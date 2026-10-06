/**
 * P4-S4 — A POS CHECKOUT REPLAY DELIVERED BY AN ACTOR WHO MAY NOT MAKE THAT
 * CHECKOUT IS NOT A REPLAY.
 *
 * The SIBLING of `p4s4-sale-commit-permission-replay.test.ts`, on the route
 * that orchestrates the same sale. Same defect, same shape: **an argument the
 * intent digest does not carry, judged AFTER the branch that answers on the
 * digest alone.**
 *
 * `POST /v1/pos/till-sessions/:sessionId/checkout` states almost nothing — its
 * accepted keys are the sale HEADER and nothing about the basket
 * (`pos-checkout.schemas.ts`) — so the argument the digest cannot carry is
 * again the one no request body states: **the actor's own permission set and
 * its branch scope.** The route guard admits `sales.create` and nothing more
 * (`pos-permissions.ts:100`), and a checkout needs two further judgements of
 * the actor: the SENSITIVE `sales.discount` for a basket carrying a granted
 * discount, and `pos.cart_remove_line` authority over the warehouse
 * (`inventory-authorization.ts:160`).
 *
 * THE DEFECT THIS SUITE EXISTS FOR. `checkout()` judges till-session OWNERSHIP
 * at step 0, before the proof — the coordinator's own ruling. But while the
 * discount refusal stayed at step 3 and the removal authority at step 6 — both
 * AFTER `provenReplay` — an actor holding neither key, who delivered the
 * already-committed `saleId`, was answered `200` with the whole
 * `PosCheckoutDto`: the sale, its totals, the discount somebody else was
 * authorized to grant, and `cogsBaseMinor`. The sibling READ route refuses a
 * colleague's session precisely so those figures are not handed over
 * (`till-session.service.ts:239-246`).
 *
 * ## WHO THE UNAUTHORIZED ACTOR CAN BE, AND WHY IT IS THE SAME USER
 *
 * On this route it CANNOT be a colleague, and that is not a weakness of the
 * case — it is step 0 of the fix already in place: `pos.session_not_owned` is
 * judged before the proof, so a colleague never reaches the replay branch at
 * all. The actor who reaches it is, by construction, the session's own owner.
 * So the only actor who can reach the replay branch WITHOUT the key is the
 * owner after the key has been WITHDRAWN — a merchant revoking a delegated
 * discount authority, which is exactly what `OD-P4-01` makes `sales.discount`:
 * a delegation and no built-in role's default (`permissions.ts:187-212`). The
 * request is byte-identical across all four deliveries below; only the actor's
 * role set moves.
 *
 * `supplier-payment.service.ts:413-415` is the estate's counter-pattern and
 * the shape of the fix: it re-authorizes over the STORED payment's warehouses
 * before it answers a replay. The fix here is the ORDER and the SUBJECT, not
 * the digest: the cart was consumed by the original checkout, so the only
 * honest subject is the STORED sale's own lines and the STORED sale's own
 * warehouse — which is what `provenReplay` already recomputes the digest over.
 * Adding the actor to the digest is impossible: `0078`/`0079` re-derive the
 * fingerprint from their own arguments, so a new field would disagree with the
 * migration on every sale and turn a re-issued token into a false
 * `pos.checkout_idempotency_conflict`.
 *
 * §C and §E keep the suite honest: the lawful retry, by an actor who holds the
 * key, still replays — before the withdrawal and again after the key is given
 * back.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, resetData, type TestApp } from '../helpers/test-app';
import { asMember, registerActor, type HttpActor } from '../helpers/inventory-commands';
import { openTillSession, terminalCode, type OpenTillSession } from '../helpers/pos-till-sessions';
import { checkoutBody, refusalCode, seedCheckoutShop, type CheckoutShop } from '../helpers/till-checkout';

const CLAIM =
  'a second delivery of a committed DISCOUNTED checkout, by an actor no longer holding sales.discount, is refused pos.cart_discount_not_permitted and never answered 200 with the sale, its discount and its cogsBaseMinor';

/** The delegated role: the cashier's own four keys plus the SENSITIVE discount key. */
const DISCOUNTER_KEYS = ['catalog.view', 'sales.view', 'sales.create', 'customers.view', 'payments.collect', 'sales.discount'] as const;
const DISCOUNTER_ROLE = `posdisc-${randomUUID().slice(0, 8)}`;

