# Six alert rules: compliance, quality, latency, tools, the funnel and the taxonomy. Each alert has a
# dedupe key, so re-running the rules never raises the same alert twice.

from __future__ import annotations

import math
import re
from datetime import datetime
from typing import Any

from ..framework import gate_by_id, median, quantile
from ..js import day_month_gb, dubai_when, iso, js_json, js_number, js_round, js_str, now_ms, parse_date, to_fixed, utc_from_ms
from ..lib.ids import new_id
from ..lib.settings import get_settings
from ..taxonomy import current, persona_by_id, scenario_by_id

ALERT_RULES: list[dict] = [
    {'name': 'Gate failure', 'when': 'Any call fails a compliance gate', 'urgency': 'Within the hour'},
    {'name': 'Quality drop', 'when': 'A cell’s median CQS falls 5 or more points week on week, with 30 or more calls in both weeks', 'urgency': 'Next working day'},
    {'name': 'Latency', 'when': 'p90 response latency above 4 s across a day', 'urgency': 'Same day'},
    {'name': 'Tool failure', 'when': 'Any tool fails on more than 5% of its calls in a day', 'urgency': 'Same day'},
    {'name': 'Funnel drop', 'when': 'A persona’s next-step rate falls 10 or more points week on week', 'urgency': 'Weekly review'},
    {'name': 'Taxonomy drift', 'when': 'Unclassified plus Other above 5% of calls for a week', 'urgency': 'Monthly review'},
]


def _urgency(rule: str) -> str:
    return next(r['urgency'] for r in ALERT_RULES if r['name'] == rule)


async def _raise(db, a: dict[str, Any]) -> bool:
    at = a.get('at')
    rows = await db.query(
        """insert into alert (id, rule, urgency, fired_at, text, page, link_label, params, dedupe_key) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
     on conflict (workspace_id, dedupe_key) do nothing returning id""",
        [new_id('al'), a['rule'], _urgency(a['rule']), iso(at if at is not None else now_ms()), a['text'], a['page'], a['link'], js_json(a.get('params') or {}), a['dedupe']],
    )
    return len(rows) > 0


def _cell_name(pid: str | None, sid: str | None) -> str:
    p, s = persona_by_id(pid), scenario_by_id(sid)
    return f"{p['id']} {p['name']}{f' × {sid} {s['name']}' if s else ''}"


def _day_str(d: datetime) -> str:
    return iso(d)[:10]


async def gate_alert(db, call_id: str) -> None:
    """Raised as soon as a gated call is scored."""
    c = await db.one('select c.call_id, c.external_id, c.persona, c.scenario, c.started_at, s.gates from calls c join call_score s on s.call_id = c.call_id where c.call_id = $1', [call_id])
    if not c or not (c['gates'] or []):
        return
    g = c['gates'][0]
    gate = gate_by_id(g['id'])
    gate_text = re.sub(r'\.$', '', gate['text'], count=1) if gate else g['id']
    n = len(c['gates'])
    more = f" (+{n - 1} more gate{'s' if n > 2 else ''})" if n > 1 else ''
    await _raise(db, {
        'rule': 'Gate failure', 'dedupe': f'gate:{call_id}', 'at': c['started_at'], 'page': 'calls', 'link': 'Open the call', 'params': {'id': call_id},
        'text': f"{c['external_id']} · {_cell_name(c['persona'], c['scenario'])}. {gate_text}{f': {g['detail']}' if g.get('detail') else ''}{more}",
    })


