# End to end over HTTP on a throwaway database: signed webhooks and polling sync bring calls in,
# the job queue evaluates them, CRM outcomes are credited, and every console endpoint answers.

import json
import time
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from calleval.analytics.meta import seed_taxonomy
from calleval.config import config
from calleval.demo.seed import seed_demo
from calleval.server import build_app

from .fixtures import drain, eleven_labs_conversation, eleven_labs_signature, retell_call, retell_signature, stub_http

pytestmark = pytest.mark.asyncio(loop_scope='session')


@pytest.fixture(scope='module')
async def client(db):
    await seed_taxonomy(db)
    app = build_app(db)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as c:
        yield c


state: dict = {}


async def test_creates_an_integration_without_echoing_secrets(client):
    r = await client.post('/api/integrations', json={'provider': 'retell', 'apiKey': 'key_retell_test', 'agentIds': ['agent_rt_1']})
    assert r.status_code == 200
    dto = r.json()
    state['retell'] = dto['id']
    assert dto['provider'] == 'retell' and dto['hasApiKey'] is True and dto['apiKeyHint'] == '…test'
    assert dto['webhookUrl'] == f"https://evals.example.com/webhooks/retell/{dto['id']}"
    assert 'key_retell_test' not in r.text


async def test_rejects_an_unsigned_or_forged_webhook(client):
    body = json.dumps({'event': 'call_analyzed', 'call': retell_call()})
    h = {'content-type': 'application/json'}
    rid = state['retell']
    assert (await client.post(f'/webhooks/retell/{rid}', content=body, headers=h)).status_code == 401
    forged = await client.post(f'/webhooks/retell/{rid}', content=body, headers={**h, 'x-retell-signature': retell_signature('wrong', body)})
    assert forged.status_code == 401
    unknown = await client.post('/webhooks/retell/int_nope', content=body, headers={**h, 'x-retell-signature': retell_signature('key_retell_test', body)})
    assert unknown.status_code == 404


async def test_queues_a_signed_call_fetches_the_prompt_and_scores_it(client, db, monkeypatch):
    calls = stub_http(monkeypatch, [
        (r'/get-agent/agent_rt_1$', lambda u, r: {'agent_id': 'agent_rt_1', 'agent_name': 'Fakhruddin inbound', 'version': 3, 'response_engine': {'type': 'retell-llm', 'llm_id': 'llm_1', 'version': 3}}),
        (r'/get-retell-llm/llm_1$', lambda u, r: {'llm_id': 'llm_1', 'model': 'claude', 'general_prompt': 'You are Sara, a sales agent for Fakhruddin Properties…', 'begin_message': 'Thank you for calling Fakhruddin Properties.'}),
    ])
    body = json.dumps({'event': 'call_analyzed', 'call': retell_call()})
    r = await client.post(f"/webhooks/retell/{state['retell']}", content=body, headers={'content-type': 'application/json', 'x-retell-signature': retell_signature('key_retell_test', body)})
    assert r.status_code == 200
    assert r.json() == {'ok': True, 'queued': True}
    ran = await drain(db)
    assert [j for j in ran if not j['ok']] == []
    assert {'ingest_call', 'evaluate_call'} <= {j['kind'] for j in ran}
    assert any('/get-retell-llm/llm_1' in c for c in calls)
    detail = (await client.get('/api/calls/rt_call_abc')).json()
    assert detail['cqs'] > 0
    assert len(detail['turns']) == 5
    assert detail['promptVersion'] == 'v2'


async def test_does_not_duplicate_a_call_delivered_twice(client, db, monkeypatch):
    stub_http(monkeypatch, [])
    body = json.dumps({'event': 'call_analyzed', 'call': retell_call()})
    await client.post(f"/webhooks/retell/{state['retell']}", content=body, headers={'content-type': 'application/json', 'x-retell-signature': retell_signature('key_retell_test', body)})
    await drain(db)
    n = await db.one("select count(*)::int as n from calls where provider = 'retell'")
    assert n['n'] == 1


async def test_pulls_new_conversations_for_the_configured_agent(client, db, monkeypatch):
    r = await client.post('/api/integrations', json={'provider': 'elevenlabs', 'apiKey': 'xi_test_key', 'webhookSecret': 'wsec_test', 'agentIds': ['agent_el_1']})
    state['el'] = r.json()['id']
    conv = eleven_labs_conversation('conv_01')
    start = conv['metadata']['start_time_unix_secs']
    calls = stub_http(monkeypatch, [
        (r'/v1/convai/conversations$', lambda u, r: {'conversations': [
            {'conversation_id': 'conv_01', 'start_time_unix_secs': start, 'status': 'done'},
            {'conversation_id': 'conv_live', 'start_time_unix_secs': start + 60, 'status': 'in-progress'},
        ], 'has_more': False, 'next_cursor': None}),
        (r'/v1/convai/conversations/conv_01$', lambda u, r: conv),
        (r'/v1/convai/agents/agent_el_1$', lambda u, r: {'agent_id': 'agent_el_1', 'name': 'Fakhruddin outbound', 'version_id': 'agtvrsn_7', 'conversation_config': {'agent': {'first_message': 'Hi, this is Sara…', 'prompt': {'prompt': 'You are Sara…', 'llm': 'claude', 'tools': [{'name': 'send_documents'}]}}}}),
    ])
    sync = await client.post(f"/api/integrations/{state['el']}/sync")
    assert sync.json()['jobId']
    ran = await drain(db)
    assert [j for j in ran if not j['ok']] == []
    # Only finished conversations are ingested; the agent filter goes to the list call.
    assert 'agent_id=agent_el_1' in next(c for c in calls if c.startswith('GET /v1/convai/conversations?'))
    assert not any('conv_live' in c for c in calls)
    integ = next(i for i in (await client.get('/api/integrations')).json() if i['id'] == state['el'])
    assert integ['callsImported'] == 1 and integ['lastError'] is None
    assert integ['lastSyncStatus'].startswith('ok')
    detail = (await client.get('/api/calls/el_conv_01')).json()
    assert detail['promptVersion'] == 'v7'


