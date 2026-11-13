/**
 * The money of "Receive a payment" (القبض), pure and testable without React.
 *
 * What this module decides, and what it does not:
 *
 * - It turns typed text into minor units with `amountInputToMinor`, the one
 *   money parser the screens use (A-17): text and BigInt, never a float.
 * - The split over invoices is ENTERED by the merchant, one figure per
 *   invoice. Nothing here proposes, rounds or spreads an amount.
 * - It makes ONE sum — the allocations, to compare with the amount received —
 *   because the contract makes the client state `creditId` exactly when the
 *   payment leaves a remainder (`receivables.schemas.ts`, property 3;
 *   `receivables-payload.ts` refuses the mismatch). The sum is BigInt on
 *   strings and single-currency: a row of another currency makes it throw
 *   rather than be added or skipped.
 * - It does NOT refuse an excess. When the invoices take more than was
 *   received the body still goes, with `creditId: null`, and the server's
 *   refusal is what the merchant reads. The server is the authority.
 * - Same currency only: `paymentAmountMinor` (in the payment's currency) and
 *   `invoiceAmountAppliedMinor` (in the invoice's) "must be equal where the
 *   two currencies agree" (the schema's comment and the payload builder's
 *   check). An invoice in another currency is never allocated here, so the
 *   pair is always the same figure and neither is computed from the other.
 * - The ids are minted ONCE per form (`mintCollectIds`) and re-sent unchanged
 *   on every retry and double click: they are the idempotency key.
 */
import type { CustomerOpenInvoiceDto } from '@daftar/shared-contracts';
import type { CollectPaymentAllocationRequestDto, CollectPaymentRequestDto } from '@/lib/phase4-collect-payment-api';
import { amountInputToMinor } from '@/lib/phase3-format';
import { isNonZeroMinor } from '../common/amount-text';
import type { MethodChoice } from '../common/payment-methods';

/** The server's own ceiling (`CUSTOMER_PAYMENT_MAX_ALLOCATIONS`). */
export const MAX_ALLOCATIONS = 50;

const MINOR = /^-?\d+$/;
const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ── Amounts ──────────────────────────────────────────────────────────────

/** A typed amount as minor units, or null when it is not a positive amount at the currency's precision. */
export function parseAmount(text: string, currency: string): string | null {
  const minor = amountInputToMinor(text, currency);
  return minor !== null && isNonZeroMinor(minor) ? minor : null;
}

function big(amountMinor: string): bigint {
  if (!MINOR.test(amountMinor)) throw new Error(`not a minor-unit integer: ${amountMinor}`);
  return BigInt(amountMinor);
}

