# P9-S0 — SCOPE AND ARCHITECTURE: Universal Booking and Services

**Phase:** 9 (master directive Part 29).
**Status:** `PREPARED / NOT PROMOTED` (Part 9).
**Base:** the sealed Phase 3 head on `main`. No Phase 4 file is touched, no Phase 4 branch
is pushed to, and no migration number is allocated (Part 10, Part 42).

---

## 1. The one thing this phase is about

A resource can be booked by two people at the same instant, and whichever mechanism
prevents that is the whole phase. Everything else — services, calendars, exceptions,
rescheduling, admin and customer surfaces — is scaffolding around that single rule.

So S0 settles the rule before anything is built:

> **Overlap is prevented by a physical database invariant, never by application logic and
> never by a trigger that looks for a conflict.**

This is R-P9-01, and it is not a preference. The project already settled it once, for
accounting periods: two concurrent transactions can both `SELECT`, both find nothing, and
both `INSERT`. A `SELECT`-then-`INSERT` check is *correct in isolation and wrong under
concurrency*, which is the worst failure shape there is — it passes every serial test.

The mechanism is therefore an **exclusion constraint**, and the preparation work exists to
prove that the constraint is the thing doing the work.

---

## 2. The model, and why it has this shape

### 2.1 Two kinds of occupancy, one table

An appointment and a resource block (a holiday, maintenance, a lunch break) occupy a
resource identically. They therefore live in **one** relation, `bookings`, distinguished by
`kind`, because the invariant must see both with one index.

Two tables would need a trigger to compare them — and that trigger would lose exactly the
race R-P9-01 names: a block and an appointment inserted concurrently could both look, both
find nothing, and both commit. The single table is a consequence of the rule, not a
modelling convenience (R-P9-05).

### 2.2 Two windows, and the index holds the wider one

A booking has a **customer-facing** span (`starts_at`, `ends_at`) — what the customer
agreed to — and an **occupying** span, the same times widened by the service's set-up and
clean-up buffers. The exclusion constraint looks at the occupying span, `blocking_window`,
because that is what the resource is actually unavailable for (R-P9-02).

The window is **half-open** (`'[)'`), so a 10:00–11:00 booking and an 11:00–12:00 booking
are adjacent, not conflicting (R-P9-04). Closed ranges would refuse every back-to-back
appointment in the business.

### 2.3 The window is stored, and pinned

`blocking_window` is a stored `TSTZRANGE` whose value is pinned to the columns it derives
from by a CHECK. It is **not** a generated column: PostgreSQL refuses
`timestamptz - interval` in a generation expression, because that arithmetic is `STABLE`
and not `IMMUTABLE` (`42P17`). This was measured, not assumed.

A `BEFORE` trigger that recomputes the column instead is also rejected, for a different
reason: it would make the CHECK a guard that can never fire — a dead guard. Leaving the
value to the caller and pinning it with a CHECK keeps the refusal real (`23514`), and the
command layer builds the range in the same expression the CHECK states (R-P9-03).

Why this matters: without the pinning CHECK, the exclusion constraint guards a value *the
client chooses*. A caller forges a one-second window and books on top of a full hour. That
is measured as a negative control, not asserted.

### 2.4 The buffers belong to the service, and are copied onto the booking

Buffers are a property of the work, not of one appointment — a haircut needs ten minutes of
clean-up whoever books it — so they live on `booking_services`. They are **copied** onto
each booking at INSERT, and the copy is what the invariant reads (R-P9-07).

The copy is deliberate: a later edit to a service must not silently move an appointment a
customer already agreed to. A deferred constraint trigger checks the copy against the
service at commit, so a row cannot be written with buffers that were never the service's.

### 2.5 The state predicate is the release mechanism

The exclusion constraint is **partial**: it applies to `booked`, `completed` and `no_show`.
Those three occupy the resource — the first is standing, the other two are history a second
booking must not be written over. `cancelled` and `rescheduled` released it, so the index
must forget them. Without the predicate a cancelled appointment holds its hour for ever,
which is the whole cancellation feature failing silently.

A cancellation is therefore nothing more than a state transition, and a reschedule is a new
row plus a transition on the old one, in one transaction (R-P9-08).

### 2.6 Availability describes; it does not enforce

`booking_resource_schedules` (the recurring week) and `booking_resource_exceptions` (dated
overrides) describe when a resource is **offered**. They are not in the invariant's path. A
closure that must physically hold time against bookings is a `resource_block` row in
`bookings` — the same table, the same index (R-P9-05). Marking a day closed does not evict
a booking already standing on it, and the model says so rather than implying otherwise.

