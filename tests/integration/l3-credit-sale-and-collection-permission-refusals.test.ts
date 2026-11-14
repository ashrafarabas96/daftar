/**
 * L3 — THE TWO RECEIVABLES KEYS ARE REFUSALS, NOT MERELY NAMES.
 *
 * ── THE MEASURED GAP THIS SUITE CLOSES ────────────────────────────────────
 *
 * A probe with a proven positive control was run over the whole test tree:
 *
 *   grep -rn "<perm>" tests --include=*.ts | grep -iE "403|without|refus|lack|missing|strip"
 *
 * It answers SIX hits for `sales.discount` — so the probe is SIGHTED and its
 * zeros mean something — and ZERO for `receivables.view` and ZERO for
 * `payments.collect`, while those two names appear in the tree 17 and 16 times
 * respectively. Both keys were therefore NAMED everywhere and ASSERTED AS A
 * REFUSAL nowhere: every suite that mentions them mentions an actor who HOLDS
 * them. A permission nobody ever measured the absence of is a permission whose
 * removal no test would notice.
 *
 * ── CLAIM 1: `receivables.view` IS THE SECOND HALF OF A CREDIT SALE ───────
 *
 * EVERY SITE THAT ENFORCES `receivables.view` FOR `POST /v1/sales`, enumerated
 * by grepping the permission name and the route across `apps/api/src` — there
 * are TWO, and the §A case below is a guard on BOTH, not on either one:
 *
 *   G1-A  `apps/api/src/modules/selling/sale-commit.service.ts:301-303`
 *         — `SaleCommitService.plan` step 2: `settlementMode === 'credit'` and
 *           no `receivables.view` ⇒ `sellingRefusal('sale.credit_not_permitted')`,
 *           403 by `selling-errors.ts:154`, rendered with
 *           `details.sellingCode`. This is the gate the route reaches FIRST.
 *   G1-B  `apps/api/src/modules/accounting/sale-posting.service.ts:86-88`
 *         — `authorizeSaleCommit`, called from `sale-commit.service.ts:427`,
 *           i.e. AFTER G1-A: `invoice.settlementKind === 'credit'` and no
 *           `receivables.view` ⇒ a bare `ForbiddenException`, which the global
 *           filter renders 403 `FORBIDDEN` "Access denied" with NO `details`
 *           (`error.filter.ts:80-93`).
 *
 * `POST /v1/sales` itself carries `@RequiresPermission('sales.create')` and
 * nothing more (`sales.controller.ts:64-67`): a decorator cannot see the body,
 * and the credit bit is in the body. The `sale.commit` operation authority is
 * `sales.create` too (`inventory-authorization.ts:122`), so the minted
 * assertion and the database behind it are NOT a third gate on this key.
 *
 * WHY THE ENUMERATION IS WRITTEN OUT HERE. A negative control that disables
 * ONE of several gates is a BLIND control, and this route is exactly that
 * trap: weakening G1-A alone leaves the case GREEN, because the request falls
 * through to G1-B and is refused 403 there instead — a different envelope, the
 * same status. The case only goes RED with BOTH disabled. A future reader who
 * takes §A for a guard on one gate will weaken one and read a false green.
 *
 * ── CLAIM 2: `payments.collect` IS THE KEY TO THE MONEY ───────────────────
 *
 * EVERY SITE THAT ENFORCES `payments.collect` FOR `POST /v1/customer-payments`
 * — again TWO, and again the §B case is a guard on BOTH:
 *
 *   G2-A  `apps/api/src/modules/receivables/receivables.controller.ts:67`
 *         — `@phase4ReceivablesPermission('payments.collect')`, which is
 *           `RequiresPermission` (`receivables-permissions.ts:59`), evaluated
 *           by `AuthGuard` at `guards.ts:83` through
 *           `tenancy.service.ts:105-109` ⇒
 *           `AppError.forbidden('Missing permission: payments.collect')`.
 *   G2-B  `apps/api/src/modules/receivables/customer-payment.service.ts:603`
 *         — `authorize(m, 'customer.collect_payment', btx)`, whose rule is
 *           `{ permission: 'payments.collect' }`
 *           (`inventory-authorization.ts:189`), refusing at
 *           `inventory-authorization.ts:258-260` with the SAME sentence. The
 *           file's own comment names the division: "the route decorator gates
 *           the REQUEST, this gates the CALL".
 *
 * Both render the identical envelope, so the §B case cannot tell them apart by
 * reading the body — which is precisely why the enumeration above is the only
 * record of how many gates it covers.
 *
 * ── WHAT EACH CASE'S POSITIVE CONTROL IS FOR ─────────────────────────────
 *
 * Each `it` carries its own control, in the same `it`, because a 403 on its
 * own proves nothing about the key under test: a broken token, an unseeded
 * fixture, a missing branch scope or an unrelated gate all answer 403 too.
 *
 *   §A the SAME member's `settlementMode: 'cash'` sale, with the SAME
 *      customer, the SAME warehouse and the SAME product, SUCCEEDS. One bit
 *      differs between the refusal and the success, and it is the credit bit.
 *   §B the SAME member's `GET /v1/customers/:id/receivable` — which needs
 *      `receivables.view`, the key this member DOES hold — SUCCEEDS. So the
 *      member authenticates, resolves a membership, has business-wide scope
 *      and can read the very figure the refused collection would have moved.
 *
 * And each case reads the world back afterwards: §A that the refused credit
 * sale left no `sales` row, no `invoices` row and the customer's AR exactly
 * where it was; §B that no `payments` row exists and the outstanding did not
 * move. A refusal that nevertheless wrote is not a refusal.
 *
 * ── THE ACTORS ───────────────────────────────────────────────────────────
 *
 * Each case's actor holds EVERY key in the registry of 58
 * (`permissions.ts:11-88`) EXCEPT the one under test, through a custom role
 * created by the owner on the merchant's own `POST /v1/businesses/current/roles`
 * route. "All but one" and not a built-in role: the built-in `cashier` lacks
 * `receivables.view` but also lacks eleven other things, so a refusal measured
 * on a cashier could be about any of them. The delegation ceiling passes
 * because the creator is the system owner (`structure.service.ts:475-480`).
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { PERMISSIONS, type Permission } from '@daftar/domain-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { asMember, registerActor, type HttpActor } from '../helpers/inventory-commands';
import { newCustomer, sellOnCredit, settlementWorld, stockUp, type OpenInvoice, type SettlementWorld } from '../golden-regression/phase4-s4/settlement-world';
import { collectPayment, refusalCode } from '../golden-regression/phase4-s4/settlement-path';
import { confirmSale } from '../golden-regression/phase4-s2/sale-path';

const CLAIM_A =
  'a member holding every permission EXCEPT receivables.view is REFUSED a credit sale, still sells for cash, and leaves no invoice and no receivable behind';
const CLAIM_B =
  'a member holding every permission EXCEPT payments.collect is REFUSED a customer payment, still reads the receivable it holds the key for, and moves no outstanding';

/** Generous, so nothing below is refused for the stock rather than for the key under test. */
const ON_HAND = '200';
const UNIT_COST = '3.00';

