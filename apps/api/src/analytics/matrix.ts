// Technical view: the persona × scenario quality matrix, a cell's detail, and the fix-first map.

import {
  DIMS, PATHS, PERSONAS, personaById, scenarioById, type CellDTO, type CellDetailDTO, type DimKey, type FixCellDTO, type FixDTO, type MatrixDTO,
} from '@calleval/framework';
import type { Db } from '../db';
import { getSettings } from '../lib/settings';
import { listCalls } from './calls';
import { parseSlice, sliceWhere, type Slice } from './filters';

const DIM_COLS = DIMS.map((d) => `percentile_cont(0.5) within group (order by s.${d.key}) as ${d.key}`).join(', ');

export async function cells(db: Db, f: Slice, opts: { ignoreVer?: boolean } = {}): Promise<{ cells: CellDTO[]; label: string | null }> {
  const w = await sliceWhere(db, f, opts.ignoreVer ? ['ver'] : []);
  const rows = await db.query(
    `with credited as (
       select o.credited_call_id as call_id, sum(case when o.stage in ('reservation','sale') then coalesce(o.value_aed, 0) else 0 end) as value
       from lead_outcome o where o.credited_call_id is not null group by o.credited_call_id)
     select c.persona as pid, c.scenario as sid, count(*)::int as n,
       percentile_cont(0.5) within group (order by c.cqs) as cqs,
       avg(case when c.gated then 1.0 else 0.0 end) * 100 as gate,
       avg(case when c.next_step = 'meeting' then 1.0 else 0.0 end) * 100 as meet,
       avg(case when c.next_step is not null then 1.0 else 0.0 end) * 100 as ns,
       coalesce(sum(cr.value), 0) / count(*) / 1000.0 as res,
       ${DIM_COLS}
     from calls c join call_score s on s.call_id = c.call_id
     left join credited cr on cr.call_id = c.call_id
     where ${w.sql} and c.persona is not null and c.scenario is not null
     group by c.persona, c.scenario`,
    w.params,
  );
  const out: CellDTO[] = rows.map((r) => {
    const cqs = Math.round(Number(r.cqs));
    const dims = {} as Record<DimKey, number>;
    // A dimension with no applicable metric in any of the cell's calls reads as the cell's CQS.
    for (const d of DIMS) dims[d.key] = r[d.key] === null || r[d.key] === undefined ? cqs : Math.round(Number(r[d.key]));
    return { pid: r.pid, sid: r.sid, n: r.n, cqs, gate: +Number(r.gate).toFixed(1), dims, meet: +Number(r.meet).toFixed(1), res: +Number(r.res).toFixed(1), ns: +Number(r.ns).toFixed(1) };
  });
  return { cells: out, label: w.label };
}

export async function matrix(db: Db, q: Record<string, unknown>): Promise<MatrixDTO> {
  const f = parseSlice(q);
  const r = await cells(db, f);
  return { ver: r.label, cells: r.cells, calls: r.cells.reduce((a, c) => a + c.n, 0) };
}

export async function cellDetail(db: Db, pid: string, sid: string, q: Record<string, unknown>): Promise<CellDetailDTO | null> {
  const f = parseSlice(q);
  const all = await cells(db, f);
  const cell = all.cells.find((c) => c.pid === pid && c.sid === sid);
  if (!cell) return null;
  const w = await sliceWhere(db, f, [], 3);
  const rows = await db.query<{ path: any; tool_stats: any; call_id: string }>(
    `select s.path, s.tool_stats, c.call_id from calls c join call_score s on s.call_id = c.call_id where c.persona = $1 and c.scenario = $2 and ${w.sql}`,
    [pid, sid, ...w.params],
  );

  // Path adherence: share of calls reaching each checkpoint in order.
  const cps = PATHS[sid] ?? [];
  const reach = cps.map(() => 0);
  for (const r of rows) {
    const steps: { hit: boolean; turn: number | null }[] = r.path?.steps ?? [];
    let last = -1;
    for (let k = 0; k < cps.length; k++) {
      const s = steps[k];
      if (!s?.hit || (s.turn !== null && s.turn < last)) break;
      if (s.turn !== null) last = s.turn;
      reach[k]++;
    }
  }
  const n = Math.max(1, rows.length);
  let maxDrop = -1, exit = -1, prev = 100;
  const path = cps.map((c, k) => {
    const pct = Math.round((reach[k] / n) * 100);
    if (prev - pct > maxDrop) { maxDrop = prev - pct; exit = k; }
    prev = pct;
    return { label: c.label, pct, exit: false };
  });
  if (exit >= 0 && cps.length > 1) path[exit].exit = true;

  // Tool health for the tools this cell's calls used or needed.
  const agg = new Map<string, { made: number; correct: number; expected: number; met: number; fc: number; fo: number }>();
  for (const r of rows) for (const t of (r.tool_stats ?? []) as any[]) {
    if (t.name === 'end_call') continue;
    const a = agg.get(t.name) ?? { made: 0, correct: 0, expected: 0, met: 0, fc: 0, fo: 0 };
    a.made += t.made; a.correct += t.correct; a.expected += t.expected; a.met += t.met; a.fc += t.fidelityChecked; a.fo += t.fidelityOk;
    agg.set(t.name, a);
  }
  const tools = Array.from(agg, ([name, a]) => ({
    name, n: a.made,
    p: a.made ? Math.round((a.correct / a.made) * 100) : null,
    r: a.expected ? Math.round((a.met / a.expected) * 100) : null,
    f: a.fc ? Math.round((a.fo / a.fc) * 100) : null,
  })).sort((x, y) => y.n - x.n).slice(0, 6);

  const personaCheck = await personaCheckFor(db, pid, sid, w.sql, w.params);
  const calls = await listCalls(db, { ...q, persona: pid, scenario: sid, sort: 'worst', limit: '6' });
  return { cell, path, tools, personaCheck, calls: calls.items };
}

