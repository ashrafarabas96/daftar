import type { FxRateSource, PostingCommand, PostingLineCommand } from '@daftar/accounting';
import type { ReceivableEntryLine } from './customer-settlement';

/**
 * The journal side of a P4-S4 receivables settlement — built the way
 * `apps/api/src/modules/purchasing/supplier-settlement-posting.ts` builds the
 * supplier side, and for the same reasons.
 *
 * Each command is built from the server's BOUND values — the entry lines
 * `planCustomerPaymentAllocation` / `planCustomerCreditCreation` /
 * `planCustomerCreditApplication` derived from the amounts the payload signs —
 * never from request input, and its one accounting assertion is minted over
 * exactly this command before the seam opens. It posts through the ONE generic
 * primitive, `accounting_post_entry`, and only through the posting adapter,
 * which presents the command's own assertion before each posting. **There is
 * no second journal writer and no second posting path on this slice.**
 *
 * - One entry per ROW: `sourceId` is the allocation, the credit or the credit
 *   application id, and `entryDate` is that row's bound date. Collapsing N
 *   allocations of one payment into one entry is not expressible —
 *   `accounting_source_bindings`' primary key `(business_id, source_type,
 *   source_id)` (`0042:280`) has nowhere to put the other N−1 source ids, and
 *   `UNIQUE (business_id, journal_entry_id)` (`0042:282`) forbids one entry
 *   serving two sources. That is what makes every row addressable for P4-S6.
 * - A line in the invoice's, the credit's or the payment's currency carries
 *   THAT SNAPSHOT EXACTLY — its rate, `rate_source` and `rate_timestamp` —
 *   never a new lookup.
 * - A `base` line (the two dusts and realized FX) is in the base currency at
 *   rate 1, source `base`, at `<entry date>T00:00:00Z`.
 * - The method's posting account is named by its CHART CODE: the posting
 *   primitive takes a system key or a code, and the completeness trigger then
 *   checks the line against the account id the row stores. A client can never
 *   choose a GL account — the account is part of the three-column FK into the
 *   method row (`0067:351-354`).
 * - `branchId` is the invoice's own `branch_id` (`invoices.branch_id`,
 *   `0075:240`, `NOT NULL`), which is the dimension
 *   `accounting_invoice_entry_complete` already pins the invoice's revenue
 *   entry to (`0077:1480-1483`). For the surplus-credit entry, which settles
 *   no invoice, it is the branch of the payment's own till or NULL. No line
 *   carries a warehouse.
 * - `requestId` is the business transaction id (P3-AL-35); `description` is
 *   null. No `rounding` (6100), no `6200` and no tax line can appear: the
 *   plan's account set is CLOSED (`ReceivableAccount`).
 */

/** The accounting source type of one allocation of a collected customer payment. */
export const CUSTOMER_PAYMENT_ALLOCATION_SOURCE = 'customer_payment_allocation';
/** The accounting source type of one application of a customer credit to an invoice. */
export const CUSTOMER_CREDIT_APPLICATION_SOURCE = 'customer_credit_application';
/**
 * The accounting source type of the entry that puts an OVERPAYMENT'S SURPLUS
 * on `customer_credit_liability` (2210).
 *
 * ## This is a coordinator question, stated rather than hidden
 *
 * OQ-6 names two source types, and both are allocation-grained. But OQ-4 puts
 * a ZERO-ALLOCATION payment in scope, and a payment whose surplus is positive
 * still moves money: the posting account is debited and the liability
 * credited. That leg belongs to no allocation — in the zero-allocation case
 * there is no allocation at all — so it cannot ride on an allocation's entry,
 * whose line multiset the deferred completeness validator pins exactly
 * (`0067:1998-2027`).
 *
 * It therefore needs its own addressable source identity, and `customer_credit`
 * (`source_id` = the credit id) is the only choice that keeps every accepted
 * law intact: one entry per row, one source identity per entry, nothing
 * polymorphic, and no second writer. The alternative the map implies —
 * folding the surplus onto the last allocation — would break the validator's
 * fixed multiset and would be unrepresentable for a payment with no
 * allocations.
 *
 * **It is reported as a required ruling** (`receivables.module.ts`,
 * `P4_S4_REQUIRED_WIRING`): a third `accounting_source_types` row, a third
 * `('post', …)` operation kind, a third name in
 * `accounting_reversals_20_domain_source_guard` (the S-P4-02 deferred seam,
 * `scripts/phase4-s1-gate.ts:1141-1153`) and a third entry in
 * `DOMAIN_SOURCE_TYPES` (`packages/accounting/src/post.ts:208`). If the
 * coordinator rules otherwise, this constant and `planCustomerCreditCreation`'s
 * entry are the only two places that change.
 */
export const CUSTOMER_CREDIT_SOURCE = 'customer_credit';

export type ReceivablesSourceType = typeof CUSTOMER_PAYMENT_ALLOCATION_SOURCE | typeof CUSTOMER_CREDIT_APPLICATION_SOURCE | typeof CUSTOMER_CREDIT_SOURCE;

/** `NUMERIC(20,10)` text of rate 1: every base line. */
const BASE_RATE = '1.0000000000';

/**
 * One stored or bound FX snapshot: a currency and the rate that converts it to
 * base.
 *
 * `source` admits `provider` as well as `base` and `manual`, because
 * `invoices.rate_source` is `CHECK (rate_source IN ('base','manual',
 * 'provider'))` (`0075:265`) where `supplier_payments.rate_source` admits only
 * two (`0067:335`). An invoice written by a provider rate must be able to
 * carry its own snapshot onto the settlement's AR line; narrowing this to the
 * supplier's two would make such an invoice unsettleable.
 */
export interface ReceivableSnapshot {
  /** ISO 4217, upper case. */
  readonly currency: string;
  /** `NUMERIC(20,10)` text. */
  readonly rate: string;
  readonly source: FxRateSource;
  /** Second precision. */
  readonly at: Date;
}

export interface ReceivablePostingInput {
  readonly tenantId: string;
  readonly businessId: string;
  readonly sourceType: ReceivablesSourceType;
  /** The row id: the accounting `source_id`. */
  readonly sourceId: string;
  /** `YYYY-MM-DD`: the row's bound date. */
  readonly entryDate: string;
  /** The business's base currency. */
  readonly baseCurrency: string;
  /** The snapshots the lines may carry; a line whose snapshot is absent is a defect. */
  readonly snapshots: Readonly<Partial<Record<'invoice' | 'credit' | 'payment', ReceivableSnapshot>>>;
  /** The chart code of the method's posting account, when the entry has a `posting_account` line. */
  readonly postingAccountCode: string | null;
  /** The settled invoice's own branch, or the payment's for a surplus-credit entry. */
  readonly branchId: string | null;
  /** The plan's `entryLines`, in order. */
  readonly lines: readonly ReceivableEntryLine[];
  readonly businessTransactionId: string;
}

/** One entry: one posting line per plan line, in order. */
export function receivablePostingCommand(i: ReceivablePostingInput): PostingCommand {
  const baseCurrency = i.baseCurrency.toUpperCase();
  const baseAt = new Date(`${i.entryDate}T00:00:00Z`);
  const lines = i.lines.map((l): PostingLineCommand => {
    const snapshot = l.currency === 'base' ? null : i.snapshots[l.currency];
    if (snapshot === undefined) throw new Error(`a ${l.currency} receivables line has no snapshot`);
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
      branchId: i.branchId,
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
