/**
 * The supplier-settlement arithmetic (PHASE_3_S6_CONTRACT A-05, A-08 – A-10,
 * §2.3; R-61 – R-64).
 *
 * Three commands consume value a purchase or a credit note carries at its
 * HISTORICAL base: a supplier payment allocation, a supplier credit
 * allocation and a supplier refund. Each releases a CUMULATIVE proportional
 * share of the carrying base it consumes, rounded once (DM §7ج), so the last
 * consumption releases the entire residue and nothing is ever stranded
 * (INV-ACC-17); the difference between what is released and what the other
 * side of the entry is worth in base is realized FX, posted to 4900/6900 and
 * never to 6100 (AL-28).
 *
 * Everything is exact integer arithmetic on `bigint`: money is integer minor
 * units, a rate is its R10 (rate × 10^10), and every division is one
 * HALF_EVEN (`roundHalfEven`, the twin of `inventory_half_even`). Nothing here
 * reads a clock, a rate registry or the database. It is the byte-equivalent
 * of 0067's `supplier_convert_base`, `supplier_ap_release` and
 * `supplier_credit_remaining_carrying`, held to the same vectors
 * (`vectors/supplier-settlement-vectors.json`).
 *
 * Notation — a purchase: `T` total txn, `B` total base, `R` its snapshot
 * rate, `O` its outstanding txn AP (`purchase_ap_outstanding`), `X = T − O`
 * the AP already released. A credit note: `OA` original amount, `OB`
 * original carrying base, `rb` the remaining amount before a consumer, `Rn`
 * its snapshot rate.
 *
 * - `convertToBase(x, R, e_t, e_b) = HALF_EVEN(x·R·10^max(0,e_b−e_t), 10^max(0,e_t−e_b))` (0043).
 * - `apRelease(B, T, X, a) = HALF_EVEN(B·(X+a), T) − HALF_EVEN(B·X, T)` (R-61):
 *   ≥ 0, and at `X + a = T` it releases the remaining base exactly.
 * - `creditRemainingCarrying(OA, OB, r)` = `g(r)`: 0 at `r = 0`, else
 *   `max(1, OB − HALF_EVEN(OB·(OA−r), OA))` (R-63).
 * - `creditRelease(OA, OB, rb, c) = g(rb) − g(rb − c)`: a partial consumption
 *   releases a cumulative proportional share; the final one (`c = rb`)
 *   releases `g(rb)`, the entire residue.
 *
 * The chain verdicts (`verifyPurchaseChain`, `verifyCreditChain`) are the
 * TypeScript twins of `purchase_settlement_verify` and
 * `supplier_credit_note_verify`: consumption is applied OLDEST FIRST, each
 * consumer starting exactly where the previous one stopped.
 */
import { InventoryError, type InventoryErrorCode } from './errors';
import { VALUE_LIMIT_MINOR } from './fixed-point';
import { roundHalfEven } from './rounding';

function refuse(code: InventoryErrorCode, message: string): never {
  throw new InventoryError(code, message);
}

function assertMinor(v: unknown, what: string, min: bigint): asserts v is bigint {
  if (typeof v !== 'bigint' || v < min || v > VALUE_LIMIT_MINOR) refuse('inventory.arithmetic_invalid', `${what} must be an integer amount within range`);
}

function assertExponent(v: unknown, what: string): asserts v is number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > 4)
    refuse('inventory.arithmetic_invalid', `${what} must be a currency minor-unit exponent`);
}

const R10 = 10n ** 10n;

const abs = (v: bigint): bigint => (v < 0n ? -v : v);

// ── The three primitives (§2.3) ──────────────────────────────────────────

/**
 * The 0043 conversion of `txnMinor` (≥ 0) at `rateR10` (> 0) from a currency
 * of `txnExponent` minor units to one of `baseExponent`: the twin of
 * `supplier_convert_base`. Zero converts to zero.
 */
