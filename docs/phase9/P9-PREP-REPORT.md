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
| `tests/phase9-prep/p9-booking-spec.ts` | — | the spec loader and its non-vacuity guards |
| `tests/phase9-prep/p9-booking-world.ts` | — | the fixture, applied as `daftar_migrator` |
| `tests/phase9-prep/p9-race.ts` | — | the race harness: `pg_blocking_pids`, never a sleep |

**33 of 33 cases green**, over three suites, on a live PostgreSQL cluster.

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

## 4. LIMITATIONS — what this work does not establish

Stated as limitations rather than left to be discovered.

1. **These suites are not in required CI.** Adding a workflow step is owner-only (TD-08),
   and the work is `PREPARED / NOT PROMOTED`. A green run here is a record, not a gate. They
   are run with `npx vitest run tests/phase9-prep`.
2. **No migration number exists, and this work proposes none.** Until the Migration Owner
   allocates one, nothing in `docs/phase9/` is deployable. The DDL spec lives outside the
   migrations directory and is absent from the migration manifest by design.
3. **There is no command layer.** `booking_create`, `booking_cancel` and
   `booking_reschedule` are not written. The proofs drive the model through direct `INSERT`
   and `UPDATE` statements in the exact shape a command would use, including the advisory
   lock — which means **R-P9-11 is proven as an obligation the command layer must honour,
   not as something the schema can enforce**. A future writer that forgets the lock gets
   `40P01` instead of `23P01`; it does not get a double booking.
4. **Schedule containment is not enforced.** Whether a booking falls inside the resource's
   working hours, on that resource's own civil day, is a validation and belongs to the
   command slice. The input exists (`businesses.timezone`, IANA-validated at the database
   boundary), so this is a deferral and not a missing input.
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
