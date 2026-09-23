#!/usr/bin/env tsx
/**
 * PHASE 2 SLICE GATE — P2-S6, accounting periods (directive §43).
 *
 * `npm run gate:phase2:s6` is the deterministic answer to "does the period
 * slice still do exactly what it was built to do?". P2-S5 gave a business its
 * own record of what a rate was; P2-S6 gives it the ability to say that a
 * stretch of time is CLOSED and to have the database refuse postings into it.
 *
 * That is a small feature with a large blast radius, and the ways to get it
 * wrong are specific:
 *
 *   — inventing a fiscal calendar, so that shipping the migration starts
 *     refusing postings for merchants who never asked for periods;
 *   — enforcing the closure in the application, so that the guarantee is a
 *     convention the next writer forgets;
 *   — letting a period be deleted, or its boundaries moved, so that "closed"
 *     is undoable without a trace;
 *   — folding `reopen` into `manage`, so that whoever may close the books may
 *     silently undo the close;
 *   — replaying an old reopen after a later close and reopening again;
 *   — a close and a posting that race into a closed period containing an
 *     entry committed after its own close.
 *
 * Every section below exists for one of those.
 *
 * P2-S6 is a CANDIDATE: `0049_accounting_periods.sql` is NOT frozen, no
 * `0050` exists, and this gate FAILS if either changes before the Tech Lead
 * accepts the slice. Once accepted, the candidate-era rules come out with the
 * candidacy — an accepted historical gate that forbids its successor is a
 * gate that stops the project.
 *
 * It COMPOSES rather than duplicates: P2-S5's gate runs unchanged, and it
 * composes P2-S4, P2-S3, P2-S2, P2-S1 and Phase 1 in turn, so the whole chain
 * runs from one command and nothing this slice adds can be paid for with a
 * regression in what came before.
 *
 * Usage: npm run gate:phase2:s6 [-- --list]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { findDefinerSearchPathViolations } from './guards/definer-search-path';
import { stripComments } from './guards/sql-schema';
import { INTENDED_TABLE_GRANTS, INTERNAL_ROLE, RUNTIME_ROLES, WRITE_PRIVILEGES } from './guards/journal-privilege-model';

const ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(ROOT, 'infrastructure/database/migrations');
const LIST_ONLY = process.argv.slice(2).includes('--list');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** The ONE migration this slice owns. A candidate, and the last file. */
const S6_MIGRATION = '0049_accounting_periods.sql';

/** The frozen boundary this slice starts from, exactly. */
const FROZEN_THROUGH = '0048_accounting_fx_rates.sql';

/** The two tables the slice owes (§11, §18). */
const S6_TABLES = ['accounting_periods', 'accounting_period_operations'] as const;

/** Every routine 0049 creates. Eleven, and no twelfth. */
const S6_ROUTINES = [
  'accounting_period_reason_digest',
  'accounting_period_canonical',
  'accounting_period_fingerprint',
  'accounting_period_topology_lock_key',
  'accounting_periods_no_delete',
  'accounting_periods_transition',
  'accounting_period_operations_immutable',
  'accounting_period_guard_posting',
  'accounting_period_create',
  'accounting_period_close',
  'accounting_period_reopen',
] as const;

/** The three merchant commands — the only period surface `daftar_app` may execute. */
const S6_COMMANDS = ['accounting_period_create', 'accounting_period_close', 'accounting_period_reopen'] as const;

/**
 * Surfaces P2-S6 explicitly DEFERRED (§8).
 *
 * A table created "for later" is scope creep with a comment on it. A trial
 * balance or a materialized balance in particular would be a reporting
 * promise the schema makes and this slice cannot keep, and a period-end
 * journal table would be the seam through which DAFTAR eventually posted
 * something nobody asked for.
 */
const OUT_OF_SCOPE_TABLES = [
  'accounting_balances',
  'accounting_trial_balance',
  'accounting_account_balances',
  'accounting_period_balances',
  'accounting_period_closings',
  'accounting_retained_earnings',
  'accounting_year_end_closings',
  'accounting_reconciliations',
  'accounting_fx_providers',
] as const;

/** The engine module P2-S6 adds to @daftar/accounting. */
const S6_MODULES = ['src/period.ts'] as const;

/** The suites that prove, against a real database, what the structure only claims. */
const P2_S6_TESTS = [
  'tests/integration/accounting-periods.test.ts',
  'tests/integration/accounting-periods-opening-balance.test.ts',
  'tests/integration/accounting-period-parity.test.ts',
  'tests/integration/accounting-periods-concurrency.test.ts',
  'tests/integration/accounting-periods-http.test.ts',
  'tests/integration/accounting-permissions.test.ts',
  'tests/security/journal-privilege-matrix.test.ts',
  'tests/integration/migration-upgrade.test.ts',
  'tests/integration/migration-portability.test.ts',
  'tests/integration/accounting-journal.test.ts',
  'tests/integration/process-composition.test.ts',
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
const s6Raw = (): string => readMigration(S6_MIGRATION);
const s6Sql = (): string => stripComments(s6Raw());

/**
 * The slice's SQL with its string literals blanked as well as its comments.
 *
 * Needed wherever a check looks for a forbidden IDENTIFIER: 0049's own error
 * sentences and COMMENT ON statements name the very things some rules forbid
 * — `accounting.period_closed` contains the word `period_closed`, and the
 * header explains at length why there is no fiscal calendar generator. A
 * guard that read those would fail on the sentence stating the rule it is
 * enforcing.
 */
const s6Code = (): string => s6Sql().replace(/'(?:[^']|'')*'/g, "''");