export function convertToBase(txnMinor: bigint, rateR10: bigint, txnExponent: number, baseExponent: number): bigint {
  assertMinor(txnMinor, 'a txn amount', 0n);
  if (typeof rateR10 !== 'bigint' || rateR10 <= 0n) refuse('inventory.arithmetic_invalid', 'a rate must be positive');
  assertExponent(txnExponent, 'a txn exponent');
  assertExponent(baseExponent, 'a base exponent');
  const up = 10n ** BigInt(Math.max(0, baseExponent - txnExponent));
  const down = 10n ** BigInt(Math.max(0, txnExponent - baseExponent));
  return roundHalfEven(txnMinor * rateR10 * up, R10 * down);
}

/** R-61: the base AP released by applying `a` after `X` of a purchase of totals `T`/`B`: the twin of `supplier_ap_release`. */
export function apRelease(totalBaseMinor: bigint, totalTxnMinor: bigint, releasedBeforeMinor: bigint, appliedMinor: bigint): bigint {
  assertMinor(totalBaseMinor, 'a purchase base total', 0n);
  assertMinor(totalTxnMinor, 'a purchase txn total', 1n);
  assertMinor(releasedBeforeMinor, 'an AP released before', 0n);
  assertMinor(appliedMinor, 'an applied amount', 0n);
  if (releasedBeforeMinor + appliedMinor > totalTxnMinor) refuse('inventory.arithmetic_invalid', 'an AP release exceeds the purchase total');
  return (
    roundHalfEven(totalBaseMinor * (releasedBeforeMinor + appliedMinor), totalTxnMinor) - roundHalfEven(totalBaseMinor * releasedBeforeMinor, totalTxnMinor)
  );
}

/** R-63: `g(r)`, the carrying base a credit note of `OA`/`OB` keeps at remaining amount `r`: the twin of `supplier_credit_remaining_carrying`. */
export function creditRemainingCarrying(originalMinor: bigint, originalCarryingMinor: bigint, remainingMinor: bigint): bigint {
  assertMinor(originalMinor, 'a credit original amount', 1n);
  assertMinor(originalCarryingMinor, 'a credit original carrying', 1n);
  assertMinor(remainingMinor, 'a credit remaining amount', 0n);
  if (remainingMinor > originalMinor) refuse('inventory.arithmetic_invalid', 'a remaining credit exceeds the original credit');
  if (remainingMinor === 0n) return 0n;
  const kept = originalCarryingMinor - roundHalfEven(originalCarryingMinor * (originalMinor - remainingMinor), originalMinor);
  return kept < 1n ? 1n : kept;
}

/** R-63: the carrying base consuming `c` releases from a note whose remaining amount is `rb`: `g(rb) − g(rb − c)`. */
export function creditRelease(originalMinor: bigint, originalCarryingMinor: bigint, remainingBeforeMinor: bigint, consumedMinor: bigint): bigint {
  assertMinor(consumedMinor, 'a consumed amount', 1n);
  assertMinor(remainingBeforeMinor, 'a remaining amount', 0n);
  if (consumedMinor > remainingBeforeMinor) refuse('inventory.arithmetic_invalid', 'a consumption exceeds the remaining credit');
  return (
    creditRemainingCarrying(originalMinor, originalCarryingMinor, remainingBeforeMinor) -
    creditRemainingCarrying(originalMinor, originalCarryingMinor, remainingBeforeMinor - consumedMinor)
  );
}

// ── Snapshots ────────────────────────────────────────────────────────────

/** A stored or bound FX snapshot, as the arithmetic reads it: its rate and the two currencies' exponents. */
export interface SettlementConversion {
  /** rate × 10^10; exactly 10^10 for the base currency. */
  readonly rateR10: bigint;
  /** Minor units of the converted currency. */
  readonly txnExponent: number;
  /** Minor units of the business's base currency. */
  readonly baseExponent: number;
}

