import { mkdtempSync, rmSync, cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { describe, it, expect, afterAll } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../../apps/api/src/infra/migrate';
import {
  dbUrl,
  PG_PORT,
  PG_USER,
  PG_PASSWORD,
  APP_DB_PASSWORD,
  PLATFORM_DB_PASSWORD,
  WORKER_DB_PASSWORD,
  RESOLVER_DB_PASSWORD,
  IDENTITY_DB_PASSWORD,
  PROVISIONER_DB_PASSWORD,
  MIGRATOR_DB_PASSWORD,
  ensurePostgres,
} from '../helpers/test-app';

/**
 * MANAGED-POSTGRESQL PORTABILITY (P2-S1 Tech Lead correction §8).
 *
 * DAFTAR must not silently require a SUPERUSER to migrate. A green CI run
 * proves nothing about that on its own, because the CI migration connection
 * IS a superuser and a superuser bypasses every privilege check that would
 * otherwise fail.
 *
 * So this suite parks a database at 0039 and then applies every migration
 * after it — `0040` and `0041` (P2-S1) and `0042` and `0043` (P2-S2) —
 * **through a connection authenticated as `daftar_migrator`** — a LOGIN
 * deployment principal with `rolsuper = false` and `rolbypassrls = false`.
 * Nothing is executed as postgres after the checkpoint, and nothing is
 * asserted that the non-superuser connection did not itself produce.
 *
 * The one thing the harness does as postgres is hand the 0039 objects to the
 * migrator, because migrations `0000`–`0039` are frozen and still contain
 * `ALTER FUNCTION ... OWNER TO daftar_platform`, which a non-superuser cannot
 * execute unless `daftar_platform` — a LOGIN runtime role — holds CREATE on
 * the schema. That is a PRE-EXISTING Phase 1 limitation, recorded in
 * docs/PHASE_2_S1_ACCEPTANCE.md for deployment hardening and deliberately not
 * fixed here: P2-S1 may not reopen frozen migrations, and buying portability
 * by granting a runtime role CREATE would undo the authority correction this
 * slice just landed. Establishing that starting state is exactly what a
 * managed deployment looks like, where the migration principal owns the
 * schema it created.
 */
const SCRATCH_DB = 'daftar_portability_0039';
const adminScratchUrl = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${SCRATCH_DB}`;
const migratorScratchUrl = `postgresql://daftar_migrator:${MIGRATOR_DB_PASSWORD}@localhost:${PG_PORT}/${SCRATCH_DB}`;

/** The six roles an application runtime authenticates as. */
const RUNTIME_ROLES = ['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver', 'daftar_provisioner'] as const;

function bootstrapSql(): string {
  return readFileSync(join(__dirname, '../../infrastructure/database/bootstrap.sql'), 'utf8')
    .replaceAll('__APP_DB_PASSWORD__', APP_DB_PASSWORD)
    .replaceAll('__PLATFORM_DB_PASSWORD__', PLATFORM_DB_PASSWORD)
    .replaceAll('__WORKER_DB_PASSWORD__', WORKER_DB_PASSWORD)
    .replaceAll('__RESOLVER_DB_PASSWORD__', RESOLVER_DB_PASSWORD)
    .replaceAll('__IDENTITY_DB_PASSWORD__', IDENTITY_DB_PASSWORD)
    .replaceAll('__PROVISIONER_DB_PASSWORD__', PROVISIONER_DB_PASSWORD)
    .replaceAll('__MIGRATOR_DB_PASSWORD__', MIGRATOR_DB_PASSWORD);
}

function migrationsUpTo(upTo: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'daftar-portability-'));
  for (const f of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    if (f <= upTo) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
  }
  return dir;
}

/**
 * A pool on a scratch database, with the error listener `pg` requires.
 *
 * Every case here ends by dropping its database `WITH (FORCE)`, which
 * terminates whatever backends are still attached. A pool whose idle client
 * is terminated EMITS an error, and an unhandled one fails the whole run even
 * though every assertion passed — so the listener is part of using a pool
 * against a database that will be dropped, not a way to hide a failure. The
 * assertions are all made through awaited queries, which still reject.
 */
function scratchPool(connectionString: string): Pool {
  const pool = new Pool({ connectionString, max: 1 });
  pool.on('error', () => undefined);
  return pool;
}

const admin = scratchPool(dbUrl);

