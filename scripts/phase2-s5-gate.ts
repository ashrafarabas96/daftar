#!/usr/bin/env tsx
/**
 * PHASE 2 SLICE GATE — P2-S5, the FX rate foundation (directive §72).
 *
 * `npm run gate:phase2:s5` is the deterministic answer to "does the FX slice
 * still do exactly what it was built to do?". P2-S4 shipped the three
 * merchant-facing journal facts; P2-S5 adds the ONE thing a future
 * multi-currency domain needs before it can post anything — a business's own
 * append-only record of what a rate was, at an instant it chose — plus two
 * pure primitives that decide WHICH account a realized difference belongs in
 * without posting anything at all.
 *
 * The slice's whole risk is that each of those is easy to get subtly wrong in
 * a way no ordinary test notices: a registry that quietly inverts a rate, a
 * lookup that answers 1 when it has nothing to say, a "correction" that
 * rewrites history, a control assertion a posting assertion can be swapped
 * for, a residual account that becomes a balancing trash can. Every section
 * below exists for one of those.
 *
 * 0048 is a CANDIDATE. §79 computes its digest and explicitly does NOT freeze
 * it, so this gate requires the manifest to stay frozen through 0047 and
 * requires 0048 to be absent from it. That restriction is candidate-era and
 * belongs here exactly as long as P2-S5 is under review — the moment a Tech
 * Lead accepts the slice, this gate becomes permanent and these two checks
 * invert, the way P2-S4's did.
 *
 * It COMPOSES rather than duplicates: P2-S4's gate runs unchanged, and it
 * composes P2-S3, P2-S2, P2-S1 and Phase 1 in turn, so the whole chain runs
 * from one command and nothing this slice adds can be paid for with a
 * regression in what came before.
 *
 * Usage: npm run gate:phase2:s5 [-- --list]
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

/** The ONE migration this slice owns. §9 authorizes no second one. */
const S5_MIGRATION = '0048_accounting_fx_rates.sql';

/** The manifest must still be frozen exactly here while 0048 is a candidate. */
const FROZEN_THROUGH = '0047_accounting_opening_balances.sql';

/** The table and routines the slice owes. */
const S5_TABLES = ['accounting_fx_rates'] as const;

const S5_ROUTINES = [
  'accounting_control_actor',
  'accounting_fx_rate_canonical',
  'accounting_fx_rate_fingerprint',
  'accounting_fx_rate_lock_key',
  'accounting_fx_rate_identity_lock_key',
  'accounting_fx_rate_enter',
  'accounting_fx_rate_lookup',
] as const;

/**
 * Surfaces P2-S5 explicitly DEFERRED (§7-§10, §21, §28).
 *
 * A table created "for later" is scope creep with a comment on it, and a rate
 * PROVIDER table in particular would be a promise the schema makes and no
 * credential can keep.
 */
const OUT_OF_SCOPE_TABLES = [
  'accounting_periods',
  'accounting_balances',
  'accounting_trial_balance',
  'accounting_fx_providers',
  'accounting_fx_rate_requests',
  'accounting_fx_cache',
] as const;

/** The engine modules P2-S5 adds to @daftar/accounting. */
const S5_MODULES = ['src/fx-rate.ts', 'src/control-assertion.ts', 'src/realized-fx.ts', 'src/rounding.ts'] as const;

/** The suites that prove, against a real database, what the structure only claims. */
const P2_S5_TESTS = [
  'tests/integration/accounting-fx-rates.test.ts',
  'tests/integration/accounting-fx-concurrency.test.ts',
  'tests/integration/accounting-fx-http.test.ts',
  'tests/integration/accounting-fx-parity.test.ts',
  'tests/security/accounting-fx-authority.test.ts',
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
const s5Raw = (): string => readMigration(S5_MIGRATION);
const s5Sql = (): string => stripComments(s5Raw());

/**
 * The slice's SQL with its string literals blanked as well as its comments.
 *
 * Needed wherever a check looks for a forbidden IDENTIFIER: this file's own
 * COMMENT ON statements explain at length why a rate is never REAL, FLOAT or
 * DOUBLE PRECISION, and a guard that read those would fail on the sentence
 * that states the rule it is enforcing.
 */
const s5Code = (): string => s5Sql().replace(/'(?:[^']|'')*'/g, "''");

