# Co-pilot: Claude drafts a business profile, taxonomy changes or a lead funnel as a proposal. Nothing changes
# until a person applies it (PUT /api/business, POST /api/taxonomy/draft/apply, POST or PUT /api/crm/funnels),
# and every proposal is run through the same checks as a manual edit before it is shown, so what the console
# offers to apply is what will be accepted.

from __future__ import annotations

import copy
from typing import Any
from urllib.parse import urlparse

import anthropic

from . import billing
from .business import SENIORITIES, get_business, merge_business
from .config import llm_enabled
from .crm import funnels as fn
from .js import js_json
from .lib.claude import request_json
from .lib.errors import HttpStatusError, http_error
from .lib.log import log
from .taxonomy import current
from .taxonomy import store as tx
from .taxonomy.catalogue import BUILTIN_EVENTS, BUILTIN_PERSONAS, BUILTIN_SCENARIOS, EVENT_GROUPS, PERSONA_PATHS, RULE_IDS, SYSTEM_EVENTS

STR: dict = {'type': 'string'}
STRS: dict = {'type': 'array', 'items': STR}
SECTIONS = ('company', 'icp', 'goals', 'calling')
EMPLOYEE_RANGES = ['1,10', '11,20', '21,50', '51,100', '101,200', '201,500', '501,1000', '1001,2000', '2001,5000', '5001,10000', '10001,1000000']


def require_copilot() -> None:
    if not llm_enabled():
        raise http_error(400, 'The co-pilot needs a Claude API key (set ANTHROPIC_API_KEY).')


def _obj(props: dict) -> dict:
    return {'type': 'object', 'additionalProperties': False, 'required': list(props), 'properties': props}


def _enum(values: list[str]) -> dict:
    return {'type': 'string', 'enum': values}


def _usage(r: dict) -> dict:
    return {'inputTokens': r['usage']['input'], 'outputTokens': r['usage']['output'], 'model': r['model']}


def _taxonomy_lines() -> str:
    t = current()
    return '\n'.join([*(f"- {p['id']} {p['name']} ({p['path']} path)" for p in t.personas), *(f"- {s['id']} {s['name']}" for s in t.scenarios)])


# ---------- Business profile ----------

BUSINESS_SYSTEM = """You help a sales team set up an AI voice-agent platform: it calls and answers leads, scores every call, finds new leads
in Apollo.io from an ideal customer profile, and runs calling campaigns inside set hours. From what the team tells you about their
business (and their website, when given) you draft their business profile. A person reviews every field before anything is saved.

Draft only what the information supports. Never invent figures: a goal nobody stated or clearly implied stays -1 (unset). Set a
section's `change` to false when you have nothing better than what is already there. List the assumptions you made, and ask up to
three questions whose answers would change the profile materially.

Fields:
- company: name; website; industry in plain words; description (two or three plain sentences); offer (what the agent sells or books
  on calls, one sentence); markets (countries or regions); languages (ISO 639-1 codes the agent should speak).
- icp, in Apollo's search vocabulary: titles as people write them ("Head of Procurement"), excludeTitles, seniorities (from the
  list), industries as Apollo industry keywords ("real estate", "computer software"), personLocations and organizationLocations
  ("Dubai, United Arab Emirates" or a country), employeeRanges (from the list), keywords (a few words), personaHint (the persona
  found leads most likely are, from the taxonomy list, or empty).
- goals: meetingsPerWeek, targetMeetingRate (percent of calls, 0-100), targetCqs (0-100 call quality; 70 is good), leadsPerWeek,
  monthlyCallBudget (calls a month); focusPersonas and focusScenarios (taxonomy ids that matter most to the business).
- calling: timezone (IANA name of the main market), startHour and endHour (local, 24-hour; end after start), days (0 = Monday …
  6 = Sunday; follow local working weeks), maxAttemptsPerLead (usually 3), allowUnknownConsent (false unless the team says it may
  legally call leads whose consent is unknown; never true by default)."""


