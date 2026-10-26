// Tunable framework settings. The framework calls weights and thresholds "starting values to revisit
// after 200 calls", and leaves the attribution window and budget bands for sales to agree, so they
// live in the database rather than in code.

import { DEFAULT_BUDGET_BANDS, DEFAULT_WEIGHTS, DIM_KEYS, GOOD_LINE, MIN_CELL_CALLS, type SettingsDTO } from '@calleval/framework';
import type { Db } from '../db';

export const DEFAULT_SETTINGS: SettingsDTO = {
  weights: { ...DEFAULT_WEIGHTS },
  attributionDays: 30,
  reservationAttributionDays: 90,
  minCellCalls: MIN_CELL_CALLS,
  reviewSampleRate: 0.1,
  confidenceThreshold: 0.7,
  costPerMinuteAed: null,
  budgetBands: DEFAULT_BUDGET_BANDS,
  retentionDays: null,
  goodLine: GOOD_LINE,
};

let cache: { at: number; value: SettingsDTO } | null = null;

export async function getSettings(db: Db): Promise<SettingsDTO> {
  if (cache && Date.now() - cache.at < 5_000) return cache.value;
  const row = await db.one<{ value: Partial<SettingsDTO> }>("select value from app_setting where key = 'framework'");
  const v = { ...DEFAULT_SETTINGS, ...(row?.value ?? {}) };
  v.weights = { ...DEFAULT_WEIGHTS, ...(row?.value?.weights ?? {}) };
  cache = { at: Date.now(), value: v };
  return v;
}

export async function updateSettings(db: Db, patch: Partial<SettingsDTO>): Promise<SettingsDTO> {
  const cur = await getSettings(db);
  const next: SettingsDTO = { ...cur, ...patch };
  if (patch.weights) {
    next.weights = { ...cur.weights };
    for (const k of DIM_KEYS) {
      const w = (patch.weights as Record<string, number>)[k];
      if (typeof w === 'number' && isFinite(w)) next.weights[k] = Math.max(0, Math.min(100, w));
    }
  }
  next.reviewSampleRate = Math.max(0, Math.min(1, next.reviewSampleRate));
  next.confidenceThreshold = Math.max(0, Math.min(1, next.confidenceThreshold));
  next.minCellCalls = Math.max(1, Math.round(next.minCellCalls));
  await db.query(
    "insert into app_setting (key, value, updated_at) values ('framework', $1::jsonb, now()) on conflict (key) do update set value = excluded.value, updated_at = now()",
    [JSON.stringify(next)],
  );
  cache = null;
  return getSettings(db);
}

export async function getKv<T>(db: Db, key: string): Promise<T | null> {
  const row = await db.one<{ value: T }>('select value from app_setting where key = $1', [key]);
  return row ? row.value : null;
}

export async function setKv(db: Db, key: string, value: unknown) {
  await db.query(
    'insert into app_setting (key, value, updated_at) values ($1, $2::jsonb, now()) on conflict (key) do update set value = excluded.value, updated_at = now()',
    [key, JSON.stringify(value)],
  );
}
