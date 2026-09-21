#!/usr/bin/env tsx
/**
 * Migration history preflight (Final Enforcement Directive §22–23).
 * Reads schema_migrations from the target database and compares names + SHA-256
 * against the on-disk migrations directory and MIGRATION_MANIFEST.json.
 *
 * HARD FAILS on:
 *  - a database migration unknown to the on-disk set (foreign/tampered history),
 *  - a hash mismatch for any migration frozen in the manifest,
 *  - an on-disk frozen migration that was never applied (gaps in frozen range),
 *  - manifest/on-disk divergence for frozen entries.
 *
 * Usage: DATABASE_URL=postgres://... tsx scripts/verify-migration-history.ts
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

const MIGRATIONS_DIR = join(__dirname, '../infrastructure/database/migrations');
const MANIFEST = join(__dirname, '../infrastructure/database/MIGRATION_MANIFEST.json');

const sha = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex');

const url = process.env['DATABASE_URL'] ?? process.env['MIGRATION_DATABASE_URL'];
if (!url) {
  console.error('usage: DATABASE_URL=postgres://... tsx scripts/verify-migration-history.ts');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
  migrations: { name: string; sha256: string }[];
};
const frozen = new Map(manifest.migrations.map((m) => [m.name, m.sha256]));

const onDisk = new Map<string, string>();
for (const f of readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()) {
  onDisk.set(f, sha(readFileSync(join(MIGRATIONS_DIR, f))));
}

// Manifest must match disk for every frozen entry.
let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.error(`  FAIL ${msg}`);
};
for (const [name, hash] of frozen) {
  const diskHash = onDisk.get(name);
  if (diskHash === undefined) fail(`frozen migration missing on disk: ${name}`);
  else if (diskHash !== hash) fail(`frozen migration bytes changed: ${name}`);
}

async function verifyDatabaseHistory(): Promise<void> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const { rows } = await pool.query<{ name: string }>(`SELECT name FROM schema_migrations ORDER BY name`);
    const applied = rows.map((r) => r.name);
    if (applied.length === 0) fail('schema_migrations is empty — database has no migration history');

    for (const name of applied) {
      if (!onDisk.has(name)) {
        fail(`database contains migration unknown to repository: ${name} (tampered/foreign history)`);
        continue;
      }
      const frozenHash = frozen.get(name);
      if (frozenHash !== undefined && onDisk.get(name) !== frozenHash) {
        fail(`applied frozen migration ${name} does not match manifest hash`);
      }
    }

    // Frozen migrations must form a contiguous applied prefix (no skipped frozen files).
    const sortedFrozen = [...frozen.keys()].sort();
    for (const name of sortedFrozen) {
      const num = Number(name.slice(0, 4));
      const anyAppliedHigher = applied.some((a) => Number(a.slice(0, 4)) >= num);
      if (!applied.includes(name) && anyAppliedHigher) {
        fail(`frozen migration ${name} not applied but a later migration is — history gap`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/schema_migrations/.test(msg)) {
      fail(`schema_migrations table missing or unreadable: ${msg}`);
    } else {
      throw err;
    }
  } finally {
    await pool.end();
  }
}

verifyDatabaseHistory()
  .then(() => {
    if (failures > 0) {
      console.error(`\nMIGRATION HISTORY VERIFY: FAIL (${failures} problem${failures === 1 ? '' : 's'})`);
      process.exit(1);
    }
    console.log('MIGRATION HISTORY VERIFY: PASS — database history matches repository and manifest.');
  })
  .catch((e: unknown) => {
    console.error(`MIGRATION HISTORY VERIFY: ERROR — ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
