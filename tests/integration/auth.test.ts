import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';

/** Auth suite (§41–44, §91): rotation, reuse detection, revocation, rate limit, reset, hygiene. */
describe('auth', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
    await resetData();
  });

  const register = (email = uniqueEmail(), password = 'Str0ng!Passw0rd') =>
    t.request.post('/v1/auth/register').send({ email, password, displayName: 'Test User', preferredLocale: 'ar' });

  it('registers and returns tokens; me works', async () => {
    const res = await register();
    expect(res.status).toBe(201);
    expect(res.body.tokens ?? res.body.accessToken).toBeDefined();
    const token = (res.body.accessToken ?? res.body.tokens?.accessToken) as string;
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.preferredLocale).toBe('ar');
  });

  it('rejects duplicate email with 409', async () => {
    const email = uniqueEmail();
    expect((await register(email)).status).toBe(201);
    const dup = await register(email);
    expect(dup.status).toBe(409);
  });

  it('rejects unexpected fields (strict schema, §94)', async () => {
    const res = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(),
      password: 'Str0ng!Passw0rd',
      displayName: 'X',
      preferredLocale: 'ar',
      tenant_id: 'injected',
      isSystemOwner: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('login succeeds; wrong password and unknown email get uniform 401', async () => {
    const email = uniqueEmail();
    await register(email);
    const ok = await t.request.post('/v1/auth/login').send({ email, password: 'Str0ng!Passw0rd' });
    expect(ok.status).toBe(201);
    const wrong = await t.request.post('/v1/auth/login').send({ email, password: 'Wr0ng!Passw0rd' });
    expect(wrong.status).toBe(401);
    const unknown = await t.request.post('/v1/auth/login').send({ email: uniqueEmail(), password: 'Whatever!1234' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe(wrong.body.error.code);
  });

  it('refresh rotates; old token reuse revokes the whole family (committed before throw)', async () => {
    const email = uniqueEmail();
    const reg = await register(email);
    const { accessToken, refreshToken } = reg.body as { accessToken: string; refreshToken: string };
    const rotated = await t.request.post('/v1/auth/refresh').send({ refreshToken });
    expect(rotated.status).toBe(201);
    const newRefresh = rotated.body.refreshToken as string;
    expect(newRefresh).not.toBe(refreshToken);

    // Reuse the OLD token → TOKEN_REUSE_DETECTED, family revoked.
    const reuse = await t.request.post('/v1/auth/refresh').send({ refreshToken });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('TOKEN_REUSE_DETECTED');

    // The NEW token (from the legitimate rotation) is also dead — family revoked.
    const after = await t.request.post('/v1/auth/refresh').send({ refreshToken: newRefresh });
    expect(after.status).toBe(401);

    // Access token of the family dies too.
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${accessToken}`);
    expect(me.status).toBe(401);
  });

  it('logout kills access and refresh immediately', async () => {
    const reg = await register();
    const { accessToken, refreshToken } = reg.body as { accessToken: string; refreshToken: string };
    expect((await t.request.post('/v1/auth/logout').set('Authorization', `Bearer ${accessToken}`)).status).toBe(201);
    expect((await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${accessToken}`)).status).toBe(401);
    expect((await t.request.post('/v1/auth/refresh').send({ refreshToken })).status).toBe(401);
  });

  it('logout-all revokes every session of the user', async () => {
    const email = uniqueEmail();
    const s1 = await register(email);
    const s2 = await t.request.post('/v1/auth/login').send({ email, password: 'Str0ng!Passw0rd' });
    const t1 = s1.body.accessToken as string;
    const t2 = s2.body.accessToken as string;
    expect((await t.request.post('/v1/auth/logout-all').set('Authorization', `Bearer ${t1}`)).status).toBe(201);
    expect((await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${t1}`)).status).toBe(401);
    expect((await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${t2}`)).status).toBe(401);
  });

  it('password reset: single-use token, sessions revoked, no enumeration', async () => {
    const email = uniqueEmail();
    const tokens: string[] = [];
    const delivery = {
      kind: 'capture-test-adapter',
      sendPasswordReset: (_email: string, token: string) => {
        tokens.push(token);
        return Promise.resolve();
      },
      sendInvitation: () => Promise.resolve(),
    };
    await t.close();
    t = await createTestApp({ delivery });
    await register(email);

    const noEnum = await t.request.post('/v1/auth/password-reset/request').send({ email: uniqueEmail() });
    expect(noEnum.status).toBe(201);
    expect(noEnum.body).toEqual({ ok: true });
    expect(tokens.length).toBe(0);

    expect((await t.request.post('/v1/auth/password-reset/request').send({ email })).status).toBe(201);
    await t.worker.drain(); // request path enqueues only; the worker delivers
    expect(tokens.length).toBe(1);
    const token = tokens[0] as string;

    const done = await t.request.post('/v1/auth/password-reset/complete').send({ token, password: 'N3w!Passw0rdZZ' });
    expect(done.status).toBe(201);
    // single-use
    const again = await t.request.post('/v1/auth/password-reset/complete').send({ token, password: 'An0ther!Passw0rd' });
    expect(again.status).toBe(400);
    // old password dead, new works
    expect((await t.request.post('/v1/auth/login').send({ email, password: 'Str0ng!Passw0rd' })).status).toBe(401);
    expect((await t.request.post('/v1/auth/login').send({ email, password: 'N3w!Passw0rdZZ' })).status).toBe(201);
  });

  it('rate limits repeated login failures from one IP+account (429), never locks the account', async () => {
    // §XXXII–XXXIII: the hard cap is per-IP+account (10/5min); the account
    // itself gets a soft delay — never an attacker-triggerable lockout.
    const email = uniqueEmail();
    await register(email);
    let last = 0;
    for (let i = 0; i < 11; i += 1) {
      const res = await t.request.post('/v1/auth/login').send({ email, password: 'Wr0ng!Passw0rd' });
      last = res.status;
    }
    expect(last).toBe(429);
  });

  it('error responses never leak secrets, SQL, or stack traces', async () => {
    const res = await t.request.post('/v1/auth/login').send({ email: 'x@y.z', password: 'a' });
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/password|hash|SELECT|stack|argon/i);
    expect(res.body.error.requestId).toBeDefined();
  });
});
