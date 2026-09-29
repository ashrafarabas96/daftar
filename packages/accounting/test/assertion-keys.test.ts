import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { effectiveHmacKey, hmacKeysEquivalent } from '../src/assertion-keys';
import * as accounting from '../src/index';
import { parseAccountingAssertionKey, secretsAreIdentical } from '../src/assertion';

/**
 * T-15a (P3-S8 A-19, TD-12). The vectors below moved verbatim from
 * `packages/inventory/test/assertion.test.ts` with the function: the one
 * effective-key comparison now lives in `@daftar/accounting` and every pair
 * of assertion keys is judged by it.
 */
describe('hmacKeysEquivalent — key separation over the EFFECTIVE HMAC-SHA-256 key (P3-AL-55 §C)', () => {
  const K = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
  const mac = (key: Buffer): string => createHmac('sha256', key).update('invctl/1\nprobe').digest('hex');
  const zeros = (n: number): Buffer => Buffer.alloc(n, 0);

  it('K and K‖0x00 are one HMAC key — the premise, and the verdict', () => {
    const padded = Buffer.concat([K, zeros(1)]);
    expect(padded.equals(K)).toBe(false);
    expect(mac(padded)).toBe(mac(K));
    expect(hmacKeysEquivalent(K, padded)).toBe(true);
    expect(hmacKeysEquivalent(padded, K)).toBe(true);
  });

  it('K and K‖0x00‖0x00 are one HMAC key, as is K padded to the full 64-byte block', () => {
    for (const extra of [2, 32]) {
      const padded = Buffer.concat([K, zeros(extra)]);
      expect(padded.length).toBeLessThanOrEqual(64);
      expect(mac(padded)).toBe(mac(K));
      expect(hmacKeysEquivalent(K, padded)).toBe(true);
    }
  });

  it('a key longer than 64 bytes is one HMAC key with its own SHA-256 digest', () => {
    for (const length of [65, 100, 128]) {
      const long = Buffer.from(Array.from({ length }, (_, i) => (i * 7 + 3) % 256));
      const digest = createHash('sha256').update(long).digest();
      expect(mac(long)).toBe(mac(digest));
      expect(hmacKeysEquivalent(long, digest)).toBe(true);
      expect(hmacKeysEquivalent(digest, long)).toBe(true);
      // … and with that digest zero-padded, too.
      expect(hmacKeysEquivalent(long, Buffer.concat([digest, zeros(3)]))).toBe(true);
    }
  });

  it('identical keys are equivalent', () => {
    expect(hmacKeysEquivalent(K, Buffer.from(K))).toBe(true);
  });

  it('genuinely different keys are not — including a leading zero, a changed last byte and a truncation', () => {
    const lastByte = Buffer.from(K);
    lastByte[31] = 0xff;
    const cases: Buffer[] = [
      Buffer.alloc(32, 7),
      lastByte,
      Buffer.concat([zeros(1), K]),
      K.subarray(0, 31),
      Buffer.concat([K, Buffer.from([1])]),
      Buffer.from(Array.from({ length: 65 }, (_, i) => i)),
    ];
    for (const other of cases) {
      expect(mac(other)).not.toBe(mac(K));
      expect(hmacKeysEquivalent(K, other)).toBe(false);
    }
  });

  it('a 64-byte key is used as-is, not hashed: it is NOT equivalent to its digest', () => {
    const block = Buffer.from(Array.from({ length: 64 }, (_, i) => i + 1));
    const digest = createHash('sha256').update(block).digest();
    expect(mac(block)).not.toBe(mac(digest));
    expect(hmacKeysEquivalent(block, digest)).toBe(false);
  });
});

describe('effectiveHmacKey — the canonical form the comparison is taken over', () => {
  const K = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));

  it('strips trailing zero bytes and nothing else', () => {
    expect(effectiveHmacKey(Buffer.concat([K, Buffer.alloc(5, 0)])).equals(K)).toBe(true);
    const leading = Buffer.concat([Buffer.alloc(2, 0), K]);
    expect(effectiveHmacKey(leading).equals(leading)).toBe(true);
  });

  it('replaces a key over the 64-byte block by its SHA-256 digest', () => {
    const long = Buffer.from(Array.from({ length: 80 }, (_, i) => (i * 5 + 1) % 256));
    const digest = createHash('sha256').update(long).digest();
    expect(effectiveHmacKey(long).equals(effectiveHmacKey(digest))).toBe(true);
  });

  it('does not mutate its argument', () => {
    const padded = Buffer.concat([K, Buffer.alloc(3, 0)]);
    const copy = Buffer.from(padded);
    effectiveHmacKey(padded);
    expect(padded.equals(copy)).toBe(true);
  });
});

describe('the accounting ↔ provisioning pair (TD-12): one comparison, over effective keys', () => {
  const b64 = (buf: Buffer): string => buf.toString('base64');
  const ACCOUNTING = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 3 + 11) % 256 || 1));

  it('is the function @daftar/accounting exports — one implementation, re-exported from the package root', () => {
    expect(accounting.hmacKeysEquivalent).toBe(hmacKeysEquivalent);
    expect(accounting.effectiveHmacKey).toBe(effectiveHmacKey);
  });

  it('an accounting key K and a provisioning key K‖0x00 are refused as one key, although their bytes differ', () => {
    const provisioning = Buffer.concat([ACCOUNTING, Buffer.alloc(1, 0)]);
    const parsed = parseAccountingAssertionKey({ ACCOUNTING_ASSERTION_KEY: b64(ACCOUNTING) });
    expect(parsed).not.toBeNull();
    const secret = parsed?.secret ?? Buffer.alloc(0);
    // The byte comparison TD-12 names would have admitted this pair.
    expect(secretsAreIdentical(secret, provisioning)).toBe(false);
    expect(hmacKeysEquivalent(secret, Buffer.from(b64(provisioning), 'base64'))).toBe(true);
  });

  it('a 65-byte provisioning key and an accounting key equal to its digest are one key', () => {
    const provisioning = Buffer.from(Array.from({ length: 65 }, (_, i) => (i * 13 + 5) % 256));
    const accountingKey = createHash('sha256').update(provisioning).digest();
    expect(secretsAreIdentical(accountingKey, provisioning)).toBe(false);
    expect(hmacKeysEquivalent(accountingKey, provisioning)).toBe(true);
  });

  it('distinct accounting and provisioning keys stay distinct', () => {
    const provisioning = Buffer.alloc(32, 0x5a);
    expect(hmacKeysEquivalent(ACCOUNTING, provisioning)).toBe(false);
  });
});
