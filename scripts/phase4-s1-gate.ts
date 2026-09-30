#!/usr/bin/env tsx
/**
 * PHASE 4 SLICE GATE — P4-S1 — `npm run gate:phase4:s1`
 * (docs/PHASE_4_EXECUTION_PLAN.md §5 and the P4-S1 section; lock §17.1
 * P4-AL-57, §17.2 P4-AL-60/61/62, §17.3 P4-AL-63/88, §17.4 G-02/G-03/G-07/G-19).
 *
 * The first Phase 4 gate. It composes `gate:phase3:corrective` — and through it
 * the whole accepted chain back to Phase 1 — plus the permanent core
 * (`check:migrations`, `check:guards`, `check:localization`,
 * `check:deployment-authority`) and the three prefix modules, and adds P4-S1's
 * own business: the Phase 4 migration boundary in two tenses, forward
 * evolution, the guards Phase 4 cannot inherit, composite-FK presence and
 * validity, the enumerated cross-tenant surface, the schema lint (G-19) and
 * numbering isolation (G-07, structural half).
 *
 * ── WHY THIS GATE EXISTS BEFORE `0074` DOES ──────────────────────────────
 *
 * `[[daftar-a-green-gate-must-prove-it-can-be-red]]`. DAFTAR's runner once
 * exited 0 over four failing tests, and a gate that reads a verdict out of an
 * exit status is worth nothing until that status has been shown to say no. So
 * this gate is written, and its refusals are exercised, BEFORE the first Phase 4
 * migration exists — while there is still nothing to be tempted to make green.
 *
 * Every check below is structurally able to run and to go red today. Some of
 * them have no subject yet, because their subject is a Phase 4 relation or a
 * Phase 4 route, and those report NOT-YET-APPLICABLE:
 *
 *   — `registered-by`, `composite-fk`, `schema-lint`, `numbering` become LIVE
 *     the moment a migration numbered past the inherited prefix exists on disk;
 *   — `cross-tenant` becomes LIVE the moment a controller serves a route under
 *     one of the Phase 4 prefixes.
 *
 * NOT-YET-APPLICABLE IS NOT A PASS. An inert check never prints `ok`, it is
 * named in every verdict line, and `INERT_ALLOWED` is a closed registry: a
 * check that goes inert without being listed there is a FAIL, and once its
 * subject exists the check is live with no edit to this file. That is the whole
 * mechanism that stops "not applicable yet" from silently becoming "fine".
 *
 * ── THE TWO TENSES, AND THE ONE CLOSURE RULE THIS FILE IS ALLOWED ────────
 *
 * `[[daftar-a-closure-rule-is-not-an-invariant]]`. `gate:phase2:release` once
 * said "nothing after 0052" and had to be corrected when `0053` landed. So:
 *
 *   — the PERMANENT invariant lives in `scripts/phase4-prefix.ts`, expresses
 *     `frozenThrough` as a FLOOR, and says nothing about files it does not know;
 *   — the CANDIDATE-TENSE boundary below — `frozenThrough` exactly at the
 *     previous head, the files after it exactly this slice's list, none of them
 *     in the manifest — is a closure rule about THIS open slice. P4-AL-61
 *     authorises it in the gate of the slice currently open and REQUIRES the
 *     acceptance commit to delete it. It is fenced between the two
 *     `CANDIDATE-TENSE` markers below and nowhere else in the Phase 4 estate,
 *     and `tests/security/phase4-forward-evolution.test.ts` holds that fence.
 *
 * AT ACCEPTANCE OF P4-S1, in one commit: fill `S1_ACCEPTED`, append the same
 * pairs to `PHASE4_S1_PREFIX` in `scripts/phase4-prefix.ts`, and DELETE the
 * fenced candidate-tense block. Nothing else about this gate changes.
 *
 * ── WHAT MAY NOT PASS SILENTLY ───────────────────────────────────────────
 *
 * Every required entry this gate names — a suite, a command, a red proof — is
 * either filled or `{ pending }`, and a pending entry is a structural FAIL,
 * never a skip (the `gate:phase3:corrective` form). A listed suite that is
 * missing, or that carries `.skip`, `.only` or `.todo`, fails; so does a
 * `p4-*` suite on disk that no entry lists, and so does a file in
 * `tests/golden-regression/phase4/` that no entry lists.
 *
 * TODAY THIS GATE IS RED, ON PURPOSE. The P4-S1 streams it names — the guard
 * arms, the per-phase browser step lists, the four goldens — have not landed,
 * and each unlanded row is a FAIL that says which stream owes it. That is the
 * gate working, not the gate broken.
 *
 * `--root <dir>` and `--structural-only` change WHERE the gate looks, never
 * WHAT it demands; a structural-only run reports no verdict on tests it did not
 * run. `--evidence=<file>` writes the machine-readable record.
 *
 * Usage: npm run gate:phase4:s1 [-- --list] [--root <dir> --structural-only] [--evidence=<file>]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PHASE2_PREFIX_END, checkPhase2Prefix } from './phase2-prefix';
import { PHASE3_PREFIX_END, checkPhase3Prefix } from './phase3-prefix';
import { PHASE4_INHERITED_PREFIX_END, PHASE4_S1_PREFIX, checkPhase4Prefix, frozenThroughFloor, phase4MigrationsOnDisk } from './phase4-prefix';
import { testTitles } from './phase3-s8-gate';

// ─────────────────────────────────────────────────────────────────────────
// What the coordinator and the owning streams fill. Every `pending` is a FAIL.
// ─────────────────────────────────────────────────────────────────────────

/** The head this slice builds on: the last inherited migration. Derived, so no number is written here. */
export const PREVIOUS_HEAD = PHASE4_INHERITED_PREFIX_END;

/**
 * The P4-S1 candidate migrations, in order, as the single migration owner names
 * them. Empty until they are written: an empty list is the absence of a
 * declared candidate, never a claim that the slice has no migration.
 */
export const S1_MIGRATIONS: readonly string[] = [];

/** The digests recorded at the P4-S1 freeze. Empty while the slice is a candidate; filling it flips the tense. */
export const S1_ACCEPTED: Readonly<Record<string, string>> = {};

/** An entry an owning stream has not delivered yet: a FAIL, never a skip. */
export interface Pending {
  readonly id: string;
  readonly area: string;
  readonly owner: string;
  readonly pending: string;
}

export interface SuiteEntry {
  readonly id: string;
  readonly area: string;
  /** `root`: the root Vitest configuration; `web`: apps/web/vitest.config.mts. */
  readonly runner: 'root' | 'web';
  readonly file: string;
  /**
   * `file` is a DIRECTORY handed to the runner whole, so a suite added to it
   * later is executed by existing rather than by somebody remembering to list
   * it. Every file inside is still checked, and the canary refuses a directory
   * that is empty or that holds a file the runner would not pick up.
   */
  readonly directory?: true;
}

export interface CommandEntry {
  readonly id: string;
  readonly area: string;
  readonly npmScript: string;
  readonly args: readonly string[];
}

export interface RedProof {
  readonly id: string;
  readonly defect: string;
  /** `<test file>::<it( title prefix>` — the test that shows this gate, or the guard, failing on the defect. */
  readonly proof: string;
}

export const isPending = (entry: object): entry is Pending => 'pending' in entry;

const FORWARD_EVOLUTION = 'tests/security/phase4-forward-evolution.test.ts';
/** The Phase 3 suite P4-AL-88 re-expresses: owned in P4-S1 by the authority owner, asserted about — never edited — here. */
const SETTLEMENT_S6 = 'tests/security/settlement-s6-no-customer-payments.test.ts';
const GOLDEN_DIR = 'tests/golden-regression/phase4';

/**
 * The guard red proofs live in their own directory, and NO gate and no npm
 * script reached it: `test:integration` runs `tests/integration tests/security`
 * and nothing else picks `tests/guards` up. So every planted-defect proof for
 * G-3, G-6 and the merchant-language rules would have been written, committed
 * and never executed — the exact shape of
 * `[[daftar-a-green-gate-must-prove-it-can-be-red]]`, one level up: not a
 * runner that cannot say no, but a proof nobody asked.
 *
 * This gate runs the DIRECTORY, never a list of names, so the next proof is
 * picked up by existing. `guardSuiteProblems` is the canary: the directory must
 * exist, hold at least one suite, and hold nothing the root runner would not
 * execute when handed the directory.
 */
const GUARD_SUITE_DIR = 'tests/guards';

/**
 * Every P4-S1 suite, by id. Exact: nothing is discovered, and every `p4-*`
 * suite on disk and every file under `tests/golden-regression/phase4/` must be
 * listed by one of these rows.
 */
export const S1_SUITES: readonly (SuiteEntry | Pending)[] = [
  // The permanent forward-evolution property (P4-AL-62): owned by this gate.
  { id: 'FE-01', area: 'forward-evolution', runner: 'root', file: FORWARD_EVOLUTION },
  // P4-AL-88: the re-expressed Phase 3 settlement suite. It is composed here
  // because `gate:phase3:corrective` composes it; the row makes that visible.
  { id: 'P3C-88', area: 'phase3-coupling', runner: 'root', file: SETTLEMENT_S6 },
  // The guard arms of the six pre-migration actions (execution plan, P4-S1 §2,
  // §3) and their planted defects: the whole of `tests/guards`, by directory.
  { id: 'GD-01', area: 'guard-proofs', runner: 'root', file: GUARD_SUITE_DIR, directory: true },
  // The permission-default authority of action 4 (OD-P4-01 A): the Phase 4 key
  // set, the sensitivity vector, the delegation ceiling, the audited backfill,
  // and the phase scoping of the registry assertions that action 7 rewrote.
  // Named file by file rather than by directory: they live in tests/security
  // beside the accepted estate, so a directory row there would claim suites
  // this slice does not own.
  { id: 'PD-01', area: 'permissions', runner: 'root', file: 'tests/security/phase4-permission-defaults.test.ts' },
  { id: 'PD-02', area: 'permissions', runner: 'root', file: 'tests/security/phase4-registry-phase-scoping.test.ts' },
  // The four P4-S1 goldens (lock §17.4; execution plan P4-S1 Exit).
  {
    id: 'G-02',
    area: 'golden',
    owner: 'the golden owner',
    pending: `GOLD-20 cross-tenant, enumerated from the route surface, under ${GOLDEN_DIR}/`,
  },
  { id: 'G-03', area: 'golden', owner: 'the golden owner', pending: `GOLD-30 cross-business FK manipulation refused by the database, under ${GOLDEN_DIR}/` },
  { id: 'G-07', area: 'golden', owner: 'the golden owner', pending: `GOLD-48 invoice sequence isolation (structural half), under ${GOLDEN_DIR}/` },
  { id: 'G-19', area: 'golden', owner: 'the golden owner', pending: `GOLD-74 schema lint, under ${GOLDEN_DIR}/` },
];

