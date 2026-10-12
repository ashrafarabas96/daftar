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
this work stands at **`PREPARED`** and not one rung further: `CHALLENGED` requires an
independent challenger pass, and none has run. The two labels are the same claim in the two
vocabularies.

`READY_TO_PROMOTE` = **NO**. Its gates are external: the roadmap predecessor must seal
first (PART 4), a migration number must be allocated by the one Migration Owner
(PART 6), and the `bootstrap.sql` role patch must be applied by its owner.

## Exact prep SHA

```
69642237295d508d67149b3f2315143206849956
```

Branch: `claude/project-thread-4i752q`
Base:   `6fc505d` (`origin/main`, the sealed Phase 3 head; `frozenThrough 0073` on this base)
Worktree: the session's primary checkout — no secondary worktree was created.
Tree state at this SHA: clean apart from this manifest, which is committed immediately
after it and names the SHA it describes rather than being backfilled into it.

**Evidence subject vs head, reconciled (Mission V2).** The evidence in this handoff was
produced against the subject SHA above; the branch head is one commit later because the
head IS this manifest naming that subject. The two can never be the same string, and the
whole difference between them is one file:

```
git diff --stat <subject> <head>
 docs/phase9/P9-HANDOFF-MANIFEST.md | 10 +++++-----
 1 file changed, 5 insertions(+), 5 deletions(-)
```

No test file, no DDL and no other document differs between them, so a result measured at
the subject is a result about the head's code. Per PART 16 that is stated as a verifiable
relation, not as "the same commit".

## Artifacts

All four are **committed** to the branch above. The copies under
`/mnt/project-files/phase9/` are off-Git and carry the same bytes; their hashes are
the same values, recorded here because PART 13 asks for a hash on anything that does
not live in Git.

| artifact | location | committed | SHA256 |
|---|---|---|---|
| DDL spec (**not a migration**) | `docs/phase9/P9-BOOKING-DDL-SPEC.sql` | yes | `53c14763e8025b4dd1dd5c13aa5cadfbf005bae5881a6fa0cf89c54a71c6fbfa` |
| Migration patch request | `docs/phase9/P9-MIGRATION-PATCH-REQUEST.md` | yes | `1f4f850fbbda7c4bd38b930c70116b19a2f5d75629259b320dc71c11be0b9157` |
| Scope and architecture | `docs/phase9/P9-S0-SCOPE-AND-ARCHITECTURE.md` | yes | `b90129cd9f066fd789ef7659df219a1c9ea95ec62b0f48007558ffccf705ba32` |
| Prep report (with LIMITATIONS) | `docs/phase9/P9-PREP-REPORT.md` | yes | `ce4ca43c8b8df8cca1a10fd63cb983d7402d2d6edee13191204d89c11ff98647` |
| Retention and erasure options | `docs/phase9/P9-RETENTION-AND-ERASURE-OPTIONS.md` | yes | `2c358ced52646829aafff90e1a987feb9af7a73305109a4bb78df699d06deb55` |
| Stored run log at the evidence SHA | `/mnt/project-files/phase9/P9-RUN-LOG.txt` | **no — off-Git** | `14ac1fa02d5b97ef0eda04260d654da36462e56d4d4de01fe36730e1d896d488` |
| This manifest | `docs/phase9/P9-HANDOFF-MANIFEST.md` | yes (next commit) | — |

No artifact is referenced by any of the above that does not exist. There are no
byte-identical duplicates to canonicalize (PART 14).

## Tests and evidence files

| suite | cases | what it measures |
|---|---|---|
| `tests/phase9-prep/p9-booking-schema.test.ts` | 16 | shape, RLS, grants, ownership, end state, the state contract |
| `tests/phase9-prep/p9-booking-concurrency.test.ts` | 11 | no double booking under real concurrency |
| `tests/phase9-prep/p9-booking-negative-controls.test.ts` | 7 | each invariant removed, and the damage measured |
| `tests/phase9-prep/p9-booking-multi-resource.test.ts` | 10 | the global lock order (PART 50), idempotent retries and the replay (PART 53) |
| `tests/phase9-prep/p9-booking-time.test.ts` | 21 | the timezone / DST law (PART 51), its soundness sweep, the measured ±1440 scan, and the two defects V3 named |
| `tests/phase9-prep/p9-booking-runtime-attack.test.ts` | 10 | the schema attacked as the six real runtime roles, no superuser |
| `tests/phase9-prep/p9-booking-spec.ts` | — | the spec loader and its non-vacuity guards |
| `tests/phase9-prep/p9-booking-world.ts` | — | the fixture, applied as `daftar_migrator` |
| `tests/phase9-prep/p9-race.ts` | — | the race harness: `pg_blocking_pids`, never a sleep |

**75 of 75 green, EXIT CODE 0**, on a live PostgreSQL 18.4 cluster, the spec applied in one
transaction as the non-superuser deployment principal on top of the sealed Phase 3
head. Run with `npx vitest run tests/phase9-prep`.

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

Items 1 and 3 are not owner-only escalations under PART 116; item 4 is.

## Challenger state

**NOT STARTED.** No independent Challenger has reviewed this work. Everything in the
prep report is the author's own measurement, and PART 114's three signatures are
therefore **one of three**: author only. This is the single largest gap in the handoff
and it is stated here rather than implied by silence.

## Coordinator state

**NOT GIVEN.** No Coordinator actual-diff review has been performed on this branch.
PART 114 requires it for high-risk changes before promotion; this is preparation, so it
is owed at promotion, not now.

## Unresolved blockers

None internal. Every remaining item is external and named above: the predecessor seal,
the migration number, the `bootstrap.sql` patch, the `customers` foreign key, the CI
step, and the Challenger and Coordinator signatures.

## What this handoff explicitly does not claim

* Not COMPLETE and not `READY_TO_PROMOTE` (PART 117).
* No canonical CI claim (PART 49) — a branch push is not CI (PART 15).
* No timing or performance number from this container, anywhere (PART 20, PART 123).
* No evidence class mixed: see §3b of the prep report.
* No progress percentage, and no progress claim derived from the case count, the line
  counts or the number of agents (Mission, cross-phase). 75 green cases say what was
  measured, not how much of Phase 9 exists.
* Business isolation of a registry read is enforced by `booking_replay_result` itself and
  not by row security — a different kind of guarantee from a policy, stated as limitation
  15 of the prep report because the executed attack is what revealed it.