### 2.7 Eligibility is declarative

Which resource may perform which service is a relation, `booking_service_resources`, whose
primary key exists to be a **foreign-key target**. Every appointment's
`(business_id, service_id, resource_id)` triple references it, so eligibility is a
declarative property of the row rather than a trigger (R-P9-06). `MATCH SIMPLE` means a
resource block, which has no `service_id`, is simply out of scope for the check.

### 2.8 Rows are never deleted, and almost nothing is mutable

A `BEFORE DELETE` trigger refuses every delete. A `BEFORE UPDATE` trigger freezes
everything except `state` and its settlement metadata: the window, the resource, the
service, the customer, the buffers, the creator and the creation time are immutable after
INSERT. A booking's history is the record; the four settlement states are terminal and none
of them reopens.

### 2.9 Serialization: a refusal a human can read (R-P9-11)

Two bookers racing on the same slot *without* a lock each insert their own entry into the
exclusion index, then each find the other's and wait. The pair deadlocks, and PostgreSQL
resolves it with `40P01 deadlock_detected`.

The data stays correct — exactly one booking exists either way — but a deadlock is not a
refusal a UI can translate into "that time has just been taken". So the command layer takes
`pg_advisory_xact_lock(booking_resource_lock_key(business, resource))` as the first act of
any transaction that will occupy a resource, in the project's own advisory-lock idiom. The
second transaction then queues, and is refused with `23P01`.

The key is per `(business, resource)`: chair A never waits on chair B, and a booking in one
business never waits on another business at all.

**This is a convenience, and the model does not depend on it.** That is the point of the
separation: the constraint is correct whether or not any writer remembers the lock. The
lock only decides *which error* the loser sees.

### 2.10 No money, anywhere

Part 11: one financial truth. There is no price, tax or amount column in any of the seven
relations, and a booking that bills posts through the canonical sales/accounting authority.
The end-state block fails the deployment if a money-shaped column ever appears, because the
one place to notice a second financial truth is before it ships.

---

## 3. Security

All seven relations: `ENABLE` **and** `FORCE ROW LEVEL SECURITY`, a permissive tenant
policy plus restrictive per-command business policies, through the existing
`app_tenant()` / `app_business()` / `app_bypass()` helpers. Every ownership FK is composite
`(tenant_id, business_id)`, so a row cannot point at another business's parent.

No runtime login role may write any of the seven. Writes go through the internal authority
`daftar_booking_internal`, which is `NOLOGIN`, `NOINHERIT` and `NOBYPASSRLS`, holds no
`DELETE` on anything and no `UPDATE` on the command registry, and whose
`CREATE ON SCHEMA public` authority is revoked before the spec ends — with the end-state
block refusing to commit if it survived. `PUBLIC` holds nothing, on any relation or
routine, and no runtime role may execute the definer guard or the lock-key routine.

---

## 4. What S0 deliberately leaves to later slices

| | what | why it is deferred and not a gap |
|---|---|---|
| S2 | the command layer (`booking_create`, `booking_cancel`, `booking_reschedule`) | needs a booking authority assertion and its key — its own slice. The grants already put every runtime role where that layer needs it, so it adds routines and changes no grant. |
| S2 | schedule containment (is this booking inside working hours, on that resource's own civil day?) | a **validation**, not a concurrency invariant. Two concurrent bookings both outside hours are two independently wrong rows; two on the same hour are one corrupted resource. The input exists (`businesses.timezone`, IANA-validated at the database boundary). |
| S3+ | admin UX, customer UX, browser proof, audit | surfaces over a model that must be correct first. |
| — | resource capacity greater than one | an exclusion constraint cannot express "at most N overlapping". A room for six is six resources. Deliberately **not** a `capacity` column the invariant cannot see. |
| promotion | the `customers` foreign key | Phase 4 is not sealed; the exact statement is in §2 of the patch request. |

---

## 5. Deliverables of this preparation track

| file | what it is |
|---|---|
| `docs/phase9/P9-S0-SCOPE-AND-ARCHITECTURE.md` | this document |
| `docs/phase9/P9-BOOKING-DDL-SPEC.sql` | the schema and its invariants — executable, executed, carrying no migration number |
| `docs/phase9/P9-MIGRATION-PATCH-REQUEST.md` | what the Migration Owner is asked to allocate, naming no number |
| `docs/phase9/P9-PREP-REPORT.md` | what was measured, what was found by execution, and the limitations |
| `tests/phase9-prep/` | 33 cases over three suites: schema, real concurrency, negative controls |
