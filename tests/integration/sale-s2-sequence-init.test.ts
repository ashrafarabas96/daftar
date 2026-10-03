/**
 * P4-S2 / TL-P4-S2-R4 — A CLEAN BUSINESS HAS A PATH TO ITS FIRST INVOICE
 * NUMBER.
 *
 * `sale_commit` numbers an invoice from `invoice_sequences`, and until this
 * ruling NOTHING in `0000`–`0078` ever created a row there. A business that
 * had just onboarded could therefore not make a sale at all: the routine
 * refused `sale.issue_invoice` and the only way forward was an operator
 * typing INSERT into the production database. That was ruled a PRODUCT
 * BLOCKER — «a sale endpoint that requires manual SQL setup is not a complete
 * product path» — and the suites that created the row BY HAND
 * (`seedSaleFixtures` in `tests/golden-regression/phase4-s2/sale-path.ts`)
 * were the reason the hole stayed invisible: every one of them seeded the
 * fixture, so every one of them tested the second invoice of a business and
 * none of them tested the first.
 *
 * This suite therefore seeds NO sequence row anywhere. Each case starts from
 * a business that has never numbered a document, which is the state a real
 * merchant is in on their first day.
 *
 * ── WHAT THE DEFAULT IS, AND WHAT IT IS NOT ───────────────────────────────
 *
 * `INV-{YYYY}-{SEQ:6}` → `INV-2026-000001`. A DAFTAR-INTERNAL document
 * identifier. It is NOT a claim of jurisdiction-specific fiscal or tax
 * compliance: **OD-03 REMAINS OPEN**, no country's invoice law, VAT rule,
 * registration threshold or legal invoice field is encoded here or asserted
 * below (`P4-AL-45`), and a Country Pack may later impose legal requirements
 * of its own. Nothing in this file should be read as evidence that a DAFTAR
 * invoice number satisfies any tax authority.
 *
 * THE WIDTH IS `{SEQ:6}`, NOT `{SEQ:06}`, AND THAT IS MEASURED RATHER THAN
 * PREFERRED. `invoice_sequences_format_ck` (`0075:379`) admits
 * `\{SEQ:[1-9][0-9]?\}` — no leading zero in the width — and `0075` is
 * FROZEN. The case `the default format is one the FROZEN P4-S1 CHECK admits,
 * and {SEQ:06} is not` reads both spellings against the live constraint, so
 * the deviation from the ruling's literal string is a measurement in the
 * suite and not a remark in a comment.
 *
 * ── HOW CONCURRENCY IS PROVED ─────────────────────────────────────────────
 *
 * No sleeps, anywhere (`[[daftar-a-test-whose-verdict-is-the-machines-speed]]`,
 * §16). Two mechanisms, both of them a HELD LOCK observed through
 * `pg_blocking_pids` before anything is asserted:
 *
 *   1. `forcedRace` over a parked STOCK KEY: both sales are observed into the
 *      lock queue before the park is released, so two sales really are in
 *      flight against one brand-new year.
 *   2. A park that is an UNCOMMITTED INSERT of the very series row the sale
 *      needs. This is the only way to be inside the
 *      `ON CONFLICT … DO NOTHING` window on purpose: the sale's insert waits
 *      on the parker's transaction id, and what the parker then does —
 *      COMMIT or ROLLBACK — decides which arm of the initialiser runs. Both
 *      arms are asserted. `waitUntilQueued` THROWS if the sale ever settles
 *      without parking, so a case that did not actually contend FAILS rather
 *      than passing for the wrong reason.
 *
 * Every verdict is read from COMMITTED STATE — the series row, the invoice
 * ordinals, the rendered numbers — and never from a rejected promise.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { asMember, onboardS3Business, registerActor, today, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import { ownerClient } from '../helpers/stock-ledger';
import {
  blockedBehind,
  census,
  censusDelta,
  expectNoDeadlock,
  forcedRace,
  must,
  parkStockKey,
  pidOf,
  requireSubject,
  saleSubject,
  waitUntilQueued,
  type Census,
  type SaleSubject,
} from '../golden-regression/phase4-s2/harness';
import { confirmSale } from '../golden-regression/phase4-s2/sale-path';

const CLAIM = 'a business that has never numbered a document can issue its first invoice';

/** The default the ruling fixes, in this estate's `{SEQ:n}` spelling. */
const DEFAULT_FORMAT = 'INV-{YYYY}-{SEQ:6}';
/** The ruling's literal spelling, kept so the deviation is measured and not assumed. */
const RULED_FORMAT_SPELLING = 'INV-{YYYY}-{SEQ:06}';

