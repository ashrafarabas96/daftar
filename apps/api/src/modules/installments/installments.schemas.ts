import { MAX_AGING_BUCKETS, MAX_AGING_BUCKET_DAY, MAX_INSTALLMENTS, MAX_INSTALLMENT_PAGE, REMAINDER_PLACEMENTS } from '@daftar/domain-core';
import { z } from 'zod';

/**
 * P4-S7 — THE REQUEST AND QUERY SCHEMAS of the instalment plan, the debt
 * reads and the statement.
 *
 * Every schema is `.strict()`, exactly as the accepted P4-S1 and P3-S4 schemas
 * are: a tenant, a business, an actor, a trace id, a revision the server owns,
 * a stored amount, a rate, a status, a balance or any authority flag is refused
 * as an UNKNOWN KEY, before the service is reached.
 *
 * What is refused here rather than later, because a field's mere presence is
 * the defect:
 *
 * - **any interest, fee, penalty or late-charge field.** `interestRate`,
 *   `apr`, `feeMinor`, `lateFeeMinor`, `penaltyMinor` are unknown keys. None
 *   is ruled, so none is validated to zero — the way a tax field is refused
 *   rather than checked against `0`;
 * - **any tax field.** OD-03 keeps sales tax a structural zero (P4-AL-44);
 * - **any status field.** Status is DERIVED from a supplied `asOf` (L2), so
 *   `status`, `isOverdue` and `settled` are unknown keys on every request. A
 *   client that may state a status is a client that may disagree with the
 *   figure;
 * - **any balance field.** There is no instalment balance:
 *   `outstandingMinor`, `settledMinor`, `paidMinor`, `remainingMinor` are
 *   unknown keys on every REQUEST. They appear only in RESPONSES, projected
 *   from the one settlement figure;
 * - **any `idempotencyKey`.** P4-AL-30: idempotency is the caller-supplied
 *   document UUID plus the stored `intent_sha256`, and `idempotency_key`
 *   "exists nowhere in the commercial schema";
 * - **any `asOf` default.** Every date is a REQUIRED input, on the reads as
 *   well as the commands. A read whose as-of date defaults to the server's
 *   today is a read that cannot be reproduced, and the status it returns is a
 *   status nobody can check (`[[daftar-a-command-must-not-read-the-clock]]`,
 *   P4-AL-30).
 *
 * ── WHY THE AMOUNTS ARE STRINGS ─────────────────────────────────────────
 *
 * A money figure crosses the wire as a decimal STRING of minor units and is
 * parsed to `bigint`. 10^18 minor units does not survive a JSON number, and
 * `[[no float money]]` is not a style rule. The regex bounds the digit count
 * so a 4 000-digit integer cannot be turned into a `bigint` by the parser —
 * the refusal is on the SHAPE, before any arithmetic.
 */

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'must be a canonical lowercase uuid');

/**
 * A civil date: `YYYY-MM-DD`, really existing. The `Date` here is a PARSER of
 * a supplied string, never a clock: it is handed an explicit value and reads
 * nothing from the environment. That is the same device
 * `selling.schemas.ts:73-79` uses, and it is the reason this file may hold the
 * identifier at all while `installment-schedule.ts` may not.
 */
const civilDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'must be a real calendar date');

/** Up to 18 digits of minor units: comfortably past any real total, short of anything that would stress a parser. */
const minorUnits = z.string().regex(/^(0|[1-9]\d{0,17})$/, 'minor units are a non-negative integer with no sign, no point and no separator');

/** A strictly positive figure in minor units. */
const positiveMinorUnits = minorUnits.refine((v) => v !== '0', 'must be strictly positive');

const pageLimit = z
  .string()
  .regex(/^\d{1,2}$/, `a limit is 1..${String(MAX_INSTALLMENT_PAGE)}`)
  .transform((s) => Number.parseInt(s, 10))
  .pipe(z.number().int().min(1).max(MAX_INSTALLMENT_PAGE));

