// What each job does. Every handler is idempotent: re-running a job after a crash or a retry
// re-fetches, re-scores and replaces, never duplicates.

import type { CanonicalCall } from '@calleval/framework';
import { config, llmEnabled } from '../config';
import { runAlertRules, gateAlert } from '../alerts/engine';
import { runClusters } from '../analytics/clusters';
import { humanOverrides } from '../analytics/review';
import { CONNECTORS, credentialsOf, getIntegration, listIntegrations } from '../connectors/registry';
import { uploadToCanonical, type UploadMeta } from '../connectors/upload';
import { attribute, pullCrm } from '../crm/outcomes';
import type { Db } from '../db';
import { errMsg, log } from '../lib/log';
import { getSettings } from '../lib/settings';
import { analyseAudio } from '../pipeline/audio';
import { evaluateCall } from '../pipeline/evaluate';
import { fetchAgentCached, storeCanonical } from '../pipeline/ingest';
import { claude } from '../pipeline/judge/llm';
import { heuristic } from '../pipeline/judge/heuristic';
import { storeEvaluation } from '../pipeline/store';
import { generateRecommendations } from '../recommendations/engine';
import { seedDemo } from '../demo/seed';
import { enqueue, type Job } from './queue';

const PAGES_PER_RUN = 20;

export async function syncIntegration(db: Db, p: { integrationId: string; since?: string; agentIndex?: number; cursor?: unknown; maxSeen?: string | null }) {
  const row = await getIntegration(db, p.integrationId);
  if (!row || !row.enabled || !CONNECTORS[row.provider]) return { skipped: true };
  const conn = CONNECTORS[row.provider];
  const creds = credentialsOf(row);
  if (!creds.apiKey) throw new Error('No API key configured for this integration');
  const overlap = 10 * 60_000;
  const since = p.since ? new Date(p.since) : row.cursor?.since ? new Date(new Date(row.cursor.since).getTime() - overlap) : new Date(Date.now() - 30 * 86_400_000);
  const agents: (string | null)[] = creds.agentIds.length ? creds.agentIds : [null];
  let ai = p.agentIndex ?? 0, cursor: unknown = p.cursor ?? null, maxSeen = p.maxSeen ? new Date(p.maxSeen) : null;
  let queued = 0, pages = 0;
  try {
    while (ai < agents.length) {
      const page = await conn.listCalls(creds, { since, cursor, agentId: agents[ai] });
      pages++;
      for (const c of page.calls) {
        if (c.startedAt && (!maxSeen || new Date(c.startedAt) > maxSeen)) maxSeen = new Date(c.startedAt);
        if (!c.complete) continue;
        const have = await db.one<{ status: string }>('select status from calls where provider = $1 and external_id = $2', [row.provider, c.externalId]);
        if (have && have.status === 'scored') continue;
        if (await enqueue(db, 'ingest_call', { integrationId: row.id, externalId: c.externalId }, { dedupeKey: `ingest:${row.provider}:${c.externalId}` })) queued++;
      }
      if (page.done) { ai++; cursor = null; } else cursor = page.cursor;
      if (pages >= PAGES_PER_RUN && ai < agents.length) {
        await enqueue(db, 'sync_integration', { integrationId: row.id, since: since.toISOString(), agentIndex: ai, cursor, maxSeen: maxSeen?.toISOString() ?? null }, { dedupeKey: `sync-cont:${row.id}:${ai}:${String(cursor)}` });
        break;
      }
    }
    const done = ai >= agents.length;
    const newSince = done && maxSeen && (!row.cursor?.since || maxSeen > new Date(row.cursor.since)) ? maxSeen.toISOString() : row.cursor?.since ?? null;
    await db.query("update integration set last_sync_at = now(), last_sync_status = $2, last_error = null, cursor = $3::jsonb, updated_at = now() where id = $1",
      [row.id, `ok · ${queued} new call${queued === 1 ? '' : 's'} queued${done ? '' : ' (continuing)'}`, JSON.stringify({ since: newSince })]);
    return { queued, pages };
  } catch (e) {
    await db.query("update integration set last_sync_at = now(), last_sync_status = 'error', last_error = $2, updated_at = now() where id = $1", [row.id, errMsg(e).slice(0, 500)]);
    throw e;
  }
}

export async function ingestCall(db: Db, p: { integrationId: string; externalId: string; raw?: unknown }) {
  const row = await getIntegration(db, p.integrationId);
  if (!row || !CONNECTORS[row.provider]) throw new Error('Integration not found');
  const conn = CONNECTORS[row.provider];
  const creds = credentialsOf(row);
  const fetched = p.raw ? { canonical: conn.normalise(p.raw), raw: p.raw } : await conn.fetchCall(creds, p.externalId);
  const c = fetched.canonical;
  const info = c.agentExternalId && creds.apiKey
    ? await fetchAgentCached(`${row.provider}:${c.agentExternalId}:${c.agentVersion ?? ''}`, () => conn.fetchAgent(creds, c.agentExternalId!, c.agentVersion))
    : null;
  const callId = await storeCanonical(db, c, fetched.raw, { integrationId: row.id, source: 'live', agentInfo: info });
  await db.query('update integration set calls_imported = (select count(*) from calls where integration_id = $1) where id = $1', [row.id]);
  await enqueue(db, 'evaluate_call', { callId }, { dedupeKey: `eval:${callId}` });
  return { callId };
}