def business_schema() -> dict:
    t = current()
    pids, sids = [p['id'] for p in t.personas], [s['id'] for s in t.scenarios]
    num = {'type': 'number', 'description': '-1 when unknown'}
    return _obj({
        'company': _obj({'change': {'type': 'boolean'}, 'name': STR, 'website': STR, 'industry': STR, 'description': STR, 'offer': STR,
                         'markets': STRS, 'languages': STRS}),
        'icp': _obj({'change': {'type': 'boolean'}, 'titles': STRS, 'excludeTitles': STRS, 'seniorities': {'type': 'array', 'items': _enum(list(SENIORITIES))},
                     'industries': STRS, 'personLocations': STRS, 'organizationLocations': STRS,
                     'employeeRanges': {'type': 'array', 'items': _enum(EMPLOYEE_RANGES)}, 'keywords': STR, 'personaHint': _enum([*pids, ''])}),
        'goals': _obj({'change': {'type': 'boolean'}, 'meetingsPerWeek': num, 'targetMeetingRate': num, 'targetCqs': num, 'leadsPerWeek': num,
                       'monthlyCallBudget': num, 'focusPersonas': {'type': 'array', 'items': _enum(pids)},
                       'focusScenarios': {'type': 'array', 'items': _enum(sids)}}),
        'calling': _obj({'change': {'type': 'boolean'}, 'timezone': STR, 'startHour': {'type': 'integer'}, 'endHour': {'type': 'integer'},
                         'days': {'type': 'array', 'items': {'type': 'integer'}}, 'maxAttemptsPerLead': {'type': 'integer'},
                         'allowUnknownConsent': {'type': 'boolean'}}),
        'assumptions': STRS,
        'questions': STRS,
    })


def _website(url: Any) -> tuple[str, list[str]] | None:
    s = str(url or '').strip()
    if not s:
        return None
    if '://' not in s:
        s = f'https://{s}'
    u = urlparse(s)
    if u.scheme not in ('http', 'https') or not u.hostname or '.' not in u.hostname:
        raise http_error(400, 'website must be a web address such as https://example.com')
    host = u.hostname.lower()
    bare = host[4:] if host.startswith('www.') else host
    return s, list(dict.fromkeys([bare, f'www.{bare}', host]))


def _read_pages(content: list[Any]) -> bool:
    """Whether web fetch returned a page (not an error) anywhere in the response."""
    for b in content:
        btype = getattr(b, 'type', None) if not isinstance(b, dict) else b.get('type')
        if btype != 'web_fetch_tool_result':
            continue
        inner = getattr(b, 'content', None) if not isinstance(b, dict) else b.get('content')
        itype = getattr(inner, 'type', None) if not isinstance(inner, dict) else inner.get('type')
        if itype and 'error' not in itype:
            return True
    return False


def _section_patch(sec: str, d: dict) -> dict:
    p = {k: v for k, v in d.items() if k != 'change'}
    if sec == 'goals':
        p = {k: v for k, v in p.items() if not (isinstance(v, (int, float)) and not isinstance(v, bool) and v < 0)}
    if sec == 'icp' and p.get('personaHint') == '':
        p['personaHint'] = None
    return p


async def propose_business(db, body: dict) -> dict:
    require_copilot()
    await billing.require_feature(db, 'copilot')
    if not isinstance(body, dict):
        raise http_error(400, 'Expected an object')
    description = str(body.get('description') or '').strip()
    site = _website(body.get('website'))
    if not description and not site:
        raise http_error(400, 'Describe the business, or give its website')
    if len(description) > 8000:
        raise http_error(400, 'Keep the description under 8,000 characters')
    sections = body.get('sections') or list(SECTIONS)
    if not isinstance(sections, list) or any(x not in SECTIONS for x in sections):
        raise http_error(400, f"sections takes {', '.join(SECTIONS)}")
    cur = await get_business(db)
    user = f"""<description>
{description or '(none given; use the website)'}
</description>
Website: {site[0] if site else 'none given'}
Sections to draft: {', '.join(sections)} (set change to false for the others)
Current profile: {js_json({k: cur[k] for k in SECTIONS})}
Personas and scenarios in the active taxonomy:
{_taxonomy_lines()}
{'Read the website with web_fetch first: the home page and at most a few pages such as about, product or pricing.' if site else ''}"""
    tools = [{'type': 'web_fetch_20260209', 'name': 'web_fetch', 'max_uses': 5, 'allowed_domains': site[1]}] if site else None
    notes: list[str] = []
    await billing.use_copilot(db, 'business')
    try:
        r = await request_json(BUSINESS_SYSTEM, user, business_schema(), effort='medium', max_tokens=16000, tools=tools, thinking=True)
    except anthropic.BadRequestError as e:
        if not tools or 'web_fetch' not in str(e).lower():
            raise
        log.warn('web fetch not available; drafting from the description only', {'error': str(e)})
        notes.append('The website couldn’t be read (web fetch isn’t enabled for this API key); this draft uses the description only.')
        r = await request_json(BUSINESS_SYSTEM, user.replace('Read the website with web_fetch first', 'The website can’t be read here; ignore it'),
                               business_schema(), effort='medium', max_tokens=16000, thinking=True)
    data = r['json']
    profile: dict[str, Any] = {}
    changes: list[dict] = []
    for sec in sections:
        d = data.get(sec) or {}
        if not d.get('change'):
            continue
        patch = _section_patch(sec, d)
        try:
            merged = merge_business(cur, {sec: patch})[sec]
        except HttpStatusError:
            # Keep every field that passes on its own; say which didn't.
            merged = copy.deepcopy(cur[sec])
            for k, v in patch.items():
                try:
                    merged = merge_business({**cur, sec: merged}, {sec: {k: v}})[sec]
                except HttpStatusError as e:
                    notes.append(f'Left {sec}.{k} as it was: {e.message}')
        diffs = [{'section': sec, 'field': k, 'from': cur[sec].get(k), 'to': v} for k, v in merged.items() if v != cur[sec].get(k)]
        if diffs:
            profile[sec] = merged
            changes += diffs
    return {'profile': profile, 'changes': changes, 'assumptions': [*notes, *(data.get('assumptions') or [])][:12],
            'questions': (data.get('questions') or [])[:5], 'websiteRead': bool(site) and _read_pages(r['content']), 'usage': _usage(r)}


