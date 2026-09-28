/**
 * P3-S6 T-07 — MP-5: PROPORTIONAL RELEASE, AND THE FINAL CONSUMER FLUSHES
 * THE WHOLE RESIDUE (docs/PHASE_3_S6_CONTRACT.md A-08, A-10, §2.3, §4.1,
 * §6 T-07; 0067 R-69; GOLD-84, DM §7ج, INV-ACC-17).
 *
 * Every figure is the package vector's (`supplier-settlement-vectors.json`):
 *   - GOLD-84 through the real API: a 100.00 USD credit note carried at
 *     360.00 ILS (a real return after a full payment); a refund of 60.00
 *     releases the cumulative proportional 216.00, 144.00 stays carried; the
 *     final 40.00 (received @ 3.70) releases the entire 144.00 residue with a
 *     4.00 gain; the note is then 0 / 0, a further refund is
 *     `credit_exhausted`, and 1150 nets to 0 per branch over the note's life
 *     (INV-ACC-17);
 *   - AP-THIRDS-EXACT-CLEARING through the real API: 1.00 USD @ 3.65 paid in
 *     thirds @ 3.70 releases 120 + 121 + 124 = 365 exactly — AP base is 0
 *     when AP txn is 0;
 *   - on a JOD-base business with LBP purchases @ 0.0000024900 (the strong
 *     base, SQL through the real routines):
 *       · STRONG-BASE-MIN1: 790.00 then 210.00 LBP of a credit carried at
 *         0.002 JOD: `g` keeps 1 while the note is open, the final consumer
 *         releases it — and the target purchase's AP base is 0 before its txn
 *         residue (R-69(a) ABSORBED: rel 0, AP line conv(a), dust −conv(a),
 *         the whole base realized); the same absorption by a payment;
 *       · BELOW-BASE-UNIT (R-69(b)): a txn-only residue of 0.10 LBP whose
 *         base is 0 — left by a frozen S5 partial return, the one origin S6
 *         cannot prevent — cannot be cleared: every payment, credit
 *         allocation and refund that converts to 0 is refused
 *         `…amount_below_base_unit` by the binder AND by the routine, and the
 *         residue stays open;
 *   - the SQL arithmetic functions answer every primitive of every vector
 *     exactly as the package does.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import {
  asMember,
  atCommit,
  expectAccepted,
  must,
  onboardS3Business,
  refusedWith,
  registerActor,
  rolledBack,
  today,
  type HttpActor,
  type Queryable,
  type S3Business,
} from '../helpers/inventory-commands';
import { historicalReturnInTx } from '../helpers/p3c-residue';
import { receivedPurchase } from '../helpers/purchase-returns';
import {
  bindingRefusal,
  concreteLines,
  createMethod,
  creditNoteIdOf,
  expectRefusal,
  httpMethod,
  httpPay,
  httpReceived,
  noteOf,
  outstandingOf,
  payBody,
  prepareAllocate,
  preparePay,
  prepareRefund,
  refundBody,
  runS6,
  seedBusinessWithBase,
  seedSettlementAccounts,
  settlementEntry,
  settlementFx,
  settlementLedgerAp,
  settlementVector,
  settlementVectors,
  sqlPrimitives,
  sqlReturnToCredit,
  stateRate,
  tryS6,
  vectorLines,
  type S6Call,
  type SettlementAccounts,
} from '../helpers/supplier-settlement';

let t: TestApp;
let owner: HttpActor;
let A: S3Business;
let J: S3Business;
let acc: SettlementAccounts;
let accJ: SettlementAccounts;
let method: string;
let day: string;

function ago(n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
  t = await createTestApp();
  owner = await registerActor(t, 'S6 carrying owner');
  A = await onboardS3Business(t, owner, 's6carry');
  acc = await seedSettlementAccounts(ownerPool(), A);
  method = await httpMethod(t, owner, A, acc.settlement.bank, { systemType: 'bank_transfer' });
  await stateRate(A, 'USD', 'ILS', '3.6000000000', `${ago(10)}T00:00:00Z`);
  await stateRate(A, 'USD', 'ILS', '3.7000000000', `${ago(7)}T00:00:00Z`);
  await stateRate(A, 'USD', 'ILS', '3.6500000000', `${ago(5)}T00:00:00Z`);
  await stateRate(A, 'USD', 'ILS', '3.7000000000', `${ago(4)}T00:00:00Z`);
  J = await seedBusinessWithBase(ownerPool(), 'JOD', 's6strong');
  accJ = await seedSettlementAccounts(ownerPool(), J);
  await stateRate(J, 'LBP', 'JOD', '0.0000024900', `${ago(10)}T00:00:00Z`);
});

afterAll(async () => {
  await t.close();
  await resetData();
});

/** INV-ACC-17: over the note's return entry and all its consumers, 1150 nets to 0 on every branch. */
async function receivable1150ByBranch(q: Queryable, businessId: string, creditNoteId: string): Promise<{ branch: string | null; net: string }[]> {
  const r = await q.query<{ branch: string | null; net: string }>(
    `WITH src AS (
       SELECT 'supplier_return'::text AS t, n.supplier_return_id AS id FROM supplier_credit_notes n WHERE n.business_id = $1 AND n.id = $2
       UNION ALL SELECT 'supplier_credit_allocation', a.id FROM supplier_credit_allocations a WHERE a.business_id = $1 AND a.credit_note_id = $2
       UNION ALL SELECT 'supplier_refund', f.id FROM supplier_refunds f WHERE f.business_id = $1 AND f.credit_note_id = $2)
     SELECT l.branch_id::text AS branch, sum(l.debit_minor - l.credit_minor)::text AS net
       FROM src JOIN journal_entries e ON e.business_id = $1 AND e.source_type = src.t AND e.source_id = src.id
       JOIN journal_lines l ON l.business_id = e.business_id AND l.journal_entry_id = e.id
       JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id AND a.system_key = 'supplier_receivable'
      GROUP BY l.branch_id`,
    [businessId, creditNoteId],
  );
  return r.rows;
}

