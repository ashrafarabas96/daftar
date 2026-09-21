import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, ownerPool, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';

/**
 * Wave 5/6/8: multi-user team management, invitations lifecycle,
 * multi-role union permissions, plan limits via the entitlement engine,
 * downgrade (OVER_LIMIT) behavior — data preserved, additions blocked.
 */
describe('team, invitations & entitlements', () => {
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

  async function onboardUser(slug: string): Promise<{ token: string; businessId: string; userId: string }> {
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
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
    return { token, businessId: on.body.businessId as string, userId: me.body.userId as string };
  }

  async function lastInviteToken(): Promise<string> {
    // Part C: invitations are ENQUEUED in the request tx; the worker delivers.
    await t.worker.drain();
    const tok = inviteTokens[inviteTokens.length - 1];
    if (!tok) throw new Error('no invitation token captured');
    return tok;
  }

  function auth(token: string, businessId: string) {
    return { Authorization: `Bearer ${token}`, 'X-Business-Id': businessId };
  }

  it('onboarding provisions a free-plan trial entitlement (same atomic tx)', async () => {
    const a = await onboardUser('ent-biz');
    const res = await t.request.get('/v1/businesses/current/entitlement').set(auth(a.token, a.businessId));
    expect(res.status).toBe(200);
    expect(res.body.planKey).toBe('free');
    expect(res.body.state).toBe('trial');
    expect(res.body.trialEndsAt).toBeTruthy();
    const maxUsers = (res.body.limits as { key: string; limit: number; usage: number }[]).find((l) => l.key === 'MAX_USERS');
    expect(maxUsers).toMatchObject({ limit: 2, usage: 1 });
    const customRoles = (res.body.features as { key: string; enabled: boolean }[]).find((f) => f.key === 'CUSTOM_ROLES');
    expect(customRoles?.enabled).toBe(false);
  });

  it('plan limit: free plan MAX_USERS=2 — third member denied with PLAN_LIMIT_EXCEEDED', async () => {
    const a = await onboardUser('limit-biz');
    const email2 = uniqueEmail();
    const email3 = uniqueEmail();
    await t.request.post('/v1/auth/register').send({
      email: email2,
      password: 'Str0ng!Passw0rd',
      displayName: 'M2',
      preferredLocale: 'ar',
    });
    await t.request.post('/v1/auth/register').send({
      email: email3,
      password: 'Str0ng!Passw0rd',
      displayName: 'M3',
      preferredLocale: 'ar',
    });
    const add2 = await t.request.post('/v1/businesses/current/members').set(auth(a.token, a.businessId)).send({ email: email2, roleKey: 'cashier' });
    expect(add2.status).toBe(201);
    const add3 = await t.request.post('/v1/businesses/current/members').set(auth(a.token, a.businessId)).send({ email: email3, roleKey: 'cashier' });
    expect(add3.status).toBe(409);
    expect(add3.body.error.code).toBe('PLAN_LIMIT_EXCEEDED');
    expect(add3.body.error.details).toMatchObject({ limitKey: 'MAX_USERS', limit: 2, usage: 2 });
  });

  it('downgrade rule: over-limit override blocks additions but preserves data', async () => {
    const a = await onboardUser('downgrade-biz');
    const email2 = uniqueEmail();
    await t.request.post('/v1/auth/register').send({
      email: email2,
      password: 'Str0ng!Passw0rd',
      displayName: 'M2',
      preferredLocale: 'ar',
    });
    await t.request.post('/v1/businesses/current/members').set(auth(a.token, a.businessId)).send({ email: email2, roleKey: 'cashier' });
    // Super-admin-style override lowers MAX_USERS to 1 (system op, seeded directly).
    const ownerId = a.userId;
    await ownerPool().query(
      `INSERT INTO entitlement_overrides (business_id, limit_key, limit_value, reason, actor_user_id)
       VALUES ($1, 'MAX_USERS', 1, 'downgrade-test', $2)`,
      [a.businessId, ownerId],
    );
    const email3 = uniqueEmail();
    await t.request.post('/v1/auth/register').send({
      email: email3,
      password: 'Str0ng!Passw0rd',
      displayName: 'M3',
      preferredLocale: 'ar',
    });
    const add3 = await t.request.post('/v1/businesses/current/members').set(auth(a.token, a.businessId)).send({ email: email3, roleKey: 'cashier' });
    expect(add3.status).toBe(409);
    // Data preserved: both members still listed, none deleted.
    const members = await t.request.get('/v1/businesses/current/members').set(auth(a.token, a.businessId));
    expect(members.body.items.length).toBe(2);
  });

  it('invitation lifecycle: invite → accept (new user registers) → member active with role', async () => {
    const a = await onboardUser('invite-biz');
    const email = uniqueEmail();
    const inv = await t.request.post('/v1/businesses/current/invitations').set(auth(a.token, a.businessId)).send({ email, roleKey: 'cashier' });
    expect(inv.status).toBe(201);
    // duplicate pending invite → 409
    const dup = await t.request.post('/v1/businesses/current/invitations').set(auth(a.token, a.businessId)).send({ email, roleKey: 'cashier' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('INVITATION_EXISTS');

    const token = await lastInviteToken();
    const acc = await t.request.post('/v1/invitations/accept-register').send({
      token,
      email,
      password: 'Str0ng!Passw0rd',
      displayName: 'New Joiner',
    });
    expect(acc.status).toBe(200);
    expect(acc.body.businessId).toBe(a.businessId);

    const members = await t.request.get('/v1/businesses/current/members').set(auth(a.token, a.businessId));
    const joined = (members.body.items as { email: string; roleKeys: string[]; status: string; joinedAt: string | null }[]).find((mm) => mm.email === email);
    if (!joined) throw new Error('member not found after accept');
    expect(joined.status).toBe('active');
    expect(joined.roleKeys).toEqual(['cashier']);
    expect(joined.joinedAt).toBeTruthy();

    // token is single-use
    const again = await t.request.post('/v1/invitations/accept-register').send({
      token,
      email,
      password: 'Str0ng!Passw0rd',
      displayName: 'Replay',
    });
    expect(again.status).toBe(404);
  });

  it('invitation expiry: expired invite → 409 INVITATION_EXPIRED, row marked expired', async () => {
    const a = await onboardUser('expiry-biz');
    const email = uniqueEmail();
    await t.request.post('/v1/businesses/current/invitations').set(auth(a.token, a.businessId)).send({ email, roleKey: 'cashier' });
    await ownerPool().query(`UPDATE business_invitations SET expires_at = now() - interval '1 hour' WHERE email = $1`, [email]);
    const token = await lastInviteToken();
    const acc = await t.request.post('/v1/invitations/accept-register').send({
      token,
      email,
      password: 'Str0ng!Passw0rd',
      displayName: 'Late',
    });
    expect(acc.status).toBe(409);
    expect(acc.body.error.code).toBe('INVITATION_EXPIRED');
    const row = (await ownerPool().query(`SELECT status FROM business_invitations WHERE email = $1`, [email])).rows[0];
    expect(row?.status).toBe('expired');
  });

  it('invitation cancel + wrong-email acceptance forbidden', async () => {
    const a = await onboardUser('cancel-biz');
    const email = uniqueEmail();
    const inv = await t.request.post('/v1/businesses/current/invitations').set(auth(a.token, a.businessId)).send({ email, roleKey: 'cashier' });
    // wrong email register attempt
    const wrong = await t.request.post('/v1/invitations/accept-register').send({
      token: await lastInviteToken(),
      email: uniqueEmail(),
      password: 'Str0ng!Passw0rd',
      displayName: 'X',
    });
    expect(wrong.status).toBe(400);
    const cancel = await t.request.delete(`/v1/businesses/current/invitations/${inv.body.invitationId as string}`).set(auth(a.token, a.businessId));
    expect(cancel.status).toBe(200);
    const acc = await t.request.post('/v1/invitations/accept-register').send({
      token: await lastInviteToken(),
      email,
      password: 'Str0ng!Passw0rd',
      displayName: 'X',
    });
    expect(acc.status).toBe(404);
  });

  it('multi-role union: cashier + custom catalog role → can create products', async () => {
    const a = await onboardUser('union-biz');
    // CUSTOM_ROLES feature is disabled on free plan — enable via override (system op).
    await ownerPool().query(
      `INSERT INTO entitlement_overrides (business_id, feature_key, enabled_value, reason, actor_user_id)
       VALUES ($1, 'CUSTOM_ROLES', true, 'union-test', $2)`,
      [a.businessId, a.userId],
    );
    const role = await t.request
      .post('/v1/businesses/current/roles')
      .set(auth(a.token, a.businessId))
      .send({ key: 'stock-clerk', name: 'Stock Clerk', permissions: ['catalog.view', 'catalog.create'] });
    expect(role.status).toBe(201);

    const email = uniqueEmail();
    await t.request.post('/v1/businesses/current/invitations').set(auth(a.token, a.businessId)).send({ email, roleKey: 'cashier' });
    const acc = await t.request.post('/v1/invitations/accept-register').send({
      token: await lastInviteToken(),
      email,
      password: 'Str0ng!Passw0rd',
      displayName: 'J',
    });
    const login = await t.request.post('/v1/auth/login').send({ email, password: 'Str0ng!Passw0rd' });
    const memberToken = login.body.accessToken as string;
    void acc;

    // cashier alone cannot create products
    const denied = await t.request
      .post('/v1/catalog/products')
      .set(auth(memberToken, a.businessId))
      .send({ translations: { ar: 'منتج' }, basePriceMinor: '100', priceCurrency: 'ILS' });
    expect(denied.status).toBe(403);

    // add the custom role as a SECOND role (union)
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${memberToken}`);
    const set = await t.request
      .patch(`/v1/businesses/current/members/${me.body.userId as string}/roles`)
      .set(auth(a.token, a.businessId))
      .send({ roleKeys: ['cashier', 'stock-clerk'] });
    expect(set.status).toBe(200);

    const allowed = await t.request
      .post('/v1/catalog/products')
      .set(auth(memberToken, a.businessId))
      .send({ translations: { ar: 'منتج' }, basePriceMinor: '100', priceCurrency: 'ILS' });
    expect(allowed.status).toBe(201);
  });

  it('owner role cannot be granted via setMemberRoles (system-managed)', async () => {
    const a = await onboardUser('owner-grant-biz');
    const email2 = uniqueEmail();
    const reg2 = await t.request.post('/v1/auth/register').send({
      email: email2,
      password: 'Str0ng!Passw0rd',
      displayName: 'M2',
      preferredLocale: 'ar',
    });
    await t.request.post('/v1/businesses/current/members').set(auth(a.token, a.businessId)).send({ email: email2, roleKey: 'cashier' });
    const me2 = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${reg2.body.accessToken as string}`);
    const grant = await t.request
      .patch(`/v1/businesses/current/members/${me2.body.userId as string}/roles`)
      .set(auth(a.token, a.businessId))
      .send({ roleKeys: ['owner'] });
    expect(grant.status).toBe(403);
  });

  it('suspend → immediate access loss; reactivate restores (MAX_USERS checked)', async () => {
    const a = await onboardUser('suspend-biz');
    const email = uniqueEmail();
    const reg2 = await t.request.post('/v1/auth/register').send({
      email,
      password: 'Str0ng!Passw0rd',
      displayName: 'M2',
      preferredLocale: 'ar',
    });
    const token2 = reg2.body.accessToken as string;
    await t.request.post('/v1/businesses/current/members').set(auth(a.token, a.businessId)).send({ email, roleKey: 'cashier' });
    const me2 = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token2}`);
    const uid2 = me2.body.userId as string;

    const before = await t.request.get('/v1/catalog/products').set(auth(token2, a.businessId));
    expect(before.status).toBe(200);

    const susp = await t.request.post(`/v1/businesses/current/members/${uid2}/suspend`).set(auth(a.token, a.businessId));
    expect(susp.status).toBe(200);
    const during = await t.request.get('/v1/catalog/products').set(auth(token2, a.businessId));
    expect(during.status).toBe(403);

    const re = await t.request.post(`/v1/businesses/current/members/${uid2}/reactivate`).set(auth(a.token, a.businessId));
    expect(re.status).toBe(200);
    const after = await t.request.get('/v1/catalog/products').set(auth(token2, a.businessId));
    expect(after.status).toBe(200);

    // removed members are preserved in history (status='removed'), not deleted
    await t.request.delete(`/v1/businesses/current/members/${uid2}`).set(auth(a.token, a.businessId));
    const row = (await ownerPool().query(`SELECT status, disabled_at FROM memberships WHERE business_id = $1 AND user_id = $2`, [a.businessId, uid2])).rows[0];
    expect(row?.status).toBe('removed');
    expect(row?.disabled_at).toBeTruthy();
    const list = await t.request.get('/v1/businesses/current/members').set(auth(a.token, a.businessId));
    expect((list.body.items as { userId: string }[]).find((mm) => mm.userId === uid2)).toBeUndefined();
  });

  it('override rows REQUIRE reason + actor (DB CHECK) and expired overrides are ignored', async () => {
    const a = await onboardUser('override-biz');
    await expect(
      ownerPool().query(
        `INSERT INTO entitlement_overrides (business_id, limit_key, limit_value, reason, actor_user_id)
         VALUES ($1, 'MAX_USERS', 99, '', $2)`,
        [a.businessId, a.userId],
      ),
    ).rejects.toThrow();
    // expired override does not apply
    await ownerPool().query(
      `INSERT INTO entitlement_overrides (business_id, limit_key, limit_value, reason, actor_user_id, starts_at, ends_at)
       VALUES ($1, 'MAX_USERS', 99, 'expired-window', $2, now() - interval '2 hours', now() - interval '1 hour')`,
      [a.businessId, a.userId],
    );
    const res = await t.request.get('/v1/businesses/current/entitlement').set(auth(a.token, a.businessId));
    const maxUsers = (res.body.limits as { key: string; limit: number }[]).find((l) => l.key === 'MAX_USERS');
    expect(maxUsers?.limit).toBe(2);
  });

  it('plan change is an entitlement-engine operation (no plan-name branching); modules stay plan-agnostic', async () => {
    const a = await onboardUser('plan-biz');
    // system op: upgrade to starter (MAX_USERS=5)
    await ownerPool().query(
      `UPDATE business_entitlements SET plan_version_id =
         (SELECT id FROM plan_versions WHERE plan_key = 'starter' ORDER BY version DESC LIMIT 1)
       WHERE business_id = $1`,
      [a.businessId],
    );
    const res = await t.request.get('/v1/businesses/current/entitlement').set(auth(a.token, a.businessId));
    expect(res.body.planKey).toBe('starter');
    const maxUsers = (res.body.limits as { key: string; limit: number }[]).find((l) => l.key === 'MAX_USERS');
    expect(maxUsers?.limit).toBe(5);
    // MULTI_BRANCH now enabled → second branch allowed
    const br = await t.request.post('/v1/businesses/current/branches').set(auth(a.token, a.businessId)).send({ name: 'B2' });
    expect(br.status).toBe(201);
  });

  it('plan versions are immutable at the DB level', async () => {
    await expect(ownerPool().query(`UPDATE plan_versions SET version = 2 WHERE plan_key = 'free'`)).rejects.toThrow();
    await expect(ownerPool().query(`DELETE FROM plan_versions WHERE plan_key = 'free'`)).rejects.toThrow();
  });
});
