import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appDbUrl, ensurePostgres, ownerPool } from '../helpers/test-app';
import { newCustomer, sellOnCredit, settlementMissing, settlementWorld, stockUp, type SettlementWorld } from '../golden-regression/phase4-s4/settlement-world';
import { applyCredit, collectPayment, rateToR10 } from '../golden-regression/phase4-s4/settlement-path';
import { creditSnapshot, must } from '../golden-regression/phase4-s4/harness';

/**
 * 0092 — THE INSTALLED `customer_account_statement`, MEASURED.
 *
 * `tests/guards/mig-0092-statement-running-balance-law.test.ts` reads the
 * migration's TEXT: that the window is there, that the path is pinned, that
 * PUBLIC is revoked, that there is no DML. Every one of those laws rests on a
 * premise it cannot itself check — that the function INSTALLED in the database
 * is the function that file describes, and that its ARITHMETIC is right.
 * Reading a migration body is not measuring the function that is installed:
 * this project has a recorded scar for exactly that distinction.
 *
 * So this suite asks the database, as `daftar_app` and under the tenant GUCs,
 * which is the only principal that will ever call this reader.
 *
 * ── WHAT IS ASSERTED ─────────────────────────────────────────────────────
 *
 * §0 NON-VACUITY. The slice is installed, the reader exists, and merchant A's
 *    statement really carries rows carrying money. A conservation law over an
 *    empty set is the vacuous pass this whole file exists to avoid.
 * §A THE CLOSING LAW, the reason the permit was given. Per currency, the LAST
 *    running balance equals `customer_ar_outstanding.txn_minor` EXACTLY — as
 *    an ABSOLUTE integer value, and not only as an identity between two sums
 *    this suite computed the same way. The second arm is the independent
 *    oracle: a running fold in BigInt over the reader's own `debit`/`credit`
 *    columns, in the reader's own order. Two different machines — a SQL window
 *    and a TypeScript fold — must produce the same integer on EVERY row.
 * §B TENANT ISOLATION, AND THE LAW BEFORE THE STATUS. The law is: the other
 *    merchant's rows DO NOT MOVE AND ARE NOT RETURNED. B's own statement is
 *    read and kept BEFORE A ever asks, A then asks for B's business and
 *    customer, and the assertions run in this order — (1) the returned set
 *    contains ZERO entry of B's, (2) B's rows are value-for-value what they
 *    were, (3) only THEN the shape of A's answer. A status assertion placed
 *    first would throw and hide the law's own assertion behind it.
 * §C THE BOUNDARIES, each on both sides and ON the threshold. A customer with
 *    NO activity answers the empty set and NOT an error. A fully-settled
 *    customer closes at EXACTLY zero. A customer in CREDIT carries a NEGATIVE
 *    running balance. The payment row — stated, with neither side — moves the
 *    balance by exactly nothing, so the row before it and the row itself carry
 *    the same integer. Two entries on the SAME DATE are separated by
 *    `kind_rank` and then by `entry_id`, so the order is total and the balance
 *    on a row does not depend on which page asked for it.
 * §D MINOR UNITS. Every amount comes back as an integer string: `BigInt`
 *    parses it without loss and `/^-?\d+$/` matches it. No float, ever.
 *
 * ── WHAT CANNOT BE RUN WHERE THIS WAS WRITTEN ────────────────────────────
 *
 * There is no PostgreSQL on the authoring machine, and the shared embedded
 * cluster is another lane's instrument (RULE-17), so NONE of this was measured
 * locally: it is NOT_RUN, which counts as nothing. The runner is the judge.
 */

const CLAIM =
  "the INSTALLED customer_account_statement carries a per-currency cumulative running balance that closes on customer_ar_outstanding exactly, and returns no row of another merchant's";

/** One row of the installed reader, selected as the read will select it. */
interface StatementRow extends Record<string, unknown> {
  entry_kind: string;
  entry_id: string;
  entry_date_text: string;
  kind_rank: number;
  currency_code: string;
  debit_txn_minor: string | null;
  credit_txn_minor: string | null;
  running_balance_txn_minor: string;
}

interface OutstandingRow extends Record<string, unknown> {
  currency_code: string;
  txn_minor: string;
}

