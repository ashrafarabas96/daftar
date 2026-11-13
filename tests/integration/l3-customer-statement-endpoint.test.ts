import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asMember, registerActor, type HttpActor } from '../helpers/inventory-commands';
import { appDbUrl, ensurePostgres, ownerPool } from '../helpers/test-app';
import {
  baseCurrency,
  newCustomer,
  sellOnCredit,
  settlementMissing,
  settlementWorld,
  stateFxRate,
  stockUp,
  type SettlementWorld,
} from '../golden-regression/phase4-s4/settlement-world';
import { collectPayment } from '../golden-regression/phase4-s4/settlement-path';

/**
 * L3 / P4-S1 — `GET /v1/customers/:customerId/statement`, THE HTTP READER OF
 * `customer_account_statement` (0092), MEASURED THROUGH THE REAL NEST
 * APPLICATION AND THE REAL DATABASE.
 *
 * `tests/integration/l3-customer-statement-running-balance.test.ts` measures
 * the INSTALLED function: its window, its closing law against
 * `customer_ar_outstanding`, its tenant isolation. This suite measures
 * something that file cannot: THE ROUTE. A reader with no endpoint is a reader
 * no merchant can reach, and an endpoint that re-sums, re-orders, truncates or
 * re-types what the reader returned is a SECOND definition of the balance —
 * exactly what `P4-AL-07` refuses.
 *
 * ── WHAT IS ASSERTED, AND WHY EACH GUARD CARRIES A NEGATIVE CONTROL ──────
 *
 * §0 NON-VACUITY. The slice is installed, the reader exists, and the route is
 *    MOUNTED — a 404 here would make every law below a law about a missing
 *    route. The customer really has entries carrying money.
 *
 * §A THE PAGE DOES NOT DECIDE THE BALANCE. This is the whole point of the
 *    design: the running balance is computed by a window INSIDE the reader
 *    over the WHOLE ordered set, so the page boundary cannot move it. The law
 *    is asserted by reading the same statement three ways — one page large
 *    enough to hold it, then in pages of 2, then in pages of 1 — and requiring
 *    the three concatenations to be EQUAL ROW FOR ROW, balance for balance. A
 *    read that summed in TypeScript over a page would restart at each page and
 *    fail this; an OFFSET page over a non-deterministic order would repeat or
 *    skip a row and fail it too. The negative control is in the same test:
 *    the walk really took more than one page (`pages > 1`), so agreement is
 *    not the agreement of two single-page reads.
 *
 * §B THE CURSOR IS A GUARD, AND A CORRUPT ONE IS REFUSED, NOT IGNORED. Six
 *    corrupt shapes — not base64url at all, base64url of the wrong field
 *    count either way, a non-date in the date field, a non-integer rank, a
 *    non-UUID id — each must be a 400 carrying the NAMED code
 *    `customer.statement_cursor_invalid`, not a bare validation failure: a
 *    generic refusal says "your query was malformed", the named one says "the
 *    page you asked to continue from is not one I issued". The NEGATIVE
 *    CONTROL is the arm that makes the six meaningful: the cursor the server
 *    itself issued, on the same route with the same actor, returns rows. A
 *    route that refused everything would pass the six and fail that one.
 *
 * §B2 A MIDDLE PAGE IS VERIFIABLE ON ITS OWN. `openingBalanceByCurrency` is
 *    the balance each currency stood at immediately before the page began.
 *    Two laws, and together they prove the carry ACROSS a page boundary
 *    rather than asserting it: the middle page's opening for a currency
 *    EQUALS the last balance of the previous page in that currency, and the
 *    middle page's first row satisfies
 *    `running === opening + debit − credit` in BigInt. On the FIRST page
 *    every opening is `'0'`, which is the negative control: a field that
 *    merely echoed the first row's balance would fail there.
 *
 * §C A CUSTOMER IN CREDIT CARRIES A NEGATIVE RUNNING BALANCE, AND THE
 *    ENDPOINT REPORTS THE SIGN. Built from a real prepayment: the payment is
 *    dated BEFORE the invoice it is allocated to, so the credit row sorts
 *    ahead of the debit row in the reader's own total order and the balance
 *    passes through a negative value. A read that clamped at zero, or typed
 *    the field as an unsigned number, would fail here. A customer in credit is
 *    a FACT, not an error.
 *
 * §D TWO CURRENCIES ARE NOT SUMMED TOGETHER. The window partitions by
 *    `currency_code`. A payment taken in a foreign currency, on account,
 *    carries NEITHER debit nor credit, so its own partition's running balance
 *    is `'0'` — while the base-currency partition is NON-ZERO at that moment.
 *    That gap is the discriminator: an unpartitioned window would have printed
 *    the carried base balance on the foreign row instead of zero. Both arms
 *    are asserted, so a zero cannot come from an empty read.
 *
 * §E AUTHORITY. `receivables.view` is required and business-wide branch scope
 *    with it, the `GET /v1/customers/:id/receivable` rule: the statement spans
 *    every branch of the business, so an actor limited to some of them is
 *    refused before any read. Each DENY is paired with the ALLOW of the
 *    holder, so a 403 that came from a broken fixture rather than from the
 *    guard would be visible.
 *
 * §F A CUSTOMER THAT DOES NOT EXIST IS `customer.not_found`, the refusal the
 *    sibling reads already give, and NOT an empty statement — an empty page
 *    would say "this customer owes nothing" about a customer that is not
 *    there.
 *
 * §G MINOR UNITS ON THE WIRE. Every amount is an integer STRING that `BigInt`
 *    parses without loss. A `number` on the wire would lose a figure above
 *    2^53 silently, and `JSON.parse` would have already destroyed it before
 *    any assertion could see it.
 */

