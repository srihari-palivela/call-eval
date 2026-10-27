# Heuristic judge and classifier: phrase patterns and the tool log stand in for the LLM when no
# Claude API key is configured (demo mode, tests, air-gapped installs). Every result it produces is
# marked layer/method "heuristic" so it is never mistaken for a judged score; with a key configured
# the Claude judge replaces it.

from __future__ import annotations

import math
import re
import time
from functools import lru_cache
from typing import Any

from ...js import at, fixed, js_round, js_split, js_str, jsre, match_all, to_fixed
from ...lib.ids import new_id
from ...taxonomy import current
from ..text import RX, js_string, lc, money_amounts, numbers_in, question_count, sentiment, strip_tags, word_count, words_to_digits

# Signals for the framework's personas; a user-defined persona based on one of them inherits its signals, and
# any persona or scenario can add keywords of its own.
PERSONA_SIGNALS: dict[str, list[Any]] = {
    'P1': [jsre(r'\b(family|kids|children|schools?|my wife|my husband|more space|second bedroom|two kids)\b', 'i')],
    'P2': [jsre(r'\b(first (home|place)|how (does|do) (it|off-plan) work|off-plan works|never bought|first.?time)\b', 'i')],
    'P3': [jsre(r'\b(yield|rental (return|income)|returns?|resale|investment|several units|roi)\b', 'i')],
    'P4': [jsre(r'\b(calling from (london|abroad|the uk|india|overseas)|non-resident|time.?zone|from overseas|outside the uae)\b', 'i')],
    'P5': [jsre(r'\b(we live in (dubai|the uae)|live in dubai marina|upgrade|moving up|relocat|our current (home|place|flat))\b', 'i')],
    'P6': [jsre(r'\b(just looking|only looking|browsing|not sure yet)\b', 'i')],
    'P7': [jsre(r'\bbroker\b.*\b(london|clients in|international|overseas|uk buyers)\b|\bagency in (london|the uk)\b', 'i')],
    'P8': [jsre(r'\b(independent broker|freelance|broker here in dubai|independent, here in dubai)\b', 'i')],
    'P9': [jsre(r'\b(already own|service charge|snagging|my unit|community team|handover of my)\b', 'i')],
    'P10': [jsre(r'\b(looking to rent|want to rent|renting, not buying|rent,? not buy|rental listing)\b', 'i')],
    'P11': [jsre(r'\b(job opening|vacancy|wrong number|supplier|vendor|recruit)\b', 'i')],
}

PROJECT_RX = jsre(r'\b(island park residences|seafront one|circle gardens|creek heights)\b', 'i')
_FAILED = jsre(r'\b(fail|failed|error|unavailable)\b', 'i')


def _caller_text(call: dict) -> str:
    return ' \n '.join(t['text'] for t in call['turns'] if t['speaker'] == 'caller')


def _next_agent(call: dict, idx: int) -> dict | None:
    return next((t for t in call['turns'] if t['idx'] > idx and t['speaker'] == 'agent'), None)


def _ok(s: str | None) -> bool:
    return not _FAILED.search(s or '')


def _parse_money(s: str) -> int | None:
    a = money_amounts(s)
    return a[0] if a else None


_NAME = jsre(r"\b(?:it'?s|my name is|this is|i'?m) ([A-Z][a-z]+)\b")
_NOT_NAME = jsre(r'^(a|an|the|just|not|looking|calling|actually|with|independent|buying)$', 'i')
_BEDS = jsre(r'\b(\d|one|two|three|four)[ -]?(bed|bedroom)s?\b|\b(\d|one|two|three) bedrooms\b', 'i')
_LOC = jsre(r'\b(dubai islands|jvc|dubai creek harbour|creek harbour|dubai marina|business bay|downtown)\b', 'i')
_COMPARE = jsre(r'\bcompare|seen\b', 'i')
_BUDGET_WORDS = jsre(r'\b(budget|around|up to|spend|million)\b', 'i')
_POINT_ZERO = jsre(r'\.0$')
_TL_YEAR = jsre(r'\b(within the year|next (summer|year)|lease ends)\b', 'i')
_TL_SOON = jsre(r'\b(next (month|few weeks)|asap|immediately|right away)\b', 'i')
_TL_LATER = jsre(r'\b(in a (couple|few) of years|no rush|not in a hurry)\b', 'i')
_MUST = jsre(r'\b(park|beach|metro|schools?|gym|pool|sea view|quiet)\b', 'gi')
_MUST_CTX = jsre(r'\b(matters|need|want|for the kids|important|near)\b', 'i')
_FAMILY = jsre(r'\b(four of us|my wife and|the kids|family)\b', 'i')
_JUST_ME = jsre(r'\bjust me\b', 'i')
_LIVE_IN = jsre(r'\b(to live in|live in it|for my family|for myself)\b', 'i')
_INVEST = jsre(r'\b(investment|invest|rental)\b', 'i')
_TYPE = jsre(r'\b(apartment|villa|townhouse|penthouse|studio)\b', 'i')
_AGENCY = jsre(r'\bagency\b', 'i')
_LONDON = jsre(r'london|uk', 'i')
_INDEPENDENT = jsre(r'\bindependent\b', 'i')
_NOT_YET = jsre(r'\b(not yet|not registered)\b', 'i')
_REGISTERED = jsre(r"\b(we registered|already registered|yes, we'?re registered)\b", 'i')
_N_BEDROOM_B = jsre(r'\b(\d)-bedroom', 'i')
_N_BEDROOM = jsre(r'(\d)-bedroom', 'i')
_APARTMENT = jsre(r'\bapartment\b', 'i')


def _sub1(rx: str, rep: str, s: str) -> str:
    return re.sub(rx, rep, s, count=1, flags=re.IGNORECASE)


