#!/usr/bin/env tsx
/**
 * CI / fresh-environment DATABASE INITIALIZATION (Completion Directive §55–56).
 *
 * A fresh PostgreSQL must start from ZERO: this command creates the DAFTAR
 * runtime roles (infrastructure/database/bootstrap.sql) with passwords taken
 * from the environment, BEFORE the migrations run. There is no "manually
 * prepared database" assumption anywhere in the pipeline.
 *
 * Usage:
 *   MIGRATION_DATABASE_URL=postgres://postgres:postgres@localhost:5432/daftar \
 *   APP_DB_PASSWORD=... PLATFORM_DB_PASSWORD=... WORKER_DB_PASSWORD=... \
 *   RESOLVER_DB_PASSWORD=... IDENTITY_DB_PASSWORD=... PROVISIONER_DB_PASSWORD=... \
 *   RECONCILER_DB_PASSWORD=... \
 *   MIGRATOR_DB_PASSWORD=... \
 *     tsx scripts/bootstrap-db-roles.ts
 *
 * The bootstrap SQL is idempotent (CREATE ROLE if missing, else ALTER the
 * password) and grants CONNECT/USAGE only — every table privilege comes
 * from the migrations. Passwords are never printed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

const url = process.env['MIGRATION_DATABASE_URL'];
if (!url) {
  console.error('MIGRATION_DATABASE_URL is required (owner/migrator connection to the target database)');
  process.exit(2);
}
const PLACEHOLDERS = [
  ['__APP_DB_PASSWORD__', 'APP_DB_PASSWORD'],
  ['__PLATFORM_DB_PASSWORD__', 'PLATFORM_DB_PASSWORD'],
  ['__WORKER_DB_PASSWORD__', 'WORKER_DB_PASSWORD'],
  ['__RESOLVER_DB_PASSWORD__', 'RESOLVER_DB_PASSWORD'],
  ['__IDENTITY_DB_PASSWORD__', 'IDENTITY_DB_PASSWORD'],
  ['__PROVISIONER_DB_PASSWORD__', 'PROVISIONER_DB_PASSWORD'],
  // P2-S8: the reconciliation principal. Read-only, and deliberately not a
  // member of any other runtime role — see 0051_accounting_reconciler_read.sql.
  ['__RECONCILER_DB_PASSWORD__', 'RECONCILER_DB_PASSWORD'],
  // Deployment, not runtime: the migration principal's credential.
  ['__MIGRATOR_DB_PASSWORD__', 'MIGRATOR_DB_PASSWORD'],
] as const;

let sql = readFileSync(join(__dirname, '../infrastructure/database/bootstrap.sql'), 'utf8');
for (const [placeholder, envName] of PLACEHOLDERS) {
  const value = process.env[envName];
  if (!value || value.length < 8) {
    console.error(`${envName} is required (min 8 chars) — no default passwords exist`);
    process.exit(2);
  }
  if (/['\\]/.test(value)) {
    console.error(`${envName} must not contain quotes or backslashes`);
    process.exit(2);
  }
  sql = sql.replaceAll(placeholder, value);
}
// The GRANT CONNECT line names the database literally as "daftar"; target the actual database.
const dbName = new URL(url).pathname.replace(/^\//, '');
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(dbName)) {
  console.error('target database name must be a plain identifier');
  process.exit(2);
}
sql = sql.replaceAll('GRANT CONNECT ON DATABASE daftar TO', `GRANT CONNECT ON DATABASE ${dbName} TO`);

const pool = new Pool({ connectionString: url, max: 1 });
pool
  .query(sql)
  .then(() => {
    console.log(`DB ROLES BOOTSTRAP: OK (${PLACEHOLDERS.length} roles ensured on ${dbName})`);
    return pool.end();
  })
  .catch((e: unknown) => {
    console.error(`DB ROLES BOOTSTRAP: FAIL — ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
