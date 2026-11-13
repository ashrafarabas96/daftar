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

/**
 * The customer write route, once the lane that owns deferred selling mounts
 * it. `path` is `null` for the same reason `STATEMENT_PATH` is: it is the
 * measured state of this base, not a placeholder to be tidied away.
 *
 * The rest is the contract that lane reported to this one — `POST
 * /v1/customers`, permission `customers.manage`, a strict body of
 * `{ customerId, name, phone?, email?, notes? }` where `customerId` is the
 * CALLER's document UUID and therefore the idempotency key, answering `201`
 * on the first send and `200` with `replayed` on a replay. It is recorded
 * here so the day the route lands this file changes in one place, and it is
 * recorded as REPORTED: I have not measured it, because it does not exist on
 * this base to measure (RULE-2).
 */
const CUSTOMER_CREATE: { readonly path: string | null; readonly permission: string } = { path: null, permission: 'customers.manage' };

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

/**
 * One row of a customer statement.
 *
 * The field names of the real row are `debit_txn_minor`, `credit_txn_minor`,
 * `currency_code` and `running_balance_txn_minor`, in minor units as `BIGINT`,
 * with the debt the customer owes POSITIVE — reported to this lane by the lane
 * that owns `0092`, and therefore NOT measured by me (RULE-2): the mapping from
 * that row to this shape is the second thing that changes the day the route
 * lands, and the laws below do not move when it does.
 */
interface StatementRow {
  readonly what: string;
  /** The window is partitioned by currency, so a row carries the one it belongs to. */
  readonly currency: string;
  readonly debitMinor: bigint;
  readonly creditMinor: bigint;
  /** The balance AFTER this row, as the statement itself prints it. */
  readonly runningMinor: bigint;
}

/**
 * Every way a statement contradicts itself, as prose. Five laws, and the fifth
 * is deliberately redundant with the fourth:
 *
 *   1. a row moves in ONE direction, and neither side is negative;
 *   2. every row of one window carries the SAME currency;
 *   3. the running balance is a recurrence from the opening balance;
 *   4. the closing balance is the last row's running balance;
 *   5. the closing balance is also the opening balance plus the movements.
 *
 * Law 5 restates law 4 by a different path ON PURPOSE. A generator that
 * computes the closing figure from its own query rather than from the rows it
 * printed satisfies one of them and not the other, and that is precisely the
 * statement a merchant cannot reconcile.
 *
 * A SIDELESS ROW IS LAWFUL, AND SAYING OTHERWISE WAS A FALSE RED THIS CHECKER
 * CARRIED UNTIL NOW. An earlier draft reported "a row that moves nothing is
 * not a row", which would have reddened a CORRECT statement: the lane that
 * owns `0092` reports that a collection received and a held credit balance are
 * rows with NO side at all, and that this is a fact rather than an error,
 * because unapplied money must not be counted twice and a credit does not net
 * off a debt (DR-114). That claim is theirs and not my measurement (RULE-2),
 * and it is exactly the kind of claim worth taking before CI rather than after
 * it. The law such a row still owes is law 3, which it meets by leaving the
 * running balance where it was — so no law was dropped to make room for it.
 *
 * Law 2 exists because the window is partitioned by currency: a sum taken
 * across two currencies is a number with no unit, and a running balance that
 * carried one would be the one figure on the page a merchant could not
 * reconcile with anything.
 */
