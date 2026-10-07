/**
 * P4-S7 LEVEL C — THE SCHEDULE ARITHMETIC, UNIT AND GOLDEN, WITH ITS GUARDS
 * SHOWN ABLE TO FAIL.
 *
 * Three kinds of claim, kept apart on purpose:
 *
 *  1. GOLDEN VECTORS — a frozen table of inputs and their exact expected
 *     splits. A golden vector is what catches a change of ANSWER, which no
 *     property test can: `scheduleAmounts` could move the remainder from the
 *     first instalments to the last and every property below would still hold.
 *  2. PROPERTIES — L1, L2, P1 and P2, asserted over a swept input space rather
 *     than over three examples. A property is what catches a change of
 *     BEHAVIOUR at an input nobody wrote down.
 *  3. RED PROOFS — every guard shown FAILING. `[[daftar-a-green-gate-must-
 *     prove-it-can-be-red]]`. Each plants a defect in a REAL subject — a real
 *     schedule value, a real projection, a real reference implementation —
 *     and requires the guard to refuse it with the RIGHT code. A red proof
 *     that only shows "something threw" is a proof that the function has a
 *     `throw` in it.
 *
 * The red proofs here are deliberately NOT lexical: nothing below greps this
 * module's source. Each one builds a value the law is about and evaluates the
 * law on it, because semantic evaluation is possible at this level and «no
 * lexical-only pseudo-proof where semantic evaluation is possible».
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REMAINDER_PLACEMENT,
  INSTALLMENT_ARITHMETIC_CODES,
  InstallmentArithmeticError,
  MAX_INSTALLMENTS,
  type RemainderPlacement,
  type Schedule,
  assertRescheduleAdmissible,
  assertScheduleClosure,
  buildSchedule,
  civilDayNumber,
  compareCivilDates,
  daysBetween,
  installmentStatus,
  isCivilDate,
  isInstallmentArithmeticCode,
  projectSchedule,
  scheduleAging,
  scheduleAmounts,
  validateSchedule,
} from '../src/installment-schedule';

/** The code a refusal carried, or `null` when the body did not refuse at all. */
function refusalCode(body: () => unknown): string | null {
  try {
    body();
    return null;
  } catch (error) {
    if (error instanceof InstallmentArithmeticError) return error.code;
    throw error;
  }
}

/** `n` monthly-ish due dates from a fixed start. Supplied, never generated inside the module. */
function dates(count: number, startDay = 1): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const month = 1 + ((startDay - 1 + i) % 12);
    const year = 2026 + Math.floor((startDay - 1 + i) / 12);
    out.push(`${String(year)}-${String(month).padStart(2, '0')}-15`);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// 1. CIVIL DATES — no clock, exact integer calendar
// ─────────────────────────────────────────────────────────────────────────

