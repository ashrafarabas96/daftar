/**
 * The refund and credit-note PLAN LAYER of P4-S5 (maturity level A/B).
 *
 * ## Why it lives here and not in `packages/inventory`
 *
 * S4's AR settlement arithmetic began life at
 * `apps/api/src/modules/receivables/customer-settlement.ts` and was later
 * reconciled into `packages/inventory/src/customer-settlement.ts`, with the API
 * file kept as a re-export. That is where this module belongs too, and
 * `PATCH-REQ-S5-004` is the request to move it there at promotion. It is NOT
 * written there now because `packages/inventory` holds the inventory primitives
 * and the Phase 4 operation vocabulary, and there is exactly one owner of those
 * in this phase; a slice in development editing them is how two slices land one
 * conflicting change in a primitive the whole estate depends on.
 *
 * ## It implements NO arithmetic of its own
 *
 * «The settlement arithmetic is REUSED, never re-implemented.» Every number
 * below comes out of an accepted primitive imported from `@daftar/inventory`:
 *
 * - `convertToBase(x, R, e_t, e_b)` — the twin of `supplier_convert_base`
 *   (`0067:671`);
 * - `creditRemainingCarrying(OA, OB, r) = g(r)` — the twin of
 *   `supplier_credit_remaining_carrying` (`0067:696`);
 * - `creditRelease(OA, OB, rb, c) = g(rb) − g(rb − c)`;
 * - `verifyCreditChain(...)` — the twin of `supplier_credit_note_verify`, and
 *   the twin S5 needs of the widened `customer_credit_verify` (`0081:879`).
 *
 * There is no `HALF_EVEN`, no rounding function, no release formula and no
 * `10n ** 18n` in this file. The `supplier_` and `ap_` in those names is
 * HISTORICAL: the bodies are plain `BIGINT` half-even arithmetic over
 * `(total, carrying, level, amount)` and carry nothing supplier-specific, which
 * is why `0067` declares them `IMMUTABLE` over scalars. Releasing a customer
 * credit's carrying base is the same function as releasing a supplier credit
 * note's.
 *
 * ## The one shape that is new, and the one that deliberately is not
 *
 * NEW: the source is `credit_note` XOR `customer_credit`, so one plan function
 * serves two source kinds. It serves them by taking a `ConsumableSource` — the
 * remaining PAIR plus the stored snapshot — which is the shape BOTH kinds
 * already have. There is no branch on the kind inside the arithmetic; the kind
 * decides only which liability account the entry names
 * (`refundLiabilityAccount`), and that decision is made once, in
 * `@daftar/domain-core`.
 *
 * NOT NEW: `planCustomerRefund` is `planRefund` (`supplier-settlement.ts:394`)
 * with AP replaced by the customer liability and the receipt replaced by a
 * disbursement — the money moves the other way, and the signs follow from that
 * and from nothing else. It is the accepted supplier refund, mirrored, because
 * `TL-P4-S5-R1` and P4-AL-22 describe the same mechanism on the AR side.
 *
 * ## `TL-P4-S5-R1`, structurally
 *
 * `planCustomerRefund` takes NO invoice, returns NO invoice and its entry's
 * account set (`REFUND_ENTRY_ACCOUNTS`) excludes `accounts_receivable`. So a
 * refund cannot reduce AR: not "does not", cannot. `assertNoReceivableLine`
 * below is the belt on the braces and `tests/guards/p4s5-refund-plan-red-proofs.test.ts`
 * plants an AR line to prove it goes red.
 */
import {
  type ConsumableSourceCap,
  type ReturnsRefusalCode,
  creditNoteCogsReversalBaseMinor,
  creditNoteTaxRefusal,
  isCreditNoteEntryAccount,
  isRefundEntryAccount,
  refundCapRefusal,
  refundLiabilityAccount,
  type CreditNoteEntryAccount,
  type RefundEntryAccount,
  type ReturnedMovementValue,
} from '@daftar/domain-core';
import {
  VALUE_LIMIT_MINOR,
  apRelease,
  convertToBase,
  creditRelease,
  creditRemainingCarrying,
  ReceivableArithmeticError,
  planCustomerCreditApplication,
  verifyCreditChain,
  type CustomerCreditApplicationPlan,
  type CustomerCreditState,
  type InvoiceArState,
  type ReceivableArithmeticCode,
  type ReceivableEntryLine,
} from '@daftar/inventory';

/**
 * A refusal of the plan layer. A plain class carrying one code of the closed
 * S5 vocabulary, so `returns-errors.ts` can classify it by TABLE and never by
 * the shape of a name. No message here carries an account code, a routine
 * name, a constraint name or an amount (P4-AL-54).
 */
export class ReturnsPlanError extends Error {
  constructor(
    readonly code: ReturnsRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReturnsPlanError';
  }
}

const refuse = (code: ReturnsRefusalCode, message: string): never => {
  throw new ReturnsPlanError(code, message);
};

const abs = (v: bigint): bigint => (v < 0n ? -v : v);

// ── Snapshots and sources ───────────────────────────────────────────────

/**
 * A stored or bound FX snapshot, as this layer reads it. The same three fields
 * as `@daftar/inventory`'s `SettlementConversion`, restated as a local alias so
 * the call sites read in S5's own vocabulary; the values are passed straight
 * through to `convertToBase` and nothing is recomputed.
 */
export interface ReturnsConversion {
  /** rate × 10^10; exactly 10^10 for the base currency. */
  readonly rateR10: bigint;
  readonly txnExponent: number;
  readonly baseExponent: number;
}