function statementOffencesIn(openingMinor: bigint, rows: readonly StatementRow[], closingMinor: bigint): string[] {
  const offences: string[] = [];
  const currencies = [...new Set(rows.map((r) => r.currency))];
  if (currencies.length > 1) offences.push(`the window mixes ${currencies.join(' and ')}, so its running balance is a sum with no unit`);
  let running = openingMinor;
  for (const row of rows) {
    if (row.debitMinor < 0n || row.creditMinor < 0n)
      offences.push(`${row.what}: a statement row carries no negative side (${row.debitMinor}/${row.creditMinor})`);
    if (row.debitMinor !== 0n && row.creditMinor !== 0n)
      offences.push(`${row.what}: a row moves in one direction, not both (${row.debitMinor}/${row.creditMinor})`);
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
/** The status of each collection the first time it was sent. */
const firstSendStatuses: number[] = [];
/** The status and the `replayed` flag of the second collection sent AGAIN, byte for byte. */
let replayStatus: number | null = null;
let replayFlag: unknown = undefined;
/** Arm A: what the server answered a collection of nothing. */
let zeroCollectionStatus: number | null = null;
/** Arm B, on a customer of its own: the whole debt, the surplus over it, and what came back. */
let otherOutstandingMinor: bigint | null = null;
let surplusMinor: bigint | null = null;
let overpaidStatus: number | null = null;
let overpaidBody = '';
let overpaidReadStatus: number | null = null;
let otherBalanceMinor: bigint | null = null;
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
  // The input of each leg is built ONCE and kept, because the replay below has
  // to be the SAME command and not a second command that looks like it: the
  // collection is idempotent on the caller-supplied document UUID plus the
  // stored intent digest, so a replay that minted a fresh id would be a new
  // payment and would prove nothing about replay at all.
  const inputs = legs.map((leg) => ({
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
  }));
  for (const [i, input] of inputs.entries()) {
    const collected = await collectPayment(w.t, w.headers, input);
    if (collected.status >= 300) {
      refusedAt = `step 3 — collection ${i + 1} of ${inputs.length} was refused with ${collected.status}: ${JSON.stringify(collected.body)}`;
      return;
    }
    firstSendStatuses.push(collected.status);
  }

  step = 'step 3b — the SAME second collection again, byte for byte';
  // The merchant's till loses its connection and the cashier presses collect
  // twice. If the second request is taken as new money, the customer is shown
  // a debt smaller than it is, and the statement balances perfectly around a
  // payment that never arrived. So the replay is driven, and what it must NOT
  // do is the law: it must not move the balance read in step 4.
  const lastInput = inputs.at(-1);
  if (lastInput === undefined) {
    refusedAt = 'step 3b — no collection was built, so there is nothing to replay';
    return;
  }
  const replay = await collectPayment(w.t, w.headers, lastInput);
  if (replay.status >= 300) {
    refusedAt = `step 3b — the replay was refused with ${replay.status}: ${JSON.stringify(replay.body)}`;
    return;
  }
  replayStatus = replay.status;
  replayFlag = (replay.body as { replayed?: unknown }).replayed;

  step = LAST_STEP;
  const read = await w.t.request.get(`/v1/customers/${customerId}/receivable`).set(w.headers).send();
  if (read.status >= 300) {
    refusedAt = `step 4 — the receivable read was refused with ${read.status}: ${JSON.stringify(read.body)}`;
    return;
  }
  observedBalanceMinor = BigInt((read.body as { baseMinor: string }).baseMinor);

  // ── the two arms, driven AFTER the flow's own figure is read ─────────────
  // Nothing below may disturb the flow above: the zero collection is refused
  // and writes nothing, and the surplus arm uses a SECOND customer with its
  // own invoice. An arm that moved the first customer's balance would make
  // every law above a law about a different flow.

  step = 'arm A — a collection of nothing';
  const zero = await collectPayment(w.t, w.headers, {
    paymentId: randomUUID(),
    customerId,
    paymentMethodId: w.paymentMethodId,
    paymentDate: w.day,
    amountMinor: '0',
    // `[]` is lawful and is a payment on account, so the ONLY thing wrong with
    // this request is the figure. An arm that also broke the allocations would
    // be refused for the other reason and prove nothing about the figure.
    allocations: [],
  });
  zeroCollectionStatus = zero.status;

  step = 'arm B — a collection LARGER than the debt, on a customer of its own';
  const otherCustomerId = await newCustomer(w);
  const otherInvoice = await sellOnCredit(w, otherCustomerId, '2');
  otherOutstandingMinor = BigInt(otherInvoice.totalTxnMinor);
  surplusMinor = otherOutstandingMinor / 5n + 1n;
  const overpaid = await collectPayment(w.t, w.headers, {
    paymentId: randomUUID(),
    customerId: otherCustomerId,
    paymentMethodId: w.paymentMethodId,
    paymentDate: w.day,
    // The whole debt AND MORE. There is no credit limit in this estate by
    // architectural decision, so the surplus is not a refusal: it is money the
    // customer has paid and nobody owes yet.
    amountMinor: (otherOutstandingMinor + surplusMinor).toString(),
    // The surplus's own document id travels with the request, because the
    // command is idempotent on caller-supplied document UUIDs.
    creditId: randomUUID(),
    allocations: [
      {
        invoiceId: otherInvoice.invoiceId,
        appliedMinor: otherOutstandingMinor.toString(),
        releasedBeforeMinor: '0',
        invoiceTotalTxnMinor: otherInvoice.totalTxnMinor,
        invoiceTotalBaseMinor: otherInvoice.totalBaseMinor,
      },
    ],
  });
  overpaidStatus = overpaid.status;
  overpaidBody = JSON.stringify(overpaid.body);
  if (overpaid.status < 300) {
    const otherRead = await w.t.request.get(`/v1/customers/${otherCustomerId}/receivable`).set(w.headers).send();
    overpaidReadStatus = otherRead.status;
    if (otherRead.status < 300) otherBalanceMinor = BigInt((otherRead.body as { baseMinor: string }).baseMinor);
  }
}, 240_000);

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

