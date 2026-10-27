# Step 3: cut the transcript into introduction, body and conclusion by fixed rules, so two reviewers
# cut the same call in the same places, and tag each body turn with a segment.

from __future__ import annotations

from ..js import at, jsre
from .text import RX, lc

ACTION_TOOLS = {'send_documents', 'schedule_callback', 'schedule_meeting', 'cancel_meeting', 'request_live_transfer', 'transfer_to_number', 'save_note', 'send_broker_registration_link'}
BROKER_SIGNAL = jsre(r"\b(i'?m (a|an independent) broker|broker|brokerage|agency|my clients|realtor)\b", 'i')
INVESTOR_SIGNAL = jsre(r"\b(for myself|for my family|buying for (me|us|my)|to live in|as an investment|i'?m an investor|looking at investments|looking to invest|want to invest|my first (home|place)|buying my first)\b", 'i')
NONTARGET_SIGNAL = jsre(r'\b(rent(ing)?\b|already own|service charge|job (opening|vacancy)|wrong number|snagging)\b', 'i')


def find_persona_resolution(call: dict, ctx: dict) -> int | None:
    """First caller turn that settles investor or broker (or non-target), unless known from history."""
    if ctx['persona'] != 'unknown':
        first = next((t for t in call['turns'] if t['speaker'] == 'agent'), None)
        return first['idx'] if first is not None else 0
    for t in call['turns']:
        if t['speaker'] != 'caller':
            continue
        s = lc(t['text'])
        if BROKER_SIGNAL.search(s) or INVESTOR_SIGNAL.search(s) or NONTARGET_SIGNAL.search(s):
            return t['idx']
    return None


_CONFIRM = jsre(r"\b(booked|scheduled|i'?ll call you|confirmation|you'?re (all )?set|moved|now (sunday|saturday|monday|tuesday|wednesday|thursday|friday))\b", 'i')


def closing_signals(call: dict) -> list[dict]:
    sig: list[dict] = []
    refusals = 0
    turns = call['turns']

    def ok_tool(name: str) -> list[dict]:
        return [tc for tc in call['toolCalls'] if tc['name'] == name and tc.get('ok') is not False]

    for tc in [*ok_tool('schedule_meeting'), *ok_tool('schedule_callback')]:
        # The booking is confirmed; the wrap-up starts at the next agent turn that reads it back.
        confirm = next((t for t in turns if t['idx'] >= tc['turnIdx'] and t['speaker'] == 'agent' and _CONFIRM.search(t['text'])), None)
        sig.append({'turn': confirm['idx'] if confirm is not None else tc['turnIdx'], 'kind': 'booking_confirmed'})
    for tc in call['toolCalls']:
        if tc['name'] == 'request_live_transfer':
            sig.append({'turn': tc['turnIdx'], 'kind': 'live_transfer'})
    for t in turns:
        if t['speaker'] != 'caller':
            if t['startS'] >= 900:
                sig.append({'turn': t['idx'], 'kind': 'time_limit'})
            continue
        s = lc(t['text'])
        if RX['dnc'].search(s):
            sig.append({'turn': t['idx'], 'kind': 'do_not_contact'})
        if RX['refusal'].search(s):
            refusals += 1
            if refusals == 2:
                sig.append({'turn': t['idx'], 'kind': 'second_refusal'})
        if RX['goodbye'].search(s):
            sig.append({'turn': t['idx'], 'kind': 'caller_goodbye'})
    # The agent's own farewell closes a call that has no other signal.
    end = next((tc for tc in call['toolCalls'] if tc['name'] == 'end_call'), None)
    if end is not None:
        sig.append({'turn': end['turnIdx'], 'kind': 'farewell'})
    return sorted(sig, key=lambda x: x['turn'])


_AGENT_ACTION = jsre(r'\b(send|book|schedule|call you|connect you|put you through|registration link|whatsapp)\b')
_PITCH_Q = jsre(r'\b(which|sounds|in person|online|walkthrough|visit)\b')
_CALLER_ACTION = jsre(r'\b(send me|call me|book|speak to (a|someone)|person|brochure|visit)\b')
_CALLER_PITCH = jsre(r'\b(how much|price|which|tell me about|what do you have|available|handover|how big)\b')