let t: TestApp;
let shop: CheckoutShop;
/** The till's OWN cashier for this suite: a member whose role set is moved under it. */
let till: HttpActor;
let session: OpenTillSession;
let saleId: string;
let body: Record<string, unknown>;

let first: Response | undefined;
let ownReplay: Response | undefined;
let afterWithdrawal: Response | undefined;
let discountControl: Response | undefined;
let afterRestoration: Response | undefined;

const headers = (): Record<string, string> => asMember(till, shop.business.businessId);

/** Set `till`'s whole role set through the merchant's own route, as the owner. */
async function setRoles(roleKeys: readonly string[]): Promise<void> {
  const res = await t.request
    .patch(`/v1/businesses/current/members/${till.userId}/roles`)
    .set(asMember(shop.cashier, shop.business.businessId))
    .send({ roleKeys });
  expect(res.status, `the role set could not be moved to ${roleKeys.join(',')}: ${JSON.stringify(res.body)}`).toBe(200);
}

/** The ONE checkout delivery, byte-identical every time it is called. */
const deliver = (): Promise<Response> =>
  t.request.post(`/v1/pos/till-sessions/${session.sessionId}/checkout`).set(headers()).send(body) as unknown as Promise<Response>;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  t = await createTestApp();
  shop = await seedCheckoutShop(t, 'chkpermrep');

  // 1. the DELEGATED role, created through the merchant's own route, and a
  //    member who holds it. No built-in role carries `sales.discount`
  //    (`OD-P4-01`), so the delegation is the only lawful way to hold it.
  const role = await t.request
    .post('/v1/businesses/current/roles')
    .set(asMember(shop.cashier, shop.business.businessId))
    .send({ key: DISCOUNTER_ROLE, name: 'POS discounter', permissions: [...DISCOUNTER_KEYS] });
  expect(role.status, JSON.stringify(role.body)).toBe(201);
  till = await registerActor(t, 'POS checkout discounter chkpermrep');
  const add = await t.request
    .post('/v1/businesses/current/members')
    .set(asMember(shop.cashier, shop.business.businessId))
    .send({ email: till.email, roleKey: DISCOUNTER_ROLE });
  expect(add.status, JSON.stringify(add.body)).toBe(201);

  // 2. HER OWN till — one open session per user, so this is a second drawer
  //    and not the fixture's. Step 0 of `checkout()` requires the deliverer to
  //    be `opened_by`, which is the whole reason the unauthorized actor below
  //    must be this same user.
  session = await openTillSession(
    t,
    till,
    shop.business.businessId,
    { branchId: shop.business.branchX, warehouseId: shop.business.w1 },
    { terminalCode: terminalCode('chkperm') },
  );

  // 3. one scan, and a DISCOUNT REQUEST she is authorized to make.
  const scanned = await t.request
    .post(`/v1/pos/till-sessions/${session.sessionId}/cart-lines`)
    .set(headers())
    .send({ productId: shop.business.piece.productId, variantId: null, quantity: '1' });
  expect(scanned.status, JSON.stringify(scanned.body)).toBe(201);
  const lines = scanned.body.lines as { cartLineId: string }[];
  const cartLineId = String(lines[lines.length - 1]?.cartLineId);
  const asked = await t.request
    .post(`/v1/pos/till-sessions/${session.sessionId}/cart-lines/${cartLineId}/discount`)
    .set(headers())
    .send({ discountMinor: '250' });
  expect(asked.status, `the delegated discount request was refused: ${JSON.stringify(asked.body)}`).toBe(200);

  saleId = randomUUID();
  body = checkoutBody(saleId, shop.day);

  // 4. the lawful discounted checkout.
  first = await deliver();
  // 5. the byte-identical second delivery, by the same actor who still holds
  //    the key. It must replay — the control for §D.
  ownReplay = await deliver();

  // 6. THE KEY IS WITHDRAWN. The merchant moves her to the built-in cashier
  //    role, which holds `sales.create` (so the route guard still admits her)
  //    and not `sales.discount`.
  await setRoles(['cashier']);
  // 7. the SAME bytes again, by the SAME owner of the SAME till, now without
  //    the key the stored sale's discount was granted under.
  afterWithdrawal = await deliver();
  // 8. the CONTROL that the key is really gone: the cart route's own discount
  //    request, which needs exactly `sales.discount`, refuses her now.
  const scannedAgain = await t.request
    .post(`/v1/pos/till-sessions/${session.sessionId}/cart-lines`)
    .set(headers())
    .send({ productId: shop.business.piece2.productId, variantId: null, quantity: '1' });
  expect(scannedAgain.status, JSON.stringify(scannedAgain.body)).toBe(201);
  const freshLines = scannedAgain.body.lines as { cartLineId: string }[];
  const freshLineId = String(freshLines[freshLines.length - 1]?.cartLineId);
  discountControl = (await t.request
    .post(`/v1/pos/till-sessions/${session.sessionId}/cart-lines/${freshLineId}/discount`)
    .set(headers())
    .send({ discountMinor: '250' })) as unknown as Response;

  // 9. the key is GIVEN BACK, and the identical delivery must replay again.
  await setRoles([DISCOUNTER_ROLE]);
  afterRestoration = await deliver();
}, 420_000);

