#!/usr/bin/env tsx
/**
 * ─────────────────────────────────────────────────────────────────────────
 * P3-S9 — THE BUSINESS, RUN ON THE DATABASE THE DEPLOYER BUILT (A-10)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `npm run check:deployment-authority` proves the deployment principal builds
 * the same catalogue a superuser builds. It does not prove the runtime
 * principals can RUN THE BUSINESS on that database: every functional suite
 * applies the history as a superuser (`tests/helpers/test-app.ts`,
 * `runMigrations(dbUrl)` with the `postgres` URL), and so does `db-from-zero`.
 * A suite that applies migrations as a superuser never asks the deployer's
 * questions.
 *
 * This script asks them, in eight steps:
 *
 *   1. its OWN embedded cluster: a fresh data directory that no earlier run
 *      touched, on `REHEARSAL_PG_PORT` (default 55471); a server already
 *      answering on that port is refused, never reused;
 *   2. `daftar` created and `bootstrap.sql` applied by the administrator, the
 *      harness's own `applyBootstrap`, so the fixture credentials match;
 *   3. a session as `daftar_migrator` that must describe itself as
 *      `daftar_migrator / daftar_migrator / not superuser / no BYPASSRLS`;
 *   4. `runMigrations` over that session applies every `.sql` file on disk and
 *      a second call applies none; the history holds `PHASE2_PREFIX` then
 *      `PHASE3_PREFIX` at their accepted digests. The number of files is never
 *      compared with a constant: a permanent script that counts files forbids
 *      evolution;
 *   5. `schema_migrations` is snapshotted;
 *   6. the pinned `DEPLOYED_SUITES` run in a child `vitest` on the same
 *      cluster. Its global setup finds a listening server, nothing to apply,
 *      and installs the three assertion keys;
 *   7. afterwards `schema_migrations` must equal the snapshot — no other
 *      principal applied anything, so the suites ran on the deployer's schema —
 *      and no runtime role, and not PUBLIC, may hold TEMPORARY or CREATE on
 *      `public`;
 *   8. `release/phase3-s9-deployed-rehearsal.json` is written and the cluster
 *      is stopped and removed.
 *
 * A failure here that the same suite does not show on the superuser-built CI
 * database is a DEPLOYMENT FINDING, not a flaky test. It is triaged, never
 * excluded from the list.
 *
 * Usage: npm run rehearse:phase3:deployed
 *
 * Importing this module runs nothing; the decisions are exported for
 * `tests/security/phase3-deployed-rehearsal.test.ts`.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Client } from 'pg';
import {
  APPLIER_OWNED_DEFINERS,
  APPLIER_OWNED_DEFINERS_QUERY,
  applierOwnedDefinerProblems,
  namespacePrivilegeProblems,
  TD18_DEFINER_OWNERS_QUERY,
  td18DefinerProblems,
  type Td18DefinerRow,
  PUBLIC_GRANTEE,
  type NamespacePrivilegeRow,
} from './phase2-deployment-authority';
import { PHASE2_PREFIX } from './phase2-prefix';
import { PHASE3_PREFIX } from './phase3-prefix';
import { protectFailingExitCode } from '../tests/helpers/exit-code';

const ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(ROOT, 'infrastructure/database/migrations');
const ARTEFACT = join(ROOT, 'release/phase3-s9-deployed-rehearsal.json');

/** The deployment principal the whole rehearsal is about. */
export const DEPLOYER = 'daftar_migrator';

/**
 * The suites that run on the deployer-built database (A-10), pinned. Short on
 * purpose (TL-6): reconciliation, grants, the definer law, the Android-callable
 * surface and freshness.
 */
export const DEPLOYED_SUITES: readonly string[] = [
  'tests/integration/phase3-s8-reconciliation.test.ts',
  'tests/integration/accounting-reconciliation.test.ts',
  'tests/integration/phase3-s8-mixed-sequence.test.ts',
  'tests/security/phase3-s8-grant-matrix.test.ts',
  'tests/security/phase3-s8-definer-law.test.ts',
  'tests/integration/web-s7-client-contract.test.ts',
  'tests/integration/read-s7-freshness.test.ts',
];

// ─────────────────────────────────────────────────────────────────────────
// THE DECISIONS, AS PURE FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────

/** The applying session, as it describes itself. */
export interface PrincipalRow {
  readonly current_user: string;
  readonly session_user: string;
  readonly rolsuper: boolean;
  readonly rolbypassrls: boolean;
}

