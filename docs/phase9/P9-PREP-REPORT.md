# P9 — PREPARATION REPORT

**Status: `PREPARED / NOT PROMOTED`** (master directive Part 9).

Nothing here is promoted, merged, or in required CI. No migration number is allocated and
no frozen migration is edited (Part 10). No Phase 4 file is touched and no Phase 4 branch is
pushed to (Part 42). Phase 9 is prepared on its own branch, on top of the sealed Phase 3
head of `main`.

---

## 1. What was built

| file | lines | what it is |
|---|---|---|
| `docs/phase9/P9-S0-SCOPE-AND-ARCHITECTURE.md` | 180 | the model, and why it has this shape |
| `docs/phase9/P9-BOOKING-DDL-SPEC.sql` | 1073 | the schema and its physical invariants — **not a migration** |
| `docs/phase9/P9-MIGRATION-PATCH-REQUEST.md` | 384 | what the Migration Owner is asked to allocate |
| `tests/phase9-prep/p9-booking-schema.test.ts` | — | 15 cases: shape, security, grants, end state |
| `tests/phase9-prep/p9-booking-concurrency.test.ts` | — | 11 proofs against real concurrent transactions |
| `tests/phase9-prep/p9-booking-negative-controls.test.ts` | — | 7 cases: each invariant removed, and the damage measured |
| `tests/phase9-prep/p9-booking-multi-resource.test.ts` | — | 8 cases: the global lock order (PART 50) and idempotent retries (PART 53) |
| `tests/phase9-prep/p9-booking-time.test.ts` | — | 13 cases: the timezone / DST law (PART 51) |
| `tests/phase9-prep/p9-booking-spec.ts` | — | the spec loader and its non-vacuity guards |
| `tests/phase9-prep/p9-booking-world.ts` | — | the fixture, applied as `daftar_migrator` |
| `tests/phase9-prep/p9-race.ts` | — | the race harness: `pg_blocking_pids`, never a sleep |

**54 of 54 cases green**, over five suites, on a live PostgreSQL 18.4 cluster.

The DDL spec is executable and **is executed**: the suites read it from its path, apply it
in one transaction as the non-superuser deployment principal `daftar_migrator` on top of the
sealed Phase 3 head, and then race real transactions against it. A spec that no parser and
no live server has had an opinion about is design, not engineering.

---

## 2. The invariant, and the proof that it is the thing doing the work

```sql
CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (business_id WITH =, resource_id WITH =, blocking_window WITH &&)
  WHERE (state IN ('booked', 'completed', 'no_show'))
```

**11 proofs with real concurrent transactions** (Part 39 — no `sleep()` as proof, no JS
simulation of a database race). Every wait is observed through `pg_blocking_pids` against a
separate observer connection, and every blocked count is asserted, so a proof cannot pass by
the racers never having contended:

1. two transactions on one slot → one commits, one `23P01`, the loser really blocked;
2. eight transactions on one slot → exactly one commits, seven `23P01`, seven blocked;
3. a **rolled-back** winner frees the slot — the loser's outcome is decided by what the
   winner did, not pre-judged by the test;
4. adjacency is not overlap: back-to-back bookings commit concurrently;
5. a booking inside the previous one's trailing buffer is refused under race;
6. the invariant is per resource: the same hour on a second chair commits;
7. a resource block and an appointment contend under the **same** index;
8. a cancellation releases the slot, and the rebooker blocks on the cancellation until it
   commits;
9. a reschedule onto an overlapping hour succeeds in **one** transaction, in the order the
   model requires (and `23P01` in the reverse order);
10. two businesses of one tenant book the same clock hour concurrently;
11. the invariant does not depend on the session timezone — proven across five zones,
    including a 30-minute and a 45-minute offset.

**7 negative controls** (Part 40 — for a critical guard, a red proof). Each one records
`pg_get_constraintdef` first, removes exactly one invariant, shows the attack **committing**,
restores it, asserts the restored definition is **character-identical**, and re-runs the
attack expecting the refusal:

