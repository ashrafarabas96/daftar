#!/usr/bin/env tsx
/**
 * ─────────────────────────────────────────────────────────────────────────
 * P2-S9 — THE DEPLOYMENT AUTHORITY, PROVED (RB-P2-01)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * WHAT THIS ANSWERS
 *
 * Every test in this repository applies the migration history as a PostgreSQL
 * superuser, because that is what a `postgres:16` service container hands you.
 * A superuser skips both of the checks that decide whether a real deployment
 * works: it is never asked whether it may `SET ROLE` to the role a file hands
 * an object to, and it is never asked whether that role may own something in
 * the schema. So the suite was green while a production deployment as the
 * documented migration principal, `daftar_migrator`, could not get past
 * `0032_provisioner_narrow_functions.sql`.
 *
 * That was release blocker RB-P2-01, and it had three independent causes,
 * each of which hid the next:
 *
 *   1. `must be able to SET ROLE "daftar_platform"` — the history hands
 *      ownership to two roles and bootstrap carried a membership for only
 *      one of them.
 *   2. `permission denied for schema public` — `public` belonged to
 *      `pg_database_owner`, so the migrator held CREATE without grant option
 *      and could not lend it to the role it was about to make owner. Every
 *      accounting migration from 0040 does exactly that lending inside its
 *      own transaction; a non-owner cannot issue the GRANT at all.
 *   3. `must be owner of function provision_replay_operation` — replacing an
 *      existing function is an OWNERSHIP check, which reads the INHERIT bit
 *      and ignores SET, so `INHERIT FALSE` on the platform membership stopped
 *      the history at `0038`.
 *
 * The corrections are in `infrastructure/database/bootstrap.sql` and in the
 * deployment tool `apps/api/src/infra/migrate.ts`. No frozen migration was
 * touched, no runtime principal was widened, and nothing here runs as a
 * superuser except the deployment administrator's own bootstrap step — which
 * is a real, separate trust boundary and not a disguise for one.
 *
 * WHAT IT PROVES, AND HOW
 *
 * Six deployment cases (§17), each executed by `runMigrations` over a
 * connection authenticated as the deployment principal and nothing else:
 *
 *   A  empty database  → bootstrap → 0000 … 0052
 *   B  a database at 0039 (the Phase 1 boundary) → 0040 … 0052
 *   C  a database at 0050 → 0051, 0052, then every unfrozen candidate
 *   D  a database at the latest migration → no-op
 *   E  a database whose applied history was tampered with → HARD FAIL
 *   F  a migration that fails half way → rollback, no history row, clean retry
 *   G  a database at the 0052 freeze, holding a business → exactly the
 *      unfrozen candidates (P3-S1: 0053 onward), whose backfills must see
 *      that business although the deployer is not a superuser (P3-AL-54 §J)
 *
 * Then the question those six cases cannot answer on their own: is the
 * database the deployment principal produced the SAME database a superuser
 * produces? Section 10 compares both catalogues — every table's owner, RLS
 * flags and ACL, every function's owner, SECURITY DEFINER flag, ACL and
 * configuration, and every policy's expression and roles — with the applying
 * principal's own name normalised, because the one difference a deployment is
 * ALLOWED to have is who owns what it created.
 *
 * Usage: npm run check:deployment-authority [-- --static-only]
 *
 * `--static-only` runs sections 1 and 2's static half and skips every case
 * that needs a cluster, for a machine that has no PostgreSQL binaries.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { runMigrations } from '../apps/api/src/infra/migrate';
import { stripComments } from './guards/sql-schema';

const ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(ROOT, 'infrastructure/database/migrations');
const ARGV = process.argv.slice(2);
const STATIC_ONLY = ARGV.includes('--static-only');

const PG_BIN = process.env['DEPLOY_PG_BIN'] ?? '/usr/lib/postgresql/16/bin';
const PG_PORT = Number(process.env['DEPLOY_PG_PORT'] ?? 55434);
const PG_USER = 'postgres';
const PG_SUPER_PASSWORD = 'postgres';

/** Throwaway credentials for a cluster that is destroyed at the end. */
const PASSWORDS: Record<string, string> = {
  __APP_DB_PASSWORD__: 'deploy_app_pw_123456',
  __PLATFORM_DB_PASSWORD__: 'deploy_platform_pw_123456',
  __WORKER_DB_PASSWORD__: 'deploy_worker_pw_123456',
  __RESOLVER_DB_PASSWORD__: 'deploy_resolver_pw_123456',
  __IDENTITY_DB_PASSWORD__: 'deploy_identity_pw_123456',
  __PROVISIONER_DB_PASSWORD__: 'deploy_provisioner_pw_123456',
  __RECONCILER_DB_PASSWORD__: 'deploy_reconciler_pw_123456',
  __MIGRATOR_DB_PASSWORD__: 'deploy_migrator_pw_123456',
};

/**
 * The canonical production deployment authority (§13, option A).
 *
 * It is the role this repository has documented as the migration principal
 * since P2-S1: a LOGIN role that no service loads and that appears in no
 * runtime connection URL. P2-S9 did not invent a second one, because a second
 * deployment credential holding the same authority removes nothing and adds
 * one more secret to protect.
 */
const DEPLOYER = 'daftar_migrator';

/** Every principal the schema knows, deployment and runtime alike (§32). */
const RUNTIME_ROLES = [
  'daftar_app',
  'daftar_platform',
  'daftar_worker',
  'daftar_identity',
  'daftar_resolver',
  'daftar_provisioner',
  'daftar_reconciler',
] as const;
/** The NOLOGIN owners of SECURITY DEFINER authority (P2-S1, P3-AL-54 §C). */
const INTERNAL_ROLES = ['daftar_accounting_internal', 'daftar_inventory_internal'] as const;
const ALL_ROLES = [...RUNTIME_ROLES, ...INTERNAL_ROLES, DEPLOYER] as const;

