# Lead funnels: the ordered stages a CRM lead moves through, defined per business. A stage can stand for a
# framework milestone, which is what the rest of the platform understands: calls move leads to the contacted,
# qualified and meeting-booked stages, outcome milestones are written as lead outcomes (attribution, Funnel by
# persona), and lost and do-not-contact stages close the lead. Stages without a milestone are the team's own.
#
# Every lead belongs to one funnel; new leads go to the first funnel whose match rules they meet, else the
# default funnel. The default funnel starts with the stages the CRM has always had, so existing leads keep theirs.

from __future__ import annotations

import copy
import re
import statistics
from typing import Any

from ..js import iso, js_json
from ..lib.errors import http_error
from ..lib.ids import new_id
from .outcomes import STAGES as OUTCOME_MILESTONES

MILESTONES: list[dict] = [
    {'id': 'new', 'label': 'New', 'description': 'Added, not contacted yet.'},
    {'id': 'contacted', 'label': 'Contacted', 'description': 'Reached on a call; calls and campaigns move leads here.'},
    {'id': 'qualified', 'label': 'Qualified', 'description': 'A call showed the lead is qualified; calls move leads here.'},
    {'id': 'meeting_booked', 'label': 'Meeting booked', 'description': 'A call booked a meeting; credited to that call.'},
    {'id': 'meeting_attended', 'label': 'Meeting attended', 'description': 'Outcome credited to the call before it.'},
    {'id': 'site_visit', 'label': 'Site visit', 'description': 'Outcome credited to the call before it.'},
    {'id': 'reservation', 'label': 'Reservation', 'description': 'Outcome credited to the call before it (long window).'},
    {'id': 'sale', 'label': 'Sale', 'description': 'Outcome credited to the call before it (long window).'},
    {'id': 'broker_registered', 'label': 'Partner registered', 'description': 'Partner outcome credited to the call before it.'},
    {'id': 'bdm_call_held', 'label': 'Partner call held', 'description': 'Partner outcome credited to the call before it.'},
    {'id': 'broker_first_lead', 'label': 'Partner’s first lead', 'description': 'Partner outcome (long window).'},
    {'id': 'broker_deal', 'label': 'Partner deal', 'description': 'Partner outcome (long window).'},
    {'id': 'lost', 'label': 'Lost', 'description': 'Closed without a deal.'},
    {'id': 'dnc', 'label': 'Do not contact', 'description': 'Asked not to be contacted; never called again. Every funnel has one.'},
]
MILESTONE_IDS = {m['id'] for m in MILESTONES}
# Calls move a lead forward to these, highest first, when its funnel has a stage for them.
CALL_MILESTONES = ('meeting_booked', 'qualified', 'contacted')
SOURCES = ('manual', 'csv', 'apollo', 'call', 'api')
PATHS = ('Investor', 'Broker', 'Non-target')
KINDS = ('open', 'won', 'lost')
DEFAULT_ID = 'fn_default'
_KEY = re.compile(r'^[a-z][a-z0-9_]{0,39}$')


def _st(key: str, label: str, milestone: str | None, kind: str = 'open', callable: bool | None = None, description: str = '') -> dict:
    return {'key': key, 'label': label, 'description': description, 'milestone': milestone, 'kind': kind,
            'callable': kind == 'open' if callable is None else callable}


DNC_STAGE = _st('dnc', 'Do not contact', 'dnc', 'lost')
# The stages the built-in CRM had before funnels; reservations were never called again.
DEFAULT_STAGES = [
    _st('new', 'New', 'new'), _st('contacted', 'Contacted', 'contacted'), _st('qualified', 'Qualified', 'qualified'),
    _st('meeting_booked', 'Meeting booked', 'meeting_booked'), _st('meeting_attended', 'Meeting attended', 'meeting_attended'),
    _st('site_visit', 'Site visit', 'site_visit'), _st('reservation', 'Reservation', 'reservation', callable=False),
    _st('sale', 'Sale', 'sale', 'won'), _st('lost', 'Lost', 'lost', 'lost'), DNC_STAGE,
]

