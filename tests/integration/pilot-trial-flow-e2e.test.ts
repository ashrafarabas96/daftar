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
 *   — a per-customer STATEMENT route (`كشف حساب`) is not on THIS base, and the
 *     scope of that is the whole claim: it is mounted on an open branch
 *     (`l3/customer-statement` @ `8eeb3303`, measured), but that PR is
 *     unmerged with changes requested and carries no running balance yet. The
 *     closest read this base does mount answers one number and no rows, so
 *     the row-level statement laws below are exercised on statements this
 *     suite derives TODAY and on the route's own rows the day it is reachable.
 *     `STATEMENT_PATH` is the one constant that changes then, and no assertion
 *     in this file moves.
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
 * The per-customer statement route, once it reaches a tree this suite can run
 * against. `null` is not a placeholder to be tidied away: it is the measured
 * state of THIS base, and the owed case below is RED while it holds, naming
 * what is missing instead of passing on nothing.
 *
 * "Not on this base" is the whole claim, and the scope matters: the route IS
 * mounted on an open branch — `GET /v1/customers/:customerId/account-statement`
 * (note `account-statement`, not `statement`), permission `receivables.view`,
 * at `customers.controller.ts:118` on `l3/customer-statement` @ `8eeb3303`,
 * measured by me there. That PR is unmerged and carries changes requested, so
 * a request written against it from here would be red for a reason that is
 * nobody's defect. What this suite waits for is the route on a tree it shares,
 * not the route's existence.
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
 * The real row's own names, MEASURED on the open branch that mounts the route
 * rather than taken from a spec: `currency` (not `currencyCode`),
 * `debitTxnMinor | null` and `creditTxnMinor | null`, with the debt the
 * customer owes POSITIVE. A `null` side is what a row carrying no side looks
 * like on the wire, and the mapper's first obligation is to read it as ZERO
 * rather than as a missing row.
 *
 * `runningMinor` has NO counterpart there yet, measured: that branch carries
 * zero occurrences of a running balance in `apps/api/src` or in the shared
 * contracts, and its own title says so — "no running balance, no migration".
 * The probe is sighted, since it finds `debitTxnMinor` in the same tree. So
 * the recurrence laws below run on statements this suite derives, and the day
 * the running balance lands they run on the route's own figure; the laws
 * themselves do not move either way.
 *
 * An earlier version of this comment named four `snake_case` columns and a
 * running balance. That was a spec reported to this lane and since withdrawn
 * by the lane that reported it, and I had repeated it without measuring —
 * which is exactly why it is measured here now.
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
 * Every way a statement contradicts itself, as prose. Five laws:
 *
 *   1. a row moves in ONE direction, and neither side is negative;
 *   2. every row of one window carries the SAME currency;
 *   3. each row's running balance follows the recurrence from the opening
 *      balance;
 *   4. the closing balance equals what the last row PRINTS;
 *   5. the closing balance equals the opening balance plus the movements.
 *
 * Laws 4 and 5 are two paths to the closing figure, and the difference
 * between them is the word PRINTS. A generator that computes its closing
 * figure from its own query rather than from the rows it printed satisfies one
 * and not the other, and that is precisely the statement a merchant cannot
 * reconcile.
 *
 * AN EARLIER VERSION OF LAW 4 COMPARED AGAINST THE RECURRENCE INSTEAD, AND CI
 * CAUGHT IT. A recurrence total IS `opening + movements`, so that version
 * compared the closing figure against the same number twice: law 5 was not
 * redundant-on-purpose, it was identical, and the case claiming "law 5 catches
 * what law 4 cannot" was FALSE — law 4 spoke in every plant law 5 did. Reading
 * the printed figure makes the two independent, and the case that asserts law
 * 4's silence is what proves it.
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
  // Law 4 reads the balance the page PRINTS on its last row — not the one the
  // recurrence just computed. That distinction is the whole of law 4's
  // independence, and getting it wrong is what made law 5 a duplicate: a
  // recurrence total IS `opening + movements`, so comparing the closing
  // figure against the recurrence and then against the movements compares it
  // twice against the same number. CI caught that claim being false.
  const printed = rows.length === 0 ? openingMinor : (rows[rows.length - 1]?.runningMinor ?? openingMinor);
  if (closingMinor !== printed) offences.push(`the closing balance is ${closingMinor} and the last row prints ${printed}`);
  if (closingMinor !== running) offences.push(`the closing balance is ${closingMinor} and the opening balance plus the movements is ${running}`);
  return offences;
}

