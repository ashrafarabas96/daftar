'use client';
/**
 * Typed client for the customer LIST read of Phase 4 (MVP-02), in the idiom of
 * `phase4-invoices-api.ts` and a separate file for the same reason: it has its
 * own audit. This is the one client library that names a customer — the
 * customers slice (see `test/od03.test.ts`, which admits exactly this path).
 *
 * ── LAW ─────────────────────────────────────────────────────────────────
 *   - one path convention: `${BFF}/<resource>`, NO `/v1` (the proxy adds it);
 *   - every GET is `cache: 'no-store'`: a customer list is read live;
 *   - the DTOs are IMPORTED from the contract and re-exported, never redeclared;
 *   - READ ONLY, and the list only. `GET /customers/:id`, the receivable read and
 *     every write are deliberately not declared: no screen may call them yet, and
 *     a function nothing calls is dead code with a plausible name.
 *
 * Authorization, business scope and language headers are set by `apiFetch`.
 */
import type { CustomerListItemDto, CustomerPageDto } from '@daftar/shared-contracts';
import { apiFetch } from './client';

export type { CustomerListItemDto, CustomerPageDto };

const BFF = '/api/proxy';

/**
 * The query `GET /v1/customers` accepts. The server's schema is `.strict()`, so
 * only these keys are ever sent. The order is the server's `(name, id)`; there
 * is no ordering parameter.
 */
export interface CustomersQuery {
  status?: CustomerListItemDto['status'];
  search?: string;
  cursor?: string;
  /** 1 to 50. */
  limit?: number;
}

/** `?a=1&b=2`, or '' — absent values are omitted. */
function qs(params: Readonly<Record<string, string | number | undefined>>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    q.set(key, String(value));
  }
  const text = q.toString();
  return text.length > 0 ? `?${text}` : '';
}

export const listCustomers = (q: CustomersQuery = {}) => apiFetch<CustomerPageDto>(`${BFF}/customers${qs({ ...q })}`, { cache: 'no-store' });
