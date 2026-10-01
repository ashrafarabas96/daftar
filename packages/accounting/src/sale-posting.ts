/**
 * The accounting truth of a sale (P4-S2; P4-AL-16, P4-AL-19, P4-AL-20,
 * P4-AL-25, P4-AL-44; Tech Lead ruling `TL-P4-S1-R1`).
 *
 * Everything here is PURE and integer-only. It derives the two journal
 * entries a confirmed sale implies, from facts that are already persisted or
 * about to be, and it writes nothing. There is no Float, no Double and no
 * Number arithmetic over money anywhere in this module: every amount is a
 * `bigint` of minor units.
 *
 * ── The two entries, and why they are two ────────────────────────────────
 *
 * A confirmed sale posts exactly two journal entries, of two different
 * accounting source types, because `accounting_reversals.id =
 * original_entry_id` permits exactly one whole-entry reversal per entry for
 * ever (§2.3, P4-AL-47). Minting them at one grain would make "reverse the
 * revenue and leave the inventory alone" — which is what a price correction
 * is — unexpressible for the rest of the project's life.
 *
 *   source type `invoice`  the revenue entry, at the INVOICE's grain
 *   source type `sale`     the COGS entry, at the SALE's grain
 *
 * Neither type may exist as a registry row without this module: an accounting
 * source type with no writer, no binding, no expected journal shape and no
 * deferred completeness validator is a dead concept, which is the whole
 * substance of `TL-P4-S1-R1`.
 *
 * ── The revenue account is 4000 ──────────────────────────────────────────
 *
 * `0040_accounting_chart.sql:59-60` registers `sales_revenue` as `4000` and
 * `sales_returns` as `4100`. A sale credits `sales_revenue`. `4100` is the
 * RETURN account and belongs to P4-S5. The system key is the engine identity
 * and the code is a presentation default (`0040:39-40`), so this module names
 * the key and never the digits.
 *
 * ── Rounding happens ONCE, and the second rounding is deleted ────────────
 *
 * `[[daftar-rounding-is-not-additive]]`. Two layers that each obey "the same
 * HALF_EVEN contract" at two aggregation grains disagree by construction, so
 * the sale path is designed to contain exactly one rounding on each side and
 * the second is removed rather than reconciled.
 *
 * REVENUE SIDE. The one rounding is the header conversion
 * `total_base_minor = HALF_EVEN(total_txn_minor × rate)`, which `0043:208-245`
 * already forces on every journal line from that line's own transaction
 * amount, and which the two lines of the invoice entry therefore carry
 * identically — so the entry balances in base by construction and no
 * rounding line (`6100`) is reachable, as P4-AL-19 requires.
 * `invoice_items.base_share_minor` is then an exact integer SPLIT of that same
 * total by largest remainder (`splitBaseByLargestRemainder` below), never a
 * second `HALF_EVEN(net_txn_minor × rate)` per row. The difference is not
 * theoretical: with `rate = 1.0850000000` and two lines of `3500` and `999`
 * transaction minor units, the header conversion is
 * `HALF_EVEN(4499 × 1.085) = HALF_EVEN(4881.415) = 4881`, while the per-row
 * conversions are `HALF_EVEN(3797.5) = 3798` (an exact tie, resolved to the
 * even integer) and `HALF_EVEN(1083.915) = 1084`, summing to `4882`. One base
 * minor unit of revenue, invented by the second rounding, on a sale whose
 * every input was exact. `SALE_BASE_SPLIT_DRIFT_VECTOR` records that case so
 * the deletion cannot be undone silently.
 *
 * COGS SIDE. There is no rounding in this module at all, and that is the
 * point. `inventory_apply_stock_movements` (`0060:376-394`) computes an
 * outbound movement's value itself and REFUSES a caller that supplies one:
 * the movement that empties a stock key takes the key's stored valuation
 * EXACTLY (`v_value := -v_level_value`, no rounding whatever), and any other
 * outbound movement takes `-inventory_half_even(|qty| × avg)` — one rounding,
 * at the row, inside the only stock writer. So the COGS entry's amount is the
 * SUM OF THOSE STORED INTEGERS and nothing else. Recomputing it from
 * `quantity × average_cost` would be the second rounding, and it would also
 * be simply wrong: it cannot reproduce the empties-the-key branch, which
 * performs no rounding, and `average_cost` is itself a derived rounded
 * quotient — `[[daftar-a-rounded-quotient-is-never-an-input]]`. This is why
 * the one official reconciliation identity is
 * `GL Inventory (1200) = Σ stock_movements.value_delta_base_minor`
 * (`TL-P4-S0-01`, P4-AL-25) and never `Σ(qty × avg)`.
 *
 * ── Tax is structurally zero and a non-zero tax is REFUSED ───────────────
 *
 * `OD-03` is OPEN (§13, P4-AL-44). `invoices.tax_minor` and
 * `invoice_items.tax_minor` each carry `CHECK (tax_minor = 0)` in `0075`, so
 * the database already makes a non-zero sales tax unrepresentable. This
 * module refuses it a second time, with a stable code, so the refusal is a
 * policy and not an accident of a CHECK someone might widen: there is no
 * `2100` line in any shape here, and no jurisdiction's rate anywhere in the
 * tree. `R-SAL-05` is the identity that survives the day the zero stops being
 * zero.
 */
