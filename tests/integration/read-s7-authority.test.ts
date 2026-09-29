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
 *     of A reading A's ids under its OTHER business A2 finds nothing;
 *   - the pickers of the movement and purchase screens (the coordinator's
 *     ruling on review item 6): single-permission roles reach the warehouse
 *     and item pickers their screens need, `holdsStock` only with
 *     `inventory.adjust` or `inventory.view`, `GET /v1/suppliers/:id` with
 *     `suppliers.pay`; none of them reaches the stock read;
 *   - R-S7-1 (the coordinator's ruling on review finding M-1): the blind
 *     count (TL-8) is enforced by the SERVER. The S3 count answer carries
 *     the expected quantity, the variance and the capture's stock sequence
 *     only to a caller holding `inventory.view`, and the stocktake detail
 *     withholds the figures of every stocktake that is not finalized (a
 *     cancelled one included) unless the caller holds `inventory.adjust`.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, ensurePostgres, resetData, type TestApp } from '../helpers/test-app';
import { asMember, registerActor, type HttpActor } from '../helpers/inventory-commands';
import { refusalCode } from '../helpers/supplier-settlement';
import { ok, readAs, seedReadsWorld, type ReadsWorld } from '../helpers/merchant-reads';
import { PHASE3_PERMISSIONS } from '@daftar/shared-contracts';

let t: TestApp;
let w: ReadsWorld;
let stocktakeW1: string;
let stocktakeW2: string;

/**
 * Custom roles of exactly the permissions named, one member each, all
 * business-wide except `transferY` (assigned to branch Y: W2 and W3).
 */
const ROLES = {
  counter: ['inventory.stocktake'],
  counterView: ['inventory.stocktake', 'inventory.view'],
  counterAdjust: ['inventory.stocktake', 'inventory.adjust'],
  mover: ['inventory.transfer'],
  moverY: ['inventory.transfer'],
  adjuster: ['inventory.adjust'],
  purchaser: ['purchases.manage'],
  receiver: ['purchases.receive'],
  payer: ['suppliers.pay'],
} as const;
type RoleName = keyof typeof ROLES;
let role: Record<RoleName, HttpActor>;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  t = await createTestApp();
  w = await seedReadsWorld(t, 'auth');
  stocktakeW1 = await openStocktake(w.A.w1);
  stocktakeW2 = await openStocktake(w.A.w2);
  // More registrations than the per-IP register limit admits: the limiter is
  // not what this suite tests, so it is stubbed while the members are made.
  const limiter = t.app.get<{ take: (...args: unknown[]) => Promise<unknown> }>('RATE_LIMITER');
  const stub = vi.spyOn(limiter, 'take').mockResolvedValue(undefined);
  role = {
    counter: await customMember('counter', ROLES.counter),
    counterView: await customMember('counterView', ROLES.counterView),
    counterAdjust: await customMember('counterAdjust', ROLES.counterAdjust),
    mover: await customMember('mover', ROLES.mover),
    moverY: await customMember('moverY', ROLES.moverY, [w.A.branchY]),
    adjuster: await customMember('adjuster', ROLES.adjuster),
    purchaser: await customMember('purchaser', ROLES.purchaser),
    receiver: await customMember('receiver', ROLES.receiver),
    payer: await customMember('payer', ROLES.payer),
  };
  stub.mockRestore();
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

