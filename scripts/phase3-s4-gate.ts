#!/usr/bin/env tsx
/**
 * PHASE 3 SLICE GATE — P3-S4, suppliers, purchases, receiving, landed cost
 * and deficit coverage (docs/PHASE_3_EXECUTION_PLAN.md §6,
 * docs/PHASE_3_S4_CONTRACT.md §7.1).
 *
 * `npm run gate:phase3:s4` answers "is P3-S4 exactly the slice the contract
 * describes, and did it stay inside its boundary?".
 *
 * Two tenses, chosen by `S4_ACCEPTED` alone, as in `phase3-s3-gate.ts`:
 *
 *   — CANDIDATE (`S4_ACCEPTED` empty): `frozenThrough` is the P3-S4 boundary,
 *     neither S4 migration is in the manifest, and the only migrations after
 *     0062 are exactly 0063 and 0064.
 *   — ACCEPTED (`S4_ACCEPTED` holds both digests): `frozenThrough` is a floor
 *     at 0064, each S4 migration hashes to its accepted digest on disk AND in
 *     the manifest, and 0063–0064 hold exactly those files. A successor is
 *     not this gate's business.
 *
 * Structural checks: the registrations are exactly P3-S4's own (two stock
 * source types, seven operation kinds, two operation→movement mappings, two
 * accounting source types and their two `post` kinds, no movement kind);
 * EXECUTE reaches `daftar_app` only on the seven entry routines and the
 * internal role only on the FX snapshot read; no role or membership change;
 * no S5+ table and no reserved/available column; OD-03 (no tax payable, no
 * rate or inclusive column, the zero-tax CHECK present); every table, bridge,
 * guard trigger and routine by name; the replaced gaps function keeps every
 * S3 digest verbatim; the owner-replaced reversal guard names all four
 * domain types; both CREATE brackets; the packages and their vectors; every
 * P3-S4 suite.
 *
 * Then the runner canary, the permanent predecessor (`gate:phase3:s3`, which
 * composes the chain back to Phase 1, budgets included), the two package
 * suites, every P3-S4 suite and Budget A in isolation.
 *
 * Usage: npm run gate:phase3:s4 [-- --list]
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

/** The P3-S3 boundary, which P3-S4 sits directly on. */
const S3_BOUNDARY = '0062_inventory_movement_commands.sql';

/** The P3-S4 migrations, in order. */
const S4_MIGRATIONS = ['0063_purchases_suppliers_sources.sql', '0064_purchase_commands.sql'] as const;
const [SOURCES, COMMANDS] = S4_MIGRATIONS;

/** The P3-S4 acceptance boundary. A floor once accepted. */
const S4_BOUNDARY = COMMANDS;

/** The two P3-S4 migrations at their accepted digests. Empty while P3-S4 is a candidate; filled in the freeze commit only. */
const S4_ACCEPTED: Readonly<Record<string, string>> = {};

const ACCEPTED = Object.keys(S4_ACCEPTED).length > 0;

/** The exact registrations P3-S4 makes (contract A-03, A-05, §2.5). */
const REGISTRATIONS: readonly (readonly [string, readonly string[]])[] = [
  ['stock_source_types', ["'purchase'", "'negative_inventory_cost_adjustment'"]],
  [
    'inventory_operation_kinds',
    ["'supplier.create'", "'supplier.update'", "'supplier.archive'", "'supplier.reactivate'", "'purchase.draft'", "'purchase.cancel'", "'purchase.receive'"],
  ],
  ['inventory_operation_movement_kinds', ["'purchase.receive', 'purchase'", "'purchase.receive', 'negative_inventory_cost_adjustment'"]],
  ['accounting_source_types', ["'purchase'", "'negative_inventory_cost_adjustment'"]],
  ['accounting_operation_kinds', ["'post', 'purchase'", "'post', 'negative_inventory_cost_adjustment'"]],
];

