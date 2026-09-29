/**
 * View models of the purchasing screens (P3-S7 contract A-11, A-13). The page
 * (a thin container) maps the server's DTOs onto these; a view renders them
 * and nothing else. Every amount is a minor-unit string the server computed,
 * every quantity a decimal string, every field the merchant types a string.
 */
import type { PaymentMethodDto, PurchaseReceiptDto, PurchaseStatusDto, SupplierPaymentDto } from '@daftar/shared-contracts';
import type { PurchaseReturnBlockDto } from '@/lib/phase3-api';

// ── Purchase list ────────────────────────────────────────────────────────

export type PurchaseFilter = 'all' | 'draft' | 'received' | 'cancelled';

export interface PurchaseRowModel {
  purchaseId: string;
  supplierName: string;
  warehouseName: string;
  documentDate: string;
  supplierReference: string | null;
  status: PurchaseStatusDto;
  currency: string;
  totalTxnMinor: string;
}

// ── Receive Purchase ─────────────────────────────────────────────────────

export interface SupplierOption {
  supplierId: string;
  name: string;
}

export interface ItemOption {
  productId: string;
  name: string;
  unitDecimals: number;
  /** Merchant variants only: the base variant is never offered (P3-AL-52). */
  variants: { variantId: string; name: string }[];
}

export interface ReceiveLineForm {
  lineId: string;
  item: ItemOption | null;
  itemSearch: string;
  itemResults: ItemOption[];
  /** True once a search for the typed text answered with nothing (m-21). */
  itemNoMatch?: boolean;
  variantId: string | null;
  quantity: string;
  unitPrice: string;
  showDiscount: boolean;
  discount: string;
  errors: { item?: boolean; variant?: boolean; quantity?: boolean; unitPrice?: boolean; discount?: boolean };
}

/** The extra-cost presets (A-13). There is no duty or other purchase-tax preset (BLOCKED BY OD-03). */
export const EXTRA_COST_KINDS = ['shipping', 'customs', 'other'] as const;
export type ExtraCostKind = (typeof EXTRA_COST_KINDS)[number];

export interface ExtraCostForm {
  landedCostId: string;
  kind: ExtraCostKind;
  amount: string;
  /** "Split manually" (the second level); otherwise the server spreads it by value. */
  manual: boolean;
  /** lineId → the share typed for that line, used only when `manual`. */
  shares: Readonly<Record<string, string>>;
  errors: { amount?: boolean; shares?: boolean };
}

export interface ReceiveForm {
  supplier: SupplierOption | null;
  supplierSearch: string;
  supplierResults: SupplierOption[];
  /** True once a search for the typed text answered with nothing (m-21). */
  supplierNoMatch?: boolean;
  /** Non-null while "Add a new supplier" is open. */
  newSupplierName: string | null;
  /** The name of an existing supplier the new name matches — a hint, never a block (A-15(c)). */
  duplicateOf: string | null;
  warehouseId: string;
  documentDate: string;
  showCurrency: boolean;
  currency: string;
  supplierReference: string;
  notes: string;
  lines: ReceiveLineForm[];
  extraCosts: ExtraCostForm[];
  errors: { supplier?: boolean; warehouse?: boolean; date?: boolean; lines?: boolean };
}

/** The server's totals for the saved draft (A-13 "Review"). */
export interface ReceiveReviewModel {
  currency: string;
  subtotalTxnMinor: string;
  landedCostTxnMinor: string;
  totalTxnMinor: string;
  lines: {
    lineId: string;
    name: string;
    variantName: string | null;
    qty: string;
    unitDecimals: number;
    unitPrice: string;
    discountTxnMinor: string;
    netTxnMinor: string;
  }[];
}

/** "Paid now" on the review (A-13; Annex R #6): shown only to a holder of `suppliers.pay`. The payment date is the document date. */
export interface PayNowForm {
  on: boolean;
  /** As the server answered them, inactive included: the view offers the active ones (Annex R #20). */
  methods: PaymentMethodDto[];
  methodId: string;
  /** The purchase currency first, then the business currency when it differs. */
  currencyOptions: string[];
  payCurrency: string;
  amount: string;
  /** "Amount this settles in {C}" — asked only when the payment currency differs from the purchase's. */
  applied: string;
  reference: string;
  errors: { method?: boolean; amount?: boolean; applied?: boolean; reference?: boolean };
}

/**
 * The receipt as the server answered it — with its trace, entry and movement
 * ids, which the view never renders (A-13, T-08) — and the payment when the
 * purchase was received and paid in one step.
 */
export interface ReceiveResultModel {
  receipt: PurchaseReceiptDto;
  payment: SupplierPaymentDto | null;
  baseCurrency: string;
}

export type ReceiveStep = 'edit' | 'review' | 'done';

// ── Purchase detail ──────────────────────────────────────────────────────

export interface PurchaseDetailLine {
  lineId: string;
  name: string;
  variantName: string | null;
  qty: string;
  unitDecimals: number;
  unitPrice: string;
  discountTxnMinor: string;
  netTxnMinor: string;
}

export interface PurchaseDetailModel {
  purchaseId: string;
  status: PurchaseStatusDto;
  supplierName: string;
  warehouseName: string;
  documentDate: string;
  supplierReference: string | null;
  notes: string | null;
  currency: string;
  baseCurrency: string;
  subtotalTxnMinor: string;
  landedCostTxnMinor: string;
  totalTxnMinor: string;
  /** Shown only for a foreign-currency purchase. */
  rate: string | null;
  lines: PurchaseDetailLine[];
}

export interface PurchaseReturnRow {
  returnId: string;
  documentDate: string;
  currency: string;
  carryingTxnMinor: string;
}

export interface PurchaseActions {
  continueDraft: boolean;
  returnToSupplier: boolean;
  /** "Undo receipt" (TL-4): present only when the S7 read says S5/S6 would accept it — absent, not disabled. */
  undoReceipt: boolean;
  paySupplier: boolean;
  /** TD-16: close a leftover smaller than the smallest coin (the payable read says so); never beside "Pay". */
  closeLeftover: boolean;
}

export interface UndoReceiptForm {
  open: boolean;
  reason: string;
  reasonMissing: boolean;
  busy: boolean;
}

// ── Return to Supplier ───────────────────────────────────────────────────

export interface ReturnLineForm {
  purchaseLineId: string;
  name: string;
  variantName: string | null;
  unitDecimals: number;
  purchasedQty: string;
  returnedQty: string;
  returnableQty: string;
  quantity: string;
  invalid: boolean;
}

export type ReturnBlock = PurchaseReturnBlockDto;
