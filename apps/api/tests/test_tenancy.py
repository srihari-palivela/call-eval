# Workspaces: self-serve sign-up with email verification, and isolation between companies in one installation,
# enforced by PostgreSQL row-level security (reads, writes, jobs, webhooks, caches and ids).

import json

import httpx
import psycopg
import pytest

from calleval import tenancy
from calleval.config import config
from calleval.connectors.registry import save_integration
from calleval.lib.settings import clear_settings_cache
from calleval.server import build_app
from calleval.tenancy import in_workspace

from .fixtures import drain, retell_call, retell_signature

pytestmark = pytest.mark.asyncio(loop_scope='session')
CONSOLE = {'x-calleval-client': 'console'}
PW = 'a long enough passphrase'


@pytest.fixture(scope='module', autouse=True)
def self_serve():
    mp = pytest.MonkeyPatch()
    mp.setattr(config, 'self_signup', True)
    yield
    mp.undo()
    clear_settings_cache()


@pytest.fixture(scope='module')
async def app(db):
    return build_app(db)


def browser(app) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='https://test', headers=CONSOLE)


async def sign_up(app, email: str, company: str) -> tuple[httpx.AsyncClient, dict]:
    c = browser(app)
    r = (await c.post('/api/auth/signup', json={'email': email, 'name': 'Founder', 'password': PW, 'workspaceName': company, 'plan': 'starter'})).json()
    assert r['sent'] is False and r['email'] == email and '/app/#verify?token=ver_' in r['devLink']  # no SMTP here: a development link
    blocked = await c.post('/api/auth/login', json={'email': email, 'password': PW})
    assert blocked.status_code == 403 and 'Verify your email' in blocked.json()['message']
    me = (await c.post('/api/auth/verify', json={'token': r['devLink'].split('token=')[1]})).json()
    assert me['role'] == 'owner' and me['workspace']['name'] == company and me['workspace']['status'] == 'trial'
    return c, me


@pytest.fixture(scope='module')
async def two(app):
    a, me_a = await sign_up(app, 'ana@alpha.example', 'Alpha Homes')
    b, me_b = await sign_up(app, 'bo@beta.example', 'Beta Solar')
    yield a, me_a, b, me_b
    await a.aclose()
    await b.aclose()


async def test_health_answers_without_a_workspace(app):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='https://test') as c:
        assert (await c.get('/healthz')).json() == {'ok': True}


async def test_sign_up_opens_its_own_workspace(app, two):
    a, me_a, b, me_b = two
    assert me_a['workspace']['id'] != me_b['workspace']['id'] and me_a['workspace']['id'].startswith('ws_')
    s = (await browser(app).get('/api/auth/status')).json()
    assert s['signupOpen'] is True and s['setupRequired'] is False and s['signedIn'] is False  # never open in self-serve mode
    ws = (await a.get('/api/workspace')).json()
    assert ws['name'] == 'Alpha Homes' and ws['members'] == 1 and ws['trialEndsAt']
    assert (await a.patch('/api/workspace', json={'name': 'Alpha Homes FZ'})).json()['name'] == 'Alpha Homes FZ'


async def test_a_second_sign_up_with_the_same_email_says_nothing_new(app, two):
    async with browser(app) as c:
        r = (await c.post('/api/auth/signup', json={'email': 'ana@alpha.example', 'name': 'X', 'password': PW, 'workspaceName': 'Copy'})).json()
        assert r == {'sent': False, 'email': 'ana@alpha.example'}
        assert (await c.post('/api/auth/forgot', json={'email': 'nobody@nowhere.example'})).json() == {'sent': True}
        assert (await c.post('/api/auth/forgot', json={'email': 'ana@alpha.example'})).json() == {'sent': True}
        assert (await c.post('/api/auth/verify', json={'token': 'ver_nope'})).status_code == 404


