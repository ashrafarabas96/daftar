/**
 * The AR settlement arithmetic of P4-S4 — the receivable mirror of the
 * accepted `supplier-settlement.ts`.
 *
 * ## One body, reconciled from two
 *
 * This module is the SINGLE plan layer of the slice. It was reconciled from
 * two independently written implementations that both landed at `9b4e2a5`:
 * `apps/api/src/modules/receivables/customer-settlement.ts` (671 lines) and
 * this package's own `customer-settlement-payloads.ts` (520 lines, which
 * despite its name held no payload builder at all — only a second copy of
 * `arSide`, `creditSide`, both line builders, `balanced()`, both dusts, the
 * realized FX and the closure). Both called the four accepted primitives, so
 * the prohibition on a second body of a financial truth was kept at the
 * primitive level and broken one layer up. There is now exactly one body of
 * each, here, and the API file is a re-export of it.
 *
 * The reconciliation kept the API module's error type, code names and field
 * names, because those are the vocabulary that is actually REGISTERED:
 * `receivables-errors.ts`' `RECEIVABLES_STATUS` classifies all fifteen codes
 * below and binds them at compile time through
 * `RECEIVABLES_PLAN_CODES_ARE_REGISTERED`, while the twelve
 * `customer_payment_allocation.*` / `payment.*` codes of the other copy were
 * classified nowhere. Landing those names would have turned every
 * merchant-input refusal into a 500 `customer_payment.arithmetic_invalid`,
 * which is the exact defect that table exists to prevent.
 *
 * Where the two copies disagreed on BEHAVIOUR, the accepted supplier
 * precedent decided, not either author:
 *
 * - the `totalBaseMinor` floor is `0n`, because the accepted `apSide`
 *   (`supplier-settlement.ts:170`) asserts `0n`; the API copy's `1n` would
 *   have refused a lawful invoice whose whole carrying base had already been
 *   released. The floor is deliberately LOOSER here than in SQL, where
 *   `supplier_ap_release` (`0067:688`) requires `p_total_base > 0`, and the
 *   divergence is unreachable rather than tolerated: `invoices.total_base_minor`
 *   is `CHECK (BETWEEN 1 AND 10^18)` (`0075:263`), so no invoice that exists
 *   can carry a zero base and no caller can reach the gap. Were a later slice
 *   to admit a zero-base document, the SQL side is the one that refuses it and
 *   this is the comment that says so;
 * - the 0..50 allocation cap is enforced HERE as well as in the zod schema,
 *   because this module is what any future caller sees;
 * - the entry-line ORDER is the API copy's (the posting line after the AR
 *   lines). `0081`'s `accounting_customer_payment_allocation_entry_complete`
 *   compares `array_agg(... ORDER BY ...)` on both sides, so it pins a SORTED
 *   MULTISET and is order-insensitive, and
 *   `packages/accounting/src/fingerprint.ts:209` sorts lines by their own
 *   bytes before hashing, so the signed fingerprint is order-insensitive too.
 *   But `packages/accounting/src/post.ts:111` assigns `line_no = i + 1`
 *   POSITIONALLY, so the order is persisted in `journal_lines`; the other
 *   copy's `unshift` would have silently renumbered every posted allocation
 *   entry with neither validator nor fingerprint to catch it.
 *
 * The per-line `dimension` of the other copy is not kept: a receivables entry
 * carries ONE branch, supplied per entry by `receivablePostingCommand`
 * (`branchId`), which is what the `0081` validator expects on every line.
 *
 * ## It implements NO arithmetic of its own
 *
 * «The settlement arithmetic is REUSED, never re-implemented.» Every number
 * below comes out of one of the four accepted primitives, imported from
 * `./supplier-settlement` and called here exactly as the supplier plan calls
 * them:
 *
 * - `convertToBase(x, R, e_t, e_b)` — `supplier-settlement.ts:78`, the twin
 *   of `supplier_convert_base` (`0067:671`);
 * - `apRelease(B, T, X, a) = HALF_EVEN(B·(X+a), T) − HALF_EVEN(B·X, T)` —
 *   `supplier-settlement.ts:89`, the twin of `supplier_ap_release`
 *   (`0067:683`);
 * - `creditRemainingCarrying(OA, OB, r) = g(r)` —
 *   `supplier-settlement.ts:101`, the twin of
 *   `supplier_credit_remaining_carrying` (`0067:696`);
 * - `creditRelease(OA, OB, rb, c) = g(rb) − g(rb − c)` —
 *   `supplier-settlement.ts:112`.
 *
 * **The `ap_`/`supplier_` in those names is HISTORICAL.** The bodies are plain
 * `BIGINT` half-even arithmetic over `(total, carrying, level, amount)` and
 * carry nothing supplier-specific; `0067:671/683/696` declare them `IMMUTABLE`
 * over scalars for exactly that reason. Releasing a receivable's carrying base
 * is the same function as releasing a payable's, so the invoice chain calls
 * `apRelease` and the customer credit calls `creditRelease`. There is no
 * rounding function, no release formula and no `HALF_EVEN` in this file, only
 * calls into those four; `VALUE_LIMIT_MINOR` likewise comes from
 * `./fixed-point`, so the ±10^18 column bound has one definition too.
 *
 * It is held to `vectors/customer-settlement-vectors.json` exactly as
 * `supplier-settlement.ts:18-20` is held to
 * `vectors/supplier-settlement-vectors.json`.
 *
 * ## Notation
 *
 * An invoice: `T` = `total_txn_minor`, `B` = `total_base_minor`, `R` =
 * `source_to_base_rate` (its own stored snapshot), `O` = the outstanding txn
 * AR from `invoice_outstanding`, `X = T − O` the AR already released. A
 * customer credit: `OA` original amount, `OB` original carrying base, `rb` the
 * remaining amount before this consumer, `Rn` its stored snapshot.
 *
 * Nothing here imports from the API, reads a clock, a rate registry or the
 * database; every export is a pure function of its arguments.
 */
