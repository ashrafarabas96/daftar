/**
 * invariant-live-rejection — plants a violation of each invariant against a
 * live, migrated database and reads the refusal (card P15-INV-C10).
 *
 * The semantic reading in docs/DAFTAR_INVARIANT_TRACEABILITY.md §7 is static:
 * "enforced" there means the constraint is written in the migration, not that
 * it refuses. This tool turns that into a measurement, one invariant at a
 * time, and it is built so that a case cannot pass by accident:
 *
 *   - the plant must be REFUSED (for a case whose expectation is 'reject'),
 *   - and its accept-control must be ACCEPTED in the same database, so a
 *     refusal that comes from a missing column, a missing parent row or a
 *     broken connection is not read as the invariant doing its work,
 *   - and a case whose expectation is 'accept' is a gap made positive: the
 *     violating row goes in, which is the evidence that nothing refuses it.
 *
 * Nothing is run against a database that matters. The target is created from
 * the source with CREATE DATABASE ... TEMPLATE, every case runs in its own
 * transaction, and the target is dropped on the way out unless --keep-target.
 * A deferred constraint trigger only fires at COMMIT, so each case commits:
 * that is why the copy exists.
 *
 *   INV_PROBE_URL          an admin connection string on the cluster; its
 *                          database is the one copied unless INV_PROBE_SOURCE_DB
 *                          names another
 *   INV_PROBE_SOURCE_DB    the migrated database to copy (default: the URL's)
 *   INV_PROBE_TARGET_DB    the copy to create and drop (default: invariant_probe)
 *   INV_PROBE_CASES        the case file (default: docs/invariants/live-rejection-cases.json)
 *   INV_PROBE_EVIDENCE_DIR where the evidence JSON is written (default: var/invariant-probe)
 *
 * Exit 0 only when every case was measured and every verdict matched its
 * expectation, with its control. Exit 1 on any mismatch, 2 on a usage or
 * environment error. A case that could not be measured is reported NOT_RUN and
 * is never counted as a pass.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Expectation = 'reject' | 'accept';

type Case = {
  /** The invariant this case measures, as §7.3 spells it. */
  id: string;
  /** What is being planted, in one line. */
  label: string;
  /** The mechanism the refusal is expected to come from, with file:line. */
  mechanism: string;
  /** Statements that must succeed before the plant: parent rows, nothing else. */
  setup?: string[];
  /** The one statement (or short transaction body) that violates the invariant. */
  plant: string;
  /** 'reject' for an enforced invariant; 'accept' for a gap proved positive. */
  expect: Expectation;
  /** Distinctive text the refusal must carry. Empty means "any refusal". */
  expectText?: string;
  /**
   * The nearest sibling that must be ACCEPTED. Without it a refusal proves
   * only that something in this statement is wrong, not that the invariant
   * refused. A case with no control cannot pass.
   */
  control: string[];
  /**
   * How the control's transaction ends. 'commit' is the default and the
   * stronger claim: the sibling row is still accepted when every deferred
   * guard has had its say. 'rollback' is for a mechanism that refuses AT the
   * statement, where the control only has to show that the statement itself is
   * accepted — a sibling stock movement, for instance, cannot be committed on
   * its own because the deferred binding foreign keys would refuse it at
   * COMMIT, and reading that refusal as "the control failed" would hide the
   * measurement instead of guarding it. Which ending was used is recorded in
   * the outcome, so the weaker claim is never read as the stronger one.
   */
  controlEnds?: 'commit' | 'rollback';
  /** Does the refusal arrive at COMMIT rather than at the statement? */
  deferred: boolean;
  /** Anything the reader needs that the fields above do not carry. */
  notes?: string;
};

type Outcome = {
  id: string;
  label: string;
  mechanism: string;
  expect: Expectation;
  /** 'PASS' only when the plant and its control both behaved as required. */
  status: 'PASS' | 'FAIL' | 'NOT_RUN';
  plantOutcome: 'rejected' | 'accepted' | 'unmeasured';
  sqlstate: string;
  message: string;
  controlOutcome: 'accepted' | 'rejected' | 'unmeasured';
  controlEnds: 'commit' | 'rollback';
  controlMessage: string;
  detail: string;
};

const PSQL_FLAGS = ['--no-psqlrc', '--no-password', '--set=ON_ERROR_STOP=1', '--set=VERBOSITY=verbose', '--quiet', '--tuples-only', '--no-align'];

function die(message: string): never {
  process.stdout.write(`${message}\n`);
  process.exit(2);
}