/** The persona's "watch for" check, measured from the metrics that capture it. */
async function personaCheckFor(db: Db, pid: string, sid: string, where: string, params: unknown[]): Promise<{ label: string; value: string } | null> {
  const p = personaById(pid);
  if (!p.checkLabel) return null;
  const base = `from calls c join metric_result m on m.call_id = c.call_id where c.persona = $1 and c.scenario = $2 and ${where}`;
  const avg = async (key: string, expr = 'avg(m.value)') => (await db.one<{ v: number | null }>(`select ${expr} as v ${base} and m.metric_key = '${key}' and m.applicable`, [pid, sid, ...params]))?.v ?? null;
  const pct = (v: number | null) => (v === null ? '—' : `${Math.round(Number(v))}%`);
  switch (pid) {
    case 'P1': return { label: p.checkLabel, value: pct(await avg('nf')) };
    case 'P2': return { label: p.checkLabel, value: pct(await avg('rga', 'avg(m.raw)')) };
    case 'P3': return { label: p.checkLabel, value: pct(await avg('sc')) };
    case 'P6': return { label: p.checkLabel, value: pct(await avg('cfc', 'avg(100 - m.value)')) };
    case 'P7': { const v = await avg('bpp', 'avg(m.raw)'); return { label: p.checkLabel, value: v === null ? '—' : Number(v).toFixed(1) }; }
    case 'P8': return { label: p.checkLabel, value: pct(await avg('pr')) };
    case 'P4': case 'P5': {
      const rx = pid === 'P4' ? '%UAE time%' : '%handover%';
      const r = await db.one<{ v: number | null }>(`select avg(case when c.canonical::text ilike $3 then 100.0 else 0 end) as v from calls c where c.persona = $1 and c.scenario = $2 and ${where.replace(/\$(\d+)/g, (_, d) => `$${Number(d) + 1}`)}${pid === 'P4' ? " and c.next_step = 'meeting'" : ''}`, [pid, sid, rx, ...params]);
      return { label: p.checkLabel, value: pct(r?.v ?? null) };
    }
    case 'P9': case 'P10': {
      const r = await db.one<{ v: number | null }>(`select avg(case when s.phases::text like '%"Pitch"%' then 100.0 else 0 end) as v from calls c join call_score s on s.call_id = c.call_id where c.persona = $1 and c.scenario = $2 and ${where}`, [pid, sid, ...params]);
      return { label: p.checkLabel, value: pct(r?.v ?? null) };
    }
    case 'P11': {
      const r = await db.one<{ v: number | null }>(`select avg(case when c.duration_s <= 60 then 100.0 else 0 end) as v from calls c where c.persona = $1 and c.scenario = $2 and ${where}`, [pid, sid, ...params]);
      return { label: p.checkLabel, value: pct(r?.v ?? null) };
    }
  }
  return null;
}

/** Where to fix first: every cell with enough calls, by median CQS (split at the Good line) and value per call (split at the median). */
export async function fixMap(db: Db, q: Record<string, unknown>): Promise<FixDTO> {
  const f = parseSlice(q);
  const vm = q.vm === 'res' ? 'res' : 'meet';
  const settings = await getSettings(db);
  const { cells: all } = await cells(db, f);
  const list: FixCellDTO[] = all.filter((c) => c.n >= settings.minCellCalls && (personaById(c.pid).path === 'Investor' || personaById(c.pid).path === 'Broker') && scenarioById(c.sid))
    .map((c) => ({ ...c, key: `${c.pid}|${c.sid}`, val: vm === 'res' ? c.res : c.meet, quad: 'maintain', depth: 0, weak: { key: DIMS[0].key, name: DIMS[0].name } }));
  const vals = list.map((c) => c.val).sort((a, b) => a - b);
  const med = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
  const vmax = vals.length ? vals[vals.length - 1] : 1;
  for (const c of list) {
    const hi = c.val >= med, good = c.cqs >= settings.goodLine;
    c.quad = hi ? (good ? 'protect' : 'fix') : good ? 'maintain' : 'review';
    c.depth = (settings.goodLine - c.cqs) / 20 + (c.val - med) / ((vmax - med) || 1);
    let low = DIMS[0];
    for (const d of DIMS) if (c.dims[d.key] < c.dims[low.key]) low = d;
    c.weak = { key: low.key, name: low.name };
  }
  const top5 = list.filter((c) => c.quad === 'fix').sort((a, b) => b.depth - a.depth).slice(0, 5);
  void PERSONAS;
  return { cells: list, med, vmax, top5, vm };
}
