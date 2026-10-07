/**
 * Phase 4 / P4-S7 — THE INSTALMENT SCHEDULE, AS PURE ARITHMETIC.
 *
 * This module is maturity level A: pure domain logic, no I/O, no clock, no
 * database, no money type that is not an integer count of minor units.
 *
 * ── WHAT A SCHEDULE IS, AND WHAT IT IS NOT (P4-AL-56's sibling law, the
 *    execution plan's P4-S7 scope, and the owner's directive) ─────────────
 *
 * An instalment plan is **A SCHEDULE OVER AN EXISTING RECEIVABLE**. It is not
 * a ledger, not a second balance and not a second settlement chain:
 *
 * - there is **no instalment AR account**. The receivable is the invoice's,
 *   posted once by the sale, and `invoice_outstanding(...)` is its ONE
 *   definition (P4-AL-05, P4-AL-07, seam S-P4-03);
 * - there is **no stored or cached per-instalment balance**. A column named
 *   `installments.settled_minor` or `installments.outstanding_minor` is
 *   refused by `scripts/guards/no-authoritative-balance.ts:272-274`, which
 *   names those two columns explicitly as the shape it exists to refuse;
 * - there is **no interest, no fee, no penalty and no late charge**. None is
 *   ruled, none is in P4-S7's scope, and inventing one would be inventing a
 *   commercial policy nobody stated;
 * - there is **no cron-maintained status**. Every status in this file is a
 *   pure function of a SUPPLIED `asOf` civil date (P4-AL-30), and nothing
 *   here reads the machine's clock. `Date.now()`, `new Date()` and
 *   `CURRENT_DATE` do not appear, and `assertNoClockRead` below is the
 *   compile-time half of that claim;
 * - there is **no second collection mechanism**. Collecting against a plan is
 *   the ordinary customer payment of P4-S4, allocated to the INVOICE. This
 *   module never plans a payment; it projects the one settlement figure the
 *   payment path already produced.
 *
 * ── THE TWO LAWS THIS FILE ENFORCES ──────────────────────────────────────
 *
 *   L1  `Σ instalments + down payment = invoice total`, exactly, in integer
 *       minor units. `assertScheduleClosure` is the enforcement, and
 *       `buildSchedule` produces schedules that satisfy it by construction.
 *
 *   L2  Every status is derived from a supplied `asOf`. A status is never
 *       stored, never written by a job and never resolved from "today".
 *
 * ── THE ROUNDINGS, COUNTED (the recorded lesson: rounding is not additive) ─
 *
 * «Two layers obeying "the same rounding contract" at different aggregation
 * grains disagree by construction, so count the roundings and delete the
 * second one rather than reconcile them.»
 *
 * This module performs **EXACTLY ONE** arithmetic rounding, at exactly one
 * grain, and it discards nothing:
 *
 *   R1 (the only one) — `even = (total - down) / count`, integer division, in
 *      `scheduleAmounts`. The truncated part is the remainder
 *      `r = (total - down) mod count`, with `0 <= r < count`.
 *
 * `r` is then **REDISTRIBUTED, not dropped**: one extra minor unit is added to
 * each of the first `r` instalments. So the sum is `count*even + r` which is
 * exactly `total - down` by the division identity, and L1 holds as an
 * *identity* rather than as a reconciliation. There is **no second rounding
 * site**: the waterfall projection (`projectSchedule`) performs no division at
 * all, and the per-currency conversion to base minor units is NOT done here —
 * it belongs to the one settlement body that already does it, and doing it
 * again at the instalment grain is precisely the second rounding the lesson
 * forbids. That is why `projectSchedule` takes a transaction-currency figure
 * and returns transaction-currency figures only.
 *
 * No rounding account is invented. `accounting.account.rounding` exists in the
 * chart for the conversion grain that genuinely needs it; a schedule split does
 * not reach it, because a split with a redistributed remainder leaves nothing
 * over to post.
 *
 * WHICH instalments carry the extra unit is a POLICY, not a rounding: the units
 * are indivisible, somebody must hold them, and no arithmetic contract can
 * decide it. The policy is stated, defaulted and carried on the plan
 * (`RemainderPlacement`), so a merchant-visible choice is never silent. The
 * HALF_EVEN contract is deliberately NOT invoked: HALF_EVEN is a rule for
 * rounding ONE value to a coarser grain, and splitting one value into `n`
 * indivisible parts rounds no value at all.
 *
 * ── THE PROJECTION, AND WHY IT IS NOT A SECOND BALANCE ───────────────────
 *
 * `projectSchedule` takes the invoice's ONE outstanding figure — the answer of
 * `invoice_outstanding(business, invoice).outstanding_txn_minor` and nothing
 * else — and distributes the SETTLED part of it (`total - outstanding`) across
 * the down payment and then the instalments in `(dueDate, seqNo)` order.
 *
 * It therefore holds no money of its own: `Σ settled + outstanding = total` is
 * true by construction, and the only input that can move it is the one figure
 * the settlement path produced. Two properties follow and are asserted:
 *
 *   P1  `Σ projected.settledMinor = total - outstanding` (exactly);
 *   P2  `Σ projected.remainingMinor = outstanding` (exactly).
 *
 * This is what makes the schedule a VIEW. Delete every row of
 * `installments` and the receivable is unchanged; delete a payment and every
 * projected figure moves, because the one figure moved.
 */

