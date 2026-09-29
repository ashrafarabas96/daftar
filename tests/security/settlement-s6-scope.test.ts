/**
 * P3-S6 T-20 — HTTP AUTHORITY AND SCOPE OF EVERY S6 ROUTE
 * (docs/PHASE_3_S6_CONTRACT.md A-03, A-18, AL-39, TL-5, §6 T-20).
 *
 * Through the real Nest application and the real database:
 *   - the permission matrix of A-03 / A-18, each DENY paired with the
 *     holder's ALLOW: the four method commands need `accounting.chart.manage`;
 *     a payment, a credit allocation and a refund need `suppliers.pay`;
 *     receive-and-pay needs `purchases.receive` AND `suppliers.pay`; the
 *     settlement reads need `suppliers.view`. A refused command is 403 with
 *     NO assertion minted and nothing written. The built-in manager (view
 *     keys only) and cashier hold none of the S6 command keys;
 *   - the payment-method reads admit ANY of `suppliers.pay`,
 *     `accounting.view`, `accounting.chart.manage`: `postingAccountId` is
 *     shown only to the two accounting keys and is ABSENT for a
 *     `suppliers.pay`-only reader; a member with none of the three is 403;
 *   - AL-39: an assigned-scope actor pays a purchase of its branch (201),
 *     but a payment touching an out-of-scope purchase is 403
 *     `inventory.warehouse_out_of_scope` before minting; receive-and-pay
 *     likewise on the purchase warehouse;
 *   - TL-5: the same actor's credit allocation and refund are 403
 *     `inventory.business_wide_scope_required` before minting, as is the
 *     supplier's payment list; a payment or a purchase's settlements outside
 *     its scope read as not found.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { InventoryAssertionMinterService } from '../../apps/api/src/modules/inventory/inventory-assertion.minter';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { asMember, must, onboardS3Business, registerActor, today, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import {
  allocateBody,
  httpDraft,
  httpMethod,
  httpPay,
  httpReceived,
  httpSupplier,
  methodBody,
  payBody,
  refundBody,
  refusalCode,
  returnToCredit,
  s6Counts,
  seedSettlementAccounts,
  type HttpPurchase,
  type SettlementAccounts,
} from '../helpers/supplier-settlement';

let t: TestApp;
let day: string;
let owner: HttpActor;
let A: S3Business;
let acc: SettlementAccounts;
let method: string;
let mint: MockInstance<InventoryAssertionMinterService['mint']>;
const actors: Record<string, HttpActor> = {};

/** Each custom actor holds exactly one key (nine registrations in all: the per-IP budget of the test app). */
const SINGLE: readonly (readonly [name: string, permission: string])[] = [
  ['payer', 'suppliers.pay'],
  ['acctViewer', 'accounting.view'],
  ['chartManager', 'accounting.chart.manage'],
  ['supViewer', 'suppliers.view'],
  ['receiver', 'purchases.receive'],
];

async function role(key: string, permissions: readonly string[]): Promise<void> {
  const r = await t.request.post('/v1/businesses/current/roles').set(asMember(owner, A.businessId)).send({ key, name: key, permissions });
  expect(r.status, `role ${key} ${JSON.stringify(r.body)}`).toBe(201);
}

