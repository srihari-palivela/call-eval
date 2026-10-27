# The built-in CRM, business onboarding and the Apollo lead finder, over HTTP on a throwaway database.

import json

import httpx
import pytest

from calleval.analytics.meta import seed_taxonomy
from calleval.leadfinder import apollo
from calleval.server import build_app

from .fixtures import drain, stub_http

pytestmark = pytest.mark.asyncio(loop_scope='session')


@pytest.fixture(scope='module')
async def client(db):
    await seed_taxonomy(db)
    app = build_app(db)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as c:
        yield c


async def test_crm_routes_are_off_until_the_toggle_is_on(client):
    r = await client.get('/api/crm/leads')
    assert r.status_code == 403
    s = (await client.put('/api/settings', json={'features': {'crm': True}})).json()
    assert s['features']['crm'] is True
    assert (await client.get('/api/crm/leads')).status_code == 200


async def test_campaigns_switch_the_crm_on_and_bad_modes_are_ignored(client):
    s = (await client.put('/api/settings', json={'features': {'campaigns': True, 'improvement': 'reckless'}})).json()
    assert s['features'] == {'crm': True, 'campaigns': True, 'improvement': 'propose'}


async def test_creates_and_backfills_leads_without_duplicates(client):
    r = (await client.post('/api/crm/leads', json={'name': 'Omar Haddad', 'phone': '00971 50 123 4567', 'consent': 'opt_in'})).json()
    assert r['created'] and r['phone'] == '+971501234567' and r['phoneValid'] and r['firstName'] == 'Omar' and r['lastName'] == 'Haddad'
    again = (await client.post('/api/crm/leads', json={'phone': '+971501234567', 'email': 'Omar@Example.com', 'company': 'Haddad Holdings', 'firstName': 'Someone'})).json()
    assert not again['created'] and again['id'] == r['id']
    assert again['email'] == 'omar@example.com' and again['company'] == 'Haddad Holdings'
    assert again['firstName'] == 'Omar'  # backfill keeps what is already filled
    bad = await client.post('/api/crm/leads', json={'email': 'not-an-email'})
    assert bad.status_code == 400


async def test_imports_a_csv_and_reports_bad_rows(client):
    csv = ('first_name,last_name,phone,email,company,consent,stage,tags\n'
           'Aisha,Khan,+971500000010,aisha@example.com,Khan Realty,opt_in,new,vip;broker\n'
           'Bad,Row,,not-an-email,,,,\n'
           'Omar,,+971501234567,,,,,\n')
    r = (await client.post('/api/crm/leads/import', content=csv, headers={'content-type': 'text/csv'})).json()
    assert r['created'] == 1 and r['updated'] == 1 and r['skipped'] == 1
    assert 'row 3' in r['errors'][0]
    leads = (await client.get('/api/crm/leads?q=khan')).json()
    assert leads['total'] == 1 and leads['items'][0]['tags'] == ['vip', 'broker']


async def test_outcome_stages_become_lead_outcomes_once(client, db):
    lead = (await client.get('/api/crm/leads?q=aisha')).json()['items'][0]
    r = await client.post(f"/api/crm/leads/{lead['id']}/stage", json={'stage': 'reservation', 'valueAed': 1_600_000})
    assert r.json()['stage'] == 'reservation'
    await client.post(f"/api/crm/leads/{lead['id']}/stage", json={'stage': 'reservation', 'valueAed': 1_600_000})
    rows = await db.query("select stage, value_aed, source from lead_outcome where lead_id = $1", [lead['id']])
    assert rows == [{'stage': 'reservation', 'value_aed': 1600000.0, 'source': 'crm'}]
    detail = (await client.get(f"/api/crm/leads/{lead['id']}")).json()
    assert [e['type'] for e in detail['events']][:2] == ['stage', 'stage']
    assert detail['outcomes'][0]['stage'] == 'reservation'
    assert (await client.post(f"/api/crm/leads/{lead['id']}/stage", json={'stage': 'won'})).status_code == 400


async def test_a_scored_call_moves_its_lead_and_a_dnc_request_stops_contact(client, db):
    from calleval.crm.leads import after_call
    lead = (await client.get('/api/crm/leads?q=omar')).json()['items'][0]
    for cid, step, dnc in (('dm_t1', None, False), ('dm_t2', 'meeting', False), ('dm_t3', None, True)):
        await db.query("insert into calls (call_id, provider, external_id, started_at, status, lead_id, next_step, qualified) values ($1,'demo',$1,now(),'scored',$2,$3,false)",
                       [cid, lead['id'], step])
        if dnc:
            await db.query("insert into call_event (call_id, type, turn, source) values ($1, 'dnc_request', 3, 'code')", [cid])
        await after_call(db, cid)
        await after_call(db, cid)  # re-scoring the same call counts once
    d = (await client.get(f"/api/crm/leads/{lead['id']}")).json()
    assert d['callCount'] == 3
    assert d['stage'] == 'dnc' and d['dnc'] and d['consent'] == 'denied'
    stages = [e['detail'].get('to') for e in reversed(d['events']) if e['type'] == 'stage']
    assert stages == ['contacted', 'meeting_booked', 'dnc']
    assert any(o['stage'] == 'meeting_booked' for o in d['outcomes'])


