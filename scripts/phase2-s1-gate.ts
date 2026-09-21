#!/usr/bin/env tsx
/**
 * PHASE 2 SLICE GATE — P2-S1 (directive §26).
 *
 * `npm run gate:phase2:s1` is the deterministic answer to "is the chart slice
 * actually done, and did it stay inside its boundary?". It refuses a tree in
 * which the slice is incomplete OR in which a later slice has leaked in.
 *
 * Structural checks run first — they are instant, and there is no point
 * running a test suite against a tree that already broke the migration
 * boundary. Then it composes the existing Phase 1 machine gates rather than
 * re-implementing them, and finally runs the P2-S1 suites.
 *
 * Usage: npm run gate:phase2:s1 [-- --list]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { findAuthoritativeBalanceColumns } from './guards/no-authoritative-balance';
import { CHART_TABLES, INTERNAL_ROLE, findAuthorityViolations } from './guards/authority-isolation';

const ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(ROOT, 'infrastructure/database/migrations');
const LIST_ONLY = process.argv.slice(2).includes('--list');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const S1_MIGRATIONS = ['0040_accounting_chart.sql', '0041_accounting_permissions.sql'] as const;

/** The 21 Phase 2 system identities, from docs/DAFTAR_ACCOUNTING_RULES.md §2. */
const REGISTRY: readonly (readonly [string, string, string])[] = [
  ['cash', '1000', 'asset'],
  ['bank', '1010', 'asset'],
  ['card_clearing', '1020', 'asset'],
  ['wallet_clearing', '1030', 'asset'],
  ['cheque_clearing', '1040', 'asset'],
  ['accounts_receivable', '1100', 'asset'],
  ['supplier_receivable', '1150', 'asset'],
  ['inventory', '1200', 'asset'],
  ['accounts_payable', '2000', 'liability'],
  ['tax_payable', '2100', 'liability'],
  ['customer_refund_liability', '2200', 'liability'],
  ['customer_credit_liability', '2210', 'liability'],
  ['opening_equity', '3000', 'equity'],
  ['sales_revenue', '4000', 'revenue'],
  ['sales_returns', '4100', 'revenue'],
  ['discounts', '4200', 'revenue'],
  ['fx_gain', '4900', 'revenue'],
  ['cogs', '5000', 'expense'],
  ['rounding', '6100', 'expense'],
  ['purchase_price_variance', '6200', 'expense'],
  ['fx_loss', '6900', 'expense'],
];

/** Surfaces that belong to P2-S2 and later. Their presence is a scope breach. */
const FUTURE_SLICE_SURFACES = ['journal_entries', 'journal_lines', 'accounting_source_bindings', 'accounting_source_types', 'accounting_post_entry'] as const;