interface SeriesRow {
  readonly tenant_id: string;
  readonly business_id: string;
  readonly document_kind: string;
  readonly period: string;
  readonly number_format: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface InvoiceRow {
  readonly number_seq: string;
  readonly period: string;
  readonly document_number: string;
  readonly document_kind: string;
  readonly business_id: string;
}

let t: TestApp;
let owner: HttpActor;
let day: string;
let year: string;
let subject: SaleSubject;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
  year = day.slice(0, 4);
  t = await createTestApp();
  owner = await registerActor(t, 'sequence init owner');
  subject = await saleSubject(ownerPool());
}, 300_000);

afterAll(async () => {
  await t?.close();
  await resetData();
});

/**
 * A business with stock and a customer, and DELIBERATELY NO SEQUENCE ROW.
 *
 * `seedSaleFixtures` is not used: it inserts the series row, which is the
 * fixture this whole suite exists to abolish. The customer is still a fixture
 * — `customers.manage` is not this slice's command — and nothing below
 * asserts anything about how the customer arrived.
 */
async function freshShop(label: string): Promise<{ shop: S3Business; customerId: string }> {
  const shop = await onboardS3Business(t, owner, label);
  const customerId = randomUUID();
  const digest = 'f'.repeat(64);
  await ownerPool().query(
    `INSERT INTO customers (tenant_id, business_id, id, name, phone, status, revision,
                            create_intent_sha256, last_intent_sha256, business_transaction_id, created_by, updated_by)
     VALUES ($1, $2, $3, 'first invoice customer', '+970000002', 'active', 1, $4, $4, $5, $6, $6)`,
    [shop.tenantId, shop.businessId, customerId, digest, randomUUID(), shop.userId],
  );
  const seeded = await seriesRows(shop.businessId);
  expect(seeded, `NO SUBJECT — ${label} was seeded with a series row, so its first sale would not be a first sale`).toEqual([]);
  return { shop, customerId };
}

async function stockUp(shop: S3Business, quantity: string, occurredOn: string = day): Promise<void> {
  const res = await t.request
    .post('/v1/inventory/adjustments')
    .set(asMember(owner, shop.businessId))
    .send({
      adjustmentId: randomUUID(),
      warehouseId: shop.w1,
      occurredOn,
      reason: 'sequence init fixture',
      lines: [{ productId: shop.piece.productId, quantity, unitCost: '5' }],
    });
  expect(res.status, `the fixture inbound adjustment is accepted: ${JSON.stringify(res.body)}`).toBe(201);
}

const sale = (shop: S3Business, customerId: string, documentDate: string = day, quantity = '1'): Promise<Response> =>
  confirmSale(t, asMember(owner, shop.businessId), {
    saleId: randomUUID(),
    customerId,
    warehouseId: shop.w1,
    branchId: shop.branchX,
    occurredOn: documentDate,
    lines: [{ productId: shop.piece.productId, quantity }],
  });

async function seriesRows(businessId: string): Promise<readonly SeriesRow[]> {
  return (
    await ownerPool().query<SeriesRow>(
      `SELECT tenant_id::text, business_id::text, document_kind, period, number_format,
              created_at::text, updated_at::text
         FROM invoice_sequences WHERE business_id = $1 ORDER BY period, document_kind`,
      [businessId],
    )
  ).rows;
}

async function invoiceRows(businessId: string): Promise<readonly InvoiceRow[]> {
  return (
    await ownerPool().query<InvoiceRow>(
      `SELECT number_seq::text, period, document_number, document_kind, business_id::text
         FROM invoices WHERE business_id = $1 ORDER BY period, number_seq`,
      [businessId],
    )
  ).rows;
}

/** The invoice of ONE sale, by the sale id the command answered with. */
async function invoiceOfSale(businessId: string, saleId: string): Promise<InvoiceRow> {
  const r = await ownerPool().query<InvoiceRow>(
    `SELECT number_seq::text, period, document_number, document_kind, business_id::text
       FROM invoices WHERE business_id = $1 AND sale_id = $2`,
    [businessId, saleId],
  );
  expect(r.rows.length, 'the committed sale carries exactly one invoice').toBe(1);
  return must(r.rows[0], 'the invoice of the sale');
}

const okSale = async (res: Response, what: string): Promise<string> => {
  expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return must((res.body as { saleId?: string }).saleId, `${what}: the answer carries the sale id`);
};

/**
 * A park that is an UNCOMMITTED INSERT of a series row, rather than a row
 * lock on an existing one.
 *
 * `parkRow` cannot do this: there is no row to lock yet, and that absence is
 * the whole case. The sale's `INSERT … ON CONFLICT DO NOTHING` waits on this
 * transaction's id, so holding the insert open holds the sale inside the
 * initialiser's conflict window, deterministically, with no sleep.
 */