describe('managed PostgreSQL: 0039 → 0049 under a non-superuser migration principal', () => {
  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  });

  it('applies 0040 through 0049 with no superuser anywhere in the path', async () => {
    await ensurePostgres();
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

    const setup = scratchPool(adminScratchUrl);
    const businesses: string[] = [];
    try {
      await setup.query(bootstrapSql());
      // bootstrap.sql names the production database literally; this scratch
      // one needs the same CONNECT.
      await setup.query(`GRANT CONNECT ON DATABASE ${SCRATCH_DB} TO daftar_migrator`);

      // ── Park at 0039 ───────────────────────────────────────────────────
      const preDir = migrationsUpTo('0039_catalog_identifiers_owner_integrity.sql');
      await runMigrations(adminScratchUrl, preDir);
      rmSync(preDir, { recursive: true, force: true });
      expect((await setup.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'accounts'`)).rows).toEqual([]);

      // Two existing businesses, so the backfill has real work to do.
      for (const slug of ['portability-one', 'portability-two']) {
        const tenant = (await setup.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0];
        const biz = (
          await setup.query<{ id: string }>(
            `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
             VALUES ($1, $2, $2, 'JO', 'JOD', 'Asia/Amman') RETURNING id`,
            [tenant?.id, slug],
          )
        ).rows[0];
        if (!biz) throw new Error('business fixture insert failed');
        businesses.push(biz.id);
        await setup.query('BEGIN');
        await setup.query(`SET LOCAL session_replication_role = replica`);
        const role = (
          await setup.query<{ id: string }>(`INSERT INTO business_roles (business_id, key, name, is_system) VALUES ($1, 'owner', 'Owner', true) RETURNING id`, [
            biz.id,
          ])
        ).rows[0];
        await setup.query('COMMIT');
        await setup.query(`INSERT INTO role_permissions (business_id, role_id, permission) VALUES ($1, $2, 'business.view')`, [biz.id, role?.id]);
      }

      // ── Hand the 0039 schema to the migrator, as a managed deployment has
      //    it from the start. See the file header for why this is done here
      //    and not by making Phase 1 non-superuser-portable.
      await setup.query(`ALTER SCHEMA public OWNER TO daftar_migrator`);
      await setup.query(`
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
          LOOP
            EXECUTE format('ALTER FUNCTION %s OWNER TO daftar_migrator', r.sig);
          END LOOP;
        END $$;
      `);
    } finally {
      await setup.end();
    }

    // ── The migration principal must be exactly that: no superuser, no RLS
    //    bypass. Asserted before it is used, so a mis-provisioned role can
    //    never make this suite pass by accident.
    const migrator = scratchPool(migratorScratchUrl);
    try {
      const who = (
        await migrator.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean }>(
          `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = current_user`,
        )
      ).rows[0];
      expect(who).toEqual({ rolname: 'daftar_migrator', rolsuper: false, rolbypassrls: false, rolcreaterole: false });

      // ── THE PROOF: every post-0039 migration executes over this
      //    connection, P2-S2's two included. Each of them transfers function
      //    ownership to the internal principal, and each of them has to do it
      //    through ordinary privilege rules.
      const applied = await runMigrations(migratorScratchUrl);
      expect(applied).toEqual([
        '0040_accounting_chart.sql',
        '0041_accounting_permissions.sql',
        '0042_accounting_journal.sql',
        '0043_accounting_invariants.sql',
        '0044_accounting_assertion_keys.sql',
        '0045_accounting_post_entry.sql',
        '0046_accounting_sources.sql',
        '0047_accounting_opening_balances.sql',
        '0048_accounting_fx_rates.sql',
        '0049_accounting_periods.sql',
      ]);

      // The ALTER FUNCTION ownership transfer was legitimate, not bypassed.
      const owners = (
        await migrator.query<{ proname: string; owner: string }>(
          `SELECT p.proname, r.rolname AS owner FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
            WHERE p.proname IN ('accounting_seed_chart','accounting_seed_chart_trg') ORDER BY p.proname`,
        )
      ).rows;
      expect(owners).toEqual([
        { proname: 'accounting_seed_chart', owner: 'daftar_accounting_internal' },
        { proname: 'accounting_seed_chart_trg', owner: 'daftar_accounting_internal' },
      ]);

      // P2-S2 repeats the same dance for five more routines. A superuser run
      // could not tell whether any of them needed elevation; this one can.
      const p2s2Owners = (
        await migrator.query<{ proname: string; owner: string }>(
          `SELECT p.proname, r.rolname AS owner FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
            WHERE p.proname IN ('accounting_pow10','accounting_assert_entry_valid','accounting_validate_entry',
                                'accounting_validate_entry_of_line','businesses_base_currency_lock')
            ORDER BY p.proname`,
        )
      ).rows;
      expect(p2s2Owners).toEqual([
        { proname: 'accounting_assert_entry_valid', owner: 'daftar_accounting_internal' },
        { proname: 'accounting_pow10', owner: 'daftar_accounting_internal' },
        { proname: 'accounting_validate_entry', owner: 'daftar_accounting_internal' },
        { proname: 'accounting_validate_entry_of_line', owner: 'daftar_accounting_internal' },
        { proname: 'businesses_base_currency_lock', owner: 'daftar_accounting_internal' },
      ]);

      // Both deferred constraint triggers survived the non-superuser path.
      const validators = (
        await migrator.query<{ tgname: string }>(
          `SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
            WHERE NOT t.tgisinternal AND t.tgdeferrable AND t.tginitdeferred
              AND t.tgname IN ('journal_entry_validate','journal_line_validate') ORDER BY t.tgname`,
        )
      ).rows.map((r) => r.tgname);
      expect(validators).toEqual(['journal_entry_validate', 'journal_line_validate']);

      // The backfill ran: every pre-existing business has its full chart.
      //
      // Read under the seeder's identity, which the migrator may assume by its
      // SET-enabled membership. RLS is real for the migrator too: `businesses`
      // FORCEs it and no policy admits a deployment principal, so a plain
      // SELECT here returns nothing — which is precisely the trap that made
      // the backfill a silent no-op before this migration was reordered.
      await migrator.query(`SET ROLE daftar_accounting_internal`);
      const charts = (
        await migrator.query<{ id: string; n: number }>(
          `SELECT b.id,
                  (SELECT count(*)::int FROM accounts a
                   JOIN accounting_system_account_keys k ON k.system_key = a.system_key AND k.account_type = a.type
                   WHERE a.business_id = b.id AND a.is_active AND a.tenant_id = b.tenant_id) AS n
             FROM businesses b ORDER BY b.store_slug`,
        )
      ).rows;
      expect(charts.map((c) => c.n)).toEqual([21, 21]);
      expect(charts.map((c) => c.id).sort()).toEqual([...businesses].sort());

      // financial_started_at is still untouched by chart creation.
      expect((await migrator.query<{ n: number }>(`SELECT count(*)::int AS n FROM businesses WHERE financial_started_at IS NOT NULL`)).rows[0]?.n).toBe(0);
      await migrator.query(`RESET ROLE`);

      // A business created AFTER the migration still gets its chart from the
      // trigger, even though PUBLIC EXECUTE is now revoked — and it gets it
      // through the ordinary RLS-scoped path, not around it.
      await migrator.query('BEGIN');
      const tenant = (await migrator.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0];
      await migrator.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant?.id]);
      const fresh = (
        await migrator.query<{ id: string }>(
          `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
           VALUES ($1, 'Post Upgrade', 'portability-three', 'JO', 'JOD', 'Asia/Amman') RETURNING id`,
          [tenant?.id],
        )
      ).rows[0];
      await migrator.query(`SELECT set_config('app.business_id', $1, true)`, [fresh?.id]);
      expect((await migrator.query<{ n: number }>(`SELECT count(*)::int AS n FROM accounts`)).rows[0]?.n).toBe(21);
      await migrator.query('COMMIT');

      // Re-running the migrations over the same connection is a no-op.
      expect(await runMigrations(migratorScratchUrl)).toEqual([]);
    } finally {
      await migrator.end();
    }
  });

  /**
   * P2-S4 §52: the SHORT path, from the frozen P2-S3 boundary.
   *
   * The 0039 case above already runs 0040…0047 in one sweep, so this looks
   * redundant — it is not. That sweep applies the candidates onto a schema
   * the same migrator built moments earlier in the same run. This one parks
   * at exactly 0045, the frozen release boundary, and asks the question a
   * real deployment asks: do the two NEW migrations apply, unaided, on top of
   * the schema that is already in production? A defect that only shows when
   * 0046 meets a settled 0045 — an assumption about ownership, an ACL that
   * happened to be in place because an earlier migration in the same
   * transaction put it there — would pass the long path and fail here.
   */
  it('applies 0046 through 0049 onto the frozen 0045 boundary, with no superuser and a no-op rerun (§52, P2-S5 §70, P2-S6 §42)', async () => {
    await ensurePostgres();
    const db = 'daftar_portability_0045';
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db}`);
    const adminUrl = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${db}`;
    const migratorUrl = `postgresql://daftar_migrator:${MIGRATOR_DB_PASSWORD}@localhost:${PG_PORT}/${db}`;

    const setup = scratchPool(adminUrl);
    try {
      await setup.query(bootstrapSql());
      await setup.query(`GRANT CONNECT ON DATABASE ${db} TO daftar_migrator`);

      // Park at exactly the frozen boundary.
      const preDir = migrationsUpTo('0045_accounting_post_entry.sql');
      await runMigrations(adminUrl, preDir);
      rmSync(preDir, { recursive: true, force: true });

      // The checkpoint is honest in both directions: the posting engine is
      // there, the sources are not.
      expect((await setup.query(`SELECT 1 FROM pg_proc WHERE proname = 'accounting_post_entry'`)).rows).toHaveLength(1);
      for (const table of ['accounting_manual_adjustments', 'accounting_reversals', 'accounting_opening_balances', 'accounting_operation_kinds']) {
        expect((await setup.query(`SELECT 1 FROM information_schema.tables WHERE table_name = $1`, [table])).rows, table).toEqual([]);
      }

      // A business that existed before the sources did.
      const tenant = (await setup.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0];
      await setup.query(
        `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
         VALUES ($1, 'Before Sources', 'portability-0045', 'JO', 'JOD', 'Asia/Amman')`,
        [tenant?.id],
      );

      // Hand the settled 0045 schema to the migrator, as a managed deployment
      // has it from the start — the same handover the 0039 case performs, and
      // for the same reason (see the file header).
      await setup.query(`ALTER SCHEMA public OWNER TO daftar_migrator`);
      await setup.query(`
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
          LOOP
            EXECUTE format('ALTER FUNCTION %s OWNER TO daftar_migrator', r.sig);
          END LOOP;
        END $$;
      `);

      // Exactly the migrations after the boundary, applied by the
      // NON-SUPERUSER principal.
      const migrator = scratchPool(migratorUrl);
      try {
        const who = (
          await migrator.query<{ rolsuper: boolean; rolbypassrls: boolean }>(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`)
        ).rows[0];
        expect(who).toEqual({ rolsuper: false, rolbypassrls: false });
      } finally {
        await migrator.end().catch(() => undefined);
      }
      expect(await runMigrations(migratorUrl)).toEqual([
        '0046_accounting_sources.sql',
        '0047_accounting_opening_balances.sql',
        '0048_accounting_fx_rates.sql',
        '0049_accounting_periods.sql',
      ]);
      expect(await runMigrations(migratorUrl)).toEqual([]);

      // And the sources arrived with the shape the slice specifies.
      const check = scratchPool(migratorUrl);
      try {
        expect(
          (
            await check.query<{ t: string }>(
              `SELECT table_name AS t FROM information_schema.tables
              WHERE table_name IN ('accounting_manual_adjustments','accounting_reversals','accounting_opening_balances',
                                   'accounting_opening_balance_lines','accounting_operation_kinds')`,
              // Sorted here rather than in SQL: ORDER BY uses the database's
              // collation, which decides where `_` falls against a letter, and
              // this assertion is about which tables exist, not about that.
            )
          ).rows
            .map((r) => r.t)
            .sort(),
        ).toEqual([
          'accounting_manual_adjustments',
          'accounting_opening_balance_lines',
          'accounting_opening_balances',
          'accounting_operation_kinds',
          'accounting_reversals',
        ]);
        // The second writer is callable by the merchant runtime and nobody
        // else — asked with has_function_privilege, because a REVOKE that
        // silently did nothing leaves a NULL acl that an acl-shaped test
        // passes vacuously on.
        expect(
          (
            await check.query<{ app: boolean; pub: boolean }>(
              `SELECT has_function_privilege('daftar_app', 'accounting_post_reversal(uuid,date,text,text)', 'EXECUTE') AS app,
                    has_function_privilege('public', 'accounting_post_reversal(uuid,date,text,text)', 'EXECUTE') AS pub`,
            )
          ).rows[0],
        ).toEqual({ app: true, pub: false });
      } finally {
        await check.end().catch(() => undefined);
      }
    } finally {
      await setup.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => undefined);
    }
  }, 180_000);

  /**
   * P2-S5 §70 — 0048 alone, onto the frozen 0047 boundary, applied by
   * `daftar_migrator`.
   *
   * The FX slice adds a SECURITY DEFINER command owned by a principal the
   * migrator is only a member of, a table with FORCE row level security, and
   * a set of helper routines whose ownership has to be handed over. Every one
   * of those is a step a superuser performs without noticing and a managed
   * deployment cannot perform at all if the migration relied on being
   * superuser. So the question is not whether 0048 is correct — other suites
   * answer that — but whether it INSTALLS under the credential a managed
   * PostgreSQL actually gives you.
   */
  it('applies 0048 alone onto the frozen 0047 boundary, then 0049, with no superuser and a no-op rerun (P2-S5 §70, P2-S6 §42)', async () => {
    await ensurePostgres();
    const db = 'daftar_portability_0047';
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db}`);
    const adminUrl = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${db}`;
    const migratorUrl = `postgresql://daftar_migrator:${MIGRATOR_DB_PASSWORD}@localhost:${PG_PORT}/${db}`;

    const setup = scratchPool(adminUrl);
    try {
      await setup.query(bootstrapSql());
      await setup.query(`GRANT CONNECT ON DATABASE ${db} TO daftar_migrator`);

      const preDir = migrationsUpTo('0047_accounting_opening_balances.sql');
      await runMigrations(adminUrl, preDir);
      rmSync(preDir, { recursive: true, force: true });

      // The checkpoint is honest in both directions.
      expect((await setup.query(`SELECT 1 FROM pg_proc WHERE proname = 'accounting_open_balance_post'`)).rows).toHaveLength(1);
      expect((await setup.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'accounting_fx_rates'`)).rows).toEqual([]);

      // Hand the settled schema to the migrator, as a managed deployment has
      // it from the start.
      await setup.query(`ALTER SCHEMA public OWNER TO daftar_migrator`);
      await setup.query(`
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
          LOOP
            EXECUTE format('ALTER FUNCTION %s OWNER TO daftar_migrator', r.sig);
          END LOOP;
        END $$;
      `);

      const who = scratchPool(migratorUrl);
      try {
        expect(
          (await who.query<{ rolsuper: boolean; rolbypassrls: boolean }>(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`)).rows[0],
        ).toEqual({ rolsuper: false, rolbypassrls: false });
      } finally {
        await who.end().catch(() => undefined);
      }

      // 0048 ALONE first, from a directory capped at it. That is the P2-S5
      // claim stated exactly: the FX migration installs by itself, on the
      // settled 0047 boundary, under a managed credential — not merely as one
      // step of a sweep that a later migration might have prepared the way
      // for. The P2-S6 candidate then follows it, and only then.
      const s5Only = migrationsUpTo('0048_accounting_fx_rates.sql');
      try {
        expect(await runMigrations(migratorUrl, s5Only)).toEqual(['0048_accounting_fx_rates.sql']);
      } finally {
        rmSync(s5Only, { recursive: true, force: true });
      }
      expect(await runMigrations(migratorUrl)).toEqual(['0049_accounting_periods.sql']);
      expect(await runMigrations(migratorUrl)).toEqual([]);

      // Everything below is read through the NON-SUPERUSER connection: if the
      // migrator can see it, so can a deployment operator.
      const check = scratchPool(migratorUrl);
      try {
        // Row level security arrived enabled AND forced — forced matters
        // because the table's owner is the migrator itself here.
        expect(
          (
            await check.query<{ e: boolean; f: boolean }>(
              `SELECT relrowsecurity AS e, relforcerowsecurity AS f FROM pg_class WHERE relname = 'accounting_fx_rates'`,
            )
          ).rows[0],
        ).toEqual({ e: true, f: true });

        // The ownership transfers happened through ordinary privilege rules:
        // the migrator is a MEMBER of the internal principal, which is how a
        // non-superuser is allowed to give an object away.
        expect(
          (
            await check.query<{ proname: string }>(
              `SELECT p.proname FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                 JOIN pg_roles o ON o.oid = p.proowner
                WHERE n.nspname = 'public' AND o.rolname = 'daftar_accounting_internal'
                  AND p.proname IN ('accounting_control_actor', 'accounting_fx_rate_enter', 'accounting_fx_rate_canonical',
                                    'accounting_fx_rate_fingerprint', 'accounting_fx_rate_lock_key', 'accounting_fx_rate_identity_lock_key')
                ORDER BY 1`,
            )
          ).rows.map((r) => r.proname),
        ).toEqual([
          'accounting_control_actor',
          'accounting_fx_rate_canonical',
          'accounting_fx_rate_enter',
          'accounting_fx_rate_fingerprint',
          'accounting_fx_rate_identity_lock_key',
          'accounting_fx_rate_lock_key',
        ]);

        // The command is callable by the merchant runtime and nobody else —
        // asked with has_function_privilege, because a REVOKE that silently
        // did nothing leaves a NULL acl an acl-shaped test passes vacuously.
        expect(
          (
            await check.query<{ app: boolean; pub: boolean }>(
              `SELECT has_function_privilege('daftar_app', 'accounting_fx_rate_enter(text,text,text,timestamptz,text)', 'EXECUTE') AS app,
                      has_function_privilege('public', 'accounting_fx_rate_enter(text,text,text,timestamptz,text)', 'EXECUTE') AS pub`,
            )
          ).rows[0],
        ).toEqual({ app: true, pub: false });

        // No runtime credential can write the registry (§25), and the migrator
        // did not leave itself BYPASSRLS anywhere (§43).
        expect(
          (
            await check.query<{ role: string; p: string }>(
              `SELECT coalesce(r.rolname, 'PUBLIC') AS role, a.privilege_type AS p
                 FROM pg_class c
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                 LEFT JOIN pg_roles r ON r.oid = a.grantee
                WHERE n.nspname = 'public' AND c.relname = 'accounting_fx_rates'
                  AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
                  AND a.grantee <> c.relowner
                ORDER BY role, a.privilege_type`,
            )
          ).rows,
        ).toEqual([{ role: 'daftar_accounting_internal', p: 'INSERT' }]);
        expect((await check.query(`SELECT 1 FROM pg_roles WHERE rolname LIKE 'daftar\\_%' AND rolbypassrls`)).rows).toEqual([]);
      } finally {
        await check.end().catch(() => undefined);
      }
    } finally {
      await setup.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => undefined);
    }
  }, 180_000);

  /**
   * P2-S6 §42 — 0049 alone, onto the frozen 0048 boundary, applied by
   * `daftar_migrator`.
   *
   * This is the migration with the most to prove under a managed credential,
   * because §12 asks for a REAL exclusion constraint and a gist exclusion on
   * a UUID column needs the `btree_gist` extension, which `0000` never
   * installed. `CREATE EXTENSION` is not something a NOSUPERUSER role may do
   * on a database it merely connects to, and the obvious ways out are both
   * refused: granting `daftar_migrator` CREATE on the database hands a
   * deployment principal the right to install arbitrary C code, and dropping
   * the exclusion constraint would leave non-overlap as a convention the
   * application is trusted to keep.
   *
   * So the extension is installed ONCE by the deployment administrator, in
   * `bootstrap.sql`, beside the roles — and 0049 only asserts that it is
   * there, with a sentence naming the fix if it is not. This test is what
   * says that arrangement actually works: bootstrap runs as the administrator,
   * every migration after the checkpoint runs as `daftar_migrator`, and the
   * migrator is granted nothing beyond CONNECT and what it already had.
   */
  it('applies 0049 alone onto the frozen 0048 boundary, with no superuser and a no-op rerun (P2-S6 §42)', async () => {
    await ensurePostgres();
    const db = 'daftar_portability_0048';
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db}`);
    const adminUrl = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${db}`;
    const migratorUrl = `postgresql://daftar_migrator:${MIGRATOR_DB_PASSWORD}@localhost:${PG_PORT}/${db}`;

    const setup = scratchPool(adminUrl);
    try {
      await setup.query(bootstrapSql());
      await setup.query(`GRANT CONNECT ON DATABASE ${db} TO daftar_migrator`);

      // The extension came from BOOTSTRAP, as the deployment administrator,
      // before any migration ran. Nothing after this point installs it.
      expect((await setup.query(`SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'`)).rows).toHaveLength(1);

      const preDir = migrationsUpTo('0048_accounting_fx_rates.sql');
      await runMigrations(adminUrl, preDir);
      rmSync(preDir, { recursive: true, force: true });

      // The checkpoint is honest in both directions.
      expect((await setup.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'accounting_fx_rates'`)).rows).toHaveLength(1);
      expect((await setup.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'accounting_periods'`)).rows).toEqual([]);

      // Hand the settled schema to the migrator, as a managed deployment has
      // it from the start.
      await setup.query(`ALTER SCHEMA public OWNER TO daftar_migrator`);
      await setup.query(`
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
          LOOP
            EXECUTE format('ALTER FUNCTION %s OWNER TO daftar_migrator', r.sig);
          END LOOP;
        END $$;
      `);

      const check = scratchPool(migratorUrl);
      try {
        expect(
          (
            await check.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
              `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
            )
          ).rows[0],
        ).toEqual({ rolname: 'daftar_migrator', rolsuper: false, rolbypassrls: false });

        // The migrator may NOT install an extension here, and does not need
        // to. Stated as a measurement rather than as a belief: this is the
        // exact call 0049 would have had to make if bootstrap had not.
        expect((await check.query<{ c: boolean }>(`SELECT has_database_privilege(current_user, $1, 'CREATE') AS c`, [db])).rows[0]?.c).toBe(false);

        expect(await runMigrations(migratorUrl)).toEqual(['0049_accounting_periods.sql']);
        expect(await runMigrations(migratorUrl)).toEqual([]);

        // ── Everything below is read through the NON-SUPERUSER connection ──

        // §12 — a REAL exclusion constraint, not a unique index and not an
        // application convention. `contype = 'x'` is the whole point.
        expect(
          (
            await check.query<{ conname: string; contype: string }>(
              `SELECT conname, contype FROM pg_constraint WHERE conrelid = 'accounting_periods'::regclass AND contype = 'x'`,
            )
          ).rows,
        ).toEqual([{ conname: 'accounting_periods_no_overlap', contype: 'x' }]);

        // §23 — the posting refusal arrived as a trigger on `journal_entries`
        // itself, so it holds for every writer, including a direct INSERT.
        expect(
          (
            await check.query<{ t: string }>(
              `SELECT tgname AS t FROM pg_trigger WHERE tgrelid = 'journal_entries'::regclass AND NOT tgisinternal AND tgname = 'accounting_period_guard'`,
            )
          ).rows,
        ).toHaveLength(1);

        // §35 — RLS enabled AND forced. Forced matters especially here,
        // because the table's owner is a DAFTAR principal rather than
        // postgres, and an owner is exempt from its own policies otherwise.
        for (const table of ['accounting_periods', 'accounting_period_operations']) {
          expect(
            (await check.query<{ e: boolean; f: boolean }>(`SELECT relrowsecurity AS e, relforcerowsecurity AS f FROM pg_class WHERE relname = $1`, [table]))
              .rows[0],
            table,
          ).toEqual({ e: true, f: true });
        }

        // The ownership handover happened through ordinary privilege rules:
        // the migrator is a MEMBER of the internal principal, which is how a
        // non-superuser may give an object away. Eight elevated routines, by
        // name — a count alone would pass if the wrong eight were listed.
        expect(
          (
            await check.query<{ proname: string }>(
              `SELECT p.proname FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                 JOIN pg_roles o ON o.oid = p.proowner
                WHERE n.nspname = 'public' AND o.rolname = 'daftar_accounting_internal'
                  AND p.proname LIKE 'accounting_period%' ORDER BY p.proname`,
            )
          ).rows.map((r) => r.proname),
        ).toEqual([
          'accounting_period_canonical',
          'accounting_period_close',
          'accounting_period_create',
          'accounting_period_fingerprint',
          'accounting_period_guard_posting',
          'accounting_period_reason_digest',
          'accounting_period_reopen',
          'accounting_period_topology_check',
          'accounting_period_topology_lock_key',
        ]);

        // §35, §12 — the temporary CREATE on the schema is gone, and no
        // DAFTAR role acquired BYPASSRLS on the way through.
        expect((await check.query<{ c: boolean }>(`SELECT has_schema_privilege('daftar_accounting_internal', 'public', 'CREATE') AS c`)).rows[0]?.c).toBe(
          false,
        );
        expect((await check.query(`SELECT 1 FROM pg_roles WHERE rolname LIKE 'daftar\\_%' AND rolbypassrls`)).rows).toEqual([]);

        // §9 — and after all of that, not one period exists. The migration
        // installed the machinery and activated nothing.
        await check.query(`SET ROLE daftar_accounting_internal`);
        expect((await check.query<{ n: number }>(`SELECT count(*)::int AS n FROM accounting_periods`)).rows[0]?.n).toBe(0);
        await check.query(`RESET ROLE`);
      } finally {
        await check.end().catch(() => undefined);
      }
    } finally {
      await setup.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => undefined);
    }
  }, 180_000);

  /**
   * P2-S6 §42 — a FRESH database, `0000` through `0049` in one sweep.
   *
   * Every case above starts from a checkpoint, which is what an existing
   * deployment does. A brand-new one starts from nothing, and the two are not
   * the same path: 0049 reaches for objects that ten earlier migrations
   * built, and an ordering mistake shows here rather than in an upgrade that
   * happened to have them already.
   *
   * This one runs as the deployment administrator on purpose. `0000`–`0039`
   * are FROZEN and still contain `ALTER FUNCTION ... OWNER TO daftar_platform`,
   * which a non-superuser cannot execute unless a RUNTIME role is granted
   * CREATE on the schema — a pre-existing Phase 1 limitation recorded in
   * docs/PHASE_2_S1_ACCEPTANCE.md, and one P2-S6 may not fix by reopening a
   * frozen file or by widening a runtime role. The managed-credential
   * question for 0049 itself is answered by the 0048-boundary case above,
   * which is the path a managed deployment actually walks.
   */
  it('applies 0000 through 0049 on a fresh database, ending at 0049 with no 0050 and a no-op rerun (P2-S6 §42)', async () => {
    await ensurePostgres();
    const db = 'daftar_portability_fresh';
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db}`);
    const url = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${db}`;

    const pool = scratchPool(url);
    try {
      await pool.query(bootstrapSql());

      const applied = await runMigrations(url);
      expect(applied[0]).toBe('0000_extensions.sql');
      expect(applied.at(-1)).toBe('0049_accounting_periods.sql');
      // §8 — 0049 is the LAST migration. No 0050 exists, and none is created.
      expect(applied.filter((f) => f >= '0050')).toEqual([]);
      expect(new Set(applied).size).toBe(applied.length);

      // The period machinery is there, on a schema nothing upgraded into.
      expect(
        (await pool.query<{ conname: string }>(`SELECT conname FROM pg_constraint WHERE conrelid = 'accounting_periods'::regclass AND contype = 'x'`)).rows.map(
          (r) => r.conname,
        ),
      ).toEqual(['accounting_periods_no_overlap']);
      expect((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM accounting_periods`)).rows[0]?.n).toBe(0);

      // Second run does nothing.
      expect(await runMigrations(url)).toEqual([]);
    } finally {
      await pool.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => undefined);
    }
  }, 300_000);

  /**
   * P2-S6 §42 — a failing migration leaves NOTHING behind.
   *
   * The runner wraps each file in its own transaction, so this should hold.
   * "Should" is the reason to measure it: a migration that stepped outside
   * that transaction — `CREATE INDEX CONCURRENTLY`, a `COMMIT` in a DO block,
   * a dblink — would leave a half-built schema AND an unrecorded file, and
   * the next run would then apply the successful half of it twice.
   *
   * The failing file is a FIXTURE written into a temporary directory. No
   * failure is introduced into a real migration, and nothing in
   * `infrastructure/database/migrations` is touched.
   */
  it('rolls a failing migration back entirely, recording nothing and leaving no object (P2-S6 §42)', async () => {
    await ensurePostgres();
    const db = 'daftar_portability_rollback';
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db}`);
    const url = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${db}`;

    const pool = scratchPool(url);
    const dir = migrationsUpTo('0049_accounting_periods.sql');
    try {
      await pool.query(bootstrapSql());
      await runMigrations(url, dir);

      // A candidate that creates a table and THEN fails, after the statement
      // that would be visible if the transaction were not real.
      writeFileSync(
        join(dir, '0099_deliberately_failing_fixture.sql'),
        `CREATE TABLE portability_rollback_probe (id INTEGER PRIMARY KEY);
         INSERT INTO portability_rollback_probe (id) VALUES (1);
         SELECT 1 / 0;
        `,
        'utf8',
      );

      await expect(runMigrations(url, dir)).rejects.toThrow(/division by zero/i);

      // Neither half survived: not the table, and not the history row.
      expect((await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'portability_rollback_probe'`)).rows).toEqual([]);
      expect((await pool.query(`SELECT 1 FROM schema_migrations WHERE name = '0099_deliberately_failing_fixture.sql'`)).rows).toEqual([]);

      // And the migrations that DID apply are still recorded, so removing the
      // bad file makes the next run a clean no-op rather than a replay.
      expect((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '0049_accounting_periods.sql'`)).rows[0]?.n).toBe(
        1,
      );
      rmSync(join(dir, '0099_deliberately_failing_fixture.sql'), { force: true });
      expect(await runMigrations(url, dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await pool.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => undefined);
    }
  }, 300_000);

  it('leaves no temporary privilege behind and no runtime principal with chart authority', async () => {
    // Read entirely through the non-superuser connection: if daftar_migrator
    // can see it, so can a deployment operator.
    const migrator = scratchPool(migratorScratchUrl);
    try {
      // The section 5b CREATE grant is gone.
      expect((await migrator.query<{ c: boolean }>(`SELECT has_schema_privilege('daftar_accounting_internal', 'public', 'CREATE') AS c`)).rows[0]?.c).toBe(
        false,
      );

      // PUBLIC holds no EXECUTE on any accounting routine.
      //
      // Asked with has_function_privilege, not by looking for a `=…` entry in
      // proacl: a function nobody has granted or revoked has a NULL acl and
      // PUBLIC can execute it, so an acl-shaped test passes VACUOUSLY on
      // exactly the function whose REVOKE silently did nothing. That is not a
      // hypothetical — under a non-superuser migrator holding membership
      // WITH INHERIT FALSE, a REVOKE issued after the ownership transfer
      // matches no grantor and PostgreSQL only warns.
      const open = (
        await migrator.query<{ proname: string }>(
          `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public'
              AND p.proname IN ('accounting_seed_chart','accounting_seed_chart_trg','accounting_post_entry','accounting_actor',
                                'accounting_canonical_line','accounting_fingerprint','accounting_assertion_key_install',
                                'accounting_assertion_key_retire','accounting_account_lock_key','accounts_posting_stability')
              AND has_function_privilege('public', p.oid, 'EXECUTE')
            ORDER BY p.proname`,
        )
      ).rows.map((r) => r.proname);
      expect(open).toEqual([]);

      // No runtime role can write the chart or call the routine.
      for (const role of RUNTIME_ROLES) {
        const { rows } = await migrator.query<{ ins: boolean; upd: boolean; del: boolean; exe: boolean }>(
          `SELECT has_table_privilege($1, 'accounts', 'INSERT') AS ins,
                  has_table_privilege($1, 'accounts', 'UPDATE') AS upd,
                  has_table_privilege($1, 'accounts', 'DELETE') AS del,
                  has_function_privilege($1, 'accounting_seed_chart(uuid)', 'EXECUTE') AS exe`,
          [role],
        );
        expect(rows[0], `${role} must hold no chart authority`).toEqual({ ins: false, upd: false, del: false, exe: false });
      }

      // Nobody holds a GRANTED UPDATE or DELETE — the internal principal
      // included. The table's owner is excluded because PostgreSQL gives an
      // owner full rights on what it created and there is no way to refuse
      // them; that owner is the deployment migrator, which is exactly why its
      // credential is never loaded by a service. Assert who it is.
      const owner = (await migrator.query<{ owner: string }>(`SELECT tableowner AS owner FROM pg_tables WHERE tablename = 'accounts'`)).rows[0];
      expect(owner?.owner).toBe('daftar_migrator');
      const writers = (
        await migrator.query<{ grantee: string; privilege_type: string }>(
          `SELECT grantee, privilege_type FROM information_schema.role_table_grants
            WHERE table_name = 'accounts' AND privilege_type IN ('UPDATE','DELETE','TRUNCATE')
              AND grantee LIKE 'daftar_%' AND grantee <> 'daftar_migrator'`,
        )
      ).rows;
      expect(writers).toEqual([]);

      // The internal principal's ONLY member is the deployment migrator.
      const members = (
        await migrator.query<{ member: string }>(
          `SELECT m.rolname AS member FROM pg_auth_members a
             JOIN pg_roles g ON g.oid = a.roleid
             JOIN pg_roles m ON m.oid = a.member
            WHERE g.rolname = 'daftar_accounting_internal' ORDER BY m.rolname`,
        )
      ).rows;
      expect(members.map((m) => m.member)).toEqual(['daftar_migrator']);

      // And that membership grants nothing by inheritance: it must be assumed.
      const grant = (
        await migrator.query<{ admin_option: boolean; inherit_option: boolean; set_option: boolean }>(
          `SELECT a.admin_option, a.inherit_option, a.set_option FROM pg_auth_members a
             JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
            WHERE g.rolname = 'daftar_accounting_internal' AND m.rolname = 'daftar_migrator'`,
        )
      ).rows[0];
      expect(grant).toEqual({ admin_option: false, inherit_option: false, set_option: true });

      // The internal principal is still unreachable.
      const internal = (
        await migrator.query<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean; rolinherit: boolean }>(
          `SELECT rolcanlogin, rolsuper, rolbypassrls, rolinherit FROM pg_roles WHERE rolname = 'daftar_accounting_internal'`,
        )
      ).rows[0];
      expect(internal).toEqual({ rolcanlogin: false, rolsuper: false, rolbypassrls: false, rolinherit: false });
    } finally {
      await migrator.end();
    }
  });
});
