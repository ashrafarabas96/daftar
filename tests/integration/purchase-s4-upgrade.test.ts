/**
 * P3-S4 T-17 — THE UPGRADE MATRIX (docs/PHASE_3_S4_CONTRACT.md A-02, §2.1,
 * §2.5, §2.7, §6 T-17).
 *
 * A database frozen at the P3-S3 checkpoint (0062) holding a live business —
 * suppliers do not exist yet, but stock does: an S3 adjustment with its
 * journal entry, and a transfer — is migrated to 0063/0064 and:
 *
 * - exactly the S4 migrations apply, first 0063 then 0064;
 * - books, ledger, documents and catalogue are byte-for-byte as they were,
 *   plus the two accounting source types 0063 is authorized to add;
 * - the registries are exactly S3 + S4 (§2.5), every S4 table and bridge is
 *   empty and arrived with row security enabled and forced;
 * - no internal principal keeps CREATE on `public`;
 * - the existing business then works under the new rules (a supplier, a
 *   draft and a receipt onto its existing stock, rolled back);
 * - a second run applies nothing.
 */
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../../apps/api/src/infra/migrate';
import { parseQuantity, toQ4 } from '../../packages/inventory/src';
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
import { must, runCommand as runS3, seedS3Business, today, transferCommand } from '../helpers/inventory-commands';
import { stockUp } from '../helpers/inventory-posting';
import { createSupplier, draftAndReceive, draftCommand, entryOf, S4_BRIDGES, S4_TABLES } from '../helpers/purchase-commands';
import { S4_OPERATION_KINDS, S4_OPERATION_MOVEMENT_KINDS, S4_SOURCE_TYPES } from '../helpers/purchase-deficits';

const SCRATCH = 'daftar_upgrade_0062';
const scratchUrl = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${SCRATCH}`;
const FROZEN = '0062_inventory_movement_commands.sql';

function bootstrapSql(): string {
  return readFileSync(join(__dirname, '../../infrastructure/database/bootstrap.sql'), 'utf8')
    .replaceAll('__APP_DB_PASSWORD__', APP_DB_PASSWORD)
    .replaceAll('__PLATFORM_DB_PASSWORD__', PLATFORM_DB_PASSWORD)
    .replaceAll('__WORKER_DB_PASSWORD__', WORKER_DB_PASSWORD)
    .replaceAll('__RESOLVER_DB_PASSWORD__', RESOLVER_DB_PASSWORD)
    .replaceAll('__IDENTITY_DB_PASSWORD__', IDENTITY_DB_PASSWORD);
}

function migrationsUpTo(upTo: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'daftar-mig-s4-'));
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

/** The scratch database is dropped WITH (FORCE); the pool must not re-throw that termination (the migration-upgrade precedent). */
function scratchPool(connectionString: string, max = 2): Pool {
  const pool = new Pool({ connectionString, max });
  pool.on('error', () => undefined);
  return pool;
}

const admin = scratchPool(dbUrl, 1);

afterAll(async () => {
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`).catch(() => undefined);
  await admin.end();
});