import type { InventoryErrorCode } from './errors';
import { VALUE_LIMIT_MINOR } from './fixed-point';
import { apRelease, convertToBase, creditRelease, creditRemainingCarrying } from './supplier-settlement';

const abs = (v: bigint): bigint => (v < 0n ? -v : v);

/** Allocations per customer payment, after `payment_allocations.line_no CHECK (BETWEEN 1 AND 50)` (`0081:307`). */
export const CUSTOMER_PAYMENT_MAX_ALLOCATIONS = 50;

/**
 * EVERY CODE THIS MODULE CAN RAISE, as a closed literal union.
 *
 * ## Why it is written out per domain instead of `` `${Domain}.${Suffix}` ``
 *
 * Three of the raise sites below are templated on `domain`
 * (`arSide`'s `amount_invalid`, `amount_exceeds_outstanding` and
 * `amount_below_base_unit`), so each produces TWO codes — one per side of the
 * invoice chain. A templated type would make the union symmetric by
 * construction and hide exactly the defect that cost this slice a round:
 * `customer_payment.amount_invalid` was reachable from `arSide` and registered
 * nowhere, so a merchant sending a non-positive applied amount got a 500
 * reporting OUR arithmetic as broken for plainly their input.
 *
 * Written out, the union is a LIST OF CLAIMS a reader can check against the
 * raise sites, and `receivables-errors.ts` holds it to `ReceivablesCode` at
 * COMPILE TIME (`RECEIVABLES_PLAN_CODES_ARE_REGISTERED`). So the whole class
 * of defect — a live raise site whose code no status table classifies — is now
 * a type error on both sides of every template, for this template and for any
 * future one. That is strictly stronger than a test, because it cannot go
 * stale and cannot be skipped.
 *
 * The asymmetry is real and deliberate, not an oversight:
 * `credit_exhausted`, `amount_exceeds_credit` and `amount_mismatch`-on-a-credit
 * exist only on the credit side, and `allocations_invalid`,
 * `credit_below_base_unit` and `arithmetic_invalid` only on the payment side,
 * because only a payment has a surplus and a closure law.
 */
export type ReceivableArithmeticCode =
  // The payment side.
  | 'customer_payment.arithmetic_invalid'
  | 'customer_payment.allocations_invalid'
  | 'customer_payment.amount_invalid'
  | 'customer_payment.amount_exceeds_outstanding'
  | 'customer_payment.amount_below_base_unit'
  | 'customer_payment.amount_mismatch'
  | 'customer_payment.residue_below_base_unit'
  | 'customer_payment.credit_below_base_unit'
  // The credit-application side.
  | 'customer_credit_application.amount_invalid'
  | 'customer_credit_application.amount_exceeds_outstanding'
  | 'customer_credit_application.amount_below_base_unit'
  | 'customer_credit_application.amount_mismatch'
  | 'customer_credit_application.residue_below_base_unit'
  | 'customer_credit_application.credit_exhausted'
  | 'customer_credit_application.amount_exceeds_credit';

/**
 * The same union as a runtime list, for a suite that wants to drive every code
 * rather than trust the type.
 *
 * `EXHAUSTIVE` is what keeps the two in step: it is a
 * `Record<ReceivableArithmeticCode, true>` built from the array, so a member
 * of the union missing from the array does not compile, and a member of the
 * array outside the union does not either.
 */
export const RECEIVABLE_ARITHMETIC_CODES = [
  'customer_payment.arithmetic_invalid',
  'customer_payment.allocations_invalid',
  'customer_payment.amount_invalid',
  'customer_payment.amount_exceeds_outstanding',
  'customer_payment.amount_below_base_unit',
  'customer_payment.amount_mismatch',
  'customer_payment.residue_below_base_unit',
  'customer_payment.credit_below_base_unit',
  'customer_credit_application.amount_invalid',
  'customer_credit_application.amount_exceeds_outstanding',
  'customer_credit_application.amount_below_base_unit',
  'customer_credit_application.amount_mismatch',
  'customer_credit_application.residue_below_base_unit',
  'customer_credit_application.credit_exhausted',
  'customer_credit_application.amount_exceeds_credit',
] as const satisfies readonly ReceivableArithmeticCode[];