let w: SettlementWorld;
/** The actor of §A: everything but `receivables.view`. */
let noReceivablesView: HttpActor;
/** The actor of §B: everything but `payments.collect`. */
let noPaymentsCollect: HttpActor;
/** §A's customer: the one the refused credit sale and the successful cash sale both name. */
let customerA: string;
/** §B's customer and its OPEN credit invoice, sold by the OWNER so §B's refusal is the only thing measured. */
let customerB: string;
let invoiceB: OpenInvoice;

/**
 * A member who holds every registered permission except `omit`, through the
 * merchant's own role route. The role's permission list is derived from
 * `PERMISSIONS` itself, so a key added to the registry tomorrow is held by
 * these actors automatically and never silently missing from the control.
 */
async function memberHoldingAllBut(omit: Permission, roleKey: string): Promise<HttpActor> {
  const permissions: Permission[] = PERMISSIONS.filter((p) => p !== omit);
  expect(permissions, `the role must omit exactly ${omit} and nothing else`).toHaveLength(PERMISSIONS.length - 1);
  expect(permissions.length, `RoleSchema caps a custom role at 100 permissions (tenancy.controller.ts:56); the registry has outgrown it`).toBeLessThanOrEqual(
    100,
  );
  const role = await w.t.request.post('/v1/businesses/current/roles').set(w.headers).send({ key: roleKey, name: roleKey, permissions });
  expect(role.status, `the delegated role ${roleKey} could not be created: ${JSON.stringify(role.body)}`).toBe(201);
  const actor = await registerActor(w.t, `l3 permission actor ${roleKey}`);
  const add = await w.t.request.post('/v1/businesses/current/members').set(w.headers).send({ email: actor.email, roleKey });
  expect(add.status, `the member of ${roleKey} could not be added: ${JSON.stringify(add.body)}`).toBe(201);
  return actor;
}

const headersOf = (by: HttpActor): Record<string, string> => asMember(by, w.shop.businessId);