describe('T-17 the P3-S4 upgrade matrix', () => {
  it('frozen 0062-checkpoint + a business with stock and books → 0063/0064, everything untouched, registries exactly S3 + S4, rerun no-op', async () => {
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

      // The checkpoint is honest: the S3 documents are there, the S4 ones are not.
      for (const t of [...S4_TABLES, ...S4_BRIDGES]) {
        expect((await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = $1`, [t])).rows, t).toEqual([]);
      }

      // A live business of the checkpoint: stock through the real S3 commands, with its entry.
      const tenantId = must((await pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0]).id;
      const userId = must(
        (
          await pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'Upgrade owner') RETURNING id`, [
            `s4-upgrade-${randomUUID().slice(0, 8)}@test.daftar.local`,
          ])
        ).rows[0],
      ).id;
      const biz = await seedS3Business(pool, tenantId, userId, 's4up');
      const seed = await pool.connect();
      try {
        await seed.query('BEGIN');
        await stockUp(seed, biz, biz.w1, [{ variantId: biz.piece.variantId, qty: '5', unitCost: '10' }]);
        await runS3(seed, biz, transferCommand(biz.w1, biz.w2, [{ variantId: biz.piece.variantId, qty: '1' }]));
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
             UNION ALL SELECT concat_ws(':', 'jl', id, journal_entry_id, account_id, debit_minor, credit_minor, warehouse_id, branch_id) FROM journal_lines
             UNION ALL SELECT concat_ws(':', 'bind', business_id, source_type, source_id, journal_entry_id) FROM accounting_source_bindings
             UNION ALL SELECT concat_ws(':', 'src', source_type, sort_order) FROM accounting_source_types
             UNION ALL SELECT concat_ws(':', 'biz', id, tenant_id, base_currency, timezone, financial_started_at) FROM businesses
             UNION ALL SELECT concat_ws(':', 'wh', business_id, id, branch_id, name, is_default, status) FROM warehouses
             UNION ALL SELECT concat_ws(':', 'p', business_id, id, sku, status, track_inventory, unit_code, unit_decimals) FROM products
             UNION ALL SELECT concat_ws(':', 'v', business_id, id, product_id, sku, status, is_base) FROM product_variants
             UNION ALL SELECT concat_ws(':', 'mv', business_id, id, warehouse_id, variant_id, stock_seq, movement_kind, source_type, source_id, qty_delta, unit_cost_base_minor, value_delta_base_minor) FROM stock_movements
             UNION ALL SELECT concat_ws(':', 'lvl', business_id, warehouse_id, variant_id, on_hand, valuation_base_minor, avg_unit_cost_base_minor, last_stock_seq) FROM stock_levels
             UNION ALL SELECT concat_ws(':', 'sb', business_id, source_type, source_id, source_line_id, movement_kind) FROM stock_source_bindings
             UNION ALL SELECT concat_ws(':', 'adj', business_id, id, warehouse_id, total_value_base_minor) FROM inventory_adjustments
             UNION ALL SELECT concat_ws(':', 'tr', business_id, id) FROM inventory_transfers
             UNION ALL SELECT concat_ws(':', 'use', jti, op_code) FROM inventory_assertion_uses
             UNION ALL SELECT concat_ws(':', 'audit', id, action) FROM audit_events
             UNION ALL SELECT concat_ws(':', 'kind', movement_kind, qty_sign, requires_reason, registered_by) FROM stock_movement_kinds`,
          )
        ).rows
          .map((x) => x.t)
          .sort();
      const before = await protectedRows();
      expect(before.filter((t) => t.startsWith('mv:')).length, 'the checkpoint holds movements').toBe(3);
      expect(before.filter((t) => t.startsWith('je:')).length, 'and an entry').toBe(1);
      const registriesBefore = await registries();

      const applied = await runMigrations(scratchUrl);
      expect(applied).toEqual(migrationsAfter(FROZEN));
      expect(applied.slice(0, 2)).toEqual(['0063_purchases_suppliers_sources.sql', '0064_purchase_commands.sql']);

      // Everything as it was, plus the two accounting source types 0063 adds (§2.1, A-14).
      expect(await protectedRows()).toEqual([...before, 'src:purchase:6', 'src:negative_inventory_cost_adjustment:7'].sort());

      // The registries: the checkpoint's rows plus exactly S4's (§2.5).
      expect(await registries()).toEqual(
        [
          ...registriesBefore,
          ...S4_SOURCE_TYPES.map((t) => `type:${t}:P3-S4`),
          ...S4_OPERATION_MOVEMENT_KINDS.map(([op, kind]) => `map:${op}:${kind}:P3-S4`),
          ...S4_OPERATION_KINDS.map((op) => `op:${op}:P3-S4`),
          'acct:post:purchase',
          'acct:post:negative_inventory_cost_adjustment',
        ].sort(),
      );

      // Every S4 table and bridge is empty, and arrived with row security enabled and forced.
      const s4 = [...S4_TABLES, ...S4_BRIDGES];
      const counts = (await pool.query<{ t: string; n: number }>(s4.map((t) => `SELECT '${t}' AS t, count(*)::int AS n FROM ${t}`).join(' UNION ALL '))).rows;
      expect(Object.fromEntries(counts.map((r) => [r.t, r.n]))).toEqual(Object.fromEntries(s4.map((t) => [t, 0])));
      expect(
        (
          await pool.query<{ t: string }>(
            `SELECT relname::text AS t FROM pg_class WHERE relname = ANY ($1::text[]) AND relkind = 'r' AND relrowsecurity AND relforcerowsecurity`,
            [s4],
          )
        ).rows
          .map((x) => x.t)
          .sort(),
      ).toEqual([...s4].sort());
      for (const role of ['daftar_inventory_internal', 'daftar_accounting_internal']) {
        expect((await pool.query<{ c: boolean }>(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS c`, [role])).rows[0]?.c, role).toBe(false);
      }

      // The existing business lives under the new rules: a supplier, a draft
      // and a receipt of 2 at 12.00 onto its existing 4 @ 10 (rolled back).
      const live = await pool.connect();
      try {
        await live.query('BEGIN');
        const supplierId = await createSupplier(live, biz, { name: 'Post-upgrade supplier' });
        const levelOf = async (): Promise<{ onHand: bigint; valuation: bigint }> => {
          const r = must(
            (
              await live.query<{ on_hand: string; valuation: string }>(
                `SELECT on_hand::text AS on_hand, valuation_base_minor::text AS valuation FROM stock_levels WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3`,
                [biz.businessId, biz.w1, biz.piece.variantId],
              )
            ).rows[0],
          );
          return { onHand: parseQuantity(r.on_hand), valuation: BigInt(r.valuation) };
        };
        const existing = await levelOf();
        const run = await draftAndReceive(
          live,
          biz,
          await draftCommand(live, supplierId, biz.w1, [{ variantId: biz.piece.variantId, qty: '2', unitPriceMinor: '1200' }], {
            documentDate: await today(live),
          }),
        );
        expect(run.purchaseEntry?.created).toBe(true);
        const B = run.prepared.cmd.totalBaseMinor.toString(10);
        const entry = must(await entryOf(live, biz.businessId, 'purchase', run.prepared.cmd.purchaseId));
        expect(entry.lines.map((l) => [l.system_key, l.debit, l.credit])).toEqual([
          ['inventory', B, '0'],
          ['accounts_payable', '0', B],
        ]);
        expect(await levelOf(), 'the receipt lands on the existing key').toEqual({
          onHand: existing.onHand + toQ4('2'),
          valuation: existing.valuation + run.prepared.cmd.totalBaseMinor,
        });
        await live.query('SET CONSTRAINTS ALL IMMEDIATE');
      } finally {
        await live.query('ROLLBACK').catch(() => undefined);
        live.release();
      }

      // A second run applies nothing.
      expect(await runMigrations(scratchUrl)).toEqual([]);
      expect(await protectedRows()).toEqual([...before, 'src:purchase:6', 'src:negative_inventory_cost_adjustment:7'].sort());
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`).catch(() => undefined);
    }
  }, 180_000);
});