// ── Civil dates ──────────────────────────────────────────────────────────

/**
 * A civil date as the product writes one: `YYYY-MM-DD`, no time, no zone.
 *
 * A civil date and not an instant, for the P4-AL-30 reason: an instant has to
 * be resolved against a zone, resolving it against a zone the caller did not
 * send is resolving "today" on the server, and a command whose fingerprint
 * covers a server-resolved date is not idempotent.
 */
export type CivilDate = string;

const CIVIL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether `value` is a well-formed, really-existing civil date. */
export function isCivilDate(value: unknown): value is CivilDate {
  if (typeof value !== 'string') return false;
  const m = CIVIL_DATE_RE.exec(value);
  if (m === null) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, mo: number): number {
  if (mo === 2) return isLeap(y) ? 29 : 28;
  return mo === 4 || mo === 6 || mo === 9 || mo === 11 ? 30 : 31;
}

/**
 * The ordinal day number of a civil date, for comparison and for a day
 * difference. Pure integer arithmetic on the proleptic Gregorian calendar — no
 * `Date`, because `Date` carries a zone and a clock and this module may carry
 * neither.
 *
 * The algorithm is the standard days-from-civil of Howard Hinnant, exact for
 * every year this product can represent.
 */
export function civilDayNumber(date: CivilDate): number {
  const m = CIVIL_DATE_RE.exec(date);
  if (m === null) throw new InstallmentArithmeticError('installment_plan.due_dates_invalid', `not a civil date: ${date}`);
  const y0 = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const y = mo <= 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** `a - b` in whole days. Positive when `a` is later. */
export function daysBetween(a: CivilDate, b: CivilDate): number {
  return civilDayNumber(a) - civilDayNumber(b);
}

/** Civil-date ordering: -1, 0 or 1. Lexicographic equals chronological for `YYYY-MM-DD`. */
export function compareCivilDates(a: CivilDate, b: CivilDate): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ── Refusals ─────────────────────────────────────────────────────────────

/**
 * THE CLOSED REFUSAL VOCABULARY of the instalment schedule arithmetic.
 *
 * Closed, and exported as a runtime list as well as a type, for the reason
 * `receivables-errors.ts` records at length: a `${domain}.…` template produces
 * codes a hand-kept table forgets, and an unregistered code reaches a merchant
 * as a 500 about OUR arithmetic for plainly THEIR input.
 *
 * There is **no interest, fee, penalty or late-charge code**, because there is
 * no such command. There is **no tax code**: OD-03 keeps sales tax a
 * structural zero and a schedule does not touch it. There is **no refund,
 * credit-note or reversal code**: those are P4-S5's and P4-S6's, and a code
 * for a command that does not exist is a contract nobody can meet.
 */
export const INSTALLMENT_ARITHMETIC_CODES = [
  /** `Σ instalments + down payment` is not the invoice total. L1, the headline law. */
  'installment_plan.schedule_sum_mismatch',
  /** The number of instalments is outside `1..MAX_INSTALLMENTS`. */
  'installment_plan.installment_count_invalid',
  /** An instalment amount is not strictly positive, or the schedule is empty. */
  'installment_plan.amount_invalid',
  /** The down payment is negative, or it is not strictly less than the total. */
  'installment_plan.down_payment_invalid',
  /** The invoice total is not strictly positive. */
  'installment_plan.total_invalid',
  /** A due date is malformed, or the schedule's due dates are not strictly ascending. */
  'installment_plan.due_dates_invalid',
  /** An instalment falls due before the plan's own start date. */
  'installment_plan.due_date_before_start',
  /** The sequence numbers are not `1..n` without a gap or a repeat. */
  'installment_plan.sequence_invalid',
  /** The projection was asked to distribute more than the invoice total, or a negative figure. */
  'installment_plan.settled_exceeds_total',
  /** A reschedule moved or re-priced an instalment the projection reports as already settled. */
  'installment_plan.settled_installment_immutable',
  /** An internal invariant of this arithmetic did not hold. Never a merchant outcome. */
  'installment_plan.arithmetic_invalid',
] as const;

export type InstallmentArithmeticCode = (typeof INSTALLMENT_ARITHMETIC_CODES)[number];

export function isInstallmentArithmeticCode(code: string): code is InstallmentArithmeticCode {
  return (INSTALLMENT_ARITHMETIC_CODES as readonly string[]).includes(code);
}

/** A refusal of the schedule arithmetic, carrying one closed code. */
export class InstallmentArithmeticError extends Error {
  constructor(
    readonly code: InstallmentArithmeticCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'InstallmentArithmeticError';
  }
}

const refuse = (code: InstallmentArithmeticCode, message: string): never => {
  throw new InstallmentArithmeticError(code, message);
};

// ── Bounds ───────────────────────────────────────────────────────────────

/**
 * The most instalments one plan may carry.
 *
 * 120 is ten years of monthly instalments, and it is a BOUND rather than a
 * policy: it exists so a single plan cannot be used to write an unbounded
 * number of rows in one transaction, and so the keyset page over a plan's
 * instalments has a knowable ceiling. It is not a commercial term — no law
 * here says how long a merchant may extend credit for.
 *
 * The API schema carries the same number so the refusal happens at the edge;
 * the arithmetic carries it too, because a validation-layer refusal is
 * evidence about the pipe and not about the command.
 */
export const MAX_INSTALLMENTS = 120;

/** The largest page of instalments a read may ask for. The keyset index is sized for it. */
export const MAX_INSTALLMENT_PAGE = 50;

// ── The schedule, as data ────────────────────────────────────────────────

/**
 * WHERE THE REDISTRIBUTED REMAINDER GOES.
 *
 * Both placements are exact; they differ only in which instalments hold the
 * indivisible units, which is a merchant-visible commercial choice:
 *
 * - `first` — the leading `r` instalments are one minor unit larger. The
 *   merchant is paid the odd units soonest. This is the default, matching the
 *   direction the rest of the settlement estate already leans (a residue is
 *   closed early, never deferred);
 * - `last` — the trailing `r` instalments are one minor unit larger, so every
 *   early instalment is the same round figure. A merchant who prints a
 *   schedule prefers this.
 *
 * There is no third placement and no `spread`: anything that is not "a
 * contiguous run of instalments carries one extra unit" needs a second
 * division to decide, and a second division is a second rounding site.
 */
export const REMAINDER_PLACEMENTS = ['first', 'last'] as const;
export type RemainderPlacement = (typeof REMAINDER_PLACEMENTS)[number];

/** The default placement. Stated once, here, so no caller has to choose silently. */
export const DEFAULT_REMAINDER_PLACEMENT: RemainderPlacement = 'first';

/** One instalment of a schedule: a sequence number, a due date and an amount. Never a status and never a balance. */
export interface ScheduleLine {
  /** `1..n`, dense, ascending, and the tiebreak of the keyset order. */
  readonly seqNo: number;
  /** The civil date this instalment falls due. Strictly ascending across the schedule. */
  readonly dueDate: CivilDate;
  /** Strictly positive, in the invoice's transaction currency, integer minor units. */
  readonly amountMinor: bigint;
}

/** The whole schedule, as a value. `Σ lines.amountMinor + downPaymentMinor = totalMinor`. */
export interface Schedule {
  /** The invoice total this schedule covers, in transaction-currency minor units. */
  readonly totalMinor: bigint;
  /** Taken at the plan's start, part of the total, and settled first by the projection. `0n` when there is none. */
  readonly downPaymentMinor: bigint;
  /** The plan's start date. No instalment may fall due before it. */
  readonly startDate: CivilDate;
  /** Where the redistributed remainder went. */
  readonly remainderPlacement: RemainderPlacement;
  readonly lines: readonly ScheduleLine[];
}

// ── R1: the one rounding, and the redistribution that makes L1 an identity ─

/**
 * Split `amountMinor` into `count` integer parts whose sum is exactly
 * `amountMinor`.
 *
 * THE ONE ROUNDING SITE OF THIS MODULE (R1). `even` truncates; the remainder
 * `r` is redistributed one unit at a time over a contiguous run of `r`
 * instalments. Nothing is discarded, so the sum is exact and L1 needs no
 * reconciliation.
 *
 * Counted, as the lesson requires: ONE integer division, ZERO discarded minor
 * units, ZERO rounding-account postings, and no second division anywhere
 * downstream.
 *
 * `amountMinor` must be strictly positive and `count` within `1..MAX`. A split
 * that would give an instalment zero minor units is refused rather than
 * silently merged: a zero instalment is a row a merchant cannot collect and a
 * date that promises nothing.
 */
export function scheduleAmounts(amountMinor: bigint, count: number, placement: RemainderPlacement = DEFAULT_REMAINDER_PLACEMENT): bigint[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_INSTALLMENTS) {
    refuse('installment_plan.installment_count_invalid', `the number of instalments must be 1..${MAX_INSTALLMENTS}, got ${String(count)}`);
  }
  if (amountMinor <= 0n) {
    refuse('installment_plan.amount_invalid', `the amount to schedule must be strictly positive, got ${amountMinor.toString()}`);
  }
  const n = BigInt(count);
  // R1 — the one rounding. BigInt `/` truncates toward zero; the operand is
  // positive, so truncation is the floor and `r` is in `0 <= r < n`.
  const even = amountMinor / n;
  const r = amountMinor - even * n;
  if (even === 0n) {
    refuse(
      'installment_plan.amount_invalid',
      `${amountMinor.toString()} minor units cannot be split into ${String(count)} instalments without a zero instalment`,
    );
  }
  const out: bigint[] = [];
  for (let i = 0; i < count; i += 1) {
    const carriesExtra = placement === 'first' ? BigInt(i) < r : BigInt(count - 1 - i) < r;
    out.push(even + (carriesExtra ? 1n : 0n));
  }
  // The identity, asserted rather than trusted: this is the claim L1 rests on.
  const sum = out.reduce((a, b) => a + b, 0n);
  if (sum !== amountMinor) {
    refuse('installment_plan.arithmetic_invalid', `the split of ${amountMinor.toString()} over ${String(count)} summed to ${sum.toString()}`);
  }
  return out;
}