const CLAIM =
  'GET /v1/customers/:customerId/statement returns the installed reader row for row, with a running balance the page boundary cannot move, a corrupt cursor refused, and the sign of a credit customer intact';

const STATEMENT_PATH = (customerId: string): string => `/v1/customers/${customerId}/statement`;

/** The DTO entry, as the wire carries it. Every amount is a string by contract. */
interface Entry extends Record<string, unknown> {
  entryKind: string;
  entryId: string;
  entryDate: string;
  kindRank: number;
  currencyCode: string;
  debitTxnMinor: string | null;
  creditTxnMinor: string | null;
  runningBalanceTxnMinor: string;
}

interface Opening {
  currencyCode: string;
  txnMinor: string;
}

interface Page {
  items: Entry[];
  openingBalanceByCurrency: Opening[];
  nextCursor: string | null;
}

/** The opening the page states for `currency`, or `undefined` if it states none. */
const openingOf = (p: Page, currency: string): string | undefined => p.openingBalanceByCurrency.find((o) => o.currencyCode === currency)?.txnMinor;

const INTEGER = /^-?\d+$/;

/** The identity of a row for the row-for-row comparison of §A. */
const identity = (e: Entry): string =>
  [e.entryKind, e.entryId, e.entryDate, String(e.kindRank), e.currencyCode, String(e.debitTxnMinor), String(e.creditTxnMinor), e.runningBalanceTxnMinor].join(
    '|',
  );

let app: Pool;
let A: SettlementWorld;
let missing: readonly string[] = [];
let base = '';

/** The actor that HOLDS `receivables.view`, and the one that holds everything but it. */
let holder: HttpActor;
let holderHeaders: Record<string, string> = {};
let deniedHeaders: Record<string, string> = {};

/** The customer with two credit invoices, one partial payment, and a foreign-currency payment on account. */
let customerId = '';
/** The customer who settles IN FULL, on the threshold: exactly zero. */
let settledCustomerId = '';

const PAY_CURRENCY = 'USD';
const RATE = '3.6700000000';

async function role(key: string, permissions: readonly string[]): Promise<void> {
  const r = await A.t.request.post('/v1/businesses/current/roles').set(A.headers).send({ key, name: key, permissions });
  expect(r.status, `role ${key}: ${JSON.stringify(r.body)}`).toBe(201);
}

async function member(a: HttpActor, roleKey: string): Promise<void> {
  const r = await A.t.request.post('/v1/businesses/current/members').set(A.headers).send({ email: a.email, roleKey });
  expect(r.status, `member ${roleKey}: ${JSON.stringify(r.body)}`).toBe(201);
}

/** An actor holding exactly `permissions` in A's business. */
async function narrowActor(name: string, permissions: readonly string[]): Promise<Record<string, string>> {
  const actor = await registerActor(A.t, name);
  const key = `l3-${name.toLowerCase()}`;
  await role(key, permissions);
  await member(actor, key);
  return asMember(actor, A.shop.businessId);
}