/** The body of one `CREATE [OR REPLACE] FUNCTION name(...)` in the slice's SQL. */
function routineBody(sql: string, name: string): string | null {
  const start = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${name}\\s*\\(`, 'i').exec(sql);
  if (start === null) return null;
  const from = start.index;
  const rest = sql.slice(from);
  // Each routine in this file is dollar-quoted with `$$`; the body runs from
  // the first `$$` to the second.
  const open = rest.indexOf('$$');
  if (open === -1) return null;
  const close = rest.indexOf('$$', open + 2);
  return close === -1 ? rest.slice(open) : rest.slice(open, close);
}

// ── 1. Migration boundary ──────────────────────────────────────────────────
//
// One authorized migration, no 0049, everything up to 0047 untouched, and the
// candidate deliberately NOT frozen (§9, §79).
function checkMigrationBoundary(): void {
  console.log('P2-S5 GATE — the candidate boundary');
  const files = sqlFiles();

  if (files.includes(S5_MIGRATION)) ok(`${S5_MIGRATION} present`);
  else fail('s5-migration', `${S5_MIGRATION} is missing — P2-S5 is the slice that creates the FX registry (§9)`);

  const beyond = files.filter((f) => f > S5_MIGRATION);
  if (beyond.length > 0) {
    fail('s5-migration', `migrations beyond the authorized candidate exist: ${beyond.join(', ')} — §9 authorizes exactly one, and there is no 0049`);
  } else {
    ok('no migration beyond the one authorized candidate (§9)');
  }

  const manifest = JSON.parse(readFileSync(join(ROOT, 'infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8')) as {
    frozenThrough: string;
    migrations: { name: string; sha256: string }[];
  };

  if (manifest.frozenThrough !== FROZEN_THROUGH) {
    fail('candidate', `frozenThrough is ${manifest.frozenThrough} — while 0048 is under review the frozen boundary stays at ${FROZEN_THROUGH} (§79)`);
  } else {
    ok(`frozenThrough = ${FROZEN_THROUGH} — the P2-S4 acceptance boundary, unchanged (§79)`);
  }

  const recorded = new Map(manifest.migrations.map((m) => [m.name, m.sha256] as const));
  if (recorded.has(S5_MIGRATION)) {
    fail('candidate', `${S5_MIGRATION} is recorded in the manifest — §79 computes its digest and explicitly does NOT freeze it before review`);
  } else {
    ok(`${S5_MIGRATION} is a candidate: its digest is reported, not frozen (§79)`);
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

  // The candidate's own digest, reported for the handoff (§79).
  if (files.includes(S5_MIGRATION)) {
    const sha = createHash('sha256')
      .update(readFileSync(join(MIGRATIONS_DIR, S5_MIGRATION)))
      .digest('hex');
    ok(`${S5_MIGRATION} sha256 = ${sha} (candidate digest, not frozen)`);
  }
}

// ── 2. The registry's physical shape ───────────────────────────────────────
function checkRegistryShape(): void {
  console.log('P2-S5 GATE — the registry');
  const sql = s5Sql();

  for (const table of S5_TABLES) {
    if (new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table}\\b`, 'i').test(sql)) ok(`${table} exists`);
    else fail('missing-surface', `${table} does not exist — P2-S5 is the slice that creates it (§11)`);
  }
  for (const routine of S5_ROUTINES) {
    if (new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${routine}\\b`, 'i').test(sql)) ok(`${routine} exists`);
    else fail('missing-surface', `${routine} does not exist — the FX commands are DB routines, not application logic (§26)`);
  }
  for (const table of OUT_OF_SCOPE_TABLES) {
    if (new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table}\\b`, 'i').test(sql)) {
      fail('scope', `${table} is created by 0048 — P2-S5 builds a manual rate history and nothing else (§7, §10)`);
    }
  }
  ok('0048 builds no provider table, no cache, no period and no balance read surface (§7, §10)');

  // §11, §15: the rate's type. G-2 also fails CI on this; asserted here so a
  // gate failure names the rule rather than a generic guard.
  if (/\brate\s+NUMERIC\s*\(\s*20\s*,\s*10\s*\)\s+NOT\s+NULL/i.test(sql)) ok('rate is NUMERIC(20,10) NOT NULL — AL-09’s exact type (§15)');
  else fail('rate-type', 'accounting_fx_rates.rate is not declared NUMERIC(20,10) NOT NULL — a float rate becomes history (§15, G-2)');
  if (/\b(REAL|DOUBLE\s+PRECISION|FLOAT\d*)\b/i.test(s5Code())) {
    fail('rate-type', '0048 names a floating-point type — no accounting value may be stored as a float (§15, G-2)');
  } else {
    ok('0048 declares no REAL, FLOAT or DOUBLE PRECISION column (§15)');
  }

  // §12: composite ownership, in both components.
  if (/FOREIGN\s+KEY\s*\(\s*tenant_id\s*,\s*business_id\s*\)\s*REFERENCES\s+businesses\s*\(\s*tenant_id\s*,\s*id\s*\)/i.test(sql)) {
    ok('(tenant_id, business_id) → businesses (tenant_id, id): a row cannot disown its tenant (§12)');
  } else {
    fail('ownership', 'accounting_fx_rates has no composite (tenant_id, business_id) foreign key — one component of a key is not an identity (§12)');
  }

  // §13: currencies answer to the registry, not to a regular expression.
  const currencyRefs = (sql.match(/REFERENCES\s+currencies\s*\(\s*code\s*\)/gi) ?? []).length;
  if (currencyRefs >= 2) ok('both currencies reference currencies(code) — ZZZ is refused by the registry, not accepted by a regex (§13)');
  else fail('currency-registry', `only ${currencyRefs} currency column references currencies(code) — both must (§13)`);

  // §14, §15, §16, §17: the four physical rules.
  const constraints: ReadonlyArray<{ re: RegExp; what: string; why: string }> = [
    { re: /CHECK\s*\(\s*from_currency\s*<>\s*to_currency\s*\)/i, what: 'from_currency <> to_currency', why: 'a same-currency rate is not a rate (§14)' },
    { re: /CHECK\s*\(\s*rate\s*>\s*0\s*\)/i, what: 'rate > 0', why: 'zero and negative are not unusual rates, they are not rates (§15)' },
    {
      re: /CHECK\s*\(\s*date_trunc\s*\(\s*'second'\s*,\s*effective_at\s*\)\s*=\s*effective_at\s*\)/i,
      what: 'second precision on effective_at',
      why: 'acctfp/1 cannot fingerprint a sub-second instant (§16)',
    },
    {
      re: /UNIQUE\s*\(\s*business_id\s*,\s*from_currency\s*,\s*to_currency\s*,\s*effective_at\s*\)/i,
      what: 'UNIQUE (business_id, from_currency, to_currency, effective_at)',
      why: 'one business, one pair, one instant, one truth (§17)',
    },
  ];
  for (const c of constraints) {
    if (c.re.test(sql)) ok(`${c.what} — ${c.why}`);
    else fail('registry-shape', `accounting_fx_rates has no ${c.what} — ${c.why}`);
  }

  // §11: the columns a rate must NOT have. Each one would turn an immutable
  // fact into a setting somebody edits.
  for (const column of ['is_current', 'superseded_by', 'status', 'last_used_at', 'updated_at']) {
    if (
      new RegExp(`^\\s*${column}\\s`, 'im').test(
        sql.slice(sql.indexOf('CREATE TABLE accounting_fx_rates'), sql.indexOf('COMMENT ON TABLE accounting_fx_rates')),
      )
    ) {
      fail('registry-shape', `accounting_fx_rates carries a ${column} column — a rate is immutable truth, and a correction is a NEW row (§11, §18)`);
    }
  }
  ok('the registry carries no status, is_current, superseded_by or last_used_at column (§11, §18)');

  // §24: one index, and it is the uniqueness constraint's own.
  const extraIndexes = sql.match(/CREATE\s+(?:UNIQUE\s+)?INDEX[^;]*ON\s+accounting_fx_rates/gi) ?? [];
  if (extraIndexes.length > 0) {
    fail(
      'index-cargo-cult',
      `0048 creates ${extraIndexes.length} extra index(es) on accounting_fx_rates — the natural key already answers the only query (§24)`,
    );
  } else {
    ok('one index on the registry, the identity constraint’s own — no speculative DESC or covering index (§24)');
  }

  // §28: entering a rate creates no journal fact, so it registers no source
  // type. A registry that grew here would mean the slice claimed the ledger.
  if (/INSERT\s+INTO\s+accounting_source_types/i.test(sql)) {
    fail('scope', '0048 registers a source type — entering a rate posts nothing, so it is not a source of journal entries (§28)');
  } else {
    ok('no source type is registered: the FX slice writes no journal entry at all (§28)');
  }
  if (/INSERT\s+INTO\s+journal_(entries|lines)/i.test(sql)) {
    fail('scope', '0048 writes the journal — P2-S5 records rates and posts nothing (§7, §28)');
  } else {
    ok('0048 contains no journal write (§7)');
  }
}

