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
8fc19042fa7a520006fb073edf0707f7f505aa9a
```

Branch: `claude/project-thread-4i752q`
Base:   `6fc505d` (`origin/main`, the sealed Phase 3 head; `frozenThrough 0073` on this base)
Worktree: the session's primary checkout — no secondary worktree was created.
Tree state at this SHA: clean apart from this manifest, which is committed immediately
after it and names the SHA it describes rather than being backfilled into it.

## Artifacts

All four are **committed** to the branch above. The copies under
`/mnt/project-files/phase9/` are off-Git and carry the same bytes; their hashes are
the same values, recorded here because PART 13 asks for a hash on anything that does
not live in Git.

| artifact | location | committed | SHA256 |
|---|---|---|---|
| DDL spec (**not a migration**) | `docs/phase9/P9-BOOKING-DDL-SPEC.sql` | yes | `280cf7f182af34f7557b7aadf6a3ca933cca0f690dd9e5d461dab2c74548ce6c` |
| Migration patch request | `docs/phase9/P9-MIGRATION-PATCH-REQUEST.md` | yes | `b06811f15fb9a2da10c536c8c017a5345de45ec7c2a0844c7ae77363e10b6fca` |
| Scope and architecture | `docs/phase9/P9-S0-SCOPE-AND-ARCHITECTURE.md` | yes | `78d83059aa1014e9bb52f750a17ae59192ec83168a037e1db1dc85d72cae8c76` |
| Prep report (with LIMITATIONS) | `docs/phase9/P9-PREP-REPORT.md` | yes | `092e9ef6ae602780d61ed788e1c077b25c76e5bd96e8bb702e3ab783946b63e6` |
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
| `tests/phase9-prep/p9-booking-time.test.ts` | 16 | the timezone / DST law (PART 51) and its soundness sweep |
| `tests/phase9-prep/p9-booking-runtime-attack.test.ts` | 10 | the schema attacked as the six real runtime roles, no superuser |
| `tests/phase9-prep/p9-booking-spec.ts` | — | the spec loader and its non-vacuity guards |
| `tests/phase9-prep/p9-booking-world.ts` | — | the fixture, applied as `daftar_migrator` |
| `tests/phase9-prep/p9-race.ts` | — | the race harness: `pg_blocking_pids`, never a sleep |

**70 of 70 green**, on a live PostgreSQL 18.4 cluster, the spec applied in one
transaction as the non-superuser deployment principal on top of the sealed Phase 3
head. Run with `npx vitest run tests/phase9-prep`.

There is **no stored evidence artifact** — no saved log is quoted as evidence anywhere,
so there is none to hash. A run is reproduced by the command above, at the SHA above.
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
   §3c.6). This one IS an owner escalation.

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
  counts or the number of agents (Mission, cross-phase). 70 green cases say what was
  measured, not how much of Phase 9 exists.
* Business isolation of a registry read is enforced by `booking_replay_result` itself and
  not by row security — a different kind of guarantee from a policy, stated as limitation
  15 of the prep report because the executed attack is what revealed it.