const EXHAUSTIVE: Record<ReceivableArithmeticCode, true> = Object.freeze(
  Object.fromEntries(RECEIVABLE_ARITHMETIC_CODES.map((c) => [c, true as const])) as Record<ReceivableArithmeticCode, true>,
);

/**
 * **EVERY CODE THIS ARITHMETIC RAISES IS AN `InventoryErrorCode`**, proved by
 * the compiler rather than by inspection — the §8.7 half of this lift that
 * says the `customer_*` refusal codes join that union in the same edit.
 *
 * `Exclude<ReceivableArithmeticCode, InventoryErrorCode>` is `never` exactly
 * when the fifteen codes above are all members, so `Record<that, never>` is
 * `Record<never, never>` and `{}` satisfies it. Leave one out of `errors.ts`
 * and the empty object is missing a required property, so the compiler names
 * **the missing code as the property name** — the same device, and the same
 * reason, as `RECEIVABLES_PLAN_CODES_ARE_REGISTERED` in
 * `receivables-errors.ts`. It costs one frozen empty object at runtime, kept
 * alive by the `void` so no lint rule prunes it.
 */
const PLAN_CODES_ARE_INVENTORY_CODES: Record<Exclude<ReceivableArithmeticCode, InventoryErrorCode>, never> = Object.freeze({});
void PLAN_CODES_ARE_INVENTORY_CODES;

/** True iff `code` is one this arithmetic can raise — the runtime half of the union. */
export function isReceivableArithmeticCode(code: string): code is ReceivableArithmeticCode {
  return Object.hasOwn(EXHAUSTIVE, code);
}

/**
 * The two sides of the invoice chain, as the templated raise sites name them.
 * Typed, so `` `${domain}.amount_invalid` `` is a member of
 * `ReceivableArithmeticCode` by construction rather than by inspection.
 */
type ArDomain = 'customer_payment' | 'customer_credit_application';

/**
 * A refusal of this arithmetic, carrying its STABLE CODE and nothing else.
 *
 * It is a class of its own rather than `InventoryError`, for one reason that
 * is not stylistic: `InventoryErrorCode` (`packages/inventory/src/errors.ts`)
 * is a CLOSED union, and the `customer_payment.*` /
 * `customer_credit_application.*` codes join it in the same edit that lifts
 * this module into `packages/inventory` (§8.7). Until then a `customer_*` code
 * is not an `InventoryErrorCode`, and borrowing `inventory.payload_invalid` for
 * all of them would collapse eleven distinct refusals into one — which is
 * exactly the "classified by a table, never by the shape of a name" rule
 * `receivables-errors.ts` exists to keep.
 *
 * The message is written for an engineer reading a log and is never forwarded
 * to a merchant: `receivablesPlanRefusal` takes the code alone.
 */
export class ReceivableArithmeticError extends Error {
  constructor(
    readonly code: ReceivableArithmeticCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReceivableArithmeticError';
  }
}

function refuse(code: ReceivableArithmeticCode, message: string): never {
  throw new ReceivableArithmeticError(code, message);
}

function assertMinor(v: bigint, what: string, min: bigint): void {
  if (typeof v !== 'bigint' || v < min || v > VALUE_LIMIT_MINOR)
    refuse('customer_payment.arithmetic_invalid', `${what} must be an integer amount within range`);
}

// ── Snapshots ────────────────────────────────────────────────────────────

/**
 * One STORED FX snapshot as the arithmetic reads it: the rate as its R10 and
 * the two currencies' exponents. Never a new lookup — a document's own
 * `source_to_base_rate` is the only rate its lines may carry.
 */
export interface ReceivableConversion {
  /** rate × 10^10; exactly 10^10 for the base currency. */
  readonly rateR10: bigint;
  /** Minor units of the converted currency. */
  readonly txnExponent: number;
  /** Minor units of the business's base currency. */
  readonly baseExponent: number;
}

const convert = (x: bigint, c: ReceivableConversion): bigint => convertToBase(x, c.rateR10, c.txnExponent, c.baseExponent);

/**
 * R-77 / R-78: a residue of 0, or one converting to at least one base minor
 * unit, is lawful; a sub-unit residue is not. Judged AFTER every
 * `…amount_below_base_unit`, which is the order the accepted guards judge it
 * in (`supplier-settlement.ts:40-42`, `0067:1019-1029`).
 */
const strands = (remainingMinor: bigint, c: ReceivableConversion): boolean => remainingMinor > 0n && convert(remainingMinor, c) === 0n;

/** The AR side of an invoice at the moment a reducer computes from it. */
export interface InvoiceArState {
  readonly totalTxnMinor: bigint;
  readonly totalBaseMinor: bigint;
  /** `O` = `invoice_outstanding(business, invoice).outstanding_txn_minor`. */
  readonly outstandingTxnMinor: bigint;
  /** The invoice's stored snapshot `R` (its currency → base). */
  readonly conversion: ReceivableConversion;
}