describe('T-07 GOLD-84 through the API: partial refund proportional, final refund flushes', () => {
  it('216.00 / 144.00 / 144.00 exactly, a 4.00 gain on the final, then credit_exhausted; 1150 nets to 0 per branch', async () => {
    const v = settlementVector('GOLD-84-PARTIAL-FINAL');
    const p = await httpReceived(t, owner, A, {
      currency: 'USD',
      documentDate: ago(9),
      lines: [{ productId: A.piece.productId, quantity: '2', unitPrice: '100.00' }],
    });
    const paid = await httpPay(
      t,
      owner,
      A,
      payBody(p.supplierId, method, ago(9), [{ purchaseId: p.purchaseId, paymentAmountMinor: '20000' }], { currencyCode: 'USD' }),
    );
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const returnId = randomUUID();
    const ret = await t.request
      .post(`/v1/purchases/${p.purchaseId}/returns`)
      .set(asMember(owner, A.businessId))
      .send({ returnId, warehouseId: A.w1, documentDate: ago(8), lines: [{ lineId: randomUUID(), purchaseLineId: must(p.lineIds[0]), quantity: '1' }] });
    expect(ret.status, JSON.stringify(ret.body)).toBe(201);
    const noteId = must(await creditNoteIdOf(ownerPool(), A.businessId, returnId), 'the credit note');
    expect(await noteOf(ownerPool(), A.businessId, noteId), 'N1: 100.00 USD carried at 360.00').toEqual({
      original: 10000n,
      originalCarrying: 36000n,
      remaining: 10000n,
      remainingCarrying: 36000n,
    });
    const dates = [ago(8), ago(6), ago(6)];
    for (const [k, s] of v.steps.entries()) {
      const consumed = String(s.step.consumedMinor);
      const r = await t.request
        .post('/v1/supplier-refunds')
        .set(asMember(owner, A.businessId))
        .send(refundBody(noteId, method, must(dates[k]), consumed, { receiptCurrencyCode: 'USD', receiptAmountMinor: String(s.step.receiptAmountMinor) }));
      if (s.outcome !== 'accepted') {
        expectRefusal(r, 409, s.outcome, `step ${k + 1}`);
        continue;
      }
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const plan = must(s.plan);
      expect(r.body, `step ${k + 1}: the stored refund is the vector's plan`).toMatchObject({
        sourceAmountConsumedMinor: plan.consumedMinor,
        creditRemainingBeforeMinor: plan.remainingBeforeMinor,
        sourceCarryingBaseReleasedMinor: plan.creditReleasedMinor,
        sourceDustBaseMinor: plan.creditDustBaseMinor,
        receiptAmountMinor: plan.receiptAmountMinor,
        receiptBaseMinor: plan.receiptBaseMinor,
        realizedFxMinor: plan.realizedMinor,
      });
      const entry = must(await settlementEntry(ownerPool(), A.businessId, 'supplier_refund', String((r.body as { refundId: string }).refundId)));
      expect(concreteLines(entry.lines, acc.settlement.bank), `step ${k + 1}: the A-05(c) entry`).toEqual(
        vectorLines(must(s.entry), { currencies: { receipt: 'USD', note: 'USD', base: 'ILS' }, branches: { purchase: A.branchX, origin: A.branchX } }),
      );
      const n = await noteOf(ownerPool(), A.businessId, noteId);
      expect({ remaining: n.remaining.toString(10), carrying: n.remainingCarrying.toString(10) }, `step ${k + 1}: after`).toEqual({
        remaining: s.after.remainingMinor,
        carrying: s.after.remainingCarryingMinor,
      });
    }
    expect(await receivable1150ByBranch(ownerPool(), A.businessId, noteId), 'INV-ACC-17').toEqual([{ branch: A.branchX, net: '0' }]);
  });
});

