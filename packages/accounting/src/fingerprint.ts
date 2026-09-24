/**
 * `acctfp/1` — the canonical financial fingerprint.
 *
 * This module and the PostgreSQL canonicalizer in `0045` are two
 * implementations of ONE specification. They must produce byte-identical
 * canonical streams and therefore identical SHA-256 digests; the shared
 * vectors in `vectors/acctfp-vectors.json` are the single source both are
 * tested against, so neither can drift without the other failing (§21).
 *
 * Why bytes and not JSON. `JSON.stringify` is not a financial identity: key
 * order, unicode escaping, number formatting and whitespace are all
 * implementation-defined, and none of them is stable across two languages.
 * The canonical stream below is defined at the byte level instead (§22).
 *
 * The stream:
 *
 *   acctfp/1 \n tenant \n business \n source_type \n source_id \n entry_date \n
 *   <line><RS><line><RS>...
 *
 * A line is its fields joined by US (0x1f). Lines are sorted ascending by
 * those field bytes, compared as bytes, and each is then terminated by RS
 * (0x1e). A NULL dimension is the single byte 0x00 — which is precisely why
 * the database side must build BYTEA: PostgreSQL TEXT cannot contain NUL, and
 * faking it with '\x00', an empty string or a literal backslash-zero would
 * make the two implementations disagree on the one value most likely to
 * appear in an attacker's payload.
 *
 * What is NOT in the stream: description, memo, request id, line numbers,
 * account UUIDs, display names, created_at. Narrative may be reworded and a
 * retry must still be recognised as the same financial fact (§28, §47).
 */
import { createHash } from 'node:crypto';
import { AccountingError } from './errors';
import type { PostingSide } from './types';

/** Field separator inside one line record. */
export const US = 0x1f;
/** Record terminator after each line. */
export const RS = 0x1e;
/** The whole representation of a NULL dimension — one byte, never a string. */
export const NUL = 0x00;
/** Stream version prefix. Bump only with a new spec and new vectors. */
export const ACCTFP_VERSION = 'acctfp/1';

// Explicitly typed, not merely annotated on the arrow: TypeScript only applies
// never-returning control-flow narrowing to a const with a type annotation, and
// without it every caller would need a non-null assertion afterwards.
const invalid: (what: string) => never = (what) => {
  throw new AccountingError('accounting.payload_invalid', `canonical fingerprint input is invalid: ${what}`);
};

/** Lowercase canonical UUID text. Rejects anything that is not a UUID (§23). */
export function canonicalUuid(value: string): string {
  const v = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) invalid('uuid');
  return v;
}

/** Uppercase ISO currency code (§23). */
export function canonicalCurrency(value: string): string {
  const v = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(v)) invalid('currency');
  return v;
}

/**
 * A non-negative integer decimal string: no sign, no separators, no exponent,
 * and no leading zeroes except the literal `0` (§23).
 */
export function canonicalAmount(value: bigint): string {
  if (value < 0n) invalid('amount is negative');
  return value.toString(10);
}

/**
 * A rate with exactly ten fraction digits, matching `NUMERIC(20,10)` storage
 * exactly. Accepts a decimal string and re-emits it in canonical form, so
 * "1", "1.0" and "1.0000000000" all become "1.0000000000" — and a rate with
 * more than ten fraction digits is refused rather than silently truncated,
 * because the database could not have stored it either.
 */
export function canonicalRate(value: string): string {
  const v = value.trim();
  const m = /^(\d+)(?:\.(\d{1,10}))?$/.exec(v);
  if (m === null) invalid('rate');
  const whole = (m[1] ?? '0').replace(/^0+(?=\d)/, '');
  const frac = (m[2] ?? '').padEnd(10, '0');
  return `${whole}.${frac}`;
}

/** `YYYY-MM-DD`, validated as a real calendar date (§23). */
export function canonicalDate(value: string): string {
  const v = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) invalid('date');
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) invalid('date is not a real calendar date');
  return v;
}

/**
 * RFC3339 UTC at SECOND precision, ending `Z` (§23).
 *
 * Sub-second precision is refused rather than truncated. §24 adds a database
 * constraint requiring `date_trunc('second', fx_rate_at) = fx_rate_at` for
 * exactly this reason: if the fingerprint silently discarded milliseconds,
 * two different persisted snapshots would share one fingerprint and the
 * signed value would no longer describe the stored truth.
 */