import { AccountingError } from './errors';
import { canonicalDate, computeFingerprint, type CanonicalLineInput } from './fingerprint';
import type { AccountingAssertionMinter } from './ports';
import { MAX_MONEY_MINOR, type AccountRef, type FxRateSource, type PostingLineCommand, type PostingSide } from './types';

/** The accounting source type of the COGS entry a sale implies. */
export const SALE_SOURCE_TYPE = 'sale';
/** The accounting source type of the revenue entry an invoice implies. */
export const INVOICE_SOURCE_TYPE = 'invoice';

/**
 * The system accounts the two Phase 4 sale shapes may name, and nothing else.
 * A closed list, because an open one is how `6100` or `2100` arrives in a
 * sale.
 */
export const SALE_REVENUE_SYSTEM_KEY = 'sales_revenue';
export const SALE_RECEIVABLE_SYSTEM_KEY = 'accounts_receivable';
export const SALE_COGS_SYSTEM_KEY = 'cogs';
export const SALE_INVENTORY_SYSTEM_KEY = 'inventory';

/**
 * The settlement accounts a till may take money into. A CLOSED list, and the
 * ONLY admitted shape: a cash sale's settlement account is a SYSTEM account
 * in this model, and `saleInvoiceDebitAccount` refuses the `code` arm of
 * `AccountRef` outright.
 *
 * The five keys are the ones `accounting_settlement_account_eligibility`
 * (`0067:1918-1945`) admits for a payment method's posting account, but that
 * routine is **not** a second line of defence on this path and this comment
 * used to claim it was. It is invoked from exactly four places — the payment
 * method guards at `0067:827` and `0067:845`, `supplier_payment_guard` at
 * `0067:924` and `supplier_refund_guard` at `0067:1160` — and from nothing on
 * the invoice posting path; and at `0067:1940-1943` it returns `eligible` for
 * ANY active asset account whose `system_key` is NULL, so it would not
 * discriminate a code even if it ran.
 *
 * What a code arm admitted instead was an own-goal with no attacker:
 * `{ kind: 'code', code: '4000' }` produced `Dr code:4000 / Cr sales_revenue`,
 * and `0040:59` seeds `sales_revenue`'s `default_code` as exactly `4000`, so
 * on a business keeping the default chart that is the SAME ACCOUNT on both
 * sides — revenue posted as its own settlement, balanced, reconciling, and
 * wrong. `'5000'` (`cogs`, `0040:67`) does the same. Mapping a code back to a
 * key to catch it would mean resolving the business's chart inside a pure
 * function; refusing the arm is the safer fix and loses nothing, because a
 * till settles into one of five system identities.
 */
export const SALE_SETTLEMENT_SYSTEM_KEYS = ['cash', 'bank', 'card_clearing', 'wallet_clearing', 'cheque_clearing'] as const;
export type SaleSettlementSystemKey = (typeof SALE_SETTLEMENT_SYSTEM_KEYS)[number];

/**
 * How the sale was settled.
 *
 * `cash` means settled at the till in the same transaction: the invoice entry
 * debits the settlement account directly and NO receivable exists at any
 * instant. That is not a simplification of the credit shape, it is the shape
 * `0075`'s frozen `invoices_walkin_no_ar` constraint trigger (`0075:660-696`)
 * requires: an invoice with a null `customer_id` may not carry a line on
 * `accounts_receivable`, deferred to COMMIT, and a walk-in cash sale is the
 * POS case. Posting `Dr AR / Cr revenue` and settling it with a second entry
 * would put the forbidden line on the invoice entry itself.
 *
 * `credit` means on account: the invoice entry debits `accounts_receivable`
 * and the settlement is a later payment allocation (P4-S4). A credit sale
 * therefore requires a customer — a receivable behind a null customer is the
 * defect `invoices_walkin_terms_ck` and `invoices_customer_snapshot_ck`
 * already refuse on the way in (P4-AL-11).
 */
export type SaleSettlementKind = 'cash' | 'credit';

/** The FX snapshot a document carries, shared by both entries of one sale. */
export interface SaleFxSnapshot {
  /** Canonical decimal string with exactly 10 fraction digits. */
  readonly sourceToBaseRate: string;
  readonly rateSource: FxRateSource;
  /** Second precision, as `invoices.rate_timestamp` stores it. */
  readonly rateTimestamp: Date;
}

/** One `invoice_items` row, as the invoice shape reads it. */
export interface SaleInvoiceLineFacts {
  readonly lineNo: number;
  /** `invoice_items.net_txn_minor` = gross − discount + tax. */
  readonly netTxnMinor: bigint;
  /** `invoice_items.tax_minor`. Structurally zero (§13). */
  readonly taxMinor: bigint;
}

