/**
 * P3-S5 T-18 — HTTP AUTHORITY OF THE FIVE S5 ROUTES, AND T-06's SCOPE SIDE
 * (docs/PHASE_3_S5_CONTRACT.md A-03, A-19, TL-4, TL-5, §6 T-06, T-18;
 * L:1174-1186).
 *
 * Through the real Nest application and the real database:
 *   - every route refuses 403 without its permission, BEFORE the service
 *     runs: no assertion is minted and nothing is written — the built-in
 *     cashier, the built-in manager on the two mutations, and every custom
 *     single-permission holder on the other permissions' routes; each DENY is
 *     paired with the ALLOW of the holder. `purchases.return` alone cannot
 *     reverse; `purchases.receive` alone cannot return;
 *   - the built-in manager (view keys only) reads every S5 route;
 *   - TL-5: a return needs `purchases.return` AND scope over the RETURN
 *     warehouse — after an S3 transfer W1→W2, an actor scoped to W2 returns a
 *     W1 purchase from W2 (201), one scoped to W1 only is 403
 *     `inventory.warehouse_out_of_scope` with nothing minted or consumed;
 *   - TL-4: a reversal needs `purchases.receive` AND scope over the
 *     purchase's warehouse;
 *   - the credit-note list requires business-wide scope;
 *   - the request carries no amount and no tax (strict DTOs); a reversal
 *     without a reason is 422 `purchase_reversal.reason_required` at the DTO;
 *   - isolation: the owner of A and A2 (same tenant, same owner), scoped to
 *     A, reaches none of A2's or B's purchases, returns or credit notes (404)
 *     and writes nothing there; the same calls in their own business succeed.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { InventoryAssertionMinterService } from '../../apps/api/src/modules/inventory/inventory-assertion.minter';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import {
  asMember,
  must,
  onboardS3Business,
  ownerClient,
  registerActor,
  runCommand as runS3,
  today,
  transferCommand,
  type HttpActor,
  type S3Business,
} from '../helpers/inventory-commands';
import { s4Delta } from '../helpers/purchase-commands';
import { s5Counts } from '../helpers/purchase-returns';

let t: TestApp;
let day: string;
let owner: HttpActor;
let bOwner: HttpActor;
let A: S3Business;
let A2: S3Business;
let B: S3Business;
let mint: MockInstance<InventoryAssertionMinterService['mint']>;
const actors: Record<string, HttpActor> = {};

type Permission = 'suppliers.view' | 'purchases.view' | 'purchases.receive' | 'purchases.return';

/**
 * Each custom actor holds exactly one of the four keys the S5 routes need
 * (ten registrations in all: the per-IP registration budget of the test app).
 */
