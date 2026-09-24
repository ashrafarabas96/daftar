#!/usr/bin/env tsx
/**
 * PHASE 2 SLICE GATE — P2-S8, the hardening and reconciliation slice.
 *
 * `npm run gate:phase2:s8` answers one question: does the reconciliation
 * authority verify the books WITHOUT becoming a second way to reach them?
 *
 * Every slice before this one added a way to write or read the ledger under a
 * merchant's own authority. P2-S8 adds the first principal that reads ACROSS
 * businesses, and that is a different kind of risk entirely. The specific ways
 * to get it wrong, each with a section below:
 *
 *   — solving enumeration by widening `app_bypass()` or granting BYPASSRLS,
 *     trading "a list of ids" for "every row of every table" (§4);
 *   — solving it by widening `daftar_worker`, so that a stolen credential-
 *     delivery credential becomes a financial reader (§0, §15);
 *   — a reconciler that can write, or execute a financial command, so that a
 *     verifier becomes a repairer nobody audited (§12, §18);
 *   — blanket `GRANT SELECT ON businesses`, handing a financial verifier the
 *     merchant's contact details for no reason (§13, §35);
 *   — a cycle that reports SUCCESS when it could not look — the difference
 *     between "checked and clean" and "could not inspect" (§16, §17);
 *   — a reconciler process that also holds the SMTP transport, the JWT keys or
 *     the credential key ring (§8, §29);
 *   — OFFSET enumeration, which silently skips a business when one is created
 *     mid-pass (§24);
 *   — a per-business timeout that is answered with a silent skip and a green
 *     cycle (§25);
 *   — a production debug switch, a bypass header or an `if (test)` branch
 *     added to make failure injection possible (f §30);
 *   — a stored balance or a materialized view added to make a budget (f §37).
 *
 * ── The rules this gate carries that no predecessor does ─────────────────
 *
 * 0051 and 0052 are CANDIDATES. Neither is frozen, neither is in the
 * manifest, and there is no 0053 (§2, §44). That prohibition lives HERE, in
 * P2-S8's own gate, because it is P2-S8's rule — the P2-S7 gate deliberately
 * dropped its own copy when it became permanent, since an accepted historical
 * gate that forbids its successor is a gate that stops the project.
 *
 * 0052 also gets a scope check of its own. It was authorized to reshape six
 * named policies and replace three named helpers, and the authorization says
 * in as many words that it extends to no other row-level security. A scope
 * that lives only in a chat message is a scope nobody can re-check, so it is
 * written here as an exact set: the six must all be present, because every
 * partial correction measured SLOWER than no correction at all, and nothing
 * outside the six may appear.
 *
 * It COMPOSES rather than duplicates: P2-S7's gate runs unchanged, and it
 * composes P2-S6 … P2-S1 and Phase 1 in turn.
 *
 * Usage: npm run gate:phase2:s8 [-- --list]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { stripComments } from './guards/sql-schema';
import { canaryRefusal } from './runner-canary';

const ARGV = process.argv.slice(2);
const LIST_ONLY = ARGV.includes('--list');

/**
 * ── Why this gate can be pointed at a directory that is not this repository ─
 *
 * f §24 asks for permanent proof that each structural refusal below can
 * actually fire, and is equally explicit that producing that proof may not
 * modify the repository: a gate proved by breaking the real tree is a gate
 * that was briefly not protecting anything.
 *
 * So `--root` lets `tests/security/phase2-s8-gate-tamper.test.ts` build a
 * hard-linked copy of the tree in a temporary directory, break exactly one
 * thing in it by replacing that one file, and run the structural half of this
 * gate against the copy. The copy is thrown away; the real tree is never
 * written to.
 *
 * Two properties keep this from being a way to weaken the gate:
 *
 *   — it changes WHERE the gate looks, never WHAT it demands. There is no
 *     branch anywhere below that behaves differently because a root was
 *     given, and no check is skipped;
 *   — `--structural-only` stops before the regression matrix, so a run under
 *     `--root` cannot report a verdict about tests it did not execute. The
 *     real invocation — `npm run gate:phase2:s8`, with no arguments — takes
 *     neither flag and is unaffected by either.
 */
const rootFlag = ARGV.indexOf('--root');
const ROOT = rootFlag >= 0 ? resolve(ARGV[rootFlag + 1] ?? '.') : join(__dirname, '..');
const STRUCTURAL_ONLY = ARGV.includes('--structural-only');
const MIGRATIONS_DIR = join(ROOT, 'infrastructure/database/migrations');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * The boundary P2-S7's acceptance left behind, and the boundary P2-S8 must
 * leave UNMOVED. Not a floor, an equality: §44 forbids freezing 0051, so a
 * frozenThrough past 0050 while this gate runs means the hard stop was
 * crossed.
 */
const FROZEN_THROUGH_EXACTLY = '0050_accounting_report_indexes.sql';

/** The reconciliation-authority migration P2-S8 was authorized to create (§2). */
const S8_MIGRATION = '0051_accounting_reconciler_read.sql';

/**
 * The SECOND candidate, authorized separately once the performance evidence
 * was accepted: the `journal_lines` tenant-policy correction.
 *
 * It is deliberately a migration of its own. `0051` has one architectural
 * responsibility — reconciler read authority — and `0052` has one — the RLS
 * performance correction. Folding the second into the first would have made
 * one file that a reviewer has to read twice with two different questions in
 * mind. Both stay CANDIDATES until the Tech Lead accepts them.
 */
const S8_RLS_MIGRATION = '0052_accounting_journal_lines_rls_performance.sql';

/**
 * The constraints the optimised policies are a consequence of.
 *
 * Since `0052`, tenant isolation on `journal_lines`, `journal_entries` and
 * `accounts` derives from the row's own `tenant_id` instead of a per-row
 * lookup in `businesses`. That is only equivalent because each table carries
 * a composite foreign key guaranteeing the pair, so these FKs are now
 * load-bearing for ISOLATION and not merely for referential integrity. A
 * later migration that dropped, disabled or invalidated one would turn a
 * proof into an assumption silently — hence the static check below (§8).
 */
const TENANT_BUSINESS_FKS = ['journal_lines_tenant_business_fk', 'journal_entries_tenant_business_fk', 'accounts_tenant_business_fk'] as const;

/** The reconciliation authority, and the principals it must NOT be. */
const RECONCILER = 'daftar_reconciler';
const DEFINER_OWNER = 'daftar_accounting_internal';
const ENUMERATOR = 'accounting_reconcile_businesses';

/** The six tables the nine checks read, and nothing else (§12, §35). */
const GRANTED_TABLES = ['businesses', 'accounts', 'journal_entries', 'journal_lines', 'accounting_periods', 'accounting_source_bindings'] as const;

/** The modules this slice owns. */
const S8_READER = 'apps/api/src/modules/accounting/accounting-reconciliation.reader.ts';
const S8_SERVICE = 'apps/api/src/modules/accounting/accounting-reconciliation.service.ts';
const S8_WORKER = 'apps/api/src/modules/accounting/accounting-reconciliation.worker.ts';
const S8_MODULE = 'apps/api/src/app/reconciler.module.ts';
const S8_MODEL = 'infrastructure/database/reconciler-privilege-model.json';
const S8_DOMAIN = 'packages/accounting/src/reconciliation.ts';

