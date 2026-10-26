// Runtime configuration from the environment. `.env` in the working directory is loaded if present.

import { existsSync } from 'node:fs';
import path from 'node:path';

function loadEnvFile() {
  for (const f of ['.env', '../../.env']) {
    const p = path.resolve(process.cwd(), f);
    if (existsSync(p)) {
      try { process.loadEnvFile(p); } catch { /* malformed .env is ignored; real env still applies */ }
      return;
    }
  }
}
loadEnvFile();

const env = process.env;
const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && isFinite(Number(v)) ? Number(v) : d);
const bool = (v: string | undefined, d: boolean) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()));
const list = (v: string | undefined) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

export const config = {
  port: num(env.PORT, 8787),
  host: env.HOST ?? '0.0.0.0',
  publicUrl: env.PUBLIC_URL ?? null,
  databaseUrl: env.DATABASE_URL ?? null,
  pgliteDir: env.PGLITE_DIR ?? './data/pglite',
  uploadDir: env.UPLOAD_DIR ?? './data/uploads',
  apiToken: env.API_TOKEN ?? null,
  appSecret: env.APP_SECRET ?? null,
  runWorker: bool(env.RUN_WORKER, true),
  workerConcurrency: num(env.WORKER_CONCURRENCY, 2),
  webDist: env.WEB_DIST ?? null,
  demoMode: (env.DEMO_MODE ?? 'on') as 'on' | 'off',
  llm: {
    mode: (env.LLM_JUDGE ?? 'auto') as 'auto' | 'off',
    model: env.CLAUDE_MODEL ?? 'claude-opus-5-5',
    effort: (env.CLAUDE_EFFORT ?? 'medium') as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
    recommendationEffort: (env.CLAUDE_RECOMMENDATION_EFFORT ?? 'high') as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
    /** Server-side refusal fallbacks; set CLAUDE_FALLBACKS=off to disable. */
    fallbacks: bool(env.CLAUDE_FALLBACKS, true),
    maxConcurrent: num(env.CLAUDE_MAX_CONCURRENT, 4),
  },
  audioModelUrl: env.AUDIO_MODEL_URL ?? null,
  /** Integrations bootstrapped from the environment on start (in addition to ones created in the console). */
  bootstrap: {
    elevenlabs: env.ELEVENLABS_API_KEY ? { apiKey: env.ELEVENLABS_API_KEY, webhookSecret: env.ELEVENLABS_WEBHOOK_SECRET ?? null, agentIds: list(env.ELEVENLABS_AGENT_IDS), baseUrl: env.ELEVENLABS_BASE_URL ?? null } : null,
    retell: env.RETELL_API_KEY ? { apiKey: env.RETELL_API_KEY, agentIds: list(env.RETELL_AGENT_IDS), baseUrl: env.RETELL_BASE_URL ?? null } : null,
    treppan: env.TREPPAN_API_URL ? { baseUrl: env.TREPPAN_API_URL, apiKey: env.TREPPAN_API_KEY ?? '' } : null,
  },
  sttApiKey: env.ELEVENLABS_STT_API_KEY ?? env.ELEVENLABS_API_KEY ?? null,
  logLevel: env.LOG_LEVEL ?? 'info',
};

export type Config = typeof config;

export function llmEnabled() {
  if (config.llm.mode === 'off') return false;
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}