async function parkUncommittedSeries(
  shop: S3Business,
  period: string,
  format: string,
): Promise<{ pid: number; commit(): Promise<void>; rollback(): Promise<void> }> {
  const c: Client = await ownerClient();
  await c.query('BEGIN');
  const r = await c.query(
    `INSERT INTO invoice_sequences (tenant_id, business_id, document_kind, period, number_format)
     VALUES ($1, $2, 'invoice', $3, $4)`,
    [shop.tenantId, shop.businessId, period, format],
  );
  expect(r.rowCount, 'the park really inserted the row it holds — a park that wrote nothing blocks nothing').toBe(1);
  const pid = await pidOf(c);
  let done = false;
  const finish = async (how: 'COMMIT' | 'ROLLBACK'): Promise<void> => {
    if (done) return;
    done = true;
    await c.query(how).catch(() => undefined);
    await c.end().catch(() => undefined);
  };
  return { pid, commit: () => finish('COMMIT'), rollback: () => finish('ROLLBACK') };
}

// ── 0. the subject, and the default itself ────────────────────────────────

describe('TL-P4-S2-R4 the default internal numbering format', () => {
  it('the subject exists: the sale commit routine is in the tree', () => {
    requireSubject(subject.missing, CLAIM);
  });

  it('the default format is one the FROZEN P4-S1 CHECK admits, and {SEQ:06} is not', async () => {
    // The ruling's literal spelling and this file's, read against the LIVE
    // constraint rather than against a copy of its regex. If a later
    // migration ever widens `invoice_sequences_format_ck`, this case flips
    // and says so — which is exactly when the literal `{SEQ:06}` becomes
    // available and the deviation can be retired.
    const r = await ownerPool().query<{ ruled: boolean; used: boolean }>(
      `SELECT ($1::text ~ src) AS ruled, ($2::text ~ src) AS used
         FROM (SELECT (regexp_match(pg_get_constraintdef(oid), '~ ''([^'']*)''::text'))[1] AS src
                 FROM pg_constraint WHERE conname = 'invoice_sequences_format_ck') c`,
      [RULED_FORMAT_SPELLING, DEFAULT_FORMAT],
    );
    const row = must(r.rows[0], 'the live invoice_sequences_format_ck pattern');
    expect(row.used, `${DEFAULT_FORMAT} is admitted by the live invoice_sequences_format_ck, so it can be stored at all`).toBe(true);
    expect(
      row.ruled,
      `${RULED_FORMAT_SPELLING} — the ruling's literal spelling — is REFUSED by invoice_sequences_format_ck (0075:379), which admits ` +
        `\\{SEQ:[1-9][0-9]?\\} and so forbids a leading zero in the width. 0075 is FROZEN, so the literal string cannot be stored without ` +
        `widening a sealed CHECK, which is the Tech Lead's call and not this slice's. ${DEFAULT_FORMAT} is the same six-digit zero-padded ` +
        `ordinal. If this expectation ever fails, the CHECK has been widened and the literal spelling should be adopted.`,
    ).toBe(false);
  });

  it('the default renders a six-digit zero-padded ordinal, and a wider ordinal is NOT truncated', async () => {
    // `lpad` TRUNCATES in PostgreSQL, so the width is a MINIMUM. A truncated
    // ordinal would be an EARLIER document's number.
    const r = await ownerPool().query<{ one: string; big: string; huge: string }>(
      `SELECT sale_document_number($1, '2026', 1) AS one,
              sale_document_number($1, '2026', 999999) AS big,
              sale_document_number($1, '2026', 1234567) AS huge`,
      [DEFAULT_FORMAT],
    );
    const row = must(r.rows[0], 'the rendered defaults');
    expect(row.one).toBe('INV-2026-000001');
    expect(row.big).toBe('INV-2026-999999');
    expect(row.huge, 'the millionth invoice is rendered in FULL: a truncated number would collide with an earlier one').toBe('INV-2026-1234567');
  });

  it('the INSERT privilege the initialiser needs is the internal writer’s alone, and it cannot rewrite a format', async () => {
    // The live catalogue, never the GRANT statement: a GRANT without grant
    // option WARNS and commits in this estate, so the privilege model is
    // asserted where it is actually recorded.
    const r = await ownerPool().query<{ role: string; priv: string }>(
      `SELECT grantee::text AS role, privilege_type::text AS priv FROM information_schema.table_privileges
        WHERE table_schema = 'public' AND table_name = 'invoice_sequences' AND grantee <> CURRENT_USER
        ORDER BY 1, 2`,
    );
    const held = r.rows.map((x) => `${x.role} ${x.priv}`);
    expect(held, 'the writer can CREATE a series row and READ one, and holds nothing else; daftar_app reads and no more').toEqual([
      'daftar_app SELECT',
      'daftar_inventory_internal INSERT',
      'daftar_inventory_internal SELECT',
    ]);
    const cols = await ownerPool().query<{ role: string; col: string; priv: string }>(
      `SELECT grantee::text AS role, column_name::text AS col, privilege_type::text AS priv
         FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = 'invoice_sequences' AND grantee <> CURRENT_USER
          AND privilege_type IN ('UPDATE', 'DELETE')
        ORDER BY 1, 2, 3`,
    );
    expect(
      cols.rows.map((x) => `${x.role} ${x.col} ${x.priv}`),
      'the only UPDATE on the series is updated_at, which is what a row lock needs — not number_format, which is what a rewrite would need',
    ).toEqual(['daftar_inventory_internal updated_at UPDATE']);
  });
});

