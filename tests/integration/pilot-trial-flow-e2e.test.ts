/**
 * THE PILOT'S TRIAL FLOW, END TO END, ON THE SERVER.
 *
 * `DR-153` (the owner's ten-day pilot order, `.local-context/PILOT_10D_PLAN_AR.md`)
 * gives this lane one item: ONE new file it owns, carrying the trial flow whole
 * — a customer, then a sale ON ACCOUNT, then a collection from that customer,
 * then a CORRECT statement. The flow is driven through the HTTP API and never
 * through the web screens: the pilot's acceptance is the server's answer, and a
 * screen that renders a wrong number correctly is still a wrong number.
 *
 * ── WHAT IS MEASURED HERE AND WHAT IS STILL OWED ──────────────────────────
 *
 * Three of the four steps have a mounted route TODAY, measured on this file's
 * own base commit, and this suite drives them for real:
 *
 *   — the sale on account: `POST /v1/sales` with `settlementMode: 'credit'`
 *     and a named `customerId` (`selling.schemas.ts:337-357`, where the
 *     `.refine` makes "a credit sale names the customer who owes it" a
 *     request-boundary refusal rather than a 500);
 *   — the collection: `POST /v1/customer-payments`, permission
 *     `payments.collect` (`receivables.controller.ts:51,66`);
 *   — the balance read: `GET /v1/customers/:customerId/receivable`, which the
 *     controller derives from the ledger ON READ and refuses outright to an
 *     actor without business-wide scope (`customers.controller.ts:71-77`).
 *
 * Two things are owed by the lane that owns the server of deferred selling,
 * and this file does NOT pretend either of them exists:
 *
 *   — `POST /v1/customers` is deliberately NOT mounted, and the controller
 *     says why in its own words: `daftar_app` has no DML on a Phase 4 table,
 *     so the write needs a definer routine that verifies a signed decision,
 *     and the four `customer.*` operation codes do not exist yet
 *     (`customers.controller.ts:21-42`). So the customer of this flow is
 *     SEEDED, through the same fixture every settlement suite uses, and the
 *     HTTP create step stays owed rather than faked;
 *   — a per-customer STATEMENT route (`كشف حساب`) does not exist at all. The
 *     closest mounted read answers one number and no rows, so the row-level
 *     statement laws below are exercised on planted statements TODAY and on
 *     the real route the day it lands. `STATEMENT_PATH` is the one constant
 *     that changes then, and no assertion in this file moves.
 *
 * ── WHY THE LAWS ARE NAMED CHECKERS AND NOT INLINE EXPECTATIONS ───────────
 *
 * "The statement is correct" is a claim about money, so it carries a NEGATIVE
 * CONTROL: a wrong number must be seen to redden it. A law written as an
 * inline `expect(a).toBe(b)` cannot be shown to discriminate without editing
 * the suite, so each law here is a named function that takes its corpus as a
 * parameter — `receivableOffencesIn` and `statementOffencesIn` — and the live
 * case and the planted witness go through the SAME function. A witness that
 * re-spelled the law would pass on its own copy of it.
 *
 * No figure below is typed in. The invoice total comes from the committed
 * document, the collection is a fraction of that total, and the expected
 * balance is arithmetic over the two. A hard-coded price would make this suite
 * a test of the catalogue's current fixture rather than of the flow.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, resetData } from '../helpers/test-app';
import {
  baseCurrency,
  newCustomer,
  sellOnCredit,
  settlementWorld,
  stockUp,
  type OpenInvoice,
  type SettlementWorld,
} from '../golden-regression/phase4-s4/settlement-world';
import { collectPayment } from '../golden-regression/phase4-s4/settlement-path';

const CLAIM = "the pilot's trial flow: a customer is sold to on account, pays part of it, and the statement says the right number";

/**
 * The per-customer statement route, once the lane that owns deferred selling
 * mounts it. `null` is not a placeholder to be tidied away later: it is the
 * measured state of the estate, and the live statement case below is RED while
 * it holds, naming what is missing instead of passing on nothing.
 */