def extract_fields(call: dict) -> dict:
    f: dict[str, str | None] = {}
    budget_aed: int | None = None
    timeline_months: int | None = None
    for t in call['turns']:
        if t['speaker'] != 'caller':
            continue
        s = strip_tags(t['text'])
        name = _NAME.search(s)
        if name and not _NOT_NAME.search(name.group(1)):
            f['name'] = name.group(1)
        beds = _BEDS.search(s)
        if beds:
            g = beds.group(1) if beds.group(1) is not None else beds.group(3)
            f['bedrooms'] = _sub1('four', '4', _sub1('three', '3', _sub1('two', '2', _sub1('one', '1', g))))
        loc = _LOC.search(s)
        if loc and not _COMPARE.search(s):
            f['location'] = loc.group(1)
        money = _parse_money(s)
        if money and _BUDGET_WORDS.search(s):
            budget_aed = money
            f['budget'] = f"{_POINT_ZERO.sub('', to_fixed(money / 1_000_000, 1), count=1)}m AED"
        if _TL_YEAR.search(s):
            timeline_months = 9
            f['timeline'] = '3–12 months'
        elif _TL_SOON.search(s):
            timeline_months = 1
            f['timeline'] = 'Under 3 months'
        elif _TL_LATER.search(s):
            timeline_months = 24
            f['timeline'] = 'Over 12 months'
        must = match_all(_MUST, s)
        if must and _MUST_CTX.search(s):
            f['must_haves'] = ', '.join(dict.fromkeys(x.lower() for x in must))
        if _FAMILY.search(s):
            f['who_for'] = 'Family'
        elif _JUST_ME.search(s):
            f['who_for'] = 'Self'
        if _LIVE_IN.search(s) and f.get('buy_intent') is None:
            f['buy_intent'] = 'Live in'
        if _INVEST.search(s):
            f['buy_intent'] = 'Investment'
        typ = _TYPE.search(s)
        if typ:
            f['property_type'] = typ.group(1).lower()
        if _AGENCY.search(s):
            f['broker_type'] = 'Agency, overseas' if _LONDON.search(s) else 'Agency'
        if _INDEPENDENT.search(s):
            f['broker_type'] = 'Independent'
        if _NOT_YET.search(s):
            f['registration'] = 'Unregistered'
        if _REGISTERED.search(s):
            f['registration'] = 'Registered'
        proj = PROJECT_RX.search(s)
        if proj:
            f['project_interest'] = proj.group(1)
    for t in call['turns']:
        if t['speaker'] != 'agent':
            continue
        if _N_BEDROOM_B.search(t['text']) and not f.get('bedrooms'):
            f['bedrooms'] = _N_BEDROOM.search(t['text']).group(1)
        if _APARTMENT.search(t['text']) and not f.get('property_type') and _APARTMENT.search(_caller_text(call)):
            f['property_type'] = 'apartment'
    return {'fields': f, 'budgetAed': budget_aed, 'timelineMonths': timeline_months}


_COLD = jsre(r'\b(just looking|not sure|not interested|maybe later)\b', 'i')
_WARM = jsre(r'\b(lease ends|need more space|want to buy|ready|this month|asap|within the year)\b', 'i')


def _intent_of(text: str, booked: bool, refused: bool) -> str:
    if booked:
        return 'hot'
    if refused:
        return 'cold'
    if _COLD.search(text):
        return 'cold'
    if _WARM.search(text):
        return 'warm'
    return 'warm'


_INVESTOR_CT = jsre(r'\b(for myself|buying|invest)\b', 'i')
_BROKER_CT = jsre(r'\bbroker\b', 'i')
_DOC_EARLY = jsre(r'\b(send me|brochure)\b', 'i')
_DOC_EV = jsre(r'brochure|send me', 'i')
_NAMED_PROJECT = jsre(r'\b(tell me about|about) .*(residences|gardens|heights|seafront|project)', 'i')
_ADVICE_TOPIC = jsre(r'\b(visa|mortgage|yield|rental return)\b', 'i')
_LOOKING = jsre(r'just looking|not interested', 'i')
_CHOSEN = jsre(r"\b(the (first|quieter|second) one sounds right|that one|i'?ll go with)\b", 'i')
_VISIT = jsre(r'\b(in person|come and see|site visit|see it)\b', 'i')

_W = {'P2': 2, 'P4': 2, 'P7': 2, 'P8': 2, 'P9': 2, 'P10': 2, 'P11': 2, 'P5': 1.5, 'P6': 1.5}
_KEYWORD_WEIGHT = 2


@lru_cache(maxsize=512)
def _keyword_rx(keywords: tuple[str, ...]) -> re.Pattern:
    return re.compile(r'\b(?:' + '|'.join(re.escape(k) for k in keywords) + r')', re.I)


def _keyword_hits(keywords: list[str] | None, turns: list[dict]) -> list[int]:
    if not keywords:
        return []
    rx = _keyword_rx(tuple(keywords))
    return [t['idx'] for t in turns if rx.search(t['text'])]