const P2_S1_TESTS = [
  'tests/integration/accounting-chart.test.ts',
  'tests/integration/accounting-permissions.test.ts',
  'tests/integration/accounting-guards.test.ts',
  'tests/integration/migration-upgrade.test.ts',
  'tests/security/accounting-boundary.test.ts',
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

// ── 1. Migration boundary ───────────────────────────────────────────────────
function checkMigrationBoundary(): void {
  console.log('P2-S1 GATE — migration boundary');
  const files = sqlFiles();
  for (const name of S1_MIGRATIONS) {
    if (!files.includes(name)) fail('migration-present', `${name} is missing — P2-S1 is not implemented`);
    else
      ok(
        `${name} present (sha256 ${createHash('sha256')
          .update(readFileSync(join(MIGRATIONS_DIR, name)))
          .digest('hex')})`,
      );
  }
  const beyond = files.filter((f) => f.slice(0, 4) > '0041');
  if (beyond.length > 0) fail('no-0042', `migration(s) beyond 0041 exist — P2-S2 is unauthorized: ${beyond.join(', ')}`);
  else ok('no 0042+ migration exists');

  const manifest = JSON.parse(readFileSync(join(ROOT, 'infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8')) as {
    frozenThrough: string;
    migrations: { name: string; sha256: string }[];
  };
  let drifted = 0;
  for (const entry of manifest.migrations) {
    if (!files.includes(entry.name)) {
      fail('frozen-history', `frozen migration deleted: ${entry.name}`);
      drifted += 1;
      continue;
    }
    const sha = createHash('sha256')
      .update(readFileSync(join(MIGRATIONS_DIR, entry.name)))
      .digest('hex');
    if (sha !== entry.sha256) {
      fail('frozen-history', `frozen migration modified: ${entry.name}`);
      drifted += 1;
    }
  }
  if (drifted === 0) ok(`${manifest.migrations.length} frozen Phase 1 migrations byte-for-byte unchanged`);
  // 0040/0041 stay candidates until Tech Lead approval is the freeze boundary (§3, §30).
  const frozen = new Set(manifest.migrations.map((m) => m.name));
  for (const name of S1_MIGRATIONS) {
    if (frozen.has(name)) fail('candidate-migrations', `${name} was frozen before Tech Lead acceptance (§3)`);
  }
  if (manifest.frozenThrough !== '0039_catalog_identifiers_owner_integrity.sql') {
    fail('candidate-migrations', `frozenThrough moved past 0039 (${manifest.frozenThrough}) — P2-S1 migrations are candidates, not release history`);
  } else {
    ok('0040/0041 are candidate migrations — frozenThrough still 0039');
  }
}

// ── 2. Slice boundary: nothing from a later slice may exist ─────────────────
function checkSliceBoundary(): void {
  console.log('P2-S1 GATE — slice boundary');
  const schema = sqlFiles()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n');
  let leaked = 0;
  for (const surface of FUTURE_SLICE_SURFACES) {
    const re = new RegExp(`CREATE\\s+(?:TABLE|OR\\s+REPLACE\\s+FUNCTION|FUNCTION)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${surface}\\b`, 'i');
    if (re.test(schema)) {
      fail('slice-boundary', `${surface} exists — that is P2-S2/P2-S3 and is unauthorized in this slice`);
      leaked += 1;
    }
  }
  if (leaked === 0) ok('no journal, binding registry or posting primitive in the tree');
  if (/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?account_translations\b/i.test(schema)) {
    fail('slice-boundary', 'account_translations exists — AL-06 resolved that system accounts localize through i18n keys');
  }
}

// ── 3. The registry is complete and exact ───────────────────────────────────
function checkRegistry(): void {
  console.log('P2-S1 GATE — system account registry');
  const sql = readFileSync(join(MIGRATIONS_DIR, '0040_accounting_chart.sql'), 'utf8');
  let missing = 0;
  for (const [key, code, type] of REGISTRY) {
    const re = new RegExp(`\\('${key}'\\s*,\\s*'${type}'\\s*,\\s*'${code}'`);
    if (!re.test(sql)) {
      fail('registry-complete', `system identity ${key} (${code}, ${type}) is not seeded by 0040`);
      missing += 1;
    }
  }
  const seeded = (sql.match(/\('[a-z_]+',\s*'(asset|liability|equity|revenue|expense)',\s*'\d{4}'/g) ?? []).length;
  if (seeded !== REGISTRY.length) fail('registry-complete', `0040 seeds ${seeded} system identities, expected exactly ${REGISTRY.length}`);
  if (missing === 0 && seeded === REGISTRY.length) ok(`all ${REGISTRY.length} system account identities seeded, and no extras`);
}

// ── 4. Guard G-3 is present and passing ─────────────────────────────────────
function checkGuardG3(): void {
  console.log('P2-S1 GATE — guard G-3');
  const guards = readFileSync(join(ROOT, 'scripts/static-guards.ts'), 'utf8');
  if (!/findAuthoritativeBalanceColumns/.test(guards)) {
    fail('guard-g3', 'static-guards.ts does not run the G-3 no-authoritative-balance rule');
    return;
  }
  const offenders = sqlFiles().flatMap((f) =>
    findAuthoritativeBalanceColumns(readFileSync(join(MIGRATIONS_DIR, f), 'utf8')).map(
      (h) => `${relative(ROOT, join(MIGRATIONS_DIR, f))}: ${h.table}.${h.column}`,
    ),
  );
  if (offenders.length > 0) for (const o of offenders) fail('guard-g3', o);
  else ok('G-3 wired into static-guards.ts and clean across the migration tree');
}

// ── 5. Authority isolation (security correction §16) ────────────────────────
//
// The rule lives in scripts/guards/authority-isolation.ts so it can be
// regression-tested directly (tests/integration/accounting-guards.test.ts):
// a guard that has never been shown to fail is not a guard.
function checkAuthorityIsolation(): void {
  console.log('P2-S1 GATE — authority isolation');
  const violations = findAuthorityViolations({
    schema: sqlFiles()
      .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
      .join('\n'),
    chartSql: readFileSync(join(MIGRATIONS_DIR, '0040_accounting_chart.sql'), 'utf8'),
    bootstrap: readFileSync(join(ROOT, 'infrastructure/database/bootstrap.sql'), 'utf8'),
  });
  if (violations.length > 0) {
    for (const detail of violations) fail('authority-isolation', detail);
    return;
  }
  ok(`no LOGIN role (nor PUBLIC) holds INSERT/UPDATE/DELETE on ${CHART_TABLES.join(' or ')}`);
  ok('no principal holds UPDATE, DELETE or TRUNCATE on accounts');
  ok(`both seeding routines owned by ${INTERNAL_ROLE}, EXECUTE revoked from PUBLIC and from every login role`);
  ok(`${INTERNAL_ROLE} is NOLOGIN, passwordless, unelevated and granted to nobody`);
  ok('app_bypass() untouched by P2-S1, and no BYPASSRLS in the slice');
}

// ── 6. Composed command matrix ──────────────────────────────────────────────
interface Step {
  readonly name: string;
  readonly cmd: string;
  readonly args: readonly string[];
}

const STEPS: readonly Step[] = [
  { name: 'migration manifest', cmd: npm, args: ['run', 'check:migrations'] },
  { name: 'static guards (incl. G-3)', cmd: npm, args: ['run', 'check:guards'] },
  { name: 'localization parity', cmd: npm, args: ['run', 'check:localization'] },
  { name: 'Phase 1 gate', cmd: npm, args: ['run', 'gate:phase1'] },
  { name: 'domain-core unit tests (permission registry)', cmd: npm, args: ['test', '-w', '@daftar/domain-core'] },
  { name: 'P2-S1 database, security and guard suites', cmd: 'npx', args: ['vitest', 'run', ...P2_S1_TESTS] },
];

function runSteps(): void {
  console.log('P2-S1 GATE — composed regression matrix');
  for (const step of STEPS) {
    const started = Date.now();
    const res = spawnSync(step.cmd, [...step.args], { cwd: ROOT, encoding: 'utf8', stdio: 'inherit', env: process.env });
    const ms = Date.now() - started;
    if (res.status !== 0) fail('regression', `${step.name} failed (exit ${res.status ?? 'signal'}) after ${ms}ms`);
    else ok(`${step.name} (${ms}ms)`);
  }
}

if (LIST_ONLY) {
  console.log('P2-S1 GATE plan:');
  console.log('  structural: migration boundary, slice boundary, 21-key registry, guard G-3, authority isolation');
  for (const s of STEPS) console.log(`  command:    ${s.cmd} ${s.args.join(' ')}`);
  process.exit(0);
}

checkMigrationBoundary();
checkSliceBoundary();
checkRegistry();
checkGuardG3();
checkAuthorityIsolation();
if (failures > 0) {
  console.error(`\nP2-S1 GATE: FAIL (${failures} structural violation${failures === 1 ? '' : 's'}) — not running the regression matrix`);
  process.exit(1);
}
runSteps();

if (failures > 0) {
  console.error(`\nP2-S1 GATE: FAIL (${failures})`);
  process.exit(1);
}
console.log('\nP2-S1 GATE: PASS');
