/**
 * Guard G-6 (P2-S7 §61) — THE REPORTING SURFACE IS READ-ONLY, AND READS THE
 * JOURNAL.
 *
 * G-4 already refuses journal DML anywhere in the application. This guard is
 * narrower and stricter, and it exists because the reporting modules are the
 * one place where each of the following would look reasonable to a hurried
 * author, pass every existing check, and be wrong:
 *
 *   — a write, of any kind, on any accounting table. A GET that repairs a
 *     row, stamps a "last viewed" column, or lazily backfills a total is a
 *     mutation a reader did not ask for and cannot audit (§39, §54).
 *
 *   — `OFFSET`. It reads and discards the rows it skips, so page N costs N
 *     pages, and a row inserted during the walk shifts every later page —
 *     which in a ledger means a line the merchant never sees (§28).
 *
 *   — a CURRENT exchange-rate lookup. A rate entered today applied to a
 *     posting from March is a report rewriting history; the rate is frozen
 *     on the line and that is the only rate a report may render (§30, §52).
 *
 *   — `accounts.is_active` in a historical filter. `is_active` governs
 *     whether an account may take a NEW posting. A report that filtered on
 *     it would delete a closed shop's history from the books (§33).
 *
 *   — `Number(`, `parseInt(`, `parseFloat(`. A cumulative total exceeds
 *     2^53 long before it exceeds what a merchant can earn, and a double
 *     rounds it silently (§41).
 *
 * The rule is scoped to the modules that ARE the reporting surface, found by
 * path, because each of these is legitimate elsewhere: a catalog list may
 * use OFFSET, the FX module exists to look up current rates, and the chart
 * editor must filter on `is_active` precisely because it decides what may be
 * posted to next.
 *
 * P3-S7 (contract §7.2(b), coordinator ruling on G-6): the surface is widened
 * to the two merchant read modules — `inventory-reads.ts` (live stock,
 * stocktakes, items) and `supplier-balance-reads.ts` (supplier AP, balance in
 * the merchant's favour, open purchases and the payable SQL builder). Each
 * rule's reason gains its stock and supplier counterpart, and one rule is
 * added: no module-level result cache. `purchasing-reads.ts` is NOT on the
 * surface: it holds S6's command-side FX binding (`readSettlementFx`), which
 * must look the current rate up.
 */

/** Anything matching this is a reporting module and is held to the rules below. The accounting alternatives are unchanged since P2-S7. */
export const READ_SURFACE =
  /(accounting-reports\.|accounting[/\\]reports\.|packages[/\\]accounting[/\\]src[/\\]reports\.ts$|inventory[/\\]inventory-reads\.ts$|purchasing[/\\]supplier-balance-reads\.ts$)/;

/** Every table inside the accounting perimeter that a report must not write. */
export const ACCOUNTING_TABLES = [
  'accounts',
  'journal_entries',
  'journal_lines',
  'accounting_source_bindings',
  'accounting_manual_adjustments',
  'accounting_reversals',
  'accounting_opening_balances',
  'accounting_opening_balance_lines',
  'accounting_periods',
  'accounting_fx_rates',
] as const;

/**
 * Every stock and supplier table a merchant read (P3-S7) must not write: the
 * stock ledger and its cache, the movement and purchase documents, and the
 * settlement records. A GET that "repairs" `stock_levels` or stamps a
 * purchase is a mutation nobody asked for.
 */
export const MERCHANT_READ_TABLES = [
  'stock_levels',
  'stock_movements',
  'stock_deficits',
  'stocktakes',
  'stocktake_lines',
  'suppliers',
  'purchases',
  'purchase_lines',
  'purchase_landed_costs',
  'supplier_returns',
  'supplier_return_lines',
  'supplier_credit_notes',
  'purchase_reversals',
  'supplier_payments',
  'supplier_payment_allocations',
  'supplier_credit_allocations',
  'supplier_refunds',
  'payment_methods',
] as const;

/**
 * A module-level result cache (P3-S7 T-02): a top-level `Map`/`Set`/
 * `WeakMap`/`WeakSet`, an import of `redis`, `ioredis` or `lru-cache`, or a
 * memoize decorator or helper. Exported so T-02 applies the very same pattern.
 */
