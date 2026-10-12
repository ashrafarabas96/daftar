/**
 * THE FOUR NAMED CUSTOMER METRICS.
 *
 * They are exactly four, they are named separately, and each carries its own
 * definition and its own conservation law:
 *
 *   1. LAST PURCHASE        — implemented here, as a pure function.
 *   2. PURCHASE FREQUENCY   — implemented here, as a pure function.
 *   3. NET SALES VALUE      — DECLARED AND REFUSING. See `netSalesValue`.
 *   4. AR AGING             — DECLARED AND REFUSING. See `arAging`.
 *
 * A surface shows one of the four or it shows nothing. There is deliberately no
 * fifth, single, authoritative-looking per-customer number in this module, and
 * there is no vocabulary for one: the ambiguous aggregate is forbidden by name,
 * and `test/metrics.test.ts` scans this file's own source text for the
 * forbidden identifiers and fails if any of them reappears. The prohibition is
 * on the TERM and not merely on the field, because a label outlives the field
 * it was invented for and the next implementer reads the label as a
 * specification.
 *
 * WHAT THIS MODULE MAY AND MAY NOT DO
 *
 * It may count a set the sales authority defines, and it may select the maximum
 * of that set under the authority's own ordering. Counting and selecting over a
 * set somebody else defines is grouping, not computing.
 *
 * It may NOT compute a financial sum. Not as a fold over document headers, not
 * as a per-customer loop over a scalar reader, not "as an interim
 * approximation". The header total of a sale document is the ORIGINAL total and
 * is not net of returns, so a money figure folded out of document headers is
 * precisely the figure the sales authority's own named inequality forbids. The
 * one definition that owns a net figure is called through the ports in
 * `./ports`, or the metric refuses. Nothing here is stored, projected, rolled
 * up, cached or materialised: every answer is derived at the moment it is
 * asked.
 *
 * THE CLOCK IS NEVER READ. No clock-reading call of any kind appears in this
 * file — the literal spellings are left out of this comment on purpose, so
 * that a future clock guard which greps before it strips comments does not
 * redden on a prose claim instead of on a live filter; that exact trap is
 * already documented in the tree. `asOf` and the interval are SUPPLIED by the
 * caller and travel on the answer, so two identical replays produce
 * byte-identical provenance and a golden test of the envelope can exist. The
 * civil-date helpers below do integer arithmetic on supplied strings; that is
 * date arithmetic, not a clock read, and it is written with no `Date` object so
 * that a future clock guard over this module has nothing to strip.
 */

import { refuse } from './errors';
import type { SaleSummaryRow } from './ports';
import type {
  AnalyticsInterval,
  AnalyticsScope,
  Derived,
  OnDemandProvenance,
  SourceDefinitionRef,
} from './provenance';

/* ------------------------------------------------------------------------- *
 * The authority's own status set, and why this module re-checks it
 * ------------------------------------------------------------------------- */

/**
 * The sale document's status domain, as the sale authority's own state CHECK
 * (`sales_state_ck`) enumerates it. This is the authority's closed set, copied
 * and not chosen: picking a different set here would be a second truth in its
 * cheapest form, a `WHERE` clause.
 */
export type SaleDocumentStatus = 'draft' | 'confirmed' | 'returned_partial' | 'returned_full' | 'void';

/**
 * COMMITTED NON-VOID: exactly the statuses the authority's state CHECK pairs
 * with `confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL AND voided_at IS
 * NULL`.
 *
 * `'draft'` is not committed. `'void'` is void. A RETURNED sale is still a
 * committed non-void sale and IS in this set: a return is a later commercial
 * fact, not an un-happening of the purchase.
 */
export const COMMITTED_NON_VOID_STATUSES: readonly SaleDocumentStatus[] = [
  'confirmed',
  'returned_partial',
  'returned_full',
];

export function isCommittedNonVoid(status: SaleDocumentStatus): boolean {
  return COMMITTED_NON_VOID_STATUSES.includes(status);
}

