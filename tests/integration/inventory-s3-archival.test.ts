/**
 * P3-S3 T-12 — P3-AL-41: NOTHING HOLDING STOCK IS ARCHIVED, AND NOTHING
 * ARCHIVED RECEIVES STOCK (docs/PHASE_3_S3_CONTRACT.md A-19, §6 T-12).
 *
 * The `*_30_archive_requires_zero_stock` triggers refuse to archive a
 * warehouse, variant or product that holds stock — judged on the cache AND
 * re-checked against the movement ledger — whoever writes the row (the
 * runtime role's raw UPDATE, or the owner). At zero the archive succeeds. The
 * routines refuse a movement into an archived warehouse or variant, or a
 * variant of an archived product. The typed catalog pre-check (the HTTP
 * command) is in `tests/security/inventory-s3-http.test.ts`; the race of an
 * archive with a movement is in `inventory-s3-concurrency.test.ts`.
 *
 * Every case runs in one owner transaction that is always rolled back.
 */
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  adjustCommand,
  attempt,
  damageCommand,
  expectAccepted,
  openingCommand,
  ownerClient,
  refusedWith,
  runCommand,
  seedS3World,
  today,
  transferCommand,
  tryCommand,
  type Outcome,
  type S3Business,
  type S3World,
} from '../helpers/inventory-commands';
import { runFinancial, stockUp } from '../helpers/inventory-posting';

let world: S3World;
let day: string;
let c: Client;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 'arch');
  day = await today();
});

afterAll(async () => {
  await resetData();
});

async function inTx(fn: () => Promise<void>): Promise<void> {
  c = await ownerClient();
  try {
    await c.query('BEGIN');
    await fn();
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
}

type Target = 'warehouses' | 'product_variants' | 'products';

/** `UPDATE <table> SET status = 'archived'` on one row, as `daftar_app` scoped to the business, inside a savepoint. */
function archiveAsApp(b: S3Business, table: Target, id: string): Promise<Outcome<number>> {
  return attempt(c, async () => {
    await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [b.tenantId, b.businessId]);
    await c.query('SET LOCAL ROLE daftar_app');
    const r = await c.query(`UPDATE ${table} SET status = 'archived' WHERE business_id = $1 AND id = $2`, [b.businessId, id]);
    await c.query('RESET ROLE');
    return r.rowCount ?? 0;
  });
}

/** The same UPDATE as the owner (a superuser: RLS and grants do not apply, the triggers do). */
function archiveAsOwner(b: S3Business, table: Target, id: string): Promise<Outcome<number>> {
  return attempt(
    c,
    async () => (await c.query(`UPDATE ${table} SET status = 'archived' WHERE business_id = $1 AND id = $2`, [b.businessId, id])).rowCount ?? 0,
  );
}

