/**
 * THE EMBEDDED POSTGRESQL CLUSTER, ON ITS OWN.
 *
 * Starting (or reusing) the real PostgreSQL the suites run against has
 * nothing to do with composing a Nest application, and keeping the two in one
 * file meant that anything wanting a database — an evidence script, a
 * measurement harness — had to import the whole framework to get one. This
 * module is deliberately framework-free: `node:fs`, `pg` and the embedded
 * distribution, and nothing else. `tests/helpers/test-app.ts` re-exports what
 * it always exported, so no suite changes.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import { ensureEmbeddedPgBinariesExecutable } from '../../scripts/ensure-embedded-pg-binaries';

export const PG_DIR = process.env['PG_DIR'] ?? '/tmp/daftar-pg-shared';
export const PG_PORT = Number(process.env['PG_PORT'] ?? 55432);
export const PG_USER = 'postgres';
export const PG_PASSWORD = 'postgres';

/** The fixture credentials of a throwaway local cluster. Never a deployment's. */
export const APP_DB_PASSWORD = 'test_app_password_123';
export const PLATFORM_DB_PASSWORD = 'test_platform_password_123';
export const WORKER_DB_PASSWORD = 'test_worker_password_123';
export const RESOLVER_DB_PASSWORD = 'test_resolver_password_123';
export const IDENTITY_DB_PASSWORD = 'test_identity_password_123';
export const PROVISIONER_DB_PASSWORD = 'test_provisioner_password_123';
export const RECONCILER_DB_PASSWORD = 'test_reconciler_password_123';
/** Deployment, not runtime: the schema-migration principal (P2-S1 portability). */
export const MIGRATOR_DB_PASSWORD = 'test_migrator_password_123';

/** The cluster's own maintenance database, which always exists. */
export const adminUrl = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/postgres`;

const START_ATTEMPTS = 12;
const SETTLE_DELAY_MS = 500;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let pg: EmbeddedPostgres | null = null;

export async function ping(): Promise<boolean> {
  const pool = new Pool({ connectionString: adminUrl, max: 1, connectionTimeoutMillis: 1500 });
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/**
 * Is the shared data directory actually held by a live postmaster?
 *
 * The file's presence alone is not the answer. `postmaster.pid` survives a
 * crash, a `kill -9` and — as happened here — a container restart, and a
 * directory guarded by a dead process's leftovers is not busy, it is littered.
 * The old check read the file's existence, so one abnormal exit made every
 * later run wait out its twelve attempts and then fail with "did not become
 * usable within 6s", forever, until somebody deleted the file by hand. A test
 * harness that cannot recover from a crash cannot report anything, and §3 of
 * the P2-S8 directive makes the harness part of the gate.
 *
 * So: read the postmaster's pid and ask the operating system whether it is
 * still there. Signal 0 checks existence and delivers nothing. `ESRCH` means
 * the process is gone and the file is stale. `EPERM` means it exists but
 * belongs to someone else, which is still held. An unreadable or malformed
 * file is treated as stale, because it cannot name a holder.
 */
export function pidFileHeld(dir: string = PG_DIR): boolean {
  const file = join(dir, 'postmaster.pid');
  if (!existsSync(file)) return false;

  let pid = Number.NaN;
  try {
    pid = Number.parseInt((readFileSync(file, 'utf8').split('\n')[0] ?? '').trim(), 10);
  } catch {
    return false; // unreadable: it names no holder
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return true; // alive, not ours
    // ESRCH — the postmaster is gone. Clear its leftovers so a fresh start can
    // take the directory, which is the whole point of the check.
    rmSync(file, { force: true });
    return false;
  }
}

/**
 * Start (or reuse) a REAL PostgreSQL 18 instance.
 *
 * Consecutive suite runs share one data directory (PG_DIR). A previous run's
 * server may still be shutting down when the next one starts: its socket
 * already refuses connections while `postmaster.pid` is still held, so a naive
 * "ping, else start" would try to start a second postmaster in the same
 * directory and die with `lock file "postmaster.pid" already exists`. The
 * handshake below waits — bounded — for the directory to settle into one of
 * the two usable states (a server that answers, or no server at all) and
 * retries a start that loses that race.
 */
export async function startOrReuse(): Promise<void> {
  for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
    if (await ping()) return; // a usable server is already listening
    if (pidFileHeld()) {
      // Someone else owns the directory: either still starting or still stopping.
      await delay(SETTLE_DELAY_MS);
      continue;
    }
    ensureEmbeddedPgBinariesExecutable();
    pg = new EmbeddedPostgres({
      databaseDir: PG_DIR,
      user: PG_USER,
      password: PG_PASSWORD,
      port: PG_PORT,
      persistent: true,
    });
    if (!existsSync(join(PG_DIR, 'PG_VERSION'))) {
      await pg.initialise();
    }
    try {
      await pg.start();
      return;
    } catch (e) {
      pg = null;
      // Lost the race against a concurrent start: settle and re-evaluate.
      if (!/postmaster\.pid|already (exists|running)/i.test(e instanceof Error ? e.message : String(e))) throw e;
      await delay(SETTLE_DELAY_MS);
    }
  }
  throw new Error(`PostgreSQL at ${PG_DIR} (port ${PG_PORT}) did not become usable within ${(START_ATTEMPTS * SETTLE_DELAY_MS) / 1000}s`);
}

/**
 * Run the deployment's own `bootstrap.sql` against `db`.
 *
 * The same file a deployment administrator runs, with the fixture passwords
 * substituted for its placeholders. It creates the cluster-wide roles if they
 * are missing and grants each of them what it needs in the database it is run
 * against — so a database created for a measurement gets exactly the grants a
 * real one gets, from the same source, rather than from a list maintained by
 * hand beside it.
 */
export async function applyBootstrap(db = 'daftar'): Promise<void> {
  const text = (await readFile(join(__dirname, '../../infrastructure/database/bootstrap.sql'), 'utf8'))
    .replaceAll('__APP_DB_PASSWORD__', APP_DB_PASSWORD)
    .replaceAll('__PLATFORM_DB_PASSWORD__', PLATFORM_DB_PASSWORD)
    .replaceAll('__WORKER_DB_PASSWORD__', WORKER_DB_PASSWORD)
    .replaceAll('__RESOLVER_DB_PASSWORD__', RESOLVER_DB_PASSWORD)
    .replaceAll('__IDENTITY_DB_PASSWORD__', IDENTITY_DB_PASSWORD)
    .replaceAll('__PROVISIONER_DB_PASSWORD__', PROVISIONER_DB_PASSWORD)
    .replaceAll('__RECONCILER_DB_PASSWORD__', RECONCILER_DB_PASSWORD)
    .replaceAll('__MIGRATOR_DB_PASSWORD__', MIGRATOR_DB_PASSWORD);
  const pool = new Pool({ connectionString: `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${db}`, max: 1 });
  try {
    await pool.query(text);
  } finally {
    await pool.end();
  }
}

/** Create `name` if it is not already there. Idempotent by construction. */
export async function ensureDatabase(name: string): Promise<void> {
  try {
    await (pg?.createDatabase(name) ?? Promise.resolve());
  } catch {
    // already exists
  }
  if (pg) return;
  // Reused instance: this process does not own the handle, so ask the server.
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } catch {
    // already exists
  } finally {
    await admin.end().catch(() => undefined);
  }
}
