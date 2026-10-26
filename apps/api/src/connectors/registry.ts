// Integrations: provider credentials stored encrypted, plus the ones bootstrapped from the
// environment so a deployment can be configured without touching the console.

import type { IntegrationDTO } from '@calleval/framework';
import { config } from '../config';
import { iso, type Db } from '../db';
import { decrypt, encrypt, hint } from '../lib/crypto';
import { newId } from '../lib/ids';
import { elevenlabs } from './elevenlabs';
import { retell } from './retell';
import type { Connector, Credentials } from './types';

export const CONNECTORS: Record<string, Connector> = { elevenlabs, retell };

export type IntegrationRow = {
  id: string; provider: 'elevenlabs' | 'retell' | 'treppan'; name: string; enabled: boolean;
  config: { agentIds?: string[]; baseUrl?: string | null; pollMinutes?: number; toolAliases?: Record<string, string> };
  secrets: string | null; api_key_hint: string | null; cursor: { since?: string; pending?: unknown } | null;
  calls_imported: number; last_sync_at: Date | null; last_sync_status: string | null; last_error: string | null; created_at: Date;
};

export function credentialsOf(row: IntegrationRow): Credentials {
  let s: { apiKey?: string; webhookSecret?: string | null } = {};
  if (row.secrets) { try { s = JSON.parse(decrypt(row.secrets)); } catch { s = {}; } }
  return { apiKey: s.apiKey ?? '', webhookSecret: s.webhookSecret ?? null, baseUrl: row.config?.baseUrl ?? null, agentIds: row.config?.agentIds ?? [] };
}

export async function getIntegration(db: Db, id: string) {
  return db.one<IntegrationRow>('select * from integration where id = $1', [id]);
}

export async function listIntegrations(db: Db) {
  return db.query<IntegrationRow>('select * from integration order by created_at');
}

export function toDTO(row: IntegrationRow): IntegrationDTO {
  const creds = credentialsOf(row);
  const base = config.publicUrl ? config.publicUrl.replace(/\/$/, '') : '';
  return {
    id: row.id, provider: row.provider, name: row.name, enabled: row.enabled,
    agentIds: row.config?.agentIds ?? [], baseUrl: row.config?.baseUrl ?? null, pollMinutes: row.config?.pollMinutes ?? 15,
    hasApiKey: !!creds.apiKey, hasWebhookSecret: !!creds.webhookSecret, apiKeyHint: row.api_key_hint,
    webhookUrl: row.provider === 'treppan' ? '' : `${base}/webhooks/${row.provider}/${row.id}`,
    lastSyncAt: iso(row.last_sync_at), lastSyncStatus: row.last_sync_status, lastError: row.last_error,
    callsImported: row.calls_imported, createdAt: iso(row.created_at)!,
  };
}

export type IntegrationInput = { provider?: 'elevenlabs' | 'retell' | 'treppan'; name?: string; apiKey?: string | null; webhookSecret?: string | null; agentIds?: string[]; baseUrl?: string | null; pollMinutes?: number; enabled?: boolean; toolAliases?: Record<string, string> };

export async function saveIntegration(db: Db, id: string | null, input: IntegrationInput): Promise<IntegrationRow> {
  const cur = id ? await getIntegration(db, id) : null;
  if (id && !cur) throw Object.assign(new Error('Integration not found'), { statusCode: 404 });
  const provider = input.provider ?? cur?.provider;
  if (!provider || !['elevenlabs', 'retell', 'treppan'].includes(provider)) throw Object.assign(new Error('provider must be elevenlabs, retell or treppan'), { statusCode: 400 });
  const prev = cur ? credentialsOf(cur) : { apiKey: '', webhookSecret: null };
  const apiKey = input.apiKey !== undefined && input.apiKey !== null && input.apiKey !== '' ? input.apiKey : prev.apiKey;
  const webhookSecret = input.webhookSecret !== undefined ? input.webhookSecret || null : prev.webhookSecret;
  const cfg = {
    ...(cur?.config ?? {}),
    ...(input.agentIds !== undefined ? { agentIds: input.agentIds.map((a) => a.trim()).filter(Boolean) } : {}),
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl || null } : {}),
    ...(input.pollMinutes !== undefined ? { pollMinutes: Math.max(0, Math.round(input.pollMinutes)) } : {}),
    ...(input.toolAliases !== undefined ? { toolAliases: Object.fromEntries(Object.entries(input.toolAliases ?? {}).filter(([k, v]) => k && typeof v === 'string').map(([k, v]) => [k.trim(), v.trim()])) } : {}),
  };
  const secrets = apiKey || webhookSecret ? encrypt(JSON.stringify({ apiKey, webhookSecret })) : null;
  if (cur) {
    await db.query('update integration set name = $2, enabled = $3, config = $4::jsonb, secrets = $5, api_key_hint = $6, updated_at = now() where id = $1',
      [cur.id, input.name ?? cur.name, input.enabled ?? cur.enabled, JSON.stringify(cfg), secrets, hint(apiKey)]);
    return (await getIntegration(db, cur.id))!;
  }
  const nid = newId('int');
  await db.query('insert into integration (id, provider, name, enabled, config, secrets, api_key_hint) values ($1,$2,$3,$4,$5::jsonb,$6,$7)',
    [nid, provider, input.name ?? (provider === 'elevenlabs' ? 'ElevenLabs' : provider === 'retell' ? 'Retell AI' : 'Treppan CRM'), input.enabled ?? true, JSON.stringify({ pollMinutes: 15, ...cfg }), secrets, hint(apiKey)]);
  return (await getIntegration(db, nid))!;
}

/** Create or refresh integrations defined by environment variables. */
export async function bootstrapFromEnv(db: Db) {
  const b = config.bootstrap;
  const upsert = async (provider: 'elevenlabs' | 'retell' | 'treppan', input: IntegrationInput) => {
    const existing = await db.one<IntegrationRow>("select * from integration where provider = $1 and name like '%(env)'", [provider]);
    await saveIntegration(db, existing?.id ?? null, { provider, name: `${provider === 'elevenlabs' ? 'ElevenLabs' : provider === 'retell' ? 'Retell AI' : 'Treppan CRM'} (env)`, ...input });
  };
  if (b.elevenlabs) await upsert('elevenlabs', { apiKey: b.elevenlabs.apiKey, webhookSecret: b.elevenlabs.webhookSecret, agentIds: b.elevenlabs.agentIds, baseUrl: b.elevenlabs.baseUrl });
  if (b.retell) await upsert('retell', { apiKey: b.retell.apiKey, agentIds: b.retell.agentIds, baseUrl: b.retell.baseUrl });
  if (b.treppan) await upsert('treppan', { apiKey: b.treppan.apiKey, baseUrl: b.treppan.baseUrl, pollMinutes: 1440 });
}
