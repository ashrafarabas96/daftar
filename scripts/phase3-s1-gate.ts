#!/usr/bin/env tsx
/**
 * PHASE 3 SLICE GATE — P3-S1, inventory and catalog primitives
 * (docs/PHASE_3_EXECUTION_PLAN.md §3 and §13).
 *
 * `npm run gate:phase3:s1` is the deterministic answer to "is P3-S1 still
 * exactly what the Tech Lead accepted, and did it stay inside its boundary?".
 *
 * P3-S1 was ACCEPTED at `f1cc4c4` and its six migrations FROZEN in the
 * manifest (docs/PHASE_3_S1_ACCEPTANCE.md). This is now a PERMANENT regression
 * gate, changed in tense the way every Phase 2 gate was at its own acceptance:
 * the candidate-era rules ("none frozen", "nothing after 0058") went with the
 * candidacy, and the accepted digests came in as an independent second source,
 * so one commit cannot move a migration and its recorded hash together.
 * `frozenThrough` is a floor, not an equality: a gate for an accepted slice must
 * never be the reason a later authorized slice cannot land.
 *
 * What it checks before running anything, because each is instant and a tree
 * that fails one is not worth a test run:
 *
 *   — the frozen boundary is at or beyond 0058, and each of the six P3-S1
 *     migrations hashes to its accepted digest on disk AND in the manifest
 *     (`check:migrations` verifies every frozen byte; this gate verifies the
 *     accepted ones against its own copy);
 *   — the range 0053–0058 holds exactly those six files, with no hole;
 *   — no P3-S2+ surface (stock ledger, stock cache, movement kinds, the unit
 *     history lock, the operation→movement map) and no P3-S3 operation kind
 *     appears anywhere in the six P3-S1 migrations;
 *   — the physical authority model is present by name: the internal role in
 *     bootstrap with its one membership, the three runtime routines, the key
 *     domain, both verifiers, both column guards and the four home-association
 *     objects;
 *   — the two transaction seams exist, carry no bypass flag, and the package
 *     that mints and canonicalizes is a workspace with its shared vectors;
 *   — every behavioural claim has a suite behind it.
 *
 * Then it proves the runner can still report failure, composes the permanent
 * predecessor (the P2-S8 gate, which composes the whole chain back to Phase 1)
 * and runs every P3-S1 suite.
 *
 * Usage: npm run gate:phase3:s1 [-- --list]
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

/** The P3-S1 acceptance boundary. A floor: later authorized slices move it forward. */
const FROZEN_THROUGH_AT_LEAST = '0058_accounting_entry_date_guard.sql';

/**
 * The six P3-S1 migrations at the digests the Tech Lead accepted (accepted head
 * `f1cc4c47a43defa969d7beff7f1c795189eee1c1`). A second source independent of
 * MIGRATION_MANIFEST.json: each file must hash to this on disk AND be recorded
 * with it in the manifest.
 */
const S1_ACCEPTED: Readonly<Record<string, string>> = {
  '0053_inventory_units_and_product_configuration.sql': '63940fbcf2c5a3cd99a20280cd83fe53198a0e2d0e2dc0db7ed80d31c47bd3e6',
  '0054_inventory_assertion_authority.sql': '7205dea79f090ecf8ded122557d92b2b9669463ce3e5aefca466a968ef9aa450',
  '0055_inventory_configure_product.sql': '6652cd5949ad2d9bdda559e23174b850f3cf6bcc2a54d307c5fb9a0a1f5fa2b7',
  '0056_inventory_branch_warehouses.sql': '2de288c370e90df5c304ccf354638d178452798662d83054c6a8df8c6f7195a5',
  '0057_inventory_permissions.sql': 'f6c7b56f920215cc8ba3e84d24e4f353329edab8dccb8d4e43a66712f7c1941d',
  '0058_accounting_entry_date_guard.sql': '455973c26bfdf0a185112a4e20a24676d54b5c4c7d4d1232f3e2dce3046b431a',
};

/** The P3-S1 migrations, in order. */
const S1_MIGRATIONS = Object.keys(S1_ACCEPTED).sort();

