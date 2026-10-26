import type { CanonicalCall } from '@calleval/framework';

export type Credentials = {
  apiKey: string;
  webhookSecret?: string | null;
  baseUrl?: string | null;
  agentIds: string[];
};

export type ListedCall = { externalId: string; startedAt: string | null; complete: boolean };

export type ListPage = { calls: ListedCall[]; cursor: unknown | null; done: boolean };

export type AgentInfo = {
  externalId: string;
  name: string | null;
  prompt: string | null;
  firstMessage: string | null;
  providerVersion: string | null;
  config: unknown;
};

export type FetchedCall = { canonical: CanonicalCall; raw: unknown };

export type WebhookEvent =
  | { kind: 'call'; externalId: string; event: string; raw: unknown | null }
  | { kind: 'ignore'; reason: string };

export interface Connector {
  provider: 'elevenlabs' | 'retell';
  /** One page of calls started after `since`, oldest first where the provider allows. */
  listCalls(creds: Credentials, opts: { since: Date | null; cursor: unknown | null; agentId: string | null }): Promise<ListPage>;
  fetchCall(creds: Credentials, externalId: string): Promise<FetchedCall>;
  /** Map a raw provider payload (from the API or a webhook) to the canonical record. */
  normalise(raw: unknown): CanonicalCall;
  fetchAgent(creds: Credentials, agentId: string, version?: string | null): Promise<AgentInfo | null>;
  listAgents(creds: Credentials): Promise<{ id: string; name: string }[]>;
  fetchAudio(creds: Credentials, call: CanonicalCall): Promise<Response | null>;
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>, creds: Credentials): Promise<boolean>;
  parseWebhook(body: any): WebhookEvent;
}

export const header = (h: Record<string, string | string[] | undefined>, name: string) => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

/** Words per second used to estimate an utterance's end when the provider only gives its start. */
export const SPEECH_WPS = { agent: 2.6, caller: 2.4 };

export function estimateEnd(start: number, text: string, speaker: 'agent' | 'caller', nextStart?: number) {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const est = start + Math.max(0.6, words / SPEECH_WPS[speaker]);
  return nextStart !== undefined && nextStart > start ? Math.min(est, nextStart - 0.05) : est;
}

/** Delivery tags such as [confidently] written into the agent text by the LLM. */
export function extractTags(text: string): string[] {
  return Array.from(text.matchAll(/\[([a-z][a-z _-]{1,30})\]/gi)).map((m) => m[1].toLowerCase());
}