async function member(a: HttpActor, roleKey: string): Promise<void> {
  const r = await t.request.post('/v1/businesses/current/members').set(asMember(owner, A.businessId)).send({ email: a.email, roleKey });
  expect(r.status, `member ${roleKey} ${JSON.stringify(r.body)}`).toBe(201);
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
  t = await createTestApp();
  owner = await registerActor(t, 'S6 scope owner');
  A = await onboardS3Business(t, owner, 's6scope');
  acc = await seedSettlementAccounts(ownerPool(), A);
  method = await httpMethod(t, owner, A, acc.settlement.bank, { systemType: 'bank_transfer' });
  for (const [name, permission] of SINGLE) {
    actors[name] = await registerActor(t, name);
    await role(`s6-${name.toLowerCase()}`, [permission]);
    await member(must(actors[name]), `s6-${name.toLowerCase()}`);
  }
  actors.manager = await registerActor(t, 'Built-in manager');
  actors.cashier = await registerActor(t, 'Built-in cashier');
  await member(must(actors.manager), 'manager');
  await member(must(actors.cashier), 'cashier');
  actors.narrowX = await registerActor(t, 'narrowX');
  await role('s6-narrowx', ['suppliers.pay', 'suppliers.view', 'purchases.receive', 'purchases.view']);
  await member(must(actors.narrowX), 's6-narrowx');
  const scoped = await t.request
    .patch(`/v1/businesses/current/members/${must(actors.narrowX).userId}/branch-scope`)
    .set(asMember(owner, A.businessId))
    .send({ mode: 'assigned', branchIds: [A.branchX] });
  expect(scoped.status).toBe(200);
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

const who = (name: string): HttpActor => must(actors[name], name);
const as = (a: HttpActor): Record<string, string> => asMember(a, A.businessId);
const state = (): Promise<Record<string, unknown>> => s6Counts(ownerPool(), A.businessId);

/** A 403 before the service minted anything, and nothing written. */
async function refusedBeforeMinting(send: () => Promise<Response>, why: string, code?: string): Promise<void> {
  // The fixtures above were made (and signed) by the owner; only this call counts.
  mint.mockClear();
  const before = await state();
  const r = await send();
  expect(r.status, `${why}: ${JSON.stringify(r.body)}`).toBe(403);
  if (code !== undefined) expect(refusalCode(r), why).toBe(code);
  expect(mint, `${why}: no assertion minted`).not.toHaveBeenCalled();
  expect(await state(), `${why}: nothing written`).toEqual(before);
  mint.mockClear();
}

// ── the commands ──────────────────────────────────────────────────────────

describe('T-20 A-03: the four method commands need accounting.chart.manage', () => {
  it('every other key and both built-in roles are 403 before minting; the holder creates, updates, deactivates, activates', async () => {
    for (const name of ['payer', 'acctViewer', 'supViewer', 'receiver', 'manager', 'cashier']) {
      const id = randomUUID();
      await refusedBeforeMinting(
        () =>
          t.request
            .post('/v1/payment-methods')
            .set(as(who(name)))
            .send({ ...methodBody(acc.settlement.cash), paymentMethodId: id }),
        `${name} creates`,
      );
      await refusedBeforeMinting(
        () =>
          t.request
            .put(`/v1/payment-methods/${method}`)
            .set(as(who(name)))
            .send({ expectedRevision: 1, postingAccountId: acc.settlement.bank, requiresReference: false, sortOrder: 5, names: { en: 'Bank' } }),
        `${name} updates`,
      );
      await refusedBeforeMinting(
        () =>
          t.request
            .post(`/v1/payment-methods/${method}/deactivate`)
            .set(as(who(name)))
            .send({ expectedRevision: 1 }),
        `${name} deactivates`,
      );
      await refusedBeforeMinting(
        () =>
          t.request
            .post(`/v1/payment-methods/${method}/activate`)
            .set(as(who(name)))
            .send({ expectedRevision: 1 }),
        `${name} activates`,
      );
    }
    const holder = who('chartManager');
    const body = methodBody(acc.settlement.cash, { names: { en: 'Till', ar: 'الصندوق' } });
    const id = String(body.paymentMethodId);
    const created = await t.request.post('/v1/payment-methods').set(as(holder)).send(body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(mint).toHaveBeenCalledTimes(1);
    const updated = await t.request
      .put(`/v1/payment-methods/${id}`)
      .set(as(holder))
      .send({ expectedRevision: 1, postingAccountId: acc.settlement.cash, requiresReference: true, sortOrder: 7, names: { en: 'Till 2' } });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    const off = await t.request.post(`/v1/payment-methods/${id}/deactivate`).set(as(holder)).send({ expectedRevision: 2 });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    const on = await t.request.post(`/v1/payment-methods/${id}/activate`).set(as(holder)).send({ expectedRevision: 3 });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body).toMatchObject({ revision: 4, isActive: true, postingAccountId: acc.settlement.cash });
  });
});

describe('T-20 A-18: the payment-method reads admit any of three keys', () => {
  it('suppliers.pay reads without postingAccountId; accounting.view and chart.manage read it; none of the three is 403', async () => {
    for (const name of ['payer', 'acctViewer', 'chartManager']) {
      const list = await t.request.get('/v1/payment-methods').set(as(who(name)));
      const one = await t.request.get(`/v1/payment-methods/${method}`).set(as(who(name)));
      expect([list.status, one.status], `${name}: ${JSON.stringify(one.body)}`).toEqual([200, 200]);
      const item = must((list.body as { items: Record<string, unknown>[] }).items.find((m) => m.paymentMethodId === method));
      const sees = name !== 'payer';
      for (const [what, dto] of [
        ['list', item],
        ['get', one.body as Record<string, unknown>],
      ] as const) {
        expect(Object.hasOwn(dto, 'postingAccountId'), `${name} ${what}: postingAccountId ${sees ? 'shown' : 'hidden'}`).toBe(sees);
        if (sees) expect(dto.postingAccountId).toBe(acc.settlement.bank);
        expect(dto).toMatchObject({ paymentMethodId: method, systemType: 'bank_transfer', isActive: true });
      }
    }
    for (const name of ['supViewer', 'receiver', 'manager', 'cashier']) {
      const list = await t.request.get('/v1/payment-methods').set(as(who(name)));
      const one = await t.request.get(`/v1/payment-methods/${method}`).set(as(who(name)));
      expect([list.status, one.status], `${name} holds none of the three`).toEqual([403, 403]);
      expect(JSON.stringify(one.body)).not.toContain(acc.settlement.bank);
    }
  });
});

describe('T-20 A-03: settlement commands need suppliers.pay', () => {
  it('payment, credit allocation and refund: every other key is 403 before minting; the payer succeeds', async () => {
    const note = await returnToCredit(t, owner, A, method, { lines: [{ productId: A.piece.productId, quantity: '2', unitPrice: '50.00' }], quantity: '2' });
    const p = await httpReceived(t, owner, A, { supplierId: note.purchase.supplierId });
    for (const name of ['acctViewer', 'chartManager', 'supViewer', 'receiver', 'manager', 'cashier']) {
      const a = who(name);
      await refusedBeforeMinting(
        () => httpPay(t, a, A, payBody(p.supplierId, method, day, [{ purchaseId: p.purchaseId, paymentAmountMinor: '100' }])),
        `${name} pays`,
      );
      await refusedBeforeMinting(
        () =>
          t.request
            .post('/v1/supplier-credit-allocations')
            .set(as(a))
            .send(allocateBody(note.creditNoteId, p.purchaseId, day, '100')),
        `${name} allocates`,
      );
      await refusedBeforeMinting(
        () =>
          t.request
            .post('/v1/supplier-refunds')
            .set(as(a))
            .send(refundBody(note.creditNoteId, method, day, '100')),
        `${name} refunds`,
      );
    }
    const payer = who('payer');
    const paid = await httpPay(t, payer, A, payBody(p.supplierId, method, day, [{ purchaseId: p.purchaseId, paymentAmountMinor: '100' }]));
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const allocated = await t.request
      .post('/v1/supplier-credit-allocations')
      .set(as(payer))
      .send(allocateBody(note.creditNoteId, p.purchaseId, day, '100'));
    expect(allocated.status, JSON.stringify(allocated.body)).toBe(201);
    const refunded = await t.request
      .post('/v1/supplier-refunds')
      .set(as(payer))
      .send(refundBody(note.creditNoteId, method, day, '100'));
    expect(refunded.status, JSON.stringify(refunded.body)).toBe(201);
    expect(mint, 'each command signed once').toHaveBeenCalledTimes(3);
  });

  it('receive-and-pay needs purchases.receive AND suppliers.pay: either alone is 403 before minting, the draft untouched', async () => {
    const body = (): Record<string, unknown> => ({
      draftRevision: 1,
      payment: { paymentId: randomUUID(), allocationId: randomUUID(), paymentMethodId: method, currencyCode: 'ILS', amountMinor: '5000' },
    });
    const d = await httpDraft(t, owner, A);
    for (const name of ['payer', 'receiver', 'supViewer', 'manager', 'cashier']) {
      await refusedBeforeMinting(
        () =>
          t.request
            .post(`/v1/purchases/${d.purchaseId}/receive-and-pay`)
            .set(as(who(name)))
            .send(body()),
        `${name} receives and pays`,
      );
    }
    const status = await ownerPool().query<{ status: string }>(`SELECT status FROM purchases WHERE business_id = $1 AND id = $2`, [A.businessId, d.purchaseId]);
    expect(must(status.rows[0]).status).toBe('draft');
    const ok = await t.request.post(`/v1/purchases/${d.purchaseId}/receive-and-pay`).set(as(owner)).send(body());
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(mint, 'the receipt and the payment each signed once').toHaveBeenCalledTimes(2);
  });

  it('the settlement reads need suppliers.view: the viewer and the manager read, the payer and the cashier are 403', async () => {
    const p = await httpReceived(t, owner, A);
    const body = payBody(p.supplierId, method, day, [{ purchaseId: p.purchaseId, paymentAmountMinor: '100' }]);
    expect((await httpPay(t, owner, A, body)).status).toBe(201);
    const paths = [`/v1/supplier-payments/${String(body.paymentId)}`, `/v1/suppliers/${p.supplierId}/payments`, `/v1/purchases/${p.purchaseId}/settlements`];
    for (const path of paths) {
      for (const name of ['supViewer', 'manager']) expect((await t.request.get(path).set(as(who(name)))).status, `${name} ${path}`).toBe(200);
      for (const name of ['payer', 'acctViewer', 'cashier']) expect((await t.request.get(path).set(as(who(name)))).status, `${name} ${path}`).toBe(403);
    }
  });
});

// ── AL-39 and TL-5 ────────────────────────────────────────────────────────

describe('T-20 AL-39 / TL-5: an assigned-scope actor', () => {
  let px: HttpPurchase;
  let py: HttpPurchase;

  beforeAll(async () => {
    const supplierId = await httpSupplier(t, owner, A);
    px = await httpReceived(t, owner, A, { supplierId, warehouseId: A.w1 });
    py = await httpReceived(t, owner, A, { supplierId, warehouseId: A.w2 });
  });

  it('pays a purchase of its branch (201); a payment touching an out-of-scope purchase is 403 warehouse_out_of_scope before minting', async () => {
    const narrow = who('narrowX');
    await refusedBeforeMinting(
      () => httpPay(t, narrow, A, payBody(px.supplierId, method, day, [{ purchaseId: py.purchaseId, paymentAmountMinor: '100' }])),
      'narrowX pays a branch-Y purchase',
      'inventory.warehouse_out_of_scope',
    );
    await refusedBeforeMinting(
      () =>
        httpPay(
          t,
          narrow,
          A,
          payBody(px.supplierId, method, day, [
            { purchaseId: px.purchaseId, paymentAmountMinor: '100' },
            { purchaseId: py.purchaseId, paymentAmountMinor: '100' },
          ]),
        ),
      'narrowX pays X and Y in one payment',
      'inventory.warehouse_out_of_scope',
    );
    const ok = await httpPay(t, narrow, A, payBody(px.supplierId, method, day, [{ purchaseId: px.purchaseId, paymentAmountMinor: '100' }]));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('receive-and-pay on an out-of-scope draft is 403 before minting; on its own branch it is 200', async () => {
    const narrow = who('narrowX');
    const body = (): Record<string, unknown> => ({
      draftRevision: 1,
      payment: { paymentId: randomUUID(), allocationId: randomUUID(), paymentMethodId: method, currencyCode: 'ILS', amountMinor: '5000' },
    });
    const dy = await httpDraft(t, owner, A, { warehouseId: A.w2 });
    await refusedBeforeMinting(
      () => t.request.post(`/v1/purchases/${dy.purchaseId}/receive-and-pay`).set(as(narrow)).send(body()),
      'narrowX receives and pays on W2',
      'inventory.warehouse_out_of_scope',
    );
    const dx = await httpDraft(t, owner, A, { warehouseId: A.w1 });
    const ok = await t.request.post(`/v1/purchases/${dx.purchaseId}/receive-and-pay`).set(as(narrow)).send(body());
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('a credit allocation and a refund are 403 business_wide_scope_required before minting — even on its own branch', async () => {
    const narrow = who('narrowX');
    const note = await returnToCredit(t, owner, A, method, { warehouseId: A.w1, lines: [{ productId: A.piece.productId, quantity: '2', unitPrice: '50.00' }] });
    const target = await httpReceived(t, owner, A, { supplierId: note.purchase.supplierId, warehouseId: A.w1 });
    await refusedBeforeMinting(
      () =>
        t.request
          .post('/v1/supplier-credit-allocations')
          .set(as(narrow))
          .send(allocateBody(note.creditNoteId, target.purchaseId, day, '100')),
      'narrowX allocates',
      'inventory.business_wide_scope_required',
    );
    await refusedBeforeMinting(
      () =>
        t.request
          .post('/v1/supplier-refunds')
          .set(as(narrow))
          .send(refundBody(note.creditNoteId, method, day, '100')),
      'narrowX refunds',
      'inventory.business_wide_scope_required',
    );
    // The business-wide holder of the same key succeeds (the pair of the DENY).
    const payer = who('payer');
    expect(
      (
        await t.request
          .post('/v1/supplier-credit-allocations')
          .set(as(payer))
          .send(allocateBody(note.creditNoteId, target.purchaseId, day, '100'))
      ).status,
    ).toBe(201);
    expect(
      (
        await t.request
          .post('/v1/supplier-refunds')
          .set(as(payer))
          .send(refundBody(note.creditNoteId, method, day, '100'))
      ).status,
    ).toBe(201);
  });

  it('reads: an out-of-scope payment or purchase reads as not found; the supplier’s payment list needs business-wide scope', async () => {
    const narrow = who('narrowX');
    const onX = payBody(px.supplierId, method, day, [{ purchaseId: px.purchaseId, paymentAmountMinor: '100' }]);
    const onY = payBody(px.supplierId, method, day, [{ purchaseId: py.purchaseId, paymentAmountMinor: '100' }]);
    const onBoth = payBody(px.supplierId, method, day, [
      { purchaseId: px.purchaseId, paymentAmountMinor: '100' },
      { purchaseId: py.purchaseId, paymentAmountMinor: '100' },
    ]);
    for (const b of [onX, onY, onBoth]) expect((await httpPay(t, owner, A, b)).status).toBe(201);
    expect((await t.request.get(`/v1/supplier-payments/${String(onX.paymentId)}`).set(as(narrow))).status).toBe(200);
    expect((await t.request.get(`/v1/supplier-payments/${String(onY.paymentId)}`).set(as(narrow))).status).toBe(404);
    expect((await t.request.get(`/v1/supplier-payments/${String(onBoth.paymentId)}`).set(as(narrow))).status, 'partly out of scope').toBe(404);
    expect((await t.request.get(`/v1/purchases/${px.purchaseId}/settlements`).set(as(narrow))).status).toBe(200);
    expect((await t.request.get(`/v1/purchases/${py.purchaseId}/settlements`).set(as(narrow))).status).toBe(404);
    const list = await t.request.get(`/v1/suppliers/${px.supplierId}/payments`).set(as(narrow));
    expect({ status: list.status, code: refusalCode(list) }).toEqual({ status: 403, code: 'inventory.business_wide_scope_required' });
    const credit = await t.request.get(`/v1/suppliers/${px.supplierId}/credit-notes`).set(as(narrow));
    expect({ status: credit.status, code: refusalCode(credit) }).toEqual({ status: 403, code: 'inventory.business_wide_scope_required' });
    expect((await t.request.get(`/v1/suppliers/${px.supplierId}/payments`).set(as(who('supViewer')))).status).toBe(200);
  });
});
