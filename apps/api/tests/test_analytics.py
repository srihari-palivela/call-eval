# Pure helpers of the analytics, alerts and recommendations modules, and the Claude code paths with a
# stand-in client (tests never call Claude). Database behaviour is covered by the API tests.

import json
from types import SimpleNamespace

import anthropic
import httpx2

from calleval.analytics import clusters, filters
from calleval.analytics.calls import _fmt_dur, note_of
from calleval.recommendations import engine


def test_parse_slice_defaults_and_clamps():
    assert filters.parse_slice({}) == {'range': 30, 'dir': 'all', 'path': 'all', 'ver': 'live', 'agent': 'all'}
    assert filters.parse_slice({'range': 'abc', 'dir': 'sideways'})['range'] == 30
    assert filters.parse_slice({'range': '0'})['range'] == 30  # Number('0') || 30
    assert filters.parse_slice({'range': '99999'})['range'] == 3650
    assert filters.parse_slice({'range': '7', 'dir': 'in', 'path': 'Broker', 'ver': 'v3', 'agent': 'ag_1'}) == {'range': 7, 'dir': 'in', 'path': 'Broker', 'ver': 'v3', 'agent': 'ag_1'}
    assert filters.parse_slice({'range': 7})['range'] == 30  # only strings count, as query values are strings


def test_version_pairs_sql_numbers_parameters_in_order():
    params = []

    def p(v):
        params.append(v)
        return f'${len(params) + 1}'

    assert filters.version_pairs_sql([], p) == 'false'
    sql = filters.version_pairs_sql([{'agentId': 'ag_a', 'label': 'v3'}, {'agentId': None, 'label': 'v1'}], p)
    assert sql == '((c.agent_id = $2 and c.prompt_version = $3) or (c.agent_id is null and c.prompt_version = $4))'
    assert params == ['ag_a', 'v3', 'v1']


def test_call_notes_follow_status_and_band():
    assert note_of({'status': 'failed', 'error': 'x' * 100})['note'] == 'Pipeline error: ' + 'x' * 80
    assert note_of({'status': 'evaluating'}) == {'note': 'In the pipeline', 'tone': 'ink'}
    assert note_of({'status': 'scored', 'gated': True})['tone'] == 'accent'
    assert note_of({'status': 'scored', 'band': 'Excellent'})['note'] == 'Reference call'
    assert note_of({'status': 'scored', 'band': 'Fail', 'cqs': 40})['note'] == 'Review every call; every gated call lands here.'
    assert note_of({'status': 'scored', 'band': 'Good'}) == {'note': None, 'tone': 'ink'}
    assert _fmt_dur(125.4) == '2:05'


def test_scope_labels():
    assert engine._scope_label('global', None) == 'all calls'
    assert engine._scope_label('persona', 'P3') == 'P3 Yield investor'
    assert engine._scope_label('cell', 'P7|S7') == 'P7 Overseas broker × S7 Broker onboarding'


def test_phrase_clusters_need_five_calls_per_theme():
    def cand(i, text):
        return {'call_id': f'c{i}', 'persona': 'P11', 'scenario': 'S11', 'summary': '', 'canonical': {'turns': [{'speaker': 'caller', 'text': text}]}}

    cands = [cand(i, 'Would buying get me a golden visa?') for i in range(6)] + [cand(10 + i, 'Can I get a mortgage pre-approval?') for i in range(4)]
    out = clusters.phrase_clusters(cands)
    assert [c['label'] for c in out] == ['Golden visa eligibility through a purchase']
    assert len(out[0]['ids']) == 6


# ---------- Claude paths with a stand-in client ----------

def _message(payload, stop='end_turn'):
    return SimpleNamespace(stop_reason=stop, content=[SimpleNamespace(type='text', text=json.dumps(payload))])


class _Stream:
    def __init__(self, msg):
        self.msg = msg

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get_final_message(self):
        return self.msg


def _fake_client(monkeypatch, module, msg, reject_fallbacks=False):
    sent = []

    def check(kw):
        sent.append(kw)
        if reject_fallbacks and 'fallbacks' in kw:
            raise anthropic.BadRequestError('fallbacks: not supported here', response=httpx2.Response(400, request=httpx2.Request('POST', 'https://api.anthropic.com')), body=None)

    class Messages:
        def stream(self, **kw):
            check(kw)
            return _Stream(msg)

        async def create(self, **kw):
            check(kw)
            return msg

    monkeypatch.setattr(module.anthropic, 'AsyncAnthropic', lambda **_: SimpleNamespace(beta=SimpleNamespace(messages=Messages())))
    return sent


FINDING = {'title': 'Ground every project fact in the tool', 'kind': 'tool', 'scope': 'global', 'scopeKey': None, 'problem': 'Grounding averages 61.',
           'proposal': 'Add a grounding rule.', 'promptPatch': None, 'metrics': ['gr', 'G1'], 'evidence': [{'callId': 'c1', 'turn': 4, 'quote': 'From 1.4 million'}]}


async def test_tailor_writes_add_and_replace_patches(monkeypatch):
    base = {'title': 'Ground facts', 'problem': 'p', 'proposal': 'Do it.', 'patch_section': 'Facts', 'patch_before': '', 'patch_after': 'Only state tool facts.', 'expected_effect': 'gr rises'}
    sent = _fake_client(monkeypatch, engine, _message({**base, 'patch_mode': 'add'}))
    out = await engine._tailor(FINDING, 'You are Sara.')
    assert out['promptPatch'] == 'Add to “Facts”:\nOnly state tool facts.'
    assert out['proposal'] == 'Do it.\n\nExpected effect: gr rises'
    assert sent[0]['fallbacks'] == 'default' and sent[0]['betas'] == ['server-side-fallback-2026-07-01']
    assert sent[0]['output_config']['format']['type'] == 'json_schema'
    _fake_client(monkeypatch, engine, _message({**base, 'patch_mode': 'replace', 'patch_before': 'Old rule.'}))
    assert (await engine._tailor(FINDING, None))['promptPatch'] == 'Replace in “Facts”:\nOld rule.\n\nWith:\nOnly state tool facts.'
    _fake_client(monkeypatch, engine, _message({**base, 'patch_mode': 'none'}))
    assert (await engine._tailor(FINDING, None))['promptPatch'] is None
    _fake_client(monkeypatch, engine, _message({**base, 'patch_mode': 'add'}, stop='refusal'))
    assert await engine._tailor(FINDING, None) is None


async def test_tailor_retries_without_fallbacks_when_rejected(monkeypatch):
    msg = _message({'title': 't', 'problem': 'p', 'proposal': 'x', 'patch_mode': 'none', 'patch_section': '', 'patch_before': '', 'patch_after': '', 'expected_effect': 'e'})
    sent = _fake_client(monkeypatch, engine, msg, reject_fallbacks=True)
    assert (await engine._tailor(FINDING, None))['title'] == 't'
    assert 'fallbacks' in sent[0] and 'fallbacks' not in sent[1]


async def test_llm_clusters_map_member_indexes(monkeypatch):
    cands = [{'call_id': f'c{i}', 'persona': None, 'scenario': None, 'summary': 's'} for i in range(6)]
    _fake_client(monkeypatch, clusters, _message({'clusters': [{'label': 'Visa', 'members': [0, 2, 99, -1], 'nearest_tag': 'S11'}]}))
    out = await clusters._llm_clusters(cands)
    assert out == [{'label': 'Visa', 'ids': ['c0', 'c2'], 'nearest': 'S11'}]