const convert = (x: bigint, c: ReturnsConversion): bigint => convertToBase(x, c.rateR10, c.txnExponent, c.baseExponent);

/** A remaining amount of 0, or one converting to at least one base minor unit, is lawful; a sub-unit residue is not. */
const strands = (remainingMinor: bigint, c: ReturnsConversion): boolean => remainingMinor > 0n && convert(remainingMinor, c) === 0n;

/**
 * The source a refund draws on, at the moment the refund computes from it —
 * read under `FOR UPDATE`, in the refund's own transaction.
 *
 * One shape for both kinds. `kind` is carried only so the entry can name the
 * right liability; no arithmetic below branches on it.
 */
export interface ConsumableSource extends ConsumableSourceCap {
  readonly originalCarryingMinor: bigint;
  /** The source's OWN stored snapshot. Never a fresh lookup: a consumer computes from the source's rate, not today's. */
  readonly conversion: ReturnsConversion;
}

// ── The entry lines ─────────────────────────────────────────────────────

/**
 * One line of an S5 entry.
 *
 * `currency` names which snapshot the line carries — the source's, the
 * disbursement's bound one, or `base` at rate 1. Both amounts are positive on
 * every line and the side carries the direction, the accepted
 * `SettlementEntryLine` convention: a negative amount on a line is how a
 * balanced-looking entry hides an unbalanced one.
 */
export interface ReturnsEntryLine {
  readonly account: RefundEntryAccount | CreditNoteEntryAccount;
  readonly side: 'D' | 'C';
  readonly currency: 'source' | 'disbursement' | 'invoice' | 'base';
  readonly txnAmountMinor: bigint;
  readonly baseAmountMinor: bigint;
}

const baseLine = (account: RefundEntryAccount | CreditNoteEntryAccount, side: 'D' | 'C', amount: bigint): ReturnsEntryLine =>
  Object.freeze({ account, side, currency: 'base' as const, txnAmountMinor: amount, baseAmountMinor: amount });

/**
 * Every line positive, and the entry balanced IN BASE.
 *
 * It balances by construction rather than by a rounding account: P4-AL-19, and
 * «no rounding account is invented to make arithmetic balance». An entry that
 * does not balance is a defect of this module, so the code is the 500
 * `customer_refund.arithmetic_invalid` and never a merchant-facing refusal.
 */
function balanced(lines: readonly ReturnsEntryLine[]): readonly ReturnsEntryLine[] {
  let balance = 0n;
  for (const l of lines) {
    if (l.baseAmountMinor <= 0n || l.txnAmountMinor <= 0n) refuse('customer_refund.arithmetic_invalid', 'an entry line carries positive amounts');
    balance += l.side === 'D' ? l.baseAmountMinor : -l.baseAmountMinor;
  }
  if (balance !== 0n) refuse('customer_refund.arithmetic_invalid', 'an entry must balance');
  return Object.freeze([...lines]);
}

/**
 * `TL-P4-S5-R1`, asserted over the produced lines.
 *
 * The account set already makes `accounts_receivable` unexpressible on a refund
 * entry — `isRefundEntryAccount` refuses it and the type union does not contain
 * it. This function is the runtime half, so the law has a REACHABLE refusal and
 * therefore a red proof: a test constructs the forbidden line through a cast,
 * calls this, and watches it raise. A guard never shown able to fail is not a
 * guard.
 */
export function assertNoReceivableLine(lines: readonly ReturnsEntryLine[]): void {
  for (const l of lines) {
    if (!isRefundEntryAccount(l.account)) {
      refuse('customer_refund.arithmetic_invalid', 'a refund entry names only its liability, the posting account and realized FX');
    }
  }
}

// ── The consumed side of a source (the mirror of `creditSide`) ──────────

/** What consuming `c` from a source releases, and the pair the source is left with. */
export interface ConsumedSide {
  readonly consumedMinor: bigint;
  /** `rb`: the LEVEL, the source's remaining as locked. */
  readonly remainingBeforeMinor: bigint;
  readonly carryingReleasedMinor: bigint;
  readonly convertedMinor: bigint;
  readonly dustBaseMinor: bigint;
  readonly remainingAfterMinor: bigint;
  readonly remainingCarryingAfterMinor: bigint;
}

/**
 * The consumed side, computed from the LOCKED source only.
 *
 * The cap is `refundCapRefusal`'s — one body, in `@daftar/domain-core`, so the
 * API, the tests and the concurrency models all ask the same question. It is
 * asked HERE, after the caller has taken the lock and against the remaining the
 * lock returned, never against a remaining read earlier in the request.
 *
 * `remainingCarryingAfterMinor` is `g(remaining_after)` computed from the
 * ORIGINAL pair — never from an already-rounded intermediate value. That is the
 * condition `customer_credit_guard` (`0081:1090-1117`) enforces on the row, and
 * computing it any other way here would produce a plan the database refuses.
 */
