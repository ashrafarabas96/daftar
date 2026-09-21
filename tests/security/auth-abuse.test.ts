import { describe, it, expect } from 'vitest';
import { clientIp } from '../../apps/api/src/common/client-ip';
import { createTestApp, resetData } from '../helpers/test-app';

/**
 * §XXXII–XXXVIII: layered auth abuse defense.
 * HARD layers (attacker-throttling): per-IP, per-IP+account, global circuit.
 * SOFT layer (account-wide): progressive response delay — an attacker spraying
 * a victim's email from many IPs can NEVER hard-lock the victim (§XXXII).
 */
describe('auth abuse rate limiting (layered)', () => {
  // Fresh app per test: the rate limiter is per-process state.
  it('per-IP layer: >30 login attempts from one IP (distinct emails) → 429', async () => {
    const t = await createTestApp();
    try {
      await resetData();
      for (let i = 0; i < 30; i++) {
        const res = await t.request
          .post('/v1/auth/login')
          .send({ email: `spray-${i}@example.com`, password: 'wrong-password-1' });
        expect(res.status).toBe(401);
      }
      const blocked = await t.request
        .post('/v1/auth/login')
        .send({ email: 'spray-31@example.com', password: 'wrong-password-1' });
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('RATE_LIMITED');
    } finally {
      await t.close();
    }
  });

  it('per-IP+account layer: >10 attempts on one email from one IP → 429, other email still allowed', async () => {
    const t = await createTestApp();
    try {
      await resetData();
      for (let i = 0; i < 10; i++) {
        const res = await t.request
          .post('/v1/auth/login')
          .send({ email: 'victim@example.com', password: 'wrong-password-1' });
        expect(res.status).toBe(401);
      }
      const blocked = await t.request
        .post('/v1/auth/login')
        .send({ email: 'victim@example.com', password: 'wrong-password-1' });
      expect(blocked.status).toBe(429);
      // A different email from the same IP is unaffected by the IP+account layer.
      const other = await t.request
        .post('/v1/auth/login')
        .send({ email: 'bystander@example.com', password: 'wrong-password-1' });
      expect(other.status).toBe(401);
    } finally {
      await t.close();
    }
  });

  it('account-wide signal is a SOFT DELAY, never a hard lockout (§XXXII–XXXIII)', async () => {
    const t = await createTestApp();
    try {
      await resetData();
      // Register a real user so a CORRECT password can succeed after failures.
      await t.request
        .post('/v1/auth/register')
        .send({ email: 'soft@example.com', password: 'correct-horse-1', displayName: 'Soft', preferredLocale: 'en' });
      // Accumulate failures past the soft-delay threshold (5) from "many IPs"
      // — simulate a distributed spray by... the IP layer is per socket here,
      // so failures accumulate on the account signal regardless.
      for (let i = 0; i < 6; i++) {
        const res = await t.request
          .post('/v1/auth/login')
          .send({ email: 'soft@example.com', password: 'wrong-password-1' });
        expect(res.status).toBe(401); // NEVER 429 — account is never locked
      }
      // The next failure is DELAYED (soft slowdown), still 401.
      const started = Date.now();
      const delayed = await t.request
        .post('/v1/auth/login')
        .send({ email: 'soft@example.com', password: 'wrong-password-1' });
      expect(delayed.status).toBe(401);
      expect(Date.now() - started).toBeGreaterThanOrEqual(400); // ~500ms step
      // Successful authentication still works (no lockout) and resets risk.
      const ok = await t.request
        .post('/v1/auth/login')
        .send({ email: 'soft@example.com', password: 'correct-horse-1' });
      expect(ok.status).toBe(201);
      // After success the delay is gone: a fresh wrong attempt is fast again.
      const t2 = Date.now();
      await t.request.post('/v1/auth/login').send({ email: 'soft@example.com', password: 'wrong-password-1' });
      expect(Date.now() - t2).toBeLessThan(400);
    } finally {
      await t.close();
    }
  });

  it('password reset: per-email layer caps at 3 requests/hour', async () => {
    const t = await createTestApp();
    try {
      await resetData();
      for (let i = 0; i < 3; i++) {
        const res = await t.request.post('/v1/auth/password-reset/request').send({ email: 'reset@example.com' });
        expect(res.status).toBe(201);
      }
      const blocked = await t.request.post('/v1/auth/password-reset/request').send({ email: 'reset@example.com' });
      expect(blocked.status).toBe(429);
    } finally {
      await t.close();
    }
  });

  it('registration: per-IP cap stops scripted account farms (§XXXV)', async () => {
    const t = await createTestApp();
    try {
      await resetData();
      for (let i = 0; i < 10; i++) {
        const res = await t.request
          .post('/v1/auth/register')
          .send({ email: `farm-${i}@example.com`, password: 'farm-password-1', displayName: 'Farm', preferredLocale: 'en' });
        expect(res.status).toBe(201);
      }
      const blocked = await t.request
        .post('/v1/auth/register')
        .send({ email: 'farm-11@example.com', password: 'farm-password-1', displayName: 'Farm', preferredLocale: 'en' });
      expect(blocked.status).toBe(429);
    } finally {
      await t.close();
    }
  });

  it('refresh: per-IP cap (§XXXVII)', async () => {
    const t = await createTestApp();
    try {
      await resetData();
      let last = 0;
      for (let i = 0; i < 61; i++) {
        const res = await t.request.post('/v1/auth/refresh').send({ refreshToken: `bogus-token-${i}-abcdefghijklmnop` });
        last = res.status;
      }
      expect(last).toBe(429);
    } finally {
      await t.close();
    }
  });

  it('reset-complete: per-IP cap against token guessing (§XXXVII)', async () => {
    const t = await createTestApp();
    try {
      await resetData();
      let last = 0;
      for (let i = 0; i < 21; i++) {
        const res = await t.request
          .post('/v1/auth/password-reset/complete')
          .send({ token: `guessed-token-${i}-abcdefghijklmnop`, password: 'new-password-123' });
        last = res.status;
      }
      expect(last).toBe(429);
    } finally {
      await t.close();
    }
  });
});

