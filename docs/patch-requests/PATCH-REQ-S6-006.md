# PATCH-REQ-S6-006 — three `OPERATION_AUTHORITY` rows for the S6 operations

**From:** P4-S6 owner, branch `p4s6/owner`, base `6587460ba3632231e4324c5ce2af92e1589d0705`.
**Status:** OPEN. Coupled to `PATCH-REQ-S6-001`.

## Target file

`apps/api/src/modules/inventory/inventory-authorization.ts` — outside S6's ownership.

## Required change

```ts
'customer.reverse_payment':    { permission: 'payments.reverse', scope: 'warehouses' },
'customer.reverse_allocation': { permission: 'payments.reverse', scope: 'warehouses' },
'sale.void_invoice':           { permission: 'sales.void',       scope: 'warehouses' },
```

The same shape and the same reasoning as S4's two rows
(`apps/api/src/modules/receivables/receivables.module.ts:70`).

## Reason

`OPERATION_AUTHORITY` is a `Record<InventoryOperationCode, …>` with **no default**, so the
file stops compiling the moment `PATCH-REQ-S6-001` registers the codes. The two must land
together or in that order.

`scope: 'warehouses'` passes the scope half trivially because no S6 command names a
warehouse — the accepted `supplier.*` and `customer.*` shape. `business_wide` would be
wrong for the same reason S4 gives: it is not the narrower choice, and nothing here needs it.

## The authority itself is NOT invented

Both keys are already in the **closed set of twelve** (`permissions.ts:68-89`, `P4-AL-36`):
`payments.reverse` (`:85`) and `sales.void` (`:80`). Both are **SENSITIVE** (`:139`, `:142`),
so under the `OD-P4-01` **OPTION A** ruling neither may be a **default** of any built-in
role, the cashier and the manager included. **This request adds no permission, no default
and no role.** Anyone adding a thirteenth key (`reversals.approve`, say) is making the edit
`P4-AL-36` forbids.

## Dependency

`PATCH-REQ-S6-001` (the codes), and S6 promotion. It cannot land first: without the codes
there is no key for the record to hold.

## The test that requires it

`packages/inventory/test/customer-reversal.test.ts` →
*"every permission S6 names is ALREADY one of the registered twelve, and every one of them is
SENSITIVE"*, which holds `REVERSAL_OPERATION_AUTHORITY` against `PERMISSIONS` and
`SENSITIVE_PERMISSIONS` from S6's side today, and asserts that
`PERMISSIONS` does **not** contain a fabricated `reversals.approve`.

## Expected semantic diff

Three rows added to one record. No existing row changes, and no permission registry is
touched.