/** `GET /v1/customers/:id/receivable`, as `by`. Needs `receivables.view` AND business-wide scope. */
const readReceivable = (by: HttpActor, customerId: string): Promise<Response> =>
  w.t.request.get(`/v1/customers/${customerId}/receivable`).set(headersOf(by)) as unknown as Promise<Response>;

/** Counted as the SCHEMA OWNER, who bypasses row security: a row written and merely hidden is still counted. */
async function rowsFor(relation: 'sales' | 'invoices' | 'payments', column: 'id' | 'sale_id', value: string): Promise<number> {
  const r = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM ${relation} WHERE business_id = $1 AND ${column} = $2`, [
    w.shop.businessId,
    value,
  ]);
  return Number(r.rows[0]?.n ?? '-1');
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  w = await settlementWorld('l3permkeys');
  await stockUp(w, ON_HAND, UNIT_COST);
  noReceivablesView = await memberHoldingAllBut('receivables.view', 'l3-no-receivables-view');
  noPaymentsCollect = await memberHoldingAllBut('payments.collect', 'l3-no-payments-collect');
  customerA = await newCustomer(w);
  customerB = await newCustomer(w);
  // §B's open invoice is the OWNER's work. §B measures the collection, not the sale.
  invoiceB = await sellOnCredit(w, customerB, '2');
});

afterAll(async () => {
  await w?.t.close();
  await resetData();
});

describe('§0 the two actors are real, distinct members of this business', () => {
  it('each is a different user from the owner and from the other', () => {
    const ids = [w.owner.userId, noReceivablesView.userId, noPaymentsCollect.userId];
    expect(new Set(ids).size, `the three actors are not three users: ${ids.join(', ')}`).toBe(3);
  });
});

/**
 * TWO GATES, NOT ONE. This case is a guard on BOTH
 * `sale-commit.service.ts:301-303` (G1-A, reached first, answers
 * `sale.credit_not_permitted`) AND
 * `sale-posting.service.ts:86-88` (G1-B, reached only if G1-A is gone,
 * answers a bare 403 with no `details`). Disabling only G1-A leaves this case
 * GREEN on G1-B's 403. Measured: see the suite header.
 */
describe(`§A ${CLAIM_A}`, () => {
  it('REFUSES the credit sale sale.credit_not_permitted, writes nothing, and still commits the same sale for CASH', async () => {
    const hdrs = headersOf(noReceivablesView);
    const arBefore = await readReceivable(w.owner, customerA);
    expect(arBefore.status, `the owner could not read the AR this case conserves: ${JSON.stringify(arBefore.body)}`).toBe(200);

    // 1. THE REFUSAL. One line, no discount, a named customer: the only
    //    unusual thing about this request is `settlementMode: 'credit'`.
    const creditSaleId = randomUUID();
    const refused = await confirmSale(w.t, hdrs, {
      saleId: creditSaleId,
      customerId: customerA,
      warehouseId: w.shop.w1,
      occurredOn: w.day,
      lines: [{ productId: w.shop.piece.productId, quantity: '1' }],
    });
    expect(
      refused.status,
      `a member WITHOUT receivables.view sold on credit: a sale that creates a receivable was committed by an actor who may not see one. ` +
        `Measured: ${refused.status} ${JSON.stringify(refused.body)}`,
    ).toBe(403);
    expect(
      refusalCode(refused, 'sale.credit_not_permitted'),
      `the refusal did not carry the typed selling code the registry assigns it (selling-errors.ts:154). ` +
        `A bare 403 here would mean G1-A is gone and G1-B answered instead: ${JSON.stringify(refused.body)}`,
    ).toBe('sale.credit_not_permitted');

    // 2. THE WORLD, READ BACK. A refusal that wrote is not a refusal.
    expect(await rowsFor('sales', 'id', creditSaleId), `the refused credit sale left a sales row behind: ${creditSaleId}`).toBe(0);
    expect(await rowsFor('invoices', 'sale_id', creditSaleId), `the refused credit sale left an invoice behind: ${creditSaleId}`).toBe(0);
    const arAfter = await readReceivable(w.owner, customerA);
    expect(arAfter.status, `the owner could not re-read the AR: ${JSON.stringify(arAfter.body)}`).toBe(200);
    expect(
      arAfter.body,
      `the refused credit sale MOVED the customer's receivable. before=${JSON.stringify(arBefore.body)} after=${JSON.stringify(arAfter.body)}`,
    ).toEqual(arBefore.body);

    // 3. THE POSITIVE CONTROL, and the reason step 1 is about the credit bit.
    //    The same member, the same customer, the same warehouse, the same
    //    product, the same day — `settlementMode: 'cash'` instead, which
    //    `confirmSale` states by carrying a payment method.
    const cashSaleId = randomUUID();
    const cash = await confirmSale(w.t, hdrs, {
      saleId: cashSaleId,
      customerId: customerA,
      warehouseId: w.shop.w1,
      occurredOn: w.day,
      payment: { paymentMethodId: w.paymentMethodId },
      lines: [{ productId: w.shop.piece.productId, quantity: '1' }],
    });
    expect(
      cash.status,
      `THE CONTROL FAILED: the same member could not make a CASH sale either, so step 1's 403 is not evidence about receivables.view — ` +
        `it could be the token, the fixture, the branch scope or another gate. Measured: ${cash.status} ${JSON.stringify(cash.body)}`,
    ).toBe(200);
    expect(await rowsFor('sales', 'id', cashSaleId), `THE CONTROL FAILED: the accepted cash sale wrote no sales row: ${cashSaleId}`).toBe(1);
  });
});

