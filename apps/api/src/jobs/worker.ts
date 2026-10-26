// In-process workers over the Postgres job queue, plus the scheduler that keeps providers polled,
// alerts evaluated, recommendations fresh and the taxonomy clustered.

import { config } from '../config';
import type { Db } from '../db';
import { errMsg, log } from '../lib/log';
import { getKv, setKv } from '../lib/settings';
import { listIntegrations } from '../connectors/registry';
import { claim, complete, enqueue, fail, jobEvents, requeueStale } from './queue';
import { runJob } from './handlers';

let stopping = false;

export function startWorkers(db: Db, n = config.workerConcurrency) {
  const id = `w_${process.pid}`;
  for (let i = 0; i < n; i++) void loop(db, `${id}_${i}`);
  log.info('workers started', { count: n });
}

export function stopWorkers() { stopping = true; jobEvents.emit('wake'); }

async function loop(db: Db, workerId: string) {
  while (!stopping) {
    let job = null;
    try { job = await claim(db, workerId); } catch (e) { log.error('claim failed', { error: errMsg(e) }); }
    if (!job) {
      await new Promise<void>((r) => { const t = setTimeout(r, 1000); jobEvents.once('wake', () => { clearTimeout(t); r(); }); });
      continue;
    }
    const t0 = Date.now();
    try {
      const out = await runJob(db, job);
      await complete(db, job.id);
      log.info('job done', { kind: job.kind, id: job.id, ms: Date.now() - t0, out: out && typeof out === 'object' ? out : undefined });
    } catch (e) {
      log.warn('job failed', { kind: job.kind, id: job.id, attempt: job.attempts, error: errMsg(e) });
      await fail(db, job, errMsg(e)).catch(() => {});
    }
  }
}

/** Run a job kind at most once per period, tracked in app_setting so restarts don't re-fire it. */
async function every(db: Db, key: string, periodMs: number, fn: () => Promise<unknown>) {
  const last = await getKv<string>(db, `scheduler:${key}`);
  if (last && Date.now() - new Date(last).getTime() < periodMs) return;
  await setKv(db, `scheduler:${key}`, new Date().toISOString());
  await fn();
}

export function startScheduler(db: Db) {
  const tick = async () => {
    try {
      await requeueStale(db);
      for (const row of await listIntegrations(db)) {
        if (!row.enabled || row.provider === 'treppan') continue;
        const mins = row.config?.pollMinutes ?? 15;
        if (mins <= 0) continue;
        if (!row.last_sync_at || Date.now() - new Date(row.last_sync_at).getTime() > mins * 60_000) {
          await enqueue(db, 'sync_integration', { integrationId: row.id }, { dedupeKey: `sync:${row.id}` });
        }
      }
      await every(db, 'alerts', 60 * 60_000, () => enqueue(db, 'alerts', { lookbackDays: 2 }, { dedupeKey: 'alerts' }));
      await every(db, 'crm', 24 * 60 * 60_000, () => enqueue(db, 'crm_sync', {}, { dedupeKey: 'crm' }));
      await every(db, 'retention', 24 * 60 * 60_000, () => enqueue(db, 'retention', {}, { dedupeKey: 'retention' }));
      await every(db, 'recommendations', 7 * 24 * 60 * 60_000, () => enqueue(db, 'recommendations', {}, { dedupeKey: 'recommendations' }));
      await every(db, 'clusters', 30 * 24 * 60 * 60_000, () => enqueue(db, 'clusters', {}, { dedupeKey: 'clusters' }));
      jobEvents.emit('wake');
    } catch (e) {
      log.error('scheduler tick failed', { error: errMsg(e) });
    }
  };
  void tick();
  const h = setInterval(tick, 30_000);
  return () => clearInterval(h);
}