TEMPLATES: dict[str, dict] = {
    'property_buyers': {
        'name': 'Property buyers', 'description': 'Enquiry to sale for off-plan buyers: meetings, site visits, reservations.',
        'stages': DEFAULT_STAGES, 'match': {'paths': ['Investor'], 'personas': [], 'sources': []},
    },
    'b2b_demo': {
        'name': 'B2B demo pipeline', 'description': 'Outbound or inbound business leads: discovery call, demo, proposal, close.',
        'stages': [
            _st('new', 'New', 'new'), _st('contacted', 'Contacted', 'contacted'), _st('qualified', 'Qualified', 'qualified'),
            _st('demo_booked', 'Demo booked', 'meeting_booked'), _st('demo_held', 'Demo held', 'meeting_attended'),
            _st('proposal', 'Proposal sent', None, callable=False, description='Pricing or a proposal is with the buyer.'),
            _st('negotiation', 'Negotiation', None, callable=False), _st('closed_won', 'Closed won', 'sale', 'won'),
            _st('closed_lost', 'Closed lost', 'lost', 'lost'), DNC_STAGE,
        ],
        'match': {'paths': [], 'personas': [], 'sources': []},
    },
    'partners': {
        'name': 'Partners and brokers', 'description': 'Recruiting partners: registration, an intro call with the partner team, first referral.',
        'stages': [
            _st('new', 'New', 'new'), _st('contacted', 'Contacted', 'contacted'), _st('registered', 'Registered', 'broker_registered'),
            _st('intro_call', 'Partner-team call held', 'bdm_call_held'), _st('first_referral', 'First referral', 'broker_first_lead', callable=False),
            _st('active', 'Active partner', 'broker_deal', 'won'), _st('lost', 'Not a fit', 'lost', 'lost'), DNC_STAGE,
        ],
        'match': {'paths': ['Broker'], 'personas': [], 'sources': []},
    },
}


def templates() -> list[dict]:
    return [{'id': k, 'name': v['name'], 'description': v['description']} for k, v in TEMPLATES.items()]


def _slug(s: str) -> str:
    out = re.sub(r'[^a-z0-9]+', '_', s.lower()).strip('_')[:40].strip('_')
    return out if out and out[0].isalpha() else f's_{out}'[:40]


def normalise_stages(raw: Any) -> list[dict]:
    """Check a funnel's stages and fill what can be filled (keys from labels, kinds from milestones, the DNC stage)."""
    if not isinstance(raw, list) or not all(isinstance(x, dict) for x in raw):
        raise http_error(400, 'stages must be a list of objects')
    if not 2 <= len(raw) <= 20:
        raise http_error(400, 'A funnel has 2 to 20 stages')
    errs: list[str] = []
    out: list[dict] = []
    for i, s in enumerate(raw):
        label = str(s.get('label') or '').strip()[:60]
        what = f'Stage {i + 1}' + (f' ({label})' if label else '')
        if not label:
            errs.append(f'{what}: a label is required')
        key = str(s.get('key') or '').strip() or _slug(label or f'stage {i + 1}')
        if not _KEY.match(key):
            errs.append(f'{what}: key must be lower-case letters, digits and _, starting with a letter')
        m = s.get('milestone')
        m = None if m in (None, '', 'none') else m
        if m is not None and m not in MILESTONE_IDS:
            errs.append(f'{what}: unknown milestone {m}')
        kind = s.get('kind') or ('won' if m in ('sale', 'broker_deal') else 'lost' if m in ('lost', 'dnc') else 'open')
        if kind not in KINDS:
            errs.append(f'{what}: kind must be open, won or lost')
        if m in ('lost', 'dnc') and kind != 'lost':
            errs.append(f'{what}: a {m} stage is a lost stage')
        callable_ = bool(s.get('callable', kind == 'open')) and kind == 'open'
        out.append({'key': key, 'label': label, 'description': str(s.get('description') or '').strip()[:300], 'milestone': m, 'kind': kind,
                    'callable': callable_})
    keys = [s['key'] for s in out]
    for k in sorted({k for k in keys if keys.count(k) > 1}):
        errs.append(f'Two stages have the key {k}')
    ms = [s['milestone'] for s in out if s['milestone']]
    for m in sorted({m for m in ms if ms.count(m) > 1}):
        errs.append(f'The milestone {m} is on two stages')
    if out and out[0]['kind'] != 'open':
        errs.append('The first stage must be an open stage')
    if errs:
        raise http_error(400, 'The funnel has problems: ' + '; '.join(errs[:10]))
    # Every funnel can honour a do-not-contact request.
    if 'dnc' not in ms:
        out.append({**DNC_STAGE, 'key': 'dnc' if 'dnc' not in keys else 'do_not_contact'})
    return out


