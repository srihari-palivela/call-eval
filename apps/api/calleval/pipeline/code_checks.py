# Step 5: code checks. Counts, timings, tool order and duplicates, banned phrases, time limit —
# everything measurable without judging the meaning of the words.

from __future__ import annotations

import math
from typing import Any

from ..framework import ALLOWED_DELIVERY_TAGS, BANNED_PHRASES, BROKER_DISCOVERY, INVESTOR_DISCOVERY, median, quantile
from ..js import at, fixed, is_finite, js_json, js_round, js_split, js_str, jsre, match_all, replace_first, to_fixed
from ..taxonomy import basis
from .text import BUYER_DISCOVERY_RX, FIELD_ASK_RX, RX, has_new_contact, js_string, lc, question_count, sentiment, strip_tags, turn_end, word_count

# RawMetric: {raw, applicable, evidence, rationale?, value?}; CodeGate: {id, failed, turn, detail}
# ToolAnalysis: {expected: [{tool, turn, reason, met}], made: [{tc, correct, argsOk, seqOk, fidelityOk, prompt, why}],
#   nextStep, nextStepTool, meetingKind, deadAir: [{turn, gap, tool}]}

_FAILED = jsre(r'\b(fail|failed|error|unavailable)\b', 'i')


def _has(o: dict, k: str) -> bool:
    v = o.get(k)
    return v is not None and v != ''


def _ok_result(tc: dict) -> bool:
    return tc.get('ok') is not False and not _FAILED.search(tc.get('resultText') or '')


def _pct(a: float, b: float) -> float | None:
    return (a / b) * 100 if b else None


def _na() -> dict:
    return {'raw': None, 'applicable': False, 'evidence': []}


def _response_latencies(call: dict) -> list[dict]:
    out = []
    for t in call['turns']:
        if t['speaker'] != 'agent':
            continue
        prev = at(call['turns'], t['idx'] - 1)
        if prev is None or prev['speaker'] != 'caller':
            continue
        lat = t['latencyS'] if t.get('latencyS') is not None else t['startS'] - turn_end(prev)
        if is_finite(lat) and -2 < lat < 60:
            out.append({'turn': t['idx'], 'lat': max(0, lat)})
    return out


_NAME_GIVEN = jsre(r"\b(it'?s|i'?m|my name is|this is) [A-Z][a-z]+\b")
_CONTACT = jsre(r'@|\b\d{7,}\b')
_DOC_ASK = jsre(r'\b(send (me|it|over)|brochure|floor plans?)\b', 'i')
_NO = jsre(r'\bno\b')
_CALL_LATER = jsre(r'\b(call me (back|later)|call back later|can you call me)\b', 'i')
_PERSON = jsre(r'\b(speak to (a|someone|an?) (person|human|advisor|agent)|real person|transfer me)\b', 'i')
_CANCEL = jsre(r'\bcancel (it|the (visit|meeting))\b', 'i')
_UNREG = jsre(r"\b(no,? not yet|not registered|aren'?t registered)\b", 'i')
_TRANSFER_TO = jsre(r'transfer_to', 'i')
_NOT_YET = jsre(r'\b(not yet|not registered)\b', 'i')
_ASKED = jsre(r'\b(yes|send|brochure|floor plan|please)\b', 'i')
_CONFIRMED = jsre(r'\b(yes|that one|correct|right|fine)\b', 'i')
_FORK_Q = jsre(r'\b(in person|online|walkthrough|office|site visit)\b.*\?', 'i')
_REGISTERED = jsre(r'registered', 'i')
_TIME_REPEAT = jsre(r'\b(\d{1,2}(:\d\d)?\s*(a\.?m\.?|p\.?m\.?)|today at|tomorrow at)\b.*\?', 'i')
_NAME_SAID = jsre(r"\b(it'?s|my name is|i'?m) [A-Z][a-z]+")
_FAREWELL = jsre(r'\b(goodbye|bye|have a (good|great|nice))\b', 'i')
_CLAIMS_SUCCESS = jsre(r"\b(done|sent|booked|you'?re (all )?(booked|set)|cancell?ed|on (its|your) way|putting you through|connecting you)\b", 'i')
_SAYS_FAILURE = jsre(r"\b(didn'?t go through|instead|not available|nobody is free|has just gone|couldn'?t|sorry)\b", 'i')
_DNC_NOTE = jsre(r'do-not-contact|dnc', 'i')


