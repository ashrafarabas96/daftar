import type { LocaleCode } from '@daftar/shared-contracts';

/**
 * Phase 3 corrective — TD-20: the names the SYSTEM gives a default warehouse,
 * in the business's locale.
 *
 * - The onboarding default (one per business, on its default branch) is named
 *   by `provision_create_business` (migration 0073) — `MAIN_WAREHOUSE_NAMES`
 *   is its table, repeated here for the reads and tests that name it.
 * - Each further branch's default is named here, by createBranch():
 *   `<branch> — <suffix>`.
 *
 * `warehouses.name` holds at most 120 characters AS THE SERVER COUNTS THEM
 * (`char_length`): code points on a UTF8 server, bytes on a byte-oriented one
 * (DAFTAR does not require a UTF8 server encoding — 0049). A branch name is
 * itself at most 120, so `<branch> — <suffix>` can exceed the column; the
 * branch part is then cut at a code point (never inside one) to the longest
 * prefix that fits, its trailing spaces dropped, and the suffix kept whole.
 */
export const MAIN_WAREHOUSE_NAMES: Readonly<Record<LocaleCode, string>> = Object.freeze({
  ar: 'المستودع الرئيسي',
  en: 'Main warehouse',
  tr: 'Ana depo',
});

export const BRANCH_DEFAULT_WAREHOUSE_SUFFIXES: Readonly<Record<LocaleCode, string>> = Object.freeze({
  ar: 'المستودع الافتراضي',
  en: 'default warehouse',
  tr: 'varsayılan depo',
});

/** The column's bound, `warehouses_name_check`. */
export const WAREHOUSE_NAME_MAX = 120;

const SEPARATOR = ' — ';

/** How the server's `char_length` counts a text, from its `server_encoding`. */
export function serverLengthOf(serverEncoding: string): (text: string) => number {
  return serverEncoding.toUpperCase() === 'UTF8' ? (text) => [...text].length : (text) => Buffer.byteLength(text, 'utf8');
}

/** The default warehouse name of a new branch named `branchName`, in `locale`, fitting the column as `lengthOf` counts it. */
export function branchDefaultWarehouseName(locale: LocaleCode, branchName: string, lengthOf: (text: string) => number): string {
  const tail = `${SEPARATOR}${BRANCH_DEFAULT_WAREHOUSE_SUFFIXES[locale]}`;
  const full = `${branchName}${tail}`;
  if (lengthOf(full) <= WAREHOUSE_NAME_MAX) return full;
  const points = [...branchName];
  let keep = points.length;
  while (keep > 0 && lengthOf(points.slice(0, keep).join('') + tail) > WAREHOUSE_NAME_MAX) keep -= 1;
  const head = points.slice(0, keep).join('').trimEnd();
  if (head.length === 0) throw new Error('a default warehouse name cannot keep any of its branch name');
  return `${head}${tail}`;
}