const SINGLE: readonly (readonly [name: string, permission: Permission])[] = [
  ['supViewer', 'suppliers.view'],
  ['purViewer', 'purchases.view'],
  ['receiver', 'purchases.receive'],
  ['returner', 'purchases.return'],
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

async function narrowActor(name: string, permissions: readonly string[], branchIds: string[]): Promise<void> {
  actors[name] = await registerActor(t, name);
  await role(`s5-${name.toLowerCase()}`, permissions);
  await member(must(actors[name]), `s5-${name.toLowerCase()}`);
  await assigned(must(actors[name]), branchIds);
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
  t = await createTestApp();
  owner = await registerActor(t, 'S5 owner');
  A = await onboardS3Business(t, owner, 's5http');
  A2 = await onboardS3Business(t, owner, 's5http2', A.tenantId);
  bOwner = await registerActor(t, 'Other owner');
  B = await onboardS3Business(t, bOwner, 's5httpB');
  for (const [name, permission] of SINGLE) {
    actors[name] = await registerActor(t, name);
    await role(`s5-${name.toLowerCase()}`, [permission]);
    await member(must(actors[name]), `s5-${name.toLowerCase()}`);
  }
  actors.manager = await registerActor(t, 'Built-in manager');
  actors.cashier = await registerActor(t, 'Built-in cashier');
  await member(must(actors.manager), 'manager');
  await member(must(actors.cashier), 'cashier');
  await narrowActor('narrowX', ['purchases.return', 'purchases.receive', 'purchases.view', 'suppliers.view'], [A.branchX]);
  await narrowActor('narrowY', ['purchases.return', 'purchases.view'], [A.branchY]);
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

interface HttpPurchase {
  readonly purchaseId: string;
  readonly supplierId: string;
  readonly lineId: string;
  readonly warehouseId: string;
}

/** A received purchase of 4 pieces at 12.50 on `warehouseId`, made through the API. */
async function received(biz: S3Business = A, warehouseId: string = biz.w1, by: HttpActor = owner): Promise<HttpPurchase> {
  const purchaseId = randomUUID();
  const lineId = randomUUID();
  const supplierId = await supplier(biz, by);
  const d = await t.request
    .put(`/v1/purchases/${purchaseId}`)
    .set(as(by, biz))
    .send({
      expectedRevision: 0,
      supplierId,
      warehouseId,
      currency: 'ILS',
      documentDate: day,
      lines: [{ lineId, productId: biz.piece.productId, quantity: '4', unitPrice: '12.50' }],
      landedCosts: [],
    });
  expect(d.status, JSON.stringify(d.body)).toBe(201);
  const r = await t.request.post(`/v1/purchases/${purchaseId}/receive`).set(as(by, biz)).send({ draftRevision: 1 });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { purchaseId, supplierId, lineId, warehouseId };
}

function returnBody(p: HttpPurchase, warehouseId: string = p.warehouseId, quantity = '1'): Record<string, unknown> {
  return { returnId: randomUUID(), warehouseId, documentDate: day, lines: [{ lineId: randomUUID(), purchaseLineId: p.lineId, quantity }] };
}

async function returned(p: HttpPurchase, biz: S3Business = A, by: HttpActor = owner): Promise<string> {
  const body = returnBody(p);
  const r = await t.request.post(`/v1/purchases/${p.purchaseId}/returns`).set(as(by, biz)).send(body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return String(body.returnId);
}

// ── the route table ───────────────────────────────────────────────────────

type Send = (a: HttpActor) => Promise<Response>;

interface Route {
  readonly name: string;
  readonly permission: Permission;
  readonly mutation: boolean;
  readonly ok: number;
  readonly prepare: () => Promise<Send>;
}

const ROUTES: readonly Route[] = [
  {
    name: 'POST /v1/purchases/:id/returns',
    permission: 'purchases.return',
    mutation: true,
    ok: 201,
    prepare: async () => {
      const p = await received();
      const body = returnBody(p);
      return (a) => t.request.post(`/v1/purchases/${p.purchaseId}/returns`).set(as(a)).send(body);
    },
  },
  {
    name: 'POST /v1/purchases/:id/reversal',
    permission: 'purchases.receive',
    mutation: true,
    ok: 200,
    prepare: async () => {
      const p = await received();
      return (a) =>
        t.request.post(`/v1/purchases/${p.purchaseId}/reversal`).set(as(a)).send({ reversalDate: day, reason: 'Received against the wrong supplier' });
    },
  },
  {
    name: 'GET /v1/purchases/:id/returns',
    permission: 'purchases.view',
    mutation: false,
    ok: 200,
    prepare: async () => {
      const p = await received();
      await returned(p);
      return (a) => t.request.get(`/v1/purchases/${p.purchaseId}/returns`).set(as(a));
    },
  },
  {
    name: 'GET /v1/supplier-returns/:returnId',
    permission: 'purchases.view',
    mutation: false,
    ok: 200,
    prepare: async () => {
      const id = await returned(await received());
      return (a) => t.request.get(`/v1/supplier-returns/${id}`).set(as(a));
    },
  },
  {
    name: 'GET /v1/suppliers/:id/credit-notes',
    permission: 'suppliers.view',
    mutation: false,
    ok: 200,
    prepare: async () => {
      const p = await received();
      return (a) => t.request.get(`/v1/suppliers/${p.supplierId}/credit-notes`).set(as(a));
    },
  },
];

/** A DENY: 403 FORBIDDEN, no assertion minted, nothing written. */
async function expectDenied(route: Route, a: HttpActor, who: string): Promise<void> {
  const send = await route.prepare();
  const before = await s5Counts(ownerPool(), A.businessId);
  mint.mockClear();
  const res = await send(a);
  expect(res.status, `${who} → ${route.name}: ${JSON.stringify(res.body)}`).toBe(403);
  expect(res.body.error.code, `${who} → ${route.name}`).toBe('FORBIDDEN');
  expect(mint, `${who} → ${route.name}: no assertion minted`).not.toHaveBeenCalled();
  expect(s4Delta(before, await s5Counts(ownerPool(), A.businessId)), `${who} → ${route.name}: nothing written`).toEqual({});
}

describe('T-18 every S5 route requires its permission, and refuses before the service runs', () => {
  for (const route of ROUTES) {
    it(`${route.name} (${route.permission})`, async () => {
      const deniers = [...SINGLE.filter(([, p]) => p !== route.permission).map(([n]) => n), 'cashier', ...(route.mutation ? ['manager'] : [])];
      for (const name of deniers) await expectDenied(route, must(actors[name], name), name);
      const holder = must(SINGLE.find(([, p]) => p === route.permission))[0];
      const send = await route.prepare();
      mint.mockClear();
      const res = await send(must(actors[holder]));
      expect(res.status, `${holder} → ${route.name}: ${JSON.stringify(res.body)}`).toBe(route.ok);
      if (route.mutation) expect(mint, 'the holder’s command is signed once').toHaveBeenCalledTimes(1);
    });
  }

  it('the built-in manager (view keys only) reads every S5 route', async () => {
    for (const route of ROUTES.filter((r) => !r.mutation)) {
      const res = await (await route.prepare())(must(actors.manager));
      expect(res.status, `manager → ${route.name}: ${JSON.stringify(res.body)}`).toBe(200);
    }
  });

  it('the answers: a return 201 then 200 as a replay; a reversal 200, the purchase then reads reversed', async () => {
    const p = await received();
    const body = returnBody(p);
    const first = await t.request.post(`/v1/purchases/${p.purchaseId}/returns`).set(as(owner)).send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ returnId: body.returnId, purchaseId: p.purchaseId, replayed: false, creditNote: null, carryingTxnMinor: '1250' });
    const again = await t.request.post(`/v1/purchases/${p.purchaseId}/returns`).set(as(owner)).send(body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ returnId: body.returnId, replayed: true, entryId: first.body.entryId });
    const q = await received();
    const rev = await t.request.post(`/v1/purchases/${q.purchaseId}/reversal`).set(as(owner)).send({ reversalDate: day, reason: 'Wrong supplier' });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    expect(rev.body).toMatchObject({ purchaseId: q.purchaseId, totalValueBaseMinor: '5000', replayed: false });
    expect((await t.request.get(`/v1/purchases/${q.purchaseId}`).set(as(owner))).body.status).toBe('reversed');
  });
});

