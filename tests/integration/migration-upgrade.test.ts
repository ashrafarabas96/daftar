import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, cpSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
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
  // P3-S4 (0063/0064): the T-17 case runs real signed commands at the 0062 checkpoint.
  ACCOUNTING_ASSERTION_KEY_B64,
  ACCOUNTING_ASSERTION_KID,
  INVENTORY_ASSERTION_KEY_B64,
  INVENTORY_ASSERTION_KID,
} from '../helpers/test-app';
import { must, runCommand, seedS3Business, today, transferCommand } from '../helpers/inventory-commands';
import { stockUp } from '../helpers/inventory-posting';
// P3-S5 (0065/0066): the T-17 case receives a real purchase at the 0064 checkpoint.
import { createSupplier, draftAndReceive, draftCommand } from '../helpers/purchase-commands';
// P3-S6 (0067/0068): the P3-S6 case returns goods for a credit note at the 0066 checkpoint.
import { returnGoods } from '../helpers/purchase-returns';
import { installSettlementFixture } from '../helpers/purchase-settlement-fixture';
// P3-S8 (0069, pin 13): the S7-head checkpoint posts a manual Inventory line,
// reads every table's rows, and runs R-INV-01..05 as the reconciler.
import {
  assertionFor as accountingAssertionFor,
  postAs,
  postReversalAs,
  reversalFingerprintOf,
  sourceAssertion,
  type PostCommand,
} from '../helpers/accounting-posting';
import { resultOf, runChecks, statuses } from '../helpers/inventory-reconciliation';
import { P3C_ACCOUNTING_SOURCE_TYPES, P3C_REGISTRY_ROWS, P3C_RELATIONS, P3C_SOURCE_TYPE_ROWS } from '../helpers/p3c-migrations';
import { createScratchDb } from '../helpers/scratch-db';
import { expectAccepted, expectRefused, settle, type Outcome } from '../helpers/stock-ledger';
import { changedTables, rowCounts, tableDigest, type TableDigest } from '../helpers/table-digest';

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
 * Every migration on disk strictly after `after`.
 *
 * The matrices below name the frozen sequence exactly and in order, which is
 * the point of them: an upgrade from a checkpoint must apply those migrations,
 * those alone, in that order. What they must NOT do is pin the END of the
 * sequence, because a slice under review carries an unfrozen candidate the
 * frozen matrix knows nothing about. A permanent predecessor matrix that
 * failed the moment an authorized successor existed would not be protecting
 * the frozen history; it would be forbidding the next slice.
 *
 * So the assertion stays an equality — the frozen names, in order — and the
 * candidates the tree actually carries are appended to the expectation rather
 * than loosened out of it. If a candidate is frozen later, this returns one
 * fewer name and the frozen list one more, and the assertion is unchanged.
 */
