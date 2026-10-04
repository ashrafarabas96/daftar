/**
 * The customer side of the accepted settlement arithmetic (P4-S4): a customer
 * payment allocation and a customer credit application.
 *
 * This is the mirror of `supplier-settlement.ts` / `supplier-settlement-payloads.ts`
 * with purchase → invoice and supplier credit note → customer credit
 * substituted. It computes, for each leg, the carrying release `rel`, the base
 * dust and the realized FX, and refuses an unlawful leg before any assertion is
 * minted — the DB routine and its COMMIT-time guards refuse all of it again
 * (`[[a wrapper is not an invariant]]`).
 *
 * THE ARITHMETIC IS IMPORTED, NEVER RE-IMPLEMENTED. `convertToBase`,
 * `apRelease`, `creditRemainingCarrying` and `creditRelease` come from
 * `./supplier-settlement`; a second body of them would be a duplicate
 * financial truth. See the comment at the first call site.
 *
 * Notation — an invoice: `T` total txn (`invoices.total_txn_minor`), `B` total
 * base, `Ri` its stored `source_to_base_rate`, `O` its outstanding txn AR as
 * `invoice_outstanding` reports it, `X = T − O` the AR already released. A
 * customer credit: `OA` original amount, `OB` original carrying base, `rb` the
 * remaining amount before a consumer, `Rn` its own stored snapshot.
 *
 * - `rel = apRelease(B, T, X, a) = HALF_EVEN(B·(X+a), T) − HALF_EVEN(B·X, T)`.
 *   A difference of two cumulative roundings of the STORED originals `B` and
 *   `T`; never a previous leg's already-rounded release.
 * - `ar_dust = rel − conv_Ri(a)`, posted as a second line on
 *   `accounts_receivable` itself (P4-S4 OQ-9), in base, sign by the dust.
 * - `cr_rel = g(rb) − g(rb − c)`, `credit_dust = cr_rel − conv_Rn(c)`, posted
 *   as a second line on `customer_credit_liability` (2210, OQ-9). The `max(1, …)`
 *   floor inside `g` is what makes the final consumption release the entire
 *   residue and strand nothing.
 * - The remaining imbalance is REALIZED FX and goes to `fx_gain` / `fx_loss`
 *   only — never to 6100 (`rounding`), 6200 or tax. A customer payment
 *   allocation realizes `pb − rel` and a credit application `cr_rel − rel`;
 *   because the customer side RECEIVES value where the supplier side pays it,
 *   a POSITIVE realized amount is a GAIN here (`fx_gain`, Cr) where it is a
 *   loss on the supplier side — the sign mirror of the accepted supplier
 *   refund, which also receives (`supplier-settlement.ts` `planRefund`).
 *
 * Money is integer `bigint` minor units bounded by `VALUE_LIMIT_MINOR`; a rate
 * is its R10. No float anywhere, one HALF_EVEN at the end of a computation,
 * and a rounded quotient is never an input to the next step.
 *
 * The sub-unit residue law (0067 R-77, R-78): a consumption may not leave a
 * remainder that converts to zero base minor units. `…amount_below_base_unit`
 * is judged BEFORE `…residue_below_base_unit`, exactly as the accepted code
 * and the SQL guards order them.
 *
 * NOT HERE, deliberately: the `invpl/1` field streams and intent digests of
 * `customer.collect_payment` and `customer.apply_credit`. `buildInventoryPayload`
 * and `inventoryIntentSha256` only accept an `InventoryOperationCode`, and
 * neither op code is registered in `INVENTORY_PAYLOAD_SCHEMAS` (`./payload`)
 * on this base. Registering them is an edit to `payload.ts`, which this slice
 * assigns elsewhere; the builders are a strict function of these plans.
 *
 * NOT HERE either: a `customer-settlement.ts` byte-equivalent twin of the SQL
 * primitives, which the implementation map §8.7 proposes. The build contract's
 * prohibition — "the settlement arithmetic is REUSED, never re-implemented" —
 * wins, so the generic primitives are imported from the supplier module.
 */