async def run_alert_rules(db, lookback_days: float = 2) -> int:
    """Evaluate the time-window rules over the last `lookback_days` (1 for the hourly run)."""
    settings = await get_settings(db)
    raised = 0
    now = now_ms()

    # Latency and tool failure, per day.
    i = 0
    while i < lookback_days:
        day = utc_from_ms(int(now - i * 86_400_000))
        d = _day_str(day)
        i += 1
        lats = await db.query(
            """select sum(t.duration_s) as total from trace_span t join calls c on c.call_id = t.call_id
       where t.kind in ('eot','llm','tool','tts') and to_char(c.started_at at time zone 'UTC', 'YYYY-MM-DD') = $1 group by t.call_id, t.turn""",
            [d],
        )
        if len(lats) >= 20:
            p90 = quantile([js_number(x['total']) for x in lats], 0.9)
            if p90 > 4:
                top = await db.one(
                    """select t.name, avg(t.duration_s) as d from trace_span t join calls c on c.call_id = t.call_id
           where t.kind = 'tool_call' and to_char(c.started_at at time zone 'UTC', 'YYYY-MM-DD') = $1 group by t.name order by avg(t.duration_s) desc limit 1""", [d])
                tail = f"; {top['name']} was the slowest tool at {to_fixed(js_number(top['d']), 1)} s on average" if top else ''
                if await _raise(db, {'rule': 'Latency', 'dedupe': f'latency:{d}', 'at': parse_date(f'{d}T20:00:00Z'), 'page': 'traces', 'link': 'See the spans in Traces',
                                     'text': f'p90 response latency was {to_fixed(p90, 1)} s across {day_month_gb(day)}, above the 4 s line{tail}.'}):
                    raised += 1
        tools = await db.query(
            """select t.name, count(*)::int as n, count(*) filter (where t.status = 'error')::int as errs from trace_span t join calls c on c.call_id = t.call_id
       where t.kind = 'tool_call' and to_char(c.started_at at time zone 'UTC', 'YYYY-MM-DD') = $1 group by t.name""", [d])
        for t in tools:
            if t['n'] >= 10 and t['errs'] / t['n'] > 0.05:
                if await _raise(db, {'rule': 'Tool failure', 'dedupe': f"tool:{t['name']}:{d}", 'at': parse_date(f'{d}T20:00:00Z'), 'page': 'traces', 'link': 'Check tool spans',
                                     'text': f"{t['name']} failed on {to_fixed((t['errs'] / t['n']) * 100, 1)}% of its {t['n']} calls on {day_month_gb(day)}, above the 5% line."}):
                    raised += 1

    # Week-on-week rules: quality drop per cell, funnel drop per persona, taxonomy drift.
    weeks = max(1, math.ceil(lookback_days / 7))
    for wk in range(weeks):
        end = utc_from_ms(int(now - wk * 7 * 86_400_000))
        end_ms = int(now - wk * 7 * 86_400_000)
        mid, start = utc_from_ms(end_ms - 7 * 86_400_000), utc_from_ms(end_ms - 14 * 86_400_000)
        rows = await db.query(
            """select c.persona as pid, c.scenario as sid, c.cqs, c.next_step is not null as ns, c.started_at > $2 as this_week,
         (select t.confidence from call_tag t where t.call_id = c.call_id and t.tag_key = 'persona' and t.layer in ('classifier','heuristic')) as persona_conf
       from calls c where c.status = 'scored' and c.started_at > $1 and c.started_at <= $3""",
            [iso(start), iso(mid), iso(end)],
        )
        tag = _day_str(end)
        cells: dict[str, dict] = {}
        for r in rows:
            k = f"{js_str(r['pid'])}|{js_str(r['sid'])}"
            g = cells.setdefault(k, {'a': [], 'b': []})
            (g['b'] if r['this_week'] else g['a']).append(js_number(r['cqs']))
        for k, g in cells.items():
            if len(g['a']) < settings['minCellCalls'] or len(g['b']) < settings['minCellCalls']:
                continue
            prev, cur = js_round(median(g['a'])), js_round(median(g['b']))
            if prev - cur >= 5:
                pid, sid = k.split('|')
                if await _raise(db, {'rule': 'Quality drop', 'dedupe': f'quality:{k}:{tag}', 'at': end, 'page': 'matrix', 'link': 'Inspect the cell in the quality matrix', 'params': {'sel': k},
                                     'text': f"{_cell_name(pid, sid)}: median CQS fell from {prev} to {cur} week on week ({len(g['a'])} and {len(g['b'])} calls)."}):
                    raised += 1
        per: dict[Any, dict] = {}
        for r in rows:
            if r['pid'] is None or persona_by_id(r['pid'])['path'] == 'Non-target' or r['pid'] == 'P0':
                continue
            g = per.setdefault(r['pid'], {'a': [], 'b': []})
            (g['b'] if r['this_week'] else g['a']).append(r['ns'])
        for pid, g in per.items():
            if len(g['a']) < settings['minCellCalls'] or len(g['b']) < settings['minCellCalls']:
                continue
            pa = (len([x for x in g['a'] if x]) / len(g['a'])) * 100
            pb = (len([x for x in g['b'] if x]) / len(g['b'])) * 100
            if pa - pb >= 10:
                if await _raise(db, {'rule': 'Funnel drop', 'dedupe': f'funnel:{js_str(pid)}:{tag}', 'at': end, 'page': 'funnel', 'link': 'Open the funnel', 'params': {'persona': pid},
                                     'text': f"{js_str(pid)} {persona_by_id(pid)['name']}: next-step rate fell from {js_round(pa)}% to {js_round(pb)}% week on week."}):
                    raised += 1
        this_week = [r for r in rows if r['this_week']]
        if len(this_week) >= 50:
            unc = len([r for r in this_week if r['pid'] == 'P0' or (r['persona_conf'] is not None and js_number(r['persona_conf']) < settings['confidenceThreshold'])])
            oth = len([r for r in this_week if current().basis(r['pid']) == 'P11'])
            share = ((unc + oth) / len(this_week)) * 100
            if share > 5:
                if await _raise(db, {'rule': 'Taxonomy drift', 'dedupe': f'drift:{tag}', 'at': end, 'page': 'taxonomy', 'link': 'Open taxonomy health',
                                     'text': f'Unclassified plus Other reached {to_fixed(share, 1)}% of calls for the week ending {day_month_gb(end)}, above the 5% line.'}):
                    raised += 1
    return raised


async def list_alerts(db, status: str, rule: str | None) -> dict:
    conds: list[str] = []
    params: list[Any] = []
    if status == 'open':
        conds.append('not acked')
    if status == 'ack':
        conds.append('acked')
    if rule:
        params.append(rule)
        conds.append(f'rule = ${len(params)}')
    rows = await db.query(f"select * from alert {f'where {' and '.join(conds)}' if conds else ''} order by fired_at desc limit 300", params)
    open_ = await db.query('select rule, count(*)::int as n from alert where not acked group by rule')
    alerts = [{
        'id': a['id'], 'rule': a['rule'], 'urgency': a['urgency'], 'firedAt': iso(a['fired_at']), 'when': dubai_when(a['fired_at']),
        'text': a['text'], 'page': a['page'], 'link': a['link_label'], 'params': a['params'] if a['params'] is not None else {}, 'acked': bool(a['acked']),
    } for a in rows]
    return {'alerts': alerts, 'rules': [{**r, 'open': next((o['n'] for o in open_ if o['rule'] == r['name']), 0)} for r in ALERT_RULES]}


async def ack_alert(db, id: str, acked: bool) -> dict:
    await db.query('update alert set acked = $2, acked_at = case when $2 then now() else null end where id = $1', [id, acked])
    return {'acked': acked}
