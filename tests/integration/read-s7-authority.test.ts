/**
 * P3-S7 T-11 — WHO MAY READ WHAT (docs PHASE_3_S7_CONTRACT A-04, §6 T-11;
 * Annex R #4, #5, #18; P3-AL-38).
 *
 * Every S7 read, plus the S6 settlement reads the S7 screens call, through
 * the real application and its guards:
 *   - the cashier holds no Phase 3 permission: every permissioned read is
 *     403; the two any-member reads (`/access`, `/units`) answer, and
 *     `/access` says the cashier holds nothing;
 *   - the manager assigned to branch Y gets 200 on the warehouse-scoped and
 *     master reads, and 403 `inventory.business_wide_scope_required` on the
 *     business-wide ones (supplier balances, supplier payable, credit notes,
 *     payments); `payment-method-defaults` is 403 (no
 *     `accounting.chart.manage`); settlements need `suppliers.view` and the
 *     purchase's warehouse in reach;
 *   - the owner gets 200 on every read;
 *   - `GET /v1/inventory/access` returns exactly the caller's subset;
 *   - isolation: a member of A naming B in `X-Business-Id` is 403; the owner
 *     of A reading A's ids under its OTHER business A2 finds nothing.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, resetData, type TestApp } from '../helpers/test-app';
import { asMember, type HttpActor } from '../helpers/inventory-commands';
import { refusalCode } from '../helpers/supplier-settlement';
import { ok, readAs, seedReadsWorld, type ReadsWorld } from '../helpers/merchant-reads';
import { PHASE3_PERMISSIONS } from '@daftar/shared-contracts';

let t: TestApp;
let w: ReadsWorld;
let stocktakeW1: string;
let stocktakeW2: string;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  t = await createTestApp();
  w = await seedReadsWorld(t, 'auth');
  stocktakeW1 = await openStocktake(w.A.w1);
  stocktakeW2 = await openStocktake(w.A.w2);
});

afterAll(async () => {
  await t.close();
  await resetData();
});

async function openStocktake(warehouseId: string): Promise<string> {
  const stocktakeId = randomUUID();
  const r = await t.request.post('/v1/inventory/stocktakes').set(asMember(w.owner, w.A.businessId)).send({ stocktakeId, warehouseId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return stocktakeId;
}

/** The answer a role gets: a status, and for a refusal its domain code (none for a plain permission refusal). */
type Verdict = readonly [number, string?];

interface Row {
  readonly name: string;
  readonly path: () => string;
  readonly cashier: Verdict;
  readonly manager: Verdict;
}

const WIDE = 'inventory.business_wide_scope_required';

/** Every S7 read, and the S6 reads the S7 screens use (Annex R #4, #5). */
const MATRIX: readonly Row[] = [
  { name: 'access', path: () => '/v1/inventory/access', cashier: [200], manager: [200] },
  { name: 'units', path: () => '/v1/inventory/units', cashier: [200], manager: [200] },
  { name: 'warehouses', path: () => '/v1/inventory/warehouses', cashier: [403], manager: [200] },
  { name: 'items', path: () => '/v1/inventory/items', cashier: [403], manager: [200] },
  { name: 'stock (W2)', path: () => `/v1/inventory/stock?warehouseId=${w.A.w2}`, cashier: [403], manager: [200] },
  { name: 'stock (W1)', path: () => `/v1/inventory/stock?warehouseId=${w.A.w1}`, cashier: [403], manager: [403, 'inventory.warehouse_out_of_scope'] },
  { name: 'stocktakes', path: () => '/v1/inventory/stocktakes', cashier: [403], manager: [200] },
  { name: 'stocktake (W2)', path: () => `/v1/inventory/stocktakes/${stocktakeW2}`, cashier: [403], manager: [200] },
  { name: 'stocktake (W1)', path: () => `/v1/inventory/stocktakes/${stocktakeW1}`, cashier: [403], manager: [404, 'inventory.stocktake_not_found'] },
  { name: 'supplier balances', path: () => '/v1/supplier-balances', cashier: [403], manager: [403, WIDE] },
  { name: 'suppliers search', path: () => '/v1/suppliers?search=supplier', cashier: [403], manager: [200] },
  { name: 'open purchases', path: () => `/v1/suppliers/${w.supplierId}/open-purchases`, cashier: [403], manager: [200] },
  { name: 'return options (W2)', path: () => `/v1/purchases/${w.purchases.partlyReturned.purchaseId}/return-options`, cashier: [403], manager: [200] },
  {
    name: 'return options (W1)',
    path: () => `/v1/purchases/${w.purchases.received.purchaseId}/return-options`,
    cashier: [403],
    manager: [404, 'purchase.not_found'],
  },
  { name: 'payment-method defaults', path: () => '/v1/payment-method-defaults', cashier: [403], manager: [403] },
  { name: 'supplier payable', path: () => `/v1/suppliers/${w.supplierId}/payable`, cashier: [403], manager: [403, WIDE] },
  { name: 'supplier credit notes', path: () => `/v1/suppliers/${w.supplierId}/credit-notes`, cashier: [403], manager: [403, WIDE] },
  { name: 'supplier payments', path: () => `/v1/suppliers/${w.supplierId}/payments`, cashier: [403], manager: [403, WIDE] },
  { name: 'settlements (W3)', path: () => `/v1/purchases/${w.purchases.partPaid.purchaseId}/settlements`, cashier: [403], manager: [200] },
  {
    name: 'settlements (W1)',
    path: () => `/v1/purchases/${w.purchases.paid.purchaseId}/settlements`,
    cashier: [403],
    manager: [404, 'purchase.not_found'],
  },
];

