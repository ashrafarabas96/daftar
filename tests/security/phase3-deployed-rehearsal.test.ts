/**
 * P3-S9 T-10 — THE DEPLOYED REHEARSAL'S DECISIONS, EACH ABLE TO SAY NO.
 *
 * `scripts/phase3-deployed-rehearsal.ts` (A-10) builds the database as
 * `daftar_migrator`, runs a pinned list of business and authority suites on
 * it, and then checks that nobody else applied anything. Its decisions are
 * exported pure functions, proved here red on a planted defect and green on
 * the accepted shape. The live run is `npm run rehearse:phase3:deployed`
 * (release gate step 8).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PHASE2_PREFIX } from '../../scripts/phase2-prefix';
import { PHASE3_PREFIX } from '../../scripts/phase3-prefix';
import {
  DEPLOYED_SUITES,
  appliedSetProblems,
  historyDifferences,
  historyDigest,
  principalProblems,
  vitestReportProblems,
  type HistoryRow,
  type VitestReport,
} from '../../scripts/phase3-deployed-rehearsal';

const REPO = join(__dirname, '../..');
const MIGRATIONS = join(REPO, 'infrastructure/database/migrations');
const SCRIPT = join(REPO, 'scripts/phase3-deployed-rehearsal.ts');

/** The script's code: block comments and whole-line comments removed. */
const code = (): string =>
  readFileSync(SCRIPT, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');

describe('step 3 — the applying session is the deployer and nothing more', () => {
  const deployer = { current_user: 'daftar_migrator', session_user: 'daftar_migrator', rolsuper: false, rolbypassrls: false };

  it('accepts daftar_migrator, not superuser, without BYPASSRLS', () => {
    expect(principalProblems(deployer)).toEqual([]);
  });

  it('refuses a superuser', () => {
    expect(principalProblems({ ...deployer, rolsuper: true })).toEqual(['daftar_migrator is a superuser']);
  });

  it('refuses BYPASSRLS', () => {
    expect(principalProblems({ ...deployer, rolbypassrls: true })).toEqual(['daftar_migrator bypasses row-level security']);
  });

  it('refuses any other principal, or a session that switched role', () => {
    expect(principalProblems({ ...deployer, current_user: 'postgres', session_user: 'postgres' })).toEqual([
      'current_user is postgres, not daftar_migrator',
      'session_user is postgres, not daftar_migrator',
    ]);
    expect(principalProblems({ ...deployer, session_user: 'postgres' })).toEqual(['session_user is postgres, not daftar_migrator']);
    expect(principalProblems(undefined)).toEqual(['the applying session did not describe itself']);
  });
});

const sha = (file: string): string =>
  createHash('sha256')
    .update(readFileSync(join(MIGRATIONS, file)))
    .digest('hex');
const onDisk = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const PREFIX = [...PHASE2_PREFIX, ...PHASE3_PREFIX];

describe('step 4 — every file on disk is applied, and the history holds both accepted prefixes', () => {
  const history = onDisk.map((name) => ({ name, sha256: sha(name) }));

  it('passes on the real tree', () => {
    expect(appliedSetProblems(onDisk, onDisk, history, PREFIX)).toEqual([]);
  });

  it('permits a later forward migration', () => {
    // Named to sort after every real file: the corrective 0070+ are on disk.
    const later = '9999_a_later_forward_migration.sql';
    expect(appliedSetProblems([...onDisk, later], [...onDisk, later], [...history, { name: later, sha256: 'f'.repeat(64) }], PREFIX)).toEqual([]);
  });

  it('refuses a file on disk the deployer did not apply', () => {
    const problems = appliedSetProblems(onDisk.slice(0, -1), onDisk, history, PREFIX);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`not applied: ${onDisk.at(-1) ?? ''}`);
  });

  it('refuses an applied history whose accepted digest changed', () => {
    const tampered = history.map((r) => (r.name === '0064_purchase_commands.sql' ? { ...r, sha256: '0'.repeat(64) } : r));
    expect(appliedSetProblems(onDisk, onDisk, tampered, PREFIX)).toEqual([
      `the history records 0064_purchase_commands.sql at 000000000000… but it was accepted at ${sha('0064_purchase_commands.sql').slice(0, 12)}…`,
    ]);
  });

  it('refuses a history that lacks an accepted entry or ends early', () => {
    expect(
      appliedSetProblems(
        onDisk,
        onDisk,
        history.filter((r) => r.name !== '0060_inventory_stock_primitive.sql'),
        PREFIX,
      )[0],
    ).toMatch(/^history entry \d+ is 0061_inventory_movement_sources\.sql; the accepted prefix has 0060_inventory_stock_primitive\.sql there$/);
    expect(appliedSetProblems(onDisk, onDisk, history.slice(0, 60), PREFIX)[0]).toMatch(/^the history ends before 0060_/);
  });
});

