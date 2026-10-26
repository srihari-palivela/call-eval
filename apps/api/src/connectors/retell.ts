// Retell AI connector. Endpoints and field names follow the official SDK (retell-sdk):
//   POST /v3/list-calls              filter_criteria.agent[].agent_id, start_timestamp, limit, pagination_key
//   GET  /v2/get-call/{call_id}      transcript_object (words with timestamps), transcript_with_tool_calls,
//                                    latency (e2e/llm/tts p50/p90 ms), call_analysis, recording urls
//   GET  /get-agent/{agent_id}       response_engine {type, llm_id, version}
//   GET  /get-retell-llm/{llm_id}    general_prompt, begin_message, states[].state_prompt
// Auth: Authorization: Bearer <api key>. Webhooks: x-retell-signature: v=<ms>,d=<HMAC-SHA256(api key, body + ms)>.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { DEFAULT_TOOL_ALIASES, type CanonicalCall, type CanonicalToolCall, type CanonicalTurn, type EndReason } from '@calleval/framework';
import { fetchRetry, getJson } from '../lib/http';
import { type Connector, type Credentials, estimateEnd, extractTags, header } from './types';

const DEFAULT_BASE = 'https://api.retellai.com';
const base = (c: Credentials) => (c.baseUrl || DEFAULT_BASE).replace(/\/$/, '');
const auth = (c: Credentials) => ({ authorization: `Bearer ${c.apiKey}` });

type Word = { word?: string; start?: number; end?: number };
type Utterance = { role: 'agent' | 'user' | 'transfer_target'; content: string; words?: Word[] };
type ToolInvocation = { role: 'tool_call_invocation'; tool_call_id: string; name: string; arguments: string; type?: string };
type ToolResult = { role: 'tool_call_result'; tool_call_id: string; content: string; successful?: boolean };
type RetellCall = {
  call_id: string;
  call_type?: 'web_call' | 'phone_call';
  agent_id: string;
  agent_name?: string;
  agent_version?: number;
  call_status?: string;
  direction?: 'inbound' | 'outbound';
  from_number?: string;
  to_number?: string;
  start_timestamp?: number;
  end_timestamp?: number;
  duration_ms?: number;
  disconnection_reason?: string;
  transcript_object?: Utterance[];
  transcript_with_tool_calls?: (Utterance | ToolInvocation | ToolResult | { role: string })[];
  recording_url?: string;
  recording_multi_channel_url?: string;
  latency?: Record<string, { p50?: number; p90?: number } | undefined>;
  call_analysis?: { call_summary?: string; user_sentiment?: string; call_successful?: boolean; in_voicemail?: boolean; custom_analysis_data?: unknown };
  retell_llm_dynamic_variables?: Record<string, string>;
  collected_dynamic_variables?: Record<string, string>;
  metadata?: any;
  call_cost?: { combined_cost?: number };
};

export function mapDisconnection(r: string | undefined, inVoicemail?: boolean): EndReason {
  if (inVoicemail) return 'voicemail';
  switch (r) {
    case 'agent_hangup': return 'natural_close';
    case 'user_hangup': case 'inactivity': return 'caller_hangup';
    case 'call_transfer': case 'transfer_bridged': return 'transfer';
    case 'voicemail_reached': case 'ivr_reached': return 'voicemail';
    case 'max_duration_reached': return 'time_limit';
    case 'user_requested_dnc': return 'dnc';
    case 'user_requested_callback': return 'natural_close';
    case 'dial_busy': case 'dial_failed': case 'dial_no_answer': case 'user_declined': return 'no_answer';
    case undefined: case null: return 'unknown';
    default: return r.startsWith('error') ? 'error' : 'unknown';
  }
}

const isUtterance = (e: any): e is Utterance => e && (e.role === 'agent' || e.role === 'user' || e.role === 'transfer_target') && typeof e.content === 'string';

function parseArgs(s: string | undefined): Record<string, unknown> {
  if (!s) return {};
  try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : { value: v }; } catch { return { raw: s }; }
}