/** EXECUTE grants P3-S4 may make, exactly (contract A-18). */
const ALLOWED_EXECUTE = [
  'supplier_create:daftar_app',
  'supplier_update:daftar_app',
  'supplier_archive:daftar_app',
  'supplier_reactivate:daftar_app',
  'purchase_save_draft:daftar_app',
  'purchase_cancel:daftar_app',
  'purchase_receive:daftar_app',
  'accounting_purchase_fx_rate:daftar_inventory_internal',
].sort();

/** Tables owned by P3-S5 and later. */
const LATER_TABLES =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(supplier_return\w*|supplier_credit\w*|supplier_payment\w*|supplier_refund\w*|supplier_allocation\w*|payment_method\w*|purchase_reversal\w*|reservation\w*)\b/i;

const TABLES = ['suppliers', 'purchases', 'purchase_lines', 'purchase_landed_costs', 'purchase_landed_cost_allocations', 'negative_inventory_cost_adjustments'];
const STOCK_SOURCE_TYPES = ['purchase', 'negative_inventory_cost_adjustment'];
const ENTRY_ROUTINES = [
  'supplier_create',
  'supplier_update',
  'supplier_archive',
  'supplier_reactivate',
  'purchase_save_draft',
  'purchase_cancel',
  'purchase_receive',
];
const HELPERS = ['purchase_lock_receipt_targets', 'purchase_cover_deficits', 'purchase_bridge_receipt'];
const ACCOUNTING_OBJECTS = [
  'accounting_purchase_fx_rate',
  'accounting_purchase_entry_complete',
  'accounting_negative_inventory_cost_adjustment_entry_complete',
];
const TRIGGERS = [
  ...STOCK_SOURCE_TYPES.flatMap((st) => [`stock_binding_requires_${st}`, `stock_bridge_immutable_${st}`, `stock_source_complete_${st}`]),
  'stock_source_freeze_purchase',
  'purchases_received_complete',
  'purchases_immutable',
  'purchases_value_complete',
  'purchase_landed_costs_freeze',
  'purchase_landed_cost_allocations_freeze',
  'purchase_allocations_consistent',
  'negative_inventory_cost_adjustments_immutable',
  'negative_inventory_cost_adjustments_value_complete',
  'suppliers_no_delete',
  'suppliers_revision_guard',
  'journal_entries_purchase_complete',
  'journal_entries_negative_inventory_cost_adjustment_complete',
];

const PACKAGE_FILES = [
  'packages/inventory/src/supplier-payloads.ts',
  'packages/inventory/src/purchase-payloads.ts',
  'packages/inventory/src/landed-cost.ts',
  'packages/inventory/src/purchase-shares.ts',
  'packages/inventory/src/deficit-coverage.ts',
  'packages/inventory/vectors/invpl-s4-vectors.json',
  'packages/inventory/vectors/landed-cost-vectors.json',
  'packages/inventory/vectors/coverage-vectors.json',
];
/** Case ids the coverage vectors must carry (contract §7.1-4). */
const COVERAGE_CASES = ['GOLD54', 'GOLD55', 'GOLD72', 'THREE-LAYERS', 'ZERO-CATCHUP', 'FLUSH-RESIDUE'];

/** Every P3-S4 suite is discovered by name; at least these must exist. */
const SUITE_PATTERN = /^purchase-s4-.*\.test\.ts$/;
const REQUIRED_SUITES = [
  'tests/integration/purchase-s4-coverage.test.ts',
  'tests/integration/purchase-s4-atomicity.test.ts',
  'tests/security/purchase-s4-signed-authority.test.ts',
  'tests/integration/purchase-s4-upgrade.test.ts',
];
const MIN_SUITES = 8;

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
const bothMigrations = (): string => S4_MIGRATIONS.map((m) => migration(m) ?? '').join('\n');
const stripTsProse = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

