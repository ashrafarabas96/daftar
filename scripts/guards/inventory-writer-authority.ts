/**
 * Rule 22 — inventory writer authority (P3-S2, contract §7.2; PM-44 static half, P3-AL-55 §G).
 *
 * Every stock mutation is internal DEFINER code that has VERIFIED an
 * `invctl/1` assertion before it decided anything (P3-AL-55 §G, L:173). A
 * routine owned by `daftar_inventory_internal` runs with the principal's
 * INSERT/UPDATE on the ledger, so a new one that writes a stock table without
 * first consuming or re-reading the verified assertion would be a writer
 * nobody authorized — callable by anyone who is ever granted EXECUTE on it.
 *
 * The rule, per DEFINITION (every `CREATE FUNCTION` of a routine handed to the
 * principal, in every file — the parsing of G-7): if its body INSERTs into,
 * UPDATEs or DELETEs from a stock table, its FIRST statement after `BEGIN`
 * must call `inventory_assertion_consume(` or `inventory_assertion_current(`.
 * "First" is literal: an assertion checked after a read or a lock has already
 * let an unauthorized caller observe or block the ledger.
 *
 * The live half is the PM-44 catalogue sweep over `pg_proc.prosrc`
 * (tests/security, contract §6 T-16); this half fails on a pull request.
 */
import { checkInventoryDefinerContract, inventoryRoutineDefinitions } from './inventory-definer-contract';

/** The stock tables whose writes need a verified assertion, bridges included. */
export const STOCK_WRITE_TABLES =
  /^(stock_movements|stock_levels|stock_source_bindings|negative_inventory_deficits|negative_deficit_coverages|stock_source_bridge_\w+)$/;

const TABLE = '(?:public\\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?';

/** Single-quoted literals out, so a message that names a table is not a write. */
function stripLiterals(body: string): string {
  return body.replace(/'(?:[^']|'')*'/g, "''");
}

/** The stock tables a body writes: `INSERT INTO t`, `UPDATE t` (not `FOR [NO KEY] UPDATE`), `DELETE FROM t`. */
export function stockTablesWritten(body: string): string[] {
  const text = stripLiterals(body);
  const found = new Set<string>();
  const patterns = [
    new RegExp(`\\bINSERT\\s+INTO\\s+${TABLE}`, 'gi'),
    new RegExp(`(?<!\\bFOR\\s+(?:NO\\s+KEY\\s+)?)\\bUPDATE\\s+(?:ONLY\\s+)?${TABLE}`, 'gi'),
    new RegExp(`\\bDELETE\\s+FROM\\s+(?:ONLY\\s+)?${TABLE}`, 'gi'),
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const t = (m[1] ?? '').toLowerCase();
      if (STOCK_WRITE_TABLES.test(t)) found.add(t);
    }
  }
  return [...found].sort();
}

/**
 * The first statement of a routine body: the text after the first `BEGIN` up
 * to its `;` (a `LANGUAGE sql` body has no `BEGIN`, so its first statement
 * is the body's first). Literals are blanked first; comments are already
 * gone.
 */
export function firstStatement(body: string): string {
  const text = stripLiterals(body);
  const begin = /\bBEGIN\b(?!\s+ATOMIC\b)/i.exec(text);
  const from = begin ? begin.index + begin[0].length : 0;
  const end = text.indexOf(';', from);
  return text.slice(from, end < 0 ? text.length : end).trim();
}

const ASSERTION_CALL = /^(?:[A-Za-z_][A-Za-z0-9_.]*\s*:=\s*|SELECT\s+|PERFORM\s+)?(?:public\.)?inventory_assertion_(?:consume|current)\s*\(/i;

export interface InventoryWriterReport {
  readonly violations: string[];
  /** `file: routine` for every definition that writes a stock table — the set the rule is watching. */
  readonly writers: string[];
}

export function checkInventoryWriterAuthority(migrations: Readonly<Record<string, string>>): InventoryWriterReport {
  const transferred = new Set(checkInventoryDefinerContract({ migrations }).transferred);
  const violations: string[] = [];
  const writers: string[] = [];
  for (const d of inventoryRoutineDefinitions(migrations)) {
    if (!transferred.has(d.name) || d.body === null) continue;
    const tables = stockTablesWritten(d.body);
    if (tables.length === 0) continue;
    writers.push(`${d.file}: ${d.name}`);
    const first = firstStatement(d.body);
    if (!ASSERTION_CALL.test(first)) {
      violations.push(
        `${d.file}: ${d.name} writes ${tables.join(', ')} but its first statement is not inventory_assertion_consume( / inventory_assertion_current( — every stock writer verifies invctl/1 before anything else (PM-44, rule 22)`,
      );
    }
  }
  return { violations, writers };
}