export function consumedSide(source: ConsumableSource, consumedMinor: bigint): ConsumedSide {
  const capProblem = refundCapRefusal(source, consumedMinor);
  if (capProblem !== null) refuse(capProblem, 'the refund is not within the source cap');
  if (consumedMinor > VALUE_LIMIT_MINOR) refuse('customer_refund.amount_invalid', 'an amount must be within range');
  const carryingReleasedMinor = creditRelease(source.originalMinor, source.originalCarryingMinor, source.remainingMinor, consumedMinor);
  const convertedMinor = convert(consumedMinor, source.conversion);
  if (convertedMinor === 0n) refuse('customer_refund.amount_below_base_unit', 'the consumed amount converts to less than one base minor unit');
  const remainingAfterMinor = source.remainingMinor - consumedMinor;
  if (strands(remainingAfterMinor, source.conversion)) {
    refuse('customer_refund.residue_below_base_unit', 'the refund would leave the source a remaining amount converting to less than one base minor unit');
  }
  return Object.freeze({
    consumedMinor,
    remainingBeforeMinor: source.remainingMinor,
    carryingReleasedMinor,
    convertedMinor,
    dustBaseMinor: carryingReleasedMinor - convertedMinor,
    remainingAfterMinor,
    remainingCarryingAfterMinor: creditRemainingCarrying(source.originalMinor, source.originalCarryingMinor, remainingAfterMinor),
  });
}

// ── (a) A customer refund ───────────────────────────────────────────────

export interface CustomerRefundInput {
  readonly source: ConsumableSource;
  /** `c` > 0, in the source's currency, ≤ the locked remaining. */
  readonly consumedMinor: bigint;
  /** True when the money leaves in the source's own currency, so `d = c` (the A-10 condition). */
  readonly sameCurrency: boolean;
  /** `d` > 0, in the disbursement currency. */
  readonly disbursementAmountMinor: bigint;
  /** The disbursement's BOUND snapshot (A-15): bound by the command, never re-read while posting. */
  readonly disbursement: ReturnsConversion;
}

/** Every amount one `refunds` row stores and its entry posts. */
export interface CustomerRefundPlan extends ConsumedSide {
  /**
   * Which liability the refund discharges — `customer_refund_liability` for a
   * credit note, `customer_credit_liability` for a customer credit.
   *
   * The plan carries the ACCOUNT and deliberately not the source KIND. A field
   * named `sourceKind` would be a discriminator beside the two source ids, and
   * `forbiddenRefundFields` refuses that name on every shape of this slice for
   * the GOLD-74 reason — so the plan does not get a private exemption from a law
   * the row obeys. The caller already knows the kind: it passed the source.
   */
  readonly liabilityAccount: ReturnType<typeof refundLiabilityAccount>;
  readonly disbursementAmountMinor: bigint;
  /** `db = conv_Rd(d)`. */
  readonly disbursementBaseMinor: bigint;
  /** `cr_rel − db`, signed: > 0 a gain (4900), < 0 a loss (6900). */
  readonly realizedMinor: bigint;
  readonly entryLines: readonly ReturnsEntryLine[];
}

/**
 * The plan of one refund.
 *
 * The entry, in the merchant's direction of travel: the liability the source
 * represents is DISCHARGED (debit) and the posting account the money left from
 * is CREDITED.
 *
 * ```
 *   Dr customer_refund_liability (2200)   | a refund on a credit note
 *   Dr customer_credit_liability (2210)   | a refund on a customer credit
 *      Cr <posting account>
 *      ± realized FX  (4900 gain / 6900 loss)
 * ```
 *
 * `0081:1594` already debits `customer_credit_liability` when a credit is
 * consumed by an application, so the second line of that table is not a new
 * model of anything: it is the same debit reached through a different consumer.
 *
 * **There is no `accounts_receivable` line and no invoice anywhere in the
 * signature.** AR fell once, when the credit note was issued and applied; this
 * command moves the liability and the cash and nothing else.
 *
 * The realized FX is `cr_rel − db`: the base the source gives up, less the base
 * the money cost. The sign convention follows the accepted supplier refund
 * (`supplier-settlement.ts:408`) read in the opposite direction of travel, and
 * nothing here invents it.
 */