/** The credit side of a customer credit at the moment a consumer computes from it. */
export interface CustomerCreditState {
  readonly originalMinor: bigint;
  readonly originalCarryingMinor: bigint;
  /** `rb`: the stored `remaining_amount_minor`. */
  readonly remainingMinor: bigint;
  /** The credit's stored snapshot `Rn`. */
  readonly conversion: ReceivableConversion;
}

/** The AR release of one reducer: `X`, `rel`, `conv_R(a)` and the dust. */
interface ArSide {
  /** `a`, in the invoice's currency. */
  readonly invoiceAmountAppliedMinor: bigint;
  /** `X = T − O`, the chain position this row was computed at. */
  readonly arReleasedBeforeMinor: bigint;
  /** `rel = R(X + a) − R(X)`. */
  readonly invoiceCarryingReleasedMinor: bigint;
  /** `conv_R(a)`. */
  readonly arConvertedMinor: bigint;
  /** `rel − conv_R(a)`, signed: the dust line's amount. */
  readonly arDustBaseMinor: bigint;
}

function arSide(domain: ArDomain, invoice: InvoiceArState, appliedMinor: bigint): ArSide {
  assertMinor(invoice.totalTxnMinor, 'an invoice txn total', 1n);
  // `0n`, not `1n`: the accepted `apSide` (`supplier-settlement.ts:170`)
  // asserts `0n` over the same field, and a floor of `1n` would refuse a
  // lawful invoice whose whole carrying base a prior reducer already released.
  assertMinor(invoice.totalBaseMinor, 'an invoice base total', 0n);
  assertMinor(invoice.outstandingTxnMinor, 'an outstanding AR', 0n);
  if (invoice.outstandingTxnMinor > invoice.totalTxnMinor) refuse('customer_payment.arithmetic_invalid', 'the outstanding AR exceeds the invoice total');
  if (typeof appliedMinor !== 'bigint' || appliedMinor <= 0n) refuse(`${domain}.amount_invalid`, 'an applied amount must be positive');
  if (appliedMinor > invoice.outstandingTxnMinor)
    refuse(`${domain}.amount_exceeds_outstanding`, 'the applied amount exceeds the outstanding AR of the invoice');
  const arReleasedBeforeMinor = invoice.totalTxnMinor - invoice.outstandingTxnMinor;
  // `apRelease` — the name is historical; see this file's header. The
  // arithmetic is `rel(X, a) = R(X + a) − R(X)` over a document's stored
  // (total, carrying) pair, which is what an invoice carries too.
  const invoiceCarryingReleasedMinor = apRelease(invoice.totalBaseMinor, invoice.totalTxnMinor, arReleasedBeforeMinor, appliedMinor);
  const arConvertedMinor = convert(appliedMinor, invoice.conversion);
  // A journal line needs base > 0: an applied amount that converts to zero is
  // a stable refusal, never a line of base 0.
  if (arConvertedMinor === 0n) refuse(`${domain}.amount_below_base_unit`, 'the applied amount converts to less than one base minor unit');
  return {
    invoiceAmountAppliedMinor: appliedMinor,
    arReleasedBeforeMinor,
    invoiceCarryingReleasedMinor,
    arConvertedMinor,
    arDustBaseMinor: invoiceCarryingReleasedMinor - arConvertedMinor,
  };
}

/** The credit release of one consumer: `rb`, `cr_rel`, `conv_Rn(c)`, the dust and the credit's pair after it. */
interface CreditSide {
  /** `c`, in the credit's currency. */
  readonly creditAmountConsumedMinor: bigint;
  /** `rb`: the level, and the level-uniqueness key. */
  readonly creditRemainingBeforeMinor: bigint;
  /** `cr_rel = g(rb) − g(rb − c)`. */
  readonly creditCarryingReleasedMinor: bigint;
  /** `conv_Rn(c)`. */
  readonly creditConvertedMinor: bigint;
  /** `cr_rel − conv_Rn(c)`, signed. */
  readonly creditDustBaseMinor: bigint;
  readonly remainingAfterMinor: bigint;
  /** `g(rb − c)`: what the credit's stored pair must become. */
  readonly remainingCarryingAfterMinor: bigint;
}

function creditSide(credit: CustomerCreditState, consumedMinor: bigint): CreditSide {
  assertMinor(credit.originalMinor, 'a credit original amount', 1n);
  assertMinor(credit.originalCarryingMinor, 'a credit original carrying', 1n);
  assertMinor(credit.remainingMinor, 'a credit remaining amount', 0n);
  if (credit.remainingMinor > credit.originalMinor) refuse('customer_payment.arithmetic_invalid', 'a remaining credit exceeds the original credit');
  if (credit.remainingMinor === 0n) refuse('customer_credit_application.credit_exhausted', 'the customer credit has nothing remaining');
  if (typeof consumedMinor !== 'bigint' || consumedMinor <= 0n) refuse('customer_credit_application.amount_invalid', 'a consumed amount must be positive');
  if (consumedMinor > credit.remainingMinor) refuse('customer_credit_application.amount_exceeds_credit', 'the consumed amount exceeds the remaining credit');
  const creditCarryingReleasedMinor = creditRelease(credit.originalMinor, credit.originalCarryingMinor, credit.remainingMinor, consumedMinor);
  const creditConvertedMinor = convert(consumedMinor, credit.conversion);
  if (creditConvertedMinor === 0n) {
    refuse('customer_credit_application.amount_below_base_unit', 'the consumed amount converts to less than one base minor unit');
  }
  const remainingAfterMinor = credit.remainingMinor - consumedMinor;
  return {
    creditAmountConsumedMinor: consumedMinor,
    creditRemainingBeforeMinor: credit.remainingMinor,
    creditCarryingReleasedMinor,
    creditConvertedMinor,
    creditDustBaseMinor: creditCarryingReleasedMinor - creditConvertedMinor,
    remainingAfterMinor,
    remainingCarryingAfterMinor: creditRemainingCarrying(credit.originalMinor, credit.originalCarryingMinor, remainingAfterMinor),
  };
}

