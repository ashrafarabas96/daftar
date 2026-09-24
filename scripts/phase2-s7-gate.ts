#!/usr/bin/env tsx
/**
 * PHASE 2 SLICE GATE — P2-S7, the financial reads (directive §68).
 *
 * `npm run gate:phase2:s7` is the deterministic answer to "do the reports
 * still tell the truth, and are they still only reports?".
 *
 * Everything before this slice WROTE the books. P2-S7 reads them, and the
 * ways to get a read wrong are different from the ways to get a write wrong,
 * because a bad read does not corrupt anything — it just tells a merchant
 * something false, convincingly, on a screen they will act on. The specific
 * ways, each of which has a section below:
 *
 *   — storing a balance, so that one day the ledger and the stored number
 *     disagree and nothing says which lied (AL-15, §11);
 *   — a report that writes: a lazy backfill, a repair, a "last viewed"
 *     stamp — a GET with a side effect nobody audits (§39, §54);
 *   — OFFSET pagination, which costs more every page and silently drops a
 *     line when a posting lands mid-walk (§28);
 *   — rendering a journal from TODAY's exchange rate, which is a report
 *     rewriting history (§30, §52);
 *   — filtering history on `accounts.is_active`, which deletes a closed
 *     shop's past from the books (§33);
 *   — a cumulative total through a JavaScript `number`, which is exact until
 *     the merchant is successful (§41);
 *   — a business-wide total that does not balance, rendered anyway (§23);
 *   — a branch filter presented as if it were a second set of books (§24);
 *   — an unauthorized reader, or an assigned-scope reader handed the whole
 *     business (§36, §62, §63);
 *   — one business reading another's journal, or learning from a refusal
 *     that an id it guessed was real (§32, §64).
 *
 * ── This gate is PERMANENT ───────────────────────────────────────────────
 *
 * P2-S7 was accepted at head 39a7503277a315c559291c15c34b66a4f4fab301, exact-SHA
 * workflow 35874918898, five jobs SUCCESS, and `0050_accounting_report_indexes.sql`
 * was frozen at the digest it was accepted at. So the question this gate asks
 * changed: not "is the candidate correct" but "is the accepted slice still
 * exactly what was accepted".
 *
 * It carries 0050's accepted digest as an INDEPENDENT SECOND SOURCE and
 * requires the file to hash to it both on disk and in the manifest, so one
 * commit cannot move a migration and its recorded hash together.
 *
 * The candidate-era rules went with the candidacy: 0050 must no longer be
 * absent from the manifest, and the "no 0051 may exist" clause is gone,
 * because an accepted historical gate that forbids its successor is a gate
 * that stops the project. P2-S8 is still forbidden from creating a 0051 —
 * that prohibition lives in P2-S8's own gate, where it belongs. Every actual
 * P2-S7 behaviour check is kept, index-only included.
 *
 * It COMPOSES rather than duplicates: P2-S6's gate runs unchanged, and it
 * composes P2-S5, P2-S4, P2-S3, P2-S2, P2-S1 and Phase 1 in turn.
 *
 * Usage: npm run gate:phase2:s7 [-- --list]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { discoverAccountingTables, findAuthoritativeBalanceColumns, isForbiddenBalanceTable } from './guards/no-authoritative-balance';
import { findReadSurfaceViolations, readSurfaceFiles } from './guards/read-surface';
import { stripComments } from './guards/sql-schema';

const ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(ROOT, 'infrastructure/database/migrations');
const LIST_ONLY = process.argv.slice(2).includes('--list');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * The boundary P2-S7's acceptance left behind. A FLOOR, never an equality:
 * this gate is permanent now, and a permanent gate has no opinion about how
 * far the boundary has moved since — only that it never moved back.
 */
const FROZEN_THROUGH_AT_LEAST = '0050_accounting_report_indexes.sql';

/** The migration this slice owns. Accepted history now; it may never vanish. */
const S7_MIGRATION = '0050_accounting_report_indexes.sql';

/**
 * The ACCEPTED digest, carried here as an independent second source.
 *
 * The manifest records it too, and that is the point: one commit cannot move
 * a migration and its recorded hash together and still pass, because this
 * file has to agree with both. The Tech Lead accepted these exact bytes at
 * head 39a7503277a315c559291c15c34b66a4f4fab301, exact-SHA workflow 35874918898.
 */
const S7_ACCEPTED = 'ef20a42788c503317c1e4b9bb69ada47e547faf42330bb1bc0d8e0a2f4c18356';

/** The read modules the slice owes. */
const S7_DOMAIN = 'packages/accounting/src/reports.ts';
const S7_READER = 'apps/api/src/modules/accounting/accounting-reports.reader.ts';
const S7_SERVICE = 'apps/api/src/modules/accounting/accounting-reports.service.ts';

