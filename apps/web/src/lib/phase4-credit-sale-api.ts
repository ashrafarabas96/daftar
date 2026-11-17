'use client';
/**
 * Typed client for the credit sale (البيع بالدين): P4-S2's ONE writing route,
 * `POST /v1/sales`, with `settlementMode: 'credit'` and the customer the sale is
 * owed by. A separate file from `phase4-pos-api.ts` because it is a money WRITE
 * with its own review, and because it is the one web client that sends a REAL
 * `customerId` to that route — `test/od03.test.ts` admits it by exact path.
 *
 * ── LAW ─────────────────────────────────────────────────────────────────
 *   - one path convention: `${BFF}/<resource>`, NO `/v1` (the proxy adds it);
 *   - every GET is `cache: 'no-store'`;
 *   - the response DTOs are IMPORTED from the contract, never redeclared. The
 *     REQUEST is declared here because the contract's `SaleCommitRequestDto`
 *     types `settlementMode` and `customerId` loosely; this one pins the credit
 *     arm. It mirrors `SaleCommitSchema`
 *     (`apps/api/src/modules/selling/selling.schemas.ts`), which is `.strict()`,
 *     so only these keys are ever sent;
 *   - there is no price, no total, no currency, no rate and no cost in the
 *     request: the server resolves every one of them, and this file does no
 *     arithmetic on anything;
 *   - `saleId` IS the idempotency key (P4-AL-30). The API keys on the body and
 *     ignores the header; the same id is also sent as `idempotency-key` so a
 *     retried request is the same request at every layer.
 *
 * Authorization, business scope and language headers are set by `apiFetch`.
 */
import type { CustomerDto, SaleDto } from '@daftar/shared-contracts';
import { apiFetch } from './client';

export type { CustomerDto, SaleDto };

const BFF = '/api/proxy';

/** One sale line: an identity, a quantity as decimal text, and the discount request (always none here). */
export interface CreditSaleLineRequestDto {
  lineId: string;
  productId: string;
  /** The merchant variant, or null for a simple product. Never the hidden base variant. */
  variantId: string | null;
  quantity: string;
  discountMinor: string;
}

/** `POST /v1/sales`, the credit arm: a named customer owes it, and the pay-by date is theirs or null. */
export interface CreditSaleRequestDto {
  saleId: string;
  settlementMode: 'credit';
  customerId: string;
  warehouseId: string;
  documentDate: string;
  dueDate: string | null;
  /** The structural zero (`POS_SALE_TAX_MINOR`): `SaleCommitSchema` admits the literal `'0'` and nothing else. */
  taxMinor: string;
  notes: string | null;
  lines: CreditSaleLineRequestDto[];
}

const seg = (id: string): string => encodeURIComponent(id);

/** `GET /v1/customers/:id` — the name and status the screen shows (`customers.view`). */
export const getCustomer = (id: string) => apiFetch<CustomerDto>(`${BFF}/customers/${seg(id)}`, { cache: 'no-store' });

/**
 * `GET /v1/sales/:saleId` — a stored sale (`sales.view`). Read when a send is
 * refused `sale.idempotency_conflict`: a sale with this id is already stored.
 */
export const getStoredSale = (saleId: string) => apiFetch<SaleDto>(`${BFF}/sales/${seg(saleId)}`, { cache: 'no-store' });

/** `POST /v1/sales` → `200`, the committed sale; an identical re-send is `200` with `replayed: true`. */
export const commitCreditSale = (body: CreditSaleRequestDto) =>
  apiFetch<SaleDto>(`${BFF}/sales`, {
    method: 'POST',
    cache: 'no-store',
    body: JSON.stringify(body),
    headers: { 'idempotency-key': body.saleId },
  });
