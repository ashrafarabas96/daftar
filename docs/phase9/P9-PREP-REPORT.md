# P9 — PREPARATION REPORT

**Status: `PREPARED / NOT PROMOTED`** (master directive Part 9). On the Mission's ladder the
rung is **`CHALLENGED`** — an independent challenger passed the work at `9a64289` with no
open finding (§3c.14) — and a challenger PASS is not a promotion; see §3c.7.

Nothing here is promoted, merged, or in required CI. No migration number is allocated and
no frozen migration is edited (Part 10). No Phase 4 file is touched and no Phase 4 branch is
pushed to (Part 42). Phase 9 is prepared on its own branch, on top of the sealed Phase 3
head of `main`.

---

## 1. What was built

| file | lines | what it is |
|---|---|---|
| `docs/phase9/P9-S0-SCOPE-AND-ARCHITECTURE.md` | 212 | the model, and why it has this shape |
| `docs/phase9/P9-BOOKING-DDL-SPEC.sql` | 1583 | the schema and its physical invariants — **not a migration** |
| `docs/phase9/P9-MIGRATION-PATCH-REQUEST.md` | 521 | what the Migration Owner is asked to allocate |
| `docs/phase9/P9-HANDOFF-MANIFEST.md` | 131 | the PART 13 handoff gate, with a SHA256 per artifact |
| `tests/phase9-prep/p9-booking-schema.test.ts` | 304 | 17 cases: shape, security, grants, end state, the state contract, collation independence |
| `tests/phase9-prep/p9-booking-concurrency.test.ts` | 407 | 11 proofs against real concurrent transactions |
| `tests/phase9-prep/p9-booking-negative-controls.test.ts` | 588 | 7 cases: each invariant removed, and the damage measured |
| `tests/phase9-prep/p9-booking-multi-resource.test.ts` | 736 | 10 cases: the global lock order (PART 50), idempotent retries and the replay (PART 53) |
| `tests/phase9-prep/p9-booking-time.test.ts` | 621 | 21 cases: the timezone / DST law (PART 51), its soundness sweep, the measured ±1440 scan at one-day granularity, and the two defects V3 named |
| `tests/phase9-prep/p9-booking-integrity.test.ts` | 399 | 7 cases: the closure record is write-once (R-P9-15) — the three defects the challenger found, the challenger's own (a4) probes behind each dropped CHECK, and the non-vacuity that keeps the guard honest |
| `tests/phase9-prep/p9-booking-runtime-attack.test.ts` | 350 | 10 cases: the schema attacked as the real runtime roles, no superuser |
| `tests/phase9-prep/p9-booking-spec.ts` | 206 | the spec loader, the state contract parser, and the non-vacuity guards |
| `tests/phase9-prep/p9-booking-world.ts` | 277 | the fixture, applied as `daftar_migrator` |
| `tests/phase9-prep/p9-race.ts` | 142 | the race harness: `pg_blocking_pids`, never a sleep |

**83 of 83 cases green, EXIT CODE 0, on the approved target — PostgreSQL 16.15 at `en_US.utf8`, under Node v24.21.0**
— over seven suites, and again on PostgreSQL 18.4 at `C` as the comparison the mission permits.
A case count is
not progress and is not quoted as any (Mission, cross-phase): it says how much was measured,
not how much of Phase 9 exists.

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

Answering a replay **from the recorded row** is now built and proved, not deferred — see
§3c.3.

---

## 3c. The Master Continuous Mission (Phases 4→15), applied

Seven Phase 9 items arrived after the sections above. Each one is answered here, and two
of them changed the build rather than the prose.

### 3c.1 The customer key comes from sealed Phase 4 — VERIFIED, not assumed

`customers` carries `PRIMARY KEY (business_id, id)` in frozen migration `0075`, which is
inside the frozen boundary (`0000`–`0079`). The composite FK the patch request asks for at
promotion is therefore the shape the sealed phase actually offers, and it matches the
project's own `payments_customer_fk`. This was read off the frozen file, not inferred from
the Phase 4 branch's working state.

### 3c.2 The occupancy states come from the contract, not from guessing

«حدد حالات شغل المورد من العقد، دون تخمين». The DDL header carries one machine-readable
line, `P9-STATE-CONTRACT`, and the suites DERIVE both lists from it. The loader
cross-checks that line against the exclusion constraint's own predicate and against
`state`'s `CHECK` list, and refuses to run if they disagree or if a state exists that the
line does not classify — so a sixth state cannot be added without a decision about whether
it holds the resource. Four mutations of the document each red the loader by name, and each
mutation is asserted to have landed before its refusal is believed (PART 17).

### 3c.3 A uniqueness constraint is not replay proof — the recorded result is returned