/** The six read routes, exactly as §18 names them. */
const S7_ROUTES = ['accounts', 'entries', 'entries/:entryId', 'trial-balance', 'ledger', 'balances'] as const;

/** The suites that prove, against a real database, what the structure only claims. */
const P2_S7_TESTS = [
  'tests/integration/accounting-reports.test.ts',
  'tests/integration/accounting-reports-authorization.test.ts',
  'tests/integration/accounting-ledger-pagination.test.ts',
  'tests/integration/accounting-report-unbalanced.test.ts',
  'tests/integration/accounting-guards.test.ts',
  'tests/golden-regression/phase2/02-report-shapes.golden.test.ts',
  'tests/performance/accounting-read-plans.test.ts',
  'tests/integration/runner-exit-code.test.ts',
];

let failures = 0;
const fail = (check: string, detail: string): void => {
  failures += 1;
  console.error(`  FAIL [${check}] ${detail}`);
};
const ok = (detail: string): void => console.log(`  ok      ${detail}`);

const sqlFiles = (): string[] =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const readIfPresent = (path: string): string | null => (existsSync(join(ROOT, path)) ? read(path) : null);

/** Strip line and block comments from TypeScript source. */
const stripTsProse = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

/** The same, and string literals too, for rules about identifiers. */
const stripTsCode = (source: string): string =>
  stripTsProse(source)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');

/**
 * Every non-test application source file, path → contents.
 *
 * The slice gates and the static guards are excluded: a gate's whole job is
 * to NAME what it forbids, so a sweep that read them would fail on the line
 * stating the rule it is enforcing.
 */
function collectAppFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  const skip = new Set(['node_modules', 'dist', '.next', 'build', '.git', 'coverage', 'guards']);
  const selfReferential = /^scripts[\\/](phase\d-\w+-gate|phase2-s\d-gate|static-guards)\.ts$/;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
        const rel = relative(ROOT, full);
        if (!selfReferential.test(rel)) out[rel] = readFileSync(full, 'utf8');
      }
    }
  };
  for (const dir of [
    'apps/api/src',
    'apps/web/src',
    'apps/admin/src',
    'packages/accounting/src',
    'packages/shared-contracts/src',
    'packages/domain-core/src',
    'scripts',
  ]) {
    const full = join(ROOT, dir);
    if (existsSync(full)) walk(full);
  }
  return out;
}