/** One page of the route, as `headers` sees it. */
async function readPage(headers: Record<string, string>, id: string, query: Record<string, string> = {}): Promise<{ status: number; body: Page }> {
  const r = await A.t.request.get(STATEMENT_PATH(id)).query(query).set(headers);
  return { status: r.status, body: r.body as Page };
}

/** Walk the whole statement in pages of `size`, following the server's own cursor. */
async function walk(id: string, size: number): Promise<{ items: Entry[]; pages: number }> {
  const items: Entry[] = [];
  let cursor: string | null = null;
  let pages = 0;
  // A bound, so a cursor that failed to advance ends the test instead of the run.
  for (let guard = 0; guard < 200; guard += 1) {
    const query: Record<string, string> = { limit: String(size) };
    if (cursor !== null) query['cursor'] = cursor;
    const page = await readPage(holderHeaders, id, query);
    expect(page.status, `page ${pages} of ${size}: ${JSON.stringify(page.body)}`).toBe(200);
    items.push(...page.body.items);
    pages += 1;
    cursor = page.body.nextCursor;
    if (cursor === null) return { items, pages };
  }
  throw new Error(`the cursor did not terminate within 200 pages of ${size}`);
}

beforeAll(async () => {
  await ensurePostgres();
  app = new Pool({ connectionString: appDbUrl, max: 2 });

  A = await settlementWorld('l3 statement endpoint');
  missing = await settlementMissing(A);
  if (missing.length > 0) return;
  base = await baseCurrency(A);

  await stockUp(A, '200', '1000');
  await stateFxRate(A, PAY_CURRENCY, base, RATE, `${A.day}T00:00:01Z`);

  customerId = await newCustomer(A);
  settledCustomerId = await newCustomer(A);

  // Two debits, so the walk has more than one page to walk.
  const first = await sellOnCredit(A, customerId, '3');
  await sellOnCredit(A, customerId, '2');

  // A partial payment against the first: half, floor-exact in minor units so
  // the fixture states no rounded figure of its own.
  const applied = (BigInt(first.totalTxnMinor) / 2n).toString();
  const paid = await collectPayment(A.t, A.headers, {
    paymentId: randomUUID(),
    customerId,
    paymentMethodId: A.paymentMethodId,
    paymentDate: A.day,
    amountMinor: applied,
    allocations: [
      {
        invoiceId: first.invoiceId,
        appliedMinor: applied,
        releasedBeforeMinor: '0',
        invoiceTotalTxnMinor: first.totalTxnMinor,
        invoiceTotalBaseMinor: first.totalBaseMinor,
      },
    ],
  });
  expect(paid.status, `the partial payment this suite reads back must have been accepted: ${JSON.stringify(paid.body)}`).toBe(201);

  // A payment taken in a FOREIGN currency, on account: zero allocations, which
  // the contract makes lawful. It is the second currency partition, and it
  // carries neither debit nor credit.
  const onAccount = await collectPayment(A.t, A.headers, {
    paymentId: randomUUID(),
    customerId,
    paymentMethodId: A.paymentMethodId,
    paymentDate: A.day,
    currencyCode: PAY_CURRENCY,
    amountMinor: '500',
    creditId: randomUUID(),
    allocations: [],
  });
  expect(onAccount.status, `the ${PAY_CURRENCY} payment on account must have been accepted: ${JSON.stringify(onAccount.body)}`).toBe(201);

  // THE SETTLED CUSTOMER, ON THE THRESHOLD: one invoice, paid in full, on the
  // invoice's own day. The back-dated prepayment that WOULD have driven the
  // balance negative is refused by the write path — see §C.
  const later = await sellOnCredit(A, settledCustomerId, '1');
  const prepaid = await collectPayment(A.t, A.headers, {
    paymentId: randomUUID(),
    customerId: settledCustomerId,
    paymentMethodId: A.paymentMethodId,
    paymentDate: A.day,
    amountMinor: later.totalTxnMinor,
    allocations: [
      {
        invoiceId: later.invoiceId,
        appliedMinor: later.totalTxnMinor,
        releasedBeforeMinor: '0',
        invoiceTotalTxnMinor: later.totalTxnMinor,
        invoiceTotalBaseMinor: later.totalBaseMinor,
      },
    ],
  });
  expect(prepaid.status, `the full settlement must have been accepted: ${JSON.stringify(prepaid.body)}`).toBe(201);

  // The two actors. The holder's scope is left at the business-wide default,
  // which §E's ALLOW arm is the positive control for.
  holder = await registerActor(A.t, 'l3 statement holder');
  await role('l3-stmt-holder', ['receivables.view', 'customers.view']);
  await member(holder, 'l3-stmt-holder');
  holderHeaders = asMember(holder, A.shop.businessId);
  // Everything a customer read might plausibly need EXCEPT the one key the
  // route requires, so a 403 is attributable to `receivables.view` alone.
  // `customers.view` and `payments.collect` are measured members of
  // `PERMISSIONS`; `receivables.view` is deliberately the ONLY key withheld,
  // so a 403 is attributable to it alone and not to an empty role.
  deniedHeaders = await narrowActor('stmtDenied', ['customers.view', 'payments.collect']);
}, 300_000);

