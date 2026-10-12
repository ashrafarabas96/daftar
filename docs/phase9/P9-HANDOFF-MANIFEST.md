# P9-HANDOFF-MANIFEST

The PART 13 handoff gate for Phase 9. PART 13 is explicit that an absent companion
document is not evidence that work never existed, so this manifest names every
artifact, where it is, whether it is committed, and its hash — so the next reader can
tell a missing file from a file they have not found yet.

## Phase

Phase 9 — Universal Booking and Services (roadmap Phase 9; directive #11 PARTs 49–53, and
the Master Continuous Mission's Phase 9 items).

## Status

`PREPARED / NOT PROMOTED` (PART 49, PART 117). On the Mission's ladder
(`PREPARED → CHALLENGED → READY_TO_PROMOTE → PROMOTION_IN_PROGRESS → ACCEPTED / SEALED`)
this work stands at **`CHALLENGED`** and not one rung further. That rung was granted, not
claimed: the same independent challenger ran three times — REJECT at `51626e1`,
PASS-WITH-SCOPE at `76ab277`, and **PASS at `9a64289`** with no open finding, seven findings
raised and all discharged. `READY_TO_PROMOTE` is the next rung and its gates are external,
below. A challenger's PASS is not a promotion and the challenger says so in its own report.

`READY_TO_PROMOTE` = **NO**. Its gates are external: the roadmap predecessor must seal
first (PART 4), a migration number must be allocated by the one Migration Owner
(PART 6), and the `bootstrap.sql` role patch must be applied by its owner.

## Exact prep SHA

```
6e339bf888b68bb7ef7b38d4af2a8b0ac0aecbbe
```

Branch: `claude/project-thread-4i752q`
Base:   `6fc505d` (`origin/main`, the sealed Phase 3 head; `frozenThrough 0073` on this base)
Worktree: the session's primary checkout — no secondary worktree was created.
Tree state at this SHA: clean apart from this manifest, which is committed immediately
after it and names the SHA it describes rather than being backfilled into it.

**Evidence subject vs head, reconciled (Mission V2).** The evidence in this handoff was
produced against the subject SHA above; the branch head is later because the head IS this
manifest naming that subject. The challenger signed `9a64289` and the coordinator reviewed
`51626e1..9a64289`; the subject above is later, because it carries the tests and
documentation the coordinator's scope items asked for. Neither signature has seen it, and
the Coordinator state below says so. The two can never be the same string, and the
whole difference between them is one file:

```
git diff --stat 6e339bf <head>
 docs/phase9/P9-HANDOFF-MANIFEST.md | (this manifest only)
 1 file changed
```

No test file, no DDL and no other document differs between them, so a result measured at
the subject is a result about the head's code. The stored run log names its own subject SHA
in its header, and that subject is the commit this manifest is written against — so the
reconciliation is readable from the artifact itself and not only from here. Per PART 16 that is stated as a verifiable
relation, not as "the same commit".

## Artifacts

All ten are **committed** to the branch above. The copies under
`/mnt/project-files/phase9/` are off-Git and carry the same bytes; their hashes are
the same values, recorded here because PART 13 asks for a hash on anything that does
not live in Git.

| artifact | location | committed | SHA256 |
|---|---|---|---|
| DDL spec (**not a migration**) | `docs/phase9/P9-BOOKING-DDL-SPEC.sql` | yes | `ac87f1246357c9c2fb78b8b87a8faf0abd5ca12d747f3192cc01ca3aa94705f5` |
| Migration patch request | `docs/phase9/P9-MIGRATION-PATCH-REQUEST.md` | yes | `973983845b11b88056caba94209ae4a355088a4fb04b77ad2d0a45ee46010a4d` |
| Scope and architecture | `docs/phase9/P9-S0-SCOPE-AND-ARCHITECTURE.md` | yes | `b90129cd9f066fd789ef7659df219a1c9ea95ec62b0f48007558ffccf705ba32` |
| Prep report (with LIMITATIONS) | `docs/phase9/P9-PREP-REPORT.md` | yes | `8dab9c1815ecd4c7f769601ba8121fabe273cc82b9445f366884ac3da8a38bae` |
| Retention and erasure options | `docs/phase9/P9-RETENTION-AND-ERASURE-OPTIONS.md` | yes | `2c358ced52646829aafff90e1a987feb9af7a73305109a4bb78df699d06deb55` |
| Stored run log at the evidence SHA | `/mnt/project-files/phase9/P9-RUN-LOG.txt` | **no — off-Git** | `9147ebc93b66aefe199e78a24821145ccbd34cff35bef5727ec1aa2d18c1f976` |
| Independent challenger's PASS-WITH-SCOPE at `903e1f4` | `/mnt/project-files/phase9/P9-CHALLENGE-903e1f4.md` | **no — off-Git** | `54b8f4d24cc087f6b3757b789c6eed4012265e792f0cefd79ae72e38fb06dbb3` |
| Coordinator actual-diff review at `9a64289` | `/mnt/project-files/phase9/P9-COORD-DIFF-REVIEW-9a64289.md` | **no — off-Git** | `bc8fcfa4f13545c92036dc864e2bacb9175fe8e4783aaa6a21afe66c6286443c` |
| Independent challenger's PASS at `9a64289` | `/mnt/project-files/phase9/P9-CHALLENGE-9a64289.md` | **no — off-Git** | `9fe72d8f3f0337732cf32e251a5365a4a35eda7959fb8c42c00d20d19c3611d9` |
| Independent challenger's PASS-WITH-SCOPE at `76ab277` | `/mnt/project-files/phase9/P9-CHALLENGE-76ab277.md` | **no — off-Git** | `67742ec1c85916505af86f1bb3a9699833af604e77e899ef9ca8bd653ac532a6` |
| Independent challenger's REJECT at `51626e1` | `/mnt/project-files/phase9/P9-CHALLENGE-51626e1.md` | **no — off-Git** | `d5b751c6a6da094d9ccb428414ec886d27c45b2a0a2011351e17bb9f50c8d577` |
| This manifest | `docs/phase9/P9-HANDOFF-MANIFEST.md` | yes (next commit) | — |

No artifact is referenced by any of the above that does not exist. There are no
byte-identical duplicates to canonicalize (PART 14).

## Tests and evidence files

| suite | cases | what it measures |
|---|---|---|
| `tests/phase9-prep/p9-booking-schema.test.ts` | 17 | shape, RLS, grants, ownership, end state, the state contract, collation independence |
| `tests/phase9-prep/p9-booking-concurrency.test.ts` | 11 | no double booking under real concurrency |
| `tests/phase9-prep/p9-booking-negative-controls.test.ts` | 7 | each invariant removed, and the damage measured |
| `tests/phase9-prep/p9-booking-multi-resource.test.ts` | 10 | the global lock order (PART 50), idempotent retries and the replay (PART 53) |
| `tests/phase9-prep/p9-booking-time.test.ts` | 21 | the timezone / DST law (PART 51), its soundness sweep, the measured ±1440 scan at one-day granularity, and the two defects V3 named |
| `tests/phase9-prep/p9-booking-integrity.test.ts` | 11 | the closure record is write-once (R-P9-15) — the two defects the independent challenger found, and the non-vacuity that keeps the guard honest |
| `tests/phase9-prep/p9-booking-runtime-attack.test.ts` | 10 | the schema attacked as the six real runtime roles, no superuser |
| `tests/phase9-prep/p9-booking-spec.ts` | — | the spec loader and its non-vacuity guards |
| `tests/phase9-prep/p9-booking-world.ts` | — | the fixture, applied as `daftar_migrator` |
| `tests/phase9-prep/p9-race.ts` | — | the race harness: `pg_blocking_pids`, never a sleep |

**87 of 87 green, EXIT CODE 0**, on the APPROVED TARGET — a live PostgreSQL **16.15**
cluster whose `datcollate` and `datctype` are both **`en_US.utf8`** (HIGH-VELOCITY V1 PART
1.3; PART 19 requires the version and the collation) — with the spec applied in one
transaction as the non-superuser deployment principal `daftar_migrator` on top of the sealed
Phase 3 head. Run with `npx vitest run tests/phase9-prep`, `PG_DIR=/tmp/daftar-pg16
PG_PORT=55433`, started 2026-10-12T16:29:37Z, finished 16:32:18Z, under **Node v24.21.0** — this phase's own Node 24 run, which PART 7.6 asked for and which earlier rounds recorded as owed.

The same set was then run under Node v22.22.0 on PostgreSQL 16.15 (16:32:18Z to 16:34:54Z)
and on PostgreSQL 18.4 at collation `C` (16:34:54Z to 16:38:35Z) — **87 of 87, EXIT CODE 0**
on both. The 18.4 run is a comparison — and that run is a COMPARISON and nothing more, which is all PART
1.3 permits it to be. No schema, invariant, routine or policy behaved differently between
the two; the one case that ever did was a harness defect in the suite's own text ordering,
found by the first target run and reported independently as C-P9-01.

The run's own output is stored as `/mnt/project-files/phase9/P9-RUN-LOG.txt` and hashed
above, because Mission V2 asks for harness and logs to be retrieved rather than recreated.
It is the verbose reporter's output for the whole set at the evidence SHA, with the
PostgreSQL server's own log lines removed so that the artifact is the test record itself,
and it opens with a run-identity header: subject SHA, clean-tree count, command, start and
finish in UTC, **EXIT CODE 0**, and the node, vitest and PostgreSQL versions. V3 observed
that the previous log's ending did not prove a successful close — vitest prints a teardown
warning after a successful run whose worker still holds the database pool, and the exit code
is what settles it. The header also records that the container ships **Node 22.22.0 while
this repository's `engines` requires >=24 <25**, so a run on the declared version is owed at
promotion. A run is reproduced by the command above, at the SHA above.
Per PART 16, a result at any other SHA does not prove this one, and per PART 15 a green
local run is a record and not CI.

## Migration patch request

`docs/phase9/P9-MIGRATION-PATCH-REQUEST.md`. It names the exact relations, columns,
constraints, indexes, routines, triggers, policies and grants, and the invariant each
exists for. It **names no migration number and no migration filename**, by rule
(PART 6), and that is mechanically checked: the file contains no four-digit migration
token.

## Shared-file patch requests

| shared file | owner | what is asked | state |
|---|---|---|---|
| `infrastructure/database/bootstrap.sql` | deployment administrator | create the `daftar_booking_internal` NOLOGIN authority, grant it USAGE on `public`, grant it to `daftar_migrator` `WITH INHERIT FALSE, SET TRUE` | **OPEN** — §1 of the patch request; until applied, the test harness creates the role and the spec's §0 refuses to apply without it |
| `bookings` (at promotion) | Migration Owner | add the composite `customers` foreign key | **OPEN** — §2 of the patch request; deferred because Phase 4 is not sealed |
| CI workflow | repository owner (TD-08) | add `tests/phase9-prep` as a step | **OPEN** — owner-only; not requested for a PREPARED phase |

No shared file owned by another track was edited by this one (PART 41, PART 42). No
root `package.json`, `tsconfig`, `bootstrap.sql`, migration manifest or migrations
directory change is in this branch.

## Open technical decisions

1. **Aggregate capacity.** Capacity greater than one is multiple resource units
   (PART 52). If aggregate-capacity resources are ever wanted, that needs a new
   explicit architecture and its own concurrency proof — an exclusion constraint cannot
   express "at most N overlapping".
2. **Replay semantics — DECIDED AND BUILT, not deferred.** The Mission ruled that a
   uniqueness constraint alone is not replay proof, so `booking_replay_result` (R-P9-14)
   returns the first attempt's recorded booking and refuses a key reused over a different
   request. What remains the command slice's decision is only the HTTP shape of that
   answer, not whether the recorded result is available.
3. **Schedule containment.** Deferred to the command slice as a validation. The
   resolver settles the harder half; the comparison against the schedule relations is
   not written.

4. **Retention period, and any erasure path — OWNER-ONLY.** The schema's rules are
   approved and enforced today: nothing is deletable by any principal, cancellation is a
   state rather than a removal, a reschedule keeps both halves with a backlink, and the
   operation registry is append-only in the grant and again in a trigger. What is NOT
   decided is how long a booking is retained and whether a right-to-erasure path exists at
   all; it trades a customer's erasure right against an append-only history. The
   fail-closed default shipped here is **retain indefinitely, erase nothing** (prep report
   §3c.6) — and Mission V2 is explicit that this default is a prep-time state, **not legal
   approval for indefinite retention**. The separation of personal content from booking
   facts and the policy options are prepared for review in
   `docs/phase9/P9-RETENTION-AND-ERASURE-OPTIONS.md`, with no invented window and no
   guessed erasure; the booking record, the registry and the backlinks are never dropped to
   solve retention. Policy-dependent activation is BLOCKED until the owner rules; the
   command work continues around it. This one IS an owner escalation, and it has been put
   to the owner.

5. **`booking.state_not_reopenable` cannot fire.** VERIFIED by execution in round 4. Block (b)'s first clause already refuses
   every change out of a terminal state, so the clause refusing re-entry to `'booked'` is
   unreachable. Which of the two refusals a caller should see is the command slice's error
   contract, so it is recorded rather than collapsed. Limitation 18.
6. **~~R-P9-15 binds UPDATE only.~~ CLOSED as R-P9-16**, after round 4 measured it reachable
   and one of its products — a booking born `'rescheduled'` pointing at a standing booking
   with no backlink — contradicted R-P9-08. A law that is UPDATE-only by oversight is not a
   design decision. What remains open is narrower and is all that limitation 19 now says:
   whether an **import of historical bookings** may create a closed row, which is a command
   with its own authority and audit rather than a side effect of INSERT privilege.

Items 1, 3, 5 and 6 are not owner-only escalations under PART 116; item 4 is. Items 5 and 6
were raised by the coordinator's actual-diff review, which asked that they be RECORDED as
open design items and not fixed under a review's scope.

## Challenger state

**RUN FOUR TIMES. Round 4 at `903e1f4`: PASS-WITH-SCOPE, and its signature extends there.**

Round 4 reviewed the delta `9a64289..3a1d0fd` and re-ran the suite: **83 of 83, exit code 0**,
Node v24.12.0, PostgreSQL 16.15 at `en_US.utf8`, fresh `initdb` with zero recovery events,
run id `P9-CHALLENGE-R4-20261012T160758Z`. It verified the previous round's "no schema
change" claim instead of accepting it — the DDL spec's 21 moved lines tokenise, comments
stripped at the top level and inside every dollar-quoted body, to the same 50 541 characters
— and answered three questions of ours by execution: each promoted (a4) case reds to NO
refusal when its own clause is removed; dropping (a3) and (a4) together is identical to
either alone, because the two guards are mutually exclusive on `OLD.state`; and the
constraint restore is byte-identical even with a failure injected mid-probe.

**Four findings, one P2 — all closed at the subject SHA above, and that SHA DOES change the
schema.** C4-P9-01: the laws were UPDATE-only, so a booking could be INSERTed already
`'rescheduled'` pointing at a standing booking with no backlink — the asymmetric chain
R-P9-08 forbids — or born `'completed'` with `settled_at` 27 years early. Closed as
**R-P9-16** (`booking.not_born_closed`) with four red proofs, §3c.16. C4-P9-02: a comment of
ours justified two cases with a CHECK that does not refuse what it claimed; verified against
the live constraint and corrected, and the same measurement is why R-P9-16 checks the
settlement fields one by one. C4-P9-03: the catalogue comment advertised a refusal that
cannot fire; caveated. C4-P9-04: an assertion alternation with an unreachable arm, and a
cleanup ordered so a throw in it would mask the real error; both closed.

Round 4 also answered the coordinator's cross-phase question: Phase 9 is **not** exposed to
the hand-written stand-in table class found in Phase 6 — the fixture applies the real frozen
`0000`–`0073` through the project's own runner, `BOOTSTRAP_PATCH` creates a role and no
table, and every foreign key out of this slice lands on a frozen key.

Round 3, at `9a64289`: **PASS, no open finding.**

Round 3 is the signature this handoff rests on. The challenger confirmed for itself that
`git diff --stat e1b201e 9a64289` touches only this manifest, so its run exercises the stated
code. Run id `P9-CHALLENGE-R3-20261012T152915Z`, **Node v24.12.0**, PostgreSQL **16.15** at
`en_US.utf8`, spec applied by the non-superuser `daftar_migrator`, one vitest process against
a cluster it `initdb`-ed fresh (zero recovery events in its log, which also answers this
phase's disclosure about its own crashed-and-recovered cluster). **82 of 82, exit code 0**;
all eight manifest digests verified byte-exact; its own four probes 4/4, exit 0. Report:
`/mnt/project-files/phase9/P9-CHALLENGE-9a64289.md`.

It proved (a2)/(a3)/(a4) by **dropping the CHECKs that hide them** rather than by reading
them: with `bookings_settled_shape_ck` gone a booking closes with an empty settlement record
and the late writes are still refused by name, and with `bookings_reschedule_shape_ck` gone
the late forward link is still refused. That is the one thing the author could not establish
about their own fix, having written the fix and the CHECKs both.

**Seven findings across three rounds, none outstanding** — one P1 and two P2s in round 1, one
P2 and a provenance item in round 2, nothing in round 3. PART 114's signatures now stand at
**three of three**: author, challenger and coordinator — see Coordinator state below, and
note that each signature names its own SHA.

Round 1, at `51626e1`: **REJECT.**

Round 2, at `76ab277`: the challenger re-ran the suite in its own container
on PostgreSQL 16.15 at `en_US.utf8` under **Node 24.12.0** — 81 of 81, exit code 0 — and
re-planted every mutation rather than reading the answers. All six round-1 findings confirmed
fixed. It verified this round's NEW premise instead of accepting it (41 999 one-day windows
across 330 zones scanned hourly: never more than one transition in 24 hours) and retracted one
probe of its own as its own bug. It left **one residual P2**: R-P9-15's words were wider than
its code, and a settlement reason could still be ADDED to a `completed` or `no_show` booking
after close. That is closed at the subject SHA above as block (a4),
`booking.settlement_after_close`, with a red proof per state, and round 3 confirmed it there.
Report: `/mnt/project-files/phase9/P9-CHALLENGE-76ab277.md`.

Node 24 now has an independent measurement **at this subject SHA**, from round 3. It is cited
as the CHALLENGER's measurement in the CHALLENGER's container, which settles the evidence
question and not the process one: PART 7.6 asks for a rerun from this phase's own container,
and that container ships 22.22.0, so the rerun is still owed at final integration.

Round 1, at `51626e1`: **RUN ONCE, VERDICT REJECT.** An independent challenger
reviewed `51626e1` in its own container on PostgreSQL 16.15 at `en_US.utf8` under Node
24.12.0, read the whole diff against `6fc505d`, verified the digests of all five committed
artifacts, and wrote four probes of its own. Its report is
`/mnt/project-files/phase9/P9-CHALLENGE-51626e1.md` (off-Git, hashed below). Verdict:
**REJECT**, six findings C-P9-01 … C-P9-06, of which two (C-P9-02, C-P9-03) were real
schema defects it proved by execution.

All six were answered at `5f15601` / `76ab277` and each answer is recorded in §3c.12 of the
prep report; the challenger then confirmed all six fixed in round 2.

All six were confirmed closed in round 2, each by re-execution rather than by reading the
answer.

What the challenger recorded as SOUND is listed in its own report and is not re-litigated
here: the no-double-booking invariant, the multi-resource lock order, the CHECK-pinned
blocking window, the replay and its scope boundary, the DST resolver's three branches and
its enforced range, tenant isolation without superuser, resurrection and tampering, and the
absence of the "it merely threw" pattern anywhere but C-P9-04. Round 2 adds to that list
every tampering route it re-planted against R-P9-15 — rewriting the reason, backdating
`settled_at`, clearing a field to NULL, reassigning the closer, repointing the successor and
settling a standing booking — all refused by name, with the lawful closures still passing.

## Coordinator state

**GIVEN at `9a64289`: COORDINATOR-ACCEPT-WITH-SCOPE.** The coordinator reviewed the actual
diff `51626e10d1cbfc8fa41ad59dfebeb55fab1d34c3..9a6428957d6d9f804f493954546a33686b8211f8`
(five commits: `bcfb4fb`, `5f15601`, `76ab277`, `e1b201e`, `9a64289`) against `main` at
`6fc505d`, in its own clone, on 2026-10-12T15:44:14Z. Report:
`/mnt/project-files/phase9/P9-COORD-DIFF-REVIEW-9a64289.md`, hashed below.

**Its method was static and read-only — it ran no database and no tests**, and says so: its
container has Node v22.22.0, so it makes no run claim of its own and every count in it is
attributed to the author or to the challenger by name. Its findings: all eight challenger
findings fixed in code, scope clean, nothing under `migrations/`, no migration number
assigned, and no new grant, policy or role.

**The verdict names `9a64289` only.** `2d10117` — the documentation commit recording the
challenger's PASS — was not reviewed, and nor is the subject of this manifest. The scope
items it asked be closed are closed at the subject SHA above, and they are documentation and
tests only: no `src/` and no DDL change, except the two OPEN DESIGN ITEMS it asked be
*recorded* rather than fixed, which are recorded as comments in the spec and as limitations
18 and 19 of the prep report.

PART 114's three signatures now stand at **three of three** — author, challenger, coordinator
— each at the SHA its own report names, and none of them at this manifest commit, which
carries no code.

## Unresolved blockers

None internal, and none from the challenge: seven findings across three rounds, all
discharged. Every remaining item is external and named above: the predecessor seal, the
migration number, the `bootstrap.sql` patch, the `customers` foreign key, the CI step, the
Coordinator signature, PART 7.6's Node 24 rerun from this container, and the owner's
retention decision.

## What this handoff explicitly does not claim

* Not COMPLETE and not `READY_TO_PROMOTE` (PART 117).
* No canonical CI claim (PART 49) — a branch push is not CI (PART 15).
* No timing or performance number from this container, anywhere (PART 20, PART 123).
* No evidence class mixed: see §3b of the prep report.
* No progress percentage, and no progress claim derived from the case count, the line
  counts or the number of agents (Mission, cross-phase). 87 green cases say what was
  measured, not how much of Phase 9 exists.
* **CLOSED: Node 24 from this container.** It ships v22.22.0 against an `engines` of
  `>=24 <25`, so **Node v24.21.0 was fetched from nodejs.org into the session scratch
  directory** and the suite was run under it on the approved target — 83 of 83, exit code 0.
  PART 7.6's rerun is no longer owed. What this does NOT establish: the container's own
  toolchain still resolves `node` to v22.22.0, so a CI or deployment runner that honours
  `engines` is a different environment from either run here.
* **Not one review of THIS SHA.** The challenger's signature reaches `903e1f4` and the
  coordinator's review names `9a64289`; this subject carries R-P9-16 and three corrections,
  which neither has seen. R-P9-16 is an executable change, not documentation.
* **Not a promotion.** A challenger PASS moves the rung to `CHALLENGED` and nothing further;
  every `READY_TO_PROMOTE` gate below is external and open.
* Business isolation of a registry read is enforced by `booking_replay_result` itself and
  not by row security — a different kind of guarantee from a policy, stated as limitation
  15 of the prep report because the executed attack is what revealed it.
