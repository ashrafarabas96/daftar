import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, resetData, uniqueEmail, type TestApp } from '../../helpers/test-app';

/**
 * GOLDEN REGRESSION — Identity & Access (P1-GOLD-01 … P1-GOLD-08).
 * These flows are the Phase 1 contract: if any of them breaks, the release is
 * broken. Each test names its golden flow id for the acceptance report.
 */
describe('golden: identity & access', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
    await resetData();
  });
  afterEach(async () => {
    await t?.close();
  });

  const password = 'Str0ng!Passw0rd';
  const register = (email: string) =>
    t.request.post('/v1/auth/register').send({ email, password, displayName: 'Owner', preferredLocale: 'ar' });

  it('P1-GOLD-01 register → access token + refresh token + session row', async () => {
    const res = await register(uniqueEmail());
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
  });

  it('P1-GOLD-02 login with correct credentials → 201 + tokens', async () => {
    const email = uniqueEmail();
    await register(email);
    const res = await t.request.post('/v1/auth/login').send({ email, password });
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeTruthy();
  });

  it('P1-GOLD-03 wrong password NEVER hard-locks the account (soft delay only)', async () => {
    const email = uniqueEmail();
    await register(email);
    for (let i = 0; i < 6; i++) {
      const bad = await t.request.post('/v1/auth/login').send({ email, password: 'Wrong!Passw0rd1' });
      expect(bad.status).toBe(401); // 401 with delay — never 429 on the account itself
    }
    const ok = await t.request.post('/v1/auth/login').send({ email, password });
    expect(ok.status).toBe(201);
  });

  it('P1-GOLD-04 refresh rotates; the previous refresh token is rejected', async () => {
    const email = uniqueEmail();
    const reg = await register(email);
    const r1 = await t.request.post('/v1/auth/refresh').send({ refreshToken: reg.body.refreshToken });
    expect(r1.status).toBe(201);
    const replay = await t.request.post('/v1/auth/refresh').send({ refreshToken: reg.body.refreshToken });
    expect(replay.status).toBe(401);
  });

  it('P1-GOLD-05 logout revokes the session immediately', async () => {
    const email = uniqueEmail();
    const reg = await register(email);
    const out = await t.request
      .post('/v1/auth/logout')
      .set('Authorization', `Bearer ${reg.body.accessToken}`)
      .send({ refreshToken: reg.body.refreshToken });
    expect([200, 201, 204]).toContain(out.status);
    const after = await t.request
      .get('/v1/me/businesses')
      .set('Authorization', `Bearer ${reg.body.accessToken}`);
    expect(after.status).toBe(401);
  });

  it('P1-GOLD-06 forged X-Forwarded-For on a direct connection is ignored', async () => {
    const email = uniqueEmail();
    await register(email);
    // Attacker spoofs a fresh IP per attempt — must NOT reset the real-IP budget.
    for (let i = 0; i < 12; i++) {
      await t.request
        .post('/v1/auth/login')
        .set('X-Forwarded-For', `10.99.0.${i}`)
        .send({ email, password: 'Wrong!Passw0rd1' });
    }
    const res = await t.request
      .post('/v1/auth/login')
      .set('X-Forwarded-For', '10.99.0.99')
      .send({ email, password: 'Wrong!Passw0rd1' });
    expect(res.status).toBe(429); // real socket peer exhausted its budget
  });

  it('P1-GOLD-07 register farm from one IP hits the per-IP cap', async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const res = await register(uniqueEmail());
      last = res.status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });

  it('P1-GOLD-08 password-reset request is generic (no account enumeration)', async () => {
    const known = uniqueEmail();
    await register(known);
    const a = await t.request.post('/v1/auth/password-reset/request').send({ email: known });
    const b = await t.request.post('/v1/auth/password-reset/request').send({ email: uniqueEmail() });
    expect(a.status).toBe(b.status);
    expect(JSON.stringify(a.body)).toBe(JSON.stringify(b.body));
  });
});