// ── 3. Append-only, proved by the trigger rather than by an ACL ────────────
function checkImmutability(): void {
  console.log('P2-S5 GATE — append-only');
  const sql = s5Sql();

  if (/CREATE\s+TRIGGER\s+\w+\s+BEFORE\s+UPDATE\s+OR\s+DELETE\s+ON\s+accounting_fx_rates/i.test(sql)) {
    ok('a BEFORE UPDATE OR DELETE trigger guards the registry (§18)');
  } else {
    fail(
      'immutability',
      'accounting_fx_rates has no BEFORE UPDATE OR DELETE trigger — §45 is explicit that a permission denied is evidence about an ACL, not about immutability',
    );
  }

  // §18: "for EVERY principal including the schema owner" means the trigger
  // body raises unconditionally. A trigger with an IF in it is a trigger with
  // a principal it lets through.
  const body = routineBody(sql, 'accounting_fx_rates_immutable');
  if (body === null) {
    fail('immutability', 'accounting_fx_rates_immutable does not exist — the append-only rule would live only in the grant model (§18)');
  } else if (/\bIF\b|\bCASE\b|\bcurrent_user\b|\bsession_user\b/i.test(body)) {
    fail('immutability', 'the immutability trigger branches on something — it must raise for every principal, the schema owner included (§18, §45)');
  } else if (/RAISE\s+EXCEPTION\s+'accounting\.fx_rate_immutable/i.test(body)) {
    ok('the immutability trigger raises accounting.fx_rate_immutable unconditionally, for every principal (§18, §45)');
  } else {
    fail('immutability', 'the immutability trigger does not raise accounting.fx_rate_immutable — the refusal needs the domain’s own name (§18)');
  }

  // No UPDATE or DELETE statement against the registry anywhere in the slice.
  if (/\b(UPDATE|DELETE\s+FROM)\s+accounting_fx_rates\b/i.test(sql)) {
    fail('immutability', '0048 itself contains an UPDATE or DELETE against accounting_fx_rates — nothing may rewrite a stated rate (§18)');
  } else {
    ok('no statement in the slice updates or deletes a rate (§18)');
  }
}

// ── 4. The lookup answers one question and invents nothing ─────────────────
function checkLookup(): void {
  console.log('P2-S5 GATE — the deterministic read');
  const sql = s5Sql();
  const body = routineBody(sql, 'accounting_fx_rate_lookup');
  if (body === null) {
    fail('lookup', 'accounting_fx_rate_lookup does not exist — §21 makes the read a database routine, not a query the caller writes');
    return;
  }

  if (/effective_at\s*<=\s*p_at/i.test(body) && /ORDER\s+BY\s+r\.effective_at\s+DESC/i.test(body) && /LIMIT\s+1/i.test(body)) {
    ok('the lookup returns the latest rate at or before the fact’s instant — never a future one (§21)');
  } else {
    fail('lookup', 'the lookup is not "max effective_at <= instant, LIMIT 1" — a rate registry that can return a future rate is a time machine (§21)');
  }

  if (/accounting\.fx_rate_missing/.test(body)) ok('a missing rate is refused by name, not substituted (§21)');
  else fail('lookup', 'the lookup does not raise accounting.fx_rate_missing — silence would become a number somebody posted (§21)');

  // §19, §20: no reciprocal, no cross-rate. A lookup that divides, or that
  // reads the registry twice, is inferring.
  if (/1\s*\/\s*|\/\s*r\.rate|\bWITH\s+RECURSIVE\b/i.test(body)) {
    fail('lookup', 'the lookup divides or recurses — it must not invert a rate or chain one pair through another (§19, §20)');
  } else {
    ok('the lookup performs no division and no recursion: no reciprocal, no cross-rate (§19, §20)');
  }
  const registryReads = (body.match(/FROM\s+accounting_fx_rates\b/gi) ?? []).length;
  if (registryReads === 1) ok('the lookup reads the registry exactly once — it is not an FX graph solver (§20)');
  else fail('lookup', `the lookup reads accounting_fx_rates ${registryReads} times — chaining two rows is a cross-rate inference (§20)`);

  // §21: no implicit 1 for a foreign pair. A COALESCE onto a literal rate is
  // exactly the substitution the directive forbids.
  if (/coalesce\s*\([^)]*\b1(\.0+)?\b/i.test(body)) {
    fail('lookup', 'the lookup coalesces a missing rate onto 1 — "no implicit 1.0 for foreign currency" (§21, §46)');
  } else {
    ok('nothing in the lookup falls back to 1 (§21, §46)');
  }

  // §23: it writes nothing. STABLE says so at the catalogue level; this says
  // so at the statement level.
  if (/\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM)\b/i.test(body)) {
    fail('lookup', 'the lookup contains a write — reading a rate must not touch a counter, an audit row or a last_used_at (§23)');
  } else {
    ok('the lookup writes nothing at all (§23)');
  }
  if (/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+accounting_fx_rate_lookup[\s\S]{0,400}?SECURITY\s+DEFINER/i.test(sql)) {
    fail(
      'lookup',
      'the lookup is SECURITY DEFINER — running as the caller is what makes isolation row level security’s answer rather than this function’s (§21, §43)',
    );
  } else {
    ok('the lookup runs as the CALLER, so a cross-business read is refused by RLS and not by arithmetic (§21, §43)');
  }
}