/** The suites that prove, against a real database, what the structure claims. */
const P2_S8_TESTS = [
  'tests/security/reconciler-authority-matrix.test.ts',
  'tests/security/reconciler-process-isolation.test.ts',
  'tests/security/accounting-reconciliation-planted.test.ts',
  'tests/security/accounting-failure-injection.test.ts',
  'tests/security/accounting-observability-redaction.test.ts',
  'tests/security/accounting-raw-sql-invariants.test.ts',
  'tests/security/accounting-credential-matrix.test.ts',
  'tests/security/journal-lines-rls-policy.test.ts',
  'tests/security/policy-helper-inlining.test.ts',
  'tests/security/search-path-shadowing.test.ts',
  // Runs THIS gate, structurally, against throwaway copies of the tree with
  // one thing broken in each (f §24). It is in the matrix rather than beside
  // it because a proof that the gate can say no is worth exactly as much as
  // the gate, and should stop being true at the same moment.
  'tests/security/phase2-s8-gate-tamper.test.ts',
  'tests/integration/accounting-reconciliation.test.ts',
  'tests/integration/runner-exit-code.test.ts',
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
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const readIfPresent = (path: string): string | null => (existsSync(join(ROOT, path)) ? read(path) : null);
const stripTsProse = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

/** Every non-test application source file, path → contents (gates excluded). */
function collectAppFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  const skip = new Set(['node_modules', 'dist', '.next', 'build', '.git', 'coverage', 'guards']);
  const selfReferential = /^scripts[\\/](phase\d-\w+-gate|phase2-s\d-gate|static-guards|check-supply-chain|phase2-rollback-rehearsal)\.ts$/;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
        const rel = relative(ROOT, full);
        if (!selfReferential.test(rel)) out[rel] = readFileSync(full, 'utf8');
      }
    }
  };
  for (const dir of [
    'apps/api/src',
    'apps/web/src',
    'apps/admin/src',
    'packages/accounting/src',
    'packages/shared-contracts/src',
    'packages/domain-core/src',
    'scripts',
  ]) {
    const full = join(ROOT, dir);
    if (existsSync(full)) walk(full);
  }
  return out;
}

// ── 1. The boundary: 0050 frozen, 0051 a candidate, no 0052 (§2, §37, §44) ──
function checkMigrationBoundary(): void {
  console.log('P2-S8 GATE — the migration boundary');
  const files = sqlFiles();
  const manifest = JSON.parse(read('infrastructure/database/MIGRATION_MANIFEST.json')) as {
    frozenThrough: string;
    migrations: { name: string; sha256: string }[];
  };

  // §44: the hard stop. P2-S8 may not freeze 0051.
  if (manifest.frozenThrough !== FROZEN_THROUGH_EXACTLY) {
    fail(
      's8-hard-stop',
      `frozenThrough is ${manifest.frozenThrough} — P2-S8 freezes nothing. The boundary stays at ${FROZEN_THROUGH_EXACTLY} until a new Tech Lead directive says otherwise (§44).`,
    );
  } else {
    ok(`frozenThrough = ${manifest.frozenThrough} — unmoved, as §44 requires`);
  }

  // §37: 0000–0050 byte-for-byte. The manifest script asserts this too; this
  // is the independent second read, in a process that is not that script.
  let drifted = 0;
  for (const m of manifest.migrations) {
    const path = join(MIGRATIONS_DIR, m.name);
    if (!existsSync(path)) {
      fail('frozen-history', `${m.name} is recorded frozen but is missing — frozen history may never be deleted`);
      drifted += 1;
      continue;
    }
    const onDisk = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (onDisk !== m.sha256) {
      fail('frozen-history', `${m.name} hashes to ${onDisk.slice(0, 12)}… but was frozen at ${m.sha256.slice(0, 12)}… — frozen bytes are immutable (§37)`);
      drifted += 1;
    }
  }
  if (drifted === 0) ok(`all ${manifest.migrations.length} frozen migrations are byte-for-byte what the manifest recorded`);

  // §2: exactly two new migrations, and BOTH are candidates.
  for (const [candidate, why] of [
    [S8_MIGRATION, 'the reconciliation authority lives in it'],
    [S8_RLS_MIGRATION, 'the journal_lines tenant-policy correction lives in it'],
  ] as const) {
    if (!files.includes(candidate)) {
      fail('s8-migration', `${candidate} is missing — it is authorized, and ${why}`);
      continue;
    }
    ok(`${candidate} present`);
    if (manifest.migrations.some((m) => m.name === candidate)) {
      fail('s8-hard-stop', `${candidate} is recorded in the manifest — it is a CANDIDATE and P2-S8 may not freeze it (§2, §29)`);
    } else {
      ok(`${candidate} is a candidate: present on disk, absent from the manifest`);
    }
    const digest = createHash('sha256')
      .update(readFileSync(join(MIGRATIONS_DIR, candidate)))
      .digest('hex');
    ok(`${candidate} SHA-256 ${digest}`);
  }

  // §29: no 0053 and nothing beyond it.
  const beyond = files.filter((f) => f > S8_RLS_MIGRATION);
  if (beyond.length > 0) {
    fail('s8-hard-stop', `migrations beyond 0052 exist (${beyond.join(', ')}) — §29 forbids creating 0053 and forbids beginning P2-S9`);
  } else {
    ok('no migration beyond 0052 exists');
  }
}

/**
 * The FK the optimised policy stands on, over the whole migration history (§8).
 *
 * `0052` may replace a per-row `businesses` lookup with a direct `tenant_id`
 * predicate ONLY because `journal_lines_tenant_business_fk` guarantees the
 * pair. The live catalogue is checked by `0052` itself at apply time and by
 * `tests/security/journal-lines-rls-policy.test.ts` at run time; what neither
 * of those can see is a FUTURE migration that removes the constraint, because
 * a database that never applied it would simply not exist yet. So this reads
 * the history as text and refuses any statement that would drop, disable or
 * un-validate it.
 */
function checkFkDependencyIsProtected(): void {
  console.log('P2-S8 GATE — the foreign keys the optimised policies depend on (§8)');
  const files = sqlFiles();
  const texts = new Map(files.map((f) => [f, readFileSync(join(MIGRATIONS_DIR, f), 'utf8')] as const));
  const rls = texts.get(S8_RLS_MIGRATION) ?? '';

  for (const fk of TENANT_BUSINESS_FKS) {
    const creators = files.filter((f) => (texts.get(f) ?? '').includes(`CONSTRAINT ${fk}`));
    if (creators.length === 0) {
      fail('s8-fk', `no migration declares ${fk} — the optimised tenant policy that stands on it has no foundation`);
    } else {
      ok(`${fk} is declared in ${creators.join(', ')}`);
    }

    // Anything that would take it away, disable it, or leave it NOT VALID.
    const dangerous: { file: string; statement: string }[] = [];
    for (const file of files) {
      const text = texts.get(file) ?? '';
      const patterns: readonly [RegExp, string][] = [
        [new RegExp(`DROP\\s+CONSTRAINT\\s+(IF\\s+EXISTS\\s+)?${fk}`, 'i'), 'drops it'],
        [new RegExp(`ALTER\\s+TABLE[^;]*DISABLE\\s+TRIGGER[^;]*${fk}`, 'is'), 'disables it'],
        [new RegExp(`ALTER\\s+CONSTRAINT\\s+${fk}[^;]*NOT\\s+VALID`, 'is'), 'leaves it NOT VALID'],
        [new RegExp(`ADD\\s+CONSTRAINT\\s+${fk}[^;]*NOT\\s+VALID`, 'is'), 'adds it NOT VALID'],
      ];
      for (const [pattern, what] of patterns) if (pattern.test(text)) dangerous.push({ file, statement: what });
    }
    for (const d of dangerous) {
      fail(
        's8-fk',
        `${d.file} ${d.statement} ${fk} — since 0052 that constraint is what makes tenant isolation correct on the table it protects, so removing it is a security change and not a schema tidy-up (§8)`,
      );
    }
    if (dangerous.length === 0) ok(`no migration drops, disables or un-validates ${fk}`);

    // And the dependency is written down where a reader of 0052 will meet it.
    if (!rls.includes(fk)) {
      fail('s8-fk', `${S8_RLS_MIGRATION} does not name ${fk} — the equivalence it relies on must be stated where the change is made (§3)`);
    } else {
      ok(`${S8_RLS_MIGRATION} names ${fk}, the constraint its equivalence depends on`);
    }
  }
}

/**
 * ── What 0052 is allowed to contain ──────────────────────────────────────
 *
 * 0052 was authorized to do two things and nothing else: replace three policy
 * helpers so the planner can inline them, and reshape six policies across the
 * three tables the trial balance reads. The Tech Lead's authorization of
 * 2026-09-24 is explicit that it does not extend to any other RLS ("لا توسّع
 * 0052 إلى أي RLS أخرى دون دليل جديد وموافقة جديدة"), so the scope is checked
 * here as text, where a reviewer can see it fail before a server exists.
 *
 * The six ALTERs are required to be present, by table and by policy name,
 * because the measurement that justifies the change only holds for all six
 * together: every partial state was measured SLOWER than doing nothing.
 */
