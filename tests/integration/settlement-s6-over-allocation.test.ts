/**
 * P3-S6 T-05 — MP-3 / PM-12: A PURCHASE'S AP IS NEVER OVER-ALLOCATED
 * (docs/PHASE_3_S6_CONTRACT.md A-08 (R-62), A-11 (R-60), §2.3
 * `purchase_settlement_verify`, §2.6 steps 6 and 11, §6 T-05).
 *
 * - Two payments of 60 against 100 outstanding, run truly concurrently in
 *   two sessions: the second parks on the purchase row lock the first holds
 *   (2a), and once the first commits it re-reads O = 40 and is refused
 *   `supplier_payment.amount_exceeds_outstanding` — exactly one succeeds.
 *   The same race through the real API: exactly one 201, the other 422.
 * - A payment and a credit allocation of 60 each against the same 100: the
 *   same lock serializes them; the loser is refused
 *   `supplier_credit_allocation.amount_exceeds_outstanding` (or the payment
 *   code when it loses).
 * - A FORGED overlapping allocation — an owner INSERT of a second payment
 *   whose allocation restates the same X, triggers on, its entry posted — is
 *   refused at COMMIT by the chain guard: `supplier_payment.settlement_inconsistent`.
 *   The honest single allocation passes the same COMMIT (the ALLOW).
 * - PM-12's detection query (no purchase has applied more than its total,
 *   no outstanding is negative) returns 0 rows after every case.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import {
  atCommit,
  expectAccepted,
  must,
  onboardS3Business,
  ownerClient,
  pidOf,
  refusedWith,
  registerActor,
  rolledBack,
  settle,
  waitUntilBlocked,
  type HttpActor,
  type Outcome,
  type S3Business,
} from '../helpers/inventory-commands';
import { postInTx } from '../helpers/purchase-commands';
import { receivedPurchase, type ReceivedPurchase } from '../helpers/purchase-returns';
import {
  committed,
  createMethod,
  httpMethod,
  httpPay,
  httpReceived,
  outstandingOf,
  payBody,
  prepareAllocate,
  preparePay,
  refusalCode,
  runS6,
  seedSettlementAccounts,
  settleConcurrently,
  sqlReturnToCredit,
  type S6Call,
  type S6Row,
  type SettlementAccounts,
} from '../helpers/supplier-settlement';

let t: TestApp;
let owner: HttpActor;
let A: S3Business;
let acc: SettlementAccounts;
let method: string;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  t = await createTestApp();
  owner = await registerActor(t, 'S6 over-allocation owner');
  A = await onboardS3Business(t, owner, 's6over');
  acc = await seedSettlementAccounts(ownerPool(), A);
  method = await committed((c) => createMethod(c, A, { postingAccountId: acc.settlement.cash }));
});

afterAll(async () => {
  await t.close();
  await resetData();
});

/** PM-12's detection query: every purchase whose AP reducers exceed its total, or whose outstanding is negative. */
async function pm12(): Promise<string[]> {
  const r = await ownerPool().query<{ id: string }>(
    `SELECT p.id::text FROM purchases p
      WHERE p.status = 'received'
        AND ((SELECT coalesce(sum(r.ap_txn_minor), 0) FROM supplier_returns r WHERE r.business_id = p.business_id AND r.purchase_id = p.id)
           + (SELECT coalesce(sum(a.purchase_amount_applied_minor), 0) FROM supplier_payment_allocations a WHERE a.business_id = p.business_id AND a.purchase_id = p.id)
           + (SELECT coalesce(sum(a.purchase_amount_applied_minor), 0) FROM supplier_credit_allocations a WHERE a.business_id = p.business_id AND a.purchase_id = p.id)
           > p.total_txn_minor
          OR purchase_ap_outstanding(p.business_id, p.id) < 0)`,
  );
  return r.rows.map((x) => x.id);
}

