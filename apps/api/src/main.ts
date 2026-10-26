// Entry point. `node dist/main.js` runs the API with in-process workers; `--worker-only` runs just the
// workers and scheduler (scale them separately against the same Postgres); `--no-worker` runs just the API.

import { config, llmEnabled } from './config';
import { getDb } from './db';
import { log, errMsg } from './lib/log';
import { bootstrapFromEnv } from './connectors/registry';
import { seedTaxonomy } from './analytics/meta';
import { buildServer } from './server';
import { startScheduler, startWorkers, stopWorkers } from './jobs/worker';

async function main() {
  const args = new Set(process.argv.slice(2));
  const workerOnly = args.has('--worker-only');
  const runWorker = !args.has('--no-worker') && config.runWorker;
  const db = await getDb();
  await seedTaxonomy(db);
  await bootstrapFromEnv(db);
  log.info('database ready', { kind: db.kind, judge: llmEnabled() ? `claude (${config.llm.model})` : 'heuristic (no ANTHROPIC_API_KEY)' });

  let stopScheduler: (() => void) | null = null;
  if (workerOnly || runWorker) {
    startWorkers(db);
    stopScheduler = startScheduler(db);
  }
  let app: Awaited<ReturnType<typeof buildServer>> | null = null;
  if (!workerOnly) {
    app = await buildServer(db);
    await app.listen({ port: config.port, host: config.host });
    log.info('api listening', { port: config.port });
  }
  const shutdown = async (sig: string) => {
    log.info('shutting down', { sig });
    stopWorkers();
    stopScheduler?.();
    await app?.close().catch(() => {});
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  log.error('fatal', { error: errMsg(e) });
  process.exit(1);
});
