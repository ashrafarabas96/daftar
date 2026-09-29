import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InvplS3Vectors } from '../scripts/s3-vector-cases';
import { InventoryError } from '../src/errors';
import { assertStorableReason, REASON_WORD_COUNT, reasonWords } from '../src/reason-digest';

const vectors = JSON.parse(readFileSync(join(__dirname, '..', 'vectors', 'invpl-s3-vectors.json'), 'utf8')) as InvplS3Vectors;

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof InventoryError) return e.code;
    throw e;
  }
  return 'accepted';
}

describe('reasonWords — the shared vectors (TL-4)', () => {
  for (const r of vectors.reasons) {
    it(`${r.id}: ${r.why}`, () => {
      expect(Buffer.from(r.reason, 'utf8').toString('hex')).toBe(r.utf8Hex);
      expect(createHash('sha256').update(Buffer.from(r.utf8Hex, 'hex')).digest('hex')).toBe(r.sha256);
      expect(reasonWords(r.reason).map((w) => w.toString())).toEqual(r.words);
    });
  }
});

describe('reasonWords — shape', () => {
  it('is eight unsigned 32-bit big-endian words of the SHA-256 of the UTF-8 bytes', () => {
    const words = reasonWords('abc');
    expect(words).toHaveLength(REASON_WORD_COUNT);
    // SHA-256("abc") = ba7816bf 8f01cfea 414140de 5dae2223 b00361a3 96177a9c b410ff61 f20015ad
    expect(words.map((w) => w.toString(16).padStart(8, '0')).join('')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    for (const w of words) {
      expect(w >= 0n && w < 2n ** 32n).toBe(true);
    }
  });

  it('hashes the reason exactly: no trim, no case folding, no normalization', () => {
    const a = reasonWords('Broken');
    expect(reasonWords(' Broken')).not.toEqual(a);
    expect(reasonWords('broken')).not.toEqual(a);
    // NFC and NFD spellings of "é" are different bytes and different words.
    expect(reasonWords('café')).not.toEqual(reasonWords('café'));
  });

  it('refuses a reason the database could not store as given', () => {
    expect(codeOf(() => reasonWords(''))).toBe('inventory.reason_required');
    expect(codeOf(() => reasonWords('    '))).toBe('inventory.reason_required');
    expect(codeOf(() => reasonWords('a'.repeat(500)))).toBe('accepted');
    expect(codeOf(() => reasonWords('a'.repeat(501)))).toBe('inventory.payload_invalid');
    // 500 code points of a four-byte character: counted as characters, like char_length.
    expect(codeOf(() => assertStorableReason('📦'.repeat(500)))).toBe('accepted');
    expect(codeOf(() => reasonWords('bad\u0000byte'))).toBe('inventory.payload_invalid');
    expect(codeOf(() => reasonWords('lone \ud800 surrogate'))).toBe('inventory.payload_invalid');
    expect(codeOf(() => reasonWords('lone \udc00 surrogate'))).toBe('inventory.payload_invalid');
  });
});
