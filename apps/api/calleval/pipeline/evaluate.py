# The evaluation pipeline for one call: context → segment → tag → code, judge and audio checks →
# fields → score. Pure apart from the judge and audio calls, so it runs the same in tests, in the
# worker and in the demo seeder.

from __future__ import annotations

from typing import Any

from ..framework import (
    DEFAULT_TOOL_ALIASES, FRAMEWORK_VERSION, GATES, INVESTOR_DISCOVERY, METRICS, budget_band, metric_by_key, normalise_metric, score_call, timeline_band,
)
from ..js import fixed, js_round, js_str, replace_first, to_fixed
from ..lib.ids import sha
from ..lib.log import err_msg
from ..recommendations.playbook import PLAYBOOK
from ..taxonomy import current, is_target_persona, persona_by_id
from .audio import audio_metrics
from .code_checks import _FAILED, analyse_tools, code_gates, code_metrics
from .context import build_context
from .judge.heuristic import heuristic_classify, heuristic_judge
from .path import evaluate_path, judge_checkpoints
from .rules import rule_tags
from .segment import segment_call
from .text import js_string, quote_of

# HumanOverrides: {tags?: {key: value}, answerKey?: {field: value} | None, gates?: {id: bool}}
# EvaluationResult: {evaluation, runs, classifier, summary}


def apply_aliases(call: dict, extra: dict[str, str] | None = None) -> dict:
    aliases = {**DEFAULT_TOOL_ALIASES, **(extra or {})}
    tool_calls = []
    for tc in call['toolCalls']:
        if tc['name'] in aliases:
            tc = {**tc, 'rawName': tc.get('rawName') if tc.get('rawName') is not None else tc['name'], 'name': aliases[tc['name']]}
        if tc['name']:
            tool_calls.append(tc)
    return {**call, 'toolCalls': tool_calls}


def has_measured_timing(call: dict) -> bool:
    """Turn timing is measured (word timestamps, real ends) rather than estimated from word counts."""
    if call.get('provider') == 'demo':
        return True
    turns = call['turns']
    return len(turns) > 0 and len([t for t in turns if t.get('words')]) / len(turns) > 0.6


def _to_tag(t: dict, layer: str, run_id: str | None = None) -> dict:
    return {'value': t['value'], 'confidence': t['confidence'], 'layer': layer, 'evidence': t['evidence'], 'runId': run_id}


def _combine(code: dict | None, judge: dict | None, kind: str) -> dict | None:
    if not (code and code.get('applicable')):
        return {'raw': judge['raw'], 'applicable': judge['applicable'], 'evidence': judge['evidence'], 'rationale': judge['rationale']} if judge else code
    if not (judge and judge.get('applicable')) or judge.get('raw') is None:
        return code
    # Conservative merge: a count takes the larger, a pass or share takes the lower.
    jr, cr = judge['raw'], code.get('raw')
    pick_judge = (jr if jr is not None else 0) > (cr if cr is not None else 0) if kind == 'low' else (jr if jr is not None else 100) < (cr if cr is not None else 100)
    if pick_judge:
        return {'raw': jr, 'applicable': True, 'evidence': list(dict.fromkeys([*judge['evidence'], *code['evidence']])), 'rationale': judge.get('rationale') or code.get('rationale')}
    return {**code, 'evidence': list(dict.fromkeys([*code['evidence'], *judge['evidence']])), 'rationale': code.get('rationale') or judge.get('rationale')}


