# PATCH-REQ-S6-008 — `P4-AL-20` lists an `allocation_reversal` source type that S6 must NOT register

**From:** P4-S6 owner, branch `p4s6/owner`, base `6587460ba3632231e4324c5ce2af92e1589d0705`.
**Status:** OPEN. Documentation correction with a design consequence.

**A status correction, recorded because the pack briefly said otherwise.** This request was
reported as "withdrawn". It is not: what is withdrawn is the `allocation_reversal`
**accounting source type** inside its body — the thing S6 must not register — and not the
request, which stands. On the merits it is right and stays: the live registry
(`0081:2467-2472`) holds no such row, the native `reversal` type carries the journal fact
(`0065:17-18`, `:310`), and registering one would be the second source identity
`P4-AL-23`/`P4-AL-09` forbid.

## Target file

`docs/PHASE_4_ARCHITECTURE_LOCK.md:476-478` — the Architecture Lock, read-only for S6.

## The measured fact

`P4-AL-20` says Phase 4 registers six new accounting source types and names them:

> `sale`, `invoice`, `payment_allocation`, `credit_note`, `refund`, `allocation_reversal`

Three of the six are already contradicted by the live registry and one of the live rows was
never enumerated — a finding `docs/PHASE_4_S5_PREPARATION.md` §3.3 reached independently from
the S5 side. The customer-side rows actually registered are
`customer_payment_allocation`, `customer_credit_application` and `customer_credit`
(`0081:2467-2472`), not `payment_allocation`. **And no `allocation_reversal` row exists.**

## Required change

Correct the enumeration, and record that **`allocation_reversal` is withdrawn as a source
type** — not deferred, withdrawn.

## Reason — this is not cosmetic; registering it would create a second truth

A reversal's journal fact is the **native** `reversal` source type
(`packages/accounting/src/post.ts:191`), written by the single reversal writer
`accounting_post_reversal` (`0046:449`), and keyed so that
`accounting_reversals.id = original_entry_id` allows **exactly one** whole-entry reversal per
entry for ever (`P4-AL-47`, restated at `post.ts:221-222` and `:257-258`).

The accepted precedent is explicit and is the shape S6 follows:

> `purchase_reversal` is registered as a **STOCK** source type only (R-B2a): its accounting
> fact is a Phase 2 `reversal`. — `0065:17-18`

and `purchase_reversals.accounting_source_type` is
`GENERATED ALWAYS AS ('reversal') STORED` (`0065:310`), with
`binding_source_id = original_entry_id` (`0065:315`).

Registering `allocation_reversal` as an accounting source type would give one journal fact
**two** source identities — the entry's own `reversal` binding and a second one naming the
reversal document — which `P4-AL-23` ("the binding table is the only edge, in both
directions") and `P4-AL-09` both forbid.

**So S6 registers no accounting source type at all.** `payment_reversals` and
`allocation_reversals` carry `accounting_source_type GENERATED ALWAYS AS ('reversal') STORED`
and bind on the original entry id (`docs/PHASE_4_S6_DDL_SPECIFICATION.md` §1.1, §2.1).

## Dependency

None for the document. The design consequence is already carried by
`docs/PHASE_4_S6_CONTRACT_PACK.md` §7.2 and the DDL specification, so S6 does not wait on
this to be ruled — it waits only to stop a later reader from re-deriving the question.

## The test that requires it

`docs/PHASE_4_S6_DDL_SPECIFICATION.md` §7 item 8: the S6 migration's end-state block asserts,
from `accounting_source_types`, that **no** `allocation_reversal` row exists and that the
native `reversal` row is unchanged. That is a live-catalogue assertion, so the design half of
this request is enforced by the migration whether or not the document is corrected.

## Expected semantic diff

One enumeration in one document, plus one sentence withdrawing `allocation_reversal`. No
code, no SQL, no registry row.
