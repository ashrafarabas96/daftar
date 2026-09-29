import type { PostingCommand, PostingLineCommand } from '@daftar/accounting';
import type { SupplierReturnEntryLine } from '@daftar/inventory';
import type { ReceiptFx } from './purchase-posting';

/**
 * The journal side of a supplier return (PHASE_3_S5_CONTRACT A-05, A-06,
 * A-10(g), A-14).
 *
 * The command is built from the server's BOUND values — the entry lines
 * `planSupplierReturn` derived from the amounts the `purchase.return` payload
 * signs — never from request input, and its one accounting assertion is
 * minted over exactly this command before seam 2 opens. It posts through the
 * one generic primitive, `accounting_post_entry`, as source
 * `supplier_return`, `source_id` = the return id.
 *
 * - `entryDate` is the return's bound `document_date` (§0: no clock).
 * - A `purchase`-currency line (AP, supplier receivable) carries the
 *   purchase's stored FX snapshot: its currency, rate, `rate_source` and
 *   `rate_timestamp` — never a new lookup (§0).
 * - A `base` line (the AP dust, inventory, PPV) is in the base currency at
 *   rate 1, source `base`, at `<document_date>T00:00:00Z` — the S3 domestic
 *   line (`inventory-posting.ts`).
 * - The AP and 1150 lines carry the PURCHASE warehouse's home branch and no
 *   warehouse (the S4 AP precedent); the inventory and PPV lines carry the
 *   RETURN warehouse and its home branch (A-05).
 * - `requestId` is the business transaction id (P3-AL-35): narrative, outside
 *   the fingerprint. `description` is null.
 * - No `rounding` (6100), revenue or `tax_payable` line can appear: the plan's
 *   account set is closed (A-05, A-14, BLOCKED BY OD-03).
 */

export const SUPPLIER_RETURN_SOURCE = 'supplier_return';

/** `NUMERIC(20,10)` text of rate 1: every base line (A-10(g) lines 2, 4, 5). */
const BASE_RATE = '1.0000000000';

export interface SupplierReturnPostingInput {
  readonly tenantId: string;
  readonly businessId: string;
  /** The return id: the accounting `source_id`. */
  readonly returnId: string;
  /** `YYYY-MM-DD`: the bound `document_date`. */
  readonly documentDate: string;
  /** The purchase currency, ISO upper case. */
  readonly currency: string;
  /** The business's base currency. */
  readonly baseCurrency: string;
  /** The purchase's stored FX snapshot (A-17 of S4). */
  readonly fx: ReceiptFx;
  /** The purchase warehouse's home branch: the AP and 1150 dimension. */
  readonly purchaseBranchId: string;
  /** The return warehouse and its home branch: the inventory and PPV dimension. */
  readonly returnWarehouseId: string;
  readonly returnBranchId: string;
  /** `planSupplierReturn(...).entryLines`, in A-10(g) order. */
  readonly lines: readonly SupplierReturnEntryLine[];
  readonly businessTransactionId: string;
}

/** The `supplier_return` entry of A-10(g): one posting line per plan line, in order. */
export function supplierReturnPostingCommand(i: SupplierReturnPostingInput): PostingCommand {
  const baseCurrency = i.baseCurrency.toUpperCase();
  const baseAt = new Date(`${i.documentDate}T00:00:00Z`);
  const lines = i.lines.map((l): PostingLineCommand => {
    const purchaseCurrency = l.currency === 'purchase';
    const onPurchase = l.dimension === 'purchase';
    return {
      account: { kind: 'system', systemKey: l.systemKey },
      side: l.side,
      baseAmountMinor: l.baseAmountMinor,
      baseCurrency,
      txnAmountMinor: l.txnAmountMinor,
      txnCurrency: purchaseCurrency ? i.currency.toUpperCase() : baseCurrency,
      fxRate: purchaseCurrency ? i.fx.rate : BASE_RATE,
      fxRateSource: purchaseCurrency ? i.fx.source : 'base',
      fxRateAt: purchaseCurrency ? i.fx.at : baseAt,
      branchId: onPurchase ? i.purchaseBranchId : i.returnBranchId,
      warehouseId: onPurchase ? null : i.returnWarehouseId,
      memo: null,
    };
  });
  return {
    tenantId: i.tenantId,
    businessId: i.businessId,
    sourceType: SUPPLIER_RETURN_SOURCE,
    sourceId: i.returnId,
    entryDate: i.documentDate,
    lines,
    description: null,
    requestId: i.businessTransactionId,
  };
}