/**
 * TWO GATES, NOT ONE. This case is a guard on BOTH
 * `receivables.controller.ts:67` (G2-A, the route decorator) AND
 * `customer-payment.service.ts:603` (G2-B, the service's own
 * re-authorization). Both raise the identical envelope, so the body cannot
 * tell them apart: disabling only G2-A leaves this case GREEN on G2-B's
 * refusal. Measured: see the suite header.
 */
describe(`§B ${CLAIM_B}`, () => {
  it('REFUSES the customer payment for the missing payments.collect, writes no payment, and still serves the receivable read it DOES hold', async () => {
    const hdrs = headersOf(noPaymentsCollect);

    // 1. THE POSITIVE CONTROL, FIRST, so the refusal below is read against a
    //    member already proven able to reach this customer's money.
    //    `receivables.view` is a key this actor HOLDS.
    const before = await readReceivable(noPaymentsCollect, customerB);
    expect(
      before.status,
      `THE CONTROL FAILED before the refusal: the member cannot even READ this customer's receivable, so a 403 on the collection would prove ` +
        `nothing about payments.collect. Measured: ${before.status} ${JSON.stringify(before.body)}`,
    ).toBe(200);
    expect(
      BigInt(String((before.body as { baseMinor?: string }).baseMinor ?? '0')) !== 0n,
      `NO SUBJECT — the customer owes nothing, so "the outstanding did not move" would compare 0 with 0: ${JSON.stringify(before.body)}`,
    ).toBe(true);

    // 2. THE REFUSAL. A full allocation against that one open invoice.
    const paymentId = randomUUID();
    const refused = await collectPayment(w.t, hdrs, {
      paymentId,
      customerId: customerB,
      paymentMethodId: w.paymentMethodId,
      paymentDate: w.day,
      amountMinor: invoiceB.totalTxnMinor,
      allocations: [
        {
          invoiceId: invoiceB.invoiceId,
          appliedMinor: invoiceB.totalTxnMinor,
          releasedBeforeMinor: '0',
          invoiceTotalTxnMinor: invoiceB.totalTxnMinor,
          invoiceTotalBaseMinor: invoiceB.totalBaseMinor,
        },
      ],
    });
    expect(
      refused.status,
      `a member WITHOUT payments.collect took a customer's money and settled an invoice with it. ` +
        `Measured: ${refused.status} ${JSON.stringify(refused.body)}`,
    ).toBe(403);
    const envelope = (refused.body as { error?: { code?: string; message?: string } }).error;
    expect(envelope?.code, `the refusal is not the FORBIDDEN envelope: ${JSON.stringify(refused.body)}`).toBe('FORBIDDEN');
    expect(
      envelope?.message,
      `the 403 does not name payments.collect, so it may be a different denial than the one under test: ${JSON.stringify(refused.body)}`,
    ).toBe('Missing permission: payments.collect');

    // 3. THE WORLD, READ BACK: no payment document, and the outstanding where
    //    it was. The read is made by the SAME member, so step 1's control is
    //    still live at the end of the case.
    expect(await rowsFor('payments', 'id', paymentId), `the refused collection left a payments row behind: ${paymentId}`).toBe(0);
    const after = await readReceivable(noPaymentsCollect, customerB);
    expect(after.status, `the member could no longer read the receivable after the refusal: ${JSON.stringify(after.body)}`).toBe(200);
    expect(
      after.body,
      `the refused collection MOVED the customer's outstanding. before=${JSON.stringify(before.body)} after=${JSON.stringify(after.body)}`,
    ).toEqual(before.body);
  });
});