/**
 * THE CLOSURE LAW — "the statement is correct" in the only shape that is not
 * a false red. Three parts, not a correspondence between two sets:
 *
 *   1. for every currency the receivable reports, the statement's last
 *      running balance in that currency equals it EXACTLY;
 *   2. for every currency in the statement that the receivable does NOT
 *      report, that last running balance is exactly zero — a positive half
 *      and not an exemption: a currency missing from the receivable whose
 *      statement does not close at zero means one of the two is lying;
 *   3. no currency the receivable reports is missing from the statement — a
 *      debt no document explains is a financial defect, not a detail.
 *
 * WHY NOT A CORRESPONDENCE. The two sides disagree about the ZEROED currency
 * ON PURPOSE: the AR function drops it (`HAVING sum(...) <> 0`, which is what
 * arm B measures below), and the statement keeps it, because a currency that
 * carries no debit still carries rows and closes at zero, and that is a fact
 * and not an error. So `byCurrency.size === currencies(items).size`, or any
 * other correspondence, would RED on a customer who paid one currency off in
 * full — a correct server and a lawful arm. That shape of false red has now
 * been caught four times in this flow, which is why the law is written as
 * three one-directional halves instead.
 *
 * The receivable half of this law is already mounted and is asserted live
 * below. Until the statement route exists, the statement half is this flow's
 * own arithmetic; the day it lands, the route's rows replace that one
 * argument and no part of this function moves.
 */
function closureOffencesIn(lastRunningByCurrency: ReadonlyMap<string, bigint>, byCurrency: ReadonlyMap<string, bigint>): string[] {
  const offences: string[] = [];
  for (const [ccy, owed] of byCurrency) {
    const last = lastRunningByCurrency.get(ccy);
    if (last === undefined) offences.push(`${ccy}: the customer owes ${owed} and the statement has no row in that currency to explain it`);
    else if (last !== owed) offences.push(`${ccy}: the statement closes at ${last} and the receivable says ${owed}`);
  }
  for (const [ccy, last] of lastRunningByCurrency) {
    if (!byCurrency.has(ccy) && last !== 0n) offences.push(`${ccy}: the receivable reports nothing outstanding and the statement closes at ${last}`);
  }
  return offences;
}

/**
 * A flat statement, grouped into one window per currency — the step the
 * statement's own shape makes necessary. Its rows arrive flat, each carrying
 * its own currency, while `statementOffencesIn` refuses a window that mixes
 * two: a mapper that fed the flat array in whole would red on a lawful
 * two-currency statement. This is that mapper's grouping, measured now rather
 * than written in a hurry the day the route lands.
 */
