/**
 * THE REAL STACK THE BROWSER GATE DRIVES (directive §8).
 *
 * Nothing here is mocked. A fresh embedded PostgreSQL is initialised in an
 * empty directory, the deployment's own `bootstrap.sql` creates the roles,
 * every migration is applied from `0000`, and the three assertion keys are
 * installed the way the operator's commands install them. Then the BUILT
 * merchant API (`apps/api/dist/main.js`, merchant-api mode, the real runtime
 * roles) and the PRODUCTION web build are started as child processes. The
 * web build is served through its production entry, `node server.mts` (what
 * `npm start` runs and what ships, TD-19), never `next start`: CSP enforced,
 * nonces per request, and every request's TCP peer appended to
 * `X-Forwarded-For`. The API lists the loopback addresses the web server
 * calls it from in `TRUSTED_PROXIES`, as a deployment lists its web tier, so
 * the API identifies each request by the browser's own (loopback) address. The gate talks to them over HTTP
 * only, the browser included.
 *
 * `embedded-cluster.ts` reads PG_DIR / PG_PORT when it is first imported, so
 * the environment is set before the dynamic import below.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import { ensureEmbeddedPgBinariesExecutable } from '../../scripts/ensure-embedded-pg-binaries';
import { runMigrations } from '../../apps/api/src/infra/migrate';

export const ROOT = join(__dirname, '..', '..');

/** Fixture key material for a throwaway cluster, three distinct secrets (the API refuses equal ones). Never a deployment's. */
const KEYS = {
  provisioning: { kid: 'v1', b64: Buffer.from('browser-gate-provisioning-key-32-bytes!!').subarray(0, 32).toString('base64') },
  accounting: { kid: 'acct1', b64: Buffer.from('browser-gate-accounting-key-32-bytes!!!!').subarray(0, 32).toString('base64') },
  inventory: { kid: 'inv1', b64: Buffer.from('browser-gate-inventory-key-32-bytes!!!!!').subarray(0, 32).toString('base64') },
} as const;

export interface StackPorts {
  readonly pg: number;
  readonly api: number;
  readonly web: number;
}

export interface Stack {
  readonly apiUrl: string;
  readonly webUrl: string;
  readonly migrations: number;
  stop(): Promise<void>;
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  await waitForExit(child);
  clearTimeout(timer);
}

/** Poll `url` until it answers 2xx, or fail when `child` dies or the deadline passes. */
async function waitForHttp(url: string, child: ChildProcess, what: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${what} exited with code ${child.exitCode} before it answered ${url}`);
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error; // connection refused surfaces as a TypeError from fetch
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${what} did not answer ${url} within ${timeoutMs / 1000}s`);
}

/**
 * Refuse to start on a port something already answers on: `waitForHttp`
 * would otherwise be satisfied by that stranger (a stale server from an
 * earlier run) while the process under test dies on EADDRINUSE, and the gate
 * would check the wrong build.
 */
async function assertNothingAnswers(url: string, what: string): Promise<void> {
  try {
    await fetch(url);
  } catch (error) {
    if (error instanceof TypeError) return; // connection refused: the port is free
    throw error;
  }
  throw new Error(`something already answers ${url}; refusing to start ${what} behind it`);
}

function startProcess(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, logFile: string): ChildProcess {
  const log = createWriteStream(logFile);
  const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  return child;
}

/**
 * Start everything on the given ports. `pgDir` must be a path the embedded
 * server may own (directly under /tmp or the CI runner's temp directory); it is
 * deleted first, so the database is always new.
 */
