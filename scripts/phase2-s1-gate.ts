#!/usr/bin/env tsx
/**
 * PHASE 2 SLICE GATE — P2-S1 (directive §26; made permanent by the P2-S1
 * FREEZE directive §7).
 *
 * `npm run gate:phase2:s1` was the deterministic answer to "is the chart slice
 * actually done, and did it stay inside its boundary?". P2-S1 is now ACCEPTED
 * and FROZEN, so the question it answers has changed tense: "is the accepted
 * chart slice still exactly what was accepted?". It is a PERMANENT regression
 * gate.
 *
 * Two consequences follow, and they are the whole point of the transition:
 *
 *  - 0040 and 0041 MUST now be frozen, at the accepted hashes. The gate carries
 *    its own copy of those hashes, so editing the migration and the manifest in
 *    the same commit still fails here.
 *  - The gate MUST NOT block later authorized slices. 0042, 0043 and their
 *    successors are legitimate; this gate has no opinion about them beyond the
 *    rules that are permanent anyway (G-3, authority isolation, AL-06). The
 *    slice-boundary check is therefore scoped to P2-S1's own two files: it
 *    proves P2-S1 did not contain a journal, not that the repository never
 *    will.
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

/**
 * P2-S1's two migrations, with the bytes the Tech Lead accepted at
 * 18d2d1c0d38a726c503ce4b6cafe833de28a1bf6. Held here as a second, independent
 * copy of the manifest's hashes — a single source would let one commit move the
 * migration and its recorded hash together.
 */
const S1_MIGRATIONS = {
  '0040_accounting_chart.sql': '535c8182a922a8363df2c791759c3e1eff2790757e402e6e28a41a5d113651db',
  '0041_accounting_permissions.sql': '3aea7eedfd6ccb9d8fd93ed827d84abaa9923ccd3b01497960237098c19b1f77',
} as const;
const S1_MIGRATION_NAMES = Object.keys(S1_MIGRATIONS) as (keyof typeof S1_MIGRATIONS)[];

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
  'tests/integration/migration-portability.test.ts',
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

  // The accepted bytes, checked against disk directly rather than against the
  // manifest — the manifest is checked separately, below, and the two have to
  // agree with the same third value for either to mean anything.
  for (const name of S1_MIGRATION_NAMES) {
    if (!files.includes(name)) {
      fail('accepted-bytes', `${name} is missing — P2-S1 is accepted history and its files may not be removed`);
      continue;
    }
    const sha = createHash('sha256')
      .update(readFileSync(join(MIGRATIONS_DIR, name)))
      .digest('hex');
    if (sha !== S1_MIGRATIONS[name]) {
      fail(
        'accepted-bytes',
        `${name} no longer matches the accepted P2-S1 bytes (expected ${S1_MIGRATIONS[name]}, got ${sha}) — a defect in frozen history needs a NEW migration`,
      );
    } else {
      ok(`${name} byte-for-byte as accepted (sha256 ${sha})`);
    }
  }

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
  if (drifted === 0) ok(`${manifest.migrations.length} frozen migrations byte-for-byte unchanged`);

  // P2-S1 is ACCEPTED, so the freeze is now the rule rather than the thing
  // being withheld. The manifest must carry the accepted hashes, not merely
  // some hash of the current file.
  const frozen = new Map(manifest.migrations.map((m) => [m.name, m.sha256]));
  for (const name of S1_MIGRATION_NAMES) {
    const recorded = frozen.get(name);
    if (recorded === undefined) {
      fail('frozen-p2s1', `${name} is not in MIGRATION_MANIFEST.json — accepted P2-S1 migrations are frozen history (freeze directive §6)`);
    } else if (recorded !== S1_MIGRATIONS[name]) {
      fail('frozen-p2s1', `${name} is frozen at ${recorded}, but the accepted hash is ${S1_MIGRATIONS[name]}`);
    } else {
      ok(`${name} frozen at its accepted hash`);
    }
  }
  if (manifest.frozenThrough < '0041_accounting_permissions.sql') {
    fail('frozen-p2s1', `frozenThrough is ${manifest.frozenThrough} — it must include P2-S1 (0041_accounting_permissions.sql or later)`);
  } else {
    ok(`frozenThrough = ${manifest.frozenThrough} — P2-S1 is release history`);
  }

  // Deliberately NOT checked: whether 0042+ exists. This gate is permanent and
  // must never be the reason an authorized later slice cannot land (§7).
  const later = files.filter((f) => f.slice(0, 4) > '0041');
  ok(
    later.length === 0
      ? 'no migration after 0041 yet (not a requirement of this gate)'
      : `${later.length} later migration(s) present — out of scope for the P2-S1 gate`,
  );
}

// ── 2. Slice boundary: P2-S1 itself contains no later slice ─────────────────
//
// Scoped to 0040/0041. Before acceptance this scanned the whole tree, because
// the whole tree WAS the slice. Now that P2-S1 is frozen the honest claim is
// narrower and permanent: the accepted chart slice shipped no journal, no
// binding registry and no posting primitive. Whether 0042 adds them is P2-S2's
// gate to judge, not this one's (§7).
function checkSliceBoundary(): void {
  console.log('P2-S1 GATE — slice boundary');
  const sliceSql = S1_MIGRATION_NAMES.filter((f) => sqlFiles().includes(f))
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n');
  let leaked = 0;
  for (const surface of FUTURE_SLICE_SURFACES) {
    const re = new RegExp(`CREATE\\s+(?:TABLE|OR\\s+REPLACE\\s+FUNCTION|FUNCTION)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${surface}\\b`, 'i');
    if (re.test(sliceSql)) {
      fail('slice-boundary', `${surface} is created by a P2-S1 migration — the accepted chart slice contained no such surface`);
      leaked += 1;
    }
  }
  if (leaked === 0) ok('accepted P2-S1 migrations create no journal, binding registry or posting primitive');

  // AL-06 is a permanent accounting decision, not a slice boundary: system
  // accounts localize through i18n keys, in every slice. So this one scans the
  // whole tree, forever.
  const schema = sqlFiles()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n');
  if (/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?account_translations\b/i.test(schema)) {
    fail('slice-boundary', 'account_translations exists — AL-06 resolved that system accounts localize through i18n keys');
  } else {
    ok('AL-06 holds: no account_translations table anywhere in the migration tree');
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
  console.log('  structural: accepted-byte freeze, slice boundary, 21-key registry, guard G-3, authority isolation');
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
