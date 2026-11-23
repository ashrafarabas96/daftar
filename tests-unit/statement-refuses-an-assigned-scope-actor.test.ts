/**
 * THE BRANCH-SCOPE REFUSAL, AS BEHAVIOUR — and the read count is the claim.
 *
 * Both reviews of `c8b1c673` named the same hole, and the money review added
 * the measurement that made it worth closing: `customer.business_wide_scope_required`
 * had NO behavioural arm anywhere in the customers module — not for the
 * statement, not for its `open-invoices` sibling — the only hit in the tree
 * being a code-to-status table in `sale-s2-error-contract.test.ts:200`, which
 * is a catalogue and not enforcement. The sibling unit suite pins
 * `businessWide: true` in `SELLING_ROUTE_AUTHORITY`, and that table is a
 * DECLARATION: the money review measured ZERO production consumers of it, so a
 * route whose decorator said something weaker would keep that pin green.
 *
 * WHY THE READ COUNT AND NOT THE STATUS. A controller that fetched the ledger
 * and threw afterwards would also answer 403, and an arm that looked only at
 * the status would call that correct while the statement had already been read
 * for an actor whose scope does not reach it. The claim here is therefore
 * "nothing was read before the refusal", which needs a stub that counts — so
 * this is a CONTROLLER-level arm with no cluster, under `tests-unit/`
 * (`vitest.config.ts`'s globalSetup boots Postgres for everything under
 * `tests/**`, unconditionally, so this file would pay for a database it never
 * queries if it sat there).
 *
 * The negative control is the second arm: the same construction with a
 * business-wide actor must REACH the read. Without it, a controller whose
 * handler was gutted entirely would pass the first arm.
 */
import { describe, expect, it } from 'vitest';

// `@daftar/domain-core`, THE SAME SPECIFIER PRODUCTION USES, and not the
// relative path into `packages/domain-core/src/errors`. I wrote the relative
// one first and this arm went red with the refusal visibly thrown at
// `customers.controller.ts:127` in the stack: two module instances of one
// class, so `instanceof` was false and `refusal()` rethrew. A red that says
// "no refusal" when the refusal happened is worse than no arm, and the cause
// was the import specifier, not the subject.
import { AppError } from '@daftar/domain-core';
import type { CustomerReadService } from '../apps/api/src/modules/selling/customer-reads';
import { CustomersController } from '../apps/api/src/modules/selling/customers.controller';
import type { MembershipContext } from '../apps/api/src/modules/tenancy/tenancy.service';

const CUSTOMER = '44444444-4444-4444-8444-444444444444';

function member(branchScopeMode: 'all' | 'assigned'): MembershipContext {
  return {
    tenantId: '11111111-1111-4111-8111-111111111111',
    businessId: '22222222-2222-4222-8222-222222222222',
    userId: '33333333-3333-4333-8333-333333333333',
    roles: new Set(['owner']),
    roleKeys: ['owner'],
    branchScopeMode,
    allowedBranchIds: [],
  } as unknown as MembershipContext;
}

/** A read service that answers nothing and only records that it was asked. */
function countingReads(): { reads: () => number; svc: CustomerReadService } {
  let n = 0;
  const svc = {
    statement: async () => {
      n += 1;
      return { customerId: CUSTOMER, rows: [] };
    },
  } as unknown as CustomerReadService;
  return { reads: () => n, svc };
}

async function refusal(run: () => Promise<unknown>): Promise<AppError> {
  try {
    await run();
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error('expected a refusal, and the route answered instead');
}

describe('the statement refuses an assigned-scope actor BEFORE it reads anything', () => {
  it('an assigned-scope actor is refused 403 customer.business_wide_scope_required, and the ledger is never read', async () => {
    const { reads, svc } = countingReads();
    const e = await refusal(() => new CustomersController(svc).statement(member('assigned'), CUSTOMER));
    expect(e.httpStatus, 'the refusal is a 403, not a 404 and not a 500').toBe(403);
    expect(e.details, 'the refusal must name the selling code the error contract publishes').toEqual({ sellingCode: 'customer.business_wide_scope_required' });
    expect(reads(), 'the statement was fetched and only THEN refused, which leaks the read this refusal exists to prevent').toBe(0);
  });

  it('THE NEGATIVE CONTROL: a business-wide actor does reach the read, so the arm above is not passing on a dead handler', async () => {
    const { reads, svc } = countingReads();
    await new CustomersController(svc).statement(member('all'), CUSTOMER);
    expect(reads(), 'a business-wide actor must reach the reader, or the first arm proves nothing').toBe(1);
  });
});
