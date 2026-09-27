/**
 * P3-S8 — "BYTE-IDENTICAL", MEASURED (docs/PHASE_3_S8_CONTRACT.md §5, A-06).
 *
 * A refused command must leave every truth table, the assertion-uses log and
 * the journal exactly as they were. "Exactly" is measured here as an
 * ORDERED-ROW DIGEST per table: every row rendered whole (`to_jsonb(row)`,
 * so a changed column of any type changes the text), the rendered rows sorted,
 * joined and hashed, together with the row count. Two digests are equal only
 * when the two row multisets are equal — an added, removed or rewritten row
 * in any column is named by table.
 *
 * The digest is read by whatever connection the caller passes. A refusal is
 * judged inside the caller's own transaction (before and after, same
 * snapshot rules), so the digest must be taken on THAT connection; reading on
 * another connection would miss an uncommitted write.
 *
 * Nothing here decides which tables matter: the caller passes the set (the
 * catalogue-discovered truth tables of `phase3-surface.ts`, plus the logs).
 */
import type { Queryable } from './stock-ledger';

const IDENT = /^[a-z_][a-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`table-digest: ${JSON.stringify(name)} is not a plain identifier`);
  return name;
}

/** `<rows>:<md5 of the sorted row texts>` per table. */
export type TableDigest = Readonly<Record<string, string>>;

/** The journal and the side-effect logs every "tables identical" row includes besides the truth tables. */
export const JOURNAL_AND_LOGS = [
  'journal_entries',
  'journal_lines',
  'accounting_source_bindings',
  'accounting_reversals',
  'accounting_assertion_uses',
  'inventory_assertion_uses',
  'audit_events',
  'outbox_events',
] as const;

/**
 * The ordered-row digest of every table in `tables`, read on `q`. Optionally
 * restricted to one business (`business_id = $1`) for tables that carry the
 * column; a table that does not is digested whole.
 */
export async function tableDigest(q: Queryable, tables: readonly string[], o: { readonly businessId?: string } = {}): Promise<TableDigest> {
  const names = [...new Set(tables)].map(ident).sort();
  if (names.length === 0) return {};
  const withBusiness = new Set<string>();
  if (o.businessId !== undefined) {
    const r = await q.query<{ t: string }>(
      `SELECT c.relname::text AS t FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY ($1::text[]) AND a.attname = 'business_id' AND NOT a.attisdropped`,
      [names],
    );
    for (const x of r.rows) withBusiness.add(x.t);
  }
  const parts = names.map((t) => {
    const where = withBusiness.has(t) ? ` WHERE x.business_id = $1` : '';
    return `SELECT '${t}' AS t, count(*)::text || ':' || md5(coalesce(string_agg(to_jsonb(x)::text, E'\\n' ORDER BY to_jsonb(x)::text), '')) AS d FROM public.${t} x${where}`;
  });
  const params = o.businessId !== undefined && withBusiness.size > 0 ? [o.businessId] : [];
  const r = await q.query<{ t: string; d: string }>(parts.join(' UNION ALL '), params);
  const out: Record<string, string> = {};
  for (const x of r.rows) out[x.t] = x.d;
  return out;
}

/** The tables whose digests differ between `before` and `after` (either side missing counts as different). */
export function changedTables(before: TableDigest, after: TableDigest): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => before[k] !== after[k]).sort();
}

/** Rows per table, parsed from a digest (for "exactly N rows were added" assertions). */
export function rowCounts(d: TableDigest): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [t, v] of Object.entries(d)) out[t] = Number(v.slice(0, v.indexOf(':')));
  return out;
}