/** The permanent core, run as commands after the predecessor gate. */
export const S1_COMMANDS: readonly (CommandEntry | Pending)[] = [
  { id: 'CORE-MIG', area: 'core', npmScript: 'check:migrations', args: [] },
  { id: 'CORE-GUARD', area: 'core', npmScript: 'check:guards', args: [] },
  { id: 'CORE-L10N', area: 'core', npmScript: 'check:localization', args: [] },
  { id: 'CORE-DEPLOY', area: 'core', npmScript: 'check:deployment-authority', args: [] },
];

/** The predecessor this gate composes, and through it the whole accepted chain. */
export const PREDECESSOR_SCRIPT = 'gate:phase3:corrective';

/**
 * One row per defect this gate claims to catch. A pending row is a FAIL: a
 * check whose red proof is not wired is a claim, not a test (P4-AL-67).
 */
export const RED_PROOFS: readonly (RedProof | Pending)[] = [
  {
    id: 'RP-FORWARD',
    defect: 'an accepted gate forbids forward evolution ("nothing after N"), so an authorized successor migration turns it red',
    proof: `${FORWARD_EVOLUTION}::a gate that forbids a successor migration is named`,
  },
  {
    id: 'RP-FLOOR',
    defect: 'frozenThrough retreats below the accepted history, or the prefix is compared for equality instead of as a floor',
    proof: `${FORWARD_EVOLUTION}::a retreating frozenThrough is refused`,
  },
  {
    id: 'RP-SHAPE',
    defect: 'a permanent gate carries one of the three forbidden shapes: a .sql count against a literal, a last-file-name comparison, a frozenThrough equality',
    proof: `${FORWARD_EVOLUTION}::the forbidden shapes are absent from every permanent gate`,
  },
  {
    id: 'RP-P3CLAIM',
    defect: 'an accepted permanent Phase 3 suite makes a claim about the future, so the first Phase 4 relation or route turns an accepted Phase 3 gate red',
    proof: `${FORWARD_EVOLUTION}::a Phase 3 suite that claims the future is named`,
  },
  {
    id: 'RP-TENSE',
    defect: 'a candidate-tense boundary assertion escapes the gate of the slice currently open and becomes a permanent closure rule',
    proof: `${FORWARD_EVOLUTION}::the candidate tense is fenced inside the open slice gate`,
  },
  {
    id: 'RP-G3',
    area: 'guards',
    owner: 'the guard owner',
    pending: 'the planted authoritative balance column (invoices.paid_minor) that the G-3 sales arm must name',
  },
  {
    id: 'RP-JARGON',
    area: 'guards',
    owner: 'the guard owner',
    pending: 'the planted accountant word on a Phase 4 screen, and the planted tax control, that the widened guard must name',
  },
  {
    id: 'RP-STEPS',
    area: 'browser',
    owner: 'the browser owner (tests/browser/flows.ts)',
    pending: 'the planted duplicate step name, and a Phase 4 screen defect that must NOT turn gate:phase3:corrective red',
  },
  { id: 'RP-FK', area: 'composite-fk', owner: 'the golden owner (G-03)', pending: 'the planted single-column FK to a business-scoped parent' },
  { id: 'RP-LINT', area: 'schema-lint', owner: 'the golden owner (G-19)', pending: 'the planted constraint naming a column that does not exist' },
  { id: 'RP-SEQ', area: 'numbering', owner: 'the golden owner (G-07)', pending: 'the planted global sequence behind a document number' },
  {
    id: 'RP-XTENANT',
    area: 'cross-tenant',
    owner: 'the golden owner (G-02)',
    pending: 'the planted Phase 4 route with no cross-tenant case, which the enumeration must name',
  },
];

// ─────────────────────────────────────────────────────────────────────────
// The Phase 4 surface this gate reasons about. All of it is vocabulary, not a
// count: adding a route group or a relation cannot escape by arithmetic.
// ─────────────────────────────────────────────────────────────────────────

/** The route prefixes Phase 4 serves (lock §16, P4-AL-88's route list). A controller under one of these is a Phase 4 route. */
export const PHASE4_ROUTE_PREFIXES: readonly string[] = [
  '/v1/pos',
  '/v1/customers',
  '/v1/sales',
  '/v1/invoices',
  '/v1/payments',
  '/v1/refunds',
  '/v1/credit-notes',
  '/v1/customer-credits',
  '/v1/installments',
  '/v1/installment-plans',
  '/v1/debts',
  '/v1/statements',
];

/** The merchant key namespaces Phase 4 adds; the jargon guard and the tax rule must reach every one (action 3). */
export const PHASE4_KEY_NAMESPACES: readonly string[] = ['pos.', 'sales.', 'customers.', 'invoices.', 'refunds.', 'installments.', 'debts.'];

/** A Phase 4 web file the widened merchant-jargon scope must examine (action 3; `isS7WebFile` reaches none of these today). */
export const PHASE4_WEB_FILE = 'apps/web/src/app/[locale]/pos/page.tsx';

/** The four accepted registries whose `registered_by` CHECK must be widened before the first Phase 4 registration (action 1). */
export const REGISTERED_BY_RELATIONS: readonly string[] = [
  'inventory_operation_kinds',
  'stock_movement_kinds',
  'stock_source_types',
  'inventory_operation_movement_kinds',
];
export const REGISTERED_BY_WIDENED = '^P[0-9]+-S[0-9]+$';
export const REGISTERED_BY_PHASE3_ONLY = '^P3-S[0-9]+$';

/**
 * The G-3 sales arm, as a behaviour rather than a naming: the guard module,
 * run over this DDL, must name every column in `mustFlag` and none in
 * `mustNotFlag`. The plan records that today it flags only
 * `customers.balance_minor`.
 */
export const DERIVED_TRUTH_FIXTURE = {
  ddl: [
    'CREATE TABLE customers (id uuid, business_id uuid, balance_minor BIGINT, amount_due_minor BIGINT, credit_limit_minor BIGINT);',
    'CREATE TABLE invoices (id uuid, business_id uuid, total_minor BIGINT, paid_minor BIGINT, outstanding_minor BIGINT);',
    'CREATE TABLE installments (id uuid, business_id uuid, amount_minor BIGINT, outstanding_minor BIGINT, settled_minor BIGINT);',
  ].join('\n'),
  tables: ['customers', 'invoices', 'installments'],
  mustFlag: [
    'customers.balance_minor',
    'customers.amount_due_minor',
    'invoices.paid_minor',
    'invoices.outstanding_minor',
    'installments.outstanding_minor',
    'installments.settled_minor',
  ],
  /** A stored fact of the document and a policy input are not derived truth; a guard that flags these asserts nothing. */
  mustNotFlag: ['invoices.total_minor', 'customers.credit_limit_minor', 'installments.amount_minor'],
} as const;

/** The contract the guard owner delivers, mirroring the accepted supplier arm (`discoverSupplierTables` / `findAuthoritativeSupplierColumns`). */
const GUARD_MODULE = 'scripts/guards/no-authoritative-balance.ts';
const GUARD_SALES_EXPORT = 'findAuthoritativeSalesColumns';
const JARGON_MODULE = 'scripts/guards/merchant-jargon.ts';

/** P4-AL-63: what `tests/browser/flows.ts` must export before the first Phase 4 browser step exists. */
const FLOWS = 'tests/browser/flows.ts';
const PHASE3_GATE = 'scripts/phase3-corrective-gate.ts';
export const PHASE3_STEP_COUNT = 15;
export const PHASE4_STEP_PREFIX = 'p4-';

/** The business-scoped parents a Phase 4 FK must reach through a COMPOSITE key (G-03). */
export const BUSINESS_SCOPED_PARENTS: readonly string[] = [
  'customers',
  'invoices',
  'payment_methods',
  'warehouses',
  'credit_notes',
  'installment_plans',
  'sales',
  'payments',
  'product_variants',
  'branches',
];

/** The Phase 4 financial core: the relations a polymorphic FK may never appear on (G-19). */
export const FINANCIAL_CORE =
  /^(sales|sale_items|invoices|invoice_items|payments|payment_allocations|payment_reversals|allocation_reversals|refunds|credit_notes|credit_note_items|customer_credits|customer_credit_applications|installment_plans|installments)$/;

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

const read = (root: string, rel: string): string => readFileSync(join(root, rel), 'utf8');
const has = (root: string, rel: string): boolean => existsSync(join(root, rel));
const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
const migrationsDir = (root: string): string => join(root, 'infrastructure/database/migrations');
const manifestPath = (root: string): string => join(root, 'infrastructure/database/MIGRATION_MANIFEST.json');

const SKIP = /\b(?:it|test|describe|suite)\.(?:skip|only|todo|skipIf|runIf)\b|\bx(?:it|describe)\s*\(|RELEASE_GATE_SKIP_/;
const stripTsProse = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
const QUOTED = /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g;
/** SQL with `--` and block comments removed, so a rule never fires on prose. */
const stripSql = (sql: string): string => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, '');