// ── 1-5. the first invoice, the second, and the new year ──────────────────

describe('TL-P4-S2-R4 the first invoice of a business, and the ordinals after it', () => {
  let A: S3Business;
  let customerId: string;

  beforeAll(async () => {
    if (subject.missing.length > 0) return;
    ({ shop: A, customerId } = await freshShop('s2seqA'));
    await stockUp(A, '50');
  }, 300_000);

  it('1. a FRESH business with no invoice sequence takes its first sale, and the sale SUCCEEDS', async () => {
    requireSubject(subject.missing, CLAIM);
    expect(await seriesRows(A.businessId), 'the premise: this business has stated no series at all').toEqual([]);
    const saleId = await okSale(await sale(A, customerId), 'the first sale of a business with no invoice series commits');
    expect(saleId.length, 'and the command answered with the sale it committed').toBeGreaterThan(0);
  });

  it('2. the created row carries the right tenant, business, document kind, four-digit year and the default format', async () => {
    requireSubject(subject.missing, CLAIM);
    const rows = await seriesRows(A.businessId);
    expect(rows.length, 'the first sale created EXACTLY ONE series row').toBe(1);
    const row = must(rows[0], 'the created series row');
    expect(row.tenant_id, 'the tenant is the business’s own, not the request’s guess').toBe(A.tenantId);
    expect(row.business_id).toBe(A.businessId);
    expect(row.document_kind).toBe('invoice');
    expect(row.period, 'the period is the DOCUMENT DATE’s year — four digits, and never read from the clock').toBe(year);
    expect(row.period).toMatch(/^[0-9]{4}$/);
    expect(row.number_format).toBe(DEFAULT_FORMAT);
  });

  it('3. the FIRST invoice of the (business, year) is sequence 1', async () => {
    requireSubject(subject.missing, CLAIM);
    const rows = await invoiceRows(A.businessId);
    expect(rows.length, 'one sale so far, one invoice').toBe(1);
    const inv = must(rows[0], 'the first invoice');
    expect(inv.number_seq, 'the first ordinal is 1 — not 0, and not whatever a counter column happened to hold').toBe('1');
    expect(inv.period).toBe(year);
    expect(inv.document_number).toBe(`INV-${year}-000001`);
  });

  it('4. the SECOND invoice of the same (business, year) is sequence 2', async () => {
    requireSubject(subject.missing, CLAIM);
    const saleId = await okSale(await sale(A, customerId), 'the second sale commits');
    const inv = await invoiceOfSale(A.businessId, saleId);
    expect(inv.number_seq).toBe('2');
    expect(inv.document_number).toBe(`INV-${year}-000002`);
    expect((await seriesRows(A.businessId)).length, 'and still exactly ONE series row: the second sale created nothing').toBe(1);
  });

  it('5. a NEW calendar year starts again at 1, as its own row, and leaves the other year alone', async () => {
    requireSubject(subject.missing, CLAIM);
    // A different year of the SAME business. The year is taken from the
    // DOCUMENT DATE, so this is a document dated in the previous year and not
    // a clock the test moved.
    const prior = `${Number(year) - 1}-06-15`;
    await stockUp(A, '10', prior);
    const res = await sale(A, customerId, prior);
    const saleId = await okSale(res, `a sale dated in ${prior.slice(0, 4)} commits`);
    const inv = await invoiceOfSale(A.businessId, saleId);
    expect(inv.period, 'the invoice belongs to the DOCUMENT DATE’s year').toBe(prior.slice(0, 4));
    expect(inv.number_seq, 'and that year starts at 1 — the ordinal is per (business, kind, period), never global').toBe('1');
    expect(inv.document_number).toBe(`INV-${prior.slice(0, 4)}-000001`);

    const rows = await seriesRows(A.businessId);
    expect(
      rows.map((x) => `${x.period} ${x.number_format}`),
      'two years, two rows, both carrying the default format, and the earlier year’s ordinals untouched',
    ).toEqual([`${prior.slice(0, 4)} ${DEFAULT_FORMAT}`, `${year} ${DEFAULT_FORMAT}`]);
    const thisYear = (await invoiceRows(A.businessId)).filter((x) => x.period === year).map((x) => x.number_seq);
    expect(thisYear, 'the current year still holds exactly 1 and 2').toEqual(['1', '2']);
  });
});