/**
 * The statement this flow SHOULD produce, row by row, with the shape the lane
 * that owns `0092` reports: a collection received is a row with **no side**,
 * and the credit side carries the amount APPLIED to the document. So each
 * collection here is two rows, not one — the money arriving, which moves no
 * balance, and the application, which moves it.
 *
 * This builder is the expected statement, and it is what exercises the laws
 * until the route exists. The day it does, the route's own rows are mapped
 * here instead and every law above stays exactly as it is.
 */
function flowStatementRows(): readonly StatementRow[] {
  const sale = BigInt(invoice.totalTxnMinor);
  const ccy = invoiceCurrency;
  const afterFirst = sale - firstCollectionMinor;
  return [
    { what: 'the sale on account', currency: ccy, debitMinor: sale, creditMinor: 0n, runningMinor: sale },
    { what: 'the first collection, received', currency: ccy, debitMinor: 0n, creditMinor: 0n, runningMinor: sale },
    { what: 'the first collection, applied to the invoice', currency: ccy, debitMinor: 0n, creditMinor: firstCollectionMinor, runningMinor: afterFirst },
    { what: 'the second collection, received', currency: ccy, debitMinor: 0n, creditMinor: 0n, runningMinor: afterFirst },
    {
      what: 'the second collection, applied to the invoice',
      currency: ccy,
      debitMinor: 0n,
      creditMinor: secondCollectionMinor,
      runningMinor: sale - collectedMinor,
    },
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

  it('3b. A REPLAY IS NOT MONEY: the same collection sent twice is answered as a replay, and the balance does not move', () => {
    expect(refusedAt).toBeNull();
    // POSITIVE CONTROL ON THE REPLAY ITSELF. A `201` from the second send
    // would mean a second payment was created, and the balance law would then
    // be measuring a flow of three collections rather than a replay of two —
    // which is the failure this case exists to catch, read as a pass.
    expect(firstSendStatuses, 'the two collections were not both accepted as NEW payments').toStrictEqual([201, 201]);
    expect(replayStatus, 'the replay was answered as a new payment rather than as a replay').toBe(200);
    expect(replayFlag, 'the answer did not say it was a replay').toBe(true);
    // AND THE MONEY, which is what this case is actually for: the balance of
    // step 4 is read AFTER the replay, so the flow's own law already covers
    // it. Stated again here because a status code is not a figure.
    expect(receivableOffencesIn(flowMovements(), observedBalanceMinor), 'the replay moved the customer balance').toStrictEqual([]);
  });

  it('ARM A — a collection of NOTHING is refused', () => {
    expect(refusedAt).toBeNull();
    // POSITIVE CONTROL: the same route, with a figure, was accepted twice a
    // moment earlier — so a refusal here is about the figure and not about a
    // route that refuses everything. (That `allocations: []` is lawful on its
    // own — a payment on account — is this estate's contract as reported to
    // this lane, not something I measured.)
    expect(firstSendStatuses, 'the route refuses collections generally, so the refusal below says nothing').toStrictEqual([201, 201]);
    expect(zeroCollectionStatus, 'a collection of zero was accepted, and a payment of nothing is a row with no money in it').toBe(400);
  });

  it('ARM B — a SURPLUS is held, never netted: paying more than the debt leaves the receivable at zero and never below it', () => {
    expect(refusedAt).toBeNull();
    const outstanding = otherOutstandingMinor;
    const surplus = surplusMinor;
    expect(outstanding, 'arm B never ran').not.toBeNull();
    expect(surplus, 'arm B never ran').not.toBeNull();
    if (outstanding === null || surplus === null) return;
    // CORPUS CONTROL: both figures must be real, or "the balance is zero"
    // would be true of a customer who was never sold to and never paid.
    expect(outstanding > 0n, `the second invoice totals ${outstanding}`).toBe(true);
    expect(surplus > 0n, `the surplus is ${surplus}, so this arm would be an exact settlement and not an overpayment`).toBe(true);
    // There is no credit limit in this estate by architectural decision, so an
    // overpayment is not a refusal. If it is refused, the body says why and
    // that is a result worth reading rather than a test to be relaxed.
    expect(overpaidStatus, `the overpayment was refused: ${overpaidBody}`).toBeLessThan(300);
    expect(overpaidReadStatus, 'the second receivable could not be read').toBe(200);
    // THE LAW, AND ITS EXACT SCOPE. A credit does not net off a debt: the
    // surplus is money the customer has paid that nobody owes yet, so an
    // UNALLOCATED surplus moves the receivable no further than the
    // allocations do — here, to exactly zero. A server that netted it would
    // answer a NEGATIVE receivable, and the merchant would read "we owe the
    // customer" off a page that should say "nothing is outstanding, and there
    // is money on account".
    //
    // This is NOT a claim that the receivable can never go negative, and the
    // difference is measured rather than argued: the one definition of the
    // settlement sum computes `total_txn_minor - coalesce(paid_txn, 0)` with
    // NO `GREATEST(0, …)` (`0084`, the set-based `invoice_outstanding`), and
    // `customer_ar_outstanding` sums it with `HAVING sum <> 0`, so a negative
    // row survives the sum. The probe is sighted: the same expression DOES
    // carry an explicit floor for a document that is not open
    // (`CASE WHEN i.status <> 'open' THEN 0::BIGINT`), so the absence of the
    // other floor is a measurement and not a blind zero. A negative
    // receivable is reachable here through a credit document or an
    // over-application, and a law that reddened every negative balance would
    // be a false red about a lawful state.
    expect(otherBalanceMinor, `the receivable after an overpayment of ${surplus} over ${outstanding}`).toBe(0n);
    // AND THE SAME CLAIM THROUGH THE NAMED CHECKER, so the figure above is not
    // the only thing standing between a netted surplus and a green suite.
    const movements: readonly Movement[] = [
      { what: 'the second sale on account', signedMinor: outstanding },
      { what: 'the payment applied to it', signedMinor: -outstanding },
    ];
    expect(receivableOffencesIn(movements, 0n), 'the arm that settles exactly disagrees with its own movements').toStrictEqual([]);
    expect(receivableOffencesIn(movements, -surplus).length, `a receivable of ${-surplus} was read as correct, so a netted surplus would pass`).toBe(1);
  });

  it('OWED BY THE SELLING LANE — the customer is created through its own route once it is mounted', () => {
    // RED ON PURPOSE, like the statement case below. The route's contract is
    // recorded on `CUSTOMER_CREATE`, so the day the migration that carries it
    // merges, step 1 stops being a seeded fixture and becomes the merchant's
    // own command — with the replay law above applied to it unchanged: the
    // same `customerId` sent twice must answer `200`, say `replayed`, and
    // leave ONE customer.
    expect(
      CUSTOMER_CREATE.path,
      'the customer write route is not mounted on this base: the four customer.* operation codes it needs do not exist yet, and this suite seeds the customer rather than pretending the route is there',
    ).not.toBeNull();
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
    // FIVE rows, so the recurrence has a middle: a two-row statement cannot
    // distinguish "each row adds its own movement" from "the last row prints
    // the closing figure", and a middle row is the only place that can. Two of
    // the five carry NO side, which is the shape the real statement has.
    expect(rows.length, 'no middle row was stated, so the recurrence would pass on its endpoints').toBeGreaterThan(2);
    expect(
      rows.filter((r) => r.debitMinor === 0n && r.creditMinor === 0n).length,
      'no sideless row was stated, so the law that they are lawful would pass on nothing',
    ).toBe(2);
    expect(statementOffencesIn(0n, rows, sale - collectedMinor), 'a statement built from the flow that actually ran contradicts itself').toStrictEqual([]);
    // No false red on the empty statement of a customer who owes nothing.
    expect(statementOffencesIn(0n, [], 0n)).toStrictEqual([]);
    // AND NO FALSE RED ON A NEGATIVE RUNNING BALANCE, which is a LAWFUL state
    // and not an error: a credit document or an over-application can carry
    // the balance below zero, the settlement sum computes the difference with
    // no floor (`0084`'s set-based `invoice_outstanding`), and the sum over a
    // customer keeps a negative row (`HAVING sum <> 0`). A floor planted in a
    // statement alone would make the statement disagree with the reader of
    // record, which is a financial defect rather than a tidier page. So this
    // control is here to STOP a later edit from adding that floor: the law
    // rejects a negative SIDE on a row, never a negative balance.
    const ccy = invoiceCurrency;
    const wentNegative: readonly StatementRow[] = [
      { what: 'a sale on account', currency: ccy, debitMinor: 100n, creditMinor: 0n, runningMinor: 100n },
      { what: 'a credit document larger than the debt', currency: ccy, debitMinor: 0n, creditMinor: 250n, runningMinor: -150n },
    ];
    expect(statementOffencesIn(0n, wentNegative, -150n), 'a negative running balance was reported as an offence, and it is a lawful state').toStrictEqual([]);
    // The negative SIDE, by contrast, is still an offence — so the control
    // above did not buy its silence by making the checker blind.
    expect(
      statementOffencesIn(0n, [{ what: 'a row with a negative debit', currency: ccy, debitMinor: -100n, creditMinor: 0n, runningMinor: -100n }], -100n).some(
        (o) => o.includes('no negative side'),
      ),
    ).toBe(true);
  });

  it('NEGATIVE CONTROL — each of the five statement laws is seen to say no, and law 5 catches what law 4 cannot', () => {
    const sale = 1_500n;
    const paid = 400n;
    const CCY = 'ILS';
    const right: readonly StatementRow[] = [
      { what: 'the sale on account', currency: CCY, debitMinor: sale, creditMinor: 0n, runningMinor: sale },
      { what: 'the collection, received', currency: CCY, debitMinor: 0n, creditMinor: 0n, runningMinor: sale },
      { what: 'the collection, applied', currency: CCY, debitMinor: 0n, creditMinor: paid, runningMinor: sale - paid },
    ];
    expect(statementOffencesIn(0n, right, sale - paid), 'the planted RIGHT statement must be silent, or the reds below say nothing').toStrictEqual([]);

    // Law 1 — two directions in one row.
    const bothWays = [{ what: 'a row that moves both ways', currency: CCY, debitMinor: sale, creditMinor: paid, runningMinor: sale - paid }];
    expect(statementOffencesIn(0n, bothWays, sale - paid).some((o) => o.includes('one direction, not both'))).toBe(true);

    // Law 2 — one window, two currencies. The arithmetic of the rows is
    // internally consistent here, so every other law is satisfied and this is
    // the only one that can object.
    const mixed: readonly StatementRow[] = [
      { what: 'a sale in the base currency', currency: CCY, debitMinor: sale, creditMinor: 0n, runningMinor: sale },
      { what: 'a collection applied in another currency', currency: 'USD', debitMinor: 0n, creditMinor: paid, runningMinor: sale - paid },
    ];
    const mixedOffences = statementOffencesIn(0n, mixed, sale - paid);
    expect(mixedOffences.some((o) => o.includes('mixes'))).toBe(true);
    expect(mixedOffences.length, 'the mixed window broke more than the currency law, so this plant proves the wrong thing').toBe(1);

    // Law 3 — the recurrence is broken in the MIDDLE, where a closing-balance
    // check alone would still agree with the final row.
    const brokenMiddle: readonly StatementRow[] = [
      { what: 'the sale on account', currency: CCY, debitMinor: sale, creditMinor: 0n, runningMinor: sale + 1n },
      { what: 'the collection, applied', currency: CCY, debitMinor: 0n, creditMinor: paid, runningMinor: sale - paid },
    ];
    expect(statementOffencesIn(0n, brokenMiddle, sale - paid).some((o) => o.includes('the recurrence gives'))).toBe(true);

    // Law 3 again, on a SIDELESS row: it is lawful, but it owes the balance it
    // was given. A row that moves nothing and yet moves the running balance is
    // money appearing from nowhere, and this is the case that keeps "sideless
    // rows are lawful" from becoming "sideless rows are unchecked".
    const sidelessMoved: readonly StatementRow[] = [
      { what: 'the sale on account', currency: CCY, debitMinor: sale, creditMinor: 0n, runningMinor: sale },
      { what: 'a collection received that moved the balance anyway', currency: CCY, debitMinor: 0n, creditMinor: 0n, runningMinor: sale - paid },
    ];
    expect(statementOffencesIn(0n, sidelessMoved, sale - paid).some((o) => o.includes('the recurrence gives'))).toBe(true);

    // Law 4 — the closing figure disagrees with the rows that were printed.
    expect(statementOffencesIn(0n, right, sale - paid + 7n).some((o) => o.includes("the last row's running balance"))).toBe(true);

    // Law 5 — the customer OPENED the window owing something, and the page
    // was printed as though it opened at zero: every running balance, and the
    // closing figure with them, forgot the opening balance.
    //
    // Law 4 is SILENT here, and that silence is the whole point: the rows and
    // the closing figure agree with EACH OTHER. Only the second path to the
    // closing figure — the opening balance plus the movements — can see that
    // both of them are short by the same amount. The silence is asserted and
    // not described, because a law claimed to catch what another cannot is a
    // claim about the other one too.
    const openedOwing = 900n;
    const forgotOpening = statementOffencesIn(openedOwing, right, sale - paid);
    expect(
      forgotOpening.some((o) => o.includes('plus the movements is')),
      'law 5 did not see a dropped opening balance',
    ).toBe(true);
    expect(
      forgotOpening.some((o) => o.includes("the last row's running balance")),
      'law 4 spoke here, so this case does not show that law 5 catches anything law 4 cannot',
    ).toBe(false);
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
