/**
 * P3-S8 T-17 — 0069 ON MANAGED POSTGRESQL (docs/PHASE_3_S8_CONTRACT.md §2.5,
 * A-02; P:275-285). The data checkpoint (existing books, stock and a residue)
 * is the P3-S8 case of tests/integration/migration-upgrade.test.ts; this suite
 * proves the deployment half:
 *
 *   - upgrade from the S7 head (0068) AS `daftar_migrator` — a LOGIN role with
 *     no SUPERUSER and no BYPASSRLS, owning what a managed deployment owns —
 *     applies exactly the files after the S7 head, 0069 first, and a rerun is
 *     a no-op;
 *   - the migrator is never widened: its attributes, memberships and
 *     privileges on the schema are what they were, and neither internal
 *     principal keeps CREATE on `public`;
 *   - the resulting catalogue (tables, functions, column ACLs, policies,
 *     triggers, constraints) equals a superuser upgrade of the same
 *     checkpoint AND a fresh superuser build 0000 → head, with the applying
 *     principal's name normalised (the migration-portability §J comparison);
 *   - 0069's preconditions refuse to apply it anywhere but on the S7 head
 *     (onto 0067) and refuse to apply it twice (a reconciler that already
 *     reads what 0069 grants is an unreviewable widening), each leaving
 *     nothing behind.
 */
import { cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../../apps/api/src/infra/migrate';
import { createScratchDb, migrationsAfter, migrationsUpTo, type ScratchDb } from '../helpers/scratch-db';

const S7_HEAD = '0068_supplier_settlement_commands.sql';
const BEFORE_S7_HEAD = '0067_payment_methods_supplier_settlement_sources.sql';
const S8M = '0069_inventory_reconciliation_read_and_account_domain.sql';

/** The catalogue a deployment is judged by (migration-portability.test.ts §J). */
const CATALOGUE: Readonly<Record<string, string>> = {
  tables: `SELECT c.relname || ' | ' || pg_get_userbyid(c.relowner) || ' | ' || c.relrowsecurity || ' | ' || c.relforcerowsecurity || ' | ' || coalesce(c.relacl::text, '') AS row
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm', 'p')`,
  functions: `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') | ' || pg_get_userbyid(p.proowner) || ' | ' || p.prosecdef
                     || ' | ' || p.provolatile::text || ' | ' || coalesce(p.proacl::text, '') || ' | ' || coalesce(p.proconfig::text, '') || ' | ' || md5(p.prosrc) AS row
                FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`,
  columns: `SELECT c.relname || '.' || a.attname || ' | ' || a.attacl::text AS row
              FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND a.attacl IS NOT NULL AND a.attnum > 0 AND NOT a.attisdropped`,
  policies: `SELECT c.relname || '.' || pol.polname || ' | ' || pol.polcmd::text || ' | ' || pol.polpermissive
                    || ' | ' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || ' | ' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
                    || ' | ' || coalesce((SELECT string_agg(pg_get_userbyid(r), ',' ORDER BY r) FROM unnest(pol.polroles) r), '') AS row
               FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid`,
  triggers: `SELECT c.relname || '.' || t.tgname || ' | ' || t.tgtype || ' | ' || t.tgenabled::text || ' | ' || t.tgdeferrable || ' | ' || t.tginitdeferred
                    || ' | ' || p.proname || ' | ' || coalesce(pg_get_triggerdef(t.oid), '') AS row
               FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid WHERE NOT t.tgisinternal`,
  constraints: `SELECT c.relname || '.' || con.conname || ' | ' || con.contype::text || ' | ' || pg_get_constraintdef(con.oid) AS row
                  FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'`,
};

/** Each catalogue row set, sorted, with the applying principal's name replaced by `<applier>`. */
async function snapshot(pool: Pool, applier: 'postgres' | 'daftar_migrator'): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const [name, query] of Object.entries(CATALOGUE)) {
    out[name] = (await pool.query<{ row: string }>(query)).rows.map((r) => r.row.split(applier).join('<applier>')).sort();
  }
  return out;
}