export async function startStack(ports: StackPorts, pgDir: string, logDir: string): Promise<Stack> {
  mkdirSync(logDir, { recursive: true });
  if (existsSync(pgDir)) rmSync(pgDir, { recursive: true, force: true });
  process.env['PG_DIR'] = pgDir;
  process.env['PG_PORT'] = String(ports.pg);
  const cluster = await import('../helpers/embedded-cluster');

  ensureEmbeddedPgBinariesExecutable();
  const pgLog = createWriteStream(join(logDir, 'postgres.log'));
  const pg = new EmbeddedPostgres({
    databaseDir: pgDir,
    user: cluster.PG_USER,
    password: cluster.PG_PASSWORD,
    port: ports.pg,
    persistent: false,
    onLog: (m: unknown) => pgLog.write(`${String(m)}\n`),
    onError: (m: unknown) => pgLog.write(`ERROR ${String(m)}\n`),
  });
  await pg.initialise();
  await pg.start();
  const children: ChildProcess[] = [];
  const stop = async (): Promise<void> => {
    for (const child of children.reverse()) await stopChild(child);
    await pg.stop();
    rmSync(pgDir, { recursive: true, force: true });
  };
  try {
    await pg.createDatabase('daftar');
    await cluster.applyBootstrap('daftar');
    const ownerUrl = `postgresql://${cluster.PG_USER}:${cluster.PG_PASSWORD}@localhost:${ports.pg}/daftar`;
    const applied = await runMigrations(ownerUrl);
    const again = await runMigrations(ownerUrl);
    if (again.length !== 0) throw new Error(`a second migration pass applied ${again.length} file(s); it must be a no-op`);
    const owner = new Pool({ connectionString: ownerUrl, max: 1 });
    try {
      await owner.query(`SELECT provision_assertion_key_install($1, decode($2, 'base64'))`, [KEYS.provisioning.kid, KEYS.provisioning.b64]);
      await owner.query(`SELECT accounting_assertion_key_install($1, decode($2, 'base64'))`, [KEYS.accounting.kid, KEYS.accounting.b64]);
      await owner.query(`SELECT inventory_assertion_key_install($1, decode($2, 'base64'))`, [KEYS.inventory.kid, KEYS.inventory.b64]);
    } finally {
      await owner.end();
    }

    const role = (name: string, password: string) => `postgresql://${name}:${password}@localhost:${ports.pg}/daftar`;
    const apiUrl = `http://localhost:${ports.api}`;
    const webUrl = `http://localhost:${ports.web}`;
    const apiEnv: NodeJS.ProcessEnv = {
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      NODE_ENV: 'development',
      PROCESS_MODE: 'merchant-api',
      PORT: String(ports.api),
      APP_DATABASE_URL: role('daftar_app', cluster.APP_DB_PASSWORD),
      IDENTITY_DATABASE_URL: role('daftar_identity', cluster.IDENTITY_DB_PASSWORD),
      RESOLVER_DATABASE_URL: role('daftar_resolver', cluster.RESOLVER_DB_PASSWORD),
      PROVISIONER_DATABASE_URL: role('daftar_provisioner', cluster.PROVISIONER_DB_PASSWORD),
      PROVISIONING_ASSERTION_KEY: KEYS.provisioning.b64,
      PROVISIONING_ASSERTION_KID: KEYS.provisioning.kid,
      ACCOUNTING_ASSERTION_KEY: KEYS.accounting.b64,
      ACCOUNTING_ASSERTION_KID: KEYS.accounting.kid,
      INVENTORY_ASSERTION_KEY: KEYS.inventory.b64,
      INVENTORY_ASSERTION_KID: KEYS.inventory.kid,
      JWT_SECRET: 'browser-gate-local-jwt-secret-with-32-plus-chars',
      MEDIA_ROOT: join(logDir, 'media'),
      DEV_MAILBOX_FILE: join(logDir, 'mailbox.log'),
      CORS_ORIGINS: webUrl,
      // TD-19: the web server is this deployment's trusted proxy.
      TRUSTED_PROXIES: '127.0.0.1,::1',
      LOG_LEVEL: 'warn',
    };
    await assertNothingAnswers(apiUrl, 'the merchant API');
    const api = startProcess(process.execPath, ['dist/main.js'], join(ROOT, 'apps/api'), apiEnv, join(logDir, 'api.log'));
    children.push(api);
    await waitForHttp(`${apiUrl}/v1/health/ready`, api, 'the merchant API');

    const webEnv: NodeJS.ProcessEnv = {
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      NODE_ENV: 'production',
      PORT: String(ports.web),
      API_URL: apiUrl,
      NEXT_TELEMETRY_DISABLED: '1',
    };
    // The production entry, exactly as `npm start` runs it: Node's own type
    // stripping, no flags, no loader.
    await assertNothingAnswers(webUrl, 'the web server');
    const web = startProcess(process.execPath, ['server.mts'], join(ROOT, 'apps/web'), webEnv, join(logDir, 'web.log'));
    children.push(web);
    await waitForHttp(`${webUrl}/en/login`, web, 'the web server (node server.mts)');
    return { apiUrl, webUrl, migrations: applied.length, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
