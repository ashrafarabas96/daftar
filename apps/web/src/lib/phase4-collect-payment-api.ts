'use client';
/**
 * Typed client for "Receive a payment" (القبض, P4-S4), in the idiom of the
 * other `phase4-*` libraries and a separate file because it is a money WRITE
 * with its own review. Part of the customers slice that `test/od03.test.ts`
 * admits by exact path.
 *
 * ── LAW ─────────────────────────────────────────────────────────────────
 *   - one path convention: `${BFF}/<resource>`, NO `/v1` (the proxy adds it);
 *   - every GET is `cache: 'no-store'`: an open invoice is read live;
 *   - the response DTOs are IMPORTED from the contract, never redeclared. The
 *     REQUEST is declared here because `@daftar/shared-contracts` does not
 *     export it: it mirrors `CustomerPaymentSchema`
 *     (`apps/api/src/modules/receivables/receivables.schemas.ts`), which is
 *     `.strict()`, so only these keys are ever sent;
 *   - every amount is a decimal STRING of minor units, sent as typed by the
 *     plan in `views/customers/collect-payment.ts` and never touched here;
 *   - the payment id is the idempotency key (R-74). The same id travels in the
 *     `idempotency-key` header so a retried request is the same request at
 *     every layer; the API itself keys on the body's ids alone.
 *
 * Authorization, business scope and language headers are set by `apiFetch`.
 */
import type { CustomerDto, CustomerOpenInvoiceDto, CustomerOpenInvoicesDto, CustomerPaymentDto, CustomerPaymentResultDto } from '@daftar/shared-contracts';
import { apiFetch } from './client';

export type { CustomerDto, CustomerOpenInvoiceDto, CustomerOpenInvoicesDto, CustomerPaymentDto, CustomerPaymentResultDto };

const BFF = '/api/proxy';

/** One leg of a payment. Same currency: the two figures are equal (the schema's own rule). */
export interface CollectPaymentAllocationRequestDto {
  allocationId: string;
  invoiceId: string;
  paymentAmountMinor: string;
  invoiceAmountAppliedMinor: string;
}

/** `POST /v1/customer-payments`. `creditId` is stated exactly when the payment leaves a remainder. */
export interface CollectPaymentRequestDto {
  paymentId: string;
  customerId: string;
  paymentMethodId: string;
  paymentDate: string;
  currencyCode: string;
  amountMinor: string;
  reference: string | null;
  creditId: string | null;
  allocations: CollectPaymentAllocationRequestDto[];
}

/** The query `GET /v1/customers/:id/open-invoices` accepts (`.strict()`): `asOf` is required. */
export interface OpenInvoicesQuery {
  asOf: string;
  /** The last row's invoice id, from `nextCursor`. */
  cursor?: string;
  /** 1 to 50. */
  limit?: number;
}

function qs(params: Readonly<Record<string, string | number | undefined>>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    q.set(key, String(value));
  }
  const text = q.toString();
  return text.length > 0 ? `?${text}` : '';
}

/** `GET /v1/customers/:id` — the name and status the screen shows (`customers.view`). */
export const getCustomer = (id: string) => apiFetch<CustomerDto>(`${BFF}/customers/${encodeURIComponent(id)}`, { cache: 'no-store' });

/** `GET /v1/customers/:id/open-invoices` — oldest first, `receivables.view`, business-wide callers only. */
export const listOpenInvoices = (id: string, q: OpenInvoicesQuery) =>
  apiFetch<CustomerOpenInvoicesDto>(`${BFF}/customers/${encodeURIComponent(id)}/open-invoices${qs({ ...q })}`, { cache: 'no-store' });

/**
 * `GET /v1/customer-payments/:paymentId` — a stored payment (`receivables.view`, the key the open-invoice
 * read already needs). Read when a send is refused as already stored under the same id.
 */
export const getStoredPayment = (paymentId: string) =>
  apiFetch<CustomerPaymentDto>(`${BFF}/customer-payments/${encodeURIComponent(paymentId)}`, { cache: 'no-store' });

/** `POST /v1/customer-payments` — 201 first time, 200 with `replayed: true` for the identical re-send. */
export const collectPayment = (body: CollectPaymentRequestDto) =>
  apiFetch<CustomerPaymentResultDto>(`${BFF}/customer-payments`, {
    method: 'POST',
    cache: 'no-store',
    body: JSON.stringify(body),
    headers: { 'idempotency-key': body.paymentId },
  });
