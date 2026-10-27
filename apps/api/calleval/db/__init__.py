# Database access. Production runs on PostgreSQL (DATABASE_URL). Without it, an embedded PostgreSQL
# (pgserver: real Postgres binaries installed with the Python package) runs from PG_DIR, so local
# development and tests need nothing else installed and use the same SQL dialect.
#
# SQL uses PostgreSQL's native $1, $2 placeholders (psycopg's raw cursor). Rows come back as dicts;
# numeric values as floats, timestamps as UTC datetimes, jsonb as Python data.
#
# Workspaces: each connection, when checked out, takes the non-superuser role calleval_app and the current
# workspace (tenancy.workspace_id()), so PostgreSQL's row-level security shows and accepts only that
# workspace's rows. `as_system()` gives the same database without that, for work across workspaces (the job
# queue, the scheduler, sign-in and webhook routing) and migrations.

from __future__ import annotations

import asyncio
import atexit
import os
import shutil
import tempfile
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, TypeVar

import psycopg
from psycopg.rows import dict_row
from psycopg.types.numeric import FloatLoader
from psycopg_pool import AsyncConnectionPool

from ..config import config
from ..js import UNDEFINED, iso, js_json
from .migrations import MIGRATIONS

__all__ = ['Db', 'Row', 'open_db', 'get_db', 'set_db', 'migrate', 'insert_many', 'json_', 'iso']

Row = dict[str, Any]
T = TypeVar('T')

# numeric (avg(), sum() over numerics, percentile_cont on numerics) as float, as node-pg callers used Number().
psycopg.adapters.register_loader('numeric', FloatLoader)


APP_ROLE = 'calleval_app'


class Db:
    """A pool (or, inside a transaction, one connection) with the query helpers the app uses."""

    def __init__(self, kind: str, pool: AsyncConnectionPool | None = None, conn: psycopg.AsyncConnection | None = None,
                 on_close: Callable[[], Awaitable[None]] | None = None, system: bool = False):
        self.kind = kind
        self._pool = pool
        self._conn = conn
        self._on_close = on_close
        self.system = system

    def as_system(self) -> Db:
        """This database without row-level security: work across workspaces. Never for what a request shows a person."""
        if self._conn is not None:
            raise RuntimeError('as_system() is not available inside a transaction')
        return Db(self.kind, pool=self._pool, system=True)

    async def _enter(self, conn: psycopg.AsyncConnection) -> None:
        if self.system:
            await conn.execute("select set_config('role', 'none', false)")
        else:
            from ..tenancy import workspace_id
            await conn.execute("select set_config('role', $1, false), set_config('app.workspace_id', $2, false)", [APP_ROLE, workspace_id()])

    async def _run(self, conn: psycopg.AsyncConnection, sql: str, params: list | tuple | None) -> list[Row]:
        cur = await conn.execute(sql, list(params) if params else None)
        return await cur.fetchall() if cur.description else []

    async def query(self, sql: str, params: list | tuple | None = None) -> list[Row]:
        if self._conn is not None:
            return await self._run(self._conn, sql, params)
        assert self._pool is not None
        async with self._pool.connection() as conn:
            await self._enter(conn)
            return await self._run(conn, sql, params)

    async def one(self, sql: str, params: list | tuple | None = None) -> Row | None:
        rows = await self.query(sql, params)
        return rows[0] if rows else None

    async def exec(self, sql: str) -> None:
        await self.query(sql)

    async def tx(self, fn: Callable[[Db], Awaitable[T]]) -> T:
        """Run fn in one transaction; a nested tx inside it becomes a savepoint."""
        if self._conn is not None:
            async with self._conn.transaction():
                return await fn(self)
        assert self._pool is not None
        async with self._pool.connection() as conn:
            await self._enter(conn)
            async with conn.transaction():
                return await fn(Db(self.kind, conn=conn, system=self.system))

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()
        if self._on_close is not None:
            await self._on_close()


async def _configure(conn: psycopg.AsyncConnection) -> None:
    await conn.execute("set time zone 'UTC'")


async def _reset(conn: psycopg.AsyncConnection) -> None:
    # A connection goes back to the pool with no role or workspace, whatever the last user set.
    await conn.execute('reset role')
    await conn.execute('reset app.workspace_id')


async def _open_pool(url: str, max_size: int = 10) -> AsyncConnectionPool:
    pool = AsyncConnectionPool(
        url, min_size=1, max_size=max_size, open=False, configure=_configure, reset=_reset,
        kwargs={'autocommit': True, 'row_factory': dict_row, 'cursor_factory': psycopg.AsyncRawCursor},
    )
    await pool.open(wait=True, timeout=60)
    return pool


# ---------- Embedded PostgreSQL ----------

_memory_server: Any = None
_memory_dir: str | None = None


