#!/usr/bin/env tsx
/**
 * PHASE 3 SLICE GATE — P3-S3, transfers, adjustments, damage, stocktake and
 * inventory opening (docs/PHASE_3_EXECUTION_PLAN.md §5, docs/PHASE_3_S3_CONTRACT.md §7.1).
 *
 * `npm run gate:phase3:s3` answers "is P3-S3 exactly the slice the contract
 * describes, and did it stay inside its boundary?".
 *
 * Two tenses, chosen by `S3_ACCEPTED` alone, as in `phase3-s2-gate.ts`:
 *
 *   — CANDIDATE (`S3_ACCEPTED` empty): `frozenThrough` is the P3-S2 boundary,
 *     neither S3 migration is in the manifest, and the only migrations after
 *     0060 are exactly 0061 and 0062.
 *   — ACCEPTED (`S3_ACCEPTED` holds both digests): `frozenThrough` is a floor
 *     at 0062, each S3 migration hashes to its accepted digest on disk AND in
 *     the manifest, and 0061–0062 hold exactly those files. A successor is
 *     not this gate's business.
 *
 * Structural checks: the registrations are exactly P3-S3's own (four stock
 * source types, seven operation kinds, six operation→movement mappings, two
 * accounting source types and their two `post` kinds, no movement kind);
 * EXECUTE reaches `daftar_app` only on the seven entry routines and the
 * internal role only on the opening-position read; no role or membership
 * change; no S4+ table and no reserved/available column; every document
 * table, bridge, guard trigger and routine by name; TD-13's try-lock prunes
 * and the owner replacing `accounting_actor`; both CREATE brackets; the
 * packages and their vectors; every P3-S3 suite.
 *
 * Then the runner canary, the permanent predecessor (`gate:phase3:s2`, which
 * composes the chain back to Phase 1, budgets included) and every P3-S3 suite.
 *
 * Usage: npm run gate:phase3:s3 [-- --list]
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

/** The P3-S2 boundary, which P3-S3 sits directly on. */
const S2_BOUNDARY = '0060_inventory_stock_primitive.sql';

/** The P3-S3 migrations, in order. */
const S3_MIGRATIONS = ['0061_inventory_movement_sources.sql', '0062_inventory_movement_commands.sql'] as const;
const [SOURCES, COMMANDS] = S3_MIGRATIONS;

/** The P3-S3 acceptance boundary. A floor once accepted. */
const S3_BOUNDARY = COMMANDS;

/** The two P3-S3 migrations at their accepted digests. Empty while P3-S3 is a candidate; filled in the freeze commit only. */
const S3_ACCEPTED: Readonly<Record<string, string>> = {};

const ACCEPTED = Object.keys(S3_ACCEPTED).length > 0;

/** The exact registrations P3-S3 makes (contract A-01, A-03, A-05; migration header R-8). */
const REGISTRATIONS: readonly (readonly [string, readonly string[]])[] = [
  ['stock_source_types', ["'inventory_adjustment'", "'inventory_opening'", "'inventory_transfer'", "'stocktake'"]],
  [
    'inventory_operation_kinds',
    [
      "'inventory.transfer'",
      "'inventory.adjust'",
      "'inventory.damage'",
      "'inventory.stocktake_open'",
      "'inventory.stocktake_count'",
      "'inventory.stocktake_finalize'",
      "'inventory.opening'",
    ],
  ],
  [
    'inventory_operation_movement_kinds',
    [
      "'inventory.transfer', 'transfer_out'",
      "'inventory.transfer', 'transfer_in'",
      "'inventory.adjust', 'adjustment'",
      "'inventory.damage', 'damage'",
      "'inventory.stocktake_finalize', 'stocktake'",
      "'inventory.opening', 'inventory_opening'",
    ],
  ],
  ['accounting_source_types', ["'inventory_adjustment'", "'inventory_opening'"]],
  ['accounting_operation_kinds', ["'post', 'inventory_adjustment'", "'post', 'inventory_opening'"]],
];

/** EXECUTE grants P3-S3 may make, exactly (contract A-18). */
const ALLOWED_EXECUTE = [
  'inventory_transfer_stock:daftar_app',
  'inventory_adjust_stock:daftar_app',
  'inventory_record_damage:daftar_app',
  'inventory_stocktake_open:daftar_app',
  'inventory_stocktake_count:daftar_app',
  'inventory_stocktake_finalize:daftar_app',
  'inventory_record_opening:daftar_app',
  'accounting_inventory_opening_position:daftar_inventory_internal',
].sort();

