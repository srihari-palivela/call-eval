# Calling compliance: country windows in the lead's local time (UAE 9–18 Dubai, US 8–21 own zone), retry pacing,
# no call after a refusal, the do-not-call list, US consent and time zone, holds on leads, and the issues list.

from datetime import UTC, datetime, timedelta

import httpx
import pytest

from calleval import compliance
from calleval.business import update_business
from calleval.campaigns import engine, providers
from calleval.crm.leads import after_call, upsert_lead
from calleval.js import js_json
from calleval.lib.settings import update_settings
from calleval.server import build_app

ALWAYS = {'timezone': 'UTC', 'startHour': 0, 'endHour': 24, 'days': [0, 1, 2, 3, 4, 5, 6], 'maxAttemptsPerLead': 5}
DUBAI_10AM = datetime(2026, 10, 27, 6, 0, tzinfo=UTC)   # 10:00 Dubai, 02:00 New York
DUBAI_8PM = datetime(2026, 10, 27, 16, 0, tzinfo=UTC)   # 20:00 Dubai, 12:00 New York
CAMPAIGN = {'id': 'cmp_rules', 'allow_unknown_consent': False, 'lead_filter': {}}
st: dict = {}


async def _lead(db, **kw):
    row, _ = await upsert_lead(db, kw, source='api')
    return row


@pytest.fixture(scope='module')
async def setup(db):
    await update_settings(db, {'features': {'crm': True}})
    await update_business(db, {'calling': ALWAYS})
    st['ae'] = await _lead(db, firstName='Aisha', phone='+971501230001', consent='opt_in')
    st['us'] = await _lead(db, firstName='Sam', phone='+12125550101', consent='opt_in', timezone='America/New_York')
    st['us_noconsent'] = await _lead(db, firstName='Una', phone='+12125550102', consent='unknown', timezone='America/New_York')
    st['us_notz'] = await _lead(db, firstName='Tia', phone='+12125550103', consent='opt_in')
    st['uk'] = await _lead(db, firstName='Ben', phone='+447700900001', consent='opt_in')
    return st


async def _ids(db, now, **kw):
    return {r['id'] for r in await engine.eligible_leads(db, {**CAMPAIGN, **kw}, ALWAYS, 100, now=now)}


async def test_each_country_is_called_only_inside_its_own_window(db, setup):
    assert await _ids(db, DUBAI_10AM) == {st['ae']['id'], st['uk']['id']}
    assert await _ids(db, DUBAI_8PM) == {st['us']['id'], st['uk']['id']}
    # The business window (always open here) never widens a country's: 19:00 in Dubai is closed for UAE numbers.
    assert st['ae']['id'] not in await _ids(db, datetime(2026, 10, 27, 15, 0, tzinfo=UTC))


async def test_us_leads_need_consent_and_a_time_zone(db, setup):
    held = await compliance.holds(db, [await db.one('select * from lead where id = $1', [i]) for i in (st['us_noconsent']['id'], st['us_notz']['id'])])
    assert held[st['us_noconsent']['id']] == {'reason': 'Needs recorded consent (US)', 'until': None}
    assert held[st['us_notz']['id']]['reason'] == 'Time zone unknown'
    # Unknown consent allowed for the campaign still doesn't reach US numbers.
    assert st['us_noconsent']['id'] not in await _ids(db, DUBAI_8PM, allow_unknown_consent=True)


async def test_retry_pacing_holds_uae_leads_once_a_day_and_twice_a_week(db, setup):
    lead = st['ae']['id']
    await db.query("insert into campaign_lead (campaign_id, lead_id, batch_id, arm, status, attempted_at) values ('cmp_a', $1, 'cb_1', 'champion', 'called', $2)",
                   [lead, DUBAI_10AM - timedelta(hours=2)])
    assert lead not in await _ids(db, DUBAI_10AM)
    row = await db.one('select * from lead where id = $1', [lead])
    h = (await compliance.holds(db, [row], now=DUBAI_10AM))[lead]
    assert h['reason'].startswith('Retry limit: next call after 28 Oct, 08:00 (Asia/Dubai)')
    assert h['until'] == '2026-10-28T04:00:00.000Z'
    next_day = DUBAI_10AM + timedelta(days=1)
    assert lead in await _ids(db, next_day)
    # A second attempt that week: the weekly limit (2) holds it beyond the next day.
    await db.query("insert into campaign_lead (campaign_id, lead_id, batch_id, arm, status, attempted_at) values ('cmp_a', $1, 'cb_2', 'champion', 'called', $2)",
                   [lead, next_day - timedelta(hours=1)])
    assert lead not in await _ids(db, next_day + timedelta(days=2))
    assert lead in await _ids(db, DUBAI_10AM + timedelta(days=7))
    await db.query("delete from campaign_lead where campaign_id = 'cmp_a'")


