#!/usr/bin/env tsx
/**
 * §XXI: "can credential key version X be retired?" — operational check.
 * Usage: MIGRATION_DATABASE_URL=... tsx scripts/check-key-retirement.ts <version>
 * Exit 0 (YES) only if NO non-terminal credential delivery references the
 * version. Never silently retire an in-use key.
 */
import { Pool } from 'pg';

const version = process.argv[2];
const url = process.env['WORKER_DATABASE_URL'];
if (!version || !url) {
  console.error('usage: WORKER_DATABASE_URL=... tsx scripts/check-key-retirement.ts <keyVersion>');
  process.exit(2);
}
const pool = new Pool({ connectionString: url, max: 1 });
try {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM credential_deliveries
     WHERE key_version = $1 AND secret_ciphertext IS NOT NULL`,
    [version],
  );
  const n = rows[0]?.n ?? 0;
  if (n > 0) {
    console.log(`NO — key version '${version}' is still referenced by ${n} non-terminal deliver${n === 1 ? 'y' : 'ies'}.`);
    process.exit(1);
  }
  console.log(`YES — key version '${version}' is not referenced by any non-terminal delivery.`);
  process.exit(0);
} finally {
  await pool.end();
}