interface Manifest {
  readonly frozenThrough: string;
  readonly migrations: readonly { readonly name: string; readonly sha256: string }[];
}

const manifest = (root: string): Manifest => JSON.parse(readFileSync(manifestPath(root), 'utf8')) as Manifest;

/** The Phase 4 migration files under `root`, in order. The subject of every `phase4-migration` check. */
export const phase4Migrations = (root: string): string[] => phase4MigrationsOnDisk(migrationsDir(root));

/** The Phase 4 DDL under `root`: every Phase 4 migration, comment-stripped, concatenated in order. */
export function phase4Sql(root: string): string {
  return phase4Migrations(root)
    .map((f) => stripSql(readFileSync(join(migrationsDir(root), f), 'utf8')))
    .join('\n');
}

// ── A narrow DDL reader ─────────────────────────────────────────────────────
//
// Regex, not a parser, and deliberately narrow: it reads `CREATE TABLE name (
// … );` bodies by balancing parentheses, and splits a body at depth-1 commas.
// A construct it cannot read is REPORTED, never skipped — `unreadable` below —
// because a lint that silently ignores what it does not understand is a lint
// that passes on the defect it exists to catch.

export interface TableDdl {
  readonly name: string;
  readonly columns: readonly string[];
  /** Depth-1 items that begin with a constraint keyword, plus the constraints added by later ALTERs. */
  readonly constraints: readonly string[];
  readonly body: string;
}

const CONSTRAINT_START = /^(CONSTRAINT\b|PRIMARY\s+KEY\b|UNIQUE\b|FOREIGN\s+KEY\b|CHECK\b|EXCLUDE\b|LIKE\b)/i;

function splitTopLevel(body: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      items.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') items.push(current.trim());
  return items;
}

export function readTables(sql: string): { tables: TableDdl[]; unreadable: string[] } {
  const tables: TableDdl[] = [];
  const unreadable: string[] = [];
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(/gi;
  for (const m of sql.matchAll(re)) {
    const name = (m[1] ?? '').toLowerCase();
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    while (i < sql.length && depth > 0) {
      if (sql[i] === '(') depth += 1;
      else if (sql[i] === ')') depth -= 1;
      i += 1;
    }
    if (depth !== 0) {
      unreadable.push(`CREATE TABLE ${name}: its body is not balanced, so this gate cannot read it`);
      continue;
    }
    const body = sql.slice((m.index ?? 0) + m[0].length, i - 1);
    const items = splitTopLevel(body);
    const columns: string[] = [];
    const constraints: string[] = [];
    for (const item of items) {
      if (CONSTRAINT_START.test(item)) {
        constraints.push(item);
        continue;
      }
      const col = /^"?([a-z_][a-z0-9_]*)"?\s/i.exec(item);
      if (col) {
        columns.push((col[1] ?? '').toLowerCase());
        if (/\b(?:REFERENCES|UNIQUE|CHECK|PRIMARY\s+KEY)\b/i.test(item)) constraints.push(`${col[1] ?? ''} ${item}`);
        continue;
      }
      unreadable.push(`${name}: this gate cannot read the table item "${item.slice(0, 60)}"`);
    }
    tables.push({ name, columns, constraints, body });
  }
  for (const m of sql.matchAll(/ALTER\s+TABLE\s+(?:ONLY\s+)?([a-z_][a-z0-9_]*)\s+ADD\s+(CONSTRAINT[\s\S]*?);/gi)) {
    const name = (m[1] ?? '').toLowerCase();
    const table = tables.find((t) => t.name === name);
    if (table) (table.constraints as string[]).push(m[2] ?? '');
  }
  return { tables, unreadable };
}

/** The identifiers of a parenthesised column list, plus any quoted literal found inside it. */
function columnList(text: string): { columns: string[]; literals: string[] } {
  const inner = /\(([^()]*)\)/.exec(text)?.[1] ?? '';
  const literals = [...inner.matchAll(/'([^']*)'/g)].map((m) => m[0]);
  const columns = inner
    .replace(/'[^']*'/g, ' ')
    .split(',')
    .map((c) => c.trim().replace(/^"|"$/g, '').toLowerCase())
    .filter((c) => /^[a-z_][a-z0-9_]*$/.test(c));
  return { columns, literals };
}

/**
 * Words inside a CHECK expression that look like column references: lower-case
 * identifiers that are not a SQL word, not a function call and not a cast
 * target. The keyword list is curated; a false positive is answered by
 * extending it, never by turning the rule off.
 */
const SQL_WORDS = new Set(
  (
    'and or not null is in between like ilike similar to escape true false case when then else end exists any all some cast as ' +
    'current_date current_timestamp now localtimestamp interval date timestamp timestamptz time numeric decimal integer int bigint smallint ' +
    'boolean text uuid jsonb json bytea char varchar real double precision serial bigserial array row unknown default value new old ' +
    'coalesce nullif greatest least abs round trunc floor ceil ceiling length char_length octet_length lower upper btrim trim ltrim rtrim ' +
    'substring position strpos overlay left right regexp_replace regexp_match split_part to_char to_number to_date to_timestamp ' +
    'extract age date_trunc make_date jsonb_typeof jsonb_array_length jsonb_object_keys num_nonnulls num_nulls sign mod div'
  ).split(/\s+/),
);

function checkExpressionColumns(expression: string): string[] {
  const text = expression.replace(/'[^']*'/g, ' ').replace(/"([a-z_][a-z0-9_]*)"/gi, '$1');
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![\w."])([a-z_][a-z0-9_]*)\b(\s*\()?/g)) {
    const word = (m[1] ?? '').toLowerCase();
    if (m[2] !== undefined) continue; // a function call
    if (SQL_WORDS.has(word)) continue;
    out.add(word);
  }
  return [...out];
}

// ─────────────────────────────────────────────────────────────────────────
// The checks. Each takes the root it looks at and returns its problems.
// ─────────────────────────────────────────────────────────────────────────

/** The three prefix modules, in process: the inherited history is intact and Phase 4's floor holds (P4-AL-60). */
export function prefixProblems(root: string): string[] {
  return [
    ...checkPhase2Prefix(migrationsDir(root), manifestPath(root)).map((p) => `Phase 2 prefix: ${p}`),
    ...checkPhase3Prefix(migrationsDir(root), manifestPath(root)).map((p) => `Phase 3 prefix: ${p}`),
    ...checkPhase4Prefix(migrationsDir(root), manifestPath(root)).map((p) => `Phase 4 prefix: ${p}`),
  ];
}

/**
 * The P4-S1 migration boundary, in the tense `accepted` names (P4-AL-61).
 *
 * ACCEPTED is the permanent half and is a floor. The CANDIDATE half is the one
 * closure rule this file is allowed, and the acceptance commit deletes it.
 */
export function boundaryProblems(
  root: string,
  accepted: Readonly<Record<string, string>> = S1_ACCEPTED,
  declared: readonly string[] = S1_MIGRATIONS,
): string[] {
  const problems: string[] = [];
  const candidate = Object.keys(accepted).length === 0;
  const m = manifest(root);
  const recorded = new Map(m.migrations.map((e) => [e.name, e.sha256]));
  const after = phase4Migrations(root);

  if (candidate) {
    // ───────────────────────── CANDIDATE-TENSE (P4-AL-61) ─────────────────────────
    // Deleted by the P4-S1 acceptance commit, together with this fence. It is a
    // closure rule about ONE OPEN SLICE and it may never be copied into a
    // permanent gate or into scripts/phase4-prefix.ts.
    if (JSON.stringify(after) !== JSON.stringify([...declared]))
      problems.push(
        `while P4-S1 is a candidate the migrations after ${PREVIOUS_HEAD} are exactly S1_MIGRATIONS (${declared.join(', ') || 'none declared'}) — found ${after.join(', ') || 'none'}`,
      );
    if (m.frozenThrough !== PREVIOUS_HEAD)
      problems.push(`frozenThrough is ${m.frozenThrough} — a P4-S1 candidate sits exactly on the inherited head ${PREVIOUS_HEAD}`);
    for (const name of after) if (recorded.has(name)) problems.push(`${name} is in the manifest before gate:phase4:s1 passed — premature freeze`);
    // ─────────────────────── end CANDIDATE-TENSE (P4-AL-61) ───────────────────────
    return problems;
  }

  const last = declared[declared.length - 1] ?? PREVIOUS_HEAD;
  if (JSON.stringify(after.slice(0, declared.length)) !== JSON.stringify([...declared]))
    problems.push(
      `the migrations after ${PREVIOUS_HEAD} begin with S1_MIGRATIONS (${declared.join(', ')}) — found ${after.slice(0, declared.length).join(', ') || 'none'}`,
    );
  if (JSON.stringify(Object.keys(accepted).sort()) !== JSON.stringify([...declared].sort()))
    problems.push(`S1_ACCEPTED must name exactly S1_MIGRATIONS (${declared.join(', ')})`);
  // A FLOOR: a later Phase 4 slice freezing further ahead is that slice doing its job.
  if (!(m.frozenThrough >= last)) problems.push(`frozenThrough is ${m.frozenThrough} — it is a floor at ${last} once P4-S1 is accepted`);
  for (const [name, digest] of Object.entries(accepted)) {
    const path = join(migrationsDir(root), name);
    if (!existsSync(path)) {
      problems.push(`${name} was accepted but is missing`);
      continue;
    }
    const onDisk = sha256(path);
    if (onDisk !== digest) problems.push(`${name} hashes to ${onDisk.slice(0, 12)}… but was accepted at ${digest.slice(0, 12)}…`);
    if (recorded.get(name) !== digest) problems.push(`${name} is not frozen in the manifest at its accepted digest`);
  }
  // The same acceptance commit appends the same pairs to the permanent module.
  const inPrefix = PHASE4_S1_PREFIX.map(([name, digest]) => `${name}:${digest}`).join('\n');
  const expected = [...declared].map((name) => `${name}:${accepted[name] ?? ''}`).join('\n');
  if (inPrefix !== expected)
    problems.push(`PHASE4_S1_PREFIX in scripts/phase4-prefix.ts does not hold exactly the accepted P4-S1 pairs — the acceptance commit fills both`);
  return problems;
}

/** Every pending entry is a FAIL: the gate is red until the owning stream delivers. */
export function pendingProblems(): string[] {
  const rows: readonly object[] = [...S1_SUITES, ...S1_COMMANDS, ...RED_PROOFS];
  return rows.filter(isPending).map((p) => `${p.id} (${p.area}) is not filled — ${p.owner} owes it: ${p.pending}`);
}

/** Every test file directly inside `dir`, sorted. Whatever extension it carries: a file the runner would not pick up is a finding, not an omission. */
export function suitesIn(root: string, dir: string): string[] {
  if (!has(root, dir)) return [];
  return readdirSync(join(root, dir))
    .filter((f) => /\.(test|spec)\.[tj]sx?$/.test(f))
    .sort()
    .map((f) => `${dir}/${f}`);
}

/**
 * The canary on the guard red proofs. `tests/guards` was reached by no gate and
 * no npm script, so a planted-defect proof written there was never executed.
 * This refuses:
 *
 *   — the directory missing, or holding no suite at all — a gate that runs an
 *     empty directory proves nothing, and vitest's own "no test files found"
 *     would be the only sign;
 *   — a file in it the ROOT runner would not execute when handed the directory:
 *     `vitest.config.ts` includes `tests/**\/*.test.ts`, so a `.test.tsx` or a
 *     `.spec.ts` there is a proof that silently never runs;
 *   — the plan not naming the directory, which is the failure this canary is
 *     named after.
 */
export function guardSuiteProblems(root: string): string[] {
  const problems: string[] = [];
  const wired = s1Plan().some((s) => s.args.includes(GUARD_SUITE_DIR));
  if (!wired) problems.push(`no step of this gate runs ${GUARD_SUITE_DIR} — the guard red proofs would be committed and never executed`);
  if (!has(root, GUARD_SUITE_DIR))
    return [...problems, `${GUARD_SUITE_DIR} is missing — the guard owner's planted-defect proofs for G-3, G-6 and the merchant-language rules live there`];
  const suites = suitesIn(root, GUARD_SUITE_DIR);
  if (suites.length === 0) problems.push(`${GUARD_SUITE_DIR} holds no suite — this gate would hand the runner an empty directory and call the result a pass`);
  const include = has(root, 'vitest.config.ts') ? read(root, 'vitest.config.ts') : '';
  if (!include.includes("'tests/**/*.test.ts'"))
    problems.push(
      `vitest.config.ts no longer includes tests/**/*.test.ts — this gate hands ${GUARD_SUITE_DIR} to the root runner and relies on that pattern to pick every proof up`,
    );
  for (const suite of suites)
    if (!suite.endsWith('.test.ts'))
      problems.push(
        `${suite} is not matched by the root runner's include (tests/**/*.test.ts), so handing it the directory would not execute it — rename it .test.ts`,
      );
  return problems;
}

/** The listed suites exist and do not skip; every `p4-*` suite and every Phase 4 golden on disk is listed; ids are unique. */
export function suiteProblems(root: string): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const e of [...S1_SUITES, ...S1_COMMANDS, ...RED_PROOFS]) {
    if (ids.has(e.id)) problems.push(`${e.id} is listed twice`);
    ids.add(e.id);
  }
  const files = S1_SUITES.filter((e): e is SuiteEntry => !isPending(e));
  for (const e of files) {
    if (!has(root, e.file)) {
      problems.push(`${e.id} ${e.file} is missing`);
      continue;
    }
    if ((e.runner === 'web') !== e.file.startsWith('apps/web/test/')) problems.push(`${e.id} ${e.file} is not a ${e.runner} suite`);
    for (const file of e.directory === true ? suitesIn(root, e.file) : [e.file]) {
      const hit = SKIP.exec(stripTsProse(read(root, file)).replace(QUOTED, "''"));
      if (hit) problems.push(`${e.id} ${file} contains ${hit[0]} — no Phase 4 suite skips`);
    }
  }
  problems.push(...guardSuiteProblems(root));
  const listed = new Set(files.map((e) => e.file));
  for (const dir of ['tests/integration', 'tests/security', 'tests/performance']) {
    if (!has(root, dir)) continue;
    for (const f of readdirSync(join(root, dir)).sort())
      if (/^(?:p4|phase4)-.*\.test\.ts$/.test(f) && !listed.has(`${dir}/${f}`)) problems.push(`${dir}/${f} is a Phase 4 suite no S1_SUITES entry lists`);
  }
  if (has(root, GOLDEN_DIR))
    for (const f of readdirSync(join(root, GOLDEN_DIR)).sort())
      if (f.endsWith('.test.ts') && !listed.has(`${GOLDEN_DIR}/${f}`)) problems.push(`${GOLDEN_DIR}/${f} is a Phase 4 golden no S1_SUITES entry lists`);
  return problems;
}

