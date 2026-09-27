/**
 * P3-S7 T-04 — THE LIVE STOCK READ (docs PHASE_3_S7_CONTRACT A-07, §6 T-04;
 * L:1256-1263, P3-AL-42, P3-AL-52).
 *
 * `GET /v1/inventory/stock?warehouseId=` through the real application:
 *   - a key without a `stock_levels` row reads zero;
 *   - a simple product is one `variantId: null` row; merchant variants are
 *     one row each, and the base variant never appears as a variant, nor
 *     does its id appear anywhere in the answer;
 *   - pre-variant stock on the base variant (non-zero) is one extra
 *     `variantId: null` row; at zero it is absent;
 *   - `status=negative` returns the stock short of zero (a seeded deficit);
 *   - keyset paging walks every row exactly once, and stays stable when a
 *     product is inserted mid-walk;
 *   - scope: the manager assigned to branch Y reaches W2 (home) and W3
 *     (`branch_warehouses`), and W1 is 403 `inventory.warehouse_out_of_scope`;
 *   - the row carries no value, average or stock sequence key.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { must } from '../helpers/inventory-commands';
import { coverageVector, installCommittedDeficitFixture, removeCommittedDeficitFixture, seedCommittedDeficitKey } from '../helpers/purchase-deficits';
import { addTrackedProduct } from '../helpers/stock-ledger';
import { nameProduct, ok, readAs, seedReadsWorld, type ReadsWorld } from '../helpers/merchant-reads';
import { expectRefusal } from '../helpers/supplier-settlement';

interface Row {
  productId: string;
  variantId: string | null;
  name: string;
  variantName: string | null;
  unitCode: string;
  unitDecimals: number;
  onHand: string;
}
interface StockPage {
  items: Row[];
  nextCursor: string | null;
}

let t: TestApp;
let w: ReadsWorld;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  await installCommittedDeficitFixture();
  t = await createTestApp();
  w = await seedReadsWorld(t, 'stock');
  await seedCommittedDeficitKey(w.A, w.A.w2, w.A.piece.variantId, must(coverageVector('GOLD54').seed[0]));
});

afterAll(async () => {
  await t.close();
  await removeCommittedDeficitFixture();
  await resetData();
});

const stock = (query: string, by = w.owner, locale = 'en'): Promise<StockPage> =>
  ok<StockPage>(readAs(t, by, w.A.businessId, `/v1/inventory/stock?${query}`, locale));

/** Every row of a warehouse, walking the pages. */
async function walk(warehouseId: string, limit: number, from: string | null = null): Promise<Row[]> {
  const out: Row[] = [];
  let cursor = from;
  for (let i = 0; i < 100; i += 1) {
    const page: StockPage = await stock(`warehouseId=${warehouseId}&limit=${limit}${cursor === null ? '' : `&cursor=${cursor}`}`);
    out.push(...page.items);
    if (page.nextCursor === null) return out;
    cursor = page.nextCursor;
  }
  throw new Error('the walk did not end');
}

const key = (r: Row): string => `${r.productId}|${r.variantId ?? 'null'}`;

