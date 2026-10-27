# Self-serve workspaces: sign-up with email verification (SELF_SIGNUP=on), password resets by email, the
# workspace itself, and the setup checklist that takes a new workspace to its first scored call and beyond.

from __future__ import annotations

import secrets
from typing import Any

from . import billing
from .auth import store
from .auth.passwords import check_policy
from .auth.store import _email, _hash, _name, client_ip, console_link
from .config import config
from .connectors.registry import CALL_PROVIDERS
from .js import iso
from .lib import email
from .lib.errors import HttpStatusError, http_error
from .lib.ids import new_id
from .lib.settings import get_settings
from .tenancy import in_workspace

PLANS = ('payg', 'starter', 'growth', 'scale', 'enterprise')
VERIFY_HOURS = 48
SIGNUPS_PER_IP_HOUR, RESETS_PER_EMAIL_HOUR = 10, 3


async def _recent(db, action: str, *, ip: str | None = None, email_: str | None = None) -> int:
    r = await db.one("""select count(*)::int as n from audit_event where action = $1 and at > now() - interval '1 hour'
                        and ($2::text is null or ip = $2) and ($3::text is null or target = $3)""", [action, ip, email_])
    return r['n']


async def _send_verification(db, user: dict, request: Any) -> dict:
    token = 'ver_' + secrets.token_urlsafe(24)
    await db.query("update user_invite set revoked_at = now() where user_id = $1 and kind = 'verify' and used_at is null and revoked_at is null", [user['id']])
    await db.query(f"""insert into user_invite (id, token_hash, email, role, kind, user_id, created_by, expires_at, workspace_id)
                       values ($1, $2, $3, $4, 'verify', $5, 'self-service', now() + interval '{VERIFY_HOURS} hours', $6)""",
                   [new_id('inv'), _hash(token), user['email'], user['role'], user['id'], user['workspace_id']])
    link = console_link(f'verify?token={token}', request)
    sent = await email.send(user['email'], 'Verify your email', f"""Hi {user['name'] or 'there'},

Confirm your email to open your Call Evaluation workspace:

{link}

The link works once and expires in {VERIFY_HOURS} hours. If you didn't sign up, ignore this email.""")
    return {'sent': sent, 'email': user['email'], **({} if sent else {'devLink': link})}


async def signup(db, body: dict, request: Any) -> dict:
    """A new workspace with its first owner, unverified until the emailed link is opened. `db` without row-level security."""
    if not config.self_signup:
        raise http_error(403, 'Sign-up is closed on this installation; ask an owner for an invitation')
    if not isinstance(body, dict):
        raise http_error(400, 'Expected an object')
    ip = client_ip(request)
    if await _recent(db, 'auth.signup', ip=ip) >= SIGNUPS_PER_IP_HOUR:
        raise http_error(429, 'Too many sign-ups from here. Try again in an hour.')
    e = _email(body.get('email'))
    name = _name(body.get('name'))
    ws_name = str(body.get('workspaceName') or '').strip()[:120]
    if not name or not ws_name:
        raise http_error(400, 'Your name and your company’s name are needed')
    password = check_policy(body.get('password'), e)
    plan = body.get('plan') if body.get('plan') in PLANS else None
    existing = await db.one('select * from app_user where lower(email) = $1', [e])
    await store.audit(db, None, 'auth.signup', target=e, status=200, ip=ip)
    if existing:
        # Never say whether an email has an account: an unverified one gets a fresh link, a verified one a note.
        if not existing['email_verified_at']:
            return await _send_verification(db, existing, request)
        await email.send(e, 'You already have an account', f"""Someone tried to sign up with this email, which already has an account.

Sign in: {console_link('', request)}
Forgotten your password? Use "Forgot your password?" on the sign-in page.""")
        return {'sent': email.configured(), 'email': e}
    ws = new_id('ws')
    await db.query(f"insert into workspace (id, name, plan, status, trial_ends_at) values ($1, $2, 'growth', 'trial', now() + interval '{int(config.trial_days)} days')",
                   [ws, ws_name])
    with in_workspace(ws):
        await billing.start_trial(db, ws, plan)
    user = await store.create_user(db, e, name, 'owner', password, workspace=ws, verified=False)
    return await _send_verification(db, user, request)