async def test_accepts_a_signed_post_call_webhook_with_the_transcript_inline(client, db, monkeypatch):
    stub_http(monkeypatch, [(r'/v1/convai/agents/agent_el_1$', lambda u, r: {'agent_id': 'agent_el_1', 'name': 'Fakhruddin outbound', 'conversation_config': {'agent': {'prompt': {'prompt': 'You are Sara…'}}}})])
    body = json.dumps({'type': 'post_call_transcription', 'event_timestamp': int(time.time()), 'data': eleven_labs_conversation('conv_02')})
    r = await client.post(f"/webhooks/elevenlabs/{state['el']}", content=body, headers={'content-type': 'application/json', 'elevenlabs-signature': eleven_labs_signature('wsec_test', body)})
    assert r.status_code == 200
    await drain(db)
    row = await db.one("select status from calls where call_id = 'el_conv_02'")
    assert row['status'] == 'scored'


async def test_credits_a_csv_outcome_to_the_preceding_call_and_skips_bad_rows(client, db):
    at = (datetime.now(UTC) - timedelta(minutes=30)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    csv = f'lead_id,stage,occurred_at,project,value_aed\nlead_123,Meeting booked,{at},Treppan Tower,\nlead_123,not-a-stage,{at},,\n"lead_999",sale,{at},"Hatta Lakes","1,250,000"\n'
    r = await client.post('/api/crm/outcomes/csv', content=csv, headers={'content-type': 'text/csv'})
    assert r.json()['imported'] == 2 and r.json()['skipped'] == 1
    o = await db.one("select credited_call_id from lead_outcome where lead_id = 'lead_123'")
    assert o['credited_call_id'] in ('el_conv_01', 'el_conv_02')
    orphan = await db.one("select credited_call_id, value_aed from lead_outcome where lead_id = 'lead_999'")
    assert orphan['credited_call_id'] is None
    assert float(orphan['value_aed']) == 1250000


async def test_api_token_guards_every_api_route_including_encoded_paths(client, monkeypatch):
    monkeypatch.setattr(config, 'api_token', 'sekret')
    for url in ['/api/meta', '/%61pi/meta', 'http://test//api/meta', '/api/integrations']:
        r = await client.get(url)
        assert r.status_code in (401, 404), url
        assert r.status_code != 200, url
    assert (await client.get('/%61pi/meta')).status_code == 401
    assert (await client.get('/api/meta', headers={'authorization': 'Bearer sekret'})).status_code == 200
    assert (await client.get('/api/meta?token=sekret')).status_code == 200
    assert (await client.post('/api/demo/seed?token=sekret')).status_code == 401


# ---------- Console endpoints on demo data ----------

ENDPOINTS = ['/api/meta', '/api/settings', '/api/matrix', '/api/matrix?range=7', '/api/calls?limit=5', '/api/version-report', '/api/traces', '/api/funnel', '/api/fix',
             '/api/recommendations', '/api/taxonomy/health', '/api/alerts', '/api/review', '/api/recordings', '/api/jobs', '/api/integrations', '/api/attention-items', '/healthz']


async def test_seeds_demo_data(db):
    r = await seed_demo(db, count=400, days=30)
    assert r['calls'] == 400


@pytest.mark.parametrize('url', ENDPOINTS)
async def test_get_answers_200(client, url):
    r = await client.get(url)
    assert r.status_code == 200, r.text[:300]


async def test_serves_a_cell_drill_down_and_a_call_with_spans_metrics_and_evidence(client):
    m = (await client.get('/api/matrix')).json()
    cell = next(c for c in m['cells'] if c['n'] > 0)
    assert (await client.get(f"/api/cells/{cell['pid']}/{cell['sid']}")).status_code == 200
    lst = (await client.get('/api/calls?limit=1')).json()
    call = (await client.get(f"/api/calls/{lst['items'][0]['id']}")).json()
    assert len(call['metrics']) > 10
    assert len(call['turns']) > 2


# By now the database holds three agents (demo, Retell, ElevenLabs) with their own version labels;
# recommendations must come from each agent's live version, not one label across all of them.
async def test_moves_a_recommendation_through_its_lifecycle(client):
    recs = (await client.get('/api/recommendations')).json()
    assert len(recs) > 0
    rid = next(r for r in recs if r['status'] == 'proposed')['id']
    r = await client.patch(f'/api/recommendations/{rid}', json={'status': 'accepted', 'note': 'Ship in the next prompt.'})
    assert r.json()['status'] == 'accepted'
    bad = await client.patch(f'/api/recommendations/{rid}', json={'status': 'nonsense'})
    assert bad.status_code == 400


async def test_updates_settings(client):
    r = await client.put('/api/settings', json={'goodLine': 72})
    assert r.json()['goodLine'] == 72
