# Taxonomy versions in the database. A change is made in a draft (a copy of the active version, or a template),
# checked as a whole on every save, and activated in one step: the previous version is retired, never edited,
# so calls keep the definitions they were classified under. Activation can queue recent calls for re-scoring.

from __future__ import annotations

import copy
import re
from typing import Any

from ..framework import P0, TOOL_MAP
from ..jobs.queue import job_events
from ..js import UNDEFINED, iso, js_json
from ..lib.errors import http_error
from . import active
from .active import _natural, normalise_entry
from .catalogue import (BUILTIN_EVENTS, BUILTIN_PERSONAS, BUILTIN_SCENARIOS, DEFAULT_DOMAIN, EVENT_GROUPS, FACETS, PERSONA_PATHS, RULE_IDS, RULES,
                        SYSTEM_EVENTS, TAXONOMY_VERSION, builtin_doc, template_doc, templates)

KINDS = {'persona': 'personas', 'scenario': 'scenarios', 'event': 'events'}
FIELDS = {
    'persona': ('name', 'path', 'signals', 'watch', 'checkLabel', 'basedOn', 'keywords'),
    'scenario': ('name', 'short', 'trigger', 'path', 'success', 'basedOn', 'keywords', 'checkpoints'),
    'event': ('label', 'group', 'basedOn', 'keywords'),
}
LIMITS = {'persona': 40, 'scenario': 40, 'event': 80}
RESCORE_LIMIT = 5000
_ID = {'persona': re.compile(r'^P[1-9]\d{0,2}$'), 'scenario': re.compile(r'^S[1-9]\d{0,2}$'), 'event': re.compile(r'^[a-z][a-z0-9_]{1,47}$')}
_SLUG = re.compile(r'^[a-z][a-z0-9_]{0,39}$')
_TOOL = re.compile(r'^[A-Za-z0-9_.:-]{1,64}$')


def _slug(s: str, n: int = 40) -> str:
    out = re.sub(r'[^a-z0-9]+', '_', s.lower()).strip('_')[:n].strip('_')
    return out if out and out[0].isalpha() else f'x_{out}'[:n]


# ---------- Reading ----------

async def seed(db) -> None:
    """Taxonomy v1.0, seeded once so versions can be added alongside it."""
    if await db.one('select 1 from taxonomy_version limit 1'):
        return

    async def body(t) -> None:
        await t.query(
            """insert into taxonomy_version (version, status, approved_by, approved_at, notes, domain)
               values ($1, 'active', 'framework', now(), 'Taxonomy v1.0 from the Call Evaluation Framework; a draft for the sales team to confirm.', $2)""",
            [TAXONOMY_VERSION, DEFAULT_DOMAIN])
        await _write_rows(t, TAXONOMY_VERSION, builtin_doc())
        for i, f in enumerate(FACETS):
            await t.query("insert into taxonomy (tag_id, version, kind, name, definition, active_from, ord) values ($1,$2,'facet',$3,$4::jsonb, now(), $5)",
                          [f['id'], TAXONOMY_VERSION, f['name'], js_json(f), i])

    await db.tx(body)


async def _write_rows(t, version: str, doc: dict) -> None:
    await t.query("delete from taxonomy where version = $1 and kind in ('persona','scenario','event')", [version])
    rows = [('persona', e['id'], e['name'], e) for e in doc['personas']] + [('scenario', e['id'], e['name'], e) for e in doc['scenarios']] \
        + [('event', e['id'], e['label'], e) for e in doc['events']]
    if not rows:
        return
    ph, params = [], []
    for i, (kind, id, name, d) in enumerate(rows):
        params += [id, version, kind, name, js_json(d), i]
        n = len(params)
        ph.append(f'(${n - 5},${n - 4},${n - 3},${n - 2},${n - 1}::jsonb,${n})')
    await t.query(f"insert into taxonomy (tag_id, version, kind, name, definition, ord) values {','.join(ph)}", params)


