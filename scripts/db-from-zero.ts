#!/usr/bin/env tsx
/**
 * DATABASE CONTRACT FROM ZERO (release gate step; Final Release Blockers 3/7).
 *
 * Starts a throw-away PostgreSQL (embedded, fresh data directory), then proves
 * the full bootstrap contract exactly as production does it:
 *   1. CREATE DATABASE                     (empty server, nothing prepared)
 *   2. bootstrap.sql                       (six runtime roles, CONNECT/USAGE only)
 *   3. migrations 0000 → latest            (advisory-locked, per-file transactions)
 *   4. migrations again                    (must be a no-op)
 *   5. history verification                (every applied file matches the frozen manifest hash;
 *                                          migrations past `frozenThrough` are candidates — still
 *                                          hash-verified against disk, frozen only at release)
 *   6. tamper proof                        (a foreign history row is detected)
 *   7. runtime roles can connect, hold no DDL, and cannot read the assertion key table
 * Prints a JSON summary line (DB_FROM_ZERO: {...}) the gate records as evidence.
 * Never touches the developer's shared instance or any configured database.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import { MIGRATIONS_DIR, runMigrations } from '../apps/api/src/infra/migrate';
import { ensureEmbeddedPgBinariesExecutable } from './ensure-embedded-pg-binaries';

const ROOT = join(__dirname, '..');
/** `--release`: every applied migration must already be frozen in the manifest. */
const RELEASE_MODE = process.argv.slice(2).includes('--release');
const PORT = Number(process.env['DB_FROM_ZERO_PORT'] ?? 55461);
const PASSWORDS = {
  __APP_DB_PASSWORD__: 'zero_app_pw_123456',
  __PLATFORM_DB_PASSWORD__: 'zero_platform_pw_123456',
  __WORKER_DB_PASSWORD__: 'zero_worker_pw_123456',
  __RESOLVER_DB_PASSWORD__: 'zero_resolver_pw_123456',
  __IDENTITY_DB_PASSWORD__: 'zero_identity_pw_123456',
  __PROVISIONER_DB_PASSWORD__: 'zero_provisioner_pw_123456',
  __MIGRATOR_DB_PASSWORD__: 'zero_migrator_pw_123456',
} as const;