afterAll(async () => {
  await app?.end();
});

describe(`§0 non-vacuity — ${CLAIM}`, () => {
  it('the slice is installed and the reader exists', async () => {
    expect(missing, 'a missing relation makes every law below vacuous').toEqual([]);
    const found = await ownerPool().query<{ oid: string | null }>(`SELECT to_regprocedure('public.customer_account_statement(uuid,uuid)')::text AS oid`);
    expect(found.rows[0]?.oid).toBe('customer_account_statement(uuid,uuid)');
  });

  it('the route is MOUNTED, and answers rows carrying money', async () => {
    const page = await readPage(holderHeaders, customerId, { limit: '50' });
    expect(page.status, `GET ${STATEMENT_PATH(':customerId')} answered ${page.status}: ${JSON.stringify(page.body)}`).toBe(200);
    expect(page.body.items.length, 'the statement must carry entries').toBeGreaterThanOrEqual(4);
    expect(page.body.items.filter((e) => e.debitTxnMinor !== null).length, 'two invoices are two debit rows').toBe(2);
    expect(page.body.items.filter((e) => e.creditTxnMinor !== null).length, 'one allocation is one credit row').toBe(1);
  });
});

describe('§A the page boundary cannot move the running balance', () => {
  it('one page, pages of 2 and pages of 1 agree ROW FOR ROW and BALANCE FOR BALANCE', async () => {
    const whole = await readPage(holderHeaders, customerId, { limit: '50' });
    expect(whole.status).toBe(200);
    expect(whole.body.nextCursor, 'the single page must be the whole statement, or it is not the control').toBeNull();

    const byTwo = await walk(customerId, 2);
    const byOne = await walk(customerId, 1);

    // The probe is SIGHTED: the walk really crossed page boundaries. Without
    // this arm two single-page reads would agree trivially.
    expect(byTwo.pages, 'the walk in pages of 2 must have taken more than one page').toBeGreaterThan(1);
    expect(byOne.pages, 'the walk in pages of 1 must have taken more than one page').toBeGreaterThan(1);

    expect(byTwo.items.map(identity), 'pages of 2 must reproduce the whole statement exactly').toEqual(whole.body.items.map(identity));
    expect(byOne.items.map(identity), 'pages of 1 must reproduce the whole statement exactly').toEqual(whole.body.items.map(identity));
  });

  it('a keyset walk neither repeats nor skips an entry — the order is total', async () => {
    const byOne = await walk(customerId, 1);
    const ids = byOne.items.map((e) => e.entryId);
    expect(new Set(ids).size, `${ids.length} entries walked, ${new Set(ids).size} distinct`).toBe(ids.length);
    for (let i = 1; i < byOne.items.length; i += 1) {
      const p = byOne.items[i - 1];
      const c = byOne.items[i];
      if (p === undefined || c === undefined) continue;
      const ordered =
        p.entryDate < c.entryDate || (p.entryDate === c.entryDate && (p.kindRank < c.kindRank || (p.kindRank === c.kindRank && p.entryId < c.entryId)));
      expect(ordered, `row ${i - 1} (${p.entryDate}/${p.kindRank}/${p.entryId}) is not before row ${i} (${c.entryDate}/${c.kindRank}/${c.entryId})`).toBe(true);
    }
  });
});