import { InventoryError } from './errors';
import { VALUE_LIMIT_MINOR } from './fixed-point';
// The four primitives of the accepted settlement arithmetic. The `supplier`
// and `ap` in these names are HISTORICAL — they were first needed on the
// purchase chain — but the arithmetic is GENERAL integer arithmetic over
// (total, base, released-before, applied) and (original, carrying, remaining):
// nothing in it is supplier-specific. The customer chain reuses them exactly,
// because a second body of this arithmetic would be a duplicate financial
// truth (0067:671/683/696 are the SQL twins, held to one vector file).
import { apRelease, convertToBase, creditRelease, creditRemainingCarrying, type SettlementConversion } from './supplier-settlement';

/** Allocations per customer payment, after `payments.allocation_count CHECK (BETWEEN 0 AND 50)`. */
export const CUSTOMER_PAYMENT_MAX_ALLOCATIONS = 50;

/**
 * The refusals this module raises, each in the domain its DB routine raises it
 * under: the `payments` document (`payment.*`) and the two accounting source
 * types (`customer_payment_allocation.*`, `customer_credit_application.*`,
 * P4-S4 OQ-6).
 *
 * They are a separate union from `InventoryErrorCode` because `errors.ts`
 * belongs to another agent's file set in this slice. Pure arithmetic and shape
 * verdicts still raise `InventoryError` with the accepted
 * `inventory.arithmetic_invalid` / `inventory.payload_invalid`, so one
 * vocabulary still spans the primitives.
 */
export type CustomerSettlementErrorCode =
  | 'payment.allocations_invalid'
  | 'payment.amount_below_base_unit'
  | 'customer_payment_allocation.amount_exceeds_outstanding'
  | 'customer_payment_allocation.amount_mismatch'
  | 'customer_payment_allocation.amount_below_base_unit'
  | 'customer_payment_allocation.residue_below_base_unit'
  | 'customer_credit_application.amount_exceeds_outstanding'
  | 'customer_credit_application.amount_exceeds_credit'
  | 'customer_credit_application.credit_exhausted'
  | 'customer_credit_application.amount_mismatch'
  | 'customer_credit_application.amount_below_base_unit'
  | 'customer_credit_application.residue_below_base_unit';

/** Typed, string-valued facts a refusal may carry beside its code. Never part of the message. */
export type CustomerSettlementErrorDetails = Readonly<Record<string, string | readonly string[]>>;

export class CustomerSettlementError extends Error {
  readonly code: CustomerSettlementErrorCode;
  readonly details: CustomerSettlementErrorDetails | undefined;

  constructor(code: CustomerSettlementErrorCode, message: string, details?: CustomerSettlementErrorDetails) {
    super(message);
    this.name = 'CustomerSettlementError';
    this.code = code;
    this.details = details === undefined ? undefined : Object.freeze({ ...details });
  }

  /** The only representation that should ever be logged or returned. */
  toSafeJSON(): { code: CustomerSettlementErrorCode } {
    return { code: this.code };
  }
}

function refuse(code: CustomerSettlementErrorCode, message: string): never {
  throw new CustomerSettlementError(code, message);
}

function invalid(message: string): never {
  throw new InventoryError('inventory.arithmetic_invalid', message);
}

function assertMinor(v: unknown, what: string, min: bigint): asserts v is bigint {
  if (typeof v !== 'bigint' || v < min || v > VALUE_LIMIT_MINOR) invalid(`${what} must be an integer amount within range`);
}

const abs = (v: bigint): bigint => (v < 0n ? -v : v);

const convert = (x: bigint, c: SettlementConversion): bigint => convertToBase(x, c.rateR10, c.txnExponent, c.baseExponent);

/** R-77 / R-78: a remaining amount of 0, or one converting to at least one base minor unit, is lawful; a sub-unit residue is not. */
const strands = (remainingMinor: bigint, c: SettlementConversion): boolean => remainingMinor > 0n && convert(remainingMinor, c) === 0n;

// ── The two states a leg computes from ───────────────────────────────────

