# The self-improvement loop: edits are applied and composed safely, probes compare matched simulated callers,
# cycles move through approval and live verification, promotions reach the provider, and every decision
# leaves a lesson. Claude is a fake client; findings come from a stub where noted.

import json
from types import SimpleNamespace

import anthropic
import httpx
import pytest

from calleval.connectors.registry import save_integration
from calleval.improve import loop, simulate
from calleval.js import js_json
from calleval.lib import claude
from calleval.lib.errors import HttpStatusError
from calleval.lib.settings import update_settings
from calleval.pipeline.judge import llm as judge_llm

from .fixtures import stub_http

PROMPT = 'You are Sara, a sales agent.\n\n# Discovery\nAsk about budget and bedrooms.\n\n# Closing\nOffer a viewing.'


# ---------- Pure parts ----------

def test_apply_edit_adds_replaces_and_refuses_an_unmatched_replace():
    p, why = loop.apply_edit(PROMPT, {'mode': 'add', 'section': 'Discovery', 'after': 'Ask one question per turn.'})
    assert why is None and 'Ask about budget and bedrooms.\nAsk one question per turn.\n\n# Closing' in p
    p, why = loop.apply_edit(PROMPT, {'mode': 'add', 'section': '', 'after': 'Never list three projects.'})
    assert p.endswith('Never list three projects.\n')
    p, why = loop.apply_edit(PROMPT, {'mode': 'replace', 'before': 'Offer a viewing.', 'after': 'Offer a viewing in person or online.'})
    assert 'in person or online' in p and why is None
    p2, why = loop.apply_edit(PROMPT, {'mode': 'replace', 'before': 'Not in the prompt', 'after': 'x'})
    assert p2 == PROMPT and why
    out = loop.compose(PROMPT, [{'id': 'a', 'mode': 'add', 'section': '', 'after': 'One.'}, {'id': 'b', 'mode': 'replace', 'before': 'nope', 'after': 'Two.'}])
    assert out['applied'] == ['a'] and out['skipped'][0]['id'] == 'b'


def test_compliance_edits_are_flagged():
    assert loop.touches_compliance({'targets': ['G4'], 'after': 'Be friendly.'})
    assert loop.touches_compliance({'targets': ['qd'], 'after': 'If asked whether you are an AI, say yes.'})
    assert loop.touches_compliance({'targets': ['oh'], 'after': 'Offer a discount when price is raised.'})
    assert not loop.touches_compliance({'targets': ['qd'], 'after': 'Ask one question per turn.'})


def test_compare_uses_matched_pairs_and_counts_added_gate_failures():
    champ = [{'cqs': 60, 'metrics': {'qd': 50}, 'gates': []}, {'cqs': 70, 'metrics': {'qd': 0}, 'gates': []}, None]
    better = [{'cqs': 66, 'metrics': {'qd': 100}, 'gates': []}, {'cqs': 72, 'metrics': {'qd': 50}, 'gates': []}, {'cqs': 90, 'metrics': {}, 'gates': []}]
    s = loop.compare(champ, better, ['qd'])
    assert s == {'n': 2, 'meanTargetDelta': 50.0, 'meanCqsDelta': 4.0, 'gatesAdded': 0, 'wins': 2, 'losses': 0}
    assert loop.is_win(s)
    gated = [{'cqs': 66, 'metrics': {'qd': 100}, 'gates': ['G1']}, better[1], None]
    assert not loop.is_win(loop.compare(champ, gated, ['qd']))
    assert not loop.is_win(loop.compare(champ, [None, None, None], ['qd']))


def test_playbook_candidates_without_claude():
    ref = {'findings': [
        {'metrics': ['qd'], 'scope': 'global', 'scopeKey': None, 'problem': 'Two questions per turn.'},
        {'metrics': ['qd'], 'scope': 'cell', 'scopeKey': 'P1|S1', 'problem': 'dup'},
        {'metrics': ['tof'], 'scope': 'cell', 'scopeKey': 'P1|S1', 'problem': 'Lists three projects.'},
        {'metrics': ['rl'], 'scope': 'global', 'scopeKey': None, 'problem': 'Slow.'},  # no prompt rule in the playbook
    ]}
    c = loop.playbook_candidates(ref, 2, 2)
    assert [(x['kind'], x['targets']) for x in c] == [('general', ['qd']), ('domain', ['tof'])]
    assert all(x['mode'] == 'add' and x['after'] for x in c)


