# Path adherence: the bridge between the scenario taxonomy and the metrics. A call scores the share
# of its scenario's checkpoints it reached in order; the first missed checkpoint is its deviation.
# Checkpoints come from the scenario's definition in the active taxonomy (or the version it was tagged under).

from __future__ import annotations

from ..js import at, jsre
from ..taxonomy import current
from .text import RX, lc

_FAILED = jsre(r'\b(fail|failed|unavailable)\b', 'i')
_READBACK = jsre(r'\b(booked|cancell?ed|moved|now|done)\b', 'i')
_ANYTHING_ELSE = jsre(r'anything else', 'i')
_PUSH = jsre(r'\b(book|viewing|before you go|special|prices are only going up)\b', 'i')


def judge_checkpoints(scenario: str | None) -> list[dict]:
    return [{'id': c['id'], 'label': c['label'], 'hint': c.get('hint')} for c in current().checkpoints(scenario) if c['detect']['by'] == 'judge']


def evaluate_path(call: dict, scenario: str | None, phases: dict, tools: dict, fields: dict, judged: dict) -> dict | None:
    cps = current().checkpoints(scenario)
    if not cps:
        return None
    turns = call['turns']

    def ok_tool(names: list[str]) -> dict | None:
        return next((tc for tc in call['toolCalls'] if tc['name'] in names and tc.get('ok') is not False and not _FAILED.search(tc.get('resultText') or '')), None)

    steps = []
    for cp in cps:
        hit, turn = False, None
        d = cp['detect']
        if d['by'] == 'tool':
            tc = ok_tool(d['tools'])
            hit = tc is not None
            turn = tc['turnIdx'] if tc is not None else None
        elif d['by'] == 'judge':
            j = judged.get(cp['id'])
            if j and j.get('hit') is None:
                continue  # the heuristic judge can't assess this user-defined checkpoint
            hit = bool(j and j.get('hit'))
            turn = j.get('turn') if j else None
        else:
            rule = d['rule']
            if rule == 'persona_resolved':
                hit = phases['personaResolvedAt'] is not None
                turn = phases['personaResolvedAt']
            elif rule == 'discovery':
                disc = next((s for s in phases['segments'] if s['name'] == 'Discovery'), None)
                n = len([k for k in ('bedrooms', 'location', 'budget', 'timeline', 'must_haves', 'who_for') if fields.get(k)])
                hit = disc is not None and n >= 2
                turn = disc['from'] if disc is not None else None
            elif rule == 'filler_before_transfer':
                tc = next((t for t in call['toolCalls'] if t['name'] == 'request_live_transfer'), None)
                a = at(turns, tc['turnIdx']) if tc is not None else None
                hit = bool(tc is not None and a is not None and a['speaker'] == 'agent' and (tc.get('startS') is None or tc['startS'] >= a['startS'] - 0.05))
                turn = a['idx'] if a is not None else None
            elif rule == 'transfer_outcome':
                tc = ok_tool(['transfer_to_number', 'schedule_callback', 'save_note'])
                hit = tc is not None
                turn = tc['turnIdx'] if tc is not None else None
            elif rule == 'short_call':
                hit = call['durationS'] <= 60 or len(turns) <= 4
                last = at(turns, len(turns) - 1)
                turn = last['idx'] if last is not None else 0
            elif rule == 'tool_confirmed_readback':
                tc = ok_tool(['schedule_meeting', 'cancel_meeting'])
                rb = next((t for t in turns if t['idx'] >= tc['turnIdx'] and t['speaker'] == 'agent' and _READBACK.search(t['text'])), None) if tc is not None else None
                hit = rb is not None
                turn = rb['idx'] if rb is not None else None
            elif rule == 'question_after_send':
                tc = ok_tool(['send_documents'])
                q = next((t for t in turns if t['idx'] > tc['turnIdx'] and t['speaker'] == 'agent' and '?' in t['text'] and not _ANYTHING_ELSE.search(t['text'])), None) if tc is not None else None
                hit = q is not None
                turn = q['idx'] if q is not None else None
            elif rule == 'no_further_pitch':
                refusals = [t for t in turns if t['speaker'] == 'caller' and (RX['refusal'].search(lc(t['text'])) or RX['dnc'].search(lc(t['text'])))]
                pivot = at(refusals, 1 if cp['id'] == 'stop' else 0)
                if pivot is None:
                    pivot = at(refusals, 0)
                if pivot is None:
                    hit = cp['id'] != 'stop'
                    turn = None
                else:
                    push = next((t for t in turns if t['idx'] > pivot['idx'] and t['speaker'] == 'agent' and _PUSH.search(t['text'])), None)
                    hit = push is None
                    turn = pivot['idx']
        steps.append({'id': cp['id'], 'label': cp['label'], 'hit': hit, 'turn': turn})
    if not steps:
        return None
    # Reached in order: a checkpoint counts if it was hit at or after the previous hit checkpoint.
    last_turn, count, deviation = -1, 0, None
    for s in steps:
        in_order = s['hit'] and (s['turn'] is None or s['turn'] >= last_turn)
        if in_order:
            count += 1
            if s['turn'] is not None:
                last_turn = s['turn']
        elif not deviation:
            deviation = s['label']
    return {'scenario': scenario, 'steps': steps, 'hit': count, 'total': len(steps), 'deviation': deviation}
