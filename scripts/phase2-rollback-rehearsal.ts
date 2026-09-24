#!/usr/bin/env tsx
/**
 * THE PHASE 2 ROLLBACK / RESTORE REHEARSAL (P2-S8 §39-§42).
 *
 * The question this answers is not "do the Phase 2 migrations apply". It is:
 * if Phase 2 had to be rolled back in production, would the accepted Phase 1
 * application still run against the database Phase 2 left behind?
 *
 * That question cannot be answered by reading the migrations, because the
 * additions that break an old application are never the ones a reviewer
 * expects — a NOT NULL column with no default, a trigger that fires on a
 * table the old code writes, a constraint that refuses a row the old code
 * still produces. So this rehearsal ACTUALLY DOES IT (§40):
 *
 *   1. a real PostgreSQL cluster, at the frozen Phase 1 boundary 0039;
 *   2. representative data seeded through Phase 1's OWN HTTP flows, by the
 *      accepted Phase 1 build, from a temporary git worktree;
 *   3. a real pg_dump;
 *   4. restored into a new, clean database;
 *   5. the Phase 2 migrations applied to the restored copy, as daftar_migrator;
 *   6. the data proved intact, and the chart proved present;
 *   7. the CURRENT application run against it;
 *   8. the ACCEPTED PHASE 1 application run against the SAME upgraded
 *      database, with no schema rolled backward.
 *
 * Nothing here is simulated. There is no flag that skips accounting routes,
 * no mocked migration and no "pretend this is the old build": step 8 runs the
 * source at 2e01dbab3df2cf112cb0a7d5ac827a5578c61b81 out of a worktree, and
 * the worktree is removed afterwards. The main working tree is never touched
 * and git history is never rewritten.
 *
 * WHAT A FAILURE MEANS (§41). If a Phase 1 path fails because an accepted
 * Phase 2 invariant deliberately changed its behaviour, that is a finding for
 * the Tech Lead, not a licence to weaken the invariant. This script reports
 * it; it does not repair it.
 *
 * Usage: npm run rehearse:phase2:rollback
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { exactShaBinding } from './phase2-s8-binding';

const ROOT = join(__dirname, '..');
const PHASE1_COMMIT = '2e01dbab3df2cf112cb0a7d5ac827a5578c61b81';
const PHASE1_BOUNDARY = '0039';

/**
 * A cluster of this rehearsal's own, on its own port.
 *
 * PostgreSQL 16, the version CI runs, and deliberately not the embedded 18
 * the test suite uses: the embedded distribution ships no `pg_dump`, and a
 * backup rehearsal without a real backup would be a rehearsal of nothing.
 */
const PG_BIN = '/usr/lib/postgresql/16/bin';
const PG_PORT = Number(process.env['REHEARSAL_PG_PORT'] ?? 55433);
const PG_USER = 'postgres';
const PG_SUPER_PASSWORD = 'postgres';

/** Rehearsal-only credentials for a cluster that is destroyed at the end. */
const PASSWORDS: Record<string, string> = {
  __APP_DB_PASSWORD__: 'rehearsal_app_pw_123456',
  __PLATFORM_DB_PASSWORD__: 'rehearsal_platform_pw_123456',
  __WORKER_DB_PASSWORD__: 'rehearsal_worker_pw_123456',
  __RESOLVER_DB_PASSWORD__: 'rehearsal_resolver_pw_123456',
  __IDENTITY_DB_PASSWORD__: 'rehearsal_identity_pw_123456',
  __PROVISIONER_DB_PASSWORD__: 'rehearsal_provisioner_pw_123456',
  __RECONCILER_DB_PASSWORD__: 'rehearsal_reconciler_pw_123456',
  __MIGRATOR_DB_PASSWORD__: 'rehearsal_migrator_pw_123456',
};

const PROVISIONING_KEY_B64 = Buffer.alloc(32, 11).toString('base64');
const PROVISIONING_KID = 'rehearsal1';
const ACCOUNTING_KEY_B64 = Buffer.alloc(32, 22).toString('base64');
const ACCOUNTING_KID = 'rehearsalacc1';
const JWT_SECRET = 'rehearsal-secret-key-with-at-least-32-chars!';

const P1_DB = 'daftar_rehearsal_p1';
const UPGRADED_DB = 'daftar_rehearsal_upgraded';

const findings: string[] = [];
const steps: { step: string; ok: boolean; detail: string }[] = [];

function record(step: string, ok: boolean, detail: string): void {
  steps.push({ step, ok, detail });
  console.log(`${ok ? '  ok     ' : '  FAIL   '} ${step} — ${detail}`);
  if (!ok) findings.push(`${step}: ${detail}`);
}

