/**
 * P3-S7 T-13 — THE ITEM AND UNIT PICKERS (docs PHASE_3_S7_CONTRACT A-06, §6
 * T-13; P3-AL-52).
 *
 * `GET /v1/inventory/items` and `GET /v1/inventory/units` through the real
 * application:
 *   - the base variant is never in `variants`, and its id never appears;
 *   - `search` matches a name substring or an exact SKU of the product or of
 *     a merchant variant, and never the base variant (whose SKU is null by
 *     constraint: the literal text `null` finds nothing);
 *   - `ids=` resolves names in ar/en/tr with the `ar` fallback, archived and
 *     untracked products included; an unknown id, or another business's, is
 *     404 `inventory.product_not_found`; `ids` with `search` is 400;
 *   - `holdsStock` is false for a new product, true after its first receipt
 *     and false again once the stock is adjusted to zero;
 *   - units carry their registry decimals and the resolved name, in registry
 *     order, for any member.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { asMember } from '../helpers/inventory-commands';
import { addTrackedProduct } from '../helpers/stock-ledger';
import { expectRefusal } from '../helpers/supplier-settlement';
import { httpAdjust, nameProduct, ok, readAs, receive, seedReadsWorld, type ReadsWorld } from '../helpers/merchant-reads';

interface Variant {
  variantId: string;
  name: string;
  status: string;
}
interface Item {
  productId: string;
  name: string;
  status: string;
  trackInventory: boolean;
  unitCode: string | null;
  unitDecimals: number | null;
  holdsStock: boolean;
  variants: Variant[];
}
interface ItemPage {
  items: Item[];
  nextCursor: string | null;
}
interface Unit {
  unitCode: string;
  name: string;
  defaultDecimals: number;
}

let t: TestApp;
let w: ReadsWorld;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  t = await createTestApp();
  w = await seedReadsWorld(t, 'items');
});

afterAll(async () => {
  await t.close();
  await resetData();
});

const items = (query: string, locale = 'en', by = w.owner): Promise<ItemPage> =>
  ok<ItemPage>(readAs(t, by, w.A.businessId, `/v1/inventory/items${query === '' ? '' : `?${query}`}`, locale));

describe('T-13 items', () => {
  it('lists the tracked, active products by name; the base variant is never a variant', async () => {
    const page = await items('limit=50');
    const A = w.A;
    expect(page.items.map((i) => i.name)).toEqual(['Apple', 'Banana', 'Mixed', 'Shirt', 'سلك']);
    const byId = new Map(page.items.map((i) => [i.productId, i]));
    expect(byId.get(A.piece.productId)).toEqual({
      productId: A.piece.productId,
      name: 'Apple',
      status: 'active',
      trackInventory: true,
      unitCode: 'piece',
      unitDecimals: 0,
      holdsStock: true,
      variants: [],
    });
    expect(byId.get(A.dec2.productId)).toMatchObject({ unitDecimals: 2, variants: [] });
    expect(byId.get(A.variantProduct.productId)?.variants).toEqual([
      { variantId: A.variantProduct.variantIds[0], name: 'L', status: 'active' },
      { variantId: A.variantProduct.variantIds[1], name: 'M', status: 'active' },
    ]);
    expect(byId.get(w.mixed.productId)?.variants, 'the mixed product lists its merchant variant only').toEqual([
      { variantId: w.mixed.merchantVariantId, name: 'Red', status: 'active' },
    ]);
    const text = JSON.stringify(page);
    for (const base of [A.piece.variantId, A.piece2.variantId, A.dec2.variantId, w.mixed.baseVariantId]) {
      expect(text.includes(base), 'no base variant id anywhere').toBe(false);
    }
    const all = await items('limit=50&trackedOnly=false');
    expect(
      all.items.find((i) => i.productId === A.untracked.productId),
      'trackedOnly=false adds the untracked product',
    ).toMatchObject({ name: 'Gift card', trackInventory: false });
  });

  it('keyset pages walk the list once', async () => {
    const whole = (await items('limit=50&trackedOnly=false')).items.map((i) => i.productId);
    const walked: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i += 1) {
      const page: ItemPage = await items(`limit=2&trackedOnly=false${cursor === null ? '' : `&cursor=${cursor}`}`);
      walked.push(...page.items.map((x) => x.productId));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    expect(walked).toEqual(whole);
  });

  it('search: a name substring, the product SKU, a merchant variant SKU; never the base variant', async () => {
    expect((await items('search=an')).items.map((i) => i.name)).toEqual(['Banana']);
    await ownerPool().query("UPDATE products SET sku = 'APL-001' WHERE business_id = $1 AND id = $2", [w.A.businessId, w.A.piece.productId]);
    expect((await items('search=apl-001')).items.map((i) => i.productId)).toEqual([w.A.piece.productId]);
    const sku = (
      await ownerPool().query<{ sku: string }>('SELECT sku FROM product_variants WHERE business_id = $1 AND id = $2', [
        w.A.businessId,
        w.A.variantProduct.variantIds[0],
      ])
    ).rows[0]?.sku;
    expect(typeof sku).toBe('string');
    expect((await items(`search=${encodeURIComponent(String(sku))}`)).items.map((i) => i.productId)).toEqual([w.A.variantProduct.productId]);
    const bases = await ownerPool().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM product_variants WHERE business_id = $1 AND is_base AND (sku IS NOT NULL OR barcode IS NOT NULL)',
      [w.A.businessId],
    );
    expect(bases.rows[0]?.n, 'a base variant has no SKU or barcode').toBe(0);
    expect((await items('search=null')).items, 'the null SKU of a base variant matches nothing').toEqual([]);
    expect((await items('search=%25')).items, 'a % is a literal').toEqual([]);
  });

  it('ids= resolves names in ar/en/tr with the ar fallback, archived and untracked products included', async () => {
    const A = w.A;
    const archived = await addTrackedProduct(ownerPool(), A, 'kg', 3);
    await nameProduct(A.businessId, archived.productId, { ar: 'مؤرشف', tr: 'Arşiv' });
    const del = await t.request.delete(`/v1/catalog/products/${archived.productId}`).set(asMember(w.owner, A.businessId));
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    const ids = [A.piece.productId, A.piece2.productId, A.dec2.productId, A.untracked.productId, archived.productId].join(',');
    const names = async (locale: string): Promise<Record<string, string>> =>
      Object.fromEntries((await items(`ids=${ids}`, locale)).items.map((i) => [i.productId, i.name]));
    expect(await names('tr')).toEqual({
      [A.piece.productId]: 'Elma',
      [A.piece2.productId]: 'موز',
      [A.dec2.productId]: 'سلك',
      [A.untracked.productId]: 'Gift card',
      [archived.productId]: 'Arşiv',
    });
    expect(await names('en')).toMatchObject({ [A.piece.productId]: 'Apple', [A.piece2.productId]: 'Banana', [archived.productId]: 'مؤرشف' });
    expect(await names('ar')).toMatchObject({ [A.piece.productId]: 'تفاح', [A.untracked.productId]: 'Gift card' });
    const page = await items(`ids=${ids}`);
    expect(page.nextCursor, 'unpaged').toBeNull();
    expect(page.items.find((i) => i.productId === archived.productId)).toMatchObject({ status: 'archived', unitCode: 'kg', unitDecimals: 3 });
    expect(
      (await items('limit=50')).items.some((i) => i.productId === archived.productId),
      'the picker lists active products only',
    ).toBe(false);
  });

  it('ids= refusals: an unknown id or another business’s is 404; ids with search, or over 200, is 400', async () => {
    const unknown = `${w.A.piece.productId},00000000-0000-4000-8000-000000000000`;
    expectRefusal(await readAs(t, w.owner, w.A.businessId, `/v1/inventory/items?ids=${unknown}`), 404, 'inventory.product_not_found');
    expectRefusal(
      await readAs(t, w.owner, w.A2.businessId, `/v1/inventory/items?ids=${w.A.piece.productId}`),
      404,
      'inventory.product_not_found',
      'read under A2',
    );
    const tooMany = Array.from({ length: 201 }, (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`).join(',');
    for (const q of [`ids=${w.A.piece.productId}&search=apple`, `ids=${tooMany}`, 'ids=not-a-uuid', 'limit=51', 'offset=1', 'search=']) {
      const r = await readAs(t, w.owner, w.A.businessId, `/v1/inventory/items?${q}`);
      expect({ q: q.slice(0, 60), status: r.status }).toEqual({ q: q.slice(0, 60), status: 400 });
    }
  });

  it('holdsStock: false when new, true after the first receipt, false again once adjusted to zero', async () => {
    const p = await addTrackedProduct(ownerPool(), w.A, 'piece', 0);
    await nameProduct(w.A.businessId, p.productId, { en: 'Quince' });
    const holds = async (): Promise<boolean | undefined> => (await items(`ids=${p.productId}`)).items[0]?.holdsStock;
    expect(await holds()).toBe(false);
    await receive(w, { warehouseId: w.A.w2, lines: [{ productId: p.productId, quantity: '2', unitPrice: '1.00' }] });
    expect(await holds()).toBe(true);
    await httpAdjust(t, w.owner, w.A, w.A.w2, [{ productId: p.productId, quantity: '-2' }]);
    expect(await holds()).toBe(false);
  });
});

describe('T-13 units', () => {
  it('every unit in registry order, with its decimals and resolved name, for any member', async () => {
    const tr = await ok<{ items: Unit[] }>(readAs(t, w.cashier, w.A.businessId, '/v1/inventory/units', 'tr'));
    expect(tr.items.map((u) => u.unitCode)).toEqual(['piece', 'kg', 'gram', 'litre', 'millilitre', 'metre', 'centimetre', 'box', 'carton', 'dozen', 'hour']);
    expect(tr.items.slice(0, 2)).toEqual([
      { unitCode: 'piece', name: 'Adet', defaultDecimals: 0 },
      { unitCode: 'kg', name: 'Kilogram', defaultDecimals: 3 },
    ]);
    const ar = await ok<{ items: Unit[] }>(readAs(t, w.owner, w.A.businessId, '/v1/inventory/units', 'ar'));
    expect(ar.items.find((u) => u.unitCode === 'metre')).toEqual({ unitCode: 'metre', name: 'متر', defaultDecimals: 2 });
    const en = await ok<{ items: Unit[] }>(readAs(t, w.owner, w.A.businessId, '/v1/inventory/units', 'en'));
    expect(en.items.find((u) => u.unitCode === 'hour')?.name).toBe('Hour');
  });
});
