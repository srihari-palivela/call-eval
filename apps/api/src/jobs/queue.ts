// A Postgres-backed job queue: no extra infrastructure, jobs survive restarts, and several worker
// processes can share it safely through SELECT … FOR UPDATE SKIP LOCKED.

import { EventEmitter } from 'node:events';
import type { JobDTO } from '@calleval/framework';
import { iso, type Db } from '../db';
import { newId } from '../lib/ids';

export type JobKind =
  | 'sync_integration'   // poll or backfill a provider for new calls
  | 'ingest_call'        // fetch one call from its provider and store the canonical record
  | 'evaluate_call'      // run the evaluation pipeline on a stored call
  | 'transcribe_upload'  // speech-to-text for an uploaded recording, then evaluate
  | 'crm_sync'           // pull outcomes from the CRM and credit them to calls
  | 'alerts'             // evaluate the alert rules
  | 'recommendations'    // generate improvement recommendations
  | 'clusters'           // monthly clustering of call summaries for taxonomy drift
  | 'retention'          // purge transcripts and audio references past the retention window
  | 'demo_seed';         // load synthetic demo calls

/** Wakes idle workers in this process as soon as a job is queued. */
export const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(100);

export type Job = { id: string; kind: JobKind; payload: Record<string, any>; attempts: number; max_attempts: number };

export async function enqueue(db: Db, kind: JobKind, payload: Record<string, unknown> = {}, opts: { dedupeKey?: string; priority?: number; delayMs?: number; maxAttempts?: number } = {}): Promise<string | null> {
  const id = newId('job');
  const rows = await db.query<{ id: string }>(
    `insert into job (id, kind, payload, priority, run_after, dedupe_key, max_attempts)
     values ($1, $2, $3::jsonb, $4, now() + ($5::int * interval '1 millisecond'), $6, $7)
     on conflict do nothing returning id`,
    [id, kind, JSON.stringify(payload), opts.priority ?? 0, opts.delayMs ?? 0, opts.dedupeKey ?? null, opts.maxAttempts ?? 5],
  );
  if (rows[0]) jobEvents.emit('wake');
  return rows[0]?.id ?? null;
}

/** Enqueue, or return the id of the identical job already waiting or running. */
export async function enqueueOrExisting(db: Db, kind: JobKind, payload: Record<string, unknown>, opts: { dedupeKey: string; priority?: number; maxAttempts?: number }): Promise<string | null> {
  const id = await enqueue(db, kind, payload, opts);
  if (id) return id;
  const cur = await db.one<{ id: string }>("select id from job where dedupe_key = $1 and status in ('queued','running') order by created_at desc limit 1", [opts.dedupeKey]);
  return cur?.id ?? null;
}

export async function claim(db: Db, workerId: string, kinds?: JobKind[]): Promise<Job | null> {
  const kindFilter = kinds?.length ? `and kind = any($2::text[])` : '';
  const params: unknown[] = [workerId];
  if (kinds?.length) params.push(kinds);
  return db.one<Job>(
    `update job set status = 'running', locked_at = now(), locked_by = $1, attempts = attempts + 1, updated_at = now()
     where id = (
       select id from job where status = 'queued' and run_after <= now() ${kindFilter}
       order by priority desc, created_at limit 1 for update skip locked
     )
     returning id, kind, payload, attempts, max_attempts`,
    params,
  );
}

export async function complete(db: Db, id: string) {
  await db.query("update job set status = 'done', locked_at = null, updated_at = now() where id = $1", [id]);
}

export async function fail(db: Db, job: Job, error: string) {
  const final = job.attempts >= job.max_attempts;
  const backoffS = Math.min(3600, 15 * 2 ** (job.attempts - 1));
  await db.query(
    `update job set status = $2, last_error = $3, locked_at = null, updated_at = now(),
       run_after = now() + ($4::int * interval '1 second') where id = $1`,
    [job.id, final ? 'failed' : 'queued', error.slice(0, 2000), backoffS],
  );
}

/** Jobs left running by a crashed worker go back to the queue. */
export async function requeueStale(db: Db, olderThanMinutes = 15) {
  await db.query(
    `update job set status = 'queued', locked_at = null, updated_at = now()
     where status = 'running' and locked_at < now() - ($1::int * interval '1 minute')`,
    [olderThanMinutes],
  );
}

export async function listJobs(db: Db, limit = 50): Promise<JobDTO[]> {
  const rows = await db.query('select * from job order by updated_at desc limit $1', [limit]);
  return rows.map((r) => ({ id: r.id, kind: r.kind, status: r.status, attempts: r.attempts, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!, lastError: r.last_error, payload: r.payload }));
}

export async function pendingCount(db: Db, kind?: JobKind): Promise<number> {
  const r = await db.one<{ n: number }>(`select count(*)::int as n from job where status in ('queued','running') ${kind ? 'and kind = $1' : ''}`, kind ? [kind] : []);
  return r?.n ?? 0;
}
