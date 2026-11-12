/**
 * L3 — `GET /v1/customers/:customerId/account-statement`, EXECUTED AGAINST
 * POSTGRESQL.
 *
 * `tests/guards/l3-customer-statement.test.ts` captures the statement TEXT and
 * simulates the cursor in JavaScript. It cannot prove what only a database can
 * refuse: that the five-branch `UNION ALL` is valid against the real schema,
 * that its column types line up, that the order really is
 * `(date, type rank, id)`, and that the keyset predicate pages without
 * repeating or skipping a row. This suite asks the database.
 *
 * Reached by `npm run test:integration` (`vitest run tests/integration …`),
 * which runs under `vitest.config.ts` and its Postgres `globalSetup`, exactly
 * like `p4s4-customer-aging-oldest-band-live.test.ts`, whose world it reuses.
 *
 * Every document is made by a product path: the sale commit (`POST /v1/sales`)
 * and the payment endpoint (`POST /v1/customer-payments`), whose overpayment
 * retains a credit. Nothing is INSERTed by hand into `invoices` or `payments`.
 *
 * THE ORACLES are never this file's own arithmetic: a row's amount is compared
 * with the STORED column of its own source row, and `outstanding` with the
 * rows `customer_ar_outstanding(...)` itself returns.
 *
 * §P — the PURE controls. They need no database, so they can be planted
 * against: they prove that the order check and the amount check can fail at
 * all (a comparator with the type rank removed, or a row with an altered
 * amount, turns them red).
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { ownerPool } from '../helpers/test-app';
import { onboardS3Business } from '../helpers/inventory-commands';
import { addMember, readAs } from '../helpers/merchant-reads';
import { confirmSale, seedSaleFixtures } from '../golden-regression/phase4-s2/sale-path';
import { creditSnapshot, invoiceTotals, must } from '../golden-regression/phase4-s4/harness';
import { applyCredit, collectPayment, rateToR10, type AllocationInput } from '../golden-regression/phase4-s4/settlement-path';
import { baseCurrency, settlementMissing, settlementWorld, stateFxRate, stockUp, type SettlementWorld } from '../golden-regression/phase4-s4/settlement-world';

/** What the route answers, as far as this suite reads it. */
interface Entry {
  entryKind: 'invoice' | 'payment' | 'payment_allocation' | 'credit' | 'credit_application';
  entryId: string;
  entryDate: string;
  currency: string;
  debitTxnMinor: string | null;
  creditTxnMinor: string | null;
  amountTxnMinor: string | null;
  customerCreditRemainingTxnMinor?: string | null;
  customerCreditOriginalTxnMinor?: string | null;
}
interface Outstanding {
  currency: string | null;
  txnMinor: string | null;
  baseMinor: string;
}
interface StatementBody {
  customerId: string;
  items: Entry[];
  outstanding: Outstanding[];
  nextCursor: string | null;
}

/** The statement's own rank of each kind: the second key of its order. */
const RANK: Readonly<Record<Entry['entryKind'], number>> = { invoice: 1, payment: 2, payment_allocation: 3, credit: 4, credit_application: 5 };

/** `(date, rank, id)`. A uuid orders bytewise in PostgreSQL, which is lowercase-hex string order. */
function compareEntries(a: Entry, b: Entry): number {
  if (a.entryDate !== b.entryDate) return a.entryDate < b.entryDate ? -1 : 1;
  if (RANK[a.entryKind] !== RANK[b.entryKind]) return RANK[a.entryKind] - RANK[b.entryKind];
  if (a.entryId !== b.entryId) return a.entryId < b.entryId ? -1 : 1;
  return 0;
}

/** How many adjacent pairs are out of order. */
function outOfOrder(items: readonly Entry[]): number {
  let n = 0;
  for (let i = 1; i < items.length; i += 1) if (compareEntries(items[i - 1] as Entry, items[i] as Entry) > 0) n += 1;
  return n;
}