def analyse_tools(call: dict, ctx: dict, persona_path: str) -> dict:
    turns = call['turns']
    tcs = call['toolCalls']
    expected: list[dict] = []
    made: list[dict] = []

    def called_before(name: str, idx: int) -> bool:
        return any(tc['name'] == name and tc['turnIdx'] <= idx and _ok_result(tc) for tc in tcs)

    # Expected calls: every moment a tool's trigger fired.
    for t in turns:
        s = lc(t['text'])
        if t['speaker'] == 'agent' and RX['projectFact'].search(s):
            expected.append({'tool': 'get_project_details', 'turn': t['idx'], 'reason': 'Project fact stated', 'met': called_before('get_project_details', t['idx'])})
        if t['speaker'] != 'caller':
            continue

        def within(name: str, n: int = 2, t: dict = t) -> bool:
            later_agents = [x for x in turns if x['idx'] > t['idx'] and x['speaker'] == 'agent']
            nth = at(later_agents, n - 1)
            limit = nth['idx'] if nth is not None else math.inf
            return any(tc['name'] == name and t['idx'] < tc['turnIdx'] <= limit for tc in tcs)

        if _NAME_GIVEN.search(strip_tags(t['text'])) or _CONTACT.search(t['text']):
            expected.append({'tool': 'update_caller_details', 'turn': t['idx'], 'reason': 'Caller gave a contact detail', 'met': within('update_caller_details', 1)})
        if _DOC_ASK.search(s) and not _NO.search(s):
            expected.append({'tool': 'send_documents', 'turn': t['idx'], 'reason': 'Caller asked for a document', 'met': within('send_documents', 3)})
        if _CALL_LATER.search(s):
            expected.append({'tool': 'schedule_callback', 'turn': t['idx'], 'reason': 'Caller asked to be called later', 'met': within('schedule_callback', 4)})
        if _PERSON.search(s):
            expected.append({'tool': 'request_live_transfer', 'turn': t['idx'], 'reason': 'Caller wants a person now', 'met': within('request_live_transfer', 2)})
        if _CANCEL.search(s):
            expected.append({'tool': 'cancel_meeting', 'turn': t['idx'], 'reason': 'Caller cancelled', 'met': within('cancel_meeting', 2)})
        if persona_path == 'Broker' and _UNREG.search(s):
            expected.append({'tool': 'send_broker_registration_link', 'turn': t['idx'], 'reason': 'Unregistered broker', 'met': within('send_broker_registration_link', 2)})
    transfer_to = next((tc for tc in tcs if tc['name'] == 'request_live_transfer' and _TRANSFER_TO.search(tc.get('resultText') or '')), None)
    if transfer_to is not None:
        expected.append({'tool': 'transfer_to_number', 'turn': transfer_to['turnIdx'], 'reason': 'request_live_transfer returned transfer_to', 'met': any(tc['name'] == 'transfer_to_number' for tc in tcs)})
    if call.get('endReason') == 'natural_close' and call.get('provider') != 'upload':
        last = at(turns, len(turns) - 1)
        expected.append({'tool': 'end_call', 'turn': last['idx'] if last is not None else 0, 'reason': 'Conclusion finished', 'met': any(tc['name'] == 'end_call' for tc in tcs)})

    # Calls made, checked against the tool map.
    seen_docs: set[str] = set()
    for tc in tcs:
        a: dict = tc.get('args') or {}
        why: list[str] = []
        correct = args_ok = seq_ok = True
        fidelity_ok: bool | None = None
        prompt: bool | None = None
        before = [t for t in turns if t['idx'] < tc['turnIdx']][-4:]
        at_turn = at(turns, tc['turnIdx'])
        name = tc['name']
        if name == 'send_broker_registration_link':
            if persona_path != 'Broker':
                correct = False
                why.append('Called for a non-broker')
            if 'registered' not in a:
                args_ok = False
                why.append('registered missing')
            if not _has(a, 'channel'):
                args_ok = False
                why.append('channel missing')
            prompt = not any(t['speaker'] == 'caller' and t['idx'] < tc['turnIdx'] - 4 and _NOT_YET.search(t['text']) for t in turns)
        elif name == 'send_documents':
            pid = a.get('project_ids') if a.get('project_ids') is not None else a.get('project_id') if a.get('project_id') is not None else ''
            dt = a.get('doc_type')
            key = js_json(pid) + js_string(dt if dt is not None else '')
            if key in seen_docs:
                correct = False
                why.append('Duplicate send')
            seen_docs.add(key)
            asked = any(t['speaker'] == 'caller' and _ASKED.search(t['text']) for t in before)
            if not asked:
                correct = False
                why.append('Unsolicited send')
            if not _has(a, 'channel'):
                args_ok = False
                why.append('channel missing')
            # The destination must be named before the send ("the number ending 47", "this number").
            # A number or email the caller has just given must also be read back and confirmed.
            named = any(t['speaker'] == 'agent' and tc['turnIdx'] - 4 <= t['idx'] <= tc['turnIdx'] and RX['readBack'].search(t['text']) for t in turns)
            confirmed = any(t['speaker'] == 'caller' and _CONFIRMED.search(t['text']) for t in before)
            fresh = any(t['speaker'] == 'caller' and t['idx'] < tc['turnIdx'] and has_new_contact(t['text']) for t in turns)
            if not named or (fresh and not confirmed):
                seq_ok = False
                why.append('No read-back before the send')
        elif name == 'schedule_meeting':
            mk = a.get('meeting_kind')
            kind = js_string(mk if mk is not None else '')
            if kind not in ('site_visit', 'online', 'office', 'bdm_call'):
                args_ok = False
                why.append('meeting_kind missing or unknown')
            if not _has(a, 'date') or not _has(a, 'time'):
                args_ok = False
                why.append('date or time missing')
            if kind == 'site_visit' and not (isinstance(a.get('project_ids'), list) and len(a['project_ids'])):
                args_ok = False
                why.append('site visit without a project')
            if persona_path == 'Investor' and not any(t['speaker'] == 'agent' and t['idx'] <= tc['turnIdx'] and _FORK_Q.search(t['text']) for t in turns):
                seq_ok = False
                why.append('Meeting fork skipped')
            if persona_path == 'Broker' and not any(x['name'] == 'send_broker_registration_link' and x['turnIdx'] <= tc['turnIdx'] for x in tcs) \
                    and not _REGISTERED.search(' '.join(t['text'] for t in turns if t['speaker'] == 'caller')):
                seq_ok = False
                why.append('Registration link not sent first')
        elif name == 'schedule_callback':
            if not _has(a, 'time'):
                args_ok = False
                why.append('time missing')
            if not any(t['speaker'] == 'agent' and _TIME_REPEAT.search(t['text']) for t in before):
                seq_ok = False
                why.append('Time not repeated back')
        elif name == 'request_live_transfer':
            if not (at_turn is not None and at_turn['speaker'] == 'agent' and tc.get('startS') is not None and tc['startS'] >= at_turn['startS'] - 0.01):
                seq_ok = False
                why.append('No filler line before the transfer request')
        elif name == 'transfer_to_number':
            req = next((x for x in tcs if x['name'] == 'request_live_transfer' and _TRANSFER_TO.search(x.get('resultText') or '')), None)
            if req is None:
                correct = False
                why.append('No transfer_to result before it')
        elif name == 'update_caller_details':
            if any(k in ('budget', 'bedrooms', 'location') for k in a):
                correct = False
                why.append('Used for budget, bedrooms or location')
            given_l = [t for t in turns if t['speaker'] == 'caller' and t['idx'] < tc['turnIdx'] and _NAME_SAID.search(strip_tags(t['text']))]
            given = given_l[-1] if given_l else None
            if given is not None:
                between = len([t for t in turns if t['speaker'] == 'agent' and given['idx'] < t['idx'] <= tc['turnIdx']])
                prompt = between <= 1
        elif name == 'end_call':
            last_l = [t for t in turns if t['speaker'] == 'agent' and t['idx'] <= tc['turnIdx']]
            last = last_l[-1] if last_l else None
            if last is None or not _FAREWELL.search(last['text']):
                seq_ok = False
                why.append('Ended without a farewell')
            if any(x['name'] == 'request_live_transfer' and _TRANSFER_TO.search(x.get('resultText') or '') for x in tcs) and not any(x['name'] == 'transfer_to_number' for x in tcs):
                correct = False
                why.append('Ended during a transfer')
        # Result fidelity: what the agent says next must match what the tool returned.
        next_agent = [t for t in turns if t['speaker'] == 'agent' and t['idx'] >= tc['turnIdx']][:2]
        if tc.get('resultText') is not None and next_agent and name != 'end_call':
            claims_success = any(_CLAIMS_SUCCESS.search(t['text']) for t in next_agent)
            says_failure = any(_SAYS_FAILURE.search(t['text']) for t in next_agent)
            fidelity_ok = True if _ok_result(tc) else (not claims_success or says_failure)
            if not _ok_result(tc) and claims_success and not says_failure:
                why.append('Claimed success after a failed result')
        made.append({'tc': tc, 'correct': correct, 'argsOk': args_ok, 'seqOk': seq_ok, 'fidelityOk': fidelity_ok, 'prompt': prompt, 'why': why})

    # Next step secured: a meeting, callback, document sent, live transfer or saved note confirmed by the tool.
    order = [('schedule_meeting', 'meeting'), ('transfer_to_number', 'transfer'), ('schedule_callback', 'callback'), ('send_documents', 'document'), ('save_note', 'note')]
    next_step = None
    next_step_tool = None
    for name, kind in order:
        tc = next((x for x in tcs if x['name'] == name and _ok_result(x) and not (name == 'save_note' and _DNC_NOTE.search(js_json(x.get('args'))))), None)
        if tc is not None:
            next_step, next_step_tool = kind, tc
            break
    meeting_kind = None
    if next_step == 'meeting':
        mk = (next_step_tool.get('args') or {}).get('meeting_kind') if next_step_tool is not None else None
        meeting_kind = js_string(mk if mk is not None else '') or None

    # Tool dead air: a tool that ran before the agent said anything, leaving the caller in silence.
    dead_air = []
    for tc in tcs:
        if tc['name'] in ('end_call', 'transfer_to_number'):
            continue
        t = at(turns, tc['turnIdx'])
        if t is None or t['speaker'] != 'agent':
            continue
        prev = at(turns, t['idx'] - 1)
        started_before_speech = tc['startS'] < t['startS'] - 0.05 if tc.get('startS') is not None else False
        if not started_before_speech or prev is None:
            continue
        gap = t['startS'] - turn_end(prev)
        if gap > 0:
            dead_air.append({'turn': t['idx'], 'gap': gap, 'tool': tc['name']})
    return {'expected': expected, 'made': made, 'nextStep': next_step, 'nextStepTool': next_step_tool, 'meetingKind': meeting_kind, 'deadAir': dead_air}


