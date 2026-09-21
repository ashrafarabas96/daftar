import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, ownerPool, resetData, uniqueEmail, type TestApp, grantFeature } from '../helpers/test-app';

/**
 * §27–31 RBAC delegation ceiling: a non-owner actor may only CREATE or ASSIGN
 * roles whose effective permissions are a subset of their own grant authority.
 * The owner is exempt (owner authority is total by identity). The owner role
 * can never be minted or assigned through generic APIs.
 */
describe('RBAC delegation ceiling (§27–31)', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
    await resetData();
  });

  function auth(token: string, businessId: string) {
    return { Authorization: `Bearer ${token}`, 'X-Business-Id': businessId };
  }

  async function registerUser(): Promise<{ token: string; userId: string; email: string }> {
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

  async function onboard(slug: string): Promise<{ token: string; businessId: string; userId: string; email: string }> {
    const u = await registerUser();
    const on = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
      .set('Authorization', `Bearer ${u.token}`)
      .send({
        businessName: `Biz ${slug}`,
        countryCode: 'PS',
        baseCurrency: 'ILS',
        storeSlug: slug,
      });
    return { ...u, businessId: on.body.businessId as string };
  }

  async function myBusinessId(token: string): Promise<string> {
    const res = await t.request.get('/v1/me/businesses').set('Authorization', `Bearer ${token}`);
    return (res.body.items as { businessId: string }[])[0]?.businessId ?? '';
  }

  /**
   * Owner + delegated member B ("lead" role: member/role/catalog authority,
   * NO billing/business.manage) + an owner-created "billing-admin" role.
   */
  async function setup(extraSlots = false) {
    const owner = await onboard(`ceil-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    // Custom-role creation requires the CUSTOM_ROLES capability (§21–22).
    await grantFeature(owner.businessId, owner.userId, 'CUSTOM_ROLES');
    if (extraSlots) {
      // Fixture via DB superuser: platform-owned override raising MAX_USERS so
      // the test can add/invite beyond the free plan's 2 seats.
      await ownerPool().query(
        `INSERT INTO entitlement_overrides (business_id, limit_key, limit_value, reason, actor_user_id)
         VALUES ($1, 'MAX_USERS', 10, 'delegation-ceiling-test', $2)`,
        [owner.businessId, owner.userId],
      );
    }
    const lead = await t.request
      .post('/v1/businesses/current/roles')
      .set(auth(owner.token, owner.businessId))
      .send({
        key: 'lead',
        name: 'Lead',
        permissions: ['member.view', 'member.manage', 'member.invite', 'role.view', 'role.create', 'role.assign', 'catalog.view'],
      });
    expect(lead.status).toBe(201);
    const billing = await t.request
      .post('/v1/businesses/current/roles')
      .set(auth(owner.token, owner.businessId))
      .send({
        key: 'billing-admin',
        name: 'Billing Admin',
        permissions: ['billing.view', 'billing.manage'],
      });
    expect(billing.status).toBe(201);
    const b = await registerUser();
    const add = await t.request.post('/v1/businesses/current/members').set(auth(owner.token, owner.businessId)).send({
      email: b.email,
      roleKey: 'lead',
    });
    expect(add.status).toBe(201);
    const bBusinessId = await myBusinessId(b.token);
    expect(bBusinessId).toBe(owner.businessId);
    return { owner, b: { ...b, businessId: bBusinessId } };
  }

  it('non-owner cannot create a role containing permissions beyond their authority', async () => {
    const { b } = await setup();
    const res = await t.request
      .post('/v1/businesses/current/roles')
      .set(auth(b.token, b.businessId))
      .send({
        key: 'power',
        name: 'Power',
        permissions: ['catalog.view', 'billing.manage'],
      });
    expect(res.status).toBe(403);
  });

  it('non-owner CAN create a role composed only of permissions they hold', async () => {
    const { b } = await setup();
    const res = await t.request
      .post('/v1/businesses/current/roles')
      .set(auth(b.token, b.businessId))
      .send({
        key: 'clerk',
        name: 'Clerk',
        permissions: ['catalog.view', 'member.view'],
      });
    expect(res.status).toBe(201);
  });

  it('owner is exempt from the ceiling (can create any role)', async () => {
    const { owner } = await setup();
    const res = await t.request
      .post('/v1/businesses/current/roles')
      .set(auth(owner.token, owner.businessId))
      .send({
        key: 'everything',
        name: 'Everything',
        permissions: ['billing.manage', 'member.manage', 'business.manage', 'role.create'],
      });
    expect(res.status).toBe(201);
  });

  it('custom role cannot be keyed owner (system-managed identity)', async () => {
    const { owner } = await setup();
    const res = await t.request
      .post('/v1/businesses/current/roles')
      .set(auth(owner.token, owner.businessId))
      .send({
        key: 'owner',
        name: 'Fake Owner',
        permissions: ['catalog.view'],
      });
    expect(res.status).toBe(403);
  });

  it('non-owner cannot ASSIGN a role whose permissions exceed their ceiling', async () => {
    const { owner, b } = await setup(true);
    const c = await registerUser();
    const addC = await t.request.post('/v1/businesses/current/members').set(auth(owner.token, owner.businessId)).send({
      email: c.email,
      roleKey: 'lead',
    });
    expect(addC.status).toBe(201);
    const res = await t.request
      .patch(`/v1/businesses/current/members/${c.userId}/roles`)
      .set(auth(b.token, b.businessId))
      .send({ roleKeys: ['billing-admin'] });
    expect(res.status).toBe(403);
  });

  it('non-owner CAN assign a role within their ceiling', async () => {
    const { owner, b } = await setup(true);
    await t.request
      .post('/v1/businesses/current/roles')
      .set(auth(owner.token, owner.businessId))
      .send({
        key: 'viewer',
        name: 'Viewer',
        permissions: ['catalog.view'],
      });
    const c = await registerUser();
    await t.request.post('/v1/businesses/current/members').set(auth(owner.token, owner.businessId)).send({
      email: c.email,
      roleKey: 'viewer',
    });
    const res = await t.request
      .patch(`/v1/businesses/current/members/${c.userId}/roles`)
      .set(auth(b.token, b.businessId))
      .send({ roleKeys: ['viewer', 'lead'] });
    expect(res.status).toBe(200);
  });

  it('non-owner cannot add a member with a role beyond their ceiling', async () => {
    const { b } = await setup();
    const d = await registerUser();
    const res = await t.request.post('/v1/businesses/current/members').set(auth(b.token, b.businessId)).send({
      email: d.email,
      roleKey: 'billing-admin',
    });
    expect(res.status).toBe(403);
  });

  it('non-owner cannot INVITE with a role beyond their ceiling', async () => {
    const { b } = await setup();
    const res = await t.request.post('/v1/businesses/current/invitations').set(auth(b.token, b.businessId)).send({
      email: uniqueEmail(),
      roleKey: 'billing-admin',
    });
    expect(res.status).toBe(403);
  });

  it('non-owner CAN invite with a role within their ceiling', async () => {
    const { owner, b } = await setup(true);
    await t.request
      .post('/v1/businesses/current/roles')
      .set(auth(owner.token, owner.businessId))
      .send({
        key: 'viewer2',
        name: 'Viewer2',
        permissions: ['catalog.view'],
      });
    const res = await t.request.post('/v1/businesses/current/invitations').set(auth(b.token, b.businessId)).send({
      email: uniqueEmail(),
      roleKey: 'viewer2',
    });
    expect(res.status).toBe(201);
  });
});
