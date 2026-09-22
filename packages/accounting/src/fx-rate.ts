/**
 * The FX rate registry's application half: the `fxrate/1` canonical
 * fingerprint, the rate identity derivation, and the typed shapes a rate
 * entry and a rate lookup carry (directive §32, §33).
 *
 * Everything here is PURE. It derives and canonicalizes; it reads no
 * configuration, opens no connection and fetches nothing. There is no rate
 * PROVIDER in this module and no seam where one could be added without a
 * migration, a credential and a review: P2-S5's only source is `manual`
 * (§10, §40).
 */
import { createHash } from 'node:crypto';
import { AccountingError } from './errors';
import { canonicalCurrency, canonicalInstantSecond, canonicalRate, canonicalUuid } from './fingerprint';
import { deriveAccountingResourceId } from './sources';

/** The only rate provenance that exists in P2-S5. Not an enum with room in it. */
export type FxRateEntrySource = 'manual';
export const FX_RATE_SOURCE: FxRateEntrySource = 'manual';

/** Stream version prefix. Bump only with a new spec and new vectors. */
export const FXRATE_VERSION = 'fxrate/1';

/** Every immutable fact of one rate entry. Nothing narrative appears here. */
export interface FxRateFacts {
  readonly tenantId: string;
  readonly businessId: string;
  readonly rateId: string;
  readonly fromCurrency: string;
  readonly toCurrency: string;
  /** Decimal string; canonicalized to exactly ten fraction digits. */
  readonly rate: string;
  /** The instant the rate takes effect. UTC, second precision. */
  readonly effectiveAt: Date;
  readonly source: FxRateEntrySource;
}

/**
 * The canonical byte stream — UTF-8, newline-separated, newline-terminated:
 *
 *   fxrate/1 \n tenant \n business \n rate_id \n from \n to \n rate \n
 *   effective_at \n source \n
 *
 * Why bytes and not JSON. `JSON.stringify` is not a financial identity: key
 * order, unicode escaping, number formatting and whitespace are all
 * implementation-defined and none of them is stable across two languages.
 * The PostgreSQL half lives in `0048` and the shared vectors in
 * `vectors/fxrate-vectors.json` are the single source both are tested
 * against, so neither can drift without the other failing.
 *
 * What is NOT in the stream: a request id, a memo, a description, a created
 * timestamp. A rate entry has no narrative at all, and a field that could be
 * reworded would make a retry sign a different command.
 */
export function fxRateCanonicalStream(facts: FxRateFacts): Buffer {
  if (facts.source !== 'manual') {
    throw new AccountingError('accounting.payload_invalid', 'the only FX rate source is manual');
  }
  const from = canonicalCurrency(facts.fromCurrency);
  const to = canonicalCurrency(facts.toCurrency);
  if (from === to) {
    throw new AccountingError('accounting.fx_same_currency', 'a currency has no exchange rate against itself');
  }
  return Buffer.from(
    [
      FXRATE_VERSION,
      canonicalUuid(facts.tenantId),
      canonicalUuid(facts.businessId),
      canonicalUuid(facts.rateId),
      from,
      to,
      canonicalRate(facts.rate),
      canonicalInstantSecond(facts.effectiveAt),
      facts.source,
      '',
    ].join('\n'),
    'utf8',
  );
}

/** Lowercase hex SHA-256 of the canonical stream — the signed fingerprint. */
export function computeFxRateFingerprint(facts: FxRateFacts): string {
  return createHash('sha256').update(fxRateCanonicalStream(facts)).digest('hex');
}

/**
 * The rate's identity, derived from the business and the request's
 * `Idempotency-Key` (§33).
 *
 * It is the SAME deterministic-id discipline P2-S4 uses for a source
 * identity, under its own domain label: same construction, same UUID shaping,
 * different domain string. The label matters. Without it, one
 * `Idempotency-Key` reused across an adjustment and a rate entry would derive
 * one UUID for two unrelated things, and a debugging session years from now
 * would find a rate id that is also a journal source id and have to decide
 * whether that meant something.
 */
export function deriveFxRateId(businessId: string, idempotencyKey: string): string {
  return deriveAccountingResourceId('daftar/accounting-fx-rate-id/v1', businessId, idempotencyKey);
}

/** What the caller states when entering a rate. No actor, no tenant, no source. */
export interface FxRateEntryCommand {
  readonly tenantId: string;
  readonly businessId: string;
  readonly rateId: string;
  readonly fromCurrency: string;
  readonly toCurrency: string;
  readonly rate: string;
  readonly effectiveAt: Date;
  readonly requestId?: string | null;
}

/** The outcome of a rate entry. `created: false` is an idempotent replay. */
export interface FxRateEntryResult {
  readonly rateId: string;
  readonly created: boolean;
}

/**
 * A resolved rate, as a future posting workflow will read it.
 *
 * All three of `rate`, `source` and `effectiveAt` are copied VERBATIM into
 * the journal line's `fx_rate`, `fx_rate_source` and `fx_rate_at` (§22, §47).
 * The line then owns that snapshot forever: nothing already posted is ever
 * re-valued from this registry, and `rateId` is tracing information rather
 * than the historical authority.
 */
export interface FxRateSnapshot {
  readonly rateId: string;
  readonly rate: string;
  readonly source: FxRateEntrySource;
  readonly effectiveAt: Date;
}

/**
 * The strict shape a rate string must have at every boundary (§15).
 *
 * Unsigned, at most ten fraction digits, no exponent, no separators. Every
 * one of those refusals matters: `3.7e0`, `+3.71`, `3.71000000001` and a
 * JSON number that arrived as `3.71` all look convertible and all mean the
 * registry would store something the caller did not state.
 */
export const FX_RATE_STRING_RE = /^(0|[1-9][0-9]{0,9})(\.[0-9]{1,10})?$/;

/**
 * Canonicalize an entered rate, or REFUSE.
 *
 * `canonicalRate` already normalizes "3.71" to "3.7100000000". What this adds
 * is the refusal of a rate that is merely zero, because zero matches the
 * shape and is not a rate any conversion can be performed with, and the
 * explicit rejection of anything outside the strict string shape rather than
 * letting a cast round it (§15: do not round an entered rate silently).
 */
export function canonicalEnteredRate(value: string): string {
  const raw = value.trim();
  if (!FX_RATE_STRING_RE.test(raw)) {
    throw new AccountingError('accounting.fx_rate_invalid', 'a rate is an exact decimal with at most ten fraction digits, stated as text');
  }
  const canonical = canonicalRate(raw);
  if (/^0\.0{10}$/.test(canonical)) {
    throw new AccountingError('accounting.fx_rate_invalid', 'a rate must be greater than zero');
  }
  return canonical;
}
