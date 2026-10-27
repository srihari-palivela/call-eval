# Step 9: score and store. Writes calls (denormalised tags and score for fast slicing), call_tag,
# call_event, metric_result, call_score, review items, trace spans and evaluator runs, replacing
# anything a previous evaluation of the same call wrote.

from __future__ import annotations

from ..db import insert_many, json_
from ..framework import FRAMEWORK_VERSION, TAXONOMY_VERSION
from ..taxonomy import persona_by_id
from ..js import at, jsre
from ..lib.ids import new_id
from .text import turn_end

# Span: {id, turn, kind, name, startS, durationS, model?, tokensIn?, tokensOut?, status, meta?}

_LLM = jsre(r'llm', 'i')
_TTS = jsre(r'tts', 'i')
_EOT = jsre(r'asr|stt|eot|end_of_turn|turn_detect', 'i')
_ERROR = jsre(r'\b(fail|failed|error|unavailable)\b', 'i')


def _span(turn, kind: str, name: str, start, dur, status: str = 'ok', meta=None) -> dict:
    s = {'id': new_id('sp'), 'turn': turn, 'kind': kind, 'name': name, 'startS': start, 'durationS': dur, 'status': status}
    if meta is not None:
        s['meta'] = meta
    return s


def build_spans(call: dict) -> list[dict]:
    """Agent-side spans per turn: end-of-turn, LLM, tool wait and TTS where the provider measures them."""
    spans: list[dict] = []
    for t in call['turns']:
        if t['speaker'] != 'agent':
            continue
        prev = at(call['turns'], t['idx'] - 1)
        lat = (t['latencyS'] if t.get('latencyS') is not None else max(0, t['startS'] - turn_end(prev))) if prev is not None and prev['speaker'] == 'caller' else None
        blocking = [tc for tc in call['toolCalls'] if tc['turnIdx'] == t['idx'] and tc.get('startS') is not None and tc['startS'] < t['startS'] - 0.05]
        tool_wait = sum(tc.get('durationS') or 0 for tc in blocking)
        m = t.get('turnMetrics') or {}

        def pick_m(rx) -> float:
            return sum(v for k, v in m.items() if rx.search(k))

        llm, tts, eot = pick_m(_LLM), pick_m(_TTS), pick_m(_EOT)
        if lat is not None:
            start = turn_end(prev) if prev is not None else t['startS']
            names = ', '.join(b['name'] for b in blocking)
            if llm or tts or eot:
                cur = start
                if eot:
                    spans.append(_span(t['idx'], 'eot', 'End-of-turn + final transcript', cur, eot))
                    cur += eot
                if tool_wait:
                    spans.append(_span(t['idx'], 'tool', f'Tool wait · {names}', cur, tool_wait))
                    cur += tool_wait
                if llm:
                    spans.append(_span(t['idx'], 'llm', 'LLM · time to first token', cur, llm))
                    cur += llm
                if tts:
                    spans.append(_span(t['idx'], 'tts', 'TTS · first audio', cur, tts))
            else:
                # The provider gives no breakdown: tool wait is known, the rest is the agent's response time.
                if tool_wait:
                    spans.append(_span(t['idx'], 'tool', f'Tool wait · {names} (no filler)', start, min(tool_wait, lat)))
                rest = max(0, lat - min(tool_wait, lat))
                spans.append(_span(t['idx'], 'llm', 'Agent response (end-of-turn + LLM + TTS, not broken down)', start + min(tool_wait, lat), rest))
    for tc in call['toolCalls']:
        status = 'error' if tc.get('ok') is False or _ERROR.search(tc.get('resultText') or '') else 'ok'
        spans.append(_span(tc['turnIdx'], 'tool_call', tc['name'], tc.get('startS'), tc.get('durationS'), status,
                           {'args': tc.get('args'), 'result': (tc.get('resultText') or '')[:500]}))
    return spans