export function planCustomerRefund(input: CustomerRefundInput): CustomerRefundPlan {
  const consumed = consumedSide(input.source, input.consumedMinor);
  const d = input.disbursementAmountMinor;
  if (typeof d !== 'bigint' || d <= 0n || d > VALUE_LIMIT_MINOR) refuse('customer_refund.amount_invalid', 'a disbursement amount must be positive');
  if (input.sameCurrency && d !== input.consumedMinor) {
    refuse('customer_refund.amount_mismatch', 'a refund in the source currency pays out exactly what it consumes');
  }
  const disbursementBaseMinor = convert(d, input.disbursement);
  if (disbursementBaseMinor === 0n) refuse('customer_refund.amount_below_base_unit', 'the disbursement converts to less than one base minor unit');

  const liabilityAccount = refundLiabilityAccount(input.source.kind);
  const lines: ReturnsEntryLine[] = [
    Object.freeze({
      account: liabilityAccount,
      side: 'D' as const,
      currency: 'source' as const,
      txnAmountMinor: consumed.consumedMinor,
      baseAmountMinor: consumed.convertedMinor,
    }),
  ];
  // The dust is the gap between the source's converted amount and the carrying
  // base it actually releases. It lands on the SAME liability account, exactly
  // as `0081:1597` lands the credit dust on 2210 — not on 6100. P4-AL-19.
  if (consumed.dustBaseMinor !== 0n) lines.push(baseLine(liabilityAccount, consumed.dustBaseMinor > 0n ? 'D' : 'C', abs(consumed.dustBaseMinor)));
  lines.push(
    Object.freeze({
      account: 'posting_account' as const,
      side: 'C' as const,
      currency: 'disbursement' as const,
      txnAmountMinor: d,
      baseAmountMinor: disbursementBaseMinor,
    }),
  );
  const realizedMinor = consumed.carryingReleasedMinor - disbursementBaseMinor;
  // F5: the realized FX is BOUNDED by the liability it arises on.
  //
  // `realized = cr_rel − db`, so `|realized| ≤ max(cr_rel, db)` is arithmetic
  // and says nothing. The bound that says something is `|realized| ≤ cr_rel`:
  // the exchange movement on discharging a liability cannot exceed the
  // liability. It fails exactly when `db > 2·cr_rel` — a disbursement costing
  // more than twice the carrying base the source gives up, which is a rate
  // wrong by over 100% and not a refund anybody meant to make. Without it the
  // plan will post an `fx_loss` line of unbounded size from a mistyped rate and
  // balance perfectly while doing so.
  //
  // `fx_rate_changed` rather than `arithmetic_invalid`: the arithmetic is
  // correct, the RATE is not, and the caller's remedy is to rebind the snapshot
  // and retry — which is a 409 and not a 500.
  if (abs(realizedMinor) > consumed.carryingReleasedMinor) {
    refuse('customer_refund.fx_rate_changed', 'the realized exchange movement exceeds the liability it arises on');
  }
  if (realizedMinor !== 0n) lines.push(baseLine(realizedMinor > 0n ? 'fx_gain' : 'fx_loss', realizedMinor > 0n ? 'C' : 'D', abs(realizedMinor)));

  const entryLines = balanced(lines);
  assertNoReceivableLine(entryLines);
  const plan: CustomerRefundPlan = Object.freeze({
    ...consumed,
    liabilityAccount,
    disbursementAmountMinor: d,
    disbursementBaseMinor,
    realizedMinor,
    entryLines,
  });
  // `TL-P4-S5-R2`: the liability absorbs no unrecorded FX, and the four terms
  // reconcile exactly in integer minor units.
  assertRefundEntryComplete(plan);
  return plan;
}

// ── (b) A credit note's revenue and COGS reversal ───────────────────────

export interface CreditNoteReversalInput {
  /** The credit note's total in its own currency, > 0. */
  readonly totalMinor: bigint;
  /** The note's own stored snapshot. */
  readonly conversion: ReturnsConversion;
  /** Structural zero (OD-03 OPEN). Any other value is refused here and by `CHECK (tax_minor = 0)` in the row. */
  readonly taxMinor: string;
  /** The return's stock movements, with their EXACT stored value deltas. Never a quantity and an average. */
  readonly returnedMovements: readonly ReturnedMovementValue[];
}

export interface CreditNoteReversalPlan {
  readonly totalBaseMinor: bigint;
  readonly cogsReversalBaseMinor: bigint;
  /** The revenue-reversal entry: 4100 debited, 2200 credited, for the WHOLE total. */
  readonly revenueEntryLines: readonly ReturnsEntryLine[];
  /** The COGS-reversal entry: 1200 debited, 5000 credited, at the exact stored deltas. */
  readonly cogsEntryLines: readonly ReturnsEntryLine[];
}

/**
 * The two entries a credit note implies, at their two grains.
 *
 * ```
 *   revenue reversal   Dr sales_returns (4100)   total, in the note's currency
 *                         Cr customer_refund_liability (2200)   the same total
 *
 *   COGS reversal      Dr inventory (1200)       Σ exact stored value deltas
 *                         Cr cogs (5000)
 * ```
 *
 * Three things are deliberate and each has a law behind it.
 *
 * 1. **The debit is `sales_returns` (4100), not a negative `sales_revenue`.**
 *    `packages/accounting/src/sale-posting.ts:31` records in its own words that
 *    "4100 is the RETURN account and belongs to P4-S5". A contra-revenue account
 *    exists so that returns are visible rather than netted away, and a negative
 *    line is refused by `balanced` anyway.
 * 2. **THIS ENTRY CARRIES NO `accounts_receivable` LINE, AND NO INVOICE.**
 *    Issuing a credit note creates a liability for its whole total; whether and
 *    how much of that liability is then set against an invoice is the business
 *    of `planCreditNoteApplication` below, one row of
 *    `credit_note_applications` at a time, through the canonical AR arithmetic.
 *    Splitting the total here would be a SECOND place AR falls and a second
 *    algorithm for how far it falls — computed, moreover, at the NOTE's FX
 *    snapshot rather than the invoice's, which is not what the invoice's stored
 *    `(total, carrying)` pair says. So the note's own entry converts the total
 *    ONCE and stops, and the comment below about "one header conversion" is
 *    true because there is now exactly one conversion in this function.
 * 3. **The COGS reversal has no rounding, because it has no arithmetic.** Its
 *    amount is `creditNoteCogsReversalBaseMinor`, the sum of the stock writer's
 *    own stored integers. There is no `quantity`, no `unitCost` and no
 *    `averageCost` in the input shape, so the second rounding
 *    `[[daftar-rounding-is-not-additive]]` warns about is unexpressible rather
 *    than merely forbidden. The movements themselves are written by the one
 *    accepted stock-movement authority; this module only reads what it wrote.
 */
