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
import { Client } from 'pg';
import { dbUrl, mintTestInventoryAssertion } from '../helpers/test-app';
import { assertionFor as accountingAssertionFor, postAs, type PostCommand, type PostLine } from '../helpers/accounting-posting';

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
  await ownerPool()
    .query('SELECT 1')
    .catch(() => undefined);
});

describe('C3 §1 — the slice is not written yet, and this says which half is missing', () => {
  it('names the relation and the command that `0094` owes', async () => {
    const rel = await ownerPool().query<{ n: string }>(`SELECT to_regclass('public.' || $1)::text AS n`, [REVERSAL_RELATION]);
    const fn = await ownerPool().query<{ c: string }>(`SELECT count(*)::text AS c FROM pg_proc WHERE proname = $1`, [REVERSAL_COMMAND]);
    expect(
      must(rel.rows[0], 'the catalogue answered nothing, which is a probe failure and not a measurement').n,
      `${REVERSAL_RELATION} is the reducer relation 0094 must create`,
    ).not.toBeNull();
    expect(must(fn.rows[0], 'the catalogue answered nothing').c, `${REVERSAL_COMMAND} is the command 0094 must create`).not.toBe('0');

    // AND ITS SIGNATURE FROM THE CATALOGUE, NOT FROM THE MIGRATION'S TEXT.
    // The file says what was written; the catalogue says what was APPLIED,
    // and those can differ -- a cluster belongs to the exact text of the
    // migrations it applied, so a stale cluster or an edited migration makes
    // the two disagree. An earlier draft of the case below called a GUESSED
    // shape and would have failed for the wrong reason, which is why the
    // shape is now read rather than assumed.
    // `pg_get_function_identity_arguments` prints the parameter NAMES
    // beside the types (`p_reversal_id uuid, ...`) -- measured, after this
    // assertion first expected bare types and failed on its own
    // expectation rather than on the function. What a caller has to match
    // is the TYPE VECTOR, so that is what is read.
    const sig = await ownerPool().query<{ types: string }>(`SELECT pg_catalog.oidvectortypes(p.proargtypes) AS types FROM pg_proc p WHERE p.proname = $1`, [
      REVERSAL_COMMAND,
    ]);
    expect(sig.rows.length, 'exactly one overload of this command must exist, or the call below is ambiguous').toBe(1);
    expect(must(sig.rows[0], 'the signature').types.replace(/[ ]+/g, ' '), 'the applied argument types are the ones this file calls').toBe(
      'uuid, uuid, date, text',
    );
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

    // ── A SECOND INVOICE THAT IS NEVER REVERSED, and it is the witness that
    // makes this case say anything. "The debt comes back" is satisfied by a
    // figure that never moved as surely as by a correct restoration, so a
    // settled invoice with no reversal of its own must still read ZERO after
    // the reversal below. Without it, a reversal that restored EVERY
    // customer's debt -- or none at all -- would pass.
    const bystanderCustomer = await newCustomer(w);
    const bystander = await sellOnCredit(w, bystanderCustomer, '4');
    const bystanderPay = await collectPayment(w.t, w.headers, {
      paymentId: randomUUID(),
      customerId: bystanderCustomer,
      paymentMethodId: w.paymentMethodId,
      paymentDate: w.day,
      amountMinor: bystander.totalTxnMinor,
      allocations: [
        {
          invoiceId: bystander.invoiceId,
          appliedMinor: bystander.totalTxnMinor,
          releasedBeforeMinor: '0',
          invoiceTotalTxnMinor: bystander.totalTxnMinor,
          invoiceTotalBaseMinor: bystander.totalBaseMinor,
        },
      ],
    });
    expect(bystanderPay.status, `the bystander invoice is settled in full: ${JSON.stringify(bystanderPay.body)}`).toBeLessThan(300);
    const bystanderBefore = await derivedRead(ownerPool(), w.shop.businessId, bystander.invoiceId);
    expect(BigInt(bystanderBefore.outstandingTxnMinor), 'the bystander owes nothing before the reversal').toBe(0n);

    // ── THE COMMAND, as the catalogue reports it and the authority path
    // demands. Its arguments are (reversal id, ALLOCATION id, date, reason),
    // so the allocation is looked up rather than the payment passed in its
    // place; and the first statement of its body consumes a signed assertion
    // (`0094:320-322`), so the digest is asked of the DATABASE with the very
    // function the command will use. Recomputing that digest here would be a
    // second copy of the arithmetic, and it would also be wrong the first
    // time the grammar changed.
    //
    // THE CALLER POSTS, as `0081:1765` says it must: the command writes the
    // reversal row and nothing else, and the row's deferred binding FK is
    // satisfied only if its accounting entry commits with it. That is the
    // same lesson `l3-c3-allocation-reversals-rls.test.ts` learned from four
    // refusals, and it applies to the real command exactly as it applied to
    // an owner-written fixture.
    const middle = must(paymentIds[1], 'the middle leg');
    const allocation = await ownerPool().query<{ id: string }>(
      `SELECT a.id::text AS id FROM payment_allocations a WHERE a.business_id = $1 AND a.payment_id = $2`,
      [w.shop.businessId, middle],
    );
    const allocationId = must(allocation.rows[0], 'the allocation of the middle leg').id;
    const reversalId = randomUUID();
    const reason = 'the merchant allocated this to the wrong invoice';
    // NOT the CLAIMED digest, which cannot answer here, and the reason is
    // in its own body: it reads the tenant and the business out of
    // app.inventory_assertion (0054:300) and returns NULL when that carrier
    // is absent. Asking it before the assertion exists is circular -- the
    // digest would need the carrier the digest is minted into -- and
    // measured, it returned NULL and the minter refused with
    // 'requires a lowercase hex sha-256 payload digest'.
    //
    // The right instrument is the function it delegates to,
    // inventory_payload_digest (0054:214), which takes the tenant and the
    // business explicitly. It is still the DATABASE computing the digest
    // with the same code the command will run: a digest recomputed in
    // TypeScript would be a second copy of the payload grammar, and wrong
    // the first time that grammar moved.
    const digest = await ownerPool().query<{ d: string }>(
      `SELECT inventory_payload_digest($1, $2::uuid, $3::uuid,
                ARRAY['uuid', 'uuid', 'integer'] || array_fill('integer'::text, ARRAY[8]),
                ARRAY[$4::text, $5::text, to_char($6::date, 'YYYYMMDD')] || inventory_reason_words($7)) AS d`,
      ['customer.reverse_allocation', w.shop.tenantId, w.shop.businessId, reversalId, allocationId, w.day, reason],
    );
    const payloadSha256 = must(digest.rows[0], 'the payload digest the command will recompute').d;
    const assertion = mintTestInventoryAssertion({
      actorUserId: w.shop.userId,
      tenantId: w.shop.tenantId,
      businessId: w.shop.businessId,
      opCode: 'customer.reverse_allocation',
      payloadSha256,
    });

    const conn = new Client({ connectionString: dbUrl });
    await conn.connect();
    try {
      await conn.query('BEGIN');
      await conn.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true),
                set_config('app.inventory_assertion', $3, true), set_config('app.business_transaction_id', $4, true)`,
        [w.shop.tenantId, w.shop.businessId, assertion, randomUUID()],
      );
      await conn.query('SET LOCAL ROLE daftar_app');
      await conn.query(`SELECT * FROM ${REVERSAL_COMMAND}($1::uuid, $2::uuid, $3::date, $4::text)`, [reversalId, allocationId, w.day, reason]);
      await conn.query('RESET ROLE');

      const stored = await conn.query<{ cur: string; applied: string; base: string; rate: string; baseCur: string }>(
        `SELECT r.invoice_currency AS cur, r.invoice_amount_applied_minor::text AS applied,
                r.invoice_carrying_base_released_minor::text AS base,
                r.invoice_historical_to_base_rate::text AS rate, b.base_currency AS "baseCur"
           FROM allocation_reversals r JOIN businesses b ON b.id = r.business_id
          WHERE r.business_id = $1 AND r.id = $2::uuid`,
        [w.shop.businessId, reversalId],
      );
      const f = must(stored.rows[0], 'the reversal row the command wrote');
      const at = new Date(`${w.day}T00:00:00Z`);
      const line = (systemKey: string, side: 'D' | 'C'): PostLine => ({
        account: { kind: 'system' as const, systemKey },
        side,
        baseAmountMinor: BigInt(f.base),
        baseCurrency: f.baseCur,
        txnAmountMinor: BigInt(f.applied),
        txnCurrency: f.cur,
        fxRate: f.rate,
        fxRateSource: f.cur === f.baseCur ? ('base' as const) : ('manual' as const),
        fxRateAt: at,
      });
      const entry: PostCommand = {
        tenantId: w.shop.tenantId,
        businessId: w.shop.businessId,
        sourceType: 'allocation_reversal',
        sourceId: reversalId,
        entryDate: w.day,
        lines: [line('accounts_receivable', 'D'), line('customer_credit_liability', 'C')],
      };
      await postAs(accountingAssertionFor(entry, w.shop.userId), entry, {}, conn);
      await conn.query('COMMIT');
    } catch (e) {
      await conn.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      await conn.end().catch(() => undefined);
    }

    const after = await derivedRead(ownerPool(), w.shop.businessId, invoice.invoiceId);
    expect(BigInt(after.outstandingTxnMinor), 'the reversed leg comes back as debt, to the minor unit, and nothing else moves').toBe(
      must(legs[1], 'the middle leg amount'),
    );

    // AND THE ALLOCATION ROW IS STILL THERE. The payment is sealed against
    // change (`0081:939`), so a reversal is a new event and never a deletion;
    // a reversal that removed the row would make this file green while
    // breaking that seal.
    const rows = await ownerPool().query<{ c: string }>(`SELECT count(*)::text AS c FROM payment_allocations WHERE business_id = $1 AND payment_id = $2`, [
      w.shop.businessId,
      middle,
    ]);
    expect(must(rows.rows[0], 'the allocation count').c, 'the reversed allocation row is still on the ledger').toBe('1');

    // THE WITNESS, READ AFTER. The bystander invoice had no reversal, so its
    // debt must NOT have come back. This is what separates "the reversal
    // restored this invoice" from "something restored every invoice" and from
    // "nothing moved at all".
    const bystanderAfter = await derivedRead(ownerPool(), w.shop.businessId, bystander.invoiceId);
    expect(
      BigInt(bystanderAfter.outstandingTxnMinor),
      'an invoice with no reversal of its own must still owe nothing, or the restoration above is not attributable to the reversal',
    ).toBe(0n);
  }, 900_000);
});
