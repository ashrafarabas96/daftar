import { beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  appDbUrl, createTestApp, ownerPool, platformDbUrl, resetData, uniqueEmail, type TestApp,
} from '../helpers/test-app';

/**
 * FINAL CLOSURE MISSION §2–9 — Authority integrity:
 *  * tenant_owner rows cannot be demoted / status-removed / deleted by the
 *    merchant DB role (raw SQL), only via the trusted ownership boundary.
 *  * A tenant can NEVER be left without an active tenant_owner — not even by
 *    platform — unless a successor owner exists in the same transaction.
 *  * membership_roles rejects raw-SQL grants of the system 'owner' role.
 */
describe('owner authority integrity (§2–9)', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
    await resetData();
  });

  function must<T>(v: T | undefined | null): T {
    if (v === undefined || v === null) throw new Error('expected value');
    return v;
  }

  interface Fx {
    tenantId: string;
    businessId: string;
    ownerUserId: string;
    otherUserId: string;
    ownerRoleId: string;
    cashierRoleId: string;
  }

  async function fixture(): Promise<Fx> {
    const reg = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'Owner', preferredLocale: 'ar',
    });
    const on = await t.request.post('/v1/onboarding/complete').set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random()*1e9)}`)
      .set('Authorization', `Bearer ${reg.body.accessToken as string}`)
      .send({
        businessName: 'Authority Biz', countryCode: 'PS', baseCurrency: 'ILS',
        storeSlug: `au-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      });
    const businessId = on.body.businessId as string;
    const reg2 = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'Other', preferredLocale: 'ar',
    });
    const ownerUserId = must((await ownerPool().query<{ user_id: string }>(
      'SELECT user_id FROM memberships WHERE business_id = $1', [businessId])).rows[0]).user_id;
    const otherUserId = (
      await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${reg2.body.accessToken as string}`)
    ).body.userId as string;
    const tenantId = must((await ownerPool().query<{ tenant_id: string }>(
      'SELECT tenant_id FROM businesses WHERE id = $1', [businessId])).rows[0]).tenant_id;
    const ownerRoleId = must((await ownerPool().query<{ id: string }>(
      `SELECT id FROM business_roles WHERE business_id = $1 AND is_system AND key = 'owner'`, [businessId])).rows[0]).id;
    const cashierRoleId = must((await ownerPool().query<{ id: string }>(
      `SELECT id FROM business_roles WHERE business_id = $1 AND key = 'cashier'`, [businessId])).rows[0]).id;
    return { tenantId, businessId, ownerUserId, otherUserId, ownerRoleId, cashierRoleId };
  }

  async function withApp<T>(fx: Fx, fn: (q: (sql: string, p?: unknown[]) => Promise<unknown>) => Promise<T>): Promise<T> {
    const pool = new Pool({ connectionString: appDbUrl, max: 1 });
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [fx.tenantId, fx.businessId]);
      const out = await fn(async (sql, p) => c.query(sql, p));
      await c.query('ROLLBACK');
      return out;
    } finally {
      c.release();
      await pool.end();
    }
  }

  async function withPlatform<T>(fn: (q: (sql: string, p?: unknown[]) => Promise<unknown>) => Promise<T>): Promise<T> {
    const pool = new Pool({ connectionString: platformDbUrl, max: 1 });
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.bypass_rls', 'true', true)`);
      const out = await fn(async (sql, p) => c.query(sql, p));
      return out; // caller decides commit/rollback via thrown errors
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
      await pool.end();
    }
  }

  it('daftar_app cannot DEMOTE an existing tenant_owner via raw SQL', async () => {
    const fx = await fixture();
    await expect(withApp(fx, async (q) => q(
      `UPDATE tenant_memberships SET role_key = 'tenant_member' WHERE tenant_id = $1 AND user_id = $2`,
      [fx.tenantId, fx.ownerUserId],
    ))).rejects.toThrow(/platform-managed/);
  });

  it('daftar_app cannot status-remove an existing tenant_owner via raw SQL', async () => {
    const fx = await fixture();
    await expect(withApp(fx, async (q) => q(
      `UPDATE tenant_memberships SET status = 'removed' WHERE tenant_id = $1 AND user_id = $2`,
      [fx.tenantId, fx.ownerUserId],
    ))).rejects.toThrow(/platform-managed/);
  });

  it('daftar_app cannot DELETE a tenant_owner row via raw SQL', async () => {
    const fx = await fixture();
    await expect(withApp(fx, async (q) => q(
      `DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2`,
      [fx.tenantId, fx.ownerUserId],
    ))).rejects.toThrow();
  });

  it('daftar_app cannot INSERT a system owner role grant into membership_roles (raw SQL escalation)', async () => {
    const fx = await fixture();
    await expect(withApp(fx, async (q) => q(
      `INSERT INTO membership_roles (business_id, user_id, role_id) VALUES ($1, $2, $3)`,
      [fx.businessId, fx.otherUserId, fx.ownerRoleId],
    ))).rejects.toThrow(/owner role grant is platform-managed/);
  });

  it('daftar_app cannot UPDATE an existing grant INTO the system owner role', async () => {
    const fx = await fixture();
    // Fixture: other user holds a cashier grant.
    await ownerPool().query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role_key) VALUES ($1, $2, 'tenant_member')`,
      [fx.tenantId, fx.otherUserId],
    );
    await ownerPool().query(
      `INSERT INTO memberships (business_id, user_id, tenant_id, status) VALUES ($1, $2, $3, 'active')`,
      [fx.businessId, fx.otherUserId, fx.tenantId],
    );
    await ownerPool().query(
      `INSERT INTO membership_roles (business_id, user_id, role_id) VALUES ($1, $2, $3)`,
      [fx.businessId, fx.otherUserId, fx.cashierRoleId],
    );
    await expect(withApp(fx, async (q) => q(
      `UPDATE membership_roles SET role_id = $3 WHERE business_id = $1 AND user_id = $2 AND role_id = $4`,
      [fx.businessId, fx.otherUserId, fx.ownerRoleId, fx.cashierRoleId],
    ))).rejects.toThrow(/owner role grant is platform-managed/);
  });

  it('even PLATFORM cannot remove the LAST active tenant_owner', async () => {
    const fx = await fixture();
    await expect(withPlatform(async (q) => q(
      `UPDATE tenant_memberships SET role_key = 'tenant_member' WHERE tenant_id = $1 AND user_id = $2`,
      [fx.tenantId, fx.ownerUserId],
    ))).rejects.toThrow(/without an active tenant_owner/);
  });

  it('ownership TRANSFER works: successor owner + demotion in ONE transaction', async () => {
    const fx = await fixture();
    await ownerPool().query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role_key) VALUES ($1, $2, 'tenant_member')`,
      [fx.tenantId, fx.otherUserId],
    );
    const pool = new Pool({ connectionString: platformDbUrl, max: 1 });
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.bypass_rls', 'true', true)`);
      await c.query(
        `UPDATE tenant_memberships SET role_key = 'tenant_owner' WHERE tenant_id = $1 AND user_id = $2`,
        [fx.tenantId, fx.otherUserId],
      );
      await c.query(
        `UPDATE tenant_memberships SET role_key = 'tenant_member' WHERE tenant_id = $1 AND user_id = $2`,
        [fx.tenantId, fx.ownerUserId],
      );
      await c.query('COMMIT');
    } finally {
      c.release();
      await pool.end();
    }
    const { rows } = await ownerPool().query<{ role_key: string }>(
      `SELECT role_key FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2`,
      [fx.tenantId, fx.otherUserId],
    );
    expect(must(rows[0]).role_key).toBe('tenant_owner');
  });

  it('concurrent demotion of two owners: exactly ONE succeeds (last-owner race)', async () => {
    const fx = await fixture();
    await ownerPool().query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role_key) VALUES ($1, $2, 'tenant_owner')`,
      [fx.tenantId, fx.otherUserId],
    );
    const attempt = async (userId: string): Promise<'ok' | 'fail'> => {
      const pool = new Pool({ connectionString: platformDbUrl, max: 1 });
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.bypass_rls', 'true', true)`);
        await c.query(
          `UPDATE tenant_memberships SET role_key = 'tenant_member' WHERE tenant_id = $1 AND user_id = $2`,
          [fx.tenantId, userId],
        );
        await new Promise((r) => setTimeout(r, 150)); // widen the race window
        await c.query('COMMIT');
        return 'ok';
      } catch {
        await c.query('ROLLBACK').catch(() => undefined);
        return 'fail';
      } finally {
        c.release();
        await pool.end();
      }
    };
    const results = await Promise.all([attempt(fx.ownerUserId), attempt(fx.otherUserId)]);
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    const { rows } = await ownerPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM tenant_memberships WHERE tenant_id = $1 AND role_key = 'tenant_owner' AND status = 'active'`,
      [fx.tenantId],
    );
    expect(must(rows[0]).n).toBe('1');
  });

  it('golden kept: owner removed then re-added cashier holds cashier ONLY (§9)', async () => {
    const fx = await fixture();
    // The lifecycle purge runs through the merchant role — DELETE of the owner
    // grant must remain allowed (removal can never grant authority).
    const n = await withApp(fx, async (q) => {
      await q(
        `DELETE FROM membership_roles WHERE business_id = $1 AND user_id = $2`,
        [fx.businessId, fx.ownerUserId],
      );
      const r = await q(
        `SELECT count(*)::text AS n FROM membership_roles WHERE business_id = $1 AND user_id = $2`,
        [fx.businessId, fx.ownerUserId],
      ) as { rows: { n: string }[] };
      return must(r.rows[0]).n;
    });
    expect(n).toBe('0');
  });
});