export function planCreditNoteReversal(input: CreditNoteReversalInput): CreditNoteReversalPlan {
  const taxProblem = creditNoteTaxRefusal(input.taxMinor);
  if (taxProblem !== null) refuse(taxProblem, 'sales tax is structurally zero in this estate');
  if (typeof input.totalMinor !== 'bigint' || input.totalMinor <= 0n || input.totalMinor > VALUE_LIMIT_MINOR) {
    refuse('credit_note.amount_invalid', 'a credit note total must be positive');
  }

  // The ONE conversion of this function. The note's total becomes base at the
  // note's own stored snapshot, and nothing else in this entry is converted —
  // so the second HALF_EVEN rounding that `[[daftar-rounding-is-not-additive]]`
  // warns about, and the worked example at
  // `packages/accounting/src/sale-posting.ts:44-59`, is unexpressible here
  // rather than merely avoided.
  const totalBaseMinor = convert(input.totalMinor, input.conversion);
  if (totalBaseMinor === 0n) refuse('credit_note.amount_below_base_unit', 'the credit note total converts to less than one base minor unit');

  const revenue: ReturnsEntryLine[] = [
    Object.freeze({
      account: 'sales_returns' as const,
      side: 'D' as const,
      currency: 'source' as const,
      txnAmountMinor: input.totalMinor,
      baseAmountMinor: totalBaseMinor,
    }),
    Object.freeze({
      account: 'customer_refund_liability' as const,
      side: 'C' as const,
      currency: 'source' as const,
      txnAmountMinor: input.totalMinor,
      baseAmountMinor: totalBaseMinor,
    }),
  ];

  const cogs = creditNoteCogsReversalBaseMinor(input.returnedMovements);
  // `throw` rather than `refuse(...)`, so the discriminated union narrows for the
  // reader as well as for the compiler: below this line `cogs` is the `ok` branch
  // and `cogs.baseMinor` is a `bigint`, not a union member nobody has checked.
  if (!cogs.ok) {
    throw new ReturnsPlanError(cogs.code, 'a COGS reversal is the sum of the stored movement value deltas and nothing else');
  }
  const cogsEntryLines = balanced([baseLine('inventory', 'D', cogs.baseMinor), baseLine('cogs', 'C', cogs.baseMinor)]);
  const revenueEntryLines = balanced(revenue);
  // `TL-P4-S5-R2` limb 1, asserted and not assumed: this entry reduces no
  // receivable. It is unexpressible by type and refused at runtime, and the red
  // proof plants the exact line that was deleted from this function.
  assertReturnEntryReducesNoReceivable(revenueEntryLines);
  for (const l of [...revenueEntryLines, ...cogsEntryLines]) {
    if (!isCreditNoteEntryAccount(l.account)) refuse('customer_refund.arithmetic_invalid', 'a credit note entry names only its seven accounts');
  }
  return Object.freeze({
    totalBaseMinor,
    cogsReversalBaseMinor: cogs.baseMinor,
    revenueEntryLines,
    cogsEntryLines,
  });
}

// ── (b2) One application of a credit note to an invoice ─────────────────

/**
 * The ONE place in this slice where `accounts_receivable` falls, and it does
 * not compute how far.
 *
 * ## Why this delegates instead of implementing
 *
 * «ONE canonical algorithm for AR.» An application of a credit note to an
 * invoice is arithmetically the SAME operation as an application of a customer
 * credit to an invoice: a consumer with a stored `(original, original_carrying,
 * remaining)` triple and its own FX snapshot releases `c` against an invoice
 * with its own stored `(total, carrying)` pair and snapshot, at the invoice's
 * level `X = T − O`. Every number — the level, the AR release `rel = R(X + a) −
 * R(X)`, the converted principal `conv_R(a)`, the dust `rel − conv_R(a)` on the
 * SAME account, the consumer's `cr_rel`, and the realized FX `cr_rel − rel` —
 * is a number `planCustomerCreditApplication`
 * (`packages/inventory/src/customer-settlement.ts:593`) already computes, and
 * its `CustomerCreditApplicationPlan extends ArSide, CreditSide` carries
 * exactly the seven amounts `credit_note_applications` stores and its
 * `*_realized_ck` constrains.
 *
 * It delegates rather than calling the pieces because the pieces are not
 * callable: `arSide` (`:312`), `arLines` (`:441`), `creditSide` (`:360`),
 * `creditLines` (`:457`), `realizedLines` (`:479`) and `balanced` (`:420`) are
 * all MODULE-PRIVATE in that file, and `packages/inventory` is single-owner in
 * this phase, so widening their visibility is a patch request and not an edit I
 * may make (and a widening that only one caller wants is a poor trade anyway).
 * The single canonical statement is therefore:
 *
 *   **A credit-note application IS a customer-credit application with one
 *   account relabelled.**
 *
 * ## The one difference, and its scope
 *
 * `creditLines` hardcodes `customer_credit_liability` (2210) because a customer
 * credit IS that liability. A credit note's liability is
 * `customer_refund_liability` (2200) — the one `planCreditNoteReversal` raised
 * above. So the plan's lines are passed through `returnsLineOfReceivableLine`,
 * which relabels 2210 → 2200 and leaves every other account, every side and
 * every amount untouched, and the result is re-run through this module's own
 * `balanced` so the relabelling is PROVED not to have disturbed the entry
 * rather than assumed not to have. `PATCH-REQ-S5-008` is the request to
 * parameterize that account at promotion, after which the relabelling
 * disappears and the delegation is total.
 *
 * The refusal codes are translated by `CREDIT_NOTE_CODE_OF` — a TOTAL map over
 * the seven `customer_credit_application.*` members of
 * `ReceivableArithmeticCode`, so a code added upstream fails to compile here
 * instead of leaking an S4 vocabulary word onto an S5 route.
 */