/** Tables owned by P3-S4 and later. */
const LATER_TABLES =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(purchase\w*|supplier\w*|negative_inventory_cost_adjustments|payment_methods|landed_cost\w*)\b/i;

const DOCUMENT_TABLES = [
  'inventory_transfers',
  'inventory_transfer_lines',
  'inventory_adjustments',
  'inventory_adjustment_lines',
  'stocktakes',
  'stocktake_lines',
  'inventory_openings',
  'inventory_opening_lines',
];
const STOCK_SOURCE_TYPES = ['inventory_transfer', 'inventory_adjustment', 'stocktake', 'inventory_opening'];
const ENTRY_ROUTINES = [
  'inventory_transfer_stock',
  'inventory_adjust_stock',
  'inventory_record_damage',
  'inventory_stocktake_open',
  'inventory_stocktake_count',
  'inventory_stocktake_finalize',
  'inventory_record_opening',
];
const HELPERS = ['inventory_lock_stock_targets', 'inventory_bridge_source_lines', 'inventory_reason_words', 'inventory_fixed_text'];
const ACCOUNTING_OBJECTS = [
  'accounting_inventory_opening_position',
  'accounting_inventory_adjustment_entry_complete',
  'accounting_inventory_opening_entry_complete',
];
const TRIGGERS = [
  ...STOCK_SOURCE_TYPES.flatMap((st) => [
    `stock_binding_requires_${st}`,
    `stock_bridge_immutable_${st}`,
    `stock_source_complete_${st}`,
    `stock_source_freeze_${st}`,
  ]),
  'inventory_transfers_immutable',
  'inventory_adjustments_immutable',
  'inventory_openings_immutable',
  'stocktakes_immutable',
  'inventory_adjustments_value_complete',
  'inventory_openings_value_complete',
  'stocktakes_value_complete',
  'stocktakes_finalized_complete',
  'journal_entries_inventory_adjustment_complete',
  'journal_entries_inventory_opening_complete',
  'accounting_reversals_20_domain_source_guard',
  'accounting_opening_balances_30_inventory_opening_guard',
  'warehouses_30_archive_requires_zero_stock',
  'products_30_archive_requires_zero_stock',
  'product_variants_30_archive_requires_zero_stock',
];

const PACKAGE_FILES = [
  'packages/inventory/src/movement-payloads.ts',
  'packages/inventory/src/allocation.ts',
  'packages/inventory/src/reason-digest.ts',
  'packages/inventory/vectors/invpl-s3-vectors.json',
  'packages/inventory/vectors/allocation-vectors.json',
  'packages/accounting/src/domain-posting.ts',
];

/** Every P3-S3 suite is discovered by name; at least these families must exist. */
const SUITE_PATTERN = /^(inventory-s3-.*|inventory-opening-.*)\.test\.ts$/;
const REQUIRED_SUITES = ['tests/integration/inventory-s3-review-fixes.test.ts', 'tests/integration/inventory-opening-authority.test.ts'];

