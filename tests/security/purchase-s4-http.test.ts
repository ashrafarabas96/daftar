/**
 * P3-S4 T-18 — HTTP AUTHORITY OF THE THIRTEEN PURCHASING ROUTES
 * (docs/PHASE_3_S4_CONTRACT.md A-19, TL-4, §6 T-18; L:1174-1186).
 *
 * Through the real Nest application and the real database:
 *   - every route refuses 403 without its permission, BEFORE the service
 *     runs: no assertion is minted and nothing is written — the built-in
 *     cashier, the built-in manager on the seven mutations, and every custom
 *     single-permission holder on the other permissions' routes; each DENY is
 *     paired with the ALLOW of the member who holds the permission;
 *   - the built-in manager (the three view keys only) reads every route;
 *   - `purchases.receive` without scope over the purchase's warehouse is 403,
 *     with it 200; an assigned-scope reader sees only purchases of in-scope
 *     warehouses; the supplier payable requires business-wide scope;
 *   - isolation: the owner of A and A2 (same tenant, same owner), scoped to
 *     A, reaches none of A2's or B's suppliers and purchases (404).
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { InventoryAssertionMinterService } from '../../apps/api/src/modules/inventory/inventory-assertion.minter';
import { createTestApp, ensurePostgres, resetData, ownerPool, type TestApp } from '../helpers/test-app';
import { asMember, onboardS3Business, registerActor, today, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import { s4Counts, s4Delta } from '../helpers/purchase-commands';

let t: TestApp;
let day: string;
let owner: HttpActor;
let bOwner: HttpActor;
let A: S3Business;
let A2: S3Business;
let B: S3Business;
let mint: MockInstance<InventoryAssertionMinterService['mint']>;
const actors: Record<string, HttpActor> = {};

type Permission = 'suppliers.view' | 'suppliers.manage' | 'purchases.view' | 'purchases.manage' | 'purchases.receive';

/** Each custom actor holds exactly one of the five keys the routes need. */
const SINGLE: readonly (readonly [name: string, permission: Permission])[] = [
  ['supViewer', 'suppliers.view'],
  ['supManager', 'suppliers.manage'],
  ['purViewer', 'purchases.view'],
  ['purManager', 'purchases.manage'],
  ['receiver', 'purchases.receive'],
];

async function role(key: string, permissions: readonly string[]): Promise<void> {
  const r = await t.request.post('/v1/businesses/current/roles').set(asMember(owner, A.businessId)).send({ key, name: key, permissions });
  expect(r.status, `role ${key} ${JSON.stringify(r.body)}`).toBe(201);
}

async function member(a: HttpActor, roleKey: string): Promise<void> {
  const r = await t.request.post('/v1/businesses/current/members').set(asMember(owner, A.businessId)).send({ email: a.email, roleKey });
  expect(r.status, `member ${roleKey}`).toBe(201);
}

async function assigned(a: HttpActor, branchIds: string[]): Promise<void> {
  const r = await t.request
    .patch(`/v1/businesses/current/members/${a.userId}/branch-scope`)
    .set(asMember(owner, A.businessId))
    .send({ mode: 'assigned', branchIds });
  expect(r.status).toBe(200);
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
  t = await createTestApp();
  owner = await registerActor(t, 'S4 owner');
  A = await onboardS3Business(t, owner, 's4http');
  A2 = await onboardS3Business(t, owner, 's4http2', A.tenantId);
  bOwner = await registerActor(t, 'Other owner');
  B = await onboardS3Business(t, bOwner, 's4httpB');
  for (const [name, permission] of SINGLE) {
    actors[name] = await registerActor(t, name);
    await role(`s4-${name.toLowerCase()}`, [permission]);
    await member(must(actors[name]), `s4-${name.toLowerCase()}`);
  }
  actors.manager = await registerActor(t, 'Built-in manager');
  actors.cashier = await registerActor(t, 'Built-in cashier');
  await member(must(actors.manager), 'manager');
  await member(must(actors.cashier), 'cashier');
  actors.narrowReceiver = await registerActor(t, 'Receiver assigned to X');
  await role('s4-narrow-receiver', ['purchases.receive', 'purchases.view', 'suppliers.view']);
  await member(must(actors.narrowReceiver), 's4-narrow-receiver');
  await assigned(must(actors.narrowReceiver), [A.branchX]);
  mint = vi.spyOn(t.app.get(InventoryAssertionMinterService), 'mint');
});

