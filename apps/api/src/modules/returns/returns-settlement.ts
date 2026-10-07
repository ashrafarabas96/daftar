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
import { VALUE_LIMIT_MINOR, convertToBase, creditRelease, creditRemainingCarrying, verifyCreditChain } from '@daftar/inventory';

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
  if (realizedMinor !== 0n) lines.push(baseLine(realizedMinor > 0n ? 'fx_gain' : 'fx_loss', realizedMinor > 0n ? 'C' : 'D', abs(realizedMinor)));

  const entryLines = balanced(lines);
  assertNoReceivableLine(entryLines);
  return Object.freeze({
    ...consumed,
    liabilityAccount,
    disbursementAmountMinor: d,
    disbursementBaseMinor,
    realizedMinor,
    entryLines,
  });
}

// ── (b) A credit note's revenue and COGS reversal ───────────────────────

export interface CreditNoteReversalInput {
  /** The credit note's total in its own currency, > 0. */
  readonly totalMinor: bigint;
  /** The note's own stored snapshot. */
  readonly conversion: ReturnsConversion;
  /** Structural zero (OD-03 OPEN). Any other value is refused here and by `CHECK (tax_minor = 0)` in the row. */
  readonly taxMinor: string;
  /**
   * The part of the total that reduces AR on an invoice, as the SUM OF THE
   * STORED APPLICATION ROWS. `0n` is lawful: a credit note issued against an
   * already-paid invoice reduces no AR and is refundable in full.
   */
  readonly appliedToInvoiceMinor: bigint;
  /** The return's stock movements, with their EXACT stored value deltas. Never a quantity and an average. */
  readonly returnedMovements: readonly ReturnedMovementValue[];
}

export interface CreditNoteReversalPlan {
  readonly totalBaseMinor: bigint;
  readonly appliedBaseMinor: bigint;
  readonly liabilityBaseMinor: bigint;
  readonly cogsReversalBaseMinor: bigint;
  /** The revenue-reversal entry: 4100 debited, AR and/or 2200 credited. */
  readonly revenueEntryLines: readonly ReturnsEntryLine[];
  /** The COGS-reversal entry: 1200 debited, 5000 credited, at the exact stored deltas. */
  readonly cogsEntryLines: readonly ReturnsEntryLine[];
}

/**
 * The two entries a credit note implies, at their two grains.
 *
 * ```
 *   revenue reversal   Dr sales_returns (4100)   total, in the note's currency
 *                         Cr accounts_receivable (1100)   the applied part
 *                         Cr customer_refund_liability (2200)   the rest
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
 * 2. **AR is credited EXACTLY ONCE, and only for the applied part.** This is
 *    the one place in the slice where AR moves. The remainder becomes the refund
 *    liability, and it is that liability a refund later consumes — which is why
 *    the refund has no AR line and needs none.
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
  if (typeof input.appliedToInvoiceMinor !== 'bigint' || input.appliedToInvoiceMinor < 0n)
    refuse('credit_note.amount_invalid', 'an applied amount must not be negative');
  if (input.appliedToInvoiceMinor > input.totalMinor) refuse('credit_note.amount_mismatch', 'the applied part exceeds the credit note total');

  const totalBaseMinor = convert(input.totalMinor, input.conversion);
  if (totalBaseMinor === 0n) refuse('credit_note.amount_below_base_unit', 'the credit note total converts to less than one base minor unit');
  // The applied part and the liability part are an exact integer SPLIT of the
  // ONE header conversion, never two independent conversions. Two HALF_EVEN
  // roundings at two grains disagree by construction
  // (`[[daftar-rounding-is-not-additive]]`, and the worked example at
  // `packages/accounting/src/sale-posting.ts:44-59`), and the difference would
  // be revenue invented by a rounding.
  const appliedBaseMinor = input.appliedToInvoiceMinor === 0n ? 0n : convert(input.appliedToInvoiceMinor, input.conversion);
  const liabilityBaseMinor = totalBaseMinor - appliedBaseMinor;
  if (liabilityBaseMinor < 0n) refuse('customer_refund.arithmetic_invalid', 'the split of a credit note total is not a split');
  const liabilityMinor = input.totalMinor - input.appliedToInvoiceMinor;
  if (liabilityMinor > 0n && liabilityBaseMinor === 0n) {
    refuse('credit_note.residue_below_base_unit', 'the refundable remainder converts to less than one base minor unit');
  }

  const revenue: ReturnsEntryLine[] = [
    Object.freeze({
      account: 'sales_returns' as const,
      side: 'D' as const,
      currency: 'source' as const,
      txnAmountMinor: input.totalMinor,
      baseAmountMinor: totalBaseMinor,
    }),
  ];
  if (input.appliedToInvoiceMinor > 0n) {
    revenue.push(
      Object.freeze({
        account: 'accounts_receivable' as const,
        side: 'C' as const,
        currency: 'invoice' as const,
        txnAmountMinor: input.appliedToInvoiceMinor,
        baseAmountMinor: appliedBaseMinor,
      }),
    );
  }
  if (liabilityMinor > 0n) {
    revenue.push(
      Object.freeze({
        account: 'customer_refund_liability' as const,
        side: 'C' as const,
        currency: 'source' as const,
        txnAmountMinor: liabilityMinor,
        baseAmountMinor: liabilityBaseMinor,
      }),
    );
  }

  const cogs = creditNoteCogsReversalBaseMinor(input.returnedMovements);
  // `throw` rather than `refuse(...)`, so the discriminated union narrows for the
  // reader as well as for the compiler: below this line `cogs` is the `ok` branch
  // and `cogs.baseMinor` is a `bigint`, not a union member nobody has checked.
  if (!cogs.ok) {
    throw new ReturnsPlanError(cogs.code, 'a COGS reversal is the sum of the stored movement value deltas and nothing else');
  }
  const cogsEntryLines = balanced([baseLine('inventory', 'D', cogs.baseMinor), baseLine('cogs', 'C', cogs.baseMinor)]);
  const revenueEntryLines = balanced(revenue);
  for (const l of [...revenueEntryLines, ...cogsEntryLines]) {
    if (!isCreditNoteEntryAccount(l.account)) refuse('customer_refund.arithmetic_invalid', 'a credit note entry names only its seven accounts');
  }
  return Object.freeze({
    totalBaseMinor,
    appliedBaseMinor,
    liabilityBaseMinor,
    cogsReversalBaseMinor: cogs.baseMinor,
    revenueEntryLines,
    cogsEntryLines,
  });
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
