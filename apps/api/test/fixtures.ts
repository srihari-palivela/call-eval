// Provider payloads shaped like the official SDKs' wire types, plus helpers to sign webhooks,
// stub provider APIs and drain the job queue in tests.

import { createHmac } from 'node:crypto';
import { vi } from 'vitest';
import type { Db } from '../src/db';
import { claim, complete, fail } from '../src/jobs/queue';
import { runJob } from '../src/jobs/handlers';

/** An ElevenLabs conversation (GET /v1/convai/conversations/{id}): an investor asking for a brochure. */
export function elevenLabsConversation(id = 'conv_01', startUnix = Math.floor(Date.now() / 1000) - 3600) {
  return {
    agent_id: 'agent_el_1',
    agent_name: 'Fakhruddin outbound',
    conversation_id: id,
    version_id: 'agtvrsn_7',
    status: 'done',
    has_audio: true,
    has_user_audio: true,
    has_response_audio: true,
    transcript: [
      { role: 'agent', message: 'Hi, this is Sara from Fakhruddin Properties. Am I speaking with Omar?', time_in_call_secs: 0 },
      { role: 'user', message: 'Yes, this is Omar.', time_in_call_secs: 5 },
      {
        role: 'agent', message: 'Thanks for your enquiry about Treppan Tower, Omar. Are you looking at it as an investment, or to live in yourself?', time_in_call_secs: 7,
        conversation_turn_metrics: { metrics: { convai_llm_service_ttfb: { elapsed_time: 0.62 }, convai_tts_service_ttfb: { elapsed_time: 0.21 } } },
      },
      { role: 'user', message: "It's an investment. I want rental income, budget around one and a half million.", time_in_call_secs: 14 },
      { role: 'user', message: 'mm-hmm', time_in_call_secs: 18, ignored_as_backchannel: true },
      {
        role: 'agent', message: 'Let me check the latest availability for you.', time_in_call_secs: 19,
        tool_calls: [{ request_id: 'tc_1', tool_name: 'get_project_details', params_as_json: '{"project":"Treppan Tower","bedrooms":1}', tool_has_been_called: true, type: 'webhook' }],
      },
      { role: 'agent', message: null, time_in_call_secs: 20, tool_results: [{ request_id: 'tc_1', tool_name: 'get_project_details', result_value: '{"starting_price_aed":1250000,"handover":"Q4 2027"}', is_error: false, tool_latency_secs: 0.8, type: 'webhook' }] },
      { role: 'agent', message: 'One-bedroom apartments start at one point two five million dirhams, with handover in the last quarter of 2027.', time_in_call_secs: 22 },
      { role: 'user', message: 'Okay. Can you send me the brochure on WhatsApp?', time_in_call_secs: 31 },
      {
        role: 'agent', message: 'Of course. I will send the brochure to this number on WhatsApp.', time_in_call_secs: 34,
        tool_calls: [{ request_id: 'tc_2', tool_name: 'send_documents', params_as_json: '{"project":"Treppan Tower","document":"brochure","channel":"whatsapp"}', tool_has_been_called: true, type: 'webhook' }],
      },
      { role: 'agent', message: null, time_in_call_secs: 35, tool_results: [{ request_id: 'tc_2', tool_name: 'send_documents', result_value: '{"status":"sent"}', is_error: false, tool_latency_secs: 0.5, type: 'webhook' }] },
      { role: 'agent', message: 'It is in your WhatsApp now. Thank you, Omar, and have a lovely day.', time_in_call_secs: 37, interrupted: false },
    ],
    metadata: {
      start_time_unix_secs: startUnix,
      call_duration_secs: 44,
      termination_reason: 'end_call tool was called.',
      main_language: 'en',
      cost: 412,
      phone_call: { direction: 'outbound', agent_number: '+97140000000', external_number: '+971500000001' },
    },
    analysis: {
      call_successful: 'success',
      transcript_summary: 'Omar is an investor interested in Treppan Tower; the brochure was sent on WhatsApp.',
      evaluation_criteria_results: { brochure_sent: { criteria_id: 'brochure_sent', result: 'success', rationale: 'Sent on WhatsApp.' } },
      data_collection_results: { budget: { data_collection_id: 'budget', value: '1.5M AED', rationale: 'Stated by caller.' } },
    },
    conversation_initiation_client_data: { dynamic_variables: { lead_id: 'lead_123', prompt_version: 'v7', customer_name: 'Omar' } },
  };
}

