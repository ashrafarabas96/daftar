# P9 — RETENTION AND ERASURE: WHAT IS PREPARED FOR THE OWNER'S DECISION

**Status: `PREPARED / NOT PROMOTED`. Nothing in this document is implemented.**

The Master Continuous Mission V2 records booking retention duration and any erasure path
as an **OWNER-ONLY open decision**, and is explicit about three things this document is
built around:

* the present absence of a `DELETE` path protects history in preparation, but is **not
  legal approval for indefinite retention**;
* the booking record, the operation registry and the reschedule backlinks may **never** be
  dropped in order to solve retention;
* the separation of personal content from facts, and the policy alternatives, are to be
  **prepared for review** — with no invented window and no guessed erasure. Activation
  that depends on the policy stays blocked until the owner rules; the command work
  continues around it.

---

## 1. What is a FACT here, and what is PERSONAL CONTENT

This separation is the part that can be designed before the policy exists, because it does
not depend on the answer. It is written as a reading of the relations as they stand today.

**Facts — the occupancy record.** These are what the invariant, the audit trail and any
later accounting rest on, and none of them identifies a person on its own:

* `bookings`: the business, branch, resource, service, window, buffers, `blocking_window`,
  state, `rescheduled_from_id`, `intent_sha256`, and the timestamps.
* `booking_operations`: the whole row — it is command identity, not customer data.
* The schedule, exception, eligibility, service and resource relations: no personal content
  at all.

**Personal content — who the appointment is with.** In Phase 9 as it stands this is
`bookings.customer_id`, a reference whose personal data lives in the Phase 4 `customers`
relation, plus `created_by_user_id` and `settled_by_user_id` — read off the relation, not
recalled — which are staff identities and are evidence of who acted rather than customer
data.

**The consequence, and it is the useful one:** Phase 9 stores almost no personal content of
its own. A customer-erasure policy is therefore mostly a Phase 4 question about `customers`,
and Phase 9's obligation is to keep working — invariant, audit, replay — when the identity
behind `customer_id` is gone. Every option below is shaped by that.

---

## 2. The options, as alternatives rather than a recommendation disguised as one

Each is stated with what it costs, because the trade is the decision.

### Option A — Retain everything, erase nothing (what the schema does today)

Nothing is deletable by any principal; cancellation is a state; the registry is append-only.

* **For:** no record can be lost by accident; the audit trail and the replay answer remain
  true forever; nothing to build.
* **Against:** it is a prep-time state and **not an approved policy**. It has no answer to a
  lawful erasure request, and "we cannot" is not an answer a policy can give.

### Option B — Erase the person, keep the fact (pseudonymisation at the customer)

`customer_id` continues to point at a `customers` row whose personal fields have been
cleared or replaced by the Phase 4 erasure path. Phase 9 changes nothing.

* **For:** the occupancy record, the invariant, the audit trail and the replay all survive
  untouched; the booking history stays readable as "this chair was occupied then".
* **Against:** it is not Phase 9's to build — it belongs to whoever owns `customers`, and
  Phase 9 can only state the requirement that it must not break the composite FK.
* **What Phase 9 would owe:** nothing structural. A test that a booking whose customer has
  been pseudonymised still reads, still blocks its slot, and still replays.

### Option C — Detach the person, keep the fact (null the reference after a window)

After a retention window, `bookings.customer_id` is set to NULL on terminal bookings.

* **For:** Phase 9 can enforce it itself; the slot history survives in full.
* **Against:** it needs `bookings_kind_shape_ck` relaxed for historical appointments, which
  weakens a shape constraint that currently cannot be forged, and it needs an UPDATE path on
  a relation whose columns are frozen after insert. **That is a real cost and it is why this
  is not recommended lightly.**
* **What Phase 9 would owe:** an explicit terminal-only transition, a new refusal for doing
  it to a live booking, and a red proof that the relaxed CHECK cannot be used to create a
  customerless appointment in the first place.

### Option D — A retention window with a hard cut

Bookings older than N are removed entirely.

* **Against, and this is a refusal rather than a trade:** it contradicts the Mission's own
  instruction that the record, the registry and the backlinks may not be dropped to solve
  retention. It also silently breaks the registry's FK and makes a replay answer a booking
  that no longer exists. **Documented so the option is visibly closed, not so it can be
  chosen.**

---

## 3. What the owner is actually being asked

Two questions, and only the owner can answer them:

1. **Is there a retention period at all**, or is the record kept for as long as the business
   exists?
2. **Which erasure shape** — the person erased at `customers` with the booking fact intact
   (Option B), or the reference detached inside Phase 9 after a window (Option C)?

Until both are answered: **nothing is deleted and nothing is built.** The fail-closed
default is Option A, named here as a default and not as a policy. No window is invented, no
erasure path is guessed at, and the booking record, the registry and the backlinks stay
whole whatever is decided.
