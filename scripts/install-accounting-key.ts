#!/usr/bin/env tsx
/**
 * Install (or rotate) the ACCOUNTING ASSERTION KEY in the database
 * (P2-S3, migration 0044).
 *
 * The merchant API mints accounting command assertions with
 * ACCOUNTING_ASSERTION_KEY; `accounting_actor()` verifies them with the SAME
 * key stored in `accounting_assertion_keys` — a table no runtime role can
 * read, this job's own principal included. The job runs under the PLATFORM
 * principal (BOOTSTRAP_DATABASE_URL, daftar_platform), which may install and
 * retire keys and may not read one back; migration credentials are refused.
 *
 * This is deliberately NOT the provisioning key job. The two domains have
 * separate registries and separate secrets so that one compromise does not
 * reach both business provisioning and the general ledger, and so that either
 * can be rotated without the other (§13, §19). The check below refuses the
 * single most likely operational mistake: pointing both at one secret.
 *
 * Usage:
 *   BOOTSTRAP_DATABASE_URL=postgres://daftar_platform:...@db/daftar \
 *   ACCOUNTING_ASSERTION_KEY=<base64 ≥32 bytes> [ACCOUNTING_ASSERTION_KID=v2] \
 *     tsx scripts/install-accounting-key.ts [--retire=<old kid>]
 *
 * Rotation: install the new kid on the database FIRST, deploy the merchant API
 * with the new key/kid, then retire the old kid. Retirement is terminal. The
 * key material is never printed, logged, or returned.
 */
import { Pool } from 'pg';

async function main(): Promise<void> {
  if (process.env['MIGRATION_DATABASE_URL'] && !process.env['BOOTSTRAP_DATABASE_URL']) {
    throw new Error('MIGRATION_DATABASE_URL is not a bootstrap credential — set BOOTSTRAP_DATABASE_URL to the daftar_platform connection');
  }
  const url = process.env['BOOTSTRAP_DATABASE_URL'];
  if (!url) throw new Error('BOOTSTRAP_DATABASE_URL is required (daftar_platform principal)');
  const keyB64 = process.env['ACCOUNTING_ASSERTION_KEY'];
  if (!keyB64 || Buffer.from(keyB64, 'base64').length < 32) throw new Error('ACCOUNTING_ASSERTION_KEY must be base64 of at least 32 bytes');
  const provisioning = process.env['PROVISIONING_ASSERTION_KEY'];
  if (provisioning && Buffer.from(keyB64, 'base64').equals(Buffer.from(provisioning, 'base64'))) {
    throw new Error('ACCOUNTING_ASSERTION_KEY must not be the same secret as PROVISIONING_ASSERTION_KEY (separate domains, rotated independently)');
  }
  const kid = process.env['ACCOUNTING_ASSERTION_KID'] ?? 'v1';
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(kid)) throw new Error('ACCOUNTING_ASSERTION_KID must match ^[A-Za-z0-9_-]{1,32}$');
  const retire = process.argv.find((a) => a.startsWith('--retire='))?.slice('--retire='.length);

  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const who = (await pool.query<{ current_user: string }>('SELECT current_user')).rows[0]?.current_user;
    if (who !== 'daftar_platform') {
      throw new Error(`accounting key installation must run as the platform principal daftar_platform (connected as "${who ?? 'unknown'}")`);
    }
    await pool.query(`SELECT accounting_assertion_key_install($1, decode($2, 'base64'))`, [kid, keyB64]);
    process.stdout.write(`ACCOUNTING KEY: installed kid=${kid}\n`);
    if (retire) {
      if (retire === kid) throw new Error('refusing to retire the kid that was just installed');
      await pool.query('SELECT accounting_assertion_key_retire($1)', [retire]);
      process.stdout.write(`ACCOUNTING KEY: retired kid=${retire}\n`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(`ACCOUNTING KEY: FAIL — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