describe('T-12.1 a warehouse, variant or product holding stock cannot be archived; at zero it can', () => {
  it('warehouse: warehouse_has_stock as daftar_app and as the owner; archived once drained', async () => {
    await inTx(async () => {
      const A = world.A;
      await stockUp(c, A, A.w2, [{ variantId: A.piece.variantId, qty: '2', unitCost: '10' }]);
      refusedWith(await archiveAsApp(A, 'warehouses', A.w2), 'P0001', 'inventory.warehouse_has_stock', 'daftar_app');
      refusedWith(await archiveAsOwner(A, 'warehouses', A.w2), 'P0001', 'inventory.warehouse_has_stock', 'owner');
      await runFinancial(c, A, await damageCommand(c, A, A.w2, [{ variantId: A.piece.variantId, qty: '2' }]));
      expect(expectAccepted(await archiveAsApp(A, 'warehouses', A.w2), 'ALLOW at zero')).toBe(1);
    });
  });

  it('merchant variant: variant_has_stock; archived once drained', async () => {
    await inTx(async () => {
      const A = world.A;
      const [v1] = A.variantProduct.variantIds;
      await stockUp(c, A, A.w1, [{ variantId: v1, qty: '1', unitCost: '4' }]);
      refusedWith(await archiveAsApp(A, 'product_variants', v1), 'P0001', 'inventory.variant_has_stock', 'daftar_app');
      refusedWith(await archiveAsOwner(A, 'product_variants', v1), 'P0001', 'inventory.variant_has_stock', 'owner');
      await runFinancial(c, A, await adjustCommand(c, A, A.w1, [{ variantId: v1, qty: '-1' }]));
      expect(expectAccepted(await archiveAsApp(A, 'product_variants', v1), 'ALLOW at zero')).toBe(1);
    });
  });

  it('product: product_has_stock through its base variant, in any warehouse; archived once drained', async () => {
    await inTx(async () => {
      const A = world.A;
      await stockUp(c, A, A.w2, [{ variantId: A.piece2.variantId, qty: '3', unitCost: '1' }]);
      refusedWith(await archiveAsApp(A, 'products', A.piece2.productId), 'P0001', 'inventory.product_has_stock', 'daftar_app');
      refusedWith(await archiveAsOwner(A, 'products', A.piece2.productId), 'P0001', 'inventory.product_has_stock', 'owner');
      await runCommand(c, A, transferCommand(A.w2, A.w1, [{ variantId: A.piece2.variantId, qty: '3' }]));
      refusedWith(await archiveAsApp(A, 'products', A.piece2.productId), 'P0001', 'inventory.product_has_stock', 'moved, not drained');
      await runFinancial(c, A, await damageCommand(c, A, A.w1, [{ variantId: A.piece2.variantId, qty: '3' }]));
      expect(expectAccepted(await archiveAsApp(A, 'products', A.piece2.productId), 'ALLOW at zero')).toBe(1);
    });
  });

  it('the movement ledger is re-checked: a cache forged to zero does not let a warehouse, variant or product with stock be archived', async () => {
    await inTx(async () => {
      const A = world.A;
      const [mv] = A.variantProduct.variantIds;
      await stockUp(c, A, A.w2, [
        { variantId: A.dec2.variantId, qty: '1.25', unitCost: '8' },
        { variantId: mv, qty: '2', unitCost: '3' },
      ]);
      // H-6: the owner forges the cache to empty keys with its own guards silenced (replica role).
      await c.query(`SET LOCAL session_replication_role = replica`);
      await c.query(`UPDATE stock_levels SET on_hand = 0, valuation_base_minor = 0 WHERE business_id = $1 AND warehouse_id = $2`, [A.businessId, A.w2]);
      await c.query(`SET LOCAL session_replication_role = origin`);
      const cache = await c.query(`SELECT DISTINCT on_hand::text FROM stock_levels WHERE business_id = $1 AND warehouse_id = $2`, [A.businessId, A.w2]);
      expect(cache.rows, 'the cache now says zero').toEqual([{ on_hand: '0.0000' }]);
      refusedWith(await archiveAsOwner(A, 'warehouses', A.w2), 'P0001', 'inventory.warehouse_has_stock', 'warehouse, ledger Σ ≠ 0');
      refusedWith(await archiveAsOwner(A, 'product_variants', mv), 'P0001', 'inventory.variant_has_stock', 'variant, ledger Σ ≠ 0');
      refusedWith(await archiveAsOwner(A, 'products', A.dec2.productId), 'P0001', 'inventory.product_has_stock', 'product, ledger Σ ≠ 0');
    });
  });

  it('negative control: with the warehouse trigger dropped, a warehouse holding stock is archived', async () => {
    await inTx(async () => {
      const A = world.A;
      await stockUp(c, A, A.w2, [{ variantId: A.piece.variantId, qty: '2', unitCost: '10' }]);
      await c.query('DROP TRIGGER warehouses_30_archive_requires_zero_stock ON warehouses');
      expect(expectAccepted(await archiveAsOwner(A, 'warehouses', A.w2), 'the protection is the trigger')).toBe(1);
    });
  });
});

describe('T-12.2 nothing archived receives stock', () => {
  it('a transfer into an archived warehouse, and an adjustment and an opening on one, are refused warehouse_archived; the active one is accepted', async () => {
    await inTx(async () => {
      const A = world.A;
      await stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '4', unitCost: '10' }]);
      expectAccepted(await archiveAsApp(A, 'warehouses', A.w2));
      refusedWith(
        await tryCommand(c, A, transferCommand(A.w1, A.w2, [{ variantId: A.piece.variantId, qty: '1' }])),
        'P0001',
        'inventory.warehouse_archived',
        'transfer in',
      );
      refusedWith(
        await tryCommand(c, A, await adjustCommand(c, A, A.w2, [{ variantId: A.piece.variantId, qty: '1', unitCost: '3' }])),
        'P0001',
        'inventory.warehouse_archived',
        'adjust',
      );
      refusedWith(
        await tryCommand(c, A, openingCommand(day, [{ warehouseId: A.w2, variantId: A.piece2.variantId, qty: '1', unitCost: '5' }])),
        'P0001',
        'inventory.warehouse_archived',
        'opening',
      );
      expectAccepted(
        await tryCommand(c, A, await adjustCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '1', unitCost: '3' }])),
        'ALLOW: the active warehouse',
      );
    });
  });

  it('an archived merchant variant, or a variant of an archived product, is refused variant_archived; the active sibling is accepted', async () => {
    await inTx(async () => {
      const A = world.A;
      const [v1, v2] = A.variantProduct.variantIds;
      expectAccepted(await archiveAsApp(A, 'product_variants', v1));
      refusedWith(
        await tryCommand(c, A, await adjustCommand(c, A, A.w1, [{ variantId: v1, qty: '1', unitCost: '3' }])),
        'P0001',
        'inventory.variant_archived',
        'archived variant',
      );
      expectAccepted(await tryCommand(c, A, await adjustCommand(c, A, A.w1, [{ variantId: v2, qty: '1', unitCost: '3' }])), 'ALLOW: the sibling');

      expectAccepted(await archiveAsApp(A, 'products', A.piece2.productId));
      refusedWith(
        await tryCommand(c, A, await adjustCommand(c, A, A.w1, [{ variantId: A.piece2.variantId, qty: '1', unitCost: '3' }])),
        'P0001',
        'inventory.variant_archived',
        'base variant of an archived product',
      );
    });
  });
});