const discoveredSuites = (): string[] =>
  ['tests/integration', 'tests/security']
    .flatMap((dir) =>
      readdirSync(join(ROOT, dir))
        .filter((f) => SUITE_PATTERN.test(f))
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
const bothMigrations = (): string => S3_MIGRATIONS.map((m) => migration(m) ?? '').join('\n');
const stripTsProse = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

// ── 1. Migration boundary ───────────────────────────────────────────────────
function checkMigrationBoundary(): void {
  console.log(`P3-S3 GATE — migration boundary (${ACCEPTED ? 'accepted' : 'candidate'})`);
  const manifest = JSON.parse(read('infrastructure/database/MIGRATION_MANIFEST.json')) as {
    frozenThrough: string;
    migrations: { name: string; sha256: string }[];
  };
  const recorded = new Map(manifest.migrations.map((m) => [m.name, m.sha256]));
  for (const name of S3_MIGRATIONS) {
    if (!existsSync(join(MIGRATIONS_DIR, name))) fail('boundary', `${name} is missing`);
  }

  if (!ACCEPTED) {
    if (manifest.frozenThrough !== S2_BOUNDARY) {
      fail('boundary', `frozenThrough is ${manifest.frozenThrough} — a P3-S3 candidate sits on the P3-S2 boundary ${S2_BOUNDARY}`);
    } else {
      ok(`frozenThrough = ${S2_BOUNDARY} — P3-S3 is not frozen`);
    }
    for (const name of S3_MIGRATIONS) {
      if (recorded.has(name)) fail('boundary', `${name} is in the manifest before P3-S3 was accepted — premature freeze`);
    }
    const after = sqlFiles().filter((f) => f > S2_BOUNDARY);
    if (JSON.stringify(after) !== JSON.stringify([...S3_MIGRATIONS])) {
      fail('boundary', `after 0060 a P3-S3 candidate holds exactly ${S3_MIGRATIONS.join(', ')} — found ${after.join(', ') || 'none'}`);
    } else {
      ok('after 0060 the tree holds exactly the two P3-S3 migrations');
    }
    return;
  }

  if (manifest.frozenThrough < S3_BOUNDARY) {
    fail('boundary', `frozenThrough is ${manifest.frozenThrough} — P3-S3 was accepted and frozen, so it must be at least ${S3_BOUNDARY}`);
  } else {
    ok(`frozenThrough = ${manifest.frozenThrough} — at or beyond the P3-S3 acceptance boundary`);
  }
  if (JSON.stringify(Object.keys(S3_ACCEPTED).sort()) !== JSON.stringify([...S3_MIGRATIONS])) {
    fail('boundary', `S3_ACCEPTED must name exactly ${S3_MIGRATIONS.join(', ')}`);
  }
  const before = failures;
  for (const [name, accepted] of Object.entries(S3_ACCEPTED)) {
    const path = join(MIGRATIONS_DIR, name);
    if (!existsSync(path)) continue;
    const onDisk = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (onDisk !== accepted) fail('boundary', `${name} hashes to ${onDisk.slice(0, 12)}… on disk but was accepted at ${accepted.slice(0, 12)}…`);
    const inManifest = recorded.get(name);
    if (inManifest === undefined) fail('boundary', `${name} was accepted but is not frozen in the manifest`);
    else if (inManifest !== accepted)
      fail('boundary', `${name} is recorded as ${inManifest.slice(0, 12)}… in the manifest but was accepted at ${accepted.slice(0, 12)}…`);
  }
  if (failures === before) ok(`the ${S3_MIGRATIONS.length} P3-S3 migrations hash to their accepted digests on disk and in the manifest`);
  const inRange = sqlFiles().filter((f) => f > S2_BOUNDARY && f <= S3_BOUNDARY);
  if (JSON.stringify(inRange) !== JSON.stringify([...S3_MIGRATIONS])) {
    fail('boundary', `0061–0062 must hold exactly ${S3_MIGRATIONS.join(', ')} — found ${inRange.join(', ') || 'none'}`);
  } else {
    ok('0061–0062 holds exactly the two accepted files');
  }
}

// ── 2. Scope ────────────────────────────────────────────────────────────────
/**
 * The value tuples of every `INSERT INTO <table> (…) VALUES …;` in the text,
 * read with a quote- and parenthesis-aware scan (a description may hold `;`
 * or parentheses), each normalised for whitespace.
 */
function insertedTuples(sql: string, table: string): string[] {
  const tuples: string[] = [];
  const head = new RegExp(`INSERT\\s+INTO\\s+${table}\\s*\\([^)]*\\)\\s*VALUES`, 'gi');
  for (const match of sql.matchAll(head)) {
    let depth = 0;
    let quoted = false;
    let current = '';
    for (let i = (match.index ?? 0) + match[0].length; i < sql.length; i += 1) {
      const ch = sql.charAt(i);
      if (quoted) {
        current += ch;
        if (ch === "'" && sql.charAt(i + 1) === "'") {
          current += "'";
          i += 1;
        } else if (ch === "'") quoted = false;
        continue;
      }
      if (ch === "'") quoted = true;
      if (ch === ';' && depth === 0) break;
      if (ch === '(') depth += 1;
      if (depth > 0) current += ch;
      if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          tuples.push(current.replace(/\s+/g, ' '));
          current = '';
        }
      }
    }
  }
  return tuples;
}

