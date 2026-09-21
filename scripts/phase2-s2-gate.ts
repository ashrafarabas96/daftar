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

/** P2-S2's two migrations. Exactly these, and nothing after them (§11). */
const S2_MIGRATIONS = ['0042_accounting_journal.sql', '0043_accounting_invariants.sql'] as const;

/** The last frozen migration. P2-S2 appends after it and freezes nothing. */
const FROZEN_THROUGH = '0041_accounting_permissions.sql';

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
/** The whole tree with comments removed — for rules about what the SQL DOES. */
const wholeTreeCode = (): string => stripComments(wholeTree());

// ── 1. Migration boundary ───────────────────────────────────────────────────
//
// P2-S2 is exactly 0042 and 0043. Both are CANDIDATES: freezing them before
// the Tech Lead has accepted them would make a correction impossible without
// rewriting release history, which is precisely the trap the freeze protocol
// exists to avoid.
function checkMigrationBoundary(): void {
  console.log('P2-S2 GATE — migration boundary');
  const files = sqlFiles();

  for (const name of S2_MIGRATIONS) {
    if (files.includes(name)) ok(`${name} present`);
    else fail('slice-migrations', `${name} is missing — P2-S2 is defined as exactly ${S2_MIGRATIONS.join(' + ')}`);
  }

  const later = files.filter((f) => f.slice(0, 4) > '0043');
  if (later.length > 0) fail('no-0044', `migration(s) beyond 0043 exist: ${later.join(', ')} — P2-S2 stops at 0043 (§11, §49)`);
  else ok('nothing after 0043 — the slice stops where the directive stops');

  const manifest = JSON.parse(readFileSync(join(ROOT, 'infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8')) as {
    frozenThrough: string;
    migrations: { name: string; sha256: string }[];
  };

  let drifted = 0;
  for (const entry of manifest.migrations) {
    if (!files.includes(entry.name)) {
      fail('frozen-history', `frozen migration deleted: ${entry.name} — 0000–0041 is release history`);
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
  if (drifted === 0) ok(`${manifest.migrations.length} frozen migrations (0000–0041) byte-for-byte unchanged`);

  const frozenNames = new Set(manifest.migrations.map((m) => m.name));
  for (const name of S2_MIGRATIONS) {
    if (frozenNames.has(name)) {
      fail('premature-freeze', `${name} is in MIGRATION_MANIFEST.json — P2-S2 migrations stay CANDIDATES until the Tech Lead accepts them (§45)`);
    } else {
      const sha = files.includes(name)
        ? createHash('sha256')
            .update(readFileSync(join(MIGRATIONS_DIR, name)))
            .digest('hex')
        : 'ABSENT';
      ok(`${name} is a candidate, not frozen (current sha256 ${sha})`);
    }
  }
  if (manifest.frozenThrough !== FROZEN_THROUGH) {
    fail('premature-freeze', `frozenThrough is ${manifest.frozenThrough}, expected ${FROZEN_THROUGH} — P2-S2 freezes nothing`);
  } else {
    ok(`frozenThrough = ${FROZEN_THROUGH} — unchanged by this slice`);
  }
}

// ── 2. Slice boundary: nothing from P2-S3 exists yet ────────────────────────
//
// §40 is unusually blunt about this: if a generic ledger write function is
// introduced, the slice FAILS. The scan covers the migration tree and the
// application source, because a posting primitive written in TypeScript is
// the same breach as one written in PL/pgSQL.
function checkSliceBoundary(): void {
  console.log('P2-S2 GATE — slice boundary (no P2-S3 surface)');
  const schema = wholeTreeCode();
  let leaked = 0;
  for (const surface of FORBIDDEN_P2_S3_SURFACES) {
    const re = new RegExp(`CREATE\\s+(?:TABLE|VIEW|OR\\s+REPLACE\\s+FUNCTION|FUNCTION|PROCEDURE)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${surface}\\b`, 'i');
    if (re.test(schema)) {
      fail('slice-boundary', `${surface} is created by a migration — that surface belongs to P2-S3 (§40, §49)`);
      leaked += 1;
    }
  }
  if (leaked === 0) ok(`no P2-S3 surface in the schema: ${FORBIDDEN_P2_S3_SURFACES.join(', ')}`);

  const srcHits = spawnSync(
    'grep',
    ['-rIl', '-E', FORBIDDEN_P2_S3_SURFACES.join('|'), 'apps', 'packages', '--include=*.ts', '--include=*.tsx', '--include=*.sql'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const hits = (srcHits.stdout ?? '').split('\n').filter((l) => l.trim().length > 0);
  if (hits.length > 0) for (const h of hits) fail('slice-boundary', `${h} references a P2-S3 posting surface — P2-S2 has no writer (§40)`);
  else ok('no posting primitive in apps/ or packages/ either — P2-S2 ships structure, not a writer');

  // A replication-role switch would silently disable every trigger in this
  // slice, immutability and validation alike. It has no legitimate use here.
  if (/session_replication_role/i.test(schema))
    fail('slice-boundary', 'session_replication_role appears in the schema — it would disable the immutability and validation triggers');
  else ok('no session_replication_role escape hatch anywhere in the migration tree');
}

// ── 3. Structural enforcement really is in the database ─────────────────────
function checkStructuralEnforcement(): void {
  console.log('P2-S2 GATE — structural enforcement');
  if (!S2_MIGRATIONS.every((m) => sqlFiles().includes(m))) {
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
  for (const name of S2_MIGRATIONS) {
    const sql = stripComments(readMigration(name));
    if (FLOAT_TYPES.test(sql))
      fail('exact-money', `${name} declares a floating-point or MONEY type — money is BIGINT minor units and rates are NUMERIC(20,10)`);
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
  console.log('  structural: migration boundary (0042+0043, no 0044+, frozen 0000–0041, no premature freeze)');
  console.log('  structural: slice boundary (no P2-S3 posting surface, no session_replication_role)');
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