# ---------- Taxonomy ----------

def _builtin_lines() -> str:
    p = '\n'.join(f"- {x['id']} {x['name']} ({x['path']} path): {x['signals']}" for x in BUILTIN_PERSONAS.values())
    s = '\n'.join(f"- {x['id']} {x['name']}: {x['trigger']} → {x['success']}" for x in BUILTIN_SCENARIOS.values())
    return f'Framework personas:\n{p}\nFramework scenarios:\n{s}'


TAXONOMY_SYSTEM = f"""You design the taxonomy an AI voice sales agent's calls are classified and scored against. Every call gets exactly
one persona (who the caller is, judged at the end of the call) and one primary scenario (the journey that decided the outcome), plus
events (moments inside any scenario). Scores are reported persona × scenario, so the taxonomy decides what a sales team can see.

Personas. path is Investor (the buyer path: discovery, qualification and meeting metrics apply), Broker (a partner or intermediary:
partner-registration checks apply and buyer discovery must not be asked) or Non-target (not a prospect: routed, never pitched).
signals: what the caller says or does that identifies them. watch: what the agent must get right with them. checkLabel: the one check
to report for them (a short noun phrase). P0 Unclassified always exists; don't propose it.

Scenarios. trigger: what starts this journey; path: the expected agent path in a few arrows; success: what a good outcome is.
checkpoints: 2–5 steps of the expected path, in order, each detected by `judge` (needs the meaning of the words; give a hint a
reviewer could check), `tool` (a successful call to one of the named tools) or `rule` (a code detector: {', '.join(sorted(RULE_IDS))}).

Events. group Objections feeds the lost-reason report; the others are Caller behaviour, Agent or system, Outcome moments. These are
detected by code and are always kept: {', '.join(SYSTEM_EVENTS)}.

basedOn makes an entry inherit a framework entry's built-in rules and checks: S12 is tagged by code for failed calls (voicemail,
silence), S10 honours do-not-contact, S4, S5 and S6 are tagged from the callback, transfer and meeting tools, S9 from an objective or
prior history, S7 from the partner-registration tool, P11 feeds the Other share watched for taxonomy drift, P7/P8 are tagged from the
registration tool. Without a Claude key, a persona based on a framework persona is also recognised by that persona's phrases, so only
inherit when the meaning truly matches; otherwise leave basedOn empty and give keywords.
keywords: 3–8 short lower-case caller phrases that identify the entry (used when no Claude key is set).

Good taxonomies are mutually exclusive and cover nearly every call: 5–12 personas and 6–14 scenarios with short plain names. Keep an
Other persona based on P11 and scenarios based on S12 (failed call), S10 (not interested) and S11 (out of scope), plus S4, S5 and S6
when the agent has those tools.

Answer with operations against the current document: add (id empty), update (an existing id, with the full entry as it should read)
or retire (an existing id; other fields empty). Prefer updating an entry whose meaning stays close over retiring it and adding a new
one, so call history stays continuous. Each operation has a one-sentence reason, citing call counts or clusters where they exist.
domain: one or two sentences, "<who>, which <sells what> to <whom>. Callers are <…>." Leave it empty to keep the current one.

{_builtin_lines()}"""

