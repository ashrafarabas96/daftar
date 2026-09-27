#!/usr/bin/env tsx
/**
 * PHASE 3 SLICE GATE — P3-S8, security, failure injection, reconciliation,
 * concurrency, performance and the rebuild rehearsal (docs/PHASE_3_S8_CONTRACT.md
 * §7.1 as amended by the coordinator rulings and Annex R §2.11).
 *
 * Two tenses, chosen by `S8_ACCEPTED` alone (the S6 form,
 * `scripts/phase3-s6-gate.ts:55-60`):
 *
 *   — CANDIDATE (`S8_ACCEPTED` empty): `frozenThrough` is exactly the P3-S7
 *     boundary 0068 (S7 shipped no migration), and the files after it are
 *     exactly `S8_MIGRATIONS` — derived from the manifest as "every file after
 *     frozenThrough", which must be the one file `S8_MIGRATION_NAME` names for
 *     `B1_RULING` — none of them recorded yet.
 *   — ACCEPTED (`S8_ACCEPTED` holds its digest): `frozenThrough` is a floor at
 *     the S8 file, and the file hashes to `S8_ACCEPTED` on disk and in the
 *     manifest.
 *
 * Structural checks, in both tenses (§7.1 1-9): the boundary; the §2.11
 * content of the S8 migration, statement by statement (the four reconciler
 * column grants and, under R-B1a, exactly the delimited guard section); the
 * reconciler model; the reconciliation domain; no stored rebuild swap; TD-12;
 * the suites; the premortem matrix (the static half of T-18); the widened
 * guards (23 rules); no skip. The runtime half composes `gate:phase3:s7` first
 * (which composes S6 … S1, P2-S8 … P2-S1 and Phase 1), then the two domain
 * packages, the S8 suites, the Tier 1 budgets alone and Budget A (and B, under
 * R-B1a) alone and last.
 *
 * `--root <dir>` and `--structural-only` exist for the tamper proofs
 * (tests/security/phase3-s8-gate-tamper.test.ts, T-15c), exactly as in
 * `scripts/phase2-s8-gate.ts`: they change WHERE the gate looks, never WHAT it
 * demands, and a structural-only run never reports a verdict on tests it did
 * not run. The module runs its gate only when executed, so T-18 imports the
 * matrix checker instead of re-implementing it.
 *
 * Usage: npm run gate:phase3:s8 [-- --list]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { PHASE2_PREFIX_END } from './phase2-prefix';
import { inventoryRoutineDefinitions } from './guards/inventory-definer-contract';
import { stockTablesWritten } from './guards/inventory-writer-authority';

/** The last file P3-S7 accepted: S7 shipped no migration (S7 accepted gate, `S7_MIGRATIONS = []`). */
export const S7_BOUNDARY = '0068_supplier_settlement_commands.sql';

/** The P3-S6 migrations, which S7 and S8 sit on. */
const S6_MIGRATIONS = ['0067_payment_methods_supplier_settlement_sources.sql', '0068_supplier_settlement_commands.sql'] as const;

/**
 * B-1 (contract §9.1): the Tech Lead chose R-B1a on 2026-09-27 (refuse manual
 * and opening-balance lines on the Inventory account once the business has
 * stock movements). R-B1b/c remain only as the gate's shape for comparison.
 */
export const B1_RULING: 'R-B1a' | 'R-B1b' | 'R-B1c' = 'R-B1a';

/** The S8 migration's name under each ruling (rulings header, "Migration"). */
export const S8_MIGRATION_NAME = B1_RULING === 'R-B1a' ? '0069_inventory_reconciliation_read_and_account_domain.sql' : '0069_inventory_reconciliation_read.sql';

/** The S8 migration's digest, recorded at the freeze (P3-S8 accepted, 2026-09-27). */
const S8_ACCEPTED: Readonly<Record<string, string>> = {
  '0069_inventory_reconciliation_read_and_account_domain.sql': '912299e90a937b684b1829df4be90d5815ee61bcee79d9a01c5e47c4d6fe3084',
};

const ACCEPTED = Object.keys(S8_ACCEPTED).length > 0;

/** §2.2: the reconciler's S8 columns, exactly. */
export const RECONCILER_S8_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  stock_movements: [
    'tenant_id',
    'business_id',
    'id',
    'warehouse_id',
    'variant_id',
    'stock_seq',
    'movement_kind',
    'source_type',
    'source_id',
    'source_line_id',
    'qty_delta',
    'value_delta_base_minor',
  ],
  stock_levels: ['tenant_id', 'business_id', 'warehouse_id', 'variant_id', 'on_hand', 'valuation_base_minor', 'last_stock_seq'],
  stock_source_bindings: ['tenant_id', 'business_id', 'source_type', 'source_id', 'source_line_id', 'movement_kind'],
  accounts: ['system_key'],
};

/** A-11: what the reconciler must never read, added by S8. */
const MUST_NOT_READ_S8 = ['inventory_assertion_keys', 'inventory_assertion_uses', 'suppliers'];

/** §6.1 (+ Annex R §2.10 under R-B1a): every S8 suite, by contract id. */
export const REQUIRED_SUITE_NAMES: Readonly<Record<string, string>> = {
  'T-01': 'tests/security/phase3-s8-signed-authority-matrix.test.ts',
  'T-02': 'tests/security/phase3-s8-writer-authority.test.ts',
  'T-03': 'tests/security/phase3-s8-operation-kinds.test.ts',
  'T-04': 'tests/security/phase3-s8-grant-matrix.test.ts',
  'T-05': 'tests/security/phase3-s8-definer-law.test.ts',
  'T-06': 'tests/integration/phase3-s8-reconciliation.test.ts',
  'T-07': 'tests/security/phase3-s8-reconciliation-planted.test.ts',
  'T-08': 'tests/integration/phase3-s8-mixed-sequence.test.ts',
  'T-09': 'tests/integration/phase3-s8-rebuild-rehearsal.test.ts',
  'T-10': 'tests/integration/phase3-s8-failure-injection.test.ts',
  'T-11': 'tests/integration/phase3-s8-concurrency.test.ts',
  'T-12': 'tests/integration/phase3-s8-negative-controls.test.ts',
  'T-13': 'tests/performance/phase3-s8-budgets.test.ts',
  'T-14': 'tests/integration/phase3-s8-guards.test.ts',
  'T-15a': 'packages/accounting/test/assertion-keys.test.ts',
  'T-15b': 'tests/integration/assertion-key-separation.test.ts',
  'T-15c': 'tests/security/phase3-s8-gate-tamper.test.ts',
  'T-16': 'tests/security/phase3-s8-reconciler-authority.test.ts',
  'T-17': 'tests/integration/phase3-s8-upgrade.test.ts',
  'T-18': 'tests/security/phase3-s8-premortem-matrix.test.ts',
  ...(B1_RULING === 'R-B1a' ? { 'T-19': 'tests/integration/phase3-s8-inventory-account-domain.test.ts' } : {}),
};

