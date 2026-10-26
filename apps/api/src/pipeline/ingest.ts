// Step 1: collect. Store the provider's call as a canonical record, link it to its agent, and work
// out which prompt version produced it so every score can be compared across releases.

import type { CanonicalCall } from '@calleval/framework';
import { json, type Db } from '../db';
import { callIdOf, newId, sha } from '../lib/ids';
import { errMsg, log } from '../lib/log';
import type { AgentInfo } from '../connectors/types';

const agentCache = new Map<string, { at: number; info: AgentInfo | null }>();

async function upsertAgent(db: Db, call: CanonicalCall, integrationId: string | null, info: AgentInfo | null): Promise<string | null> {
  if (!call.agentExternalId) return null;
  const id = `ag_${sha(`${call.provider}:${call.agentExternalId}`, 12)}`;
  await db.query(
    `insert into agent (id, provider, external_id, integration_id, name, prompt_text, first_message, config, prompt_hash, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9, now())
     on conflict (provider, external_id) do update set
       name = coalesce(excluded.name, agent.name),
       integration_id = coalesce(excluded.integration_id, agent.integration_id),
       prompt_text = coalesce(excluded.prompt_text, agent.prompt_text),
       first_message = coalesce(excluded.first_message, agent.first_message),
       config = coalesce(excluded.config, agent.config),
       prompt_hash = coalesce(excluded.prompt_hash, agent.prompt_hash),
       updated_at = now()`,
    [id, call.provider, call.agentExternalId, integrationId, info?.name ?? call.agentName ?? null, info?.prompt ?? null, info?.firstMessage ?? null, json(info?.config ?? null), info?.prompt ? sha(info.prompt) : null],
  );
  return id;
}

async function labelFor(db: Db, agentId: string | null, key: string, opts: { label?: string; prompt?: string | null; providerVersion?: string | null; source: string; at: string }): Promise<string> {
  const existing = await db.one<{ label: string }>('select label from prompt_version where agent_id is not distinct from $1 and hash = $2', [agentId, key]);
  if (existing) {
    await db.query('update prompt_version set last_seen_at = greatest(coalesce(last_seen_at, $3::timestamptz), $3::timestamptz), first_seen_at = least(first_seen_at, $3::timestamptz) where agent_id is not distinct from $1 and hash = $2', [agentId, key, opts.at]);
    return existing.label;
  }
  let label = opts.label;
  if (!label && opts.prompt) {
    const same = await db.one<{ label: string }>('select label from prompt_version where agent_id is not distinct from $1 and hash = $2', [agentId, `prompt:${sha(opts.prompt)}`]);
    label = same?.label;
  }
  if (!label) {
    const n = await db.one<{ n: number }>('select count(distinct label)::int as n from prompt_version where agent_id is not distinct from $1', [agentId]);
    label = `v${(n?.n ?? 0) + 1}`;
  }
  await db.query(
    `insert into prompt_version (id, agent_id, label, hash, prompt_text, provider_version, source, first_seen_at, last_seen_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$8)
     on conflict (agent_id, hash) do nothing`,
    [newId('pv'), agentId, label, key, opts.prompt ?? null, opts.providerVersion ?? null, opts.source, opts.at],
  );
  if (opts.prompt && !key.startsWith('prompt:')) {
    await db.query(`insert into prompt_version (id, agent_id, label, hash, prompt_text, provider_version, source, first_seen_at, last_seen_at) values ($1,$2,$3,$4,$5,$6,'prompt',$7,$7) on conflict (agent_id, hash) do nothing`,
      [newId('pv'), agentId, label, `prompt:${sha(opts.prompt)}`, opts.prompt, opts.providerVersion ?? null, opts.at]);
  }
  return label;
}

/**
 * Prompt version, in order of preference: an explicit `prompt_version` dynamic variable; the
 * provider's agent version (Retell agent_version, ElevenLabs version_id), labelled v1, v2, … per
 * agent in order of first appearance; or a hash of the agent's prompt at ingest time.
 */
export async function resolvePromptVersion(db: Db, agentId: string | null, call: CanonicalCall, info: AgentInfo | null): Promise<string | null> {
  if (call.promptVersionHint) return labelFor(db, agentId, `hint:${call.promptVersionHint}`, { label: call.promptVersionHint, source: 'dynamic_variable', at: call.startedAt });
  if (call.agentVersion) return labelFor(db, agentId, `pv:${call.agentVersion}`, { prompt: info?.prompt ?? null, providerVersion: call.agentVersion, source: 'provider_version', at: call.startedAt });
  if (info?.prompt) return labelFor(db, agentId, `prompt:${sha(info.prompt)}`, { prompt: info.prompt, source: 'prompt_hash', at: call.startedAt });
  return null;
}

export async function fetchAgentCached(key: string, fn: () => Promise<AgentInfo | null>): Promise<AgentInfo | null> {
  const hit = agentCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.info;
  let info: AgentInfo | null = null;
  try { info = await fn(); } catch (e) { log.warn('could not fetch agent configuration', { key, error: errMsg(e) }); }
  agentCache.set(key, { at: Date.now(), info });
  return info;
}

export async function storeCanonical(db: Db, call: CanonicalCall, raw: unknown, opts: { integrationId: string | null; source: 'live' | 'upload' | 'demo'; agentInfo?: AgentInfo | null; keepRaw?: boolean }): Promise<string> {
  const callId = callIdOf(call.provider, call.externalId);
  const agentId = await upsertAgent(db, call, opts.integrationId, opts.agentInfo ?? null);
  const version = await resolvePromptVersion(db, agentId, call, opts.agentInfo ?? null);
  await db.query(
    `insert into calls (call_id, provider, external_id, integration_id, agent_id, lead_id, started_at, duration_s, direction, end_reason, end_reason_raw, language,
        prompt_version, agent_version, source, recording_url, recording_channels, has_audio, status, canonical, raw)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'ingested',$19::jsonb,$20::jsonb)
     on conflict (provider, external_id) do update set
       integration_id = coalesce(excluded.integration_id, calls.integration_id), agent_id = excluded.agent_id, lead_id = excluded.lead_id,
       started_at = excluded.started_at, duration_s = excluded.duration_s, direction = excluded.direction, end_reason = excluded.end_reason,
       end_reason_raw = excluded.end_reason_raw, language = excluded.language, prompt_version = coalesce(excluded.prompt_version, calls.prompt_version),
       agent_version = excluded.agent_version, recording_url = excluded.recording_url, recording_channels = excluded.recording_channels,
       has_audio = excluded.has_audio, status = 'ingested', canonical = excluded.canonical, raw = excluded.raw, updated_at = now()`,
    [callId, call.provider, call.externalId, opts.integrationId, agentId, call.leadId ?? null, call.startedAt, call.durationS, call.direction, call.endReason, call.endReasonRaw ?? null,
      call.language ?? null, version, call.agentVersion ?? null, opts.source, call.recording?.multiChannelUrl ?? call.recording?.url ?? null, call.recording?.channels ?? null,
      !!call.recording?.available, json(call), opts.keepRaw === false ? null : json(raw)],
  );
  return callId;
}