MODES = {
    'draft': 'Design the taxonomy for this business from its profile: retire what doesn’t fit, update what is close, add what is missing.',
    'edit': 'Make the change the team asks for, and only what it needs (including entries it affects).',
    'review': 'Review the taxonomy against the evidence from recent calls and propose the changes it supports: split overloaded entries, add '
              'what keeps landing in Unclassified, Other or Out of scope, merge or retire entries nobody reaches. Propose nothing the evidence '
              'doesn’t support.',
}


def taxonomy_schema() -> dict:
    op = _enum(['add', 'update', 'retire'])
    cp = _obj({'id': STR, 'label': STR, 'hint': STR, 'by': _enum(['judge', 'tool', 'rule']), 'tools': STRS, 'rule': _enum([*sorted(RULE_IDS), ''])})
    persona = _obj({'op': op, 'id': STR, 'name': STR, 'path': _enum(list(PERSONA_PATHS)), 'signals': STR, 'watch': STR, 'checkLabel': STR,
                    'basedOn': _enum([*BUILTIN_PERSONAS, '']), 'keywords': STRS, 'reason': STR})
    scenario = _obj({'op': op, 'id': STR, 'name': STR, 'short': STR, 'trigger': STR, 'path': STR, 'success': STR,
                     'basedOn': _enum([*BUILTIN_SCENARIOS, '']), 'keywords': STRS, 'checkpoints': {'type': 'array', 'items': cp}, 'reason': STR})
    event = _obj({'op': op, 'id': STR, 'label': STR, 'group': _enum(list(EVENT_GROUPS)), 'keywords': STRS, 'reason': STR})
    return _obj({'summary': STR, 'domain': STR, 'personas': {'type': 'array', 'items': persona}, 'scenarios': {'type': 'array', 'items': scenario},
                 'events': {'type': 'array', 'items': event}, 'questions': STRS})


async def taxonomy_evidence(db) -> dict:
    use = await tx.usage(db)
    total = sum(use['personas'].values())
    other = current().ids_based_on('persona', ('P11',))
    unc = use['personas'].get('P0', 0) + sum(use['personas'].get(i, 0) for i in other)
    clusters = await db.query('select label, size, nearest, proposed from cluster order by size desc limit 15')
    calls = await db.query(
        """select c.persona, c.scenario, t.value as summary, pt.confidence as conf
           from calls c join call_tag t on t.call_id = c.call_id and t.tag_key = 'summary'
           left join call_tag pt on pt.call_id = c.call_id and pt.tag_key = 'persona' and pt.taxonomy_version = t.taxonomy_version
           where c.status = 'scored' and c.started_at > now() - interval '30 days' and t.value is not null
           order by (c.persona = 'P0' or c.persona = any($1::text[]) or coalesce(pt.confidence, 1) < 0.7) desc, c.started_at desc limit 40""", [other])
    return {'usage': use, 'unclassifiedShare': round(unc / total * 100, 1) if total else None, 'clusters': clusters, 'calls': calls}


def _compact(doc: dict) -> str:
    keep = {'personas': ('id', 'name', 'path', 'signals', 'watch', 'basedOn', 'keywords'),
            'scenarios': ('id', 'name', 'trigger', 'success', 'basedOn', 'keywords', 'checkpoints'), 'events': ('id', 'label', 'group')}
    return js_json({'domain': doc['domain'], **{k: [{f: e.get(f) for f in fs} for e in doc[k]] for k, fs in keep.items()}})


def _op_from(kind: str, x: dict) -> dict:
    op, id = x['op'], (x.get('id') or '').strip() or None
    if op == 'retire':
        return {'op': op, 'kind': kind, 'id': id, 'entry': None, 'reason': x.get('reason') or ''}
    entry = {k: v for k, v in x.items() if k in tx.FIELDS[kind]}
    if 'basedOn' in entry:
        entry['basedOn'] = entry['basedOn'] or None
    if kind == 'scenario':
        entry['checkpoints'] = [{'id': c['id'], 'label': c['label'], **({'hint': c['hint']} if c.get('hint') else {}),
                                 'detect': {'by': 'tool', 'tools': c['tools']} if c['by'] == 'tool' else {'by': 'rule', 'rule': c['rule']} if c['by'] == 'rule'
                                 else {'by': 'judge'}} for c in x.get('checkpoints') or []]
    if kind == 'event':
        entry['basedOn'] = id if id in BUILTIN_EVENTS else None
    return {'op': op, 'kind': kind, 'id': None if op == 'add' else id, 'entry': entry, 'reason': x.get('reason') or ''}


