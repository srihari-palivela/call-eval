# Technical view: the persona × scenario quality matrix, a cell's detail, and the fix-first map.

from __future__ import annotations

import re
from typing import Any

from ..framework import DIMS
from ..js import fixed, js_number, js_round, to_fixed
from ..lib.settings import get_settings
from ..taxonomy import current, persona_by_id, scenario_by_id
from .filters import parse_slice, slice_where

DIM_COLS = ', '.join(f"percentile_cont(0.5) within group (order by s.{d['key']}) as {d['key']}" for d in DIMS)


async def cells(db, f: dict, ignore_ver: bool = False) -> dict:
    w = await slice_where(db, f, ['ver'] if ignore_ver else [])
    rows = await db.query(
        f"""with credited as (
       select o.credited_call_id as call_id, sum(case when o.stage in ('reservation','sale') then coalesce(o.value_aed, 0) else 0 end) as value
       from lead_outcome o where o.credited_call_id is not null group by o.credited_call_id)
     select c.persona as pid, c.scenario as sid, count(*)::int as n,
       percentile_cont(0.5) within group (order by c.cqs) as cqs,
       avg(case when c.gated then 1.0 else 0.0 end) * 100 as gate,
       avg(case when c.next_step = 'meeting' then 1.0 else 0.0 end) * 100 as meet,
       avg(case when c.next_step is not null then 1.0 else 0.0 end) * 100 as ns,
       coalesce(sum(cr.value), 0) / count(*) / 1000.0 as res,
       {DIM_COLS}
     from calls c join call_score s on s.call_id = c.call_id
     left join credited cr on cr.call_id = c.call_id
     where {w['sql']} and c.persona is not null and c.scenario is not null
     group by c.persona, c.scenario""",
        w['params'],
    )
    out = []
    for r in rows:
        cqs = js_round(js_number(r['cqs']))
        # A dimension with no applicable metric in any of the cell's calls reads as the cell's CQS.
        dims = {d['key']: cqs if r.get(d['key']) is None else js_round(js_number(r[d['key']])) for d in DIMS}
        out.append({'pid': r['pid'], 'sid': r['sid'], 'n': r['n'], 'cqs': cqs, 'gate': fixed(js_number(r['gate']), 1), 'dims': dims,
                    'meet': fixed(js_number(r['meet']), 1), 'res': fixed(js_number(r['res']), 1), 'ns': fixed(js_number(r['ns']), 1)})
    return {'cells': out, 'label': w['label']}


async def matrix(db, q: dict[str, Any]) -> dict:
    f = parse_slice(q)
    r = await cells(db, f)
    return {'ver': r['label'], 'cells': r['cells'], 'calls': sum(c['n'] for c in r['cells'])}


async def cell_detail(db, pid: str, sid: str, q: dict[str, Any]) -> dict | None:
    from .calls import list_calls

    f = parse_slice(q)
    all_ = await cells(db, f)
    cell = next((c for c in all_['cells'] if c['pid'] == pid and c['sid'] == sid), None)
    if not cell:
        return None
    w = await slice_where(db, f, [], 3)
    rows = await db.query(
        f"select s.path, s.tool_stats, c.call_id from calls c join call_score s on s.call_id = c.call_id where c.persona = $1 and c.scenario = $2 and {w['sql']}",
        [pid, sid, *w['params']],
    )

    # Path adherence: share of calls reaching each checkpoint in order. Steps are matched by checkpoint id, and a
    # checkpoint a call wasn't assessed on (a user-defined one under the heuristic judge) counts only where it was.
    cps = current().checkpoints(sid)
    reach = [0 for _ in cps]
    assessed = [0 for _ in cps]
    for r in rows:
        steps = {x.get('id'): x for x in ((r['path'] or {}).get('steps') or [] if isinstance(r['path'], dict) else [])}
        last = -1
        for k, c in enumerate(cps):
            s = steps.get(c['id'])
            if s is None:
                continue
            assessed[k] += 1
            if not s.get('hit') or (s.get('turn') is not None and s['turn'] < last):
                break
            if s.get('turn') is not None:
                last = s['turn']
            reach[k] += 1
    max_drop, exit_, prev = -1, -1, 100
    path = []
    for k, c in enumerate(cps):
        if rows and not assessed[k]:
            continue
        pct = js_round((reach[k] / max(1, assessed[k] if rows else 0)) * 100)
        if prev - pct > max_drop:
            max_drop, exit_ = prev - pct, len(path)
        prev = pct
        path.append({'label': c['label'], 'pct': pct, 'exit': False})
    if exit_ >= 0 and len(path) > 1:
        path[exit_]['exit'] = True

    # Tool health for the tools this cell's calls used or needed.
    agg: dict[str, dict] = {}
    for r in rows:
        for t in r['tool_stats'] or []:
            if t['name'] == 'end_call':
                continue
            a = agg.setdefault(t['name'], {'made': 0, 'correct': 0, 'expected': 0, 'met': 0, 'fc': 0, 'fo': 0})
            a['made'] += t['made']
            a['correct'] += t['correct']
            a['expected'] += t['expected']
            a['met'] += t['met']
            a['fc'] += t['fidelityChecked']
            a['fo'] += t['fidelityOk']
    tools = sorted([{
        'name': name, 'n': a['made'],
        'p': js_round((a['correct'] / a['made']) * 100) if a['made'] else None,
        'r': js_round((a['met'] / a['expected']) * 100) if a['expected'] else None,
        'f': js_round((a['fo'] / a['fc']) * 100) if a['fc'] else None,
    } for name, a in agg.items()], key=lambda x: -x['n'])[:6]

    persona_check = await _persona_check_for(db, pid, sid, w['sql'], w['params'])
    calls = await list_calls(db, {**q, 'persona': pid, 'scenario': sid, 'sort': 'worst', 'limit': '6'})
    return {'cell': cell, 'path': path, 'tools': tools, 'personaCheck': persona_check, 'calls': calls['items']}


