#!/usr/bin/env tsx
/**
 * PHASE 3 SLICE GATE — P3-S2, the immutable stock ledger
 * (docs/PHASE_3_EXECUTION_PLAN.md §4, docs/PHASE_3_S2_CONTRACT.md §7.1).
 *
 * `npm run gate:phase3:s2` is the deterministic answer to "is P3-S2 exactly the
 * ledger the contract describes, and did it stay inside its boundary?".
 *
 * The gate has two tenses, chosen by `S2_ACCEPTED` alone:
 *
 *   — CANDIDATE (`S2_ACCEPTED` empty): `frozenThrough` is still the P3-S1
 *     boundary, neither S2 migration is in the manifest (no premature freeze),
 *     and the only migrations after 0058 are exactly 0059 and 0060.
 *   — ACCEPTED (`S2_ACCEPTED` holds both digests): `frozenThrough` is a FLOOR at
 *     0060, each S2 migration hashes to its accepted digest on disk AND in the
 *     manifest, and 0059–0060 hold exactly those two files. A successor after
 *     0060 is not this gate's business: a gate for an accepted slice must never
 *     be the reason a later authorized slice cannot land.
 *
 * Freezing P3-S2 is therefore one edit here (the two digests) and one in the
 * manifest, from two independent sources.
 *
 * Structural checks, each instant:
 *
 *   — scope: no source type, no operation→movement mapping, no operation kind
 *     is registered; no EXECUTE is granted to anyone; no P3-S3+ table and no
 *     `reserved`/`available` column exists;
 *   — required objects: the ledger tables and registries, the trigger set, the
 *     trusted routines, the CREATE-on-public bracket around the ownership
 *     transfer, and the owner replacing `inventory_configure_product`;
 *   — the package: fixed-point modules and the shared `invval/1` vectors with
 *     their exact identifiers, and no framework or driver import;
 *   — every P3-S2 suite exists.
 *
 * Then it proves the runner can still report failure, composes the permanent
 * predecessor (`gate:phase3:s1`, which composes the whole chain back to Phase 1)
 * and runs every P3-S2 suite.
 *
 * Usage: npm run gate:phase3:s2 [-- --list]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './guards/sql-schema';

const ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(ROOT, 'infrastructure/database/migrations');
const LIST_ONLY = process.argv.slice(2).includes('--list');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** The P3-S1 boundary, which P3-S2 sits directly on. */
const S1_BOUNDARY = '0058_accounting_entry_date_guard.sql';

/** The P3-S2 migrations, in order. */
const S2_MIGRATIONS = ['0059_inventory_stock_ledger.sql', '0060_inventory_stock_primitive.sql'] as const;

/** The P3-S2 acceptance boundary. A floor once accepted. */
const S2_BOUNDARY = S2_MIGRATIONS[S2_MIGRATIONS.length - 1];

/**
 * The two P3-S2 migrations at their accepted digests. Empty while P3-S2 is a
 * candidate; filled in the freeze commit only, as a second source independent
 * of MIGRATION_MANIFEST.json.
 */
const S2_ACCEPTED: Readonly<Record<string, string>> = {};

const ACCEPTED = Object.keys(S2_ACCEPTED).length > 0;

/** Operation kinds the lock reserves for P3-S3 (P3-AL-55 §E). */
const LATER_OPERATION_KINDS = [
  'inventory.transfer',
  'inventory.adjust',
  'inventory.damage',
  'inventory.stocktake_open',
  'inventory.stocktake_count',
  'inventory.stocktake_finalize',
  'inventory.opening',
] as const;

/** Registrations P3-S2 must leave empty: each belongs to the slice that adds its producer. */
const FORBIDDEN_REGISTRATIONS = /INSERT\s+INTO\s+(stock_source_types|inventory_operation_movement_kinds|inventory_operation_kinds)\b/i;

/** Tables owned by P3-S3 and later (plan §5–§8). */
const LATER_TABLES =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(negative_inventory_cost_adjustments|purchase\w*|supplier\w*|inventory_transfer\w*|stocktake\w*|stock_source_bridge_\w+)\b/i;