/** Surfaces owned by P3-S2 and later (plan §4–§8). Their presence is a scope breach. */
const FUTURE_SLICE_SURFACES = [
  'stock_movements',
  'stock_levels',
  'stock_movement_kinds',
  'stock_source_types',
  'stock_source_bindings',
  'products_20_unit_history_lock',
  'inventory_operation_movement_kinds',
] as const;

/** Operation kinds the lock reserves for P3-S3 (P3-AL-55 §E). Registering one here is registering a claim no routine can honour. */
const LATER_OPERATION_KINDS = [
  'inventory.transfer',
  'inventory.adjust',
  'inventory.damage',
  'inventory.stocktake_open',
  'inventory.stocktake_count',
  'inventory.stocktake_finalize',
  'inventory.opening',
] as const;

/** Named objects P3-AL-54 / P3-AL-55 require, and the P3-S1 migration that must define each. */
const REQUIRED_OBJECTS: readonly (readonly [string, RegExp])[] = [
  ['units registry', /CREATE TABLE units\b/],
  ['unit_names registry', /CREATE TABLE unit_names\b/],
  ['products inventory columns', /ADD COLUMN track_inventory\b/],
  ['product_variants.is_base', /ADD COLUMN is_base\b/],
  ['products_10_inventory_config_authority', /CREATE TRIGGER products_10_inventory_config_authority\b/],
  ['product_variants_10_base_variant_authority', /CREATE TRIGGER product_variants_10_base_variant_authority\b/],
  ['inventory_operation_kinds', /CREATE TABLE inventory_operation_kinds\b/],
  ['inventory_assertion_keys', /CREATE TABLE inventory_assertion_keys\b/],
  ['inventory_assertion_uses', /CREATE TABLE inventory_assertion_uses\b/],
  ['inventory_assertion_key_install', /FUNCTION inventory_assertion_key_install\(/],
  ['inventory_assertion_key_retire', /FUNCTION inventory_assertion_key_retire\(/],
  ['inventory_assertion_consume', /FUNCTION inventory_assertion_consume\(/],
  ['inventory_assertion_current', /FUNCTION inventory_assertion_current\(/],
  ['inventory_configure_product', /FUNCTION inventory_configure_product\(/],
  ['structure_associate_warehouse_branch', /FUNCTION structure_associate_warehouse_branch\(/],
  ['structure_dissociate_warehouse_branch', /FUNCTION structure_dissociate_warehouse_branch\(/],
  ['branch_warehouses', /CREATE TABLE branch_warehouses\b/],
  ['warehouses_home_branch_maintain', /CREATE TRIGGER warehouses_home_branch_maintain\b/],
  ['warehouses_require_home_branch', /CREATE CONSTRAINT TRIGGER warehouses_require_home_branch\b/],
  ['branch_warehouses_keep_home', /CREATE CONSTRAINT TRIGGER branch_warehouses_keep_home\b/],
  ['warehouses_home_branch_immutable', /CREATE TRIGGER warehouses_home_branch_immutable\b/],
];

/** The flags P3-AL-55 §I forbids from ever existing on a seam. */
const FORBIDDEN_SEAM_FLAGS = [/\bskipInventoryAssertion\b/, /\brequiresAssertion\s*:\s*false\b/, /\brawInventoryWrite\b/, /\btrusted\s*:\s*true\b/];

/** Every P3-S1 suite. Existence is checked structurally; each one runs below. */
const P3_S1_TESTS = [
  'tests/integration/inventory-config.test.ts',
  'tests/integration/inventory-seam.test.ts',
  'tests/integration/inventory-seam-posting.test.ts',
  'tests/integration/inventory-configuration.test.ts',
  'tests/integration/warehouse-branch-association.test.ts',
  'tests/integration/catalog-base-variant.test.ts',
  'tests/integration/migration-portability.test.ts',
  'tests/integration/migration-upgrade.test.ts',
  'tests/security/search-path-shadowing.test.ts',
  'tests/security/db-privileges.test.ts',
  'tests/integration/runner-exit-code.test.ts',
];

/** Discovered, not listed: every inventory security/DB suite any P3-S1 agent added. */
const discoveredInventorySuites = (): string[] =>
  ['tests/integration', 'tests/security']
    .flatMap((dir) =>
      readdirSync(join(ROOT, dir))
        .filter((f) => /^inventory-.*\.test\.ts$/.test(f))
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
const readIfPresent = (path: string): string | null => (existsSync(join(ROOT, path)) ? read(path) : null);
const sqlFiles = (): string[] =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
const stripTsProse = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

// ── 1. Migration boundary ───────────────────────────────────────────────────
function checkMigrationBoundary(): void {
  console.log('P3-S1 GATE — migration boundary');
  const manifest = JSON.parse(read('infrastructure/database/MIGRATION_MANIFEST.json')) as {
    frozenThrough: string;
    migrations: { name: string; sha256: string }[];
  };
  if (manifest.frozenThrough < FROZEN_THROUGH_AT_LEAST) {
    fail('boundary', `frozenThrough is ${manifest.frozenThrough} — P3-S1 was accepted and frozen, so it must be at least ${FROZEN_THROUGH_AT_LEAST}`);
  } else {
    ok(`frozenThrough = ${manifest.frozenThrough} — at or beyond the P3-S1 acceptance boundary`);
  }

  const recorded = new Map(manifest.migrations.map((m) => [m.name, m.sha256]));
  const before = failures;
  for (const [name, accepted] of Object.entries(S1_ACCEPTED)) {
    const path = join(MIGRATIONS_DIR, name);
    if (!existsSync(path)) {
      fail('boundary', `${name} was accepted and frozen but is missing`);
      continue;
    }
    const onDisk = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (onDisk !== accepted) fail('boundary', `${name} hashes to ${onDisk.slice(0, 12)}… on disk but was accepted at ${accepted.slice(0, 12)}…`);
    const inManifest = recorded.get(name);
    if (inManifest === undefined) fail('boundary', `${name} was accepted but is not frozen in the manifest`);
    else if (inManifest !== accepted)
      fail('boundary', `${name} is recorded as ${inManifest.slice(0, 12)}… in the manifest but was accepted at ${accepted.slice(0, 12)}…`);
  }
  if (failures === before) ok(`the ${S1_MIGRATIONS.length} P3-S1 migrations hash to their accepted digests on disk and in the manifest`);

  // No hole inside the accepted range, and nothing renumbered into it. A
  // successor after 0058 is not this gate's business.
  const inRange = sqlFiles().filter((f) => f >= '0053' && f <= FROZEN_THROUGH_AT_LEAST);
  if (JSON.stringify(inRange) !== JSON.stringify(S1_MIGRATIONS)) {
    fail('boundary', `0053–0058 must hold exactly ${S1_MIGRATIONS.join(', ')} — found ${inRange.join(', ') || 'none'}`);
  } else {
    ok('0053–0058 holds exactly the six accepted files');
  }
}

// ── 2. Scope: nothing from a later slice ─────────────────────────────────────
function checkScope(): void {
  console.log('P3-S1 GATE — slice scope');
  const sql = S1_MIGRATIONS.filter((f) => existsSync(join(MIGRATIONS_DIR, f)))
    .map((f) => stripComments(readFileSync(join(MIGRATIONS_DIR, f), 'utf8')))
    .join('\n');
  for (const surface of FUTURE_SLICE_SURFACES) {
    if (new RegExp(`\\b${surface}\\b`, 'i').test(sql)) fail('scope', `${surface} appears in a P3-S1 migration — it belongs to a later slice`);
  }
  ok('no P3-S2+ surface in the P3-S1 migrations');
  // Only the registry INSERTs are read: `inventory.adjust` is also a Phase 3
  // PERMISSION key (P3-AL-38), which P3-S1 legitimately seeds.
  const registrations = (sql.match(/INSERT\s+INTO\s+inventory_operation_kinds[\s\S]*?;/gi) ?? []).join('\n');
  if (registrations === '') fail('scope', 'no migration registers the P3-S1 operation kinds');
  for (const kind of LATER_OPERATION_KINDS) {
    if (registrations.includes(`'${kind}'`)) fail('scope', `operation kind ${kind} is registered by P3-S1 — P3-AL-55 §E reserves it for P3-S3`);
  }
  ok('the operation registry holds no kind reserved for P3-S3');
}

// ── 3. The physical authority model, by name ───────────────────────────────
function checkAuthorityModel(): void {
  console.log('P3-S1 GATE — physical authority model (P3-AL-54, P3-AL-55)');
  const sql = S1_MIGRATIONS.filter((f) => existsSync(join(MIGRATIONS_DIR, f)))
    .map((f) => stripComments(readFileSync(join(MIGRATIONS_DIR, f), 'utf8')))
    .join('\n');
  for (const [name, pattern] of REQUIRED_OBJECTS) {
    if (pattern.test(sql)) ok(name);
    else fail('authority', `${name} is not created by any P3-S1 migration`);
  }

  const bootstrap = stripComments(read('infrastructure/database/bootstrap.sql'));
  const roleShape = /daftar_inventory_internal\s+NOLOGIN\s+NOINHERIT\s+NOSUPERUSER\s+NOCREATEDB\s+NOCREATEROLE\s+NOREPLICATION\s+NOBYPASSRLS/;
  if (!roleShape.test(bootstrap)) fail('authority', 'bootstrap.sql does not create daftar_inventory_internal in the P3-AL-54 §C shape');
  else ok('daftar_inventory_internal is created by bootstrap, NOLOGIN NOINHERIT … NOBYPASSRLS');
  if (!/GRANT\s+daftar_inventory_internal\s+TO\s+daftar_migrator\s+WITH\s+INHERIT\s+FALSE\s*,\s*SET\s+TRUE/i.test(bootstrap)) {
    fail('authority', 'bootstrap.sql does not grant the one membership daftar_migrator WITH INHERIT FALSE, SET TRUE');
  } else {
    ok('its one membership is daftar_migrator, INHERIT FALSE, SET TRUE');
  }
  if (/CREATE ROLE daftar_inventory_internal/.test(sql)) fail('authority', 'a migration creates the internal role — roles belong to bootstrap');

  // Every ownership transfer is bracketed in its own file (P3-AL-54 §J).
  for (const f of S1_MIGRATIONS) {
    const text = readIfPresent(`infrastructure/database/migrations/${f}`);
    if (text === null) continue;
    const body = stripComments(text);
    if (!/OWNER TO daftar_inventory_internal/.test(body)) continue;
    const granted = /GRANT CREATE ON SCHEMA public TO daftar_inventory_internal/.test(body);
    const revoked = /REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal/.test(body);
    if (!granted || !revoked) fail('authority', `${f} hands ownership to the internal role without the CREATE-on-public bracket in the same file`);
    else ok(`${f}: ownership transfer bracketed by GRANT/REVOKE CREATE ON SCHEMA public`);
  }
}

// ── 4. The seams and the package ───────────────────────────────────────────
function checkSeamsAndPackage(): void {
  console.log('P3-S1 GATE — transaction seams and @daftar/inventory');
  const database = readIfPresent('apps/api/src/infra/database.ts') ?? '';
  for (const seam of ['withBusinessInventoryTransaction', 'withBusinessInventoryAccountingTransaction']) {
    if (new RegExp(`async ${seam}<`).test(database)) ok(`${seam} exists`);
    else fail('seam', `${seam} is missing from apps/api/src/infra/database.ts`);
  }
  if (!/app\.inventory_assertion/.test(database)) fail('seam', 'the carrier app.inventory_assertion is never set');
  const sources = ['apps/api/src/infra/database.ts', ...listTs('apps/api/src/modules/inventory')];
  for (const path of sources) {
    const code = stripTsProse(read(path));
    for (const flag of FORBIDDEN_SEAM_FLAGS) {
      if (flag.test(code)) fail('seam', `${path} contains ${flag.source} — P3-AL-55 §I forbids every bypass flag`);
    }
  }
  ok('no seam bypass flag anywhere in the seams or the inventory module');

  const pkg = JSON.parse(read('package.json')) as { workspaces: string[] };
  if (!pkg.workspaces.includes('packages/inventory')) fail('package', '@daftar/inventory is not a workspace');
  for (const path of ['packages/inventory/src/assertion.ts', 'packages/inventory/src/payload.ts', 'packages/inventory/vectors/invpl-vectors.json']) {
    if (existsSync(join(ROOT, path))) ok(path);
    else fail('package', `${path} is missing (P3-AL-55 §F)`);
  }
  const assertion = stripTsProse(readIfPresent('packages/inventory/src/assertion.ts') ?? '');
  if (/\bverify\w*\s*\(/i.test(assertion))
    fail('package', 'packages/inventory/src/assertion.ts verifies — the package mints and splits only; the database verifies');
  else ok('the package mints and splits, and never verifies');
}

function listTs(dir: string): string[] {
  if (!existsSync(join(ROOT, dir))) return [];
  return readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `${dir}/${f}`);
}

// ── 5. Every behavioural claim has a suite ─────────────────────────────────
function checkSuites(): void {
  console.log('P3-S1 GATE — behavioural suites');
  for (const path of P3_S1_TESTS) {
    if (existsSync(join(ROOT, path))) ok(path);
    else fail('suite', `${path} is missing`);
  }
  const discovered = discoveredInventorySuites();
  if (discovered.length === 0) fail('suite', 'no inventory-*.test.ts suite exists');
  else ok(`${discovered.length} inventory suites discovered`);
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

const suites = (): string[] => [...new Set([...P3_S1_TESTS, ...discoveredInventorySuites()])].sort();

const STEPS = (): { name: string; cmd: string; args: string[] }[] => [
  { name: 'migration manifest (frozen 0000–0052 byte-identical)', cmd: npm, args: ['run', 'check:migrations'] },
  { name: 'static guards', cmd: npm, args: ['run', 'check:guards'] },
  { name: 'deployment authority (third ownership target)', cmd: npm, args: ['run', 'check:deployment-authority'] },
  { name: 'P2-S8 gate (permanent predecessor, composes P2-S7…P2-S1 and Phase 1)', cmd: npm, args: ['run', 'gate:phase2:s8'] },
  { name: '@daftar/inventory unit suite (invpl/1, invctl/1, shared vectors)', cmd: npm, args: ['run', 'test', '-w', '@daftar/inventory'] },
  { name: '@daftar/domain-core unit suite (the Phase 3 permission registry)', cmd: npm, args: ['run', 'test', '-w', '@daftar/domain-core'] },
  { name: 'P3-S1 authority, seam, command, catalog, warehouse and portability suites', cmd: 'npx', args: ['vitest', 'run', ...suites()] },
];

function runSteps(): void {
  console.log('P3-S1 GATE — composed regression matrix');
  checkRunnerReportsFailure();
  if (failures > 0) {
    console.error('\nP3-S1 GATE: FAIL — the test runner cannot report failure; refusing to run the regression matrix');
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
  console.log('P3-S1 GATE plan:');
  console.log(`  structural: frozenThrough at or beyond ${FROZEN_THROUGH_AT_LEAST}; ${S1_MIGRATIONS.join(', ')} at their accepted digests`);
  console.log('  structural: no P3-S2+ surface and no P3-S3 operation kind in the P3-S1 migrations');
  console.log(
    '  structural: internal role in bootstrap with its one membership; the routines, key domain, verifiers, guards and home-association objects exist',
  );
  console.log('  structural: every ownership transfer to the internal role is bracketed by CREATE on public in its own file');
  console.log('  structural: both seams exist with no bypass flag; @daftar/inventory is a workspace with its vectors and never verifies');
  console.log('  structural: every P3-S1 suite exists');
  for (const s of STEPS()) console.log(`  command:    ${s.cmd} ${s.args.join(' ')}`);
  process.exit(0);
}

checkMigrationBoundary();
checkScope();
checkAuthorityModel();
checkSeamsAndPackage();
checkSuites();
if (failures > 0) {
  console.error(`\nP3-S1 GATE: FAIL (${failures} structural violation${failures === 1 ? '' : 's'}) — not running the regression matrix`);
  process.exit(1);
}
runSteps();

if (failures > 0) {
  console.error(`\nP3-S1 GATE: FAIL (${failures})`);
  process.exit(1);
}
console.log('\nP3-S1 GATE: PASS');
