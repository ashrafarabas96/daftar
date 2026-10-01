import type { PostingCommand, PostingLineCommand } from '@daftar/accounting';
import type { SaleSettlementMode } from '@daftar/domain-core';

/**
 * The journal side of an atomic sale commit — P4-S2
 * (docs/PHASE_4_S2_CONTRACT.md A-07; lock P4-AL-16, P4-AL-19, P4-AL-20,
 * P4-AL-25, P4-AL-44; §4 matrix at `docs/PHASE_4_ARCHITECTURE_LOCK.md:188-190`).
 *
 * A sale posts **two** entries, in this order, through the one generic
 * primitive `accounting_post_entry`, each presented its own accounting
 * assertion minted BEFORE the transaction opened:
 *
 *   1. `sale`    — the COGS entry: `Dr cogs / Cr inventory`;
 *   2. `invoice` — the revenue entry: `Cr sales_revenue` against
 *      `Dr accounts_receivable` for a `credit` sale, or `Dr cash` for a `cash`
 *      sale (D-01, RECOMMENDED-PENDING the Tech Lead's word).
 *
 * Both commands are built from the server's BOUND values — the totals, the FX
 * snapshot the sale signed, and the stock writer's own returned integers —
 * never from request input (P4-AL-18).
 *
 * - `entryDate` is the sale's `document_date` for both entries, which is also
 *   the invoice's `issue_date`. Neither is a clock value
 *   (`[[daftar-a-command-must-not-read-the-clock]]`).
 * - `requestId` is the business transaction id (P3-AL-35): narrative, outside
 *   the fingerprint. `description` is null.
 * - **No `rounding` (6100) line, ever** (P4-AL-19): there is no
 *   `rounding_difference_minor` column on any Phase 4 table and no `6100` line
 *   in any Phase 4 journal shape. `classifyRoundingResidual` stays unreachable
 *   from this path.
 * - **No `tax_payable` (2100) line** while P4-AL-44 holds. The account exists
 *   and never moves; the journal shape has the line's place in it, and
 *   enabling non-zero tax is one migration plus a Country Pack, not a
 *   re-modelling. No jurisdiction's tax law is encoded here (P4-AL-45) and
 *   OD-03 stays OPEN.
 */

export const SALE_SOURCE = 'sale';
export const INVOICE_SOURCE = 'invoice';

/** `NUMERIC(20,10)` text of a rate of exactly 1: the domestic snapshot. */
const DOMESTIC_RATE_TEXT = '1.0000000000';

/** The FX snapshot the sale bound, exactly as `sales` and `invoices` store it. */
export interface SaleFx {
  /** `NUMERIC(20,10)` text; `1.0000000000` when the sale is in the base currency. */
  readonly rate: string;
  readonly source: 'base' | 'manual';
  /** Second precision: `<document_date>T00:00:00Z` when domestic, the registry row's `effective_at` otherwise. */
  readonly at: Date;
}

interface SalePostingBase {
  readonly tenantId: string;
  readonly businessId: string;
  /** `YYYY-MM-DD`: the sale's document date. */
  readonly documentDate: string;
  readonly baseCurrency: string;
  /** The warehouse's home branch: the dimension of both entries. */
  readonly branchId: string;
  readonly businessTransactionId: string;
}

export interface SaleCogsPostingInput extends SalePostingBase {
  /** The accounting `source_id`: the sale's own id. */
  readonly saleId: string;
  /** The warehouse the stock left: the dimension of both lines of the COGS entry. */
  readonly warehouseId: string;
  /**
   * The sum of the STORED `stock_movements.value_delta_base_minor` integers of
   * this sale's movements, as the stock writer returned them, negated to a
   * positive magnitude.
   *
   * It is **not** `quantity x average_cost` (P4-AL-25,
   * `[[daftar-a-rounded-quotient-is-never-an-input]]`): average cost is a
   * derived rounded quotient, re-multiplying it reintroduces the drift the
   * stored delta already resolved, and it would establish a second source of
   * truth beside the ledger. Summing the stored integers is what makes
   * `GL Inventory (1200) = Sigma stock_movements.value_delta_base_minor` an
   * EXACT integer identity, which is the identity `R-INV-01` asserts over
   * every movement in the business, sale-driven ones included.
   */
  readonly cogsBaseMinor: bigint;
}