// ── The entry lines ──────────────────────────────────────────────────────

/**
 * The accounts an AR settlement entry may touch — a CLOSED set, the mirror of
 * `SettlementAccount` (`supplier-settlement.ts:225`).
 *
 * Never `rounding` (6100), never `purchase_price_variance` (6200), never tax,
 * and never `customer_refund_liability` (2200), which is P4-S5's. A `6100`
 * line is not "avoided by convention": it is not expressible, which is what
 * G-04 asserts by requiring that account to carry no line.
 */
export type ReceivableAccount = 'accounts_receivable' | 'customer_credit_liability' | 'fx_gain' | 'fx_loss' | 'posting_account';

/**
 * One line of an AR settlement entry.
 *
 * - `currency` names the snapshot the line carries — the invoice's (`invoice`,
 *   `R`), the credit's (`credit`, `Rn`), the payment's bound snapshot
 *   (`payment`, `Rp`), or `base` at rate 1. A line never carries a rate looked
 *   up for it.
 * - No line carries a warehouse. The branch dimension is the invoice's own
 *   `branch_id`, which `accounting_invoice_entry_complete` already pins the
 *   revenue entry to (`0077:1480-1483`).
 */
export interface ReceivableEntryLine {
  readonly account: ReceivableAccount;
  readonly side: 'D' | 'C';
  readonly currency: 'invoice' | 'credit' | 'payment' | 'base';
  readonly txnAmountMinor: bigint;
  readonly baseAmountMinor: bigint;
}

function baseLine(account: ReceivableAccount, side: 'D' | 'C', amount: bigint): ReceivableEntryLine {
  return { account, side, currency: 'base', txnAmountMinor: amount, baseAmountMinor: amount };
}

/** `balanced()` (`supplier-settlement.ts:249-257`): a non-zero base balance, or a non-positive amount, is a defect. */
function balanced(lines: ReceivableEntryLine[]): readonly ReceivableEntryLine[] {
  let balance = 0n;
  for (const l of lines) {
    if (l.baseAmountMinor <= 0n || l.txnAmountMinor <= 0n) refuse('customer_payment.arithmetic_invalid', 'an entry line carries positive amounts');
    balance += l.side === 'D' ? l.baseAmountMinor : -l.baseAmountMinor;
  }
  if (balance !== 0n) refuse('customer_payment.arithmetic_invalid', 'a settlement entry must balance');
  return Object.freeze(lines);
}

/**
 * The AR principal line and its dust, the exact mirror of `apLines`
 * (`supplier-settlement.ts:259-272`) with the side flipped: settling a
 * receivable CREDITS the asset where settling a payable debits the liability.
 *
 * OQ-9, ruled: the dust stays on `accounts_receivable` — a second line on the
 * SAME account as the principal, in base currency at rate 1. There is no
 * write-off line and no `rounding_difference_minor` column anywhere on this
 * path.
 */
function arLines(ar: ArSide): ReceivableEntryLine[] {
  const out: ReceivableEntryLine[] = [
    { account: 'accounts_receivable', side: 'C', currency: 'invoice', txnAmountMinor: ar.invoiceAmountAppliedMinor, baseAmountMinor: ar.arConvertedMinor },
  ];
  if (ar.arDustBaseMinor !== 0n) out.push(baseLine('accounts_receivable', ar.arDustBaseMinor > 0n ? 'C' : 'D', abs(ar.arDustBaseMinor)));
  return out;
}

/**
 * The credit principal line and its dust, the mirror of `creditLines`
 * (`supplier-settlement.ts:274-287`). Consuming a customer credit DEBITS
 * `customer_credit_liability` (2210) where consuming a supplier credit note
 * credits `supplier_receivable`.
 *
 * OQ-9, ruled: the credit-application dust goes to `customer_credit_liability`
 * — the same account as its principal, exactly as the AR dust goes to
 * `accounts_receivable`.
 */
function creditLines(cr: CreditSide): ReceivableEntryLine[] {
  const out: ReceivableEntryLine[] = [
    {
      account: 'customer_credit_liability',
      side: 'D',
      currency: 'credit',
      txnAmountMinor: cr.creditAmountConsumedMinor,
      baseAmountMinor: cr.creditConvertedMinor,
    },
  ];
  if (cr.creditDustBaseMinor !== 0n) out.push(baseLine('customer_credit_liability', cr.creditDustBaseMinor > 0n ? 'D' : 'C', abs(cr.creditDustBaseMinor)));
  return out;
}