/** The last frozen migration (MIGRATION_MANIFEST.json `frozenThrough`). */
const FROZEN_THROUGH = '0052_accounting_journal_lines_rls_performance.sql';

const findings: string[] = [];
const steps: { step: string; ok: boolean; detail: string }[] = [];

function record(step: string, ok: boolean, detail: string): void {
  steps.push({ step, ok, detail });
  console.log(`${ok ? '  ok     ' : '  FAIL   '} ${step} — ${detail}`);
  if (!ok) findings.push(`${step}: ${detail}`);
}

function section(title: string): void {
  console.log(`\nDEPLOYMENT AUTHORITY — ${title}`);
}

function url(db: string, role: string, password: string): string {
  return `postgresql://${role}:${password}@127.0.0.1:${PG_PORT}/${db}`;
}
const ownerUrl = (db: string): string => `postgresql://${PG_USER}:${PG_SUPER_PASSWORD}@127.0.0.1:${PG_PORT}/${db}`;
const deployerUrl = (db: string): string => url(db, DEPLOYER, PASSWORDS['__MIGRATOR_DB_PASSWORD__'] as string);

function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {}): string {
  const res = spawnSync(cmd, args, { cwd: ROOT, env: { ...process.env, ...opts.env }, encoding: 'utf8' });
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (res.status !== 0 && !opts.allowFailure) throw new Error(`${cmd} ${args.join(' ')} failed (${res.status ?? 'signal'}):\n${output.slice(-4000)}`);
  return output;
}

async function sql<T extends Record<string, unknown>>(connectionString: string, text: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query<T>(text, params);
    return rows;
  } finally {
    await client.end();
  }
}

async function exec(connectionString: string, text: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(text);
  } finally {
    await client.end();
  }
}

// ── the cluster ────────────────────────────────────────────────────────────
//
// Its own throwaway cluster, for the same reason the rollback rehearsal has
// one: this script needs a superuser that can create databases and roles, and
// it needs to be able to destroy everything afterwards. It never touches a
// cluster it did not create.

let dataDir = '';
const SERVER_USER = process.env['DEPLOY_PG_OS_USER'] ?? 'postgres';
const NEEDS_PRIVILEGE_DROP = typeof process.getuid === 'function' && process.getuid() === 0;

function pgServer(bin: string, args: string[], opts: { allowFailure?: boolean } = {}): string {
  const exe = join(PG_BIN, bin);
  if (!NEEDS_PRIVILEGE_DROP) return run(exe, args, opts);
  return run('setpriv', ['--reuid', SERVER_USER, '--regid', SERVER_USER, '--init-groups', '--', exe, ...args], opts);
}

function startCluster(): void {
  dataDir = mkdtempSync(join(tmpdir(), 'daftar-deploy-pg-'));
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  const pwFile = join(dataDir, '..', `pw-${process.pid}`);
  writeFileSync(pwFile, PG_SUPER_PASSWORD);
  if (NEEDS_PRIVILEGE_DROP) {
    run('chown', ['-R', `${SERVER_USER}:${SERVER_USER}`, dataDir]);
    run('chown', [`${SERVER_USER}:${SERVER_USER}`, pwFile]);
    run('chmod', ['0600', pwFile]);
  }
  pgServer('initdb', ['-D', dataDir, '-U', PG_USER, '--auth-local=trust', '--auth-host=md5', `--pwfile=${pwFile}`]);
  rmSync(pwFile, { force: true });
  pgServer('pg_ctl', [
    '-D',
    dataDir,
    '-o',
    `-p ${PG_PORT} -c listen_addresses=127.0.0.1 -c fsync=off -c unix_socket_directories=${dataDir}`,
    '-w',
    '-l',
    join(dataDir, 'server.log'),
    'start',
  ]);
}

function stopCluster(): void {
  if (!dataDir) return;
  pgServer('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], { allowFailure: true });
  rmSync(dataDir, { recursive: true, force: true });
}

function bootstrapSql(db: string): string {
  let text = readFileSync(join(ROOT, 'infrastructure/database/bootstrap.sql'), 'utf8');
  for (const [token, value] of Object.entries(PASSWORDS)) text = text.replaceAll(token, value);
  // The bootstrap names the production database; a throwaway one is not it.
  return text.replaceAll('GRANT CONNECT ON DATABASE daftar TO', `GRANT CONNECT ON DATABASE ${db} TO`);
}

/** A database with bootstrap applied by the deployment ADMINISTRATOR and nothing else. */
async function freshDatabase(db: string): Promise<void> {
  await exec(ownerUrl('postgres'), `DROP DATABASE IF EXISTS ${db}`);
  await exec(ownerUrl('postgres'), `CREATE DATABASE ${db}`);
  await exec(ownerUrl(db), bootstrapSql(db));
}

/** A migrations directory holding only the files up to and including `through`. */
function migrationsUpTo(through: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'daftar-deploy-mig-'));
  for (const f of migrationFiles().filter((f) => f <= through)) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
  return dir;
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

// ─────────────────────────────────────────────────────────────────────────
// 1. THE AUTHORITY INVENTORY (§12) — derived, never guessed
// ─────────────────────────────────────────────────────────────────────────
//
// Read off the frozen history rather than written down, so that a later
// authorized migration which hands ownership to a role nobody granted a
// membership for is a red gate here instead of a deployment that dies half
// way through production.

interface Inventory {
  readonly ownershipTargets: string[];
  readonly extensions: string[];
  readonly grantees: string[];
  readonly revokees: string[];
  readonly disableTrigger: string[];
  readonly createsFunctions: number;
  readonly createsPolicies: number;
  readonly touchesSchemaMigrations: string[];
}

