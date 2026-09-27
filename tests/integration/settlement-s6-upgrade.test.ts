/**
 * P3-S6 T-17 — THE UPGRADE MATRIX (docs/PHASE_3_S6_CONTRACT.md A-02, §2.1,
 * §2.8, §2.9, §6 T-17).
 *
 * A database frozen at the P3-S5 checkpoint (0066) holding a live business —
 * S3 stock and a transfer, two purchases received through the real S4
 * routines, one returned in part through the real S5 routine, each with its
 * entry — is migrated to 0067/0068 and:
 *
 * - exactly the S6 migrations apply, 0067 then 0068;
 * - books, ledger, S1–S5 documents and catalogue rows are as they were, plus
 *   the three accounting source types 0067 is authorized to add
 *   (`supplier_payment` 9, `supplier_credit_allocation` 10,
 *   `supplier_refund` 11);
 * - the registries are exactly S1…S6: the seven S6 operation kinds (26 in
 *   all), the three `post` accounting kinds, no stock source type and no
 *   operation → movement mapping;
 * - every S6 table is empty and arrived with row security enabled and
 *   forced; no internal principal keeps CREATE on `public`; both discoveries
 *   (`supplier_settlement_guard_gaps()`, `inventory_stock_source_guard_gaps()`)
 *   return no row;
 * - the existing purchases then live under the new rules (rolled back): the
 *   partly returned one is paid for exactly what the return left, a later
 *   return issues a real credit note, and that credit is refunded — every
 *   deferred guard holds;
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
import { receivedPurchase, returnGoods, type ReceivedPurchase } from '../helpers/purchase-returns';
import {
  S6_OPERATION_KINDS,
  S6_SOURCE_TYPES,
  S6_TABLES,
  createMethod,
  creditNoteIdOf,
  flushDeferred,
  noteOf,
  outstandingOf,
  payInFull,
  prepareRefund,
  runS6,
  seedSettlementAccounts,
} from '../helpers/supplier-settlement';

const SCRATCH = 'daftar_upgrade_0066';
const scratchUrl = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${SCRATCH}`;
const FROZEN = '0066_supplier_return_reversal_commands.sql';
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
  const dir = mkdtempSync(join(tmpdir(), 'daftar-mig-s6-'));
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

/** The scratch database is dropped WITH (FORCE): only the resulting 57P01 is expected of an idle pooled connection. */
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