/**
 * The COGS entry (lock §4: COGS is `journal_lines` on `5000` bound to the
 * `sale` source).
 *
 * `Dr cogs C / Cr inventory C`, both lines at the sale's warehouse and its
 * home branch, both in the BASE currency at rate 1: an inventory value is
 * already a base figure — the stock ledger holds no transaction currency — so
 * there is no conversion to make and each line trivially satisfies the `0043`
 * per-line law. This is the accepted `adjustmentPostingCommand` domestic shape
 * under the sale's own source type.
 *
 * **It returns `null` when `cogsBaseMinor` is zero**, and that is not a
 * convenience. A journal amount must be positive (`0042`), so a sale of stock
 * whose average cost is zero has no entry to post. The obligation is therefore
 * conditional, and the condition is not a column — `sales` carries no
 * `cogs_*` column, because the lock's §4 matrix names a stored COGS as the
 * forbidden second truth and the extended G-3 pattern
 * `(^|_)(cogs|cost_of_goods|...)($|_)` refuses one by name. So the
 * `binding_source_id IS NOT NULL` obligation is carried by a DEFERRED
 * constraint trigger that re-derives the sum from the ledger at COMMIT
 * (`sales_cogs_owed`, specified in docs/PHASE_4_S2_CONTRACT.md C-07), in the
 * `inventory_source_value_complete()` form of `0061`, rather than by a row
 * `CHECK` over a value no row holds.
 */
export function saleCogsPostingCommand(i: SaleCogsPostingInput): PostingCommand | null {
  if (i.cogsBaseMinor < 0n) throw new Error('a sale COGS magnitude is never negative');
  if (i.cogsBaseMinor === 0n) return null;
  const currency = i.baseCurrency.toUpperCase();
  const line = (systemKey: 'cogs' | 'inventory', side: 'D' | 'C'): PostingLineCommand => ({
    account: { kind: 'system', systemKey },
    side,
    baseAmountMinor: i.cogsBaseMinor,
    baseCurrency: currency,
    txnAmountMinor: i.cogsBaseMinor,
    txnCurrency: currency,
    fxRate: DOMESTIC_RATE_TEXT,
    fxRateSource: 'base',
    fxRateAt: new Date(`${i.documentDate}T00:00:00Z`),
    branchId: i.branchId,
    warehouseId: i.warehouseId,
    memo: null,
  });
  return {
    tenantId: i.tenantId,
    businessId: i.businessId,
    sourceType: SALE_SOURCE,
    sourceId: i.saleId,
    entryDate: i.documentDate,
    lines: [line('cogs', 'D'), line('inventory', 'C')],
    description: null,
    requestId: i.businessTransactionId,
  };
}

export interface InvoiceRevenuePostingInput extends SalePostingBase {
  /** The accounting `source_id`: the invoice's own id (lock §4: revenue is bound to the `invoice` source). */
  readonly invoiceId: string;
  /**
   * What the merchant STATED, read from the stored `sales.settlement_mode`.
   * It selects the debit account and nothing else: the credit side, both
   * amounts and the whole FX snapshot are identical either way, so the two
   * shapes are one shape with one substituted account and the deferred
   * `invoice_entry_complete` validator can re-derive both from the stored row.
   */
  readonly settlementMode: SaleSettlementMode;
  /** The invoice's own currency, ISO upper case. */
  readonly currency: string;
  /** T: the invoice total in txn minor units. `>= 1` — a zero invoice is not representable (`0075:260`). */
  readonly totalTxnMinor: bigint;
  /** B = convert(T): the ONE conversion, HALF_EVEN, made once and stored. */
  readonly totalBaseMinor: bigint;
  readonly fx: SaleFx;
}

