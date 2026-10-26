// End to end over HTTP on an in-memory database: signed webhooks and polling sync bring calls in,
// the job queue evaluates them, CRM outcomes are credited, and every console endpoint answers.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, setDb, type Db } from '../src/db';
import { buildServer } from '../src/server';
import { seedTaxonomy } from '../src/analytics/meta';
import { seedDemo } from '../src/demo/seed';
import { drain, elevenLabsConversation, elevenLabsSignature, retellCall, retellSignature, stubFetch } from './fixtures';

let db: Db;
let app: FastifyInstance;

beforeAll(async () => {
  db = await openDb({ url: null, dir: 'memory' });
  setDb(db);
  await seedTaxonomy(db);
  app = await buildServer(db);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app?.close();
  await db?.close();
});

const json = (r: { body: string }) => JSON.parse(r.body);

describe('Retell webhook', () => {
  let integrationId = '';

  it('creates an integration without echoing secrets', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/integrations', payload: { provider: 'retell', apiKey: 'key_retell_test', agentIds: ['agent_rt_1'] } });
    expect(r.statusCode).toBe(200);
    const dto = json(r);
    integrationId = dto.id;
    expect(dto).toMatchObject({ provider: 'retell', hasApiKey: true, apiKeyHint: '…test', webhookUrl: `https://evals.example.com/webhooks/retell/${dto.id}` });
    expect(r.body).not.toContain('key_retell_test');
  });

  it('rejects an unsigned or forged webhook', async () => {
    const body = JSON.stringify({ event: 'call_analyzed', call: retellCall() });
    const unsigned = await app.inject({ method: 'POST', url: `/webhooks/retell/${integrationId}`, payload: body, headers: { 'content-type': 'application/json' } });
    expect(unsigned.statusCode).toBe(401);
    const forged = await app.inject({ method: 'POST', url: `/webhooks/retell/${integrationId}`, payload: body, headers: { 'content-type': 'application/json', 'x-retell-signature': retellSignature('wrong', body) } });
    expect(forged.statusCode).toBe(401);
    const unknown = await app.inject({ method: 'POST', url: '/webhooks/retell/int_nope', payload: body, headers: { 'content-type': 'application/json', 'x-retell-signature': retellSignature('key_retell_test', body) } });
    expect(unknown.statusCode).toBe(404);
  });

  it('queues a signed call, fetches the agent prompt and scores the call', async () => {
    const calls = stubFetch([
      [/\/get-agent\/agent_rt_1$/, () => ({ agent_id: 'agent_rt_1', agent_name: 'Fakhruddin inbound', version: 3, response_engine: { type: 'retell-llm', llm_id: 'llm_1', version: 3 } })],
      [/\/get-retell-llm\/llm_1$/, () => ({ llm_id: 'llm_1', model: 'claude', general_prompt: 'You are Sara, a sales agent for Fakhruddin Properties…', begin_message: 'Thank you for calling Fakhruddin Properties.' })],
    ]);
    const body = JSON.stringify({ event: 'call_analyzed', call: retellCall() });
    const r = await app.inject({ method: 'POST', url: `/webhooks/retell/${integrationId}`, payload: body, headers: { 'content-type': 'application/json', 'x-retell-signature': retellSignature('key_retell_test', body) } });
    expect(r.statusCode).toBe(200);
    expect(json(r)).toEqual({ ok: true, queued: true });

    const ran = await drain(db);
    expect(ran.filter((j) => !j.ok)).toEqual([]);
    expect(ran.map((j) => j.kind)).toEqual(expect.arrayContaining(['ingest_call', 'evaluate_call']));
    expect(calls.some((c) => c.includes('/get-retell-llm/llm_1'))).toBe(true);

    const detail = json(await app.inject({ method: 'GET', url: '/api/calls/rt_call_abc' }));
    expect(detail.cqs).toBeGreaterThan(0);
    expect(detail.turns.length).toBe(5);
    expect(detail.promptVersion).toBe('v2');
    vi.unstubAllGlobals();
  });

  it('does not duplicate a call delivered twice', async () => {
    stubFetch([]);
    const body = JSON.stringify({ event: 'call_analyzed', call: retellCall() });
    await app.inject({ method: 'POST', url: `/webhooks/retell/${integrationId}`, payload: body, headers: { 'content-type': 'application/json', 'x-retell-signature': retellSignature('key_retell_test', body) } });
    await drain(db);
    const n = await db.one<{ n: number }>("select count(*)::int as n from calls where provider = 'retell'");
    expect(n?.n).toBe(1);
    vi.unstubAllGlobals();
  });
});