// ── 5. Authority: the second assertion domain, and who may write ───────────
function checkAuthority(): void {
  console.log('P2-S5 GATE — authority');
  const sql = s5Sql();

  // §29, §30: a SECOND format on the same key material, domain-separated.
  if (/'acctctl\/1'/.test(sql)) ok("the control assertion is bound to the domain label 'acctctl/1' (§29)");
  else fail('control-assertion', "0048 does not bind the control assertion to 'acctctl/1' — an unlabelled MAC over the same key is the same MAC (§29, §30)");

  const verifier = routineBody(sql, 'accounting_control_actor');
  if (verifier === null) {
    fail('control-assertion', 'accounting_control_actor does not exist — the control format needs its own verifier (§29)');
  } else {
    if (/hmac\s*\(/i.test(verifier) && /'acctctl\/1'/.test(verifier)) {
      ok('the control verifier computes its MAC over the domain-prefixed preimage (§30)');
    } else {
      fail('control-assertion', 'the control verifier does not prefix its preimage with the domain — §30 forbids relying on parser lengths for separation');
    }
    if (/fx_rate_enter/.test(sql)) ok("command kind 'fx_rate_enter' is the only control command this slice mints or accepts (§29)");
    else fail('control-assertion', 'no command kind is bound into the control assertion (§29)');
    if (/accounting_assertion_uses/i.test(verifier)) ok('a control assertion is single-use, through the existing replay registry (§31, §63)');
    else fail('control-assertion', 'the control verifier records no jti — a stolen assertion would replay forever (§31, §60)');
    if (/expires|v_exp/i.test(verifier)) ok('the control assertion carries an expiry the verifier enforces (§62)');
    else fail('control-assertion', 'the control verifier checks no expiry (§62)');
  }

  // §26: one definer command, pinned and owned.
  if (/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+accounting_fx_rate_enter[\s\S]{0,600}?SECURITY\s+DEFINER/i.test(sql)) {
    ok('accounting_fx_rate_enter is the one SECURITY DEFINER write path (§26)');
  } else {
    fail(
      'authority',
      'accounting_fx_rate_enter is not SECURITY DEFINER — the only write path must be elevated, or the grant model is the only thing protecting the table (§26)',
    );
  }
  if (/ALTER\s+FUNCTION\s+accounting_fx_rate_enter[^;]*OWNER\s+TO\s+daftar_accounting_internal/i.test(sql)) {
    ok(`the command is owned by ${INTERNAL_ROLE}, which cannot log in (§26)`);
  } else {
    fail(
      'authority',
      `accounting_fx_rate_enter is not transferred to ${INTERNAL_ROLE} — a definer owned by the migrator runs with the migrator's authority (§26)`,
    );
  }
  if (/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+accounting_fx_rate_enter[^;]*TO\s+PUBLIC/i.test(sql)) {
    fail('authority', 'EXECUTE on the FX command is granted to PUBLIC (§26)');
  } else {
    ok('EXECUTE on the FX command is never granted to PUBLIC (§26)');
  }
  if (/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+accounting_fx_rate_enter[^;]*TO\s+daftar_app/i.test(sql)) {
    ok('EXECUTE on the FX command is granted to daftar_app alone (§26)');
  } else {
    fail('authority', 'EXECUTE on the FX command is not granted to daftar_app — the merchant runtime is the one caller (§26)');
  }

  // §26 again: no temporary relation, and schema authority handed back.
  if (/CREATE\s+(?:TEMP|TEMPORARY|LOCAL\s+TEMP)\s/i.test(sql)) {
    fail('guard-g5', '0048 creates a temporary relation — a session-scoped relation is exactly what pg_temp shadowing exploits (§26, §69)');
  } else {
    ok('0048 creates no temporary relation (§26, §69)');
  }
  if (/GRANT\s+CREATE\s+ON\s+SCHEMA\s+public/i.test(sql) && !/REVOKE\s+CREATE\s+ON\s+SCHEMA\s+public/i.test(sql)) {
    fail('schema-authority', '0048 grants CREATE on schema public without revoking it — the elevated principal keeps schema authority (§26)');
  } else {
    ok('schema authority is returned: every CREATE grant on public is revoked before the migration ends (§26)');
  }

  // §27: the GUC is a transport, never an authorization.
  if (/current_setting\s*\(\s*'app\.(tenant_id|business_id|user_id|bypass_rls)'/i.test(routineBody(sql, 'accounting_fx_rate_enter') ?? '')) {
    fail(
      'guc-scope',
      'the FX command reads a scope GUC to decide WHO the actor is — a GUC is where a request says what it wants, never proof of what it may have (§27, §61)',
    );
  } else {
    ok('the FX command takes its actor, tenant, business and rate id from the verified assertion alone (§27, §37, §61)');
  }

  // §25, §44: the grant model. No runtime role gets a write on the registry,
  // and exactly one gets a read.
  const runtime = new Set<string>(RUNTIME_ROLES);
  for (const table of S5_TABLES) {
    const grants = INTENDED_TABLE_GRANTS[table];
    if (grants === undefined) {
      fail('grant-model', `${table} is not in the intended grant model — G-1 would not notice a grant on it (§67)`);
      continue;
    }
    let writers = 0;
    const readers: string[] = [];
    for (const [grantee, privileges] of Object.entries(grants)) {
      for (const privilege of privileges) {
        if (runtime.has(grantee) && (WRITE_PRIVILEGES as readonly string[]).includes(privilege)) {
          fail('runtime-dml', `the grant model gives the runtime role ${grantee} ${privilege} on ${table} — no login role writes a rate (§25)`);
          writers += 1;
        }
        if (privilege === 'SELECT' && runtime.has(grantee)) readers.push(grantee);
      }
      if ((privileges as readonly string[]).includes('UPDATE') || (privileges as readonly string[]).includes('DELETE')) {
        fail('runtime-dml', `the grant model gives ${grantee} UPDATE or DELETE on ${table} — the registry is append-only for everyone (§18, §25)`);
      }
    }
    if (writers === 0) ok(`no runtime credential holds DML on ${table}; the command reaches it only as ${INTERNAL_ROLE} (§25)`);
    if (readers.length === 1) ok(`exactly one runtime reader on ${table}: ${readers[0]} (§44)`);
    else fail('grant-model', `${table} has ${readers.length} runtime readers (${readers.join(', ') || 'none'}) — §44 wants the minimum, which is one`);
  }

  // §43: RLS on and FORCED, nothing touched in the bypass path, never BYPASSRLS.
  if (
    /ALTER\s+TABLE\s+accounting_fx_rates\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(sql) &&
    /ALTER\s+TABLE\s+accounting_fx_rates\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i.test(sql)
  ) {
    ok('row level security is ENABLED and FORCED on the registry (§43)');
  } else {
    fail('rls', 'accounting_fx_rates does not both ENABLE and FORCE row level security — a table its owner can read past is not isolated (§43)');
  }
  if (/\bBYPASSRLS\b/i.test(sql) && !/NOBYPASSRLS/i.test(sql)) {
    fail('rls', '0048 grants BYPASSRLS — no accounting principal may ever hold it (§43)');
  } else {
    ok('0048 grants BYPASSRLS to nobody (§43)');
  }
  // USING app_bypass() in a policy is how every other accounting table reads
  // the platform escape hatch; REDEFINING it, or setting the GUC behind it, is
  // what §43 forbids.
  if (/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+app_bypass\b/i.test(sql) || /set_config\s*\(\s*'app\.bypass_rls'/i.test(sql)) {
    fail('rls', '0048 redefines app_bypass or sets its GUC — the existing platform escape hatch is not this slice’s to widen (§43)');
  } else if (/app_bypass\(\)/i.test(sql)) {
    ok('the registry’s policies read the existing app_bypass() and change nothing about it (§43)');
  } else {
    fail('rls', 'the registry’s policies do not use app_bypass() — it must behave like every other accounting table (§43)');
  }

  // §69: G-5 across the whole tree, including these new definers.
  const migrations: Record<string, string> = {};
  for (const name of sqlFiles()) migrations[name] = readMigration(name);
  const manifest = JSON.parse(readFileSync(join(ROOT, 'infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8')) as { migrations: { name: string }[] };
  const g5 = findDefinerSearchPathViolations({
    migrations,
    bootstrap: readFileSync(join(ROOT, 'infrastructure/database/bootstrap.sql'), 'utf8'),
    frozen: new Set(manifest.migrations.map((m) => m.name)),
  });
  if (g5.length > 0) for (const detail of g5) fail('guard-g5', detail);
  else ok('G-5 clean: every SECURITY DEFINER routine pins its path with pg_temp named LAST (§69)');
}

// ── 6. Idempotency, conflict and the locks ─────────────────────────────────
function checkIdempotencyAndLocks(): void {
  console.log('P2-S5 GATE — idempotency, conflict and serialization');
  const sql = s5Sql();
  const enter = routineBody(sql, 'accounting_fx_rate_enter');
  if (enter === null) {
    fail('idempotency', 'accounting_fx_rate_enter does not exist');
    return;
  }

  // §33 and §34 are two different refusals, and collapsing them would tell a
  // merchant the wrong thing about which of two facts is in dispute.
  for (const [code, why] of [
    ['accounting.idempotency_conflict', 'the same key carrying a different payload (§33)'],
    ['accounting.fx_rate_conflict', 'two different keys stating different rates for one pair and instant (§34)'],
  ] as const) {
    if (enter.includes(code)) ok(`${code} is raised for ${why}`);
    else fail('idempotency', `the FX command never raises ${code} — ${why} would be answered with success or with a raw duplicate key`);
  }

  // §34: never overwrite. The command may INSERT, and that is all.
  if (/\bUPDATE\s+accounting_fx_rates\b|ON\s+CONFLICT[\s\S]{0,80}?DO\s+UPDATE/i.test(enter)) {
    fail('idempotency', 'the FX command can overwrite an existing rate — a second answer never replaces the first (§34)');
  } else {
    ok('the FX command only ever inserts: an existing rate is returned or the request is refused (§34)');
  }

  // §35: no SQLSTATE, constraint name or deadlock wording reaches a caller.
  const raised = enter.match(/RAISE\s+EXCEPTION\s+'[^']*'/g) ?? [];
  const leaky = raised.filter((r) => /23505|40P01|40001|deadlock|serializ|_uk\b|_ck\b|constraint/i.test(r));
  if (leaky.length > 0) {
    for (const r of leaky) fail('error-leak', `a refusal leaks an implementation detail: ${r.slice(0, 80)}… (§17, §35)`);
  } else {
    ok('no refusal names a SQLSTATE, a constraint, a deadlock or a serialization failure (§17, §35)');
  }

  // §36: narrow, deterministic locks in a fixed order — and never a
  // business-wide one, which would make entering a EUR rate wait on a USD one.
  const locks = [...enter.matchAll(/pg_advisory_xact_lock\s*\(\s*(\w+)\s*\(/g)].map((m) => m[1]);
  if (locks.length === 0) {
    fail(
      'serialization',
      'the FX command takes no advisory lock — §35’s concurrent cases would be settled by whichever transaction happened to be second (§36)',
    );
  } else if (locks.some((l) => l === undefined || !/^accounting_fx_rate_(identity_)?lock_key$/.test(l))) {
    fail('serialization', `the FX command locks on [${locks.join(', ')}] — the key must be derived from the FX identity, not from the business (§36)`);
  } else if (locks[0] !== 'accounting_fx_rate_identity_lock_key') {
    fail('serialization', `the identity lock is not taken first (order: ${locks.join(' → ')}) — two locks in an unfixed order is a deadlock, not a race (§36)`);
  } else {
    ok(`two narrow locks in a fixed order: ${locks.join(' → ')} — neither is business-wide (§36)`);
  }
  if (/pg_advisory_xact_lock\s*\(\s*hashtextextended\s*\(\s*p?_?business/i.test(enter) || /FOR\s+(SHARE|UPDATE)/i.test(enter)) {
    fail(
      'serialization',
      'the FX command takes a business-wide lock or a row lock on the business — entering a USD rate must not block entering a EUR one (§36)',
    );
  } else {
    ok('the FX command locks no business row and takes no business-wide lock (§36)');
  }

  // §41, §42: exactly one audit event and one outbox event, neither carrying
  // the rate.
  const audits = (enter.match(/INSERT\s+INTO\s+audit_events/gi) ?? []).length;
  const outbox = (enter.match(/INSERT\s+INTO\s+outbox_events/gi) ?? []).length;
  if (audits === 1) ok('exactly one audit event per accepted entry (§41)');
  else fail('audit', `the FX command writes ${audits} audit events — §41 specifies exactly one, in the same transaction`);
  if (outbox === 1) ok('exactly one outbox event per accepted entry (§42)');
  else fail('outbox', `the FX command writes ${outbox} outbox events — §42 specifies exactly one, in the same transaction`);
  if (/accounting\.fx_rate_entered/.test(enter) && /'accounting_fx_rate'/.test(enter)) {
    ok("the audit event is accounting.fx_rate_entered on entity 'accounting_fx_rate' (§41)");
  } else {
    fail('audit', 'the audit event is not accounting.fx_rate_entered on accounting_fx_rate (§41)');
  }
  if (/accounting\.fx_rate\.entered/.test(enter)) ok('the outbox event type is accounting.fx_rate.entered (§42)');
  else fail('outbox', 'the outbox event type is not accounting.fx_rate.entered (§42)');

  // The rate VALUE in either payload would put commercially sensitive truth on
  // a bus that more systems read than the ledger.
  const payloads = [...enter.matchAll(/jsonb_build_object\(([\s\S]*?)\)\s*\)/g)].map((m) => m[1] ?? '');
  const withRate = payloads.filter((p) => /'rate'|\bv_rate\b|'rateValue'/.test(p));
  if (withRate.length > 0) {
    fail('audit', 'an audit or outbox payload carries the rate value — identifiers and safe labels only (§41, §42)');
  } else {
    ok('neither the audit metadata nor the outbox payload carries the rate value (§41, §42)');
  }
}

// ── 7. The clock audit (§64, §65) ──────────────────────────────────────────
//
// Round four of P2-S4 established the rule this section enforces: closing a
// clock seam in the DTO, the schema, the service and the engine is not closing
// it while the trusted database command still has a `coalesce(p_x, today)`.
// So every clock reference in 0048 is enumerated here, by line, and each one
// must be a use the directive actually permits.
function checkClockAudit(): void {
  console.log('P2-S5 GATE — the clock audit');
  const raw = stripComments(s5Raw());
  const lines = raw.split('\n');
  const clock = /\b(now\(\)|current_timestamp|clock_timestamp\(\)|current_date|localtimestamp|transaction_timestamp\(\)|statement_timestamp\(\))/i;

  const permitted: ReadonlyArray<{ re: RegExp; why: string }> = [
    // A narrative audit column. It is not fingerprinted, not part of any
    // identity, and no command reads it back.
    { re: /created_at\s+TIMESTAMPTZ\s+NOT\s+NULL\s+DEFAULT\s+now\(\)/i, why: 'created_at is narrative, never an identity (§64)' },
    // "Is this assertion expired?" is a question about the clock, which is the
    // one thing a command may ask it.
    { re: /extract\s*\(\s*epoch\s+FROM\s+now\(\)\s*\)/i, why: 'the expiry comparison asks the clock a question, it does not choose a value (§62, §64)' },
  ];

  let offenders = 0;
  lines.forEach((line, i) => {
    if (!clock.test(line)) return;
    if (permitted.some((p) => p.re.test(line))) return;
    offenders += 1;
    fail('clock', `${S5_MIGRATION}:${i + 1} reads the clock outside the two permitted uses — an effective instant is stated, never resolved (§64, §65)`);
  });
  if (offenders === 0) ok('every clock reference in 0048 is one of the two permitted uses, and none of them chooses a stored value (§64, §65)');

  // The specific shape §65 names: a coalesce whose fallback is the clock.
  const coalesced = raw.match(/coalesce\s*\([^)]*\b(now\(\)|current_date|current_timestamp|clock_timestamp\(\))/gi) ?? [];
  if (coalesced.length > 0) {
    for (const c of coalesced)
      fail('clock', `0048 falls back to the clock: ${c} — this is the exact seam round four closed in accounting_post_reversal (§64, §65)`);
  } else {
    ok('no coalesce anywhere in 0048 falls back to a clock value (§65)');
  }

  // The effective instant is a parameter with no default and no substitute.
  const enter = routineBody(raw, 'accounting_fx_rate_enter') ?? '';
  if (/p_effective_at\s+IS\s+NULL/i.test(enter) && /accounting\.fx_effective_at_required/.test(enter)) {
    ok('a NULL effective instant is REFUSED by name, never filled in (§64)');
  } else {
    fail('clock', 'the FX command does not refuse a NULL effective instant by name — a command that fills one in is not idempotent (§64)');
  }
}

// ── 8. The pure primitives (§49-§56, §58) ──────────────────────────────────
function checkPurePrimitives(): void {
  console.log('P2-S5 GATE — the realized-FX and rounding primitives');

  for (const module of S5_MODULES) {
    if (existsSync(join(ROOT, 'packages/accounting', module))) ok(`packages/accounting/${module}`);
    else fail('engine', `packages/accounting/${module} is missing — these are engine primitives, not API helpers (§49, §54)`);
  }

  const realizedPath = join(ROOT, 'packages/accounting/src/realized-fx.ts');
  if (existsSync(realizedPath)) {
    const src = readFileSync(realizedPath, 'utf8');
    const code = stripTypeScriptProse(src);
    const identifiers = stripTypeScriptComments(src);

    // §49: it decides, it does not post.
    if (/\b(post|insert|query|client|pool|db)\b\s*\(/i.test(identifiers)) {
      fail('realized-fx', 'the realized-FX primitive calls something — it CHOOSES an account and returns an intent; posting is the caller’s (§49)');
    } else {
      ok('the realized-FX primitive posts nothing and touches no database (§49)');
    }

    // §51: the direction is explicit. A primitive that guessed would book a
    // gain as a loss on exactly the half of all settlements it guessed wrong.
    if (/'inflow'/.test(code) && /'outflow'/.test(code)) ok("the economic direction is an explicit 'inflow' | 'outflow' (§51)");
    else fail('realized-fx', 'the realized-FX primitive does not require an explicit inflow/outflow direction (§51)');

    // §53: the two accounts, the two sides, and nothing else.
    if (/'fx_gain'/.test(code) && /'fx_loss'/.test(code)) ok('the only accounts it can choose are fx_gain and fx_loss (§53)');
    else fail('realized-fx', 'the realized-FX primitive does not name both fx_gain and fx_loss (§53)');
    if (/systemKey:\s*'fx_gain',\s*side:\s*'C'/.test(code) && /systemKey:\s*'fx_loss',\s*side:\s*'D'/.test(code)) {
      ok('a gain is a CREDIT to fx_gain and a loss a DEBIT to fx_loss, pinned in code (§53)');
    } else {
      fail('realized-fx', 'the gain/credit and loss/debit pairing is not pinned — a sign error here is silent and permanent (§53)');
    }

    // §56: it can never reach another helper's account.
    for (const forbidden of ['purchase_price_variance', 'rounding', 'inventory_adjustment']) {
      if (new RegExp(`'${forbidden}'`).test(code)) {
        fail('account-separation', `the realized-FX primitive names '${forbidden}' — an FX difference is never a variance, a residual or an adjustment (§56)`);
      }
    }
    ok('the realized-FX primitive cannot return a variance, a residual or an adjustment account (§56)');

    // §50, §52: exact integers only.
    if (/\b(Number|parseFloat|parseInt|Math\.(round|floor|ceil|abs))\b/.test(identifiers)) {
      fail('realized-fx', 'the realized-FX primitive uses floating-point arithmetic — every amount is a BigInt of minor units (§50)');
    } else {
      ok('the realized-FX primitive is BigInt-only: no Number, no parseFloat, no Math.round (§50)');
    }
    if (/MAX_MONEY_MINOR/.test(identifiers)) ok('the primitive is bounded by MAX_MONEY_MINOR (§50, AL-10)');
    else fail('realized-fx', 'the realized-FX primitive does not bound its inputs by MAX_MONEY_MINOR (§50)');
  }

  const roundingPath = join(ROOT, 'packages/accounting/src/rounding.ts');
  if (existsSync(roundingPath)) {
    const code = stripTypeScriptProse(readFileSync(roundingPath, 'utf8'));
    if (/'rounding'/.test(code)) ok("the rounding primitive's only account is 'rounding' (§55)");
    else fail('rounding', "the rounding primitive does not name 'rounding' as its account (§55)");
    for (const forbidden of ['fx_gain', 'fx_loss', 'purchase_price_variance']) {
      if (new RegExp(`'${forbidden}'`).test(code)) {
        fail('account-separation', `the rounding primitive names '${forbidden}' — a residual is not a gain, a loss or a variance (§55, §56)`);
      }
    }
    ok('the rounding primitive cannot return an FX or variance account (§55, §56)');
    if (/accounting\.rounding_residual_unbounded/.test(code)) {
      ok('an out-of-bounds residual is REFUSED — 6100 is not a balancing trash can (§55)');
    } else {
      fail('rounding', 'the rounding primitive does not refuse an unbounded residual (§55)');
    }
    if (/reason/.test(code)) ok('the caller must supply a reason for every residual (§55)');
    else fail('rounding', 'the rounding primitive takes no caller-supplied reason (§55)');
  }

  // §58: exactly one TypeScript implementation of the AL-09 conversion, and
  // exactly one in the database. A third would be a third answer.
  const conversionSources = Object.entries(collectAppFiles()).filter(([path, body]) => /function\s+convertToBaseMinor\b/.test(body) && path.endsWith('.ts'));
  if (conversionSources.length === 1) ok(`one TypeScript conversion implementation: ${conversionSources[0]?.[0]} (§58)`);
  else
    fail(
      'arithmetic',
      `${conversionSources.length} TypeScript implementations of convertToBaseMinor exist — §58 forbids a third arithmetic (${conversionSources.map((c) => c[0]).join(', ')})`,
    );
  const wholeTree = sqlFiles().map(readMigration).join('\n');
  const sqlConversions = (wholeTree.match(/base_minor|v_expected\s*:=\s*v_q/g) ?? []).length;
  if (/accounting\.entry_fx_arithmetic/.test(wholeTree) && sqlConversions > 0) {
    ok('the database keeps its one AL-09 implementation, inside accounting_assert_entry_valid (§58)');
  } else {
    fail('arithmetic', 'the database no longer validates the AL-09 conversion at COMMIT (§58)');
  }
  if (/convertToBaseMinor|accounting_convert|fx_convert/i.test(s5Sql())) {
    fail('arithmetic', '0048 adds a conversion routine — the FX slice records rates, it does not convert money (§58)');
  } else {
    ok('0048 adds no conversion arithmetic of its own (§58)');
  }
}

/**
 * Strip line and block comments and string literals from TypeScript source.
 *
 * Crude on purpose: this is a guard, not a parser. Everything it removes is
 * something a rule about CODE should not read anyway, and over-removal can
 * only make the guard quieter about prose, never about a real identifier.
 */
function stripTypeScriptComments(source: string): string {
  return stripTypeScriptProse(source)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/**
 * The same, but KEEPING string literals.
 *
 * A rule about which ACCOUNT a primitive may return is a rule about a string
 * literal, so those checks read this; a rule about which API a primitive may
 * call is a rule about identifiers, and those read the stricter version above.
 */
function stripTypeScriptProse(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
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
  for (const dir of ['apps/api/src', 'packages/accounting/src', 'packages/shared-contracts/src', 'scripts']) {
    const full = join(ROOT, dir);
    if (existsSync(full)) walk(full);
  }
  return out;
}

// ── 9. The merchant surface (§38-§40) and the shared canonicalization ──────
function checkSurfaceAndCanonicalization(): void {
  console.log('P2-S5 GATE — the merchant surface');

  const controller = join(ROOT, 'apps/api/src/modules/accounting/accounting.controller.ts');
  if (!existsSync(controller)) {
    fail('http-surface', 'the accounting controller is missing');
    return;
  }
  const body = readFileSync(controller, 'utf8');
  if (/@Post\(\s*'fx-rates'\s*\)/.test(body)) ok('POST …/accounting/fx-rates exists (§38)');
  else fail('http-surface', 'the FX route does not exist — §38 fixes it at POST /v1/businesses/:businessId/accounting/fx-rates');
  if (/@RequiresPermission\(\s*'accounting\.fx\.manage'\s*\)/.test(body)) ok('the route requires accounting.fx.manage, not accounting.post (§38)');
  else fail('http-surface', 'the FX route does not require accounting.fx.manage (§38)');
  if (/@(Get|Put|Patch|Delete)\(\s*'fx-rates/.test(body)) {
    fail('http-surface', 'the FX surface exposes a read, update or delete route — P2-S5 authorizes one POST (§38)');
  } else {
    ok('the FX surface is one POST: no list, no update, no delete (§38)');
  }

  const service = join(ROOT, 'apps/api/src/modules/accounting/accounting-fx.service.ts');
  if (existsSync(service)) {
    const code = stripTypeScriptComments(readFileSync(service, 'utf8'));
    if (/branchScopeMode\s*!==\s*''/.test(code) || /branchScopeMode/.test(code))
      ok('the service requires business-wide branch authority as a separate check (§38)');
    else fail('http-surface', 'the FX service does not check branch_scope_mode — a rate applies to every branch (§38)');
    if (/\b(enterTrusted|systemRate|skipAuthorization|forceEnter|postTrusted)\b/.test(code)) {
      fail('trusted-path', 'the FX service names a bypass seam — authority arrives as a minted assertion or the rate is not entered (§37)');
    } else {
      ok('the FX service has no trusted path, no skip flag and no system variant (§37)');
    }
    if (/enteredByUserId/.test(code) && !/dto\.enteredByUserId|body\.enteredByUserId/.test(code)) {
      ok('entered_by_user_id is never read from a payload (§37)');
    }
  } else {
    fail('engine', 'apps/api/src/modules/accounting/accounting-fx.service.ts is missing (§38)');
  }

  const schemas = join(ROOT, 'apps/api/src/modules/accounting/accounting.schemas.ts');
  if (existsSync(schemas)) {
    const code = readFileSync(schemas, 'utf8');
    const section = code.slice(code.indexOf('AccountingFxRateCreateSchema'));
    if (/\.strict\(\)/.test(section)) ok('the FX payload is .strict(): an unknown field is refused, never ignored (§39)');
    else fail('dto', 'AccountingFxRateCreateSchema is not .strict() (§39)');
    if (/rate:\s*z\.number|effectiveAt:\s*z\.date/.test(section)) {
      fail('dto', 'the FX DTO types the rate or the instant as a JSON number or Date — both cross HTTP as strings (§39)');
    } else {
      ok('the rate and the instant cross HTTP as strings (§39)');
    }
    if (/source:/.test(section)) fail('dto', 'the FX DTO accepts a source — the server fixes it (§40)');
    else ok('the FX DTO has no source field: provenance is the server’s (§40)');
  }

  const contracts = join(ROOT, 'packages/shared-contracts/src/index.ts');
  if (existsSync(contracts)) {
    const dto = readFileSync(contracts, 'utf8');
    const i = dto.indexOf('AccountingFxRateCreateDto');
    if (i >= 0 && /rate\??:\s*number/.test(dto.slice(i, i + 800))) {
      fail('money-shape', 'the FX DTO types the rate as a JS number — a double cannot hold a ten-digit rate (§39)');
    } else {
      ok('the public FX DTO carries the rate as a string (§39)');
    }
  }

  // §32: one canonicalization, two implementations, one vector source — and
  // never JSON.stringify, whose key order and number formatting are not a
  // specification.
  const vectors = join(ROOT, 'packages/accounting/vectors/fxrate-vectors.json');
  if (existsSync(vectors)) {
    const parsed = JSON.parse(readFileSync(vectors, 'utf8')) as { spec?: string; cases?: unknown[] };
    if (parsed.spec === 'fxrate/1' && (parsed.cases?.length ?? 0) >= 9) ok(`fxrate/1 vectors: ${parsed.cases?.length} shared cases (§32, §59)`);
    else fail('vectors', 'packages/accounting/vectors/fxrate-vectors.json does not carry the fxrate/1 vector set (§32, §59)');
  } else {
    fail('vectors', 'the shared fxrate/1 vector file is missing — one specification with two implementations needs one vector source (§32)');
  }
  const fxRateSrc = join(ROOT, 'packages/accounting/src/fx-rate.ts');
  if (existsSync(fxRateSrc)) {
    const code = stripTypeScriptComments(readFileSync(fxRateSrc, 'utf8'));
    if (/JSON\.stringify/.test(code))
      fail('canonicalization', 'the FX canonicalizer uses JSON.stringify — key order and number formatting are not a specification (§32)');
    else ok('the FX canonicalizer builds its own byte stream, never JSON.stringify (§32)');
  }
  // The PostgreSQL half must format the rate with a leading digit, or "0.709"
  // becomes ".7090000000" and the two implementations part company silently.
  if (/FM9+0\.0{10}/.test(s5Sql())) ok('the SQL canonicalizer’s mask forces a leading digit before the decimal point (§32, §59)');
  else fail('canonicalization', 'the SQL rate mask does not force a leading digit — 0.709 would canonicalize as .7090000000 (§32, §59)');
}

// ── 10. The behavioural regressions this slice may never lose (§78) ────────
//
// A structural check reads what the code SAYS. These are the cases that read
// what it DOES, and naming them here means deleting one fails the gate
// instead of quietly shrinking what "ready" means.
const REQUIRED_BEHAVIOUR: ReadonlyArray<{ file: string; needle: RegExp; what: string }> = [
  { file: 'tests/integration/accounting-fx-rates.test.ts', needle: /reciprocal/i, what: 'a lookup never inverts a rate (§19, §46)' },
  { file: 'tests/integration/accounting-fx-rates.test.ts', needle: /cross[- ]rate/i, what: 'a lookup never chains two pairs (§20, §46)' },
  { file: 'tests/integration/accounting-fx-rates.test.ts', needle: /implicit 1|implicit one/i, what: 'no implicit 1.0 for a foreign pair (§21, §46)' },
  {
    file: 'tests/integration/accounting-fx-rates.test.ts',
    needle: /schema OWNER|owner/i,
    what: 'immutability proved against a schema authority, not a missing grant (§45)',
  },
  { file: 'tests/security/accounting-fx-authority.test.ts', needle: /both directions/i, what: 'cross-protocol substitution fails in BOTH directions (§30)' },
  { file: 'tests/security/accounting-fx-authority.test.ts', needle: /tamper/i, what: 'the tamper matrix over every assertion claim (§61)' },
  { file: 'tests/security/accounting-fx-authority.test.ts', needle: /stolen|spoof/i, what: 'a stolen runtime credential cannot enter a rate (§60)' },
  { file: 'tests/integration/accounting-fx-concurrency.test.ts', needle: /same key/i, what: 'two real connections, one key (§35)' },
  { file: 'tests/integration/accounting-fx-concurrency.test.ts', needle: /audit|outbox/i, what: 'an audit or outbox failure rolls the rate back (§66)' },
  {
    file: 'tests/integration/accounting-fx-http.test.ts',
    needle: /BRANCH-SCOPED/i,
    what: 'a branch-scoped member holding the permission is still refused (§38)',
  },
  { file: 'tests/integration/accounting-fx-http.test.ts', needle: /Idempotency-Key/i, what: 'the key is required, and a replay changes nothing (§33)' },
  { file: 'tests/integration/accounting-fx-parity.test.ts', needle: /byte-identical/i, what: 'fxrate/1 is byte-identical in both implementations (§32)' },
  {
    file: 'tests/integration/accounting-fx-parity.test.ts',
    needle: /pinned value/i,
    what: "AL-09's conversion vectors, re-pinned in both implementations (§57)",
  },
  { file: 'packages/accounting/test/realized-fx.test.ts', needle: /fx_gain|fx_loss/, what: 'the eight pinned realized-FX examples (§52)' },
  { file: 'packages/accounting/test/fx-rate.test.ts', needle: /1\.0000000000/, what: 'the canonicalization equivalence cases (§59)' },
  { file: 'tests/integration/migration-upgrade.test.ts', needle: /0047-checkpoint/, what: 'the frozen 0047 → 0048 upgrade path (§71)' },
  {
    file: 'tests/integration/migration-portability.test.ts',
    needle: /0048 alone onto the frozen 0047 boundary/,
    what: '0048 installs under a non-superuser migrator (§70)',
  },
];

function checkBehaviouralRegressions(): void {
  console.log('P2-S5 GATE — the behavioural regressions');
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

// ── 11. Composed command matrix ────────────────────────────────────────────
interface Step {
  readonly name: string;
  readonly cmd: string;
  readonly args: readonly string[];
}

const STEPS: readonly Step[] = [
  // Every predecessor is PERMANENT. The P2-S4 gate composes P2-S3, which
  // composes P2-S2, P2-S1 and Phase 1, so running it once runs the whole
  // chain — and a regression anywhere in it fails here.
  { name: 'P2-S4 gate (permanent predecessor, composes P2-S3, P2-S2, P2-S1 and Phase 1)', cmd: npm, args: ['run', 'gate:phase2:s4'] },
  { name: 'migrations apply from zero under the migration principal', cmd: npm, args: ['run', 'check:db-from-zero'] },
  { name: '@daftar/accounting unit suite', cmd: npm, args: ['run', 'test', '-w', '@daftar/accounting'] },
  { name: 'P2-S5 registry, authority, concurrency, HTTP, parity and portability matrices', cmd: 'npx', args: ['vitest', 'run', ...P2_S5_TESTS] },
];

function runSteps(): void {
  console.log('P2-S5 GATE — composed regression matrix');
  for (const step of STEPS) {
    const started = Date.now();
    const res = spawnSync(step.cmd, [...step.args], { cwd: ROOT, encoding: 'utf8', stdio: 'inherit', env: process.env });
    const ms = Date.now() - started;
    if (res.status !== 0) fail('regression', `${step.name} failed (exit ${res.status ?? 'signal'}) after ${ms}ms`);
    else ok(`${step.name} (${ms}ms)`);
  }
}

if (LIST_ONLY) {
  console.log('P2-S5 GATE plan:');
  console.log('  structural: exactly one candidate migration, no 0049, 0048 NOT frozen, every frozen predecessor byte-identical');
  console.log('  structural: the registry’s type, composite ownership, currency registry, four physical rules and one index');
  console.log('  structural: append-only through an unconditional trigger, not through a missing grant');
  console.log('  structural: the lookup is max effective_at <= instant, with no reciprocal, cross-rate, implicit 1 or write');
  console.log('  structural: acctctl/1 is domain-separated, single-use and expiring; one definer command, owned, granted to daftar_app alone');
  console.log('  structural: no runtime DML, one runtime reader, RLS enabled and forced, nobody holds BYPASSRLS, G-5 clean');
  console.log(
    '  structural: both conflict codes, no overwrite, no leaked SQLSTATE, two narrow locks in a fixed order, one audit and one outbox event without the rate',
  );
  console.log('  structural: every clock reference in 0048 enumerated, no coalesce onto a clock, a NULL instant refused by name');
  console.log('  structural: the realized-FX and rounding primitives are pure, BigInt-only, bounded, and cannot reach each other’s account');
  console.log('  structural: one POST, accounting.fx.manage, business-wide authority, a strict string payload, a server-fixed source');
  console.log('  structural: one fxrate/1 vector source, no JSON.stringify, and a SQL mask that keeps the leading digit');
  console.log('  structural: every named behavioural regression exists');
  for (const s of STEPS) console.log(`  command:    ${s.cmd} ${s.args.join(' ')}`);
  process.exit(0);
}

checkMigrationBoundary();
checkRegistryShape();
checkImmutability();
checkLookup();
checkAuthority();
checkIdempotencyAndLocks();
checkClockAudit();
checkPurePrimitives();
checkSurfaceAndCanonicalization();
checkBehaviouralRegressions();
if (failures > 0) {
  console.error(`\nP2-S5 GATE: FAIL (${failures} structural violation${failures === 1 ? '' : 's'}) — not running the regression matrix`);
  process.exit(1);
}
runSteps();

if (failures > 0) {
  console.error(`\nP2-S5 GATE: FAIL (${failures})`);
  process.exit(1);
}
console.log('\nP2-S5 GATE: PASS');