const convert = (x: bigint, c: SettlementConversion): bigint => convertToBase(x, c.rateR10, c.txnExponent, c.baseExponent);

/** The AP side of a purchase at the moment a reducer computes from it (A-08). */
export interface PurchaseApState {
  readonly totalTxnMinor: bigint;
  readonly totalBaseMinor: bigint;
  /** `O = purchase_ap_outstanding(business, purchase)`. */
  readonly outstandingTxnMinor: bigint;
  /** The purchase's snapshot `R` (its currency → base). */
  readonly conversion: SettlementConversion;
}

/** The credit side of a supplier credit note at the moment a consumer computes from it (A-10). */
export interface CreditNoteState {
  readonly originalMinor: bigint;
  readonly originalCarryingMinor: bigint;
  /** `rb`: the stored `remaining_amount_minor`. */
  readonly remainingMinor: bigint;
  /** The note's stored snapshot `Rn`: never a new lookup (L:830-841). */
  readonly conversion: SettlementConversion;
}

/** The AP release of one reducer: `X`, `rel`, `conv_R(a)` and the dust. */
interface ApSide {
  readonly appliedMinor: bigint;
  readonly releasedBeforeMinor: bigint;
  readonly carryingReleasedMinor: bigint;
  readonly apConvertedMinor: bigint;
  readonly apDustBaseMinor: bigint;
}

function apSide(domain: 'supplier_payment' | 'supplier_credit_allocation', purchase: PurchaseApState, appliedMinor: bigint): ApSide {
  assertMinor(purchase.totalTxnMinor, 'a purchase txn total', 1n);
  assertMinor(purchase.totalBaseMinor, 'a purchase base total', 0n);
  assertMinor(purchase.outstandingTxnMinor, 'an outstanding AP', 0n);
  if (purchase.outstandingTxnMinor > purchase.totalTxnMinor) refuse('inventory.arithmetic_invalid', 'the outstanding AP exceeds the purchase total');
  if (typeof appliedMinor !== 'bigint' || appliedMinor <= 0n) {
    refuse(domain === 'supplier_payment' ? 'supplier_payment.allocations_invalid' : 'inventory.payload_invalid', 'an applied amount must be positive');
  }
  if (appliedMinor > purchase.outstandingTxnMinor)
    refuse(`${domain}.amount_exceeds_outstanding`, 'the applied amount exceeds the outstanding AP of the purchase');
  const releasedBeforeMinor = purchase.totalTxnMinor - purchase.outstandingTxnMinor;
  const carryingReleasedMinor = apRelease(purchase.totalBaseMinor, purchase.totalTxnMinor, releasedBeforeMinor, appliedMinor);
  const apConvertedMinor = convert(appliedMinor, purchase.conversion);
  // A-08 / S5 TL-3: a journal line needs base > 0. An applied amount that
  // converts to 0 — the txn-only residue of a very small foreign purchase
  // included — is a stable refusal, never a line of base 0.
  if (apConvertedMinor === 0n) refuse(`${domain}.amount_below_base_unit`, 'the applied amount converts to less than one base minor unit');
  return { appliedMinor, releasedBeforeMinor, carryingReleasedMinor, apConvertedMinor, apDustBaseMinor: carryingReleasedMinor - apConvertedMinor };
}

/** The credit release of one consumer: `rb`, `cr_rel`, `conv_Rn(c)`, the dust and the note's pair after it. */
interface CreditSide {
  readonly consumedMinor: bigint;
  readonly remainingBeforeMinor: bigint;
  readonly creditReleasedMinor: bigint;
  readonly creditConvertedMinor: bigint;
  readonly creditDustBaseMinor: bigint;
  readonly remainingAfterMinor: bigint;
  readonly remainingCarryingAfterMinor: bigint;
}