describe('T-18 the request shape: no amount, no tax, a reversal reason', () => {
  it('an amount or tax field is refused 400 before anything is minted; a reversal with no or a blank reason is 422 reason_required', async () => {
    const p = await received();
    const before = await s5Counts(ownerPool(), A.businessId);
    mint.mockClear();
    for (const extra of [{ taxAmount: '1.00' }, { amount: '12.50' }, { apTxnMinor: '1250' }]) {
      const r = await t.request
        .post(`/v1/purchases/${p.purchaseId}/returns`)
        .set(as(owner))
        .send({ ...returnBody(p), ...extra });
      expect(r.status, `${JSON.stringify(extra)}: ${JSON.stringify(r.body)}`).toBe(400);
    }
    for (const body of [{ reversalDate: day }, { reversalDate: day, reason: null }, { reversalDate: day, reason: '   ' }]) {
      const r = await t.request.post(`/v1/purchases/${p.purchaseId}/reversal`).set(as(owner)).send(body);
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      expect(r.body.error.details?.purchasingCode).toBe('purchase_reversal.reason_required');
    }
    const taxed = await t.request.post(`/v1/purchases/${p.purchaseId}/reversal`).set(as(owner)).send({ reversalDate: day, reason: 'x', taxAmount: '1' });
    expect(taxed.status).toBe(400);
    expect(mint).not.toHaveBeenCalled();
    expect(s4Delta(before, await s5Counts(ownerPool(), A.businessId))).toEqual({});
  });
});