/** -1, 0 or 1, by BigInt on the two strings. */
export function compareMinor(a: string, b: string): -1 | 0 | 1 {
  const x = big(a);
  const y = big(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The exact sum of figures that are ALL in `currency`; a figure in any other currency throws. */
export function sumMinor(parts: readonly { currency: string; amountMinor: string }[], currency: string): string {
  let total = 0n;
  for (const part of parts) {
    if (part.currency !== currency) throw new Error(`cannot add ${part.currency} to a ${currency} payment: one currency per payment`);
    total += big(part.amountMinor);
  }
  return total.toString();
}

// ── Ids ──────────────────────────────────────────────────────────────────

export interface CollectIds {
  readonly paymentId: string;
  readonly creditId: string;
  /** The allocation id of one invoice: minted the first time it is asked for, the same ever after. */
  allocationIdFor(invoiceId: string): string;
}

/** The ids of ONE form. A new form — after a saved payment, or "start again" — mints new ones. */
export function mintCollectIds(mint: () => string = () => crypto.randomUUID()): CollectIds {
  const paymentId = mint();
  const creditId = mint();
  const allocations = new Map<string, string>();
  return {
    paymentId,
    creditId,
    allocationIdFor(invoiceId) {
      const known = allocations.get(invoiceId);
      if (known !== undefined) return known;
      const minted = mint();
      allocations.set(invoiceId, minted);
      return minted;
    },
  };
}

// ── The form ─────────────────────────────────────────────────────────────

/** An open invoice as the screen holds it: the server's row, untouched, and what the merchant typed against it. */
export interface CollectRowModel extends CustomerOpenInvoiceDto {
  amount: string;
  invalid: boolean;
}

export interface CollectFormErrors {
  method?: boolean;
  amount?: boolean;
  date?: boolean;
  reference?: boolean;
  rows?: boolean;
  tooMany?: boolean;
}

export interface CollectFormModel {
  methodId: string;
  currency: string;
  currencyOptions: string[];
  amount: string;
  date: string;
  reference: string;
  errors: CollectFormErrors;
}

/** True when the merchant may put money from a `currency` payment against this row. */
export function isAllocatable(row: CustomerOpenInvoiceDto, currency: string): boolean {
  return !row.isCredit && row.currency === currency;
}

/**
 * What a balance row (`isCredit`, DR-31) holds for the customer, as text: the
 * server's own figure with its minus sign removed, or null.
 *
 * Only the SIGN character is dropped, and only on a row the server itself
 * flags credit-bearing with a negative figure; no digit is touched and nothing
 * is computed. Any other shape — a positive or malformed figure on a balance
 * row, or a row that is not one — is null, and the screen then shows no figure
 * for it rather than guessing a direction. (Shown signed, the Arabic currency
 * format splits the figure with bidi marks; T-16 refuses that.)
 */
export function heldOnRow(row: Pick<CustomerOpenInvoiceDto, 'isCredit' | 'outstandingTxnMinor'>): string | null {
  const m = /^-(\d+)$/.exec(row.outstandingTxnMinor);
  return row.isCredit && m?.[1] !== undefined && isNonZeroMinor(m[1]) ? m[1] : null;
}

/** What is left of the amount received once the invoices have taken theirs: something, nothing, or less than nothing. */
export type Surplus = 'none' | 'kept' | 'over';

interface TypedAllocation {
  readonly invoiceId: string;
  readonly currency: string;
  readonly amountMinor: string;
}

function typedAllocations(rows: readonly CollectRowModel[], currency: string): { allocations: TypedAllocation[]; invalidRows: string[] } {
  const allocations: TypedAllocation[] = [];
  const invalidRows: string[] = [];
  for (const row of rows) {
    if (!isAllocatable(row, currency) || row.amount.trim().length === 0) continue;
    const minor = parseAmount(row.amount, currency);
    if (minor === null) invalidRows.push(row.invoiceId);
    else allocations.push({ invoiceId: row.invoiceId, currency: row.currency, amountMinor: minor });
  }
  return { allocations, invalidRows };
}

function surplusBetween(allocations: readonly TypedAllocation[], amountMinor: string, currency: string): Surplus {
  const order = compareMinor(sumMinor(allocations, currency), amountMinor);
  return order < 0 ? 'kept' : order === 0 ? 'none' : 'over';
}

/** The hint beside the form, from the same comparison the plan makes; null while any typed figure does not parse. */
export function surplusOf(form: CollectFormModel, rows: readonly CollectRowModel[]): Surplus | null {
  const amountMinor = parseAmount(form.amount, form.currency);
  if (amountMinor === null) return null;
  const typed = typedAllocations(rows, form.currency);
  if (typed.invalidRows.length > 0) return null;
  return surplusBetween(typed.allocations, amountMinor, form.currency);
}

export interface CollectPlanInput {
  customerId: string;
  form: CollectFormModel;
  rows: readonly CollectRowModel[];
  method: MethodChoice | undefined;
  ids: CollectIds;
}

export type CollectPlan =
  | { readonly ok: true; readonly body: CollectPaymentRequestDto; readonly surplus: Surplus }
  | { readonly ok: false; readonly errors: CollectFormErrors; readonly invalidRows: string[] };

/** The body to send, or the form's errors. Shape checks only: every money judgement is the server's. */
export function planCollectPayment(input: CollectPlanInput): CollectPlan {
  const { form, method, ids } = input;
  const amountMinor = parseAmount(form.amount, form.currency);
  const reference = form.reference.trim();
  const { allocations, invalidRows } = typedAllocations(input.rows, form.currency);
  const errors: CollectFormErrors = {
    method: method === undefined,
    amount: amountMinor === null,
    date: !CIVIL_DATE.test(form.date),
    reference: method?.requiresReference === true && reference.length === 0,
    rows: invalidRows.length > 0,
    tooMany: allocations.length > MAX_ALLOCATIONS,
  };
  if (Object.values(errors).some(Boolean) || method === undefined || amountMinor === null) return { ok: false, errors, invalidRows };
  const surplus = surplusBetween(allocations, amountMinor, form.currency);
  const legs: CollectPaymentAllocationRequestDto[] = allocations.map((a) => ({
    allocationId: ids.allocationIdFor(a.invoiceId),
    invoiceId: a.invoiceId,
    paymentAmountMinor: a.amountMinor,
    invoiceAmountAppliedMinor: a.amountMinor,
  }));
  return {
    ok: true,
    surplus,
    body: {
      paymentId: ids.paymentId,
      customerId: input.customerId,
      paymentMethodId: method.paymentMethodId,
      paymentDate: form.date,
      currencyCode: form.currency,
      amountMinor,
      reference: reference.length > 0 ? reference : null,
      creditId: surplus === 'kept' ? ids.creditId : null,
      allocations: legs,
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
