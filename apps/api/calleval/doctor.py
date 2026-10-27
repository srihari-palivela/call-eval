# `calleval doctor`: go-live checks against the real services, changing nothing. The database (migrations, the
# app role, row-level security actually binding), configuration, the Claude key, email, Stripe, and a connection
# test of every enabled voice integration in every workspace. Exit code 1 when anything fails.

from __future__ import annotations

from .config import config, llm_enabled
from .db.migrations import MIGRATIONS
from .lib.log import err_msg

PASS, WARN, FAIL = 'pass', 'warn', 'fail'


async def run(db, email_to: str | None = None) -> list[tuple[str, str, str]]:
    out: list[tuple[str, str, str]] = []

    def add(status: str, check: str, detail: str) -> None:
        out.append((status, check, detail))

    sys_db = db.as_system()
    # Database
    v = await sys_db.one('select max(version) as v from schema_migrations')
    latest = max(m['version'] for m in MIGRATIONS)
    add(PASS if v['v'] == latest else FAIL, 'database migrations', f"at version {v['v']} of {latest}")
    role = await sys_db.one("select rolsuper from pg_roles where rolname = 'calleval_app'")
    add(PASS if role and not role['rolsuper'] else FAIL, 'app database role', 'calleval_app exists, not a superuser' if role else 'calleval_app is missing')
    rls = await sys_db.one("select count(*) filter (where relrowsecurity)::int as on_, count(*)::int as n from pg_class where relname = any($1::text[])",
                           [['calls', 'lead', 'app_setting', 'job', 'integration']])
    add(PASS if rls['on_'] == rls['n'] == 5 else FAIL, 'row-level security', f"{rls['on_']} of {rls['n']} sampled tenant tables protected")
    me = await db.one('select current_user as u, (select rolsuper from pg_roles where rolname = current_user) as su, '
                      "current_setting('app.workspace_id', true) as ws")
    add(PASS if not me['su'] else FAIL, 'requests run as the app role', f"as {me['u']} in {me['ws']}")
    # Configuration
    add(PASS if config.app_secret and len(config.app_secret) >= 32 else FAIL, 'APP_SECRET', 'set (32+ characters)' if config.app_secret and len(config.app_secret) >= 32
        else 'missing or short: provider keys are encrypted with it; set a long random value and keep it')
    if (config.public_url or '').startswith('https://'):
        add(PASS, 'PUBLIC_URL', config.public_url or '')
    elif config.public_url:
        add(FAIL, 'PUBLIC_URL', f'{config.public_url} is not https: session cookies would not be marked secure')
    else:
        add(FAIL, 'PUBLIC_URL', 'not set: links in emails and the webhook addresses need it')
    add(PASS if config.demo_mode == 'off' else WARN, 'DEMO_MODE', 'off' if config.demo_mode == 'off' else 'on: anyone with settings access can load synthetic calls')
    if config.api_token:
        add(PASS if len(config.api_token) >= 32 else FAIL, 'API_TOKEN', 'set (owner-level: keep it secret)' if len(config.api_token) >= 32 else 'shorter than 32 characters')
    add(PASS if config.forwarded_allow_ips != '*' else WARN, 'FORWARDED_ALLOW_IPS', config.forwarded_allow_ips)
    users = await sys_db.one('select count(*)::int as n from app_user')
    if not config.self_signup and not config.api_token and not users['n']:
        add(FAIL, 'sign-in', 'no users yet: the app is open to anyone who can reach it; run `calleval users create`')
    # Claude
    if llm_enabled():
        try:
            from .pipeline.judge.llm import get_client
            m = await get_client().models.retrieve(config.llm.model)
            add(PASS, 'Claude', f'{m.id} reachable with the configured key')
        except Exception as e:  # noqa: BLE001
            add(FAIL, 'Claude', err_msg(e))
    else:
        add(WARN, 'Claude', 'no ANTHROPIC_API_KEY: calls are scored by the heuristic judge and the co-pilot is off')
    # Email
    from .lib import email
    if not email.configured():
        add(FAIL if config.self_signup else WARN, 'email', 'SMTP_URL not set: sign-up verification and password resets can’t be sent')
    elif email_to:
        ok = await email.send(email_to, 'Call Evaluation: test email', 'This is a test from `calleval doctor`.')
        add(PASS if ok else FAIL, 'email', f'test sent to {email_to}' if ok else 'sending failed (see the log)')
    else:
        add(PASS, 'email', 'SMTP_URL set (pass --email you@example.com to send a test)')
    # Stripe
    if config.billing:
        if not config.stripe_secret_key or not config.stripe_webhook_secret:
            add(FAIL, 'Stripe', 'BILLING is on but STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET is missing')
        else:
            try:
                from .lib.http import get_json
                await get_json('https://api.stripe.com/v1/balance', {'authorization': f'Bearer {config.stripe_secret_key}'})
                live = config.stripe_secret_key.startswith('sk_live_')
                add(PASS if live else WARN, 'Stripe', 'live key works' if live else 'test-mode key works (switch to the live key to take payments)')
            except Exception as e:  # noqa: BLE001
                add(FAIL, 'Stripe', err_msg(e))
    # Integrations, in every workspace
    from .connectors.registry import CONNECTORS, credentials_of
    from .tenancy import in_workspace
    for r in await sys_db.query("select id, workspace_id, provider, name from integration where enabled and provider in ('elevenlabs', 'retell') order by workspace_id"):
        with in_workspace(r['workspace_id']):
            row = await db.one('select * from integration where id = $1', [r['id']])
            try:
                agents = await CONNECTORS[row['provider']].list_agents(credentials_of(row))
                add(PASS, f"{r['provider']} ({r['name'] or r['id']}, {r['workspace_id']})", f'connected; {len(agents)} agents')
            except Exception as e:  # noqa: BLE001 - every failure is reported
                add(FAIL, f"{r['provider']} ({r['name'] or r['id']}, {r['workspace_id']})", err_msg(e))
    return out


def print_report(rows: list[tuple[str, str, str]]) -> bool:
    width = max(len(c) for _, c, _ in rows)
    for status, check, detail in rows:
        print(f"{status.upper():5}  {check.ljust(width)}  {detail}")
    fails = sum(1 for s, _, _ in rows if s == FAIL)
    print(f"\n{fails} failing, {sum(1 for s, _, _ in rows if s == WARN)} warnings, {sum(1 for s, _, _ in rows if s == PASS)} passing")
    return fails == 0

