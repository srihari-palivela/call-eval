# Batch-calling campaigns: who is eligible, when calls go out, how batches split between prompt arms, what the
# providers receive, and how scored calls come back to their campaign lead.

import json
from datetime import UTC, datetime

import httpx
import pytest

from calleval.business import update_business
from calleval.campaigns import engine, providers
from calleval.connectors.registry import save_integration
from calleval.crm.leads import upsert_lead
from calleval.js import js_json
from calleval.lib.errors import HttpStatusError
from calleval.lib.settings import update_settings

from .fixtures import stub_http

ALWAYS = {'timezone': 'UTC', 'startHour': 0, 'endHour': 24, 'days': [0, 1, 2, 3, 4, 5, 6], 'maxAttemptsPerLead': 3, 'allowUnknownConsent': False}
st: dict = {}


async def _lead(db, **kw):
    row, _ = await upsert_lead(db, kw, source='api')
    if 'call_count' in kw:
        await db.query('update lead set call_count = $2 where id = $1', [row['id'], kw['call_count']])
    return row


@pytest.fixture(scope='module')
async def setup(db):
    await update_settings(db, {'features': {'crm': True, 'campaigns': True, 'improvement': 'propose'}})
    await update_business(db, {'calling': {k: v for k, v in ALWAYS.items() if k != 'allowUnknownConsent'}})
    el = await save_integration(db, None, {'provider': 'elevenlabs', 'apiKey': 'xi_key', 'agentIds': ['agent_el_1']})
    rt = await save_integration(db, None, {'provider': 'retell', 'apiKey': 'rt_key', 'agentIds': ['agent_rt_1']})
    st['el'], st['rt'] = el['id'], rt['id']
    st['ok'] = await _lead(db, firstName='Aisha', phone='+4477001110001', consent='opt_in', company='Acme')
    st['unknown'] = await _lead(db, firstName='Omar', phone='+4477001110002', consent='unknown')
    await _lead(db, firstName='Dana', phone='+4477001110003', consent='opt_in', dnc=True)
    await _lead(db, firstName='Lee', phone='050 111 0004', consent='opt_in')  # not E.164
    await _lead(db, firstName='Max', phone='+4477001110005', consent='opt_in', call_count=3)
    await _lead(db, firstName='Lou', phone='+4477001110006', consent='opt_in', stage='lost')
    await _lead(db, firstName='Den', phone='+4477001110007', consent='denied')
    return st


async def test_feature_switch_guards_campaigns(db, setup):
    await update_settings(db, {'features': {'campaigns': False}})
    with pytest.raises(HttpStatusError) as e:
        await engine.require_campaigns(db)
    assert e.value.status_code == 403
    await update_settings(db, {'features': {'campaigns': True}})
    await engine.require_campaigns(db)


def test_effective_mode_is_the_stricter_one():
    assert engine.effective_mode('auto', 'propose') == 'propose'
    assert engine.effective_mode('propose', 'auto') == 'propose'
    assert engine.effective_mode('auto', 'auto') == 'auto'
    assert engine.effective_mode('auto', 'off') == 'off'


def test_calling_window_uses_the_business_timezone_and_days():
    calling = {'timezone': 'Asia/Dubai', 'startHour': 9, 'endHour': 20, 'days': [0, 1, 2, 3, 4, 5]}
    assert engine.in_calling_window(calling, datetime(2026, 10, 26, 6, 0, tzinfo=UTC))       # Monday 10:00 in Dubai
    assert not engine.in_calling_window(calling, datetime(2026, 10, 26, 4, 30, tzinfo=UTC))  # 08:30 in Dubai
    assert not engine.in_calling_window(calling, datetime(2026, 10, 26, 16, 0, tzinfo=UTC))  # 20:00 in Dubai
    assert not engine.in_calling_window(calling, datetime(2026, 11, 1, 8, 0, tzinfo=UTC))    # Sunday


def test_arm_assignment_is_deterministic_and_close_to_the_share():
    assert engine.assign_arm('ld_1', None, 0.5) == 'champion'
    arms = [engine.assign_arm(f'ld_{i}', 'cyc_a', 0.2) for i in range(2000)]
    assert arms == [engine.assign_arm(f'ld_{i}', 'cyc_a', 0.2) for i in range(2000)]
    assert 0.16 < arms.count('challenger') / 2000 < 0.24


async def test_only_eligible_leads_are_called(db, setup):
    c = {'id': 'cmp_x', 'allow_unknown_consent': False, 'lead_filter': {}}
    ids = {r['id'] for r in await engine.eligible_leads(db, c, ALWAYS, 50)}
    assert ids == {st['ok']['id']}
    ids = {r['id'] for r in await engine.eligible_leads(db, {**c, 'allow_unknown_consent': True}, ALWAYS, 50)}
    assert ids == {st['ok']['id'], st['unknown']['id']}
    ids = {r['id'] for r in await engine.eligible_leads(db, {**c, 'lead_filter': {'leadIds': [st['unknown']['id']]}}, ALWAYS, 50)}
    assert ids == set()