| control | what is removed | what then commits |
|---|---|---|
| 1 | `bookings_no_overlap` | both racers' overlapping bookings |
| 2 | the constraint, replaced by a `SELECT`-then-`INSERT` trigger | a double booking, as soon as one writer forgets the lock |
| 3 | `bookings_blocking_window_ck` | a forged one-second window, on top of a full hour |
| 4 | the state predicate | a cancelled booking holds its hour for ever |
| 5 | the blocking window, replaced by the service window | an overlapping buffer |
| 6 | the resource lock | `40P01` instead of a refusal anyone can read |

and a closing case: the invariant survived every control, character for character.

The schema suite adds that it was built on Phase 3's sealed head and not on an unsealed
Phase 4 candidate, that the frozen history has no object dropped or replaced, that the whole
cluster contains exactly two exclusion constraints (the accounting-periods one and this
one), and that re-applying the spec is **refused atomically** rather than half-done.

---

## 3. What execution found that reading did not

Both of these were found by running the SQL, not by reviewing it. Both are recorded because
they are the reason the spec has the shape it has.

### 3.1 `blocking_window` cannot be a generated column — `42P17`

The first version made `blocking_window` `GENERATED ALWAYS AS (…) STORED`, which is the
obvious way to make it unforgeable. PostgreSQL refused the table:
**`42P17 invalid_object_definition`, "generation expression is not immutable"** —
`timestamptz - interval` is `STABLE`, not `IMMUTABLE`.

The fix is a plain stored column pinned by a CHECK. A `BEFORE` trigger that recomputes the
value was considered and **rejected**, because it would make the CHECK a guard that can never
fire — a dead guard, which is worse than no guard, since it reads as protection.

### 3.2 Two bookers racing on one slot deadlock — `40P01`

`PROOF 1` failed on roughly four runs in ten, always at about `deadlock_timeout`, with
`40P01 deadlock_detected` and **two** blocked transactions rather than one. This is a real
product defect, not a test artifact: each transaction inserts its own entry into the
exclusion index, then finds the other's and waits, so the two wait on each other.

**The data stays correct either way — exactly one booking exists.** What is wrong is the
error the loser gets: a deadlock, not "that time has just been taken". A UI cannot translate
`40P01` into anything a customer should read.

