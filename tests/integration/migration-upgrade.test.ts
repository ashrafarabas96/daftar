import { mkdtempSync, rmSync, cpSync, readdirSync, readFileSync } from 'node:fs';
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
  ensurePostgres,
} from '../helpers/test-app';

/**
 * Terminal Closure §13–16: the upgrade path from the PRE-ENCRYPTION schema
 * must be safe. A database sitting at migration 0024 holding legacy
 * pending/failed plaintext deliveries must migrate to latest without a
 * constraint violation — and no plaintext secret may survive.
 */
const SCRATCH_DB = 'daftar_upgrade_test';
const scratchUrl = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${SCRATCH_DB}`;

function bootstrapSql(): string {
  return readFileSync(join(__dirname, '../../infrastructure/database/bootstrap.sql'), 'utf8')
    .replaceAll('__APP_DB_PASSWORD__', APP_DB_PASSWORD)
    .replaceAll('__PLATFORM_DB_PASSWORD__', PLATFORM_DB_PASSWORD)
    .replaceAll('__WORKER_DB_PASSWORD__', WORKER_DB_PASSWORD)
    .replaceAll('__RESOLVER_DB_PASSWORD__', RESOLVER_DB_PASSWORD)
    .replaceAll('__IDENTITY_DB_PASSWORD__', IDENTITY_DB_PASSWORD);
}

/** Copy migration files up to (and including) `upTo` into a temp dir. */
function migrationsUpTo(upTo: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'daftar-mig-'));
  for (const f of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    if (f <= upTo) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
  }
  return dir;
}

/**
 * Every scratch database in this suite is torn down with
 * `DROP DATABASE ... WITH (FORCE)`, which terminates whatever backend is still
 * attached. `pg` surfaces that termination on the POOL, and a pool with no
 * `error` listener re-throws it as an uncaught exception — which vitest counts
 * as a run failure even when every test passed, and which then fails the gate
 * that runs this suite. The connection is being torn down on purpose, so the
 * listener is the correct response, not a swallowed defect: the queries
 * themselves are all awaited, and a real query failure still rejects.
 */
function scratchPool(connectionString: string, max = 1): Pool {
  const pool = new Pool({ connectionString, max });
  pool.on('error', () => undefined);
  return pool;
}

const admin = scratchPool(dbUrl);

describe('migration upgrade path: pre-encryption schema → latest (§13–16)', () => {
  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  });

  it('legacy plaintext deliveries survive the upgrade as reissue_required — no plaintext remains', async () => {
    await ensurePostgres();
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

    const pool = scratchPool(scratchUrl, 2);
    try {
      await pool.query(bootstrapSql());

      // 1) Migrate to the PRE-ENCRYPTION schema (through 0024).
      const preDir = migrationsUpTo('0024_role_crud_grants.sql');
      const pre = await runMigrations(scratchUrl, preDir);
      expect(pre.length).toBeGreaterThan(0);
      rmSync(preDir, { recursive: true, force: true });

      // 2) Insert representative legacy rows (plaintext secrets, as pre-0025).
      const user = (
        await pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, display_name) VALUES ('upgrade@test.dev', 'x', 'Upgrade') RETURNING id`)
      ).rows[0];
      const prt = (
        await pool.query<{ id: string }>(
          `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
           VALUES ($1, 'hash-upgrade-reset', now() + interval '1 hour') RETURNING id`,
          [user?.id],
        )
      ).rows[0];
      await pool.query(
        `INSERT INTO credential_deliveries (kind, password_reset_token_id, email, secret, status)
         VALUES ('password_reset', $1, 'upgrade@test.dev', 'PLAINTEXT-RESET-SECRET', 'pending')`,
        [prt?.id],
      );

      const tenant = (await pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0];
      const biz = (
        await pool.query<{ id: string }>(
          `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
           VALUES ($1, 'Upgrade Biz', 'upgrade-biz', 'JO', 'JOD', 'Asia/Amman') RETURNING id`,
          [tenant?.id],
        )
      ).rows[0];
      const role = (
        await pool.query<{ id: string }>(`INSERT INTO business_roles (business_id, key, name, is_system) VALUES ($1, 'clerk', 'Clerk', false) RETURNING id`, [
          biz?.id,
        ])
      ).rows[0];
      const inv = (
        await pool.query<{ id: string }>(
          `INSERT INTO business_invitations (business_id, email, role_id, token_hash, invited_by, expires_at)
           VALUES ($1, 'invited@test.dev', $2, 'hash-upgrade-invite', $3, now() + interval '7 days') RETURNING id`,
          [biz?.id, role?.id, user?.id],
        )
      ).rows[0];
      await pool.query(
        `INSERT INTO credential_deliveries (kind, business_id, invitation_id, email, secret, status)
         VALUES ('invitation', $1, $2, 'invited@test.dev', 'PLAINTEXT-INVITE-SECRET', 'pending')`,
        [biz?.id, inv?.id],
      );
      await pool.query(
        `INSERT INTO credential_deliveries (kind, password_reset_token_id, email, secret, status, attempts, last_error)
         VALUES ('password_reset', $1, 'upgrade@test.dev', 'PLAINTEXT-FAILED-SECRET', 'failed', 2, 'smtp timeout')`,
        [prt?.id],
      );
      await pool.query(
        `INSERT INTO credential_deliveries (kind, password_reset_token_id, email, secret, status, attempts)
         VALUES ('password_reset', $1, 'upgrade@test.dev', 'PLAINTEXT-SENT-SECRET', 'sent', 1)`,
        [prt?.id],
      );

      // 3) Upgrade to latest (0025 + 0026+) — MUST succeed.
      const applied = await runMigrations(scratchUrl);
      expect(applied).toContain('0025_credential_payload_protection.sql');

      // 4) No plaintext column, no plaintext anywhere.
      const cols = await pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'credential_deliveries'`);
      expect(cols.rows.map((c) => c.column_name)).not.toContain('secret');

      const rows = (
        await pool.query<{ status: string; last_error: string | null; secret_ciphertext: string | null }>(
          `SELECT status, last_error, secret_ciphertext FROM credential_deliveries ORDER BY created_at`,
        )
      ).rows;
      expect(rows).toHaveLength(4);
      // Non-terminal legacy rows parked in a terminal-equivalent state.
      const parked = rows.filter((r) => r.status === 'reissue_required');
      expect(parked).toHaveLength(3);
      for (const r of parked) {
        expect(r.secret_ciphertext).toBeNull();
        expect(r.last_error).toContain('reissue required');
      }
      // Terminal rows untouched in state, payload gone.
      const sent = rows.filter((r) => r.status === 'sent');
      expect(sent).toHaveLength(1);
      expect(sent[0]?.secret_ciphertext).toBeNull();

      // 5) The worker never claims reissue_required rows (claim predicate check).
      const claimable = (
        await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM credential_deliveries
           WHERE (status IN ('pending','failed') AND next_attempt_at <= now())
              OR (status = 'processing' AND lease_until < now())`,
        )
      ).rows[0];
      expect(claimable?.n).toBe(0);

      // 6) The new payload CHECK still admits a fresh encrypted enqueue shape.
      await pool.query(
        `INSERT INTO credential_deliveries (kind, password_reset_token_id, email, secret_ciphertext, secret_nonce, key_version)
         VALUES ('password_reset', $1, 'upgrade@test.dev', 'ct', 'nn', 'v1')`,
        [prt?.id],
      );
    } finally {
      await pool.end();
    }
  }, 180_000);

  it('compatibility matrix (§V): 0026-checkpoint → latest, then migrate is a no-op', async () => {
    await ensurePostgres();
    const db2 = 'daftar_upgrade_0026';
    await admin.query(`DROP DATABASE IF EXISTS ${db2} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db2}`);
    const url2 = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${db2}`;
    const pool = scratchPool(url2);
    try {
      await pool.query(bootstrapSql());
      const preDir = migrationsUpTo('0026_versioned_trial_override_shape_ownership.sql');
      await runMigrations(url2, preDir);
      rmSync(preDir, { recursive: true, force: true });
      // Representative 0026-state data: a published plan version exists with trial_days.
      const pv = (
        await pool.query<{ state: string; trial_days: number }>(`SELECT state, trial_days FROM plan_versions WHERE plan_key = 'free' ORDER BY version`)
      ).rows;
      expect(pv.length).toBeGreaterThan(0);
      // Upgrade to latest.
      const applied = await runMigrations(url2);
      expect(applied).toContain('0027_plan_version_immutability_hardening.sql');
      // Second run is a no-op (idempotent) and never a checksum failure.
      const again = await runMigrations(url2);
      expect(again).toEqual([]);
      // Published rows remain frozen under the hardened lifecycle.
      const pub = (await pool.query<{ id: string }>(`SELECT id FROM plan_versions WHERE state = 'PUBLISHED' LIMIT 1`)).rows[0];
      if (pub) {
        await expect(pool.query(`UPDATE plan_versions SET trial_days = 3 WHERE id = $1`, [pub.id])).rejects.toThrow();
      }
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${db2} WITH (FORCE)`).catch(() => undefined);
    }
  }, 180_000);

  /**
   * P2-S1 (directive §25): a database parked at 0039 with a real tenant and
   * business must take 0040/0041 and come out with a complete, correctly
   * typed, active chart, consistent permissions, and a second run that does
   * nothing. This is the upgrade path every existing deployment will take.
   */
  it('compatibility matrix (P2-S1 §25): 0039-checkpoint + existing business → 0040/0041 chart + permissions, rerun no-op', async () => {
    await ensurePostgres();
    const db4 = 'daftar_upgrade_0039';
    await admin.query(`DROP DATABASE IF EXISTS ${db4} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db4}`);
    const url4 = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${db4}`;
    const pool = scratchPool(url4);
    try {
      await pool.query(bootstrapSql());
      const preDir = migrationsUpTo('0039_catalog_identifiers_owner_integrity.sql');
      await runMigrations(url4, preDir);
      rmSync(preDir, { recursive: true, force: true });

      // Nothing accounting exists at 0039 — the checkpoint must be honest.
      const before = await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'accounts'`);
      expect(before.rows).toEqual([]);

      // Two existing businesses in two tenants, each with a system owner role.
      const businesses: string[] = [];
      for (const slug of ['upgrade-acct-one', 'upgrade-acct-two']) {
        const tenant = (await pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0];
        const biz = (
          await pool.query<{ id: string }>(
            `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
             VALUES ($1, $2, $2, 'JO', 'JOD', 'Asia/Amman') RETURNING id`,
            [tenant?.id, slug],
          )
        ).rows[0];
        if (!biz) throw new Error('business fixture insert failed');
        businesses.push(biz.id);
        // The 0006 system-role guard admits only the platform principal, so
        // this fixture creates the owner role the way provisioning would —
        // with row triggers detached for the fixture insert alone.
        await pool.query('BEGIN');
        await pool.query(`SET LOCAL session_replication_role = replica`);
        const role = (
          await pool.query<{ id: string }>(`INSERT INTO business_roles (business_id, key, name, is_system) VALUES ($1, 'owner', 'Owner', true) RETURNING id`, [
            biz.id,
          ])
        ).rows[0];
        await pool.query('COMMIT');
        await pool.query(`INSERT INTO role_permissions (business_id, role_id, permission) VALUES ($1, $2, 'business.view')`, [biz.id, role?.id]);
        await pool.query(`INSERT INTO business_roles (business_id, key, name, is_system) VALUES ($1, 'cashier', 'Cashier', false)`, [biz.id]);
      }

      // Apply every migration after the checkpoint, one slice after another.
      // The supported upgrade path is 0039 → latest, not 0039 → 0041 and not
      // 0039 → 0043; a deployment that has been away for several slices takes
      // exactly one path, and this is it.
      const applied = await runMigrations(url4);
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
      ]);

      // Every existing business now holds all 21 required system accounts,
      // active, correctly typed, and owned by its own tenant.
      const charts = (
        await pool.query<{ id: string; n: number }>(
          `SELECT b.id,
                  (SELECT count(*)::int FROM accounts a
                   JOIN accounting_system_account_keys k ON k.system_key = a.system_key AND k.account_type = a.type
                   WHERE a.business_id = b.id AND a.is_active AND a.tenant_id = b.tenant_id) AS n
           FROM businesses b ORDER BY b.store_slug`,
        )
      ).rows;
      expect(charts).toHaveLength(2);
      for (const c of charts) expect(c.n).toBe(21);
      expect(charts.map((c) => c.id).sort()).toEqual([...businesses].sort());

      // Permissions: owner roles carry the five accounting keys, cashier none.
      const owner = (
        await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM role_permissions rp
           JOIN business_roles r ON r.business_id = rp.business_id AND r.id = rp.role_id
           WHERE r.is_system AND r.key = 'owner' AND rp.permission LIKE 'accounting.%'`,
        )
      ).rows[0];
      expect(owner?.n).toBe(10); // 5 keys × 2 businesses
      const others = (
        await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM role_permissions rp
           JOIN business_roles r ON r.business_id = rp.business_id AND r.id = rp.role_id
           WHERE NOT (r.is_system AND r.key = 'owner') AND rp.permission LIKE 'accounting.%'`,
        )
      ).rows[0];
      expect(others?.n).toBe(0);
      // Period permissions stay absent (P2-S6).
      const period = await pool.query(`SELECT 1 FROM role_permissions WHERE permission LIKE 'accounting.period.%'`);
      expect(period.rows).toEqual([]);

      // Creating a business AFTER the upgrade gets its chart in the same transaction.
      const t3 = (await pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0];
      const b3 = (
        await pool.query<{ id: string }>(
          `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
           VALUES ($1, 'After', 'upgrade-acct-after', 'JO', 'JOD', 'Asia/Amman') RETURNING id`,
          [t3?.id],
        )
      ).rows[0];
      const n3 = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM accounts WHERE business_id = $1`, [b3?.id])).rows[0];
      expect(n3?.n).toBe(21);

      // financial_started_at was never touched by any of this.
      const started = await pool.query(`SELECT 1 FROM businesses WHERE financial_started_at IS NOT NULL`);
      expect(started.rows).toEqual([]);

      // Second run is a no-op, and the chart is not re-seeded or duplicated.
      expect(await runMigrations(url4)).toEqual([]);
      const total = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM accounts`)).rows[0];
      expect(total?.n).toBe(63); // 3 businesses × 21
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${db4} WITH (FORCE)`).catch(() => undefined);
    }
  }, 180_000);

  /**
   * P2-S2/P2-S3 (directive §41, §73): the upgrade path every deployment that
   * already ran P2-S1 will take. The checkpoint is the FROZEN P2-S1 boundary —
   * 0041 — and what follows must be exactly the six migrations of the three
   * slices since, must leave the journal writable by no RUNTIME credential,
   * and must be a no-op on a second run.
   *
   * The "writable by nobody" of P2-S2 became "writable only by the posting
   * primitive" in P2-S3, so the assertion below now distinguishes the two
   * principal classes rather than asserting a sentence that was true only
   * while no writer had shipped.
   */
  it('compatibility matrix (P2-S2 §41 / P2-S3 §73 / P2-S4 §52 / P2-S5 §71): frozen 0041-checkpoint + existing business → 0042…0048, one writer per slice, rerun no-op', async () => {
    await ensurePostgres();
    const db5 = 'daftar_upgrade_0041';
    await admin.query(`DROP DATABASE IF EXISTS ${db5} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db5}`);
    const url5 = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${db5}`;
    const pool = scratchPool(url5);
    try {
      await pool.query(bootstrapSql());
      const preDir = migrationsUpTo('0041_accounting_permissions.sql');
      await runMigrations(url5, preDir);
      rmSync(preDir, { recursive: true, force: true });

      // The checkpoint must be honest in both directions: the chart is there,
      // the journal is not.
      expect((await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'accounts'`)).rows).toHaveLength(1);
      for (const table of [
        'journal_entries',
        'journal_lines',
        'accounting_source_bindings',
        'accounting_source_types',
        'accounting_system_actors',
        'accounting_assertion_keys',
        'accounting_assertion_uses',
      ]) {
        expect((await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = $1`, [table])).rows, table).toEqual([]);
      }

      // A business that existed before the journal did.
      const tenant = (await pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0];
      const biz = (
        await pool.query<{ id: string }>(
          `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
           VALUES ($1, 'Before Journal', 'upgrade-journal', 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
          [tenant?.id],
        )
      ).rows[0];
      expect((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM accounts WHERE business_id = $1`, [biz?.id])).rows[0]?.n).toBe(21);

      // Exactly the migrations of P2-S2, P2-S3, P2-S4 and P2-S5 follow the
      // frozen P2-S1 boundary, in order.
      expect(await runMigrations(url5)).toEqual([
        '0042_accounting_journal.sql',
        '0043_accounting_invariants.sql',
        '0044_accounting_assertion_keys.sql',
        '0045_accounting_post_entry.sql',
        '0046_accounting_sources.sql',
        '0047_accounting_opening_balances.sql',
        '0048_accounting_fx_rates.sql',
      ]);

      // The closed registries came out with the shape the slice specifies:
      // three source types, and no system actor at all (AL-04 invents nobody).
      expect((await pool.query<{ t: string }>(`SELECT source_type AS t FROM accounting_source_types ORDER BY sort_order`)).rows.map((r) => r.t)).toEqual([
        'opening_balance',
        'manual_adjustment',
        'reversal',
      ]);
      expect((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM accounting_system_actors`)).rows[0]?.n).toBe(0);
      // P2-S5 §28: entering a rate is not a journal fact, so it registers no
      // source type. A registry that grew here would mean the FX slice had
      // quietly claimed the ability to post.
      expect((await pool.query(`SELECT 1 FROM accounting_source_types WHERE source_type LIKE 'fx%'`)).rows).toEqual([]);

      // Both deferred validators and both binding directions survived the
      // upgrade path, not just a fresh install.
      const triggers = (
        await pool.query<{ t: string }>(
          `SELECT tgname AS t FROM pg_trigger WHERE tgname IN ('journal_entry_validate', 'journal_line_validate') AND tgdeferrable AND tginitdeferred ORDER BY 1`,
        )
      ).rows.map((r) => r.t);
      expect(triggers).toEqual(['journal_entry_validate', 'journal_line_validate']);
      const fks = (
        await pool.query<{ c: string }>(
          `SELECT conname AS c FROM pg_constraint
           WHERE conname IN ('accounting_source_bindings_entry_fk', 'journal_entries_binding_fk')
             AND contype = 'f' AND condeferrable AND condeferred ORDER BY 1`,
        )
      ).rows.map((r) => r.c);
      expect(fks).toEqual(['accounting_source_bindings_entry_fk', 'journal_entries_binding_fk']);

      // The upgrade must not have handed any RUNTIME credential the ability to
      // write, and must not have given even the internal posting authority the
      // ability to rewrite or destroy what it wrote. Every journal DML grant
      // that exists after the upgrade is named here, exactly.
      const writers = (
        await pool.query<{ g: string; p: string; t: string }>(
          `SELECT coalesce(r.rolname, 'PUBLIC') AS g, a.privilege_type AS p, c.relname AS t
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
             LEFT JOIN pg_roles r ON r.oid = a.grantee
            WHERE n.nspname = 'public'
              AND c.relname IN ('journal_entries', 'journal_lines', 'accounting_source_bindings')
              AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
              AND a.grantee <> c.relowner
            ORDER BY c.relname, g, a.privilege_type`,
        )
      ).rows;
      expect(writers).toEqual([
        { g: 'daftar_accounting_internal', p: 'INSERT', t: 'accounting_source_bindings' },
        { g: 'daftar_accounting_internal', p: 'INSERT', t: 'journal_entries' },
        { g: 'daftar_accounting_internal', p: 'INSERT', t: 'journal_lines' },
      ]);

      // The one writer arrived, and it is reachable only by executing the
      // posting primitive: the internal principal cannot log in, and the
      // primitive is callable by the merchant runtime alone — not by the
      // platform credential, and not by PUBLIC.
      expect(
        (
          await pool.query<{ n: string }>(`SELECT proname AS n FROM pg_proc WHERE proname IN ('accounting_post_entry', 'accounting_actor') ORDER BY 1`)
        ).rows.map((r) => r.n),
      ).toEqual(['accounting_actor', 'accounting_post_entry']);
      expect((await pool.query<{ l: boolean }>(`SELECT rolcanlogin AS l FROM pg_roles WHERE rolname = 'daftar_accounting_internal'`)).rows[0]?.l).toBe(false);
      const callers = (
        await pool.query<{ g: string }>(
          `SELECT coalesce(r.rolname, 'PUBLIC') AS g
             FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
             CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
             LEFT JOIN pg_roles r ON r.oid = a.grantee
            WHERE n.nspname = 'public' AND p.proname = 'accounting_post_entry'
              AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner
            ORDER BY 1`,
        )
      ).rows.map((r) => r.g);
      expect(callers).toEqual(['daftar_app']);

      // The chart alone still does not start the business's financial life.
      expect((await pool.query(`SELECT 1 FROM businesses WHERE financial_started_at IS NOT NULL`)).rows).toEqual([]);

      // Second run does nothing.
      expect(await runMigrations(url5)).toEqual([]);
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${db5} WITH (FORCE)`).catch(() => undefined);
    }
  }, 180_000);

  /**
   * P2-S5 §71 — the upgrade matrix for the FX slice, from the boundary that
   * actually exists in production: a database frozen at 0047.
   *
   * The questions are narrow on purpose. Does exactly ONE migration follow
   * (§9 allows no 0049)? Does it arrive with its protections already on,
   * rather than as a table somebody is expected to lock down afterwards? Does
   * a second run do nothing? And are the forty-eight frozen files still the
   * bytes the manifest recorded — checked against the history the migrator
   * itself wrote, not against the files this process just read.
   */
  it('compatibility matrix (P2-S5 §71): frozen 0047-checkpoint → 0048 alone, protected on arrival, rerun no-op', async () => {
    await ensurePostgres();
    const db6 = 'daftar_upgrade_0047';
    await admin.query(`DROP DATABASE IF EXISTS ${db6} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db6}`);
    const url6 = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${db6}`;
    const pool = scratchPool(url6);
    try {
      await pool.query(bootstrapSql());
      const preDir = migrationsUpTo('0047_accounting_opening_balances.sql');
      await runMigrations(url6, preDir);
      rmSync(preDir, { recursive: true, force: true });

      // The checkpoint is honest: the journal is there, the registry is not.
      expect((await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'journal_lines'`)).rows).toHaveLength(1);
      expect((await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'accounting_fx_rates'`)).rows).toEqual([]);

      // A business that existed before the registry did.
      const tenant = (await pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0];
      const biz = (
        await pool.query<{ id: string }>(
          `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
           VALUES ($1, 'Before FX', 'upgrade-fx', 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
          [tenant?.id],
        )
      ).rows[0];
      expect(biz?.id).toBeTypeOf('string');

      // Exactly one migration follows the frozen P2-S4 boundary.
      expect(await runMigrations(url6)).toEqual(['0048_accounting_fx_rates.sql']);

      // It arrived with row level security ENABLED and FORCED (§43): a table
      // that had to be secured in a later step would be readable across
      // businesses for however long that step took.
      const rls = (
        await pool.query<{ e: boolean; f: boolean }>(`SELECT relrowsecurity AS e, relforcerowsecurity AS f FROM pg_class WHERE relname = 'accounting_fx_rates'`)
      ).rows[0];
      expect(rls).toEqual({ e: true, f: true });

      // And with its immutability trigger (§18) and its routines (§26, §21).
      expect(
        (
          await pool.query<{ t: string }>(`SELECT tgname AS t FROM pg_trigger WHERE tgrelid = 'accounting_fx_rates'::regclass AND NOT tgisinternal ORDER BY 1`)
        ).rows.map((r) => r.t),
      ).toEqual(['accounting_fx_rates_no_mutation']);
      expect(
        (
          await pool.query<{ n: string }>(
            `SELECT proname AS n FROM pg_proc WHERE proname IN ('accounting_fx_rate_enter', 'accounting_fx_rate_lookup', 'accounting_control_actor') ORDER BY 1`,
          )
        ).rows.map((r) => r.n),
      ).toEqual(['accounting_control_actor', 'accounting_fx_rate_enter', 'accounting_fx_rate_lookup']);

      // Every DML grant on the new table that exists after the upgrade, named
      // exactly (§25, §44): one runtime READER, one internal writer, and no
      // UPDATE or DELETE for anybody at all.
      const grants = (
        await pool.query<{ g: string; p: string }>(
          `SELECT coalesce(r.rolname, 'PUBLIC') AS g, a.privilege_type AS p
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
             LEFT JOIN pg_roles r ON r.oid = a.grantee
            WHERE n.nspname = 'public' AND c.relname = 'accounting_fx_rates'
              AND a.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
              AND a.grantee <> c.relowner
            ORDER BY g, a.privilege_type`,
        )
      ).rows;
      expect(grants).toEqual([
        { g: 'daftar_accounting_internal', p: 'INSERT' },
        { g: 'daftar_accounting_internal', p: 'SELECT' },
        { g: 'daftar_app', p: 'SELECT' },
      ]);

      // The upgrade registered no source type (§28) and started nobody's
      // financial life.
      expect((await pool.query(`SELECT 1 FROM accounting_source_types WHERE source_type LIKE 'fx%'`)).rows).toEqual([]);
      expect((await pool.query(`SELECT 1 FROM businesses WHERE financial_started_at IS NOT NULL`)).rows).toEqual([]);

      // The forty-nine frozen files this database actually carries are
      // byte-for-byte what the manifest recorded, as the migrator recorded
      // them on the way in. The boundary is read as a FLOOR and the comparison
      // is capped at 0048: this database stops there, and a later authorized
      // slice freezing its own migration must not fail a test about this one.
      const manifest = JSON.parse(readFileSync(join(__dirname, '../../infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8')) as {
        frozenThrough: string;
        migrations: { name: string; sha256: string }[];
      };
      expect(manifest.frozenThrough >= '0048_accounting_fx_rates.sql').toBe(true);
      const frozen = manifest.migrations.filter((m) => m.name <= '0048_accounting_fx_rates.sql');
      expect(frozen).toHaveLength(49);
      const applied = new Map(
        (await pool.query<{ name: string; sha256: string }>(`SELECT name, sha256 FROM schema_migrations ORDER BY name`)).rows.map((r) => [r.name, r.sha256]),
      );
      for (const m of frozen) expect(applied.get(m.name), m.name).toBe(m.sha256);

      // Second run does nothing.
      expect(await runMigrations(url6)).toEqual([]);
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${db6} WITH (FORCE)`).catch(() => undefined);
    }
  }, 180_000);

  it('compatibility matrix (§54): 0035-checkpoint (JSONB translations, cross-table SKUs) → latest; content preserved, registry built, no-op rerun', async () => {
    await ensurePostgres();
    const db3 = 'daftar_upgrade_0035';
    await admin.query(`DROP DATABASE IF EXISTS ${db3} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db3}`);
    const url3 = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${db3}`;
    const pool = scratchPool(url3);
    try {
      await pool.query(bootstrapSql());
      const preDir = migrationsUpTo('0035_ownership_implication_and_indexes.sql');
      await runMigrations(url3, preDir);
      rmSync(preDir, { recursive: true, force: true });

      // Representative 0035-state data: JSONB translations, a product SKU and a
      // variant SKU that are distinct, an archived duplicate that must NOT
      // block the upgrade, and a category tree.
      const tenant = (await pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0];
      const biz = (
        await pool.query<{ id: string }>(
          `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
           VALUES ($1, 'Upgrade Cat', 'upgrade-cat', 'JO', 'JOD', 'Asia/Amman') RETURNING id`,
          [tenant?.id],
        )
      ).rows[0];
      const cat = (
        await pool.query<{ id: string }>(`INSERT INTO categories (business_id, translations) VALUES ($1, '{"ar":"مشروبات","en":"Drinks"}') RETURNING id`, [
          biz?.id,
        ])
      ).rows[0];
      const p1 = (
        await pool.query<{ id: string }>(
          `INSERT INTO products (business_id, category_id, translations, sku, barcode, base_price_minor, price_currency)
           VALUES ($1, $2, '{"ar":"قهوة","en":"Coffee","tr":"Kahve"}', 'COF-1', '111', 900719925474099399, 'JOD') RETURNING id`,
          [biz?.id, cat?.id],
        )
      ).rows[0];
      await pool.query(`INSERT INTO product_variants (business_id, product_id, sku, barcode) VALUES ($1, $2, 'COF-1-L', '222')`, [biz?.id, p1?.id]);
      await pool.query(
        `INSERT INTO products (business_id, translations, sku, base_price_minor, price_currency, status)
         VALUES ($1, '{"en":"Old"}', 'cof-1', 1, 'JOD', 'archived')`,
        [biz?.id],
      );

      const applied = await runMigrations(url3);
      const after0035 = readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql') && f.slice(0, 4) > '0035')
        .sort();
      expect(after0035[0]).toBe('0036_catalog_translations_normalized.sql');
      expect(applied).toEqual(after0035);
      expect(await runMigrations(url3)).toEqual([]);

      // Translations preserved exactly, JSONB gone.
      const tr = (
        await pool.query<{ locale: string; name: string }>(`SELECT locale, name FROM product_translations WHERE product_id = $1 ORDER BY locale`, [p1?.id])
      ).rows;
      expect(tr).toEqual([
        { locale: 'ar', name: 'قهوة' },
        { locale: 'en', name: 'Coffee' },
        { locale: 'tr', name: 'Kahve' },
      ]);
      const ctr = (
        await pool.query<{ locale: string; name: string }>(`SELECT locale, name FROM category_translations WHERE category_id = $1 ORDER BY locale`, [cat?.id])
      ).rows;
      expect(ctr).toEqual([
        { locale: 'ar', name: 'مشروبات' },
        { locale: 'en', name: 'Drinks' },
      ]);
      const cols = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name IN ('products','categories') AND column_name = 'translations'`);
      expect(cols.rows).toEqual([]);
      // Money survived the round trip exactly.
      const price = (await pool.query<{ p: string }>(`SELECT base_price_minor::text AS p FROM products WHERE id = $1`, [p1?.id])).rows[0];
      expect(price?.p).toBe('900719925474099399');

      // Registry: live identifiers only (archived duplicate excluded), cross-table.
      const reg = (
        await pool.query<{ kind: string; value_norm: string; owner_type: string }>(
          `SELECT kind, value_norm, owner_type FROM catalog_identifiers WHERE business_id = $1 ORDER BY kind, value_norm`,
          [biz?.id],
        )
      ).rows;
      expect(reg).toEqual([
        { kind: 'barcode', value_norm: '111', owner_type: 'product' },
        { kind: 'barcode', value_norm: '222', owner_type: 'variant' },
        { kind: 'sku', value_norm: 'cof-1', owner_type: 'product' },
        { kind: 'sku', value_norm: 'cof-1-l', owner_type: 'variant' },
      ]);
      // And it now enforces the cross-table rule for raw SQL.
      await expect(
        pool.query(
          `WITH p AS (INSERT INTO products (business_id, sku, base_price_minor, price_currency) VALUES ($1, 'cof-1-l', 1, 'JOD') RETURNING business_id, id)
           INSERT INTO product_translations (business_id, product_id, locale, name) SELECT business_id, id, 'en', 'x' FROM p`,
          [biz?.id],
        ),
      ).rejects.toThrow(/duplicate key/);
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${db3} WITH (FORCE)`).catch(() => undefined);
    }
  }, 180_000);
});