/**
 * §XXXIX–XL: trusted-proxy-aware client IP resolution.
 * Deterministic identity for: direct forged XFF, trusted LB, multi-proxy
 * chain, IPv4, IPv6, malformed XFF.
 */
describe('clientIp trusted proxy handling (§XL matrix)', () => {
  const reqWith = (xff: string | string[] | undefined, remote: string | undefined) =>
    ({
      headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
      socket: { remoteAddress: remote },
    }) as unknown as Parameters<typeof clientIp>[0];

  const LB = '10.0.0.1';
  const cfg = { TRUST_PROXY: 'false' as const, TRUSTED_PROXIES: '10.0.0.1,10.0.0.2,2001:db8::1' };

  it('TRUST_PROXY=false ignores X-Forwarded-For (no spoofing)', () => {
    const ip = clientIp(reqWith('203.0.113.9', '198.51.100.7'), { TRUST_PROXY: 'false', TRUSTED_PROXIES: '' });
    expect(ip).toBe('198.51.100.7');
  });

  it('TRUST_PROXY=true uses the first X-Forwarded-For entry (legacy mode)', () => {
    const ip = clientIp(reqWith('203.0.113.9, 10.0.0.1', '198.51.100.7'), { TRUST_PROXY: 'true', TRUSTED_PROXIES: '' });
    expect(ip).toBe('203.0.113.9');
  });

  it('direct request with FORGED XFF: untrusted socket peer → XFF ignored entirely', () => {
    const ip = clientIp(reqWith('203.0.113.9', '198.51.100.7'), cfg);
    expect(ip).toBe('198.51.100.7'); // attacker cannot spoof
  });

  it('trusted LB request: right-to-left walk returns the real client', () => {
    const ip = clientIp(reqWith('203.0.113.9', LB), cfg);
    expect(ip).toBe('203.0.113.9');
  });

  it('multiple proxy chain: skips trusted hops, first untrusted from the right wins', () => {
    const ip = clientIp(reqWith('203.0.113.9, 10.0.0.2', LB), cfg);
    expect(ip).toBe('203.0.113.9'); // 10.0.0.2 trusted → skipped
  });

  it('multi-chain with untrusted middle hop: that hop is the identity', () => {
    const ip = clientIp(reqWith('203.0.113.9, 198.51.100.50, 10.0.0.2', LB), cfg);
    expect(ip).toBe('198.51.100.50');
  });

  it('IPv6: exact-match trusted proxy skipped, IPv6 client resolved', () => {
    const ip = clientIp(reqWith('2001:db8::99', '2001:db8::1'), cfg);
    expect(ip).toBe('2001:db8::99');
  });

  it('IPv4 CIDR range trusts any address in the block', () => {
    const cidrCfg = { TRUST_PROXY: 'false' as const, TRUSTED_PROXIES: '10.0.0.0/8' };
    const ip = clientIp(reqWith('203.0.113.9, 10.1.2.3', '10.9.9.9'), cidrCfg);
    expect(ip).toBe('203.0.113.9');
  });

  it('IPv4-mapped IPv6 socket peer ( Express ::ffff: ) matches the IPv4 trusted list', () => {
    const ip = clientIp(reqWith('203.0.113.9', '::ffff:10.0.0.1'), cfg);
    expect(ip).toBe('203.0.113.9');
  });

  it('malformed XFF entries are dropped from the chain', () => {
    const junk = 'x'.repeat(60); // > 45 chars — not an IP
    const ip = clientIp(reqWith(`${junk}, 203.0.113.9`, LB), cfg);
    expect(ip).toBe('203.0.113.9');
  });

  it('XFF as an array header is normalized', () => {
    const ip = clientIp(reqWith(['203.0.113.9', '10.0.0.2'], LB), cfg);
    expect(ip).toBe('203.0.113.9');
  });

  it('entire chain trusted → leftmost entry; empty XFF → socket address', () => {
    expect(clientIp(reqWith('10.0.0.2', LB), cfg)).toBe('10.0.0.2');
    expect(clientIp(reqWith(undefined, LB), cfg)).toBe(LB);
  });

  it('no socket address → unknown (never crashes the auth path)', () => {
    const ip = clientIp(reqWith(undefined, undefined), { TRUST_PROXY: 'false', TRUSTED_PROXIES: '' });
    expect(ip).toBe('unknown');
  });
});
