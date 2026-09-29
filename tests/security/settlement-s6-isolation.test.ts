/**
 * P3-S6 — TENANT AND SECOND-BUSINESS ISOLATION OF EVERY S6 ROUTE AND ROUTINE
 * (docs/PHASE_3_S6_CONTRACT.md A-02, A-18, §2.7; AL-15 §B).
 *
 * Three businesses: A and A2 belong to ONE owner in ONE tenant; B is another
 * owner's, in another tenant.
 *
 * HTTP: the owner, acting in A2, names A's method, supplier, purchase,
 * credit note, payment or draft in each of the eleven S6 routes — every one
 * reads as not found (404, or the FK code for a posting account), writes
 * nothing in A, A2 or B; the same call naming A2's own objects succeeds
 * (the ALLOW beside each DENY). B's owner, in B, is refused A's objects the
 * same way, and presenting A's business id is 403 (no membership).
 *
 * SQL: each of the seven routines, called under an HONEST assertion and the
 * scope of A2 (and of B) over arguments naming A's rows, is refused
 * (`….not_found`), while the same routine over A2's own rows succeeds.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import {
  asMember,
  expectAccepted,
  must,
  onboardS3Business,
  refusedWith,
  registerActor,
  rolledBack,
  today,
  type HttpActor,
  type S3Business,
} from '../helpers/inventory-commands';
import { receivedPurchase } from '../helpers/purchase-returns';
import {
  allocateBody,
  createMethod,
  httpDraft,
  httpMethod,
  httpPay,
  httpReceived,
  methodBody,
  methodCreateCall,
  methodLifecycleCall,
  methodUpdateCall,
  payBody,
  prepareAllocate,
  preparePay,
  prepareRefund,
  refundBody,
  refusalCode,
  returnToCredit,
  s6Counts,
  seedSettlementAccounts,
  sqlReturnToCredit,
  tryS6,
  type HttpPurchase,
  type S6Call,
  type SettlementAccounts,
} from '../helpers/supplier-settlement';

let t: TestApp;
let day: string;
let owner: HttpActor;
let bOwner: HttpActor;
let A: S3Business;
let A2: S3Business;
let B: S3Business;

/** One business's S6 world, made through the API by its owner. */
interface World {
  readonly biz: S3Business;
  readonly by: HttpActor;
  readonly acc: SettlementAccounts;
  readonly method: string;
  readonly purchase: HttpPurchase;
  readonly creditNoteId: string;
  readonly paymentId: string;
}

const worlds: Record<'A' | 'A2' | 'B', World | undefined> = { A: undefined, A2: undefined, B: undefined };
const w = (k: 'A' | 'A2' | 'B'): World => must(worlds[k], k);

async function world(biz: S3Business, by: HttpActor): Promise<World> {
  const acc = await seedSettlementAccounts(ownerPool(), biz);
  const method = await httpMethod(t, by, biz, acc.settlement.bank, { systemType: 'bank_transfer' });
  const note = await returnToCredit(t, by, biz, method, { lines: [{ productId: biz.piece.productId, quantity: '2', unitPrice: '50.00' }], quantity: '2' });
  const purchase = await httpReceived(t, by, biz, { supplierId: note.purchase.supplierId });
  const body = payBody(purchase.supplierId, method, day, [{ purchaseId: purchase.purchaseId, paymentAmountMinor: '100' }]);
  const paid = await httpPay(t, by, biz, body);
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  return { biz, by, acc, method, purchase, creditNoteId: note.creditNoteId, paymentId: String(body.paymentId) };
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
  t = await createTestApp();
  owner = await registerActor(t, 'S6 isolation owner');
  bOwner = await registerActor(t, 'S6 isolation other owner');
  A = await onboardS3Business(t, owner, 's6isoA');
  A2 = await onboardS3Business(t, owner, 's6isoA2', A.tenantId);
  B = await onboardS3Business(t, bOwner, 's6isoB');
  expect(A2.tenantId).toBe(A.tenantId);
  expect(B.tenantId).not.toBe(A.tenantId);
  worlds.A = await world(A, owner);
  worlds.A2 = await world(A2, owner);
  worlds.B = await world(B, bOwner);
});

afterAll(async () => {
  await t.close();
  await resetData();
});

async function everything(): Promise<Record<string, unknown>[]> {
  return [await s6Counts(ownerPool(), A.businessId), await s6Counts(ownerPool(), A2.businessId), await s6Counts(ownerPool(), B.businessId)];
}