// ── 1. Migration boundary ───────────────────────────────────────────────────
function checkMigrationBoundary(): void {
  console.log(`P3-S4 GATE — migration boundary (${ACCEPTED ? 'accepted' : 'candidate'})`);
  const manifest = JSON.parse(read('infrastructure/database/MIGRATION_MANIFEST.json')) as {
    frozenThrough: string;
    migrations: { name: string; sha256: string }[];
  };
  const recorded = new Map(manifest.migrations.map((m) => [m.name, m.sha256]));
  for (const name of S4_MIGRATIONS) {
    if (!existsSync(join(MIGRATIONS_DIR, name))) fail('boundary', `${name} is missing`);
  }

  if (!ACCEPTED) {
    if (manifest.frozenThrough !== S3_BOUNDARY) {
      fail('boundary', `frozenThrough is ${manifest.frozenThrough} — a P3-S4 candidate sits on the P3-S3 boundary ${S3_BOUNDARY}`);
    } else {
      ok(`frozenThrough = ${S3_BOUNDARY} — P3-S4 is not frozen`);
    }
    for (const name of S4_MIGRATIONS) {
      if (recorded.has(name)) fail('boundary', `${name} is in the manifest before P3-S4 was accepted — premature freeze`);
    }
    const after = sqlFiles().filter((f) => f > S3_BOUNDARY);
    if (JSON.stringify(after) !== JSON.stringify([...S4_MIGRATIONS])) {
      fail('boundary', `after 0062 a P3-S4 candidate holds exactly ${S4_MIGRATIONS.join(', ')} — found ${after.join(', ') || 'none'}`);
    } else {
      ok('after 0062 the tree holds exactly the two P3-S4 migrations');
    }
    return;
  }

  if (manifest.frozenThrough < S4_BOUNDARY) {
    fail('boundary', `frozenThrough is ${manifest.frozenThrough} — P3-S4 was accepted and frozen, so it must be at least ${S4_BOUNDARY}`);
  } else {
    ok(`frozenThrough = ${manifest.frozenThrough} — at or beyond the P3-S4 acceptance boundary`);
  }
  if (JSON.stringify(Object.keys(S4_ACCEPTED).sort()) !== JSON.stringify([...S4_MIGRATIONS])) {
    fail('boundary', `S4_ACCEPTED must name exactly ${S4_MIGRATIONS.join(', ')}`);
  }
  const before = failures;
  for (const [name, accepted] of Object.entries(S4_ACCEPTED)) {
    const path = join(MIGRATIONS_DIR, name);
    if (!existsSync(path)) continue;
    const onDisk = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (onDisk !== accepted) fail('boundary', `${name} hashes to ${onDisk.slice(0, 12)}… on disk but was accepted at ${accepted.slice(0, 12)}…`);
    const inManifest = recorded.get(name);
    if (inManifest === undefined) fail('boundary', `${name} was accepted but is not frozen in the manifest`);
    else if (inManifest !== accepted)
      fail('boundary', `${name} is recorded as ${inManifest.slice(0, 12)}… in the manifest but was accepted at ${accepted.slice(0, 12)}…`);
  }
  if (failures === before) ok(`the ${S4_MIGRATIONS.length} P3-S4 migrations hash to their accepted digests on disk and in the manifest`);
  const inRange = sqlFiles().filter((f) => f > S3_BOUNDARY && f <= S4_BOUNDARY);
  if (JSON.stringify(inRange) !== JSON.stringify([...S4_MIGRATIONS])) {
    fail('boundary', `0063–0064 must hold exactly ${S4_MIGRATIONS.join(', ')} — found ${inRange.join(', ') || 'none'}`);
  } else {
    ok('0063–0064 holds exactly the two accepted files');
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
  console.log('P3-S4 GATE — slice scope');
  const sql = bothMigrations();
  const before = failures;
  for (const [table, expected] of REGISTRATIONS) {
    const tuples = insertedTuples(sql, table);
    // Compared without whitespace: a tuple may be written `('a','b')` or `('a', 'b')`.
    const bare = (text: string): string => text.replace(/\s+/g, '');
    const matched = expected.map((e) => tuples.filter((t) => bare(t).startsWith(`(${bare(e)}`)).length);
    if (tuples.length !== expected.length || matched.some((n) => n !== 1)) {
      fail('scope', `${table}: P3-S4 registers exactly ${expected.join(' | ')} — found ${tuples.join(' | ') || 'none'}`);
    }
  }
  if (/INSERT\s+INTO\s+stock_movement_kinds\b/i.test(sql)) fail('scope', 'P3-S4 registers a stock movement kind — the S2 registry is closed');
  const table = LATER_TABLES.exec(sql);
  if (table) fail('scope', `a P3-S4 migration creates ${table[1]} — it belongs to a later slice`);
  if (/^\s*(reserved|available)\s+[A-Z]/im.test(sql)) fail('scope', 'a P3-S4 migration defines a reserved/available column');
  const grants = [...sql.matchAll(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+(\w+)\s*\((?:[^()]|\([^()]*\))*\)\s+TO\s+(\w+)/gi)].map((m) => `${m[1]}:${m[2]}`).sort();
  const grantStatements = (sql.match(/GRANT\s+EXECUTE\b/gi) ?? []).length;
  if (JSON.stringify(grants) !== JSON.stringify(ALLOWED_EXECUTE) || grantStatements !== ALLOWED_EXECUTE.length) {
    fail('scope', `EXECUTE grants must be exactly ${ALLOWED_EXECUTE.join(', ')} — found ${grants.join(', ') || 'none'} (${grantStatements} statements)`);
  }
  if (/\b(BYPASSRLS|ALTER\s+ROLE|CREATE\s+ROLE)\b/i.test(sql) || /\bGRANT\s+daftar_\w+\s+TO\b/i.test(sql)) {
    fail('scope', 'a P3-S4 migration changes a role or a role membership — roles belong to bootstrap');
  }
  // OD-03 (P3-AL-23): no tax is designed, and the zero-tax bound is a CHECK.
  if (/\btax_payable\b/i.test(sql)) fail('od-03', 'a P3-S4 migration names tax_payable — purchase tax posting is BLOCKED BY OD-03');
  if (/^\s*\w*(tax_rate|tax_percent\w*|\w*inclusive\w*)\s+[A-Z]/im.test(sql))
    fail('od-03', 'a P3-S4 migration defines a tax rate, percentage or inclusive column — BLOCKED BY OD-03');
  if (!/CONSTRAINT\s+purchases_tax_policy_absent_ck\s+CHECK\s*\(\s*tax_minor\s*=\s*0\s*\)/i.test(sql))
    fail('od-03', 'purchases_tax_policy_absent_ck CHECK (tax_minor = 0) is missing');
  if (/'(rounding|purchase_price_variance)'/.test(sql))
    fail('scope', 'a P3-S4 migration names the rounding or PPV system key — a receipt posts only Inventory / AP');
  if (failures === before)
    ok('registrations exactly P3-S4’s own; EXECUTE exactly the eight grants; OD-03 bounded; no role change, later-slice table or reserved column');
}

// ── 3. Required objects ─────────────────────────────────────────────────────
function checkRequiredObjects(): void {
  console.log('P3-S4 GATE — required objects (contract §2)');
  const sources = migration(SOURCES) ?? '';
  const commands = migration(COMMANDS) ?? '';
  const sql = `${sources}\n${commands}`;
  const before = failures;
  for (const t of [...TABLES, ...STOCK_SOURCE_TYPES.map((st) => `stock_source_bridge_${st}`)]) {
    if (!new RegExp(`CREATE TABLE ${t}\\b`).test(sources)) fail('objects', `table ${t} is not created by ${SOURCES}`);
  }
  for (const t of TRIGGERS) {
    if (!new RegExp(`CREATE (CONSTRAINT )?TRIGGER ${t}\\b`).test(sql)) fail('objects', `trigger ${t} is not created`);
  }
  for (const r of ENTRY_ROUTINES) {
    if (!new RegExp(`FUNCTION ${r}\\(`).test(commands)) fail('objects', `entry routine ${r} is not created by ${COMMANDS}`);
  }
  for (const r of HELPERS) {
    if (!new RegExp(`FUNCTION ${r}\\(`).test(commands)) fail('objects', `helper ${r} is not created by ${COMMANDS}`);
  }
  for (const r of ACCOUNTING_OBJECTS) {
    if (!new RegExp(`FUNCTION ${r}\\(`).test(sources)) fail('objects', `${r} is not created by ${SOURCES}`);
  }
  if (failures === before)
    ok(
      `${TABLES.length} tables, 2 bridges, ${TRIGGERS.length} triggers, ${ENTRY_ROUTINES.length} entry routines, ${HELPERS.length} helpers, ${ACCOUNTING_OBJECTS.length} accounting objects`,
    );

  // The replaced gaps function keeps every P3-S3 body digest verbatim (contract §2.3), so review F3 still holds.
  const mark = before;
  const s3Digests = [...(migration('0061_inventory_movement_sources.sql') ?? '').matchAll(/"(\w+\(\))":\s*"([0-9a-f]{64})"/g)].map(
    (m) => `"${m[1]}": "${m[2]}"`,
  );
  if (!/CREATE OR REPLACE FUNCTION inventory_stock_source_guard_gaps\(/.test(sources))
    fail('objects', `${SOURCES} does not replace inventory_stock_source_guard_gaps()`);
  if (s3Digests.length < 13) fail('objects', `found only ${s3Digests.length} P3-S3 guard digests in 0061 — the reference is unreadable`);
  for (const d of s3Digests) {
    if (!sources.includes(d)) fail('objects', `the replaced gaps function drops or changes the P3-S3 digest ${d.slice(0, 48)}…`);
  }
  // The reversal guard is replaced by its owner and names all four domain-owned source types.
  const reversal =
    /SET LOCAL ROLE daftar_accounting_internal;[\s\S]*?CREATE OR REPLACE FUNCTION accounting_reversals_20_domain_source_guard\(\)[\s\S]*?\$\$;/.exec(sources);
  if (!reversal) fail('objects', 'accounting_reversals_20_domain_source_guard() is not replaced by its owner in 0063');
  else
    for (const st of ['inventory_adjustment', 'inventory_opening', 'purchase', 'negative_inventory_cost_adjustment']) {
      if (!reversal[0].includes(`'${st}'`)) fail('objects', `the replaced reversal guard does not name ${st}`);
    }
  for (const role of ['inventory', 'accounting']) {
    const granted = sql.includes(`GRANT CREATE ON SCHEMA public TO daftar_${role}_internal`);
    const revoked = sql.includes(`REVOKE CREATE ON SCHEMA public FROM daftar_${role}_internal`);
    if (sql.includes(`OWNER TO daftar_${role}_internal`) && (!granted || !revoked)) {
      fail('objects', `ownership handed to daftar_${role}_internal without the CREATE-on-public bracket`);
    }
  }
  if (failures === mark)
    ok(`the gaps function keeps all ${s3Digests.length} P3-S3 digests; the owner-replaced reversal guard names four types; both CREATE brackets`);
}

// ── 4. Packages ─────────────────────────────────────────────────────────────
function checkPackages(): void {
  console.log('P3-S4 GATE — packages');
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
  const coverage = existsSync(join(ROOT, 'packages/inventory/vectors/coverage-vectors.json')) ? read('packages/inventory/vectors/coverage-vectors.json') : '';
  for (const id of COVERAGE_CASES) {
    if (!coverage.includes(`"${id}"`)) fail('package', `coverage-vectors.json has no case ${id}`);
  }
  const post = stripTsProse(read('packages/accounting/src/post.ts'));
  const domain = /DOMAIN_SOURCE_TYPES\s*=\s*\[([^\]]*)\]/.exec(post);
  if (!domain || !['purchase', 'negative_inventory_cost_adjustment'].every((st) => (domain[1] ?? '').includes(`'${st}'`)))
    fail('package', 'DOMAIN_SOURCE_TYPES does not name both P3-S4 source types');
  else ok('DOMAIN_SOURCE_TYPES names both P3-S4 source types; the coverage vectors carry every named case');
}

// ── 5. Suites ───────────────────────────────────────────────────────────────
function checkSuites(): void {
  console.log('P3-S4 GATE — behavioural suites');
  for (const path of REQUIRED_SUITES) {
    if (existsSync(join(ROOT, path))) ok(path);
    else fail('suite', `${path} is missing`);
  }
  const discovered = discoveredSuites();
  if (discovered.length < MIN_SUITES) fail('suite', `fewer than ${MIN_SUITES} purchase-s4-* suites exist (found ${discovered.length})`);
  else ok(`${discovered.length} P3-S4 suites discovered`);
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
  { name: 'P3-S3 gate (permanent predecessor, composes P3-S2, P3-S1, P2-S8…P2-S1 and Phase 1)', cmd: npm, args: ['run', 'gate:phase3:s3'] },
  { name: '@daftar/inventory unit suite (payloads, landed cost, shares, coverage vectors)', cmd: npm, args: ['run', 'test', '-w', '@daftar/inventory'] },
  { name: '@daftar/accounting unit suite (domain posting)', cmd: npm, args: ['run', 'test', '-w', '@daftar/accounting'] },
  {
    name: 'P3-S4 supplier, purchase, receipt, coverage, isolation, concurrency and idempotency suites',
    cmd: 'npx',
    args: ['vitest', 'run', ...discoveredSuites()],
  },
  {
    name: 'Budget A in isolation (two WHEN-filtered deferred triggers on journal_entries)',
    cmd: 'npx',
    args: ['vitest', 'run', 'tests/performance/accounting-budgets.test.ts'],
  },
];

function runSteps(): void {
  console.log('P3-S4 GATE — composed regression matrix');
  checkRunnerReportsFailure();
  if (failures > 0) {
    console.error('\nP3-S4 GATE: FAIL — the test runner cannot report failure; refusing to run the regression matrix');
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
  console.log(`P3-S4 GATE plan (${ACCEPTED ? 'accepted' : 'candidate'}):`);
  if (ACCEPTED) console.log(`  structural: frozenThrough at or beyond ${S4_BOUNDARY}; ${S4_MIGRATIONS.join(', ')} at their accepted digests`);
  else console.log(`  structural: frozenThrough = ${S3_BOUNDARY}; after it exactly ${S4_MIGRATIONS.join(', ')}, neither in the manifest`);
  console.log('  structural: registrations exactly P3-S4’s own; EXECUTE exactly eight grants; no role change, later-slice table or reserved column');
  console.log(
    '  structural: OD-03 bounded; tables, bridges, guard triggers, entry routines and helpers exist; S3 digests kept; reversal guard; CREATE brackets',
  );
  console.log('  structural: packages and vectors present; @daftar/inventory framework-free; every P3-S4 suite exists');
  for (const s of STEPS()) console.log(`  command:    ${s.cmd} ${s.args.join(' ')}`);
  process.exit(0);
}

checkMigrationBoundary();
checkScope();
checkRequiredObjects();
checkPackages();
checkSuites();
if (failures > 0) {
  console.error(`\nP3-S4 GATE: FAIL (${failures} structural violation${failures === 1 ? '' : 's'}) — not running the regression matrix`);
  process.exit(1);
}
runSteps();

if (failures > 0) {
  console.error(`\nP3-S4 GATE: FAIL (${failures})`);
  process.exit(1);
}
console.log('\nP3-S4 GATE: PASS');
