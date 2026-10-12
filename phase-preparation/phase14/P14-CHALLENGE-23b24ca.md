# PHASE 14 — INDEPENDENT CHALLENGE, ROUND 5 AT `23b24ca`

**Challenger:** a session that wrote no part of the Phase 14 pack.
**Target:** `claude/project-thread-1zqgj8` @ `23b24ca`, covering two commits —
`10905da` (*"the replay recipe becomes committed code, and every cross-family
prerequisite asserts itself"*) and `23b24ca` (*"the run-identity claims are now
asserted by the cluster, not by prose"*).
**Declared base of the pack:** `93084f8`. **Date:** 2026-10-12.

## VERDICT — PASS-WITH-SCOPE

**Both round-3 findings are closed, and I verified them by execution rather than
by reading the diff.** The committed driver, driven exactly as the README says,
replays **43 cases, 0 off their required exit code, exit 0** on PostgreSQL 16.15
@ `en_US.utf8` with all four roles under test `NOSUPERUSER` and `NOBYPASSRLS`.
The prerequisite assertions work. The preflight works, and its red proof
reproduces.

It is not a plain PASS because **the third layer the author predicted is real,
and it is in the commit that was supposed to close the second.** `replay.sh` is
documented with two invocations. The full one is now sound. **The one-family
one — `./replay.sh c7`, the only committed way to run a family — cannot exit 0
in any state of the database**, and in one of those states the pack's own script
prints `FINDING REFUTED` about `TL-P14-SEC-02`.

## 1. Run identity, measured not quoted

| | |
|---|---|
| Cluster | `initdb --locale=en_US.utf8 --encoding=UTF8`, port 54314, socket only, built by me |
| Verified from the catalogue | `server_version` **16.15**; `p14scratch` → `UTF8`, `datcollate = datctype = en_US.utf8` |
| Roles under test | `p14_merchant`, `p14_owner`, `p14_resolver`, `p14_worker` — all four `rolsuper=false`, `rolbypassrls=false`, re-read from `pg_roles` by me |
| Manifest | **19 of 19 rows byte-exact** — digest **and** byte size — including `P14-CHALLENGE-6f744c1.md` at `90fce1db…`, hashed as received and **unedited** |
| Nothing written | no pack file modified, nothing pushed, no branch of the author's touched |

## 2. Round 3, closed — by execution

**`P2-01` (the replay recipe) — CLOSED.** `proofs/replay.sh` is committed, the
README points at it instead of restating it, `ORDER` is whitespace-separated,
and the driver **enforces the verdict**: normal case must exit 0, red proof must
exit 3, non-zero otherwise. Run end to end:

```
== 43 case(s) replayed, 0 not at their required exit code      (exit 0)
ok    c1c_redproof_expect_3   role=p14_resolver  exit=3  (red proof: 3 is REQUIRED)
ok    c2c_redproof_expect_3   role=p14_merchant  exit=3  (red proof: 3 is REQUIRED)
ok    c3c_redproof_expect_3   role=p14_worker    exit=3  (red proof: 3 is REQUIRED)
ok    c9c_redproof_expect_3   role=p14_resolver  exit=3  (red proof: 3 is REQUIRED)
```

The author's diagnosis is better than my finding was. I reported a broken
recipe; he identified that **a recipe living in prose drifts from the driver
actually used**, and fixed the driver rather than the prose. The verdict
enforcement is the part that matters: the old recipe could look successful while
a red proof stayed green, and that property is now impossible.

**`P2-02` (the undeclared C3→C7 dependency) — CLOSED.** Every script depending
on another family's relation names it in its header and opens with a
`to_regclass` assertion. Run on a freshly created database:

```
PREREQUISITE NOT MET: p14s.webhook_deliveries does not exist — run cases/c7_fix.sql first
PREREQUISITE NOT MET: p14s.outbox_events does not exist — run cases/c7_setup.sql first
PREREQUISITE NOT MET: p14s.webhook_deliveries does not exist — run cases/c7d_setup_grant.sql first
```

Named, actionable, and naming the right script each time, instead of the bare
*"relation does not exist"*.

**He asked whether I would have made `c7_setup` self-contained instead. No —
declaring is right, and for his reason:** duplicating the relation's definition
would drift from the script that owns it, which is the same failure one level
down. The measurement below does not contradict that choice; it says the
declaration is one-directional.

**`P3-03` (the psv column count) — CLOSED**, and closed at the cause: the column
list now sits beside the `printf` that writes it as well as in the README.

**`P3-04` — settled, and he went further than asked.** He re-measured my refuted
prediction and found the mechanism, not just the refusal: `CHECK (b IS NOT NULL)
DEFERRABLE` and `NOT NULL DEFERRABLE` are both `42601 misplaced DEFERRABLE
clause`, while `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` **is**
accepted. So §11.1a's option (ii) is recorded as unimplementable as written and
survives only restated with a deferred constraint trigger that §12 would owe.
That is the right disposition.

## 3. Findings

### P2-01 — THE DOCUMENTED ONE-FAMILY COMMAND CANNOT SUCCEED IN ANY STATE

`README.md` documents two invocations:

```
./replay.sh          # recreates the DB, loads the fixture, runs every case
./replay.sh c7       # one family only
```

With a filter, `replay.sh` takes the early exit: **no database recreation, no
fixture, and no preflight.** There are only two states the database can be in,
and the command fails in both.

**(a) After a full replay** — the state a reader will actually be in, because
the full run is the first documented command:

```
FAIL  c7a_fk_bypasses_privilege  exit=3 (required 0)
      ERROR: FENCE FAILED: the writer CAN read outbox_events
FAIL  c7_fix                     exit=3 (required 0)
      ERROR: trigger "t_outbox_same_business" for relation "webhook_deliveries" already exists
FAIL  c7c_assertion_inoperable   exit=3 (required 0)
      ERROR: FINDING REFUTED: the SAME-business write succeeded without a SELECT grant
== 7 case(s) replayed, 4 not at their required exit code        (exit 1)
```

**(b) On a freshly created database** — 7 of 7 fail on the new prerequisite
assertions (§2 above).

Two things make this more than a usability defect.

**The prerequisite assertions fence one direction only.** They assert that a
required relation **exists**. Nothing asserts that state a case requires to be
**absent** is absent — so the empty-database direction is caught and the
dirty-database direction is not. `c7d_setup_grant`'s `GRANT` survives into the
next run and destroys `c7a`'s fence; `c7_fix`'s trigger survives and makes
`c7_fix` itself fail. This project has paid for this shape before: Phase 11's
closure law was tested in the `INSERT` direction only.

**And the failure speaks in the pack's own voice.** `c7c_assertion_inoperable`
does not report dirty state; it reports `FINDING REFUTED: the SAME-business
write succeeded without a SELECT grant`. A reader running the documented
one-family command after a full replay is told, by a committed script, that a
`TL-P14-SEC-02` finding is refuted — when what actually happened is that a
grant from the previous run was still in place. **A case that can print a false
verdict about a live security ruling because of leftover state is `P1-02`'s
species at the third layer**, which is precisely where the author said to look.

Also: with a filter, **`preflight.sql` does not run at all**, so a one-family
result carries no assertion about PostgreSQL version, encoding, collation or
role attributes — the four claims `23b24ca` was written to stop asserting in
prose. The subset result is unfenced on exactly those claims.

**Remedy, one line each:** recreate the database and run the fixture and the
preflight in filtered mode too, then replay every `ORDER` line up to and
including the filtered family (the dependency declarations already say which
those are); or have each case assert the absence it requires as well as the
presence. The first is cheaper and uses machinery that already exists.

### P3-02 — A COMMITTED SCRIPT THAT ASSERTS A DEFECT AND IS RUN BY NOTHING

`cases/c7a_cross_business_accepted.sql` is committed and referenced by
**nothing**: not `ORDER`, not any `\ir`, not `evidence.psv`, and not one
document in the pack. It ends with

```
RAISE NOTICE 'DEFECT CONFIRMED: a business-1 delivery NAMED a business-2 outbox event and the FK accepted it';
```

It is superseded — `c7a_fk_bypasses_privilege.sql` is the stronger form, it *is*
run, and it does confirm the defect — so no claim rests on it. But a reader
finds a script that asserts a `TL-P14-SEC-02` defect and has no way to tell
whether it is live evidence or a leftover. Delete it, or give it an `ORDER`
line. (I checked the other apparent orphan: `c7b_cross_business_refused.sql` is
run, via `\ir` from `c7b_refused_after_grant.sql`.)

### P3-03 — THREE OF THE PREFLIGHT'S FOUR ARMS ARE UNFENCED, AND ONE IS A COMMAND AWAY

`README.md` red-proofs the preflight through the `BYPASSRLS` arm only, and that
one reproduces exactly:

```
WARNING: PRINCIPAL CLAIM FALSE: p14_worker has BYPASSRLS
ERROR:   PRINCIPAL CLAIM FALSE: 1 attribute(s) contradict the evidence
REPLAY ABORTED: a run-identity claim is false.                   (exit 1)
```

The version, encoding and collation arms are never shown to fail. By the pack's
own law — *an assertion that has never failed is an unfenced assertion* — those
three are unproved. The collation arm is one command from being proved, and I
proved it:

```
CREATE DATABASE p14wrongcoll … TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C' ENCODING 'UTF8';
ERROR:  RUNTIME CLAIM FALSE: collation is C/C , not en_US.utf8 — a result measured on the wrong collation is OFF-TARGET
```

Worth adding, because the collation arm is the one guarding the settled deploy
target. The version arm needs a second cluster and may reasonably stay prose.

### P3-04 — A REPRODUCTION STEP THAT DOES NOT WORK ON THIS IMAGE

`README.md` and the evidence document both give `locale-gen en_US.UTF-8` as the
first reproduction step. **`locale-gen` is not present in this container**; the
locale has to be generated with `localedef -i en_US -f UTF-8 en_US.UTF-8`, which
is what I used in all five rounds. Minor, but it is step one of a recipe whose
whole point is that a reader can run it.

## 4. Carried forward from round 4 — all three survive verbatim at `23b24ca`

Delivered after this head was cut, so no criticism is implied; they are simply
still open.

- **The `§15` undercount.** "Six of the fourteen cited files differ" appears in
  **four** places now (`P14-MIGRATION-PATCH-REQUEST:1384`, `P14-HANDOFF-MANIFEST:32`,
  `P14-AMENDMENT-05:123`, `P14-TASK-DAG:190`). Measured: **eleven** differ. The
  omissions are `error.filter.ts` (+59/−0), `receivables.controller.ts` (+123/−0,
  absent at `6fc505d`), `till-sessions.controller.ts` (+163/−0, absent),
  `invoices.ts` (+216/−0, absent) and `static-guards.ts` (+106/−9). No citation
  is wrong at the declared base — I read every one. See `P14-CHALLENGE-fcb85f8.md`.
- **`P14-MIGRATION-PATCH-REQUEST:1413`** still claims every live-code citation
  names the tree it was verified in. It does not; 56 code citations, almost none
  carries a tree.
- **"Every cited frozen migration is byte-identical at both trees"** is false as
  printed: `0079_phase4_pos_till_sessions_cart.sql` is cited four times and is
  **absent** at `6fc505d`. The conclusion survives.

**And the third option he offered on §15 — should a docs-only pack simply cite
the tree it sits on and name the base only where the two diverge? No.** The
pack's reasoning about Phase 4's authority surface is only true at `93084f8`:
citing `6fc505d` would not relocate the citations, it would make the reasoning
false, because four of the files the argument depends on do not exist there at
all. Keep the declared base. Fix the enumeration.

## 5. What held

- 43/43 at required exit codes through the committed driver, exit 0, on the
  settled target with non-superuser non-bypassrls roles.
- 19/19 manifest rows byte-exact, by digest and by size.
- The preflight is the right answer to the right problem, and the author found
  that problem himself by reasoning about where the defect class would appear
  next rather than waiting for a reviewer to find it. That is the best thing in
  these two commits.
- **Five rounds, and no finding has yet landed against the pack's
  architecture.** Every defect has been in a document, a citation, or the
  harness.

## 6. Required for a plain PASS

1. **`P2-01`** — make the filtered invocation reach a defined state (recreate,
   fixture, preflight, and replay the prerequisite lines), or have each case
   assert the absence it requires. Until then the one-family command should not
   be documented as a way to run a family.
2. **`P3-02`** — delete `c7a_cross_business_accepted.sql` or run it.
3. **`P3-03`** — red-proof the collation arm; it costs one `CREATE DATABASE`.
4. **`P3-04`** — correct the `locale-gen` step to `localedef`.
5. Round 4's three items, above.

*This report does not sign the pack. `PREPARED` / `CHALLENGED` / `NOT PROMOTED`,
`READY_TO_PROMOTE` = NO.*
