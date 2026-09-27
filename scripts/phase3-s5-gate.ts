#!/usr/bin/env tsx
/**
 * PHASE 3 SLICE GATE — P3-S5, supplier returns, PPV, supplier credit notes
 * and purchase reversal (docs/PHASE_3_EXECUTION_PLAN.md §7,
 * docs/PHASE_3_S5_CONTRACT.md §7.1).
 *
 * Two tenses, chosen by `S5_ACCEPTED` alone, as in `phase3-s4-gate.ts`:
 *
 *   — CANDIDATE (`S5_ACCEPTED` empty): `frozenThrough` is the P3-S4 boundary,
 *     neither S5 migration is in the manifest, and the only migrations after
 *     0064 are exactly 0065 and 0066.
 *   — ACCEPTED (`S5_ACCEPTED` holds both digests): `frozenThrough` is a floor
 *     at 0066, each S5 migration hashes to its accepted digest on disk AND in
 *     the manifest, and 0065–0066 hold exactly those files.
 *
 * Structural checks: the registrations are exactly P3-S5's own (two stock
 * source types, two operation kinds and mappings, `supplier_return` as the
 * only accounting source — the reversal posts through the Phase 2 reversal
 * workflow, R-B2a); EXECUTE exactly the seven grants; no UPDATE or DELETE
 * grant and no role change; no S6+ table; OD-03 (no tax object); the PPV and
 * supplier-receivable keys present; every table, bridge, guard trigger and
 * routine by name, the detail guards judging INSERT; the replaced gaps
 * function keeping every P3-S3 and P3-S4 digest verbatim; the owner-replaced
 * reversal guard; the owner-replaced stock primitive with its
 * `purchase_reversal` branch (R-B1a, the Tech Lead's decision); the packages
 * and vectors; every P3-S5 suite.
 *
 * Then the runner canary, the permanent predecessor (`gate:phase3:s4`), both
 * package suites, every P3-S5 suite and Budget A in isolation.
 *
 * Usage: npm run gate:phase3:s5 [-- --list]
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

/** The P3-S4 boundary, which P3-S5 sits directly on. */
const S4_BOUNDARY = '0064_purchase_commands.sql';

/** The P3-S5 migrations, in order. */
const S5_MIGRATIONS = ['0065_supplier_returns_reversals_sources.sql', '0066_supplier_return_reversal_commands.sql'] as const;
const [SOURCES, COMMANDS] = S5_MIGRATIONS;

/** The P3-S5 acceptance boundary. A floor once accepted. */
const S5_BOUNDARY = COMMANDS;

/** The two P3-S5 migrations at their accepted digests. Empty while P3-S5 is a candidate; filled in the freeze commit only. */
const S5_ACCEPTED: Readonly<Record<string, string>> = {};

const ACCEPTED = Object.keys(S5_ACCEPTED).length > 0;

/** The exact registrations P3-S5 makes (contract §2, R-B2a: `purchase_reversal` is a stock source only). */
const REGISTRATIONS: readonly (readonly [string, readonly string[]])[] = [
  ['stock_source_types', ["'purchase_reversal'", "'supplier_return'"]],
  ['inventory_operation_kinds', ["'purchase.return'", "'purchase.reverse'"]],
  ['inventory_operation_movement_kinds', ["'purchase.return', 'supplier_return'", "'purchase.reverse', 'purchase_reversal'"]],
  ['accounting_source_types', ["'supplier_return'"]],
  ['accounting_operation_kinds', ["'post', 'supplier_return'"]],
];

/** EXECUTE grants P3-S5 may make, exactly (contract A-18, §7.1-2). */
const ALLOWED_EXECUTE = [
  'purchase_return:daftar_app',
  'purchase_reverse:daftar_app',
  'purchase_ap_outstanding:daftar_app',
  'purchase_ap_outstanding:daftar_inventory_internal',
  'purchase_settlement_state:daftar_app',
  'purchase_settlement_state:daftar_inventory_internal',
  'accounting_purchase_entry_id:daftar_inventory_internal',
].sort();

/** Tables owned by P3-S6 and later. */
const LATER_TABLES =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(supplier_payment\w*|supplier_allocation\w*|supplier_credit_allocation\w*|supplier_refund\w*|payment_method\w*|reservation\w*)\b/i;