function migrationsAfter(after: string): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && f > after)
    .sort();
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
        '0049_accounting_periods.sql',
        '0050_accounting_report_indexes.sql',
        ...migrationsAfter('0050_accounting_report_indexes.sql'),
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
      expect(owner?.n).toBe(14); // 7 keys × 2 businesses: the five of P2-S1 and the two of P2-S6
      const others = (
        await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM role_permissions rp
           JOIN business_roles r ON r.business_id = rp.business_id AND r.id = rp.role_id
           WHERE NOT (r.is_system AND r.key = 'owner') AND rp.permission LIKE 'accounting.%'`,
        )
      ).rows[0];
      expect(others?.n).toBe(0);
      // P2-S6 §21: the period backfill reached every existing owner role with
      // BOTH keys and nobody else's role with either. A backfill that wrote
      // only `manage` would quietly make closing the books imply undoing them.
      const period = (
        await pool.query<{ key: string; permission: string; n: number }>(
          `SELECT r.key, rp.permission, count(*)::int AS n FROM role_permissions rp
             JOIN business_roles r ON r.business_id = rp.business_id AND r.id = rp.role_id
            WHERE rp.permission LIKE 'accounting.period.%'
            GROUP BY r.key, rp.permission ORDER BY r.key, rp.permission`,
        )
      ).rows;
      expect(period).toEqual([
        { key: 'owner', permission: 'accounting.period.manage', n: 2 },
        { key: 'owner', permission: 'accounting.period.reopen', n: 2 },
      ]);

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
  it('compatibility matrix (P2-S2 §41 / P2-S3 §73 / P2-S4 §52 / P2-S5 §71 / P2-S6 §42): frozen 0041-checkpoint + existing business → 0042…0049, one writer per slice, rerun no-op', async () => {
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

      // Exactly the migrations of P2-S2, P2-S3, P2-S4, P2-S5 and P2-S6 follow
      // the frozen P2-S1 boundary, in order.
      expect(await runMigrations(url5)).toEqual([
        '0042_accounting_journal.sql',
        '0043_accounting_invariants.sql',
        '0044_accounting_assertion_keys.sql',
        '0045_accounting_post_entry.sql',
        '0046_accounting_sources.sql',
        '0047_accounting_opening_balances.sql',
        '0048_accounting_fx_rates.sql',
        '0049_accounting_periods.sql',
        '0050_accounting_report_indexes.sql',
        ...migrationsAfter('0050_accounting_report_indexes.sql'),
      ]);

      // The closed registries came out with the shape the slice specifies:
      // three source types, and no system actor at all (AL-04 invents nobody).
      // The upgrade runs to the latest migration, so the two inventory source
      // types P3-S3 registers (0061, contract A-14(e)) follow them, in order.
      // P3-S4 (0063/0064): then the two P3-S4 registers (0063, contract A-05), in order.
      // P3-S5 (0065/0066): then the one P3-S5 registers (0065, contract A-05;
      // R-B2a: `purchase_reversal` is a stock source type only).
      // P3-S6 (0067/0068): then the three P3-S6 registers (0067, contract A-05), in order.
      expect((await pool.query<{ t: string }>(`SELECT source_type AS t FROM accounting_source_types ORDER BY sort_order`)).rows.map((r) => r.t)).toEqual([
        'opening_balance',
        'manual_adjustment',
        'reversal',
        'inventory_adjustment',
        'inventory_opening',
        // P3-S4 (0063/0064)
        'purchase',
        'negative_inventory_cost_adjustment',
        // P3-S5 (0065/0066)
        'supplier_return',
        // P3-S6 (0067/0068)
        'supplier_payment',
        'supplier_credit_allocation',
        'supplier_refund',
        // Phase 3 corrective (0072 TD-16, R-96)
        ...P3C_ACCOUNTING_SOURCE_TYPES.map(([t]) => t),
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
   * The questions are narrow on purpose. Which migrations follow, exactly?
   * Does the FX registry arrive with its protections already on, rather than
   * as a table somebody is expected to lock down afterwards? Does a second
   * run do nothing? And are the forty-nine frozen files still the bytes the
   * manifest recorded — checked against the history the migrator itself
   * wrote, not against the files this process just read.
   *
   * P2-S6 added one name to the answer and changed nothing else about it: the
   * authorized successor 0049 follows 0048, and no 0050 exists to follow
   * that. The list is asserted whole rather than by a floor, so a stray
   * migration is a failure here rather than a surprise in production.
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

      // The frozen P2-S4 boundary is followed by 0048 and then by 0049, in
      // that order. A FLOOR, not an exact tail: what comes after them belongs
      // to the slice in flight, and an upgrade case pinned to the last
      // migration fails the next authorized one rather than the next upgrade
      // defect.
      const fromS4 = await runMigrations(url6);
      expect(fromS4.slice(0, 2)).toEqual(['0048_accounting_fx_rates.sql', '0049_accounting_periods.sql']);

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

  /**
   * P2-S6 §42 — the upgrade every deployment will actually perform: a
   * database frozen at 0048, and 0049 alone on top of it.
   *
   * The other cases above reach 0049 by sweeping several candidates onto a
   * schema the same run built moments earlier. This one starts where
   * production starts, at the accepted boundary, with a business that already
   * has books, and asks four things.
   *
   * Does exactly ONE migration follow — §8 allows no 0050? Does 0049 leave
   * the existing books ALONE (§28): no synthetic journal entry, no guessed
   * historical period, no business quietly given a financial start? Does the
   * new table arrive already protected, rather than as something a later step
   * is trusted to lock down? And does a second run do nothing?
   *
   * The §9 activation model is what makes the second question load-bearing.
   * A migration that invented a fiscal calendar for every existing merchant
   * would look harmless here and would start REFUSING their postings the
   * moment it shipped.
   */
  it('compatibility matrix (P2-S6 §42): frozen 0048-checkpoint + existing books → 0049 alone, activating nothing, rerun no-op', async () => {
    await ensurePostgres();
    const db7 = 'daftar_upgrade_0048';
    await admin.query(`DROP DATABASE IF EXISTS ${db7} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db7}`);
    const url7 = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${db7}`;
    const pool = scratchPool(url7);
    try {
      await pool.query(bootstrapSql());
      const preDir = migrationsUpTo('0048_accounting_fx_rates.sql');
      await runMigrations(url7, preDir);
      rmSync(preDir, { recursive: true, force: true });

      // The checkpoint is honest in both directions: the FX registry is
      // there, periods are not.
      expect((await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'accounting_fx_rates'`)).rows).toHaveLength(1);
      for (const table of ['accounting_periods', 'accounting_period_operations']) {
        expect((await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = $1`, [table])).rows, table).toEqual([]);
      }

      // A business that existed before periods did, with accounting data of
      // its own: the twenty-one seeded system accounts.
      const tenant = (await pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0];
      const biz = (
        await pool.query<{ id: string }>(
          `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
           VALUES ($1, 'Before Periods', 'upgrade-periods', 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
          [tenant?.id],
        )
      ).rows[0];
      expect((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM accounts WHERE business_id = $1`, [biz?.id])).rows[0]?.n).toBe(21);

      /**
       * A digest of everything §28 forbids 0049 to touch, taken before and
       * compared after.
       *
       * A digest rather than a row count, because a migration that rewrote a
       * date or an account type would leave the counts identical. This
       * database holds no journal rows — posting one takes the whole control
       * plane, which is not what a migration test is for — so the case where
       * the books are FULL is carried by `accounting-periods.test.ts`, whose
       * cluster holds real postings from every accounting suite and which
       * asserts there that 0049 created no period anywhere in it.
       */
      const protectedDigest = async (): Promise<string[]> => {
        const r = await pool.query<{ t: string }>(
          `SELECT t FROM (
             SELECT concat_ws(':', 'acc', id, business_id, code, type, system_key, is_active) AS t FROM accounts
             UNION ALL SELECT concat_ws(':', 'je', id, business_id, entry_date, source_type, source_id, status, posting_fingerprint) FROM journal_entries
             UNION ALL SELECT concat_ws(':', 'jl', id, journal_entry_id, account_id, debit_minor, credit_minor, base_amount_minor) FROM journal_lines
             UNION ALL SELECT concat_ws(':', 'bind', business_id, source_type, source_id, journal_entry_id) FROM accounting_source_bindings
             UNION ALL SELECT concat_ws(':', 'src', source_type, sort_order) FROM accounting_source_types
             UNION ALL SELECT concat_ws(':', 'fx', id, business_id, from_currency, to_currency, rate, effective_at) FROM accounting_fx_rates
             UNION ALL SELECT concat_ws(':', 'biz', id, tenant_id, base_currency, timezone, financial_started_at) FROM businesses
           ) x`,
        );
        // Every protected row itself, not a hash of them: a successor's exact
        // additions can then be named in the expectation instead of hidden.
        return r.rows.map((x) => x.t).sort();
      };
      const before = await protectedDigest();

      // 0049 is the first thing that follows the frozen P2-S5 boundary; a
      // later authorized candidate may follow it, and this case is not the
      // place that decides whether one exists.
      const fromS5 = await runMigrations(url7);
      expect(fromS5[0]).toBe('0049_accounting_periods.sql');

      // §28 — the books are exactly as they were, byte for byte, and no
      // business was quietly given a financial start. The one protected
      // change on the way to the latest migration is P3-S3's: 0061 appends
      // two source types (contract A-14(e)) and touches no other row.
      // P3-S4 (0063/0064): and P3-S4's — 0063 appends two more (contract A-05)
      // and likewise touches no other row.
      // P3-S5 (0065/0066): and P3-S5's — 0065 appends one more (contract A-05)
      // and likewise touches no other row.
      // P3-S6 (0067/0068): and P3-S6's — 0067 appends three more (contract
      // A-05) and likewise touches no other row.
      expect(await protectedDigest()).toEqual(
        [
          ...before,
          'src:inventory_adjustment:4',
          'src:inventory_opening:5',
          'src:purchase:6',
          'src:negative_inventory_cost_adjustment:7',
          // P3-S5 (0065/0066)
          'src:supplier_return:8',
          // P3-S6 (0067/0068)
          'src:supplier_payment:9',
          'src:supplier_credit_allocation:10',
          'src:supplier_refund:11',
          // Phase 3 corrective (0072 TD-16, R-96)
          ...P3C_SOURCE_TYPE_ROWS,
        ].sort(),
      );
      expect((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM journal_entries`)).rows[0]?.n).toBe(0);
      expect((await pool.query(`SELECT 1 FROM businesses WHERE financial_started_at IS NOT NULL`)).rows).toEqual([]);

      // §9 — and NOTHING is activated. Zero periods, for this business and
      // for every other: the migration guessed no fiscal calendar, so the
      // posting rules this merchant had yesterday are the ones they have
      // today. The first period they create themselves is what changes that.
      expect((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM accounting_periods`)).rows[0]?.n).toBe(0);
      expect((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM accounting_period_operations`)).rows[0]?.n).toBe(0);

      // The table arrived with row level security ENABLED and FORCED, with
      // its physical non-overlap constraint (§12) and with the posting guard
      // already on `journal_entries` (§23). A protection installed in a later
      // step is a window, however short.
      const rls = (
        await pool.query<{ e: boolean; f: boolean }>(`SELECT relrowsecurity AS e, relforcerowsecurity AS f FROM pg_class WHERE relname = 'accounting_periods'`)
      ).rows[0];
      expect(rls).toEqual({ e: true, f: true });
      expect(
        (
          await pool.query<{ t: string }>(
            `SELECT contype AS t FROM pg_constraint WHERE conrelid = 'accounting_periods'::regclass AND conname = 'accounting_periods_no_overlap'`,
          )
        ).rows.map((r) => r.t),
      ).toEqual(['x']);
      expect(
        (
          await pool.query<{ t: string }>(
            `SELECT tgname AS t FROM pg_trigger WHERE tgrelid = 'journal_entries'::regclass AND NOT tgisinternal AND tgname = 'accounting_period_guard'`,
          )
        ).rows,
      ).toHaveLength(1);

      // Every DML grant on the two new tables, named exactly (§35): the
      // runtime reads periods and nothing else, the internal principal writes
      // both, and NOBODY holds DELETE or TRUNCATE on either.
      const grants = (
        await pool.query<{ t: string; g: string; p: string }>(
          `SELECT c.relname AS t, coalesce(r.rolname, 'PUBLIC') AS g, a.privilege_type AS p
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
             LEFT JOIN pg_roles r ON r.oid = a.grantee
            WHERE n.nspname = 'public' AND c.relname IN ('accounting_periods', 'accounting_period_operations')
              AND a.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
              AND a.grantee <> c.relowner
            ORDER BY t, g, a.privilege_type`,
        )
      ).rows;
      expect(grants).toEqual([
        { t: 'accounting_period_operations', g: 'daftar_accounting_internal', p: 'INSERT' },
        { t: 'accounting_period_operations', g: 'daftar_accounting_internal', p: 'SELECT' },
        { t: 'accounting_periods', g: 'daftar_accounting_internal', p: 'INSERT' },
        { t: 'accounting_periods', g: 'daftar_accounting_internal', p: 'SELECT' },
        { t: 'accounting_periods', g: 'daftar_accounting_internal', p: 'UPDATE' },
        { t: 'accounting_periods', g: 'daftar_app', p: 'SELECT' },
      ]);

      // 0049 was ACCEPTED and FROZEN at the accepted digest. The manifest
      // carries it, the boundary is at least here, and the accepted bytes are
      // still the accepted bytes — a floor rather than an equality, so a later
      // authorized slice can move the boundary without breaking this matrix.
      const manifest = JSON.parse(readFileSync(join(__dirname, '../../infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8')) as {
        frozenThrough: string;
        migrations: { name: string; sha256: string }[];
      };
      expect(manifest.frozenThrough >= '0049_accounting_periods.sql').toBe(true);
      expect(manifest.migrations.find((m) => m.name === '0049_accounting_periods.sql')?.sha256).toBe(
        '454a52183f8666f88bbf17b87b4b44e6413114af069149d2eb2489854307d851',
      );

      // Second run does nothing.
      expect(await runMigrations(url7)).toEqual([]);
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${db7} WITH (FORCE)`).catch(() => undefined);
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
  /**
   * P3-S1 — the frozen 0052 boundary, holding a business with a catalog, a
   * product variant, two warehouses and the seeded chart, upgraded to every
   * P3-S1 candidate.
   *
   * What the candidates may change is narrow and stated exactly: they ADD the
   * home association of each existing warehouse, the Phase 3 permissions of
   * the owner (eleven) and manager (three view keys), and three nullable or
   * false columns. They may not configure a product, create a base variant,
   * move a warehouse, or touch a single accounting row. The digest below is
   * everything they must not rewrite.
   */
  it('compatibility matrix (P3-S1): frozen 0052-checkpoint + existing business → the P3-S1 candidates, nothing configured, books untouched, rerun no-op', async () => {
    await ensurePostgres();
    const db8 = 'daftar_upgrade_0052';
    await admin.query(`DROP DATABASE IF EXISTS ${db8} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db8}`);
    const url8 = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${db8}`;
    const pool = scratchPool(url8);
    try {
      await pool.query(bootstrapSql());
      const FROZEN = '0052_accounting_journal_lines_rls_performance.sql';
      const preDir = migrationsUpTo(FROZEN);
      await runMigrations(url8, preDir);
      rmSync(preDir, { recursive: true, force: true });
      for (const table of ['units', 'unit_names', 'branch_warehouses', 'inventory_assertion_keys', 'inventory_assertion_uses', 'inventory_operation_kinds']) {
        expect((await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = $1`, [table])).rows, table).toEqual([]);
      }

      const tenant = (await pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0];
      const biz = (
        await pool.query<{ id: string }>(
          `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
           VALUES ($1, 'Before Inventory', 'upgrade-inventory', 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
          [tenant?.id],
        )
      ).rows[0];
      const branches = (
        await pool.query<{ id: string }>(`INSERT INTO branches (business_id, name, is_default) VALUES ($1, 'A', true), ($1, 'B', false) RETURNING id`, [
          biz?.id,
        ])
      ).rows;
      for (const [i, b] of branches.entries()) {
        await pool.query(`INSERT INTO warehouses (business_id, branch_id, name, is_default) VALUES ($1, $2, $3, $4)`, [biz?.id, b.id, `W${i}`, i === 0]);
      }
      const product = (
        await pool.query<{ id: string }>(
          `WITH p AS (INSERT INTO products (business_id, sku, base_price_minor, price_currency, unit) VALUES ($1, 'INV-1', 500, 'ILS', 'kg') RETURNING business_id, id)
           INSERT INTO product_translations (business_id, product_id, locale, name) SELECT business_id, id, 'en', 'Before' FROM p RETURNING product_id AS id`,
          [biz?.id],
        )
      ).rows[0];
      await pool.query(`INSERT INTO product_variants (business_id, product_id, sku) VALUES ($1, $2, 'INV-1-L')`, [biz?.id, product?.id]);

      const protectedDigest = async (): Promise<string> => {
        const r = await pool.query<{ d: string }>(
          `SELECT md5(string_agg(t, '|' ORDER BY t)) AS d FROM (
             SELECT concat_ws(':', 'acc', id, business_id, code, type, system_key, is_active) AS t FROM accounts
             UNION ALL SELECT concat_ws(':', 'je', id, business_id, entry_date, source_type, source_id) FROM journal_entries
             UNION ALL SELECT concat_ws(':', 'jl', id, journal_entry_id, account_id, debit_minor, credit_minor) FROM journal_lines
             UNION ALL SELECT concat_ws(':', 'biz', id, tenant_id, base_currency, timezone, financial_started_at) FROM businesses
             UNION ALL SELECT concat_ws(':', 'wh', business_id, id, branch_id, name, is_default, status) FROM warehouses
             UNION ALL SELECT concat_ws(':', 'br', business_id, id, name, is_default, status) FROM branches
             UNION ALL SELECT concat_ws(':', 'p', business_id, id, sku, barcode, base_price_minor, unit, version, status) FROM products
             UNION ALL SELECT concat_ws(':', 'v', business_id, id, product_id, sku, barcode, price_minor, attributes, status) FROM product_variants
             UNION ALL SELECT concat_ws(':', 'ci', business_id, kind, value_norm, owner_type, owner_id) FROM catalog_identifiers
           ) x`,
        );
        return r.rows[0]?.d ?? '';
      };
      const before = await protectedDigest();

      const applied = await runMigrations(url8);
      expect(applied).toEqual(migrationsAfter(FROZEN));
      expect(applied.length).toBeGreaterThan(0);
      expect(await protectedDigest()).toBe(before);

      // Nothing configured, no base variant, every variant a merchant one.
      expect(
        (
          await pool.query<{ tracked: number; base: number; merchant: number }>(
            `SELECT (SELECT count(*)::int FROM products WHERE track_inventory OR unit_code IS NOT NULL OR unit_decimals IS NOT NULL) AS tracked,
                    (SELECT count(*)::int FROM product_variants WHERE is_base) AS base,
                    (SELECT count(*)::int FROM product_variants WHERE NOT is_base) AS merchant`,
          )
        ).rows[0],
      ).toEqual({ tracked: 0, base: 0, merchant: 1 });

      // Row A: every existing warehouse, exactly its home association.
      const assoc = (
        await pool.query<{ ok: boolean; n: number }>(
          `SELECT bool_and(EXISTS (SELECT 1 FROM warehouses w WHERE w.business_id = bw.business_id AND w.id = bw.warehouse_id AND w.branch_id = bw.branch_id)) AS ok,
                  count(*)::int AS n FROM branch_warehouses bw`,
        )
      ).rows[0];
      expect(assoc).toEqual({ ok: true, n: 2 });

      // The four lifecycle triggers and the TD-09 guard arrived with the
      // tables they protect — a protection installed later is a window.
      const triggers = (
        await pool.query<{ t: string }>(
          `SELECT c.relname || '.' || t.tgname AS t FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
            WHERE NOT t.tgisinternal AND t.tgname IN ('warehouses_home_branch_maintain', 'warehouses_require_home_branch', 'branch_warehouses_keep_home',
                                                      'warehouses_home_branch_immutable', 'products_10_inventory_config_authority',
                                                      'product_variants_10_base_variant_authority', 'accounting_entry_date_guard')`,
        )
      ).rows
        .map((r) => r.t)
        .sort();
      expect(triggers).toEqual(
        [
          'branch_warehouses.branch_warehouses_keep_home',
          'journal_entries.accounting_entry_date_guard',
          'product_variants.product_variants_10_base_variant_authority',
          'products.products_10_inventory_config_authority',
          'warehouses.warehouses_home_branch_immutable',
          'warehouses.warehouses_home_branch_maintain',
          'warehouses.warehouses_require_home_branch',
        ].sort(),
      );

      // Every DML grant on the new tables, named exactly (P3-AL-54 §H).
      const grants = (
        await pool.query<{ t: string; g: string; p: string }>(
          `SELECT c.relname AS t, coalesce(r.rolname, 'PUBLIC') AS g, a.privilege_type AS p
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
             LEFT JOIN pg_roles r ON r.oid = a.grantee
            WHERE n.nspname = 'public'
              AND c.relname IN ('units', 'unit_names', 'branch_warehouses', 'inventory_assertion_keys', 'inventory_assertion_uses', 'inventory_operation_kinds')
              AND a.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
              AND a.grantee <> c.relowner`,
        )
      ).rows
        .map((g) => `${g.t}:${g.g}:${g.p}`)
        .sort();
      expect(grants).toEqual(
        [
          'branch_warehouses:daftar_app:SELECT',
          'branch_warehouses:daftar_inventory_internal:DELETE',
          'branch_warehouses:daftar_inventory_internal:INSERT',
          'branch_warehouses:daftar_inventory_internal:SELECT',
          'inventory_assertion_keys:daftar_inventory_internal:INSERT',
          'inventory_assertion_keys:daftar_inventory_internal:SELECT',
          'inventory_assertion_keys:daftar_inventory_internal:UPDATE',
          'inventory_assertion_uses:daftar_inventory_internal:DELETE',
          'inventory_assertion_uses:daftar_inventory_internal:INSERT',
          'inventory_assertion_uses:daftar_inventory_internal:SELECT',
          'inventory_operation_kinds:daftar_inventory_internal:SELECT',
          'unit_names:daftar_app:SELECT',
          'units:daftar_app:SELECT',
          'units:daftar_inventory_internal:SELECT',
        ].sort(),
      );

      // Second run does nothing.
      expect(await runMigrations(url8)).toEqual([]);
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${db8} WITH (FORCE)`).catch(() => undefined);
    }
  }, 180_000);

  it('compatibility matrix (P3-S2): frozen 0058-checkpoint + existing business → the P3-S2 ledger, empty (registries exactly as P3-S3, P3-S4 and P3-S5 left them), books and catalog untouched, rerun no-op', async () => {
    await ensurePostgres();
    const db9 = 'daftar_upgrade_0058';
    await admin.query(`DROP DATABASE IF EXISTS ${db9} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db9}`);
    const url9 = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${db9}`;
    const pool = scratchPool(url9);
    const LEDGER = [
      'stock_movement_kinds',
      'stock_source_types',
      'inventory_operation_movement_kinds',
      'stock_levels',
      'stock_movements',
      'stock_source_bindings',
      'negative_inventory_deficits',
      'negative_deficit_coverages',
    ];
    try {
      await pool.query(bootstrapSql());
      const FROZEN = '0058_accounting_entry_date_guard.sql';
      const preDir = migrationsUpTo(FROZEN);
      await runMigrations(url9, preDir);
      rmSync(preDir, { recursive: true, force: true });
      for (const table of LEDGER) {
        expect((await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = $1`, [table])).rows, table).toEqual([]);
      }

      const tenant = (await pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0];
      const biz = (
        await pool.query<{ id: string }>(
          `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
           VALUES ($1, 'Before Ledger', 'upgrade-ledger', 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
          [tenant?.id],
        )
      ).rows[0];
      const branch = (await pool.query<{ id: string }>(`INSERT INTO branches (business_id, name, is_default) VALUES ($1, 'A', true) RETURNING id`, [biz?.id]))
        .rows[0];
      await pool.query(`INSERT INTO warehouses (business_id, branch_id, name, is_default) VALUES ($1, $2, 'W0', true)`, [biz?.id, branch?.id]);
      const product = (
        await pool.query<{ id: string }>(
          `WITH p AS (INSERT INTO products (business_id, sku, base_price_minor, price_currency, unit) VALUES ($1, 'LED-1', 500, 'ILS', 'kg') RETURNING business_id, id)
           INSERT INTO product_translations (business_id, product_id, locale, name) SELECT business_id, id, 'en', 'Before' FROM p RETURNING product_id AS id`,
          [biz?.id],
        )
      ).rows[0];
      await pool.query(`INSERT INTO product_variants (business_id, product_id, sku) VALUES ($1, $2, 'LED-1-L')`, [biz?.id, product?.id]);

      const protectedDigest = async (): Promise<string> => {
        const r = await pool.query<{ d: string }>(
          `SELECT md5(string_agg(t, '|' ORDER BY t)) AS d FROM (
             SELECT concat_ws(':', 'acc', id, business_id, code, type, system_key, is_active) AS t FROM accounts
             UNION ALL SELECT concat_ws(':', 'je', id, business_id, entry_date, source_type, source_id) FROM journal_entries
             UNION ALL SELECT concat_ws(':', 'jl', id, journal_entry_id, account_id, debit_minor, credit_minor) FROM journal_lines
             UNION ALL SELECT concat_ws(':', 'biz', id, tenant_id, base_currency, timezone, financial_started_at) FROM businesses
             UNION ALL SELECT concat_ws(':', 'wh', business_id, id, branch_id, name, is_default, status) FROM warehouses
             UNION ALL SELECT concat_ws(':', 'bw', business_id, warehouse_id, branch_id) FROM branch_warehouses
             UNION ALL SELECT concat_ws(':', 'p', business_id, id, sku, barcode, base_price_minor, unit, version, status, track_inventory, unit_code, unit_decimals) FROM products
             UNION ALL SELECT concat_ws(':', 'v', business_id, id, product_id, sku, barcode, price_minor, attributes, status, is_base) FROM product_variants
           ) x`,
        );
        return r.rows[0]?.d ?? '';
      };
      const before = await protectedDigest();

      const applied = await runMigrations(url9);
      expect(applied).toEqual(migrationsAfter(FROZEN));
      expect(applied.length).toBeGreaterThan(0);
      expect(await protectedDigest()).toBe(before);

      // The ledger exists and is empty; the closed movement-kind registry is
      // seeded, and P3-S2 itself registered no source type and no op→kind row
      // (P3-AL-50, L:1992). The upgrade runs to the latest migration, so the
      // two registries hold exactly what P3-S3 registered (0061 §2.1 step 7,
      // 0062 §2.5) — every row by P3-S3, none by P3-S1 or P3-S2. The frozen
      // 0060 checkpoint itself, with both registries empty, is proven by the
      // P3-S3 case below.
      // P3-S4 (0063/0064): plus exactly what P3-S4 registered (0063 §2.1 step
      // 7, 0064 §2.5), every such row by P3-S4; the ledger stays empty.
      // P3-S5 (0065/0066): plus exactly what P3-S5 registered (0065 §2.1, 0066
      // §2.6), every such row by P3-S5; the ledger stays empty.
      const counts = (
        await pool.query<{ t: string; n: number }>(LEDGER.map((t) => `SELECT '${t}' AS t, count(*)::int AS n FROM ${t}`).join(' UNION ALL '))
      ).rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.t]: r.n }), {});
      expect(
        (
          await pool.query<{ r: string }>(
            `SELECT 'type:' || source_type || ':' || registered_by AS r FROM stock_source_types
             UNION ALL SELECT 'map:' || op_code || ':' || movement_kind || ':' || registered_by FROM inventory_operation_movement_kinds`,
          )
        ).rows
          .map((x) => x.r)
          .sort(),
      ).toEqual(
        [
          'type:inventory_adjustment:P3-S3',
          'type:inventory_opening:P3-S3',
          'type:inventory_transfer:P3-S3',
          'type:stocktake:P3-S3',
          'map:inventory.adjust:adjustment:P3-S3',
          'map:inventory.damage:damage:P3-S3',
          'map:inventory.opening:inventory_opening:P3-S3',
          'map:inventory.stocktake_finalize:stocktake:P3-S3',
          'map:inventory.transfer:transfer_in:P3-S3',
          'map:inventory.transfer:transfer_out:P3-S3',
          // P3-S4 (0063/0064)
          'type:purchase:P3-S4',
          'type:negative_inventory_cost_adjustment:P3-S4',
          'map:purchase.receive:purchase:P3-S4',
          'map:purchase.receive:negative_inventory_cost_adjustment:P3-S4',
          // P3-S5 (0065/0066)
          'type:purchase_reversal:P3-S5',
          'type:supplier_return:P3-S5',
          'map:purchase.return:supplier_return:P3-S5',
          'map:purchase.reverse:purchase_reversal:P3-S5',
        ].sort(),
      );
      expect(counts).toEqual({
        stock_movement_kinds: 10,
        // P3-S4 (0063/0064): 4 + 2 source types, 6 + 2 op→kind rows.
        // P3-S5 (0065/0066): 4 + 2 + 2 source types, 6 + 2 + 2 op→kind rows.
        stock_source_types: 8,
        inventory_operation_movement_kinds: 10,
        stock_levels: 0,
        stock_movements: 0,
        stock_source_bindings: 0,
        negative_inventory_deficits: 0,
        negative_deficit_coverages: 0,
      });

      // The history lock and the ledger's own protections arrived with it.
      const triggers = (
        await pool.query<{ t: string }>(
          `SELECT c.relname || '.' || t.tgname AS t FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
            WHERE NOT t.tgisinternal AND t.tgname IN ('products_10_inventory_config_authority', 'products_20_unit_history_lock',
                                                      'stock_movements_append_only', 'stock_source_bindings_append_only',
                                                      'negative_deficit_coverages_append_only', 'stock_levels_retain',
                                                      'stock_levels_zero_on_hand_zero_value')`,
        )
      ).rows
        .map((r) => r.t)
        .sort();
      expect(triggers).toEqual(
        [
          'negative_deficit_coverages.negative_deficit_coverages_append_only',
          'products.products_10_inventory_config_authority',
          'products.products_20_unit_history_lock',
          'stock_levels.stock_levels_retain',
          'stock_levels.stock_levels_zero_on_hand_zero_value',
          'stock_movements.stock_movements_append_only',
          'stock_source_bindings.stock_source_bindings_append_only',
        ].sort(),
      );

      // No runtime role holds DML on any ledger table; daftar_app reads the
      // movements and the cache only (P3-AL-54 §H, contract A-17).
      const runtimeGrants = (
        await pool.query<{ t: string; g: string; p: string }>(
          `SELECT c.relname AS t, r.rolname AS g, a.privilege_type AS p
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
             JOIN pg_roles r ON r.oid = a.grantee
            WHERE n.nspname = 'public' AND c.relname = ANY ($1::text[])
              AND r.rolname IN ('daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_provisioner', 'daftar_identity', 'daftar_resolver', 'daftar_reconciler')`,
          [LEDGER],
        )
      ).rows
        .map((g) => `${g.t}:${g.g}:${g.p}`)
        .sort();
      expect(runtimeGrants).toEqual([
        // P3-S4 (0063, contract A-18): daftar_app also reads the coverages and the deficits (the replay and read models).
        'negative_deficit_coverages:daftar_app:SELECT',
        'negative_inventory_deficits:daftar_app:SELECT',
        'stock_levels:daftar_app:SELECT',
        'stock_movements:daftar_app:SELECT',
      ]);

      // Second run does nothing.
      expect(await runMigrations(url9)).toEqual([]);
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${db9} WITH (FORCE)`).catch(() => undefined);
    }
  }, 180_000);

  it('compatibility matrix (P3-S3): frozen 0060-checkpoint + existing tracked business → 0061/0062, books and ledger untouched, registries exactly P3-S3 (P3-S4: + P3-S4; P3-S5: + P3-S5), rerun no-op', async () => {
    await ensurePostgres();
    const db10 = 'daftar_upgrade_0060';
    await admin.query(`DROP DATABASE IF EXISTS ${db10} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db10}`);
    const url10 = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${db10}`;
    const pool = scratchPool(url10);
    const LEDGER = ['stock_levels', 'stock_movements', 'stock_source_bindings', 'negative_inventory_deficits', 'negative_deficit_coverages'];
    const S3_TABLES = [
      'inventory_transfers',
      'inventory_transfer_lines',
      'inventory_adjustments',
      'inventory_adjustment_lines',
      'stocktakes',
      'stocktake_lines',
      'inventory_openings',
      'inventory_opening_lines',
      'stock_source_bridge_inventory_transfer',
      'stock_source_bridge_inventory_adjustment',
      'stock_source_bridge_stocktake',
      'stock_source_bridge_inventory_opening',
    ];
    const CHECKPOINT_REGISTRIES = [
      'op:inventory.configure_product:P3-S1',
      'op:structure.associate_warehouse_branch:P3-S1',
      'op:structure.dissociate_warehouse_branch:P3-S1',
      'acct:post:manual_adjustment',
      'acct:post:opening_balance',
      'acct:reverse:reversal',
    ];
    const registries = async (): Promise<string[]> =>
      (
        await pool.query<{ r: string }>(
          `SELECT 'type:' || source_type || ':' || registered_by AS r FROM stock_source_types
           UNION ALL SELECT 'map:' || op_code || ':' || movement_kind || ':' || registered_by FROM inventory_operation_movement_kinds
           UNION ALL SELECT 'op:' || op_code || ':' || registered_by FROM inventory_operation_kinds
           UNION ALL SELECT 'acct:' || operation_kind || ':' || source_type FROM accounting_operation_kinds`,
        )
      ).rows
        .map((x) => x.r)
        .sort();
    try {
      await pool.query(bootstrapSql());
      const FROZEN = '0060_inventory_stock_primitive.sql';
      const preDir = migrationsUpTo(FROZEN);
      await runMigrations(url10, preDir);
      rmSync(preDir, { recursive: true, force: true });

      // The checkpoint is honest in both directions: the P3-S2 ledger is
      // there, the P3-S3 documents and bridges are not — and P3-S2's own
      // claim holds exactly at its own boundary: no source type, no op→kind
      // row, only the three P3-S1 operation kinds and the three native
      // accounting pairs (0059-E (2), 0060-E (6), L:1992).
      for (const table of LEDGER) {
        expect((await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = $1`, [table])).rows, table).toHaveLength(1);
      }
      for (const table of S3_TABLES) {
        expect((await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = $1`, [table])).rows, table).toEqual([]);
      }
      expect(await registries()).toEqual([...CHECKPOINT_REGISTRIES].sort());

      // A business that existed before P3-S3, with everything that can exist
      // at this checkpoint: two branches with their warehouses, a product
      // TRACKED in stock with its base variant, and a tracked variant product.
      // No movement can exist here — with both registries empty no binding
      // (FK to stock_source_types) and so no movement can be written — which
      // is exactly why the ledger below must still be empty afterwards.
      const tenant = (await pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0];
      const biz = (
        await pool.query<{ id: string }>(
          `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
           VALUES ($1, 'Before Movements', 'upgrade-movements', 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
          [tenant?.id],
        )
      ).rows[0];
      const branches = (
        await pool.query<{ id: string }>(`INSERT INTO branches (business_id, name, is_default) VALUES ($1, 'A', true), ($1, 'B', false) RETURNING id`, [
          biz?.id,
        ])
      ).rows;
      for (const [i, b] of branches.entries()) {
        await pool.query(`INSERT INTO warehouses (business_id, branch_id, name, is_default) VALUES ($1, $2, $3, $4)`, [biz?.id, b.id, `W${i}`, i === 0]);
      }
      const newProduct = async (sku: string): Promise<string> =>
        (
          await pool.query<{ id: string }>(
            `WITH p AS (INSERT INTO products (business_id, sku, base_price_minor, price_currency, unit) VALUES ($1, $2, 500, 'ILS', 'piece') RETURNING business_id, id)
             INSERT INTO product_translations (business_id, product_id, locale, name) SELECT business_id, id, 'en', 'Before' FROM p RETURNING product_id AS id`,
            [biz?.id, sku],
          )
        ).rows[0]?.id ?? '';
      const simple = await newProduct('MOV-1');
      const varied = await newProduct('MOV-2');
      await pool.query(`INSERT INTO product_variants (business_id, product_id, sku) VALUES ($1, $2, 'MOV-2-A'), ($1, $2, 'MOV-2-B')`, [biz?.id, varied]);
      // The configuration's own writes, as the principal the configure
      // command runs as (the stock-ledger harness's configureRaw).
      const cfg = await pool.connect();
      try {
        await cfg.query('BEGIN');
        await cfg.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [tenant?.id, biz?.id]);
        await cfg.query('SET LOCAL ROLE daftar_inventory_internal');
        await cfg.query(`UPDATE products SET track_inventory = true, unit_code = 'piece', unit_decimals = 0 WHERE business_id = $1`, [biz?.id]);
        await cfg.query(`INSERT INTO product_variants (business_id, product_id, is_base) VALUES ($1, $2, true)`, [biz?.id, simple]);
        await cfg.query('COMMIT');
      } finally {
        cfg.release();
      }

      const protectedRows = async (): Promise<string[]> =>
        (
          await pool.query<{ t: string }>(
            `SELECT concat_ws(':', 'acc', id, business_id, code, type, system_key, is_active) AS t FROM accounts
             UNION ALL SELECT concat_ws(':', 'je', id, business_id, entry_date, source_type, source_id) FROM journal_entries
             UNION ALL SELECT concat_ws(':', 'jl', id, journal_entry_id, account_id, debit_minor, credit_minor) FROM journal_lines
             UNION ALL SELECT concat_ws(':', 'bind', business_id, source_type, source_id, journal_entry_id) FROM accounting_source_bindings
             UNION ALL SELECT concat_ws(':', 'src', source_type, sort_order) FROM accounting_source_types
             UNION ALL SELECT concat_ws(':', 'biz', id, tenant_id, base_currency, timezone, financial_started_at) FROM businesses
             UNION ALL SELECT concat_ws(':', 'wh', business_id, id, branch_id, name, is_default, status) FROM warehouses
             UNION ALL SELECT concat_ws(':', 'bw', business_id, warehouse_id, branch_id) FROM branch_warehouses
             UNION ALL SELECT concat_ws(':', 'p', business_id, id, sku, base_price_minor, unit, version, status, track_inventory, unit_code, unit_decimals) FROM products
             UNION ALL SELECT concat_ws(':', 'v', business_id, id, product_id, sku, price_minor, attributes, status, is_base) FROM product_variants
             UNION ALL SELECT concat_ws(':', 'kind', movement_kind, qty_sign, requires_reason, registered_by) FROM stock_movement_kinds`,
          )
        ).rows
          .map((x) => x.t)
          .sort();
      const before = await protectedRows();
      expect(before.filter((t) => t.startsWith('p:') && t.endsWith(':t:piece:0'))).toHaveLength(2);
      expect(before.filter((t) => t.startsWith('v:') && t.endsWith(':t'))).toHaveLength(1);
      // The one protected change 0061 is authorized to make (contract A-14(e)).
      // P3-S4 (0063/0064): and the one 0063 is authorized to make (contract A-05).
      // P3-S5 (0065/0066): and the one 0065 is authorized to make (contract A-05).
      // P3-S6 (0067/0068): and the three 0067 is authorized to make (contract A-05).
      const after = [
        ...before,
        'src:inventory_adjustment:4',
        'src:inventory_opening:5',
        'src:purchase:6',
        'src:negative_inventory_cost_adjustment:7',
        // P3-S5 (0065/0066)
        'src:supplier_return:8',
        // P3-S6 (0067/0068)
        'src:supplier_payment:9',
        'src:supplier_credit_allocation:10',
        'src:supplier_refund:11',
        // Phase 3 corrective (0072 TD-16, R-96)
        ...P3C_SOURCE_TYPE_ROWS,
      ].sort();

      const applied = await runMigrations(url10);
      expect(applied).toEqual(migrationsAfter(FROZEN));
      expect(applied.slice(0, 2)).toEqual(['0061_inventory_movement_sources.sql', '0062_inventory_movement_commands.sql']);

      // Books, catalog, configuration and the movement-kind seed are exactly
      // as they were, plus 0061's two accounting source types — named here
      // rather than hashed away.
      expect(await protectedRows()).toEqual(after);

      // The ledger is still empty, and so is every new document table and
      // bridge: an upgrade writes no movement and invents no document.
      const counts = (
        await pool.query<{ t: string; n: number }>([...LEDGER, ...S3_TABLES].map((t) => `SELECT '${t}' AS t, count(*)::int AS n FROM ${t}`).join(' UNION ALL '))
      ).rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.t]: r.n }), {});
      expect(counts).toEqual(Object.fromEntries([...LEDGER, ...S3_TABLES].map((t) => [t, 0])));

      // The registries are exactly the checkpoint's rows plus P3-S3's
      // (§2.1 step 7, §2.5, A-14(e)).
      expect(await registries()).toEqual(
        [
          ...CHECKPOINT_REGISTRIES,
          'type:inventory_adjustment:P3-S3',
          'type:inventory_opening:P3-S3',
          'type:inventory_transfer:P3-S3',
          'type:stocktake:P3-S3',
          'map:inventory.adjust:adjustment:P3-S3',
          'map:inventory.damage:damage:P3-S3',
          'map:inventory.opening:inventory_opening:P3-S3',
          'map:inventory.stocktake_finalize:stocktake:P3-S3',
          'map:inventory.transfer:transfer_in:P3-S3',
          'map:inventory.transfer:transfer_out:P3-S3',
          'op:inventory.adjust:P3-S3',
          'op:inventory.damage:P3-S3',
          'op:inventory.opening:P3-S3',
          'op:inventory.stocktake_count:P3-S3',
          'op:inventory.stocktake_finalize:P3-S3',
          'op:inventory.stocktake_open:P3-S3',
          'op:inventory.transfer:P3-S3',
          'acct:post:inventory_adjustment',
          'acct:post:inventory_opening',
          // P3-S4 (0063/0064): the upgrade runs to the latest migration, so
          // P3-S4's rows follow (§2.1 step 7, §2.5, A-03, A-05) — and only they.
          'type:purchase:P3-S4',
          'type:negative_inventory_cost_adjustment:P3-S4',
          'map:purchase.receive:purchase:P3-S4',
          'map:purchase.receive:negative_inventory_cost_adjustment:P3-S4',
          'op:supplier.create:P3-S4',
          'op:supplier.update:P3-S4',
          'op:supplier.archive:P3-S4',
          'op:supplier.reactivate:P3-S4',
          'op:purchase.draft:P3-S4',
          'op:purchase.cancel:P3-S4',
          'op:purchase.receive:P3-S4',
          'acct:post:purchase',
          'acct:post:negative_inventory_cost_adjustment',
          // P3-S5 (0065/0066): then P3-S5's rows (§2.1, §2.6, A-03, A-05) — and only they.
          'type:purchase_reversal:P3-S5',
          'type:supplier_return:P3-S5',
          'map:purchase.return:supplier_return:P3-S5',
          'map:purchase.reverse:purchase_reversal:P3-S5',
          'op:purchase.return:P3-S5',
          'op:purchase.reverse:P3-S5',
          'acct:post:supplier_return',
          // P3-S6 (0067/0068): then P3-S6's rows (§2.8, A-03, A-05) — and only
          // they: seven op kinds and three accounting pairs, no stock row.
          'op:payment.create_method:P3-S6',
          'op:payment.update_method:P3-S6',
          'op:payment.deactivate_method:P3-S6',
          'op:payment.activate_method:P3-S6',
          'op:supplier.pay:P3-S6',
          'op:supplier.allocate_credit:P3-S6',
          'op:supplier.receive_refund:P3-S6',
          'acct:post:supplier_payment',
          'acct:post:supplier_credit_allocation',
          'acct:post:supplier_refund',
          // Phase 3 corrective (0072 TD-16, R-96)
          ...P3C_REGISTRY_ROWS,
        ].sort(),
      );

      // Every new table and bridge arrived with row security ENABLED and
      // FORCED — a protection installed later is a window (§2.6).
      expect(
        (
          await pool.query<{ t: string }>(
            `SELECT relname::text AS t FROM pg_class WHERE relname = ANY ($1::text[]) AND relkind = 'r' AND relrowsecurity AND relforcerowsecurity`,
            [S3_TABLES],
          )
        ).rows
          .map((x) => x.t)
          .sort(),
      ).toEqual([...S3_TABLES].sort());

      // The existing business lives with the new rule: its zero-stock tracked
      // product archives through the A-19 guard (rolled back — only the
      // verdict is wanted).
      const arch = await pool.connect();
      try {
        await arch.query('BEGIN');
        const r = await arch.query(`UPDATE products SET status = 'archived' WHERE business_id = $1 AND id = $2`, [biz?.id, simple]);
        expect(r.rowCount).toBe(1);
      } finally {
        await arch.query('ROLLBACK').catch(() => undefined);
        arch.release();
      }
      expect(await protectedRows()).toEqual(after);

      // Neither internal principal was left the ownership-transfer authority.
      for (const role of ['daftar_inventory_internal', 'daftar_accounting_internal']) {
        expect((await pool.query<{ c: boolean }>(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS c`, [role])).rows[0]?.c, role).toBe(false);
      }

      // Second run does nothing.
      expect(await runMigrations(url10)).toEqual([]);
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${db10} WITH (FORCE)`).catch(() => undefined);
    }
  }, 180_000);

  /**
   * P3-S4 (0063/0064) — T-17 (docs/PHASE_3_S4_CONTRACT.md §6, §7.3 row 4).
   *
   * A frozen 0062 checkpoint holding a business that already has BOOKS and
   * STOCK — both written the only way they can be at that checkpoint, by the
   * real P3-S3 commands and the one generic posting primitive (H-4): a stock
   * gain through the adjustment command with its journal entry, then a
   * transfer. The upgrade to 0063/0064 must touch none of it, register
   * exactly the P3-S4 rows on top of the checkpoint's, create the S4 tables
   * empty, and do nothing on a rerun.
   */
  it('compatibility matrix (P3-S4): frozen 0062-checkpoint + existing business with books and stock → 0063/0064, books, ledger and catalogue untouched, registries exactly S3 + S4 (P3-S5: + S5), rerun no-op', async () => {
    await ensurePostgres();
    const db11 = 'daftar_upgrade_0062';
    await admin.query(`DROP DATABASE IF EXISTS ${db11} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db11}`);
    const url11 = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${db11}`;
    const pool = scratchPool(url11);
    const S4_TABLES = [
      'suppliers',
      'purchases',
      'purchase_lines',
      'purchase_landed_costs',
      'purchase_landed_cost_allocations',
      'negative_inventory_cost_adjustments',
      'stock_source_bridge_purchase',
      'stock_source_bridge_negative_inventory_cost_adjustment',
    ];
    // Every table whose rows the upgrade must leave exactly as they were:
    // the books, the catalogue and structure, the S2 ledger and the S3
    // documents and bridges. Whole rows (to_jsonb), not counts or hashes, so a
    // rewritten column fails and a successor's addition would be named.
    const PROTECTED = [
      'accounts',
      'journal_entries',
      'journal_lines',
      'accounting_source_bindings',
      'businesses',
      'branches',
      'warehouses',
      'branch_warehouses',
      'products',
      'product_variants',
      'product_translations',
      'stock_movement_kinds',
      'stock_movements',
      'stock_levels',
      'stock_source_bindings',
      'negative_inventory_deficits',
      'negative_deficit_coverages',
      'inventory_adjustments',
      'inventory_adjustment_lines',
      'inventory_transfers',
      'inventory_transfer_lines',
      'stocktakes',
      'stocktake_lines',
      'inventory_openings',
      'inventory_opening_lines',
      'stock_source_bridge_inventory_adjustment',
      'stock_source_bridge_inventory_opening',
      'stock_source_bridge_inventory_transfer',
      'stock_source_bridge_stocktake',
    ];
    const CHECKPOINT_REGISTRIES = [
      'op:inventory.configure_product:P3-S1',
      'op:structure.associate_warehouse_branch:P3-S1',
      'op:structure.dissociate_warehouse_branch:P3-S1',
      'acct:post:manual_adjustment',
      'acct:post:opening_balance',
      'acct:reverse:reversal',
      // P3-S3 (0061/0062), frozen at this checkpoint.
      'type:inventory_adjustment:P3-S3',
      'type:inventory_opening:P3-S3',
      'type:inventory_transfer:P3-S3',
      'type:stocktake:P3-S3',
      'map:inventory.adjust:adjustment:P3-S3',
      'map:inventory.damage:damage:P3-S3',
      'map:inventory.opening:inventory_opening:P3-S3',
      'map:inventory.stocktake_finalize:stocktake:P3-S3',
      'map:inventory.transfer:transfer_in:P3-S3',
      'map:inventory.transfer:transfer_out:P3-S3',
      'op:inventory.adjust:P3-S3',
      'op:inventory.damage:P3-S3',
      'op:inventory.opening:P3-S3',
      'op:inventory.stocktake_count:P3-S3',
      'op:inventory.stocktake_finalize:P3-S3',
      'op:inventory.stocktake_open:P3-S3',
      'op:inventory.transfer:P3-S3',
      'acct:post:inventory_adjustment',
      'acct:post:inventory_opening',
    ];
    const registries = async (): Promise<string[]> =>
      (
        await pool.query<{ r: string }>(
          `SELECT 'type:' || source_type || ':' || registered_by AS r FROM stock_source_types
           UNION ALL SELECT 'map:' || op_code || ':' || movement_kind || ':' || registered_by FROM inventory_operation_movement_kinds
           UNION ALL SELECT 'op:' || op_code || ':' || registered_by FROM inventory_operation_kinds
           UNION ALL SELECT 'acct:' || operation_kind || ':' || source_type FROM accounting_operation_kinds`,
        )
      ).rows
        .map((x) => x.r)
        .sort();
    const tablesPresent = async (tables: readonly string[]): Promise<string[]> =>
      (
        await pool.query<{ t: string }>(
          `SELECT table_name::text AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY ($1::text[])`,
          [[...tables]],
        )
      ).rows
        .map((x) => x.t)
        .sort();
    try {
      await pool.query(bootstrapSql());
      const FROZEN = '0062_inventory_movement_commands.sql';
      const preDir = migrationsUpTo(FROZEN);
      await runMigrations(url11, preDir);
      rmSync(preDir, { recursive: true, force: true });

      // The checkpoint is honest in both directions: every protected table is
      // there, no S4 table is, and the registries are exactly S1 + S3.
      expect(await tablesPresent(PROTECTED)).toEqual([...PROTECTED].sort());
      expect(await tablesPresent(S4_TABLES)).toEqual([]);
      expect(await registries()).toEqual([...CHECKPOINT_REGISTRIES].sort());

      // The keys the checkpoint's own signed commands verify (the platform ops
      // command, as ensurePostgres runs it on the suite's database).
      await pool.query(`SELECT inventory_assertion_key_install($1, decode($2, 'base64'))`, [INVENTORY_ASSERTION_KID, INVENTORY_ASSERTION_KEY_B64]);
      await pool.query(`SELECT accounting_assertion_key_install($1, decode($2, 'base64'))`, [ACCOUNTING_ASSERTION_KID, ACCOUNTING_ASSERTION_KEY_B64]);

      // A business that existed before P3-S4, with books and stock of its own.
      const tenantId = must((await pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0]).id;
      const userId = must(
        (
          await pool.query<{ id: string }>(
            `INSERT INTO users (email, password_hash, display_name) VALUES ('upgrade-s4-owner@test.daftar.local', 'x', 'Upgrade S4') RETURNING id`,
          )
        ).rows[0],
      ).id;
      const biz = await seedS3Business(pool, tenantId, userId, 'upgrade-s4');
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const gain = await stockUp(c, biz, biz.w1, [
          { variantId: biz.piece.variantId, qty: '10', unitCost: '2.5' },
          { variantId: biz.dec2.variantId, qty: '3.25', unitCost: '4' },
        ]);
        expect(gain.entry?.created).toBe(true);
        await runCommand(c, biz, transferCommand(biz.w1, biz.w2, [{ variantId: biz.piece.variantId, qty: '4' }]));
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }

      const protectedRows = async (): Promise<string[]> =>
        (
          await pool.query<{ t: string }>(
            [
              ...PROTECTED.map((t) => `SELECT '${t}:' || to_jsonb(x)::text AS t FROM ${t} x`),
              `SELECT concat_ws(':', 'src', source_type, sort_order) FROM accounting_source_types`,
            ].join(' UNION ALL '),
          )
        ).rows
          .map((x) => x.t)
          .sort();
      const before = await protectedRows();
      // The books and the stock really exist: one posted entry with its
      // binding, and a ledger of the gain plus both legs of the transfer.
      const n = async (table: string): Promise<number> => must((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]).n;
      expect({
        entries: await n('journal_entries'),
        bindings: await n('accounting_source_bindings'),
        movements: await n('stock_movements'),
        levels: await n('stock_levels'),
      }).toEqual({ entries: 1, bindings: 1, movements: 4, levels: 3 });
      // The one protected change 0063 is authorized to make (contract A-05).
      // P3-S5 (0065/0066): and the one 0065 is authorized to make (contract A-05).
      // P3-S6 (0067/0068): and the three 0067 is authorized to make (contract A-05).
      const after = [
        ...before,
        'src:purchase:6',
        'src:negative_inventory_cost_adjustment:7',
        // P3-S5 (0065/0066)
        'src:supplier_return:8',
        // P3-S6 (0067/0068)
        'src:supplier_payment:9',
        'src:supplier_credit_allocation:10',
        'src:supplier_refund:11',
        // Phase 3 corrective (0072 TD-16, R-96)
        ...P3C_SOURCE_TYPE_ROWS,
      ].sort();

      const applied = await runMigrations(url11);
      expect(applied).toEqual(migrationsAfter(FROZEN));
      expect(applied.slice(0, 2)).toEqual(['0063_purchases_suppliers_sources.sql', '0064_purchase_commands.sql']);

      // Books, ledger, S3 documents and catalogue are exactly as they were,
      // plus 0063's two accounting source types — named, not hashed away.
      // P3-S5 (0065/0066): and 0065's one.
      expect(await protectedRows()).toEqual(after);

      // Every S4 table and bridge exists, arrived with row security ENABLED
      // and FORCED (§2.6), and is empty: an upgrade invents no supplier, no
      // purchase and no coverage.
      expect(await tablesPresent(S4_TABLES)).toEqual([...S4_TABLES].sort());
      expect(
        (
          await pool.query<{ t: string }>(
            `SELECT relname::text AS t FROM pg_class WHERE relname = ANY ($1::text[]) AND relkind = 'r' AND relrowsecurity AND relforcerowsecurity`,
            [S4_TABLES],
          )
        ).rows
          .map((x) => x.t)
          .sort(),
      ).toEqual([...S4_TABLES].sort());
      const s4Counts = (
        await pool.query<{ t: string; n: number }>(S4_TABLES.map((t) => `SELECT '${t}' AS t, count(*)::int AS n FROM ${t}`).join(' UNION ALL '))
      ).rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.t]: r.n }), {});
      expect(s4Counts).toEqual(Object.fromEntries(S4_TABLES.map((t) => [t, 0])));

      // The registries are exactly the checkpoint's S1 + S3 rows plus P3-S4's
      // (§2.1 step 7, §2.5, A-03, A-05), and nothing else.
      // P3-S5 (0065/0066): the upgrade runs to the latest migration, so
      // P3-S5's rows follow (§2.1, §2.6, A-03, A-05) — and only they.
      expect(await registries()).toEqual(
        [
          ...CHECKPOINT_REGISTRIES,
          'type:purchase:P3-S4',
          'type:negative_inventory_cost_adjustment:P3-S4',
          'map:purchase.receive:purchase:P3-S4',
          'map:purchase.receive:negative_inventory_cost_adjustment:P3-S4',
          'op:supplier.create:P3-S4',
          'op:supplier.update:P3-S4',
          'op:supplier.archive:P3-S4',
          'op:supplier.reactivate:P3-S4',
          'op:purchase.draft:P3-S4',
          'op:purchase.cancel:P3-S4',
          'op:purchase.receive:P3-S4',
          'acct:post:purchase',
          'acct:post:negative_inventory_cost_adjustment',
          // P3-S5 (0065/0066)
          'type:purchase_reversal:P3-S5',
          'type:supplier_return:P3-S5',
          'map:purchase.return:supplier_return:P3-S5',
          'map:purchase.reverse:purchase_reversal:P3-S5',
          'op:purchase.return:P3-S5',
          'op:purchase.reverse:P3-S5',
          'acct:post:supplier_return',
          // P3-S6 (0067/0068)
          'op:payment.create_method:P3-S6',
          'op:payment.update_method:P3-S6',
          'op:payment.deactivate_method:P3-S6',
          'op:payment.activate_method:P3-S6',
          'op:supplier.pay:P3-S6',
          'op:supplier.allocate_credit:P3-S6',
          'op:supplier.receive_refund:P3-S6',
          'acct:post:supplier_payment',
          'acct:post:supplier_credit_allocation',
          'acct:post:supplier_refund',
          // Phase 3 corrective (0072 TD-16, R-96)
          ...P3C_REGISTRY_ROWS,
        ].sort(),
      );
      // The replaced discovery reports no gap over the six registered types.
      // P3-S5 (0065/0066): nor over the eight, once 0065 replaced it again.
      expect((await pool.query(`SELECT * FROM inventory_stock_source_guard_gaps()`)).rows).toEqual([]);

      // Neither internal principal was left the ownership-transfer authority.
      for (const role of ['daftar_inventory_internal', 'daftar_accounting_internal']) {
        expect((await pool.query<{ c: boolean }>(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS c`, [role])).rows[0]?.c, role).toBe(false);
      }

      // Second run does nothing, and still leaves every protected row as it was.
      expect(await runMigrations(url11)).toEqual([]);
      expect(await protectedRows()).toEqual(after);
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${db11} WITH (FORCE)`).catch(() => undefined);
    }
  }, 180_000);

  /**
   * P3-S5 (0065/0066) — T-17 (docs/PHASE_3_S5_CONTRACT.md §6, §7.3 row 4).
   *
   * A frozen 0064 checkpoint holding a business that already has BOOKS,
   * STOCK, a SUPPLIER and a RECEIVED PURCHASE — each written the only way it
   * can be at that checkpoint: an S3 stock gain with its journal entry, a
   * transfer, then an S4 supplier, draft and receipt with the purchase entry.
   * The upgrade to 0065/0066 must touch none of it (0065 adds two candidate
   * keys to the S4 tables, and no row), register exactly the P3-S5 rows on
   * top of the checkpoint's S1 + S3 + S4 ones, create the five S5 documents
   * and two bridges empty and forced under row security, answer the received
   * purchase's outstanding AP as its total (no return, no reversal), and do
   * nothing on a rerun.
   */
  it('compatibility matrix (P3-S5): frozen 0064-checkpoint + existing business with books, stock, a supplier and a received purchase → 0065/0066, books, ledger and catalogue untouched, registries exactly S1 + S3 + S4 + S5, rerun no-op', async () => {
    await ensurePostgres();
    const db12 = 'daftar_upgrade_0064';
    await admin.query(`DROP DATABASE IF EXISTS ${db12} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db12}`);
    const url12 = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${db12}`;
    const pool = scratchPool(url12);
    const S5_TABLES = [
      'supplier_returns',
      'supplier_return_lines',
      'supplier_credit_notes',
      'purchase_reversals',
      'purchase_reversal_lines',
      'stock_source_bridge_supplier_return',
      'stock_source_bridge_purchase_reversal',
    ];
    // Every table whose rows the upgrade must leave exactly as they were: the
    // books, the catalogue and structure, the S2 ledger, the S3 documents and
    // bridges, the S4 suppliers, purchases and bridges, and the trail of the
    // commands that wrote them. Whole rows (to_jsonb), so a rewritten column
    // fails and an addition is named.
    const PROTECTED = [
      'accounts',
      'journal_entries',
      'journal_lines',
      'accounting_source_bindings',
      'accounting_reversals',
      'businesses',
      'branches',
      'warehouses',
      'branch_warehouses',
      'products',
      'product_variants',
      'product_translations',
      'stock_movement_kinds',
      'stock_movements',
      'stock_levels',
      'stock_source_bindings',
      'negative_inventory_deficits',
      'negative_deficit_coverages',
      'inventory_adjustments',
      'inventory_adjustment_lines',
      'inventory_transfers',
      'inventory_transfer_lines',
      'stocktakes',
      'stocktake_lines',
      'inventory_openings',
      'inventory_opening_lines',
      'stock_source_bridge_inventory_adjustment',
      'stock_source_bridge_inventory_opening',
      'stock_source_bridge_inventory_transfer',
      'stock_source_bridge_stocktake',
      'suppliers',
      'purchases',
      'purchase_lines',
      'purchase_landed_costs',
      'purchase_landed_cost_allocations',
      'negative_inventory_cost_adjustments',
      'stock_source_bridge_purchase',
      'stock_source_bridge_negative_inventory_cost_adjustment',
      'inventory_assertion_uses',
      'audit_events',
      'outbox_events',
    ];
    const CHECKPOINT_REGISTRIES = [
      'op:inventory.configure_product:P3-S1',
      'op:structure.associate_warehouse_branch:P3-S1',
      'op:structure.dissociate_warehouse_branch:P3-S1',
      'acct:post:manual_adjustment',
      'acct:post:opening_balance',
      'acct:reverse:reversal',
      // P3-S3 (0061/0062), frozen at this checkpoint.
      'type:inventory_adjustment:P3-S3',
      'type:inventory_opening:P3-S3',
      'type:inventory_transfer:P3-S3',
      'type:stocktake:P3-S3',
      'map:inventory.adjust:adjustment:P3-S3',
      'map:inventory.damage:damage:P3-S3',
      'map:inventory.opening:inventory_opening:P3-S3',
      'map:inventory.stocktake_finalize:stocktake:P3-S3',
      'map:inventory.transfer:transfer_in:P3-S3',
      'map:inventory.transfer:transfer_out:P3-S3',
      'op:inventory.adjust:P3-S3',
      'op:inventory.damage:P3-S3',
      'op:inventory.opening:P3-S3',
      'op:inventory.stocktake_count:P3-S3',
      'op:inventory.stocktake_finalize:P3-S3',
      'op:inventory.stocktake_open:P3-S3',
      'op:inventory.transfer:P3-S3',
      'acct:post:inventory_adjustment',
      'acct:post:inventory_opening',
      // P3-S4 (0063/0064), frozen at this checkpoint.
      'type:purchase:P3-S4',
      'type:negative_inventory_cost_adjustment:P3-S4',
      'map:purchase.receive:purchase:P3-S4',
      'map:purchase.receive:negative_inventory_cost_adjustment:P3-S4',
      'op:supplier.create:P3-S4',
      'op:supplier.update:P3-S4',
      'op:supplier.archive:P3-S4',
      'op:supplier.reactivate:P3-S4',
      'op:purchase.draft:P3-S4',
      'op:purchase.cancel:P3-S4',
      'op:purchase.receive:P3-S4',
      'acct:post:purchase',
      'acct:post:negative_inventory_cost_adjustment',
    ];
    // What 0065/0066 are authorized to register, and nothing else.
    const S5_REGISTRIES = [
      'type:purchase_reversal:P3-S5',
      'type:supplier_return:P3-S5',
      'map:purchase.return:supplier_return:P3-S5',
      'map:purchase.reverse:purchase_reversal:P3-S5',
      'op:purchase.return:P3-S5',
      'op:purchase.reverse:P3-S5',
      'acct:post:supplier_return',
    ];
    // P3-S6 (0067/0068): the upgrade runs to the latest migration, so what
    // 0067/0068 are authorized to register follows (§2.8, A-03, A-05) — and
    // only that.
    const S6_REGISTRIES = [
      'op:payment.create_method:P3-S6',
      'op:payment.update_method:P3-S6',
      'op:payment.deactivate_method:P3-S6',
      'op:payment.activate_method:P3-S6',
      'op:supplier.pay:P3-S6',
      'op:supplier.allocate_credit:P3-S6',
      'op:supplier.receive_refund:P3-S6',
      'acct:post:supplier_payment',
      'acct:post:supplier_credit_allocation',
      'acct:post:supplier_refund',
    ];
    const registries = async (): Promise<string[]> =>
      (
        await pool.query<{ r: string }>(
          `SELECT 'type:' || source_type || ':' || registered_by AS r FROM stock_source_types
           UNION ALL SELECT 'map:' || op_code || ':' || movement_kind || ':' || registered_by FROM inventory_operation_movement_kinds
           UNION ALL SELECT 'op:' || op_code || ':' || registered_by FROM inventory_operation_kinds
           UNION ALL SELECT 'acct:' || operation_kind || ':' || source_type FROM accounting_operation_kinds`,
        )
      ).rows
        .map((x) => x.r)
        .sort();
    const tablesPresent = async (tables: readonly string[]): Promise<string[]> =>
      (
        await pool.query<{ t: string }>(
          `SELECT table_name::text AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY ($1::text[])`,
          [[...tables]],
        )
      ).rows
        .map((x) => x.t)
        .sort();
    try {
      await pool.query(bootstrapSql());
      const FROZEN = '0064_purchase_commands.sql';
      const preDir = migrationsUpTo(FROZEN);
      await runMigrations(url12, preDir);
      rmSync(preDir, { recursive: true, force: true });

      // The checkpoint is honest in both directions: every protected table is
      // there, no S5 table is, and the registries are exactly S1 + S3 + S4.
      expect(await tablesPresent(PROTECTED)).toEqual([...PROTECTED].sort());
      expect(await tablesPresent(S5_TABLES)).toEqual([]);
      expect(await registries()).toEqual([...CHECKPOINT_REGISTRIES].sort());

      // The keys the checkpoint's own signed commands verify.
      await pool.query(`SELECT inventory_assertion_key_install($1, decode($2, 'base64'))`, [INVENTORY_ASSERTION_KID, INVENTORY_ASSERTION_KEY_B64]);
      await pool.query(`SELECT accounting_assertion_key_install($1, decode($2, 'base64'))`, [ACCOUNTING_ASSERTION_KID, ACCOUNTING_ASSERTION_KEY_B64]);

      // A business that existed before P3-S5, with books, stock, a supplier and
      // a received purchase of its own, all committed.
      const tenantId = must((await pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0]).id;
      const userId = must(
        (
          await pool.query<{ id: string }>(
            `INSERT INTO users (email, password_hash, display_name) VALUES ('upgrade-s5-owner@test.daftar.local', 'x', 'Upgrade S5') RETURNING id`,
          )
        ).rows[0],
      ).id;
      const biz = await seedS3Business(pool, tenantId, userId, 'upgrade-s5');
      const c = await pool.connect();
      let purchaseId = '';
      let purchaseTotal = '';
      try {
        await c.query('BEGIN');
        const gain = await stockUp(c, biz, biz.w1, [{ variantId: biz.piece.variantId, qty: '10', unitCost: '2.5' }]);
        expect(gain.entry?.created).toBe(true);
        await runCommand(c, biz, transferCommand(biz.w1, biz.w2, [{ variantId: biz.piece.variantId, qty: '4' }]));
        const supplierId = await createSupplier(c, biz, { name: 'Before returns' });
        const run = await draftAndReceive(
          c,
          biz,
          await draftCommand(c, supplierId, biz.w1, [
            { variantId: biz.piece.variantId, qty: '3', unitPriceMinor: '1200' },
            { variantId: biz.dec2.variantId, qty: '1.5', unitPriceMinor: '400' },
          ]),
        );
        expect(run.purchaseEntry?.created).toBe(true);
        purchaseId = run.prepared.cmd.purchaseId;
        purchaseTotal = run.prepared.cmd.totalBaseMinor.toString(10);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }

      const protectedRows = async (): Promise<string[]> =>
        (
          await pool.query<{ t: string }>(
            [
              ...PROTECTED.map((t) => `SELECT '${t}:' || to_jsonb(x)::text AS t FROM ${t} x`),
              `SELECT concat_ws(':', 'src', source_type, sort_order) FROM accounting_source_types`,
            ].join(' UNION ALL '),
          )
        ).rows
          .map((x) => x.t)
          .sort();
      const before = await protectedRows();
      // The books, the stock and the purchase really exist: the gain's entry and
      // the purchase's, each with its binding; the gain, both transfer legs and
      // the two receipt movements; one supplier, one received purchase with two
      // lines, each bridged.
      const n = async (table: string): Promise<number> => must((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]).n;
      expect({
        entries: await n('journal_entries'),
        bindings: await n('accounting_source_bindings'),
        movements: await n('stock_movements'),
        levels: await n('stock_levels'),
        suppliers: await n('suppliers'),
        received: must((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM purchases WHERE status = 'received'`)).rows[0]).n,
        lines: await n('purchase_lines'),
        purchaseBridges: await n('stock_source_bridge_purchase'),
      }).toEqual({ entries: 2, bindings: 2, movements: 5, levels: 3, suppliers: 1, received: 1, lines: 2, purchaseBridges: 2 });
      // The one protected change 0065 is authorized to make (contract A-05).
      // P3-S6 (0067/0068): and the three 0067 is authorized to make (contract A-05).
      // Phase 3 corrective (0072 TD-16, R-96): and the one 0072 is authorized to make.
      const after = [
        ...before,
        'src:supplier_return:8',
        'src:supplier_payment:9',
        'src:supplier_credit_allocation:10',
        'src:supplier_refund:11',
        ...P3C_SOURCE_TYPE_ROWS,
      ].sort();

      const applied = await runMigrations(url12);
      expect(applied).toEqual(migrationsAfter(FROZEN));
      expect(applied.slice(0, 2)).toEqual(['0065_supplier_returns_reversals_sources.sql', '0066_supplier_return_reversal_commands.sql']);

      // Books, ledger, S3 and S4 documents and catalogue are exactly as they
      // were, plus 0065's one accounting source type — named, not hashed away.
      expect(await protectedRows()).toEqual(after);

      // Every S5 table and bridge exists, arrived with row security ENABLED and
      // FORCED (§2.7), and is empty: an upgrade invents no return, no credit
      // note and no reversal.
      expect(await tablesPresent(S5_TABLES)).toEqual([...S5_TABLES].sort());
      expect(
        (
          await pool.query<{ t: string }>(
            `SELECT relname::text AS t FROM pg_class WHERE relname = ANY ($1::text[]) AND relkind = 'r' AND relrowsecurity AND relforcerowsecurity`,
            [S5_TABLES],
          )
        ).rows
          .map((x) => x.t)
          .sort(),
      ).toEqual([...S5_TABLES].sort());
      const s5Counts = (
        await pool.query<{ t: string; n: number }>(S5_TABLES.map((t) => `SELECT '${t}' AS t, count(*)::int AS n FROM ${t}`).join(' UNION ALL '))
      ).rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.t]: r.n }), {});
      expect(s5Counts).toEqual(Object.fromEntries(S5_TABLES.map((t) => [t, 0])));

      // The registries are exactly the checkpoint's S1 + S3 + S4 rows plus
      // P3-S5's (§2.1, §2.6, A-03, A-05; R-B2a: `purchase_reversal` is a stock
      // source type only), and nothing else.
      expect(await registries()).toEqual([...CHECKPOINT_REGISTRIES, ...S5_REGISTRIES, ...S6_REGISTRIES, ...P3C_REGISTRY_ROWS].sort());
      // The replaced discovery reports no gap over the eight registered types.
      expect((await pool.query(`SELECT * FROM inventory_stock_source_guard_gaps()`)).rows).toEqual([]);

      // The checkpoint's received purchase under the new reads (A-16, R-52):
      // nothing returned and nothing reversed, so its outstanding AP is its
      // whole total and nothing is allocated against it.
      expect(
        must(
          (
            await pool.query<{ ap: string; payment: boolean; credit: boolean }>(
              `SELECT purchase_ap_outstanding($1, $2)::text AS ap, s.payment_allocated AS payment, s.credit_allocated AS credit
                 FROM purchase_settlement_state($1, $2) s`,
              [biz.businessId, purchaseId],
            )
          ).rows[0],
        ),
      ).toEqual({ ap: purchaseTotal, payment: false, credit: false });

      // Neither internal principal was left the ownership-transfer authority.
      for (const role of ['daftar_inventory_internal', 'daftar_accounting_internal']) {
        expect((await pool.query<{ c: boolean }>(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS c`, [role])).rows[0]?.c, role).toBe(false);
      }

      // Second run does nothing, and still leaves every protected row and every
      // registry as it was.
      expect(await runMigrations(url12)).toEqual([]);
      expect(await protectedRows()).toEqual(after);
      expect(await registries()).toEqual([...CHECKPOINT_REGISTRIES, ...S5_REGISTRIES, ...S6_REGISTRIES, ...P3C_REGISTRY_ROWS].sort());
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${db12} WITH (FORCE)`).catch(() => undefined);
    }
  }, 180_000);

  /**
   * P3-S6 (0067/0068) — the P3-S6 upgrade case (docs/PHASE_3_S6_CONTRACT.md
   * §7.3 rows 1–4, in the P3-S5 case's shape).
   *
   * A frozen 0066 checkpoint holding a business that already has BOOKS,
   * STOCK, a RECEIVED PURCHASE with its entry, and a SUPPLIER RETURN that
   * produced a CREDIT NOTE — each written the only way it can be at that
   * checkpoint: an S3 stock gain with its journal entry, a transfer, an S4
   * supplier, draft and receipt with the purchase entry, then an S5 return
   * with its entry. At 0066 no settlement exists, so a purchase's outstanding
   * AP is its total less its returns' AP and a return never exceeds it; the
   * credit note is produced the way every S5 suite produces one — the
   * owner-installed settlement fixture (tests/helpers/purchase-settlement-fixture.ts)
   * states that part of the purchase was already settled, and is restored
   * (its catalogue asserted as found) before the checkpoint commits.
   *
   * The upgrade to 0067/0068 must touch none of it — the credit note's two
   * remaining values included — register exactly the P3-S6 rows on top of the
   * checkpoint's S1 + S3 + S4 + S5 ones, create the six S6 tables empty and
   * forced under row security, leave both guard discoveries empty, answer the
   * purchase's outstanding AP through the replaced read (T − the return's AP,
   * nothing allocated), and do nothing on a rerun.
   */
  it('compatibility matrix (P3-S6): frozen 0066-checkpoint + existing business with books, stock, a received purchase and a supplier return with its credit note → 0067/0068, books, ledger and catalogue untouched, registries exactly S1 + S3 + S4 + S5 + S6, rerun no-op', async () => {
    await ensurePostgres();
    const db13 = 'daftar_upgrade_0066';
    await admin.query(`DROP DATABASE IF EXISTS ${db13} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db13}`);
    const url13 = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${db13}`;
    const pool = scratchPool(url13);
    const S6_TABLES = [
      'payment_methods',
      'payment_method_names',
      'supplier_payments',
      'supplier_payment_allocations',
      'supplier_credit_allocations',
      'supplier_refunds',
    ];
    const S6_ROUTINES = [
      'payment_method_create',
      'payment_method_update',
      'payment_method_deactivate',
      'payment_method_activate',
      'supplier_pay',
      'supplier_allocate_credit',
      'supplier_receive_refund',
      'supplier_credit_note_consume',
      'supplier_settlement_guard_gaps',
      'accounting_settlement_account_eligibility',
    ];
    // Every table whose rows the upgrade must leave exactly as they were: the
    // books, the catalogue and structure, the S2 ledger, the S3, S4 and S5
    // documents and bridges, and the trail of the commands that wrote them.
    // Whole rows (to_jsonb), so a rewritten column fails and an addition is
    // named.
    const PROTECTED = [
      'accounts',
      'journal_entries',
      'journal_lines',
      'accounting_source_bindings',
      'accounting_reversals',
      'businesses',
      'branches',
      'warehouses',
      'branch_warehouses',
      'products',
      'product_variants',
      'product_translations',
      'stock_movement_kinds',
      'stock_movements',
      'stock_levels',
      'stock_source_bindings',
      'negative_inventory_deficits',
      'negative_deficit_coverages',
      'inventory_adjustments',
      'inventory_adjustment_lines',
      'inventory_transfers',
      'inventory_transfer_lines',
      'stocktakes',
      'stocktake_lines',
      'inventory_openings',
      'inventory_opening_lines',
      'stock_source_bridge_inventory_adjustment',
      'stock_source_bridge_inventory_opening',
      'stock_source_bridge_inventory_transfer',
      'stock_source_bridge_stocktake',
      'suppliers',
      'purchases',
      'purchase_lines',
      'purchase_landed_costs',
      'purchase_landed_cost_allocations',
      'negative_inventory_cost_adjustments',
      'stock_source_bridge_purchase',
      'stock_source_bridge_negative_inventory_cost_adjustment',
      'supplier_returns',
      'supplier_return_lines',
      'supplier_credit_notes',
      'purchase_reversals',
      'purchase_reversal_lines',
      'stock_source_bridge_supplier_return',
      'stock_source_bridge_purchase_reversal',
      'inventory_assertion_uses',
      'audit_events',
      'outbox_events',
    ];
    const CHECKPOINT_REGISTRIES = [
      'op:inventory.configure_product:P3-S1',
      'op:structure.associate_warehouse_branch:P3-S1',
      'op:structure.dissociate_warehouse_branch:P3-S1',
      'acct:post:manual_adjustment',
      'acct:post:opening_balance',
      'acct:reverse:reversal',
      // P3-S3 (0061/0062), frozen at this checkpoint.
      'type:inventory_adjustment:P3-S3',
      'type:inventory_opening:P3-S3',
      'type:inventory_transfer:P3-S3',
      'type:stocktake:P3-S3',
      'map:inventory.adjust:adjustment:P3-S3',
      'map:inventory.damage:damage:P3-S3',
      'map:inventory.opening:inventory_opening:P3-S3',
      'map:inventory.stocktake_finalize:stocktake:P3-S3',
      'map:inventory.transfer:transfer_in:P3-S3',
      'map:inventory.transfer:transfer_out:P3-S3',
      'op:inventory.adjust:P3-S3',
      'op:inventory.damage:P3-S3',
      'op:inventory.opening:P3-S3',
      'op:inventory.stocktake_count:P3-S3',
      'op:inventory.stocktake_finalize:P3-S3',
      'op:inventory.stocktake_open:P3-S3',
      'op:inventory.transfer:P3-S3',
      'acct:post:inventory_adjustment',
      'acct:post:inventory_opening',
      // P3-S4 (0063/0064), frozen at this checkpoint.
      'type:purchase:P3-S4',
      'type:negative_inventory_cost_adjustment:P3-S4',
      'map:purchase.receive:purchase:P3-S4',
      'map:purchase.receive:negative_inventory_cost_adjustment:P3-S4',
      'op:supplier.create:P3-S4',
      'op:supplier.update:P3-S4',
      'op:supplier.archive:P3-S4',
      'op:supplier.reactivate:P3-S4',
      'op:purchase.draft:P3-S4',
      'op:purchase.cancel:P3-S4',
      'op:purchase.receive:P3-S4',
      'acct:post:purchase',
      'acct:post:negative_inventory_cost_adjustment',
      // P3-S5 (0065/0066), frozen at this checkpoint.
      'type:purchase_reversal:P3-S5',
      'type:supplier_return:P3-S5',
      'map:purchase.return:supplier_return:P3-S5',
      'map:purchase.reverse:purchase_reversal:P3-S5',
      'op:purchase.return:P3-S5',
      'op:purchase.reverse:P3-S5',
      'acct:post:supplier_return',
    ];
    // What 0067/0068 are authorized to register, and nothing else: seven
    // operation kinds and three accounting source types with their `post`
    // pairs — no stock source type and no op→kind row (no S6 command moves
    // stock).
    const S6_REGISTRIES = [
      'op:payment.create_method:P3-S6',
      'op:payment.update_method:P3-S6',
      'op:payment.deactivate_method:P3-S6',
      'op:payment.activate_method:P3-S6',
      'op:supplier.pay:P3-S6',
      'op:supplier.allocate_credit:P3-S6',
      'op:supplier.receive_refund:P3-S6',
      'acct:post:supplier_payment',
      'acct:post:supplier_credit_allocation',
      'acct:post:supplier_refund',
    ];
    const registries = async (): Promise<string[]> =>
      (
        await pool.query<{ r: string }>(
          `SELECT 'type:' || source_type || ':' || registered_by AS r FROM stock_source_types
           UNION ALL SELECT 'map:' || op_code || ':' || movement_kind || ':' || registered_by FROM inventory_operation_movement_kinds
           UNION ALL SELECT 'op:' || op_code || ':' || registered_by FROM inventory_operation_kinds
           UNION ALL SELECT 'acct:' || operation_kind || ':' || source_type FROM accounting_operation_kinds`,
        )
      ).rows
        .map((x) => x.r)
        .sort();
    const tablesPresent = async (tables: readonly string[]): Promise<string[]> =>
      (
        await pool.query<{ t: string }>(
          `SELECT table_name::text AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY ($1::text[])`,
          [[...tables]],
        )
      ).rows
        .map((x) => x.t)
        .sort();
    const routinesPresent = async (): Promise<string[]> =>
      (await pool.query<{ p: string }>(`SELECT DISTINCT proname::text AS p FROM pg_proc WHERE proname = ANY ($1::text[])`, [S6_ROUTINES])).rows
        .map((x) => x.p)
        .sort();
    try {
      await pool.query(bootstrapSql());
      const FROZEN = '0066_supplier_return_reversal_commands.sql';
      const preDir = migrationsUpTo(FROZEN);
      await runMigrations(url13, preDir);
      rmSync(preDir, { recursive: true, force: true });

      // The checkpoint is honest in both directions: every protected table is
      // there, no S6 table or routine is, and the registries are exactly
      // S1 + S3 + S4 + S5.
      expect(await tablesPresent(PROTECTED)).toEqual([...PROTECTED].sort());
      expect(await tablesPresent(S6_TABLES)).toEqual([]);
      expect(await routinesPresent()).toEqual([]);
      expect(await registries()).toEqual([...CHECKPOINT_REGISTRIES].sort());

      // The keys the checkpoint's own signed commands verify.
      await pool.query(`SELECT inventory_assertion_key_install($1, decode($2, 'base64'))`, [INVENTORY_ASSERTION_KID, INVENTORY_ASSERTION_KEY_B64]);
      await pool.query(`SELECT accounting_assertion_key_install($1, decode($2, 'base64'))`, [ACCOUNTING_ASSERTION_KID, ACCOUNTING_ASSERTION_KEY_B64]);

      // A business that existed before P3-S6, with books, stock, a received
      // purchase and a supplier return with its credit note, all committed.
      const tenantId = must((await pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0]).id;
      const userId = must(
        (
          await pool.query<{ id: string }>(
            `INSERT INTO users (email, password_hash, display_name) VALUES ('upgrade-s6-owner@test.daftar.local', 'x', 'Upgrade S6') RETURNING id`,
          )
        ).rows[0],
      ).id;
      const biz = await seedS3Business(pool, tenantId, userId, 'upgrade-s6');
      const c = await pool.connect();
      let purchaseId = '';
      let creditNoteId = '';
      try {
        await c.query('BEGIN');
        const gain = await stockUp(c, biz, biz.w1, [{ variantId: biz.piece.variantId, qty: '10', unitCost: '2.5' }]);
        expect(gain.entry?.created).toBe(true);
        await runCommand(c, biz, transferCommand(biz.w1, biz.w2, [{ variantId: biz.piece.variantId, qty: '4' }]));
        const supplierId = await createSupplier(c, biz, { name: 'Before settlements' });
        const draft = await draftCommand(c, supplierId, biz.w1, [{ variantId: biz.piece.variantId, qty: '3', unitPriceMinor: '1200' }]);
        const run = await draftAndReceive(c, biz, draft);
        expect(run.purchaseEntry?.created).toBe(true);
        purchaseId = draft.purchaseId;
        expect(run.prepared.cmd.totalBaseMinor, 'the purchase total').toBe(3600n);
        // The fixture states that 2400 of the 3600 were already settled, so a
        // return of two units (2400) takes the remaining 1200 of AP first and
        // leaves 1200 as a supplier credit with its note (S5 A-09, A-10).
        const fixture = await installSettlementFixture(c);
        await fixture.set(biz.businessId, purchaseId, { outstandingTxn: 1200n });
        const returned = await returnGoods(c, biz, purchaseId, { lines: [{ purchaseLineId: must(draft.lines[0]).lineId, qty: '2' }] });
        expect(returned.run.entry?.created, 'the return posts its entry').toBe(true);
        expect({ ap: returned.prepared.plan.apTxnMinor, credit: returned.prepared.plan.creditTxnMinor }, 'AP first, the rest a supplier credit').toEqual({
          ap: 1200n,
          credit: 1200n,
        });
        creditNoteId = must(returned.prepared.cmd.creditNoteId, 'the credit note id');
        await fixture.restore();
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }

      const protectedRows = async (): Promise<string[]> =>
        (
          await pool.query<{ t: string }>(
            [
              ...PROTECTED.map((t) => `SELECT '${t}:' || to_jsonb(x)::text AS t FROM ${t} x`),
              `SELECT concat_ws(':', 'src', source_type, sort_order) FROM accounting_source_types`,
            ].join(' UNION ALL '),
          )
        ).rows
          .map((x) => x.t)
          .sort();
      const before = await protectedRows();
      // The books, the stock, the purchase and the return really exist: the
      // gain's, the purchase's and the return's entries, each with its
      // binding; the gain, both transfer legs, the receipt and the return
      // movements; one received purchase, one return with its bridge, and one
      // credit note whose remaining values are its original ones.
      const n = async (table: string): Promise<number> => must((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]).n;
      expect({
        entries: await n('journal_entries'),
        bindings: await n('accounting_source_bindings'),
        movements: await n('stock_movements'),
        received: must((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM purchases WHERE status = 'received'`)).rows[0]).n,
        returns: await n('supplier_returns'),
        returnBridges: await n('stock_source_bridge_supplier_return'),
        notes: await n('supplier_credit_notes'),
      }).toEqual({ entries: 3, bindings: 3, movements: 5, received: 1, returns: 1, returnBridges: 1, notes: 1 });
      const note = async (): Promise<{ original: string; remaining: string; original_base: string; remaining_base: string }> =>
        must(
          (
            await pool.query<{ original: string; remaining: string; original_base: string; remaining_base: string }>(
              `SELECT original_amount_minor::text AS original, remaining_amount_minor::text AS remaining,
                      original_carrying_base_amount_minor::text AS original_base, remaining_carrying_base_amount_minor::text AS remaining_base
                 FROM supplier_credit_notes WHERE id = $1`,
              [creditNoteId],
            )
          ).rows[0],
          'the checkpoint credit note',
        );
      expect(await note()).toEqual({ original: '1200', remaining: '1200', original_base: '1200', remaining_base: '1200' });
      // The three protected changes 0067 is authorized to make (contract A-05).
      // Phase 3 corrective (0072 TD-16, R-96): and the one 0072 is authorized to make.
      const after = [...before, 'src:supplier_payment:9', 'src:supplier_credit_allocation:10', 'src:supplier_refund:11', ...P3C_SOURCE_TYPE_ROWS].sort();

      const applied = await runMigrations(url13);
      expect(applied).toEqual(migrationsAfter(FROZEN));
      expect(applied.slice(0, 2)).toEqual(['0067_payment_methods_supplier_settlement_sources.sql', '0068_supplier_settlement_commands.sql']);

      // Books, ledger, S3, S4 and S5 documents — the credit note's remaining
      // values included — and catalogue are exactly as they were, plus 0067's
      // three accounting source types, named, not hashed away.
      expect(await protectedRows()).toEqual(after);
      expect(await note()).toEqual({ original: '1200', remaining: '1200', original_base: '1200', remaining_base: '1200' });

      // Every S6 table and routine exists; every table arrived with row
      // security ENABLED and FORCED (§2.7) and is empty: an upgrade invents no
      // method, no payment, no allocation and no refund.
      expect(await tablesPresent(S6_TABLES)).toEqual([...S6_TABLES].sort());
      expect(await routinesPresent()).toEqual([...S6_ROUTINES].sort());
      expect(
        (
          await pool.query<{ t: string }>(
            `SELECT relname::text AS t FROM pg_class WHERE relname = ANY ($1::text[]) AND relkind = 'r' AND relrowsecurity AND relforcerowsecurity`,
            [S6_TABLES],
          )
        ).rows
          .map((x) => x.t)
          .sort(),
      ).toEqual([...S6_TABLES].sort());
      const s6Counts = (
        await pool.query<{ t: string; n: number }>(S6_TABLES.map((t) => `SELECT '${t}' AS t, count(*)::int AS n FROM ${t}`).join(' UNION ALL '))
      ).rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.t]: r.n }), {});
      expect(s6Counts).toEqual(Object.fromEntries(S6_TABLES.map((t) => [t, 0])));

      // The registries are exactly the checkpoint's S1 + S3 + S4 + S5 rows plus
      // P3-S6's (§2.8, A-03, A-05), and nothing else.
      expect(await registries()).toEqual([...CHECKPOINT_REGISTRIES, ...S6_REGISTRIES, ...P3C_REGISTRY_ROWS].sort());
      // Both discoveries report no gap.
      expect((await pool.query(`SELECT * FROM inventory_stock_source_guard_gaps()`)).rows).toEqual([]);
      expect((await pool.query(`SELECT * FROM supplier_settlement_guard_gaps()`)).rows).toEqual([]);

      // The checkpoint's purchase under the replaced reads (A-13): nothing is
      // allocated, so its outstanding AP is its total less the return's AP.
      expect(
        must(
          (
            await pool.query<{ ap: string; payment: boolean; credit: boolean }>(
              `SELECT purchase_ap_outstanding($1, $2)::text AS ap, s.payment_allocated AS payment, s.credit_allocated AS credit
                 FROM purchase_settlement_state($1, $2) s`,
              [biz.businessId, purchaseId],
            )
          ).rows[0],
        ),
      ).toEqual({ ap: '2400', payment: false, credit: false });

      // Neither internal principal was left the ownership-transfer authority.
      for (const role of ['daftar_inventory_internal', 'daftar_accounting_internal']) {
        expect((await pool.query<{ c: boolean }>(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS c`, [role])).rows[0]?.c, role).toBe(false);
      }

      // Second run does nothing, and still leaves every protected row and every
      // registry as it was.
      expect(await runMigrations(url13)).toEqual([]);
      expect(await protectedRows()).toEqual(after);
      expect(await registries()).toEqual([...CHECKPOINT_REGISTRIES, ...S6_REGISTRIES, ...P3C_REGISTRY_ROWS].sort());
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${db13} WITH (FORCE)`).catch(() => undefined);
    }
  }, 180_000);

  /**
   * P3-S8 (pin 13, T-17; docs/PHASE_3_S8_CONTRACT.md §2.5, §7.3 #13, Annex R §2).
   *
   * A database parked at the S7 head (0068; S7 shipped no migration) holding a
   * business with books, stock, a transfer, a received purchase — and a
   * manual adjustment on the Inventory system account posted AFTER its first
   * movement, which the S7 head admits. That is exactly the pre-foundation
   * residue R-B1a leaves to reconciliation (Annex R §2.6, §2.10).
   *
   * 0069 must then: change no row of any table; register nothing; grant the
   * reconciler exactly the §2.2 columns (and nothing at table level); add the
   * three R-B1a objects; be a no-op on rerun. On the upgraded data the guard
   * is live (a new manual Inventory line is refused at COMMIT), R-INV-01 names
   * the business for the residue while R-INV-02..05 are ok, and reversing the
   * residue — the correction path — turns R-INV-01 ok.
   */
  it('compatibility matrix (P3-S8): frozen 0068-checkpoint + existing business with books, stock, a purchase and a manual Inventory line → 0069 alone, no row changed, registries unchanged, reconciler columns exact, R-B1a live, rerun no-op', async () => {
    const S7_HEAD = '0068_supplier_settlement_commands.sql';
    const S8M = '0069_inventory_reconciliation_read_and_account_domain.sql';
    const CODE = 'accounting.inventory_account_domain_owned';
    const scratch = await createScratchDb('daftar_upgrade_0068', { upTo: S7_HEAD });
    const pool = scratch.pool;
    // The §2.2 columns, and the 0051 accounts columns the reconciler held before.
    const RECONCILER_0051 = { accounts: ['business_id', 'id', 'tenant_id', 'type'] };
    const RECONCILER_0069 = {
      accounts: ['business_id', 'id', 'system_key', 'tenant_id', 'type'],
      stock_levels: ['business_id', 'last_stock_seq', 'on_hand', 'tenant_id', 'valuation_base_minor', 'variant_id', 'warehouse_id'],
      stock_movements: [
        'business_id',
        'id',
        'movement_kind',
        'qty_delta',
        'source_id',
        'source_line_id',
        'source_type',
        'stock_seq',
        'tenant_id',
        'value_delta_base_minor',
        'variant_id',
        'warehouse_id',
      ],
      stock_source_bindings: ['business_id', 'movement_kind', 'source_id', 'source_line_id', 'source_type', 'tenant_id'],
    };
    const reconcilerColumns = async (): Promise<Record<string, string[]>> => {
      const r = await pool.query<{ t: string; c: string }>(
        `SELECT c.relname::text AS t, a.attname::text AS c
           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid, aclexplode(a.attacl) x
          WHERE c.relname = ANY ($1::text[]) AND c.relnamespace = 'public'::regnamespace AND a.attnum > 0 AND NOT a.attisdropped
            AND x.grantee = 'daftar_reconciler'::regrole AND x.privilege_type = 'SELECT'
          ORDER BY 1, 2`,
        [Object.keys(RECONCILER_0069)],
      );
      const out: Record<string, string[]> = {};
      for (const x of r.rows) (out[x.t] ??= []).push(x.c);
      return out;
    };
    const reconcilerTableSelect = async (): Promise<string[]> =>
      (
        await pool.query<{ t: string }>(
          `SELECT t::text AS t FROM unnest($1::text[]) t WHERE has_table_privilege('daftar_reconciler', 'public.' || t, 'SELECT') ORDER BY 1`,
          [Object.keys(RECONCILER_0069)],
        )
      ).rows.map((x) => x.t);
    const rB1aObjects = async (): Promise<string[]> =>
      (
        await pool.query<{ o: string }>(
          `SELECT 'fn:' || p.proname || ':' || pg_get_userbyid(p.proowner) || ':' || p.prosecdef || ':' || array_to_string(p.proconfig, ';')
                  || ':' || coalesce((SELECT string_agg(pg_get_userbyid(x.grantee), ',' ORDER BY 1) FROM aclexplode(p.proacl) x
                                        WHERE x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner), '-') AS o
             FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('inventory_business_has_stock_movements', 'accounting_inventory_account_domain_guard')
           UNION ALL
           SELECT 'tg:' || t.tgname || ':' || t.tgdeferrable || ':' || t.tginitdeferred || ':' || t.tgenabled::text FROM pg_trigger t
            WHERE t.tgrelid = 'public.journal_entries'::regclass AND t.tgname = 'journal_entries_inventory_account_domain'
           ORDER BY 1`,
        )
      ).rows.map((x) => x.o);
    const registries = async (): Promise<string[]> =>
      (
        await pool.query<{ r: string }>(
          `SELECT 'type:' || source_type || ':' || registered_by AS r FROM stock_source_types
           UNION ALL SELECT 'map:' || op_code || ':' || movement_kind || ':' || registered_by FROM inventory_operation_movement_kinds
           UNION ALL SELECT 'op:' || op_code || ':' || registered_by FROM inventory_operation_kinds
           UNION ALL SELECT 'acct:' || operation_kind || ':' || source_type FROM accounting_operation_kinds
           UNION ALL SELECT 'src:' || source_type || ':' || sort_order FROM accounting_source_types`,
        )
      ).rows
        .map((x) => x.r)
        .sort();
    // Every row of every table (schema_migrations aside, which the runner
    // writes): 0069 writes no row anywhere, so the whole database is the
    // protected set, discovered rather than listed.
    const everyTable = async (): Promise<string[]> =>
      (
        await pool.query<{ t: string }>(
          `SELECT relname::text AS t FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') AND relname <> 'schema_migrations' ORDER BY 1`,
        )
      ).rows.map((x) => x.t);
    const rows = async (): Promise<TableDigest> => tableDigest(pool, await everyTable());
    const appUrl = scratch.url('daftar_app');
    const inApp = async <T>(fn: (c: Client) => Promise<T>): Promise<Outcome<T>> => {
      const c = new Client({ connectionString: appUrl });
      await c.connect();
      try {
        return await settle(async () => {
          await c.query('BEGIN');
          const v = await fn(c);
          await c.query('COMMIT');
          return v;
        });
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
    };
    try {
      expect(scratch.applied[scratch.applied.length - 1]).toBe(S7_HEAD);
      const day = await today(pool);

      // A business that existed at the S7 head, with books, stock, a transfer
      // and a received purchase, all committed.
      const tenantId = must((await pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0]).id;
      const userId = must(
        (
          await pool.query<{ id: string }>(
            `INSERT INTO users (email, password_hash, display_name) VALUES ('upgrade-s8-owner@test.daftar.local', 'x', 'Upgrade S8') RETURNING id`,
          )
        ).rows[0],
      ).id;
      const biz = await seedS3Business(pool, tenantId, userId, 'upgrade-s8');
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const gain = await stockUp(c, biz, biz.w1, [{ variantId: biz.piece.variantId, qty: '10', unitCost: '2.5' }]);
        expect(gain.entry?.created).toBe(true);
        await runCommand(c, biz, transferCommand(biz.w1, biz.w2, [{ variantId: biz.piece.variantId, qty: '4' }]));
        const supplierId = await createSupplier(c, biz, { name: 'Before reconciliation' });
        const draft = await draftCommand(c, supplierId, biz.w1, [{ variantId: biz.piece.variantId, qty: '3', unitPriceMinor: '1200' }]);
        expect((await draftAndReceive(c, biz, draft)).purchaseEntry?.created).toBe(true);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
      // The S7 head admits a manual Inventory line after the first movement:
      // the residue R-B1a leaves to reconciliation.
      const line = (systemKey: string, side: 'D' | 'C', amount: bigint): PostCommand['lines'][number] => ({
        account: { kind: 'system', systemKey },
        side,
        baseAmountMinor: amount,
        baseCurrency: 'ILS',
        txnAmountMinor: amount,
        txnCurrency: 'ILS',
        fxRate: '1',
        fxRateSource: 'base',
        fxRateAt: new Date('2026-03-14T09:15:00Z'),
        branchId: null,
        warehouseId: null,
      });
      const manual = (amount: bigint): PostCommand => ({
        tenantId,
        businessId: biz.businessId,
        sourceType: 'manual_adjustment',
        sourceId: randomUUID(),
        entryDate: day,
        description: 'manual Inventory line at the S7 head',
        requestId: randomUUID(),
        lines: [line('inventory', 'D', amount), line('opening_equity', 'C', amount)],
      });
      const residue = manual(700n);
      const residueEntry = expectAccepted(
        await inApp((a) => postAs(accountingAssertionFor(residue, userId), residue, {}, a)),
        'the S7 head admits a manual Inventory line after movements',
      );

      // The checkpoint is honest: no reconciler stock read, no system_key, no
      // R-B1a object; R-INV-01..05 cannot be inspected ("unavailable", never ok).
      expect(await reconcilerColumns()).toEqual(RECONCILER_0051);
      expect(await reconcilerTableSelect()).toEqual([]);
      expect(await rB1aObjects()).toEqual([]);
      const target = { tenantId, businessId: biz.businessId };
      expect(statuses(await runChecks(scratch.poolAs('daftar_reconciler'), target))).toEqual({
        'R-INV-01': 'unavailable',
        'R-INV-02': 'unavailable',
        'R-INV-03': 'unavailable',
        'R-INV-04': 'unavailable',
        'R-INV-05': 'unavailable',
      });
      const before = await rows();
      const registriesBefore = await registries();
      expect(registriesBefore.filter((r) => r.startsWith('op:'))).toHaveLength(26);

      // 0069 alone first: the corrective migrations that follow it on disk
      // (0070+) are applied, and judged, after this.
      const toS8 = migrationsUpTo(S8M);
      try {
        expect(await runMigrations(scratch.url(), toS8)).toEqual([S8M]);
      } finally {
        rmSync(toS8, { recursive: true, force: true });
      }

      // No row of any table changed; nothing was registered.
      expect(changedTables(before, await rows())).toEqual([]);
      expect(await registries()).toEqual(registriesBefore);
      // The reconciler reads exactly the §2.2 columns, never a whole table.
      expect(await reconcilerColumns()).toEqual(RECONCILER_0069);
      expect(await reconcilerTableSelect()).toEqual([]);
      // The three R-B1a objects, in their shape (Annex R §2.4, §2.5).
      const PIN = 'search_path=pg_catalog, public, pg_temp';
      expect(await rB1aObjects()).toEqual([
        `fn:accounting_inventory_account_domain_guard:daftar_accounting_internal:true:${PIN}:-`,
        `fn:inventory_business_has_stock_movements:daftar_inventory_internal:true:${PIN}:daftar_accounting_internal`,
        'tg:journal_entries_inventory_account_domain:true:true:O',
      ]);
      // Neither internal principal was left the ownership-transfer authority.
      for (const role of ['daftar_inventory_internal', 'daftar_accounting_internal']) {
        expect((await pool.query<{ c: boolean }>(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS c`, [role])).rows[0]?.c, role).toBe(false);
      }

      // Phase 3 corrective: the rest (0070+) changes no existing row; it
      // registers exactly its own rows (0072 TD-16: one operation kind and one
      // accounting source type with its posting pair) and adds one empty table.
      const applied = await scratch.migrateRest();
      expect(applied).toEqual(migrationsAfter(S8M));
      const corrected = await rows();
      expect(changedTables(before, corrected)).toEqual([
        'accounting_operation_kinds',
        'accounting_source_types',
        'inventory_operation_kinds',
        ...P3C_RELATIONS,
      ]);
      for (const rel of P3C_RELATIONS) expect(rowCounts(corrected)[rel], rel).toBe(0);
      expect(await registries()).toEqual([...registriesBefore, ...P3C_REGISTRY_ROWS, ...P3C_SOURCE_TYPE_ROWS].sort());

      // Second run does nothing, and still changes no row.
      expect(await scratch.migrateRest()).toEqual([]);
      expect(changedTables(corrected, await rows())).toEqual([]);

      // On the upgraded data: the residue is reported, by business, and only by R-INV-01.
      const upgraded = await runChecks(scratch.poolAs('daftar_reconciler'), target);
      expect(statuses(upgraded)).toEqual({ 'R-INV-01': 'discrepancy', 'R-INV-02': 'ok', 'R-INV-03': 'ok', 'R-INV-04': 'ok', 'R-INV-05': 'ok' });
      expect({ n: resultOf(upgraded, 'R-INV-01').offendingCount, ids: resultOf(upgraded, 'R-INV-01').offendingIds }).toEqual({ n: 1, ids: [biz.businessId] });
      // The guard is live: a new manual Inventory line is refused at COMMIT …
      const again = manual(300n);
      expectRefused(await inApp((a) => postAs(accountingAssertionFor(again, userId), again, {}, a)), 'P0001', CODE, 'a manual Inventory line after 0069');
      // … and the correction path is open: reversing the residue is accepted
      // and R-INV-01 is then ok.
      const assertion = sourceAssertion({
        actorUserId: userId,
        tenantId,
        businessId: biz.businessId,
        operationKind: 'reverse',
        sourceType: 'reversal',
        sourceId: residueEntry.entryId,
        postingFingerprint: reversalFingerprintOf(residue, residueEntry.entryId, day),
      });
      expectAccepted(
        await inApp((a) => postReversalAs(assertion, residueEntry.entryId, day, 'pre-foundation residue', randomUUID(), a)),
        'the reversal of the residue',
      );
      expect(statuses(await runChecks(scratch.poolAs('daftar_reconciler'), target))).toEqual({
        'R-INV-01': 'ok',
        'R-INV-02': 'ok',
        'R-INV-03': 'ok',
        'R-INV-04': 'ok',
        'R-INV-05': 'ok',
      });
    } finally {
      await scratch.drop();
    }
  }, 180_000);
});