const S8_RLS_POLICIES: readonly (readonly [string, string])[] = [
  ['journal_lines', 'tenant_membership'],
  ['journal_lines', 'business_isolation'],
  ['journal_entries', 'tenant_membership'],
  ['journal_entries', 'business_isolation'],
  ['accounts', 'tenant_membership'],
  ['accounts', 'business_isolation'],
];

/** The three policy helpers 0052 replaces, and the only ones it may replace. */
const S8_RLS_HELPERS = ['app_tenant', 'app_business', 'app_bypass'] as const;

function checkRlsMigrationContent(): void {
  console.log('P2-S8 GATE — 0052 is a policy-shape migration and nothing else');
  const raw = readIfPresent(`infrastructure/database/migrations/${S8_RLS_MIGRATION}`);
  if (raw === null) return;
  const sql = stripComments(raw);
  // 0052's own assertion block names what it is asserting the ABSENCE of —
  // BYPASSRLS, the write privileges, the role names — inside string literals.
  // Blanking the literals is what lets this scan tell a privilege being taken
  // from one being checked for, the same reason 0051's scan does it.
  const sqlNoStrings = sql.replace(/'(?:[^']|'')*'/g, "''");

  const forbidden: [RegExp, string][] = [
    [/CREATE\s+(?:UNLOGGED\s+|TEMP\s+|TEMPORARY\s+)?TABLE\b/i, 'creates a table — no stored balance, ever (AL-15, §37)'],
    [/CREATE\s+MATERIALIZED\s+VIEW\b/i, 'creates a materialized view — a second source of financial truth (AL-15)'],
    [/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\b/i, 'creates a view'],
    [/CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\b/i, 'creates a trigger'],
    [/CREATE\s+INDEX\b|CREATE\s+UNIQUE\s+INDEX\b/i, 'creates an index — 0050 is where the accounting indexes live and it is frozen'],
    [/ADD\s+COLUMN\b/i, 'adds a column'],
    [/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE)\b/i, 'writes data'],
    [/\bGRANT\b/i, 'grants a privilege — a performance correction is not permission to widen anything'],
    [/\bREVOKE\b/i, "revokes a privilege — the privilege surface is 0051's business and bootstrap.sql's, not this file's"],
    [/\bBYPASSRLS\b/i, 'mentions BYPASSRLS — §4 is non-negotiable'],
    [/\bSUPERUSER\b(?!\s*;)/i, 'mentions SUPERUSER'],
    [/CREATE\s+ROLE\b|ALTER\s+ROLE\b/i, 'touches a role'],
    [/\bPASSWORD\b/i, 'contains a password — a migration must never know a credential'],
    [/app\.bypass_rls/i, 'reaches for app.bypass_rls — since 0032 that GUC reads nothing'],
    [/DROP\s+POLICY\b/i, 'drops a policy — ALTER POLICY keeps the table protected at every instant inside the transaction'],
    [/CREATE\s+POLICY\b/i, 'creates a policy — 0052 reshapes existing boundaries and introduces none'],
    [/DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i, 'turns row-level security off'],
    [/ALTER\s+FUNCTION\b/i, 'alters a function in place — the replacement is asserted as a whole definition, not patched attribute by attribute'],
  ];
  let clean = true;
  for (const [re, what] of forbidden) {
    if (re.test(sqlNoStrings)) {
      fail('s8-rls-migration-scope', `${S8_RLS_MIGRATION} ${what}`);
      clean = false;
    }
  }
  if (clean) ok(`${S8_RLS_MIGRATION} creates, grants, drops and stores nothing`);

  // Exactly the six authorized ALTER POLICY statements, no more and no fewer.
  const altered = [...sql.matchAll(/ALTER\s+POLICY\s+([A-Za-z_][A-Za-z0-9_]*)\s+ON\s+([A-Za-z_][A-Za-z0-9_]*)/gi)].map(
    (m) => `${(m[2] ?? '').toLowerCase()}.${(m[1] ?? '').toLowerCase()}`,
  );
  const expected = S8_RLS_POLICIES.map(([t, p]) => `${t}.${p}`);
  const unexpected = altered.filter((a) => !expected.includes(a));
  const missing = expected.filter((e) => !altered.includes(e));
  if (unexpected.length > 0) {
    fail('s8-rls-migration-scope', `${S8_RLS_MIGRATION} alters policies nobody authorized: ${[...new Set(unexpected)].join(', ')}`);
  }
  if (missing.length > 0) {
    fail(
      's8-rls-migration-scope',
      `${S8_RLS_MIGRATION} is missing ${missing.join(', ')} — every partial correction was measured SLOWER than no correction, so a subset is not a smaller fix, it is a regression`,
    );
  }
  if (unexpected.length === 0 && missing.length === 0) ok(`${S8_RLS_MIGRATION} alters exactly the six authorized policies`);

  // Exactly the three authorized helper replacements.
  const replaced = [...sql.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+([A-Za-z_][A-Za-z0-9_]*)/gi)].map((m) => (m[1] ?? '').toLowerCase());
  const extra = replaced.filter((r) => !(S8_RLS_HELPERS as readonly string[]).includes(r));
  const absent = S8_RLS_HELPERS.filter((h) => !replaced.includes(h));
  if (extra.length > 0) fail('s8-rls-migration-scope', `${S8_RLS_MIGRATION} replaces functions nobody authorized: ${[...new Set(extra)].join(', ')}`);
  if (absent.length > 0) fail('s8-rls-migration-scope', `${S8_RLS_MIGRATION} does not replace ${absent.join(', ')}`);
  if (extra.length === 0 && absent.length === 0) ok(`${S8_RLS_MIGRATION} replaces exactly ${S8_RLS_HELPERS.join(', ')}`);

  // The replacement must not smuggle authority into app_bypass(): the only
  // DAFTAR principal its new body may name is the platform one.
  const bypass = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+app_bypass[\s\S]*?;/i.exec(sql)?.[0] ?? '';
  const named = [...new Set(bypass.match(/daftar_[a-z_]+/g) ?? [])];
  if (named.length !== 1 || named[0] !== 'daftar_platform') {
    fail('s8-rls-migration-scope', `${S8_RLS_MIGRATION} rewrites app_bypass() to name ${named.join(', ') || 'nothing'} — §4 pins it to daftar_platform alone`);
  } else {
    ok('the replaced app_bypass() still exempts daftar_platform and nobody else');
  }

  // And the policy bodies must compare the COLUMN, which is the half of the
  // correction that fixes the row estimate. A single surviving `::text =`
  // would leave one relation estimating blindly beside two that do not.
  for (const line of sql.split('\n')) {
    if (/^\s*(USING|WITH CHECK)\b/i.test(line) && /::text\s*=/.test(line)) {
      fail('s8-rls-migration-scope', `${S8_RLS_MIGRATION} still casts a column to text in: ${line.trim()}`);
    }
  }
}