/** The AR side of an invoice at the moment a settler computes from it: the mirror of `PurchaseApState`. */
export interface InvoiceArState {
  /** `T` = `invoices.total_txn_minor` (≥ 1; an invoice of zero is not representable, 0075:260). */
  readonly totalTxnMinor: bigint;
  /** `B`, the invoice's historical carrying base. */
  readonly totalBaseMinor: bigint;
  /** `O` = `invoice_outstanding(business, invoice)`, re-read under the invoice's own lock. */
  readonly outstandingTxnMinor: bigint;
  /** The invoice's STORED snapshot `Ri` (`invoices.source_to_base_rate`): never a new lookup. */
  readonly conversion: SettlementConversion;
}

/** The credit side of a customer credit at the moment a consumer computes from it: the mirror of `CreditNoteState`. */
export interface CustomerCreditState {
  /** `OA` = `customer_credits.original_amount_minor`, immutable. */
  readonly originalMinor: bigint;
  /** `OB` = `customer_credits.original_carrying_base_amount_minor`, immutable. */
  readonly originalCarryingMinor: bigint;
  /** `rb` = the stored `remaining_amount_minor`. */
  readonly remainingMinor: bigint;
  /** The credit's own stored snapshot `Rn`: every consumer reads it and never looks a rate up again. */
  readonly conversion: SettlementConversion;
}

// ── The entry lines ──────────────────────────────────────────────────────

/** The accounts a P4-S4 settlement entry may touch: never 6100 (`rounding`), 6200 or tax. */
export type CustomerSettlementAccount = 'accounts_receivable' | 'customer_credit_liability' | 'fx_gain' | 'fx_loss' | 'posting_account';

/**
 * One line of a customer settlement entry.
 *
 * - `currency`: the txn currency and snapshot the line carries — the invoice's
 *   (`invoice`, `Ri`), the credit's (`credit`, `Rn`), the payment's bound
 *   snapshot (`payment`, `Rp`), or `base` at rate 1.
 * - `dimension`: whose branch the line carries — the settled invoice's, or the
 *   credit's origin payment's. No line carries a warehouse.
 */
export interface CustomerSettlementEntryLine {
  readonly account: CustomerSettlementAccount;
  readonly side: 'D' | 'C';
  readonly currency: 'invoice' | 'credit' | 'payment' | 'base';
  readonly txnAmountMinor: bigint;
  readonly baseAmountMinor: bigint;
  readonly dimension: 'invoice' | 'origin';
}

function baseLine(account: CustomerSettlementAccount, side: 'D' | 'C', amount: bigint, dimension: 'invoice' | 'origin'): CustomerSettlementEntryLine {
  return { account, side, currency: 'base', txnAmountMinor: amount, baseAmountMinor: amount, dimension };
}

function balanced(lines: CustomerSettlementEntryLine[]): CustomerSettlementEntryLine[] {
  let balance = 0n;
  for (const l of lines) {
    if (l.baseAmountMinor <= 0n || l.txnAmountMinor <= 0n) invalid('an entry line carries positive amounts');
    balance += l.side === 'D' ? l.baseAmountMinor : -l.baseAmountMinor;
  }
  if (balance !== 0n) invalid('a settlement entry must balance');
  return lines;
}

// ── The AR side of one leg ───────────────────────────────────────────────

/** `X`, `rel`, `conv_Ri(a)` and the dust of one AR reducer: the mirror of `ApSide`. */
export interface CustomerArSide {
  /** `a`, in the invoice currency. */
  readonly appliedMinor: bigint;
  /** `X = T − O`, the chain position this leg computed from. */
  readonly releasedBeforeMinor: bigint;
  /** `rel`. */
  readonly carryingReleasedMinor: bigint;
  /** `conv_Ri(a)`. */
  readonly arConvertedMinor: bigint;
  /** `rel − conv_Ri(a)`, signed. */
  readonly arDustBaseMinor: bigint;
}

type ArDomain = 'customer_payment_allocation' | 'customer_credit_application';