export function normaliseRetell(raw: unknown): CanonicalCall {
  const c = raw as RetellCall;
  const utterances = (c.transcript_object ?? []).filter(isUtterance);
  const turns: CanonicalTurn[] = [];
  const sourceIdx: number[] = []; // utterance index → turn idx (or -1 for transfer_target)
  for (const u of utterances) {
    if (u.role === 'transfer_target') { sourceIdx.push(-1); continue; } // the human advisor is out of scope
    const words = (u.words ?? []).filter((w) => typeof w.start === 'number' && typeof w.end === 'number');
    const speaker = u.role === 'agent' ? 'agent' : 'caller';
    sourceIdx.push(turns.length);
    turns.push({
      idx: turns.length,
      speaker,
      text: u.content.trim(),
      startS: words.length ? words[0].start! : turns.length ? (turns[turns.length - 1].endS ?? 0) + 0.5 : 0,
      endS: words.length ? words[words.length - 1].end! : undefined,
      words: words.length ? words.map((w) => ({ w: w.word ?? '', s: w.start!, e: w.end! })) : undefined,
      tags: speaker === 'agent' ? extractTags(u.content) : undefined,
    });
  }
  for (let i = 0; i < turns.length; i++) if (turns[i].endS === undefined) turns[i].endS = estimateEnd(turns[i].startS, turns[i].text, turns[i].speaker, turns[i + 1]?.startS);

  // Walk the interleaved transcript to place tool calls on agent turns.
  const toolCalls: CanonicalToolCall[] = [];
  const results = new Map<string, ToolResult>();
  for (const e of c.transcript_with_tool_calls ?? []) if ((e as ToolResult).role === 'tool_call_result') results.set((e as ToolResult).tool_call_id, e as ToolResult);
  let uttSeen = -1;
  let lastTurn: CanonicalTurn | null = null;
  const pendingAfterCaller: CanonicalToolCall[] = [];
  for (const e of c.transcript_with_tool_calls ?? []) {
    if (isUtterance(e)) {
      uttSeen++;
      const ti = sourceIdx[uttSeen];
      if (ti === undefined || ti < 0) continue;
      lastTurn = turns[ti];
      if (lastTurn.speaker === 'agent') for (const p of pendingAfterCaller.splice(0)) p.turnIdx = lastTurn.idx;
      continue;
    }
    if ((e as ToolInvocation).role !== 'tool_call_invocation') continue;
    const inv = e as ToolInvocation;
    const res = results.get(inv.tool_call_id);
    const aliased = inv.type && inv.type !== 'custom' && inv.type in DEFAULT_TOOL_ALIASES ? DEFAULT_TOOL_ALIASES[inv.type] : inv.type === 'end_call' ? 'end_call' : inv.name;
    const tc: CanonicalToolCall = {
      id: inv.tool_call_id,
      turnIdx: lastTurn?.speaker === 'agent' ? lastTurn.idx : -1,
      name: aliased || inv.name,
      rawName: inv.name,
      args: parseArgs(inv.arguments),
      resultText: res?.content,
      result: res?.content ? parseArgs(res.content) : undefined,
      ok: res ? res.successful ?? !/\berror\b/i.test(res.content ?? '') : undefined,
      startS: lastTurn?.endS ?? undefined,
    };
    if (tc.turnIdx < 0) pendingAfterCaller.push(tc);
    toolCalls.push(tc);
  }
  const lastAgent = [...turns].reverse().find((t) => t.speaker === 'agent');
  for (const p of pendingAfterCaller) p.turnIdx = lastAgent?.idx ?? 0;

  const dyn: Record<string, unknown> = { ...(c.retell_llm_dynamic_variables ?? {}), ...(c.collected_dynamic_variables ?? {}) };
  const md = (c.metadata && typeof c.metadata === 'object') ? c.metadata : {};
  const ms = (v?: number) => (typeof v === 'number' ? v / 1000 : undefined);
  const lat = c.latency ?? {};
  const durationS = c.duration_ms !== undefined ? c.duration_ms / 1000 : c.start_timestamp && c.end_timestamp ? (c.end_timestamp - c.start_timestamp) / 1000 : (turns[turns.length - 1]?.endS ?? 0);

  return {
    provider: 'retell',
    externalId: c.call_id,
    agentExternalId: c.agent_id,
    agentName: c.agent_name ?? null,
    agentVersion: c.agent_version !== undefined ? String(c.agent_version) : null,
    startedAt: new Date(c.start_timestamp ?? Date.now()).toISOString(),
    durationS,
    direction: c.direction ?? 'unknown',
    endReason: mapDisconnection(c.disconnection_reason, c.call_analysis?.in_voicemail),
    endReasonRaw: c.disconnection_reason ?? null,
    language: (typeof dyn.language === 'string' ? dyn.language : null),
    fromNumber: c.from_number ?? null,
    toNumber: c.to_number ?? null,
    dynamicVariables: dyn,
    turns,
    toolCalls,
    recording: { available: !!(c.recording_multi_channel_url || c.recording_url), url: c.recording_url ?? null, multiChannelUrl: c.recording_multi_channel_url ?? null, channels: c.recording_multi_channel_url ? 2 : c.recording_url ? 1 : null },
    providerAnalysis: c.call_analysis ? {
      summary: c.call_analysis.call_summary ?? null,
      successful: c.call_analysis.call_successful ?? null,
      sentiment: c.call_analysis.user_sentiment ?? null,
      dataCollection: c.call_analysis.custom_analysis_data && typeof c.call_analysis.custom_analysis_data === 'object'
        ? Object.fromEntries(Object.entries(c.call_analysis.custom_analysis_data as Record<string, unknown>).map(([k, v]) => [k, { value: v }]))
        : undefined,
    } : null,
    latency: { e2eP50: ms(lat.e2e?.p50), e2eP90: ms(lat.e2e?.p90), llmP50: ms(lat.llm?.p50), llmP90: ms(lat.llm?.p90), ttsP50: ms(lat.tts?.p50), ttsP90: ms(lat.tts?.p90) },
    cost: typeof c.call_cost?.combined_cost === 'number' ? { amount: c.call_cost.combined_cost / 100, currency: 'USD' } : null,
    leadId: (md.lead_id as string) ?? (typeof dyn.lead_id === 'string' ? dyn.lead_id : null),
    promptVersionHint: (typeof dyn.prompt_version === 'string' ? dyn.prompt_version : null) ?? (md.prompt_version as string) ?? null,
  };
}

