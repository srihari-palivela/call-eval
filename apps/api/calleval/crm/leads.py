# The built-in CRM (on when settings.features.crm is): leads, their stage and history. Leads come from the
# console, CSV, lead finders (Apollo) and calls; campaigns call them. Outcome stages (meeting booked through
# sale) are written as lead outcomes, so attribution, the funnel and the fix-first map work exactly as with an
# external CRM. Imports backfill: a known lead's empty fields are filled, filled ones are kept.

from __future__ import annotations

import re
from typing import Any

from ..js import iso, js_json, js_number
from ..lib.errors import http_error
from ..lib.ids import new_id
from ..lib.settings import get_settings
from . import funnels as fn

CONSENT = ('opt_in', 'existing_customer', 'unknown', 'denied')
SOURCES = ('manual', 'csv', 'apollo', 'call', 'api')
FIELDS = ('first_name', 'last_name', 'phone', 'email', 'company', 'title', 'city', 'country', 'timezone', 'persona_hint', 'owner', 'notes', 'external_ref', 'apollo_id')
_E164 = re.compile(r'^\+[1-9]\d{6,14}$')
_EMAIL = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')


async def require_crm(db) -> None:
    if not (await get_settings(db))['features']['crm']:
        raise http_error(403, 'The built-in CRM is off. Turn it on in Scoring model → Settings (features.crm).')
    from .. import billing
    await billing.require_feature(db, 'crm')


def normalise_phone(v: Any) -> str | None:
    """E.164 when the number says so (+971…, 00971…); other text is kept digits-only and flagged ineligible."""
    if v is None:
        return None
    s = re.sub(r'[^\d+]', '', str(v))
    if s.startswith('00'):
        s = '+' + s[2:]
    s = s[0] + s[1:].replace('+', '') if s else s
    return s or None


def is_e164(phone: str | None) -> bool:
    return bool(phone and _E164.match(phone))


def normalise_email(v: Any) -> str | None:
    s = str(v or '').strip()
    return s.lower() if s and _EMAIL.match(s) else None


def to_dto(r: dict, hold: dict | None = None) -> dict:
    """A lead for the console; `hold` = why campaigns won't call it now (compliance.holds), when known."""
    name = ' '.join(x for x in (r.get('first_name'), r.get('last_name')) if x) or None
    return {
        'id': r['id'], 'source': r['source'], 'externalRef': r['external_ref'], 'apolloId': r['apollo_id'], 'firstName': r['first_name'], 'lastName': r['last_name'],
        'name': name, 'phone': r['phone'], 'phoneValid': is_e164(r['phone']), 'email': r['email'], 'company': r['company'], 'title': r['title'], 'city': r['city'],
        'country': r['country'], 'timezone': r['timezone'], 'personaHint': r['persona_hint'], 'funnelId': r.get('funnel_id') or fn.DEFAULT_ID, 'stage': r['stage'], 'owner': r['owner'], 'consent': r['consent'],
        'dnc': r['dnc'], 'tags': r['tags'] or [], 'notes': r['notes'], 'enrichment': r['enrichment'] or {}, 'enrichedAt': iso(r['enriched_at']),
        'callCount': r['call_count'], 'lastCalledAt': iso(r['last_called_at']), 'lastCallId': r['last_call_id'], 'createdAt': iso(r['created_at']), 'updatedAt': iso(r['updated_at']),
        'hold': hold,
    }


_IN = {'firstName': 'first_name', 'lastName': 'last_name', 'personaHint': 'persona_hint', 'externalRef': 'external_ref', 'apolloId': 'apollo_id',
       'funnelId': 'funnel_id'}


def clean_input(d: dict[str, Any]) -> dict[str, Any]:
    """Console/API/CSV input (camelCase or snake_case) → column values, validated."""
    out: dict[str, Any] = {}
    for k, v in d.items():
        col = _IN.get(k, k)
        if col == 'name' and v and not d.get('first_name') and not d.get('firstName'):
            parts = str(v).strip().split(None, 1)
            out['first_name'] = parts[0]
            if len(parts) > 1:
                out['last_name'] = parts[1]
        elif col in FIELDS:
            out[col] = None if v is None or str(v).strip() == '' else str(v).strip()[:2000]
        elif col in ('stage', 'consent', 'dnc', 'tags', 'funnel_id') and v is not None and str(v).strip() != '':
            out[col] = v.strip() if isinstance(v, str) and col in ('stage', 'consent', 'funnel_id') else v
    if 'phone' in out:
        out['phone'] = normalise_phone(out['phone'])
    if 'email' in out:
        raw = out['email']
        out['email'] = normalise_email(raw)
        if raw and not out['email']:
            raise http_error(400, f'Not an email address: {raw}')
    if out.get('consent') is not None and out['consent'] not in CONSENT:
        raise http_error(400, f"consent must be one of {', '.join(CONSENT)}")
    if 'dnc' in out:
        out['dnc'] = bool(out['dnc']) if not isinstance(out['dnc'], str) else out['dnc'].lower() in ('1', 'true', 'yes')
    if 'tags' in out:
        t = out['tags']
        out['tags'] = [s.strip() for s in (t.split(';') if isinstance(t, str) else t or []) if str(s).strip()][:30]
    return out