// ── 2. What 0051 is allowed to contain (§33) ───────────────────────────────
function checkMigrationContent(): void {
  console.log('P2-S8 GATE — 0051 is an authority migration and nothing else');
  const raw = readIfPresent(`infrastructure/database/migrations/${S8_MIGRATION}`);
  if (raw === null) return;
  const sql = stripComments(raw);

  /**
   * The same SQL with single-quoted literals blanked out.
   *
   * The forbidden-content scan below must read this rather than `sql`,
   * because 0051's closing assertion block NAMES the things it is asserting
   * the absence of: it loops over `ARRAY['INSERT', 'UPDATE', 'DELETE',
   * 'TRUNCATE']` and it raises a message containing the word BYPASSRLS. A
   * scan that could not tell a privilege being GRANTED from one being
   * REFUSED would punish the migration for checking itself, which is exactly
   * the behaviour that gets self-verification deleted.
   *
   * Every other check keeps reading `sql`, because the identifiers they look
   * for — `daftar_worker`, the role names in the membership loop — live
   * inside those same literals and are the point.
   */
  const sqlNoStrings = sql.replace(/'(?:[^']|'')*'/g, "''");

  // §33 names what it may carry. Everything else is something nobody
  // authorized, and an authority migration is exactly where an unauthorized
  // addition is hardest to notice.
  const forbidden: [RegExp, string][] = [
    [/CREATE\s+(?:UNLOGGED\s+|TEMP\s+|TEMPORARY\s+)?TABLE\b/i, 'creates a table — reconciliation stores nothing (§18)'],
    [/CREATE\s+MATERIALIZED\s+VIEW\b/i, 'creates a materialized view — a second source of financial truth (AL-15)'],
    [/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\b/i, 'creates a view'],
    [/CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\b/i, 'creates a trigger'],
    [/CREATE\s+INDEX\b|CREATE\s+UNIQUE\s+INDEX\b/i, 'creates an index — §26 requires measurement first and §2 authorizes no 0052'],
    [/ADD\s+COLUMN\b/i, 'adds a column'],
    [/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE)\b/i, 'writes data'],
    [/\bBYPASSRLS\b/i, 'mentions BYPASSRLS — §4 is non-negotiable'],
    [/\bSUPERUSER\b(?!\s*;)/i, 'mentions SUPERUSER'],
    [/CREATE\s+ROLE\b/i, 'creates a role — bootstrap.sql owns role creation, because a migration must never know a credential'],
    [/\bPASSWORD\b/i, 'contains a password — a migration must never know a credential'],
    [/app\.bypass_rls/i, 'reaches for app.bypass_rls — since 0032 that GUC reads nothing, and §4 forbids reviving it as an authority'],
    [/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+app_bypass/i, 'redefines app_bypass() — §4 pins it to daftar_platform alone'],
    [/DROP\s+POLICY\b/i, 'drops a policy — §4 forbids weakening tenant or business isolation'],
  ];
  let clean = true;
  for (const [re, what] of forbidden) {
    if (re.test(sqlNoStrings)) {
      fail('s8-migration-scope', `${S8_MIGRATION} ${what}`);
      clean = false;
    }
  }

  // Exactly one function, and it is the enumerator (§9).
  const created = [...sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(\w+)/gi)].map(([, name]) => name);
  if (created.length !== 1 || created[0] !== ENUMERATOR) {
    fail('s8-enumerator', `${S8_MIGRATION} creates ${created.length === 0 ? 'no function' : created.join(', ')} — §9 authorizes exactly one, ${ENUMERATOR}`);
  } else if (clean) {
    ok(`${S8_MIGRATION} creates one function, ${ENUMERATOR}, and no relation`);
  }

  // §10: hardened definer, owned by the unreachable internal principal, with
  // EXECUTE revoked from PUBLIC and granted to the reconciler alone.
  const definerRules: [RegExp, string][] = [
    [/SECURITY\s+DEFINER/i, 'the enumerator is not SECURITY DEFINER, so it cannot see the rows it exists to list'],
    [
      /SET\s+search_path\s*=\s*pg_catalog,\s*public,\s*pg_temp/i,
      'the enumerator has no hardened search_path — a definer routine without one is a privilege escalation waiting for a shadowing schema',
    ],
    [
      new RegExp(`OWNER\\s+TO\\s+${DEFINER_OWNER}`, 'i'),
      `the enumerator is not owned by ${DEFINER_OWNER} — a definer routine runs as its owner, so the owner IS the authority`,
    ],
    [
      new RegExp(`REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+${ENUMERATOR}[\\s\\S]{0,120}?FROM\\s+PUBLIC`, 'i'),
      'PUBLIC EXECUTE is not revoked from the enumerator — PostgreSQL grants it by default (§10)',
    ],
    [new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+${ENUMERATOR}[\\s\\S]{0,120}?TO\\s+${RECONCILER}`, 'i'), `EXECUTE is not granted to ${RECONCILER}`],
  ];
  for (const [re, why] of definerRules) {
    if (!re.test(sql)) fail('s8-enumerator', `${S8_MIGRATION}: ${why}`);
  }

  // §9: the enumerator returns identifiers ONLY. A name or a currency in the
  // return type turns an identifier service into a data export.
  const returns = /RETURNS\s+TABLE\s*\(([^)]*)\)/i.exec(sql)?.[1] ?? '';
  const returned = returns
    .split(',')
    .map((c) => c.trim().split(/\s+/)[0] ?? '')
    .filter(Boolean);
  if (returned.length !== 2 || !returned.includes('tenant_id') || !returned.includes('business_id')) {
    fail('s8-enumerator', `the enumerator returns (${returned.join(', ')}) — §9 allows exactly tenant_id and business_id`);
  } else {
    ok('the enumerator returns tenant_id and business_id, and nothing else');
  }

  // §24: keyset, never OFFSET, and bounded.
  if (/\bOFFSET\b/i.test(sql)) {
    fail('s8-enumerator', 'the enumerator uses OFFSET — a business created mid-pass makes an OFFSET walk skip another one (§24)');
  } else {
    ok('the enumerator paginates by keyset, not OFFSET');
  }
  if (!/\bLIMIT\b/i.test(sql) || !/least\s*\(/i.test(sql)) {
    fail('s8-enumerator', 'the enumerator does not clamp its limit — an unbounded page is an unbounded read (§25)');
  } else {
    ok('the enumerator clamps its page size');
  }

  // §12: reads are column-level SELECT on exactly the six tables, and there
  // is no write grant anywhere in the file.
  const grants = [...sql.matchAll(/GRANT\s+([A-Z ,]+?)(\(([^)]*)\))?\s+ON\s+(?:TABLE\s+)?(\w+)\s+TO\s+(\w+)/gi)];
  const granted = new Map<string, string[]>();
  for (const [, privs = '', , columns, table = '', grantee = ''] of grants) {
    const privilege = privs.trim().toUpperCase();
    if (grantee === 'daftar_worker') {
      fail('s8-worker-unchanged', `${S8_MIGRATION} grants ${privilege} on ${table} to daftar_worker — §15 requires the worker to be unchanged`);
    }
    if (grantee !== RECONCILER) continue;
    if (privilege !== 'SELECT') {
      fail('s8-read-only', `${S8_MIGRATION} grants ${privilege} on ${table} to ${RECONCILER} — reconciliation may DETECT, never REPAIR (§18)`);
      continue;
    }
    if (columns === undefined) {
      fail(
        's8-column-grants',
        `${S8_MIGRATION} grants table-wide SELECT on ${table} — §13 requires column grants, or a stolen reconciliation credential becomes a customer-data reader`,
      );
      continue;
    }
    granted.set(
      table,
      columns.split(',').map((c) => c.trim()),
    );
  }
  const grantedTables = [...granted.keys()].sort();
  const expected = [...GRANTED_TABLES].sort();
  if (grantedTables.join(',') !== expected.join(',')) {
    fail('s8-column-grants', `${RECONCILER} is granted SELECT on [${grantedTables.join(', ')}] — §35 names exactly [${expected.join(', ')}]`);
  } else {
    ok(`column-level SELECT on exactly the ${expected.length} tables the nine checks read`);
  }

  // §13: no PII column, whatever the table.
  const pii = /\b(name|store_slug|email|phone|contact|address|password|token|secret|key_material|description|memo|last_reopen_reason)\b/i;
  for (const [table, columns] of granted) {
    for (const column of columns) {
      if (pii.test(column)) fail('s8-column-grants', `${RECONCILER} may read ${table}.${column}, which is merchant free text or a contact detail (§13)`);
    }
  }

  // §14/§27: the file verifies its own claims against the LIVE catalogue.
  // A migration that describes a privilege model and does not assert it has
  // documented an intention, not built a boundary.
  for (const [needle, why] of [
    ['rolbypassrls', 'never asserts that nothing holds BYPASSRLS'],
    ['app_bypass', 'never asserts that app_bypass() still names daftar_platform alone'],
    ['has_table_privilege', 'never asserts the absence of write privileges against the live catalogue'],
    ['daftar_worker', 'never asserts the §15 worker regression'],
  ] as const) {
    if (!sql.includes(needle)) fail('s8-self-assertion', `${S8_MIGRATION} ${why} (§14, §15, §27)`);
  }
  ok('0051 asserts its own privilege model against the live catalogue before it commits');
}

// ── 3. app_bypass() is untouched, across the whole schema (§4) ─────────────
function checkBypassContract(): void {
  console.log('P2-S8 GATE — the RLS bypass contract');
  const schema = sqlFiles()
    .map((f) => stripComments(read(`infrastructure/database/migrations/${f}`)))
    .join('\n');

  // The LAST definition of app_bypass() in migration order is the one the
  // database ends up with. Reading only 0032 would miss a later redefinition,
  // which is precisely how this contract would be lost.
  // The BODY, between the dollar quotes — not the header. A non-greedy match
  // that stopped at the first `$$` would stop at the OPENING delimiter and
  // then report that a perfectly correct function does not name the principal
  // its body names, which is a gate failing on its own regex.
  const definitions = [...schema.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+app_bypass\s*\(\s*\)[\s\S]*?\$\$([\s\S]*?)\$\$/gi)];
  const last = definitions[definitions.length - 1]?.[1];
  if (last === undefined) {
    fail('bypass-contract', 'app_bypass() is not defined anywhere in the schema');
  } else if (!/daftar_platform/.test(last) || /daftar_reconciler|daftar_worker|app\.bypass_rls/.test(last)) {
    fail('bypass-contract', 'the final definition of app_bypass() names a principal other than daftar_platform — §4 is non-negotiable');
  } else {
    ok(`app_bypass() is defined ${definitions.length} time${definitions.length === 1 ? '' : 's'} and its final form exempts daftar_platform alone`);
  }

  for (const f of sqlFiles()) {
    const sql = stripComments(read(`infrastructure/database/migrations/${f}`));
    if (/ALTER\s+ROLE\s+\w+\s+(?:WITH\s+)?[^;]*\bBYPASSRLS\b/i.test(sql) && !/NOBYPASSRLS/i.test(sql)) {
      fail('bypass-contract', `${f} grants BYPASSRLS — §4 forbids it outright`);
    }
  }
  ok('no migration grants BYPASSRLS');
}

// ── 4. The role's attributes, at the place they are set (§5) ───────────────
function checkRoleAttributes(): void {
  console.log('P2-S8 GATE — the reconciler role');
  const bootstrap = readIfPresent('infrastructure/database/bootstrap.sql');
  if (bootstrap === null) {
    fail('s8-role', 'infrastructure/database/bootstrap.sql is missing');
    return;
  }
  if (!new RegExp(`\\b${RECONCILER}\\b`).test(bootstrap)) {
    fail('s8-role', `bootstrap.sql never creates ${RECONCILER} — 0051 refuses to apply without it, so a deployment would fail at the migration step`);
    return;
  }
  // The attributes are read from the statement that mentions the role, not
  // from the file as a whole: NOSUPERUSER appearing somewhere else in a file
  // that creates seven roles proves nothing about this one.
  const block = new RegExp(`${RECONCILER}[\\s\\S]{0,400}?;`, 'i').exec(bootstrap)?.[0] ?? '';
  for (const attribute of ['LOGIN', 'NOSUPERUSER', 'NOBYPASSRLS', 'NOCREATEDB', 'NOCREATEROLE', 'NOREPLICATION']) {
    if (new RegExp(`\\b${attribute}\\b`).test(block)) ok(`${RECONCILER} is ${attribute}`);
    else fail('s8-role', `${RECONCILER} is not declared ${attribute} where it is created (§5)`);
  }
  for (const [re, why] of [
    [new RegExp(`REVOKE\\s+TEMPORARY[\\s\\S]{0,200}?${RECONCILER}`, 'i'), 'TEMPORARY is not revoked — a temp table is a writable object (§5)'],
    [new RegExp(`REVOKE\\s+CREATE\\s+ON\\s+SCHEMA\\s+public[\\s\\S]{0,200}?${RECONCILER}`, 'i'), 'CREATE on schema public is not revoked (§5)'],
  ] as [RegExp, string][]) {
    if (!re.test(bootstrap)) fail('s8-role', `bootstrap.sql: ${why}`);
  }
  ok('TEMPORARY and CREATE on public are revoked from the reconciler');
}

// ── 5. The process boundary (§6, §7, §8, §29, §31, §32) ────────────────────
function checkProcessBoundary(): void {
  console.log('P2-S8 GATE — the reconciler process');

  const config = readIfPresent('apps/api/src/config.ts');
  if (config === null) {
    fail('s8-process', 'apps/api/src/config.ts is missing');
  } else {
    const code = stripTsProse(config);
    if (!/PROCESS_MODE[\s\S]{0,200}?'reconciler'/.test(code)) {
      fail('s8-process', "config.ts has no 'reconciler' PROCESS_MODE — §6 gives reconciliation its own process");
    } else {
      ok("PROCESS_MODE accepts 'reconciler'");
    }
    if (!/RECONCILER_DATABASE_URL/.test(code)) {
      fail('s8-process', 'config.ts never reads RECONCILER_DATABASE_URL — §7 gives the reconciler its own connection string');
    } else {
      ok('RECONCILER_DATABASE_URL is a configuration key of its own');
    }
    // §8: the refusal must be PHYSICAL, and it must apply in every
    // environment. A check inside `if (NODE_ENV === 'production')` is a
    // check that is off in every test that would have caught the mistake.
    const productionOnly = /NODE_ENV\s*!==\s*'production'\s*\)\s*return;?[\s\S]*mode\s*===\s*'reconciler'/.test(code);
    if (productionOnly) {
      fail('s8-process', "config.ts refuses the other processes' secrets only in production — §8 is a boundary, not a production convention");
    }
    for (const secret of ['SMTP_URL', 'JWT_SECRET', 'CREDENTIAL_PAYLOAD_KEY', 'ACCOUNTING_ASSERTION_KEY', 'WORKER_DATABASE_URL']) {
      if (!new RegExp(`'${secret}'`).test(code)) {
        fail(
          's8-process',
          `config.ts never refuses ${secret} in reconciler mode — §29 requires the cross-process secret matrix to be enforced, not documented`,
        );
      }
    }
    ok("the reconciler process physically refuses every other process's secret, in every environment");
  }

  // §6: a MODULE, not a provider inside WorkerModule.
  const module = readIfPresent(S8_MODULE);
  if (module === null) {
    fail('s8-process', `${S8_MODULE} is missing — §6 requires a dedicated module, not a provider bolted into WorkerModule`);
  } else {
    if (/controllers\s*:/.test(stripTsProse(module))) {
      fail('s8-process', `${S8_MODULE} declares controllers — the reconciler has NO HTTP surface (§6)`);
    } else {
      ok('ReconcilerModule has no controllers and no HTTP surface');
    }
  }
  const workerModule = readIfPresent('apps/api/src/app/worker.module.ts');
  if (workerModule !== null && /[Rr]econcil/.test(stripTsProse(workerModule))) {
    fail('s8-process', 'worker.module.ts still composes reconciliation — §0 separates delivery authority from financial reconciliation authority');
  } else {
    ok('the worker process cannot reach reconciliation at all');
  }

  // §31: no silent fallback to another pool. A reconciler that quietly
  // borrowed the platform pool would pass every functional test and hold an
  // authority nobody granted it.
  const database = readIfPresent('apps/api/src/infra/database.ts');
  if (database === null) {
    fail('s8-process', 'apps/api/src/infra/database.ts is missing');
  } else {
    const code = stripTsProse(database);
    if (!/withReconcilerTransaction/.test(code)) {
      fail('s8-process', 'database.ts has no withReconcilerTransaction — §30 gives the reconciler its own pool and its own boundary');
    } else {
      ok('database.ts exposes a reconciler boundary of its own');
    }
    if (/RECONCILER_DATABASE_URL\s*(?:\?\?|\|\|)\s*\w/.test(code)) {
      fail('s8-process', 'database.ts falls back to another connection string when RECONCILER_DATABASE_URL is absent — §31 forbids a silent fallback');
    } else {
      ok('there is no fallback: without its own URL the reconciler pool does not exist');
    }
    if (!new RegExp(`'${RECONCILER}'`).test(code)) {
      fail('s8-process', `database.ts never verifies that the reconciler pool authenticates as ${RECONCILER} (§30)`);
    } else {
      ok(`the reconciler pool is verified to authenticate as ${RECONCILER}`);
    }
  }

  // §32: a boot path with graceful shutdown.
  const main = readIfPresent('apps/api/src/main.ts');
  if (main === null) {
    fail('s8-process', 'apps/api/src/main.ts is missing');
  } else {
    const code = stripTsProse(main);
    if (!/ReconcilerModule/.test(code)) {
      fail('s8-process', 'main.ts has no reconciler branch — §32 boots it as an ApplicationContext');
    } else if (!/SIGTERM/.test(code)) {
      fail(
        's8-process',
        'main.ts does not handle SIGTERM in the reconciler branch — §32 requires graceful shutdown, and §17 forbids reporting an interrupted cycle as success',
      );
    } else {
      ok('main.ts boots the reconciler as an ApplicationContext and drains it on SIGTERM');
    }
  }
}

// ── 6. Reconciliation may DETECT, never REPAIR (§18) ───────────────────────
function checkDetectNotRepair(): void {
  console.log('P2-S8 GATE — detect, never repair');
  for (const path of [S8_READER, S8_SERVICE, S8_WORKER]) {
    const source = readIfPresent(path);
    if (source === null) {
      fail('s8-detect', `${path} is missing`);
      continue;
    }
    const code = stripTsProse(source);
    for (const [re, what] of [
      [/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE\s+)/i, 'issues a write'],
      [/\bOFFSET\b/i, 'uses OFFSET (§24)'],
      [/SET\s+ROLE/i, 'issues SET ROLE — a process does not change who it is mid-pass'],
      [/app\.bypass_rls|app_bypass/i, 'reaches for the RLS bypass (§4)'],
    ] as [RegExp, string][]) {
      if (re.test(code)) fail('s8-detect', `${path} ${what}`);
    }
  }
  ok('the reconciliation path writes nothing, pages by keyset and changes no principal');

  // §16/§17: "could not look" must be a DIFFERENT outcome from "looked and
  // found nothing", and it must not be counted as success.
  // §16's four-valued outcome is a DOMAIN concept, so it is asserted where it
  // is defined. The reader's job is to raise when it cannot read; the domain
  // is what turns that into a status distinct from `ok`.
  const domain = readIfPresent(S8_DOMAIN);
  if (domain === null) {
    fail('s8-unavailable', `${S8_DOMAIN} is missing — the reconciliation outcome type lives in the domain package`);
  } else {
    const code = stripTsProse(domain);
    if (!/'unavailable'/.test(code)) {
      fail('s8-unavailable', `${S8_DOMAIN} has no \`unavailable\` status — §16 distinguishes "checked and clean" from "could not inspect"`);
    } else if (!/ReconciliationStatus[\s\S]{0,200}?'unavailable'/.test(code)) {
      fail('s8-unavailable', `${S8_DOMAIN} mentions unavailable but it is not one of the statuses a check may carry (§16)`);
    } else {
      ok('a check that could not look answers `unavailable`, not `clean`');
    }
    if (!/enumeration[\s\S]{0,120}?'unavailable'/.test(code)) {
      fail('s8-unavailable', `${S8_DOMAIN} has no distinct enumeration outcome — a pass that could not list the businesses has not checked them (§17)`);
    } else {
      ok('incomplete enumeration is its own outcome, not a short list of clean results');
    }
  }

  const reader = readIfPresent(S8_READER);
  if (reader !== null) {
    const code = stripTsProse(reader);
    if (!/has_function_privilege/.test(code)) {
      fail(
        's8-unavailable',
        `${S8_READER} never probes its own EXECUTE privilege — §17 requires the pass to run through the PRODUCTION authority, and to say so when it cannot`,
      );
    } else {
      ok('the pass probes its own enumeration authority before claiming to have enumerated');
    }
    if (!/statement_timeout/.test(code)) {
      fail('s8-unavailable', `${S8_READER} sets no per-business statement_timeout — §25 bounds each business, and a breach is an error, never a silent skip`);
    } else {
      ok('each business is bounded by a statement timeout whose breach is an error');
    }
  }
  const service = readIfPresent(S8_SERVICE);
  if (service !== null && !/unavailable/.test(stripTsProse(service))) {
    fail('s8-unavailable', `${S8_SERVICE} never considers an unavailable check — a cycle with one is NOT a success (§17)`);
  } else if (service !== null) {
    ok('a cycle carrying an unavailable check is not reported as a success');
  }
}