// ── 1. The migration boundary, with an optional migration in it ────────────
//
// Frozen history is still frozen history. 0050 may exist or not; if it does
// it is a candidate and it is indexes. There is never a 0051.
function checkMigrationBoundary(): void {
  console.log('P2-S7 GATE — the migration boundary');
  const files = sqlFiles();
  const manifest = JSON.parse(read('infrastructure/database/MIGRATION_MANIFEST.json')) as {
    frozenThrough: string;
    migrations: { name: string; sha256: string }[];
  };

  if (manifest.frozenThrough < FROZEN_THROUGH_AT_LEAST) {
    fail('accepted-history', `frozenThrough is ${manifest.frozenThrough} — P2-S7 was accepted and frozen, so it must be at least ${FROZEN_THROUGH_AT_LEAST}`);
  } else {
    ok(`frozenThrough = ${manifest.frozenThrough} — at or beyond the P2-S7 acceptance boundary`);
  }

  // Every frozen migration, 0000 through the boundary, byte-identical. The
  // manifest check has its own script; this is the independent second read.
  let drifted = 0;
  for (const m of manifest.migrations) {
    const path = join(MIGRATIONS_DIR, m.name);
    if (!existsSync(path)) {
      fail('frozen-history', `${m.name} is recorded frozen but is missing — frozen history may never be deleted`);
      drifted += 1;
      continue;
    }
    const onDisk = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (onDisk !== m.sha256) {
      fail('frozen-history', `${m.name} hashes to ${onDisk.slice(0, 12)}… but was frozen at ${m.sha256.slice(0, 12)}… — frozen bytes are immutable`);
      drifted += 1;
    }
  }
  if (drifted === 0) ok(`all ${manifest.migrations.length} frozen migrations are byte-for-byte what the manifest recorded`);

  // This gate is PERMANENT. It asks whether P2-S7 is still what was accepted,
  // and it deliberately has NO opinion about whether a later authorized
  // migration exists: an accepted historical gate that forbids its successor
  // is a gate that stops the project. The candidate-era rules — 0050 must not
  // be frozen, no 0051 may exist — went with the candidacy. (The P2-S8 gate
  // carries its own 0051 prohibition, because that is P2-S8's rule to keep.)
  const recorded = new Map(manifest.migrations.map((m) => [m.name, m.sha256] as const));

  if (!files.includes(S7_MIGRATION)) {
    fail('accepted-history', `${S7_MIGRATION} is missing — it is accepted history and may never be deleted`);
    return;
  }
  ok(`${S7_MIGRATION} present`);

  const inManifest = recorded.get(S7_MIGRATION);
  if (inManifest === undefined) {
    fail('accepted-history', `${S7_MIGRATION} is not recorded in MIGRATION_MANIFEST.json — P2-S7 was accepted, so its migration is frozen history`);
  } else if (inManifest !== S7_ACCEPTED) {
    fail(
      'accepted-history',
      `${S7_MIGRATION} is recorded at ${inManifest.slice(0, 12)}… but was accepted at ${S7_ACCEPTED.slice(0, 12)}… — the manifest disagrees with the acceptance`,
    );
  } else {
    const onDisk = createHash('sha256')
      .update(readFileSync(join(MIGRATIONS_DIR, S7_MIGRATION)))
      .digest('hex');
    if (onDisk !== S7_ACCEPTED) {
      fail(
        'accepted-history',
        `${S7_MIGRATION} hashes to ${onDisk.slice(0, 12)}… on disk but was accepted at ${S7_ACCEPTED.slice(0, 12)}… — accepted bytes are immutable`,
      );
    } else {
      ok(`${S7_MIGRATION} is frozen at its accepted digest, on disk and in the manifest`);
    }
  }

  // INDEX-ONLY. The one thing this migration was authorized to be.
  const sql = stripComments(read(`infrastructure/database/migrations/${S7_MIGRATION}`));
  const forbidden: [RegExp, string][] = [
    [/CREATE\s+(?:UNLOGGED\s+|TEMP\s+|TEMPORARY\s+)?TABLE\b/i, 'creates a table'],
    [/CREATE\s+MATERIALIZED\s+VIEW\b/i, 'creates a materialized view — AL-15 forbids a second source of financial truth'],
    [/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\b/i, 'creates a view'],
    [/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i, 'creates a function'],
    [/CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\b/i, 'creates a trigger'],
    [/CREATE\s+POLICY\b/i, 'creates a policy'],
    [/CREATE\s+ROLE\b|ALTER\s+ROLE\b/i, 'changes a role'],
    [/\bGRANT\b|\bREVOKE\b/i, 'changes a privilege'],
    [/ADD\s+(?:COLUMN|CONSTRAINT)\b/i, 'adds a column or a constraint'],
    [/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE)\b/i, 'writes data'],
    [/CREATE\s+UNIQUE\s+INDEX\b/i, 'creates a UNIQUE index — that is a constraint wearing an index’s clothes'],
  ];
  let clean = true;
  for (const [re, what] of forbidden) {
    if (re.test(sql)) {
      fail('s7-index-only', `${S7_MIGRATION} ${what} — it was accepted as an index migration and nothing else (§12, §57)`);
      clean = false;
    }
  }
  const created = [...sql.matchAll(/CREATE\s+INDEX\s+(\w+)\s+ON\s+(\w+)/gi)];
  if (created.length === 0) {
    fail('s7-index-only', `${S7_MIGRATION} exists and creates no index — then it should not exist`);
  } else if (clean) {
    ok(`${S7_MIGRATION} creates ${created.length} index${created.length === 1 ? '' : 'es'} and nothing else`);
  }
  // An index is an access path to the journal, never a copy of it.
  for (const [, , table] of created) {
    if (table !== undefined && isForbiddenBalanceTable(table)) {
      fail('s7-index-only', `${S7_MIGRATION} indexes \`${table}\`, which is a stored balance — AL-15`);
    }
  }
}

// ── 2. AL-15: the journal is the only financial truth (§11) ────────────────
function checkNoStoredBalance(): void {
  console.log('P2-S7 GATE — live aggregation only');
  const schema = sqlFiles()
    .map((f) => read(`infrastructure/database/migrations/${f}`))
    .join('\n');
  const watched = discoverAccountingTables(schema);

  let stored = 0;
  for (const table of watched) {
    if (isForbiddenBalanceTable(table)) {
      fail('al-15', `table \`${table}\` stores accounting balances — every figure is aggregated from the journal at read time`);
      stored += 1;
    }
  }
  for (const f of sqlFiles()) {
    for (const hit of findAuthoritativeBalanceColumns(read(`infrastructure/database/migrations/${f}`), watched)) {
      fail('al-15', `${f}: ${hit.table}.${hit.column} claims storage authority over a derived financial quantity`);
      stored += 1;
    }
  }
  if (stored === 0) ok(`no stored accounting balance in any of the ${watched.length} accounting tables`);

  // No materialized view anywhere in the schema may carry accounting truth.
  if (/CREATE\s+MATERIALIZED\s+VIEW/i.test(stripComments(schema))) {
    fail('al-15', 'the schema creates a materialized view — a refreshed copy of the journal is a second truth that can be stale');
  } else {
    ok('no materialized view exists');
  }

  // …and no report may reach for a cache the application invented instead.
  const forbidden = /\b(accounting_balances|account_balances|running_balances|trial_balance_cache|ledger_cache|balance_snapshots)\b/i;
  for (const [path, source] of Object.entries(collectAppFiles())) {
    if (forbidden.test(stripTsProse(source))) {
      fail('al-15', `${path} names a persisted balance store — P2-S7 aggregates the journal and stores nothing`);
    }
  }
}