_BED_ENTITY = jsre(r"\b(it'?s|my name is|i'?m) [A-Z][a-z]+|@|\b\d{7,}\b|\b(one|two|three|four|\d) bed", 'i')
_CORR_WORDS = jsre(r'\b(name|said|not|we said)\b', 'i')
_ARTEFACT = jsre(r'[*#_`]|https?:\/\/|\{\{|\}\}|<[a-z]+>', 'i')
_GIVEN_NAME = jsre(r"\b(it'?s|my name is|i'?m) [A-Z][a-z]+")
_GIVEN_PERSONA = jsre(r'\b(broker|for myself|for my family|invest)', 'i')
_GIVEN_PROJECT = jsre(r'\b(residences|gardens|heights|seafront|project)\b', 'i')
_GIVEN_BEDS = jsre(r'\bbed(room)?s?\b', 'i')
_GIVEN_BUDGET = jsre(r'\b(million|budget|aed|dirhams)\b', 'i')
_INTEREST = jsre(r'interest|project')
_WS = jsre(r'\s+')
_COMMA = jsre(r',')
_VOLUNTEER = jsre(r"\b(i'?m (a|an independent) broker|broker, actually|for myself|as an investment|looking at investments|i'?m an investor)\b", 'i')
_AND_ALSO_Q = jsre(r'\b(and|also)\b[^?]*\?')
_BROKER_SPLIT = jsre(r'broker')
_INVESTOR_WORD = jsre(r'\binvestor\b')
_SENT_SPLIT = jsre(r'(?<=[.!?])\s+')
_TAG_OPEN = jsre(r'\[[a-z]', 'gi')
_EXCITED_CALLER = jsre(r'!|\b(great|amazing|love|excited|perfect)\b', 'i')
_EXCITED_PREV = jsre(r'!|\b(great|amazing|love|excited)\b', 'i')
_DASH_END = jsre(r'[—-]$')
_PAUSE_PUNCT = jsre(r'[.,!?;:—-]$')


