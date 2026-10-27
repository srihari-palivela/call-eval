# User-defined taxonomies: drafts, validation, activation, and the pipeline and analytics following the active
# version (anchors through basedOn, keywords for the heuristic classifier, checkpoints from the definition).

import httpx
import pytest

from calleval import taxonomy
from calleval.analytics.meta import seed_taxonomy
from calleval.connectors.elevenlabs import normalise_elevenlabs
from calleval.lib.settings import DEFAULT_SETTINGS
from calleval.pipeline.evaluate import evaluate_call
from calleval.pipeline.judge import llm
from calleval.pipeline.judge.heuristic import heuristic
from calleval.pipeline.judge.prompt import system_prompt
from calleval.server import build_app
from calleval.taxonomy import store

from .fixtures import clone, eleven_labs_conversation

pytestmark = pytest.mark.asyncio(loop_scope='session')


@pytest.fixture(scope='module')
async def client(db):
    await seed_taxonomy(db)
    app = build_app(db)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as c:
        yield c
    taxonomy.reset()


def call_with(caller_lines: list[str], tools: list[dict] | None = None, **extra) -> dict:
    """A canonical call: the agent opens, then the caller's lines alternate with short agent replies."""
    c = clone(normalise_elevenlabs(eleven_labs_conversation()))
    turns = [{'idx': 0, 'speaker': 'agent', 'text': 'Hi, this is Sara. Is now a good time?', 'startS': 0, 'endS': 3, 'interrupted': False, 'tags': []}]
    t = 4.0
    for line in caller_lines:
        for speaker, text in (('caller', line), ('agent', 'Thanks, that helps. Could you tell me a bit more?')):
            turns.append({'idx': len(turns), 'speaker': speaker, 'text': text, 'startS': t, 'endS': t + 3, 'interrupted': False, 'tags': []})
            t += 4
    return {**c, 'turns': turns, 'toolCalls': tools or [], 'durationS': int(t), 'providerAnalysis': {}, **extra}


async def test_serves_the_framework_taxonomy_with_its_anchors_and_paths(client):
    d = (await client.get('/api/taxonomy')).json()
    assert d['active']['version'] == '1.0' and d['active']['status'] == 'active' and d['draft'] is None
    assert [p['id'] for p in d['active']['personas']][:3] == ['P1', 'P2', 'P3'] and len(d['active']['personas']) == 11
    s1 = next(s for s in d['active']['scenarios'] if s['id'] == 'S1')
    assert s1['basedOn'] == 'S1' and [c['id'] for c in s1['checkpoints']][-1] == 'booking'
    assert next(e for e in d['active']['events'] if e['id'] == 'tool_failure')['system'] is True
    assert any(c['detect']['by'] == 'judge' for c in d['builtins']['scenarios'][0]['checkpoints'])
    assert {t['id'] for t in d['templates']} == {'real_estate', 'b2b_sales'} and 'send_documents' in d['tools']
    assert d['copilot'] is False and d['active']['domain'].startswith('a Dubai real-estate developer')


async def test_a_draft_is_a_copy_and_only_one_exists(client):
    d = (await client.post('/api/taxonomy/draft', json={'from': 'active'})).json()
    assert d['draft']['version'] == '1.1' and d['draft']['status'] == 'draft'
    assert d['diff'] == {'added': [], 'changed': [], 'retired': [], 'domainChanged': False}
    again = await client.post('/api/taxonomy/draft', json={'from': 'active'})
    assert again.status_code == 409
    assert (await client.post('/api/taxonomy/draft', json={'from': 'nope', 'replace': True})).status_code == 400


async def test_saving_checks_the_whole_document(client):
    draft = (await client.get('/api/taxonomy')).json()['draft']
    bad = {**draft, 'personas': [*draft['personas'], {'id': '', 'name': 'Yield investor', 'path': 'Buyer'}]}
    r = await client.put('/api/taxonomy/draft', json=bad)
    assert r.status_code == 400
    msg = r.json()['message']
    assert 'path must be Investor, Broker, Non-target' in msg and 'Two personas are called “yield investor”' in msg
    cp_bad = {**draft, 'scenarios': [*draft['scenarios'], {'id': '', 'name': 'Renewal', 'checkpoints': [{'label': 'Checked', 'detect': {'by': 'rule', 'rule': 'magic'}}]}]}
    assert 'rule must be one of' in (await client.put('/api/taxonomy/draft', json=cp_bad)).json()['message']