/** The persisted `invoices` row the revenue entry is derived from. */
export interface SaleInvoiceFacts {
  readonly tenantId: string;
  readonly businessId: string;
  /** `invoices.id`, which is also `binding_source_id` and the entry's source id. */
  readonly invoiceId: string;
  /** `invoices.issue_date`, which is the entry date. Never a clock. */
  readonly issueDate: string;
  readonly branchId: string;
  readonly customerId: string | null;
  readonly settlementKind: SaleSettlementKind;
  /**
   * Where a cash sale's money lands: the payment method's posting account.
   * `null` for a credit sale, which debits the receivable instead.
   */
  readonly settlementAccount: AccountRef | null;
  readonly currencyCode: string;
  readonly baseCurrency: string;
  readonly subtotalTxnMinor: bigint;
  readonly discountTxnMinor: bigint;
  readonly taxMinor: bigint;
  readonly totalTxnMinor: bigint;
  /** The single rounding of the revenue side: `HALF_EVEN(total_txn × rate)`. */
  readonly totalBaseMinor: bigint;
  readonly fx: SaleFxSnapshot;
  readonly lines: readonly SaleInvoiceLineFacts[];
}

/**
 * One stock movement the sale wrote, as `inventory_apply_stock_movements`
 * RETURNED it (`0060:467-468`). `valueDeltaBaseMinor` is the routine's own
 * integer and is negative for an outbound movement; nothing in this module
 * recomputes it.
 */
export interface SaleMovementFacts {
  readonly sourceLineId: string;
  readonly valueDeltaBaseMinor: bigint;
}

/** The persisted `sales` row the COGS entry is derived from. */
export interface SaleCogsFacts {
  readonly tenantId: string;
  readonly businessId: string;
  /** `sales.id`, which is also `binding_source_id` and the entry's source id. */
  readonly saleId: string;
  /** `sales.sold_on`, the sale's civil date. The entry date of both entries. */
  readonly soldOn: string;
  readonly branchId: string;
  /** One warehouse per sale: the till's. The dimension both lines carry. */
  readonly warehouseId: string;
  readonly baseCurrency: string;
  readonly movements: readonly SaleMovementFacts[];
}

const assertMinor = (value: unknown, what: string): bigint => {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_MONEY_MINOR) {
    throw new AccountingError('accounting.payload_invalid', `${what} must be a non-negative integer of minor units within the money cap`);
  }
  return value;
};

/**
 * `OD-03` as a refusal rather than a hope (§13, P4-AL-44).
 *
 * Phase 4 ships structurally zero sales tax. A non-zero tax on a sale is
 * refused under a stable code — at the header and at every line — and the
 * refusal says nothing about any jurisdiction's law, because settling that is
 * `OD-03`'s and an approved Country Pack's, not this module's.
 */
export function assertSalesTaxStructurallyZero(facts: Pick<SaleInvoiceFacts, 'taxMinor' | 'lines'>): void {
  if (facts.taxMinor !== 0n) {
    throw new AccountingError(
      'accounting.sales_tax_unsupported',
      'Phase 4 posts no sales tax: a non-zero invoice tax is refused until an approved Country Pack exists (OD-03)',
    );
  }
  for (const line of facts.lines) {
    if (line.taxMinor !== 0n) {
      throw new AccountingError(
        'accounting.sales_tax_unsupported',
        'Phase 4 posts no sales tax: a non-zero invoice line tax is refused until an approved Country Pack exists (OD-03)',
      );
    }
  }
}

/**
 * Split an already-converted base total over the lines' transaction amounts
 * by largest remainder, ties to the lower index, so `Σ shares = total`
 * EXACTLY and no second rounding exists.
 *
 * This is the algorithm `packages/inventory/src/allocation.ts:40` uses for the
 * purchase receipt's base split, and the sale's split must be the same one,
 * because `GOLD-33`/`G-18` compares a purchase and a sale in one ledger. It
 * is restated here rather than imported: `@daftar/accounting` depends on
 * `@daftar/domain-core` only, and a package that imports an inventory
 * valuation package to add up money would be a dependency edge in the wrong
 * direction.
 *
 * **Where the two implementations are actually compared.** Not here, and not
 * in this package's own suite, which cannot import `@daftar/inventory` at
 * all: `tests/guards/sale-s2-base-split-agreement.test.ts` imports BOTH this
 * function and the inventory `largestRemainder` and runs them over
 * `SALE_BASE_SPLIT_AGREEMENT_VECTORS`. An earlier version of that claim was
 * false in a way worth recording: the vectors below were asserted against
 * THIS implementation only, so a duplication justified by a cross-package pin
 * had a pin with one side missing. The vectors themselves were fine — they
 * discriminate the tie rule — but a good vector applied to one side proves
 * only that the side agrees with itself.
 */
export function splitBaseByLargestRemainder(totalBaseMinor: bigint, lineTxnMinor: readonly bigint[]): bigint[] {
  assertMinor(totalBaseMinor, 'a base total');
  if (lineTxnMinor.length === 0) {
    throw new AccountingError('accounting.payload_invalid', 'a base total cannot be split over no lines');
  }
  for (const t of lineTxnMinor) assertMinor(t, 'a line transaction amount');
  const sum = lineTxnMinor.reduce((a, b) => a + b, 0n);
  if (sum === 0n) {
    if (totalBaseMinor !== 0n) {
      throw new AccountingError('accounting.payload_invalid', 'a non-zero base total cannot be split over lines that sum to zero');
    }
    return lineTxnMinor.map(() => 0n);
  }
  const shares = lineTxnMinor.map((t) => (totalBaseMinor * t) / sum);
  const remainders = lineTxnMinor.map((t) => (totalBaseMinor * t) % sum);
  let residue = totalBaseMinor - shares.reduce((a, b) => a + b, 0n);
  const order = lineTxnMinor
    .map((_, i) => i)
    .sort((a, b) => {
      const ra = remainders[a] ?? 0n;
      const rb = remainders[b] ?? 0n;
      if (ra !== rb) return ra > rb ? -1 : 1;
      return a - b;
    });
  for (const i of order) {
    if (residue === 0n) break;
    shares[i] = (shares[i] ?? 0n) + 1n;
    residue -= 1n;
  }
  if (residue !== 0n) {
    throw new AccountingError('accounting.payload_invalid', 'the base split residue exceeded the number of lines');
  }
  return shares;
}