/** How many rows carry an amount other than their own stored one. */
function amountMismatches(items: readonly Entry[], stored: ReadonlyMap<string, string>): number {
  return items.filter((r) => r.amountTxnMinor !== null && stored.get(r.entryId) !== r.amountTxnMinor).length;
}

describe('§P pure controls: the order check and the amount check can fail at all', () => {
  // The invoice's id sorts AFTER the payment's, so only the type rank can put it first.
  const invoice: Entry = {
    entryKind: 'invoice',
    entryId: 'ffffffff-0000-4000-8000-000000000001',
    entryDate: '2026-01-02',
    currency: 'USD',
    debitTxnMinor: null,
    creditTxnMinor: null,
    amountTxnMinor: '100',
  };
  const payment: Entry = {
    entryKind: 'payment',
    entryId: '00000000-0000-4000-8000-000000000002',
    entryDate: '2026-01-02',
    currency: 'USD',
    debitTxnMinor: null,
    creditTxnMinor: null,
    amountTxnMinor: '60',
  };
  const earlier: Entry = {
    entryKind: 'payment',
    entryId: '99999999-0000-4000-8000-000000000003',
    entryDate: '2026-01-01',
    currency: 'USD',
    debitTxnMinor: null,
    creditTxnMinor: null,
    amountTxnMinor: '5',
  };

  it('the right order is accepted, and every wrong one is counted', () => {
    expect(outOfOrder([earlier, invoice, payment])).toBe(0);
    expect(outOfOrder([invoice, earlier, payment])).toBeGreaterThan(0); // date wrong
    expect(outOfOrder([payment, invoice])).toBeGreaterThan(0); // rank wrong, with the id order pointing the other way
  });

  it('an altered amount is counted, an untouched one is not', () => {
    const stored = new Map([invoice, payment, earlier].map((r) => [r.entryId, r.amountTxnMinor ?? ''] as const));
    expect(amountMismatches([earlier, invoice, payment], stored)).toBe(0);
    expect(amountMismatches([earlier, { ...invoice, amountTxnMinor: '101' }, payment], stored)).toBe(1);
  });
});

let w: SettlementWorld;
let missing: readonly string[] = [];
let customerId: string;
let foreignCustomerId: string;
let invoiceAId: string;
let invoiceBId: string;
let paymentId: string;
let creditId: string;
let allocationIds: string[] = [];
let applicationIds: string[] = [];
let dayA: string;

const statementPath = (id: string, query = ''): string => `/v1/customers/${id}/account-statement${query}`;

async function getStatement(id: string, query = ''): Promise<{ status: number; body: StatementBody }> {
  const res = await w.t.request.get(statementPath(id, query)).set(w.headers);
  return { status: res.status, body: res.body as StatementBody };
}

