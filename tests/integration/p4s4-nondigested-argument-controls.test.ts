/**
 * P4-S4 — THE NEGATIVE CONTROLS FOR THE REPLAY-BEFORE-JUDGEMENT SHAPE.
 *
 * `p4s4-credit-application-customer-replay.test.ts` is the defect:
 * `customerId` is a body key the intent digest cannot carry, and it was judged
 * after the replay branch. `p4s4-checkout-owner-replay.test.ts` and
 * `p4s4-sale-commit-permission-replay.test.ts` are the same shape on two more
 * routes. This suite is the other side of the sweep: the commands the reading
 * says are SAFE, proved safe BY EXECUTION rather than by reading, so a later
 * edit that reorders one of them is red here.
 *
 * Each case delivers a lawful command and then re-delivers it under the same
 * idempotency key with the one argument the digest is claimed to carry
 * CHANGED. A command whose digest really covers that argument answers a
 * CONFLICT. A command that answered `replayed: true` would be the defect.
 *
 *   §A `customer.collect_payment` — `customerId`. The routine signs
 *      `p_customer_id::text` into the stored intent (`0081:1901`) and
 *      `receivables-payload.ts:305` reproduces it, so the two sides agree and
 *      a second delivery naming a different customer is a different command.
 *      This is the control the credit application does NOT have, and the
 *      reason the credit application's fix had to be the ORDER: its routine
 *      signs six fields and takes no customer at all.
 *
 *   §B `pos.session_open` — THE ACTOR. `pos_till_sessions.opened_by` is the
 *      `invctl/1` assertion's actor and is in no payload grammar, so the
 *      digest cannot carry it — and `0079:933-936` judges it INSIDE the
 *      replay arm, before `v_replay := true`. A colleague presenting the first
 *      cashier's own open intent is `pos.session_not_owned`, not a replay.
 *
 *   §C `pos.session_close` — THE ACTOR again, judged BEFORE the status arm
 *      that answers the replay (`0079:1012-1015`).
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, resetData, type TestApp } from '../helpers/test-app';
import { asMember } from '../helpers/inventory-commands';
import { collectPayment, refusalCode, type AllocationInput } from '../golden-regression/phase4-s4/settlement-path';
import { newCustomer, sellOnCredit, settlementMissing, settlementWorld, stockUp, type SettlementWorld } from '../golden-regression/phase4-s4/settlement-world';
import { refusalCode as posRefusalCode, seedCheckoutShop, type CheckoutShop } from '../helpers/till-checkout';
import { terminalCode } from '../helpers/pos-till-sessions';

let t: TestApp;
let w: SettlementWorld;
let missing: readonly string[] = [];

/** §A */
let payFirst: Response | undefined;
let payWrongCustomer: Response | undefined;
let payIdentical: Response | undefined;

/** §B, §C */
let shop: CheckoutShop;
let openByColleague: Response | undefined;
let openOwnReplay: Response | undefined;
let closeFirst: Response | undefined;
let closeByColleague: Response | undefined;
let closeOwnReplay: Response | undefined;