class _LocalPostgres:
    """An embedded server from the system's PostgreSQL binaries (initdb, pg_ctl), for platforms pgserver has
    no wheel for (Linux on ARM). PG_BIN points at them when they are not on PATH (Debian:
    /usr/lib/postgresql/<version>/bin). Processes sharing a data directory share its server."""

    def __init__(self, data_dir: str, cleanup: str):
        self.dir = Path(data_dir).resolve()
        self.cleanup_mode = cleanup
        self.bin = self._find_bin()
        self.started = False
        if not (self.dir / 'PG_VERSION').exists():
            self.dir.mkdir(parents=True, exist_ok=True)
            self._run('initdb', '-D', str(self.dir), '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C')
        self.socket_dir = self._running_socket_dir()
        if self.socket_dir is None:
            # A short socket path: Unix sockets are limited to about 100 characters.
            self.socket_dir = tempfile.mkdtemp(prefix='cepg')
            self._run('pg_ctl', '-D', str(self.dir), '-l', str(self.dir / 'server.log'), '-w', 'start',
                      '-o', f"-k {self.socket_dir} -c listen_addresses='' -c timezone=UTC")
            self.started = True

    @staticmethod
    def _find_bin() -> Path:
        cands = [os.environ.get('PG_BIN') or '', *sorted(map(str, Path('/usr/lib/postgresql').glob('*/bin')), reverse=True)]
        for c in cands:
            if c and (Path(c) / 'pg_ctl').exists():
                return Path(c)
        found = shutil.which('pg_ctl')
        if found:
            return Path(found).parent
        raise RuntimeError('No embedded PostgreSQL here: install pgserver, or PostgreSQL (initdb, pg_ctl) and set PG_BIN, or set DATABASE_URL.')

    def _run(self, exe: str, *args: str) -> None:
        import subprocess
        subprocess.run([str(self.bin / exe), *args], check=True, capture_output=True)

    def _running_socket_dir(self) -> str | None:
        pid_file = self.dir / 'postmaster.pid'
        if not pid_file.exists():
            return None
        lines = pid_file.read_text().splitlines()
        try:
            os.kill(int(lines[0]), 0)
        except (ValueError, IndexError, OSError):
            return None
        return lines[4] if len(lines) > 4 and lines[4] else None

    def get_uri(self, database: str | None = None) -> str:
        return f'postgresql://postgres@/{database or "postgres"}?host={self.socket_dir}'

    def cleanup(self) -> None:
        if self.started and self.cleanup_mode == 'stop':
            try:
                self._run('pg_ctl', '-D', str(self.dir), '-m', 'fast', 'stop')
            except Exception:
                pass


def _embedded_server(data_dir: str, cleanup: str) -> Any:
    Path(data_dir).mkdir(parents=True, exist_ok=True)
    try:
        import pgserver  # imported lazily: production with DATABASE_URL never needs it
    except ImportError:
        srv = _LocalPostgres(data_dir, cleanup)
        atexit.register(srv.cleanup)
        return srv
    return pgserver.get_server(data_dir, cleanup_mode=cleanup)


def _memory_cleanup() -> None:
    global _memory_server
    if _memory_server is not None:
        try:
            _memory_server.cleanup()
        except Exception:
            pass
        _memory_server = None
    if _memory_dir:
        shutil.rmtree(_memory_dir, ignore_errors=True)


async def _open_memory() -> Db:
    """A fresh, throwaway database on a per-process embedded server (tests, one-off scripts)."""
    global _memory_server, _memory_dir
    if _memory_server is None:
        _memory_dir = tempfile.mkdtemp(prefix='calleval-pg-')
        _memory_server = await asyncio.to_thread(_embedded_server, _memory_dir, 'stop')
        atexit.register(_memory_cleanup)
    name = f'mem_{os.urandom(6).hex()}'
    admin = await psycopg.AsyncConnection.connect(_memory_server.get_uri(), autocommit=True)
    await admin.execute(f'create database {name}')
    await admin.close()
    pool = await _open_pool(_memory_server.get_uri(name), max_size=8)

    async def drop() -> None:
        conn = await psycopg.AsyncConnection.connect(_memory_server.get_uri(), autocommit=True)
        await conn.execute(f'drop database if exists {name} with (force)')
        await conn.close()

    return Db('embedded', pool=pool, on_close=drop)


async def _open_embedded(data_dir: str) -> Db:
    srv = await asyncio.to_thread(_embedded_server, str(Path(data_dir).resolve()), 'stop')

    async def stop() -> None:
        # Stop the server with the service (its own exit hook does not); a server another process still
        # uses keeps running.
        await asyncio.to_thread(srv.cleanup)

    return Db('embedded', pool=await _open_pool(srv.get_uri()), on_close=stop)


# ---------- Migrations and the process-wide handle ----------

async def migrate(db: Db) -> None:
    await db.exec('create table if not exists schema_migrations (version int primary key, applied_at timestamptz not null default now())')
    done = {int(r['version']) for r in await db.query('select version from schema_migrations')}
    for m in MIGRATIONS:
        if m['version'] in done:
            continue

        async def apply(t: Db, m: dict = m) -> None:
            await t.exec(m['sql'])
            await t.query('insert into schema_migrations (version) values ($1)', [m['version']])

        await db.tx(apply)


async def open_db(url: str | None | object = UNDEFINED, dir: str | None = None) -> Db:
    """Open and migrate. `url` defaults to DATABASE_URL; without one, `dir` (default PG_DIR) holds an
    embedded server, and dir='memory' gives a throwaway database."""
    u = config.database_url if url is UNDEFINED else url
    if u:
        db = Db('pg', pool=await _open_pool(str(u)))
    elif (dir or config.pg_dir) == 'memory':
        db = await _open_memory()
    else:
        db = await _open_embedded(dir or config.pg_dir)
    await migrate(db.as_system())
    return db


_current: Db | None = None


async def get_db() -> Db:
    global _current
    if _current is None:
        _current = await open_db()
    return _current


def set_db(db: Db | None) -> None:
    global _current
    _current = db


def insert_many(table: str, cols: list[str], rows: list[list[Any]], suffix: str = '') -> tuple[str, list[Any]]:
    """Build a multi-row INSERT for batch writes."""
    params: list[Any] = []
    values = []
    for r in rows:
        ph = []
        for v in r:
            params.append(v)
            ph.append(f'${len(params)}')
        values.append(f"({','.join(ph)})")
    return f"insert into {table} ({','.join(cols)}) values {','.join(values)} {suffix}", params


def json_(v: Any) -> str | None:
    """A jsonb parameter, as the TypeScript `json()` helper: JSON text (null → 'null'); UNDEFINED → SQL NULL."""
    return None if v is UNDEFINED else js_json(v)