/** A request that must read as not found (or the named code) and write nothing anywhere. */
async function hidden(send: () => Promise<Response>, why: string, status = 404, code?: RegExp): Promise<void> {
  const before = await everything();
  const r = await send();
  expect(r.status, `${why}: ${JSON.stringify(r.body)}`).toBe(status);
  // A domain refusal carries its stable code in the details; a plain not-found only the error code.
  const said = refusalCode(r) ?? (r.body as { error?: { code?: string } }).error?.code ?? '';
  if (code !== undefined) expect(said, why).toMatch(code);
  expect(JSON.stringify(r.body), `${why}: nothing of A leaks`).not.toContain(w('A').acc.settlement.bank);
  expect(await everything(), `${why}: nothing written in A, A2 or B`).toEqual(before);
}

const NOT_FOUND = /\.not_found$|^NOT_FOUND$/;

/** Every S6 route, from `from` (acting as its owner), naming the `target` world's objects where `own` would name its own. */
async function routes(from: World, target: World): Promise<readonly (readonly [string, () => Promise<Response>, number, RegExp | undefined])[]> {
  const h = asMember(from.by, from.biz.businessId);
  // The caller's own draft, made before any request is judged.
  const draft = await httpDraft(t, from.by, from.biz);
  const rp = (draft: HttpPurchase, methodId: string): Promise<Response> =>
    t.request
      .post(`/v1/purchases/${draft.purchaseId}/receive-and-pay`)
      .set(h)
      .send({
        draftRevision: 1,
        payment: { paymentId: randomUUID(), allocationId: randomUUID(), paymentMethodId: methodId, currencyCode: 'ILS', amountMinor: '5000' },
      });
  return [
    ['GET a method', () => t.request.get(`/v1/payment-methods/${target.method}`).set(h), 404, NOT_FOUND],
    [
      'PUT a method',
      () =>
        t.request
          .put(`/v1/payment-methods/${target.method}`)
          .set(h)
          .send({ expectedRevision: 1, postingAccountId: from.acc.settlement.bank, requiresReference: false, sortOrder: 3, names: { en: 'X' } }),
      404,
      NOT_FOUND,
    ],
    ['deactivate a method', () => t.request.post(`/v1/payment-methods/${target.method}/deactivate`).set(h).send({ expectedRevision: 1 }), 404, NOT_FOUND],
    ['activate a method', () => t.request.post(`/v1/payment-methods/${target.method}/activate`).set(h).send({ expectedRevision: 1 }), 404, NOT_FOUND],
    [
      'create a method on the other business’s account',
      () => t.request.post('/v1/payment-methods').set(h).send(methodBody(target.acc.settlement.cash)),
      422,
      /^payment_method\.posting_account_not_found$/,
    ],
    [
      'pay the other business’s purchase',
      () =>
        httpPay(
          t,
          from.by,
          from.biz,
          payBody(target.purchase.supplierId, from.method, day, [{ purchaseId: target.purchase.purchaseId, paymentAmountMinor: '100' }]),
        ),
      404,
      NOT_FOUND,
    ],
    [
      'pay through the other business’s method',
      () =>
        httpPay(
          t,
          from.by,
          from.biz,
          payBody(from.purchase.supplierId, target.method, day, [{ purchaseId: from.purchase.purchaseId, paymentAmountMinor: '100' }]),
        ),
      404,
      NOT_FOUND,
    ],
    [
      'allocate the other business’s note',
      () =>
        t.request
          .post('/v1/supplier-credit-allocations')
          .set(h)
          .send(allocateBody(target.creditNoteId, from.purchase.purchaseId, day, '100')),
      404,
      NOT_FOUND,
    ],
    [
      'allocate onto the other business’s purchase',
      () =>
        t.request
          .post('/v1/supplier-credit-allocations')
          .set(h)
          .send(allocateBody(from.creditNoteId, target.purchase.purchaseId, day, '100')),
      404,
      NOT_FOUND,
    ],
    [
      'refund the other business’s note',
      () =>
        t.request
          .post('/v1/supplier-refunds')
          .set(h)
          .send(refundBody(target.creditNoteId, from.method, day, '100')),
      404,
      NOT_FOUND,
    ],
    [
      'refund through the other business’s method',
      () =>
        t.request
          .post('/v1/supplier-refunds')
          .set(h)
          .send(refundBody(from.creditNoteId, target.method, day, '100')),
      404,
      NOT_FOUND,
    ],
    ['receive-and-pay through the other business’s method', () => rp(draft, target.method), 404, NOT_FOUND],
    ['GET the other business’s payment', () => t.request.get(`/v1/supplier-payments/${target.paymentId}`).set(h), 404, NOT_FOUND],
    ['list the other business’s supplier’s payments', () => t.request.get(`/v1/suppliers/${target.purchase.supplierId}/payments`).set(h), 404, NOT_FOUND],
    ['the other business’s purchase settlements', () => t.request.get(`/v1/purchases/${target.purchase.purchaseId}/settlements`).set(h), 404, NOT_FOUND],
  ];
}

