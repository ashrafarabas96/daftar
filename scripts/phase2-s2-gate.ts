#!/usr/bin/env tsx
/**
 * PHASE 2 SLICE GATE — P2-S2, the immutable journal structural core
 * (directive §42).
 *
 * `npm run gate:phase2:s2` is the deterministic answer to "is the journal
 * slice actually done, and did it stay inside its boundary?". P2-S2 ships
 * STRUCTURE only: tables, constraints, triggers, RLS and read grants. It
 * ships no writer. The two questions this gate exists to answer are therefore
 * "is every structural invariant really enforced by the database?" and "did
 * anything from P2-S3 sneak in early?".
 *
 * It COMPOSES rather than duplicates. P2-S1 is a permanent predecessor: its
 * gate runs first, unchanged, so the accepted chart slice keeps proving itself
 * forever. The guards (G-1 as data, G-2, G-3, authority isolation) live in
 * scripts/guards/ and are regression-tested on their own; here they are
 * invoked, not re-implemented. Matrix 1 and Matrix 2 are vitest suites; the
 * gate runs them, it does not restate their assertions.
 *
 * Structural checks run first because they are instant and because there is no
 * point running a test matrix against a tree that already broke the migration
 * boundary.
 *
 * Usage: npm run gate:phase2:s2 [-- --list]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { findAuthoritativeBalanceColumns } from './guards/no-authoritative-balance';
import { findAuthorityViolations } from './guards/authority-isolation';
import { findFloatRateColumns } from './guards/no-float-rate';
import { stripComments } from './guards/sql-schema';
import {
  ACCOUNTING_REGISTRY_TABLES,
  FORBIDDEN_P2_S3_SURFACES,
  INTENDED_TABLE_GRANTS,
  JOURNAL_TABLES,
  WRITE_PRIVILEGES,
} from './guards/journal-privilege-model';

const ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(ROOT, 'infrastructure/database/migrations');
const LIST_ONLY = process.argv.slice(2).includes('--list');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * P2-S2's two migrations, with the bytes the Tech Lead accepted at
 * cd41573469563dc334bb5f84a660558cd805950c. Held here as an independent second
 * copy of the manifest's hashes — a single source would let one commit move a
 * migration and its recorded hash together.
 *
 * P2-S2 is now ACCEPTED and FROZEN, so the question this gate answers has
 * changed tense: not "did the slice stay a candidate?" but "is the accepted
 * slice still exactly what was accepted?". It is a PERMANENT regression gate.
 */
const S2_MIGRATIONS = {
  '0042_accounting_journal.sql': '78c852cd1f5888013a02244327a1eb606e3f0fd9582fbbed2018b9382cb92e33',
  '0043_accounting_invariants.sql': '9744da043d3c8b3fe68af30b135e5f5f36207ec5b457d115a3f5a465d268e70f',
} as const;
const S2_MIGRATION_NAMES = Object.keys(S2_MIGRATIONS) as (keyof typeof S2_MIGRATIONS)[];

/** P2-S2 is frozen through its last migration. */
const FROZEN_THROUGH = '0043_accounting_invariants.sql';

/** Immutability is per table, unconditional, and has no privileged exemption (§27). */
const IMMUTABLE_TABLES = ['journal_entries', 'journal_lines', 'accounting_source_bindings'] as const;

/** The two commit-time validators. §28 requires BOTH; line-only is not acceptable. */
const DEFERRED_TRIGGERS = [
  { name: 'journal_entry_validate', table: 'journal_entries' },
  { name: 'journal_line_validate', table: 'journal_lines' },
] as const;

/** AL-01's binding integrity is bidirectional, and both directions are deferrable (§19). */
const DEFERRED_FKS = ['accounting_source_bindings_entry_fk', 'journal_entries_binding_fk'] as const;

/** Floating point has no authority over money, anywhere in the schema (§22/§23). */
const FLOAT_TYPES = /\b(REAL|FLOAT4|FLOAT8|DOUBLE\s+PRECISION|MONEY)\b/i;