async def test_a_refusal_on_a_call_closes_the_lead_and_stops_calls(db, setup):
    lead = await _lead(db, firstName='Rana', phone='+971501230009', consent='opt_in')
    await db.query(
        """insert into calls (call_id, provider, external_id, lead_id, started_at, status, canonical, scenario, persona, scored_at)
           values ('el_refuse', 'elevenlabs', 'refuse', $1, now(), 'scored', $2::jsonb, 'S10', 'P6', now())""", [lead['id'], js_json({'turns': []})])
    await after_call(db, 'el_refuse')
    row = await db.one('select stage, refused_at from lead where id = $1', [lead['id']])
    assert row['stage'] == 'lost' and row['refused_at'] is not None
    assert lead['id'] not in await _ids(db, DUBAI_10AM)
    held = await compliance.holds(db, [await db.one('select * from lead where id = $1', [lead['id']])])
    assert held[lead['id']]['reason'] == 'Refused on a call'


async def test_the_do_not_call_list_takes_a_csv_with_a_header_and_columns(db, setup):
    app = build_app(db)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as c:
        csv = 'name,phone,note\nAisha,+971 50 123 0001,listed in DNCR\nBad,12,x\nUK person,00447700900002,\n'
        r = (await c.post('/api/compliance/dnc', content=csv, headers={'content-type': 'text/csv'})).json()
        assert r == {'added': 2, 'invalid': 1, 'total': 2}
        assert (await c.post('/api/compliance/dnc', json={'numbers': ['+971501230001', 'nope']})).json() == {'added': 0, 'invalid': 1, 'total': 2}
        assert (await c.get('/api/compliance/dnc/check?phone=%2B971501230001')).json() == {'listed': True}
        assert st['ae']['id'] not in await _ids(db, DUBAI_10AM)
        listed = (await c.get('/api/crm/leads?q=Aisha')).json()['items'][0]
        assert listed['hold'] == {'reason': 'On the do-not-call list', 'until': None}
        d = (await c.get('/api/compliance')).json()
        assert d['dnc']['count'] == 2 and d['held']['dnc'] == 1 and d['held']['refused'] == 1 and d['held']['consent'] == 1
        assert [r['country'] for r in d['rules']] == ['AE', 'US'] and d['rules'][0]['endHour'] == 18
        assert (await c.delete('/api/compliance/dnc')).json() == {'removed': 2}
    assert st['ae']['id'] in await _ids(db, DUBAI_10AM)


async def test_issues_flag_hours_past_the_uae_window_until_fixed(db, setup):
    await update_business(db, {'calling': {'timezone': 'Asia/Dubai', 'startHour': 9, 'endHour': 20}})
    d = await compliance.compliance_dto(db)
    block = [i for i in d['issues'] if i['severity'] == 'block']
    assert len(block) == 1 and 'United Arab Emirates' in block[0]['title'] and '9:00–18:00' in block[0]['fix']
    assert d['issues'][0]['severity'] == 'block'
    titles = {i['title'] for i in d['issues']}
    assert {'No do-not-call list uploaded', 'UAE telemarketing needs TDRA approval', 'US calls must say the agent is an AI'} <= titles
    assert '1 US leads have no recorded consent' in titles and '1 US leads have no time zone' in titles
    assert await compliance.blocking_issues(db) == 1
    await update_business(db, {'calling': {'startHour': 9, 'endHour': 18}})
    assert await compliance.blocking_issues(db) == 0
    await update_business(db, {'calling': ALWAYS})


def test_us_calls_ask_the_agent_to_disclose_it_is_an_ai():
    camp = {'id': 'cmp_1', 'objective': ''}
    us = providers.retell_task({'id': 'ld_1', 'phone': '+12125550101'}, camp, 'champion', 'v1', None)
    ae = providers.elevenlabs_recipient({'id': 'ld_2', 'phone': '+971501230001'}, camp, 'champion', 'v1', None)
    assert us['retell_llm_dynamic_variables']['ai_disclosure'] == 'true'
    assert ae['conversation_initiation_client_data']['dynamic_variables']['ai_disclosure'] == 'false'
    assert compliance.rule_for('+447700900001') is None and compliance.rule_for('+971501230001')['country'] == 'AE'