function leg(inv: { invoiceId: string; totalTxnMinor: string; totalBaseMinor: string }, appliedMinor: bigint): AllocationInput {
  return {
    invoiceId: inv.invoiceId,
    appliedMinor: appliedMinor.toString(),
    releasedBeforeMinor: '0',
    invoiceTotalTxnMinor: inv.totalTxnMinor,
    invoiceTotalBaseMinor: inv.totalBaseMinor,
  };
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();

  // ── §A, on the receivables world ───────────────────────────────────────
  w = await settlementWorld('s4nondigest');
  missing = await settlementMissing(w);
  if (missing.length === 0) {
    await stockUp(w, '100', '6');
    const owner = await newCustomer(w);
    const stranger = await newCustomer(w);
    const invoice = await sellOnCredit(w, owner, '2');
    const paymentId = randomUUID();
    const body = {
      paymentId,
      paymentMethodId: w.paymentMethodId,
      paymentDate: w.day,
      amountMinor: invoice.totalTxnMinor,
      allocations: [leg(invoice, BigInt(invoice.totalTxnMinor))],
    } as const;
    payFirst = await collectPayment(w.t, w.headers, { ...body, customerId: owner });
    payWrongCustomer = await collectPayment(w.t, w.headers, { ...body, customerId: stranger });
    payIdentical = await collectPayment(w.t, w.headers, { ...body, customerId: owner });
  }
  await w?.t?.close();

  // ── §B and §C, on the POS world ────────────────────────────────────────
  await resetData();
  t = await createTestApp();
  shop = await seedCheckoutShop(t, 'nondigestpos');
  const openBody = {
    sessionId: randomUUID(),
    branchId: shop.business.branchX,
    warehouseId: shop.business.w1,
    terminalCode: terminalCode('ndg2'),
    openingFloatMinor: '5000',
  };
  const open = (by: CheckoutShop['cashier']): Promise<Response> =>
    t.request.post('/v1/pos/till-sessions').set(asMember(by, shop.business.businessId)).send(openBody) as unknown as Promise<Response>;
  // The owner's open first; `seedCheckoutShop` already holds one open session
  // for `cashier`, so this second one is opened by the COLLEAGUE, whose own
  // intent is then presented back by the first cashier.
  const first = await open(shop.colleague);
  expect(first.status, `the control's own open was refused: ${JSON.stringify(first.body)}`).toBeLessThan(300);
  openByColleague = await open(shop.cashier);
  openOwnReplay = await open(shop.colleague);

  const closeBody = { closingCountMinor: '5000' };
  const close = (by: CheckoutShop['cashier']): Promise<Response> =>
    t.request
      .post(`/v1/pos/till-sessions/${openBody.sessionId}/close`)
      .set(asMember(by, shop.business.businessId))
      .send(closeBody) as unknown as Promise<Response>;
  closeFirst = await close(shop.colleague);
  closeByColleague = await close(shop.cashier);
  closeOwnReplay = await close(shop.colleague);
}, 600_000);

afterAll(async () => {
  await t?.close();
  await resetData();
});

describe('§A customer.collect_payment: customerId IS digested, so a different customer is a CONFLICT', () => {
  it('the slice is present, so nothing below is vacuous', () => {
    expect(missing, 'the P4-S4 settlement surface is incomplete').toEqual([]);
  });

  it('the lawful payment commits', () => {
    const res = payFirst as Response;
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect((res.body as { replayed: boolean }).replayed).toBe(false);
  });

  it('the same payment id naming a DIFFERENT customer is refused idempotency_conflict, never answered as a replay', () => {
    const res = payWrongCustomer as Response;
    expect((res.body as { replayed?: boolean }).replayed, `measured ${res.status} ${JSON.stringify(res.body)}`).not.toBe(true);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(refusalCode(res, 'customer_payment.idempotency_conflict'), JSON.stringify(res.body)).toBe('customer_payment.idempotency_conflict');
  });

  it('and the byte-identical second delivery still REPLAYS', () => {
    const res = payIdentical as Response;
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body as { replayed: boolean }).replayed).toBe(true);
  });
});

describe('§B pos.session_open: the ACTOR is not digestible, and is judged INSIDE the replay arm', () => {
  it('a colleague presenting the session owner’s own open intent is pos.session_not_owned, not a replay', () => {
    const res = openByColleague as Response;
    expect((res.body as { replayed?: boolean }).replayed, `measured ${res.status} ${JSON.stringify(res.body)}`).not.toBe(true);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(posRefusalCode(res.body), JSON.stringify(res.body)).toBe('pos.session_not_owned');
  });

  it('and the owner’s byte-identical second open still replays', () => {
    const res = openOwnReplay as Response;
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  });
});

describe('§C pos.session_close: the ACTOR is judged BEFORE the status arm that answers the replay', () => {
  it('the owner closes her own shift', () => {
    const res = closeFirst as Response;
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('a colleague presenting the same close intent is pos.session_not_owned, not a replay', () => {
    const res = closeByColleague as Response;
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(posRefusalCode(res.body), JSON.stringify(res.body)).toBe('pos.session_not_owned');
  });

  it('and the owner’s byte-identical second close still replays', () => {
    const res = closeOwnReplay as Response;
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});
