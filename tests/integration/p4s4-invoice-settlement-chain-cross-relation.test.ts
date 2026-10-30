/**
 * P4-S4 — THE CHAIN LAW ACROSS THE TWO REDUCER RELATIONS.
 * (DR-72. `0081:327-333` and `0081:473-476`; the chain itself is
 *  `invoice_settlement_verify` at `0081:691`, reached from
 *  `payment_allocation_value_complete` at `0081:1060` `at PERFORM`.)
 *
 * ── THE HOLE THIS FILE COVERS, AND WHY NOTHING ELSE COVERS IT ─────────────
 *
 * Both settling relations carry a per-relation level `UNIQUE` on
 * `(business_id, invoice_id, ar_released_before_txn_minor)`, and
 * `p4s4-invoice-settlement-chain.test.ts:318` already proves that a second row
 * at one position WITHIN `payment_allocations` is refused `23505` by that
 * index. The schema states the limit of that index in its own words
 * (`0081:327-333`):
 *
 *   «a UNIQUE index cannot see across `payment_allocations` and
 *    `customer_credit_applications`, which can each occupy the same level, so
 *    the cross-relation guarantee rests on `invoice_settlement_verify`.»
 *
 * So the cross-relation case has NO index behind it. One payment allocation
 * and one credit application of the same invoice, both computed from the same
 * chain position, collide on no key in either relation, and the ONLY thing in
 * the estate that refuses them is the chain inside
 * `invoice_settlement_verify`. This file is that law.
 *
 * ── WHAT THE REFUSED STATE IS ─────────────────────────────────────────────
 *
 * The attack is not an over-settlement. The two reducers apply `a₁` and `a₂`
 * with `a₁ + a₂ = T`, so every AGGREGATE reads perfectly closed:
 *
 *     Σa = T          and          Σrel = HALF_EVEN(B·Σa, T) = B   (at Σa = T)
 *
 * and therefore `invoice_outstanding` returns `0` in BOTH currencies. The
 * invoice looks paid. What is false is the HISTORY: both reducers claim that
 * nothing had been released before them, so the same `a₁` of the invoice is
 * released twice and the other `a₂` of it never is. The only term of the law
 * that can see this is the per-row recurrence `h.x <> h.before`
 * (`0081:770-772`), and this file measures that the cumulative identity is
 * BLIND to it on this head — see the last case, which proves the identity has
 * teeth where `B ≠ T` and measures that on this head it cannot.
 *
 * ── WHY THE LAW IS FORCED BY NAME AND NOT WITH `ALL` ──────────────────────
 *
 * The two `value_complete` triggers are `DEFERRABLE INITIALLY DEFERRED`, so a
 * violation planted in a transaction that is rolled back NEVER REACHES THE
 * CHECK: the write is accepted, the invoice reads `outstanding = 0`, and
 * nothing is raised at all. That is measured here as its own case, because it
 * is the reason every refusal below forces the constraint rather than trusting
 * the plant to speak.
 *
 * It is forced BY NAME because `payment_allocations_binding_fk` is deferred
 * too (measured below), and a planted allocation has no
 * `accounting_source_bindings` row — no command wrote it a journal entry — so
 * `SET CONSTRAINTS ALL IMMEDIATE` would let a FOREIGN KEY answer in place of
 * the law. Forcing the settlement trigger by name leaves the binding FK
 * deferred and makes the chain the next thing that can speak. That the law and
 * not something else is what spoke is then proved by the pair of cases below:
 * the SAME plant with the LAWFUL position is ACCEPTED through the SAME forced
 * trigger. One integer differs between the two, so no foreign key, no missing
 * seed row and no guard can account for the refusal.
 *
 * Every `it` requires its subject first. No `.skip`, no `.todo`, no
 * conditional pass; every count carries a `business_id` predicate; every
 * planted row runs inside a transaction that is ALWAYS rolled back.
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
  deferredVerifierWiring,
  derivedRead,
  inRolledBackTx,
  invoiceChain,
  must,
  plantSettlementRow,
  raised,
  type Queryable,
} from '../golden-regression/phase4-s4/harness';
import { applyCredit, collectPayment, CHAIN, ROUTINES, type AllocationInput } from '../golden-regression/phase4-s4/settlement-path';
import {
  newCustomer,
  sellOnCredit,
  settlementMissing,
  settlementWorld,
  stockUp,
  type OpenInvoice,
  type SettlementWorld,
} from '../golden-regression/phase4-s4/settlement-world';

const CLAIM =
  'two reducers of one invoice computed from the same chain position are refused even when one is a payment allocation and the other a credit application, which no per-relation UNIQUE can see';

/**
 * The refusal this law answers with. It is a literal here, so the case below
 * ALSO asserts that this exact token appears in the LIVE body of
 * `invoice_settlement_verify`: the day the migration renames the refusal, this
 * file fails loudly instead of passing on a string nothing raises any more.
 */
