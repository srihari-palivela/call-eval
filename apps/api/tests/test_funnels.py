# Lead funnels: stages with framework milestones, routing new leads, outcomes and call progress by milestone,
# campaign eligibility from callable stages, edits that move leads, and the conversion report.

import httpx
import pytest

from calleval.analytics.meta import seed_taxonomy
from calleval.crm import funnels, leads
from calleval.server import build_app

pytestmark = pytest.mark.asyncio(loop_scope='session')


@pytest.fixture(scope='module')
async def client(db):
    await seed_taxonomy(db)
    app = build_app(db)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as c:
        yield c


async def lead(client, **kw) -> dict:
    r = await client.post('/api/crm/leads', json={'consent': 'opt_in', **kw})
    assert r.status_code == 200, r.text
    return r.json()


async def test_funnels_are_part_of_the_crm_switch(client):
    assert (await client.get('/api/crm/funnels')).status_code == 403
    await client.put('/api/settings', json={'features': {'crm': True}})
    d = (await client.get('/api/crm/funnels')).json()
    assert [f['id'] for f in d['funnels']] == ['fn_default'] and d['funnels'][0]['isDefault']
    assert d['funnels'][0]['match'] == {'paths': [], 'personas': [], 'sources': []}
    assert [s['key'] for s in d['funnels'][0]['stages']][:3] == ['new', 'contacted', 'qualified']
    assert {m['id'] for m in d['milestones']} >= {'meeting_booked', 'sale', 'dnc'} and d['copilot'] is False
    assert {t['id'] for t in d['templates']} == {'property_buyers', 'b2b_demo', 'partners'}


async def test_leads_from_before_funnels_join_the_default(client, db):
    await db.query("insert into lead (id, source, first_name, phone, stage, consent) values ('ld_old', 'csv', 'Old', '+971500000099', 'qualified', 'opt_in')")
    await db.query('update lead set funnel_id = null')
    lst = (await client.get('/api/crm/leads')).json()
    assert lst['funnel']['id'] == 'fn_default' and lst['stages']['qualified'] == 1
    assert lst['items'][0]['funnelId'] == 'fn_default'


async def test_stage_lists_are_checked(client):
    base = {'name': 'Broken', 'stages': [{'label': 'Won already', 'milestone': 'sale'}, {'label': 'Open', 'key': 'open'}, {'label': 'Again', 'key': 'open', 'milestone': 'sale'}]}
    r = await client.post('/api/crm/funnels', json=base)
    msg = r.json()['message']
    assert r.status_code == 400 and 'first stage must be an open stage' in msg and 'key open' in msg and 'milestone sale is on two stages' in msg
    ok = (await client.post('/api/crm/funnels', json={'name': 'Two step', 'stages': [{'label': 'Lead'}, {'label': 'Signed', 'milestone': 'sale'}]})).json()
    assert [(s['key'], s['kind'], s['callable']) for s in ok['stages']] == [('lead', 'open', True), ('signed', 'won', False), ('dnc', 'lost', False)]
    await client.delete(f"/api/crm/funnels/{ok['id']}")


async def test_new_leads_are_routed_by_the_match_rules(client):
    b2b = (await client.post('/api/crm/funnels', json={'template': 'b2b_demo', 'match': {'sources': ['apollo'], 'paths': [], 'personas': []}})).json()
    assert b2b['name'] == 'B2B demo pipeline' and b2b['match']['sources'] == ['apollo']
    found, _ = await leads.upsert_lead(await _db(client), {'firstName': 'Dana', 'company': 'Acme', 'phone': '+971500000001', 'consent': 'opt_in'}, source='apollo')
    assert found['funnel_id'] == b2b['id'] and found['stage'] == 'new'
    manual = await lead(client, name='Mona', phone='+971500000002')
    assert manual['funnelId'] == 'fn_default'
    # A CSV that names a milestone lands on the funnel's stage for it.
    pinned = await lead(client, name='Rami', phone='+971500000003', funnelId=b2b['id'], stage='meeting_booked')
    assert pinned['stage'] == 'demo_booked'
    bad = await client.post('/api/crm/leads', json={'name': 'X', 'phone': '+971500000004', 'funnelId': b2b['id'], 'stage': 'site_visit'})
    assert bad.status_code == 400 and 'not a stage of the funnel B2B demo pipeline' in bad.json()['message']


