/**
 * The refusal codes a P3-S7 screen can meet, enumerated FROM THE API CODE —
 * never from a document (Annex R #10). The API modules cannot be imported
 * into the web runner (they pull in the database driver and Nest), so each
 * explicit table is read from its source text: the object literal's keys, the
 * set's members, the `inventoryRefusal('…')` literals. A table that cannot be
 * found, or reads empty, throws — an enumeration that silently finds nothing
 * would let every code go unkeyed.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const API = join(REPO_ROOT, 'apps', 'api', 'src');

const read = (...path: string[]): string => readFileSync(join(API, ...path), 'utf8');

/** The quoted `domain.code` strings between `start` and `end` in `source`. */
function codesBetween(source: string, start: string, end: string, what: string): string[] {
  const from = source.indexOf(start);
  const to = from < 0 ? -1 : source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`${what}: could not find "${start}" … "${end}" in the API source`);
  const codes = [...source.slice(from, to).matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1] ?? '');
  if (codes.length === 0) throw new Error(`${what}: the table reads empty`);
  return [...new Set(codes)].sort();
}

/** Every key of `PURCHASING_STATUS` (S4, S5 and S6 §3). */
export function purchasingCodes(): string[] {
  return codesBetween(read('modules', 'purchasing', 'purchasing-errors.ts'), 'const PURCHASING_STATUS = {', '} as const satisfies', 'PURCHASING_STATUS');
}

/** Every key of `PAYMENT_METHOD_STATUS` (S6 §3). */
export function paymentMethodCodes(): string[] {
  return codesBetween(
    read('modules', 'payment-methods', 'payment-method-errors.ts'),
    'const PAYMENT_METHOD_STATUS = {',
    '} as const satisfies',
    'PAYMENT_METHOD_STATUS',
  );
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * The inventory vocabulary a purchasing or stock path can meet: the S4 table
 * and the accepted P3-S3 set (`purchasing-errors.ts`), plus every
 * `inventoryRefusal('…')` literal the API raises — which brings the
 * `structure.*` association codes that travel in `details.inventoryCode`.
 */
export function inventoryCodes(): string[] {
  const source = read('modules', 'purchasing', 'purchasing-errors.ts');
  const s4 = codesBetween(source, 'const S4_INVENTORY_STATUS', '};', 'S4_INVENTORY_STATUS');
  const s3 = codesBetween(source, 'const S3_MAPPED_INVENTORY_CODES', ']);', 'S3_MAPPED_INVENTORY_CODES');
  const literals = walk(API).flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/\binventoryRefusal\(\s*'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1] ?? ''));
  if (literals.length === 0) throw new Error('no inventoryRefusal literal found in apps/api/src');
  return [...new Set([...s4, ...s3, ...literals])].sort();
}

/**
 * The `accounting.*` codes a merchant screen can meet under
 * `ACCOUNTING_REFUSED` (their `details.code`): the exchange-rate entry (A-14),
 * a closed or future date, the payment setup of a method, scope and replay.
 * Each is checked to exist in `@daftar/accounting`'s `AccountingErrorCode`.
 */
export const MERCHANT_ACCOUNTING_CODES: readonly string[] = [
  'accounting.fx_rate_missing',
  'accounting.fx_rate_invalid',
  'accounting.fx_rate_conflict',
  'accounting.fx_same_currency',
  'accounting.fx_currency_unknown',
  'accounting.period_closed',
  'accounting.period_not_open',
  'accounting.period_missing_for_date',
  'accounting.entry_date_in_future',
  'accounting.system_account_missing',
  'accounting.account_inactive',
  'accounting.account_not_found',
  'accounting.forbidden',
  'accounting.branch_scope_violation',
  'accounting.idempotency_conflict',
];

/** Every `AccountingErrorCode` literal of the accounting package. */
export function accountingCodes(): string[] {
  const source = readFileSync(join(REPO_ROOT, 'packages', 'accounting', 'src', 'errors.ts'), 'utf8');
  return codesBetween(source, 'export type AccountingErrorCode', ';\n', 'AccountingErrorCode');
}

/** The envelope codes a refusal without a domain code carries (`domainCode ?? code`; Annex R #11). */
export const ENVELOPE_CODES: readonly string[] = [
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'FORBIDDEN',
  'CONFLICT',
  'INTERNAL_ERROR',
  'UNAUTHENTICATED',
  'RATE_LIMITED',
  'ACCOUNTING_REFUSED',
];

/**
 * Codes deliberately WITHOUT a key: the web never sends a tax element, so a
 * tax refusal cannot be provoked from an S7 screen, and a tax word may not
 * enter the S7 namespaces (BLOCKED BY OD-03, A-19, T-12). It renders the
 * data-safe fallback if it is ever met.
 */
export const OD03_UNKEYED: readonly string[] = ['purchase.tax_policy_absent'];
