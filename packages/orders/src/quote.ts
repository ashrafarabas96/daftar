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
import { assertQuantityRepresentable, formatQuantity, parseQuantity } from '@daftar/inventory';
import { stockKeyOf } from './cart';
import { NO_QUOTE_EXPIRY, type OrderQuoteConfirmationDto } from './contracts';
import { OrderError, assertCanonicalId } from './errors';
import { compareCanonical, isCanonicalInstant } from './instant';

/** Non-negative integer minor units as a decimal string. A shape check, so a float, a sign or padding cannot pass. */
const NON_NEGATIVE_MINOR = /^(0|[1-9]\d*)$/;

/**
 * The inventory authority's own bound on a product's frozen `unit_decimals`
 * (`packages/inventory/src/quantity.ts`, `Q4_STEP` for d = 0..4). It is mirrored
 * here so a malformed PRECISION is refused under its own code instead of being
 * relabelled as a malformed quantity.
 */
export const MAX_UNIT_DECIMALS = 4;

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
 * The quantity law for a quoted line.
 *
 * `cart.ts` already runs `@daftar/inventory`'s parse and representability pair
 * over a basket line; the quote relation did not, and that was a real defect
 * rather than an omission: the quote is the immutable record of what the shopper
 * was shown, `I6.3` stores `quantity` in `NUMERIC(18,4)`, and a `'-5'`, an
 * `'abc'` or a `'2.00000000001'` that this module admitted would be a commercial
 * fact nobody can defend and a row the column would reject or silently round.
 * So the same inventory truth is called here, under a quote-specific code.
 *
 * The CANONICAL FORM check is the third law and the one that is not obvious: the
 * quantity must be spelled exactly as `formatQuantity` spells it, so `'2'`,
 * `'2.0'` and `'2.0000'` are not three quotes of the same thing with three
 * different digests, and so a quoted quantity can be compared to a basket
 * position's `totalQuantity` — which is produced by that same formatter — by
 * string equality rather than by re-parsing.
 */
