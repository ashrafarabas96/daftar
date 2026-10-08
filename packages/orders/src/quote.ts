/**
 * The immutable server-generated COMMERCIAL QUOTE SNAPSHOT — audited master
 * directive §27.
 *
 * ## The law this implements, and the law it refines
 *
 * An earlier law of this package said flatly "the order holds no money". §27
 * refines it, and the refined form is the binding one:
 *
 * > **THE ORDER HOLDS NO AUTHORITATIVE FINANCIAL TRUTH.** But it MAY carry an
 * > immutable server-generated commercial quote snapshot, in a clearly
 * > non-ledger, non-AR, non-settlement relation.
 *
 * The reason is a real defect the strict form allowed: **the system must not
 * silently change what the shopper saw.** An order that remembered nothing
 * about the prices it was placed at would let a catalogue edit between placement
 * and commit charge a different amount with nobody noticing. The quote closes
 * that without creating a second ledger, because of what it is forbidden to be:
 *
 * - **server-generated only.** No client states a price into it;
 * - **immutable.** A re-quote is a new version, never an edit;
 * - **never journal input.** No posting reads it;
 * - **never inventory authority.** No movement reads it;
 * - **never the canonical amount.** The sale command recomputes the truth, and
 *   where the recomputation diverges from the confirmed quote beyond policy,
 *   the automatic commit is REFUSED and an explicit re-confirmation is
 *   required.
 *
 * ## The complete list of money arithmetic in this package
 *
 * Stating it exhaustively, because "the order holds no money" is no longer the
 * whole answer and a reader deserves the real boundary:
 *
 * 1. **integer addition** of the stated line totals, to check that the displayed
 *    total adds up (`buildCommercialQuote`);
 * 2. **integer subtraction** of the quoted total from the recomputed total, to
 *    measure divergence (`assessQuoteDivergence`).
 *
 * That is all of it, and both are exact integer operations on minor units with
 * no rounding and no policy.
 *
 * **In particular this module does NOT derive a line total from a unit price and
 * a quantity.** That multiplication needs a rounding mode at the product's unit
 * precision, a rounding mode is a pricing policy, and a pricing policy invented
 * here would be a second money truth — the one thing the project has a rule
 * about. The per-line unit price, discount and line total are the pricing
 * authority's figures, carried verbatim, and this module checks only that they
 * sum to the total the shopper was shown.
 */
import { createHash } from 'node:crypto';
import { OrderError, assertCanonicalId } from './errors';
import { compareCanonical, isCanonicalInstant } from './instant';

/** Non-negative integer minor units as a decimal string. A shape check, so a float, a sign or padding cannot pass. */
const NON_NEGATIVE_MINOR = /^(0|[1-9]\d*)$/;

function requireMinor(value: string, field: string): bigint {
  if (!NON_NEGATIVE_MINOR.test(value)) {
    throw new OrderError('order.quote_amount_invalid', 'an amount must be non-negative integer minor units as a canonical decimal string', {
      field,
      stated: value,
    });
  }
  return BigInt(value);
}

/**
 * One priced line, exactly as the pricing authority resolved it and the shopper
 * saw it.
 *
 * `lineTotalMinor` is carried, not computed — see the module note.
 */
export interface QuoteLineSnapshot {
  /** As produced by `stockKeyOf`. */
  stockKey: string;
  productId: string;
  variantId: string | null;
  /** The decimal quantity string, at the product's unit precision. */
  quantity: string;
  /** The catalogue unit price the shopper was shown, minor units. */
  unitPriceMinor: string;
  /** The discount actually applied, minor units. A request that was granted, not a request. */
  discountMinor: string;
  /** What this line came to, as the pricing authority computed it. */
  lineTotalMinor: string;
}

/** The snapshot itself. Everything here is a fact about what the shopper was shown. */
export interface CommercialQuote {
  quoteId: string;
  orderId: string;
  /**
   * 1-based, strictly increasing. A re-quote is a NEW version with a new
   * `quoteId`; nothing is ever edited in place, which is why a confirmation can
   * name the version it agreed to.
   */
  version: number;
  currency: string;
  lines: readonly QuoteLineSnapshot[];
  /** The sum of the line totals — checked, not invented. */
  displayedTotalMinor: string;
  /** RFC3339 UTC at second precision, stated by the caller. Never a clock. */
  issuedAt: string;
  /** RFC3339 UTC, or `null` when product policy sets no expiry. */
  expiresAt: string | null;
  /** `sha256` over the canonical serialization below. Lowercase hex. */
  digest: string;
}