async def read_doc(db, version: str) -> dict:
    rows = await db.query("select tag_id, kind, definition, ord from taxonomy where version = $1 and kind in ('persona','scenario','event')", [version])
    doc: dict[str, Any] = {'personas': [], 'scenarios': [], 'events': []}
    for r in sorted(rows, key=lambda r: (r['ord'], _natural(r['tag_id']))):
        if r['tag_id'] == 'P0':
            continue
        doc[KINDS[r['kind']]].append(normalise_entry(r['kind'], {**r['definition'], 'id': r['tag_id']}))
    return doc


def _doc_dto(v: dict, doc: dict) -> dict:
    return {'version': v['version'], 'status': v['status'], 'domain': v.get('domain') or DEFAULT_DOMAIN, 'personas': doc['personas'], 'p0': P0,
            'scenarios': doc['scenarios'], 'events': doc['events'], 'facets': FACETS, 'notes': v.get('notes'), 'createdAt': iso(v['created_at']),
            'approvedAt': iso(v.get('approved_at'))}


async def _version(db, status: str) -> dict | None:
    return await db.one('select * from taxonomy_version where status = $1 order by created_at desc limit 1', [status])


async def usage(db) -> dict:
    rows = await db.query(
        """select 'persona' as k, persona as id, count(*)::int as n from calls where status = 'scored' and started_at > now() - interval '90 days' and persona is not null group by persona
           union all
           select 'scenario', scenario, count(*)::int from calls where status = 'scored' and started_at > now() - interval '90 days' and scenario is not null group by scenario""")
    return {'personas': {r['id']: r['n'] for r in rows if r['k'] == 'persona'}, 'scenarios': {r['id']: r['n'] for r in rows if r['k'] == 'scenario'}}


async def known_tools(db) -> list[str]:
    """The framework's tools plus every tool name seen on recent calls (custom agents have their own)."""
    seen = await db.query(
        """select distinct tc->>'name' as name from (select canonical from calls where canonical is not null order by started_at desc limit 300) c,
             jsonb_array_elements(coalesce(c.canonical->'toolCalls', '[]'::jsonb)) tc""")
    return sorted({t['name'] for t in TOOL_MAP} | {r['name'] for r in seen if r['name']})


def _name(e: dict) -> str:
    return e.get('name') or e.get('label') or e['id']


def diff(act: dict, draft: dict, use: dict) -> dict:
    out: dict[str, Any] = {'added': [], 'changed': [], 'retired': [], 'domainChanged': (act.get('domain') or '') != (draft.get('domain') or '')}
    for kind, key in KINDS.items():
        a = {e['id']: e for e in act[key]}
        d = {e['id']: e for e in draft[key]}
        for id, e in d.items():
            if id not in a:
                out['added'].append({'kind': kind, 'id': id, 'name': _name(e)})
            else:
                fields = [f for f in FIELDS[kind] if a[id].get(f) != e.get(f)]
                if fields:
                    out['changed'].append({'kind': kind, 'id': id, 'name': _name(e), 'fields': fields})
        for id, e in a.items():
            if id not in d:
                out['retired'].append({'kind': kind, 'id': id, 'name': _name(e), 'calls': use.get(key, {}).get(id, 0)})
    return out


async def taxonomy_dto(db) -> dict:
    from ..config import llm_enabled
    await seed(db)
    av = await _version(db, 'active')
    act = {**await read_doc(db, av['version']), 'domain': av.get('domain') or DEFAULT_DOMAIN}
    dv = await _version(db, 'draft')
    draft = {**await read_doc(db, dv['version']), 'domain': dv.get('domain') or DEFAULT_DOMAIN} if dv else None
    use = await usage(db)
    versions = await db.query("select version, status, approved_at, notes, created_at from taxonomy_version order by created_at")
    return {
        'active': _doc_dto(av, act),
        'draft': _doc_dto(dv, draft) if dv and draft else None,
        'diff': diff(act, draft, use) if draft else None,
        'versions': [{'version': v['version'], 'status': v['status'], 'approvedAt': iso(v['approved_at']), 'notes': v['notes'], 'createdAt': iso(v['created_at'])}
                     for v in versions],
        # The framework's entries with their checkpoints, so the editor can copy a built-in path.
        'builtins': {k: builtin_doc()[k] for k in ('personas', 'scenarios', 'events')},
        'rules': RULES,
        'tools': await known_tools(db),
        'templates': templates(),
        'usage': use,
        'copilot': llm_enabled(),
    }