function buildInventory(): Inventory {
  const ownershipTargets = new Set<string>();
  const extensions = new Set<string>();
  const grantees = new Set<string>();
  const revokees = new Set<string>();
  const disableTrigger: string[] = [];
  const touchesSchemaMigrations: string[] = [];
  let createsFunctions = 0;
  let createsPolicies = 0;

  for (const file of migrationFiles()) {
    const code = stripComments(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    for (const m of code.matchAll(/\bOWNER\s+TO\s+(daftar_[a-z_]+)/gi)) ownershipTargets.add(m[1]);
    for (const m of code.matchAll(/CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_]+)"?/gi)) extensions.add(m[1]);
    for (const m of code.matchAll(/\bGRANT\b[\s\S]{0,400}?\bTO\s+([a-z_,\s]+?)[;\n]/gi)) {
      for (const r of m[1].split(',')) if (/^daftar_[a-z_]+$/.test(r.trim())) grantees.add(r.trim());
    }
    for (const m of code.matchAll(/\bREVOKE\b[\s\S]{0,400}?\bFROM\s+([a-z_,\s]+?)[;\n]/gi)) {
      for (const r of m[1].split(',')) if (/^daftar_[a-z_]+$/.test(r.trim())) revokees.add(r.trim());
    }
    if (/DISABLE\s+TRIGGER/i.test(code)) disableTrigger.push(file);
    if (/\bschema_migrations\b/i.test(code)) touchesSchemaMigrations.push(file);
    createsFunctions += [...code.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/gi)].length;
    createsPolicies += [...code.matchAll(/CREATE\s+POLICY\b/gi)].length;
  }

  return {
    ownershipTargets: [...ownershipTargets].sort(),
    extensions: [...extensions].sort(),
    grantees: [...grantees].sort(),
    revokees: [...revokees].sort(),
    disableTrigger,
    createsFunctions,
    createsPolicies,
    touchesSchemaMigrations,
  };
}

