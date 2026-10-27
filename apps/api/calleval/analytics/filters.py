# Shared slicing for every view: date range, direction, persona path, prompt version, agent.

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from ..js import at, iso, now_ms, num_or

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


def ms_of(d: datetime) -> int:
    """A timestamp as JavaScript Date milliseconds (sub-millisecond digits truncated)."""
    return (d.astimezone(UTC) - _EPOCH) // timedelta(milliseconds=1)


def parse_slice(q: dict[str, Any]) -> dict[str, Any]:
    def s(k: str, d: str) -> str:
        v = q.get(k)
        return str(v) if isinstance(v, str) and v else d
    range_ = max(1, min(3650, num_or(s('range', '30'), 30)))
    dir_ = s('dir', 'all')
    return {'range': range_, 'dir': dir_ if dir_ in ('in', 'out') else 'all', 'path': s('path', 'all'), 'ver': s('ver', 'live'), 'agent': s('agent', 'all')}


async def versions(db, agent: str) -> list[dict]:
    """Prompt versions in release order (by first call seen), optionally for one agent."""
    rows = await db.query(
        f"""select c.prompt_version as label, min(c.started_at) as first_seen, max(c.started_at) as last_seen, count(*)::int as calls
     from calls c where c.prompt_version is not null and c.status = 'scored' {'and c.agent_id = $1' if agent != 'all' else ''}
     group by c.prompt_version order by min(c.started_at)""",
        [agent] if agent != 'all' else [],
    )
    return [{'label': r['label'], 'firstSeen': r['first_seen'], 'lastSeen': r['last_seen'], 'calls': r['calls']} for r in rows]


async def _per_agent_versions(db, which: str) -> list[dict]:
    """Each agent's live (or previous) prompt version, in release order per agent."""
    rows = await db.query(
        """select agent_id, prompt_version as label, count(*)::int as n from calls where prompt_version is not null and status = 'scored'
     group by agent_id, prompt_version order by agent_id, min(started_at)""",
    )
    by: dict[str | None, dict] = {}
    for r in rows:
        a = by.setdefault(r['agent_id'], {'labels': [], 'n': 0})
        a['labels'].append(r['label'])
        a['n'] += r['n']
    out = [{'agentId': agent_id, 'n': a['n'], 'label': at(a['labels'], len(a['labels']) - 1) if which == 'live' else at(a['labels'], len(a['labels']) - 2)}
           for agent_id, a in by.items()]
    return sorted([x for x in out if x['label']], key=lambda x: -x['n'])


async def resolve_version(db, ver: str, agent: str) -> dict:
    if ver == 'all' or not ver:
        return {'label': None, 'anchor': None, 'live': True}
    vs = await versions(db, agent)
    if agent == 'all' and ver in ('live', 'previous'):
        pairs = await _per_agent_versions(db, ver)
        if len(pairs) > 1:
            # The label shown in the console is the busiest agent's; the filter uses every agent's own.
            return {'label': pairs[0]['label'], 'anchor': None, 'live': ver == 'live', 'perAgent': [{'agentId': p['agentId'], 'label': p['label']} for p in pairs]}
    if not vs:
        return {'label': None, 'anchor': None, 'live': True}
    live = vs[-1]
    if ver == 'live':
        return {'label': live['label'], 'anchor': None, 'live': True}
    v = at(vs, len(vs) - 2) if ver == 'previous' else next((x for x in vs if x['label'] == ver), None)
    if not v:
        return {'label': '__none__' if ver == 'previous' else ver, 'anchor': None, 'live': False}
    # A retired version is read over its own last `range` days, so comparisons are like for like.
    return {'label': v['label'], 'anchor': None if v['label'] == live['label'] else v['lastSeen'], 'live': v['label'] == live['label']}


async def slice_where(db, f: dict, ignore: tuple | list = (), start_index: int = 1) -> dict:
    """WHERE clause over `calls c` for a slice. Pass `ignore` to drop a filter a view doesn't use."""
    conds = ["c.status = 'scored'"]
    params: list[Any] = []

    def p(v: Any) -> str:
        params.append(v)
        return f'${start_index + len(params) - 1}'

    anchor = None
    label = None
    if 'ver' not in ignore:
        r = await resolve_version(db, f['ver'], f['agent'])
        label, anchor = r['label'], r['anchor']
        if r.get('perAgent'):
            conds.append(version_pairs_sql(r['perAgent'], p))
        elif r['label']:
            conds.append(f"c.prompt_version = {p(r['label'])}")
    if 'range' not in ignore:
        end = ms_of(anchor) if anchor is not None else now_ms()
        conds.append(f"c.started_at > {p(iso(int(end - f['range'] * 86_400_000)))}::timestamptz")
        if anchor is not None:
            conds.append(f'c.started_at <= {p(iso(end))}::timestamptz')
    if 'dir' not in ignore and f['dir'] != 'all':
        conds.append(f"c.direction = {p('inbound' if f['dir'] == 'in' else 'outbound')}")
    if 'path' not in ignore and f['path'] != 'all':
        conds.append(f"c.persona_path = {p(f['path'])}")
    if f['agent'] != 'all':
        conds.append(f"c.agent_id = {p(f['agent'])}")
    return {'sql': ' and '.join(conds), 'params': params, 'label': label}


def version_pairs_sql(pairs: list[dict], p: Callable[[Any], str]) -> str:
    """SQL matching each agent's own version: (agent a and version x) or (agent b and version y)…"""
    if not pairs:
        return 'false'
    parts = []
    for x in pairs:
        agent = 'c.agent_id is null' if x['agentId'] is None else f"c.agent_id = {p(x['agentId'])}"
        parts.append(f"({agent} and c.prompt_version = {p(x['label'])})")
    return f"({' or '.join(parts)})"
