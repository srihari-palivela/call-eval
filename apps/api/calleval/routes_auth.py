# Signing in and signing up, your own account and API tokens, the workspace and its setup checklist, and
# (users:manage) users, invitations and the audit log.
#
# Routes used before anyone is signed in work on the database without row-level security (`_sys`): accounts
# carry their workspace and every query names it. Signed-in routes run in the caller's workspace.

from __future__ import annotations

import hmac

from fastapi import APIRouter, Request

from . import billing, workspaces
from .auth import store
from .auth.store import Principal, client_ip
from .config import config
from .js import iso
from .lib.errors import http_error
from .web import J, JsResponse, body_json, q

router = APIRouter()


def _db(req: Request):
    return req.app.state.db


def _sys(req: Request):
    return req.app.state.db.as_system()


def _me(req: Request) -> Principal:
    return req.state.principal


async def _signed_in(req: Request, user: dict, action: str) -> JsResponse:
    """Start a session for the user and answer with who they are, the cookie set."""
    db = _sys(req)
    token = await store.start_session(db, user['id'], req)
    p = await store.principal_of(db, user)
    await store.audit(db, p, action, target=user['email'], status=200, ip=client_ip(req))
    res = J(p.dto())
    store.set_session_cookie(res, token, req)
    return res


# ---------- Signing in and signing up ----------
@router.get('/api/auth/status')
async def auth_status(req: Request):
    exist = await store.users_exist(_sys(req))
    p = getattr(req.state, 'principal', None)
    setup = not exist and not config.self_signup
    return J({'signedIn': p is not None, 'me': p.dto() if p else None, 'setupRequired': setup, 'setupNeedsToken': setup and bool(config.api_token),
              'signupOpen': config.self_signup})


@router.post('/api/auth/setup')
async def auth_setup(req: Request):
    """The first owner of a single-company installation. Open to anyone while no user exists, unless API_TOKEN is
    set, which it then needs. With self-serve sign-up on, workspaces start through sign-up instead."""
    db = _sys(req)
    if config.self_signup:
        raise http_error(409, 'Create an account through sign-up')
    if await store.users_exist(db):
        raise http_error(409, 'The first owner already exists; sign in instead')
    b = await body_json(req) or {}
    if config.api_token and not hmac.compare_digest(str(b.get('setupToken') or '').encode(), config.api_token.encode()):
        raise http_error(403, 'Enter the API_TOKEN set on the server to create the first owner')
    user = await store.create_user(db, b.get('email'), b.get('name'), 'owner', b.get('password'))
    return await _signed_in(req, user, 'auth.setup')


@router.post('/api/auth/signup')
async def auth_signup(req: Request):
    return J(await workspaces.signup(_sys(req), await body_json(req) or {}, req))


@router.post('/api/auth/verify')
async def auth_verify(req: Request):
    user = await workspaces.verify(_sys(req), (await body_json(req) or {}).get('token'))
    return await _signed_in(req, user, 'auth.verify')


@router.post('/api/auth/resend')
async def auth_resend(req: Request):
    await workspaces.resend(_sys(req), (await body_json(req) or {}).get('email'), req)
    return J({'sent': True})


@router.post('/api/auth/forgot')
async def auth_forgot(req: Request):
    await workspaces.forgot(_sys(req), (await body_json(req) or {}).get('email'), req)
    return J({'sent': True})


@router.post('/api/auth/login')
async def auth_login(req: Request):
    db = _sys(req)
    b = await body_json(req) or {}
    user = await store.login(db, b.get('email'), b.get('password'), req)
    token = await store.start_session(db, user['id'], req)
    res = J((await store.principal_of(db, user)).dto())
    store.set_session_cookie(res, token, req)
    return res


@router.get('/api/auth/invites/{token}')
async def auth_invite(token: str, req: Request):
    r = await store.read_invite(_sys(req), token)
    if r['kind'] not in ('invite', 'reset'):
        raise http_error(404, 'This link is invalid, used or expired; ask for a new one')
    return J({'email': r['email'], 'role': r['role'], 'kind': r['kind'], 'expiresAt': iso(r['expires_at'])})


