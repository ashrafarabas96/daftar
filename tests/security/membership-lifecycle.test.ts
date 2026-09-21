import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, ownerPool, resetData, uniqueEmail, type TestApp, grantFeature } from '../helpers/test-app';

/**
 * WAVE 1 (BLOCKER P1) — Membership authority lifecycle: removal ENDS current
 * effective authority (roles + branch scopes purged, recorded in audit);
 * re-add/re-invite starts a FRESH authorization relationship. Suspend keeps
 * roles; reactivate restores exactly them. addMember never bypasses states.
 */
describe('membership authority lifecycle (WAVE 1)', () => {
  let t: TestApp;
  const inviteTokens: string[] = [];
  const delivery = {
    kind: 'capture-test-adapter',
    sendPasswordReset: () => Promise.resolve(),
    sendInvitation: (_email: string, token: string) => {
      inviteTokens.push(token);
      return Promise.resolve();
    },
  };

  beforeEach(async () => {
    t = await createTestApp({ delivery });
    await resetData();
    inviteTokens.length = 0;
  });

  function auth(token: string, businessId: string) {
    return { Authorization: `Bearer ${token}`, 'X-Business-Id': businessId };
  }

  async function register(): Promise<{ token: string; userId: string; email: string }> {
    const reg = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(),
      password: 'Str0ng!Passw0rd',
      displayName: 'U',
      preferredLocale: 'ar',
    });
    const token = reg.body.accessToken as string;
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
    return { token, userId: me.body.userId as string, email: me.body.email as string };
  }

  async function onboard(): Promise<{ token: string; userId: string; email: string; businessId: string }> {
    const u = await register();
    const on = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
      .set('Authorization', `Bearer ${u.token}`)
      .send({
        businessName: 'Biz',
        countryCode: 'PS',
        baseCurrency: 'ILS',
        storeSlug: `lc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      });
    const businessId = on.body.businessId as string;
    await grantFeature(businessId, u.userId, 'CUSTOM_ROLES');
    return { ...u, businessId };
  }

  async function roleKeysOf(businessId: string, userId: string): Promise<string[]> {
    const { rows } = await ownerPool().query<{ key: string }>(
      `SELECT r.key FROM membership_roles mr JOIN business_roles r
         ON r.business_id = mr.business_id AND r.id = mr.role_id
       WHERE mr.business_id = $1 AND mr.user_id = $2`,
      [businessId, userId],
    );
    return rows.map((r) => r.key).sort();
  }

  it('PRIVILEGE RESURRECTION: removed owner re-added as cashier never regains owner', async () => {
    const a = await onboard();
    const b = await register();
    // Fixture: B is a second owner (ownership is system-managed; tests set it via superuser).
    const ownerRole = (await ownerPool().query<{ id: string }>(`SELECT id FROM business_roles WHERE business_id = $1 AND key = 'owner'`, [a.businessId]))
      .rows[0]?.id;
    await ownerPool().query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role_key)
         SELECT tenant_id, $2, 'tenant_member' FROM businesses WHERE id = $1 ON CONFLICT DO NOTHING`,
      [a.businessId, b.userId],
    );
    await ownerPool().query(
      `INSERT INTO memberships (tenant_id, business_id, user_id, status, joined_at)
         SELECT tenant_id, id, $2, 'active', now() FROM businesses WHERE id = $1`,
      [a.businessId, b.userId],
    );
    await ownerPool().query('INSERT INTO membership_roles (business_id, user_id, role_id) VALUES ($1, $2, $3)', [a.businessId, b.userId, ownerRole]);
    expect(await roleKeysOf(a.businessId, b.userId)).toEqual(['owner']);

    // Owner A removes owner B.
    const rm = await t.request.delete(`/v1/businesses/current/members/${b.userId}`).set(auth(a.token, a.businessId));
    expect(rm.status).toBe(200);
    // Current effective authority is GONE.
    expect(await roleKeysOf(a.businessId, b.userId)).toEqual([]);

    // Re-add as cashier: fresh authorization relationship.
    const add = await t.request.post('/v1/businesses/current/members').set(auth(a.token, a.businessId)).send({
      email: b.email,
      roleKey: 'cashier',
    });
    expect(add.status).toBe(201);
    expect(await roleKeysOf(a.businessId, b.userId)).toEqual(['cashier']);

    // B has cashier power only — member management is denied.
    const denied = await t.request.get('/v1/businesses/current/members').set(auth(b.token, a.businessId));
    expect(denied.status).toBe(403);

    // Audit recorded the removed authority.
    const audit = await ownerPool().query(
      `SELECT metadata FROM audit_events WHERE action = 'structure.member_removed' AND entity_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [b.userId],
    );
    expect((audit.rows[0]?.metadata as { removedRoleKeys?: string[] }).removedRoleKeys).toEqual(['owner']);
  });

  it('addMember on an ACTIVE member → ALREADY_MEMBER (no silent role merge)', async () => {
    const a = await onboard();
    const b = await register();
    const add1 = await t.request.post('/v1/businesses/current/members').set(auth(a.token, a.businessId)).send({
      email: b.email,
      roleKey: 'cashier',
    });
    expect(add1.status).toBe(201);
    const add2 = await t.request.post('/v1/businesses/current/members').set(auth(a.token, a.businessId)).send({
      email: b.email,
      roleKey: 'manager',
    });
    expect(add2.status).toBe(409);
    expect((add2.body.error as { code: string }).code).toBe('ALREADY_MEMBER');
    expect(await roleKeysOf(a.businessId, b.userId)).toEqual(['cashier']);
  });

  it('addMember on a SUSPENDED member → 409 (must use reactivate)', async () => {
    const a = await onboard();
    const b = await register();
    await t.request.post('/v1/businesses/current/members').set(auth(a.token, a.businessId)).send({
      email: b.email,
      roleKey: 'cashier',
    });
    const susp = await t.request.post(`/v1/businesses/current/members/${b.userId}/suspend`).set(auth(a.token, a.businessId));
    expect(susp.status).toBe(200);
    const add = await t.request.post('/v1/businesses/current/members').set(auth(a.token, a.businessId)).send({
      email: b.email,
      roleKey: 'manager',
    });
    expect(add.status).toBe(409);
    expect((add.body.error as { code: string }).code).toBe('MEMBER_SUSPENDED');
    // Roles unchanged through suspension.
    expect(await roleKeysOf(a.businessId, b.userId)).toEqual(['cashier']);
    // Reactivate restores exactly the same roles.
    const re = await t.request.post(`/v1/businesses/current/members/${b.userId}/reactivate`).set(auth(a.token, a.businessId));
    expect(re.status).toBe(200);
    expect(await roleKeysOf(a.businessId, b.userId)).toEqual(['cashier']);
  });

  it('removed member re-invited + accept → only the invited role (clean set)', async () => {
    const a = await onboard();
    const b = await register();
    await t.request.post('/v1/businesses/current/members').set(auth(a.token, a.businessId)).send({
      email: b.email,
      roleKey: 'manager',
    });
    expect(await roleKeysOf(a.businessId, b.userId)).toEqual(['manager']);
    const rm = await t.request.delete(`/v1/businesses/current/members/${b.userId}`).set(auth(a.token, a.businessId));
    expect(rm.status).toBe(200);

    // Custom role for the fresh invitation (system roles are not invitable).
    const role = await t.request
      .post('/v1/businesses/current/roles')
      .set(auth(a.token, a.businessId))
      .send({
        key: 'clerk',
        name: 'Clerk',
        permissions: ['catalog.view'],
      });
    expect(role.status).toBe(201);
    const inv = await t.request.post('/v1/businesses/current/invitations').set(auth(a.token, a.businessId)).send({
      email: b.email,
      roleKey: 'clerk',
    });
    expect(inv.status).toBe(201);
    await t.worker.drain(); // request path enqueues only; the worker delivers
    const token = inviteTokens[inviteTokens.length - 1];
    const acc = await t.request.post('/v1/invitations/accept').set('Authorization', `Bearer ${b.token}`).send({ token });
    expect(acc.status).toBe(200);
    expect(await roleKeysOf(a.businessId, b.userId)).toEqual(['clerk']);
    // Manager-grade power is gone.
    const denied = await t.request
      .post('/v1/businesses/current/roles')
      .set(auth(b.token, a.businessId))
      .send({
        key: 'x',
        name: 'X',
        permissions: ['catalog.view'],
      });
    expect(denied.status).toBe(403);
  });

  it('suspended member cannot be resurrected via invitation accept', async () => {
    const a = await onboard();
    const b = await register();
    await t.request.post('/v1/businesses/current/members').set(auth(a.token, a.businessId)).send({
      email: b.email,
      roleKey: 'cashier',
    });
    await t.request.post(`/v1/businesses/current/members/${b.userId}/suspend`).set(auth(a.token, a.businessId));
    const role = await t.request
      .post('/v1/businesses/current/roles')
      .set(auth(a.token, a.businessId))
      .send({
        key: 'clerk2',
        name: 'Clerk2',
        permissions: ['catalog.view'],
      });
    expect(role.status).toBe(201);
    const inv = await t.request.post('/v1/businesses/current/invitations').set(auth(a.token, a.businessId)).send({
      email: b.email,
      roleKey: 'clerk2',
    });
    expect(inv.status).toBe(201);
    await t.worker.drain(); // request path enqueues only; the worker delivers
    const token = inviteTokens[inviteTokens.length - 1];
    const acc = await t.request.post('/v1/invitations/accept').set('Authorization', `Bearer ${b.token}`).send({ token });
    expect(acc.status).toBe(409);
    expect((acc.body.error as { code: string }).code).toBe('MEMBER_SUSPENDED');
    expect(await roleKeysOf(a.businessId, b.userId)).toEqual(['cashier']);
  });
});