«تعيد المحاولة المتكررة النتيجة المسجلة. قيد التفرّد المانع للتكرار وحده ليس برهان نجاح
replay». The registry's primary key only establishes that no second booking exists; the
caller holding the refusal still has no booking id, and the SQLSTATE it received is an
accident of which constraint its statements reached first (measured: `23P01` when the whole
request is re-sent, `23505` when only the registry row is left to refuse it).
`booking_replay_result` (R-P9-14) returns the booking the **first** attempt produced, read
by `(business_id, operation_id)`; PROOF 15 measures both retry routes and then asserts the
replay returns the winner's id, that the id names a booking that really stands on the
resource and instant asked for, that the retry's own id is not a booking, and that asking
twice gives the identical answer down to the recorded instant. PROOF 16 adds the refusals
that keep an idempotency key from answering a *different* request: a recorded op code or
intent digest that disagrees is `booking.operation_conflict` /
`booking.operation_intent_conflict`, and an unknown key is reported as a first attempt
rather than as an error.

### 3c.4 The runtime is not a direct writer — proved by executed attack, not by catalogue

«لا إثبات نواة أو كتالوج بدل هجوم منفذ». `p9-booking-runtime-attack.test.ts` connects as
each of the six real runtime roles with no superuser anywhere, sets the tenant and business
GUCs the way a request does, and EXECUTES the writes: every INSERT on all seven relations,
and UPDATE and DELETE against a booking that really exists, come back `42501` and the row
survives. It also proves what the roles *may* do (a merchant reads its own calendar), so the
refusals are a boundary and not a blanket denial, and that RLS applies to the internal
authority itself: a cross-business INSERT as `daftar_booking_internal` is refused by policy
while the same row in its own business is accepted.

**This suite found a real hole in work written an hour earlier.** The first version of
`booking_replay_result` relied on row security for business isolation. §8's read policies
exempt `daftar_booking_internal` by name — and that is the only principal allowed to execute
the routine — so with the business as a parameter, the lookup answered a sibling business's
operation id with that sibling's booking id. The cross-business case returned the row; the
boundary now lives in the routine and fails closed (`booking.replay_scope_mismatch`, also
for an unscoped caller). The lesson is the one this phase keeps re-learning: a law that
names its premise must read it, and RLS is not a premise a routine may assume on behalf of a
principal RLS deliberately exempts.

### 3c.5 Thirteen DST cases do not prove all dates and zones — so the scope is written down

The scope `booking_resolve_local` claims is stated in the DDL beside the routine: any IANA
zone the server knows, a finite wall clock, a transition of at most ±180 minutes, and an
offset that the stated wall clock actually has. Everything outside it is REFUSED by name
rather than guessed — including `±infinity`, which the earlier version reported as
*ambiguous*: a refusal that said something false about why, found while writing this scope
and now `booking.local_time_not_finite`. The SOUNDNESS property is swept rather than
sampled: over 14 000 inputs across ten transition days in two zones, every instant the
routine returns maps back through its zone to exactly the wall clock asked for, with an
oracle (the round trip) independent of the candidate counting the routine decides by — and
a control shows PostgreSQL's own `AT TIME ZONE` failing that same sweep.

### 3c.5a The bound itself, measured (Mission V2)

V2 asked for the resolver's real bound against the lawful IANA transition, and for no claim
left wider than its evidence. The ±180-minute scan is now measured over every zone the
measuring server knows — 499 on the approved PostgreSQL 16 target, 598 on the PG 18.4
comparison container, a tzdata-build fact and not a property of the law (C-P9-05) — in
both directions separately, because they fail differently:
2024–2030 (the window bookings live in) has a widest transition of 120 minutes either way,
while 1970–2040 contains a 1440-minute date-line move and a 420-minute repeat. A gap wider
than the bound is still refused — proved on Kwajalein's skipped day — but a repeat wider
than it would be resolved silently, which is the one thing R-P9-13 exists to prevent.
LIMITATION 12 now says exactly that, and the sentence it replaces was wider than its
evidence.

**V3 then went one step further, and it was right to.** Documenting a limitation is not the
same as fixing it: a repeat wider than the bound was still being resolved silently in the
historical range, and "bookings are future-dated" is a mitigation, not a law. V3 asked for
the supported range to be declared with an enforced guard and for the claim **or the
algorithm** to be fixed. Both were fixed — §3c.10.

### 3c.6 Retention — the rules that ARE approved, and the one that is not

The rules the schema enforces today, which need no owner decision because they follow from
laws already in force:

* **Nothing is deleted.** No principal holds `DELETE` on any of the seven relations, and
  `bookings` carries a raise-only `BEFORE DELETE` trigger behind that missing grant.
* **Cancellation is a state, not a removal.** A cancelled or rescheduled booking keeps its
  row, its window and its intent digest; it stops occupying the resource because the
  exclusion predicate stops matching it, not because anything was erased.
* **A reschedule keeps both halves.** The predecessor is transitioned and the successor
  carries a backlink to it, so the history of a moved appointment is readable in both
  directions.