/** What `buildCommercialQuote` is given. The digest is computed, so it is not an input. */
export type CommercialQuoteInput = Omit<CommercialQuote, 'digest'>;

/**
 * The canonical byte stream the digest is taken over.
 *
 * Written out field by field in a FIXED order rather than handed to
 * `JSON.stringify` on the whole object, so the digest cannot change because a
 * field was reordered, and cannot silently stop covering a field that a future
 * author adds to the type: a new field is simply not in the stream until
 * someone puts it here, and this function is where a reviewer looks.
 *
 * `\u0000` separates fields because it cannot occur in any of the values, so no
 * concatenation of two fields can be confused with a different pair.
 */
export function canonicalQuoteBytes(quote: CommercialQuoteInput): string {
  const parts: string[] = [
    'daftar.p6.quote/1',
    quote.quoteId,
    quote.orderId,
    String(quote.version),
    quote.currency,
    quote.issuedAt,
    quote.expiresAt ?? '',
    quote.displayedTotalMinor,
    String(quote.lines.length),
  ];
  for (const line of quote.lines) {
    parts.push(line.stockKey, line.productId, line.variantId ?? '', line.quantity, line.unitPriceMinor, line.discountMinor, line.lineTotalMinor);
  }
  return parts.join('\u0000');
}

function digestOf(quote: CommercialQuoteInput): string {
  return createHash('sha256').update(canonicalQuoteBytes(quote), 'utf8').digest('hex');
}

/**
 * Build a quote snapshot, checking everything that can be checked without
 * inventing a pricing policy.
 */
export function buildCommercialQuote(input: CommercialQuoteInput): CommercialQuote {
  assertCanonicalId(input.quoteId, 'quoteId');
  assertCanonicalId(input.orderId, 'orderId');

  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new OrderError('order.quote_version_invalid', 'a quote version is an integer of at least 1');
  }
  if (!/^[A-Z]{3}$/.test(input.currency)) {
    throw new OrderError('order.quote_amount_invalid', 'currency must be a three-letter uppercase code', { field: 'currency' });
  }
  if (!isCanonicalInstant(input.issuedAt)) {
    throw new OrderError('order.occurred_at_invalid', 'issuedAt must be a canonical RFC3339 UTC instant at second precision');
  }
  if (input.expiresAt !== null) {
    if (!isCanonicalInstant(input.expiresAt)) {
      throw new OrderError('order.occurred_at_invalid', 'expiresAt must be a canonical RFC3339 UTC instant at second precision');
    }
    if (compareCanonical(input.expiresAt, input.issuedAt) <= 0) {
      throw new OrderError('order.quote_expiry_invalid', 'a quote that expires does so strictly after it was issued');
    }
  }
  if (input.lines.length === 0) {
    throw new OrderError('order.cart_empty', 'a quote carries at least one line');
  }

  const seen = new Set<string>();
  let sum = 0n;
  for (const line of input.lines) {
    assertCanonicalId(line.productId, 'productId');
    if (line.variantId !== null) assertCanonicalId(line.variantId, 'variantId');
    if (seen.has(line.stockKey)) {
      throw new OrderError('order.quote_line_duplicate', 'two quote lines name one stock key', { stockKey: line.stockKey });
    }
    seen.add(line.stockKey);
    requireMinor(line.unitPriceMinor, 'unitPriceMinor');
    requireMinor(line.discountMinor, 'discountMinor');
    sum += requireMinor(line.lineTotalMinor, 'lineTotalMinor');
  }

  const displayed = requireMinor(input.displayedTotalMinor, 'displayedTotalMinor');
  if (displayed !== sum) {
    // A displayed total that does not equal its own lines is precisely the
    // silent price surprise §27 exists to prevent, arriving before the shopper
    // has even confirmed. It is refused rather than corrected: correcting it
    // would mean choosing which of the two figures the shopper actually saw.
    throw new OrderError('order.quote_total_mismatch', 'the displayed total is not the exact sum of the quoted line totals', {
      displayedTotalMinor: input.displayedTotalMinor,
      lineSumMinor: sum.toString(),
    });
  }

  return { ...input, lines: Object.freeze([...input.lines]), digest: digestOf(input) };
}