// ── 6. an existing format is never overwritten ────────────────────────────

describe('TL-P4-S2-R4 a merchant’s own number_format survives the initialiser', () => {
  let B: S3Business;
  let customerId: string;
  const CUSTOM = 'FAT/{YYYY}/{SEQ:4}';

  beforeAll(async () => {
    if (subject.missing.length > 0) return;
    ({ shop: B, customerId } = await freshShop('s2seqB'));
    await stockUp(B, '20');
    await ownerPool().query(
      `INSERT INTO invoice_sequences (tenant_id, business_id, document_kind, period, number_format)
       VALUES ($1, $2, 'invoice', $3, $4)`,
      [B.tenantId, B.businessId, year, CUSTOM],
    );
  }, 300_000);

  it('6. an EXISTING custom format is PRESERVED: the sale renders from it and never writes the default over it', async () => {
    requireSubject(subject.missing, CLAIM);
    const before = must((await seriesRows(B.businessId))[0], 'the merchant’s own series row');
    expect(before.number_format, 'the premise: the merchant has stated a format of their own').toBe(CUSTOM);

    const saleId = await okSale(await sale(B, customerId), 'the sale of a business that already stated a format commits');
    const inv = await invoiceOfSale(B.businessId, saleId);
    expect(inv.document_number, 'the number is rendered from the MERCHANT’s format, not from the default').toBe(`FAT/${year}/0001`);
    expect(inv.number_seq).toBe('1');

    const after = must((await seriesRows(B.businessId))[0], 'the series row after the sale');
    expect(after.number_format, 'the stated format is byte-identical afterwards — `DO NOTHING`, never `DO UPDATE`').toBe(CUSTOM);
    expect(after.created_at, 'and it is the SAME row: the initialiser did not replace it').toBe(before.created_at);
    expect(after.updated_at, 'nothing on it was touched at all — the row is a lock and a format, not a counter').toBe(before.updated_at);
    expect((await seriesRows(B.businessId)).length, 'still exactly one row').toBe(1);
  });
});

// ── 7. two simultaneous first invoices ────────────────────────────────────