def heuristic_classify(inp: dict) -> dict:
    call, ctx, rules = inp['call'], inp['ctx'], inp['rules']
    turns = call['turns']
    ct = _caller_text(call)
    started = time.monotonic()
    ex = extract_fields(call)
    callers = [t for t in turns if t['speaker'] == 'caller']
    tax = current()

    def on_path(path: str) -> str | None:
        return next((p['id'] for p in tax.personas if p['path'] == path), None)

    # Persona: judged at the end of the call, from all caller text.
    if rules.get('persona'):
        rp = rules['persona']
        persona = {'value': rp['value'], 'confidence': rp['confidence'], 'evidence': rp['evidence']}
    else:
        # Specific signals (calling from abroad, first home, broker, owner) outweigh generic ones (investment, family).
        by_id: dict[str, dict] = {}
        for bid, rxs in PERSONA_SIGNALS.items():
            pid = tax.persona_for(bid)
            if pid is None:
                continue
            sc = by_id.setdefault(pid, {'id': pid, 's': 0, 'ev': []})
            for t in callers:
                for rx in rxs:
                    if rx.search(t['text']):
                        sc['s'] += _W.get(bid, 1)
                        sc['ev'].append(t['idx'])
        for p in tax.personas:
            hits = _keyword_hits(p.get('keywords'), callers)
            if hits:
                sc = by_id.setdefault(p['id'], {'id': p['id'], 's': 0, 'ev': []})
                sc['s'] += _KEYWORD_WEIGHT * len(hits)
                sc['ev'] += hits
        scores = sorted(by_id.values(), key=lambda x: -x['s'])
        top = scores[0] if scores else None
        second = scores[1] if len(scores) > 1 else None
        if top is None or top['s'] == 0:
            investor = bool(_INVESTOR_CT.search(ct)) or ctx['persona'] == 'investor'
            broker = bool(_BROKER_CT.search(ct)) or ctx['persona'] == 'broker'
            b_id = (tax.persona_for('P8') or on_path('Broker')) if broker else None
            i_id = (tax.persona_for('P1') or on_path('Investor')) if investor else None
            persona = {'value': b_id, 'confidence': 0.55, 'evidence': []} if b_id else {'value': i_id, 'confidence': 0.5, 'evidence': []} if i_id else {'value': 'P0', 'confidence': 0.8, 'evidence': []}
        else:
            # Clear winner → high confidence; a tie with another persona → under the review line.
            margin = (top['s'] - (second['s'] if second else 0)) / top['s']
            persona = {'value': top['id'], 'confidence': min(0.96, fixed(0.6 + margin * 0.3 + min(top['s'], 3) * 0.03, 2)), 'evidence': list(dict.fromkeys(top['ev']))[:4]}
    p_def = None if persona['value'] == 'P0' else tax.persona(persona['value'])

    # Scenario: the journey that decided the outcome is primary.
    comp = RX['objection']['competitor_mentioned']
    objections = [t for t in callers if any(rx.search(t['text']) and not comp.search(t['text']) for rx in RX['objection'].values())]
    booked = any(t['name'] == 'schedule_meeting' and _ok(t.get('resultText')) for t in call['toolCalls'])
    docs = any(t['name'] == 'send_documents' for t in call['toolCalls'])
    refused = any(RX['refusal'].search(strip_tags(t['text'])) or RX['dnc'].search(t['text']) for t in callers)
    first_callers = callers[:3]
    doc_asked_early = any(_DOC_EARLY.search(t['text']) for t in first_callers)
    named_project = any(_NAMED_PROJECT.search(t['text']) for t in first_callers)
    off_topic = next((t for t in callers if RX['offTopic'].search(t['text']) and not comp.search(t['text'])), None)
    caller_pos = next((k for k, t in enumerate(callers) if t is off_topic), -1)
    # The framework's journeys, as the active taxonomy's entries based on them (None when it has none).
    S = {b: tax.scenario_for(b) for b in ('S1', 'S2', 'S3', 'S7', 'S8', 'S9', 'S10', 'S11')}
    kw = sorted(((len(h), s['id'], h) for s in tax.scenarios if (h := _keyword_hits(s.get('keywords'), callers))),
                key=lambda x: -x[0])
    if rules.get('scenarioPrimary'):
        sp = {'value': rules['scenarioPrimary']['value'], 'confidence': 1, 'evidence': rules['scenarioPrimary']['evidence']}
    elif kw:
        sp = {'value': kw[0][1], 'confidence': min(0.9, fixed(0.7 + 0.05 * kw[0][0], 2)), 'evidence': kw[0][2][:3]}
    else:
        if p_def is not None and p_def['path'] == 'Non-target':
            sp = {'value': 'S11' if off_topic is not None or p_def.get('basedOn') != 'P11' else 'S10', 'confidence': 0.82,
                  'evidence': [off_topic['idx']] if off_topic is not None else []}
        elif refused and not booked and not docs and len(callers) <= 4:
            sp = {'value': 'S10', 'confidence': 0.82, 'evidence': [t['idx'] for t in callers if RX['refusal'].search(strip_tags(t['text'])) or RX['dnc'].search(t['text'])][:2]}
        elif S['S9'] and S['S9'] in rules['scenarioCandidates'] and ctx['objective'] != 'empty':
            sp = {'value': 'S9', 'confidence': 0.84, 'evidence': [0]}
        elif off_topic is not None and _ADVICE_TOPIC.search(off_topic['text']) and caller_pos <= 2:
            sp = {'value': 'S11', 'confidence': 0.8, 'evidence': [off_topic['idx']]}
        elif doc_asked_early and not booked:
            sp = {'value': 'S3', 'confidence': 0.84, 'evidence': [t['idx'] for t in first_callers if _DOC_EV.search(t['text'])]}
        elif named_project:
            sp = {'value': 'S2', 'confidence': 0.8, 'evidence': [t['idx'] for t in first_callers][:2]}
        elif objections and not booked:
            sp = {'value': 'S8', 'confidence': 0.78, 'evidence': [o['idx'] for o in objections]}
        else:
            sp = {'value': 'S1', 'confidence': 0.88 if booked else 0.79 if any(t['name'] == 'get_project_details' for t in call['toolCalls']) else 0.62,
                  'evidence': [t['turnIdx'] for t in call['toolCalls'] if t['name'] in ('get_project_details', 'schedule_meeting')][:3]}
        # Without an entry for that journey, the discovery entry (or the first scenario) under the review line.
        mapped = S.get(sp['value'])
        sp = {**sp, 'value': mapped} if mapped else {**sp, 'value': S['S1'] or (tax.scenarios[0]['id'] if tax.scenarios else None), 'confidence': 0.5}
    ss: dict = {'value': None, 'confidence': 0, 'evidence': []}
    if objections and S['S8'] and sp['value'] != S['S8']:
        ss = {'value': S['S8'], 'confidence': 0.7, 'evidence': [o['idx'] for o in objections]}
    elif docs and S['S3'] and sp['value'] != S['S3'] and sp['value'] != S['S7']:
        ss = {'value': S['S3'], 'confidence': 0.72, 'evidence': [t['turnIdx'] for t in call['toolCalls'] if t['name'] == 'send_documents']}
    elif off_topic is not None and S['S11'] and sp['value'] != S['S11']:
        ss = {'value': S['S11'], 'confidence': 0.7, 'evidence': [off_topic['idx']]}

    first_c = ' '.join(t['text'] for t in first_callers)
    last_c = ' '.join(t['text'] for t in callers[-3:])
    i_start = _intent_of(first_c, False, bool(_LOOKING.search(first_c)))
    i_end = _intent_of(last_c, booked, refused and not booked and not docs)
    events: list[dict] = []
    for t in callers:
        for typ, rx in RX['objection'].items():
            if rx.search(t['text']):
                events.append({'type': typ, 'turn': t['idx']})
        if RX['frustration'].search(lc(t['text'])):
            events.append({'type': 'frustration', 'turn': t['idx']})
        if RX['offTopic'].search(t['text']) and not comp.search(t['text']):
            events.append({'type': 'off_topic_request', 'turn': t['idx']})
        if _CHOSEN.search(t['text']):
            events.append({'type': 'project_chosen', 'turn': t['idx']})
        if _VISIT.search(t['text']):
            events.append({'type': 'visit_requested', 'turn': t['idx']})
    rank = {'cold': 0, 'warm': 1, 'hot': 2}
    last = turns[-1]['idx'] if turns else 0
    if rank[i_end] > rank[i_start]:
        events.append({'type': 'intent_rose', 'turn': last})
    if rank[i_end] < rank[i_start]:
        events.append({'type': 'intent_fell', 'turn': last})
    # Only events the active taxonomy has, plus its own keyword-defined ones.
    active_events = {e['id'] for e in tax.events}
    events = [e for e in events if e['type'] in active_events]
    for e in tax.events:
        if not e.get('system'):
            events += [{'type': e['id'], 'turn': i} for i in _keyword_hits(e.get('keywords'), callers)[:3]]

    return {
        'persona': persona,
        'personaResolvedTurn': None,
        'scenarioPrimary': sp,
        'scenarioSecondary': ss,
        'intentStart': {'value': i_start, 'confidence': 0.7, 'evidence': [t['idx'] for t in first_callers][:2]},
        'intentEnd': {'value': i_end, 'confidence': 0.75, 'evidence': [t['idx'] for t in callers[-2:]]},
        'events': events,
        'fields': ex['fields'],
        'budgetAed': ex['budgetAed'],
        'timelineMonths': ex['timelineMonths'],
        'language': call.get('language') if call.get('language') is not None else 'en',
        'summary': f"{p_def['name'] if p_def else 'Unclassified caller'}: {strip_tags(first_callers[0]['text'] if first_callers else '')[:120]}",
        'run': {'id': new_id('run'), 'kind': 'classifier', 'mode': 'heuristic', 'model': None, 'inputTokens': 0, 'outputTokens': 0,
                'latencyMs': int((time.monotonic() - started) * 1000), 'status': 'ok'},
    }