const SELECT_STATEMENT = `
  SELECT s.entry_kind, s.entry_id, to_char(s.entry_date, 'YYYY-MM-DD') AS entry_date_text, s.kind_rank,
         s.currency_code, s.debit_txn_minor::text AS debit_txn_minor, s.credit_txn_minor::text AS credit_txn_minor,
         s.running_balance_txn_minor::text AS running_balance_txn_minor
    FROM customer_account_statement($1::uuid, $2::uuid) s
   -- THE ORDER IS ASKED FOR, not inherited from the plan. Both laws in this
   -- file read the row SEQUENCE: §A takes the LAST running balance per
   -- currency, and foldRunning accumulates in arrival order. Without an
   -- ORDER BY those laws rest on the function's body keeping its own
   -- ordering through whatever plan is chosen -- true in every run measured
   -- so far (Function Scan, not inlined), and still a plan artefact rather
   -- than a contract. A law that depends on the planner is a law that passes
   -- until the day it does not.
   --
   -- foldRunning keys its accumulator on currency_code, so partitioning
   -- the output by currency first changes no figure it computes; it only
   -- makes the sequence the laws judge the one the query demanded.
   ORDER BY s.currency_code, s.entry_date, s.kind_rank, s.entry_id`;

/** One `daftar_app` statement under the tenant/business GUCs of `scope`. */
async function asApp<T extends Record<string, unknown>>(
  pool: Pool,
  scope: { readonly tenantId: string; readonly businessId: string },
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [scope.tenantId, scope.businessId]);
    const r = await client.query<T>(sql, [...params]);
    await client.query('COMMIT');
    return r.rows;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * THE INDEPENDENT ORACLE. A running fold in BigInt over the reader's own
 * debit/credit columns, per currency, in the order the reader returned. It
 * shares no arithmetic with the SQL window: if the two agree on every row, the
 * window's frame, its partition and its order are all right; if they disagree,
 * the row they first disagree on names the defect.
 */
function foldRunning(rows: readonly StatementRow[]): readonly string[] {
  const acc = new Map<string, bigint>();
  return rows.map((r) => {
    const previous = acc.get(r.currency_code) ?? 0n;
    const next = previous + BigInt(r.debit_txn_minor ?? '0') - BigInt(r.credit_txn_minor ?? '0');
    acc.set(r.currency_code, next);
    return next.toString();
  });
}

const INTEGER = /^-?\d+$/;

let app: Pool;
let A: SettlementWorld;
let B: SettlementWorld;
let missing: readonly string[] = [];

/** A's customer: two credit invoices and one partial payment against the first. */
let aCustomer: string;
let aRows: readonly StatementRow[] = [];
let aOutstanding: readonly OutstandingRow[] = [];
/** The customer who did nothing at all. */
let quietCustomer: string;
/** B's customer and B's own statement, READ BEFORE A EVER ASKS. */
let bCustomer: string;
let bRowsBefore: readonly StatementRow[] = [];
let bRowsAfter: readonly StatementRow[] = [];
/** What A got back when it asked for B's business and B's customer. */
let aAskingForB: readonly StatementRow[] = [];
let aAskingForBFailure: string | null = null;