describe('T-17 the P3-S6 upgrade matrix', () => {
  it('frozen 0066 checkpoint + a live business → 0067/0068, everything untouched, registries exactly S1…S6, gaps empty, rerun no-op', async () => {
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

      // The checkpoint is honest: the S5 documents are there, the S6 ones are not.
      for (const t of S6_TABLES) expect((await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = $1`, [t])).rows, t).toEqual([]);
      for (const f of ['supplier_pay', 'payment_method_create', 'supplier_settlement_guard_gaps']) {
        expect((await pool.query(`SELECT 1 FROM pg_proc WHERE proname = $1`, [f])).rows, f).toEqual([]);
      }

      // A live business of the checkpoint: S3 stock and a transfer, two S4 receipts, one S5 partial return.
      const tenantId = must((await pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0]).id;
      const userId = must(
        (
          await pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'Upgrade owner') RETURNING id`, [
            `s6-upgrade-${randomUUID().slice(0, 8)}@test.daftar.local`,
          ])
        ).rows[0],
      ).id;
      const biz = await seedS3Business(pool, tenantId, userId, 's6up');
      let partlyReturned: ReceivedPurchase;
      let untouched: ReceivedPurchase;
      const seed = await pool.connect();
      try {
        await seed.query('BEGIN');
        await stockUp(seed, biz, biz.w1, [{ variantId: biz.piece.variantId, qty: '5', unitCost: '10' }]);
        await runS3(seed, biz, transferCommand(biz.w1, biz.w2, [{ variantId: biz.piece.variantId, qty: '1' }]));
        const supplierId = await createSupplier(seed, biz, { name: 'Checkpoint supplier' });
        partlyReturned = await receivedPurchase(seed, biz, [{ variantId: biz.piece.variantId, qty: '3', unitPriceMinor: '1200' }], { supplierId });
        untouched = await receivedPurchase(seed, biz, [{ variantId: biz.piece2.variantId, qty: '2', unitPriceMinor: '500' }], { supplierId });
        await returnGoods(seed, biz, partlyReturned.purchaseId, { lines: [{ purchaseLineId: must(partlyReturned.lines[0]).lineId, qty: '1' }] });
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
             UNION ALL SELECT concat_ws(':', 'mv', business_id, id, warehouse_id, variant_id, stock_seq, movement_kind, source_type, source_id, qty_delta, unit_cost_base_minor, value_delta_base_minor) FROM stock_movements
             UNION ALL SELECT concat_ws(':', 'lvl', business_id, warehouse_id, variant_id, on_hand, valuation_base_minor, avg_unit_cost_base_minor, last_stock_seq) FROM stock_levels
             UNION ALL SELECT concat_ws(':', 'sb', business_id, source_type, source_id, source_line_id, movement_kind) FROM stock_source_bindings
             UNION ALL SELECT concat_ws(':', 'sup', business_id, id, name, status, revision) FROM suppliers
             UNION ALL SELECT concat_ws(':', 'pur', business_id, id, supplier_id, warehouse_id, status, revision, currency_code, total_txn_minor, total_base_minor, source_to_base_rate, receive_intent_sha256) FROM purchases
             UNION ALL SELECT concat_ws(':', 'pl', business_id, purchase_id, id, line_no, variant_id, qty, net_txn_minor, landed_cost_txn_minor, base_share_minor, unit_cost_base_minor) FROM purchase_lines
             UNION ALL SELECT concat_ws(':', 'ret', business_id, id, purchase_id, ap_txn_minor, ap_base_minor, ap_released_before_txn_minor, credit_txn_minor) FROM supplier_returns
             UNION ALL SELECT concat_ws(':', 'retl', business_id, return_id, id, purchase_line_id, qty) FROM supplier_return_lines
             UNION ALL SELECT concat_ws(':', 'cn', business_id, id, original_amount_minor, remaining_amount_minor, remaining_carrying_base_amount_minor) FROM supplier_credit_notes
             UNION ALL SELECT concat_ws(':', 'use', jti, op_code) FROM inventory_assertion_uses
             UNION ALL SELECT concat_ws(':', 'audit', id, action) FROM audit_events
             UNION ALL SELECT concat_ws(':', 'out', id, type) FROM outbox_events`,
          )
        ).rows
          .map((x) => x.t)
          .sort();
      const before = await protectedRows();
      expect(before.filter((t) => t.startsWith('pur:')).length, 'the checkpoint holds two received purchases').toBe(2);
      expect(before.filter((t) => t.startsWith('ret:')).length, 'and one return').toBe(1);
      const registriesBefore = await registries();

      const applied = await runMigrations(scratchUrl);
      expect(applied, 'exactly the S6 migrations apply').toEqual(migrationsAfter(FROZEN));
      expect(applied).toEqual(S6_MIGRATIONS);

      // Everything as it was, plus the three accounting source types 0067 adds (A-05).
      expect(await protectedRows()).toEqual([...before, 'src:supplier_payment:9', 'src:supplier_credit_allocation:10', 'src:supplier_refund:11'].sort());

      // The registries: the checkpoint's rows plus exactly S6's (§2.8, A-05): no stock source type, no mapping.
      const after = await registries();
      expect(after).toEqual([...registriesBefore, ...S6_OPERATION_KINDS.map((op) => `op:${op}:P3-S6`), ...S6_SOURCE_TYPES.map((t) => `acct:post:${t}`)].sort());
      expect(after.filter((r) => r.startsWith('op:')).length, 'S1 3 + S3 7 + S4 7 + S5 2 + S6 7').toBe(26);

      // Every S6 table is empty and arrived with row security enabled and forced.
      const counts = (await pool.query<{ t: string; n: number }>(S6_TABLES.map((t) => `SELECT '${t}' AS t, count(*)::int AS n FROM ${t}`).join(' UNION ALL ')))
        .rows;
      expect(Object.fromEntries(counts.map((r) => [r.t, r.n]))).toEqual(Object.fromEntries(S6_TABLES.map((t) => [t, 0])));
      expect(
        (
          await pool.query<{ t: string }>(
            `SELECT relname::text AS t FROM pg_class WHERE relname = ANY ($1::text[]) AND relkind = 'r' AND relrowsecurity AND relforcerowsecurity`,
            [[...S6_TABLES]],
          )
        ).rows
          .map((x) => x.t)
          .sort(),
      ).toEqual([...S6_TABLES].sort());
      for (const role of ['daftar_inventory_internal', 'daftar_accounting_internal']) {
        expect((await pool.query<{ c: boolean }>(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS c`, [role])).rows[0]?.c, role).toBe(false);
      }
      expect((await pool.query(`SELECT * FROM supplier_settlement_guard_gaps()`)).rows, 'supplier_settlement_guard_gaps()').toEqual([]);
      expect((await pool.query(`SELECT * FROM inventory_stock_source_guard_gaps()`)).rows, 'inventory_stock_source_guard_gaps()').toEqual([]);

      // The checkpoint's purchases live under S6 (rolled back).
      const live = await pool.connect();
      try {
        await live.query('BEGIN');
        const accounts = await seedSettlementAccounts(live, biz);
        const method = await createMethod(live, biz, { postingAccountId: accounts.settlement.bank });
        expect(await outstandingOf(live, biz.businessId, partlyReturned.purchaseId), 'O = T − the S5 return (AP first)').toEqual({
          o: 2400n,
          t: 3600n,
          b: 3600n,
        });
        await payInFull(live, biz, partlyReturned.purchaseId, partlyReturned.supplierId, method);
        expect((await outstandingOf(live, biz.businessId, partlyReturned.purchaseId)).o).toBe(0n);
        await flushDeferred(live);
        const { prepared } = await returnGoods(live, biz, partlyReturned.purchaseId, {
          lines: [{ purchaseLineId: must(partlyReturned.lines[0]).lineId, qty: '1' }],
        });
        const noteId = must(await creditNoteIdOf(live, biz.businessId, prepared.cmd.returnId), 'a return after the payment issues a real credit note');
        expect(await noteOf(live, biz.businessId, noteId)).toMatchObject({ original: 1200n, remaining: 1200n });
        await flushDeferred(live);
        await runS6(live, biz, await prepareRefund(live, biz, { creditNoteId: noteId, paymentMethodId: method, consumedMinor: 1200n }));
        expect(await noteOf(live, biz.businessId, noteId)).toMatchObject({ remaining: 0n, remainingCarrying: 0n });
        expect((await outstandingOf(live, biz.businessId, untouched.purchaseId)).o, 'the other purchase is open in full').toBe(1000n);
        expectAccepted(await atCommit(live), 'every deferred guard holds over the upgraded business');
      } finally {
        await live.query('ROLLBACK');
        live.release();
      }

      // A second run applies nothing.
      expect(await runMigrations(scratchUrl)).toEqual([]);
      expect(await protectedRows()).toEqual([...before, 'src:supplier_payment:9', 'src:supplier_credit_allocation:10', 'src:supplier_refund:11'].sort());
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
    }
  }, 180_000);
});