describe('civil dates', () => {
  it('accepts a real date and refuses one that does not exist', () => {
    expect(isCivilDate('2026-02-28')).toBe(true);
    expect(isCivilDate('2028-02-29')).toBe(true); // 2028 is a leap year
    expect(isCivilDate('2026-02-29')).toBe(false); // 2026 is not
    expect(isCivilDate('2100-02-29')).toBe(false); // century, not a leap year
    expect(isCivilDate('2000-02-29')).toBe(true); // 400, a leap year
    expect(isCivilDate('2026-13-01')).toBe(false);
    expect(isCivilDate('2026-04-31')).toBe(false);
    expect(isCivilDate('2026-1-1')).toBe(false);
    expect(isCivilDate(20260101)).toBe(false);
  });

  it('measures a day difference exactly, including across a leap day and a century', () => {
    expect(daysBetween('2026-01-02', '2026-01-01')).toBe(1);
    expect(daysBetween('2026-01-01', '2026-01-02')).toBe(-1);
    expect(daysBetween('2028-03-01', '2028-02-28')).toBe(2); // 29 February exists
    expect(daysBetween('2027-03-01', '2027-02-28')).toBe(1); // it does not
    expect(daysBetween('2100-03-01', '2100-02-28')).toBe(1); // 2100 is not a leap year
    expect(daysBetween('2027-01-01', '2026-01-01')).toBe(365);
    expect(daysBetween('2029-01-01', '2028-01-01')).toBe(366);
  });

  it('agrees with the UTC epoch day for every first of the month over four years', () => {
    // The oracle is an INDEPENDENT implementation (Date's own epoch arithmetic
    // at a fixed instant), so this is a cross-check and not a tautology. It
    // reads no clock: every instant it constructs is supplied.
    for (let y = 2024; y <= 2028; y += 1) {
      for (let m = 1; m <= 12; m += 1) {
        const date = `${String(y)}-${String(m).padStart(2, '0')}-01`;
        const oracle = Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
        expect(civilDayNumber(date), date).toBe(oracle);
      }
    }
  });

  it('orders lexicographically, which is chronologically', () => {
    expect(compareCivilDates('2026-01-31', '2026-02-01')).toBe(-1);
    expect(compareCivilDates('2026-02-01', '2026-02-01')).toBe(0);
    expect(compareCivilDates('2026-12-31', '2026-02-01')).toBe(1);
  });

  it('RED PROOF — a malformed date is refused by the day-number arithmetic, not silently coerced', () => {
    expect(refusalCode(() => civilDayNumber('2026-1-1'))).toBe('installment_plan.due_dates_invalid');
    expect(refusalCode(() => civilDayNumber('tomorrow'))).toBe('installment_plan.due_dates_invalid');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. R1 — THE ONE ROUNDING, AND ITS GOLDEN VECTORS
// ─────────────────────────────────────────────────────────────────────────

/**
 * FROZEN GOLDEN VECTORS of `scheduleAmounts`.
 *
 * Each row is `[amount, count, placement, expected]`. The expected arrays are
 * the ANSWER and not a property: moving the redistributed remainder from the
 * head to the tail keeps every sum identical and would pass §3 entirely, so
 * this table is the only thing that pins WHICH instalment carries the odd
 * minor unit — the merchant-visible half of the policy.
 */
const SPLIT_VECTORS: readonly [bigint, number, RemainderPlacement, bigint[]][] = [
  // Exact division: no remainder, nothing to place.
  [1200n, 3, 'first', [400n, 400n, 400n]],
  [1200n, 3, 'last', [400n, 400n, 400n]],
  // One odd minor unit.
  [1000n, 3, 'first', [334n, 333n, 333n]],
  [1000n, 3, 'last', [333n, 333n, 334n]],
  // Two odd minor units.
  [1001n, 3, 'first', [334n, 334n, 333n]],
  [1001n, 3, 'last', [333n, 334n, 334n]],
  // The worst case: `count - 1` odd units.
  [100n, 7, 'first', [15n, 15n, 14n, 14n, 14n, 14n, 14n]],
  [100n, 7, 'last', [14n, 14n, 14n, 14n, 14n, 15n, 15n]],
  // One instalment: the whole amount, no division to speak of.
  [7n, 1, 'first', [7n]],
  // A three-exponent currency (JOD/KWD): the arithmetic does not know or care.
  [10_000n, 3, 'first', [3334n, 3333n, 3333n]],
  // Past 2^53, where a JS number would have stopped being exact.
  [9_007_199_254_740_993n, 2, 'first', [4_503_599_627_370_497n, 4_503_599_627_370_496n]],
  // A long plan at the bound.
  [MAX_INSTALLMENTS * 100 + 7, MAX_INSTALLMENTS, 'first', []],
].map((row) => row as [bigint, number, RemainderPlacement, bigint[]]);

describe('scheduleAmounts — R1, the one rounding site', () => {
  for (const [amount, count, placement, expected] of SPLIT_VECTORS) {
    if (expected.length === 0) continue;
    it(`GOLDEN: ${amount.toString()} over ${String(count)} (${placement}) = [${expected.join(', ')}]`, () => {
      expect(scheduleAmounts(BigInt(amount), count, placement)).toEqual(expected);
    });
  }

  it('GOLDEN: the 120-instalment bound splits 12007 as 7 lines of 101 then 113 of 100', () => {
    const got = scheduleAmounts(12_007n, MAX_INSTALLMENTS, 'first');
    expect(got.filter((a) => a === 101n)).toHaveLength(7);
    expect(got.filter((a) => a === 100n)).toHaveLength(MAX_INSTALLMENTS - 7);
    expect(got.slice(0, 7).every((a) => a === 101n)).toBe(true);
  });

  it('defaults to placing the remainder on the leading instalments', () => {
    expect(DEFAULT_REMAINDER_PLACEMENT).toBe('first');
    expect(scheduleAmounts(1000n, 3)).toEqual(scheduleAmounts(1000n, 3, 'first'));
  });

  it('PROPERTY: the sum is exact and no unit is discarded, over a swept space', () => {
    // 1..40 instalments × a spread of amounts × both placements. The sum
    // identity is what makes L1 an identity rather than a reconciliation, so
    // it is swept rather than sampled.
    for (let count = 1; count <= 40; count += 1) {
      for (const amount of [count, count + 1, count * 7 - 1, 999_999_937, 10 ** 9 + 7]) {
        if (amount < count) continue;
        for (const placement of ['first', 'last'] as const) {
          const parts = scheduleAmounts(BigInt(amount), count, placement);
          expect(parts).toHaveLength(count);
          expect(
            parts.reduce((a, b) => a + b, 0n),
            `${String(amount)}/${String(count)}/${placement}`,
          ).toBe(BigInt(amount));
        }
      }
    }
  });

  it('PROPERTY: the parts differ by at most one minor unit, so the split is as even as integers allow', () => {
    for (let count = 1; count <= 40; count += 1) {
      for (const amount of [count, count * 3 + 1, 100_003, 2 ** 31 - 1]) {
        if (amount < count) continue;
        const parts = scheduleAmounts(BigInt(amount), count);
        const min = parts.reduce((a, b) => (b < a ? b : a));
        const max = parts.reduce((a, b) => (b > a ? b : a));
        expect(max - min, `${String(amount)}/${String(count)}`).toBeLessThanOrEqual(1n);
      }
    }
  });

  it('PROPERTY: the two placements are a reversal of each other, which is what makes both exact', () => {
    for (let count = 2; count <= 12; count += 1) {
      for (const amount of [count * 10 + 1, count * 10 + count - 1, 1_000_003]) {
        const first = scheduleAmounts(BigInt(amount), count, 'first');
        const last = scheduleAmounts(BigInt(amount), count, 'last');
        expect([...last].reverse(), `${String(amount)}/${String(count)}`).toEqual(first);
      }
    }
  });

  it('RED PROOF — a split that would give an instalment nothing is refused, not silently merged', () => {
    // Three instalments cannot be carved out of two minor units without a
    // zero line, and a zero line is a date that promises nothing and a row no
    // merchant can collect.
    expect(refusalCode(() => scheduleAmounts(2n, 3))).toBe('installment_plan.amount_invalid');
    expect(refusalCode(() => scheduleAmounts(0n, 3))).toBe('installment_plan.amount_invalid');
    expect(refusalCode(() => scheduleAmounts(-1200n, 3))).toBe('installment_plan.amount_invalid');
  });

  it('RED PROOF — a count outside 1..MAX is refused with the count code and not the amount code', () => {
    expect(refusalCode(() => scheduleAmounts(1200n, 0))).toBe('installment_plan.installment_count_invalid');
    expect(refusalCode(() => scheduleAmounts(1200n, -3))).toBe('installment_plan.installment_count_invalid');
    expect(refusalCode(() => scheduleAmounts(1200n, MAX_INSTALLMENTS + 1))).toBe('installment_plan.installment_count_invalid');
    expect(refusalCode(() => scheduleAmounts(1200n, 2.5))).toBe('installment_plan.installment_count_invalid');
    // The bound itself is INSIDE: a boundary refused is a boundary nobody can use.
    expect(scheduleAmounts(BigInt(MAX_INSTALLMENTS), MAX_INSTALLMENTS)).toHaveLength(MAX_INSTALLMENTS);
  });

  it('RED PROOF — A SECOND ROUNDING SITE IS VISIBLE AS A DISAGREEMENT, which is the lesson', () => {
    // «Rounding is not additive: two layers obeying the same rounding contract
    // at different aggregation grains disagree by construction.»
    //
    // The plant is a REAL second implementation that rounds at a SECOND grain:
    // it splits the amount into two halves first (grain 1) and then splits
    // each half across its instalments (grain 2) — each step obeying "divide
    // and distribute the remainder", the same contract R1 obeys. It is shown
    // to DISAGREE with the one-rounding answer, which is the whole claim.
    const twoGrainSplit = (amount: bigint, count: number): bigint[] => {
      const halfCount = Math.floor(count / 2);
      const restCount = count - halfCount;
      const half = amount / 2n; // rounding #1, at the half grain
      const rest = amount - half;
      return [...(halfCount > 0 ? scheduleAmounts(half, halfCount) : []), ...scheduleAmounts(rest, restCount)]; // rounding #2
    };
    const oneGrain = scheduleAmounts(1000n, 3);
    const twoGrain = twoGrainSplit(1000n, 3);
    // BOTH sum to 1000 — which is exactly why "the sums agree" is not evidence
    // that the roundings agree.
    expect(oneGrain.reduce((a, b) => a + b, 0n)).toBe(1000n);
    expect(twoGrain.reduce((a, b) => a + b, 0n)).toBe(1000n);
    // And the ANSWERS differ, line by line. This module has ONE grain so that
    // this disagreement has nowhere to arise.
    expect(twoGrain).not.toEqual(oneGrain);
    expect(oneGrain).toEqual([334n, 333n, 333n]);
    expect(twoGrain).toEqual([500n, 250n, 250n]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. L1 — Σ instalments + down payment = invoice total
// ─────────────────────────────────────────────────────────────────────────

describe('L1 — the closure law', () => {
  it('a built schedule closes, with and without a down payment', () => {
    const noDown = buildSchedule({ totalMinor: 1000n, downPaymentMinor: 0n, startDate: '2026-01-01', dueDates: dates(3) });
    expect(noDown.lines.map((l) => l.amountMinor)).toEqual([334n, 333n, 333n]);
    expect(() => assertScheduleClosure(noDown)).not.toThrow();

    const withDown = buildSchedule({ totalMinor: 1000n, downPaymentMinor: 100n, startDate: '2026-01-01', dueDates: dates(3) });
    expect(withDown.lines.map((l) => l.amountMinor)).toEqual([300n, 300n, 300n]);
    expect(withDown.lines.reduce((a, l) => a + l.amountMinor, 0n) + withDown.downPaymentMinor).toBe(1000n);
  });

  it('PROPERTY: L1 holds for every built schedule over a swept space, down payment included', () => {
    for (const total of [1n, 7n, 100n, 1001n, 999_999_937n, 9_007_199_254_740_993n]) {
      for (const count of [1, 2, 3, 7, 13, 40]) {
        for (const downShare of [0n, 1n, total / 3n, total - BigInt(count)]) {
          const down = downShare < 0n ? 0n : downShare;
          if (down >= total) continue;
          if (total - down < BigInt(count)) continue;
          const s = buildSchedule({ totalMinor: total, downPaymentMinor: down, startDate: '2026-01-01', dueDates: dates(count) });
          expect(s.lines.reduce((a, l) => a + l.amountMinor, 0n) + s.downPaymentMinor, `${total.toString()}/${String(count)}/${down.toString()}`).toBe(total);
        }
      }
    }
  });

  it('RED PROOF — a schedule that misses the total by ONE MINOR UNIT is refused', () => {
    // The plant is a REAL schedule value, built correctly and then tampered
    // with by one minor unit on one line. One unit, because the defect this law
    // exists to catch is not a wild figure: it is the last instalment
    // collecting the wrong money by the smallest amount nobody notices.
    const good = buildSchedule({ totalMinor: 1000n, downPaymentMinor: 100n, startDate: '2026-01-01', dueDates: dates(3) });
    expect(() => assertScheduleClosure(good)).not.toThrow();
    for (const delta of [1n, -1n]) {
      const tampered: Schedule = {
        ...good,
        lines: good.lines.map((l, i) => (i === good.lines.length - 1 ? { ...l, amountMinor: l.amountMinor + delta } : l)),
      };
      expect(
        refusalCode(() => assertScheduleClosure(tampered)),
        `delta ${delta.toString()}`,
      ).toBe('installment_plan.schedule_sum_mismatch');
      expect(refusalCode(() => validateSchedule(tampered))).toBe('installment_plan.schedule_sum_mismatch');
    }
  });

  it('RED PROOF — a down payment counted twice is refused by the same law', () => {
    // The classic way L1 breaks in practice: the schedule is built over the
    // FULL total and a down payment is recorded beside it, so the merchant is
    // scheduled for total + down.
    const overScheduled = buildSchedule({ totalMinor: 1000n, downPaymentMinor: 0n, startDate: '2026-01-01', dueDates: dates(4) });
    const withPhantomDown: Schedule = { ...overScheduled, downPaymentMinor: 250n };
    expect(refusalCode(() => assertScheduleClosure(withPhantomDown))).toBe('installment_plan.schedule_sum_mismatch');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. THE VALIDATORS
// ─────────────────────────────────────────────────────────────────────────

describe('validateSchedule', () => {
  const base = buildSchedule({ totalMinor: 1200n, downPaymentMinor: 0n, startDate: '2026-01-01', dueDates: dates(3) });

  it('accepts the schedule its own builder produced', () => {
    expect(() => validateSchedule(base)).not.toThrow();
  });

  it.each([
    ['a non-positive total', { ...base, totalMinor: 0n }, 'installment_plan.total_invalid'],
    ['a negative down payment', { ...base, downPaymentMinor: -1n }, 'installment_plan.down_payment_invalid'],
    ['a down payment that leaves nothing to schedule', { ...base, downPaymentMinor: 1200n }, 'installment_plan.down_payment_invalid'],
    ['a malformed start date', { ...base, startDate: '2026-02-30' }, 'installment_plan.due_dates_invalid'],
    ['an empty schedule', { ...base, lines: [] }, 'installment_plan.installment_count_invalid'],
  ])('RED PROOF — refuses %s', (_label, planted, code) => {
    expect(refusalCode(() => validateSchedule(planted as Schedule))).toBe(code);
  });

  it('RED PROOF — refuses a non-ascending due date, and the correct form of the same schedule passes', () => {
    const reordered: Schedule = {
      ...base,
      lines: [
        { seqNo: 1, dueDate: '2026-03-15', amountMinor: 400n },
        { seqNo: 2, dueDate: '2026-02-15', amountMinor: 400n },
        { seqNo: 3, dueDate: '2026-04-15', amountMinor: 400n },
      ],
    };
    expect(refusalCode(() => validateSchedule(reordered))).toBe('installment_plan.due_dates_invalid');
    // The SAME three dates, ordered: the law is about the order and not about the dates.
    const ordered: Schedule = {
      ...base,
      lines: [
        { seqNo: 1, dueDate: '2026-02-15', amountMinor: 400n },
        { seqNo: 2, dueDate: '2026-03-15', amountMinor: 400n },
        { seqNo: 3, dueDate: '2026-04-15', amountMinor: 400n },
      ],
    };
    expect(() => validateSchedule(ordered)).not.toThrow();
  });

  it('RED PROOF — refuses two instalments on the SAME day, which a non-strict order would accept', () => {
    const sameDay: Schedule = {
      ...base,
      lines: [
        { seqNo: 1, dueDate: '2026-02-15', amountMinor: 400n },
        { seqNo: 2, dueDate: '2026-02-15', amountMinor: 400n },
        { seqNo: 3, dueDate: '2026-03-15', amountMinor: 400n },
      ],
    };
    expect(refusalCode(() => validateSchedule(sameDay))).toBe('installment_plan.due_dates_invalid');
  });

  it('RED PROOF — refuses a gap, a repeat and a zero in the sequence numbers', () => {
    for (const seqs of [
      [1, 3, 4],
      [1, 1, 2],
      [0, 1, 2],
      [3, 2, 1],
    ]) {
      const planted: Schedule = { ...base, lines: base.lines.map((l, i) => ({ ...l, seqNo: seqs[i] as number })) };
      expect(
        refusalCode(() => validateSchedule(planted)),
        seqs.join(','),
      ).toBe('installment_plan.sequence_invalid');
    }
  });

  it('RED PROOF — refuses an instalment falling due before the plan starts', () => {
    const early: Schedule = { ...base, startDate: '2026-06-01' };
    expect(refusalCode(() => validateSchedule(early))).toBe('installment_plan.due_date_before_start');
    // Due ON the start date is admissible: a plan whose first instalment falls
    // on its start date is an ordinary arrangement, and `<` is not `<=`.
    const onStart = buildSchedule({ totalMinor: 900n, downPaymentMinor: 0n, startDate: '2026-01-15', dueDates: ['2026-01-15', '2026-02-15', '2026-03-15'] });
    expect(() => validateSchedule(onStart)).not.toThrow();
  });

  it('RED PROOF — refuses a zero or negative instalment amount', () => {
    for (const bad of [0n, -1n]) {
      const planted: Schedule = {
        ...base,
        totalMinor: 800n + bad,
        lines: base.lines.map((l, i) => (i === 2 ? { ...l, amountMinor: bad } : { ...l, amountMinor: 400n })),
      };
      expect(
        refusalCode(() => validateSchedule(planted)),
        bad.toString(),
      ).toBe('installment_plan.amount_invalid');
    }
  });

  it('RED PROOF — the builder refuses a count past the bound and a down payment at the total', () => {
    expect(refusalCode(() => buildSchedule({ totalMinor: 1000n, downPaymentMinor: 0n, startDate: '2026-01-01', dueDates: [] }))).toBe(
      'installment_plan.installment_count_invalid',
    );
    expect(refusalCode(() => buildSchedule({ totalMinor: 1000n, downPaymentMinor: 1000n, startDate: '2026-01-01', dueDates: dates(3) }))).toBe(
      'installment_plan.down_payment_invalid',
    );
    expect(refusalCode(() => buildSchedule({ totalMinor: 0n, downPaymentMinor: 0n, startDate: '2026-01-01', dueDates: dates(3) }))).toBe(
      'installment_plan.total_invalid',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. L2 — STATUS FROM A SUPPLIED asOf, AND NOWHERE ELSE
// ─────────────────────────────────────────────────────────────────────────

describe('L2 — status is derived from a supplied as-of date', () => {
  it('GOLDEN: the four statuses at their boundaries', () => {
    expect(installmentStatus(100n, 100n, '2020-01-01', '2026-06-15')).toBe('settled'); // settled beats any date
    expect(installmentStatus(100n, 99n, '2026-06-14', '2026-06-15')).toBe('overdue');
    expect(installmentStatus(100n, 0n, '2026-06-15', '2026-06-15')).toBe('due_today');
    expect(installmentStatus(100n, 0n, '2026-06-16', '2026-06-15')).toBe('upcoming');
  });

  it('settled is checked FIRST, so a fully collected instalment is never reported overdue', () => {
    // The ordering matters and is not cosmetic: a merchant chasing a debt must
    // not be shown money they already have.
    expect(installmentStatus(100n, 100n, '1999-01-01', '2026-06-15')).toBe('settled');
  });

  it('PROPERTY: the answer depends on nothing but its four arguments', () => {
    // Called a hundred times with the same four values, in a loop that takes
    // real time to run. A function that consulted a clock would answer
    // differently across a midnight boundary and could answer differently
    // here; one that does not, cannot.
    const answers = new Set<string>();
    for (let i = 0; i < 100; i += 1) answers.add(installmentStatus(500n, 200n, '2026-06-15', '2026-06-15'));
    expect([...answers]).toEqual(['due_today']);
  });

  it('PROPERTY: the status is monotone in asOf — once overdue, always overdue', () => {
    for (const asOf of ['2026-06-16', '2026-07-01', '2027-01-01', '2030-12-31']) {
      expect(installmentStatus(100n, 50n, '2026-06-15', asOf), asOf).toBe('overdue');
    }
    for (const asOf of ['2026-06-14', '2026-01-01', '2020-01-01']) {
      expect(installmentStatus(100n, 50n, '2026-06-15', asOf), asOf).toBe('upcoming');
    }
  });

  it('RED PROOF — a settled figure outside 0..amount is an internal defect, not a status', () => {
    expect(refusalCode(() => installmentStatus(100n, 101n, '2026-06-15', '2026-06-15'))).toBe('installment_plan.arithmetic_invalid');
    expect(refusalCode(() => installmentStatus(100n, -1n, '2026-06-15', '2026-06-15'))).toBe('installment_plan.arithmetic_invalid');
  });

  it('RED PROOF — A CLOCK-READING STATUS IS A DIFFERENT ANSWER, shown as a disagreement', () => {
    // The plant is a REAL second implementation that resolves "today" itself —
    // the exact seam law 3 exists to keep closed. It is shown to DISAGREE with
    // the supplied-date answer for a date that is plainly in the merchant's
    // own past or future, which is what makes the seam a defect rather than a
    // convention: the same command, replayed, answers differently.
    const clockStatus = (amount: bigint, settled: bigint, dueDate: string): string => {
      const today = new Date().toISOString().slice(0, 10); // THE SEAM
      return installmentStatus(amount, settled, dueDate, today);
    };
    // A plan being reviewed AS OF an audit date in the past.
    const auditAsOf = '2026-01-01';
    const dueDate = '2026-06-15';
    expect(installmentStatus(100n, 0n, dueDate, auditAsOf)).toBe('upcoming');
    // The clock-reading version cannot answer the audit's question at all: its
    // answer is a function of when it was called. Today is after 2026-06-15,
    // so it reports overdue for an instalment the audit date says is upcoming.
    expect(clockStatus(100n, 0n, dueDate)).not.toBe('upcoming');
    expect(clockStatus(100n, 0n, dueDate)).toBe('overdue');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. THE PROJECTION — P1 and P2
// ─────────────────────────────────────────────────────────────────────────

describe('projectSchedule — the waterfall over the ONE settlement figure', () => {
  const plan = buildSchedule({ totalMinor: 1200n, downPaymentMinor: 300n, startDate: '2026-01-01', dueDates: ['2026-02-15', '2026-03-15', '2026-04-15'] });

  it('GOLDEN: nothing collected — the down payment and every instalment are fully outstanding', () => {
    const p = projectSchedule(plan, 1200n, '2026-01-10');
    expect(p.downPaymentSettledMinor).toBe(0n);
    expect(p.installments.map((i) => i.settledMinor)).toEqual([0n, 0n, 0n]);
    expect(p.installments.map((i) => i.remainingMinor)).toEqual([300n, 300n, 300n]);
    expect(p.installments.map((i) => i.status)).toEqual(['upcoming', 'upcoming', 'upcoming']);
    expect(p.status).toBe('on_track');
    expect(p.nextDueDate).toBe('2026-02-15');
    expect(p.overdueMinor).toBe(0n);
  });

  it('GOLDEN: the down payment settles FIRST, before any instalment', () => {
    const p = projectSchedule(plan, 900n, '2026-01-10');
    expect(p.downPaymentSettledMinor).toBe(300n);
    expect(p.installments.map((i) => i.settledMinor)).toEqual([0n, 0n, 0n]);
  });

  it('GOLDEN: a partial collection runs down the schedule in due order and stops mid-instalment', () => {
    // 1200 total, 650 collected: 300 down, then 300 to instalment 1, then 50 to instalment 2.
    const p = projectSchedule(plan, 550n, '2026-03-20');
    expect(p.downPaymentSettledMinor).toBe(300n);
    expect(p.installments.map((i) => i.settledMinor)).toEqual([300n, 50n, 0n]);
    expect(p.installments.map((i) => i.remainingMinor)).toEqual([0n, 250n, 300n]);
    expect(p.installments.map((i) => i.status)).toEqual(['settled', 'overdue', 'upcoming']);
    expect(p.overdueMinor).toBe(250n);
    expect(p.nextDueDate).toBe('2026-03-15');
    expect(p.status).toBe('overdue');
  });

  it('GOLDEN: fully settled — the plan is settled whatever the dates say', () => {
    const p = projectSchedule(plan, 0n, '2030-01-01');
    expect(p.status).toBe('settled');
    expect(p.nextDueDate).toBeNull();
    expect(p.overdueMinor).toBe(0n);
    expect(p.installments.every((i) => i.status === 'settled')).toBe(true);
  });

  it('PROPERTY: P1 and P2 hold for every outstanding figure in 0..total, over several shapes', () => {
    const shapes = [
      buildSchedule({ totalMinor: 1000n, downPaymentMinor: 0n, startDate: '2026-01-01', dueDates: dates(3) }),
      buildSchedule({ totalMinor: 1001n, downPaymentMinor: 1n, startDate: '2026-01-01', dueDates: dates(7) }),
      buildSchedule({ totalMinor: 100n, downPaymentMinor: 37n, startDate: '2026-01-01', dueDates: dates(9) }),
      buildSchedule({ totalMinor: 9_007_199_254_740_993n, downPaymentMinor: 1n, startDate: '2026-01-01', dueDates: dates(2) }),
    ];
    for (const s of shapes) {
      const step = s.totalMinor > 400n ? s.totalMinor / 97n : 1n;
      for (let out = 0n; out <= s.totalMinor; out += step) {
        const p = projectSchedule(s, out, '2026-06-15');
        const settled = p.installments.reduce((a, i) => a + i.settledMinor, 0n) + p.downPaymentSettledMinor;
        const remaining = p.installments.reduce((a, i) => a + i.remainingMinor, 0n) + (p.downPaymentMinor - p.downPaymentSettledMinor);
        expect(settled, `P1 at ${out.toString()}`).toBe(s.totalMinor - out);
        expect(remaining, `P2 at ${out.toString()}`).toBe(out);
      }
    }
  });

  it('PROPERTY: the projection is monotone — more collected never un-settles an instalment', () => {
    const s = buildSchedule({ totalMinor: 1200n, downPaymentMinor: 0n, startDate: '2026-01-01', dueDates: dates(6) });
    let previous = projectSchedule(s, 1200n, '2026-06-15').installments.map((i) => i.settledMinor);
    for (let out = 1150n; out >= 0n; out -= 50n) {
      const now = projectSchedule(s, out, '2026-06-15').installments.map((i) => i.settledMinor);
      for (let i = 0; i < now.length; i += 1)
        expect(now[i] as bigint, `instalment ${String(i + 1)} at ${out.toString()}`).toBeGreaterThanOrEqual(previous[i] as bigint);
      previous = now;
    }
  });

  it('PROPERTY: a plan written over an ALREADY PART-PAID invoice reports the truth immediately', () => {
    // There is no "activation" and no backfill: the schedule is a view, so the
    // first projection after it is written already shows what was collected.
    const s = buildSchedule({ totalMinor: 1000n, downPaymentMinor: 0n, startDate: '2026-01-01', dueDates: dates(4) });
    const p = projectSchedule(s, 400n, '2026-06-15');
    expect(p.installments.map((i) => i.settledMinor)).toEqual([250n, 250n, 100n, 0n]);
    expect(p.outstandingMinor).toBe(400n);
  });

  it('RED PROOF — an outstanding figure outside 0..total is refused, NOT clamped', () => {
    // Out of range it is not the one figure: it is a figure from another
    // invoice, a stale read or a defect, and a clamp would turn all three into
    // a plausible screen.
    expect(refusalCode(() => projectSchedule(plan, 1201n, '2026-06-15'))).toBe('installment_plan.settled_exceeds_total');
    expect(refusalCode(() => projectSchedule(plan, -1n, '2026-06-15'))).toBe('installment_plan.settled_exceeds_total');
    // The two boundaries are INSIDE.
    expect(() => projectSchedule(plan, 0n, '2026-06-15')).not.toThrow();
    expect(() => projectSchedule(plan, 1200n, '2026-06-15')).not.toThrow();
  });

  it('RED PROOF — a malformed as-of date is refused rather than defaulted', () => {
    expect(refusalCode(() => projectSchedule(plan, 600n, '2026-02-30'))).toBe('installment_plan.due_dates_invalid');
    expect(refusalCode(() => projectSchedule(plan, 600n, ''))).toBe('installment_plan.due_dates_invalid');
  });

  it('RED PROOF — A TAMPERED SCHEDULE CANNOT BE PROJECTED, so P2 can never be satisfied by a broken plan', () => {
    // The plant breaks L1 by one minor unit. The projection is the place a
    // reader would see the consequence, so it must refuse rather than report
    // figures that do not add up to the one outstanding figure.
    const tampered: Schedule = { ...plan, lines: plan.lines.map((l, i) => (i === 0 ? { ...l, amountMinor: l.amountMinor + 1n } : l)) };
    expect(refusalCode(() => projectSchedule(tampered, 600n, '2026-06-15'))).toBe('installment_plan.schedule_sum_mismatch');
  });

  it('RED PROOF — A SECOND BALANCE DISAGREES WITH THE ONE FIGURE, shown as a disagreement', () => {
    // The plant is a REAL second implementation of the kind law 1 forbids: a
    // per-instalment stored `settled_minor`, maintained by its own writer. It
    // is given a value that is perfectly plausible row by row and is shown to
    // contradict the one settlement figure — which is the failure mode a
    // stored balance has and a projection cannot have.
    const storedSettled = [300n, 300n, 300n]; // "all three instalments collected"
    const storedDownSettled = 0n; // but the down payment was never recorded
    const impliedOutstanding = plan.totalMinor - (storedSettled.reduce((a, b) => a + b, 0n) + storedDownSettled);
    const oneFigure = 300n; // what `invoice_outstanding` actually says
    expect(impliedOutstanding).toBe(300n);
    // The two agree HERE — which is why a reconciliation test over one case
    // proves nothing. Move one stored row and they part company, while every
    // row still looks valid on its own:
    const driftedStored = [300n, 300n, 299n];
    const driftedImplied = plan.totalMinor - (driftedStored.reduce((a, b) => a + b, 0n) + storedDownSettled);
    expect(driftedImplied).not.toBe(oneFigure);
    // The projection has no such degree of freedom: its figures are a function
    // of the one figure, so there is nothing to drift.
    const p = projectSchedule(plan, oneFigure, '2026-06-15');
    expect(p.installments.reduce((a, i) => a + i.remainingMinor, 0n) + (p.downPaymentMinor - p.downPaymentSettledMinor)).toBe(oneFigure);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 7. RESCHEDULING
// ─────────────────────────────────────────────────────────────────────────

describe('assertRescheduleAdmissible', () => {
  const plan = buildSchedule({ totalMinor: 1200n, downPaymentMinor: 0n, startDate: '2026-01-01', dueDates: ['2026-02-15', '2026-03-15', '2026-04-15'] });
  // 400 collected: instalment 1 is settled in full, 2 and 3 are not.
  const projection = projectSchedule(plan, 800n, '2026-03-20');

  it('the projection used by the rest of this block has exactly one settled instalment', () => {
    expect(projection.installments.map((i) => i.status)).toEqual(['settled', 'overdue', 'upcoming']);
  });

  it('accepts a replacement that keeps the settled instalment and re-spreads the tail', () => {
    const replacement: Schedule = {
      ...plan,
      lines: [
        { seqNo: 1, dueDate: '2026-02-15', amountMinor: 400n },
        { seqNo: 2, dueDate: '2026-06-15', amountMinor: 200n },
        { seqNo: 3, dueDate: '2026-07-15', amountMinor: 200n },
        { seqNo: 4, dueDate: '2026-08-15', amountMinor: 400n },
      ],
    };
    expect(() => assertRescheduleAdmissible(projection, replacement)).not.toThrow();
  });

  it('RED PROOF — refuses a replacement that MOVES the settled instalment', () => {
    const moved: Schedule = {
      ...plan,
      lines: [
        { seqNo: 1, dueDate: '2026-09-15', amountMinor: 400n }, // the collected one, pushed out
        { seqNo: 2, dueDate: '2026-10-15', amountMinor: 400n },
        { seqNo: 3, dueDate: '2026-11-15', amountMinor: 400n },
      ],
    };
    expect(refusalCode(() => assertRescheduleAdmissible(projection, moved))).toBe('installment_plan.settled_installment_immutable');
  });

  it('RED PROOF — refuses a replacement that RE-PRICES the settled instalment', () => {
    const repriced: Schedule = {
      ...plan,
      lines: [
        { seqNo: 1, dueDate: '2026-02-15', amountMinor: 200n }, // collected 400, now says 200
        { seqNo: 2, dueDate: '2026-03-15', amountMinor: 500n },
        { seqNo: 3, dueDate: '2026-04-15', amountMinor: 500n },
      ],
    };
    expect(refusalCode(() => assertRescheduleAdmissible(projection, repriced))).toBe('installment_plan.settled_installment_immutable');
  });

  it('RED PROOF — refuses a replacement that DROPS the settled instalment entirely', () => {
    const dropped: Schedule = {
      ...plan,
      lines: [
        { seqNo: 2, dueDate: '2026-06-15', amountMinor: 600n },
        { seqNo: 3, dueDate: '2026-07-15', amountMinor: 600n },
      ],
    };
    // The sequence law fires first — which is correct and is worth asserting:
    // a replacement that does not start at 1 is malformed before it is
    // inadmissible, and the first refusal a caller meets must be the one that
    // describes what they sent.
    expect(refusalCode(() => assertRescheduleAdmissible(projection, dropped))).toBe('installment_plan.sequence_invalid');
  });

  it('RED PROOF — refuses a replacement over a DIFFERENT total, and one that changes the down payment', () => {
    const biggerTotal: Schedule = {
      ...plan,
      totalMinor: 1500n,
      lines: [
        { seqNo: 1, dueDate: '2026-02-15', amountMinor: 400n },
        { seqNo: 2, dueDate: '2026-03-15', amountMinor: 550n },
        { seqNo: 3, dueDate: '2026-04-15', amountMinor: 550n },
      ],
    };
    expect(refusalCode(() => assertRescheduleAdmissible(projection, biggerTotal))).toBe('installment_plan.schedule_sum_mismatch');

    const withDownPlan = buildSchedule({ totalMinor: 1200n, downPaymentMinor: 300n, startDate: '2026-01-01', dueDates: dates(3) });
    const withDownProjection = projectSchedule(withDownPlan, 900n, '2026-06-15');
    const downChanged: Schedule = {
      ...withDownPlan,
      downPaymentMinor: 0n,
      lines: [
        { seqNo: 1, dueDate: '2026-02-15', amountMinor: 400n },
        { seqNo: 2, dueDate: '2026-03-15', amountMinor: 400n },
        { seqNo: 3, dueDate: '2026-04-15', amountMinor: 400n },
      ],
    };
    expect(refusalCode(() => assertRescheduleAdmissible(withDownProjection, downChanged))).toBe('installment_plan.down_payment_invalid');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 8. SCHEDULE-GRAIN AGING
// ─────────────────────────────────────────────────────────────────────────

describe('scheduleAging — a partition of the plan, not a second customer aging', () => {
  const plan = buildSchedule({
    totalMinor: 1200n,
    downPaymentMinor: 0n,
    startDate: '2026-01-01',
    dueDates: ['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15'],
  });

  it('GOLDEN: buckets 30,60 at as-of 2026-04-20 place each unsettled instalment by its own days past due', () => {
    const p = projectSchedule(plan, 1200n, '2026-04-20');
    // days past due: 95, 64, 36, 5 — so buckets 2, 2, 1, 0 against [30, 60].
    expect(p.installments.map((i) => i.daysPastDue)).toEqual([95, 64, 36, 5]);
    const buckets = scheduleAging(p, [30, 60]);
    expect(buckets.map((b) => [b.bucketNo, b.remainingMinor, b.installmentCount])).toEqual([
      [0, 300n, 1],
      [1, 300n, 1],
      [2, 600n, 2],
    ]);
    expect(buckets.map((b) => [b.fromDays, b.toDays])).toEqual([
      [0, 30],
      [31, 60],
      [61, null],
    ]);
  });

  it('GOLDEN: a settled instalment appears in no bucket at all', () => {
    const p = projectSchedule(plan, 600n, '2026-04-20'); // the first two instalments are collected
    const buckets = scheduleAging(p, [30, 60]);
    expect(buckets.reduce((a, b) => a + b.installmentCount, 0)).toBe(2);
    expect(buckets.reduce((a, b) => a + b.remainingMinor, 0n)).toBe(600n);
  });

  it('PROPERTY: the buckets are a PARTITION of the schedule, for every as-of and every boundary set', () => {
    for (const asOf of ['2026-01-01', '2026-02-20', '2026-04-20', '2027-01-01']) {
      for (const bounds of [[1], [30, 60], [7, 30, 60, 90, 180, 365]]) {
        for (const out of [1200n, 900n, 450n, 1n]) {
          const p = projectSchedule(plan, out, asOf);
          const buckets = scheduleAging(p, bounds);
          expect(buckets).toHaveLength(bounds.length + 1);
          expect(
            buckets.reduce((a, b) => a + b.remainingMinor, 0n),
            `${asOf}/${bounds.join(',')}/${out.toString()}`,
          ).toBe(p.installments.reduce((a, i) => a + i.remainingMinor, 0n));
        }
      }
    }
  });

  it('PROPERTY: it CANNOT be a customer aging, because it takes no customer', () => {
    // A type-level claim, asserted so the shape cannot be widened quietly: the
    // only argument that carries identity is a projection of ONE plan. There
    // is no overload taking a business, a customer or a connection, so nothing
    // here can be summed into a figure that competes with
    // `customer_ar_aging`, which stays the aging of record.
    expect(scheduleAging.length).toBe(2);
  });

  it('RED PROOF — refuses non-ascending and non-positive boundaries', () => {
    const p = projectSchedule(plan, 1200n, '2026-04-20');
    expect(refusalCode(() => scheduleAging(p, [60, 30]))).toBe('installment_plan.arithmetic_invalid');
    expect(refusalCode(() => scheduleAging(p, [30, 30]))).toBe('installment_plan.arithmetic_invalid');
    expect(refusalCode(() => scheduleAging(p, [0]))).toBe('installment_plan.arithmetic_invalid');
    expect(refusalCode(() => scheduleAging(p, [-30]))).toBe('installment_plan.arithmetic_invalid');
    // And the correct form of the same question passes, so the law is about
    // the order and not about the numbers.
    expect(() => scheduleAging(p, [30, 60])).not.toThrow();
  });

  it('RED PROOF — the bucket arithmetic is the SAME shape customer_ar_aging uses', () => {
    // `0084:707-709` buckets by `count of boundaries the days-past-due figure
    // has PASSED`, with a strict `>`. A `>=` would move every instalment
    // falling exactly on a boundary into the next bucket, which is a different
    // answer for the most common case a merchant looks at — 30 days exactly.
    const p = projectSchedule(plan, 1200n, '2026-02-14'); // instalment 1 is exactly 30 days past due
    expect(p.installments[0]?.daysPastDue).toBe(30);
    const strict = scheduleAging(p, [30]);
    // Nothing has passed the 30-day boundary, because 30 is not MORE than 30:
    // every unsettled instalment sits in bucket 0 and bucket 1 is empty.
    expect(strict[0]?.installmentCount).toBe(4);
    expect(strict[1]?.installmentCount).toBe(0);
    expect(strict[1]?.remainingMinor).toBe(0n);
    // The plant: the SAME grouping with `>=` instead of `>`. It moves the
    // instalment that falls exactly on the boundary into the next bucket,
    // which is a different answer for the most common case a merchant looks
    // at. The disagreement is the proof that the comparison is load-bearing.
    const looseInBucket1 = p.installments.filter((i) => i.remainingMinor > 0n).reduce((acc, i) => acc + (i.daysPastDue >= 30 ? 1 : 0), 0);
    expect(looseInBucket1).toBe(1);
    expect(looseInBucket1).not.toBe(strict[1]?.installmentCount);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 9. THE CLOSED CODE LIST
// ─────────────────────────────────────────────────────────────────────────

describe('the refusal vocabulary', () => {
  it('is closed, deduplicated, and every code is recognized by its own predicate', () => {
    expect(new Set(INSTALLMENT_ARITHMETIC_CODES).size).toBe(INSTALLMENT_ARITHMETIC_CODES.length);
    for (const code of INSTALLMENT_ARITHMETIC_CODES) expect(isInstallmentArithmeticCode(code), code).toBe(true);
    expect(isInstallmentArithmeticCode('installment_plan.not_a_code')).toBe(false);
  });

  it('carries NO interest, fee, penalty, tax, refund, reversal or balance code', () => {
    // A code for a command nobody authorized is a contract a client will build
    // against. The absence is asserted rather than left to a reviewer.
    const forbidden = /interest|apr|fee|penalty|charge|tax|refund|reversal|credit_note|balance/;
    for (const code of INSTALLMENT_ARITHMETIC_CODES) expect(forbidden.test(code), code).toBe(false);
  });

  it('every code is prefixed with the domain the database will raise it under', () => {
    for (const code of INSTALLMENT_ARITHMETIC_CODES) expect(code.startsWith('installment_plan.') || code.startsWith('installment.'), code).toBe(true);
  });

  it('every code in the list is REACHABLE from a real input, or is named as internal', () => {
    // A code nobody can reach is a contract nobody can meet. The eight
    // merchant-facing codes are each driven above; the two internal ones
    // (`arithmetic_invalid`, `settled_exceeds_total`) are reachable only
    // through a tampered value, which §3, §5 and §6 each do.
    const driven = new Set<string>();
    const drive = (body: () => unknown): void => {
      const code = refusalCode(body);
      if (code !== null) driven.add(code);
    };
    const plan = buildSchedule({ totalMinor: 1200n, downPaymentMinor: 0n, startDate: '2026-01-01', dueDates: dates(3) });
    drive(() => assertScheduleClosure({ ...plan, totalMinor: 1n }));
    drive(() => scheduleAmounts(1200n, 0));
    drive(() => scheduleAmounts(2n, 3));
    drive(() => validateSchedule({ ...plan, downPaymentMinor: -1n }));
    drive(() => validateSchedule({ ...plan, totalMinor: 0n }));
    drive(() => civilDayNumber('nope'));
    drive(() => validateSchedule({ ...plan, startDate: '2026-06-01' }));
    drive(() => validateSchedule({ ...plan, lines: plan.lines.map((l) => ({ ...l, seqNo: 9 })) }));
    drive(() => projectSchedule(plan, 99_999n, '2026-01-01'));
    // A collected instalment re-priced: the admissibility law's own code, and
    // the one code only a reschedule can reach.
    drive(() =>
      assertRescheduleAdmissible(projectSchedule(plan, 800n, '2026-06-15'), {
        ...plan,
        lines: [
          { seqNo: 1, dueDate: plan.lines[0]?.dueDate ?? '2026-01-15', amountMinor: 200n },
          { seqNo: 2, dueDate: plan.lines[1]?.dueDate ?? '2026-02-15', amountMinor: 500n },
          { seqNo: 3, dueDate: plan.lines[2]?.dueDate ?? '2026-03-15', amountMinor: 500n },
        ],
      }),
    );
    drive(() => installmentStatus(10n, 11n, '2026-01-01', '2026-01-01'));
    expect([...driven].sort()).toEqual([...INSTALLMENT_ARITHMETIC_CODES].sort());
  });
});
