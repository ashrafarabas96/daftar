/**
 * `src/customer-reversal.ts` — the P4-S6 reversal planner, at level C.
 *
 * ## What each block proves, and what its RED PROOF plants
 *
 * A red proof here plants a REAL SUBJECT: it takes a chain or a plan that the
 * production module itself builds, mutates ONE fact of it, and requires the
 * production function to refuse. The subject is never fictional and the
 * assertion is never "no finding": a block that asserted `undefined` has no
 * finding would assert the opposite of its intent, and a planted defect that
 * the module cannot even be handed is a proof of nothing.
 *
 * Every plant is announced in its own `it` title with the word PLANTED, and
 * every announcing block executes a refusal, so one title cannot satisfy a
 * whole file — the `roster-red-proofs` standard of `gate:phase4:s4`, applied
 * here by hand because this package is outside that gate's roster.
 *
 * ## It asserts CODES, never messages
 *
 * A message is not a contract. `codeOf` reduces every call to its code or to
 * `'accepted'`, so a reworded refusal does not move a test and a renamed code
 * does.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DIRECT_VOID_IS_REFUSED,
  FROZEN_OPERATION_CODE_PATTERN,
  P4_S6_REQUIRED_WIRING,
  REVERSAL_CODES,
  REVERSAL_OPERATION_AUTHORITY,
  REVERSAL_OPERATION_CODES,
  ReversalError,
  activeTotal,
  chainBreak,
  creditChain,
  exactInverseSteps,
  invoiceChain,
  isContiguousFromZero,
  isLastActiveReducer,
  isReversalCode,
  orderedActive,
  planAllocationReversal,
  planPaymentReversal,
  tailOf,
  voidPrecondition,
  type ActiveReducer,
  type AllocationReversalInput,
  type PaymentReversalInput,
  type SettlementChain,
} from '../src/customer-reversal';
import { PERMISSIONS, SENSITIVE_PERMISSIONS } from '@daftar/domain-core';

/** The code of a refusal, or `'accepted'`. Never a message. */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ReversalError) return e.code;
    throw e;
  }
  return 'accepted';
}

// ── The world: one invoice of 1000, settled in three steps ───────────────
//
// Levels 0 → 400 → 700, amounts 400, 300, 300, which closes the invoice
// exactly. Entry ids are distinct and sort in the same order as the levels, so
// a test that depends on the deterministic mirror order says so by using them.

const INV = 'invoice-aaaa';
const TOTAL = 1000n;

function alloc(id: string, level: bigint, amount: bigint, entry: string): ActiveReducer {
  return { reducerId: id, kind: 'payment_allocation', level, amount, originalEntryId: entry };
}

const R1 = alloc('alloc-1', 0n, 400n, 'entry-1');
const R2 = alloc('alloc-2', 400n, 300n, 'entry-2');
const R3 = alloc('alloc-3', 700n, 300n, 'entry-3');

const fullChain = (): SettlementChain => invoiceChain(INV, TOTAL, [R1, R2, R3]);
/** After `alloc-3` was reversed: its row still exists in the relation, but it is NOT active. */
const afterTailReversed = (): SettlementChain => invoiceChain(INV, TOTAL, [R1, R2]);

function allocationInput(over: Partial<AllocationReversalInput> = {}): AllocationReversalInput {
  return {
    reversalId: 'rev-1',
    reducerId: R3.reducerId,
    kind: 'payment_allocation',
    originalEntryId: R3.originalEntryId,
    sourceType: 'customer_payment_allocation',
    chains: [fullChain()],
    reversalDate: '2026-03-02',
    originalDate: '2026-03-01',
    reason: 'keyed to the wrong invoice',
    ...over,
  };
}