function parseUrl(raw: string): { host: string; port: string; user: string; password: string; database: string } {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new Error('not a postgres URL');
    const q = u.searchParams;
    return {
      host: u.hostname !== '' ? decodeURIComponent(u.hostname) : (q.get('host') ?? ''),
      port: u.port !== '' ? u.port : (q.get('port') ?? '5432'),
      user: u.username !== '' ? decodeURIComponent(u.username) : (q.get('user') ?? ''),
      password: u.password !== '' ? decodeURIComponent(u.password) : (q.get('password') ?? ''),
      database: decodeURIComponent(u.pathname.replace(/^\//, '')) || (q.get('dbname') ?? ''),
    };
  } catch {
    // Nothing of the input is printed: it carries the password.
    die('INV_PROBE_URL is not a connection string this tool can parse. Nothing of its content is printed here.');
  }
}

/** PG* variables, never argv: libpq echoes a connection string in its errors. */
function env(database: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env };
  delete out.INV_PROBE_URL;
  out.PGHOST = dsn.host;
  out.PGPORT = dsn.port;
  out.PGDATABASE = database;
  out.PGCONNECT_TIMEOUT = process.env.PGCONNECT_TIMEOUT ?? '10';
  if (dsn.user !== '') out.PGUSER = dsn.user;
  if (dsn.password !== '') out.PGPASSWORD = dsn.password;
  else delete out.PGPASSWORD;
  return out;
}

function scrub(text: string): string {
  let out = text;
  if (dsn.password !== '') out = out.split(dsn.password).join('«password»');
  return out;
}