async def find_existing(db, v: dict[str, Any]) -> dict | None:
    if v.get('apollo_id'):
        r = await db.one('select * from lead where apollo_id = $1', [v['apollo_id']])
        if r:
            return r
    if v.get('email'):
        r = await db.one('select * from lead where lower(email) = $1', [v['email']])
        if r:
            return r
    if v.get('phone'):
        return await db.one('select * from lead where phone = $1', [v['phone']])
    return None


def _stage_in(funnel: dict, stage: str | None) -> dict | None:
    """A stage of the funnel by key, or by milestone (a CSV's "meeting_booked" in a funnel that calls it "Demo booked")."""
    if not stage:
        return None
    return fn.stage_of(funnel, stage) or fn.stage_for(funnel, stage)


def _bad_stage(funnel: dict, stage: str) -> Exception:
    return http_error(400, f"“{stage}” is not a stage of the funnel {funnel['name']} ({', '.join(s['key'] for s in funnel['stages'])})")


async def event(db, lead_id: str, type: str, detail: dict | None = None, actor: str | None = None) -> None:
    await db.query('insert into lead_event (lead_id, type, detail, actor) values ($1,$2,$3::jsonb,$4)', [lead_id, type, js_json(detail or {}), actor])


async def upsert_lead(db, data: dict[str, Any], *, source: str = 'manual', actor: str = 'console', overwrite: bool = False) -> tuple[dict, bool]:
    """Create a lead, or backfill the matching one (same Apollo id, email or phone). Returns (row, created)."""
    v = clean_input(data)
    if not any(v.get(k) for k in ('phone', 'email', 'apollo_id', 'first_name', 'company')):
        raise http_error(400, 'A lead needs at least a name, company, phone, email or Apollo id')
    cur = await find_existing(db, v)
    if cur:
        sets, params = [], [cur['id']]
        for col in FIELDS:
            if col in v and v[col] is not None and (overwrite or cur.get(col) in (None, '')):
                if v[col] != cur.get(col):
                    params.append(v[col])
                    sets.append(f'{col} = ${len(params)}')
        if v.get('tags'):
            params.append(js_json(list(dict.fromkeys([*(cur['tags'] or []), *v['tags']]))))
            sets.append(f'tags = ${len(params)}::jsonb')
        if v.get('consent') and (overwrite or cur['consent'] == 'unknown') and cur['consent'] != 'denied':
            params.append(v['consent'])
            sets.append(f'consent = ${len(params)}')
        if sets:
            await db.query(f"update lead set {', '.join(sets)}, updated_at = now() where id = $1", params)
            await event(db, cur['id'], 'backfill', {'fields': [s.split(' = ')[0] for s in sets], 'source': source}, actor)
        return await db.one('select * from lead where id = $1', [cur['id']]), False
    src = source if source in SOURCES else 'api'
    funnel = await fn.get_funnel(db, v['funnel_id']) if v.get('funnel_id') else await fn.funnel_for_lead(db, v, src)
    st = _stage_in(funnel, v.get('stage')) if v.get('stage') else fn.first_stage(funnel)
    if st is None:
        raise _bad_stage(funnel, v['stage'])
    lid = new_id('ld')
    cols = ['id', 'source', *[c for c in FIELDS if v.get(c) is not None]]
    vals = [lid, src, *[v[c] for c in FIELDS if v.get(c) is not None]]
    cols += ['funnel_id', 'stage', 'consent', 'dnc', 'tags']
    dnc = bool(v.get('dnc')) or st['milestone'] == 'dnc'
    vals += [funnel['id'], st['key'], 'denied' if st['milestone'] == 'dnc' else v.get('consent') or 'unknown', dnc, js_json(v.get('tags') or [])]
    ph = ','.join(f'${i + 1}' + ('::jsonb' if c == 'tags' else '') for i, c in enumerate(cols))
    await db.query(f"insert into lead ({','.join(cols)}, stage_at) values ({ph}, now())", vals)
    await event(db, lid, 'created', {'source': source, 'funnelId': funnel['id'], 'stage': st['key']}, actor)
    row = await db.one('select * from lead where id = $1', [lid])
    if st['milestone'] in fn.OUTCOME_MILESTONES:
        await _outcome(db, row, st['milestone'], None)
    return row, True