async def test_each_workspace_sees_only_its_own_data(app, two, db):
    a, _, b, me_b = two
    assert (await a.put('/api/settings', json={'goodLine': 66})).json()['goodLine'] == 66
    assert (await b.get('/api/settings')).json()['goodLine'] == 70
    await a.put('/api/settings', json={'features': {'crm': True}})
    await b.put('/api/settings', json={'features': {'crm': True}})
    lead = (await a.post('/api/crm/leads', json={'name': 'Omar', 'phone': '+971501234567', 'consent': 'opt_in'})).json()
    assert (await b.get('/api/crm/leads')).json()['total'] == 0
    assert (await b.get(f"/api/crm/leads/{lead['id']}")).status_code == 404
    # The same phone may be a lead in both workspaces: uniqueness is per workspace.
    assert (await b.post('/api/crm/leads', json={'name': 'Omar', 'phone': '+971501234567'})).json()['created'] is True
    await a.post('/api/taxonomy/draft', json={'from': 'active'})
    assert (await a.get('/api/taxonomy')).json()['draft'] is not None and (await b.get('/api/taxonomy')).json()['draft'] is None
    assert len((await a.get('/api/access')).json()['users']) == 1 and (await a.get('/api/access')).json()['users'][0]['email'] == 'ana@alpha.example'


async def test_the_database_refuses_crossing_workspaces(two, db):
    _, me_a, _, me_b = two
    wa, wb = me_a['workspace']['id'], me_b['workspace']['id']
    with in_workspace(wa):
        assert await db.query('select id from lead where workspace_id = $1', [wb]) == []  # asked by name, still hidden
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            await db.query("insert into lead (id, source, first_name, workspace_id) values ('ld_x', 'api', 'X', $1)", [wb])
    with pytest.raises(tenancy.NoWorkspace):
        await db.query('select 1 from lead')  # self-serve mode: no workspace, no tenant data
    assert len(await db.as_system().query('select distinct workspace_id from lead')) == 2


async def test_demo_data_ids_never_collide_and_jobs_run_in_their_workspace(app, two, db):
    a, me_a, b, me_b = two
    for c in (a, b):
        assert (await c.post('/api/demo/seed', json={'count': 20, 'days': 3})).status_code == 200
    ran = await drain(db)
    assert {r['workspace'] for r in ran if r['kind'] == 'demo_seed'} == {me_a['workspace']['id'], me_b['workspace']['id']}
    assert all(r['ok'] for r in ran), ran
    ta, tb = (await a.get('/api/meta')).json()['totals'], (await b.get('/api/meta')).json()['totals']
    assert ta['calls'] == tb['calls'] == 20 and ta['scored'] == 20
    ids = {r['workspace_id']: set() for r in await db.as_system().query('select distinct workspace_id from calls')}
    for r in await db.as_system().query('select call_id, workspace_id from calls'):
        ids[r['workspace_id']].add(r['call_id'])
    assert not ids[me_a['workspace']['id']] & ids[me_b['workspace']['id']]  # same demo seed, distinct ids


async def test_webhooks_land_in_the_integrations_workspace(app, two, db, monkeypatch):
    _, me_a, b, me_b = two
    with in_workspace(me_b['workspace']['id']):
        row = await save_integration(db, None, {'provider': 'retell', 'name': 'Retell', 'apiKey': 'key_beta'})
    body = json.dumps({'event': 'call_analyzed', 'call': retell_call('call_wb')})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='https://test') as hook:
        r = await hook.post(f"/webhooks/retell/{row['id']}", content=body, headers={'x-retell-signature': retell_signature('key_beta', body), 'content-type': 'application/json'})
    assert r.json() == {'ok': True, 'queued': True}
    job = await db.as_system().one("select workspace_id from job where kind = 'ingest_call' order by created_at desc limit 1")
    assert job['workspace_id'] == me_b['workspace']['id']


async def test_the_setup_checklist_follows_the_workspace(two):
    a, _, b, _ = two
    s = (await b.get('/api/setup')).json()
    ids = [x['id'] for x in s['steps']]
    assert ids[:5] == ['workspace', 'business', 'connect', 'calls', 'taxonomy'] and len(ids) == 13
    done = {x['id']: x['done'] for x in s['steps']}
    assert done['workspace'] and done['connect'] and not done['taxonomy']  # Beta has a Retell integration (previous test)
    assert (await b.post('/api/setup/dismiss', json={'dismissed': True})).json()['dismissed'] is True
    assert (await a.get('/api/setup')).json()['dismissed'] is False
