import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, grantFeature, ownerPool, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';

/**
 * WAVE 4 — Invitation lifecycle completion: expired-sweep before
 * invite/list/resend/accept, expired-resend policy (reject, no silent
 * extension), direct-add converts pending reservations (no double quota),
 * delivery tracking on invitations AND password resets.
 */
describe('invitation lifecycle hardening (WAVE 4)', () => {
  let t: TestApp;
  let inviteTokens: string[];
  let failDelivery: boolean;
  const delivery = {
    kind: 'capture-test-adapter',
    sendPasswordReset: () => {
      if (failDelivery) return Promise.reject(new Error('smtp down'));
      return Promise.resolve();
    },
    sendInvitation: (_email: string, token: string) => {
      if (failDelivery) return Promise.reject(new Error('smtp down'));
      inviteTokens.push(token);
      return Promise.resolve();
    },
  };

  beforeEach(async () => {
    inviteTokens = [];
    failDelivery = false;
    t = await createTestApp({ delivery });
    await resetData();
  });

  function auth(token: string, businessId: string) {
    return { Authorization: `Bearer ${token}`, 'X-Business-Id': businessId };
  }

  async function onboard(): Promise<{ token: string; businessId: string; userId: string }> {
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
        businessName: 'Biz',
        countryCode: 'PS',
        baseCurrency: 'ILS',
        storeSlug: `il-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      });
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
    const userId = me.body.userId as string;
    await grantFeature(on.body.businessId as string, userId, 'CUSTOM_ROLES');
    return { token, businessId: on.body.businessId as string, userId };
  }

  async function makeRole(a: { token: string; businessId: string }, key: string) {
    const role = await t.request
      .post('/v1/businesses/current/roles')
      .set(auth(a.token, a.businessId))
      .send({
        key,
        name: key,
        permissions: ['catalog.view'],
      });
    expect(role.status).toBe(201);
  }

  async function forceExpire(businessId: string, email: string) {
    await ownerPool().query(
      `UPDATE business_invitations SET expires_at = now() - interval '1 hour'
       WHERE business_id = $1 AND email = $2 AND status = 'pending'`,
      [businessId, email],
    );
  }

  async function invitationRows(businessId: string, email: string) {
    const { rows } = await ownerPool().query<{ status: string; delivery_status: string; delivery_attempts: number }>(
      `SELECT status, delivery_status, delivery_attempts FROM business_invitations
       WHERE business_id = $1 AND email = $2 ORDER BY created_at`,
      [businessId, email],
    );
    return rows;
  }

  it('expired pending invite no longer blocks a new invitation (sweep before invite)', async () => {
    const a = await onboard();
    await makeRole(a, 'clerk');
    const email = uniqueEmail();
    const inv1 = await t.request.post('/v1/businesses/current/invitations').set(auth(a.token, a.businessId)).send({ email, roleKey: 'clerk' });
    expect(inv1.status).toBe(201);
    await forceExpire(a.businessId, email);
    const inv2 = await t.request.post('/v1/businesses/current/invitations').set(auth(a.token, a.businessId)).send({ email, roleKey: 'clerk' });
    expect(inv2.status).toBe(201);
    const rows = await invitationRows(a.businessId, email);
    expect(rows.map((r) => r.status)).toEqual(['expired', 'pending']);
  });

  it('list sweeps expired rows (never shows stale pending)', async () => {
    const a = await onboard();
    await makeRole(a, 'clerk');
    const email = uniqueEmail();
    await t.request.post('/v1/businesses/current/invitations').set(auth(a.token, a.businessId)).send({ email, roleKey: 'clerk' });
    await forceExpire(a.businessId, email);
    const list = await t.request.get('/v1/businesses/current/invitations').set(auth(a.token, a.businessId));
    const item = (list.body.items as { email: string; status: string }[]).find((i) => i.email === email);
    expect(item?.status).toBe('expired');
  });

  it('resend of an EXPIRED invitation → 409 INVITATION_EXPIRED (no silent extension)', async () => {
    const a = await onboard();
    await makeRole(a, 'clerk');
    const email = uniqueEmail();
    const inv = await t.request.post('/v1/businesses/current/invitations').set(auth(a.token, a.businessId)).send({ email, roleKey: 'clerk' });
    const id = inv.body.invitationId as string;
    await t.worker.drain(); // request path enqueues only; the worker delivers
    await forceExpire(a.businessId, email);
    const res = await t.request.post(`/v1/businesses/current/invitations/${id}/resend`).set(auth(a.token, a.businessId));
    expect(res.status).toBe(409);
    expect((res.body.error as { code: string }).code).toBe('INVITATION_EXPIRED');
    // No new token was minted or delivered.
    expect(inviteTokens.length).toBe(1);
  });

  it('resend of a VALID pending invitation rotates token and extends expiry', async () => {
    const a = await onboard();
    await makeRole(a, 'clerk');
    const email = uniqueEmail();
    const inv = await t.request.post('/v1/businesses/current/invitations').set(auth(a.token, a.businessId)).send({ email, roleKey: 'clerk' });
    const id = inv.body.invitationId as string;
    await t.worker.drain(); // first token delivered (request path never drains)
    const res = await t.request.post(`/v1/businesses/current/invitations/${id}/resend`).set(auth(a.token, a.businessId));
    expect(res.status).toBe(200);
    await t.worker.drain(); // rotated token delivered
    expect(inviteTokens.length).toBe(2);
    // Old token is dead; the rotated token is the only valid one.
    const oldToken = inviteTokens[0] ?? '';
    const newToken = inviteTokens[1] ?? '';
    const regB = await t.request.post('/v1/invitations/accept-register').send({
      token: oldToken,
      email,
      password: 'Str0ng!Passw0rd',
      displayName: 'B',
    });
    expect(regB.status).toBe(404);
    const accB = await t.request.post('/v1/invitations/accept-register').send({
      token: newToken,
      email,
      password: 'Str0ng!Passw0rd',
      displayName: 'B',
    });
    expect(accB.status).toBe(200);
    expect(accB.status).toBe(200);
  });

  it('direct add with a PENDING invitation converts the reservation (invitation cancelled, no double quota)', async () => {
    const a = await onboard();
    await makeRole(a, 'clerk');
    const email = uniqueEmail();
    const reg = await t.request.post('/v1/auth/register').send({
      email,
      password: 'Str0ng!Passw0rd',
      displayName: 'B',
      preferredLocale: 'ar',
    });
    expect(reg.status).toBe(201);
    const inv = await t.request.post('/v1/businesses/current/invitations').set(auth(a.token, a.businessId)).send({ email, roleKey: 'clerk' });
    expect(inv.status).toBe(201);
    const add = await t.request.post('/v1/businesses/current/members').set(auth(a.token, a.businessId)).send({ email, roleKey: 'clerk' });
    expect(add.status).toBe(201);
    const rows = await invitationRows(a.businessId, email);
    expect(rows.map((r) => r.status)).toEqual(['cancelled']);
    // Quota reflects exactly ONE member for this user (no double counting).
    const ent = await t.request.get('/v1/businesses/current/entitlement').set(auth(a.token, a.businessId));
    const maxUsers = (ent.body.limits as { key: string; usage: number }[]).find((l) => l.key === 'MAX_USERS');
    expect(maxUsers?.usage).toBe(2); // owner + the added member
  });

  it('delivery failure is tracked: invitation stays pending, delivery_status=failed', async () => {
    const a = await onboard();
    await makeRole(a, 'clerk');
    failDelivery = true;
    const email = uniqueEmail();
    const inv = await t.request.post('/v1/businesses/current/invitations').set(auth(a.token, a.businessId)).send({ email, roleKey: 'clerk' });
    // The invitation COMMITS even when delivery fails — and the failure is visible.
    expect(inv.status).toBe(201);
    // Part C: the request path only ENQUEUES — the worker drains after commit.
    await t.worker.drain();
    const rows = await invitationRows(a.businessId, email);
    expect(rows[0]).toMatchObject({ status: 'pending', delivery_status: 'failed', delivery_attempts: 1 });
  });

  it('successful delivery is tracked (delivery_status=sent)', async () => {
    const a = await onboard();
    await makeRole(a, 'clerk');
    const email = uniqueEmail();
    await t.request.post('/v1/businesses/current/invitations').set(auth(a.token, a.businessId)).send({ email, roleKey: 'clerk' });
    await t.worker.drain();
    const rows = await invitationRows(a.businessId, email);
    expect(rows[0]).toMatchObject({ status: 'pending', delivery_status: 'sent', delivery_attempts: 1 });
  });

  it('password reset delivery failure is tracked on the token row', async () => {
    const email = uniqueEmail();
    await t.request.post('/v1/auth/register').send({
      email,
      password: 'Str0ng!Passw0rd',
      displayName: 'U',
      preferredLocale: 'ar',
    });
    failDelivery = true;
    const res = await t.request.post('/v1/auth/password-reset/request').send({ email });
    expect([200, 201, 204]).toContain(res.status); // enumeration-safe: same outcome either way
    await t.worker.drain();
    const { rows } = await ownerPool().query<{ delivery_status: string; delivery_attempts: number; last_delivery_error: string | null }>(
      `SELECT prt.delivery_status, prt.delivery_attempts, prt.last_delivery_error
       FROM password_reset_tokens prt JOIN users u ON u.id = prt.user_id WHERE u.email = $1`,
      [email],
    );
    expect(rows[0]?.delivery_status).toBe('failed');
    expect(rows[0]?.delivery_attempts).toBe(1);
    expect(rows[0]?.last_delivery_error).toBe('DELIVERY_FAILED'); // §XXIII: classified, never raw
  });

  it('password reset successful delivery is tracked', async () => {
    const email = uniqueEmail();
    await t.request.post('/v1/auth/register').send({
      email,
      password: 'Str0ng!Passw0rd',
      displayName: 'U',
      preferredLocale: 'ar',
    });
    const res = await t.request.post('/v1/auth/password-reset/request').send({ email });
    expect([200, 201, 204]).toContain(res.status);
    await t.worker.drain();
    const { rows } = await ownerPool().query<{ delivery_status: string }>(
      `SELECT prt.delivery_status FROM password_reset_tokens prt JOIN users u ON u.id = prt.user_id WHERE u.email = $1`,
      [email],
    );
    expect(rows[0]?.delivery_status).toBe('sent');
  });
});
