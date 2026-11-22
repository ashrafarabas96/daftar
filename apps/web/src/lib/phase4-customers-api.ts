'use client';
/**
 * Typed client for "New customer" (P4-S1): `POST /v1/customers` and the read
 * that confirms it, `GET /v1/customers/:customerId`. In the idiom of the other
 * `phase4-*` libraries.
 *
 * ── LAW ─────────────────────────────────────────────────────────────────
 *   - one path convention: `${BFF}/<resource>`, NO `/v1` (the proxy adds it);
 *   - every call is `cache: 'no-store'`;
 *   - the response DTOs are IMPORTED from the contract, never redeclared. The
 *     REQUEST is the contract's create request MINUS `contacts`, because the
 *     mounted route validates with `CustomerWriteCreateSchema`, which omits
 *     `contacts` and is `.strict()` (owner decision DR-142): sending the key
 *     is refused, so the type cannot name it;
 *   - the customer id in the BODY is the replay key (P4-AL-30): the API proves
 *     a replay by that id plus the stored `intent_sha256`. No `idempotency-key`
 *     header is sent: the customers module does not read one, and a header
 *     that nothing reads would only suggest a guarantee that does not exist.
 *     Keeping the id across a retry and a reload is
 *     `views/customers/customer-create-flow.ts`'s job.
 *
 * Authorization, business scope and language headers are set by `apiFetch`.
 */
import type { CustomerCommandResultDto, CustomerCreateRequestDto, CustomerDto } from '@daftar/shared-contracts';
import { apiFetch } from './client';

export type { CustomerCommandResultDto, CustomerDto };

const BFF = '/api/proxy';

/** `POST /v1/customers` as the mounted route accepts it: the contract's request without `contacts`. */
export type CreateCustomerRequestDto = Omit<CustomerCreateRequestDto, 'contacts'>;

/** `GET /v1/customers/:customerId` — requires `customers.view`. */
export const getCustomer = (customerId: string) => apiFetch<CustomerDto>(`${BFF}/customers/${encodeURIComponent(customerId)}`, { cache: 'no-store' });

/** `POST /v1/customers` — requires `customers.manage`; 201 first time, 200 with `replayed: true` for the identical re-send. */
export const createCustomer = (body: CreateCustomerRequestDto) =>
  apiFetch<CustomerCommandResultDto>(`${BFF}/customers`, {
    method: 'POST',
    cache: 'no-store',
    body: JSON.stringify(body),
  });