describe('ElevenLabs polling sync and webhook', () => {
  let integrationId = '';

  it('pulls new conversations for the configured agent', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/integrations', payload: { provider: 'elevenlabs', apiKey: 'xi_test_key', webhookSecret: 'wsec_test', agentIds: ['agent_el_1'] } });
    integrationId = json(r).id;
    const conv = elevenLabsConversation('conv_01');
    const calls = stubFetch([
      [/\/v1\/convai\/conversations$/, () => ({ conversations: [
        { conversation_id: 'conv_01', start_time_unix_secs: conv.metadata.start_time_unix_secs, status: 'done' },
        { conversation_id: 'conv_live', start_time_unix_secs: conv.metadata.start_time_unix_secs + 60, status: 'in-progress' },
      ], has_more: false, next_cursor: null })],
      [/\/v1\/convai\/conversations\/conv_01$/, () => conv],
      [/\/v1\/convai\/agents\/agent_el_1$/, () => ({ agent_id: 'agent_el_1', name: 'Fakhruddin outbound', version_id: 'agtvrsn_7', conversation_config: { agent: { first_message: 'Hi, this is Sara…', prompt: { prompt: 'You are Sara…', llm: 'claude', tools: [{ name: 'send_documents' }] } } } })],
    ]);
    const sync = await app.inject({ method: 'POST', url: `/api/integrations/${integrationId}/sync` });
    expect(json(sync).jobId).toBeTruthy();
    const ran = await drain(db);
    expect(ran.filter((j) => !j.ok)).toEqual([]);
    // Only finished conversations are ingested; the agent filter goes to the list call.
    expect(calls.find((c) => c.startsWith('GET /v1/convai/conversations?'))).toContain('agent_id=agent_el_1');
    expect(calls.some((c) => c.includes('conv_live'))).toBe(false);

    const integ = json(await app.inject({ method: 'GET', url: '/api/integrations' })).find((i: { id: string }) => i.id === integrationId);
    expect(integ).toMatchObject({ callsImported: 1, lastError: null });
    expect(integ.lastSyncStatus).toMatch(/^ok/);
    const detail = json(await app.inject({ method: 'GET', url: '/api/calls/el_conv_01' }));
    expect(detail.promptVersion).toBe('v7');
    vi.unstubAllGlobals();
  });

  it('accepts a signed post-call webhook with the transcript inline', async () => {
    stubFetch([[/\/v1\/convai\/agents\/agent_el_1$/, () => ({ agent_id: 'agent_el_1', name: 'Fakhruddin outbound', conversation_config: { agent: { prompt: { prompt: 'You are Sara…' } } } })]]);
    const body = JSON.stringify({ type: 'post_call_transcription', event_timestamp: Math.floor(Date.now() / 1000), data: elevenLabsConversation('conv_02') });
    const r = await app.inject({ method: 'POST', url: `/webhooks/elevenlabs/${integrationId}`, payload: body, headers: { 'content-type': 'application/json', 'elevenlabs-signature': elevenLabsSignature('wsec_test', body) } });
    expect(r.statusCode).toBe(200);
    await drain(db);
    const row = await db.one<{ status: string }>("select status from calls where call_id = 'el_conv_02'");
    expect(row?.status).toBe('scored');
    vi.unstubAllGlobals();
  });
});

describe('CRM outcomes', () => {
  it('credits a CSV outcome to the call that preceded it and skips bad rows', async () => {
    const at = new Date(Date.now() - 1800_000).toISOString();
    const csv = `lead_id,stage,occurred_at,project,value_aed\nlead_123,Meeting booked,${at},Treppan Tower,\nlead_123,not-a-stage,${at},,\n"lead_999",sale,${at},"Hatta Lakes","1,250,000"\n`;
    const r = await app.inject({ method: 'POST', url: '/api/crm/outcomes/csv', payload: csv, headers: { 'content-type': 'text/csv' } });
    expect(json(r)).toMatchObject({ imported: 2, skipped: 1 });
    const o = await db.one<{ credited_call_id: string | null }>("select credited_call_id from lead_outcome where lead_id = 'lead_123'");
    expect(o?.credited_call_id).toMatch(/^el_conv_0[12]$/);
    const orphan = await db.one<{ credited_call_id: string | null; value_aed: string }>("select credited_call_id, value_aed from lead_outcome where lead_id = 'lead_999'");
    expect(orphan?.credited_call_id).toBeNull();
    expect(Number(orphan?.value_aed)).toBe(1250000);
  });
});

describe('console endpoints on demo data', () => {
  beforeAll(async () => { await seedDemo(db, { count: 400, days: 30 }); });

  const endpoints = ['/api/meta', '/api/settings', '/api/matrix', '/api/matrix?range=7', '/api/calls?limit=5', '/api/version-report', '/api/traces', '/api/funnel', '/api/fix',
    '/api/recommendations', '/api/taxonomy/health', '/api/alerts', '/api/review', '/api/recordings', '/api/jobs', '/api/integrations', '/api/attention-items', '/healthz'];
  it.each(endpoints)('GET %s answers 200', async (url) => {
    const r = await app.inject({ method: 'GET', url });
    expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
  });

  it('serves a cell drill-down and a call with spans, metrics and evidence', async () => {
    const m = json(await app.inject({ method: 'GET', url: '/api/matrix' }));
    const cell = m.cells.find((c: { n: number }) => c.n > 0);
    const d = await app.inject({ method: 'GET', url: `/api/cells/${cell.pid}/${cell.sid}` });
    expect(d.statusCode).toBe(200);
    const list = json(await app.inject({ method: 'GET', url: '/api/calls?limit=1' }));
    const call = json(await app.inject({ method: 'GET', url: `/api/calls/${list.items[0].id}` }));
    expect(call.metrics.length).toBeGreaterThan(10);
    expect(call.turns.length).toBeGreaterThan(2);
  });

  // By now the database holds three agents (demo, Retell, ElevenLabs) with their own version labels;
  // recommendations must come from each agent's live version, not one label across all of them.
  it('moves a recommendation through its lifecycle', async () => {
    const recs = json(await app.inject({ method: 'GET', url: '/api/recommendations' }));
    expect(recs.length).toBeGreaterThan(0);
    const id = recs.find((r: { status: string }) => r.status === 'proposed').id;
    const r = await app.inject({ method: 'PATCH', url: `/api/recommendations/${id}`, payload: { status: 'accepted', note: 'Ship in the next prompt.' } });
    expect(json(r).status).toBe('accepted');
    const bad = await app.inject({ method: 'PATCH', url: `/api/recommendations/${id}`, payload: { status: 'nonsense' } });
    expect(bad.statusCode).toBe(400);
  });

  it('updates settings', async () => {
    const r = await app.inject({ method: 'PUT', url: '/api/settings', payload: { goodLine: 72 } });
    expect(json(r).goodLine).toBe(72);
  });
});