async def propose_taxonomy(db, body: dict) -> dict:
    require_copilot()
    await billing.require_feature(db, 'copilot')
    if not isinstance(body, dict):
        raise http_error(400, 'Expected an object')
    mode = body.get('mode') or 'edit'
    if mode not in MODES:
        raise http_error(400, 'mode is draft, edit or review')
    instruction = str(body.get('instruction') or '').strip()
    if mode == 'edit' and not instruction:
        raise http_error(400, 'Say what to change')
    if len(instruction) > 4000:
        raise http_error(400, 'Keep the instruction under 4,000 characters')
    await tx.seed(db)
    base = await tx.working_doc(db)
    biz = await get_business(db)
    ev = await taxonomy_evidence(db)
    tools = await tx.known_tools(db)
    calls = '\n'.join(f"- {c['persona'] or 'P0'}/{c['scenario'] or '-'}{' (low confidence)' if (c['conf'] or 1) < 0.7 else ''}: {c['summary'][:240]}"
                      for c in ev['calls'])
    clusters = '\n'.join(f"- {c['label']}: {c['size']} calls, nearest {c['nearest']}{' (proposed by a reviewer)' if c['proposed'] else ''}"
                         for c in ev['clusters'])
    user = f"""TASK ({mode}): {MODES[mode]}
{f'The team asks: {instruction}' if instruction else ''}

Business profile: {js_json({k: biz[k] for k in ('company', 'icp', 'goals')})}
Agent tools: {', '.join(tools)}

Current taxonomy (the draft being edited): {_compact(base)}

Evidence from the last 90 days:
Calls per persona: {js_json(ev['usage']['personas'])}; per scenario: {js_json(ev['usage']['scenarios'])}
Unclassified plus Other share: {f"{ev['unclassifiedShare']}%" if ev['unclassifiedShare'] is not None else 'no scored calls yet'}
Unnamed clusters of call summaries:
{clusters or '- none yet'}
Recent call summaries (persona/scenario, unclear ones first):
{calls or '- none yet'}"""
    await billing.use_copilot(db, 'taxonomy')
    r = await request_json(TAXONOMY_SYSTEM, user, taxonomy_schema(), effort='high', max_tokens=32000, thinking=True)
    data = r['json']
    ids = {k: {e['id'] for e in base[tx.KINDS[k]]} for k in tx.KINDS}
    known = await tx.known_ids(db)
    ops = []
    for kind in tx.KINDS:
        for x in data.get(tx.KINDS[kind]) or []:
            o = _op_from(kind, x)
            if o['op'] != 'add' and o['id'] not in ids[kind]:
                log.warn('co-pilot proposed a change to an entry the draft lacks', {'kind': kind, 'id': o['id'], 'op': o['op']})
                continue
            if kind == 'event' and o['op'] == 'retire' and o['id'] in SYSTEM_EVENTS:
                continue
            # Would this change pass on its own? The person applying it sees why not.
            try:
                tx.normalise_doc(tx.apply_to_doc(base, [o]), known)
            except HttpStatusError as e:
                o['warnings'] = [e.message.replace('The taxonomy has problems: ', '')]
            ops.append(o)
    domain = (data.get('domain') or '').strip() or None
    return {'summary': data.get('summary') or '', 'domain': domain if domain != base['domain'] else None, 'operations': ops,
            'questions': (data.get('questions') or [])[:5],
            'evidence': {'calls': len(ev['calls']), 'clusters': len(ev['clusters']), 'unclassifiedShare': ev['unclassifiedShare']}, 'usage': _usage(r)}


# ---------- Lead funnels ----------