function creditSide(domain: 'supplier_credit_allocation' | 'supplier_refund', note: CreditNoteState, consumedMinor: bigint): CreditSide {
  assertMinor(note.originalMinor, 'a credit original amount', 1n);
  assertMinor(note.originalCarryingMinor, 'a credit original carrying', 1n);
  assertMinor(note.remainingMinor, 'a credit remaining amount', 0n);
  if (note.remainingMinor > note.originalMinor) refuse('inventory.arithmetic_invalid', 'a remaining credit exceeds the original credit');
  if (note.remainingMinor === 0n) refuse(`${domain}.credit_exhausted`, 'the credit note has nothing remaining');
  if (typeof consumedMinor !== 'bigint' || consumedMinor <= 0n) refuse('inventory.payload_invalid', 'a consumed amount must be positive');
  if (consumedMinor > note.remainingMinor) refuse(`${domain}.amount_exceeds_credit`, 'the consumed amount exceeds the remaining credit');
  const creditReleasedMinor = creditRelease(note.originalMinor, note.originalCarryingMinor, note.remainingMinor, consumedMinor);
  const creditConvertedMinor = convert(consumedMinor, note.conversion);
  if (creditConvertedMinor === 0n) refuse(`${domain}.amount_below_base_unit`, 'the consumed amount converts to less than one base minor unit');
  const remainingAfterMinor = note.remainingMinor - consumedMinor;
  return {
    consumedMinor,
    remainingBeforeMinor: note.remainingMinor,
    creditReleasedMinor,
    creditConvertedMinor,
    creditDustBaseMinor: creditReleasedMinor - creditConvertedMinor,
    remainingAfterMinor,
    remainingCarryingAfterMinor: creditRemainingCarrying(note.originalMinor, note.originalCarryingMinor, remainingAfterMinor),
  };
}

// ── The entry lines (A-05) ───────────────────────────────────────────────

/** The accounts an S6 entry may touch: never 6100 (`rounding`), 6200 or tax (A-05, A-21). */
export type SettlementAccount = 'accounts_payable' | 'supplier_receivable' | 'fx_gain' | 'fx_loss' | 'posting_account';

/**
 * One line of an A-05 entry.
 *
 * - `currency`: the txn currency and snapshot the line carries — the
 *   purchase's (`purchase`, `R`), the note's (`note`, `Rn`), the payment's or
 *   the receipt's bound snapshot, or `base` at rate 1.
 * - `dimension`: whose branch the line carries — the (target) purchase's, or
 *   the note's origin purchase's (A-05(b), (c)). No line carries a warehouse.
 */
export interface SettlementEntryLine {
  readonly account: SettlementAccount;
  readonly side: 'D' | 'C';
  readonly currency: 'purchase' | 'note' | 'payment' | 'receipt' | 'base';
  readonly txnAmountMinor: bigint;
  readonly baseAmountMinor: bigint;
  readonly dimension: 'purchase' | 'origin';
}

function baseLine(account: SettlementAccount, side: 'D' | 'C', amount: bigint, dimension: 'purchase' | 'origin'): SettlementEntryLine {
  return { account, side, currency: 'base', txnAmountMinor: amount, baseAmountMinor: amount, dimension };
}

function balanced(lines: SettlementEntryLine[]): SettlementEntryLine[] {
  let balance = 0n;
  for (const l of lines) {
    if (l.baseAmountMinor <= 0n || l.txnAmountMinor <= 0n) refuse('inventory.arithmetic_invalid', 'an entry line carries positive amounts');
    balance += l.side === 'D' ? l.baseAmountMinor : -l.baseAmountMinor;
  }
  if (balance !== 0n) refuse('inventory.arithmetic_invalid', 'a settlement entry must balance');
  return lines;
}

function apLines(ap: ApSide): SettlementEntryLine[] {
  const out: SettlementEntryLine[] = [
    {
      account: 'accounts_payable',
      side: 'D',
      currency: 'purchase',
      txnAmountMinor: ap.appliedMinor,
      baseAmountMinor: ap.apConvertedMinor,
      dimension: 'purchase',
    },
  ];
  if (ap.apDustBaseMinor !== 0n) out.push(baseLine('accounts_payable', ap.apDustBaseMinor > 0n ? 'D' : 'C', abs(ap.apDustBaseMinor), 'purchase'));
  return out;
}