// ── 7. No production debug switch was added to make testing possible (f §30)
function checkNoTestSeamInProduction(): void {
  console.log('P2-S8 GATE — no production debug switch');
  const forbidden: [RegExp, string][] = [
    [/x-daftar-(?:bypass|debug|test|disable)/i, 'a bypass or debug request header'],
    [/DISABLE_(?:RLS|CONSTRAINTS|TRIGGERS)/i, 'a switch that disables an invariant'],
    [/session_replication_role/i, 'a switch that disables triggers and foreign keys'],
    [/ALLOW_(?:UNBALANCED|FUTURE_DATED|UNSIGNED)/i, 'a switch that permits an invalid posting'],
  ];
  let found = 0;
  for (const [path, source] of Object.entries(collectAppFiles())) {
    // The rehearsal and the gates are excluded by collectAppFiles; every
    // remaining file is code a production process can load.
    for (const [re, what] of forbidden) {
      if (re.test(stripTsProse(source))) {
        fail('s8-no-seam', `${path} contains ${what} — failure injection may not add a production switch (f §30)`);
        found += 1;
      }
    }
  }
  if (found === 0) ok('no bypass header, no disable-constraint switch and no test-only branch in any production source file');
}

// ── 8. The intended privilege model is machine-readable (§27) ──────────────
function checkPrivilegeModel(): void {
  console.log('P2-S8 GATE — the intended privilege model');
  const raw = readIfPresent(S8_MODEL);
  if (raw === null) {
    fail('s8-model', `${S8_MODEL} is missing — §27 requires the intended model to be machine-readable, so a suite can compare it with the live catalogue`);
    return;
  }
  const model = JSON.parse(raw) as {
    role?: string;
    memberOf?: string[];
    writePrivileges?: string[];
    executableRoutines?: string[];
    selectColumns?: Record<string, string[]>;
    mustNotRead?: string[];
  };
  if (model.role !== RECONCILER) fail('s8-model', `the model describes ${String(model.role)}, not ${RECONCILER}`);
  if ((model.memberOf ?? []).length > 0) fail('s8-model', 'the model grants role membership — §5 forbids it');
  if ((model.writePrivileges ?? []).length > 0) fail('s8-model', 'the model grants a write privilege — §12 forbids it');
  if ((model.executableRoutines ?? []).length !== 1)
    fail('s8-model', `the model lists ${(model.executableRoutines ?? []).length} executable routines — §9 authorizes exactly one`);
  if ((model.mustNotRead ?? []).length === 0) fail('s8-model', 'the model names nothing the reconciler must not read — §13 is the point of column grants');

  // The model and the migration must name the same tables. Two sources that
  // can drift are two sources that will.
  const modelled = Object.keys(model.selectColumns ?? {}).sort();
  const expected = [...GRANTED_TABLES].sort();
  if (modelled.join(',') !== expected.join(',')) {
    fail('s8-model', `the model grants SELECT on [${modelled.join(', ')}] but 0051 grants it on [${expected.join(', ')}]`);
  } else {
    ok('the intended model and 0051 name the same six tables');
  }

  const suite = readIfPresent('tests/security/reconciler-authority-matrix.test.ts');
  if (suite === null) {
    fail('s8-model', 'tests/security/reconciler-authority-matrix.test.ts is missing — a model nobody compares with the database is a document');
  } else if (!suite.includes('reconciler-privilege-model.json')) {
    fail('s8-model', 'the authority matrix suite does not read the model file — §27 compares the INTENDED model with the LIVE catalogue');
  } else {
    ok('the authority matrix compares the intended model with the live catalogue');
  }
}

