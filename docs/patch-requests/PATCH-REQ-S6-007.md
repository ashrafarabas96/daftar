# PATCH-REQ-S6-007 — `P4-AL-22` names two level constraints; the live tree has five

**From:** P4-S6 owner, branch `p4s6/owner`, base `6587460ba3632231e4324c5ce2af92e1589d0705`.
**Status:** OPEN. Documentation correction; no code effect.

## Target file

`docs/PHASE_4_ARCHITECTURE_LOCK.md:509-511` — the Architecture Lock. **Read, never edited by
S6**, which is why this is a request.

## The measured fact

`P4-AL-22` says:

> The accepted level-uniqueness constraints are
> `supplier_credit_allocations_level_uq UNIQUE (business_id, credit_note_id, credit_remaining_before_minor)`
> (`0067:438`) and `supplier_refunds_level_uq` (`0067:491`).

`grep -rn "_level_uq" infrastructure/database/` at the base SHA returns **five**:

| constraint | `file:line` |
|---|---|
| `payment_allocations_level_uq` | `0081:334` |
| `customer_credit_applications_level_uq` | `0081:470` |
| `customer_credit_applications_invoice_level_uq` | `0081:474` |
| `supplier_credit_allocations_level_uq` | `0067:438` |
| `supplier_refunds_level_uq` | `0067:491` |

The lock is not wrong about its own moment — it was written before `0081` existed, and
`:528-530` already requires the pair of devices on "the payment, the credit note, the customer
credit", which is what `0081` then built. It is **stale as an enumeration**, and the
enumeration is exactly what a reader of S6's level-uniqueness work will reach for.

## Required change

At `:509-511`, replace the two-item enumeration with a pointer to the live reading and the
current count, e.g. *"The accepted level-uniqueness constraints at the time of this lock were
the two supplier ones (`0067:438`, `0067:491`); `0081` added three customer ones, and the
live enumeration is `docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §0."*

The **substance** of `P4-AL-22` is not changed and must not be: level uniqueness is necessary
and not sufficient, the sufficient mechanism is the COMMIT-time chain verifier, each
consumable source carries **both**, and the recorded cost at `:533-537` is the one that
authorises S6's replacement.

## Reason

An enumeration a reader checks against the tree, which the tree contradicts, is the
"27 → 30 → 32" class of defect `docs/PHASE_4_S5_PREPARATION.md` §0 item 3 records being
structurally eliminated from the test estate. The same class in a document is caught by a
reader or not at all. Recording it in S6's own pack is not enough: the lock is where a
future slice will look.

## Dependency

None. It can land at any time and changes no behaviour.

## The test that requires it

None, and that is the honest answer — a prose enumeration has no test, which is precisely why
it drifted. The closest thing to a check is
`packages/inventory/test/customer-reversal.test.ts`' refusal to name a migration number, and
`docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §0, which states the enumeration **as a read** with the
command that produced it, so the next reader can re-run it instead of trusting it.

## Expected semantic diff

One paragraph of one document. No code, no SQL, no test.