export interface CreditNoteApplicationInput {
  /** The invoice's stored pair and snapshot, read under ITS lock. Never the note's snapshot standing in for it. */
  readonly invoice: InvoiceArState;
  /** The note's remaining pair and its own stored snapshot, read under the note's lock. */
  readonly note: CustomerCreditState;
  /** The note's currency is the invoice's, so `c = a` (A-10). */
  readonly sameCurrency: boolean;
  /** `c` > 0, in the note's currency, ≤ the locked remaining. */
  readonly consumedMinor: bigint;
  /** `a` > 0, in the invoice's currency, ≤ `O`. */
  readonly appliedMinor: bigint;
}

/**
 * Every amount one `credit_note_applications` row stores — the canonical plan's
 * own field set, unchanged, with only the entry's account vocabulary narrowed
 * to S5's. `Omit` rather than a restatement: a restated field list is a second
 * declaration of the same truth, and would go stale silently.
 */
export type CreditNoteApplicationPlan = Omit<CustomerCreditApplicationPlan, 'entryLines'> & {
  readonly entryLines: readonly ReturnsEntryLine[];
};

/** 2210 → 2200, and nothing else. `posting_account` is deliberately absent: this entry never touches it. */
const RETURNS_ACCOUNT_OF_RECEIVABLE_ACCOUNT = Object.freeze({
  accounts_receivable: 'accounts_receivable',
  customer_credit_liability: 'customer_refund_liability',
  fx_gain: 'fx_gain',
  fx_loss: 'fx_loss',
} as const satisfies Partial<Record<ReceivableEntryLine['account'], CreditNoteEntryAccount>>);

/** The snapshot names, mapped. `payment` is deliberately absent: a credit-note application has no payment leg. */
const RETURNS_CURRENCY_OF_RECEIVABLE_CURRENCY = Object.freeze({
  invoice: 'invoice',
  credit: 'source',
  base: 'base',
} as const satisfies Partial<Record<ReceivableEntryLine['currency'], ReturnsEntryLine['currency']>>);

function returnsLineOfReceivableLine(line: ReceivableEntryLine): ReturnsEntryLine {
  const account = (RETURNS_ACCOUNT_OF_RECEIVABLE_ACCOUNT as Partial<Record<string, CreditNoteEntryAccount>>)[line.account];
  const currency = (RETURNS_CURRENCY_OF_RECEIVABLE_CURRENCY as Partial<Record<string, ReturnsEntryLine['currency']>>)[line.currency];
  if (account === undefined || currency === undefined) {
    // `throw` rather than `refuse(...)`: an arrow-function `never` does not
    // narrow for the compiler, and the two `undefined`s below must be gone.
    throw new ReturnsPlanError('customer_refund.arithmetic_invalid', 'a credit note application entry names only its own accounts and snapshots');
  }
  return Object.freeze({ account, side: line.side, currency, txnAmountMinor: line.txnAmountMinor, baseAmountMinor: line.baseAmountMinor });
}

/**
 * The S5 code for each refusal the canonical AR arithmetic raises on this path.
 *
 * Total over the `customer_credit_application.*` half of
 * `ReceivableArithmeticCode` by construction. The `customer_payment.*` half is
 * reachable too — `arSide` raises `customer_payment.arithmetic_invalid` for an
 * outstanding that exceeds the total, and `creditSide` for a remaining that
 * exceeds the original — and those are defects of the CALLER's read, so they
 * land on `credit_note.settlement_changed`: the invoice or the note moved under
 * the lock the caller thought it held.
 */
const CREDIT_NOTE_CODE_OF = Object.freeze({
  'customer_credit_application.amount_invalid': 'credit_note.amount_invalid',
  'customer_credit_application.amount_exceeds_outstanding': 'credit_note.amount_exceeds_outstanding',
  'customer_credit_application.amount_below_base_unit': 'credit_note.amount_below_base_unit',
  'customer_credit_application.amount_mismatch': 'credit_note.amount_mismatch',
  'customer_credit_application.residue_below_base_unit': 'credit_note.residue_below_base_unit',
  'customer_credit_application.credit_exhausted': 'credit_note.note_exhausted',
  'customer_credit_application.amount_exceeds_credit': 'credit_note.amount_exceeds_note',
} as const satisfies Record<Extract<ReceivableArithmeticCode, `customer_credit_application.${string}`>, ReturnsRefusalCode>);

export function planCreditNoteApplication(input: CreditNoteApplicationInput): CreditNoteApplicationPlan {
  let canonical: CustomerCreditApplicationPlan;
  try {
    canonical = planCustomerCreditApplication({
      invoice: input.invoice,
      credit: input.note,
      sameCurrency: input.sameCurrency,
      consumedMinor: input.consumedMinor,
      appliedMinor: input.appliedMinor,
    });
  } catch (err) {
    if (!(err instanceof ReceivableArithmeticError)) throw err;
    const mapped = (CREDIT_NOTE_CODE_OF as Partial<Record<string, ReturnsRefusalCode>>)[err.code];
    // A `customer_payment.*` code on this path is the caller's stale read, not
    // a merchant's bad amount: the document moved under the lock.
    throw new ReturnsPlanError(mapped ?? 'credit_note.settlement_changed', 'the canonical AR arithmetic refused this credit note application');
  }
  const { entryLines: canonicalLines, ...amounts } = canonical;
  const plan: CreditNoteApplicationPlan = Object.freeze({
    ...amounts,
    entryLines: balanced(canonicalLines.map(returnsLineOfReceivableLine)),
  });
  // `TL-P4-S5-R2` limbs 2 to 5 and the identity. The relabelling is pure, so
  // these could only fail if the canonical arithmetic or the relabelling moved —
  // which is exactly when they must.
  assertCanonicalArRelease(input.invoice, plan);
  assertApplicationEntryComplete(plan);
  return plan;
}