/**
 * The counterexample the deleted second rounding produces, kept as data.
 *
 * `rate` 1.0850000000 over two lines. The split is what the ledger carries;
 * `perRowHalfEven` is what a second per-row conversion would carry; they
 * differ by one base minor unit and the sum over the rows exceeds the total
 * the two journal lines are forced to carry by `0043:208-245`. A test that
 * asserts this pair is a test that cannot be made green by reintroducing the
 * rounding.
 */
export const SALE_BASE_SPLIT_DRIFT_VECTOR = {
  rate: '1.0850000000',
  lineTxnMinor: [3500n, 999n] as readonly bigint[],
  totalTxnMinor: 4499n,
  /** `HALF_EVEN(4499 × 1.085) = HALF_EVEN(4881.415)`. The one rounding. */
  totalBaseMinor: 4881n,
  /** `splitBaseByLargestRemainder(4881, [3500, 999])`. Sums to 4881. */
  split: [3797n, 1084n] as readonly bigint[],
  /** `[HALF_EVEN(3797.5), HALF_EVEN(1083.915)]`. Sums to 4882. The drift. */
  perRowHalfEven: [3798n, 1084n] as readonly bigint[],
  driftBaseMinor: 1n,
} as const;

/**
 * Vectors pinning `splitBaseByLargestRemainder` to the purchase receipt's
 * `largestRemainder` (`packages/inventory/src/allocation.ts:40`) at scale 0.
 *
 * Exported so the ONE suite that can see both packages —
 * `tests/guards/sale-s2-base-split-agreement.test.ts` — runs both
 * implementations over them. This package's own suite can only check its own
 * side, and says so; the cross-package claim lives where it is checkable.
 *
 * They discriminate the tie rule rather than merely exercising the happy
 * path: flipping ties to the HIGHER index changes the answer on three of the
 * six, which the agreement suite proves before trusting them.
 */
export const SALE_BASE_SPLIT_AGREEMENT_VECTORS: readonly { readonly total: bigint; readonly weights: readonly bigint[]; readonly shares: readonly bigint[] }[] =
  [
    { total: 4881n, weights: [3500n, 999n], shares: [3797n, 1084n] },
    { total: 100n, weights: [1n, 1n, 1n], shares: [34n, 33n, 33n] },
    { total: 10n, weights: [1n, 1n, 1n, 1n], shares: [3n, 3n, 2n, 2n] },
    { total: 1n, weights: [1n, 1n], shares: [1n, 0n] },
    { total: 7n, weights: [0n, 7n], shares: [0n, 7n] },
    { total: 0n, weights: [5n, 5n], shares: [0n, 0n] },
  ];

const line = (
  account: AccountRef,
  side: PostingSide,
  baseAmountMinor: bigint,
  baseCurrency: string,
  txnAmountMinor: bigint,
  txnCurrency: string,
  fx: SaleFxSnapshot,
  branchId: string | null,
  warehouseId: string | null,
): PostingLineCommand => ({
  account,
  side,
  baseAmountMinor,
  baseCurrency: baseCurrency.toUpperCase(),
  txnAmountMinor,
  txnCurrency: txnCurrency.toUpperCase(),
  fxRate: fx.sourceToBaseRate,
  fxRateSource: fx.rateSource,
  fxRateAt: fx.rateTimestamp,
  branchId,
  warehouseId,
  memo: null,
});

/**
 * The debit account of the revenue entry: the settlement account for a cash
 * sale, `accounts_receivable` for a credit sale. The single place the two
 * shapes differ.
 */
export function saleInvoiceDebitAccount(facts: Pick<SaleInvoiceFacts, 'settlementKind' | 'settlementAccount' | 'customerId'>): AccountRef {
  if (facts.settlementKind === 'cash') {
    const account = facts.settlementAccount;
    if (account === null || account === undefined) {
      throw new AccountingError('accounting.payload_invalid', 'a cash sale states the account its money lands in');
    }
    // The `code` arm is refused OUTRIGHT, not inspected. An earlier version
    // gated the closed-list check on `account.kind === 'system' && …`, so the
    // `code` arm of `AccountRef` (`types.ts:39`) fell through unchecked and
    // `code:'4000'` posted revenue against itself. See the list's own comment
    // above for why refusal is the safer fix than mapping codes to keys.
    if (account.kind !== 'system') {
      throw new AccountingError(
        'accounting.payload_invalid',
        "a cash sale's settlement account is named by its system identity, never by an account code: a code cannot be checked against the settlement keys without resolving the business's chart",
      );
    }
    if (!(SALE_SETTLEMENT_SYSTEM_KEYS as readonly string[]).includes(account.systemKey)) {
      throw new AccountingError('accounting.payload_invalid', `${account.systemKey} is not a settlement account a till may take money into`);
    }
    return account;
  }
  if (facts.settlementAccount !== null) {
    throw new AccountingError('accounting.payload_invalid', 'a credit sale settles nothing at the till and names no settlement account');
  }
  if (facts.customerId === null) {
    // P4-AL-11 and the frozen `invoices_walkin_no_ar` trigger: a receivable
    // behind nobody is the defect, not a tolerated edge case.
    throw new AccountingError('accounting.payload_invalid', 'a credit sale is owed by a customer: an invoice with no customer may not carry a receivable line');
  }
  return { kind: 'system', systemKey: SALE_RECEIVABLE_SYSTEM_KEY };
}

