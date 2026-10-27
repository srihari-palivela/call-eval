# Version report: per-cell change between two prompt versions with a 95% bootstrap interval. A change
# counts only when the interval excludes zero and both sides have enough calls.

from __future__ import annotations

import math
from datetime import datetime
from typing import Any

from ..framework import DIM_KEYS, bootstrap_median_diff, median
from ..js import at, day_month_gb, fixed, js_round, now_ms, utc_from_ms
from ..lib.settings import get_settings
from .filters import versions
from .matrix import fix_map


def _window_of(a: datetime, b: datetime | None) -> str:
    return f"{day_month_gb(a)} – {day_month_gb(b or utc_from_ms(now_ms()))} {(b or utc_from_ms(now_ms())).year}"


async def version_report(db, q: dict[str, Any]) -> dict:
    agent = q['agent'] if isinstance(q.get('agent'), str) and q['agent'] else 'all'
    # Version labels are per agent, so with several agents the report compares the busiest agent's
    # releases unless one is chosen.
    if agent == 'all':
        agents = await db.query("select agent_id from calls where status = 'scored' and prompt_version is not null and agent_id is not null group by agent_id order by count(*) desc")
        if len(agents) > 1:
            agent = agents[0]['agent_id']
    vs = await versions(db, agent)
    last, prev = at(vs, len(vs) - 1), at(vs, len(vs) - 2)
    to = (q['to'] if isinstance(q.get('to'), str) and q['to'] else None) or (last['label'] if last else None) or None
    from_ = (q['from'] if isinstance(q.get('from'), str) and q['from'] else None) or (prev['label'] if prev else None) or None
    measure = 'ns' if q.get('measure') == 'ns' else 'cqs'
    score = q['score'] if isinstance(q.get('score'), str) and (q['score'] == 'cqs' or q['score'] in DIM_KEYS) else 'cqs'
    settings = await get_settings(db)
    from_v = next((v for v in vs if v['label'] == from_), None)
    to_v = next((v for v in vs if v['label'] == to), None)
    if not from_ or not to or not from_v or not to_v:
        return {'from': from_, 'to': to, 'fromWindow': _window_of(from_v['firstSeen'], from_v['lastSeen']) if from_v else None,
                'toWindow': _window_of(to_v['firstSeen'], to_v['lastSeen']) if to_v else None, 'cells': [], 'fixKeys': []}

    col = 'c.cqs' if score == 'cqs' else f's.{score}'
    rows = await db.query(
        f"""select c.prompt_version as v, c.persona as pid, c.scenario as sid, {col} as x, (c.next_step is not null) as ns
     from calls c join call_score s on s.call_id = c.call_id
     where c.status = 'scored' and c.prompt_version in ($1, $2) and c.persona is not null and c.scenario is not null {'and c.agent_id = $3' if agent != 'all' else ''}
     order by c.persona, c.scenario, c.started_at, c.call_id""",
        [from_, to, agent] if agent != 'all' else [from_, to],
    )
    groups: dict[str, dict] = {}
    for r in rows:
        k = f"{r['pid']}|{r['sid']}"
        g = groups.get(k) or {'a': [], 'b': []}
        val = (100 if r['ns'] else 0) if measure == 'ns' else (None if r['x'] is None else float(r['x']))
        if val is not None:
            (g['a'] if r['v'] == from_ else g['b']).append(val)
        groups[k] = g
    min_ = settings['minCellCalls']
    cells = []
    # Rows arrive ordered, so each cell's bootstrap seed (and so its interval) is the same on every request.
    seed = 11
    for key, g in groups.items():
        a, b = g['a'], g['b']
        if not a or not b:
            continue
        pid, sid = key.split('|')
        if measure == 'ns':
            p2, p3 = sum(a) / len(a) / 100, sum(b) / len(b) / 100
            old, nw = js_round(p2 * 100), js_round(p3 * 100)
            pm = (p2 + p3) / 2
            half = 1.96 * math.sqrt(max(pm * (1 - pm), 0.0001) * (1 / len(a) + 1 / len(b))) * 100
            lo, hi = (p3 - p2) * 100 - half, (p3 - p2) * 100 + half
        else:
            old, nw = js_round(median(a)), js_round(median(b))
            r = bootstrap_median_diff(a, b, 600, seed)
            seed += 1
            lo, hi = r['lo'], r['hi']
        d = nw - old
        enough = len(a) >= min_ and len(b) >= min_
        verdict = 'few' if not enough else 'up' if lo > 0 else 'down' if hi < 0 else 'flat'
        cells.append({'pid': pid, 'sid': sid, 'n2': len(a), 'n3': len(b), 'old': old, 'nw': nw, 'd': d, 'lo': fixed(lo, 1), 'hi': fixed(hi, 1), 'verdict': verdict, 'key': key})
    fix = await fix_map(db, {'range': '90', 'agent': agent})
    return {'from': from_, 'to': to, 'fromWindow': _window_of(from_v['firstSeen'], from_v['lastSeen']), 'toWindow': _window_of(to_v['firstSeen'], to_v['lastSeen']),
            'cells': cells, 'fixKeys': [c['key'] for c in fix['top5']]}