export async function evaluateStored(db: Db, p: { callId: string; judge?: 'heuristic' | 'auto' }) {
  const row = await db.one<{ canonical: CanonicalCall; integration_id: string | null; source: string; lead_id: string | null }>('select canonical, integration_id, source, lead_id from calls where call_id = $1', [p.callId]);
  if (!row?.canonical) throw new Error(`Call ${p.callId} not found`);
  await db.query("update calls set status = 'evaluating', updated_at = now() where call_id = $1", [p.callId]);
  try {
    const settings = await getSettings(db);
    // Demo calls always use the heuristic judge so seeding never spends API credit.
    const judge = p.judge === 'heuristic' || row.source === 'demo' || !llmEnabled() ? heuristic : claude;
    let audio = null;
    if (config.audioModelUrl && row.canonical.recording?.available && row.integration_id) {
      const integ = await getIntegration(db, row.integration_id);
      const conn = integ ? CONNECTORS[integ.provider] : null;
      if (integ && conn) audio = await analyseAudio(row.canonical, await conn.fetchAudio(credentialsOf(integ), row.canonical).catch(() => null));
    }
    const integ = row.integration_id ? await getIntegration(db, row.integration_id) : null;
    const res = await evaluateCall(row.canonical, { callId: p.callId, judge, settings, audio, human: await humanOverrides(db, p.callId), toolAliases: integ?.config?.toolAliases });
    await storeEvaluation(db, row.canonical, res.evaluation, res.runs, res.summary);
    if (res.evaluation.gates.some((g) => g.failed)) await gateAlert(db, p.callId);
    if (row.lead_id) await attribute(db, [row.lead_id]);
    return { cqs: res.evaluation.cqs, judge: res.evaluation.judgeMode };
  } catch (e) {
    await db.query("update calls set status = 'failed', error = $2, updated_at = now() where call_id = $1", [p.callId, errMsg(e).slice(0, 1000)]);
    throw e;
  }
}

export async function transcribeUpload(db: Db, p: { uploadId: string }) {
  const u = await db.one('select * from upload where id = $1', [p.uploadId]);
  if (!u) throw new Error('Upload not found');
  await db.query("update upload set status = 'transcribing' where id = $1", [u.id]);
  try {
    const meta: UploadMeta = { uploadId: u.id, filename: u.filename, filePath: u.path, mime: u.mime, direction: u.meta?.direction ?? 'unknown', promptVersion: u.meta?.promptVersion ?? null, layout: u.meta?.layout === 'cl' ? 'cl' : 'al', channels: u.meta?.channels ?? null, conversationId: u.meta?.conversationId ?? null, startedAt: u.meta?.startedAt ?? new Date(u.created_at).toISOString() };
    const c = await uploadToCanonical(meta);
    const callId = await storeCanonical(db, c, null, { integrationId: null, source: 'upload', keepRaw: false });
    await db.query("update upload set status = 'stored', call_id = $2 where id = $1", [u.id, callId]);
    await enqueue(db, 'evaluate_call', { callId }, { dedupeKey: `eval:${callId}` });
    return { callId };
  } catch (e) {
    await db.query("update upload set status = 'failed', meta = meta || $2::jsonb where id = $1", [u.id, JSON.stringify({ error: errMsg(e) })]);
    throw e;
  }
}

export async function crmSync(db: Db) {
  let total = 0;
  for (const row of (await listIntegrations(db)).filter((r) => r.provider === 'treppan' && r.enabled)) {
    const creds = credentialsOf(row);
    if (!creds.baseUrl) continue;
    try {
      const r = await pullCrm(db, creds.baseUrl, creds.apiKey, row.last_sync_at ? new Date(new Date(row.last_sync_at).getTime() - 86_400_000) : null);
      total += r.imported;
      await db.query("update integration set last_sync_at = now(), last_sync_status = $2, last_error = null where id = $1", [row.id, `ok · ${r.imported} outcomes`]);
    } catch (e) {
      await db.query("update integration set last_sync_at = now(), last_sync_status = 'error', last_error = $2 where id = $1", [row.id, errMsg(e)]);
    }
  }
  return { imported: total, credited: await attribute(db) };
}

export async function retention(db: Db) {
  const s = await getSettings(db);
  if (!s.retentionDays) return { purged: 0 };
  const rows = await db.query(
    `update calls set raw = null, recording_url = null, canonical = jsonb_set(jsonb_set(canonical, '{turns}', '[]'::jsonb), '{toolCalls}', '[]'::jsonb), updated_at = now()
     where started_at < now() - ($1::int * interval '1 day') and raw is not null returning call_id`,
    [s.retentionDays],
  );
  return { purged: rows.length };
}

export async function runJob(db: Db, job: Job): Promise<unknown> {
  const p = job.payload ?? {};
  switch (job.kind) {
    case 'sync_integration': return syncIntegration(db, p as any);
    case 'ingest_call': return ingestCall(db, p as any);
    case 'evaluate_call': return evaluateStored(db, p as any);
    case 'transcribe_upload': return transcribeUpload(db, p as any);
    case 'crm_sync': return crmSync(db);
    case 'alerts': return runAlertRules(db, Number(p.lookbackDays ?? 2));
    case 'recommendations': return generateRecommendations(db, { rangeDays: Number(p.rangeDays ?? 30), agent: (p.agent as string) ?? 'all', useLlm: p.useLlm !== false });
    case 'clusters': return runClusters(db);
    case 'retention': return retention(db);
    case 'demo_seed': return seedDemo(db, { count: Number(p.count ?? 5000), days: Number(p.days ?? 90) });
    default: log.warn('unknown job kind', { kind: job.kind }); return null;
  }
}