export const retell: Connector = {
  provider: 'retell',

  async listCalls(creds, { since, cursor, agentId }) {
    const filter: Record<string, unknown> = {};
    if (agentId) filter.agent = [{ agent_id: agentId }];
    if (since) filter.start_timestamp = { op: 'ge', type: 'number', value: since.getTime() };
    const body: Record<string, unknown> = { filter_criteria: filter, limit: 100, sort_order: 'ascending' };
    if (cursor) body.pagination_key = cursor;
    const page = await getJson<{ items: { call_id: string; start_timestamp?: number; call_status?: string }[]; has_more: boolean; pagination_key?: string }>(
      `${base(creds)}/v3/list-calls`, { ...auth(creds), 'content-type': 'application/json' }, { method: 'POST', body: JSON.stringify(body) },
    );
    return {
      calls: (page.items ?? []).map((c) => ({ externalId: c.call_id, startedAt: c.start_timestamp ? new Date(c.start_timestamp).toISOString() : null, complete: c.call_status === 'ended' || c.call_status === 'error' || c.call_status === 'not_connected' })),
      cursor: page.pagination_key ?? null,
      done: !page.has_more || !page.pagination_key,
    };
  },

  async fetchCall(creds, externalId) {
    const raw = await getJson<RetellCall>(`${base(creds)}/v2/get-call/${encodeURIComponent(externalId)}`, auth(creds));
    return { canonical: normaliseRetell(raw), raw };
  },

  normalise: normaliseRetell,

  async fetchAgent(creds, agentId, version) {
    const q = version ? `?version=${encodeURIComponent(version)}` : '';
    const a = await getJson<any>(`${base(creds)}/get-agent/${encodeURIComponent(agentId)}${q}`, auth(creds));
    const eng = a?.response_engine ?? {};
    let prompt: string | null = null, firstMessage: string | null = null, cfg: unknown = { engine: eng.type ?? null };
    if (eng.type === 'retell-llm' && eng.llm_id) {
      const lq = eng.version !== undefined && eng.version !== null ? `?version=${eng.version}` : '';
      const llm = await getJson<any>(`${base(creds)}/get-retell-llm/${encodeURIComponent(eng.llm_id)}${lq}`, auth(creds));
      const states = Array.isArray(llm?.states) ? llm.states.map((s: any) => `## State: ${s.name}\n${s.state_prompt ?? ''}`).join('\n\n') : '';
      prompt = [llm?.general_prompt ?? '', states].filter(Boolean).join('\n\n') || null;
      firstMessage = llm?.begin_message ?? null;
      cfg = { engine: 'retell-llm', model: llm?.model ?? null, tools: (llm?.general_tools ?? []).map((t: any) => t?.name).filter(Boolean) };
    }
    return { externalId: a.agent_id ?? agentId, name: a.agent_name ?? null, prompt, firstMessage, providerVersion: a.version !== undefined ? String(a.version) : null, config: cfg };
  },

  async listAgents(creds) {
    const r = await getJson<any>(`${base(creds)}/v2/list-agents`, { ...auth(creds), 'content-type': 'application/json' }, { method: 'POST', body: JSON.stringify({ limit: 100 }) }).catch(async () => getJson<any>(`${base(creds)}/list-agents`, auth(creds)));
    const items = Array.isArray(r) ? r : r?.items ?? [];
    const seen = new Map<string, string>();
    for (const a of items) if (a?.agent_id && !seen.has(a.agent_id)) seen.set(a.agent_id, a.agent_name ?? a.agent_id);
    return Array.from(seen, ([id, name]) => ({ id, name }));
  },

  async fetchAudio(_creds, call) {
    const url = call.recording?.multiChannelUrl ?? call.recording?.url;
    if (!url) return null;
    return fetchRetry(url, { timeoutMs: 120_000, retries: 2 });
  },

  async verifyWebhook(rawBody, headers, creds) {
    const sig = header(headers, 'x-retell-signature');
    if (!sig || !creds.apiKey) return false;
    const m = /^v=(\d+),d=([0-9a-f]{64})$/i.exec(sig);
    if (!m) return false;
    const ts = Number(m[1]);
    if (!Number.isSafeInteger(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) return false;
    const digest = createHmac('sha256', creds.apiKey).update(rawBody + m[1]).digest();
    const given = Buffer.from(m[2], 'hex');
    return given.length === digest.length && timingSafeEqual(given, digest);
  },

  parseWebhook(body) {
    const event = body?.event as string | undefined;
    const call = body?.call;
    if (!event || !call?.call_id) return { kind: 'ignore', reason: 'not a call event' };
    if (event === 'call_analyzed' || event === 'call_ended') return { kind: 'call', externalId: call.call_id, event, raw: Array.isArray(call.transcript_object) ? call : null };
    return { kind: 'ignore', reason: `unhandled event ${event}` };
  },
};