// ──────────────────────────────────────────────────────────────────────────
describe('the chain law over the ACTIVE subset', () => {
  it('accepts the contiguous chain the settlement commands build', () => {
    expect(isContiguousFromZero(fullChain())).toBe(true);
    expect(activeTotal(fullChain())).toBe(1000n);
    expect(orderedActive(fullChain()).map((r) => r.reducerId)).toEqual(['alloc-1', 'alloc-2', 'alloc-3']);
  });

  it('accepts the chain that remains after the TAIL is reversed, with the top level freed', () => {
    const c = afterTailReversed();
    expect(isContiguousFromZero(c)).toBe(true);
    expect(activeTotal(c)).toBe(700n);
    // The level 700 is now free, and the original row at 700 still exists in
    // the relation. That is the whole incompatibility with the per-relation
    // level UNIQUE, and it is why a lawful later allocation needs the
    // replacement protection of docs/PHASE_4_S6_LEVEL_UNIQUENESS.md.
    expect(orderedActive(c).map((r) => r.level)).toEqual([0n, 400n]);
  });

  // ──────────────────────────────────────────────────────────────────────
  // ONE PLANTED FACT PER WORLD.
  //
  // A refusal only proves the law under test when the request is otherwise
  // completely valid: a world broken in two ways proves nothing about either
  // break, because the refusal could be naming the other one. So each planted
  // world below carries its own OTHERWISE-VALID proof, asserted in the test
  // rather than reasoned about in a comment — the plant is undone (or the
  // single broken field is corrected) and the SAME constructor must then
  // report a clean chain. Each of these three cases was previously pinned
  // only by the refusal code; the otherwise-valid half is new.
  // ──────────────────────────────────────────────────────────────────────

  it('PLANTED GAP — a chain whose middle reducer is dropped from the active set is reported as a gap, not silently re-chained', () => {
    // Plant: alloc-2 removed from ACTIVE while alloc-3 stays. This is exactly
    // the state a MID-CHAIN reversal would leave, and the counterexample
    // P4-AL-21 records. The subject is the real production constructor.
    const planted = invoiceChain(INV, TOTAL, [R1, R3]);
    expect(isContiguousFromZero(planted)).toBe(false);
    expect(chainBreak(planted)).toMatch(/gap/);
    expect(codeOf(() => tailOf(planted, 'allocation_reversal'))).toBe('allocation_reversal.chain_inconsistent');

    // OTHERWISE VALID, two ways. (a) Undo the plant by dropping the stranded
    // reducer: what remains is a clean chain with a tail, so the gap was the
    // ONE fact that differed.
    const withoutStranded = invoiceChain(INV, TOTAL, [R1]);
    expect(chainBreak(withoutStranded)).toBeNull();
    expect(tailOf(withoutStranded, 'allocation_reversal')?.reducerId).toBe('alloc-1');

    // (b) Undo the plant the other way, by re-seating the SAME reducer at the
    // level the recurrence gives it. Only `level` changes; the id, the amount
    // and the entry are alloc-3's own. A clean chain here proves the gap was
    // not an artefact of alloc-3's amount, its capacity fit or its ordering.
    const reseated = invoiceChain(INV, TOTAL, [R1, alloc(R3.reducerId, 400n, R3.amount, 'entry-3')]);
    expect(chainBreak(reseated)).toBeNull();
    expect(activeTotal(reseated)).toBe(700n);
    expect(tailOf(reseated, 'allocation_reversal')?.reducerId).toBe('alloc-3');
  });

  it('PLANTED OVERLAP — two active reducers at one level are an overlap, which is what the replaced level UNIQUE used to refuse', () => {
    const twin = alloc('alloc-2b', 400n, 300n, 'entry-2b');
    const planted = invoiceChain(INV, TOTAL, [R1, twin, R2]);
    expect(chainBreak(planted)).toMatch(/overlap/);
    expect(codeOf(() => tailOf(planted, 'allocation_reversal'))).toBe('allocation_reversal.chain_inconsistent');

    // OTHERWISE VALID: remove EITHER of the two rows at level 400 and the
    // chain is clean. Both directions are asserted, because removing only one
    // of them would leave open the possibility that the surviving row was
    // itself the defect and the duplication incidental.
    const withoutTwin = invoiceChain(INV, TOTAL, [R1, R2]);
    expect(chainBreak(withoutTwin)).toBeNull();
    expect(tailOf(withoutTwin, 'allocation_reversal')?.reducerId).toBe('alloc-2');

    const withoutOriginal = invoiceChain(INV, TOTAL, [R1, twin]);
    expect(chainBreak(withoutOriginal)).toBeNull();
    expect(tailOf(withoutOriginal, 'allocation_reversal')?.reducerId).toBe('alloc-2b');

    // And the overlap is not a disguised capacity break: 400 + 300 + 300 is
    // below the invoice total, so capacity is NOT what the refusal names.
    expect(chainBreak(planted)).not.toMatch(/capacity/);
  });

  it('PLANTED OVER-CAPACITY — an active set consuming more than the invoice total is refused', () => {
    // The ONE planted fact is the capacity. The rows are untouched.
    const planted = invoiceChain(INV, 500n, [R1, R2]);
    expect(chainBreak(planted)).toMatch(/capacity/);
    // Not a gap and not an overlap: the levels still follow the recurrence,
    // so the refusal is the capacity law and not a chain defect.
    expect(chainBreak(planted)).not.toMatch(/gap|overlap/);

    // OTHERWISE VALID: the SAME rows against the real invoice total are a
    // clean chain with a tail.
    const atRealCapacity = invoiceChain(INV, TOTAL, [R1, R2]);
    expect(chainBreak(atRealCapacity)).toBeNull();
    expect(tailOf(atRealCapacity, 'allocation_reversal')?.reducerId).toBe('alloc-2');
    // And the boundary is inclusive: consuming the capacity EXACTLY is lawful,
    // so the refusal above is about exceeding it and not about reaching it.
    const exactlyFull = invoiceChain(INV, 700n, [R1, R2]);
    expect(chainBreak(exactlyFull)).toBeNull();
  });

  it('an empty active set is a well-formed chain with no tail — an empty collection is never a refusal', () => {
    const empty = invoiceChain(INV, TOTAL, []);
    expect(chainBreak(empty)).toBeNull();
    expect(isContiguousFromZero(empty)).toBe(true);
    expect(activeTotal(empty)).toBe(0n);
    expect(tailOf(empty, 'allocation_reversal')).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe('the LIFO law — only the last active settlement reducer', () => {
  it('names the highest-level active reducer as the tail', () => {
    expect(tailOf(fullChain(), 'allocation_reversal')?.reducerId).toBe('alloc-3');
    expect(isLastActiveReducer(fullChain(), 'alloc-3', 'allocation_reversal')).toBe(true);
  });

  it('the tail MOVES BACK when the tail is reversed — the next reversal is the new tail, and only it', () => {
    const c = afterTailReversed();
    expect(tailOf(c, 'allocation_reversal')?.reducerId).toBe('alloc-2');
    expect(isLastActiveReducer(c, 'alloc-3', 'allocation_reversal')).toBe(false);
  });

  it('refuses the FIRST allocation of a three-step chain', () => {
    expect(codeOf(() => planAllocationReversal(allocationInput({ reducerId: 'alloc-1', originalEntryId: 'entry-1' })))).toBe(
      'allocation_reversal.not_last_reducer',
    );
  });

  it('refuses a MIDDLE allocation of a three-step chain', () => {
    expect(codeOf(() => planAllocationReversal(allocationInput({ reducerId: 'alloc-2', originalEntryId: 'entry-2' })))).toBe(
      'allocation_reversal.not_last_reducer',
    );
  });

  it('accepts the LAST allocation, and reports the level it frees', () => {
    const plan = planAllocationReversal(allocationInput());
    expect(plan.freedLevels).toEqual([{ chainId: INV, chainKind: 'invoice_ar', freedLevel: 700n, amount: 300n }]);
  });

  it('an EXACT REPLAY of a reversal answers already_reversed, and the two commands answer that one state with ONE code', () => {
    // THIS CASE PREVIOUSLY ASSERTED THE DEFECT. Its title said "it was already
    // reversed" while its assertion pinned `not_last_reducer` — a test that
    // names one law and holds the code to another, which is worse than no test
    // because it looks like coverage. The challenger found the code unreachable
    // for the condition it names; the title was the evidence.
    expect(codeOf(() => planAllocationReversal(allocationInput({ chains: [afterTailReversed()] })))).toBe('allocation_reversal.already_reversed');

    // And the payment command answers the SAME state with the SAME suffix, so
    // a client sees one state and one code and never two.
    const replayed = codeOf(() =>
      planPaymentReversal({
        reversalId: 'prev-1',
        paymentId: 'payment-1',
        allocations: [{ reducerId: 'alloc-3', originalEntryId: 'entry-3', chain: afterTailReversed() }],
        surplusCredit: null,
        reversalDate: '2026-03-02',
        originalDate: '2026-03-01',
        reason: 'replayed',
      }),
    );
    expect(replayed).toBe('payment_reversal.already_reversed');
    expect(replayed.split('.')[1]).toBe('allocation_reversal.already_reversed'.split('.')[1]);
  });

  it('a reducer the chain never carried is NOT confused with one already reversed when the chain still has a tail', () => {
    // The membership test must not become a catch-all: a reducer that is simply
    // the wrong one, on a chain whose tail is a DIFFERENT live reducer, is a
    // LIFO refusal and not a replay. Without this case the fix above would be
    // free to answer `already_reversed` for every miss.
    expect(codeOf(() => planAllocationReversal(allocationInput({ reducerId: 'alloc-1', originalEntryId: 'entry-1' })))).toBe(
      'allocation_reversal.not_last_reducer',
    );
  });

  it('PLANTED — a reversal dated before its original is refused, and the date is the caller-stated one with no clock read', () => {
    expect(codeOf(() => planAllocationReversal(allocationInput({ reversalDate: '2026-02-28' })))).toBe('allocation_reversal.date_before_original');
    // Same civil date is lawful: a reversal on the day of the original is not a reversal before it.
    expect(codeOf(() => planAllocationReversal(allocationInput({ reversalDate: '2026-03-01' })))).toBe('accepted');
  });

  it('PLANTED — a NON-CANONICAL date that is EARLIER than the original no longer slips past the ordering law', () => {
    // The challenger's demonstration, as a case here. `'2026-2-28'` is the 28th
    // of February, which is BEFORE the original of the 1st of March — and by
    // character order it is GREATER than `'2026-03-01'`, because `'2'` > `'0'`.
    // So the `<` comparison passed it. The comparison was not the defect; the
    // unvalidated input was.
    expect('2026-2-28' > '2026-03-01', 'the premise of the finding: character order and calendar order disagree here').toBe(true);
    expect(codeOf(() => planAllocationReversal(allocationInput({ reversalDate: '2026-2-28' })))).toBe('allocation_reversal.date_invalid');
    expect(
      codeOf(() =>
        planPaymentReversal({
          reversalId: 'prev-2',
          paymentId: 'payment-1',
          allocations: [{ reducerId: 'alloc-3', originalEntryId: 'entry-3', chain: fullChain() }],
          surplusCredit: null,
          reversalDate: '2026-2-28',
          originalDate: '2026-03-01',
          reason: 'modelled',
        }),
      ),
    ).toBe('payment_reversal.date_invalid');
  });

  it('PLANTED — a date of the right SHAPE that names no day of the calendar is refused', () => {
    // A regex alone would accept these. `2026-02-31` and `2026-13-01` match
    // `\d{4}-\d{2}-\d{2}` exactly and are not days.
    expect(codeOf(() => planAllocationReversal(allocationInput({ reversalDate: '2026-02-31' })))).toBe('allocation_reversal.date_invalid');
    expect(codeOf(() => planAllocationReversal(allocationInput({ reversalDate: '2026-13-01' })))).toBe('allocation_reversal.date_invalid');
    // And the canonical one is still accepted, so the validator refuses the
    // non-day and not the date.
    expect(codeOf(() => planAllocationReversal(allocationInput({ reversalDate: '2026-03-02' })))).toBe('accepted');
  });

  it('PLANTED — a blank reason is refused, and whitespace is not a reason', () => {
    expect(codeOf(() => planAllocationReversal(allocationInput({ reason: '   ' })))).toBe('allocation_reversal.reason_required');
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe('the TWO-CHAIN law — a credit application is the tail on both, or on neither', () => {
  const CREDIT = 'credit-bbbb';
  const CREDIT_ORIGINAL = 500n;

  /** Two applications of one credit: 300 then 200, so the credit closes exactly. */
  const C1 = { reducerId: 'app-1', remainingBeforeMinor: 500n, consumedMinor: 300n, originalEntryId: 'entry-c1' };
  const C2 = { reducerId: 'app-2', remainingBeforeMinor: 200n, consumedMinor: 200n, originalEntryId: 'entry-c2' };

  /** The invoice chain `app-2` also sits on: one earlier allocation, then `app-2` at 400. */
  const invoiceForApp2 = (): SettlementChain =>
    invoiceChain('invoice-cccc', 1000n, [R1, { reducerId: 'app-2', kind: 'credit_application', level: 400n, amount: 200n, originalEntryId: 'entry-c2' }]);

  function creditApplicationInput(over: Partial<AllocationReversalInput> = {}): AllocationReversalInput {
    return {
      reversalId: 'rev-2',
      reducerId: 'app-2',
      kind: 'credit_application',
      originalEntryId: 'entry-c2',
      sourceType: 'customer_credit_application',
      chains: [invoiceForApp2(), creditChain(CREDIT, CREDIT_ORIGINAL, [C1, C2])],
      reversalDate: '2026-03-02',
      originalDate: '2026-03-01',
      reason: 'applied to the wrong invoice',
      ...over,
    };
  }

  it('converts the DESCENDING stored credit level into the one ascending predicate, so there is one LIFO law and not two', () => {
    const c = creditChain(CREDIT, CREDIT_ORIGINAL, [C1, C2]);
    // level = original - remaining_before: 0 then 300. The tail is the SMALLEST
    // remaining_before, which is the last consumer.
    expect(orderedActive(c).map((r) => [r.reducerId, r.level])).toEqual([
      ['app-1', 0n],
      ['app-2', 300n],
    ]);
    expect(tailOf(c, 'allocation_reversal')?.reducerId).toBe('app-2');
    expect(isContiguousFromZero(c)).toBe(true);
  });

  it('accepts the application that is the tail on BOTH chains, and reports BOTH freed levels', () => {
    const plan = planAllocationReversal(creditApplicationInput());
    expect(plan.freedLevels.map((f) => [f.chainId, f.chainKind, f.freedLevel])).toEqual([
      ['credit-bbbb', 'customer_credit', 300n],
      ['invoice-cccc', 'invoice_ar', 400n],
    ]);
  });

  it('PLANTED — the tail on its INVOICE but not on its CREDIT is refused', () => {
    // Plant: a THIRD application consumed the credit after app-2, so app-2 is
    // mid-chain on the credit while still the tail on its invoice. The whole
    // credit chain is restated at original 600 so it stays CONTIGUOUS — a
    // planted gap would be refused by the chain law and would prove the wrong
    // thing.
    const credit = creditChain(CREDIT, 600n, [
      { reducerId: 'app-1', remainingBeforeMinor: 600n, consumedMinor: 300n, originalEntryId: 'entry-c1' },
      { reducerId: 'app-2', remainingBeforeMinor: 300n, consumedMinor: 200n, originalEntryId: 'entry-c2' },
      { reducerId: 'app-3', remainingBeforeMinor: 100n, consumedMinor: 100n, originalEntryId: 'entry-c3' },
    ]);
    expect(codeOf(() => planAllocationReversal(creditApplicationInput({ chains: [invoiceForApp2(), credit] })))).toBe('allocation_reversal.not_last_reducer');
  });

  it('PLANTED — the tail on its CREDIT but not on its INVOICE is refused', () => {
    // Plant: a later payment allocation settled more of the same invoice, so
    // app-2 is mid-chain on the invoice while still the tail on its credit.
    const invoice = invoiceChain('invoice-cccc', 1000n, [
      R1,
      { reducerId: 'app-2', kind: 'credit_application', level: 400n, amount: 200n, originalEntryId: 'entry-c2' },
      alloc('alloc-9', 600n, 100n, 'entry-9'),
    ]);
    expect(codeOf(() => planAllocationReversal(creditApplicationInput({ chains: [invoice, creditChain(CREDIT, CREDIT_ORIGINAL, [C1, C2])] })))).toBe(
      'allocation_reversal.not_last_reducer',
    );
  });

  it('PLANTED — a credit application presented with ONE chain is refused by arity, before any tail check could pass', () => {
    expect(codeOf(() => planAllocationReversal(creditApplicationInput({ chains: [invoiceForApp2()] })))).toBe('allocation_reversal.chain_inconsistent');
    expect(codeOf(() => planAllocationReversal(creditApplicationInput({ chains: [creditChain(CREDIT, CREDIT_ORIGINAL, [C1, C2])] })))).toBe(
      'allocation_reversal.chain_inconsistent',
    );
  });

  it('PLANTED — a payment allocation presented with a CREDIT chain it does not sit on is refused', () => {
    expect(codeOf(() => planAllocationReversal(allocationInput({ chains: [fullChain(), creditChain(CREDIT, CREDIT_ORIGINAL, [C1, C2])] })))).toBe(
      'allocation_reversal.chain_inconsistent',
    );
  });

  it('PLANTED — a credit consumer declaring more remaining than the credit ever had is refused', () => {
    expect(codeOf(() => creditChain(CREDIT, 100n, [C1]))).toBe('allocation_reversal.chain_inconsistent');
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe('the WHOLE-PAYMENT law', () => {
  const P = 'payment-dddd';

  /** A payment with two allocations, each the tail of its own invoice. */
  function twoChainPayment(over: Partial<PaymentReversalInput> = {}): PaymentReversalInput {
    return {
      reversalId: 'rev-3',
      paymentId: P,
      allocations: [
        { reducerId: 'pa-1', originalEntryId: 'entry-p1', chain: invoiceChain('invoice-1', 1000n, [R1, alloc('pa-1', 400n, 600n, 'entry-p1')]) },
        { reducerId: 'pa-2', originalEntryId: 'entry-p2', chain: invoiceChain('invoice-2', 500n, [alloc('pa-2', 0n, 500n, 'entry-p2')]) },
      ],
      surplusCredit: null,
      reversalDate: '2026-03-02',
      originalDate: '2026-03-01',
      reason: 'the customer paid twice',
      ...over,
    };
  }

  it('accepts a payment whose EVERY active allocation is the tail of its own chain, and nests one plan per allocation', () => {
    const plan = planPaymentReversal(twoChainPayment());
    expect(plan.allocationReversals.map((a) => a.reducerId)).toEqual(['pa-1', 'pa-2']);
    expect(plan.inverse.map((s) => s.originalEntryId)).toEqual(['entry-p1', 'entry-p2']);
    expect(plan.surplusCreditId).toBeNull();
  });

  it('accepts a payment with ZERO allocations — pure on-account money (R-87) — and mirrors only its credit entry', () => {
    const plan = planPaymentReversal(
      twoChainPayment({
        allocations: [],
        surplusCredit: { creditId: 'credit-z', originalEntryId: 'entry-z', originalAmountMinor: 900n, remainingAmountMinor: 900n },
      }),
    );
    expect(plan.allocationReversals).toEqual([]);
    expect(plan.inverse.map((s) => s.sourceType)).toEqual(['customer_credit']);
  });

  it('PLANTED — ONE of two allocations mid-chain refuses the WHOLE command; there is no partial reversal', () => {
    // Plant: a later allocation settled more of invoice-2, so pa-2 is mid-chain
    // there while pa-1 is still a perfectly lawful tail on invoice-1.
    const broken = twoChainPayment();
    const planted: PaymentReversalInput = {
      ...broken,
      allocations: [
        ...broken.allocations.filter((a) => a.reducerId === 'pa-1'),
        {
          reducerId: 'pa-2',
          originalEntryId: 'entry-p2',
          chain: invoiceChain('invoice-2', 1000n, [alloc('pa-2', 0n, 500n, 'entry-p2'), alloc('later', 500n, 200n, 'entry-later')]),
        },
      ],
    };
    expect(codeOf(() => planPaymentReversal(planted))).toBe('payment_reversal.not_last_reducer');
  });

  it('PLANTED — a CONSUMED surplus credit refuses the whole payment reversal by its own code', () => {
    expect(
      codeOf(() =>
        planPaymentReversal(
          twoChainPayment({ surplusCredit: { creditId: 'credit-z', originalEntryId: 'entry-z', originalAmountMinor: 900n, remainingAmountMinor: 400n } }),
        ),
      ),
    ).toBe('payment_reversal.credit_consumed');
  });

  it('an UNTOUCHED surplus credit is accepted, and a fully consumed one is refused — the boundary is remaining === original', () => {
    const whole = { creditId: 'credit-z', originalEntryId: 'entry-z', originalAmountMinor: 900n, remainingAmountMinor: 900n };
    expect(codeOf(() => planPaymentReversal(twoChainPayment({ surplusCredit: whole })))).toBe('accepted');
    expect(codeOf(() => planPaymentReversal(twoChainPayment({ surplusCredit: { ...whole, remainingAmountMinor: 0n } })))).toBe(
      'payment_reversal.credit_consumed',
    );
  });

  it('PLANTED — an allocation already reversed, presented in a payment reversal, is refused as already reversed', () => {
    const base = twoChainPayment();
    const planted: PaymentReversalInput = {
      ...base,
      allocations: [{ reducerId: 'pa-1', originalEntryId: 'entry-p1', chain: invoiceChain('invoice-1', 1000n, [R1]) }],
    };
    expect(codeOf(() => planPaymentReversal(planted))).toBe('payment_reversal.already_reversed');
  });

  it('PLANTED — two allocations of one payment presented on ONE invoice chain is refused: the tail question would have two answers', () => {
    const base = twoChainPayment();
    const one = invoiceChain('invoice-1', 1000n, [alloc('pa-1', 0n, 400n, 'entry-p1'), alloc('pa-2', 400n, 600n, 'entry-p2')]);
    expect(
      codeOf(() =>
        planPaymentReversal({
          ...base,
          allocations: [
            { reducerId: 'pa-1', originalEntryId: 'entry-p1', chain: one },
            { reducerId: 'pa-2', originalEntryId: 'entry-p2', chain: one },
          ],
        }),
      ),
    ).toBe('payment_reversal.chain_inconsistent');
  });

  it('PLANTED — a payment allocation presented on a CREDIT chain is refused', () => {
    const base = twoChainPayment();
    expect(
      codeOf(() =>
        planPaymentReversal({
          ...base,
          allocations: [
            {
              reducerId: 'pa-1',
              originalEntryId: 'entry-p1',
              chain: creditChain('credit-x', 600n, [{ reducerId: 'pa-1', remainingBeforeMinor: 600n, consumedMinor: 600n, originalEntryId: 'entry-p1' }]),
            },
          ],
        }),
      ),
    ).toBe('payment_reversal.chain_inconsistent');
  });

  it('PLANTED — a blank reason and a date before the payment are each refused by their own code', () => {
    expect(codeOf(() => planPaymentReversal(twoChainPayment({ reason: '\t\n ' })))).toBe('payment_reversal.reason_required');
    expect(codeOf(() => planPaymentReversal(twoChainPayment({ reversalDate: '2026-02-01' })))).toBe('payment_reversal.date_before_original');
  });

  it('the planner has NO parameter through which a partial reversal could be asked for', () => {
    // The whole-payment law as a shape, not as a validation. `allocations` is
    // the ACTIVE set the port returns; there is no `allocationIds`, no
    // `include`, no `only` and no `amountMinor` anywhere on the input.
    const keys = Object.keys(twoChainPayment()).sort();
    expect(keys).toEqual(['allocations', 'originalDate', 'paymentId', 'reason', 'reversalDate', 'reversalId', 'surplusCredit']);
    expect(keys.some((k) => /amount|minor|partial|only|include|subset/i.test(k))).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe('the exact-inverse journal selection', () => {
  it('carries only WHICH entry, WHEN and WHY — no field through which an amount could travel', () => {
    const plan = planAllocationReversal(allocationInput());
    for (const step of plan.inverse) {
      expect(Object.keys(step).sort()).toEqual(['originalEntryId', 'sourceId', 'sourceType']);
    }
  });

  it('orders the mirrors deterministically by entry id, so the account lock order is chosen here and not by a query plan', () => {
    const steps = exactInverseSteps(
      [
        { originalEntryId: 'entry-z', sourceType: 'customer_credit', sourceId: 'c' },
        { originalEntryId: 'entry-a', sourceType: 'customer_payment_allocation', sourceId: 'a' },
        { originalEntryId: 'entry-m', sourceType: 'customer_credit_application', sourceId: 'm' },
      ],
      'payment_reversal',
    );
    expect(steps.map((s) => s.originalEntryId)).toEqual(['entry-a', 'entry-m', 'entry-z']);
  });

  it('PLANTED — the same original entry twice in one reversal is refused, not deduplicated', () => {
    expect(
      codeOf(() =>
        exactInverseSteps(
          [
            { originalEntryId: 'entry-a', sourceType: 'customer_payment_allocation', sourceId: 'a' },
            { originalEntryId: 'entry-a', sourceType: 'customer_payment_allocation', sourceId: 'a2' },
          ],
          'allocation_reversal',
        ),
      ),
    ).toBe('allocation_reversal.already_reversed');
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe('the void surface and the refusal of the direct path', () => {
  it('an invoice with no active reducer is voidable', () => {
    expect(voidPrecondition({ invoiceId: INV, status: 'open', chain: invoiceChain(INV, TOTAL, []) })).toEqual({ voidable: true });
  });

  it('PLANTED — an invoice with active reducers is NOT voidable, and the answer names the reversals NEWEST FIRST', () => {
    const r = voidPrecondition({ invoiceId: INV, status: 'open', chain: fullChain() });
    expect(r.voidable).toBe(false);
    expect(r.voidable === false && r.reverseInThisOrder).toEqual(['alloc-3', 'alloc-2', 'alloc-1']);
  });

  it('PLANTED — a draft and an already-void invoice are each refused by state, not by the chain', () => {
    expect(codeOf(() => voidPrecondition({ invoiceId: INV, status: 'draft', chain: invoiceChain(INV, TOTAL, []) }))).toBe('invoice_void.state_invalid');
    expect(codeOf(() => voidPrecondition({ invoiceId: INV, status: 'void', chain: invoiceChain(INV, TOTAL, []) }))).toBe('invoice_void.state_invalid');
  });

  it('PLANTED — a void checked against a CREDIT chain is refused: an invoice is voided against its own AR chain', () => {
    const credit = creditChain('credit-x', 100n, [{ reducerId: 'app', remainingBeforeMinor: 100n, consumedMinor: 100n, originalEntryId: 'e' }]);
    expect(codeOf(() => voidPrecondition({ invoiceId: INV, status: 'open', chain: credit }))).toBe('invoice_void.state_invalid');
  });

  it('the direct void refusal is stated with its code, what it refuses and where the law lives', () => {
    expect(DIRECT_VOID_IS_REFUSED.refusal).toBe('invoice_void.direct_update_refused');
    expect(isReversalCode(DIRECT_VOID_IS_REFUSED.refusal)).toBe(true);
    expect(DIRECT_VOID_IS_REFUSED.where).toContain('P4-AL-24');
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe('the surface contracts this slice must not invent', () => {
  it('the code union and its array are the same set, and the array is sorted', () => {
    expect([...REVERSAL_CODES]).toEqual([...REVERSAL_CODES].sort());
    expect(new Set(REVERSAL_CODES).size).toBe(REVERSAL_CODES.length);
    for (const c of REVERSAL_CODES) expect(isReversalCode(c)).toBe(true);
    expect(isReversalCode('payment_reversal.nope')).toBe(false);
  });

  it('no S6 code collides with a P4-S4 receivables code namespace', () => {
    for (const c of REVERSAL_CODES) expect(c.startsWith('customer_payment.')).toBe(false);
  });

  it('every S6 operation code satisfies the FROZEN operation-code regex, so no first segment carries an underscore', () => {
    for (const op of REVERSAL_OPERATION_CODES) {
      expect(FROZEN_OPERATION_CODE_PATTERN.test(op)).toBe(true);
      expect(op.split('.')[0]).toMatch(/^[a-z]+$/);
    }
    // The shape P4-AL-28 says was never a candidate.
    expect(FROZEN_OPERATION_CODE_PATTERN.test('payment_reversal.create')).toBe(false);
  });

  it('every permission S6 names is ALREADY one of the registered twelve, and every one of them is SENSITIVE', () => {
    for (const key of Object.values(REVERSAL_OPERATION_AUTHORITY)) {
      expect(PERMISSIONS as readonly string[]).toContain(key);
      expect(SENSITIVE_PERMISSIONS as readonly string[]).toContain(key);
    }
    // A thirteenth key would contradict P4-AL-36; this is the assertion that notices.
    expect((PERMISSIONS as readonly string[]).includes('reversals.approve')).toBe(false);

    // THE READ KEY, which this case used to miss entirely because it iterated
    // the WRITE mapping alone: the reversal read route of the contract pack §5
    // requires `receivables.view`, which no row of REVERSAL_OPERATION_AUTHORITY
    // names. It is registered, and it is NOT sensitive — a read route that
    // demanded a sensitive key would be a quietly different authority model.
    expect(PERMISSIONS as readonly string[]).toContain('receivables.view');
    expect(SENSITIVE_PERMISSIONS as readonly string[]).not.toContain('receivables.view');
  });

  it('the required-wiring record names a patch request per row and leaves no row unowned', () => {
    expect(P4_S6_REQUIRED_WIRING.length).toBeGreaterThan(0);
    for (const row of P4_S6_REQUIRED_WIRING) {
      expect(row.patchRequest).toMatch(/^PATCH-REQ-S6-\d{3}$/);
      expect(row.file.length).toBeGreaterThan(0);
      expect(row.edit.length).toBeGreaterThan(0);
    }
    expect(new Set(P4_S6_REQUIRED_WIRING.map((r) => r.patchRequest)).size).toBe(P4_S6_REQUIRED_WIRING.length);
  });

  it('the wiring registry names EVERY patch request on disk, in BOTH directions', () => {
    // THE DEFECT THIS CASE EXISTS FOR: the registry listed six of the ten patch
    // requests, and the case above could not have noticed, because it walked
    // the registry and checked the shape of what it found — it held the array
    // to itself. A registry that lists six of ten obligations reads as
    // complete. So the claim is now BOTH directions against the directory.
    const dir = path.join(__dirname, '..', '..', '..', 'docs', 'patch-requests');
    const onDisk = fs
      .readdirSync(dir)
      .filter((f) => /^PATCH-REQ-S6-\d{3}\.md$/.test(f))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
    // Non-vacuity: an empty directory would make both assertions below trivial.
    expect(onDisk.length, 'no S6 patch request was found on disk, so this case proves nothing').toBeGreaterThan(0);
    const named = [...P4_S6_REQUIRED_WIRING.map((r) => r.patchRequest)].sort();
    expect(named, 'a patch request exists on disk that the wiring registry does not name').toEqual(onDisk);
  });

  it('this module names no migration number: the real prefix is unknown until the predecessors seal', () => {
    for (const row of P4_S6_REQUIRED_WIRING) expect(row.file).not.toMatch(/\b00\d{2}_/);
  });
});
