#!/usr/bin/env tsx
/**
 * PHASE 2 SLICE GATE — P2-S3, the secure posting engine (directive §74).
 *
 * `npm run gate:phase2:s3` is the deterministic answer to "is the posting
 * slice actually done, and did it stay inside its boundary?". P2-S1 gave the
 * chart, P2-S2 gave the journal its structure and gave nobody the ability to
 * write to it; P2-S3 ships the ONE writer and everything that has to be true
 * before a writer is safe.
 *
 * It COMPOSES rather than duplicates. Phase 1, P2-S1 and P2-S2 are permanent
 * predecessors: their gates run unchanged, so nothing this slice adds can be
 * paid for with a regression in what came before. The guards live in
 * scripts/guards/ and are regression-tested on their own; here they are
 * invoked, not re-implemented. The matrices are vitest suites; the gate runs
 * them, it does not restate their assertions.
 *
 * Structural checks run first because they are instant and because there is no
 * point running a test matrix against a tree that already broke the migration
 * boundary.
 *
 * Usage: npm run gate:phase2:s3 [-- --list]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { findAuthorityViolations } from './guards/authority-isolation';
import { findPostingSurfaceViolations, POSTING_CALLER, POSTING_PRIMITIVE, postingPrimitiveGrantees } from './guards/posting-surface';
import { stripComments } from './guards/sql-schema';
import { INTENDED_TABLE_GRANTS, INTERNAL_ROLE, REQUIRED_P2_S3_SURFACES, RUNTIME_ROLES, WRITE_PRIVILEGES } from './guards/journal-privilege-model';

const ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(ROOT, 'infrastructure/database/migrations');
const LIST_ONLY = process.argv.slice(2).includes('--list');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** P2-S3's two migrations. CANDIDATES: they must exist and must NOT be frozen. */
const S3_MIGRATIONS = ['0044_accounting_assertion_keys.sql', '0045_accounting_post_entry.sql'] as const;

/** The last migration P2-S2 froze. Everything at or below it is release history. */
const FROZEN_THROUGH = '0043_accounting_invariants.sql';

/** The first migration number P2-S4 owns. Its existence here means scope creep. */
const NEXT_SLICE_MIGRATION = '0046';

/** The workspace this slice adds, and the modules it must contain. */
const ACCOUNTING_PACKAGE = 'packages/accounting';
const ACCOUNTING_MODULES = ['src/fingerprint.ts', 'src/assertion.ts', 'src/fx.ts', 'src/post.ts', 'src/ports.ts', 'src/types.ts', 'src/errors.ts'] as const;

/** The assertion key domain 0044 must create. */
const ASSERTION_OBJECTS = [
  'accounting_assertion_keys',
  'accounting_assertion_uses',
  'accounting_assertion_key_install',
  'accounting_assertion_key_retire',
] as const;

/** The suites that prove, against a real database, what the structure only claims. */
const P2_S3_TESTS = [
  'tests/integration/accounting-posting.test.ts',
  'tests/integration/accounting-concurrency.test.ts',
  'tests/integration/accounting-engine.test.ts',
  'tests/integration/accounting-fingerprint-parity.test.ts',
  'tests/integration/posting-surface-guard.test.ts',
  'tests/security/accounting-posting-authority.test.ts',
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
// P2-S3's two migrations must EXIST and must NOT be frozen. A slice that froze
// itself would have decided its own acceptance, which is the Tech Lead's call
// and nobody else's; a slice missing its migrations has not shipped. And 0046
// must not exist, because it belongs to P2-S4.
function checkMigrationBoundary(): void {
  console.log('P2-S3 GATE — migration boundary');
  const files = sqlFiles();

  for (const name of S3_MIGRATIONS) {
    if (files.includes(name)) ok(`${name} present`);
    else fail('s3-migrations', `${name} is missing — P2-S3 ships exactly these two migrations`);
  }

  const later = files.filter((f) => f.slice(0, 4) >= NEXT_SLICE_MIGRATION);
  if (later.length > 0) fail('scope', `migration(s) ${later.join(', ')} exist — ${NEXT_SLICE_MIGRATION}+ is P2-S4 and is out of scope (§85)`);
  else ok(`no migration at or after ${NEXT_SLICE_MIGRATION} — P2-S4 has not been started`);

  const manifest = JSON.parse(readFileSync(join(ROOT, 'infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8')) as {
    frozenThrough: string;
    migrations: { name: string; sha256: string }[];
  };

  // 0000–0043 is release history and must be byte-identical.
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
      fail('frozen-history', `frozen migration modified: ${entry.name} — a defect in frozen history needs a NEW migration, never an edit`);
      drifted += 1;
    }
  }
  if (drifted === 0) ok(`${manifest.migrations.length} frozen migrations byte-for-byte unchanged`);

  // The candidate rule, in both directions.
  const frozen = new Set(manifest.migrations.map((m) => m.name));
  for (const name of S3_MIGRATIONS) {
    if (frozen.has(name)) fail('premature-freeze', `${name} is already in MIGRATION_MANIFEST.json — a slice does not freeze itself (§85)`);
  }
  if (manifest.frozenThrough !== FROZEN_THROUGH) {
    fail('premature-freeze', `frozenThrough is ${manifest.frozenThrough} — P2-S3 is a candidate, so it must still be ${FROZEN_THROUGH}`);
  } else {
    ok(`0044/0045 are CANDIDATES: frozenThrough is still ${FROZEN_THROUGH}`);
  }
}

