# PATCH-REQ-S5-004 — relocate the S5 plan layer into `packages/inventory` at promotion

| field | value |
|---|---|
| requested by | P4-S5 owner |
| base of record | `phase/4-sales-pos-customers-receivables` @ `6587460` |
| target file | `packages/inventory/src/returns-settlement.ts` (new), and one line in `packages/inventory/src/index.ts` |
| owner of target | the inventory primitives — **one owner in this phase, and it is not S5** |
| depends on | nothing technical. It is a PROMOTION-TIME request, deliberately not made now |
| blocks | nothing. The slice works at levels A–E without it |

## Required change

Move the body of `apps/api/src/modules/returns/returns-settlement.ts` into
`packages/inventory/src/returns-settlement.ts`, add `export * from './returns-settlement';` to
`packages/inventory/src/index.ts`, and reduce the API module file to a re-export — the exact
device `apps/api/src/modules/receivables/customer-settlement.ts` already is.

Hold it to a vectors file, `packages/inventory/vectors/returns-settlement-vectors.json`, the way
`supplier-settlement.ts:18-20` is held to `vectors/supplier-settlement-vectors.json` and
`customer-settlement.ts` to its own.

## Reason

S4's AR settlement arithmetic began at
`apps/api/src/modules/receivables/customer-settlement.ts` (671 lines) and was reconciled into
`packages/inventory/src/customer-settlement.ts`, with the API file kept as a re-export. That
reconciliation's own header records why
(`packages/inventory/src/customer-settlement.ts:6-26`): two independently written
implementations of one arithmetic had both landed, and *"the prohibition on a second body of a
financial truth was kept at the primitive level and broken one layer up"*. The package is where
a plan layer belongs, so that the one body is reachable from the API, from the tests and from
any future caller without a second copy appearing beside it.

S5's plan layer is therefore written in the API module ONLY as a staging position, and this
request is the record that it is one rather than a preference.

## Why S5 does not make the change now

`packages/inventory` holds the inventory primitives and the Phase 4 operation vocabulary, and
the operating directive names them a shared, single-owner area. Two slices in parallel
development both adding a module to that package, both touching its `index.ts`, is how one
conflicting change lands in a file the whole estate depends on. The staged position costs one
file move and no behaviour.

Note what the staging does NOT cost: the plan layer **imports** `convertToBase`,
`creditRelease`, `creditRemainingCarrying`, `verifyCreditChain` and `VALUE_LIMIT_MINOR` from
`@daftar/inventory` and re-implements none of them, so there is no second body of a financial
truth at either location. Reading a primitive is not editing it.

## The test that requires it

No test requires the move. Two things would notice it:

- `tests/guards/sale-s2-base-split-agreement.test.ts:18-23` records the package dependency
  discipline this estate keeps, and a plan layer in `apps/api` is reachable only from a suite
  that imports `apps/api/src/...` by relative path — which both S5 level-C suites do, and which
  the accepted `tests/helpers/supplier-settlement.ts:60-72` also does, so it is a precedent and
  not a novelty;
- a vectors file can only be held against a package module, so the vector discipline is what the
  move actually buys.

## Expected semantic diff

None. The same exported names, the same bodies, one import path changed inside
`apps/api/src/modules/returns/*` and a re-export in its place. A pure relocation, verifiable by
diffing the two file bodies.