/**
 * Realized FX, and the ONLY two accounts it may touch (`4900` / `6900`).
 *
 * The sign is the AR mirror of the AP one and is deliberately inverted. On the
 * payable side cash is CREDITED and the liability DEBITED, so an excess of
 * `pb` over `rel` needs a debit — a loss. On the receivable side cash is
 * DEBITED and the asset CREDITED, so the same excess needs a credit — a gain.
 * `balanced()` is what proves the choice rather than this comment.
 */
function realizedLines(realizedMinor: bigint): ReceivableEntryLine[] {
  if (realizedMinor === 0n) return [];
  return [baseLine(realizedMinor > 0n ? 'fx_gain' : 'fx_loss', realizedMinor > 0n ? 'C' : 'D', abs(realizedMinor))];
}

// ── (a) One allocation of a collected customer payment ───────────────────

export interface CustomerPaymentAllocationInput {
  readonly invoice: InvoiceArState;
  /** `P = C`: the payment is in the invoice's currency, so `p = a`. */
  readonly sameCurrency: boolean;
  /** `p` > 0, in the payment currency. */
  readonly paymentAmountMinor: bigint;
  /** The payment's bound snapshot `Rp`. */
  readonly payment: ReceivableConversion;
  /** `a` > 0, in the invoice's currency, ≤ `O`. */
  readonly appliedMinor: bigint;
}

/** Every amount one `payment_allocations` row stores and its entry posts. */
export interface CustomerPaymentAllocationPlan extends ArSide {
  readonly paymentAmountMinor: bigint;
  /** `pb = conv_Rp(p)`. */
  readonly paymentBaseMinor: bigint;
  /** `pb − rel`, signed: > 0 a gain (4900), < 0 a loss (6900). */
  readonly realizedFxMinor: bigint;
  readonly entryLines: readonly ReceivableEntryLine[];
}

export function planCustomerPaymentAllocation(input: CustomerPaymentAllocationInput): CustomerPaymentAllocationPlan {
  const p = input.paymentAmountMinor;
  if (typeof p !== 'bigint' || p <= 0n || p > VALUE_LIMIT_MINOR) refuse('customer_payment.allocations_invalid', 'a payment amount must be positive');
  if (input.sameCurrency && p !== input.appliedMinor) {
    refuse('customer_payment.amount_mismatch', 'a payment in the invoice currency pays exactly what it applies');
  }
  const ar = arSide('customer_payment', input.invoice, input.appliedMinor);
  const paymentBaseMinor = convert(p, input.payment);
  if (paymentBaseMinor === 0n) refuse('customer_payment.amount_below_base_unit', 'the payment amount converts to less than one base minor unit');
  if (strands(input.invoice.outstandingTxnMinor - ar.invoiceAmountAppliedMinor, input.invoice.conversion)) {
    refuse('customer_payment.residue_below_base_unit', 'the allocation would leave the invoice an amount converting to less than one base minor unit');
  }
  const realizedFxMinor = paymentBaseMinor - ar.invoiceCarryingReleasedMinor;
  const lines = arLines(ar);
  lines.push({ account: 'posting_account', side: 'D', currency: 'payment', txnAmountMinor: p, baseAmountMinor: paymentBaseMinor });
  lines.push(...realizedLines(realizedFxMinor));
  return { ...ar, paymentAmountMinor: p, paymentBaseMinor, realizedFxMinor, entryLines: balanced(lines) };
}

// ── (b) The surplus of a collected payment, as a customer credit ─────────

export interface CustomerCreditCreationInput {
  /** `s` > 0: `amount_minor − Σ payment_amount_minor`, in the payment currency. */
  readonly surplusMinor: bigint;
  /** The payment's bound snapshot `Rp`: the credit is born at the payment's rate. */
  readonly payment: ReceivableConversion;
}

/** Everything the surplus `customer_credits` row stores, and the entry that puts the money on the liability. */
export interface CustomerCreditCreationPlan {
  /** `OA` = `s`. */
  readonly originalAmountMinor: bigint;
  /** `OB` = `conv_Rp(s)`, and the row is born with `remaining = OA`, `remaining_carrying = OB`. */
  readonly originalCarryingBaseMinor: bigint;
  readonly entryLines: readonly ReceivableEntryLine[];
}

/**
 * The overpayment leg (G-15): the surplus becomes a CUSTOMER CREDIT and never
 * revenue. The entry is `Dr posting_account / Cr customer_credit_liability`,
 * both at the payment's own snapshot, so no revenue account appears in it —
 * which is what G-15 asserts.
 *
 * `g(OA) = OB` holds by construction at birth: `creditRemainingCarrying(OA,
 * OB, OA) = max(1, OB − HALF_EVEN(OB·0, OA)) = OB`, so the row satisfies the
 * verifier's stored-pair identity the instant it is written. It is asserted
 * here rather than assumed.
 */