describe('S6 isolation over HTTP', () => {
  it('A2 (same owner, same tenant) reaches none of A’s S6 objects; the same calls on A2’s own succeed', async () => {
    for (const [what, send, status, code] of await routes(w('A2'), w('A'))) await hidden(send, `A2 → A: ${what}`, status, code);
    // Receive-and-pay on A's draft, from A2.
    const drafted = await httpDraft(t, owner, A);
    await hidden(
      () =>
        t.request
          .post(`/v1/purchases/${drafted.purchaseId}/receive-and-pay`)
          .set(asMember(owner, A2.businessId))
          .send({
            draftRevision: 1,
            payment: { paymentId: randomUUID(), allocationId: randomUUID(), paymentMethodId: w('A2').method, currencyCode: 'ILS', amountMinor: '5000' },
          }),
      'A2 → A: receive-and-pay A’s draft',
      404,
      NOT_FOUND,
    );
    // The method list of A2 does not name A's method.
    const list = await t.request.get('/v1/payment-methods').set(asMember(owner, A2.businessId));
    expect((list.body as { items: { paymentMethodId: string }[] }).items.map((m) => m.paymentMethodId)).not.toContain(w('A').method);
  });

  it('the ALLOW: the same routes over A2’s own objects', async () => {
    const x = w('A2');
    const h = asMember(owner, A2.businessId);
    expect((await t.request.get(`/v1/payment-methods/${x.method}`).set(h)).status).toBe(200);
    const created = methodBody(x.acc.settlement.cash);
    expect((await t.request.post('/v1/payment-methods').set(h).send(created)).status).toBe(201);
    const id = String(created.paymentMethodId);
    expect(
      (
        await t.request
          .put(`/v1/payment-methods/${id}`)
          .set(h)
          .send({ expectedRevision: 1, postingAccountId: x.acc.settlement.cash, requiresReference: false, sortOrder: 3, names: { en: 'X' } })
      ).status,
    ).toBe(200);
    expect((await t.request.post(`/v1/payment-methods/${id}/deactivate`).set(h).send({ expectedRevision: 2 })).status).toBe(200);
    expect((await t.request.post(`/v1/payment-methods/${id}/activate`).set(h).send({ expectedRevision: 3 })).status).toBe(200);
    const p = await httpReceived(t, owner, A2, { supplierId: x.purchase.supplierId });
    expect((await httpPay(t, owner, A2, payBody(p.supplierId, x.method, day, [{ purchaseId: p.purchaseId, paymentAmountMinor: '100' }]))).status).toBe(201);
    expect(
      (
        await t.request
          .post('/v1/supplier-credit-allocations')
          .set(h)
          .send(allocateBody(x.creditNoteId, p.purchaseId, day, '100'))
      ).status,
    ).toBe(201);
    expect(
      (
        await t.request
          .post('/v1/supplier-refunds')
          .set(h)
          .send(refundBody(x.creditNoteId, x.method, day, '100'))
      ).status,
    ).toBe(201);
    const d = await httpDraft(t, owner, A2);
    const rp = await t.request
      .post(`/v1/purchases/${d.purchaseId}/receive-and-pay`)
      .set(h)
      .send({
        draftRevision: 1,
        payment: { paymentId: randomUUID(), allocationId: randomUUID(), paymentMethodId: x.method, currencyCode: 'ILS', amountMinor: '5000' },
      });
    expect(rp.status, JSON.stringify(rp.body)).toBe(200);
    expect((await t.request.get(`/v1/supplier-payments/${x.paymentId}`).set(h)).status).toBe(200);
    expect((await t.request.get(`/v1/suppliers/${x.purchase.supplierId}/payments`).set(h)).status).toBe(200);
    expect((await t.request.get(`/v1/purchases/${x.purchase.purchaseId}/settlements`).set(h)).status).toBe(200);
  });

  it('B (another tenant) reaches none of A’s S6 objects; presenting A’s business is 403', async () => {
    for (const [what, send, status, code] of await routes(w('B'), w('A'))) await hidden(send, `B → A: ${what}`, status, code);
    const a = w('A');
    const asA = asMember(bOwner, A.businessId);
    for (const [what, send] of [
      ['GET a method', () => t.request.get(`/v1/payment-methods/${a.method}`).set(asA)],
      [
        'pay',
        () =>
          t.request
            .post('/v1/supplier-payments')
            .set(asA)
            .send(payBody(a.purchase.supplierId, a.method, day, [{ purchaseId: a.purchase.purchaseId, paymentAmountMinor: '100' }])),
      ],
      [
        'refund',
        () =>
          t.request
            .post('/v1/supplier-refunds')
            .set(asA)
            .send(refundBody(a.creditNoteId, a.method, day, '100')),
      ],
      ['GET a payment', () => t.request.get(`/v1/supplier-payments/${a.paymentId}`).set(asA)],
    ] as const) {
      await hidden(send, `B’s owner presenting A: ${what}`, 403);
    }
  });
});

