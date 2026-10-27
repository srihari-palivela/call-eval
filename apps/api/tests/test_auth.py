# Users and access over HTTP: open until the first owner, then sessions, invitations, roles and their
# permissions on every route, API tokens, CSRF protection, owner rules, and the audit log.

import httpx
import pytest

from calleval.analytics.meta import seed_taxonomy
from calleval.auth import POLICY, store
from calleval.config import config
from calleval.server import build_app

pytestmark = pytest.mark.asyncio(loop_scope='session')
CONSOLE = {'x-calleval-client': 'console'}
PW = 'correct horse battery'


@pytest.fixture(scope='module')
async def app(db):
    await seed_taxonomy(db)
    return build_app(db)


def browser(app) -> httpx.AsyncClient:
    """A client with its own cookie jar, like one person's browser (https, as PUBLIC_URL makes the cookie Secure)."""
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='https://test', headers=CONSOLE)


@pytest.fixture(scope='module')
async def owner(app):
    async with browser(app) as c:
        yield c


def _routes(routes, out):
    for r in routes:
        if type(r).__name__ == '_IncludedRouter':
            _routes(r.original_router.routes, out)
        elif getattr(r, 'path', '').startswith('/api'):
            out |= {f'{m} {r.path}' for m in r.methods if m != 'HEAD'}
    return out


async def test_every_api_route_names_a_permission(app):
    routes = _routes(app.routes, set())
    assert routes - set(POLICY) == set(), 'routes without a permission'
    assert set(POLICY) - routes == set(), 'permissions for routes that no longer exist'


async def test_open_until_the_first_owner(app, owner):
    s = (await owner.get('/api/auth/status')).json()
    assert s['signedIn'] and s['setupRequired'] and not s['setupNeedsToken'] and s['me']['via'] == 'open'
    meta = (await owner.get('/api/meta')).json()
    assert meta['me']['role'] == 'owner' and 'users:manage' in meta['me']['permissions']
    bad = await owner.post('/api/auth/setup', json={'email': 'hana@example.com', 'name': 'Hana', 'password': 'short'})
    assert bad.status_code == 400 and '12 to 256 characters' in bad.json()['message']
    me = (await owner.post('/api/auth/setup', json={'email': 'Hana@Example.com', 'name': 'Hana', 'password': PW})).json()
    assert me['email'] == 'hana@example.com' and me['role'] == 'owner' and me['via'] == 'session'
    assert (await owner.post('/api/auth/setup', json={'email': 'x@example.com', 'name': 'X', 'password': PW})).status_code == 409


async def test_sign_in_is_required_once_a_user_exists(app, owner):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='https://test') as anon:
        assert (await anon.get('/api/meta')).status_code == 401
        assert (await anon.get('/%61pi/meta')).status_code == 401
        s = (await anon.get('/api/auth/status')).json()
        assert s == {'signedIn': False, 'me': None, 'setupRequired': False, 'setupNeedsToken': False, 'signupOpen': False}
        assert (await anon.get('/healthz')).status_code == 200
    me = (await owner.get('/api/meta')).json()['me']
    assert me['via'] == 'session' and me['email'] == 'hana@example.com'


async def test_changes_with_a_session_need_the_console_header(app, owner):
    cookie = owner.cookies.get(store.SESSION_COOKIE)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='https://test', cookies={store.SESSION_COOKIE: cookie}) as forged:
        r = await forged.put('/api/settings', json={'goodLine': 71})
        assert r.status_code == 403 and 'X-CallEval-Client' in r.json()['message']
        assert (await forged.get('/api/settings')).status_code == 200  # reading needs no header
    assert (await owner.put('/api/settings', json={'goodLine': 71})).status_code == 200


async def test_wrong_passwords_are_counted_and_limited(app, db):
    async with browser(app) as c:
        r = await c.post('/api/auth/login', json={'email': 'hana@example.com', 'password': 'nope nope nope'})
        assert r.status_code == 401 and r.json()['message'] == 'Wrong email or password'
        assert (await c.post('/api/auth/login', json={'email': 'nobody@example.com', 'password': PW})).status_code == 401
        for _ in range(store.MAX_FAILS_PER_EMAIL):
            await c.post('/api/auth/login', json={'email': 'locked@example.com', 'password': 'nope nope nope'})
        assert (await c.post('/api/auth/login', json={'email': 'locked@example.com', 'password': 'nope nope nope'})).status_code == 429
        ok = await c.post('/api/auth/login', json={'email': 'HANA@example.com', 'password': PW})
        assert ok.status_code == 200 and ok.json()['role'] == 'owner'
    failed = await db.one("select count(*)::int as n from audit_event where action = 'auth.login_failed' and target = 'hana@example.com'")
    assert failed['n'] == 1