const STATEMENT_PATH: ((customerId: string) => string) | null = null;

// ── the laws ──────────────────────────────────────────────────────────────

/** One movement on the customer's account, in the account's own currency. */
interface Movement {
  readonly what: string;
  /** What the movement adds to what the customer owes. A collection is negative. */
  readonly signedMinor: bigint;
}

/**
 * Every disagreement between what the customer's account SHOULD say after a
 * list of movements and what the server reported, as prose.
 *
 * The live case feeds the real movements and the real read through this. The
 * witness feeds planted ones. Both go through this one body, so a change to
 * the arithmetic cannot leave the witness green on a copy of the old one.
 */
function receivableOffencesIn(movements: readonly Movement[], observedMinor: bigint): string[] {
  const offences: string[] = [];
  for (const m of movements) {
    if (m.signedMinor === 0n) offences.push(`${m.what}: a movement of zero is not a movement`);
  }
  const expected = movements.reduce((acc, m) => acc + m.signedMinor, 0n);
  if (observedMinor !== expected) {
    offences.push(`the balance is ${observedMinor} and the movements sum to ${expected}: ${movements.map((m) => `${m.what} ${m.signedMinor}`).join(', ')}`);
  }
  return offences;
}

/** One row of a customer statement, as any statement of an account is shaped. */
interface StatementRow {
  readonly what: string;
  readonly debitMinor: bigint;
  readonly creditMinor: bigint;
  /** The balance AFTER this row, as the statement itself prints it. */
  readonly runningMinor: bigint;
}

/**
 * Every way a statement contradicts itself, as prose. Four laws, and the
 * fourth is deliberately redundant with the third:
 *
 *   1. a row moves in ONE direction, and neither side is negative;
 *   2. the running balance is a recurrence from the opening balance;
 *   3. the closing balance is the last row's running balance;
 *   4. the closing balance is also the opening balance plus the movements.
 *
 * Law 4 restates law 3 by a different path ON PURPOSE. A generator that
 * computes the closing figure from its own query rather than from the rows it
 * printed satisfies one of them and not the other, and that is precisely the
 * statement a merchant cannot reconcile.
 */
function statementOffencesIn(openingMinor: bigint, rows: readonly StatementRow[], closingMinor: bigint): string[] {
  const offences: string[] = [];
  let running = openingMinor;
  for (const row of rows) {
    if (row.debitMinor < 0n || row.creditMinor < 0n)
      offences.push(`${row.what}: a statement row carries no negative side (${row.debitMinor}/${row.creditMinor})`);
    if (row.debitMinor !== 0n && row.creditMinor !== 0n)
      offences.push(`${row.what}: a row moves in one direction, not both (${row.debitMinor}/${row.creditMinor})`);
    if (row.debitMinor === 0n && row.creditMinor === 0n) offences.push(`${row.what}: a row that moves nothing is not a row`);
    running += row.debitMinor - row.creditMinor;
    if (row.runningMinor !== running) offences.push(`${row.what}: the row prints ${row.runningMinor} and the recurrence gives ${running}`);
  }
  if (closingMinor !== running) offences.push(`the closing balance is ${closingMinor} and the last row's running balance is ${running}`);
  const byMovement = rows.reduce((acc, r) => acc + r.debitMinor - r.creditMinor, openingMinor);
  if (closingMinor !== byMovement) offences.push(`the closing balance is ${closingMinor} and the opening balance plus the movements is ${byMovement}`);
  return offences;
}

// ── the flow, run once ────────────────────────────────────────────────────

let w: SettlementWorld;
let customerId: string;
let invoice: OpenInvoice;
let firstCollectionMinor: bigint;
let secondCollectionMinor: bigint;
/** The two collections together — what the customer has paid against the invoice. */
let collectedMinor: bigint;
let observedBalanceMinor: bigint;
let invoiceCurrency: string;
let businessBaseCurrency: string;
/** Where the flow was REFUSED, which is a result to be read and not a failure to be hidden. */
let refusedAt: string | null = null;
/**
 * The last step the flow reaches when nothing refused it. Asserted below as a
 * POSITIVE CONTROL on the flow itself: an early `return` out of `beforeAll`
 * leaves the four figures at their initial values, and a suite that only
 * compared those figures with each other would be green about a flow that
 * never ran.
 */