/**
 * Recompute the digest and refuse a quote whose bytes no longer match it.
 *
 * This is the immutability claim made checkable. A quote stored in a relation
 * and later edited in place fails here, and `order.quote_tampered` says so
 * rather than the system carrying on with a snapshot that is no longer the one
 * the shopper confirmed.
 */
export function assertQuoteIntact(quote: CommercialQuote): void {
  const { digest, ...rest } = quote;
  const recomputed = digestOf(rest);
  if (recomputed !== digest) {
    throw new OrderError('order.quote_tampered', 'the quote does not match its own digest', { quoteId: quote.quoteId });
  }
}

/**
 * Refuse a quote that may no longer be confirmed.
 *
 * `asOf` is supplied, never read from a clock: the same retry must reach the
 * same verdict, and a quote that expired between two attempts of one request
 * would otherwise make the request's outcome depend on when it arrived.
 *
 * `confirmedVersion` is the version the shopper actually agreed to. Confirming
 * an older version than the order's current quote is `order.quote_version_stale`
 * — the shopper agreed to a figure that has since been superseded, and the
 * correct answer is to show them the new one, not to charge either.
 */
export function assertQuoteConfirmable(quote: CommercialQuote, asOf: string, confirmedVersion: number): void {
  assertQuoteIntact(quote);
  if (!isCanonicalInstant(asOf)) {
    throw new OrderError('order.occurred_at_invalid', 'asOf must be a canonical RFC3339 UTC instant at second precision');
  }
  if (compareCanonical(asOf, quote.issuedAt) < 0) {
    throw new OrderError('order.quote_expiry_invalid', 'asOf precedes the instant the quote was issued');
  }
  if (quote.expiresAt !== null && compareCanonical(asOf, quote.expiresAt) > 0) {
    throw new OrderError('order.quote_expired', 'the quote has expired and must be re-issued before it is confirmed', { quoteId: quote.quoteId });
  }
  if (confirmedVersion !== quote.version) {
    throw new OrderError('order.quote_version_stale', 'the confirmed version is not the order current quote version', {
      confirmed: String(confirmedVersion),
      current: String(quote.version),
    });
  }
}

/** The verdict on comparing the canonical recomputation against the confirmed quote. */
export type QuoteDivergenceVerdict =
  | { status: 'within_policy'; differenceMinor: string }
  | { status: 'requires_reconfirmation'; quotedTotalMinor: string; recomputedTotalMinor: string; differenceMinor: string };

/**
 * Compare what the sale command recomputed against what the shopper confirmed.
 *
 * `toleranceMinor` is a REQUIRED input with no default anywhere in this package.
 * A tolerance is a commercial policy — how much of a price change a business is
 * willing to charge without asking again — and a default written here would be a
 * policy DAFTAR invented on the merchant's behalf, silently, in the one place a
 * shopper would feel it. **The recommended value is `"0"`**: any divergence at
 * all requires explicit re-confirmation. That is raised to the owner as
 * `OD-P6-06` and is not decided here.
 *
 * The difference is ABSOLUTE: a recomputation that came out LOWER than the quote
 * also requires re-confirmation beyond tolerance. Charging less than the shopper
 * agreed to is still not the transaction they agreed to, and a one-sided
 * comparison is how a discount bug ships as a feature.
 */
export function assessQuoteDivergence(quote: CommercialQuote, recomputedTotalMinor: string, toleranceMinor: string): QuoteDivergenceVerdict {
  assertQuoteIntact(quote);
  const recomputed = requireMinor(recomputedTotalMinor, 'recomputedTotalMinor');
  const tolerance = requireMinor(toleranceMinor, 'toleranceMinor');
  const quoted = BigInt(quote.displayedTotalMinor);

  const signed = recomputed - quoted;
  const difference = signed < 0n ? -signed : signed;

  if (difference > tolerance) {
    return {
      status: 'requires_reconfirmation',
      quotedTotalMinor: quote.displayedTotalMinor,
      recomputedTotalMinor: recomputed.toString(),
      differenceMinor: difference.toString(),
    };
  }
  return { status: 'within_policy', differenceMinor: difference.toString() };
}