export function planCustomerCreditCreation(input: CustomerCreditCreationInput): CustomerCreditCreationPlan {
  const s = input.surplusMinor;
  if (typeof s !== 'bigint' || s <= 0n || s > VALUE_LIMIT_MINOR) refuse('customer_payment.allocations_invalid', 'a surplus must be positive');
  const originalCarryingBaseMinor = convert(s, input.payment);
  if (originalCarryingBaseMinor === 0n) refuse('customer_payment.credit_below_base_unit', 'the surplus converts to less than one base minor unit');
  if (creditRemainingCarrying(s, originalCarryingBaseMinor, s) !== originalCarryingBaseMinor) {
    refuse('customer_payment.arithmetic_invalid', 'a credit born at its own original pair must satisfy g(OA) = OB');
  }
  const lines: ReceivableEntryLine[] = [
    { account: 'posting_account', side: 'D', currency: 'payment', txnAmountMinor: s, baseAmountMinor: originalCarryingBaseMinor },
    { account: 'customer_credit_liability', side: 'C', currency: 'payment', txnAmountMinor: s, baseAmountMinor: originalCarryingBaseMinor },
  ];
  return { originalAmountMinor: s, originalCarryingBaseMinor, entryLines: balanced(lines) };
}

// ── (c) One application of an existing customer credit to an invoice ─────

export interface CustomerCreditApplicationInput {
  readonly invoice: InvoiceArState;
  readonly credit: CustomerCreditState;
  /** The credit's currency is the invoice's, so `c = a`. */
  readonly sameCurrency: boolean;
  /** `c` > 0, in the credit's currency, ≤ `rb`. */
  readonly consumedMinor: bigint;
  /** `a` > 0, in the invoice's currency, ≤ `O`. */
  readonly appliedMinor: bigint;
}

/** Every amount one `customer_credit_applications` row stores and its entry posts. */
export interface CustomerCreditApplicationPlan extends ArSide, CreditSide {
  /** `cr_rel − rel`, signed: > 0 a gain (4900), < 0 a loss (6900). */
  readonly realizedFxMinor: bigint;
  readonly entryLines: readonly ReceivableEntryLine[];
}

export function planCustomerCreditApplication(input: CustomerCreditApplicationInput): CustomerCreditApplicationPlan {
  const cr = creditSide(input.credit, input.consumedMinor);
  if (input.sameCurrency && cr.creditAmountConsumedMinor !== input.appliedMinor) {
    refuse('customer_credit_application.amount_mismatch', 'a credit in the invoice currency applies exactly what it consumes');
  }
  const ar = arSide('customer_credit_application', input.invoice, input.appliedMinor);
  if (strands(input.invoice.outstandingTxnMinor - ar.invoiceAmountAppliedMinor, input.invoice.conversion)) {
    refuse(
      'customer_credit_application.residue_below_base_unit',
      'the application would leave the invoice an amount converting to less than one base minor unit',
    );
  }
  if (strands(cr.remainingAfterMinor, input.credit.conversion)) {
    refuse(
      'customer_credit_application.residue_below_base_unit',
      'the application would leave the credit a remainder converting to less than one base minor unit',
    );
  }
  const realizedFxMinor = cr.creditCarryingReleasedMinor - ar.invoiceCarryingReleasedMinor;
  const lines = [...creditLines(cr), ...arLines(ar), ...realizedLines(realizedFxMinor)];
  return { ...ar, ...cr, realizedFxMinor, entryLines: balanced(lines) };
}

// ── The closure law of a collected payment (OQ-4) ────────────────────────

/**
 * The ONE closure a `payments` row genuinely owes:
 *
 *     Σ payment_amount_minor + credit created = amount_minor
 *
 * with `allocation_count >= 0`, so a pure on-account payment (zero
 * allocations, the whole amount becoming a credit) is representable and a
 * fully-allocated one creates no credit. This is NOT
 * `payment.amount == invoice paid amount`, which is a source-of-truth rule the
 * Tech Lead forbids: what an invoice has been paid is
 * `invoice_outstanding`'s business and nothing else's.
 *
 * **Both sides are in the PAYMENT's currency** — coordinator ruling, and the
 * accepted law is `0067:950-955`. It is the only currency in which the
 * identity can be stated: `amount_minor` is the payment's while
 * `invoice_amount_applied_minor` is each invoice's own, so comparing those two
 * halves would compare two different units. The BASE-currency identity runs
 * alongside it and is asserted where the header base is bound
 * (`bindCustomerPayment`): `Σ payment_base_amount_minor + the credit's
 * original carrying base = base_amount_minor`, never `conv(Σ p)`.
 *
 * The database recomputes the same two sums at COMMIT, from its own rows,
 * under `payment_complete()`.
 */
