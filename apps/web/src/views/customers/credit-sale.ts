/**
 * The credit sale (البيع بالدين), pure and testable without React: what the
 * merchant typed, turned into the one body `POST /v1/sales` accepts.
 *
 * What this module decides, and what it does not:
 *
 * - It sends IDENTITIES, QUANTITIES and two DATES. It sends no price, no
 *   total, no currency, no rate and no cost: the server resolves every one
 *   from its catalogue and its registry, and validating a client figure would
 *   "imply the client's number could be adopted" (P4-AL-18). So there is no
 *   money in this module at all — nothing is parsed, added or rounded.
 * - `settlementMode` is `'credit'` and `customerId` is the customer the route
 *   named. A credit sale owed by nobody is refused by the schema, the row
 *   CHECK and `invoices_walkin_no_ar`; here it is a defect and THROWS, so a
 *   malformed id can never be sent as a walk-in by accident.
 * - The discount request is always none (`NO_DISCOUNT_MINOR`): a discount
 *   needs the SENSITIVE `sales.discount`, and this screen offers none.
 * - `taxMinor` is the structural zero the POS client already names
 *   (`POS_SALE_TAX_MINOR`, P4-AL-44, OD-03 open): a position, not an amount.
 * - The dates are CIVIL DATES judged by text: a real `YYYY-MM-DD` day, and a
 *   pay-by date ON or after the sale date (`dueDate >= documentDate`, the
 *   schema's own rule, inclusive). No clock and no time zone is read here; the
 *   sale date is the one the form holds, stated when the form opened.
 * - The ids are minted ONCE per form (`mintCreditSaleIds`) and re-sent
 *   unchanged on every retry and double click: they are the idempotency key.
 */
import type { CreditSaleLineRequestDto, CreditSaleRequestDto } from '@/lib/phase4-credit-sale-api';
import { POS_SALE_TAX_MINOR } from '@/lib/phase4-pos-api';
import { isUuid } from '@/lib/route-ids';
import { lineQuantityErrors, quantityText, type DraftLine } from '../stock/model';

/** The server's own ceiling (`MAX_SALE_LINES`, `packages/domain-core/src/sale.ts`). */
export const MAX_SALE_LINES = 200;

/** The discount request of every line: none. Text of minor units, as the schema requires. */
export const NO_DISCOUNT_MINOR = '0';

const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * True for a real calendar day in `YYYY-MM-DD`. The text is read back through
 * a UTC date and must come out unchanged, so `2026-11-31` and `2027-02-29` are
 * refused and `2028-02-29` is not. UTC is explicit: no local zone is involved.
 */
export function isCivilDate(text: string): boolean {
  if (!CIVIL_DATE.test(text)) return false;
  const at = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === text;
}

// ── Ids ──────────────────────────────────────────────────────────────────

export interface CreditSaleIds {
  readonly saleId: string;
  /** The sale line id of one form line: minted the first time it is asked for, the same ever after. */
  lineIdFor(lineKey: string): string;
}

/** The ids of ONE form. A new form — after a saved or an already-stored sale — mints new ones. */
export function mintCreditSaleIds(mint: () => string = () => crypto.randomUUID()): CreditSaleIds {
  const saleId = mint();
  const lines = new Map<string, string>();
  return {
    saleId,
    lineIdFor(lineKey) {
      const known = lines.get(lineKey);
      if (known !== undefined) return known;
      const minted = mint();
      lines.set(lineKey, minted);
      return minted;
    },
  };
}

// ── The form ─────────────────────────────────────────────────────────────

export interface CreditSaleFormErrors {
  warehouse?: boolean;
  date?: boolean;
  dueDate?: boolean;
  lines?: boolean;
  tooMany?: boolean;
}

export interface CreditSaleFormModel {
  warehouseId: string;
  /** The sale date, `YYYY-MM-DD`, stated when the form opened and kept across every retry. */
  documentDate: string;
  /** The pay-by date as typed; empty for none. */
  dueDate: string;
  errors: CreditSaleFormErrors;
}

export interface CreditSalePlanInput {
  customerId: string;
  form: CreditSaleFormModel;
  lines: readonly DraftLine[];
  ids: CreditSaleIds;
}

export type CreditSalePlan =
  | { readonly ok: true; readonly body: CreditSaleRequestDto }
  | { readonly ok: false; readonly errors: CreditSaleFormErrors; readonly lineErrors: Readonly<Record<string, string>> };

/** The body to send, or the form's errors. Shape checks only: every judgement of price, stock and money is the server's. */
export function planCreditSale(input: CreditSalePlanInput): CreditSalePlan {
  const { form, lines, ids } = input;
  if (!isUuid(input.customerId)) throw new Error('a credit sale names the customer who owes it: no valid customer id was given');
  const dueText = form.dueDate.trim();
  const dateOk = isCivilDate(form.documentDate);
  const errors: CreditSaleFormErrors = {
    warehouse: form.warehouseId.length === 0,
    date: !dateOk,
    dueDate: dueText.length > 0 && (!isCivilDate(dueText) || (dateOk && dueText < form.documentDate)),
    lines: lines.length === 0,
    tooMany: lines.length > MAX_SALE_LINES,
  };
  const lineErrors = lineQuantityErrors(lines, false);
  if (Object.values(errors).some(Boolean) || Object.keys(lineErrors).length > 0) return { ok: false, errors, lineErrors };
  const body: CreditSaleLineRequestDto[] = lines.map((line) => ({
    lineId: ids.lineIdFor(line.lineKey),
    productId: line.productId,
    variantId: line.variantId,
    quantity: quantityText(line.quantity),
    discountMinor: NO_DISCOUNT_MINOR,
  }));
  return {
    ok: true,
    body: {
      saleId: ids.saleId,
      settlementMode: 'credit',
      customerId: input.customerId,
      warehouseId: form.warehouseId,
      documentDate: form.documentDate,
      dueDate: dueText.length > 0 ? dueText : null,
      taxMinor: POS_SALE_TAX_MINOR,
      notes: null,
      lines: body,
    },
  };
}

// ── Sending ──────────────────────────────────────────────────────────────

export interface SubmitGuard {
  /** Runs `send` unless a send is already in flight, in which case it returns null and sends nothing. */
  run<T>(send: () => Promise<T>): Promise<T> | null;
  readonly busy: boolean;
}

/** One send at a time per form: a double click, or a second tap before the button re-renders disabled, sends once. */
export function createSubmitGuard(): SubmitGuard {
  let inFlight = false;
  return {
    run<T>(send: () => Promise<T>): Promise<T> | null {
      if (inFlight) return null;
      inFlight = true;
      let sent: Promise<T>;
      try {
        sent = send();
      } catch (error) {
        inFlight = false;
        throw error;
      }
      return sent.finally(() => {
        inFlight = false;
      });
    },
    get busy() {
      return inFlight;
    },
  };
}
