#!/usr/bin/env tsx
/**
 * PHASE 2 SLICE GATE — P2-S4, the accounting-native sources (directive §51).
 *
 * `npm run gate:phase2:s4` is the deterministic answer to "does the source
 * slice still do exactly what it was built to do?". P2-S3 shipped the one
 * hardened writer; P2-S4 builds the three merchant-facing facts ON TOP of it —
 * manual adjustment, reversal and opening balance — and this gate exists to
 * make sure they stay built on top of it rather than around it.
 *
 * 0046 and 0047 are CANDIDATES, not frozen history, so the questions here are
 * different in kind from the P2-S3 gate's. That gate asks "are the accepted
 * bytes still the accepted bytes". This one asks "is the candidate still
 * correct", which means it checks structure and behaviour rather than digests,
 * and it refuses a 0048 outright because §7 authorizes exactly two migrations.
 *
 * It COMPOSES rather than duplicates: P2-S3's gate runs unchanged, and it
 * composes P2-S2, P2-S1 and Phase 1 in turn, so the whole chain runs from one
 * command and nothing this slice adds can be paid for with a regression in
 * what came before.
 *
 * Usage: npm run gate:phase2:s4 [-- --list]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { findDefinerSearchPathViolations } from './guards/definer-search-path';
import { findPostingSurfaceViolations, journalWriters } from './guards/posting-surface';
import { stripComments } from './guards/sql-schema';
import { INTENDED_TABLE_GRANTS, INTERNAL_ROLE, RUNTIME_ROLES, WRITE_PRIVILEGES } from './guards/journal-privilege-model';

const ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(ROOT, 'infrastructure/database/migrations');
const LIST_ONLY = process.argv.slice(2).includes('--list');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** The two migrations §7 authorizes, and the boundary they must not cross. */
const S4_MIGRATIONS = ['0046_accounting_sources.sql', '0047_accounting_opening_balances.sql'] as const;
const FROZEN_THROUGH = '0045_accounting_post_entry.sql';

/** The tables and routines this slice owes. */
const S4_TABLES = [
  'accounting_operation_kinds',
  'accounting_manual_adjustments',
  'accounting_reversals',
  'accounting_opening_balances',
  'accounting_opening_balance_lines',
] as const;

const S4_ROUTINES = [
  'accounting_post_manual_adjustment',
  'accounting_post_reversal',
  'accounting_open_balance_draft',
  'accounting_open_balance_edit',
  'accounting_open_balance_discard',
  'accounting_open_balance_post',
  'accounting_open_balance_supersede',
] as const;

/**
 * Surfaces §7 explicitly DEFERS. A gate that only checks what was built lets
 * scope creep through silently; this half checks what was not.
 */
const OUT_OF_SCOPE_TABLES = ['accounting_periods', 'accounting_fx_rates', 'accounting_balances', 'accounting_trial_balance', 'accounting_fx_registry'] as const;

/** The engine modules P2-S4 adds to @daftar/accounting. */
const S4_MODULES = ['src/sources.ts'] as const;

