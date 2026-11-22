/**
 * `GET /v1/customers/:customerId/statement` MUST BE IN THE ROUTE AUTHORITY
 * TABLE, WITH THE SAME AUTHORITY ITS SIBLINGS CARRY.
 *
 * WHAT THIS LAW PROVES, AND WHAT IT DOES NOT — stated first, because a law
 * over a table is the easiest kind to over-read:
 *   - It PROVES registration: the route is declared, and it is declared with
 *     `receivables.view` and `businessWide: true` rather than with some weaker
 *     authority that would let a branch-scoped member read a whole business's
 *     ledger.
 *   - It does NOT prove the route EXISTS, that it answers, that it reads
 *     `customer_account_statement`, or that its running balance is right. A
 *     table entry is text. I have been bitten by exactly this shape before:
 *     six wiring seeds stayed green in a suite that booted no application, so
 *     a text law was read as a behaviour law.
 * The behaviour is the integration suite's subject
 * (`tests/integration/l3-statement-http-path.test.ts`), which needs a live
 * cluster and is therefore a separate file by necessity, not by taste.
 *
 * WHY IT LIVES UNDER `tests-unit/`: `vitest.config.ts`'s `globalSetup` calls
 * `ensurePostgres()` unconditionally, so anything under `tests/**` needs a
 * cluster before its first assertion. This law needs none, and today the
 * runner is busy — so putting it here is what lets it be MEASURED red now
 * instead of asserted red on faith.
 */
import { describe, expect, it } from 'vitest';

import { SELLING_ROUTE_AUTHORITY } from '../apps/api/src/modules/selling/selling-permissions';
import type { CustomerStatementRowDto } from '../packages/shared-contracts/src/customers';

/**
 * A COMPILE-TIME ARM, and the only kind that can state this claim: the four
 * amounts `0092` leaves empty must be declared nullable. `tsc` is the runner
 * for this one — if any of these fields were `string`, the object below would
 * not compile, and that is its red. A runtime assertion could not say it at
 * all, because the values already arrive null: nothing fails until a client
 * renders the null as 0, which is the defect the money review caught.
 */
const NULLABLE_SIDES: Pick<CustomerStatementRowDto, 'debitTxnMinor' | 'creditTxnMinor' | 'amountTxnMinor' | 'amountBaseMinor'> = {
  debitTxnMinor: null,
  creditTxnMinor: null,
  amountTxnMinor: null,
  amountBaseMinor: null,
};

const PATH = '/v1/customers/:customerId/statement';
const SIBLING = '/v1/customers/:customerId/open-invoices';

const entryFor = (path: string) => SELLING_ROUTE_AUTHORITY.find((r) => r.path === path && r.method === 'GET');

describe('the customer statement route and the authority it is declared with', () => {
  it('the table is readable and its sibling IS there, so a miss below is a fact and not a broken import', () => {
    // The positive control. Without it, a renamed export or a reshaped table
    // would make every assertion below fail for the wrong reason -- or, worse,
    // a `find` over an empty array would make a NEGATIVE law pass vacuously.
    expect(SELLING_ROUTE_AUTHORITY.length, 'the authority table came back empty -- the import is wrong, not the table').toBeGreaterThan(5);
    expect(entryFor(SIBLING), `the sibling ${SIBLING} is absent, so this probe cannot speak about ${PATH}`).toBeDefined();
  });

  it('the four sides `0092` can leave empty are declared nullable', () => {
    // The typed object above IS the claim; this arm reports it rather than
    // leaving a reader to notice a type alias at the top of the file.
    expect(NULLABLE_SIDES.debitTxnMinor, 'a credit-bearing entry has no debit side').toBeNull();
    expect(NULLABLE_SIDES.creditTxnMinor, 'a debit-bearing entry has no credit side').toBeNull();
    expect(NULLABLE_SIDES.amountTxnMinor, 'the preserved-credit branch leaves both amount columns empty').toBeNull();
    expect(NULLABLE_SIDES.amountBaseMinor).toBeNull();
  });

  it('the statement route is declared in the authority table', () => {
    expect(entryFor(PATH), `${PATH} is not declared in SELLING_ROUTE_AUTHORITY`).toBeDefined();
  });

  it('and it is declared with the SAME authority as its sibling, not a weaker one', () => {
    const entry = entryFor(PATH);
    const sibling = entryFor(SIBLING);
    // Named one by one rather than compared as objects: a whole-object equality
    // would also pass if both were wrong together, and it would say nothing
    // about WHICH field drifted on the day one does.
    expect(entry?.permission, 'a statement is a receivables read').toBe('receivables.view');
    expect(entry?.businessWide, 'a statement spans the business, so a branch-scoped member must not read it through a branch token').toBe(true);
    expect(entry?.permission, 'the statement must not be reachable with less authority than the open-invoices picker').toBe(sibling?.permission);
    expect(entry?.businessWide).toBe(sibling?.businessWide);
  });
});
