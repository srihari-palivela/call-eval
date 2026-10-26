// ElevenLabs Agents Platform (Conversational AI) connector.
// Endpoints and field names follow the official SDK's wire types (@elevenlabs/elevenlabs-js):
//   GET  /v1/convai/conversations                 list (agent_id, cursor, page_size ≤ 100, call_start_after_unix)
//   GET  /v1/convai/conversations/{id}            transcript, metadata, analysis, initiation data
//   GET  /v1/convai/conversations/{id}/audio      recording
//   GET  /v1/convai/agents/{id}                   conversation_config.agent.prompt.prompt, first_message, version_id
// Auth header: xi-api-key. Post-call webhooks are signed: ElevenLabs-Signature: t=<s>,v0=<HMAC-SHA256(secret, `${t}.${body}`)>.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CanonicalCall, CanonicalToolCall, CanonicalTurn, Direction, EndReason } from '@calleval/framework';
import { fetchRetry, getJson } from '../lib/http';
import { type Connector, type Credentials, estimateEnd, extractTags, header } from './types';

const DEFAULT_BASE = 'https://api.elevenlabs.io';
const base = (c: Credentials) => (c.baseUrl || DEFAULT_BASE).replace(/\/$/, '');
const auth = (c: Credentials) => ({ 'xi-api-key': c.apiKey });

type ElTranscriptItem = {
  role: 'user' | 'agent';
  message?: string | null;
  time_in_call_secs: number;
  interrupted?: boolean | null;
  tool_calls?: { request_id: string; tool_name: string; params_as_json: string; tool_has_been_called?: boolean; type?: string | null }[] | null;
  tool_results?: { request_id: string; tool_name: string; result_value?: string; is_error?: boolean; tool_latency_secs?: number | null; type?: string | null }[] | null;
  conversation_turn_metrics?: { metrics?: Record<string, { elapsed_time: number }> | null } | null;
  ignored_as_backchannel?: boolean | null;
};

type ElConversation = {
  conversation_id: string;
  agent_id: string;
  agent_name?: string | null;
  version_id?: string | null;
  branch_id?: string | null;
  status: string;
  user_id?: string | null;
  has_audio?: boolean;
  has_user_audio?: boolean;
  has_response_audio?: boolean;
  transcript: ElTranscriptItem[];
  metadata: {
    start_time_unix_secs: number;
    call_duration_secs: number;
    termination_reason?: string | null;
    main_language?: string | null;
    cost?: number | null;
    phone_call?: { direction?: 'inbound' | 'outbound'; agent_number?: string; external_number?: string } | null;
  };
  analysis?: {
    evaluation_criteria_results?: Record<string, { criteria_id: string; result: string; rationale: string }> | null;
    data_collection_results?: Record<string, { data_collection_id: string; value?: unknown; rationale: string }> | null;
    call_successful?: string;
    transcript_summary?: string;
  } | null;
  conversation_initiation_client_data?: { dynamic_variables?: Record<string, unknown> | null; user_id?: string | null } | null;
};

export function mapTermination(reason: string | null | undefined): EndReason {
  const r = (reason ?? '').toLowerCase();
  if (!r) return 'unknown';
  if (r.includes('max') && r.includes('duration')) return 'time_limit';
  if (r.includes('voicemail')) return 'voicemail';
  if (r.includes('transfer')) return 'transfer';
  if (r.includes('end_call') || r.includes('agent ended') || r.includes('agent')) return 'natural_close';
  if (r.includes('remote party') || r.includes('client disconnected') || r.includes('user') || r.includes('hang')) return 'caller_hangup';
  if (r.includes('no answer') || r.includes('busy')) return 'no_answer';
  if (r.includes('error') || r.includes('fail')) return 'error';
  return 'unknown';
}

function parseArgs(s: string | undefined | null): Record<string, unknown> {
  if (!s) return {};
  try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : { value: v }; } catch { return { raw: s }; }
}