const row = (name: string, sha256 = 'a'.repeat(64), appliedAt = '2026-09-27T10:00:00.000Z'): HistoryRow => ({ name, sha256, appliedAt });

describe('step 7 — the history after the suites is exactly the snapshot', () => {
  const before = [row('0068_x.sql'), row('0069_y.sql')];

  it('passes when nothing changed', () => {
    expect(historyDifferences(before, [...before])).toEqual([]);
    expect(historyDigest(before)).toBe(historyDigest([...before].reverse()));
  });

  it('flags an added row', () => {
    expect(historyDifferences(before, [...before, row('0070_z.sql')])).toEqual(['0070_z.sql was added to the history during the suites']);
  });

  it('flags a changed digest', () => {
    expect(historyDifferences(before, [before[0] ?? row('?'), row('0069_y.sql', 'b'.repeat(64))])).toEqual([
      '0069_y.sql changed digest from aaaaaaaaaaaa… to bbbbbbbbbbbb…',
    ]);
  });

  it('flags a removed row', () => {
    expect(historyDifferences(before, before.slice(0, 1))).toEqual(['0069_y.sql was removed from the history during the suites']);
  });

  it('flags a row applied again', () => {
    const again = [before[0] ?? row('?'), row('0069_y.sql', 'a'.repeat(64), '2026-09-27T11:00:00.000Z')];
    expect(historyDifferences(before, again)).toEqual(['0069_y.sql was re-applied at 2026-09-27T11:00:00.000Z']);
    expect(historyDigest(again)).not.toBe(historyDigest(before));
  });
});

describe('step 6 — the pinned suites', () => {
  it('are exactly the A-10 list, and every one exists', () => {
    expect(DEPLOYED_SUITES).toEqual([
      'tests/integration/phase3-s8-reconciliation.test.ts',
      'tests/integration/accounting-reconciliation.test.ts',
      'tests/integration/phase3-s8-mixed-sequence.test.ts',
      'tests/security/phase3-s8-grant-matrix.test.ts',
      'tests/security/phase3-s8-definer-law.test.ts',
      'tests/integration/web-s7-client-contract.test.ts',
      'tests/integration/read-s7-freshness.test.ts',
    ]);
    for (const s of DEPLOYED_SUITES) expect(existsSync(join(REPO, s)), s).toBe(true);
  });

  const report = (patch: Partial<VitestReport> = {}): VitestReport => ({
    numTotalTests: 42,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    success: true,
    testResults: DEPLOYED_SUITES.map((s) => ({ name: join(REPO, s), status: 'passed' })),
    ...patch,
  });

  it('pass when every suite ran and passed', () => {
    expect(vitestReportProblems(report(), DEPLOYED_SUITES, REPO)).toEqual([]);
  });

  it('fail on a failed test, a failed suite, or an unsuccessful run', () => {
    expect(vitestReportProblems(report({ numFailedTests: 1, success: false }), DEPLOYED_SUITES, REPO)).toEqual([
      '1 test(s) failed',
      'vitest reported the run unsuccessful',
    ]);
    const failedSuite = report({ testResults: DEPLOYED_SUITES.map((s, i) => ({ name: join(REPO, s), status: i === 3 ? 'failed' : 'passed' })) });
    expect(vitestReportProblems(failedSuite, DEPLOYED_SUITES, REPO)).toEqual(['tests/security/phase3-s8-grant-matrix.test.ts failed']);
  });

  it('fail on a suite that never ran, on a skipped test, on no test at all, and on no report', () => {
    const missing = report({ testResults: DEPLOYED_SUITES.slice(1).map((s) => ({ name: join(REPO, s), status: 'passed' })) });
    expect(vitestReportProblems(missing, DEPLOYED_SUITES, REPO)).toEqual(['tests/integration/phase3-s8-reconciliation.test.ts did not run']);
    expect(vitestReportProblems(report({ numPendingTests: 1 }), DEPLOYED_SUITES, REPO)).toEqual(['1 test(s) skipped or todo']);
    expect(vitestReportProblems(report({ numTotalTests: 0 }), DEPLOYED_SUITES, REPO)).toEqual(['vitest ran no test']);
    expect(vitestReportProblems(undefined, DEPLOYED_SUITES, REPO)).toEqual(['vitest wrote no report']);
  });
});