async function main(): Promise<void> {
  // The embedded server creates and owns its data directory (initdb refuses a root-owned one).
  const dir = join(tmpdir(), `daftar-db-from-zero-${randomUUID()}`);
  ensureEmbeddedPgBinariesExecutable();
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT, persistent: false });
  const summary: Record<string, unknown> = { port: PORT };
  const pools: Pool[] = [];
  const openPool = (connectionString: string, max: number): Pool => {
    const p = new Pool({ connectionString, max });
    p.on('error', () => undefined); // server shutdown at the end terminates idle clients; never an unhandled event
    pools.push(p);
    return p;
  };
  try {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('daftar');
    const owner = `postgresql://postgres:postgres@localhost:${PORT}/daftar`;

    // 2. roles
    let bootstrap = readFileSync(join(ROOT, 'infrastructure/database/bootstrap.sql'), 'utf8');
    for (const [k, v] of Object.entries(PASSWORDS)) bootstrap = bootstrap.replaceAll(k, v);
    const pool = openPool(owner, 2);
    await pool.query(bootstrap);
    summary['roles'] = (await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_roles WHERE rolname LIKE 'daftar_%'`)).rows[0]?.n;

    // 3–4. migrate, then no-op
    const applied = await runMigrations(owner);
    const again = await runMigrations(owner);
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    if (applied.length !== files.length) throw new Error(`fresh migrate applied ${applied.length} files, expected ${files.length}`);
    if (again.length !== 0) throw new Error(`second migrate applied ${again.length} files, expected a no-op`);
    summary['migrationsApplied'] = applied.length;
    summary['latestMigration'] = files[files.length - 1];
    summary['rerunApplied'] = again.length;

    // 5. history verification against the frozen manifest
    const manifest = JSON.parse(readFileSync(join(ROOT, 'infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8')) as {
      frozenThrough: string;
      migrations: { name: string; sha256: string }[];
    };
    const history = (await pool.query<{ name: string; sha256: string }>('SELECT name, sha256 FROM schema_migrations ORDER BY name')).rows;
    const byName = new Map(history.map((r) => [r.name, r.sha256] as const));
    for (const m of manifest.migrations) {
      const onDisk = createHash('sha256')
        .update(readFileSync(join(MIGRATIONS_DIR, m.name)))
        .digest('hex');
      if (onDisk !== m.sha256) throw new Error(`frozen migration ${m.name} differs from the manifest`);
      if (byName.get(m.name) !== m.sha256) throw new Error(`history for ${m.name} does not match the manifest`);
    }
    // Migrations newer than `frozenThrough` are CANDIDATES: the manifest's own
    // policy allows them mid-phase ("New migrations ... are appended to the
    // manifest only at release time") and a slice directive may forbid freezing
    // them before its acceptance review. History integrity is still proven for
    // them — applied exactly once, and the applied hash equals the file on disk
    // — only the freeze requirement is deferred. `--release` restores the hard
    // rule, and the Phase 1 release gate passes it, so a RELEASE still cannot
    // ship an unfrozen migration.
    const candidates = files.filter((f) => f > manifest.frozenThrough);
    for (const f of candidates) {
      if (RELEASE_MODE) throw new Error(`migration ${f} is newer than frozenThrough=${manifest.frozenThrough} — freeze it in the manifest before release`);
      const onDisk = createHash('sha256')
        .update(readFileSync(join(MIGRATIONS_DIR, f)))
        .digest('hex');
      if (!byName.has(f)) throw new Error(`candidate migration ${f} was never applied`);
      if (byName.get(f) !== onDisk) throw new Error(`candidate migration ${f} history hash does not match the file on disk`);
    }
    summary['candidateMigrations'] = candidates;
    summary['manifestFrozenThrough'] = manifest.frozenThrough;
    summary['manifestVerified'] = manifest.migrations.length;

    // 6. tamper proof — the same verifier CI runs (scripts/verify-migration-history.ts)
    //    must REJECT a history row that names a migration the repository does not have.
    const verify = (): number =>
      spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts/verify-migration-history.ts')], {
        cwd: ROOT,
        env: { ...process.env, DATABASE_URL: owner },
        encoding: 'utf8',
      }).status ?? -1;
    if (verify() !== 0) throw new Error('history verification failed on a clean fresh database');
    await pool.query(`INSERT INTO schema_migrations (name, sha256) VALUES ('9999_foreign_tamper.sql', 'deadbeef')`);
    const tamperExit = verify();
    if (tamperExit === 0) throw new Error('history verification ACCEPTED a tampered/foreign history row — gate broken');
    await pool.query(`DELETE FROM schema_migrations WHERE name = '9999_foreign_tamper.sql'`);
    if (verify() !== 0) throw new Error('history verification failed after removing the tamper fixture');
    summary['historyVerifiedClean'] = true;
    summary['tamperRejectedExitCode'] = tamperExit;

    // 7. runtime role contract
    const app = openPool(`postgresql://daftar_app:${PASSWORDS.__APP_DB_PASSWORD__}@localhost:${PORT}/daftar`, 1);
    const who = (await app.query<{ u: string }>('SELECT current_user AS u')).rows[0]?.u;
    if (who !== 'daftar_app') throw new Error('daftar_app cannot connect');
    const ddl = await app.query('CREATE TABLE zero_probe (id int)').then(
      () => 'allowed',
      () => 'denied',
    );
    const keys = await app.query('SELECT * FROM provisioning_assertion_keys').then(
      () => 'allowed',
      () => 'denied',
    );
    const registry = await app
      .query(
        `INSERT INTO catalog_identifiers (business_id, kind, value_norm, owner_type, owner_id) VALUES (gen_random_uuid(),'sku','x','product',gen_random_uuid())`,
      )
      .then(
        () => 'allowed',
        () => 'denied',
      );
    if (ddl !== 'denied' || keys !== 'denied' || registry !== 'denied')
      throw new Error(`runtime role contract broken: ddl=${ddl} keys=${keys} registry=${registry}`);
    summary['appRole'] = { ddl, assertionKeys: keys, registryWrite: registry };

    process.stdout.write(`DB_FROM_ZERO: ${JSON.stringify(summary)}\n`);
    process.stdout.write(
      `DB FROM ZERO: PASS (${applied.length} migrations, roles ${String(summary['roles'])}, no-op rerun, manifest + history verified, tamper rejected)\n`,
    );
  } finally {
    for (const p of pools) await p.end().catch(() => undefined);
    await pg.stop().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e: unknown) => {
  console.error(`DB FROM ZERO: FAIL — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
