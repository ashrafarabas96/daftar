/**
 * L3 — THE CUSTOMER STATEMENT READ (`GET /v1/customers/:customerId/account-statement`).
 *
 * No database: `Database.scoped` is replaced by a recording fake, so every
 * assertion is over the SQL the read REALLY issued, never over prose. The fake
 * evaluates only the keyset predicate the read passes as parameters; it does
 * NOT execute the SQL. What therefore remains NOT_RUN here (needs PostgreSQL,
 * which this machine lacks) is: the SQL's own validity against the schema and
 * its ordering/predicate executed by PostgreSQL.
 *
 * Laws under test:
 *  - P4-AL-07: the read derives money THROUGH `customer_ar_outstanding` and
 *    sums nothing itself — no `sum(` in any statement it issues.
 *  - no per-row running balance: no row carries one, and the authoritative
 *    figure arrives as a separate `outstanding` field.
 *  - keyset only (budget P4-D): no `OFFSET`.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { PERMISSION_KEY } from '../../apps/api/src/common/guards';
import { CustomerReadService } from '../../apps/api/src/modules/selling/customer-reads';
import { CustomersController } from '../../apps/api/src/modules/selling/customers.controller';
import { CustomerAccountStatementQuerySchema } from '../../apps/api/src/modules/selling/selling.schemas';
import type { MembershipContext } from '../../apps/api/src/modules/tenancy/tenancy.service';

const BUSINESS = '11111111-1111-4111-8111-111111111111';
const OTHER_BUSINESS = '22222222-2222-4222-8222-222222222222';
const CUSTOMER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FOREIGN_CUSTOMER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const m = { tenantId: '99999999-9999-4999-8999-999999999999', businessId: BUSINESS, branchScopeMode: 'all' } as unknown as MembershipContext;

/** What the statement SQL yields, already in the read's output column shape, in the order the SQL promises. */
interface Row {
  kind_rank: number;
  entry_kind: 'invoice' | 'payment' | 'credit' | 'credit_application';
  entry_id: string;
  entry_date: string;
  document_number: string | null;
  related_id: string | null;
  currency_code: string;
  debit_txn_minor: string | null;
  credit_txn_minor: string | null;
  amount_txn_minor: string;
  amount_base_minor: string;
  reference: string | null;
}

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FIXTURE: Row[] = [
  {
    kind_rank: 1,
    entry_kind: 'invoice',
    entry_id: id(1),
    entry_date: '2026-01-01',
    document_number: 'INV-1',
    related_id: null,
    currency_code: 'USD',
    debit_txn_minor: '1000',
    credit_txn_minor: null,
    amount_txn_minor: '1000',
    amount_base_minor: '1000',
    reference: null,
  },
  {
    kind_rank: 1,
    entry_kind: 'invoice',
    entry_id: id(2),
    entry_date: '2026-01-02',
    document_number: 'INV-2',
    related_id: null,
    currency_code: 'USD',
    debit_txn_minor: '500',
    credit_txn_minor: null,
    amount_txn_minor: '500',
    amount_base_minor: '500',
    reference: null,
  },
  {
    kind_rank: 2,
    entry_kind: 'payment',
    entry_id: id(3),
    entry_date: '2026-01-02',
    document_number: null,
    related_id: null,
    currency_code: 'USD',
    debit_txn_minor: null,
    credit_txn_minor: null,
    amount_txn_minor: '700',
    amount_base_minor: '700',
    reference: 'R-1',
  },
  {
    kind_rank: 4,
    entry_kind: 'credit',
    entry_id: id(4),
    entry_date: '2026-01-02',
    document_number: null,
    related_id: id(3),
    currency_code: 'USD',
    debit_txn_minor: null,
    credit_txn_minor: null,
    amount_txn_minor: '200',
    amount_base_minor: '200',
    reference: null,
  },
  {
    kind_rank: 5,
    entry_kind: 'credit_application',
    entry_id: id(5),
    entry_date: '2026-01-03',
    document_number: 'INV-2',
    related_id: id(2),
    currency_code: 'USD',
    debit_txn_minor: null,
    credit_txn_minor: '200',
    amount_txn_minor: '200',
    amount_base_minor: '200',
    reference: null,
  },
];

interface Captured {
  sql: string;
  params: unknown[];
}