// ── (b3) `TL-P4-S5-R2`: the posting-completeness assertions ─────────────

/**
 * The TypeScript twins of the deferred completeness validators, and the reason
 * `TL-P4-S5-R2`'s seven red proofs have real subjects to plant against.
 *
 * The ruling, in the project owner's own terms: *"No realized exchange movement
 * may silently change `customer_refund_liability` without its accounting line.
 * The liability's amount and carrying value come from the same canonical
 * settlement calculation that produced the AR release."* And the identity it
 * requires, which must reconcile EXACTLY in integer minor units with no
 * unexplained one-minor drift:
 *
 *     AR effect + realized FX effect + dust/residue effect + liability effect = 0
 *
 * `balanced()` already asserts that sum is zero, but it asserts it of whatever
 * lines it is handed: a plan that omitted the realized-FX line AND understated
 * the liability by the same amount balances perfectly and is wrong. So these
 * functions assert each TERM separately against the canonical arithmetic that
 * produced it, which is the half a balance check cannot see.
 *
 * They are functions with reachable refusals rather than comments, because a
 * law with no refusal has no red proof and `[[daftar-a-green-gate-must-prove-it-can-be-red]]`.
 */

/** The NET base movement on one account across an entry: debits positive, credits negative. */
function netBaseOn(lines: readonly ReturnsEntryLine[], account: string): bigint {
  let net = 0n;
  for (const l of lines) {
    if (l.account !== account) continue;
    net += l.side === 'D' ? l.baseAmountMinor : -l.baseAmountMinor;
  }
  return net;
}

const incomplete = (message: string): never => {
  throw new ReturnsPlanError('credit_note.posting_incomplete', message);
};

/**
 * `TL-P4-S5-R2`, limb 1: the credit note's OWN entry reduces no receivable.
 *
 * "A credit-note flow reduces invoice AR exactly once… the credit-note/return
 * creation path must not independently post another AR reduction for the same
 * economic amount." The account union already makes the line unexpressible in a
 * well-typed call; this is the runtime half, so the law has a reachable refusal
 * and therefore a red proof. The planted subject is the exact line that was
 * deleted from `planCreditNoteReversal`.
 */
export function assertReturnEntryReducesNoReceivable(lines: readonly ReturnsEntryLine[]): void {
  if (lines.some((l) => l.account === 'accounts_receivable')) {
    refuse('customer_refund.arithmetic_invalid', 'a credit note entry raises its liability and reduces no receivable');
  }
}

/**
 * `TL-P4-S5-R2`, limb 2: the AR release is the CANONICAL one, recomputed.
 *
 * "Do not implement independent credit-note AR arithmetic… The AR side derives
 * from the stored invoice settlement pair through the canonical mechanism."
 *
 * This recomputes `rel = R(X + a) − R(X)` with `apRelease` — the accepted
 * primitive, the same one `arSide` calls — directly from the invoice's STORED
 * pair, and refuses a plan that disagrees by even one minor unit. The defect it
 * exists to catch is the one the first draft of this slice shipped: the applied
 * part converted at the NOTE's snapshot (3 633 on the worked scenario) rather
 * than released from the invoice's own pair (3 617).
 */
export function assertCanonicalArRelease(
  invoice: InvoiceArState,
  plan: Pick<CreditNoteApplicationPlan, 'arReleasedBeforeMinor' | 'invoiceAmountAppliedMinor' | 'invoiceCarryingReleasedMinor'>,
): void {
  const canonical = apRelease(invoice.totalBaseMinor, invoice.totalTxnMinor, plan.arReleasedBeforeMinor, plan.invoiceAmountAppliedMinor);
  if (plan.invoiceCarryingReleasedMinor !== canonical) {
    incomplete('the AR carrying release must be the canonical release over the invoice stored pair');
  }
  if (plan.arReleasedBeforeMinor !== invoice.totalTxnMinor - invoice.outstandingTxnMinor) {
    incomplete('the AR level must be the invoice chain position the lock returned');
  }
}

/**
 * `TL-P4-S5-R2`, limbs 3, 4, 5 and the IDENTITY: every term of the entry is
 * posted, and each equals the canonical number that produced it.
 *
 * Four separate assertions, deliberately not one:
 *
 * - the NET movement on `accounts_receivable` is exactly the carrying the
 *   invoice released — the principal line AND its dust line together, so a
 *   missing dust line is a mismatch and not a rounding;
 * - the NET movement on the liability is exactly the carrying the note released
 *   — so no realized exchange movement can silently change the liability;
 * - the realized-FX line is present iff `realizedFxMinor ≠ 0`, for exactly
 *   `|realizedFxMinor|`, on 4900 for a gain and 6900 for a loss;
 * - and the four terms sum to zero, in integer minor units, which is the
 *   ruling's identity stated as arithmetic rather than as prose.
 */
