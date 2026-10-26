/**
 * P4-S4 — THE 1-BASED `bucket_no`, MEASURED AGAINST THE INSTALLED DATABASE.
 *
 * `tests/guards/p4s4-customer-aging-bucket-mapping.test.ts` proves the MAPPING:
 * given a 1-based `bucket_no`, `foldCustomerAging` places it at
 * `bucket_no - 1`, refuses anything it cannot place, and the old
 * `buckets[r.bucket_no]` goes red. Every one of those twelve cases is pure, and
 * every one of them rests on a premise it cannot itself check:
 *
 *     that `customer_ar_aging(...)` really is 1-BASED IN THE INSTALLED DATABASE.
 *
 * That premise was read out of `0084`'s text — `1 + (SELECT count(*) …)` — and
 * reading a migration body is not measuring the function that is installed.
 * This project has a recorded scar for exactly that distinction: a ruling that
 * stood on a migration body a LATER migration had already replaced. `0084` is
 * the live definition of `customer_ar_aging` today, so the premise is expected
 * to hold — but expecting is not measuring, and the whole financial fix rests
 * on this one fact.
 *
 * So this suite asks the database.
 *
 * ── THE CASE ─────────────────────────────────────────────────────────────
 *
 * A real credit invoice, committed through the real `POST /v1/sales`, with a
 * STATED due date. Then the aging is asked for as of a horizon 265 days past
 * that due date — comfortably past the last boundary, so the receivable
 * belongs to the oldest band and to no other.
 *
 * WHAT THE OLD CODE DID TO THIS EXACT CASE, stated carefully because the first
 * report of this defect got it wrong. The old fold's only index expression was
 * `buckets[r.bucket_no]`, and the SQL's smallest `bucket_no` is 1 — so index 0,
 * the `0-30` not-yet-due band, was never written by ANY row for ANY input. A
 * sole receivable in the oldest band therefore produced ALL FOUR BANDS ZERO
 * and `totalBaseMinor: '0'`. The debt was reported as NOT EXISTING, which is
 * worse than reported as current and is a different diagnosis. §C measures
 * exactly that, from the rows the installed function really returns.
 *
 * THE HORIZON MOVES, NOT THE INVOICE. The as-of date is the CALLER'S input —
 * the lock's §4 matrix makes aging "the AR journal plus a **supplied** as-of
 * date" — so a future horizon is a lawful question and needs no backdating, no
 * hand-written `due_date` and no clock manipulation. Writing `invoices.due_date`
 * directly would forge the document (P4-AL-24) and would prove something about
 * a row no command produced. Every figure here comes out of a real command or
 * out of the product's own SQL function.
 *
 * ── WHAT IS ASSERTED ─────────────────────────────────────────────────────
 *
 * §0 NON-VACUITY. The slice is installed, the invoice is a real open credit
 *    invoice carrying money, its due date is really not null, and the horizon
 *    really is 265 days past it — the interval measured BY POSTGRESQL, not by
 *    JavaScript date arithmetic, because a JS off-by-one here would decide the
 *    very claim this file exists to settle.
 * §A THE ORDINAL BASE, FROM THE INSTALLED FUNCTION. The oldest band comes back
 *    as `bucketDays.length + 1`, explicitly NOT as `bucketDays.length`, and a
 *    sweep of four horizons — one inside each band — returns 1, 2, 3, 4. That
 *    makes 1-basedness a measured property of the whole range, not an anecdote
 *    about its top.
 * §B THE DTO, DATABASE TO SCREEN. The route places that money in the FINAL
 *    band, `totalBaseMinor` carries it, the first band is `'0'`, and the
 *    conservation law holds three ways against the product's own
 *    `invoice_outstanding`.
 * §C THE REGRESSION, ON REAL ROWS. The measured `bucket_no` indexes PAST the
 *    end of the real labels array; the old fold run over the real rows reports
 *    `'0'` in EVERY band and in the total; and index 0 is shown to be
 *    unreachable for every ordinal the function can produce. The money
 *    disappearance, reproduced from live data.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { STANDARD_AGING_BUCKET_DAYS, agingBucketLabels } from '@daftar/domain-core';
import { ownerPool } from '../helpers/test-app';
import { must } from '../golden-regression/phase4-s4/harness';
import { confirmSale } from '../golden-regression/phase4-s2/sale-path';
import { newCustomer, settlementMissing, settlementWorld, stockUp, type SettlementWorld } from '../golden-regression/phase4-s4/settlement-world';

const CLAIM =
  'the INSTALLED customer_ar_aging returns a 1-BASED bucket_no, so a receivable 265 days past due lands in the OLDEST band of the DTO and its money is in totalBaseMinor';

/** The boundaries the caller supplies, and the labels they produce. */
const BUCKET_DAYS = [30, 60, 90] as const;
const LABELS = agingBucketLabels([...BUCKET_DAYS]);