const TABLES = ['supplier_returns', 'supplier_return_lines', 'supplier_credit_notes', 'purchase_reversals', 'purchase_reversal_lines'];
const STOCK_SOURCE_TYPES = ['supplier_return', 'purchase_reversal'];
const ENTRY_ROUTINES = ['purchase_return', 'purchase_reverse'];
const HELPERS = ['purchase_lock_stock_keys', 'purchase_bridge_return', 'purchase_bridge_reversal', 'purchase_ap_outstanding', 'purchase_settlement_state'];
const ACCOUNTING_OBJECTS = ['accounting_supplier_return_entry_complete', 'accounting_purchase_entry_id'];
const TRIGGERS = [
  ...STOCK_SOURCE_TYPES.flatMap((st) => [
    `stock_binding_requires_${st}`,
    `stock_bridge_immutable_${st}`,
    `stock_source_complete_${st}`,
    `stock_source_freeze_${st}`,
  ]),
  'supplier_returns_complete',
  'supplier_returns_immutable',
  'supplier_returns_value_complete',
  'supplier_return_lines_quantity_bound',
  'supplier_return_lines_same_transaction',
  'supplier_credit_notes_immutable',
  'supplier_credit_notes_same_transaction',
  'purchase_reversals_complete',
  'purchase_reversals_immutable',
  'purchase_reversals_value_complete',
  'purchase_reversal_lines_same_transaction',
  'journal_entries_supplier_return_complete',
];
/**
 * The detail guards that judge INSERT (the 0063 R-34/R-36 hardening carried
 * forward): a detail row may only be written in the transaction that created
 * its header.
 */
const INSERT_GUARDS: readonly (readonly [trigger: string, table: string])[] = [
  ['supplier_return_lines_same_transaction', 'supplier_return_lines'],
  ['supplier_credit_notes_same_transaction', 'supplier_credit_notes'],
  ['purchase_reversal_lines_same_transaction', 'purchase_reversal_lines'],
];

const PACKAGE_FILES = [
  'packages/inventory/src/supplier-return.ts',
  'packages/inventory/src/supplier-return-payloads.ts',
  'packages/inventory/src/purchase-reversal-payloads.ts',
  'packages/inventory/vectors/invpl-s5-vectors.json',
  'packages/inventory/vectors/supplier-return-vectors.json',
];
/** Case ids the supplier-return vectors must carry (contract §7.1-4). */
const RETURN_CASES = ['CUMULATIVE-THIRDS', 'FOREIGN-DUST', 'AP-FIRST-EXCESS', 'AP-EXHAUSTED', 'PPV-NEGATIVE', 'VALUE-ZERO'];

