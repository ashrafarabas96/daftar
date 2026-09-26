import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PostingCommand } from '@daftar/accounting';
import { configureProductPayload, splitInventoryAssertion } from '@daftar/inventory';
import { Database, type BusinessInventoryTransaction, type BusinessScope } from '../../apps/api/src/infra/database';
import { DatabaseAccountingSourcesAdapter } from '../../apps/api/src/modules/accounting/accounting-sources.adapter';
import { createTestApp, ensurePostgres, mintTestInventoryAssertion, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import {
  fingerprintOf,
  must,
  seedPostingFixture,
  simpleCommand,
  sourceAssertion,
  todayIn,
  type PostCommand,
  type PostingFixture,
} from '../helpers/accounting-posting';

/**
 * THE P3-AL-32 SEAM MATRIX, ROW 7 — composition with an accepted Phase 2
 * operation, carrying a REAL P3-S1 inventory assertion.
 *
 * Inside `withBusinessInventoryAccountingTransaction`, the real
 * `inventory_configure_product` routine consumes a real `invctl/1`
 * assertion for `inventory.configure_product` from the seam's carrier, and
 * an existing, accepted Phase 2 accounting operation (the P2-S4 manual
 * adjustment) runs on the SAME transaction handle; both commit once,
 * together — and a failure injected after both removes both (row 8 again,
 * this time with the real P3-S1 command in the transaction).
 *
 * DEPENDS ON THE DATABASE HALF OF P3-S1 (migrations 0053/0054 and the routine
 * `inventory_configure_product`, plus `ensurePostgres()` installing the
 * inventory test key). It is kept in its own file for that reason and is run
 * once that branch is merged; nothing in it is skipped.
 */

let t: TestApp;
let db: Database;
let sources: DatabaseAccountingSourcesAdapter;
let fx: PostingFixture;
let today: string;
let scope: BusinessScope;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  fx = await seedPostingFixture(ownerPool(), 'seam-posting');
  today = await todayIn(ownerPool(), 'Asia/Hebron');
  scope = { tenantId: fx.tenantId, businessId: fx.businessId, actorUserId: fx.userId };
  t = await createTestApp();
  db = t.app.get(Database);
  sources = t.app.get(DatabaseAccountingSourcesAdapter);
}, 180_000);

afterAll(async () => {
  await t.close();
});

async function newProduct(): Promise<string> {
  const r = await ownerPool().query<{ id: string }>(
    `INSERT INTO products (business_id, sku, base_price_minor, price_currency) VALUES ($1, $2, 1, 'ILS') RETURNING id`,
    [fx.businessId, `seam-${randomUUID().slice(0, 8)}`],
  );
  return must(r.rows[0]).id;
}

interface Configure {
  productId: string;
  trackInventory: boolean;
  unitCode: string | null;
  unitDecimals: number | null;
}

/** The exact assertion the merchant API would mint for this exact command. */
function configureAssertion(c: Configure): string {
  const payload = configureProductPayload({ tenantId: fx.tenantId, businessId: fx.businessId, ...c });
  return mintTestInventoryAssertion({
    actorUserId: fx.userId,
    tenantId: fx.tenantId,
    businessId: fx.businessId,
    opCode: payload.opCode,
    payloadSha256: payload.sha256,
  });
}

async function configure(tx: BusinessInventoryTransaction, c: Configure): Promise<void> {
  await tx.query(`SELECT inventory_configure_product($1, $2, $3, $4)`, [c.productId, c.trackInventory, c.unitCode, c.unitDecimals]);
}

function adjustment(): PostCommand {
  return simpleCommand(fx, randomUUID(), today, 150000n, 'manual_adjustment');
}

function accountingAssertionFor(c: PostCommand): string {
  return sourceAssertion({
    actorUserId: fx.userId,
    tenantId: c.tenantId,
    businessId: c.businessId,
    operationKind: 'post',
    sourceType: 'manual_adjustment',
    sourceId: c.sourceId,
    postingFingerprint: fingerprintOf(c),
  });
}

function postingCommand(c: PostCommand): PostingCommand {
  return {
    tenantId: c.tenantId,
    businessId: c.businessId,
    sourceType: c.sourceType,
    sourceId: c.sourceId,
    entryDate: c.entryDate,
    description: c.description ?? null,
    requestId: c.requestId ?? null,
    lines: c.lines.map((l) => ({ ...l, branchId: l.branchId ?? null, warehouseId: l.warehouseId ?? null })),
  };
}