/**
 * ── THE KEYSET CURSOR (the slice's law 5) ───────────────────────────────
 *
 * A statement or debt history page is continued by a CURSOR that carries
 * EVERY COMPONENT OF THE ORDERING KEY, and never by an `OFFSET`.
 *
 * `OFFSET` reads and discards what it skips, and a row appended mid-walk
 * shifts every later page — in a ledger that is a line nobody sees.
 * `scripts/guards/read-surface.ts`' `no OFFSET pagination` rule refuses it
 * statically over every `apps/api/src/modules/<context>/*-reads.ts`, so a read
 * module of this slice is covered by that rule the day it is written.
 *
 * The token is `<date>|<kind>|<uuid>`, in that order, and it is OPAQUE to the
 * client in contract while being readable in fact: an opaque base64 token
 * would hide a malformed cursor behind a decode step and turn a client defect
 * into an empty page. A token of the wrong SHAPE is
 * `installment.cursor_invalid`; a well-formed token naming a row the caller
 * cannot see is an EMPTY PAGE, never a 404 (G-02).
 *
 * The ordering key has three components because two are not unique: two
 * documents of one customer can share a date, and a date plus a kind can hold
 * many rows. A keyset whose key is not unique either repeats a row or skips
 * one at every page boundary.
 */
export const STATEMENT_ENTRY_KINDS = ['invoice', 'payment', 'credit_application', 'installment_due'] as const;
export type StatementEntryKind = (typeof STATEMENT_ENTRY_KINDS)[number];

const CURSOR_RE = new RegExp(
  `^(\\d{4}-\\d{2}-\\d{2})\\|(${STATEMENT_ENTRY_KINDS.join('|')})\\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`,
);

/** The three components of a statement cursor, parsed. */
export interface StatementCursor {
  readonly entryDate: string;
  readonly entryKind: StatementEntryKind;
  readonly entryId: string;
}

export const statementCursor = z
  .string()
  .max(96)
  .refine((v) => CURSOR_RE.test(v), 'a statement cursor is <date>|<kind>|<uuid>')
  .transform((v): StatementCursor => {
    const m = CURSOR_RE.exec(v) as RegExpExecArray;
    return { entryDate: m[1] as string, entryKind: m[2] as StatementEntryKind, entryId: m[3] as string };
  });

/** The cursor token a read emits for a row. The one place the token's shape is written. */
export function encodeStatementCursor(c: StatementCursor): string {
  return `${c.entryDate}|${c.entryKind}|${c.entryId}`;
}

/**
 * The instalment page's cursor is the SEQUENCE NUMBER, not a uuid.
 *
 * A plan's instalments are ordered `(due_date, seq_no)` and `seq_no` is dense
 * `1..n` within the plan, so the sequence number alone is a unique, totally
 * ordered key over the page's scope — and the page's scope is one plan, which
 * the path already names. A uuid cursor here would be a second identifier for
 * a row the composite key already orders.
 *
 * It is NOT an offset. `WHERE seq_no > $cursor` reads nothing it discards and
 * is unaffected by a row appended before it, which is precisely what an
 * `OFFSET` is not.
 */
const installmentCursor = z
  .string()
  .regex(/^\d{1,3}$/)
  .transform((s) => Number.parseInt(s, 10))
  .pipe(z.number().int().min(1).max(MAX_INSTALLMENTS));

/**
 * Supplied, strictly ascending aging day boundaries — the EXACT shape
 * `CustomerAgingQuerySchema` requires (`selling.schemas.ts:179-190`), reusing
 * its two bounds from the package rather than restating two numbers.
 *
 * They are a REQUIRED input because the lock decides no bucket policy
 * (`OD-P4-03` OPTION A says the aging is shown; it does not say in what
 * buckets), and the server may not invent a commercial policy nobody stated.
 * They are never stored: a materialised aging table is forbidden (P4-AL-06),
 * and this slice adds no authoritative aging balance of any kind.
 */