async def _outcome(db, lead: dict, stage: str, value_aed: float | None) -> None:
    from .outcomes import upsert_outcomes
    await upsert_outcomes(db, [{'lead_id': lead['id'], 'stage': stage, 'occurred_at': iso(lead['updated_at']), 'value_aed': value_aed,
                                'external_id': f"crm:{lead['id']}:{stage}"}], 'crm')


async def lead_funnel(db, lead: dict) -> dict:
    return await fn.get_funnel(db, lead['funnel_id']) if lead.get('funnel_id') else await fn.ensure_default(db)


async def set_stage(db, lead_id: str, stage: str, *, note: str | None = None, value_aed: Any = None, actor: str = 'console') -> dict:
    cur = await db.one('select * from lead where id = $1', [lead_id])
    if not cur:
        raise http_error(404, 'Lead not found')
    funnel = await lead_funnel(db, cur)
    st = _stage_in(funnel, stage)
    if st is None:
        raise _bad_stage(funnel, stage)
    extra = ", dnc = true, consent = 'denied'" if st['milestone'] == 'dnc' else ''
    await db.query(f'update lead set stage = $2, funnel_id = $3, stage_at = now(){extra}, updated_at = now() where id = $1', [lead_id, st['key'], funnel['id']])
    await event(db, lead_id, 'stage', {'from': cur['stage'], 'to': st['key'], **({'note': note} if note else {})}, actor)
    row = await db.one('select * from lead where id = $1', [lead_id])
    if st['milestone'] in fn.OUTCOME_MILESTONES:
        v = js_number(value_aed) if value_aed not in (None, '') else None
        await _outcome(db, row, st['milestone'], v if isinstance(v, (int, float)) and v == v else None)
    return row


async def advance(db, lead: dict, milestones: tuple[str, ...], *, note: str, actor: str) -> dict:
    """Move a lead forward to the first of these milestones its funnel has a stage for, never backwards and never
    out of a won or lost stage."""
    funnel = await lead_funnel(db, lead)
    cur = fn.stage_of(funnel, lead['stage'])
    if cur is not None and cur['kind'] != 'open':
        return lead
    order = [s['key'] for s in funnel['stages']]
    here = order.index(cur['key']) if cur is not None else -1
    for m in milestones:
        target = fn.stage_for(funnel, m)
        if target is not None:
            return await set_stage(db, lead['id'], target['key'], note=note, actor=actor) if order.index(target['key']) > here else lead
    return lead


async def move_to_funnel(db, lead_id: str, funnel_id: str, actor: str = 'console') -> dict:
    """Move a lead to another funnel, keeping its milestone where the new funnel has it, else its first stage."""
    cur = await db.one('select * from lead where id = $1', [lead_id])
    if not cur:
        raise http_error(404, 'Lead not found')
    old, new = await lead_funnel(db, cur), await fn.get_funnel(db, funnel_id)
    if old['id'] == new['id']:
        return cur
    st = fn.stage_of(old, cur['stage'])
    dest = (fn.stage_for(new, st['milestone']) if st and st['milestone'] else None) or fn.first_stage(new)
    await db.query('update lead set funnel_id = $2, stage = $3, stage_at = now(), updated_at = now() where id = $1', [lead_id, new['id'], dest['key']])
    await event(db, lead_id, 'funnel', {'from': old['id'], 'to': new['id'], 'stage': dest['key']}, actor)
    return await db.one('select * from lead where id = $1', [lead_id])


async def update_lead(db, lead_id: str, patch: dict[str, Any], actor: str = 'console') -> dict:
    cur = await db.one('select * from lead where id = $1', [lead_id])
    if not cur:
        raise http_error(404, 'Lead not found')
    v = clean_input(patch)
    stage = v.pop('stage', None)
    funnel_id = v.pop('funnel_id', None)
    if funnel_id and funnel_id != (cur['funnel_id'] or ''):
        cur = await move_to_funnel(db, lead_id, funnel_id, actor)
    sets, params = [], [lead_id]
    for col in (*FIELDS, 'consent', 'dnc'):
        if col in v:
            params.append(v[col])
            sets.append(f'{col} = ${len(params)}')
    if 'tags' in v:
        params.append(js_json(v['tags']))
        sets.append(f'tags = ${len(params)}::jsonb')
    if sets:
        try:
            await db.query(f"update lead set {', '.join(sets)}, updated_at = now() where id = $1", params)
        except Exception as e:
            if 'lead_email_idx' in str(e) or 'lead_phone_idx' in str(e):
                raise http_error(400, 'Another lead already has this email or phone') from e
            raise
        await event(db, lead_id, 'edit', {'fields': [s.split(' = ')[0] for s in sets]}, actor)
    if stage and stage != cur['stage']:
        return await set_stage(db, lead_id, stage, actor=actor)
    return await db.one('select * from lead where id = $1', [lead_id])