/** The suites that prove, against a real database, what the structure only claims. */
const P2_S4_TESTS = [
  'tests/integration/accounting-sources.test.ts',
  'tests/integration/accounting-sources-concurrency.test.ts',
  'tests/security/accounting-sources-authority.test.ts',
  'tests/integration/accounting-journal.test.ts',
  'tests/integration/migration-upgrade.test.ts',
  'tests/integration/migration-portability.test.ts',
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
const readMigration = (name: string): string => readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
const wholeTree = (): string => sqlFiles().map(readMigration).join('\n');
const s4Sql = (): string => S4_MIGRATIONS.map(readMigration).join('\n');

// ── 1. Migration boundary ───────────────────────────────────────────────────
//
// Two authorized migrations, no more; everything up to 0045 untouched; the
// manifest still frozen where P2-S3 left it, because §59 forbids freezing
// 0046/0047 before an independent review.
function checkMigrationBoundary(): void {
  console.log('P2-S4 GATE — migration boundary');
  const files = sqlFiles();

  for (const name of S4_MIGRATIONS) {
    if (files.includes(name)) ok(`${name} present`);
    else fail('s4-migrations', `${name} is missing — P2-S4 is the slice that creates it (§7)`);
  }

  const beyond = files.filter((f) => f.slice(0, 4) > '0047');
  if (beyond.length > 0) {
    fail('scope', `migrations beyond 0047 exist (${beyond.join(', ')}) — §7 authorizes exactly 0046 and 0047, and §59 forbids starting P2-S5`);
  } else {
    ok('no migration after 0047 — the slice stopped where it was authorized to stop');
  }

  const manifest = JSON.parse(readFileSync(join(ROOT, 'infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8')) as {
    frozenThrough: string;
    migrations: { name: string; sha256: string }[];
  };

  if (manifest.frozenThrough !== FROZEN_THROUGH) {
    fail(
      'candidate-status',
      `frozenThrough is ${manifest.frozenThrough} — P2-S4's migrations are CANDIDATES, so it must stay at ${FROZEN_THROUGH} until a Tech Lead freezes them (§59)`,
    );
  } else {
    ok(`frozenThrough = ${FROZEN_THROUGH} — 0046/0047 are candidates, exactly as §59 requires`);
  }

  const frozen = new Set(manifest.migrations.map((m) => m.name));
  for (const name of S4_MIGRATIONS) {
    if (frozen.has(name)) fail('candidate-status', `${name} appears in MIGRATION_MANIFEST.json — a candidate must not be frozen before review (§59)`);
  }
  if (!S4_MIGRATIONS.some((n) => frozen.has(n))) ok('neither candidate is recorded as frozen history');
}

// ── 2. The surfaces this slice owes, and the ones it must not build ────────
function checkSurfaces(): void {
  console.log('P2-S4 GATE — the source surfaces');
  const schema = stripComments(wholeTree());
  const s4 = stripComments(s4Sql());

  for (const table of S4_TABLES) {
    if (new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table}\\b`, 'i').test(s4)) ok(`${table} exists`);
    else fail('missing-surface', `${table} does not exist — P2-S4 is the slice that creates it (§9)`);
  }
  for (const routine of S4_ROUTINES) {
    if (new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${routine}\\b`, 'i').test(s4)) ok(`${routine} exists`);
    else fail('missing-surface', `${routine} does not exist — the source workflows are DB commands, not application logic (§37)`);
  }

  // §7's deferrals. A table created "for later" is scope creep with a comment
  // on it, and the point of an authorized scope is that it binds.
  for (const table of OUT_OF_SCOPE_TABLES) {
    if (new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table}\\b`, 'i').test(schema)) {
      fail('scope', `${table} exists — §7 defers FX registry, periods and financial reads to a later slice`);
    }
  }
  ok('no FX registry, period or balance-read table was built ahead of its slice (§7)');

  // §12: the journal never learns that one of its entries was reversed.
  const journal = stripComments(readMigration('0042_accounting_journal.sql') + '\n' + s4Sql());
  for (const column of ['reversed', 'reversed_at', 'reversed_by_entry_id', 'is_reversed']) {
    if (new RegExp(`ALTER\\s+TABLE\\s+journal_entries[\\s\\S]{0,120}?ADD\\s+COLUMN[\\s\\S]{0,40}?\\b${column}\\b`, 'i').test(journal)) {
      fail('immutable-journal', `journal_entries gained a ${column} column — a reversal is a NEW entry, never a mark on the old one (§12)`);
    }
  }
  ok('journal_entries carries no reversal marker — the original stays exactly what it was (§12)');

  // §13: a second reversal must be physically impossible, not merely refused.
  if (/UNIQUE\s*\(\s*business_id\s*,\s*original_entry_id\s*\)/i.test(s4)) {
    ok('accounting_reversals is UNIQUE (business_id, original_entry_id) — a second reversal cannot be written (§13)');
  } else {
    fail('reversal-uniqueness', 'accounting_reversals has no UNIQUE (business_id, original_entry_id) — the rule would live only in code (§13)');
  }

  // §14: the uniqueness refusal must surface as a domain code.
  if (/accounting\.reversal_exists/.test(s4)) ok('the uniqueness refusal is mapped to accounting.reversal_exists, never a raw duplicate-key error (§14)');
  else fail('reversal-uniqueness', 'nothing maps the reversal uniqueness violation to accounting.reversal_exists (§14)');

  // §24: exactly one POSTED opening balance per business, enforced physically.
  if (/CREATE\s+UNIQUE\s+INDEX[\s\S]{0,200}?ON\s+accounting_opening_balances\s*\(\s*business_id\s*\)\s*WHERE\s+status\s*=\s*'posted'/i.test(s4)) {
    ok("a partial UNIQUE (business_id) WHERE status = 'posted' makes two posted opening balances impossible (§24)");
  } else {
    fail('opening-uniqueness', 'accounting_opening_balances has no partial unique index on the posted status — the rule would be advisory (§24)');
  }

  // §28: supersession requires a reversal of the opening entry, at the DB
  // boundary rather than in the caller.
  if (/accounting\.supersede_without_reversal/.test(s4) && /FROM\s+accounting_reversals/i.test(s4)) {
    ok('supersession is refused unless the opening entry has been reversed, enforced in the database (§28)');
  } else {
    fail('supersede-rule', 'nothing at the database boundary requires a reversal before an opening balance may be superseded (§28)');
  }

  // §10: the journal has one status and a draft is never one of its rows.
  if (/INSERT\s+INTO\s+journal_entries[\s\S]{0,400}?'draft'/i.test(s4)) {
    fail('draft-journal', "a journal entry is written with a draft status — posted is the journal's only status (§10, §22)");
  } else {
    ok('no journal entry is ever written as a draft — the draft lives in accounting_opening_balances (§22, §37)');
  }

  // §11: the financial identity stays (business_id, source_type, source_id).
  // A parallel idempotency cache would mean two answers to "has this happened".
  if (/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?accounting_(?:idempotency|request|command)_/i.test(s4)) {
    fail('idempotency', 'a parallel idempotency table was created — the financial identity is (business_id, source_type, source_id) (§11)');
  } else {
    ok('no parallel idempotency registry: the source binding remains the single financial identity (§11)');
  }
}

// ── 3. Guards, widened for a second writer ─────────────────────────────────
function checkGuards(): void {
  console.log('P2-S4 GATE — guards');
  const schema = wholeTree();

  // §21: with a second SECURITY DEFINER journal writer, G-4 must protect EVERY
  // routine capable of a journal write, not one named primitive. The guard
  // discovers writers from the schema; this asserts it actually found both, so
  // a guard that silently stopped finding them fails here rather than passing.
  const writers = journalWriters(schema).map((r) => r.name);
  if (writers.length < 2) {
    fail(
      'guard-g4',
      `G-4 discovered ${writers.length} journal writer(s) (${writers.join(', ') || 'none'}) — P2-S4 adds a second one, so it must find both (§21)`,
    );
  } else if (!writers.includes('accounting_post_entry') || !writers.includes('accounting_post_reversal')) {
    fail('guard-g4', `G-4 found writers [${writers.join(', ')}] — both accounting_post_entry and accounting_post_reversal must be among them (§21)`);
  } else {
    ok(`G-4 protects every journal writer it can find: ${writers.join(', ')} (§21)`);
  }

  const violations = findPostingSurfaceViolations({ schema, appFiles: collectAppFiles() });
  if (violations.length > 0) for (const detail of violations) fail('guard-g4', detail);
  else
    ok('G-4 clean: every writer carries the full protection set, is granted only to the merchant runtime, and no application code writes the ledger directly');

  // §45: G-5 is permanent and must cover the NEW definers too.
  const migrations: Record<string, string> = {};
  for (const name of sqlFiles()) migrations[name] = readMigration(name);
  const manifest = JSON.parse(readFileSync(join(ROOT, 'infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8')) as { migrations: { name: string }[] };
  const g5 = findDefinerSearchPathViolations({
    migrations,
    bootstrap: readFileSync(join(ROOT, 'infrastructure/database/bootstrap.sql'), 'utf8'),
    frozen: new Set(manifest.migrations.map((m) => m.name)),
  });
  if (g5.length > 0) for (const detail of g5) fail('guard-g5', detail);
  else ok('G-5 clean: every new SECURITY DEFINER routine pins its path with pg_temp named LAST, and nothing creates a session relation (§45)');

  // §45 again, stated directly against the candidates: no runtime DML, no
  // temp-table design, no CREATE on public left behind.
  const s4 = stripComments(s4Sql());
  if (/CREATE\s+(?:TEMP|TEMPORARY|LOCAL\s+TEMP)\s/i.test(s4)) {
    fail('guard-g5', 'a P2-S4 migration creates a temporary relation — a session-scoped relation is exactly what pg_temp shadowing exploits (§45)');
  } else {
    ok('neither candidate creates a temporary relation');
  }
  if (/GRANT\s+CREATE\s+ON\s+SCHEMA\s+public/i.test(s4) && !/REVOKE\s+CREATE\s+ON\s+SCHEMA\s+public/i.test(s4)) {
    fail('schema-authority', 'a P2-S4 migration grants CREATE on schema public without revoking it — the elevated principal keeps schema authority');
  } else {
    ok('schema authority is returned: every CREATE grant on public is revoked before the migration ends');
  }

  // No runtime credential may hold DML on the new source tables either.
  const runtime = new Set<string>(RUNTIME_ROLES);
  let modelWriters = 0;
  for (const table of S4_TABLES) {
    const grants = INTENDED_TABLE_GRANTS[table];
    if (grants === undefined) {
      fail('grant-model', `${table} is not in the intended grant model — G-1 would not notice a grant on it (§50)`);
      continue;
    }
    for (const [grantee, privileges] of Object.entries(grants)) {
      for (const privilege of privileges) {
        if (runtime.has(grantee) && (WRITE_PRIVILEGES as readonly string[]).includes(privilege)) {
          fail(
            'runtime-dml',
            `the intended grant model gives the runtime role ${grantee} ${privilege} on ${table} — only the elevated commands write (AL-03/AL-18)`,
          );
          modelWriters += 1;
        }
      }
    }
  }
  if (modelWriters === 0) ok(`no runtime credential holds DML on any source table; the commands reach them only as ${INTERNAL_ROLE}`);
}

/**
 * Strip line and block comments and string literals from TypeScript source.
 *
 * Crude on purpose: this is a guard, not a parser, and everything it removes
 * is something a rule about CODE should not be reading anyway. Over-removal
 * can only make the guard quieter about prose, never about a real identifier.
 */
function stripTypeScriptComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/** Every non-test application and script source file, path → contents. */
function collectAppFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  const skip = new Set(['node_modules', 'dist', '.next', 'build', '.git', 'coverage']);
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) out[relative(ROOT, full)] = readFileSync(full, 'utf8');
    }
  };
  for (const dir of ['apps/api/src', 'packages/accounting/src', 'scripts']) {
    const full = join(ROOT, dir);
    if (existsSync(full)) walk(full);
  }
  return out;
}

// ── 4. The engine and the HTTP surface ─────────────────────────────────────
function checkEngineAndSurface(): void {
  console.log('P2-S4 GATE — the engine and the merchant surface');
  for (const module of S4_MODULES) {
    if (existsSync(join(ROOT, 'packages/accounting', module))) ok(`packages/accounting/${module}`);
    else fail('engine', `packages/accounting/${module} is missing — the source derivations belong in the engine, not in the API (§36)`);
  }

  // §38: no trusted path, anywhere in the engine or the adapters.
  //
  // CODE only. The engine documents at length why these seams do not exist,
  // and a check that read prose would fail on the very comments that explain
  // the rule — so comments and strings come out first, and this file, which
  // must name the forbidden identifiers to look for them, excludes itself.
  const appFiles = collectAppFiles();
  const forbidden = /\b(postTrusted|skipPermission|systemPost|rawWrite|allowInactive|skipAuthorization|forcePost)\b/;
  const selfPath = relative(ROOT, __filename).replace(/\\/g, '/');
  const offenders = Object.entries(appFiles)
    .filter(([path]) => path !== selfPath)
    .filter(([, body]) => forbidden.test(stripTypeScriptComments(body)));
  if (offenders.length > 0) {
    for (const [path] of offenders)
      fail('trusted-path', `${path} names a bypass seam — authority arrives as a minted assertion or the post does not happen (§38)`);
  } else {
    ok('no trusted path, no skip flag and no "allow inactive" switch anywhere in the engine or the adapters (§38)');
  }

  // §35: exactly three merchant endpoints, and no generic poster.
  const controller = join(ROOT, 'apps/api/src/modules/accounting/accounting.controller.ts');
  if (!existsSync(controller)) {
    fail('http-surface', 'apps/api/src/modules/accounting/accounting.controller.ts is missing — §35 fixes the merchant surface at three endpoints');
    return;
  }
  const body = readFileSync(controller, 'utf8');
  const routes = [...body.matchAll(/@(Post|Get|Put|Patch|Delete)\(\s*'([^']*)'\s*\)/g)].map((m) => `${m[1]} ${m[2]}`);
  const expected = ['Post adjustments', 'Post entries/:entryId/reversals', 'Post opening-balance'];
  if (routes.length !== expected.length || expected.some((r) => !routes.includes(r))) {
    fail('http-surface', `the accounting controller exposes [${routes.join(', ')}] — §35 authorizes exactly [${expected.join(', ')}]`);
  } else {
    ok('exactly three merchant endpoints: adjustments, reversals, opening balance (§35)');
  }
  if (/@(Post|Put|Patch)\(\s*'(post|entries|journal)'\s*\)/.test(body)) {
    fail('http-surface', 'a generic posting endpoint is exposed — §35 forbids /accounting/post');
  }

  // §36: money crosses HTTP as a decimal string, never a JS number.
  const contracts = join(ROOT, 'packages/shared-contracts/src/index.ts');
  if (existsSync(contracts)) {
    const dto = readFileSync(contracts, 'utf8');
    const section = dto.slice(dto.indexOf('AccountingLineDto'));
    if (/(?:baseAmountMinor|txnAmountMinor|fxRate)\??:\s*number/.test(section)) {
      fail('money-shape', 'an accounting DTO types money or a rate as a JS number — money crosses HTTP as a decimal string (§36)');
    } else {
      ok('every accounting DTO carries money and rates as strings (§36)');
    }
  }
}

// ── 5. Composed command matrix ──────────────────────────────────────────────
interface Step {
  readonly name: string;
  readonly cmd: string;
  readonly args: readonly string[];
}

const STEPS: readonly Step[] = [
  // Every predecessor is PERMANENT. The P2-S3 gate composes P2-S2, which
  // composes P2-S1, which composes Phase 1's, so running it once runs the
  // whole chain — and a regression anywhere in it fails here.
  { name: 'P2-S3 gate (permanent predecessor, composes P2-S2, P2-S1 and Phase 1)', cmd: npm, args: ['run', 'gate:phase2:s3'] },
  { name: 'migrations apply from zero under the migration principal', cmd: npm, args: ['run', 'check:db-from-zero'] },
  { name: '@daftar/accounting unit suite', cmd: npm, args: ['run', 'test', '-w', '@daftar/accounting'] },
  { name: 'P2-S4 source, concurrency, authority and upgrade matrices', cmd: 'npx', args: ['vitest', 'run', ...P2_S4_TESTS] },
];

function runSteps(): void {
  console.log('P2-S4 GATE — composed regression matrix');
  for (const step of STEPS) {
    const started = Date.now();
    const res = spawnSync(step.cmd, [...step.args], { cwd: ROOT, encoding: 'utf8', stdio: 'inherit', env: process.env });
    const ms = Date.now() - started;
    if (res.status !== 0) fail('regression', `${step.name} failed (exit ${res.status ?? 'signal'}) after ${ms}ms`);
    else ok(`${step.name} (${ms}ms)`);
  }
}

if (LIST_ONLY) {
  console.log('P2-S4 GATE plan:');
  console.log('  structural: 0046 and 0047 exist, nothing beyond them, both still candidates in the manifest');
  console.log('  structural: the five source tables and seven source commands exist; no FX registry, period or balance table was built early');
  console.log('  structural: the journal carries no reversal marker; reversal and opening-balance uniqueness are physical; supersession requires a reversal');
  console.log('  structural: G-4 protects EVERY journal writer, G-5 covers the new definers, no runtime DML on any source table');
  console.log('  structural: the engine owns the derivations, no bypass seam exists, exactly three merchant endpoints, money crosses HTTP as strings');
  for (const s of STEPS) console.log(`  command:    ${s.cmd} ${s.args.join(' ')}`);
  process.exit(0);
}

checkMigrationBoundary();
checkSurfaces();
checkGuards();
checkEngineAndSurface();
if (failures > 0) {
  console.error(`\nP2-S4 GATE: FAIL (${failures} structural violation${failures === 1 ? '' : 's'}) — not running the regression matrix`);
  process.exit(1);
}
runSteps();

if (failures > 0) {
  console.error(`\nP2-S4 GATE: FAIL (${failures})`);
  process.exit(1);
}
console.log('\nP2-S4 GATE: PASS');