def _segment_of_turn(call: dict, idx: int, prev: str | None) -> str:
    t = call['turns'][idx]
    s = lc(t['text'])
    tools = [tc for tc in call['toolCalls'] if tc['turnIdx'] == idx]
    if t['speaker'] == 'agent':
        if any(tc['name'] in ACTION_TOOLS for tc in tools):
            return 'Action'
        if any(tc['name'] == 'get_project_details' for tc in tools) or RX['projectFact'].search(s):
            return 'Pitch'
        prev_caller = at(call['turns'], idx - 1)
        if prev_caller is not None and prev_caller['speaker'] == 'caller':
            c = lc(prev_caller['text'])
            if any(rx.search(c) for rx in RX['objection'].values()):
                return 'Objection'
            if RX['offTopic'].search(c):
                return 'Off-topic'
        if _AGENT_ACTION.search(s):
            return 'Action'
        if '?' in s:
            return 'Pitch' if prev == 'Pitch' and _PITCH_Q.search(s) else 'Discovery'
        return prev if prev is not None else 'Discovery'
    if any(rx.search(s) for rx in RX['objection'].values()):
        return 'Objection'
    if RX['offTopic'].search(s):
        return 'Off-topic'
    if _CALLER_ACTION.search(s):
        return 'Action'
    if _CALLER_PITCH.search(s):
        return 'Pitch'
    return prev if prev is not None else 'Discovery'


def segment_call(call: dict, ctx: dict, hint: dict | None = None) -> dict:
    hint = hint or {}
    turns = call['turns']
    n = len(turns)
    if not n:
        return {'phases': [], 'segments': [], 'turnSegments': {}, 'personaResolvedAt': None, 'closingSignal': None}
    persona_resolved_at = hint['personaResolvedAt'] if hint.get('personaResolvedAt') is not None else find_persona_resolution(call, ctx)

    # Introduction ends when persona is resolved; on an inbound call, also once the caller's first
    # question has been answered (the agent turn after it).
    intro_end = persona_resolved_at if persona_resolved_at is not None else -1
    if intro_end >= 0 and ctx['direction'] == 'inbound':
        first_q = next((t for t in turns if t['speaker'] == 'caller' and '?' in t['text']), None)
        if first_q is not None and first_q['idx'] < intro_end + 4:
            answer = next((t for t in turns if t['idx'] > first_q['idx'] and t['speaker'] == 'agent'), None)
            if answer is not None:
                intro_end = max(intro_end, answer['idx'])

    # Conclusion starts at the first closing signal the caller does not reopen.
    signals = [s for s in closing_signals(call) if s['turn'] > intro_end]
    closing = None
    i = 0
    while i < len(signals):
        s = signals[i]
        reopen = next((t for t in turns if t['idx'] > s['turn'] and t['speaker'] == 'caller' and RX['reopen'].search(t['text']) and not RX['goodbye'].search(t['text'])), None)
        if reopen is None:
            closing = s
            break
        # The body resumes; the conclusion restarts at the next closing signal after the reopen.
        later = next((x for x in signals[i + 1:] if x['turn'] > reopen['idx']), None)
        if later is None:
            closing = s
            break
        i = next(k for k, x in enumerate(signals) if x is later) - 1
        i += 1
    concl_start = closing['turn'] if closing is not None else max(intro_end + 1, n - 1)

    phases: list[dict] = []
    turn_segments: dict[int, str] = {}
    if persona_resolved_at is None or intro_end < 0:
        # Ended before persona was resolved: no body; score the introduction and conclusion only.
        intro_to = max(0, min(n - 1, concl_start - 1))
        phases.append({'name': 'Introduction', 'from': 0, 'to': intro_to})
        if concl_start <= n - 1 and concl_start > intro_to:
            phases.append({'name': 'Conclusion', 'from': concl_start, 'to': n - 1})
        return {'phases': phases, 'segments': [], 'turnSegments': turn_segments, 'personaResolvedAt': None, 'closingSignal': closing}
    phases.append({'name': 'Introduction', 'from': 0, 'to': min(intro_end, n - 1)})
    body_from, body_to = intro_end + 1, min(concl_start - 1, n - 1)
    if body_to >= body_from:
        phases.append({'name': 'Body', 'from': body_from, 'to': body_to})
    if concl_start <= n - 1:
        phases.append({'name': 'Conclusion', 'from': max(concl_start, body_from), 'to': n - 1})

    segments: list[dict] = []
    prev = None
    hint_segs = hint.get('turnSegments') or {}
    for i in range(body_from, body_to + 1):
        seg = hint_segs.get(i) or hint_segs.get(str(i)) or _segment_of_turn(call, i, prev)
        turn_segments[i] = seg
        last = segments[-1] if segments else None
        if last is not None and last['name'] == seg and last['to'] == i - 1:
            last['to'] = i
        else:
            segments.append({'name': seg, 'from': i, 'to': i})
        prev = seg
    return {'phases': phases, 'segments': segments, 'turnSegments': turn_segments, 'personaResolvedAt': persona_resolved_at, 'closingSignal': closing}


def phase_of(p: dict, idx: int) -> str | None:
    return next((ph['name'] for ph in p['phases'] if ph['from'] <= idx <= ph['to']), None)
