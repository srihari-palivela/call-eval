# Entry point. `calleval serve` runs the API with in-process workers and scheduler (RUN_WORKER=false
# for a web-only instance); `calleval worker` runs just the workers and scheduler, to scale them
# separately against the same PostgreSQL; `calleval migrate` and `calleval seed-demo` are one-offs;
# `calleval users` creates the first owner on a server, lists users and makes password-reset links.

from __future__ import annotations

import argparse
import asyncio
import json
import signal
import sys

from .tenancy import DEFAULT_WORKSPACE, in_workspace


async def _with_db(fn):
    from .analytics.meta import seed_taxonomy
    from .db import get_db

    db = await get_db()
    try:
        # One-off commands act on the default workspace (users and doctor go across workspaces on purpose).
        with in_workspace(DEFAULT_WORKSPACE):
            await seed_taxonomy(db)
            return await fn(db)
    finally:
        await db.close()


async def _worker() -> None:
    from .analytics.meta import seed_taxonomy
    from .connectors.registry import bootstrap_from_env
    from .db import get_db
    from .jobs.worker import start_scheduler, start_workers, stop_workers
    from .lib.log import log

    db = await get_db()
    with in_workspace(DEFAULT_WORKSPACE):
        await seed_taxonomy(db)
        await bootstrap_from_env(db)
    start_workers(db)
    stop_scheduler = start_scheduler(db)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    await stop.wait()
    log.info('shutting down', {'sig': 'signal'})
    stop_scheduler()
    await stop_workers()
    await db.close()


async def _users(a: argparse.Namespace, db) -> None:
    from .auth import store
    from .lib.errors import HttpStatusError

    try:
        if a.ucmd == 'create':
            if a.password_stdin:
                password = sys.stdin.readline().rstrip('\n')
            else:
                import getpass
                password = getpass.getpass('Password (12 characters or more): ')
                if getpass.getpass('Again: ') != password:
                    sys.exit('The passwords differ')
            u = await store.create_user(db.as_system(), a.email, a.name, a.role, password)
            await store.audit(db.as_system(), store.CLI, 'users.create', target=u['email'], status=200)
            print(f"created {u['role']} {u['email']}")
        elif a.ucmd == 'list':
            for u in await db.as_system().query('select email, name, role, status, last_seen_at, workspace_id from app_user order by created_at'):
                print(f"{u['email']}\t{u['role']}\t{u['status']}\t{u['workspace_id']}\t{u['name']}\t{u['last_seen_at'] or 'never'}")
        elif a.ucmd == 'reset':
            u = await db.as_system().one('select id from app_user where lower(email) = $1', [a.email.strip().lower()])
            if not u:
                sys.exit(f'No user {a.email}')
            r = await store.create_reset(db.as_system(), store.CLI, u['id'], None)
            print(f"{r['url']}\n(valid until {r['expiresAt']}; it signs out the user's other sessions once used)")
    except HttpStatusError as e:
        sys.exit(e.message)


def main(argv: list[str] | None = None) -> None:
    from .auth.roles import ROLE_IDS

    p = argparse.ArgumentParser(prog='calleval', description='Call evaluation API')
    sub = p.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('serve', help='API, workers and scheduler (workers off with RUN_WORKER=false)')
    s.add_argument('--reload', action='store_true', help='restart on code changes (development)')
    s.add_argument('--no-worker', action='store_true', help='API only')
    sub.add_parser('worker', help='workers and scheduler only')
    sub.add_parser('migrate', help='apply database migrations')
    d = sub.add_parser('seed-demo', help='load synthetic demo calls through the real pipeline')
    d.add_argument('--count', type=int, default=5000)
    d.add_argument('--days', type=int, default=90)
    u = sub.add_parser('users', help='create the first owner, list users, make a password-reset link')
    us = u.add_subparsers(dest='ucmd', required=True)
    uc = us.add_parser('create', help='create a user (prompts for the password)')
    uc.add_argument('--email', required=True)
    uc.add_argument('--name', default='')
    uc.add_argument('--role', default='owner', choices=list(ROLE_IDS))
    uc.add_argument('--password-stdin', action='store_true', help='read the password from standard input')
    us.add_parser('list', help='list users')
    dr = sub.add_parser('doctor', help='go-live checks against the real services (changes nothing)')
    dr.add_argument('--email', help='send a test email to this address')
    ur = us.add_parser('reset', help='print a password-reset link')
    ur.add_argument('--email', required=True)
    a = p.parse_args(argv)

    from .config import config

    if a.cmd == 'serve':
        import os

        import uvicorn
        if a.no_worker:
            os.environ['RUN_WORKER'] = 'false'
            config.run_worker = False
        uvicorn.run('calleval.server:create_app', factory=True, host=config.host, port=config.port, reload=a.reload,
                    log_level='warning', proxy_headers=True, forwarded_allow_ips=config.forwarded_allow_ips)
    elif a.cmd == 'worker':
        asyncio.run(_worker())
    elif a.cmd == 'migrate':
        async def show(db):
            print(f'migrated ({db.kind})')
        asyncio.run(_with_db(show))
    elif a.cmd == 'seed-demo':
        from .demo.seed import seed_demo

        async def seed(db):
            print(json.dumps(await seed_demo(db, count=a.count, days=a.days)))
        asyncio.run(_with_db(seed))
    elif a.cmd == 'users':
        asyncio.run(_with_db(lambda db: _users(a, db)))
    elif a.cmd == 'doctor':
        from .doctor import print_report, run

        async def check(db):
            return print_report(await run(db, a.email))
        if not asyncio.run(_with_db(check)):
            sys.exit(1)


if __name__ == '__main__':
    main(sys.argv[1:])
