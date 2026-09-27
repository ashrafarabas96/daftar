/**
 * P3-S6 T-08 — MP-6 / PM-15: A SUPPLIER CREDIT IS NEVER OVER-CONSUMED
 * (docs/PHASE_3_S6_CONTRACT.md A-10 (R-63), A-11 (2a'), A-12, §2.6
 * `supplier_allocate_credit` step 7 and `supplier_receive_refund` step 6,
 * §6 T-08).
 *
 * Every consumer locks the note FOR UPDATE, reads `r`, checks `c ≤ r`,
 * inserts its row and decrements both values — so, run truly concurrently in
 * two sessions (the second parks on the note row the first holds):
 *   - a credit allocation and a refund of 60 each on a 100 note: exactly one
 *     succeeds, the other `…amount_exceeds_credit`, in either order;
 *   - two refunds of 60: exactly one;
 *   - two refunds of 40 (disjoint, both fit): the second was bound against
 *     r = 100 and is refused `supplier_refund.settlement_changed` (retryable);
 *     re-bound, it succeeds — 20 remain;
 *   - the same race through the real API: one 201, the other 422;
 *   - a forged UPDATE of the note (owner, no backing consumer) is
 *     `supplier_credit_note.immutable`;
 *   - PM-15's detection query returns 0 rows after every case.
 */
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import {
  asMember,
  expectAccepted,
  must,
  onboardS3Business,
  ownerClient,
  pidOf,
  refusedWith,
  registerActor,
  rolledBack,
  scratch,
  settle,
  today,
  waitUntilBlocked,
  type HttpActor,
  type Outcome,
  type S3Business,
} from '../helpers/inventory-commands';
import { receivedPurchase } from '../helpers/purchase-returns';
import {
  committed,
  createMethod,
  httpMethod,
  noteOf,
  prepareAllocate,
  prepareRefund,
  refundBody,
  refusalCode,
  returnToCredit,
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
  owner = await registerActor(t, 'S6 credit concurrency owner');
  A = await onboardS3Business(t, owner, 's6cc');
  acc = await seedSettlementAccounts(ownerPool(), A);
  method = await committed((c) => createMethod(c, A, { postingAccountId: acc.settlement.cash }));
});

afterAll(async () => {
  await t.close();
  await resetData();
});

/** PM-15: every note whose stored pair is not what its consumers leave, or is out of bounds. */
async function pm15(): Promise<string[]> {
  const r = await ownerPool().query<{ id: string }>(
    `SELECT n.id::text FROM supplier_credit_notes n
      WHERE n.remaining_amount_minor < 0 OR n.remaining_amount_minor > n.original_amount_minor
         OR n.remaining_amount_minor <> n.original_amount_minor
              - (SELECT coalesce(sum(a.credit_amount_consumed_minor), 0) FROM supplier_credit_allocations a WHERE a.business_id = n.business_id AND a.credit_note_id = n.id)
              - (SELECT coalesce(sum(f.source_amount_consumed_minor), 0) FROM supplier_refunds f WHERE f.business_id = n.business_id AND f.credit_note_id = n.id)
         OR n.remaining_carrying_base_amount_minor
              <> supplier_credit_remaining_carrying(n.original_amount_minor, n.original_carrying_base_amount_minor, n.remaining_amount_minor)`,
  );
  return r.rows.map((x) => x.id);
}

/** A committed 100.00 ILS credit note (a real return after a full payment) and its supplier. */
function note100(): Promise<{ creditNoteId: string; supplierId: string }> {
  return committed(async (c) => {
    const n = await sqlReturnToCredit(c, A, method, { qty: '2', unitPriceMinor: '10000' });
    return { creditNoteId: n.creditNoteId, supplierId: n.purchase.supplierId };
  });
}

/** The first command holds its locks uncommitted; the second must park on the note row; then the first commits. */
async function race(first: S6Call, second: S6Call): Promise<{ first: Outcome<S6Row[]>; second: Outcome<S6Row[]> }> {
  const s1 = await ownerClient();
  const s2 = await ownerClient();
  try {
    await s1.query('BEGIN');
    await s2.query('BEGIN');
    const firstOutcome = await settle(() => runS6(s1, A, first));
    const pid2 = await pidOf(s2);
    const pending = settle(() => runS6(s2, A, second));
    await waitUntilBlocked(pid2, 'the second consumer parks on the note row the first holds');
    await s1.query(firstOutcome.ok ? 'COMMIT' : 'ROLLBACK');
    const secondOutcome = await pending;
    await s2.query(secondOutcome.ok ? 'COMMIT' : 'ROLLBACK');
    return { first: firstOutcome, second: secondOutcome };
  } finally {
    await s1.end();
    await s2.end();
  }
}

const bindRefund = (creditNoteId: string, consumed: bigint): Promise<S6Call> =>
  rolledBack((c) => prepareRefund(c, A, { creditNoteId, paymentMethodId: method, consumedMinor: consumed }));

