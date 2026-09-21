import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, ownerPool, resetData, uniqueEmail, type TestApp, grantFeature } from '../helpers/test-app';

/**
 * §21–23 — Tenant membership foundation. TENANT ≠ BUSINESS. Onboarding
 * creates Tenant + Tenant Owner Membership + Business + Business Owner
 * Membership (+ branch/warehouse/config/entitlement/outbox) atomically.
 */
function must<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null) throw new Error(`fixture missing: ${what}`);
  return v;
}

describe('tenant memberships', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
    await resetData();
  });

  it('onboarding creates the tenant_owner membership in the same transaction', async () => {
    const reg = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'U', preferredLocale: 'ar',
    });
    const token = reg.body.accessToken as string;
    const on = await t.request.post('/v1/onboarding/complete').set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random()*1e9)}`).set('Authorization', `Bearer ${token}`).send({
      businessName: 'B', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `tm-${Date.now()}`,
    });
    expect(on.status).toBe(201);
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
    const { rows } = await ownerPool().query<{ role_key: string }>(
      'SELECT role_key FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2',
      [on.body.tenantId as string, me.body.userId as string],
    );
    expect(rows.map((r) => r.role_key)).toEqual(['tenant_owner']);
  });

  it('a global user can belong to MULTIPLE tenants and MULTIPLE businesses', async () => {
    // DB-level proof of the model: one user, two tenants, three businesses.
    const { rows: u } = await ownerPool().query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'U') RETURNING id`,
      [uniqueEmail()],
    );
    const user = u[0];
    if (!user) throw new Error('fixture user insert failed');
    const { rows: tenants } = await ownerPool().query<{ id: string }>(
      `INSERT INTO tenants DEFAULT VALUES RETURNING id`,
    );
    const t1 = tenants[0];
    if (!t1) throw new Error('fixture tenant insert failed');
    const { rows: t2rows } = await ownerPool().query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`);
    const t2 = t2rows[0];
    if (!t2) throw new Error('fixture tenant insert failed');
    await ownerPool().query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role_key) VALUES
       ($1, $3, 'tenant_owner'), ($2, $3, 'tenant_member')`,
      [t1.id, t2.id, user.id],
    );
    await ownerPool().query(
      `INSERT INTO businesses (tenant_id, name, store_slug, base_currency, country_code, timezone) VALUES
       ($1, 'A1', $3, 'ILS', 'PS', 'Asia/Hebron'), ($1, 'A2', $4, 'ILS', 'PS', 'Asia/Hebron'), ($2, 'B1', $5, 'ILS', 'PS', 'Asia/Hebron')`,
      [t1.id, t2.id, `tma1-${Date.now()}`, `tma2-${Date.now()}`, `tmb1-${Date.now()}`],
    );
    const { rows: tm } = await ownerPool().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM tenant_memberships WHERE user_id = $1', [user.id],
    );
    expect(tm[0]?.n).toBe(2);
    const { rows: biz } = await ownerPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM businesses WHERE tenant_id IN (
         SELECT tenant_id FROM tenant_memberships WHERE user_id = $1)`, [user.id],
    );
    expect(biz[0]?.n).toBe(3);
  });

  // WAVE 3 — DB-enforced invariant: no business membership without tenant
  // membership in the OWNING tenant; no cross-tenant business linkage.
  it('DB rejects a business membership whose user is not a tenant member', async () => {
    const { rows: u } = await ownerPool().query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'U') RETURNING id`,
      [uniqueEmail()],
    );
    const { rows: tn } = await ownerPool().query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`);
    const { rows: b } = await ownerPool().query<{ id: string }>(
      `INSERT INTO businesses (tenant_id, name, store_slug, base_currency, country_code, timezone)
       VALUES ($1, 'X', $2, 'ILS', 'PS', 'Asia/Hebron') RETURNING id`,
      [must(tn[0],'tenant').id, `tmx-${Date.now()}`],
    );
    await expect(
      ownerPool().query(
        `INSERT INTO memberships (tenant_id, business_id, user_id, status, joined_at)
         VALUES ($1, $2, $3, 'active', now())`,
        [must(tn[0],'tenant').id, must(b[0],'business').id, must(u[0],'user').id],
      ),
    ).rejects.toThrow(/tenant_member_fk|foreign key/i);
  });

  it('DB rejects a membership linking tenant A to a business of tenant B', async () => {
    const { rows: u } = await ownerPool().query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'U') RETURNING id`,
      [uniqueEmail()],
    );
    const { rows: tA } = await ownerPool().query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`);
    const { rows: tB } = await ownerPool().query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`);
    await ownerPool().query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role_key) VALUES ($1, $2, 'tenant_member'), ($3, $2, 'tenant_member')`,
      [must(tA[0],'tenantA').id, must(u[0],'user').id, must(tB[0],'tenantB').id],
    );
    const { rows: b } = await ownerPool().query<{ id: string }>(
      `INSERT INTO businesses (tenant_id, name, store_slug, base_currency, country_code, timezone)
       VALUES ($1, 'X', $2, 'ILS', 'PS', 'Asia/Hebron') RETURNING id`,
      [must(tB[0],'tenantB').id, `tmy-${Date.now()}`],
    );
    await expect(
      ownerPool().query(
        `INSERT INTO memberships (tenant_id, business_id, user_id, status, joined_at)
         VALUES ($1, $2, $3, 'active', now())`,
        [must(tA[0],'tenantA').id, must(b[0],'business').id, must(u[0],'user').id], // tenant A id with tenant B's business
      ),
    ).rejects.toThrow(/tenant_business_fk|foreign key/i);
  });

  it('merchant app role CANNOT mint tenant_owner via raw SQL (trigger-enforced)', async () => {
    const { Client } = await import('pg');
    const { appDbUrl } = await import('../helpers/test-app');
    const { rows: tn } = await ownerPool().query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`);
    const { rows: u } = await ownerPool().query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'U') RETURNING id`,
      [uniqueEmail()],
    );
    const c = new Client({ connectionString: appDbUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [must(tn[0],'tenant').id]);
      await expect(
        c.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role_key) VALUES ($1, $2, 'tenant_owner')`, [
          must(tn[0],'tenant').id, must(u[0],'user').id,
        ]),
      ).rejects.toThrow(/platform-managed/i);
      await c.query('ROLLBACK');
      // ...but tenant_member IS allowed for the scoped app role (join flows).
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [must(tn[0],'tenant').id]);
      await c.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role_key) VALUES ($1, $2, 'tenant_member')`, [
        must(tn[0],'tenant').id, must(u[0],'user').id,
      ]);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });

  it('invitation accept creates tenant_member for a user from ANOTHER tenant', async () => {
    const inviteTokens: string[] = [];
    const t2 = await createTestApp({
      delivery: {
        kind: 'capture',
        sendPasswordReset: () => Promise.resolve(),
        sendInvitation: (_e: string, tok: string) => { inviteTokens.push(tok); return Promise.resolve(); },
      },
    });
    // A: owner of tenant A business
    const regA = await t2.request.post('/v1/auth/register').send({
      email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'A', preferredLocale: 'ar',
    });
    const tokenA = regA.body.accessToken as string;
    const onA = await t2.request.post('/v1/onboarding/complete').set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random()*1e9)}`).set('Authorization', `Bearer ${tokenA}`).send({
      businessName: 'A', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `tma-${Date.now()}`,
    });
    const bizA = onA.body.businessId as string;
    const userA = (await t2.request.get('/v1/auth/me').set('Authorization', `Bearer ${tokenA}`)).body.userId as string;
    await grantFeature(bizA, userA, 'CUSTOM_ROLES');
    const tenantA = onA.body.tenantId as string;
    // B: owner of their OWN separate tenant
    const regB = await t2.request.post('/v1/auth/register').send({
      email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'B', preferredLocale: 'ar',
    });
    const tokenB = regB.body.accessToken as string;
    const emailB = (await t2.request.get('/v1/auth/me').set('Authorization', `Bearer ${tokenB}`)).body.email as string;
    const userB = (await t2.request.get('/v1/auth/me').set('Authorization', `Bearer ${tokenB}`)).body.userId as string;
    await t2.request.post('/v1/onboarding/complete').set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random()*1e9)}`).set('Authorization', `Bearer ${tokenB}`).send({
      businessName: 'B', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `tmb-${Date.now()}`,
    });
    // Invite B into A's business (custom role: system roles are not invitable)
    const role = await t2.request.post('/v1/businesses/current/roles').set({
      Authorization: `Bearer ${tokenA}`, 'X-Business-Id': bizA,
    }).send({ key: 'guest', name: 'Guest', permissions: ['catalog.view'] });
    expect(role.status).toBe(201);
    const inv = await t2.request.post('/v1/businesses/current/invitations').set({
      Authorization: `Bearer ${tokenA}`, 'X-Business-Id': bizA,
    }).send({ email: emailB, roleKey: 'guest' });
    expect(inv.status).toBe(201);
    await t2.worker.drain(); // request path enqueues only; the worker delivers
    const acc = await t2.request.post('/v1/invitations/accept').set('Authorization', `Bearer ${tokenB}`).send({
      token: inviteTokens[inviteTokens.length - 1],
    });
    expect(acc.status).toBe(200);
    // B is now tenant_member of tenant A — without losing their own tenant.
    const { rows } = await ownerPool().query<{ role_key: string }>(
      'SELECT role_key FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2',
      [tenantA, userB],
    );
    expect(rows.map((r) => r.role_key)).toEqual(['tenant_member']);
    const mine = await t2.request.get('/v1/me/businesses').set('Authorization', `Bearer ${tokenB}`);
    expect((mine.body.items as unknown[]).length).toBe(2); // own business + A's business
    await t2.close();
  });
});