export function normaliseElevenLabs(raw: unknown): CanonicalCall {
  const c = raw as ElConversation;
  const items = (c.transcript ?? []).filter(Boolean);
  const turns: CanonicalTurn[] = [];
  const toolCalls: CanonicalToolCall[] = [];
  const pending: { tc: NonNullable<ElTranscriptItem['tool_calls']>[number]; at: number; afterTurn: number | null }[] = [];
  const results = new Map<string, NonNullable<ElTranscriptItem['tool_results']>[number]>();

  for (const it of items) for (const r of it.tool_results ?? []) results.set(r.request_id, r);

  for (const it of items) {
    const text = (it.message ?? '').trim();
    const speaker = it.role === 'agent' ? 'agent' : 'caller';
    if (text && !(speaker === 'caller' && it.ignored_as_backchannel)) {
      const metrics: Record<string, number> = {};
      for (const [k, v] of Object.entries(it.conversation_turn_metrics?.metrics ?? {})) if (v && typeof v.elapsed_time === 'number') metrics[k] = v.elapsed_time;
      turns.push({ idx: turns.length, speaker, text, startS: it.time_in_call_secs ?? 0, interrupted: !!it.interrupted, turnMetrics: Object.keys(metrics).length ? metrics : undefined, tags: speaker === 'agent' ? extractTags(text) : undefined });
    }
    for (const tc of it.tool_calls ?? []) {
      const last = turns[turns.length - 1];
      // A tool call in the same item as spoken text, or right after an agent turn, belongs to that turn;
      // one that arrives after the caller spoke belongs to the agent's next turn (dead air before it).
      pending.push({ tc, at: it.time_in_call_secs ?? 0, afterTurn: last && last.speaker === 'agent' ? last.idx : null });
    }
  }

  for (let i = 0; i < turns.length; i++) {
    const next = turns.slice(i + 1).find(() => true);
    turns[i].endS = estimateEnd(turns[i].startS, turns[i].text, turns[i].speaker, next?.startS);
  }

  for (const p of pending) {
    let turnIdx = p.afterTurn;
    if (turnIdx === null) turnIdx = turns.find((t) => t.speaker === 'agent' && t.startS >= p.at)?.idx ?? turns.filter((t) => t.speaker === 'agent').slice(-1)[0]?.idx ?? 0;
    const r = results.get(p.tc.request_id);
    toolCalls.push({
      id: p.tc.request_id,
      turnIdx,
      name: p.tc.tool_name,
      rawName: p.tc.tool_name,
      args: parseArgs(p.tc.params_as_json),
      resultText: r?.result_value ?? undefined,
      result: r?.result_value ? parseArgs(r.result_value) : undefined,
      ok: r ? !r.is_error : undefined,
      startS: p.at,
      durationS: r?.tool_latency_secs ?? undefined,
    });
  }

  const md = c.metadata ?? ({} as ElConversation['metadata']);
  const dyn = { ...(c.conversation_initiation_client_data?.dynamic_variables ?? {}) } as Record<string, unknown>;
  const pc = md.phone_call ?? null;
  const direction: Direction = pc?.direction ?? (typeof dyn.direction === 'string' && ['inbound', 'outbound'].includes(dyn.direction) ? (dyn.direction as Direction) : 'unknown');
  const an = c.analysis ?? null;

  return {
    provider: 'elevenlabs',
    externalId: c.conversation_id,
    agentExternalId: c.agent_id,
    agentName: c.agent_name ?? null,
    agentVersion: c.version_id ?? c.branch_id ?? null,
    startedAt: new Date((md.start_time_unix_secs ?? 0) * 1000).toISOString(),
    durationS: md.call_duration_secs ?? 0,
    direction,
    endReason: mapTermination(md.termination_reason),
    endReasonRaw: md.termination_reason ?? null,
    language: md.main_language ?? null,
    fromNumber: pc ? (pc.direction === 'inbound' ? pc.external_number : pc.agent_number) ?? null : null,
    toNumber: pc ? (pc.direction === 'inbound' ? pc.agent_number : pc.external_number) ?? null : null,
    dynamicVariables: dyn,
    turns,
    toolCalls,
    recording: { available: !!c.has_audio, channels: 1, url: null, multiChannelUrl: null },
    providerAnalysis: an ? {
      summary: an.transcript_summary ?? null,
      successful: an.call_successful === 'success' ? true : an.call_successful === 'failure' ? false : null,
      evaluationCriteria: Object.fromEntries(Object.entries(an.evaluation_criteria_results ?? {}).map(([k, v]) => [k, { result: v.result, rationale: v.rationale }])),
      dataCollection: Object.fromEntries(Object.entries(an.data_collection_results ?? {}).map(([k, v]) => [k, { value: v.value ?? null, rationale: v.rationale }])),
    } : null,
    latency: null,
    cost: typeof md.cost === 'number' ? { amount: md.cost, currency: 'credits' } : null,
    leadId: (typeof dyn.lead_id === 'string' && dyn.lead_id) || c.conversation_initiation_client_data?.user_id || c.user_id || null,
    promptVersionHint: typeof dyn.prompt_version === 'string' ? dyn.prompt_version : null,
  };
}