def _match(raw: Any) -> dict:
    m = raw if isinstance(raw, dict) else {}

    def strs(v: Any, allowed: tuple | None = None) -> list[str]:
        xs = [str(x).strip() for x in (v if isinstance(v, list) else []) if str(x).strip()][:50]
        if allowed is not None and any(x not in allowed for x in xs):
            raise http_error(400, f"match takes {', '.join(allowed)}")
        return list(dict.fromkeys(xs))

    return {'paths': strs(m.get('paths'), PATHS), 'personas': strs(m.get('personas')), 'sources': strs(m.get('sources'), SOURCES)}


def to_dto(r: dict, counts: dict[str, int] | None = None) -> dict:
    counts = counts or {}
    m = r['match'] or {}
    return {'id': r['id'], 'name': r['name'], 'description': r['description'], 'isDefault': r['is_default'], 'stages': r['stages'],
            'match': {k: m.get(k) or [] for k in ('paths', 'personas', 'sources')},
            'leads': sum(counts.values()), 'byStage': {s['key']: counts.get(s['key'], 0) for s in r['stages']},
            'createdAt': iso(r['created_at']), 'updatedAt': iso(r['updated_at'])}


# ---------- Reading ----------

async def ensure_default(db) -> dict:
    """The default funnel, created on first use with the CRM's original stages; leads from before funnels join it."""
    r = await db.one('select * from funnel where is_default')
    if not r:
        await db.query(
            """insert into funnel (id, name, description, is_default, stages, match) values ($1, 'Leads', 'The default funnel: every lead no other funnel matches.', true, $2::jsonb, $3::jsonb)
               on conflict do nothing""", [DEFAULT_ID, js_json(DEFAULT_STAGES), js_json(_match({}))])
        r = await db.one('select * from funnel where is_default')
    await db.query('update lead set funnel_id = $1 where funnel_id is null', [r['id']])
    return r


async def get_funnel(db, id: str) -> dict:
    await ensure_default(db)
    r = await db.one('select * from funnel where id = $1', [id])
    if not r:
        raise http_error(404, 'Funnel not found')
    return r


async def _counts(db) -> dict[str, dict[str, int]]:
    rows = await db.query('select funnel_id, stage, count(*)::int as n from lead group by funnel_id, stage')
    out: dict[str, dict[str, int]] = {}
    for r in rows:
        out.setdefault(r['funnel_id'], {})[r['stage']] = r['n']
    return out


async def list_funnels(db) -> list[dict]:
    await ensure_default(db)
    counts = await _counts(db)
    return [to_dto(r, counts.get(r['id'])) for r in await db.query('select * from funnel order by is_default desc, created_at')]


async def funnel_dto(db, id: str) -> dict:
    r = await get_funnel(db, id)
    return to_dto(r, (await _counts(db)).get(id))


def stage_of(funnel: dict, key: str | None) -> dict | None:
    return next((s for s in funnel['stages'] if s['key'] == key), None)


def stage_for(funnel: dict, milestone: str) -> dict | None:
    return next((s for s in funnel['stages'] if s['milestone'] == milestone), None)


def first_stage(funnel: dict) -> dict:
    return funnel['stages'][0]


async def funnel_for_lead(db, values: dict, source: str) -> dict:
    """The funnel a new lead joins: the first non-default funnel whose rules it matches, else the default."""
    from ..taxonomy import persona_by_id
    default = await ensure_default(db)
    hint = values.get('persona_hint')
    path = persona_by_id(hint)['path'] if hint else None
    for f in await db.query('select * from funnel where not is_default order by created_at'):
        m = f['match'] or {}
        if source in (m.get('sources') or []) or (hint and hint in (m.get('personas') or [])) or (path and path in (m.get('paths') or [])):
            return f
    return default


async def blocked_stages(db) -> list[str]:
    """`funnel_id:stage` for every stage campaigns may not call (won, lost, or marked not callable)."""
    await ensure_default(db)
    return [f"{f['id']}:{s['key']}" for f in await db.query('select id, stages from funnel') for s in f['stages'] if not s['callable']]


# ---------- Changes ----------

def _body(b: dict, cur: dict | None = None) -> dict:
    out: dict[str, Any] = {}
    if 'name' in b or cur is None:
        name = str(b.get('name') or '').strip()[:80]
        if not name:
            raise http_error(400, 'A funnel needs a name')
        out['name'] = name
    if 'description' in b:
        out['description'] = str(b.get('description') or '').strip()[:500]
    if 'stages' in b:
        out['stages'] = normalise_stages(b['stages'])
    if 'match' in b:
        out['match'] = _match(b['match'])
    return out