function checkScope(): void {
  console.log('P3-S3 GATE — slice scope');
  const sql = bothMigrations();
  const before = failures;
  for (const [table, expected] of REGISTRATIONS) {
    const tuples = insertedTuples(sql, table);
    const matched = expected.map((e) => tuples.filter((t) => t.startsWith(`(${e}`)).length);
    if (tuples.length !== expected.length || matched.some((n) => n !== 1)) {
      fail('scope', `${table}: P3-S3 registers exactly ${expected.join(' | ')} — found ${tuples.join(' | ') || 'none'}`);
    }
  }
  if (/INSERT\s+INTO\s+stock_movement_kinds\b/i.test(sql)) fail('scope', 'P3-S3 registers a stock movement kind — the S2 registry is closed');
  const table = LATER_TABLES.exec(sql);
  if (table) fail('scope', `a P3-S3 migration creates ${table[1]} — it belongs to a later slice`);
  if (/^\s*(reserved|available)\s+[A-Z]/im.test(sql)) fail('scope', 'a P3-S3 migration defines a reserved/available column');
  const grants = [...sql.matchAll(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+(\w+)\s*\([^)]*\)\s+TO\s+(\w+)/gi)].map((m) => `${m[1]}:${m[2]}`).sort();
  const grantStatements = (sql.match(/GRANT\s+EXECUTE\b/gi) ?? []).length;
  if (JSON.stringify(grants) !== JSON.stringify(ALLOWED_EXECUTE) || grantStatements !== ALLOWED_EXECUTE.length) {
    fail('scope', `EXECUTE grants must be exactly ${ALLOWED_EXECUTE.join(', ')} — found ${grants.join(', ') || 'none'} (${grantStatements} statements)`);
  }
  if (/\b(BYPASSRLS|ALTER\s+ROLE|CREATE\s+ROLE)\b/i.test(sql) || /\bGRANT\s+daftar_\w+\s+TO\b/i.test(sql)) {
    fail('scope', 'a P3-S3 migration changes a role or a role membership — roles belong to bootstrap');
  }
  if (failures === before) ok('registrations exactly P3-S3’s own; EXECUTE exactly the eight grants; no role change, later-slice table or reserved column');
}