def test_provider_payloads_carry_the_join_keys_and_the_challenger_prompt():
    lead = {'id': 'ld_1', 'phone': '+4477000000001', 'first_name': 'Aisha', 'company': 'Acme', 'persona_hint': 'P3'}
    camp = {'id': 'cmp_1', 'objective': 'Book a viewing'}
    champ = providers.elevenlabs_recipient(lead, camp, 'champion', 'v3', None)
    assert champ['phone_number'] == '+4477000000001'
    dv = champ['conversation_initiation_client_data']['dynamic_variables']
    assert dv['lead_id'] == 'ld_1' and dv['campaign_id'] == 'cmp_1' and dv['arm'] == 'champion' and dv['prompt_version'] == 'v3'
    assert json.loads(dv['known_facts']) == {'company': 'Acme', 'persona': 'P3'}
    assert 'conversation_config_override' not in champ['conversation_initiation_client_data']
    chal = providers.elevenlabs_recipient(lead, camp, 'challenger', 'v3.c1', 'NEW PROMPT')
    assert chal['conversation_initiation_client_data']['conversation_config_override'] == {'agent': {'prompt': {'prompt': 'NEW PROMPT'}}}
    task = providers.retell_task(lead, camp, 'challenger', 'v3.c1', 'NEW PROMPT')
    assert task['to_number'] == '+4477000000001'
    assert all(isinstance(v, str) for v in task['retell_llm_dynamic_variables'].values())
    assert task['metadata']['arm'] == 'challenger'
    assert task['agent_override'] == {'retell_llm': {'general_prompt': 'NEW PROMPT'}}
    assert 'agent_override' not in providers.retell_task(lead, camp, 'champion', 'v3', None)


async def test_retell_campaigns_need_a_from_number(db, setup):
    with pytest.raises(HttpStatusError):
        await engine.create_campaign(db, {'name': 'R', 'integrationId': st['rt']})
    c = await engine.create_campaign(db, {'name': 'R', 'integrationId': st['rt'], 'fromNumber': '+14155550100'})
    assert c['agentExternalId'] == 'agent_rt_1' and c['status'] == 'draft'


async def test_dispatches_a_champion_batch_then_splits_arms_once_a_challenger_is_live(db, setup, monkeypatch):
    sent: list[dict] = []

    def submit(u, req):
        sent.append(json.loads(req['content']))
        return {'id': f'batch_{len(sent)}', 'status': 'pending'}

    stub_http(monkeypatch, [
        (r'/v1/convai/batch-calling/submit$', submit),
        (r'/v1/convai/agents/agent_el_1$', lambda u, r: {'agent_id': 'agent_el_1', 'name': 'Sara', 'conversation_config': {'agent': {'prompt': {'prompt': 'You are Sara.'}}}}),
    ])
    c = await engine.create_campaign(db, {'name': 'October', 'integrationId': st['el'], 'objective': 'Book a viewing', 'batchSize': 10, 'allowUnknownConsent': True})
    st['cmp'] = c['id']
    started = await engine.set_status(db, c['id'], 'start')
    assert started['status'] == 'running'
    assert started['champion'] == {'label': 'v1', 'source': 'provider'} and started['championPrompt'] == 'You are Sara.'
    r = await engine.dispatch_batch(db, c['id'])
    assert r['size'] == 2 and r['providerBatchId'] == 'batch_1'
    body = sent[0]
    assert body['agent_id'] == 'agent_el_1' and body['timezone'] == 'UTC'
    assert {x['conversation_initiation_client_data']['dynamic_variables']['arm'] for x in body['recipients']} == {'champion'}
    lead = await db.one('select stage from lead where id = $1', [st['ok']['id']])
    assert lead['stage'] == 'contacted'
    # One batch in flight at a time.
    assert (await engine.dispatch_batch(db, c['id']))['skipped'] == 'a batch is still in flight'

    # The first batch's calls come back; a challenger goes live and takes half the next batch.
    await db.query("update campaign_lead set status = 'called' where campaign_id = $1", [c['id']])
    for i in range(20):
        await _lead(db, firstName=f'N{i}', phone=f'+447700222{i:04d}', consent='opt_in')
    await db.query('update campaign set challenger = $2::jsonb, challenger_share = 0.5, batch_size = 20 where id = $1',
                   [c['id'], js_json({'label': 'v1.c1', 'prompt': 'You are Sara. Ask one question per turn.', 'cycleId': 'cyc_test'})])
    r = await engine.dispatch_batch(db, c['id'])
    assert r['size'] == 20
    arms = {}
    for x in sent[1]['recipients']:
        init = x['conversation_initiation_client_data']
        arm = init['dynamic_variables']['arm']
        arms[arm] = arms.get(arm, 0) + 1
        if arm == 'challenger':
            assert init['dynamic_variables']['prompt_version'] == 'v1.c1'
            assert init['conversation_config_override']['agent']['prompt']['prompt'].endswith('one question per turn.')
        else:
            assert init['dynamic_variables']['prompt_version'] == 'v1'
    assert arms.get('challenger', 0) > 0 and arms.get('champion', 0) > 0