describe('T-08 MP-6: concurrent consumers of one note', () => {
  it('a credit allocation and a refund of 60 each on 100: exactly one, in either order', async () => {
    for (const allocationFirst of [true, false]) {
      const { creditNoteId, supplierId } = await note100();
      const target = await committed((c) => receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '1', unitPriceMinor: '10000' }], { supplierId }));
      const allocation = await rolledBack((c) => prepareAllocate(c, A, { creditNoteId, purchaseId: target.purchaseId, consumedMinor: 6000n }));
      const refund = await bindRefund(creditNoteId, 6000n);
      const r = allocationFirst ? await race(allocation, refund) : await race(refund, allocation);
      expectAccepted(r.first, allocationFirst ? 'the allocation' : 'the refund');
      refusedWith(
        r.second,
        'P0001',
        allocationFirst ? 'supplier_refund.amount_exceeds_credit' : 'supplier_credit_allocation.amount_exceeds_credit',
        'the second consumer',
      );
      expect(await noteOf(ownerPool(), A.businessId, creditNoteId), 'exactly one 60 consumed').toMatchObject({ remaining: 4000n, remainingCarrying: 4000n });
    }
    expect(await pm15()).toEqual([]);
  });

  it('two refunds of 60 on 100: exactly one', async () => {
    const { creditNoteId } = await note100();
    const [one, two] = [await bindRefund(creditNoteId, 6000n), await bindRefund(creditNoteId, 6000n)];
    const r = await race(one, two);
    expectAccepted(r.first);
    refusedWith(r.second, 'P0001', 'supplier_refund.amount_exceeds_credit', 'the second refund');
    expect(await noteOf(ownerPool(), A.businessId, creditNoteId)).toMatchObject({ remaining: 4000n });
    expect(await pm15()).toEqual([]);
  });

  it('two refunds of 40 on 100 (disjoint): the stale one is settlement_changed, and its re-bound retry succeeds', async () => {
    const { creditNoteId } = await note100();
    const [one, two] = [await bindRefund(creditNoteId, 4000n), await bindRefund(creditNoteId, 4000n)];
    const r = await race(one, two);
    expectAccepted(r.first);
    refusedWith(r.second, 'P0001', 'supplier_refund.settlement_changed', 'bound against r = 100, now 60');
    const retry = await bindRefund(creditNoteId, 4000n);
    await committed((c) => runS6(c, A, retry));
    expect(await noteOf(ownerPool(), A.businessId, creditNoteId), 'two disjoint 40s: 20 remain').toMatchObject({ remaining: 2000n, remainingCarrying: 2000n });
    expect(await pm15()).toEqual([]);
  });

  it('through the API: two refunds of 60 at once — one 201, the other 422 amount_exceeds_credit', async () => {
    const payer = await httpMethod(t, owner, A, acc.settlement.bank);
    const { creditNoteId } = await returnToCredit(t, owner, A, payer, { lines: [{ productId: A.piece.productId, quantity: '2', unitPrice: '100.00' }] });
    expect((await noteOf(ownerPool(), A.businessId, creditNoteId)).remaining).toBe(10000n);
    const day = await today();
    const results = await settleConcurrently(2, () =>
      t.request
        .post('/v1/supplier-refunds')
        .set(asMember(owner, A.businessId))
        .send(refundBody(creditNoteId, payer, day, '6000')),
    );
    const responses = results.map((o) => expectAccepted(o, 'the request completes'));
    expect(responses.map((x) => x.status).sort(), JSON.stringify(responses.map((x): unknown => x.body))).toEqual([201, 422]);
    expect(refusalCode(must(responses.find((x) => x.status === 422)))).toBe('supplier_refund.amount_exceeds_credit');
    expect((await noteOf(ownerPool(), A.businessId, creditNoteId)).remaining).toBe(4000n);
    expect(await pm15()).toEqual([]);
  });
});

describe('T-08 a forged note UPDATE', () => {
  it('without a backing consumer the note is supplier_credit_note.immutable, whatever the pair', async () => {
    const { creditNoteId } = await note100();
    await rolledBack(async (c: Client) => {
      for (const [what, sql] of [
        [
          'a naked decrement to (99.00, g(99.00))',
          `UPDATE supplier_credit_notes SET remaining_amount_minor = 9900, remaining_carrying_base_amount_minor = 9900 WHERE business_id = $1 AND id = $2`,
        ],
        [
          'an increase',
          `UPDATE supplier_credit_notes SET remaining_amount_minor = 20000, remaining_carrying_base_amount_minor = 20000 WHERE business_id = $1 AND id = $2`,
        ],
        ['to zero', `UPDATE supplier_credit_notes SET remaining_amount_minor = 0, remaining_carrying_base_amount_minor = 0 WHERE business_id = $1 AND id = $2`],
      ] as const) {
        refusedWith(await scratch(c, () => settle(() => c.query(sql, [A.businessId, creditNoteId]))), 'P0001', 'supplier_credit_note.immutable', what);
      }
    });
    expect(await noteOf(ownerPool(), A.businessId, creditNoteId)).toMatchObject({ remaining: 10000n, remainingCarrying: 10000n });
    expect(await pm15()).toEqual([]);
  });
});