function creditLines(cr: CreditSide): SettlementEntryLine[] {
  const out: SettlementEntryLine[] = [
    {
      account: 'supplier_receivable',
      side: 'C',
      currency: 'note',
      txnAmountMinor: cr.consumedMinor,
      baseAmountMinor: cr.creditConvertedMinor,
      dimension: 'origin',
    },
  ];
  if (cr.creditDustBaseMinor !== 0n) out.push(baseLine('supplier_receivable', cr.creditDustBaseMinor > 0n ? 'C' : 'D', abs(cr.creditDustBaseMinor), 'origin'));
  return out;
}

// ── (a) A supplier payment allocation ────────────────────────────────────

export interface PaymentAllocationInput {
  readonly purchase: PurchaseApState;
  /** `P = C`: the payment is in the purchase currency, so `p = a` (A-07). */
  readonly sameCurrency: boolean;
  /** `p` > 0, in the payment currency. */
  readonly paymentAmountMinor: bigint;
  /** The payment's bound snapshot `Rp` (A-15). */
  readonly payment: SettlementConversion;
  /** `a` > 0, in the purchase currency, ≤ `O`. */
  readonly appliedMinor: bigint;
}

/** Every amount one `supplier_payment_allocations` row stores and its entry posts (A-05(a), A-07 – A-09). */
export interface PaymentAllocationPlan extends ApSide {
  readonly paymentAmountMinor: bigint;
  /** `pb = conv_Rp(p)`. */
  readonly paymentBaseMinor: bigint;
  /** `pb − rel`, signed: > 0 a loss (6900), < 0 a gain (4900). */
  readonly realizedMinor: bigint;
  readonly entryLines: readonly SettlementEntryLine[];
}

export function planPaymentAllocation(input: PaymentAllocationInput): PaymentAllocationPlan {
  const p = input.paymentAmountMinor;
  if (typeof p !== 'bigint' || p <= 0n || p > VALUE_LIMIT_MINOR) refuse('supplier_payment.allocations_invalid', 'a payment amount must be positive');
  if (input.sameCurrency && p !== input.appliedMinor)
    refuse('supplier_payment.amount_mismatch', 'a payment in the purchase currency pays exactly what it applies');
  const ap = apSide('supplier_payment', input.purchase, input.appliedMinor);
  const paymentBaseMinor = convert(p, input.payment);
  if (paymentBaseMinor === 0n) refuse('supplier_payment.amount_below_base_unit', 'the payment amount converts to less than one base minor unit');
  const realizedMinor = paymentBaseMinor - ap.carryingReleasedMinor;
  const lines = apLines(ap);
  lines.push({ account: 'posting_account', side: 'C', currency: 'payment', txnAmountMinor: p, baseAmountMinor: paymentBaseMinor, dimension: 'purchase' });
  if (realizedMinor !== 0n) lines.push(baseLine(realizedMinor > 0n ? 'fx_loss' : 'fx_gain', realizedMinor > 0n ? 'D' : 'C', abs(realizedMinor), 'purchase'));
  return { ...ap, paymentAmountMinor: p, paymentBaseMinor, realizedMinor, entryLines: balanced(lines) };
}

// ── (b) A supplier credit allocation ─────────────────────────────────────

export interface CreditAllocationInput {
  readonly purchase: PurchaseApState;
  readonly note: CreditNoteState;
  /** The note currency is the purchase currency, so `c = a` (A-10). */
  readonly sameCurrency: boolean;
  /** `c` > 0, in the note currency, ≤ `rb`. */
  readonly consumedMinor: bigint;
  /** `a` > 0, in the purchase currency, ≤ `O`. */
  readonly appliedMinor: bigint;
}