export const MODULE_CACHE =
  /^(?:export\s+)?(?:const|let|var)\s+\w+(?:\s*:[^=\n]+)?\s*=\s*new\s+(?:Map|Set|WeakMap|WeakSet)\b|\bfrom\s+['"](?:redis|ioredis|lru-cache)['"]|\brequire\(\s*['"](?:redis|ioredis|lru-cache)['"]\s*\)|@Memoize\b|\bmemoize\s*\(/m;

export interface ReadSurfaceRule {
  readonly name: string;
  readonly why: string;
  readonly offends: (source: string) => string | null;
}

/**
 * Strip the comments, so a rule quoting the thing it forbids does not trip
 * itself. Only whole-line `//` and block comments are removed, so nothing
 * inside a string literal is touched.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Drop every `SELECT … FROM` projection, so what is left is predicates,
 * joins and ordering.
 */
function withoutProjections(sql: string): string {
  return sql.replace(/\bSELECT\b[\s\S]*?\bFROM\b/gi, ' FROM ');
}

/**
 * Every template literal in the module that reads the journal — that is,
 * every piece of SQL about what already happened.
 *
 * The scan sees the SQL a module writes, not the SQL it assembles at run
 * time from a condition array, so this rule is the first line and not the
 * only one: the behavioural proof that a deactivated account keeps its
 * history lives in tests/integration/accounting-reports.test.ts and runs
 * against a real ledger.
 */
function historicalSql(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/`([^`]*)`/g)) {
    const text = m[1] ?? '';
    // P3-S7: the stock ledger and the supplier settlement records are history too.
    if (
      /\b(journal_(entries|lines)|stock_movements|purchase_ap_outstanding|supplier_credit_notes|supplier_payment_allocations|supplier_credit_allocations)\b/i.test(
        text,
      )
    )
      out.push(text);
  }
  return out;
}

const first = (source: string, re: RegExp): string | null => re.exec(source)?.[0]?.replace(/\s+/g, ' ').trim() ?? null;

export const READ_SURFACE_RULES: readonly ReadSurfaceRule[] = [
  {
    name: 'no write to an accounting table',
    why: 'a GET that writes is a mutation the merchant did not ask for and cannot audit (§39, §54); the same holds for a stock or supplier read that repairs stock_levels or stamps a purchase (P3-S7 A-03)',
    offends: (source) =>
      first(
        source,
        new RegExp(
          `\\b(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|TRUNCATE(?:\\s+TABLE)?)\\s+(?:public\\.)?(${[...ACCOUNTING_TABLES, ...MERCHANT_READ_TABLES].join('|')})\\b`,
          'i',
        ),
      ),
  },
  {
    name: 'no OFFSET pagination',
    why: 'OFFSET reads and discards what it skips, and a row appended mid-walk shifts every later page — in a ledger that is a line nobody sees (§28); in a stock or supplier list it is an item or a supplier nobody sees (P3-S7 §2(3))',
    offends: (source) => first(source, /\bOFFSET\s+[$\d]/i),
  },
  {
    name: 'no current exchange-rate lookup',
    why: "the rate is frozen on the line; looking one up now would let a rate entered today rewrite a posting from March (§30, §52); a supplier balance is read in each purchase currency, never re-converted at today's rate (P3-S7 §2(3))",
    offends: (source) => first(source, /accounting_fx_rate_lookup\s*\(/i),
  },
  {
    name: 'no historical filter on accounts.is_active',
    why: '`is_active` decides what may be posted to NEXT; filtering history on it deletes a closed shop from the books (§33), and a closed payment method or an inactive supplier from what is still owed (P3-S7 §2(3))',
    // Scoped to HISTORICAL sql — a query that reads the journal. The chart
    // list legitimately filters on `is_active`, because a caller asking
    // "what may I post to" is asking exactly that question; a query that
    // touches `journal_lines` is asking what happened, and what happened
    // does not change when a shop closes.
    offends: (source) => {
      for (const sql of historicalSql(source)) {
        // The projection is not a filter: `SELECT a.is_active` is how the
        // report TELLS the merchant the account is closed, which is the
        // opposite of hiding its history.
        const hit = first(withoutProjections(sql), /\bis_active\b/i);
        if (hit !== null) return hit;
      }
      return null;
    },
  },
  {
    name: 'no floating-point parse of an amount',
    why: 'a cumulative total passes 2^53 long before it passes what a merchant can earn, and a double rounds it in silence (§41); a four-decimal quantity loses its last digit the same way (P3-S7 §2(3))',
    // Keyed on what is being parsed, not on the function. A page size and a
    // line number are small bounded integers and `number` is the right type
    // for them; money is not, ever.
    offends: (source) =>
      first(source, /\b(?:Number|parseInt|parseFloat)\s*\(\s*[^),]*(?:minor|amount|debit|credit|balance|total|net|sum|rate|qty|quantity|on_?hand)[^),]*[),]/i),
  },
  {
    name: 'no persisted or materialized balance source',
    why: 'AL-15: every figure is aggregated from the journal at the moment it is asked for; a stored one is a second truth that can drift (§11). Stock is read from stock_levels, the one named cache, and supplier figures from the ledger and purchase_ap_outstanding at request time (P3-S7 A-03)',
    offends: (source) =>
      first(
        source,
        /\b(accounting_balances|account_balances|running_balances|trial_balance_cache|ledger_cache|balance_snapshots|stock_snapshots|stock_level_snapshots|supplier_balance_cache|supplier_balance_snapshots|CREATE\s+MATERIALIZED\s+VIEW)\b/i,
      ),
  },
  {
    name: 'no module-level result cache',
    why: 'a Map, Set or LRU held by the module, or a redis/memoize layer, answers the next request from a copy that a commit has already made stale (P3-S7 A-03(4), T-02)',
    offends: (source) => first(source, MODULE_CACHE),
  },
];

export interface ReadSurfaceViolation {
  readonly file: string;
  readonly rule: string;
  readonly evidence: string;
  readonly why: string;
}

/**
 * Check the reporting modules among `files` (path → contents).
 *
 * Returns one violation per broken rule per file. An empty array is a pass;
 * so is a set of files containing no reporting module, which is why the
 * caller also asserts that the surface exists — a guard watching nothing is
 * decorative.
 */
export function findReadSurfaceViolations(files: Readonly<Record<string, string>>): ReadSurfaceViolation[] {
  const out: ReadSurfaceViolation[] = [];
  for (const [file, source] of Object.entries(files)) {
    if (!READ_SURFACE.test(file)) continue;
    const code = stripComments(source);
    for (const rule of READ_SURFACE_RULES) {
      const evidence = rule.offends(code);
      if (evidence !== null) out.push({ file, rule: rule.name, evidence, why: rule.why });
    }
  }
  return out;
}

/** The reporting modules found in `files`, so the caller can prove it found some. */
export function readSurfaceFiles(files: Readonly<Record<string, string>>): string[] {
  return Object.keys(files)
    .filter((f) => READ_SURFACE.test(f))
    .sort();
}
