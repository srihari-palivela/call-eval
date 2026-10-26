import { describe, expect, it } from 'vitest';
import { cqsOf, normalise, rollUp, scoreCall, bootstrapMedianDiff, cohensKappa, bandName, METRICS, DEFAULT_WEIGHTS } from '../src';

describe('normalise', () => {
  it('maps low-is-better metrics linearly between green and red', () => {
    expect(normalise({ kind: 'low', green: 2.5, red: 4 }, 2)).toBe(100);
    expect(normalise({ kind: 'low', green: 2.5, red: 4 }, 4.2)).toBe(0);
    expect(normalise({ kind: 'low', green: 2.5, red: 4 }, 3.25)).toBeCloseTo(50);
  });
  it('maps high-is-better and two-sided metrics', () => {
    expect(normalise({ kind: 'high', green: 95, red: 80 }, 87.5)).toBeCloseTo(50);
    expect(normalise({ kind: 'two', green: [40, 60], red: [25, 75] }, 50)).toBe(100);
    expect(normalise({ kind: 'two', green: [40, 60], red: [25, 75] }, 67.5)).toBeCloseTo(50);
    expect(normalise({ kind: 'two', green: [40, 60], red: [25, 75] }, 20)).toBe(0);
  });
  it('rescales judge scales and handles pass/fail', () => {
    expect(normalise({ kind: 'judge', min: -2, max: 2 }, 1)).toBe(75);
    expect(normalise({ kind: 'judge', min: 0, max: 2 }, 1.8)).toBeCloseTo(90);
    expect(normalise({ kind: 'pass' }, true)).toBe(100);
    expect(normalise({ kind: 'pass' }, 0)).toBe(0);
    expect(normalise({ kind: 'pass' }, null)).toBeNull();
  });
});

describe('roll-up and CQS', () => {
  it('drops metrics that do not apply instead of scoring them 100', () => {
    const dims = rollUp({ trel: 80, reask: null, cco: 60 });
    expect(dims.und?.v).toBe(70);
    expect(dims.und?.n).toBe(2);
  });
  it('counts Re-ask and Wrong path twice', () => {
    const dims = rollUp({ trel: 100, reask: 40 });
    expect(dims.und?.v).toBe(60); // (100 + 2*40) / 3
  });
  it('re-normalises weights when a dimension is missing and caps gated calls at 40', () => {
    const r = cqsOf({ und: 80, body: 60 }, DEFAULT_WEIGHTS, false);
    expect(r.raw).toBeCloseTo((20 * 80 + 15 * 60) / 35);
    const g = cqsOf({ und: 90, body: 90 }, DEFAULT_WEIGHTS, true);
    expect(g.cqs).toBe(40);
    expect(g.raw).toBe(90);
  });
  it('scores a full call and bands it', () => {
    const values = Object.fromEntries(METRICS.map((m) => [m.key, 90]));
    const s = scoreCall(values, 0);
    expect(s.cqs).toBe(90);
    expect(s.band).toBe('Excellent');
    expect(bandName(69)).toBe('Needs review');
    expect(bandName(49)).toBe('Fail');
  });
});

describe('statistics', () => {
  it('bootstrap interval excludes zero for a clear shift and includes it for noise', () => {
    const a = Array.from({ length: 60 }, (_, i) => 60 + (i % 7));
    const b = a.map((x) => x + 8);
    const r = bootstrapMedianDiff(a, b);
    expect(r.d).toBe(8);
    expect(r.lo).toBeGreaterThan(0);
    const n = bootstrapMedianDiff(a, [...a].reverse());
    expect(n.lo).toBeLessThanOrEqual(0);
    expect(n.hi).toBeGreaterThanOrEqual(0);
  });
  it('computes Cohen’s kappa', () => {
    expect(cohensKappa([['a', 'a'], ['b', 'b'], ['a', 'a'], ['b', 'b']])).toBe(1);
    const k = cohensKappa([['a', 'a'], ['a', 'b'], ['b', 'b'], ['b', 'a']]);
    expect(k).toBeCloseTo(0);
  });
});
