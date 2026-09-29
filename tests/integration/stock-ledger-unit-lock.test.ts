/**
 * P3-S2 — THE UNIT-HISTORY LOCK, THE VARIANT STOCK-IDENTITY LOCK AND THE
 * P3-AL-41 DISABLE RULE (docs/PHASE_3_S2_CONTRACT.md §6: T-17.1 – T-17.10,
 * T-17.N; A-12, A-13, A-18; the post-review H-1 variant lock and the M-1
 * READ COMMITTED requirement of the configure command, R7 and R9).
 *
 * The configuration command is the REAL `inventory_configure_product`,
 * carrying an assertion minted by the S1 minter (`mintTestInventoryAssertion`)
 * over the S1 payload digest, as `daftar_app`. Stock history is written by
 * the fixture producer through the real primitive. Everything happens in a
 * transaction that is rolled back; the products are fresh per case.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  INTERNAL,
  addTrackedProduct,
  addVariantProduct,
  applyOne,
  attempt,
  expectAccepted,
  expectRefused,
  must,
  req,
  scratch,
  seedStockBusiness,
  setScope,
  tryConfigure,
  withRolledBackFixture,
  withoutRefusal,
  type ConfigureCall,
  type Key,
  type ProductRef,
  type Queryable,
  type StockBusiness,
} from '../helpers/stock-ledger';

let biz: StockBusiness;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  biz = await seedStockBusiness(ownerPool(), 'unitlock');
});

/** A fresh tracked `piece`/0 product with its base variant (committed; each case is otherwise rolled back). */
async function freshProduct(): Promise<ProductRef & { key: Key }> {
  const p = await addTrackedProduct(ownerPool(), biz, 'piece', 0);
  return { ...p, key: { warehouseId: biz.warehouse1, variantId: p.variantId } };
}

const call = (productId: string, track: boolean, unitCode: string | null, unitDecimals: number | null = null): ConfigureCall => ({
  productId,
  track,
  unitCode,
  unitDecimals,
});

async function unitOf(q: Queryable, productId: string): Promise<{ track: boolean; unit: string | null; decimals: number | null }> {
  const r = await q.query<{ track: boolean; unit: string | null; decimals: number | null }>(
    `SELECT track_inventory AS track, unit_code AS unit, unit_decimals AS decimals FROM products WHERE id = $1`,
    [productId],
  );
  return must(r.rows[0]);
}

type Reparenter = { role: 'daftar_app' } | { role: 'superuser'; scope: { tenantId: string; businessId: string } };

/** A raw reparent of a variant as `daftar_app` under the business scope (or as the superuser under `scope`). */
function reparent(q: Queryable, variantId: string, toProductId: string, as: Reparenter = { role: 'daftar_app' }) {
  return attempt(q, async () => {
    if (as.role === 'daftar_app') {
      await setScope(q, biz);
      await q.query('SET LOCAL ROLE daftar_app');
    } else {
      await setScope(q, as.scope);
    }
    const r = await q.query(`UPDATE product_variants SET product_id = $2 WHERE id = $1`, [variantId, toProductId]);
    await q.query('RESET ROLE');
    return r.rowCount;
  });
}

async function productOf(q: Queryable, variantId: string): Promise<string> {
  return must((await q.query<{ p: string }>(`SELECT product_id::text AS p FROM product_variants WHERE id = $1`, [variantId])).rows[0]).p;
}

/** Two tracked products of the business (committed): `from` with two merchant variants, `to` with one. */
async function twoVariantProducts(): Promise<{ from: string; to: string; v1: string; v2: string }> {
  const a = await addVariantProduct(ownerPool(), biz, 2);
  const b = await addVariantProduct(ownerPool(), biz, 1);
  return { from: a.productId, to: b.productId, v1: must(a.variantIds[0]), v2: must(a.variantIds[1]) };
}