/** T-13: run alone, after the functional suites (A-17, SM:36). */
const BUDGET_SUITE = 'tests/performance/phase3-s8-budgets.test.ts';
/** Budgets A (and B under R-B1a), re-measured in isolation and last (A-17, pin 15). */
const ACCOUNTING_BUDGETS = 'tests/performance/accounting-budgets.test.ts';

/** A-19: the six key-pair sites that must compare effective HMAC keys. */
export const TD12_SITES = [
  'apps/api/src/config.ts',
  'apps/api/src/modules/accounting/accounting-assertion.minter.ts',
  'apps/api/src/modules/inventory/inventory-assertion.minter.ts',
  'scripts/install-accounting-key.ts',
  'scripts/install-inventory-key.ts',
  'scripts/install-provisioning-key.ts',
] as const;
const TD12_HOME = 'packages/accounting/src/assertion-keys.ts';

/** S7's rule count; S8 widens rules and adds none. */
export const EXPECTED_RULE_COUNT = 23;

/** The one routine after the prefix that may write the stock cache (A-13 §4: no stored swap). */
const STOCK_CACHE_WRITERS = ['inventory_apply_stock_movements'];
const SWAP_TEMPLATE = 'infrastructure/database/procedures/stock-rebuild-swap.sql.template';

export const PREMORTEM_MATRIX = 'tests/premortem/phase3-premortem-matrix.json';

// ── Output ──────────────────────────────────────────────────────────────────
let failures = 0;
const fail = (check: string, detail: string): void => {
  failures += 1;
  console.error(`  FAIL [${check}] ${detail}`);
};
const ok = (detail: string): void => console.log(`  ok      ${detail}`);

// ── The SQL reader of §2.11 ─────────────────────────────────────────────────

/** One top-level statement of a migration. */
export interface SqlStatement {
  /** Offset of its first character in the raw file. */
  readonly start: number;
  /** The statement with comments removed, whitespace collapsed, every literal written '' and every dollar-quoted body written $BODY$. */
  readonly skeleton: string;
  /** The dollar-quoted bodies, verbatim. */
  readonly bodies: readonly string[];
  /** The statement exactly as written, up to (not including) its `;`. */
  readonly raw: string;
}

/**
 * Split a migration into its top-level statements, aware of comments, single-
 * quoted literals and dollar quotes, so a `;` or a keyword inside a function
 * body, a DO block or a COMMENT's text is never read as a statement.
 */
export function splitSqlStatements(sql: string): SqlStatement[] {
  const out: SqlStatement[] = [];
  let skeleton = '';
  let bodies: string[] = [];
  let start = -1;
  let i = 0;
  const flush = (end: number): void => {
    const text = skeleton.replace(/\s+/g, ' ').trim();
    if (text !== '') out.push({ start, skeleton: text, bodies, raw: sql.slice(start, end) });
    skeleton = '';
    bodies = [];
    start = -1;
  };
  while (i < sql.length) {
    const c = sql[i] ?? '';
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      skeleton += ' ';
      continue;
    }
    if (start === -1 && !/\s/.test(c)) start = i;
    const dollar = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i, i + 64));
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      bodies.push(sql.slice(i + tag.length, end === -1 ? sql.length : end));
      skeleton += ' $BODY$ ';
      i = end === -1 ? sql.length : end + tag.length;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j += 1;
      }
      skeleton += "''";
      i = j + 1;
      continue;
    }
    if (c === ';') {
      flush(i);
      i += 1;
      continue;
    }
    skeleton += c;
    i += 1;
  }
  flush(sql.length);
  return out;
}

