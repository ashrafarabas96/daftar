/**
 * ─────────────────────────────────────────────────────────────────────────────
 * PHASE 15 — A REAL POSTGRESQL CLUSTER, AND THE REAL BACKUP TOOLS (Part 76)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * STATUS: PREPARED / NOT PROMOTED.
 *
 * WHY THIS IS NOT `tests/helpers/embedded-cluster.ts`
 *
 * The suites run against the embedded distribution, which in this tree is
 * PostgreSQL 18, and that distribution ships three executables — `initdb`,
 * `pg_ctl`, `postgres`. It ships NO `pg_dump`, `pg_dumpall`, `pg_restore` or
 * `psql` (measured: `ls node_modules/@embedded-postgres/linux-x64/native/bin`).
 * A backup/restore drill needs all four, and the ones installed on this host
 * are PostgreSQL 16, which `pg_dump` refuses to point at an 18 server. So the
 * drill brings up its OWN clusters from the SAME 16 installation the dump
 * tools come from: one server version, one client version, no mismatch, and
 * the restore target is a genuinely separate cluster with a separate data
 * directory and port — not another database on the source server.
 *
 * WHY `su postgres`
 *
 * `initdb` refuses to run as root, and this container is root. The data
 * directories therefore live under /tmp/daftar-p15-* owned by the `postgres`
 * OS account, and every server-side command runs as that account. The client
 * side (pg_dump, pg_restore, psql, the `pg` driver) connects over TCP and does
 * not care which account invoked it.
 *
 * WHAT THIS MODULE REFUSES TO DO
 *
 * It never touches `/tmp/daftar-pg-shared` or port 55432 — the shared cluster
 * other work in this repository owns. Every port and directory is passed in by
 * the caller. It is framework-free (`node:*` and `pg` only), so the drill can
 * run without compiling the application.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, chownSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';

/** The one PostgreSQL installation whose server and client tools match. */
export const PG16_BIN = '/usr/lib/postgresql/16/bin';
export const PG_SUPERUSER = 'postgres';
export const PG_SUPERPASS = 'postgres';

/** The OS account the server runs as (`initdb` refuses root). */
const SERVER_OS_USER = 'postgres';

export interface ClusterSpec {
  /** The base directory this cluster owns, created and destroyed by the caller's run. */
  readonly dir: string;
  readonly port: number;
  /** A label used in error messages: `source` / `target`. */
  readonly label: string;
}

export class ClusterError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
    this.name = 'ClusterError';
  }
}

function run(cmd: string, args: readonly string[], o: { readonly env?: NodeJS.ProcessEnv; readonly input?: string } = {}): SpawnSyncReturns<string> {
  return spawnSync(cmd, [...args], { encoding: 'utf8', env: { ...process.env, ...o.env }, input: o.input, maxBuffer: 64 * 1024 * 1024 });
}

/** `bash -c` as the server's OS account, or directly when already that account. */
function asServerUser(script: string): SpawnSyncReturns<string> {
  if (userInfo().username === SERVER_OS_USER) return run('/bin/bash', ['-c', script]);
  return run('su', [SERVER_OS_USER, '-s', '/bin/bash', '-c', script]);
}