const bucketDays = z
  .string()
  .regex(/^\d{1,4}(,\d{1,4}){0,5}$/, 'ascending day boundaries, e.g. 30,60,90')
  .transform((s) => s.split(',').map((d) => Number.parseInt(d, 10)))
  .pipe(
    z
      .array(z.number().int().min(1).max(MAX_AGING_BUCKET_DAY))
      .min(1)
      .max(MAX_AGING_BUCKETS)
      .refine((days) => days.every((d, i) => i === 0 || d > (days[i - 1] as number)), 'day boundaries are strictly ascending'),
  );

// ── Commands ─────────────────────────────────────────────────────────────

/**
 * One instalment of a schedule a caller states explicitly.
 *
 * `dueDate` is SUPPLIED, always. Nothing behind this schema generates "monthly
 * from the start date": adding a month needs a calendar policy nobody ruled
 * (what is a month after 31 January?), and a generated date is a
 * server-resolved date wearing a schedule's clothes. A client that wants
 * twelve monthly dates computes them where the merchant's calendar is known
 * and sends twelve dates — and the intent digest then binds all twelve.
 *
 * `amountMinor` is OPTIONAL per line, and the two modes are mutually exclusive
 * at the schedule level:
 *
 * - every line states its amount → the caller's schedule, checked against L1;
 * - no line states an amount → the even split (`scheduleAmounts`), with the
 *   remainder redistributed over `remainderPlacement`.
 *
 * A MIXTURE is refused. "Some amounts stated, the rest inferred" needs a
 * second division over a residue, and a second division is a second rounding
 * site — the exact shape the recorded lesson says to delete rather than
 * reconcile.
 */
export const InstallmentLineSchema = z
  .object({
    seqNo: z.number().int().min(1).max(MAX_INSTALLMENTS),
    dueDate: civilDate,
    amountMinor: positiveMinorUnits.optional(),
  })
  .strict();

export const CreateInstallmentPlanSchema = z
  .object({
    /** The caller-chosen plan id. The idempotency identity, with the server-computed intent digest beside it (P4-AL-30). */
    planId: uuid,
    invoiceId: uuid,
    /** Stated, and checked against the invoice's own customer: a mismatch is `installment_plan.customer_mismatch`. */
    customerId: uuid,
    /** The plan's own start date, supplied. No instalment may fall due before it, and it may not precede the invoice's issue date. */
    startDate: civilDate,
    /** Omitted means none. `'0'` is accepted and means the same thing; the digest binds what was sent. */
    downPaymentMinor: minorUnits.optional(),
    remainderPlacement: z.enum(REMAINDER_PLACEMENTS).optional(),
    installments: z.array(InstallmentLineSchema).min(1).max(MAX_INSTALLMENTS),
  })
  .strict()
  .refine(
    (v) => {
      const stated = v.installments.filter((l) => l.amountMinor !== undefined).length;
      return stated === 0 || stated === v.installments.length;
    },
    { message: 'either every instalment states its amount or none does; a mixture needs a second rounding site', path: ['installments'] },
  )
  .refine((v) => v.installments.every((l, i) => l.seqNo === i + 1), {
    message: 'sequence numbers are 1..n in order with no gap and no repeat',
    path: ['installments'],
  })
  .refine((v) => v.installments.every((l, i) => i === 0 || l.dueDate > (v.installments[i - 1] as { dueDate: string }).dueDate), {
    message: 'due dates are strictly ascending',
    path: ['installments'],
  });

/**
 * A reschedule replaces the plan's UNSETTLED tail.
 *
 * It carries its OWN caller-chosen id, so a reschedule is an idempotent
 * command in its own right rather than a second write under the plan's id —
 * the plan id would make the second reschedule of one plan indistinguishable
 * from a replay of the first.
 *
 * It states `expectedOutstandingMinor`: the figure the caller SAW when it drew
 * the schedule. The command refuses with `installment_plan.settlement_changed`
 * if the one settlement figure has moved since, and the client retries the
 * SAME body against the new figure. The cap is never silently adjusted to fit
 * (the accepted `customer_payment.settlement_changed` shape).
 */