describe('T-06 / TL-5: a return is scoped by its RETURN warehouse', () => {
  it('after a transfer W1→W2, the W2-scoped actor returns the W1 purchase from W2; the W1-scoped actor is 403 with nothing minted or consumed', async () => {
    const p = await received(A, A.w1);
    // The owner moves 2 of the 4 pieces to W2 through the real S3 transfer (committed).
    const c = await ownerClient();
    try {
      await c.query('BEGIN');
      await runS3(c, A, transferCommand(A.w1, A.w2, [{ variantId: A.piece.variantId, qty: '2' }]));
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
    const fromW2 = returnBody(p, A.w2, '2');
    const before = await s5Counts(ownerPool(), A.businessId);
    mint.mockClear();
    const denied = await t.request
      .post(`/v1/purchases/${p.purchaseId}/returns`)
      .set(as(must(actors.narrowX)))
      .send(fromW2);
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(denied.body.error.details?.inventoryCode).toBe('inventory.warehouse_out_of_scope');
    expect(mint, 'no assertion minted').not.toHaveBeenCalled();
    expect(s4Delta(before, await s5Counts(ownerPool(), A.businessId)), 'nothing written, no inventory_assertion_uses row').toEqual({});
    const ok = await t.request
      .post(`/v1/purchases/${p.purchaseId}/returns`)
      .set(as(must(actors.narrowY)))
      .send(fromW2);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ warehouseId: A.w2, purchaseId: p.purchaseId });
    // The W1-scoped actor returns from W1 — the purchase's own warehouse — and the W2-scoped one cannot.
    const fromW1 = returnBody(p, A.w1, '1');
    expect(
      (
        await t.request
          .post(`/v1/purchases/${p.purchaseId}/returns`)
          .set(as(must(actors.narrowY)))
          .send(fromW1)
      ).status,
    ).toBe(403);
    expect(
      (
        await t.request
          .post(`/v1/purchases/${p.purchaseId}/returns`)
          .set(as(must(actors.narrowX)))
          .send(fromW1)
      ).status,
    ).toBe(201);
  });

  it('TL-4: a reversal needs scope over the purchase warehouse: W2 purchase → 403, nothing minted; W1 purchase → 200', async () => {
    const receiverX = must(actors.narrowX);
    const outOfScope = await received(A, A.w2);
    const before = await s5Counts(ownerPool(), A.businessId);
    mint.mockClear();
    const denied = await t.request
      .post(`/v1/purchases/${outOfScope.purchaseId}/reversal`)
      .set(as(receiverX))
      .send({ reversalDate: day, reason: 'Wrong supplier' });
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(mint).not.toHaveBeenCalled();
    expect(s4Delta(before, await s5Counts(ownerPool(), A.businessId))).toEqual({});
    const inScope = await received(A, A.w1);
    const ok = await t.request.post(`/v1/purchases/${inScope.purchaseId}/reversal`).set(as(receiverX)).send({ reversalDate: day, reason: 'Wrong supplier' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('the credit-note list requires business-wide scope', async () => {
    const p = await received();
    const narrow = await t.request.get(`/v1/suppliers/${p.supplierId}/credit-notes`).set(as(must(actors.narrowX)));
    expect(narrow.status).toBe(403);
    expect(narrow.body.error.details?.inventoryCode).toBe('inventory.business_wide_scope_required');
    expect((await t.request.get(`/v1/suppliers/${p.supplierId}/credit-notes`).set(as(must(actors.supViewer)))).status).toBe(200);
  });
});

describe('T-18 isolation: the owner scoped to A reaches nothing of A2 (same owner) or B', () => {
  for (const which of ['A2', 'B'] as const) {
    it(`${which}: returns, reversal and reads answer 404, and nothing is written there; in ${which} itself they succeed`, async () => {
      const X = which === 'A2' ? A2 : B;
      const xOwner = which === 'A2' ? owner : bOwner;
      const theirs = await received(X, X.w1, xOwner);
      const theirReturn = await returned(theirs, X, xOwner);
      const theirCounts = await s5Counts(ownerPool(), X.businessId);
      const ours = await s5Counts(ownerPool(), A.businessId);
      mint.mockClear();
      const calls: [string, () => Promise<Response>][] = [
        ['return their purchase', () => t.request.post(`/v1/purchases/${theirs.purchaseId}/returns`).set(as(owner)).send(returnBody(theirs, A.w1))],
        [
          'reverse their purchase',
          () => t.request.post(`/v1/purchases/${theirs.purchaseId}/reversal`).set(as(owner)).send({ reversalDate: day, reason: 'Hijack' }),
        ],
        ['list their returns', () => t.request.get(`/v1/purchases/${theirs.purchaseId}/returns`).set(as(owner))],
        ['read their return', () => t.request.get(`/v1/supplier-returns/${theirReturn}`).set(as(owner))],
        ['their supplier credit notes', () => t.request.get(`/v1/suppliers/${theirs.supplierId}/credit-notes`).set(as(owner))],
      ];
      for (const [what, call] of calls) {
        const r = await call();
        expect(r.status, `${what} of ${which} from A: ${JSON.stringify(r.body)}`).toBe(404);
      }
      expect(s4Delta(theirCounts, await s5Counts(ownerPool(), X.businessId)), `${which} untouched`).toEqual({});
      // A refused command may mint (the service reads the purchase in A's scope first) but never consumes or writes in A.
      expect(s4Delta(ours, await s5Counts(ownerPool(), A.businessId)), 'A untouched').toEqual({});
      // ALLOW: in its own business the same reads succeed.
      expect((await t.request.get(`/v1/supplier-returns/${theirReturn}`).set(as(xOwner, X))).status).toBe(200);
      expect((await t.request.get(`/v1/purchases/${theirs.purchaseId}/returns`).set(as(xOwner, X))).status).toBe(200);
      const rev = await t.request
        .post(`/v1/purchases/${(await received(X, X.w1, xOwner)).purchaseId}/reversal`)
        .set(as(xOwner, X))
        .send({ reversalDate: day, reason: 'Own' });
      expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    });
  }
});