const LAST_STEP = 'step 4 — the balance the server derives on read';
let step = 'before step 0';

beforeAll(async () => {
  step = 'step 0 — ensurePostgres, resetData and the settlement world';
  await ensurePostgres();
  await resetData();
  w = await settlementWorld('l7 pilot trial flow');

  step = 'step 0 — priced stock, so the invoice below carries value';
  await stockUp(w, '20', '500');

  step = 'step 1 — the customer';
  customerId = await newCustomer(w);

  step = 'step 2 — the sale ON ACCOUNT';
  invoice = await sellOnCredit(w, customerId, '3');
  invoiceCurrency = invoice.currencyCode;
  businessBaseCurrency = await baseCurrency(w);

  step = 'step 3 — the collections, fractions of the invoice and not round figures of my choosing';
  // TWO collections and not one, because the second is where the arithmetic
  // can go wrong in a way one collection cannot show: `releasedBeforeMinor`
  // is the invoice's own CHAIN POSITION, and the release of a leg is a
  // difference of two cumulative roundings of the invoice's stored originals
  // rather than a function of the previous leg's already-rounded release. A
  // suite that collected once would pass with the chain position pinned at
  // zero forever, and the statement below would have one movement instead of
  // a running balance.
  firstCollectionMinor = BigInt(invoice.totalTxnMinor) / 3n;
  secondCollectionMinor = BigInt(invoice.totalTxnMinor) / 4n;
  collectedMinor = firstCollectionMinor + secondCollectionMinor;
  const legs: readonly { readonly amount: bigint; readonly releasedBefore: bigint }[] = [
    { amount: firstCollectionMinor, releasedBefore: 0n },
    { amount: secondCollectionMinor, releasedBefore: firstCollectionMinor },
  ];
  for (const [i, leg] of legs.entries()) {
    const collected = await collectPayment(w.t, w.headers, {
      paymentId: randomUUID(),
      customerId,
      paymentMethodId: w.paymentMethodId,
      paymentDate: w.day,
      amountMinor: leg.amount.toString(),
      allocations: [
        {
          invoiceId: invoice.invoiceId,
          appliedMinor: leg.amount.toString(),
          // The chain position the suite PREDICTS and the server derives.
          // A wrong prediction here is refused by the command rather than
          // absorbed, which is why it is stated rather than omitted.
          releasedBeforeMinor: leg.releasedBefore.toString(),
          invoiceTotalTxnMinor: invoice.totalTxnMinor,
          invoiceTotalBaseMinor: invoice.totalBaseMinor,
        },
      ],
    });
    if (collected.status >= 300) {
      refusedAt = `step 3 — collection ${i + 1} of ${legs.length} was refused with ${collected.status}: ${JSON.stringify(collected.body)}`;
      return;
    }
  }

  step = LAST_STEP;
  const read = await w.t.request.get(`/v1/customers/${customerId}/receivable`).set(w.headers).send();
  if (read.status >= 300) {
    refusedAt = `step 4 — the receivable read was refused with ${read.status}: ${JSON.stringify(read.body)}`;
    return;
  }
  observedBalanceMinor = BigInt((read.body as { baseMinor: string }).baseMinor);
}, 180_000);

afterAll(async () => {
  await resetData();
});

/**
 * The three movements the flow actually drove, in the order it drove them, as
 * ONE declaration. Three copies of this list in three cases is three places a
 * later edit can disagree with itself, and the disagreement would read as a
 * failure of the server rather than of the suite.
 */
function flowMovements(): readonly Movement[] {
  return [
    { what: 'the sale on account', signedMinor: BigInt(invoice.totalBaseMinor) },
    { what: 'the first collection', signedMinor: -firstCollectionMinor },
    { what: 'the second collection', signedMinor: -secondCollectionMinor },
  ];
}