/** Every command, and the predecessor gate, name an npm script that exists. */
export function commandProblems(root: string): string[] {
  const problems: string[] = [];
  const scripts = (JSON.parse(read(root, 'package.json')) as { scripts?: Record<string, string> }).scripts ?? {};
  for (const c of S1_COMMANDS) {
    if (isPending(c)) continue;
    if (typeof scripts[c.npmScript] !== 'string') problems.push(`${c.id}: package.json has no script ${c.npmScript}`);
  }
  if (typeof scripts[PREDECESSOR_SCRIPT] !== 'string') problems.push(`package.json has no script ${PREDECESSOR_SCRIPT} — this gate composes it`);
  for (const own of ['phase4-prefix', 'gate:phase4:s1'])
    if (typeof scripts[own] !== 'string') problems.push(`package.json has no script ${own} — a gate nobody can run is not a gate`);
  return problems;
}

/** Every red proof is filled and resolves to a real `it(` title (P4-AL-67). */
export function redProofProblems(root: string): string[] {
  const problems: string[] = [];
  for (const row of RED_PROOFS) {
    if (isPending(row)) continue;
    const [file = '', prefix = ''] = row.proof.split('::');
    if (prefix.trim() === '') {
      problems.push(`${row.id}: ${row.proof} names no title`);
      continue;
    }
    if (!has(root, file)) {
      problems.push(`${row.id}: ${file} does not exist`);
      continue;
    }
    if (!testTitles(read(root, file)).some((t) => t.startsWith(prefix))) problems.push(`${row.id}: no it( title in ${file} starts with "${prefix}"`);
  }
  return problems;
}

/**
 * The guards Phase 4 cannot inherit (actions 2 and 3), asserted as BEHAVIOUR:
 * the accepted guard modules are loaded and run over fixtures, so the check
 * survives any internal refactor of the guards and fails only when the
 * protection is genuinely absent.
 */
export function guardProblems(root: string): string[] {
  const problems: string[] = [];
  if (!has(root, GUARD_MODULE)) problems.push(`${GUARD_MODULE} is missing`);
  else {
    /* eslint-disable-next-line @typescript-eslint/no-require-imports */
    const guard = require(join(root, GUARD_MODULE)) as Record<string, unknown>;
    const find = guard[GUARD_SALES_EXPORT];
    if (typeof find !== 'function')
      problems.push(
        `${GUARD_MODULE} exports no ${GUARD_SALES_EXPORT}(sql, tables) — guard G-3 has no sales arm, so nothing stops a Phase 4 migration storing an authoritative balance (lock P4-AL-06, plan action 2)`,
      );
    else {
      const findings = (find as (sql: string, tables: readonly string[]) => { table?: string; column?: string }[])(
        DERIVED_TRUTH_FIXTURE.ddl,
        DERIVED_TRUTH_FIXTURE.tables,
      );
      const flagged = new Set(findings.map((f) => `${f.table ?? ''}.${f.column ?? ''}`));
      for (const want of DERIVED_TRUTH_FIXTURE.mustFlag)
        if (!flagged.has(want)) problems.push(`the G-3 sales arm does not flag ${want} — it is an authoritative stored balance (P4-AL-06)`);
      for (const no of DERIVED_TRUTH_FIXTURE.mustNotFlag)
        if (flagged.has(no))
          problems.push(
            `the G-3 sales arm flags ${no}, which is a stored fact of the document and not derived truth — a guard that flags everything asserts nothing`,
          );
    }
  }
  if (!has(root, JARGON_MODULE)) problems.push(`${JARGON_MODULE} is missing`);
  else {
    /* eslint-disable-next-line @typescript-eslint/no-require-imports */
    const jargon = require(join(root, JARGON_MODULE)) as {
      findMerchantJargon?: (catalogs: Record<string, Record<string, string>>) => unknown[];
      findS7SourceViolations?: (files: Record<string, string>) => unknown[];
    };
    const catalogue = jargon.findMerchantJargon;
    if (typeof catalogue !== 'function') problems.push(`${JARGON_MODULE} exports no findMerchantJargon`);
    else {
      for (const ns of PHASE4_KEY_NAMESPACES) {
        const hits = catalogue({ en: { [`${ns}title`]: 'Journal ledger' } });
        if (hits.length === 0)
          problems.push(
            `the merchant-jargon guard does not examine the ${ns}* key namespace — a Phase 4 screen may ship the accountant's words (plan action 3)`,
          );
      }
      if (catalogue({ en: { 'accounting.title': 'Journal ledger' } }).length !== 0)
        problems.push(
          `the merchant-jargon guard examines accounting.* keys — that namespace IS the accountant chart, and widening the scope must not swallow it`,
        );
    }
    const source = jargon.findS7SourceViolations;
    if (typeof source !== 'function') problems.push(`${JARGON_MODULE} exports no findS7SourceViolations`);
    else if (source({ [PHASE4_WEB_FILE]: '<p>Ledger</p>' }).length === 0)
      problems.push(`the merchant-jargon source scope does not examine ${PHASE4_WEB_FILE} — a pos/ or customers/ file is never examined today (plan action 3)`);
  }
  problems.push(...readSurfaceCoverageProblems(root));
  problems.push(...derivedTruthCitationProblems(root));
  return problems;
}

