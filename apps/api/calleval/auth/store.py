# Accounts, sessions, API tokens, invitations and the audit log.
#
# Who is asking (a Principal) comes from, in order: a bearer token (the API_TOKEN environment token, or a
# personal API token), or the session cookie. Before any user exists, without API_TOKEN and without self-serve
# sign-up, the app is open: everyone is an owner, as it was before accounts. Secrets (session cookies, API
# tokens, invitation and verification links) are random and only their SHA-256 is stored.
#
# Accounts belong to one workspace. These tables have no row-level security (sign-in happens before any
# workspace is known), so every query here names the workspace it means.

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from dataclasses import dataclass, replace
from typing import Any

from ..config import config
from ..js import iso, js_json
from ..lib.errors import http_error
from ..lib.ids import new_id
from ..lib.log import log
from ..tenancy import DEFAULT_WORKSPACE
from .passwords import check_policy, hash_password, verify_password
from .roles import ALL, PERMISSIONS, ROLE_IDS, permissions_of, roles_dto, within

SESSION_COOKIE = 'ce_session'
SESSION_DAYS, IDLE_DAYS = 30, 7
INVITE_DAYS, RESET_HOURS = 7, 24
LOGIN_WINDOW_MIN, MAX_FAILS_PER_EMAIL, MAX_FAILS_PER_IP = 15, 8, 30
TOKEN_PREFIX = 'ce_'
_EMAIL = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')


@dataclass(frozen=True)
class Principal:
    id: str | None
    email: str | None
    name: str
    role: str
    permissions: frozenset[str]
    via: str  # session | token | env | open (and cli, for the command line; self, for a self-service request)
    session_id: str | None = None
    token_id: str | None = None
    workspace_id: str = DEFAULT_WORKSPACE
    workspace: dict | None = None  # {id, name, plan, status}

    @property
    def label(self) -> str:
        """How the principal appears in histories (lead events, reviews, decisions, the audit log)."""
        if self.via == 'open':
            return 'console'
        if self.via == 'env':
            return 'API_TOKEN'
        if self.via == 'cli':
            return 'command line'
        if self.via == 'self':
            return 'self-service'
        if self.via == 'token':
            return f'{self.email} (token {self.name})' if self.email else f'token {self.name}'
        return self.email or self.name

    def can(self, permission: str) -> bool:
        return permission in self.permissions

    def dto(self) -> dict:
        return {'id': self.id, 'email': self.email, 'name': self.name, 'role': self.role, 'permissions': sorted(self.permissions), 'via': self.via,
                'workspace': {**self.workspace, 'billing': config.billing} if self.workspace else None}


OPEN = Principal(None, None, 'Everyone (no users yet)', 'owner', frozenset(ALL), 'open')
ENV = Principal(None, None, 'API_TOKEN', 'owner', frozenset(ALL), 'env')
CLI = Principal(None, None, 'command line', 'owner', frozenset(ALL), 'cli')
SELF = Principal(None, None, 'self-service', 'owner', frozenset(ALL), 'self')