// ── 9. Every behavioural claim has a suite that makes it ──────────────────
/**
 * WHAT THIS CHECK READS, AND WHAT IT REFUSES TO READ (f §1, §4, §6).
 *
 * It used to read `release/phase2-s8-evidence.json`,
 * `release/phase2-s8-rls-equivalence.json` and
 * `release/phase2-s8-performance-tier2.json`, and fail when one was missing.
 * Those three files are gitignored, so a clean checkout never has them: the
 * gate could only pass on a machine where somebody had already produced them
 * by hand. That is the defect f §1 names — a gate that cannot run in CI is
 * not an acceptance gate, and a local JSON file GitHub never produced is
 * supporting evidence, not CI proof.
 *
 * The answer is NOT to keep reading them and forgive their absence, which
 * would make the gate silently weaker on exactly the machine whose verdict
 * matters. It is to move every claim that rests on a produced artefact into
 * the release gate — `npm run gate:phase2:s8:release`, which requires all of
 * them and forgives nothing — and to leave THIS gate deriving its verdict
 * from two things only: files that are in the repository, and the exit status
 * of commands it runs itself.
 *
 * So the list below contains sources and suites, never outputs.
 */
function checkClaimsHaveSuites(): void {
  console.log('P2-S8 GATE — every behavioural claim has a suite');
  const required: [string, string][] = [
    [
      'tests/security/reconciler-authority-matrix.test.ts',
      'the intended model against the live catalogue, both directions, and the stolen-credential matrix (§27, §28)',
    ],
    ['tests/security/reconciler-process-isolation.test.ts', 'the cross-process secret matrix and what the reconciler process does NOT compose (§8, §29)'],
    ['tests/security/accounting-reconciliation-planted.test.ts', 'each of the nine checks tripped by a planted discrepancy (§23)'],
    ['tests/security/accounting-failure-injection.test.ts', 'FI-01 … FI-12 (f §29)'],
    ['tests/security/accounting-observability-redaction.test.ts', 'the redaction sentinels and the metric label contract (f §45, §46)'],
    ['tests/security/accounting-raw-sql-invariants.test.ts', 'the invariants at raw SQL, beneath every application layer'],
    [
      'tests/security/accounting-credential-matrix.test.ts',
      'what each runtime database credential can actually do, asked from the credential rather than through the product (f §13, §14, §17)',
    ],
    [
      'tests/integration/accounting-reconciliation.test.ts',
      'the nine checks through the PRODUCTION authority, pagination, the schedule and crash/restart (§11, §17, §21, §22, §24)',
    ],
    [
      'tests/security/journal-lines-rls-policy.test.ts',
      'the FK foundation, the effective policy shape and the isolation matrix A…M over all three corrected tables (§7, §8, §9)',
    ],
    [
      'tests/security/policy-helper-inlining.test.ts',
      'the three policy helpers: why they may carry no search_path, that nothing else joined that set, and that their authority did not move',
    ],
    [
      'tests/security/phase2-s8-gate-tamper.test.ts',
      'that each structural refusal in THIS file can actually fire, proved against a throwaway copy of the tree (f §24)',
    ],
    ['tests/performance/accounting-rls-equivalence.test.ts', 'the same read at 0051 and at 0052 on one database: the answer and the plan (§10, §11)'],
    ['tests/performance/accounting-budgets.test.ts', 'the six budgets, measured (f §34)'],
    ['tests/performance/accounting-dataset.ts', 'the deterministic dataset generator (f §31)'],
    ['scripts/phase2-rollback-rehearsal.ts', 'the rollback/restore rehearsal (f §39–§42)'],
    ['scripts/check-supply-chain.ts', 'supply-chain hygiene (f §47)'],
    ['scripts/phase2-s8-release-gate.ts', 'the release gate: the acceptance-scale claims this gate deliberately does not make (f §4)'],
    ['docs/PHASE_2_KMS_SIGNER_REVIEW.md', 'the KMS signer review (f §43, §44)'],
    ['docs/PHASE_2_S8_ACCEPTANCE.md', 'the acceptance record (f §52)'],
    ['docs/PHASE_2_PERFORMANCE_BASELINE.md', 'the performance baseline (f §51)'],
    ['.github/workflows/phase2-s8-evidence.yml', 'the workflow that produces the release evidence ON GitHub, at an exact SHA (f §9, §10)'],
    ['tests/fixtures/runner-exit-code/failing.fixture.ts', 'the canary this gate runs before trusting any test result in its own run (f §3)'],
  ];
  for (const [path, why] of required) {
    if (existsSync(join(ROOT, path))) ok(`${path} — ${why}`);
    else fail('s8-suites', `${path} is missing — ${why}`);
  }

  const suite = readIfPresent('tests/security/reconciler-authority-matrix.test.ts');
  if (suite !== null && !suite.includes('reconciler-privilege-model.json')) {
    fail('s8-suites', 'the authority matrix suite does not read the model file — §27 compares the INTENDED model with the LIVE catalogue');
  }

  // The debt this slice found and did NOT close must be written down, or the
  // next reader will rediscover it as a surprise.
  const debt = readIfPresent('TECHNICAL_DEBT.md');
  if (debt === null) {
    fail('s8-suites', 'TECHNICAL_DEBT.md is missing');
  } else {
    for (const [needle, what] of [
      [/entry_date_in_future|future-dat/i, 'the future-dating rule living in the commands rather than in the schema'],
      [/KMS/i, 'the assertion-signing boundary the KMS review left open'],
    ] as [RegExp, string][]) {
      if (!needle.test(debt))
        fail('s8-suites', `TECHNICAL_DEBT.md does not record ${what} — a finding that is not written down is a finding that was not reported`);
    }
    ok('the two findings this slice did not close are recorded as debt');
  }
}