function arSide(domain: ArDomain, invoice: InvoiceArState, appliedMinor: bigint): CustomerArSide {
  assertMinor(invoice.totalTxnMinor, 'an invoice txn total', 1n);
  assertMinor(invoice.totalBaseMinor, 'an invoice base total', 0n);
  assertMinor(invoice.outstandingTxnMinor, 'an outstanding AR', 0n);
  if (invoice.outstandingTxnMinor > invoice.totalTxnMinor) invalid('the outstanding AR exceeds the invoice total');
  if (typeof appliedMinor !== 'bigint' || appliedMinor <= 0n) invalid('an applied amount must be positive');
  if (appliedMinor > invoice.outstandingTxnMinor)
    refuse(`${domain}.amount_exceeds_outstanding`, 'the applied amount exceeds the outstanding AR of the invoice');
  const releasedBeforeMinor = invoice.totalTxnMinor - invoice.outstandingTxnMinor;
  const carryingReleasedMinor = apRelease(invoice.totalBaseMinor, invoice.totalTxnMinor, releasedBeforeMinor, appliedMinor);
  const arConvertedMinor = convert(appliedMinor, invoice.conversion);
  // A journal line needs base > 0. An applied amount that converts to 0 — the
  // txn-only residue of a very small foreign invoice included — is a stable
  // refusal, never a line of base 0. Judged BEFORE the residue law.
  if (arConvertedMinor === 0n) refuse(`${domain}.amount_below_base_unit`, 'the applied amount converts to less than one base minor unit');
  return { appliedMinor, releasedBeforeMinor, carryingReleasedMinor, arConvertedMinor, arDustBaseMinor: carryingReleasedMinor - arConvertedMinor };
}

function arLines(ar: CustomerArSide): CustomerSettlementEntryLine[] {
  const out: CustomerSettlementEntryLine[] = [
    {
      account: 'accounts_receivable',
      side: 'C',
      currency: 'invoice',
      txnAmountMinor: ar.appliedMinor,
      baseAmountMinor: ar.arConvertedMinor,
      dimension: 'invoice',
    },
  ];
  if (ar.arDustBaseMinor !== 0n) out.push(baseLine('accounts_receivable', ar.arDustBaseMinor > 0n ? 'C' : 'D', abs(ar.arDustBaseMinor), 'invoice'));
  return out;
}

// ── The credit side of one leg ───────────────────────────────────────────

/** `rb`, `cr_rel`, `conv_Rn(c)`, the dust and the credit's pair after it: the mirror of `CreditSide`. */
export interface CustomerCreditSide {
  /** `c`, in the credit currency. */
  readonly consumedMinor: bigint;
  /** `rb`, the level — and the level-uniqueness key. */
  readonly remainingBeforeMinor: bigint;
  /** `cr_rel = g(rb) − g(rb − c)`. */
  readonly creditReleasedMinor: bigint;
  /** `conv_Rn(c)`. */
  readonly creditConvertedMinor: bigint;
  /** `cr_rel − conv_Rn(c)`, signed. */
  readonly creditDustBaseMinor: bigint;
  readonly remainingAfterMinor: bigint;
  /** `g(rb − c)`. */
  readonly remainingCarryingAfterMinor: bigint;
}

function creditSide(credit: CustomerCreditState, consumedMinor: bigint): CustomerCreditSide {
  assertMinor(credit.originalMinor, 'a credit original amount', 1n);
  assertMinor(credit.originalCarryingMinor, 'a credit original carrying', 1n);
  assertMinor(credit.remainingMinor, 'a credit remaining amount', 0n);
  if (credit.remainingMinor > credit.originalMinor) invalid('a remaining credit exceeds the original credit');
  if (credit.remainingMinor === 0n) refuse('customer_credit_application.credit_exhausted', 'the customer credit has nothing remaining');
  if (typeof consumedMinor !== 'bigint' || consumedMinor <= 0n) invalid('a consumed amount must be positive');
  if (consumedMinor > credit.remainingMinor)
    refuse('customer_credit_application.amount_exceeds_credit', 'the consumed amount exceeds the remaining customer credit');
  const creditReleasedMinor = creditRelease(credit.originalMinor, credit.originalCarryingMinor, credit.remainingMinor, consumedMinor);
  const creditConvertedMinor = convert(consumedMinor, credit.conversion);
  if (creditConvertedMinor === 0n)
    refuse('customer_credit_application.amount_below_base_unit', 'the consumed amount converts to less than one base minor unit');
  const remainingAfterMinor = credit.remainingMinor - consumedMinor;
  return {
    consumedMinor,
    remainingBeforeMinor: credit.remainingMinor,
    creditReleasedMinor,
    creditConvertedMinor,
    creditDustBaseMinor: creditReleasedMinor - creditConvertedMinor,
    remainingAfterMinor,
    remainingCarryingAfterMinor: creditRemainingCarrying(credit.originalMinor, credit.originalCarryingMinor, remainingAfterMinor),
  };
}

