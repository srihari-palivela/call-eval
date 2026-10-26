// Scoring maths: normalise each metric, drop what doesn't apply, average into dimensions,
// weight the dimensions, apply the gates. CQS = min(Σ w·S ÷ Σ w, G), G = 40 if any gate failed.

import { DEFAULT_WEIGHTS, DIMS, DimKey, METRICS, Metric, Norm } from './metrics';

export const GATE_CAP = 40;
export const GOOD_LINE = 70;
export const MIN_CELL_CALLS = 30;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Normalise a raw measurement into 0–100. Returns null for a missing raw value. */
export function normalise(norm: Norm, raw: number | boolean | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const v = typeof raw === 'boolean' ? (raw ? 1 : 0) : raw;
  if (!isFinite(v)) return null;
  switch (norm.kind) {
    case 'pass':
      return v >= 1 ? 100 : 0;
    case 'low':
      if (v <= norm.green) return 100;
      if (v >= norm.red) return 0;
      return ((norm.red - v) / (norm.red - norm.green)) * 100;
    case 'high':
      if (v >= norm.green) return 100;
      if (v <= norm.red) return 0;
      return ((v - norm.red) / (norm.green - norm.red)) * 100;
    case 'two': {
      const [g0, g1] = norm.green, [r0, r1] = norm.red;
      if (v >= g0 && v <= g1) return 100;
      if (v < g0) return v <= r0 ? 0 : ((v - r0) / (g0 - r0)) * 100;
      return v >= r1 ? 0 : ((r1 - v) / (r1 - g1)) * 100;
    }
    case 'judge':
      return clamp(((v - norm.min) / (norm.max - norm.min)) * 100, 0, 100);
  }
}

export function normaliseMetric(m: Metric, raw: number | boolean | null | undefined) {
  const out = normalise(m.norm, raw);
  return out === null ? null : Math.round(out);
}

export function normRule(norm: Norm): string {
  switch (norm.kind) {
    case 'pass': return 'Pass = 100 · fail = 0';
    case 'low': return `≤ ${norm.green} · > ${norm.red}`;
    case 'high': return `≥ ${norm.green} · < ${norm.red}`;
    case 'two': return `${norm.green[0]}–${norm.green[1]} · < ${norm.red[0]} or > ${norm.red[1]}`;
    case 'judge': return `Scale ${norm.min} to ${norm.max}`;
  }
}

export type DimScore = { v: number; n: number };
export type DimScores = Partial<Record<DimKey, DimScore>>;

/** Roll metric scores (null = no opportunity in the call) into dimension scores; weighted metrics count more. */
export function rollUp(values: Record<string, number | null | undefined>): DimScores {
  const acc: Partial<Record<DimKey, { s: number; w: number; n: number }>> = {};
  for (const m of METRICS) {
    const v = values[m.key];
    if (v === null || v === undefined) continue;
    const w = m.weight ?? 1;
    const a = (acc[m.dim] ??= { s: 0, w: 0, n: 0 });
    a.s += v * w; a.w += w; a.n += 1;
  }
  const dims: DimScores = {};
  for (const [k, a] of Object.entries(acc)) if (a && a.w > 0) dims[k as DimKey] = { v: a.s / a.w, n: a.n };
  return dims;
}

/** Same roll-up for an index-aligned score array in METRICS order (the console's scoring model uses this). */
export function rollUpArray(scores: (number | null)[]): DimScores {
  const values: Record<string, number | null> = {};
  METRICS.forEach((m, i) => { values[m.key] = scores[i] ?? null; });
  return rollUp(values);
}

export type CqsResult = { raw: number; num: number; den: number; exact: number; cqs: number; gated: boolean };

/** CQS = min(Σ w·S ÷ Σ w, G); weights re-normalise over the dimensions present in the call. */
export function cqsOf(dims: Partial<Record<DimKey, number>>, weights: Record<DimKey, number> = DEFAULT_WEIGHTS, gated = false): CqsResult {
  let num = 0, den = 0;
  for (const d of DIMS) {
    const v = dims[d.key], w = weights[d.key] ?? 0;
    if (v !== undefined && v !== null && w > 0) { num += w * v; den += w; }
  }
  const raw = den ? num / den : 0;
  const exact = gated ? Math.min(raw, GATE_CAP) : raw;
  return { raw, num, den, exact, cqs: Math.round(exact), gated };
}

export type BandName = 'Excellent' | 'Good' | 'Needs review' | 'Fail';
export const BANDS: { name: BandName; min: number; action: string }[] = [
  { name: 'Excellent', min: 85, action: 'Use as a reference call.' },
  { name: 'Good', min: 70, action: 'No action.' },
  { name: 'Needs review', min: 50, action: 'Sample for coaching or a prompt fix.' },
  { name: 'Fail', min: 0, action: 'Review every call; every gated call lands here.' },
];
export function bandName(v: number): BandName {
  return (BANDS.find((b) => v >= b.min) ?? BANDS[BANDS.length - 1]).name;
}
export function bandAction(v: number): string {
  return (BANDS.find((b) => v >= b.min) ?? BANDS[BANDS.length - 1]).action;
}

/** Full scoring for one call from its metric values and gate flags. */
export function scoreCall(values: Record<string, number | null | undefined>, gatesFailed: number, weights: Record<DimKey, number> = DEFAULT_WEIGHTS) {
  const roll = rollUp(values);
  const dims = Object.fromEntries(Object.entries(roll).map(([k, v]) => [k, v!.v])) as Partial<Record<DimKey, number>>;
  const r = cqsOf(dims, weights, gatesFailed > 0);
  return { roll, dims, ...r, band: bandName(r.cqs) };
}

// ---------- Small statistics helpers shared by the API and the console ----------

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Deterministic PRNG so bootstrap intervals are reproducible between requests. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 95% bootstrap interval for the difference of medians (b − a). */
export function bootstrapMedianDiff(a: number[], b: number[], iters = 1000, seed = 7, stat: (xs: number[]) => number = median) {
  const d = stat(b) - stat(a);
  if (!a.length || !b.length) return { d, lo: NaN, hi: NaN };
  const rnd = mulberry32(seed);
  const diffs: number[] = [];
  const pick = (xs: number[]) => { const out = new Array(xs.length); for (let i = 0; i < xs.length; i++) out[i] = xs[Math.floor(rnd() * xs.length)]; return out; };
  for (let i = 0; i < iters; i++) diffs.push(stat(pick(b)) - stat(pick(a)));
  return { d, lo: quantile(diffs, 0.025), hi: quantile(diffs, 0.975) };
}

/** Cohen's kappa for two raters over categorical labels. */
export function cohensKappa(pairs: [string, string][]): number | null {
  if (!pairs.length) return null;
  const cats = Array.from(new Set(pairs.flat()));
  const n = pairs.length;
  let agree = 0;
  const ca: Record<string, number> = {}, cb: Record<string, number> = {};
  for (const [x, y] of pairs) {
    if (x === y) agree++;
    ca[x] = (ca[x] ?? 0) + 1; cb[y] = (cb[y] ?? 0) + 1;
  }
  const po = agree / n;
  const pe = cats.reduce((s, c) => s + ((ca[c] ?? 0) / n) * ((cb[c] ?? 0) / n), 0);
  if (pe === 1) return po === 1 ? 1 : 0;
  return (po - pe) / (1 - pe);
}