function windowsOf(rows: readonly StatementRow[]): ReadonlyMap<string, readonly StatementRow[]> {
  const windows = new Map<string, StatementRow[]>();
  for (const row of rows) {
    const window = windows.get(row.currency);
    if (window === undefined) windows.set(row.currency, [row]);
    else window.push(row);
  }
  return windows;
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
/**
 * The shape of the receivable answer this suite reads, with every money figure
 * a STRING — which is the estate's own rule and not a preference: a `BIGINT`
 * past 2^53 loses precision through `JSON.parse` without raising anything.
 */
interface ReceivableBody {
  readonly baseMinor: string;
  readonly byCurrency: readonly { readonly currency: string; readonly txnMinor: string }[];
}
/** The per-currency half of each receivable answer, kept for the laws below. */
let observedByCurrency: readonly { readonly currency: string; readonly txnMinor: string }[] = [];
let otherByCurrency: readonly { readonly currency: string; readonly txnMinor: string }[] | null = null;
/**
 * `day` shifted by whole days, as a civil date and nothing else.
 *
 * The arithmetic is done in UTC on purpose: a civil date minus a civil date
 * has no timezone, and reading the local clock here would make this suite
 * answer a different question either side of local midnight — the same reason
 * every date on these routes is supplied rather than defaulted.
 */
function civilDatePlusDays(day: string, days: number): string {
  const parts = day.split('-').map((p) => Number(p));
  const shifted = Date.UTC(parts[0] ?? 0, (parts[1] ?? 1) - 1, parts[2] ?? 1) + days * 86_400_000;
  return new Date(shifted).toISOString().slice(0, 10);
}

/** The fields this suite reads off one row of the open-invoices page. */
interface OpenInvoiceRow {
  readonly invoiceId: string;
  readonly currency: string;
  readonly totalTxnMinor: string;
  readonly outstandingTxnMinor: string;
  readonly settlementState: string;
  readonly isCredit: boolean;
  readonly hasExplicitDueDate: boolean;
  readonly dueDate: string | null;
  readonly daysPastDue: number;
  readonly ageDays: number;
}
/** Arm E: the sale that states a term, and what its page says about it. */
let termDueDate = '';
let termSaleStatus: number | null = null;
let termSaleBody = '';
let termOpenInvoices: readonly OpenInvoiceRow[] | null = null;
/** Arm F: the cross-customer allocation, and both balances read after it. */
let crossCustomerStatus: number | null = null;
let crossCustomerBody = '';
let payerBalanceAfterCross: bigint | null = null;
let targetBalanceAfterCross: bigint | null = null;
/** The flow customer's still-open documents, and arm B's customer's. */
let openInvoices: readonly OpenInvoiceRow[] = [];
let otherOpenInvoices: readonly OpenInvoiceRow[] | null = null;
/** Arm C: what the server answered a sale on account that names nobody. */
let creditWithNobodyStatus: number | null = null;
let creditWithNobodyBody = '';
/** Arm D: what the server answered a receivable read for a customer that does not exist. */
let unknownCustomerStatus: number | null = null;
let unknownCustomerBody = '';
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
 * The step the flow is in, kept so a refusal can say WHERE it happened.
 *
 * IT IS A TRACE AND NOT A CONTROL, and an earlier version of this suite got
 * that wrong: it asserted `step === LAST_STEP`, which CI reddened at once,
 * because the arms below run AFTER the balance is read and leave their own
 * label behind. The assertion was false by construction — the flow is
 * SUPPOSED to continue past that point — and it would have gone on being
 * false however correct the server was.
 *
 * The control the suite actually needs is `balanceWasRead`: an early `return`
 * out of `beforeAll` leaves every figure at its initial value, and a suite
 * comparing those figures with each other would be green about a flow that
 * never ran. A boolean set at the moment of the read says that and nothing
 * else.
 */
const LAST_STEP = 'step 4 — the balance the server derives on read';
let step = 'before step 0';
/** True once the receivable read landed — the positive control on the flow. */
let balanceWasRead = false;

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
  const readBody = read.body as ReceivableBody;
  observedBalanceMinor = BigInt(readBody.baseMinor);
  observedByCurrency = readBody.byCurrency;
  balanceWasRead = true;

  step = 'step 4b — the SAME money read a second way, per invoice';
  // A second INDEPENDENT read of the same debt, at the document level: this
  // page derives each figure through `invoice_outstanding(...)` and never from
  // a stored column, so it is not the customer total repeated — it is the
  // same money reached by another path. A balance that agreed with itself and
  // with nothing else would be a figure this suite could not cross-check at
  // all, and `asOf` is supplied rather than defaulted because a read whose
  // date the server resolved answers a different question either side of
  // local midnight.
  const openPage = await w.t.request.get(`/v1/customers/${customerId}/open-invoices?asOf=${w.day}`).set(w.headers).send();
  if (openPage.status >= 300) {
    refusedAt = `step 4b — the open-invoices read was refused with ${openPage.status}: ${JSON.stringify(openPage.body)}`;
    return;
  }
  openInvoices = (openPage.body as { items: readonly OpenInvoiceRow[] }).items;

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
    if (otherRead.status < 300) {
      const otherBody = otherRead.body as ReceivableBody;
      otherBalanceMinor = BigInt(otherBody.baseMinor);
      otherByCurrency = otherBody.byCurrency;
      const otherOpen = await w.t.request.get(`/v1/customers/${otherCustomerId}/open-invoices?asOf=${w.day}`).set(w.headers).send();
      if (otherOpen.status < 300) otherOpenInvoices = (otherOpen.body as { items: readonly OpenInvoiceRow[] }).items;
    }
  }
  step = 'arm C — a sale ON ACCOUNT that names nobody';
  // The body is built here in full rather than through the sale helper,
  // because the helper cannot express this request: given a null customer it
  // commits the WALK-IN arm, which is necessarily cash. The schema is
  // `.strict()`, so every field is present and only ONE of them is wrong —
  // otherwise the refusal could be about the shape instead of about the debt
  // nobody owes.
  const nobodyOwesIt = await w.t.request
    .post('/v1/sales')
    .set(w.headers)
    .send({
      saleId: randomUUID(),
      settlementMode: 'credit',
      customerId: null,
      warehouseId: w.shop.w1,
      documentDate: w.day,
      dueDate: null,
      taxMinor: '0',
      notes: null,
      lines: [{ lineId: randomUUID(), productId: w.shop.piece.productId, variantId: null, quantity: '1', discountMinor: '0' }],
    });
  creditWithNobodyStatus = nobodyOwesIt.status;
  creditWithNobodyBody = JSON.stringify(nobodyOwesIt.body);

  step = 'arm D — the receivable of a customer that does not exist';
  const unknownCustomer = await w.t.request.get(`/v1/customers/${randomUUID()}/receivable`).set(w.headers).send();
  unknownCustomerStatus = unknownCustomer.status;
  unknownCustomerBody = JSON.stringify(unknownCustomer.body);

  step = 'arm E — a sale on account WITH a stated term, on a customer of its own';
  // The flow's own sale names no due date, so it exercises only the arm where
  // the age is anchored on the issue date. A merchant who sells on credit
  // states a term, and that is the other arm — on a customer of its own, so
  // the flow's single open document stays single.
  const termCustomerId = await newCustomer(w);
  termDueDate = civilDatePlusDays(w.day, 7);
  const termSale = await w.t.request
    .post('/v1/sales')
    .set(w.headers)
    .send({
      saleId: randomUUID(),
      settlementMode: 'credit',
      customerId: termCustomerId,
      warehouseId: w.shop.w1,
      documentDate: w.day,
      dueDate: termDueDate,
      taxMinor: '0',
      notes: null,
      lines: [{ lineId: randomUUID(), productId: w.shop.piece.productId, variantId: null, quantity: '1', discountMinor: '0' }],
    });
  termSaleStatus = termSale.status;
  termSaleBody = JSON.stringify(termSale.body);
  if (termSale.status < 300) {
    const termPage = await w.t.request.get(`/v1/customers/${termCustomerId}/open-invoices?asOf=${w.day}`).set(w.headers).send();
    if (termPage.status < 300) termOpenInvoices = (termPage.body as { items: readonly OpenInvoiceRow[] }).items;
  }

  step = "arm F — money offered against ANOTHER customer's invoice";
  // The one misattribution that would ruin a statement without contradicting
  // it: the money is real, the invoice is real, and the two belong to
  // different people. The estate refuses it by name —
  // `invoice_settlement.customer_mismatch`, "a payment settles invoices of
  // its own customer only" (`0081:736`, `:1998`) — and this arm is what
  // proves that refusal reaches the merchant rather than living in a
  // migration comment.
  //
  // The allocation's expectation fields never travel: the request body
  // carries four keys per leg, so the invoice totals passed here cannot
  // influence what the server is asked.
  const targetInvoice = (termOpenInvoices ?? [])[0];
  if (targetInvoice !== undefined) {
    const cross = await collectPayment(w.t, w.headers, {
      paymentId: randomUUID(),
      customerId,
      paymentMethodId: w.paymentMethodId,
      paymentDate: w.day,
      amountMinor: '100',
      allocations: [
        {
          invoiceId: targetInvoice.invoiceId,
          appliedMinor: '100',
          releasedBeforeMinor: '0',
          invoiceTotalTxnMinor: targetInvoice.totalTxnMinor,
          invoiceTotalBaseMinor: targetInvoice.totalTxnMinor,
        },
      ],
    });
    crossCustomerStatus = cross.status;
    crossCustomerBody = JSON.stringify(cross.body);
    // Both balances re-read AFTER it, because the refusal's status code is
    // not the law — the law is that no money moved on either side.
    const payerAgain = await w.t.request.get(`/v1/customers/${customerId}/receivable`).set(w.headers).send();
    if (payerAgain.status < 300) payerBalanceAfterCross = BigInt((payerAgain.body as ReceivableBody).baseMinor);
    const targetAgain = await w.t.request.get(`/v1/customers/${termCustomerId}/receivable`).set(w.headers).send();
    if (targetAgain.status < 300) targetBalanceAfterCross = BigInt((targetAgain.body as ReceivableBody).baseMinor);
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
    expect(balanceWasRead, `the flow stopped at "${step}" before reading the balance, so the figures below are not the figures of a flow that ran`).toBe(true);
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

  it('1-4b. THE PER-CURRENCY FIGURE — the half of the statement closure law that is already mounted', () => {
    expect(refusedAt).toBeNull();
    // MEASURED ON THIS BASE, not taken on report. The receivable read answers
    // `byCurrency` straight out of the AR function — its SQL is
    // `SELECT r.currency_code, r.txn_minor::text … FROM customer_ar_outstanding($1,$2) r`
    // — so `byCurrency[].txnMinor` IS that function's `txn_minor` for the
    // currency. The statement's closure law (per currency, the last running
    // balance equals exactly that figure) therefore already has one of its
    // two reads mounted, and this case is that read: asserted now, so that
    // the day the statement lands the law is one comparison and not a new
    // investigation.
    expect(observedByCurrency.length, 'the per-currency half of the answer is empty while the customer still owes something').toBe(1);
    const only = observedByCurrency[0];
    expect(only?.currency, 'the per-currency figure is not in the invoice currency').toBe(invoiceCurrency);
    expect(only?.txnMinor, 'the per-currency figure disagrees with the sale minus the collections').toBe(
      (BigInt(invoice.totalTxnMinor) - collectedMinor).toString(),
    );
    // AND THE UNIT. A money figure crosses the wire as a decimal STRING: a
    // `number` past 2^53 loses precision through `JSON.parse` and raises
    // nothing, so the type is a law here and not a style.
    expect(typeof only?.txnMinor, 'a money figure arrived as something other than a string').toBe('string');

    // AND THE CLOSURE LAW ITSELF, with its receivable half LIVE and its
    // statement half still this flow's own arithmetic. The day the route
    // lands, the rows' last running balance replaces that one argument and
    // nothing else here moves.
    const live = new Map(observedByCurrency.map((e) => [e.currency, BigInt(e.txnMinor)]));
    expect(live.size, 'the live half of the closure law is empty, so it would close onto nothing').toBe(1);
    const predicted = new Map([[invoiceCurrency, BigInt(invoice.totalTxnMinor) - collectedMinor]]);
    expect(closureOffencesIn(predicted, live), 'the closure law fails between the flow and the receivable the server derives').toStrictEqual([]);
  });

  it('THE CLOSURE LAW — each of its three halves is seen to say no, and a correspondence would red on a lawful arm', () => {
    const A = 'ILS';
    const B = 'USD';
    const owed = new Map([[A, 700n]]);

    // The planted agreement must be silent, or every red below says nothing.
    expect(closureOffencesIn(new Map([[A, 700n]]), owed)).toStrictEqual([]);

    // Half 1 — the figures disagree.
    expect(closureOffencesIn(new Map([[A, 699n]]), owed).some((o) => o.includes('the statement closes at'))).toBe(true);

    // Half 2 — a currency the receivable does not report, whose statement
    // does NOT close at zero. One of the two sides is lying, and this is the
    // only half that can say so.
    const stray = closureOffencesIn(
      new Map([
        [A, 700n],
        [B, 40n],
      ]),
      owed,
    );
    expect(stray.some((o) => o.includes('reports nothing outstanding'))).toBe(true);
    expect(stray.length, 'the stray-currency plant broke more than the half it is for').toBe(1);

    // Half 3 — a debt the statement has no row to explain.
    expect(closureOffencesIn(new Map(), owed).some((o) => o.includes('no row in that currency'))).toBe(true);

    // AND THE OTHER DIRECTION, which is the whole reason the law is not a
    // correspondence: a currency PAID OFF IN FULL is absent from the
    // receivable and present in the statement, closing at zero. It is a
    // lawful arm, and it must be silent. A `byCurrency.size ===
    // currencies(items).size` would have reddened exactly here.
    expect(
      closureOffencesIn(
        new Map([
          [A, 700n],
          [B, 0n],
        ]),
        owed,
      ),
      'a currency paid off in full was read as an offence',
    ).toStrictEqual([]);
  });

  it('A FLAT STATEMENT IS GROUPED BEFORE IT IS JUDGED, or the currency law reds on a lawful page', () => {
    const A = 'ILS';
    const B = 'USD';
    const flat: readonly StatementRow[] = [
      { what: 'a sale in A', currency: A, debitMinor: 500n, creditMinor: 0n, runningMinor: 500n },
      { what: 'a sale in B', currency: B, debitMinor: 300n, creditMinor: 0n, runningMinor: 300n },
      { what: 'a collection applied in A', currency: A, debitMinor: 0n, creditMinor: 200n, runningMinor: 300n },
    ];
    // The grouping is real: two windows, and the A window keeps BOTH its rows
    // in the order they arrived — a grouping that dropped one would make
    // every recurrence below pass on a shorter page.
    const windows = windowsOf(flat);
    expect([...windows.keys()].sort(), 'the flat page did not group into one window per currency').toStrictEqual([A, B].sort());
    expect(windows.get(A)?.length, 'the A window lost a row').toBe(2);
    expect(windows.get(B)?.length, 'the B window lost a row').toBe(1);

    // Grouped, each window is lawful.
    expect(statementOffencesIn(0n, windows.get(A) ?? [], 300n), 'the A window contradicts itself').toStrictEqual([]);
    expect(statementOffencesIn(0n, windows.get(B) ?? [], 300n), 'the B window contradicts itself').toStrictEqual([]);

    // AND THE CONTROL THAT MAKES THE GROUPING NECESSARY: the same rows fed in
    // WHOLE are refused, because a window may not mix two currencies. So a
    // mapper that skipped this step would red on a lawful two-currency page.
    expect(
      statementOffencesIn(0n, flat, 300n).some((o) => o.includes('mixes')),
      'the ungrouped page was accepted, so the grouping above is not load-bearing',
    ).toBe(true);
  });

  it('1-4c. THE SAME MONEY, READ A SECOND WAY: the invoice itself says what is left on it', () => {
    expect(refusedAt).toBeNull();
    // Two independent reads of one debt. This page derives every figure
    // through `invoice_outstanding(...)` and never from a stored column, so
    // agreement here is agreement between two paths — not a number repeating
    // itself.
    expect(openInvoices.length, 'the customer owes something and no document explains it').toBe(1);
    const row = openInvoices[0];
    expect(row?.invoiceId, 'the open document is not the invoice this flow committed').toBe(invoice.invoiceId);
    expect(row?.currency).toBe(invoiceCurrency);
    expect(row?.totalTxnMinor, 'the document total moved after the collections, and a collection does not change a total').toBe(invoice.totalTxnMinor);
    expect(row?.outstandingTxnMinor, 'what is left on the invoice disagrees with the sale minus the collections').toBe(
      (BigInt(invoice.totalTxnMinor) - collectedMinor).toString(),
    );
    // AND IT AGREES WITH THE CUSTOMER TOTAL, which is the cross-check: one
    // invoice in one currency, so the two reads must land on the same figure.
    expect(row?.outstandingTxnMinor, 'the invoice and the customer total disagree about the same money').toBe(observedByCurrency[0]?.txnMinor);
    // The state is DERIVED and it is the state this flow produced: paid in
    // part, not unpaid and not settled. A suite that read `unpaid` here would
    // be reading a page that forgot both collections.
    expect(row?.settlementState, 'the settlement state is not what two partial collections produce').toBe('partial');
    // AND THE CREDIT FLAG IS FALSE: this row is debt. A page that marked a
    // part-paid invoice as a credit balance would show the merchant money it
    // does not have.
    expect(row?.isCredit, 'a part-paid invoice was marked as carrying credit').toBe(false);
    // And the sale named no due date, so the page says so in its own field
    // rather than through an age of zero.
    expect(row?.hasExplicitDueDate, 'the invoice reports a stated due date it never had').toBe(false);
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
    // other floor is a measurement and not a blind zero.
    //
    // Whether a negative balance can be REACHED is a different question from
    // whether the arithmetic has a floor, and today it cannot be: a credit
    // note is refused by `invoices_document_kind_ck` (`0075:250`) and an
    // over-application by `invoice_settlement.settlement_inconsistent`
    // (`0081:780-782`). So this zero is the only answer this arm can produce
    // — and the law stays written as "an unallocated surplus moves it no
    // further", not as "it is never negative", because the second one would
    // pass today and go false the day either door opens.
    expect(otherBalanceMinor, `the receivable after an overpayment of ${surplus} over ${outstanding}`).toBe(0n);
    // AND THE PER-CURRENCY HALF IS EMPTY HERE, which is a measured property
    // of the AR function rather than an oversight: it ends in
    // `HAVING sum <> 0`, so a customer who owes exactly nothing has NO row at
    // all instead of a row of zero. A suite that asserted one zero entry here
    // would be red about a correct server — and that is the same class of
    // false red as a floor on the balance.
    expect(otherByCurrency, 'arm B never read the second receivable').not.toBeNull();
    expect(otherByCurrency ?? [], 'a customer who owes exactly nothing still carries a per-currency row').toStrictEqual([]);
    // AND THIS IS THE CLOSURE LAW'S SECOND HALF, measured in the wild rather
    // than planted: the currency is absent from the receivable and its
    // statement closes at zero, so the law must be silent — while the same
    // currency closing at anything else would be an offence. This arm is the
    // live case that a correspondence between the two sides would have
    // reddened.
    expect(closureOffencesIn(new Map([[invoiceCurrency, 0n]]), new Map()), 'a settled currency was read as an offence').toStrictEqual([]);
    // AND THE DOCUMENT-LEVEL READ AGREES: a settled invoice is not an OPEN
    // invoice, so arm B's customer has no open document at all. This is the
    // second path saying the same thing as the zero above, and a page that
    // still listed the invoice would mean one of the two reads is wrong about
    // whether anything is outstanding.
    expect(otherOpenInvoices, 'arm B never read the second open-invoices page').not.toBeNull();
    expect(otherOpenInvoices ?? [], 'a fully settled invoice is still listed as open').toStrictEqual([]);
    expect(
      closureOffencesIn(new Map([[invoiceCurrency, 1n]]), new Map()).length,
      'a settled currency whose statement does not close at zero was accepted',
    ).toBe(1);
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
    // AND NO FALSE RED ON A NEGATIVE RUNNING BALANCE. This is a law about THE
    // CHECKER and not a claim about what the server can produce today, and
    // the difference is measured rather than assumed:
    //
    //   — a negative balance is NOT reachable on this tree. A credit note
    //     cannot exist, because `invoices.document_kind` carries
    //     `CONSTRAINT invoices_document_kind_ck CHECK (document_kind =
    //     'invoice')` (`0075:250`) and no later migration drops it; and an
    //     over-application is refused by name, because the settlement
    //     verifier raises `invoice_settlement.settlement_inconsistent` on
    //     `v_sum > v_i.total_txn_minor` (`0081:780-782`). Both measured here,
    //     on this branch's own base;
    //   — but the SETTLEMENT SUM itself has no floor (`0084`'s set-based
    //     `invoice_outstanding` computes the plain difference) and the sum
    //     over a customer keeps a negative row (`HAVING sum <> 0`), so the
    //     day a reducer or a document kind arrives, a negative balance is
    //     what the reader of record will answer.
    //
    // So the checker must not reject one — a floor in the statement alone
    // would make the statement disagree with the reader of record, which is a
    // financial defect and not a tidier page. And the law is deliberately NOT
    // written the other way round, as "the balance is never negative": that
    // one would pass today and become FALSE the day a migration drops the
    // constraint, which is how a test comes to explode a month later.
    //
    // The planted statement is a literal array handed straight to the
    // checker, so there is no corpus it could fail to match — but it is still
    // asserted to BE what it claims before its silence is read (RULE-27: a
    // plant that matched nothing reads as a successful control and is
    // nothing).
    const ccy = invoiceCurrency;
    const wentNegative: readonly StatementRow[] = [
      { what: 'a sale on account', currency: ccy, debitMinor: 100n, creditMinor: 0n, runningMinor: 100n },
      { what: 'a reducer larger than the debt, which this tree cannot yet produce', currency: ccy, debitMinor: 0n, creditMinor: 250n, runningMinor: -150n },
    ];
    expect(wentNegative.length, 'the planted statement is empty, so its silence would be silence about nothing').toBe(2);
    expect(wentNegative.at(-1)?.runningMinor, 'the planted statement does not actually go negative').toBe(-150n);
    expect(
      statementOffencesIn(0n, wentNegative, -150n),
      'a negative running balance was reported as an offence, and the checker may not reject one',
    ).toStrictEqual([]);
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
    expect(statementOffencesIn(0n, right, sale - paid + 7n).some((o) => o.includes('the last row prints'))).toBe(true);

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
      forgotOpening.some((o) => o.includes('the last row prints')),
      'law 4 spoke here, so this case does not show that law 5 catches anything law 4 cannot',
    ).toBe(false);
  });

  it('ARM C — a sale ON ACCOUNT that names nobody is refused, and that is what makes step 2 a credit sale', () => {
    expect(refusedAt).toBeNull();
    // THE POSITIVE CONTROL IS THE FLOW ITSELF: the same route, the same
    // warehouse, the same product, one field different — and step 2 committed.
    // So this refusal is about the debt nobody owes and not about a route
    // that refuses sales. It is also what makes step 2 a CREDIT sale rather
    // than a cash one that happened to name a customer: if the server did not
    // require the customer, `settlementMode: 'credit'` would be decoration.
    expect(invoice.saleId.length, 'step 2 did not commit, so this refusal is about nothing').toBeGreaterThan(0);
    expect(creditWithNobodyStatus, `a credit sale with no customer was accepted: ${creditWithNobodyBody}`).toBe(400);
    // And the refusal names the field, not just the request: a 400 that could
    // be about any of the nine fields is not a law about this one.
    expect(creditWithNobodyBody, 'the refusal does not name the customer').toContain('customerId');
  });

  it('ARM D — the receivable of a customer that does not exist is refused by name', () => {
    expect(refusedAt).toBeNull();
    // The read this flow's whole balance law rests on must distinguish "owes
    // nothing" from "is not there". A read that answered zero for an unknown
    // id would make every balance law in this file pass for a customer that
    // was never created.
    expect(unknownCustomerStatus, `an unknown customer was answered rather than refused: ${unknownCustomerBody}`).toBe(404);
    expect(unknownCustomerBody, 'the refusal does not carry the code').toContain('customer.not_found');
    // AND THE OTHER DIRECTION: the same route answered 200 for the customer
    // of this flow a moment earlier, so the 404 is about the id.
    expect(balanceWasRead, 'the same route never answered successfully, so the refusal says nothing').toBe(true);
  });

  it('ARM E — a stated TERM is reported as a term, and the two ages are not each other', () => {
    expect(refusedAt).toBeNull();
    expect(termSaleStatus, `the sale with a stated term was refused: ${termSaleBody}`).toBeLessThan(300);
    expect(termOpenInvoices, 'arm E never read its page').not.toBeNull();
    const rows = termOpenInvoices ?? [];
    expect(rows.length, 'the sale with a term left no open document').toBe(1);
    const row = rows[0];
    // The term is reported as a TERM, in its own field. The flow's own sale
    // names none, so without this arm the suite would only ever have seen the
    // `false` side of it.
    expect(row?.hasExplicitDueDate, 'a stated due date was not reported as one').toBe(true);
    expect(row?.dueDate, 'the due date came back as something other than the one stated').toBe(termDueDate);
    // AND THE TWO AGES ARE INDEPENDENT, which is the law this arm exists for.
    // `daysPastDue` is measured against the TERM and `ageDays` against the
    // document's own date, so a sale made today with a term a week out is
    // SEVEN DAYS from being late and ZERO days old. A page that derived
    // either from the other could not report both.
    expect(row?.daysPastDue, 'how late the debt is, against a term seven days out').toBe(-7);
    expect(row?.ageDays, 'how old the document is, against the day it was issued').toBe(0);
    expect(row?.daysPastDue === row?.ageDays, 'the two ages came back equal, so one of them is derived from the other').toBe(false);
    // AND A NEGATIVE AGE IS NOT A MISSING TERM. This is the pairing the page's
    // own contract calls the defect it closed: `hasExplicitDueDate` says
    // whether a term exists and NOTHING else says it, so a debt that is not
    // yet late must not read as a debt with no term.
    expect(row?.hasExplicitDueDate, 'a negative days-past-due was read as a missing term').toBe(true);
    // And it is debt, not credit: nothing has been collected against it.
    expect(row?.isCredit, 'an unpaid invoice with a term was marked as carrying credit').toBe(false);
    expect(row?.settlementState, 'an invoice nobody has paid against is not unpaid').toBe('unpaid');
  });

  it("ARM F — money offered against another customer's invoice is refused, and NO balance moves", () => {
    expect(refusedAt).toBeNull();
    // CORPUS CONTROL: the arm needs a real invoice belonging to someone else.
    expect(termOpenInvoices?.length, "arm F had no other customer's invoice to aim at").toBe(1);
    expect(crossCustomerStatus, `a payment was allocated to another customer's invoice: ${crossCustomerBody}`).toBeGreaterThanOrEqual(400);
    // The code is asserted and not just the status, because this estate names
    // the refusal: "a payment settles invoices of its own customer only".
    expect(crossCustomerBody, 'the refusal does not name the mismatch').toContain('customer_mismatch');
    // AND THE LAW THAT MATTERS. A status code is a message; a balance is
    // money. This misattribution is the one that would leave a statement
    // perfectly self-consistent and still wrong — the payer's debt reduced by
    // money that went to someone else's invoice, and the other customer's
    // debt reduced by money they never paid. So both are re-read after the
    // refusal and both must be exactly where they were.
    expect(payerBalanceAfterCross, "the payer's balance was not re-read").not.toBeNull();
    expect(payerBalanceAfterCross, "the refused payment moved the payer's own balance").toBe(observedBalanceMinor);
    expect(targetBalanceAfterCross, "the target's balance was not re-read").not.toBeNull();
    // That customer has exactly one invoice and nothing has ever been
    // collected against it, so their whole receivable IS its total — which is
    // what the figure must still be.
    const untouched = BigInt((termOpenInvoices ?? [])[0]?.totalTxnMinor ?? '-1');
    expect(untouched > 0n, 'the untouched total came back as nothing, so the comparison below would be about zero').toBe(true);
    expect(targetBalanceAfterCross, "the refused payment moved the other customer's balance").toBe(untouched);
  });

  it('OWED — the statement route is read through this file once it reaches a tree this suite shares', () => {
    // RED ON PURPOSE, and it is the schedule rather than an oversight: this
    // lane's item is green on CI at the pilot's day 6-8. The assertion is
    // written against the route and not against a mock, so the day
    // `STATEMENT_PATH` names a path this suite can reach, this case begins
    // measuring the real statement through `windowsOf` and
    // `statementOffencesIn` above — the same checkers the planted witnesses
    // exercised in both directions — and through `closureOffencesIn`, whose
    // receivable half is already live.
    //
    // What is owed is NOT the route's existence. It is mounted on an open
    // branch, measured there: `GET /v1/customers/:customerId/account-statement`
    // at `customers.controller.ts:118` on `l3/customer-statement` @
    // `8eeb3303`, with `outstanding[]` carried inside the answer. Two things
    // keep it out of reach from here: that PR is unmerged with changes
    // requested, and it has no running balance yet, so the recurrence has
    // nothing of its own to read.
    expect(
      STATEMENT_PATH,
      'the statement route is mounted on an open branch and not on this one, and it carries no running balance yet, so this suite neither reaches it nor fakes it',
    ).not.toBeNull();
  });
});
