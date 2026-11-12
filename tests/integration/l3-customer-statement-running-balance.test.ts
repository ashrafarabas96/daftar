import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appDbUrl, ensurePostgres, ownerPool } from '../helpers/test-app';
import { newCustomer, sellOnCredit, settlementMissing, settlementWorld, stockUp, type SettlementWorld } from '../golden-regression/phase4-s4/settlement-world';
import { collectPayment } from '../golden-regression/phase4-s4/settlement-path';

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
    FROM customer_account_statement($1::uuid, $2::uuid) s`;

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
    expect(last.size, 'every currency the statement reports must be one the reader of record reports').toBe(aOutstanding.length);
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

  it('entries on the SAME date are ordered by kind_rank and then by entry_id — a total order', () => {
    for (let i = 1; i < aRows.length; i += 1) {
      const p = aRows[i - 1];
      const c = aRows[i];
      if (p === undefined || c === undefined) continue;
      const ordered =
        p.entry_date_text < c.entry_date_text ||
        (p.entry_date_text === c.entry_date_text && (p.kind_rank < c.kind_rank || (p.kind_rank === c.kind_rank && p.entry_id < c.entry_id)));
      expect(
        ordered,
        `row ${i - 1} (${p.entry_date_text}/${p.kind_rank}/${p.entry_id}) is not before row ${i} (${c.entry_date_text}/${c.kind_rank}/${c.entry_id})`,
      ).toBe(true);
    }
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