/**
 * The row these metrics are computed over.
 *
 * MEASURED GAP, recorded rather than papered over: the port row shape
 * (`src/ports.ts:18-24`) carries no `status` column, and its docstring states
 * that the port returns committed non-void sales already. Both can be true and
 * the metric still needs the column, for one reason: a conservation law that
 * cannot see a `'draft'` or a `'void'` candidate cannot catch a status-set
 * drift upstream, and a status-set drift is the first defect this metric's law
 * exists to catch. So the status travels on the row, this module filters by it
 * again, and the duplicated filter is the point.
 *
 * The adapter that maps the sales authority's read onto this shape is a
 * Phase-4-seal item and is not written here; the authority's modules are not
 * present on this branch at all.
 */
export interface MetricSaleRow extends SaleSummaryRow {
  readonly status: SaleDocumentStatus;
}

/* ------------------------------------------------------------------------- *
 * Failures: a refusal is the caller's business, a breached law is a bug
 * ------------------------------------------------------------------------- */

/**
 * A breached conservation law or a malformed input. It is deliberately NOT one
 * of the refusal codes: a refusal is an honest answer to a caller who could
 * have asked differently, whereas a breached law means this module computed
 * something wrong and the caller can do nothing about it. Each instance names
 * the law or rule that turned red, because a generic failure names no law.
 */
export class AnalyticsContractViolation extends Error {
  readonly law: string;
  readonly detail: Readonly<Record<string, string>>;

  constructor(law: string, message: string, detail: Readonly<Record<string, string>> = {}) {
    super(`${law}: ${message}`);
    this.name = 'AnalyticsContractViolation';
    this.law = law;
    this.detail = detail;
  }
}

function violate(law: string, message: string, detail?: Readonly<Record<string, string>>): never {
  throw new AnalyticsContractViolation(law, message, detail);
}

/* ------------------------------------------------------------------------- *
 * Civil dates: validated, compared and stepped without a clock
 * ------------------------------------------------------------------------- */

const CIVIL_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

interface CivilDateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * A `YYYY-MM-DD` shape check PLUS a real-calendar refinement, so `2026-02-30`
 * is REFUSED rather than coerced into the first of March. This mirrors the
 * live `civilDate` discipline, which pairs the regex with a round-trip check
 * for the same reason.
 */
export function parseCivilDate(value: string, field: string): CivilDateParts {
  if (!CIVIL_DATE_SHAPE.test(value)) {
    violate('L-DATE-1', `${field} is not a YYYY-MM-DD civil date`, { field, value });
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    violate('L-DATE-1', `${field} is not a date that exists in the calendar`, { field, value });
  }
  return { year, month, day };
}

/**
 * Civil dates in `YYYY-MM-DD` sort lexicographically in calendar order, which
 * is the whole reason the shape is fixed-width and zero-padded. Both operands
 * are validated first, so this never compares a malformed string.
 */
function compareCivilDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The civil successor of a supplied date, by integer arithmetic. Needed to
 * prove that two adjacent sub-intervals of an inclusive/inclusive partition
 * leave no day uncovered between them: a gap of one day is invisible to a
 * lexicographic comparison and is exactly the boundary defect the additivity
 * law exists to catch.
 */
