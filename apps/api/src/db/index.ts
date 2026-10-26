// Database access. Production runs on PostgreSQL (DATABASE_URL); local development and tests run
// on PGlite, an in-process build of the same Postgres, so one SQL dialect serves both.

import { mkdirSync } from 'node:fs';
import { config } from '../config';
import { MIGRATIONS } from './migrations';

export type Row = Record<string, any>;

export interface Db {
  kind: 'pg' | 'pglite';
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T | null>;
  exec(sql: string): Promise<void>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

type Querier = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; exec?: (sql: string) => Promise<unknown> };

function wrap(kind: Db['kind'], q: Querier, txImpl: Db['tx'], close: () => Promise<void>): Db {
  const db: Db = {
    kind,
    async query(sql, params = []) { return (await q.query(sql, params as any[])).rows; },
    async one(sql, params = []) { return (await q.query(sql, params as any[])).rows[0] ?? null; },
    async exec(sql) { if (q.exec) await q.exec(sql); else await q.query(sql); },
    tx: txImpl,
    close,
  };
  return db;
}

async function openPglite(dir: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  if (dir !== 'memory://' && !dir.startsWith('memory')) mkdirSync(dir, { recursive: true });
  const pg = new PGlite(dir === 'memory' ? undefined : dir);
  await pg.waitReady;
  // PGlite serialises transactions itself; a nested tx() inside one reuses the open transaction.
  return wrap('pglite', pg as unknown as Querier, async (fn) => pg.transaction(async (t) => {
    const inner: Db = wrap('pglite', t as unknown as Querier, async (f) => f(inner), async () => {});
    return fn(inner);
  }) as Promise<any>, async () => { await pg.close(); });
}

async function openPg(url: string): Promise<Db> {
  const pgMod = await import('pg');
  const Pool = (pgMod as any).default?.Pool ?? (pgMod as any).Pool;
  const pool = new Pool({ connectionString: url, max: 10 });
  const db: Db = wrap('pg', pool, async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const inner = wrap('pg', client, async (f) => f(inner), async () => {});
      const out = await fn(inner);
      await client.query('commit');
      return out;
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }, async () => { await pool.end(); });
  return db;
}

export async function migrate(db: Db) {
  await db.exec('create table if not exists schema_migrations (version int primary key, applied_at timestamptz not null default now())');
  const done = new Set((await db.query<{ version: number }>('select version from schema_migrations')).map((r) => Number(r.version)));
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    await db.tx(async (t) => {
      await t.exec(m.sql);
      await t.query('insert into schema_migrations (version) values ($1)', [m.version]);
    });
  }
}

let current: Db | null = null;

export async function openDb(opts: { url?: string | null; dir?: string } = {}): Promise<Db> {
  const url = opts.url !== undefined ? opts.url : config.databaseUrl;
  const db = url ? await openPg(url) : await openPglite(opts.dir ?? config.pgliteDir);
  await migrate(db);
  return db;
}

export async function getDb(): Promise<Db> {
  if (!current) current = await openDb();
  return current;
}

export function setDb(db: Db | null) { current = db; }

/** Build a multi-row INSERT for batch writes. */
export function insertMany(table: string, cols: string[], rows: unknown[][], suffix = ''): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const values = rows.map((r) => `(${r.map((v) => { params.push(v); return `$${params.length}`; }).join(',')})`).join(',');
  return { sql: `insert into ${table} (${cols.join(',')}) values ${values} ${suffix}`, params };
}

export const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
export const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