/**
 * G-6 must reach a Phase 4 read module, and it must reach it by SHAPE.
 *
 * `READ_SURFACE` was a path regex naming `accounting-reports`,
 * `inventory-reads.ts` and `supplier-balance-reads.ts`, so a Phase 4 read
 * module was never examined and an `OFFSET` or a `Number()` on money would
 * ship green. The probes below are read modules in context directories that do
 * not exist in the tree: they cannot be satisfied by adding a name, only by a
 * rule about a module's shape. `apps/api/src/modules/<context>/<name>-reads.ts`
 * is that rule.
 *
 * The accepted exclusions are asserted from the same side, so widening the rule
 * cannot quietly swallow them: `purchasing-reads.ts` holds S6's command-side FX
 * binding and must stay OFF the surface
 * (`tests/integration/static-guards-s7.test.ts:141`), and a controller or a
 * service is not a read module.
 */
export function readSurfaceCoverageProblems(root: string): string[] {
  const module = 'scripts/guards/read-surface.ts';
  if (!has(root, module)) return [`${module} is missing`];
  /* eslint-disable-next-line @typescript-eslint/no-require-imports */
  const guard = require(join(root, module)) as { READ_SURFACE?: RegExp };
  const surface = guard.READ_SURFACE;
  if (!(surface instanceof RegExp)) return [`${module} exports no READ_SURFACE pattern this gate can probe`];
  const problems: string[] = [];
  // A read module in a context nobody has created yet. If the surface misses
  // one of these it is still a name list, however it is spelled.
  for (const context of ['selling', 'sales', 'pos', 'receivables', 'invoices', 'customers', 'debts', 'installments'])
    if (!surface.test(`apps/api/src/modules/${context}/${context}-reads.ts`))
      problems.push(
        `guard G-6's READ_SURFACE does not reach apps/api/src/modules/${context}/${context}-reads.ts — a Phase 4 read module is never examined, so an OFFSET or a Number() on money would ship green (G-6; the surface must be a rule about a module's shape, not a list of paths)`,
      );
  for (const [path, why] of [
    [
      'apps/api/src/modules/purchasing/purchasing-reads.ts',
      "it holds S6's command-side FX binding and static-guards-s7.test.ts:141 requires it OFF the surface",
    ],
    ['apps/api/src/modules/selling/sales-reads.controller.ts', 'a controller is not a read module'],
    ['apps/api/src/modules/selling/sales-movements.service.ts', 'a service is not a read module'],
  ] as const)
    if (surface.test(path))
      problems.push(`guard G-6's READ_SURFACE now matches ${path}, and ${why} — widening the rule must not swallow the accepted exclusions`);
  return problems;
}

/**
 * The complement arm of G-3 returns the Phase 4 relations too, so its finding
 * must cite the decision that governs a stored receivable. `static-guards.ts`
 * is this gate's own file; the assertion keeps the correction from being
 * reverted silently, since a wrong citation sends the next reader to a decision
 * about the stock ledger.
 */
export function derivedTruthCitationProblems(root: string): string[] {
  const file = 'scripts/static-guards.ts';
  if (!has(root, file)) return [`${file} is missing`];
  const code = read(root, file);
  if (!/P4-AL-06/.test(code))
    return [
      `${file} reports a derived-truth finding without a Phase 4 citation — a receivable column failing under P3-AL-49 sends the reader to a decision about the stock ledger`,
    ];
  return [];
}

/**
 * P4-AL-63: the two Phase 3 browser couplings, resolved before the first
 * Phase 4 step exists. `tests/browser/flows.ts` is NOT this gate's file; this
 * check states the contract it must satisfy and refuses until it does.
 */
export function browserStepProblems(root: string): string[] {
  const problems: string[] = [];
  if (!has(root, FLOWS)) return [`${FLOWS} is missing`];
  const flows = stripTsProse(read(root, FLOWS));
  const list = (name: string): string[] | null => {
    const m = new RegExp(`export const ${name}\\b[^=]*=\\s*\\[([^\\]]*)\\]`).exec(flows);
    return m ? [...(m[1] ?? '').matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => x[1] ?? x[2] ?? '') : null;
  };
  const p3 = list('PHASE3_STEPS');
  const p4 = list('PHASE4_STEPS');
  if (p3 === null)
    problems.push(
      `${FLOWS} exports no PHASE3_STEPS — ${PHASE3_GATE}:507-513 runs the browser matrix with no --steps, so the first Phase 4 step would make a Phase 4 screen defect turn an accepted PHASE 3 gate red (P4-AL-63)`,
    );
  if (p4 === null) problems.push(`${FLOWS} exports no PHASE4_STEPS — the Phase 4 gates cannot name the steps they own (P4-AL-63)`);
  if (p3 !== null && p3.length !== PHASE3_STEP_COUNT)
    problems.push(
      `PHASE3_STEPS holds ${p3.length} names; the accepted Phase 3 matrix is exactly ${PHASE3_STEP_COUNT} steps, and pinning the Phase 3 gate to a different list changes accepted coverage`,
    );
  if (p3 !== null && p4 !== null) {
    const shared = p3.filter((s) => p4.includes(s));
    if (shared.length > 0)
      problems.push(
        `PHASE3_STEPS and PHASE4_STEPS share ${shared.join(', ')} — flows.ts:275 already has a step named "return", and a duplicate name is run by --steps=<PHASE3_STEPS> and collides in the evidence (P4-AL-68)`,
      );
  }
  for (const step of p4 ?? [])
    if (!step.startsWith(PHASE4_STEP_PREFIX))
      problems.push(`the Phase 4 browser step "${step}" is not ${PHASE4_STEP_PREFIX}-prefixed, so it can collide with a Phase 3 step name (P4-AL-68)`);
  const steps = new Set([...(p3 ?? []), ...(p4 ?? [])]);
  const declared = [...flows.matchAll(/run\.step\(\s*'([^']+)'/g)].map((m) => m[1] ?? '');
  for (const s of declared) if (steps.size > 0 && !steps.has(s)) problems.push(`${FLOWS} runs the step "${s}" that neither exported list names`);
  const counts = new Map<string, number>();
  for (const s of declared) counts.set(s, (counts.get(s) ?? 0) + 1);
  for (const [s, n] of counts) if (n > 1) problems.push(`${FLOWS} declares the step "${s}" ${n} times — run.step refuses a duplicate name (P4-AL-68)`);
  if (!has(root, PHASE3_GATE)) problems.push(`${PHASE3_GATE} is missing`);
  else if (!/--steps=/.test(stripTsProse(read(root, PHASE3_GATE))))
    problems.push(
      `${PHASE3_GATE} still runs the browser matrix with no --steps — it must be pinned to PHASE3_STEPS before the first Phase 4 step exists (P4-AL-63). It is an ACCEPTED gate: the coordinator authorises that edit, no Phase 4 stream makes it unilaterally`,
    );
  return problems;
}

/** Action 1: before the first Phase 4 registration, the four accepted registries accept a `P4-Sn` registrant. */
export function registeredByProblems(root: string): string[] {
  const sql = phase4Sql(root);
  const problems: string[] = [];
  for (const relation of REGISTERED_BY_RELATIONS) {
    const widened = new RegExp(
      `ALTER\\s+TABLE\\s+(?:ONLY\\s+)?${relation}\\b[\\s\\S]{0,600}?${REGISTERED_BY_WIDENED.replace(/[[\]$^*+?.()|{}\\]/g, '\\$&')}`,
      'i',
    );
    if (!widened.test(sql))
      problems.push(
        `no Phase 4 migration widens ${relation}.registered_by to ${REGISTERED_BY_WIDENED} — the first Phase 4 registration fails the accepted CHECK (plan action 1)`,
      );
  }
  if (new RegExp(REGISTERED_BY_PHASE3_ONLY.replace(/[[\]$^*+?.()|{}\\]/g, '\\$&')).test(sql))
    problems.push(`a Phase 4 migration re-introduces ${REGISTERED_BY_PHASE3_ONLY} — widening it and putting it back is not widening it`);
  return problems;
}

/** G-03's structural half: every FK from a Phase 4 relation to a business-scoped parent is composite, present and VALID. */
export function compositeFkProblems(root: string): string[] {
  const sql = phase4Sql(root);
  const { tables, unreadable } = readTables(sql);
  const problems = [...unreadable];
  const scoped = new Set([...BUSINESS_SCOPED_PARENTS, ...tables.filter((t) => t.columns.includes('business_id')).map((t) => t.name)]);
  for (const table of tables) {
    if (!table.columns.includes('business_id')) continue;
    for (const constraint of table.constraints) {
      // A COLUMN-level REFERENCES: the item begins with the column's own name,
      // never with a constraint keyword (a table-level FOREIGN KEY is read below).
      const inline = CONSTRAINT_START.test(constraint) ? null : /^([a-z_][a-z0-9_]*)\s[\s\S]*?\bREFERENCES\s+([a-z_][a-z0-9_]*)/i.exec(constraint);
      if (inline && scoped.has((inline[2] ?? '').toLowerCase()))
        problems.push(
          `${table.name}.${inline[1] ?? ''} references the business-scoped ${inline[2] ?? ''} through a SINGLE column — the FK must carry business_id on both sides, or SQL can bind ${table.name}(A) to ${inline[2] ?? ''}(B) (G-03)`,
        );
      const fk = /FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/i.exec(constraint);
      if (!fk) continue;
      const parent = (fk[2] ?? '').toLowerCase();
      if (!scoped.has(parent)) continue;
      const child = columnList(`(${fk[1] ?? ''})`).columns;
      const target = columnList(`(${fk[3] ?? ''})`).columns;
      if (!child.includes('business_id') || !target.includes('business_id'))
        problems.push(
          `${table.name}: the foreign key (${child.join(', ')}) → ${parent} (${target.join(', ')}) omits business_id on one side — a composite seam is what refuses a cross-business binding (G-03)`,
        );
    }
  }
  for (const m of sql.matchAll(/ADD\s+CONSTRAINT\s+([a-z_][a-z0-9_]*)[\s\S]{0,400}?NOT\s+VALID/gi))
    problems.push(`the Phase 4 constraint ${m[1] ?? ''} is added NOT VALID — a constraint nobody validated protects none of the rows that are already there`);
  for (const m of sql.matchAll(/ALTER\s+TABLE\s+(?:ONLY\s+)?([a-z_][a-z0-9_]*)\s+DROP\s+CONSTRAINT\s+([a-z_][a-z0-9_]*)/gi))
    if (/fk|foreign/i.test(m[2] ?? ''))
      problems.push(`a Phase 4 migration drops the foreign key ${m[2] ?? ''} on ${m[1] ?? ''} — the composite seams are never dropped (P2-S8's accepted rule)`);
  return problems;
}

/** G-19 (GOLD-74): the schema lint over the Phase 4 tables. */
export function schemaLintProblems(root: string): string[] {
  const sql = phase4Sql(root);
  const { tables, unreadable } = readTables(sql);
  const problems = [...unreadable];
  const byName = new Map(tables.map((t) => [t.name, t]));
  for (const table of tables) {
    const known = new Set(table.columns);
    for (const constraint of table.constraints) {
      const kind = /\b(PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK)\b/i.exec(constraint)?.[1]?.toUpperCase().replace(/\s+/g, ' ');
      if (kind === undefined) continue;
      if (kind === 'CHECK') {
        const expression = /CHECK\s*\(([\s\S]*)\)/i.exec(constraint)?.[1] ?? '';
        for (const word of checkExpressionColumns(expression))
          if (!known.has(word))
            problems.push(`${table.name}: the CHECK names "${word}", which is not a column of ${table.name} (${[...known].join(', ')}) — GOLD-74`);
        continue;
      }
      const list = columnList(constraint.replace(/REFERENCES[\s\S]*$/i, ''));
      for (const column of list.columns)
        if (!known.has(column)) problems.push(`${table.name}: the ${kind} names the column "${column}", which ${table.name} does not have — GOLD-74`);
      for (const literal of list.literals)
        problems.push(
          `${table.name}: the ${kind} column list contains the literal ${literal} — a constraint that pins a literal is not the constraint it looks like (GOLD-74)`,
        );
      const fk = /FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/i.exec(constraint);
      if (fk) {
        const parent = byName.get((fk[2] ?? '').toLowerCase());
        const target = columnList(`(${fk[3] ?? ''})`).columns;
        if (parent)
          for (const column of target)
            if (!parent.columns.includes(column))
              problems.push(`${table.name}: the foreign key targets ${parent.name}.${column}, which ${parent.name} does not have — GOLD-74`);
        if (columnList(`(${fk[1] ?? ''})`).columns.length !== target.length)
          problems.push(
            `${table.name}: the foreign key (${fk[1] ?? ''}) → ${fk[2] ?? ''} (${fk[3] ?? ''}) has a different number of columns on each side — GOLD-74`,
          );
      }
    }
    if (!FINANCIAL_CORE.test(table.name)) continue;
    const referenced = new Set<string>();
    for (const constraint of table.constraints) {
      const inline = CONSTRAINT_START.test(constraint) ? null : /^([a-z_][a-z0-9_]*)\s[\s\S]*?\bREFERENCES\b/i.exec(constraint);
      if (inline) referenced.add((inline[1] ?? '').toLowerCase());
      const fk = /FOREIGN\s+KEY\s*\(([^)]*)\)/i.exec(constraint);
      if (fk) for (const c of columnList(`(${fk[1] ?? ''})`).columns) referenced.add(c);
    }
    for (const column of table.columns) {
      const m = /^(.*)_id$/.exec(column);
      if (!m || referenced.has(column)) continue;
      const stem = m[1] ?? '';
      const discriminator = [`${stem}_type`, `${stem}_kind`].find((d) => known.has(d));
      if (discriminator !== undefined)
        problems.push(
          `${table.name}: ${column} has no foreign key and sits beside ${discriminator} — that is a polymorphic reference, and the financial core has none (GOLD-74; the composite bridge pattern of P4-AL-29 is how a source is bound)`,
        );
    }
  }
  return problems;
}

