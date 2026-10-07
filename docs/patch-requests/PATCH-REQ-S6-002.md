# PATCH-REQ-S6-002 — widen `InventoryErrorCode` with every S6 refusal code

**From:** P4-S6 owner, branch `p4s6/owner`, base `6587460ba3632231e4324c5ce2af92e1589d0705`.
**Status:** OPEN.

## Target file

`packages/inventory/src/errors.ts` — an **inventory primitive**, outside S6's ownership.

## Required change

Add every member of `REVERSAL_CODES`
(`packages/inventory/src/customer-reversal.ts`) to `InventoryErrorCode`, in three namespace
blocks — `payment_reversal.*`, `allocation_reversal.*`, `invoice_void.*` — beside the
existing `customer_payment.*` block (`errors.ts:128-135`).

## Reason

`customer-settlement.ts:202` carries a compile-time binding

```ts
const PLAN_CODES_ARE_INVENTORY_CODES: Record<Exclude<ReceivableArithmeticCode, InventoryErrorCode>, never> = Object.freeze({});
```

which is what makes "a live raise site whose code no status table classifies" a **type
error** rather than a 500 the merchant sees. S6 cannot write that line today: none of its
codes is an `InventoryErrorCode`, so the `Exclude` is non-empty and the file would not
compile.

The defect this prevents is recorded with its cost at `customer-settlement.ts:113-120`:
`customer_payment.amount_invalid` was reachable from `arSide` and registered nowhere, "so a
merchant sending a non-positive applied amount got a 500 reporting OUR arithmetic as broken
for plainly their input."

## Dependency

None on the database. It can land as soon as S6 is promoted. Until it lands, S6's union is
**local and closed**, and `REVERSAL_CODES` is the list this request is checked against.

## The test that requires it

`packages/inventory/test/customer-reversal.test.ts` →
*"the code union and its array are the same set, and the array is sorted"*, which pins the
the array itself from S6's side so this request cannot drift from its subject — and a COUNT is deliberately not written anywhere here, because a number in prose drifts from the array it describes, and three codes were in fact added after review (F6 and the date validation). The test that requires
the **widening** is the `PLAN_CODES_ARE_INVENTORY_CODES` line above, which becomes writable
the day it lands.

## Expected semantic diff

Every `REVERSAL_CODES` literal added to one union. No existing member changes. Every consumer of
`InventoryErrorCode` keeps compiling, because a union only widens.

## What else this unblocks, and does not itself do

A code in `InventoryErrorCode` is still **unclassified** until a status table maps it to an
HTTP status and a locale catalogue gives it a sentence. Those are `PATCH-REQ-S6-009`, and
this request must not be read as having done them.