// ── 2. The slice's surfaces exist ──────────────────────────────────────────
//
// P2-S2's gate asserts these surfaces are absent from 0042/0043. This one
// asserts they are PRESENT in the tree: the two statements are about different
// files and both must hold, which is exactly why neither replaces the other.
function checkSurfacesExist(): void {
  console.log('P2-S3 GATE — the posting surfaces this slice owes');
  const schema = stripComments(wholeTree());
  for (const surface of REQUIRED_P2_S3_SURFACES) {
    const re = new RegExp(`CREATE\\s+(?:TABLE|VIEW|TYPE|OR\\s+REPLACE\\s+FUNCTION|FUNCTION|PROCEDURE)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${surface}\\b`, 'i');
    if (re.test(schema)) ok(`${surface} exists`);
    else fail('missing-surface', `${surface} does not exist — P2-S3 is the slice that creates it`);
  }
  for (const object of ASSERTION_OBJECTS) {
    const re = new RegExp(`CREATE\\s+(?:TABLE|OR\\s+REPLACE\\s+FUNCTION|FUNCTION)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${object}\\b`, 'i');
    if (!re.test(schema)) fail('assertion-domain', `the accounting assertion key domain is incomplete: ${object} is missing (§15, §58)`);
  }
  if (
    ASSERTION_OBJECTS.every((o) =>
      new RegExp(`CREATE\\s+(?:TABLE|OR\\s+REPLACE\\s+FUNCTION|FUNCTION)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${o}\\b`, 'i').test(schema),
    )
  )
    ok(`the assertion key domain is complete: ${ASSERTION_OBJECTS.join(', ')}`);

  // The DB recomputes the fingerprint from the row it is about to write; it
  // never trusts the caller's value. Without this the signature authorizes a
  // number rather than a payload.
  const posting = sqlFiles().includes('0045_accounting_post_entry.sql') ? stripComments(readMigration('0045_accounting_post_entry.sql')) : '';
  if (/v_actualfp\s*:?=\s*accounting_fingerprint\(/i.test(posting) && /v_actualfp\s*<>\s*v_actor\.posting_fingerprint/i.test(posting)) {
    ok('the primitive recomputes the fingerprint from the payload and compares it to the signed one (§27)');
  } else {
    fail(
      'payload-recomputation',
      '0045 does not recompute the fingerprint and compare it against the assertion — the signature would authorize a number, not a payload (§27)',
    );
  }

  // The first-activity stamp is the primitive's business, under the same lock.
  if (/UPDATE\s+businesses\s+SET\s+financial_started_at/i.test(posting) && /financial_started_at\s+IS\s+NULL/i.test(posting)) {
    ok('financial_started_at is established by the primitive, once, under the business row lock (§38)');
  } else {
    fail('financial-start', '0045 does not establish financial_started_at on the first posting (§38)');
  }
}

// ── 3. Guard G-4, plus the grant model from both sides ─────────────────────
function checkGuards(): void {
  console.log('P2-S3 GATE — guards');

  const guardPath = join(ROOT, 'scripts/guards/posting-surface.ts');
  if (!existsSync(guardPath)) {
    fail('guard-g4', 'scripts/guards/posting-surface.ts is missing — G-4 is required (§69)');
  } else if (!/findPostingSurfaceViolations/.test(readFileSync(join(ROOT, 'scripts/static-guards.ts'), 'utf8'))) {
    fail('guard-g4', 'static-guards.ts does not run G-4 — a guard that runs nowhere guards nothing');
  } else {
    const appFiles = collectAppFiles();
    const violations = findPostingSurfaceViolations({ schema: wholeTree(), appFiles });
    if (violations.length > 0) for (const detail of violations) fail('guard-g4', detail);
    else
      ok(`G-4 clean: ${POSTING_PRIMITIVE} carries every protection, is granted only to ${POSTING_CALLER}, and no application code writes the ledger directly`);
  }

  // The EXECUTE surface, read straight out of the migrations. G-4 says the
  // same thing; this repeats it here because it is the single most damaging
  // thing that could silently change, and a gate that asks twice costs
  // milliseconds.
  const grantees = postingPrimitiveGrantees(wholeTree());
  if (grantees.length !== 1 || grantees[0] !== POSTING_CALLER) {
    fail('posting-grants', `${POSTING_PRIMITIVE} is granted EXECUTE to [${grantees.join(', ') || 'nobody'}] — it must be exactly ${POSTING_CALLER}`);
  } else {
    ok(`${POSTING_PRIMITIVE} is executable by exactly one runtime role: ${POSTING_CALLER}`);
  }

  // No runtime credential holds journal DML, in the model or in the tree.
  const runtime = new Set<string>(RUNTIME_ROLES);
  let modelWriters = 0;
  for (const [table, grants] of Object.entries(INTENDED_TABLE_GRANTS)) {
    for (const [grantee, privileges] of Object.entries(grants)) {
      for (const privilege of privileges) {
        if (runtime.has(grantee) && (WRITE_PRIVILEGES as readonly string[]).includes(privilege)) {
          fail(
            'runtime-dml',
            `the intended grant model gives the runtime role ${grantee} ${privilege} on ${table} — the only writer is the posting primitive (AL-03/AL-18)`,
          );
          modelWriters += 1;
        }
      }
    }
  }
  if (modelWriters === 0) ok(`no runtime credential holds journal DML; the writer reaches the ledger only as ${INTERNAL_ROLE}`);

  const authority = findAuthorityViolations({
    schema: wholeTree(),
    chartSql: readMigration('0040_accounting_chart.sql'),
    bootstrap: readFileSync(join(ROOT, 'infrastructure/database/bootstrap.sql'), 'utf8'),
  });
  if (authority.length > 0) for (const detail of authority) fail('authority-isolation', detail);
  else ok('authority isolation clean: no LOGIN principal can reach ledger truth except through the primitive');
}

/** Every non-test application and script source file, path → contents. */
function collectAppFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  const skip = new Set(['node_modules', 'dist', '.next', 'build', '.git', 'coverage']);
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) out[relative(ROOT, full)] = readFileSync(full, 'utf8');
    }
  };
  for (const dir of ['apps/api/src', 'packages/accounting/src', 'scripts']) {
    const full = join(ROOT, dir);
    if (existsSync(full)) walk(full);
  }
  return out;
}