# ---------- Validation ----------

def _what(kind: str, i: int, name: Any) -> str:
    return f'{kind} {i + 1} ({name})' if name else f'{kind} {i + 1}'


def normalise_doc(body: dict, known: dict[str, set[str]]) -> dict:
    """Check a whole document and fill what can be filled (short names, path text, new ids). `known` holds the ids every
    version has used, so a new entry never takes the id of a retired one. Raises 400 listing the problems."""
    errs: list[str] = []
    if not isinstance(body, dict):
        raise http_error(400, 'Expected a taxonomy document')

    def text(v: Any, n: int, what: str, required: bool = False) -> str:
        s = v.strip() if isinstance(v, str) else '' if v is None else str(v).strip()
        if required and not s:
            errs.append(f'{what} is required')
        if len(s) > n:
            errs.append(f'{what} is longer than {n} characters')
        return s[:n]

    def keywords(v: Any, what: str) -> list[str]:
        if v is None:
            return []
        if not isinstance(v, list):
            errs.append(f'{what}: keywords must be a list')
            return []
        out = list(dict.fromkeys(str(x).strip().lower() for x in v if str(x).strip()))
        if len(out) > 30 or any(len(x) > 60 for x in out):
            errs.append(f'{what}: up to 30 keywords of up to 60 characters')
        return out[:30]

    def entries(kind: str) -> list[dict]:
        v = body.get(KINDS[kind])
        if not isinstance(v, list) or not all(isinstance(x, dict) for x in v):
            errs.append(f'{KINDS[kind]} must be a list of objects')
            return []
        if len(v) > LIMITS[kind]:
            errs.append(f'At most {LIMITS[kind]} {KINDS[kind]}')
        return v

    def ident(kind: str, e: dict, what: str, seen: set[str]) -> str:
        id = str(e.get('id') or '').strip()
        if id and not _ID[kind].match(id):
            errs.append(f'{what}: id "{id}" is not a valid {kind} id')
        if id and id in seen:
            errs.append(f'{what}: id {id} is used twice')
        seen.add(id)
        return id

    def unique_names(kind: str, xs: list[dict], key: str) -> None:
        names = [x[key].lower() for x in xs if x[key]]
        for n in sorted({n for n in names if names.count(n) > 1}):
            errs.append(f'Two {KINDS[kind]} are called “{n}”')

    seen_p: set[str] = set()
    personas = []
    for i, e in enumerate(entries('persona')):
        if str(e.get('id') or '') == 'P0':
            continue
        what = _what('Persona', i, e.get('name'))
        p = {'id': ident('persona', e, what, seen_p), 'name': text(e.get('name'), 80, f'{what}: name', True),
             'path': e.get('path'), 'signals': text(e.get('signals'), 500, f'{what}: signals'), 'watch': text(e.get('watch'), 500, f'{what}: watch for'),
             'checkLabel': text(e.get('checkLabel'), 120, f'{what}: check'), 'basedOn': e.get('basedOn') or None, 'keywords': keywords(e.get('keywords'), what)}
        if p['path'] not in PERSONA_PATHS:
            errs.append(f"{what}: path must be {', '.join(PERSONA_PATHS)}")
        if p['basedOn'] is not None and p['basedOn'] not in BUILTIN_PERSONAS:
            errs.append(f'{what}: basedOn must be a framework persona (P1–P11) or empty')
        personas.append(p)
    unique_names('persona', personas, 'name')

    seen_s: set[str] = set()
    scenarios = []
    for i, e in enumerate(entries('scenario')):
        what = _what('Scenario', i, e.get('name'))
        cps = []
        raw_cps = e.get('checkpoints') if e.get('checkpoints') is not None else []
        if not isinstance(raw_cps, list) or len(raw_cps) > 10:
            errs.append(f'{what}: checkpoints must be a list of at most 10')
            raw_cps = []
        cp_ids: set[str] = set()
        for j, c in enumerate(raw_cps):
            cw = f'{what}, checkpoint {j + 1}'
            if not isinstance(c, dict):
                errs.append(f'{cw} must be an object')
                continue
            label = text(c.get('label'), 80, f'{cw}: label', True)
            cid = str(c.get('id') or '').strip() or (_slug(label) if label else '')
            if cid and not _SLUG.match(cid):
                errs.append(f'{cw}: id must be lower-case letters, digits and _')
            if cid in cp_ids:
                cid = f'{cid}_{j + 1}'[:40]
            cp_ids.add(cid)
            det = c.get('detect') if isinstance(c.get('detect'), dict) else {}
            by = det.get('by')
            if by == 'tool':
                tools = [str(t).strip() for t in det.get('tools') or [] if str(t).strip()]
                if not tools or len(tools) > 5 or any(not _TOOL.match(t) for t in tools):
                    errs.append(f'{cw}: a tool checkpoint names 1–5 tools')
                detect: dict = {'by': 'tool', 'tools': tools}
            elif by == 'rule':
                if det.get('rule') not in RULE_IDS:
                    errs.append(f"{cw}: rule must be one of {', '.join(sorted(RULE_IDS))}")
                detect = {'by': 'rule', 'rule': det.get('rule')}
            elif by == 'judge':
                detect = {'by': 'judge'}
            else:
                errs.append(f'{cw}: detect.by must be judge, tool or rule')
                detect = {'by': 'judge'}
            cp = {'id': cid, 'label': label, 'detect': detect}
            hint = text(c.get('hint'), 300, f'{cw}: hint')
            if hint:
                cp['hint'] = hint
            cps.append(cp)
        name = text(e.get('name'), 80, f'{what}: name', True)
        s = {'id': ident('scenario', e, what, seen_s), 'name': name, 'short': text(e.get('short'), 24, f'{what}: short name') or name[:24],
             'trigger': text(e.get('trigger'), 500, f'{what}: trigger'), 'path': text(e.get('path'), 500, f'{what}: expected path') or ' → '.join(c['label'] for c in cps),
             'success': text(e.get('success'), 500, f'{what}: success'), 'basedOn': e.get('basedOn') or None, 'keywords': keywords(e.get('keywords'), what),
             'checkpoints': cps}
        if s['basedOn'] is not None and s['basedOn'] not in BUILTIN_SCENARIOS:
            errs.append(f'{what}: basedOn must be a framework scenario (S1–S12) or empty')
        scenarios.append(s)
    unique_names('scenario', scenarios, 'name')

    seen_e: set[str] = set()
    events = []
    raw_events = entries('event')
    explicit = {str(e.get('id')) for e in raw_events if e.get('id')}
    for i, e in enumerate(raw_events):
        what = _what('Event', i, e.get('label'))
        label = text(e.get('label'), 80, f'{what}: label', True)
        id = ident('event', e, what, seen_e) or (_slug(label) if label else '')
        while not e.get('id') and (id in seen_e or id in explicit):
            id = f'{id}_2'[:48]
        seen_e.add(id)
        ev = {'id': id, 'label': label, 'group': e.get('group'), 'basedOn': e.get('basedOn') or None, 'keywords': keywords(e.get('keywords'), what),
              'system': id in SYSTEM_EVENTS}
        if id in SYSTEM_EVENTS:
            ev.update({'group': BUILTIN_EVENTS[id]['group'], 'basedOn': id})
        elif ev['group'] not in EVENT_GROUPS:
            errs.append(f"{what}: group must be one of {', '.join(EVENT_GROUPS)}")
        if ev['basedOn'] is not None and ev['basedOn'] not in BUILTIN_EVENTS:
            errs.append(f'{what}: basedOn must be a framework event or empty')
        events.append(ev)
    # Code still raises the system events, so every version keeps them.
    for sid in SYSTEM_EVENTS:
        if sid not in seen_e:
            events.append({**BUILTIN_EVENTS[sid], 'basedOn': sid, 'keywords': [], 'system': True})
    unique_names('event', events, 'label')

    if not personas:
        errs.append('At least one persona is needed')
    if not scenarios:
        errs.append('At least one scenario is needed')
    domain = text(body.get('domain'), 600, 'Domain') or DEFAULT_DOMAIN
    if errs:
        raise http_error(400, 'The taxonomy has problems: ' + '; '.join(dict.fromkeys(errs[:12])))

    # New entries get the next free id; ids retired in earlier versions are never reused.
    def assign(xs: list[dict], prefix: str, kind: str) -> None:
        used = known.get(kind, set()) | {x['id'] for x in xs if x['id']}
        n = max([int(i[1:]) for i in used if re.match(rf'^{prefix}\d+$', i)] or [0])
        for x in xs:
            if not x['id']:
                n += 1
                x['id'] = f'{prefix}{n}'
    assign(personas, 'P', 'persona')
    assign(scenarios, 'S', 'scenario')
    return {'domain': domain, 'personas': personas, 'scenarios': scenarios, 'events': events}