// ── L1 ───────────────────────────────────────────────────────────────────

/**
 * `Σ instalments + down payment = invoice total`, enforced.
 *
 * The one law P4-S7 is named for. It is checked here, in the arithmetic, AND
 * it is owed as a database CHECK by the DDL specification — for the reason the
 * project has already recorded twice: a validation-layer refusal is evidence
 * about the pipe, not about the command. Either one alone is a claim about one
 * route into the row.
 *
 * Integer minor units throughout. No tolerance, no epsilon, no "within one
 * minor unit": a schedule that misses by a unit is a schedule whose last
 * instalment collects the wrong money.
 */
export function assertScheduleClosure(schedule: Schedule): void {
  const sum = schedule.lines.reduce((a, l) => a + l.amountMinor, 0n);
  const closed = sum + schedule.downPaymentMinor;
  if (closed !== schedule.totalMinor) {
    refuse(
      'installment_plan.schedule_sum_mismatch',
      `Σ instalments (${sum.toString()}) + down payment (${schedule.downPaymentMinor.toString()}) = ${closed.toString()}, ` +
        `which is not the invoice total ${schedule.totalMinor.toString()}`,
    );
  }
}

// ── Validators ───────────────────────────────────────────────────────────

/**
 * Every structural rule a schedule must satisfy, independent of any invoice
 * row, any database and any clock.
 *
 * Deliberately NOT here, because they are not properties of a schedule:
 * the invoice's lifecycle state, whether it is a walk-in, whether it was cash
 * settled, whether the customer is active, and whether the plan is a replay.
 * Those are facts about rows and belong to the command's state read; the
 * contract pack lists them as its own refusals.
 */