# ---------- Fake Claude ----------

class FakeMsg(SimpleNamespace):
    pass


def fake_client(handler):
    class Stream:
        def __init__(self, req):
            self.req = req

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get_final_message(self):
            out = handler(self.req)
            if isinstance(out, Exception):
                raise out
            return FakeMsg(stop_reason='end_turn', content=[SimpleNamespace(type='text', text=json.dumps(out))], model='fake',
                           usage=SimpleNamespace(input_tokens=100, output_tokens=20, cache_read_input_tokens=0, cache_creation_input_tokens=0))

    calls = []

    def stream(**req):
        calls.append(req)
        return Stream(req)

    return SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(stream=stream)), calls=calls)


def schema_of(req):
    return set(req['output_config']['format']['schema']['properties'])


async def test_simulate_builds_a_scoreable_call_with_tools_from_the_real_call(monkeypatch):
    turns = iter([
        {'say': 'Hi, this is Sara. Is now a good time?', 'tool_calls': [], 'end_call': False},
        {'say': 'Let me check what fits.', 'tool_calls': [{'name': 'get_project_details', 'args_json': '{"bedrooms": 2}'}], 'end_call': False},
        {'say': 'Island Park has two-bedrooms from 1.6 million dirhams.', 'tool_calls': [], 'end_call': False},
        {'say': 'Thanks for your time, goodbye.', 'tool_calls': [], 'end_call': True},
    ])
    callers = iter([{'say': 'Yes, go ahead.', 'end_call': False}, {'say': 'Two bedrooms please.', 'end_call': False}])

    def handler(req):
        return next(turns) if 'tool_calls' in schema_of(req) else next(callers)

    fc = fake_client(handler)
    monkeypatch.setattr(judge_llm, '_client', fc)
    task = simulate.task_from_call('dm_1', {'turns': [{'speaker': 'caller', 'text': 'I want two bedrooms in Dubai Islands.'}],
                                            'toolCalls': [{'name': 'get_project_details', 'resultText': '{"projects":[{"name":"Island Park","from_aed":1600000}]}'}],
                                            'dynamicVariables': {'customer_name': 'Omar', 'lead_id': 'ld_1'}, 'direction': 'outbound'}, 'P1', 'S1')
    assert 'two bedrooms in Dubai Islands' in task['brief'] and task['dynamicVariables'] == {'customer_name': 'Omar', 'lead_id': 'ld_1'}
    b = simulate.Budget(10_000_000)
    call = await simulate.simulate(task, PROMPT, budget=b)
    assert [t['speaker'] for t in call['turns']] == ['agent', 'caller', 'agent', 'agent', 'caller', 'agent']
    assert call['toolCalls'][0]['name'] == 'get_project_details' and 'Island Park' in call['toolCalls'][0]['resultText']
    assert call['turns'][call['toolCalls'][0]['turnIdx']]['text'] == 'Let me check what fits.'
    assert call['endReason'] == 'natural_close' and b.llm_calls == 6 and b.input_tokens == 600
    assert all('SIMULATION' in r['system'][0]['text'].upper() or r['system'][0]['text'] == task['brief'] for r in fc.calls)
    assert fc.calls[0]['fallbacks'] == 'default' and fc.calls[0]['betas'] == ['server-side-fallback-2026-07-01']


async def test_simulated_calls_are_scored_by_the_real_pipeline(monkeypatch):
    from calleval.lib.settings import DEFAULT_SETTINGS

    def handler(req):
        if 'tool_calls' in schema_of(req):
            asked = 'one question per turn' in req['system'][0]['text']
            say = 'Is it for you or for family?' if asked else 'Is it for you or for family? And what budget do you have?'
            return {'say': f"Hi Omar, this is Sara. {say}", 'tool_calls': [], 'end_call': False}
        return {'say': 'For my family, around two million.', 'end_call': len(req['messages'][0]['content']) > 400}

    monkeypatch.setattr(judge_llm, '_client', fake_client(handler))
    task = simulate.task_from_call('dm_2', {'turns': [{'speaker': 'caller', 'text': 'For my family.'}], 'toolCalls': [], 'dynamicVariables': {}}, 'P1', 'S1')
    b = simulate.Budget(10_000_000)
    runs = await loop.run_prompt([task], PROMPT, DEFAULT_SETTINGS, b, 'simt')
    assert runs[0] is not None and 0 <= runs[0]['cqs'] <= 100 and runs[0]['metrics'] and runs[0]['turns'] >= 3
    stopped = await loop.run_prompt([task], PROMPT, DEFAULT_SETTINGS, simulate.Budget(0), 'simt')
    assert stopped == [None]  # an exhausted budget runs nothing