/**
 * The revenue entry of a sale — source type `invoice`, exactly two lines.
 *
 *   cash sale    Dr <settlement account>   Cr sales_revenue (4000)
 *   credit sale  Dr accounts_receivable    Cr sales_revenue (4000)
 *
 * Both lines carry `txn = invoices.total_txn_minor` in the invoice's own
 * currency at the invoice's own snapshot, and `base = invoices.total_base_minor`.
 * That is not a convenience: `0043:208-245` forces every line's base amount to
 * be the exact `HALF_EVEN` conversion of THAT line's transaction amount at
 * THAT line's rate, so two lines carrying the same transaction amount at the
 * same rate necessarily carry the same base amount, the entry balances with
 * no residue, and `classifyRoundingResidual` stays unreachable (P4-AL-19).
 *
 * There is no tax line, because the tax is zero and a zero line is refused by
 * `journal_lines`. There is no discount line either: the discount is already
 * inside `total_txn_minor` through `invoices_total_ck`, and a separate `4200`
 * line would post a gross revenue this invoice never earned.
 *
 * Neither line carries a warehouse. The revenue entry is a document fact, and
 * `purchase_ap_outstanding`'s accepted precedent is decisive about the other
 * direction too (`TL-P4-S1-C16`): the receivable is computed from the
 * documents, so `journal_lines` needs no customer dimension it does not have.
 */
export function deriveSaleInvoiceEntryLines(facts: SaleInvoiceFacts): PostingLineCommand[] {
  assertSalesTaxStructurallyZero(facts);
  assertMinor(facts.subtotalTxnMinor, 'an invoice subtotal');
  assertMinor(facts.discountTxnMinor, 'an invoice discount');
  if (facts.discountTxnMinor > facts.subtotalTxnMinor) {
    throw new AccountingError('accounting.payload_invalid', 'an invoice discount may not exceed its subtotal');
  }
  if (facts.totalTxnMinor !== facts.subtotalTxnMinor - facts.discountTxnMinor + facts.taxMinor) {
    throw new AccountingError('accounting.payload_invalid', 'an invoice total is its subtotal less its discount plus its tax');
  }
  if (facts.totalTxnMinor <= 0n || facts.totalTxnMinor > MAX_MONEY_MINOR) {
    throw new AccountingError('accounting.payload_invalid', 'an invoice total is positive and within the money cap');
  }
  if (facts.totalBaseMinor <= 0n || facts.totalBaseMinor > MAX_MONEY_MINOR) {
    throw new AccountingError('accounting.payload_invalid', 'an invoice base total is positive and within the money cap');
  }
  if (facts.lines.length === 0) {
    throw new AccountingError('accounting.payload_invalid', 'an invoice has at least one line');
  }
  const lineSum = facts.lines.reduce((a, l) => a + assertMinor(l.netTxnMinor, 'an invoice line net'), 0n);
  if (lineSum !== facts.totalTxnMinor) {
    throw new AccountingError('accounting.payload_invalid', 'an invoice total is the sum of its line nets');
  }
  const debit = saleInvoiceDebitAccount(facts);
  return [
    line(debit, 'D', facts.totalBaseMinor, facts.baseCurrency, facts.totalTxnMinor, facts.currencyCode, facts.fx, facts.branchId, null),
    line(
      { kind: 'system', systemKey: SALE_REVENUE_SYSTEM_KEY },
      'C',
      facts.totalBaseMinor,
      facts.baseCurrency,
      facts.totalTxnMinor,
      facts.currencyCode,
      facts.fx,
      facts.branchId,
      null,
    ),
  ];
}

/** One line's base share, carrying the line it belongs to. */
export interface SaleInvoiceBaseShare {
  readonly lineNo: number;
  readonly shareMinor: bigint;
}