def eligibility_sql(allow_unknown_consent: bool, max_attempts: int, blocked: list[str]) -> str:
    """Leads a campaign may call: a valid E.164 number, not DNC, consent given (or unknown when allowed),
    not past the attempt limit, and in a stage its funnel lets campaigns call (`blocked` from funnels.blocked_stages)."""
    consents = "('opt_in','existing_customer','unknown')" if allow_unknown_consent else "('opt_in','existing_customer')"
    # Funnel ids and stage keys are validated identifiers; quotes are doubled all the same.
    closed = ','.join("'" + b.replace("'", "''") + "'" for b in blocked)
    return (f"l.phone ~ '^\\+[1-9][0-9]{{6,14}}$' and not l.dnc and l.consent in {consents} and l.call_count < {int(max_attempts)}"
            + (f" and (l.funnel_id || ':' || l.stage) not in ({closed})" if closed else ''))


async def list_leads(db, q: dict[str, str]) -> dict:
    conds, params = ['true'], []

    def p(v: Any) -> str:
        params.append(v)
        return f'${len(params)}'

    if q.get('q'):
        like = f"%{re.sub(r'[%_]', '', q['q'])}%"
        ph = p(like)
        conds.append(f"(coalesce(l.first_name,'') || ' ' || coalesce(l.last_name,'') ilike {ph} or l.email ilike {ph} or l.phone ilike {ph} or l.company ilike {ph} or l.title ilike {ph})")
    funnel = await fn.get_funnel(db, q['funnel']) if q.get('funnel') else await fn.ensure_default(db)
    conds.append(f"l.funnel_id = {p(funnel['id'])}")
    for k in ('stage', 'source', 'consent', 'owner'):
        if q.get(k):
            conds.append(f'l.{k} = {p(q[k])}')
    if q.get('dnc') in ('true', 'false'):
        conds.append('l.dnc' if q['dnc'] == 'true' else 'not l.dnc')
    if q.get('eligible') == 'true':
        from ..business import get_business
        c = (await get_business(db))['calling']
        conds.append(eligibility_sql(c['allowUnknownConsent'], c['maxAttemptsPerLead'], await fn.blocked_stages(db)))
    if q.get('needsEnrichment') == 'true':
        conds.append("(l.phone is null or l.email is null) and l.apollo_id is not null")
    sort = {'name': 'l.first_name asc nulls last, l.last_name asc nulls last', 'updated': 'l.updated_at desc', 'called': 'l.last_called_at desc nulls last',
            'stage': 'l.stage asc, l.updated_at desc'}.get(q.get('sort') or '', 'l.created_at desc')
    limit = min(500, max(1, int(js_number(q.get('limit') or 50) or 50)))
    offset = max(0, int(js_number(q.get('offset') or 0) or 0))
    where = ' and '.join(conds)
    total = (await db.one(f'select count(*)::int as n from lead l where {where}', params))['n']
    rows = await db.query(f'select l.* from lead l where {where} order by {sort} limit {limit} offset {offset}', params)
    counts = {r['stage']: r['n'] for r in await db.query('select stage, count(*)::int as n from lead where funnel_id = $1 group by stage', [funnel['id']])}
    from ..compliance import holds
    held = await holds(db, rows)
    return {'items': [to_dto(r, held.get(r['id'])) for r in rows], 'total': total, 'stages': {s['key']: counts.get(s['key'], 0) for s in funnel['stages']},
            'funnel': fn.to_dto(funnel, counts)}