// ── 4. The @daftar/accounting workspace ────────────────────────────────────
function checkAccountingPackage(): void {
  console.log('P2-S3 GATE — @daftar/accounting');
  const pkgDir = join(ROOT, ACCOUNTING_PACKAGE);
  if (!existsSync(join(pkgDir, 'package.json'))) {
    fail('accounting-package', `${ACCOUNTING_PACKAGE} is missing — the engine is a real workspace, not code pasted into the API`);
    return;
  }
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { workspaces: string[] };
  if (!root.workspaces.includes(ACCOUNTING_PACKAGE)) fail('accounting-package', `${ACCOUNTING_PACKAGE} is not in the root workspaces array`);
  else ok(`${ACCOUNTING_PACKAGE} is a declared workspace`);

  for (const module of ACCOUNTING_MODULES) {
    if (existsSync(join(pkgDir, module))) ok(`${ACCOUNTING_PACKAGE}/${module}`);
    else fail('accounting-package', `${ACCOUNTING_PACKAGE}/${module} is missing`);
  }

  // The shared vectors are the single source both implementations are tested
  // against. Without them the SQL canonicalizer and the TypeScript one can
  // drift apart while each stays internally consistent — and a fingerprint two
  // implementations disagree about authorizes nothing.
  const vectors = join(pkgDir, 'vectors/acctfp-vectors.json');
  if (!existsSync(vectors)) {
    fail('fingerprint-vectors', 'packages/accounting/vectors/acctfp-vectors.json is missing — SQL and TypeScript would have no shared source of truth (§21)');
  } else {
    const parsed = JSON.parse(readFileSync(vectors, 'utf8')) as { cases?: unknown[] };
    const n = parsed.cases?.length ?? 0;
    if (n === 0) fail('fingerprint-vectors', 'the canonical fingerprint vector file contains no cases');
    else ok(`${n} shared acctfp/1 vectors`);
    const parity = join(ROOT, 'tests/integration/accounting-fingerprint-parity.test.ts');
    if (!existsSync(parity))
      fail('fingerprint-vectors', 'tests/integration/accounting-fingerprint-parity.test.ts is missing — nothing compares SQL against TypeScript (§21)');
    else ok('the SQL and TypeScript canonicalizers are compared against the same vectors');
  }
}