The fix is the project's own advisory-lock idiom: `booking_resource_lock_key(business,
resource)`, `IMMUTABLE STRICT`, taken with `pg_advisory_xact_lock` as the **first act** of
any transaction that will occupy a resource (R-P9-11, end-state check (g2)). The lock is per
`(business, resource)`, so chair A never waits on chair B. `CONTROL 6` constructs the mutual
wait deterministically and measures `40P01`, then shows the locked form giving one commit,
one `23P01`, and one observed wait.

Note what this does **not** change: the constraint is correct whether or not any writer
remembers the lock, and `CONTROL 2` measures exactly that difference. The lock decides which
error the loser sees; the constraint decides whether a double booking can exist.

---

## 3a. Directive #11 (PARTs 49–53), applied

PART 49 is the status this report already carries, unchanged: `PREPARED / NOT
PROMOTED`, no promotion before the roadmap predecessor, no migration number, and no
canonical CI claim. PARTs 50, 51 and 53 asked for work that did not exist; PART 52
asked for a property the model already had.

### PART 50 — the global lock order, and a premise measurement refuted

`booking_lock_resources(business, resources[])` takes a transaction's whole lock set
at once, sorted ascending by key and deduplicated, before any mutation. R-P9-11
serialized one resource, which a reschedule that *moves* a booking is not: that
touches two, and A→B crossing B→A deadlocks under per-resource locking for the same
reason the bare index did.

Three things were measured, and the first corrected the proof twice:

1. **A true swap of two occupied slots cannot be two independent reschedules.** Both
   sides are refused `23P01`, because each wants an hour the other has not released
   and neither can see the other's uncommitted release. The first version of the proof
   expected both to commit; the second expected one survivor; the server's answer was
   neither. That is a correct refusal, and the final state is the one already true —
   which is exactly PART 50's "no deadlock, one valid final state".
2. **A swap IS expressible, as one transaction** that performs both transitions before
   either insert. Proven to commit, with each hour held once.
3. **Under per-resource locking the same crossing gives `40P01`** — the negative
   control, with the cycle constructed rather than hoped for.

And two cross-resource reschedules that do not contend both commit under the one lock
set, which is what shows it serializes without refusing legal work.

### PART 51 — the timezone / DST law

`booking_resolve_local(zone, local, offset)` counts the instants that map back to the
stated wall clock: none means REFUSE, one resolves, more than one means REFUSE unless
the caller states which offset it means. Never the first occurrence by default.

**It exists because PostgreSQL's own `AT TIME ZONE` answers both broken cases
silently, and that was measured before any law was written.** An hour a
spring-forward skipped comes back as an instant an hour away from what was asked; an
hour a fall-back repeated comes back as one of the two with nothing to say it chose.
Both are negative controls.

Proven on both shift sizes that exist — `America/New_York`'s hour and
`Australia/Lord_Howe`'s thirty minutes — which is why the scan steps by one minute.
The resolver is `STABLE`, and the suite asserts both the volatility and that
PostgreSQL itself refuses to index the routine, so it can never be folded into an
index that would outlive the next tz database update.

### PART 52 — capacity

Already satisfied, and recorded here rather than changed: capacity greater than one is
multiple resource units, and there is deliberately no `capacity` integer, because an
exclusion constraint cannot express "at most N overlapping" and a column the physical
invariant cannot see is worse than no column. Aggregate capacity would need a new
architecture and its own concurrency proof.

### PART 53 — audit and idempotency

The command identity is the caller's `operation_id`, derived from no clock and no
sequence. Two concurrent transactions carrying the same `operation_id` produce exactly
one booking and one registry row; the loser is refused by the registry's primary key
(`23505`) or by the invariant (`23P01`). The registry is append-only in the trigger as
well as the grant. Cancellation and reschedule retain history, and the reschedule
proofs assert that no predecessor is left released with no successor.

Answering a replay **from the recorded row** rather than returning the duplicate-key
error is the command layer's obligation and is not built.

---

## 3b. Evidence classes (PART 15)

Stated in the only classes the directive allows, with nothing mixed and nothing
claimed in a stronger class than it was measured in.

| claim | class |
|---|---|
| the seven relations, their constraints, RLS, grants, ownership, end state | PROVEN BY DATABASE CATALOGUE |
| no double booking under race; the lock orders; DST refusals; idempotent retries | PROVEN BY TEST |
| each invariant is load-bearing (six red proofs, restored character-identical) | PROVEN BY TEST |
| the DDL spec as a deployable migration | **SPEC ONLY** — no number allocated |
| the command layer, schedule containment | **SPEC ONLY** — not written |
| these suites in required CI | **UNMEASURED** — owner-only (TD-08) |
| browser, UX, localization (PART 111) | **UNMEASURED** — no surface exists |
| performance | **UNMEASURED** — and no number from this container may be quoted |

A green run of `tests/phase9-prep` is a **record**, not a gate: the suites are not in
required CI, and a branch push is not CI (PART 15).

---

## 4. LIMITATIONS — what this work does not establish

Stated as limitations rather than left to be discovered.

1. **These suites are not in required CI.** Adding a workflow step is owner-only (TD-08),
   and the work is `PREPARED / NOT PROMOTED`. A green run here is a record, not a gate. They
   are run with `npx vitest run tests/phase9-prep`.
2. **No migration number exists, and this work proposes none.** Until the Migration Owner
   allocates one, nothing in `docs/phase9/` is deployable. The DDL spec lives outside the
   migrations directory and is absent from the migration manifest by design.
3. **There is no command layer.** `booking_create`, `booking_cancel` and
   `booking_reschedule` are not written. The proofs drive the model through direct
   `INSERT` and `UPDATE` statements in the exact shape a command would use, including
   the advisory locks — which means **R-P9-11 and R-P9-12 are proven as obligations the
   command layer must honour, not as something the schema can enforce**. A future
   writer that forgets a lock gets `40P01` instead of a readable refusal; it does not
   get a double booking. Likewise, answering an idempotent replay from the recorded
   registry row, rather than returning the duplicate-key error, is the command layer's
   job (PART 53) and is not built.
4. **Schedule containment is not enforced.** Whether a booking falls inside the
   resource's working hours, on that resource's own civil day, is a validation and
   belongs to the command slice. `booking_resolve_local` now settles the harder half —
   that resolving the merchant's wall clock is never a guess — but the comparison
   against `booking_resource_schedules` and `booking_resource_exceptions` is not
   written.
5. **Resource capacity greater than one is not modelled.** An exclusion constraint expresses
   "no two overlapping rows", not "at most N overlapping rows", and there is no declarative
   way to say the second. A room for six is six resources. There is deliberately **no**
   `capacity` column, because a column the physical invariant cannot see is worse than no
   column.
6. **`bookings.customer_id` carries no foreign key.** `customers` is a Phase 4 relation and
   Phase 4 is not sealed. The exact statement to add at promotion is §2 of the patch request.
   Until then, referential integrity for that one column is not enforced by the database.
7. **`daftar_booking_internal` is created by the test harness**, in exactly the statements
   §1 of the patch request asks for in `bootstrap.sql`. Until that patch lands, the role does
   not exist in a real deployment, and the spec's §0 refuses to apply rather than inventing
   it.
8. **No timing or performance claim is made.** Numbers from a preparation container are not
   comparable to anything, and none appears in any Phase 9 document. The one duration that
   mattered — the deadlock in §3.2 appearing at about `deadlock_timeout` — is reported as the
   diagnostic clue it was, not as a measurement of anything.
9. **No surface exists.** Admin UX, customer UX, the browser proof and the audit trail of
   Part 29 are not built. This track prepared the model the surfaces will stand on.
10. **The reschedule proof covers one transaction, not a crash between its two statements.**
    The model requires the new row and the predecessor's transition in one transaction, and
    the proof drives them that way; a partially applied reschedule is impossible by
    transaction semantics rather than by anything this work added.

11. **The proofs ran on top of the sealed Phase 3 head of `main`, not on top of the Phase 4
    candidates.** This is deliberate — the Phase 4 candidate migrations are unfrozen and may
    still change, so a proof against them would be invalidated by their next revision, and
    Part 42 keeps a future-phase track out of the Phase 4 integration tree. It is sound for
    this slice because the spec's only outward references are `users`, `businesses` and
    `branches`, all Phase 1–2 relations far below the frozen boundary; it depends on no Phase
    4 relation. The one coupling that does exist is the `customers` foreign key, and it is
    already deferred to promotion (§2 of the patch request). The Migration Owner will apply
    this slice after the Phase 4 candidates, and when Phase 4 is sealed these suites can be
    re-run against that head unchanged to confirm it.

12. **The local-time scan is bounded to ±180 minutes** around PostgreSQL's own
    answer. Every transition in the IANA database is far inside that bound, but a zone
    whose offset moved by more than three hours at once would resolve as "does not
    exist" rather than being found. Refusing is the safe side of the bound, and that is
    the side this lands on.
13. **The DST cases depend on the server's tz database**, so the suite asserts the
    occurrence counts of its four moments from the server before relying on them. A tz
    update that moved a rule reds the suite rather than silently making its proofs
    vacuous — but it does red it, and that is maintenance this work hands forward.
14. **The lock-set collision case is reasoned, not measured.** Two distinct resources
    hashing to one key would merge their locks, which broadens exclusion and cannot
    narrow it; no fixture constructs such a collision, because constructing one against
    `hashtextextended` is not something a proof can do honestly at this size.

---

## 5. Compliance

* Part 0 — nothing was killed, reset, discarded, force-pushed or rewritten. This container
  is a clean checkout of `main` at the sealed Phase 3 head.
* Part 9 — `PREPARED / NOT PROMOTED`, on its own branch.
* Part 10 — no number allocated, no frozen migration edited, a patch request submitted
  instead. The patch request names no migration number and no migration filename.
* Part 11 / Part 12 — no money column anywhere, and the end-state block fails the deployment
  if one ever appears.
* Part 13 — `FORCE ROW LEVEL SECURITY` on all seven, composite ownership FKs throughout,
  nothing granted to `PUBLIC`.
* Part 39 — real concurrency only. Every wait observed through `pg_blocking_pids`; no sleep
  is used as proof and no JavaScript simulates a database race.
* Part 40 — every subject asserted to exist before it is removed; every mutation shown to
  have landed; every control's restoration asserted character-identical; no skipped case
  counted as green.
* Part 50 — the proofs ran against the spec file on disk at the commit this report is
  committed with, applied by the real path, not against a copy or a description of it.
* Part 83 — this is not "done". It is prepared, and §4 says exactly what it is not.
