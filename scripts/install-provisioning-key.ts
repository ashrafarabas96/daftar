#!/usr/bin/env tsx
/**
 * Install (or rotate) the PROVISIONING ASSERTION KEY in the database
 * (Final Release Blocker 1, migration 0038).
 *
 * The merchant API mints provisioning assertions with PROVISIONING_ASSERTION_KEY;
 * provision_actor() verifies them with the SAME key stored in
 * provisioning_assertion_keys — a table no runtime role can read. This job
 * runs under the PLATFORM principal (BOOTSTRAP_DATABASE_URL, daftar_platform),
 * exactly like the platform-owner bootstrap; migration credentials are refused.
 *
 * Usage:
 *   BOOTSTRAP_DATABASE_URL=postgres://daftar_platform:...@db/daftar \
 *   PROVISIONING_ASSERTION_KEY=<base64 ≥32 bytes> [PROVISIONING_ASSERTION_KID=v2] \
 *     tsx scripts/install-provisioning-key.ts [--retire=<old kid>]
 *
 * Rotation: install the new kid on the database FIRST, deploy the API with the
 * new key/kid, then retire the old kid. The key is never printed.
 */
import { Pool } from 'pg';

async function main(): Promise<void> {
  if (process.env['MIGRATION_DATABASE_URL'] && !process.env['BOOTSTRAP_DATABASE_URL']) {
    throw new Error('MIGRATION_DATABASE_URL is not a bootstrap credential — set BOOTSTRAP_DATABASE_URL to the daftar_platform connection');
  }
  const url = process.env['BOOTSTRAP_DATABASE_URL'];
  if (!url) throw new Error('BOOTSTRAP_DATABASE_URL is required (daftar_platform principal)');
  const keyB64 = process.env['PROVISIONING_ASSERTION_KEY'];
  if (!keyB64 || Buffer.from(keyB64, 'base64').length < 32) throw new Error('PROVISIONING_ASSERTION_KEY must be base64 of at least 32 bytes');
  const kid = process.env['PROVISIONING_ASSERTION_KID'] ?? 'v1';
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(kid)) throw new Error('PROVISIONING_ASSERTION_KID must match ^[A-Za-z0-9_-]{1,32}$');
  const retire = process.argv.find((a) => a.startsWith('--retire='))?.slice('--retire='.length);

  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const who = (await pool.query<{ current_user: string }>('SELECT current_user')).rows[0]?.current_user;
    if (who !== 'daftar_platform') throw new Error(`key installation must run as the platform principal daftar_platform (connected as "${who ?? 'unknown'}")`);
    await pool.query(`SELECT provision_assertion_key_install($1, decode($2, 'base64'))`, [kid, keyB64]);
    process.stdout.write(`PROVISIONING KEY: installed kid=${kid}\n`);
    if (retire) {
      if (retire === kid) throw new Error('refusing to retire the kid that was just installed');
      await pool.query('SELECT provision_assertion_key_retire($1)', [retire]);
      process.stdout.write(`PROVISIONING KEY: retired kid=${retire}\n`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(`PROVISIONING KEY: FAIL — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