* **The operation registry is append-only** in the grant (`SELECT, INSERT` only) and again
  in a trigger, so a recorded command identity cannot be rewritten or removed — which is
  what makes a replay answerable years later.

What is NOT approved, and is therefore not built: **the retention PERIOD, and any erasure
path at all** — a merchant's right-to-erasure request, an archival cut-off, a purge of
bookings belonging to a closed business. Those need an owner ruling (they trade a customer's
erasure right against an append-only financial-adjacent history), and the fail-closed
default this work ships is **retain indefinitely, erase nothing**, because a schema with no
delete path cannot lose a record by accident. Recorded as an open decision in the handoff
manifest; Phase 9 proposes no retention window of its own.

### 3c.7 The status ladder

The Mission's ladder is `PREPARED → CHALLENGED → READY_TO_PROMOTE → PROMOTION_IN_PROGRESS →
ACCEPTED / SEALED`. Phase 9 stands at **`CHALLENGED`**, and not one rung further. That rung
was granted rather than claimed: an independent challenger ran three times and passed the
work at `9a64289` with no open finding (§3c.14), after seven findings across three rounds.
It remains true, and worth repeating, that every case in this report was written by the
author of the thing it tests — the challenger's own probes are its own, and its report says
which numbers are the author's. `READY_TO_PROMOTE = NO`, because the roadmap predecessor is
not sealed, no migration number exists, the `customers` FK and the `bootstrap.sql` patch are
owed to their owners, the retention period is the owner's, PART 7.6's Node 24 rerun from
this phase's own container is owed, and one signature of the three — the coordinator
actual-diff review — is still owed. The D11 PART 117 label for the same state is
`PREPARED / NOT PROMOTED`; it names the promotion state, not the ladder rung, and this
report uses both so neither vocabulary has to be guessed at.

### 3c.15 The COORDINATOR's actual-diff review of `51626e1..9a64289`, and its seven scope items

PART 15's chain is AUTHOR → INDEPENDENT CHALLENGER → COORDINATOR ACTUAL-DIFF REVIEW. The
third is now given: **COORDINATOR-ACCEPT-WITH-SCOPE** over the five commits
`bcfb4fb`, `5f15601`, `76ab277`, `e1b201e`, `9a64289` against `main` at `6fc505d`. Report:
`/mnt/project-files/phase9/P9-COORD-DIFF-REVIEW-9a64289.md`, digest
`bc8fcfa4f13545c92036dc864e2bacb9175fe8e4783aaa6a21afe66c6286443c`.

**It was static and read-only — no database, no test run — and says so in its own method
line**, because its container also ships Node v22.22.0. Every count in it is attributed to
the author or to the challenger by name. What it checked and accepted: all eight challenger
findings fixed in code, scope clean, nothing under `migrations/`, no migration number
assigned, no new grant, policy or role. Its verdict names `9a64289`; `2d10117`, the
documentation commit recording the challenger's PASS, was not reviewed.

Its seven scope items, each closed here — documentation and tests only, no `src/` and no DDL
change beyond the two items it asked be *recorded*:

1. **§3c.7 still said "no challenger has run".** Already corrected at `2d10117`, which the
   review had not seen. §3c.7 now states the rung as `CHALLENGED` and keeps the part that is
   still true: every case in this report was written by the author of the thing it tests.
2. **"All seven are committed" contradicted the artifact table, and Node 24's coverage had
   two accounts.** The count was corrected at `2d10117` (and is now nine). The second
   account was a stale clause on the round-2 paragraph — "this round has not been
   challenged" — true when written and false once round 3 ran; it now records that round 3
   confirmed the fix there, and the Node 24 coverage is stated once, in one place.
3. **Three comments named a constraint that does not exist.** `bookings_settle_shape_ck` for
   `bookings_settled_shape_ck`, in the spec and twice in the integrity suite. Corrected. A
   comment naming a constraint that is not there is worse than no comment: a reader checking
   the claim finds nothing and cannot tell whether the guard or the note is wrong.
4. **(a3) had no case for a lone `settled_at` or a lone `settled_by_user_id`.** Added to the
   standing-booking case, each refused by name. Worth saying why the name matters here:
   `bookings_settled_shape_ck` would refuse both as well, and the trigger fires *before* the
   constraint, so a case that accepted any failure would have passed on the CHECK and proved
   nothing about (a3).
5. **The challenger's three (a4) probes were not in the suite.** Promoted, as a case of their
   own: it captures each shape CHECK with `pg_get_constraintdef`, drops it, closes a booking
   with an **empty** settlement record (with `bookings_reschedule_shape_ck` gone, as
   `'rescheduled'` with a NULL forward link), shows the late write still refused by name,
   then discards the probe rows and restores the constraint — and asserts the restoration.
   The first version of that case failed on the restore with `23514`, because the rows it had
   just created were the ones the CHECK forbids; a case that weakens the schema and cannot
   put it back is worse than the hole it tests for, so the discard step is measured, not
   assumed.
6. **Two things to record, not fix.** `booking.state_not_reopenable` cannot fire — block
   (b)'s first clause refuses every change out of a terminal state first — and R-P9-15 binds
   UPDATE only, so nothing refuses an INSERT that arrives already closed. Both are
   command-slice questions: which refusal a caller should see is an error contract, and
   whether a booking may be born closed has different answers for an import, a historical
   migration and a live cancellation. Recorded as limitations 18 and 19 and as comments at
   block (b), deliberately not collapsed — fixing either under a review's scope would decide
   a contract silently.
7. **This phase's own Node 24 run.** Done, and it is this phase's first: the container ships
   v22.22.0, so Node **v24.21.0** was fetched from nodejs.org into the session scratch
   directory and the suite was run under it against the same PostgreSQL 16.15 at
   `en_US.utf8`. Both runs are in the run log with their run ids, commands and exit codes.
   PART 7.6's rerun is therefore no longer owed on the database half or the runtime half.

**The run after these items.** `tests/phase9-prep`, 7 files, **83 of 83 cases, exit code 0**,
on PostgreSQL 16.15 at `en_US.utf8` under **Node v24.21.0**, and again under v22.22.0 on both
16.15 and 18.4. (83, not the 84 this paragraph first said: the two (a3) probes are assertions
inside the existing standing-booking case, not cases of their own, and only the promoted (a4)
probes added a case. The number is what the runner printed.)

### 3c.14 The challenger's THIRD pass at `9a64289` — PASS, and what a PASS is not

The independent challenger re-ran the work a third time, at `9a64289` (code `e1b201e`; it
verified for itself that the diff between them touches only the manifest, so its run
exercises the stated subject). Verdict: **PASS, no open finding.** Report:
`/mnt/project-files/phase9/P9-CHALLENGE-9a64289.md`, digest
`9fe72d8f3f0337732cf32e251a5365a4a35eda7959fb8c42c00d20d19c3611d9`.

Its run, which is now also **this subject's Node 24 evidence**: run id
`P9-CHALLENGE-R3-20261012T152915Z`, Node **v24.12.0**, PostgreSQL **16.15** at
`en_US.utf8`, the spec applied by the non-superuser `daftar_migrator`, one vitest process
against a cluster it `initdb`-ed fresh at port 54401 — whose log shows **zero recovery
events**, which also answers this phase's disclosure that its own PG 16 cluster had crashed
and WAL-recovered between rounds. **82 of 82, exit code 0**, with the same tz numbers this
phase measures (gap 1440, repeat 420 at Antarctica/Vostok, 499 zones × 47 483 samples) and
all **eight** manifest digests verified byte-exact.

**It did not read (a2)/(a3)/(a4) — it dropped the constraints that hide them.** A refusal
test that passes on whichever constraint fires first proves nothing, so each probe removed
the masking CHECK before reaching the guard beneath it. With `bookings_settled_shape_ck`
dropped, a booking closes with an **empty** settlement record, and a later write to
`settled_at` or `settled_by_user_id` is still refused by name; with
`bookings_reschedule_shape_ck` dropped, a booking closes as `'rescheduled'` with a NULL
forward link, and the late link is still refused. So (a4) is a real guard and not a shadow of
the CHECKs — which is the one thing the author could not establish about their own fix, since
the author wrote the fix and the CHECKs both.

**Seven findings across three rounds, all discharged.** One P1 and two P2s in round 1, a P2
and a provenance item in round 2, nothing in round 3. On the Mission's ladder this moves the
work from `PREPARED` to **`CHALLENGED`**, which is the only rung a challenger can grant.

**PASS IS NOT PROMOTE, and the challenger says so in its own words.**
`READY_TO_PROMOTE` remains **NO**, for reasons that were never the challenge's business and
have not moved: the roadmap predecessor is unsealed, there is no migration number, the
`customers` foreign key and the `bootstrap.sql` role patch are owed to their owners, the
retention period is the owner's decision, and PART 7.6's Node 24 rerun **from this phase's
own container** is owed at final integration — an independent challenger's Node 24 run
satisfies the evidence question, not the process one. The signature covers the schema, the
triggers, the replay path, the DST resolver, tenant isolation without superuser, and the
suite's execution at this SHA on the deploy-target runtime. It does not cover CI, the API
layer, or parallel confirm, and PART 114's coordinator actual-diff review is still not given:
two of three signatures, not three.

### 3c.13 The challenger's SECOND pass at `76ab277` — PASS-WITH-SCOPE, and the residual closed

The same independent challenger re-ran the work at `76ab277` in its own container, on
PostgreSQL 16.15 at `en_US.utf8` under **Node 24.12.0**, and re-planted every mutation rather
than reading the answers. Verdict: **PASS-WITH-SCOPE**, 81 of 81 with exit code 0, all six
round-1 findings confirmed fixed, and **one residual P2**. Its report is
`/mnt/project-files/phase9/P9-CHALLENGE-76ab277.md`.

**The Node 24 run is the challenger's, not this phase's.** Its re-run was on 24.12.0 at this
subject's parent SHA, so Node 24 behaviour now has an independent measurement. That is cited
as the challenger's measurement. PART 7.6's rerun *from this phase's own container* is still
owed: the container ships 22.22.0.

**The residual: R-P9-15's words were wider than its code.** Guard (a2) refused a REWRITE and
(a3) refused a write to a STANDING booking. Between them they left the one shape that
matters most — a field still NULL on a booking that is **already closed**, written later. The
shape CHECKs hide most of it by accident: `settled_at` and `settled_by_user_id` must be
non-NULL at close, and the forward link is forced by `bookings_reschedule_shape_ck`. But
`bookings_cancel_reason_ck` requires `settle_reason` only for `'cancelled'`, so on
`'completed'` and `'no_show'` it may legitimately be NULL at close — and was then writable.
The challenger measured it on both states: *refusal=(NONE)*. The late reason inherited the
`settled_at` written at closure, so nothing in the row distinguished it from one recorded
there, on a no-show, the state most likely to be disputed.

Closed as block **(a4)**, `booking.settlement_after_close`: once a booking is not `'booked'`,
no settlement field may go from NULL to non-NULL. The law's sentence needed no rewriting —
only the code was narrower than the law, so the code is what changed. Two red proofs land it,
one per state, each asserting that the reason is legitimately NULL at close first (so the
case is about the hole and not about a CHECK), then the refusal by name, then that neither
the reason nor `settled_at` moved. The non-vacuity case gains a `no_show` closed WITH its
reason in one statement, because a refusal of (a4) and a refusal of that lawful shape would
otherwise be indistinguishable.

**Two things the challenger withdrew or corrected, recorded because it did so in writing.**
It verified this round's NEW premise rather than accepting it — "no zone has ever
transitioned twice within one day" — by enumerating every transition window at one-day
granularity and then scanning each one hourly: 41 999 windows across 330 zones, a maximum of
one transition per 24 hours, no window with more than one. And it retracted a finding of its
own: its first probe read "reassign closer → (NONE)", which was its own bug — it passed the
same user id, so `IS DISTINCT FROM` correctly permitted a no-op. Retested with a different
user, it is refused by name.

**The run after this fix.** `tests/phase9-prep`, 7 files, **82 of 82 cases, exit code 0**, on
PostgreSQL 16.15 at `en_US.utf8`, and again on 18.4 at `C` as the comparison.

### 3c.12 The INDEPENDENT CHALLENGER's REJECT at `51626e1`, answered

An independent challenger ran its own container against `51626e1` on PostgreSQL 16.15 at
`en_US.utf8` under Node 24.12.0, read the whole diff against `6fc505d`, verified the digests
of all five committed artifacts, and wrote four probes of its own. Its verdict was **REJECT**
with six findings. The report is `/mnt/project-files/phase9/P9-CHALLENGE-51626e1.md`. This is
what each one was and what was done; nothing here is self-signed, and the challenger has not
seen this round.

**C-P9-01 (P1) — the whole measurement was off-target, and one case red on the target.**
Correct, and already being fixed when the report landed: §3c.11 above records the same
collation defect, found on the same first target run. The five orderings pin `COLLATE "C"`
and a live case proves the hazard. The evidence claim is now stated against the target run's
own identity and exit code, and the 18.4 numbers are a comparison, not the claim.

**C-P9-02 and C-P9-03 (P2) — two laws this file states were enforced by nothing.** The real
finding of the round, and both were defects in the schema, not in the evidence. Block (a) of
`bookings_transition` froze what time is held for whom; the state machine in block (b) only
fires on a CHANGE of `state`. An UPDATE that left `state` alone and rewrote only the
settlement matched neither, so **the cancellation reason could be rewritten, `settled_at`
backdated three days, and `rescheduled_to_id` repointed at a different booking** until the
forward link contradicted the backlink that block (a) does freeze. The challenger proved both
by execution: *refusal=(none)*, twice.

Fixed as **R-P9-15 — the closure record is WRITE-ONCE**: blocks (a2) and (a3) of
`bookings_transition` refuse any change to `settled_at`, `settled_by_user_id`,
`settle_reason` or `rescheduled_to_id` once it is non-NULL (`booking.immutable_settlement`),
and refuse writing one while the booking is still `'booked'`
(`booking.settlement_without_close`). Write-once rather than frozen-always, because the
statement that closes the booking has to write them. `IS DISTINCT FROM` on both sides, so
**clearing** a written value is a rewrite too.

Five cases land it in `tests/phase9-prep/p9-booking-integrity.test.ts`, each asserting the
refusal **by name** — the two shape CHECKs would refuse some of these UPDATEs for a different
reason, and a case asserting only "it failed" would have passed on the wrong constraint with
the hole still open. The file carries the challenger's own measured pre-fix output beside each
proof. The fifth case is non-vacuity: the three lawful closures still go through, so a guard
that refused every UPDATE could not satisfy the suite.

**C-P9-04 (P2) — the long-range tz sweep rested on a false premise.** The comment claimed a
sample window holding two transitions "reports their sum, which can only overstate". False:
two transitions of OPPOSITE sign inside one window **cancel**, and the challenger found the
pairs (Asia/Hebron 2040-10-20 +60 with 2040-10-27 −60, and four more). The reported maximum
was therefore a lower bound, not an upper one, and the assertion could not do the job it was
given — redding if a future tzdata widened a repeat past the scan. The step is corrected
rather than the claim reworded: the sweep now runs at **one-day** granularity, which isolates
single transitions, and the two headline numbers are unchanged (gap 1440, repeat 420 at
Antarctica/Vostok). Its second half was the zero margin: `<= 1440` against a scan half-width
of exactly ±1440. The dangerous direction is now asserted **strictly** (`widest_repeat <
1440`); the gap stays inclusive because 1440 is measured there and a gap only ever produces a
refusal.

**C-P9-05 (P3) — the documented zone count was the container's, not the target's.** 598 is a
PG 18.4 tzdata fact; the target returns 499. Restated in all three places as a property of
the measuring server's tzdata build, with both numbers given.

**C-P9-06 (P3) — a catalog comment its own routine disproves.** `booking_replay_result`'s
`COMMENT` still ended "row security applies to it as to any read", which is the premise the
routine's own executed attack falsified. Struck, and replaced with what is true: row security
does not bound this routine, which is why the scope is enforced in the body.

**The run after the fixes.** `tests/phase9-prep`, 7 files, **81 of 81 cases, exit code 0**, on
PostgreSQL 16.15 at `en_US.utf8` and again on 18.4 at `C` as a comparison. The 1-day sweep
reproduces the challenger's numbers exactly on the target: gap 1440, repeat 420
(Antarctica/Vostok), 499 zones × 47 483 samples.

**What is still owed and is NOT claimed.** Node 24 (the container ships 22.22.0 — the
challenger's run was on 24.12.0, but it was a run of `51626e1`, not of this round). No
challenger signature on this round, and no coordinator actual-diff review: PART 15 forbids
the author signing their own work. (Superseded by §3c.13 and §3c.14: the challenger passed
the work two rounds later, at `9a64289`. This paragraph is left as it was written, because a
round's record should say what was true when it was written.) The retention decision is the
owner's.

### 3c.11 HIGH-VELOCITY V1 — measured on the APPROVED TARGET, PostgreSQL 16 / `en_US.utf8`

The mission's PART 1.3 names **PostgreSQL 16 with `en_US.utf8`** as the approved deployment
target, says PG18 may be used only for specific comparison experiments, and PART 19 requires
the database version **and collation** in every piece of evidence. Every proof in this phase
until now was produced on PostgreSQL 18.4 — and, it turns out, on a **`C`-collated** cluster,
which no document said because nothing asked.

So the target was built and the whole suite run on it: a PostgreSQL **16.15** cluster,
`UTF8`, `datcollate` and `datctype` both **`en_US.utf8`**, initialised with the project's own
`bootstrap.sql` as the deployment principal.

**It found a defect in the suite on the first run.** Five assertions sorted text in SQL —
under the database's collation — and compared the result to a JavaScript `.sort()`, which is
code-unit order. Under `en_US.utf8` the underscore carries no primary weight, so
`booking_resources` sorts BEFORE `booking_resource_schedules`; under `C` it sorts after. The
same schema therefore passed on one collation and failed on the other. The orderings now pin
`COLLATE "C"`, and a new case proves the hazard is real on the live server rather than
assumed — a fix for a difference nobody can demonstrate is a guess.

Nothing in the schema, the invariant, the routines or the policies behaved differently
between the two versions: after the harness fix, **76 of 76 cases passed on PostgreSQL
16.15/`en_US.utf8` AND on PostgreSQL 18.4/`C`, exit code 0 on both**, and the run log records
each run's version, collation, role, command, times and exit code. That is the honest shape
of the claim — the invariant is proved on the approved target, and the PG18 run is now what
the mission says it may be: a comparison.

What this does **not** establish: Node 24. The container ships Node 22.22.0 while the
repository declares `>=24 <25`, so the runtime half of PART 7.6's "rerun on Node 24 and
PostgreSQL 16 at final integration" is still **UNMEASURED**. The database half is now
measured.

### 3c.10 Mission V3 — the scan fixed, and the exit code proved

**1. The ±180 window was a defect, not a documented limit.** Measured: Antarctica/Vostok
went from +07:00 to +00:00 on 1994-01-31, so seven wall-clock hours occur twice. At ±180
the second occurrence is outside the scan, the time looks unambiguous, and the resolver
**silently picked one** — the single thing R-P9-13 exists to prevent. The suite proves this
against a COPY of the old scan created in the scratch database, so the defect is
demonstrated rather than described, and nothing in the document is mutated to show it.

The fix is in the algorithm, not in the prose:

* the scan is **±1440 minutes**, measured to cover every transition in the supported range
  in both directions;
* the candidates are the **zone's own offsets**, read out of the zone with their seconds,
  rather than whole-minute shifts of PostgreSQL's answer — the whole-minute premise is
  measured false inside the range (Africa/Monrovia, -00:44:30 until 1972). No wrong answer
  was found from that premise, so the suite and the spec both call it a premise removed and
  not a defect repaired;
* the **round-trip filter** is why widening is safe at all: a candidate survives only if
  mapping it back into the zone returns exactly the wall clock asked for, so a wider scan
  cannot invent a candidate.

**2. The supported range is enforced.** `1970-01-01` to `2100-01-01`, refused by its own
name (`booking.local_time_out_of_supported_range`), and it is exactly the span the scan's
width is measured over. The inside edges are asserted to answer, so it is a boundary with
evidence behind it and not the blanket ban on distant dates V3 warned against.

**3. The run's exit code and identity are proved, not implied.** V3 observed that the
previous log's ending did not show Vitest closing successfully — correct: vitest prints a
"close timed out / something prevents Vite server from exiting" teardown warning after a
successful run whose worker still holds the PostgreSQL pool, and that trailer is the last
thing in the log. The stored artifact now opens with a run-identity header: subject SHA, a
clean-tree count at run time, the command, start and finish in UTC, **EXIT CODE 0**, the
node, vitest and PostgreSQL versions, and the result lines — plus the explanation of that
trailer. The header also records that the container ships **Node 22.22.0 while this
repository's `engines` requires >=24 <25**: the suites pass under 22, but a run on the
declared version is owed at promotion, and that is stated rather than left to be inferred.

### 3c.9 Mission V2 — the four items it adds beyond V1

1. **Evidence subject reconciled with the head.** V2 asks for `e077daa` (the subject the
   evidence was produced against) to be reconciled with head `57ac451`. They differ by
   exactly one file: `57ac451` is the handoff manifest written to name `e077daa`, which is
   why it cannot be the same string as the SHA it describes. `git diff --stat e077daa
   57ac451` is the whole reconciliation, and the manifest now states it rather than leaving
   two SHAs to be noticed.
2. **The internal GUC-only visibility was NOT narrowed.** V2 says not to reduce the
   deliberate internal visibility without an exploit. No policy in §8 changed: the
   `current_user = 'daftar_booking_internal'` read exemption stands exactly as it was. What
   was added is a check inside one routine, against a hole the executed attack actually
   returned — which is the exploit the instruction asks for, and it is recorded in §3c.4.
3. **A run log is now a stored artifact.** V2 asks for harness and logs to be retrieved
   rather than recreated. The suites' output at the evidence SHA is saved and hashed
   alongside the documents, so a later reader can compare a run instead of taking this
   report's word for the counts. Per PART 16 it proves only the SHA it names.
4. **Retention is reframed, not answered.** V2 is explicit that the current absence of a
   DELETE path protects history in preparation but is **not legal approval for indefinite
   retention**, and that the record, the registry and the backlinks may never be dropped to
   solve retention. So the default stated in §3c.6 is a prep-time state, not a policy, and
   the separation of personal content from booking facts plus the policy options are
   prepared for review in `P9-RETENTION-AND-ERASURE-OPTIONS.md` with no invented window and
   no guessed erasure. Policy-dependent activation stays blocked until the owner rules; the
   command work continues around it.

### 3c.8 The prep cases are not a sealed phase

76 green cases say that the invariants in this document hold on a live server. They do not
say Phase 9 exists: there is no command layer, no surface, no migration number, and these
suites are not in required CI. §4 states that in full, and nothing in this report may be
read as a promotion claim (PART 83).

---

## 3b. Evidence classes (PART 15)

Stated in the only classes the directive allows, with nothing mixed and nothing
claimed in a stronger class than it was measured in.

| claim | class |
|---|---|
| the seven relations, their constraints, RLS, grants, ownership, end state | PROVEN BY DATABASE CATALOGUE |
| no double booking under race; the lock orders; DST refusals; idempotent retries | PROVEN BY TEST |
| the replay returns the first attempt's recorded booking, and refuses a reused key over a different request | PROVEN BY TEST |
| no runtime role writes these relations, and RLS confines the internal authority | PROVEN BY EXECUTED ATTACK (test, no superuser) |
| the local-time soundness property over 14 000+ inputs | PROVEN BY TEST (sweep, independent oracle) |
| every claim above, on the APPROVED TARGET PostgreSQL 16.15 / `en_US.utf8` | PROVEN BY TEST (76/76, exit 0) |
| the same claims on PostgreSQL 18.4 / `C` | PROVEN BY TEST — a comparison run, not the target |
| anything on Node 24 (the repository's declared engine) | **UNMEASURED** — the container ships Node 22.22.0 |
| each invariant is load-bearing (six red proofs, restored character-identical) | PROVEN BY TEST |
| the DDL spec as a deployable migration | **SPEC ONLY** — no number allocated |
| the command layer, schedule containment | **SPEC ONLY** — not written |
| any retention period, and any erasure path | **UNMEASURED** — owner-only; nothing deletable today |
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

12. **The local-time scan is bounded to ±1440 minutes over a declared range, and the
    earlier ±180 claim was WRONG, not merely narrow.** V3 of the Mission said the ±180
    window could pick an occurrence inside a longer historical repeat, and it was right:
    Antarctica/Vostok moved from +07:00 to +00:00 on 1994-01-31, so seven wall-clock hours
    occur twice, and at ±180 the old scan resolved such a time **silently** instead of
    refusing it as ambiguous. That is proved against a copy of the old scan, and it is the
    one defect in this phase that was found by a directive rather than by the suite. The
    scan is now ±1440 minutes — measured to cover every transition in the supported range
    in both directions (widest gap 1440, Kwajalein's 1993 date-line move; widest repeat
    420, Vostok) — and the candidates are the zone's own offsets rather than whole-minute
    shifts, because the whole-minute premise is measured false inside the range
    (Africa/Monrovia, -00:44:30 until 1972; no wrong answer was found from it, so that part
    is a premise removed and not a defect repaired). The supported range **1970-01-01 to
    2100-01-01 is enforced** and refused by its own name. What remains limited: outside that
    range the routine answers nothing, by design, and widening it means re-running the
    measurement rather than editing a comment.
13. **The DST cases depend on the server's tz database**, so the suite asserts the
    occurrence counts of its four moments from the server before relying on them. A tz
    update that moved a rule reds the suite rather than silently making its proofs
    vacuous — but it does red it, and that is maintenance this work hands forward.
14. **The retention period and every erasure path are undecided.** What the schema
    enforces is "retain everything, delete nothing", which is a default and not a policy. A
    right-to-erasure request has no path here, by design rather than by oversight, and
    building one is an owner decision because it trades that right against an append-only
    history (§3c.6).
15. **Business isolation of a registry READ is enforced by the routine, not by RLS.** §8's
    read policies exempt `daftar_booking_internal` by name so its definer bodies can read
    across the businesses of one tenant, and that principal is the only one allowed to
    execute `booking_replay_result`. The business boundary for the replay therefore lives in
    the routine's own fail-closed check. It is proved (`booking.replay_scope_mismatch`), but
    it is a different kind of guarantee from a policy, and a future routine over these
    relations must make the same check rather than assume it.
16. **~~No independent challenger has run.~~** Written before the challenge and left in
    place, because a limitations list that quietly deletes its own entries cannot be
    audited. Superseded: an independent challenger ran three times and passed the work at
    `9a64289` (§3c.12–§3c.14). What remains true is the part under it — every case in this
    report was written by the author of the thing it tests, and the challenger's probes
    are the challenger's. The coordinator actual-diff review was given at `9a64289`
    (ACCEPT-WITH-SCOPE); one signature of three is now owed, not two.
18. **`booking.state_not_reopenable` can never fire — OPEN DESIGN ITEM, not a fix.** Block
    (b)'s first clause already refuses every change of state out of a terminal state, so
    the clause beneath it, which refuses re-entering `'booked'`, is unreachable: any UPDATE
    that would re-enter `'booked'` is leaving a terminal state and is refused by
    `booking.state_terminal` first. The refusal is therefore dead code with a live name,
    and its name appears in the function's own COMMENT as though it were reachable.
    Recorded rather than deleted: which of the two refusals a caller should see is a
    question about the command slice's error contract, not about the schema, and
    collapsing them now would decide it silently. Raised by the coordinator's actual-diff
    review of `51626e1..9a64289`.
19. **R-P9-15 guards UPDATE only, so an INSERT can create an already-closed booking —
    OPEN DESIGN ITEM, not a fix.** `bookings_transition` is a BEFORE UPDATE trigger, and
    nothing refuses an INSERT that arrives with `state = 'cancelled'` and a settlement
    record already written, or with a forward reschedule link. The shape CHECKs make such
    a row internally consistent rather than impossible. Whether a booking may be born
    closed is a command-slice question — an import, a migration of historical data and a
    live cancellation want different answers — so the schema does not decide it here.
    What the schema does guarantee is that once such a row exists, every later write to
    its closure record is refused. Raised by the same review.
17. **The lock-set collision case is reasoned, not measured.** Two distinct resources
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
