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
import { randomBytes } from 'node:crypto';
import { chmodSync, chownSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';

/** The one PostgreSQL installation whose server and client tools match. */
export const PG16_BIN = '/usr/lib/postgresql/16/bin';
export const PG_SUPERUSER = 'postgres';

// ── PART 103 — the superuser password is minted per run, never committed ───
//
// Both clusters this module creates are disposable and live only as long as
// the drill, so their superuser password has no reason to exist in the tree.
// Committing one as a literal would make it secret-shaped source material that
// a release scan must then be told to ignore, in a shared file this phase does
// not own. Minting it at module load removes the material rather than excusing
// it, and is not scanner evasion: the value never enters the tree at all.
//
// Module scope, so SOURCE and TARGET share one value within a run — the DR
// drill's globals restore carries the source roles' password hashes into the
// target, and V8 then authenticates `daftar_app` against them, which only
// agrees if both clusters were built from the same in-process secret. With
// `--keep`, the drill prints this value so the kept clusters stay reachable.
export const PG_SUPERPASS = `p15_super_${randomBytes(18).toString('base64url')}`;

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
export function startCluster(spec: ClusterSpec, extraSettings: readonly string[] = []): void {
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
  // `extraSettings` are appended LAST, so a caller can override a default
  // above it: PostgreSQL takes the final assignment of a setting in the file.
  // The PITR proof uses this to turn `fsync` back on, because a recovery claim
  // made on a cluster that was never durable proves nothing.
  writeFileSync(
    conf,
    `${readFileSync(conf, 'utf8')}\nport=${spec.port}\nlisten_addresses='127.0.0.1'\nfsync=off\nmax_connections=200\n${extraSettings.map((l) => `${l}\n`).join('')}`,
  );
  must(asServerUser(`${PG16_BIN}/pg_ctl -D ${data} -l ${join(spec.dir, 'server.log')} -w start`), `pg_ctl start (${spec.label})`);
}

/**
 * A directory the server account can write to — the WAL archive and the base
 * backup both need this, and `archive_command` failing on permissions looks
 * exactly like archiving being broken.
 */
export function prepareServerWritableDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o755);
  if (userInfo().username !== SERVER_OS_USER) {
    const uid = Number(must(run('id', ['-u', SERVER_OS_USER]), 'id -u postgres').trim());
    const gid = Number(must(run('id', ['-g', SERVER_OS_USER]), 'id -g postgres').trim());
    chownSync(dir, uid, gid);
  }
}

/**
 * `pg_basebackup -Fp -X stream` — a PHYSICAL backup, which is the thing a
 * logical dump is not. PITR replays archived WAL on top of one of these; a
 * `pg_dump` has no LSN to replay onto.
 */
export function baseBackup(port: number, outDir: string): void {
  prepareServerWritableDir(outDir);
  must(
    asServerUser(
      `PGPASSWORD='${PG_SUPERPASS}' ${PG16_BIN}/pg_basebackup -h 127.0.0.1 -p ${port} -U ${PG_SUPERUSER} -D ${outDir} -Fp -X stream -c fast --no-sync`,
    ),
    `pg_basebackup (:${port})`,
  );
}

/**
 * Lay a base backup down as a new data directory and arm it for recovery.
 *
 * `recovery.signal` + `restore_command` + a recovery target is the whole of
 * PITR's interface. `recovery_target_action='promote'` so the cluster comes up
 * read-write once it reaches the target, instead of pausing and leaving the
 * caller unable to tell "paused" from "finished".
 */
export function armRecovery(
  dataDir: string,
  backupDir: string,
  opts: { readonly restoreCommand: string; readonly targetTime?: string; readonly targetLsn?: string },
): void {
  rmSync(dataDir, { recursive: true, force: true });
  must(asServerUser(`cp -a ${backupDir} ${dataDir}`), `copy base backup to ${dataDir}`);
  must(asServerUser(`chmod 700 ${dataDir}`), `chmod 700 ${dataDir}`);
  const target = opts.targetTime !== undefined ? `recovery_target_time='${opts.targetTime}'` : `recovery_target_lsn='${opts.targetLsn ?? ''}'`;
  const conf = join(dataDir, 'postgresql.auto.conf');
  must(
    asServerUser(
      `cat >> ${conf} <<'P15EOF'
restore_command='${opts.restoreCommand}'
${target}
recovery_target_action='promote'
P15EOF`,
    ),
    'write recovery settings',
  );
  must(asServerUser(`touch ${join(dataDir, 'recovery.signal')}`), 'touch recovery.signal');
}

/** Start a cluster that is already laid down on disk (a recovery target). */
export function startExisting(dir: string, label: string): SpawnSyncReturns<string> {
  return asServerUser(`${PG16_BIN}/pg_ctl -D ${join(dir, 'data')} -l ${join(dir, 'server.log')} -w -t 120 start`);
}

/** The server log, for reading why a recovery refused. */
export function serverLog(dir: string): string {
  const f = join(dir, 'server.log');
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
}

/** `psql -c`, as the superuser, returning one scalar — used during recovery. */
export function psqlScalar(port: number, db: string, sql: string): { readonly ok: boolean; readonly value: string; readonly detail: string } {
  const r = run(`${PG16_BIN}/psql`, ['-h', '127.0.0.1', '-p', String(port), '-U', PG_SUPERUSER, '-d', db, '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    env: { PGPASSWORD: PG_SUPERPASS },
  });
  return { ok: r.status === 0, value: (r.stdout ?? '').trim(), detail: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim() };
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
