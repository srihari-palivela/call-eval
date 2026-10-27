import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import anthropic
import httpx
import pytest

from calleval.connectors.demo import generate_call
from calleval.connectors.elevenlabs import normalise_elevenlabs
from calleval.connectors.retell import normalise_retell
from calleval.framework import GATE_CAP
from calleval.lib.settings import DEFAULT_SETTINGS
from calleval.pipeline.evaluate import evaluate_call
from calleval.pipeline.judge import llm
from calleval.pipeline.judge.heuristic import heuristic
from .fixtures import eleven_labs_conversation, retell_call


async def run(call):
    return (await evaluate_call(call, call_id='test', judge=heuristic, settings=DEFAULT_SETTINGS))['evaluation']


async def test_scores_a_clean_elevenlabs_investor_call_end_to_end():
    ev = await run(normalise_elevenlabs(eleven_labs_conversation()))
    assert ev['judgeMode'] == 'heuristic'
    assert 0 < ev['cqs'] <= 100
    assert [g for g in ev['gates'] if g['failed']] == []
    assert ev['outcome']['nextStep'] == 'document'
    assert ev['tags']['persona']['value'].startswith('P')
    # Every metric is either scored 0–100 or explicitly not applicable; nothing defaults to 100.
    for m in ev['metrics']:
        if m['applicable']:
            assert m['value'] is None or 0 <= m['value'] <= 100
        else:
            assert m['value'] is None
    docs = next(t for t in ev['toolStats'] if t['name'] == 'send_documents')
    assert docs['made'] == 1


async def test_fails_g8_and_caps_the_score_when_a_send_is_claimed_without_the_tool():
    raw = eleven_labs_conversation('conv_claim')
    raw['transcript'] = [t for t in raw['transcript']
                         if not any(c['tool_name'] == 'send_documents' for c in t.get('tool_calls') or [])
                         and not any(r['tool_name'] == 'send_documents' for r in t.get('tool_results') or [])]
    raw['transcript'].append({'role': 'agent', 'message': "Done — it's on your WhatsApp now.", 'time_in_call_secs': 40})
    ev = await run(normalise_elevenlabs(raw))
    g8 = next(g for g in ev['gates'] if g['id'] == 'G8')
    assert g8['failed'] is True
    assert ev['cqs'] <= GATE_CAP


async def test_recognises_a_transfer_as_the_next_step_on_a_retell_call():
    ev = await run(normalise_retell(retell_call()))
    assert ev['outcome']['nextStep'] == 'transfer'
    assert ev['context']['direction'] == 'inbound'


async def test_tags_synthetic_calls_with_the_persona_and_scenario_they_were_generated_for():
    persona = scenario = 0
    n = 120
    now = datetime.now(UTC)
    for i in range(n):
        call = generate_call(1000 + i, at=now - timedelta(hours=i), version='v3')
        ev = (await evaluate_call(call, call_id=f't{i}', judge=heuristic, settings=DEFAULT_SETTINGS))['evaluation']
        if ev['tags']['persona']['value'] == call['dynamicVariables']['demo_persona']:
            persona += 1
        if ev['tags']['scenarioPrimary']['value'] == call['dynamicVariables']['demo_scenario']:
            scenario += 1
        if any(g['failed'] for g in ev['gates']):
            assert ev['cqs'] <= GATE_CAP
    assert persona / n > 0.75
    # The generator deliberately includes ambiguous calls (two needs, early hang-ups), so scenario agreement is lower.
    assert scenario / n > 0.6


async def test_human_overrides_replace_tags_and_gates():
    call = normalise_elevenlabs(eleven_labs_conversation())
    ev = (await evaluate_call(call, call_id='h', judge=heuristic, settings=DEFAULT_SETTINGS,
                              human={'tags': {'persona': 'P3'}, 'gates': {'G2': True}, 'answerKey': {'budget': '1.5m AED'}}))['evaluation']
    assert ev['tags']['persona'] == {'value': 'P3', 'confidence': 1, 'layer': 'human', 'evidence': ev['tags']['persona']['evidence']}
    g2 = next(g for g in ev['gates'] if g['id'] == 'G2')
    assert g2['failed'] and g2['source'] == 'human'
    assert ev['cqs'] <= GATE_CAP
    fca = next(m for m in ev['metrics'] if m['key'] == 'fca')
    assert fca['applicable'] and fca['raw'] == 100


# ---------- Claude judge, with a fake client ----------

class FakeStream:
    def __init__(self, message):
        self.message = message

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get_final_message(self):
        if isinstance(self.message, Exception):
            raise self.message
        return self.message


class FakeClient:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []
        self.beta = SimpleNamespace(messages=SimpleNamespace(stream=self.stream))

    def stream(self, **params):
        self.requests.append(params)
        return FakeStream(self.responses.pop(0))


def message(payload, stop_reason='end_turn'):
    usage = SimpleNamespace(input_tokens=100, output_tokens=20, cache_read_input_tokens=900, cache_creation_input_tokens=0)
    return SimpleNamespace(stop_reason=stop_reason, stop_details=None, model='claude-opus-5-5', usage=usage,
                           content=[SimpleNamespace(type='text', text=json.dumps(payload))])


