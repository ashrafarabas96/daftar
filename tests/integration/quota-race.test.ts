import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, grantFeature, ownerPool, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';

/**
 * §28/§46–48 — Quota concurrency: with ONE slot left, simultaneous consumers
 * must serialize on the quota advisory lock: exactly ONE succeeds, the rest
 * get PLAN_LIMIT_EXCEEDED. Applies to users (invitations), branches, products.
 */
describe('quota concurrency', () => {
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

  async function onboard(slug: string): Promise<{ token: string; businessId: string; userId: string }> {
    const reg = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'U', preferredLocale: 'ar',
    });
    const on = await t.request.post('/v1/onboarding/complete').set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random()*1e9)}`).set('Authorization', `Bearer ${reg.body.accessToken as string}`).send({
      businessName: 'B', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: slug,
    });
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${reg.body.accessToken as string}`);
    return { token: reg.body.accessToken as string, businessId: on.body.businessId as string, userId: me.body.userId as string };
  }

  function auth(token: string, businessId: string) {
    return { Authorization: `Bearer ${token}`, 'X-Business-Id': businessId };
  }

  it('MAX_USERS race: one slot left + two simultaneous invitations → exactly one success', async () => {
    const a = await onboard(`qr-u-${Date.now()}`); // free plan: MAX_USERS=2, owner occupies 1
    const [r1, r2] = await Promise.all([
      t.request.post('/v1/businesses/current/invitations').set(auth(a.token, a.businessId))
        .send({ email: uniqueEmail(), roleKey: 'cashier' }),
      t.request.post('/v1/businesses/current/invitations').set(auth(a.token, a.businessId))
        .send({ email: uniqueEmail(), roleKey: 'cashier' }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(loser.body.error.code).toBe('PLAN_LIMIT_EXCEEDED');
  });

  it('pending invite reserves the slot: cancel releases it, expiry releases it', async () => {
    const a = await onboard(`qr-r-${Date.now()}`);
    const inv = await t.request.post('/v1/businesses/current/invitations').set(auth(a.token, a.businessId))
      .send({ email: uniqueEmail(), roleKey: 'cashier' });
    expect(inv.status).toBe(201);
    // slot now reserved — second invite denied
    const denied = await t.request.post('/v1/businesses/current/invitations').set(auth(a.token, a.businessId))
      .send({ email: uniqueEmail(), roleKey: 'cashier' });
    expect(denied.status).toBe(409);
    // cancel releases
    const list = await t.request.get('/v1/businesses/current/invitations').set(auth(a.token, a.businessId));
    const invId = (list.body.items as { id: string }[])[0]?.id;
    if (!invId) throw new Error('invitation not listed');
    const cancel = await t.request.delete(`/v1/businesses/current/invitations/${invId}`).set(auth(a.token, a.businessId));
    expect(cancel.status).toBe(200);
    const after = await t.request.post('/v1/businesses/current/invitations').set(auth(a.token, a.businessId))
      .send({ email: uniqueEmail(), roleKey: 'cashier' });
    expect(after.status).toBe(201);
  });

  it('MAX_PRODUCTS race: limit lowered to current usage + 1 → exactly one of two creates succeeds', async () => {
    const a = await onboard(`qr-p-${Date.now()}`);
    await ownerPool().query(
      `INSERT INTO entitlement_overrides (business_id, limit_key, limit_value, reason, actor_user_id)
       VALUES ($1, 'MAX_PRODUCTS', 1, 'race-test', $2)`,
      [a.businessId, a.userId],
    );
    const mk = () => t.request.post('/v1/catalog/products').set(auth(a.token, a.businessId))
      .send({ translations: { ar: 'منتج' }, basePriceMinor: '100', priceCurrency: 'ILS' });
    const [r1, r2] = await Promise.all([mk(), mk()]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
  });

  it('MAX_BRANCHES race: limit 2 (default branch occupies 1) → exactly one of two creates succeeds', async () => {
    const a = await onboard(`qr-b-${Date.now()}`);
    // free plan MAX_BRANCHES=1 + MULTI_BRANCH off — raise limit, grant feature
    await grantFeature(a.businessId, a.userId, 'MULTI_BRANCH');
    await ownerPool().query(
      `INSERT INTO entitlement_overrides (business_id, limit_key, limit_value, reason, actor_user_id)
       VALUES ($1, 'MAX_BRANCHES', 2, 'race-test', $2)`,
      [a.businessId, a.userId],
    );
    const mk = () => t.request.post('/v1/businesses/current/branches').set(auth(a.token, a.businessId))
      .send({ name: `Br-${Math.random()}` });
    const [r1, r2] = await Promise.all([mk(), mk()]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
  });
});