/** A member of A under a new custom role holding exactly `permissions`. */
async function customMember(name: string, permissions: readonly string[], branchIds?: readonly string[]): Promise<HttpActor> {
  const key = `t11-${name.toLowerCase()}`;
  const r = await t.request.post('/v1/businesses/current/roles').set(asMember(w.owner, w.A.businessId)).send({ key, name: key, permissions });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const actor = await registerActor(t, `T-11 ${name}`);
  const m = await t.request.post('/v1/businesses/current/members').set(asMember(w.owner, w.A.businessId)).send({ email: actor.email, roleKey: key });
  expect(m.status, JSON.stringify(m.body)).toBe(201);
  if (branchIds !== undefined) {
    const s = await t.request
      .patch(`/v1/businesses/current/members/${actor.userId}/branch-scope`)
      .set(asMember(w.owner, w.A.businessId))
      .send({ mode: 'assigned', branchIds });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
  }
  return actor;
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
  const access = (by: HttpActor): Promise<{ businessWide: boolean; permissions: string[]; openingPosted: boolean }> =>
    ok(readAs(t, by, w.A.businessId, '/v1/inventory/access'));

  it('returns exactly the caller’s subset, in the list’s order', async () => {
    expect(await access(w.owner)).toEqual({ businessWide: true, permissions: [...PHASE3_PERMISSIONS], openingPosted: false });
    expect(await access(w.manager)).toEqual({
      businessWide: false,
      permissions: ['inventory.view', 'purchases.view', 'suppliers.view', 'warehouse.view', 'warehouse.manage'],
      openingPosted: false,
    });
    expect(await access(w.cashier)).toEqual({ businessWide: true, permissions: [], openingPosted: false });
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

describe('T-11 R-S7-1 the blind count is enforced by the server (TL-8)', () => {
  interface CountLine {
    productId: string;
    countedQty: string;
    expectedQtyAtCapture: string | null;
    varianceQty: string | null;
    capturedAtStockSeq: string | null;
  }
  interface DetailLine {
    productId: string;
    countedQty: string;
    expectedQty: string | null;
    varianceQty: string | null;
  }
  const count = async (by: HttpActor, stocktakeId: string, quantity: string): Promise<CountLine> => {
    const r = await t.request
      .put(`/v1/inventory/stocktakes/${stocktakeId}/counts`)
      .set(asMember(by, w.A.businessId))
      .send({ lines: [{ productId: w.A.piece2.productId, variantId: null, quantity }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const lines = (r.body as { lines: CountLine[] }).lines;
    expect(lines).toHaveLength(1);
    return lines[0] as CountLine;
  };
  const detail = async (by: HttpActor, stocktakeId: string): Promise<{ status: string; lines: DetailLine[] }> =>
    ok(readAs(t, by, w.A.businessId, `/v1/inventory/stocktakes/${stocktakeId}`));
  const close = async (by: HttpActor, stocktakeId: string, outcome: 'cancel' | 'finalize'): Promise<void> => {
    const r = await t.request
      .post(`/v1/inventory/stocktakes/${stocktakeId}/${outcome}`)
      .set(asMember(by, w.A.businessId))
      .send(outcome === 'finalize' ? { occurredOn: w.day } : {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };

  // piece2 in W2: 5 received, 2 returned — 3 on hand.
  it('PUT counts: a counter without inventory.view gets the count only; a counter holding it gets the capture', async () => {
    const blind = await count(role.counter, stocktakeW2, '0');
    expect(blind).toMatchObject({ productId: w.A.piece2.productId, countedQty: '0.0000' });
    expect({ expected: blind.expectedQtyAtCapture, variance: blind.varianceQty, seq: blind.capturedAtStockSeq }).toEqual({
      expected: null,
      variance: null,
      seq: null,
    });
    const blindAdjust = await count(role.counterAdjust, stocktakeW2, '0');
    expect({ expected: blindAdjust.expectedQtyAtCapture, variance: blindAdjust.varianceQty, seq: blindAdjust.capturedAtStockSeq }).toEqual({
      expected: null,
      variance: null,
      seq: null,
    });

    const seen = await count(role.counterView, stocktakeW2, '1');
    expect(seen).toMatchObject({ countedQty: '1.0000', expectedQtyAtCapture: '3.0000', varianceQty: '-2.0000' });
    expect(seen.capturedAtStockSeq).toMatch(/^\d+$/);
    const owner = await count(w.owner, stocktakeW2, '1');
    expect(owner).toMatchObject({ countedQty: '1.0000', expectedQtyAtCapture: '3.0000', varianceQty: '-2.0000' });
    expect(owner.capturedAtStockSeq).toMatch(/^\d+$/);
  });

  it('GET detail of a draft: the figures only to inventory.adjust (A-08)', async () => {
    for (const by of [role.counter, role.counterView]) {
      const d = await detail(by, stocktakeW2);
      expect(d.lines.map((l) => [l.expectedQty, l.varianceQty])).toEqual([[null, null]]);
    }
    const seen = await detail(role.counterAdjust, stocktakeW2);
    expect(seen.lines.map((l) => [l.countedQty, l.expectedQty, l.varianceQty])).toEqual([['1', '3', '-2']]);
  });

  it('GET detail of a CANCELLED stocktake stays blind: counting, cancelling and reading back discloses nothing', async () => {
    await close(role.counter, stocktakeW2, 'cancel');
    const d = await detail(role.counter, stocktakeW2);
    expect(d.status).toBe('cancelled');
    expect(d.lines.map((l) => [l.countedQty, l.expectedQty, l.varianceQty])).toEqual([['1', null, null]]);
    const seen = await detail(role.counterAdjust, stocktakeW2);
    expect(seen.lines.map((l) => [l.expectedQty, l.varianceQty])).toEqual([['3', '-2']]);
  });

  it('GET detail of a FINALIZED stocktake: the figures to every caller who may read it (A-08)', async () => {
    const stocktakeId = randomUUID();
    const opened = await t.request.post('/v1/inventory/stocktakes').set(asMember(role.counter, w.A.businessId)).send({ stocktakeId, warehouseId: w.A.w2 });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    await count(role.counter, stocktakeId, '3');
    await close(role.counter, stocktakeId, 'finalize');
    const d = await detail(role.counter, stocktakeId);
    expect(d.status).toBe('finalized');
    expect(d.lines.map((l) => [l.countedQty, l.expectedQty, l.varianceQty])).toEqual([['3', '3', '0']]);
  });
});

describe('T-11 input: a NUL byte in any search is a validation refusal, never a 500 (review L-2)', () => {
  it('items, stock, suppliers and supplier balances answer 400 VALIDATION_FAILED', async () => {
    const paths = [
      '/v1/inventory/items?search=%00',
      '/v1/inventory/items?search=a%00b',
      `/v1/inventory/stock?warehouseId=${w.A.w1}&search=%00`,
      `/v1/inventory/stock?warehouseId=${w.A.w1}&search=a%00b`,
      '/v1/suppliers?search=%00',
      '/v1/suppliers?search=a%00b',
      '/v1/supplier-balances?search=%00',
      '/v1/supplier-balances?search=a%00b',
    ];
    for (const path of paths) {
      const r = await readAs(t, w.owner, w.A.businessId, path);
      expect({ path, status: r.status, code: (r.body as { error?: { code?: string } }).error?.code }).toEqual({ path, status: 400, code: 'VALIDATION_FAILED' });
    }
  });
});

describe('T-11 the pickers: single-permission roles (review item 6)', () => {
  interface Access {
    readonly warehouses: number;
    readonly items: number;
    /** `holdsStock` of a product that holds stock, when the items read answers. */
    readonly holdsStock?: boolean | null;
    readonly stock: number;
    readonly supplier: number;
    readonly openPurchases: number;
  }
  const accessOf = async (by: HttpActor): Promise<Access> => {
    const read = (path: string): Promise<Response> => readAs(t, by, w.A.businessId, path);
    const items = await read(`/v1/inventory/items?ids=${w.A.piece.productId}`);
    const holds = items.status === 200 ? (items.body as { items: { holdsStock: boolean | null }[] }).items.map((i) => i.holdsStock) : [];
    return {
      warehouses: (await read('/v1/inventory/warehouses')).status,
      items: items.status,
      ...(items.status === 200 ? { holdsStock: holds.length === 1 ? holds[0] : undefined } : {}),
      stock: (await read(`/v1/inventory/stock?warehouseId=${w.A.w2}`)).status,
      supplier: (await read(`/v1/suppliers/${w.supplierId}`)).status,
      openPurchases: (await read(`/v1/suppliers/${w.supplierId}/open-purchases`)).status,
    };
  };
  const picker = { warehouses: 200, items: 200, holdsStock: null, stock: 403, supplier: 403, openPurchases: 403 } as const;

  it('each widened permission reaches the warehouse and item pickers, never the stock read', async () => {
    expect({
      'inventory.stocktake': await accessOf(role.counter),
      'inventory.transfer': await accessOf(role.mover),
      'inventory.adjust': await accessOf(role.adjuster),
      'purchases.manage': await accessOf(role.purchaser),
      'purchases.receive': await accessOf(role.receiver),
      'suppliers.pay': await accessOf(role.payer),
      'inventory.stocktake + inventory.view': await accessOf(role.counterView),
    }).toEqual({
      'inventory.stocktake': picker,
      'inventory.transfer': picker,
      'inventory.adjust': { ...picker, holdsStock: true },
      'purchases.manage': picker,
      'purchases.receive': picker,
      'suppliers.pay': { warehouses: 403, items: 403, stock: 403, supplier: 200, openPurchases: 200 },
      'inventory.stocktake + inventory.view': { ...picker, holdsStock: true, stock: 200 },
    });
  });

  it('a widened picker still lists only the warehouses the caller reaches, with no quantity or value', async () => {
    const mine = await ok<{ items: Record<string, unknown>[] }>(readAs(t, role.moverY, w.A.businessId, '/v1/inventory/warehouses'));
    expect(mine.items.map((x) => x['warehouseId']).sort()).toEqual([w.A.w2, w.w3].sort());
    for (const x of mine.items) expect(Object.keys(x).sort()).toEqual(['branchIds', 'homeBranchId', 'name', 'status', 'warehouseId']);
    const stock = await readAs(t, role.moverY, w.A.businessId, `/v1/inventory/stock?warehouseId=${w.A.w2}`);
    expect(stock.status).toBe(403);
  });
});
