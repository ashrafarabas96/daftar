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

import { SOURCE_DOCUMENT_TABLES } from './no-authoritative-balance';

/**
 * ── P4-S1: the surface is a RULE over module shape, not a list of modules ──
 *
 * The regex named five things: `accounting-reports.*`, `accounting/reports.*`,
 * `packages/accounting/src/reports.ts`, `inventory/inventory-reads.ts` and
 * `purchasing/supplier-balance-reads.ts`. Two of those five spell out the
 * DIRECTORY the module lives in, so a merchant read module in a directory the
 * regex never heard of was simply not examined — and `selling/customer-reads.ts`
 * and `selling/invoice-reads.ts` are exactly that. An `OFFSET`, a current FX
 * lookup or a `Number(amount)` in either of them would have shipped green,
 * which is the same shape of hole G-3's balance rule had (P4-AL-06: "a rule
 * keyed on a name protects a name").
 *
 * So the merchant half is now a rule about what the file IS: a read module of
 * an API bounded context — `apps/api/src/modules/<context>/<name>-reads.ts`.
 * The context's name is not in the pattern, so renaming `selling/` to `sales/`,
 * `pos/` or `receivables/` changes nothing, and a Phase 5 context is covered
 * the day it is written.
 *
 * Why `<name>-reads.ts` and not "anything in a read module's directory": the
 * suffix is the repository's own convention for "this file answers queries",
 * and the `\.ts$` anchor is what keeps `inventory-reads.controller.ts` (a
 * transport) and `inventory-movements.service.ts` (a command) off the surface,
 * exactly as P3-S7 decided. The accounting alternatives are unchanged since
 * P2-S7, including `packages/accounting/src/reports.ts`, which is the one read
 * module outside the API.
 *
 * `purchasing-reads.ts` stays out through `READ_SURFACE_EXEMPT` below, because
 * that is an exemption and not a scope.
 */

/**
 * The named exemptions, with the reason each one is not a report.
 * `purchasing-reads.ts`: S6's command-side FX binding (`readSettlementFx`)
 * lives there and must look the current rate up (P3-S7, coordinator ruling on
 * G-6). An exemption has to be written down HERE, in the guard, with its
 * reason — which is the opposite of a module escaping because nobody listed it.
 */
export const READ_SURFACE_EXEMPT: readonly string[] = ['purchasing-reads.ts'];

/** Anything matching this is a reporting module and is held to the rules below. */
export const READ_SURFACE = new RegExp(
  // not one of the named exemptions…
  `^(?![\\s\\S]*[/\\\\](?:${READ_SURFACE_EXEMPT.map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$)` +
    '(?:' +
    // …and either an accounting reporting module (unchanged since P2-S7)…
    '[\\s\\S]*(?:accounting-reports\\.|accounting[/\\\\]reports\\.)' +
    '|[\\s\\S]*packages[/\\\\]accounting[/\\\\]src[/\\\\]reports\\.ts$' +
    // …or a read module of an API bounded context, whatever the context is called.
    '|apps[/\\\\]api[/\\\\]src[/\\\\]modules[/\\\\][^/\\\\]+[/\\\\][\\w.-]*-reads\\.ts$' +
    ')',
);

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
  // P4-S1: the Phase 4 read tables. A GET that stamps an invoice or backfills a
  // customer is the same mutation nobody asked for (P4-AL-06, P4-AL-46: a
  // commercial mistake is corrected by a NEW document, never by editing a row).
  'customers',
  'customer_contacts',
  'invoices',
  'invoice_items',
  'invoice_sequences',
] as const;

/**
 * ── P4-S1: the write rule is DML, not a table list ───────────────────────
 *
 * The two arrays above are the perimeter this guard can NAME, and naming it is
 * what lets the failure message say which perimeter was crossed. But a read
 * module has no business writing ANY relation, so the rule below also refuses
 * the statement shape itself, whatever the relation is called. A Phase 5
 * `UPDATE quotes SET …` inside a read module is refused the day it is written,
 * without the array having to grow first.
 *
 * `UPDATE` is matched only in its statement shape — a target and then `SET` —
 * so `SELECT … FOR UPDATE`, `FOR NO KEY UPDATE` and `FOR UPDATE OF t` are not
 * mistaken for it. `SELECT … INTO` is deliberately left out: it is vanishingly
 * rare in this codebase and a lookalike would be a false positive, and the
 * materialized-view rule below already catches the shape that matters.
 */
