/**
 * P3-S6 T-12 — THE S5 PROOFS AGAIN, AGAINST REAL ALLOCATIONS
 * (docs/PHASE_3_S6_CONTRACT.md A-13, §6 T-12; S5 TL-9, S5 T-07, T-08;
 * 0065 R-54; 0067 R-62, R-67).
 *
 * S5 was proven against a settlement fixture; with S6 the extension points
 * `purchase_ap_outstanding` and `purchase_settlement_state` read the real
 * allocation tables, so:
 *   - AP FIRST (S5 T-07): a return after a partial payment releases
 *     least(C, O) of AP and issues the excess as a credit note — paid 60.00
 *     of 100.00, a return carrying 50.00 releases 40.00 and credits 10.00;
 *   - a return and the payments CHAIN (R-62): paid 30.00, a return of 25.00,
 *     then 45.00 settles exactly (O = 0, ledger AP 0 / 0), and a further
 *     0.01 exceeds what is outstanding; PM-12's detection query is empty;
 *   - the reversal (S5 T-08 (a)(b)): a purchase with a payment allocated is
 *     `purchase_reversal.payment_allocated`, with a credit allocated
 *     `purchase_reversal.credit_allocated` (409, nothing written) — in the
 *     routine and, with the routine's extension point forged away, at COMMIT
 *     by `purchase_reversals_unsettled` (R-67); an unsettled purchase reverses;
 *   - 0065 R-54 still holds with a payment present: a return whose X (a
 *     forged `purchase_ap_outstanding`, in its own transaction only) forgets
 *     a committed return fails COMMIT `inventory.source_value_mismatch`; the
 *     honest X counts the payment and the return; and, as 0067 R-62 claims
 *     ("an S5 return's X counts the S6 reducers before it"), a return whose X
 *     forgets only a committed PAYMENT is refused the same.
 */
import type { Client } from 'pg';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import {
  asMember,
  atCommit,
  expectAccepted,
  must,
  onboardS3Business,
  ownerClient,
  refusedWith,
  registerActor,
  settle,
  today,
  type HttpActor,
  type Outcome,
  type S3Business,
} from '../helpers/inventory-commands';
import { prepareReturn, prepareReversal, receivedPurchase, runReturn, runReversal, tryReturn, tryS5, type ReceivedPurchase } from '../helpers/purchase-returns';
import {
  allocateBody,
  committed,
  createMethod,
  expectRefusal,
  httpMethod,
  httpPay,
  httpReceived,
  httpReturn,
  noteOf,
  outstandingOf,
  payBody,
  preparePay,
  returnToCredit,
  runS6,
  s6Counts,
  seedSettlementAccounts,
  settlementLedgerAp,
  type HttpPurchase,
  type SettlementAccounts,
} from '../helpers/supplier-settlement';

let t: TestApp;
let owner: HttpActor;
let A: S3Business;
let acc: SettlementAccounts;
let method: string;
let day: string;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
  t = await createTestApp();
  owner = await registerActor(t, 'S6 S5-reproof owner');
  A = await onboardS3Business(t, owner, 's6s5');
  acc = await seedSettlementAccounts(ownerPool(), A);
  method = await httpMethod(t, owner, A, acc.settlement.cash);
});

afterAll(async () => {
  await t.close();
  await resetData();
});

const headers = (): Record<string, string> => asMember(owner, A.businessId);

/** 4 × 25.00 ILS = 100.00, received through the API. */
const purchase100 = (supplierId?: string): Promise<HttpPurchase> =>
  httpReceived(t, owner, A, {
    ...(supplierId === undefined ? {} : { supplierId }),
    lines: [{ productId: A.piece.productId, quantity: '4', unitPrice: '25.00' }],
  });

async function pay(p: HttpPurchase, amount: string): Promise<Response> {
  return httpPay(t, owner, A, payBody(p.supplierId, method, day, [{ purchaseId: p.purchaseId, paymentAmountMinor: amount }]));
}

