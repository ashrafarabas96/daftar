import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, grantFeature, ownerPool, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';

/**
 * P2-S1 — accounting permissions through the REAL onboarding path
 * (directive §18, §19, §23). Registering a key in TypeScript proves nothing
 * about what a newly created business actually persists, so this suite drives
 * the HTTP onboarding flow and then reads the rows back.
 */
const ACCOUNTING = ['accounting.view', 'accounting.post', 'accounting.reverse', 'accounting.chart.manage', 'accounting.fx.manage'] as const;

describe('P2-S1 accounting permissions (real onboarding path)', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
    await resetData();
  });

  function auth(token: string, businessId: string) {
    return { Authorization: `Bearer ${token}`, 'X-Business-Id': businessId };
  }

  async function registerUser(): Promise<{ token: string; userId: string; email: string }> {
    const reg = await t.request.post('/v1/auth/register').send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'U', preferredLocale: 'ar' });
    const token = reg.body.accessToken as string;
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
    return { token, userId: me.body.userId as string, email: me.body.email as string };
  }

  async function onboard(slug: string): Promise<{ token: string; userId: string; businessId: string }> {
    const u = await registerUser();
    const on = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
      .set('Authorization', `Bearer ${u.token}`)
      .send({ businessName: `Biz ${slug}`, countryCode: 'PS', baseCurrency: 'ILS', storeSlug: slug });
    expect(on.status).toBe(201);
    return { token: u.token, userId: u.userId, businessId: on.body.businessId as string };
  }

  async function permissionsOf(businessId: string, roleKey: string): Promise<string[]> {
    const { rows } = await ownerPool().query<{ permission: string }>(
      `SELECT rp.permission FROM role_permissions rp
       JOIN business_roles r ON r.business_id = rp.business_id AND r.id = rp.role_id
       WHERE rp.business_id = $1 AND r.key = $2 ORDER BY rp.permission`,
      [businessId, roleKey],
    );
    return rows.map((r) => r.permission);
  }

  it('a business created after 0041 persists all five accounting keys on its owner role', async () => {
    const owner = await onboard(`perm-owner-${Date.now()}`);
    const persisted = await permissionsOf(owner.businessId, 'owner');
    for (const key of ACCOUNTING) expect(persisted).toContain(key);
  });

  it('manager and cashier gain no accounting authority at creation', async () => {
    const owner = await onboard(`perm-roles-${Date.now()}`);
    for (const roleKey of ['manager', 'cashier']) {
      const persisted = await permissionsOf(owner.businessId, roleKey);
      expect(persisted.filter((p) => p.startsWith('accounting.'))).toEqual([]);
    }
  });

  /**
   * P2-S6 §21. The two period keys are persisted on the owner role and on
   * NOTHING else — including no built-in accountant role, which C-12 still
   * forbids. `manage` and `reopen` are two rows, never one: a backfill that
   * wrote only `manage` would silently make closing the books imply undoing
   * them for every existing merchant.
   */
  it('the owner role persists BOTH period permissions, and no other role persists either', async () => {
    const owner = await onboard(`perm-period-${Date.now()}`);
    const persisted = await permissionsOf(owner.businessId, 'owner');
    expect(persisted).toContain('accounting.period.manage');
    expect(persisted).toContain('accounting.period.reopen');

    for (const roleKey of ['manager', 'cashier']) {
      const other = await permissionsOf(owner.businessId, roleKey);
      expect(other.filter((k) => k.startsWith('accounting.period.'))).toEqual([]);
    }

    const { rows } = await ownerPool().query<{ key: string }>(
      `SELECT DISTINCT r.key FROM role_permissions rp
       JOIN business_roles r ON r.business_id = rp.business_id AND r.id = rp.role_id
       WHERE rp.permission LIKE 'accounting.period.%' ORDER BY r.key`,
    );
    expect(rows.map((r) => r.key)).toEqual(['owner']);
  });

  it('no built-in "accountant" role is created (C-12)', async () => {
    const owner = await onboard(`perm-c12-${Date.now()}`);
    const { rows } = await ownerPool().query<{ key: string }>(`SELECT key FROM business_roles WHERE business_id = $1 ORDER BY key`, [owner.businessId]);
    expect(rows.map((r) => r.key)).toEqual(['cashier', 'manager', 'owner']);
  });

  it('the owner can compose an accounting permission into a custom role through the existing trusted flow', async () => {
    const owner = await onboard(`perm-custom-${Date.now()}`);
    await grantFeature(owner.businessId, owner.userId, 'CUSTOM_ROLES');
    const res = await t.request
      .post('/v1/businesses/current/roles')
      .set(auth(owner.token, owner.businessId))
      .send({ key: 'bookkeeper', name: 'Bookkeeper', permissions: ['accounting.view', 'accounting.chart.manage'] });
    expect(res.status).toBe(201);
    expect(await permissionsOf(owner.businessId, 'bookkeeper')).toEqual(['accounting.chart.manage', 'accounting.view']);
  });

  it('a non-owner without accounting.chart.manage cannot delegate it (delegation ceiling)', async () => {
    const owner = await onboard(`perm-ceiling-${Date.now()}`);
    await grantFeature(owner.businessId, owner.userId, 'CUSTOM_ROLES');
    await ownerPool().query(
      `INSERT INTO entitlement_overrides (business_id, limit_key, limit_value, reason, actor_user_id) VALUES ($1, 'MAX_USERS', 10, 'p2-s1-test', $2)`,
      [owner.businessId, owner.userId],
    );
    const lead = await t.request
      .post('/v1/businesses/current/roles')
      .set(auth(owner.token, owner.businessId))
      .send({ key: 'lead', name: 'Lead', permissions: ['role.view', 'role.create', 'role.assign', 'member.view', 'accounting.view'] });
    expect(lead.status).toBe(201);

    const member = await registerUser();
    const add = await t.request.post('/v1/businesses/current/members').set(auth(owner.token, owner.businessId)).send({ email: member.email, roleKey: 'lead' });
    expect(add.status).toBe(201);

    // Holds accounting.view, so may pass that on…
    const allowed = await t.request
      .post('/v1/businesses/current/roles')
      .set(auth(member.token, owner.businessId))
      .send({ key: 'reader', name: 'Reader', permissions: ['accounting.view'] });
    expect(allowed.status).toBe(201);

    // …but chart authority is beyond their ceiling.
    const refused = await t.request
      .post('/v1/businesses/current/roles')
      .set(auth(member.token, owner.businessId))
      .send({ key: 'chart-editor', name: 'Chart Editor', permissions: ['accounting.view', 'accounting.chart.manage'] });
    expect(refused.status).toBe(403);
  });

  it('P2-S1 exposes NO accounting HTTP mutation surface (§20)', async () => {
    const owner = await onboard(`perm-http-${Date.now()}`);
    const headers = auth(owner.token, owner.businessId);
    for (const [method, path] of [
      ['post', '/v1/accounting/accounts'],
      ['patch', '/v1/accounting/accounts/00000000-0000-0000-0000-000000000000'],
      ['delete', '/v1/accounting/accounts/00000000-0000-0000-0000-000000000000'],
      ['post', '/v1/accounting/entries'],
    ] as const) {
      const res = await t.request[method](path).set(headers).send({});
      expect(res.status).toBe(404);
    }
  });
});