describe('§B a corrupt cursor is REFUSED, not ignored', () => {
  const corrupt: readonly (readonly [label: string, value: string])[] = [
    ['not base64url at all', 'not a cursor!!'],
    ['the empty string', ''],
    ['base64url of too few fields', Buffer.from('2026-01-01|1', 'utf8').toString('base64url')],
    ['base64url of too many fields', Buffer.from('2026-01-01|1|00000000-0000-4000-8000-000000000000|x', 'utf8').toString('base64url')],
    ['a non-date in the date field', Buffer.from('2026-13-45|1|00000000-0000-4000-8000-000000000000', 'utf8').toString('base64url')],
    ['a non-integer rank', Buffer.from('2026-01-01|one|00000000-0000-4000-8000-000000000000', 'utf8').toString('base64url')],
    ['a non-UUID entry id', Buffer.from('2026-01-01|1|not-a-uuid', 'utf8').toString('base64url')],
  ];

  for (const [label, value] of corrupt) {
    it(`${label} is a 400 carrying customer.statement_cursor_invalid, and is not silently dropped`, async () => {
      const r = await A.t.request.get(STATEMENT_PATH(customerId)).query({ cursor: value }).set(holderHeaders);
      expect(r.status, `cursor ${JSON.stringify(value)} answered ${r.status}: ${JSON.stringify(r.body)}`).toBe(400);
      expect(r.body?.error?.code, JSON.stringify(r.body)).toBe('VALIDATION_FAILED');
      expect(r.body?.error?.details?.sellingCode, `the refusal must be NAMED, not generic: ${JSON.stringify(r.body)}`).toBe(
        'customer.statement_cursor_invalid',
      );
      // AND it did not quietly serve page one instead, which is the failure
      // mode a status assertion alone would not catch.
      expect(r.body?.items, 'a refused cursor must carry no page').toBeUndefined();
    });
  }

  it('THE NEGATIVE CONTROL: the cursor the server issued is accepted on the same route', async () => {
    const first = await readPage(holderHeaders, customerId, { limit: '1' });
    expect(first.status).toBe(200);
    const issued = first.body.nextCursor;
    expect(issued, 'the probe is blind unless the server really issued a cursor').not.toBeNull();
    const second = await readPage(holderHeaders, customerId, { limit: '1', cursor: issued as string });
    expect(second.status, `the server's own cursor was refused: ${JSON.stringify(second.body)}`).toBe(200);
    expect(second.body.items.length, "the server's own cursor must advance to a row").toBe(1);
    expect(second.body.items[0]?.entryId, 'the second page must not repeat the first row').not.toBe(first.body.items[0]?.entryId);
  });
});

