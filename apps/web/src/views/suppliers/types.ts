/**
 * View models of the supplier screens (P3-S7 contract A-09, A-11, A-13). The
 * page maps the server's DTOs onto these; a view renders them and nothing
 * else. Amounts are minor-unit strings the server computed; the merchant's
 * typed amounts are strings until `amountInputToMinor` reads them.
 */
import type { PaymentMethodDto, SupplierRefundResultDto, SupplierStatusDto } from '@daftar/shared-contracts';
import type { CurrencyAmountDto, PaymentMethodDefaultDto } from '@/lib/phase3-api';

export interface SupplierRowModel {
  supplierId: string;
  name: string;
  status: SupplierStatusDto;
  /** Business-wide callers only (S4 TL-4): what the merchant still owes, per currency. */
  owed: CurrencyAmountDto[] | null;
  /** Business-wide callers only: the balance in your favour, per currency. */
  inYourFavour: CurrencyAmountDto[] | null;
}

export interface OpenPurchaseRowModel {
  purchaseId: string;
  documentDate: string;
  supplierReference: string | null;
  currency: string;
  totalTxnMinor: string;
  outstandingTxnMinor: string;
}

export interface FavourNoteModel {
  creditNoteId: string;
  issuedOn: string;
  currency: string;
  remainingTxnMinor: string;
}

/** "Get money back" (S6 refund; A-11): business-wide + `suppliers.pay`. */
export interface MoneyBackForm {
  open: boolean;
  notes: FavourNoteModel[];
  creditNoteId: string;
  /** As the server answered them, inactive included: the view offers the active ones (Annex R #20). */
  methods: PaymentMethodDto[];
  methodId: string;
  amount: string;
  date: string;
  /** "Received in a different currency" reveals the receipt currency and amount. */
  differentCurrency: boolean;
  currencies: string[];
  receiptCurrency: string;
  receiptAmount: string;
  reference: string;
  errors: { note?: boolean; method?: boolean; amount?: boolean; receiptAmount?: boolean; reference?: boolean };
  busy: boolean;
  /** The server's answer (trace and entry ids included — never rendered). */
  done: SupplierRefundResultDto | null;
}

// ── Pay Supplier ─────────────────────────────────────────────────────────

export interface PayRowModel extends OpenPurchaseRowModel {
  /** The server's oldest-first proposal for this purchase; null when none was asked or the purchase is in another currency. */
  proposedMinor: string | null;
  /** "Change the split": what the merchant types for this purchase, in the payment currency. */
  amount: string;
  /** "Amount this settles in {C}", asked only when the purchase currency differs from the payment's (S6 A-07). */
  applied: string;
  invalid: boolean;
}

/** The first way to pay (A-09(e), TL-3): the merchant picks a kind; the system picks the account. */
export interface MethodSetupModel {
  /** `choose` for a holder of the setup permissions; `ask_owner` otherwise. */
  mode: 'choose' | 'ask_owner';
  options: PaymentMethodDefaultDto[];
  chosen: PaymentMethodDefaultDto['systemType'] | null;
  busy: boolean;
}

export interface PayFormModel {
  methodId: string;
  currency: string;
  currencyOptions: string[];
  amount: string;
  date: string;
  reference: string;
  /** "Change the split": per-purchase amounts typed by the merchant instead of the proposal. */
  manual: boolean;
  errors: { method?: boolean; amount?: boolean; date?: boolean; reference?: boolean; rows?: boolean };
}

/** "Use your balance in your favour" (A-11): the server proposes which open purchases it settles. */
export interface FavourUseModel {
  creditNoteId: string;
  currency: string;
  rows: { purchaseId: string; documentDate: string; proposedMinor: string }[];
  unallocatedMinor: string | null;
  busy: boolean;
  done: boolean;
}