/** Step 3 — the session that applies the history is the deployer and nothing more. */
export function principalProblems(row: PrincipalRow | undefined): string[] {
  if (row === undefined) return ['the applying session did not describe itself'];
  const problems: string[] = [];
  if (row.current_user !== DEPLOYER) problems.push(`current_user is ${row.current_user}, not ${DEPLOYER}`);
  if (row.session_user !== DEPLOYER) problems.push(`session_user is ${row.session_user}, not ${DEPLOYER}`);
  if (row.rolsuper !== false) problems.push(`${row.current_user} is a superuser`);
  if (row.rolbypassrls !== false) problems.push(`${row.current_user} bypasses row-level security`);
  return problems;
}

/** One row of `schema_migrations`. */
export interface HistoryRow {
  readonly name: string;
  readonly sha256: string;
  readonly appliedAt: string;
}

/**
 * Step 4 — the deployer applied every file on disk, in order, and the history
 * it wrote begins with the Phase 2 prefix followed by the Phase 3 prefix, each
 * name at its accepted digest. Files after the prefixes are permitted.
 */
export function appliedSetProblems(
  applied: readonly string[],
  onDisk: readonly string[],
  history: readonly Pick<HistoryRow, 'name' | 'sha256'>[],
  prefix: readonly (readonly [name: string, sha256: string])[],
): string[] {
  const problems: string[] = [];
  const disk = [...onDisk].sort();
  if (applied.length !== disk.length || applied.some((f, i) => f !== disk[i])) {
    const missing = disk.filter((f) => !applied.includes(f));
    const extra = applied.filter((f) => !disk.includes(f));
    problems.push(
      `the deployer applied ${applied.length} file(s) but ${disk.length} are on disk` +
        (missing.length > 0 ? `; not applied: ${missing.join(', ')}` : '') +
        (extra.length > 0 ? `; not on disk: ${extra.join(', ')}` : '') +
        (missing.length === 0 && extra.length === 0 ? '; the order differs' : ''),
    );
  }
  const ordered = [...history].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  prefix.forEach(([name, sha256], i) => {
    const row = ordered[i];
    if (row === undefined) problems.push(`the history ends before ${name}`);
    else if (row.name !== name) problems.push(`history entry ${i} is ${row.name}; the accepted prefix has ${name} there`);
    else if (row.sha256 !== sha256) problems.push(`the history records ${name} at ${row.sha256.slice(0, 12)}… but it was accepted at ${sha256.slice(0, 12)}…`);
  });
  return problems;
}

/** Step 7 — every way the history after the suites differs from the snapshot before them. */
export function historyDifferences(before: readonly HistoryRow[], after: readonly HistoryRow[]): string[] {
  const problems: string[] = [];
  const was = new Map(before.map((r) => [r.name, r] as const));
  const now = new Map(after.map((r) => [r.name, r] as const));
  for (const r of after) {
    const prev = was.get(r.name);
    if (prev === undefined) problems.push(`${r.name} was added to the history during the suites`);
    else if (prev.sha256 !== r.sha256) problems.push(`${r.name} changed digest from ${prev.sha256.slice(0, 12)}… to ${r.sha256.slice(0, 12)}…`);
    else if (prev.appliedAt !== r.appliedAt) problems.push(`${r.name} was re-applied at ${r.appliedAt}`);
  }
  for (const r of before) if (!now.has(r.name)) problems.push(`${r.name} was removed from the history during the suites`);
  return problems;
}

/** The part of vitest's JSON report the verdict reads. */
export interface VitestReport {
  readonly numTotalTests: number;
  readonly numFailedTests: number;
  readonly numPendingTests: number;
  readonly numTodoTests: number;
  readonly success: boolean;
  readonly testResults: readonly { readonly name: string; readonly status: string }[];
}

/**
 * Step 6 — every pinned suite ran and passed, nothing failed, nothing was
 * skipped, and at least one test ran. A suite the runner never loaded is a
 * failure, not an absence.
 */
export function vitestReportProblems(report: VitestReport | undefined, suites: readonly string[], root: string): string[] {
  if (report === undefined) return ['vitest wrote no report'];
  const problems: string[] = [];
  if (report.numTotalTests === 0) problems.push('vitest ran no test');
  if (report.numFailedTests !== 0) problems.push(`${report.numFailedTests} test(s) failed`);
  if (report.numPendingTests + report.numTodoTests !== 0) problems.push(`${report.numPendingTests + report.numTodoTests} test(s) skipped or todo`);
  if (!report.success) problems.push('vitest reported the run unsuccessful');
  const byFile = new Map(report.testResults.map((t) => [relative(root, t.name).split('\\').join('/'), t.status] as const));
  for (const s of suites) {
    const status = byFile.get(s);
    if (status === undefined) problems.push(`${s} did not run`);
    else if (status !== 'passed') problems.push(`${s} ${status}`);
  }
  return problems;
}