# ---------- Judged metrics ----------

def _m(applicable: bool, raw: float | None, evidence: list[int] | None = None, rationale: str = '') -> dict:
    return {'applicable': applicable, 'raw': raw if applicable else None, 'evidence': evidence if evidence is not None else [], 'rationale': rationale}


_FILLER = jsre(r'\b(let me|one moment|checking|pull that up|look that up|sending|booking|cancelling|moving)\b', 'i')


def _is_filler(t: dict) -> bool:
    return word_count(strip_tags(t['text'])) <= 9 and bool(_FILLER.search(t['text']))


_STATEMENT = jsre(r'[.!]\s')
_SORRY = jsre(r"\b(sorry|you'?re right)\b")
_PUSHY = jsre(r'\b(book|viewing|special|offer|before you go)\b')
_SALESY = jsre(r"\b(great question|exciting|shouldn'?t miss)\b")
_DOC_REQ = jsre(r'\b(send me|brochure|send it)\b')
_DOC_ACT = jsre(r'\b(send|which project|whatsapp|email)\b')
_PERSON_REQ = jsre(r'\b(speak to|person|human)\b')
_PUSH_AFTER_NO = jsre(r'\b(book|viewing|before you go|special)\b')
_PRICE_Q = jsre(r'\b(how much|price|handover|how big)\b')
_REPEAT = jsre(r"\b(i said|i told you|already told|the one we'?ve been talking about|you used it|we said)\b", 'i')
_WS = jsre(r'\s+')
_UNCLEAR = jsre(r'^(what\??|sorry\??|pardon\??|huh\??)$', 'i')
_ENDS_Q = jsre(r'\?$')
_CLARIFY = jsre(r'\b(could you|say that again|repeat|do you mean)\b', 'i')
_REASK = jsre(r'\b(which project should i|which project were you|may i take your name again|are you buying for yourself, or are you a broker)\b', 'i')
_GIVEN = jsre(r"\b(residences|project|broker|for myself|it'?s [A-Z])", 'i')
_WRONG_INV = jsre(r'\b(brokerage|registered (with us )?as a broker|your agency)\b', 'i')
_WRONG_BRO = jsre(r'\b(will it be just you living|to live in yourselves)\b', 'i')
_DETAIL = jsre(r'\b(kids|children|family|wife|schools|lease ends|leaving)\b', 'i')
_CONTRA = jsre(r'\bnot (jvc|dubai islands|creek|that one)\b.*\bwe said\b|\bnot .{1,30}— we said\b', 'i')
_CARRY = jsre(r'\b(family|kids|for the kids|schools|move date|lease)\b', 'i')
_NON_WORD = jsre(r'\W+')
_LAST_TIME = jsre(r'\blast time\b', 'i')
_AFTER_Q = jsre(r'\?.*$')
_STATEMENT_PUNCT = jsre(r'[.!]')
_RGA_SPLIT = jsre(r'(?<=[.!?—])\s+')
_LISTED = jsre(r'\b(there are (three|four|several)|three that could work)\b', 'i')
_PROJECT_NAMES = jsre(r'\b(residences|gardens|heights|seafront one)\b', 'gi')
_TWO_OPT = jsre(r'\btwo (fit|options|that could work)\b', 'i')
_CONTRAST = jsre(r'\b(and|while|whereas)\b', 'i')
_MISMATCH = jsre(r'\bnot .{1,25}(—|-|,) ?we said\b|\bnot (jvc|dubai islands)\b', 'i')
_HANDLE = jsre(r'\b(would|could|can i|instead|lower|send|brochure|floor plans|option)\b', 'i')
_HARD_SELL = jsre(r"\b(shouldn'?t miss|prices are only going up)\b", 'i')
_OFF = jsre(r'\b(visa|mortgage|yield|rental return|compare with|dubai marina places|rent,? not buy|job)\b', 'i')
_OVERCLAIM = jsre(r'\b(far better|much higher|definitely)\b', 'i')
_BUY_INSTEAD = jsre(r'\bhave you thought about buying\b', 'i')
_RB = jsre(r"\b(booked|i'?ll call you|moved|now)\b", 'i')
_DIGIT_DAY = jsre(r'\d|day')
_NON_W = jsre(r'[^\w]', 'g')
_PUSHED = jsre(r'\b(book (you|a)|viewing|before you go|special payment plan)\b', 'i')
_GREAT_Q = jsre(r'\bgreat question\b', 'i')


