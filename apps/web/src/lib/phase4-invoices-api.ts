'use client';
/**
 * Typed client for the invoice reads of Phase 4 (MVP-02). Written in the idiom
 * of `phase3-api.ts` and `phase4-pos-api.ts`, and a separate file for the same
 * reason they are: it has its own audit.
 *
 * ── LAW (as in the other clients) ────────────────────────────────────────
 *   - one path convention: `${BFF}/<resource>`, NO `/v1` (the proxy adds it);
 *   - money is an integer minor-unit STRING, end to end; this file does NO
 *     arithmetic on it;
 *   - every GET is `cache: 'no-store'`: an invoice is read live;
 *   - the DTOs are IMPORTED from the contract and re-exported, never redeclared,
 *     so a field renamed server-side is a type error here and not a screen
 *     rendering `undefined`.
 *
 * Authorization, business scope, language and idempotency headers are set by
 * `apiFetch` and by nothing here.
 *
 * `getInvoiceSettlement` is a SEPARATE read on purpose: it needs
 * `receivables.view` and business-wide branch scope, so it can be refused
 * while `getInvoice` answers. A caller treats that refusal as "no collection
 * figures", never as a failed screen.
 */
import type { InvoiceDto, InvoiceItemDto, InvoicePageDto, InvoiceSettlementDto, InvoiceSummaryDto } from '@daftar/shared-contracts';
import { apiFetch } from './client';

export type { InvoiceDto, InvoiceItemDto, InvoicePageDto, InvoiceSettlementDto, InvoiceSummaryDto };

const BFF = '/api/proxy';

/**
 * The query `GET /v1/invoices` accepts, as much of it as a screen asks for.
 * The server's schema is `.strict()`, so only these keys are ever sent, and
 * `from`/`to` go together or not at all (`YYYY-MM-DD`).
 */
export interface InvoicesQuery {
  status?: InvoiceSummaryDto['status'];
  documentKind?: InvoiceSummaryDto['documentKind'];
  from?: string;
  to?: string;
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

/** Every read: live, never cached by the browser. */
function read<T>(path: string): Promise<T> {
  return apiFetch<T>(path, { cache: 'no-store' });
}

export const listInvoices = (q: InvoicesQuery = {}) => read<InvoicePageDto>(`${BFF}/invoices${qs({ ...q })}`);

const seg = (id: string): string => encodeURIComponent(id);

export const getInvoice = (invoiceId: string) => read<InvoiceDto>(`${BFF}/invoices/${seg(invoiceId)}`);
export const getInvoiceSettlement = (invoiceId: string) => read<InvoiceSettlementDto>(`${BFF}/invoices/${seg(invoiceId)}/settlement`);