async def _db(client):
    return client._transport.app.state.db


async def test_outcome_stages_are_credited_by_milestone(client):
    db = await _db(client)
    f = next(x for x in (await client.get('/api/crm/funnels')).json()['funnels'] if x['name'] == 'B2B demo pipeline')
    ld = await lead(client, name='Sara', phone='+971500000005', funnelId=f['id'])
    r = (await client.post(f"/api/crm/leads/{ld['id']}/stage", json={'stage': 'demo_held'})).json()
    assert r['stage'] == 'demo_held'
    out = await db.one('select stage, source from lead_outcome where lead_id = $1', [ld['id']])
    assert out == {'stage': 'meeting_attended', 'source': 'crm'}
    await client.post(f"/api/crm/leads/{ld['id']}/stage", json={'stage': 'proposal'})  # the team's own stage: no outcome
    assert (await db.one('select count(*)::int as n from lead_outcome where lead_id = $1', [ld['id']]))['n'] == 1


async def test_calls_move_leads_forward_by_milestone_never_back(client, db):
    f = next(x for x in (await client.get('/api/crm/funnels')).json()['funnels'] if x['name'] == 'B2B demo pipeline')
    ld = await lead(client, name='Hadi', phone='+971500000006', funnelId=f['id'])
    row = await db.one('select * from lead where id = $1', [ld['id']])
    row = await leads.advance(db, row, ('meeting_booked', 'qualified', 'contacted'), note='call', actor='pipeline')
    assert row['stage'] == 'demo_booked'
    row = await leads.advance(db, row, ('contacted',), note='call', actor='pipeline')
    assert row['stage'] == 'demo_booked'
    won = await leads.set_stage(db, ld['id'], 'closed_won')
    assert (await leads.advance(db, won, ('qualified',), note='call', actor='pipeline'))['stage'] == 'closed_won'
    # A funnel without a qualified stage falls back to contacted.
    two = (await client.post('/api/crm/funnels', json={'name': 'Short', 'stages': [{'label': 'New', 'milestone': 'new'}, {'label': 'Called', 'milestone': 'contacted'}]})).json()
    s = await lead(client, name='Lina', phone='+971500000007', funnelId=two['id'])
    srow = await db.one('select * from lead where id = $1', [s['id']])
    assert (await leads.advance(db, srow, ('qualified', 'contacted'), note='call', actor='pipeline'))['stage'] == 'called'


async def test_campaigns_only_call_callable_stages(client, db):
    f = next(x for x in (await client.get('/api/crm/funnels')).json()['funnels'] if x['name'] == 'B2B demo pipeline')
    a = await lead(client, name='Callable', phone='+971500000008', funnelId=f['id'], stage='qualified')
    b = await lead(client, name='Handled', phone='+971500000009', funnelId=f['id'], stage='proposal')
    sql = leads.eligibility_sql(False, 3, await funnels.blocked_stages(db))
    ids = {r['id'] for r in await db.query(f'select l.id from lead l where {sql}')}
    assert a['id'] in ids and b['id'] not in ids
    lst = (await client.get(f"/api/crm/leads?funnel={f['id']}&eligible=true")).json()
    assert a['id'] in {x['id'] for x in lst['items']} and b['id'] not in {x['id'] for x in lst['items']}