/** G-07's structural half: document numbering is per business, and no global sequence backs a document number. */
export function numberingProblems(root: string): string[] {
  const sql = phase4Sql(root);
  const { tables, unreadable } = readTables(sql);
  const problems = [...unreadable];
  for (const m of sql.matchAll(/CREATE\s+SEQUENCE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi))
    problems.push(
      `a Phase 4 migration creates the sequence ${m[1] ?? ''} — a document number comes from a per-business counter row under a lock, never from a cluster-wide sequence that two businesses share (G-07)`,
    );
  for (const table of tables) {
    for (const column of table.columns) {
      if (new RegExp(`\\b${column}\\s+(?:big)?serial\\b`, 'i').test(table.body) && /(number|seq|no)$/.test(column))
        problems.push(`${table.name}.${column} is a serial — a document number series is per business, and serial is per table (G-07)`);
    }
    const numbers = table.columns.filter((c) => /_(number|no)$/.test(c));
    if (numbers.length === 0) continue;
    if (!table.columns.includes('business_id')) {
      problems.push(
        `${table.name} carries the document number ${numbers.join(', ')} and no business_id — a number series that is not scoped to a business is shared between businesses (G-07)`,
      );
      continue;
    }
    for (const number of numbers) {
      const unique = table.constraints
        .filter((c) => /\b(UNIQUE|PRIMARY\s+KEY)\b/i.test(c))
        .map((c) => columnList(c.replace(/REFERENCES[\s\S]*$/i, '')).columns);
      const covering = unique.filter((cols) => cols.includes(number));
      if (covering.length === 0) {
        problems.push(`${table.name}.${number} is a document number with no UNIQUE over it — a series with duplicates is not a series (G-07)`);
        continue;
      }
      for (const cols of covering)
        if (!cols.includes('business_id'))
          problems.push(
            `${table.name}: UNIQUE (${cols.join(', ')}) over the document number ${number} omits business_id — two businesses of one tenant must hold independent series (G-07)`,
          );
    }
  }
  return problems;
}

/** Every route the API serves under a Phase 4 prefix, discovered from the controllers so a new route cannot escape (G-02). */
export function discoverPhase4Routes(root: string): string[] {
  const dir = join(root, 'apps/api/src/modules');
  if (!existsSync(dir)) return [];
  const controllers: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path).sort()) {
      const full = join(path, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.controller.ts')) controllers.push(full);
    }
  };
  walk(dir);
  const routes: string[] = [];
  for (const file of controllers) {
    const source = stripTsProse(readFileSync(file, 'utf8'));
    const prefix = /@Controller\(\s*'([^']*)'/.exec(source)?.[1] ?? '';
    const normalized = `/${prefix.replace(/^\/+|\/+$/g, '')}`;
    if (!PHASE4_ROUTE_PREFIXES.some((p) => normalized === p || normalized.startsWith(`${p}/`))) continue;
    for (const m of source.matchAll(/@(Get|Post|Patch|Put|Delete)\(\s*(?:'([^']*)')?\s*\)/g)) {
      const sub = (m[2] ?? '').replace(/^\/+/, '');
      routes.push(`${(m[1] ?? '').toUpperCase()} ${sub === '' ? normalized : `${normalized}/${sub}`}`);
    }
  }
  return [...new Set(routes)].sort();
}

/** G-02: every discovered Phase 4 route is named by the enumerated cross-tenant golden. */
export function crossTenantProblems(root: string): string[] {
  const routes = discoverPhase4Routes(root);
  const goldens = S1_SUITES.filter((e): e is SuiteEntry => !isPending(e) && e.area === 'golden');
  if (goldens.length === 0)
    return routes.map(
      (r) =>
        `${r} is a Phase 4 route and no enumerated cross-tenant golden is declared yet (G-02) — every Phase 4 route refuses another tenant's token at the API and again at SQL`,
    );
  const text = goldens.map((g) => (has(root, g.file) ? read(root, g.file) : '')).join('\n');
  const problems: string[] = [];
  for (const route of routes) {
    const path = route.split(' ')[1] ?? '';
    if (!text.includes(path))
      problems.push(`${route} appears in no cross-tenant golden — the suite is enumerated from the route surface so a new route cannot escape (G-02)`);
  }
  return problems;
}

/**
 * This gate's own hygiene, and the reason it exists: the Phase 4 estate carries
 * no permanent "nothing after N". The full estate-wide grep, over every
 * accepted gate, is `tests/security/phase4-forward-evolution.test.ts`; this is
 * the subset the gate can prove about its own two files without a runner.
 */
