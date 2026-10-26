// Traces: where response latency goes per day, tool span health, agent spans by prompt version,
// evaluator runs, and the slowest turns, all joined to calls by conversation id.

import { quantile, type TracesDTO } from '@calleval/framework';
import type { Db } from '../db';
import { parseSlice, sliceWhere, versions } from './filters';

type TurnLat = { call: string; ext: string; turn: number; day: string; eot: number; llm: number; tool: number; tts: number; total: number; ver: string | null };

export async function traces(db: Db, q: Record<string, unknown>): Promise<TracesDTO> {
  const f = parseSlice(q);
  const w = await sliceWhere(db, f, ['ver', 'dir', 'path']);
  const spanRows = await db.query<{ call_id: string; external_id: string; turn: number; kind: string; d: number; day: string; ver: string | null }>(
    `select t.call_id, c.external_id, t.turn, t.kind, t.duration_s as d, to_char(c.started_at at time zone 'UTC', 'YYYY-MM-DD') as day, c.prompt_version as ver
     from trace_span t join calls c on c.call_id = t.call_id
     where ${w.sql} and t.kind in ('eot','llm','tool','tts') and t.turn is not null`,
    w.params,
  );
  const byTurn = new Map<string, TurnLat>();
  for (const r of spanRows) {
    const k = `${r.call_id}#${r.turn}`;
    const t = byTurn.get(k) ?? { call: r.call_id, ext: r.external_id, turn: r.turn, day: r.day, eot: 0, llm: 0, tool: 0, tts: 0, total: 0, ver: r.ver };
    const d = Number(r.d) || 0;
    t[r.kind as 'eot' | 'llm' | 'tool' | 'tts'] += d; t.total += d;
    byTurn.set(k, t);
  }
  const turns = Array.from(byTurn.values());

  // Each day's slowest 10% of agent turns, split by where the time went.
  const nDays = Math.min(f.range, 14);
  const today = new Date();
  const days: TracesDTO['days'] = [];
  for (let i = nDays - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    const list = turns.filter((t) => t.day === key);
    if (!list.length) { days.push({ day: String(d.getUTCDate()), date: key, total: 0, eot: 0, llm: 0, tool: 0, tts: 0, n: 0 }); continue; }
    const p90 = quantile(list.map((t) => t.total), 0.9);
    const slow = list.filter((t) => t.total >= p90);
    const avg = (k: 'eot' | 'llm' | 'tool' | 'tts') => +(slow.reduce((a, t) => a + t[k], 0) / slow.length).toFixed(2);
    const parts = { eot: avg('eot'), llm: avg('llm'), tool: avg('tool'), tts: avg('tts') };
    days.push({ day: String(d.getUTCDate()), date: key, total: +(parts.eot + parts.llm + parts.tool + parts.tts).toFixed(2), ...parts, n: list.length });
  }

  const cov = await db.one<{ calls: number; with_timing: number; turns: number; linked: number; judged: number }>(
    `select count(*)::int as calls,
       count(*) filter (where exists (select 1 from trace_span t where t.call_id = c.call_id and t.kind in ('llm','tool','eot','tts')))::int as with_timing,
       coalesce(sum((select count(*) from jsonb_array_elements(c.canonical->'turns') x where x->>'speaker' = 'agent')), 0)::int as turns,
       (select count(*) from metric_result m join calls c2 on c2.call_id = m.call_id where m.applicable and m.method like '%judge%' and m.run_id is not null and c2.call_id in (select c3.call_id from calls c3 where ${w.sql.replace(/c\./g, 'c3.')}))::int as linked,
       (select count(*) from metric_result m join calls c2 on c2.call_id = m.call_id where m.applicable and m.method like '%judge%' and c2.call_id in (select c3.call_id from calls c3 where ${w.sql.replace(/c\./g, 'c3.')}))::int as judged
     from calls c where ${w.sql}`,
    w.params,
  );

  const tools = await db.query<{ name: string; n: number; p50: number | null; p90: number | null; errs: number }>(
    `select t.name, count(*)::int as n, percentile_cont(0.5) within group (order by t.duration_s) as p50, percentile_cont(0.9) within group (order by t.duration_s) as p90,
       count(*) filter (where t.status = 'error')::int as errs
     from trace_span t join calls c on c.call_id = t.call_id where ${w.sql} and t.kind = 'tool_call' group by t.name order by count(*) desc`,
    w.params,
  );
  const topErr = await db.query<{ name: string; msg: string; n: number }>(
    `select t.name, left(coalesce(t.meta->>'result', ''), 90) as msg, count(*)::int as n
     from trace_span t join calls c on c.call_id = t.call_id where ${w.sql} and t.kind = 'tool_call' and t.status = 'error'
     group by t.name, left(coalesce(t.meta->>'result', ''), 90) order by count(*) desc`,
    w.params,
  );

  // Agent spans by prompt version: the two most recent versions.
  const vs = await versions(db, f.agent);
  const a = vs[vs.length - 2]?.label ?? null, b = vs[vs.length - 1]?.label ?? null;
  const verStats = async (label: string | null) => {
    if (!label) return null;
    const tl = turns.filter((t) => t.ver === label);
    const r = await db.one<{ calls: number; tools: number; agent_turns: number }>(
      `select count(*)::int as calls, coalesce(sum(jsonb_array_length(coalesce(c.canonical->'toolCalls','[]'::jsonb))), 0)::int as tools,
         coalesce(sum((select count(*) from jsonb_array_elements(c.canonical->'turns') x where x->>'speaker' = 'agent')), 0)::int as agent_turns
       from calls c where ${w.sql} and c.prompt_version = $${w.params.length + 1}`,
      [...w.params, label],
    );
    const tot = tl.map((t) => t.total), llm = tl.map((t) => t.llm);
    return {
      p50: tot.length ? quantile(tot, 0.5) : null, p90: tot.length ? quantile(tot, 0.9) : null, llm50: llm.length ? quantile(llm, 0.5) : null,
      tool: tl.length ? tl.reduce((s, t) => s + t.tool, 0) / tl.length : null,
      turnsPerCall: r && r.calls ? r.agent_turns / r.calls : null, toolsPerCall: r && r.calls ? r.tools / r.calls : null,
    };
  };
  const sa = await verStats(a), sb = await verStats(b);
  const fmtS = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v.toFixed(2)} s`);
  const fmtN = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toFixed(1));
  const worse = (x: number | null | undefined, y: number | null | undefined) => x !== null && x !== undefined && y !== null && y !== undefined && y > x * 1.05;
  const llmSpans: TracesDTO['llmSpans'] = [
    { measure: 'Response latency · p50', a: fmtS(sa?.p50), b: fmtS(sb?.p50), flag: worse(sa?.p50, sb?.p50) },
    { measure: 'Response latency · p90', a: fmtS(sa?.p90), b: fmtS(sb?.p90), flag: worse(sa?.p90, sb?.p90) },
    { measure: 'Agent response span · p50', a: fmtS(sa?.llm50), b: fmtS(sb?.llm50), flag: worse(sa?.llm50, sb?.llm50) },
    { measure: 'Tool wait per turn (mean)', a: fmtS(sa?.tool), b: fmtS(sb?.tool), flag: worse(sa?.tool, sb?.tool) },
    { measure: 'Agent turns per call', a: fmtN(sa?.turnsPerCall), b: fmtN(sb?.turnsPerCall), flag: false },
    { measure: 'Tool calls per call', a: fmtN(sa?.toolsPerCall), b: fmtN(sb?.toolsPerCall), flag: false },
  ];

  const runs = await db.query<{ kind: string; model: string | null; n: number; errs: number; p50: number | null; tin: number | null; tout: number | null }>(
    `select r.kind, max(r.model) as model, count(*)::int as n, count(*) filter (where r.status <> 'ok')::int as errs,
       percentile_cont(0.5) within group (order by r.latency_ms) as p50, avg(r.input_tokens) as tin, avg(r.output_tokens) as tout
     from eval_run r join calls c on c.call_id = r.call_id where ${w.sql} group by r.kind order by count(*) desc`,
    w.params,
  );
  const RUN_NAME: Record<string, string> = { judge: 'LLM judge', classifier: 'Classifier', judge_heuristic: 'Heuristic judge', classifier_heuristic: 'Heuristic classifier', audio: 'Audio models' };
  const evalRuns: TracesDTO['evalRuns'] = runs.map((r) => {
    const err = r.n ? (r.errs / r.n) * 100 : 0;
    const meta = r.kind.endsWith('heuristic')
      ? 'Phrase patterns and the tool log · used when no Claude API key is configured'
      : `${r.model ?? ''} · p50 ${((Number(r.p50) || 0) / 1000).toFixed(1)} s · ${Math.round(Number(r.tin) || 0).toLocaleString('en-US')} in / ${Math.round(Number(r.tout) || 0).toLocaleString('en-US')} out tokens a run`;
    return { name: RUN_NAME[r.kind] ?? r.kind, meta, runs: `${r.n.toLocaleString('en-US')} runs`, err: `${err.toFixed(1)}% errors`, bad: err > 1 };
  });

  const slowTurns = [...turns].sort((x, y) => y.total - x.total).slice(0, 5).map((t) => ({
    callId: t.call, turn: t.turn, lat: +t.total.toFixed(1),
    why: t.tool > t.total * 0.5 ? `Waited ${t.tool.toFixed(1)} s on a tool with no filler line` : t.llm > 0 && t.eot + t.tts > 0 ? `LLM ${t.llm.toFixed(1)} s, end-of-turn ${t.eot.toFixed(1)} s, TTS ${t.tts.toFixed(1)} s` : `Agent took ${t.total.toFixed(1)} s to respond`,
  }));

  const first = days.find((d) => d.n)?.date, last = days[days.length - 1]?.date;
  return {
    window: first ? `${first} – ${last}` : 'No traced calls in this window',
    days,
    coverage: { calls: cov?.calls ?? 0, withTiming: cov?.with_timing ?? 0, turns: cov?.turns ?? 0, turnsWithLatency: turns.length, metricsLinked: cov?.judged ? Math.round(((cov.linked ?? 0) / cov.judged) * 100) : 100, orphan: 0 },
    toolSpans: tools.map((t) => ({ name: t.name, n: t.n, p50: t.p50 === null ? null : +Number(t.p50).toFixed(2), p90: t.p90 === null ? null : +Number(t.p90).toFixed(2), errPct: t.n ? +((t.errs / t.n) * 100).toFixed(1) : 0, topError: topErr.find((e) => e.name === t.name)?.msg || null })),
    llmSpans,
    versions: { a, b },
    evalRuns,
    slowTurns,
  };
}