export function assertPaymentClosure(amountMinor: bigint, allocationPaymentAmountsMinor: readonly bigint[], creditCreatedMinor: bigint): void {
  assertMinor(amountMinor, 'a payment amount', 1n);
  let allocated = 0n;
  for (const p of allocationPaymentAmountsMinor) {
    assertMinor(p, 'an allocation payment amount', 1n);
    allocated += p;
  }
  if (allocated > amountMinor) refuse('customer_payment.allocations_invalid', 'a payment cannot allocate more than it received');
  if (allocated + creditCreatedMinor !== amountMinor) {
    refuse('customer_payment.allocations_invalid', 'a payment allocates its whole amount or carries the surplus as a customer credit');
  }
}

/** `s = amount − Σ p`: the surplus a collected payment carries, 0 when it is fully allocated. */
export function paymentSurplusMinor(amountMinor: bigint, allocationPaymentAmountsMinor: readonly bigint[]): bigint {
  let allocated = 0n;
  for (const p of allocationPaymentAmountsMinor) allocated += p;
  const surplus = amountMinor - allocated;
  if (surplus < 0n) refuse('customer_payment.allocations_invalid', 'a payment cannot allocate more than it received');
  return surplus;
}

// ── (d) The whole payment, planned in one call ───────────────────────────

/** One leg of a payment as `planCustomerPayment` takes it. */
export interface CustomerPaymentLegInput {
  readonly invoice: InvoiceArState;
  /** `P = C`: the payment is in this invoice's currency. */
  readonly sameCurrency: boolean;
  readonly paymentAmountMinor: bigint;
  readonly appliedMinor: bigint;
}

export interface CustomerPaymentInput {
  readonly amountMinor: bigint;
  /** The payment's bound snapshot `Rp`. */
  readonly payment: ReceivableConversion;
  /** In `line_no` order; possibly EMPTY (OQ-4: a pure on-account payment). */
  readonly legs: readonly CustomerPaymentLegInput[];
}

/** Every figure a collected payment stores: its legs, its surplus credit and its header base. */
export interface CustomerPaymentPlan {
  readonly allocations: readonly CustomerPaymentAllocationPlan[];
  /** NULL exactly when the payment is fully allocated. */
  readonly credit: CustomerCreditCreationPlan | null;
  /**
   * `Σ payment_base_amount_minor + the credit's original carrying base` —
   * coordinator ruling, and never `conv(Σ p)`. A rounded quotient is never an
   * input to the next step (P4-AL-25), so the header base is a SUM OF
   * PER-LEG CONVERSIONS and not one conversion of a sum.
   */
  readonly baseAmountMinor: bigint;
  /** `s = amount − Σ p`, 0 when fully allocated. */
  readonly surplusMinor: bigint;
}

/**
 * The whole payment in one call: each leg's AR release, dust, base and
 * realized FX; the surplus credit's `(OA, OB)`; the header base; and both
 * closure laws asserted before anything can be signed.
 *
 * `allocation_count >= 0` (OQ-4). A payment with no legs plans no allocation,
 * one credit for the whole amount, and a `baseAmountMinor` that is the
 * credit's carrying base — not zero, which is the third of the coordinator's
 * corrections.
 */
export function planCustomerPayment(input: CustomerPaymentInput): CustomerPaymentPlan {
  // `payments.allocation_count CHECK (BETWEEN 0 AND 50)` (`0081:307` on
  // `payment_allocations.line_no`), enforced in the PLAN layer and not only in
  // `receivables.schemas.ts` / `receivables-payload.ts:189`: this module is
  // what any future caller of the package sees, and a cap that lives only in
  // one caller's zod schema is not a property of the arithmetic.
  // The count is read rather than `Array.isArray`-guarded on purpose:
  // narrowing a `readonly T[]` through `Array.isArray` widens it to `any[]`,
  // which would make every leg below an `any` and silently drop the type
  // checking this module depends on. A missing or non-array `legs` has no
  // numeric `length`, so this one test covers both it and the cap.
  const legCount: unknown = input.legs.length;
  if (typeof legCount !== 'number' || legCount > CUSTOMER_PAYMENT_MAX_ALLOCATIONS) {
    refuse('customer_payment.allocations_invalid', `a payment has 0..${CUSTOMER_PAYMENT_MAX_ALLOCATIONS} allocations`);
  }
  const allocations = input.legs.map((leg) =>
    planCustomerPaymentAllocation({
      invoice: leg.invoice,
      sameCurrency: leg.sameCurrency,
      paymentAmountMinor: leg.paymentAmountMinor,
      payment: input.payment,
      appliedMinor: leg.appliedMinor,
    }),
  );
  const paymentAmounts = allocations.map((a) => a.paymentAmountMinor);
  const surplusMinor = paymentSurplusMinor(input.amountMinor, paymentAmounts);
  const credit = surplusMinor > 0n ? planCustomerCreditCreation({ surplusMinor, payment: input.payment }) : null;
  assertPaymentClosure(input.amountMinor, paymentAmounts, credit?.originalAmountMinor ?? 0n);
  const baseAmountMinor = allocations.reduce((sum, a) => sum + a.paymentBaseMinor, credit?.originalCarryingBaseMinor ?? 0n);
  if (baseAmountMinor <= 0n) refuse('customer_payment.arithmetic_invalid', 'a collected payment converts to at least one base minor unit');
  return { allocations, credit, baseAmountMinor, surplusMinor };
}
