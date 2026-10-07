# PATCH-REQ-S6-003 — add the three customer source types to `DOMAIN_REVERSIBLE_SOURCE_TYPES`

**From:** P4-S6 owner, branch `p4s6/owner`, base `6587460ba3632231e4324c5ce2af92e1589d0705`.
**Status:** OPEN. Blocked on the S6 migration.

## Target file

`packages/accounting/src/post.ts:301` — an **accounting package**, outside S6's ownership.

## Required change

```ts
export const DOMAIN_REVERSIBLE_SOURCE_TYPES = [
  'purchase',
  'customer_payment_allocation',
  'customer_credit_application',
  'customer_credit',
] as const;
```

## Reason

The constant is `['purchase']` alone today, and `0081`'s own comment says why and whose job
this is: *"None of the three joins `DOMAIN_REVERSIBLE_SOURCE_TYPES` below. Reversal is
P4-S6: this slice ships no reversal document for any of them"* (`post.ts:280-282`). The same
file states the mechanism the list gates: a domain source type is reversible only where the
writer "requires a paired `purchase_reversals` row in the same transaction before
`accounting_post_reversal` runs" (`post.ts:292-297`), minted by
`mintDomainReversalAssertion`.

Without this, `mintDomainReversalAssertion` refuses every S6 reversal and no mirror can be
signed.

## Dependency

**Must land in the same change as, or after, the S6 migration's widening of
`accounting_reversals_20_domain_source_guard()`**
(`docs/PHASE_4_S6_DDL_SPECIFICATION.md` §4). Landing it first would let the application mint
a reversal assertion the database still refuses — a loud failure rather than a silent one,
but an avoidable round.

## The test that requires it

The level-F suite that posts a mirror through `accounting_post_reversal` for a reversed
allocation. At level C the requirement is recorded in `P4_S6_REQUIRED_WIRING`
(`packages/inventory/src/customer-reversal.ts`) and asserted present by
`packages/inventory/test/customer-reversal.test.ts` →
*"the required-wiring record names a patch request per row and leaves no row unowned"*.

## Expected semantic diff

Three literals appended to one `as const` array. `'purchase'` stays **first**, because
nothing should have to prove that an append is not a reorder.

## What this request does NOT ask for

It does not ask for a new accounting **source type**. S6 registers none:
`payment_reversals` and `allocation_reversals` carry
`accounting_source_type GENERATED ALWAYS AS ('reversal') STORED`, following `0065:17-18`
("`purchase_reversal` is registered as a STOCK source type only … its accounting fact is a
Phase 2 `reversal`") and `0065:310`, rather than `P4-AL-20`'s stale enumeration. The
enumeration correction is `PATCH-REQ-S6-008`.