async def test_a_scored_call_is_linked_to_its_campaign_lead(db, setup):
    cl = await db.one("select lead_id, batch_id from campaign_lead where campaign_id = $1 and status = 'dispatched' limit 1", [st['cmp']])
    canonical = {'dynamicVariables': {'campaign_id': st['cmp'], 'lead_id': cl['lead_id'], 'arm': 'champion'}, 'turns': [], 'toolCalls': []}
    await db.query(
        """insert into calls (call_id, provider, external_id, lead_id, started_at, status, canonical, cqs, gated, next_step, scored_at)
           values ('el_c1', 'elevenlabs', 'c1', $1, now(), 'scored', $2::jsonb, 74, false, 'meeting', now())""", [cl['lead_id'], js_json(canonical)])
    stats = await engine.on_call_scored(db, 'el_c1')
    assert stats['called'] >= 1
    row = await db.one("select status, call_id from campaign_lead where campaign_id = $1 and lead_id = $2 and batch_id = $3", [st['cmp'], cl['lead_id'], cl['batch_id']])
    assert row == {'status': 'called', 'call_id': 'el_c1'}
    assert await engine.on_call_scored(db, 'nope') is None


async def test_a_provider_rejection_pauses_the_campaign(db, setup, monkeypatch):
    stub_http(monkeypatch, [(r'/batch-calling/submit$', lambda u, r: httpx.Response(422, json={'detail': [{'msg': 'phone number not on a SIP trunk'}]}))])
    c = await engine.create_campaign(db, {'name': 'Bad', 'integrationId': st['el'], 'allowUnknownConsent': True})
    await db.query("update campaign set status = 'running', champion = $2::jsonb where id = $1", [c['id'], js_json({'label': 'v1', 'prompt': 'x'})])
    await _lead(db, firstName='Zed', phone='+4477003330001', consent='opt_in')
    r = await engine.dispatch_batch(db, c['id'])
    assert 'phone number not on a SIP trunk' in r['paused']
    detail = await engine.campaign_detail(db, c['id'])
    assert detail['status'] == 'paused' and detail['batches'][0]['status'] == 'failed'
    assert 'SIP trunk' in detail['stats']['lastError']


async def test_tick_queues_dispatch_and_respects_the_daily_cap(db, setup):
    c = await engine.create_campaign(db, {'name': 'Tick', 'integrationId': st['el'], 'dailyCap': 1})
    await db.query("update campaign set status = 'running', champion = $2::jsonb where id = $1", [c['id'], js_json({'label': 'v1', 'prompt': None})])
    await engine.campaign_tick(db)
    job = await db.one("select payload from job where kind = 'campaign_dispatch' and dedupe_key = $1", [f"campaign:{c['id']}"])
    assert job['payload'] == {'campaignId': c['id']}
    await db.query("insert into campaign_lead (campaign_id, lead_id, batch_id, arm, status) values ($1, 'ld_any', 'cb_any', 'champion', 'called')", [c['id']])
    assert (await engine.dispatch_batch(db, c['id']))['skipped'] == 'daily cap reached'


async def test_http_routes_answer_and_respect_the_switch(db, setup):
    from calleval.routes_campaigns import router
    from calleval.server import build_app
    app = build_app(db)
    app.include_router(router)
    routes = app.router.routes  # keep the console's catch-all last, as server.py does
    for r in [r for r in routes if getattr(r, 'path', '') == '/{path:path}']:
        routes.remove(r)
        routes.append(r)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        r = await client.get('/api/campaigns')
        assert r.status_code == 200 and any(c['name'] == 'October' for c in r.json())
        assert (await client.post('/api/campaigns', json={'name': 'x', 'integrationId': 'nope'})).status_code == 400
        assert (await client.post('/api/improvement/cycles/cyc_nope/approve')).status_code == 404
        assert (await client.get('/api/improvement/lessons')).status_code == 200
        await update_settings(db, {'features': {'campaigns': False}})
        off = await client.get('/api/campaigns')
        assert off.status_code == 403 and 'Campaigns are off' in off.json()['message']
        await update_settings(db, {'features': {'campaigns': True}})


async def test_a_campaign_with_nobody_left_to_call_completes(db, setup):
    c = await engine.create_campaign(db, {'name': 'Empty', 'integrationId': st['el'], 'leadFilter': {'stages': ['site_visit']}})
    await db.query("update campaign set status = 'running' where id = $1", [c['id']])
    assert (await engine.dispatch_batch(db, c['id'])) == {'completed': True}
    assert (await engine.campaign_detail(db, c['id']))['status'] == 'completed'
