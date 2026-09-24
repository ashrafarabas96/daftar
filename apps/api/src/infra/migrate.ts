#!/usr/bin/env tsx
/**
 * Migration runner (§35): raw SQL migrations, checksum-verified, advisory-locked,
 * each file applied in its own transaction. No auto-sync, no schema push.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, type PoolClient } from 'pg';

export const MIGRATIONS_DIR = join(__dirname, '../../../../infrastructure/database/migrations');
const ADVISORY_LOCK = 727272;

/**
 * ── The ownership handover, and the privilege PostgreSQL demands for it ────
 *
 * A migration that ends with `ALTER FUNCTION f OWNER TO r` is telling
 * PostgreSQL to move an object into another role's name. PostgreSQL allows
 * that only when the caller can `SET ROLE` to r AND r holds CREATE on the
 * object's schema — r has to be allowed to own something there.
 *
 * The first half is a bootstrap concern: `daftar_migrator` is a member of
 * each handover target, INHERIT FALSE / SET TRUE. The second half is this
 * function's concern, and it is the reason a deployment as the real
 * production authority failed where CI did not: CI applies migrations as a
 * superuser, for whom neither check is performed.
 *
 * The accounting migrations from 0040 onward solve it inside themselves —
 * `GRANT CREATE ON SCHEMA public TO daftar_accounting_internal` at the top,
 * `REVOKE` at the bottom, one transaction, so the privilege never exists in
 * any committed state. The Phase 1 provisioning migrations 0032, 0033 and
 * 0038 do not, because nothing ever applied them as a non-superuser. They
 * are frozen, so the same shape is applied from OUTSIDE the file, by the
 * deployment tool, with the same property: the grant and the revoke are
 * issued inside the migration's own transaction, so no other session ever
 * observes the privilege, and a failed migration rolls it back with
 * everything else.
 *
 * The targets are read from the file about to be applied rather than named
 * here, so a later authorized migration that hands ownership to a role this
 * code has never heard of deploys correctly. `npm run check:deployment-authority`
 * re-derives the whole set from the frozen history and fails if bootstrap
 * does not carry a membership for each one — a missing membership is then a
 * red gate rather than a production deployment that dies halfway.
 */
const OWNER_TO = /\bOWNER\s+TO\s+(daftar_[a-z_]+)/gi;

/** Every role the given migration hands object ownership to, comments stripped. */
export function ownershipTargets(sql: string): string[] {
  const code = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  return [...new Set([...code.matchAll(OWNER_TO)].map((m) => m[1]).filter((r): r is string => typeof r === 'string'))].sort();
}

/**
 * Lend CREATE on `public` to each handover target for the length of this
 * transaction. Identifiers come from `ownershipTargets`, which accepts only
 * `daftar_[a-z_]+` — there is no caller string on this path — and each name
 * is quoted anyway.
 */
async function lendSchemaCreate(client: PoolClient, targets: string[], direction: 'GRANT' | 'REVOKE'): Promise<void> {
  for (const role of targets) {
    const quoted = `"${role.replace(/"/g, '""')}"`;
    await client.query(direction === 'GRANT' ? `GRANT CREATE ON SCHEMA public TO ${quoted}` : `REVOKE CREATE ON SCHEMA public FROM ${quoted}`);
  }
}

export async function runMigrations(databaseUrl: string, dir = MIGRATIONS_DIR): Promise<string[]> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  // An idle pooled client whose backend goes away emits on the POOL, and a
  // pool with no `error` listener turns that into an uncaught exception that
  // takes the whole process with it. Every migration here is applied through
  // an AWAITED query, so a real failure still rejects and still aborts the
  // run; this listener only covers the connection being cut while nothing is
  // in flight — an administrator dropping the database, a managed provider
  // recycling the backend — which is not a migration failure and must not be
  // reported as a crash.
  pool.on('error', () => undefined);
  const applied: string[] = [];
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK]);
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      const files = readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .sort();
      const existing = new Map(
        (await client.query<{ name: string; sha256: string }>('SELECT name, sha256 FROM schema_migrations')).rows.map((r) => [r.name, r.sha256] as const),
      );
      for (const file of files) {
        const sql = readFileSync(join(dir, file), 'utf8');
        const sha = createHash('sha256').update(sql).digest('hex');
        const prev = existing.get(file);
        if (prev) {
          if (prev !== sha) throw new Error(`Migration tampered after apply: ${file} (checksum mismatch)`);
          continue; // no-op reapply is safe by checksum, not by re-running SQL
        }
        const targets = ownershipTargets(sql);
        await client.query('BEGIN');
        try {
          await lendSchemaCreate(client, targets, 'GRANT');
          await client.query(sql);
          // Taken back inside the same transaction the file ran in, so the
          // committed state never carries it. A file that revoked it itself
          // (0040 onward) makes this a no-op, which is the intended overlap.
          await lendSchemaCreate(client, targets, 'REVOKE');
          await client.query('INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)', [file, sha]);
          await client.query('COMMIT');
          applied.push(file);
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        }
      }
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK]).catch(() => undefined);
    } finally {
      client.release();
    }
    return applied;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/* istanbul ignore next -- CLI entry */
if (require.main === module) {
  // Security Gate Zero (§8): MIGRATION_DATABASE_URL exists ONLY inside this
  // migration command. The API runtime config never loads it.
  const migrationUrl = process.env['MIGRATION_DATABASE_URL'];
  if (!migrationUrl) {
    console.error('MIGRATION_DATABASE_URL is required (migration command only; the API runtime never reads it)');
    process.exit(1);
  }
  runMigrations(migrationUrl)
    .then((applied) => {
      console.log(`migrations applied: ${applied.length > 0 ? applied.join(', ') : 'none (up to date)'}`);
      process.exit(0);
    })
    .catch((e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