describe('§B2 a middle page is verifiable on its own — openingBalanceByCurrency', () => {
  it("the FIRST page opens every currency at '0' — the control a field echoing the first row would fail", async () => {
    const first = await readPage(holderHeaders, customerId, { limit: '2' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.openingBalanceByCurrency.length, 'the probe is sighted: the first page states an opening per currency').toBeGreaterThan(0);
    const currenciesOnPage = new Set(first.body.items.map((e) => e.currencyCode));
    expect(new Set(first.body.openingBalanceByCurrency.map((o) => o.currencyCode)), 'one opening per currency appearing in items').toEqual(currenciesOnPage);
    for (const o of first.body.openingBalanceByCurrency) {
      expect(o.txnMinor, `${o.currencyCode} must open at 0 on the first page and opened at ${o.txnMinor}`).toBe('0');
    }
  });

  it("a MIDDLE page's opening EQUALS the previous page's last balance, and its first row is opening + debit - credit", async () => {
    const first = await readPage(holderHeaders, customerId, { limit: '2' });
    expect(first.status).toBe(200);
    const cursor = first.body.nextCursor;
    expect(cursor, 'the probe is blind unless there IS a middle page').not.toBeNull();

    const middle = await readPage(holderHeaders, customerId, { limit: '2', cursor: cursor as string });
    expect(middle.status, JSON.stringify(middle.body)).toBe(200);
    expect(middle.body.items.length, 'the middle page must carry rows').toBeGreaterThan(0);

    // (1) THE CARRY ACROSS THE BOUNDARY. The anchor is the previous page's
    // last row, so the opening in ITS currency is exactly its balance.
    const anchor = first.body.items[first.body.items.length - 1];
    expect(anchor, 'the first page must have a last row to anchor on').toBeDefined();
    const carried = openingOf(middle.body, (anchor as Entry).currencyCode);
    expect(
      carried,
      `the middle page opened ${(anchor as Entry).currencyCode} at ${String(carried)} and the previous page closed it at ` +
        `${(anchor as Entry).runningBalanceTxnMinor}`,
    ).toBe((anchor as Entry).runningBalanceTxnMinor);

    // (2) AND THE ARITHMETIC OF THE FIRST ROW, in BigInt, from the opening
    // the page itself stated — so the carry is PROVED and not asserted.
    const row = middle.body.items[0] as Entry;
    const opening = openingOf(middle.body, row.currencyCode);
    expect(opening, `the middle page states no opening for ${row.currencyCode}`).toBeDefined();
    const expected = BigInt(opening as string) + BigInt(row.debitTxnMinor ?? '0') - BigInt(row.creditTxnMinor ?? '0');
    expect(
      row.runningBalanceTxnMinor,
      `${row.entryKind}: opening ${String(opening)} + debit ${String(row.debitTxnMinor)} - credit ${String(row.creditTxnMinor)} = ${expected.toString()}, ` +
        `but the row carries ${row.runningBalanceTxnMinor}`,
    ).toBe(expected.toString());
  });
});

describe('§C the zero threshold, and the sign the wire can carry', () => {
  /**
   * WHAT WAS ASKED FOR HERE, AND WHY IT IS NOT ASSERTED AGAINST REAL ROWS.
   *
   * The intended case was a customer IN CREDIT carrying a NEGATIVE running
   * balance, built from a prepayment dated before the invoice it settles so
   * the credit row would sort ahead of the debit row. IT IS NOT REACHABLE ON
   * THIS TREE, and that is MEASURED and not assumed — three independent
   * closures, each with its own refusal:
   *
   *   1. A payment dated before the invoice it is allocated to is REFUSED:
   *      `422 customer_payment.date_before_invoice`. That is the measurement
   *      that killed this fixture; it was run, and the body is quoted in the
   *      lane report. So no credit row can ever precede its own debit row.
   *   2. Over-application is refused: `409
   *      customer_payment.amount_exceeds_outstanding` and
   *      `409 customer_credit_application.amount_exceeds_outstanding`. So the
   *      credit side of a document can never EXCEED its debit side.
   *   3. Settlement is derived and never a status (`P4-AL-24`), so a fully
   *      settled invoice keeps `status = 'open'` and BOTH its debit row and
   *      its credit rows stay in the statement. They cannot leave separately.
   *
   * Together: within a currency the cumulative `debit − credit` is bounded
   * BELOW by zero through every sanctioned write path. The sibling suite
   * reached the same conclusion independently — it proves its own negative
   * case with a SYNTHETIC BigInt fold rather than with database rows
   * (`l3-customer-statement-running-balance.test.ts` §C).
   *
   * A negative balance is therefore a REAL CONTRACT with no producer yet: the
   * reader computes `debit − credit` and will print a minus the day a
   * sanctioned writer can create one (a credit note that lands on the debit
   * side, say). What is asserted below is what can be: the threshold ITSELF
   * at exactly zero, and that the WIRE would carry a minus — the field is a
   * signed integer STRING, not an unsigned number that would have thrown the
   * sign away in `JSON.parse` before any client could read it. The gap is
   * raised for the owner rather than papered over with a hand-built row.
   */
  it('a customer who settles IN FULL closes at EXACTLY zero — the integer 0, not merely falsy', async () => {
    const page = await readPage(holderHeaders, settledCustomerId, { limit: '50' });
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(page.body.items.length, 'the probe is sighted: the settled customer has entries').toBeGreaterThan(0);
    const closing = page.body.items[page.body.items.length - 1]?.runningBalanceTxnMinor;
    expect(closing, `a fully settled customer must close at 0 and closed at ${String(closing)}`).toBe('0');
    // AND the debit and the credit are both still there: if the debit row had
    // left on settlement, this would close at 0 for the wrong reason.
    expect(page.body.items.filter((e) => e.debitTxnMinor !== null).length, 'the settled invoice is still a debit row').toBe(1);
    expect(page.body.items.filter((e) => e.creditTxnMinor !== null).length, 'the settling allocation is still a credit row').toBe(1);
  });

  it('the balance is a SIGNED integer string, so a minus survives the wire', async () => {
    const page = await readPage(holderHeaders, customerId, { limit: '50' });
    expect(page.status).toBe(200);
    for (const e of page.body.items) {
      expect(typeof e.runningBalanceTxnMinor, 'a number could not carry a minus past 2^53, nor the magnitude').toBe('string');
      expect(e.runningBalanceTxnMinor, `${e.entryKind} = ${e.runningBalanceTxnMinor}`).toMatch(/^-?\d+$/);
    }
    // The contract ACCEPTS a minus: the same regex the rows are held to
    // matches a negative integer string. This is a statement about the
    // contract, not about a row the database produced.
    expect('-1').toMatch(/^-?\d+$/);
  });
});

describe('§D two currencies are never summed together', () => {
  it("the foreign-currency payment's own partition reads '0' while the base partition is NON-ZERO", async () => {
    const page = await readPage(holderHeaders, customerId, { limit: '50' });
    expect(page.status).toBe(200);
    const currencies = new Set(page.body.items.map((e) => e.currencyCode));
    expect(currencies.size, `the subject needs two currencies and the statement reported ${JSON.stringify([...currencies])}`).toBe(2);

    const foreign = page.body.items.filter((e) => e.currencyCode === PAY_CURRENCY);
    expect(foreign.length, `the probe is sighted: there are ${PAY_CURRENCY} rows`).toBeGreaterThan(0);
    for (const e of foreign) {
      expect(e.debitTxnMinor, `${e.entryKind} in ${PAY_CURRENCY} must carry no debit`).toBeNull();
      expect(e.creditTxnMinor, `${e.entryKind} in ${PAY_CURRENCY} must carry no credit`).toBeNull();
      expect(e.runningBalanceTxnMinor, `${e.entryKind} in ${PAY_CURRENCY} must read 0 in its own partition`).toBe('0');
    }

    // THE DISCRIMINATOR: the base partition is non-zero, so an unpartitioned
    // window would have printed a non-zero balance on the foreign rows above.
    const baseRows = page.body.items.filter((e) => e.currencyCode === base);
    expect(baseRows.length, `the probe is sighted: there are ${base} rows`).toBeGreaterThan(0);
    const closing = baseRows[baseRows.length - 1]?.runningBalanceTxnMinor;
    expect(BigInt(closing ?? '0') === 0n, `the ${base} partition must be non-zero or §D has no discriminator; it closed at ${String(closing)}`).toBe(false);
  });
});

describe('§E authority — receivables.view AND business-wide scope', () => {
  it('an actor WITHOUT receivables.view is refused 403', async () => {
    const r = await A.t.request.get(STATEMENT_PATH(customerId)).set(deniedHeaders);
    expect(r.status, `the route answered ${r.status} to an actor holding no receivables.view: ${JSON.stringify(r.body)}`).toBe(403);
  });

  it('THE PAIRED ALLOW: the holder of receivables.view reads the same statement', async () => {
    const r = await A.t.request.get(STATEMENT_PATH(customerId)).set(holderHeaders);
    expect(r.status, `the holder was refused, so the 403 above is not attributable to the permission: ${JSON.stringify(r.body)}`).toBe(200);
  });
});

describe('§F a customer that does not exist is a refusal, not an empty statement', () => {
  it('an unknown customer id is customer.not_found and NOT an empty page', async () => {
    const r = await A.t.request.get(STATEMENT_PATH(randomUUID())).set(holderHeaders);
    expect(r.status, JSON.stringify(r.body)).toBe(404);
    expect(JSON.stringify(r.body), 'the refusal must be this module’s own customer.not_found').toMatch(/customer\.not_found/);
  });
});

describe('§G minor units on the wire — integer strings, never a float', () => {
  it('every amount the route returns is an integer string BigInt parses without loss', async () => {
    const page = await readPage(holderHeaders, customerId, { limit: '50' });
    expect(page.status).toBe(200);
    expect(page.body.items.length).toBeGreaterThan(0);
    for (const e of page.body.items) {
      for (const [k, v] of Object.entries(e)) {
        if (!/Minor$/.test(k)) continue;
        if (v === null) continue;
        expect(typeof v, `${e.entryKind}.${k} arrived as ${typeof v}; a number loses a figure above 2^53 before any assertion can see it`).toBe('string');
        expect(v as string, `${e.entryKind}.${k} = ${String(v)}`).toMatch(INTEGER);
        expect(BigInt(v as string).toString()).toBe(v);
      }
      expect(e.runningBalanceTxnMinor, 'the running balance is never null').not.toBeNull();
    }
  });
});