async def create_funnel(db, b: dict) -> dict:
    await ensure_default(db)
    if not isinstance(b, dict):
        raise http_error(400, 'Expected an object')
    tpl = TEMPLATES.get(b.get('template') or '')
    if b.get('template') and not tpl:
        raise http_error(400, 'Unknown funnel template')
    base = {'name': tpl['name'], 'description': tpl['description'], 'stages': copy.deepcopy(tpl['stages']), 'match': tpl['match']} if tpl else {'stages': DEFAULT_STAGES}
    v = _body({**base, **{k: x for k, x in b.items() if k != 'template'}})
    id = new_id('fn')
    await db.query('insert into funnel (id, name, description, stages, match) values ($1,$2,$3,$4::jsonb,$5::jsonb)',
                   [id, v['name'], v.get('description', ''), js_json(v['stages']), js_json(v.get('match') or _match({}))])
    return await funnel_dto(db, id)


async def update_funnel(db, id: str, b: dict, actor: str = 'console') -> dict:
    cur = await get_funnel(db, id)
    if not isinstance(b, dict):
        raise http_error(400, 'Expected an object')
    v = _body(b, cur)
    remap = b.get('remap') or {}
    if not isinstance(remap, dict):
        raise http_error(400, 'remap maps a removed stage key to a stage key of the new funnel')
    moves: list[tuple[str, str]] = []
    if 'stages' in v:
        new_keys = {s['key'] for s in v['stages']}
        counts = (await _counts(db)).get(id, {})
        stranded = [s for s in cur['stages'] if s['key'] not in new_keys and counts.get(s['key'])]
        missing = [s for s in stranded if remap.get(s['key']) not in new_keys]
        if missing:
            raise http_error(409, 'These stages still hold leads; say where they go (remap): '
                             + ', '.join(f"{s['label']} ({counts[s['key']]})" for s in missing))
        moves = [(s['key'], remap[s['key']]) for s in stranded]

    async def body(t) -> None:
        sets, params = [], [id]
        for col in ('name', 'description'):
            if col in v:
                params.append(v[col])
                sets.append(f'{col} = ${len(params)}')
        for col in ('stages', 'match'):
            if col in v:
                params.append(js_json(v[col]))
                sets.append(f'{col} = ${len(params)}::jsonb')
        if sets:
            await t.query(f"update funnel set {', '.join(sets)}, updated_at = now() where id = $1", params)
        for old, new in moves:
            moved = await t.query('update lead set stage = $3, stage_at = now(), updated_at = now() where funnel_id = $1 and stage = $2 returning id', [id, old, new])
            for r in moved:
                await t.query("insert into lead_event (lead_id, type, detail, actor) values ($1, 'remap', $2::jsonb, $3)",
                              [r['id'], js_json({'from': old, 'to': new, 'funnelId': id}), actor])

    await db.tx(body)
    return await funnel_dto(db, id)


async def set_default(db, id: str) -> dict:
    await get_funnel(db, id)

    async def body(t) -> None:
        await t.query('update funnel set is_default = false where is_default and id <> $1', [id])
        await t.query('update funnel set is_default = true, updated_at = now() where id = $1', [id])

    await db.tx(body)
    return await funnel_dto(db, id)


async def delete_funnel(db, id: str, move_to: str | None) -> None:
    cur = await get_funnel(db, id)
    if cur['is_default']:
        raise http_error(400, 'The default funnel can’t be deleted; make another funnel the default first')
    n = (await db.one('select count(*)::int as n from lead where funnel_id = $1', [id]))['n']
    target = None
    if n:
        if not move_to:
            raise http_error(409, f'This funnel holds {n} leads; choose a funnel to move them to (moveTo)')
        if move_to == id:
            raise http_error(400, 'moveTo must be another funnel')
        target = await get_funnel(db, move_to)

    async def body(t) -> None:
        if target:
            for s in cur['stages']:
                dest = (stage_for(target, s['milestone']) if s['milestone'] else None) or first_stage(target)
                await t.query('update lead set funnel_id = $2, stage = $3, updated_at = now() where funnel_id = $1 and stage = $4',
                              [id, target['id'], dest['key'], s['key']])
            # Leads in a stage the funnel no longer lists start at the target's first stage.
            await t.query('update lead set funnel_id = $2, stage = $3, updated_at = now() where funnel_id = $1', [id, target['id'], first_stage(target)['key']])
        await t.query('delete from funnel where id = $1', [id])

    await db.tx(body)