/** The reported case. 265 > 90, so this is the oldest band and nothing else. */
const DAYS_PAST_DUE = 265;

/** One SQL row of the installed function, as the read selects it. */
interface AgingRow {
  bucket_no: number;
  currency_code: string | null;
  txn_minor: string | null;
  base_minor: string;
  invoice_count: number;
}

let w: SettlementWorld;
let missing: readonly string[] = [];

let customerId: string;
let invoiceId: string;
/** The due date this suite STATED on the sale, and the one the function reports back. */
let statedDueDate: string;
let reportedDueDate: string | null = null;
/** The product's OWN outstanding figures for that invoice — the oracle, never a reimplementation. */
let outstandingBaseMinor: string | null = null;
let outstandingTxnMinor: string | null = null;
let invoiceCurrency: string | null = null;

/** The horizon, and the interval PostgreSQL measures between it and the due date. */
let asOf: string;
let measuredDaysPastDue: number | null = null;

/** The installed function's answer at that horizon, and the route's. */
let sqlRows: readonly AgingRow[] = [];
let http: Response | undefined;
/** The same function at a horizon inside each band: the 1-based sweep. */
let sweep: readonly { readonly days: number; readonly bucketNos: readonly number[] }[] = [];

/**
 * DR-10 — the same installed function under the STANDARD boundaries
 * `[0, 30, 60, 90]`, swept across every boundary the decision names, plus the
 * route's answer on both sides of the due date.
 */
let standardSweep: readonly { readonly days: number; readonly bucketNos: readonly number[] }[] = [];
let standardHttpOverdue: Response | undefined;
let standardHttpNotDue: Response | undefined;

/**
 * DR-13 — a SECOND customer, whose only invoice states NO due date. It is kept
 * apart from the subject above on purpose: adding an invoice to that customer
 * would move every total §A to §C measures, and a proof that moves its own
 * subject proves nothing.
 */
let termlessCustomerId: string;
let termlessIssueDate: string;
let termlessOutstandingBaseMinor: string | null = null;
let termlessRows: readonly AgingRow[] = [];
let termlessSweep: readonly { readonly days: number; readonly bucketNos: readonly number[] }[] = [];
/** The route asked for the boundaries DR-14 retired, so the refusal is measured and not assumed. */
let legacyBucketDaysHttp: Response | undefined;

/** `date + n days`, computed in UTC and re-measured in the database before anything rests on it. */
function plusDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The installed `customer_ar_aging`, asked directly, in the read's own order. */
async function agingRows(at: string): Promise<readonly AgingRow[]> {
  const r = await ownerPool().query<AgingRow>(
    `SELECT a.bucket_no, a.currency_code, a.txn_minor::text AS txn_minor, a.base_minor::text AS base_minor, a.invoice_count
       FROM customer_ar_aging($1::uuid, $2::uuid, $3::date, $4::integer[]) a
      ORDER BY a.bucket_no, a.currency_code NULLS FIRST`,
    [w.shop.businessId, customerId, at, [...BUCKET_DAYS]],
  );
  return r.rows;
}

/** The installed `customer_ar_aging` under the STANDARD boundaries (DR-10). */
async function agingStandardRows(at: string): Promise<readonly AgingRow[]> {
  const r = await ownerPool().query<AgingRow>(
    `SELECT a.bucket_no, a.currency_code, a.txn_minor::text AS txn_minor, a.base_minor::text AS base_minor, a.invoice_count
       FROM customer_ar_aging($1::uuid, $2::uuid, $3::date, $4::integer[]) a
      ORDER BY a.bucket_no, a.currency_code NULLS FIRST`,
    [w.shop.businessId, customerId, at, [...STANDARD_AGING_BUCKET_DAYS]],
  );
  return r.rows;
}

/** The installed function under the STANDARD boundaries, for any customer. */
async function agingStandardRowsFor(id: string, at: string): Promise<readonly AgingRow[]> {
  const r = await ownerPool().query<AgingRow>(
    `SELECT a.bucket_no, a.currency_code, a.txn_minor::text AS txn_minor, a.base_minor::text AS base_minor, a.invoice_count
       FROM customer_ar_aging($1::uuid, $2::uuid, $3::date, $4::integer[]) a
      ORDER BY a.bucket_no, a.currency_code NULLS FIRST`,
    [w.shop.businessId, id, at, [...STANDARD_AGING_BUCKET_DAYS]],
  );
  return r.rows;
}

/** Σ `base_minor` over SQL rows — the oracle, summed here and never read off the DTO. */
function sumBase(rows: readonly AgingRow[]): bigint {
  return rows.reduce((acc, r) => acc + BigInt(r.base_minor), 0n);
}

