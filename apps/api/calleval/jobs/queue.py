# A Postgres-backed job queue: no extra infrastructure, jobs survive restarts, and several worker
# processes can share it safely through SELECT … FOR UPDATE SKIP LOCKED.

from __future__ import annotations

import asyncio
from typing import Any

from ..js import iso, js_json
from ..lib.ids import new_id

# Job kinds:
#   sync_integration   poll or backfill a provider for new calls
#   ingest_call        fetch one call from its provider and store the canonical record
#   evaluate_call      run the evaluation pipeline on a stored call
#   transcribe_upload  speech-to-text for an uploaded recording, then evaluate
#   crm_sync           pull outcomes from the CRM and credit them to calls
#   alerts             evaluate the alert rules
#   recommendations    generate improvement recommendations
#   clusters           monthly clustering of call summaries for taxonomy drift
#   retention          purge transcripts and audio past the retention window
#   demo_seed          load synthetic demo calls
#   lead_search        find people matching the ideal customer profile (Apollo) and add them to the CRM
#   lead_enrich        backfill CRM leads from Apollo within a credit cap
#   campaign_dispatch  submit a campaign's next batch of calls to the provider
#   improve_cycle      propose, probe and compose a challenger prompt for a campaign
#   improve_verify     decide a live challenger: promote, roll back or keep collecting calls
JOB_KINDS = ('sync_integration', 'ingest_call', 'evaluate_call', 'transcribe_upload', 'crm_sync', 'alerts',
             'recommendations', 'clusters', 'retention', 'demo_seed', 'lead_search', 'lead_enrich',
             'campaign_dispatch', 'improve_cycle', 'improve_verify')


class _Wake:
    """Wakes idle workers in this process as soon as a job is queued."""

    def __init__(self) -> None:
        self._waiters: set[asyncio.Future] = set()

    def emit(self) -> None:
        for f in list(self._waiters):
            if not f.done():
                f.set_result(None)
        self._waiters.clear()

    async def wait(self, timeout: float) -> None:
        fut = asyncio.get_running_loop().create_future()
        self._waiters.add(fut)
        try:
            await asyncio.wait_for(fut, timeout)
        except TimeoutError:
            pass
        finally:
            self._waiters.discard(fut)


job_events = _Wake()


async def enqueue(db, kind: str, payload: dict[str, Any] | None = None, *, dedupe_key: str | None = None, priority: int = 0,
                  delay_ms: int = 0, max_attempts: int = 5) -> str | None:
    rows = await db.query(
        """insert into job (id, kind, payload, priority, run_after, dedupe_key, max_attempts)
           values ($1, $2, $3::jsonb, $4, now() + ($5::int * interval '1 millisecond'), $6, $7)
           on conflict do nothing returning id""",
        [new_id('job'), kind, js_json(payload or {}), priority, delay_ms, dedupe_key, max_attempts],
    )
    if rows:
        job_events.emit()
    return rows[0]['id'] if rows else None


async def enqueue_or_existing(db, kind: str, payload: dict[str, Any], *, dedupe_key: str, priority: int = 0, max_attempts: int = 5) -> str | None:
    """Enqueue, or return the id of the identical job already waiting or running."""
    id = await enqueue(db, kind, payload, dedupe_key=dedupe_key, priority=priority, max_attempts=max_attempts)
    if id:
        return id
    cur = await db.one("select id from job where dedupe_key = $1 and status in ('queued','running') order by created_at desc limit 1", [dedupe_key])
    return cur['id'] if cur else None


async def claim(db, worker_id: str, kinds: list[str] | None = None) -> dict | None:
    kind_filter = 'and kind = any($2::text[])' if kinds else ''
    params: list[Any] = [worker_id] + ([kinds] if kinds else [])
    return await db.one(
        f"""update job set status = 'running', locked_at = now(), locked_by = $1, attempts = attempts + 1, updated_at = now()
            where id = (
              select id from job where status = 'queued' and run_after <= now() {kind_filter}
              order by priority desc, created_at limit 1 for update skip locked
            )
            returning id, workspace_id, kind, payload, attempts, max_attempts""",
        params,
    )


async def complete(db, id: str) -> None:
    await db.query("update job set status = 'done', locked_at = null, updated_at = now() where id = $1", [id])


async def fail(db, job: dict, error: str) -> None:
    final = job['attempts'] >= job['max_attempts']
    backoff_s = min(3600, 15 * 2 ** (job['attempts'] - 1))
    await db.query(
        """update job set status = $2, last_error = $3, locked_at = null, updated_at = now(),
             run_after = now() + ($4::int * interval '1 second') where id = $1""",
        [job['id'], 'failed' if final else 'queued', error[:2000], backoff_s],
    )


async def requeue_stale(db, older_than_minutes: int = 15) -> None:
    """Jobs left running by a crashed worker go back to the queue, unless they have used all their
    attempts: a job that keeps killing its worker is failed instead of retried forever. Running jobs
    renew locked_at (heartbeat), so only a lost worker's jobs go stale."""
    await db.query(
        """update job set status = case when attempts >= max_attempts then 'failed' else 'queued' end,
             last_error = case when attempts >= max_attempts then 'Worker stopped responding while running this job' else last_error end,
             locked_at = null, updated_at = now()
           where status = 'running' and locked_at < now() - ($1::int * interval '1 minute')""",
        [older_than_minutes],
    )


async def heartbeat(db, id: str) -> None:
    await db.query("update job set locked_at = now() where id = $1 and status = 'running'", [id])


async def list_jobs(db, limit: int = 50) -> list[dict]:
    rows = await db.query('select * from job order by updated_at desc limit $1', [limit])
    return [{'id': r['id'], 'kind': r['kind'], 'status': r['status'], 'attempts': r['attempts'], 'createdAt': iso(r['created_at']),
             'updatedAt': iso(r['updated_at']), 'lastError': r['last_error'], 'payload': r['payload']} for r in rows]


async def pending_count(db, kind: str | None = None) -> int:
    r = await db.one(f"select count(*)::int as n from job where status in ('queued','running') {'and kind = $1' if kind else ''}", [kind] if kind else [])
    return r['n'] if r else 0