/** Every amount one `supplier_credit_allocations` row stores and its entry posts (A-05(b), A-10). */
export interface CreditAllocationPlan extends ApSide, CreditSide {
  /** `cr_rel − rel`, signed: > 0 a loss (6900), < 0 a gain (4900). */
  readonly realizedMinor: bigint;
  readonly entryLines: readonly SettlementEntryLine[];
}

export function planCreditAllocation(input: CreditAllocationInput): CreditAllocationPlan {
  const cr = creditSide('supplier_credit_allocation', input.note, input.consumedMinor);
  if (input.sameCurrency && input.consumedMinor !== input.appliedMinor) {
    refuse('supplier_credit_allocation.amount_mismatch', 'a credit in the purchase currency applies exactly what it consumes');
  }
  const ap = apSide('supplier_credit_allocation', input.purchase, input.appliedMinor);
  const realizedMinor = cr.creditReleasedMinor - ap.carryingReleasedMinor;
  const lines = [...apLines(ap), ...creditLines(cr)];
  if (realizedMinor !== 0n) lines.push(baseLine(realizedMinor > 0n ? 'fx_loss' : 'fx_gain', realizedMinor > 0n ? 'D' : 'C', abs(realizedMinor), 'purchase'));
  return { ...ap, ...cr, realizedMinor, entryLines: balanced(lines) };
}

// ── (c) A supplier refund ────────────────────────────────────────────────

export interface RefundInput {
  readonly note: CreditNoteState;
  /** The receipt currency is the note currency, so `m = c` (A-10). */
  readonly sameCurrency: boolean;
  /** `c` > 0, in the note currency, ≤ `rb`. */
  readonly consumedMinor: bigint;
  /** `m` > 0, in the receipt currency. */
  readonly receiptAmountMinor: bigint;
  /** The receipt's bound snapshot `Rr` (A-15). */
  readonly receipt: SettlementConversion;
}

/** Every amount one `supplier_refunds` row stores and its entry posts (A-05(c), A-10). */
export interface RefundPlan extends CreditSide {
  readonly receiptAmountMinor: bigint;
  /** `mb = conv_Rr(m)`. */
  readonly receiptBaseMinor: bigint;
  /** `mb − cr_rel`, signed: > 0 a gain (4900), < 0 a loss (6900). */
  readonly realizedMinor: bigint;
  readonly entryLines: readonly SettlementEntryLine[];
}

export function planRefund(input: RefundInput): RefundPlan {
  const cr = creditSide('supplier_refund', input.note, input.consumedMinor);
  const m = input.receiptAmountMinor;
  if (typeof m !== 'bigint' || m <= 0n || m > VALUE_LIMIT_MINOR) refuse('inventory.payload_invalid', 'a receipt amount must be positive');
  if (input.sameCurrency && m !== input.consumedMinor)
    refuse('supplier_refund.amount_mismatch', 'a refund in the note currency receives exactly what it consumes');
  const receiptBaseMinor = convert(m, input.receipt);
  if (receiptBaseMinor === 0n) refuse('supplier_refund.amount_below_base_unit', 'the receipt amount converts to less than one base minor unit');
  const realizedMinor = receiptBaseMinor - cr.creditReleasedMinor;
  const lines: SettlementEntryLine[] = [
    { account: 'posting_account', side: 'D', currency: 'receipt', txnAmountMinor: m, baseAmountMinor: receiptBaseMinor, dimension: 'origin' },
    ...creditLines(cr),
  ];
  if (realizedMinor !== 0n) lines.push(baseLine(realizedMinor > 0n ? 'fx_gain' : 'fx_loss', realizedMinor > 0n ? 'C' : 'D', abs(realizedMinor), 'origin'));
  return { ...cr, receiptAmountMinor: m, receiptBaseMinor, realizedMinor, entryLines: balanced(lines) };
}