async def invite(owner, app, email: str, role: str) -> httpx.AsyncClient:
    inv = (await owner.post('/api/access/invites', json={'email': email, 'role': role})).json()
    assert inv['url'].startswith('https://evals.example.com/app/#accept?token=') and inv['role'] == role
    token = inv['url'].split('token=')[1]
    c = browser(app)
    info = (await c.get(f'/api/auth/invites/{token}')).json()
    assert info == {'email': email, 'role': role, 'kind': 'invite', 'expiresAt': info['expiresAt']}
    me = (await c.post(f'/api/auth/invites/{token}/accept', json={'name': email.split('@')[0].title(), 'password': PW})).json()
    assert me['role'] == role and me['via'] == 'session'
    assert (await c.get(f'/api/auth/invites/{token}')).status_code == 404  # used
    return c


async def test_roles_decide_what_each_route_allows(app, owner, db):
    viewer = await invite(owner, app, 'vic@example.com', 'viewer')
    sales = await invite(owner, app, 'sam@example.com', 'sales_manager')
    try:
        assert (await viewer.get('/api/matrix')).status_code == 200
        r = await viewer.get('/api/calls')
        assert r.status_code == 403 and r.json()['message'] == 'Your role (Viewer) can’t do this: it needs “Read calls”.'
        assert (await viewer.get('/api/crm/leads')).status_code == 403  # a route from an included router
        assert (await viewer.get('/api/access')).status_code == 403
        assert (await sales.put('/api/settings', json={'goodLine': 72})).status_code == 403
        assert (await sales.put('/api/business', json={'company': {'name': 'Acme'}})).status_code == 200
        assert 'campaigns:start' in (await sales.get('/api/auth/me')).json()['permissions']
        assert [r['id'] for r in (await sales.get('/api/auth/roles')).json()] == ['sales_manager', 'viewer']
        # The co-pilot needs both its domain permission and copilot:use.
        r = await viewer.post('/api/taxonomy/copilot', json={'mode': 'review'})
        assert r.status_code == 403 and 'Edit taxonomy drafts' in r.json()['message']
    finally:
        await viewer.aclose()
        await sales.aclose()


async def test_reviews_carry_the_reviewers_identity(app, owner, db):
    await db.query("insert into calls (call_id, provider, external_id, started_at, status, source) values ('rv1', 'demo', 'rv1', now(), 'scored', 'demo')")
    reviewer = await invite(owner, app, 'rita@example.com', 'reviewer')
    try:
        r = await reviewer.post('/api/calls/rv1/labels', json={'metrics': {'trel': 80}, 'reviewer': 'someone else'})
        assert r.status_code == 200
        row = await db.one("select reviewer from review_label where call_id = 'rv1'")
        assert row['reviewer'] == 'rita@example.com'
        assert (await reviewer.post('/api/calls/rv1/reevaluate')).status_code == 403
    finally:
        await reviewer.aclose()


async def test_owner_rules_and_disabling(app, owner):
    admin = await invite(owner, app, 'ada@example.com', 'admin')
    try:
        acc = (await admin.get('/api/access')).json()
        users = {u['email']: u for u in acc['users']}
        assert {r['id'] for r in acc['roles']} == {'owner', 'admin', 'qa_lead', 'sales_manager', 'reviewer', 'viewer'}
        assert any(p['id'] == 'campaigns:start' and p['risky'] for p in acc['permissions'])
        hana, vic = users['hana@example.com'], users['vic@example.com']
        assert (await admin.patch(f"/api/access/users/{hana['id']}", json={'role': 'viewer'})).status_code == 403
        assert (await admin.patch(f"/api/access/users/{vic['id']}", json={'role': 'owner'})).status_code == 403
        assert (await admin.post('/api/access/invites', json={'email': 'o2@example.com', 'role': 'owner'})).status_code == 403
        r = await owner.patch(f"/api/access/users/{hana['id']}", json={'role': 'admin'})
        assert r.status_code == 409 and 'last owner' in r.json()['message']
        # Disabling signs the user out at once.
        rita = users['rita@example.com']
        assert (await admin.patch(f"/api/access/users/{rita['id']}", json={'status': 'disabled'})).json()['status'] == 'disabled'
        async with browser(app) as c:
            assert (await c.post('/api/auth/login', json={'email': 'rita@example.com', 'password': PW})).status_code == 401
    finally:
        await admin.aclose()