/**
 * The OLD fold, for §C: `buckets[r.bucket_no]` and the silent `continue`,
 * exactly as `customer-reads.ts` stood at `54a851c`.
 *
 * KNOWINGLY A SECOND COPY of the one in
 * `tests/guards/p4s4-customer-aging-bucket-mapping.test.ts`, and DELIBERATELY
 * NOT SHARED with it. Do not "finish the job" by extracting a helper: a red
 * proof whose subject lives in a file neither suite owns can be weakened by
 * editing that subject, and both proofs then go green together and in
 * silence. The two also serve different subjects — that one runs over a
 * constructed fixture, this one over rows the installed function actually
 * produced. Two homes for a WRONG implementation is correct; two homes for a
 * truth is what the rule forbids.
 */
function oldFold(rows: readonly AgingRow[]): { readonly bands: readonly string[]; readonly totalBaseMinor: string } {
  const buckets = LABELS.map(() => '0');
  let total = 0n;
  for (const r of rows) {
    const current = buckets[r.bucket_no];
    if (current === undefined) continue; // ← the silence that dropped the money
    buckets[r.bucket_no] = (BigInt(current) + BigInt(r.base_minor)).toString();
    total += BigInt(r.base_minor);
  }
  return { bands: buckets, totalBaseMinor: total.toString() };
}

/**
 * The aging route, as a merchant client asks it.
 *
 * The boundaries here are the STANDARD set and not this suite's `BUCKET_DAYS`,
 * because DR-14 makes the standard set the only one the route offers: asking
 * for `30,60,90` now answers 400 `VALIDATION_FAILED`. `BUCKET_DAYS` is still
 * what §A and §C ask the installed FUNCTION directly, which takes any
 * well-formed set — the restriction is the product's, at the edge, not the
 * database's.
 */
function agingPath(at: string): string {
  return `/v1/customers/${customerId}/receivable/aging?asOf=${at}&bucketDays=${STANDARD_AGING_BUCKET_DAYS.join(',')}`;
}

/** The same route under the standard boundaries, which is also the proof the schema ACCEPTS a leading zero. */
function standardAgingPath(at: string): string {
  return `/v1/customers/${customerId}/receivable/aging?asOf=${at}&bucketDays=${STANDARD_AGING_BUCKET_DAYS.join(',')}`;
}

