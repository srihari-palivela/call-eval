# In-process workers over the Postgres job queue, plus the scheduler that keeps providers polled,
# alerts evaluated, recommendations fresh and the taxonomy clustered.

from __future__ import annotations

import asyncio
import os
import time
from collections.abc import Awaitable, Callable

from ..campaigns.engine import campaign_tick
from ..config import config
from ..connectors.registry import CALL_PROVIDERS, list_integrations
from ..js import now_iso, now_ms, parse_date, to_ms
from ..lib.log import err_msg, log
from ..lib.settings import get_kv, set_kv
from ..tenancy import in_workspace
from .handlers import run_job
from .queue import claim, complete, enqueue, fail, heartbeat, job_events, requeue_stale

_stopping = False
_tasks: list[asyncio.Task] = []


def start_workers(db, n: int | None = None) -> None:
    global _stopping
    _stopping = False
    n = config.worker_concurrency if n is None else n
    wid = f'w_{os.getpid()}'
    for i in range(n):
        _tasks.append(asyncio.create_task(_loop(db, f'{wid}_{i}')))
    log.info('workers started', {'count': n})


async def stop_workers() -> None:
    global _stopping
    _stopping = True
    job_events.emit()
    tasks = list(_tasks)
    _tasks.clear()
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


async def _loop(db, worker_id: str) -> None:
    # The queue is shared by every workspace: claimed without row-level security, each job then runs in its own.
    sys_db = db.as_system()
    while not _stopping:
        job = None
        try:
            job = await claim(sys_db, worker_id)
        except Exception as e:
            log.error('claim failed', {'error': err_msg(e)})
        if not job:
            await job_events.wait(1.0)
            continue
        t0 = time.monotonic()
        beat = asyncio.create_task(_heartbeat(sys_db, job['id']))
        try:
            with in_workspace(job['workspace_id']):
                out = await run_job(db, job)
            await complete(sys_db, job['id'])
            log.info('job done', {'kind': job['kind'], 'id': job['id'], 'ms': int((time.monotonic() - t0) * 1000), 'out': out if isinstance(out, dict) else None})
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.warn('job failed', {'kind': job['kind'], 'id': job['id'], 'attempt': job['attempts'], 'error': err_msg(e)})
            try:
                await fail(sys_db, job, err_msg(e))
            except Exception:
                pass
        finally:
            beat.cancel()


async def _heartbeat(db, job_id: str, every_s: float = 60.0) -> None:
    """Keep the job's lock fresh while it runs, so a long job is not taken for a lost one."""
    while True:
        await asyncio.sleep(every_s)
        try:
            await heartbeat(db, job_id)
        except Exception as e:
            log.warn('job heartbeat failed', {'id': job_id, 'error': err_msg(e)})


async def _every(db, key: str, period_ms: int, fn: Callable[[], Awaitable[object]]) -> None:
    """Run a job kind at most once per period, tracked in app_setting so restarts don't re-fire it."""
    last = await get_kv(db, f'scheduler:{key}')
    d = parse_date(last) if isinstance(last, str) else None
    if d and now_ms() - to_ms(d) < period_ms:
        return
    await set_kv(db, f'scheduler:{key}', now_iso())
    await fn()


async def _tick(db) -> None:
    try:
        sys_db = db.as_system()
        await requeue_stale(sys_db)
        for w in await sys_db.query('select id from workspace order by created_at'):
            with in_workspace(w['id']):
                await _tick_workspace(db)
        job_events.emit()
    except Exception as e:
        log.error('scheduler tick failed', {'error': err_msg(e)})


async def _tick_workspace(db) -> None:
    """One workspace's scheduled work: polling, the periodic jobs and its campaigns."""
    try:
        for row in await list_integrations(db):
            if not row['enabled'] or row['provider'] not in CALL_PROVIDERS:
                continue
            mins = (row.get('config') or {}).get('pollMinutes', 15)
            if mins is None:
                mins = 15
            if mins <= 0:
                continue
            if not row['last_sync_at'] or now_ms() - to_ms(row['last_sync_at']) > mins * 60_000:
                await enqueue(db, 'sync_integration', {'integrationId': row['id']}, dedupe_key=f"sync:{row['id']}")
        day = 24 * 60 * 60_000
        await _every(db, 'alerts', 60 * 60_000, lambda: enqueue(db, 'alerts', {'lookbackDays': 2}, dedupe_key='alerts'))
        await _every(db, 'crm', day, lambda: enqueue(db, 'crm_sync', {}, dedupe_key='crm'))
        await _every(db, 'retention', day, lambda: enqueue(db, 'retention', {}, dedupe_key='retention'))
        await _every(db, 'recommendations', 7 * day, lambda: enqueue(db, 'recommendations', {}, dedupe_key='recommendations'))
        await _every(db, 'clusters', 30 * day, lambda: enqueue(db, 'clusters', {}, dedupe_key='clusters'))
        # Campaigns: next batch inside the calling window, improvement cycles and challenger verification.
        await campaign_tick(db)
    except Exception as e:
        log.error('scheduler tick failed for a workspace', {'error': err_msg(e)})


def start_scheduler(db, interval_s: float = 30.0) -> Callable[[], None]:
    async def run() -> None:
        while True:
            await _tick(db)
            await asyncio.sleep(interval_s)

    task = asyncio.create_task(run())
    return task.cancel