function requireQuoteQuantity(line: QuoteLineSnapshot, unitDecimals: number | undefined): bigint {
  let q4: bigint;
  try {
    q4 = parseQuantity(line.quantity);
  } catch {
    throw new OrderError('order.quote_quantity_invalid', 'a quoted quantity is not an exact decimal at the supported scale', {
      stockKey: line.stockKey,
      stated: line.quantity,
    });
  }
  if (q4 <= 0n) {
    throw new OrderError('order.quote_quantity_invalid', 'a quoted quantity is strictly positive', { stockKey: line.stockKey, stated: line.quantity });
  }
  if (formatQuantity(q4) !== line.quantity) {
    throw new OrderError('order.quote_quantity_invalid', 'a quoted quantity is written in its canonical four-decimal form, so one quantity has one spelling', {
      stockKey: line.stockKey,
      stated: line.quantity,
      canonical: formatQuantity(q4),
    });
  }
  if (unitDecimals !== undefined) {
    // The PRECISION is checked before the quantity is checked against it, and
    // under its own code. A caller-supplied precision that is not an integer in
    // 0..4 is a defect in the CALLER's figure, not in the shopper's quantity;
    // relabelling it `order.quote_quantity_invalid` told a client to ask the
    // shopper to fix a number the shopper never wrote (round-5 challenge P3).
    if (!Number.isInteger(unitDecimals) || unitDecimals < 0 || unitDecimals > MAX_UNIT_DECIMALS) {
      throw new OrderError('order.unit_precision_invalid', 'a stated unit precision is an integer from 0 to 4', {
        stockKey: line.stockKey,
        stated: String(unitDecimals),
      });
    }
    try {
      assertQuantityRepresentable(q4, unitDecimals);
    } catch (cause) {
      // Narrowed: with the precision already range-checked, the only refusal
      // the inventory authority can raise here is about the QUANTITY. Anything
      // else is rethrown as itself rather than renamed.
      if (cause instanceof Error && 'code' in cause && cause.code !== 'inventory.quantity_precision_invalid') {
        throw cause;
      }
      throw new OrderError('order.quote_quantity_invalid', 'a quoted quantity is not representable at the product unit precision', {
        stockKey: line.stockKey,
        stated: line.quantity,
      });
    }
  }
  return q4;
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
 * What is CHECKED about a quote without being part of it.
 *
 * It is a second parameter rather than a field of the input on purpose: the
 * input is exactly what the digest is taken over, and a checking aid that lived
 * on the input would either enter the canonical stream or have to be excluded
 * from it by hand, which is the kind of exception a later author drops.
 */
export interface CommercialQuoteChecks {
  /**
   * Stock key → the product's unit precision. A key that is absent is not
   * checked for representability — the law is not claimed where the caller did
   * not supply the precision, rather than being quietly assumed to be 4.
   */
  unitDecimalsByStockKey?: ReadonlyMap<string, number>;
}

/**
 * Build a quote snapshot, checking everything that can be checked without
 * inventing a pricing policy.
 */
export function buildCommercialQuote(input: CommercialQuoteInput, checks?: CommercialQuoteChecks): CommercialQuote {
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
    // The stock key must BE the canonical key of its own product and variant,
    // not merely a string. It is the same identity `stock_levels` is keyed on,
    // and it is also what makes this module's statement about `\u0000` true:
    // every other field in the canonical stream is matched against a pattern
    // that excludes a NUL, and `stockKey` and `quantity` were the two that were
    // not. The injectivity premise held only by the accident of the line-count
    // field; now it holds for the reason the comment gives.
    const canonicalKey = stockKeyOf(line);
    if (line.stockKey !== canonicalKey) {
      throw new OrderError('order.quote_stock_key_invalid', 'a quote line stock key is not the canonical key of its own product and variant', {
        stated: line.stockKey,
        expected: canonicalKey,
      });
    }
    requireQuoteQuantity(line, checks?.unitDecimalsByStockKey?.get(canonicalKey));
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
export function assertQuoteIntact(quote: CommercialQuote, checks?: CommercialQuoteChecks): void {
  const { digest, ...rest } = quote;
  const recomputed = digestOf(rest);
  if (recomputed !== digest) {
    throw new OrderError('order.quote_tampered', 'the quote does not match its own digest', { quoteId: quote.quoteId });
  }

  // INTEGRITY IS NOT LAWFULNESS, and for one revision this function conflated
  // them. Recomputing the digest proves only that nobody edited the quote since
  // its bytes were written; it proves nothing about whether those bytes were
  // ever admissible. `canonicalQuoteBytes` is exported, so ANY self-consistent
  // object carries a valid digest — and the independent challenger measured the
  // cost: a hand-built quote whose displayed total was 999999 against lines
  // summing to 1000 passed this check, passed the approval gate, built a sale
  // commit intent, and then had PART 33's zero tolerance measured against the
  // forged figure, so the HONEST recomputation of 1000 was the one refused as a
  // divergence. A forged duplicate stock key was worse: it collapsed the
  // hand-off's per-key map and handed the last duplicate's discount to a
  // checkout the other line had priced at zero.
  //
  // So lawfulness is re-established by RE-RUNNING THE BUILDER over the quote's
  // own fields. The builder is the only definition of a lawful quote, and this
  // cannot drift from it, because it IS it: a law added there is enforced here
  // on the next call with no second site to remember. Its refusal is rethrown
  // as itself — `order.quote_total_mismatch`, `order.quote_line_duplicate`,
  // `order.quote_quantity_invalid` — rather than flattened into "tampered",
  // because the caller deserves to know WHICH law the quote breaks.
  //
  // A quote read back from the relation carries its stored digest, so the digest
  // check above speaks for the storage and this check speaks for the content.
  // `I6.2` would refuse an unlawful sum in the relation too, but the DDL is
  // `SPEC ONLY` until the Migration Owner applies it, so today this is the only
  // layer that holds.
  const rebuilt = buildCommercialQuote(rest, checks);
  if (rebuilt.digest !== digest) {
    // Unreachable while the digest is a pure function of the fields: the bytes
    // were just proved to hash to `digest`. Stated as a refusal rather than
    // assumed, so a future change to the builder that alters the stream cannot
    // pass silently.
    throw new OrderError('order.quote_tampered', 'the quote rebuilt from its own fields does not reproduce its digest', { quoteId: quote.quoteId });
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
 *
 * ## The expiry boundary is HALF-OPEN, and it was wrong here
 *
 * **A quote is valid only while `asOf < expiresAt`, so `asOf === expiresAt` is
 * EXPIRED.** Until Directive #11 PART 34 named it, this function compared with
 * `> 0` and therefore ACCEPTED the exact expiry instant — a quote was usable
 * for one whole second past the moment it was declared to stop being usable.
 * An inclusive bound is the kind of defect no reviewer feels, because the
 * wording "expires at T" reads true either way; only stating which side T
 * falls on, and then testing the three instants around it, settles it.
 * Equality must never be admitted by accident, so it is admitted by nothing:
 * the comparison is `>= 0`.
 */
export function assertQuoteConfirmable(quote: CommercialQuote, asOf: string, confirmedVersion: number, checks?: CommercialQuoteChecks): void {
  // `checks` is threaded rather than dropped: `assertQuoteIntact` re-runs the
  // builder, and the builder's REPRESENTABILITY law is the one leg that needs a
  // per-stock-key precision to be claimed at all. For one revision this
  // function had no such parameter, so the only gate call site could not supply
  // one and that leg had no caller — the same "a law with no caller guards
  // nothing" shape the challenger found in the quote module itself. Measured
  // then: with a precision of 0 the builder refuses a quantity of `0.5000`, and
  // a forged quote carrying it passed the whole gate. The path failed closed one
  // layer out, because `summariseBasket` refuses the matching position, but a
  // defence that depends on another module's refusal is not this one's defence.
  assertQuoteIntact(quote, checks);
  if (!isCanonicalInstant(asOf)) {
    throw new OrderError('order.occurred_at_invalid', 'asOf must be a canonical RFC3339 UTC instant at second precision');
  }
  if (compareCanonical(asOf, quote.issuedAt) < 0) {
    throw new OrderError('order.quote_expiry_invalid', 'asOf precedes the instant the quote was issued');
  }
  if (quote.expiresAt !== null && compareCanonical(asOf, quote.expiresAt) >= 0) {
    throw new OrderError('order.quote_expired', 'the quote has expired and must be re-issued before it is confirmed', { quoteId: quote.quoteId });
  }
  if (confirmedVersion !== quote.version) {
    throw new OrderError('order.quote_version_stale', 'the confirmed version is not the order current quote version', {
      confirmed: String(confirmedVersion),
      current: String(quote.version),
    });
  }
}

/**
 * A quote, the confirmation that agreed to it, and the instant of the attempt.
 *
 * This type exists because the three were previously passed around separately,
 * which let a caller consult one and not the others — and because the
 * independent challenger measured exactly that: `assessQuoteDivergence` would
 * report `within_policy` over a quote that `assertQuoteConfirmable` refused at
 * the same `asOf`. A verdict that gates the automatic commit must be impossible
 * to obtain for a quote nobody may confirm, so the window, the version, the
 * order and the digest are now checked by the same call that produces it.
 */
export interface ConfirmedQuoteApproval {
  quote: CommercialQuote;
  confirmation: OrderQuoteConfirmationDto;
  /**
   * The instant the commit is attempted. A caller input, never a clock, so one
   * request's retries reach one verdict (see `assertQuoteConfirmable`).
   */
  asOf: string;
  /**
   * What is CHECKED about the quote but is not part of it — today, the
   * per-stock-key unit precision the representability law needs. It rides on
   * the approval so the hand-off can supply the same map it validated the
   * basket with, rather than the gate silently not claiming that law.
   */
  checks?: CommercialQuoteChecks;
  /**
   * The total the canonical sales authority recomputed on a PREVIOUS refused
   * attempt, when there was one.
   *
   * Phase 6 cannot recompute the authoritative total — that is the whole point
   * of §27 — so divergence can only be measured against a figure the authority
   * returned. Carrying it here is what lets the hand-off itself refuse a second
   * attempt at a total the shopper never agreed to, instead of rebuilding the
   * same intent and letting the boundary refuse it again.
   */
  priorRecomputedTotalMinor?: string;
}

/**
 * The text a confirmation must carry for the quote's expiry.
 *
 * The domain says `expiresAt: string | null`; `I6a.2`'s seven-column foreign key
 * cannot, because a null inside a composite key under the default `MATCH SIMPLE`
 * skips the whole key — MEASURED on PostgreSQL 16.15. So the relation stores
 * `'infinity'` for "no expiry", and this function is the ONE place the domain's
 * `null` and the relation's `NO_QUOTE_EXPIRY` are mapped onto each other. A
 * second mapping written at a call site is how the two representations drift.
 */
export function quoteExpiryText(quote: CommercialQuote): string {
  return quote.expiresAt ?? NO_QUOTE_EXPIRY;
}

/**
 * Refuse an approval that is not an approval OF THIS ORDER'S CURRENT QUOTE.
 *
 * This is the in-process twin of `I6a.2`: the seven-column foreign key makes a
 * confirmation that disagrees with its quote UNREPRESENTABLE in the relation,
 * and these five comparisons make it unusable in the domain. Both exist because
 * either alone can be bypassed — the relation is not consulted by a pure
 * function, and a check in a function is not consulted by an `INSERT`.
 */
export function assertQuoteApproved(approval: ConfirmedQuoteApproval, orderId: string, checks?: CommercialQuoteChecks): void {
  assertCanonicalId(orderId, 'orderId');
  // The presence of the approval is checked at RUNTIME, not only by the type.
  // A required field is a type-level law, and a type-level law reds the
  // typecheck while leaving the suite green — so a JavaScript caller, or a
  // caller holding an `as` cast, would reach the rest of this function and
  // crash on a property of `undefined` instead of being refused.
  if (approval === null || typeof approval !== 'object' || typeof approval.quote !== 'object' || typeof approval.confirmation !== 'object') {
    throw new OrderError('order.quote_not_approved', 'a checkout carries the quote the shopper confirmed; there is no unapproved path');
  }
  const { quote, confirmation } = approval;
  assertCanonicalId(confirmation.confirmationId, 'confirmationId');

  if (quote.orderId !== orderId) {
    throw new OrderError('order.quote_not_approved', 'the quote belongs to another order', { orderId, quoteOrderId: quote.orderId });
  }
  if (confirmation.orderId !== orderId) {
    throw new OrderError('order.quote_not_approved', 'the confirmation names another order', { orderId, confirmedOrderId: confirmation.orderId });
  }
  // Nullable means MAY BE ABSENT, not may be anything: `null` is the shopper
  // confirming on the storefront, and a non-null value names a member of staff
  // who confirmed on their behalf — so it is an id or it is nothing.
  if (confirmation.confirmedByUserId !== null) assertCanonicalId(confirmation.confirmedByUserId, 'confirmedByUserId');
  if (confirmation.quoteId !== quote.quoteId) {
    throw new OrderError('order.quote_not_approved', 'the confirmation names another quote', {
      quoteId: quote.quoteId,
      confirmedQuoteId: confirmation.quoteId,
    });
  }
  if (confirmation.confirmedQuoteDigest !== quote.digest) {
    throw new OrderError('order.quote_not_approved', 'the confirmation agreed to different bytes than the quote it names', {
      quoteId: quote.quoteId,
      confirmedDigest: confirmation.confirmedQuoteDigest,
    });
  }
  if (confirmation.confirmedQuoteExpiresAt !== quoteExpiryText(quote)) {
    throw new OrderError('order.quote_not_approved', 'the confirmation saw a different expiry than the quote states', {
      quoteId: quote.quoteId,
      confirmedExpiresAt: confirmation.confirmedQuoteExpiresAt,
      expiresAt: quoteExpiryText(quote),
    });
  }

  // `confirmedAt` — the instant the shopper AGREED — was previously validated
  // and compared nowhere in this package. The DTO's own doc said it must fall
  // strictly before the quote's expiry, and the field was read by nothing: the
  // challenger stored a confirmation dated thirteen hours after the window shut
  // and had it approved, along with `''`, `'not-a-date'`,
  // `'2026-13-45T99:99:99Z'`, a bare `'2026-10-01'`, and one dated 2020, before
  // the quote existed. `c_half_open_window_ck` does enforce it in the relation —
  // measured, strictly, infinity included — but this function exists precisely
  // because a pure function does not consult the relation.
  //
  // Three laws, in the order a reader would ask them:
  if (!isCanonicalInstant(confirmation.confirmedAt)) {
    throw new OrderError('order.occurred_at_invalid', 'confirmedAt must be a canonical RFC3339 UTC instant at second precision', {
      confirmationId: confirmation.confirmationId,
      stated: confirmation.confirmedAt,
    });
  }
  if (compareCanonical(confirmation.confirmedAt, quote.issuedAt) < 0) {
    throw new OrderError('order.quote_expiry_invalid', 'a confirmation cannot predate the instant its quote was issued', {
      confirmedAt: confirmation.confirmedAt,
      issuedAt: quote.issuedAt,
    });
  }
  // HALF-OPEN, written as `>=` so equality is admitted by nothing: a
  // confirmation AT the expiry instant is outside the window, exactly as
  // `asOf === expiresAt` is (PART 34, `I6.4a`). A quote with no expiry is open
  // at every instant — `'infinity'` is the relation's spelling of this same
  // sentence, and `quoteExpiryText` is where the two meet.
  if (quote.expiresAt !== null && compareCanonical(confirmation.confirmedAt, quote.expiresAt) >= 0) {
    throw new OrderError('order.quote_expired', 'the confirmation was recorded at or after the instant the quote expired', {
      confirmationId: confirmation.confirmationId,
      confirmedAt: confirmation.confirmedAt,
      expiresAt: quote.expiresAt,
    });
  }

  // The window and the version, last, so a mismatch of IDENTITY is reported as
  // one rather than as a stale version of a quote that was never this order's.
  // PRECEDENCE, and it is a law rather than a convenience: the EXPLICIT
  // argument wins over `approval.checks`. A caller that names the precisions at
  // the call site is the one holding the products, and the approval travelled
  // with the quote. Where the two disagree the call site decides, so an
  // approval cannot weaken a check its caller stated. The fallback exists only
  // for a caller that has no precisions of its own (`assessQuoteDivergence`),
  // and the direction is proved by a case in which the two disagree — a
  // precedence with no such case is a comment, not a law.
  assertQuoteConfirmable(quote, approval.asOf, confirmation.confirmedVersion, checks ?? approval.checks);
}

/** The verdict on comparing the canonical recomputation against the confirmed quote. */
export type QuoteDivergenceVerdict =
  | { status: 'within_policy'; differenceMinor: string }
  | { status: 'requires_reconfirmation'; quotedTotalMinor: string; recomputedTotalMinor: string; differenceMinor: string };

/**
 * The Phase 6 v1 divergence policy, set by Directive #11 PART 33:
 * **EXACTLY ZERO MINOR UNITS.**
 *
 * Any difference at all between the total the shopper confirmed and the total
 * the canonical sale recomputes requires explicit re-confirmation. One minor
 * unit more is overcharging; one minor unit less is not the transaction that
 * was agreed either.
 *
 * This is a CONSTANT and not a parameter on purpose. A tolerance is a
 * commercial policy, and while no such policy exists the only safe shape is one
 * that no caller can widen — a function taking a tolerance can be passed a
 * non-zero one by any future caller, with nothing going red. When a later
 * explicit commercial policy supplies a figure, it arrives here, with its own
 * authority named, and the tests below change with it.
 *
 * (This closes `OD-P6-06`, which this preparation had raised to the owner with
 * `"0"` recommended. The owner's ruling is the recommended value, so the value
 * stops being a caller's input at all.)
 */
export const P6_V1_QUOTE_DIVERGENCE_TOLERANCE_MINOR = '0';

/**
 * Compare what the sale command recomputed against what the shopper confirmed.
 *
 * There is no tolerance argument: see `P6_V1_QUOTE_DIVERGENCE_TOLERANCE_MINOR`.
 *
 * The difference is ABSOLUTE: a recomputation that came out LOWER than the quote
 * also requires re-confirmation. Charging less than the shopper agreed to is
 * still not the transaction they agreed to, and a one-sided comparison is how a
 * discount bug ships as a feature.
 */
export function assessQuoteDivergence(approval: ConfirmedQuoteApproval, orderId: string, recomputedTotalMinor: string): QuoteDivergenceVerdict {
  // Not `assertQuoteIntact` alone: the whole approval, so no verdict at all
  // exists for an expired, superseded or foreign quote.
  // No `approval.checks` read here: a malformed approval must reach the
  // presence guard inside `assertQuoteApproved` as a refusal, not as a
  // TypeError. That function falls back to its own `approval.checks` once the
  // shape is proved.
  assertQuoteApproved(approval, orderId);
  const quote = approval.quote;
  const recomputed = requireMinor(recomputedTotalMinor, 'recomputedTotalMinor');
  const tolerance = requireMinor(P6_V1_QUOTE_DIVERGENCE_TOLERANCE_MINOR, 'P6_V1_QUOTE_DIVERGENCE_TOLERANCE_MINOR');
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

/**
 * The refusal, as a refusal.
 *
 * `assessQuoteDivergence` returns a verdict because a caller may want to report
 * the two figures; the checkout hand-off wants the commit STOPPED, and a verdict
 * a caller can ignore is how PART 33's zero tolerance ends up guarding nothing.
 */
export function assertCommitWithinConfirmedQuote(approval: ConfirmedQuoteApproval, orderId: string, recomputedTotalMinor: string): void {
  const verdict = assessQuoteDivergence(approval, orderId, recomputedTotalMinor);
  if (verdict.status === 'requires_reconfirmation') {
    throw new OrderError(
      'order.quote_requires_reconfirmation',
      'the recomputed total diverges from the confirmed quote, so an explicit re-confirmation is required',
      {
        quotedTotalMinor: verdict.quotedTotalMinor,
        recomputedTotalMinor: verdict.recomputedTotalMinor,
        differenceMinor: verdict.differenceMinor,
        toleranceMinor: P6_V1_QUOTE_DIVERGENCE_TOLERANCE_MINOR,
      },
    );
  }
}
