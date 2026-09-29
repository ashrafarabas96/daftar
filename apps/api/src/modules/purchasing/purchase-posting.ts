import type { PostingCommand, PostingLineCommand } from '@daftar/accounting';
import { adjustmentPostingCommand } from '../inventory/inventory-posting';

/**
 * The journal side of a purchase receipt (PHASE_3_S4_CONTRACT A-05, A-06,
 * A-13 step 9, A-16(i), A-17).
 *
 * Both commands are built from the server's BOUND values — the totals, the
 * FX snapshot and the coverage net the receipt payload signs — never from
 * request input, and each accounting assertion is minted over exactly its
 * command before seam 2 opens. They post through the one generic primitive,
 * `accounting_post_entry`, in this order: `purchase`, then (iff N ≠ 0)
 * `negative_inventory_cost_adjustment`.
 *
 * - `entryDate` is the purchase's `document_date` for both entries.
 * - `requestId` is the business transaction id (P3-AL-35): narrative,
 *   outside the fingerprint. `description` is null.
 * - No `rounding` (6100), `purchase_price_variance` (6200) or `tax_payable`
 *   line ever appears (P:207, A-12).
 */

export const PURCHASE_SOURCE = 'purchase';
export const CATCH_UP_SOURCE = 'negative_inventory_cost_adjustment';

/** The FX snapshot of the receipt, exactly as `purchases` stores it (A-17). */
export interface ReceiptFx {
  /** `NUMERIC(20,10)` text: `1.0000000000` when domestic. */
  readonly rate: string;
  readonly source: 'base' | 'manual';
  /** Second precision: `<date>T00:00:00Z` when domestic, the registry row's `effective_at` otherwise. */
  readonly at: Date;
}

export interface PurchasePostingInput {
  readonly tenantId: string;
  readonly businessId: string;
  readonly purchaseId: string;
  /** `YYYY-MM-DD`. */
  readonly documentDate: string;
  /** The purchase currency, ISO upper case. */
  readonly currency: string;
  /** The business's base currency. */
  readonly baseCurrency: string;
  /** T: the purchase total in txn minor units. */
  readonly totalTxnMinor: bigint;
  /** B = convert(T): the one conversion (A-13 step 6). */
  readonly totalBaseMinor: bigint;
  readonly fx: ReceiptFx;
  readonly warehouseId: string;
  /** The warehouse's home branch. */
  readonly branchId: string;
  readonly businessTransactionId: string;
}

/**
 * `Dr inventory T/B` (the purchase warehouse and its home branch) and
 * `Cr accounts_payable T/B` (the home branch, no warehouse): one line each,
 * both carrying the same txn amount, base amount and FX, so the entry
 * balances in base by construction and each line satisfies 0043 (A-05).
 */
export function purchasePostingCommand(i: PurchasePostingInput): PostingCommand {
  const line = (systemKey: 'inventory' | 'accounts_payable', side: 'D' | 'C', warehouseId: string | null): PostingLineCommand => ({
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
    warehouseId,
    memo: null,
  });
  return {
    tenantId: i.tenantId,
    businessId: i.businessId,
    sourceType: PURCHASE_SOURCE,
    sourceId: i.purchaseId,
    entryDate: i.documentDate,
    lines: [line('inventory', 'D', i.warehouseId), line('accounts_payable', 'C', null)],
    description: null,
    requestId: i.businessTransactionId,
  };
}

export interface CatchUpPostingInput {
  readonly tenantId: string;
  readonly businessId: string;
  /** The coverage header id: the accounting `source_id` (A-10(a)). */
  readonly adjustmentId: string;
  readonly documentDate: string;
  readonly baseCurrency: string;
  readonly warehouseId: string;
  readonly branchId: string;
  /** N = Σ of the stored coverage values, signed. */
  readonly netValueMinor: bigint;
  readonly businessTransactionId: string;
}

/**
 * The single catch-up entry of a receipt's coverages (A-16(i)): N < 0 posts
 * `Dr cogs |N| / Cr inventory |N|`, N > 0 `Dr inventory N / Cr cogs N`, both
 * domestic, both at the warehouse and its home branch — the S3 adjustment
 * shape (`adjustmentPostingCommand`) under its own source type. Null when
 * N = 0: nothing is posted and no assertion is minted.
 */
export function catchUpPostingCommand(i: CatchUpPostingInput): PostingCommand | null {
  const command = adjustmentPostingCommand({
    tenantId: i.tenantId,
    businessId: i.businessId,
    sourceId: i.adjustmentId,
    occurredOn: i.documentDate,
    baseCurrency: i.baseCurrency,
    businessTransactionId: i.businessTransactionId,
    warehouseId: i.warehouseId,
    branchId: i.branchId,
    netValueMinor: i.netValueMinor,
  });
  return command === null ? null : { ...command, sourceType: CATCH_UP_SOURCE };
}
