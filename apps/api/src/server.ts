// HTTP API: the console's REST endpoints, signed provider webhooks, uploads, and the built console.

import { createWriteStream, existsSync, mkdirSync, statSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { CanonicalCall, SettingsDTO } from '@calleval/framework';
import { config } from './config';
import type { Db } from './db';
import { newId } from './lib/ids';
import { errMsg, log } from './lib/log';
import { getSettings, updateSettings } from './lib/settings';
import { meta } from './analytics/meta';
import { cellDetail, fixMap, matrix } from './analytics/matrix';
import { callDetail, listCalls } from './analytics/calls';
import { versionReport } from './analytics/version';
import { traces } from './analytics/traces';
import { funnel } from './analytics/funnel';
import { taxonomyHealth } from './analytics/taxonomy';
import { recordings } from './analytics/recordings';
import { listReview, resolveReview } from './analytics/review';
import { ackAlert, listAlerts } from './alerts/engine';
import { listRecommendations, updateRecommendation } from './recommendations/engine';
import { CONNECTORS, credentialsOf, getIntegration, listIntegrations, saveIntegration, toDTO, type IntegrationInput } from './connectors/registry';
import { parseCsv, upsertOutcomes, type OutcomeInput } from './crm/outcomes';
import { enqueue, enqueueOrExisting, listJobs } from './jobs/queue';

type Req = FastifyRequest & { rawBody?: string };
const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

export async function buildServer(db: Db): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 60 * 1024 * 1024, trustProxy: true });
  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 300 * 1024 * 1024, files: 1 } });

  // Keep the raw body: webhook signatures are computed over the exact bytes received.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as Req).rawBody = body as string;
    try { done(null, body ? JSON.parse(body as string) : {}); } catch (e) { done(httpError(400, `Invalid JSON: ${errMsg(e)}`), undefined); }
  });
  app.addContentTypeParser(['text/csv', 'text/plain'], { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.addHook('onRequest', async (req, reply) => {
    if (!config.apiToken || !req.url.startsWith('/api/')) return;
    const h = req.headers.authorization;
    const q = (req.query as Record<string, string> | undefined)?.token;
    if (h === `Bearer ${config.apiToken}` || (req.method === 'GET' && q === config.apiToken)) return;
    reply.code(401).send({ error: 'Unauthorized', message: 'Set Authorization: Bearer <API_TOKEN>.' });
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const code = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (code >= 500) log.error('request failed', { url: req.url, error: errMsg(err) });
    reply.code(code).send({ error: code >= 500 ? 'Internal error' : 'Bad request', message: err.message });
  });

  app.get('/healthz', async () => {
    await db.one('select 1 as ok');
    return { ok: true };
  });

  // ---------- Reference ----------
  app.get('/api/meta', async () => meta(db));
  app.get('/api/settings', async () => getSettings(db));
  app.put('/api/settings', async (req) => updateSettings(db, (req.body ?? {}) as Partial<SettingsDTO>));

  // ---------- Technical view ----------
  app.get('/api/matrix', async (req) => matrix(db, req.query as Record<string, unknown>));
  app.get('/api/cells/:pid/:sid', async (req) => {
    const { pid, sid } = req.params as { pid: string; sid: string };
    const r = await cellDetail(db, pid, sid, req.query as Record<string, unknown>);
    if (!r) throw httpError(404, 'No calls in this cell for the current filters');
    return r;
  });
  app.get('/api/calls', async (req) => listCalls(db, req.query as Record<string, unknown>));
  app.get('/api/calls/:id', async (req) => {
    const r = await callDetail(db, (req.params as { id: string }).id);
    if (!r) throw httpError(404, 'Call not found');
    return r;
  });
  app.get('/api/calls/:id/audio', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = await db.one<{ canonical: CanonicalCall; integration_id: string | null; source: string; recording_url: string | null }>('select canonical, integration_id, source, recording_url from calls where call_id = $1', [id]);
    if (!row) throw httpError(404, 'Call not found');
    if (row.source === 'upload' && row.canonical.recording?.url && existsSync(row.canonical.recording.url)) {
      const f = row.canonical.recording.url;
      reply.header('content-type', 'audio/mpeg').header('content-length', statSync(f).size);
      return reply.send(createReadStream(f));
    }
    const integ = row.integration_id ? await getIntegration(db, row.integration_id) : null;
    const conn = integ ? CONNECTORS[integ.provider] : null;
    if (!integ || !conn) throw httpError(404, 'No recording available for this call');
    const res = await conn.fetchAudio(credentialsOf(integ), row.canonical);
    if (!res) throw httpError(404, 'No recording available for this call');
    reply.header('content-type', res.headers.get('content-type') ?? 'audio/mpeg');
    return reply.send(Buffer.from(await res.arrayBuffer()));
  });
  app.post('/api/calls/:id/reevaluate', async (req) => {
    const id = (req.params as { id: string }).id;
    const jobId = await enqueueOrExisting(db, 'evaluate_call', { callId: id, reason: 'manual' }, { dedupeKey: `eval:${id}`, priority: 5 });
    return { jobId, queued: !!jobId };
  });
  app.get('/api/version-report', async (req) => versionReport(db, req.query as Record<string, unknown>));
  app.get('/api/traces', async (req) => traces(db, req.query as Record<string, unknown>));

  // ---------- Business view ----------
  app.get('/api/funnel', async (req) => funnel(db, req.query as Record<string, unknown>));
  app.get('/api/fix', async (req) => fixMap(db, req.query as Record<string, unknown>));

  // ---------- Improvement ----------
  app.get('/api/recommendations', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return listRecommendations(db, { status: q.status ?? 'all', scope: q.scope ?? null, kind: q.kind ?? null, scopeKey: q.scopeKey ?? null });
  });
  app.post('/api/recommendations/generate', async (req) => {
    const b = (req.body ?? {}) as { rangeDays?: number; agent?: string; useLlm?: boolean };
    return { jobId: await enqueueOrExisting(db, 'recommendations', { rangeDays: b.rangeDays ?? 30, agent: b.agent ?? 'all', useLlm: b.useLlm !== false }, { dedupeKey: 'recommendations', priority: 3 }) };
  });
  app.patch('/api/recommendations/:id', async (req) => updateRecommendation(db, (req.params as { id: string }).id, (req.body ?? {}) as { status?: string; note?: string; targetVersion?: string }));
  app.get('/api/attention-items', async () => {
    const rows = await db.query<{ key: string; owner: string | null; status: string | null }>('select key, owner, status from attention_item');
    return Object.fromEntries(rows.map((r) => [r.key, { owner: r.owner ?? 'none', status: r.status ?? 'open' }]));
  });
  app.put('/api/attention-items/:key', async (req) => {
    const key = (req.params as { key: string }).key;
    const b = (req.body ?? {}) as { owner?: string; status?: string; note?: string };
    await db.query(
      `insert into attention_item (key, owner, status, note, updated_at) values ($1, $2, $3, $4, now())
       on conflict (key) do update set owner = coalesce($2, attention_item.owner), status = coalesce($3, attention_item.status), note = coalesce($4, attention_item.note), updated_at = now()`,
      [key, b.owner ?? null, b.status ?? null, b.note ?? null],
    );
    return { ok: true };
  });

  // ---------- Governance ----------
  app.get('/api/taxonomy/health', async () => taxonomyHealth(db));
  app.post('/api/taxonomy/clusters/run', async () => ({ jobId: await enqueueOrExisting(db, 'clusters', {}, { dedupeKey: 'clusters', priority: 3 }) }));
  app.post('/api/taxonomy/clusters/:id/propose', async (req) => {
    const proposed = ((req.body ?? {}) as { proposed?: boolean }).proposed !== false;
    await db.query('update cluster set proposed = $2 where id = $1', [(req.params as { id: string }).id, proposed]);
    return { proposed };
  });
  app.get('/api/alerts', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return listAlerts(db, q.status ?? 'open', q.rule && q.rule !== 'all' ? q.rule : null);
  });
  app.post('/api/alerts/:id/ack', async (req) => ackAlert(db, (req.params as { id: string }).id, ((req.body ?? {}) as { acked?: boolean }).acked !== false));
  app.get('/api/review', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return listReview(db, { status: q.status ?? 'open', kind: q.kind });
  });
  app.post('/api/review/:id', async (req) => resolveReview(db, (req.params as { id: string }).id, (req.body ?? {}) as { value?: string | null; gateConfirmed?: boolean; note?: string }));

  // ---------- Data in ----------
  app.get('/api/integrations', async () => (await listIntegrations(db)).map(toDTO));
  app.post('/api/integrations', async (req) => toDTO(await saveIntegration(db, null, (req.body ?? {}) as IntegrationInput)));
  app.patch('/api/integrations/:id', async (req) => toDTO(await saveIntegration(db, (req.params as { id: string }).id, (req.body ?? {}) as IntegrationInput)));
  app.delete('/api/integrations/:id', async (req) => {
    await db.query('delete from integration where id = $1', [(req.params as { id: string }).id]);
    return { ok: true };
  });
  app.post('/api/integrations/:id/test', async (req) => {
    const row = await getIntegration(db, (req.params as { id: string }).id);
    if (!row) throw httpError(404, 'Integration not found');
    const creds = credentialsOf(row);
    try {
      if (row.provider === 'treppan') {
        const { pullCrm } = await import('./crm/outcomes');
        const r = await pullCrm(db, creds.baseUrl ?? '', creds.apiKey, new Date());
        return { ok: true, message: `Connected; ${r.imported} outcomes returned for today.` };
      }
      const agents = await CONNECTORS[row.provider].listAgents(creds);
      const missing = creds.agentIds.filter((a) => !agents.some((x) => x.id === a));
      return { ok: true, message: `Connected. ${agents.length} agent${agents.length === 1 ? '' : 's'} visible${missing.length ? `; not found: ${missing.join(', ')}` : ''}.`, agents };
    } catch (e) {
      return { ok: false, message: errMsg(e) };
    }
  });
  app.post('/api/integrations/:id/sync', async (req) => {
    const id = (req.params as { id: string }).id;
    const since = ((req.body ?? {}) as { since?: string }).since;
    const row = await getIntegration(db, id);
    if (!row) throw httpError(404, 'Integration not found');
    const kind = row.provider === 'treppan' ? 'crm_sync' : 'sync_integration';
    return { jobId: await enqueueOrExisting(db, kind, kind === 'crm_sync' ? {} : { integrationId: id, ...(since ? { since } : {}) }, { dedupeKey: since ? `backfill:${id}:${since}` : `sync:${id}`, priority: 4 }) };
  });

  app.get('/api/recordings', async (req) => recordings(db, ((req.query ?? {}) as { group?: string }).group ?? null));
  app.post('/api/uploads', async (req) => {
    const file = await (req as unknown as { file: () => Promise<any> }).file();
    if (!file) throw httpError(400, 'No file uploaded');
    const fields = Object.fromEntries(Object.entries(file.fields ?? {}).map(([k, v]: [string, any]) => [k, v?.value]));
    if (String(fields.consent) !== 'true') throw httpError(400, 'Confirm that the recording notice covers transcript, classifier and audio analysis.');
    if (!config.sttApiKey) throw httpError(400, 'Uploads are transcribed with ElevenLabs Speech-to-Text; set ELEVENLABS_API_KEY (or ELEVENLABS_STT_API_KEY) first.');
    mkdirSync(config.uploadDir, { recursive: true });
    const id = newId('upl');
    const safe = String(file.filename ?? 'recording').replace(/[^\w.-]+/g, '_').slice(-120);
    const dest = path.resolve(config.uploadDir, `${id}-${safe}`);
    await pipeline(file.file, createWriteStream(dest));
    const channels = fields.layout === 'mono' ? 1 : Number(fields.channels) || null;
    const meta = {
      direction: fields.dir === 'out' ? 'outbound' : fields.dir === 'in' ? 'inbound' : 'unknown', promptVersion: fields.prompt && fields.prompt !== 'unknown' ? fields.prompt : null,
      layout: fields.layout === 'cl' ? 'cl' : 'al', channels, duration: Number(fields.duration) || null, sampleRate: Number(fields.sampleRate) || null, conversationId: fields.conv || null,
    };
    await db.query("insert into upload (id, filename, size_bytes, mime, path, status, meta) values ($1,$2,$3,$4,$5,'received',$6::jsonb)", [id, file.filename, statSync(dest).size, file.mimetype, dest, JSON.stringify(meta)]);
    await enqueue(db, 'transcribe_upload', { uploadId: id }, { dedupeKey: `upload:${id}`, priority: 4 });
    return { id, callId: null, status: 'queued' };
  });
  app.post('/api/crm/outcomes', async (req) => {
    const b = req.body as OutcomeInput[] | { items?: OutcomeInput[] };
    const items = Array.isArray(b) ? b : b?.items ?? [];
    return upsertOutcomes(db, items, 'api');
  });
  app.post('/api/crm/outcomes/csv', async (req) => upsertOutcomes(db, parseCsv(String(req.body ?? '')) as unknown as OutcomeInput[], 'csv'));
  app.get('/api/jobs', async (req) => listJobs(db, Math.min(200, Number(((req.query ?? {}) as { limit?: string }).limit ?? 50))));
  app.post('/api/demo/seed', async (req) => {
    if (config.demoMode === 'off') throw httpError(403, 'Demo mode is off (DEMO_MODE=off).');
    const b = (req.body ?? {}) as { count?: number; days?: number };
    return { jobId: await enqueueOrExisting(db, 'demo_seed', { count: Math.min(20_000, b.count ?? 5000), days: b.days ?? 90 }, { dedupeKey: 'demo_seed', maxAttempts: 1, priority: 10 }) };
  });

  // ---------- Webhooks ----------
  const webhook = (provider: 'elevenlabs' | 'retell') => async (req: FastifyRequest, reply: import('fastify').FastifyReply) => {
    const id = (req.params as { id: string }).id;
    const row = await getIntegration(db, id);
    if (!row || row.provider !== provider) return reply.code(404).send({ error: 'Unknown integration' });
    const conn = CONNECTORS[provider];
    const raw = (req as Req).rawBody ?? '';
    if (!(await conn.verifyWebhook(raw, req.headers as Record<string, string>, credentialsOf(row)))) {
      log.warn('webhook signature rejected', { provider, integration: id });
      return reply.code(401).send({ error: 'Invalid signature' });
    }
    const ev = conn.parseWebhook(req.body);
    if (ev.kind === 'call') await enqueue(db, 'ingest_call', { integrationId: id, externalId: ev.externalId, ...(ev.raw ? { raw: ev.raw } : {}) }, { dedupeKey: `ingest:${provider}:${ev.externalId}`, priority: 2 });
    return reply.code(200).send({ ok: true, queued: ev.kind === 'call' });
  };
  app.post('/webhooks/elevenlabs/:id', webhook('elevenlabs'));
  app.post('/webhooks/retell/:id', webhook('retell'));

  // ---------- Console ----------
  const dist = config.webDist ?? [path.resolve(process.cwd(), '../web/dist'), path.resolve(process.cwd(), 'apps/web/dist')].find((p) => existsSync(path.join(p, 'index.html')));
  if (dist && existsSync(path.join(dist, 'index.html'))) {
    await app.register(fastifyStatic, { root: dist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/webhooks/')) return reply.code(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
    log.info('serving the console', { dist });
  }
  return app;
}