async def evaluate_call(raw_call: dict, *, call_id: str, judge: Any, settings: dict, audio: dict | None = None, human: dict | None = None,
                        tool_aliases: dict[str, str] | None = None) -> dict:
    call = apply_aliases(raw_call, tool_aliases)
    runs: list[dict] = []
    ctx = build_context(call)
    rules = rule_tags(call, ctx)

    # Tag: rules → classifier → human review.
    cls_in = {'call': call, 'ctx': ctx, 'rules': rules, 'taxonomyVersion': current().version}
    try:
        cls = await judge.classify(cls_in)
    except Exception as e:  # noqa: BLE001 - the heuristic classifier is the floor
        failed = getattr(e, 'run', None)
        if failed:
            runs.append(failed)
        cls = heuristic_classify(cls_in)
        cls['run']['error'] = f'LLM classifier failed, heuristic used: {err_msg(e)}'
    runs.append(cls['run'])
    layer = 'classifier' if cls['run']['mode'] == 'llm' else 'heuristic'
    human_tags = (human or {}).get('tags') or {}

    def pick(key: str, rule: dict | None, model: dict) -> dict:
        if human_tags.get(key):
            return {'value': human_tags[key], 'confidence': 1, 'layer': 'human', 'evidence': model['evidence']}
        if rule:
            return {**rule, 'evidence': rule['evidence'] if rule['evidence'] else model['evidence']}
        return _to_tag(model, layer, cls['run']['id'])

    persona = pick('persona', rules['persona'], cls['persona'])
    scenario_primary = pick('scenario_primary', rules['scenarioPrimary'], cls['scenarioPrimary'])
    if human_tags.get('scenario_secondary'):
        scenario_secondary = pick('scenario_secondary', None, cls['scenarioSecondary'])
    else:
        sec = {'value': None, 'confidence': 0, 'evidence': []} if cls['scenarioSecondary']['value'] == scenario_primary['value'] else cls['scenarioSecondary']
        scenario_secondary = _to_tag(sec, layer, cls['run']['id'])
    intent_start = pick('intent_start', None, cls['intentStart'])
    intent_end = pick('intent_end', None, cls['intentEnd'])
    p_def = persona_by_id(persona['value'])
    persona_path = rules['personaPath'] if rules['personaPath'] is not None else p_def['path']
    if persona['value'] and p_def['path'] != '—':
        ctx['personaSource'] = 'history' if ctx['persona'] != 'unknown' else 'introduction'

    hint_resolved = None if rules['failedCall'] else cls.get('personaResolvedTurn')
    phases = segment_call(call, ctx, {'personaResolvedAt': hint_resolved, 'turnSegments': cls.get('turnSegments')})

    # Captured fields: classifier extraction, provider data collection where ids match, known facts.
    fields: dict[str, Any] = {'persona': None if persona_path == '—' else persona_path, **cls['fields']}
    for k, v in ((call.get('providerAnalysis') or {}).get('dataCollection') or {}).items():
        val = (v or {}).get('value')
        if k in fields and not fields[k] and val is not None and val != '':
            fields[k] = js_string(val)
    if rules['brokerRegistration'] and not fields.get('registration'):
        fields['registration'] = rules['brokerRegistration']
    if ctx['customerName'] and not fields.get('name'):
        fields['name'] = ctx['customerName']

    scenario = scenario_primary['value']
    measured_timing = has_measured_timing(call)
    tools = analyse_tools(call, ctx, persona_path)
    code_in = {'call': call, 'ctx': ctx, 'phases': phases, 'personaPath': persona_path, 'scenario': scenario, 'fields': fields, 'measuredTiming': measured_timing}
    code = code_metrics(code_in, tools)
    c_gates = code_gates(code_in, tools)

    judge_in = {'call': call, 'ctx': ctx, 'phases': phases, 'personaId': persona['value'], 'personaPath': persona_path, 'scenario': scenario,
                'scenario2': scenario_secondary['value'], 'fields': fields, 'tools': tools, 'checkpoints': judge_checkpoints(scenario)}
    try:
        judged = await judge.judge(judge_in)
    except Exception as e:  # noqa: BLE001 - the heuristic judge is the floor
        failed = getattr(e, 'run', None)
        if failed:
            runs.append(failed)
        judged = heuristic_judge(judge_in)
        judged['run']['error'] = f'LLM judge failed, heuristic used: {err_msg(e)}'
    runs.append(judged['run'])

    aud = audio_metrics(call, audio) if audio and audio.get('usable') else {}
    recording = bool((call.get('recording') or {}).get('available'))

    # Field capture accuracy against a human answer key, when one exists.
    answer_key = (human or {}).get('answerKey')
    if answer_key:
        keys = list(answer_key)

        def norm(s: Any) -> str:
            return ('' if s is None else js_string(s)).strip().lower()

        tp = len([k for k in keys if norm(fields.get(k)) and norm(fields.get(k)) == norm(answer_key[k])])
        predicted = len([k for k in keys if norm(fields.get(k))])
        precision = tp / predicted if predicted else 1
        recall = tp / len(keys) if keys else 1
        code['fca'] = {'raw': fixed(min(precision, recall) * 100, 1), 'applicable': True, 'evidence': [],
                       'rationale': f'Precision {to_fixed(precision * 100, 0)}%, recall {to_fixed(recall * 100, 0)}% against the labelled answer key.'}

    # Merge into metric outcomes.
    metrics: list[dict] = []
    for m in METRICS:
        j = judged['metrics'].get(m['key'])
        method = m['method']
        if method == 'code':
            r = code.get(m['key'])
        elif method == 'judge':
            r = {'raw': j['raw'], 'applicable': j['applicable'], 'evidence': j['evidence'], 'rationale': j['rationale']} if j else None
        elif method == 'code + judge':
            r = _combine(code.get(m['key']), j, m['norm']['kind'])
        else:
            r = aud.get(m['key'])
            if r is None:
                r = None if m.get('needsAudio') else code.get(m['key'])
        # No usable recording drops the whole Emotion and realism dimension; weights re-normalise.
        if m['dim'] == 'emo' and not recording:
            r = None
        # Investor path: broker checks don't apply; broker path: buyer discovery isn't scored.
        if m['key'] == 'bpp' and persona_path != 'Broker':
            r = None
        if not r or not r.get('applicable') or r.get('raw') is None:
            metrics.append({'key': m['key'], 'applicable': False, 'raw': None, 'value': None, 'method': method,
                            'evidence': (r or {}).get('evidence') if (r or {}).get('evidence') is not None else [],
                            'rationale': (r or {}).get('rationale'), 'runId': None})
            continue
        value = r['value'] if r.get('value') is not None else normalise_metric(m, r['raw'])
        run_id = judged['run']['id'] if 'judge' in method and j else 'audio' if method == 'audio' and aud.get(m['key']) else None
        metrics.append({'key': m['key'], 'applicable': True, 'raw': r['raw'], 'value': value,
                        'method': f'{method} (heuristic)' if judged['run']['mode'] == 'heuristic' and 'judge' in method else method,
                        'evidence': r['evidence'][:6], 'rationale': r.get('rationale'), 'runId': run_id})

    # Gates: code and judge each decide what they can see; a failure from either stands.
    human_gates = (human or {}).get('gates') or {}
    gates: list[dict] = []
    for g in GATES:
        c = next((x for x in c_gates if x['id'] == g['id'] and x['failed']), None)
        jg = judged['gates'].get(g['id'])
        human_call = human_gates.get(g['id'])
        if human_call is False:
            gates.append({'id': g['id'], 'failed': False, 'turn': None, 'detail': 'Overturned in human review.', 'source': 'human'})
        elif human_call is True:
            turn = c['turn'] if c is not None and c['turn'] is not None else jg.get('turn') if jg else None
            detail = c['detail'] if c is not None and c['detail'] is not None else jg['detail'] if jg and jg.get('detail') is not None else 'Confirmed in human review.'
            gates.append({'id': g['id'], 'failed': True, 'turn': turn, 'detail': detail, 'source': 'human'})
        elif c is not None:
            gates.append({'id': g['id'], 'failed': True, 'turn': c['turn'], 'detail': c['detail'], 'source': 'code'})
        elif jg and jg.get('failed'):
            gates.append({'id': g['id'], 'failed': True, 'turn': jg['turn'], 'detail': jg['detail'], 'source': 'judge' if judged['run']['mode'] == 'llm' else 'heuristic',
                          'runId': judged['run']['id']})
        else:
            gates.append({'id': g['id'], 'failed': False, 'turn': None, 'detail': None, 'source': 'code'})
    failed_gates = [g for g in gates if g['failed']]

    values = {m['key']: m['value'] for m in metrics}
    score = score_call(values, len(failed_gates), settings['weights'])

    path = evaluate_path(call, scenario, phases, tools, fields, judged['checkpoints'])

    # Events: rules, classifier and gates.
    events: list[dict] = []
    seen: set[str] = set()

    def add_ev(e: dict) -> None:
        k = f"{e['type']}|{js_str(e['turn'])}"
        if k not in seen:
            seen.add(k)
            events.append(e)

    for e in rules['events']:
        add_ev(e)
    for e in cls['events']:
        add_ev({'type': e['type'], 'turn': e['turn'], 'detail': None, 'source': layer})
    for g in failed_gates:
        add_ev({'type': 'gate_failure', 'turn': g['turn'] if g['turn'] is not None else 0, 'detail': g['id'], 'source': g['source']})
    events.sort(key=lambda e: e['turn'])

    rank = {'cold': 0, 'warm': 1, 'hot': 2}
    sv, ev_ = intent_start['value'], intent_end['value']
    intent_change = f'{sv} → {ev_}' if sv and ev_ else None
    if sv and ev_ and not any(e['type'] in ('intent_rose', 'intent_fell') for e in events):
        a, b = rank.get(ev_), rank.get(sv)
        if a is not None and b is not None and a > b:
            add_ev({'type': 'intent_rose', 'turn': len(call['turns']) - 1, 'detail': None, 'source': layer})
        if a is not None and b is not None and a < b:
            add_ev({'type': 'intent_fell', 'turn': len(call['turns']) - 1, 'detail': None, 'source': layer})

    # Qualified lead: target persona resolved with at least 5 of the 7 discovery fields (brokers: registration status known).
    covered = len([f for f in INVESTOR_DISCOVERY if any(fields.get(k) and fields.get(k) != 'Not captured' for k in f['fields'])])
    qualified = bool(fields.get('registration')) if persona_path == 'Broker' else persona_path == 'Investor' and phases['personaResolvedAt'] is not None and covered >= 5

    sch = next((m for m in metrics if m['key'] == 'sch'), None)
    sch_raw = sch['raw'] if sch is not None else None
    ab = next((m for m in metrics if m['key'] == 'ab'), None)
    abandoned = ab is not None and ab['value'] == 0

    order = {m['key']: i for i, m in enumerate(METRICS)}
    lowest = [
        {'key': m['key'], 'value': m['value'], 'turn': m['evidence'][0] if m['evidence'] else None, 'quote': quote_of(call, m['evidence'][0] if m['evidence'] else None), 'why': m['rationale']}
        for m in sorted((m for m in metrics if m['applicable'] and m['value'] is not None), key=lambda m: (m['value'], order[m['key']]))[:3]
    ]

    # Coaching: the judge's own coaching when it ran, otherwise the playbook for the weakest points.
    if judged['coaching']:
        coaching = [{'title': c['issue'], 'detail': c['issue'], 'turn': c['turn'], 'suggestion': c['better']} for c in judged['coaching']]
    else:
        picks = [*({'key': g['id'], 'turn': g['turn'], 'why': g['detail']} for g in failed_gates), *({'key': x['key'], 'turn': x['turn'], 'why': x['why']} for x in lowest if x['value'] < 70)][:3]
        coaching = []
        for x in picks:
            pb = PLAYBOOK.get(x['key'])
            md = metric_by_key(x['key'])
            title = pb['title'] if pb else md['name'] if md else x['key']
            coaching.append({'title': title, 'detail': x['why'] if x['why'] is not None else '', 'turn': x['turn'], 'suggestion': (pb or {}).get('coach') or None})

    # Review queue: low-confidence tags, every gate failure, and a random sample.
    review: list[dict] = []
    thr = settings['confidenceThreshold']
    for key, t in (('persona', persona), ('scenario_primary', scenario_primary), ('intent_end', intent_end)):
        if t['layer'] not in ('human', 'rule') and t['value'] and t['confidence'] < thr:
            review.append({'kind': 'tag', 'reason': f"{replace_first(key, '_', ' ')} under {js_str(thr)} confidence", 'tagKey': key})
    # A gate a reviewer has already confirmed is not sent back for review when the call is scored again.
    unreviewed = [g for g in failed_gates if g['source'] != 'human']
    if unreviewed:
        review.append({'kind': 'gate', 'reason': f"Compliance gate failed: {', '.join(g['id'] for g in failed_gates)}"})
    if not review and int(sha(call_id, 8), 16) / 0xFFFFFFFF < settings['reviewSampleRate']:
        review.append({'kind': 'sample', 'reason': f"{js_round(settings['reviewSampleRate'] * 100)}% random sample"})

    dv = call.get('dynamicVariables') or {}
    facets = {
        'direction': None if ctx['direction'] == 'unknown' else 'Inbound' if ctx['direction'] == 'inbound' else 'Outbound',
        'history': 'Returning' if ctx['history'] == 'returning' else 'New',
        'intent_start': intent_start['value'], 'intent_end': intent_end['value'],
        'budget_band': budget_band(cls.get('budgetAed'), settings['budgetBands']),
        'timeline_band': timeline_band(cls.get('timelineMonths')) if persona_path == 'Investor' else None,
        'language': cls['language'] if cls.get('language') is not None else call.get('language'),
        'broker_registration': fields.get('registration') if persona_path == 'Broker' else None,
        'lead_source': dv['lead_source'] if isinstance(dv.get('lead_source'), str) else None,
    }

    tool_names = list(dict.fromkeys([*(x['tc']['name'] for x in tools['made']), *(x['tool'] for x in tools['expected'])]))
    tool_stats = []
    for name in tool_names:
        made = [x for x in tools['made'] if x['tc']['name'] == name]
        exp = [x for x in tools['expected'] if x['tool'] == name]
        fid = [x for x in made if x['fidelityOk'] is not None]
        tool_stats.append({'name': name, 'made': len(made), 'correct': len([x for x in made if x['correct'] and x['argsOk']]), 'expected': len(exp),
                           'met': len([x for x in exp if x['met']]), 'fidelityChecked': len(fid), 'fidelityOk': len([x for x in fid if x['fidelityOk']]),
                           'errors': len([x for x in made if x['tc'].get('ok') is False or _FAILED.search(x['tc'].get('resultText') or '')])})

    nst = tools['nextStepTool']
    evaluation = {
        'callId': call_id,
        'frameworkVersion': FRAMEWORK_VERSION,
        'taxonomyVersion': current().version,
        'context': ctx,
        'phases': phases,
        'tags': {'persona': persona, 'scenarioPrimary': scenario_primary, 'scenarioSecondary': scenario_secondary, 'intentStart': intent_start, 'intentEnd': intent_end,
                 'facets': facets, 'events': events},
        'fields': fields,
        'metrics': metrics,
        'gates': gates,
        'path': path,
        'outcome': {
            'nextStep': tools['nextStep'],
            'nextStepDetail': nst['name'] + (f" · {tools['meetingKind']}" if tools['meetingKind'] else '') if nst is not None else None,
            'meetingKind': tools['meetingKind'],
            'sentimentDelta': sch_raw,
            'intentChange': intent_change,
            'qualified': bool(qualified) and is_target_persona(persona['value']),
            'abandoned': abandoned,
        },
        'dims': score['roll'],
        'rawCqs': fixed(score['raw'], 2),
        'cqs': score['cqs'],
        'band': score['band'],
        'lowest': lowest,
        'coaching': coaching,
        'review': review,
        'judgeMode': judged['run']['mode'],
        'toolStats': tool_stats,
    }
    return {'evaluation': evaluation, 'runs': runs, 'classifier': cls, 'summary': cls['summary']}