/** A committed received purchase of one piece at `priceMinor` (ILS), of `supplierId` when given. */
function purchaseOf(priceMinor: string, supplierId?: string): Promise<ReceivedPurchase> {
  return committed((c) =>
    receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '1', unitPriceMinor: priceMinor }], supplierId === undefined ? {} : { supplierId }),
  );
}

/**
 * Two commands bound against the same state, run in two sessions: the first
 * holds its locks uncommitted, the second must park on them, then the first
 * commits and the second finishes (and commits when accepted).
 */
async function race(first: S6Call, second: S6Call): Promise<{ first: Outcome<S6Row[]>; second: Outcome<S6Row[]> }> {
  const s1 = await ownerClient();
  const s2 = await ownerClient();
  try {
    await s1.query('BEGIN');
    await s2.query('BEGIN');
    const firstOutcome = await settle(() => runS6(s1, A, first));
    const pid2 = await pidOf(s2);
    const pending = settle(() => runS6(s2, A, second));
    await waitUntilBlocked(pid2, 'the second settlement parks on the purchase row the first holds');
    await s1.query(firstOutcome.ok ? 'COMMIT' : 'ROLLBACK');
    const secondOutcome = await pending;
    await s2.query(secondOutcome.ok ? 'COMMIT' : 'ROLLBACK');
    return { first: firstOutcome, second: secondOutcome };
  } finally {
    await s1.end();
    await s2.end();
  }
}

describe('T-05 MP-3: concurrent settlements of one purchase', () => {
  it('two payments of 60 against 100: the second waits on the purchase row, then is refused amount_exceeds_outstanding', async () => {
    const p = await purchaseOf('100');
    expect((await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).o).toBe(100n);
    const bind = (): Promise<S6Call> =>
      rolledBack((c) =>
        preparePay(c, A, { supplierId: p.supplierId, paymentMethodId: method, allocations: [{ purchaseId: p.purchaseId, paymentAmountMinor: 60n }] }),
      );
    const [one, two] = [await bind(), await bind()];
    const r = await race(one, two);
    expect(expectAccepted(r.first, 'the first payment')[0]).toMatchObject({ replayed: false });
    refusedWith(r.second, 'P0001', 'supplier_payment.amount_exceeds_outstanding', 'the second payment');
    expect((await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).o, 'exactly one 60 applied').toBe(40n);
    expect(await pm12()).toEqual([]);
  });

  it('a payment and a credit allocation of 60 each against 100: exactly one wins, in either order', async () => {
    const { purchase: origin, creditNoteId } = await committed((c) => sqlReturnToCredit(c, A, method, { qty: '2', unitPriceMinor: '1000' }));
    for (const payFirst of [true, false]) {
      const p = await purchaseOf('100', origin.supplierId);
      const pay = await rolledBack((c) =>
        preparePay(c, A, { supplierId: p.supplierId, paymentMethodId: method, allocations: [{ purchaseId: p.purchaseId, paymentAmountMinor: 60n }] }),
      );
      const credit = await rolledBack((c) => prepareAllocate(c, A, { creditNoteId, purchaseId: p.purchaseId, consumedMinor: 60n }));
      const r = payFirst ? await race(pay, credit) : await race(credit, pay);
      expectAccepted(r.first, payFirst ? 'the payment' : 'the credit allocation');
      refusedWith(
        r.second,
        'P0001',
        payFirst ? 'supplier_credit_allocation.amount_exceeds_outstanding' : 'supplier_payment.amount_exceeds_outstanding',
        payFirst ? 'the credit allocation after the payment' : 'the payment after the credit allocation',
      );
      expect((await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).o, 'exactly one 60 applied').toBe(40n);
    }
    expect(await pm12()).toEqual([]);
  });

  it('through the API: two payments of 60 against 100 at once — exactly one 201, the other 422 amount_exceeds_outstanding', async () => {
    const httpMethodId = await httpMethod(t, owner, A, acc.settlement.bank);
    const p = await httpReceived(t, owner, A, { lines: [{ productId: A.piece.productId, quantity: '1', unitPrice: '1.00' }] });
    const results = await settleConcurrently(2, () =>
      httpPay(t, owner, A, payBody(p.supplierId, httpMethodId, p.documentDate, [{ purchaseId: p.purchaseId, paymentAmountMinor: '60' }])),
    );
    const responses = results.map((o) => expectAccepted(o, 'the request completes'));
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses, JSON.stringify(responses.map((r): unknown => r.body))).toEqual([201, 422]);
    const loser = must(responses.find((r) => r.status === 422));
    expect(refusalCode(loser)).toBe('supplier_payment.amount_exceeds_outstanding');
    expect((await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).o).toBe(40n);
    expect(await pm12()).toEqual([]);
  });
});