async def store_evaluation(db, call: dict, ev: dict, runs: list[dict], summary: str) -> None:
    id = ev['callId']
    fv, tv = FRAMEWORK_VERSION, ev.get('taxonomyVersion') or TAXONOMY_VERSION
    spans = build_spans(call)
    gated = any(g['failed'] for g in ev['gates'])
    p = persona_by_id(ev['tags']['persona']['value'])
    tags = ev['tags']

    async def write(t) -> None:
        # Re-scoring replaces the evaluation, its spans and its evaluator runs (so token counts are not double-counted).
        for table in ('call_tag', 'call_event', 'metric_result', 'call_score', 'trace_span', 'eval_run'):
            await t.query(f'delete from {table} where call_id = $1', [id])
        await t.query("delete from review_item where call_id = $1 and status = 'open'", [id])

        tag_rows: list[list] = []

        def tag(key: str, v: dict) -> None:
            tag_rows.append([id, tv, key, v['value'], v['confidence'], v['layer'], json_(v['evidence']), v.get('runId')])

        tag('persona', tags['persona'])
        tag('scenario_primary', tags['scenarioPrimary'])
        tag('scenario_secondary', tags['scenarioSecondary'])
        tag('intent_start', tags['intentStart'])
        tag('intent_end', tags['intentEnd'])
        for k, v in tags['facets'].items():
            tag_rows.append([id, tv, f'facet:{k}', v, 1, 'rule', '[]', None])
        tag_rows.append([id, tv, 'summary', summary[:500], 1, 'classifier' if ev['judgeMode'] == 'llm' else 'heuristic', '[]', None])
        sql, params = insert_many('call_tag', ['call_id', 'taxonomy_version', 'tag_key', 'value', 'confidence', 'layer', 'evidence', 'run_id'], tag_rows)
        await t.query(sql, params)

        if tags['events']:
            sql, params = insert_many('call_event', ['call_id', 'type', 'turn', 'detail', 'source'], [[id, e['type'], e['turn'], e.get('detail'), e['source']] for e in tags['events']])
            await t.query(sql, params)

        sql, params = insert_many('metric_result', ['call_id', 'framework_version', 'metric_key', 'raw', 'value', 'applicable', 'method', 'evidence', 'rationale', 'run_id'],
                                  [[id, fv, m['key'], m['raw'], m['value'], m['applicable'], m['method'], json_(m['evidence']), m.get('rationale'), m.get('runId')] for m in ev['metrics']])
        await t.query(sql, params)

        def d(k: str):
            x = ev['dims'].get(k)
            return x['v'] if x is not None else None

        await t.query(
            """insert into call_score (call_id, framework_version, und, body, concl, tools, emo, intro, voice, dims, cqs, raw_cqs, band, gated, gates, path, outcome, fields, context, phases, lowest, coaching, tool_stats)
               values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb,$21::jsonb,$22::jsonb,$23::jsonb)""",
            [id, fv, d('und'), d('body'), d('concl'), d('tools'), d('emo'), d('intro'), d('voice'), json_(ev['dims']), ev['cqs'], ev['rawCqs'], ev['band'], gated,
             json_([g for g in ev['gates'] if g['failed']]), json_(ev['path']), json_(ev['outcome']), json_(ev['fields']), json_(ev['context']), json_(ev['phases']),
             json_(ev['lowest']), json_(ev['coaching']), json_(ev['toolStats'])],
        )

        if spans:
            sql, params = insert_many('trace_span', ['id', 'call_id', 'turn', 'kind', 'name', 'start_s', 'duration_s', 'model', 'tokens_in', 'tokens_out', 'status', 'meta'],
                                      [[s['id'], id, s['turn'], s['kind'], s['name'], s['startS'], s['durationS'], s.get('model'), s.get('tokensIn'), s.get('tokensOut'), s['status'],
                                        json_(s.get('meta'))] for s in spans])
            await t.query(sql, params)
        if runs:
            sql, params = insert_many('eval_run', ['id', 'call_id', 'kind', 'version', 'model', 'input_tokens', 'output_tokens', 'latency_ms', 'status', 'error', 'output', 'cited_turns'],
                                      [[r['id'], id, f"{r['kind']}_heuristic" if r['mode'] == 'heuristic' else r['kind'], tv if r['kind'] == 'classifier' else f'rubrics-{fv}', r.get('model'),
                                        r['inputTokens'], r['outputTokens'], r['latencyMs'], r['status'], r.get('error'), json_(r.get('output')), '[]'] for r in runs])
            await t.query(sql + ' on conflict (id) do nothing', params)
        for r in ev['review']:
            key = r.get('tagKey')
            tag_val = tags['persona'] if key == 'persona' else tags['scenarioPrimary'] if key == 'scenario_primary' else tags['intentEnd'] if key == 'intent_end' else None
            current = tag_val['value'] if tag_val is not None and tag_val['value'] is not None else (','.join(g['id'] for g in ev['gates'] if g['failed']) if r['kind'] == 'gate' else None)
            await t.query(
                'insert into review_item (id, call_id, kind, tag_key, reason, current_value, confidence) values ($1,$2,$3,$4,$5,$6,$7)',
                [new_id('rev'), id, r['kind'], key, r['reason'], current, tag_val['confidence'] if tag_val is not None else None],
            )
        await t.query(
            """update calls set status = 'scored', error = null, persona = $2, persona_path = $3, scenario = $4, scenario2 = $5, intent_start = $6, intent_end = $7,
                 cqs = $8, raw_cqs = $9, band = $10, gated = $11, next_step = $12, qualified = $13, judge_mode = $14, needs_review = $15,
                 language = coalesce(language, $16), scored_at = now(), updated_at = now()
               where call_id = $1""",
            [id, tags['persona']['value'], None if p['path'] == '—' else p['path'], tags['scenarioPrimary']['value'], tags['scenarioSecondary']['value'],
             tags['intentStart']['value'], tags['intentEnd']['value'], ev['cqs'], ev['rawCqs'], ev['band'], gated, ev['outcome']['nextStep'], ev['outcome']['qualified'],
             ev['judgeMode'], any(r['kind'] != 'sample' for r in ev['review']), tags['facets'].get('language')],
        )

    await db.tx(write)