const R7 = 'products_20_unit_history_lock()';
const R9 = 'product_variants_20_stock_identity_lock()';
const CONFIGURE = 'inventory_configure_product(uuid,boolean,text,smallint)';

/** A raw unit change of the product, as whoever the caller has made the session. */
function rawUnitChange(q: Queryable, productId: string, set = `unit_code = 'kg'`) {
  return attempt(q, () => q.query(`UPDATE products SET ${set} WHERE id = $1`, [productId]));
}

describe('T-17 — the unit-history lock (P:169)', () => {
  it('T-17.1 (row 2): a tracked product with no movement may change its unit through the command', async () => {
    const p = await freshProduct();
    await withRolledBackFixture(async (c) => {
      const r = expectAccepted(await tryConfigure(c, biz, call(p.productId, true, 'kg')), 'row 2');
      expect(r.unit_code).toBe('kg');
      expect(await unitOf(c, p.productId)).toEqual({ track: true, unit: 'kg', decimals: r.unit_decimals });
    });
  });

  it('T-17.2 (row 3): after the first movement the command’s unit change → inventory.unit_identity_locked, and the unit is unchanged', async () => {
    const p = await freshProduct();
    await withRolledBackFixture(async (c) => {
      await applyOne(c, biz, req(p.key, 'purchase', '1', { unitCost: '1' }));
      expectRefused(await tryConfigure(c, biz, call(p.productId, true, 'kg')), 'P0001', 'inventory.unit_identity_locked', 'row 3');
      expect(await unitOf(c, p.productId)).toEqual({ track: true, unit: 'piece', decimals: 0 });
      // The same command that changes nothing about the unit is still fine.
      expectAccepted(await tryConfigure(c, biz, call(p.productId, true, null)), 'no unit change');
    });
  });

  it('T-17.N: with guard 2 dropped in-transaction, the T-17.2 change is allowed', async () => {
    const p = await freshProduct();
    await withRolledBackFixture(async (c) => {
      await applyOne(c, biz, req(p.key, 'purchase', '1', { unitCost: '1' }));
      await scratch(c, async () => {
        await c.query(`DROP TRIGGER products_20_unit_history_lock ON products`);
        const r = expectAccepted(await tryConfigure(c, biz, call(p.productId, true, 'kg')), 'guard 2 gone');
        expect(r.unit_code).toBe('kg');
      });
    });
  });

  it('T-17.3 (A-12): the raw UPDATE as daftar_app is refused by guard 1 first → inventory.configuration_authority_required', async () => {
    const p = await freshProduct();
    await withRolledBackFixture(async (c) => {
      await applyOne(c, biz, req(p.key, 'purchase', '1', { unitCost: '1' }));
      const o = await attempt(c, async () => {
        await setScope(c, biz);
        await c.query('SET LOCAL ROLE daftar_app');
        return c.query(`UPDATE products SET unit_code = 'kg' WHERE id = $1`, [p.productId]);
      });
      expectRefused(o, 'P0001', 'inventory.configuration_authority_required');
    });
  });

  it('T-17.4 (A-12): the raw UPDATE executed AS the internal role (the one principal guard 1 admits), in scope → inventory.unit_identity_locked', async () => {
    const p = await freshProduct();
    await withRolledBackFixture(async (c) => {
      await applyOne(c, biz, req(p.key, 'purchase', '1', { unitCost: '1' }));
      const asInternal = (set: string) =>
        attempt(c, async () => {
          await setScope(c, biz);
          await c.query(`SET LOCAL ROLE ${INTERNAL}`);
          return c.query(`UPDATE products SET ${set} WHERE id = $1`, [p.productId]);
        });
      expectRefused(await asInternal(`unit_code = 'kg'`), 'P0001', 'inventory.unit_identity_locked', 'unit_code');
      expectRefused(await asInternal(`unit_decimals = 2`), 'P0001', 'inventory.unit_identity_locked', 'unit_decimals');
      // Guard 2 is the refusal: the same principal may still change what it does not guard.
      expectAccepted(await asInternal(`track_inventory = true`), 'tracking unchanged');
    });
  });

  it('T-17.5 (A-12, A-18): with guard 1 dropped, the superuser unscoped or in another business’s scope → inventory.scope_mismatch; in the product’s scope → inventory.unit_identity_locked', async () => {
    const p = await freshProduct();
    await withRolledBackFixture(async (c) => {
      await applyOne(c, biz, req(p.key, 'purchase', '1', { unitCost: '1' }));
      await scratch(c, async () => {
        await c.query(`DROP TRIGGER products_10_inventory_config_authority ON products`);
        await setScope(c, { tenantId: '', businessId: '' });
        expectRefused(await rawUnitChange(c, p.productId), 'P0001', 'inventory.scope_mismatch', 'unscoped');
        await setScope(c, { tenantId: biz.other.tenantId, businessId: biz.other.businessId });
        expectRefused(await rawUnitChange(c, p.productId), 'P0001', 'inventory.scope_mismatch', 'other business');
        await setScope(c, { tenantId: biz.other.tenantId, businessId: biz.businessId });
        expectRefused(await rawUnitChange(c, p.productId), 'P0001', 'inventory.scope_mismatch', 'split scope');
        await setScope(c, biz);
        expectRefused(await rawUnitChange(c, p.productId), 'P0001', 'inventory.unit_identity_locked', 'product scope');
      });
    });
  });

  // A-18: the history read joins product_variants, whose policies stay scope-bound, so an
  // out-of-scope writer's history check would see NO variant. The scope refusal is what
  // closes that blind spot — removing it lets the unscoped superuser rewrite a unit with history.
  it('T-17.5 control (A-18): without the scope refusal, the unscoped superuser’s unit change is ACCEPTED despite history — the refusal is what closes the RLS blind spot', async () => {
    const p = await freshProduct();
    await withRolledBackFixture(async (c) => {
      await applyOne(c, biz, req(p.key, 'purchase', '1', { unitCost: '1' }));
      await scratch(c, async () => {
        await c.query(`DROP TRIGGER products_10_inventory_config_authority ON products`);
        await withoutRefusal(c, 'products_20_unit_history_lock()', 'inventory.scope_mismatch');
        await setScope(c, { tenantId: '', businessId: '' });
        expectAccepted(await rawUnitChange(c, p.productId), 'unscoped, history hidden from the variant join');
        expect((await unitOf(c, p.productId)).unit).toBe('kg');
      });
    });
  });

  it('T-17.6 (rows 4 and 5): the decimals change with history is locked, and stays locked after the stock returns to zero', async () => {
    const p = await freshProduct();
    await withRolledBackFixture(async (c) => {
      await applyOne(c, biz, req(p.key, 'purchase', '2', { unitCost: '1' }));
      expectRefused(await tryConfigure(c, biz, call(p.productId, true, 'piece', 2)), 'P0001', 'inventory.unit_identity_locked', 'row 4');
      await applyOne(c, biz, req(p.key, 'damage', '-2', { reason: 'back to zero' }));
      expect(await unitOf(c, p.productId)).toEqual({ track: true, unit: 'piece', decimals: 0 });
      expectRefused(await tryConfigure(c, biz, call(p.productId, true, 'kg')), 'P0001', 'inventory.unit_identity_locked', 'row 5 unit');
      expectRefused(await tryConfigure(c, biz, call(p.productId, true, 'piece', 1)), 'P0001', 'inventory.unit_identity_locked', 'row 5 decimals');
    });
  });

  it('T-17.7 (row 6): disable at zero, re-enable with a NULL unit → the historical unit is unchanged; re-enable with another unit → locked', async () => {
    const p = await freshProduct();
    await withRolledBackFixture(async (c) => {
      await applyOne(c, biz, req(p.key, 'purchase', '2', { unitCost: '1' }));
      await applyOne(c, biz, req(p.key, 'damage', '-2', { reason: 'empty' }));
      expectAccepted(await tryConfigure(c, biz, call(p.productId, false, null)), 'disable at zero');
      expect(await unitOf(c, p.productId)).toEqual({ track: false, unit: 'piece', decimals: 0 });
      expectRefused(await tryConfigure(c, biz, call(p.productId, true, 'kg')), 'P0001', 'inventory.unit_identity_locked', 're-enable with another unit');
      const r = expectAccepted(await tryConfigure(c, biz, call(p.productId, true, null)), 're-enable, NULL unit');
      expect({ unit: r.unit_code, decimals: r.unit_decimals }).toEqual({ unit: 'piece', decimals: 0 });
    });
  });

  it('T-17.7 (P3-AL-41): disabling a product that holds stock → inventory.tracking_disable_requires_zero_stock; control: without the rule it is accepted', async () => {
    const p = await freshProduct();
    await withRolledBackFixture(async (c) => {
      await applyOne(c, biz, req(p.key, 'purchase', '2', { unitCost: '1' }));
      expectRefused(await tryConfigure(c, biz, call(p.productId, false, null)), 'P0001', 'inventory.tracking_disable_requires_zero_stock');
      // Stock in ANY warehouse counts.
      await applyOne(c, biz, req(p.key, 'transfer_out', '-2'));
      await applyOne(c, biz, req({ warehouseId: biz.warehouse2, variantId: p.variantId }, 'purchase', '1', { unitCost: '1' }));
      expectRefused(await tryConfigure(c, biz, call(p.productId, false, null)), 'P0001', 'inventory.tracking_disable_requires_zero_stock', 'other warehouse');
      await scratch(c, async () => {
        await withoutRefusal(c, 'inventory_configure_product(uuid,boolean,text,smallint)', 'inventory.tracking_disable_requires_zero_stock');
        expectAccepted(await tryConfigure(c, biz, call(p.productId, false, null)), 'rule removed');
      });
    });
  });

  it('T-17.8 (row 8): the owner changing units.default_decimals leaves every product’s persisted unit_decimals unchanged', async () => {
    const p = await freshProduct();
    await withRolledBackFixture(async (c) => {
      await applyOne(c, biz, req(p.key, 'purchase', '1', { unitCost: '1' }));
      const before = await c.query<{ id: string; d: number | null }>(`SELECT id::text, unit_decimals AS d FROM products WHERE business_id = $1 ORDER BY id`, [
        biz.businessId,
      ]);
      const r = await c.query(`UPDATE units SET default_decimals = 3 WHERE unit_code = 'piece'`);
      expect(r.rowCount).toBe(1);
      const after = await c.query<{ id: string; d: number | null }>(`SELECT id::text, unit_decimals AS d FROM products WHERE business_id = $1 ORDER BY id`, [
        biz.businessId,
      ]);
      expect(after.rows).toEqual(before.rows);
      expect(await unitOf(c, p.productId)).toEqual({ track: true, unit: 'piece', decimals: 0 });
    });
  });

  it('T-17.9 (row 7): the free products.unit label changes with history — guard 2 does not fire (its WHEN clause)', async () => {
    const p = await freshProduct();
    await withRolledBackFixture(async (c) => {
      await applyOne(c, biz, req(p.key, 'purchase', '1', { unitCost: '1' }));
      const o = await attempt(c, async () => {
        await setScope(c, biz);
        await c.query('SET LOCAL ROLE daftar_app');
        const r = await c.query(`UPDATE products SET unit = 'box of 12' WHERE id = $1`, [p.productId]);
        await c.query('RESET ROLE');
        return r.rowCount;
      });
      expect(expectAccepted(o, 'label')).toBe(1);
    });
  });

  it('T-17.10: pg_trigger shows products_20_unit_history_lock by name — BEFORE UPDATE row, its WHEN clause, internal DEFINER, enabled — ordered after products_10_inventory_config_authority', async () => {
    const r = await ownerPool().query<{ name: string; type: number; enabled: string; def: string; owner: string; secdef: boolean }>(
      `SELECT g.tgname::text AS name, g.tgtype::int AS type, g.tgenabled::text AS enabled, pg_get_triggerdef(g.oid) AS def, r.rolname::text AS owner, p.prosecdef AS secdef
         FROM pg_trigger g JOIN pg_proc p ON p.oid = g.tgfoid JOIN pg_roles r ON r.oid = p.proowner
        WHERE g.tgrelid = 'products'::regclass AND NOT g.tgisinternal AND (g.tgtype & 2) = 2 AND (g.tgtype & 16) = 16
        ORDER BY g.tgname`,
    );
    const names = r.rows.map((x) => x.name);
    const lock = must(r.rows.find((x) => x.name === 'products_20_unit_history_lock'));
    expect({ type: lock.type, enabled: lock.enabled, owner: lock.owner, secdef: lock.secdef }).toEqual({
      type: 1 + 2 + 16,
      enabled: 'O',
      owner: INTERNAL,
      secdef: true,
    });
    expect(lock.def).toBe(
      'CREATE TRIGGER products_20_unit_history_lock BEFORE UPDATE ON public.products FOR EACH ROW ' +
        'WHEN (((old.unit_code IS DISTINCT FROM new.unit_code) OR (old.unit_decimals IS DISTINCT FROM new.unit_decimals))) ' +
        'EXECUTE FUNCTION products_20_unit_history_lock()',
    );
    expect(names.indexOf('products_10_inventory_config_authority')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('products_20_unit_history_lock')).toBeGreaterThan(names.indexOf('products_10_inventory_config_authority'));
  });
});