async def test_removing_a_stage_with_leads_needs_a_remap(client, db):
    f = next(x for x in (await client.get('/api/crm/funnels')).json()['funnels'] if x['name'] == 'B2B demo pipeline')
    stages = [s for s in f['stages'] if s['key'] != 'proposal']
    r = await client.put(f"/api/crm/funnels/{f['id']}", json={'stages': stages})
    assert r.status_code == 409 and 'Proposal sent (2)' in r.json()['message']
    ok = (await client.put(f"/api/crm/funnels/{f['id']}", json={'stages': stages, 'remap': {'proposal': 'negotiation'}})).json()
    assert 'proposal' not in ok['byStage'] and ok['byStage']['negotiation'] == 2
    ev = await db.one("select detail from lead_event where type = 'remap' order by id desc limit 1")
    assert ev['detail']['from'] == 'proposal' and ev['detail']['to'] == 'negotiation'


async def test_deleting_a_funnel_moves_its_leads_by_milestone(client, db):
    short = next(x for x in (await client.get('/api/crm/funnels')).json()['funnels'] if x['name'] == 'Short')
    assert (await client.delete(f"/api/crm/funnels/{short['id']}")).status_code == 409
    assert (await client.delete('/api/crm/funnels/fn_default')).status_code == 400
    assert (await client.delete(f"/api/crm/funnels/{short['id']}?moveTo=fn_default")).json() == {'ok': True}
    moved = await db.one("select funnel_id, stage from lead where first_name = 'Lina'")
    assert moved == {'funnel_id': 'fn_default', 'stage': 'contacted'}


async def test_moving_a_lead_keeps_its_milestone(client):
    f = next(x for x in (await client.get('/api/crm/funnels')).json()['funnels'] if x['name'] == 'B2B demo pipeline')
    ld = await lead(client, name='Yara', phone='+971500000010', stage='meeting_booked')
    moved = (await client.patch(f"/api/crm/leads/{ld['id']}", json={'funnelId': f['id']})).json()
    assert moved['funnelId'] == f['id'] and moved['stage'] == 'demo_booked'


async def test_the_report_follows_leads_through_the_stages(client, db):
    f = (await client.post('/api/crm/funnels', json={'template': 'b2b_demo', 'name': 'Report test'})).json()
    ids = [(await lead(client, name=f'R{i}', phone=f'+97150000010{i}', funnelId=f['id']))['id'] for i in range(4)]
    for i in ids[:3]:
        await client.post(f'/api/crm/leads/{i}/stage', json={'stage': 'contacted'})
    await client.post(f'/api/crm/leads/{ids[0]}/stage', json={'stage': 'demo_booked'})
    await client.post(f'/api/crm/leads/{ids[0]}/stage', json={'stage': 'closed_won'})
    await client.post(f'/api/crm/leads/{ids[1]}/stage', json={'stage': 'closed_lost'})
    rep = (await client.get(f"/api/crm/funnels/{f['id']}/report?range=30")).json()
    by = {s['key']: s for s in rep['stages']}
    assert rep['cohort'] == 4 and by['new']['reached'] == 4 and by['contacted']['reached'] == 3 and by['contacted']['conv'] == 0.75
    assert by['demo_booked']['reached'] == 1 and by['closed_won']['reached'] == 1 and by['closed_won']['now'] == 1
    assert by['contacted']['lostFrom'] == 1 and by['closed_lost']['now'] == 1 and by['closed_lost']['conv'] is None
    assert rep['overall'] == {'open': 2, 'won': 1, 'lost': 1, 'winRate': 0.5}
    assert rep['sources'] == [{'source': 'manual', 'n': 4, 'won': 1}]
    assert (await client.get(f"/api/crm/funnels/{f['id']}/report?range=7")).status_code == 400


async def test_the_default_can_move(client):
    f = next(x for x in (await client.get('/api/crm/funnels')).json()['funnels'] if x['name'] == 'Report test')
    d = (await client.post(f"/api/crm/funnels/{f['id']}/default")).json()
    assert d['isDefault']
    lst = (await client.get('/api/crm/funnels')).json()['funnels']
    assert [x['id'] for x in lst if x['isDefault']] == [f['id']]