describe('TL-P4-S2-R4 two simultaneous first invoices of a new year', () => {
  let C: S3Business;
  let cCustomer: string;
  let D: S3Business;
  let dCustomer: string;
  let E: S3Business;
  let eCustomer: string;

  beforeAll(async () => {
    if (subject.missing.length > 0) return;
    ({ shop: C, customerId: cCustomer } = await freshShop('s2seqC'));
    await stockUp(C, '20');
    ({ shop: D, customerId: dCustomer } = await freshShop('s2seqD'));
    await stockUp(D, '20');
    ({ shop: E, customerId: eCustomer } = await freshShop('s2seqE'));
    await stockUp(E, '20');
  }, 300_000);

  it('7a. two sales FORCED into one brand-new year yield ONE row, TWO numbers, ordinals 1 and 2', async () => {
    requireSubject(subject.missing, CLAIM);
    expect(await seriesRows(C.businessId), 'the premise: the year has no series row when both sales start').toEqual([]);

    // The stock key both sales must lock is parked, and each sale is OBSERVED
    // into the queue behind it before the next is launched and before the
    // park is released. `waitUntilQueued` throws if a sale ever settles
    // without parking, so an unforced run FAILS instead of passing.
    const park = await parkStockKey(() => ownerClient(), C.businessId, C.w1, C.piece.variantId);
    const outcomes = await forcedRace(park, [() => sale(C, cCustomer), () => sale(C, cCustomer)], 'two first sales of a brand-new year');
    expectNoDeadlock(outcomes, 'two first sales of a brand-new year');

    const statuses = outcomes.map((o) => (o.kind === 'ok' ? (o.value as Response).status : `threw ${String((o as { error: unknown }).error)}`));
    expect(
      statuses.every((s) => typeof s === 'number' && s < 300),
      `NO SALE IS LOST: both sales commit, neither is refused for contention. Got ${JSON.stringify(statuses)}`,
    ).toBe(true);

    const rows = await seriesRows(C.businessId);
    expect(rows.length, 'EXACTLY ONE series row — the primary key decided it, and the loser’s DO NOTHING did nothing').toBe(1);
    expect(must(rows[0], 'the row').number_format, 'and it carries the default, written once').toBe(DEFAULT_FORMAT);

    const invoices = await invoiceRows(C.businessId);
    expect(
      invoices.map((x) => x.number_seq),
      'TWO distinct ordinals, 1 and 2 — no duplicate, no gap',
    ).toEqual(['1', '2']);
    expect(new Set(invoices.map((x) => x.document_number)).size, 'and two DISTINCT rendered numbers').toBe(2);
    expect(invoices.map((x) => x.document_number)).toEqual([`INV-${year}-000001`, `INV-${year}-000002`]);
  });

  it('7b. a sale held inside the ON CONFLICT window uses the row the OTHER transaction committed, format and all', async () => {
    requireSubject(subject.missing, CLAIM);
    const CUSTOM = 'BIL-{YYYY}-{SEQ:3}';
    const parked = await parkUncommittedSeries(D, year, CUSTOM);
    const flag = { done: false };
    let inFlight: Promise<Response> | null = null;
    try {
      inFlight = sale(D, dCustomer).then(
        (r) => {
          flag.done = true;
          return r;
        },
        (e: unknown) => {
          flag.done = true;
          throw e;
        },
      );
      // The sale's own `INSERT … ON CONFLICT DO NOTHING` now waits on the
      // parker's transaction id. This is the collision window, entered on
      // purpose and observed, not hoped for.
      const queued = await waitUntilQueued([parked.pid], 1, flag, 'the sale inside the series initialiser’s conflict window');
      expect(queued.length, 'the sale is really blocked by the uncommitted series insert').toBeGreaterThanOrEqual(1);
      expect((await blockedBehind([parked.pid])).length, 'and still blocked when the assertion is taken').toBeGreaterThanOrEqual(1);
    } finally {
      // The OTHER transaction WINS. `DO NOTHING` must then leave its format
      // alone and the sale must number from it.
      await parked.commit();
    }
    const res = await must(inFlight, 'the in-flight sale');
    const saleId = await okSale(res, 'the sale that lost the initialiser race still commits');
    const inv = await invoiceOfSale(D.businessId, saleId);
    expect((await seriesRows(D.businessId)).length, 'exactly one row: the loser inserted nothing').toBe(1);
    expect(must((await seriesRows(D.businessId))[0], 'the row').number_format, 'the WINNER’s format stands, unoverwritten').toBe(CUSTOM);
    expect(inv.document_number, 'and the sale numbered itself from the winner’s format').toBe(`BIL-${year}-001`);
    expect(inv.number_seq).toBe('1');
  });

  it('7c. a sale held behind an ABORTED series insert creates the row itself and still gets ordinal 1', async () => {
    requireSubject(subject.missing, CLAIM);
    const parked = await parkUncommittedSeries(E, year, 'ABORT-{YYYY}-{SEQ:9}');
    const flag = { done: false };
    let inFlight: Promise<Response> | null = null;
    try {
      inFlight = sale(E, eCustomer).then(
        (r) => {
          flag.done = true;
          return r;
        },
        (e: unknown) => {
          flag.done = true;
          throw e;
        },
      );
      const queued = await waitUntilQueued([parked.pid], 1, flag, 'the sale behind an aborted series insert');
      expect(queued.length, 'the sale is blocked by the uncommitted insert before it is rolled back').toBeGreaterThanOrEqual(1);
    } finally {
      await parked.rollback();
    }
    const res = await must(inFlight, 'the in-flight sale');
    const saleId = await okSale(res, 'the sale whose rival aborted still commits');
    const rows = await seriesRows(E.businessId);
    expect(rows.length, 'exactly one row, and it is the sale’s own').toBe(1);
    expect(must(rows[0], 'the row').number_format, 'the aborted format left no trace: the DEFAULT is what is there').toBe(DEFAULT_FORMAT);
    const inv = await invoiceOfSale(E.businessId, saleId);
    expect(inv.number_seq, 'and the ordinal is 1 — the aborted rival consumed nothing').toBe('1');
    expect(inv.document_number).toBe(`INV-${year}-000001`);
  });
});

// ── 8. rollback leaves no committed number ────────────────────────────────