async function storedReturn(returnId: string): Promise<{ ap: string; credit: string; x: string; note: string | null }> {
  return must(
    (
      await ownerPool().query<{ ap: string; credit: string; x: string; note: string | null }>(
        `SELECT ap_txn_minor::text AS ap, credit_txn_minor::text AS credit, ap_released_before_txn_minor::text AS x, credit_note_id::text AS note
           FROM supplier_returns WHERE business_id = $1 AND id = $2`,
        [A.businessId, returnId],
      )
    ).rows[0],
  );
}

/** PM-12: every purchase whose reducers overrun its total or whose stored X does not chain. */
async function pm12(): Promise<string[]> {
  const r = await ownerPool().query<{ id: string }>(
    `SELECT p.id::text FROM purchases p
      WHERE p.business_id = $1 AND p.status = 'received'
        AND (purchase_ap_outstanding(p.business_id, p.id) < 0 OR purchase_ap_outstanding(p.business_id, p.id) > p.total_txn_minor)`,
    [A.businessId],
  );
  return r.rows.map((x) => x.id);
}

describe('T-12 S5 T-07 again: AP first, against a real payment', () => {
  it('paid 60.00 of 100.00, a return carrying 50.00 releases 40.00 of AP and credits 10.00', async () => {
    const p = await purchase100();
    expect((await pay(p, '6000')).status).toBe(201);
    expect(await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).toMatchObject({ o: 4000n });
    const ret = await httpReturn(t, owner, A, p, '2');
    const stored = await storedReturn(String(ret.returnId));
    expect(stored, 'X = the payment; AP = least(C, O) = 40.00; the excess is credit').toMatchObject({ ap: '4000', credit: '1000', x: '6000' });
    expect(await noteOf(ownerPool(), A.businessId, must(stored.note))).toMatchObject({ original: 1000n, remaining: 1000n });
    expect(await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).toMatchObject({ o: 0n });
    expect(await settlementLedgerAp(ownerPool(), A.businessId, p.purchaseId), 'the ledger AP clears').toEqual({ base: 0n, txn: 0n });
  });
});

describe('T-12 R-62: a return and the payments chain', () => {
  it('paid 30.00, returned 25.00, then 45.00 settles exactly; 0.01 more exceeds what is outstanding', async () => {
    const p = await purchase100();
    expect((await pay(p, '3000')).status).toBe(201);
    const ret = await httpReturn(t, owner, A, p, '1');
    expect(await storedReturn(String(ret.returnId)), 'X = 30.00; all AP, no credit').toMatchObject({ ap: '2500', credit: '0', x: '3000', note: null });
    expect(await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).toMatchObject({ o: 4500n });
    const last = await pay(p, '4500');
    expect(last.status, JSON.stringify(last.body)).toBe(201);
    expect(
      must((last.body as { allocations: { apReleasedBeforeTxnMinor: string }[] }).allocations[0]).apReleasedBeforeTxnMinor,
      'the payment after the return starts where the payment and the return left X',
    ).toBe('5500');
    expect(await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).toMatchObject({ o: 0n });
    expect(await settlementLedgerAp(ownerPool(), A.businessId, p.purchaseId)).toEqual({ base: 0n, txn: 0n });
    const before = await s6Counts(ownerPool(), A.businessId);
    expectRefusal(await pay(p, '1'), 422, 'supplier_payment.amount_exceeds_outstanding', 'nothing is outstanding');
    expect(await s6Counts(ownerPool(), A.businessId)).toEqual(before);
    expect(await pm12()).toEqual([]);
  });
});