async def test_eligible_filter_excludes_dnc_unknown_consent_and_bad_numbers(client):
    await client.post('/api/crm/leads', json={'name': 'Unknown Consent', 'phone': '+971500000099'})
    await client.post('/api/crm/leads', json={'name': 'No Number', 'email': 'nonumber@example.com', 'consent': 'opt_in'})
    names = {x['name'] for x in (await client.get('/api/crm/leads?eligible=true')).json()['items']}
    assert names == set()  # Aisha reserved (closed), Omar DNC, the others lack consent or a number
    await client.put('/api/business', json={'calling': {'allowUnknownConsent': True}})
    names = {x['name'] for x in (await client.get('/api/crm/leads?eligible=true')).json()['items']}
    assert names == {'Unknown Consent'}


async def test_onboarding_validates_and_builds_the_apollo_query(client):
    bad = await client.put('/api/business', json={'icp': {'seniorities': ['emperor']}})
    assert bad.status_code == 400
    assert (await client.put('/api/business', json={'calling': {'timezone': 'Mars/Base'}})).status_code == 400
    r = await client.put('/api/business', json={
        'company': {'name': 'Fakhruddin Properties', 'markets': ['UAE', 'UK']},
        'icp': {'titles': ['Real Estate Broker'], 'seniorities': ['owner', 'director'], 'personLocations': ['London, United Kingdom'],
                'employeeRanges': ['1,10'], 'keywords': 'off-plan', 'industries': ['real estate'], 'personaHint': 'P7'},
        'goals': {'meetingsPerWeek': 25, 'targetMeetingRate': 18, 'focusPersonas': ['P7']}, 'onboarded': True})
    assert r.status_code == 200 and r.json()['onboardedAt']
    b = (await client.get('/api/business')).json()
    assert b['apolloQuery'] == {'person_titles[]': ['Real Estate Broker'], 'include_similar_titles': True, 'person_seniorities[]': ['owner', 'director'],
                                'person_locations[]': ['London, United Kingdom'], 'organization_num_employees_ranges[]': ['1,10'], 'q_keywords': 'off-plan real estate'}
    assert b['progress']['goals']['meetingsPerWeek'] == 25 and b['leadFinder']['apollo'] is False


async def test_finds_leads_on_apollo_and_enriches_them_within_the_credit_cap(client, db, monkeypatch):
    assert (await client.post('/api/leadfinder/search', json={'max': 3})).status_code == 400  # no Apollo key yet
    monkeypatch.setenv('APOLLO_API_KEY', 'apollo_test')
    people = [{'id': f'ap_{i}', 'first_name': f'Broker{i}', 'last_name_obfuscated': 'S***h', 'title': 'Broker', 'has_email': True, 'has_direct_phone': 'Yes',
               'organization': {'name': f'Agency {i}'}} for i in range(5)]
    seen: list[dict] = []

    def search(u, req):
        seen.append(dict(u.params.multi_items()))
        return {'total_entries': 5, 'people': people}

    def match(u, req):
        details = json.loads(req['content'])['details']
        return {'matches': [{'id': d['id'], 'first_name': 'B', 'last_name': 'Smith', 'email': f"{d['id']}@agency.example", 'email_status': 'verified',
                             'city': 'London', 'country': 'United Kingdom', 'match_confidence': 'high'} for d in details],
                'credits_consumed': len(details), 'request_id': 'req_1'}

    calls = stub_http(monkeypatch, [(r'/mixed_people/api_search$', search), (r'/people/bulk_match$', match)])
    r = await client.post('/api/leadfinder/search', json={'max': 3})
    assert r.status_code == 200
    ran = await drain(db)
    assert [j for j in ran if not j['ok']] == []
    assert ('person_titles[]', 'Real Estate Broker') in seen[0].items() or seen[0].get('person_titles[]') == 'Real Estate Broker'
    found = (await client.get('/api/crm/leads?source=apollo')).json()
    assert found['total'] == 3
    assert all(x['consent'] == 'unknown' and x['personaHint'] == 'P7' and x['lastName'] is None for x in found['items'])
    # Phones need a public HTTPS address; with the test URL they are requested by webhook.
    r = await client.post('/api/leadfinder/enrich', json={'creditCap': 18})  # 9 credits a person with phones → 2 people
    assert r.status_code == 200
    await drain(db)
    enriched = [x for x in (await client.get('/api/crm/leads?source=apollo')).json()['items'] if x['enrichedAt']]
    assert len(enriched) == 2 and all(x['email'].endswith('@agency.example') and x['lastName'] == 'Smith' for x in enriched)
    assert any('reveal_phone_number=true' in c and 'webhook_url=' in c for c in calls)


async def test_apollo_phone_webhook_needs_its_secret_and_backfills_phones(client):
    r = await client.post('/webhooks/apollo/env/wrong', json={'people': [{'id': 'ap_0', 'phone_numbers': [{'sanitized_number': '+447700900001'}]}]})
    assert r.status_code == 401
    secret = apollo.phone_webhook_secret(None)
    r = await client.post(f'/webhooks/apollo/env/{secret}', json={'people': [{'id': 'ap_0', 'phone_numbers': [{'sanitized_number': '+447700900001'}]}]})
    assert r.json()['updated'] == 1
    lead = next(x for x in (await client.get('/api/crm/leads?source=apollo')).json()['items'] if x['apolloId'] == 'ap_0')
    assert lead['phone'] == '+447700900001'