async def test_claude_requests_retry_without_fallbacks_where_they_are_rejected(monkeypatch):
    def handler(req):
        if 'fallbacks' in req:
            return anthropic.BadRequestError('fallbacks: unknown parameter', response=httpx.Response(400, request=httpx.Request('POST', 'https://x')), body=None)
        return {'say': 'ok', 'end_call': True}

    monkeypatch.setattr(judge_llm, '_client', fake_client(handler))
    monkeypatch.setattr(claude, '_fallbacks', None)
    out = await simulate.claude_json('sys', 'user', simulate.CALLER_SCHEMA, budget=simulate.Budget(1000))
    assert out == {'say': 'ok', 'end_call': True} and claude._fallbacks is False


# ---------- Cycles on the database ----------

st: dict = {}


async def _call(db, cid, label, cqs, gated=False, arm=None, campaign=None, lead='ld_x', agent=None):
    canonical = {'turns': [{'idx': 0, 'speaker': 'agent', 'text': 'Hi'}, {'idx': 1, 'speaker': 'caller', 'text': 'I want a two-bed near the beach.'}],
                 'toolCalls': [], 'dynamicVariables': {'campaign_id': campaign, 'lead_id': lead}, 'direction': 'outbound'}
    await db.query(
        """insert into calls (call_id, provider, external_id, agent_id, lead_id, started_at, status, canonical, cqs, gated, next_step, prompt_version, persona, scenario, scored_at)
           values ($1, 'elevenlabs', $1, $2, $3, now(), 'scored', $4::jsonb, $5, $6, null, $7, 'P1', 'S1', now())""",
        [cid, agent or st['agent'], lead, js_json(canonical), cqs, gated, label])
    if arm:
        await db.query("insert into campaign_lead (campaign_id, lead_id, batch_id, arm, prompt_version, status, call_id) values ($1,$2,'cb_t',$3,$4,'called',$5)",
                       [campaign, f'{lead}_{cid}', arm, label, cid])


async def _campaign(db, mode='propose'):
    from calleval.campaigns import engine
    c = await engine.create_campaign(db, {'name': f'C {mode}', 'integrationId': st['el'], 'improvement': mode, 'minCallsPerArm': 10, 'maxCallsPerArm': 40})
    await db.query("update campaign set status = 'running', champion = $2::jsonb where id = $1", [c['id'], js_json({'label': 'v1', 'prompt': PROMPT, 'source': 'agent'})])
    return c['id']


@pytest.fixture(scope='module')
async def base(db):
    await update_settings(db, {'features': {'crm': True, 'campaigns': True, 'improvement': 'auto'}})
    el = await save_integration(db, None, {'provider': 'elevenlabs', 'apiKey': 'xi_key', 'agentIds': ['agent_el_1']})
    st['el'] = el['id']
    from calleval.campaigns.engine import agent_row_id
    st['agent'] = agent_row_id('elevenlabs', 'agent_el_1')
    return st


FINDINGS = {'findings': [
    {'fingerprint': 'f1', 'title': 'One question per turn', 'problem': 'Two questions per turn on 40% of calls.', 'kind': 'prompt', 'scope': 'global', 'scopeKey': None,
     'metrics': ['qd'], 'promptPatch': None, 'priority': 50, 'evidence': [{'callId': 'x', 'turn': 1, 'quote': 'Budget? And bedrooms?'}]},
    {'fingerprint': 'f2', 'title': 'Two-option fork', 'problem': 'Lists three projects.', 'kind': 'prompt', 'scope': 'cell', 'scopeKey': 'P1|S1',
     'metrics': ['tof'], 'promptPatch': None, 'priority': 40, 'evidence': []},
], 'version': 'v1', 'calls': 20}