/** Named objects the contract requires (§2.2–§2.5), and the S2 migration that must define each. */
const REQUIRED_OBJECTS: readonly (readonly [string, (typeof S2_MIGRATIONS)[number], RegExp])[] = [
  ['stock_movement_kinds registry', '0059_inventory_stock_ledger.sql', /CREATE TABLE stock_movement_kinds\b/],
  ['stock_source_types registry', '0059_inventory_stock_ledger.sql', /CREATE TABLE stock_source_types\b/],
  ['inventory_operation_movement_kinds registry', '0059_inventory_stock_ledger.sql', /CREATE TABLE inventory_operation_movement_kinds\b/],
  ['stock_levels', '0059_inventory_stock_ledger.sql', /CREATE TABLE stock_levels\b/],
  ['stock_movements', '0059_inventory_stock_ledger.sql', /CREATE TABLE stock_movements\b/],
  ['stock_source_bindings', '0059_inventory_stock_ledger.sql', /CREATE TABLE stock_source_bindings\b/],
  ['negative_inventory_deficits', '0059_inventory_stock_ledger.sql', /CREATE TABLE negative_inventory_deficits\b/],
  ['negative_deficit_coverages', '0059_inventory_stock_ledger.sql', /CREATE TABLE negative_deficit_coverages\b/],
  ['stock_ledger_append_only()', '0059_inventory_stock_ledger.sql', /FUNCTION stock_ledger_append_only\(/],
  ['stock_levels_retain()', '0059_inventory_stock_ledger.sql', /FUNCTION stock_levels_retain\(/],
  ['inventory_stock_source_guard_gaps()', '0059_inventory_stock_ledger.sql', /FUNCTION inventory_stock_source_guard_gaps\(/],
  ['trigger stock_movements_append_only', '0059_inventory_stock_ledger.sql', /CREATE TRIGGER stock_movements_append_only\b/],
  ['trigger stock_source_bindings_append_only', '0059_inventory_stock_ledger.sql', /CREATE TRIGGER stock_source_bindings_append_only\b/],
  ['trigger negative_deficit_coverages_append_only', '0059_inventory_stock_ledger.sql', /CREATE TRIGGER negative_deficit_coverages_append_only\b/],
  ['trigger stock_levels_retain', '0059_inventory_stock_ledger.sql', /CREATE TRIGGER stock_levels_retain\b/],
  ['type inventory_movement_request', '0060_inventory_stock_primitive.sql', /CREATE TYPE inventory_movement_request\b/],
  ['R1 inventory_half_even', '0060_inventory_stock_primitive.sql', /FUNCTION inventory_half_even\(/],
  ['R2 inventory_quantity_is_representable', '0060_inventory_stock_primitive.sql', /FUNCTION inventory_quantity_is_representable\(/],
  ['R3 inventory_apply_stock_movements', '0060_inventory_stock_primitive.sql', /FUNCTION inventory_apply_stock_movements\(/],
  ['R4 inventory_next_deficit_seq', '0060_inventory_stock_primitive.sql', /FUNCTION inventory_next_deficit_seq\(/],
  ['R5 inventory_stock_fold', '0060_inventory_stock_primitive.sql', /FUNCTION inventory_stock_fold\(/],
  ['R6 inventory_stock_verify', '0060_inventory_stock_primitive.sql', /FUNCTION inventory_stock_verify\(/],
  ['R7 trigger products_20_unit_history_lock', '0060_inventory_stock_primitive.sql', /CREATE TRIGGER products_20_unit_history_lock\b/],
  [
    'R8 constraint trigger stock_levels_zero_on_hand_zero_value (deferred)',
    '0060_inventory_stock_primitive.sql',
    /CREATE CONSTRAINT TRIGGER stock_levels_zero_on_hand_zero_value[\s\S]*?DEFERRABLE INITIALLY DEFERRED/,
  ],
  ['trigger product_variants_20_stock_identity_lock', '0060_inventory_stock_primitive.sql', /CREATE TRIGGER product_variants_20_stock_identity_lock\b/],
  [
    'the owner replaces inventory_configure_product',
    '0060_inventory_stock_primitive.sql',
    /SET LOCAL ROLE daftar_inventory_internal;[\s\S]*?CREATE OR REPLACE FUNCTION inventory_configure_product\(/,
  ],
];

const PACKAGE_MODULES = ['fixed-point', 'rounding', 'quantity', 'valuation', 'rebuild'].map((m) => `packages/inventory/src/${m}.ts`);
const VECTORS = 'packages/inventory/vectors/valuation-vectors.json';
const PRECISION_IDS = Array.from({ length: 10 }, (_, i) => `P-${String(i + 1).padStart(2, '0')}`);
const SCENARIO_IDS = [
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'I',
  'AL08-RECEIPT',
  'AL08-TRANSFER-GOLD44',
  'AL08-ADJ-POS',
  'AL08-ADJ-NEG',
  'AL08-CATCHUP-GOLD54',
  'AL08-CATCHUP-GOLD55',
  'AL08-CATCHUP-GOLD72',
];

/** Every P3-S2 suite (contract §8). Existence is checked structurally; each one runs below. */
const P3_S2_TESTS = [
  'tests/security/stock-ledger-authority.test.ts',
  'tests/security/stock-ledger-structure.test.ts',
  'tests/integration/stock-ledger-primitive.test.ts',
  'tests/integration/stock-ledger-vectors.test.ts',
  'tests/integration/stock-ledger-rebuild.test.ts',
  'tests/integration/stock-ledger-concurrency.test.ts',
  'tests/integration/stock-ledger-unit-lock.test.ts',
  'tests/integration/stock-ledger-guards.test.ts',
];

/** Discovered, not listed: every stock-ledger suite any P3-S2 agent added. */
const discoveredLedgerSuites = (): string[] =>
  ['tests/integration', 'tests/security']
    .flatMap((dir) =>
      readdirSync(join(ROOT, dir))
        .filter((f) => /^stock-ledger-.*\.test\.ts$/.test(f))
        .map((f) => `${dir}/${f}`),
    )
    .sort();

let failures = 0;
const fail = (check: string, detail: string): void => {
  failures += 1;
  console.error(`  FAIL [${check}] ${detail}`);
};
const ok = (detail: string): void => console.log(`  ok      ${detail}`);

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const sqlFiles = (): string[] =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
const migration = (name: string): string | null => {
  const path = join(MIGRATIONS_DIR, name);
  return existsSync(path) ? stripComments(readFileSync(path, 'utf8')) : null;
};
const stripTsProse = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

// ── 1. Migration boundary ───────────────────────────────────────────────────
function checkMigrationBoundary(): void {
  console.log(`P3-S2 GATE — migration boundary (${ACCEPTED ? 'accepted' : 'candidate'})`);
  const manifest = JSON.parse(read('infrastructure/database/MIGRATION_MANIFEST.json')) as {
    frozenThrough: string;
    migrations: { name: string; sha256: string }[];
  };
  const recorded = new Map(manifest.migrations.map((m) => [m.name, m.sha256]));

  for (const name of S2_MIGRATIONS) {
    if (!existsSync(join(MIGRATIONS_DIR, name))) fail('boundary', `${name} is missing`);
  }

  if (!ACCEPTED) {
    if (manifest.frozenThrough !== S1_BOUNDARY) {
      fail('boundary', `frozenThrough is ${manifest.frozenThrough} — a P3-S2 candidate sits on the P3-S1 boundary ${S1_BOUNDARY}`);
    } else {
      ok(`frozenThrough = ${S1_BOUNDARY} — P3-S2 is not frozen`);
    }
    for (const name of S2_MIGRATIONS) {
      if (recorded.has(name)) fail('boundary', `${name} is in the manifest before P3-S2 was accepted — premature freeze`);
    }
    const after = sqlFiles().filter((f) => f > S1_BOUNDARY);
    if (JSON.stringify(after) !== JSON.stringify([...S2_MIGRATIONS])) {
      fail('boundary', `after 0058 a P3-S2 candidate holds exactly ${S2_MIGRATIONS.join(', ')} — found ${after.join(', ') || 'none'}`);
    } else {
      ok('after 0058 the tree holds exactly the two P3-S2 migrations');
    }
    return;
  }

  if (manifest.frozenThrough < S2_BOUNDARY) {
    fail('boundary', `frozenThrough is ${manifest.frozenThrough} — P3-S2 was accepted and frozen, so it must be at least ${S2_BOUNDARY}`);
  } else {
    ok(`frozenThrough = ${manifest.frozenThrough} — at or beyond the P3-S2 acceptance boundary`);
  }
  if (JSON.stringify(Object.keys(S2_ACCEPTED).sort()) !== JSON.stringify([...S2_MIGRATIONS])) {
    fail('boundary', `S2_ACCEPTED must name exactly ${S2_MIGRATIONS.join(', ')}`);
  }
  const before = failures;
  for (const [name, accepted] of Object.entries(S2_ACCEPTED)) {
    const path = join(MIGRATIONS_DIR, name);
    if (!existsSync(path)) continue;
    const onDisk = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (onDisk !== accepted) fail('boundary', `${name} hashes to ${onDisk.slice(0, 12)}… on disk but was accepted at ${accepted.slice(0, 12)}…`);
    const inManifest = recorded.get(name);
    if (inManifest === undefined) fail('boundary', `${name} was accepted but is not frozen in the manifest`);
    else if (inManifest !== accepted)
      fail('boundary', `${name} is recorded as ${inManifest.slice(0, 12)}… in the manifest but was accepted at ${accepted.slice(0, 12)}…`);
  }
  if (failures === before) ok(`the ${S2_MIGRATIONS.length} P3-S2 migrations hash to their accepted digests on disk and in the manifest`);

  const inRange = sqlFiles().filter((f) => f > S1_BOUNDARY && f <= S2_BOUNDARY);
  if (JSON.stringify(inRange) !== JSON.stringify([...S2_MIGRATIONS])) {
    fail('boundary', `0059–0060 must hold exactly ${S2_MIGRATIONS.join(', ')} — found ${inRange.join(', ') || 'none'}`);
  } else {
    ok('0059–0060 holds exactly the two accepted files');
  }
}

// ── 2. Scope: nothing from a later slice ─────────────────────────────────────
function checkScope(): void {
  console.log('P3-S2 GATE — slice scope');
  const before = failures;
  for (const name of S2_MIGRATIONS) {
    const sql = migration(name);
    if (sql === null) continue;
    const registration = FORBIDDEN_REGISTRATIONS.exec(sql);
    if (registration) fail('scope', `${name} registers into ${registration[1]} — each registration belongs to the slice that adds its producer`);
    if (/\bGRANT\s+EXECUTE\b/i.test(sql)) fail('scope', `${name} grants EXECUTE — P3-S2 reaches no runtime principal (A-01)`);
    const table = LATER_TABLES.exec(sql);
    if (table) fail('scope', `${name} creates ${table[1]} — it belongs to a later slice`);
    if (/^\s*(reserved|available)\s+[A-Z]/im.test(sql)) fail('scope', `${name} defines a reserved/available column — L:1274 forbids it`);
    for (const kind of LATER_OPERATION_KINDS) {
      if (sql.includes(`'${kind}'`)) fail('scope', `${name} names operation kind ${kind} — P3-AL-55 §E reserves it for P3-S3`);
    }
  }
  if (failures === before) ok('no registration, no EXECUTE grant, no later-slice table or column, no P3-S3 operation kind');
}

// ── 3. Required objects ─────────────────────────────────────────────────────
function checkRequiredObjects(): void {
  console.log('P3-S2 GATE — required objects (contract §2.2–§2.5)');
  for (const [label, file, pattern] of REQUIRED_OBJECTS) {
    const sql = migration(file);
    if (sql !== null && pattern.test(sql)) ok(label);
    else fail('objects', `${label} is not created by ${file}`);
  }
  // Every ownership transfer is bracketed in its own file (P3-AL-54 §J).
  for (const name of S2_MIGRATIONS) {
    const sql = migration(name);
    if (sql === null || !/OWNER TO daftar_inventory_internal/.test(sql)) continue;
    const granted = sql.indexOf('GRANT CREATE ON SCHEMA public TO daftar_inventory_internal');
    const revoked = sql.lastIndexOf('REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal');
    const firstTransfer = sql.indexOf('OWNER TO daftar_inventory_internal');
    const lastTransfer = sql.lastIndexOf('OWNER TO daftar_inventory_internal');
    if (granted < 0 || revoked < 0 || granted > firstTransfer || revoked < lastTransfer) {
      fail('objects', `${name} hands ownership to the internal role outside a GRANT/REVOKE CREATE ON SCHEMA public bracket`);
    } else {
      ok(`${name}: ownership transfer bracketed by GRANT/REVOKE CREATE ON SCHEMA public`);
    }
  }
  if (/CREATE ROLE/i.test(migration(S2_MIGRATIONS[0]) ?? '') || /CREATE ROLE/i.test(migration(S2_MIGRATIONS[1]) ?? '')) {
    fail('objects', 'a P3-S2 migration creates a role — roles belong to bootstrap');
  }
}

// ── 4. The package ──────────────────────────────────────────────────────────
function checkPackage(): void {
  console.log('P3-S2 GATE — @daftar/inventory fixed-point arithmetic and invval/1');
  for (const path of [...PACKAGE_MODULES, VECTORS]) {
    if (existsSync(join(ROOT, path))) ok(path);
    else fail('package', `${path} is missing`);
  }
  if (existsSync(join(ROOT, VECTORS))) {
    const vectors = JSON.parse(read(VECTORS)) as { version?: string; precision?: { id: string }[]; scenarios?: { id: string }[] };
    const precision = (vectors.precision ?? []).map((v) => v.id);
    const scenarios = (vectors.scenarios ?? []).map((v) => v.id);
    if (JSON.stringify(precision) !== JSON.stringify(PRECISION_IDS))
      fail('package', `precision vectors must be exactly ${PRECISION_IDS.join(',')} — found ${precision.join(',')}`);
    else ok(`${precision.length} precision vectors`);
    if (JSON.stringify(scenarios) !== JSON.stringify(SCENARIO_IDS))
      fail('package', `scenario vectors must be exactly ${SCENARIO_IDS.join(',')} — found ${scenarios.join(',')}`);
    else ok(`${scenarios.length} scenario vectors`);
  }
  const src = join(ROOT, 'packages/inventory/src');
  for (const f of readdirSync(src).filter((n) => n.endsWith('.ts'))) {
    const code = stripTsProse(readFileSync(join(src, f), 'utf8'));
    for (const m of code.matchAll(/\bfrom\s+'([^']+)'/g)) {
      const spec = m[1] ?? '';
      if (!spec.startsWith('./') && !spec.startsWith('node:'))
        fail('package', `packages/inventory/src/${f} imports ${spec} — the package is framework- and driver-free`);
    }
  }
  ok('packages/inventory/src imports only itself and node: built-ins');
}

// ── 5. Every behavioural claim has a suite ─────────────────────────────────
function checkSuites(): void {
  console.log('P3-S2 GATE — behavioural suites');
  for (const path of P3_S2_TESTS) {
    if (existsSync(join(ROOT, path))) ok(path);
    else fail('suite', `${path} is missing`);
  }
  if (!existsSync(join(ROOT, 'tests/helpers/stock-ledger.ts'))) fail('suite', 'tests/helpers/stock-ledger.ts is missing');
  const discovered = discoveredLedgerSuites();
  if (discovered.length === 0) fail('suite', 'no stock-ledger-*.test.ts suite exists');
  else ok(`${discovered.length} stock-ledger suites discovered`);
}

/** Prove the runner can still report failure before trusting any result (see scripts/phase2-s7-gate.ts). */
function checkRunnerReportsFailure(): void {
  const config = 'tests/fixtures/runner-exit-code/vitest.config.ts';
  const res = spawnSync('npx', ['vitest', 'run', '--config', config, 'failing'], { cwd: ROOT, encoding: 'utf8', env: process.env });
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (!/1 failed/.test(output)) {
    fail('runner', `the exit-code canary did not run its failing test, so this run proves nothing about the runner:\n${output.slice(-2000)}`);
    return;
  }
  if (res.status === 0) {
    fail('runner', 'the test runner exited 0 over a failing test; no result in this run is evidence (tests/helpers/exit-code.ts)');
    return;
  }
  ok(`the test runner reports failure (canary exited ${res.status ?? 'on a signal'})`);
}

const suites = (): string[] => [...new Set([...P3_S2_TESTS, ...discoveredLedgerSuites()])].sort();

const STEPS = (): { name: string; cmd: string; args: string[] }[] => [
  { name: 'P3-S1 gate (permanent predecessor, composes P2-S8…P2-S1 and Phase 1)', cmd: npm, args: ['run', 'gate:phase3:s1'] },
  {
    name: 'P3-S2 ledger authority, structure, primitive, vectors, rebuild, concurrency, unit-lock and guard suites',
    cmd: 'npx',
    args: ['vitest', 'run', ...suites()],
  },
];

function runSteps(): void {
  console.log('P3-S2 GATE — composed regression matrix');
  checkRunnerReportsFailure();
  if (failures > 0) {
    console.error('\nP3-S2 GATE: FAIL — the test runner cannot report failure; refusing to run the regression matrix');
    process.exit(1);
  }
  for (const step of STEPS()) {
    const started = Date.now();
    const res = spawnSync(step.cmd, [...step.args], { cwd: ROOT, encoding: 'utf8', stdio: 'inherit', env: process.env });
    const ms = Date.now() - started;
    if (res.status !== 0) fail('regression', `${step.name} failed (exit ${res.status ?? 'signal'}) after ${ms}ms`);
    else ok(`${step.name} (${ms}ms)`);
  }
}

if (LIST_ONLY) {
  console.log(`P3-S2 GATE plan (${ACCEPTED ? 'accepted' : 'candidate'}):`);
  if (ACCEPTED) console.log(`  structural: frozenThrough at or beyond ${S2_BOUNDARY}; ${S2_MIGRATIONS.join(', ')} at their accepted digests`);
  else console.log(`  structural: frozenThrough = ${S1_BOUNDARY}; after it exactly ${S2_MIGRATIONS.join(', ')}, neither in the manifest`);
  console.log('  structural: no registration, no EXECUTE grant, no later-slice table or reserved/available column, no P3-S3 operation kind');
  console.log(
    '  structural: the ledger tables, registries, triggers and trusted routines exist; ownership transfer bracketed; owner replaces inventory_configure_product',
  );
  console.log('  structural: @daftar/inventory fixed-point modules and invval/1 vectors with exact ids; no framework or driver import');
  console.log('  structural: every P3-S2 suite exists');
  for (const s of STEPS()) console.log(`  command:    ${s.cmd} ${s.args.join(' ')}`);
  process.exit(0);
}

checkMigrationBoundary();
checkScope();
checkRequiredObjects();
checkPackage();
checkSuites();
if (failures > 0) {
  console.error(`\nP3-S2 GATE: FAIL (${failures} structural violation${failures === 1 ? '' : 's'}) — not running the regression matrix`);
  process.exit(1);
}
runSteps();

if (failures > 0) {
  console.error(`\nP3-S2 GATE: FAIL (${failures})`);
  process.exit(1);
}
console.log('\nP3-S2 GATE: PASS');
