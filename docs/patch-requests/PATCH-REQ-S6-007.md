# PATCH-REQ-S6-007 — `P4-AL-22`'s level-constraint enumeration becomes stale the moment `0081` is sealed, and must be updated in that seal commit

**From:** P4-S6 owner, branch `p4s6/owner`, base `6587460ba3632231e4324c5ce2af92e1589d0705`.
**Status:** OPEN, and deliberately **not actionable yet**. Documentation correction, scheduled
to the `0081` seal commit. No code effect.

**Supersedes the first draft of this request**, which asserted that the Architecture Lock's
enumeration was *already* stale. That assertion was wrong, and the error was mine, not the
lock's — see "The correction" below. The enumeration of five constraints that the first draft
carried is a correct **read of the live tree** and is retained here unchanged; only the
conclusion drawn from it has changed.

## Target file

`docs/PHASE_4_ARCHITECTURE_LOCK.md:509-511` — the Architecture Lock. **Read, never edited by
S6**, which is why this is a request.

## The correction

`P4-AL-22` says:

> The **accepted** level-uniqueness constraints are
> `supplier_credit_allocations_level_uq UNIQUE (business_id, credit_note_id, credit_remaining_before_minor)`
> (`0067:438`) and `supplier_refunds_level_uq` (`0067:491`).

The operative word is **accepted**. `frozenThrough` is `0079`, so migrations `0080`–`0086` are
S4 **candidates** and nothing in them is accepted. The three customer constraints in `0081`
are therefore not counter-examples to `P4-AL-22`: they are not accepted, and the lock does not
claim they are. The same paragraph goes further and anticipates them in terms — *"Phase 4
**introduces** `payment_remaining_before_minor` on `payment_allocations`; it does not inherit
it"* — which is the lock describing the very rows I found in `0081`.

The conflation in the first draft was between **accepted** and **live**, and it was mine. The
lock is correct as written, at its own moment and at this one.

## The live read (retained, as a read)

`grep -rn "_level_uq" infrastructure/database/` at the base SHA returns **five** occurrences:

| constraint | `file:line` | accepted? |
|---|---|---|
| `payment_allocations_level_uq` | `0081:334` | NO — S4 candidate, `frozenThrough` is `0079` |
| `customer_credit_applications_level_uq` | `0081:470` | NO — S4 candidate |
| `customer_credit_applications_invoice_level_uq` | `0081:474` | NO — S4 candidate |
| `supplier_credit_allocations_level_uq` | `0067:438` | YES |
| `supplier_refunds_level_uq` | `0067:491` | YES |

Two accepted, exactly as `P4-AL-22` enumerates. Three candidates, which `P4-AL-22`'s own
"introduces" sentence anticipates. The read is worth keeping because S6's replacement work has
to address all five — three by replacing their protection, two by leaving them alone (TD-15,
`docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §5) — and because `supplier_payment_allocations` has no
level constraint at all, which inverts the symmetry a reader would assume.

## Required change, and when

**At the moment `0081` is sealed** — i.e. when `frozenThrough` advances past it — the
two-item enumeration at `:509-511` becomes stale as a statement about the accepted set, and it
must be updated **in that seal commit**, not before. Updating it earlier would make the lock
claim an acceptance that has not happened, which is a worse defect than the one being
prevented.

The replacement text at that moment is an enumeration of five, e.g. *"The accepted
level-uniqueness constraints are `payment_allocations_level_uq` (`0081:334`),
`customer_credit_applications_level_uq` (`0081:470`),
`customer_credit_applications_invoice_level_uq` (`0081:474`),
`supplier_credit_allocations_level_uq` (`0067:438`) and `supplier_refunds_level_uq`
(`0067:491`)"* — adjusted to whatever `0081` actually seals, read from the sealed file rather
than from this request.

The **substance** of `P4-AL-22` is not changed by any of this and must not be: level
uniqueness is necessary and not sufficient, the sufficient mechanism is the COMMIT-time chain
verifier, each consumable source carries **both**, and the recorded cost at `:533-537` is the
one that authorises S6's replacement.

## Reason

An accepted-set enumeration is a thing readers check against the tree. While `0081` is a
candidate, the tree and the lock agree. The instant `0081` seals, they disagree, and the
disagreement is silent — a prose enumeration has no test, which is exactly how the
"27 → 30 → 32" class of drift that `docs/PHASE_4_S5_PREPARATION.md` §0 item 3 records being
structurally eliminated from the test estate survives in documents. Binding the update to the
seal commit is the only point at which the change is both correct and unmissable.

## Dependency

**Blocked on the `0081` seal**, by design. It cannot land before it without introducing the
defect it prevents.

## The test that requires it

None, and that is the honest answer — a prose enumeration has no test, which is precisely why
it is scheduled to a commit rather than left to a reader. The nearest mechanical check is
`docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §0, which states the enumeration **as a read**, with the
command that produced it and the accepted/candidate column above, so the next reader re-runs
it instead of trusting it.

## Expected semantic diff

One paragraph of one document, inside the `0081` seal commit. No code, no SQL, no test.