@router.post('/api/auth/invites/{token}/accept')
async def auth_accept(token: str, req: Request):
    user = await store.accept_invite(_sys(req), token, await body_json(req) or {})
    return await _signed_in(req, user, 'auth.accept')


@router.post('/api/auth/logout')
async def auth_logout(req: Request):
    p = _me(req)
    await store.end_session(_sys(req), p)
    await store.audit(_sys(req), p, 'auth.logout', status=200, ip=client_ip(req))
    res = J({'ok': True})
    store.clear_session_cookie(res)
    return res


# ---------- Your account ----------
@router.get('/api/auth/me')
async def auth_me(req: Request):
    return J(_me(req).dto())


@router.put('/api/auth/me')
async def put_me(req: Request):
    user = await store.update_me(_db(req), _me(req), await body_json(req) or {})
    return J({**(await store.principal_of(_db(req), user)).dto(), 'via': _me(req).via})


@router.get('/api/auth/roles')
async def grantable_roles(req: Request):
    """The roles you may give a token (or, with users:manage, a person): those within your own."""
    from .auth.roles import roles_dto
    return J([r for r in roles_dto() if store.may_grant(_me(req), r['id'])])


@router.get('/api/auth/tokens')
async def my_tokens(req: Request):
    p = _me(req)
    return J(await store.list_tokens(_db(req), p.workspace_id, p.id) if p.id else [])


@router.post('/api/auth/tokens')
async def new_token(req: Request):
    await billing.require_feature(_db(req), 'api_tokens')
    return J(await store.create_token(_db(req), _me(req), await body_json(req) or {}))


@router.delete('/api/auth/tokens/{id}')
async def del_token(id: str, req: Request):
    await store.revoke_token(_db(req), _me(req), id)
    return J({'ok': True})


# ---------- The workspace and its setup checklist ----------
@router.get('/api/workspace')
async def get_workspace(req: Request):
    return J(await workspaces.workspace_dto(_db(req), _me(req).workspace_id))


@router.patch('/api/workspace')
async def patch_workspace(req: Request):
    return J(await workspaces.rename(_db(req), _me(req).workspace_id, await body_json(req) or {}))


@router.get('/api/setup')
async def get_setup(req: Request):
    return J(await workspaces.setup_dto(_db(req), _me(req).workspace_id))


@router.post('/api/setup/dismiss')
async def dismiss_setup(req: Request):
    return J(await workspaces.dismiss_setup(_db(req), _me(req).workspace_id, (await body_json(req) or {}).get('dismissed', True)))


# ---------- Users and access ----------
@router.get('/api/access')
async def access(req: Request):
    return J(await store.access_dto(_db(req), _me(req).workspace_id))


@router.post('/api/access/invites')
async def invite(req: Request):
    b = await body_json(req) or {}
    await billing.check_seat(_db(req), str(b.get('role') or ''))
    return J(await store.create_invite(_db(req), _me(req), b.get('email'), b.get('role'), req))


@router.delete('/api/access/invites/{id}')
async def del_invite(id: str, req: Request):
    await store.revoke_invite(_db(req), _me(req), id)
    return J({'ok': True})


@router.patch('/api/access/users/{id}')
async def patch_user(id: str, req: Request):
    return J(await store.update_user(_db(req), _me(req), id, await body_json(req) or {}))


@router.post('/api/access/users/{id}/reset')
async def reset_link(id: str, req: Request):
    return J(await store.create_reset(_db(req), _me(req), id, req))


@router.delete('/api/access/users/{id}/sessions')
async def sign_out_everywhere(id: str, req: Request):
    if not await _db(req).one('select 1 from app_user where id = $1 and workspace_id = $2', [id, _me(req).workspace_id]):
        raise http_error(404, 'User not found')
    return J({'ok': True, 'revoked': await store.revoke_sessions(_db(req), id)})


@router.get('/api/access/audit')
async def audit_log(req: Request):
    return J(await store.audit_list(_db(req), q(req), _me(req).workspace_id))
