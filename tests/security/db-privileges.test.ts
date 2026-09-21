import { beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { appDbUrl, ensurePostgres, identityDbUrl, ownerPool, resetData } from '../helpers/test-app';

/**
 * Security Gate Zero §12 — RLS/privilege NEGATIVE tests, executed as the
 * NORMAL app role (daftar_app) with a raw connection. Every one of these
 * MUST fail closed. A pass here is proof, not assumption.
 */
describe('db privilege separation (as daftar_app)', () => {
  let tenantA = '';
  let businessA = '';
  let businessB = '';

  beforeAll(async () => {
    await ensurePostgres();
    await resetData();
    const { rows: t } = await ownerPool().query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`);
    const tenantRow = t[0];
    if (!tenantRow) throw new Error('fixture tenant insert failed');
    tenantA = tenantRow.id;
    const { rows: b } = await ownerPool().query<{ id: string }>(
      `INSERT INTO businesses (tenant_id, name, store_slug, base_currency, country_code, timezone)
       VALUES ($1, 'A', 'neg-a', 'ILS', 'PS', 'Asia/Hebron'), ($1, 'B', 'neg-b', 'ILS', 'PS', 'Asia/Hebron') RETURNING id`,
      [tenantA],
    );
    const bA = b[0];
    const bB = b[1];
    if (!bA || !bB) throw new Error('fixture business insert failed');
    businessA = bA.id;
    businessB = bB.id;
  });

  async function asApp(fn: (c: Client) => Promise<void>): Promise<void> {
    const c = new Client({ connectionString: appDbUrl });
    await c.connect();
    try {
      await fn(c);
    } finally {
      await c.end();
    }
  }

  it('bypass flag does NOTHING for daftar_app: identity tables are unreachable', async () => {
    await asApp(async (c) => {
      // Grant revoked (0010): permission denied — the flag cannot restore access.
      // (Each denial aborts its transaction, so probe each table separately.)
      for (const table of ['users', 'sessions', 'password_reset_tokens', 'platform_role_memberships']) {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.bypass_rls', 'true', true)`);
        await expect(c.query(`SELECT count(*) FROM ${table}`)).rejects.toThrow(/permission denied/i);
        await c.query('ROLLBACK');
      }
    });
  });

  it('cross-business read returns zero rows even with tenant context of the other business', async () => {
    await ownerPool().query(
      `WITH p AS (INSERT INTO products (business_id, base_price_minor, price_currency) VALUES ($1, 100, 'ILS') RETURNING business_id, id)
       INSERT INTO product_translations (business_id, product_id, locale, name) SELECT business_id, id, 'ar', 'ب' FROM p`,
      [businessB],
    );
    await asApp(async (c) => {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [tenantA, businessA]);
      const { rows } = await c.query('SELECT count(*)::int AS n FROM products');
      expect(rows[0]?.n).toBe(0);
      // Switching business context mid-transaction to B then back is transaction-local only.
      await c.query('ROLLBACK');
    });
  });

  it('cross-business WRITE fails (WITH CHECK)', async () => {
    await asApp(async (c) => {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [tenantA, businessA]);
      await expect(c.query(`INSERT INTO products (business_id, base_price_minor, price_currency) VALUES ($1, 100, 'ILS')`, [businessB])).rejects.toThrow(
        /row-level security|row violates/i,
      );
      await c.query('ROLLBACK');
    });
  });

  it('DDL is impossible: CREATE/ALTER/DROP TABLE all fail', async () => {
    await asApp(async (c) => {
      await expect(c.query('CREATE TABLE pwned (id int)')).rejects.toThrow();
      await expect(c.query('ALTER TABLE products ADD COLUMN pwned int')).rejects.toThrow();
      await expect(c.query('DROP TABLE products')).rejects.toThrow();
    });
  });

  it('RLS cannot be disabled or altered by the app role', async () => {
    await asApp(async (c) => {
      await expect(c.query('ALTER TABLE products DISABLE ROW LEVEL SECURITY')).rejects.toThrow();
      await expect(c.query('ALTER TABLE products NO FORCE ROW LEVEL SECURITY')).rejects.toThrow();
      await expect(c.query('DROP POLICY business_isolation ON products')).rejects.toThrow();
      await expect(c.query('CREATE POLICY pwned ON products USING (true)')).rejects.toThrow();
    });
  });

  // §13 — Merchant runtime must never mutate entitlement authority. Every one
  // of these writes MUST be denied for daftar_app.
  it('daftar_app cannot INSERT entitlement_overrides (grant revoked)', async () => {
    await asApp(async (c) => {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [tenantA, businessA]);
      await expect(c.query(`INSERT INTO entitlement_overrides (business_id, feature_key, enabled_value) VALUES ($1, 'x', true)`, [businessA])).rejects.toThrow(
        /permission denied/i,
      );
      await c.query('ROLLBACK');
    });
  });

  it('daftar_app cannot UPDATE business_entitlements (subscription state is platform-owned)', async () => {
    await asApp(async (c) => {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [tenantA, businessA]);
      await expect(c.query(`UPDATE business_entitlements SET state = 'active'`)).rejects.toThrow(/permission denied/i);
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [tenantA, businessA]);
      await expect(
        c.query(`INSERT INTO business_entitlements (business_id, plan_version_id, state) VALUES ($1, '00000000-0000-0000-0000-000000000000', 'active')`, [
          businessA,
        ]),
      ).rejects.toThrow(/permission denied/i);
      await c.query('ROLLBACK');
    });
  });

  it('daftar_app cannot change a published plan version', async () => {
    await asApp(async (c) => {
      await expect(c.query(`UPDATE plan_versions SET effective_from = now()`)).rejects.toThrow(/permission denied/i);
      await expect(c.query(`INSERT INTO plan_versions (plan_key, version) VALUES ('pwn', 99)`)).rejects.toThrow(/permission denied/i);
    });
  });

  it('daftar_app cannot grant platform roles', async () => {
    await asApp(async (c) => {
      await expect(
        c.query(`INSERT INTO platform_role_memberships (user_id, role_key) VALUES ('00000000-0000-0000-0000-000000000000', 'platform_owner')`),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  it('daftar_app cannot modify feature flags', async () => {
    await asApp(async (c) => {
      await expect(c.query(`INSERT INTO feature_flags (key, enabled) VALUES ('pwn', true)`)).rejects.toThrow(/permission denied/i);
      await expect(c.query(`UPDATE feature_flags SET enabled = true`)).rejects.toThrow(/permission denied/i);
    });
  });

  it('tenant context change cannot leak another tenant\u2019s businesses', async () => {
    const { rows: t2 } = await ownerPool().query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`);
    const other = t2[0];
    if (!other) throw new Error('fixture tenant insert failed');
    await ownerPool().query(
      `INSERT INTO businesses (tenant_id, name, store_slug, base_currency, country_code, timezone) VALUES ($1, 'C', 'neg-c', 'ILS', 'PS', 'Asia/Hebron')`,
      [other.id],
    );
    await asApp(async (c) => {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
      const { rows } = await c.query<{ store_slug: string }>('SELECT store_slug FROM businesses');
      const slugs = rows.map((r) => r.store_slug).sort();
      expect(slugs).toEqual(['neg-a', 'neg-b']); // tenant A's own rows only — never neg-c
      await c.query('ROLLBACK');
    });
  });
});

/**
 * WAVE 2 — daftar_identity is the auth-runtime principal ONLY. It must be
 * able to do its job (users/sessions/lineage/reset tokens + audit append) and
 * NOTHING else: no plans, no overrides, no flags, no catalog, no businesses,
 * no platform roles.
 */
describe('identity DB role separation (as daftar_identity)', () => {
  async function asIdentity(fn: (c: Client) => Promise<void>): Promise<void> {
    const c = new Client({ connectionString: identityDbUrl });
    await c.connect();
    try {
      await fn(c);
    } finally {
      await c.end();
    }
  }

  it('identity CAN do its job: insert/select users, sessions, lineage, reset tokens', async () => {
    await asIdentity(async (c) => {
      const uid = '00000000-0000-4000-8000-0000000000aa';
      await c.query(
        `INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, 'identity-probe@test.local', 'x', 'Probe')
         ON CONFLICT (id) DO NOTHING`,
        [uid],
      );
      const { rows } = await c.query('SELECT id FROM users WHERE id = $1', [uid]);
      expect(rows.length).toBe(1);
      const sid = '00000000-0000-4000-8000-0000000000bb';
      await c.query(
        `INSERT INTO sessions (id, user_id, family_id, refresh_token_hash, expires_at) VALUES ($1, $2, '00000000-0000-4000-8000-0000000000cc', 'h', now() + interval '1 day')`,
        [sid, uid],
      );
      await c.query(`INSERT INTO session_refresh_tokens (session_id, token_hash, state) VALUES ($1, 'th', 'issued')`, [sid]);
      await c.query(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, 'rh', now() + interval '1 hour')`, [uid]);
      // cleanup via superuser pool
      await ownerPool().query('DELETE FROM password_reset_tokens WHERE user_id = $1', [uid]);
      await ownerPool().query('DELETE FROM session_refresh_tokens WHERE session_id = $1', [sid]);
      await ownerPool().query('DELETE FROM sessions WHERE id = $1', [sid]);
      await ownerPool().query('DELETE FROM users WHERE id = $1', [uid]);
    });
  });

  it('identity CANNOT change plans', async () => {
    await asIdentity(async (c) => {
      await expect(c.query(`INSERT INTO plans (key, name) VALUES ('pwn', 'Pwn')`)).rejects.toThrow(/permission denied/i);
      await expect(c.query(`UPDATE plans SET name = 'x'`)).rejects.toThrow(/permission denied/i);
      await expect(c.query(`SELECT count(*) FROM plans`)).rejects.toThrow(/permission denied/i);
    });
  });

  it('identity CANNOT insert entitlement overrides or touch subscriptions', async () => {
    await asIdentity(async (c) => {
      await expect(
        c.query(`INSERT INTO entitlement_overrides (business_id, feature_key, enabled_value) VALUES ('00000000-0000-0000-0000-000000000000', 'x', true)`),
      ).rejects.toThrow(/permission denied/i);
      await expect(c.query(`UPDATE business_entitlements SET state = 'active'`)).rejects.toThrow(/permission denied/i);
    });
  });

  it('identity CANNOT change feature flags', async () => {
    await asIdentity(async (c) => {
      await expect(c.query(`INSERT INTO feature_flags (key, enabled) VALUES ('pwn', true)`)).rejects.toThrow(/permission denied/i);
      await expect(c.query(`UPDATE feature_flags SET enabled = false`)).rejects.toThrow(/permission denied/i);
    });
  });

  it('identity CANNOT write catalog or create businesses', async () => {
    await asIdentity(async (c) => {
      await expect(
        c.query(`INSERT INTO products (business_id, base_price_minor, price_currency) VALUES ('00000000-0000-0000-0000-000000000000', 1, 'ILS')`),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        c.query(
          `INSERT INTO businesses (tenant_id, name, store_slug, base_currency, country_code) VALUES ('00000000-0000-0000-0000-000000000000', 'X', 'pwn-slug', 'ILS', 'PS')`,
        ),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  it('identity CANNOT grant platform roles or read platform role memberships', async () => {
    await asIdentity(async (c) => {
      await expect(
        c.query(`INSERT INTO platform_role_memberships (user_id, role_key) VALUES ('00000000-0000-0000-0000-000000000000', 'platform_owner')`),
      ).rejects.toThrow(/permission denied/i);
      await expect(c.query(`SELECT count(*) FROM platform_role_memberships`)).rejects.toThrow(/permission denied/i);
    });
  });

  it('identity CANNOT bypass RLS via the flag (role-gated app_bypass)', async () => {
    await asIdentity(async (c) => {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.bypass_rls', 'true', true)`);
      // memberships has no identity policy → flag must NOT unlock it
      await expect(c.query(`SELECT count(*) FROM memberships`)).rejects.toThrow(/permission denied/i);
      await c.query('ROLLBACK');
    });
  });
});
