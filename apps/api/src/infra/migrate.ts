#!/usr/bin/env tsx
/**
 * Migration runner (§35): raw SQL migrations, checksum-verified, advisory-locked,
 * each file applied in its own transaction. No auto-sync, no schema push.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

export const MIGRATIONS_DIR = join(__dirname, '../../../../infrastructure/database/migrations');
const ADVISORY_LOCK = 727272;

export async function runMigrations(databaseUrl: string, dir = MIGRATIONS_DIR): Promise<string[]> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const applied: string[] = [];
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK]);
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
      const existing = new Map(
        (await client.query<{ name: string; sha256: string }>('SELECT name, sha256 FROM schema_migrations')).rows.map(
          (r) => [r.name, r.sha256] as const,
        ),
      );
      for (const file of files) {
        const sql = readFileSync(join(dir, file), 'utf8');
        const sha = createHash('sha256').update(sql).digest('hex');
        const prev = existing.get(file);
        if (prev) {
          if (prev !== sha) throw new Error(`Migration tampered after apply: ${file} (checksum mismatch)`);
          continue; // no-op reapply is safe by checksum, not by re-running SQL
        }
        await client.query('BEGIN');
        try {
          await client.query(sql);
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