async function productState(id: string): Promise<{ track_inventory: boolean; unit_code: string | null; unit_decimals: number | null; xmin: string }> {
  const r = await ownerPool().query<{ track_inventory: boolean; unit_code: string | null; unit_decimals: number | null; xmin: string }>(
    `SELECT track_inventory, unit_code, unit_decimals, xmin::text AS xmin FROM products WHERE id = $1`,
    [id],
  );
  return must(r.rows[0]);
}

async function useOf(inventoryAssertion: string): Promise<{ xact: string } | undefined> {
  const { jti } = splitInventoryAssertion(inventoryAssertion);
  return (await ownerPool().query<{ xact: string }>(`SELECT xact::text AS xact FROM inventory_assertion_uses WHERE jti = $1::uuid`, [jti])).rows[0];
}

describe('row 7 — an accepted Phase 2 posting composes with the P3-S1 command on one handle, and commits once', () => {
  it('configure_product (consuming a real invctl/1) and a manual adjustment commit in ONE transaction', async () => {
    const productId = await newProduct();
    const command: Configure = { productId, trackInventory: true, unitCode: 'piece', unitDecimals: 0 };
    const inv = configureAssertion(command);
    const c = adjustment();

    const result = await db.withBusinessInventoryAccountingTransaction(scope, inv, accountingAssertionFor(c), async (tx) => {
      await configure(tx, command);
      const posted = await sources.postAdjustmentInTransaction(tx.accounting, { command: postingCommand(c), reason: 'composed with configure_product' });
      const ids = must(
        (await tx.query<{ xid8: string; xid: string }>(`SELECT pg_current_xact_id()::text AS xid8, xid(pg_current_xact_id())::text AS xid`)).rows[0],
      );
      return { ...posted, ...ids };
    });

    expect(result.created).toBe(true);
    const status = must((await ownerPool().query<{ s: string }>(`SELECT pg_xact_status($1::xid8) AS s`, [result.xid8])).rows[0]).s;
    expect(status).toBe('committed');
    // The P3-S1 command's effect, its consumed assertion and the posting all
    // belong to that one committed transaction.
    const product = await productState(productId);
    expect(product).toMatchObject({ track_inventory: true, unit_code: 'piece', unit_decimals: 0 });
    expect(product.xmin).toBe(result.xid);
    expect(await useOf(inv)).toEqual({ xact: result.xid8 });
    const entry = must((await ownerPool().query<{ xmin: string }>(`SELECT xmin::text AS xmin FROM journal_entries WHERE id = $1`, [result.entryId])).rows[0]);
    expect(entry.xmin).toBe(result.xid);
  });

  it('a failure injected after both rolls back the P3-S1 command, its assertion use AND the posting', async () => {
    const productId = await newProduct();
    const command: Configure = { productId, trackInventory: true, unitCode: 'kg', unitDecimals: 3 };
    const inv = configureAssertion(command);
    const c = adjustment();

    const run = db.withBusinessInventoryAccountingTransaction(scope, inv, accountingAssertionFor(c), async (tx) => {
      await configure(tx, command);
      await sources.postAdjustmentInTransaction(tx.accounting, { command: postingCommand(c), reason: 'composed with configure_product' });
      throw new Error('injected after the command and the posting');
    });
    await expect(run).rejects.toThrow('injected after the command and the posting');

    expect(await productState(productId)).toMatchObject({ track_inventory: false, unit_code: null, unit_decimals: null });
    expect(await useOf(inv)).toBeUndefined();
    const entries = must(
      (await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM journal_entries WHERE source_id = $1::uuid`, [c.sourceId])).rows[0],
    );
    expect(entries.n).toBe('0');
  });

  it('the non-posting seam carries the same inventory assertion to the same routine, and posts nothing', async () => {
    const productId = await newProduct();
    const command: Configure = { productId, trackInventory: true, unitCode: 'piece', unitDecimals: 0 };
    const inv = configureAssertion(command);
    const xid8 = await db.withBusinessInventoryTransaction(scope, inv, async (tx) => {
      await configure(tx, command);
      return must((await tx.query<{ x: string }>(`SELECT pg_current_xact_id()::text AS x`)).rows[0]).x;
    });
    expect(await productState(productId)).toMatchObject({ track_inventory: true, unit_code: 'piece', unit_decimals: 0 });
    expect(await useOf(inv)).toEqual({ xact: xid8 });
  });
});
