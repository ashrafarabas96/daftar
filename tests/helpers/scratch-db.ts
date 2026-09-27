/**
 * P3-S8 — THE SCRATCH DATABASE FOR EVERY NEGATIVE CONTROL
 * (docs/PHASE_3_S8_CONTRACT.md §5, A-14; lifted from the pattern of
 * tests/security/inventory-signed-authority.test.ts PM-44 negative control).
 *
 * A negative control removes exactly one invariant and shows the attack then
 * commits. Removing an invariant means dropping a trigger, replacing a
 * routine or granting what the model forbids — so it happens in a database of
 * its own, built here from the REAL migration files on disk (never from a copy
 * of another database, never from a hand-written schema), and dropped
 * afterwards with `WITH (FORCE)`.
 *
 * What a scratch database carries:
 *   - the deployment's own `bootstrap.sql` (every role, every grant a real
 *     database gets), through `applyBootstrap`;
 *   - the migrations `0000` … `upTo` (all of them by default), through the
 *     real runner `runMigrations`;
 *   - the three assertion keys the test application signs with, installed the
 *     way the platform-only ops commands install them — when the migrations
 *     applied define their install routines;
 *   - optionally (`migratorOwned`), every `postgres`-owned object in `public`
 *     handed to `daftar_migrator`, the ownership a managed deployment holds
 *     (the migration-portability pattern), so the rest of the history can be
 *     applied by the non-superuser deployment principal.
 *
 * Every identifier that reaches SQL is validated against `^daftar_[a-z0-9_]+$`.
 */
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { MIGRATIONS_DIR, runMigrations } from '../../apps/api/src/infra/migrate';
import {
  ACCOUNTING_ASSERTION_KEY_B64,
  ACCOUNTING_ASSERTION_KID,
  APP_DB_PASSWORD,
  IDENTITY_DB_PASSWORD,
  INVENTORY_ASSERTION_KEY_B64,
  INVENTORY_ASSERTION_KID,
  MIGRATOR_DB_PASSWORD,
  PG_PASSWORD,
  PG_PORT,
  PG_USER,
  PLATFORM_DB_PASSWORD,
  PROVISIONER_DB_PASSWORD,
  PROVISIONING_ASSERTION_KEY_B64,
  PROVISIONING_ASSERTION_KID,
  RECONCILER_DB_PASSWORD,
  RESOLVER_DB_PASSWORD,
  WORKER_DB_PASSWORD,
  applyBootstrap,
  dbUrl,
  ensurePostgres,
} from './test-app';

/** Every login role a scratch database can be reached as. */
export type ScratchRole =
  | 'postgres'
  | 'daftar_app'
  | 'daftar_platform'
  | 'daftar_worker'
  | 'daftar_resolver'
  | 'daftar_identity'
  | 'daftar_provisioner'
  | 'daftar_reconciler'
  | 'daftar_migrator';

const PASSWORDS: Readonly<Record<ScratchRole, string>> = {
  postgres: PG_PASSWORD,
  daftar_app: APP_DB_PASSWORD,
  daftar_platform: PLATFORM_DB_PASSWORD,
  daftar_worker: WORKER_DB_PASSWORD,
  daftar_resolver: RESOLVER_DB_PASSWORD,
  daftar_identity: IDENTITY_DB_PASSWORD,
  daftar_provisioner: PROVISIONER_DB_PASSWORD,
  daftar_reconciler: RECONCILER_DB_PASSWORD,
  daftar_migrator: MIGRATOR_DB_PASSWORD,
};

const SAFE_NAME = /^daftar_[a-z0-9_]+$/;

function safeName(name: string): string {
  if (!SAFE_NAME.test(name) || name === 'daftar') throw new Error(`scratch database name ${JSON.stringify(name)} is not a daftar_* scratch identifier`);
  return name;
}

/** The connection string of `role` on database `db` of the shared cluster. */
export function urlOf(db: string, role: ScratchRole = 'postgres'): string {
  const user = role === 'postgres' ? PG_USER : role;
  return `postgresql://${user}:${PASSWORDS[role]}@localhost:${PG_PORT}/${db}`;
}

/** Every migration file on disk, in apply order. */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/** The last migration on disk (the head a scratch database is built to by default). */
export function headMigration(): string {
  const files = migrationFiles();
  const last = files[files.length - 1];
  if (last === undefined) throw new Error('no migration on disk');
  return last;
}

/** Every migration strictly after `after`, in apply order. */
export function migrationsAfter(after: string): string[] {
  return migrationFiles().filter((f) => f > after);
}

/**
 * A temporary directory holding copies of the migrations up to and including
 * `upTo` (the migration-upgrade pattern). The caller removes it with
 * `rmSync(dir, { recursive: true, force: true })`.
 */
export function migrationsUpTo(upTo: string): string {
  if (!migrationFiles().includes(upTo)) throw new Error(`no migration named ${upTo}`);
  const dir = mkdtempSync(join(tmpdir(), 'daftar-scratch-mig-'));
  for (const f of migrationFiles()) if (f <= upTo) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
  return dir;
}