/** A credit sale on `day`, through the real command; its identity read back from the stored rows. */
async function sellOn(day: string, quantity: string): Promise<{ invoiceId: string }> {
  const saleId = randomUUID();
  const res = await confirmSale(w.t, w.headers, {
    saleId,
    customerId,
    warehouseId: w.shop.w1,
    branchId: w.shop.branchX,
    occurredOn: day,
    lines: [{ productId: w.shop.piece.productId, quantity }],
  });
  expect(res.status, `the credit sale on ${day} commits: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  const r = await ownerPool().query<{ invoice_id: string }>(
    `SELECT i.id::text AS invoice_id FROM sales s JOIN invoices i ON i.business_id = s.business_id AND i.sale_id = s.id WHERE s.business_id = $1 AND s.id = $2`,
    [w.shop.businessId, saleId],
  );
  return { invoiceId: must(r.rows[0], `the invoice of sale ${saleId}`).invoice_id };
}

/** The STORED amount of each source row, by id: the oracle for "each row carries its own amount". */
async function storedAmounts(): Promise<ReadonlyMap<string, string>> {
  const q = await ownerPool().query<{ id: string; amount: string }>(
    `SELECT id::text AS id, total_txn_minor::text AS amount FROM invoices WHERE business_id = $1 AND customer_id = $2
     UNION ALL SELECT id::text, amount_minor::text FROM payments WHERE business_id = $1 AND customer_id = $2
     UNION ALL SELECT id::text, invoice_amount_applied_minor::text FROM payment_allocations WHERE business_id = $1 AND customer_id = $2
     UNION ALL SELECT id::text, invoice_amount_applied_minor::text FROM customer_credit_applications WHERE business_id = $1 AND customer_id = $2`,
    [w.shop.businessId, customerId],
  );
  return new Map(q.rows.map((r) => [r.id, r.amount] as const));
}

describe('the statement, executed', () => {
  beforeAll(async () => {
    w = await settlementWorld('l3 account statement');
    missing = await settlementMissing(w);
    if (missing.length > 0) return;

    const base = await baseCurrency(w);
    expect('USD', 'the payment currency must differ from the base so the retained credit carries a real rate').not.toBe(base);
    await stateFxRate(w, 'USD', base, '3.6700000000', `${w.day}T00:00:01Z`);
    await stockUp(w, '200', '11');
    customerId = (await seedSaleFixtures(ownerPool(), w.shop, w.day)).customerId;

    // Two invoices on DIFFERENT dates: A the day before, B today.
    const d = new Date(`${w.day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    dayA = d.toISOString().slice(0, 10);
    invoiceAId = (await sellOn(dayA, '3')).invoiceId;
    invoiceBId = (await sellOn(w.day, '6')).invoiceId;

    // A payment that OVERPAYS invoice A, so the product retains a credit.
    const totalsA = await invoiceTotals(ownerPool(), w.shop.businessId, invoiceAId);
    const totalA = BigInt(totalsA.totalTxnMinor);
    const surplus = totalA / 4n;
    expect(surplus >= 2n, `NO SUBJECT: a surplus of ${surplus} would retain no credit`).toBe(true);
    paymentId = randomUUID();
    creditId = randomUUID();
    const leg: AllocationInput = {
      invoiceId: invoiceAId,
      appliedMinor: totalA.toString(),
      paymentAmountMinor: totalA.toString(),
      releasedBeforeMinor: '0',
      invoiceTotalTxnMinor: totalsA.totalTxnMinor,
      invoiceTotalBaseMinor: totalsA.totalBaseMinor,
      invoiceToBaseRateR10: rateToR10(totalsA.sourceToBaseRate),
      paymentToBaseRateR10: rateToR10('3.6700000000'),
    };
    const pay = await collectPayment(w.t, w.headers, {
      paymentId,
      customerId,
      paymentMethodId: w.paymentMethodId,
      paymentDate: w.day,
      currencyCode: 'USD',
      amountMinor: (totalA + surplus).toString(),
      reference: 'L3-STATEMENT',
      creditId,
      allocations: [leg],
    });
    expect(pay.status, `the overpayment is accepted: ${JSON.stringify(pay.body)}`).toBeLessThan(300);
    expect((await creditSnapshot(ownerPool(), w.shop.businessId, creditId)).originalAmountMinor, 'the retained credit exists').toBeTruthy();

    // Two PARTIAL applications of the retained credit onto invoice B, the same day:
    // two `credit_application` rows that share (date, rank), so the cursor's tie
    // boundary is exercised by PostgreSQL. The product's own endpoint, the
    // golden-12 shape (releasedBefore accumulates; the credit row is the authority).
    const totalsB = await invoiceTotals(ownerPool(), w.shop.businessId, invoiceBId);
    const credit0 = await creditSnapshot(ownerPool(), w.shop.businessId, creditId);
    const original = BigInt(credit0.originalAmountMinor);
    expect(BigInt(totalsB.totalTxnMinor) >= original, 'NO SUBJECT: invoice B cannot absorb the credit').toBe(true);
    expect(original >= 4n, 'NO SUBJECT: the credit cannot be consumed in two quarters and keep a remainder').toBe(true);
    const quarter = original / 4n;
    let releasedBefore = 0n;
    applicationIds = [];
    for (const consumed of [quarter, quarter]) {
      const before = await creditSnapshot(ownerPool(), w.shop.businessId, creditId);
      const applicationId = randomUUID();
      const res = await applyCredit(w.t, w.headers, {
        applicationId,
        creditId,
        customerId,
        invoiceId: invoiceBId,
        applicationDate: w.day,
        consumedMinor: consumed.toString(),
        remainingBeforeMinor: before.remainingAmountMinor,
        creditOriginalMinor: before.originalAmountMinor,
        creditOriginalCarryingMinor: before.originalCarryingBaseAmountMinor,
        creditToBaseRateR10: rateToR10(before.creditToBaseRate),
        leg: {
          invoiceId: invoiceBId,
          appliedMinor: consumed.toString(),
          paymentAmountMinor: consumed.toString(),
          releasedBeforeMinor: releasedBefore.toString(),
          invoiceTotalTxnMinor: totalsB.totalTxnMinor,
          invoiceTotalBaseMinor: totalsB.totalBaseMinor,
          invoiceToBaseRateR10: rateToR10(totalsB.sourceToBaseRate),
          paymentToBaseRateR10: rateToR10(before.creditToBaseRate),
        },
      });
      expect(res.status, `the credit application of ${consumed} is accepted: ${JSON.stringify(res.body)}`).toBeLessThan(300);
      applicationIds.push(applicationId);
      releasedBefore += consumed;
    }
    const alloc = await ownerPool().query<{ id: string }>(`SELECT id::text AS id FROM payment_allocations WHERE business_id = $1 AND payment_id = $2`, [
      w.shop.businessId,
      paymentId,
    ]);
    allocationIds = alloc.rows.map((r) => r.id);
    expect(allocationIds.length, 'the payment really allocated to invoice A').toBeGreaterThan(0);

    // ANOTHER business, with its own customer, to be asked for under THIS business's header.
    const shop2 = await onboardS3Business(w.t, w.owner, 'l3 account statement other');
    foreignCustomerId = (await seedSaleFixtures(ownerPool(), shop2, w.day)).customerId;
  });

  it('the subject exists: the slice is installed and the seven seeded rows are all on the statement', async () => {
    expect(missing, `the slice is not installed: ${missing.join('; ')}`).toEqual([]);
    const { status, body } = await getStatement(customerId, '?limit=50');
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.items.map((r) => r.entryId).sort()).toEqual([invoiceAId, invoiceBId, paymentId, creditId, ...allocationIds, ...applicationIds].sort());
    expect(new Set(body.items.map((r) => r.entryKind))).toEqual(new Set(['invoice', 'payment', 'payment_allocation', 'credit', 'credit_application']));
    expect(new Set(body.items.map((r) => r.entryDate)).size, 'the rows span more than one date').toBeGreaterThan(1);
  });

  it('ORDER: the rows come back in (date, type rank, id), executed by PostgreSQL', async () => {
    const { body } = await getStatement(customerId, '?limit=50');
    expect(body.items.length).toBeGreaterThanOrEqual(7);
    expect(outOfOrder(body.items), `out of order: ${JSON.stringify(body.items.map((r) => [r.entryDate, r.entryKind, r.entryId]))}`).toBe(0);
    // Same day, three kinds: the rank decides, not the id (B, payment, credit all dated today).
    const today = body.items.filter((r) => r.entryDate === w.day).map((r) => r.entryKind);
    expect(today).toEqual(['invoice', 'payment', ...allocationIds.map(() => 'payment_allocation'), 'credit', 'credit_application', 'credit_application']);
    expect(body.items[0]?.entryId, 'the earlier invoice is first').toBe(invoiceAId);
  });

  it('AMOUNTS: each row carries its own stored amount', async () => {
    const { body } = await getStatement(customerId, '?limit=50');
    const stored = await storedAmounts();
    expect(stored.size, 'NO SUBJECT: no stored rows to compare with').toBeGreaterThanOrEqual(4);
    expect(amountMismatches(body.items, stored)).toBe(0);
  });

  it('PAGING: the concatenation of small pages equals one large page, with no repeat and no skip', async () => {
    const whole = (await getStatement(customerId, '?limit=50')).body.items.map((r) => r.entryId);
    for (const size of [1, 2, 3]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = `?limit=${size}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
        const page: { status: number; body: StatementBody } = await getStatement(customerId, query);
        expect(page.status, JSON.stringify(page.body)).toBe(200);
        seen.push(...page.body.items.map((r) => r.entryId));
        cursor = page.body.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 20);
      expect(pages, `limit ${size} really paged`).toBeGreaterThan(1);
      expect(seen, `limit ${size}`).toEqual(whole);
      expect(new Set(seen).size, `limit ${size} repeated a row`).toBe(seen.length);
    }
  });

  it('TIE BOUNDARY: two rows share (date, rank) and a page edge between them neither repeats nor skips, executed by PostgreSQL', async () => {
    const whole = (await getStatement(customerId, '?limit=50')).body.items;
    const apps = whole.filter((r) => r.entryKind === 'credit_application');
    expect(apps.length, 'NO SUBJECT: no two rows share (date, rank)').toBe(2);
    expect(apps[0]?.entryDate).toBe(apps[1]?.entryDate);
    const firstIdx = whole.findIndex((r) => r.entryId === apps[0]?.entryId);
    const p1 = await getStatement(customerId, `?limit=${firstIdx + 1}`);
    expect(p1.body.items.at(-1)?.entryId, 'page 1 ends exactly on the first of the tied rows').toBe(apps[0]?.entryId);
    const p2 = await getStatement(customerId, `?limit=50&cursor=${encodeURIComponent(p1.body.nextCursor ?? '')}`);
    expect(p2.body.items[0]?.entryId, 'page 2 starts on the second tied row: neither repeated nor skipped').toBe(apps[1]?.entryId);
  });

  it('CLOSES ON THE READER OF RECORD, per currency: debit minus credit equals customer_ar_outstanding.txn_minor', async () => {
    const { body } = await getStatement(customerId, '?limit=50');
    const oracle = await ownerPool().query<{ currency_code: string; txn_minor: string }>(
      `SELECT r.currency_code, r.txn_minor::text AS txn_minor FROM customer_ar_outstanding($1::uuid, $2::uuid) r WHERE r.currency_code IS NOT NULL`,
      [w.shop.businessId, customerId],
    );
    expect(oracle.rows.length, 'NO SUBJECT: the reader of record states no currency').toBeGreaterThan(0);
    const net = new Map<string, bigint>();
    for (const r of body.items) {
      const cur = net.get(r.currency) ?? 0n;
      net.set(r.currency, cur + BigInt(r.debitTxnMinor ?? '0') - BigInt(r.creditTxnMinor ?? '0'));
    }
    for (const o of oracle.rows) expect(net.get(o.currency_code)?.toString(), `closure for ${o.currency_code}`).toBe(o.txn_minor);
    expect(
      body.items.some((r) => r.entryKind === 'payment' && (r.debitTxnMinor !== null || r.creditTxnMinor !== null)),
      'the payment as received posts to neither side',
    ).toBe(false);
  });

  it('THE CREDIT BALANCE: the credit row shows the STORED remaining, not the original, and nothing is netted into outstanding', async () => {
    const { body } = await getStatement(customerId, '?limit=50');
    const rows = body.items.filter((r) => r.entryKind === 'credit');
    expect(rows.length, 'one explicit row per credit').toBe(1);
    const row = rows[0] as Entry;
    const stored = await ownerPool().query<{ original: string; remaining: string }>(
      `SELECT original_amount_minor::text AS original, remaining_amount_minor::text AS remaining FROM customer_credits WHERE business_id = $1 AND id = $2`,
      [w.shop.businessId, creditId],
    );
    const st = must(stored.rows[0], 'the stored credit row');
    expect(st.remaining, 'NO SUBJECT: the credit was partially consumed, so remaining differs from original').not.toBe(st.original);
    expect(BigInt(st.remaining) > 0n, 'NO SUBJECT: a fully consumed credit would show 0 and prove little').toBe(true);
    expect(row.customerCreditRemainingTxnMinor, 'the row shows the stored remaining').toBe(st.remaining);
    expect(row.customerCreditOriginalTxnMinor, 'and the original under its own name').toBe(st.original);
    expect(row.amountTxnMinor, 'the credit row has no generic amount to be misread as a debt or payment').toBeNull();
    expect(row.debitTxnMinor === null && row.creditTxnMinor === null).toBe(true);
  });

  it('OUTSTANDING equals the reader of record, customer_ar_outstanding, row for row', async () => {
    const { body } = await getStatement(customerId, '?limit=1');
    const oracle = await ownerPool().query<{ currency_code: string | null; txn_minor: string | null; base_minor: string }>(
      `SELECT r.currency_code, r.txn_minor::text AS txn_minor, r.base_minor::text AS base_minor
         FROM customer_ar_outstanding($1::uuid, $2::uuid) r ORDER BY r.currency_code NULLS FIRST`,
      [w.shop.businessId, customerId],
    );
    expect(oracle.rows.length, 'NO SUBJECT: the reader of record returned nothing').toBeGreaterThan(0);
    expect(body.outstanding).toEqual(oracle.rows.map((r) => ({ currency: r.currency_code, txnMinor: r.txn_minor, baseMinor: r.base_minor })));
  });

  it('LOAD-BEARING over HTTP: a member without receivables.view is refused, and a branch-assigned member is refused for scope; the owner is served', async () => {
    // The built-in cashier does not hold receivables.view (permissions.ts, cashier list).
    const cashier = await addMember(w.t, w.owner, w.shop, 'l3 statement cashier', 'cashier');
    const noPermission = await readAs(w.t, cashier, w.shop.businessId, statementPath(customerId, '?limit=1'));
    expect(noPermission.status, JSON.stringify(noPermission.body)).toBe(403);
    expect(noPermission.body?.error?.details?.sellingCode, 'refused by the permission guard, not by the scope rule').not.toBe(
      'customer.business_wide_scope_required',
    );
    // The built-in manager holds receivables.view; assigned to one branch, its scope is not business-wide.
    const manager = await addMember(w.t, w.owner, w.shop, 'l3 statement manager', 'manager', [w.shop.branchX]);
    const narrow = await readAs(w.t, manager, w.shop.businessId, statementPath(customerId, '?limit=1'));
    expect(narrow.status, JSON.stringify(narrow.body)).toBe(403);
    expect(narrow.body?.error?.details?.sellingCode).toBe('customer.business_wide_scope_required');
    // Positive control: the owner (all branches, holds the key) reads the same URL.
    const owner = await readAs(w.t, w.owner, w.shop.businessId, statementPath(customerId, '?limit=1'));
    expect(owner.status).toBe(200);
  });

  it('NEGATIVE CONTROL: another business’s customer id is refused, not answered', async () => {
    const own = await getStatement(customerId, '?limit=50');
    expect(own.status, 'the same request for our own customer answers, so the refusal below is isolation').toBe(200);
    const foreign = await getStatement(foreignCustomerId, '?limit=50');
    expect([403, 404], JSON.stringify(foreign.body)).toContain(foreign.status);
    expect(foreign.body.items ?? []).toEqual([]);
  });
});