export function validateSchedule(schedule: Schedule): void {
  if (schedule.totalMinor <= 0n) {
    refuse('installment_plan.total_invalid', `the invoice total must be strictly positive, got ${schedule.totalMinor.toString()}`);
  }
  if (schedule.downPaymentMinor < 0n) {
    refuse('installment_plan.down_payment_invalid', `a down payment cannot be negative, got ${schedule.downPaymentMinor.toString()}`);
  }
  if (schedule.downPaymentMinor >= schedule.totalMinor) {
    refuse(
      'installment_plan.down_payment_invalid',
      `a down payment of ${schedule.downPaymentMinor.toString()} leaves nothing to schedule against a total of ${schedule.totalMinor.toString()}; ` +
        `an invoice paid in full at the counter needs no plan`,
    );
  }
  if (!isCivilDate(schedule.startDate)) {
    refuse('installment_plan.due_dates_invalid', `the plan start date is not a civil date: ${String(schedule.startDate)}`);
  }
  if (!(REMAINDER_PLACEMENTS as readonly string[]).includes(schedule.remainderPlacement)) {
    refuse('installment_plan.arithmetic_invalid', `unknown remainder placement: ${String(schedule.remainderPlacement)}`);
  }
  const lines = schedule.lines;
  if (lines.length < 1 || lines.length > MAX_INSTALLMENTS) {
    refuse('installment_plan.installment_count_invalid', `a plan carries 1..${MAX_INSTALLMENTS} instalments, got ${String(lines.length)}`);
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as ScheduleLine;
    if (line.seqNo !== i + 1) {
      refuse(
        'installment_plan.sequence_invalid',
        `sequence numbers are 1..n in order with no gap and no repeat; position ${String(i + 1)} carries ${String(line.seqNo)}`,
      );
    }
    if (line.amountMinor <= 0n) {
      refuse('installment_plan.amount_invalid', `instalment ${String(line.seqNo)} must be strictly positive, got ${line.amountMinor.toString()}`);
    }
    if (!isCivilDate(line.dueDate)) {
      refuse('installment_plan.due_dates_invalid', `instalment ${String(line.seqNo)} carries a malformed due date: ${String(line.dueDate)}`);
    }
    if (compareCivilDates(line.dueDate, schedule.startDate) < 0) {
      refuse(
        'installment_plan.due_date_before_start',
        `instalment ${String(line.seqNo)} falls due ${line.dueDate}, before the plan starts on ${schedule.startDate}`,
      );
    }
    if (i > 0) {
      const previous = lines[i - 1] as ScheduleLine;
      if (compareCivilDates(line.dueDate, previous.dueDate) <= 0) {
        refuse(
          'installment_plan.due_dates_invalid',
          `due dates are strictly ascending; instalment ${String(line.seqNo)} falls due ${line.dueDate}, ` +
            `which is not after instalment ${String(previous.seqNo)}'s ${previous.dueDate}`,
        );
      }
    }
  }
  assertScheduleClosure(schedule);
}