async def verify(db, token: Any) -> dict:
    r = await db.one("""select * from user_invite where token_hash = $1 and kind = 'verify' and used_at is null and revoked_at is null
                        and expires_at > now()""", [_hash(str(token or ''))])
    if not r:
        raise http_error(404, 'This link is invalid, used or expired; sign in to get a new one')
    await db.query('update app_user set email_verified_at = coalesce(email_verified_at, now()), updated_at = now() where id = $1', [r['user_id']])
    await db.query('update user_invite set used_at = now() where id = $1', [r['id']])
    return await db.one('select * from app_user where id = $1', [r['user_id']])


async def resend(db, email_: Any, request: Any) -> None:
    e = str(email_ or '').strip().lower()
    u = await db.one("select * from app_user where lower(email) = $1 and email_verified_at is null and status = 'active'", [e])
    if u and await _recent(db, 'auth.resend', email_=e) < RESETS_PER_EMAIL_HOUR:
        await store.audit(db, None, 'auth.resend', target=e, ip=client_ip(request), workspace=u['workspace_id'])
        await _send_verification(db, u, request)


async def forgot(db, email_: Any, request: Any) -> None:
    """A password-reset link by email, for a verified, active account (and nothing said either way)."""
    e = str(email_ or '').strip().lower()
    u = await db.one("select * from app_user where lower(email) = $1 and email_verified_at is not null and status = 'active'", [e])
    if not u or await _recent(db, 'auth.forgot', email_=e) >= RESETS_PER_EMAIL_HOUR:
        return
    await store.audit(db, None, 'auth.forgot', target=e, ip=client_ip(request), workspace=u['workspace_id'])
    r = await store.create_reset(db, store.SELF, u['id'], request)
    await email.send(e, 'Reset your password', f"""Someone asked to reset the password for your Call Evaluation account.

Choose a new password: {r['url']}

The link works once and expires in {store.RESET_HOURS} hours. If it wasn't you, ignore this email: your password stays as it is.""")


# ---------- The workspace ----------

async def workspace_dto(db, ws: str) -> dict:
    w = await db.one('select * from workspace where id = $1', [ws])
    if not w:
        raise http_error(404, 'Workspace not found')
    members = await db.one("select count(*)::int as n from app_user where workspace_id = $1 and status = 'active'", [ws])
    return {'id': w['id'], 'name': w['name'], 'plan': w['plan'], 'status': w['status'], 'trialEndsAt': iso(w['trial_ends_at']),
            'createdAt': iso(w['created_at']), 'members': members['n'], 'billing': config.billing}


async def rename(db, ws: str, body: dict) -> dict:
    name = str((body or {}).get('name') or '').strip()[:120]
    if not name:
        raise http_error(400, 'A workspace needs a name')
    await db.query('update workspace set name = $2, updated_at = now() where id = $1', [ws, name])
    return await workspace_dto(db, ws)


# ---------- Setup checklist ----------

# Features a plan must include, and the first plan that does (for the "Upgrade to" hint).
_UPGRADE = {'copilot': 'starter', 'crm': 'growth', 'campaigns': 'growth', 'lead_finder': 'growth', 'improvement': 'growth'}


async def _available(db, feature: str | None) -> tuple[bool, str | None]:
    if not feature:
        return True, None
    try:
        await billing.require_feature(db, feature)
        return True, None
    except HttpStatusError:
        return False, _UPGRADE.get(feature)


async def _exists(db, sql: str, params: list | None = None) -> bool:
    return bool((await db.one(f'select exists ({sql}) as x', params or []))['x'])