FUNNEL_SYSTEM = f"""You design lead funnels for a CRM built into an AI voice-agent platform. A funnel is the ordered list of stages a lead
moves through, from first contact to won or lost. A stage can stand for a milestone the platform understands; stages without one
are the team's own and are moved by hand.

Milestones (each at most once per funnel):
{chr(10).join(f"- {m['id']}: {m['label']}. {m['description']}" for m in fn.MILESTONES)}

Rules: 5–10 stages; the first stage is open (usually milestone new); kind is open, won or lost (milestone sale or a partner deal is
won; lost and dnc are lost); every funnel ends with a do-not-contact stage (milestone dnc). callable marks the open stages campaigns
may call: early ones, not stages a person is handling (a proposal, a negotiation) and never won or lost ones. Keys are snake_case.
Use labels in the team's own words (a software company says "Demo booked" for meeting_booked).
match routes new leads to this funnel by persona path, persona id or lead source; leave it empty when one funnel serves everyone.
Explain the design in one or two sentences (reason) and ask at most three questions where the answer would change it."""


def funnel_schema() -> dict:
    stage = _obj({'key': STR, 'label': STR, 'description': STR, 'milestone': _enum([*(m['id'] for m in fn.MILESTONES), 'none']),
                  'kind': _enum(list(fn.KINDS)), 'callable': {'type': 'boolean'}})
    match = _obj({'paths': {'type': 'array', 'items': _enum(list(fn.PATHS))}, 'personas': {'type': 'array', 'items': _enum([p['id'] for p in current().personas])},
                  'sources': {'type': 'array', 'items': _enum(list(fn.SOURCES))}})
    return _obj({'name': STR, 'description': STR, 'stages': {'type': 'array', 'items': stage}, 'match': match, 'reason': STR, 'questions': STRS})


def _tidy_stages(stages: list[dict]) -> list[dict]:
    """Small repairs before the checks: unique keys, each milestone once, lost milestones on lost stages."""
    seen_k: set[str] = set()
    seen_m: set[str] = set()
    out = []
    for s in stages:
        s = dict(s)
        if s.get('milestone') == 'none':
            s['milestone'] = None
        if s.get('milestone') in seen_m:
            s['milestone'] = None
        if s.get('milestone'):
            seen_m.add(s['milestone'])
        if s.get('milestone') in ('lost', 'dnc'):
            s['kind'] = 'lost'
        k = s.get('key') or ''
        while k in seen_k:
            k = f'{k}_2'
        seen_k.add(k)
        out.append({**s, 'key': k})
    return out


async def propose_funnel(db, body: dict) -> dict:
    require_copilot()
    await billing.require_feature(db, 'copilot')
    if not isinstance(body, dict):
        raise http_error(400, 'Expected an object')
    instruction = str(body.get('instruction') or '').strip()
    if len(instruction) > 4000:
        raise http_error(400, 'Keep the instruction under 4,000 characters')
    target = await fn.get_funnel(db, body['funnelId']) if body.get('funnelId') else None
    biz = await get_business(db)
    funnels = await fn.list_funnels(db)
    sources = await db.query('select source, count(*)::int as n from lead group by source order by n desc')
    existing = '\n'.join(f"- {f['name']}{' (default)' if f['isDefault'] else ''}: {' → '.join(s['label'] for s in f['stages'])}; {f['leads']} leads" for f in funnels)
    user = f"""{f'The team asks: {instruction}' if instruction else 'Design the funnel this business needs.'}
{f"Redesign this funnel (keep keys for stages that stay, so its leads keep their place): {js_json({'name': target['name'], 'stages': target['stages'], 'match': target['match']})}" if target else 'Design a new funnel.'}

Business profile: {js_json({k: biz[k] for k in ('company', 'icp', 'goals')})}
Personas: {_taxonomy_lines()}
Existing funnels:
{existing}
Leads by source: {js_json({r['source']: r['n'] for r in sources})}"""
    await billing.use_copilot(db, 'funnel')
    r = await request_json(FUNNEL_SYSTEM, user, funnel_schema(), effort='high', max_tokens=16000, thinking=True)
    data = r['json']
    try:
        stages = fn.normalise_stages(_tidy_stages(data.get('stages') or []))
    except HttpStatusError as e:
        raise http_error(502, f'The co-pilot’s funnel didn’t pass the checks ({e.message}); try again or adjust the instruction') from e
    m = data.get('match') or {}
    return {'funnel': {'name': (data.get('name') or 'New funnel').strip()[:80], 'description': (data.get('description') or '').strip()[:500], 'stages': stages,
                       'match': {'paths': m.get('paths') or [], 'personas': m.get('personas') or [], 'sources': m.get('sources') or []}},
            'reason': data.get('reason') or '', 'questions': (data.get('questions') or [])[:5], 'usage': _usage(r)}


__all__ = ['propose_business', 'propose_funnel', 'propose_taxonomy', 'require_copilot']