def _hash(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def may_grant(actor: Principal, role: str) -> bool:
    """Nobody grants more than they have, and only owners make owners."""
    return role in ROLE_IDS and within(role, actor.permissions) and (role != 'owner' or actor.role == 'owner')


def client_ip(request: Any) -> str | None:
    return request.client.host if getattr(request, 'client', None) else None


# ---------- Who is asking ----------

_users_exist = False


async def users_exist(db) -> bool:
    """Once a user exists, sign-in is required for good (the last owner can't be removed)."""
    global _users_exist
    if not _users_exist:
        _users_exist = bool(await db.one('select 1 from app_user limit 1'))
    return _users_exist


def forget_users_cache() -> None:
    global _users_exist
    _users_exist = False


async def open_mode(db) -> bool:
    return not config.self_signup and not config.api_token and not await users_exist(db)


async def workspace_of(db, ws: str) -> dict | None:
    return await db.one('select id, name, plan, status from workspace where id = $1', [ws])


async def resolve(db, request: Any) -> Principal | None:
    """The principal behind a request, or None when nobody valid is signed in."""
    authz = request.headers.get('authorization') or ''
    bearer = authz[7:].strip() if authz[:7].lower() == 'bearer ' else None
    if bearer is None and request.method == 'GET':
        bearer = request.query_params.get('token')  # media elements can't send headers
    if bearer:
        if config.api_token and hmac.compare_digest(bearer.encode(), config.api_token.encode()):
            return replace(ENV, workspace=await workspace_of(db, DEFAULT_WORKSPACE))
        p = await _from_token(db, bearer) if bearer.startswith(TOKEN_PREFIX) else None
        if p:
            return p
    cookie = request.cookies.get(SESSION_COOKIE)
    if cookie:
        p = await _from_session(db, cookie)
        if p:
            return p
    return replace(OPEN, workspace=await workspace_of(db, DEFAULT_WORKSPACE)) if await open_mode(db) else None


async def _from_session(db, cookie: str) -> Principal | None:
    sid = _hash(cookie)
    r = await db.one(
        f"""select u.id, u.email, u.name, u.role, u.workspace_id, w.name as ws_name, w.plan, w.status as ws_status
            from user_session s join app_user u on u.id = s.user_id join workspace w on w.id = u.workspace_id
            where s.id = $1 and s.revoked_at is null and s.expires_at > now() and s.last_seen_at > now() - interval '{IDLE_DAYS} days'
              and u.status = 'active'""", [sid])
    if not r:
        return None
    # Sliding idle expiry, written at most every five minutes.
    await db.query("update user_session set last_seen_at = now() where id = $1 and last_seen_at < now() - interval '5 minutes'", [sid])
    await db.query("update app_user set last_seen_at = now() where id = $1 and (last_seen_at is null or last_seen_at < now() - interval '5 minutes')", [r['id']])
    return Principal(r['id'], r['email'], r['name'] or r['email'], r['role'], permissions_of(r['role']), 'session', session_id=sid,
                     workspace_id=r['workspace_id'], workspace=_ws(r))


def _ws(r: dict) -> dict:
    return {'id': r['workspace_id'], 'name': r['ws_name'], 'plan': r['plan'], 'status': r['ws_status']}


async def _from_token(db, token: str) -> Principal | None:
    r = await db.one(
        """select t.id, t.name, t.role, t.user_id, t.workspace_id, u.email, u.role as user_role, u.status, w.name as ws_name, w.plan, w.status as ws_status
           from api_token t left join app_user u on u.id = t.user_id join workspace w on w.id = t.workspace_id
           where t.token_hash = $1 and t.revoked_at is null and (t.expires_at is null or t.expires_at > now())""", [_hash(token)])
    if not r or (r['user_id'] and r['status'] != 'active'):
        return None
    await db.query("update api_token set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '5 minutes')", [r['id']])
    # A token never does more than the person who made it can do now.
    creator = permissions_of(r['user_role']) if r['user_id'] else frozenset(ALL)
    role = r['role'] if r['role'] != 'owner' or not r['user_id'] or r['user_role'] == 'owner' else r['user_role']
    return Principal(r['user_id'], r['email'], r['name'], role, permissions_of(role) & creator, 'token', token_id=r['id'],
                     workspace_id=r['workspace_id'], workspace=_ws(r))


# ---------- Sessions ----------

async def start_session(db, user_id: str, request: Any) -> str:
    token = secrets.token_urlsafe(32)
    await db.query(f"insert into user_session (id, user_id, expires_at, ip, user_agent) values ($1, $2, now() + interval '{SESSION_DAYS} days', $3, $4)",
                   [_hash(token), user_id, client_ip(request), (request.headers.get('user-agent') or '')[:300]])
    await db.query('update app_user set last_login_at = now(), last_seen_at = now() where id = $1', [user_id])
    return token


def set_session_cookie(response: Any, token: str, request: Any) -> None:
    secure = (config.public_url or '').startswith('https://') or request.url.scheme == 'https'
    response.set_cookie(SESSION_COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True, samesite='lax', secure=secure, path='/')


def clear_session_cookie(response: Any) -> None:
    response.delete_cookie(SESSION_COOKIE, path='/')


async def end_session(db, p: Principal) -> None:
    if p.session_id:
        await db.query('update user_session set revoked_at = now() where id = $1', [p.session_id])


async def revoke_sessions(db, user_id: str, keep: str | None = None) -> int:
    rows = await db.query('update user_session set revoked_at = now() where user_id = $1 and revoked_at is null and id is distinct from $2 returning id',
                          [user_id, keep])
    return len(rows)


# ---------- Users ----------

def user_dto(r: dict, sessions: int = 0) -> dict:
    return {'id': r['id'], 'email': r['email'], 'name': r['name'], 'role': r['role'], 'status': r['status'], 'createdAt': iso(r['created_at']),
            'lastLoginAt': iso(r['last_login_at']), 'lastSeenAt': iso(r['last_seen_at']), 'sessions': sessions}


def _email(v: Any) -> str:
    e = str(v or '').strip().lower()
    if not _EMAIL.match(e) or len(e) > 254:
        raise http_error(400, 'Enter a valid email address')
    return e


def _name(v: Any) -> str:
    return str(v or '').strip()[:120]


async def principal_of(db, r: dict, via: str = 'session') -> Principal:
    return Principal(r['id'], r['email'], r['name'] or r['email'], r['role'], permissions_of(r['role']), via, workspace_id=r['workspace_id'],
                     workspace=await workspace_of(db, r['workspace_id']))


async def create_user(db, email: Any, name: Any, role: str, password: Any, *, workspace: str = DEFAULT_WORKSPACE, verified: bool = True) -> dict:
    e = _email(email)
    if role not in ROLE_IDS:
        raise http_error(400, f"role is one of {', '.join(ROLE_IDS)}")
    pw = check_policy(password, e)
    if await db.one('select 1 from app_user where lower(email) = $1', [e]):
        raise http_error(409, 'A user with this email already exists')
    uid = new_id('usr')
    await db.query(f"""insert into app_user (id, email, name, role, password_hash, password_changed_at, workspace_id, email_verified_at)
                       values ($1,$2,$3,$4,$5, now(), $6, {'now()' if verified else 'null'})""",
                   [uid, e, _name(name), role, await hash_password(pw), workspace])
    global _users_exist
    _users_exist = True
    return await db.one('select * from app_user where id = $1', [uid])


async def login(db, email: Any, password: Any, request: Any) -> dict:
    e = str(email or '').strip().lower()
    ip = client_ip(request)
    fails = await db.one(
        f"""select count(*) filter (where detail->>'email' = $1)::int as by_email, count(*) filter (where ip = $2)::int as by_ip
            from audit_event where action = 'auth.login_failed' and at > now() - interval '{LOGIN_WINDOW_MIN} minutes'""", [e, ip])
    if fails['by_email'] >= MAX_FAILS_PER_EMAIL or fails['by_ip'] >= MAX_FAILS_PER_IP:
        raise http_error(429, f'Too many sign-in attempts. Try again in {LOGIN_WINDOW_MIN} minutes.')
    r = await db.one("select * from app_user where lower(email) = $1 and status = 'active'", [e])
    ok = await verify_password(str(password or ''), r['password_hash'] if r else None)
    if not ok or not r:
        # Recorded in the account's workspace when the email has one, so its admins see attempts on their users.
        await audit(db, None, 'auth.login_failed', target=e, status=401, ip=ip, detail={'email': e}, workspace=r['workspace_id'] if r else None)
        raise http_error(401, 'Wrong email or password')
    if not r['email_verified_at']:
        raise http_error(403, 'Verify your email first: open the link we sent, or ask for a new one')
    await audit(db, await principal_of(db, r), 'auth.login', target=e, status=200, ip=ip)
    return r


async def update_me(db, p: Principal, body: dict) -> dict:
    if p.via != 'session' or not p.id:
        raise http_error(400, 'Sign in as a user to change your account')
    r = await db.one('select * from app_user where id = $1', [p.id])
    if 'name' in body:
        await db.query('update app_user set name = $2, updated_at = now() where id = $1', [p.id, _name(body.get('name'))])
    if body.get('newPassword') is not None:
        if not await verify_password(str(body.get('currentPassword') or ''), r['password_hash']):
            raise http_error(400, 'Your current password is wrong')
        pw = check_policy(body['newPassword'], r['email'])
        await db.query('update app_user set password_hash = $2, password_changed_at = now(), updated_at = now() where id = $1', [p.id, await hash_password(pw)])
        await revoke_sessions(db, p.id, keep=p.session_id)
    return await db.one('select * from app_user where id = $1', [p.id])


async def _active_owners(db, besides: str, ws: str) -> int:
    return (await db.one("select count(*)::int as n from app_user where role = 'owner' and status = 'active' and id <> $1 and workspace_id = $2",
                         [besides, ws]))['n']


async def update_user(db, actor: Principal, id: str, body: dict) -> dict:
    r = await db.one('select * from app_user where id = $1 and workspace_id = $2', [id, actor.workspace_id])
    if not r:
        raise http_error(404, 'User not found')
    if r['role'] == 'owner' and actor.role != 'owner':
        raise http_error(403, 'Only an owner can change an owner')
    role = body.get('role', r['role'])
    status = body.get('status', r['status'])
    if role != r['role'] and not may_grant(actor, role):
        raise http_error(403, 'You can only give roles within your own' + (' (only owners make owners)' if role == 'owner' else ''))
    if status not in ('active', 'disabled'):
        raise http_error(400, 'status is active or disabled')
    if r['role'] == 'owner' and r['status'] == 'active' and (role != 'owner' or status != 'active') and not await _active_owners(db, id, actor.workspace_id):
        raise http_error(409, 'This is the last owner; make someone else an owner first')
    await db.query('update app_user set role = $2, status = $3, name = $4, updated_at = now() where id = $1',
                   [id, role, status, _name(body['name']) if 'name' in body else r['name']])
    if status == 'disabled' or role != r['role']:
        await revoke_sessions(db, id)
    return user_dto(await db.one('select * from app_user where id = $1', [id]))


# ---------- Invitations and password resets ----------

def invite_dto(r: dict, url: str | None = None) -> dict:
    out = {'id': r['id'], 'email': r['email'], 'role': r['role'], 'kind': r['kind'], 'createdAt': iso(r['created_at']), 'expiresAt': iso(r['expires_at']),
           'createdBy': r['created_by']}
    return {**out, 'url': url} if url else out


def console_link(fragment: str, request: Any) -> str:
    """A link into the console (served at /app/). Tokens go in the fragment, so they never reach a server log."""
    base = (config.public_url or (str(request.base_url) if request is not None else f'http://localhost:{config.port}')).rstrip('/')
    return f'{base}/app/#{fragment}'


def link_for(token: str, request: Any) -> str:
    return console_link(f'accept?token={token}', request)


async def create_invite(db, actor: Principal, email: Any, role: Any, request: Any) -> dict:
    e = _email(email)
    if not may_grant(actor, str(role)):
        raise http_error(403, 'You can only invite people to roles within your own' + (' (only owners invite owners)' if role == 'owner' else ''))
    if await db.one('select 1 from app_user where lower(email) = $1', [e]):
        raise http_error(409, 'A user with this email already exists')
    token = 'inv_' + secrets.token_urlsafe(24)
    iid = new_id('inv')
    await db.query(f"""insert into user_invite (id, token_hash, email, role, kind, created_by, expires_at, workspace_id)
                       values ($1,$2,$3,$4,'invite',$5, now() + interval '{INVITE_DAYS} days', $6)""",
                   [iid, _hash(token), e, role, actor.label, actor.workspace_id])
    return invite_dto(await db.one('select * from user_invite where id = $1', [iid]), link_for(token, request))


async def create_reset(db, actor: Principal, user_id: str, request: Any) -> dict:
    r = await db.one('select * from app_user where id = $1', [user_id])
    if not r or (actor.via not in ('cli', 'self') and r['workspace_id'] != actor.workspace_id):
        raise http_error(404, 'User not found')
    if r['role'] == 'owner' and actor.role != 'owner':
        raise http_error(403, 'Only an owner can reset an owner’s password')
    token = 'rst_' + secrets.token_urlsafe(24)
    iid = new_id('inv')
    await db.query("update user_invite set revoked_at = now() where user_id = $1 and kind = 'reset' and used_at is null and revoked_at is null", [user_id])
    await db.query(f"""insert into user_invite (id, token_hash, email, role, kind, user_id, created_by, expires_at, workspace_id)
                       values ($1,$2,$3,$4,'reset',$5,$6, now() + interval '{RESET_HOURS} hours', $7)""",
                   [iid, _hash(token), r['email'], r['role'], user_id, actor.label, r['workspace_id']])
    return invite_dto(await db.one('select * from user_invite where id = $1', [iid]), link_for(token, request))


async def read_invite(db, token: str) -> dict:
    r = await db.one('select * from user_invite where token_hash = $1 and used_at is null and revoked_at is null and expires_at > now()', [_hash(token)])
    if not r:
        raise http_error(404, 'This link is invalid, used or expired; ask for a new one')
    return r


async def accept_invite(db, token: str, body: dict) -> dict:
    inv = await read_invite(db, token)
    if inv['kind'] not in ('invite', 'reset'):
        raise http_error(404, 'This link is invalid, used or expired; ask for a new one')
    if inv['kind'] == 'reset':
        u = await db.one("select * from app_user where id = $1 and status = 'active'", [inv['user_id']])
        if not u:
            raise http_error(404, 'This account is disabled')
        pw = check_policy(body.get('password'), u['email'])
        await db.query('update app_user set password_hash = $2, password_changed_at = now(), updated_at = now() where id = $1', [u['id'], await hash_password(pw)])
        await revoke_sessions(db, u['id'])
    else:
        u = await create_user(db, inv['email'], body.get('name'), inv['role'], body.get('password'), workspace=inv['workspace_id'])
    await db.query('update user_invite set used_at = now() where id = $1', [inv['id']])
    return await db.one('select * from app_user where id = $1', [u['id']])


async def revoke_invite(db, actor: Principal, id: str) -> None:
    await db.query('update user_invite set revoked_at = now() where id = $1 and used_at is null and workspace_id = $2', [id, actor.workspace_id])


# ---------- API tokens ----------

def token_dto(r: dict, token: str | None = None) -> dict:
    out = {'id': r['id'], 'name': r['name'], 'prefix': r['prefix'], 'role': r['role'], 'userId': r['user_id'], 'userEmail': r.get('email'),
           'createdAt': iso(r['created_at']), 'expiresAt': iso(r['expires_at']), 'lastUsedAt': iso(r['last_used_at'])}
    return {**out, 'token': token} if token else out


async def list_tokens(db, ws: str, user_id: str | None = None) -> list[dict]:
    rows = await db.query(
        """select t.*, u.email from api_token t left join app_user u on u.id = t.user_id
           where t.revoked_at is null and (t.expires_at is null or t.expires_at > now()) and ($1::text is null or t.user_id = $1) and t.workspace_id = $2
           order by t.created_at desc""", [user_id, ws])
    return [token_dto(r) for r in rows]


async def create_token(db, actor: Principal, body: dict) -> dict:
    if actor.via not in ('session', 'env', 'open'):
        raise http_error(403, 'API tokens are made by people signed in, not by other tokens')
    name = str(body.get('name') or '').strip()[:80]
    if not name:
        raise http_error(400, 'Give the token a name, such as what will use it')
    role = body.get('role') or actor.role
    if not may_grant(actor, role):
        raise http_error(403, 'A token can’t have a role beyond yours')
    days = body.get('expiresDays')
    if days not in (None, 30, 90, 365):
        raise http_error(400, 'expiresDays is 30, 90, 365 or null (never)')
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    tid = new_id('tok')
    await db.query(
        f"""insert into api_token (id, name, token_hash, prefix, user_id, role, expires_at, workspace_id)
            values ($1,$2,$3,$4,$5,$6, {'null' if days is None else f"now() + interval '{int(days)} days'"}, $7)""",
        [tid, name, _hash(token), token[:10], actor.id, role, actor.workspace_id])
    r = await db.one('select t.*, u.email from api_token t left join app_user u on u.id = t.user_id where t.id = $1', [tid])
    return token_dto(r, token)


async def revoke_token(db, actor: Principal, id: str) -> None:
    r = await db.one('select * from api_token where id = $1 and workspace_id = $2', [id, actor.workspace_id])
    if not r:
        raise http_error(404, 'Token not found')
    if r['user_id'] != actor.id and not actor.can('users:manage'):
        raise http_error(403, 'You can only revoke your own tokens')
    await db.query('update api_token set revoked_at = now() where id = $1', [id])


# ---------- Access overview and audit ----------

async def access_dto(db, ws: str) -> dict:
    users = await db.query('select * from app_user where workspace_id = $1 order by created_at', [ws])
    sessions = {r['user_id']: r['n'] for r in await db.query(
        f"""select s.user_id, count(*)::int as n from user_session s join app_user u on u.id = s.user_id
            where u.workspace_id = $1 and s.revoked_at is null and s.expires_at > now() and s.last_seen_at > now() - interval '{IDLE_DAYS} days'
            group by s.user_id""", [ws])}
    invites = await db.query("""select * from user_invite where workspace_id = $1 and kind in ('invite', 'reset') and used_at is null and revoked_at is null
                                and expires_at > now() order by created_at desc""", [ws])
    return {'users': [user_dto(u, sessions.get(u['id'], 0)) for u in users], 'invites': [invite_dto(i) for i in invites],
            'tokens': await list_tokens(db, ws), 'roles': roles_dto(), 'permissions': PERMISSIONS}


async def audit(db, p: Principal | None, action: str, *, target: str | None = None, status: int | None = None, ip: str | None = None,
                detail: dict | None = None, workspace: str | None = None) -> None:
    try:
        await db.query('insert into audit_event (actor_id, actor, action, target, status, ip, detail, workspace_id) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)',
                       [p.id if p else None, p.label if p else 'anonymous', action, target, status, ip, js_json(detail or {}),
                        p.workspace_id if p else workspace])
    except Exception as e:  # noqa: BLE001 - a failed audit write never fails the request it describes
        log.error('audit write failed', {'action': action, 'error': str(e)})


async def audit_list(db, q: dict, ws: str) -> list[dict]:
    conds, params = ['workspace_id = $1'], [ws]
    for k, col in (('actor', 'actor'), ('action', 'action')):
        if q.get(k):
            params.append(f"%{re.sub(r'[%_]', '', q[k])}%")
            conds.append(f'{col} ilike ${len(params)}')
    try:
        limit = min(500, max(1, int(q.get('limit') or 100)))
    except ValueError:
        limit = 100
    rows = await db.query(f"select * from audit_event where {' and '.join(conds)} order by at desc, id desc limit {limit}", params)
    return [{'id': r['id'], 'at': iso(r['at']), 'actor': r['actor'], 'actorId': r['actor_id'], 'action': r['action'], 'target': r['target'], 'status': r['status'],
             'ip': r['ip'], 'detail': r['detail']} for r in rows]