def code_metrics(inp: dict, tools: dict) -> dict[str, dict]:
    call, ctx, phases, persona_path = inp['call'], inp['ctx'], inp['phases'], inp['personaPath']
    turns = call['turns']
    agent = [t for t in turns if t['speaker'] == 'agent']
    caller = [t for t in turns if t['speaker'] == 'caller']
    m: dict[str, dict] = {}
    has_body = any(p['name'] == 'Body' for p in phases['phases'])

    def body_turns(pred) -> list[dict]:
        b = next((p for p in phases['phases'] if p['name'] == 'Body'), None)
        return [t for t in turns if b['from'] <= t['idx'] <= b['to'] and pred(t)] if b is not None else []

    # ---------- Voice and timing ----------
    lats = _response_latencies(call)
    if lats:
        xs = [x['lat'] for x in lats]
        p50, p90 = quantile(xs, 0.5), quantile(xs, 0.9)
        s50 = 100 if p50 <= 1.2 else 0 if p50 >= 2.5 else ((2.5 - p50) / 1.3) * 100
        s90 = 100 if p90 <= 2.5 else 0 if p90 >= 4 else ((4 - p90) / 1.5) * 100
        worst = sorted(lats, key=lambda x: -x['lat'])[0]
        m['rl'] = {'raw': fixed(p90, 2), 'applicable': True, 'value': js_round(min(s50, s90)), 'evidence': [worst['turn']],
                   'rationale': f"p50 {to_fixed(p50, 1)} s, p90 {to_fixed(p90, 1)} s; slowest turn #{worst['turn']} at {to_fixed(worst['lat'], 1)} s."}
    else:
        m['rl'] = _na()

    if call['toolCalls']:
        worst_l = sorted(tools['deadAir'], key=lambda x: -x['gap'])
        worst = worst_l[0] if worst_l else None
        m['tda'] = {'raw': fixed(worst['gap'], 2) if worst else 0, 'applicable': True, 'evidence': [worst['turn']] if worst else [],
                    'rationale': f"{to_fixed(worst['gap'], 1)} s of silence while {worst['tool']} ran with no filler line." if worst else 'Every blocking tool call had a filler line before it.'}
    else:
        m['tda'] = _na()

    silences = [x for x in lats if x['lat'] > 4]
    m['ls'] = {'raw': len(silences), 'applicable': len(lats) > 0, 'evidence': [s['turn'] for s in silences],
               'rationale': f"{len(silences)} gap(s) over 4 s on the agent's turn." if silences else None}

    def is_barge(c: dict) -> bool:
        prev = at(turns, c['idx'] - 1)
        if prev is None or prev['speaker'] != 'agent':
            return False
        if RX['backchannel'].search(strip_tags(c['text'])):
            return False
        return bool(prev.get('interrupted')) or c['startS'] < turn_end(prev) - 0.15

    barges = [c for c in caller if is_barge(c)]
    m['cbr'] = {'raw': fixed((len(barges) / len(agent)) * 100, 1) if agent else None, 'applicable': len(agent) > 0, 'evidence': [b['idx'] for b in barges]}
    if barges:
        def recovered_fn(b: dict) -> bool:
            prev_agent = at(turns, b['idx'] - 1)
            next_a = next((t for t in turns if t['idx'] > b['idx'] and t['speaker'] == 'agent'), None)
            if next_a is None:
                return True
            pw = set(js_split(lc(prev_agent['text']), _WS))
            nw = js_split(lc(next_a['text']), _WS)
            overlap = len([w for w in nw if w in pw and len(w) > 3]) / max(1, len(nw))
            return overlap < 0.6

        recovered = [b for b in barges if recovered_fn(b)]
        m['br'] = {'raw': fixed((len(recovered) / len(barges)) * 100, 1), 'applicable': True, 'evidence': [b['idx'] for b in barges]}
    else:
        m['br'] = _na()

    def is_cut_in(a: dict) -> bool:
        prev = at(turns, a['idx'] - 1)
        return bool(prev is not None and prev['speaker'] == 'caller' and inp['measuredTiming'] and a['startS'] < turn_end(prev) - 0.2)

    cut_ins = [a for a in agent if is_cut_in(a)]
    m['aci'] = {'raw': fixed((len(cut_ins) / len(caller)) * 100, 1) if caller else None, 'applicable': bool(inp['measuredTiming']) and len(caller) > 0, 'evidence': [c['idx'] for c in cut_ins]}

    wc = [word_count(strip_tags(a['text'])) for a in agent]
    if wc:
        med, long = median(wc), len([w for w in wc if w > 50]) / len(wc)
        s_med = 100 if med <= 30 else 0 if med >= 45 else ((45 - med) / 15) * 100
        s_long = 100 if long <= 0.1 else 0 if long >= 0.3 else ((0.3 - long) / 0.2) * 100
        longest = agent[wc.index(max(wc))]
        m['atl'] = {'raw': med, 'applicable': True, 'value': js_round(min(s_med, s_long)), 'evidence': [longest['idx']],
                    'rationale': f'Median {js_str(med)} words; {to_fixed(long * 100, 0)}% of turns over 50 words.'}
    else:
        m['atl'] = _na()

    def dur(ts: list[dict]) -> float:
        return sum(max(0, turn_end(t) - t['startS']) for t in ts)

    a_dur, c_dur = dur(agent), dur(caller)
    m['tr'] = {'raw': fixed((a_dur / (a_dur + c_dur)) * 100, 1) if a_dur + c_dur > 0 else None, 'applicable': a_dur + c_dur > 0 and len(caller) > 1, 'evidence': []}

    m['sra'] = _na()  # needs a human-checked reference transcript

    field_vals = [v for v in inp['fields'].values() if isinstance(v, str) and len(v) > 1]
    entity_turns = [c for c in caller if _BED_ENTITY.search(strip_tags(c['text'])) or any(v in c['text'] for v in field_vals)]
    entity_corrections = [c for c in caller if RX['correction'].search(lc(c['text'])) and _CORR_WORDS.search(c['text'])]
    m['ent'] = {'raw': fixed(100 * (1 - min(len(entity_corrections), len(entity_turns)) / len(entity_turns)), 1), 'applicable': True, 'evidence': [c['idx'] for c in entity_corrections]} \
        if entity_turns else _na()

    artefacts = []
    for a in agent:
        unknown_tags = [t for t in (a.get('tags') or []) if t not in ALLOWED_DELIVERY_TAGS]
        if unknown_tags or _ARTEFACT.search(a['text']):
            artefacts.append(a['idx'])
    m['va'] = {'raw': len(artefacts), 'applicable': len(agent) > 0, 'evidence': artefacts,
               'rationale': 'Delivery tags, symbols or markup that the voice would read aloud.' if artefacts else None}

    # ---------- Understanding (code parts) ----------
    corrections = [c for c in caller if RX['correction'].search(lc(c['text']))]
    m['cc'] = {'raw': len(corrections), 'applicable': len(caller) > 0, 'evidence': [c['idx'] for c in corrections]}

    reasks: list[int] = []
    kf = ctx.get('knownFacts')
    known_text = kf.lower() if isinstance(kf, str) else js_json(kf).lower() if kf is not None and kf != '' else ''

    def given_earlier(field: str, a: dict) -> bool:
        for c in caller:
            if c['idx'] >= a['idx']:
                continue
            if field == 'name':
                hit = _GIVEN_NAME.search(strip_tags(c['text']))
            elif field == 'persona':
                hit = _GIVEN_PERSONA.search(c['text'])
            elif field == 'project_interest':
                hit = _GIVEN_PROJECT.search(c['text'])
            elif field == 'bedrooms':
                hit = _GIVEN_BEDS.search(c['text'])
            elif field == 'budget':
                hit = _GIVEN_BUDGET.search(c['text'])
            else:
                hit = None
            if hit:
                return True
        return False

    for a in agent:
        s = lc(a['text'])
        for field, rx in FIELD_ASK_RX.items():
            if not rx.search(s) or '?' not in a['text']:
                continue
            known = (field == 'name' and ctx['identity'] == 'known') or (field != 'name' and replace_first(field, '_interest', '') in known_text) \
                or (field == 'persona' and ctx['persona'] != 'unknown') or (field == 'project_interest' and bool(_INTEREST.search(known_text)))
            if given_earlier(field, a) or known:
                reasks.append(a['idx'])
                break
    m['reask'] = {'raw': len(reasks), 'applicable': len(agent) > 0, 'evidence': reasks,
                  'rationale': 'Asked for something already given in this call or in known_facts.' if reasks else None}

    m['fca'] = _na()  # filled when an answer key exists

    # ---------- Introduction (code parts) ----------
    first_agent = agent[0] if agent else None

    def agent_idx(n: int) -> float:
        a = at(agent, n - 1)
        return a['idx'] if a is not None else math.inf

    if first_agent is not None:
        errs = []
        s = lc(first_agent['text'])
        if ctx['direction'] == 'outbound' and ctx['objective'] == 'empty' and ctx['history'] == 'new':
            if not RX['timeCheck'].search(s):
                errs.append('skipped the time check')
            if RX['howCanIHelp'].search(s):
                errs.append('“how can I help” on an outbound call')
        if ctx['direction'] == 'outbound' and ctx['objective'] == 'callback' and not RX['callbackMention'].search(s):
            errs.append('a cold introduction on a requested callback')
        if ctx['direction'] == 'inbound' and RX['timeCheck'].search(s):
            errs.append('“is now a good time” on an inbound call')
        if ctx['history'] == 'returning' and (word_count(s) > 35 or len(match_all(_COMMA, s)) >= 3):
            errs.append('read the history out as a list')
        if ctx['identity'] == 'known' and any(a['idx'] <= agent_idx(4) and RX['nameAsk'].search(lc(a['text'])) for a in agent):
            errs.append('asked for a name already known')
        if ctx['persona'] != 'unknown' and any(RX['personaFork'].search(lc(a['text'])) for a in agent):
            errs.append('asked investor-or-broker again')
        m['ch'] = {'raw': 0 if errs else 1, 'applicable': True, 'evidence': [first_agent['idx']] if errs else [],
                   'rationale': f"Opening {'; '.join(errs)}." if errs else 'Opening matches its context.'}

    fork_turn = next((a for a in agent if RX['personaFork'].search(lc(a['text']))), None)
    # The caller settled the persona themselves before any fork was asked ("I'm a broker", "for myself").
    volunteer_turn = next((t for t in turns if t['speaker'] == 'caller' and _VOLUNTEER.search(t['text'])), None)
    persona_volunteered = volunteer_turn is not None and (fork_turn is None or volunteer_turn['idx'] < fork_turn['idx'])
    if ctx['persona'] == 'unknown' and persona_path != 'Non-target' and not (persona_volunteered and fork_turn is None):
        if fork_turn is None:
            m['pfd'] = {'raw': 0, 'applicable': True, 'evidence': [], 'rationale': 'The investor-or-broker fork was never asked.'}
        else:
            parts = js_split(lc(fork_turn['text']), _BROKER_SPLIT)
            after = parts[1] if len(parts) > 1 else ''
            alone = question_count(fork_turn['text']) <= 1 and not _AND_ALSO_Q.search(after) and not RX['liveOrInvest'].search(_INVESTOR_WORD.sub('', lc(fork_turn['text']), count=1))
            on_time = fork_turn['idx'] <= (agent_idx(2) if ctx['direction'] == 'outbound' else agent_idx(3))
            asked_after_volunteer = persona_volunteered
            reasons = [r for r, bad in (('paired with another question', not alone), ('asked late', not on_time), ('asked after the caller had already said', asked_after_volunteer)) if bad]
            m['pfd'] = {'raw': 1 if alone and on_time and not asked_after_volunteer else 0, 'applicable': True, 'evidence': [fork_turn['idx']],
                        'rationale': '; '.join(reasons) or 'Asked alone and on time.'}
    else:
        m['pfd'] = _na()

    name_asks = [a for a in agent if RX['nameAsk'].search(lc(a['text']))]
    if ctx['identity'] == 'unknown':
        first = name_asks[0] if name_asks else None
        by_five = first['idx'] <= agent_idx(5) if first is not None else False
        given = next((c for c in caller if c['idx'] > first['idx']), None) if first is not None else None
        saved = False
        if given is not None:
            nxt = next((t for t in turns if t['idx'] > given['idx'] and t['speaker'] == 'agent'), None)
            limit = nxt['idx'] if nxt is not None else -1
            saved = any(tc['name'] == 'update_caller_details' and given['idx'] < tc['turnIdx'] <= limit for tc in call['toolCalls'])
        short = len(turns) < 6 or persona_path == 'Non-target'
        if short and first is None:
            m['nc'] = _na()
        else:
            reasons = [r for r, bad in (('asked after agent turn 5', not by_five), ('asked more than once', len(name_asks) > 1), ('update_caller_details not called in that turn', not saved)) if bad]
            m['nc'] = {'raw': 1 if first is not None and by_five and len(name_asks) == 1 and saved else 0, 'applicable': True, 'evidence': [first['idx']] if first is not None else [],
                       'rationale': 'Name never asked.' if first is None else ('; '.join(reasons) or 'Asked once, early, and saved.')}
    else:
        m['nc'] = {'raw': 0 if name_asks else 1, 'applicable': True, 'evidence': [a['idx'] for a in name_asks],
                   'rationale': 'Asked for a name that was already known.' if name_asks else 'Used the known name.'}

    # ---------- Body (code parts) ----------
    # Discovery only has an opportunity in journeys built on it (discovery, enquiry, objection, broker onboarding).
    if has_body and persona_path in ('Investor', 'Broker') and basis(inp['scenario']) in ('S1', 'S2', 'S7', 'S8'):
        spec = BROKER_DISCOVERY if persona_path == 'Broker' else INVESTOR_DISCOVERY
        fields = inp['fields']
        covered = [f for f in spec if any((fields.get(k) and fields.get(k) != 'Not captured') or (known_text and replace_first(k, '_', ' ') in known_text) for k in f['fields'])]
        missing = ', '.join(f['label'].lower() for f in spec if f not in covered) or 'none missing'
        m['dc'] = {'raw': fixed((len(covered) / len(spec)) * 100, 1), 'applicable': True, 'evidence': [],
                   'rationale': f'{len(covered)} of {len(spec)} discovery fields captured ({missing}).'}
    else:
        m['dc'] = _na()

    if has_body:
        viol: list[int] = []
        b_agent = body_turns(lambda t: t['speaker'] == 'agent')
        for i, a in enumerate(b_agent):
            if question_count(a['text']) >= 2:
                viol.append(a['idx'])
            prev_a = at(b_agent, i - 1)
            if prev_a is not None and prev_a['idx'] == a['idx'] - 2 and RX['bareQuestion'].search(strip_tags(a['text'])) and RX['bareQuestion'].search(strip_tags(prev_a['text'])):
                viol.append(a['idx'])
        m['qd'] = {'raw': len(viol), 'applicable': len(b_agent) > 0, 'evidence': viol,
                   'rationale': f'{len(viol)} turn(s) with two questions, or two bare questions in a row.' if viol else None}
    else:
        m['qd'] = _na()

    ecal: list[int] = []
    sighs = 0
    for i, a in enumerate(agent):
        s = lc(a['text'])
        if any(p in s for p in BANNED_PHRASES):
            ecal.append(a['idx'])
        tags = a.get('tags') or []
        if any(t not in ALLOWED_DELIVERY_TAGS for t in tags):
            ecal.append(a['idx'])
        sents = js_split(a['text'], _SENT_SPLIT)
        if any(len(match_all(_TAG_OPEN, x)) > 1 for x in sents):
            ecal.append(a['idx'])
        sighs += len([t for t in tags if t == 'sighs'])
        prev = at(turns, a['idx'] - 1)
        prev_caller = prev if prev is not None and prev['speaker'] == 'caller' else None
        if 'enthusiastically' in tags and prev_caller is not None and not _EXCITED_CALLER.search(prev_caller['text']):
            ecal.append(a['idx'])
        if tags and i > 0 and (agent[i - 1].get('tags') or []) and agent[i - 1]['idx'] == a['idx'] - 2:
            ecal.append(a['idx'])
    if sighs > 1:
        ecal.append(next(a for a in agent if 'sighs' in (a.get('tags') or []))['idx'])
    uniq = list(dict.fromkeys(ecal))
    m['ecal'] = {'raw': len(uniq), 'applicable': len(agent) > 0, 'evidence': uniq,
                 'rationale': 'Banned phrases or delivery tags used outside the prompt’s rules.' if ecal else None}

    if persona_path == 'Broker':
        buyer_qs = [a for a in agent if BUYER_DISCOVERY_RX.search(lc(a['text'])) and '?' in a['text']]
        m['bpp'] = {'raw': len(buyer_qs), 'applicable': True, 'evidence': [b['idx'] for b in buyer_qs],
                    'rationale': 'Buyer discovery questions asked to a broker.' if buyer_qs else 'No buyer questions to the broker.'}
    else:
        m['bpp'] = _na()

    # ---------- Conclusion ----------
    nss_applies = persona_path in ('Investor', 'Broker') and basis(inp['scenario']) not in ('S10', 'S12')
    if nss_applies:
        m['nss'] = {'raw': 1 if tools['nextStep'] else 0, 'applicable': True, 'evidence': [tools['nextStepTool']['turnIdx']] if tools['nextStepTool'] is not None else [],
                    'rationale': f"Next step: {tools['nextStep']}." if tools['nextStep'] else 'Ended with no meeting, callback, document, transfer or note.'}
    else:
        m['nss'] = _na()

    if call['durationS'] > 900:
        cs = phases.get('closingSignal')
        ct = at(turns, cs['turn']) if cs else None
        wrap = ct['startS'] if ct is not None and ct.get('startS') is not None else math.inf
        end = next((tc for tc in call['toolCalls'] if tc['name'] == 'end_call'), None)
        et = at(turns, end['turnIdx']) if end is not None else None
        end_at = (et['startS'] if et is not None and et.get('startS') is not None else call['durationS']) if end is not None else call['durationS']
        m['tlh'] = {'raw': 1 if wrap <= 930 and end_at <= 955 and end is not None else 0, 'applicable': True, 'evidence': [cs['turn']] if cs else [],
                    'rationale': f'Wrap-up at {_round_str(wrap)} s, end at {_round_str(end_at)} s.'}
    else:
        m['tlh'] = _na()

    last = turns[-1] if turns else None
    abandoned = call.get('endReason') == 'caller_hangup' and (not phases.get('closingSignal') or (last is not None and last['speaker'] == 'agent' and bool(last.get('interrupted')))
                                                           or (last is not None and last['speaker'] == 'agent' and bool(_DASH_END.search(last['text'].strip()))))
    if len(turns) > 2 and basis(inp['scenario']) not in ('S12',):
        m['ab'] = {'raw': 0 if abandoned else 1, 'applicable': True, 'evidence': [last['idx']] if abandoned and last is not None else [],
                   'rationale': 'The caller hung up mid-flow, with no close.' if abandoned else None}
    else:
        m['ab'] = _na()

    # ---------- Tool use ----------
    if tools['made'] or tools['expected']:
        made = [x for x in tools['made'] if x['tc']['name'] != 'end_call' or len(tools['made']) == 1]
        correct = [x for x in made if x['correct']]
        not_correct = [x for x in made if not x['correct']]
        m['tp'] = {'raw': _pct(len(correct), len(made)), 'applicable': True, 'evidence': [x['tc']['turnIdx'] for x in not_correct],
                   'rationale': '; '.join(f"{x['tc']['name']}: {', '.join(x['why'])}" for x in not_correct) or None} if made else _na()
        exp = tools['expected']
        unmet = [e for e in exp if not e['met']]
        m['trc'] = {'raw': _pct(len([e for e in exp if e['met']]), len(exp)), 'applicable': True, 'evidence': [e['turn'] for e in unmet],
                    'rationale': '; '.join(f"{e['tool']} expected at #{e['turn']} ({e['reason'].lower()})" for e in unmet) or None} if exp else _na()
        arg_checked = [x for x in made if x['tc']['name'] in ('send_broker_registration_link', 'send_documents', 'schedule_meeting', 'schedule_callback')]
        m['aa'] = {'raw': _pct(len([x for x in arg_checked if x['argsOk']]), len(arg_checked)), 'applicable': True, 'evidence': [x['tc']['turnIdx'] for x in arg_checked if not x['argsOk']]} \
            if arg_checked else _na()
        seq_checked = [x for x in made if x['tc']['name'] in ('send_documents', 'schedule_meeting', 'schedule_callback', 'request_live_transfer', 'end_call', 'send_broker_registration_link')]
        bad_seq = [x for x in seq_checked if not x['seqOk']]
        m['seq'] = {'raw': _pct(len(seq_checked) - len(bad_seq), len(seq_checked)), 'applicable': True, 'evidence': [x['tc']['turnIdx'] for x in bad_seq],
                    'rationale': '; '.join(f"{x['tc']['name']}: {', '.join(x['why'])}" for x in bad_seq) or None} if seq_checked else _na()
        fid = [x for x in made if x['fidelityOk'] is not None]
        m['rf'] = {'raw': _pct(len([x for x in fid if x['fidelityOk']]), len(fid)), 'applicable': True, 'evidence': [x['tc']['turnIdx'] for x in fid if not x['fidelityOk']]} \
            if fid else _na()
        pr = [x for x in made if x['prompt'] is not None]
        missed_updates = [e for e in tools['expected'] if e['tool'] == 'update_caller_details' and not e['met']]
        m['pr'] = {'raw': _pct(len([x for x in pr if x['prompt']]), len(pr) + len(missed_updates)), 'applicable': True,
                   'evidence': [x['tc']['turnIdx'] for x in pr if not x['prompt']] + [e['turn'] for e in missed_updates]} if pr or missed_updates else _na()
        spam = [x for x in made if x['tc']['name'] == 'send_documents' and not x['correct']]
        m['sp'] = {'raw': len(spam), 'applicable': True, 'evidence': [x['tc']['turnIdx'] for x in spam]} if any(x['tc']['name'] == 'send_documents' for x in made) else _na()
    else:
        for k in ('tp', 'trc', 'aa', 'seq', 'rf', 'pr', 'sp'):
            m[k] = _na()

    # ---------- Emotion and realism (transcript side) ----------
    sents = [{'idx': c['idx'], 'v': sentiment(c['text']), 'words': word_count(c['text'])} for c in caller]
    if len(sents) >= 3:
        start = (sents[0]['v'] + sents[1]['v']) / 2
        end = (sents[-1]['v'] + sents[-2]['v']) / 2
        m['cet'] = {'raw': fixed(end - start, 2), 'applicable': True, 'evidence': [sents[0]['idx'], sents[-1]['idx']],
                    'rationale': f'Caller sentiment {to_fixed(start, 1)} at the start, {to_fixed(end, 1)} at the end (transcript).'}
    else:
        m['cet'] = _na()
    frus = [c for c in caller if RX['frustration'].search(lc(c['text']))]
    if frus:
        def acked_fn(f: dict) -> bool:
            n = next((t for t in turns if t['idx'] > f['idx'] and t['speaker'] == 'agent'), None)
            return bool(n is not None and RX['empathy'].search(lc(n['text'])))

        acked = [f for f in frus if acked_fn(f)]
        m['fe'] = {'raw': fixed((len(acked) / len(frus)) * 100, 1), 'applicable': True, 'evidence': [f['idx'] for f in frus],
                   'rationale': f'{len(frus)} frustration event(s), {len(acked)} acknowledged.'}
    else:
        m['fe'] = _na()
    latter = sents[len(sents) // 2:]
    run = max_run = 0
    run_end = -1
    for i, s in enumerate(latter):
        if s['words'] <= 3 and (i == 0 or s['words'] <= latter[i - 1]['words'] + 1):
            run += 1
            if run > max_run:
                max_run = run
                run_end = s['idx']
        else:
            run = 0
    m['dis'] = {'raw': 0 if max_run >= 3 else 1, 'applicable': True, 'evidence': [run_end] if max_run >= 3 else [],
                'rationale': 'Caller answers got shorter and flatter over 3 or more turns.' if max_run >= 3 else None} if len(sents) >= 4 else _na()

    def is_over(a: dict) -> bool:
        prev = at(turns, a['idx'] - 1)
        return bool((RX['enthusiasm'].search(strip_tags(a['text'])) or 'enthusiastically' in (a.get('tags') or []))
                    and prev is not None and prev['speaker'] == 'caller' and not _EXCITED_PREV.search(prev['text']))

    over = [a for a in agent if is_over(a)]
    m['od'] = {'raw': len(over), 'applicable': True, 'evidence': [o['idx'] for o in over]} if agent else _na()
    if inp['measuredTiming']:
        rates = []
        for a in agent:
            wpm = (word_count(strip_tags(a['text'])) / max(0.5, turn_end(a) - a['startS'])) * 60
            if is_finite(wpm) and word_count(turns[a['idx']]['text']) >= 5:
                rates.append({'idx': a['idx'], 'wpm': wpm})
        m['srate'] = {'raw': js_round(median([r['wpm'] for r in rates])), 'applicable': True, 'evidence': []} if rates else _na()
    else:
        m['srate'] = _na()
    with_words = [a for a in agent if a.get('words') and len(a['words']) > 4]
    if with_words:
        unnatural = 0
        ev: list[int] = []
        for a in with_words:
            ws = a['words']
            for i in range(1, len(ws)):
                gap = ws[i]['s'] - ws[i - 1]['e']
                if gap > 0.7 and not _PAUSE_PUNCT.search(ws[i - 1]['w']):
                    unnatural += 1
                    ev.append(a['idx'])
        m['pp'] = {'raw': unnatural, 'applicable': True, 'evidence': list(dict.fromkeys(ev))}
    else:
        m['pp'] = _na()
    return m


def _round_str(v: float) -> str:
    return 'Infinity' if v == math.inf else js_str(js_round(v))


_ANYTHING_ELSE = jsre(r'\banything else\b', 'i')
_PITCH_WORDS = jsre(r'\b(offer|payment plan|special|before you go|would you like|can i (send|book)|shall i|book you)\b', 'i')
_CLAIM_RX: list[tuple[Any, list[str]]] = [
    (jsre(r"\b(you'?re (all )?booked|(is|has been) booked|booked (you|it) (in|for))\b", 'i'), ['schedule_meeting']),
    (jsre(r'\b((is|has been) cancell?ed|cancell?ed (it|your|the))\b', 'i'), ['cancel_meeting']),
    (jsre(r"\b(it'?s on your (whatsapp|email)|(is|are) on your (whatsapp|email) now|sent —|sent it|has been sent)\b", 'i'), ['send_documents', 'send_broker_registration_link']),
]


def code_gates(inp: dict, tools: dict) -> list[dict]:
    """Gates that code can decide from the tool log and the transcript."""
    call = inp['call']
    turns = call['turns']
    gates: list[dict] = []

    # G5: contact continued after a do-not-contact request.
    dnc = next((t for t in turns if t['speaker'] == 'caller' and RX['dnc'].search(lc(t['text']))), None)
    if dnc is not None:
        pitch = next((t for t in turns if t['idx'] > dnc['idx'] and t['speaker'] == 'agent' and not _ANYTHING_ELSE.search(t['text'])
                      and (RX['projectFact'].search(lc(t['text'])) or _PITCH_WORDS.search(t['text']))), None)
        gates.append({'id': 'G5', 'failed': pitch is not None, 'turn': pitch['idx'] if pitch is not None else dnc['idx'],
                      'detail': 'Kept selling after the caller asked not to be contacted.' if pitch is not None else None})
    # G6: a document sent to a number or email that was not read back and confirmed.
    for x in tools['made']:
        if x['tc']['name'] != 'send_documents':
            continue
        if not x['seqOk'] and 'No read-back before the send' in x['why']:
            gates.append({'id': 'G6', 'failed': True, 'turn': x['tc']['turnIdx'], 'detail': 'Sent without reading the number or email back and confirming it.'})
            break
    # G8: a booking, cancellation or send claimed without the tool confirming it.
    for t in turns:
        if t['speaker'] != 'agent':
            continue
        for rx, names in _CLAIM_RX:
            if not rx.search(t['text']):
                continue
            confirmed = any(tc['name'] in names and tc['turnIdx'] <= t['idx'] and tc.get('ok') is not False and not _FAILED.search(tc.get('resultText') or '') for tc in call['toolCalls'])
            if not confirmed:
                gates.append({'id': 'G8', 'failed': True, 'turn': t['idx'], 'detail': f"Claimed “{t['text'][:60]}…” without {names[0]} confirming it."})
                break
    # G9: the call ended after transfer_to, while an advisor was waiting on hold.
    tt = next((tc for tc in call['toolCalls'] if tc['name'] == 'request_live_transfer' and _TRANSFER_TO.search(tc.get('resultText') or '')), None)
    if tt is not None and not any(tc['name'] == 'transfer_to_number' for tc in call['toolCalls']):
        gates.append({'id': 'G9', 'failed': True, 'turn': tt['turnIdx'], 'detail': 'Ended after transfer_to without transferring; the advisor was left waiting.'})
    return gates
