import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, ownerPool, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';

/**
 * Tenant/Business isolation (§37–39, §92–93) + owner safety (§28) +
 * system-role immutability (§26) + pooled-connection safety (§38, RELEASE BLOCKER).
 */
describe('isolation & tenancy security', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
    await resetData();
  });

  async function onboardUser(slug: string): Promise<{ token: string; businessId: string }> {
    const reg = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(),
      password: 'Str0ng!Passw0rd',
      displayName: 'U',
      preferredLocale: 'ar',
    });
    const token = reg.body.accessToken as string;
    const on = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        businessName: `Biz ${slug}`,
        countryCode: 'PS',
        baseCurrency: 'ILS',
        storeSlug: slug,
      });
    return { token, businessId: on.body.businessId as string };
  }

  it('FOUNDATION: Business A cannot read/list/update Business B catalog (cross-business)', async () => {
    const a = await onboardUser('biz-alpha');
    const b = await onboardUser('biz-beta');
    const created = await t.request
      .post('/v1/catalog/products')
      .set('Authorization', `Bearer ${a.token}`)
      .set('X-Business-Id', a.businessId)
      .send({ translations: { ar: 'منتج أ' }, basePriceMinor: '1000', priceCurrency: 'ILS' });
    expect(created.status).toBe(201);
    const productId = created.body.id as string;

    // B reading A's product by ID → 404 (not 403 — no existence leak)
    const read = await t.request.get(`/v1/catalog/products/${productId}`).set('Authorization', `Bearer ${b.token}`).set('X-Business-Id', b.businessId);
    expect(read.status).toBe(404);

    // B's list is empty
    const list = await t.request.get('/v1/catalog/products').set('Authorization', `Bearer ${b.token}`).set('X-Business-Id', b.businessId);
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([]);

    // B updating A's product → 404
    const upd = await t.request
      .patch(`/v1/catalog/products/${productId}`)
      .set('Authorization', `Bearer ${b.token}`)
      .set('X-Business-Id', b.businessId)
      .send({ translations: { ar: 'مخترق' } });
    expect(upd.status).toBe(404);
  });

  it('cross-tenant: user from tenant A cannot address a business in tenant B at all', async () => {
    const a = await onboardUser('tenant-one');
    const b = await onboardUser('tenant-two');
    // A's token + B's business id → membership resolution fails → 403
    const res = await t.request.get('/v1/catalog/products').set('Authorization', `Bearer ${a.token}`).set('X-Business-Id', b.businessId);
    expect(res.status).toBe(403);
  });

  it('membership revoked mid-session takes effect immediately', async () => {
    const a = await onboardUser('rev-biz');
    const cashierReg = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(),
      password: 'Str0ng!Passw0rd',
      displayName: 'C',
      preferredLocale: 'ar',
    });
    const cashierToken = cashierReg.body.accessToken as string;
    const cashierId = cashierReg.body.userId ?? (await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${cashierToken}`)).body.userId;

    await t.request
      .post('/v1/businesses/current/members')
      .set('Authorization', `Bearer ${a.token}`)
      .set('X-Business-Id', a.businessId)
      .send({ email: (await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${cashierToken}`)).body.email, roleKey: 'cashier' });

    const before = await t.request.get('/v1/catalog/products').set('Authorization', `Bearer ${cashierToken}`).set('X-Business-Id', a.businessId);
    expect(before.status).toBe(200);

    await t.request.delete(`/v1/businesses/current/members/${cashierId}`).set('Authorization', `Bearer ${a.token}`).set('X-Business-Id', a.businessId);

    const after = await t.request.get('/v1/catalog/products').set('Authorization', `Bearer ${cashierToken}`).set('X-Business-Id', a.businessId);
    expect(after.status).toBe(403);
  });

  it('cross-business category FK rejected (§39)', async () => {
    const a = await onboardUser('cat-a');
    const b = await onboardUser('cat-b');
    const cat = await t.request
      .post('/v1/catalog/categories')
      .set('Authorization', `Bearer ${a.token}`)
      .set('X-Business-Id', a.businessId)
      .send({ translations: { ar: 'قسم' } });
    const catId = cat.body.id as string;
    const res = await t.request
      .post('/v1/catalog/products')
      .set('Authorization', `Bearer ${b.token}`)
      .set('X-Business-Id', b.businessId)
      .send({ translations: { ar: 'منتج' }, basePriceMinor: '500', priceCurrency: 'ILS', categoryId: catId });
    expect(res.status).toBe(400);
  });

  it('branch→warehouse cross-business FK rejected at DB level (§39)', async () => {
    const a = await onboardUser('br-a');
    const b = await onboardUser('br-b');
    const aBranch = (await ownerPool().query('SELECT id FROM branches WHERE business_id = $1 AND is_default', [a.businessId])).rows[0]?.id as string;
    // Direct DB write attempt as app role under B's scope:
    const appPool = (await import('pg')).Pool;
    const pool = new appPool({ connectionString: process.env['APP_DB_URL'] ?? 'postgresql://daftar_app:test_app_password_123@localhost:55432/daftar', max: 1 });
    const c = await pool.connect();
    const bTenant = (await ownerPool().query('SELECT tenant_id FROM businesses WHERE id = $1', [b.businessId])).rows[0]?.tenant_id as string;
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true), set_config('app.bypass_rls', 'false', true)`, [
      bTenant,
      b.businessId,
    ]);
    const res = await c
      .query('INSERT INTO warehouses (business_id, id, branch_id, name) VALUES ($1, gen_random_uuid(), $2, $3)', [b.businessId, aBranch, 'cross'])
      .catch((e: { code: string }) => e);
    await c.query('ROLLBACK');
    c.release();
    await pool.end();
    // Rejected — by composite FK (23503) or by RLS scope (42501) before the FK check. Either proves the wall.
    expect(['23503', '42501']).toContain((res as { code: string }).code);
  });

  describe('owner safety (§28)', () => {
    it('removing the LAST owner fails; second owner allows removal of the first', async () => {
      const a = await onboardUser('owner-biz');
      const meA = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${a.token}`);
      const ownerAId = meA.body.userId as string;

      // Removing the only owner → 409 LAST_OWNER_REMOVAL
      const fail = await t.request
        .delete(`/v1/businesses/current/members/${ownerAId}`)
        .set('Authorization', `Bearer ${a.token}`)
        .set('X-Business-Id', a.businessId);
      expect(fail.status).toBe(409);
      expect(fail.body.error.code).toBe('LAST_OWNER_REMOVAL');

      // Add owner B (via DB: owner role assignment is system-managed; owner A invites B as manager then promotes? —
      // owner key cannot be assigned via API (system-managed). Seed owner B directly as system op.)
      const regB = await t.request.post('/v1/auth/register').send({
        email: uniqueEmail(),
        password: 'Str0ng!Passw0rd',
        displayName: 'B',
        preferredLocale: 'ar',
      });
      const meB = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${regB.body.accessToken as string}`);
      const ownerBId = meB.body.userId as string;
      const ownerRole = (await ownerPool().query(`SELECT id FROM business_roles WHERE business_id = $1 AND key = 'owner'`, [a.businessId])).rows[0]
        ?.id as string;
      await ownerPool().query(
        `INSERT INTO tenant_memberships (tenant_id, user_id, role_key)
         SELECT tenant_id, $2, 'tenant_member' FROM businesses WHERE id = $1 ON CONFLICT DO NOTHING`,
        [a.businessId, ownerBId],
      );
      await ownerPool().query(
        `INSERT INTO memberships (tenant_id, business_id, user_id, status, joined_at)
         SELECT tenant_id, id, $2, 'active', now() FROM businesses WHERE id = $1`,
        [a.businessId, ownerBId],
      );
      await ownerPool().query('INSERT INTO membership_roles (business_id, user_id, role_id) VALUES ($1, $2, $3)', [a.businessId, ownerBId, ownerRole]);

      // Now removing owner A succeeds (B remains)
      const ok = await t.request
        .delete(`/v1/businesses/current/members/${ownerAId}`)
        .set('Authorization', `Bearer ${regB.body.accessToken as string}`)
        .set('X-Business-Id', a.businessId);
      expect(ok.status).toBe(200);

      // And removing owner B (now last) fails again
      const fail2 = await t.request
        .delete(`/v1/businesses/current/members/${ownerBId}`)
        .set('Authorization', `Bearer ${regB.body.accessToken as string}`)
        .set('X-Business-Id', a.businessId);
      expect(fail2.status).toBe(409);
    });

    it('two simultaneous removals of the last two owners: exactly one succeeds (locking)', async () => {
      const a = await onboardUser('race-owner-biz');
      const meA = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${a.token}`);
      const ownerAId = meA.body.userId as string;
      const regB = await t.request.post('/v1/auth/register').send({
        email: uniqueEmail(),
        password: 'Str0ng!Passw0rd',
        displayName: 'B',
        preferredLocale: 'ar',
      });
      const tokenB = regB.body.accessToken as string;
      const ownerBId = (await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${tokenB}`)).body.userId as string;
      const ownerRole = (await ownerPool().query(`SELECT id FROM business_roles WHERE business_id = $1 AND key = 'owner'`, [a.businessId])).rows[0]
        ?.id as string;
      await ownerPool().query(
        `INSERT INTO tenant_memberships (tenant_id, user_id, role_key)
         SELECT tenant_id, $2, 'tenant_member' FROM businesses WHERE id = $1 ON CONFLICT DO NOTHING`,
        [a.businessId, ownerBId],
      );
      await ownerPool().query(
        `INSERT INTO memberships (tenant_id, business_id, user_id, status, joined_at)
         SELECT tenant_id, id, $2, 'active', now() FROM businesses WHERE id = $1`,
        [a.businessId, ownerBId],
      );
      await ownerPool().query('INSERT INTO membership_roles (business_id, user_id, role_id) VALUES ($1, $2, $3)', [a.businessId, ownerBId, ownerRole]);

      const [r1, r2] = await Promise.all([
        t.request.delete(`/v1/businesses/current/members/${ownerAId}`).set('Authorization', `Bearer ${a.token}`).set('X-Business-Id', a.businessId),
        t.request.delete(`/v1/businesses/current/members/${ownerBId}`).set('Authorization', `Bearer ${tokenB}`).set('X-Business-Id', a.businessId),
      ]);
      const statuses = [r1.status, r2.status].sort((x, y) => x - y);
      expect(statuses).toEqual([200, 409]);

      // At least one owner remains
      const owners = await ownerPool().query(
        `SELECT count(*) FROM memberships m
         JOIN membership_roles mr ON mr.business_id = m.business_id AND mr.user_id = m.user_id
         JOIN business_roles r ON r.business_id = mr.business_id AND r.id = mr.role_id
         WHERE m.business_id = $1 AND m.status = 'active' AND r.key = 'owner'`,
        [a.businessId],
      );
      expect(Number(owners.rows[0]?.count)).toBe(1);
    });
  });

  describe('system role immutability (§26)', () => {
    it('app role cannot INSERT/UPDATE/DELETE system roles even in bypass-free tx', async () => {
      const a = await onboardUser('sysrole-biz');
      const pool = new (await import('pg')).Pool({
        connectionString: 'postgresql://daftar_app:test_app_password_123@localhost:55432/daftar',
        max: 1,
      });
      const c = await pool.connect();
      const tenantId = (await ownerPool().query('SELECT tenant_id FROM businesses WHERE id = $1', [a.businessId])).rows[0]?.tenant_id as string;
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true), set_config('app.bypass_rls', 'false', true)`, [
        tenantId,
        a.businessId,
      ]);
      const ins = await c
        .query(`INSERT INTO business_roles (business_id, id, key, name, is_system) VALUES ($1, gen_random_uuid(), 'superuser', 'x', true)`, [a.businessId])
        .catch((e: { code: string }) => e);
      expect((ins as { code: string }).code).toBe('P0001');
      await c.query('ROLLBACK');

      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true), set_config('app.bypass_rls', 'false', true)`, [
        tenantId,
        a.businessId,
      ]);
      const upd = await c
        .query(`UPDATE business_roles SET is_system = false WHERE business_id = $1 AND key = 'owner'`, [a.businessId])
        .catch((e: { code: string }) => e);
      expect((upd as { code: string }).code).toBe('P0001');
      await c.query('ROLLBACK');

      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true), set_config('app.bypass_rls', 'false', true)`, [
        tenantId,
        a.businessId,
      ]);
      const del = await c.query(`DELETE FROM business_roles WHERE business_id = $1 AND key = 'owner'`, [a.businessId]).catch((e: { code: string }) => e);
      // DELETE is denied by GRANTs (app role has no DELETE on business_roles) — the
      // trigger is the second wall if grants ever widen. Either rejection proves it.
      expect(['P0001', '42501']).toContain((del as { code: string }).code);
      await c.query('ROLLBACK');
      c.release();
      await pool.end();
    });

    it('client cannot set is_system / owner key via API (mass assignment, §94–95)', async () => {
      const a = await onboardUser('massasgn-biz');
      const res = await t.request
        .post('/v1/businesses/current/roles')
        .set('Authorization', `Bearer ${a.token}`)
        .set('X-Business-Id', a.businessId)
        .send({ key: 'owner', name: 'fake', permissions: ['member.manage'], is_system: true });
      expect([400, 403]).toContain(res.status);
      // and no new owner-like role appeared
      const roles = await t.request.get('/v1/businesses/current/roles').set('Authorization', `Bearer ${a.token}`).set('X-Business-Id', a.businessId);
      expect(roles.body.items.filter((r: { isSystem: boolean }) => r.isSystem).length).toBe(1);
    });
  });

  describe('pooled connection safety (§38) — SECURITY RELEASE BLOCKER', () => {
    it('Request A then Request B on the same pooled connection: no stale context', async () => {
      const a = await onboardUser('pool-a');
      const b = await onboardUser('pool-b');
      await t.request
        .post('/v1/catalog/products')
        .set('Authorization', `Bearer ${a.token}`)
        .set('X-Business-Id', a.businessId)
        .send({ translations: { ar: 'سرّي أ' }, basePriceMinor: '100', priceCurrency: 'ILS' });

      // Hammer alternately — pool reuse makes stale context visible if any exists.
      for (let i = 0; i < 5; i += 1) {
        const listA = await t.request.get('/v1/catalog/products').set('Authorization', `Bearer ${a.token}`).set('X-Business-Id', a.businessId);
        const listB = await t.request.get('/v1/catalog/products').set('Authorization', `Bearer ${b.token}`).set('X-Business-Id', b.businessId);
        expect(listA.body.items.length).toBe(1);
        expect(listB.body.items.length).toBe(0);
      }
    });

    it('default-deny: app role with NO context sees zero rows (proven at DB)', async () => {
      await onboardUser('deny-biz');
      const pool = new (await import('pg')).Pool({
        connectionString: 'postgresql://daftar_app:test_app_password_123@localhost:55432/daftar',
        max: 1,
      });
      const r = await pool.query('SELECT count(*) FROM businesses');
      expect(Number(r.rows[0]?.count)).toBe(0);
      const p = await pool.query('SELECT count(*) FROM products');
      expect(Number(p.rows[0]?.count)).toBe(0);
      await pool.end();
    });
  });
});
