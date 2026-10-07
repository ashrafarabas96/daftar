# PATCH-REQ-S5-001 — register the three P4-S5 operation codes in the inventory payload vocabulary

| field | value |
|---|---|
| requested by | P4-S5 owner |
| base of record | `phase/4-sales-pos-customers-receivables` @ `6587460` |
| target file | `packages/inventory/src/payload.ts` |
| owner of target | the inventory primitives — **one owner in this phase, and it is not S5** |
| depends on | nothing. Can land before or after S4 seals |
| blocks | the S5 migration's `inventory_operation_kinds` registration, `customer_credit_consume`'s widened assertion array (`PATCH-REQ-S5-003`), and the S4 gate's `command-refusal-audit` discovery of S5's command paths |

## Required change

Add a `InventoryP4S5OperationCode` union beside the four that exist, and join it to
`InventoryOperationCode` and to the runtime list family:

```ts
/** P4-S5: the returns slice — a credit note issued or voided, and a refund paid out. */
export type InventoryP4S5OperationCode = 'customer.issue_credit_note' | 'customer.void_credit_note' | 'customer.refund';

export type InventoryOperationCode =
  | …
  | InventoryP4S4OperationCode
  | InventoryP4S5OperationCode;

export const INVENTORY_P4_S5_OPERATION_CODES: readonly InventoryP4S5OperationCode[] = [
  'customer.issue_credit_note',
  'customer.void_credit_note',
  'customer.refund',
];
```

Nothing else in the file changes. No existing union gains or loses a member.

## Reason

`scripts/phase4-s4-gate.ts:3003` declares `OPERATION_VOCABULARY = 'packages/inventory/src/payload.ts'`
and `:3149` (`phase4OperationCodes`) reads the `InventoryP4S<n>OperationCode` unions out of it.
`:3351` refuses the file outright when it declares none: *"the law cannot learn which operations
are Phase 4's, so it has no subject and that is not a pass"*. So the vocabulary is where the
estate learns an operation exists, and an S5 command whose code is not there is a command the
refusal audit cannot discover and the operation-kinds registration cannot be checked against.

**The spelling is forced, not chosen.** `inventory_operation_kinds.op_code` is
`CHECK (op_code ~ '^[a-z]+(\.[a-z_]+)+$')`, frozen inside `inventory_payload_digest`
(`0054:229`, probed at `0074:62-70`), so the FIRST segment may hold no underscore and
`customer_refund.pay` is unrepresentable. Hence `customer.*`, the same namespace as S4's
`customer.collect_payment` and `customer.apply_credit`.

## Why S5 does not make the change itself

`packages/inventory` holds the inventory primitives and the operation vocabulary, and the
operating directive names them as a shared, single-owner area. Two slices in parallel
development editing one primitive union is how one conflicting change lands in a file the
whole estate depends on.

## The test that requires it

`tests/guards/p4s5-refund-plan-red-proofs.test.ts`, §9 — "the operation codes S5 needs are
representable under the frozen digest CHECK" — asserts the three codes against
`OPERATION_CODE_SHAPE` today, from `@daftar/domain-core`'s `S5_OPERATION_CODES`. That is the
level-C half and it does NOT need this patch.

What needs it is the integrated gate (level G): `gate:phase4:s4`'s `command-refusal-audit`
check, which at `6587460` measured *"11 declared Phase 4 operation(s)"* and *"10 command
path(s) discovered"*. The three S5 commands must appear in both numbers, and the audit must
reach the one `auditThenRethrow…` composer on each of their refusal paths.

## Expected semantic diff

- `phase4OperationCodes(root)` goes from 11 entries to 14;
- `InventoryOperationCode` gains three members, so `inventory_payload_digest`'s TypeScript twin
  accepts three more op codes and nothing else changes about it;
- no existing code's behaviour changes: the union is additive and no runtime list is reordered.

## What this patch must NOT do

- it must not touch `inventory_payload_digest`, the frozen `CHECK`, or any of the four
  settlement primitives in `supplier-settlement.ts`;
- it must not move `INVENTORY_P4_S4_OPERATION_CODES` or renumber anything.
