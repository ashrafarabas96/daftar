import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, ownerPool, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';

/**
 * §16–20 — Refresh token lineage: single-use rotation, concurrent refresh
 * race (exactly one succeeds), reuse detection with COMMIT-BEFORE-THROW
 * revocation, family kill, lineage state auditability.
 */
describe('refresh token lineage & reuse security', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
    await resetData();
  });

  async function loginUser(): Promise<{ refreshToken: string; accessToken: string; userId: string }> {
    const email = uniqueEmail();
    const reg = await t.request.post('/v1/auth/register').send({
      email, password: 'Str0ng!Passw0rd', displayName: 'U', preferredLocale: 'ar',
    });
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${reg.body.accessToken as string}`);
    return {
      refreshToken: reg.body.refreshToken as string,
      accessToken: reg.body.accessToken as string,
      userId: me.body.userId as string,
    };
  }

  it('rotation: old token is single-use; lineage records issued→consumed→issued chain', async () => {
    const u = await loginUser();
    const r1 = await t.request.post('/v1/auth/refresh').send({ refreshToken: u.refreshToken });
    expect(r1.status).toBe(201);
    // old token replayed → reuse detected
    const replay = await t.request.post('/v1/auth/refresh').send({ refreshToken: u.refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('TOKEN_REUSE_DETECTED');

    const { rows } = await ownerPool().query<{ state: string }>(
      `SELECT state FROM session_refresh_tokens ORDER BY created_at`,
    );
    const states = rows.map((r) => r.state);
    expect(states.filter((s) => s === 'consumed').length).toBe(1);
    // successor was revoked by the reuse-triggered family kill
    expect(states.filter((s) => s === 'revoked').length).toBeGreaterThanOrEqual(1);
  });

  it('reuse revocation COMMITS before the throw: the newest token is dead too', async () => {
    const u = await loginUser();
    const r1 = await t.request.post('/v1/auth/refresh').send({ refreshToken: u.refreshToken });
    expect(r1.status).toBe(201);
    const newest = r1.body.refreshToken as string;
    // attacker replays the stolen old token
    await t.request.post('/v1/auth/refresh').send({ refreshToken: u.refreshToken });
    // even the legitimate newest token is now revoked (family kill committed)
    const after = await t.request.post('/v1/auth/refresh').send({ refreshToken: newest });
    expect(after.status).toBe(401);
    const { rows } = await ownerPool().query<{ status: string }>(`SELECT status FROM sessions`);
    expect(rows.every((r) => r.status === 'revoked')).toBe(true);
  });

  it('CONCURRENT refresh of the same token: exactly one succeeds, other is reuse', async () => {
    const u = await loginUser();
    const [a, b] = await Promise.all([
      t.request.post('/v1/auth/refresh').send({ refreshToken: u.refreshToken }),
      t.request.post('/v1/auth/refresh').send({ refreshToken: u.refreshToken }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 401]);
    const loser = a.status === 401 ? a : b;
    expect(loser.body.error.code).toBe('TOKEN_REUSE_DETECTED');
    // family revoked — winner's new token is dead as well (secure failure)
    const winner = a.status === 201 ? a : b;
    const followUp = await t.request.post('/v1/auth/refresh').send({ refreshToken: winner.body.refreshToken as string });
    expect(followUp.status).toBe(401);
  });

  it('logout kills the lineage: refresh after logout is 401 and stays dead', async () => {
    const u = await loginUser();
    const out = await t.request.post('/v1/auth/logout').set('Authorization', `Bearer ${u.accessToken}`);
    expect(out.status).toBe(201);
    const r = await t.request.post('/v1/auth/refresh').send({ refreshToken: u.refreshToken });
    expect(r.status).toBe(401);
    const { rows } = await ownerPool().query<{ state: string }>(
      `SELECT state FROM session_refresh_tokens WHERE state = 'issued'`,
    );
    expect(rows.length).toBe(0);
  });
});
