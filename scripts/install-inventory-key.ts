#!/usr/bin/env tsx
/**
 * Install (or rotate) the INVENTORY ASSERTION KEY in the database
 * (P3-AL-55 §C).
 *
 * The merchant API mints `invctl/1` inventory command assertions with
 * INVENTORY_ASSERTION_KEY; `inventory_assertion_consume()` verifies them with
 * the SAME key stored in `inventory_assertion_keys` — a table no runtime role
 * can read, this job's own principal included. The job runs under the
 * PLATFORM principal (BOOTSTRAP_DATABASE_URL, daftar_platform), which may
 * install and retire keys and may not read one back; migration credentials
 * are refused.
 *
 * This is deliberately NOT the provisioning or the accounting key job. The
 * three domains have separate registries and separate secrets so that one
 * compromise does not reach inventory authority, business provisioning and
 * the general ledger at once, and so that each can be rotated without the
 * others. The checks below refuse the most likely operational mistake:
 * pointing two of them at one secret. They compare DECODED bytes, because two
 * base64 spellings of one secret are one secret.
 *
 * Usage:
 *   BOOTSTRAP_DATABASE_URL=postgres://daftar_platform:...@db/daftar \
 *   INVENTORY_ASSERTION_KEY=<base64 ≥32 bytes> [INVENTORY_ASSERTION_KID=v2] \
 *   [PROVISIONING_ASSERTION_KEY=… ACCOUNTING_ASSERTION_KEY=…  (checked, never installed)] \
 *     tsx scripts/install-inventory-key.ts [--retire=<old kid>]
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
  const keyB64 = process.env['INVENTORY_ASSERTION_KEY'];
  if (!keyB64 || Buffer.from(keyB64, 'base64').length < 32) throw new Error('INVENTORY_ASSERTION_KEY must be base64 of at least 32 bytes');
  const secret = Buffer.from(keyB64, 'base64');
  const provisioning = process.env['PROVISIONING_ASSERTION_KEY'];
  if (provisioning && secret.equals(Buffer.from(provisioning, 'base64'))) {
    throw new Error('INVENTORY_ASSERTION_KEY must not be the same secret as PROVISIONING_ASSERTION_KEY (separate domains, rotated independently)');
  }
  const accounting = process.env['ACCOUNTING_ASSERTION_KEY'];
  if (accounting && secret.equals(Buffer.from(accounting, 'base64'))) {
    throw new Error('INVENTORY_ASSERTION_KEY must not be the same secret as ACCOUNTING_ASSERTION_KEY (separate domains, rotated independently)');
  }
  const kid = process.env['INVENTORY_ASSERTION_KID'] ?? 'v1';
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(kid)) throw new Error('INVENTORY_ASSERTION_KID must match ^[A-Za-z0-9_-]{1,32}$');
  const retire = process.argv.find((a) => a.startsWith('--retire='))?.slice('--retire='.length);

  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const who = (await pool.query<{ current_user: string }>('SELECT current_user')).rows[0]?.current_user;
    if (who !== 'daftar_platform') {
      throw new Error(`inventory key installation must run as the platform principal daftar_platform (connected as "${who ?? 'unknown'}")`);
    }
    await pool.query(`SELECT inventory_assertion_key_install($1, decode($2, 'base64'))`, [kid, keyB64]);
    process.stdout.write(`INVENTORY KEY: installed kid=${kid}\n`);
    if (retire) {
      if (retire === kid) throw new Error('refusing to retire the kid that was just installed');
      await pool.query('SELECT inventory_assertion_key_retire($1)', [retire]);
      process.stdout.write(`INVENTORY KEY: retired kid=${retire}\n`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(`INVENTORY KEY: FAIL — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