describe('S6 isolation at the routines', () => {
  /** Every routine bound over A's rows, run under the honest assertion and scope of `from`: refused; over `from`'s own rows: accepted. */
  async function routinesIsolated(from: S3Business, fromAcc: SettlementAccounts): Promise<void> {
    // A's rows, committed by the API fixtures; bound as A's services bind them.
    const tw = w('A');
    const target = A;
    const targetAcc = tw.acc;
    await rolledBack(async (c) => {
      const deny: [string, S6Call][] = [
        ['method_update', methodUpdateCall(from, tw.method, 1, { postingAccountId: fromAcc.settlement.bank })],
        ['method_deactivate', methodLifecycleCall(from, 'method_deactivate', tw.method, 1)],
        ['method_activate', methodLifecycleCall(from, 'method_activate', tw.method, 1)],
        [
          'pay',
          await preparePay(c, target, {
            supplierId: tw.purchase.supplierId,
            paymentMethodId: tw.method,
            allocations: [{ purchaseId: tw.purchase.purchaseId, paymentAmountMinor: 100n }],
          }),
        ],
        ['allocate_credit', await prepareAllocate(c, target, { creditNoteId: tw.creditNoteId, purchaseId: tw.purchase.purchaseId, consumedMinor: 100n })],
        ['receive_refund', await prepareRefund(c, target, { creditNoteId: tw.creditNoteId, paymentMethodId: tw.method, consumedMinor: 100n })],
      ];
      for (const [what, call] of deny) {
        const o = await tryS6(c, from, call, { post: false });
        refusedWith(o, 'P0001', null, `${what} over the other business’s rows`);
        if (!o.ok) expect(o.code, what).toMatch(NOT_FOUND);
      }
      const create = await tryS6(c, from, methodCreateCall(from, { postingAccountId: targetAcc.settlement.cash }), { post: false });
      refusedWith(create, 'P0001', 'payment_method.posting_account_not_found', 'method_create on the other business’s account');
    });
    // The ALLOW: the same seven over the caller's own rows.
    await rolledBack(async (c) => {
      const m = await createMethod(c, from, { postingAccountId: fromAcc.settlement.bank });
      expectAccepted(await tryS6(c, from, methodUpdateCall(from, m, 1, { postingAccountId: fromAcc.settlement.cash })), 'method_update');
      expectAccepted(await tryS6(c, from, methodLifecycleCall(from, 'method_deactivate', m, 2)), 'method_deactivate');
      expectAccepted(await tryS6(c, from, methodLifecycleCall(from, 'method_activate', m, 3)), 'method_activate');
      const n = await sqlReturnToCredit(c, from, m, { qty: '2', unitPriceMinor: '5000' });
      const p = await receivedPurchase(c, from, [{ variantId: from.piece.variantId, qty: '1', unitPriceMinor: '10000' }], {
        supplierId: n.purchase.supplierId,
      });
      expectAccepted(
        await tryS6(
          c,
          from,
          await preparePay(c, from, { supplierId: p.supplierId, paymentMethodId: m, allocations: [{ purchaseId: p.purchaseId, paymentAmountMinor: 100n }] }),
        ),
        'pay',
      );
      expectAccepted(
        await tryS6(c, from, await prepareAllocate(c, from, { creditNoteId: n.creditNoteId, purchaseId: p.purchaseId, consumedMinor: 100n })),
        'allocate_credit',
      );
      expectAccepted(
        await tryS6(c, from, await prepareRefund(c, from, { creditNoteId: n.creditNoteId, paymentMethodId: m, consumedMinor: 100n })),
        'receive_refund',
      );
    });
  }

  it('A2 (same owner, same tenant) over A’s rows: every routine refused not_found; over its own: accepted', async () => {
    const before = await everything();
    await routinesIsolated(A2, w('A2').acc);
    expect(await everything()).toEqual(before);
  });

  it('B (another tenant) over A’s rows: every routine refused not_found; over its own: accepted', async () => {
    const before = await everything();
    await routinesIsolated(B, w('B').acc);
    expect(await everything()).toEqual(before);
  });
});