/** What the deployment principal is: attributes, memberships, and its privileges on the database and schema. */
async function migratorShape(pool: Pool): Promise<unknown> {
  const attrs = (
    await pool.query(
      `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolinherit, rolcanlogin FROM pg_roles WHERE rolname = 'daftar_migrator'`,
    )
  ).rows;
  const memberships = (
    await pool.query<{ m: string }>(
      `SELECT pg_get_userbyid(m.roleid) || ':' || m.admin_option AS m FROM pg_auth_members m WHERE m.member = 'daftar_migrator'::regrole ORDER BY 1`,
    )
  ).rows.map((x) => x.m);
  const privileges = (
    await pool.query(
      `SELECT has_database_privilege('daftar_migrator', current_database(), 'CREATE') AS db_create,
              has_database_privilege('daftar_migrator', current_database(), 'TEMPORARY') AS db_temp,
              has_schema_privilege('daftar_migrator', 'public', 'CREATE') AS schema_create,
              pg_get_userbyid(n.nspowner) AS schema_owner
         FROM pg_namespace n WHERE n.nspname = 'public'`,
    )
  ).rows;
  return { attrs, memberships, privileges };
}

async function appliedNames(pool: Pool): Promise<string[]> {
  return (await pool.query<{ name: string }>(`SELECT name FROM schema_migrations ORDER BY name`)).rows.map((x) => x.name);
}