/** Apply the migrations up to `upTo` (inclusive) to `url`, through the real runner. */
export async function migrateUpTo(url: string, upTo: string): Promise<string[]> {
  const dir = migrationsUpTo(upTo);
  try {
    return await runMigrations(url, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A pool whose idle-client errors are expected: a scratch database is dropped
 * `WITH (FORCE)`, which terminates any backend still attached, and `pg` emits
 * that on the pool. Every query is awaited, so a real failure still rejects.
 */
export function scratchPool(connectionString: string, max = 2): Pool {
  const pool = new Pool({ connectionString, max });
  pool.on('error', () => undefined);
  return pool;
}

export interface ScratchDbOptions {
  /** Apply the migrations up to and including this file. Default: every file on disk. */
  readonly upTo?: string;
  /** Install the provisioning, accounting and inventory test keys where their install routines exist. Default true. */
  readonly keys?: boolean;
  /** Hand every postgres-owned object in `public` (and the schema) to daftar_migrator after building. Default false. */
  readonly migratorOwned?: boolean;
}

export interface ScratchDb {
  readonly name: string;
  /** The migrations the build applied, in order. */
  readonly applied: readonly string[];
  /** A superuser pool on the scratch database. */
  readonly pool: Pool;
  /** The connection string of `role` on the scratch database. */
  url(role?: ScratchRole): string;
  /** A fresh pool as `role` (closed by `drop()`). */
  poolAs(role: ScratchRole, max?: number): Pool;
  /** Apply every remaining migration on disk, as the superuser or the deployment principal. */
  migrateRest(as?: 'postgres' | 'daftar_migrator'): Promise<string[]>;
  /** Close every pool this handle opened and drop the database. */
  drop(): Promise<void>;
}

/**
 * Hand every postgres-owned relation and routine in `public`, and the schema
 * itself, to daftar_migrator — what a managed deployment's history looks
 * like (tests/integration/migration-portability.test.ts). Superuser only.
 */
export async function transferPublicToMigrator(pool: Pool): Promise<void> {
  await pool.query(`ALTER SCHEMA public OWNER TO daftar_migrator`);
  await pool.query(`
    DO $$
    DECLARE r RECORD;
    BEGIN
      FOR r IN SELECT c.relname, c.relkind FROM pg_class c
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 JOIN pg_roles o ON o.oid = c.relowner
                WHERE n.nspname = 'public' AND o.rolname = 'postgres' AND c.relkind IN ('r','v','m','S','p')
      LOOP
        EXECUTE format('ALTER %s public.%I OWNER TO daftar_migrator',
                       CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,
                       r.relname);
      END LOOP;
      FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                 JOIN pg_roles o ON o.oid = p.proowner
                WHERE n.nspname = 'public' AND o.rolname = 'postgres'
                  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
      LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO daftar_migrator', r.sig);
      END LOOP;
    END $$;
  `);
}

/** Install the three test keys where the applied migrations define their install routines. */
async function installKeys(pool: Pool): Promise<void> {
  const has = async (sig: string): Promise<boolean> =>
    (await pool.query<{ ok: boolean }>(`SELECT to_regprocedure($1) IS NOT NULL AS ok`, [sig])).rows[0]?.ok === true;
  if (await has('provision_assertion_key_install(text,bytea)')) {
    await pool.query(`SELECT provision_assertion_key_install($1, decode($2, 'base64'))`, [PROVISIONING_ASSERTION_KID, PROVISIONING_ASSERTION_KEY_B64]);
  }
  if (await has('accounting_assertion_key_install(text,bytea)')) {
    await pool.query(`SELECT accounting_assertion_key_install($1, decode($2, 'base64'))`, [ACCOUNTING_ASSERTION_KID, ACCOUNTING_ASSERTION_KEY_B64]);
  }
  if (await has('inventory_assertion_key_install(text,bytea)')) {
    await pool.query(`SELECT inventory_assertion_key_install($1, decode($2, 'base64'))`, [INVENTORY_ASSERTION_KID, INVENTORY_ASSERTION_KEY_B64]);
  }
}

/**
 * Build a scratch database `name` from the real migrations. An existing
 * database of that name is dropped first (a previous run that died leaves
 * one behind).
 */
export async function createScratchDb(name: string, o: ScratchDbOptions = {}): Promise<ScratchDb> {
  const db = safeName(name);
  await ensurePostgres();
  const admin = scratchPool(dbUrl, 1);
  const opened: Pool[] = [];
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db}`);
  } finally {
    await admin.end();
  }
  await applyBootstrap(db);
  const pool = scratchPool(urlOf(db), 4);
  opened.push(pool);
  await pool.query(`GRANT CONNECT ON DATABASE ${db} TO daftar_migrator`);
  const applied = o.upTo === undefined ? await runMigrations(urlOf(db)) : await migrateUpTo(urlOf(db), o.upTo);
  if (o.keys !== false) await installKeys(pool);
  if (o.migratorOwned === true) await transferPublicToMigrator(pool);

  return {
    name: db,
    applied,
    pool,
    url: (role: ScratchRole = 'postgres') => urlOf(db, role),
    poolAs: (role: ScratchRole, max = 2) => {
      const p = scratchPool(urlOf(db, role), max);
      opened.push(p);
      return p;
    },
    migrateRest: async (as: 'postgres' | 'daftar_migrator' = 'postgres') => {
      const done = await runMigrations(urlOf(db, as));
      if (o.keys !== false) await installKeys(pool);
      return done;
    },
    drop: async () => {
      for (const p of opened.splice(0)) await p.end().catch(() => undefined);
      const again = scratchPool(dbUrl, 1);
      try {
        await again.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      } finally {
        await again.end();
      }
    },
  };
}
