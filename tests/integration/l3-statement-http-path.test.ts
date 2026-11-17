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
 *   §2 the running balance is the CUMULATIVE sum of the rows above it, which
 *      is the one thing a statement is for and the one thing a per-row reader
 *      can get wrong without any row looking wrong;
 *   §3 an unknown customer is refused rather than answered with an empty
 *      statement, because "no rows" and "no such customer" are different
 *      facts and a merchant must not read one as the other.
 *
 * WHAT IS DELIBERATELY NOT HERE, named so no reader mistakes its absence for
 * coverage: the BRANCH-SCOPE refusal. A statement spans the business, and the
 * controller enforces that with `assertBusinessWide`, raising
 * `customer.business_wide_scope_required` (`customers.controller.ts:111`). I
 * did not write an arm for it, because the refusal is raised for an
 * ASSIGNED-SCOPE ACTOR -- the existing suites build one and then call
 * (`inventory-opening-authority.test.ts:66` is the shape) -- and it is NOT
 * reachable by setting a branch header on the owner's request. I had written
 * exactly that invented arm, using a `w.branchId` field that does not exist on
 * `SettlementWorld`, and it would have produced a red that said nothing about
 * the route. The unit sibling pins the DECLARATION (`businessWide: true`),
 * which is text and not enforcement, so this gap is real until an arm builds
 * an assigned-scope actor.
 *
 * IMPORTED RED, NAMED BEFORE IT HAPPENS (the base is another PR's head): this
 * run carries `#85`'s content, so a failure inside `0092`'s own laws or in
 * `apps/api/src/config.ts` belongs to the BASE and not to this change.
 * Anything else here is mine.
 *
 * NOT RUN YET, AND I WILL NOT CALL IT MEASURED UNTIL IT IS: this worktree was
 * cut fresh and has no `node_modules`, and installing them is a network-heavy
 * job while CI runs are in flight, which RULE-10 forbids. So the red below is
 * INTENDED, not observed. The moment the runner is free: one install, then
 * this file and its unit sibling, and the observed codes recorded in the
 * commit message.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { newCustomer, sellOnCredit, settlementWorld, stockUp, type SettlementWorld } from '../golden-regression/phase4-s4/settlement-world';

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

  it('§2 each row\'s running balance is the cumulative sum of the rows up to it', async () => {
    const res = await w.t.request.get(statementPath(customerId)).set(w.headers);
    expect(res.status).toBe(200);

    const rows = res.body.rows as readonly Record<string, string>[];
    // The fixture must be able to tell the designs apart BEFORE the reader is
    // asked anything: if every debit were zero, a reader that returned zero
    // for every running balance would pass this arm and prove nothing.
    const debits = rows.map((r) => Number(r.debitTxnMinor ?? 0));
    const credits = rows.map((r) => Number(r.creditTxnMinor ?? 0));
    expect(
      debits.reduce((t, d) => t + d, 0),
      'the fixture produced no debits, so this arm cannot discriminate',
    ).toBeGreaterThan(0);

    let cumulative = 0;
    rows.forEach((row, index) => {
      cumulative += debits[index] - credits[index];
      expect(
        Number(row.runningBalanceTxnMinor),
        `row ${index + 1} (${row.entryKind}) must carry the cumulative balance, not its own amount`,
      ).toBe(cumulative);
    });
  }, 300_000);

  it('§3 refuses an unknown customer instead of answering with an empty statement', async () => {
    const res = await w.t.request.get(statementPath('00000000-0000-4000-8000-000000000000')).set(w.headers);
    expect(res.status, 'an unknown customer must not read as a customer with no entries').toBe(404);
  }, 300_000);

});