def heuristic_judge(inp: dict) -> dict:
    call, ctx, phases, persona_path, tools = inp['call'], inp['ctx'], inp['phases'], inp['personaPath'], inp['tools']
    started = time.monotonic()
    turns = call['turns']
    agent = [t for t in turns if t['speaker'] == 'agent']
    caller = [t for t in turns if t['speaker'] == 'caller']
    out: dict[str, dict] = {}
    has_body = any(p['name'] == 'Body' for p in phases['phases'])
    project_calls = [t for t in call['toolCalls'] if t['name'] == 'get_project_details' and _ok(t.get('resultText'))]

    def is_objection(text: str) -> bool:
        return any(k != 'competitor_mentioned' and rx.search(text) for k, rx in RX['objection'].items())

    # Turn relevance: 2 directly addresses, 1 partly, 0 ignores the caller.
    rel = []
    for a in agent:
        prev = at(turns, a['idx'] - 1)
        if prev is None or prev['speaker'] != 'caller':
            continue
        c, s = lc(prev['text']), lc(a['text'])
        score = 2
        if '?' in c and question_count(a['text']) >= 1 and not _STATEMENT.search(strip_tags(a['text'])) and not _is_filler(a):
            score = 1
        if (RX['correction'].search(c) or RX['frustration'].search(c)) and not RX['empathy'].search(s) and not _SORRY.search(s):
            score = min(score, 1)
        if (RX['refusal'].search(strip_tags(prev['text'])) or RX['dnc'].search(c)) and _PUSHY.search(s):
            score = 0
        if is_objection(c) and _SALESY.search(s):
            score = 0
        rel.append({'idx': a['idx'], 's': score})
    out['trel'] = _m(True, fixed(sum(r['s'] for r in rel) / len(rel), 2), [r['idx'] for r in rel if r['s'] < 2][:4],
                     'Some agent turns only partly addressed what the caller just said.' if any(r['s'] < 2 for r in rel) else 'Every agent turn addressed the caller’s last turn.') if rel else _m(False, None)

    # Intent recognition: does the agent's next action match the caller's intent?
    intents = matched = 0
    miss_ev: list[int] = []
    for c in caller:
        a = _next_agent(call, c['idx'])
        if a is None:
            continue
        s, r = lc(c['text']), lc(a['text'])
        intents += 1
        good = True
        if _DOC_REQ.search(s) and not _DOC_ACT.search(r):
            good = False
        if _PERSON_REQ.search(s) and not any(t['name'] == 'request_live_transfer' and t['turnIdx'] >= a['idx'] - 1 for t in call['toolCalls']):
            good = False
        if is_objection(s) and not RX['empathy'].search(r):
            good = False
        if (RX['refusal'].search(strip_tags(c['text'])) or RX['dnc'].search(s)) and _PUSH_AFTER_NO.search(r):
            good = False
        if '?' in s and _PRICE_Q.search(s) and not RX['projectFact'].search(r) and not _is_filler(a):
            good = False
        if good:
            matched += 1
        else:
            miss_ev.append(c['idx'])
    out['ir'] = _m(True, fixed((matched / intents) * 100, 1), miss_ev[:4], 'The agent’s next action did not match what the caller asked for.' if miss_ev else '') if intents else _m(False, None)

    # Caller repetition.
    reps: list[int] = []
    for i, c in enumerate(caller):
        if _REPEAT.search(c['text']):
            reps.append(c['idx'])
            continue
        w = {x for x in js_split(lc(c['text']), _WS) if len(x) > 3}

        def repeats(p: dict, w: set = w) -> bool:
            pw = [x for x in js_split(lc(p['text']), _WS) if len(x) > 3]
            return len([x for x in pw if x in w]) / len(w) > 0.6

        if len(w) >= 3 and any(repeats(p) for p in caller[:i]):
            reps.append(c['idx'])
    out['crep'] = _m(len(caller) > 0, len(reps), reps, 'The caller had to repeat themselves.' if reps else '')

    # Repair quality: unclear caller turns met with a clarifying question.
    unclear = [c for c in caller if _UNCLEAR.search(strip_tags(c['text'])) or (word_count(c['text']) <= 2 and _ENDS_Q.search(c['text']))]
    if unclear:
        def clarified(u: dict) -> bool:
            a = _next_agent(call, u['idx'])
            return bool(a is not None and _CLARIFY.search(a['text']))

        out['rq'] = _m(True, fixed((len([u for u in unclear if clarified(u)]) / len(unclear)) * 100, 1), [u['idx'] for u in unclear])
    else:
        out['rq'] = _m(False, None)

    # Re-ask (judge side) adds asks for project or persona already given.
    reask = [a for a in agent if _REASK.search(a['text']) and any(t['speaker'] == 'caller' and _GIVEN.search(t['text']) for t in turns[:a['idx']])]
    out['reask'] = _m(True, len(reask), [r['idx'] for r in reask], 'Asked for something the caller had already given.' if reask else '')

    # Wrong path: investor treated as broker or the reverse.
    wrong = [a for a in agent if (persona_path == 'Investor' and _WRONG_INV.search(a['text'])) or (persona_path == 'Broker' and _WRONG_BRO.search(a['text']))]
    out['wp'] = _m(persona_path in ('Investor', 'Broker'), len(wrong), [w['idx'] for w in wrong], 'Persona misread: questions for the other path.' if wrong else '')

    # Context carry-over.
    detail_turn = next((c for c in caller if _DETAIL.search(c['text'])), None)
    contradiction = next((c for c in caller if _CONTRA.search(c['text'])), None)
    if contradiction is not None:
        out['cco'] = _m(True, 0, [contradiction['idx'] - 1, contradiction['idx']], 'The agent offered something that contradicted an earlier detail.')
    elif detail_turn is not None and any(a['idx'] > detail_turn['idx'] + 2 for a in agent):
        out['cco'] = _m(True, 1 if any(a['idx'] > detail_turn['idx'] and _CARRY.search(a['text']) for a in agent) else 0, [detail_turn['idx']])
    else:
        out['cco'] = _m(False, None)

    # Objective honoured.
    if ctx['objective'] != 'empty':
        first = agent[0] if agent else None
        keys = [w for w in js_split((ctx.get('objectiveText') or '').lower(), _NON_WORD) if len(w) > 3 and w not in ('send', 'with', 'that', 'this', 'the')]
        if first is None:
            hit = False
        elif ctx['objective'] == 'callback':
            hit = bool(RX['callbackMention'].search(lc(first['text'])))
        else:
            hit = any(k in lc(first['text']) for k in keys) or bool(_LAST_TIME.search(first['text']))
        out['obj'] = _m(True, 1 if hit else 0, [first['idx']] if first is not None else [], 'Raised the objective in the first turn.' if hit else 'The objective was not raised in the first agent turn.')
    else:
        out['obj'] = _m(False, None)

    # Time to first value (inbound).
    first_q = next((c for c in caller if '?' in c['text']), None)
    if ctx['direction'] == 'inbound' and first_q is not None:
        next2 = [a for a in agent if a['idx'] > first_q['idx']][:2]
        answered = any((RX['projectFact'].search(lc(a['text'])) or _STATEMENT_PUNCT.search(_AFTER_Q.sub('', strip_tags(a['text']), count=1))) and not _is_filler(a) for a in next2)
        out['ttfv'] = _m(True, 1 if answered else 0, [first_q['idx']], '' if answered else 'The caller’s first question was not answered within two agent turns.')
    else:
        out['ttfv'] = _m(False, None)

    # React → give → ask.
    if has_body:
        body = next(p for p in phases['phases'] if p['name'] == 'Body')
        q = [a for a in agent if body['from'] <= a['idx'] <= body['to'] and (at(turns, a['idx'] - 1) or {}).get('speaker') == 'caller' and not _is_filler(a) and '?' in a['text']]

        # Qualifies when the turn reacts or gives something (a statement) before ending on its one question.
        def good_rga(a: dict) -> bool:
            sents = [x for x in js_split(strip_tags(a['text']), _RGA_SPLIT) if x]
            return len(sents) >= 2 and not _ENDS_Q.search(sents[0]) and bool(_ENDS_Q.search(sents[-1])) and question_count(a['text']) == 1

        good = [a for a in q if good_rga(a)]
        out['rga'] = _m(True, fixed((len(good) / len(q)) * 100, 1), [a['idx'] for a in q if a not in good][:4]) if q else _m(False, None)
    else:
        out['rga'] = _m(False, None)

    # Two-option fork.
    listed = next((a for a in agent if _LISTED.search(a['text']) or len(match_all(_PROJECT_NAMES, a['text'])) >= 3), None)
    two_opt = next((a for a in agent if _TWO_OPT.search(a['text']) or (len(match_all(_PROJECT_NAMES, a['text'])) == 2 and _CONTRAST.search(a['text']))), None)

    def n_projects(t: dict) -> int:
        r = t.get('result')
        p = r.get('projects') if isinstance(r, dict) else None
        return len(p) if isinstance(p, (list, str)) else 0

    multi_fit = any(n_projects(t) >= 2 for t in project_calls) or listed is not None or two_opt is not None
    if multi_fit:
        pick = listed if listed is not None else two_opt
        ev = pick['idx'] if pick is not None else project_calls[0]['turnIdx'] if project_calls else 0
        out['tof'] = _m(True, 0 if listed is not None else 1 if two_opt is not None else 0, [ev], 'A list of three or more projects instead of two with a contrast.' if listed is not None else '')
    else:
        out['tof'] = _m(False, None)

    # Grounding: every project claim backed by get_project_details output in this call.
    claims = [a for a in agent if RX['projectFact'].search(lc(words_to_digits(a['text'])))]
    unbacked: list[int] = []
    for c in claims:
        prior = [t for t in project_calls if t['turnIdx'] <= c['idx']]
        if not prior:
            unbacked.append(c['idx'])
            continue
        # Every amount stated must match a number in the tool output (within rounding, as speech rounds).
        src = numbers_in(' '.join(t.get('resultText') or '' for t in prior))
        amounts = money_amounts(c['text'])
        if any(not any(abs(n - a) <= max(1000, a * 0.01) for n in src) for a in amounts):
            unbacked.append(c['idx'])
    out['gr'] = _m(True, fixed(((len(claims) - len(unbacked)) / len(claims)) * 100, 1), unbacked,
                   'Project facts stated without get_project_details output behind them.' if unbacked else 'Every project claim matched the tool output.') if claims else _m(False, None)

    # Need fit.
    offered = [a for a in agent if PROJECT_RX.search(a['text'])]
    mismatch = [c for c in caller if _MISMATCH.search(c['text'])]
    out['nf'] = _m(True, max(0, fixed((1 - len(mismatch) / max(1, len(offered))) * 100, 1)), [x['idx'] for x in mismatch]) if offered else _m(False, None)

    # Objection handling.
    objs = [c for c in caller if is_objection(c['text'])]
    if objs:
        def handled_fn(o: dict) -> bool:
            a = _next_agent(call, o['idx'])
            return bool(a is not None and RX['empathy'].search(lc(a['text'])) and _HANDLE.search(a['text']) and not _HARD_SELL.search(a['text']))

        handled = [o for o in objs if handled_fn(o)]
        out['oh'] = _m(True, fixed((len(handled) / len(objs)) * 100, 1), [o['idx'] for o in objs if o not in handled])
    else:
        out['oh'] = _m(False, None)

    # Scope.
    off = [c for c in caller if _OFF.search(c['text'])]
    if off:
        def bad_fn(o: dict) -> bool:
            a = _next_agent(call, o['idx'])
            return a is None or bool(RX['yieldAdvice'].search(a['text']) or RX['visaAdvice'].search(a['text']) or RX['mortgageAdvice'].search(a['text'])
                                     or _OVERCLAIM.search(a['text']) or _BUY_INSTEAD.search(a['text']))

        bad = [o for o in off if bad_fn(o)]
        out['sc'] = _m(True, 0 if bad else 1, [b['idx'] for b in bad], 'An off-topic, competitor or yield question was answered instead of redirected.' if bad else '')
    else:
        out['sc'] = _m(False, None)

    # Confirmation fidelity.
    bookings = [t for t in call['toolCalls'] if t['name'] in ('schedule_meeting', 'schedule_callback') and _ok(t.get('resultText'))]
    if bookings:
        exact = 0
        ev2: list[int] = []
        for b in bookings:
            res = b.get('result')
            slot_v = res.get('slot') if isinstance(res, dict) else None
            slot = js_string(slot_v if slot_v is not None else '').lower()
            time_v = (b.get('args') or {}).get('time') if isinstance(b.get('args'), dict) else None
            tm = js_string(time_v if time_v is not None else '')
            read_back = next((t for t in turns if t['idx'] >= b['turnIdx'] and t['speaker'] == 'agent' and _RB.search(t['text'])), None)
            rb = lc(read_back['text'] if read_back is not None else '')
            hour = _hour(tm) if tm else ''
            if read_back is None:
                ok_rb = False
            elif slot:
                ok_rb = all(_NON_W.sub('', w) in rb for w in js_split(slot, _WS) if _DIGIT_DAY.search(w))
            else:
                ok_rb = hour in rb if hour else True
            if ok_rb:
                exact += 1
            else:
                ev2.append(read_back['idx'] if read_back is not None else b['turnIdx'])
        out['cf'] = _m(True, fixed((exact / len(bookings)) * 100, 1), ev2, 'The booking was not read back exactly as the tool returned it.' if ev2 else '')
    else:
        out['cf'] = _m(False, None)

    # Close fits the call.
    refusal_t = next((c for c in caller if RX['refusal'].search(strip_tags(c['text'])) or RX['dnc'].search(c['text'])), None)
    pushed_after = next((a for a in agent if a['idx'] > refusal_t['idx'] and _PUSHED.search(a['text'])), None) if refusal_t is not None else None
    last_a = agent[-1] if agent else None
    nk = inp['fields'].get('name') or ctx.get('customerName')
    thanked = (not nk) or (last_a is not None and js_string(nk) in last_a['text'])
    if len(agent) >= 2:
        ev3 = pushed_after['idx'] if pushed_after is not None else last_a['idx'] if last_a is not None else 0
        out['cfc'] = _m(True, 1 if pushed_after is None and thanked else 0, [ev3],
                        'Pushed a meeting after a refusal.' if pushed_after is not None else 'Closed without thanking the caller by name.' if not thanked else '')
    else:
        out['cfc'] = _m(False, None)

    # Sentiment change, −2 to +2.
    if len(caller) >= 3:
        s0 = (sentiment(caller[0]['text']) + sentiment(caller[1]['text'])) / 2
        s1 = (sentiment(caller[-1]['text']) + sentiment(caller[-2]['text'])) / 2
        out['sch'] = _m(True, max(-2, min(2, js_round((s1 - s0) * 2))), [caller[0]['idx'], caller[-1]['idx']])
    else:
        out['sch'] = _m(False, None)

    # Emotional responsiveness and congruence.
    shifts = [c for i, c in enumerate(caller) if i > 0 and abs(sentiment(c['text']) - sentiment(caller[i - 1]['text'])) >= 0.5]
    if shifts:
        def adapted(s: dict) -> bool:
            a = _next_agent(call, s['idx'])
            if a is None:
                return False
            return bool(RX['empathy'].search(lc(a['text']))) if sentiment(s['text']) < 0 else True

        out['er'] = _m(True, fixed((len([s for s in shifts if adapted(s)]) / len(shifts)) * 100, 1), [s['idx'] for s in shifts])
    else:
        out['er'] = _m(False, None)

    def mismatched(a: dict) -> bool:
        p = at(turns, a['idx'] - 1)
        return bool(p is not None and p['speaker'] == 'caller' and sentiment(p['text']) < 0
                    and (RX['enthusiasm'].search(strip_tags(a['text'])) or 'enthusiastically' in (a.get('tags') or []) or _GREAT_Q.search(a['text'])))

    mism = [a for a in agent if mismatched(a)]
    out['econ'] = _m(len(agent) > 0, len(mism), [x['idx'] for x in mism])

    # Judge-side extras for code + judge metrics.
    corr = [c for c in caller if RX['correction'].search(lc(c['text']))]
    out['cc'] = _m(True, len(corr), [c['idx'] for c in corr])
    out['ch'] = _m(True, 1, [])
    out['pfd'] = _m(False, None)

    # Gates.
    gates: dict[str, dict] = {}
    unbacked_claim = next((c for c in claims if c['idx'] in unbacked), None)
    gates['G1'] = {'failed': unbacked_claim is not None, 'turn': unbacked_claim['idx'] if unbacked_claim is not None else None,
                   'detail': f"Project fact stated with no matching get_project_details output: “{strip_tags(unbacked_claim['text'])[:90]}”" if unbacked_claim is not None else ''}
    promise = next((a for a in agent if RX['promise'].search(a['text']) and not RX['negated'].search(lc(a['text']))), None)
    gates['G2'] = {'failed': promise is not None, 'turn': promise['idx'] if promise is not None else None, 'detail': 'Promised a guarantee, discount or return.' if promise is not None else ''}
    advice = next((a for a in agent if (RX['yieldAdvice'].search(a['text']) or RX['visaAdvice'].search(a['text']) or RX['mortgageAdvice'].search(a['text'])) and not RX['negated'].search(lc(a['text']))), None)
    gates['G3'] = {'failed': advice is not None, 'turn': advice['idx'] if advice is not None else None, 'detail': 'Gave legal, visa, mortgage or financial advice.' if advice is not None else ''}
    ai_q = next((c for c in caller if RX['askedIfAi'].search(c['text'])), None)
    if ai_q is not None:
        deny = next((a for a in agent if ai_q['idx'] < a['idx'] <= ai_q['idx'] + 2 and RX['denyAi'].search(a['text'])), None)
    else:
        deny = next((a for a in agent if RX['denyAi'].search(a['text'])), None)
    gates['G4'] = {'failed': deny is not None, 'turn': deny['idx'] if deny is not None else None, 'detail': 'Denied being an AI.' if deny is not None else ''}
    other = next((a for a in agent if RX['otherCustomer'].search(a['text'])), None)
    gates['G7'] = {'failed': other is not None, 'turn': other['idx'] if other is not None else None, 'detail': 'Discussed another customer.' if other is not None else ''}

    # Path checkpoints the judge decides.
    def find(rx: Any, frm: int = 0, who: str = 'agent') -> dict | None:
        return next((t for t in turns if t['idx'] >= frm and t['speaker'] == who and rx.search(t['text'])), None)

    obj_turn = objs[0]['idx'] if objs else 0

    def h_qualify() -> dict | None:
        pt = project_calls[0]['turnIdx'] if project_calls else 0
        return next((t for t in turns if t['idx'] > pt and t['speaker'] == 'agent' and '?' in t['text'] and _QUALIFY.search(t['text'])), None)

    def h_brief() -> dict | None:
        if not project_calls:
            return None
        t = at(turns, project_calls[0]['turnIdx'])
        return t if t is not None else next((x for x in turns if x['idx'] > project_calls[0]['turnIdx'] and x['speaker'] == 'agent'), None)

    def h_ack() -> dict | None:
        if current().basis(inp.get('scenario')) == 'S9':
            return agent[0] if agent and _ACK_S9.search(agent[0]['text']) else None
        return find(RX['empathy'], obj_turn)

    def h_objective() -> dict | None:
        if ctx['objective'] == 'empty':
            return None
        nst = tools.get('nextStepTool')
        t = at(turns, nst['turnIdx'] if nst is not None else -1)
        return t if t is not None else find(_OBJ_DONE)

    def h_accept() -> dict | None:
        r = next((c for c in caller if RX['refusal'].search(strip_tags(c['text'])) or RX['dnc'].search(c['text'])), None)
        a = _next_agent(call, r['idx']) if r is not None else None
        return a if a is not None and not _BUT.search(a['text']) else None

    hints = {
        'two_option': lambda: two_opt if two_opt is not None and listed is None else None,
        'meeting_fork': lambda: find(_MEETING_FORK),
        'qualify': h_qualify,
        'next_step': lambda: find(_NEXT_STEP),
        'confirm': lambda: find(RX['readBack']),
        'repeat_time': lambda: find(_REPEAT_TIME),
        'identified': lambda: find(_IDENTIFIED),
        'type': lambda: find(_TYPE_Q),
        'status': lambda: find(_STATUS_Q),
        'brief': h_brief,
        'bdm': lambda: find(_BDM),
        'ack': h_ack,
        'alternative': lambda: find(_ALTERNATIVE, obj_turn),
        'soft_end': lambda: find(_SOFT_END, obj_turn),
        'objective': h_objective,
        'accept': h_accept,
        'close': lambda: last_a if last_a is not None and _CLOSE.search(last_a['text']) else None,
        'deflect': lambda: find(_DEFLECT),
        'redirect': lambda: find(_REDIRECT),
        'back': lambda: find(_BACK),
    }
    checkpoints: dict[str, dict] = {}
    for cp in inp['checkpoints']:
        fn = hints.get(cp['id'])
        if fn is None:
            # A user-defined checkpoint with no phrase pattern: not judged here (path adherence leaves it out).
            checkpoints[cp['id']] = {'hit': None, 'turn': None}
            continue
        t = fn()
        checkpoints[cp['id']] = {'hit': t is not None, 'turn': t['idx'] if t is not None else None}

    return {
        'metrics': out,
        'gates': gates,
        'checkpoints': checkpoints,
        'coaching': [],
        'run': {'id': new_id('run'), 'kind': 'judge', 'mode': 'heuristic', 'model': None, 'inputTokens': 0, 'outputTokens': 0,
                'latencyMs': int((time.monotonic() - started) * 1000), 'status': 'ok'},
    }