/**
 * The per-line base shares the invoice carries in `invoice_items.base_share_minor`.
 *
 * An exact integer split of `total_base_minor`, so
 * `Σ base_share_minor = total_base_minor` is a physical identity rather than
 * an approximation, and `R-SAL-03` ("revenue from the journal = Σ invoice line
 * revenue") is true by construction instead of true to within a cent. This is
 * the second rounding, deleted.
 *
 * ── Why each share NAMES its line ───────────────────────────────────────
 *
 * The split is taken in `lineNo` order, because the tie rule is "to the lower
 * index" and the index must therefore mean something stable. An earlier
 * version sorted internally and returned a bare `bigint[]`, which made the
 * ordering a fact about this function's body that no type carried: a caller
 * that read `invoice_items` in primary-key or insertion order and zipped it
 * with the array positionally wrote the shares onto the WRONG LINES.
 *
 * That defect is invisible to every check in the slice. `Σ` is unchanged, so
 * `Σ base_share_minor = total_base_minor` passes, the deferred validator
 * passes, `R-SAL-03` passes, and both journal lines are unaffected because
 * they are at the header grain. Only the per-line base revenue is wrong —
 * which is the figure a merchant reads on a line and a tax pack would later
 * compute from. A positional array between two layers that each have their
 * own idea of line order is exactly the mis-zip a pair makes unrepresentable,
 * so the pair is the type.
 */
export function deriveSaleInvoiceBaseShares(facts: Pick<SaleInvoiceFacts, 'totalBaseMinor' | 'totalTxnMinor' | 'lines'>): SaleInvoiceBaseShare[] {
  const ordered = [...facts.lines].sort((a, b) => a.lineNo - b.lineNo);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i]?.lineNo === ordered[i - 1]?.lineNo) {
      throw new AccountingError('accounting.payload_invalid', 'two invoice lines claim the same line number, so no share can name its line');
    }
  }
  const shares = splitBaseByLargestRemainder(
    facts.totalBaseMinor,
    ordered.map((l) => l.netTxnMinor),
  );
  const sum = shares.reduce((a, b) => a + b, 0n);
  if (sum !== facts.totalBaseMinor) {
    throw new AccountingError('accounting.payload_invalid', 'the invoice base shares do not sum to the invoice base total');
  }
  return ordered.map((l, i) => ({ lineNo: l.lineNo, shareMinor: shares[i] ?? 0n }));
}

/**
 * The base-currency value a sale released from stock: `−Σ value_delta_base_minor`
 * over its movements, as `inventory_apply_stock_movements` returned them.
 *
 * **Zero is a real answer, and this is the arm that makes the sale commit
 * possible at all.** A sale of stock whose stored valuation is zero releases
 * no value: `0060:388-390` sets `v_value := -v_level_value` on the movement
 * that empties a key, and that is `0` when the key's stored valuation is `0`.
 * Zero-valued stock is reachable without anything being wrong — a free sample
 * taken into stock at no cost, a write-down that emptied a key's value while
 * units remained, an opening position stated at zero.
 *
 * Such a sale implies NO COGS entry: there is no cost of goods to post, and
 * `journal_lines_money_cap_ck` (`0042:225`) requires `base_amount_minor > 0`,
 * so a zero line is not expressible. The accounting is sound with one entry —
 * revenue and its settlement — and `GL Inventory (1200) = Σ
 * stock_movements.value_delta_base_minor` still holds, at `0` on both sides.
 *
 * Minting a second assertion for an entry that will never be posted is the
 * one thing that must NOT happen: `AccountingAssertionSequence.assertComplete()`
 * (`apps/api/src/infra/database.ts`) refuses a commit that presented some but
 * not all of its assertions, so a fabricated COGS assertion would make the
 * sale uncommittable. Hence `deriveSaleCommitPostings` returns `cogs: null`
 * and `mintSaleCommitAssertions` mints ONE assertion, and the seam is told it
 * has one posting rather than two.
 *
 * **Where this is actually enforced.** Not here. A pure function that returns
 * `null` is a shape, not a guarantee: nothing stops a future writer bridging
 * a non-zero movement value and posting no `sale` entry. That is the
 * migration owner's deferred trigger on `sales` — a non-zero bridged movement
 * total with no `sale` accounting binding fails the COMMIT — and this arm is
 * written to agree with it, not to replace it
 * (`[[daftar-wrapper-is-not-an-invariant]]`).
 */
export function saleCogsReleasedBaseMinor(facts: SaleCogsFacts): bigint {
  if (facts.movements.length === 0) {
    // Distinct from the zero-value case on purpose: a sale that moved no
    // stock at all is a defect in the caller, not a free sample.
    throw new AccountingError('accounting.payload_invalid', 'a sale moves stock: a commit with no movements is not a sale');
  }
  let total = 0n;
  for (const m of facts.movements) {
    if (typeof m.valueDeltaBaseMinor !== 'bigint') {
      throw new AccountingError('accounting.payload_invalid', 'a movement value is an exact integer of base minor units');
    }
    if (m.valueDeltaBaseMinor > 0n) {
      throw new AccountingError('accounting.payload_invalid', 'a sale movement releases stock: its value delta is never positive');
    }
    total -= m.valueDeltaBaseMinor;
  }
  if (total > MAX_MONEY_MINOR) {
    throw new AccountingError('accounting.payload_invalid', 'the released stock value of a sale exceeds the money cap');
  }
  return total;
}