async def test_propose_only_cycle_without_claude_waits_for_a_person(db, base, monkeypatch):
    async def findings(*a, **k):
        return json.loads(json.dumps(FINDINGS))
    monkeypatch.setattr(loop, 'collect_findings', findings)
    monkeypatch.setattr(loop, 'llm_enabled', lambda: False)
    cid = await _campaign(db, 'auto')
    r = await loop.run_cycle(db, cid)
    assert r['status'] == 'awaiting_approval' and r['probed'] is False
    d = await loop.cycle_detail(db, r['cycleId'])
    assert d['composed']['unprobed'] is True and d['challengerLabel'] == 'v1.c1'
    assert 'Ask exactly one question per turn' in d['composed']['prompt']
    # A second cycle can't start while this one is open.
    assert (await loop.run_cycle(db, cid))['skipped'].startswith('a cycle is already active')
    live = await loop.approve(db, r['cycleId'], 'reviewer')
    assert live['status'] == 'live' and live['decidedBy'] == 'reviewer'
    camp = await db.one('select challenger from campaign where id = $1', [cid])
    assert camp['challenger']['label'] == 'v1.c1' and camp['challenger']['cycleId'] == r['cycleId']
    with pytest.raises(HttpStatusError):
        await loop.approve(db, r['cycleId'])
    st['live_cycle'], st['live_campaign'] = r['cycleId'], cid


async def test_verify_waits_for_enough_calls_then_promotes_a_verified_win(db, base, monkeypatch):
    cyc, cid = st['live_cycle'], st['live_campaign']
    assert (await loop.verify(db, cyc))['decision'] == 'pending'
    for i in range(12):
        await _call(db, f'w_a{i}', 'v1', 60 + i % 5, arm='champion', campaign=cid)
        await _call(db, f'w_b{i}', 'v1.c1', 72 + i % 5, arm='challenger', campaign=cid)
    patched = []
    stub_http(monkeypatch, [(r'/v1/convai/agents/agent_el_1$', lambda u, r: patched.append(json.loads(r['content'])) or {'agent_id': 'agent_el_1'})])
    out = await loop.verify(db, cyc)
    # Auto mode, no compliance wording in the edit: promoted straight away and pushed to ElevenLabs.
    assert out['status'] == 'promoted' and out['decidedBy'] == 'auto'
    assert out['verdict']['decision'] == 'promote' and out['verdict']['lo'] > 0
    assert 'Ask exactly one question per turn' in patched[0]['conversation_config']['agent']['prompt']['prompt']
    camp = await db.one('select champion, challenger from campaign where id = $1', [cid])
    assert camp['challenger'] is None and camp['champion']['label'] == 'v1.c1' and camp['champion']['source'] == 'promoted'
    lessons = await loop.list_lessons(db, st['agent'])
    assert {x['outcome'] for x in lessons if x['cycleId'] == cyc} == {'adopted'}


async def test_a_worse_challenger_is_rolled_back_and_remembered(db, base, monkeypatch):
    async def findings(*a, **k):
        return json.loads(json.dumps(FINDINGS))
    monkeypatch.setattr(loop, 'collect_findings', findings)
    monkeypatch.setattr(loop, 'llm_enabled', lambda: False)
    cid = await _campaign(db, 'propose')
    r = await loop.run_cycle(db, cid)
    await loop.approve(db, r['cycleId'])
    for i in range(12):
        await _call(db, f'r_a{i}', 'v1', 75 + i % 4, arm='champion', campaign=cid)
        await _call(db, f'r_b{i}', 'v1.c1', 55 + i % 4, arm='challenger', campaign=cid)
    out = await loop.verify(db, r['cycleId'])
    assert out['status'] == 'rolled_back'
    assert (await db.one('select challenger from campaign where id = $1', [cid]))['challenger'] is None
    assert {x['outcome'] for x in await loop.list_lessons(db, st['agent']) if x['cycleId'] == r['cycleId']} == {'regressed'}


async def test_propose_mode_waits_for_a_person_to_promote(db, base, monkeypatch):
    async def findings(*a, **k):
        return json.loads(json.dumps(FINDINGS))
    monkeypatch.setattr(loop, 'collect_findings', findings)
    monkeypatch.setattr(loop, 'llm_enabled', lambda: False)
    cid = await _campaign(db, 'propose')
    r = await loop.run_cycle(db, cid)
    await loop.approve(db, r['cycleId'])
    for i in range(12):
        await _call(db, f'p_a{i}', 'v1', 60 + i % 3, arm='champion', campaign=cid)
        await _call(db, f'p_b{i}', 'v1.c1', 70 + i % 3, arm='challenger', campaign=cid)
    out = await loop.verify(db, r['cycleId'])
    assert out['status'] == 'awaiting_promotion'
    stub_http(monkeypatch, [(r'/v1/convai/agents/agent_el_1$', lambda u, req: {'agent_id': 'agent_el_1'})])
    done = await loop.promote(db, r['cycleId'], 'manager')
    assert done['status'] == 'promoted' and done['decidedBy'] == 'manager'