/** The body of one `CREATE [OR REPLACE] FUNCTION name(...)` in the slice's SQL. */
function routineBody(sql: string, name: string): string | null {
  const start = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${name}\\s*\\(`, 'i').exec(sql);
  if (start === null) return null;
  const rest = sql.slice(start.index);
  const open = rest.indexOf('$$');
  if (open === -1) return null;
  const close = rest.indexOf('$$', open + 2);
  return close === -1 ? rest.slice(open) : rest.slice(open, close);
}

/** Strip line and block comments from TypeScript source. */
const stripTsProse = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

/** The same, and string literals too, for rules about identifiers. */
const stripTsCode = (source: string): string =>
  stripTsProse(source)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');

/**
 * Every non-test application and script source file, path → contents.
 *
 * The slice gates themselves are excluded, and so are the static guards. A
 * gate's whole job is to NAME the things it forbids — `failpoint`,
 * `generateFiscal` — so a sweep that read them would fail on the line stating
 * the rule it is enforcing, and the only way to make it pass would be to stop
 * naming what is banned.
 */
function collectAppFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  const skip = new Set(['node_modules', 'dist', '.next', 'build', '.git', 'coverage', 'guards']);
  const selfReferential = /^scripts[\\/](phase\d-\w+-gate|phase2-s\d-gate|static-guards)\.ts$/;
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
  for (const dir of ['apps/api/src', 'packages/accounting/src', 'packages/shared-contracts/src', 'packages/domain-core/src', 'scripts']) {
    const full = join(ROOT, dir);
    if (existsSync(full)) walk(full);
  }
  return out;
}

const readIfPresent = (path: string): string | null => (existsSync(join(ROOT, path)) ? readFileSync(join(ROOT, path), 'utf8') : null);

// ── 1. The candidate boundary ──────────────────────────────────────────────
//
// 0049 exists, is UNFROZEN, is the last migration, and every frozen
// predecessor is still byte-identical. This section is the candidate-era one:
// it comes out when the Tech Lead accepts the slice and 0049 is frozen.
function checkMigrationBoundary(): void {
  console.log('P2-S6 GATE — the candidate boundary');
  const files = sqlFiles();

  if (files.includes(S6_MIGRATION)) ok(`${S6_MIGRATION} present`);
  else fail('s6-migration', `${S6_MIGRATION} is missing — P2-S6 is the slice that creates it (§8)`);

  // §8: exactly one new migration. Not two, and not a 0050 "while we are here".
  const beyond = files.filter((f) => f > S6_MIGRATION);
  if (beyond.length > 0) fail('scope', `migrations beyond ${S6_MIGRATION} exist: ${beyond.join(', ')} — P2-S6 creates exactly one, and no 0050 (§8)`);
  else ok(`${S6_MIGRATION} is the last migration — no 0050 exists (§8)`);

  const manifest = JSON.parse(readFileSync(join(ROOT, 'infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8')) as {
    frozenThrough: string;
    migrations: { name: string; sha256: string }[];
  };

  // §49: the candidate is NOT frozen. Freezing it is the Tech Lead's act, not
  // a step of the work, and a slice that froze its own migration would have
  // certified itself.
  if (manifest.frozenThrough !== FROZEN_THROUGH) {
    fail(
      'candidate',
      `frozenThrough is ${manifest.frozenThrough} — while P2-S6 is under review it must be exactly ${FROZEN_THROUGH}, because 0049 is a candidate (§49)`,
    );
  } else {
    ok(`frozenThrough = ${FROZEN_THROUGH} — the P2-S6 candidate is not frozen (§49)`);
  }
  if (manifest.migrations.some((m) => m.name === S6_MIGRATION)) {
    fail('candidate', `${S6_MIGRATION} is recorded in MIGRATION_MANIFEST.json — a candidate under review is not frozen history (§49)`);
  } else {
    ok(`${S6_MIGRATION} is absent from the manifest — it is a candidate (§49)`);
  }

  // Every frozen predecessor still hashes to what the manifest recorded. The
  // manifest check has its own script; this is the independent second read,
  // because a slice that edited history would otherwise only fail later.
  let drifted = 0;
  for (const m of manifest.migrations) {
    const path = join(MIGRATIONS_DIR, m.name);
    if (!existsSync(path)) {
      fail('frozen-history', `${m.name} is recorded frozen but is missing from the tree — frozen history may never be deleted`);
      drifted += 1;
      continue;
    }
    const onDisk = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (onDisk !== m.sha256) {
      fail('frozen-history', `${m.name} hashes to ${onDisk.slice(0, 12)}… but was frozen at ${m.sha256.slice(0, 12)}… — frozen bytes are immutable`);
      drifted += 1;
    }
  }
  if (drifted === 0) ok(`all ${manifest.migrations.length} frozen migrations are byte-for-byte what the manifest recorded`);

  if (files.includes(S6_MIGRATION)) {
    const digest = createHash('sha256')
      .update(readFileSync(join(MIGRATIONS_DIR, S6_MIGRATION)))
      .digest('hex');
    ok(`${S6_MIGRATION} candidate digest ${digest}`);
  }
}

// ── 2. The period's physical shape (§11, §12, §13, §15) ────────────────────
function checkPeriodShape(): void {
  console.log('P2-S6 GATE — the period');
  const sql = s6Sql();
  const code = s6Code();

  for (const table of S6_TABLES) {
    if (new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table}\\b`, 'i').test(sql)) ok(`${table} exists`);
    else fail('missing-surface', `${table} does not exist — P2-S6 is the slice that creates it (§11, §18)`);
  }
  for (const routine of S6_ROUTINES) {
    if (new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${routine}\\b`, 'i').test(sql)) ok(`${routine} exists`);
    else fail('missing-surface', `${routine} does not exist — the period commands are DB routines, not application logic (§23)`);
  }
  for (const table of OUT_OF_SCOPE_TABLES) {
    if (new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table}\\b`, 'i').test(code)) {
      fail('scope', `${table} is created by 0049 — P2-S6 builds periods and nothing else (§8)`);
    }
  }
  ok('0049 builds no balance table, no trial balance, no period-end journal and no reconciliation surface (§8)');

  // §11: the columns, by name. A period whose closure carried no actor, or
  // whose reopen carried no reason, would satisfy every behavioural test and
  // leave nothing to audit.
  for (const column of [
    'tenant_id',
    'business_id',
    'start_date',
    'end_date',
    'status',
    'created_by_user_id',
    'created_at',
    'closed_by_user_id',
    'closed_at',
    'last_reopened_by_user_id',
    'last_reopened_at',
    'last_reopen_reason',
  ]) {
    if (new RegExp(`\\b${column}\\b`).test(code)) ok(`accounting_periods.${column} is declared (§11)`);
    else fail('period-shape', `accounting_periods has no ${column} — §11 names it`);
  }

  // §11: DATE, not a timestamp. A period boundary that carried a time would
  // make "which period is 2026-03-31 in?" depend on a zone.
  if (/\bstart_date\s+DATE\b/i.test(code) && /\bend_date\s+DATE\b/i.test(code)) ok('the boundaries are civil DATEs, with no time and no zone (§11)');
  else fail('period-shape', 'start_date and end_date are not both DATE — a boundary with a time is a boundary that depends on a zone (§11)');

  // §11: exactly two statuses. An enum with room in it is an invitation.
  if (/status[^;]*CHECK\s*\([^)]*IN\s*\(\s*'open'\s*,\s*'closed'\s*\)/is.test(sql)) ok("the status vocabulary is exactly 'open' and 'closed' (§11)");
  else fail('period-shape', "accounting_periods.status does not CHECK (status IN ('open','closed')) — the vocabulary is closed (§11)");

  // §11: start_date <= end_date, and finite. `daterange` accepts infinity and
  // an infinite period would swallow every future posting date forever.
  if (/start_date\s*<=\s*end_date/i.test(sql)) ok('a period ends on or after it starts, physically (§11)');
  else fail('period-shape', 'no CHECK (start_date <= end_date) — §11 requires it in the schema, not in the service');
  if (/infinity/i.test(sql)) ok('an infinite boundary is refused by a CHECK — there is no period that covers all time (§11)');
  else fail('period-shape', "no constraint rejects 'infinity'::date — daterange accepts it, and an infinite period covers every future posting (§11)");

  // §11: composite ownership. A row must never claim tenant A while naming a
  // business tenant B owns.
  if (/FOREIGN\s+KEY\s*\(\s*tenant_id\s*,\s*business_id\s*\)\s*REFERENCES\s+businesses/i.test(sql)) ok('composite (tenant_id, business_id) ownership (§11)');
  else fail('period-shape', 'accounting_periods does not reference businesses (tenant_id, id) compositely — one component of a key is not an identity (§11)');

  // §12: a REAL exclusion constraint. This is the section's whole point: a
  // unique index cannot express "these two ranges overlap", and enforcing
  // non-overlap in the command would make it a convention the next writer
  // forgets. `daterange(..., '[]')` because both boundaries are inclusive.
  if (/EXCLUDE\s+USING\s+gist\s*\(\s*business_id\s+WITH\s*=\s*,\s*daterange\s*\(\s*start_date\s*,\s*end_date\s*,\s*'\[\]'\s*\)\s+WITH\s*&&/i.test(sql)) {
    ok('non-overlap is a gist EXCLUDE constraint on (business_id, daterange inclusive) — physical, not advisory (§12)');
  } else {
    fail(
      'period-shape',
      "accounting_periods has no gist EXCLUDE on (business_id =, daterange(start_date, end_date, '[]') &&) — §12 requires the physical constraint",
    );
  }

  // §12: the extension it needs is installed by the DEPLOYMENT administrator,
  // not by granting the migration principal the right to install C code.
  const bootstrap = readIfPresent('infrastructure/database/bootstrap.sql') ?? '';
  if (/CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+btree_gist/i.test(bootstrap))
    ok('btree_gist is installed once by bootstrap.sql, as the deployment administrator (§12)');
  else
    fail('extension', 'bootstrap.sql does not install btree_gist — the gist EXCLUDE on a UUID column needs it, and daftar_migrator may not install it (§12)');
  if (/GRANT\s+CREATE\s+ON\s+DATABASE[^;]*daftar_migrator/i.test(bootstrap)) {
    fail(
      'extension',
      'bootstrap.sql grants CREATE ON DATABASE to daftar_migrator — that is the right to install arbitrary C code, and §12 asks for the minimum (§12)',
    );
  } else {
    ok('daftar_migrator gained no CREATE ON DATABASE — the extension path added no privilege to the migration principal (§12)');
  }

  // §18: the operation registry binds command identity to its outcome.
  const registry = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?accounting_period_operations\b[\s\S]*?;\s*$/im.exec(sql)?.[0] ?? '';
  for (const column of ['operation_kind', 'period_id', 'payload_fingerprint', 'resulting_status', 'actor_user_id', 'created_at']) {
    if (new RegExp(`\\b${column}\\b`).test(registry)) ok(`accounting_period_operations.${column} is declared (§18)`);
    else fail('registry-shape', `the operation registry has no ${column} — §18 names it, and without it a replay cannot prove what it is replaying`);
  }
  if (/operation_kind[^,]*CHECK\s*\([^)]*period_create[\s\S]{0,80}period_close[\s\S]{0,80}period_reopen/i.test(registry)) {
    ok('the registry records exactly the three operation kinds (§18, §19)');
  } else {
    fail(
      'registry-shape',
      'accounting_period_operations.operation_kind does not CHECK the three kinds — a registry that accepts any kind proves nothing (§18)',
    );
  }
}