async def lead_detail(db, lead_id: str) -> dict:
    from ..compliance import holds
    r = await db.one('select * from lead where id = $1', [lead_id])
    if not r:
        raise http_error(404, 'Lead not found')
    events = await db.query('select at, type, detail, actor from lead_event where lead_id = $1 order by at desc, id desc limit 200', [lead_id])
    calls = await db.query(
        """select call_id, started_at, duration_s, direction, persona, scenario, cqs, band, next_step, status from calls
           where lead_id = $1 order by started_at desc limit 50""", [lead_id])
    outcomes = await db.query('select stage, occurred_at, value_aed, credited_call_id from lead_outcome where lead_id = $1 order by occurred_at', [lead_id])
    return {
        **to_dto(r, (await holds(db, [r])).get(r['id'])),
        'events': [{'at': iso(e['at']), 'type': e['type'], 'detail': e['detail'], 'actor': e['actor']} for e in events],
        'calls': [{'id': c['call_id'], 'startedAt': iso(c['started_at']), 'durationS': c['duration_s'], 'direction': c['direction'], 'persona': c['persona'],
                   'scenario': c['scenario'], 'cqs': None if c['cqs'] is None else round(c['cqs']), 'band': c['band'], 'nextStep': c['next_step'], 'status': c['status']}
                  for c in calls],
        'outcomes': [{'stage': o['stage'], 'at': iso(o['occurred_at']), 'valueAed': o['value_aed'], 'creditedCallId': o['credited_call_id']} for o in outcomes],
    }


async def delete_lead(db, lead_id: str) -> None:
    await db.query('delete from lead_event where lead_id = $1', [lead_id])
    await db.query('delete from lead where id = $1', [lead_id])


async def import_csv(db, text: str, actor: str = 'console') -> dict:
    from .outcomes import parse_csv
    created = updated = skipped = 0
    errors: list[str] = []
    for i, row in enumerate(parse_csv(text)):
        data = {k.replace(' ', '_'): v for k, v in row.items()}
        if 'external_id' in data:
            data['external_ref'] = data.pop('external_id')
        try:
            _, was_created = await upsert_lead(db, data, source='csv', actor=actor)
            created += was_created
            updated += not was_created
        except Exception as e:  # noqa: BLE001 - one bad row is reported, the rest import
            skipped += 1
            if len(errors) < 20:
                errors.append(f'row {i + 2}: {getattr(e, "message", str(e))}')
    return {'created': created, 'updated': updated, 'skipped': skipped, 'errors': errors}


async def after_call(db, call_id: str) -> dict | None:
    """Bring a CRM lead up to date after one of its calls is scored (once per call): count the attempt,
    move the stage forward (contacted → qualified → meeting booked), and honour a refusal (lost; never called
    again) or a do-not-contact request (do not contact)."""
    if not (await get_settings(db))['features']['crm']:
        return None
    c = await db.one('select call_id, lead_id, started_at, next_step, qualified, persona, persona_path, scenario from calls where call_id = $1', [call_id])
    if not c or not c['lead_id']:
        return None
    lead = await db.one('select * from lead where id = $1', [c['lead_id']])
    if not lead:
        return None
    first_time = not await db.one("select 1 from lead_event where lead_id = $1 and type = 'call' and detail->>'callId' = $2", [lead['id'], call_id])
    if first_time:
        await db.query(
            """update lead set call_count = call_count + 1, last_called_at = greatest(coalesce(last_called_at, $2::timestamptz), $2::timestamptz),
                 last_call_id = $3, persona_hint = coalesce(persona_hint, $4), updated_at = now() where id = $1""",
            [lead['id'], c['started_at'], call_id, c['persona'] if c['persona_path'] in ('Investor', 'Broker') else None])
        await event(db, lead['id'], 'call', {'callId': call_id, 'nextStep': c['next_step'], 'qualified': c['qualified']}, 'pipeline')
    dnc = await db.one("select 1 from call_event where call_id = $1 and type = 'dnc_request'", [call_id])
    # A refusal (a not-interested call) or a do-not-contact request: never called again.
    from ..taxonomy import basis
    if dnc or basis(c['scenario']) == 'S10':
        await db.query('update lead set refused_at = coalesce(refused_at, $2::timestamptz), updated_at = now() where id = $1', [lead['id'], c['started_at']])
    if dnc and not lead['dnc']:
        return await set_stage(db, lead['id'], 'dnc', note='Asked not to be contacted on a call', actor='pipeline')
    if basis(c['scenario']) == 'S10':
        funnel = await lead_funnel(db, lead)
        cur, lost = fn.stage_of(funnel, lead['stage']), fn.stage_for(funnel, 'lost')
        if lost and (cur is None or cur['kind'] == 'open'):
            return await set_stage(db, lead['id'], lost['key'], note='Declined on a call', actor='pipeline')
        return await db.one('select * from lead where id = $1', [lead['id']])
    # As far as the call got, falling back to an earlier milestone when the funnel has no stage for it.
    reached = fn.CALL_MILESTONES[fn.CALL_MILESTONES.index('meeting_booked' if c['next_step'] == 'meeting' else 'qualified' if c['qualified'] else 'contacted'):]
    return await advance(db, lead, reached, note=f'From call {call_id}', actor='pipeline')