describe('T-05 R-62: a forged overlapping allocation is refused at COMMIT', () => {
  /**
   * The owner copies the honest payment under new ids — a second header and
   * an allocation restating the SAME X (the first one's) — with every
   * trigger on and its own entry posted, so the only thing wrong is the
   * overlap.
   */
  async function forgeOverlap(c: Client, honest: S6Call, allocationId: string): Promise<void> {
    const paymentId = randomUUID();
    await c.query(
      `INSERT INTO supplier_payments (tenant_id, business_id, id, supplier_id, payment_method_id, posting_account_id, currency_code, amount_minor,
                                      payment_to_base_rate, rate_source, rate_timestamp, fx_rate_id, base_amount_minor, payment_date, reference,
                                      allocation_count, intent_sha256, business_transaction_id, created_by)
       SELECT tenant_id, business_id, $3, supplier_id, payment_method_id, posting_account_id, currency_code, amount_minor,
              payment_to_base_rate, rate_source, rate_timestamp, fx_rate_id, base_amount_minor, payment_date, reference,
              allocation_count, intent_sha256, business_transaction_id, created_by
         FROM supplier_payments WHERE business_id = $1 AND id = $2`,
      [A.businessId, honest.params[0], paymentId],
    );
    await c.query(
      `INSERT INTO supplier_payment_allocations (tenant_id, business_id, id, payment_id, supplier_id, purchase_id, line_no, payment_currency,
                                                 payment_amount_minor, payment_to_base_rate, payment_base_amount_minor, purchase_currency,
                                                 purchase_amount_applied_minor, purchase_historical_to_base_rate, ap_released_before_txn_minor,
                                                 purchase_carrying_base_released_minor, ap_dust_base_minor, realized_fx_gain_loss_minor, binding_source_id)
       SELECT tenant_id, business_id, $4, $3, supplier_id, purchase_id, line_no, payment_currency,
              payment_amount_minor, payment_to_base_rate, payment_base_amount_minor, purchase_currency,
              purchase_amount_applied_minor, purchase_historical_to_base_rate, ap_released_before_txn_minor,
              purchase_carrying_base_released_minor, ap_dust_base_minor, realized_fx_gain_loss_minor, $4
         FROM supplier_payment_allocations WHERE business_id = $1 AND payment_id = $2`,
      [A.businessId, honest.params[0], paymentId, allocationId],
    );
    await postInTx(c, { ...must(honest.postings[0]), sourceId: allocationId }, A.userId);
  }

  it('the honest allocation commits; its overlapping copy is supplier_payment.settlement_inconsistent', async () => {
    await rolledBack(async (c) => {
      const method2 = await createMethod(c, A, { postingAccountId: acc.settlement.cash });
      const p = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '1', unitPriceMinor: '100' }]);
      const honest = await preparePay(c, A, {
        supplierId: p.supplierId,
        paymentMethodId: method2,
        allocations: [{ purchaseId: p.purchaseId, paymentAmountMinor: 60n }],
      });
      await runS6(c, A, honest);
      expectAccepted(await atCommit(c), 'the honest allocation alone');
      await forgeOverlap(c, honest, randomUUID());
      refusedWith(await atCommit(c), 'P0001', 'supplier_payment.settlement_inconsistent', 'two allocations computed from the same X');
    });
    expect(await pm12()).toEqual([]);
  });
});