/**
 * The revenue entry (lock §4: revenue recognised is `journal_lines` on **`4000`
 * `sales_revenue`** bound to the `invoice` source — `4100` is Sales Returns and
 * is the credit note's account, which the lock's own independent review had to
 * correct as RT-01).
 *
 * `Dr accounts_receivable T/B / Cr sales_revenue T/B`: one line each, both
 * carrying the same txn amount, the same base amount and the same FX snapshot,
 * so the entry balances in base BY CONSTRUCTION and each line is the exact
 * `HALF_EVEN` conversion of its own txn amount at its own rate (`0043:208-245`).
 * This is the accepted `purchasePostingCommand` shape with the sides and the
 * accounts of a sale.
 *
 * Two lines, not three. `ACCOUNTING_RULES.md` §5.2's tidy `Dr Bank / Cr AR /
 * Cr FX Gain` shape passes only because its numbers are tidy; there is no
 * realized FX on an invoice, because nothing has been released yet — the
 * carrying-release law (P4-AL-21) applies to the SETTLEMENT, which is P4-S4's.
 *
 * Both lines carry the branch and NO warehouse: a receivable and a revenue
 * figure are not warehouse-dimensional, which is also what makes
 * `R-INV-01`'s Inventory sum untouched by this entry.
 *
 * The debit is `accounts_receivable` for a `credit` sale and the **`cash`
 * system account** for a `cash` one. The cash arm writes NO payment document:
 * `payments`, `payment_allocations` and the settlement entry are P4-S4's
 * relations and `P4-AL-86` forbids creating a later slice's relation here, so
 * a walk-in cash sale's revenue is balanced by a direct debit on `1000 Cash on
 * Hand` and the fact that the customer paid is the stored
 * `sales.settlement_mode` input rather than a derived state.
 *
 * It does **not** debit a `payment_methods` posting account. That account is
 * reached through a `payments` row (`0067:352-354`'s three-column FK), which
 * is exactly the document this slice may not write; debiting it without one
 * would leave a settlement entry nothing can reverse at the allocation grain
 * P4-AL-17 requires. The narrower `cash` identity is the honest one, and the
 * cost is recorded in docs/PHASE_4_S2_CONTRACT.md D-01 rather than hidden.
 *
 * A walk-in (null `customer_id`) is therefore representable only as a `cash`
 * sale, and that is a PHYSICAL fact, not a convention: `0075`'s deferred
 * `invoices_walkin_no_ar` constraint trigger reads the posted entry's lines
 * and refuses a receivable line behind a null customer (`0075:660-693`).
 */
export function invoiceRevenuePostingCommand(i: InvoiceRevenuePostingInput): PostingCommand {
  if (i.totalTxnMinor <= 0n || i.totalBaseMinor <= 0n) throw new Error('an invoice total is positive');
  const line = (systemKey: 'accounts_receivable' | 'cash' | 'sales_revenue', side: 'D' | 'C'): PostingLineCommand => ({
    account: { kind: 'system', systemKey },
    side,
    baseAmountMinor: i.totalBaseMinor,
    baseCurrency: i.baseCurrency.toUpperCase(),
    txnAmountMinor: i.totalTxnMinor,
    txnCurrency: i.currency.toUpperCase(),
    fxRate: i.fx.rate,
    fxRateSource: i.fx.source,
    fxRateAt: i.fx.at,
    branchId: i.branchId,
    warehouseId: null,
    memo: null,
  });
  return {
    tenantId: i.tenantId,
    businessId: i.businessId,
    sourceType: INVOICE_SOURCE,
    sourceId: i.invoiceId,
    entryDate: i.documentDate,
    lines: [line(i.settlementMode === 'credit' ? 'accounts_receivable' : 'cash', 'D'), line('sales_revenue', 'C')],
    description: null,
    requestId: i.businessTransactionId,
  };
}
