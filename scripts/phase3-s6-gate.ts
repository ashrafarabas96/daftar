#!/usr/bin/env tsx
/**
 * PHASE 3 SLICE GATE — P3-S6, payment methods and supplier settlement
 * (docs/PHASE_3_EXECUTION_PLAN.md §8, docs/PHASE_3_S6_CONTRACT.md §7.1).
 *
 * Two tenses, chosen by `S6_ACCEPTED` alone, as in `phase3-s5-gate.ts`:
 *
 *   — CANDIDATE (`S6_ACCEPTED` empty): `frozenThrough` is the P3-S5 boundary,
 *     neither S6 migration is in the manifest, and the only migrations after
 *     0066 are exactly 0067 and 0068.
 *   — ACCEPTED (`S6_ACCEPTED` holds both digests): `frozenThrough` is a floor
 *     at 0068, each S6 migration hashes to its accepted digest on disk AND in
 *     the manifest, and 0067–0068 hold exactly those files.
 *
 * Structural checks: the registrations are exactly P3-S6's own (three
 * accounting source types and their post kinds, seven operation kinds, no
 * stock source or movement kind); EXECUTE exactly the eight grants; UPDATE and
 * DELETE only as contract A-17 lists them; no role change; no customer-side or
 * later-slice table (MP-7); OD-03 (no tax object); the realized-FX and AP keys
 * present and no rounding or PPV key; every table, guard trigger and routine by
 * name; the owner-replaced credit-note guard, reversal guard and the two S5
 * extension points; the replaced source-guard gaps function keeping every
 * P3-S3, P3-S4 and P3-S5 digest except the credit-note guard's (0065 R-53,
 * coordinator ruling); the packages, vectors and the inventory-assertion
 * sequence seam; every P3-S6 suite.
 *
 * Then the runner canary, the permanent predecessor (`gate:phase3:s5`), both
 * package suites, the seam unit tests, every P3-S6 suite and Budget A in
 * isolation.
 *
 * Usage: npm run gate:phase3:s6 [-- --list]
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

/** The P3-S5 boundary, which P3-S6 sits directly on. */
const S5_BOUNDARY = '0066_supplier_return_reversal_commands.sql';

/** The P3-S6 migrations, in order. */
const S6_MIGRATIONS = ['0067_payment_methods_supplier_settlement_sources.sql', '0068_supplier_settlement_commands.sql'] as const;
const [SOURCES, COMMANDS] = S6_MIGRATIONS;

/** The P3-S6 acceptance boundary. A floor once accepted. */
const S6_BOUNDARY = COMMANDS;

/** The two P3-S6 migrations at their accepted digests. Empty while P3-S6 is a candidate; filled in the freeze commit only. */
const S6_ACCEPTED: Readonly<Record<string, string>> = {};

const ACCEPTED = Object.keys(S6_ACCEPTED).length > 0;

/** The seven operation kinds (contract A-03), one per entry routine. */
const OPERATION_KINDS = [
  'payment.create_method',
  'payment.update_method',
  'payment.deactivate_method',
  'payment.activate_method',
  'supplier.pay',
  'supplier.allocate_credit',
  'supplier.refund',
];

/** The exact registrations P3-S6 makes (contract §7.1-2). */
const REGISTRATIONS: readonly (readonly [string, readonly string[]])[] = [
  ['accounting_source_types', ["'supplier_payment'", "'supplier_credit_allocation'", "'supplier_refund'"]],
  ['accounting_operation_kinds', ["'post', 'supplier_payment'", "'post', 'supplier_credit_allocation'", "'post', 'supplier_refund'"]],
  ['inventory_operation_kinds', OPERATION_KINDS.map((k) => `'${k}'`)],
];
/** Registries P3-S6 must not touch. */
const CLOSED_REGISTRIES = [
  'stock_source_types',
  'stock_movement_kinds',
  'inventory_operation_movement_kinds',
  'accounting_system_account_keys',
  'permissions',
  'role_permissions',
];