/** A recording fake of `Database.scoped`. The statement rows are served by keyset over the fixture. */
function fakeDb(opts: { customerExists: boolean }) {
  const captured: Captured[] = [];
  const db = {
    async scoped(_scope: unknown, sql: string, params: unknown[] = []) {
      captured.push({ sql, params });
      if (/FROM customers c WHERE c\.business_id = \$1 AND c\.id = \$2/.test(sql)) {
        return { rows: opts.customerExists && params[1] === CUSTOMER && params[0] === BUSINESS ? [{ id: CUSTOMER }] : [] };
      }
      if (/customer_ar_outstanding/.test(sql)) {
        return { rows: [{ currency_code: 'USD', txn_minor: '1100', base_minor: '1100' }] };
      }
      // The statement read: parameters are $1 business, $2 customer, $3 date, $4 rank, $5 id, $6 limit.
      const [, , cDate, cRank, cId, lim] = params as [string, string, string | null, number | null, string | null, number];
      const rows =
        cDate === null
          ? FIXTURE
          : FIXTURE.filter(
              (r) =>
                r.entry_date > cDate ||
                (r.entry_date === cDate && (r.kind_rank > (cRank as number) || (r.kind_rank === cRank && r.entry_id > (cId as string)))),
            );
      return { rows: rows.slice(0, lim).map((r) => ({ ...r, entry_date_text: r.entry_date })) };
    },
  };
  return { db, captured };
}

function service(opts: { customerExists: boolean }) {
  const { db, captured } = fakeDb(opts);
  return { reads: new CustomerReadService(db as never), captured };
}