// ── 5. Key separation ───────────────────────────────────────────────────────
//
// The accounting assertion key is not the provisioning key. Reusing one secret
// for two authorities means a leak in either one forges both, and it means a
// provisioning assertion can be replayed as financial authority.
function checkKeySeparation(): void {
  console.log('P2-S3 GATE — key separation');
  const configPath = join(ROOT, 'apps/api/src/config.ts');
  if (!existsSync(configPath)) {
    fail('key-separation', 'apps/api/src/config.ts is missing');
    return;
  }
  const config = readFileSync(configPath, 'utf8');
  if (!/ACCOUNTING_ASSERTION_KEY/.test(config) || !/ACCOUNTING_ASSERTION_KID/.test(config)) {
    fail('key-separation', 'the API config declares no ACCOUNTING_ASSERTION_KEY/KID — the posting authority would have no key of its own');
  } else {
    ok('ACCOUNTING_ASSERTION_KEY and ACCOUNTING_ASSERTION_KID are configured separately from provisioning');
  }
  if (/PROVISIONING_ASSERTION_KEY/.test(config) && /equals\(|timingSafeEqual|compare\(/.test(config)) {
    ok('the configuration refuses to start when the accounting key equals the provisioning key');
  } else {
    fail('key-separation', 'nothing refuses an accounting key byte-equal to the provisioning key — one leaked secret would forge both authorities (§16)');
  }
}

// ── 6. Composed command matrix ──────────────────────────────────────────────
interface Step {
  readonly name: string;
  readonly cmd: string;
  readonly args: readonly string[];
}

const STEPS: readonly Step[] = [
  // Every predecessor is PERMANENT. If Phase 1, the chart slice or the journal
  // slice has regressed, nothing P2-S3 proves about itself matters. The P2-S2
  // gate composes the P2-S1 gate, which composes Phase 1's, so running it once
  // runs the whole chain.
  { name: 'P2-S2 gate (permanent predecessor, composes P2-S1 and Phase 1)', cmd: npm, args: ['run', 'gate:phase2:s2'] },
  { name: 'static guards (G-2, G-3, G-4 and the rest)', cmd: npm, args: ['run', 'check:guards'] },
  { name: '@daftar/accounting unit suite', cmd: npm, args: ['run', 'test', '-w', '@daftar/accounting'] },
  { name: 'P2-S3 posting, concurrency, parity and authority matrices', cmd: 'npx', args: ['vitest', 'run', ...P2_S3_TESTS] },
  { name: 'engine-shape goldens', cmd: npm, args: ['run', 'test:golden'] },
];

function runSteps(): void {
  console.log('P2-S3 GATE — composed regression matrix');
  for (const step of STEPS) {
    const started = Date.now();
    const res = spawnSync(step.cmd, [...step.args], { cwd: ROOT, encoding: 'utf8', stdio: 'inherit', env: process.env });
    const ms = Date.now() - started;
    if (res.status !== 0) fail('regression', `${step.name} failed (exit ${res.status ?? 'signal'}) after ${ms}ms`);
    else ok(`${step.name} (${ms}ms)`);
  }
}

if (LIST_ONLY) {
  console.log('P2-S3 GATE plan:');
  console.log('  structural: migration boundary (0044/0045 present and NOT frozen, 0000–0043 unchanged, no 0046)');
  console.log('  structural: the posting and assertion surfaces exist, the DB recomputes the fingerprint, financial_started_at is wired');
  console.log('  structural: guard G-4, the posting EXECUTE surface, the runtime-DML model, authority isolation');
  console.log('  structural: the @daftar/accounting workspace, its modules and the shared acctfp/1 vectors');
  console.log('  structural: accounting and provisioning assertion keys are separate secrets');
  for (const s of STEPS) console.log(`  command:    ${s.cmd} ${s.args.join(' ')}`);
  process.exit(0);
}

checkMigrationBoundary();
checkSurfacesExist();
checkGuards();
checkAccountingPackage();
checkKeySeparation();
if (failures > 0) {
  console.error(`\nP2-S3 GATE: FAIL (${failures} structural violation${failures === 1 ? '' : 's'}) — not running the regression matrix`);
  process.exit(1);
}
runSteps();

if (failures > 0) {
  console.error(`\nP2-S3 GATE: FAIL (${failures})`);
  process.exit(1);
}
console.log('\nP2-S3 GATE: PASS');