beforeEach(() => {
  mint.mockClear();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await t.close();
  await resetData();
});

function must<T>(v: T | undefined, what = 'value'): T {
  if (v === undefined) throw new Error(`missing ${what}`);
  return v;
}

const as = (a: HttpActor, biz: S3Business = A): Record<string, string> => asMember(a, biz.businessId);

// ── fixtures, made by the owner through the API ───────────────────────────

async function supplier(biz: S3Business = A, by: HttpActor = owner): Promise<string> {
  const id = randomUUID();
  const r = await t.request
    .post('/v1/suppliers')
    .set(as(by, biz))
    .send({ supplierId: id, name: `Supplier ${id.slice(0, 6)}` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return id;
}

function draftBody(biz: S3Business, supplierId: string, warehouseId: string): Record<string, unknown> {
  return {
    expectedRevision: 0,
    supplierId,
    warehouseId,
    currency: 'ILS',
    documentDate: day,
    lines: [{ lineId: randomUUID(), productId: biz.piece.productId, quantity: '2', unitPrice: '12.50' }],
    landedCosts: [],
  };
}

async function draft(biz: S3Business = A, warehouseId: string = biz.w1, by: HttpActor = owner): Promise<string> {
  const id = randomUUID();
  const r = await t.request
    .put(`/v1/purchases/${id}`)
    .set(as(by, biz))
    .send(draftBody(biz, await supplier(biz, by), warehouseId));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return id;
}

async function received(biz: S3Business = A, by: HttpActor = owner): Promise<string> {
  const id = await draft(biz, biz.w1, by);
  const r = await t.request.post(`/v1/purchases/${id}/receive`).set(as(by, biz)).send({ draftRevision: 1 });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return id;
}

// ── the route table ───────────────────────────────────────────────────────

type Send = (a: HttpActor) => Promise<Response>;

interface Route {
  readonly name: string;
  readonly permission: Permission;
  readonly mutation: boolean;
  readonly ok: number;
  /** Make the route's fixture (as the owner) and return the request to send. */
  readonly prepare: () => Promise<Send>;
}

const ROUTES: readonly Route[] = [
  {
    name: 'POST /v1/suppliers',
    permission: 'suppliers.manage',
    mutation: true,
    ok: 201,
    prepare: async () => (a) => t.request.post('/v1/suppliers').set(as(a)).send({ supplierId: randomUUID(), name: 'Route supplier' }),
  },
  {
    name: 'PUT /v1/suppliers/:id',
    permission: 'suppliers.manage',
    mutation: true,
    ok: 200,
    prepare: async () => {
      const id = await supplier();
      return (a) => t.request.put(`/v1/suppliers/${id}`).set(as(a)).send({ expectedRevision: 1, name: 'Renamed' });
    },
  },
  {
    name: 'POST /v1/suppliers/:id/archive',
    permission: 'suppliers.manage',
    mutation: true,
    ok: 200,
    prepare: async () => {
      const id = await supplier();
      return (a) => t.request.post(`/v1/suppliers/${id}/archive`).set(as(a)).send({ expectedRevision: 1 });
    },
  },
  {
    name: 'POST /v1/suppliers/:id/reactivate',
    permission: 'suppliers.manage',
    mutation: true,
    ok: 200,
    prepare: async () => {
      const id = await supplier();
      expect((await t.request.post(`/v1/suppliers/${id}/archive`).set(as(owner)).send({ expectedRevision: 1 })).status).toBe(200);
      return (a) => t.request.post(`/v1/suppliers/${id}/reactivate`).set(as(a)).send({ expectedRevision: 2 });
    },
  },
  { name: 'GET /v1/suppliers', permission: 'suppliers.view', mutation: false, ok: 200, prepare: async () => (a) => t.request.get('/v1/suppliers').set(as(a)) },
  {
    name: 'GET /v1/suppliers/:id',
    permission: 'suppliers.view',
    mutation: false,
    ok: 200,
    prepare: async () => {
      const id = await supplier();
      return (a) => t.request.get(`/v1/suppliers/${id}`).set(as(a));
    },
  },
  {
    name: 'GET /v1/suppliers/:id/payable',
    permission: 'suppliers.view',
    mutation: false,
    ok: 200,
    prepare: async () => {
      const id = await supplier();
      return (a) => t.request.get(`/v1/suppliers/${id}/payable`).set(as(a));
    },
  },
  {
    name: 'PUT /v1/purchases/:id',
    permission: 'purchases.manage',
    mutation: true,
    ok: 201,
    prepare: async () => {
      const body = draftBody(A, await supplier(), A.w1);
      return (a) => t.request.put(`/v1/purchases/${randomUUID()}`).set(as(a)).send(body);
    },
  },
  {
    name: 'POST /v1/purchases/:id/receive',
    permission: 'purchases.receive',
    mutation: true,
    ok: 200,
    prepare: async () => {
      const id = await draft();
      return (a) => t.request.post(`/v1/purchases/${id}/receive`).set(as(a)).send({ draftRevision: 1 });
    },
  },
  {
    name: 'POST /v1/purchases/:id/cancel',
    permission: 'purchases.manage',
    mutation: true,
    ok: 200,
    prepare: async () => {
      const id = await draft();
      return (a) => t.request.post(`/v1/purchases/${id}/cancel`).set(as(a)).send({ draftRevision: 1 });
    },
  },
  { name: 'GET /v1/purchases', permission: 'purchases.view', mutation: false, ok: 200, prepare: async () => (a) => t.request.get('/v1/purchases').set(as(a)) },
  {
    name: 'GET /v1/purchases/:id',
    permission: 'purchases.view',
    mutation: false,
    ok: 200,
    prepare: async () => {
      const id = await received();
      return (a) => t.request.get(`/v1/purchases/${id}`).set(as(a));
    },
  },
  {
    name: 'GET /v1/purchases/:id/payable',
    permission: 'purchases.view',
    mutation: false,
    ok: 200,
    prepare: async () => {
      const id = await received();
      return (a) => t.request.get(`/v1/purchases/${id}/payable`).set(as(a));
    },
  },
];

/** A DENY: 403 FORBIDDEN, no assertion minted, nothing written. */
async function expectDenied(route: Route, a: HttpActor, who: string): Promise<void> {
  const send = await route.prepare();
  const before = await s4Counts(ownerPool(), A.businessId);
  mint.mockClear();
  const res = await send(a);
  expect(res.status, `${who} → ${route.name}: ${JSON.stringify(res.body)}`).toBe(403);
  expect(res.body.error.code, `${who} → ${route.name}`).toBe('FORBIDDEN');
  expect(mint, `${who} → ${route.name}: no assertion minted`).not.toHaveBeenCalled();
  expect(s4Delta(before, await s4Counts(ownerPool(), A.businessId)), `${who} → ${route.name}: nothing written`).toEqual({});
}

describe('T-18 every route requires its permission, and refuses before the service runs', () => {
  for (const route of ROUTES) {
    it(`${route.name} (${route.permission})`, async () => {
      const deniers = [...SINGLE.filter(([, p]) => p !== route.permission).map(([n]) => n), 'cashier', ...(route.mutation ? ['manager'] : [])];
      for (const name of deniers) await expectDenied(route, must(actors[name], name), name);
      const holder = must(SINGLE.find(([, p]) => p === route.permission))[0];
      const send = await route.prepare();
      mint.mockClear();
      const res = await send(must(actors[holder]));
      expect(res.status, `${holder} → ${route.name}: ${JSON.stringify(res.body)}`).toBe(route.ok);
      if (route.mutation) expect(mint, 'the holder’s command is signed').toHaveBeenCalledTimes(1);
    });
  }

  it('the built-in manager (the three view keys) reads every route', async () => {
    for (const route of ROUTES.filter((r) => !r.mutation)) {
      const res = await (await route.prepare())(must(actors.manager));
      expect(res.status, `manager → ${route.name}: ${JSON.stringify(res.body)}`).toBe(200);
    }
  });
});

describe('T-18 warehouse scope', () => {
  it('purchases.receive without scope over the purchase’s warehouse → 403, nothing minted; in scope → 200', async () => {
    const narrow = must(actors.narrowReceiver);
    const outOfScope = await draft(A, A.w2);
    const before = await s4Counts(ownerPool(), A.businessId);
    mint.mockClear();
    const denied = await t.request.post(`/v1/purchases/${outOfScope}/receive`).set(as(narrow)).send({ draftRevision: 1 });
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(mint).not.toHaveBeenCalled();
    expect(s4Delta(before, await s4Counts(ownerPool(), A.businessId))).toEqual({});
    const inScope = await draft(A, A.w1);
    const ok = await t.request.post(`/v1/purchases/${inScope}/receive`).set(as(narrow)).send({ draftRevision: 1 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('an assigned-scope reader sees purchases of in-scope warehouses only', async () => {
    const narrow = must(actors.narrowReceiver);
    const x = await draft(A, A.w1);
    const y = await draft(A, A.w2);
    const list = await t.request.get('/v1/purchases?limit=100').set(as(narrow));
    expect(list.status).toBe(200);
    const items = list.body.items as { id: string; warehouseId: string }[];
    expect(items.map((p) => p.id)).toContain(x);
    expect(items.map((p) => p.id)).not.toContain(y);
    expect(items.every((p) => p.warehouseId === A.w1)).toBe(true);
    expect((await t.request.get(`/v1/purchases/${y}`).set(as(narrow))).status, 'an out-of-scope purchase is not found').toBe(404);
    expect((await t.request.get(`/v1/purchases/${y}/payable`).set(as(narrow))).status).toBe(404);
    expect((await t.request.get(`/v1/purchases/${x}`).set(as(narrow))).status).toBe(200);
  });

  it('the supplier payable requires business-wide scope; the supplier itself is readable', async () => {
    const narrow = must(actors.narrowReceiver);
    const id = await supplier();
    const payable = await t.request.get(`/v1/suppliers/${id}/payable`).set(as(narrow));
    expect(payable.status).toBe(403);
    expect(payable.body.error.details?.inventoryCode).toBe('inventory.business_wide_scope_required');
    expect((await t.request.get(`/v1/suppliers/${id}`).set(as(narrow))).status).toBe(200);
  });
});

describe('T-18 isolation: the owner scoped to A reaches nothing of A2 (same owner) or B', () => {
  for (const which of ['A2', 'B'] as const) {
    it(`${which}: every route answers 404 for its supplier and purchase ids, lists never show them, and nothing is written there`, async () => {
      const X = which === 'A2' ? A2 : B;
      const xOwner = which === 'A2' ? owner : bOwner;
      const theirSupplier = await supplier(X, xOwner);
      const theirPurchase = await received(X, xOwner);
      const theirDraft = await draft(X, X.w1, xOwner);
      const theirs = await s4Counts(ownerPool(), X.businessId);
      const calls: [string, () => Promise<Response>][] = [
        ['GET supplier', () => t.request.get(`/v1/suppliers/${theirSupplier}`).set(as(owner))],
        ['GET supplier payable', () => t.request.get(`/v1/suppliers/${theirSupplier}/payable`).set(as(owner))],
        ['PUT supplier', () => t.request.put(`/v1/suppliers/${theirSupplier}`).set(as(owner)).send({ expectedRevision: 1, name: 'Hijack' })],
        ['archive supplier', () => t.request.post(`/v1/suppliers/${theirSupplier}/archive`).set(as(owner)).send({ expectedRevision: 1 })],
        ['GET purchase', () => t.request.get(`/v1/purchases/${theirPurchase}`).set(as(owner))],
        ['GET purchase payable', () => t.request.get(`/v1/purchases/${theirPurchase}/payable`).set(as(owner))],
        ['receive their draft', () => t.request.post(`/v1/purchases/${theirDraft}/receive`).set(as(owner)).send({ draftRevision: 1 })],
        ['cancel their draft', () => t.request.post(`/v1/purchases/${theirDraft}/cancel`).set(as(owner)).send({ draftRevision: 1 })],
      ];
      for (const [what, call] of calls) {
        const r = await call();
        expect(r.status, `${what} of ${which} from A: ${JSON.stringify(r.body)}`).toBe(404);
      }
      const body = { ...draftBody(A, await supplier(), A.w1), expectedRevision: 1 };
      expect((await t.request.put(`/v1/purchases/${theirDraft}`).set(as(owner)).send(body)).status, 'replacing their draft from A').toBe(404);
      const suppliers = (await t.request.get('/v1/suppliers?limit=100').set(as(owner))).body.items as { id: string }[];
      expect(suppliers.map((s) => s.id)).not.toContain(theirSupplier);
      const purchases = (await t.request.get('/v1/purchases?limit=100').set(as(owner))).body.items as { id: string }[];
      expect(purchases.map((p) => p.id)).not.toContain(theirPurchase);
      expect(s4Delta(theirs, await s4Counts(ownerPool(), X.businessId)), `${which} untouched`).toEqual({});
      // ALLOW: in its own business the same read succeeds.
      expect((await t.request.get(`/v1/purchases/${theirPurchase}`).set(as(xOwner, X))).status).toBe(200);
    });
  }
});