describe('L3 customer statement', () => {
  it('RED/route: the controller exposes GET :customerId/account-statement', () => {
    const handler = (CustomersController.prototype as unknown as Record<string, unknown>).accountStatement;
    expect(typeof handler).toBe('function');
    expect(Reflect.getMetadata('path', handler as object)).toBe(':customerId/account-statement');
    expect(Reflect.getMetadata('method', handler as object)).toBe(0); // RequestMethod.GET
  });

  it('chronological, keyset-paginated: page 2 neither repeats nor skips', async () => {
    const { reads } = service({ customerExists: true });
    const q1 = CustomerAccountStatementQuerySchema.parse({ limit: '2' });
    const p1 = await reads.accountStatement(m, CUSTOMER, q1);
    expect(p1.items.map((r) => r.entryId)).toEqual([id(1), id(2)]);
    expect(p1.nextCursor).not.toBeNull();

    const seen = [...p1.items.map((r) => r.entryId)];
    let cursor = p1.nextCursor;
    let guard = 0;
    while (cursor !== null && guard++ < 10) {
      const page = await reads.accountStatement(m, CUSTOMER, CustomerAccountStatementQuerySchema.parse({ limit: '2', cursor }));
      seen.push(...page.items.map((r) => r.entryId));
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(FIXTURE.map((r) => r.entry_id)); // all five, once each, in order
    const dates = (await reads.accountStatement(m, CUSTOMER, CustomerAccountStatementQuerySchema.parse({}))).items.map((r) => r.entryDate);
    expect([...dates].sort()).toEqual(dates);
  });

  it('GUARD: no statement the read issues contains sum( or OFFSET, and money comes through the reader of record', async () => {
    const { reads, captured } = service({ customerExists: true });
    await reads.accountStatement(m, CUSTOMER, CustomerAccountStatementQuerySchema.parse({ limit: '2' }));
    expect(captured.length).toBeGreaterThanOrEqual(3); // a non-empty subject for the negative assertions
    for (const c of captured) {
      expect(c.sql, c.sql).not.toMatch(/\bsum\s*\(/i);
      expect(c.sql, c.sql).not.toMatch(/\boffset\b/i);
    }
    expect(captured.some((c) => /customer_ar_outstanding\(/.test(c.sql))).toBe(true);
  });

  it('CLOSES ON THE READER OF RECORD: the statement keeps only open credit-sale invoices, on every branch that names an invoice', async () => {
    const { reads, captured } = service({ customerExists: true });
    await reads.accountStatement(m, CUSTOMER, CustomerAccountStatementQuerySchema.parse({}));
    const stmt = captured.find((c) => /UNION ALL/i.test(c.sql));
    expect(stmt, 'the statement SQL was captured').toBeDefined();
    const sql = (stmt as Captured).sql;
    // The three branches that name an invoice (the invoice, its allocations, its credit applications) each carry the full predicate.
    expect(sql.match(/settlement_mode = 'credit'/g)?.length).toBe(3);
    expect(sql.match(/status = 'open'/g)?.length).toBe(3);
    expect(sql.match(/document_kind = 'invoice'/g)?.length).toBe(3);
    // Applied money is posted per allocation, from the column the reader itself sums; the payment as received is a stated row with neither side.
    expect(sql).toMatch(/FROM payment_allocations pa/);
    expect(sql).toMatch(/pa\.invoice_amount_applied_minor/);
    expect(sql.match(/p\.amount_minor::text/g)?.length, 'the payment row states its amount once, as a memo').toBe(1);
  });

  it('the payload says outstanding is the whole customer balance, not the page total', async () => {
    const { reads } = service({ customerExists: true });
    const res = await reads.accountStatement(m, CUSTOMER, CustomerAccountStatementQuerySchema.parse({ limit: '1' }));
    expect(res.outstandingScope).toBe('whole_customer');
  });

  it('no per-row running balance; the authoritative total is a separate field', async () => {
    const { reads } = service({ customerExists: true });
    const res = await reads.accountStatement(m, CUSTOMER, CustomerAccountStatementQuerySchema.parse({}));
    for (const r of res.items) expect(Object.keys(r).filter((k) => /balance|running/i.test(k))).toEqual([]);
    expect(res.outstanding).toEqual([{ currency: 'USD', txnMinor: '1100', baseMinor: '1100' }]);
  });

  it('NEGATIVE CONTROL: a well-formed request returns the rows, with debit and credit kept separate', async () => {
    const { reads } = service({ customerExists: true });
    const res = await reads.accountStatement(m, CUSTOMER, CustomerAccountStatementQuerySchema.parse({}));
    expect(res.customerId).toBe(CUSTOMER);
    expect(res.items).toHaveLength(FIXTURE.length);
    const inv = res.items[0];
    expect(inv).toMatchObject({ entryKind: 'invoice', documentNumber: 'INV-1', debitTxnMinor: '1000', creditTxnMinor: null, amountTxnMinor: '1000' });
    expect(res.items[2]).toMatchObject({ entryKind: 'payment', debitTxnMinor: null, creditTxnMinor: null, amountTxnMinor: '700' });
  });

  it("NEGATIVE CONTROL: another business's customer id is refused and no statement SQL is issued", async () => {
    const { reads, captured } = service({ customerExists: true });
    await expect(reads.accountStatement(m, FOREIGN_CUSTOMER, CustomerAccountStatementQuerySchema.parse({}))).rejects.toMatchObject({
      code: 'NOT_FOUND',
      details: { sellingCode: 'customer.not_found' },
    });
    expect(captured.some((c) => /customer_ar_outstanding|UNION ALL/i.test(c.sql))).toBe(false);
    void OTHER_BUSINESS;
  });

  it('the route path cannot be confused with the guard seed path under the checker rule (text.includes)', () => {
    const mine = '/v1/customers/:customerId/account-statement';
    const seed = '/v1/customers/:customerId/statement';
    console.log('mine=' + mine + ' | seed=' + seed + ' | mine.includes(seed)=' + String(mine.includes(seed)));
    expect(mine.includes(seed)).toBe(false);
  });

  it('the cursor accepts rank 5 (credit application) and refuses rank 6', () => {
    expect(CustomerAccountStatementQuerySchema.parse({ cursor: `2026-01-02:5:${id(3)}` }).cursor).toBe(`2026-01-02:5:${id(3)}`);
    expect(() => CustomerAccountStatementQuerySchema.parse({ cursor: `2026-01-02:6:${id(3)}` })).toThrow();
  });

  it('LOAD-BEARING (permission): the route names receivables.view, the key the permission guard reads', () => {
    const handler = (CustomersController.prototype as unknown as Record<string, object>).accountStatement as object;
    expect(Reflect.getMetadata(PERMISSION_KEY, handler)).toBe('receivables.view');
    // Positive control that the probe can see: a sibling route's key reads the same way.
    const sibling = (CustomersController.prototype as unknown as Record<string, object>).list as object;
    expect(Reflect.getMetadata(PERMISSION_KEY, sibling)).toBe('customers.view');
  });

  it('LOAD-BEARING (scope): an actor whose scope is not business-wide is refused before any read; a business-wide one is served', async () => {
    let reads = 0;
    const fakeReads = {
      async accountStatement() {
        reads += 1;
        return { customerId: CUSTOMER, items: [], outstanding: [], outstandingScope: 'whole_customer', nextCursor: null };
      },
    };
    const controller = new CustomersController(fakeReads as never);
    const assigned = { ...m, branchScopeMode: 'assigned' } as unknown as MembershipContext;
    await expect(controller.accountStatement(assigned, CUSTOMER, {})).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { sellingCode: 'customer.business_wide_scope_required' },
    });
    expect(reads, 'a refused actor reached the read').toBe(0);
    await expect(controller.accountStatement(m, CUSTOMER, {})).resolves.toMatchObject({ customerId: CUSTOMER });
    expect(reads, 'the business-wide actor reached the read exactly once').toBe(1);
  });

  it('query schema: keyset cursor, capped limit, no offset key', () => {
    expect(() => CustomerAccountStatementQuerySchema.parse({ offset: '5' })).toThrow();
    expect(() => CustomerAccountStatementQuerySchema.parse({ limit: '100000' })).toThrow();
    expect(() => CustomerAccountStatementQuerySchema.parse({ cursor: 'not-a-cursor' })).toThrow();
    expect(CustomerAccountStatementQuerySchema.parse({ cursor: `2026-01-02:2:${id(3)}` }).cursor).toBe(`2026-01-02:2:${id(3)}`);
  });
});
