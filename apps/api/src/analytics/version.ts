// Version report: per-cell change between two prompt versions with a 95% bootstrap interval. A change
// counts only when the interval excludes zero and both sides have enough calls.

import { DIM_KEYS, bootstrapMedianDiff, median, type VersionCellDTO, type VersionReportDTO } from '@calleval/framework';
import type { Db } from '../db';
import { getSettings } from '../lib/settings';
import { versions } from './filters';
import { fixMap } from './matrix';

const fmtDay = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const windowOf = (a: Date, b: Date | null) => `${fmtDay(a)} – ${fmtDay(b ?? new Date())} ${(b ?? new Date()).getUTCFullYear()}`;

export async function versionReport(db: Db, q: Record<string, unknown>): Promise<VersionReportDTO> {
  let agent = typeof q.agent === 'string' && q.agent ? q.agent : 'all';
  // Version labels are per agent, so with several agents the report compares the busiest agent's
  // releases unless one is chosen.
  if (agent === 'all') {
    const agents = await db.query<{ agent_id: string }>("select agent_id from calls where status = 'scored' and prompt_version is not null and agent_id is not null group by agent_id order by count(*) desc");
    if (agents.length > 1) agent = agents[0].agent_id;
  }
  const vs = await versions(db, agent);
  const to = (typeof q.to === 'string' && q.to) || vs[vs.length - 1]?.label || null;
  const from = (typeof q.from === 'string' && q.from) || vs[vs.length - 2]?.label || null;
  const measure = q.measure === 'ns' ? 'ns' : 'cqs';
  const score = typeof q.score === 'string' && (q.score === 'cqs' || (DIM_KEYS as string[]).includes(q.score)) ? q.score : 'cqs';
  const settings = await getSettings(db);
  const fromV = vs.find((v) => v.label === from), toV = vs.find((v) => v.label === to);
  if (!from || !to || !fromV || !toV) return { from, to, fromWindow: fromV ? windowOf(fromV.firstSeen, fromV.lastSeen) : null, toWindow: toV ? windowOf(toV.firstSeen, toV.lastSeen) : null, cells: [], fixKeys: [] };

  const col = score === 'cqs' ? 'c.cqs' : `s.${score}`;
  const rows = await db.query<{ v: string; pid: string; sid: string; x: number | null; ns: boolean }>(
    `select c.prompt_version as v, c.persona as pid, c.scenario as sid, ${col} as x, (c.next_step is not null) as ns
     from calls c join call_score s on s.call_id = c.call_id
     where c.status = 'scored' and c.prompt_version in ($1, $2) and c.persona is not null and c.scenario is not null ${agent !== 'all' ? 'and c.agent_id = $3' : ''}`,
    agent !== 'all' ? [from, to, agent] : [from, to],
  );
  const groups = new Map<string, { a: number[]; b: number[] }>();
  for (const r of rows) {
    const k = `${r.pid}|${r.sid}`;
    const g = groups.get(k) ?? { a: [], b: [] };
    const val = measure === 'ns' ? (r.ns ? 100 : 0) : r.x === null ? null : Number(r.x);
    if (val !== null) (r.v === from ? g.a : g.b).push(val);
    groups.set(k, g);
  }
  const min = settings.minCellCalls;
  const cells: VersionCellDTO[] = [];
  let seed = 11;
  for (const [key, g] of groups) {
    if (!g.a.length || !g.b.length) continue;
    const [pid, sid] = key.split('|');
    let old: number, nw: number, lo: number, hi: number;
    if (measure === 'ns') {
      const p2 = g.a.reduce((s, x) => s + x, 0) / g.a.length / 100, p3 = g.b.reduce((s, x) => s + x, 0) / g.b.length / 100;
      old = Math.round(p2 * 100); nw = Math.round(p3 * 100);
      const pm = (p2 + p3) / 2;
      const half = 1.96 * Math.sqrt(Math.max(pm * (1 - pm), 0.0001) * (1 / g.a.length + 1 / g.b.length)) * 100;
      lo = (p3 - p2) * 100 - half; hi = (p3 - p2) * 100 + half;
    } else {
      old = Math.round(median(g.a)); nw = Math.round(median(g.b));
      const r = bootstrapMedianDiff(g.a, g.b, 600, seed++);
      lo = r.lo; hi = r.hi;
    }
    const d = nw - old;
    const enough = g.a.length >= min && g.b.length >= min;
    const verdict: VersionCellDTO['verdict'] = !enough ? 'few' : lo > 0 ? 'up' : hi < 0 ? 'down' : 'flat';
    cells.push({ pid, sid, n2: g.a.length, n3: g.b.length, old, nw, d, lo: +lo.toFixed(1), hi: +hi.toFixed(1), verdict, key });
  }
  const fix = await fixMap(db, { range: '90', agent });
  return { from, to, fromWindow: windowOf(fromV.firstSeen, fromV.lastSeen), toWindow: windowOf(toV.firstSeen, toV.lastSeen), cells, fixKeys: fix.top5.map((c) => c.key) };
}