const words = (text: string, start: number) => {
  let t = start;
  return text.split(/\s+/).map((w) => { const s = t; t += 0.35; return { word: w, start: +s.toFixed(2), end: +(s + 0.3).toFixed(2) }; });
};

/** A Retell call (GET /v2/get-call/{id}): a caller asks for a person and is transferred. */
export function retellCall(id = 'call_abc', startMs = Date.now() - 2 * 3600_000) {
  const u = (role: 'agent' | 'user' | 'transfer_target', content: string, start: number) => ({ role, content, words: words(content, start) });
  const t = [
    u('agent', 'Thank you for calling Fakhruddin Properties, this is Sara. How can I help?', 0.2),
    u('user', 'Hi, I would like to know about Hatta Lakes. Can you send me the floor plans?', 5),
    u('agent', 'Of course. Shall I send them to this number on WhatsApp?', 10.5),
    u('user', 'Yes please. And can I speak to someone now?', 14),
    u('agent', 'Let me connect you with one of our advisors, one moment please.', 18),
    u('transfer_target', 'Hello, this is Ahmed from the sales team.', 25),
  ];
  return {
    call_id: id,
    call_type: 'phone_call',
    agent_id: 'agent_rt_1',
    agent_name: 'Fakhruddin inbound',
    agent_version: 3,
    call_status: 'ended',
    direction: 'inbound',
    from_number: '+971500000002',
    to_number: '+97140000001',
    start_timestamp: startMs,
    end_timestamp: startMs + 30_000,
    duration_ms: 30_000,
    disconnection_reason: 'call_transfer',
    transcript_object: t,
    transcript_with_tool_calls: [
      t[0], t[1],
      // The documents tool fires after the caller's yes, before the agent speaks again.
      t[2], t[3],
      { role: 'tool_call_invocation', tool_call_id: 'tc_doc', name: 'send_documents', arguments: '{"project":"Hatta Lakes","document":"floor_plans","channel":"whatsapp"}', type: 'custom' },
      { role: 'tool_call_result', tool_call_id: 'tc_doc', content: '{"status":"sent"}', successful: true },
      t[4],
      { role: 'tool_call_invocation', tool_call_id: 'tc_xfer', name: 'transfer_to_sales', arguments: '{}', type: 'transfer_call' },
      { role: 'tool_call_result', tool_call_id: 'tc_xfer', content: 'transferred', successful: true },
      t[5],
    ],
    recording_url: 'https://recordings.example.com/call_abc.wav',
    recording_multi_channel_url: 'https://recordings.example.com/call_abc_multi.wav',
    latency: { e2e: { p50: 1100, p90: 2300 }, llm: { p50: 600, p90: 900 }, tts: { p50: 200, p90: 350 } },
    call_analysis: { call_summary: 'Caller asked about Hatta Lakes and was transferred.', user_sentiment: 'Positive', call_successful: true, in_voicemail: false, custom_analysis_data: { project: 'Hatta Lakes' } },
    retell_llm_dynamic_variables: { lead_id: 'lead_456', prompt_version: 'v2' },
    call_cost: { combined_cost: 37.5 },
  };
}

export const retellSignature = (apiKey: string, body: string, ms = Date.now()) =>
  `v=${ms},d=${createHmac('sha256', apiKey).update(body + ms).digest('hex')}`;

export const elevenLabsSignature = (secret: string, body: string, s = Math.floor(Date.now() / 1000)) =>
  `t=${s},v0=${createHmac('sha256', secret).update(`${s}.${body}`).digest('hex')}`;

type Route = [RegExp, (url: URL, init?: RequestInit) => unknown];

/** Replace global fetch with canned provider responses; unknown URLs fail loudly. */
export function stubFetch(routes: Route[]) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    const r = routes.find(([rx]) => rx.test(url.pathname));
    if (!r) return new Response(JSON.stringify({ detail: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(r[1](url, init)), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

/** Run queued jobs until the queue is empty, as the worker would. */
export async function drain(db: Db, max = 200) {
  const ran: { kind: string; ok: boolean; error?: string }[] = [];
  for (let i = 0; i < max; i++) {
    const job = await claim(db, 'test');
    if (!job) break;
    try {
      await runJob(db, job);
      await complete(db, job.id);
      ran.push({ kind: job.kind, ok: true });
    } catch (e) {
      await fail(db, { ...job, attempts: job.max_attempts }, String(e));
      ran.push({ kind: job.kind, ok: false, error: String(e) });
    }
  }
  return ran;
}