function checkInventoryAgainstBootstrap(inv: Inventory): void {
  section('1. the authority inventory, derived from the frozen history (§12)');
  const bootstrap = readFileSync(join(ROOT, 'infrastructure/database/bootstrap.sql'), 'utf8');
  const bootstrapCode = stripComments(bootstrap);

  record('1.1 ownership targets', true, `the history hands ownership to: ${inv.ownershipTargets.join(', ')}`);
  record('1.2 extensions', true, `the history names: ${inv.extensions.join(', ')}`);
  record('1.3 privilege surface', true, `${inv.grantees.length} grantee role(s), ${inv.revokees.length} revokee role(s)`);
  record('1.4 routines and policies', true, `${inv.createsFunctions} CREATE FUNCTION, ${inv.createsPolicies} CREATE POLICY`);
  record(
    '1.5 DISABLE TRIGGER',
    true,
    inv.disableTrigger.length === 0
      ? 'no migration disables a trigger'
      : `${inv.disableTrigger.join(', ')} — the object owner may do this, and the deployer owns them`,
  );
  record(
    '1.6 schema_migrations',
    inv.touchesSchemaMigrations.length === 0,
    inv.touchesSchemaMigrations.length === 0
      ? 'no migration writes the history table — only the runner does'
      : `written by ${inv.touchesSchemaMigrations.join(', ')}, which puts the history under a migration's control`,
  );

  // Every ownership target must have a membership, or the deployment stops.
  for (const target of inv.ownershipTargets) {
    const granted = new RegExp(`GRANT\\s+${target}\\s+TO\\s+${DEPLOYER}\\b`, 'i').test(bootstrapCode);
    record(
      `1.7 membership for ${target}`,
      granted,
      granted
        ? `bootstrap.sql grants ${target} to ${DEPLOYER}`
        : `bootstrap.sql grants no ${target} membership — a deployment would stop at the first handover to it`,
    );
  }

  // The deployer must own the schema, or it cannot lend CREATE to the role it
  // is about to hand an object to (cause 2 of RB-P2-01).
  const ownsSchema = new RegExp(`ALTER\\s+SCHEMA\\s+public\\s+OWNER\\s+TO\\s+${DEPLOYER}\\b`, 'i').test(bootstrapCode);
  record(
    '1.8 schema ownership',
    ownsSchema,
    ownsSchema ? `bootstrap.sql makes ${DEPLOYER} the owner of schema public` : 'bootstrap.sql leaves schema public owned by someone else',
  );

  // §16: bootstrap must install every extension the history names, BEFORE the
  // history reaches it, and no runtime may be given extension-creation.
  for (const ext of inv.extensions) {
    const installed = new RegExp(`CREATE\\s+EXTENSION\\s+(IF\\s+NOT\\s+EXISTS\\s+)?"?${ext}"?`, 'i').test(bootstrapCode);
    record(
      `1.9 extension ${ext}`,
      installed,
      installed ? 'installed by the deployment administrator in bootstrap.sql' : 'not installed in bootstrap.sql — the migration would need CREATE ON DATABASE',
    );
  }
  const runtimeCreate = RUNTIME_ROLES.filter((r) => new RegExp(`GRANT[^;]*\\bCREATE\\b[^;]*ON\\s+DATABASE[^;]*\\b${r}\\b`, 'i').test(bootstrapCode));
  record(
    '1.10 no runtime may create an extension',
    runtimeCreate.length === 0,
    runtimeCreate.length === 0 ? 'no runtime role holds CREATE ON DATABASE' : `granted to ${runtimeCreate.join(', ')}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 2. THE DEPLOYMENT PRINCIPAL IS NOT A RUNTIME (§13, §14)
// ─────────────────────────────────────────────────────────────────────────

function checkDeployerIsNotARuntime(): void {
  section('2. the deployment principal is a deployment principal (§13, §14)');
  // No runtime configuration may accept the deployment credential. The
  // migration command reads MIGRATION_DATABASE_URL and the runtime config
  // never loads it; this asserts that the separation is still true in code
  // rather than only in a comment.
  const configFiles: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(ts|js|mjs|cjs|yml|yaml|env|example)$/.test(e.name)) configFiles.push(full);
    }
  };
  for (const d of ['apps', 'packages']) if (existsSync(join(ROOT, d))) walk(join(ROOT, d));

  // Comments are stripped first, and deliberately: `apps/api/src/config.ts`
  // NAMES the variable in order to say that it never reads it, which is the
  // documentation a reader wants and the opposite of the defect being looked
  // for. What matters is whether any runtime CODE reaches for the value.
  const offenders = configFiles.filter((f) => {
    if (f.endsWith('apps/api/src/infra/migrate.ts')) return false; // the migration command itself
    const text = readFileSync(f, 'utf8');
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1').replace(/^\s*#.*$/, ''))
      .join('\n');
    return /MIGRATION_DATABASE_URL/.test(code);
  });
  record(
    '2.1 no runtime configuration reads the deployment URL',
    offenders.length === 0,
    offenders.length === 0
      ? 'MIGRATION_DATABASE_URL is read by the migration command and by nothing else'
      : offenders.map((o) => o.replace(`${ROOT}/`, '')).join(', '),
  );

  const runtimeUrlNames = readdirSync(join(ROOT, 'apps'), { withFileTypes: true }).length > 0;
  record('2.2 runtime connection URLs are per-runtime', runtimeUrlNames, 'each runtime has its own *_DATABASE_URL; the deployer has none');
}

async function checkLiveDeployerShape(db: string): Promise<Record<string, unknown>> {
  section('2b. the deployment principal, as the live catalogue describes it');
  const [role] = await sql<{
    rolcanlogin: boolean;
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolreplication: boolean;
    rolinherit: boolean;
  }>(
    ownerUrl(db),
    `SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolinherit
       FROM pg_roles WHERE rolname = $1`,
    [DEPLOYER],
  );
  record('2.3 NOT a superuser', role.rolsuper === false, `rolsuper = ${String(role.rolsuper)}`);
  record('2.4 does NOT bypass RLS', role.rolbypassrls === false, `rolbypassrls = ${String(role.rolbypassrls)}`);
  record('2.5 cannot create databases', role.rolcreatedb === false, `rolcreatedb = ${String(role.rolcreatedb)}`);
  record('2.6 cannot create roles', role.rolcreaterole === false, `rolcreaterole = ${String(role.rolcreaterole)}`);
  record('2.7 cannot replicate', role.rolreplication === false, `rolreplication = ${String(role.rolreplication)}`);

  const memberships = await sql<{ grantor_role: string; inherit_option: boolean; set_option: boolean; admin_option: boolean }>(
    ownerUrl(db),
    `SELECT g.rolname AS grantor_role, a.inherit_option, a.set_option, a.admin_option
       FROM pg_auth_members a JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
      WHERE m.rolname = $1 ORDER BY 1`,
    [DEPLOYER],
  );
  record(
    '2.8 memberships',
    true,
    memberships.map((m) => `${m.grantor_role} (inherit=${String(m.inherit_option)}, set=${String(m.set_option)})`).join('; ') || '(none)',
  );
  const withAdmin = memberships.filter((m) => m.admin_option);
  record(
    '2.9 no membership carries ADMIN OPTION',
    withAdmin.length === 0,
    withAdmin.length === 0 ? 'the deployer cannot pass any membership on' : withAdmin.map((m) => m.grantor_role).join(', '),
  );

  const reverse = await sql<{ member: string }>(
    ownerUrl(db),
    `SELECT m.rolname AS member FROM pg_auth_members a JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
      WHERE g.rolname = $1 ORDER BY 1`,
    [DEPLOYER],
  );
  record(
    '2.10 nothing is a member of the deployer',
    reverse.length === 0,
    reverse.length === 0 ? 'no role can assume the deployment authority' : reverse.map((r) => r.member).join(', '),
  );

  return { attributes: role, memberships, membersOfDeployer: reverse.map((r) => r.member) };
}

// ─────────────────────────────────────────────────────────────────────────
// 3–8. THE DEPLOYMENT MATRIX (§17)
// ─────────────────────────────────────────────────────────────────────────

async function appliedCount(db: string): Promise<{ n: number; last: string | null }> {
  const [row] = await sql<{ n: string; last: string | null }>(ownerUrl(db), `SELECT count(*)::text AS n, max(name) AS last FROM schema_migrations`);
  return { n: Number(row.n), last: row.last };
}

async function caseA(db: string): Promise<void> {
  section('3. CASE A — an empty database, bootstrap, then the whole accepted history');
  await freshDatabase(db);
  const applied = await runMigrations(deployerUrl(db), MIGRATIONS_DIR);
  const state = await appliedCount(db);
  const expected = migrationFiles().length;
  record('3.1 the deployment principal applied every migration', applied.length === expected, `${applied.length} of ${expected} applied as ${DEPLOYER}`);
  record('3.2 the history records them all', state.n === expected, `schema_migrations has ${state.n} rows, last = ${String(state.last)}`);
}

async function caseB(db: string): Promise<void> {
  section('4. CASE B — a database at the Phase 1 boundary, upgraded to 0052');
  await freshDatabase(db);
  const p1 = migrationsUpTo('0039_catalog_identifiers_owner_integrity.sql');
  try {
    const phase1 = await runMigrations(deployerUrl(db), p1);
    record(
      '4.1 Phase 1 applies as the deployment principal',
      phase1.length === readdirSync(p1).length,
      `${phase1.length} migrations through the Phase 1 boundary`,
    );
    const phase2 = await runMigrations(deployerUrl(db), MIGRATIONS_DIR);
    const state = await appliedCount(db);
    record(
      '4.2 Phase 2 applies on top of it',
      state.n === migrationFiles().length,
      `${phase2.length} further migrations; history now ${state.n}, last = ${String(state.last)}`,
    );
  } finally {
    rmSync(p1, { recursive: true, force: true });
  }
}

async function caseC(db: string): Promise<void> {
  section('5. CASE C — a database at 0050, upgraded across the P2-S8 freeze');
  await freshDatabase(db);
  const upTo50 = migrationsUpTo('0050_accounting_report_indexes.sql');
  try {
    await runMigrations(deployerUrl(db), upTo50);
    const before = await appliedCount(db);
    const applied = await runMigrations(deployerUrl(db), MIGRATIONS_DIR);
    const after = await appliedCount(db);
    // The frozen names exactly and in order, then whatever unfrozen candidates
    // the tree carries — appended to the expectation, never loosened out of it.
    const expected = ['0051_accounting_reconciler_read.sql', FROZEN_THROUGH, ...migrationFiles().filter((f) => f > FROZEN_THROUGH)];
    record(
      '5.1 exactly 0051 and 0052 are added, then the unfrozen candidates',
      applied.length === expected.length && applied.every((f, i) => f === expected[i]),
      `${before.n} → ${after.n}; applied ${applied.join(', ') || '(none)'}`,
    );
  } finally {
    rmSync(upTo50, { recursive: true, force: true });
  }
}

/**
 * CASE G — the P3-S1 candidates on top of the frozen history, applied to a
 * database that already HOLDS a business.
 *
 * An empty database cannot tell a backfill that worked from one that saw
 * nothing. The deployer owns the tables but is subject to their FORCE row
 * security, so a backfill that forgot that would seed nothing in production
 * and pass every set-wise assertion vacuously. The business below is written
 * by the administrator (a superuser, which RLS does not restrict), then the
 * candidates run as the deployer, and the rows they were required to write
 * are read back.
 */
async function caseG(db: string): Promise<void> {
  section('8b. CASE G — a database at the 0052 freeze with a business, upgraded to every candidate');
  await freshDatabase(db);
  const frozen = migrationsUpTo(FROZEN_THROUGH);
  try {
    await runMigrations(deployerUrl(db), frozen);
    const seed = {
      tenant: randomUUID(),
      business: randomUUID(),
      branch: randomUUID(),
      warehouse: randomUUID(),
      owner: randomUUID(),
      manager: randomUUID(),
      cashier: randomUUID(),
      custom: randomUUID(),
    };
    // The shape the frozen provisioning writer produces (0033:137): only the
    // owner is a system role; manager and cashier are the builtin template
    // roles, identified by their unique key.
    // System roles are system-managed (0006 business_roles_system_guard):
    // only the platform principal, for which app_bypass() is true, may write
    // them — so the seed is written AS daftar_platform, exactly the principal
    // provisioning writes it as.
    await exec(
      ownerUrl(db),
      `BEGIN;
       SET LOCAL ROLE daftar_platform;
       INSERT INTO tenants (id) VALUES ('${seed.tenant}');
       INSERT INTO businesses (id, tenant_id, name, store_slug, country_code, base_currency, timezone)
         VALUES ('${seed.business}', '${seed.tenant}', 'Deploy G', 'deploy-g', 'PS', 'ILS', 'Asia/Hebron');
       INSERT INTO branches (business_id, id, name, is_default) VALUES ('${seed.business}', '${seed.branch}', 'Main', true);
       INSERT INTO warehouses (business_id, id, branch_id, name, is_default) VALUES ('${seed.business}', '${seed.warehouse}', '${seed.branch}', 'Main WH', true);
       INSERT INTO business_roles (business_id, id, key, name, is_system) VALUES
         ('${seed.business}', '${seed.owner}', 'owner', 'Owner', true),
         ('${seed.business}', '${seed.manager}', 'manager', 'Manager', false),
         ('${seed.business}', '${seed.cashier}', 'cashier', 'Cashier', false),
         ('${seed.business}', '${seed.custom}', 'clerk', 'Clerk', false);
       INSERT INTO role_permissions (business_id, role_id, permission) VALUES
         ('${seed.business}', '${seed.manager}', 'catalog.view'), ('${seed.business}', '${seed.manager}', 'warehouse.manage'),
         ('${seed.business}', '${seed.cashier}', 'catalog.view'),
         ('${seed.business}', '${seed.custom}', 'catalog.view');
       COMMIT;`,
    );
    const applied = await runMigrations(deployerUrl(db), MIGRATIONS_DIR);
    const candidates = migrationFiles().filter((f) => f > FROZEN_THROUGH);
    record(
      '8b.1 exactly the unfrozen candidates are added',
      applied.length === candidates.length && applied.every((f, i) => f === candidates[i]),
      `applied ${applied.join(', ') || '(none)'}`,
    );
    const [home] = await sql<{ n: string; home: string }>(
      ownerUrl(db),
      `SELECT count(*)::text AS n, count(*) FILTER (WHERE branch_id = $2 AND warehouse_id = $3)::text AS home
         FROM branch_warehouses WHERE business_id = $1`,
      [seed.business, seed.branch, seed.warehouse],
    );
    record(
      '8b.2 the existing warehouse has exactly its home association',
      home?.n === '1' && home.home === '1',
      `${home?.n ?? '?'} row(s), ${home?.home ?? '?'} home`,
    );
    const perms = async (role: string): Promise<string[]> =>
      (
        await sql<{ p: string }>(ownerUrl(db), `SELECT permission AS p FROM role_permissions WHERE business_id = $1 AND role_id = $2 ORDER BY 1`, [
          seed.business,
          role,
        ])
      ).map((r) => r.p);
    const owner = await perms(seed.owner);
    const phase3 = ['inventory.', 'purchases.', 'suppliers.'];
    record('8b.3 the owner holds all eleven Phase 3 permissions', owner.filter((p) => phase3.some((x) => p.startsWith(x))).length === 11, owner.join(', '));
    const manager = await perms(seed.manager);
    record(
      '8b.4 the manager gained exactly the three view keys and kept what it had',
      manager.join(',') === ['catalog.view', 'inventory.view', 'purchases.view', 'suppliers.view', 'warehouse.manage'].join(','),
      manager.join(', '),
    );
    const cashier = await perms(seed.cashier);
    record('8b.5 the cashier gained nothing', cashier.join(',') === 'catalog.view', cashier.join(', '));
    const custom = await perms(seed.custom);
    record('8b.6 the custom role is unchanged', custom.join(',') === 'catalog.view', custom.join(', '));
  } finally {
    rmSync(frozen, { recursive: true, force: true });
  }
}

async function caseD(db: string): Promise<void> {
  section('6. CASE D — a database already at the latest migration');
  const before = await appliedCount(db);
  const applied = await runMigrations(deployerUrl(db), MIGRATIONS_DIR);
  const after = await appliedCount(db);
  record('6.1 a re-run is a no-op', applied.length === 0 && after.n === before.n, `${applied.length} migrations applied; history unchanged at ${after.n}`);
}

async function caseE(db: string): Promise<void> {
  section('7. CASE E — an applied migration whose bytes changed afterwards');
  const tampered = mkdtempSync(join(tmpdir(), 'daftar-deploy-tamper-'));
  try {
    for (const f of migrationFiles()) cpSync(join(MIGRATIONS_DIR, f), join(tampered, f));
    const victim = '0045_accounting_post_entry.sql';
    writeFileSync(join(tampered, victim), `${readFileSync(join(tampered, victim), 'utf8')}\n-- a byte nobody accepted\n`);
    const before = await appliedCount(db);
    let message = '';
    try {
      await runMigrations(deployerUrl(db), tampered);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    const after = await appliedCount(db);
    record('7.1 the deployment refuses to proceed', /checksum mismatch/i.test(message), message === '' ? 'the run SUCCEEDED over a tampered history' : message);
    record('7.2 the history is untouched', after.n === before.n, `schema_migrations still has ${after.n} rows`);
  } finally {
    rmSync(tampered, { recursive: true, force: true });
  }
}

async function caseF(db: string): Promise<void> {
  section('8. CASE F — a migration that fails half way through');
  await freshDatabase(db);
  const dir = mkdtempSync(join(tmpdir(), 'daftar-deploy-fail-'));
  try {
    for (const f of migrationFiles()) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
    // A file that does real work and THEN fails, so the rollback has
    // something to undo. It is created in a disposable copy of the directory
    // and never exists in the repository.
    // It sorts BETWEEN 0044 and 0045, so the run fails with part of the
    // history applied and committed. A probe that sorted last would prove
    // only that the final file can fail.
    const broken = '0044a_deployment_failure_probe.sql';
    writeFileSync(join(dir, broken), 'CREATE TABLE deployment_failure_probe (id int);\nSELECT 1 / 0;\n');
    let message = '';
    try {
      await runMigrations(deployerUrl(db), dir);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    record('8.1 the failure is reported, not swallowed', /division by zero/i.test(message), message || 'the run reported success');

    const [probe] = await sql<{ exists: boolean }>(ownerUrl(db), `SELECT to_regclass('public.deployment_failure_probe') IS NOT NULL AS exists`);
    record(
      '8.2 the failed migration rolled back completely',
      probe.exists === false,
      `the table it created before failing ${probe.exists ? 'SURVIVED' : 'is gone'}`,
    );

    const [row] = await sql<{ n: string }>(ownerUrl(db), `SELECT count(*)::text AS n FROM schema_migrations WHERE name = $1`, [broken]);
    record('8.3 no false history row', Number(row.n) === 0, `schema_migrations has ${row.n} row(s) for the failed file`);

    // The failure really was mid-history: what ran before it is committed,
    // what comes after it never ran.
    const partial = await appliedCount(db);
    record(
      '8.5 the migrations before it are committed, those after it are not',
      partial.n > 0 && partial.n < migrationFiles().length,
      `${partial.n} of ${migrationFiles().length} applied, last = ${String(partial.last)}`,
    );

    // Clean retry: with the broken file removed, the same database finishes.
    rmSync(join(dir, broken), { force: true });
    const applied = await runMigrations(deployerUrl(db), dir);
    const state = await appliedCount(db);
    record(
      '8.4 the retry completes cleanly',
      state.n === migrationFiles().length && applied.length > 0,
      `${applied.length} applied on retry; history now ${state.n} of ${migrationFiles().length}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 9. THE HISTORY TABLE'S AUTHORITY (§15)
// ─────────────────────────────────────────────────────────────────────────

async function checkHistoryAuthority(db: string): Promise<void> {
  section('9. the deployment principal owns its own history table (§15)');
  const [owner] = await sql<{ owner: string; acl: string }>(
    ownerUrl(db),
    `SELECT pg_get_userbyid(relowner) AS owner, coalesce(relacl::text, '') AS acl FROM pg_class WHERE relname = 'schema_migrations'`,
  );
  record('9.1 the history table belongs to the deployer', owner.owner === DEPLOYER, `owner = ${owner.owner}`);
  const runtimeReaders = RUNTIME_ROLES.filter((r) => owner.acl.includes(`${r}=`));
  record(
    '9.2 no runtime principal was granted anything on it',
    runtimeReaders.length === 0,
    runtimeReaders.length === 0 ? `acl = ${owner.acl || '(owner only)'}` : runtimeReaders.join(', '),
  );

  const runner = readFileSync(join(ROOT, 'apps/api/src/infra/migrate.ts'), 'utf8');
  record(
    '9.3 checksum validation is not optional',
    /checksum mismatch/.test(runner) && !/SKIP_CHECKSUM|--no-verify|DISABLE_CHECKSUM/i.test(runner),
    'the runner has no switch that turns verification off',
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 10. THE SAME DATABASE A SUPERUSER WOULD HAVE BUILT
// ─────────────────────────────────────────────────────────────────────────

const CATALOGUE_QUERIES: Record<string, string> = {
  tables: `SELECT c.relname || ' | ' || pg_get_userbyid(c.relowner) || ' | ' || c.relrowsecurity || ' | ' || c.relforcerowsecurity || ' | ' || coalesce(c.relacl::text, '') AS row
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm', 'p') ORDER BY 1`,
  functions: `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') | ' || pg_get_userbyid(p.proowner) || ' | ' || p.prosecdef
                     || ' | ' || coalesce(p.proacl::text, '') || ' | ' || coalesce(p.proconfig::text, '') AS row
                FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') ORDER BY 1`,
  policies: `SELECT c.relname || '.' || pol.polname || ' | ' || pol.polcmd::text || ' | ' || pol.polpermissive
                    || ' | ' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '')
                    || ' | ' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
                    || ' | ' || coalesce((SELECT string_agg(pg_get_userbyid(r), ',' ORDER BY r) FROM unnest(pol.polroles) r), '') AS row
               FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid ORDER BY 1`,
  triggers: `SELECT c.relname || '.' || t.tgname || ' | ' || t.tgtype || ' | ' || t.tgenabled::text || ' | ' || t.tgdeferrable || ' | ' || t.tginitdeferred
                    || ' | ' || p.proname AS row
               FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_proc p ON p.oid = t.tgfoid
              WHERE n.nspname = 'public' AND NOT t.tgisinternal ORDER BY 1`,
  columnAcls: `SELECT c.relname || '.' || a.attname || ' | ' || a.attacl::text AS row
                 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND a.attacl IS NOT NULL AND a.attnum > 0 AND NOT a.attisdropped ORDER BY 1`,
  constraints: `SELECT c.relname || '.' || con.conname || ' | ' || con.contype::text || ' | ' || pg_get_constraintdef(con.oid) AS row
                  FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' ORDER BY 1`,
};

async function catalogueSnapshot(db: string, applier: string): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const [name, query] of Object.entries(CATALOGUE_QUERIES)) {
    const rows = await sql<{ row: string }>(ownerUrl(db), query);
    // The one difference a deployment is ALLOWED to have is who owns what it
    // created, so the applying principal's own name is normalised away. Every
    // OTHER owner — the two delegated ones — is compared literally, which is
    // the point: a handover that silently did not happen shows up here.
    out[name] = rows.map((r) => r.row.split(applier).join('<applier>'));
  }
  return out;
}

async function checkCatalogueEquivalence(deployed: string, superuser: string): Promise<Record<string, number>> {
  section('10. the deployment authority builds the database a superuser builds');
  const a = await catalogueSnapshot(deployed, DEPLOYER);
  const b = await catalogueSnapshot(superuser, PG_USER);
  const counts: Record<string, number> = {};
  for (const name of Object.keys(CATALOGUE_QUERIES)) {
    const setB = new Set(b[name]);
    const setA = new Set(a[name]);
    const onlyA = a[name].filter((x) => !setB.has(x));
    const onlyB = b[name].filter((x) => !setA.has(x));
    counts[name] = a[name].length;
    record(
      `10.${Object.keys(CATALOGUE_QUERIES).indexOf(name) + 1} ${name}`,
      onlyA.length === 0 && onlyB.length === 0,
      onlyA.length === 0 && onlyB.length === 0
        ? `${a[name].length} identical`
        : `${onlyA.length} differ under the deployer, ${onlyB.length} under the superuser — e.g. ${(onlyA[0] ?? onlyB[0] ?? '').slice(0, 200)}`,
    );
  }
  return counts;
}

// ─────────────────────────────────────────────────────────────────────────
// 11. THE ROLE MATRIX (§32)
// ─────────────────────────────────────────────────────────────────────────

interface RoleRow {
  readonly role: string;
  readonly login: boolean;
  readonly superuser: boolean;
  readonly bypassrls: boolean;
  readonly createdb: boolean;
  readonly createrole: boolean;
  readonly replication: boolean;
  readonly inherit: boolean;
  readonly memberOf: string[];
  readonly temporaryOnDatabase: boolean;
  readonly createOnPublic: boolean;
  readonly financialExecute: string[];
  readonly journalDml: string[];
  readonly readsJournal: boolean;
  readonly readsAccounts: boolean;
}

async function roleMatrix(db: string): Promise<RoleRow[]> {
  section('11. the final role matrix (§32)');
  const rows: RoleRow[] = [];
  for (const role of ALL_ROLES) {
    const [attrs] = await sql<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolinherit: boolean;
    }>(ownerUrl(db), `SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolinherit FROM pg_roles WHERE rolname = $1`, [
      role,
    ]);
    const memberOf = (
      await sql<{ r: string }>(
        ownerUrl(db),
        `SELECT g.rolname AS r FROM pg_auth_members a JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member WHERE m.rolname = $1 ORDER BY 1`,
        [role],
      )
    ).map((x) => x.r);
    const [priv] = await sql<{ temp: boolean; create_public: boolean; reads_journal: boolean; reads_accounts: boolean }>(
      ownerUrl(db),
      `SELECT has_database_privilege($1, current_database(), 'TEMPORARY') AS temp,
              has_schema_privilege($1, 'public', 'CREATE')                AS create_public,
              has_table_privilege($1, 'journal_lines', 'SELECT')          AS reads_journal,
              has_table_privilege($1, 'accounts', 'SELECT')               AS reads_accounts`,
      [role],
    );
    const financialExecute = (
      await sql<{ f: string }>(
        ownerUrl(db),
        `SELECT p.proname AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname LIKE 'accounting\\_%'
            AND has_function_privilege($1, p.oid, 'EXECUTE') ORDER BY 1`,
        [role],
      )
    ).map((x) => x.f);
    const journalDml = (
      await sql<{ p: string }>(
        ownerUrl(db),
        `SELECT unnest(ARRAY['INSERT', 'UPDATE', 'DELETE']) AS p
          EXCEPT SELECT p FROM (SELECT unnest(ARRAY['INSERT', 'UPDATE', 'DELETE']) AS p) q
          WHERE NOT has_table_privilege($1, 'journal_lines', q.p) ORDER BY 1`,
        [role],
      )
    ).map((x) => x.p);
    rows.push({
      role,
      login: attrs.rolcanlogin,
      superuser: attrs.rolsuper,
      bypassrls: attrs.rolbypassrls,
      createdb: attrs.rolcreatedb,
      createrole: attrs.rolcreaterole,
      replication: attrs.rolreplication,
      inherit: attrs.rolinherit,
      memberOf,
      temporaryOnDatabase: priv.temp,
      createOnPublic: priv.create_public,
      financialExecute,
      journalDml,
      readsJournal: priv.reads_journal,
      readsAccounts: priv.reads_accounts,
    });
  }

  for (const r of rows) {
    console.log(
      `  ${r.role.padEnd(28)} login=${String(r.login)[0]} super=${String(r.superuser)[0]} bypassrls=${String(r.bypassrls)[0]} createdb=${String(r.createdb)[0]} ` +
        `createrole=${String(r.createrole)[0]} repl=${String(r.replication)[0]} temp=${String(r.temporaryOnDatabase)[0]} create(public)=${String(r.createOnPublic)[0]} ` +
        `journalDML=[${r.journalDml.join(',')}] memberOf=[${r.memberOf.join(',')}]`,
    );
  }

  // The invariants the matrix exists to protect.
  const superusers = rows.filter((r) => r.superuser);
  record('11.1 no principal is a superuser', superusers.length === 0, superusers.map((r) => r.role).join(', ') || 'none');
  const bypass = rows.filter((r) => r.bypassrls);
  record('11.2 no principal bypasses RLS', bypass.length === 0, bypass.map((r) => r.role).join(', ') || 'none');
  const writers = rows.filter((r) => r.role !== DEPLOYER && r.role !== 'daftar_accounting_internal' && r.journalDml.length > 0);
  record(
    '11.3 no runtime holds journal DML',
    writers.length === 0,
    writers.map((r) => `${r.role}:${r.journalDml.join('/')}`).join(', ') || 'only the deployer (as owner) and the internal posting authority',
  );
  const temps = rows.filter((r) => r.temporaryOnDatabase && r.role !== DEPLOYER);
  record('11.4 no runtime holds TEMPORARY', temps.length === 0, temps.map((r) => r.role).join(', ') || 'none');
  const creators = rows.filter((r) => r.createOnPublic && r.role !== DEPLOYER);
  record('11.5 only the deployer may create in public', creators.length === 0, creators.map((r) => r.role).join(', ') || 'none');
  const loginInternal = rows.find((r) => r.role === 'daftar_accounting_internal');
  record('11.6 the posting authority has no credential', loginInternal?.login === false, `daftar_accounting_internal login = ${String(loginInternal?.login)}`);
  const inventoryInternal = rows.find((r) => r.role === 'daftar_inventory_internal');
  record(
    '11.7 the inventory authority has no credential and inherits nothing',
    inventoryInternal?.login === false && inventoryInternal.inherit === false && inventoryInternal.memberOf.length === 0,
    `daftar_inventory_internal login = ${String(inventoryInternal?.login)}, inherit = ${String(inventoryInternal?.inherit)}, memberOf = [${inventoryInternal?.memberOf.join(',') ?? ''}]`,
  );
  const reachable = rows.filter(
    (r) => (RUNTIME_ROLES as readonly string[]).includes(r.role) && r.memberOf.some((m) => (INTERNAL_ROLES as readonly string[]).includes(m)),
  );
  record(
    '11.8 no runtime principal is a member of an internal authority',
    reachable.length === 0,
    reachable.map((r) => `${r.role} → ${r.memberOf.join(',')}`).join('; ') || 'none',
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const inventory = buildInventory();
  checkInventoryAgainstBootstrap(inventory);
  checkDeployerIsNotARuntime();

  let deployerShape: Record<string, unknown> = {};
  let matrix: RoleRow[] = [];
  let catalogue: Record<string, number> = {};

  if (!STATIC_ONLY) {
    startCluster();
    try {
      const DEPLOYED = 'daftar_deploy_case_a';
      await caseA(DEPLOYED);
      deployerShape = await checkLiveDeployerShape(DEPLOYED);
      await caseB('daftar_deploy_case_b');
      await caseC('daftar_deploy_case_c');
      await caseD(DEPLOYED);
      await caseE(DEPLOYED);
      await caseF('daftar_deploy_case_f');
      await caseG('daftar_deploy_case_g');
      await checkHistoryAuthority(DEPLOYED);

      // The superuser control: the same bootstrap and the same history,
      // applied by a superuser, for section 10 to compare against.
      const SUPER_DB = 'daftar_deploy_superuser_control';
      await freshDatabase(SUPER_DB);
      await runMigrations(ownerUrl(SUPER_DB), MIGRATIONS_DIR);
      catalogue = await checkCatalogueEquivalence(DEPLOYED, SUPER_DB);

      matrix = await roleMatrix(DEPLOYED);
    } finally {
      stopCluster();
    }
  }

  const releaseDir = join(ROOT, 'release');
  mkdirSync(releaseDir, { recursive: true });
  const artefact = {
    produced: 'scripts/phase2-deployment-authority.ts',
    producedAt: new Date().toISOString(),
    node: process.version,
    postgres: STATIC_ONLY ? null : run(join(PG_BIN, 'postgres'), ['--version'], { allowFailure: true }).trim(),
    deploymentPrincipal: DEPLOYER,
    staticOnly: STATIC_ONLY,
    inventory,
    bootstrapSha256: createHash('sha256')
      .update(readFileSync(join(ROOT, 'infrastructure/database/bootstrap.sql')))
      .digest('hex'),
    runnerSha256: createHash('sha256')
      .update(readFileSync(join(ROOT, 'apps/api/src/infra/migrate.ts')))
      .digest('hex'),
    deployerShape,
    catalogueRowCounts: catalogue,
    roleMatrix: matrix,
    steps,
    verdict: findings.length === 0 ? 'PASS' : 'FAIL',
    findings,
  };
  const out = join(releaseDir, 'phase2-s9-deployment-authority.json');
  writeFileSync(out, `${JSON.stringify(artefact, null, 2)}\n`);

  console.log(`\nDEPLOYMENT AUTHORITY: ${findings.length === 0 ? 'PASS' : `FAIL (${findings.length})`}`);
  console.log(`evidence: ${out.replace(`${ROOT}/`, '')}`);
  if (findings.length > 0) {
    for (const f of findings) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

void main().catch((e: unknown) => {
  stopCluster();
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
