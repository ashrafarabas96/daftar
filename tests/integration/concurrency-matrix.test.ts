import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, ownerPool, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';

function must<T>(v: T | undefined | null): T {
  if (v === undefined || v === null) throw new Error('expected value');
  return v;
}

/**
 * Directive §66 — concurrency review matrix. Every race the directive names
 * must resolve to exactly one winner, a stable error for the loser, and a
 * consistent database afterwards (never a 500, never a torn state).
 *
 * Races already covered elsewhere: quota limits (quota-race), last-owner
 * removal/demotion (isolation, owner-authority), slug race (onboarding),
 * refresh-token reuse (refresh-lineage), support-session revoke
 * (support-sessions), platform-owner bootstrap (bootstrap-owner), product
 * optimistic concurrency (catalog).
 */
describe('concurrency matrix (§66)', () => {
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
    const email = uniqueEmail();
    const reg = await t.request.post('/v1/auth/register').send({ email, password: 'Str0ng!Passw0rd', displayName: 'U', preferredLocale: 'ar' });
    expect(reg.status).toBe(201);
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${reg.body.accessToken as string}`);
    return { token: reg.body.accessToken as string, userId: me.body.userId as string, email };
  }

  async function onboard(): Promise<{ token: string; businessId: string; userId: string }> {
    const u = await register();
    const on = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `cm-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
      .set('Authorization', `Bearer ${u.token}`)
      .send({ businessName: 'Race', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `cm-${Date.now()}-${Math.floor(Math.random() * 1e6)}` });
    expect(on.status).toBe(201);
    return { token: u.token, businessId: on.body.businessId as string, userId: u.userId };
  }

  async function platformOwner(): Promise<{ token: string }> {
    const u = await register();
    await ownerPool().query(`INSERT INTO platform_role_memberships (user_id, role_key) VALUES ($1, 'platform_owner')`, [u.userId]);
    return { token: u.token };
  }

  it('same invitation token accepted twice concurrently → exactly one 200, one 404; ONE membership', async () => {
    const a = await onboard();
    const invitee = await register();
    const inv = await t.request.post('/v1/businesses/current/invitations').set(auth(a.token, a.businessId)).send({ email: invitee.email, roleKey: 'cashier' });
    expect(inv.status).toBe(201);
    await t.worker.drain();
    const token = must(inviteTokens[0]);

    const [r1, r2] = await Promise.all([
      t.request.post('/v1/invitations/accept').set('Authorization', `Bearer ${invitee.token}`).send({ token }),
      t.request.post('/v1/invitations/accept').set('Authorization', `Bearer ${invitee.token}`).send({ token }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 404]);

    const members = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM memberships WHERE business_id = $1 AND user_id = $2`, [
      a.businessId,
      invitee.userId,
    ]);
    expect(Number(must(members.rows[0]).n)).toBe(1);
    const inviteRows = await ownerPool().query<{ status: string }>(`SELECT status FROM business_invitations WHERE business_id = $1`, [a.businessId]);
    expect(inviteRows.rows.map((r) => r.status)).toEqual(['accepted']);
  });

  it('concurrent PUBLISH of the same draft plan version → exactly one 200, one 409; ONE audit event', async () => {
    const p = await platformOwner();
    const created = await t.request
      .post('/v1/admin/plan-versions')
      .set('Authorization', `Bearer ${p.token}`)
      .send({ planKey: 'free', limits: { MAX_USERS: 3 } });
    expect(created.status).toBe(201);
    const pvId = (created.body as { id: string }).id;

    const [r1, r2] = await Promise.all([
      t.request.post(`/v1/admin/plan-versions/${pvId}/publish`).set('Authorization', `Bearer ${p.token}`),
      t.request.post(`/v1/admin/plan-versions/${pvId}/publish`).set('Authorization', `Bearer ${p.token}`),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const state = await ownerPool().query<{ state: string }>('SELECT state FROM plan_versions WHERE id = $1', [pvId]);
    expect(must(state.rows[0]).state).toBe('PUBLISHED');
    const audit = await ownerPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events WHERE action = 'admin.plan_version_published' AND entity_id = $1`,
      [pvId],
    );
    expect(Number(must(audit.rows[0]).n)).toBe(1);
  });

  it('role change racing member removal → no 500; a removed member NEVER keeps effective roles', async () => {
    const a = await onboard();
    const m = await register();
    const add = await t.request.post('/v1/businesses/current/members').set(auth(a.token, a.businessId)).send({ email: m.email, roleKey: 'cashier' });
    expect(add.status).toBe(201);

    const [roles, removal] = await Promise.all([
      t.request
        .patch(`/v1/businesses/current/members/${m.userId}/roles`)
        .set(auth(a.token, a.businessId))
        .send({ roleKeys: ['manager'] }),
      t.request.delete(`/v1/businesses/current/members/${m.userId}`).set(auth(a.token, a.businessId)),
    ]);
    // Removal always wins eventually: the role change either landed first (200) or saw the removed row (404).
    expect(removal.status).toBe(200);
    expect([200, 404]).toContain(roles.status);

    const row = must(
      (await ownerPool().query<{ status: string }>('SELECT status FROM memberships WHERE business_id = $1 AND user_id = $2', [a.businessId, m.userId])).rows[0],
    );
    expect(row.status).toBe('removed');
    const effective = await ownerPool().query<{ n: string }>('SELECT count(*)::text AS n FROM membership_roles WHERE business_id = $1 AND user_id = $2', [
      a.businessId,
      m.userId,
    ]);
    expect(Number(must(effective.rows[0]).n)).toBe(0);
    // The removed member has lost access immediately.
    const denied = await t.request.get('/v1/businesses/current').set(auth(m.token, a.businessId));
    expect(denied.status).toBe(403);
  });

  it('CONCURRENT onboarding with the same Idempotency-Key + same payload → one 201, one 200 replay, ONE business', async () => {
    const u = await register();
    const key = `cm-same-${Date.now()}`;
    const payload = { businessName: 'Same', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `cm-same-${Date.now()}` };
    const call = () => t.request.post('/v1/onboarding/complete').set('Idempotency-Key', key).set('Authorization', `Bearer ${u.token}`).send(payload);
    const [r1, r2] = await Promise.all([call(), call()]);
    expect([r1.status, r2.status].sort()).toEqual([200, 201]);
    const winner = r1.status === 201 ? r1 : r2;
    const loser = r1.status === 201 ? r2 : r1;
    expect(loser.body.businessId).toBe(winner.body.businessId);
    expect(loser.body.replayed).toBe(true);
    const n = await ownerPool().query<{ n: string }>('SELECT count(*)::text AS n FROM businesses WHERE store_slug = $1', [payload.storeSlug]);
    expect(Number(must(n.rows[0]).n)).toBe(1);
    const tenants = await ownerPool().query<{ n: string }>('SELECT count(*)::text AS n FROM tenant_memberships WHERE user_id = $1', [u.userId]);
    expect(Number(must(tenants.rows[0]).n)).toBe(1);
  });

  it('CONCURRENT onboarding with the same Idempotency-Key + DIFFERENT payload → one 201, one 409, ONE business', async () => {
    const u = await register();
    const key = `cm-diff-${Date.now()}`;
    const stamp = Date.now();
    const [r1, r2] = await Promise.all([
      t.request
        .post('/v1/onboarding/complete')
        .set('Idempotency-Key', key)
        .set('Authorization', `Bearer ${u.token}`)
        .send({ businessName: 'A', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `cm-diff-a-${stamp}` }),
      t.request
        .post('/v1/onboarding/complete')
        .set('Idempotency-Key', key)
        .set('Authorization', `Bearer ${u.token}`)
        .send({ businessName: 'B', countryCode: 'JO', baseCurrency: 'JOD', storeSlug: `cm-diff-b-${stamp}` }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(loser.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const n = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM businesses WHERE store_slug LIKE $1`, [`cm-diff-%-${stamp}`]);
    expect(Number(must(n.rows[0]).n)).toBe(1);
  });
});