def classifier_payload(call):
    tag = lambda v, c=0.9: {'value': v, 'confidence': c, 'evidence_turns': [1, 99]}  # noqa: E731
    return {
        'persona': tag('P3'), 'persona_resolved_turn': 3, 'scenario_primary': tag('S3'), 'scenario_secondary': tag('none'),
        'intent_start': tag('warm'), 'intent_end': tag('hot', 0.5), 'events': [{'type': 'visit_requested', 'turn': 5}, {'type': 'not_an_event', 'turn': 1}],
        'fields': {k: ('1.5m AED' if k == 'budget' else '') for k in llm.FIELD_KEYS}, 'budget_aed': 1_500_000, 'timeline_months': -1,
        'language': 'en', 'summary': 'An investor asked for a brochure.', 'body_segments': [{'turn': 4, 'segment': 'Pitch'}, {'turn': 400, 'segment': 'Pitch'}],
    }


def judge_payload():
    from calleval.pipeline.judge.types import JUDGED_GATES, JUDGED_METRICS
    return {
        'metrics': {m['key']: {'applicable': m['key'] != 'tof', 'raw': 1, 'evidence_turns': [2], 'rationale': 'ok'} for m in JUDGED_METRICS},
        'gates': {g: {'failed': g == 'G2', 'turn': 7 if g == 'G2' else -1, 'detail': 'Promised a discount.' if g == 'G2' else ''} for g in JUDGED_GATES},
        'checkpoints': [{'id': 'send', 'hit': True, 'turn': 5}],
        'coaching': [{'turn': 7, 'issue': 'Promised a discount', 'better_response': 'Say an advisor can explain the payment plans.'}],
    }


@pytest.fixture
def fake_claude(monkeypatch):
    def install(responses):
        client = FakeClient(responses)
        monkeypatch.setattr(llm, '_client', client)
        monkeypatch.setattr(llm, '_fallbacks_supported', None)
        return client
    return install


async def test_claude_judge_maps_structured_outputs_and_caches_the_prompt(fake_claude):
    call = normalise_elevenlabs(eleven_labs_conversation())
    client = fake_claude([message(classifier_payload(call)), message(judge_payload())])
    res = await evaluate_call(call, call_id='c1', judge=llm.claude, settings=DEFAULT_SETTINGS)
    ev = res['evaluation']
    assert ev['judgeMode'] == 'llm'
    assert ev['tags']['persona']['value'] == 'P3' and ev['tags']['persona']['layer'] == 'classifier'
    assert ev['tags']['persona']['evidence'] == [1]  # turn 99 does not exist
    assert ev['tags']['scenarioSecondary']['value'] is None
    assert ev['fields']['budget'] == '1.5m AED'
    assert next(g for g in ev['gates'] if g['id'] == 'G2')['source'] == 'judge'
    assert ev['coaching'][0]['suggestion'].startswith('Say an advisor')
    assert [r['mode'] for r in res['runs']] == ['llm', 'llm'] and res['runs'][0]['inputTokens'] == 1000
    req = client.requests[0]
    assert req['system'][0]['cache_control'] == {'type': 'ephemeral'}
    assert req['messages'][0]['content'][0]['cache_control'] == {'type': 'ephemeral'}
    assert req['output_config']['format']['type'] == 'json_schema'
    assert req['fallbacks'] == 'default' and req['betas'] == ['server-side-fallback-2026-07-01']


async def test_a_refusal_falls_back_to_the_heuristic_and_records_why(fake_claude):
    call = normalise_elevenlabs(eleven_labs_conversation())
    fake_claude([message({}, 'refusal'), message(judge_payload())])
    res = await evaluate_call(call, call_id='c2', judge=llm.claude, settings=DEFAULT_SETTINGS)
    failed, used = res['runs'][0], res['runs'][1]
    assert failed['status'] == 'error' and 'declined' in failed['error']
    assert used['mode'] == 'heuristic' and used['error'].startswith('LLM classifier failed, heuristic used')
    assert res['evaluation']['judgeMode'] == 'llm'


async def test_retries_without_fallbacks_when_the_deployment_rejects_them(fake_claude):
    call = normalise_elevenlabs(eleven_labs_conversation())
    req = httpx.Request('POST', 'https://api.anthropic.com/v1/messages')
    bad = anthropic.BadRequestError('fallbacks: unknown parameter', response=httpx.Response(400, request=req), body=None)
    client = fake_claude([bad, message(classifier_payload(call)), message(judge_payload())])
    res = await evaluate_call(call, call_id='c3', judge=llm.claude, settings=DEFAULT_SETTINGS)
    assert res['evaluation']['tags']['persona']['layer'] == 'classifier'
    assert 'fallbacks' in client.requests[0] and 'fallbacks' not in client.requests[1] and 'fallbacks' not in client.requests[2]