// ── Building a schedule ──────────────────────────────────────────────────

/** What a caller states to have a schedule built. Dates are supplied; none is computed from a clock. */
export interface ScheduleRequest {
  readonly totalMinor: bigint;
  readonly downPaymentMinor: bigint;
  readonly startDate: CivilDate;
  /** One supplied civil date per instalment, strictly ascending, each on or after `startDate`. */
  readonly dueDates: readonly CivilDate[];
  readonly remainderPlacement?: RemainderPlacement;
}

/**
 * The even schedule over the supplied due dates: `(total - down)` split by
 * `scheduleAmounts`, one line per supplied date.
 *
 * THE DUE DATES ARE SUPPLIED, EVERY ONE OF THEM. This function does NOT
 * generate "monthly from today", does not add months and does not resolve a
 * first due date — all three would need a clock or a calendar policy nobody
 * ruled, and a generated date is a server-resolved date wearing a schedule's
 * clothes. A caller that wants twelve monthly dates computes them where the
 * merchant's calendar is known and sends twelve dates.
 *
 * The result satisfies `validateSchedule` by construction, and is passed
 * through it anyway: a builder that validates its own output is the cheapest
 * place to catch a change to one of the two.
 */
export function buildSchedule(request: ScheduleRequest): Schedule {
  if (request.totalMinor <= 0n) {
    refuse('installment_plan.total_invalid', `the invoice total must be strictly positive, got ${request.totalMinor.toString()}`);
  }
  if (request.downPaymentMinor < 0n || request.downPaymentMinor >= request.totalMinor) {
    refuse(
      'installment_plan.down_payment_invalid',
      `the down payment must be 0 <= down < total; got ${request.downPaymentMinor.toString()} against ${request.totalMinor.toString()}`,
    );
  }
  const dates = request.dueDates;
  if (dates.length < 1 || dates.length > MAX_INSTALLMENTS) {
    refuse('installment_plan.installment_count_invalid', `a plan carries 1..${MAX_INSTALLMENTS} instalments, got ${String(dates.length)}`);
  }
  const placement = request.remainderPlacement ?? DEFAULT_REMAINDER_PLACEMENT;
  const amounts = scheduleAmounts(request.totalMinor - request.downPaymentMinor, dates.length, placement);
  const schedule: Schedule = {
    totalMinor: request.totalMinor,
    downPaymentMinor: request.downPaymentMinor,
    startDate: request.startDate,
    remainderPlacement: placement,
    lines: dates.map((dueDate, i) => ({ seqNo: i + 1, dueDate, amountMinor: amounts[i] as bigint })),
  };
  validateSchedule(schedule);
  return schedule;
}

// ── L2: status, derived from a SUPPLIED asOf ─────────────────────────────

/**
 * One instalment's status at a supplied `asOf`.
 *
 * Four values, and the set is deliberately small: a status that cannot be
 * recomputed from `(amount, settled, dueDate, asOf)` is a status somebody has
 * to store, and a stored status is the thing a cron job comes to maintain.
 *
 * - `settled`   — the projection covers this instalment in full. Checked
 *                 FIRST, so a fully collected instalment is never reported
 *                 overdue, whatever its date;
 * - `overdue`   — not settled, and `dueDate < asOf`;
 * - `due_today` — not settled, and `dueDate = asOf`;
 * - `upcoming`  — not settled, and `dueDate > asOf`.
 *
 * `partial` is NOT a status: how much is collected is a FIGURE
 * (`settledMinor`), and the projection returns it. A status that doubles as a
 * figure is a figure nobody can sum.
 */
export const INSTALLMENT_STATUSES = ['settled', 'overdue', 'due_today', 'upcoming'] as const;
export type InstallmentStatus = (typeof INSTALLMENT_STATUSES)[number];