beforeAll(async () => {
  w = await settlementWorld('p4s4 aging oldest band');
  missing = await settlementMissing(w);
  if (missing.length > 0) return;

  await stockUp(w, '100', '1000');
  customerId = await newCustomer(w);

  // The due date is STATED and equals the document date: `sale.due_date_invalid`
  // refuses a due date BEFORE the document date (`0078:636`), and equal is the
  // earliest lawful one — which makes the whole interval below the horizon's.
  statedDueDate = w.day;
  const saleId = randomUUID();
  const sale = await confirmSale(w.t, w.headers, {
    saleId,
    customerId,
    warehouseId: w.shop.w1,
    branchId: w.shop.branchX,
    occurredOn: w.day,
    dueDate: statedDueDate,
    lines: [{ productId: w.shop.piece.productId, quantity: '3' }],
  });
  expect(sale.status, `the credit sale commits: ${JSON.stringify(sale.body)}`).toBeLessThan(300);

  const inv = await ownerPool().query<{ invoice_id: string; status: string; settlement_mode: string }>(
    `SELECT i.id::text AS invoice_id, i.status, s.settlement_mode
       FROM sales s JOIN invoices i ON i.business_id = s.business_id AND i.sale_id = s.id
      WHERE s.business_id = $1 AND s.id = $2`,
    [w.shop.businessId, saleId],
  );
  const row = must(inv.rows[0], `the committed sale ${saleId} and its invoice`);
  expect(row.status, 'an open invoice is the only status the reader of record reads (0075:722)').toBe('open');
  expect(row.settlement_mode, 'a receivable is a CREDIT invoice; a cash invoice reports nothing outstanding').toBe('credit');
  invoiceId = row.invoice_id;

  // THE ORACLE, out of the product's own set-based reader (`0084`, §5) — the
  // outstanding figures AND the due date, so neither is this file's own idea
  // of what the document says.
  const out = await ownerPool().query<{ outstanding_txn_minor: string; outstanding_base_minor: string; currency_code: string; due_date: string | null }>(
    `SELECT o.outstanding_txn_minor::text AS outstanding_txn_minor, o.outstanding_base_minor::text AS outstanding_base_minor,
            o.currency_code, o.due_date::text AS due_date
       FROM invoice_outstanding($1::uuid, ARRAY[$2::uuid]) o`,
    [w.shop.businessId, invoiceId],
  );
  const o = must(out.rows[0], `invoice_outstanding reports on invoice ${invoiceId}`);
  outstandingTxnMinor = o.outstanding_txn_minor;
  outstandingBaseMinor = o.outstanding_base_minor;
  invoiceCurrency = o.currency_code;
  reportedDueDate = o.due_date;

  asOf = plusDays(statedDueDate, DAYS_PAST_DUE);

  // THE INTERVAL, MEASURED BY POSTGRESQL. `plusDays` is JavaScript date
  // arithmetic and this claim is about days past due; if the two disagree, the
  // assertion in §0 fails rather than the suite quietly aging the wrong
  // interval and still going green.
  const span = await ownerPool().query<{ days: number }>(`SELECT ($1::date - $2::date)::int AS days`, [asOf, reportedDueDate ?? statedDueDate]);
  measuredDaysPastDue = must(span.rows[0], 'the database measures the interval').days;

  sqlRows = await agingRows(asOf);
  http = await w.t.request.get(agingPath(asOf)).set(w.headers);

  // One horizon inside each band: 0 days past due is band 1, and 45 / 75 / 265
  // sit inside (30,60], (60,90] and (90,∞) respectively.
  const probes = [0, 45, 75, DAYS_PAST_DUE];
  const collected: { days: number; bucketNos: number[] }[] = [];
  for (const days of probes) {
    const rows = await agingRows(plusDays(statedDueDate, days));
    collected.push({ days, bucketNos: rows.map((r) => r.bucket_no) });
  }
  sweep = collected;

  // DR-10. The SAME installed function, the SAME invoice, the standard
  // boundaries — asked at every boundary the decision names and one day either
  // side of each, so an off-by-one cannot hide between two probes.
  const standardProbes = [-45, -1, 0, 1, 30, 31, 60, 61, 90, 91];
  const standardCollected: { days: number; bucketNos: number[] }[] = [];
  for (const days of standardProbes) {
    const rows = await agingStandardRows(plusDays(statedDueDate, days));
    standardCollected.push({ days, bucketNos: rows.map((r) => r.bucket_no) });
  }
  standardSweep = standardCollected;

  standardHttpOverdue = await w.t.request.get(standardAgingPath(plusDays(statedDueDate, 45))).set(w.headers);
  standardHttpNotDue = await w.t.request.get(standardAgingPath(plusDays(statedDueDate, -10))).set(w.headers);

  // DR-14, measured at the edge: the boundaries the product used before are
  // refused now. Asked here rather than asserted from the schema, because the
  // claim is about what a client gets back.
  legacyBucketDaysHttp = await w.t.request.get(`/v1/customers/${customerId}/receivable/aging?asOf=${asOf}&bucketDays=${BUCKET_DAYS.join(',')}`).set(w.headers);

  // DR-13: a credit sale with NO due date. `dueDate` is `.nullable()` and not
  // optional, so stating null is the lawful way to say "no term" — and that is
  // the document this decision is about.
  termlessCustomerId = await newCustomer(w);
  termlessIssueDate = w.day;
  const termlessSaleId = randomUUID();
  const termlessSale = await confirmSale(w.t, w.headers, {
    saleId: termlessSaleId,
    customerId: termlessCustomerId,
    warehouseId: w.shop.w1,
    branchId: w.shop.branchX,
    occurredOn: termlessIssueDate,
    dueDate: null,
    lines: [{ productId: w.shop.piece.productId, quantity: '2' }],
  });
  expect(termlessSale.status, `the termless credit sale commits: ${JSON.stringify(termlessSale.body)}`).toBeLessThan(300);

  const termlessInv = await ownerPool().query<{ invoice_id: string; due_date: string | null; issue_date: string }>(
    `SELECT i.id::text AS invoice_id, i.due_date::text AS due_date, i.issue_date::text AS issue_date
       FROM sales s JOIN invoices i ON i.business_id = s.business_id AND i.sale_id = s.id
      WHERE s.business_id = $1 AND s.id = $2`,
    [w.shop.businessId, termlessSaleId],
  );
  const ti = must(termlessInv.rows[0], 'the termless invoice');
  // Non-vacuity: the document really states no due date, and really has an
  // issue date to fall back on.
  expect(ti.due_date, 'the termless invoice must have NO due date, or §F proves nothing').toBeNull();
  expect(ti.issue_date).toBe(termlessIssueDate);

  const termlessOut = await ownerPool().query<{ outstanding_base_minor: string }>(
    `SELECT o.outstanding_base_minor::text AS outstanding_base_minor FROM invoice_outstanding($1::uuid, ARRAY[$2::uuid]) o`,
    [w.shop.businessId, ti.invoice_id],
  );
  termlessOutstandingBaseMinor = must(termlessOut.rows[0], 'the termless outstanding').outstanding_base_minor;

  termlessRows = await agingStandardRowsFor(termlessCustomerId, plusDays(termlessIssueDate, 265));
  const termlessProbes = [0, 1, 30, 31, 91];
  const collectedTermless: { days: number; bucketNos: number[] }[] = [];
  for (const days of termlessProbes) {
    const rows = await agingStandardRowsFor(termlessCustomerId, plusDays(termlessIssueDate, days));
    collectedTermless.push({ days, bucketNos: rows.map((r) => r.bucket_no) });
  }
  termlessSweep = collectedTermless;
});