/**
 * The COGS entry of a sale — source type `sale`, exactly two lines, BASE ONLY.
 *
 *   Dr cogs (5000)        Σ |value_delta_base_minor|
 *   Cr inventory (1200)   Σ |value_delta_base_minor|
 *
 * The amount is the sum of the stored integers `inventory_apply_stock_movements`
 * wrote, negated. It is never `quantity × average_cost`: that would be a
 * second rounding at the wrong grain, and it could not reproduce the branch at
 * `0060:389` in which a movement that empties a stock key takes the key's
 * stored valuation exactly. The identity this keeps exact is
 * `GL Inventory (1200) = Σ stock_movements.value_delta_base_minor`.
 *
 * Inventory is carried in the business's base currency only, so both lines are
 * base-to-base: rate `1.0000000000`, source `base`, at the entry date's
 * midnight UTC — the deterministic instant the opening-balance plug already
 * uses, so the database's independent re-derivation reproduces the digest. No
 * clock is read.
 *
 * Both lines carry the sale's warehouse and branch, following the one accepted
 * Inventory/COGS pair in the tree: `accounting_negative_inventory_cost_adjustment_entry_complete`
 * (`0063:1640-1643`) requires `warehouse_id IS NOT DISTINCT FROM v_wh` on
 * EVERY line of the entry, its COGS line included. The purchase entry's
 * counter-account carries a null warehouse (`0063:1584-1585`), but its
 * counter-account is Accounts Payable — a supplier fact with no warehouse —
 * and COGS is not.
 *
 * ── The zero-cost arm: `null`, not a zero line ──────────────────────────
 *
 * Returns `null` when the sale released no value, which is a legitimate and
 * reachable sale and not an error. See `saleCogsReleasedBaseMinor`.
 */
export function deriveSaleCogsEntryLines(facts: SaleCogsFacts): PostingLineCommand[] | null {
  const total = saleCogsReleasedBaseMinor(facts);
  if (total === 0n) return null;
  const date = canonicalDate(facts.soldOn);
  const fx: SaleFxSnapshot = { sourceToBaseRate: '1.0000000000', rateSource: 'base', rateTimestamp: new Date(`${date}T00:00:00Z`) };
  return [
    line({ kind: 'system', systemKey: SALE_COGS_SYSTEM_KEY }, 'D', total, facts.baseCurrency, total, facts.baseCurrency, fx, facts.branchId, facts.warehouseId),
    line(
      { kind: 'system', systemKey: SALE_INVENTORY_SYSTEM_KEY },
      'C',
      total,
      facts.baseCurrency,
      total,
      facts.baseCurrency,
      fx,
      facts.branchId,
      facts.warehouseId,
    ),
  ];
}

const toCanonical = (l: PostingLineCommand): CanonicalLineInput => ({
  accountIdentity: l.account.kind === 'system' ? l.account.systemKey : `code:${l.account.code}`,
  side: l.side,
  baseAmountMinor: l.baseAmountMinor,
  baseCurrency: l.baseCurrency,
  txnAmountMinor: l.txnAmountMinor,
  txnCurrency: l.txnCurrency,
  fxRate: l.fxRate,
  fxRateSource: l.fxRateSource,
  fxRateAt: l.fxRateAt,
  branchId: l.branchId,
  warehouseId: l.warehouseId,
});

/** The `acctfp/1` fingerprint of the COGS entry, over its derived lines. */
export function computeSaleCogsFingerprint(facts: SaleCogsFacts, lines: readonly PostingLineCommand[]): string {
  return computeFingerprint(
    { tenantId: facts.tenantId, businessId: facts.businessId, sourceType: SALE_SOURCE_TYPE, sourceId: facts.saleId, entryDate: canonicalDate(facts.soldOn) },
    lines.map(toCanonical),
  );
}

/** The `acctfp/1` fingerprint of the revenue entry, over its derived lines. */
export function computeSaleInvoiceFingerprint(facts: SaleInvoiceFacts, lines: readonly PostingLineCommand[]): string {
  return computeFingerprint(
    {
      tenantId: facts.tenantId,
      businessId: facts.businessId,
      sourceType: INVOICE_SOURCE_TYPE,
      sourceId: facts.invoiceId,
      entryDate: canonicalDate(facts.issueDate),
    },
    lines.map(toCanonical),
  );
}

/** One posting of a sale commit: what it is, when, and the exact lines it owes. */
export interface SalePosting<T extends string> {
  readonly sourceType: T;
  readonly sourceId: string;
  readonly entryDate: string;
  readonly lines: readonly PostingLineCommand[];
  readonly fingerprint: string;
}

/**
 * The postings a sale commit presents, in posting order, with the lines each
 * one must carry.
 *
 * The order is the order of P4-AL-16's own sentence — the COGS entry, then the
 * revenue entry — and it is load-bearing, because `AccountingAssertionSequence`
 * (`apps/api/src/infra/database.ts`) hands out the k-th assertion only for a
 * posting whose `(sourceType, sourceId)` matches its claims.
 *
 * **`cogs` is `null` for a sale that released no stock value**, which is a
 * legitimate sale with ONE posting rather than two — see
 * `saleCogsReleasedBaseMinor`. `revenue` is never null: a sale that posts no
 * revenue entry is not a sale.
 */
export interface SaleCommitPostings {
  readonly cogs: SalePosting<typeof SALE_SOURCE_TYPE> | null;
  readonly revenue: SalePosting<typeof INVOICE_SOURCE_TYPE>;
  /**
   * The per-line base shares, each NAMING its line (`lineNo`), in `lineNo`
   * order. Never zipped positionally against a caller's own line order — see
   * `deriveSaleInvoiceBaseShares` for the defect that pairing prevents.
   */
  readonly baseShares: readonly SaleInvoiceBaseShare[];
}