const ENTRY_ROUTINES = [
  'payment_method_create',
  'payment_method_update',
  'payment_method_deactivate',
  'payment_method_activate',
  'supplier_pay',
  'supplier_allocate_credit',
  'supplier_refund',
];

/** EXECUTE grants P3-S6 may make, exactly (contract A-17, §7.1-2). */
const ALLOWED_EXECUTE = [...ENTRY_ROUTINES.map((r) => `${r}:daftar_app`), 'accounting_settlement_account_eligibility:daftar_inventory_internal'].sort();

/** UPDATE/DELETE grants P3-S6 may make, exactly (contract A-17): table → privilege keyword. */
const ALLOWED_WRITE_GRANTS = ['payment_methods:UPDATE', 'payment_method_names:UPDATE', 'payment_method_names:DELETE', 'supplier_credit_notes:UPDATE'].sort();

/** Tables owned by later slices or by the customer side (MP-7). */
const LATER_TABLES =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(payments|payment_allocations|payment_reversals|refunds|customer_\w*|credit_notes|invoice\w*|sale\w*|reservation\w*)\b/i;

const TABLES = [
  'payment_methods',
  'payment_method_names',
  'supplier_payments',
  'supplier_payment_allocations',
  'supplier_credit_allocations',
  'supplier_refunds',
];
const SETTLEMENT_TABLES = ['supplier_payments', 'supplier_payment_allocations', 'supplier_credit_allocations', 'supplier_refunds'];
const ARITHMETIC = [
  'supplier_convert_base',
  'supplier_ap_release',
  'supplier_credit_remaining_carrying',
  'purchase_settlement_verify',
  'supplier_credit_note_verify',
];
/** The §2.3 guard triggers and their functions (the credit-note guard is replaced, its S5 trigger unchanged). */
const GUARDS: readonly (readonly [trigger: string, fn: string])[] = [
  ['payment_methods_guard', 'payment_method_guard'],
  ['payment_methods_named', 'payment_method_named'],
  ['payment_method_names_guard', 'payment_method_name_guard'],
  ['supplier_payments_guard', 'supplier_payment_guard'],
  ['supplier_payments_complete', 'supplier_payment_complete'],
  ['supplier_payment_allocations_guard', 'supplier_payment_allocation_guard'],
  ['supplier_payment_allocations_value_complete', 'supplier_payment_allocation_value_complete'],
  ['supplier_credit_allocations_guard', 'supplier_credit_allocation_guard'],
  ['supplier_credit_allocations_value_complete', 'supplier_credit_allocation_value_complete'],
  ['supplier_refunds_guard', 'supplier_refund_guard'],
  ['supplier_refunds_value_complete', 'supplier_refund_value_complete'],
  ['purchase_reversals_unsettled', 'purchase_reversal_unsettled'],
];
/** The guards that judge INSERT as well as UPDATE and DELETE (tgtype 31, the 0063 R-34/R-39 hardening). */
const INSERT_GUARDS: readonly (readonly [trigger: string, table: string])[] = [
  ['payment_methods_guard', 'payment_methods'],
  ['payment_method_names_guard', 'payment_method_names'],
  ['supplier_payments_guard', 'supplier_payments'],
  ['supplier_payment_allocations_guard', 'supplier_payment_allocations'],
  ['supplier_credit_allocations_guard', 'supplier_credit_allocations'],
  ['supplier_refunds_guard', 'supplier_refunds'],
];
const ACCOUNTING_COMPLETENESS = ['supplier_payment', 'supplier_credit_allocation', 'supplier_refund'];

const PACKAGE_FILES = [
  'packages/inventory/src/supplier-settlement.ts',
  'packages/inventory/src/supplier-settlement-payloads.ts',
  'packages/inventory/src/payment-method-payloads.ts',
  'packages/inventory/vectors/invpl-s6-vectors.json',
  'packages/inventory/vectors/supplier-settlement-vectors.json',
];
/** Case ids the settlement vectors must carry (contract §4.1); reconciled with the package on integration. */
const SETTLEMENT_CASES: readonly string[] = [];