function psql(database: string, sql: string): { out: string; err: string; code: number } {
  try {
    const out = execFileSync('psql', [...PSQL_FLAGS, '--command', sql], {
      env: env(database),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { out: scrub(out), err: '', code: 0 };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { out: scrub(e.stdout ?? ''), err: scrub(e.stderr ?? String(error)), code: e.status ?? 1 };
  }
}

/**
 * The SQLSTATE and the reason, as psql prints them under VERBOSITY=verbose:
 * `ERROR:  23514: new row ... violates check constraint "..."`. Measured on
 * this build rather than assumed, because the code sits in front of the reason
 * and an earlier form of this reader left the code empty while printing it
 * inside the message.
 */
function readFailure(stderr: string): { sqlstate: string; message: string } {
  const state =
    /^(?:ERROR|FATAL|PANIC):\s+([0-9A-Z]{5}):/m.exec(stderr) ??
    /^[A-Z]+:\s+\(?SQLSTATE\s+([0-9A-Z]{5})\)?/m.exec(stderr) ??
    /SQLSTATE\s+([0-9A-Z]{5})/.exec(stderr);
  const detail = /^(?:ERROR|FATAL|PANIC):\s+(.*)$/m.exec(stderr);
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  return { sqlstate: state?.[1] ?? '', message: (detail?.[1] ?? lines[0] ?? '').slice(0, 400) };
}

function loadCases(path: string): Case[] {
  if (!existsSync(path)) die(`the case file is not at ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    die(`${path} is not JSON`);
  }
  if (!Array.isArray(parsed)) die(`${path} must hold an array of cases`);
  const cases: Case[] = [];
  for (const [index, raw] of parsed.entries()) {
    const c = raw as Partial<Case>;
    const where = `case ${index + 1}${typeof c.id === 'string' ? ` (${c.id})` : ''}`;
    if (typeof c.id !== 'string' || c.id === '') die(`${where} has no id`);
    if (typeof c.label !== 'string' || c.label === '') die(`${where} has no label`);
    if (typeof c.mechanism !== 'string' || c.mechanism === '') die(`${where} has no mechanism`);
    if (typeof c.plant !== 'string' || c.plant === '') die(`${where} has no plant`);
    if (c.expect !== 'reject' && c.expect !== 'accept') die(`${where} must expect 'reject' or 'accept'`);
    if (!Array.isArray(c.control) || c.control.length === 0) {
      // A case without a control cannot pass, so it is refused at load time
      // rather than counted later.
      die(`${where} has no accept-control, and a refusal without one measures nothing`);
    }
    if (typeof c.deferred !== 'boolean') die(`${where} must say whether its refusal is deferred`);
    if (c.controlEnds !== undefined && c.controlEnds !== 'commit' && c.controlEnds !== 'rollback') {
      die(`${where} has a controlEnds that is neither 'commit' nor 'rollback'`);
    }
    if (c.controlEnds === 'rollback' && c.deferred) {
      // A deferred refusal is only visible at COMMIT, so a control that never
      // commits could not show that the sibling survives the guard it is meant
      // to pass. Allowing it would buy a green with a weaker measurement.
      die(`${where} is deferred, so its control must commit: a control that rolls back cannot pass a COMMIT-time guard`);
    }
    cases.push({
      id: c.id,
      label: c.label,
      mechanism: c.mechanism,
      setup: Array.isArray(c.setup) ? c.setup : [],
      plant: c.plant,
      expect: c.expect,
      expectText: typeof c.expectText === 'string' ? c.expectText : '',
      control: c.control as string[],
      controlEnds: c.controlEnds ?? 'commit',
      deferred: c.deferred,
      notes: typeof c.notes === 'string' ? c.notes : '',
    });
  }
  return cases;
}

/**
 * One transaction: the statements, then COMMIT or ROLLBACK. A plant always
 * commits, because a deferred constraint trigger refuses there and nowhere
 * earlier; a control may roll back, and which it did is reported.
 */
function attempt(database: string, statements: string[], ends: 'commit' | 'rollback' = 'commit'): { code: number; err: string } {
  const body = statements.map((s) => (s.trim().endsWith(';') ? s.trim() : `${s.trim()};`)).join('\n');
  const result = psql(database, `BEGIN;\n${body}\n${ends === 'commit' ? 'COMMIT' : 'ROLLBACK'};`);
  return { code: result.code, err: result.err };
}

const dsn = parseUrl(process.env.INV_PROBE_URL ?? die('INV_PROBE_URL is required'));
const sourceDb = process.env.INV_PROBE_SOURCE_DB ?? dsn.database;
const targetDb = process.env.INV_PROBE_TARGET_DB ?? 'invariant_probe';
const casePath = process.env.INV_PROBE_CASES ?? join('docs', 'invariants', 'live-rejection-cases.json');
const evidenceDir = process.env.INV_PROBE_EVIDENCE_DIR ?? join('var', 'invariant-probe');
const keepTarget = process.argv.includes('--keep-target');

if (sourceDb === '') die('INV_PROBE_URL carries no database and INV_PROBE_SOURCE_DB was not set');
if (targetDb === sourceDb) die('the target is the source; the probe writes to the target, so it must be another database');
if (!/_(probe|drill_target|restore)$|^invariant_probe$/.test(targetDb)) {
  die(`the target "${targetDb}" is not named as a throwaway; it must end in _probe, _drill_target or _restore`);
}

/**
 * The two cases that prove this tool can fail. They are not in the committed
 * case file, because that file has to run green, and a file carrying a case
 * that must come back FAIL would be read as a broken suite. They run under
 * --self-check, where their FAIL is the pass.
 */
const INVERSE_CONTROLS: Case[] = [
  {
    id: 'HARNESS-CONTROL-ITSELF-REFUSED',
    label: 'a case whose accept-control is itself refused must NOT pass',
    mechanism: 'a table that does not exist, named by both the plant and the control',
    plant: 'INSERT INTO probe_self_absent (x) VALUES (-1)',
    expect: 'reject',
    control: ['INSERT INTO probe_self_absent (x) VALUES (1)'],
    controlEnds: 'commit',
    deferred: false,
    notes: 'Expected FAIL: the plant is refused for the wrong reason and the control cannot show otherwise.',
  },
  {
    id: 'HARNESS-GAP-CLAIMED-ON-A-GUARD',
    label: 'a gap claimed where a CHECK exists must NOT pass',
    mechanism: 'a scratch table WITH a CHECK, declared as if nothing guarded it',
    setup: ['CREATE TABLE IF NOT EXISTS probe_self_guarded (x integer CHECK (x > 0))'],
    plant: 'INSERT INTO probe_self_guarded (x) VALUES (-1)',
    expect: 'accept',
    control: ['CREATE TABLE IF NOT EXISTS probe_self_guarded (x integer CHECK (x > 0))', 'INSERT INTO probe_self_guarded (x) VALUES (1)'],
    controlEnds: 'commit',
    deferred: false,
    notes: 'Expected FAIL: the row was refused, so the gap does not exist and must not be reported.',
  },
];

const selfCheck = process.argv.includes('--self-check');
const cases = selfCheck ? loadCases(join('docs', 'invariants', 'harness-self-controls.json')) : loadCases(casePath);
const outcomes: Outcome[] = [];

// The copy. CREATE DATABASE ... TEMPLATE refuses while another session is
// connected to the source, which is the behaviour wanted: a probe is not run
// beside live traffic.
const dropFirst = psql('postgres', `DROP DATABASE IF EXISTS "${targetDb}"`);
if (dropFirst.code !== 0) die(`the target could not be dropped before the copy: ${readFailure(dropFirst.err).message}`);
const copy = psql('postgres', `CREATE DATABASE "${targetDb}" TEMPLATE "${sourceDb}"`);
if (copy.code !== 0) die(`the copy of "${sourceDb}" could not be made: ${readFailure(copy.err).message}`);

const identity = psql(targetDb, `SELECT system_identifier::text || ' ' || current_catalog FROM pg_control_system()`);
const migrations = psql(targetDb, `SELECT count(*)::text FROM schema_migrations`);

for (const c of [...cases, ...(selfCheck ? INVERSE_CONTROLS : [])]) {
  const planted = attempt(targetDb, [...(c.setup ?? []), c.plant]);
  const plantFailure = readFailure(planted.err);
  const plantOutcome = planted.code === 0 ? 'accepted' : 'rejected';

  const controlEnds = c.controlEnds ?? 'commit';
  const controlled = attempt(targetDb, c.control, controlEnds);
  const controlFailure = readFailure(controlled.err);
  const controlOutcome = controlled.code === 0 ? 'accepted' : 'rejected';

  const wantedText = c.expectText ?? '';
  const textMatches = wantedText === '' || planted.err.includes(wantedText);
  const wanted = c.expect === 'reject' ? 'rejected' : 'accepted';
  const reasons: string[] = [];
  if (plantOutcome !== wanted) reasons.push(`the plant was ${plantOutcome} where ${wanted} was required`);
  if (controlOutcome !== 'accepted') {
    reasons.push(`the accept-control was refused (${controlFailure.message}), so a refusal of the plant would measure nothing`);
  }
  if (c.expect === 'reject' && plantOutcome === 'rejected' && !textMatches) {
    reasons.push(`the refusal did not carry ${JSON.stringify(wantedText)}, so it may be a different refusal`);
  }

  outcomes.push({
    id: c.id,
    label: c.label,
    mechanism: c.mechanism,
    expect: c.expect,
    status: reasons.length === 0 ? 'PASS' : 'FAIL',
    plantOutcome,
    controlEnds,
    sqlstate: plantFailure.sqlstate,
    message: plantFailure.message,
    controlOutcome,
    controlMessage: controlFailure.message,
    detail: reasons.length === 0 ? `the plant was ${plantOutcome} and the control was accepted (control ended in ${controlEnds})` : reasons.join('; '),
  });
}

if (!keepTarget) {
  const dropped = psql('postgres', `DROP DATABASE IF EXISTS "${targetDb}"`);
  if (dropped.code !== 0) {
    process.stdout.write(`WARNING the probe copy "${targetDb}" could not be dropped: ${readFailure(dropped.err).message}\n`);
  }
}

const inverseIds = new Set(INVERSE_CONTROLS.map((c) => c.id));
const ordinary = outcomes.filter((o) => !inverseIds.has(o.id));
const inverse = outcomes.filter((o) => inverseIds.has(o.id));
const passed = ordinary.filter((o) => o.status === 'PASS').length;
const failed = ordinary.filter((o) => o.status === 'FAIL').length;
const notRun = cases.length - ordinary.length;
// Under --self-check the two inverse controls must come back FAIL: that is
// what proves this tool can fail at all. An inverse control that passed would
// mean the reader accepts a refused control, or a gap where a guard stands.
const inverseWrong = inverse.filter((o) => o.status !== 'FAIL');
const verdict = failed === 0 && notRun === 0 && inverseWrong.length === 0 && (!selfCheck || inverse.length === INVERSE_CONTROLS.length) ? 'PASS' : 'FAIL';

for (const o of ordinary) {
  process.stdout.write(`${o.status.padEnd(7)} ${o.id} — ${o.label}\n`);
  process.stdout.write(`        ${o.detail}${o.sqlstate === '' ? '' : ` [SQLSTATE ${o.sqlstate}]`}\n`);
  if (o.message !== '') process.stdout.write(`        refusal: ${o.message}\n`);
}
for (const o of inverse) {
  const right = o.status === 'FAIL';
  process.stdout.write(`${(right ? 'PASS' : 'FAIL').padEnd(7)} ${o.id} — ${o.label}\n`);
  process.stdout.write(`        it came back ${o.status}, where FAIL is what proves the reader can refuse: ${o.detail}\n`);
}

mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
const evidencePath = join(evidenceDir, 'invariant-live-rejection.json');
writeFileSync(
  evidencePath,
  `${JSON.stringify(
    {
      tool: 'scripts/invariant-live-rejection.ts',
      at: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      cluster: identity.out.trim(),
      source: sourceDb,
      target: targetDb,
      migrationsApplied: migrations.code === 0 ? Number(migrations.out.trim()) : null,
      cases: cases.length,
      passed,
      failed,
      notRun,
      selfCheck,
      inverseControls: inverse.map((o) => ({ id: o.id, status: o.status, required: 'FAIL' })),
      outcomes,
      verdict,
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);

process.stdout.write(`\nevidence ${evidencePath}\n`);
if (selfCheck) {
  process.stdout.write(`self-check — ${inverse.length} inverse controls, ${inverse.length - inverseWrong.length} of them FAILED as required\n`);
}
process.stdout.write(`verdict ${verdict} — ${passed} passed, ${failed} failed, ${notRun} not run of ${cases.length}\n`);
process.exit(verdict === 'PASS' ? 0 : 1);
