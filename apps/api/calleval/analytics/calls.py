# Call list and call drill-down.

from __future__ import annotations

import re
from typing import Any
from urllib.parse import quote

from ..framework import FACETS, FIELD_LABELS, METRICS, band_action, gate_by_id
from ..js import at, en_us, fixed, iso, jsre, js_json, js_number, js_round, js_str, num_or, replace_first, test, to_fixed, utc_string
from ..taxonomy import current, persona_by_id, scenario_by_id
from .filters import parse_slice, slice_where


def _title(persona: str | None, scenario: str | None) -> str:
    p, s = persona_by_id(persona), scenario_by_id(scenario)
    return f"{p['id']} {p['name']}{f' × {s['id']} {s['name']}' if s else ''}"


def note_of(r: dict) -> dict:
    if r['status'] == 'failed':
        return {'note': f"Pipeline error{f': {str(r.get('error'))[:80]}' if r.get('error') else ''}", 'tone': 'accent'}
    if r['status'] != 'scored':
        return {'note': 'In the pipeline', 'tone': 'ink'}
    if r.get('gated'):
        return {'note': 'Gate failure · in human review', 'tone': 'accent'}
    if r.get('needs_review'):
        return {'note': 'Tag under the confidence line · queued for review', 'tone': 'accent'}
    if r.get('band') == 'Excellent':
        return {'note': 'Reference call', 'tone': 'ink'}
    if r.get('band') in ('Fail', 'Needs review'):
        return {'note': band_action(r['cqs'] if r.get('cqs') is not None else 0), 'tone': 'accent'}
    return {'note': None, 'tone': 'ink'}


async def list_calls(db, q: dict[str, Any]) -> dict:
    f = parse_slice(q)
    w = await slice_where(db, f, [], 1)
    params = list(w['params'])

    def p(v: Any) -> str:
        params.append(v)
        return f'${len(params)}'

    conds = [replace_first(w['sql'], "c.status = 'scored'", "c.status in ('scored','failed','ingested','evaluating')")]

    def s(k: str) -> str | None:
        v = q.get(k)
        return str(v) if isinstance(v, str) and v else None

    if s('persona'):
        conds.append(f"c.persona = {p(s('persona'))}")
    if s('scenario'):
        conds.append(f"c.scenario = {p(s('scenario'))}")
    if s('band'):
        conds.append(f"c.band = {p(s('band'))}")
    if s('gated') == 'true':
        conds.append('c.gated')
    if s('review') == 'true':
        conds.append('c.needs_review')
    if s('status'):
        conds.append(f"c.status = {p(s('status'))}")
    if s('q'):
        like = f"%{re.sub(r'[%_]', '', s('q'))}%"
        conds.append(f'(c.call_id ilike {p(like)} or c.external_id ilike ${len(params)} or c.canonical::text ilike ${len(params)})')
    sort = 'c.cqs asc nulls last, c.started_at desc' if s('sort') == 'worst' else 'c.cqs desc nulls last, c.started_at desc' if s('sort') == 'best' else 'c.started_at desc'
    # A limit or offset that is not a number falls back to the default instead of failing the query.
    limit = int(min(200, max(1, num_or(s('limit'), 50))))
    offset = int(max(0, num_or(s('offset'), 0)))
    where = ' and '.join(conds)
    total_row = await db.one(f'select count(*)::int as n from calls c where {where}', params)
    total = total_row['n'] if total_row else 0
    rows = await db.query(
        f"""select c.call_id, c.provider, c.external_id, c.started_at, c.duration_s, c.direction, c.persona, c.scenario, c.scenario2, c.cqs, c.raw_cqs, c.band, c.gated,
       c.prompt_version, c.status, c.error, c.needs_review, c.next_step, a.name as agent_name, s.gates
     from calls c left join agent a on a.id = c.agent_id left join call_score s on s.call_id = c.call_id
     where {where} order by {sort} limit {js_str(limit)} offset {js_str(offset)}""",
        params,
    )
    items = [{
        'id': r['call_id'], 'provider': r['provider'], 'externalId': r['external_id'], 'title': _title(r['persona'], r['scenario']) if r['persona'] else 'Not scored yet',
        'startedAt': iso(r['started_at']), 'durationS': js_number(r['duration_s']), 'direction': r['direction'], 'persona': r['persona'], 'scenario': r['scenario'],
        'scenario2': r['scenario2'], 'cqs': None if r['cqs'] is None else js_round(js_number(r['cqs'])), 'rawCqs': None if r['raw_cqs'] is None else js_round(js_number(r['raw_cqs'])),
        'band': r['band'], 'gates': [g['id'] for g in (r['gates'] or [])], 'promptVersion': r['prompt_version'], 'agentName': r['agent_name'], 'status': r['status'],
        'note': note_of(r)['note'], 'needsReview': bool(r['needs_review']), 'nextStep': r['next_step'],
    } for r in rows]
    return {'items': items, 'total': total}


