# PATCH-REQ-S8-001 — `SALES_RECONCILIATION_CHECK_IDS` in the product reconciler

| | |
|---|---|
| raised by | P4-S8 |
| base SHA | `6587460ba3632231e4324c5ce2af92e1589d0705` |
| target file | `packages/accounting/src/reconciliation.ts` |
| owner | the accounting-package owner |
| check waiting on it | `rsal-in-product-reconciler` (`WAITING_FOR_INTEGRATED_SURFACE`) |
| test that requires it | `tests/guards/p4s89-waiting-status-law.test.ts::rsal-in-product-reconciler reports WAITING_FOR_INTEGRATED_SURFACE and never PASS` |

## Required change

Export the seven `P4-AL-49` sales reconciliation check ids beside the accepted
`RECONCILIATION_CHECK_IDS` (R-ACC-01…09) and
`INVENTORY_RECONCILIATION_CHECK_IDS` (R-INV-01…05):

```ts
export const SALES_RECONCILIATION_CHECK_IDS = ['R-SAL-01', 'R-SAL-02', 'R-SAL-03', 'R-SAL-04', 'R-SAL-05', 'R-SAL-06', 'R-SAL-07'] as const;
```

and compute them in the existing pass, on the existing `daftar_reconciler`
read-only connection.

And **delete the `sales-payment` entry from `DEFERRED_RECONCILIATION_DOMAINS`**,
whose stated reason is "the R-SAL-* pass is assembled in P4-S8". Once the ids
are there that reason is false, and a deferral whose reason has become false is
a green nobody re-reads. `rsal-in-product-reconciler` asserts both halves and
reports the stale deferral by name.

## Reason

`P4-AL-49` adds the seven to the **EXISTING** pass. S8 holds the contract table
(`scripts/phase4-s8/reconciliation-framework.ts`: identity, agreement domains,
accounts, relations, grain, and at least one planted discrepancy per check,
13 plants in all), but the identities must be computed by the **product**, on
the read-only reconciler connection, and not by a second implementation inside
a gate. Two implementations of one identity disagree eventually, and the
disagreement is found by a reconciliation that should have found something else.

## Dependency

`R-SAL-01`, `02`, `04` and `05` read `credit_notes`, `refunds` and
`payment_allocations`; the first two are **P4-S5**'s. So this patch lands with
or after S5, and the check reports WAITING until then — which is why it is a
patch request with a dependency rather than an edit now.

## Why S8 did not edit the file

The accounting package is on the forbidden list for this slice, and for a good
reason: it carries the single financial model. A gate owner adding a second
place where an accounting identity is defined is exactly how a second financial
model starts.

## Expected semantic diff

| | before | after |
|---|---|---|
| `SALES_RECONCILIATION_CHECK_IDS` | not exported | 7 ids, exactly `P4-AL-49`'s |
| `DEFERRED_RECONCILIATION_DOMAINS` | contains `sales-payment` | does not |
| `rsal-in-product-reconciler` | WAITING | evaluates |
| who computes an R-SAL identity | nobody | the product reconciler |
