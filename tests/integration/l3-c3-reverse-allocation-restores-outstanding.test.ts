/**
 * C3 — REVERSING AN ALLOCATION MUST PUT THE DEBT BACK, TO THE MINOR UNIT.
 *
 * RED FIRST, and red for a NAMED reason: neither the command nor the reducer
 * relation exists yet. `0094` is not written, and §1 says so by measuring the
 * catalogue rather than by failing somewhere vague.
 *
 * WHY THIS FILE EXISTS AT ALL. The second money review named one danger above
 * every other in this design, and no text can settle it: `invoice_outstanding`
 * computes what an invoice still owes through the CUMULATIVE identity
 * `Σ rel = HALF_EVEN(B·Σa, T)` (`0084:576-580`), where each leg's release is
 * `apRelease(B, T, X, a) = HALF_EVEN(B·(X+a), T) − HALF_EVEN(B·X, T)`
 * (`packages/inventory/src/supplier-settlement.ts:89`). A reversal that
 * subtracts the leg's ALREADY-ROUNDED release, instead of removing the leg
 * from the set the identity is computed over, drifts by a minor unit — and a
 * minor unit of a customer's debt that belongs to nobody is exactly the fault
 * MVP-03 was written against. `P4-AL-25` states the rule it would break: a
 * rounded quotient is never an input.
 *
 * THE DECLARED LIMIT OF THIS FILE, stated rather than left for a reader to
 * discover. In a world where the invoice and the base are the same currency,
 * `B = T`, so `apRelease` collapses to the applied amount and the identity
 * CANNOT bite: this file would stay green against a reversal that subtracts a
 * rounded number. The case that bites needs an invoice denominated away from
 * the base, which `sellOnCredit` does not offer today. So the arm below is the
 * one that catches double-counting and sign errors, and the cross-currency arm
 * is `NOT_RUN` and OWED — it is named here so a green run is not read as a
 * proof it never gave.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { settlementWorld, settlementMissing, stockUp, newCustomer, sellOnCredit, type SettlementWorld } from '../golden-regression/phase4-s4/settlement-world';
import { derivedRead, must } from '../golden-regression/phase4-s4/harness';
import { collectPayment, type AllocationInput } from '../golden-regression/phase4-s4/settlement-path';
import { randomUUID } from 'node:crypto';

/** The names `0094` will carry. Both are in the estate's own reducer vocabulary (`scripts/phase4-s1-gate.ts:1634`). */
const REVERSAL_RELATION = 'allocation_reversals';
const REVERSAL_COMMAND = 'customer_reverse_allocation';

let w: SettlementWorld;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  w = await settlementWorld('l3 c3 reverse allocation');
  const missing = await settlementMissing(w);
  expect(missing, `the settlement subject must be complete on this head: ${missing.join(', ')}`).toEqual([]);
}, 900_000);

afterAll(async () => {
  await ownerPool().query('SELECT 1').catch(() => undefined);
});

describe('C3 §1 — the slice is not written yet, and this says which half is missing', () => {
  it('names the relation and the command that `0094` owes', async () => {
    const rel = await ownerPool().query<{ n: string }>(`SELECT to_regclass('public.' || $1)::text AS n`, [REVERSAL_RELATION]);
    const fn = await ownerPool().query<{ c: string }>(`SELECT count(*)::text AS c FROM pg_proc WHERE proname = $1`, [REVERSAL_COMMAND]);
    expect(must(rel.rows[0], 'the catalogue answered nothing, which is a probe failure and not a measurement').n, `${REVERSAL_RELATION} is the reducer relation 0094 must create`).not.toBeNull();
    expect(must(fn.rows[0], 'the catalogue answered nothing').c, `${REVERSAL_COMMAND} is the command 0094 must create`).not.toBe('0');
  }, 120_000);
});

describe('C3 §2 — the debt comes back exactly, and the remaining legs keep the cumulative identity', () => {
  /**
   * Three partial allocations, then the MIDDLE one is reversed. The invoice
   * must then owe exactly what the two surviving legs leave it owing — and
   * `derivedRead` is the estate's own reader, so the figure is the one a
   * merchant would see rather than one this file recomputes.
   */
  it('reverses the middle leg of three and leaves the invoice owing exactly the rest', async () => {
    await stockUp(w, '1000', '1000');
    const customer = await newCustomer(w);
    const invoice = await sellOnCredit(w, customer, '9');
    const total = BigInt(invoice.totalTxnMinor);
    const third = total / 3n;
    expect(third > 0n, 'NO SUBJECT — a third of this invoice is zero, so there are no three legs to make').toBe(true);
    const legs = [third, third, total - third - third];

    const paymentIds: string[] = [];
    let releasedBefore = 0n;
    for (const amount of legs) {
      const paymentId = randomUUID();
      const leg: AllocationInput = {
        invoiceId: invoice.invoiceId,
        appliedMinor: amount.toString(),
        releasedBeforeMinor: releasedBefore.toString(),
        invoiceTotalTxnMinor: invoice.totalTxnMinor,
        invoiceTotalBaseMinor: invoice.totalBaseMinor,
      };
      const res = await collectPayment(w.t, w.headers, {
        paymentId,
        customerId: customer,
        paymentMethodId: w.paymentMethodId,
        paymentDate: w.day,
        amountMinor: amount.toString(),
        allocations: [leg],
      });
      expect(res.status, `the leg of ${amount} is accepted: ${JSON.stringify(res.body)}`).toBeLessThan(300);
      paymentIds.push(paymentId);
      releasedBefore += amount;
    }

    const settled = await derivedRead(ownerPool(), w.shop.businessId, invoice.invoiceId);
    expect(BigInt(settled.outstandingTxnMinor), 'the three legs settle the invoice in full before anything is reversed').toBe(0n);

    // The command 0094 owes. Until it exists this throws, and §1 above has
    // already said which half is missing, so this failure is not a mystery.
    const middle = must(paymentIds[1], 'the middle leg');
    await ownerPool().query(`SELECT ${REVERSAL_COMMAND}($1::uuid, $2::uuid, $3::text)`, [w.shop.businessId, middle, 'the merchant allocated this to the wrong invoice']);

    const after = await derivedRead(ownerPool(), w.shop.businessId, invoice.invoiceId);
    expect(BigInt(after.outstandingTxnMinor), 'the reversed leg comes back as debt, to the minor unit, and nothing else moves').toBe(must(legs[1], 'the middle leg amount'));

    // AND THE ALLOCATION ROW IS STILL THERE. The payment is sealed against
    // change (`0081:939`), so a reversal is a new event and never a deletion;
    // a reversal that removed the row would make this file green while
    // breaking that seal.
    const rows = await ownerPool().query<{ c: string }>(
      `SELECT count(*)::text AS c FROM payment_allocations WHERE business_id = $1 AND payment_id = $2`,
      [w.shop.businessId, middle],
    );
    expect(must(rows.rows[0], 'the allocation count').c, 'the reversed allocation row is still on the ledger').toBe('1');
  }, 900_000);
});