async def known_ids(db) -> dict[str, set[str]]:
    rows = await db.query("select distinct kind, tag_id from taxonomy where kind in ('persona','scenario','event')")
    out: dict[str, set[str]] = {'persona': set(BUILTIN_PERSONAS), 'scenario': set(BUILTIN_SCENARIOS), 'event': set(BUILTIN_EVENTS)}
    for r in rows:
        out[r['kind']].add(r['tag_id'])
    return out


# ---------- Drafts ----------

def _next_version(existing: list[str], major_bump: bool) -> str:
    nums = [tuple(int(x) for x in v.split('.')) for v in existing if re.match(r'^\d+\.\d+$', v)]
    major = max((n[0] for n in nums), default=1)
    if major_bump:
        return f'{major + 1}.0'
    return f'{major}.{max((n[1] for n in nums if n[0] == major), default=-1) + 1}'


async def create_draft(db, source: str = 'active', replace: bool = False) -> dict:
    await seed(db)
    if source != 'active' and template_doc(source) is None:
        raise http_error(400, 'from must be "active" or a template id')
    cur = await _version(db, 'draft')
    if cur and not replace:
        raise http_error(409, f"Draft v{cur['version']} already exists; edit it, or discard it first")
    av = await _version(db, 'active')
    if source == 'active':
        doc = {**await read_doc(db, av['version']), 'domain': av.get('domain') or DEFAULT_DOMAIN}
    else:
        doc = template_doc(source)
    doc = normalise_doc(copy.deepcopy(doc), await known_ids(db)) if source != 'active' else doc

    async def body(t) -> None:
        if cur:
            await t.query('delete from taxonomy where version = $1', [cur['version']])
            await t.query('delete from taxonomy_version where version = $1', [cur['version']])
        existing = [r['version'] for r in await t.query('select version from taxonomy_version')]
        version = _next_version(existing, major_bump=source != 'active')
        notes = 'Draft from the active version' if source == 'active' else f'Draft from the template “{source}”'
        await t.query("insert into taxonomy_version (version, status, notes, domain) values ($1, 'draft', $2, $3)", [version, notes, doc['domain']])
        await _write_rows(t, version, doc)

    await db.tx(body)
    return await taxonomy_dto(db)


