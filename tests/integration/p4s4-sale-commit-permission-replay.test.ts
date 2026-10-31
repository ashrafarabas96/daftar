/**
 * P4-S4 — A SALE REPLAY DELIVERED BY AN ACTOR WHO MAY NOT MAKE THAT SALE IS
 * NOT A REPLAY.
 *
 * The third instance of `p4s4-credit-application-customer-replay.test.ts`'
 * defect, found by generalising its shape: **an argument the intent digest
 * does not carry, judged AFTER the replay branch.**
 *
 * `POST /v1/sales` digests every field of its body
 * (`sale-payloads.ts:213-245` and `0078:567-584`, which agree field for
 * field), so there is no body key to smuggle here. The argument the digest
 * does not carry is the one no request body states: **the actor's own
 * permission set.** The route guard admits `sales.create`, and TWO further
 * keys are required for particular sales and are checked in
 * `SaleCommitService.plan` — `sales.discount` for a discounted line and
 * `receivables.view` for a credit sale (P4-AL-35's matrix,
 * `sale-commit.service.ts:281-286`).
 *
 * THE DEFECT THIS SUITE EXISTS FOR. `plan`'s replay branch is step 1
 * (`sale-commit.service.ts:261-269`) and the matrix is step 2, five lines
 * later — so a CASHIER, whose built-in role carries `sales.create` and
 * neither `sales.discount` nor `receivables.view`
 * (`permissions.ts:214`), who delivers a manager's already-committed
 * DISCOUNTED sale is answered `200 replayed: true` with the whole `SaleDto` —
 * the totals, the granted discount and `cogsBaseMinor`. The identical body
 * sent under a fresh `saleId` is `403 sale.discount_not_permitted`, which is
 * the proof the permission is real and the replay path is where it is lost.
 * «A silently-zeroed discount charges the customer more than the cashier told
 * them» is the reason that refusal exists; being told the discount was granted
 * when you may not grant one is the same sentence read backwards.
 *
 * `supplier-payment.service.ts:413-415` is the estate's own counter-pattern
 * and the shape of the fix: it re-authorizes over the STORED payment's
 * warehouses before it answers a replay — "the stored answer is shown only to
 * an actor with authority over every warehouse it touches". The fix here is
 * the ORDER, not the digest: adding the actor or its roles to the digest would
 * disagree with `0078`'s own `inventory_payload_digest` call on every sale and
 * turn a token re-issue into a false `sale.idempotency_conflict`.
 *
 * §C keeps the suite honest: the manager's byte-identical second delivery
 * still replays.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, resetData, type TestApp } from '../helpers/test-app';
import { asMember } from '../helpers/inventory-commands';
import { refusalCode, seedCheckoutShop, type CheckoutShop } from '../helpers/till-checkout';

const CLAIM =
  'a second delivery of a committed DISCOUNTED sale, by an actor without sales.discount, is refused discount_not_permitted and never answered as a replay';

let t: TestApp;
let shop: CheckoutShop;
let saleId: string;
let body: Record<string, unknown>;

let first: Response | undefined;
let byCashier: Response | undefined;
let freshByCashier: Response | undefined;
let ownReplay: Response | undefined;

/** The sale body: one line, a stated discount request, cash settlement. */
function saleBody(id: string, day: string, warehouseId: string, productId: string): Record<string, unknown> {
  return {
    saleId: id,
    settlementMode: 'cash',
    customerId: null,
    warehouseId,
    documentDate: day,
    dueDate: null,
    taxMinor: '0',
    notes: null,
    lines: [{ lineId: randomUUID(), productId, variantId: null, quantity: '1', discountMinor: '100' }],
  };
}

const commit = (b: Record<string, unknown>, by: CheckoutShop['cashier'], businessId: string): Promise<Response> =>
  t.request.post('/v1/sales').set(asMember(by, businessId)).send(b) as unknown as Promise<Response>;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  t = await createTestApp();
  shop = await seedCheckoutShop(t, 'salepermrep');
  saleId = randomUUID();
  body = saleBody(saleId, shop.day, shop.business.w1, shop.business.piece.productId);

  // 1. the lawful discounted sale, by the actor who holds every key.
  first = await commit(body, shop.cashier, shop.business.businessId);
  // 2. the SAME body, every digested field identical, delivered by the CASHIER.
  byCashier = await commit(body, shop.colleague, shop.business.businessId);
  // 3. the CONTROL: the same body under a fresh sale id, by the same cashier.
  //    This is what the permission actually answers when no replay is in play.
  freshByCashier = await commit(saleBody(randomUUID(), shop.day, shop.business.w1, shop.business.piece.productId), shop.colleague, shop.business.businessId);
  // 4. the byte-identical second delivery by the original actor, which must still replay.
  ownReplay = await commit(body, shop.cashier, shop.business.businessId);
}, 420_000);

afterAll(async () => {
  await t?.close();
  await resetData();
});

describe(`§0 ${CLAIM}`, () => {
  it('the two actors are distinct, and the second is a cashier without sales.discount', () => {
    expect(shop.cashier.userId).not.toBe(shop.colleague.userId);
  });

  it('the CONTROL: the cashier may not make a discounted sale at all', () => {
    const res = freshByCashier as Response;
    expect(res.status, `a cashier made a discounted sale under a fresh id: ${JSON.stringify(res.body)}`).toBe(403);
    expect(refusalCode(res.body), JSON.stringify(res.body)).toBe('sale.discount_not_permitted');
  });
});

describe('§A the lawful discounted sale', () => {
  it('is accepted and is not a replay', () => {
    const res = first as Response;
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.replayed).toBe(false);
    expect(res.body.discountTxnMinor).toBe('100');
  });
});

describe('§B the same sale id, an actor without sales.discount', () => {
  it('is REFUSED sale.discount_not_permitted — it is not answered 200 replayed:true', () => {
    const res = byCashier as Response;
    expect(
      (res.body as { replayed?: boolean }).replayed,
      `the route told a cashier who may not grant a discount that a discounted sale had been carried out, and handed over ` +
        `its totals and cogsBaseMinor. Measured: ${res.status} ${JSON.stringify(res.body)}`,
    ).not.toBe(true);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(refusalCode(res.body), JSON.stringify(res.body)).toBe('sale.discount_not_permitted');
  });
});

describe('§C the other half: the original actor’s byte-identical second delivery still REPLAYS', () => {
  it('answers 200 replayed:true, so §B is not passing by refusing everything', () => {
    const res = ownReplay as Response;
    expect(refusalCode(res.body), 'a lawful replay was refused').toBeNull();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.replayed).toBe(true);
    expect(res.body.saleId).toBe(saleId);
  });
});