async def test_api_tokens_never_exceed_their_maker(app, owner):
    t = (await owner.post('/api/auth/tokens', json={'name': 'BI export', 'role': 'viewer', 'expiresDays': 90})).json()
    assert t['token'].startswith('ce_') and t['prefix'] == t['token'][:10] and t['role'] == 'viewer'
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='https://test', headers={'authorization': f"Bearer {t['token']}"}) as bot:
        assert (await bot.get('/api/matrix')).status_code == 200
        assert (await bot.get('/api/calls')).status_code == 403
        assert (await bot.get('/api/auth/me')).json()['via'] == 'token'
        # A token can't mint tokens, and needs no console header (it isn't a cookie).
        assert (await bot.post('/api/auth/tokens', json={'name': 'x'})).status_code == 403
    mine = (await owner.get('/api/auth/tokens')).json()
    assert [x['name'] for x in mine] == ['BI export'] and 'token' not in mine[0]
    assert (await owner.delete(f"/api/auth/tokens/{t['id']}")).json() == {'ok': True}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='https://test', headers={'authorization': f"Bearer {t['token']}"}) as bot:
        assert (await bot.get('/api/matrix')).status_code == 401
    assert (await owner.post('/api/auth/tokens', json={'name': 'x', 'expiresDays': 7})).status_code == 400


async def test_the_env_token_is_still_an_owner(app, monkeypatch):
    monkeypatch.setattr(config, 'api_token', 'sekret')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='https://test') as c:
        me = (await c.get('/api/auth/me', headers={'authorization': 'Bearer sekret'})).json()
        assert me['via'] == 'env' and me['role'] == 'owner'
        assert (await c.get('/api/meta?token=sekret')).status_code == 200
        assert (await c.post('/api/demo/seed?token=sekret')).status_code == 401


async def test_password_changes_and_reset_links(app, owner):
    async with browser(app) as other:
        await other.post('/api/auth/login', json={'email': 'hana@example.com', 'password': PW})
        assert (await other.get('/api/auth/me')).status_code == 200
        bad = await owner.put('/api/auth/me', json={'currentPassword': 'wrong wrong wrong', 'newPassword': 'a new long passphrase'})
        assert bad.status_code == 400
        ok = await owner.put('/api/auth/me', json={'currentPassword': PW, 'newPassword': 'a new long passphrase', 'name': 'Hana K'})
        assert ok.json()['name'] == 'Hana K'
        assert (await other.get('/api/auth/me')).status_code == 401  # other sessions end
    assert (await owner.get('/api/auth/me')).status_code == 200  # this one stays
    users = {u['email']: u for u in (await owner.get('/api/access')).json()['users']}
    reset = (await owner.post(f"/api/access/users/{users['sam@example.com']['id']}/reset")).json()
    assert reset['kind'] == 'reset' and '#accept?token=rst_' in reset['url']
    token = reset['url'].split('token=')[1]
    async with browser(app) as sam:
        assert (await sam.post(f'/api/auth/invites/{token}/accept', json={'password': 'sams brand new passphrase'})).status_code == 200
        assert (await sam.post('/api/auth/login', json={'email': 'sam@example.com', 'password': PW})).status_code == 401
        assert (await sam.post('/api/auth/login', json={'email': 'sam@example.com', 'password': 'sams brand new passphrase'})).status_code == 200


async def test_changes_are_in_the_audit_log(app, owner):
    log = (await owner.get('/api/access/audit?action=settings')).json()
    done = [e for e in log if e['status'] == 200]
    assert done and all(e['action'] == 'PUT /api/settings' and e['actor'] == 'hana@example.com' for e in done)
    denied = (await owner.get('/api/access/audit?actor=sam')).json()
    assert any(e['action'] == 'PUT /api/settings' and e['status'] == 403 for e in denied)
    actions = {e['action'] for e in (await owner.get('/api/access/audit?limit=500')).json()}
    assert {'auth.setup', 'auth.accept', 'auth.login', 'auth.login_failed', 'POST /api/access/invites'} <= actions
    async with browser(app) as out:
        await out.post('/api/auth/login', json={'email': 'hana@example.com', 'password': 'a new long passphrase'})
        assert (await out.post('/api/auth/logout')).json() == {'ok': True}
        assert (await out.get('/api/meta')).status_code == 401