const P2_S2_TESTS = [
  'tests/integration/accounting-journal.test.ts',
  'tests/security/journal-privilege-matrix.test.ts',
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

// ── 1. Migration boundary ───────────────────────────────────────────────────
//
// P2-S2 is ACCEPTED and FROZEN. The two consequences are the whole point of
// the transition, and they are exactly the P2-S1 gate's after acceptance:
//
//  - 0042 and 0043 MUST now be frozen, at the accepted hashes. The gate carries
//    its own copy of those hashes, so editing a migration and the manifest in
//    the same commit still fails here.
//  - The gate MUST NOT block a later authorized migration. 0044, 0045 and their
//    successors are legitimate (P2-S3 and beyond); this permanent gate has no
//    opinion about whether they exist. The candidate-era "no 0044" and "not yet
//    frozen" rules are gone: a historical accepted gate that forbade its
//    successors would be a gate that blocks the next slice.
function checkMigrationBoundary(): void {
  console.log('P2-S2 GATE — migration boundary');
  const files = sqlFiles();

  // The accepted bytes, checked against disk directly — the manifest is checked
  // separately below, and the two must agree with the same third value for
  // either to mean anything.
  for (const name of S2_MIGRATION_NAMES) {
    if (!files.includes(name)) {
      fail('accepted-bytes', `${name} is missing — P2-S2 is accepted history and its files may not be removed`);
      continue;
    }
    const sha = createHash('sha256')
      .update(readFileSync(join(MIGRATIONS_DIR, name)))
      .digest('hex');
    if (sha !== S2_MIGRATIONS[name]) {
      fail(
        'accepted-bytes',
        `${name} no longer matches the accepted P2-S2 bytes (expected ${S2_MIGRATIONS[name]}, got ${sha}) — a defect in frozen history needs a NEW migration`,
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
      fail('frozen-history', `frozen migration deleted: ${entry.name} — 0000–0043 is release history`);
      drifted += 1;
      continue;
    }
    const sha = createHash('sha256')
      .update(readFileSync(join(MIGRATIONS_DIR, entry.name)))
      .digest('hex');
    if (sha !== entry.sha256) {
      fail('frozen-history', `frozen migration modified: ${entry.name} — a defect in frozen history needs a NEW migration`);
      drifted += 1;
    }
  }
  if (drifted === 0) ok(`${manifest.migrations.length} frozen migrations byte-for-byte unchanged`);

  // P2-S2 is ACCEPTED, so the manifest must carry the accepted hashes, not
  // merely some hash of the current file.
  const frozen = new Map(manifest.migrations.map((m) => [m.name, m.sha256]));
  for (const name of S2_MIGRATION_NAMES) {
    const recorded = frozen.get(name);
    if (recorded === undefined) {
      fail('frozen-p2s2', `${name} is not in MIGRATION_MANIFEST.json — accepted P2-S2 migrations are frozen history (§5)`);
    } else if (recorded !== S2_MIGRATIONS[name]) {
      fail('frozen-p2s2', `${name} is frozen at ${recorded}, but the accepted hash is ${S2_MIGRATIONS[name]}`);
    } else {
      ok(`${name} frozen at its accepted hash`);
    }
  }
  if (manifest.frozenThrough < FROZEN_THROUGH) {
    fail('frozen-p2s2', `frozenThrough is ${manifest.frozenThrough} — it must include P2-S2 (${FROZEN_THROUGH} or later)`);
  } else {
    ok(`frozenThrough = ${manifest.frozenThrough} — P2-S2 is release history`);
  }

  // Deliberately NOT checked: whether 0044+ exists. This gate is permanent and
  // must never be the reason an authorized later slice cannot land (§6).
  const later = files.filter((f) => f.slice(0, 4) > '0043');
  ok(
    later.length === 0
      ? 'no migration after 0043 yet (not a requirement of this gate)'
      : `${later.length} later migration(s) present — out of scope for the P2-S2 gate`,
  );
}

// ── 2. Slice boundary: P2-S2's own migrations shipped no writer ─────────────
//
// Scoped to 0042/0043. Before acceptance this scanned the whole tree and all of
// apps/ and packages/, because the whole repository was the slice under review.
// Now that P2-S2 is frozen the honest claim is narrower and permanent: the
// accepted journal slice created no posting primitive and no assertion surface.
// Whether 0044/0045 add them is P2-S3's gate to judge, not this one's (§6) — a
// permanent gate that forbade its successors' surfaces would block the next
// slice, which §6 explicitly prohibits.
function checkSliceBoundary(): void {
  console.log('P2-S2 GATE — slice boundary (P2-S2 shipped no writer)');
  const sliceSchema = stripComments(
    S2_MIGRATION_NAMES.filter((f) => sqlFiles().includes(f))
      .map(readMigration)
      .join('\n'),
  );
  let leaked = 0;
  for (const surface of FORBIDDEN_P2_S3_SURFACES) {
    const re = new RegExp(`CREATE\\s+(?:TABLE|VIEW|OR\\s+REPLACE\\s+FUNCTION|FUNCTION|PROCEDURE)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${surface}\\b`, 'i');
    if (re.test(sliceSchema)) {
      fail('slice-boundary', `${surface} is created by a P2-S2 migration — the accepted journal slice contained no writer or assertion surface`);
      leaked += 1;
    }
  }
  if (leaked === 0) ok(`the accepted P2-S2 migrations create no posting or assertion surface: ${FORBIDDEN_P2_S3_SURFACES.join(', ')}`);

  // session_replication_role would silently disable every trigger this slice
  // installed, immutability and validation alike. It has no legitimate use in
  // 0042/0043 and never did.
  if (/session_replication_role/i.test(sliceSchema))
    fail('slice-boundary', 'session_replication_role appears in a P2-S2 migration — it would disable the immutability and validation triggers');
  else ok('no session_replication_role escape hatch in the accepted P2-S2 migrations');
}

// ── 3. Structural enforcement really is in the database ─────────────────────
function checkStructuralEnforcement(): void {
  console.log('P2-S2 GATE — structural enforcement');
  if (!S2_MIGRATION_NAMES.every((m) => sqlFiles().includes(m))) {
    fail('structure', 'P2-S2 migrations are missing — cannot verify structural enforcement');
    return;
  }
  const journal = stripComments(readMigration('0042_accounting_journal.sql'));
  const invariants = stripComments(readMigration('0043_accounting_invariants.sql'));

  // Immutability: BEFORE UPDATE OR DELETE, per table, unconditional.
  for (const table of IMMUTABLE_TABLES) {
    const re = new RegExp(`CREATE\\s+TRIGGER\\s+\\w+\\s+BEFORE\\s+UPDATE\\s+OR\\s+DELETE\\s+ON\\s+${table}\\b`, 'i');
    if (re.test(journal)) ok(`${table} is immutable by trigger (BEFORE UPDATE OR DELETE)`);
    else fail('immutability', `${table} has no BEFORE UPDATE OR DELETE immutability trigger (§20, §27)`);
  }
  // §27: no privileged exemption. The immutability functions must not consult
  // current_user at all — the owner, the platform role and support are all
  // refused equally.
  const immutableFns = invariantsOfImmutability(journal);
  if (/current_user|session_user|current_setting\(/i.test(immutableFns)) {
    fail('immutability', 'an immutability trigger function inspects the current identity — §27 forbids any admin, platform or support bypass');
  } else {
    ok('immutability triggers are unconditional: no identity check, so no bypass for owner, platform or support');
  }

  // §28: BOTH deferred validators.
  for (const { name, table } of DEFERRED_TRIGGERS) {
    const re = new RegExp(`CREATE\\s+CONSTRAINT\\s+TRIGGER\\s+${name}[\\s\\S]{0,400}?ON\\s+${table}[\\s\\S]{0,200}?DEFERRABLE\\s+INITIALLY\\s+DEFERRED`, 'i');
    if (re.test(invariants)) ok(`${name} on ${table} is a DEFERRABLE INITIALLY DEFERRED constraint trigger`);
    else fail('deferred-validation', `${name} on ${table} is missing or not deferred — §28 requires BOTH sides; line-only is not acceptable`);
  }

  // §19: the binding relationship is bidirectional and both FKs are deferred.
  for (const fk of DEFERRED_FKS) {
    const re = new RegExp(`CONSTRAINT\\s+${fk}\\s+FOREIGN\\s+KEY[\\s\\S]{0,300}?DEFERRABLE\\s+INITIALLY\\s+DEFERRED`, 'i');
    if (re.test(journal)) ok(`${fk} is DEFERRABLE INITIALLY DEFERRED`);
    else fail('binding-integrity', `${fk} is missing or not deferrable — AL-01 needs both directions, each deferred (§19)`);
  }

  // §22/§23: money and rates are exact types, never floating point.
  for (const name of S2_MIGRATION_NAMES) {
    const sql = stripComments(readMigration(name));
    if (FLOAT_TYPES.test(sql))
      fail('exact-money', `${name} declares a floating-point or MONEY type — money is BIGINT minor units and rates are NUMERIC(20,10)`);
  }
  // Composite identity. An entry is `(business_id, id)`; `journal_entries` has
  // no global UNIQUE on `id`, so a validator that reads lines by
  // `journal_entry_id` alone can pull another business's independent entry
  // into this one's validation. The behavioural proof is in
  // tests/integration/accounting-journal.test.ts; this is the fast tripwire,
  // so a reintroduction fails before a database is even started.
  if (/journal_entry_id\s*=\s*p_entry_id/i.test(invariants)) {
    fail(
      'composite-identity',
      '0043 addresses journal lines by entry id alone — an entry is (business_id, id), and the UUID alone may belong to another business',
    );
  } else {
    ok('the validator addresses journal lines by the composite (business_id, id), never by the UUID alone');
  }

  if (!/ROUND\s*\(/i.test(invariants)) ok('0043 computes the base-amount expectation without PostgreSQL ROUND() — HALF_EVEN is spelled out (§24)');
  else fail('exact-money', '0043 uses ROUND() — §24 forbids the shortcut; HALF_EVEN must be derived from quotient and remainder');
  if (/SUM\s*\(\s*(?!.*::\s*numeric)[^)]*amount_minor[^)]*\)/i.test(invariants)) {
    fail('exact-money', '0043 sums a minor-unit column without casting to NUMERIC — a BIGINT sum can overflow before the balance check runs (§22)');
  } else {
    ok('every minor-unit sum in 0043 is cast to NUMERIC before adding (§22)');
  }
}

/** The text of 0042's immutability trigger functions, isolated from the rest. */
function invariantsOfImmutability(journal: string): string {
  const out: string[] = [];
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(\w*immutable\w*)\s*\([\s\S]*?\$\$([\s\S]*?)\$\$/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(journal)) !== null) out.push(m[2] ?? '');
  return out.join('\n');
}

// ── 4. Guards G-1, G-2, G-3 and authority isolation ─────────────────────────
function checkGuards(): void {
  console.log('P2-S2 GATE — guards');

  // G-1 exists as DATA and states a no-writer model. §34: the model, not six
  // hand-written negative tests, is what discovers a future accidental GRANT.
  const modelPath = join(ROOT, 'scripts/guards/journal-privilege-model.ts');
  if (!existsSync(modelPath)) {
    fail('guard-g1', 'scripts/guards/journal-privilege-model.ts is missing — G-1 is required (§34)');
  } else {
    let writers = 0;
    for (const [table, grants] of Object.entries(INTENDED_TABLE_GRANTS)) {
      for (const [grantee, privileges] of Object.entries(grants)) {
        for (const privilege of privileges) {
          if ((WRITE_PRIVILEGES as readonly string[]).includes(privilege)) {
            fail('guard-g1', `the intended grant model gives ${grantee} ${privilege} on ${table} — P2-S2 has NO writer (§32, §40)`);
            writers += 1;
          }
        }
      }
    }
    for (const registry of ACCOUNTING_REGISTRY_TABLES) {
      if (Object.keys(INTENDED_TABLE_GRANTS[registry] ?? {}).length > 0)
        fail('guard-g1', `${registry} is granted to someone — the closed registries are default deny (§33)`);
    }
    for (const table of JOURNAL_TABLES) {
      if (INTENDED_TABLE_GRANTS[table] === undefined) fail('guard-g1', `${table} is absent from the intended grant model — G-1 would not watch it`);
    }
    if (writers === 0) ok(`G-1 model covers ${JOURNAL_TABLES.length + ACCOUNTING_REGISTRY_TABLES.length} tables and grants no write privilege to anyone`);
  }
  const matrixSuite = join(ROOT, 'tests/security/journal-privilege-matrix.test.ts');
  if (!existsSync(matrixSuite))
    fail('guard-g1', 'tests/security/journal-privilege-matrix.test.ts is missing — the live catalogue is never compared to the model');
  else if (!/compareTableGrants/.test(readFileSync(matrixSuite, 'utf8')))
    fail('guard-g1', 'the Matrix 1 suite does not compare the live grant catalogue against the intended model (§34)');
  else ok('G-1 is compared against the live PostgreSQL grant catalogue in tests/security/journal-privilege-matrix.test.ts');

  // G-2: no floating-point rate column anywhere, and the rule is wired in.
  const guards = readFileSync(join(ROOT, 'scripts/static-guards.ts'), 'utf8');
  if (!/findFloatRateColumns/.test(guards)) {
    fail('guard-g2', 'static-guards.ts does not run the G-2 no-float-rate rule (§35)');
  } else {
    const offenders = sqlFiles().flatMap((f) =>
      findFloatRateColumns(readMigration(f)).map((h) => `${relative(ROOT, join(MIGRATIONS_DIR, f))}: ${h.table}.${h.column} is ${h.detail}`),
    );
    if (offenders.length > 0) for (const o of offenders) fail('guard-g2', o);
    else ok('G-2 wired into static-guards.ts and clean: no rate column is REAL, DOUBLE PRECISION or under-scaled NUMERIC');
  }

  // G-3 now covers the journal too: a stored balance on an entry or a line
  // would be the second truth AL-15 refuses.
  const g3 = sqlFiles().flatMap((f) =>
    findAuthoritativeBalanceColumns(readMigration(f)).map((h) => `${relative(ROOT, join(MIGRATIONS_DIR, f))}: ${h.table}.${h.column}`),
  );
  if (g3.length > 0) for (const o of g3) fail('guard-g3', o);
  else ok('G-3 clean: no authoritative balance column on accounts, entries, lines or bindings');

  // Authority isolation, extended in P2-S2: the journal has no writer at all.
  const violations = findAuthorityViolations({
    schema: wholeTree(),
    chartSql: readMigration('0040_accounting_chart.sql'),
    bootstrap: readFileSync(join(ROOT, 'infrastructure/database/bootstrap.sql'), 'utf8'),
  });
  if (violations.length > 0) for (const detail of violations) fail('authority-isolation', detail);
  else ok(`no principal holds INSERT, UPDATE, DELETE or TRUNCATE on ${JOURNAL_TABLES.join(', ')} — the journal has no writer until P2-S3`);
}

// ── 5. Composed command matrix ──────────────────────────────────────────────
interface Step {
  readonly name: string;
  readonly cmd: string;
  readonly args: readonly string[];
}

const STEPS: readonly Step[] = [
  // P2-S1 is a PERMANENT predecessor (§42). If the accepted chart slice has
  // regressed, nothing P2-S2 proves about itself matters.
  { name: 'P2-S1 gate (permanent predecessor)', cmd: npm, args: ['run', 'gate:phase2:s1'] },
  { name: 'P2-S2 invariant and privilege matrices', cmd: 'npx', args: ['vitest', 'run', ...P2_S2_TESTS] },
];

function runSteps(): void {
  console.log('P2-S2 GATE — composed regression matrix');
  for (const step of STEPS) {
    const started = Date.now();
    const res = spawnSync(step.cmd, [...step.args], { cwd: ROOT, encoding: 'utf8', stdio: 'inherit', env: process.env });
    const ms = Date.now() - started;
    if (res.status !== 0) fail('regression', `${step.name} failed (exit ${res.status ?? 'signal'}) after ${ms}ms`);
    else ok(`${step.name} (${ms}ms)`);
  }
}

if (LIST_ONLY) {
  console.log('P2-S2 GATE plan:');
  console.log('  structural: migration boundary (0042/0043 frozen at accepted hashes; later migrations allowed)');
  console.log('  structural: slice boundary (the accepted 0042/0043 shipped no writer or assertion surface)');
  console.log('  structural: immutability triggers, both deferred validators, bidirectional deferred bindings, exact money');
  console.log('  structural: guards G-1 (model), G-2, G-3, authority isolation');
  for (const s of STEPS) console.log(`  command:    ${s.cmd} ${s.args.join(' ')}`);
  process.exit(0);
}

checkMigrationBoundary();
checkSliceBoundary();
checkStructuralEnforcement();
checkGuards();
if (failures > 0) {
  console.error(`\nP2-S2 GATE: FAIL (${failures} structural violation${failures === 1 ? '' : 's'}) — not running the regression matrix`);
  process.exit(1);
}
runSteps();

if (failures > 0) {
  console.error(`\nP2-S2 GATE: FAIL (${failures})`);
  process.exit(1);
}
console.log('\nP2-S2 GATE: PASS');