async def _persona_check_for(db, pid: str, sid: str, where: str, params: list) -> dict | None:
    """The persona's "watch for" check, measured from the metrics that capture it."""
    p = persona_by_id(pid)
    if not p['checkLabel']:
        return None
    base = f'from calls c join metric_result m on m.call_id = c.call_id where c.persona = $1 and c.scenario = $2 and {where}'

    async def avg(key: str, expr: str = 'avg(m.value)') -> float | None:
        r = await db.one(f"select {expr} as v {base} and m.metric_key = '{key}' and m.applicable", [pid, sid, *params])
        return r['v'] if r else None

    def pct(v: float | None) -> str:
        return '—' if v is None else f'{js_round(js_number(v))}%'

    label = p['checkLabel']
    b = p.get('basedOn')  # the framework persona whose check this one inherits; a new persona has none
    if b == 'P1':
        return {'label': label, 'value': pct(await avg('nf'))}
    if b == 'P2':
        return {'label': label, 'value': pct(await avg('rga', 'avg(m.raw)'))}
    if b == 'P3':
        return {'label': label, 'value': pct(await avg('sc'))}
    if b == 'P6':
        return {'label': label, 'value': pct(await avg('cfc', 'avg(100 - m.value)'))}
    if b == 'P7':
        v = await avg('bpp', 'avg(m.raw)')
        return {'label': label, 'value': '—' if v is None else to_fixed(js_number(v), 1)}
    if b == 'P8':
        return {'label': label, 'value': pct(await avg('pr'))}
    if b in ('P4', 'P5'):
        rx = '%UAE time%' if b == 'P4' else '%handover%'
        shifted = re.sub(r'\$(\d+)', lambda m: f'${int(m.group(1)) + 1}', where)
        r = await db.one(
            f"select avg(case when c.canonical::text ilike $3 then 100.0 else 0 end) as v from calls c where c.persona = $1 and c.scenario = $2 and {shifted}{" and c.next_step = 'meeting'" if b == 'P4' else ''}",
            [pid, sid, rx, *params],
        )
        return {'label': label, 'value': pct(r['v'] if r else None)}
    if b in ('P9', 'P10'):
        r = await db.one(
            f"""select avg(case when s.phases::text like '%"Pitch"%' then 100.0 else 0 end) as v from calls c join call_score s on s.call_id = c.call_id where c.persona = $1 and c.scenario = $2 and {where}""",
            [pid, sid, *params],
        )
        return {'label': label, 'value': pct(r['v'] if r else None)}
    if b == 'P11':
        r = await db.one(f'select avg(case when c.duration_s <= 60 then 100.0 else 0 end) as v from calls c where c.persona = $1 and c.scenario = $2 and {where}', [pid, sid, *params])
        return {'label': label, 'value': pct(r['v'] if r else None)}
    return None


async def fix_map(db, q: dict[str, Any]) -> dict:
    """Where to fix first: every cell with enough calls, by median CQS (split at the Good line) and value per call (split at the median)."""
    f = parse_slice(q)
    vm = 'res' if q.get('vm') == 'res' else 'meet'
    settings = await get_settings(db)
    all_ = (await cells(db, f))['cells']
    lst = [{**c, 'key': f"{c['pid']}|{c['sid']}", 'val': c['res'] if vm == 'res' else c['meet'], 'quad': 'maintain', 'depth': 0,
            'weak': {'key': DIMS[0]['key'], 'name': DIMS[0]['name']}}
           for c in all_ if c['n'] >= settings['minCellCalls'] and persona_by_id(c['pid'])['path'] in ('Investor', 'Broker') and scenario_by_id(c['sid'])]
    vals = sorted(c['val'] for c in lst)
    med = vals[len(vals) // 2] if vals else 0
    vmax = vals[-1] if vals else 1
    for c in lst:
        hi, good = c['val'] >= med, c['cqs'] >= settings['goodLine']
        c['quad'] = ('protect' if good else 'fix') if hi else ('maintain' if good else 'review')
        c['depth'] = (settings['goodLine'] - c['cqs']) / 20 + (c['val'] - med) / ((vmax - med) or 1)
        low = DIMS[0]
        for d in DIMS:
            if c['dims'][d['key']] < c['dims'][low['key']]:
                low = d
        c['weak'] = {'key': low['key'], 'name': low['name']}
    top5 = sorted([c for c in lst if c['quad'] == 'fix'], key=lambda c: -c['depth'])[:5]
    return {'cells': lst, 'med': med, 'vmax': vmax, 'top5': top5, 'vm': vm}
