/**
 * P3-S5 T-17 — THE UPGRADE MATRIX (docs/PHASE_3_S5_CONTRACT.md A-05, §2.1,
 * §2.8, §6 T-17).
 *
 * A database frozen at the P3-S4 checkpoint (0064) holding a live business —
 * stock through the real S3 commands and two purchases received through the
 * real S4 routines, each with its entry — is migrated to 0065/0066 and:
 *
 * - exactly the S5 migrations apply, first 0065 then 0066;
 * - books, ledger, documents and catalogue rows are as they were, plus the
 *   one accounting source type 0065 is authorized to add
 *   (`src:supplier_return:8`);
 * - the registries are exactly S3 + S4 + S5 (§2.5): the two stock source
 *   types, the two operation kinds with their two mappings, and
 *   `post:supplier_return` — `purchase_reversal` is a stock source only;
 * - every S5 table and bridge is empty and arrived with row security enabled
 *   and forced; no internal principal keeps CREATE on `public`;
 * - the existing purchases then live under the new rules: one is returned in
 *   part, the other reversed, each through the real routine and entry, and
 *   every deferred guard holds (rolled back);
 * - a second run applies nothing.
 */
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../../apps/api/src/infra/migrate';
import {
  ACCOUNTING_ASSERTION_KEY_B64,
  ACCOUNTING_ASSERTION_KID,
  APP_DB_PASSWORD,
  IDENTITY_DB_PASSWORD,
  INVENTORY_ASSERTION_KEY_B64,
  INVENTORY_ASSERTION_KID,
  PG_PASSWORD,
  PG_PORT,
  PG_USER,
  PLATFORM_DB_PASSWORD,
  RESOLVER_DB_PASSWORD,
  WORKER_DB_PASSWORD,
  dbUrl,
  ensurePostgres,
} from '../helpers/test-app';
import { atCommit, expectAccepted, must, runCommand as runS3, seedS3Business, transferCommand } from '../helpers/inventory-commands';
import { stockUp } from '../helpers/inventory-posting';
import { createSupplier } from '../helpers/purchase-commands';
import {
  S5_BRIDGES,
  S5_OPERATION_KINDS,
  S5_OPERATION_MOVEMENT_KINDS,
  S5_SOURCE_TYPES,
  S5_TABLES,
  prepareReversal,
  receivedPurchase,
  returnGoods,
  runReversal,
  type ReceivedPurchase,
} from '../helpers/purchase-returns';
// P3-S6 (0067/0068)
import { S6_ACCOUNTING_SOURCE_TYPES, S6_OPERATION_KINDS } from '../helpers/stock-ledger';