def _fmt_dur(s: float) -> str:
    t = js_round(s)  # round first, so 119.6 s reads 2:00, not 1:60
    return f'{t // 60}:{t % 60:02d}'


def _cap(s: Any) -> Any:
    return s[0].upper() + s[1:] if s else s


END_LABEL = {
    'natural_close': 'Natural close', 'caller_hangup': 'Caller hung up', 'agent_hangup': 'Agent hung up', 'transfer': 'Live transfer', 'time_limit': 'Time limit',
    'voicemail': 'Voicemail', 'dnc': 'Do-not-contact', 'no_answer': 'No answer', 'error': 'Error', 'unknown': 'Unknown',
}

_RX_CORRECTION = jsre(r'\b(no|not|i said|we said)\b', 'i')
_RX_IMPATIENCE = jsre(r'\b(okay,? okay|just|can you just)\b', 'i')


def _event_label(type: str) -> str:
    e = current().event(type)
    return e['label'] if e else type


def _nz(v: Any, d: Any) -> Any:
    return v if v is not None else d


async def call_detail(db, id: str) -> dict | None:
    from ..recommendations.engine import list_recommendations
    from .review import list_review

    c = await db.one('select c.*, a.name as agent_name from calls c left join agent a on a.id = c.agent_id where c.call_id = $1', [id])
    if not c:
        return None
    call = c['canonical']
    s = await db.one('select * from call_score where call_id = $1', [id])
    tags = await db.query('select * from call_tag where call_id = $1', [id])
    events = await db.query('select * from call_event where call_id = $1 order by turn', [id])
    metrics = await db.query('select * from metric_result where call_id = $1', [id])
    spans = await db.query('select * from trace_span where call_id = $1 order by start_s nulls last', [id])
    runs = await db.query('select * from eval_run where call_id = $1 order by created_at', [id])
    outcomes = await db.query('select * from lead_outcome where lead_id = $1 order by occurred_at', [c['lead_id']]) if c['lead_id'] else []

    def tag(k: str) -> dict | None:
        return next((t for t in tags if t['tag_key'] == k), None)

    ctx = s.get('context') if s else None
    phases = s.get('phases') if s else None
    fields = _nz(s.get('fields') if s else None, {})
    outcome = _nz(s.get('outcome') if s else None, {})
    call_turns = (call or {}).get('turns') or [] if call is not None else []

    # Turns with tools, latency, delivery tags, barge-ins and events.
    ev_by_turn: dict[Any, str] = {}
    for e in events:
        if e['turn'] not in ev_by_turn:
            ev_by_turn[e['turn']] = 'Gate failure' if e['type'] == 'gate_failure' else _event_label(e['type'])
    pra = phases.get('personaResolvedAt') if phases else None
    if pra is not None and pra not in ev_by_turn:
        ev_by_turn[pra] = 'Persona resolved'
    turns = []
    for t in call_turns:
        prev = at(call['turns'], t['idx'] - 1)
        tools = [{
            'name': tc['name'], 'args': ', '.join(f'{k}: {js_json(v)}' for k, v in (tc.get('args') or {}).items()),
            'result': tc['resultText'] if tc.get('resultText') is not None else (js_json(tc['result']) if tc.get('result') is not None else ''),
            'ok': tc.get('ok'), 'durationS': tc.get('durationS'),
        } for tc in (call.get('toolCalls') or []) if tc.get('turnIdx') == t['idx']]
        lat = None
        if t['speaker'] == 'agent' and prev and prev['speaker'] == 'caller':
            base = t['latencyS'] if t.get('latencyS') is not None else max(0, t['startS'] - (prev['endS'] if prev.get('endS') is not None else prev['startS']))
            lat = fixed(base, 2)
        barge = None
        if t['speaker'] == 'caller' and prev and prev['speaker'] == 'agent' and (prev.get('interrupted') or (prev.get('endS') is not None and t['startS'] < prev['endS'] - 0.15)):
            barge = 'correction' if test(_RX_CORRECTION, t['text']) else 'impatience' if test(_RX_IMPATIENCE, t['text']) else 'new question'
        ts = phases.get('turnSegments') if phases else None
        phase = next((p['name'] for p in (phases.get('phases') or []) if p['from'] <= t['idx'] <= p['to']), None) if phases else None
        dto = {
            'id': t['idx'], 'sp': 'A' if t['speaker'] == 'agent' else 'C', 't': t['startS'], 'end': t.get('endS'), 'text': t['text'], 'lat': lat,
            'tag': at(t.get('tags') or [], 0), 'barge': barge, 'event': ev_by_turn.get(t['idx']),
            'seg': (ts or {}).get(str(t['idx'])) if ts is not None else None, 'phase': phase,
        }
        if tools:
            dto['tools'] = tools
        turns.append(dto)

    # Trace: per-turn spans and evaluator runs.
    turn_spans: dict[str, list] = {}
    sums = {'eot': 0, 'llm': 0, 'tool': 0, 'tts': 0}
    per_turn: dict[int, float] = {}
    for sp in spans:
        if sp['turn'] is None or sp['kind'] == 'tool_call':
            continue
        prev = at(call['turns'], sp['turn'] - 1)
        origin = (prev['endS'] if prev.get('endS') is not None else prev['startS']) if prev else 0
        dur = num_or(sp['duration_s'], 0)
        turn_spans.setdefault(str(sp['turn']), []).append({'label': sp['name'], 'start': max(0, js_number(sp['start_s']) - origin), 'dur': dur, 'kind': sp['kind']})
        if sp['kind'] in sums:
            sums[sp['kind']] += dur
        per_turn[sp['turn']] = per_turn.get(sp['turn'], 0) + dur
    for sp in [x for x in spans if x['kind'] == 'tool_call' and x['turn'] is not None]:
        t = at(call['turns'], sp['turn'])
        prev = at(call['turns'], sp['turn'] - 1)
        origin = (prev['endS'] if prev.get('endS') is not None else prev['startS']) if prev else 0
        if not t or sp['start_s'] is None:
            continue
        blocking = js_number(sp['start_s']) < t['startS'] - 0.05
        if not blocking:
            turn_spans.setdefault(str(sp['turn']), []).append({'label': f"Tool · {sp['name']} (during speech)", 'start': max(0, js_number(sp['start_s']) - origin), 'dur': num_or(sp['duration_s'], 0.3), 'kind': 'bg'})
    lat_turns = sorted([t for t in turns if t['lat'] is not None], key=lambda t: -(t['lat'] or 0))
    slow = lat_turns[0] if lat_turns else None
    judged = len([m for m in metrics if m['applicable'] and 'judge' in str(m['method'])])
    tok_in = sum(r['input_tokens'] or 0 for r in runs)
    tok_out = sum(r['output_tokens'] or 0 for r in runs)
    evals: list[list[str]] = []
    for r in runs:
        kind = r['kind']
        name = 'Judge run · judged metrics, gates and path' if kind.startswith('judge') else 'Persona and scenario classifier' if kind.startswith('classifier') else kind
        who = 'heuristic' if kind.endswith('heuristic') else (r['model'] if r['model'] is not None else 'model')
        lat_s = f" · {to_fixed(r['latency_ms'] / 1000, 1)} s" if r['latency_ms'] else ''
        tok = f" · {en_us(r['input_tokens'])} in / {js_str(r['output_tokens'])} out" if r['input_tokens'] else ''
        evals.append([name, f"{who} · {r['status']}{lat_s}{tok}"])
    if judged:
        evals.insert(0, ['Judged metrics on this call', str(judged)])

    metric_rows = []
    for m in METRICS:
        r = next((x for x in metrics if x['metric_key'] == m['key']), None)
        metric_rows.append({
            'key': m['key'], 'dim': m['dim'], 'name': m['name'], 'target': m['target'], 'method': r['method'] if r and r['method'] is not None else m['method'],
            'value': js_round(js_number(r['value'])) if r and r['applicable'] and r['value'] is not None else None,
            'raw': None if not r or r['raw'] is None else js_number(r['raw']),
            'unit': m['unit'], 'evidence': (r['evidence'] if r and r['evidence'] is not None else []), 'rationale': r['rationale'] if r else None,
            'runId': r['run_id'] if r else None,
        })

    n = note_of({'gated': bool(c['gated']), 'needs_review': bool(c['needs_review']), 'band': c['band'], 'status': c['status'], 'cqs': c['cqs'], 'error': c['error']})

    def tag_row(k: str, label: str) -> dict | None:
        t = tag(k)
        if not t or not t['value']:
            return None
        if k == 'persona':
            v = f"{t['value']} {persona_by_id(t['value'])['name']}"
        elif k.startswith('scenario'):
            sc = scenario_by_id(t['value'])
            v = f"{t['value']} {sc['name'] if sc else ''}"
        else:
            v = _cap(t['value'])
        return {'key': k, 'label': label, 'value': v, 'conf': js_number(_nz(t['confidence'], 0)), 'layer': t['layer'], 'ev': _nz(t['evidence'], [])}

    intent_s = (tag('intent_start') or {}).get('value')
    intent_e = (tag('intent_end') or {}).get('value')
    tag_list = [x for x in [tag_row('persona', 'Persona'), tag_row('scenario_primary', 'Primary scenario'), tag_row('scenario_secondary', 'Secondary scenario')] if x]
    if intent_s and intent_e:
        ti = tag('intent_end')
        tag_list.append({'key': 'intent', 'label': 'Intent at start → end', 'value': f'{_cap(intent_s)} → {_cap(intent_e)}', 'conf': js_number(_nz(ti['confidence'], 0)),
                         'layer': ti['layer'], 'ev': [*_nz((tag('intent_start') or {}).get('evidence'), []), *_nz(ti['evidence'], [])]})
    facet_rows = []
    for fc in FACETS:
        if fc['id'] == 'intent':
            continue
        v = (tag(f"facet:{fc['id']}") or {}).get('value')
        if v:
            facet_rows.append([fc['name'], v.upper() if fc['id'] == 'language' else v])

    has_recording = bool(c['has_audio']) and c['provider'] != 'demo'
    context: list = []
    if ctx:
        if ctx.get('persona') != 'unknown':
            persona_line = f"{_cap(ctx.get('persona'))}, known from history"
        elif phases and phases.get('personaResolvedAt') is not None:
            path = persona_by_id(c['persona'])['path']
            persona_line = f"{'Broker' if path == 'Broker' else 'Investor' if path == 'Investor' else 'Non-target'}, resolved at turn {js_str(phases['personaResolvedAt'])}"
        else:
            persona_line = 'Unresolved'
        context = [
            ['Direction', _cap(ctx.get('direction'))],
            ['Identity', f"Name known{f' ({ctx['customerName']})' if ctx.get('customerName') else ''}" if ctx.get('identity') == 'known' else 'Name unknown'],
            ['History', _cap(ctx.get('history'))],
            ['Objective', 'Empty' if ctx.get('objective') == 'empty' else _nz(ctx.get('objectiveText'), _cap(ctx.get('objective')))],
            ['Persona', persona_line],
        ]
    provider = c['provider']
    record = [
        ['Started', utc_string(c['started_at']).replace(' GMT', ' UTC', 1)], ['Duration', _fmt_dur(js_number(c['duration_s']))],
        ['End reason', END_LABEL.get(c['end_reason']) if c['end_reason'] in END_LABEL else (c['end_reason'] if c['end_reason'] is not None else '—')],
        ['Prompt', _nz(c['prompt_version'], '—')],
        ['Agent', f"{c['agent_name']}{f' · {c['agent_version']}' if c['agent_version'] else ''}" if c['agent_name'] else '—'],
        ['Source', 'ElevenLabs' if provider == 'elevenlabs' else 'Retell AI' if provider == 'retell' else 'Upload' if provider == 'upload' else 'Demo'],
        ['Language', _nz(c['language'], '—').upper()],
        ['Recording', 'Dual-channel' if c['recording_channels'] == 2 else 'Mono' if c['recording_channels'] == 1 else 'Available' if c['has_audio'] else 'None'],
    ]
    path_dto = None
    if s and s.get('path') is not None:
        sp_ = s['path']
        sc = scenario_by_id(sp_.get('scenario'))
        path_dto = {'scenario': f"{js_str(sp_.get('scenario')) if sp_.get('scenario') is not None else 'undefined'} {sc['name'] if sc else ''}".strip(),
                    'steps': [{'label': x.get('label'), 'turn': x.get('turn'), 'hit': x.get('hit')} for x in sp_['steps']], 'deviation': sp_.get('deviation')}
    outcome_rows: list = []
    if s:
        mk = outcome.get('meetingKind')
        sd = outcome.get('sentimentDelta')
        ic = outcome.get('intentChange')
        outcome_rows = [
            ['Next step', f"{_cap(outcome['nextStep'])}{f' · {replace_first(js_str(mk) if not isinstance(mk, str) else mk, '_', ' ')}' if mk else ''}" if outcome.get('nextStep') else 'None'],
            ['Sentiment change', '—' if sd is None else f"{'+' if sd > 0 else ''}{js_str(sd)}"],
            ['Intent', ' → '.join(_cap(x) for x in ic.split(' → ')) if ic else '—'],
            ['Qualified lead', 'Yes' if outcome.get('qualified') else 'No'],
        ]
    pa = (call or {}).get('providerAnalysis') if call is not None else None
    return {
        'id': c['call_id'], 'provider': provider, 'externalId': c['external_id'], 'title': _title(c['persona'], c['scenario']) if c['persona'] else 'Not scored yet',
        'startedAt': iso(c['started_at']), 'durationS': js_number(c['duration_s']), 'direction': c['direction'], 'endReason': _nz(c['end_reason'], 'unknown'),
        'endReasonRaw': c['end_reason_raw'], 'language': c['language'], 'promptVersion': c['prompt_version'], 'agentVersion': c['agent_version'], 'agentName': c['agent_name'],
        'audioUrl': f"/api/calls/{quote(id, safe='-_.!~*()' + chr(39))}/audio" if has_recording else None,
        'recordingChannels': c['recording_channels'], 'status': c['status'], 'source': c['source'], 'judgeMode': c['judge_mode'], 'note': n['note'], 'noteTone': n['tone'],
        'context': context,
        'record': record,
        'gates': [{'id': g['id'], 'text': (gate_by_id(g['id']) or {}).get('text', g['id']), 'detail': _nz(g.get('detail'), ''), 'turn': g.get('turn'), 'runId': g.get('runId')}
                  for g in _nz(s.get('gates') if s else None, [])],
        'tags': tag_list,
        'events': [{'type': e['type'], 'label': f"Gate failure{f' · {e['detail']}' if e['detail'] else ''}" if e['type'] == 'gate_failure' else _event_label(e['type']), 'turn': e['turn']} for e in events],
        'facets': facet_rows,
        'phases': _nz(phases.get('phases') if phases else None, []),
        'segs': _nz(phases.get('segments') if phases else None, []),
        'path': path_dto,
        'fields': [[FIELD_LABELS[k], _nz(v, 'Not captured')] for k, v in fields.items() if k in FIELD_LABELS],
        'outcome': outcome_rows,
        'metrics': metric_rows,
        'dims': _nz(s.get('dims') if s else None, {}),
        'cqs': None if c['cqs'] is None else js_round(js_number(c['cqs'])), 'rawCqs': None if c['raw_cqs'] is None else js_round(js_number(c['raw_cqs'])), 'band': c['band'],
        'lowest': _nz(s.get('lowest') if s else None, []),
        'turns': turns,
        'trace': {
            'id': f"tr_{str(c['external_id'])[-8:]}", 'spans': len(spans), 'llmCalls': len([r for r in runs if not str(r['kind']).endswith('heuristic')]),
            'inTok': tok_in, 'outTok': tok_out, 'n': len(per_turn), 'sums': sums, 'slowTurn': {'id': slow['id'], 'lat': _nz(slow['lat'], 0)} if slow else None,
            'evals': evals, 'turnSpans': turn_spans,
        },
        'coaching': _nz(s.get('coaching') if s else None, []),
        'recommendations': await list_recommendations(db, scope='call', scope_key=id),
        'review': await list_review(db, call_id=id, status='all'),
        'providerAnalysis': {'summary': pa.get('summary'), 'successful': pa.get('successful'), 'sentiment': pa.get('sentiment')} if pa else None,
        'crm': {'leadId': c['lead_id'], 'outcomes': [{'stage': o['stage'], 'at': iso(o['occurred_at']), 'valueAed': o['value_aed'], 'credited': o['credited_call_id'] == id} for o in outcomes]},
    }