/** The history's digest: one line per row, in name order. */
export function historyDigest(rows: readonly HistoryRow[]): string {
  const lines = [...rows]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((r) => `${r.name} ${r.sha256} ${r.appliedAt}`)
    .join('\n');
  return createHash('sha256').update(lines).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────
// THE LIVE REHEARSAL
// ─────────────────────────────────────────────────────────────────────────

/** The rehearsal stops rather than rehearse on a database it cannot vouch for. */
class RehearsalRefusal extends Error {
  constructor(reason: string) {
    super(`refused: ${reason}`);
    this.name = 'RehearsalRefusal';
  }
}

interface Step {
  readonly step: string;
  readonly ok: boolean;
  readonly detail: string;
}

async function query<T extends Record<string, unknown>>(url: string, text: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(text, params)).rows;
  } finally {
    await client.end();
  }
}

async function answers(url: string): Promise<boolean> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch (e) {
    const code = e instanceof Error && 'code' in e ? String(e.code) : '';
    const message = e instanceof Error ? e.message : String(e);
    // Nothing listening. Anything else means something answered, even if it
    // refused these credentials, and that server is not this rehearsal's.
    return !(code === 'ECONNREFUSED' || /ECONNREFUSED|timeout/i.test(message));
  }
}

async function readHistory(url: string): Promise<HistoryRow[]> {
  const rows = await query<{ name: string; sha256: string; applied_at: Date }>(url, 'SELECT name, sha256, applied_at FROM schema_migrations ORDER BY name');
  return rows.map((r) => ({ name: r.name, sha256: r.sha256, appliedAt: r.applied_at.toISOString() }));
}

async function namespacePrivileges(url: string): Promise<NamespacePrivilegeRow[]> {
  const roles = (await query<{ r: string }>(url, `SELECT rolname AS r FROM pg_roles WHERE rolname LIKE 'daftar\\_%' ORDER BY 1`)).map((x) => x.r);
  const rows: NamespacePrivilegeRow[] = [];
  for (const role of [...roles, PUBLIC_GRANTEE]) {
    const [p] = await query<{ temp: boolean; create_public: boolean }>(
      url,
      `SELECT has_database_privilege($1, current_database(), 'TEMPORARY') AS temp, has_schema_privilege($1, 'public', 'CREATE') AS create_public`,
      [role === PUBLIC_GRANTEE ? 'public' : role],
    );
    if (p === undefined) throw new RehearsalRefusal(`the privilege query returned no row for ${role}`);
    rows.push({ role, temporaryOnDatabase: p.temp, createOnPublic: p.create_public });
  }
  return rows;
}