async def test_new_entries_get_fresh_ids_and_system_events_stay(client):
    draft = (await client.get('/api/taxonomy')).json()['draft']
    doc = {
        'domain': draft['domain'],
        'personas': [*draft['personas'], {'id': '', 'name': 'Holiday-home buyer', 'path': 'Investor', 'signals': 'Wants a second home for holidays',
                                          'keywords': ['holiday home', 'Vacation Home', 'holiday home']}],
        'scenarios': [*draft['scenarios'], {'id': '', 'name': 'Mortgage pre-approval', 'trigger': 'Asks about financing', 'success': 'Referred to the partner bank',
                                            'checkpoints': [{'label': 'Bank partner offered', 'hint': 'Names the partner bank'}]}],
        # Every event left out, including the ones code raises.
        'events': [{'id': '', 'label': 'Asked about golden visa', 'group': 'Caller behaviour', 'keywords': ['golden visa']}],
    }
    doc['scenarios'][-1]['checkpoints'][0]['detect'] = {'by': 'judge'}
    d = (await client.put('/api/taxonomy/draft', json=doc)).json()
    new_p, new_s = d['draft']['personas'][-1], d['draft']['scenarios'][-1]
    assert (new_p['id'], new_p['keywords'], new_p['basedOn']) == ('P12', ['holiday home', 'vacation home'], None)
    assert new_s['id'] == 'S13' and new_s['short'] == 'Mortgage pre-approval' and new_s['path'] == 'Bank partner offered'
    assert new_s['checkpoints'][0]['id'] == 'bank_partner_offered'
    ev = {e['id']: e for e in d['draft']['events']}
    assert 'asked_about_golden_visa' in ev and all(x in ev for x in ('tool_failure', 'dnc_request', 'gate_failure'))
    assert 'objection_budget' not in ev
    added = {(a['kind'], a['id']) for a in d['diff']['added']}
    assert ('persona', 'P12') in added and ('scenario', 'S13') in added
    assert any(r['id'] == 'objection_budget' for r in d['diff']['retired'])


async def test_applies_operations_and_refuses_to_retire_code_events(client):
    r = await client.post('/api/taxonomy/draft/apply', json={'operations': [
        {'op': 'update', 'kind': 'persona', 'id': 'P6', 'entry': {'name': 'Just browsing', 'keywords': ['just looking']}, 'reason': 'Clearer'},
        {'op': 'retire', 'kind': 'persona', 'id': 'P10', 'entry': None, 'reason': 'No renters call'},
        {'op': 'add', 'kind': 'event', 'id': None, 'entry': {'label': 'Objection · maintenance fees', 'group': 'Objections', 'keywords': ['maintenance fees']}, 'reason': 'x'},
    ], 'domain': 'a Dubai developer selling homes. Callers are buyers, brokers and residents.'})
    d = r.json()
    names = {p['id']: p['name'] for p in d['draft']['personas']}
    assert names['P6'] == 'Just browsing' and 'P10' not in names
    assert d['draft']['domain'].startswith('a Dubai developer selling homes')
    bad = await client.post('/api/taxonomy/draft/apply', json={'operations': [{'op': 'retire', 'kind': 'event', 'id': 'tool_failure'}]})
    assert bad.status_code == 400 and 'detected by code' in bad.json()['message']
    unknown = await client.post('/api/taxonomy/draft/apply', json={'operations': [{'op': 'update', 'kind': 'scenario', 'id': 'S99', 'entry': {}}]})
    assert unknown.status_code == 400


async def test_activation_retires_the_old_version_and_the_app_follows(client, db):
    r = (await client.post('/api/taxonomy/draft/activate', json={'notes': 'Holiday homes', 'rescoreDays': 0})).json()
    assert r == {'version': '1.1', 'rescoring': 0}
    d = (await client.get('/api/taxonomy')).json()
    assert d['active']['version'] == '1.1' and d['draft'] is None
    assert [(v['version'], v['status']) for v in d['versions']] == [('1.0', 'retired'), ('1.1', 'active')]
    meta = (await client.get('/api/meta')).json()
    assert meta['taxonomyVersion'] == '1.1' and 'P12' in [p['id'] for p in meta['personas']] and 'P10' not in [p['id'] for p in meta['personas']]
    # A retired persona still has a name for the calls tagged with it.
    assert taxonomy.persona_by_id('P10')['name'] == 'Renter'
    assert taxonomy.current().domain.startswith('a Dubai developer selling homes')
    assert 'a Dubai developer selling homes' in system_prompt() and 'Holiday-home buyer' in system_prompt()
    schema = llm._for_taxonomy()[1]
    assert 'P12' in schema['properties']['persona']['properties']['value']['enum']
    assert 'asked_about_golden_visa' in schema['properties']['events']['items']['properties']['type']['enum']