async def save_draft(db, body: dict) -> dict:
    dv = await _version(db, 'draft')
    if not dv:
        raise http_error(404, 'There is no draft; create one first')
    doc = normalise_doc(body, await known_ids(db))

    async def write(t) -> None:
        await t.query('update taxonomy_version set domain = $2 where version = $1', [dv['version'], doc['domain']])
        await _write_rows(t, dv['version'], doc)

    await db.tx(write)
    return await taxonomy_dto(db)


def apply_to_doc(doc: dict, ops: Any) -> dict:
    """A copy of the document with the operations applied in order (not yet checked as a whole)."""
    if not isinstance(ops, list) or not all(isinstance(o, dict) for o in ops):
        raise http_error(400, 'operations must be a list')
    doc = copy.deepcopy(doc)
    for i, o in enumerate(ops):
        kind, op = o.get('kind'), o.get('op')
        if kind not in KINDS or op not in ('add', 'update', 'retire'):
            raise http_error(400, f'Operation {i + 1}: op must be add, update or retire and kind persona, scenario or event')
        xs = doc[KINDS[kind]]
        entry = {k: v for k, v in (o.get('entry') or {}).items() if k in FIELDS[kind]}
        if op == 'add':
            xs.append({**entry, 'id': ''})
            continue
        idx = next((j for j, x in enumerate(xs) if x['id'] == o.get('id')), None)
        if idx is None:
            raise http_error(400, f"Operation {i + 1}: there is no {kind} {o.get('id')} in the draft")
        if op == 'update':
            xs[idx] = {**xs[idx], **entry}
        elif kind == 'event' and xs[idx]['id'] in SYSTEM_EVENTS:
            raise http_error(400, f"Operation {i + 1}: {xs[idx]['id']} is detected by code and can’t be retired")
        else:
            xs.pop(idx)
    return doc