const CHAIN_REFUSAL = 'invoice_settlement.settlement_inconsistent';
/** The constraint trigger that carries the law, forced by name. */
const SETTLEMENT_TRIGGER = 'payment_allocations_value_complete';
/** Deferred too, and the reason `ALL` is not what gets forced. */
const BINDING_FK = 'payment_allocations_binding_fk';

let w: SettlementWorld;
let missing: readonly string[] = [];

/** The twin that is settled LAWFULLY across both relations: the positive control. */
let lawful: OpenInvoice | undefined;
/** The twin that is settled HALF way, and which the planted row then attacks. */
let attacked: OpenInvoice | undefined;
/** `a₁`, applied by the credit application at position 0 on BOTH twins. */
let a1 = 0n;
/** `a₂ = T − a₁`, applied by the payment allocation: at `a₁` on the lawful twin, at `0` by the plant. */
let a2 = 0n;
/** The lawful payment allocation on the lawful twin, which every plant below is cloned from. */
let sourceAllocationId: string | undefined;

function leg(inv: OpenInvoice, appliedMinor: bigint, releasedBefore: bigint): AllocationInput {
  return {
    invoiceId: inv.invoiceId,
    appliedMinor: appliedMinor.toString(),
    releasedBeforeMinor: releasedBefore.toString(),
    invoiceTotalTxnMinor: inv.totalTxnMinor,
    invoiceTotalBaseMinor: inv.totalBaseMinor,
  };
}

/** The live `sha256` of a routine's `pg_get_functiondef`, which is how «unchanged» is proved of a database object. */
async function routineDigest(q: Queryable, name: string): Promise<string> {
  const r = await q.query<{ digest: string }>(
    `SELECT encode(sha256(pg_get_functiondef(p.oid)::text::bytea), 'hex') AS digest
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = $1`,
    [name],
  );
  return must(r.rows[0], `the live definition of ${name}`).digest;
}

/** The live body of a routine, read from the catalogue and never out of a migration file. */
async function routineBody(q: Queryable, name: string): Promise<string> {
  const r = await q.query<{ body: string }>(
    `SELECT pg_get_functiondef(p.oid) AS body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = $1`,
    [name],
  );
  return must(r.rows[0], `the live body of ${name}`).body;
}

/**
 * Plant ONE payment allocation on the attacked twin, cloned from the lawful
 * twin's accepted allocation with the named overrides, then force the
 * settlement trigger BY NAME and report what it raised.
 *
 * The clone keeps the amount, the currencies, the rates, the payment's base
 * amount, the dust and the realized FX of an ACCEPTED row, so the per-row
 * identities of `payment_allocation_value_complete` (`0081:1049-1057`) are
 * satisfied and the chain is the next thing that can speak. Everything runs in
 * a transaction that is always rolled back.
 */
