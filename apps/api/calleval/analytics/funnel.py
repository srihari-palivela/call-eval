# Business view: each persona down the sales funnel, with CRM outcomes credited to calls.
# Rates are fractions (0–1); lost reasons and drop-offs are percentages.

from __future__ import annotations

from typing import Any

from ..framework import LOST_REASON_LABELS
from ..js import fixed, js_round, js_str, num_or
from ..lib.settings import get_settings
from ..taxonomy import current, persona_by_id
from .filters import parse_slice, slice_where


async def funnel(db, q: dict[str, Any]) -> dict:
    f = parse_slice(q)
    w = await slice_where(db, f, ['ver', 'path'])
    settings = await get_settings(db)
    crm = await db.one('select count(*)::int as n from lead_outcome')
    crm_connected = ((crm or {}).get('n') or 0) > 0
    personas = current().personas

    per = await db.query(
        f"""select c.persona as pid, count(*)::int as n, count(*) filter (where c.qualified)::int as qual,
       count(*) filter (where c.next_step is not null)::int as ns, count(*) filter (where c.next_step = 'meeting')::int as mb,
       avg(c.duration_s) / 60.0 as mins,
       count(*) filter (where exists (select 1 from call_event e where e.call_id = c.call_id and e.type = 'intent_rose'))::int as lift,
       count(*) filter (where exists (select 1 from call_tag t where t.call_id = c.call_id and t.tag_key = 'facet:broker_registration' and t.value = 'Unregistered'))::int as unreg
     from calls c where {w['sql']} and c.persona is not null group by c.persona""",
        w['params'],
    )
    out = await db.query(
        f"""select c.persona as pid, o.stage, count(*)::int as n, sum(o.value_aed) as value
     from lead_outcome o join calls c on c.call_id = o.credited_call_id where {w['sql']} group by c.persona, o.stage""",
        w['params'],
    )

    def stage(pid: str, s: str | list[str]) -> int:
        return sum(o['n'] for o in out if o['pid'] == pid and (o['stage'] in s if isinstance(s, list) else o['stage'] == s))

    def value(pid: str) -> float:
        return sum(num_or(o['value'], 0) for o in out if o['pid'] == pid and o['stage'] in ('reservation', 'sale'))

    def row(pid: str) -> dict | None:
        return next((p for p in per if p['pid'] == pid), None)

    def safe(a: float, b: float) -> float:
        return a / b if b else 0

    def g(r: dict | None, k: str) -> Any:
        return r[k] if r else None

    investor = []
    for p in [x for x in personas if x['path'] == 'Investor']:
        r = row(p['id'])
        n, qual, mb = g(r, 'n') or 0, g(r, 'qual') or 0, g(r, 'mb') or 0
        investor.append({
            'id': p['id'], 'name': p['name'], 'n': n, 'q': safe(qual, n), 'ns': safe(g(r, 'ns') or 0, n), 'mb': min(1, safe(mb, qual)),
            'show': min(1, safe(stage(p['id'], 'meeting_attended'), mb)) if crm_connected else None,
            'sv': min(1, safe(stage(p['id'], 'site_visit'), qual)) if crm_connected else None,
            'res': min(1, safe(stage(p['id'], ['reservation', 'sale']), qual)) if crm_connected else None,
            'qual': qual, 'value': value(p['id']) / 1_000_000 if crm_connected else None, 'lift': safe(g(r, 'lift') or 0, n), 'mins': fixed(num_or(g(r, 'mins'), 0), 1),
        })
    broker = []
    for p in [x for x in personas if x['path'] == 'Broker']:
        r = row(p['id'])
        n, unreg = g(r, 'n') or 0, g(r, 'unreg') or 0
        reg, bdm, lead = stage(p['id'], 'broker_registered'), stage(p['id'], 'bdm_call_held'), stage(p['id'], ['broker_first_lead', 'broker_deal'])
        broker.append({
            'id': p['id'], 'name': p['name'], 'n': n, 'unreg': unreg, 'reg': reg, 'bdm': bdm, 'lead': lead,
            'act': min(1, safe(reg, unreg)) if crm_connected else None, 'bdmR': min(1, safe(bdm, reg)) if crm_connected else None,
            'leadR': min(1, safe(lead, reg)) if crm_connected else None,
            'ns': safe(g(r, 'ns') or 0, n), 'mins': fixed(num_or(g(r, 'mins'), 0), 1),
        })

    # Lost reasons: objection events on target calls that ended with no next step.
    objections = [e for e in current().events if e['group'] == 'Objections']
    lost_keys = [e['id'] for e in objections]
    lost_labels = [LOST_REASON_LABELS.get(e['id']) or e['label'].replace('Objection · ', '', 1) for e in objections]
    lost_rows = await db.query(
        f"""select c.persona as pid, e.type, count(*)::int as n from call_event e join calls c on c.call_id = e.call_id
     where {w['sql']} and c.next_step is null and c.persona_path in ('Investor','Broker') and e.type = any(${len(w['params']) + 1}::text[])
     group by c.persona, e.type""",
        [*w['params'], lost_keys],
    )
    lost: dict[str, list[int]] = {}
    for p in [x for x in personas if x['path'] != 'Non-target']:
        counts = [next((r['n'] for r in lost_rows if r['pid'] == p['id'] and r['type'] == k), 0) for k in lost_keys]
        tot = sum(counts)
        lost[p['id']] = [js_round((c / tot) * 100) if tot else 0 for c in counts]

    # Drop-off: where calls with no next step left their expected path.
    drop_rows = await db.query(
        f"""select c.persona as pid, c.scenario as sid, s.path, s.phases from calls c join call_score s on s.call_id = c.call_id
     where {w['sql']} and c.next_step is null and c.persona_path in ('Investor','Broker')""",
        w['params'],
    )
    drops: dict[str, list] = {}
    for p in [x for x in personas if x['path'] != 'Non-target']:
        lst = [r for r in drop_rows if r['pid'] == p['id'] and r['path'] and r['path'].get('deviation')]
        counts: dict[str, dict] = {}
        for r in lst:
            steps = r['path']['steps']
            last_hit = next((s for s in reversed(steps) if s.get('hit') and s.get('turn') is not None), None)
            if last_hit:
                ph = next((x for x in ((r['phases'] or {}).get('phases') or []) if x['from'] <= last_hit['turn'] <= x['to']), None)
                phase = ph['name'] if ph else 'Body'
            else:
                phase = 'Introduction'
            key = f"{r['path']['deviation']} · {js_str(r['sid'])}"
            cur = counts.get(key) or {'phase': phase, 'n': 0}
            cur['n'] += 1
            counts[key] = cur
        tot = len(lst)
        drops[p['id']] = sorted([[k, v['phase'], js_round((v['n'] / tot) * 100) if tot else 0] for k, v in counts.items()], key=lambda x: -x[2])[:3]

    calls = sum(r['n'] for r in per)
    target_ids = [p['id'] for p in personas if p['path'] != 'Non-target']
    target = [r for r in per if r['pid'] in target_ids]
    return {
        'range': js_str(f['range']),
        'totals': {
            'calls': calls, 'targetCalls': sum(r['n'] for r in target), 'qualified': sum(r['qual'] for r in target),
            'nextStep': sum(r['ns'] for r in per), 'nonTarget': sum(r['n'] for r in per if persona_by_id(r['pid'])['path'] == 'Non-target'),
        },
        'investor': investor, 'broker': broker, 'lostLabels': lost_labels, 'lost': lost, 'drops': drops,
        'crmConnected': crm_connected, 'attributionDays': settings['attributionDays'],
    }
