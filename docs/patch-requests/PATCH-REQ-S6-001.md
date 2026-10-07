# PATCH-REQ-S6-001 — register the three P4-S6 operation codes

**From:** P4-S6 owner, branch `p4s6/owner`, base `6587460ba3632231e4324c5ce2af92e1589d0705`.
**Status:** OPEN. Blocked on S6 promotion.

## Target file

`packages/inventory/src/payload.ts` — an **inventory primitive**, outside S6's ownership.

## Required change

Add, in the shape `InventoryP4S4OperationCode` / `INVENTORY_P4_S4_OPERATION_CODES` already
uses (`payload.ts:189`, `:259`):

```ts
export type InventoryP4S6OperationCode = 'customer.reverse_payment' | 'customer.reverse_allocation' | 'sale.void_invoice';
export const INVENTORY_P4_S6_OPERATION_CODES: readonly InventoryP4S6OperationCode[] = [
  'customer.reverse_payment',
  'customer.reverse_allocation',
  'sale.void_invoice',
];
```

both joined into `InventoryOperationCode` / `INVENTORY_OPERATION_CODES`, plus **one**
`INVENTORY_PAYLOAD_SCHEMAS` entry per code whose field order matches the S6 routine's own
argument order exactly (`payload.ts:928` and `:1104` are the S4 entries).

## Reason

`canonicalInventoryPayload` cannot hash a payload whose op code has no field schema, so no
`invctl/1` assertion can be minted for any S6 command. The codes already satisfy the
**frozen** `^[a-z]+(\.[a-z_]+)+$` (`0054:53`, duplicated at `0054:229`), so no first segment
carries an underscore, and `P4-AL-28`'s `customer_payment.*` shape was never a candidate.

## Dependency

**Must land AFTER S6 is promoted and its routines exist**, not before.
`gate:phase4:s4`'s `command-refusal-audit` check discovers a command path per **declared**
Phase 4 operation; three codes registered with no routine behind them make it report a path
it cannot find. That is why S6 declares them locally in
`packages/inventory/src/customer-reversal.ts` (`REVERSAL_OPERATION_CODES`) rather than
registering them now.

## The test that requires it

`packages/inventory/test/customer-reversal.test.ts` →
*"every S6 operation code satisfies the FROZEN operation-code regex, so no first segment
carries an underscore"* holds the codes to the regex from this side today. The test that
requires the **registration** is the level-F assertion-minting suite, which cannot exist
until the routines do.

## Expected semantic diff

Three literals added to two unions and two arrays, three schema entries added to one record.
No existing code, array element or schema entry changes, and nothing is **reordered** —
`INVENTORY_OPERATION_CODES`' order is read by payload digests.