async def test_auto_mode_never_promotes_compliance_wording_on_its_own(db, base, monkeypatch):
    async def findings(*a, **k):
        f = json.loads(json.dumps(FINDINGS))
        f['findings'] = [{**f['findings'][0], 'metrics': ['G3']}]  # the playbook's advice rule (visa, mortgage, yield)
        return f
    monkeypatch.setattr(loop, 'collect_findings', findings)
    monkeypatch.setattr(loop, 'llm_enabled', lambda: False)
    cid = await _campaign(db, 'auto')
    r = await loop.run_cycle(db, cid)
    d = await loop.cycle_detail(db, r['cycleId'])
    assert d['composed']['compliance'] is True
    await loop.approve(db, r['cycleId'])
    for i in range(12):
        await _call(db, f'g_a{i}', 'v1', 60, arm='champion', campaign=cid)
        await _call(db, f'g_b{i}', 'v1.c1', 75, arm='challenger', campaign=cid)
    assert (await loop.verify(db, r['cycleId']))['status'] == 'awaiting_promotion'
    with pytest.raises(HttpStatusError):
        await loop.promote(db, r['cycleId'], 'auto')


async def test_probed_cycle_keeps_only_winning_edits(db, base, monkeypatch):
    """With Claude: two proposals; the probe (stubbed simulations) shows only the first helps."""
    async def findings(*a, **k):
        return json.loads(json.dumps(FINDINGS))
    monkeypatch.setattr(loop, 'collect_findings', findings)
    monkeypatch.setattr(loop, 'llm_enabled', lambda: True)
    proposals = {'candidates': [
        {'kind': 'general', 'targets': ['qd'], 'mode': 'add', 'section': 'Discovery', 'before': '', 'after': 'Ask one question per turn.', 'rationale': 'f1'},
        {'kind': 'domain', 'targets': ['tof', 'nope'], 'mode': 'add', 'section': 'Closing', 'before': '', 'after': 'Offer two projects with a contrast.', 'rationale': 'f2'},
    ]}
    fc = fake_client(lambda req: proposals)
    monkeypatch.setattr(judge_llm, '_client', fc)

    async def run_prompt(tasks, prompt, settings, budget, label):
        budget.llm_calls += len(tasks)
        good = 'one question per turn' in prompt
        return [{'task': t['callId'], 'cqs': 70 + (6 if good else 0), 'metrics': {'qd': 100 if good else 50, 'tof': 50}, 'gates': [], 'turns': 8} for t in tasks]

    monkeypatch.setattr(loop, 'run_prompt', run_prompt)
    cid = await _campaign(db, 'propose')
    for i in range(12):
        await _call(db, f'q_a{i}', 'v1', 60, arm='champion', campaign=cid)
    r = await loop.run_cycle(db, cid)
    assert r['status'] == 'awaiting_approval'
    d = await loop.cycle_detail(db, r['cycleId'])
    by_id = {c['id']: c for c in d['candidates']}
    assert by_id['cand_1']['probe']['meanTargetDelta'] == 50 and by_id['cand_2']['probe']['wins'] == 0
    assert by_id['cand_2']['targets'] == ['tof']
    assert d['composed']['applied'] == ['cand_1'] and d['composed']['probe']['meanCqsDelta'] == 6
    assert d['cost']['llmCalls'] >= 1
    rejected = [x for x in d['lessons'] if x['outcome'] == 'rejected']
    assert len(rejected) == 1 and 'two projects' in rejected[0]['edit']
    # The proposal request carried the champion prompt, the findings and the structured-output schema.
    req = fc.calls[0]
    assert 'Ask about budget and bedrooms.' in req['messages'][0]['content'] and 'Two questions per turn' in req['messages'][0]['content']
    assert req['output_config']['format']['type'] == 'json_schema'