export function assertApplicationEntryComplete(plan: CreditNoteApplicationPlan): void {
  const lines = plan.entryLines;
  const arEffect = netBaseOn(lines, 'accounts_receivable');
  const liabilityEffect = netBaseOn(lines, 'customer_refund_liability');
  const fxEffect = netBaseOn(lines, 'fx_gain') + netBaseOn(lines, 'fx_loss');

  // AR is CREDITED, so its net is negative and its magnitude is the release.
  if (arEffect !== -plan.invoiceCarryingReleasedMinor) {
    incomplete('the receivable movement must equal the invoice carrying release, dust line included');
  }
  // The liability is DEBITED, so its net is positive.
  if (liabilityEffect !== plan.creditCarryingReleasedMinor) {
    incomplete('the liability movement must equal the note carrying release, dust line included');
  }
  const fxLines = lines.filter((l) => l.account === 'fx_gain' || l.account === 'fx_loss');
  if (plan.realizedFxMinor === 0n) {
    if (fxLines.length !== 0) incomplete('a zero realized FX posts no line');
  } else {
    if (fxLines.length !== 1) incomplete('a non-zero realized FX posts exactly one line');
    const fx = fxLines[0] as ReturnsEntryLine;
    const expectedAccount = plan.realizedFxMinor > 0n ? 'fx_gain' : 'fx_loss';
    const magnitude = plan.realizedFxMinor > 0n ? plan.realizedFxMinor : -plan.realizedFxMinor;
    if (fx.account !== expectedAccount || fx.baseAmountMinor !== magnitude) {
      incomplete('the realized FX line must name the gain or loss account for exactly the realized amount');
    }
    // A gain is a CREDIT and a loss a DEBIT, so the net is the negation.
    if (fxEffect !== -plan.realizedFxMinor) incomplete('the realized FX line must carry the side its sign requires');
  }
  // The ruling's identity, in integer minor units, with no tolerance.
  if (arEffect + liabilityEffect + fxEffect !== 0n) {
    incomplete('AR, liability, dust and realized FX must reconcile exactly');
  }
}

/**
 * The same completeness law for a refund entry: the liability discharged is
 * exactly the carrying the source released, the posting account carries exactly
 * the disbursement's base, and the realized FX is posted rather than absorbed.
 *
 * `TL-P4-S5-R2`: *"The refund liability must not absorb unrecorded FX."* The
 * plausible defect is a plan that debits the liability for the CONVERTED amount
 * and omits the dust line, leaving the gap inside the liability with no line
 * naming it — which balances only if something else is also wrong, and this
 * catches it before that happens.
 */
export function assertRefundEntryComplete(plan: CustomerRefundPlan): void {
  const lines = plan.entryLines;
  const liabilityEffect = netBaseOn(lines, plan.liabilityAccount);
  const postingEffect = netBaseOn(lines, 'posting_account');
  const fxEffect = netBaseOn(lines, 'fx_gain') + netBaseOn(lines, 'fx_loss');
  if (liabilityEffect !== plan.carryingReleasedMinor) {
    incomplete('the liability discharged must equal the carrying the source released, dust line included');
  }
  if (postingEffect !== -plan.disbursementBaseMinor) {
    incomplete('the posting account must carry exactly the disbursement base');
  }
  if (fxEffect !== -plan.realizedMinor) {
    incomplete('the realized FX must be posted and not absorbed by the liability');
  }
  if (liabilityEffect + postingEffect + fxEffect !== 0n) {
    incomplete('liability, cash, dust and realized FX must reconcile exactly');
  }
  assertNoReceivableLine(lines);
}

// ── (c) The consumption chain of a source, verified ─────────────────────

/** One consumer of a source as stored: an application row, or a refund row. */
export interface SourceConsumerRow {
  /** `credit_remaining_before_minor` (rb) — the LEVEL. */
  readonly remainingBeforeMinor: bigint;
  readonly consumedMinor: bigint;
  readonly releasedBaseMinor: bigint;
}

/**
 * The COMMIT-time chain law over a source's consumers — applications AND
 * refunds together.
 *
 * **The union is the whole point.** `customer_credit_verify` (`0081:879-918`)
 * reads ONE relation today and its own comment at `0081:877-878` says so:
 * "with S4's one consumer relation; S5's refund adds one UNION ALL branch". A
 * refund that consumed credit without that branch leaves
 * `remaining = original − Σ(applications) − refund` while `v_sum` counts
 * applications only, and `0081:918` raises. So this verifier takes BOTH kinds
 * of row in one array, and `PATCH-REQ-S5-003` is the request for the SQL twin.
 *
 * It delegates to `verifyCreditChain` and adds nothing: that function already
 * holds every element of the law — the levels chaining from the original, each
 * consumption within its level, the stored remaining equal to
 * `original − Σ`, the stored carrying equal to `g(stored remaining)` and never
 * `g` of a previous rounded step, and `Σ released = original carrying −
 * g(remaining)`. A second copy of it here would be a second truth whose only
 * symptom is a disagreement under numbers nobody tested.
 *
 * It re-raises as `credit_note.consumption_inconsistent` so the S5 surface
 * reports one code for this class, however the underlying twin spells its own.
 */
export function verifySourceConsumptionChain(
  source: {
    readonly originalMinor: bigint;
    readonly originalCarryingMinor: bigint;
    readonly remainingMinor: bigint;
    readonly remainingCarryingMinor: bigint;
  },
  rows: readonly SourceConsumerRow[],
): void {
  try {
    verifyCreditChain(source, rows);
  } catch {
    refuse('credit_note.consumption_inconsistent', 'the consumers of the source do not form one chain');
  }
}