describe('H-1 — a stocked variant keeps its product (product_variants_20_stock_identity_lock, R9)', () => {
  it('R9.1 ALLOW: a merchant variant with no stock key moves to another product of the business (daftar_app, raw UPDATE)', async () => {
    const t = await twoVariantProducts();
    await withRolledBackFixture(async (c) => {
      expect(expectAccepted(await reparent(c, t.v1, t.to), 'no stock key')).toBe(1);
      expect(await productOf(c, t.v1)).toBe(t.to);
    });
  });

  it('R9.2 DENY: once the variant has a stock key the same UPDATE → inventory.variant_stock_identity_locked — also back at zero, and for a key in another warehouse; an unstocked sibling still moves', async () => {
    const t = await twoVariantProducts();
    await withRolledBackFixture(async (c) => {
      const k1 = { warehouseId: biz.warehouse1, variantId: t.v1 };
      await applyOne(c, biz, req(k1, 'purchase', '2', { unitCost: '1' }));
      expectRefused(await reparent(c, t.v1, t.to), 'P0001', 'inventory.variant_stock_identity_locked', 'stocked');
      await applyOne(c, biz, req(k1, 'damage', '-2', { reason: 'back to zero' }));
      expectRefused(await reparent(c, t.v1, t.to), 'P0001', 'inventory.variant_stock_identity_locked', 'key at zero');
      expect(await productOf(c, t.v1)).toBe(t.from);
      await applyOne(c, biz, req({ warehouseId: biz.warehouse2, variantId: t.v2 }, 'purchase', '1', { unitCost: '1' }));
      expectRefused(await reparent(c, t.v2, t.to), 'P0001', 'inventory.variant_stock_identity_locked', 'key in warehouse 2');
    });
    const u = await twoVariantProducts();
    await withRolledBackFixture(async (c) => {
      await applyOne(c, biz, req({ warehouseId: biz.warehouse1, variantId: u.v1 }, 'purchase', '1', { unitCost: '1' }));
      expect(expectAccepted(await reparent(c, u.v2, u.to), 'the unstocked sibling')).toBe(1);
    });
  });

  it('R9.N: with product_variants_20_stock_identity_lock dropped in-transaction, the stocked variant moves — its stock history now belongs to another product', async () => {
    const t = await twoVariantProducts();
    await withRolledBackFixture(async (c) => {
      await applyOne(c, biz, req({ warehouseId: biz.warehouse1, variantId: t.v1 }, 'purchase', '2', { unitCost: '1' }));
      await scratch(c, async () => {
        await c.query(`DROP TRIGGER product_variants_20_stock_identity_lock ON product_variants`);
        expect(expectAccepted(await reparent(c, t.v1, t.to), 'lock gone')).toBe(1);
        expect(await productOf(c, t.v1)).toBe(t.to);
      });
    });
  });

  it('R9.3: the superuser unscoped, in another business’s scope or with a split scope → inventory.scope_mismatch; in the variant’s own scope → inventory.variant_stock_identity_locked', async () => {
    const t = await twoVariantProducts();
    await withRolledBackFixture(async (c) => {
      await applyOne(c, biz, req({ warehouseId: biz.warehouse1, variantId: t.v1 }, 'purchase', '1', { unitCost: '1' }));
      const as = (scope: { tenantId: string; businessId: string }) => reparent(c, t.v1, t.to, { role: 'superuser', scope });
      expectRefused(await as({ tenantId: '', businessId: '' }), 'P0001', 'inventory.scope_mismatch', 'unscoped');
      expectRefused(await as({ tenantId: biz.other.tenantId, businessId: biz.other.businessId }), 'P0001', 'inventory.scope_mismatch', 'other business');
      expectRefused(await as({ tenantId: biz.other.tenantId, businessId: biz.businessId }), 'P0001', 'inventory.scope_mismatch', 'split scope');
      expectRefused(await as(biz), 'P0001', 'inventory.variant_stock_identity_locked', 'own scope');
    });
  });

  it('R9.4 (WHEN): other columns of a stocked variant still change, and SET product_id = product_id does not fire the lock', async () => {
    const t = await twoVariantProducts();
    await withRolledBackFixture(async (c) => {
      await applyOne(c, biz, req({ warehouseId: biz.warehouse1, variantId: t.v1 }, 'purchase', '1', { unitCost: '1' }));
      const o = await attempt(c, async () => {
        await setScope(c, biz);
        await c.query('SET LOCAL ROLE daftar_app');
        const a = await c.query(`UPDATE product_variants SET sku = $2 WHERE id = $1`, [t.v1, `SKU-R94-${t.v1.slice(0, 8)}`]);
        const b = await c.query(`UPDATE product_variants SET product_id = product_id WHERE id = $1`, [t.v1]);
        await c.query('RESET ROLE');
        return [a.rowCount, b.rowCount];
      });
      expect(expectAccepted(o, 'not a reparent')).toEqual([1, 1]);
    });
  });

  it('R9.5: pg_trigger shows product_variants_20_stock_identity_lock — BEFORE UPDATE OF product_id row, its WHEN clause, internal DEFINER, enabled — ordered after product_variants_10_base_variant_authority', async () => {
    const r = await ownerPool().query<{ name: string; type: number; enabled: string; def: string; owner: string; secdef: boolean }>(
      `SELECT g.tgname::text AS name, g.tgtype::int AS type, g.tgenabled::text AS enabled, pg_get_triggerdef(g.oid) AS def, r.rolname::text AS owner, p.prosecdef AS secdef
         FROM pg_trigger g JOIN pg_proc p ON p.oid = g.tgfoid JOIN pg_roles r ON r.oid = p.proowner
        WHERE g.tgrelid = 'product_variants'::regclass AND NOT g.tgisinternal AND (g.tgtype & 2) = 2 AND (g.tgtype & 16) = 16
        ORDER BY g.tgname`,
    );
    const names = r.rows.map((x) => x.name);
    const lock = must(r.rows.find((x) => x.name === 'product_variants_20_stock_identity_lock'));
    expect({ type: lock.type, enabled: lock.enabled, owner: lock.owner, secdef: lock.secdef }).toEqual({
      type: 1 + 2 + 16,
      enabled: 'O',
      owner: INTERNAL,
      secdef: true,
    });
    expect(lock.def).toBe(
      'CREATE TRIGGER product_variants_20_stock_identity_lock BEFORE UPDATE OF product_id ON public.product_variants FOR EACH ROW ' +
        'WHEN ((old.product_id IS DISTINCT FROM new.product_id)) EXECUTE FUNCTION product_variants_20_stock_identity_lock()',
    );
    expect(names.indexOf('product_variants_10_base_variant_authority')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('product_variants_20_stock_identity_lock')).toBeGreaterThan(names.indexOf('product_variants_10_base_variant_authority'));
  });
});

