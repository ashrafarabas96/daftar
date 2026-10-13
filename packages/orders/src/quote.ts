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
 * **This module still does not PRICE a line.** The unit price, the discount and
 * the line total remain the pricing authority's figures, carried verbatim into
 * the quote and into its digest. What changed on 2026-10-12 is that the owner
 * settled the rounding question the earlier note left open — per line, half to
 * even, one rounding after the quantity and the approved discounts — so a
 * carried line total now has exactly one lawful value and this module CHECKS it
 * (`assertLineTotalRounded`, `line-rounding.ts`) instead of accepting any
 * figure that happens to sum. The arithmetic of that check is exact integer
 * arithmetic on `bigint` minor units and ten-thousandths of a quantity; the
 * rounding mode is not invented here but imported from the one the project
 * already accepted (`packages/inventory/src/rounding.ts:29`). Checking a figure
 * against the project's own rule is not a second money truth; silently
 * displaying a figure that disagrees with it, and leaving the sale command's
 * recomputation to discover the disagreement after the shopper has confirmed,
 * is the price surprise §27 exists to prevent.
 */
import { createHash } from 'node:crypto';
import { CarrierFault, assertNotProxyCarrier, assertReadableArray, assertReadableCarrier, requireStringLeaf, snapshotFields } from './carrier';
import { assertQuantityRepresentable, formatQuantity, parseQuantity } from '@daftar/inventory';
import { stockKeyOf } from './cart';
import { NO_QUOTE_EXPIRY, type OrderQuoteConfirmationDto } from './contracts';
import { OrderError, assertCanonicalId, type OrderErrorCode } from './errors';
import { compareCanonical, isCanonicalInstant } from './instant';
import { assertLineTotalRounded } from './line-rounding';
import { type UnitPrecisionDeclaration, requireUnitPrecision } from './unit-precision';

/** Non-negative integer minor units as a decimal string. A shape check, so a float, a sign or padding cannot pass. */
const NON_NEGATIVE_MINOR = /^(0|[1-9]\d*)$/;

/**
 * Refuse a leaf that is not a string, under the code the FIELD owns.
 *
 * `B-2`, from the coordinator's diff review of `3f56c62`: `RegExp#test` and
 * `BigInt` stringify their argument, so `new String('3799')`, `{ toString() {…} }`
 * and `['3799']` passed every amount, instant and currency check and produced an
 * IDENTICAL digest — measured, with the `toString` case leaving a bare `{}` in
 * the carrier where an amount belonged. The builder then copied the leaf by
 * reference and froze only the top level, so the caller kept the object and
 * could rewrite it after the digest. A type check before the pattern is the only
 * place this can be closed, because after the pattern there is nothing left to
 * check: the thing that matched was a string the runtime invented.
 *
 * The CODE is the field's own, not a generic shape code, because the subject of
 * a refusal is what the caller has to fix.
 */
function requireStringField(value: unknown, field: string, code: OrderErrorCode, message: string): string {
  try {
    return requireStringLeaf(value, field);
  } catch (error) {
    if (!(error instanceof CarrierFault)) throw error;
    throw new OrderError(code, message, { field, carrier: 'not-primitive' });
  }
}