describe('T-17 — 0069 onto the S7 head as daftar_migrator, identical to a superuser build (§2.5)', () => {
  let managed: ScratchDb;
  let superuser: ScratchDb;
  let fresh: ScratchDb;

  beforeAll(async () => {
    managed = await createScratchDb('daftar_p3s8_t17_managed', { upTo: S7_HEAD, migratorOwned: true });
    superuser = await createScratchDb('daftar_p3s8_t17_superuser', { upTo: S7_HEAD });
    fresh = await createScratchDb('daftar_p3s8_t17_fresh');
  }, 300_000);

  afterAll(async () => {
    for (const db of [managed, superuser, fresh]) await db.drop();
  });

  it('the checkpoints are the S7 head, and the fresh build is every file on disk', () => {
    expect(managed.applied[managed.applied.length - 1]).toBe(S7_HEAD);
    expect(superuser.applied[superuser.applied.length - 1]).toBe(S7_HEAD);
    expect(fresh.applied).toContain(S8M);
    expect(fresh.applied.slice(fresh.applied.indexOf(S7_HEAD) + 1)).toEqual(migrationsAfter(S7_HEAD));
  });

  it('as daftar_migrator (no SUPERUSER, no BYPASSRLS): applies exactly the files after the S7 head, 0069 first; a rerun is a no-op; the migrator is not widened', async () => {
    const asMigrator = managed.poolAs('daftar_migrator', 1);
    expect(
      (await asMigrator.query<{ rolsuper: boolean; rolbypassrls: boolean }>(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`))
        .rows[0],
    ).toEqual({ rolsuper: false, rolbypassrls: false });
    const shapeBefore = await migratorShape(managed.pool);

    const applied = await managed.migrateRest('daftar_migrator');
    expect(applied).toEqual(migrationsAfter(S7_HEAD));
    expect(applied[0]).toBe(S8M);
    expect(await managed.migrateRest('daftar_migrator')).toEqual([]);

    expect(await migratorShape(managed.pool)).toEqual(shapeBefore);
    for (const role of ['daftar_inventory_internal', 'daftar_accounting_internal']) {
      expect((await managed.pool.query<{ c: boolean }>(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS c`, [role])).rows[0]?.c, role).toBe(false);
    }
    // The two R-B1a functions landed with their owners, not the applier's.
    expect(
      (
        await managed.pool.query<{ o: string }>(
          `SELECT proname || ':' || pg_get_userbyid(proowner) AS o FROM pg_proc
            WHERE proname IN ('inventory_business_has_stock_movements', 'accounting_inventory_account_domain_guard') ORDER BY 1`,
        )
      ).rows.map((x) => x.o),
    ).toEqual(['accounting_inventory_account_domain_guard:daftar_accounting_internal', 'inventory_business_has_stock_movements:daftar_inventory_internal']);
  });

  it('the catalogue equals a superuser upgrade of the same checkpoint and a fresh superuser build 0000 → head', async () => {
    expect(await superuser.migrateRest()).toEqual(migrationsAfter(S7_HEAD));
    // The managed upgrade ran in the previous case; each is idempotent.
    expect(await managed.migrateRest('daftar_migrator')).toEqual([]);
    const deployed = await snapshot(managed.pool, 'daftar_migrator');
    const upgradedBySuperuser = await snapshot(superuser.pool, 'postgres');
    const builtFresh = await snapshot(fresh.pool, 'postgres');
    for (const name of Object.keys(CATALOGUE)) {
      expect(deployed[name], `managed ↔ superuser upgrade: ${name}`).toEqual(upgradedBySuperuser[name]);
      expect(builtFresh[name], `fresh ↔ superuser upgrade: ${name}`).toEqual(upgradedBySuperuser[name]);
    }
    expect(await appliedNames(managed.pool)).toEqual(await appliedNames(fresh.pool));
  });

  it('refuses to apply 0069 anywhere but on the S7 head (onto 0067), recording nothing and leaving no grant or object', async () => {
    const early = await createScratchDb('daftar_p3s8_t17_early', { upTo: BEFORE_S7_HEAD });
    const dir = migrationsUpTo(BEFORE_S7_HEAD);
    try {
      cpSync(join(MIGRATIONS_DIR, S8M), join(dir, S8M));
      await expect(runMigrations(early.url(), dir)).rejects.toThrow(/inventory\.migration_end_state_invalid: 0069 applies on the S7 head/);
      expect(await appliedNames(early.pool)).not.toContain(S8M);
      expect(
        (
          await early.pool.query<{ n: number }>(
            `SELECT (SELECT count(*) FROM pg_proc WHERE proname IN ('inventory_business_has_stock_movements', 'accounting_inventory_account_domain_guard'))::int
                  + (SELECT count(*) FROM pg_trigger WHERE tgname = 'journal_entries_inventory_account_domain')::int AS n`,
          )
        ).rows[0]?.n,
      ).toBe(0);
      expect(
        (
          await early.pool.query<{ r: boolean }>(
            `SELECT has_any_column_privilege('daftar_reconciler', 'public.stock_movements', 'SELECT')
                 OR has_column_privilege('daftar_reconciler', 'public.accounts', 'system_key', 'SELECT') AS r`,
          )
        ).rows[0]?.r,
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await early.drop();
    }
  }, 300_000);

  it('refuses to apply 0069 twice: on its own head, with its record removed, the rerun is refused as an unreviewable widening and changes nothing', async () => {
    const own = await createScratchDb('daftar_p3s8_t17_twice', { upTo: S8M });
    const dir = migrationsUpTo(S8M);
    try {
      expect(own.applied[own.applied.length - 1]).toBe(S8M);
      await own.pool.query(`DELETE FROM schema_migrations WHERE name = $1`, [S8M]);
      const before = await snapshot(own.pool, 'postgres');
      await expect(runMigrations(own.url(), dir)).rejects.toThrow(/inventory\.authority_leak: daftar_reconciler already reads a column 0069 grants/);
      expect(await snapshot(own.pool, 'postgres')).toEqual(before);
      expect(await appliedNames(own.pool)).not.toContain(S8M);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await own.drop();
    }
  }, 300_000);

  // Phase 3 corrective (0072) registers a further operation kind after 0069, so on
  // the head 0069's own head precondition (exactly the S7 head's twenty-six kinds)
  // refuses the rerun first — still recording nothing and changing nothing.
  it('refuses to apply 0069 twice: on the head, with its record removed, the rerun is refused by its S7-head precondition and changes nothing', async () => {
    await superuser.pool.query(`DELETE FROM schema_migrations WHERE name = $1`, [S8M]);
    const before = await snapshot(superuser.pool, 'postgres');
    await expect(runMigrations(superuser.url())).rejects.toThrow(
      /^inventory\.migration_end_state_invalid: 0069 applies on the S7 head \(0068 and its twenty-six operation kinds\) only$/,
    );
    expect(await snapshot(superuser.pool, 'postgres')).toEqual(before);
    expect(await appliedNames(superuser.pool)).not.toContain(S8M);
  });
});