/** Comments and literals out of a PL/pgSQL body, so only its code is judged. */
function bodyCode(body: string): string {
  return body
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

/**
 * What a DO block of the S8 migration may call (review L-1: an allow-list, not
 * a denylist): catalogue probes, privilege probes, aggregates, and the R-B1a
 * helper the end-state block asks as the accounting principal. Exactly the
 * routines 0069 calls; anything else — a writing routine, set_config, a lock,
 * a sequence — is refused wherever it hides (a PERFORM, a SELECT … INTO, an
 * assignment, a condition).
 */
export const DO_BLOCK_CALLS: ReadonlySet<string> = new Set([
  'aclexplode',
  'array_agg',
  'cardinality',
  'count',
  'current_database',
  'has_any_column_privilege',
  'has_column_privilege',
  'has_database_privilege',
  'has_function_privilege',
  'has_schema_privilege',
  'has_table_privilege',
  'inventory_business_has_stock_movements',
  'pg_get_triggerdef',
  'position',
  'string_agg',
  'to_regclass',
  'to_regprocedure',
  'unnest',
]);

/** SQL and PL/pgSQL words that may stand before a parenthesis without calling anything. */
const NOT_A_CALL = new Set(['and', 'any', 'array', 'elsif', 'exists', 'from', 'if', 'in', 'join', 'not', 'on', 'or', 'select', 'then', 'values', 'where']);

/** A role switch a DO block may make: to one of the two internal principals, and only in the R-B1a end-state block. */
const DO_ROLE_SWITCH = /^SET LOCAL ROLE (daftar_inventory_internal|daftar_accounting_internal)$/i;

/** The read-only statement forms a DO block may hold once its control prefixes (DECLARE, BEGIN, IF … THEN, FOREACH … LOOP) are read. */
const DO_FORMS: readonly RegExp[] = [
  /^END(?: IF| LOOP)?$/i,
  /^RAISE EXCEPTION ''(?:\s*,\s*[\s\S]*)?$/i,
  /^SELECT\b[\s\S]*\bINTO\s+[a-z_][a-z0-9_]*(?:\s*,\s*[a-z_][a-z0-9_]*)*\b[\s\S]*$/i,
  /^[a-z_][a-z0-9_]* := [\s\S]+$/i,
  /^RESET ROLE$/i,
];
const DO_DECLARATION = /^[a-z_][a-z0-9_]*(?: CONSTANT)? [a-z_][a-z0-9_]*(?:\[\])?(?: := [\s\S]+)?$/i;
const DO_PREFIX = /^(?:DECLARE\b|BEGIN\b|ELSE\b|(?:IF|ELSIF)\b[\s\S]*?\bTHEN\b|FOREACH [a-z_][a-z0-9_]* IN ARRAY [a-z_][a-z0-9_]* LOOP\b)\s*/i;
/** Words that make a SELECT something other than a read: a data-modifying CTE or a row lock. */
const DO_SELECT_WRITES = /\b(?:INSERT|UPDATE|DELETE|MERGE|FOR\s+(?:NO\s+KEY\s+)?UPDATE|FOR\s+(?:KEY\s+)?SHARE)\b/i;

/** The problems of one DO block's code (comments and literals already out), empty when it only states and asserts. */
export function doBlockProblems(code: string, inRB1aSection: boolean): string[] {
  const problems: string[] = [];
  if (code.includes('"')) problems.push('a quoted identifier — a DO block here names every object plainly');
  let inDeclare = false;
  for (const piece of code.split(';')) {
    let rest = piece.replace(/\s+/g, ' ').trim();
    for (let m = DO_PREFIX.exec(rest); m !== null && rest !== ''; m = DO_PREFIX.exec(rest)) {
      const word = (m[0].trim().split(' ')[0] ?? '').toUpperCase();
      if (word === 'DECLARE') inDeclare = true;
      if (word === 'BEGIN') inDeclare = false;
      rest = rest.slice(m[0].length);
    }
    if (rest === '') continue;
    if (DO_ROLE_SWITCH.test(rest)) {
      if (!inRB1aSection)
        problems.push(
          `${rest} — a role switch to an internal principal is admitted only in the R-B1a end-state block, and this block is outside the R-B1a section`,
        );
      continue;
    }
    const allowed = inDeclare ? DO_DECLARATION.test(rest) : DO_FORMS.some((f) => f.test(rest)) && !(/^SELECT\b/i.test(rest) && DO_SELECT_WRITES.test(rest));
    if (!allowed)
      problems.push(
        `${rest.slice(0, 90)}${rest.length > 90 ? '…' : ''} — not a read-only assertion form (SELECT … INTO, :=, IF, FOREACH, RAISE EXCEPTION, SET LOCAL ROLE/RESET ROLE)`,
      );
  }
  for (const m of code.matchAll(/(\bAS\s+)?\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi)) {
    const name = (m[2] ?? '').toLowerCase();
    if (m[1] !== undefined || NOT_A_CALL.has(name) || DO_BLOCK_CALLS.has(name)) continue;
    problems.push(`calls ${name}( — a DO block here calls only ${[...DO_BLOCK_CALLS].join(', ')}`);
  }
  return problems;
}

const R_B1A_HELPER = 'inventory_business_has_stock_movements';
const R_B1A_GUARD = 'accounting_inventory_account_domain_guard';
const R_B1A_TRIGGER = 'journal_entries_inventory_account_domain';
/**
 * The R-B1a trigger exactly as 0069 writes it (review L-2): the WHEN clause is
 * the rule's scope, so any other filter — `WHEN (false)`, one type — is a
 * different rule. 0069-E (3) and T-19 pin its deparsed form.
 */
export const R_B1A_TRIGGER_SQL =
  "CREATE CONSTRAINT TRIGGER journal_entries_inventory_account_domain AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.source_type IN ('manual_adjustment', 'opening_balance')) EXECUTE FUNCTION accounting_inventory_account_domain_guard()";
/** md5 of each R-B1a body as written — equal to md5(pg_proc.prosrc), which T-19 pins on the live catalogue. */
export const R_B1A_GUARD_BODY_MD5 = 'c6254815e09d55cf6072c3a465519183';
export const R_B1A_HELPER_BODY_MD5 = '4f3b6dd09d6ac5084051891072e1c9f7';
const md5 = (text: string): string => createHash('md5').update(text, 'utf8').digest('hex');
const PINNED_PATH =
  /\bSECURITY DEFINER\b[\s\S]*\bSET search_path = pg_catalog, public, pg_temp\b|\bSET search_path = pg_catalog, public, pg_temp\b[\s\S]*\bSECURITY DEFINER\b/i;

/** Annex R §2.11: the R-B1a statements, each exactly once (the COMMENTs at most once). */
const R_B1A_EXPECTED: Readonly<Record<string, readonly [min: number, max: number]>> = {
  'grant-create:daftar_inventory_internal': [1, 1],
  'revoke-create:daftar_inventory_internal': [1, 1],
  'grant-create:daftar_accounting_internal': [1, 1],
  'revoke-create:daftar_accounting_internal': [1, 1],
  [`create-function:${R_B1A_HELPER}`]: [1, 1],
  [`create-function:${R_B1A_GUARD}`]: [1, 1],
  [`comment:${R_B1A_HELPER}`]: [0, 1],
  [`comment:${R_B1A_GUARD}`]: [0, 1],
  [`revoke-public:${R_B1A_HELPER}`]: [1, 1],
  [`revoke-public:${R_B1A_GUARD}`]: [1, 1],
  [`grant-execute:${R_B1A_HELPER}`]: [1, 1],
  [`owner:${R_B1A_HELPER}`]: [1, 1],
  [`owner:${R_B1A_GUARD}`]: [1, 1],
  [`trigger:${R_B1A_TRIGGER}`]: [1, 1],
};

const Q = String.raw`(?:public\.)?`;
const FN_ARGS = String.raw`\s?\([^()]*\)`;

/** Classify one R-B1a statement, or return null when it is not one of §2.11's. */
function classifyRB1a(st: SqlStatement): string | null {
  const s = st.skeleton;
  let m = new RegExp(String.raw`^GRANT CREATE ON SCHEMA public TO (daftar_inventory_internal|daftar_accounting_internal)$`, 'i').exec(s);
  if (m) return `grant-create:${(m[1] ?? '').toLowerCase()}`;
  m = new RegExp(String.raw`^REVOKE CREATE ON SCHEMA public FROM (daftar_inventory_internal|daftar_accounting_internal)$`, 'i').exec(s);
  if (m) return `revoke-create:${(m[1] ?? '').toLowerCase()}`;
  m = new RegExp(String.raw`^CREATE FUNCTION ${Q}(${R_B1A_HELPER}|${R_B1A_GUARD})\s?\(`, 'i').exec(s);
  if (m) {
    const name = (m[1] ?? '').toLowerCase();
    const returns = name === R_B1A_HELPER ? /\bRETURNS BOOLEAN LANGUAGE sql STABLE\b/i : /\bRETURNS trigger LANGUAGE plpgsql\b/i;
    const pinned = name === R_B1A_HELPER ? R_B1A_HELPER_BODY_MD5 : R_B1A_GUARD_BODY_MD5;
    return PINNED_PATH.test(s) && returns.test(s) && st.bodies.length === 1 && md5(st.bodies[0] ?? '') === pinned ? `create-function:${name}` : null;
  }
  m = new RegExp(String.raw`^COMMENT ON FUNCTION ${Q}(${R_B1A_HELPER}|${R_B1A_GUARD})${FN_ARGS} IS ''$`, 'i').exec(s);
  if (m) return `comment:${(m[1] ?? '').toLowerCase()}`;
  m = new RegExp(String.raw`^REVOKE ALL ON FUNCTION ${Q}(${R_B1A_HELPER}|${R_B1A_GUARD})${FN_ARGS} FROM PUBLIC$`, 'i').exec(s);
  if (m) return `revoke-public:${(m[1] ?? '').toLowerCase()}`;
  if (new RegExp(String.raw`^GRANT EXECUTE ON FUNCTION ${Q}${R_B1A_HELPER}\s?\(\s?UUID\s?\) TO daftar_accounting_internal$`, 'i').test(s))
    return `grant-execute:${R_B1A_HELPER}`;
  if (new RegExp(String.raw`^ALTER FUNCTION ${Q}${R_B1A_HELPER}${FN_ARGS} OWNER TO daftar_inventory_internal$`, 'i').test(s)) return `owner:${R_B1A_HELPER}`;
  if (new RegExp(String.raw`^ALTER FUNCTION ${Q}${R_B1A_GUARD}${FN_ARGS} OWNER TO daftar_accounting_internal$`, 'i').test(s)) return `owner:${R_B1A_GUARD}`;
  if (
    st.raw
      .replace(/--[^\n]*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() === R_B1A_TRIGGER_SQL
  )
    return `trigger:${R_B1A_TRIGGER}`;
  return null;
}

const RECONCILER_GRANT = new RegExp(String.raw`^GRANT SELECT\s?\(([^()]*)\) ON (?:TABLE )?${Q}([a-z_][a-z0-9_]*) TO daftar_reconciler$`, 'i');

/**
 * §7.1(1) and Annex R §2.11: the S8 migration admits exactly
 *   — `DO` blocks that change nothing: only the read-only assertion forms and
 *     the `DO_BLOCK_CALLS` routines (`doBlockProblems`), a role switch to an
 *     internal principal only inside the R-B1a section;
 *   — the four column-level `GRANT SELECT (…) … TO daftar_reconciler`, with
 *     exactly `RECONCILER_S8_COLUMNS`;
 *   — under R-B1a, and only between its BEGIN/END markers, exactly the
 *     `R_B1A_EXPECTED` statements.
 * Every other statement is a problem. Returns the problems, empty when clean.
 */
export function s8MigrationContentProblems(raw: string, ruling: string = B1_RULING): string[] {
  const problems: string[] = [];
  const begins = [...raw.matchAll(/^-- ══ BEGIN R-B1a\b/gm)].map((m) => m.index ?? 0);
  const ends = [...raw.matchAll(/^-- ══ END R-B1a\b/gm)].map((m) => m.index ?? 0);
  const rb1a = ruling === 'R-B1a';
  let section: [number, number] | null = null;
  if (rb1a) {
    if (begins.length !== 1 || ends.length !== 1 || (begins[0] ?? 0) > (ends[0] ?? 0)) {
      problems.push(`the R-B1a section must be delimited by exactly one BEGIN and one END marker (found ${begins.length} and ${ends.length})`);
    } else {
      section = [begins[0] ?? 0, ends[0] ?? 0];
    }
  } else if (begins.length + ends.length > 0) {
    problems.push(`B1_RULING is ${ruling} but the R-B1a section is still in the file`);
  }

  const grants = new Map<string, string[]>();
  const rb1aSeen = new Map<string, number>();
  for (const st of splitSqlStatements(raw)) {
    const s = st.skeleton;
    const where = `statement at offset ${st.start} (${s.slice(0, 90)}${s.length > 90 ? '…' : ''})`;
    if (/^DO(?: LANGUAGE plpgsql)? \$BODY\$(?: LANGUAGE plpgsql)?$/i.test(s)) {
      const code = st.bodies.map(bodyCode).join('\n');
      const inSection = section !== null && st.start >= section[0] && st.start <= section[1];
      for (const p of doBlockProblems(code, inSection)) problems.push(`a DO block ${where} ${p.startsWith('calls ') ? p : `contains ${p}`}`);
      continue;
    }
    const grant = RECONCILER_GRANT.exec(s);
    if (grant) {
      const table = (grant[2] ?? '').toLowerCase();
      if (grants.has(table)) problems.push(`${table} is granted to daftar_reconciler twice`);
      grants.set(
        table,
        (grant[1] ?? '')
          .split(',')
          .map((c) => c.trim().toLowerCase())
          .filter((c) => c !== ''),
      );
      continue;
    }
    const kind = rb1a ? classifyRB1a(st) : null;
    if (kind !== null) {
      if (section === null || st.start < section[0] || st.start > section[1]) problems.push(`${kind} ${where} is outside the delimited R-B1a section`);
      rb1aSeen.set(kind, (rb1aSeen.get(kind) ?? 0) + 1);
      continue;
    }
    problems.push(`${where} is not admitted by §2.11`);
  }

  for (const [table, expected] of Object.entries(RECONCILER_S8_COLUMNS)) {
    const actual = grants.get(table);
    if (actual === undefined) {
      problems.push(`no column grant of ${table} to daftar_reconciler`);
      continue;
    }
    const want = [...expected].sort().join(', ');
    const got = [...actual].sort().join(', ');
    if (want !== got || new Set(actual).size !== actual.length) problems.push(`${table} grants daftar_reconciler (${got}) — §2.2 is exactly (${want})`);
  }
  for (const table of grants.keys()) {
    if (!(table in RECONCILER_S8_COLUMNS))
      problems.push(`${table} is granted to daftar_reconciler — §2.2 names only ${Object.keys(RECONCILER_S8_COLUMNS).join(', ')}`);
  }
  if (rb1a) {
    for (const [kind, [min, max]] of Object.entries(R_B1A_EXPECTED)) {
      const n = rb1aSeen.get(kind) ?? 0;
      if (n < min || n > max) problems.push(`R-B1a needs ${min === max ? `exactly ${min}` : `${min}–${max}`} × ${kind}, found ${n}`);
    }
  }
  return problems;
}

// ── The premortem matrix (A-14; the static half of T-18) ───────────────────

interface MatrixRow {
  readonly invariant?: unknown;
  readonly positive?: unknown;
  readonly negativeControl?: unknown;
  readonly s8?: unknown;
}

/** The ids the matrix must hold, exactly. */
export const PREMORTEM_IDS: readonly string[] = Array.from({ length: 46 }, (_, i) => `PM-${String(i + 1).padStart(2, '0')}`);

/**
 * Every `it(` / `test(` title in a test file (`.each(…)` and `.concurrent`
 * included; `.skip`, `.todo` and `.only` are not proof and are not read),
 * with simple escapes resolved. Titles may span lines.
 */
export function testTitles(source: string): string[] {
  const titles: string[] = [];
  const re =
    /\b(?:it|test)((?:\.(?:each|concurrent|sequential|fails|skip|todo|only|skipIf|runIf)\b(?:\s*\([\s\S]*?\))?)*)\s*\(\s*(['"`])((?:\\[\s\S]|(?!\2)[^\\])*)\2/g;
  for (const m of source.matchAll(re)) {
    if (/\.(?:skip|todo|only|skipIf|runIf)\b/.test(m[1] ?? '')) continue;
    titles.push((m[3] ?? '').replace(/\\([\s\S])/g, '$1'));
  }
  return titles;
}

/**
 * The problems of the premortem matrix under `root`, empty when it is
 * complete: the ids are exactly PM-01 … PM-46; every row states its
 * invariant and has at least one positive test and one negative control;
 * every `file::title prefix` names an existing file with an `it(` title that
 * starts with the prefix; every `s8` suite exists.
 */
export function premortemMatrixProblems(root: string, matrix?: unknown): string[] {
  const problems: string[] = [];
  let parsed: unknown = matrix;
  if (parsed === undefined) {
    const path = join(root, PREMORTEM_MATRIX);
    if (!existsSync(path)) return [`${PREMORTEM_MATRIX} is missing`];
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      return [`${PREMORTEM_MATRIX} is not JSON: ${error instanceof Error ? error.message : String(error)}`];
    }
  }
  const rows = typeof parsed === 'object' && parsed !== null && 'rows' in parsed ? (parsed as { rows: unknown }).rows : undefined;
  if (typeof rows !== 'object' || rows === null || Array.isArray(rows)) return ['the matrix has no `rows` object'];
  const byId = rows as Record<string, MatrixRow>;
  const ids = Object.keys(byId);
  for (const id of PREMORTEM_IDS) if (!ids.includes(id)) problems.push(`${id} is missing from the matrix`);
  for (const id of ids) if (!PREMORTEM_IDS.includes(id)) problems.push(`${id} is not a premortem id (PM-01 … PM-46)`);

  const titleCache = new Map<string, string[] | null>();
  const titlesOf = (file: string): string[] | null => {
    if (!titleCache.has(file)) {
      const path = join(root, file);
      titleCache.set(file, existsSync(path) ? testTitles(readFileSync(path, 'utf8')) : null);
    }
    return titleCache.get(file) ?? null;
  };
  const refs = (id: string, field: 'positive' | 'negativeControl', value: unknown): void => {
    if (!Array.isArray(value) || value.length === 0) {
      problems.push(`${id} has no ${field} test`);
      return;
    }
    for (const ref of value) {
      if (typeof ref !== 'string' || !ref.includes('::')) {
        problems.push(`${id} ${field}: ${JSON.stringify(ref)} is not "<file>::<title prefix>"`);
        continue;
      }
      const [file = '', prefix = ''] = ref.split('::');
      if (prefix.trim() === '') {
        problems.push(`${id} ${field}: ${file} names no title`);
        continue;
      }
      const titles = titlesOf(file);
      if (titles === null) problems.push(`${id} ${field}: ${file} does not exist`);
      else if (!titles.some((t) => t.startsWith(prefix))) problems.push(`${id} ${field}: no it( title in ${file} starts with "${prefix}"`);
    }
  };
  for (const id of PREMORTEM_IDS) {
    const row = byId[id];
    if (row === undefined) continue;
    if (typeof row.invariant !== 'string' || row.invariant.trim() === '') problems.push(`${id} states no invariant`);
    refs(id, 'positive', row.positive);
    refs(id, 'negativeControl', row.negativeControl);
    if (row.s8 !== undefined) {
      if (!Array.isArray(row.s8)) problems.push(`${id} s8 is not a list`);
      else
        for (const suite of row.s8) {
          if (typeof suite !== 'string' || !existsSync(join(root, suite))) problems.push(`${id} s8: ${String(suite)} does not exist`);
        }
    }
  }
  return problems;
}

// ── The gate against a tree ─────────────────────────────────────────────────

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function runGate(root: string, listOnly: boolean, structuralOnly: boolean): void {
  const MIGRATIONS_DIR = join(root, 'infrastructure/database/migrations');
  const read = (path: string): string => readFileSync(join(root, path), 'utf8');
  const has = (path: string): boolean => existsSync(join(root, path));
  const sqlFiles = (): string[] =>
    readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  const sha256 = (name: string): string =>
    createHash('sha256')
      .update(readFileSync(join(MIGRATIONS_DIR, name)))
      .digest('hex');
  const stripTsProse = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  const walk = (dir: string, accept: (name: string) => boolean): string[] => {
    const abs = join(root, dir);
    if (!existsSync(abs)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(abs).sort()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue;
      const full = join(abs, entry);
      if (statSync(full).isDirectory()) out.push(...walk(relative(root, full), accept));
      else if (accept(entry)) out.push(relative(root, full).split('\\').join('/'));
    }
    return out;
  };
  const manifest = (): { frozenThrough: string; migrations: { name: string; sha256: string }[] } =>
    JSON.parse(read('infrastructure/database/MIGRATION_MANIFEST.json')) as { frozenThrough: string; migrations: { name: string; sha256: string }[] };

  /** The S8 migrations: every file after `frozenThrough` while a candidate; the accepted names once frozen. */
  const s8Migrations = (): string[] => (ACCEPTED ? Object.keys(S8_ACCEPTED).sort() : sqlFiles().filter((f) => f > manifest().frozenThrough));

  /** The S8 functional suites (T-01 … T-12, T-14 … T-19): every `phase3-s8-*` suite under tests/integration and tests/security, and T-15b. */
  const functionalSuites = (): string[] =>
    [
      ...['tests/integration', 'tests/security'].flatMap((dir) =>
        has(dir)
          ? readdirSync(join(root, dir))
              .filter((f) => /^phase3-s8-.*\.test\.ts$/.test(f))
              .map((f) => `${dir}/${f}`)
          : [],
      ),
      REQUIRED_SUITE_NAMES['T-15b'] ?? '',
    ]
      .filter((f) => f !== '' && has(f))
      .sort();

  // ── 1. Boundary ───────────────────────────────────────────────────────────
  function checkBoundary(): void {
    console.log(`P3-S8 GATE — migration boundary (${ACCEPTED ? 'accepted' : 'candidate'}; ${B1_RULING})`);
    const m = manifest();
    const recorded = new Map(m.migrations.map((x) => [x.name, x.sha256]));
    const mark = failures;
    for (const name of S6_MIGRATIONS) {
      if (!existsSync(join(MIGRATIONS_DIR, name))) fail('boundary', `${name} is missing`);
      else if (recorded.get(name) !== sha256(name)) fail('boundary', `${name} does not hash to its manifest digest`);
    }
    if (failures === mark) ok('0067 and 0068 hash to their manifest digests (the accepted digests themselves are proven by the predecessor step)');
    const files = s8Migrations();
    if (!ACCEPTED) {
      if (m.frozenThrough !== S7_BOUNDARY)
        fail('boundary', `frozenThrough is ${m.frozenThrough} — a P3-S8 candidate sits exactly on the P3-S7 boundary ${S7_BOUNDARY}`);
      else ok(`frozenThrough = ${S7_BOUNDARY} — P3-S8 is not frozen`);
      if (JSON.stringify(files) !== JSON.stringify([S8_MIGRATION_NAME]))
        fail('boundary', `after ${m.frozenThrough} a P3-S8 candidate holds exactly ${S8_MIGRATION_NAME} (${B1_RULING}) — found ${files.join(', ') || 'none'}`);
      else ok(`S8_MIGRATIONS (derived from the manifest) = ${S8_MIGRATION_NAME}`);
      for (const name of files) if (recorded.has(name)) fail('boundary', `${name} is in the manifest before P3-S8 was accepted — premature freeze`);
      return;
    }
    if (JSON.stringify(files) !== JSON.stringify([S8_MIGRATION_NAME])) fail('boundary', `S8_ACCEPTED must name exactly ${S8_MIGRATION_NAME}`);
    if (m.frozenThrough < S8_MIGRATION_NAME)
      fail('boundary', `frozenThrough is ${m.frozenThrough} — it is a floor at ${S8_MIGRATION_NAME} once P3-S8 is accepted`);
    else ok(`frozenThrough = ${m.frozenThrough} — at or beyond ${S8_MIGRATION_NAME}`);
    for (const [name, accepted] of Object.entries(S8_ACCEPTED)) {
      if (!existsSync(join(MIGRATIONS_DIR, name))) {
        fail('boundary', `${name} was accepted but is missing`);
        continue;
      }
      if (sha256(name) !== accepted) fail('boundary', `${name} hashes to ${sha256(name).slice(0, 12)}… but was accepted at ${accepted.slice(0, 12)}…`);
      if (recorded.get(name) !== accepted) fail('boundary', `${name} is not frozen in the manifest at its accepted digest`);
    }
  }

  // ── 2. Migration content (§7.1(1), Annex R §2.11) ─────────────────────────
  function checkMigrationContent(): void {
    console.log('P3-S8 GATE — migration content (§7.1(1), Annex R §2.11)');
    const mark = failures;
    for (const name of s8Migrations()) {
      if (!existsSync(join(MIGRATIONS_DIR, name))) continue;
      for (const p of s8MigrationContentProblems(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'))) fail('migration', `${name}: ${p}`);
    }
    if (B1_RULING === 'R-B1a') {
      const filter = 'apps/api/src/common/error.filter.ts';
      if (!has(filter) || !stripTsProse(read(filter)).includes("'accounting.inventory_account_domain_owned'"))
        fail('migration', `${filter} does not map accounting.inventory_account_domain_owned (R-B1a, Annex R §2.9)`);
    }
    if (failures === mark)
      ok(
        `the S8 migration holds DO blocks that change nothing, the four reconciler column grants of §2.2${B1_RULING === 'R-B1a' ? ', and exactly the delimited R-B1a statements; the error filter maps its code' : ''}`,
      );
  }

  // ── 3. Reconciler model and the reconciliation domain (§7.1(2), (3)) ─────
  function checkReconcilerModel(): void {
    console.log('P3-S8 GATE — reconciler model and reconciliation domain (A-10, A-11, A-12)');
    const mark = failures;
    const model = JSON.parse(read('infrastructure/database/reconciler-privilege-model.json')) as {
      selectColumns?: Record<string, string[]>;
      mustNotRead?: string[];
      executableRoutines?: string[];
    };
    for (const [table, columns] of Object.entries(RECONCILER_S8_COLUMNS)) {
      const inModel = model.selectColumns?.[table] ?? [];
      const s8 = table === 'accounts' ? inModel.filter((c) => columns.includes(c)) : inModel;
      if ([...s8].sort().join(',') !== [...columns].sort().join(','))
        fail('reconciler-model', `the model's ${table} columns (${inModel.join(', ')}) do not carry exactly §2.2's (${columns.join(', ')})`);
    }
    for (const t of MUST_NOT_READ_S8) if (!(model.mustNotRead ?? []).includes(t)) fail('reconciler-model', `mustNotRead lacks ${t} (A-11)`);
    if ((model.executableRoutines ?? []).length !== 1) fail('reconciler-model', `executableRoutines must stay exactly one (A-11)`);

    const reconciliation = has('packages/accounting/src/reconciliation.ts') ? stripTsProse(read('packages/accounting/src/reconciliation.ts')) : '';
    for (const id of ['R-INV-01', 'R-INV-02', 'R-INV-03', 'R-INV-04', 'R-INV-05'])
      if (!reconciliation.includes(`'${id}'`)) fail('reconciler-model', `packages/accounting/src/reconciliation.ts does not define ${id} (A-10)`);
    if (!/export\s+const\s+ALL_RECONCILIATION_CHECK_IDS\b/.test(reconciliation))
      fail('reconciler-model', 'packages/accounting/src/reconciliation.ts does not export ALL_RECONCILIATION_CHECK_IDS');
    if (!/requires:\s*\[[^\]]*'stock_movements'/.test(reconciliation)) fail('reconciler-model', 'no reconciliation check requires stock_movements');
    const deferred = /DEFERRED_RECONCILIATION_DOMAINS[^=]*=\s*\[([\s\S]*?)\];/.exec(reconciliation);
    if (!deferred) fail('reconciler-model', 'DEFERRED_RECONCILIATION_DOMAINS is not declared');
    else if ((deferred[1] ?? '').includes("'inventory-valuation'"))
      fail('reconciler-model', 'DEFERRED_RECONCILIATION_DOMAINS still defers inventory-valuation (A-12)');
    const readerPath = 'apps/api/src/modules/accounting/accounting-reconciliation.reader.ts';
    const reader = has(readerPath) ? stripTsProse(read(readerPath)) : '';
    if (!reader.includes('has_any_column_privilege')) fail('reconciler-model', `${readerPath} has no has_any_column_privilege probe`);
    const lossy = /\bround\s*\(|numeric\s*\(\s*28|::\s*(?:float|double|real)\b/i.exec(reader);
    if (lossy) fail('reconciler-model', `${readerPath} uses ${lossy[0]} — the R-INV comparisons are exact integers (L:1243)`);
    if (failures === mark)
      ok(
        'the model carries §2.2 and the A-11 exclusions; R-INV-01..05 and ALL_RECONCILIATION_CHECK_IDS exist; inventory-valuation is no longer deferred; the probe; no rounding',
      );
  }

  // ── 4. No stored swap (§7.1(4), A-13) ─────────────────────────────────────
  function checkNoStoredSwap(): void {
    console.log('P3-S8 GATE — no stored rebuild swap (A-13, rule 22)');
    const mark = failures;
    const migrations: Record<string, string> = {};
    for (const name of sqlFiles()) if (name > PHASE2_PREFIX_END) migrations[name] = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
    const writers = new Set<string>();
    for (const d of inventoryRoutineDefinitions(migrations)) {
      if (d.body !== null && stockTablesWritten(d.body, (t) => t === 'stock_levels').length > 0) writers.add(d.name);
    }
    const found = [...writers].sort();
    if (JSON.stringify(found) !== JSON.stringify(STOCK_CACHE_WRITERS))
      fail(
        'migration',
        `the routines after ${PHASE2_PREFIX_END} that write stock_levels are ${found.join(', ') || 'none'} — only ${STOCK_CACHE_WRITERS.join(', ')} may`,
      );
    if (!has(SWAP_TEMPLATE)) fail('migration', `${SWAP_TEMPLATE} is missing (A-13)`);
    else if (/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b/i.test(read(SWAP_TEMPLATE).replace(/--[^\n]*/g, ' ')))
      fail('migration', `${SWAP_TEMPLATE} defines a routine — the swap is an incident migration, never a stored routine`);
    if (failures === mark) ok(`only ${STOCK_CACHE_WRITERS.join(', ')} writes the stock cache; the swap is the procedure template outside migrations/`);
  }

  // ── 5. TD-12 (§7.1(5), A-19) ──────────────────────────────────────────────
  function checkTd12(): void {
    console.log('P3-S8 GATE — TD-12: one effective-key comparison (A-19)');
    const mark = failures;
    const definition = /\b(?:function\s+hmacKeysEquivalent\b|(?:const|let|var)\s+hmacKeysEquivalent\s*=)/;
    const sources = [...walk('apps', (f) => /\.tsx?$/.test(f)), ...walk('packages', (f) => /\.tsx?$/.test(f)), ...walk('scripts', (f) => /\.ts$/.test(f))];
    const defined = sources.filter((f) => definition.test(stripTsProse(read(f))));
    if (JSON.stringify(defined) !== JSON.stringify([TD12_HOME]))
      fail('td12', `hmacKeysEquivalent must be defined exactly once, in ${TD12_HOME} — found ${defined.join(', ') || 'none'}`);
    for (const site of TD12_SITES) {
      if (!has(site)) {
        fail('td12', `${site} is missing`);
        continue;
      }
      const code = stripTsProse(read(site));
      if (!/\bhmacKeysEquivalent\s*\(/.test(code)) fail('td12', `${site} does not compare keys with hmacKeysEquivalent`);
      const bytewise = /\.equals\(|\bsecretsAreIdentical\(/.exec(code);
      if (bytewise) fail('td12', `${site} still compares key bytes (${bytewise[0]}) — the defect TD-12 names`);
    }
    const provisioning = has('scripts/install-provisioning-key.ts') ? stripTsProse(read('scripts/install-provisioning-key.ts')) : '';
    for (const key of ['ACCOUNTING_ASSERTION_KEY', 'INVENTORY_ASSERTION_KEY'])
      if (!provisioning.includes(key)) fail('td12', `scripts/install-provisioning-key.ts does not check the pair with ${key}`);
    if (walk('packages/inventory/src', (f) => /\.ts$/.test(f)).some((f) => definition.test(stripTsProse(read(f)))))
      fail('td12', 'packages/inventory/src still defines hmacKeysEquivalent');
    if (failures === mark) ok(`hmacKeysEquivalent is defined once, in ${TD12_HOME}, and every one of the ${TD12_SITES.length} key-pair sites uses it`);
  }

  // ── 6. Suites and no skip (§7.1(6), (9)) ──────────────────────────────────
  function checkSuites(): void {
    console.log('P3-S8 GATE — suites (§6.1)');
    const mark = failures;
    for (const [id, file] of Object.entries(REQUIRED_SUITE_NAMES)) if (!has(file)) fail('suites', `${id} ${file} is missing`);
    const skip = /\b(?:it|test|describe|suite)\.(?:skip|only|todo|skipIf|runIf)\b|\bx(?:it|describe)\s*\(|RELEASE_GATE_SKIP_/;
    // Code only: a quoted fixture that NAMES a skip (T-18's title reader proof) is not one.
    const quoted = /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g;
    for (const file of Object.values(REQUIRED_SUITE_NAMES)) {
      if (!has(file)) continue;
      const hit = skip.exec(stripTsProse(read(file)).replace(quoted, "''"));
      if (hit) fail('suites', `${file} contains ${hit[0]} — no S8 suite skips (§7.1(9))`);
    }
    if (failures === mark) ok(`${Object.keys(REQUIRED_SUITE_NAMES).length} S8 suites exist (${functionalSuites().length} functional); none skips`);
  }

  // ── 7. Premortem (§7.1(7)) ────────────────────────────────────────────────
  function checkPremortem(): void {
    console.log('P3-S8 GATE — premortem matrix (A-14, the static half of T-18)');
    const problems = premortemMatrixProblems(root);
    for (const p of problems) fail('premortem', p);
    if (problems.length === 0) ok(`PM-01 … PM-46 each resolve to a positive test and a negative control`);
  }

  // ── 8. Guards (§7.1(8), A-18) ─────────────────────────────────────────────
  function checkGuards(): void {
    console.log('P3-S8 GATE — static guards (A-18; 23 rules)');
    const mark = failures;
    const code = (file: string): string => (has(file) ? stripTsProse(read(file)) : '');
    const references: readonly (readonly [file: string, token: RegExp, why: string])[] = [
      ['scripts/guards/no-authoritative-balance.ts', /\bPHASE2_PREFIX_END\b/, 'G-3 discovers the Phase 3 surface after PHASE2_PREFIX_END (a)'],
      ['scripts/guards/no-float-rate.ts', /\bisPhase3Relation\b/, 'G-2 reads the same Phase 3 discovery (b)'],
      ['scripts/guards/posting-surface.ts', /\bINVENTORY_PERIMETER\b/, 'G-4 carries the inventory perimeter (c)'],
      ['scripts/guards/definer-search-path.ts', /\bPHASE2_PREFIX_END\b/, 'G-5 skips frozen files only up to PHASE2_PREFIX_END (d)'],
      ['scripts/guards/inventory-writer-authority.ts', /\bPHASE2_PREFIX_END\b/, 'rule 22 reads the truth set after PHASE2_PREFIX_END (e)'],
      [
        'scripts/guards/inventory-writer-authority.ts',
        /WRITER_AUTHORITY_EXCEPTIONS\s*:\s*readonly string\[\]\s*=\s*\[\s*'warehouses_home_branch_maintain'\s*\]/,
        'rule 22 exempts exactly warehouses_home_branch_maintain (e)',
      ],
    ];
    for (const [file, token, why] of references) if (!token.test(code(file))) fail('guards', `${file}: ${why} — not found`);
    // The same guard program `npm run check:guards` runs, under the same tsx.
    const res = spawnSync(process.execPath, [...process.execArgv, join(root, 'scripts/static-guards.ts')], { cwd: root, encoding: 'utf8', env: process.env });
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    if (res.status !== 0 || !output.includes(`STATIC GUARDS: PASS (${EXPECTED_RULE_COUNT} rules)`))
      fail('guards', `the static guards did not print PASS (${EXPECTED_RULE_COUNT} rules) (exit ${res.status ?? 'signal'}):\n${output.slice(-2500)}`);
    if (failures === mark) ok(`STATIC GUARDS: PASS (${EXPECTED_RULE_COUNT} rules), with rules 15-18 and 22 on the Phase 3 surface`);
  }

  // ── 9. Budgets stay (§A-17) ───────────────────────────────────────────────
  function checkBudgets(): void {
    console.log('P3-S8 GATE — budgets (A-17)');
    const mark = failures;
    const accounting = has(ACCOUNTING_BUDGETS) ? read(ACCOUNTING_BUDGETS) : '';
    if (!/\bA_POST_P95:\s*15,/.test(accounting)) fail('perf', `Budget A is not 15 ms in ${ACCOUNTING_BUDGETS} — it is never raised`);
    if (!/\bB_ADJUSTMENT_ENDPOINT_P95:\s*60,/.test(accounting)) fail('perf', `Budget B is not 60 ms in ${ACCOUNTING_BUDGETS} — it is never raised`);
    const t13 = has(BUDGET_SUITE) ? read(BUDGET_SUITE) : '';
    for (const id of ['S8-R1', 'S8-R2', 'S8-V', 'S8-B', 'S8-M']) if (!t13.includes(`'${id}'`)) fail('perf', `${BUDGET_SUITE} does not measure ${id}`);
    if (failures === mark) ok('Budget A 15 ms and B 60 ms unchanged; T-13 measures S8-R1, R2, V, B and M');
  }

  // ── Runtime ───────────────────────────────────────────────────────────────
  const STEPS = (): { name: string; area: string; cmd: string; args: string[] }[] => [
    {
      name: 'P3-S7 gate (permanent predecessor; composes P3-S6 … P3-S1, P2-S8 … P2-S1 and Phase 1)',
      area: 'predecessor',
      cmd: npm,
      args: ['run', 'gate:phase3:s7'],
    },
    { name: '@daftar/accounting unit suite (T-15a, R-INV definitions)', area: 'suites', cmd: npm, args: ['run', 'test', '-w', '@daftar/accounting'] },
    { name: '@daftar/inventory unit suite', area: 'suites', cmd: npm, args: ['run', 'test', '-w', '@daftar/inventory'] },
    { name: 'S8 functional suites (T-01 … T-12, T-14 … T-19)', area: 'suites', cmd: 'npx', args: ['vitest', 'run', ...functionalSuites()] },
    { name: 'T-13 Tier 1 budgets, alone', area: 'perf', cmd: 'npx', args: ['vitest', 'run', BUDGET_SUITE] },
    {
      name: `Budget A${B1_RULING === 'R-B1a' ? ' and B (the R-B1a guard fires at a manual adjustment’s COMMIT)' : ''} in isolation, last`,
      area: 'perf',
      cmd: 'npx',
      args: ['vitest', 'run', ACCOUNTING_BUDGETS],
    },
  ];

  function runnerReportsFailure(): void {
    const res = spawnSync('npx', ['vitest', 'run', '--config', 'tests/fixtures/runner-exit-code/vitest.config.ts', 'failing'], {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
    });
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    if (!/1 failed/.test(output))
      fail('suites', `the exit-code canary did not run its failing test, so this run proves nothing about the runner:\n${output.slice(-2000)}`);
    else if (res.status === 0) fail('suites', 'the test runner exited 0 over a failing test; no result in this run is evidence (tests/helpers/exit-code.ts)');
    else ok(`the test runner reports failure (canary exited ${res.status ?? 'on a signal'})`);
  }

  if (listOnly) {
    console.log(`P3-S8 GATE plan (${ACCEPTED ? 'accepted' : 'candidate'}; ${B1_RULING}):`);
    if (ACCEPTED) console.log(`  structural: frozenThrough at or beyond ${S8_MIGRATION_NAME}; it hashes to S8_ACCEPTED on disk and in the manifest`);
    else console.log(`  structural: frozenThrough = ${S7_BOUNDARY}; after it exactly ${S8_MIGRATION_NAME}, unrecorded`);
    console.log('  structural: §2.11 content (4 reconciler column grants; the delimited R-B1a statements; DO blocks change nothing); the error filter');
    console.log('  structural: reconciler model; R-INV-01..05; no stored swap; TD-12 at six sites; premortem PM-01..46; static guards (23 rules); budgets');
    console.log('  suites:');
    for (const [id, file] of Object.entries(REQUIRED_SUITE_NAMES)) console.log(`    ${id.padEnd(6)} ${file}${has(file) ? '' : '   (missing)'}`);
    console.log('  runtime:    the runner canary');
    for (const s of STEPS()) console.log(`  command:    ${s.cmd} ${s.args.join(' ')}`);
    return;
  }

  checkBoundary();
  checkMigrationContent();
  checkReconcilerModel();
  checkNoStoredSwap();
  checkTd12();
  checkSuites();
  checkPremortem();
  checkBudgets();
  checkGuards();
  if (failures > 0) {
    console.error(`\nP3-S8 GATE: FAIL (${failures} structural violation${failures === 1 ? '' : 's'}) — not running the regression matrix`);
    process.exitCode = 1;
    return;
  }
  if (structuralOnly) {
    console.log('\nP3-S8 GATE: PASS (structural checks only)');
    return;
  }
  console.log('P3-S8 GATE — composed regression matrix');
  runnerReportsFailure();
  if (failures > 0) {
    console.error('\nP3-S8 GATE: FAIL — the test runner cannot report failure; refusing to run the regression matrix');
    process.exitCode = 1;
    return;
  }
  for (const step of STEPS()) {
    const started = Date.now();
    const res = spawnSync(step.cmd, [...step.args], { cwd: root, encoding: 'utf8', stdio: 'inherit', env: process.env });
    const ms = Date.now() - started;
    if (res.status !== 0) fail(step.area, `${step.name} failed (exit ${res.status ?? 'signal'}) after ${ms}ms`);
    else ok(`${step.name} (${ms}ms)`);
  }
  if (failures > 0) {
    console.error(`\nP3-S8 GATE: FAIL (${failures})`);
    process.exitCode = 1;
    return;
  }
  console.log('\nP3-S8 GATE: PASS');
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const rootFlag = argv.indexOf('--root');
  const root = rootFlag >= 0 ? resolve(argv[rootFlag + 1] ?? '.') : join(__dirname, '..');
  runGate(root, argv.includes('--list'), argv.includes('--structural-only'));
}
