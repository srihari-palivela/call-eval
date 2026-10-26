// Shared slicing for every view: date range, direction, persona path, prompt version, agent.

import type { Db } from '../db';

export type Slice = { range: number; dir: 'all' | 'in' | 'out'; path: string; ver: string; agent: string };

export function parseSlice(q: Record<string, unknown>): Slice {
  const s = (k: string, d: string) => (typeof q[k] === 'string' && q[k] ? String(q[k]) : d);
  const range = Math.max(1, Math.min(3650, Number(s('range', '30')) || 30));
  const dir = s('dir', 'all');
  return { range, dir: dir === 'in' || dir === 'out' ? dir : 'all', path: s('path', 'all'), ver: s('ver', 'live'), agent: s('agent', 'all') };
}

export type VersionInfo = { label: string; firstSeen: Date; lastSeen: Date | null; calls: number };

/** Prompt versions in release order (by first call seen), optionally for one agent. */
export async function versions(db: Db, agent: string): Promise<VersionInfo[]> {
  const rows = await db.query<{ label: string; first_seen: Date; last_seen: Date | null; calls: number }>(
    `select c.prompt_version as label, min(c.started_at) as first_seen, max(c.started_at) as last_seen, count(*)::int as calls
     from calls c where c.prompt_version is not null and c.status = 'scored' ${agent !== 'all' ? 'and c.agent_id = $1' : ''}
     group by c.prompt_version order by min(c.started_at)`,
    agent !== 'all' ? [agent] : [],
  );
  return rows.map((r) => ({ label: r.label, firstSeen: new Date(r.first_seen), lastSeen: r.last_seen ? new Date(r.last_seen) : null, calls: r.calls }));
}

export type ResolvedVersion = {
  label: string | null;
  anchor: Date | null;
  live: boolean;
  /** Across several agents, `live` and `previous` mean each agent's own version (labels are per agent). */
  perAgent?: { agentId: string | null; label: string }[];
};

/** Each agent's live (or previous) prompt version, in release order per agent. */
async function perAgentVersions(db: Db, which: 'live' | 'previous') {
  const rows = await db.query<{ agent_id: string | null; label: string; n: number }>(
    `select agent_id, prompt_version as label, count(*)::int as n from calls where prompt_version is not null and status = 'scored'
     group by agent_id, prompt_version order by agent_id, min(started_at)`,
  );
  const by = new Map<string | null, { labels: string[]; n: number }>();
  for (const r of rows) { const a = by.get(r.agent_id) ?? { labels: [], n: 0 }; a.labels.push(r.label); a.n += r.n; by.set(r.agent_id, a); }
  return Array.from(by, ([agentId, a]) => ({ agentId, n: a.n, label: which === 'live' ? a.labels[a.labels.length - 1] : a.labels[a.labels.length - 2] }))
    .filter((x): x is { agentId: string | null; n: number; label: string } => !!x.label)
    .sort((x, y) => y.n - x.n);
}

export async function resolveVersion(db: Db, ver: string, agent: string): Promise<ResolvedVersion> {
  if (ver === 'all' || !ver) return { label: null, anchor: null, live: true };
  const vs = await versions(db, agent);
  if (agent === 'all' && (ver === 'live' || ver === 'previous')) {
    const pairs = await perAgentVersions(db, ver);
    if (pairs.length > 1) {
      // The label shown in the console is the busiest agent's; the filter uses every agent's own.
      return { label: pairs[0].label, anchor: null, live: ver === 'live', perAgent: pairs.map(({ agentId, label }) => ({ agentId, label })) };
    }
  }
  if (!vs.length) return { label: null, anchor: null, live: true };
  const live = vs[vs.length - 1];
  if (ver === 'live') return { label: live.label, anchor: null, live: true };
  const v = ver === 'previous' ? vs[vs.length - 2] : vs.find((x) => x.label === ver);
  if (!v) return { label: ver === 'previous' ? '__none__' : ver, anchor: null, live: false };
  // A retired version is read over its own last `range` days, so comparisons are like for like.
  return { label: v.label, anchor: v.label === live.label ? null : v.lastSeen, live: v.label === live.label };
}

/** WHERE clause over `calls c` for a slice. Pass `ignore` to drop a filter a view doesn't use. */
export async function sliceWhere(db: Db, f: Slice, ignore: ('ver' | 'dir' | 'path' | 'range')[] = [], startIndex = 1) {
  const conds = ["c.status = 'scored'"];
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${startIndex + params.length - 1}`; };
  let anchor: Date | null = null;
  let label: string | null = null;
  if (!ignore.includes('ver')) {
    const r = await resolveVersion(db, f.ver, f.agent);
    label = r.label; anchor = r.anchor;
    if (r.perAgent) conds.push(versionPairsSql(r.perAgent, p));
    else if (r.label) conds.push(`c.prompt_version = ${p(r.label)}`);
  }
  if (!ignore.includes('range')) {
    const end = anchor ?? new Date();
    conds.push(`c.started_at > ${p(new Date(end.getTime() - f.range * 86_400_000).toISOString())}::timestamptz`);
    if (anchor) conds.push(`c.started_at <= ${p(end.toISOString())}::timestamptz`);
  }
  if (!ignore.includes('dir') && f.dir !== 'all') conds.push(`c.direction = ${p(f.dir === 'in' ? 'inbound' : 'outbound')}`);
  if (!ignore.includes('path') && f.path !== 'all') conds.push(`c.persona_path = ${p(f.path)}`);
  if (f.agent !== 'all') conds.push(`c.agent_id = ${p(f.agent)}`);
  return { sql: conds.join(' and '), params, label };
}

/** SQL matching each agent's own version: (agent a and version x) or (agent b and version y)… */
export function versionPairsSql(pairs: { agentId: string | null; label: string }[], p: (v: unknown) => string) {
  if (!pairs.length) return 'false';
  return `(${pairs.map((x) => `(${x.agentId === null ? 'c.agent_id is null' : `c.agent_id = ${p(x.agentId)}`} and c.prompt_version = ${p(x.label)})`).join(' or ')})`;
}