function must(r: SpawnSyncReturns<string>, what: string): string {
  if (r.error) throw new ClusterError(`${what}: could not be executed`, String(r.error));
  if (r.status !== 0) throw new ClusterError(`${what}: exit ${r.status}`, `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim());
  return r.stdout ?? '';
}

/** The directory the server account must own, with the paths above it traversable. */
export function prepareClusterDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o755);
  if (userInfo().username !== SERVER_OS_USER) {
    const ids = run('id', ['-u', SERVER_OS_USER]);
    const gids = run('id', ['-g', SERVER_OS_USER]);
    chownSync(dir, Number(must(ids, 'id -u postgres').trim()), Number(must(gids, 'id -g postgres').trim()));
  }
}

/**
 * `initdb` a fresh cluster and start it on its own port.
 *
 * md5 authentication, not trust: the drill's restore step authenticates as the
 * runtime roles to prove their privileges survived, and `trust` would let any
 * password through and prove nothing.
 */
export function startCluster(spec: ClusterSpec): void {
  const data = join(spec.dir, 'data');
  const pwfile = join(spec.dir, 'superuser.pw');
  writeFileSync(pwfile, `${PG_SUPERPASS}\n`, { mode: 0o600 });
  if (userInfo().username !== SERVER_OS_USER) {
    const uid = Number(must(run('id', ['-u', SERVER_OS_USER]), 'id -u postgres').trim());
    const gid = Number(must(run('id', ['-g', SERVER_OS_USER]), 'id -g postgres').trim());
    chownSync(pwfile, uid, gid);
  }
  must(asServerUser(`${PG16_BIN}/initdb -D ${data} -U ${PG_SUPERUSER} --auth=md5 --pwfile=${pwfile} -E UTF8 --locale=C`), `initdb (${spec.label})`);
  // Written AFTER initdb so the generated file is not overwritten.
  const conf = join(data, 'postgresql.conf');
  writeFileSync(conf, `${readFileSync(conf, 'utf8')}\nport=${spec.port}\nlisten_addresses='127.0.0.1'\nfsync=off\nmax_connections=200\n`);
  must(asServerUser(`${PG16_BIN}/pg_ctl -D ${data} -l ${join(spec.dir, 'server.log')} -w start`), `pg_ctl start (${spec.label})`);
}

export function stopCluster(spec: ClusterSpec): void {
  const data = join(spec.dir, 'data');
  if (!existsSync(join(data, 'PG_VERSION'))) return;
  // Immediate, not fast: the drill's clusters are disposable and a stuck
  // shutdown would hold the port for the next run.
  asServerUser(`${PG16_BIN}/pg_ctl -D ${data} -m immediate -w stop`);
}

export const adminUrl = (port: number): string => `postgresql://${PG_SUPERUSER}:${PG_SUPERPASS}@127.0.0.1:${port}/postgres`;
export const dbUrl = (port: number, db = 'daftar'): string => `postgresql://${PG_SUPERUSER}:${PG_SUPERPASS}@127.0.0.1:${port}/${db}`;
export const roleUrl = (port: number, role: string, password: string, db = 'daftar'): string => `postgresql://${role}:${password}@127.0.0.1:${port}/${db}`;

/** `pg_dumpall --globals-only` — the roles a per-database dump does NOT carry. */
export function dumpGlobals(port: number, out: string): void {
  must(
    run(`${PG16_BIN}/pg_dumpall`, ['-h', '127.0.0.1', '-p', String(port), '-U', PG_SUPERUSER, '--globals-only', '-f', out], {
      env: { PGPASSWORD: PG_SUPERPASS },
    }),
    'pg_dumpall --globals-only',
  );
}

/** `pg_dump -Fc` — the custom-format dump of one database. */
export function dumpDatabase(port: number, db: string, out: string): void {
  must(
    run(`${PG16_BIN}/pg_dump`, ['-h', '127.0.0.1', '-p', String(port), '-U', PG_SUPERUSER, '-Fc', '-d', db, '-f', out], { env: { PGPASSWORD: PG_SUPERPASS } }),
    `pg_dump -Fc ${db}`,
  );
}

/**
 * Apply a globals dump to an empty cluster.
 *
 * A globals dump always re-declares the bootstrap superuser, which the fresh
 * cluster's own `initdb` already created. That one collision is expected and is
 * the ONLY stderr this accepts: anything else fails the restore, because
 * "errors were ignored" is not a restore proof. The roles are then asserted to
 * exist positively by the caller rather than inferred from a quiet run.
 */
export function restoreGlobals(port: number, file: string): { readonly tolerated: readonly string[] } {
  const r = run(`${PG16_BIN}/psql`, ['-h', '127.0.0.1', '-p', String(port), '-U', PG_SUPERUSER, '-d', 'postgres', '-v', 'ON_ERROR_STOP=0', '-f', file], {
    env: { PGPASSWORD: PG_SUPERPASS },
  });
  if (r.error) throw new ClusterError('psql (globals): could not be executed', String(r.error));
  const lines = (r.stderr ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const tolerated: string[] = [];
  const fatal: string[] = [];
  for (const l of lines) {
    if (/role "postgres" already exists/i.test(l)) tolerated.push(l);
    else if (/^ERROR|^psql:.*ERROR|^FATAL/i.test(l)) fatal.push(l);
  }
  if (fatal.length > 0) throw new ClusterError('globals restore reported errors other than the pre-existing bootstrap superuser', fatal.join('\n'));
  return { tolerated };
}

/** `CREATE DATABASE` on the target, from `template0` so nothing is inherited. */
export function createEmptyDatabase(port: number, db: string): void {
  must(
    run(
      `${PG16_BIN}/psql`,
      [
        '-h',
        '127.0.0.1',
        '-p',
        String(port),
        '-U',
        PG_SUPERUSER,
        '-d',
        'postgres',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `CREATE DATABASE ${db} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`,
      ],
      {
        env: { PGPASSWORD: PG_SUPERPASS },
      },
    ),
    `CREATE DATABASE ${db}`,
  );
}

export function dropDatabase(port: number, db: string): void {
  must(
    run(
      `${PG16_BIN}/psql`,
      [
        '-h',
        '127.0.0.1',
        '-p',
        String(port),
        '-U',
        PG_SUPERUSER,
        '-d',
        'postgres',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`,
      ],
      {
        env: { PGPASSWORD: PG_SUPERPASS },
      },
    ),
    `DROP DATABASE ${db}`,
  );
}

/**
 * `pg_restore --exit-on-error` — no error is tolerated.
 *
 * `pg_restore` without this flag reports a non-zero exit at the END and
 * restores whatever it could, which is how a half-restored database gets
 * called recovered. `--exit-on-error` stops at the first failure, and
 * `--single-transaction` makes the whole restore atomic, so the target is
 * either the backup or still empty — never a partial ledger.
 */
export function restoreDatabase(port: number, db: string, file: string): void {
  must(
    run(`${PG16_BIN}/pg_restore`, ['-h', '127.0.0.1', '-p', String(port), '-U', PG_SUPERUSER, '-d', db, '--exit-on-error', '--single-transaction', file], {
      env: { PGPASSWORD: PG_SUPERPASS },
    }),
    `pg_restore ${db}`,
  );
}

/** The version string of the tools, recorded in the run identity. */
export function toolVersions(): Readonly<Record<string, string>> {
  const v = (bin: string): string => (run(`${PG16_BIN}/${bin}`, ['--version']).stdout ?? '').trim();
  return { initdb: v('initdb'), pg_dump: v('pg_dump'), pg_dumpall: v('pg_dumpall'), pg_restore: v('pg_restore'), psql: v('psql') };
}