describe('T-07 AP-THIRDS-EXACT-CLEARING through the API', () => {
  it('1.00 USD @ 3.65 paid in thirds @ 3.70: releases 120 + 121 + 124 = 365; AP base is 0 when AP txn is 0', async () => {
    const v = settlementVector('AP-THIRDS-EXACT-CLEARING');
    const p = await httpReceived(t, owner, A, {
      currency: 'USD',
      documentDate: ago(5),
      lines: [{ productId: A.piece.productId, quantity: '1', unitPrice: '1.00' }],
    });
    expect(await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).toEqual({ o: 100n, t: 100n, b: 365n });
    for (const [k, s] of v.steps.entries()) {
      const plan = must(s.plan);
      const r = await httpPay(
        t,
        owner,
        A,
        payBody(
          p.supplierId,
          method,
          ago(4),
          [{ purchaseId: p.purchaseId, paymentAmountMinor: must(plan.paymentAmountMinor), purchaseAmountAppliedMinor: must(plan.appliedMinor) }],
          {
            currencyCode: 'USD',
          },
        ),
      );
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const allocation = must((r.body as { allocations: Record<string, unknown>[] }).allocations[0]);
      expect(allocation, `third ${k + 1}: the vector's plan`).toMatchObject({
        paymentBaseMinor: plan.paymentBaseMinor,
        apReleasedBeforeTxnMinor: plan.releasedBeforeMinor,
        carryingBaseReleasedMinor: plan.carryingReleasedMinor,
        apDustBaseMinor: plan.apDustBaseMinor,
        realizedFxMinor: plan.realizedMinor,
      });
      const entry = must(await settlementEntry(ownerPool(), A.businessId, 'supplier_payment', String(allocation.allocationId)));
      expect(concreteLines(entry.lines, acc.settlement.bank), `third ${k + 1}: the A-05(a) entry`).toEqual(
        vectorLines(must(s.entry), { currencies: { purchase: 'USD', payment: 'USD', base: 'ILS' }, branches: { purchase: A.branchX, origin: null } }),
      );
      const o = await outstandingOf(ownerPool(), A.businessId, p.purchaseId);
      expect(o.o.toString(10), `third ${k + 1}: outstanding`).toBe(s.after.outstandingTxnMinor);
    }
    expect(await settlementLedgerAp(ownerPool(), A.businessId, p.purchaseId), 'cleared exactly: AP txn 0 and AP base 0').toEqual({ base: 0n, txn: 0n });
  });
});