export function canonicalInstantSecond(value: Date): string {
  if (Number.isNaN(value.getTime())) invalid('instant');
  if (value.getTime() % 1000 !== 0) invalid('instant carries sub-second precision');
  return `${value.toISOString().slice(0, 19)}Z`;
}

/** `D` or `C`, nothing else (§23). */
export function canonicalSide(side: PostingSide): string {
  if (side !== 'D' && side !== 'C') invalid('side');
  return side;
}

/**
 * One line's canonical fields, already normalized. The engine builds this from
 * a command plus the account identity the database resolved; the database
 * builds the same eleven fields from the row it is about to write.
 */
export interface CanonicalLineInput {
  readonly accountIdentity: string;
  readonly side: PostingSide;
  readonly baseAmountMinor: bigint;
  readonly baseCurrency: string;
  readonly txnAmountMinor: bigint;
  readonly txnCurrency: string;
  readonly fxRate: string;
  readonly fxRateSource: string;
  readonly fxRateAt: Date;
  readonly branchId: string | null;
  readonly warehouseId: string | null;
}

/** The header a stream starts with, before any line. */
export interface CanonicalHeaderInput {
  readonly tenantId: string;
  readonly businessId: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly entryDate: string;
}

const utf8 = (s: string): Buffer => Buffer.from(s, 'utf8');

/** A dimension is either its lowercase UUID bytes or the single NUL byte. */
const dimension = (value: string | null): Buffer => (value === null ? Buffer.from([NUL]) : utf8(canonicalUuid(value)));

/**
 * The canonical bytes of ONE line: eleven fields joined by US, with no
 * terminator. The terminator is added by `canonicalStream` after sorting, so
 * that sorting compares exactly the field bytes (§25).
 */
export function canonicalLineBytes(line: CanonicalLineInput): Buffer {
  if (line.accountIdentity.length === 0) invalid('account identity is empty');
  if (line.fxRateSource !== 'base' && line.fxRateSource !== 'manual' && line.fxRateSource !== 'provider') invalid('fx rate source');
  const fields: Buffer[] = [
    utf8(line.accountIdentity),
    utf8(canonicalSide(line.side)),
    utf8(canonicalAmount(line.baseAmountMinor)),
    utf8(canonicalCurrency(line.baseCurrency)),
    utf8(canonicalAmount(line.txnAmountMinor)),
    utf8(canonicalCurrency(line.txnCurrency)),
    utf8(canonicalRate(line.fxRate)),
    utf8(line.fxRateSource),
    utf8(canonicalInstantSecond(line.fxRateAt)),
    dimension(line.branchId),
    dimension(line.warehouseId),
  ];
  const out: Buffer[] = [];
  fields.forEach((f, i) => {
    if (i > 0) out.push(Buffer.from([US]));
    out.push(f);
  });
  return Buffer.concat(out);
}

/**
 * The full canonical byte stream.
 *
 * Lines are sorted by their own bytes, not by `line_no`, insertion order,
 * account id, `localeCompare` or a database collation — every one of those
 * would let the same financial fact hash two different ways depending on how
 * it arrived (§25). `Buffer.compare` is a plain unsigned byte comparison,
 * which is what PostgreSQL's BYTEA ordering also is.
 *
 * Two identical lines serialize identically and BOTH remain in the stream:
 * multiplicity is financial truth, so it must survive canonicalization.
 */
export function canonicalStream(header: CanonicalHeaderInput, lines: readonly CanonicalLineInput[]): Buffer {
  if (lines.length === 0) invalid('a posting has no lines');
  if (header.sourceType.length === 0) invalid('source type is empty');
  const head = utf8(
    [
      ACCTFP_VERSION,
      canonicalUuid(header.tenantId),
      canonicalUuid(header.businessId),
      header.sourceType,
      canonicalUuid(header.sourceId),
      canonicalDate(header.entryDate),
      '',
    ].join('\n'),
  );
  const sorted = lines.map(canonicalLineBytes).sort(Buffer.compare);
  const body: Buffer[] = [];
  for (const line of sorted) {
    body.push(line, Buffer.from([RS]));
  }
  return Buffer.concat([head, ...body]);
}

/** Lowercase hex SHA-256 of the canonical stream — the signed fingerprint. */
export function computeFingerprint(header: CanonicalHeaderInput, lines: readonly CanonicalLineInput[]): string {
  return createHash('sha256').update(canonicalStream(header, lines)).digest('hex');
}