describe('TL-P4-S2-R4 a rolled-back sale leaves no number and no series row', () => {
  let F: S3Business;
  let customerId: string;

  beforeAll(async () => {
    if (subject.missing.length > 0) return;
    ({ shop: F, customerId } = await freshShop('s2seqF'));
    await stockUp(F, '20');
  }, 300_000);

  /**
   * Raise at the first write to `invoice_items`, which is AFTER the series
   * row was created, AFTER the ordinal was taken and AFTER the invoice was
   * inserted. Anything that survived would be a number consumed by a sale
   * that never happened, and the next sale would start at 2.
   */
  async function withRaisingTrigger<T>(relation: string, fn: () => Promise<T>): Promise<T> {
    const fname = `p4s2_seq_inject_${relation}`;
    await ownerPool().query(
      `CREATE OR REPLACE FUNCTION ${fname}() RETURNS trigger LANGUAGE plpgsql AS
       $fx$ BEGIN RAISE EXCEPTION 'p4s2.injected_failure: a failure after the invoice was numbered' USING ERRCODE = 'P0001'; END $fx$`,
    );
    await ownerPool().query(`CREATE TRIGGER zz_p4s2_seq_inject BEFORE INSERT ON ${relation} FOR EACH ROW EXECUTE FUNCTION ${fname}()`);
    try {
      return await fn();
    } finally {
      await ownerPool().query(`DROP TRIGGER IF EXISTS zz_p4s2_seq_inject ON ${relation}`);
      await ownerPool().query(`DROP FUNCTION IF EXISTS ${fname}()`);
    }
  }

  it('8. a sale that fails AFTER it was numbered leaves NO committed invoice number and NO series row', async () => {
    requireSubject(subject.missing, CLAIM);
    expect(await seriesRows(F.businessId), 'the premise: nothing numbered yet').toEqual([]);
    const before: Census = await census(ownerPool(), F.businessId);

    const refused = await withRaisingTrigger('invoice_items', () => sale(F, customerId));
    expect(refused.status >= 400, `the injected failure surfaces as a refusal: ${JSON.stringify(refused.body)}`).toBe(true);

    expect(await invoiceRows(F.businessId), 'NO invoice survives, so no number was consumed').toEqual([]);
    expect(await seriesRows(F.businessId), 'and NO series row survives either: the initialiser is inside the sale’s transaction, not beside it').toEqual([]);
    expect(censusDelta(before, await census(ownerPool(), F.businessId)), 'nothing at all survives — not a row of any business-scoped relation').toEqual({});

    // And the number it had taken is still available: the next sale is 1.
    const saleId = await okSale(await sale(F, customerId), 'the sale after the rollback commits');
    const inv = await invoiceOfSale(F.businessId, saleId);
    expect(inv.number_seq, 'the rolled-back sale consumed nothing, so the next invoice is still the FIRST').toBe('1');
    expect(inv.document_number).toBe(`INV-${year}-000001`);
  });
});

// ── 9 and 10. the series belongs to one business, and to no client ────────

