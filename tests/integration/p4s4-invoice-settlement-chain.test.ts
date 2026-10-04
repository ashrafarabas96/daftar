/**
 * P4-S4 — THE OLDEST-FIRST CHAIN OVER ONE INVOICE, AND THE LAST CONSUMPTION.
 * (P4-S4 BUILD CONTRACT OQ-1 and OQ-3; implementation map §1.1, §8.2, §8.4,
 *  §9 G-14/G-15; `docs/PHASE_4_ARCHITECTURE_LOCK.md` P4-AL-25.)
 *
 * ── THE CHAIN ─────────────────────────────────────────────────────────────
 *
 * Every row that settles an invoice records the chain position it was computed
 * from — `ar_released_before_txn_minor`, which is `X` — and the one amount it
 * applies, `invoice_amount_applied_minor`, which is `a`. The chain of an
 * invoice is the union of `payment_allocations` and
 * `customer_credit_applications` over it, ordered by `X`, and the law is a
 * recurrence rather than a count:
 *
 *     X₀ = 0        and        Xᵢ₊₁ = Xᵢ + aᵢ
 *
 * A position ABOVE the recurrence is a GAP — an amount of the invoice nothing
 * accounted for. A position BELOW it is an OVERLAP — the same amount released
 * twice. Both are the same defect from either side, and the `UNIQUE
 * (business_id, invoice_id, ar_released_before_txn_minor)` of contract OQ-1
 * makes the exact-repeat case a database refusal rather than a discovered
 * inconsistency.
 *
 * ── THE LAST CONSUMPTION RELEASES THE WHOLE RESIDUE ───────────────────────
 *
 * `rel(B, T, X, a) = HALF_EVEN(B·(X+a), T) − HALF_EVEN(B·X, T)` is a
 * DIFFERENCE OF CUMULATIVE roundings of the invoice's stored originals, never
 * a function of a previous step's already-rounded release
 * (`[[daftar-a-rounded-quotient-is-never-an-input]]`, P4-AL-25). That is what
 * makes `Σ rel` over a chain that consumes the whole of `T` equal `B` EXACTLY
 * — a naive per-step `conv(aᵢ)` would strand a minor unit — and the suite
 * includes a case where it would.
 *
 * The same property on the credit side is the `max(1, …)` floor in
 * `g(OA, OB, r)` (`packages/inventory/src/supplier-settlement.ts:7-10, 31-35`):
 * a credit consumed down to zero has `remaining_carrying = g(0) = 0` exactly,
 * so no carrying value is stranded on a credit nobody can consume again.
 *
 * ── RED UNTIL `0081` LANDS ────────────────────────────────────────────────
 *
 * Every `it` requires its subject first. No `.skip`, no `.todo`, no
 * conditional pass; and every count carries a `business_id` predicate.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { ownerClient } from '../helpers/stock-ledger';
import { requireSubject } from '../golden-regression/phase4-s2/harness';
import {
  chainBreaks,
  chainTotals,
  cloneRow,
  derivedRead,
  inRolledBackTx,
  invoiceChain,
  must,
  raised,
  type ChainStep,
} from '../golden-regression/phase4-s4/harness';
import { applyCredit, collectPayment, CHAIN, type AllocationInput } from '../golden-regression/phase4-s4/settlement-path';
import {
  newCustomer,
  sellOnCredit,
  settlementMissing,
  settlementWorld,
  stockUp,
  type OpenInvoice,
  type SettlementWorld,
} from '../golden-regression/phase4-s4/settlement-world';

const CLAIM = 'the oldest-first chain over an invoice has no gap and no overlap, and the final consumption releases the whole residue';

let w: SettlementWorld;
let missing: readonly string[] = [];

/** The invoice settled in three partial steps that close it exactly. */
let target: OpenInvoice;
let steps: readonly Response[] = [];
/** An allocation for MORE of the invoice than is left: must be refused by the cap under the lock. */
let overAllocation: Response | undefined;
/** The credit consumed to exactly zero across two applications. */
let credit: { readonly creditId: string; readonly originalMinor: bigint; readonly originalCarryingMinor: bigint } | undefined;
let creditApplications: readonly Response[] = [];

function leg(inv: OpenInvoice, appliedMinor: bigint, releasedBefore: bigint): AllocationInput {
  return {
    invoiceId: inv.invoiceId,
    appliedMinor: appliedMinor.toString(),
    releasedBeforeMinor: releasedBefore.toString(),
    invoiceTotalTxnMinor: inv.totalTxnMinor,
    invoiceTotalBaseMinor: inv.totalBaseMinor,
  };
}