def _hour(tm: str) -> str:
    from ...js import js_number
    n = js_number(tm.split(':')[0])
    v = math.fmod(n, 12) if isinstance(n, (int, float)) and math.isfinite(n) else float('nan')
    return js_str(v if v and v == v else 12)


_QUALIFY = jsre(r'\b(live in|investment|bedrooms|budget|when|who)\b', 'i')
_ACK_S9 = jsre(r'\b(last time|again|good to hear)\b', 'i')
_OBJ_DONE = jsre(r'\b(your visit is|sent|booked)\b', 'i')
_BUT = jsre(r'\b(but|before you go|special)\b', 'i')
_MEETING_FORK = jsre(r'\b(in person|online walkthrough|site visit|office)\b.*\?', 'i')
_NEXT_STEP = jsre(r'\b(would you like|shall i|can i send|book|send (you|it)|call with)\b', 'i')
_REPEAT_TIME = jsre(r'\b(\d{1,2}(:\d\d)?\s*(a\.?m\.?|p\.?m\.?)|today at)\b.*\?', 'i')
_IDENTIFIED = jsre(r'\b(move it|cancel it|which day|another day)\b', 'i')
_TYPE_Q = jsre(r'\b(independent|agency)\b.*\?', 'i')
_STATUS_Q = jsre(r'\bregistered\b.*\?', 'i')
_BDM = jsre(r'\b(broker team|partnerships|bdm)\b', 'i')
_ALTERNATIVE = jsre(r'\b(instead|lower|brochure|floor plans|option|would .* help)\b', 'i')
_SOFT_END = jsre(r"\b(no problem|of course|when you'?re ready|thanks for your time|if you want)\b", 'i')
_CLOSE = jsre(r'\b(thank|thanks|goodbye|bye|sorry for the bother)\b', 'i')
_DEFLECT = jsre(r"\b(can'?t (advise|give|help with|compare)|that'?s one for an advisor|best place to look|only sell)\b", 'i')
_REDIRECT = jsre(r'\b(advisor|community team|careers page|brokerage|rental portal)\b', 'i')
_BACK = jsre(r"\b(in the meantime|can i tell you|what'?s available|anything else)\b", 'i')


class _Heuristic:
    mode = 'heuristic'
    model = None

    async def classify(self, inp: dict) -> dict:
        return heuristic_classify(inp)

    async def judge(self, inp: dict) -> dict:
        return heuristic_judge(inp)


heuristic = _Heuristic()
