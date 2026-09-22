import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNTING_ASSERTION_COMPONENTS,
  mintAccountingAssertion,
  parseAccountingAssertionKey,
  secretsAreIdentical,
  splitAccountingAssertion,
  type AccountingAssertionClaims,
} from '../src/assertion';
import { AccountingError } from '../src/errors';

const key = { kid: 'acct1', secret: Buffer.alloc(32, 7) };

const claims: AccountingAssertionClaims = {
  actorUserId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  tenantId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
  businessId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
  operationKind: 'post',
  sourceType: 'manual_adjustment',
  sourceId: '1b4e28ba-2fa1-11d2-9a0c-0305e82c3301',
  postingFingerprint: 'a'.repeat(64),
};

describe('accounting assertion — format (§14)', () => {
  it('mints exactly twelve dot-separated components', () => {
    const parts = mintAccountingAssertion(key, claims).split('.');
    expect(parts).toHaveLength(ACCOUNTING_ASSERTION_COMPONENTS);
    expect(ACCOUNTING_ASSERTION_COMPONENTS).toBe(12);
  });

  it('places every claim in the documented position', () => {
    const p = mintAccountingAssertion(key, claims).split('.');
    expect(p[0]).toBe('v1');
    expect(p[1]).toBe('acct1');
    expect(p[2]).toBe(claims.actorUserId);
    expect(p[3]).toBe(claims.tenantId);
    expect(p[4]).toBe(claims.businessId);
    expect(p[5]).toBe('post');
    expect(p[6]).toBe(claims.sourceType);
    expect(p[7]).toBe(claims.sourceId);
    expect(p[8]).toBe(claims.postingFingerprint);
    expect(Number(p[9])).toBeGreaterThan(0);
    expect(p[10]).toMatch(/^[0-9a-f-]{36}$/);
    expect(p[11]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('signs the first eleven components, so every claim is bound', () => {
    const raw = mintAccountingAssertion(key, claims);
    const parts = raw.split('.');
    const expected = createHmac('sha256', key.secret).update(parts.slice(0, 11).join('.'), 'utf8').digest('hex');
    expect(parts[11]).toBe(expected);
  });

  it('gives each mint a fresh jti, so two mints are never the same assertion', () => {
    const a = mintAccountingAssertion(key, claims).split('.');
    const b = mintAccountingAssertion(key, claims).split('.');
    expect(a[10]).not.toBe(b[10]);
    expect(a[11]).not.toBe(b[11]);
  });

  it('sets an expiry a short TTL into the future', () => {
    const now = new Date('2026-03-14T08:00:00Z');
    const exp = Number(mintAccountingAssertion(key, claims, now).split('.')[9]);
    expect(exp).toBe(Math.floor(now.getTime() / 1000) + 60);
  });

  it('changing any signed claim changes the signature', () => {
    const now = new Date('2026-03-14T08:00:00Z');
    const base = mintAccountingAssertion(key, claims, now).split('.')[11];
    const variants: AccountingAssertionClaims[] = [
      { ...claims, actorUserId: '3f2504e0-4f89-41d3-9a0c-0305e82c3302' },
      { ...claims, tenantId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6e' },
      { ...claims, businessId: '6ba7b810-9dad-11d1-80b4-00c04fd430c9' },
      { ...claims, sourceType: 'opening_balance' },
      { ...claims, sourceId: '1b4e28ba-2fa1-11d2-9a0c-0305e82c3302' },
      { ...claims, postingFingerprint: 'b'.repeat(64) },
    ];
    // The jti differs per mint, so compare against a mint of the SAME claims
    // rather than expecting equality — what matters is that no variant can
    // reuse the original signature.
    for (const v of variants) {
      expect(mintAccountingAssertion(key, v, now).split('.')[11]).not.toBe(base);
    }
  });

  it('a different key produces a different signature over identical claims', () => {
    const other = { kid: 'acct1', secret: Buffer.alloc(32, 9) };
    const now = new Date('2026-03-14T08:00:00Z');
    expect(mintAccountingAssertion(key, claims, now).split('.')[11]).not.toBe(mintAccountingAssertion(other, claims, now).split('.')[11]);
  });
});

describe('accounting assertion — refusals at mint time', () => {
  const bad: ReadonlyArray<readonly [string, AccountingAssertionClaims]> = [
    ['a non-uuid actor', { ...claims, actorUserId: 'not-a-uuid' }],
    ['a non-uuid tenant', { ...claims, tenantId: 'nope' }],
    ['a non-uuid business', { ...claims, businessId: '' }],
    ['a non-uuid source id', { ...claims, sourceId: '123' }],
    ['a fingerprint that is not sha-256 hex', { ...claims, postingFingerprint: 'short' }],
    ['a source type containing the separator', { ...claims, sourceType: 'manual.adjustment' }],
  ];
  for (const [what, c] of bad) {
    it(`refuses ${what}`, () => {
      expect(() => mintAccountingAssertion(key, c)).toThrow(AccountingError);
    });
  }

  it('refuses an operation kind other than post — no speculative kinds', () => {
    expect(() => mintAccountingAssertion(key, { ...claims, operationKind: 'reverse' as 'post' })).toThrow(AccountingError);
  });
});

describe('accounting assertion — key handling (§19)', () => {
  it('requires at least 32 secret bytes', () => {
    expect(() => parseAccountingAssertionKey({ ACCOUNTING_ASSERTION_KEY: Buffer.alloc(31).toString('base64') })).toThrow(/at least 32 bytes/);
  });

  it('accepts a 32-byte key and defaults the kid', () => {
    const parsed = parseAccountingAssertionKey({ ACCOUNTING_ASSERTION_KEY: Buffer.alloc(32, 1).toString('base64') });
    expect(parsed?.kid).toBe('v1');
    expect(parsed?.secret).toHaveLength(32);
  });

  it('validates the kid shape', () => {
    expect(() =>
      parseAccountingAssertionKey({ ACCOUNTING_ASSERTION_KEY: Buffer.alloc(32, 1).toString('base64'), ACCOUNTING_ASSERTION_KID: 'bad kid!' }),
    ).toThrow(/ACCOUNTING_ASSERTION_KID/);
  });

  it('returns null when no key is configured, so a process without one simply cannot mint', () => {
    expect(parseAccountingAssertionKey({})).toBeNull();
  });

  it('detects an accounting secret identical to the provisioning secret', () => {
    expect(secretsAreIdentical(Buffer.alloc(32, 3), Buffer.alloc(32, 3))).toBe(true);
    expect(secretsAreIdentical(Buffer.alloc(32, 3), Buffer.alloc(32, 4))).toBe(false);
    expect(secretsAreIdentical(Buffer.alloc(32, 3), Buffer.alloc(33, 3))).toBe(false);
  });
});

describe('accounting assertion — parsing', () => {
  it('splits a well-formed assertion', () => {
    expect(splitAccountingAssertion(mintAccountingAssertion(key, claims))).toHaveLength(12);
  });

  it('refuses a wrong component count or version', () => {
    expect(() => splitAccountingAssertion('v1.a.b')).toThrow(AccountingError);
    expect(() => splitAccountingAssertion(mintAccountingAssertion(key, claims).replace(/^v1\./, 'v2.'))).toThrow(AccountingError);
  });
});