function creditLines(cr: CustomerCreditSide): CustomerSettlementEntryLine[] {
  const out: CustomerSettlementEntryLine[] = [
    {
      account: 'customer_credit_liability',
      side: 'D',
      currency: 'credit',
      txnAmountMinor: cr.consumedMinor,
      baseAmountMinor: cr.creditConvertedMinor,
      dimension: 'origin',
    },
  ];
  if (cr.creditDustBaseMinor !== 0n)
    out.push(baseLine('customer_credit_liability', cr.creditDustBaseMinor > 0n ? 'D' : 'C', abs(cr.creditDustBaseMinor), 'origin'));
  return out;
}

/** The realized line: on the customer side a POSITIVE realized amount is a gain (Cr 4900), a negative one a loss (Dr 6900). */
function realizedLine(realizedMinor: bigint, dimension: 'invoice' | 'origin'): CustomerSettlementEntryLine {
  return baseLine(realizedMinor > 0n ? 'fx_gain' : 'fx_loss', realizedMinor > 0n ? 'C' : 'D', abs(realizedMinor), dimension);
}

// ── (a) One leg of a customer payment allocation ─────────────────────────

export interface CustomerPaymentAllocationInput {
  readonly invoice: InvoiceArState;
  /** `P = C`: the payment is in the invoice currency, so `p = a`. */
  readonly sameCurrency: boolean;
  /** `p` > 0, in the payment currency. */
  readonly paymentAmountMinor: bigint;
  /** The payment's bound snapshot `Rp`. */
  readonly payment: SettlementConversion;
  /** `a` > 0, in the invoice currency, ≤ `O`. */
  readonly appliedMinor: bigint;
}

/** Every amount one `payment_allocations` row stores and its entry posts. */
export interface CustomerPaymentAllocationPlan extends CustomerArSide {
  readonly paymentAmountMinor: bigint;
  /** `pb = conv_Rp(p)` — `payment_base_amount_minor`. */
  readonly paymentBaseMinor: bigint;
  /** `pb − rel` — `realized_fx_gain_loss_minor`; > 0 a gain (4900), < 0 a loss (6900). */
  readonly realizedMinor: bigint;
  readonly entryLines: readonly CustomerSettlementEntryLine[];
}

/**
 * One allocation of a customer payment to one invoice: `X`, `rel`, the AR dust
 * and the realized FX, with the entry it posts.
 *
 * Refusal order, exactly as the accepted supplier mirror and the SQL guards
 * order it: the chain cap (`amount_exceeds_outstanding`), then every
 * `amount_below_base_unit`, then `residue_below_base_unit`.
 */
export function planCustomerPaymentAllocation(input: CustomerPaymentAllocationInput): CustomerPaymentAllocationPlan {
  const p = input.paymentAmountMinor;
  if (typeof p !== 'bigint' || p <= 0n || p > VALUE_LIMIT_MINOR) refuse('payment.allocations_invalid', 'a payment amount must be positive');
  if (input.sameCurrency && p !== input.appliedMinor)
    refuse('customer_payment_allocation.amount_mismatch', 'a payment in the invoice currency collects exactly what it applies');
  const ar = arSide('customer_payment_allocation', input.invoice, input.appliedMinor);
  const paymentBaseMinor = convert(p, input.payment);
  if (paymentBaseMinor === 0n) refuse('customer_payment_allocation.amount_below_base_unit', 'the payment amount converts to less than one base minor unit');
  if (strands(input.invoice.outstandingTxnMinor - ar.appliedMinor, input.invoice.conversion))
    refuse(
      'customer_payment_allocation.residue_below_base_unit',
      'the allocation would leave the invoice an outstanding amount converting to less than one base minor unit',
    );
  const realizedMinor = paymentBaseMinor - ar.carryingReleasedMinor;
  const lines = arLines(ar);
  lines.unshift({ account: 'posting_account', side: 'D', currency: 'payment', txnAmountMinor: p, baseAmountMinor: paymentBaseMinor, dimension: 'invoice' });
  if (realizedMinor !== 0n) lines.push(realizedLine(realizedMinor, 'invoice'));
  return { ...ar, paymentAmountMinor: p, paymentBaseMinor, realizedMinor, entryLines: balanced(lines) };
}