export const elevenlabs: Connector = {
  provider: 'elevenlabs',

  async listCalls(creds, { since, cursor, agentId }) {
    const q = new URLSearchParams({ page_size: '100' });
    if (agentId) q.set('agent_id', agentId);
    if (since) q.set('call_start_after_unix', String(Math.floor(since.getTime() / 1000)));
    if (cursor) q.set('cursor', String(cursor));
    const page = await getJson<{ conversations: { conversation_id: string; start_time_unix_secs: number; status: string }[]; next_cursor?: string | null; has_more: boolean }>(`${base(creds)}/v1/convai/conversations?${q}`, auth(creds));
    return {
      calls: page.conversations.map((c) => ({ externalId: c.conversation_id, startedAt: new Date(c.start_time_unix_secs * 1000).toISOString(), complete: c.status === 'done' || c.status === 'failed' })),
      cursor: page.next_cursor ?? null,
      done: !page.has_more || !page.next_cursor,
    };
  },

  async fetchCall(creds, externalId) {
    const raw = await getJson<ElConversation>(`${base(creds)}/v1/convai/conversations/${encodeURIComponent(externalId)}`, auth(creds));
    return { canonical: normaliseElevenLabs(raw), raw };
  },

  normalise: normaliseElevenLabs,

  async fetchAgent(creds, agentId) {
    const a = await getJson<any>(`${base(creds)}/v1/convai/agents/${encodeURIComponent(agentId)}`, auth(creds));
    const agentCfg = a?.conversation_config?.agent ?? {};
    return {
      externalId: a.agent_id ?? agentId,
      name: a.name ?? null,
      prompt: agentCfg?.prompt?.prompt ?? null,
      firstMessage: agentCfg?.first_message ?? null,
      providerVersion: a.version_id ?? null,
      config: { llm: agentCfg?.prompt?.llm ?? null, tools: (agentCfg?.prompt?.tools ?? []).map((t: any) => t?.name).filter(Boolean), language: agentCfg?.language ?? null },
    };
  },

  async listAgents(creds) {
    const r = await getJson<{ agents: { agent_id: string; name: string }[] }>(`${base(creds)}/v1/convai/agents?page_size=100`, auth(creds));
    return (r.agents ?? []).map((a) => ({ id: a.agent_id, name: a.name }));
  },

  async fetchAudio(creds, call) {
    return fetchRetry(`${base(creds)}/v1/convai/conversations/${encodeURIComponent(call.externalId)}/audio`, { headers: auth(creds), timeoutMs: 120_000, retries: 2 });
  },

  async verifyWebhook(rawBody, headers, creds) {
    const secret = creds.webhookSecret;
    const sig = header(headers, 'elevenlabs-signature');
    if (!secret || !sig) return false;
    const parts = Object.fromEntries(sig.split(',').map((p) => { const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));
    const t = Number(parts.t);
    if (!parts.v0 || !isFinite(t)) return false;
    if (Math.abs(Date.now() - t * 1000) > 30 * 60 * 1000) return false;
    const digest = createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
    const a = Buffer.from(digest), b = Buffer.from(parts.v0);
    return a.length === b.length && timingSafeEqual(a, b);
  },

  parseWebhook(body) {
    const type = body?.type as string | undefined;
    const data = body?.data;
    if (!type || !data?.conversation_id) return { kind: 'ignore', reason: 'not a conversation event' };
    if (type === 'post_call_transcription') return { kind: 'call', externalId: data.conversation_id, event: type, raw: Array.isArray(data.transcript) ? data : null };
    if (type === 'post_call_audio') return { kind: 'ignore', reason: 'audio is fetched on demand' };
    if (type === 'call_initiation_failure') return { kind: 'ignore', reason: 'call never connected' };
    return { kind: 'ignore', reason: `unhandled event ${type}` };
  },
};