describe('§0 the measurement has a subject', () => {
  it('the P4-S4 settlement surface is installed, so nothing below is green about an absent slice', () => {
    expect(missing, `the slice is not installed: ${missing.join('; ')}`).toEqual([]);
  });

  it('there is a real open credit invoice, it carries money, and its DUE DATE is really not null', () => {
    expect(invoiceId).toBeTruthy();
    // `due_date IS NOT NULL` is a precondition of the SQL function's own
    // threshold test. A null due date counts zero thresholds, lands in band 1,
    // and would make this suite pass for the wrong reason.
    expect(reportedDueDate, 'a null due date never exceeds a threshold, so the oldest band would be unreachable').not.toBeNull();
    expect(reportedDueDate).toBe(statedDueDate);
    expect(outstandingBaseMinor).not.toBeNull();
    expect(BigInt(outstandingBaseMinor ?? '0') > 0n, 'NO SUBJECT — a zero outstanding makes every figure below 0 against 0').toBe(true);
    expect(BigInt(outstandingTxnMinor ?? '0') > 0n).toBe(true);
    expect(invoiceCurrency).toBeTruthy();
  });

  it('the horizon really is 265 days past the due date, as POSTGRESQL measures it', () => {
    expect(measuredDaysPastDue).toBe(DAYS_PAST_DUE);
    // And it is past the LAST boundary, which is what puts it in the oldest
    // band at all. Derived from the boundaries, not written as 90.
    expect(DAYS_PAST_DUE > Math.max(...BUCKET_DAYS)).toBe(true);
    expect(LABELS.length).toBe(BUCKET_DAYS.length + 1);
  });

  it('the installed function returned a row at all — the aging is not simply empty', () => {
    expect(sqlRows.length).toBeGreaterThan(0);
    expect(sumBase(sqlRows) > 0n, 'NO SUBJECT — the function reported no money, so no band can hold any').toBe(true);
  });
});

describe('§A the ORDINAL BASE of the installed customer_ar_aging', () => {
  it(`${CLAIM} — the oldest band comes back as bucketDays.length + 1`, () => {
    expect(sqlRows.length).toBe(1);
    const only = must(sqlRows[0], 'the one aging row');
    // THE LOAD-BEARING FACT, measured rather than read off a migration.
    expect(only.bucket_no).toBe(BUCKET_DAYS.length + 1);
    expect(only.bucket_no).toBe(4);
    // And explicitly NOT the 0-based reading. If the function were 0-based this
    // would be 3, every assertion above would still pass, and the fix would be
    // wrong in the opposite direction.
    expect(only.bucket_no).not.toBe(BUCKET_DAYS.length);
    expect(only.bucket_no).not.toBe(3);
    expect(only.base_minor).toBe(outstandingBaseMinor);
    expect(only.invoice_count).toBe(1);
  });

  it('1-basedness holds across the WHOLE range: a horizon inside each band returns 1, 2, 3, 4', () => {
    // A single top-of-range measurement is satisfied by an off-by-one that only
    // bites at the end. This sweep is the general statement.
    expect(sweep.length).toBe(4);
    expect(sweep.map((s) => s.days)).toEqual([0, 45, 75, DAYS_PAST_DUE]);
    for (const s of sweep) expect(s.bucketNos.length, `horizon +${s.days} returned no row`).toBe(1);
    expect(sweep.map((s) => s.bucketNos[0])).toEqual([1, 2, 3, 4]);
    // The lowest ordinal the function ever produces is 1, never 0.
    expect(Math.min(...sweep.map((s) => s.bucketNos[0] ?? 0))).toBe(1);
  });
});