async def test_the_heuristic_classifier_uses_keywords_and_drops_retired_events(client):
    c = call_with(['We want a holiday home near the beach for winters.', 'Mostly for family holidays.', 'Also, are the maintenance fees high?'])
    ev = (await evaluate_call(c, call_id='kw1', judge=heuristic, settings=DEFAULT_SETTINGS))['evaluation']
    assert ev['tags']['persona']['value'] == 'P12' and ev['taxonomyVersion'] == '1.1'
    types = {e['type'] for e in ev['tags']['events']}
    assert 'objection_maintenance_fees' in types
    # The scenario keyword path: the new scenario's own phrases.
    c2 = call_with(['Do you help with financing?'])
    await client.post('/api/taxonomy/draft', json={'from': 'active'})
    draft = (await client.get('/api/taxonomy')).json()['draft']
    s13 = next(s for s in draft['scenarios'] if s['id'] == 'S13')
    s13['keywords'] = ['financing', 'mortgage']
    await client.put('/api/taxonomy/draft', json=draft)
    await client.post('/api/taxonomy/draft/activate', json={})
    ev2 = (await evaluate_call(c2, call_id='kw2', judge=heuristic, settings=DEFAULT_SETTINGS))['evaluation']
    assert ev2['tags']['scenarioPrimary']['value'] == 'S13'
    # Its judge checkpoint has no phrase pattern, so the heuristic judge leaves path adherence out.
    assert ev2['path'] is None


async def test_a_template_taxonomy_keeps_the_framework_rules_through_anchors(client):
    await client.put('/api/business', json={'goals': {'focusPersonas': ['P1', 'P7'], 'focusScenarios': ['S7']}, 'icp': {'personaHint': 'P8'}})
    d = (await client.post('/api/taxonomy/draft', json={'from': 'b2b_sales'})).json()
    assert d['draft']['version'] == '2.0' and d['draft']['personas'][0]['name'] == 'Decision maker'
    retired = {r['id'] for r in d['diff']['retired'] if r['kind'] == 'persona'}
    assert {'P7', 'P8', 'P9', 'P11', 'P12'} <= retired  # P10 went in 1.1
    await client.post('/api/taxonomy/draft/activate', json={})
    tax = taxonomy.current()
    assert tax.version == '2.0' and tax.persona_for('P11') == 'P6' and tax.scenario_for('S12') == 'S12'
    # The business profile forgets what the new version retired (P1 and S7 exist again in the template).
    biz = (await client.get('/api/business')).json()['profile']
    assert biz['goals']['focusPersonas'] == ['P1'] and biz['goals']['focusScenarios'] == ['S7'] and biz['icp']['personaHint'] is None
    # Failed call: the rule tags the scenario based on S12; the caller said almost nothing.
    failed = call_with(['Hello?'], endReason='voicemail')
    ev = (await evaluate_call(failed, call_id='b2b1', judge=heuristic, settings=DEFAULT_SETTINGS))['evaluation']
    assert ev['tags']['persona']['value'] == 'P0' and ev['tags']['scenarioPrimary']['value'] == 'S12'
    # A reseller is recognised by the partner persona's keywords.
    partner = call_with(['We are a reseller and refer clients to tools like yours.', 'Do you have a partner programme?'])
    ev = (await evaluate_call(partner, call_id='b2b2', judge=heuristic, settings=DEFAULT_SETTINGS))['evaluation']
    assert ev['tags']['persona']['value'] == 'P5' and ev['tags']['persona']['layer'] == 'heuristic'
    # The Other share follows the persona based on P11, not the id P11.
    assert tax.ids_based_on('persona', ('P11',)) == ['P6', 'P11']


async def test_rescoring_queues_recent_calls(client, db):
    await db.query("""insert into calls (call_id, provider, external_id, started_at, status, source) values
                      ('rs1', 'demo', 'rs1', now() - interval '2 days', 'scored', 'demo'),
                      ('rs2', 'demo', 'rs2', now() - interval '40 days', 'scored', 'demo')""")
    assert await store.rescore(db, 7) == 1
    job = await db.one("select payload from job where dedupe_key = 'eval:rs1'")
    assert job['payload'] == {'callId': 'rs1', 'reason': 'taxonomy'}
    assert await store.rescore(db, 7) == 0  # already queued


async def test_discarding_a_draft_leaves_the_active_version(client):
    await client.post('/api/taxonomy/draft', json={'from': 'active'})
    d = (await client.delete('/api/taxonomy/draft')).json()
    assert d['draft'] is None and d['active']['version'] == '2.0'
    assert (await client.post('/api/taxonomy/draft/activate', json={})).status_code == 404