async def working_doc(db) -> dict:
    """The draft if there is one, else the active version: what the next change starts from."""
    v = await _version(db, 'draft') or await _version(db, 'active')
    return {**await read_doc(db, v['version']), 'domain': v.get('domain') or DEFAULT_DOMAIN}


async def apply_ops(db, ops: Any, domain: Any = UNDEFINED) -> dict:
    """Apply proposed operations (from the co-pilot, after a person picked them) to the draft, creating it if needed."""
    if not isinstance(ops, list):
        raise http_error(400, 'operations must be a list')
    if not await _version(db, 'draft'):
        await create_draft(db, 'active')
    doc = apply_to_doc(await working_doc(db), ops)
    if isinstance(domain, str) and domain.strip():
        doc['domain'] = domain
    return await save_draft(db, doc)


async def discard_draft(db) -> dict:
    dv = await _version(db, 'draft')
    if dv:
        async def body(t) -> None:
            await t.query('delete from taxonomy where version = $1', [dv['version']])
            await t.query('delete from taxonomy_version where version = $1', [dv['version']])
        await db.tx(body)
    return await taxonomy_dto(db)


async def activate(db, notes: Any = None, rescore_days: Any = 0, by: str = 'console') -> dict:
    dv = await _version(db, 'draft')
    if not dv:
        raise http_error(404, 'There is no draft to activate')
    if rescore_days not in (None, 0, 7, 30, 90):
        raise http_error(400, 'rescoreDays is 0, 7, 30 or 90')
    # Check the draft once more as a whole (it may predate a rule change).
    doc = normalise_doc({**await read_doc(db, dv['version']), 'domain': dv.get('domain')}, await known_ids(db))

    async def body(t) -> None:
        await _write_rows(t, dv['version'], doc)
        await t.query("update taxonomy set active_to = now() where version in (select version from taxonomy_version where status = 'active')")
        await t.query("update taxonomy_version set status = 'retired' where status = 'active'")
        await t.query("update taxonomy_version set status = 'active', approved_by = $3, approved_at = now(), notes = coalesce($2, notes) where version = $1",
                      [dv['version'], str(notes).strip()[:1000] if isinstance(notes, str) and notes.strip() else None, by])
        await t.query('update taxonomy set active_from = now() where version = $1', [dv['version']])

    await db.tx(body)
    await active.load(db)
    from ..business import drop_retired_ids
    await drop_retired_ids(db)
    n = await rescore(db, int(rescore_days or 0)) if rescore_days else 0
    return {'version': dv['version'], 'rescoring': n}


async def rescore(db, days: int) -> int:
    """Queue scored calls from the last `days` days for re-scoring under the active version (newest first)."""
    rows = await db.query(
        f"""insert into job (id, kind, payload, priority, run_after, dedupe_key, max_attempts)
            select 'job_' || substr(md5(random()::text || c.call_id), 1, 12), 'evaluate_call',
                   jsonb_build_object('callId', c.call_id, 'reason', 'taxonomy'), 1, now(), 'eval:' || c.call_id, 5
            from (select call_id from calls where status = 'scored' and purged_at is null and started_at > now() - ($1::int * interval '1 day')
                  order by started_at desc limit {RESCORE_LIMIT}) c
            on conflict do nothing returning id""", [days])
    if rows:
        job_events.emit()
    return len(rows)