export const RescheduleInstallmentPlanSchema = z
  .object({
    rescheduleId: uuid,
    expectedOutstandingMinor: minorUnits,
    /** Supplied, and bound by the digest: a reschedule's admissibility is judged at a stated date, never at the server's. */
    asOf: civilDate,
    remainderPlacement: z.enum(REMAINDER_PLACEMENTS).optional(),
    installments: z.array(InstallmentLineSchema).min(1).max(MAX_INSTALLMENTS),
  })
  .strict();

/**
 * Cancelling a plan removes the SCHEDULE and nothing else.
 *
 * The receivable is untouched, because the schedule never held it: after a
 * cancellation the invoice owes exactly what it owed a moment before, and
 * `invoice_outstanding` returns the same figure. That is the clearest possible
 * statement of law 1, and it is why no amount, no account and no posting
 * appears on this request.
 *
 * `reason` is required: `installments.manage` is sensitive, and a sensitive
 * command that records no reason is a change nobody can review.
 */
export const CancelInstallmentPlanSchema = z
  .object({
    cancellationId: uuid,
    asOf: civilDate,
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

// ── Reads ────────────────────────────────────────────────────────────────

/** `GET /v1/installment-plans/:planId` — the plan, projected at a supplied as-of date. */
export const InstallmentPlanQuerySchema = z.object({ asOf: civilDate }).strict();

/** `GET /v1/installment-plans/:planId/installments` — the keyset page over one plan's schedule. */
export const InstallmentPageQuerySchema = z
  .object({
    asOf: civilDate,
    cursor: installmentCursor.optional(),
    limit: pageLimit.optional(),
  })
  .strict();

/** `GET /v1/customers/:customerId/statement` — the keyset page over the customer's debt history. */
export const CustomerStatementQuerySchema = z
  .object({
    asOf: civilDate,
    /** Supplied, and the page never silently widens: an omitted `from` means "from the beginning", stated. */
    from: civilDate.optional(),
    cursor: statementCursor.optional(),
    limit: pageLimit.optional(),
  })
  .strict();

/** `GET /v1/customers/:customerId/debts` — the keyset page over the customer's open debts at a supplied as-of date. */
export const CustomerDebtsQuerySchema = z
  .object({
    asOf: civilDate,
    cursor: statementCursor.optional(),
    limit: pageLimit.optional(),
  })
  .strict();

/**
 * `GET /v1/installment-plans/:planId/aging` — the SCHEDULE-GRAIN aging of ONE
 * plan.
 *
 * Scoped to one plan on purpose. `customer_ar_aging` is the aging of record
 * and this is not a second one: it cannot be asked for a customer, so it
 * cannot be summed into a competing customer balance. See the contract pack
 * and `PATCH-REQ-S7-001`.
 */
export const InstallmentPlanAgingQuerySchema = z.object({ asOf: civilDate, bucketDays }).strict();

export type CreateInstallmentPlanRequest = z.infer<typeof CreateInstallmentPlanSchema>;
export type RescheduleInstallmentPlanRequest = z.infer<typeof RescheduleInstallmentPlanSchema>;
export type CancelInstallmentPlanRequest = z.infer<typeof CancelInstallmentPlanSchema>;
export type InstallmentPlanQuery = z.infer<typeof InstallmentPlanQuerySchema>;
export type InstallmentPageQuery = z.infer<typeof InstallmentPageQuerySchema>;
export type CustomerStatementQuery = z.infer<typeof CustomerStatementQuerySchema>;
export type CustomerDebtsQuery = z.infer<typeof CustomerDebtsQuerySchema>;
export type InstallmentPlanAgingQuery = z.infer<typeof InstallmentPlanAgingQuerySchema>;