async function main(): Promise<void> {
  const port = Number(process.env['REHEARSAL_PG_PORT'] ?? 55471);
  // A path no earlier run touched. The embedded server creates and owns the
  // directory itself (initdb refuses one that root created), so the path is
  // unique rather than pre-made.
  const pgDir = join(tmpdir(), `daftar-deployed-rehearsal-${randomUUID()}`);
  const steps: Step[] = [];
  const findings: string[] = [];
  const record = (step: string, ok: boolean, detail: string): void => {
    steps.push({ step, ok, detail });
    console.log(`${ok ? '  ok     ' : '  FAIL   '} ${step} — ${detail}`);
    if (!ok) findings.push(`${step}: ${detail}`);
  };

  // The harness reads its cluster from the environment when it is loaded, so
  // the environment is set first and the harness imported after.
  process.env['PG_DIR'] = pgDir;
  process.env['PG_PORT'] = String(port);
  const cluster = await import('../tests/helpers/embedded-cluster');
  const { ensureEmbeddedPgBinariesExecutable } = await import('./ensure-embedded-pg-binaries');
  const { runMigrations } = await import('../apps/api/src/infra/migrate');
  const { default: EmbeddedPostgres } = await import('embedded-postgres');

  const ownerUrl = `postgresql://${cluster.PG_USER}:${cluster.PG_PASSWORD}@localhost:${port}/daftar`;
  const migratorUrl = `postgresql://${DEPLOYER}:${cluster.MIGRATOR_DB_PASSWORD}@localhost:${port}/daftar`;
  const artefact: Record<string, unknown> = {
    produced: 'scripts/phase3-deployed-rehearsal.ts',
    producedAt: new Date().toISOString(),
    node: process.version,
    cluster: { port, dataDirectory: pgDir },
    deploymentPrincipal: DEPLOYER,
    suites: DEPLOYED_SUITES,
  };

  console.log(`\nDEPLOYED REHEARSAL — own cluster on port ${port}, ${pgDir}`);
  const occupied = await answers(cluster.adminUrl);
  record(
    '1 the rehearsal starts its own cluster',
    !occupied,
    occupied ? `a server already answers on port ${port}; the rehearsal never reuses one` : `nothing listens on ${port}; fresh data directory`,
  );
  ensureEmbeddedPgBinariesExecutable();
  const pg = new EmbeddedPostgres({ databaseDir: pgDir, user: cluster.PG_USER, password: cluster.PG_PASSWORD, port, persistent: false });
  let started = false;
  try {
    if (occupied) throw new RehearsalRefusal(`port ${port} is taken`);
    await pg.initialise();
    await pg.start();
    started = true;
    const [version] = await query<{ v: string }>(cluster.adminUrl, `SELECT current_setting('server_version') AS v`);
    artefact['postgres'] = version?.v ?? null;

    // 2 — the administrator's database and bootstrap, and nothing else.
    await pg.createDatabase('daftar');
    await cluster.applyBootstrap('daftar');
    record('2 bootstrap applied by the administrator', true, `database daftar on PostgreSQL ${String(artefact['postgres'])}`);

    // 3 — the applying principal.
    const [principal] = await query<{ current_user: string; session_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
      migratorUrl,
      `SELECT current_user::text AS current_user, session_user::text AS session_user, r.rolsuper, r.rolbypassrls
         FROM pg_roles r WHERE r.rolname = current_user`,
    );
    artefact['principal'] = principal ?? null;
    const who = principalProblems(principal);
    record('3 the applying session is the deployer, not a superuser, without BYPASSRLS', who.length === 0, who.join('; ') || JSON.stringify(principal));
    if (who.length > 0) throw new RehearsalRefusal(`the history is not applied by this session: ${who.join('; ')}`);

    // 4 — every file on disk, then nothing.
    const onDisk = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const applied = await runMigrations(migratorUrl, MIGRATIONS_DIR);
    const again = await runMigrations(migratorUrl, MIGRATIONS_DIR);
    const before = await readHistory(ownerUrl);
    const prefix = [...PHASE2_PREFIX, ...PHASE3_PREFIX];
    const set = appliedSetProblems(applied, onDisk, before, prefix);
    record(
      '4.1 the deployer applied every file on disk; the history holds both accepted prefixes',
      set.length === 0,
      set.join('; ') || `${applied.length} applied, last ${applied[applied.length - 1] ?? '(none)'}; Phase 2 and Phase 3 prefixes at their accepted digests`,
    );
    record('4.2 a second run applies nothing', again.length === 0, again.length === 0 ? 'no-op' : `applied ${again.join(', ')}`);
    artefact['applied'] = applied;

    // 5 — the snapshot.
    const digestBefore = historyDigest(before);
    artefact['historyDigestBefore'] = digestBefore;
    record('5 schema_migrations snapshotted', before.length > 0, `${before.length} rows, sha256 ${digestBefore.slice(0, 16)}…`);

    // 6 — the pinned suites, on this cluster.
    const reportFile = join(pgDir, '..', `daftar-deployed-rehearsal-${randomUUID()}.json`);
    console.log(`\nDEPLOYED REHEARSAL — ${DEPLOYED_SUITES.length} suites on the deployer's database`);
    const env: NodeJS.ProcessEnv = { ...process.env, PG_DIR: pgDir, PG_PORT: String(port) };
    // Asynchronous, never `spawnSync`: the embedded server writes its log to a
    // pipe this process reads. Blocking the event loop until vitest exits
    // stops that pipe being drained; once it fills, every backend that logs an
    // error (the suites provoke hundreds, by design) blocks on the write, and
    // the run hangs with sessions "active" on nothing.
    const vitest = await new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const child = spawn('npx', ['vitest', 'run', ...DEPLOYED_SUITES, '--reporter=default', '--reporter=json', `--outputFile.json=${reportFile}`], {
        cwd: ROOT,
        env,
        stdio: 'inherit',
      });
      child.on('error', reject);
      child.on('exit', (status, signal) => resolve({ status, signal }));
    });
    let report: VitestReport | undefined;
    if (existsSync(reportFile)) {
      report = JSON.parse(readFileSync(reportFile, 'utf8')) as VitestReport;
      rmSync(reportFile, { force: true });
    }
    const suiteProblems = vitestReportProblems(report, DEPLOYED_SUITES, ROOT);
    if (vitest.status !== 0) suiteProblems.push(`vitest exited ${vitest.status ?? `on ${vitest.signal ?? 'an unknown signal'}`}`);
    artefact['vitest'] = {
      exitStatus: vitest.status,
      total: report?.numTotalTests ?? null,
      failed: report?.numFailedTests ?? null,
      skipped: report === undefined ? null : report.numPendingTests + report.numTodoTests,
      files: report?.testResults.map((t) => ({ file: relative(ROOT, t.name), status: t.status })) ?? [],
    };
    record(
      '6 every pinned suite passes on the deployer-built database',
      suiteProblems.length === 0,
      suiteProblems.join('; ') || `${report?.numTotalTests ?? 0} tests in ${DEPLOYED_SUITES.length} suites`,
    );

    // 7 — the history is the deployer's, and the namespace boundary held.
    const after = await readHistory(ownerUrl);
    const digestAfter = historyDigest(after);
    artefact['historyDigestAfter'] = digestAfter;
    const changed = historyDifferences(before, after);
    record('7.1 schema_migrations is exactly the snapshot', changed.length === 0, changed.join('; ') || `sha256 ${digestAfter.slice(0, 16)}… unchanged`);
    const privileges = await namespacePrivileges(ownerUrl);
    artefact['namespacePrivileges'] = privileges;
    const leaked = namespacePrivilegeProblems(privileges, 'after the suites');
    record(
      '7.2 no runtime role, and not PUBLIC, holds TEMPORARY or CREATE on public',
      leaked.length === 0,
      leaked.join('; ') || `${privileges.length} grantees asked`,
    );

    // 7.3 — the ownership fact this rehearsal found (P3-S9), now closed
    // (TD-18, 0070): the deployer owns NO SECURITY DEFINER routine, so no
    // routine runs as a principal that exists only because of who applied
    // the history.
    const owned = (await query<{ f: string }>(ownerUrl, APPLIER_OWNED_DEFINERS_QUERY, [DEPLOYER])).map((r) => r.f);
    artefact['applierOwnedDefiners'] = { pinned: APPLIER_OWNED_DEFINERS, observed: owned };
    const ownership = applierOwnedDefinerProblems(owned, DEPLOYER);
    record('7.3 the deployer owns no SECURITY DEFINER routine', ownership.length === 0, ownership.join('; ') || 'none');

    // 7.4 — the four routines 0037-0039 left to the applier are owned by
    // their internal principals, with the pinned path, on this build too.
    const td18Rows = await query<Td18DefinerRow>(ownerUrl, TD18_DEFINER_OWNERS_QUERY);
    artefact['td18Definers'] = td18Rows;
    const td18 = td18DefinerProblems(td18Rows);
    record(
      '7.4 the TD-18 routines have their internal owners and the pinned path',
      td18.length === 0,
      td18.join('; ') || td18Rows.map((r) => `${r.f} → ${r.owner}`).join('; '),
    );
  } catch (e) {
    record('the rehearsal stopped', false, e instanceof Error ? e.message : String(e));
  } finally {
    if (started) {
      await pg.stop().catch((e: unknown) => {
        record('8 the cluster stops', false, e instanceof Error ? e.message : String(e));
      });
    }
    // Only ever the directory this run named; never another server's.
    if (!occupied) rmSync(pgDir, { recursive: true, force: true });
  }

  // 8 — the artefact.
  artefact['steps'] = steps;
  artefact['verdict'] = findings.length === 0 ? 'PASS' : 'FAIL';
  artefact['findings'] = findings;
  mkdirSync(join(ROOT, 'release'), { recursive: true });
  writeFileSync(ARTEFACT, `${JSON.stringify(artefact, null, 2)}\n`);
  console.log(`\nDEPLOYED REHEARSAL: ${findings.length === 0 ? 'PASS' : `FAIL (${findings.length})`}`);
  console.log(`evidence: ${relative(ROOT, ARTEFACT)}`);
  if (findings.length > 0) {
    for (const f of findings) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  // `embedded-postgres` exits through a hook with a hard-coded 0; without the
  // guard a FAIL verdict could leave with status 0 (tests/helpers/exit-code.ts).
  protectFailingExitCode();
  void main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.stack : e);
    process.exit(1);
  });
}