describe('the script', () => {
  it('compares the applied set with the files on disk, never with a migration count', () => {
    expect(code()).not.toMatch(/\b(?:53|69|70)\b/);
    expect(code()).not.toMatch(/\.length\s*(?:[!=]==?|[<>]=?)\s*[1-9]/);
    expect(code()).toMatch(/readdirSync\(MIGRATIONS_DIR\)/);
  });

  it('builds its own cluster on its own port, apart from the harness default', () => {
    expect(code()).toMatch(/process\.env\['REHEARSAL_PG_PORT'\] \?\? 55471/);
    expect(code()).not.toMatch(/process\.env\['PG_PORT'\] \?\?/);
  });

  it('records the applier-owned SECURITY DEFINER routines and holds them to none (TD-18, 0070)', () => {
    expect(code()).toMatch(/APPLIER_OWNED_DEFINERS_QUERY, \[DEPLOYER\]/);
    expect(code()).toMatch(/artefact\['applierOwnedDefiners'\] = \{ pinned: APPLIER_OWNED_DEFINERS, observed: owned \}/);
    expect(code()).toMatch(/record\('7\.3 the deployer owns no SECURITY DEFINER routine', ownership\.length === 0/);
  });

  it('records the four TD-18 routines with their internal owners and the pinned path (7.4)', () => {
    expect(code()).toMatch(/query<Td18DefinerRow>\(ownerUrl, TD18_DEFINER_OWNERS_QUERY\)/);
    expect(code()).toMatch(/artefact\['td18Definers'\] = td18Rows/);
    expect(code()).toMatch(/'7\.4 the TD-18 routines have their internal owners and the pinned path',\s*td18\.length === 0/);
  });

  it('can report its own failure: the exit guard is installed before main runs', () => {
    // embedded-postgres exits through a hook with a hard-coded 0. Without the
    // guard, the first live run wrote verdict FAIL and exited 0.
    expect(code()).toMatch(/if \(require\.main === module\) \{\s*protectFailingExitCode\(\);\s*void main\(\)/);
    expect(code()).toMatch(/process\.exitCode = 1;/);
  });

  it('never blocks its own event loop while the suites run: the server log pipe must keep draining', () => {
    expect(code()).not.toMatch(/\bspawnSync\b|\bexecSync\b|\bexecFileSync\b/);
    expect(code()).toMatch(/await new Promise<\{ status: number \| null; signal: NodeJS\.Signals \| null \}>/);
  });

  it('importing it runs nothing', () => {
    const child = spawnSync(
      join(REPO, 'node_modules/.bin/tsx'),
      ['-e', "const m = require('./scripts/phase3-deployed-rehearsal.ts'); console.log('IMPORTED', typeof m.principalProblems);"],
      { cwd: REPO, encoding: 'utf8', env: { ...process.env, REHEARSAL_PG_PORT: '1' } },
    );
    expect(child.status).toBe(0);
    expect(child.stdout).toContain('IMPORTED function');
    expect(`${child.stdout}${child.stderr}`).not.toMatch(/DEPLOYED REHEARSAL|DEPLOYMENT AUTHORITY/);
  });
});
