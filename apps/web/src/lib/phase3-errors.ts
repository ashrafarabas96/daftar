'use client';
/**
 * Refusal → merchant text (P3-S7 contract A-15(d), §3 web-side rules).
 *
 * A screen never renders `ApiError.message` or the code itself (A-15(e)): it
 * renders `t(refusalKey(error))`. The key is `error.<code>`, with the code's
 * dots kept, where the code is the stable domain code the refusal carries
 * (`ApiError.domainCode`) or, when it carries none, the envelope code
 * (`NOT_FOUND`, `VALIDATION_FAILED`, `FORBIDDEN` …). A code the catalog does
 * not know — a defect the merchant can do nothing about — falls back to the
 * glossary's "data safe" error (GL §4), as does a network failure. Every text
 * answers what happened, whether the data is safe and what to do (SIM-13).
 */
import en from '@/messages/en.json';
import { ApiError } from './client';

const CATALOG: Readonly<Record<string, string>> = en;

/** The key a page shows when a command succeeded but reading its result back failed (m-3): "Saved. Refresh the page…". */
export const SAVED_REFRESH_KEY = 'common.savedRefresh';

/** The key a refusal renders under when nothing more specific exists (GL "data safe" error). */
export const FALLBACK_ERROR_KEY = 'error.fallback';

/** The code a refusal is known by: its domain code, else its envelope code; null when it is not an API refusal. */
export function refusalCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  return error.domainCode ?? error.code;
}

/** The catalog key for a refusal, network failure or defect. Always a key that exists. */
export function refusalKey(error: unknown): string {
  const code = refusalCode(error);
  if (code === null) return FALLBACK_ERROR_KEY;
  const key = `error.${code}`;
  return Object.hasOwn(CATALOG, key) ? key : FALLBACK_ERROR_KEY;
}

/**
 * The 409s the S5 and S6 tables mark "retry: yes" (§3(c), Annex R #9): a
 * concurrent command moved what this one was computed against. They are
 * retried once, automatically, with the same document id.
 */
export const RETRYABLE_CONFLICTS: ReadonlySet<string> = new Set([
  'purchase.fx_rate_changed',
  'inventory.valuation_changed',
  'supplier_payment.settlement_changed',
  'supplier_payment.fx_rate_changed',
  'supplier_credit_allocation.settlement_changed',
  'supplier_refund.settlement_changed',
  'supplier_refund.fx_rate_changed',
]);

/** True for a 409 whose code is in `RETRYABLE_CONFLICTS`. */
export function isRetryableConflict(error: unknown): boolean {
  const code = refusalCode(error);
  return error instanceof ApiError && error.status === 409 && code !== null && RETRYABLE_CONFLICTS.has(code);
}

/**
 * Run a command; when it is refused with a retryable 409, run the SAME call
 * once more (the caller's closure carries the same document id, so it is the
 * same command). Any other outcome, and a second refusal, reach the caller.
 */
export async function withConflictRetry<T>(command: () => Promise<T>): Promise<T> {
  try {
    return await command();
  } catch (error) {
    if (!isRetryableConflict(error)) throw error;
    return command();
  }
}

/** A refusal for a missing exchange rate, which A-14 answers with the inline rate entry. */
export function isMissingExchangeRate(error: unknown): boolean {
  const code = refusalCode(error);
  return code === 'purchase.fx_rate_missing' || code === 'accounting.fx_rate_missing';
}

/** A 403 — on a page load it renders the permission state, on an action the mapped text (§3(b)). */
export function isPermissionRefusal(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

/** A 5xx, or no answer at all: the form and its document id are kept, so "Try again" is a replay (§3(d)). */
export function isTransientFailure(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500;
}