export function nextCivilDate(value: string): string {
  const { year, month, day } = parseCivilDate(value, 'date');
  let y = year;
  let m = month;
  let d = day + 1;
  if (d > daysInMonth(y, m)) {
    d = 1;
    m += 1;
  }
  if (m > 12) {
    m = 1;
    y += 1;
  }
  const yy = String(y).padStart(4, '0');
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/**
 * The boundary convention, stated once and applied everywhere in this module:
 * `from` inclusive, `to` inclusive. It is stated in code rather than carried on
 * the interval because the live interval type has no field for it; see the
 * recorded tension in this module's header note on the interval shape below.
 */
export function intervalContains(interval: AnalyticsInterval, documentDate: string): boolean {
  return (
    compareCivilDates(documentDate, interval.from) >= 0 && compareCivilDates(documentDate, interval.to) <= 0
  );
}

function requireWellFormedInterval(interval: AnalyticsInterval, field: string): void {
  parseCivilDate(interval.from, `${field}.from`);
  parseCivilDate(interval.to, `${field}.to`);
  if (compareCivilDates(interval.from, interval.to) > 0) {
    violate('L-DATE-2', `${field} ends before it begins`, { from: interval.from, to: interval.to });
  }
}

/* ------------------------------------------------------------------------- *
 * The request shape and the provenance every answer carries
 * ------------------------------------------------------------------------- */

/**
 * NOTE ON THE INTERVAL LABEL, recorded as a tension and not resolved here.
 * The design document labels an analytical window `kind: 'sales_interval'` and
 * carries an explicit `boundary` and `label` on it. The live interval type in
 * `src/provenance.ts:16-20` offers `'calendar_range' | 'accounting_period' |
 * 'rolling_window'` and carries neither `boundary` nor `label`. That file is
 * not this task's to edit, so a sales window is carried here as
 * `'calendar_range'` — the one of the three that is honestly a labelled pair of
 * supplied dates and is NOT an accounting period. Phase 13 never infers a
 * period from two dates, so `'accounting_period'` is never synthesised here.
 */
export interface MetricRequest {
  readonly customerId: string;
  /** SUPPLIED. Never the machine clock. There is no default and no `?? today`. */
  readonly asOf: string;
  /** WHICH set was answered over. Required, so it cannot be dropped silently. */
  readonly scope: AnalyticsScope;
}

export interface WindowedMetricRequest extends MetricRequest {
  /**
   * Typed as nullable on purpose: a window question with no window must be
   * REFUSABLE at this boundary, and a refusal that cannot be reached is a
   * refusal that is never tested.
   */
  readonly interval: AnalyticsInterval | null;
}

function onDemandProvenance(
  asOf: string,
  interval: AnalyticsInterval,
  scope: AnalyticsScope,
  sourceDefinition: SourceDefinitionRef,
): OnDemandProvenance {
  return { mode: 'on_demand', asOf, interval, sourceDefinition, scope };
}

/**
 * The one definition both implemented metrics read: the sales authority's own
 * committed non-void document set. Named on every answer, because an answer
 * whose figure cannot be traced to a definition is a figure with no authority.
 */
export const COMMITTED_SALE_SET_DEFINITION: SourceDefinitionRef = {
  definition: 'sales.committed_non_void_sale_documents',
};

/* ------------------------------------------------------------------------- *
 * METRIC 1 — LAST PURCHASE
 * ------------------------------------------------------------------------- */

/**
 * The answer is a REFERENCE TO A SALE DOCUMENT, not a bare date: a date with no
 * document behind it cannot be reconciled against anything.
 *
 * `L-LASTP-2`, as a named inequality this shape is built to respect:
 * last purchase != last invoice != last payment != last visit. Those are four
 * different documents with four different authorities, and a surface that
 * labels any of them "last purchase" has created the forbidden ambiguity with a
 * date instead of a number. Nothing in this module reads an invoice, a payment
 * or a visit.
 */
export interface LastPurchaseSaleRef {
  readonly saleId: string;
  readonly customerId: string;
  readonly documentDate: string;
  readonly status: SaleDocumentStatus;
}

export interface LastPurchaseAnswer {
  /** `null` means NO PURCHASE — a stated absence, never a blank cell. */
  readonly sale: LastPurchaseSaleRef | null;
  /**
   * The cardinality of the candidate set, REPORTED. `candidateCount === 0` iff
   * `sale === null`, which is what makes "no purchase" distinguishable from a
   * read that failed and rendered empty.
   */
  readonly candidateCount: number;
}

/**
 * LAST PURCHASE — the latest canonical committed non-void sale for the customer
 * at the supplied `asOf`.
 *
 * The ordering is the sale document's own: the maximum of the tuple
 * `(documentDate, saleId)`. NEVER an insertion timestamp and never a
 * confirmation timestamp — `documentDate` is the business date, and two sales
 * entered out of order on one day would otherwise swap.
 *
 * `L-LASTP-1` is enforced here, as three executable checks over the returned
 * answer rather than as a comment:
 *   1. MEMBERSHIP  — the answer is one of the input rows that passed the filter;
 *   2. MAXIMALITY  — no candidate has a strictly greater `(documentDate, saleId)`;
 *   3. CARDINALITY — `candidateCount === 0` iff the answer is "no purchase".
 */
export function lastPurchase(
  rows: readonly MetricSaleRow[],
  request: MetricRequest,
): Derived<LastPurchaseAnswer> {
  parseCivilDate(request.asOf, 'asOf');

  const candidates = rows.filter((row) => {
    if (row.customerId !== request.customerId) return false;
    if (!isCommittedNonVoid(row.status)) return false;
    parseCivilDate(row.documentDate, 'row.documentDate');
    return compareCivilDates(row.documentDate, request.asOf) <= 0;
  });

  let winner: MetricSaleRow | null = null;
  for (const row of candidates) {
    if (winner === null || compareSaleOrdering(row, winner) > 0) winner = row;
  }

  const answer: LastPurchaseAnswer = {
    sale:
      winner === null
        ? null
        : {
            saleId: winner.saleId,
            customerId: request.customerId,
            documentDate: winner.documentDate,
            status: winner.status,
          },
    candidateCount: candidates.length,
  };

  assertLastPurchaseLaw(rows, request, answer);

  // The answer is a point-in-time question, but the live provenance shape
  // requires an interval, so the degenerate interval [asOf, asOf] is carried
  // and is honest: it is the window the question was asked over.
  const interval: AnalyticsInterval = { kind: 'calendar_range', from: request.asOf, to: request.asOf };
  return {
    value: answer,
    provenance: onDemandProvenance(request.asOf, interval, request.scope, COMMITTED_SALE_SET_DEFINITION),
  };
}

function compareSaleOrdering(a: MetricSaleRow, b: MetricSaleRow): number {
  const byDate = compareCivilDates(a.documentDate, b.documentDate);
  if (byDate !== 0) return byDate;
  return a.saleId < b.saleId ? -1 : a.saleId > b.saleId ? 1 : 0;
}

/**
 * `L-LASTP-1`, executable. Exported so a conservation harness can assert the
 * law against an answer it did not itself produce — an algorithm compared to
 * itself proves nothing.
 */
export function assertLastPurchaseLaw(
  rows: readonly MetricSaleRow[],
  request: MetricRequest,
  answer: LastPurchaseAnswer,
): void {
  const candidates = rows.filter(
    (row) =>
      row.customerId === request.customerId &&
      isCommittedNonVoid(row.status) &&
      compareCivilDates(row.documentDate, request.asOf) <= 0,
  );

  if (answer.candidateCount !== candidates.length) {
    violate('L-LASTP-1', 'the reported candidate cardinality is not the candidate set size', {
      reported: String(answer.candidateCount),
      actual: String(candidates.length),
    });
  }

  // Line 3 — cardinality 0 iff "no purchase".
  if ((candidates.length === 0) !== (answer.sale === null)) {
    violate('L-LASTP-1', 'an empty candidate set must answer "no purchase", and a non-empty one must not', {
      candidateCount: String(candidates.length),
      sale: answer.sale === null ? 'null' : answer.sale.saleId,
    });
  }
  if (answer.sale === null) return;

  // Line 1 — membership. Catches a status-set drift: a draft or a void selected.
  const member = candidates.find((row) => row.saleId === answer.sale?.saleId);
  if (member === undefined) {
    violate('L-LASTP-1', 'the answer is not a member of the canonical committed non-void candidate set', {
      saleId: answer.sale.saleId,
      asOf: request.asOf,
    });
  }
  if (member.documentDate !== answer.sale.documentDate || member.status !== answer.sale.status) {
    violate('L-LASTP-1', 'the answer misreports the document it points at', { saleId: answer.sale.saleId });
  }

  // Line 2 — maximality. Catches an ordering drift, which reorders same-day sales.
  for (const row of candidates) {
    if (compareSaleOrdering(row, member) > 0) {
      violate('L-LASTP-1', 'a candidate is strictly later than the answer on (documentDate, saleId)', {
        answerSaleId: member.saleId,
        answerDocumentDate: member.documentDate,
        greaterSaleId: row.saleId,
        greaterDocumentDate: row.documentDate,
      });
    }
  }
}

/* ------------------------------------------------------------------------- *
 * METRIC 2 — PURCHASE FREQUENCY
 * ------------------------------------------------------------------------- */

/**
 * Three separately named fields, never one. A count is the one aggregate that
 * is not a second truth: the authority defines the SET, and counting a set the
 * authority defines is grouping.
 *
 * `L-FREQ-2`, as a named inequality: `saleCount != netOrderCount`, and the two
 * are NEVER rendered under one label. Where only one number fits on a screen
 * the surface shows `saleCount` and names it, because that is the one the
 * definition calls PURCHASE FREQUENCY.
 */
export interface PurchaseFrequencyAnswer {
  /** Count of canonical committed sale DOCUMENTS in the interval. Never lines. */
  readonly saleCount: number;
  /** Count of canonical RETURN documents of that same set, in the same interval. */
  readonly returnCount: number;
  /**
   * Present ONLY when the caller explicitly asked for it. `saleCount` minus the
   * count of sales whose status is `'returned_full'`; a PARTIAL return does not
   * remove a purchase from the count.
   */
  readonly netOrderCount?: number;
}

export interface PurchaseFrequencyOptions {
  /** Opt-in, per the definition: absent means the field is absent from the answer. */
  readonly includeNetOrderCount?: boolean;
}

/**
 * PURCHASE FREQUENCY — a count of canonical committed sales over an EXPLICIT
 * interval. There is no default window: a window question with no window
 * refuses `analytics.interval_required`, because a report that supplies its own
 * window is the machine clock asked to supply one.
 *
 * Returns are counted SEPARATELY from purchases.
 */
export function purchaseFrequency(
  rows: readonly MetricSaleRow[],
  request: WindowedMetricRequest,
  options: PurchaseFrequencyOptions = {},
): Derived<PurchaseFrequencyAnswer> {
  parseCivilDate(request.asOf, 'asOf');
  const interval = request.interval;
  if (interval === null) {
    refuse(
      'analytics.interval_required',
      'PURCHASE FREQUENCY is a count over an explicit interval and no interval was supplied',
      { customerId: request.customerId },
    );
  }
  requireWellFormedInterval(interval, 'interval');

  const answer = countOverInterval(rows, request.customerId, interval, options);

  return {
    value: answer,
    provenance: onDemandProvenance(request.asOf, interval, request.scope, COMMITTED_SALE_SET_DEFINITION),
  };
}

function inScope(row: MetricSaleRow, customerId: string, interval: AnalyticsInterval): boolean {
  if (row.customerId !== customerId) return false;
  if (!isCommittedNonVoid(row.status)) return false;
  parseCivilDate(row.documentDate, 'row.documentDate');
  return intervalContains(interval, row.documentDate);
}

function countOverInterval(
  rows: readonly MetricSaleRow[],
  customerId: string,
  interval: AnalyticsInterval,
  options: PurchaseFrequencyOptions,
): PurchaseFrequencyAnswer {
  let saleCount = 0;
  let returnCount = 0;
  let returnedFullCount = 0;

  for (const row of rows) {
    if (!inScope(row, customerId, interval)) continue;
    if (row.isReturn) {
      returnCount += 1;
      continue;
    }
    saleCount += 1;
    if (row.status === 'returned_full') returnedFullCount += 1;
  }

  if (options.includeNetOrderCount === true) {
    return { saleCount, returnCount, netOrderCount: saleCount - returnedFullCount };
  }
  return { saleCount, returnCount };
}

/**
 * `L-FREQ-1`, line 4 — ADDITIVITY OVER A PARTITION OF THE INTERVAL, executable.
 *
 * This is the line that earns its place. A single happy-path count passes with
 * an inclusive/exclusive boundary error, with a double-counted boundary day and
 * with a dropped one; only splitting the interval and adding the parts can see
 * any of the three. The parts are checked to BE a partition first — contiguous
 * by civil successor, starting at `from`, ending at `to`, non-overlapping —
 * because adding up the parts of a non-partition proves nothing.
 *
 * Returns the whole-interval answer, so a caller gets the figure and the proof
 * from one call.
 */
export function assertFrequencyAdditivity(
  rows: readonly MetricSaleRow[],
  request: WindowedMetricRequest,
  parts: readonly AnalyticsInterval[],
  options: PurchaseFrequencyOptions = {},
): Derived<PurchaseFrequencyAnswer> {
  const whole = request.interval;
  if (whole === null) {
    refuse('analytics.interval_required', 'additivity is asserted over an interval and none was supplied', {
      customerId: request.customerId,
    });
  }
  assertIsPartition(whole, parts);

  const wholeAnswer = purchaseFrequency(rows, request, options);

  let saleSum = 0;
  let returnSum = 0;
  let netSum = 0;
  for (const part of parts) {
    const partAnswer = countOverInterval(rows, request.customerId, part, options);
    saleSum += partAnswer.saleCount;
    returnSum += partAnswer.returnCount;
    netSum += partAnswer.netOrderCount ?? 0;
  }

  if (saleSum !== wholeAnswer.value.saleCount) {
    violate('L-FREQ-1', 'saleCount is not additive over a partition of the interval', {
      interval: `${whole.from}..${whole.to}`,
      partitionSum: String(saleSum),
      wholeInterval: String(wholeAnswer.value.saleCount),
      parts: parts.map((p) => `${p.from}..${p.to}`).join(','),
    });
  }
  if (returnSum !== wholeAnswer.value.returnCount) {
    violate('L-FREQ-1', 'returnCount is not additive over a partition of the interval', {
      interval: `${whole.from}..${whole.to}`,
      partitionSum: String(returnSum),
      wholeInterval: String(wholeAnswer.value.returnCount),
    });
  }
  const wholeNet = wholeAnswer.value.netOrderCount;
  if (wholeNet !== undefined && netSum !== wholeNet) {
    violate('L-FREQ-1', 'netOrderCount is not additive over a partition of the interval', {
      interval: `${whole.from}..${whole.to}`,
      partitionSum: String(netSum),
      wholeInterval: String(wholeNet),
    });
  }

  return wholeAnswer;
}

/**
 * A real partition check, under the inclusive/inclusive boundary convention:
 * the parts in order must begin at the whole's `from`, end at its `to`, and
 * each next part must begin on the CIVIL SUCCESSOR of the previous part's `to`.
 * Successor equality is what rejects both an overlap (a repeated boundary day)
 * and a gap (a skipped one); a lexicographic "less than" cannot see either.
 */
export function assertIsPartition(whole: AnalyticsInterval, parts: readonly AnalyticsInterval[]): void {
  requireWellFormedInterval(whole, 'interval');
  if (parts.length === 0) {
    violate('L-FREQ-1', 'an empty list of sub-intervals is not a partition', {
      interval: `${whole.from}..${whole.to}`,
    });
  }
  parts.forEach((part, index) => requireWellFormedInterval(part, `parts[${index}]`));

  const first = parts[0];
  const last = parts[parts.length - 1];
  if (first === undefined || last === undefined) {
    violate('L-FREQ-1', 'the sub-interval list is not indexable', {});
  }
  if (first.from !== whole.from) {
    violate('L-FREQ-1', 'the partition does not begin where the interval begins', {
      expected: whole.from,
      actual: first.from,
    });
  }
  if (last.to !== whole.to) {
    violate('L-FREQ-1', 'the partition does not end where the interval ends', {
      expected: whole.to,
      actual: last.to,
    });
  }
  for (let i = 1; i < parts.length; i += 1) {
    const previous = parts[i - 1];
    const current = parts[i];
    if (previous === undefined || current === undefined) continue;
    const expected = nextCivilDate(previous.to);
    if (current.from !== expected) {
      violate('L-FREQ-1', 'adjacent sub-intervals neither meet nor are disjoint by one civil day', {
        previousTo: previous.to,
        expectedNextFrom: expected,
        actualNextFrom: current.from,
      });
    }
  }
}

/* ------------------------------------------------------------------------- *
 * METRIC 3 — NET SALES VALUE: declared, and refusing
 * ------------------------------------------------------------------------- */

/**
 * NET SALES VALUE must come from the Sales/Accounting authority's canonical
 * SET-BASED read, including returns and credit notes, according to the accepted
 * revenue definition. Therefore, and this is the whole of it: THIS PHASE DOES
 * NOT COMPUTE THIS FIGURE.
 *
 * MEASURED, 2026-10-12: the modules that own the canonical sales, point-of-sale
 * and receivables reads DO NOT EXIST on this branch. There is no set-based
 * customer-scoped net-sales reader to call. So this function REFUSES. It does
 * not return `0n`.
 *
 * A zero would be the dangerous option, and the reason is not pedantry: a zero
 * is a number, a number reaches a screen, and a merchant sets credit terms on
 * what is on the screen. A figure with a caveat attached is also a figure,
 * because the caveat is what gets dropped on the way to the screen. Nothing is
 * the only honest answer, and `analytics.waiting_for_integrated_surface` is how
 * nothing is said out loud.
 *
 * When the authority's set-based sibling lands, the owning authority writes it
 * and this function becomes a call to it holding no arithmetic. The bigint
 * return type is declared now so that the signature is a promise about MONEY:
 * minor units in `bigint`, never a float, because the eighteen-digit minor
 * figure does not survive a JavaScript `number`.
 */
export function netSalesValue(_rows: readonly MetricSaleRow[], request: WindowedMetricRequest): Derived<bigint> {
  refuse(
    'analytics.waiting_for_integrated_surface',
    'NET SALES VALUE comes from the sales authority canonical set-based read, which is not present on this branch; this phase never reimplements the sum',
    { customerId: request.customerId, asOf: request.asOf },
  );
}

/**
 * The named inequality `L-NETSALES-1`, written down as a function so it can be
 * ASSERTED and made to FAIL rather than described.
 *
 * The fold over document headers is NOT this metric. It is the standing
 * temptation, and it is wrong for a citable reason: the header total is the
 * ORIGINAL total and is not net of returns. This function exists only to be
 * the left-hand side of an inequality in a test. It is not exported as a
 * metric, it is not a fallback, and it is never rendered.
 */
export function documentHeaderFoldThatIsNotNetSalesValue(
  rows: readonly MetricSaleRow[],
  customerId: string,
  interval: AnalyticsInterval,
): bigint {
  let total = 0n;
  for (const row of rows) {
    if (!inScope(row, customerId, interval)) continue;
    total += row.netTxnMinor;
  }
  return total;
}

/* ------------------------------------------------------------------------- *
 * METRIC 4 — AR AGING: declared, and refusing
 * ------------------------------------------------------------------------- */

/** A band of the aged answer. Money in `bigint` minor units, never a float. */
export interface ArAgingBand {
  /** 1-BASED, as the authority's own bucket numbering is. */
  readonly bucketNo: number;
  readonly outstandingMinor: bigint;
}

/**
 * AR AGING — via the Phase 4 / S7 canonical readers ONLY.
 *
 * The outstanding AR of an invoice is the one settlement-sum definition the
 * receivables authority owns "and nothing else — not a stored column ..., not a
 * sum computed here, and not the journal"
 * (`apps/api/src/modules/receivables/receivables-reads.ts:19-26`, read at
 * `93084f8`). "Only" closes the door on every substitute: not the journal's AR
 * control account, not a sum of payment allocations or credit applications, and
 * not a privately aged copy.
 *
 * MEASURED, 2026-10-12: that module is not on this branch. So this REFUSES,
 * for the same reason as NET SALES VALUE and with the same code. It does not
 * return an empty band list either: an empty aged answer renders as a customer
 * who owes nothing, which is a figure.
 */
export function arAging(request: MetricRequest & { readonly bucketDays: readonly number[] }): Derived<
  readonly ArAgingBand[]
> {
  refuse(
    'analytics.waiting_for_integrated_surface',
    'AR AGING comes from the Phase 4 S7 canonical receivables readers only, and that authority is not present on this branch',
    {
      customerId: request.customerId,
      asOf: request.asOf,
      bucketDays: request.bucketDays.join(','),
    },
  );
}