// ── (b) A customer credit application ────────────────────────────────────

export interface CustomerCreditApplicationInput {
  readonly invoice: InvoiceArState;
  readonly credit: CustomerCreditState;
  /** The credit currency is the invoice currency, so `c = a`. */
  readonly sameCurrency: boolean;
  /** `c` > 0, in the credit currency, ≤ `rb`. */
  readonly consumedMinor: bigint;
  /** `a` > 0, in the invoice currency, ≤ `O`. */
  readonly appliedMinor: bigint;
}

/** Every amount one `customer_credit_applications` row stores and its entry posts. */
export interface CustomerCreditApplicationPlan extends CustomerArSide, CustomerCreditSide {
  /** `cr_rel − rel` — `realized_fx_gain_loss_minor`; > 0 a gain (4900), < 0 a loss (6900). */
  readonly realizedMinor: bigint;
  readonly entryLines: readonly CustomerSettlementEntryLine[];
}

/**
 * One application of a customer credit to one invoice: the credit release, the
 * AR release, both dusts and the realized FX, with the entry it posts.
 *
 * The credit side is judged first — `credit_exhausted`, then
 * `amount_exceeds_credit` — exactly as the accepted supplier mirror orders it,
 * and the residue law is judged last, over BOTH remainders.
 */
export function planCustomerCreditApplication(input: CustomerCreditApplicationInput): CustomerCreditApplicationPlan {
  const cr = creditSide(input.credit, input.consumedMinor);
  if (input.sameCurrency && input.consumedMinor !== input.appliedMinor)
    refuse('customer_credit_application.amount_mismatch', 'a credit in the invoice currency applies exactly what it consumes');
  const ar = arSide('customer_credit_application', input.invoice, input.appliedMinor);
  if (strands(input.invoice.outstandingTxnMinor - ar.appliedMinor, input.invoice.conversion) || strands(cr.remainingAfterMinor, input.credit.conversion))
    refuse(
      'customer_credit_application.residue_below_base_unit',
      'the application would leave the invoice or the credit a remaining amount converting to less than one base minor unit',
    );
  const realizedMinor = cr.creditReleasedMinor - ar.carryingReleasedMinor;
  const lines = [...creditLines(cr), ...arLines(ar)];
  if (realizedMinor !== 0n) lines.push(realizedLine(realizedMinor, 'invoice'));
  return { ...ar, ...cr, realizedMinor, entryLines: balanced(lines) };
}

// ── (c) The whole payment document, and its closure law ──────────────────

/** One leg of a customer payment, in `line_no` order. */
export interface CustomerPaymentLeg {
  readonly invoice: InvoiceArState;
  /** The payment currency is this invoice's currency, so `p = a`. */
  readonly sameCurrency: boolean;
  /** `p_i` > 0, in the payment currency: the money THIS leg consumes. */
  readonly paymentAmountMinor: bigint;
  /** `a_i` > 0, in the invoice currency. */
  readonly appliedMinor: bigint;
}

export interface CustomerPaymentInput {
  /** `payments.amount_minor`: the money received, a document fact. */
  readonly amountMinor: bigint;
  /** The payment's bound snapshot `Rp`. */
  readonly payment: SettlementConversion;
  /** 0..50 legs, in `line_no` order. A payment with none is a pure on-account collection (OQ-4). */
  readonly legs: readonly CustomerPaymentLeg[];
}