/**
 * Derive both postings of one sale commit.
 *
 * Nothing here is believed from the client (P4-AL-18): every figure is taken
 * from the resolved server-side facts, and a client-supplied total has already
 * been discarded by the caller rather than validated.
 */
export function deriveSaleCommitPostings(invoice: SaleInvoiceFacts, cogs: SaleCogsFacts): SaleCommitPostings {
  if (invoice.businessId !== cogs.businessId || invoice.tenantId !== cogs.tenantId) {
    throw new AccountingError('accounting.payload_invalid', 'the invoice and the sale of one commit are the same business');
  }
  if (canonicalDate(invoice.issueDate) !== canonicalDate(cogs.soldOn)) {
    // One transaction, one civil date: two entries of one atomic sale dated
    // differently would put the revenue and its cost in different periods.
    throw new AccountingError('accounting.payload_invalid', "a sale's invoice is issued on the day the sale is made");
  }
  if (invoice.branchId !== cogs.branchId) {
    throw new AccountingError('accounting.payload_invalid', "a sale's invoice is issued by the branch that made it");
  }
  const cogsLines = deriveSaleCogsEntryLines(cogs);
  const revenueLines = deriveSaleInvoiceEntryLines(invoice);
  return {
    cogs:
      cogsLines === null
        ? null
        : {
            sourceType: SALE_SOURCE_TYPE,
            sourceId: cogs.saleId,
            entryDate: canonicalDate(cogs.soldOn),
            lines: cogsLines,
            fingerprint: computeSaleCogsFingerprint(cogs, cogsLines),
          },
    revenue: {
      sourceType: INVOICE_SOURCE_TYPE,
      sourceId: invoice.invoiceId,
      entryDate: canonicalDate(invoice.issueDate),
      lines: revenueLines,
      fingerprint: computeSaleInvoiceFingerprint(invoice, revenueLines),
    },
    baseShares: deriveSaleInvoiceBaseShares(invoice),
  };
}

/**
 * Mint the two accounting assertions of a sale commit, in posting order,
 * BEFORE the transaction opens.
 *
 * Both are `post` assertions over domain sources, so they go through the same
 * rule `mintDomainPostingAssertion` enforces: `AccountingEngine.post` refuses
 * both source types by name, there is no `trusted` flag, and the physical
 * guarantees stay the database's — the deferred completeness triggers and the
 * source rows' own deferred binding FKs.
 *
 * ── What the COGS fingerprint is predicting, and why that is safe ────────
 *
 * The assertion is minted before the transaction, but an outbound movement's
 * value is computed INSIDE it, by the stock writer, under the stock key's
 * lock. So the caller's COGS figure is a PREDICTION read from `stock_levels`
 * before the lock, and a concurrent movement on the same key can make it
 * stale. That is the same shape the reversal mirror already has: two
 * independent derivations compared through a signed fingerprint, so a
 * disagreement is a REFUSAL and never a wrong entry
 * (`sources.ts`, the module header). Three mechanisms make the disagreement
 * loud, in this order: `accounting_post_entry` recomputes `acctfp/1` from the
 * lines it actually received and refuses a mismatch before any write; the
 * deferred `accounting_sale_entry_complete` trigger re-derives the expected
 * COGS line from the PERSISTED `stock_movements` and fails the COMMIT on any
 * difference; and the sale's own deferred binding FK fails the COMMIT if the
 * entry never happened at all. A stale prediction therefore costs a refused
 * sale the till retries — the atomic refusal `OD-P4-05` rules for — and can
 * never cost a misstated COGS.
 */
export function mintSaleCommitAssertions(
  minter: AccountingAssertionMinter,
  postings: SaleCommitPostings,
  invoice: SaleInvoiceFacts,
  actorUserId: string,
): readonly [string] | readonly [string, string] {
  const mint = (sourceType: string, sourceId: string, postingFingerprint: string): string =>
    minter.mint({
      actorUserId,
      tenantId: invoice.tenantId,
      businessId: invoice.businessId,
      operationKind: 'post',
      sourceType,
      sourceId,
      postingFingerprint,
    });
  // ONE assertion for a zero-cost sale, and never a fabricated second one:
  // `assertComplete()` refuses a commit that presented some but not all of
  // its assertions, so minting a COGS assertion for an entry that will never
  // be posted would make the sale uncommittable.
  //
  // Minted in the order they are returned, which is the order they are
  // presented in. Nothing cryptographic depends on it — each mint is
  // independent — but an array whose order is the reverse of the loop that
  // built it is the kind of detail a later reader has to re-derive.
  if (postings.cogs === null) {
    return [mint(INVOICE_SOURCE_TYPE, postings.revenue.sourceId, postings.revenue.fingerprint)] as const;
  }
  const cogs = mint(SALE_SOURCE_TYPE, postings.cogs.sourceId, postings.cogs.fingerprint);
  const revenue = mint(INVOICE_SOURCE_TYPE, postings.revenue.sourceId, postings.revenue.fingerprint);
  return [cogs, revenue] as const;
}