/** Every P3-S6 suite is discovered by name; at least these must exist. */
const SUITE_PATTERN = /^settlement-s6-.*\.test\.ts$/;
const REQUIRED_SUITE_NAMES = [
  'settlement-s6-payment-method',
  'settlement-s6-payment-method-history',
  'settlement-s6-over-allocation',
  'settlement-s6-realized-fx',
  'settlement-s6-carrying-release',
  'settlement-s6-credit-concurrency',
  'settlement-s6-no-customer-payments',
  'settlement-s6-receive-and-pay',
  'settlement-s6-upgrade',
];
const MIN_SUITES = 18;

const discoveredSuites = (): string[] =>
  ['tests/integration', 'tests/security']
    .flatMap((dir) =>
      readdirSync(join(ROOT, dir))
        .filter((f) => SUITE_PATTERN.test(f))
        .map((f) => `${dir}/${f}`),
    )
    .sort();

/** The seam unit tests (contract §7.1-8): any `apps/api` or `tests` file named for the seam. */
const seamUnitTests = (): string[] =>
  ['tests/integration', 'tests/unit', 'apps/api/test', 'apps/api/src/infra']
    .filter((dir) => existsSync(join(ROOT, dir)))
    .flatMap((dir) =>
      readdirSync(join(ROOT, dir))
        .filter((f) => /seam.*\.test\.ts$/.test(f))
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
const bothMigrations = (): string => S6_MIGRATIONS.map((m) => migration(m) ?? '').join('\n');
const stripTsProse = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

// ── 1. Migration boundary ───────────────────────────────────────────────────
function checkMigrationBoundary(): void {
  console.log(`P3-S6 GATE — migration boundary (${ACCEPTED ? 'accepted' : 'candidate'})`);
  const manifest = JSON.parse(read('infrastructure/database/MIGRATION_MANIFEST.json')) as {
    frozenThrough: string;
    migrations: { name: string; sha256: string }[];
  };
  const recorded = new Map(manifest.migrations.map((m) => [m.name, m.sha256]));
  for (const name of S6_MIGRATIONS) {
    if (!existsSync(join(MIGRATIONS_DIR, name))) fail('boundary', `${name} is missing`);
  }

  if (!ACCEPTED) {
    if (manifest.frozenThrough !== S5_BOUNDARY) {
      fail('boundary', `frozenThrough is ${manifest.frozenThrough} — a P3-S6 candidate sits on the P3-S5 boundary ${S5_BOUNDARY}`);
    } else {
      ok(`frozenThrough = ${S5_BOUNDARY} — P3-S6 is not frozen`);
    }
    for (const name of S6_MIGRATIONS) {
      if (recorded.has(name)) fail('boundary', `${name} is in the manifest before P3-S6 was accepted — premature freeze`);
    }
    const after = sqlFiles().filter((f) => f > S5_BOUNDARY);
    if (JSON.stringify(after) !== JSON.stringify([...S6_MIGRATIONS])) {
      fail('boundary', `after 0066 a P3-S6 candidate holds exactly ${S6_MIGRATIONS.join(', ')} — found ${after.join(', ') || 'none'}`);
    } else {
      ok('after 0066 the tree holds exactly the two P3-S6 migrations');
    }
    return;
  }

  if (manifest.frozenThrough < S6_BOUNDARY) {
    fail('boundary', `frozenThrough is ${manifest.frozenThrough} — P3-S6 was accepted and frozen, so it must be at least ${S6_BOUNDARY}`);
  } else {
    ok(`frozenThrough = ${manifest.frozenThrough} — at or beyond the P3-S6 acceptance boundary`);
  }
  if (JSON.stringify(Object.keys(S6_ACCEPTED).sort()) !== JSON.stringify([...S6_MIGRATIONS])) {
    fail('boundary', `S6_ACCEPTED must name exactly ${S6_MIGRATIONS.join(', ')}`);
  }
  const before = failures;
  for (const [name, accepted] of Object.entries(S6_ACCEPTED)) {
    const path = join(MIGRATIONS_DIR, name);
    if (!existsSync(path)) continue;
    const onDisk = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (onDisk !== accepted) fail('boundary', `${name} hashes to ${onDisk.slice(0, 12)}… on disk but was accepted at ${accepted.slice(0, 12)}…`);
    const inManifest = recorded.get(name);
    if (inManifest === undefined) fail('boundary', `${name} was accepted but is not frozen in the manifest`);
    else if (inManifest !== accepted)
      fail('boundary', `${name} is recorded as ${inManifest.slice(0, 12)}… in the manifest but was accepted at ${accepted.slice(0, 12)}…`);
  }
  if (failures === before) ok(`the ${S6_MIGRATIONS.length} P3-S6 migrations hash to their accepted digests on disk and in the manifest`);
  const inRange = sqlFiles().filter((f) => f > S5_BOUNDARY && f <= S6_BOUNDARY);
  if (JSON.stringify(inRange) !== JSON.stringify([...S6_MIGRATIONS])) {
    fail('boundary', `0067–0068 must hold exactly ${S6_MIGRATIONS.join(', ')} — found ${inRange.join(', ') || 'none'}`);
  } else {
    ok('0067–0068 holds exactly the two accepted files');
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
  console.log('P3-S6 GATE — slice scope');
  const sql = bothMigrations();
  const before = failures;
  // Compared without whitespace: a tuple may be written `('a','b')` or `('a', 'b')`.
  const bare = (text: string): string => text.replace(/\s+/g, '');
  for (const [table, expected] of REGISTRATIONS) {
    const tuples = insertedTuples(sql, table);
    const matched = expected.map((e) => tuples.filter((t) => bare(t).startsWith(`(${bare(e)}`)).length);
    if (tuples.length !== expected.length || matched.some((n) => n !== 1)) {
      fail('scope', `${table}: P3-S6 registers exactly ${expected.join(' | ')} — found ${tuples.join(' | ') || 'none'}`);
    }
  }
  for (const table of CLOSED_REGISTRIES) {
    if (new RegExp(`INSERT\\s+INTO\\s+${table}\\b`, 'i').test(sql)) fail('scope', `P3-S6 inserts into ${table} — that registry is closed to this slice`);
  }
  if (/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+inventory_stock_source_guard_gaps\b/i.test(migration(COMMANDS) ?? ''))
    fail('scope', `${COMMANDS} replaces inventory_stock_source_guard_gaps() — only ${SOURCES} may (0065 R-53)`);
  const table = LATER_TABLES.exec(sql);
  if (table) fail('scope', `a P3-S6 migration creates ${table[1]} — customer-side or later-slice table (MP-7)`);
  const grants = [...sql.matchAll(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+(\w+)\s*\((?:[^()]|\([^()]*\))*\)\s+TO\s+(\w+)/gi)].map((m) => `${m[1]}:${m[2]}`).sort();
  const grantStatements = (sql.match(/GRANT\s+EXECUTE\b/gi) ?? []).length;
  if (JSON.stringify(grants) !== JSON.stringify(ALLOWED_EXECUTE) || grantStatements !== ALLOWED_EXECUTE.length) {
    fail('scope', `EXECUTE grants must be exactly ${ALLOWED_EXECUTE.join(', ')} — found ${grants.join(', ') || 'none'} (${grantStatements} statements)`);
  }
  if (/\b(BYPASSRLS|ALTER\s+ROLE|CREATE\s+ROLE)\b/i.test(sql) || /\bGRANT\s+daftar_\w+\s+TO\b/i.test(sql)) {
    fail('scope', 'a P3-S6 migration changes a role or a role membership — roles belong to bootstrap');
  }
  // OD-03 (P3-AL-23): no tax object at all in P3-S6.
  if (/\btax_payable\b/i.test(sql)) fail('od-03', 'a P3-S6 migration names tax_payable — tax posting is BLOCKED BY OD-03');
  if (/^\s*\w*tax\w*\s+[A-Z]/im.test(sql)) fail('od-03', 'a P3-S6 migration defines a tax column — BLOCKED BY OD-03');
  if (/'rounding'/.test(sql)) fail('scope', 'a P3-S6 migration names the rounding system key — realized FX is never rounding (AL-28)');
  if (/'purchase_price_variance'/.test(sql)) fail('scope', 'a P3-S6 migration names the PPV key — settlement differences are realized FX');
  if (/\bround\(/i.test(sql)) fail('scope', 'a P3-S6 migration calls round( — inventory_half_even only');
  const sources = migration(SOURCES) ?? '';
  for (const key of ['fx_gain', 'fx_loss', 'accounts_payable', 'supplier_receivable']) {
    if (!sources.includes(`'${key}'`)) fail('scope', `${SOURCES} does not name the ${key} system key its entries need (A-14(a))`);
  }
  // UPDATE/DELETE exactly as A-17 lists them; never on the four settlement tables.
  const writes: string[] = [];
  for (const m of sql.matchAll(/GRANT\s+([^;]+?)\s+ON\s+(?:TABLE\s+)?([\w,\s]+?)\s+TO\s+(\w+)/gi)) {
    const privileges = m[1] ?? '';
    if (/^EXECUTE\b/i.test(privileges.trim())) continue;
    const tables = (m[2] ?? '').split(',').map((t) => t.trim());
    for (const kw of ['UPDATE', 'DELETE', 'TRUNCATE']) {
      if (new RegExp(`\\b${kw}\\b`, 'i').test(privileges)) for (const t of tables) writes.push(`${t}:${kw}`);
    }
  }
  const sortedWrites = [...new Set(writes)].sort();
  if (JSON.stringify(sortedWrites) !== JSON.stringify(ALLOWED_WRITE_GRANTS))
    fail('scope', `UPDATE/DELETE grants must be exactly ${ALLOWED_WRITE_GRANTS.join(', ')} (A-17) — found ${sortedWrites.join(', ') || 'none'}`);
  if (writes.some((w) => SETTLEMENT_TABLES.includes(w.split(':')[0] ?? ''))) fail('scope', 'a runtime role gains UPDATE or DELETE on a settlement table');
  // ALTER TABLE on an earlier slice's table only as the S5 candidate key (§7.1-2).
  const s6Tables = new Set(TABLES);
  const alters = [...sql.matchAll(/ALTER\s+TABLE\s+(?:ONLY\s+)?(\w+)\s+([^;]*);/gi)].filter((m) => !s6Tables.has(m[1] ?? ''));
  const allowedAlters = ['supplier_credit_notes:ADD CONSTRAINT supplier_credit_notes_supplier_uq'];
  const found = alters.map((m) => `${m[1] ?? ''}:${(m[2] ?? '').replace(/\s+/g, ' ').trim()}`);
  const unexpected = found.filter((f) => !allowedAlters.some((allowed) => f.startsWith(allowed)));
  if (unexpected.length > 0 || found.length !== allowedAlters.length)
    fail('scope', `P3-S6 may alter an earlier table only by the supplier_credit_notes candidate key — found ${found.join(' | ') || 'none'}`);
  const policies = [...sql.matchAll(/ALTER\s+POLICY\s+(\w+)\s+ON\s+(\w+)/gi)].map((m) => `${m[2]}.${m[1]}`);
  if (policies.some((p) => p !== 'supplier_credit_notes.business_isolation_read'))
    fail('scope', `P3-S6 may alter only supplier_credit_notes.business_isolation_read — found ${policies.join(', ')}`);
  if (failures === before)
    ok(
      'registrations exactly P3-S6’s own; EXECUTE exactly eight grants; UPDATE/DELETE exactly A-17; one candidate key; OD-03 bounded; no role change, rounding, PPV or customer-side table',
    );
}

// ── 3. Required objects ─────────────────────────────────────────────────────
function checkRequiredObjects(): void {
  console.log('P3-S6 GATE — required objects (contract §2)');
  const sources = migration(SOURCES) ?? '';
  const commands = migration(COMMANDS) ?? '';
  const sql = `${sources}\n${commands}`;
  const before = failures;
  for (const t of TABLES) {
    if (!new RegExp(`CREATE TABLE ${t}\\b`).test(sources)) fail('objects', `table ${t} is not created by ${SOURCES}`);
  }
  for (const [t, fn] of GUARDS) {
    if (!new RegExp(`CREATE (CONSTRAINT )?TRIGGER ${t}\\b`).test(sources)) fail('objects', `trigger ${t} is not created by ${SOURCES}`);
    if (!new RegExp(`FUNCTION ${fn}\\(`).test(sources)) fail('objects', `guard function ${fn}() is not created by ${SOURCES}`);
  }
  for (const [t, table] of INSERT_GUARDS) {
    if (!new RegExp(`^CREATE TRIGGER ${t}\\s+BEFORE INSERT OR UPDATE OR DELETE ON ${table}\\s`, 'm').test(sources)) {
      fail('objects', `trigger ${t} does not judge INSERT, UPDATE and DELETE on ${table}`);
    }
  }
  for (const fn of ARITHMETIC) {
    if (!new RegExp(`FUNCTION ${fn}\\(`).test(sources)) fail('objects', `${fn}() is not created by ${SOURCES}`);
  }
  if (!/FUNCTION supplier_settlement_guard_gaps\(/.test(sources)) fail('objects', `supplier_settlement_guard_gaps() is not created by ${SOURCES}`);
  for (const r of ENTRY_ROUTINES) {
    if (!new RegExp(`FUNCTION ${r}\\(`).test(commands)) fail('objects', `entry routine ${r} is not created by ${COMMANDS}`);
  }
  for (const st of ACCOUNTING_COMPLETENESS) {
    if (!new RegExp(`CREATE CONSTRAINT TRIGGER journal_entries_${st}_complete\\b`).test(sources))
      fail('objects', `the ${st} entry-completeness trigger is not created by ${SOURCES}`);
  }
  if (failures === before)
    ok(
      `${TABLES.length} tables, ${GUARDS.length} guard triggers (${INSERT_GUARDS.length} judging INSERT), ${ARITHMETIC.length} arithmetic and verify functions, the S6 gaps report, ${ENTRY_ROUTINES.length} entry routines, ${ACCOUNTING_COMPLETENESS.length} entry-completeness triggers`,
    );

  const mark = failures;
  // The credit-note guard, replaced by its owner, admits exactly the AL-31 decrement (A-12).
  const note = /SET LOCAL ROLE daftar_inventory_internal;[\s\S]*?CREATE OR REPLACE FUNCTION supplier_credit_note_guard\(\)([\s\S]*?)\$\$;/.exec(sources);
  if (!note || !(note[1] ?? '').includes('supplier_credit_remaining_carrying'))
    fail('objects', 'supplier_credit_note_guard() is not replaced by its owner with the remaining-carrying rule (A-12)');
  // The two S5 extension points now read both allocation tables (S5 TL-9).
  for (const fn of ['purchase_ap_outstanding', 'purchase_settlement_state']) {
    const body = new RegExp(`CREATE OR REPLACE FUNCTION ${fn}\\(([\\s\\S]*?)\\$\\$;`).exec(sources);
    if (!body || !(body[1] ?? '').includes('supplier_payment_allocations') || !(body[1] ?? '').includes('supplier_credit_allocations'))
      fail('objects', `${fn}() is not replaced to read both allocation tables (S5 TL-9)`);
  }
  // The reversal guard is replaced by its owner and refuses the three settlement types.
  const reversal =
    /SET LOCAL ROLE daftar_accounting_internal;[\s\S]*?CREATE OR REPLACE FUNCTION accounting_reversals_20_domain_source_guard\(\)[\s\S]*?\$\$;/.exec(sources);
  if (!reversal) fail('objects', `accounting_reversals_20_domain_source_guard() is not replaced by its owner in ${SOURCES}`);
  else
    for (const token of [
      'purchase_reversals',
      "'inventory_adjustment'",
      "'inventory_opening'",
      "'negative_inventory_cost_adjustment'",
      "'supplier_return'",
      "'supplier_payment'",
      "'supplier_credit_allocation'",
      "'supplier_refund'",
    ]) {
      if (!reversal[0].includes(token)) fail('objects', `the replaced reversal guard does not name ${token}`);
    }
  // The source-guard gaps function is replaced (0065 R-53): every earlier digest verbatim except the credit-note guard's.
  const s5Sources = migration('0065_supplier_returns_reversals_sources.sql') ?? '';
  const noteDigest = /"supplier_credit_note_guard\(\)":\s*"([0-9a-f]{64})"/.exec(s5Sources)?.[1];
  const priorDigests = [...s5Sources.matchAll(/"(\w+\(\))":\s*"([0-9a-f]{64})"/g)]
    .filter((m) => m[1] !== 'supplier_credit_note_guard()')
    .map((m) => `"${m[1]}": "${m[2]}"`);
  if (!/CREATE OR REPLACE FUNCTION inventory_stock_source_guard_gaps\(/.test(sources))
    fail('objects', `${SOURCES} does not replace inventory_stock_source_guard_gaps() although it replaces a guard 0065 records by digest (R-53)`);
  if (priorDigests.length < 30) fail('objects', `found only ${priorDigests.length} earlier guard digests in 0065 — the reference is unreadable`);
  for (const d of priorDigests) {
    if (!sources.includes(d)) fail('objects', `the replaced gaps function drops or changes the digest ${d.slice(0, 48)}…`);
  }
  if (noteDigest && new RegExp(`"supplier_credit_note_guard\\(\\)":\\s*"${noteDigest}"`).test(sources))
    fail('objects', 'the replaced gaps function keeps the S5 digest of supplier_credit_note_guard() although the body changed');
  for (const role of ['inventory', 'accounting']) {
    const granted = sql.includes(`GRANT CREATE ON SCHEMA public TO daftar_${role}_internal`);
    const revoked = sql.includes(`REVOKE CREATE ON SCHEMA public FROM daftar_${role}_internal`);
    if (sql.includes(`OWNER TO daftar_${role}_internal`) && (!granted || !revoked)) {
      fail('objects', `ownership handed to daftar_${role}_internal without the CREATE-on-public bracket`);
    }
  }
  if (failures === mark)
    ok(
      `the owner-replaced credit-note guard, extension points and reversal guard; the gaps function keeps all ${priorDigests.length} earlier digests and re-records the credit-note guard; both CREATE brackets`,
    );
}

// ── 4. Packages ─────────────────────────────────────────────────────────────
function checkPackages(): void {
  console.log('P3-S6 GATE — packages');
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
  const vectors = existsSync(join(ROOT, 'packages/inventory/vectors/supplier-settlement-vectors.json'))
    ? read('packages/inventory/vectors/supplier-settlement-vectors.json')
    : '';
  for (const id of SETTLEMENT_CASES) {
    if (!vectors.includes(`"${id}"`)) fail('package', `supplier-settlement-vectors.json has no case ${id}`);
  }
  const post = stripTsProse(read('packages/accounting/src/post.ts'));
  const domain = /DOMAIN_SOURCE_TYPES\s*=\s*\[([^\]]*)\]/.exec(post);
  for (const st of ACCOUNTING_COMPLETENESS) {
    if (!domain || !(domain[1] ?? '').includes(`'${st}'`)) fail('package', `DOMAIN_SOURCE_TYPES does not name ${st}`);
  }
  const reversible = /DOMAIN_REVERSIBLE_SOURCE_TYPES\s*=\s*\[([^\]]*)\]/.exec(post);
  if (!reversible || (reversible[1] ?? '').replace(/\s+/g, '') !== "'purchase'")
    fail('package', "DOMAIN_REVERSIBLE_SOURCE_TYPES must be exactly ['purchase'] (TD-15)");
  const seam = stripTsProse(read('apps/api/src/infra/database.ts'));
  for (const name of ['InventoryAssertionSequence', 'presentInventoryAssertion']) {
    if (!new RegExp(`export\\s+(?:class|function|type|interface|const)\\s+${name}\\b`).test(seam) && !new RegExp(`\\b${name}\\s*\\(`).test(seam))
      fail('package', `${name} is not provided by apps/api/src/infra/database.ts (A-19)`);
  }
  if (failures === packageMark)
    ok('DOMAIN_SOURCE_TYPES names the three settlement types; nothing new is reversible; the inventory-assertion sequence seam exists');
}

// ── 5. Suites ───────────────────────────────────────────────────────────────
function checkSuites(): void {
  console.log('P3-S6 GATE — behavioural suites');
  const names = discoveredSuites().map((path) => path.replace(/^.*\//, '').replace(/\.test\.ts$/, ''));
  for (const name of REQUIRED_SUITE_NAMES) {
    if (names.includes(name)) ok(name);
    else fail('suite', `${name}.test.ts is missing from tests/integration and tests/security`);
  }
  const discovered = discoveredSuites();
  if (discovered.length < MIN_SUITES) fail('suite', `fewer than ${MIN_SUITES} settlement-s6-* suites exist (found ${discovered.length})`);
  else ok(`${discovered.length} P3-S6 suites discovered`);
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
  { name: 'P3-S5 gate (permanent predecessor, composes P3-S4 … P3-S1, P2-S8 … P2-S1 and Phase 1)', cmd: npm, args: ['run', 'gate:phase3:s5'] },
  { name: '@daftar/inventory unit suite (settlement arithmetic, S6 payload vectors)', cmd: npm, args: ['run', 'test', '-w', '@daftar/inventory'] },
  { name: '@daftar/accounting unit suite (domain posting)', cmd: npm, args: ['run', 'test', '-w', '@daftar/accounting'] },
  { name: 'apps/api seam unit tests (accounting and inventory assertion sequences)', cmd: 'npx', args: ['vitest', 'run', ...seamUnitTests()] },
  {
    name: 'P3-S6 payment-method, payment, allocation, credit, refund, isolation, concurrency and idempotency suites',
    cmd: 'npx',
    args: ['vitest', 'run', ...discoveredSuites()],
  },
  {
    name: 'Budget A in isolation (three more WHEN-filtered deferred triggers on journal_entries)',
    cmd: 'npx',
    args: ['vitest', 'run', 'tests/performance/accounting-budgets.test.ts'],
  },
];

function runSteps(): void {
  console.log('P3-S6 GATE — composed regression matrix');
  checkRunnerReportsFailure();
  if (failures > 0) {
    console.error('\nP3-S6 GATE: FAIL — the test runner cannot report failure; refusing to run the regression matrix');
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
  console.log(`P3-S6 GATE plan (${ACCEPTED ? 'accepted' : 'candidate'}):`);
  if (ACCEPTED) console.log(`  structural: frozenThrough at or beyond ${S6_BOUNDARY}; ${S6_MIGRATIONS.join(', ')} at their accepted digests`);
  else console.log(`  structural: frozenThrough = ${S5_BOUNDARY}; after it exactly ${S6_MIGRATIONS.join(', ')}, neither in the manifest`);
  console.log(
    '  structural: registrations exactly P3-S6’s own; EXECUTE exactly eight grants; UPDATE/DELETE exactly A-17; no role change, rounding, PPV or customer-side table',
  );
  console.log(
    '  structural: OD-03 bounded; tables, guards, arithmetic, routines exist; replaced credit-note guard, extension points, reversal guard and gaps function',
  );
  console.log('  structural: packages present; @daftar/inventory framework-free; the inventory-assertion sequence seam; every P3-S6 suite exists');
  for (const s of STEPS()) console.log(`  command:    ${s.cmd} ${s.args.join(' ')}`);
  process.exit(0);
}

checkMigrationBoundary();
checkScope();
checkRequiredObjects();
checkPackages();
checkSuites();
if (failures > 0) {
  console.error(`\nP3-S6 GATE: FAIL (${failures} structural violation${failures === 1 ? '' : 's'}) — not running the regression matrix`);
  process.exit(1);
}
runSteps();

if (failures > 0) {
  console.error(`\nP3-S6 GATE: FAIL (${failures})`);
  process.exit(1);
}
console.log('\nP3-S6 GATE: PASS');
