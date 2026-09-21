import { beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { createTestApp, ownerPool, resetData, uniqueEmail, appDbUrl, type TestApp, grantFeature } from '../helpers/test-app';

function must<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null) throw new Error(`missing ${what}`);
  return v;
}

async function asApp(fn: (c: Client) => Promise<unknown>): Promise<void> {
  const c = new Client({ connectionString: appDbUrl });
  await c.connect();
  try {
    await fn(c);
  } finally {
    await c.end();
  }
}

/**
 * §69–74 team role CRUD completion:
 *  - role.update / role.delete commands exist and are permission-gated
 *  - system roles are immutable (API 403 AND DB trigger)
 *  - delegation ceiling applies to role UPDATE (no widening beyond authority)
 *  - delete-with-assigned: 409 ROLE_IN_USE without replacement, atomic
 *    reassignment with replacementRoleKey (ceiling-checked)
 *  - member role assignment requires the dedicated role.assign permission
 */
describe('team role CRUD (§69–74)', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
    await resetData();
  });

  function auth(token: string, businessId: string) {
    return { Authorization: `Bearer ${token}`, 'X-Business-Id': businessId };
  }

  async function onboard(slug: string) {
    const reg = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'O', preferredLocale: 'ar',
    });
    const token = reg.body.accessToken as string;
    const on = await t.request.post('/v1/onboarding/complete').set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random()*1e9)}`).set('Authorization', `Bearer ${token}`).send({
      businessName: 'B', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: slug,
    });
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
    return { token, businessId: on.body.businessId as string, tenantId: on.body.tenantId as string, userId: me.body.userId as string };
  }

  async function setup() {
    const o = await onboard(`rc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    await grantFeature(o.businessId, o.userId, 'CUSTOM_ROLES');
    return o;
  }

  async function createRole(o: { token: string; businessId: string }, key: string, permissions: string[]) {
    const res = await t.request.post('/v1/businesses/current/roles').set(auth(o.token, o.businessId)).send({
      key, name: key, permissions,
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  it('role.update renames and replaces the permission set (audited)', async () => {
    const o = await setup();
    const roleId = await createRole(o, 'clerk', ['catalog.view']);
    const res = await t.request.patch(`/v1/businesses/current/roles/${roleId}`).set(auth(o.token, o.businessId)).send({
      name: 'Senior Clerk', permissions: ['catalog.view', 'catalog.create'],
    });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Senior Clerk');
    expect(res.body.permissions).toEqual(['catalog.view', 'catalog.create']);
    const { rows } = await ownerPool().query<{ action: string }>(
      `SELECT action FROM audit_events WHERE entity_id = $1 AND action = 'structure.role_updated'`, [roleId],
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('system roles are immutable: API 403 + DB trigger blocks raw UPDATE/DELETE', async () => {
    const o = await setup();
    const { rows } = await ownerPool().query<{ id: string }>(
      `SELECT id FROM business_roles WHERE business_id = $1 AND is_system AND key = 'owner'`, [o.businessId],
    );
    const ownerRoleId = must(rows[0], 'owner role').id;
    const res = await t.request.patch(`/v1/businesses/current/roles/${ownerRoleId}`).set(auth(o.token, o.businessId)).send({
      name: 'Hacked',
    });
    expect(res.status).toBe(403);
    const del = await t.request.delete(`/v1/businesses/current/roles/${ownerRoleId}`).set(auth(o.token, o.businessId)).send({});
    expect(del.status).toBe(403);
    // Raw SQL as the merchant role must ALSO be stopped by the trigger
    // (with tenant context set so the row is visible under RLS).
    await expect(
      asApp(async (c) => {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [o.tenantId, o.businessId]);
        await c.query(`UPDATE business_roles SET name = 'x' WHERE id = $1`, [ownerRoleId]);
      }),
    ).rejects.toThrow(/immutable|system/i);
  });

  it('delegation ceiling applies to role UPDATE: a non-owner cannot widen a role', async () => {
    const o = await setup();
    // Lead can manage roles but holds no billing authority.
    const leadId = await createRole(o, 'lead', ['role.view', 'role.create', 'role.update', 'catalog.view']);
    const clerkId = await createRole(o, 'clerk2', ['catalog.view']);
    const reg = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'L', preferredLocale: 'ar',
    });
    const leadToken = reg.body.accessToken as string;
    const email = (await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${leadToken}`)).body.email as string;
    await t.request.post('/v1/businesses/current/members').set(auth(o.token, o.businessId)).send({ email, roleKey: 'lead' });
    // Widening clerk2 to include billing.manage exceeds the lead's authority.
    const res = await t.request.patch(`/v1/businesses/current/roles/${clerkId}`).set(auth(leadToken, o.businessId)).send({
      permissions: ['catalog.view', 'billing.manage'],
    });
    expect(res.status).toBe(403);
    // Within ceiling is allowed.
    const ok = await t.request.patch(`/v1/businesses/current/roles/${clerkId}`).set(auth(leadToken, o.businessId)).send({
      permissions: ['catalog.view'],
    });
    expect(ok.status).toBe(200);
    expect(leadId).toBeTruthy();
  });

  it('delete-with-assigned: 409 ROLE_IN_USE without replacement; atomic reassignment with replacement', async () => {
    const o = await setup();
    const clerkId = await createRole(o, 'temp', ['catalog.view']);
    const viewerId = await createRole(o, 'viewer2', ['catalog.view']);
    const reg = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'M', preferredLocale: 'ar',
    });
    const token = reg.body.accessToken as string;
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
    const add = await t.request.post('/v1/businesses/current/members').set(auth(o.token, o.businessId)).send({
      email: me.body.email as string, roleKey: 'temp',
    });
    expect(add.status).toBe(201);
    const memberId = me.body.userId as string;

    const conflict = await t.request.delete(`/v1/businesses/current/roles/${clerkId}`).set(auth(o.token, o.businessId)).send({});
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('ROLE_IN_USE');

    const del = await t.request.delete(`/v1/businesses/current/roles/${clerkId}`).set(auth(o.token, o.businessId)).send({
      replacementRoleKey: 'viewer2',
    });
    expect(del.status).toBe(200);
    const { rows } = await ownerPool().query<{ role_id: string }>(
      'SELECT role_id FROM membership_roles WHERE business_id = $1 AND user_id = $2', [o.businessId, memberId],
    );
    expect(rows.map((r) => r.role_id)).toEqual([viewerId]);
    const { rows: gone } = await ownerPool().query<{ id: string }>(
      'SELECT id FROM business_roles WHERE id = $1', [clerkId],
    );
    expect(gone).toHaveLength(0);
  });

  it('member role assignment requires role.assign (member.manage alone is not enough)', async () => {
    const o = await setup();
    // manager-style role WITHOUT role.assign
    const noAssignId = await createRole(o, 'noassign', ['member.view', 'member.manage', 'catalog.view']);
    expect(noAssignId).toBeTruthy();
    const reg = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'N', preferredLocale: 'ar',
    });
    const token = reg.body.accessToken as string;
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
    await t.request.post('/v1/businesses/current/members').set(auth(o.token, o.businessId)).send({
      email: me.body.email as string, roleKey: 'noassign',
    });
    const res = await t.request.patch(`/v1/businesses/current/members/${me.body.userId as string}/roles`)
      .set(auth(token, o.businessId)).send({ roleKeys: ['noassign'] });
    expect(res.status).toBe(403);
  });
});
