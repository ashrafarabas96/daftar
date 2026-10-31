/**
 * P4-S4 — A CHECKOUT REPLAY PRESENTED BY A COLLEAGUE IS NOT A REPLAY.
 *
 * This is `p4s4-credit-application-customer-replay.test.ts`' defect, found on
 * a second route by generalising its shape: **an argument the intent digest
 * does not carry, judged AFTER the replay branch.**
 *
 * `POST /v1/pos/till-sessions/:sessionId/checkout` carries seven body keys and
 * one path id, and the argument this suite is about is in NEITHER: the
 * AUTHENTICATED USER. `pos_till_sessions.opened_by` is the assertion's actor
 * and never an argument (`till-session.service.ts:56-61` — "neither payload
 * grammar has a user field and neither routine takes one"), so
 * `saleCommitIntentSha256` cannot carry it and must not: a digest over the
 * actor would make one cashier's lawful retry of her own checkout a false
 * `pos.checkout_idempotency_conflict` if the token were re-issued.
 *
 * `OD-P4-09` OPTION A is **one session, one authenticated user**, and
 * `pos-checkout.service.ts:201` is the sentence that enforces it:
 * `session.openedBy !== m.userId` ⇒ `pos.session_not_owned`, 403. The sibling
 * READ route refuses a colleague's session for the same reason and says so:
 * "a read that handed over another cashier's drawer figures would be the shared
 * till the ruling refused, read-only" (`till-session.service.ts:239-246`).
 *
 * THE DEFECT THIS SUITE EXISTS FOR. `provenReplay` is STEP 0 and returns at
 * `:196`, five lines BEFORE the ownership sentence at `:201`. Its proof is the
 * sale's stored `commit_intent_sha256` and the line-identity binding
 * (`in_session`), and neither can see who is asking. So a COLLEAGUE —
 * `sales.create` in the same business, which the route guard is satisfied by,
 * and no claim at all on this till — who delivers the already-committed
 * `saleId` with the same header intent is answered `200` with the whole
 * `PosCheckoutDto`: the sale, its totals, its customer, and the id of every
 * cart row the drawer consumed. The 403 that is the slice's central ruling is
 * never reached, and the colleague learns the drawer figures the READ route
 * exists to withhold from her.
 *
 * The fix is the ORDER, not the digest: the session is read and its owner
 * judged before the replay proof is consulted, so a colleague is
 * `pos.session_not_owned` whether or not the sale is already stored.
 *
 * §C keeps the suite honest: the OWN cashier's byte-identical second delivery
 * still replays, so this cannot pass by refusing everything.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import {
  census,
  checkout,
  clearBasket,
  expectUntouched,
  refusalCode,
  scan,
  seedCheckoutShop,
  type CheckoutCensus,
  type CheckoutShop,
} from '../helpers/till-checkout';

const CLAIM =
  'a second delivery of a committed checkout under its stored sale id, presented by a COLLEAGUE, is refused pos.session_not_owned and never answered as a replay';

let t: TestApp;
let shop: CheckoutShop;
let saleId: string;

/** The three deliveries, all made in `beforeAll` so each `it` is a pure assertion. */
let first: Response | undefined;
let byColleague: Response | undefined;
let ownReplay: Response | undefined;
/** The world right after the lawful checkout, and right after the colleague's delivery. */
let afterFirst: CheckoutCensus | undefined;
let afterColleague: CheckoutCensus | undefined;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  t = await createTestApp();
  shop = await seedCheckoutShop(t, 'ckownrep');
  await clearBasket(t, shop);
  await scan(t, shop, shop.business.piece.productId, '2');
  saleId = randomUUID();

  // 1. the lawful checkout, by the till's own cashier.
  first = await checkout(t, shop, saleId);
  afterFirst = await census(ownerPool(), shop.business.businessId, shop.session.sessionId);
  // 2. the SAME sale id, the same header intent, presented by a COLLEAGUE who
  //    holds `sales.create` in this business and no claim on this till.
  byColleague = await checkout(t, shop, saleId, shop.colleague);
  afterColleague = await census(ownerPool(), shop.business.businessId, shop.session.sessionId);
  // 3. the byte-identical second delivery by the OWNER, which must still replay.
  ownReplay = await checkout(t, shop, saleId);
}, 420_000);

afterAll(async () => {
  await t?.close();
  await resetData();
});

describe(`§0 ${CLAIM}`, () => {
  it('the two cashiers are distinct members of one business, or §B has no subject', () => {
    expect(shop.cashier.userId).not.toBe(shop.colleague.userId);
    expect(shop.session.sessionId).toBeTruthy();
  });
});

describe('§A the lawful checkout', () => {
  it('is accepted and is not a replay', () => {
    const res = first as Response;
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.sale.replayed).toBe(false);
    expect(res.body.sale.saleId).toBe(saleId);
  });
});

describe('§B the same sale id, a COLLEAGUE', () => {
  it('is REFUSED pos.session_not_owned — it is not answered 200 with the drawer’s sale', () => {
    const res = byColleague as Response;
    // The defect's exact signature: 200 carrying the sale and the consumed rows.
    expect(
      res.status,
      `the route handed cashier ${shop.colleague.userId} the sale, the totals and every consumed cart line id of ` +
        `${shop.cashier.userId}'s drawer, which OD-P4-09 and the READ route both refuse. Measured: ${res.status} ${JSON.stringify(res.body)}`,
    ).toBe(403);
    expect(refusalCode(res.body), JSON.stringify(res.body)).toBe('pos.session_not_owned');
    expect((res.body as { sale?: unknown }).sale, 'a refused checkout carries no sale').toBeUndefined();
    expect((res.body as { consumedCartLineIds?: unknown }).consumedCartLineIds, 'a refused checkout names no consumed row').toBeUndefined();
  });

  it('and it wrote nothing: the world is exactly what the lawful checkout left', () => {
    expectUntouched(afterFirst as CheckoutCensus, afterColleague as CheckoutCensus, 'a colleague’s replay of a committed checkout');
  });
});

describe('§C the other half: the OWNER’s byte-identical second delivery still REPLAYS', () => {
  it('answers 200 replayed:true, so §B is not passing by refusing everything', () => {
    const res = ownReplay as Response;
    expect(refusalCode(res.body), 'a lawful replay was refused').toBeNull();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.sale.replayed).toBe(true);
    expect(res.body.sale.saleId).toBe(saleId);
  });
});