describe('T-12 S5 T-08 again: a settled purchase is not reversed', () => {
  const reverse = (p: HttpPurchase): Promise<Response> =>
    t.request.post(`/v1/purchases/${p.purchaseId}/reversal`).set(headers()).send({ reversalDate: day, reason: 'Received twice' });

  it('(a) a payment allocated → 409 payment_allocated; (b) a credit allocated → 409 credit_allocated; nothing written; unsettled → reversed', async () => {
    const paid = await purchase100();
    expect((await pay(paid, '100')).status).toBe(201);
    let before = await s6Counts(ownerPool(), A.businessId);
    expectRefusal(await reverse(paid), 409, 'purchase_reversal.payment_allocated', '(a)');
    expect(await s6Counts(ownerPool(), A.businessId)).toEqual(before);

    const note = await returnToCredit(t, owner, A, method, { lines: [{ productId: A.piece.productId, quantity: '1', unitPrice: '10.00' }] });
    const credited = await purchase100(note.purchase.supplierId);
    const r = await t.request
      .post('/v1/supplier-credit-allocations')
      .set(headers())
      .send(allocateBody(note.creditNoteId, credited.purchaseId, day, '500'));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    before = await s6Counts(ownerPool(), A.businessId);
    expectRefusal(await reverse(credited), 409, 'purchase_reversal.credit_allocated', '(b)');
    expect(await s6Counts(ownerPool(), A.businessId)).toEqual(before);

    const unsettled = await purchase100();
    expect((await reverse(unsettled)).status, 'ALLOW: an unsettled purchase reverses').toBe(200);
  });

  it('R-67 at COMMIT: with purchase_settlement_state forged to (false, false), the routine passes and purchase_reversals_unsettled refuses', async () => {
    const m = await committed((c) => createMethod(c, A, { postingAccountId: acc.settlement.bank }));
    const p = await committed(async (c) => {
      const received = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '2', unitPriceMinor: '1000' }]);
      await runS6(
        c,
        A,
        await preparePay(c, A, {
          supplierId: received.supplierId,
          paymentMethodId: m,
          allocations: [{ purchaseId: received.purchaseId, paymentAmountMinor: 500n }],
        }),
      );
      return received;
    });
    const before = await s6Counts(ownerPool(), A.businessId);
    const c = await ownerClient();
    try {
      await c.query('BEGIN');
      const honest = await prepareReversal(c, A, p.purchaseId);
      refusedWith(await tryS5(c, A, honest.cmd, { trace: honest.trace }), 'P0001', 'purchase_reversal.payment_allocated', 'the routine itself');
      await c.query(`CREATE OR REPLACE FUNCTION purchase_settlement_state(p_business_id UUID, p_purchase_id UUID,
                       OUT payment_allocated BOOLEAN, OUT credit_allocated BOOLEAN)
                     LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
                     BEGIN payment_allocated := false; credit_allocated := false; END; $$`);
      const prep = await prepareReversal(c, A, p.purchaseId);
      expectAccepted(await settle(() => runReversal(c, A, prep)), 'the forged extension point lets the routine through');
      refusedWith(await atCommit(c), 'P0001', 'purchase_reversal.payment_allocated', 'the deferred guard reads the table itself');
    } finally {
      // The forged extension point never outlives this transaction.
      await c.query('ROLLBACK');
      await c.end();
    }
    expect(await s6Counts(ownerPool(), A.businessId), 'nothing written').toEqual(before);
    const status = must((await ownerPool().query<{ s: string }>(`SELECT status AS s FROM purchases WHERE id = $1`, [p.purchaseId])).rows[0]).s;
    expect(status).toBe('received');
  });
});