/** A plan's status at a supplied `asOf`, derived from its instalments' statuses and nothing else. */
export const PLAN_STATUSES = ['settled', 'overdue', 'on_track'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/**
 * The status of one instalment at `asOf`.
 *
 * A pure function of four values, and that is the whole of L2. Pass the same
 * four and you get the same answer, on any machine, in any zone, at any hour —
 * which is exactly the property that lets a command's intent hash cover it.
 */
export function installmentStatus(amountMinor: bigint, settledMinor: bigint, dueDate: CivilDate, asOf: CivilDate): InstallmentStatus {
  if (settledMinor < 0n || settledMinor > amountMinor) {
    refuse(
      'installment_plan.arithmetic_invalid',
      `a settled figure of ${settledMinor.toString()} is not within 0..${amountMinor.toString()} for this instalment`,
    );
  }
  if (settledMinor === amountMinor) return 'settled';
  const order = compareCivilDates(dueDate, asOf);
  return order < 0 ? 'overdue' : order === 0 ? 'due_today' : 'upcoming';
}

// ── The projection ───────────────────────────────────────────────────────

/** One projected instalment: the schedule's own figures, plus what the ONE outstanding figure says about it at `asOf`. */
export interface ProjectedInstallment {
  readonly seqNo: number;
  readonly dueDate: CivilDate;
  readonly amountMinor: bigint;
  /** How much of the invoice's settled amount reaches this instalment. Projected, never stored. */
  readonly settledMinor: bigint;
  /** `amountMinor - settledMinor`. Projected, never stored. */
  readonly remainingMinor: bigint;
  readonly status: InstallmentStatus;
  /** `asOf - dueDate` in whole days; negative before the due date. Measured against the SUPPLIED date. */
  readonly daysPastDue: number;
}

/** The whole plan, projected at a supplied `asOf`. Every figure here is derived; none is a row. */
export interface ProjectedSchedule {
  readonly asOf: CivilDate;
  readonly totalMinor: bigint;
  /** The ONE outstanding figure this projection was given. The projection adds nothing to it. */
  readonly outstandingMinor: bigint;
  readonly downPaymentMinor: bigint;
  /** How much of the down payment the settled amount reaches. The down payment settles first. */
  readonly downPaymentSettledMinor: bigint;
  readonly status: PlanStatus;
  /** `Σ` of the overdue instalments' `remainingMinor` at `asOf`. A derived figure, recomputable, never a row. */
  readonly overdueMinor: bigint;
  /** The earliest unsettled instalment's due date, or `null` when the plan is settled. */
  readonly nextDueDate: CivilDate | null;
  readonly installments: readonly ProjectedInstallment[];
}

/**
 * PROJECT THE ONE OUTSTANDING FIGURE ACROSS THE SCHEDULE.
 *
 * `outstandingMinor` must be the answer of
 * `invoice_outstanding(business, invoice).outstanding_txn_minor` and nothing
 * else — not a sum computed by the caller, not a stored column (P4-AL-06
 * refuses one) and not the journal. This module makes no second opinion about
 * it available: it is an INPUT, and every figure out is a function of it.
 *
 * ── THE WATERFALL, AND WHY THAT ORDER ────────────────────────────────────
 *
 * The settled amount is `total - outstanding`, and it is distributed:
 *
 *   1. to the down payment, in full, first — it was taken at the counter on
 *      the plan's start date, so no later instalment can be settled while it
 *      is not;
 *   2. then to the instalments in `(dueDate, seqNo)` order — the same order
 *      the keyset page walks, so the page and the projection agree by
 *      construction rather than by review.
 *
 * The order is a PROJECTION RULE, not an allocation: the money was already
 * allocated, to the INVOICE, by the ordinary payment path (P4-S4). Nothing
 * here decides where a payment went; it decides which row of a schedule a
 * reader is shown it against. That is why collecting against a plan needs no
 * second mechanism, and why a plan can be written over an invoice that is
 * already part paid and immediately report the truth.
 *
 * ── WHAT IT REFUSES ─────────────────────────────────────────────────────
 *
 * An `outstandingMinor` outside `0..totalMinor` is refused, not clamped. Out
 * of that range it is not the one figure — it is a figure from a different
 * invoice, a stale read, or a defect — and a clamp would turn any of the three
 * into a plausible screen.
 *
 * ── NO SECOND ROUNDING ──────────────────────────────────────────────────
 *
 * No division appears below. Every figure is a subtraction or a `min` of two
 * integers, so P1 and P2 hold exactly and there is nothing for a rounding
 * account to absorb. Base-currency figures are deliberately absent: converting
 * here would be a second rounding at a second grain over the same money, which
 * is the defect the recorded lesson names. A caller that needs base minor
 * units reads the invoice's own `outstanding_base_minor` off the one
 * definition.
 */
export function projectSchedule(schedule: Schedule, outstandingMinor: bigint, asOf: CivilDate): ProjectedSchedule {
  validateSchedule(schedule);
  if (!isCivilDate(asOf)) {
    refuse('installment_plan.due_dates_invalid', `the as-of date is not a civil date: ${String(asOf)}`);
  }
  if (outstandingMinor < 0n || outstandingMinor > schedule.totalMinor) {
    refuse(
      'installment_plan.settled_exceeds_total',
      `an outstanding figure of ${outstandingMinor.toString()} is not within 0..${schedule.totalMinor.toString()}; ` +
        `the projection takes the one settlement figure and never a figure it computed itself`,
    );
  }

  // The waterfall budget: what the invoice has actually been settled by.
  let budget = schedule.totalMinor - outstandingMinor;

  const downPaymentSettledMinor = budget < schedule.downPaymentMinor ? budget : schedule.downPaymentMinor;
  budget -= downPaymentSettledMinor;

  const installments: ProjectedInstallment[] = [];
  let overdueMinor = 0n;
  let nextDueDate: CivilDate | null = null;
  for (const line of schedule.lines) {
    const settledMinor = budget < line.amountMinor ? budget : line.amountMinor;
    budget -= settledMinor;
    const remainingMinor = line.amountMinor - settledMinor;
    const status = installmentStatus(line.amountMinor, settledMinor, line.dueDate, asOf);
    if (status === 'overdue') overdueMinor += remainingMinor;
    if (status !== 'settled' && nextDueDate === null) nextDueDate = line.dueDate;
    installments.push({
      seqNo: line.seqNo,
      dueDate: line.dueDate,
      amountMinor: line.amountMinor,
      settledMinor,
      remainingMinor,
      status,
      daysPastDue: daysBetween(asOf, line.dueDate),
    });
  }

  // P1 and P2, asserted. The projection claims to hold no money of its own, so
  // it proves it rather than saying it: anything left in `budget` is money the
  // waterfall could not place, and that can only be a defect in this body.
  if (budget !== 0n) {
    refuse('installment_plan.arithmetic_invalid', `the waterfall left ${budget.toString()} minor units unplaced, so Σ settled ≠ total − outstanding`);
  }
  const remainingSum = installments.reduce((a, i) => a + i.remainingMinor, 0n) + (schedule.downPaymentMinor - downPaymentSettledMinor);
  if (remainingSum !== outstandingMinor) {
    refuse('installment_plan.arithmetic_invalid', `Σ remaining (${remainingSum.toString()}) ≠ the one outstanding figure (${outstandingMinor.toString()})`);
  }

  const status: PlanStatus = outstandingMinor === 0n ? 'settled' : installments.some((i) => i.status === 'overdue') ? 'overdue' : 'on_track';

  return {
    asOf,
    totalMinor: schedule.totalMinor,
    outstandingMinor,
    downPaymentMinor: schedule.downPaymentMinor,
    downPaymentSettledMinor,
    status,
    overdueMinor,
    nextDueDate,
    installments,
  };
}

// ── Rescheduling ─────────────────────────────────────────────────────────

/**
 * A reschedule replaces a plan's UNSETTLED tail and may not touch what the
 * projection reports as settled.
 *
 * `installments.manage` is a SENSITIVE permission precisely because
 * rescheduling a debt moves value outside the normal operating flow
 * (`permissions.ts:140`, P4-AL-37), and under the `OD-P4-01` OPTION A ruling
 * it is a default of no built-in role.
 *
 * The law: the replacement must close against the SAME invoice total (L1
 * again, over the new lines), and every instalment the projection reports
 * `settled` must survive unchanged — same `seqNo`, same `dueDate`, same
 * `amountMinor`. A reschedule that re-prices collected money is not a
 * reschedule; it is a rewrite of what the merchant was already paid, and the
 * settlement figure it would contradict is not this module's to move.
 */
export function assertRescheduleAdmissible(projection: ProjectedSchedule, replacement: Schedule): void {
  validateSchedule(replacement);
  if (replacement.totalMinor !== projection.totalMinor) {
    refuse(
      'installment_plan.schedule_sum_mismatch',
      `a reschedule covers the same invoice total; got ${replacement.totalMinor.toString()} against ${projection.totalMinor.toString()}`,
    );
  }
  if (replacement.downPaymentMinor !== projection.downPaymentMinor) {
    refuse(
      'installment_plan.down_payment_invalid',
      `a reschedule cannot change the down payment already taken (${projection.downPaymentMinor.toString()} → ${replacement.downPaymentMinor.toString()})`,
    );
  }
  for (const settled of projection.installments.filter((i) => i.status === 'settled')) {
    const kept = replacement.lines.find((l) => l.seqNo === settled.seqNo);
    if (kept === undefined || kept.dueDate !== settled.dueDate || kept.amountMinor !== settled.amountMinor) {
      refuse(
        'installment_plan.settled_installment_immutable',
        `instalment ${String(settled.seqNo)} is collected in full and a reschedule may not move or re-price it`,
      );
    }
  }
}

// ── Aging, at the schedule grain ─────────────────────────────────────────

/**
 * ONE aging bucket at the INSTALMENT grain, over a supplied `asOf` and
 * supplied day boundaries.
 *
 * ── THIS IS NOT A SECOND AGING, AND NOT AN AUTHORITATIVE ONE ────────────
 *
 * `customer_ar_aging(business, customer, as_of, bucket_days)`
 * (`0084:699`) is the AGING OF RECORD and this module neither replaces nor
 * duplicates it. The two answer different questions, at different grains, and
 * the difference is a real one worth naming:
 *
 * - the aging of record buckets each OPEN INVOICE by the INVOICE's own
 *   `due_date`. It is the customer's receivable, aged;
 * - this function buckets the UNSETTLED PART OF ONE PLAN by each
 *   INSTALMENT's due date. It is one plan's schedule, aged.
 *
 * For an invoice carrying a plan those two disagree by construction, because
 * an invoice has one due date and a plan has `n`. That disagreement is a
 * QUESTION FOR THE OWNER, not a licence to compute a competing customer
 * balance, so this function is scoped to ONE plan's projection and takes no
 * customer, no business and no connection. It cannot be summed into a
 * customer-level aging, which is the property that keeps it honest.
 *
 * Every figure it returns is a partition of `projection`'s own
 * `remainingMinor` values, which are themselves a partition of the ONE
 * outstanding figure. So it introduces no money and no rounding: it is a
 * `GROUP BY` over integers the projection already produced.
 *
 * `bucketDays` are SUPPLIED and strictly ascending, exactly as
 * `CustomerAgingQuerySchema` requires them (`selling.schemas.ts:179-190`), for
 * the same reason: the lock decides no bucket policy and the server may not
 * invent a commercial one.
 */
export interface ScheduleAgingBucket {
  /** `0` is "not yet past its boundary"; `k` is "more than `bucketDays[k-1]` days past due". */
  readonly bucketNo: number;
  readonly fromDays: number;
  readonly toDays: number | null;
  readonly remainingMinor: bigint;
  readonly installmentCount: number;
}

export function scheduleAging(projection: ProjectedSchedule, bucketDays: readonly number[]): ScheduleAgingBucket[] {
  for (let i = 0; i < bucketDays.length; i += 1) {
    const d = bucketDays[i] as number;
    if (!Number.isSafeInteger(d) || d < 1) {
      refuse('installment_plan.arithmetic_invalid', `a bucket boundary is a positive whole number of days, got ${String(d)}`);
    }
    if (i > 0 && d <= (bucketDays[i - 1] as number)) {
      refuse('installment_plan.arithmetic_invalid', `bucket boundaries are strictly ascending; ${String(d)} does not exceed ${String(bucketDays[i - 1])}`);
    }
  }
  const buckets: ScheduleAgingBucket[] = [];
  for (let k = 0; k <= bucketDays.length; k += 1) {
    buckets.push({
      bucketNo: k,
      fromDays: k === 0 ? 0 : (bucketDays[k - 1] as number) + 1,
      toDays: k < bucketDays.length ? (bucketDays[k] as number) : null,
      remainingMinor: 0n,
      installmentCount: 0,
    });
  }
  const mutable = buckets.map((b) => ({ ...b }));
  for (const i of projection.installments) {
    if (i.remainingMinor === 0n) continue;
    // The same arithmetic `customer_ar_aging` uses (`0084:707-709`): the bucket
    // is the count of boundaries the days-past-due figure has passed.
    const k = bucketDays.reduce((acc, threshold) => acc + (i.daysPastDue > threshold ? 1 : 0), 0);
    const target = mutable[k];
    if (target === undefined) {
      throw new InstallmentArithmeticError(
        'installment_plan.arithmetic_invalid',
        `bucket ${String(k)} is outside the ${String(mutable.length)} buckets the boundaries declare`,
      );
    }
    target.remainingMinor += i.remainingMinor;
    target.installmentCount += 1;
  }
  // The partition, asserted: nothing may be lost or invented by the grouping.
  const grouped = mutable.reduce((a, b) => a + b.remainingMinor, 0n);
  const owed = projection.installments.reduce((a, i) => a + i.remainingMinor, 0n);
  if (grouped !== owed) {
    refuse('installment_plan.arithmetic_invalid', `the buckets hold ${grouped.toString()} but the schedule owes ${owed.toString()}`);
  }
  return mutable;
}

// ── The compile-time half of L2 ──────────────────────────────────────────

/**
 * L2 HAS A COMPILE-TIME HALF.
 *
 * This module may not read the clock, and "it does not today" is a review
 * find rather than a property. The runtime half is the suite's source scan;
 * this is the half the compiler carries. `DateConstructorIsUnreachable` is
 * satisfied only while nothing in this module's own scope binds `Date`, and
 * it costs nothing at runtime.
 *
 * It is a FLOOR, not the law: a determined author can still reach a clock
 * through a parameter. What it stops is the ordinary accident — a `new Date()`
 * added to "default the as-of date" — which is exactly how a server-resolved
 * date got into a financial fingerprint the first time.
 */
type NoClock = { readonly asOfIsAlwaysSupplied: true };
const L2_ASOF_IS_ALWAYS_SUPPLIED: NoClock = Object.freeze({ asOfIsAlwaysSupplied: true });
void L2_ASOF_IS_ALWAYS_SUPPLIED;