function requireMinor(value: string, field: string): bigint {
  requireStringField(value, field, 'order.quote_amount_invalid', 'an amount must be a string of integer minor units, not an object a regex would stringify');
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
function requireQuoteQuantity(line: QuoteLineSnapshot, declaration: UnitPrecisionDeclaration | undefined): bigint {
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
  if (declaration !== undefined) {
    // The PRECISION is checked before the quantity is checked against it, and
    // under its own code. A caller-supplied precision that is not an integer in
    // 0..4 is a defect in the CALLER's figure, not in the shopper's quantity;
    // relabelling it `order.quote_quantity_invalid` told a client to ask the
    // shopper to fix a number the shopper never wrote (round-5 challenge P3).
    // The whole law, including which products may declare no precision at all,
    // lives in `unit-precision.ts` and is not restated here.
    const unitDecimals = requireUnitPrecision(declaration, { stockKey: line.stockKey });
    if (unitDecimals === null) {
      // A precision-free product's quantity is bounded by the storage scale
      // alone, and `parseQuantity` above has already applied it. The law is not
      // claimed where the catalogue states none to claim it against.
      return q4;
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
 * The fields the canonical stream above covers, written out beside it.
 *
 * Round 10's F-34 is why these exist. `buildCommercialQuote` returned
 * `{ ...input, lines, digest }` while the stream is a hand-written field list,
 * so a field a caller added to the input RODE ONTO the returned quote outside
 * the digest — and `assertQuoteIntact` then answered "untampered" after that
 * field had been rewritten from `'5'` to `'500000'`. I reproduced it, and it is
 * WIDER than the report: it holds for a LINE's extra field too, which the
 * challenger measured only at the top level.
 *
 * TypeScript refuses an extra property on an object LITERAL (`TS2353`) but not
 * on a spread variable, which is exactly how an application tier assembles an
 * input — so the type system was never the guard here, and this package's own
 * law is that a type-only requirement has no runtime existence.
 *
 * These two arrays and the stream must be edited together. A field added to the
 * stream and not here is stripped from the carrier; a field added here and not
 * to the stream rides again. The case
 * "the digested stream and the carried fields are THE SAME SET" asserts the
 * agreement rather than trusting this comment.
 */
const CANONICAL_QUOTE_FIELDS: readonly (keyof CommercialQuoteInput)[] = Object.freeze([
  'quoteId',
  'orderId',
  'version',
  'currency',
  'lines',
  'displayedTotalMinor',
  'issuedAt',
  'expiresAt',
]);
const CANONICAL_LINE_FIELDS: readonly (keyof QuoteLineSnapshot)[] = Object.freeze([
  'stockKey',
  'productId',
  'variantId',
  'quantity',
  'unitPriceMinor',
  'discountMinor',
  'lineTotalMinor',
]);

/**
 * Every key an object carries ITSELF that the allow-list does not cover —
 * `Reflect.ownKeys`, not `Object.keys`.
 *
 * The independent challenger handed me this before round 11 and I measured it
 * on the built package: with `Object.keys`, an undeclared field reaches a quote
 * three ways the check could not see — on the PROTOTYPE, as an own
 * NON-ENUMERABLE property, or through a class ACCESSOR — and each stayed
 * readable as `'5'` while `assertQuoteIntact` answered ACCEPTED. The line level
 * bit the same way, which the report did not cover. The coordinator ruled it a
 * FAIL-OPEN of the guard F-34 exists for: an "untampered" verdict for bytes
 * nobody attested to is the whole defect, whatever the money impact.
 *
 * `Reflect.ownKeys` closes the own half — non-enumerable properties AND SYMBOL
 * keys, which neither review had listed. The prototype half cannot be closed by
 * listing keys at all, because the field is not the object's own; that is what
 * `assertPlainCarrier` is for.
 */
/**
 * The fields a confirmation carries, as a LIST, so the snapshot of it is taken
 * over something a reader can check against `OrderQuoteConfirmationDto` rather
 * than over whatever keys the caller's object happens to have.
 */
const CONFIRMATION_FIELDS: readonly string[] = Object.freeze([
  'confirmationId',
  'quoteId',
  'orderId',
  'confirmedVersion',
  'confirmedAt',
  'confirmedQuoteDigest',
  'confirmedQuoteExpiresAt',
  'confirmedByUserId',
]);

function undeclaredKeys(carrier: object, allowed: ReadonlySet<string>): string[] {
  return Reflect.ownKeys(carrier)
    .filter((key) => typeof key !== 'string' || !allowed.has(key))
    .map((key) => String(key))
    .sort();
}

/**
 * Refuse a PROXY, at every level.
 *
 * The challenger's `F-41`, ruled blocking by the coordinator: a Proxy forwards
 * `getPrototypeOf`, `isArray` and `ownKeys` to its target, so it passes every
 * structural check here and a `get` trap can still answer an undeclared field —
 * readable, through `assertQuoteIntact` and `assertQuoteApproved`. It is the
 * same fail-open as `F-34` and `F-40`, one indirection out.
 *
 * WHY `node:util`'s `types.isProxy` AND NOT A DEEP COPY. Two remedies were on
 * the table. A deep copy would have to be built before any check and compared
 * against the original, which means this package would carry its own structural
 * equality for a quote — a second definition of what a quote IS, beside the
 * canonical stream, to be kept in step with it forever. That is the "second
 * money truth" shape this phase refuses elsewhere. `types.isProxy` asks the
 * runtime the question directly and cannot drift. The package already depends on
 * Node built-ins (`node:crypto` for the digest), so the runtime requirement is
 * not new, and `packages/orders` is a server-side library — it is not bundled
 * for a browser.
 *
 * It is also the honest one: it answers the question that was asked (is this
 * object a Proxy?) rather than answering a different question well.
 */
function assertNotProxy(carrier: object, subject: string, lineIndex: number | null): void {
  try {
    assertNotProxyCarrier(carrier);
  } catch (error) {
    if (!(error instanceof CarrierFault)) throw error;
    throw new OrderError('order.quote_field_undeclared', `${subject} is a Proxy, which can answer for a field that is in no byte of the digest`, {
      ...(lineIndex === null ? {} : { lineIndex: String(lineIndex) }),
      carrier: 'proxy',
    });
  }
}

/**
 * Refuse a carrier whose prototype is not `Object.prototype`.
 *
 * A class instance, or any object whose prototype carries data, can answer for
 * a field that is nowhere in its own keys: `Reflect.ownKeys` cannot see it, and
 * a getter can return anything on each read. So the carrier's prototype is
 * checked as well as its keys.
 *
 * WHAT THIS CHECK CANNOT SEE, AND WHO SEES IT INSTEAD. A **Proxy** over a plain
 * object forwards both `getPrototypeOf` and `ownKeys` to its target, so it
 * passes this check and the key list alike and can still answer an undeclared
 * field from a `get` trap. Measured at `7902cc0` (challenger `F-41`). Nothing a
 * key list or a prototype comparison can do detects that — a Proxy is designed
 * to be transparent — so it is refused by a DIFFERENT kind of check:
 * `assertNotProxy` runs first in this function and asks the runtime itself,
 * through `node:util`'s `types.isProxy`. An earlier revision of this comment
 * said a Proxy "is NOT claimed to be closed"; that sentence was true when it was
 * written and became false three functions above it, and the challenger's `R-25`
 * round caught it still standing here.
 *
 * One property of that choice worth stating, since it was not the reason for it:
 * `types.isProxy` is not realm-sensitive, while the `Object.prototype`
 * comparison below is, so the cross-realm Proxy is caught too — measured by the
 * challenger at `3f56c62`.
 *
 * AND THE CLOSING REBUILD IS NOT CREDITED HERE, which an earlier revision of
 * this paragraph did. The rebuild RE-READS the carrier, and a field that answers
 * twice is precisely what exploits a second read: the coordinator's `B-1`
 * measured six such threats, one of which got an unconfirmed quote approved
 * through the very comparison the rebuild was supposed to protect. A re-read is
 * not a defence against a value that changes between reads. What closes that is
 * the ACCESSOR REFUSAL in `assertPlainCarrier`, plus every gate returning a
 * frozen snapshot that callers read instead of the caller's object.
 *
 * WHAT THIS COSTS, stated rather than discovered: an `Object.create(null)`
 * carrier is refused too, as is an ORM entity or any class instance. `JSON.parse`
 * yields `Object.prototype` **in the same realm**, so the ordinary storage path —
 * read the row, parse or project it, hand it in — is unaffected; a CROSS-REALM
 * plain object (`vm.runInNewContext`, a worker) has a different
 * `Object.prototype` and IS refused, with `prototype: 'not Object.prototype'`
 * (challenger `F-42`, measured). A layer that materialises rows into CLASS
 * INSTANCES, or that parses them in another realm, must project to a plain
 * object in this one, which is the same obligation
 * `P6-INTEGRATION-PATCH-REQUEST.md` §6 already states for a row that carries its
 * own columns.
 *
 * WHY THIS IS NOT MERELY DEFENCE IN DEPTH ON THE INPUT PATH. A quote the builder
 * produced cannot carry either shape — `{ ...carrier }` copies own enumerable
 * properties only, measured: a prototype field and a non-enumerable field each
 * come out `undefined` with the digest unchanged. The reachable path is a carrier
 * the CALLER builds and hands straight to `assertQuoteIntact`. The input path is
 * guarded to the same standard anyway, because a field this package would
 * silently drop is exactly the thing `R-16` was about.
 */
function assertPlainCarrier(carrier: object, subject: string, lineIndex: number | null): void {
  const at: Record<string, string> = lineIndex === null ? {} : { lineIndex: String(lineIndex) };
  try {
    assertReadableCarrier(carrier);
  } catch (error) {
    if (!(error instanceof CarrierFault)) throw error;
    if (error.kind === 'proxy') {
      throw new OrderError('order.quote_field_undeclared', `${subject} is a Proxy, which can answer for a field that is in no byte of the digest`, {
        ...at,
        carrier: 'proxy',
      });
    }
    // The ACCESSOR arm is the `B-1` family: a getter answers the CHECK with one
    // value and the USE with another, so six gates accepted a quote and then
    // emitted figures no confirmed quote carried. It is refused by name, and
    // before the digest, because an accessor over a DIGESTED field would make
    // the digest itself a statement about whichever read happened first.
    if (error.kind === 'accessor') {
      throw new OrderError(
        'order.quote_field_undeclared',
        `${subject} answers a field from an accessor, so the value that was checked need not be the value that is used`,
        { ...at, carrier: 'accessor', fields: error.field ?? '' },
      );
    }
    throw new OrderError(
      'order.quote_field_undeclared',
      `${subject} is not a plain object, so a field it answers for need not be among its own keys and nothing can attest to it`,
      { ...at, prototype: error.kind === 'null-prototype' ? 'null' : 'not Object.prototype' },
    );
  }
}

/**
 * Refuse a `lines` CONTAINER that is anything but a plain array of its lines.
 *
 * The challenger's `F-40`, and it was a P1 fail-open one container up. The quote
 * was guarded and each LINE was guarded; the array BETWEEN them was neither
 * key-checked nor shape-checked, so every one of these answered an undeclared
 * field while `assertQuoteIntact` said ACCEPTED and the field read back as
 * `'500000'` — measured at `7902cc0`:
 *
 *   - `Object.assign([...lines], { documentFeeMinor: '500000' })`
 *   - the same field defined NON-ENUMERABLE on the array
 *   - an Array SUBCLASS with a getter on its prototype
 *   - a non-array object carrying `length`, `entries`, `map` and
 *     `Symbol.iterator` — `Array.isArray` was asserted on the INPUT path only,
 *     so a hand-built quote could hand in any iterable
 *
 * So the container is held to the same standard as the things on either side of
 * it: it is an array, its prototype is `Array.prototype`, and its own keys are
 * nothing but the index keys and `length`. An extra key is NAMED, like any other
 * undeclared field.
 *
 * `length` is accepted because an array cannot exist without it, and index keys
 * are accepted by POSITION rather than by count, so a sparse or out-of-order
 * array is refused rather than silently read.
 *
 * A PROXY over a lawful array forwards `isArray`, `getPrototypeOf` and
 * `ownKeys`, so nothing in the paragraph above can see one — and it is REFUSED
 * anyway, because `assertReadableArray` asks the runtime through
 * `node:util`'s `types.isProxy` before it looks at a single key. This comment
 * used to end "and is NOT detected here", which was true when it was written
 * and was made false by the guard two files away; it is the third of the three
 * places the coordinator's `R-23` found, and it outlived the first round of
 * that remedy because I corrected the two the review quoted and did not
 * re-read the third against the code.
 */
function assertPlainLineArray(lines: unknown, subject: string): readonly QuoteLineSnapshot[] {
  const refuse = (reason: string, detail?: Record<string, string>): never => {
    throw new OrderError('order.quote_field_undeclared', `${subject} lines container ${reason}, so nothing can attest to what it carries`, {
      container: reason,
      ...detail,
    });
  };
  // One definition, in `carrier.ts`, mapped here onto this package's own
  // wording: the container guard is the same discipline the positions in
  // `checkout-intent.ts` now need, and two copies of it would drift.
  let array: readonly unknown[];
  try {
    array = assertReadableArray(lines);
  } catch (error) {
    if (!(error instanceof CarrierFault)) throw error;
    if (error.kind === 'proxy') assertNotProxy(new Proxy({}, {}), `${subject} lines container`, null);
    if (error.kind === 'not-array') refuse('is not an array');
    if (error.kind === 'prototype') refuse('is not a plain array');
    if (error.kind === 'undeclared') refuse('carries keys that are not its own indices', { fields: error.field ?? '' });
    // An accessor INDEX is the `B-1` family at the container level: the element
    // the gate walked need not be the element the caller later hands on.
    if (error.kind === 'accessor') refuse('answers an index from an accessor', { fields: error.field ?? '' });
    // Positions are judged by PRESENCE, so a SPARSE array — whose holes are not
    // own keys at all — is refused rather than walked with `undefined` lines.
    if (error.kind === 'sparse') refuse('is sparse', { missingIndex: error.field ?? '' });
    throw error;
  }
  return array as readonly QuoteLineSnapshot[];
}

/** The input reduced to exactly the fields the digest covers, lines included. */
function canonicalCarrier(input: CommercialQuoteInput): CommercialQuoteInput {
  // `[...input.lines]` first, NOT `input.lines.map(...)`. `Array.prototype.map`
  // honours `Symbol.species`, so mapping an Array SUBCLASS returns an instance
  // of that subclass — and the builder's own output would then carry whatever
  // the subclass's prototype answers for, readable, outside the digest, with
  // both gates still accepting it (challenger `F-45`, ruled blocking). The
  // input guard refuses such an input before this line is reached, measured, so
  // this is the second layer; it is here because the sentence this function's
  // header makes about its own output should be true of THIS function and not
  // only true because something upstream checked.
  // Copied field by field THROUGH `snapshotFields`, which refuses a leaf that is
  // not a primitive. Two things follow: the copy cannot share a mutable leaf
  // with the caller, and the returned quote is therefore frozen ALL THE WAY
  // DOWN rather than only at the top. A leaf shared with the caller is a leaf
  // the caller can still change after the digest is taken — `Object.freeze` is
  // shallow and says nothing about what a field POINTS AT. MEASURED by the
  // coordinator at `3f56c62` (`P6-COORD-B2-FREEZE-RECHECK-3f56c62.md`): a boxed
  // `String` currency carrying a `documentFeeMinor` property was held by
  // reference, stayed unfrozen, and the property was rewritten to `999999999`
  // after the digest while both gates still answered ACCEPTED.
  //
  // The recheck's own conclusion is carried here rather than improved upon: the
  // shallow freeze is NOT a separate defect. It can only matter while a leaf is
  // an object, and a leaf can only be an object because the leaves were not
  // type-checked. With the `typeof` checks above in place the existing freeze is
  // deep in effect, because no object leaf is left to reach. This copy is the
  // structural layer that keeps that true for a field added later without a
  // check; it is not claimed to close anything on its own. The leaf checks in
  // the builder above refuse a
  // non-primitive field under its own domain code first; this is the layer that
  // keeps the guarantee true for a field added later without such a check.
  // A fault from the snapshot is MAPPED, never allowed to escape: an unmapped
  // `CarrierFault` would reach the caller as a crash with no subject, which is
  // the `R-C4` shape under a different name.
  const refuseCarrier = (error: unknown, lineIndex: number | null): never => {
    if (!(error instanceof CarrierFault)) throw error;
    throw new OrderError(
      'order.quote_field_undeclared',
      `a quote ${lineIndex === null ? 'carrier' : 'LINE'} cannot be copied as its own data: ${error.message}`,
      {
        ...(lineIndex === null ? {} : { lineIndex: String(lineIndex) }),
        carrier: error.kind,
        ...(error.field === null ? {} : { fields: error.field }),
      },
    );
  };
  const lines = [...input.lines].map((line, index) => {
    try {
      return snapshotFields<QuoteLineSnapshot>(line, CANONICAL_LINE_FIELDS);
    } catch (error) {
      return refuseCarrier(error, index);
    }
  });
  let kept: Record<string, unknown>;
  try {
    kept = snapshotFields<Record<string, unknown>>(input, CANONICAL_QUOTE_FIELDS, [], undefined, ['lines']);
  } catch (error) {
    return refuseCarrier(error, null);
  }
  const carrier: Record<string, unknown> = { ...kept, lines: Object.freeze(lines) };
  // The field ORDER of the canonical stream is `CANONICAL_QUOTE_FIELDS`, and the
  // digest is taken over that list rather than over this object's key order, so
  // rebuilding the object here cannot move a byte of the stream.
  return Object.freeze(carrier) as unknown as CommercialQuoteInput;
}

/**
 * Refuse an INPUT that carries a field the canonical stream does not cover.
 *
 * `canonicalCarrier` already keeps such a field off the returned quote, so
 * nothing can ride along unattested. But stripping is silent, and silence is
 * the wrong answer to the one case this package was asked about: a
 * DOCUMENT-LEVEL FEE. The pack claims a document-level fee is "fail-closed, not
 * silently dropped" (`ACC-REQ-P6-03`). With stripping alone that sentence was
 * false in one direction — a fee folded into `displayedTotalMinor` is refused
 * as `order.quote_total_mismatch`, but a fee sent as a FIELD was accepted and
 * quietly left out of the quote the shopper is shown. The coordinator's review
 * of `7834bfb` named it `R-16`.
 *
 * So the refusal happens at the INPUT, before anything is computed, and it
 * NAMES the field. A caller who sends `documentFeeMinor` learns that this
 * package does not price a document-level fee, instead of watching it vanish.
 * Phase 6 does not own fee policy; `ACC-REQ-P6-03` asks the Accounting
 * Authority for it, and until there is a ruling the fail-closed answer is to
 * refuse the field rather than to invent a treatment for it.
 *
 * This is strict about storage too, and deliberately: a layer that reads rows
 * with their own columns attached (`created_at`, a row id, `business_id`) must
 * project to the declared shape before calling in. That obligation is written
 * in `P6-INTEGRATION-PATCH-REQUEST.md` §6, and it fails closed.
 */
function assertCanonicalInput(input: CommercialQuoteInput): void {
  assertPlainCarrier(input, 'the quote input', null);
  const allowed = new Set<string>(CANONICAL_QUOTE_FIELDS as readonly string[]);
  const extra = undeclaredKeys(input, allowed);
  if (extra.length > 0) {
    throw new OrderError(
      'order.quote_field_undeclared',
      'the quote input carries a field this package does not price or digest; a document-level fee or any other amount must be ruled on by the Accounting Authority (ACC-REQ-P6-03) before it can be carried',
      {
        quoteId: String((input as { quoteId?: unknown }).quoteId),
        fields: extra.sort().join(','),
      },
    );
  }
  const allowedLine = new Set<string>(CANONICAL_LINE_FIELDS as readonly string[]);
  const lines = assertPlainLineArray(input.lines, 'the quote input');
  for (const [index, line] of lines.entries()) {
    // REFUSED, not skipped. `B-4(2)`, located by the coordinator and the
    // challenger together: this line read `if (line === null || typeof line !==
    // 'object') continue;`, and `typeof` a FUNCTION is `'function'`, so a
    // function object carrying `documentFeeMinor` walked past the per-line
    // guard, past the fee refusal, and the fee was SILENTLY DROPPED — which is
    // the exact thing `ACC-REQ-P6-03` and the pack claimed could not happen.
    // A skip is how a guard becomes a comment.
    if (line === null || (typeof line !== 'object' && typeof line !== 'function')) {
      throw new OrderError('order.quote_field_undeclared', 'a quote input LINE is not an object, so nothing it carries can be priced or digested', {
        lineIndex: String(index),
        carrier: line === null ? 'null' : typeof line,
      });
    }
    assertPlainCarrier(line, 'a quote input LINE', index);
    const extraLine = undeclaredKeys(line, allowedLine);
    if (extraLine.length > 0) {
      throw new OrderError('order.quote_field_undeclared', 'a quote input LINE carries a field this package does not price or digest', {
        quoteId: String((input as { quoteId?: unknown }).quoteId),
        lineIndex: String(index),
        fields: extraLine.sort().join(','),
      });
    }
  }
}

/**
 * Refuse a quote whose CARRIER is not the digested stream.
 *
 * The digest covers a field list; an object can carry more. A consumer reading
 * such a field off a quote has NO tamper evidence for it, while the quote's own
 * digest check answers "untampered" — which is worse than no evidence, because
 * the check was consulted and said yes. So an undeclared field is refused
 * rather than ignored, and the refusal names it — at the quote level, on each
 * LINE, and on the lines CONTAINER between them (`assertPlainLineArray`; the
 * container was unguarded until the challenger's `F-40`).
 *
 * A PROXY over a lawful carrier forwards `getPrototypeOf`, `isArray` and
 * `ownKeys`, so it passes every STRUCTURAL guard here and could answer an
 * undeclared field from a `get` trap. It is refused anyway, by asking the
 * runtime rather than the object: `assertNotProxy` (`types.isProxy`) runs over
 * the quote, over the lines container and over each line, and the refusal
 * carries `details.carrier = 'proxy'` (`F-41`, measured over eight Proxy shapes
 * at `3f56c62`, the revocable, trapless, cross-realm and Proxy-of-a-Proxy cases
 * among them). This paragraph previously said the opposite, having outlived the
 * check that closed it (`R-25`).
 *
 * This is deliberately strict about one thing in particular: a storage layer
 * that reads a quote back with its own columns attached (`created_at`, a row
 * id) must map to the declared shape before this function is reached. That is
 * the cost of the immutability claim being checkable, and it fails closed.
 */
function assertCanonicalCarrier(quote: CommercialQuote): void {
  assertPlainCarrier(quote, 'a quote', null);
  const allowed = new Set<string>([...CANONICAL_QUOTE_FIELDS, 'digest']);
  const extra = undeclaredKeys(quote, allowed);
  if (extra.length > 0) {
    throw new OrderError('order.quote_field_undeclared', 'a quote carries a field the canonical stream does not cover, so nothing attests to it', {
      quoteId: String(quote.quoteId),
      fields: extra.sort().join(','),
    });
  }
  const allowedLine = new Set<string>(CANONICAL_LINE_FIELDS);
  for (const [index, line] of assertPlainLineArray(quote.lines, 'a quote').entries()) {
    assertPlainCarrier(line, 'a quote LINE', index);
    const extraLine = undeclaredKeys(line, allowedLine);
    if (extraLine.length > 0) {
      throw new OrderError('order.quote_field_undeclared', 'a quote LINE carries a field the canonical stream does not cover, so nothing attests to it', {
        quoteId: String(quote.quoteId),
        lineIndex: String(index),
        fields: extraLine.sort().join(','),
      });
    }
  }
}

/**
 * What is CHECKED about a quote without being part of it.
 *
 * It is a second parameter rather than a field of the input on purpose: a
 * checking aid that lived on the input would either enter the canonical stream
 * or have to be excluded from it by hand, which is the kind of exception a
 * later author drops.
 *
 * This paragraph used to justify that by saying "the input is exactly what the
 * digest is taken over". That was NOT true, and round 10's F-34 was right to
 * name the sentence rather than only the behaviour: the digest is taken over a
 * hand-written field list, and the builder used to return the whole input
 * beside it. The decision was sound and its stated reason was not. As of this
 * commit the sentence is true in the only way that can be checked — the
 * builder returns exactly the digested fields and `assertQuoteIntact` refuses a
 * carrier that holds more (`order.quote_field_undeclared`) — and the reason
 * above no longer rests on the claim.
 */
export interface CommercialQuoteChecks {
  /**
   * Stock key → what the catalogue declares about that product's unit
   * precision. A key that is absent is not checked for representability — the
   * law is not claimed where the caller did not supply the declaration, rather
   * than being quietly assumed to be 4.
   *
   * A DECLARATION rather than a number: a product that does not track inventory
   * may lawfully carry no precision, and `null` inside a supplied declaration
   * means exactly that, while an absent KEY means the caller did not say. The
   * two are different and are kept different.
   */
  unitPrecisionByStockKey?: ReadonlyMap<string, UnitPrecisionDeclaration>;
}

/**
 * Build a quote snapshot, checking everything that can be checked without
 * inventing a pricing policy.
 */
export function buildCommercialQuote(input: CommercialQuoteInput, checks?: CommercialQuoteChecks): CommercialQuote {
  // R-16: an undeclared field is refused HERE, by name, before anything is
  // computed. `canonicalCarrier` below then keeps the carrier equal to the
  // digested stream even for a caller that reaches the builder another way
  // (`assertQuoteIntact` re-runs this function on a stored quote). Two layers,
  // because the first states the law to the caller and the second keeps the
  // claim true for a quote that was not built here.
  assertCanonicalInput(input);
  assertCanonicalId(input.quoteId, 'quoteId');
  assertCanonicalId(input.orderId, 'orderId');

  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new OrderError('order.quote_version_invalid', 'a quote version is an integer of at least 1');
  }
  // R-20, named rather than closed, and the limit is stated where a reader
  // meets it: this is a SHAPE check, so `XYZ` is accepted. The platform's
  // currency registry (`@daftar/domain-core`, `minorUnitsOf`, which throws for
  // an unsupported code) is not consulted, because `packages/orders` does not
  // depend on `@daftar/domain-core` and adding a workspace dependency
  // regenerates the ROOT lockfile, which belongs to the Repo Owner (PART 8).
  // `P6-INTEGRATION-PATCH-REQUEST.md` §7 asks for it, together with an FK from
  // `order_quotes.currency` to `currencies` so the database closes it too.
  //
  // What the gap can and cannot cost, measured rather than assumed: every
  // amount in this module already arrives in integer MINOR units, so the
  // rounding rule never consults an exponent and cannot default to a wrong one.
  // An unknown code therefore cannot move money here; it can only let an
  // unknown code be STORED on a quote. That is why this is a residual and not a
  // blocker, and why the suite carries an exponent-0 case (JPY) to pin that the
  // rule is exponent-agnostic.
  requireStringField(input.currency, 'currency', 'order.quote_amount_invalid', 'currency must be a string, not an object a regex would stringify');
  if (!/^[A-Z]{3}$/.test(input.currency)) {
    throw new OrderError('order.quote_amount_invalid', 'currency must be a three-letter uppercase code', { field: 'currency' });
  }
  requireStringField(input.issuedAt, 'issuedAt', 'order.occurred_at_invalid', 'issuedAt must be a string instant, not an object a regex would stringify');
  if (!isCanonicalInstant(input.issuedAt)) {
    throw new OrderError('order.occurred_at_invalid', 'issuedAt must be a canonical RFC3339 UTC instant at second precision');
  }
  if (input.expiresAt !== null) {
    requireStringField(input.expiresAt, 'expiresAt', 'order.occurred_at_invalid', 'expiresAt must be a string instant, not an object a regex would stringify');
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
    requireStringField(line.stockKey, 'stockKey', 'order.quote_stock_key_invalid', 'a stock key must be a string, not an object a comparison would stringify');
    requireStringField(line.quantity, 'quantity', 'order.quote_quantity_invalid', 'a quantity must be a string, not an object a regex would stringify');
    const canonicalKey = stockKeyOf(line);
    if (line.stockKey !== canonicalKey) {
      throw new OrderError('order.quote_stock_key_invalid', 'a quote line stock key is not the canonical key of its own product and variant', {
        stated: line.stockKey,
        expected: canonicalKey,
      });
    }
    const quantityQ4 = requireQuoteQuantity(line, checks?.unitPrecisionByStockKey?.get(canonicalKey));
    if (seen.has(line.stockKey)) {
      throw new OrderError('order.quote_line_duplicate', 'two quote lines name one stock key', { stockKey: line.stockKey });
    }
    seen.add(line.stockKey);
    const unitPriceMinor = requireMinor(line.unitPriceMinor, 'unitPriceMinor');
    const discountMinor = requireMinor(line.discountMinor, 'discountMinor');
    const lineTotalMinor = requireMinor(line.lineTotalMinor, 'lineTotalMinor');
    // The owner's per-line rounding rule, as a gate rather than a derivation:
    // the carried figure is still the pricing authority's, and it is refused
    // when it is not the one the project's own HALF_EVEN produces from the
    // quantity, the unit price and the discount this very line carries. The
    // quantity is already parsed and canonical by here, so this check cannot
    // be the one that reports a malformed quantity.
    assertLineTotalRounded(lineTotalMinor, quantityQ4, unitPriceMinor, discountMinor, { stockKey: canonicalKey });
    sum += lineTotalMinor;
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

  // The carrier is reduced to exactly the digested fields (F-34). Spreading the
  // input would hand back whatever else the caller had attached, with the
  // package's own digest beside it and nothing attesting to it.
  const carrier = canonicalCarrier(input);
  return Object.freeze({ ...carrier, digest: digestOf(carrier) });
}

/**
 * Recompute the digest and refuse a quote whose bytes no longer match it.
 *
 * This is the immutability claim made checkable. A quote stored in a relation
 * and later edited in place fails here, and `order.quote_tampered` says so
 * rather than the system carrying on with a snapshot that is no longer the one
 * the shopper confirmed.
 */
export function assertQuoteIntact(quote: CommercialQuote, checks?: CommercialQuoteChecks): CommercialQuote {
  // BEFORE the digest, because the digest's verdict is only as wide as the
  // fields it covers: a quote carrying an undeclared field gets "untampered"
  // for bytes nobody attested to (F-34).
  assertCanonicalCarrier(quote);
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
  const rebuilt: CommercialQuote = buildCommercialQuote(rest, checks);
  if (rebuilt.digest !== digest) {
    // Unreachable while the digest is a pure function of the fields: the bytes
    // were just proved to hash to `digest`. Stated as a refusal rather than
    // assumed, so a future change to the builder that alters the stream cannot
    // pass silently.
    throw new OrderError('order.quote_tampered', 'the quote rebuilt from its own fields does not reproduce its digest', { quoteId: quote.quoteId });
  }

  // THE VALIDATED SNAPSHOT, and the reason this function returns anything at
  // all (the coordinator's `B-1` remedy): a caller that goes back to its own
  // object after this gate has checked nothing it then uses. `rebuilt` came out
  // of the builder, so it is a fresh deep-frozen copy whose every leaf is a
  // primitive — nothing the caller still holds can change a byte of it. Callers
  // inside this package read ONLY what the gate returns; a caller outside it is
  // handed the same snapshot rather than being trusted to re-read safely.
  return rebuilt;
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
export function assertQuoteConfirmable(quote: CommercialQuote, asOf: string, confirmedVersion: number, checks?: CommercialQuoteChecks): CommercialQuote {
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
  // EVERY read below is off `snapshot`, never off `quote` again: an `expiresAt`
  // accessor answered this function's expiry comparison with a future instant
  // and the rest of the system with the real one (`B-1` T4). The accessor is
  // refused outright now, and reading only the snapshot is the property that
  // does not depend on that refusal staying complete.
  const snapshot = assertQuoteIntact(quote, checks);
  if (!isCanonicalInstant(asOf)) {
    throw new OrderError('order.occurred_at_invalid', 'asOf must be a canonical RFC3339 UTC instant at second precision');
  }
  if (compareCanonical(asOf, snapshot.issuedAt) < 0) {
    throw new OrderError('order.quote_expiry_invalid', 'asOf precedes the instant the quote was issued');
  }
  if (snapshot.expiresAt !== null && compareCanonical(asOf, snapshot.expiresAt) >= 0) {
    throw new OrderError('order.quote_expired', 'the quote has expired and must be re-issued before it is confirmed', { quoteId: snapshot.quoteId });
  }
  if (confirmedVersion !== snapshot.version) {
    throw new OrderError('order.quote_version_stale', 'the confirmed version is not the order current quote version', {
      confirmed: String(confirmedVersion),
      current: String(snapshot.version),
    });
  }
  return snapshot;
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
  // GATED, because this function's OUTPUT is what a confirmation row carries,
  // and it was the one exported reader of a quote field with no gate of its own
  // (the challenger's `R-25`, routed by the coordinator). It is not a fail-open
  // — nothing in this package reaches it ungated, and `I6a.2`'s seven-column
  // foreign key makes a disagreeing confirmation unrepresentable — but an
  // exported function that reads a quote and is trusted to have read the real
  // one is a defence that depends on its callers, and this package has already
  // paid for that shape twice.
  //
  // WHAT THE GATE BUYS, stated exactly rather than as "now closed": it refuses
  // a quote edited in place after its bytes were digested, a quote carrying an
  // undeclared field, a Proxy or a tampered lines container, and a quote whose
  // content the builder would not produce. WHAT IT DOES NOT BUY: a wholly
  // fabricated, self-consistent quote still passes, because `canonicalQuoteBytes`
  // is exported and any self-consistent object carries a valid digest — the
  // same limit recorded on `assertQuoteIntact` above. That one is closed by the
  // relation, not here.
  // The mapping reads the GATE'S SNAPSHOT, not the argument: the gate having
  // accepted the caller's object is not a reason to read that object again.
  return expiryTextOf(assertQuoteIntact(quote));
}

/**
 * The mapping itself, for callers that have ALREADY gated this quote.
 *
 * Not exported: the mapping stays single-sited (a second mapping written at a
 * call site is how the two representations drift), while the gate is not paid
 * twice inside one function that has already run it.
 */
function expiryTextOf(quote: CommercialQuote): string {
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
export function assertQuoteApproved(approval: ConfirmedQuoteApproval, orderId: string, checks?: CommercialQuoteChecks): ConfirmedQuoteApproval {
  assertCanonicalId(orderId, 'orderId');
  // The presence of the approval is checked at RUNTIME, not only by the type.
  // A required field is a type-level law, and a type-level law reds the
  // typecheck while leaving the suite green — so a JavaScript caller, or a
  // caller holding an `as` cast, would reach the rest of this function and
  // crash on a property of `undefined` instead of being refused.
  // `typeof null === 'object'`, so the first two members of this guard used to
  // admit `{ quote: null }` and `{ confirmation: null }` and the function then
  // raised a `TypeError` on a property of `null` — the very crash the comment
  // above says it prevents. Measured by the coordinator's diff review at
  // `b3719c0` (R-09). It failed closed, under the wrong subject and the wrong
  // error class; a caller cannot act on a `TypeError`.
  if (
    approval === null ||
    typeof approval !== 'object' ||
    approval.quote === null ||
    approval.confirmation === null ||
    typeof approval.quote !== 'object' ||
    typeof approval.confirmation !== 'object'
  ) {
    throw new OrderError('order.quote_not_approved', 'a checkout carries the quote the shopper confirmed; there is no unapproved path');
  }
  // THE APPROVAL ITSELF is read as its own data before anything is taken off
  // it: an accessor on `approval.quote` answered this gate with a lawful quote
  // and the intent builder with another one on its fourth read (`B-1` T1).
  try {
    assertReadableCarrier(approval);
  } catch (error) {
    if (!(error instanceof CarrierFault)) throw error;
    throw new OrderError(
      'order.quote_not_approved',
      'an approval must be plain own data; a Proxy or an accessor can answer the check and the use differently',
      {
        carrier: error.kind,
        ...(error.field === null ? {} : { fields: error.field }),
      },
    );
  }
  // The CONFIRMATION is snapshotted, so every comparison below reads a frozen
  // primitive copy rather than the caller's object. A `confirmedQuoteDigest`
  // accessor is what got an unconfirmed quote approved (`B-1` T3).
  let confirmation: OrderQuoteConfirmationDto;
  try {
    confirmation = snapshotFields<OrderQuoteConfirmationDto>(approval.confirmation, CONFIRMATION_FIELDS);
  } catch (error) {
    if (!(error instanceof CarrierFault)) throw error;
    throw new OrderError(
      'order.quote_not_approved',
      'a confirmation must be plain own data covering exactly the confirmation contract; nothing else is attested to',
      { carrier: error.kind, ...(error.field === null ? {} : { fields: error.field }) },
    );
  }
  // The QUOTE is gated FIRST, before any field of it is compared. The previous
  // order compared the digest at the top and re-established integrity only at
  // the end, so a quote whose bytes did not match its own digest was measured
  // against the confirmation before anything had established that the bytes
  // were the ones the digest covers.
  const quote = assertQuoteIntact(approval.quote, checks ?? approval.checks);
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
  // ONE gated read, held in a const. Calling `quoteExpiryText` twice would run
  // the integrity gate — and therefore the builder — twice for one comparison,
  // and the second call could not disagree with the first anyway.
  const expiryText = quoteExpiryText(quote);
  if (confirmation.confirmedQuoteExpiresAt !== expiryText) {
    throw new OrderError('order.quote_not_approved', 'the confirmation saw a different expiry than the quote states', {
      quoteId: quote.quoteId,
      confirmedExpiresAt: confirmation.confirmedQuoteExpiresAt,
      expiresAt: expiryText,
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
  const confirmable = assertQuoteConfirmable(quote, approval.asOf, confirmation.confirmedVersion, checks ?? approval.checks);

  // THE VALIDATED APPROVAL, which is what callers must read from here on
  // (`B-1`). `asOf` is carried through the canonical-instant check inside
  // `assertQuoteConfirmable`, the quote is the gate's own snapshot and the
  // confirmation is the frozen primitive copy taken above, so nothing in the
  // returned object can change under a caller that holds it. `checks` is NOT
  // carried: a map is not a primitive, and a caller that needs precisions
  // states them at its own call site, which is the precedence this function
  // already enforces.
  return Object.freeze({
    quote: confirmable,
    confirmation,
    asOf: approval.asOf,
    ...(approval.priorRecomputedTotalMinor === undefined
      ? {}
      : {
          priorRecomputedTotalMinor: requireStringField(
            approval.priorRecomputedTotalMinor,
            'priorRecomputedTotalMinor',
            'order.quote_amount_invalid',
            'a prior recomputed total must be a string of integer minor units',
          ),
        }),
  });
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
  const quote = assertQuoteApproved(approval, orderId).quote;
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