// ── The chains (R-62, R-63): oldest first ────────────────────────────────

/** One AP reducer of a purchase (a return's AP part, a payment allocation, a credit allocation) as stored. */
export interface PurchaseChainRow {
  /** `ap_released_before_txn_minor` (X). */
  readonly releasedBeforeMinor: bigint;
  /** `ap_txn_minor` / `purchase_amount_applied_minor`. */
  readonly amountMinor: bigint;
  /** `ap_base_minor` / `purchase_carrying_base_released_minor`. */
  readonly releasedBaseMinor: bigint;
}

/**
 * R-62, the twin of `purchase_settlement_verify`: over the reducers with
 * amount > 0 ordered by X (oldest first), each X is the sum of the amounts
 * before it, `Σ amount ≤ T`, and `Σ rel = HALF_EVEN(B·Σ amount, T)`. Two
 * reducers computed from the same O overlap and are refused.
 */
export function verifyPurchaseChain(totalTxnMinor: bigint, totalBaseMinor: bigint, rows: readonly PurchaseChainRow[]): void {
  assertMinor(totalTxnMinor, 'a purchase txn total', 1n);
  assertMinor(totalBaseMinor, 'a purchase base total', 0n);
  const bad = (): never => refuse('supplier_payment.settlement_inconsistent', 'the AP reducers of the purchase do not form one chain');
  const ordered = rows
    .filter((r) => r.amountMinor > 0n)
    .sort((a, b) => (a.releasedBeforeMinor < b.releasedBeforeMinor ? -1 : a.releasedBeforeMinor > b.releasedBeforeMinor ? 1 : 0));
  let sum = 0n;
  let released = 0n;
  for (const r of ordered) {
    if (r.releasedBeforeMinor !== sum) bad();
    sum += r.amountMinor;
    released += r.releasedBaseMinor;
  }
  if (sum > totalTxnMinor || released !== roundHalfEven(totalBaseMinor * sum, totalTxnMinor)) bad();
}

/** One consumer of a credit note (a credit allocation or a refund) as stored. */
export interface CreditChainRow {
  /** `credit_remaining_before_minor` (rb). */
  readonly remainingBeforeMinor: bigint;
  readonly consumedMinor: bigint;
  /** `credit_carrying_base_released_minor` / `source_carrying_base_released_minor`. */
  readonly releasedBaseMinor: bigint;
}

/**
 * R-63, the twin of `supplier_credit_note_verify`: over the consumers ordered
 * by `rb` descending (oldest first), each `rb = OA − Σ` of the earlier
 * consumptions; the stored remaining is `OA − Σ c`, the stored remaining
 * carrying is `g(OA − Σ c)`, and `Σ cr_rel = OB − g(remaining)`.
 */
export function verifyCreditChain(
  note: { readonly originalMinor: bigint; readonly originalCarryingMinor: bigint; readonly remainingMinor: bigint; readonly remainingCarryingMinor: bigint },
  rows: readonly CreditChainRow[],
): void {
  const bad = (): never => refuse('supplier_credit_note.consumption_inconsistent', 'the consumers of the credit note do not form one chain');
  const ordered = [...rows].sort((a, b) => (a.remainingBeforeMinor > b.remainingBeforeMinor ? -1 : a.remainingBeforeMinor < b.remainingBeforeMinor ? 1 : 0));
  let consumed = 0n;
  let released = 0n;
  for (const r of ordered) {
    if (r.consumedMinor <= 0n || r.remainingBeforeMinor !== note.originalMinor - consumed) bad();
    consumed += r.consumedMinor;
    released += r.releasedBaseMinor;
  }
  if (consumed > note.originalMinor || note.remainingMinor !== note.originalMinor - consumed) bad();
  const g = creditRemainingCarrying(note.originalMinor, note.originalCarryingMinor, note.remainingMinor);
  if (note.remainingCarryingMinor !== g || released !== note.originalCarryingMinor - g) bad();
}