export function closureRuleProblems(root: string): string[] {
  const problems: string[] = [];
  const FORBIDDEN: readonly (readonly [RegExp, string])[] = [
    [/\.sql['"`]\s*\)\s*\)?\s*\.length\s*[=!<>]==?\s*\d+/, 'a count of .sql files compared with a literal'],
    [/frozenThrough\s*[=!]==/, 'a frozenThrough equality (it is a floor)'],
  ];
  // The head is READ from the tree, never written down: a permanent module may
  // name a migration that exists (its accepted digests do) and may not name one
  // that does not, and that rule stays correct as the head moves.
  const head = Number(
    readdirSync(migrationsDir(root))
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .slice(-1)[0]
      ?.slice(0, 4) ?? '0',
  );
  for (const file of ['scripts/phase4-prefix.ts']) {
    if (!has(root, file)) {
      problems.push(`${file} is missing`);
      continue;
    }
    const code = stripTsProse(read(root, file));
    for (const [shape, why] of FORBIDDEN)
      if (shape.test(code)) problems.push(`${file} contains ${why} — a permanent invariant never bounds the future (P4-AL-60)`);
    for (const m of code.matchAll(/['"`](\d{4})_[a-z0-9_]+\.sql['"`]/g))
      if (Number(m[1]) > head)
        problems.push(`${file} names the migration ${m[0]}, which does not exist — a permanent module that names a future file bounds the future (P4-AL-60)`);
  }
  // The candidate tense is fenced, and the fence names the decision that allows it.
  const self = 'scripts/phase4-s1-gate.ts';
  if (has(root, self)) {
    const text = read(root, self);
    const open = (text.match(/CANDIDATE-TENSE \(P4-AL-61\)/g) ?? []).length;
    const candidate = Object.keys(S1_ACCEPTED).length === 0;
    if (candidate && open < 2)
      problems.push(
        `${self}: the candidate-tense block is not fenced between two "CANDIDATE-TENSE (P4-AL-61)" markers, so the acceptance commit cannot find what to delete`,
      );
    if (!candidate && open > 0)
      problems.push(`${self}: P4-S1 is accepted and the candidate-tense block is still here — the acceptance commit deletes it (P4-AL-61)`);
  }
  return problems;
}

// ─────────────────────────────────────────────────────────────────────────
// Applicability. A check with no subject yet is NOT-YET-APPLICABLE, which is
// not a pass: it prints n/a, it is named in the verdict, and it becomes live
// with no edit to this file the moment its subject exists.
// ─────────────────────────────────────────────────────────────────────────

export type Needs = 'live' | 'phase4-migration' | 'phase4-route';

export interface Check {
  readonly id: string;
  readonly title: string;
  readonly area: string;
  readonly needs: Needs;
  readonly run: (root: string) => string[];
  readonly ok: string;
  /** What makes an inert check live. Printed on every n/a line. */
  readonly liveWhen?: string;
}

export const CHECKS: readonly Check[] = [
  {
    id: 'prefix',
    title: 'the three migration prefixes',
    area: 'prefix',
    needs: 'live',
    run: prefixProblems,
    ok: `0000–${PHASE4_INHERITED_PREFIX_END.slice(0, 4)} intact byte for byte (Phase 2 through ${PHASE2_PREFIX_END.slice(0, 4)}, Phase 3 through ${PHASE3_PREFIX_END.slice(0, 4)}); frozenThrough a floor at ${frozenThroughFloor()}; later migrations permitted`,
  },
  {
    id: 'boundary',
    title: `the P4-S1 migration boundary (${Object.keys(S1_ACCEPTED).length === 0 ? 'candidate' : 'accepted'} tense)`,
    area: 'boundary',
    needs: 'live',
    run: (root) => boundaryProblems(root),
    ok:
      Object.keys(S1_ACCEPTED).length === 0
        ? `frozenThrough exactly ${PREVIOUS_HEAD}; after it exactly S1_MIGRATIONS, none recorded`
        : 'the P4-S1 migrations are frozen at their accepted digests, and frozenThrough is a floor',
  },
  { id: 'pending', title: 'required entries', area: 'pending', needs: 'live', run: pendingProblems, ok: 'no required entry is pending' },
  {
    id: 'suites',
    title: 'suites',
    area: 'suites',
    needs: 'live',
    run: suiteProblems,
    ok: `every listed suite exists and skips nothing; every p4-* suite and every ${GOLDEN_DIR} file is listed; every ${GUARD_SUITE_DIR} proof is one this gate executes`,
  },
  {
    id: 'commands',
    title: 'commands',
    area: 'commands',
    needs: 'live',
    run: commandProblems,
    ok: 'the permanent core, the predecessor gate and this gate all name scripts that exist',
  },
  {
    id: 'red-proofs',
    title: 'red proofs',
    area: 'red-proof',
    needs: 'live',
    run: redProofProblems,
    ok: `${RED_PROOFS.length} red proofs resolve to their tests`,
  },
  {
    id: 'closure-rule',
    title: 'no permanent "nothing after N"',
    area: 'closure-rule',
    needs: 'live',
    run: closureRuleProblems,
    ok: 'the permanent prefix module bounds nothing, and the candidate tense is fenced inside this gate',
  },
  {
    id: 'guards',
    title: 'the guards Phase 4 cannot inherit (actions 2, 3)',
    area: 'guards',
    needs: 'live',
    run: guardProblems,
    ok: 'the G-3 sales arm names every authoritative balance column and no stored fact; the jargon guard reaches the Phase 4 namespaces and screens',
  },
  {
    id: 'browser-steps',
    title: 'the Phase 3 browser coupling (P4-AL-63)',
    area: 'browser',
    needs: 'live',
    run: browserStepProblems,
    ok: 'flows.ts exports disjoint PHASE3_STEPS/PHASE4_STEPS and the Phase 3 gate is pinned to its own fifteen',
  },
  {
    id: 'registered-by',
    title: 'the registries accept a Phase 4 registrant (action 1)',
    area: 'registration',
    needs: 'phase4-migration',
    run: registeredByProblems,
    ok: `all four registered_by CHECKs widened to ${REGISTERED_BY_WIDENED}`,
    liveWhen: 'a migration numbered past the inherited prefix exists',
  },
  {
    id: 'composite-fk',
    title: 'composite-FK presence and validity (G-03)',
    area: 'composite-fk',
    needs: 'phase4-migration',
    run: compositeFkProblems,
    ok: 'every FK to a business-scoped parent carries business_id on both sides, is VALID and is never dropped',
    liveWhen: 'a migration numbered past the inherited prefix exists',
  },
  {
    id: 'schema-lint',
    title: 'the schema lint (G-19 / GOLD-74)',
    area: 'schema-lint',
    needs: 'phase4-migration',
    run: schemaLintProblems,
    ok: 'every column named in every UNIQUE, CHECK and FK exists; no literal in a constraint column list; no polymorphic FK in the financial core',
    liveWhen: 'a migration numbered past the inherited prefix exists',
  },
  {
    id: 'numbering',
    title: 'numbering isolation (G-07, structural half)',
    area: 'numbering',
    needs: 'phase4-migration',
    run: numberingProblems,
    ok: 'every document number is UNIQUE within its business and no global sequence backs one',
    liveWhen: 'a migration numbered past the inherited prefix exists',
  },
  {
    id: 'cross-tenant',
    title: 'the enumerated cross-tenant surface (G-02)',
    area: 'cross-tenant',
    needs: 'phase4-route',
    run: crossTenantProblems,
    ok: 'every discovered Phase 4 route is named by the enumerated cross-tenant golden',
    liveWhen: 'a controller serves a route under a Phase 4 prefix',
  },
];

/** The closed registry of checks that may report NOT-YET-APPLICABLE. A check that goes inert without being here is a FAIL. */
export const INERT_ALLOWED: readonly string[] = ['registered-by', 'composite-fk', 'schema-lint', 'numbering', 'cross-tenant'];

export function isApplicable(needs: Needs, root: string): boolean {
  if (needs === 'live') return true;
  if (needs === 'phase4-migration') return phase4Migrations(root).length > 0;
  return discoverPhase4Routes(root).length > 0;
}

/**
 * The gate refuses to treat NOT-YET-APPLICABLE as a pass. Two rules, and both
 * of them fire without anyone editing this file:
 *
 *   — an inert check must be in `INERT_ALLOWED`;
 *   — once its subject exists, no check of that kind may be inert.
 */
export function applicabilityProblems(root: string, inert: readonly string[]): string[] {
  const problems: string[] = [];
  for (const id of inert)
    if (!INERT_ALLOWED.includes(id))
      problems.push(
        `the check "${id}" reported NOT-YET-APPLICABLE and is not in INERT_ALLOWED — a check does not become optional by finding nothing to look at`,
      );
  const migrations = phase4Migrations(root);
  if (migrations.length > 0)
    for (const c of CHECKS)
      if (c.needs === 'phase4-migration' && inert.includes(c.id))
        problems.push(
          `${migrations.length} Phase 4 migration(s) exist (${migrations.join(', ')}) and the check "${c.id}" is still inert — it is live from the first Phase 4 migration`,
        );
  const routes = discoverPhase4Routes(root);
  if (routes.length > 0)
    for (const c of CHECKS)
      if (c.needs === 'phase4-route' && inert.includes(c.id))
        problems.push(`${routes.length} Phase 4 route(s) exist and the check "${c.id}" is still inert — it is live from the first Phase 4 route`);
  return problems;
}

// ── The runtime plan ────────────────────────────────────────────────────────

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

export type Step = { readonly kind: 'command'; readonly name: string; readonly area: string; readonly cmd: string; readonly args: readonly string[] };

/**
 * The runtime half, in order: the predecessor gate first (it composes the whole
 * accepted chain), then the permanent core, then P4-S1's own suites, then the
 * Phase 4 goldens — which also run in `test:golden`, and the duplicate
 * execution is accepted (`OD-P4-10` OPTION A). It is not optimised away.
 */
export function s1Plan(): readonly Step[] {
  const suites = S1_SUITES.filter((e): e is SuiteEntry => !isPending(e));
  const rootSuites = suites.filter((e) => e.runner === 'root' && e.area !== 'golden' && e.area !== 'guard-proofs').map((e) => e.file);
  const webSuites = suites.filter((e) => e.runner === 'web').map((e) => e.file);
  const goldens = suites.filter((e) => e.area === 'golden').map((e) => e.file);
  // Its own visible step: when a planted defect stops firing, a reviewer must
  // see THAT in the step list, not inside a run of everything.
  const guardProofs = suites.filter((e) => e.area === 'guard-proofs').map((e) => e.file);
  const commands = S1_COMMANDS.filter((c): c is CommandEntry => !isPending(c));
  return [
    {
      kind: 'command',
      name: `${PREDECESSOR_SCRIPT} (permanent predecessor; composes the whole accepted chain back to Phase 1)`,
      area: 'predecessor',
      cmd: npm,
      args: ['run', PREDECESSOR_SCRIPT],
    },
    ...commands.map(
      (c): Step => ({
        kind: 'command',
        name: `${c.id} npm run ${c.npmScript}`,
        area: 'core',
        cmd: npm,
        args: ['run', c.npmScript, ...(c.args.length ? ['--', ...c.args] : [])],
      }),
    ),
    ...(guardProofs.length > 0
      ? [
          {
            kind: 'command' as const,
            name: `the guard planted-defect proofs, by directory (${guardProofs.join(', ')}) — reached by no other gate or script`,
            area: 'guard-proofs',
            cmd: 'npx',
            args: ['vitest', 'run', ...guardProofs],
          },
        ]
      : []),
    ...(rootSuites.length > 0
      ? [
          {
            kind: 'command' as const,
            name: `P4-S1 suites, root runner (${rootSuites.length})`,
            area: 'suites',
            cmd: 'npx',
            args: ['vitest', 'run', ...rootSuites],
          },
        ]
      : []),
    ...(webSuites.length > 0
      ? [
          {
            kind: 'command' as const,
            name: `P4-S1 suites, web runner (${webSuites.length})`,
            area: 'web-suites',
            cmd: 'npx',
            args: ['vitest', 'run', '--config', 'apps/web/vitest.config.mts', ...webSuites],
          },
        ]
      : []),
    ...(goldens.length > 0
      ? [
          {
            kind: 'command' as const,
            name: `the P4-S1 goldens (${goldens.length}); they also run in test:golden, and OD-P4-10 accepts the duplicate`,
            area: 'golden',
            cmd: 'npx',
            args: ['vitest', 'run', ...goldens],
          },
        ]
      : []),
  ];
}

// ── The gate against a tree ─────────────────────────────────────────────────

interface Verdict {
  readonly gate: 'gate:phase4:s1';
  readonly root: string;
  readonly tense: 'candidate' | 'accepted';
  readonly structuralOnly: boolean;
  readonly verdict: 'PASS' | 'STRUCTURAL_PASS' | 'FAIL';
  readonly failures: number;
  readonly inert: readonly { readonly id: string; readonly why: string }[];
  readonly pending: readonly string[];
  readonly phase4Migrations: readonly string[];
  readonly phase4Routes: readonly string[];
}

function runGate(root: string, listOnly: boolean, structuralOnly: boolean, evidence: string | null): void {
  let failures = 0;
  const fail = (area: string, detail: string): void => {
    failures += 1;
    console.error(`  FAIL [${area}] ${detail}`);
  };
  const ok = (detail: string): void => console.log(`  ok      ${detail}`);
  const tense = Object.keys(S1_ACCEPTED).length === 0 ? 'candidate' : 'accepted';
  const migrations = phase4Migrations(root);
  const routes = discoverPhase4Routes(root);

  if (listOnly) {
    console.log(`P4-S1 GATE plan (${tense} tense) at ${root}:`);
    console.log(`  composes:   npm run ${PREDECESSOR_SCRIPT}, and through it the whole accepted chain back to Phase 1`);
    console.log(`  subject:    ${migrations.length} Phase 4 migration(s) (${migrations.join(', ') || 'none'}); ${routes.length} Phase 4 route(s)`);
    console.log('  structural checks:');
    for (const c of CHECKS)
      console.log(
        `    ${c.id.padEnd(14)} ${isApplicable(c.needs, root) ? 'live' : `NOT-YET-APPLICABLE — live when ${c.liveWhen ?? 'its subject exists'}`}   ${c.title}`,
      );
    console.log('  suites:');
    for (const e of S1_SUITES)
      console.log(
        `    ${e.id.padEnd(8)} ${isPending(e) ? `PENDING — FAILS until filled (${e.owner}): ${e.pending}` : `${e.runner.padEnd(4)} ${e.file}${has(root, e.file) ? '' : '   (missing)'}`}`,
      );
    console.log('  commands:');
    for (const c of S1_COMMANDS)
      console.log(
        `    ${c.id.padEnd(12)} ${isPending(c) ? `PENDING — FAILS until filled (${c.owner}): ${c.pending}` : ['npm run', c.npmScript, ...c.args].join(' ')}`,
      );
    console.log('  red proofs:');
    for (const r of RED_PROOFS)
      console.log(
        `    ${r.id.padEnd(12)} ${isPending(r) ? `PENDING — FAILS until filled (${r.owner}): ${r.pending}` : `${r.defect}\n                 ${r.proof}`}`,
      );
    console.log('  runtime:    the root and web runner canaries, before any result is trusted');
    for (const s of s1Plan()) console.log(`  command:    ${s.cmd} ${s.args.join(' ')}`);
    const pending = pendingProblems().length;
    console.log(`\n${pending} pending entr${pending === 1 ? 'y' : 'ies'}: the gate FAILS until ${pending === 1 ? 'it is' : 'they are'} filled.`);
    return;
  }

  const inert: { id: string; why: string }[] = [];
  for (const check of CHECKS) {
    console.log(`P4-S1 GATE — ${check.title}`);
    if (!isApplicable(check.needs, root)) {
      inert.push({ id: check.id, why: check.liveWhen ?? 'its subject exists' });
      console.log(`  n/a     NOT-YET-APPLICABLE — this check is live when ${check.liveWhen ?? 'its subject exists'}; it is NOT a pass`);
      continue;
    }
    const problems = check.run(root);
    for (const p of problems) fail(check.area, p);
    if (problems.length === 0) ok(check.ok);
  }
  console.log('P4-S1 GATE — applicability');
  const applicability = applicabilityProblems(
    root,
    inert.map((i) => i.id),
  );
  for (const p of applicability) fail('applicability', p);
  if (applicability.length === 0)
    ok(
      inert.length === 0
        ? 'every check had a subject and ran'
        : `${inert.length} check(s) NOT-YET-APPLICABLE, all of them in INERT_ALLOWED: ${inert.map((i) => i.id).join(', ')}`,
    );

  const record = (verdict: Verdict['verdict']): void => {
    if (evidence === null) return;
    const out: Verdict = {
      gate: 'gate:phase4:s1',
      root,
      tense,
      structuralOnly,
      verdict,
      failures,
      inert,
      pending: pendingProblems(),
      phase4Migrations: migrations,
      phase4Routes: routes,
    };
    mkdirSync(dirname(resolve(evidence)), { recursive: true });
    writeFileSync(resolve(evidence), `${JSON.stringify(out, null, 2)}\n`);
    console.log(`  evidence: ${evidence}`);
  };
  const inertNote = inert.length === 0 ? '' : ` — ${inert.length} check(s) NOT-YET-APPLICABLE: ${inert.map((i) => `${i.id} (live when ${i.why})`).join('; ')}`;

  if (failures > 0) {
    console.error(`\nP4-S1 GATE: FAIL (${failures} structural violation${failures === 1 ? '' : 's'}) — not running the regression matrix${inertNote}`);
    record('FAIL');
    process.exitCode = 1;
    return;
  }
  if (structuralOnly) {
    console.log(`\nP4-S1 GATE: PASS (structural checks only)${inertNote}`);
    record('STRUCTURAL_PASS');
    return;
  }

  console.log('P4-S1 GATE — runner canaries');
  for (const [label, config] of [
    ['root', 'tests/fixtures/runner-exit-code/vitest.config.ts'],
    ['web', 'apps/web/test/fixtures/runner-exit-code/vitest.config.mts'],
  ] as const) {
    const res = spawnSync('npx', ['vitest', 'run', '--config', config, 'failing'], { cwd: root, encoding: 'utf8', env: process.env });
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    if (!/1 failed/.test(output)) fail('runner', `the ${label} canary did not run its failing test, so this run proves nothing:\n${output.slice(-2000)}`);
    else if (res.status === 0) fail('runner', `the ${label} runner exited 0 over a failing test; no result it gives is evidence (tests/helpers/exit-code.ts)`);
    else ok(`the ${label} runner reports failure (canary exited ${res.status ?? 'on a signal'})`);
  }
  if (failures > 0) {
    console.error('\nP4-S1 GATE: FAIL — a test runner cannot report failure; refusing to run the regression matrix');
    record('FAIL');
    process.exitCode = 1;
    return;
  }

  console.log('P4-S1 GATE — composed regression matrix');
  for (const step of s1Plan()) {
    const started = Date.now();
    const res = spawnSync(step.cmd, [...step.args], { cwd: root, encoding: 'utf8', stdio: 'inherit', env: process.env });
    const ms = Date.now() - started;
    if (res.status !== 0) fail(step.area, `${step.name} failed (exit ${res.status ?? 'signal'}) after ${ms}ms`);
    else ok(`${step.name} (${ms}ms)`);
  }
  if (failures > 0) {
    console.error(`\nP4-S1 GATE: FAIL (${failures})${inertNote}`);
    record('FAIL');
    process.exitCode = 1;
    return;
  }
  console.log(`\nP4-S1 GATE: PASS${inertNote}`);
  record('PASS');
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const rootFlag = argv.indexOf('--root');
  const root = rootFlag >= 0 ? resolve(argv[rootFlag + 1] ?? '.') : join(__dirname, '..');
  const evidence = argv.find((a) => a.startsWith('--evidence='))?.slice('--evidence='.length) ?? null;
  runGate(root, argv.includes('--list'), argv.includes('--structural-only'), evidence);
}