afterAll(async () => {
  await t?.close();
  await resetData();
});

describe(`§0 ${CLAIM}`, () => {
  it('the deliverer is the till’s OWN owner throughout, so no case is passing by pos.session_not_owned', () => {
    expect(till.userId).not.toBe(shop.cashier.userId);
    expect(session.warehouseId).toBe(shop.business.w1);
    for (const res of [first, ownReplay, afterWithdrawal, afterRestoration] as Response[])
      expect(refusalCode(res.body), `a delivery was refused as a colleague's: ${JSON.stringify(res.body)}`).not.toBe('pos.session_not_owned');
  });

  it('the CONTROL: with the key withdrawn, the actor may not request a discount at all', () => {
    const res = discountControl as Response;
    expect(res.status, `a cashier without sales.discount asked for one: ${JSON.stringify(res.body)}`).toBe(403);
    expect(refusalCode(res.body), JSON.stringify(res.body)).toBe('pos.cart_discount_not_permitted');
  });
});

describe('§A the lawful discounted checkout', () => {
  it('is accepted, and the sale carries the CART’s granted discount', () => {
    const res = first as Response;
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.sale.discountTxnMinor, 'the sale must carry the cart’s discount request').toBe('250');
    expect(res.body.sale.totalTxnMinor).toBe('750');
    expect(res.body.consumedCartLineIds, 'the checkout consumed its snapshot').toHaveLength(1);
  });
});

describe('§C the lawful retry, by the actor who still holds the key', () => {
  it('answers 200 from the STORED sale, so §D is not passing by refusing everything', () => {
    const res = ownReplay as Response;
    expect(refusalCode(res.body), 'a lawful replay was refused').toBeNull();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.sale.saleId).toBe(saleId);
    expect(res.body.sale.replayed, 'the answer must be the STORED sale, reported as a replay').toBe(true);
    expect(res.body.sale.cogsBaseMinor, 'the figure the defect handed over').not.toBeNull();
    expect(res.body.sale.discountTxnMinor).toBe('250');
  });
});

describe('§D the SAME bytes, the SAME till, the key withdrawn', () => {
  it('is REFUSED pos.cart_discount_not_permitted — it is not answered 200 with the sale, its discount and its cogsBaseMinor', () => {
    const res = afterWithdrawal as Response;
    const sale = (res.body as { sale?: Record<string, unknown> }).sale;
    expect(
      sale,
      `the route handed an actor who may not grant a discount the whole stored sale — its totals, its granted discount and its cogsBaseMinor. ` +
        `Measured: ${res.status} ${JSON.stringify(res.body)}`,
    ).toBeUndefined();
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(refusalCode(res.body), JSON.stringify(res.body)).toBe('pos.cart_discount_not_permitted');
  });
});

describe('§E the key given back: the lawful retry still replays', () => {
  it('answers 200 from the stored sale again, so the fix refused the actor and not the retry', () => {
    const res = afterRestoration as Response;
    expect(refusalCode(res.body), 'a lawful replay was refused after the key was restored').toBeNull();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.sale.discountTxnMinor).toBe('250');
    expect(res.body.consumedCartLineIds, 'the answer names the ORIGINAL snapshot and not the current basket').toHaveLength(1);
  });
});