describe('TL-P4-S2-R4 the series is the business’s, and the ordinal is nobody’s to choose', () => {
  let G: S3Business;
  let gCustomer: string;
  let H: S3Business;
  let hCustomer: string;
  const G_FORMAT = 'GEE-{YYYY}-{SEQ:2}';

  beforeAll(async () => {
    if (subject.missing.length > 0) return;
    ({ shop: G, customerId: gCustomer } = await freshShop('s2seqG'));
    await stockUp(G, '20');
    ({ shop: H, customerId: hCustomer } = await freshShop('s2seqH'));
    await stockUp(H, '20');
    await ownerPool().query(
      `INSERT INTO invoice_sequences (tenant_id, business_id, document_kind, period, number_format)
       VALUES ($1, $2, 'invoice', $3, $4)`,
      [G.tenantId, G.businessId, year, G_FORMAT],
    );
  }, 300_000);

  it('9. a CROSS-BUSINESS series row cannot be used: each business numbers from its own', async () => {
    requireSubject(subject.missing, CLAIM);
    // G has stated a distinctive format for this very period. H has stated
    // nothing. If the lookup were not keyed on the business, H's first
    // invoice would render from G's format — and if the ordinal were not
    // either, it would continue G's count.
    const gSale = await okSale(await sale(G, gCustomer), 'G’s sale commits');
    const gInv = await invoiceOfSale(G.businessId, gSale);
    expect(gInv.document_number, 'G numbers from G’s format').toBe(`GEE-${year}-01`);

    const hSale = await okSale(await sale(H, hCustomer), 'H’s first sale commits without ever having stated a series');
    const hInv = await invoiceOfSale(H.businessId, hSale);
    expect(hInv.document_number, 'H did NOT borrow G’s format: it got its own row with the default').toBe(`INV-${year}-000001`);
    expect(hInv.number_seq, 'and its own count, which starts at 1 rather than continuing G’s').toBe('1');

    const hRows = await seriesRows(H.businessId);
    expect(hRows.length, 'H now owns exactly one row').toBe(1);
    expect(must(hRows[0], 'H’s row').business_id, 'and it is H’s, not G’s').toBe(H.businessId);
    expect(must(hRows[0], 'H’s row').tenant_id, 'carrying H’s tenant').toBe(H.tenantId);
    expect(must((await seriesRows(G.businessId))[0], 'G’s row').number_format, 'G’s row is untouched by H’s sale').toBe(G_FORMAT);

    // The same claim at the catalogue grain: nothing about the key is
    // ambiguous, so "the wrong business's row" is not addressable.
    const pk = await ownerPool().query<{ cols: string[] }>(
      `SELECT array_agg(a.attname ORDER BY k.ord)::text[] AS cols
         FROM pg_constraint c
         JOIN unnest(c.conkey) WITH ORDINALITY AS k(att, ord) ON true
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.att
        WHERE c.conname = 'invoice_sequences_pkey'`,
    );
    expect(must(pk.rows[0], 'the primary key').cols, 'the series is keyed on the business, the kind and the period').toEqual([
      'business_id',
      'document_kind',
      'period',
    ]);
    // And the FK that makes a wrong tenant unrepresentable is still composite.
    const fk = await ownerPool().query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'invoice_sequences_tenant_fk'`,
    );
    expect(must(fk.rows[0], 'the tenancy FK').def, 'a series row with the wrong tenant is refused by the composite FK, not by a convention').toMatch(
      /FOREIGN KEY \(tenant_id, business_id\) REFERENCES businesses\(tenant_id, id\)/,
    );
  });

  it('10. the client cannot choose or forge number_seq', async () => {
    requireSubject(subject.missing, CLAIM);
    // (a) the wire. The DTO is `.strict()`, so a body that states a number,
    //     an ordinal or a format is a 4xx and not a field quietly ignored —
    //     "ignored" is indistinguishable from "honoured" the day the name
    //     changes.
    const base = {
      saleId: randomUUID(),
      settlementMode: 'credit' as const,
      customerId: hCustomer,
      warehouseId: H.w1,
      documentDate: day,
      dueDate: null,
      taxMinor: '0',
      notes: null,
      lines: [{ lineId: randomUUID(), productId: H.piece.productId, variantId: null, quantity: '1', discountMinor: '0' }],
    };
    for (const forged of [
      { numberSeq: 99 },
      { number_seq: 99 },
      { documentNumber: 'INV-1999-000001' },
      { numberFormat: 'HACK-{YYYY}-{SEQ:6}' },
      { period: '1999' },
    ]) {
      const res = await t.request
        .post('/v1/sales')
        .set(asMember(owner, H.businessId))
        .send({ ...base, saleId: randomUUID(), ...forged });
      expect(
        res.status,
        `a request stating ${Object.keys(forged).join(', ')} is REFUSED, not accepted-and-ignored: ${JSON.stringify(res.body)}`,
      ).toBeGreaterThanOrEqual(400);
    }

    // (b) the privilege. Even a client that got past the DTO holds no DML on
    //     either relation, so there is no statement it could issue.
    const dml = await ownerPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.table_privileges
        WHERE table_schema = 'public' AND table_name IN ('invoices', 'invoice_sequences')
          AND grantee = 'daftar_app' AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')`,
    );
    expect(must(dml.rows[0], 'the daftar_app DML count').n, 'daftar_app holds no INSERT, UPDATE or DELETE on the invoice or the series (P4-AL-38)').toBe('0');

    // (c) the signature. `sale_commit` takes no ordinal, no document number
    //     and no format: there is no argument for a client-chosen number to
    //     travel in, which is why (a) is a refusal and not a sanitisation.
    const args = await ownerPool().query<{ args: string }>(
      `SELECT pg_get_function_identity_arguments(p.oid) AS args FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'sale_commit'`,
    );
    const signature = must(args.rows[0], 'the sale_commit signature').args;
    expect(signature.length, 'NO SUBJECT — the signature came back empty').toBeGreaterThan(0);
    for (const forbidden of ['number_seq', 'document_number', 'number_format', 'ordinal', 'period']) {
      expect(signature.includes(forbidden), `sale_commit takes no ${forbidden}: the number is the server’s to compute (P4-AL-18)`).toBe(false);
    }

    // (d) and the committed ordinals are a clean 1..n with no forged value in
    //     them, read from the committed state rather than from the refusals.
    const rows = (await invoiceRows(H.businessId)).map((x) => x.number_seq);
    expect(rows, 'H’s committed ordinals are exactly what the server allocated').toEqual(['1']);
  });
});
