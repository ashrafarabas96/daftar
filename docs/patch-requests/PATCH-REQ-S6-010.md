# PATCH-REQ-S6-010 — the three test hooks S6 needs inside S4's suites

**From:** P4-S6 owner, branch `p4s6/owner`, base `6587460ba3632231e4324c5ce2af92e1589d0705`.
**Status:** OPEN. Blocked on P4-S4 sealing and S6 promotion.

## Target files — all `tests/**`, all belonging to P4-S4's suites

1. `tests/golden-regression/phase4-s4/harness.ts`
2. `tests/golden-regression/phase4-s4/settlement-path.ts`
3. `tests/guards/p4s4-settlement-surface-laws.test.ts`

S6 edits **none** of them. Every one is an existing S4 suite.

## Required changes

### 1. `harness.ts` — an active-chain reader and a `plantReversalRow`

`invoiceChain`, `chainBreak` and `chainTotals` exist and read the chain over **all** rows.
S6's chain is the **ACTIVE** subset. Two additions:

- `activeInvoiceChain(...)` / `activeCreditChain(...)` — the chain anti-joined against the
  reversal relations. **One** definition, reached by every S6 suite, so a reader of the chain
  and a writer of a reversal cannot disagree about which rows are active;
- `plantReversalRow(...)` beside the existing `plantSettlementRow`, which is what the
  direct-SQL red proofs of `docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §6 are driven through.

### 2. `settlement-path.ts` — a reversal path

`collectPayment` and `applyCredit` exist. S6 needs `reversePayment`, `reverseReducer` and
`voidInvoice`, driving the product's own HTTP commands. **No `payment_reversals` or
`allocation_reversals` row may be inserted by hand** in any suite that asserts a claim about
the system: "a test written against relations the test itself created would prove the fixture
and not the system" (`docs/PHASE_4_S5_PREPARATION.md` §8), and the terms are the ones
`tests/golden-regression/phase4/01-cross-tenant.golden.test.ts:198-206` sets for S4's four
relations. The sole exception is a **planted** direct-SQL insert whose whole purpose is to be
refused.

### 3. `p4s4-settlement-surface-laws.test.ts` — extend the "no UPDATE" law to S6's two cases

That suite holds true the claim that neither S4 routine issues an `UPDATE` on `invoices`,
`customers` or `payments` — every `UPDATE` token in either body being the word inside a
`FOR UPDATE` clause (`0081:663-669`). S6 breaks that claim in **two** specific, lawful ways
and must not do so silently:

- the S6 migration grants `UPDATE (<one column>) ON payments TO daftar_inventory_internal`
  purely for the **row-lock ACL** of lock step 2 (`docs/PHASE_4_S6_CONTRACT_PACK.md` §8.1),
  and the S6 routines must still issue **no** `UPDATE` on `payments`. The law needs the new
  grant as a subject and the new routines inside its scan;
- the `void_invoice` command **does** update `invoices.status`, lawfully: the grant already
  exists (`0081:682`) and `invoices_lifecycle_guard()` (`0075:546`) already admits
  `open → void`. So the law gains one **named exception with its bound**, not a loosened
  predicate — the exception is `void_invoice`, the column is `status`, the transition is
  bounded by a guard the role cannot lift (`0081:674-680`: it owns the guard functions but
  **not** the tables, so it cannot `ALTER TABLE … DISABLE TRIGGER`).

A loosened predicate here would delete the law. The exception must be by name, with the
bound stated, and with its own red proof: an `UPDATE` of `invoices.status` from outside
`void_invoice` must still be refused (`invoice_void.direct_update_refused`,
`docs/PHASE_4_S6_DDL_SPECIFICATION.md` §5.1).

## Reason

Without (1) and (2), S6's level-F suites would each build their own activeness definition and
their own reversal path — two bodies of one truth, which is what the harness exists to
prevent. Without (3), S6 lands a grant and an `UPDATE` that an accepted suite's claim says do
not exist, and the suite either goes red for the wrong reason or is quietly weakened.

## Dependency

P4-S4 sealed (so the harness is final), S6 promoted, and `PATCH-REQ-S6-004` (so there is
something to drive).

## The test that requires it

Every level-F S6 suite, and specifically the two-directional red proofs per replaced
constraint that `PATCH-REQ-S6-004` owes: the unlawful direct insert refused, the lawful
post-reversal insert accepted. Both need `plantReversalRow` and the active-chain reader.

## Expected semantic diff

Two new exported helpers and one new path module in `tests/golden-regression/phase4-s4/`;
in the guard suite, one widened subject list and one **named** exception with its bound and
its own red proof. **No existing assertion is weakened or deleted.**