# ---------- Report ----------

async def report(db, id: str, rng: str) -> dict:
    """Leads created in the range, followed through the funnel: how many reached each stage (or a later one),
    the conversion from the stage before, days to reach it, and where leads were lost."""
    f = await get_funnel(db, id)
    if rng not in ('30', '90', 'all'):
        raise http_error(400, 'range is 30, 90 or all')
    cond = '' if rng == 'all' else f"and l.created_at > now() - interval '{int(rng)} days'"
    leads = await db.query(f'select l.id, l.stage, l.source, l.created_at from lead l where l.funnel_id = $1 {cond}', [id])
    events = await db.query(
        f"""select e.lead_id, e.at, e.detail from lead_event e join lead l on l.id = e.lead_id
            where l.funnel_id = $1 {cond} and e.type in ('stage', 'remap') order by e.at""", [id])
    stages = f['stages']
    index = {s['key']: i for i, s in enumerate(stages)}
    progress = [i for i, s in enumerate(stages) if s['kind'] != 'lost']
    by_lead: dict[str, list[dict]] = {}
    for e in events:
        by_lead.setdefault(e['lead_id'], []).append(e)

    reached_any = [0] * len(stages)
    days: list[list[float]] = [[] for _ in stages]
    lost_from = [0] * len(stages)
    for ld in leads:
        evs = by_lead.get(ld['id'], [])
        visited = {ld['stage'], *(e['detail'].get('to') for e in evs), *(e['detail'].get('from') for e in evs)}
        furthest = max((index[k] for k in visited if k in index and stages[index[k]]['kind'] != 'lost'), default=None)
        if furthest is not None:
            for i in progress:
                if i <= furthest:
                    reached_any[i] += 1
        first_at: dict[str, Any] = {}
        for e in evs:
            to = e['detail'].get('to')
            if to in index and to not in first_at:
                first_at[to] = e['at']
            fr = e['detail'].get('from')
            if to in index and stages[index[to]]['kind'] == 'lost' and fr in index:
                lost_from[index[fr]] += 1
        for k, at in first_at.items():
            days[index[k]].append(max(0.0, (at - ld['created_at']).total_seconds() / 86400))
    now = {s['key']: 0 for s in stages}
    for ld in leads:
        if ld['stage'] in now:
            now[ld['stage']] += 1

    out_stages = []
    prev = None
    for i, s in enumerate(stages):
        lost = s['kind'] == 'lost'
        reached = now[s['key']] if lost else reached_any[i]
        conv = None if lost or prev is None or not reached_any[prev] else round(reached_any[i] / reached_any[prev], 3)
        out_stages.append({'key': s['key'], 'label': s['label'], 'kind': s['kind'], 'now': now[s['key']], 'reached': reached, 'conv': conv,
                           'medianDays': round(statistics.median(days[i]), 1) if days[i] else None, 'lostFrom': lost_from[i]})
        if not lost:
            prev = i
    kinds = {s['key']: s['kind'] for s in stages}
    won = sum(1 for ld in leads if kinds.get(ld['stage']) == 'won')
    lost_n = sum(1 for ld in leads if kinds.get(ld['stage']) == 'lost')
    sources: dict[str, dict] = {}
    for ld in leads:
        x = sources.setdefault(ld['source'], {'source': ld['source'], 'n': 0, 'won': 0})
        x['n'] += 1
        x['won'] += kinds.get(ld['stage']) == 'won'
    return {
        'funnel': to_dto(f, (await _counts(db)).get(id)), 'range': rng, 'cohort': len(leads), 'stages': out_stages,
        'overall': {'open': len(leads) - won - lost_n, 'won': won, 'lost': lost_n, 'winRate': round(won / (won + lost_n), 3) if won + lost_n else None},
        'sources': sorted(sources.values(), key=lambda x: -x['n']),
    }


__all__ = ['CALL_MILESTONES', 'DEFAULT_ID', 'MILESTONES', 'OUTCOME_MILESTONES', 'blocked_stages', 'create_funnel', 'delete_funnel', 'ensure_default',
           'first_stage', 'funnel_dto', 'funnel_for_lead', 'get_funnel', 'list_funnels', 'normalise_stages', 'report', 'set_default', 'stage_for',
           'stage_of', 'templates', 'update_funnel']