// ── 10. The guard that makes every green in this run mean something ───────
/**
 * A DORMANT GUARD IS NOT A GUARD (f §17, §18).
 *
 * `tests/helpers/exit-code.ts` is the reason a failing Vitest run in this
 * repository leaves with a non-zero status at all; without it the
 * `embedded-postgres` shutdown hook calls `process.exit(0)` over a recorded
 * failure and every gate that reads an exit status silently becomes a
 * rubber stamp. The canary below proves the guard WORKS. It cannot prove the
 * guard is still WIRED IN, because the canary runs through the same
 * `globalSetup` that installs it — remove the installation and the canary
 * stops being able to detect its removal, which is the exact shape of the
 * defect it exists to catch.
 *
 * So the wiring is checked here as text: the root configuration names the
 * global setup, the global setup imports the helper and calls it at module
 * scope, and the canary's own configuration names the same global setup. An
 * edit that deletes the call while leaving `exit-code.ts` on disk — the
 * failure f §18 names — fails this check with the file and the missing line.
 */
function checkRunnerGuardIsInstalled(): void {
  console.log('P2-S8 GATE — the exit-code guard is installed, not merely present (f §17, §18)');
  const GLOBAL_SETUP = 'tests/helpers/global-setup.ts';

  for (const [config, what] of [
    ['vitest.config.ts', 'the root configuration'],
    ['tests/fixtures/runner-exit-code/vitest.config.ts', "the canary's own configuration"],
  ] as const) {
    const raw = readIfPresent(config);
    if (raw === null) {
      fail('s8-runner-guard', `${config} is missing — ${what} is what installs the guard`);
      continue;
    }
    if (!new RegExp(`globalSetup:\\s*(\\[\\s*)?['"\`]${GLOBAL_SETUP}['"\`]`).test(stripTsProse(raw))) {
      fail('s8-runner-guard', `${config} does not set globalSetup to ${GLOBAL_SETUP} — ${what} no longer installs the exit-code guard (f §18)`);
    } else {
      ok(`${config} runs ${GLOBAL_SETUP}`);
    }
  }

  const setup = readIfPresent(GLOBAL_SETUP);
  const helper = readIfPresent('tests/helpers/exit-code.ts');
  if (setup === null || helper === null) {
    fail('s8-runner-guard', `${GLOBAL_SETUP} or tests/helpers/exit-code.ts is missing — no run in this repository can report failure reliably`);
    return;
  }
  if (!/export\s+function\s+protectFailingExitCode\s*\(/.test(helper)) {
    fail('s8-runner-guard', 'tests/helpers/exit-code.ts no longer exports protectFailingExitCode()');
  }
  const body = stripTsProse(setup);
  if (!/import\s*\{[^}]*\bprotectFailingExitCode\b[^}]*\}\s*from\s*['"]\.\/exit-code['"]/.test(body)) {
    fail('s8-runner-guard', `${GLOBAL_SETUP} does not import protectFailingExitCode from ./exit-code — the helper exists and nothing calls it (f §18)`);
    return;
  }
  // At MODULE scope, so it runs on import rather than when some function is
  // eventually called. A call nested inside `setup()` would run after Vitest
  // has already loaded the config — and the leading-margin test is how the
  // difference is read without a parser.
  if (!/^protectFailingExitCode\(\);/m.test(body)) {
    fail(
      's8-runner-guard',
      `${GLOBAL_SETUP} imports protectFailingExitCode but does not call it at module scope — an imported guard that is never invoked is not installed (f §18)`,
    );
  } else {
    ok(`${GLOBAL_SETUP} calls protectFailingExitCode() at module scope, so every run in this repository can report failure`);
  }
}