const SCRATCH = 'daftar_upgrade_0064';
const scratchUrl = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${SCRATCH}`;
const FROZEN = '0064_purchase_commands.sql';
const S5_MIGRATIONS = ['0065_supplier_returns_reversals_sources.sql', '0066_supplier_return_reversal_commands.sql'];
// P3-S6 (0067/0068): the upgrade runs to the latest migration, so the two S6 files follow.
const S6_MIGRATIONS = ['0067_payment_methods_supplier_settlement_sources.sql', '0068_supplier_settlement_commands.sql'];

function bootstrapSql(): string {
  return readFileSync(join(__dirname, '../../infrastructure/database/bootstrap.sql'), 'utf8')
    .replaceAll('__APP_DB_PASSWORD__', APP_DB_PASSWORD)
    .replaceAll('__PLATFORM_DB_PASSWORD__', PLATFORM_DB_PASSWORD)
    .replaceAll('__WORKER_DB_PASSWORD__', WORKER_DB_PASSWORD)
    .replaceAll('__RESOLVER_DB_PASSWORD__', RESOLVER_DB_PASSWORD)
    .replaceAll('__IDENTITY_DB_PASSWORD__', IDENTITY_DB_PASSWORD);
}

function migrationsUpTo(upTo: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'daftar-mig-s5-'));
  for (const f of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    if (f <= upTo) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
  }
  return dir;
}

function migrationsAfter(after: string): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && f > after)
    .sort();
}

/**
 * The scratch database is dropped WITH (FORCE): an idle pooled connection is
 * then terminated by the server (57P01, admin_shutdown). That one error is
 * expected; any other idle-client error is recorded and fails the test.
 */
const unexpectedPoolErrors: Error[] = [];
function scratchPool(connectionString: string, max = 2): Pool {
  const pool = new Pool({ connectionString, max });
  pool.on('error', (e: Error & { code?: string }) => {
    if (e.code !== '57P01') unexpectedPoolErrors.push(e);
  });
  return pool;
}

const admin = scratchPool(dbUrl, 1);

afterAll(async () => {
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
  await admin.end();
  expect(unexpectedPoolErrors, 'no pooled connection failed but by the expected termination').toEqual([]);
});

describe('T-17 the P3-S5 upgrade matrix', () => {
  it('frozen 0064-checkpoint + a business with received purchases → 0065/0066, everything untouched, registries exactly S3 + S4 + S5, rerun no-op', async () => {
    await ensurePostgres();
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${SCRATCH}`);
    const pool = scratchPool(scratchUrl);
    try {
      await pool.query(bootstrapSql());
      const preDir = migrationsUpTo(FROZEN);
      await runMigrations(scratchUrl, preDir);
      rmSync(preDir, { recursive: true, force: true });
      await pool.query(`SELECT inventory_assertion_key_install($1, decode($2, 'base64'))`, [INVENTORY_ASSERTION_KID, INVENTORY_ASSERTION_KEY_B64]);
      await pool.query(`SELECT accounting_assertion_key_install($1, decode($2, 'base64'))`, [ACCOUNTING_ASSERTION_KID, ACCOUNTING_ASSERTION_KEY_B64]);

      // The checkpoint is honest: the S4 documents are there, the S5 ones are not.
      for (const t of [...S5_TABLES, ...S5_BRIDGES]) {
        expect((await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = $1`, [t])).rows, t).toEqual([]);
      }
      for (const f of ['purchase_ap_outstanding', 'purchase_settlement_state', 'purchase_return', 'purchase_reverse']) {
        expect((await pool.query(`SELECT 1 FROM pg_proc WHERE proname = $1`, [f])).rows, f).toEqual([]);
      }

      // A live business of the checkpoint: S3 stock and a transfer, then two S4 receipts, each with its entry.
      const tenantId = must((await pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0]).id;
      const userId = must(
        (
          await pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'Upgrade owner') RETURNING id`, [
            `s5-upgrade-${randomUUID().slice(0, 8)}@test.daftar.local`,
          ])
        ).rows[0],
      ).id;
      const biz = await seedS3Business(pool, tenantId, userId, 's5up');
      let toReturn: ReceivedPurchase;
      let toReverse: ReceivedPurchase;
      const seed = await pool.connect();
      try {
        await seed.query('BEGIN');
        await stockUp(seed, biz, biz.w1, [{ variantId: biz.piece.variantId, qty: '5', unitCost: '10' }]);
        await runS3(seed, biz, transferCommand(biz.w1, biz.w2, [{ variantId: biz.piece.variantId, qty: '1' }]));
        const supplierId = await createSupplier(seed, biz, { name: 'Checkpoint supplier' });
        toReturn = await receivedPurchase(seed, biz, [{ variantId: biz.piece.variantId, qty: '3', unitPriceMinor: '1200' }], { supplierId });
        toReverse = await receivedPurchase(seed, biz, [{ variantId: biz.piece2.variantId, qty: '2', unitPriceMinor: '500' }], { supplierId });
        await seed.query('COMMIT');
      } catch (e) {
        await seed.query('ROLLBACK');
        throw e;
      } finally {
        seed.release();
      }

      const registries = async (): Promise<string[]> =>
        (
          await pool.query<{ r: string }>(
            `SELECT 'type:' || source_type || ':' || registered_by AS r FROM stock_source_types
             UNION ALL SELECT 'map:' || op_code || ':' || movement_kind || ':' || registered_by FROM inventory_operation_movement_kinds
             UNION ALL SELECT 'op:' || op_code || ':' || registered_by FROM inventory_operation_kinds
             UNION ALL SELECT 'acct:' || operation_kind || ':' || source_type FROM accounting_operation_kinds`,
          )
        ).rows
          .map((x) => x.r)
          .sort();
      const protectedRows = async (): Promise<string[]> =>
        (
          await pool.query<{ t: string }>(
            `SELECT concat_ws(':', 'acc', id, business_id, code, type, system_key, is_active) AS t FROM accounts
             UNION ALL SELECT concat_ws(':', 'je', id, business_id, entry_date, source_type, source_id) FROM journal_entries
             UNION ALL SELECT concat_ws(':', 'jl', id, journal_entry_id, account_id, debit_minor, credit_minor, txn_amount_minor, txn_currency, fx_rate, warehouse_id, branch_id) FROM journal_lines
             UNION ALL SELECT concat_ws(':', 'bind', business_id, source_type, source_id, journal_entry_id) FROM accounting_source_bindings
             UNION ALL SELECT concat_ws(':', 'src', source_type, sort_order) FROM accounting_source_types
             UNION ALL SELECT concat_ws(':', 'biz', id, tenant_id, base_currency, timezone, financial_started_at) FROM businesses
             UNION ALL SELECT concat_ws(':', 'wh', business_id, id, branch_id, name, is_default, status) FROM warehouses
             UNION ALL SELECT concat_ws(':', 'p', business_id, id, sku, status, track_inventory, unit_code, unit_decimals) FROM products
             UNION ALL SELECT concat_ws(':', 'v', business_id, id, product_id, sku, status, is_base) FROM product_variants
             UNION ALL SELECT concat_ws(':', 'mv', business_id, id, warehouse_id, variant_id, stock_seq, movement_kind, source_type, source_id, qty_delta, unit_cost_base_minor, value_delta_base_minor) FROM stock_movements
             UNION ALL SELECT concat_ws(':', 'lvl', business_id, warehouse_id, variant_id, on_hand, valuation_base_minor, avg_unit_cost_base_minor, last_stock_seq) FROM stock_levels
             UNION ALL SELECT concat_ws(':', 'sb', business_id, source_type, source_id, source_line_id, movement_kind) FROM stock_source_bindings
             UNION ALL SELECT concat_ws(':', 'sup', business_id, id, name, status, revision) FROM suppliers
             UNION ALL SELECT concat_ws(':', 'pur', business_id, id, supplier_id, warehouse_id, status, revision, currency_code, total_txn_minor, total_base_minor, source_to_base_rate, receive_intent_sha256) FROM purchases
             UNION ALL SELECT concat_ws(':', 'pl', business_id, purchase_id, id, line_no, variant_id, qty, net_txn_minor, landed_cost_txn_minor, base_share_minor, unit_cost_base_minor) FROM purchase_lines
             UNION ALL SELECT concat_ws(':', 'use', jti, op_code) FROM inventory_assertion_uses
             UNION ALL SELECT concat_ws(':', 'audit', id, action) FROM audit_events
             UNION ALL SELECT concat_ws(':', 'out', id, type) FROM outbox_events
             UNION ALL SELECT concat_ws(':', 'kind', movement_kind, qty_sign, requires_reason, registered_by) FROM stock_movement_kinds`,
          )
        ).rows
          .map((x) => x.t)
          .sort();
      const before = await protectedRows();
      expect(before.filter((t) => t.startsWith('pur:')).length, 'the checkpoint holds two received purchases').toBe(2);
      expect(before.filter((t) => t.startsWith('je:')).length, 'and three entries').toBe(3);
      const registriesBefore = await registries();

      const applied = await runMigrations(scratchUrl);
      expect(applied, 'exactly the S5 migrations apply').toEqual(migrationsAfter(FROZEN));
      expect(applied).toEqual([
        ...S5_MIGRATIONS,
        // P3-S6 (0067/0068)
        ...S6_MIGRATIONS,
      ]);

      // Everything as it was, plus the one accounting source type 0065 adds (A-05, A-15(e)).
      // P3-S6 (0067/0068): and the three 0067 adds (docs/PHASE_3_S6_CONTRACT.md A-05).
      expect(await protectedRows()).toEqual(
        [
          ...before,
          'src:supplier_return:8',
          // P3-S6 (0067/0068)
          'src:supplier_payment:9',
          'src:supplier_credit_allocation:10',
          'src:supplier_refund:11',
        ].sort(),
      );

      // The registries: the checkpoint's rows plus exactly S5's (§2.5).
      expect(await registries()).toEqual(
        [
          ...registriesBefore,
          ...S5_SOURCE_TYPES.map((t) => `type:${t}:P3-S5`),
          ...S5_OPERATION_MOVEMENT_KINDS.map(([op, kind]) => `map:${op}:${kind}:P3-S5`),
          ...S5_OPERATION_KINDS.map((op) => `op:${op}:P3-S5`),
          'acct:post:supplier_return',
          // P3-S6 (0067/0068): then exactly S6's (docs/PHASE_3_S6_CONTRACT.md §2.8,
          // A-03, A-05, §7.3 row 21) — seven op kinds, three accounting pairs, no stock row.
          ...S6_OPERATION_KINDS.map((op) => `op:${op}:P3-S6`),
          ...S6_ACCOUNTING_SOURCE_TYPES.map((t) => `acct:post:${t}`),
        ].sort(),
      );

      // Every S5 table and bridge is empty, and arrived with row security enabled and forced.
      const s5 = [...S5_TABLES, ...S5_BRIDGES];
      const counts = (await pool.query<{ t: string; n: number }>(s5.map((t) => `SELECT '${t}' AS t, count(*)::int AS n FROM ${t}`).join(' UNION ALL '))).rows;
      expect(Object.fromEntries(counts.map((r) => [r.t, r.n]))).toEqual(Object.fromEntries(s5.map((t) => [t, 0])));
      expect(
        (
          await pool.query<{ t: string }>(
            `SELECT relname::text AS t FROM pg_class WHERE relname = ANY ($1::text[]) AND relkind = 'r' AND relrowsecurity AND relforcerowsecurity`,
            [s5],
          )
        ).rows
          .map((x) => x.t)
          .sort(),
      ).toEqual([...s5].sort());
      for (const role of ['daftar_inventory_internal', 'daftar_accounting_internal']) {
        expect((await pool.query<{ c: boolean }>(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS c`, [role])).rows[0]?.c, role).toBe(false);
      }

      // The existing purchases live under the new rules (rolled back): one returned in part, the other reversed.
      const live = await pool.connect();
      try {
        await live.query('BEGIN');
        const { prepared, run } = await returnGoods(live, biz, toReturn.purchaseId, { lines: [{ purchaseLineId: must(toReturn.lines[0]).lineId, qty: '1' }] });
        expect(run.entry?.created, 'the return posts its entry').toBe(true);
        expect(prepared.plan.apTxnMinor, 'AP first against the checkpoint purchase').toBe(1200n);
        const reversal = await runReversal(live, biz, await prepareReversal(live, biz, toReverse.purchaseId));
        expect(reversal.entry?.created, 'the reversal posts the Phase 2 reversal').toBe(true);
        expect(reversal.rows.map((r) => r.value_delta_base_minor)).toEqual(['-1000']);
        expectAccepted(await atCommit(live), 'every deferred guard holds over the upgraded business');
      } finally {
        await live.query('ROLLBACK');
        live.release();
      }

      // A second run applies nothing.
      expect(await runMigrations(scratchUrl)).toEqual([]);
      expect(await protectedRows()).toEqual(
        [
          ...before,
          'src:supplier_return:8',
          // P3-S6 (0067/0068)
          'src:supplier_payment:9',
          'src:supplier_credit_allocation:10',
          'src:supplier_refund:11',
        ].sort(),
      );
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
    }
  }, 180_000);
});