describe('§B the DTO, from the database to the screen', () => {
  it('the route answers 200 with the five standard bands, in order', () => {
    expect(http?.status, `the aging read is accepted: ${JSON.stringify(http?.body)}`).toBe(200);
    const body = http?.body as { buckets?: { label?: string }[]; bucketDays?: number[] };
    // Five since DR-10, and the standard set since DR-14 — the route offers no
    // other, so this is the shape every client sees.
    expect(body.buckets?.length).toBe(STANDARD_AGING_BUCKET_DAYS.length + 1);
    expect(body.buckets?.map((b) => b.label)).toEqual([...agingBucketLabels([...STANDARD_AGING_BUCKET_DAYS])]);
    expect(body.bucketDays).toEqual([...STANDARD_AGING_BUCKET_DAYS]);
  });

  it(`a receivable ${DAYS_PAST_DUE} days past due is in the FINAL band, and its money is in totalBaseMinor`, () => {
    const body = http?.body as {
      buckets?: { label?: string; baseMinor?: string; invoiceCount?: number; byCurrency?: { currency?: string; txnMinor?: string }[] }[];
      totalBaseMinor?: string;
    };
    const buckets = body.buckets ?? [];
    const last = buckets[buckets.length - 1];
    expect(last?.label).toBe('over-90');
    expect(last?.baseMinor).toBe(outstandingBaseMinor);
    expect(last?.invoiceCount).toBe(1);
    expect(last?.byCurrency).toEqual([{ currency: invoiceCurrency, txnMinor: outstandingTxnMinor }]);
    expect(body.totalBaseMinor).toBe(outstandingBaseMinor);
  });

  it('THE DEFECT’S REAL SYMPTOM IS GONE: the aged debt no longer reads as ZERO', () => {
    const body = http?.body as { buckets?: { baseMinor?: string }[]; totalBaseMinor?: string };
    const buckets = body.buckets ?? [];
    // THIS is what the old code did to this case: every band `'0'` and a total
    // of `'0'` — the debt reported as not existing. Each half refused by name.
    expect(body.totalBaseMinor).not.toBe('0');
    expect(BigInt(body.totalBaseMinor ?? '0') > 0n).toBe(true);
    expect(
      buckets.some((b) => b.baseMinor !== '0'),
      'at least one band must hold the money',
    ).toBe(true);
    // And it is in the RIGHT band: the oldest, with the three younger ones
    // empty. The first band being `'0'` is correct here and is NOT evidence of
    // the fix on its own — under the old fold it was `'0'` too, because index 0
    // was unreachable. The evidence is the total and the final band together.
    // FOUR younger bands since DR-10 added the not-due one.
    expect(buckets.slice(0, -1).map((b) => b.baseMinor)).toEqual(['0', '0', '0', '0']);
    expect(buckets[buckets.length - 1]?.baseMinor).toBe(outstandingBaseMinor);
  });

  it('the conservation law holds three ways against the product’s own invoice_outstanding', () => {
    const body = http?.body as { buckets?: { baseMinor?: string }[]; totalBaseMinor?: string };
    const fromBuckets = (body.buckets ?? []).reduce((acc, b) => acc + BigInt(b.baseMinor ?? '0'), 0n);
    const owed = BigInt(outstandingBaseMinor ?? '0');
    expect(owed > 0n).toBe(true); // non-vacuity, where it is used
    expect(BigInt(body.totalBaseMinor ?? '0')).toBe(owed);
    expect(fromBuckets).toBe(owed);
    expect(BigInt(body.totalBaseMinor ?? '0')).toBe(fromBuckets);
    // A FOURTH reader, so the total is not just self-consistent: the aging and
    // the plain AR read are the same AR.
    expect(sumBase(sqlRows)).toBe(owed);
  });

  it('the live AR read agrees with the aging total — two readers, one receivable', async () => {
    const res = await w.t.request.get(`/v1/customers/${customerId}/receivable`).set(w.headers);
    expect(res.status, `the AR read is accepted: ${JSON.stringify(res.body)}`).toBe(200);
    const body = res.body as { baseMinor?: string };
    expect(body.baseMinor).toBe(outstandingBaseMinor);
    expect((http?.body as { totalBaseMinor?: string }).totalBaseMinor).toBe(body.baseMinor);
  });
});