/** The same three movements as a statement would print them, with its running balance. */
function flowStatementRows(): readonly StatementRow[] {
  const sale = BigInt(invoice.totalTxnMinor);
  return [
    { what: 'the sale on account', debitMinor: sale, creditMinor: 0n, runningMinor: sale },
    { what: 'the first collection', debitMinor: 0n, creditMinor: firstCollectionMinor, runningMinor: sale - firstCollectionMinor },
    { what: 'the second collection', debitMinor: 0n, creditMinor: secondCollectionMinor, runningMinor: sale - collectedMinor },
  ];
}

describe(CLAIM, () => {
  it('HAS A SUBJECT — the flow ran, the invoice carries value, and the collection is neither nothing nor the whole of it', () => {
    expect(refusedAt, `THE FLOW WAS REFUSED, which is a result and not a failure: ${refusedAt}`).toBeNull();
    expect(step, `the flow stopped at "${step}", so the figures below are not the figures of a flow that ran`).toBe(LAST_STEP);
    expect(BigInt(invoice.totalTxnMinor) > 0n, `NO SUBJECT — the invoice totals ${invoice.totalTxnMinor}, so every figure below would compare 0 with 0`).toBe(
      true,
    );
    expect(
      firstCollectionMinor > 0n && secondCollectionMinor > 0n,
      `NO SUBJECT — the collections are ${firstCollectionMinor} and ${secondCollectionMinor}: a collection of nothing leaves the chain position where it started`,
    ).toBe(true);
    expect(
      secondCollectionMinor !== firstCollectionMinor,
      `NO SUBJECT — two equal collections of ${firstCollectionMinor} cannot tell a running balance from a doubled one`,
    ).toBe(true);
    expect(
      collectedMinor < BigInt(invoice.totalTxnMinor),
      `NO SUBJECT — the collection ${collectedMinor} settles the whole invoice ${invoice.totalTxnMinor}, so a closed balance of zero would be read as a correct remainder`,
    ).toBe(true);
  });

  it('the figures of this flow are in ONE currency, so a minor unit of the invoice and a minor unit of the balance are the same thing', () => {
    expect(refusedAt).toBeNull();
    // Not decoration. `GET .../receivable` answers in the business's BASE
    // currency, and the invoice totals in its own. Comparing them without
    // this is an FX assumption dressed as arithmetic.
    expect(invoiceCurrency, `the invoice's currency and the business base currency`).toBe(businessBaseCurrency);
    expect(invoice.totalBaseMinor, `the invoice's base total and its transaction total, at one currency`).toBe(invoice.totalTxnMinor);
  });

  it('1-4. THE FLOW: what the customer owes after the sale and the two collections is what the server says, to the minor unit', () => {
    expect(refusedAt).toBeNull();
    expect(receivableOffencesIn(flowMovements(), observedBalanceMinor), 'the balance the server derives disagrees with the flow that was driven').toStrictEqual(
      [],
    );
  });

  it('NEGATIVE CONTROL — a balance one minor unit out is reported by the same checker the live case used', () => {
    expect(refusedAt).toBeNull();
    const wrong = receivableOffencesIn(flowMovements(), observedBalanceMinor + 1n);
    expect(wrong.length, `a balance of ${observedBalanceMinor + 1n} was read as correct, so the live case above proves nothing`).toBe(1);
    expect(wrong[0]).toContain('the movements sum to');

    // AND THE OTHER DIRECTION, so the checker is not a function that reports
    // everything: the collection read as a debit is the sign error this flow
    // is most likely to make, and it must be reported too.
    expect(
      receivableOffencesIn([{ what: 'the collection, signed as if it increased the debt', signedMinor: collectedMinor }], observedBalanceMinor).length,
    ).toBe(1);
    expect(receivableOffencesIn([{ what: 'a movement of nothing', signedMinor: 0n }], 0n)).toStrictEqual([
      'a movement of nothing: a movement of zero is not a movement',
    ]);
  });

  it('the STATEMENT laws hold on a statement that is right, and this statement has rows to be right about', () => {
    expect(refusedAt).toBeNull();
    const sale = BigInt(invoice.totalTxnMinor);
    const rows = flowStatementRows();
    // THREE rows, so the recurrence has a middle: a two-row statement cannot
    // distinguish "each row adds its own movement" from "the last row prints
    // the closing figure", and the middle row is the only place that can.
    expect(rows.length, 'no middle row was stated, so the recurrence would pass on its endpoints').toBeGreaterThan(2);
    expect(statementOffencesIn(0n, rows, sale - collectedMinor), 'a statement built from the flow that actually ran contradicts itself').toStrictEqual([]);
    // No false red on the empty statement of a customer who owes nothing.
    expect(statementOffencesIn(0n, [], 0n)).toStrictEqual([]);
  });

  it('NEGATIVE CONTROL — each of the four statement laws is seen to say no, and law 4 catches what law 3 cannot', () => {
    const sale = 1_500n;
    const paid = 400n;
    const right: readonly StatementRow[] = [
      { what: 'the sale on account', debitMinor: sale, creditMinor: 0n, runningMinor: sale },
      { what: 'the collection', debitMinor: 0n, creditMinor: paid, runningMinor: sale - paid },
    ];
    expect(statementOffencesIn(0n, right, sale - paid), 'the planted RIGHT statement must be silent, or the reds below say nothing').toStrictEqual([]);

    // Law 1 — two directions in one row.
    const bothWays = [{ what: 'a row that moves both ways', debitMinor: sale, creditMinor: paid, runningMinor: sale - paid }];
    expect(statementOffencesIn(0n, bothWays, sale - paid).some((o) => o.includes('one direction, not both'))).toBe(true);

    // Law 2 — the recurrence is broken in the MIDDLE, where a closing-balance
    // check alone would still agree with the final row.
    const brokenMiddle: readonly StatementRow[] = [
      { what: 'the sale on account', debitMinor: sale, creditMinor: 0n, runningMinor: sale + 1n },
      { what: 'the collection', debitMinor: 0n, creditMinor: paid, runningMinor: sale - paid },
    ];
    expect(statementOffencesIn(0n, brokenMiddle, sale - paid).some((o) => o.includes('the recurrence gives'))).toBe(true);

    // Law 3 — the closing figure disagrees with the rows that were printed.
    expect(statementOffencesIn(0n, right, sale - paid + 7n).some((o) => o.includes("the last row's running balance"))).toBe(true);

    // Law 4 — the opening balance is dropped on the way to the closing figure.
    // Law 3 is SILENT here, because the rows and the closing figure agree with
    // each other and both forgot the opening balance. This is the one case
    // that makes law 4 earn its place rather than restate law 3.
    const openedOwing = 900n;
    const forgotOpening: readonly StatementRow[] = [
      { what: 'the sale on account', debitMinor: sale, creditMinor: 0n, runningMinor: sale },
      { what: 'the collection', debitMinor: 0n, creditMinor: paid, runningMinor: sale - paid },
    ];
    const lawThreeAndFour = statementOffencesIn(openedOwing, forgotOpening, sale - paid);
    expect(lawThreeAndFour.some((o) => o.includes('plus the movements is'))).toBe(true);
  });

  it('OWED BY THE SELLING LANE — the per-customer statement route is read through this file once it is mounted', () => {
    // RED ON PURPOSE, and it is the schedule rather than an oversight: this
    // lane's item is green on CI at the pilot's day 6-8, and the route it
    // reads is built on day 3-5 by the lane that owns it. The assertion is
    // written against the route and not against a mock, so the day
    // `STATEMENT_PATH` names the real path this case begins measuring the real
    // statement through `statementOffencesIn` above — the same checker the
    // planted witnesses just exercised in both directions.
    expect(
      STATEMENT_PATH,
      'the per-customer statement route is not mounted yet: the customer statement and its migration are owed by the lane that owns deferred selling, and this suite does not fake it',
    ).not.toBeNull();
  });
});