// ── 3. The read surface is a READ surface (§28, §30, §33, §39, §41, §54, §61)
function checkReadSurface(): void {
  console.log('P2-S7 GATE — the read surface');
  const files = collectAppFiles();
  const surface = readSurfaceFiles(files);
  if (surface.length === 0) {
    fail('read-surface', 'no accounting reporting module found — the guard is watching nothing');
  } else {
    ok(`${surface.length} reporting module${surface.length === 1 ? '' : 's'} under the read-surface rules`);
  }
  const violations = findReadSurfaceViolations(files);
  for (const v of violations) fail('read-surface', `${v.file}: ${v.rule} — ${v.why}`);
  if (violations.length === 0) ok('no write, no OFFSET, no current-rate lookup, no is_active history filter, no floating-point amount');

  // The static guard suite must actually carry G-6, or removing it from the
  // gate's import would silently remove it from CI as well.
  const guards = read('scripts/static-guards.ts');
  if (!/findReadSurfaceViolations/.test(guards))
    fail('read-surface', 'scripts/static-guards.ts does not run the read-surface guard — G-6 would not fail a pull request');
  else ok('G-6 runs in the static guard suite');
}

// ── 4. The domain module owns the arithmetic (§15, §16, §17, §42) ──────────
function checkDomainModule(): void {
  console.log('P2-S7 GATE — the domain module');
  const domain = readIfPresent(S7_DOMAIN);
  if (domain === null) {
    fail('s7-domain', `${S7_DOMAIN} is missing — the read arithmetic belongs in @daftar/accounting, not in a controller`);
    return;
  }
  const code = stripTsCode(domain);

  for (const symbol of ['normalBalanceOf', 'presentationNet', 'exactMinor', 'trialBalance', 'ledger', 'balances']) {
    if (new RegExp(`\\b${symbol}\\b`).test(code)) ok(`@daftar/accounting exports ${symbol}`);
    else fail('s7-domain', `${S7_DOMAIN} does not define ${symbol} — §15 puts the read arithmetic in the domain package`);
  }

  // The package stays pure: no transport, no configuration, no clock.
  for (const [re, what] of [
    [/\bprocess\s*\.\s*env\b/, 'reads process.env'],
    [/@nestjs\//, 'imports Nest'],
    [/\bfrom\s+''pg''|\brequire\(''pg''\)/, 'imports a database driver'],
  ] as [RegExp, string][]) {
    if (re.test(code)) fail('s7-domain', `${S7_DOMAIN} ${what} — the domain package has no transport, no configuration and no connection (§16)`);
  }

  // No second engine. One domain owns posting AND reading.
  const forbiddenEngines = /\b(JournalServiceV2|ReportingDatabase|FinancialReadStore)\b/;
  for (const [path, source] of Object.entries(collectAppFiles())) {
    if (forbiddenEngines.test(stripTsCode(source))) fail('s7-domain', `${path} defines a parallel financial engine — §17 forbids a second one`);
  }

  // The normal-balance rule is stated ONCE. A report that re-derives it is a
  // report that will disagree with the others the day one copy is edited.
  for (const path of [S7_READER, S7_SERVICE]) {
    const source = readIfPresent(path);
    if (source === null) continue;
    if (/===\s*''asset''\s*\|\|/.test(stripTsProse(source).replace(/'/g, "''"))) {
      fail('s7-domain', `${path} re-implements the normal-balance rule — it is stated once, in ${S7_DOMAIN} (§42)`);
    }
  }
  ok('the normal-balance rule is stated once, in the domain package');

  // Money crosses the wire as a decimal string, never a number.
  const contracts = readIfPresent('packages/shared-contracts/src/index.ts');
  if (contracts !== null) {
    const dtoBlock = /Accounting(?:TrialBalanceRow|Ledger|AccountBalance|EntryLine)Dto\s*\{[^}]*\}/g;
    for (const m of contracts.match(dtoBlock) ?? []) {
      if (/\b(?:Minor|balanceMinor|netMinor)\s*:\s*number\b/.test(m)) {
        fail('s7-domain', 'a money field in @daftar/shared-contracts is typed `number` — amounts are exact decimal STRINGS of minor units (§16, §41)');
      }
    }
    ok('every money field in the read DTOs is a decimal string');
  }
}

// ── 5. The six routes, and what guards them (§18, §36, §62) ────────────────
function checkRoutes(): void {
  console.log('P2-S7 GATE — the HTTP surface');
  const controller = readIfPresent('apps/api/src/modules/accounting/accounting.controller.ts');
  if (controller === null) {
    fail('s7-routes', 'the accounting controller is missing');
    return;
  }
  const source = stripTsProse(controller);

  for (const route of S7_ROUTES) {
    const re = new RegExp(`@Get\\(\\s*'${route.replace(/[/:]/g, (c) => `\\${c}`)}'\\s*\\)`);
    if (re.test(source)) ok(`GET …/accounting/${route}`);
    else fail('s7-routes', `GET …/accounting/${route} is missing — §18 names all six`);
  }

  // Every read route requires accounting.view, on the route itself.
  const blocks = [...source.matchAll(/@Get\(\s*'([^']*)'\s*\)([\s\S]{0,400}?)async\s+\w+\(/g)];
  for (const [, route = '', between = ''] of blocks) {
    if (!S7_ROUTES.includes(route as (typeof S7_ROUTES)[number])) continue;
    if (!/@RequiresPermission\(\s*'accounting\.view'\s*\)/.test(between)) {
      fail('s7-routes', `GET …/${route} does not require accounting.view on the route (§36, §62)`);
    }
  }
  ok('all six read routes require accounting.view');

  // A read route is a read. No mutation verb may carry a report's name.
  for (const verb of ['@Post', '@Patch', '@Put', '@Delete']) {
    const re = new RegExp(`${verb}\\(\\s*'(trial-balance|ledger|balances)'`);
    if (re.test(source)) fail('s7-routes', `${verb} on a report path — GET means GET (§54)`);
  }
  ok('no mutation verb carries a report path');

  // Branch scope is resolved from the membership, not from the query string.
  const service = readIfPresent(S7_SERVICE);
  if (service === null) {
    fail('s7-routes', `${S7_SERVICE} is missing`);
  } else {
    const code = stripTsProse(service);
    if (!/branchScopeMode\s*===\s*'assigned'/.test(code)) {
      fail('s7-routes', `${S7_SERVICE} never distinguishes an assigned-scope membership — §36 is not enforced`);
    } else if (!/allowedBranchIds/.test(code)) {
      fail('s7-routes', `${S7_SERVICE} never consults allowedBranchIds — a branch id in a query string is a request, not a fact (§36)`);
    } else {
      ok('branch scope is resolved from the membership and checked against allowedBranchIds');
    }
    if (!/hasPermission\([^)]*'accounting\.view'\)/.test(code)) {
      fail('s7-routes', `${S7_SERVICE} does not check accounting.view itself — the guard and the service answer different callers (§36)`);
    } else {
      ok('the service checks accounting.view independently of the route guard');
    }
  }
}

// ── 6. The whole-business balance assertion exists (§23, §24) ──────────────
function checkBalanceAssertion(): void {
  console.log('P2-S7 GATE — the balance assertion');
  const domain = readIfPresent(S7_DOMAIN);
  if (domain === null) return;
  const code = stripTsProse(domain);

  if (!/accounting\.report_unbalanced/.test(code)) {
    fail(
      's7-balance',
      `${S7_DOMAIN} never raises accounting.report_unbalanced — a whole-business trial balance that does not balance must be refused, not rendered (§23)`,
    );
  } else {
    ok('a whole-business trial balance that does not balance is refused');
  }
  if (!/isWholeBusinessScope/.test(code)) {
    fail('s7-balance', `${S7_DOMAIN} applies the balance assertion without distinguishing a whole-business report from a branch dimension (§24)`);
  } else {
    ok('the assertion is scoped to the whole-business report, and a branch dimension may legitimately not balance');
  }
  if (!/isBalanced/.test(code)) {
    fail('s7-balance', `${S7_DOMAIN} does not report isBalanced — a branch-filtered report must say plainly that it is a dimension (§24)`);
  } else {
    ok('a branch-dimensional report states whether it balances');
  }
  // No clearing account, no discarded entry: the two ways to fake a balance.
  if (/branch_clearing|clearingAccount|interBranch/i.test(stripTsCode(domain))) {
    fail('s7-balance', `${S7_DOMAIN} invents a branch clearing account — §24 forbids manufacturing a balance`);
  }
}

// ── 7. Keyset pagination, never OFFSET (§19, §28, §29) ─────────────────────
function checkPagination(): void {
  console.log('P2-S7 GATE — pagination');
  const domain = readIfPresent(S7_DOMAIN);
  const reader = readIfPresent(S7_READER);
  if (domain === null || reader === null) return;

  for (const [name, source] of [
    ['the domain module', domain],
    ['the SQL reader', reader],
  ] as const) {
    if (/\bOFFSET\b/i.test(stripTsProse(source).replace(/'[^']*'/g, ''))) {
      fail('s7-pagination', `${name} uses OFFSET — a keyset cursor is the only pagination a ledger may have (§28)`);
    }
  }
  ok('no OFFSET in the read path');

  const code = stripTsProse(domain);
  for (const symbol of ['encodeLedgerCursor', 'decodeLedgerCursor', 'encodeEntryCursor', 'decodeEntryCursor']) {
    if (!new RegExp(`\\b${symbol}\\b`).test(code))
      fail('s7-pagination', `${S7_DOMAIN} does not define ${symbol} — the cursor codec belongs to the domain (§29)`);
  }
  if (!/report_cursor_invalid/.test(code)) {
    fail('s7-pagination', `${S7_DOMAIN} never refuses a malformed cursor — a cursor is server-issued state and a bad one is a stable refusal (§29)`);
  } else {
    ok('a malformed cursor is refused rather than interpreted');
  }

  // The ledger's ORDER BY and its cursor predicate must be the SAME tuple, or
  // the next page starts somewhere the last one did not end.
  const sql = stripTsProse(reader);
  if (!/ORDER\s+BY\s+e\.entry_date,\s*l\.journal_entry_id,\s*l\.line_no/i.test(sql)) {
    fail('s7-pagination', `${S7_READER} does not order the ledger by (entry_date, journal_entry_id, line_no) — §28 fixes the tuple`);
  } else {
    ok('the ledger orders by its full tuple, in SQL');
  }
  if (!/\(\s*e\.entry_date,\s*l\.journal_entry_id,\s*l\.line_no\s*\)\s*>/i.test(sql)) {
    fail(
      's7-pagination',
      `${S7_READER} does not compare the whole tuple in its cursor predicate — a partial predicate is not lexicographically the ORDER BY (§28)`,
    );
  } else {
    ok('the cursor predicate is the same tuple as the ORDER BY, compared as a row');
  }
}

// ── 8. Exact integer money, from PostgreSQL to the wire (§41) ──────────────
function checkExactMoney(): void {
  console.log('P2-S7 GATE — exact amounts');
  const reader = readIfPresent(S7_READER);
  if (reader === null) return;
  const sql = stripTsProse(reader);

  // SUM(bigint) is NUMERIC. Casting it back to BIGINT is the overflow.
  if (/sum\s*\([^)]*\)\s*::\s*bigint/i.test(sql)) {
    fail('s7-money', `${S7_READER} casts a SUM back to BIGINT — cumulative history is not capped the way a single line is (§41)`);
  } else {
    ok('no SUM is cast back to BIGINT');
  }
  if (!/::\s*text/i.test(sql)) {
    fail('s7-money', `${S7_READER} never serializes a total as text — a NUMERIC must cross to JavaScript as an exact decimal string (§41)`);
  } else {
    ok('totals cross to JavaScript as exact decimal strings');
  }
  const domain = readIfPresent(S7_DOMAIN);
  if (domain !== null && !/bigint/.test(stripTsProse(domain))) {
    fail('s7-money', `${S7_DOMAIN} does not use bigint for amounts (§41)`);
  } else {
    ok('the domain module carries amounts as bigint');
  }
}

// ── 9. History is history (§30, §32, §33, §34, §52) ────────────────────────
function checkHistory(): void {
  console.log('P2-S7 GATE — history');
  const reader = readIfPresent(S7_READER);
  const service = readIfPresent(S7_SERVICE);
  if (reader === null || service === null) return;

  if (/accounting_fx_rate_lookup/.test(stripTsProse(reader))) {
    fail('s7-history', `${S7_READER} looks up a current FX rate — the rate frozen on the line is the only rate a report may render (§30, §52)`);
  } else {
    ok('no report consults the current FX rate');
  }
  if (!/fx_rate\b/.test(stripTsProse(reader))) {
    fail('s7-history', `${S7_READER} never reads the line's own fx_rate — the snapshot is what the report renders (§30)`);
  } else {
    ok('the report renders the snapshot frozen on the line');
  }

  // A foreign account and an invented one must be indistinguishable.
  if (!/NotFoundException/.test(stripTsProse(service))) {
    fail('s7-history', `${S7_SERVICE} never answers NOT FOUND — a cross-business probe must not be told which of its guesses was real (§32)`);
  } else {
    ok('a cross-business probe is answered as not found');
  }

  // Entry detail may not carry assertion material.
  for (const forbidden of ['postingFingerprint', 'posting_fingerprint', 'assertion', 'jti', 'kid']) {
    if (new RegExp(`\\b${forbidden}\\b`).test(stripTsCode(service))) {
      fail('s7-history', `${S7_SERVICE} exposes ${forbidden} — publishing assertion material hands a caller the shape of a forgery (§35)`);
    }
  }
  ok('no assertion material reaches a read DTO');
}

// ── 10. Every behavioural claim has a suite behind it (§45–§51, §62–§66) ────
function checkBehaviouralRegressions(): void {
  console.log('P2-S7 GATE — behavioural regressions');
  const required: [string, string][] = [
    ['tests/integration/accounting-reports.test.ts', 'the reports against a real ledger, with an independent recomputation (§45)'],
    ['tests/integration/accounting-reports-authorization.test.ts', 'the permission, branch and tenant matrices (§62, §63, §64)'],
    ['tests/integration/accounting-ledger-pagination.test.ts', 'keyset traversal, same-date collisions and a concurrent append (§49, §50)'],
    ['tests/integration/accounting-report-unbalanced.test.ts', 'the whole-business balance refusal (§23, §51)'],
    ['tests/golden-regression/phase2/02-report-shapes.golden.test.ts', 'the hand-computed trial balance and ledger (§46, §47, §48)'],
    ['tests/performance/accounting-read-plans.test.ts', 'the query-plan measurement the index decision rests on (§13, §57)'],
    ['packages/accounting/test/reports.test.ts', 'the normal-balance rule over all five types, and the cursor codec (§29, §42)'],
    ['tests/helpers/exit-code.ts', 'the guard that lets a failing run say so, which every gate verdict rests on'],
    ['tests/integration/runner-exit-code.test.ts', 'the end-to-end proof that a failing `vitest run` leaves with a non-zero status'],
    ['tests/fixtures/runner-exit-code/failing.fixture.ts', 'the canary this gate runs before trusting any test result in its own run'],
  ];
  for (const [path, why] of required) {
    if (existsSync(join(ROOT, path))) ok(`${path} — ${why}`);
    else fail('s7-regression', `${path} is missing — ${why}`);
  }

  // The independent recomputation must actually be independent: a test that
  // produced its expectation by calling the code under test would agree with
  // it by construction (§45).
  const reports = readIfPresent('tests/integration/accounting-reports.test.ts');
  if (reports !== null) {
    if (/from\s+'@daftar\/accounting'/.test(reports)) {
      fail(
        's7-regression',
        'the report suite imports the production aggregation — a reference calculation that shares the implementation proves nothing (§45)',
      );
    } else {
      ok('the reference calculation shares nothing with the production aggregation');
    }
  }

  // The acceptance document must exist and must state the outcome of the
  // index decision, either way (§70).
  const acceptance = readIfPresent('docs/PHASE_2_S7_ACCEPTANCE.md');
  if (acceptance === null) {
    fail('s7-docs', 'docs/PHASE_2_S7_ACCEPTANCE.md is missing (§70)');
  } else {
    const created = sqlFiles().includes(S7_MIGRATION);
    const claimsCreated = /0050_accounting_report_indexes\.sql/.test(acceptance);
    const claimsNotCreated = /0050 NOT CREATED/.test(acceptance);
    if (created && !claimsCreated) fail('s7-docs', 'the acceptance document does not record the index migration that exists');
    else if (!created && !claimsNotCreated) fail('s7-docs', 'the acceptance document does not record that no index migration was created (§14)');
    else ok('the acceptance document records the index decision the tree actually reflects');
    for (const claim of ['AL-15', 'accounting.view', 'keyset']) {
      if (!acceptance.includes(claim)) fail('s7-docs', `the acceptance document never mentions ${claim} (§70)`);
    }
  }
}

const STEPS: { name: string; cmd: string; args: string[] }[] = [
  { name: 'migration manifest', cmd: npm, args: ['run', 'check:migrations'] },
  { name: 'static guards (G-1…G-6)', cmd: npm, args: ['run', 'check:guards'] },
  { name: 'P2-S6 gate (permanent predecessor, composes P2-S5…P2-S1 and Phase 1)', cmd: npm, args: ['run', 'gate:phase2:s6'] },
  { name: '@daftar/accounting unit suite (the read arithmetic and the cursor codec)', cmd: npm, args: ['run', 'test', '-w', '@daftar/accounting'] },
  {
    name: 'P2-S7 report, authorization, pagination, incident, golden, plan and runner-soundness suites',
    cmd: 'npx',
    args: ['vitest', 'run', ...P2_S7_TESTS],
  },
];

/**
 * Before any test result in this run is treated as evidence: prove the test
 * runner can still report failure.
 *
 * This gate, and the six it composes, decide PASS or FAIL from the exit status
 * of `npx vitest run`. A runner that answered 0 over failing tests would make
 * every one of those verdicts meaningless while looking exactly like success —
 * and it did, until `tests/helpers/exit-code.ts`: `embedded-postgres` registers
 * a shutdown hook through `async-exit-hook`, which subscribes to `beforeExit`
 * with a hardcoded zero and calls `process.exit(0)` when the loop drains,
 * erasing the 1 Vitest had just recorded.
 *
 * `tests/integration/runner-exit-code.test.ts` asserts the same property, but
 * that assertion is circular where it matters most: if the runner cannot
 * report failure, it cannot report THAT failure either. So the check is also
 * made here, in a process that is not Vitest, from the exit status directly,
 * and it runs FIRST — nothing below it is trusted until it passes.
 */
function checkRunnerReportsFailure(): void {
  const config = 'tests/fixtures/runner-exit-code/vitest.config.ts';
  const res = spawnSync('npx', ['vitest', 'run', '--config', config, 'failing'], { cwd: ROOT, encoding: 'utf8', env: process.env });
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;

  if (!/1 failed/.test(output)) {
    fail('runner', `the exit-code canary did not run its failing test, so this run proves nothing about the runner:\n${output.slice(-2000)}`);
    return;
  }
  if (res.status === 0) {
    fail(
      'runner',
      'the test runner exited 0 over a failing test. No test result in this run — or in any gate it composes — is evidence. ' +
        'See tests/helpers/exit-code.ts.',
    );
    return;
  }
  ok(`the test runner reports failure (canary exited ${res.status ?? 'on a signal'})`);
}

function runSteps(): void {
  console.log('P2-S7 GATE — composed regression matrix');
  checkRunnerReportsFailure();
  if (failures > 0) {
    console.error('\nP2-S7 GATE: FAIL — the test runner cannot report failure; refusing to run the regression matrix');
    process.exit(1);
  }
  for (const step of STEPS) {
    const started = Date.now();
    const res = spawnSync(step.cmd, [...step.args], { cwd: ROOT, encoding: 'utf8', stdio: 'inherit', env: process.env });
    const ms = Date.now() - started;
    if (res.status !== 0) fail('regression', `${step.name} failed (exit ${res.status ?? 'signal'}) after ${ms}ms`);
    else ok(`${step.name} (${ms}ms)`);
  }
}

if (LIST_ONLY) {
  console.log('P2-S7 GATE plan:');
  console.log('  structural: every frozen migration byte-identical; 0050 present and frozen at its accepted digest on disk AND in the manifest');
  console.log('  structural: no stored balance, no balance table, no materialized view, no cache named anywhere in the application');
  console.log(
    '  structural: the reporting modules write nothing, use no OFFSET, look up no current rate, filter no history on is_active, parse no amount as a double',
  );
  console.log('  structural: the read arithmetic lives in @daftar/accounting, states the normal-balance rule once, and carries amounts as bigint');
  console.log('  structural: six GET routes, each requiring accounting.view, with branch scope resolved from the membership');
  console.log('  structural: a whole-business trial balance that does not balance is refused; a branch dimension says so instead');
  console.log('  structural: keyset cursors only, the ORDER BY tuple and the cursor predicate identical, a malformed cursor refused');
  console.log('  structural: SUM is NUMERIC, serialized as an exact decimal string, never cast back to BIGINT');
  console.log('  structural: the FX snapshot on the line is what a report renders; a cross-business probe is not found; no assertion material in a DTO');
  console.log('  structural: every behavioural claim has a suite, the recomputation is independent, and the acceptance document matches the tree');
  for (const s of STEPS) console.log(`  command:    ${s.cmd} ${s.args.join(' ')}`);
  process.exit(0);
}

checkMigrationBoundary();
checkNoStoredBalance();
checkReadSurface();
checkDomainModule();
checkRoutes();
checkBalanceAssertion();
checkPagination();
checkExactMoney();
checkHistory();
checkBehaviouralRegressions();
if (failures > 0) {
  console.error(`\nP2-S7 GATE: FAIL (${failures} structural violation${failures === 1 ? '' : 's'}) — not running the regression matrix`);
  process.exit(1);
}
runSteps();

if (failures > 0) {
  console.error(`\nP2-S7 GATE: FAIL (${failures})`);
  process.exit(1);
}
console.log('\nP2-S7 GATE: PASS');