describe('M-1 — the configure command, R7 and R9 run only at READ COMMITTED (inventory.isolation_unsupported)', () => {
  for (const isolation of ['REPEATABLE READ', 'SERIALIZABLE'] as const) {
    it(`M-1.1: inventory_configure_product under ${isolation} → inventory.isolation_unsupported, the product unchanged`, async () => {
      const p = await freshProduct();
      await withRolledBackFixture(
        async (c) => {
          expectRefused(await tryConfigure(c, biz, call(p.productId, true, null)), 'P0001', 'inventory.isolation_unsupported', 'no unit change');
          expectRefused(await tryConfigure(c, biz, call(p.productId, false, null)), 'P0001', 'inventory.isolation_unsupported', 'disable');
          expect(await unitOf(c, p.productId)).toEqual({ track: true, unit: 'piece', decimals: 0 });
        },
        { isolation },
      );
    });
  }

  it('M-1.1.N: under REPEATABLE READ with the configure command’s isolation refusal removed, the same call is accepted', async () => {
    const p = await freshProduct();
    await withRolledBackFixture(
      async (c) => {
        await withoutRefusal(c, CONFIGURE, 'inventory.isolation_unsupported');
        expectAccepted(await tryConfigure(c, biz, call(p.productId, false, null)), 'refusal removed');
        expect((await unitOf(c, p.productId)).track).toBe(false);
      },
      { isolation: 'REPEATABLE READ' },
    );
  });

  it('M-1.2: R7 — the raw unit change as the internal role, in scope, on a product WITHOUT history, under REPEATABLE READ → inventory.isolation_unsupported; control: without that refusal it is accepted', async () => {
    const p = await freshProduct();
    await withRolledBackFixture(
      async (c) => {
        const asInternal = () =>
          attempt(c, async () => {
            await setScope(c, biz);
            await c.query(`SET LOCAL ROLE ${INTERNAL}`);
            const r = await c.query(`UPDATE products SET unit_code = 'kg' WHERE id = $1`, [p.productId]);
            await c.query('RESET ROLE');
            return r.rowCount;
          });
        expectRefused(await asInternal(), 'P0001', 'inventory.isolation_unsupported', 'R7 under RR');
        await scratch(c, async () => {
          await withoutRefusal(c, R7, 'inventory.isolation_unsupported');
          expect(expectAccepted(await asInternal(), 'R7 refusal removed')).toBe(1);
        });
      },
      { isolation: 'REPEATABLE READ' },
    );
  });

  it('M-1.3: R9 — reparenting an UNSTOCKED variant as daftar_app under REPEATABLE READ → inventory.isolation_unsupported; control: without that refusal it is accepted', async () => {
    const t = await twoVariantProducts();
    await withRolledBackFixture(
      async (c) => {
        expectRefused(await reparent(c, t.v1, t.to), 'P0001', 'inventory.isolation_unsupported', 'R9 under RR');
        await scratch(c, async () => {
          await withoutRefusal(c, R9, 'inventory.isolation_unsupported');
          expect(expectAccepted(await reparent(c, t.v1, t.to), 'R9 refusal removed')).toBe(1);
        });
      },
      { isolation: 'REPEATABLE READ' },
    );
  });
});