// ── 3. Immutability: no delete, no boundary move, no identity exemption ────
function checkImmutability(): void {
  console.log('P2-S6 GATE — immutability');
  const sql = s6Sql();

  // §15: there is no DELETE path. Not "nobody is granted DELETE" — a trigger,
  // because the table's OWNER holds rights no grant can revoke, and an ACL
  // refusal is evidence about the caller and never about the invariant.
  if (/CREATE\s+TRIGGER\s+\w+\s+BEFORE\s+DELETE\s+ON\s+accounting_periods\b/i.test(sql))
    ok('a BEFORE DELETE trigger refuses every deletion, owner included (§15)');
  else fail('immutability', 'accounting_periods has no BEFORE DELETE trigger — a grant cannot bind the owner, so "no DELETE path" needs a trigger (§15)');

  // §16: the transition trigger. Only open→closed and closed→open, and no
  // unrelated field may move under cover of a status change.
  const transition = routineBody(sql, 'accounting_periods_transition');
  if (transition === null) {
    fail('immutability', 'accounting_periods_transition does not exist — §16 requires the transition rule in the database');
  } else {
    for (const [what, re] of [
      ['the boundaries are immutable', /start_date|end_date/i],
      ['the identity is immutable', /\bOLD\.id\b|\bNEW\.id\b/i],
      ['a close carries its actor and instant', /closed_by_user_id[\s\S]*closed_at|closed_at[\s\S]*closed_by_user_id/i],
      [
        'a reopen carries its actor, instant and reason',
        /last_reopened_by_user_id[\s\S]*last_reopen_reason|last_reopen_reason[\s\S]*last_reopened_by_user_id/i,
      ],
    ] as const) {
      if (re.test(transition)) ok(`transition rule: ${what} (§16)`);
      else fail('immutability', `accounting_periods_transition does not enforce that ${what} (§16)`);
    }

    // §16, stated as sharply as it can be: NO IDENTITY EXEMPTION. A trigger
    // that let one role through would make every rule above a rule about
    // everyone except whoever holds that role.
    if (/\bcurrent_user\b|\bsession_user\b|\bpg_has_role\b/i.test(transition)) {
      fail('immutability', 'accounting_periods_transition branches on the CALLER — §16 admits no identity exemption, for any principal including the owner');
    } else {
      ok('the transition rule names no principal — there is no exemption for anybody (§16)');
    }
  }

  // §18: the registry is append-only, for the same reason and by the same means.
  if (/CREATE\s+TRIGGER\s+\w+\s+BEFORE\s+(UPDATE\s+OR\s+DELETE|DELETE\s+OR\s+UPDATE)\s+ON\s+accounting_period_operations\b/i.test(sql)) {
    ok('the operation registry is append-only through a trigger (§18)');
  } else {
    fail('immutability', 'accounting_period_operations has no BEFORE UPDATE OR DELETE trigger — a command record that can be rewritten proves nothing (§18)');
  }

  // §15: no generic PATCH. A route that accepted a partial period is a route
  // through which a boundary eventually moves.
  const controller = readIfPresent('apps/api/src/modules/accounting/accounting.controller.ts');
  if (controller === null) {
    fail('surface', 'apps/api/src/modules/accounting/accounting.controller.ts is missing');
  } else if (/@(Patch|Put)\(\s*['"`][^'"`]*periods/i.test(stripTsProse(controller))) {
    fail('surface', 'a PATCH or PUT route reaches a period — §15 allows only the three named transitions, never a generic update');
  } else {
    ok('no PATCH or PUT route reaches a period (§15)');
  }
}

// ── 4. Activation and the database-level posting refusal (§9, §23) ─────────
function checkActivationAndGuard(): void {
  console.log('P2-S6 GATE — activation and the posting refusal');
  const sql = s6Sql();
  const code = s6Code();

  // §23: the refusal is a TRIGGER ON journal_entries. Not a check in the
  // service, not a rule in the engine — those are conventions the next writer
  // forgets, and a direct INSERT would walk straight past them.
  if (/CREATE\s+TRIGGER\s+\w+\s+BEFORE\s+INSERT\s+ON\s+journal_entries\b/i.test(sql)) {
    ok('a BEFORE INSERT trigger on journal_entries refuses a closed-period posting (§23)');
  } else {
    fail('guard', 'no BEFORE INSERT trigger on journal_entries — §23 requires the refusal in the DATABASE, independent of Nest, TypeScript and HTTP');
  }

  const guard = routineBody(sql, 'accounting_period_guard_posting');
  if (guard === null) {
    fail('guard', 'accounting_period_guard_posting does not exist — §23 requires it');
  } else {
    // §9: zero periods preserve the existing behaviour exactly. This is the
    // activation model's whole safety property: shipping the migration must
    // not change one thing for a merchant who has no periods.
    // Either shape says the same thing: no period row for this business means
    // the guard hands the entry straight back. The `IS NULL` form is the one
    // 0049 uses, because the same read also yields the earliest boundary.
    if (/NOT\s+EXISTS|IF\s+NOT\s+\w+\s+THEN\s+RETURN\s+NEW|IF\s+\w+\s+IS\s+NULL\s+THEN\s*\n?\s*RETURN\s+NEW/i.test(guard))
      ok('with zero periods the guard returns NEW unchanged — shipping activates nothing (§9)');
    else
      fail('activation', 'the posting guard has no zero-period passthrough — §9 says existing posting-date rules continue until the FIRST period is created');

    for (const [code_, why] of [
      ['accounting.period_missing_for_date', 'a date outside every period is refused by name (§9, §23)'],
      ['accounting.period_closed', 'a date inside a closed period is refused by name (§9, §23)'],
    ] as const) {
      if (sql.includes(code_)) ok(why);
      else fail('guard', `the guard never raises ${code_} — §23 names it`);
    }

    // §25: lock order. The guard takes the business row BEFORE it reads a
    // period, which is the same order the commands take, and is what makes
    // close-versus-post a race with a determined winner rather than a deadlock.
    const business = guard.search(/FROM\s+businesses\b/i);
    const period = guard.search(/FROM\s+accounting_periods\b/i);
    if (business !== -1 && period !== -1 && business < period)
      ok('the guard locks the business BEFORE reading a period — one lock order on both paths (§25, §27)');
    else fail('guard', 'the posting guard reads a period before locking the business — two orders is a deadlock, not a race (§25)');

    // ── The opening-balance exception (correction §3, §6, §7, §10, §11) ────
    //
    // The rule this protects is not "an opening balance is special". It is
    // that an accounting fact must not change meaning with setup order: a
    // merchant who states their opening position AFTER defining their first
    // period must get the same answer as one who states it before. Three
    // separate things can silently destroy it, so three separate checks.
    //
    // 1. the exception exists at all, and binds BOTH the source and the date.
    const exception = /NEW\.source_type\s*=\s*'opening_balance'\s+AND\s+NEW\.entry_date\s*(<=?)\s*\w+/i.exec(guard);
    if (exception === null)
      fail(
        'opening-balance-exception',
        'the guard no longer lets an opening_balance predating the earliest period post — a historical opening position would be REFUSED purely because the merchant created a period first (correction §2, §3)',
      );
    else ok('an opening_balance dated before the earliest period start posts without a covering period (correction §3, §6)');

    // 2. it is STRICTLY before. `<=` would swallow the earliest start date,
    //    which belongs to the ordinary covering rule: on that date the period
    //    covers the entry, and a CLOSED period there must still refuse it.
    if (exception !== null && exception[1] === '<=')
      fail(
        'opening-balance-exception',
        'the opening-balance exception uses <= against the earliest start — the start date is COVERED, and a closed period beginning that day must still refuse (correction §3 case 3, §11)',
      );
    else if (exception !== null)
      ok('the exception is strictly BEFORE the earliest start, so the boundary date stays under the covering rule (correction §9 D)');

    // 3. it belongs to exactly ONE source. A second source LITERAL in this
    //    guard is the shape the bypass would take if it ever broadened. The
    //    test is on quoted literals, because the guard's own prose names the
    //    other sources in order to say they are excluded.
    const others = ["'manual_adjustment'", "'reversal'"].filter((k) => guard.includes(k));
    if (others.length === 0) ok('no other source carries a period exception — the guard names opening_balance alone (correction §10)');
    else
      fail(
        'opening-balance-exception',
        `the posting guard carries the source literal ${others.join(' and ')} — the pre-period exception is opening_balance ONLY, and a second source here is a generic backdating bypass (correction §10)`,
      );
  }

  // §9: no fiscal calendar, anywhere. Neither the migration nor the engine may
  // generate a period from a year, a quarter or a month; a helper that offered
  // to is the seam through which DAFTAR eventually guesses a merchant's books.
  if (/INSERT\s+INTO\s+accounting_periods/i.test(code)) {
    const inserts = code.match(/INSERT\s+INTO\s+accounting_periods/gi) ?? [];
    const inCommand = routineBody(sql, 'accounting_period_create')?.match(/INSERT\s+INTO\s+accounting_periods/gi) ?? [];
    if (inserts.length === inCommand.length && inCommand.length > 0)
      ok('the ONLY INSERT INTO accounting_periods in 0049 is inside the create command (§9, §28)');
    else
      fail(
        'activation',
        '0049 inserts a period outside accounting_period_create — a migration that creates periods is a migration that guessed a fiscal calendar (§9, §28)',
      );
  } else {
    fail('activation', 'no INSERT INTO accounting_periods anywhere in 0049 — the create command has to write the row');
  }
  for (const [file, source] of Object.entries(collectAppFiles())) {
    if (/\b(generateFiscal|fiscalCalendar|generatePeriods|autoCreatePeriods|periodsForYear|monthlyPeriods|quarterlyPeriods)\b/.test(stripTsCode(source))) {
      fail('activation', `${file} generates periods from a calendar — §9 forbids inventing a merchant's fiscal calendar`);
    }
  }
  ok('no fiscal-calendar generator exists in the application either (§9)');

  // §10: the universal no-future rule is NOT relaxed, and 0049 does not
  // replace the frozen P2-S3 writer that enforces it.
  if (/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+accounting_post_entry\b/i.test(sql)) {
    fail('scope', '0049 redefines accounting_post_entry — §10 says the frozen P2-S3 writer stays, and a period rule is not a reason to rewrite the poster');
  } else {
    ok('0049 does not redefine accounting_post_entry — the no-future rule stays where P2-S3 put it (§10)');
  }

  // §28: the migration rewrites no existing financial truth.
  for (const table of ['journal_entries', 'journal_lines', 'accounting_source_bindings', 'accounting_fx_rates', 'accounting_manual_adjustments']) {
    if (new RegExp(`(UPDATE|DELETE\\s+FROM)\\s+${table}\\b`, 'i').test(code)) {
      fail('scope', `0049 writes to ${table} — §28 forbids rewriting existing books, and the slice creates zero synthetic entries`);
    }
  }
  if (/UPDATE\s+businesses\s+SET[^;]*financial_started_at/i.test(code)) {
    fail('scope', "0049 sets financial_started_at — §28 says no business's financial life begins because periods shipped");
  }
  ok('0049 rewrites no journal, no binding, no rate snapshot and no financial start (§28)');
}

// ── 5. Authority: two permissions, one protocol, no widening (§19, §21, §22, §35) ──
function checkAuthority(): void {
  console.log('P2-S6 GATE — authority');
  const sql = s6Sql();
  const code = s6Code();

  // §21: exactly two permission keys, both SENSITIVE, and reopen is NOT
  // implied by manage.
  const permissions = readIfPresent('packages/domain-core/src/permissions.ts');
  if (permissions === null) {
    fail('permissions', 'packages/domain-core/src/permissions.ts is missing');
  } else {
    for (const key of ['accounting.period.manage', 'accounting.period.reopen']) {
      if (permissions.includes(`'${key}'`)) ok(`${key} is registered (§21)`);
      else fail('permissions', `${key} is not registered — §21 names exactly these two keys`);
    }
    const sensitive = /SENSITIVE_PERMISSIONS[\s\S]*?\]/.exec(permissions)?.[0] ?? '';
    for (const key of ['accounting.period.manage', 'accounting.period.reopen']) {
      if (sensitive.includes(`'${key}'`)) ok(`${key} is SENSITIVE (§21)`);
      else fail('permissions', `${key} is not in SENSITIVE_PERMISSIONS — §21 says both are sensitive`);
    }
    // §21: no third key, and no built-in accountant role.
    const invented = [...permissions.matchAll(/'accounting\.period\.[a-z.]+'/g)].map((m) => m[0]);
    const unique = new Set(invented);
    if (unique.size > 2) fail('permissions', `more than two period permissions exist: ${[...unique].join(', ')} — §21 registers exactly two`);
    else ok('exactly two period permissions exist — no third key was invented (§21)');
    if (/\baccountant\b/i.test(stripTsCode(permissions)))
      fail('permissions', 'a built-in accountant role appears in permissions.ts — C-12 still forbids one (§21)');
    else ok('no built-in accountant role was created (§21, C-12)');
  }

  // §19: ONE control protocol. P2-S6 extends `acctctl/1` with three kinds and
  // invents no third assertion format — a second protocol over one signing
  // secret is separated by disjoint preimages, and a third would be a third
  // place for that reasoning to be wrong.
  const assertion = readIfPresent('packages/accounting/src/control-assertion.ts');
  if (assertion === null) {
    fail('assertion', 'packages/accounting/src/control-assertion.ts is missing');
  } else {
    const stripped = stripTsProse(assertion);
    for (const kind of ['period_create', 'period_close', 'period_reopen']) {
      if (stripped.includes(`'${kind}'`)) ok(`acctctl/1 carries the ${kind} command kind (§19)`);
      else fail('assertion', `acctctl/1 does not carry ${kind} — §19 extends the EXISTING protocol with exactly these three kinds`);
    }
    if (/'acctctl\/[2-9]'|ACCTCTL2|acctctl2/.test(stripped))
      fail('assertion', 'a second control-assertion version appears — §19 forbids a third assertion protocol');
    else ok('no new assertion protocol was invented — acctctl/1 was extended (§19)');
  }
  // §19: the DATABASE verifies the assertion; it never trusts a GUC tenant,
  // a GUC business, or a client's claim about who the actor is.
  for (const command of S6_COMMANDS) {
    const body = routineBody(sql, command);
    if (body === null) {
      fail('assertion', `${command} does not exist`);
      continue;
    }
    if (/accounting_control_actor/i.test(body)) ok(`${command} resolves its actor through the verified assertion (§19)`);
    else fail('assertion', `${command} does not call accounting_control_actor — §19 says the database verifies the assertion, never a GUC or a client claim`);
  }

  // §22: a period governs every branch, so managing one requires business-wide
  // authority. Reads may follow accounting.view.
  const service = readIfPresent('apps/api/src/modules/accounting/accounting-periods.service.ts');
  if (service === null) {
    fail('surface', 'apps/api/src/modules/accounting/accounting-periods.service.ts is missing');
  } else if (/branchScopeMode\s*!==\s*'all'/.test(service)) {
    ok('a period mutation requires branch_scope_mode = all (§22)');
  } else {
    fail('authority', 'the period service does not require branch_scope_mode = all — a period governs every branch (§22)');
  }

  // §35: RLS enabled AND forced on both tables. Forced matters because the
  // owner is a DAFTAR principal, and an owner is otherwise exempt from its
  // own policies.
  for (const table of S6_TABLES) {
    if (new RegExp(`ALTER\\s+TABLE\\s+${table}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i').test(sql)) ok(`${table}: RLS enabled (§35)`);
    else fail('rls', `${table} does not ENABLE ROW LEVEL SECURITY (§35)`);
    if (new RegExp(`ALTER\\s+TABLE\\s+${table}\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i').test(sql)) ok(`${table}: RLS forced (§35)`);
    else fail('rls', `${table} does not FORCE ROW LEVEL SECURITY — the owner would be exempt from its own policies (§35)`);
  }

  // §35: no BYPASSRLS anywhere, and app_bypass() is not widened.
  // Asked as "does 0049 CONFER it?", not "does 0049 say the word?". The
  // migration's own final verification block refuses to commit if any DAFTAR
  // role holds BYPASSRLS, and a guard that read that sentence would fail on
  // the statement enforcing the rule.
  if (/(CREATE|ALTER)\s+ROLE[^;]*\bBYPASSRLS\b/i.test(code)) fail('rls', '0049 confers BYPASSRLS on a role — §35 forbids it for every DAFTAR role');
  else ok('0049 confers BYPASSRLS on nobody (§35)');
  if (/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+app_bypass\b/i.test(sql)) fail('rls', '0049 redefines app_bypass() — §35 forbids widening the bypass');
  else ok('0049 does not redefine app_bypass() (§35)');

  // §35: the intended grant model carries the two new tables, and no runtime
  // role is a writer on either. The live-catalogue comparison is G-1's job;
  // this is the model's own consistency check, so a table added to the
  // database and forgotten here fails before CI reaches a database.
  for (const table of S6_TABLES) {
    const intended = INTENDED_TABLE_GRANTS[table];
    if (intended === undefined) {
      fail('grants', `${table} is not in the intended grant model — an unmodelled table is a table G-1 cannot police (§35)`);
      continue;
    }
    for (const role of RUNTIME_ROLES) {
      const held = intended[role] ?? [];
      const writes = held.filter((p) => (WRITE_PRIVILEGES as readonly string[]).includes(p));
      if (writes.length > 0) fail('grants', `${role} holds ${writes.join(', ')} on ${table} — no runtime credential writes a period (§35)`);
    }
    if ((intended[INTERNAL_ROLE] ?? []).includes('DELETE')) {
      fail('grants', `${INTERNAL_ROLE} holds DELETE on ${table} — §15 says a period is never deleted and §18 says the registry is append-only`);
    }
    ok(`${table}: no runtime writer, and no DELETE for anybody (§35)`);
  }
  // §35: the three commands are the only period surface `daftar_app` executes.
  for (const command of S6_COMMANDS) {
    if (new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+${command}[^;]*daftar_app`, 'i').test(sql)) ok(`${command} is executable by daftar_app (§35)`);
    else fail('grants', `${command} is not granted to daftar_app — the merchant runtime has to be able to ASK`);
  }
  if (/REVOKE\s+ALL\s+ON\s+FUNCTION[^;]*FROM\s+PUBLIC/i.test(sql)) ok('0049 revokes PUBLIC EXECUTE on its routines (§35)');
  else fail('grants', '0049 does not REVOKE ALL ... FROM PUBLIC on its routines — PUBLIC executes an ungranted function by default (§35)');

  // §35: G-5 across the whole tree, including these new definers.
  const migrations: Record<string, string> = {};
  for (const name of sqlFiles()) migrations[name] = readMigration(name);
  const manifest = JSON.parse(readFileSync(join(ROOT, 'infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8')) as { migrations: { name: string }[] };
  const g5 = findDefinerSearchPathViolations({
    migrations,
    bootstrap: readFileSync(join(ROOT, 'infrastructure/database/bootstrap.sql'), 'utf8'),
    frozen: new Set(manifest.migrations.map((m) => m.name)),
  });
  if (g5.length > 0) for (const detail of g5) fail('guard-g5', detail);
  else ok('G-5 clean: every SECURITY DEFINER routine pins its path with pg_temp named LAST (§35)');
}

// ── 6. Idempotency, conflict and serialization (§14, §18, §25, §27) ────────
function checkIdempotencyAndLocks(): void {
  console.log('P2-S6 GATE — idempotency and serialization');
  const sql = s6Sql();

  for (const command of S6_COMMANDS) {
    const body = routineBody(sql, command);
    if (body === null) {
      fail('idempotency', `${command} does not exist`);
      continue;
    }

    // §18: the registry answers a replay. A command that decided from the
    // period's CURRENT STATE instead would reopen a re-closed period when an
    // old reopen was replayed — the hazard §18 names by name.
    const registry = body.search(/\baccounting_period_operations\b/i);
    if (registry === -1) {
      fail('idempotency', `${command} never consults accounting_period_operations — §18 requires durable command identity`);
      continue;
    }
    const state = body.search(/FROM\s+accounting_periods\b/i);
    if (state !== -1 && state < registry) {
      fail(
        'idempotency',
        `${command} inspects the period's state BEFORE the operation registry — §18's replayed-reopen hazard is answerable only if the registry decides first`,
      );
    } else {
      ok(`${command} consults the operation registry before inspecting any state (§18)`);
    }

    // §18: a key reused with a different payload is a named refusal, never a
    // raw unique violation the caller has to interpret.
    if (/accounting\.idempotency_conflict/.test(body)) ok(`${command} refuses a reused key with a different payload by name (§18)`);
    else fail('idempotency', `${command} never raises accounting.idempotency_conflict — §18 forbids surfacing a raw unique violation`);

    // §14, §25: one advisory lock per BUSINESS, then the business row, then
    // the period. The same order in all three commands and in the posting
    // guard is what makes a close and a posting a race rather than a deadlock.
    if (/accounting_period_topology_lock_key/i.test(body)) ok(`${command} serializes on the per-business topology lock (§14)`);
    else fail('locks', `${command} does not take the per-business topology lock — §14 requires serialization per business`);

    // Read as `FROM <table>`, so a `%ROWTYPE` declaration at the top of the
    // routine is not mistaken for a lock. The DECLARE block names the period
    // type first in every one of these commands, and it takes no lock at all.
    const business = body.search(/FROM\s+businesses\b/i);
    const period = body.search(/FROM\s+accounting_periods\b/i);
    if (business !== -1 && period !== -1 && business < period) ok(`${command} locks the business before the period (§25)`);
    else fail('locks', `${command} reaches a period before the business row — one lock order, on every path (§25)`);
  }

  // §14: no GLOBAL accounting lock. A single key for every business would turn
  // every merchant's period management into one queue.
  const keyFn = routineBody(sql, 'accounting_period_topology_lock_key');
  if (keyFn === null) fail('locks', 'accounting_period_topology_lock_key does not exist');
  else if (/p_business/i.test(keyFn)) ok('the topology lock key is derived from the BUSINESS — no global accounting lock (§14)');
  else fail('locks', 'the topology lock key does not depend on the business — §14 forbids a global lock');

  // §37: the exclusion constraint's NAME never reaches a caller. A merchant
  // reading "accounting_periods_no_overlap" is reading the schema.
  const create = routineBody(sql, 'accounting_period_create');
  if (create === null) {
    fail('idempotency', 'accounting_period_create does not exist');
  } else if (/exclusion_violation/i.test(create) && /accounting\.period_overlap/.test(create)) {
    ok('an exclusion violation is translated into accounting.period_overlap — no constraint name leaks (§37)');
  } else {
    fail('locks', 'accounting_period_create does not catch exclusion_violation and re-raise accounting.period_overlap — §37 forbids leaking a constraint name');
  }

  // §13: contiguity is REFUSED, never inferred and never silently merged.
  if (/accounting\.period_not_contiguous/.test(sql)) ok('a gap is refused by name — no inference, no silent merge (§13)');
  else fail('contiguity', 'nothing raises accounting.period_not_contiguous — §13 refuses a gap rather than filling it');
}

// ── 7. The reopen reason (§17, §33, §34) ───────────────────────────────────
function checkReopenReason(): void {
  console.log('P2-S6 GATE — the reopen reason');
  const sql = s6Sql();

  const reopen = routineBody(sql, 'accounting_period_reopen');
  if (reopen === null) {
    fail('reason', 'accounting_period_reopen does not exist');
  } else {
    if (/accounting\.period_reopen_reason_required/.test(reopen)) ok('a blank or absent reason is refused by name (§17)');
    else fail('reason', 'accounting_period_reopen never raises accounting.period_reopen_reason_required — §17 makes the reason REQUIRED');
    if (/btrim\s*\(/i.test(reopen)) ok('the reason is trimmed before it is judged (§17)');
    else fail('reason', 'accounting_period_reopen does not trim the reason — a reason of spaces is not a reason (§17)');
  }

  // §17: the bounds, physically, on the column itself.
  if (/last_reopen_reason[\s\S]{0,400}?BETWEEN\s+1\s+AND\s+500|length\s*\(\s*last_reopen_reason\s*\)[\s\S]{0,80}500/i.test(sql)) {
    ok('the reason is bounded to 1–500 characters by a CHECK (§17)');
  } else {
    fail('reason', 'no CHECK bounds last_reopen_reason to 1–500 characters — §17 states the bounds');
  }

  // §34, the sharp one: the free-text reason must NOT enter the outbox. An
  // outbox event crosses a trust boundary, and a merchant's sentence about why
  // they reopened their books is not something to publish.
  if (reopen !== null) {
    const outbox = /INSERT\s+INTO\s+outbox_events[\s\S]*?;/i.exec(reopen)?.[0] ?? '';
    if (outbox === '') {
      fail('outbox', 'accounting_period_reopen publishes no outbox event — §34 requires exactly one');
    } else if (/last_reopen_reason|v_reason\b|p_reason\b/i.test(outbox)) {
      fail('outbox', 'the reopen outbox event carries the free-text reason — §34 forbids it, and the audit trail is where the reason belongs');
    } else {
      ok('the reopen outbox event carries no free-text reason (§34)');
    }
    const audit = /INSERT\s+INTO\s+audit_events[\s\S]*?;/i.exec(reopen)?.[0] ?? '';
    if (/last_reopen_reason|v_reason\b|p_reason\b/i.test(audit)) ok('the reopen AUDIT event carries the reason (§33)');
    else fail('audit', 'the reopen audit event does not carry the reason — §33 requires it there');
  }
}

// ── 8. Audit, outbox and their atomicity (§33, §34, §41) ───────────────────
function checkAuditAndOutbox(): void {
  console.log('P2-S6 GATE — audit and outbox');
  const sql = s6Sql();
  const code = s6Code();

  for (const command of S6_COMMANDS) {
    const body = routineBody(sql, command);
    if (body === null) continue;
    const audits = (body.match(/INSERT\s+INTO\s+audit_events/gi) ?? []).length;
    const outboxes = (body.match(/INSERT\s+INTO\s+outbox_events/gi) ?? []).length;
    if (audits === 1) ok(`${command} writes exactly one audit event (§33)`);
    else fail('audit', `${command} writes ${audits} audit events — §33 requires exactly one per created state change`);
    if (outboxes === 1) ok(`${command} publishes exactly one outbox event (§34)`);
    else fail('outbox', `${command} publishes ${outboxes} outbox events — §34 requires exactly one`);
  }

  // §33, §34: both are written INSIDE the command's transaction, so a failure
  // of either rolls the whole thing back. There is no BEGIN/COMMIT inside the
  // routines, which is what makes that automatic — and it is the reason a
  // transactional failure injection can prove it.
  if (/\bCOMMIT\b\s*;/i.test(code))
    fail('atomicity', '0049 commits inside a routine — §33 and §34 require the audit and the outbox to roll back with the command');
  else ok('no routine commits its own transaction — an audit or outbox failure rolls everything back (§33, §34)');

  // §34: the outbox carries identifiers, dates, state and safe labels. Never
  // an assertion, never authorization context.
  for (const command of S6_COMMANDS) {
    const body = routineBody(sql, command);
    if (body === null) continue;
    const outbox = /INSERT\s+INTO\s+outbox_events[\s\S]*?;/i.exec(body)?.[0] ?? '';
    if (/assertion|payload_fingerprint|p_assertion|accounting_control_assertion/i.test(outbox)) {
      fail('outbox', `${command}'s outbox event carries an assertion or a fingerprint — §34 lists what may go out, and neither is on it`);
    }
  }
  ok('no outbox event carries an assertion, a fingerprint or raw authorization context (§34)');

  // §41: no production failpoint. A hook that let a test make the audit fail
  // is a hook an operator can pull.
  for (const [file, source] of Object.entries(collectAppFiles())) {
    if (/\b(failpoint|failPoint|FAILPOINT|__forceAuditFailure|injectFailure)\b/.test(stripTsCode(source))) {
      fail('failpoint', `${file} carries a failure-injection hook — §41 forbids a production failpoint`);
    }
  }
  if (/failpoint/i.test(code)) fail('failpoint', '0049 carries a failure-injection hook — §41 forbids a production failpoint');
  ok('no production failure-injection hook exists — §41 is satisfied by transactional injection in the tests');
}

// ── 9. One specification, two implementations (§20) ────────────────────────
function checkCanonicalization(): void {
  console.log('P2-S6 GATE — acctperiod/1');

  for (const module of S6_MODULES) {
    if (existsSync(join(ROOT, 'packages/accounting', module))) ok(`@daftar/accounting ${module} exists`);
    else fail('missing-surface', `packages/accounting/${module} is missing — §20 needs the TypeScript half of the fingerprint`);
  }

  const period = readIfPresent('packages/accounting/src/period.ts');
  if (period === null) {
    fail('canonical', 'packages/accounting/src/period.ts is missing');
  } else {
    const stripped = stripTsCode(period);
    // §20: a deterministic stream, never JSON.stringify — key order is an
    // implementation detail of one language and a fingerprint may not depend
    // on it.
    if (/JSON\.stringify/.test(stripped)) fail('canonical', 'period.ts uses JSON.stringify to canonicalize — §20 requires a deterministic stream');
    else ok('the canonical stream is built explicitly, not by JSON.stringify (§20)');
    // §20: the reason enters the fingerprint as a DIGEST, and the reason
    // identity contract is defined, not assumed.
    if (/periodReasonDigest/.test(stripped)) ok('the reopen reason has a defined digest contract (§20)');
    else fail('canonical', 'period.ts defines no reason digest — §20 requires the exact normalization and SHA-256 contract');
    // §9: no calendar generator in the engine either.
    if (/\b(fromYear|fromQuarter|fromMonth|calendarFor)\b/.test(stripped))
      fail('activation', 'period.ts generates periods from a calendar unit — §9 forbids it');
  }

  // §20: ONE vector file, read by BOTH halves. Without shared vectors the two
  // implementations drift and nothing notices until a merchant is refused.
  const vectors = join(ROOT, 'packages/accounting/vectors/acctperiod-vectors.json');
  if (!existsSync(vectors)) {
    fail('canonical', 'packages/accounting/vectors/acctperiod-vectors.json is missing — §20 requires shared vectors');
  } else {
    const parsed = JSON.parse(readFileSync(vectors, 'utf8')) as { spec?: string; cases?: unknown[] };
    if (parsed.spec !== 'acctperiod/1') fail('canonical', `the vector file declares spec ${String(parsed.spec)} — §20 names acctperiod/1`);
    else if ((parsed.cases ?? []).length < 8)
      fail('canonical', `the vector file carries ${(parsed.cases ?? []).length} cases — §20's interesting cases are more than that`);
    else ok(`acctperiod/1 vectors: ${(parsed.cases ?? []).length} cases, shared by both implementations (§20)`);
  }

  // §20: the PostgreSQL half exists and is IMMUTABLE, so the same inputs give
  // the same bytes on both sides forever.
  const sql = s6Sql();
  for (const routine of ['accounting_period_canonical', 'accounting_period_fingerprint', 'accounting_period_reason_digest']) {
    if (new RegExp(`FUNCTION\\s+${routine}[\\s\\S]{0,400}?IMMUTABLE`, 'i').test(sql)) ok(`${routine} is IMMUTABLE (§20)`);
    else fail('canonical', `${routine} is not declared IMMUTABLE — a canonicalizer that may vary is not a canonicalizer (§20)`);
  }
}

// ── 10. The merchant surface (§29-§32) ─────────────────────────────────────
function checkSurface(): void {
  console.log('P2-S6 GATE — the merchant surface');

  const controller = readIfPresent('apps/api/src/modules/accounting/accounting.controller.ts');
  if (controller === null) {
    fail('surface', 'apps/api/src/modules/accounting/accounting.controller.ts is missing');
    return;
  }
  const stripped = stripTsProse(controller);

  for (const [route, why] of [
    [/@Post\(\s*['"`]periods['"`]\s*\)/, 'POST .../accounting/periods (§29)'],
    [/@Post\(\s*['"`]periods\/:periodId\/close['"`]\s*\)/, 'POST .../periods/:periodId/close (§30)'],
    [/@Post\(\s*['"`]periods\/:periodId\/reopen['"`]\s*\)/, 'POST .../periods/:periodId/reopen (§31)'],
    [/@Get\(\s*['"`]periods['"`]\s*\)/, 'GET .../accounting/periods (§32)'],
  ] as const) {
    if (route.test(stripped)) ok(`route present: ${why}`);
    else fail('surface', `route missing: ${why}`);
  }

  /**
   * The decorators between a route and its handler — which is where the
   * permission is declared. Read as a SLICE rather than by matching the whole
   * method, because a handler's length is not something a guard should depend
   * on: a route that grew two parameters would otherwise silently stop being
   * checked.
   */
  const decoratorsOf = (route: string): string => {
    const at = stripped.indexOf(route);
    if (at === -1) return '';
    const handler = stripped.indexOf('async ', at);
    return handler === -1 ? '' : stripped.slice(at, handler);
  };

  // §21: the reopen route demands the reopen key, and NOT the manage key. The
  // negative half is the one that matters — a route that accepted either
  // would make the second permission decorative.
  const reopenRoute = decoratorsOf("@Post('periods/:periodId/reopen')");
  if (/accounting\.period\.reopen/.test(reopenRoute)) ok('the reopen route requires accounting.period.reopen (§21)');
  else fail('surface', 'the reopen route does not require accounting.period.reopen — §21 says manage does not imply reopen');
  if (/accounting\.period\.manage/.test(reopenRoute)) fail('surface', 'the reopen route accepts accounting.period.manage — §21 says the two keys are separate');

  // §21: and create and close demand `manage`, not `reopen`.
  for (const route of ["@Post('periods')", "@Post('periods/:periodId/close')"]) {
    const declared = decoratorsOf(route);
    if (declared === '') {
      fail('surface', `${route} has no decorators — the permission has to be declared on the route`);
      continue;
    }
    if (/accounting\.period\.manage/.test(declared)) ok(`${route} requires accounting.period.manage (§21)`);
    else fail('surface', `${route} does not require accounting.period.manage (§21)`);
    if (/accounting\.period\.reopen/.test(declared))
      fail('surface', `${route} accepts accounting.period.reopen — §21 says reopen undoes a close and does nothing else`);
  }

  // §32: reading is accounting.view, because reading never corrupts a ledger.
  const listRoute = decoratorsOf("@Get('periods')");
  if (/accounting\.view/.test(listRoute)) ok('the list route requires accounting.view (§32)');
  else fail('surface', 'the list route does not require accounting.view (§32)');

  // §18: every mutation takes an Idempotency-Key, the close and the reopen
  // included. A close without one cannot answer a retried request.
  const keyed = (stripped.match(/requireIdempotencyKey/g) ?? []).length;
  if (keyed >= 3) ok(`the three period mutations demand an Idempotency-Key (§18)`);
  else fail('surface', `only ${keyed} routes demand an Idempotency-Key — §18 requires one on create, close and reopen`);

  // §32: the list is an OBJECT with `items`. A bare array cannot grow a field
  // without breaking every client, and DAFTAR's contracts do not do that.
  const contracts = readIfPresent('packages/shared-contracts/src/index.ts') ?? '';
  if (/AccountingPeriodListDto\s*\{[^}]*items/s.test(contracts)) ok('the period list is an object with items, never a bare array (§32)');
  else fail('surface', 'AccountingPeriodListDto is not an object with `items` — §32 forbids a bare array');

  // §32: the list exposes no assertion, no operation id and no audit internal.
  const adapter = readIfPresent('apps/api/src/modules/accounting/accounting-periods.adapter.ts') ?? '';
  const listQuery = /listPeriods[\s\S]*?\}\s*$/.exec(adapter)?.[0] ?? adapter;
  for (const leak of ['payload_fingerprint', 'operation_id', 'accounting_period_operations']) {
    if (listQuery.includes(leak)) fail('surface', `the period list reads ${leak} — §32 exposes no operation id and no audit internal`);
  }
  ok('the period list exposes no assertion, no operation id and no audit internal (§32)');

  // §29-§31: the payload is strict. An unknown key is a refusal, not a field
  // the server silently drops.
  const schemas = readIfPresent('apps/api/src/modules/accounting/accounting.schemas.ts') ?? '';
  const periodSchemas = [...schemas.matchAll(/AccountingPeriod\w+Schema[\s\S]{0,600}?;/g)].map((m) => m[0]);
  if (periodSchemas.length >= 2 && periodSchemas.every((s) => /\.strict\(\)/.test(s))) ok('every period payload schema is strict (§29-§31)');
  else fail('surface', 'a period payload schema is not .strict() — an unknown key must be refused, not dropped (§29-§31)');
}

// ── 11. The behavioural regressions this slice may never lose (§48) ────────
const REQUIRED_BEHAVIOUR: ReadonlyArray<{ file: string; needle: RegExp; what: string }> = [
  {
    file: 'tests/integration/accounting-periods.test.ts',
    needle: /count\(\*\)[\s\S]{0,200}accounting_periods/i,
    what: 'the migration created NO period anywhere in a database that has real books (§9, §28)',
  },
  {
    file: 'tests/integration/accounting-periods.test.ts',
    needle: /period_missing_for_date/,
    what: 'a posting outside every period is refused once periods exist (§9, §23)',
  },
  {
    file: 'tests/integration/accounting-periods.test.ts',
    needle: /period_closed/,
    what: 'a posting into a closed period is refused (§23, §38)',
  },
  {
    file: 'tests/integration/accounting-periods.test.ts',
    needle: /entry_date_in_future/,
    what: 'the universal no-future rule still holds inside an open period, in a real IANA zone (§10, §39)',
  },
  {
    file: 'tests/integration/accounting-periods-concurrency.test.ts',
    needle: /deadlock/i,
    what: 'a close interleaved with a posting never deadlocks (§25)',
  },
  // The correction's own regressions. A regex over 0049 can say the exception
  // is written; only these can say it WORKS, which is why §28 asks for both.
  {
    file: 'tests/integration/accounting-periods-opening-balance.test.ts',
    needle: /FLOW 1[\s\S]{0,4000}FLOW 2/,
    what: 'the same opening balance is accepted whether the first period was created before or after it (correction §8)',
  },
  {
    file: 'tests/integration/accounting-periods-opening-balance.test.ts',
    needle: /inside a CLOSED period[\s\S]{0,600}period_closed/,
    what: 'an opening balance inside a CLOSED period is still refused (correction §11)',
  },
  {
    file: 'tests/integration/accounting-periods-opening-balance.test.ts',
    needle: /manual adjustment[\s\S]{0,600}period_missing_for_date/,
    what: 'a manual adjustment before the earliest period gains nothing from the exception (correction §10)',
  },
  {
    file: 'tests/integration/accounting-periods-opening-balance.test.ts',
    needle: /REVERSAL[\s\S]{0,1600}period_missing_for_date/,
    what: 'a reversal outside period coverage is still refused (correction §10)',
  },
  {
    file: 'tests/integration/accounting-periods-concurrency.test.ts',
    needle: /openBalanceOn[\s\S]{0,8000}the OPENING BALANCE wins the business row/,
    what: 'the opening balance and the first period race to the same books in BOTH winner orders (correction §12)',
  },
  {
    file: 'tests/integration/accounting-periods-concurrency.test.ts',
    needle: /outbox_events/,
    what: 'an outbox failure rolls the whole command back, injected transactionally (§34, §41)',
  },
  {
    file: 'tests/integration/accounting-periods-concurrency.test.ts',
    needle: /audit_events/,
    what: 'an audit failure rolls the whole command back, injected transactionally (§33, §41)',
  },
  {
    file: 'tests/integration/accounting-periods.test.ts',
    needle: /accounting_periods_no_overlap|period_overlap/,
    what: 'the non-overlap matrix, refused by the domain sentence rather than by a constraint name (§37)',
  },
  {
    file: 'tests/integration/accounting-periods-http.test.ts',
    needle: /accounting\.period\.manage/,
    what: 'a manage-only member may close and is REFUSED a reopen (§21)',
  },
  {
    file: 'tests/integration/accounting-periods-http.test.ts',
    needle: /branch-scope/,
    what: 'a branch-scoped member may not manage a period and may still read one (§22)',
  },
  {
    file: 'tests/integration/accounting-period-parity.test.ts',
    needle: /accounting_period_canonical/,
    what: 'TypeScript and PostgreSQL agree on acctperiod/1 byte for byte (§20)',
  },
  {
    file: 'tests/integration/migration-portability.test.ts',
    needle: /0049_accounting_periods\.sql/,
    what: '0049 applies under a NOSUPERUSER, NOBYPASSRLS migration principal (§42)',
  },
  {
    file: 'tests/integration/migration-upgrade.test.ts',
    needle: /0049_accounting_periods\.sql/,
    what: '0048 → 0049 upgrades an existing deployment without rewriting its books (§28, §42)',
  },
];

function checkBehaviouralRegressions(): void {
  console.log('P2-S6 GATE — the behavioural regressions');
  for (const { file, needle, what } of REQUIRED_BEHAVIOUR) {
    const path = join(ROOT, file);
    if (!existsSync(path)) {
      fail('regression-proof', `${file} is missing — it carries the proof of ${what}`);
      continue;
    }
    if (needle.test(readFileSync(path, 'utf8'))) ok(`behavioural regression present: ${what}`);
    else fail('regression-proof', `${file} no longer proves ${what}`);
  }
}

// ── 12. Composed command matrix ────────────────────────────────────────────
interface Step {
  readonly name: string;
  readonly cmd: string;
  readonly args: readonly string[];
}

const STEPS: readonly Step[] = [
  // Every predecessor is PERMANENT. The P2-S5 gate composes P2-S4, which
  // composes P2-S3, P2-S2, P2-S1 and Phase 1, so running it once runs the
  // whole chain — and a regression anywhere in it fails here.
  { name: 'P2-S5 gate (permanent predecessor, composes P2-S4, P2-S3, P2-S2, P2-S1 and Phase 1)', cmd: npm, args: ['run', 'gate:phase2:s5'] },
  { name: 'migrations apply from zero under the migration principal', cmd: npm, args: ['run', 'check:db-from-zero'] },
  { name: '@daftar/accounting unit suite', cmd: npm, args: ['run', 'test', '-w', '@daftar/accounting'] },
  { name: '@daftar/domain-core unit suite (the permission registry)', cmd: npm, args: ['run', 'test', '-w', '@daftar/domain-core'] },
  { name: 'P2-S6 period, parity, concurrency, HTTP, authority and portability matrices', cmd: 'npx', args: ['vitest', 'run', ...P2_S6_TESTS] },
];

function runSteps(): void {
  console.log('P2-S6 GATE — composed regression matrix');
  for (const step of STEPS) {
    const started = Date.now();
    const res = spawnSync(step.cmd, [...step.args], { cwd: ROOT, encoding: 'utf8', stdio: 'inherit', env: process.env });
    const ms = Date.now() - started;
    if (res.status !== 0) fail('regression', `${step.name} failed (exit ${res.status ?? 'signal'}) after ${ms}ms`);
    else ok(`${step.name} (${ms}ms)`);
  }
}

if (LIST_ONLY) {
  console.log('P2-S6 GATE plan:');
  console.log('  structural: 0049 present, UNFROZEN, absent from the manifest, the last migration; every frozen predecessor byte-identical');
  console.log('  structural: the period’s columns, civil-date boundaries, closed status vocabulary, finite range and composite ownership');
  console.log('  structural: non-overlap is a real gist EXCLUDE, and btree_gist comes from bootstrap without widening the migration principal');
  console.log('  structural: no DELETE path, no boundary move, no identity exemption, an append-only operation registry, no generic PATCH');
  console.log('  structural: the closed-period refusal is a trigger on journal_entries; zero periods activate nothing; no fiscal calendar anywhere');
  console.log('  structural: exactly two permissions, both sensitive, reopen separate from manage; acctctl/1 extended, never replaced');
  console.log('  structural: RLS enabled and forced, no runtime writer, no DELETE for anybody, nobody holds BYPASSRLS, G-5 clean');
  console.log('  structural: the registry decides a replay before any state is read; one lock order, business before period, no global lock');
  console.log('  structural: a reopen reason is required, trimmed, bounded, audited — and never published to the outbox');
  console.log('  structural: one audit and one outbox event per command, rolled back together, with no production failpoint');
  console.log('  structural: one acctperiod/1 vector source, no JSON.stringify, and an IMMUTABLE PostgreSQL half');
  console.log('  structural: four routes, three idempotent mutations, a list that is an object with items and leaks no internals');
  console.log('  structural: every named behavioural regression exists');
  for (const s of STEPS) console.log(`  command:    ${s.cmd} ${s.args.join(' ')}`);
  process.exit(0);
}

checkMigrationBoundary();
checkPeriodShape();
checkImmutability();
checkActivationAndGuard();
checkAuthority();
checkIdempotencyAndLocks();
checkReopenReason();
checkAuditAndOutbox();
checkCanonicalization();
checkSurface();
checkBehaviouralRegressions();
if (failures > 0) {
  console.error(`\nP2-S6 GATE: FAIL (${failures} structural violation${failures === 1 ? '' : 's'}) — not running the regression matrix`);
  process.exit(1);
}
runSteps();

if (failures > 0) {
  console.error(`\nP2-S6 GATE: FAIL (${failures})`);
  process.exit(1);
}
console.log('\nP2-S6 GATE: PASS');