/** One partial collection against `target`, from the stated chain position. */
async function pay(customerId: string, appliedMinor: bigint, releasedBefore: bigint): Promise<Response> {
  const allocations = [leg(target, appliedMinor, releasedBefore)];
  return collectPayment(w.t, w.headers, {
    paymentId: randomUUID(),
    customerId,
    paymentMethodId: w.paymentMethodId,
    paymentDate: w.day,
    amountMinor: appliedMinor.toString(),
    allocations,
  });
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  w = await settlementWorld('s4chain');
  missing = await settlementMissing(w);
  if (missing.length > 0) return;

  await stockUp(w, '100', '7');
  const customer = await newCustomer(w);
  // Three units at a cost that gives a total not divisible by three, so the
  // three partial steps below cannot all be equal and the last one carries
  // whatever the first two left. A chain whose steps divide evenly would never
  // exercise the cumulative-release property at all.
  target = await sellOnCredit(w, customer, '3');
  const total = BigInt(target.totalTxnMinor);
  const first = total / 3n;
  const second = total / 3n;
  const last = total - first - second;
  expect(last > 0n, 'the last step carries a positive residue, or the chain closes before it').toBe(true);

  const s1 = await pay(customer, first, 0n);
  const s2 = await pay(customer, second, first);
  // THE CAP, attempted BEFORE the chain is closed so that a refusal cannot be
  // mistaken for "nothing left to settle": one minor unit MORE than the
  // invoice has left. The client states no chain position — the request
  // carries no derived figure — so "two settlements from one chain position"
  // is not something a caller can even ask for through this boundary any more.
  // What a caller CAN ask for is more of the invoice than remains, and the
  // command must recompute the outstanding under the invoice's row lock and
  // refuse it rather than silently adjust the amount (`0068:741-745, 761-765`).
  //
  // The database-level half of the law — that two rows computed from the same
  // chain position cannot both exist — is proved by direct SQL further down,
  // which is the only way to reach it now that the command will not carry a
  // position at all.
  overAllocation = await pay(customer, last + 1n, first + second);
  const s3 = await pay(customer, last, first + second);
  steps = [s1, s2, s3];

  // ── the credit side: born from a surplus, consumed to exactly zero ────
  const creditCustomer = await newCustomer(w);
  const ci1 = await sellOnCredit(w, creditCustomer, '2');
  const ci2 = await sellOnCredit(w, creditCustomer, '1');
  const surplus = BigInt(ci2.totalTxnMinor);
  const creditId = randomUUID();
  const born = await collectPayment(w.t, w.headers, {
    paymentId: randomUUID(),
    customerId: creditCustomer,
    paymentMethodId: w.paymentMethodId,
    paymentDate: w.day,
    amountMinor: (BigInt(ci1.totalTxnMinor) + surplus).toString(),
    creditId,
    allocations: [leg(ci1, BigInt(ci1.totalTxnMinor), 0n)],
  });
  expect(born.status, `the credit-bearing overpayment commits: ${JSON.stringify(born.body)}`).toBeLessThan(300);
  const cr = must(
    (
      await ownerPool().query<{ oa: string; ob: string }>(
        `SELECT original_amount_minor::text AS oa, original_carrying_base_amount_minor::text AS ob
           FROM customer_credits WHERE business_id = $1 AND id = $2`,
        [w.shop.businessId, creditId],
      )
    ).rows[0],
    `the credit ${creditId}`,
  );
  credit = { creditId, originalMinor: BigInt(cr.oa), originalCarryingMinor: BigInt(cr.ob) };
  // Two applications that consume the credit to EXACTLY zero: a part, then the
  // rest. The second is the "final consumption" the residue law is about.
  const half = credit.originalMinor / 2n;
  const rest = credit.originalMinor - half;
  const a1 = await applyCredit(w.t, w.headers, {
    applicationId: randomUUID(),
    creditId,
    customerId: creditCustomer,
    invoiceId: ci2.invoiceId,
    applicationDate: w.day,
    consumedMinor: half.toString(),
    remainingBeforeMinor: credit.originalMinor.toString(),
    creditOriginalMinor: credit.originalMinor.toString(),
    creditOriginalCarryingMinor: credit.originalCarryingMinor.toString(),
    leg: leg(ci2, half, 0n),
  });
  const a2 = await applyCredit(w.t, w.headers, {
    applicationId: randomUUID(),
    creditId,
    customerId: creditCustomer,
    invoiceId: ci2.invoiceId,
    applicationDate: w.day,
    consumedMinor: rest.toString(),
    remainingBeforeMinor: rest.toString(),
    creditOriginalMinor: credit.originalMinor.toString(),
    creditOriginalCarryingMinor: credit.originalCarryingMinor.toString(),
    leg: leg(ci2, rest, half),
  });
  creditApplications = [a1, a2];
}, 420_000);