describe('T-07 the strong base (JOD, LBP @ 0.0000024900) through the real routines', () => {
  const LBP = { currency: 'LBP' } as const;

  async function lbpPurchase(c: Client, supplierId: string, unitPriceMinor = '100000'): Promise<string> {
    const p = await receivedPurchase(c, J, [{ variantId: J.piece.variantId, qty: '1', unitPriceMinor }], { ...LBP, supplierId });
    expect(await outstandingOf(c, J.businessId, p.purchaseId), 'P1: T = 100000 LBP, B = conv(T) = 2').toEqual({ o: 100000n, t: 100000n, b: 2n });
    return p.purchaseId;
  }

  async function lbpNote(c: Client, jMethod: string): Promise<{ supplierId: string; creditNoteId: string }> {
    const n = await sqlReturnToCredit(c, J, jMethod, { ...LBP, qty: '2', unitPriceMinor: '100000' });
    expect(await noteOf(c, J.businessId, n.creditNoteId), 'N1: 1000.00 LBP carried at 0.002 JOD').toEqual({
      original: 100000n,
      originalCarrying: 2n,
      remaining: 100000n,
      remainingCarrying: 2n,
    });
    return { supplierId: n.purchase.supplierId, creditNoteId: n.creditNoteId };
  }

  it('STRONG-BASE-MIN1: g keeps 1 while open, the final consumer releases it; the target is ABSORBED (R-69(a)) and clears to 0 / 0', async () => {
    const v = settlementVector('STRONG-BASE-MIN1');
    await rolledBack(async (c) => {
      const jMethod = await createMethod(c, J, { postingAccountId: accJ.settlement.cash });
      const { supplierId, creditNoteId } = await lbpNote(c, jMethod);
      const p1 = await lbpPurchase(c, supplierId);
      for (const [k, s] of v.steps.entries()) {
        const plan = must(s.plan);
        const call = await prepareAllocate(c, J, { creditNoteId, purchaseId: p1, consumedMinor: BigInt(String(s.step.consumedMinor)) });
        const rows = await runS6(c, J, call);
        expectAccepted(await atCommit(c), `step ${k + 1} at COMMIT`);
        const id = must(rows[0]?.allocation_id);
        const stored = must(
          (
            await c.query<Record<string, string>>(
              `SELECT credit_amount_consumed_minor::text AS "consumedMinor", credit_remaining_before_minor::text AS "remainingBeforeMinor",
                      credit_carrying_base_released_minor::text AS "creditReleasedMinor", credit_dust_base_minor::text AS "creditDustBaseMinor",
                      purchase_amount_applied_minor::text AS "appliedMinor", ap_released_before_txn_minor::text AS "releasedBeforeMinor",
                      purchase_carrying_base_released_minor::text AS "carryingReleasedMinor", ap_dust_base_minor::text AS "apDustBaseMinor",
                      realized_fx_gain_loss_minor::text AS "realizedMinor"
                 FROM supplier_credit_allocations WHERE business_id = $1 AND id = $2`,
              [J.businessId, id],
            )
          ).rows[0],
        );
        const { creditConvertedMinor: _c, apConvertedMinor: _a, ...storedPlan } = plan;
        expect(stored, `step ${k + 1}: stored = the vector's plan`).toEqual(storedPlan);
        const entry = must(await settlementEntry(c, J.businessId, 'supplier_credit_allocation', id));
        expect(concreteLines(entry.lines, null), `step ${k + 1}: the A-05(b) entry`).toEqual(
          vectorLines(must(s.entry), { currencies: { purchase: 'LBP', note: 'LBP', base: 'JOD' }, branches: { purchase: J.branchX, origin: J.branchX } }),
        );
        const n = await noteOf(c, J.businessId, creditNoteId);
        expect({ o: (await outstandingOf(c, J.businessId, p1)).o.toString(10), r: n.remaining.toString(10), g: n.remainingCarrying.toString(10) }).toEqual({
          o: s.after.outstandingTxnMinor,
          r: s.after.remainingMinor,
          g: s.after.remainingCarryingMinor,
        });
      }
      expect(await settlementLedgerAp(c, J.businessId, p1), 'AP txn and AP base both exactly 0').toEqual({ base: 0n, txn: 0n });
      expect(await receivable1150ByBranch(c, J.businessId, creditNoteId), 'INV-ACC-17').toEqual([{ branch: J.branchX, net: '0' }]);
    });
  });

  it('R-69(a) by a payment: 790.00 then 210.00 LBP — the final allocation has rel 0, AP line conv(a) = 1, dust −1, and the whole payment base is FX', async () => {
    await rolledBack(async (c) => {
      const jMethod = await createMethod(c, J, { postingAccountId: accJ.settlement.cash });
      const s = await receivedPurchase(c, J, [{ variantId: J.piece.variantId, qty: '1', unitPriceMinor: '100000' }], LBP);
      const pay = async (amount: bigint): Promise<string> => {
        const call = await preparePay(c, J, {
          supplierId: s.supplierId,
          paymentMethodId: jMethod,
          currency: 'LBP',
          allocations: [{ purchaseId: s.purchaseId, paymentAmountMinor: amount }],
        });
        const rows = await runS6(c, J, call);
        expectAccepted(await atCommit(c));
        return must(rows[0]?.allocation_id);
      };
      await pay(79000n);
      expect(await settlementLedgerAp(c, J.businessId, s.purchaseId), 'AP base already 0, a txn residue of 21000 LBP remains').toEqual({
        base: 0n,
        txn: 21000n,
      });
      const last = await pay(21000n);
      const row = must(
        (
          await c.query<{ rel: string; dust: string; pb: string; fx: string }>(
            `SELECT purchase_carrying_base_released_minor::text AS rel, ap_dust_base_minor::text AS dust, payment_base_amount_minor::text AS pb,
                    realized_fx_gain_loss_minor::text AS fx FROM supplier_payment_allocations WHERE business_id = $1 AND id = $2`,
            [J.businessId, last],
          )
        ).rows[0],
      );
      expect(row).toEqual({ rel: '0', dust: '-1', pb: '1', fx: '1' });
      const entry = must(await settlementEntry(c, J.businessId, 'supplier_payment', last));
      expect(concreteLines(entry.lines, accJ.settlement.cash)).toEqual([
        { account: 'accounts_payable', side: 'D', currency: 'LBP', txn: '21000', base: '1', branchId: J.branchX },
        { account: 'accounts_payable', side: 'C', currency: 'JOD', txn: '1', base: '1', branchId: J.branchX },
        { account: 'posting_account', side: 'C', currency: 'LBP', txn: '21000', base: '1', branchId: J.branchX },
        { account: 'fx_loss', side: 'D', currency: 'JOD', txn: '1', base: '1', branchId: J.branchX },
      ]);
      expect(await settlementLedgerAp(c, J.businessId, s.purchaseId), 'AP txn and AP base both exactly 0').toEqual({ base: 0n, txn: 0n });
      expect((await outstandingOf(c, J.businessId, s.purchaseId)).o).toBe(0n);
    });
  });

  it('BELOW-BASE-UNIT (R-69(b)): an S5-origin residue of 0.10 LBP whose base is 0 is refused amount_below_base_unit by the binder and by the routine, every way', async () => {
    await rolledBack(async (c) => {
      const jMethod = await createMethod(c, J, { postingAccountId: accJ.settlement.cash });
      const { supplierId, creditNoteId } = await lbpNote(c, jMethod);
      // 10000 × 0.10 LBP: T = 100000, B = 2. A frozen S5 partial return of 9999 leaves the only
      // residue S6 cannot prevent (M1): O = 10 LBP with a remaining AP base of 0.
      // Phase 3 corrective (0072 R-95): such a return is refused now, so the
      // residue a deployed database already holds is rebuilt with the frozen
      // S5 behaviour (the prevention trigger off for that one return).
      const origin = await receivedPurchase(c, J, [{ variantId: J.piece.variantId, qty: '10000', unitPriceMinor: '10' }], { ...LBP, supplierId });
      const p1 = origin.purchaseId;
      expect(await outstandingOf(c, J.businessId, p1)).toEqual({ o: 100000n, t: 100000n, b: 2n });
      await historicalReturnInTx(c, J, p1, [{ purchaseLineId: must(origin.lines[0]).lineId, qty: '9999' }]);
      expect(await outstandingOf(c, J.businessId, p1)).toMatchObject({ o: 10n });
      expect(await settlementLedgerAp(c, J.businessId, p1), 'a txn-only residue: base 0, txn 10').toEqual({ base: 0n, txn: 10n });

      const date = await today(c);
      const lbp = await settlementFx(c, J.businessId, 'LBP', date);
      const lbpAt = `${lbp.at.toISOString().slice(0, 19)}Z`;
      const baseAt = `${date}T00:00:00Z`;
      const bindingRefused = async (bind: () => Promise<S6Call>, code: string, what: string): Promise<void> => {
        expect(await bindingRefusal(bind), `${what}: the binder`).toBe(code);
      };
      const craft = (kind: S6Call['kind'], params: readonly unknown[]): S6Call => ({
        kind,
        params,
        postings: [],
        trace: randomUUID(),
        builtSha256: null,
        intentSha256: null,
      });
      const payCall = (currency: string, fx: readonly unknown[], amount: string, base: string, applied: string): S6Call =>
        craft('pay', [
          randomUUID(),
          supplierId,
          jMethod,
          accJ.settlement.cash,
          date,
          currency,
          amount,
          ...fx,
          base,
          null,
          [randomUUID()],
          [p1],
          [J.w1],
          ['LBP'],
          [amount],
          [base],
          [applied],
          ['99990'],
          ['0'],
          ['0'],
          [base],
        ]);

      // Step 2: 0.001 JOD applying 0.10 LBP — conv_R(10) = 0.
      await bindingRefused(
        () =>
          preparePay(c, J, {
            supplierId,
            paymentMethodId: jMethod,
            currency: 'JOD',
            allocations: [{ purchaseId: p1, paymentAmountMinor: 1n, appliedMinor: 10n }],
          }),
        'supplier_payment.amount_below_base_unit',
        'JOD 1 → 10 LBP',
      );
      refusedWith(
        await tryS6(c, J, payCall('JOD', [null, '1.0000000000', 'base', baseAt], '1', '1', '10')),
        'P0001',
        'supplier_payment.amount_below_base_unit',
        'JOD 1 → 10 LBP',
      );
      // Step 3: 0.10 LBP in LBP — the payment base is 0 as well.
      await bindingRefused(
        () => preparePay(c, J, { supplierId, paymentMethodId: jMethod, currency: 'LBP', allocations: [{ purchaseId: p1, paymentAmountMinor: 10n }] }),
        'supplier_payment.amount_below_base_unit',
        'LBP 10 → 10',
      );
      refusedWith(
        await tryS6(c, J, payCall('LBP', [lbp.rateId, lbp.rate, lbp.source, lbpAt], '10', '0', '10')),
        'P0001',
        'supplier_payment.amount_below_base_unit',
        'LBP 10 → 10',
      );
      // Step 4: a credit allocation of 0.10 LBP.
      await bindingRefused(
        () => prepareAllocate(c, J, { creditNoteId, purchaseId: p1, consumedMinor: 10n }),
        'supplier_credit_allocation.amount_below_base_unit',
        'credit 10 → 10',
      );
      refusedWith(
        await tryS6(
          c,
          J,
          craft('allocate_credit', [randomUUID(), creditNoteId, p1, J.w1, date, 'LBP', '10', '100000', '0', '0', 'LBP', '10', '99990', '0', '0', '0']),
        ),
        'P0001',
        'supplier_credit_allocation.amount_below_base_unit',
        'credit 10 → 10',
      );
      // Step 5: a refund whose consumption converts to 0.
      await bindingRefused(
        () => prepareRefund(c, J, { creditNoteId, paymentMethodId: jMethod, consumedMinor: 100n, receiptCurrency: 'JOD', receiptAmountMinor: 1n }),
        'supplier_refund.amount_below_base_unit',
        'refund 100 LBP as 0.001 JOD',
      );
      refusedWith(
        await tryS6(
          c,
          J,
          craft('receive_refund', [
            randomUUID(),
            creditNoteId,
            jMethod,
            accJ.settlement.cash,
            date,
            'LBP',
            '100',
            '100000',
            '0',
            '0',
            'JOD',
            '1',
            null,
            '1.0000000000',
            'base',
            baseAt,
            '1',
            '1',
            null,
          ]),
        ),
        'P0001',
        'supplier_refund.amount_below_base_unit',
        'refund 100 LBP as 0.001 JOD',
      );
      expect(await outstandingOf(c, J.businessId, p1), 'the residue stays open').toMatchObject({ o: 10n });
      expect(await noteOf(c, J.businessId, creditNoteId), 'the note is untouched').toMatchObject({ remaining: 100000n, remainingCarrying: 2n });
    });
  });
});

describe('T-07 the SQL arithmetic = the package vectors', () => {
  it('every primitive of every vector case', async () => {
    const vs = settlementVectors();
    expect(vs.map((v) => v.id)).toEqual(expect.arrayContaining(['GOLD-84-PARTIAL-FINAL', 'AP-THIRDS-EXACT-CLEARING', 'STRONG-BASE-MIN1', 'BELOW-BASE-UNIT']));
    let n = 0;
    for (const v of vs) {
      for (const p of await sqlPrimitives(ownerPool(), v)) {
        expect(p.actual, `${v.id}: ${p.call}`).toBe(p.expected);
        n += 1;
      }
    }
    expect(n, 'the vectors carry primitives').toBeGreaterThan(50);
  });
});
