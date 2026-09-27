/**
 * ASSERTION-KEY SEPARATION — the one effective-key comparison (P3-S8 A-19,
 * TD-12, P3-AL-55 §C).
 *
 * DAFTAR signs three authority domains with three HMAC-SHA-256 keys: the
 * provisioning key (Phase 1), the accounting key (Phase 2) and the inventory
 * key (Phase 3). Separate variable names are not separation: two keys that
 * HMAC treats as ONE key let a single secret mint in both domains. Every pair
 * — accounting↔provisioning, inventory↔provisioning, inventory↔accounting — is
 * therefore compared here and nowhere else, at every site that loads or
 * installs a key (`apps/api/src/config.ts`, both minters, the three
 * `scripts/install-*-key.ts`).
 *
 * The comparison is over the EFFECTIVE key, never over the bytes. `K` and
 * `K‖0x00` are one HMAC-SHA-256 key: compare the effective key.
 *
 * It lives in `@daftar/accounting` (TL-2) rather than in the inventory
 * package: accepted Phase 2 accounting code must not import a Phase 3 domain
 * package, and `@daftar/domain-core` reaches the web bundle, where
 * `node:crypto` has no place. It uses `node:crypto` only.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/** SHA-256's block size: the length HMAC-SHA-256 pads (or hashes) every key to. */
const HMAC_SHA256_BLOCK_BYTES = 64;

/**
 * The key HMAC-SHA-256 actually uses (RFC 2104 §2): a key longer than the
 * 64-byte block is replaced by its SHA-256 digest, and the result is padded
 * with 0x00 up to the block. Two byte strings that differ only by trailing
 * zero bytes — or a long key and its own digest — are therefore ONE key.
 * Stripping the trailing zeros yields a canonical form in which exactly the
 * equivalent keys compare equal.
 */
export function effectiveHmacKey(key: Buffer): Buffer {
  const k = key.length > HMAC_SHA256_BLOCK_BYTES ? createHash('sha256').update(key).digest() : key;
  let end = k.length;
  while (end > 0 && k[end - 1] === 0) end -= 1;
  return k.subarray(0, end);
}

/**
 * True when two secrets are the SAME HMAC-SHA-256 key, even when their bytes
 * differ (P3-AL-55 §C). Exact byte comparison is not enough for key
 * separation: `K` and `K‖0x00` sign identically, as do a key over 64 bytes and
 * its SHA-256 digest, so a key "different" from another in that way would let
 * one secret mint in both domains. Compared in constant time over the
 * normalized forms; different normalized lengths are different keys.
 */
export function hmacKeysEquivalent(a: Buffer, b: Buffer): boolean {
  const na = effectiveHmacKey(a);
  const nb = effectiveHmacKey(b);
  if (na.length !== nb.length) return false;
  return timingSafeEqual(na, nb);
}
