/**
 * Binding a free-text reason under the locked `invpl/1` grammar
 * (PHASE_3_S3_CONTRACT A-09, TL-4).
 *
 * The grammar has four field types — `uuid`, `boolean`, `integer`, `code` —
 * and no text type, so an adjustment's or a damage's reason cannot be a field
 * by itself. It is bound instead as the SHA-256 of its exact UTF-8 bytes,
 * split into eight unsigned 32-bit big-endian words, each carried as a
 * base-10 `integer` field (`reason_w1` … `reason_w8`). The SQL twin
 * `inventory_reason_words(text)` computes the same words from the reason the
 * routine actually receives, so a reason changed after signing is a
 * different payload and is refused before anything is written.
 *
 * The reason is hashed exactly as given — never trimmed, normalized or
 * case-folded here. The caller passes the one string it will also pass to the
 * routine; normalizing on only one side would let the two disagree.
 */
import { createHash } from 'node:crypto';
import { InventoryError } from './errors';

/** Words in a SHA-256 digest: 256 / 32. */
export const REASON_WORD_COUNT = 8;
/** The primitive's rule (`0060`): a stored reason is 1..500 characters after trimming. */
export const REASON_MAX_CHARS = 500;

/** A UTF-16 surrogate that is not half of a pair: text with one has no exact UTF-8 bytes. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** Leading or trailing whitespace as PostgreSQL's `btrim(text)` sees it: the space character only. */
const BTRIM_SPACES = /^ +| +$/g;

/**
 * Refuses a reason the database could never store as given: empty after
 * `btrim`, longer than 500 characters (code points, as `char_length`
 * counts), containing NUL (PostgreSQL text cannot), or not well-formed
 * UTF-16 (its UTF-8 bytes would be a replacement, not the text).
 */
export function assertStorableReason(reason: string): void {
  if (typeof reason !== 'string') throw new InventoryError('inventory.reason_required', 'a reason is required');
  const trimmed = reason.replace(BTRIM_SPACES, '');
  const length = [...trimmed].length;
  if (length === 0) throw new InventoryError('inventory.reason_required', 'a reason is required');
  if (length > REASON_MAX_CHARS) throw new InventoryError('inventory.payload_invalid', 'a reason is at most 500 characters');
  if (reason.includes('\u0000') || LONE_SURROGATE.test(reason)) {
    throw new InventoryError('inventory.payload_invalid', 'a reason must be well-formed text without NUL');
  }
}

/** The SHA-256 of the reason's exact UTF-8 bytes, as eight unsigned 32-bit big-endian words. */
export function reasonWords(reason: string): readonly bigint[] {
  assertStorableReason(reason);
  const digest = createHash('sha256').update(Buffer.from(reason, 'utf8')).digest();
  const words: bigint[] = [];
  for (let i = 0; i < REASON_WORD_COUNT; i += 1) words.push(BigInt(digest.readUInt32BE(i * 4)));
  return Object.freeze(words);
}