describe('§C the old fold, run over the rows the installed function really produced', () => {
  it('the measured bucket_no indexes PAST the end of the real labels array', () => {
    const only = must(sqlRows[0], 'the one aging row');
    expect(sqlRows.length).toBeGreaterThan(0); // non-vacuity: there is a row to misplace
    // This is the defect in one line, stated about measured data and the real
    // labels array: the old code's index does not exist, and the right one is
    // the oldest band.
    expect(LABELS[only.bucket_no]).toBeUndefined();
    expect(LABELS[only.bucket_no - 1]).toBe('over-90');
  });

  it('the old fold reports ZERO IN EVERY BAND and in the total — the debt as NOT EXISTING, from live data', () => {
    const owed = sumBase(sqlRows);
    expect(owed > 0n, 'non-vacuity: the function reported money, so there is money to lose').toBe(true);
    const wrong = oldFold(sqlRows);
    // THE CORRECTED DIAGNOSIS, measured: not "reported as current" — reported
    // as nothing at all. Every band, not just the last.
    expect(wrong.bands.length).toBe(LABELS.length);
    expect([...wrong.bands]).toEqual(LABELS.map(() => '0'));
    expect(wrong.totalBaseMinor).toBe('0');
    // The gap is the WHOLE receivable, against the figure the screen now shows.
    expect(owed - BigInt(wrong.totalBaseMinor)).toBe(owed);
    expect(wrong.totalBaseMinor).not.toBe((http?.body as { totalBaseMinor?: string }).totalBaseMinor);
    expect((http?.body as { totalBaseMinor?: string }).totalBaseMinor).toBe(owed.toString());
  });

  it('index 0 — the not-yet-due band — was UNREACHABLE for every ordinal the function can produce', () => {
    // The second half of the corrected diagnosis, and the reason the first
    // report was wrong. `buckets[r.bucket_no]` can only write index 0 when
    // `bucket_no` is 0, and the installed function's minimum is 1 — measured
    // by the §A sweep, not assumed here.
    expect(sweep.length).toBeGreaterThan(0); // non-vacuity: the sweep ran
    const ordinals = sweep.flatMap((s) => [...s.bucketNos]);
    expect(ordinals.length).toBeGreaterThan(0);
    expect(Math.min(...ordinals)).toBe(1);
    for (const bucketNo of ordinals) {
      const wrong = oldFold([{ bucket_no: bucketNo, currency_code: 'USD', txn_minor: '1', base_minor: '1', invoice_count: 1 }]);
      expect(wrong.bands[0], `bucket_no ${bucketNo} must not be able to write the not-yet-due band`).toBe('0');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §E DR-10 — THE STANDARD AGING, AGAINST THE INSTALLED FUNCTION.
//
// The guard suite proves the FOLD under the standard boundaries with no
// database. What it cannot prove is that PostgreSQL bands the days the way the
// decision reads them, because the band arithmetic is in SQL. These cases ask
// the installed `customer_ar_aging` itself, over a real open credit invoice
// with a real due date, at every boundary the decision names — and one day
// either side of each, so an off-by-one cannot hide between two probes.
//
// `STANDARD_LABELS` is derived from product code, not written out here, so a
// change of label cannot pass by agreement with a copy in a test.
// ─────────────────────────────────────────────────────────────────────────────
const STANDARD_LABELS = agingBucketLabels([...STANDARD_AGING_BUCKET_DAYS]);

describe('§E DR-10 the standard aging as the database computes it', () => {
  it('the route ACCEPTS a leading zero, which is what asks for the not-due band', () => {
    // The schema used to refuse `0` outright (`min(1)`), so this is the
    // boundary case of the decision and not a formality.
    expect(standardHttpOverdue?.status, `bucketDays=0,30,60,90 is accepted: ${JSON.stringify(standardHttpOverdue?.body)}`).toBe(200);
    expect(standardHttpNotDue?.status).toBe(200);
    const body = standardHttpOverdue?.body as { buckets?: { label?: string; fromDays?: number | null; toDays?: number | null }[]; bucketDays?: number[] };
    expect(body.bucketDays).toEqual([...STANDARD_AGING_BUCKET_DAYS]);
    expect(body.buckets?.map((b) => b.label)).toEqual([...STANDARD_LABELS]);
    expect(body.buckets?.map((b) => b.fromDays)).toEqual([null, 1, 31, 61, 91]);
    expect(body.buckets?.map((b) => b.toDays)).toEqual([0, 30, 60, 90, null]);
  });

  it('every boundary the decision names falls on the side the decision names, as POSTGRESQL measures it', () => {
    expect(standardSweep.length).toBe(10); // non-vacuity: the sweep ran
    expect(standardSweep.map((s) => s.days)).toEqual([-45, -1, 0, 1, 30, 31, 60, 61, 90, 91]);
    for (const s of standardSweep) expect(s.bucketNos.length, `horizon ${s.days} returned no row`).toBe(1);
    // not due, not due, THE DUE DATE ITSELF, then 1-30 twice, 31-60 twice,
    // 61-90 twice, and the open band.
    expect(standardSweep.map((s) => s.bucketNos[0])).toEqual([1, 1, 1, 2, 2, 3, 3, 4, 4, 5]);
  });

  it('ON THE DUE DATE the invoice is NOT YET LATE: it is in the not-due band and in no overdue band', () => {
    const onDueDate = must(
      standardSweep.find((s) => s.days === 0),
      'the horizon on the due date',
    );
    expect(onDueDate.bucketNos).toEqual([1]);
    const firstLate = must(
      standardSweep.find((s) => s.days === 1),
      'the horizon one day after the due date',
    );
    expect(firstLate.bucketNos).toEqual([2]);
  });

  it('THE DEFECT DR-10 REMOVES: money not yet due is reported as not due, and the total is still the whole receivable', async () => {
    const owed = BigInt(must(outstandingBaseMinor, 'the product’s own outstanding figure'));
    const body = standardHttpNotDue?.body as { buckets?: { label?: string; baseMinor?: string; invoiceCount?: number }[]; totalBaseMinor?: string };

    // Ten days BEFORE the due date. Under the old standard `[30, 60, 90]` this
    // same invoice came back in the band labelled `0-30` — reported to the
    // merchant as up to thirty days late, when nobody owed it yet.
    const notDue = must(body.buckets?.[0], 'the not-due band');
    expect(notDue.label).toBe('not-due');
    expect(notDue.baseMinor).toBe(owed.toString());
    expect(notDue.invoiceCount).toBe(1);

    // And NOTHING in any overdue band: not the money, not the count.
    const overdue = body.buckets?.slice(1) ?? [];
    expect(overdue.length).toBe(STANDARD_AGING_BUCKET_DAYS.length);
    expect(overdue.map((b) => b.baseMinor)).toEqual(overdue.map(() => '0'));
    expect(overdue.map((b) => b.invoiceCount)).toEqual(overdue.map(() => 0));

    // The total is the TOTAL RECEIVABLE and not overdue debt (DR-10), so it
    // still carries the full amount — the figure is unchanged, its MEANING is
    // what the decision pins. Checked against the product's own reader.
    expect(body.totalBaseMinor).toBe(owed.toString());
    const sqlRowsNotDue = await agingStandardRows(plusDays(statedDueDate, -10));
    expect(sumBase(sqlRowsNotDue).toString()).toBe(owed.toString());
    expect(sqlRowsNotDue.map((r) => r.bucket_no)).toEqual([1]);
  });

  it('and once it IS late, the overdue bands carry it and the not-due band is empty', () => {
    const owed = BigInt(must(outstandingBaseMinor, 'the product’s own outstanding figure'));
    const body = standardHttpOverdue?.body as { buckets?: { label?: string; baseMinor?: string }[]; totalBaseMinor?: string };
    // Forty-five days past due: past 30, not past 60 — the `31-60` band.
    expect(body.buckets?.[0]?.baseMinor).toBe('0');
    expect(body.buckets?.[2]?.label).toBe('31-60');
    expect(body.buckets?.[2]?.baseMinor).toBe(owed.toString());
    expect(body.totalBaseMinor).toBe(owed.toString());
    const overdue = (body.buckets?.slice(1) ?? []).reduce((s, b) => s + BigInt(b.baseMinor ?? '0'), 0n);
    // Here — and only here — the overdue total and the receivable coincide.
    expect(overdue.toString()).toBe(owed.toString());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §F DR-13 and DR-14 — the termless invoice, and the boundaries on offer.
//
// §E proved the standard bands against a document that STATES a due date. This
// section is about the two decisions that followed:
//
//   DR-13 — an invoice with no stated term is due from its own issue date. The
//   old reader guarded with `due_date IS NOT NULL`, so such an invoice exceeded
//   no threshold however old it got and sat in band 1 forever: debt leaving an
//   aging report by omission rather than by payment.
//
//   DR-14 — the first release offers the standard boundaries and no others.
//
// Both are measured here against the INSTALLED function and the real route.
// ─────────────────────────────────────────────────────────────────────────────
describe('§F DR-13 a termless invoice ages from its issue date, and DR-14 fixes what may be asked', () => {
  it('the subject exists and is really termless', () => {
    // Non-vacuity before anything rests on it.
    expect(termlessRows.length).toBeGreaterThan(0);
    expect(BigInt(termlessOutstandingBaseMinor ?? '0') > 0n).toBe(true);
  });

  it('265 days after its ISSUE date it is in the OPEN band — not parked in not-due', () => {
    expect(termlessRows.length).toBe(1);
    const only = must(termlessRows[0], 'the one aging row');
    // Band five of five: the open band. Under the retired guard this was band
    // ONE, with the same document and the same horizon.
    expect(only.bucket_no).toBe(STANDARD_AGING_BUCKET_DAYS.length + 1);
    expect(only.bucket_no).not.toBe(1);
    expect(only.base_minor).toBe(termlessOutstandingBaseMinor);
    expect(only.invoice_count).toBe(1);
  });

  it('and it crosses each boundary on the day the decision says, measured from the issue date', () => {
    expect(termlessSweep.map((s) => s.days)).toEqual([0, 1, 30, 31, 91]);
    for (const s of termlessSweep) expect(s.bucketNos.length, `horizon +${s.days} returned no row`).toBe(1);
    // On the issue date itself the term is zero days, so it is not yet late.
    expect(termlessSweep.map((s) => s.bucketNos[0])).toEqual([1, 2, 2, 3, 5]);
  });

  it('DR-14: the route REFUSES the boundaries the product used before, by name', () => {
    expect(legacyBucketDaysHttp?.status, `bucketDays=30,60,90 must be refused: ${JSON.stringify(legacyBucketDaysHttp?.body)}`).toBe(400);
    const body = legacyBucketDaysHttp?.body as { error?: { code?: string; details?: { issues?: { path?: string }[] } } };
    expect(body.error?.code).toBe('VALIDATION_FAILED');
    expect((body.error?.details?.issues ?? []).map((i) => i.path)).toContain('bucketDays');
    // And the set that IS on offer still answers 200, so the refusal is about
    // the value and not about the route.
    expect(standardHttpOverdue?.status).toBe(200);
  });
});
