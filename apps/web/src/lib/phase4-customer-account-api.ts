'use client';
/**
 * Typed client for the customer ACCOUNT screen (MVP-02): what one customer owes,
 * in the idiom of `phase4-invoices-api.ts`. Five merged reads, nothing else:
 *
 *   - `GET /v1/customers/:id` — the name (`customers.view`);
 *   - `GET /v1/customers/:id/receivable` — the balance, per currency and in the
 *     base currency (`receivables.view`, business-wide);
 *   - `GET /v1/customers/:id/receivable/aging` — the same money by age, at a
 *     SUPPLIED as-of date and the SUPPLIED boundaries (both required; the
 *     server invents neither);
 *   - `GET /v1/customers/:id/open-invoices` — oldest first, keyset-paged;
 *   - `GET /v1/customers/:id/credits` — the amounts held for the customer
 *     (`receivables.view`, business-wide; newest first, at most 200, no cursor).
 *
 * ── LAW ─────────────────────────────────────────────────────────────────
 *   - one path convention: `${BFF}/<resource>`, NO `/v1` (the proxy adds it);
 *   - every GET is `cache: 'no-store'`: money is read live;
 *   - the DTOs are IMPORTED from the contract and re-exported, never redeclared;
 *   - READ ONLY. The customer writes are another lane's unmerged PR, and
 *     collecting a payment is the next screen.
 *
 * Authorization, business scope and language headers are set by `apiFetch`.
 */
import type {
  CustomerAgingDto,
  CustomerCreditDto,
  CustomerDto,
  CustomerOpenInvoiceDto,
  CustomerOpenInvoicesDto,
  CustomerReceivableDto,
} from '@daftar/shared-contracts';
import { apiFetch } from './client';

export type { CustomerAgingDto, CustomerCreditDto, CustomerDto, CustomerOpenInvoiceDto, CustomerOpenInvoicesDto, CustomerReceivableDto };

const BFF = '/api/proxy';

/**
 * The aging boundaries this release offers, and the only ones the server
 * accepts (DR-14; `selling.schemas.ts` refuses any other set). Sent as the
 * server spells them.
 */
export const ACCOUNT_AGING_BUCKET_DAYS = '0,30,60,90';

/**
 * The server's band tokens for that set (`agingBucketLabels([0, 30, 60, 90])`
 * in `@daftar/domain-core`), in the server's order, each with the catalogue
 * sentence the merchant reads. The day numbers in a sentence are the band's own
 * `fromDays` / `toDays`, as the server states them — the screen spells no
 * boundary of its own. A token outside this table is an answer the screen
 * cannot place, and the page refuses it as a failed load rather than showing
 * it under a guess.
 */
export const AGE_BAND_KEYS: Readonly<Record<string, string>> = {
  // The first band holds every row up to and including its due date, "due today" among them,
  // so it is worded "not late": "not due" would contradict a row in it.
  'not-due': 'customers.account.age.notLate',
  '1-30': 'customers.account.age.band',
  '31-60': 'customers.account.age.band',
  '61-90': 'customers.account.age.band',
  'over-90': 'customers.account.age.over',
};

/** The most rows `GET /v1/customers/:id/credits` ever returns (`LIMIT 200`, no cursor). */
export const CREDITS_READ_CAP = 200;

/** The query `GET /v1/customers/:id/open-invoices` accepts (`.strict()` on the server). */
export interface OpenInvoicesQuery {
  /** `YYYY-MM-DD`, required. */
  asOf: string;
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

export const getCustomer = (id: string) => apiFetch<CustomerDto>(`${BFF}/customers/${encodeURIComponent(id)}`, { cache: 'no-store' });

export const getCustomerReceivable = (id: string) =>
  apiFetch<CustomerReceivableDto>(`${BFF}/customers/${encodeURIComponent(id)}/receivable`, { cache: 'no-store' });

export const getCustomerAging = (id: string, asOf: string) =>
  apiFetch<CustomerAgingDto>(`${BFF}/customers/${encodeURIComponent(id)}/receivable/aging${qs({ asOf, bucketDays: ACCOUNT_AGING_BUCKET_DAYS })}`, {
    cache: 'no-store',
  });

export const listCustomerOpenInvoices = (id: string, q: OpenInvoicesQuery) =>
  apiFetch<CustomerOpenInvoicesDto>(`${BFF}/customers/${encodeURIComponent(id)}/open-invoices${qs({ ...q })}`, { cache: 'no-store' });

export const listCustomerCredits = (id: string) =>
  apiFetch<readonly CustomerCreditDto[]>(`${BFF}/customers/${encodeURIComponent(id)}/credits`, { cache: 'no-store' });
