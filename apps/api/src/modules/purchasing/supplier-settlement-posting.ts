import type { PostingCommand, PostingLineCommand } from '@daftar/accounting';
import type { SettlementEntryLine } from '@daftar/inventory';

/**
 * The journal side of a supplier settlement (PHASE_3_S6_CONTRACT A-05, A-09,
 * A-14(a), A-15).
 *
 * Each command is built from the server's BOUND values — the entry lines
 * `planPaymentAllocation` / `planCreditAllocation` / `planRefund` derived from
 * the amounts the payload signs — never from request input, and its one
 * accounting assertion is minted over exactly this command before seam 2
 * opens. It posts through the one generic primitive, `accounting_post_entry`,
 * and only through the posting adapter, which presents the command's own
 * assertion (`presentAccountingAssertion`) before each posting.
 *
 * - One entry per row (A-05): `source_id` is the allocation, credit
 *   allocation or refund id; `entryDate` is that row's bound date.
 * - A line in the purchase's, the note's, the payment's or the receipt's
 *   currency carries that snapshot exactly — its rate, `rate_source` and
 *   `rate_timestamp` — never a new lookup (L:830-841).
 * - A `base` line (the dusts and realized FX) is in the base currency at rate
 *   1, source `base`, at `<entry date>T00:00:00Z` (0065d R-46).
 * - The method's posting account is named by its chart code: the posting
 *   primitive takes a system key or a code, and the completeness trigger then
 *   checks the line against the account id the row stores.
 * - `branchId` is the stated purchase's warehouse's branch (`purchase`) or
 *   the note's origin purchase's (`origin`), either possibly NULL; no line
 *   carries a warehouse (A-05).
 * - `requestId` is the business transaction id (P3-AL-35); `description` is
 *   null. No `rounding` (6100), `purchase_price_variance` (6200) or
 *   `tax_payable` line can appear: the plan's account set is closed.
 */

export const SUPPLIER_PAYMENT_SOURCE = 'supplier_payment';
export const SUPPLIER_CREDIT_ALLOCATION_SOURCE = 'supplier_credit_allocation';
export const SUPPLIER_REFUND_SOURCE = 'supplier_refund';
/**
 * Phase 3 corrective (0072 R-96): the base-only release of a purchase's
 * sub-unit AP residue — Dr Accounts Payable / Cr FX gain, both `base` lines on
 * the purchase's branch — built by this same function from
 * `planResidueWriteOff`'s lines. `source_id` is the purchase.
 */
export const PURCHASE_RESIDUE_WRITE_OFF_SOURCE = 'purchase_residue_write_off';

export type SettlementSourceType =
  | typeof SUPPLIER_PAYMENT_SOURCE
  | typeof SUPPLIER_CREDIT_ALLOCATION_SOURCE
  | typeof SUPPLIER_REFUND_SOURCE
  | typeof PURCHASE_RESIDUE_WRITE_OFF_SOURCE;

/** `NUMERIC(20,10)` text of rate 1: every base line. */
const BASE_RATE = '1.0000000000';

/** One stored or bound FX snapshot: a currency and the rate that converts it to base. */
export interface SettlementSnapshot {
  /** ISO 4217, upper case. */
  readonly currency: string;
  /** `NUMERIC(20,10)` text. */
  readonly rate: string;
  readonly source: 'base' | 'manual';
  /** Second precision. */
  readonly at: Date;
}

export interface SettlementPostingInput {
  readonly tenantId: string;
  readonly businessId: string;
  readonly sourceType: SettlementSourceType;
  /** The row id: the accounting `source_id`. */
  readonly sourceId: string;
  /** `YYYY-MM-DD`: the row's bound date. */
  readonly entryDate: string;
  /** The business's base currency. */
  readonly baseCurrency: string;
  /** The snapshots the lines may carry; a line whose snapshot is absent is a defect. */
  readonly snapshots: Readonly<Partial<Record<'purchase' | 'note' | 'payment' | 'receipt', SettlementSnapshot>>>;
  /** The chart code of the method's posting account, when the entry has a `posting_account` line. */
  readonly postingAccountCode: string | null;
  /** The (target) purchase's branch and the note's origin purchase's branch. */
  readonly branches: { readonly purchase: string | null; readonly origin: string | null };
  /** The plan's `entryLines`, in A-05 order. */
  readonly lines: readonly SettlementEntryLine[];
  readonly businessTransactionId: string;
}

/** One A-05 entry: one posting line per plan line, in order. */
export function settlementPostingCommand(i: SettlementPostingInput): PostingCommand {
  const baseCurrency = i.baseCurrency.toUpperCase();
  const baseAt = new Date(`${i.entryDate}T00:00:00Z`);
  const lines = i.lines.map((l): PostingLineCommand => {
    const snapshot = l.currency === 'base' ? null : i.snapshots[l.currency];
    if (snapshot === undefined) throw new Error(`a ${l.currency} settlement line has no snapshot`);
    let account: PostingLineCommand['account'];
    if (l.account === 'posting_account') {
      if (i.postingAccountCode === null) throw new Error('a posting-account line has no account');
      account = { kind: 'code', code: i.postingAccountCode };
    } else {
      account = { kind: 'system', systemKey: l.account };
    }
    return {
      account,
      side: l.side,
      baseAmountMinor: l.baseAmountMinor,
      baseCurrency,
      txnAmountMinor: l.txnAmountMinor,
      txnCurrency: snapshot === null ? baseCurrency : snapshot.currency.toUpperCase(),
      fxRate: snapshot === null ? BASE_RATE : snapshot.rate,
      fxRateSource: snapshot === null ? 'base' : snapshot.source,
      fxRateAt: snapshot === null ? baseAt : snapshot.at,
      branchId: l.dimension === 'purchase' ? i.branches.purchase : i.branches.origin,
      warehouseId: null,
      memo: null,
    };
  });
  return {
    tenantId: i.tenantId,
    businessId: i.businessId,
    sourceType: i.sourceType,
    sourceId: i.sourceId,
    entryDate: i.entryDate,
    lines,
    description: null,
    requestId: i.businessTransactionId,
  };
}