const STEPS: { name: string; cmd: string; args: string[]; env?: Record<string, string> }[] = [
  { name: 'migration manifest', cmd: npm, args: ['run', 'check:migrations'] },
  { name: 'static guards (G-1…G-6)', cmd: npm, args: ['run', 'check:guards'] },
  { name: 'supply-chain hygiene (§47, f §22)', cmd: npm, args: ['run', 'check:supply-chain'] },
  { name: 'P2-S7 gate (permanent predecessor, composes P2-S6…P2-S1 and Phase 1)', cmd: npm, args: ['run', 'gate:phase2:s7'] },
  {
    name: 'P2-S8 authority, isolation, planted-discrepancy, failure-injection, redaction and reconciliation suites',
    cmd: 'npx',
    args: ['vitest', 'run', ...P2_S8_TESTS],
  },
  /**
   * TIER 1, RUN HERE RATHER THAN READ FROM A FILE (f §5, §12, §23).
   *
   * The documentation has called Tier 1 a per-push measurement since it was
   * written, and until this step existed that sentence was false: nothing in
   * CI ran it, and the only Tier 1 number anyone had was produced on a
   * laptop. f §5 is explicit — "if the documentation calls Tier 1 'per-push',
   * CI must actually run it" — so it is a command this gate executes, and its
   * verdict is the suite's own exit status against the SAME six budget
   * ceilings Tier 2 uses. The dataset is smaller and the evidence file says
   * so; the ceilings are not lowered to fit it.
   *
   * It runs LAST because it is the longest step, and a structural violation
   * or a failing security suite should be reported in minutes rather than
   * behind a measurement.
   */
  {
    name: 'the six budgets at Tier 1, measured in this run (f §5, §12)',
    cmd: 'npx',
    args: ['vitest', 'run', 'tests/performance/accounting-budgets.test.ts'],
    env: { P2S8_PERF_TIER: '1' },
  },
];

/**
 * Before any test result in this run is treated as evidence: prove the test
 * runner can still report failure (f §3 — GREEN IS NOT EVIDENCE unless the
 * mechanism that reports green is itself proven capable of reporting red).
 *
 * `tests/integration/runner-exit-code.test.ts` asserts the same property, but
 * that assertion is circular where it matters most: a runner that cannot
 * report failure cannot report THAT failure either. So the check is made here
 * too, in a process that is not Vitest, from the exit status directly, and it
 * runs FIRST — nothing below it is trusted until it passes.
 */
function checkRunnerReportsFailure(): void {
  const config = 'tests/fixtures/runner-exit-code/vitest.config.ts';
  const res = spawnSync('npx', ['vitest', 'run', '--config', config, 'failing'], { cwd: ROOT, encoding: 'utf8', env: process.env });
  // The decision itself lives in `scripts/runner-canary.ts`, where
  // `tests/security/phase2-s8-gate-tamper.test.ts` can hand it the pair of
  // values a broken runner would produce and prove it refuses them (f §24).
  const refusal = canaryRefusal({ output: `${res.stdout ?? ''}${res.stderr ?? ''}`, status: res.status });
  if (refusal !== null) {
    fail('runner', refusal);
    return;
  }
  ok(`the test runner reports failure (canary exited ${res.status ?? 'on a signal'})`);
}

function runSteps(): void {
  console.log('P2-S8 GATE — composed regression matrix');
  // Only the canary's OWN verdict may stop the matrix here. Counting every
  // failure recorded so far would let an unrelated finding — a missed
  // performance budget, say — print the sentence "the test runner cannot
  // report failure", which would be false, and would hide the state of
  // every suite behind a claim about the runner.
  const beforeCanary = failures;
  checkRunnerReportsFailure();
  if (failures > beforeCanary) {
    console.error('\nP2-S8 GATE: FAIL — the test runner cannot report failure; refusing to run the regression matrix');
    process.exit(1);
  }
  for (const step of STEPS) {
    const started = Date.now();
    const res = spawnSync(step.cmd, [...step.args], { cwd: ROOT, encoding: 'utf8', stdio: 'inherit', env: { ...process.env, ...(step.env ?? {}) } });
    const ms = Date.now() - started;
    if (res.status !== 0) fail('regression', `${step.name} failed (exit ${res.status ?? 'signal'}) after ${ms}ms`);
    else ok(`${step.name} (${ms}ms)`);
  }
}

if (LIST_ONLY) {
  console.log('P2-S8 GATE plan:');
  console.log('  structural: frozenThrough unmoved at 0050; 0051 and 0052 present and NOT in the manifest; no 0053');
  console.log('  structural: 0052 alters exactly six named policies, replaces exactly three named helpers, and creates/grants/stores nothing');
  console.log('  structural: every table whose policy 0052 reshaped still carries the composite FK that equivalence stands on');
  console.log('  structural: 0051 creates one enumerator and no relation, index, column, role, password or policy drop');
  console.log('  structural: the enumerator is a hardened SECURITY DEFINER owned by the internal principal, PUBLIC revoked, keyset and clamped');
  console.log('  structural: column-level SELECT on exactly six tables, no write grant, no PII column, nothing granted to daftar_worker');
  console.log('  structural: 0051 asserts its own privilege model against the live catalogue before committing');
  console.log('  structural: the final app_bypass() exempts daftar_platform alone, and no migration grants BYPASSRLS');
  console.log('  structural: the reconciler role is LOGIN/NOSUPERUSER/NOBYPASSRLS/NOCREATEDB/NOCREATEROLE/NOREPLICATION, no TEMP, no CREATE on public');
  console.log('  structural: a dedicated module with no controllers, a pool with no fallback, a boot path that drains on SIGTERM');
  console.log("  structural: the reconciler process physically refuses every other process's secret, in every environment");
  console.log('  structural: the reconciliation path writes nothing, uses no OFFSET, probes its own authority and bounds each business');
  console.log('  structural: no bypass header, disable-constraint switch or test-only branch in production source');
  console.log('  structural: the intended privilege model is machine-readable and a suite compares it with the live catalogue');
  console.log('  structural: every behavioural claim has a suite, and the open findings are recorded as debt');
  console.log('  structural: vitest.config.ts installs the exit-code guard through globalSetup, and the guard is CALLED (f §17, §18)');
  console.log('  structural: nothing above reads release/ — this gate runs on a clean checkout (f §4 LEVEL A)');
  for (const s of STEPS) console.log(`  command:    ${s.cmd} ${s.args.join(' ')}`);
  process.exit(0);
}

checkMigrationBoundary();
checkMigrationContent();
checkRlsMigrationContent();
checkFkDependencyIsProtected();
checkBypassContract();
checkRoleAttributes();
checkProcessBoundary();
checkDetectNotRepair();
checkNoTestSeamInProduction();
checkPrivilegeModel();
checkClaimsHaveSuites();
checkRunnerGuardIsInstalled();

// `--structural-only`: every refusal above has been made, and nothing below
// would be a statement about this tree. It exists so f §24's tamper proofs
// can ask "does this refusal fire?" against a throwaway copy without also
// running a two-hour regression matrix inside a unit test.
if (STRUCTURAL_ONLY) {
  if (failures > 0) {
    console.error(`\nP2-S8 GATE: FAIL (${failures} structural violation${failures === 1 ? '' : 's'}) — structural checks only`);
    process.exit(1);
  }
  console.log('\nP2-S8 GATE: PASS (structural checks only)');
  process.exit(0);
}

if (failures > 0) {
  console.error(`\nP2-S8 GATE: FAIL (${failures} structural violation${failures === 1 ? '' : 's'}) — not running the regression matrix`);
  process.exit(1);
}

runSteps();

if (failures > 0) {
  console.error(`\nP2-S8 GATE: FAIL (${failures})`);
  process.exit(1);
}
console.log('\nP2-S8 GATE: PASS');
