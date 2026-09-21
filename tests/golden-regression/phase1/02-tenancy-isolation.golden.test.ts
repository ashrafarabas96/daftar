import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, ownerPool, resetData, uniqueEmail, type TestApp } from '../../helpers/test-app';

/**
 * GOLDEN REGRESSION — Tenancy & Isolation (P1-GOLD-09 … P1-GOLD-16).
 */
describe('golden: tenancy & isolation', () => {
  let t: TestApp;
  let inviteTokens: string[];
  beforeEach(async () => {
    inviteTokens = [];
    t = await createTestApp({
      delivery: {
        kind: 'capture-test-adapter',
        sendPasswordReset: () => Promise.resolve(),
        sendInvitation: (_email: string, token: string) => {
          inviteTokens.push(token);
          return Promise.resolve();
        },
      },
    });
    await resetData();
  });
  afterEach(async () => {
    await t?.close();
  });

  let seq = 0;
  async function onboardedBusiness(): Promise<{ token: string; businessId: string; email: string }> {
    const email = uniqueEmail();
    const reg = await t.request.post('/v1/auth/register').send({
      email, password: 'Str0ng!Passw0rd', displayName: 'Owner', preferredLocale: 'ar',
    });
    const token = reg.body.accessToken as string;
    const on = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `gold-${Date.now()}-${++seq}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        businessName: 'Golden Co', countryCode: 'JO', baseCurrency: 'JOD',
        storeSlug: `gold-${Date.now()}-${seq}`,
      });
    expect(on.status).toBe(201);
    return { token, businessId: on.body.businessId as string, email };
  }

  it('P1-GOLD-09 onboarding is ONE atomic operation (tenant+business+roles+branch+warehouse+outbox+audit)', async () => {
    const { businessId } = await onboardedBusiness();
    const pool = ownerPool();
    const roles = await pool.query('SELECT count(*)::int n FROM business_roles WHERE business_id=$1', [businessId]);
    const branch = await pool.query('SELECT count(*)::int n FROM branches WHERE business_id=$1 AND is_default', [businessId]);
    const wh = await pool.query('SELECT count(*)::int n FROM warehouses WHERE business_id=$1 AND is_default', [businessId]);
    const outbox = await pool.query(`SELECT count(*)::int n FROM outbox_events WHERE business_id=$1 AND type='business.created'`, [businessId]);
    const audit = await pool.query(`SELECT count(*)::int n FROM audit_events WHERE entity='business' AND entity_id=$1`, [businessId]);
    expect(roles.rows[0]?.n).toBeGreaterThanOrEqual(3);
    expect(branch.rows[0]?.n).toBe(1);
    expect(wh.rows[0]?.n).toBe(1);
    expect(outbox.rows[0]?.n).toBe(1);
    expect(audit.rows[0]?.n).toBe(1);
  });

  it('P1-GOLD-10 double submit (same Idempotency-Key) creates exactly ONE business', async () => {
    const email = uniqueEmail();
    const reg = await t.request.post('/v1/auth/register').send({
      email, password: 'Str0ng!Passw0rd', displayName: 'Owner', preferredLocale: 'ar',
    });
    const token = reg.body.accessToken as string;
    const payload = { businessName: 'مرة واحدة', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `once-${Date.now()}` };
    const KEY = `gold-idem-${Date.now()}`;
    const [r1, r2] = await Promise.all([
      t.request.post('/v1/onboarding/complete').set('Idempotency-Key', KEY).set('Authorization', `Bearer ${token}`).send(payload),
      t.request.post('/v1/onboarding/complete').set('Idempotency-Key', KEY).set('Authorization', `Bearer ${token}`).send(payload),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 201]);
    const n = await ownerPool().query('SELECT count(*)::int n FROM businesses');
    expect(n.rows[0]?.n).toBe(1);
  });

  it('P1-GOLD-11 cross-tenant product read is denied', async () => {
    const a = await onboardedBusiness();
    const b = await onboardedBusiness();
    const created = await t.request
      .post('/v1/catalog/products')
      .set({ Authorization: `Bearer ${a.token}`, 'X-Business-Id': a.businessId })
      .send({ translations: { ar: 'سرّي' }, basePriceMinor: '100', priceCurrency: 'JOD' });
    expect(created.status).toBe(201);
    const stolen = await t.request
      .get(`/v1/catalog/products/${created.body.id}`)
      .set({ Authorization: `Bearer ${b.token}`, 'X-Business-Id': b.businessId });
    expect([403, 404]).toContain(stolen.status);
  });

  it('P1-GOLD-12 cross-tenant member list is denied', async () => {
    const a = await onboardedBusiness();
    const b = await onboardedBusiness();
    const res = await t.request
      .get('/v1/businesses/current/members')
      .set({ Authorization: `Bearer ${b.token}`, 'X-Business-Id': a.businessId });
    expect(res.status).toBe(403);
  });

  it('P1-GOLD-13 a business id in the header never overrides the caller tenant (BOLA guard)', async () => {
    const a = await onboardedBusiness();
    const b = await onboardedBusiness();
    const res = await t.request
      .get('/v1/businesses/current')
      .set({ Authorization: `Bearer ${b.token}`, 'X-Business-Id': a.businessId });
    expect(res.status).toBe(403);
  });

  it('P1-GOLD-14 invitation accept-register → membership with the invited role', async () => {
    const a = await onboardedBusiness();
    const email = uniqueEmail();
    const invite = await t.request
      .post('/v1/businesses/current/invitations')
      .set({ Authorization: `Bearer ${a.token}`, 'X-Business-Id': a.businessId })
      .send({ email, roleKey: 'cashier' });
    expect(invite.status).toBe(201);
    await t.worker.drain(); // request path enqueues only; the worker delivers
    const token = inviteTokens[0] ?? '';
    expect(token).toBeTruthy();
    const accept = await t.request.post('/v1/invitations/accept-register').send({
      token, email, password: 'Str0ng!Passw0rd', displayName: 'Staff',
    });
    expect(accept.status).toBe(200);
    const membership = await ownerPool().query(
      `SELECT m.status FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.business_id = $1 AND u.email = $2`,
      [a.businessId, email],
    );
    expect(membership.rows[0]?.status).toBe('active');
  });

  it('P1-GOLD-15 suspended member immediately loses access', async () => {
    const a = await onboardedBusiness();
    const pool = ownerPool();
    const email = uniqueEmail();
    const reg = await t.request.post('/v1/auth/register').send({
      email, password: 'Str0ng!Passw0rd', displayName: 'Staff', preferredLocale: 'ar',
    });
    const user = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
    const userId = user.rows[0]?.id as string;
    const add = await t.request
      .post('/v1/businesses/current/members')
      .set({ Authorization: `Bearer ${a.token}`, 'X-Business-Id': a.businessId })
      .send({ email, roleKey: 'manager' });
    expect([200, 201]).toContain(add.status);
    const before = await t.request
      .get('/v1/businesses/current')
      .set({ Authorization: `Bearer ${reg.body.accessToken}`, 'X-Business-Id': a.businessId });
    expect(before.status).toBe(200);
    const suspend = await t.request
      .post(`/v1/businesses/current/members/${userId}/suspend`)
      .set({ Authorization: `Bearer ${a.token}`, 'X-Business-Id': a.businessId })
      .send({});
    expect([200, 201, 204]).toContain(suspend.status);
    const after = await t.request
      .get('/v1/businesses/current')
      .set({ Authorization: `Bearer ${reg.body.accessToken}`, 'X-Business-Id': a.businessId });
    expect(after.status).toBe(403);
  });

  it('P1-GOLD-16 every business mutation writes an audit event with actor + request id', async () => {
    const a = await onboardedBusiness();
    const res = await t.request
      .post('/v1/catalog/products')
      .set({ Authorization: `Bearer ${a.token}`, 'X-Business-Id': a.businessId })
      .send({ translations: { ar: 'منتج' }, basePriceMinor: '500', priceCurrency: 'JOD' });
    expect(res.status).toBe(201);
    const audit = await ownerPool().query(`SELECT * FROM audit_events WHERE entity='product' AND entity_id=$1`, [res.body.id]);
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0]?.actor_user_id).toBeTruthy();
    expect(audit.rows[0]?.request_id).toBeTruthy();
  });
});