/** Every amount the `payments` row and, when there is a surplus, the `customer_credits` row it bears store. */
export interface CustomerPaymentPlan {
  readonly amountMinor: bigint;
  /** `Σ pb_i + OB` — a sum of single roundings, never `conv(Σ p_i)`. */
  readonly baseAmountMinor: bigint;
  /** `payments.allocation_count`, 0..50. */
  readonly allocationCount: number;
  readonly allocations: readonly CustomerPaymentAllocationPlan[];
  /** The surplus the payment carries into a new `customer_credits` row: `OA`, 0 when fully allocated. */
  readonly creditCreatedMinor: bigint;
  /** `OB = conv_Rp(OA)`, 0 when there is no surplus. */
  readonly creditCarryingBaseMinor: bigint;
  /** The entry the surplus owes, empty when there is none. No dust and no FX: one conversion feeds both lines. */
  readonly creditEntryLines: readonly CustomerSettlementEntryLine[];
}

/**
 * A whole customer payment: every leg planned, plus the closure law.
 *
 * The closure the document genuinely owes is
 * `Σ payment_amount_minor + credit created = amount_minor`, all three in the
 * PAYMENT currency and at the payment's own rate — the currency-coherent form
 * of the accepted `supplier_payment_complete()` rule
 * (`Σ payment_amount_minor = amount_minor`, 0067:938-960), relaxed to
 * `allocation_count ≥ 0` so a pure on-account collection is representable
 * (map §8.1 Departure 1, OQ-4). It is NOT
 * `payment.amount == invoice paid amount`: no leg's invoice-currency `a_i`
 * appears in it.
 */
export function planCustomerPayment(input: CustomerPaymentInput): CustomerPaymentPlan {
  const amountMinor = input.amountMinor;
  if (typeof amountMinor !== 'bigint' || amountMinor <= 0n || amountMinor > VALUE_LIMIT_MINOR)
    refuse('payment.allocations_invalid', 'a payment amount must be positive');
  if (!Array.isArray(input.legs) || input.legs.length > CUSTOMER_PAYMENT_MAX_ALLOCATIONS)
    refuse('payment.allocations_invalid', `a payment has 0..${CUSTOMER_PAYMENT_MAX_ALLOCATIONS} allocations`);
  const allocations: CustomerPaymentAllocationPlan[] = [];
  let allocated = 0n;
  let baseAmountMinor = 0n;
  for (const leg of input.legs) {
    const plan = planCustomerPaymentAllocation({ ...leg, payment: input.payment });
    allocated += plan.paymentAmountMinor;
    baseAmountMinor += plan.paymentBaseMinor;
    allocations.push(plan);
  }
  if (allocated > amountMinor) refuse('payment.allocations_invalid', 'a payment allocates no more than it received');
  const creditCreatedMinor = amountMinor - allocated;
  let creditCarryingBaseMinor = 0n;
  const creditEntryLines: CustomerSettlementEntryLine[] = [];
  if (creditCreatedMinor > 0n) {
    creditCarryingBaseMinor = convert(creditCreatedMinor, input.payment);
    // `customer_credits.original_carrying_base_amount_minor` is CHECK (>= 1):
    // a surplus that converts to nothing is not a representable credit.
    if (creditCarryingBaseMinor === 0n) refuse('payment.amount_below_base_unit', 'the surplus converts to less than one base minor unit');
    baseAmountMinor += creditCarryingBaseMinor;
    creditEntryLines.push(
      {
        account: 'posting_account',
        side: 'D',
        currency: 'payment',
        txnAmountMinor: creditCreatedMinor,
        baseAmountMinor: creditCarryingBaseMinor,
        dimension: 'origin',
      },
      {
        account: 'customer_credit_liability',
        side: 'C',
        currency: 'payment',
        txnAmountMinor: creditCreatedMinor,
        baseAmountMinor: creditCarryingBaseMinor,
        dimension: 'origin',
      },
    );
    balanced(creditEntryLines);
  }
  return {
    amountMinor,
    baseAmountMinor,
    allocationCount: input.legs.length,
    allocations,
    creditCreatedMinor,
    creditCarryingBaseMinor,
    creditEntryLines,
  };
}