beforeAll(async () => {
  await ensurePostgres();
  app = new Pool({ connectionString: appDbUrl, max: 4 });

  A = await settlementWorld('statement A');
  B = await settlementWorld('statement B');
  missing = await settlementMissing(A);
  if (missing.length > 0) return;

  await stockUp(A, '100', '1000');
  await stockUp(B, '100', '1000');

  aCustomer = await newCustomer(A);
  quietCustomer = await newCustomer(A);
  bCustomer = await newCustomer(B);

  // A's two debits, and B's one. Both merchants' documents exist before either
  // statement is read, so the isolation case is not an artefact of ordering.
  const first = await sellOnCredit(A, aCustomer, '3');
  await sellOnCredit(A, aCustomer, '2');
  await sellOnCredit(B, bCustomer, '4');

  // One PARTIAL payment against A's first invoice: half of it, floor-exact in
  // minor units so the fixture states no rounded figure of its own.
  const applied = (BigInt(first.totalTxnMinor) / 2n).toString();
  const paid = await collectPayment(A.t, A.headers, {
    paymentId: randomUUID(),
    customerId: aCustomer,
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
  expect(paid.status, 'the partial payment this whole suite reads back must have been accepted').toBe(201);

  // B's statement FIRST, and kept. The law compares against these values.
  bRowsBefore = await asApp<StatementRow>(app, B.shop, SELECT_STATEMENT, [B.shop.businessId, bCustomer]);

  aRows = await asApp<StatementRow>(app, A.shop, SELECT_STATEMENT, [A.shop.businessId, aCustomer]);
  aOutstanding = await asApp<OutstandingRow>(
    app,
    A.shop,
    `SELECT r.currency_code, r.txn_minor::text AS txn_minor FROM customer_ar_outstanding($1::uuid, $2::uuid) r`,
    [A.shop.businessId, aCustomer],
  );

  // A asks for B's business and B's customer. Whatever this does — rows,
  // nothing, or a refusal — is captured and asserted on LATER, in the order
  // §B states, so a throw cannot pre-empt the law's own assertion.
  try {
    aAskingForB = await asApp<StatementRow>(app, A.shop, SELECT_STATEMENT, [B.shop.businessId, bCustomer]);
  } catch (e) {
    aAskingForBFailure = e instanceof Error ? e.message : String(e);
  }

  bRowsAfter = await asApp<StatementRow>(app, B.shop, SELECT_STATEMENT, [B.shop.businessId, bCustomer]);
}, 240_000);

afterAll(async () => {
  await app?.end();
});

describe(`§0 non-vacuity — ${CLAIM}`, () => {
  it('the slice is installed and the reader exists', async () => {
    expect(missing, 'a missing relation makes every law below vacuous').toEqual([]);
    const found = await ownerPool().query<{ oid: string | null }>(`SELECT to_regprocedure('public.customer_account_statement(uuid,uuid)')::text AS oid`);
    expect(found.rows[0]?.oid).toBe('customer_account_statement(uuid,uuid)');
  });

  it("A's statement carries rows, and money", () => {
    expect(aRows.length).toBeGreaterThanOrEqual(4);
    expect(aRows.filter((r) => r.debit_txn_minor !== null).length, 'two invoices must be two debit rows').toBe(2);
    expect(aRows.filter((r) => r.credit_txn_minor !== null).length, 'one allocation must be one credit row').toBe(1);
    expect(aOutstanding.length, 'the reader of record must answer for one currency').toBe(1);
  });
});

describe('§A the closing law — the last running balance IS the reader of record', () => {
  // THE SUBJECT, ASSERTED HERE AND NOT ONLY IN §0. `beforeAll` returns early
  // when a relation is missing (`:165`), which leaves `aRows` and
  // `aOutstanding` EMPTY -- and then every law in this section passes by
  // iterating over nothing. §0 does go red in that case, so the FILE is red;
  // but a law that is GREEN on a fixture which never reached the function
  // under test is the vacuous pass this file's own header says it exists to
  // avoid, and a green line in a report is how a wrong conclusion gets drawn
  // from a red file. So this section states the minimum it needs before it
  // judges anything.
  beforeAll(() => {
    expect(aRows.length, 'NO SUBJECT — the statement returned no row, so nothing below judges the function').toBeGreaterThan(0);
    expect(aOutstanding.length, 'NO SUBJECT — the reader of record returned nothing, so the closing law has no right-hand side').toBeGreaterThan(0);
  });

  it('per currency, the last running balance equals customer_ar_outstanding.txn_minor exactly', () => {
    const last = new Map<string, string>();
    for (const r of aRows) last.set(r.currency_code, r.running_balance_txn_minor);
    for (const o of aOutstanding) {
      // Absolute values, both printed, so a failure says WHICH integer is wrong
      // and not merely that two expressions differ.
      expect(
        last.get(o.currency_code),
        `${o.currency_code}: the statement closes at ${String(last.get(o.currency_code))} and the reader of record states ${o.txn_minor}`,
      ).toBe(o.txn_minor);
    }
    // AND THE OTHER DIRECTION, which is where the old form was simply wrong.
    // It asserted `last.size === aOutstanding.length`, i.e. that the two
    // report the SAME SET of currencies. They do not, by construction:
    // `customer_ar_outstanding` ends with `HAVING sum(...) <> 0`
    // (`0083:378`), so a currency settled in full yields NO row there, while
    // the statement still carries its documents and closes them at `0`. On a
    // fully settled customer the old line read `1` against `0` and would have
    // gone red for a correct statement.
    //
    // So the law is directional: every currency the reader reports is closed
    // on above, and a currency only the STATEMENT reports must close at
    // exactly zero -- the `HAVING` difference, and nothing else hiding in it.
    const reported = new Set(aOutstanding.map((o) => o.currency_code));
    for (const [currency, closing] of last)
      if (!reported.has(currency))
        expect(closing, `${currency}: the reader of record omits it, so the statement must close it at exactly 0 and it closed at ${closing}`).toBe('0');
    // THE POSITIVE CONTROL for that loop: this fixture is half paid on
    // purpose, so the reader DOES report its currency and the loop above must
    // have had nothing to skip. Without this, the directional law would pass
    // vacuously on a fixture whose currencies the reader never reports.
    expect(
      [...last.keys()].filter((c) => !reported.has(c)),
      'this fixture is half paid, so no currency of it is omitted by the reader',
    ).toEqual([]);
  });

  it('the SQL window agrees with an independent BigInt fold on EVERY row', () => {
    expect(aRows.map((r) => r.running_balance_txn_minor)).toEqual(foldRunning(aRows));
  });
});

describe('§B tenant isolation — the law before the status', () => {
  it("(1) A's answer for B's customer contains ZERO of B's entries", () => {
    const bIds = new Set(bRowsBefore.map((r) => r.entry_id));
    expect(bIds.size, 'the probe is sighted: B really has entries to leak').toBeGreaterThan(0);
    const leaked = aAskingForB.filter((r) => bIds.has(r.entry_id)).map((r) => `${r.entry_kind}:${r.entry_id}`);
    expect(leaked, "A must see none of B's statement entries").toEqual([]);
  });

  it("(2) B's rows did not move: value for value, before and after", () => {
    expect(bRowsAfter.length, `B had ${bRowsBefore.length} rows before A read and ${bRowsAfter.length} after`).toBe(bRowsBefore.length);
    for (let i = 0; i < bRowsBefore.length; i += 1) {
      const before = bRowsBefore[i];
      const after = bRowsAfter[i];
      expect(
        [after?.entry_id, after?.debit_txn_minor, after?.credit_txn_minor, after?.running_balance_txn_minor],
        `B row ${i}: before (${String(before?.debit_txn_minor)}/${String(before?.credit_txn_minor)}/${String(before?.running_balance_txn_minor)}) ` +
          `after (${String(after?.debit_txn_minor)}/${String(after?.credit_txn_minor)}/${String(after?.running_balance_txn_minor)})`,
      ).toEqual([before?.entry_id, before?.debit_txn_minor, before?.credit_txn_minor, before?.running_balance_txn_minor]);
    }
  });

  it('(3) and only now the shape of that answer: the empty set, not another merchant’s money', () => {
    if (aAskingForBFailure !== null) {
      expect(aAskingForBFailure).toMatch(/not_found|permission denied/);
      return;
    }
    expect(aAskingForB).toEqual([]);
  });
});

/**
 * §B2 — A SEPARATE LAW, AND DELIBERATELY NOT FOLDED INTO §B.
 *
 * §B asserts that the CALLER cannot reach another merchant's statement: its
 * subject is reachability, and its evidence is that none of B's entry ids comes
 * back and that none of B's rows moved.
 *
 * This section asserts something else about the same call: WHAT THE READER
 * ANSWERS WITH. The owner's text is «`INVOKER` keeps row security in force»,
 * and the law that follows from it is that `p_business_id` FILTERS ABOVE the
 * caller's own policies — so a foreign id yields THE EMPTY SET. Not a refusal,
 * not an exception, not one partial row. The three outcomes are different
 * defects and only an assertion on the COUNT separates them: a reader that
 * raised would be a reader whose filter never ran, and a reader that returned
 * one row would be a leak of exactly one row.
 *
 * It is `NOT_RUN` where it was written: it needs a live cluster.
 */
describe('§B2 the foreign business_id answers ZERO ROWS — the filter above the policies', () => {
  it('A asking with B’s business_id gets exactly 0 rows, not a refusal and not a partial row', () => {
    expect(aAskingForBFailure, 'the law is ZERO ROWS: a refusal means the filter never ran, which is a different reader').toBeNull();
    expect(
      aAskingForB.length,
      `a foreign business_id returned ${aAskingForB.length} row(s); the law is that it filters above the caller's policies and returns none`,
    ).toBe(0);
    // The probe is SIGHTED: the very same statement text, under B's own GUCs,
    // returns rows for the same arguments. Without this arm a zero could come
    // from a broken query rather than from the filter (RULE-11).
    expect(bRowsAfter.length, 'the probe is blind: the same call returns nothing for B either').toBeGreaterThan(0);
  });
});

describe('§C the boundaries', () => {
  it('a customer with no activity answers the EMPTY SET and not an error', async () => {
    const rows = await asApp<StatementRow>(app, A.shop, SELECT_STATEMENT, [A.shop.businessId, quietCustomer]);
    expect(rows).toEqual([]);
  });

  it('the payment row, with neither side, moves the balance by exactly nothing', () => {
    const i = aRows.findIndex((r) => r.entry_kind === 'payment');
    expect(i, 'the probe is sighted: there is a payment row to test').toBeGreaterThan(0);
    expect(aRows[i]?.debit_txn_minor).toBeNull();
    expect(aRows[i]?.credit_txn_minor).toBeNull();
    expect(aRows[i]?.running_balance_txn_minor).toBe(aRows[i - 1]?.running_balance_txn_minor);
  });

  it('entries on the SAME date are ordered by kind_rank and then by entry_id — a total order WITHIN a currency', () => {
    // THE ORDER THIS LAW JUDGES IS THE WINDOW'S OWN, AND THE WINDOW IS
    // PARTITIONED. `0092` accumulates
    // `OVER (PARTITION BY currency_code ORDER BY entry_date, kind_rank, entry_id)`,
    // so the triple is strictly increasing INSIDE a currency and says nothing
    // across one. An earlier form of this case compared every consecutive pair
    // globally, which was true only because every fixture here had a single
    // currency -- and it became a trap the moment the probe started asking for
    // `ORDER BY s.currency_code, …` (added so the laws stop resting on the
    // planner): at a currency boundary the date legitimately goes BACKWARDS,
    // and the law would have gone red on a CORRECT reader. The law that forbids
    // the case it requires is the false-failure shape this lane keeps writing
    // rules against, and this one was mine.
    //
    // So: the triple increases within a currency, and the currencies arrive in
    // contiguous blocks -- which is what makes "within a currency" a partition
    // of the rows and not a filter over them.
    const seenBlocks: string[] = [];
    for (let i = 0; i < aRows.length; i += 1) {
      const c = aRows[i];
      if (c === undefined) continue;
      if (seenBlocks[seenBlocks.length - 1] !== c.currency_code) seenBlocks.push(c.currency_code);
      const p = aRows[i - 1];
      if (i === 0 || p === undefined || p.currency_code !== c.currency_code) continue;
      const ordered =
        p.entry_date_text < c.entry_date_text ||
        (p.entry_date_text === c.entry_date_text && (p.kind_rank < c.kind_rank || (p.kind_rank === c.kind_rank && p.entry_id < c.entry_id)));
      expect(
        ordered,
        `row ${i - 1} (${p.currency_code}/${p.entry_date_text}/${p.kind_rank}/${p.entry_id}) is not before row ${i} (${c.currency_code}/${c.entry_date_text}/${c.kind_rank}/${c.entry_id})`,
      ).toBe(true);
    }
    // No currency may appear in two separate blocks: that would mean the rows
    // of one partition are interleaved with another's, and then "within a
    // currency" above would be skipping pairs it ought to have judged.
    expect(seenBlocks.length, 'every currency must arrive as ONE contiguous block').toBe(new Set(seenBlocks).size);
    // And the probe is sighted: it saw rows at all.
    expect(seenBlocks.length, 'NO SUBJECT — the statement returned no currency block to order').toBeGreaterThan(0);
  });

  it('a customer who settles in full closes at EXACTLY zero, and one in credit goes NEGATIVE', async () => {
    const payer = await newCustomer(A);
    const inv = await sellOnCredit(A, payer, '1');
    const full = await collectPayment(A.t, A.headers, {
      paymentId: randomUUID(),
      customerId: payer,
      paymentMethodId: A.paymentMethodId,
      paymentDate: A.day,
      amountMinor: inv.totalTxnMinor,
      allocations: [
        {
          invoiceId: inv.invoiceId,
          appliedMinor: inv.totalTxnMinor,
          releasedBeforeMinor: '0',
          invoiceTotalTxnMinor: inv.totalTxnMinor,
          invoiceTotalBaseMinor: inv.totalBaseMinor,
        },
      ],
    });
    expect(full.status).toBe(201);

    const rows = await asApp<StatementRow>(app, A.shop, SELECT_STATEMENT, [A.shop.businessId, payer]);
    const closing = rows[rows.length - 1]?.running_balance_txn_minor;
    // ON the threshold: zero, as the integer `'0'`, not merely falsy.
    expect(closing, `a fully settled customer must close at 0 and closed at ${String(closing)}`).toBe('0');

    // AND THE READER OF RECORD, WHICH THIS ARM NEVER ASKED. The closing
    // figure above was asserted against a literal; the one claim the card
    // makes is about agreement with `customer_ar_outstanding`, and the only
    // place that agreement is interesting -- the zero boundary -- was the one
    // place nothing measured it. At full settlement the reader reports NO ROW
    // for the currency (`HAVING sum(...) <> 0`, `0083:378`), so that absence
    // is the assertion.
    const settledReader = await asApp<OutstandingRow>(
      app,
      A.shop,
      `SELECT r.currency_code, r.txn_minor::text AS txn_minor FROM customer_ar_outstanding($1::uuid, $2::uuid) r`,
      [A.shop.businessId, payer],
    );
    expect(settledReader, `the reader of record must report nothing for a fully settled customer; it reported ${JSON.stringify(settledReader)}`).toEqual([]);
    // THE POSITIVE CONTROL for that emptiness, through the SAME call and the
    // same connection: the half-paid customer of §A still gets a row. An
    // empty answer from a probe that cannot see would otherwise read as
    // agreement (RULE-11/RULE-18).
    const openReader = await asApp<OutstandingRow>(
      app,
      A.shop,
      `SELECT r.currency_code, r.txn_minor::text AS txn_minor FROM customer_ar_outstanding($1::uuid, $2::uuid) r`,
      [A.shop.businessId, aCustomer],
    );
    expect(openReader.length, 'the same call must still answer for a customer who owes, or the emptiness above measures nothing').toBeGreaterThan(0);
    expect(rows.map((r) => r.running_balance_txn_minor)).toEqual(foldRunning(rows));
    // One minor unit past the threshold, in the direction a credit note goes:
    // the fold over the same rows plus one more applied unit is NEGATIVE, and
    // a customer in credit is a FACT, not an error.
    const overpaid = foldRunning([
      ...rows,
      {
        ...(rows[rows.length - 1] as StatementRow),
        entry_id: randomUUID(),
        kind_rank: 5,
        debit_txn_minor: null,
        credit_txn_minor: '1',
      },
    ]);
    expect(overpaid[overpaid.length - 1]).toBe('-1');
  });
});

describe('§D minor units — integers, never a float', () => {
  it('every amount the reader returns is an integer string BigInt parses without loss', () => {
    expect(aRows.length).toBeGreaterThan(0);
    for (const r of aRows) {
      for (const [k, v] of Object.entries({
        debit_txn_minor: r.debit_txn_minor,
        credit_txn_minor: r.credit_txn_minor,
        running_balance_txn_minor: r.running_balance_txn_minor,
      })) {
        if (v === null) continue;
        expect(v, `${r.entry_kind}.${k} = ${v}`).toMatch(INTEGER);
        expect(BigInt(v).toString()).toBe(v);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §E — THE END-STATE CLAIMS SEEN REFUSING, which nothing had watched.
//
// `0092`'s `DO $post$` block (`:306`–`:409`) carries NINE named refusals, each
// with its own positive control inside its own query. Every one of them has
// only ever been observed in the AFFIRMATIVE: the migration applies upward and
// the block stays silent. The package's seven mutants attack the migration's
// TEXT, not these claims, so no run has ever seen one of them speak.
//
// That is the defect class this lane keeps writing rules against, and the money
// review named it. So this section runs the real block against a catalogue
// mutated inside a transaction it rolls back, and watches the claim refuse.
//
// WHY THE BLOCK IS READ FROM THE FILE rather than re-stated here: a copy would
// drift from the migration and then prove something about the copy. The block
// is extracted between its own `$post$` delimiters, and that extraction is
// asserted to have found the real thing before anything is run (RULE-27).
// ─────────────────────────────────────────────────────────────────────────────
describe('§E the end-state block refuses, and is seen doing it', () => {
  const MIGRATION_PATH = join(__dirname, '../../infrastructure/database/migrations/0092_p4s1_customer_account_statement_reader.sql');

  /** The real `DO $post$ … $post$;` block, taken from the migration this card ships. */
  function endStateBlock(): string {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    const start = sql.indexOf('DO $post$');
    const end = sql.indexOf('$post$;', start + 'DO $post$'.length);
    expect(start, 'the end-state block must be found in the migration, or this section tests a copy').toBeGreaterThan(-1);
    expect(end, 'the block must be terminated, or the extraction is truncated').toBeGreaterThan(start);
    const block = `${sql.slice(start, end)}$post$;`;
    // THE EXTRACTION IS PROVED BEFORE IT IS RUN: it must carry the refusals
    // this section is about, and more than one of them.
    const refusals = block.match(/selling\.migration_end_state_invalid/g) ?? [];
    expect(refusals.length, `the extracted block must carry the named refusals; it carried ${refusals.length}`).toBeGreaterThanOrEqual(8);
    return block;
  }

  it('the real block is SILENT on the real catalogue — the positive control for every arm below', async () => {
    const c = await ownerPool().connect();
    try {
      await c.query('BEGIN');
      await c.query(endStateBlock());
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  }, 300_000);

  it('RED: with EXECUTE revoked from daftar_app, the reachability claim refuses by name', async () => {
    const c = await ownerPool().connect();
    let message = '';
    try {
      await c.query('BEGIN');
      await c.query(`REVOKE EXECUTE ON FUNCTION customer_account_statement(uuid, uuid) FROM daftar_app`);
      // THE PLANT REACHED THE CATALOGUE, asserted before its result is read.
      const seen = await c.query<{ ok: boolean }>(`SELECT has_function_privilege('daftar_app', 'customer_account_statement(uuid,uuid)', 'EXECUTE') AS ok`);
      expect(seen.rows[0]?.ok, 'the revoke must really have landed, or the refusal below proves nothing').toBe(false);
      try {
        await c.query(endStateBlock());
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
    expect(message, `the block must refuse, and by this claim: ${message}`).toContain('not reachable by daftar_app alone');
  }, 300_000);

  it('and the rollback took the plant with it: the grant is back', async () => {
    const r = await ownerPool().query<{ ok: boolean }>(`SELECT has_function_privilege('daftar_app', 'customer_account_statement(uuid,uuid)', 'EXECUTE') AS ok`);
    expect(r.rows[0]?.ok, 'daftar_app holds EXECUTE again, so the committed catalogue is unchanged').toBe(true);
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// §F — THE TWO BRANCHES NOTHING HAD EVER EXECUTED.
//
// `0092` has five branches. Every case above exercises three of them: the
// invoice, the payment row and the allocation. Branch 4 (`credit`, kind_rank 4)
// and branch 5 (`credit_application`, kind_rank 5) had never produced a single
// row in any executed case, and the independent review on `55e6c134` named
// that as blocking. It is right, and the reason it is blocking rather than
// cosmetic is branch 5: it MOVES THE BALANCE, and `customer_ar_outstanding`
// counts `customer_credit_applications` inside its `paid` sum (`0084:636-639`).
// So a wrong join, a wrong currency or a wrong sign there breaks the closing
// law IN PRODUCTION while §A stays green on a fixture that has no credit in
// it. Ten green jobs attested nothing about two fifths of this reader.
//
// The shape is the estate's own measured precedent, not an invention:
// `tests/golden-regression/phase4-s4/12-overpayment-customer-credit.golden.test.ts`
// overpays with an explicit `creditId`, reads the credit's pair back off the
// stored row with `creditSnapshot` (never assuming it), sells a LATER invoice,
// and consumes part of the credit onto it.
// ─────────────────────────────────────────────────────────────────────────────
describe('§F the credit and its application — the branches that move the balance without a payment', () => {
  let creditCustomer = '';
  let creditRows: readonly StatementRow[] = [];
  let creditOutstanding: readonly OutstandingRow[] = [];

  beforeAll(async () => {
    creditCustomer = await newCustomer(A);
    const invoiceA = await sellOnCredit(A, creditCustomer, '2');
    const totalA = BigInt(invoiceA.totalTxnMinor);
    const surplus = 500n;
    const creditId = randomUUID();

    // THE OVERPAYMENT that gives the credit its birth, and the surplus is the
    // credit's original amount.
    const born = await collectPayment(A.t, A.headers, {
      paymentId: randomUUID(),
      customerId: creditCustomer,
      paymentMethodId: A.paymentMethodId,
      paymentDate: A.day,
      amountMinor: (totalA + surplus).toString(),
      creditId,
      allocations: [
        {
          invoiceId: invoiceA.invoiceId,
          appliedMinor: invoiceA.totalTxnMinor,
          releasedBeforeMinor: '0',
          invoiceTotalTxnMinor: invoiceA.totalTxnMinor,
          invoiceTotalBaseMinor: invoiceA.totalBaseMinor,
        },
      ],
    });
    expect(born.status, `the overpayment is accepted: ${JSON.stringify(born.body)}`).toBeLessThan(300);

    // THE CREDIT'S OWN FIGURES, READ BACK off the stored row. A number retyped
    // here would be a second copy of the arithmetic, and the application's
    // chain position is the credit's to state.
    const snapshot = await creditSnapshot(ownerPool(), A.shop.businessId, creditId);
    const remainingBefore = BigInt(snapshot.remainingAmountMinor);
    expect(remainingBefore, 'NO SUBJECT — the credit was born with nothing in it, so there is nothing to apply').toBeGreaterThan(0n);

    // A LATER invoice, and part of the credit onto it.
    const invoiceB = await sellOnCredit(A, creditCustomer, '6');
    const consumed = remainingBefore < BigInt(invoiceB.totalTxnMinor) ? remainingBefore : BigInt(invoiceB.totalTxnMinor);
    expect(consumed, 'NO SUBJECT — nothing can be consumed onto the later invoice').toBeGreaterThan(0n);
    const applied = await applyCredit(A.t, A.headers, {
      applicationId: randomUUID(),
      creditId,
      customerId: creditCustomer,
      invoiceId: invoiceB.invoiceId,
      applicationDate: A.day,
      consumedMinor: consumed.toString(),
      remainingBeforeMinor: snapshot.remainingAmountMinor,
      creditOriginalMinor: snapshot.originalAmountMinor,
      creditOriginalCarryingMinor: snapshot.originalCarryingBaseAmountMinor,
      creditToBaseRateR10: rateToR10(snapshot.creditToBaseRate),
      leg: {
        invoiceId: invoiceB.invoiceId,
        appliedMinor: consumed.toString(),
        paymentAmountMinor: consumed.toString(),
        releasedBeforeMinor: '0',
        invoiceTotalTxnMinor: invoiceB.totalTxnMinor,
        invoiceTotalBaseMinor: invoiceB.totalBaseMinor,
        invoiceToBaseRateR10: rateToR10(invoiceB.sourceToBaseRate),
        paymentToBaseRateR10: rateToR10(snapshot.creditToBaseRate),
      },
    });
    expect(applied.status, `the credit application is accepted: ${JSON.stringify(applied.body)}`).toBeLessThan(300);

    creditRows = await asApp<StatementRow>(app, A.shop, SELECT_STATEMENT, [A.shop.businessId, creditCustomer]);
    creditOutstanding = await asApp<OutstandingRow>(
      app,
      A.shop,
      `SELECT r.currency_code, r.txn_minor::text AS txn_minor FROM customer_ar_outstanding($1::uuid, $2::uuid) r`,
      [A.shop.businessId, creditCustomer],
    );
  }, 900_000);

  it('BOTH branches produced rows — the non-vacuity this section exists for', () => {
    const ranks = new Set(creditRows.map((r) => r.kind_rank));
    expect(ranks.has(4), `branch 4 (the credit) produced no row; ranks seen: ${[...ranks].sort().join(',')}`).toBe(true);
    expect(ranks.has(5), `branch 5 (the credit application) produced no row; ranks seen: ${[...ranks].sort().join(',')}`).toBe(true);
    // And all five are now exercised in one statement, which is the claim the
    // suite could not make before.
    expect(
      [...ranks].sort((x, y) => x - y),
      'every branch of the reader is exercised here',
    ).toStrictEqual([1, 2, 3, 4, 5]);
  });

  it('the credit row itself moves the balance by nothing, and the APPLICATION moves it', () => {
    const credit = creditRows.find((r) => r.kind_rank === 4);
    const application = creditRows.find((r) => r.kind_rank === 5);
    const c = must(credit, 'the credit row');
    const a = must(application, 'the credit application row');
    // The credit is a fact on the statement, not a movement of the receivable:
    // both sides are absent, exactly as the payment row is.
    expect(c.debit_txn_minor, 'the credit row debits nothing').toBeNull();
    expect(c.credit_txn_minor, 'the credit row credits nothing').toBeNull();
    // The application is the movement, and it is a CREDIT of the applied
    // amount — the same side an allocation takes, because it settles the same
    // receivable.
    expect(a.debit_txn_minor, 'the application debits nothing').toBeNull();
    expect(BigInt(must(a.credit_txn_minor, 'the application credits the applied amount')), 'and it credits a positive figure').toBeGreaterThan(0n);
  });

  it('and the closing law still holds WITH the credit branches in play, in both directions', () => {
    const last = new Map<string, string>();
    for (const r of creditRows) last.set(r.currency_code, r.running_balance_txn_minor);
    expect(last.size, 'NO SUBJECT — the statement returned no row for this customer').toBeGreaterThan(0);
    const reported = new Set(creditOutstanding.map((o) => o.currency_code));
    for (const o of creditOutstanding)
      expect(
        last.get(o.currency_code),
        `${o.currency_code}: the statement closes at ${String(last.get(o.currency_code))} and the reader of record states ${o.txn_minor}`,
      ).toBe(o.txn_minor);
    for (const [currency, closing] of last)
      if (!reported.has(currency)) expect(closing, `${currency}: the reader of record omits it, so the statement must close it at exactly 0`).toBe('0');
  });

  it('and the SQL window still agrees with an independent BigInt fold on every row', () => {
    expect(creditRows.map((r) => r.running_balance_txn_minor)).toEqual(foldRunning(creditRows));
  });
});