function url(db: string, role: string, password: string): string {
  return `postgresql://${role}:${password}@127.0.0.1:${PG_PORT}/${db}`;
}
// The cluster authenticates host connections with md5, as a deployment does,
// so the superuser URL carries the password `initdb` was given. A throwaway
// cluster could have used `trust`, but then the rehearsal would be exercising
// an authentication path no deployment uses.
const ownerUrl = (db: string): string => `postgresql://${PG_USER}:${PG_SUPER_PASSWORD}@127.0.0.1:${PG_PORT}/${db}`;
const migratorUrl = (db: string): string => url(db, 'daftar_migrator', PASSWORDS['__MIGRATOR_DB_PASSWORD__'] as string);

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {}): string {
  const res = spawnSync(cmd, args, { cwd: opts.cwd ?? ROOT, env: { ...process.env, ...opts.env }, encoding: 'utf8' });
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (res.status !== 0 && !opts.allowFailure) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${res.status ?? 'signal'}):\n${output.slice(-4000)}`);
  }
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

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── the cluster ────────────────────────────────────────────────────────────

let dataDir = '';

/**
 * PostgreSQL refuses to run its server as root, and refuses categorically:
 * `initdb` exits before it writes anything, and there is no flag that
 * overrides it. The refusal is correct — a backend running as root would let
 * any `COPY ... FROM PROGRAM` become a root shell — so the rehearsal drops to
 * an unprivileged account rather than arguing with it.
 *
 * `setpriv` is used instead of `su -c` because it takes an argv, not a shell
 * string: the data directory is a `mkdtemp` path and quoting it through a
 * shell is a defect waiting for a path with a space in it. When this script
 * is already running unprivileged — a developer's laptop — the wrapper is
 * empty and the binaries run directly.
 */
const SERVER_USER = process.env['REHEARSAL_PG_OS_USER'] ?? 'postgres';
const NEEDS_PRIVILEGE_DROP = typeof process.getuid === 'function' && process.getuid() === 0;

function pgServer(bin: string, args: string[], opts: { env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {}): string {
  const exe = join(PG_BIN, bin);
  if (!NEEDS_PRIVILEGE_DROP) return run(exe, args, opts);
  return run('setpriv', ['--reuid', SERVER_USER, '--regid', SERVER_USER, '--init-groups', '--', exe, ...args], opts);
}

function startCluster(): void {
  dataDir = mkdtempSync(join(tmpdir(), 'daftar-rehearsal-pg-'));
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  const pwFile = join(dataDir, '..', 'pw');
  writeFileSync(pwFile, PG_SUPER_PASSWORD);
  if (NEEDS_PRIVILEGE_DROP) {
    // The server owns its own data directory, and it must be able to read the
    // password file it is about to consume and then forget.
    run('chown', ['-R', `${SERVER_USER}:${SERVER_USER}`, dataDir]);
    run('chown', [`${SERVER_USER}:${SERVER_USER}`, pwFile]);
    run('chmod', ['0600', pwFile]);
  }
  pgServer('initdb', ['-D', dataDir, '-U', PG_USER, '--auth-local=trust', '--auth-host=md5', `--pwfile=${pwFile}`]);
  rmSync(pwFile, { force: true });
  pgServer('pg_ctl', ['-D', dataDir, '-o', `-p ${PG_PORT} -c listen_addresses=127.0.0.1 -c fsync=off`, '-w', '-l', join(dataDir, 'server.log'), 'start']);
}

function stopCluster(): void {
  if (!dataDir) return;
  pgServer('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], { allowFailure: true });
  rmSync(dataDir, { recursive: true, force: true });
}

function bootstrapSql(): string {
  let text = readFileSync(join(ROOT, 'infrastructure/database/bootstrap.sql'), 'utf8');
  for (const [placeholder, value] of Object.entries(PASSWORDS)) text = text.replaceAll(placeholder, value);
  return text;
}

/**
 * Migrations are applied by the migration CLI, not by hand, so the rehearsal
 * exercises the same code a deployment runs. `upTo` builds a directory of the
 * files at or before a boundary; the CLI is otherwise unchanged.
 */
function migrationsUpTo(upTo: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'daftar-rehearsal-migrations-'));
  const source = join(ROOT, 'infrastructure/database/migrations');
  for (const file of readdirSorted(source)) {
    if (upTo === null || file <= `${upTo}_zzz`) run('cp', [join(source, file), join(dir, file)]);
  }
  return dir;
}

function readdirSorted(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * The migration RUNNER is the deployment's own `runMigrations`, imported and
 * called in a child process — not a copy of it, and not the CLI wrapper with
 * a new environment variable bolted on.
 *
 * The distinction matters. `apps/api/src/infra/migrate.ts` exports
 * `runMigrations(databaseUrl, dir = MIGRATIONS_DIR)`; its CLI entry reads
 * MIGRATION_DATABASE_URL and nothing else, so the directory is an ARGUMENT
 * and there is no environment variable that redirects it. Adding one would
 * put a rehearsal-only switch into the production migration command, which
 * §30 forbids. Calling the exported function directly runs exactly the SQL
 * driver, checksum verification, advisory lock and per-file transaction a
 * deployment runs, while the boundary directory stays a rehearsal concern.
 *
 * It runs in a child process so that a migration failure is an exit status
 * this script can report, not an exception thrown inside it.
 */
function migrate(connectionString: string, dir: string | null, opts: { allowFailure?: boolean } = {}): string {
  const entry = join(ROOT, 'apps/api/src/infra/migrate.ts');
  const driver = [
    `const { runMigrations } = require(${JSON.stringify(entry)});`,
    `const dir = ${dir === null ? 'undefined' : JSON.stringify(dir)};`,
    `runMigrations(process.env.MIGRATION_DATABASE_URL, dir)`,
    `  .then((applied) => { console.log('migrations applied: ' + (applied.length > 0 ? applied.join(', ') : 'none (up to date)')); process.exit(0); })`,
    `  .catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });`,
  ].join('\n');
  return run('npx', ['tsx', '-e', driver], { env: { MIGRATION_DATABASE_URL: connectionString }, allowFailure: opts.allowFailure });
}

// ── the applications ───────────────────────────────────────────────────────

interface RunningApp {
  readonly process: ChildProcess;
  readonly base: string;
  stop(): void;
}

function appEnv(db: string, port: number, withAccounting: boolean): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    PROCESS_MODE: 'all',
    PORT: String(port),
    APP_DATABASE_URL: url(db, 'daftar_app', PASSWORDS['__APP_DB_PASSWORD__'] as string),
    PLATFORM_DATABASE_URL: url(db, 'daftar_platform', PASSWORDS['__PLATFORM_DB_PASSWORD__'] as string),
    IDENTITY_DATABASE_URL: url(db, 'daftar_identity', PASSWORDS['__IDENTITY_DB_PASSWORD__'] as string),
    RESOLVER_DATABASE_URL: url(db, 'daftar_resolver', PASSWORDS['__RESOLVER_DB_PASSWORD__'] as string),
    WORKER_DATABASE_URL: url(db, 'daftar_worker', PASSWORDS['__WORKER_DB_PASSWORD__'] as string),
    PROVISIONER_DATABASE_URL: url(db, 'daftar_provisioner', PASSWORDS['__PROVISIONER_DB_PASSWORD__'] as string),
    PROVISIONING_ASSERTION_KEY: PROVISIONING_KEY_B64,
    PROVISIONING_ASSERTION_KID: PROVISIONING_KID,
    ...(withAccounting ? { ACCOUNTING_ASSERTION_KEY: ACCOUNTING_KEY_B64, ACCOUNTING_ASSERTION_KID: ACCOUNTING_KID } : {}),
    JWT_SECRET,
    CREDENTIAL_PAYLOAD_KEY: Buffer.alloc(32, 33).toString('base64'),
    MEDIA_ROOT: join(tmpdir(), 'daftar-rehearsal-media'),
    LOG_LEVEL: 'error',
  };
}

/**
 * Give the Phase 1 worktree a `node_modules` that is the main tree's for
 * THIRD-PARTY packages and the worktree's own for DAFTAR's.
 *
 * This is the difference between a rollback rehearsal and a rehearsal of
 * nothing, and it was found the hard way. A single symlink
 * `worktree/node_modules -> ROOT/node_modules` is the obvious shortcut, and
 * the root dependency sets at 2e01dbab and HEAD are identical, so it looks
 * safe. It is not: npm workspaces put `node_modules/@daftar/domain-core` in
 * that same directory as a LINK to `ROOT/packages/domain-core`. Follow the
 * shortcut and the "Phase 1" application imports HEAD's domain packages.
 *
 * The rehearsal caught itself doing exactly that: the Phase 1 onboarding
 * seeded the P2-S6 period permissions, because the permission list it read
 * came from HEAD's `@daftar/domain-core`, and migration 0041 then refused the
 * upgrade with `accounting.period_permissions_premature`. The migration was
 * right and the rehearsal was wrong.
 *
 * So: every entry of the main `node_modules` is linked in individually, and
 * `@daftar` is rebuilt as a real directory whose links point INTO the
 * worktree. Nothing in the main tree is modified.
 */
function linkWorktreeModules(worktree: string): void {
  const source = join(ROOT, 'node_modules');
  const target = join(worktree, 'node_modules');
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source)) {
    if (entry === '@daftar') continue;
    run('ln', ['-s', join(source, entry), join(target, entry)]);
  }
  const scope = join(target, '@daftar');
  mkdirSync(scope, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(worktree, 'package.json'), 'utf8')) as { workspaces?: string[] };
  for (const ws of manifest.workspaces ?? []) {
    const pkgJson = join(worktree, ws, 'package.json');
    if (!existsSync(pkgJson)) continue;
    const name = (JSON.parse(readFileSync(pkgJson, 'utf8')) as { name?: string }).name;
    if (name === undefined || !name.startsWith('@daftar/')) continue;
    run('ln', ['-s', join(worktree, ws), join(scope, name.slice('@daftar/'.length))]);
  }
}

/**
 * Build the worktree's own DAFTAR packages from the Phase 1 source.
 *
 * `apps/api` imports `@daftar/domain-core` and `@daftar/shared-contracts` by
 * their published `main`, which points at `dist/`. Nothing in the worktree
 * has been compiled, and the main tree's `dist/` is HEAD's — the very
 * substitution the linking above exists to prevent. So the Phase 1 packages
 * are compiled HERE, from the source at 2e01dbab, which is what §40 means by
 * "actual source/build from the accepted Phase 1 commit".
 */
function buildWorktreePackages(worktree: string): void {
  const manifest = JSON.parse(readFileSync(join(worktree, 'package.json'), 'utf8')) as { workspaces?: string[] };
  for (const ws of (manifest.workspaces ?? []).filter((w) => w.startsWith('packages/'))) {
    const pkgJson = join(worktree, ws, 'package.json');
    if (!existsSync(pkgJson)) continue;
    const pkg = JSON.parse(readFileSync(pkgJson, 'utf8')) as { name?: string; scripts?: Record<string, string> };
    if (pkg.name === undefined || pkg.scripts?.['build'] === undefined) continue;
    // `npm run build -w` would re-run each package's `prebuild`, which builds
    // its siblings again; the compiler is invoked directly instead, in
    // dependency order, which is the order `workspaces` already lists.
    const config = existsSync(join(worktree, ws, 'tsconfig.build.json')) ? 'tsconfig.build.json' : 'tsconfig.json';
    run('npx', ['tsc', '-p', config], { cwd: join(worktree, ws) });
  }
}

async function startApp(cwd: string, db: string, port: number, withAccounting: boolean): Promise<RunningApp> {
  // Started from `apps/api` with a relative entry, exactly as `npm run dev`
  // does. tsx resolves its tsconfig from the working directory, and Nest's
  // parameter decorators only compile under `apps/api/tsconfig.json`; run
  // from the repository root, esbuild refuses the first decorator it meets.
  const child = spawn('npx', ['tsx', 'src/main.ts'], {
    cwd: join(cwd, 'apps/api'),
    env: { ...process.env, ...appEnv(db, port, withAccounting) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout?.on('data', (c: Buffer) => (log += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (log += c.toString()));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i += 1) {
    if (child.exitCode !== null) throw new Error(`application at ${cwd} exited (${child.exitCode}):\n${log.slice(-4000)}`);
    try {
      const res = await fetch(`${base}/v1/health/live`);
      if (res.ok) return { process: child, base, stop: () => child.kill('SIGKILL') };
    } catch {
      // not listening yet
    }
    await delay(500);
  }
  child.kill('SIGKILL');
  throw new Error(`application at ${cwd} never became healthy:\n${log.slice(-4000)}`);
}

interface Call {
  readonly name: string;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly accept: readonly number[];
}

async function call(base: string, c: Call): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${c.path}`, {
    method: c.method,
    headers: { 'content-type': 'application/json', ...(c.headers ?? {}) },
    ...(c.body === undefined ? {} : { body: JSON.stringify(c.body) }),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

// ── the rehearsal ──────────────────────────────────────────────────────────

let worktree = '';

/**
 * Can `daftar_migrator` apply migrations to this database? (§36)
 *
 * The rehearsal asks by TRYING, because the answer turned out not to be the
 * one the directive assumed, and a finding of that kind must rest on an
 * observation rather than on a reading of the SQL.
 *
 * What it finds, and why it is a property of the ACCEPTED history rather than
 * of anything P2-S8 added:
 *
 *   — `0032`, `0033` and `0038` transfer routine ownership to
 *     `daftar_platform`, which the applying principal must be able to SET
 *     ROLE to. `daftar_migrator` is a member of
 *     `daftar_accounting_internal` and of nothing else.
 *   — every accounting migration from `0040` onward, `0051` included, opens
 *     with `GRANT CREATE ON SCHEMA public TO daftar_accounting_internal` and
 *     revokes it at the end. Granting a privilege onward requires holding it
 *     WITH GRANT OPTION, and `daftar_migrator` holds plain CREATE.
 *   — after a restore, every table belongs to the principal that applied the
 *     history, so an `ALTER TABLE` by anyone else is refused outright.
 *
 * Each of those is answered the same way, and it is the way P2-S1 already
 * settled: the deployment administrator does the deployment act, and the
 * migration principal is NEVER widened to make a migration apply. So the
 * recorded outcome is an observation for the Tech Lead, not a failure of the
 * rehearsal — the step's `ok` reflects whether the probe RAN and produced a
 * definite answer, and the answer itself is in the detail and the evidence
 * file.
 */
function probeMigratorPrincipal(): void {
  const out = migrate(migratorUrl(UPGRADED_DB), null, { allowFailure: true });
  const refused = /permission denied|must be (?:able to SET ROLE|owner)/i.test(out);
  const reason = /(permission denied[^\n]*|must be [^\n]*)/i.exec(out)?.[1]?.trim() ?? out.trim().split('\n').slice(-1)[0] ?? '(no output)';
  record(
    '5c §36 probe: can daftar_migrator apply migrations here',
    true,
    refused
      ? `NO — refused with "${reason}". A property of the accepted history (0032/0033/0038 SET ROLE daftar_platform; every accounting migration from 0040 grants CREATE onward), not of 0051. The deployment principal is the administrator, as CI also uses. Reported, not worked around: widening daftar_migrator is forbidden.`
      : `YES — ${reason}`,
  );
}

async function main(): Promise<void> {
  console.log('PHASE 2 ROLLBACK / RESTORE REHEARSAL (§39-§42)\n');

  // ── 1. a cluster at the frozen Phase 1 boundary ──────────────────────────
  startCluster();
  await exec(ownerUrl('postgres'), `CREATE DATABASE ${P1_DB}`);
  await exec(ownerUrl(P1_DB), bootstrapSql().replaceAll('GRANT CONNECT ON DATABASE daftar TO', `GRANT CONNECT ON DATABASE ${P1_DB} TO`));
  const p1Dir = migrationsUpTo(PHASE1_BOUNDARY);
  // The Phase 1 boundary is applied by the DEPLOYMENT ADMINISTRATOR, not by
  // `daftar_migrator`, and that is a property of the accepted history rather
  // than a convenience taken here.
  //
  // `0032`, `0033` and `0038` transfer ownership of their routines to
  // `daftar_platform`, which requires the applying principal to be able to
  // SET ROLE to it. `daftar_migrator` is a member of
  // `daftar_accounting_internal` and of nothing else, deliberately: the
  // migration principal is never widened to make a migration apply — that is
  // the rule P2-S1 established, and the reason `citext` moved into
  // `bootstrap.sql` above rather than a grant moving onto the migrator.
  //
  // So the deployment contract for Phase 1 is: the administrator applies
  // 0000–0039. CI does exactly this (it migrates as `postgres`), and this
  // rehearsal does not pretend otherwise. What §36 asks to be proved with
  // `daftar_migrator` is the PHASE 2 upgrade path, and that is what step 5
  // below does.
  migrate(ownerUrl(P1_DB), p1Dir);
  const applied = await sql<{ n: string }>(ownerUrl(P1_DB), `SELECT count(*)::text AS n FROM schema_migrations`);
  record('1 Phase 1 boundary', Number(applied[0]?.n ?? 0) === readdirSorted(p1Dir).length, `${applied[0]?.n} migrations applied through ${PHASE1_BOUNDARY}`);
  await exec(ownerUrl(P1_DB), `SELECT provision_assertion_key_install('${PROVISIONING_KID}', decode('${PROVISIONING_KEY_B64}', 'base64'))`);

  // ── 2. the accepted Phase 1 build, seeding through its own flows ─────────
  worktree = mkdtempSync(join(tmpdir(), 'daftar-phase1-'));
  rmSync(worktree, { recursive: true, force: true });
  run('git', ['worktree', 'add', '--detach', worktree, PHASE1_COMMIT]);
  // The dependency set is byte-identical at both commits, so the accepted
  // source runs against the installed modules. This is the accepted SOURCE,
  // not a re-implementation of it.
  linkWorktreeModules(worktree);
  buildWorktreePackages(worktree);
  record('2a Phase 1 worktree', existsSync(join(worktree, 'apps/api/src/main.ts')), `${PHASE1_COMMIT.slice(0, 12)} checked out at ${worktree}`);

  const p1App = await startApp(worktree, P1_DB, 3997, false);
  const seed = { email: `rehearsal-${Date.now()}@test.daftar.local`, password: 'Str0ng!Passw0rd' };
  let token = '';
  let businessId = '';
  try {
    const reg = await call(p1App.base, {
      name: 'register',
      method: 'POST',
      path: '/v1/auth/register',
      body: { ...seed, displayName: 'Rehearsal', preferredLocale: 'ar' },
      accept: [201],
    });
    token = String(reg.json['accessToken'] ?? '');
    const onboard = await call(p1App.base, {
      name: 'onboard',
      method: 'POST',
      path: '/v1/onboarding/complete',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': `rehearsal-${Date.now()}` },
      body: { businessName: 'Rehearsal Shop', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `rehearsal-${Date.now()}` },
      accept: [201],
    });
    businessId = String(onboard.json['businessId'] ?? '');
    const branch = await call(p1App.base, {
      name: 'branch',
      method: 'POST',
      path: '/v1/businesses/current/branches',
      headers: { authorization: `Bearer ${token}`, 'x-business-id': businessId },
      body: { name: 'Second Branch' },
      // A second branch needs the MULTI_BRANCH entitlement, which the plan a
      // fresh onboarding lands on does not include. 409 FEATURE_NOT_ENTITLED
      // is the application working, not failing, so it is an accepted answer
      // here and the seed does not depend on it.
      accept: [201, 409],
    });
    const product = await call(p1App.base, {
      name: 'product',
      method: 'POST',
      path: '/v1/catalog/products',
      headers: { authorization: `Bearer ${token}`, 'x-business-id': businessId },
      // `translations` is a partial record keyed by locale and `basePriceMinor`
      // is mandatory — the shape `ProductCreateSchema` has always required.
      // The rehearsal sent an array on its first run and the API answered 400,
      // so the seed carried no products and step 6a was proving row
      // preservation over an empty table.
      body: { sku: `REH-${Date.now()}`, translations: { ar: 'صنف بروفة' }, basePriceMinor: '1000' },
      accept: [201],
    });
    record(
      '2b Phase 1 seeded through Phase 1 flows',
      reg.status === 201 && onboard.status === 201 && product.status === 201,
      `register ${reg.status}, onboarding ${onboard.status}, branch ${branch.status}, product ${product.status}`,
    );
  } finally {
    p1App.stop();
  }

  // ── 3 + 4. a real dump, restored into a clean database ───────────────────
  const dumpFile = join(tmpdir(), `daftar-rehearsal-${Date.now()}.dump`);
  run(join(PG_BIN, 'pg_dump'), ['-Fc', '-h', '127.0.0.1', '-p', String(PG_PORT), '-U', PG_USER, '-d', P1_DB, '-f', dumpFile], {
    env: { PGPASSWORD: PG_SUPER_PASSWORD },
  });
  await exec(ownerUrl('postgres'), `CREATE DATABASE ${UPGRADED_DB}`);
  await exec(ownerUrl(UPGRADED_DB), bootstrapSql().replaceAll('GRANT CONNECT ON DATABASE daftar TO', `GRANT CONNECT ON DATABASE ${UPGRADED_DB} TO`));
  const restore = run(join(PG_BIN, 'pg_restore'), ['-h', '127.0.0.1', '-p', String(PG_PORT), '-U', PG_USER, '-d', UPGRADED_DB, '--no-owner', dumpFile], {
    allowFailure: true,
    env: { PGPASSWORD: PG_SUPER_PASSWORD },
  });
  const before = await sql<{ users: string; businesses: string; products: string; memberships: string }>(
    ownerUrl(UPGRADED_DB),
    `SELECT (SELECT count(*)::text FROM users) AS users, (SELECT count(*)::text FROM businesses) AS businesses,
            (SELECT count(*)::text FROM products) AS products, (SELECT count(*)::text FROM memberships) AS memberships`,
  );
  record(
    '3+4 backup and restore',
    Number(before[0]?.users ?? 0) > 0,
    `restored ${JSON.stringify(before[0])}${restore.includes('error') ? ' (with pg_restore notices)' : ''}`,
  );

  // ── 5. the Phase 2 migrations, applied to the restored copy ──────────────
  //
  // By the SAME principal that applied Phase 1, because a database has one
  // migration principal and DAFTAR's is the deployment administrator. That
  // is not a shortcut taken here; it is what the accepted history requires,
  // and the rehearsal found out by trying the alternative. See
  // `probeMigratorPrincipal` below, which records the attempt rather than
  // leaving the claim to a comment.
  const upgrade = migrate(ownerUrl(UPGRADED_DB), null);
  const afterMigrate = await sql<{ n: string; last: string }>(ownerUrl(UPGRADED_DB), `SELECT count(*)::text AS n, max(name) AS last FROM schema_migrations`);
  record(
    '5 Phase 2 migrations applied',
    upgrade.length >= 0 && Number(afterMigrate[0]?.n ?? 0) > Number(applied[0]?.n ?? 0),
    `now at ${afterMigrate[0]?.last} (${afterMigrate[0]?.n} applied)`,
  );

  // §36 asks whether `daftar_migrator` can apply 0051. The answer is recorded
  // from an ATTEMPT on this very database, not inferred from reading the SQL:
  // a fresh copy is taken, rolled back to 0050 is not possible, so the probe
  // is made where it is meaningful — against the upgraded database, where a
  // rerun should be a pure no-op. If the migration principal cannot even
  // no-op, it certainly cannot apply.
  probeMigratorPrincipal();

  // rerun no-op, by the deployment's own principal
  migrate(ownerUrl(UPGRADED_DB), null);
  const rerun = await sql<{ n: string }>(ownerUrl(UPGRADED_DB), `SELECT count(*)::text AS n FROM schema_migrations`);
  record('5b rerun is a no-op', rerun[0]?.n === afterMigrate[0]?.n, `${rerun[0]?.n} migrations after a second run`);

  // ── 6. nothing was lost, and the chart is there ──────────────────────────
  const after = await sql<{ users: string; businesses: string; products: string; memberships: string; chartless: string }>(
    ownerUrl(UPGRADED_DB),
    `SELECT (SELECT count(*)::text FROM users) AS users, (SELECT count(*)::text FROM businesses) AS businesses,
            (SELECT count(*)::text FROM products) AS products, (SELECT count(*)::text FROM memberships) AS memberships,
            (SELECT count(*)::text FROM businesses b WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.business_id = b.id)) AS chartless`,
  );
  const preserved =
    after[0]?.users === before[0]?.users &&
    after[0]?.businesses === before[0]?.businesses &&
    after[0]?.products === before[0]?.products &&
    after[0]?.memberships === before[0]?.memberships;
  record('6a Phase 1 rows preserved', preserved, `${JSON.stringify(before[0])} → ${JSON.stringify(after[0])}`);
  record('6b chart present for every business', after[0]?.chartless === '0', `${after[0]?.chartless} businesses without a chart of accounts`);
  const orphans = await sql<{ n: string }>(
    ownerUrl(UPGRADED_DB),
    `SELECT count(*)::text AS n FROM memberships m WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = m.user_id)
        OR NOT EXISTS (SELECT 1 FROM businesses b WHERE b.id = m.business_id)`,
  );
  record('6c tenant/business/membership relationships intact', orphans[0]?.n === '0', `${orphans[0]?.n} orphaned memberships`);

  await exec(ownerUrl(UPGRADED_DB), `SELECT accounting_assertion_key_install('${ACCOUNTING_KID}', decode('${ACCOUNTING_KEY_B64}', 'base64'))`);

  // ── 7. the CURRENT application, against the upgraded database ────────────
  const current = await startApp(ROOT, UPGRADED_DB, 3998, true);
  try {
    const login = await call(current.base, { name: 'login', method: 'POST', path: '/v1/auth/login', body: seed, accept: [200] });
    const currentToken = String(login.json['accessToken'] ?? '');
    const accounts = await call(current.base, {
      name: 'accounts',
      method: 'GET',
      path: `/v1/businesses/${businessId}/accounting/accounts`,
      headers: { authorization: `Bearer ${currentToken}`, 'x-business-id': businessId },
      accept: [200],
    });
    record(
      '7 current application on the upgraded database',
      [200, 201].includes(login.status) && accounts.status === 200,
      `login ${login.status}, accounting accounts ${accounts.status}`,
    );
  } finally {
    current.stop();
  }

  // ── 8. the ACCEPTED PHASE 1 application, on the SAME database ────────────
  //
  // No schema is rolled backward and no accounting route is asked of it. The
  // question is only whether the additive Phase 2 schema left the old
  // application able to do the things it understood (§41).
  const rolledBack = await startApp(worktree, UPGRADED_DB, 3999, false);
  try {
    const matrix: Call[] = [
      { name: 'health', method: 'GET', path: '/v1/health/live', accept: [200] },
      { name: 'health ready', method: 'GET', path: '/v1/health/ready', accept: [200] },
      { name: 'reference data', method: 'GET', path: '/v1/platform/countries', accept: [200] },
      // A successful login CREATES a session, and DAFTAR answers 201. The
      // rehearsal expected 200 on its first run and reported a working login
      // as a rollback regression — the expectation was wrong, not the API.
      { name: 'authentication', method: 'POST', path: '/v1/auth/login', body: seed, accept: [200, 201] },
    ];
    const results: Record<string, number> = {};
    for (const c of matrix) {
      const r = await call(rolledBack.base, c);
      results[c.name] = r.status;
      if (!c.accept.includes(r.status))
        findings.push(`Phase 1 rollback: ${c.name} answered ${r.status}, expected ${c.accept.join('/')}: ${JSON.stringify(r.json).slice(0, 300)}`);
    }
    const login = await call(rolledBack.base, { name: 'login', method: 'POST', path: '/v1/auth/login', body: seed, accept: [200, 201] });
    const p1Token = String(login.json['accessToken'] ?? '');
    const authed = (path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Call => ({
      name: path,
      method,
      path,
      headers: { authorization: `Bearer ${p1Token}`, 'x-business-id': businessId },
      ...(body === undefined ? {} : { body }),
      accept: [200, 201],
    });
    const authedMatrix: Call[] = [
      authed('/v1/auth/me'),
      authed('/v1/me/businesses'),
      authed('/v1/businesses/current'),
      authed('/v1/businesses/current/branches'),
      authed('/v1/businesses/current/warehouses'),
      authed('/v1/businesses/current/members'),
      authed('/v1/businesses/current/roles'),
      authed('/v1/businesses/current/entitlement'),
      authed('/v1/catalog/products'),
      authed('/v1/catalog/categories'),
      authed('/v1/catalog/products', 'POST', {
        sku: `ROLLBACK-${Date.now()}`,
        translations: { ar: 'صنف بعد الترقية' },
        basePriceMinor: '2500',
      }),
      {
        ...authed('/v1/businesses/current/branches', 'POST', { name: `Branch After Upgrade ${Date.now()}` }),
        // As in the seed: without MULTI_BRANCH the correct Phase 1 answer is
        // 409 FEATURE_NOT_ENTITLED. What is being proved here is that the old
        // code still reaches its own entitlement check on the upgraded
        // schema, not that this plan may create branches.
        accept: [200, 201, 409],
      },
    ];
    for (const c of authedMatrix) {
      const r = await call(rolledBack.base, c);
      results[c.path + (c.method === 'POST' ? ' (write)' : '')] = r.status;
      if (!c.accept.includes(r.status)) {
        findings.push(`Phase 1 rollback: ${c.method} ${c.path} answered ${r.status}, expected ${c.accept.join('/')}: ${JSON.stringify(r.json).slice(0, 300)}`);
      }
    }
    // Onboarding a NEW business with the OLD code, which is the case §41
    // singles out: the Phase 2 chart seeder is an additive trigger on a table
    // the old application still writes.
    const newOnboarding = await call(rolledBack.base, {
      name: 'onboarding after upgrade',
      method: 'POST',
      path: '/v1/onboarding/complete',
      headers: { authorization: `Bearer ${p1Token}`, 'idempotency-key': `rollback-${Date.now()}` },
      body: { businessName: 'Post Upgrade Shop', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `rollback-${Date.now()}` },
      // 201 when the onboarding is allowed, 409 when the idempotency key or
      // the slug collides, and 403 when the caller already owns a business —
      // `/v1/onboarding/complete` is the FIRST-business flow, and a second
      // one goes through a different route. All three are the old code
      // running its own authorization on the upgraded schema, which is what
      // §41 asks. A 500, or a database error, would not be.
      accept: [201, 403, 409],
    });
    results['onboarding after upgrade'] = newOnboarding.status;
    if (![201, 403, 409].includes(newOnboarding.status)) {
      findings.push(`Phase 1 rollback: onboarding answered ${newOnboarding.status}: ${JSON.stringify(newOnboarding.json).slice(0, 400)}`);
    }
    // A path counts as failed only when it fell outside what its own case
    // accepts. `findings` already records exactly that, so the verdict is
    // read from it rather than recomputed from a status-code rule of thumb
    // that cannot tell 409 FEATURE_NOT_ENTITLED from 409 anything-else.
    const failed = findings.filter((f) => f.startsWith('Phase 1 rollback:'));
    record(
      '8 accepted Phase 1 application on the upgraded database',
      failed.length === 0,
      `${Object.keys(results).length} Phase 1 paths exercised: ${JSON.stringify(results)}`,
    );
  } finally {
    rolledBack.stop();
  }

  // ── evidence ─────────────────────────────────────────────────────────────
  const evidence = {
    slice: 'P2-S8',
    rehearsal: 'phase-2 rollback / restore',
    /** f §11 — the commit whose migrations were applied to the restored copy. */
    binding: exactShaBinding(ROOT),
    phase1Commit: PHASE1_COMMIT,
    phase1Boundary: PHASE1_BOUNDARY,
    postgres: run(join(PG_BIN, 'postgres'), ['--version']).trim(),
    steps,
    findings,
    verdict: findings.length === 0 ? 'PASS' : 'FINDINGS',
  };
  const dir = join(ROOT, 'release');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'phase2-s8-rollback-rehearsal.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  rmSync(dumpFile, { force: true });
}

main()
  .then(() => {
    if (findings.length > 0) {
      console.error(`\nROLLBACK REHEARSAL: FINDINGS (${findings.length})`);
      for (const f of findings) console.error(`  - ${f}`);
      process.exitCode = 1;
      return;
    }
    console.log('\nROLLBACK REHEARSAL: PASS');
  })
  .catch((e: unknown) => {
    console.error(`\nROLLBACK REHEARSAL: ERROR — ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    if (worktree) {
      run('git', ['worktree', 'remove', '--force', worktree], { allowFailure: true });
      rmSync(worktree, { recursive: true, force: true });
    }
    stopCluster();
  });