// ── 3. Required objects ─────────────────────────────────────────────────────
function checkRequiredObjects(): void {
  console.log('P3-S3 GATE — required objects (contract §2)');
  const sources = migration(SOURCES) ?? '';
  const commands = migration(COMMANDS) ?? '';
  const sql = `${sources}\n${commands}`;
  const before = failures;
  for (const t of [...DOCUMENT_TABLES, ...STOCK_SOURCE_TYPES.map((st) => `stock_source_bridge_${st}`)]) {
    if (!new RegExp(`CREATE TABLE ${t}\\b`).test(sources)) fail('objects', `table ${t} is not created by ${SOURCES}`);
  }
  for (const t of TRIGGERS) {
    if (!new RegExp(`CREATE (CONSTRAINT )?TRIGGER ${t}\\b`).test(sql)) fail('objects', `trigger ${t} is not created`);
  }
  for (const r of ENTRY_ROUTINES) {
    if (!new RegExp(`FUNCTION ${r}\\(`).test(commands)) fail('objects', `entry routine ${r} is not created by ${COMMANDS}`);
  }
  for (const r of HELPERS) {
    if (!new RegExp(`FUNCTION ${r}\\(`).test(sql)) fail('objects', `helper ${r} is not created`);
  }
  for (const r of ACCOUNTING_OBJECTS) {
    if (!new RegExp(`FUNCTION ${r}\\(`).test(sources)) fail('objects', `${r} is not created by ${SOURCES}`);
  }
  if (failures === before)
    ok(`${DOCUMENT_TABLES.length} documents, 4 bridges, ${TRIGGERS.length} triggers, ${ENTRY_ROUTINES.length} entry routines, ${HELPERS.length} helpers`);

  // TD-13: both prunes run only under the try-lock, and the accounting owner replaces its own routine.
  for (const domain of ['accounting', 'provisioning']) {
    if (!sources.includes(`pg_try_advisory_xact_lock(hashtext('daftar.${domain}_assertion_uses')`)) {
      fail('td-13', `the ${domain} prune does not take its try-lock`);
    }
    const deletes = sources.match(new RegExp(`DELETE\\s+FROM\\s+${domain}_assertion_uses\\b`, 'gi')) ?? [];
    const guarded =
      sources.match(
        new RegExp(
          `IF\\s+pg_try_advisory_xact_lock\\(hashtext\\('daftar\\.${domain}_assertion_uses'\\)[^;]*THEN\\s+DELETE\\s+FROM\\s+${domain}_assertion_uses\\b`,
          'gi',
        ),
      ) ?? [];
    if (deletes.length === 0 || deletes.length !== guarded.length) fail('td-13', `${domain}_assertion_uses has a DELETE outside its try-lock`);
  }
  if (!/SET LOCAL ROLE daftar_accounting_internal;[\s\S]*?CREATE OR REPLACE FUNCTION accounting_actor\(/.test(sources)) {
    fail('td-13', 'accounting_actor is not replaced by its owner');
  }
  if (
    !/FUNCTION inventory_stock_source_guard_gaps\(/.test(sources) ||
    !/\btgtype\b/.test(sources) ||
    !/\btgfoid\b/.test(sources) ||
    !/\bconfrelid\b/.test(sources)
  ) {
    fail('objects', 'the strengthened inventory_stock_source_guard_gaps() (timing, function, FK target) is not in 0061');
  }
  for (const role of ['inventory', 'accounting']) {
    const granted = /GRANT CREATE ON SCHEMA public TO daftar_/.test(sql) && sql.includes(`GRANT CREATE ON SCHEMA public TO daftar_${role}_internal`);
    const revoked = sql.includes(`REVOKE CREATE ON SCHEMA public FROM daftar_${role}_internal`);
    if (sql.includes(`OWNER TO daftar_${role}_internal`) && (!granted || !revoked)) {
      fail('objects', `ownership handed to daftar_${role}_internal without the CREATE-on-public bracket`);
    }
  }
  if (failures === before) ok('TD-13 try-lock prunes, the owner-replaced accounting_actor, the strengthened gaps function, both CREATE brackets');
}

// ── 4. Packages ─────────────────────────────────────────────────────────────
function checkPackages(): void {
  console.log('P3-S3 GATE — packages');
  for (const path of PACKAGE_FILES) {
    if (existsSync(join(ROOT, path))) ok(path);
    else fail('package', `${path} is missing`);
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

// ── 5. Suites ───────────────────────────────────────────────────────────────
function checkSuites(): void {
  console.log('P3-S3 GATE — behavioural suites');
  for (const path of REQUIRED_SUITES) {
    if (existsSync(join(ROOT, path))) ok(path);
    else fail('suite', `${path} is missing`);
  }
  const discovered = discoveredSuites();
  if (discovered.filter((s) => /inventory-s3-/.test(s)).length < 3) fail('suite', `fewer than three inventory-s3-* suites exist (found ${discovered.length})`);
  else ok(`${discovered.length} P3-S3 suites discovered`);
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

const STEPS = (): { name: string; cmd: string; args: string[] }[] => [
  { name: 'P3-S2 gate (permanent predecessor, composes P3-S1, P2-S8…P2-S1 and Phase 1)', cmd: npm, args: ['run', 'gate:phase3:s2'] },
  { name: '@daftar/accounting unit suite (domain posting, the TL-10 refusal)', cmd: npm, args: ['run', 'test', '-w', '@daftar/accounting'] },
  { name: 'P3-S3 command, posting, isolation, concurrency, idempotency and review-fix suites', cmd: 'npx', args: ['vitest', 'run', ...discoveredSuites()] },
];

function runSteps(): void {
  console.log('P3-S3 GATE — composed regression matrix');
  checkRunnerReportsFailure();
  if (failures > 0) {
    console.error('\nP3-S3 GATE: FAIL — the test runner cannot report failure; refusing to run the regression matrix');
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
  console.log(`P3-S3 GATE plan (${ACCEPTED ? 'accepted' : 'candidate'}):`);
  if (ACCEPTED) console.log(`  structural: frozenThrough at or beyond ${S3_BOUNDARY}; ${S3_MIGRATIONS.join(', ')} at their accepted digests`);
  else console.log(`  structural: frozenThrough = ${S2_BOUNDARY}; after it exactly ${S3_MIGRATIONS.join(', ')}, neither in the manifest`);
  console.log('  structural: registrations exactly P3-S3’s own; EXECUTE exactly eight grants; no role change, later-slice table or reserved column');
  console.log('  structural: documents, bridges, guard triggers, entry routines and helpers exist; TD-13 try-lock prunes; strengthened gaps; CREATE brackets');
  console.log('  structural: packages and vectors present; @daftar/inventory framework-free; every P3-S3 suite exists');
  for (const s of STEPS()) console.log(`  command:    ${s.cmd} ${s.args.join(' ')}`);
  process.exit(0);
}

checkMigrationBoundary();
checkScope();
checkRequiredObjects();
checkPackages();
checkSuites();
if (failures > 0) {
  console.error(`\nP3-S3 GATE: FAIL (${failures} structural violation${failures === 1 ? '' : 's'}) — not running the regression matrix`);
  process.exit(1);
}
runSteps();

if (failures > 0) {
  console.error(`\nP3-S3 GATE: FAIL (${failures})`);
  process.exit(1);
}
console.log('\nP3-S3 GATE: PASS');