describe('T-04 the stock read', () => {
  it('reads every tracked, active product of the warehouse with its live quantity; the base variant never appears', async () => {
    const rows = (await stock(`warehouseId=${w.A.w1}&limit=50`)).items;
    const byKey = new Map(rows.map((r) => [key(r), r]));
    const A = w.A;
    expect(byKey.get(`${A.piece.productId}|null`)).toEqual({
      productId: A.piece.productId,
      variantId: null,
      name: 'Apple',
      variantName: null,
      unitCode: 'piece',
      unitDecimals: 0,
      onHand: '4',
    });
    expect(byKey.get(`${A.dec2.productId}|null`), 'the ar fallback name, at the unit decimals').toMatchObject({ name: 'سلك', onHand: '1.50', unitDecimals: 2 });
    expect(byKey.get(`${A.piece2.productId}|null`)?.onHand).toBe('2');
    for (const [i, size] of [
      [0, 'L'],
      [1, 'M'],
    ] as const) {
      expect(byKey.get(`${A.variantProduct.productId}|${A.variantProduct.variantIds[i]}`), `merchant variant ${size}`).toMatchObject({
        name: 'Shirt',
        variantName: size,
        onHand: '0',
      });
    }
    expect(byKey.has(`${A.variantProduct.productId}|null`), 'a variant product has no null row').toBe(false);
    expect(byKey.get(`${w.mixed.productId}|null`), 'pre-variant base stock is a real quantity').toMatchObject({
      name: 'Mixed',
      variantName: null,
      onHand: '3',
    });
    expect(byKey.get(`${w.mixed.productId}|${w.mixed.merchantVariantId}`)).toMatchObject({ variantName: 'Red', onHand: '0' });
    expect(byKey.has(`${A.untracked.productId}|null`), 'an untracked product is not stock').toBe(false);
    expect(rows).toHaveLength(7);
    const text = JSON.stringify(rows);
    for (const base of [A.piece.variantId, A.piece2.variantId, A.dec2.variantId, w.mixed.baseVariantId]) {
      expect(text.includes(base), 'no base variant id anywhere in the answer').toBe(false);
    }
    for (const r of rows)
      expect(Object.keys(r).sort(), 'no value, average or stock sequence').toEqual(Object.keys(byKey.get(`${A.piece.productId}|null`) ?? {}).sort());
  });

  it('a key with no stock_levels row reads zero; zero pre-variant stock is not a row', async () => {
    const none = await ownerPool().query('SELECT 1 FROM stock_levels WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3', [
      w.A.businessId,
      w.w3,
      w.A.dec2.variantId,
    ]);
    expect(none.rowCount, 'no stock_levels row for (W3, dec2)').toBe(0);
    const rows = (await stock(`warehouseId=${w.w3}&limit=50`)).items;
    expect(rows.find((r) => r.productId === w.A.dec2.productId)).toMatchObject({ variantId: null, onHand: '0.00' });
    expect(rows.find((r) => r.productId === w.A.piece.productId)?.onHand, 'the part-paid receipt of 10').toBe('10');
    expect(
      rows.filter((r) => r.productId === w.mixed.productId).map((r) => r.variantId),
      'the mixed product in W3: its merchant variant only',
    ).toEqual([w.mixed.merchantVariantId]);
  });

  it('status filters: in_stock, out_of_stock and negative (a deficit, stock short of zero)', async () => {
    const negative = (await stock(`warehouseId=${w.A.w2}&status=negative`)).items;
    expect(negative).toEqual([expect.objectContaining({ productId: w.A.piece.productId, variantId: null, onHand: '-5' })]);
    const inStock = (await stock(`warehouseId=${w.A.w2}&status=in_stock`)).items;
    expect(inStock.map((r) => [r.productId, r.onHand])).toEqual([[w.A.piece2.productId, '3']]);
    const out = (await stock(`warehouseId=${w.A.w2}&status=out_of_stock&limit=50`)).items;
    expect(out.every((r) => /^0(\.0+)?$/.test(r.onHand))).toBe(true);
    expect(out.length + inStock.length + negative.length).toBe((await stock(`warehouseId=${w.A.w2}&limit=50`)).items.length);
  });

  it('search: a substring of the resolved name, or an exact SKU of a merchant variant; never the base variant', async () => {
    const byName = (await stock(`warehouseId=${w.A.w1}&search=shir`)).items;
    expect(byName.map((r) => r.variantName)).toEqual(['L', 'M']);
    const sku = must(
      (await ownerPool().query<{ sku: string }>('SELECT sku FROM product_variants WHERE id = $1', [w.A.variantProduct.variantIds[1]])).rows[0],
    ).sku;
    expect((await stock(`warehouseId=${w.A.w1}&search=${encodeURIComponent(sku.toLowerCase())}`)).items.map((r) => r.variantId)).toEqual([
      w.A.variantProduct.variantIds[1],
    ]);
    expect((await stock(`warehouseId=${w.A.w1}&search=%25`)).items, 'a % is a literal').toEqual([]);
  });

  it('keyset paging walks every row once, and a product inserted mid-walk neither repeats nor skips a row', async () => {
    const all = (await stock(`warehouseId=${w.A.w1}&limit=50`)).items;
    expect((await walk(w.A.w1, 2)).map(key)).toEqual(all.map(key));
    const first = await stock(`warehouseId=${w.A.w1}&limit=3`);
    // Two products appear mid-walk: one sorting before the cursor, one after it.
    for (const name of ['AAA before', 'zzz after']) {
      const p = await addTrackedProduct(ownerPool(), w.A, 'piece', 0);
      await nameProduct(w.A.businessId, p.productId, { en: name });
    }
    const rest = await walk(w.A.w1, 2, must(first.nextCursor));
    const seen = [...first.items, ...rest].map((r) => r.name);
    expect(
      seen.filter((n) => n === 'AAA before'),
      'a row inserted before the cursor is not repeated or shown',
    ).toEqual([]);
    expect(
      seen.filter((n) => n === 'zzz after'),
      'a row inserted after the cursor is reached',
    ).toEqual(['zzz after']);
    const walked = [...first.items, ...rest].filter((r) => r.name !== 'zzz after').map(key);
    expect(walked, 'every original row exactly once, in order').toEqual(all.map(key));
  });

  it('scope: the manager assigned to Y reads W2 and W3, and is refused W1', async () => {
    expect((await stock(`warehouseId=${w.A.w2}&limit=50`, w.manager)).items.length).toBeGreaterThan(0);
    expect((await stock(`warehouseId=${w.w3}&limit=50`, w.manager)).items.length).toBeGreaterThan(0);
    const refused = await readAs(t, w.manager, w.A.businessId, `/v1/inventory/stock?warehouseId=${w.A.w1}`);
    expectRefusal(refused, 403, 'inventory.warehouse_out_of_scope');
    const foreign = await readAs(t, w.owner, w.A.businessId, `/v1/inventory/stock?warehouseId=${w.A2.w1}`);
    expectRefusal(foreign, 404, 'inventory.warehouse_not_found', "another business's warehouse is not this business's");
  });

  it('a bad query is VALIDATION_FAILED: no warehouse, a limit above 50, an unknown key, a forged cursor', async () => {
    for (const q of [
      '',
      `warehouseId=${w.A.w1}&limit=51`,
      `warehouseId=${w.A.w1}&offset=2`,
      `warehouseId=${w.A.w1}&cursor=nope`,
      `warehouseId=${w.A.w1}&status=deficit`,
    ]) {
      const r = await readAs(t, w.owner, w.A.businessId, `/v1/inventory/stock?${q}`);
      expect({ q, status: r.status, code: (r.body as { error: { code: string } }).error.code }).toEqual({ q, status: 400, code: 'VALIDATION_FAILED' });
    }
  });
});