const ANY_DML =
  /\b(?:INSERT\s+INTO|MERGE\s+INTO|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(?:public\s*\.\s*)?("[^"]+"|[A-Za-z_][\w$]*)|\bUPDATE\s+(?:ONLY\s+)?(?:public\s*\.\s*)?("[^"]+"|[A-Za-z_][\w$]*)\s+SET\b/i;

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
/**
 * What makes a query HISTORICAL: it reads a relation that records something
 * that already happened.
 *
 * P3-S7 named six relations. P4-S1 makes it a shape as well as a set, for the
 * reason §33 gives: an `is_active` filter over history deletes a closed shop
 * from the books, and it would equally delete a **deactivated customer's debt
 * from what is owed** — the same defect, one phase later, on a relation the
 * old set had never heard of.
 *
 * So: any relation whose name ends in the document grammar this repository
 * uses for things that happened (`*_movements`, `*_allocations`, `*_lines`,
 * `*_entries`, `*_items`), any `journal_*`, the derived-figure functions the
 * product reads through (P4-AL-07), and the sales documents themselves. The
 * grammar is what carries a Phase 5 relation; the named ones are the two
 * functions and the documents whose names do not end in it.
 *
 * Measured over the shipped surface: the widening takes the accounting reader
 * from 9 historical literals to 11 and `inventory-reads.ts` from 1 to 4, and
 * the number of `is_active` predicates found stays 0 — before and after.
 */
const HISTORICAL_RELATION =
  /\b(?:\w*_(?:movements|allocations|lines|entries|items)|journal_\w+|purchase_ap_outstanding|supplier_credit_notes|customer_ar_outstanding|invoice_outstanding|invoice_settlement_state|invoices?|sales?|payments?|credit_notes|customer_credits|installments|stocktakes)\b/i;

function historicalSql(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/`([^`]*)`/g)) {
    const text = m[1] ?? '';
    if (HISTORICAL_RELATION.test(text)) out.push(text);
  }
  return out;
}

const first = (source: string, re: RegExp): string | null => re.exec(source)?.[0]?.replace(/\s+/g, ' ').trim() ?? null;

/**
 * ── P4-S1: a persisted balance source, in the RELATION position ──────────
 *
 * Two halves, and the difference between them is the whole lesson.
 *
 * `NAMED_BALANCE_STORE` is the P2-S7/P3-S7 list of exact relation names, plus
 * `CREATE MATERIALIZED VIEW`. It is matched anywhere in the module, exactly as
 * it always was, because none of those names has a legitimate use as anything
 * else — so its reach is unchanged and no accepted verdict moves.
 *
 * `DERIVED_TOTAL_RELATION` is the new grammar — `*_balances`, `*_snapshots`,
 * `*_rollups`, `*_summary`, `*_caches`, `*_projections`, `*_outstanding`,
 * `*_payables`, `*_receivables` — and it is matched ONLY where SQL puts a
 * relation: after `FROM`, `JOIN`, `UPDATE`, `INTO` or `USING`.
 *
 * That anchor is a correction, and it is the stronger fix rather than the
 * cheaper one. The grammar is a RELATION-name grammar, and testing it against
 * every identifier in the text meant it also tested COLUMN identifiers:
 * `invoices.customer_phone_snapshot` — a contact label frozen on the document
 * at issue, read in a select list and never in a `FROM` — failed G-6 on the
 * merged tree. Exempting `*_phone_snapshot` would have rebuilt the
 * list-shaped hole this slice exists to remove, because the next label column
 * (`customer_address_snapshot`, and whatever a later slice needs) reopens it.
 * Anchoring on the relation position removes the whole class at once and
 * exempts nothing.
 *
 * There is deliberately NO column-level half here. A rule about the word
 * `snapshot` in a column name is a rule about vocabulary; what AL-15 forbids is
 * reading a figure out of a stored total, and a stored total is a relation.
 * G-3 is what refuses the stored money COLUMN, at the schema, where it is
 * declared — the only place that can prove it.
 *
 * One exemption survives the anchor, and it is reachable: a report may read
 * `accounting_opening_balances` in a `FROM`, because that is an AL-13 SOURCE
 * DOCUMENT recording what the merchant declared their position to be on a date
 * — an input to the journal that nothing recomputes. It is not restated here;
 * it is `SOURCE_DOCUMENT_TABLES`, imported from G-3, so the two guards cannot
 * come to disagree about which relations are documents.
 *
 * The `*_name_snapshot` and `opening_balances` carve-outs that stood here
 * before the anchor existed are DELETED. With the anchor they are unreachable —
 * no relation is called `*_name_snapshot` — and a dead exemption is worse than
 * none, because a later reader takes it for a licence.
 */
const NAMED_BALANCE_STORE =
  /\b(?:accounting_balances|account_balances|running_balances|trial_balance_cache|ledger_cache|balance_snapshots|stock_snapshots|stock_level_snapshots|supplier_balance_cache|supplier_balance_snapshots)\b|CREATE\s+MATERIALIZED\s+VIEW/i;

/** G-3's `DERIVED_TOTAL_TABLE`, in read-surface form: a relation that IS a stored total. */
const DERIVED_TOTAL_RELATION = /(^|_)(balances?|snapshots?|rollups?|summar(y|ies)|caches?|projections?|outstanding|payables?|receivables?)($|_)/i;

/**
 * Every identifier SQL puts in a RELATION position: after `FROM`, `JOIN`,
 * `UPDATE`, `INTO` or `USING`, bare or schema-qualified.
 *
 * An identifier followed by `(` is a FUNCTION CALL, not a relation, and it is
 * not captured. That is not a loophole, it is P4-AL-07: a derived value is read
 * through the product's own function, and the same function is what the
 * reconciler and the gate use. `FROM customer_ar_outstanding($1, $2)`,
 * `invoice_outstanding(…)` and `purchase_ap_outstanding(…)` are the CORRECT way
 * to read AR and AP — they aggregate the journal at the moment they are asked —
 * and a rule that refused them would be refusing the very decision it exists to
 * enforce. A stored total is a table; a function is the aggregation.
 *
 * `JOIN t USING (id)` names columns rather than a relation, and the parenthesis
 * is why that is not matched either.
 *
 * The paren check applies to the READ position only. `INSERT INTO t (cols)` is
 * a relation followed by a COLUMN LIST, so applying it there would have exempted
 * `INSERT INTO receivables_rollup (id) VALUES ($1)` — measured, not guessed —
 * which is why `INTO` and `UPDATE` are a separate alternative with no paren
 * check. `UPDATE t SET` never carries one.
 *
 * `(?![\w$])` after each identifier is load-bearing, not decoration. Without it
 * the greedy identifier BACKTRACKS to satisfy the paren lookahead:
 * `FROM customer_ar_outstanding($1)` yielded the relation
 * `customer_ar_outstandin`, one character short — a name that matches nothing,
 * which would have made the rule silently unreliable on every function call.
 * With it, the match takes the whole name or fails.
 */
const QUALIFIER = String.raw`(?:(?:"[^"]+"|[A-Za-z_][\w$]*)\s*\.\s*)?`;
const IDENT = String.raw`("[^"]+"|[A-Za-z_][\w$]*)(?![\w$])`;
const RELATION_POSITION = new RegExp(
  // read position: an identifier followed by `(` is a function call, not a relation
  String.raw`\b(?:FROM|JOIN|USING)\s+(?:ONLY\s+)?${QUALIFIER}${IDENT}(?!\s*\()` +
    // write position: `INSERT INTO t (cols)` and `UPDATE t SET` — a following `(` is a column list
    String.raw`|\b(?:INTO|UPDATE)\s+(?:ONLY\s+)?${QUALIFIER}${IDENT}`,
  'gi',
);

/**
 * Every name the SQL declares as a COMMON TABLE EXPRESSION.
 *
 * A CTE is not a stored relation: it is computed inside the statement, from
 * whatever the statement reads, at the moment the statement runs — which is the
 * opposite of the thing AL-15 forbids. `accounting-reconciliation.reader.ts`
 * already has `), cache AS ( … ) … FROM cache k` (`:549-555`), a pure function
 * of the ledger by PM-01, and the relation grammar matched the bare word
 * `cache`. That module is not on the read surface, so nothing failed today —
 * but a Phase 4 read module with `WITH summary AS (…)` or
 * `WITH outstanding AS (…)` is an entirely ordinary thing to write, and it
 * would have been refused. Same defect as the column false positive, one step
 * further out: the grammar names stored relations, so it must be asked only
 * about stored relations.
 *
 * `AS (` is the discriminator. A column alias is `expr AS name` with no
 * parenthesis, so it is not mistaken for a CTE.
 */
const CTE_SIGNATURE = String.raw`\s+AS\s*(?:(?:NOT\s+)?MATERIALIZED\s+)?\(`;

/**
 * Whether this SQL declares `name` as a common table expression.
 *
 * `<name> AS (` is the signature, and it is reliable without parsing the CTE
 * chain: a COLUMN alias is `expr AS name` and is never followed by a
 * parenthesis. Walking the chain with one regex is what does not work —
 * `WITH ledger AS ( … ), cache AS ( … )` has aggregate calls inside the first
 * body, and a chain-shaped pattern found `ledger` and missed `cache`.
 */
export function declaresCommonTableExpression(source: string, name: string): boolean {
  return new RegExp(String.raw`\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${CTE_SIGNATURE}`, 'i').test(source);
}

/** The relations one module's text puts in a relation position, unquoted and lowercased, sorted. */
export function relationsReferenced(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(RELATION_POSITION)) out.add((m[1] ?? m[2] ?? '').replace(/^"(.*)"$/, '$1').toLowerCase());
  return [...out].sort();
}

/**
 * A STORED relation read or written here that is itself a derived total.
 *
 * Skipped, because none of them is a stored total: a declared source document
 * (`SOURCE_DOCUMENT_TABLES`, shared with G-3) and a CTE the same SQL computes.
 */
function firstDerivedTotalRelation(source: string): string | null {
  for (const relation of relationsReferenced(source)) {
    if (SOURCE_DOCUMENT_TABLES.includes(relation)) continue;
    if (declaresCommonTableExpression(source, relation)) continue;
    if (DERIVED_TOTAL_RELATION.test(relation)) return relation;
  }
  return null;
}

export const READ_SURFACE_RULES: readonly ReadSurfaceRule[] = [
  {
    name: 'no write to an accounting table',
    why: 'a GET that writes is a mutation the merchant did not ask for and cannot audit (§39, §54); the same holds for a stock or supplier read that repairs stock_levels or stamps a purchase (P3-S7 A-03), for a Phase 4 read that stamps an invoice or backfills a customer (P4-S1), and for a write to any other relation at all — the rule is the statement, not the table list',
    offends: (source) =>
      first(
        source,
        new RegExp(
          `\\b(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|TRUNCATE(?:\\s+TABLE)?)\\s+(?:public\\.)?(${[...ACCOUNTING_TABLES, ...MERCHANT_READ_TABLES].join('|')})\\b`,
          'i',
        ),
      ) ?? first(source, ANY_DML),
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
    why: 'AL-15: every figure is aggregated from the journal at the moment it is asked for; a stored one is a second truth that can drift (§11). Stock is read from stock_levels, the one named cache, and supplier figures from the ledger and purchase_ap_outstanding at request time (P3-S7 A-03); AR, an invoice outstanding and an aging bucket are read the same way, never from a snapshot, summary or rollup under any name (P4-S1, P4-AL-06)',
    offends: (source) => first(source, NAMED_BALANCE_STORE) ?? firstDerivedTotalRelation(source),
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
