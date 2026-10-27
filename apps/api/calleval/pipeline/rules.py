# Step 4, layer 1: tags set by rules from call data, with no judgement needed. Higher layers
# (classifier, then human review) take over everything rules leave open.
#
# Rules name framework entries (S12 failed call, P7/P8 brokers…) and tag the active taxonomy's entry based
# on them; a taxonomy without such an entry leaves that tag to the classifier.

from __future__ import annotations

from ..js import jsre
from ..taxonomy import current
from .text import RX, js_string, lc, truthy, word_count


def _rule(value: str, evidence: list[int]) -> dict:
    return {'value': value, 'confidence': 1, 'layer': 'rule', 'evidence': evidence}


_OVERSEAS = jsre(r'\b(london|uk|abroad|overseas|international|india|europe|my clients in)\b')
_UNAVAILABLE = jsre(r'unavailable|no advisor|busy', 'i')
_SEND_FAIL = jsre(r'fail|undeliverable|fallback|by email instead', 'i')
_EMAIL = jsre(r'\bemail\b', 'i')


def rule_tags(call: dict, ctx: dict) -> dict:
    out: dict = {'persona': None, 'personaPath': None, 'scenarioPrimary': None, 'scenarioCandidates': [], 'returning': ctx['history'] == 'returning',
                 'failedCall': False, 'brokerRegistration': None, 'events': []}
    tcs = call['toolCalls']
    turns = call['turns']
    tax = current()

    def called(name: str) -> list[dict]:
        return [t for t in tcs if t['name'] == name]

    caller_words = sum(word_count(t['text']) for t in turns if t['speaker'] == 'caller')

    # Under 3 caller words, a voicemail greeting or a dropped line → S12, P0.
    if caller_words < 3 or call.get('endReason') in ('voicemail', 'no_answer'):
        out['failedCall'] = True
        out['persona'] = _rule('P0', [])
        failed = tax.scenario_for('S12')
        if failed:
            out['scenarioPrimary'] = _rule(failed, [t['idx'] for t in turns[:2]])
        return out

    reg = called('send_broker_registration_link')
    if reg:
        args = reg[0].get('args') or {}
        bt = args.get('broker_type')
        typ = js_string(bt if bt is not None else '').lower()
        caller_text = ' '.join(lc(t['text']) for t in turns if t['speaker'] == 'caller')
        overseas = bool(_OVERSEAS.search(caller_text)) or 'international' in typ or 'overseas' in typ
        broker = tax.persona_for('P7' if overseas else 'P8') or tax.persona_for('P8') or tax.persona_for('P7') \
            or next((p['id'] for p in tax.personas if p['path'] == 'Broker'), None)
        if broker:
            out['persona'] = _rule(broker, [reg[0]['turnIdx']])
            out['personaPath'] = 'Broker'
        onboarding = tax.scenario_for('S7')
        if onboarding:
            out['scenarioPrimary'] = _rule(onboarding, [reg[0]['turnIdx']])
        out['brokerRegistration'] = 'Registered' if args.get('registered') is True else 'Unregistered' if args.get('registered') is False else None
    transfer = called('request_live_transfer')
    s_transfer, s_change, s_callback, s_returning = (tax.scenario_for(b) for b in ('S5', 'S6', 'S4', 'S9'))
    if not out['scenarioPrimary'] and transfer and s_transfer:
        out['scenarioPrimary'] = _rule(s_transfer, [transfer[0]['turnIdx']])
    cancel = called('cancel_meeting')
    moved = [t for t in called('schedule_meeting') if truthy((t.get('args') or {}).get('reschedule')) or truthy((t.get('args') or {}).get('meeting_id'))]
    if not out['scenarioPrimary'] and (cancel or moved) and s_change:
        out['scenarioPrimary'] = _rule(s_change, [(cancel[0] if cancel else moved[0])['turnIdx']])
    cb = called('schedule_callback')
    other_actions = [t for t in tcs if t['name'] in ('schedule_meeting', 'send_documents', 'request_live_transfer', 'send_broker_registration_link')]
    if not out['scenarioPrimary'] and cb and not other_actions and s_callback:
        out['scenarioPrimary'] = _rule(s_callback, [cb[0]['turnIdx']])
    if (ctx['objective'] != 'empty' or ctx['history'] == 'returning') and s_returning:
        out['scenarioCandidates'].append(s_returning)

    # Events that code can see.
    for tc in tcs:
        if tc.get('ok') is False:
            out['events'].append({'type': 'tool_failure', 'turn': tc['turnIdx'], 'detail': tc['name'], 'source': 'code'})
        if tc['name'] == 'request_live_transfer' and _UNAVAILABLE.search(tc.get('resultText') or ''):
            out['events'].append({'type': 'transfer_unavailable', 'turn': tc['turnIdx'], 'detail': None, 'source': 'code'})
        if tc['name'] == 'send_documents' and _SEND_FAIL.search(tc.get('resultText') or ''):
            fallback = next((t for t in turns if t['idx'] >= tc['turnIdx'] and t['speaker'] == 'agent' and _EMAIL.search(t['text'])), None)
            if fallback is not None:
                out['events'].append({'type': 'whatsapp_fallback_email', 'turn': fallback['idx'], 'detail': None, 'source': 'code'})
    if (call.get('durationS') or 0) >= 900 or call.get('endReason') == 'time_limit':
        out['events'].append({'type': 'time_limit_reached', 'turn': turns[-1]['idx'] if turns else 0, 'detail': None, 'source': 'code'})
    corrective = 0
    for t in turns:
        if t['speaker'] != 'caller':
            continue
        s = lc(t['text'])
        if RX['askedIfAi'].search(s):
            out['events'].append({'type': 'asked_if_ai', 'turn': t['idx'], 'detail': None, 'source': 'code'})
        if RX['dnc'].search(s):
            out['events'].append({'type': 'dnc_request', 'turn': t['idx'], 'detail': None, 'source': 'code'})
        if RX['correction'].search(s):
            corrective += 1
            if corrective == 3:
                out['events'].append({'type': 'interruption_burst', 'turn': t['idx'], 'detail': None, 'source': 'code'})
    return out
