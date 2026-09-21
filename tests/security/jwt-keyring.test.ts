import { describe, it, expect } from 'vitest';
import { TokenService, parseKeyRing } from '../../apps/api/src/modules/auth/tokens';

/**
 * §56–60: JWT key ring with kid. Sign with the active key; verify with
 * active+previous (rotation never logs users out); unknown kids rejected.
 */
const SECRET_A = 'keyring-secret-A-with-at-least-32-chars!!';
const SECRET_B = 'keyring-secret-B-with-at-least-32-chars!!';

function svc(keys: string, fallbackSecret = SECRET_A): TokenService {
  return new TokenService({ JWT_SECRET: fallbackSecret, JWT_KEYS: keys } as never);
}

describe('JWT key ring', () => {
  it('legacy single-secret config still signs/verifies (kid=legacy)', async () => {
    const s = new TokenService({ JWT_SECRET: SECRET_A } as never);
    const token = await s.signAccessToken('user-1', 'session-1');
    const payload = JSON.parse(Buffer.from(token.split('.')[1] as string, 'base64url').toString());
    expect(payload.sub).toBe('user-1');
    await expect(s.verifyAccessToken(token)).resolves.toEqual({ sub: 'user-1', sid: 'session-1' });
  });

  it('rotation: tokens signed by the previous active key still verify', async () => {
    const ring1 = JSON.stringify([{ kid: 'k1', secret: SECRET_A, status: 'active' }]);
    const old = svc(ring1);
    const token = await old.signAccessToken('user-2', 'session-2');

    const ring2 = JSON.stringify([
      { kid: 'k2', secret: SECRET_B, status: 'active' },
      { kid: 'k1', secret: SECRET_A, status: 'previous' },
    ]);
    const rotated = svc(ring2);
    await expect(rotated.verifyAccessToken(token)).resolves.toEqual({ sub: 'user-2', sid: 'session-2' });

    // New tokens carry the NEW kid.
    const fresh = await rotated.signAccessToken('user-3', 'session-3');
    const header = JSON.parse(Buffer.from(fresh.split('.')[0] as string, 'base64url').toString());
    expect(header.kid).toBe('k2');
  });

  it('unknown kid is rejected', async () => {
    const s = svc(JSON.stringify([{ kid: 'k1', secret: SECRET_A, status: 'active' }]));
    const token = await s.signAccessToken('user-4', 'session-4');
    // Verify with a DIFFERENT service whose ring does not contain k1.
    const other = svc(JSON.stringify([{ kid: 'k9', secret: SECRET_B, status: 'active' }]));
    await expect(other.verifyAccessToken(token)).rejects.toThrow('unknown signing key');
  });

  it('a token signed with a retired (absent) key is rejected', async () => {
    // k1 is ACTIVE and signs; then the ring rotates and k1 is fully retired.
    const old = svc(JSON.stringify([{ kid: 'k1', secret: SECRET_A, status: 'active' }]));
    const token = await old.signAccessToken('user-5', 'session-5');
    const retired = svc(JSON.stringify([{ kid: 'k2', secret: SECRET_B, status: 'active' }]));
    await expect(retired.verifyAccessToken(token)).rejects.toThrow('unknown signing key');
  });

  it('a token signed with a different secret under a known kid is rejected', async () => {
    const a = svc(JSON.stringify([{ kid: 'k1', secret: SECRET_A, status: 'active' }]));
    const b = svc(JSON.stringify([{ kid: 'k1', secret: SECRET_B, status: 'active' }]));
    const token = await a.signAccessToken('user-6', 'session-6');
    await expect(b.verifyAccessToken(token)).rejects.toThrow();
  });

  describe('parseKeyRing validation', () => {
    it('rejects invalid JSON', () => {
      expect(() => parseKeyRing({ JWT_SECRET: SECRET_A, JWT_KEYS: '{nope' } as never)).toThrow('not valid JSON');
    });
    it('rejects zero active keys', () => {
      const keys = JSON.stringify([{ kid: 'k1', secret: SECRET_A, status: 'previous' }]);
      expect(() => parseKeyRing({ JWT_SECRET: SECRET_A, JWT_KEYS: keys } as never)).toThrow('exactly one active');
    });
    it('rejects two active keys', () => {
      const keys = JSON.stringify([
        { kid: 'k1', secret: SECRET_A, status: 'active' },
        { kid: 'k2', secret: SECRET_B, status: 'active' },
      ]);
      expect(() => parseKeyRing({ JWT_SECRET: SECRET_A, JWT_KEYS: keys } as never)).toThrow('exactly one active');
    });
    it('rejects duplicate kids', () => {
      const keys = JSON.stringify([
        { kid: 'k1', secret: SECRET_A, status: 'active' },
        { kid: 'k1', secret: SECRET_B, status: 'previous' },
      ]);
      expect(() => parseKeyRing({ JWT_SECRET: SECRET_A, JWT_KEYS: keys } as never)).toThrow('duplicate kid');
    });
    it('rejects short secrets', () => {
      const keys = JSON.stringify([{ kid: 'k1', secret: 'too-short', status: 'active' }]);
      expect(() => parseKeyRing({ JWT_SECRET: SECRET_A, JWT_KEYS: keys } as never)).toThrow('32 chars');
    });
  });
});