async def setup_dto(db, ws: str) -> dict:
    from . import compliance
    from .business import get_business
    w = await db.one('select setup, status from workspace where id = $1', [ws])
    settings = await get_settings(db)
    stored = await db.one("select value from app_setting where key = 'framework'")
    biz = await get_business(db)
    users = await db.one("select count(*)::int as n from app_user where workspace_id = $1 and status = 'active'", [ws])
    invites = await db.one("select count(*)::int as n from user_invite where workspace_id = $1 and kind = 'invite'", [ws])
    providers = list(CALL_PROVIDERS)
    steps: list[tuple] = [
        # id, title, detail, page, done, optional, copilot, feature
        ('workspace', 'Create the workspace', 'Your account and your company’s workspace.', 'access', True, False, False, None),
        ('business', 'Describe the business', 'The co-pilot reads your website and drafts the profile; you confirm each section.', 'business',
         bool(biz['company'].get('name') or biz.get('onboardedAt')), False, True, None),
        ('connect', 'Connect the voice platform', 'Add your ElevenLabs or Retell key; the connection test lists your agents.', 'integrations',
         await _exists(db, 'select 1 from integration where enabled and provider = any($1::text[])', [providers]), False, True, None),
        ('calls', 'Bring in calls', 'Backfill the last 30 days, upload recordings, or load demo data to look around.', 'integrations',
         await _exists(db, "select 1 from calls where status = 'scored' and source <> 'demo'"), False, False, None),
        ('taxonomy', 'Define the taxonomy', 'The personas and journeys your calls are scored by; the co-pilot drafts them.', 'taxonomy',
         await _exists(db, "select 1 from taxonomy_version where status = 'active' and coalesce(approved_by, '') <> 'framework'"), False, True, None),
        ('scoring', 'Check the scoring model', 'The weights, the Good line and the gates, explained.', 'scoring', bool(stored), False, False, None),
        ('team', 'Invite the team', 'Give each person a role; viewers are free.', 'access', users['n'] > 1 or invites['n'] > 0, True, False, None),
        ('crm', 'Turn on the CRM and design funnels', 'Your stages in your words; the co-pilot drafts the funnel.', 'funnels',
         bool(settings['features'].get('crm')) and await _exists(db, 'select 1 from funnel'), False, True, 'crm'),
        ('leads', 'Find leads', 'Search Apollo from your ideal customer profile, or import a CSV.', 'leads',
         await _exists(db, 'select 1 from lead'), True, True, 'lead_finder'),
        ('compliance', 'Check calling compliance', 'Calling hours, retry limits, consent and the do-not-call list for each country you call.', 'compliance',
         await compliance.blocking_issues(db) == 0, False, True, 'campaigns'),
        ('campaign', 'Run a test campaign', 'One lead, your own number: hear the agent before the real list.', 'campaigns',
         await _exists(db, 'select 1 from campaign'), False, True, 'campaigns'),
        ('improvement', 'Choose what the improvement loop may do', 'Off, propose each change, or promote verified wins.', 'business',
         'improvement' in ((stored or {}).get('value') or {}).get('features', {}), False, True, 'improvement'),
        ('plan', 'Choose a plan', 'Or pay as you go; set a spend cap.', 'billing', not billing.enabled() or w['status'] == 'active', False, True, None),
    ]
    out = []
    for id, title, detail, page, done, optional, copilot, feature in steps:
        ok, upgrade = await _available(db, feature)
        out.append({'id': id, 'title': title, 'detail': detail, 'page': page, 'done': bool(done), 'optional': optional, 'copilot': copilot,
                    'available': ok, **({'upgrade': upgrade} if upgrade else {})})
    required = [s for s in out if not s['optional'] and s['available']]
    return {'steps': out, 'done': sum(1 for s in required if s['done']), 'total': len(required), 'dismissed': bool((w['setup'] or {}).get('dismissed'))}


async def dismiss_setup(db, ws: str, dismissed: Any) -> dict:
    await db.query("update workspace set setup = setup || jsonb_build_object('dismissed', $2::boolean), updated_at = now() where id = $1", [ws, bool(dismissed)])
    return await setup_dto(db, ws)