describe('T-12 0065 R-54 still holds with S6 allocations', () => {
  /** `purchase_ap_outstanding` answering T minus the returns only (or minus nothing), in the caller's transaction only. */
  async function forgeOutstanding(c: Client, keep: 'nothing' | 'returns'): Promise<void> {
    const kept =
      keep === 'nothing'
        ? '0'
        : `(SELECT coalesce(sum(r.ap_txn_minor), 0) FROM supplier_returns r WHERE r.business_id = p_business_id AND r.purchase_id = p_purchase_id)`;
    await c.query(`CREATE OR REPLACE FUNCTION purchase_ap_outstanding(p_business_id UUID, p_purchase_id UUID) RETURNS BIGINT
                   LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
                   BEGIN RETURN (SELECT p.total_txn_minor - ${kept} FROM purchases p WHERE p.business_id = p_business_id AND p.id = p_purchase_id); END; $$`);
  }

  /** A committed 40.00 purchase with a committed 15.00 payment and a committed return of one 10.00 piece (X = 15.00). */
  async function settledAndReturned(): Promise<ReceivedPurchase> {
    const m = await committed((c) => createMethod(c, A, { postingAccountId: acc.settlement.bank }));
    const p = await committed(async (c) => {
      const received = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '4', unitPriceMinor: '1000' }]);
      await runS6(
        c,
        A,
        await preparePay(c, A, {
          supplierId: received.supplierId,
          paymentMethodId: m,
          allocations: [{ purchaseId: received.purchaseId, paymentAmountMinor: 1500n }],
        }),
      );
      return received;
    });
    const first = await committed(async (c) => {
      const prep = await prepareReturn(c, A, p.purchaseId, { lines: [{ purchaseLineId: must(p.lines[0]).lineId, qty: '1' }] });
      await runReturn(c, A, prep);
      return prep;
    });
    expect(await storedReturn(first.cmd.returnId), 'the first return counted the payment').toMatchObject({ x: '1500', ap: '1000' });
    return p;
  }

  /** A second return of one piece under a forged `purchase_ap_outstanding`, and its COMMIT probe; always rolled back. */
  async function forgedReturnAtCommit(p: ReceivedPurchase, keep: 'nothing' | 'returns'): Promise<{ x: string; outcome: Outcome<null> }> {
    const c: Client = await ownerClient();
    try {
      await c.query('BEGIN');
      await forgeOutstanding(c, keep);
      const prep = await prepareReturn(c, A, p.purchaseId, { lines: [{ purchaseLineId: must(p.lines[0]).lineId, qty: '1' }] });
      expectAccepted(await tryReturn(c, A, prep), 'the forged return is taken by the routine');
      const x = must(
        (
          await c.query<{ x: string }>(`SELECT ap_released_before_txn_minor::text AS x FROM supplier_returns WHERE business_id = $1 AND id = $2`, [
            A.businessId,
            prep.cmd.returnId,
          ])
        ).rows[0],
      ).x;
      return { x, outcome: await atCommit(c) };
    } finally {
      // The forged extension point never outlives this transaction.
      await c.query('ROLLBACK');
      await c.end();
    }
  }

  it('a return whose X forgets the committed return (X = 0 < 10.00) fails at COMMIT source_value_mismatch, a payment present', async () => {
    const p = await settledAndReturned();
    const r = await forgedReturnAtCommit(p, 'nothing');
    expect(r.x, 'X = T − forged O').toBe('0');
    refusedWith(r.outcome, 'P0001', 'inventory.source_value_mismatch', 'X = 0 forgets the committed 10.00 return');
    // The honest second return records X = the payment and the first return.
    const honest = await committed(async (h) => {
      const prep = await prepareReturn(h, A, p.purchaseId, { lines: [{ purchaseLineId: must(p.lines[0]).lineId, qty: '1' }] });
      await runReturn(h, A, prep);
      return prep;
    });
    expect(await storedReturn(honest.cmd.returnId)).toMatchObject({ x: '2500', ap: '1000', credit: '0' });
  });

  it('R-62 "an S5 return’s X counts the S6 reducers before it": a return whose X forgets only the committed PAYMENT is refused at COMMIT', async () => {
    const p = await settledAndReturned();
    const r = await forgedReturnAtCommit(p, 'returns');
    expect(r.x, 'X = the returns only: the committed 15.00 payment forgotten').toBe('1000');
    // Either the S5 value guard or the R-62 chain may refuse it; what must not happen is that it commits.
    expect(r.outcome.ok ? 'accepted' : `${r.outcome.sqlstate} ${r.outcome.code}`, 'X = 10.00 forgets the committed 15.00 payment').toMatch(
      /^P0001 (inventory\.source_value_mismatch|supplier_payment\.settlement_inconsistent)$/,
    );
  });
});
