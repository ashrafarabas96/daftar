/**
 * THE CUSTOMER STATEMENT OVER HTTP — RED FIRST.
 *
 * `0092` added `customer_account_statement(p_business_id, p_customer_id)`, a
 * reader that returns one row per ledger entry with a `running_balance_txn_minor`
 * carried down the document order. Nothing exposes it: measured on `main`,
 * `customer_account_statement` appears in ZERO files, while the same probe
 * finds 26 `receivables` files and 41 files naming `statement` under
 * `apps/api/src` — so the absence is a fact about the tree and not a blind
 * anchor (RULE-11). The reader exists only on this branch's base, `#85` @
 * `a3d380c0`, which is why this work is stacked there rather than on `main`:
 * built on `main` it would be built on a reader that does not exist.
 *
 * This file is the BEHAVIOUR half. Its sibling
 * (`tests-unit/statement-route-is-registered-with-its-authority.test.ts`)
 * pins the authority the route is declared with, which is text; this one
 * drives the route and reads what the merchant would read.
 *
 * WHAT IT ASSERTS, each arm one claim:
 *   §1 the route answers at all, for a customer with two credit sales;
 *   §2 the running balance is the CUMULATIVE sum of the rows above it WITHIN
 *      ITS OWN CURRENCY, which is the one thing a statement is for and the one
 *      thing a per-row reader can get wrong without any row looking wrong;
 *   §2b the rows of one currency arrive as a CONTIGUOUS BLOCK, which is what
 *      makes §2's series well defined at all;
 *   §3 an unknown customer is refused rather than answered with an empty
 *      statement, because "no rows" and "no such customer" are different
 *      facts and a merchant must not read one as the other.
 *
 * WHAT IS DELIBERATELY NOT HERE, named so no reader mistakes its absence for
 * coverage: the BRANCH-SCOPE refusal. A statement spans the business, and the
 * controller enforces that with `assertBusinessWide`, raising
 * `customer.business_wide_scope_required` (`customers.controller.ts:126-127`;
 * I had written `:111`, which is the end of the handler, not the refusal). I
 * did not write an arm for it, because the refusal is raised for an
 * ASSIGNED-SCOPE ACTOR -- the existing suites build one and then call
 * (`inventory-opening-authority.test.ts:66` is the shape) -- and it is NOT
 * reachable by setting a branch header on the owner's request. I had written
 * exactly that invented arm, using a `w.branchId` field that does not exist on
 * `SettlementWorld`, and it would have produced a red that said nothing about
 * the route. The unit sibling pins the DECLARATION (`businessWide: true`),
 * which is text and not enforcement.
 *
 * THE GAP IS NOW CLOSED, AND NOT HERE: both reviews of `c8b1c673` named it,
 * and the money review added the measurement that the whole customers module
 * — this route and its `open-invoices` sibling alike — had no behavioural arm
 * for `customer.business_wide_scope_required` at all. The arm lives in
 * `tests-unit/statement-refuses-an-assigned-scope-actor.test.ts`, at the
 * CONTROLLER level with a counting stub for the read service, because the
 * claim worth making is not "a 403 comes back" but "the ledger is never read
 * before the refusal" — and a stub counts reads where a cluster cannot.
 *
 * IMPORTED RED, NAMED BEFORE IT HAPPENS (the base is another PR's head): this
 * run carries `#85`'s content, so a failure inside `0092`'s own laws or in
 * `apps/api/src/config.ts` belongs to the BASE and not to this change.
 * Anything else here is mine.
 *
 * MEASURED RED, on a real cluster of my own, with the runner idle (0 runs in
 * flight at the moment of starting): `Tests 2 failed | 1 passed (3)`. The app
 * booted and routed -- it answered `404 {"error":{"code":"NOT_FOUND"...}}`,
 * a structured envelope and not a connection error -- so the 404 is the
 * absence of THIS route and not a dead application.
 *
 * AND ONE OF THE THREE PASSED FOR THE WRONG REASON, which is worth more than
 * the two that failed: §3 expects 404 for an unknown customer, and right now
 * EVERY request to this path answers 404, so its green today is VACUOUS. It
 * discriminates only once §1 and §2 are green, because only then does a 404
 * mean "no such customer" rather than "no such route". Nobody should read
 * today's `1 passed` as coverage of the unknown-customer refusal; I write this
 * here rather than in a report because the file is what the next reader opens.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { randomUUID } from 'node:crypto';

import {
  baseCurrency,
  newCustomer,
  sellOnCredit,
  settlementWorld,
  stateFxRate,
  stockUp,
  type SettlementWorld,
} from '../golden-regression/phase4-s4/settlement-world';
import { confirmSale } from '../golden-regression/phase4-s2/sale-path';
import { must } from '../golden-regression/phase4-s4/harness';
import { addTrackedProductPricedIn } from '../helpers/stock-ledger';
import { ownerPool } from '../helpers/test-app';

let w: SettlementWorld;
let customerId: string;

const statementPath = (id: string): string => `/v1/customers/${id}/statement`;

beforeAll(async () => {
  w = await settlementWorld('l3 statement http path');
  await stockUp(w, '20', '100');
  customerId = await newCustomer(w);
  // TWO movements, not one: a single entry cannot tell a running balance from
  // the row's own amount, so a one-sale fixture would pass against a reader
  // that simply echoed each row (the same trap a one-line transfer set for
  // the C6 conservation law, where the document WAS the line).
  await sellOnCredit(w, customerId, '3');
  await sellOnCredit(w, customerId, '5');
}, 600_000);

describe('GET /v1/customers/:customerId/statement', () => {
  it('§1 answers for a customer with two credit sales', async () => {
    const res = await w.t.request.get(statementPath(customerId)).set(w.headers);
    expect(res.status, `the statement route must answer: ${res.status} ${JSON.stringify(res.body)}`).toBe(200);
    expect(Array.isArray(res.body?.rows), 'the statement must carry rows').toBe(true);
    expect(res.body.rows.length, 'two credit sales must produce at least two entries').toBeGreaterThanOrEqual(2);
  }, 300_000);

  it("§2 each row's running balance is the cumulative sum of the rows up to it", async () => {
    const res = await w.t.request.get(statementPath(customerId)).set(w.headers);
    expect(res.status).toBe(200);

    const rows = res.body.rows as readonly Record<string, string | null>[];
    // The fixture must be able to tell the designs apart BEFORE the reader is
    // asked anything: if every debit were zero, a reader that returned zero
    // for every running balance would pass this arm and prove nothing.
    // BIGINT, NOT `Number`. These are `BIGINT` columns and the DTO carries them
    // as text precisely because a JSON number loses precision above 2^53; doing
    // the comparison in `Number` would throw that away inside the very suite
    // meant to protect it. It also produced this file's only two `tsc` errors
    // (TS2532 at the old line 107), because an index into a `number[]` is
    // `number | undefined` under this project's settings.
    //
    // AND NULL IS NOT ZERO: `0092` leaves the side an entry does not belong on
    // NULL, so a missing side counts 0n toward the running sum while the DTO
    // keeps the distinction. The money review of bb45d8ec found this suite
    // reading `string` where the database returns null on four columns.
    const minor = (v: string | null | undefined): bigint => (v === null || v === undefined ? 0n : BigInt(v));
    // ONLY the debit side is gathered as an array, because only it is used --
    // for the discrimination check below. The credit side is read per row
    // inside the loop. An earlier form kept BOTH arrays after I moved the
    // arithmetic into the loop, and eslint caught `credits` as dead: dead
    // credit-side arithmetic sitting in a money suite, which the money review
    // rightly refused to wave through as formatting.
    const debits = rows.map((r) => minor(r.debitTxnMinor));
    expect(debits.reduce((t, d) => t + d, 0n) > 0n, 'the fixture produced no debits, so this arm cannot discriminate').toBe(true);

    // PER CURRENCY, NOT ACROSS THE STATEMENT. `0092:200-203` computes the
    // balance `OVER (PARTITION BY s.currency_code ...)`, so there is one
    // independent series per currency and a single running total across all
    // rows is a law the function does not hold. It passed here because this
    // fixture sells in one currency -- and a law that is only true of its own
    // fixture is how a correct implementation gets a red tomorrow, which is
    // how a law gets disabled. Both reviews of `c8b1c673` named it: the money
    // review as a false red waiting to happen, the independent review as rows
    // delivered interleaved. The reader now sorts by currency first, and this
    // keeps a total per currency so the arm states what the function states.
    const cumulative = new Map<string, bigint>();
    rows.forEach((row, index) => {
      // `String(...)` and not a cast: the rows come back typed as
      // `Record<string, string | null>`, and a Map keyed by `string | null`
      // would let a NULL currency silently become its own series.
      //
      // AND THE FIELD IS `currency`, NOT `currencyCode`. I wrote
      // `row.currencyCode` first -- the COLUMN's name, not the DTO's
      // (`customers.ts:162`/`:305` use `currency`, and the mapper assigns
      // `currency: r.currency_code`) -- so every key became the string
      // "undefined", every row collapsed into ONE series, and this per-currency
      // law silently became the across-currency law it was written to replace.
      // It passed. §4 is what caught it, by demanding TWO currencies be
      // present before it judged anything: a `Record<string, ...>` index
      // yields `undefined` for a wrong name rather than failing, so an
      // untyped row read is a place where a typo passes as a measurement.
      const key = String(row.currency);
      const running = (cumulative.get(key) ?? 0n) + minor(row.debitTxnMinor) - minor(row.creditTxnMinor);
      cumulative.set(key, running);
      expect(
        minor(row.runningBalanceTxnMinor),
        `row ${index + 1} (${row.entryKind}, ${key}) must carry the cumulative balance of ITS OWN currency, not its own amount and not a total across currencies`,
      ).toBe(running);
    });
  }, 300_000);

  it('§2b the rows of one currency arrive as a contiguous block, so the series §2 checks is well defined', async () => {
    const res = await w.t.request.get(statementPath(customerId)).set(w.headers);
    expect(res.status).toBe(200);
    const rows = (res.body as { rows: readonly Record<string, string | null>[] }).rows;
    expect(rows.length, 'NO SUBJECT -- no rows, so there is no ordering to judge').toBeGreaterThan(0);

    // THIS CUSTOMER HOLDS ONE CURRENCY, so `seen.size === 1` here and this arm
    // cannot fail on THIS fixture however the reader sorts. I first wrote that
    // a two-currency fixture was out of reach because `sellOnCredit` derives
    // the currency from the business row -- and that was wrong: the base
    // branch's own suite already builds one at
    // `l3-customer-statement-running-balance.test.ts:758-830`, by pricing a
    // product in a second catalogue currency. So the discriminating arm is
    // §4 below, on a customer of its own, and this one states the law for
    // every customer the route answers for.
    const seen = new Set<string>();
    let previous: string | null = null;
    rows.forEach((row, index) => {
      const code = String(row.currency);
      if (code !== previous) {
        expect(
          seen.has(code),
          `currency ${code} appears again at row ${index + 1} after another currency came between: the series are interleaved and the running balance column mixes two of them`,
        ).toBe(false);
        seen.add(code);
        previous = code;
      }
    });
  }, 300_000);

  it('§4 THE DISCRIMINATING ARM: a customer holding TWO currencies is handed each series as its own block, each cumulative within itself', async () => {
    // §2 and §2b are both true of a one-currency customer no matter how the
    // reader sorts, so neither of them measured the defect the reviews of
    // `c8b1c673` found: `0092:200-203` computes the balance
    // `OVER (PARTITION BY s.currency_code ...)`, and the reader's ORDER BY had
    // only the three date keys. Two currencies therefore arrived INTERLEAVED,
    // with every row's own figure right and the column as a whole a mix of two
    // independent series -- a number the merchant reads and cannot use.
    //
    // The recipe is not invented here: the base branch's own suite builds a
    // two-currency customer at
    // `l3-customer-statement-running-balance.test.ts:758-830`, and this arm
    // reuses it and then reads the result OVER HTTP, which is the half that
    // suite does not cover (it reads the function directly). The second code
    // is read from the `currencies` catalogue rather than typed, or it would
    // fail the foreign key and say nothing about the partition.
    const baseCode = await baseCurrency(w);
    const other = await ownerPool().query<{ code: string }>('SELECT c.code FROM currencies c WHERE c.code <> $1 ORDER BY c.code LIMIT 1', [baseCode]);
    const foreignCode = must(other.rows[0], 'NO SUBJECT -- the catalogue holds no second currency, so this arm has no partition to measure').code;
    expect(foreignCode, 'the second currency must differ from the base').not.toBe(baseCode);

    const days = await ownerPool().query<{ d: string }>(`SELECT to_char($1::date - g, 'YYYY-MM-DD') AS d FROM generate_series(3, 0, -1) AS g`, [w.day]);
    expect(days.rows.length, 'NO SUBJECT -- four distinct business days are needed to interleave two currencies').toBe(4);
    const [d1, d2, d3, d4] = days.rows.map((r) => r.d);
    expect(new Set([d1, d2, d3, d4]).size, 'the four days must differ, or the order falls through to a random entry_id').toBe(4);

    // THE RATE IS EFFECTIVE FROM THE EARLIEST OF THOSE DAYS, not from `w.day`.
    // Stated at `w.day` it produced `sale.fx_rate_missing` (422) on the first
    // foreign sale, which is three days earlier: a rate is a dated fact and a
    // sale before its effective instant has none. The measured refusal is the
    // reason this line sits after the days are known.
    await stateFxRate(w, foreignCode, baseCode, '3.5000000000', `${must(d1, 'the earliest business day')}T00:00:00Z`);
    const priced = await addTrackedProductPricedIn(ownerPool(), w.shop, foreignCode);
    const inbound = await w.t.request
      .post('/v1/inventory/adjustments')
      .set(w.headers)
      .send({
        adjustmentId: randomUUID(),
        warehouseId: w.shop.w1,
        occurredOn: w.day,
        reason: 'l3 statement http two-currency arm',
        lines: [{ productId: priced.productId, quantity: '50', unitCost: '7' }],
      });
    expect(inbound.status, `the priced inbound for the foreign-currency product is accepted: ${JSON.stringify(inbound.body)}`).toBe(201);

    const twoCustomer = await newCustomer(w);

    // FOUR INVOICES ON FOUR DISTINCT DAYS, ALTERNATING CURRENCY, and the shape
    // is the whole point. My first version of this arm sold ONCE in each
    // currency, and I planted the old three-key ORDER BY to see it redden --
    // IT STAYED GREEN. With one row per currency every possible order gives
    // two contiguous blocks of one, so the arm was vacuous and my fix was
    // unproven. The function's own final order is three keys with no currency
    // (`0092:282`), so under the old reader the delivered order is date-only:
    // alternating the currency day by day makes that order interleave them,
    // and `currency_code` first makes each a block of two. The days are
    // computed by the database rather than typed, as
    // `inventory-s3-adjustment.test.ts:334` does, and they must not tie --
    // equal dates fall through to `entry_id`, a random UUID, which would make
    // this arm a coin toss rather than a measurement.
    const sell = async (day: string | undefined, productId: string, quantity: string): Promise<void> => {
      const res = await confirmSale(w.t, w.headers, {
        saleId: randomUUID(),
        customerId: twoCustomer,
        warehouseId: w.shop.w1,
        branchId: w.shop.branchX,
        occurredOn: must(day, 'a business day for this sale'),
        lines: [{ productId, quantity }],
      });
      expect(res.status, `the sale on ${String(day)} commits: ${JSON.stringify(res.body)}`).toBeLessThan(300);
    };

    await sell(d1, w.shop.piece.productId, '2');
    await sell(d2, priced.productId, '3');
    await sell(d3, w.shop.piece.productId, '1');
    await sell(d4, priced.productId, '2');

    const res = await w.t.request.get(statementPath(twoCustomer)).set(w.headers);
    expect(res.status, `the statement answers for the two-currency customer: ${JSON.stringify(res.body)}`).toBe(200);
    const rows = (res.body as { rows: readonly Record<string, string | null>[] }).rows;

    // THE SUBJECT FIRST. Without two currencies actually present, everything
    // below is vacuously true and this arm would be the blind zero it exists
    // to replace.
    const currencies = new Set(rows.map((r) => String(r.currency)));
    // And at least TWO rows per currency, or contiguity is satisfied by any
    // order and this arm is back to being vacuous.
    const perCurrency = new Map<string, number>();
    rows.forEach((r) => perCurrency.set(String(r.currency), (perCurrency.get(String(r.currency)) ?? 0) + 1));
    [...perCurrency.entries()].forEach(([code, n]) => {
      expect(n, `currency ${code} has ${n} row(s): with fewer than two, a contiguous block is guaranteed whatever the order`).toBeGreaterThanOrEqual(2);
    });
    expect(
      currencies.size,
      `NO SUBJECT -- the statement carries ${currencies.size} currency/currencies (${[...currencies].join(', ')}), so there is no partition to measure`,
    ).toBe(2);
    expect(
      currencies.has(baseCode) && currencies.has(foreignCode),
      `the two series must be ${baseCode} and ${foreignCode}, and they are ${[...currencies].join(', ')}`,
    ).toBe(true);

    // (a) each currency is ONE contiguous block. This is what fails when the
    // reader drops `s.currency_code` from its ORDER BY.
    const seen = new Set<string>();
    let previous: string | null = null;
    rows.forEach((row, index) => {
      const code = String(row.currency);
      if (code !== previous) {
        expect(
          seen.has(code),
          `currency ${code} appears again at row ${index + 1} after another currency came between: the two series are interleaved and the running-balance column mixes them`,
        ).toBe(false);
        seen.add(code);
        previous = code;
      }
    });

    // (b) and inside each block the balance is cumulative for THAT currency
    // alone -- the law `0092`'s partition states, asserted per key so a total
    // across currencies cannot satisfy it.
    const minor = (v: string | null | undefined): bigint => (v === null || v === undefined ? 0n : BigInt(v));
    const running = new Map<string, bigint>();
    rows.forEach((row, index) => {
      const code = String(row.currency);
      const next = (running.get(code) ?? 0n) + minor(row.debitTxnMinor) - minor(row.creditTxnMinor);
      running.set(code, next);
      expect(
        minor(row.runningBalanceTxnMinor),
        `row ${index + 1} (${String(row.entryKind)}, ${code}) must carry the cumulative balance of ITS OWN currency`,
      ).toBe(next);
    });

    // (c) and the two series are genuinely independent: neither closing figure
    // may equal the sum of both, which is what an unpartitioned reader would
    // have produced on the last row.
    const closes = [...running.values()];
    expect(closes.length).toBe(2);
    const both = closes.reduce((t, c) => t + c, 0n);
    expect(
      closes.some((c) => c === both),
      `one series closes at the sum of both (${both}), so the partition is not holding`,
    ).toBe(false);
  }, 900_000);

  it('§3 refuses an unknown customer instead of answering with an empty statement', async () => {
    const res = await w.t.request.get(statementPath('00000000-0000-4000-8000-000000000000')).set(w.headers);
    expect(res.status, 'an unknown customer must not read as a customer with no entries').toBe(404);
  }, 300_000);
});