async function plantOnAttacked(overrides: Readonly<Record<string, string | number | null>>): Promise<{
  readonly insertError: { readonly message: string; readonly code: string | undefined } | null;
  readonly forced: { readonly message: string; readonly code: string | undefined } | null;
  /**
   * `relation@position+applied` per step, SORTED.
   *
   * Sorted because the two rows of the attack SHARE a position and
   * `invoiceChain` orders by the position alone, so the order the union
   * happened to return is not a property of the estate. The law's own
   * `ORDER BY d.x, d.amount` (`0081:766`) breaks the tie inside the database;
   * a suite that asserted the order it saw out here would be asserting how a
   * `UNION ALL` was planned.
   */
  readonly positions: readonly string[];
  readonly applied: bigint;
  readonly released: bigint;
  readonly breaks: readonly { readonly kind: string; readonly actualPosition: string }[];
  readonly read: { readonly outstandingTxnMinor: bigint; readonly outstandingBaseMinor: bigint; readonly state: string } | null;
}> {
  const target = must(attacked, 'the attacked twin');
  const source = must(sourceAllocationId, 'the lawful allocation every plant is cloned from');
  return inRolledBackTx(
    () => ownerClient(),
    w.shop,
    async (c) => {
      const newId = randomUUID();
      // The INSERT is reported separately from the forced check. A plant that
      // died on insertion never reached the law, and a case that conflated the
      // two would read «something refused me» as «the chain refused me».
      const insertError = await raised(() =>
        plantSettlementRow(c, 'payment_allocations', w.shop.businessId, source, { id: newId, binding_source_id: newId, ...overrides }),
      );
      if (insertError !== null) return { insertError, forced: null, positions: [], applied: 0n, released: 0n, breaks: [], read: null };
      // Measured BEFORE the force, because after a refusal the transaction is
      // aborted and nothing can be read out of it.
      const chain = await invoiceChain(c, w.shop.businessId, target.invoiceId);
      const totals = chainTotals(chain);
      const positions = chain.map((s) => `${s.relation}@${s.positionMinor}+${s.appliedMinor}`).sort();
      const breaks = chainBreaks(chain).map((b) => ({ kind: b.kind, actualPosition: b.actualPosition }));
      const forced = await raised(() => c.query(`SET CONSTRAINTS ${SETTLEMENT_TRIGGER} IMMEDIATE`));
      // Readable only when the force did NOT refuse: that is the whole point
      // of the negative control and of the acceptance case.
      const read = forced === null ? await derivedRead(c, w.shop.businessId, target.invoiceId) : null;
      return {
        insertError,
        forced,
        positions,
        applied: totals.applied,
        released: totals.released,
        breaks,
        read: read === null ? null : { outstandingTxnMinor: read.outstandingTxnMinor, outstandingBaseMinor: read.outstandingBaseMinor, state: read.state },
      };
    },
  );
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  w = await settlementWorld('s4xrel');
  missing = await settlementMissing(w);
  if (missing.length > 0) return;

  await stockUp(w, '100', '7');
  const customer = await newCustomer(w);

  // THREE invoices of ONE customer. `funder` is overpaid to give birth to the
  // credit; `lawful` and `attacked` are TWINS — same product, same quantity,
  // so the same `T` and the same `B` — which is what lets one accepted
  // allocation be cloned onto the other twin without any of its stored
  // figures ceasing to be the R-82 figures of its invoice. The twins being
  // interchangeable is asserted below and not assumed.
  const funder = await sellOnCredit(w, customer, '1');
  lawful = await sellOnCredit(w, customer, '2');
  attacked = await sellOnCredit(w, customer, '2');

  const total = BigInt(lawful.totalTxnMinor);
  // A THIRD and two thirds, so the two reducers of the attack apply DIFFERENT
  // amounts. Two equal amounts at one position would make the chain's
  // `ORDER BY x, amount` a tie, and a law whose subject depends on how a tie
  // broke is a law about the planner.
  a1 = total / 3n;
  a2 = total - a1;
  expect(a1 > 0n && a2 > 0n && a1 !== a2, `the two reducers apply different positive amounts of ${total}: measured ${a1} and ${a2}`).toBe(true);

  // The credit, born of a surplus on `funder` large enough to be applied to
  // BOTH twins and still leave a positive remainder.
  const creditId = randomUUID();
  const born = await collectPayment(w.t, w.headers, {
    paymentId: randomUUID(),
    customerId: customer,
    paymentMethodId: w.paymentMethodId,
    paymentDate: w.day,
    amountMinor: (BigInt(funder.totalTxnMinor) + total).toString(),
    creditId,
    allocations: [leg(funder, BigInt(funder.totalTxnMinor), 0n)],
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
  const originalMinor = BigInt(cr.oa);
  expect(originalMinor >= a1 * 2n, `the credit ${originalMinor} covers the first leg of BOTH twins (${a1} each)`).toBe(true);

  // Leg one of each twin, from position 0, through the REAL credit-application
  // command: the row the attack then shares a position with.
  const credited = async (inv: OpenInvoice, remainingBefore: bigint): Promise<Response> =>
    applyCredit(w.t, w.headers, {
      applicationId: randomUUID(),
      creditId,
      customerId: customer,
      invoiceId: inv.invoiceId,
      applicationDate: w.day,
      consumedMinor: a1.toString(),
      remainingBeforeMinor: remainingBefore.toString(),
      creditOriginalMinor: cr.oa,
      creditOriginalCarryingMinor: cr.ob,
      leg: leg(inv, a1, 0n),
    });
  const c1 = await credited(lawful, originalMinor);
  expect(c1.status, `leg one of the lawful twin commits: ${JSON.stringify(c1.body)}`).toBeLessThan(300);
  const c2 = await credited(attacked, originalMinor - a1);
  expect(c2.status, `leg one of the attacked twin commits: ${JSON.stringify(c2.body)}`).toBeLessThan(300);

  // Leg two of the LAWFUL twin only, through the REAL payment command: the
  // accepted allocation every plant below is cloned from. The attacked twin is
  // deliberately left with `a₂` outstanding, so the planted row can complete
  // it to exactly `T` and the refused state is an overlap and never an
  // over-settlement.
  const paid = await collectPayment(w.t, w.headers, {
    paymentId: randomUUID(),
    customerId: customer,
    paymentMethodId: w.paymentMethodId,
    paymentDate: w.day,
    amountMinor: a2.toString(),
    allocations: [leg(lawful, a2, a1)],
  });
  expect(paid.status, `leg two of the lawful twin commits: ${JSON.stringify(paid.body)}`).toBeLessThan(300);
  const src = must(
    (
      await ownerPool().query<{ id: string }>(
        `SELECT id::text AS id FROM payment_allocations WHERE business_id = $1 AND invoice_id = $2 AND ${CHAIN.position} = $3`,
        [w.shop.businessId, lawful.invoiceId, a1.toString()],
      )
    ).rows[0],
    `the lawful twin's accepted allocation at chain position ${a1}`,
  );
  sourceAllocationId = src.id;
}, 420_000);

afterAll(async () => {
  await w?.t?.close();
  await resetData();
});

describe('P4-S4 the chain law across the two reducer relations', () => {
  it('the subject exists: the settlement relations, their chain columns, the commands, the verifiers and the routes', () => {
    requireSubject(missing, CLAIM);
  });

  it('the shipped wiring is what calls this law at COMMIT, and the refusal this file names is the one the live routine raises', async () => {
    requireSubject(missing, CLAIM);
    const wiring = await deferredVerifierWiring(ownerPool());
    const reducers = wiring.filter((x) => x.relation === 'payment_allocations' || x.relation === 'customer_credit_applications');
    expect(
      reducers.map((x) => `${x.relation}/${x.trigger} deferred=${x.deferred} reaches=${x.reachesVerifier}`).sort(),
      `BOTH reducer relations must reach ${ROUTINES.invoiceSettlementVerify} through a DEFERRABLE INITIALLY DEFERRED constraint trigger, or the ` +
        `cross-relation law is carried by nothing and forcing it by name below would be a proof about a routine nobody runs. Measured: ` +
        `${JSON.stringify(wiring)}`,
    ).toEqual([
      `customer_credit_applications/customer_credit_applications_value_complete deferred=true reaches=true`,
      `payment_allocations/${SETTLEMENT_TRIGGER} deferred=true reaches=true`,
    ]);
    // The literal this file asserts on, pinned to the shipped routine.
    const body = await routineBody(ownerPool(), ROUTINES.invoiceSettlementVerify);
    expect(
      body.includes(CHAIN_REFUSAL),
      `${ROUTINES.invoiceSettlementVerify} must still raise "${CHAIN_REFUSAL}" by that name. If the migration renamed it, every refusal ` +
        `assertion in this file would be matching a string nothing raises, and would pass only because it never looked.`,
    ).toBe(true);
    // And the reason the force below names ONE constraint instead of ALL.
    const deferred = await ownerPool().query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'payment_allocations'::regclass AND condeferrable AND condeferred ORDER BY conname`,
    );
    expect(
      deferred.rows.map((r) => r.conname),
      `a planted allocation has no accounting_source_bindings row, so ${BINDING_FK} — deferred too — would answer in place of the law under ` +
        `SET CONSTRAINTS ALL IMMEDIATE. That is why the force below names ${SETTLEMENT_TRIGGER}.`,
    ).toEqual([BINDING_FK, SETTLEMENT_TRIGGER]);
  });

  it('POSITIVE CONTROL — a LAWFUL cross-relation chain over the twin closes the invoice to nothing in BOTH currencies', async () => {
    requireSubject(missing, CLAIM);
    const inv = must(lawful, 'the lawful twin');
    const chain = await invoiceChain(ownerPool(), w.shop.businessId, inv.invoiceId);
    expect(
      chain.map((s) => `${s.relation}@${s.positionMinor}+${s.appliedMinor}`),
      `the lawful twin is settled by ONE row in EACH relation, and the positions PARTITION its total: a cross-relation chain is not ` +
        `refused for being cross-relation, which is what makes the refusal below about the POSITION and nothing else`,
    ).toEqual([`customer_credit_applications@0+${a1}`, `payment_allocations@${a1}+${a2}`]);
    expect(chainBreaks(chain), 'and it has no gap and no overlap').toEqual([]);
    const totals = chainTotals(chain);
    const read = await derivedRead(ownerPool(), w.shop.businessId, inv.invoiceId);
    expect(
      {
        applied: totals.applied.toString(),
        released: totals.released.toString(),
        outstanding_txn: read.outstandingTxnMinor.toString(),
        outstanding_base: read.outstandingBaseMinor.toString(),
        state: read.state,
      },
      `Σa must be the invoice's whole T and Σrel its whole B, so the invoice owes nothing in either currency. This is the arm the attack ` +
        `below differs from by ONE integer, and a failure here would mean the attack's refusal could be a broken fixture wearing the ` +
        `costume of a law`,
    ).toEqual({
      applied: inv.totalTxnMinor,
      released: inv.totalBaseMinor,
      outstanding_txn: '0',
      outstanding_base: '0',
      state: 'paid',
    });
  });

  it('the twins are interchangeable and the attacked twin still owes exactly the amount the plant will claim', async () => {
    requireSubject(missing, CLAIM);
    const l = must(lawful, 'the lawful twin');
    const a = must(attacked, 'the attacked twin');
    expect(
      { txn: a.totalTxnMinor, base: a.totalBaseMinor, ccy: a.currencyCode, rate: a.sourceToBaseRate },
      `the clone keeps the SOURCE row's rel, dust, realized FX and rates, and those are the R-82 figures of the invoice the row names. If the ` +
        `twins' totals differed, the per-row identity of 0081:1049-1057 would refuse the clone and the refusal below would be the WRONG LAW`,
    ).toEqual({ txn: l.totalTxnMinor, base: l.totalBaseMinor, ccy: l.currencyCode, rate: l.sourceToBaseRate });
    const chain = await invoiceChain(ownerPool(), w.shop.businessId, a.invoiceId);
    expect(
      chain.map((s) => `${s.relation}@${s.positionMinor}+${s.appliedMinor}`),
      'the attacked twin carries exactly ONE reducer, a credit application at position 0',
    ).toEqual([`customer_credit_applications@0+${a1}`]);
    const read = await derivedRead(ownerPool(), w.shop.businessId, a.invoiceId);
    expect(
      { outstanding_txn: read.outstandingTxnMinor.toString(), state: read.state },
      `so it owes exactly a₂ = ${a2}, and a plant that applies a₂ brings Σa to exactly T — an OVERLAP and never an over-settlement, which is ` +
        `a different term of the law (0081:782 "v_sum > total")`,
    ).toEqual({ outstanding_txn: a2.toString(), state: 'partial' });
  });

  it('THE TRAP — the same violation planted and NOT forced raises nothing at all, and the invoice reads fully settled', async () => {
    requireSubject(missing, CLAIM);
    // The constraint triggers are INITIALLY DEFERRED, so a plant inside a
    // transaction that is rolled back never reaches the check. This is
    // measured, and not described, because it is the reason every refusal in
    // this file forces the constraint — and because what it shows is the
    // CORRUPT STATE the law exists to prevent: every aggregate reads closed.
    const target = must(attacked, 'the attacked twin');
    const source = must(sourceAllocationId, 'the lawful allocation');
    const outcome = await inRolledBackTx(
      () => ownerClient(),
      w.shop,
      async (c) => {
        const newId = randomUUID();
        const err = await raised(() =>
          plantSettlementRow(c, 'payment_allocations', w.shop.businessId, source, {
            id: newId,
            binding_source_id: newId,
            invoice_id: target.invoiceId,
            [CHAIN.position]: 0,
          }),
        );
        const read = await derivedRead(c, w.shop.businessId, target.invoiceId);
        const totals = chainTotals(await invoiceChain(c, w.shop.businessId, target.invoiceId));
        return { err, read, totals };
      },
    );
    expect(
      outcome.err,
      `the INSERT itself must be accepted: no per-relation UNIQUE, no foreign key and no BEFORE guard refuses this row, which is exactly ` +
        `0081:327-333's point. A refusal here would mean the law below was never reached. Measured: ${JSON.stringify(outcome.err)}`,
    ).toBeNull();
    expect(
      {
        applied: outcome.totals.applied.toString(),
        released: outcome.totals.released.toString(),
        outstanding_txn: outcome.read.outstandingTxnMinor.toString(),
        outstanding_base: outcome.read.outstandingBaseMinor.toString(),
      },
      `and with the deferred check not forced, the invoice reads CLOSED in both currencies while the same ${a1} of it was released twice and ` +
        `the other ${a2} never was. Σa = T and Σrel = B both hold, so no aggregate can see this defect: only the per-row recurrence can`,
    ).toEqual({
      applied: target.totalTxnMinor,
      released: target.totalBaseMinor,
      outstanding_txn: '0',
      outstanding_base: '0',
    });
  });

  it('THE REFUSAL — one payment allocation and one credit application at the SAME chain position are refused BY NAME', async () => {
    requireSubject(missing, CLAIM);
    const target = must(attacked, 'the attacked twin');
    const outcome = await plantOnAttacked({ invoice_id: target.invoiceId, [CHAIN.position]: 0 });
    expect(outcome.insertError, `the plant must reach the law: ${JSON.stringify(outcome.insertError)}`).toBeNull();
    // What the law refused, stated before the refusal is asserted.
    expect(
      outcome.positions,
      `the refused state is TWO reducers at position 0, one in EACH relation — the shape no per-relation UNIQUE can see (0081:327-333). Each ` +
        `relation holds exactly one row at that position, so both indexes are satisfied`,
    ).toEqual([`customer_credit_applications@0+${a1}`, `payment_allocations@0+${a2}`]);
    expect(
      { applied: outcome.applied.toString(), released: outcome.released.toString() },
      `and it is refused with Σa = T and Σrel = B — the cumulative identity Σrel = HALF_EVEN(B·Σa, T), which at Σa = T is Σrel = B, is ` +
        `SATISFIED. The law is not refusing an arithmetic mismatch; it is refusing a history in which the same amount is released twice`,
    ).toEqual({ applied: target.totalTxnMinor, released: target.totalBaseMinor });
    expect(outcome.breaks, 'and the recurrence names it an OVERLAP at position 0, which is the term that can see it').toEqual([
      { kind: 'overlap', actualPosition: '0' },
    ]);
    const err = must(outcome.forced, `the refusal. NOTHING was raised, so two reducers of invoice ${target.invoiceId} can be computed from one chain position`);
    expect(
      err.message,
      `and the refusal is the CHAIN LAW by name. A 23505 would be a per-relation UNIQUE (which cannot see this), a 23503 the deferred binding ` +
        `FK, and a "customer_payment.settlement_inconsistent" the per-row trigger at 0081:1049-1057 — none of those is this law. Measured: ` +
        `${err.code} ${err.message}`,
    ).toContain(CHAIN_REFUSAL);
    expect(err.code, `raised by ${ROUTINES.invoiceSettlementVerify} as a business refusal: ${err.code} ${err.message}`).toBe('P0001');
  });

  it('ATTRIBUTION — the SAME plant at the LAWFUL position is ACCEPTED through the SAME forced trigger, so one integer is the whole difference', async () => {
    requireSubject(missing, CLAIM);
    const target = must(attacked, 'the attacked twin');
    // Byte-for-byte the plant of the case above, with `ar_released_before_txn_minor`
    // left at the source row's lawful `a₁` instead of 0. Same clone, same new
    // payment, same absent binding row, same forced constraint.
    const outcome = await plantOnAttacked({ invoice_id: target.invoiceId });
    expect(outcome.insertError, `the plant is accepted on insertion: ${JSON.stringify(outcome.insertError)}`).toBeNull();
    expect(outcome.positions, 'the positions now PARTITION the total, across the two relations').toEqual([
      `customer_credit_applications@0+${a1}`,
      `payment_allocations@${a1}+${a2}`,
    ]);
    expect(
      outcome.forced,
      `this is the attribution of the refusal above. The two plants differ in ONE INTEGER — the chain position — and are otherwise the same ` +
        `cloned row, with the same missing accounting_source_bindings row, the same foreign keys and the same forced constraint. So the ` +
        `refusal above cannot be a foreign key, a missing seed row, a guard or the planter: it is the chain. Measured: ` +
        `${JSON.stringify(outcome.forced)}`,
    ).toBeNull();
    expect(
      must(outcome.read, 'the derived read of the accepted plant'),
      'and the accepted cross-relation chain closes the invoice to nothing in both currencies',
    ).toEqual({ outstandingTxnMinor: 0n, outstandingBaseMinor: 0n, state: 'paid' });
  });

  it('NEGATIVE CONTROL — with the verifier’s effect removed the same write is ACCEPTED, and the shipped definition is proved unchanged', async () => {
    requireSubject(missing, CLAIM);
    const target = must(attacked, 'the attacked twin');
    const source = must(sourceAllocationId, 'the lawful allocation');
    const before = await routineDigest(ownerPool(), ROUTINES.invoiceSettlementVerify);
    const outcome = await inRolledBackTx(
      () => ownerClient(),
      w.shop,
      async (c) => {
        // The verifier's EFFECT is removed by replacing its body with a no-op
        // inside this transaction. DDL is transactional, so the ROLLBACK in
        // `inRolledBackTx` restores the shipped definition; that it did is
        // asserted from OUTSIDE this transaction below, and the digest taken
        // here proves the replacement was APPLIED before any result is read.
        await c.query(
          `CREATE OR REPLACE FUNCTION ${ROUTINES.invoiceSettlementVerify}(p_business_id UUID, p_invoice_id UUID) RETURNS void
             LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $noop$ BEGIN RETURN; END $noop$`,
        );
        const inside = await routineDigest(c, ROUTINES.invoiceSettlementVerify);
        const newId = randomUUID();
        const insertError = await raised(() =>
          plantSettlementRow(c, 'payment_allocations', w.shop.businessId, source, {
            id: newId,
            binding_source_id: newId,
            invoice_id: target.invoiceId,
            [CHAIN.position]: 0,
          }),
        );
        const forced = await raised(() => c.query(`SET CONSTRAINTS ${SETTLEMENT_TRIGGER} IMMEDIATE`));
        const seen = forced === null ? await derivedRead(c, w.shop.businessId, target.invoiceId) : null;
        const read =
          seen === null ? null : { outstandingTxnMinor: seen.outstandingTxnMinor, outstandingBaseMinor: seen.outstandingBaseMinor, state: seen.state };
        return { inside, insertError, forced, read };
      },
    );
    expect(
      outcome.inside === before,
      `THE PLANT MUST BE PROVED APPLIED BEFORE ITS RESULT IS READ. The routine's digest inside the transaction must DIFFER from the shipped ` +
        `${before}; if it did not, the "acceptance" below would be the shipped law accepting the write, which is the opposite of what this ` +
        `case claims. Measured inside: ${outcome.inside}`,
    ).toBe(false);
    expect(outcome.insertError, `the plant is accepted on insertion: ${JSON.stringify(outcome.insertError)}`).toBeNull();
    expect(
      outcome.forced,
      `WITH THE LAW GONE, THE SAME WRITE IS ACCEPTED. This is the half that makes the refusal above mean something: it proves the refusal came ` +
        `from ${ROUTINES.invoiceSettlementVerify} and not from something else in the estate that would have objected anyway. Measured: ` +
        `${JSON.stringify(outcome.forced)}`,
    ).toBeNull();
    expect(
      must(outcome.read, 'the derived read with the law removed'),
      `and the invoice then reads FULLY SETTLED — Σa = T and Σrel = B — while the same ${a1} of it was released twice and the other ${a2} ` +
        `never was. That unreachable-but-plausible state is the harm, and on this head it is invisible to every aggregate`,
    ).toEqual({ outstandingTxnMinor: 0n, outstandingBaseMinor: 0n, state: 'paid' });
    const after = await routineDigest(ownerPool(), ROUTINES.invoiceSettlementVerify);
    expect(
      after,
      `and the SHIPPED definition is byte-identical after the control: the replacement lived only inside a rolled-back transaction. A test that ` +
        `left a no-op verifier behind would make every later law of this estate vacuous`,
    ).toBe(before);
  });

  it('the shipped verifier still refuses, measured AFTER the negative control, so nothing was left weakened', async () => {
    requireSubject(missing, CLAIM);
    const target = must(attacked, 'the attacked twin');
    const outcome = await plantOnAttacked({ invoice_id: target.invoiceId, [CHAIN.position]: 0 });
    const err = must(outcome.forced, 'the refusal, re-measured after the negative control replaced and restored the routine');
    expect(err.message, `the law is back and refusing: ${err.code} ${err.message}`).toContain(CHAIN_REFUSAL);
  });

  it('the cumulative identity has teeth only where B ≠ T, and on this head B = T — stated, measured, and not faked', async () => {
    requireSubject(missing, CLAIM);
    // The chain law has TWO independent terms: the per-row recurrence
    // `h.x <> h.before` and the cumulative identity
    // `Σrel = HALF_EVEN(B·Σa, T)`. On this head the identity cannot see the
    // overlap at all, and that is a property of the head and not of the law:
    // a product's price currency is pinned to the business base currency, so
    // every invoice carries `source_to_base_rate = 1` and `B = T`, where
    // `rel(B,T,X,a) = a` identically and Σrel = Σa for ANY positions.
    //
    // So the identity's teeth are proved where `B ≠ T` IS representable, over
    // the estate's OWN arithmetic read from the database — never a second body
    // of the rounding in TypeScript, and never a fixture forced into a state
    // the catalogue authority forbids.
    const r = must(
      (
        await ownerPool().query<{ same: string; lawful: string; identity: string; bt_same: string; bt_identity: string }>(
          `SELECT (supplier_ap_release(333, 1000, 0, 500) + supplier_ap_release(333, 1000, 0, 500))::text AS same,
                  (supplier_ap_release(333, 1000, 0, 500) + supplier_ap_release(333, 1000, 500, 500))::text AS lawful,
                  inventory_half_even(333::numeric * 1000, 1000, 0)::text AS identity,
                  (supplier_ap_release(1000, 1000, 0, 500) + supplier_ap_release(1000, 1000, 0, 500))::text AS bt_same,
                  inventory_half_even(1000::numeric * 1000, 1000, 0)::text AS bt_identity`,
        )
      ).rows[0],
      'the estate’s own release arithmetic',
    );
    expect(
      { lawful: r.lawful, identity: r.identity },
      'where B ≠ T, a chain whose positions PARTITION the total releases exactly B: Σrel = HALF_EVEN(B·T, T) = B',
    ).toEqual({ lawful: '333', identity: '333' });
    expect(
      r.same === r.identity,
      `and where B ≠ T, two reducers at the SAME position releasing the same Σa = T release ${r.same} and not ${r.identity}: the cumulative ` +
        `identity catches the overlap on its own. This is the term that is live on a head where an invoice can carry B ≠ T`,
    ).toBe(false);
    expect(
      r.bt_same,
      `but at B = T the SAME overlap releases ${r.bt_same}, which IS the identity's ${r.bt_identity} — rel(T,T,X,a) = a for every X, so the ` +
        `identity is blind and the per-row recurrence is the ONLY term that refuses the cross-relation overlap on this head`,
    ).toBe(r.bt_identity);
    const live = must(
      (
        await ownerPool().query<{ total: string; cross: string }>(
          `SELECT count(*)::text AS total, count(*) FILTER (WHERE total_base_minor <> total_txn_minor)::text AS cross
             FROM invoices WHERE business_id = $1`,
          [w.shop.businessId],
        )
      ).rows[0],
      'the invoices of this business',
    );
    expect(BigInt(live.total) > 0n, `NO SUBJECT — this business has no invoice, so the disclosure below is quantified over nothing`).toBe(true);
    expect(
      live.cross,
      `THE DISCLOSURE: every invoice of this business carries B = T, so no fixture on this head can put the cumulative identity's teeth into ` +
        `the live law. The identity is proved able to refuse above, synthetically, over the estate's own functions; it is NOT asserted of a ` +
        `live row, because that is an assertion nobody here can make true`,
    ).toBe('0');
  });
});