/** Every P3-S5 suite is discovered by name; at least these must exist. */
const SUITE_PATTERN = /^purchase-s5-.*\.test\.ts$/;
const REQUIRED_SUITE_NAMES = [
  'purchase-s5-quantity-bound',
  'purchase-s5-ap-first',
  'purchase-s5-reversal-preconditions',
  'purchase-s5-reversal-exact',
  'purchase-s5-signed-authority',
  'purchase-s5-upgrade',
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
const bothMigrations = (): string => S5_MIGRATIONS.map((m) => migration(m) ?? '').join('\n');
const stripTsProse = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

// ── 1. Migration boundary ───────────────────────────────────────────────────
function checkMigrationBoundary(): void {
  console.log(`P3-S5 GATE — migration boundary (${ACCEPTED ? 'accepted' : 'candidate'})`);
  const manifest = JSON.parse(read('infrastructure/database/MIGRATION_MANIFEST.json')) as {
    frozenThrough: string;
    migrations: { name: string; sha256: string }[];
  };
  const recorded = new Map(manifest.migrations.map((m) => [m.name, m.sha256]));
  for (const name of S5_MIGRATIONS) {
    if (!existsSync(join(MIGRATIONS_DIR, name))) fail('boundary', `${name} is missing`);
  }

  if (!ACCEPTED) {
    if (manifest.frozenThrough !== S4_BOUNDARY) {
      fail('boundary', `frozenThrough is ${manifest.frozenThrough} — a P3-S5 candidate sits on the P3-S4 boundary ${S4_BOUNDARY}`);
    } else {
      ok(`frozenThrough = ${S4_BOUNDARY} — P3-S5 is not frozen`);
    }
    for (const name of S5_MIGRATIONS) {
      if (recorded.has(name)) fail('boundary', `${name} is in the manifest before P3-S5 was accepted — premature freeze`);
    }
    const after = sqlFiles().filter((f) => f > S4_BOUNDARY);
    if (JSON.stringify(after) !== JSON.stringify([...S5_MIGRATIONS])) {
      fail('boundary', `after 0064 a P3-S5 candidate holds exactly ${S5_MIGRATIONS.join(', ')} — found ${after.join(', ') || 'none'}`);
    } else {
      ok('after 0064 the tree holds exactly the two P3-S5 migrations');
    }
    return;
  }

  if (manifest.frozenThrough < S5_BOUNDARY) {
    fail('boundary', `frozenThrough is ${manifest.frozenThrough} — P3-S5 was accepted and frozen, so it must be at least ${S5_BOUNDARY}`);
  } else {
    ok(`frozenThrough = ${manifest.frozenThrough} — at or beyond the P3-S5 acceptance boundary`);
  }
  if (JSON.stringify(Object.keys(S5_ACCEPTED).sort()) !== JSON.stringify([...S5_MIGRATIONS])) {
    fail('boundary', `S5_ACCEPTED must name exactly ${S5_MIGRATIONS.join(', ')}`);
  }
  const before = failures;
  for (const [name, accepted] of Object.entries(S5_ACCEPTED)) {
    const path = join(MIGRATIONS_DIR, name);
    if (!existsSync(path)) continue;
    const onDisk = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (onDisk !== accepted) fail('boundary', `${name} hashes to ${onDisk.slice(0, 12)}… on disk but was accepted at ${accepted.slice(0, 12)}…`);
    const inManifest = recorded.get(name);
    if (inManifest === undefined) fail('boundary', `${name} was accepted but is not frozen in the manifest`);
    else if (inManifest !== accepted)
      fail('boundary', `${name} is recorded as ${inManifest.slice(0, 12)}… in the manifest but was accepted at ${accepted.slice(0, 12)}…`);
  }
  if (failures === before) ok(`the ${S5_MIGRATIONS.length} P3-S5 migrations hash to their accepted digests on disk and in the manifest`);
  const inRange = sqlFiles().filter((f) => f > S4_BOUNDARY && f <= S5_BOUNDARY);
  if (JSON.stringify(inRange) !== JSON.stringify([...S5_MIGRATIONS])) {
    fail('boundary', `0065–0066 must hold exactly ${S5_MIGRATIONS.join(', ')} — found ${inRange.join(', ') || 'none'}`);
  } else {
    ok('0065–0066 holds exactly the two accepted files');
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
  console.log('P3-S5 GATE — slice scope');
  const sql = bothMigrations();
  const before = failures;
  for (const [table, expected] of REGISTRATIONS) {
    const tuples = insertedTuples(sql, table);
    // Compared without whitespace: a tuple may be written `('a','b')` or `('a', 'b')`.
    const bare = (text: string): string => text.replace(/\s+/g, '');
    const matched = expected.map((e) => tuples.filter((t) => bare(t).startsWith(`(${bare(e)}`)).length);
    if (tuples.length !== expected.length || matched.some((n) => n !== 1)) {
      fail('scope', `${table}: P3-S5 registers exactly ${expected.join(' | ')} — found ${tuples.join(' | ') || 'none'}`);
    }
  }
  if (/INSERT\s+INTO\s+stock_movement_kinds\b/i.test(sql)) fail('scope', 'P3-S5 registers a stock movement kind — the S2 registry is closed');
  const table = LATER_TABLES.exec(sql);
  if (table) fail('scope', `a P3-S5 migration creates ${table[1]} — it belongs to a later slice`);
  if (/^\s*(reserved|available)\s+[A-Z]/im.test(sql)) fail('scope', 'a P3-S5 migration defines a reserved/available column');
  const grants = [...sql.matchAll(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+(\w+)\s*\((?:[^()]|\([^()]*\))*\)\s+TO\s+(\w+)/gi)].map((m) => `${m[1]}:${m[2]}`).sort();
  const grantStatements = (sql.match(/GRANT\s+EXECUTE\b/gi) ?? []).length;
  if (JSON.stringify(grants) !== JSON.stringify(ALLOWED_EXECUTE) || grantStatements !== ALLOWED_EXECUTE.length) {
    fail('scope', `EXECUTE grants must be exactly ${ALLOWED_EXECUTE.join(', ')} — found ${grants.join(', ') || 'none'} (${grantStatements} statements)`);
  }
  if (/\b(BYPASSRLS|ALTER\s+ROLE|CREATE\s+ROLE)\b/i.test(sql) || /\bGRANT\s+daftar_\w+\s+TO\b/i.test(sql)) {
    fail('scope', 'a P3-S5 migration changes a role or a role membership — roles belong to bootstrap');
  }
  // OD-03 (P3-AL-23): no tax object at all in P3-S5.
  if (/\btax_payable\b/i.test(sql)) fail('od-03', 'a P3-S5 migration names tax_payable — purchase tax posting is BLOCKED BY OD-03');
  if (/^\s*\w*tax\w*\s+[A-Z]/im.test(sql)) fail('od-03', 'a P3-S5 migration defines a tax column — BLOCKED BY OD-03');
  if (/'rounding'/.test(sql)) fail('scope', 'a P3-S5 migration names the rounding system key');
  const sources = migration(SOURCES) ?? '';
  for (const key of ['purchase_price_variance', 'supplier_receivable']) {
    if (!sources.includes(`'${key}'`)) fail('scope', `${SOURCES} does not name the ${key} system key its return entry needs (A-15(a))`);
  }
  // Runtime roles gain no UPDATE or DELETE on any P3-S5 table.
  for (const m of sql.matchAll(/GRANT\s+([A-Z,\s]+?)\s+ON\s+(?:TABLE\s+)?([\w,\s]+?)\s+TO\s+(\w+)/gi)) {
    const privileges = m[1] ?? '';
    const tables = (m[2] ?? '').split(',').map((t) => t.trim());
    if (/\b(UPDATE|DELETE|TRUNCATE)\b/i.test(privileges) && tables.some((t) => TABLES.includes(t) || t.startsWith('stock_source_bridge_'))) {
      fail('scope', `a P3-S5 migration grants ${privileges.trim()} on ${tables.join(', ')} to ${m[3] ?? '?'} — the S5 documents are insert-only`);
    }
  }
  // No ALTER TABLE on an earlier slice's table beyond the two candidate keys (§2.1(2)).
  const s5Tables = new Set([...TABLES, ...STOCK_SOURCE_TYPES.map((st) => `stock_source_bridge_${st}`)]);
  const alters = [...sql.matchAll(/ALTER\s+TABLE\s+(?:ONLY\s+)?(\w+)\s+([^;]*);/gi)].filter((m) => !s5Tables.has(m[1] ?? ''));
  const allowedAlters = ['purchases:ADD CONSTRAINT purchases_supplier_uq UNIQUE', 'purchase_lines:ADD CONSTRAINT purchase_lines_line_variant_uq UNIQUE'];
  const found = alters.map((m) => `${m[1] ?? ''}:${(m[2] ?? '').replace(/\s+/g, ' ').trim()}`);
  const unexpected = found.filter((f) => !allowedAlters.some((allowed) => f.startsWith(allowed)));
  if (unexpected.length > 0 || found.length !== allowedAlters.length)
    fail('scope', `P3-S5 may alter an earlier table only by the two candidate keys — found ${found.join(' | ') || 'none'}`);
  if (failures === before)
    ok(
      'registrations exactly P3-S5’s own; EXECUTE exactly the seven grants; insert-only documents; two candidate keys; OD-03 bounded; no role change or later-slice table',
    );
}

// ── 3. Required objects ─────────────────────────────────────────────────────
function checkRequiredObjects(): void {
  console.log('P3-S5 GATE — required objects (contract §2)');
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
  for (const [t, table] of INSERT_GUARDS) {
    if (!new RegExp(`^CREATE TRIGGER ${t}\\s+BEFORE INSERT(?: OR UPDATE)?(?: OR DELETE)? ON ${table}\\s`, 'm').test(sources)) {
      fail('objects', `trigger ${t} does not judge INSERT on ${table}`);
    }
  }
  for (const r of ENTRY_ROUTINES) {
    if (!new RegExp(`FUNCTION ${r}\\(`).test(commands)) fail('objects', `entry routine ${r} is not created by ${COMMANDS}`);
  }
  for (const r of HELPERS) {
    if (!new RegExp(`FUNCTION ${r}\\(`).test(commands)) fail('objects', `helper or read function ${r} is not created by ${COMMANDS}`);
  }
  for (const r of ACCOUNTING_OBJECTS) {
    if (!new RegExp(`FUNCTION ${r}\\(`).test(sources)) fail('objects', `${r} is not created by ${SOURCES}`);
  }
  if (failures === before)
    ok(
      `${TABLES.length} tables, 2 bridges, ${TRIGGERS.length} triggers (${INSERT_GUARDS.length} judging INSERT), ${ENTRY_ROUTINES.length} entry routines, ${HELPERS.length} helpers, ${ACCOUNTING_OBJECTS.length} accounting objects`,
    );

  // The replaced gaps function keeps every P3-S3 and P3-S4 body digest verbatim (contract §2.3).
  const mark = before;
  const priorDigests = [...(migration('0063_purchases_suppliers_sources.sql') ?? '').matchAll(/"(\w+\(\))":\s*"([0-9a-f]{64})"/g)].map(
    (m) => `"${m[1]}": "${m[2]}"`,
  );
  if (!/CREATE OR REPLACE FUNCTION inventory_stock_source_guard_gaps\(/.test(sources))
    fail('objects', `${SOURCES} does not replace inventory_stock_source_guard_gaps()`);
  if (priorDigests.length < 24) fail('objects', `found only ${priorDigests.length} P3-S3/P3-S4 guard digests in 0063 — the reference is unreadable`);
  for (const d of priorDigests) {
    if (!sources.includes(d)) fail('objects', `the replaced gaps function drops or changes the digest ${d.slice(0, 48)}…`);
  }
  // The reversal guard is replaced by its owner: it admits a purchase entry only with its paired reversal document.
  const reversal =
    /SET LOCAL ROLE daftar_accounting_internal;[\s\S]*?CREATE OR REPLACE FUNCTION accounting_reversals_20_domain_source_guard\(\)[\s\S]*?\$\$;/.exec(sources);
  if (!reversal) fail('objects', `accounting_reversals_20_domain_source_guard() is not replaced by its owner in ${SOURCES}`);
  else
    for (const token of ['purchase_reversals', "'inventory_adjustment'", "'inventory_opening'", "'negative_inventory_cost_adjustment'", "'supplier_return'"]) {
      if (!reversal[0].includes(token)) fail('objects', `the replaced reversal guard does not name ${token}`);
    }
  // R-B1a (the Tech Lead's decision): the stock primitive is replaced by its owner with the purchase_reversal branch.
  const primitive = /SET LOCAL ROLE daftar_inventory_internal;[\s\S]*?CREATE OR REPLACE FUNCTION inventory_apply_stock_movements\(([\s\S]*?)\$\$;/.exec(
    sources,
  );
  if (!primitive || !(primitive[1] ?? '').includes("'purchase_reversal'"))
    fail('objects', 'the stock primitive is not replaced by its owner with the purchase_reversal branch (R-B1a)');
  for (const role of ['inventory', 'accounting']) {
    const granted = sql.includes(`GRANT CREATE ON SCHEMA public TO daftar_${role}_internal`);
    const revoked = sql.includes(`REVOKE CREATE ON SCHEMA public FROM daftar_${role}_internal`);
    if (sql.includes(`OWNER TO daftar_${role}_internal`) && (!granted || !revoked)) {
      fail('objects', `ownership handed to daftar_${role}_internal without the CREATE-on-public bracket`);
    }
  }
  if (failures === mark)
    ok(`the gaps function keeps all ${priorDigests.length} P3-S3/P3-S4 digests; the owner-replaced reversal guard and stock primitive; both CREATE brackets`);
}

// ── 4. Packages ─────────────────────────────────────────────────────────────
function checkPackages(): void {
  console.log('P3-S5 GATE — packages');
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
  const packageMark = failures;
  const vectors = existsSync(join(ROOT, 'packages/inventory/vectors/supplier-return-vectors.json'))
    ? read('packages/inventory/vectors/supplier-return-vectors.json')
    : '';
  for (const id of RETURN_CASES) {
    if (!vectors.includes(`"${id}"`)) fail('package', `supplier-return-vectors.json has no case ${id}`);
  }
  const post = stripTsProse(read('packages/accounting/src/post.ts'));
  const domain = /DOMAIN_SOURCE_TYPES\s*=\s*\[([^\]]*)\]/.exec(post);
  if (!domain || !(domain[1] ?? '').includes("'supplier_return'")) fail('package', 'DOMAIN_SOURCE_TYPES does not name supplier_return');
  const reversible = /DOMAIN_REVERSIBLE_SOURCE_TYPES\s*=\s*\[([^\]]*)\]/.exec(post);
  if (!reversible || (reversible[1] ?? '').replace(/\s+/g, '') !== "'purchase'") fail('package', "DOMAIN_REVERSIBLE_SOURCE_TYPES must be exactly ['purchase']");
  if (!/export\s+function\s+mintDomainReversalAssertion\b/.test(read('packages/accounting/src/domain-posting.ts')))
    fail('package', 'mintDomainReversalAssertion is not exported');
  if (failures === packageMark) ok('DOMAIN_SOURCE_TYPES, DOMAIN_REVERSIBLE_SOURCE_TYPES and the reversal minter; the return vectors carry every named case');
}

// ── 5. Suites ───────────────────────────────────────────────────────────────
function checkSuites(): void {
  console.log('P3-S5 GATE — behavioural suites');
  const names = discoveredSuites().map((path) => path.replace(/^.*\//, '').replace(/\.test\.ts$/, ''));
  for (const name of REQUIRED_SUITE_NAMES) {
    if (names.includes(name)) ok(name);
    else fail('suite', `${name}.test.ts is missing from tests/integration and tests/security`);
  }
  const discovered = discoveredSuites();
  if (discovered.length < MIN_SUITES) fail('suite', `fewer than ${MIN_SUITES} purchase-s5-* suites exist (found ${discovered.length})`);
  else ok(`${discovered.length} P3-S5 suites discovered`);
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
  { name: 'P3-S4 gate (permanent predecessor, composes P3-S3 … P3-S1, P2-S8 … P2-S1 and Phase 1)', cmd: npm, args: ['run', 'gate:phase3:s4'] },
  { name: '@daftar/inventory unit suite (return arithmetic, reversal twin, S5 payload vectors)', cmd: npm, args: ['run', 'test', '-w', '@daftar/inventory'] },
  { name: '@daftar/accounting unit suite (domain posting, the reversal minter)', cmd: npm, args: ['run', 'test', '-w', '@daftar/accounting'] },
  { name: 'P3-S5 return, reversal, credit note, isolation, concurrency and idempotency suites', cmd: 'npx', args: ['vitest', 'run', ...discoveredSuites()] },
  {
    name: 'Budget A in isolation (one more WHEN-filtered deferred trigger on journal_entries)',
    cmd: 'npx',
    args: ['vitest', 'run', 'tests/performance/accounting-budgets.test.ts'],
  },
];

function runSteps(): void {
  console.log('P3-S5 GATE — composed regression matrix');
  checkRunnerReportsFailure();
  if (failures > 0) {
    console.error('\nP3-S5 GATE: FAIL — the test runner cannot report failure; refusing to run the regression matrix');
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
  console.log(`P3-S5 GATE plan (${ACCEPTED ? 'accepted' : 'candidate'}):`);
  if (ACCEPTED) console.log(`  structural: frozenThrough at or beyond ${S5_BOUNDARY}; ${S5_MIGRATIONS.join(', ')} at their accepted digests`);
  else console.log(`  structural: frozenThrough = ${S4_BOUNDARY}; after it exactly ${S5_MIGRATIONS.join(', ')}, neither in the manifest`);
  console.log('  structural: registrations exactly P3-S5’s own; EXECUTE exactly seven grants; insert-only documents; no role change or later-slice table');
  console.log(
    '  structural: OD-03 bounded; tables, bridges, guard triggers, entry routines and helpers exist; S3 digests kept; reversal guard; CREATE brackets',
  );
  console.log('  structural: packages and vectors present; @daftar/inventory framework-free; every P3-S5 suite exists');
  for (const s of STEPS()) console.log(`  command:    ${s.cmd} ${s.args.join(' ')}`);
  process.exit(0);
}

checkMigrationBoundary();
checkScope();
checkRequiredObjects();
checkPackages();
checkSuites();
if (failures > 0) {
  console.error(`\nP3-S5 GATE: FAIL (${failures} structural violation${failures === 1 ? '' : 's'}) — not running the regression matrix`);
  process.exit(1);
}
runSteps();

if (failures > 0) {
  console.error(`\nP3-S5 GATE: FAIL (${failures})`);
  process.exit(1);
}
console.log('\nP3-S5 GATE: PASS');