afterAll(async () => {
  await w?.t?.close();
  await resetData();
});

describe('P4-S4 the oldest-first chain over an invoice', () => {
  it('the subject exists: the settlement relations, their chain columns, the commands, the verifiers and the routes', () => {
    requireSubject(missing, CLAIM);
  });

  it('the three partial settlements are each accepted', () => {
    requireSubject(missing, CLAIM);
    steps.forEach((res, i) => {
      expect(res.status, `partial settlement ${i + 1} of 3 commits: ${JSON.stringify(res.body)}`).toBeLessThan(300);
    });
  });

  it('the chain starts at zero and has NO GAP and NO OVERLAP', async () => {
    requireSubject(missing, CLAIM);
    const chain = await invoiceChain(ownerPool(), w.shop.businessId, target.invoiceId);
    expect(
      chain.length,
      `NO SUBJECT — the invoice ${target.invoiceId} of this business has no settlement row, so the recurrence is asserted over nothing`,
    ).toBeGreaterThan(1);
    const breaks = chainBreaks(chain);
    expect(
      breaks,
      `the chain of invoice ${target.invoiceId} must satisfy X₀ = 0 and Xᵢ₊₁ = Xᵢ + aᵢ. A position above it is a GAP — an amount of the ` +
        `invoice nothing accounted for; below it is an OVERLAP — the same amount released twice. Measured chain: ` +
        `${JSON.stringify(chain.map((s) => ({ rel: s.relation, X: s.positionMinor.toString(), a: s.appliedMinor.toString() })))}`,
    ).toEqual([]);
  });

  it('and the chain’s arrival order agrees with its position order, without the clock being the authority', async () => {
    requireSubject(missing, CLAIM);
    const chain = await invoiceChain(ownerPool(), w.shop.businessId, target.invoiceId);
    expect(chain.length, 'NO SUBJECT — nothing on the chain to order').toBeGreaterThan(1);
    // `created_at` is read, compared NON-strictly, and never used to order the
    // chain: two rows written in one transaction share a timestamp to the
    // microsecond, so a strict inequality here would be reporting the host's
    // clock resolution rather than a law (`[[daftar-a-test-whose-verdict-is-the-machines-speed]]`).
    const times = chain.map((s) => s.createdAt);
    const sorted = [...times].sort();
    expect(times, `a later chain position was never written before an earlier one. Measured: ${JSON.stringify(times)}`).toEqual(sorted);
  });

  it('the final consumption closes the invoice EXACTLY: Σ a = total and Σ rel = the invoice’s whole base total', async () => {
    requireSubject(missing, CLAIM);
    const chain = await invoiceChain(ownerPool(), w.shop.businessId, target.invoiceId);
    const totals = chainTotals(chain);
    expect(chain.length, 'NO SUBJECT — nothing on the chain to total').toBeGreaterThan(1);
    expect(
      totals.applied.toString(),
      `the chain applied ${totals.applied} of an invoice totalling ${target.totalTxnMinor}: the three steps must consume it exactly`,
    ).toBe(target.totalTxnMinor);
    expect(
      totals.released.toString(),
      `Σ rel over the chain must be the invoice's WHOLE base total ${target.totalBaseMinor}, measured ${totals.released}. This is the ` +
        `cumulative-release property: rel is a difference of two cumulative roundings of the stored (B, T), so the last step releases ` +
        `whatever the earlier ones left. A per-step conv(aᵢ) would strand ` +
        `${(BigInt(target.totalBaseMinor) - totals.released).toString()} base minor units on an invoice nobody can settle again ` +
        `(P4-AL-25, R-77/R-78).`,
    ).toBe(target.totalBaseMinor);
  });

  it('and the reader of record agrees: nothing outstanding, nothing stranded, the state is `paid`', async () => {
    requireSubject(missing, CLAIM);
    const read = await derivedRead(ownerPool(), w.shop.businessId, target.invoiceId);
    expect(
      {
        paid_txn: read.paidTxnMinor.toString(),
        paid_base: read.paidBaseMinor.toString(),
        outstanding_txn: read.outstandingTxnMinor.toString(),
        outstanding_base: read.outstandingBaseMinor.toString(),
        state: read.state,
      },
      `after the final consumption the invoice ${target.invoiceId} owes nothing in EITHER currency: a residual base minor unit is value ` +
        `stranded on a document no further settlement can reach, which is exactly what R-77/R-78 forbid`,
    ).toEqual({
      paid_txn: target.totalTxnMinor,
      paid_base: target.totalBaseMinor,
      outstanding_txn: '0',
      outstanding_base: '0',
      state: 'paid',
    });
  });

  // ── two settlements from one chain position ───────────────────────────

  it('an allocation for MORE of the invoice than remains is REFUSED under the lock, and writes nothing', async () => {
    requireSubject(missing, CLAIM);
    const res = must(overAllocation, 'the over-allocation attempt');
    expect(
      res.status,
      `one minor unit more than the invoice had left must be refused. The outstanding is re-read AFTER the invoice row is locked and ` +
        `compared with what the caller asked for; a caller who asks for more than remains is refused, never silently given less ` +
        `(0068:741-745, 761-765). Measured: ${res.status} ${JSON.stringify(res.body)}`,
    ).toBeGreaterThanOrEqual(400);
    expect(res.status, 'and it is a business refusal, not a crash: asking for too much is an outcome, not a defect').toBeLessThan(500);
    // And it left nothing behind. Counted with the business predicate and
    // against the chain, which is the only place a half-written settlement
    // could hide.
    const chain = await invoiceChain(ownerPool(), w.shop.businessId, target.invoiceId);
    const totals = chainTotals(chain);
    expect(
      totals.applied.toString(),
      `the chain of invoice ${target.invoiceId} applied ${totals.applied} of a ${target.totalTxnMinor} invoice — the refused attempt added ` +
        `nothing, and no step of the chain applied more than the invoice has`,
    ).toBe(target.totalTxnMinor);
    expect(chain.filter((s) => s.positionMinor === 0n).length, 'exactly one row of this business’s chain was ever computed from position 0').toBe(1);
  });

  it('that law can say no: a planted second row at the same chain position is refused BY THE DATABASE', async () => {
    requireSubject(missing, CLAIM);
    // THE PLANTED RED PROOF for contract OQ-1's level uniqueness, by DIRECT
    // SQL rather than through the command: the command's own recomputation is
    // one mechanism and the UNIQUE is a second, independent one, and a proof
    // that went through the command would only ever exercise the first.
    //
    // The row is CLONED from an accepted row of the same relation with exactly
    // one override — a second `id` — so it departs from a lawful row only in
    // the way the law is about. Everything runs in a transaction that is
    // ALWAYS rolled back.
    const chain = await invoiceChain(ownerPool(), w.shop.businessId, target.invoiceId);
    const source = must(
      chain.find((s) => s.relation === 'payment_allocations'),
      'a lawful payment allocation of this chain to clone',
    );
    const outcome = await inRolledBackTx(
      () => ownerClient(),
      w.shop,
      async (c) => {
        const newId = randomUUID();
        return raised(() =>
          cloneRow(c, 'payment_allocations', w.shop.businessId, source.id, {
            id: newId,
            binding_source_id: newId,
          }),
        );
      },
    );
    expect(
      outcome,
      `a second allocation of invoice ${target.invoiceId} computed from chain position ${source.positionMinor} must be impossible. It was ` +
        `accepted, which means two settlements can be computed from one chain position and the same amount of the invoice released twice ` +
        `(contract OQ-1).`,
    ).not.toBeNull();
    const err = must(outcome, 'the refusal');
    expect(
      err.code,
      `and the refusal is the DATABASE's unique violation (23505) on (business_id, invoice_id, ${CHAIN.position}), not an application check: ` +
        `${err.code} ${err.message}`,
    ).toBe('23505');
  });

  it('and the chain law itself can say no: a gap and an overlap are each named on synthetic chains', () => {
    // The red proof for `chainBreaks`, on synthetic steps. A function that has
    // only ever been handed a lawful chain is a function nobody has watched
    // refuse anything. No subject is required: this is about the law, not
    // about the estate.
    const ok: Pick<ChainStep, 'positionMinor' | 'appliedMinor'>[] = [
      { positionMinor: 0n, appliedMinor: 300n },
      { positionMinor: 300n, appliedMinor: 200n },
      { positionMinor: 500n, appliedMinor: 100n },
    ];
    expect(chainBreaks(ok), 'a chain with no gap and no overlap').toEqual([]);
    expect(chainBreaks([]), 'an empty chain breaks nothing — non-vacuity is the caller’s job, not this function’s').toEqual([]);
    expect(chainBreaks([{ positionMinor: 50n, appliedMinor: 100n }]), 'a chain that does not start at zero is a gap at index 0').toEqual([
      { index: 0, expectedPosition: '0', actualPosition: '50', kind: 'gap' },
    ]);
    expect(
      chainBreaks([
        { positionMinor: 0n, appliedMinor: 300n },
        { positionMinor: 400n, appliedMinor: 100n },
      ]),
      'a position above the recurrence is a GAP of 100 nothing accounted for',
    ).toEqual([{ index: 1, expectedPosition: '300', actualPosition: '400', kind: 'gap' }]);
    expect(
      chainBreaks([
        { positionMinor: 0n, appliedMinor: 300n },
        { positionMinor: 200n, appliedMinor: 100n },
      ]),
      'a position below it is an OVERLAP: 100 of the invoice released twice',
    ).toEqual([{ index: 1, expectedPosition: '300', actualPosition: '200', kind: 'overlap' }]);
    expect(
      chainBreaks([
        { positionMinor: 0n, appliedMinor: 300n },
        { positionMinor: 0n, appliedMinor: 300n },
      ]),
      'two steps from the same position is the overlap the level UNIQUE makes unrepresentable',
    ).toEqual([{ index: 1, expectedPosition: '300', actualPosition: '0', kind: 'overlap' }]);
  });

  // ── the credit side: the last consumption strands nothing ─────────────

  it('a credit consumed in two applications is accepted both times', () => {
    requireSubject(missing, CLAIM);
    expect(creditApplications.length, 'NO SUBJECT — no credit application was attempted').toBe(2);
    creditApplications.forEach((res, i) => {
      expect(res.status, `credit application ${i + 1} of 2 commits: ${JSON.stringify(res.body)}`).toBeLessThan(300);
    });
  });

  it('the FINAL consumption zeroes the credit’s remaining pair EXACTLY, stranding no carrying value', async () => {
    requireSubject(missing, CLAIM);
    const c = must(credit, 'the credit');
    const r = must(
      (
        await ownerPool().query<{ remaining: string; remaining_carrying: string; consumed: string; released: string; apps: number }>(
          `SELECT cc.remaining_amount_minor::text AS remaining,
                  cc.remaining_carrying_base_amount_minor::text AS remaining_carrying,
                  (SELECT coalesce(sum(x.credit_amount_consumed_minor), 0)::text FROM customer_credit_applications x
                    WHERE x.business_id = cc.business_id AND x.credit_id = cc.id)                       AS consumed,
                  (SELECT coalesce(sum(x.credit_carrying_base_released_minor), 0)::text FROM customer_credit_applications x
                    WHERE x.business_id = cc.business_id AND x.credit_id = cc.id)                       AS released,
                  (SELECT count(*)::int FROM customer_credit_applications x
                    WHERE x.business_id = cc.business_id AND x.credit_id = cc.id)                       AS apps
             FROM customer_credits cc WHERE cc.business_id = $1 AND cc.id = $2`,
          [w.shop.businessId, c.creditId],
        )
      ).rows[0],
      `the credit ${c.creditId}`,
    );
    expect(r.apps, 'NO SUBJECT — the credit has no application, so nothing consumed it and the law is about nothing').toBe(2);
    expect(r.consumed, `the two applications consumed the whole original ${c.originalMinor}`).toBe(c.originalMinor.toString());
    expect(r.remaining, 'so nothing of the credit remains').toBe('0');
    expect(
      r.remaining_carrying,
      `and its remaining CARRYING value is zero EXACTLY, measured ${r.remaining_carrying}. g(OA, OB, 0) = 0 by definition and the max(1, …) ` +
        `floor is what makes the last consumption release the entire residue rather than leaving a minor unit of carrying value on a credit ` +
        `nobody can consume again (packages/inventory/src/supplier-settlement.ts:7-10, 31-35).`,
    ).toBe('0');
    expect(
      r.released,
      `and Σ cr_rel over the applications is the credit's whole original carrying ${c.originalCarryingMinor} — OB − g(0) and nothing less`,
    ).toBe(c.originalCarryingMinor.toString());
  });
});