function verdictOf(r: Response): Verdict {
  const code = r.status === 200 ? undefined : refusalCode(r);
  return code === undefined ? [r.status] : [r.status, code];
}

async function matrixFor(by: HttpActor, pick: (row: Row) => Verdict): Promise<void> {
  const got: Record<string, Verdict> = {};
  const want: Record<string, Verdict> = {};
  for (const row of MATRIX) {
    got[row.name] = verdictOf(await readAs(t, by, w.A.businessId, row.path()));
    want[row.name] = pick(row);
  }
  expect(got).toEqual(want);
}

describe('T-11 the authority matrix', () => {
  it('the cashier: 403 on every permissioned read', async () => {
    await matrixFor(w.cashier, (r) => r.cashier);
  });

  it('the manager assigned to Y: warehouse and master reads answer; business-wide reads are refused', async () => {
    await matrixFor(w.manager, (r) => r.manager);
  });

  it('the owner: 200 on every read', async () => {
    await matrixFor(w.owner, () => [200]);
  });

  it('the manager reads only the warehouses it reaches', async () => {
    const mine = await ok<{ items: { warehouseId: string; branchIds: string[] }[] }>(readAs(t, w.manager, w.A.businessId, '/v1/inventory/warehouses'));
    expect(mine.items.map((x) => x.warehouseId).sort()).toEqual([w.A.w2, w.w3].sort());
    expect(mine.items.find((x) => x.warehouseId === w.w3)?.branchIds).toEqual([w.A.branchX, w.A.branchY].sort());
    const all = await ok<{ items: { warehouseId: string }[] }>(readAs(t, w.owner, w.A.businessId, '/v1/inventory/warehouses'));
    expect(all.items.map((x) => x.warehouseId).sort()).toEqual([w.A.w1, w.A.w2, w.w3].sort());
    const takes = await ok<{ items: { stocktakeId: string }[] }>(readAs(t, w.manager, w.A.businessId, '/v1/inventory/stocktakes'));
    expect(takes.items.map((x) => x.stocktakeId)).toEqual([stocktakeW2]);
  });
});

describe('T-11 GET /v1/inventory/access', () => {
  const access = (by: HttpActor): Promise<{ businessWide: boolean; permissions: string[] }> => ok(readAs(t, by, w.A.businessId, '/v1/inventory/access'));

  it('returns exactly the caller’s subset, in the list’s order', async () => {
    expect(await access(w.owner)).toEqual({ businessWide: true, permissions: [...PHASE3_PERMISSIONS] });
    expect(await access(w.manager)).toEqual({
      businessWide: false,
      permissions: ['inventory.view', 'purchases.view', 'suppliers.view', 'warehouse.view', 'warehouse.manage'],
    });
    expect(await access(w.cashier)).toEqual({ businessWide: true, permissions: [] });
  });
});

describe('T-11 isolation', () => {
  it('a member of A naming B (another tenant) is refused on every read, and so is B’s owner naming A', async () => {
    for (const row of MATRIX) {
      expect({ read: row.name, status: (await readAs(t, w.owner, w.B.businessId, row.path())).status }).toEqual({ read: row.name, status: 403 });
      expect({ read: row.name, status: (await readAs(t, w.ownerB, w.A.businessId, row.path())).status }).toEqual({ read: row.name, status: 403 });
    }
  });

  it('the same owner reading A’s ids under A2 finds nothing', async () => {
    const underA2 = (path: string): Promise<Response> => readAs(t, w.owner, w.A2.businessId, path);
    const expectNotFound = async (path: string, code: string): Promise<void> => {
      const r = await underA2(path);
      expect({ path, status: r.status, code: refusalCode(r) }).toEqual({ path, status: 404, code });
    };
    await expectNotFound(`/v1/inventory/stock?warehouseId=${w.A.w1}`, 'inventory.warehouse_not_found');
    await expectNotFound(`/v1/inventory/stocktakes/${stocktakeW1}`, 'inventory.stocktake_not_found');
    await expectNotFound(`/v1/inventory/items?ids=${w.A.piece.productId}`, 'inventory.product_not_found');
    await expectNotFound(`/v1/suppliers/${w.supplierId}/open-purchases`, 'supplier.not_found');
    await expectNotFound(`/v1/purchases/${w.purchases.received.purchaseId}/return-options`, 'purchase.not_found');
    const filtered = await ok<{ items: unknown[] }>(underA2(`/v1/inventory/stocktakes?warehouseId=${w.A.w1}`));
    expect(filtered.items, 'filtering A2 by an A warehouse finds nothing').toEqual([]);

    const warehouses = await ok<{ items: { warehouseId: string }[] }>(underA2('/v1/inventory/warehouses'));
    expect(warehouses.items.map((x) => x.warehouseId).sort()).toEqual([w.A2.w1, w.A2.w2].sort());
    const balances = await ok<{ items: { supplierId: string }[] }>(underA2('/v1/supplier-balances?limit=50'));
    expect(balances.items.some((x) => x.supplierId === w.supplierId)).toBe(false);
    const items = await ok<{ items: { productId: string }[] }>(underA2('/v1/inventory/items?limit=50&trackedOnly=false'));
    expect(items.items.some((x) => x.productId === w.A.piece.productId)).toBe(false);
    const stocktakeList = await ok<{ items: unknown[] }>(underA2('/v1/inventory/stocktakes'));
    expect(stocktakeList.items).toEqual([]);
    const suppliers = await ok<{ items: { id: string }[] }>(underA2(`/v1/suppliers?search=${encodeURIComponent(w.supplierName)}`));
    expect(suppliers.items).toEqual([]);
  });
});
