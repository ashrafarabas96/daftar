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

const admin = new Pool({ connectionString: dbUrl, max: 1 });

describe('migration upgrade path: pre-encryption schema → latest (§13–16)', () => {
  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  });

  it('legacy plaintext deliveries survive the upgrade as reissue_required — no plaintext remains', async () => {
    await ensurePostgres();
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

    const pool = new Pool({ connectionString: scratchUrl, max: 2 });
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
    const pool = new Pool({ connectionString: url2, max: 1 });
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
    const pool = new Pool({ connectionString: url4, max: 1 });
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

      // Apply exactly the P2-S1 migrations.
      const applied = await runMigrations(url4);
      expect(applied).toEqual(['0040_accounting_chart.sql', '0041_accounting_permissions.sql']);

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

  it('compatibility matrix (§54): 0035-checkpoint (JSONB translations, cross-table SKUs) → latest; content preserved, registry built, no-op rerun', async () => {
    await ensurePostgres();
    const db3 = 'daftar_upgrade_0035';
    await admin.query(`DROP DATABASE IF EXISTS ${db3} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db3}`);
    const url3 = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${db3}`;
    const pool = new Pool({ connectionString: url3, max: 1 });
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
