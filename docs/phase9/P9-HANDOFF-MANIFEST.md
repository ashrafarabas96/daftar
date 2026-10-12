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
claimed: the same independent challenger has now **run eight times** — REJECT at `51626e1`,
PASS-WITH-SCOPE at `76ab277`, PASS at `9a64289`, PASS-WITH-SCOPE at `903e1f4`, REJECT at
`6e339bf`, PASS-WITH-SCOPE at `0f4f0e4`, PASS-WITH-SCOPE at `01f7c2d` with `C6-P9-01` closed,
and **REJECT at `b6d6101`** on one P1 — a gate of mine that failed open — in the same round
that **withdrew the signatures at `0f4f0e4` and `01f7c2d`** because a repository gate was red at
both — and the coordinator's actual-diff review of `9a64289..01f7c2d` is
**ACCEPT-WITH-RESIDUALS on the schema and the suite**, while **not accepting this handoff
gate**: see the Challenger and Coordinator states below. `READY_TO_PROMOTE` is the next rung
and its gates are external, below. Neither a challenger PASS nor a coordinator accept is a
promotion, and both say so in their own reports.

`READY_TO_PROMOTE` = **NO**. Its gates are external: the roadmap predecessor must seal
first (PART 4), a migration number must be allocated by the one Migration Owner
(PART 6), and the `bootstrap.sql` role patch must be applied by its owner.

## Exact prep SHA

**The subject is the commit this manifest is IN**, which from any checkout of the branch is:

```
git log -1 --format=%H -- docs/phase9/P9-HANDOFF-MANIFEST.md
```

Parent: `eb1046c` — the previous head, which round 8 reviewed as `b6d6101` plus a manifest.
Branch: `claude/project-thread-4i752q`
Base:   `6fc505d` (`origin/main`, the sealed Phase 3 head; `frozenThrough 0073` on this base)
Worktree: the session's primary checkout — no secondary worktree was created.
Tree state: `git status --porcelain` was 0 lines when the run below started, and 0 lines after
the push.

**Why there is no literal SHA printed here, and why that is an improvement.** Until this round
the code landed in one commit and this manifest in the next, so the manifest named an earlier
subject and the head was always one commit ahead of the evidence. Round 8 measured what that
costs: this file published **two different SHA256s for the prep report**, one at each of the two
commits, because the document moved between them. So the documents, the tests and this manifest
now go in **ONE commit** — the subject and the head are the same commit, there is no
reconciliation to state, and the digest tables below cannot disagree with each other. A literal
SHA cannot be written into the commit that contains it; the command above is exact, and
`git log -1 --format=%H -- <this file>` is the same expression the mirror check uses, so a
reader learns one idiom rather than two.

**What that does NOT paper over (PART 16).** The run recorded below was executed on the working
tree that became this commit, with `git status --porcelain` empty at the start — not on the
commit object, which did not exist yet. That is the same relation every pre-commit run has to
its commit, and it is stated rather than implied. A result at any other SHA does not prove this
one, and the stored run log names its own subject in its header.

## Artifacts

**Five documents are committed** to the branch above, plus this manifest in the commit that
follows the subject. Everything else listed here is **off-Git**, under
`/mnt/project-files/phase9/`, and is hashed because PART 13 asks for a hash on anything that
does not live in Git. The `committed` column of the table below is the authority; an earlier
version of this sentence said "all ten are committed", which the table never supported
(coordinator finding F-02).

**The off-Git MIRRORS of the committed documents, and how to re-measure this claim.** Five
committed documents also exist as copies under `/mnt/project-files/phase9/`, for readers who
have no checkout. An earlier version of this section said those copies "carry the same bytes;
their hashes are the same values". **That was FALSE when it was committed**, and both the
seventh challenge round (C7-P9-01) and the coordinator's review (B-1) measured it so: four of
the six mirrored files held a coherent snapshot of an older commit, `e81b079`, among them the
DDL spec — which was the version REJECTED in round 5, carrying neither R-P9-17 nor R-P9-18.
A file that is present, named, hashed and different defeats this gate more completely than an
absent one, because nothing invites a second look.

So the claim is restated as something a reader can measure rather than something that stays
true only while someone keeps the copies in step by hand:

- The mirrors were taken from **the commit in which this manifest last changed** — not from
  the subject SHA above, because this manifest's own commit also touches the prep report, and a
  digest table that named an earlier commit would be stale for that one file on the day it was
  written. That commit locates itself from any checkout:
  `git log -1 --format=%H -- docs/phase9/P9-HANDOFF-MANIFEST.md`.
- Each committed document's SHA256 at that commit is listed below. **Where a mirror differs
  from the digest beside it, the committed blob is the authority and the mirror is stale.**
- One command re-measures the whole claim, from a checkout of this branch:

```
M=$(git log -1 --format=%H -- docs/phase9/P9-HANDOFF-MANIFEST.md)
MIR=/mnt/project-files/phase9
for f in docs/phase9/*; do b=$(basename "$f"); \
  a=$(git show "$M:$f" | sha256sum | cut -d' ' -f1); \
  c=$(sha256sum "$MIR/$b" 2>/dev/null | cut -d' ' -f1); \
  [ "$a" = "$c" ] && echo "SAME $b" || echo "DIFFERENT $b $a $c"; done
# and the other direction, or a renamed or deleted document leaves an ORPHAN
# mirror that the loop above never visits and nobody ever flags:
for m in "$MIR"/*; do b=$(basename "$m"); case "$b" in P9-CHALLENGE-*|P9-COORD-*|P9-RUN-LOG*|P9-EVIDENCE-SHA*|P9-MIRROR-REFRESH-*) continue;; esac; \
  git cat-file -e "$M:docs/phase9/$b" 2>/dev/null || echo "ORPHAN $b — no committed counterpart at $M"; done
```

The second loop is there because round 8 measured that the first one cannot see an orphan: it
walks the committed documents, so a document that is renamed or deleted leaves its mirror
sitting in place, named and hashed and belonging to nothing. The `case` skips the off-Git
artifacts — challenge reports, coordinator reviews, run logs, digest files and refresh records
— which are off-Git BY DESIGN and have no committed counterpart to find.

| mirrored document | SHA256 of the committed blob at `$M` |
|---|---|
| `P9-BOOKING-DDL-SPEC.sql` | `49aad8e0e02366f99516a8670eab7751445e61eacbcdb676f7e74ab989e5eb00` |
| `P9-MIGRATION-PATCH-REQUEST.md` | `c4b3c6e4b2106810cc020824bfadaeaf2701a981da48d0a7c1e8fc8e101480e7` |
| `P9-PREP-REPORT.md` | `dca086b9004a08747313b1d29ab6ddacb0076c07d790024c802ceaf186ed08b1` |
| `P9-S0-SCOPE-AND-ARCHITECTURE.md` | `b90129cd9f066fd789ef7659df219a1c9ea95ec62b0f48007558ffccf705ba32` |
| `P9-RETENTION-AND-ERASURE-OPTIONS.md` | `2c358ced52646829aafff90e1a987feb9af7a73305109a4bb78df699d06deb55` |

This manifest's own mirror is refreshed in the same act and its digest is published in the
refresh record, not here, because a file cannot carry its own hash. **Anyone who edits a file
under `docs/phase9/` invalidates every row above**, which is the point: the next person is
told what they have just made stale, instead of discovering it as a reviewer did. The refresh
is recorded off-Git in `P9-MIRROR-REFRESH-01f7c2d.txt` — named for the subject whose mirrors it
corrected, not for this one — hashed below, with the before-and-after
measurement. **C7-P9-01 / B-1 is not closed by this section**: the coordinator ruled that
closing it needs a measurement by someone who is not the author, and that is the next
challenge round's.

**One commit, one digest per file.** Every SHA256 in the table below for a committed document
is the digest of its blob **at the same commit as the mirror table above**, `$M`. Round 8 found
this file publishing two different digests for `P9-PREP-REPORT.md` — the mirror table at one
commit, this table at another, with no commit named in the column at all — because the manifest
used to land in a commit after the one it described. It no longer does: the documents and this
manifest go in the same commit, so the two tables cannot disagree, and the column says which
commit it means.

| artifact | location | committed | SHA256 at `$M` |
|---|---|---|---|
| DDL spec (**not a migration**) | `docs/phase9/P9-BOOKING-DDL-SPEC.sql` | yes | `49aad8e0e02366f99516a8670eab7751445e61eacbcdb676f7e74ab989e5eb00` |
| Migration patch request | `docs/phase9/P9-MIGRATION-PATCH-REQUEST.md` | yes | `c4b3c6e4b2106810cc020824bfadaeaf2701a981da48d0a7c1e8fc8e101480e7` |
| Scope and architecture | `docs/phase9/P9-S0-SCOPE-AND-ARCHITECTURE.md` | yes | `b90129cd9f066fd789ef7659df219a1c9ea95ec62b0f48007558ffccf705ba32` |
| Prep report (with LIMITATIONS) | `docs/phase9/P9-PREP-REPORT.md` | yes | `dca086b9004a08747313b1d29ab6ddacb0076c07d790024c802ceaf186ed08b1` |
| Retention and erasure options | `docs/phase9/P9-RETENTION-AND-ERASURE-OPTIONS.md` | yes | `2c358ced52646829aafff90e1a987feb9af7a73305109a4bb78df699d06deb55` |
| Stored run log at the evidence SHA | `/mnt/project-files/phase9/P9-RUN-LOG.txt` | **no — off-Git** | `92dea85ad38b47ae3be0eff1c2fd26409c3289e9a4c47d3a8f069d6079642147` |
| Independent challenger's PASS-WITH-SCOPE at `0f4f0e4` | `/mnt/project-files/phase9/P9-CHALLENGE-0f4f0e4.md` | **no — off-Git** | `44aad5193b4c22b3cb8ff24f8f25b5d1196de496ab6d7ffe930d4abc0ca66371` |
| Independent challenger's REJECT at `6e339bf` | `/mnt/project-files/phase9/P9-CHALLENGE-6e339bf.md` | **no — off-Git** | `142f861726e3456d198433ab57d8aac4785802862645dac962bdae426fe9ced4` |
| Independent challenger's PASS-WITH-SCOPE at `903e1f4` | `/mnt/project-files/phase9/P9-CHALLENGE-903e1f4.md` | **no — off-Git** | `54b8f4d24cc087f6b3757b789c6eed4012265e792f0cefd79ae72e38fb06dbb3` |
| Coordinator actual-diff review at `9a64289` | `/mnt/project-files/phase9/P9-COORD-DIFF-REVIEW-9a64289.md` | **no — off-Git** | `bc8fcfa4f13545c92036dc864e2bacb9175fe8e4783aaa6a21afe66c6286443c` |
| Independent challenger's PASS at `9a64289` | `/mnt/project-files/phase9/P9-CHALLENGE-9a64289.md` | **no — off-Git** | `9fe72d8f3f0337732cf32e251a5365a4a35eda7959fb8c42c00d20d19c3611d9` |
| Independent challenger's PASS-WITH-SCOPE at `76ab277` | `/mnt/project-files/phase9/P9-CHALLENGE-76ab277.md` | **no — off-Git** | `67742ec1c85916505af86f1bb3a9699833af604e77e899ef9ca8bd653ac532a6` |
| Independent challenger's REJECT at `51626e1` | `/mnt/project-files/phase9/P9-CHALLENGE-51626e1.md` | **no — off-Git** | `d5b751c6a6da094d9ccb428414ec886d27c45b2a0a2011351e17bb9f50c8d577` |
| Independent challenger's PASS-WITH-SCOPE at `01f7c2d` (round 7) | `/mnt/project-files/phase9/P9-CHALLENGE-01f7c2d.md` | **no — off-Git** | `f12333dda03335828b6302c1beec1fac7d82ce0b9c3f9dd02b270991f02e7ca7` |
| Coordinator actual-diff review at `01f7c2d` | `/mnt/project-files/phase9/P9-COORD-DIFF-REVIEW-01f7c2d.md` | **no — off-Git** | `02fadfc2b996ea0424c5c82bc2a7c5ef9cc60b1d2d96fc9d3b7cdfaa249d2449` |
| Mirror refresh record (C7-P9-01 / B-1) | `/mnt/project-files/phase9/P9-MIRROR-REFRESH-01f7c2d.txt` | **no — off-Git** | `168e8be09f920bc668b767a416b9c89cdf5bbfba7c322d463688e3be6e475828` |
| Independent challenger's REJECT at `b6d6101` (round 8) | `/mnt/project-files/phase9/P9-CHALLENGE-b6d6101.md` | **no — off-Git** | `3815e04b9420077e4b7868a655fa44a5edcc27c8eeaae18c7803e29cb48177b9` |
| Stored run log and digest record for THIS subject | `/mnt/project-files/phase9/P9-RUN-LOG-<subject>.txt`, `P9-EVIDENCE-SHA-<subject>.txt` | **no — off-Git** | written after this commit, with the subject SHA in the filename and in the header; the digest record carries its own `sha256sum -c`-verifiable lines |
| This manifest | `docs/phase9/P9-HANDOFF-MANIFEST.md` | yes (next commit) | — |

No artifact is referenced by any of the above that does not exist. There are no
byte-identical duplicates to canonicalize (PART 14).

## Tests and evidence files

| suite | cases | what it measures |
|---|---|---|
| `tests/phase9-prep/p9-booking-schema.test.ts` | 25 | shape, RLS, grants, ownership, the state contract, collation independence, and the end state — both deferred guards pinned as ONE ROW (table, function, enabled, events, deferral, WHEN clause) with a red proof for each of round 8's three wrong triggers and a deletion proof per condition |
| `tests/phase9-prep/p9-booking-concurrency.test.ts` | 11 | no double booking under real concurrency |
| `tests/phase9-prep/p9-booking-negative-controls.test.ts` | 7 | each invariant removed, and the damage measured |
| `tests/phase9-prep/p9-booking-multi-resource.test.ts` | 10 | the global lock order (PART 50), idempotent retries and the replay (PART 53) |
| `tests/phase9-prep/p9-booking-time.test.ts` | 21 | the timezone / DST law (PART 51), its soundness sweep, the measured ±1440 scan at one-day granularity, and the two defects V3 named |
| `tests/phase9-prep/p9-booking-integrity.test.ts` | 24 | the closure record is write-once (R-P9-15), a booking is born standing (R-P9-16) and the reschedule chain agrees with itself (R-P9-17) and ends in a booking that is kept (R-P9-18) — the defects seven independent rounds found, each law's red proof and its non-vacuity, the walk reached in isolation by a write that changes nothing, and the ceiling measured as enforced |
| `tests/phase9-prep/p9-booking-runtime-attack.test.ts` | 11 | the schema attacked as the six real runtime roles, no superuser, and the deferred chain check proved to fail CLOSED when row security blinds it |
| `tests/phase9-prep/p9-booking-spec.ts` | — | the spec loader and its non-vacuity guards |
| `tests/phase9-prep/p9-booking-world.ts` | — | the fixture, applied as `daftar_migrator` |
| `tests/phase9-prep/p9-race.ts` | — | the race harness: `pg_blocking_pids`, never a sleep |

**109 of 109 green, EXIT CODE 0**, on the APPROVED TARGET — a live PostgreSQL **16.15**
cluster whose `datcollate` and `datctype` are both **`en_US.utf8`** (HIGH-VELOCITY V1 PART
1.3; PART 19 requires the version and the collation) — with the spec applied in one
transaction as the non-superuser deployment principal `daftar_migrator` on top of the sealed
Phase 3 head. Run with `node ./node_modules/vitest/vitest.mjs run tests/phase9-prep --reporter=verbose`,
`PG_DIR=/tmp/daftar-pg16 PG_PORT=55433`, started 2026-10-12T21:49:32Z, finished 21:53:17Z,
under **Node v24.21.0** — this phase's own Node 24 run, which PART 7.6 asked for.

**The repository's own gates at the same tree**, run after a clean `npm ci` (**exit code 0**)
and by their own script names, not by a narrower command standing in for them:
`npm run format` — `prettier --check .` — **exit code 0**, and `npm run lint` —
`eslint . --max-warnings 0`, the whole repository and not just this phase's directory —
**exit code 0**. The format gate was **RED at
`99695bb`** on three Phase 9 files and is fixed in the subject commit; §3c.20 of the prep
report measures it. The root `npm run build` and `npm run typecheck` are red cold on `main`
itself (tracked as G6) and are not claimed here as passing.

Earlier runs of this line's trees are in the stored run logs with their exit codes, **the red
ones included** — a mutation helper that matched the ceiling's token inside a comment I had
just written, the scheduling-coincidence assertion of §3c.20, and an end-state assertion whose
paren nesting I wrote from memory and which refused the migration outright. They are published
because a run log that contains only green runs is a selection, not a record.

The same set was then run under Node v22.22.0 on PostgreSQL 16.15 (17:55:54Z to 17:58:53Z)
and on PostgreSQL 18.4 at collation `C` (17:58:53Z to 18:02:50Z) — **97 of 97, EXIT CODE 0**
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

**RUN EIGHT TIMES. Round 8 at `b6d6101`: REJECT on one P1 — a gate of mine that failed open —
and TWO EARLIER SIGNATURES WITHDRAWN. The signatures that stand are at `9a64289` and
`903e1f4`. No signature names THIS subject, which answers round 8.**

Round 8 reviewed `b6d6101`: **102 of 102, exit code 0** on its own fresh PG 16.15 at
`en_US.utf8` under Node v24.12.0, with `prettier --check .` and `eslint . --max-warnings 0`
both exit 0 at that subject. Report: `/mnt/project-files/phase9/P9-CHALLENGE-b6d6101.md`,
hashed above.

**C8-P9-01 (P1): the end-state gate for the deferred triggers FAILED OPEN.** I had asked it to
land a trigger that passes my new `(h3)` and is still the wrong trigger; it landed three, and in
each the 2-ring commits with no refusal — the shipped trigger with `DISABLE TRIGGER` applied, a
same-shaped trigger executing a do-nothing function, and no trigger on `bookings` at all beside
a same-name decoy on another table. `tgrelid`, `tgfoid` and `tgenabled` were unpinned, and the
four checks were separate `NOT EXISTS` clauses over a name, which need not be satisfied by the
same row. The same gap existed in `bookings_buffers_are_the_service_s`. Both are now one
`NOT EXISTS` over a single joined row, with six red proofs and a deletion proof per new
condition; §3c.21 of the prep report records it.

**`C7-P9-01` / `B-1` is CLOSED by round 8**, on a measurement that is not the author's: the
published command resolved this file's commit to `eb1046c` and gave 6 of 6 SAME, and the
challenger then made the gate red three ways, which is the part I had not done. **The CONTROL 2
relaxation is ruled NOT a weakening**, against its own eight-race formulation and a
drop-the-constraint red proof.

**Two signatures withdrawn.** Under the Phase 4 round-20 ruling — a head that turns a repository
gate red carries no signature — `prettier --check .` was red at `0f4f0e4` and at `01f7c2d`, so
the round-6 and round-7 signatures are withdrawn in round 8's own report.

**The seventh round, for the record.**

Round 7 reviewed `01f7c2d` in its own container: PostgreSQL 16.15 at `en_US.utf8` from a
fresh `initdb` (no crash-recovery line, no `FATAL`, no `PANIC`), Node v24.12.0, the spec
applied as `daftar_migrator`, one vitest process — **97 of 97, exit code 0, twice**, tree
clean before and after each, **13 of 13 digests verified**, and a statement-level delta of
`140 → 140` with exactly two statements replaced: the function body and its `COMMENT`, with
no constraint, trigger, index, grant, policy or owner among them. Report:
`/mnt/project-files/phase9/P9-CHALLENGE-01f7c2d.md`, hashed above. Its signature covers the
schema and the suite and **explicitly not this manifest's artifact table**, which is where
its blocking finding is.

**C6-P9-01 is closed with a completeness result**, not an absence of findings. Asked to find
a ring this schema's single-transaction case does not already cover, it measured four more
shapes — a backlink written onto a standing and onto a closed row (`booking.immutable` both),
four rows born with circular backlinks (`booking.chain_asymmetric`, zero rows), a tail closed
onto the head in a later transaction (`booking.chain_asymmetric`), two concurrent transactions
each holding half of a 2-ring (both die on the deferred composite FK), and a lasso
(`booking.chain_is_a_ring`) — and then showed why no such ring exists: a link's two halves are
a birth and a close, R-P9-17 is deferred so they share a transaction, around a ring those
pairings chain through every row, and agreement in both directions makes in- and out-degree at
most one, so the forward-link graph is paths and cycles and R-P9-18 removes the cycles.

Its three findings — the false mirror claim (`C7-P9-01`), the walk's branch being independently
reachable after all (`C7-P9-02`) and the ceiling being an enforced limit (`C7-P9-03`) — are
answered in the subject commit, with five cases added so this repository measures them too.
§3c.19 of the prep report records them, including one correction of the challenger's own report
and one count where it was right and I was further wrong: four mirrors were stale, not three.

Round 6 reviewed `0f4f0e4` and re-ran the suite on its own fresh PG 16.15 at `en_US.utf8`
under Node v24.12.0: **93 of 93, exit code 0**, 12 of 12 digests, normalised spec delta
`135 → 140` statements and all of it R-P9-17. Run id
`P9-CHALLENGE-R6-20261012T173352Z`. Report:
`/mnt/project-files/phase9/P9-CHALLENGE-0f4f0e4.md`, hashed below.

**C5-P9-01 is closed.** Both of R-P9-17's clauses load-bearing and orthogonal, six pair-drop
combinations against the born guard and immutability with no masking in any direction, the
`chain_unreadable` refusal reproduced under the challenger's own restrictive policy, and the
**deferral measured as load-bearing**: set the constraint `IMMEDIATE` and the LAWFUL
reschedule is refused at the successor's INSERT. It also planted the `IS NULL` idiom this
author had rejected and measured that it commits the defect, because in the asymmetric case
the counterpart's link is itself NULL.

**Concurrency is now MEASURED, and limitation 20 is rewritten against the author.** Both
races with `pg_blocking_pids`: the conclusion held, and the mechanism this author predicted
was wrong for race A, which is refused by `booking.immutable_settlement` because the
row-level re-evaluation reaches R-P9-15 first. Recorded as conclusion measured, mechanism
revised.

**Its one P2 is C6-P9-01: a pairwise check cannot see a ring.** A 2-ring and a 3-ring
committed in one transaction, five rows whose every pairwise check holds and whose chains
reach no booking anybody keeps. Closed at the subject SHA above as **R-P9-18**
(`booking.chain_is_a_ring`, with `chain_unterminated` and `chain_too_long` as defence in
depth), with four cases including a red proof that cuts the block out of the live function
body and restores it byte-identical, §3c.18 of the prep report. The challenger had also
measured which fix NOT to take, and that measurement is why the law is about termination
rather than about the next row's state.

**Round 5 at `6e339bf`: REJECT.**

Round 5 re-measured the whole of R-P9-16 and passed it — eight births each refused by name,
seven of the eight accepted once the guard is removed, no masking against the shape CHECKs
pair-dropped, every lawful path unbroken, **87 of 87 exit code 0** on its own fresh PG 16.15
at `en_US.utf8` under Node v24.12.0, 11 of 11 digests verified, and the tokenised comparison
repeated: 50 541 → 52 284 normalised characters, 131 → 135 statements, the whole executable
difference being the guard and its own bookkeeping. Run id
`P9-CHALLENGE-R5-20261012T164403Z`. Report:
`/mnt/project-files/phase9/P9-CHALLENGE-6e339bf.md`, hashed below.

**Its one P1 is C5-P9-01, and it is right.** The asymmetric reschedule chain was still
reachable through the CLOSE — the first write of the forward link, and the only verb of the
three an ordinary caller performs. Four disagreeing chains were committed at that subject.
Closed at the subject SHA above as **R-P9-17** (`bookings_chain_symmetric` on the deferred
constraint trigger `bookings_chain_agrees`; `booking.chain_asymmetric`,
`booking.chain_unreadable`), with seven red proofs including the row-security fail-closed
case, §3c.17 of the prep report. Its two P3s — the guard's state clause unheld by any case,
and the missing lone `settled_by_user_id` shape — are closed in the same commit. **This is
an executable schema change, so no earlier signature reaches it.**

**Round 4 at `903e1f4`: PASS-WITH-SCOPE, and its signature extends there.**

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

**GIVEN at `01f7c2d`: ACCEPT-WITH-RESIDUALS on the schema and the suite, and this handoff
gate NOT ACCEPTED.** The coordinator reviewed the actual diff `9a64289..01f7c2d` in its own
clone, reproduced **97 of 97, exit code 0** on PostgreSQL 16.15 at `en_US.utf8` under **Node
22** — it states that it cannot verify the Node 24 runs or the PostgreSQL 18.4 comparison,
both of which are mine — and ran the ring walk itself on a self-loop, a 2-ring, a 3-ring and
a ring entered from a tail, finding it terminates and fails closed on each, with no other verb
creating the forbidden state, every lookup keyed `(business_id, id)`, and no definer trusting
a caller-supplied id. Report: `/mnt/project-files/phase9/P9-COORD-DIFF-REVIEW-01f7c2d.md`,
hashed above.

**Its blocking finding B-1 is this file's mirror claim**, the same defect as `C7-P9-01`: false
from the moment it was committed, true only from my out-of-band refresh, and — as committed —
true only while someone keeps the copies in step by hand. Its ruling is recorded in its own
words: *the gate is a claim in a committed file.* The Artifacts section above is rewritten to
answer it, and **B-1 stays open until someone who is not its author measures it**, which is
the coordinator's own condition.

Its residuals F-02 through F-09 are each answered in the subject commit and recorded in
§3c.20 of the prep report: the artifact count restated against its own table, the stale spec
comment that contradicted `bookings_born_booked_only`, the definer and guard counts, the stale
status lines in this file, and the chain trigger's event mask and `WHEN` clause now pinned both
in the spec's end-state block and from the suite. F-10 and F-11 are its corrections of round 7
and of my own refresh record, both accepted.

**The earlier review, for the record.** The coordinator reviewed the actual
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
— each at the SHA its own report names. Round 7 and this review both name `01f7c2d`; **none of
them names the subject of this manifest**, which answers their findings, and none names this
manifest commit.

## Unresolved blockers

**One internal and it is mine: `C8-P9-01`, a gate of my own that failed open.** Round 8 landed
three wrong triggers past the end-state check I had just added for F-09, and in each one the
2-ring commits. Both deferred guards are rewritten as one-row identity predicates at the subject
SHA above, with six red proofs and a deletion proof per new condition — **and the author does
not sign their own fix** (PART 15), so this is answered and not closed.

`C7-P9-01` / `B-1` **is closed**, by round 8's own measurement rather than mine, which is the
condition the coordinator set.

Fifteen findings across eight rounds, plus eleven coordinator residuals, are all discharged in
code or in prose at the subject SHA above. **The signatures that stand are at `9a64289` and
`903e1f4`**: the round-6 and round-7 signatures were withdrawn in round 8 because
`prettier --check .` was red at the heads they named. Nothing signs this subject.

Every other remaining item is external and named above: the predecessor seal, the migration
number, the `bootstrap.sql` patch, the `customers` foreign key, the CI step, and the owner's
retention decision. PART 7.6's Node 24 rerun is closed and was redone at this subject.

## What this handoff explicitly does not claim

* Not COMPLETE and not `READY_TO_PROMOTE` (PART 117).
* No canonical CI claim (PART 49) — a branch push is not CI (PART 15).
* No timing or performance number from this container, anywhere (PART 20, PART 123).
* No evidence class mixed: see §3b of the prep report.
* No progress percentage, and no progress claim derived from the case count, the line
  counts or the number of agents (Mission, cross-phase). 109 green cases say what was
  measured, not how much of Phase 9 exists.
* **CLOSED: Node 24 from this container.** It ships v22.22.0 against an `engines` of
  `>=24 <25`, so **Node v24.21.0 was fetched from nodejs.org into the session scratch
  directory** and the suite was run under it on the approved target — 109 of 109, exit code 0.
  PART 7.6's rerun is no longer owed. What this does NOT establish: the container's own
  toolchain still resolves `node` to v22.22.0, so a CI or deployment runner that honours
  `engines` is a different environment from either run here.
* **Not one review of THIS SHA.** Both the challenger's seventh signature and the
  coordinator's review name `01f7c2d`. This subject is the commit that answers their findings,
  including a schema change for F-09 and five new cases, and no round has seen it. A fix is not
  a signature.
* **The format gate's history is disclosed, not quietly fixed.** `prettier --check .` was red
  from `0f4f0e4` through `99695bb`, and nobody had run it. Round 8 measured the gate at every
  candidate SHA in a clean worktree: exit 0 at `9a64289`, `903e1f4`, `6e339bf` and the subject;
  **exit 1 at `0f4f0e4`, `01f7c2d` and `99695bb`**, the same three files at each. It is green at
  the subject; what that does not undo is that it was red while this file claimed the work was
  ready for a handoff gate, and that the challenger has **withdrawn two signatures** over it.
* **Not a promotion.** A challenger PASS moves the rung to `CHALLENGED` and nothing further;
  every `READY_TO_PROMOTE` gate below is external and open.
* Business isolation of a registry read is enforced by `booking_replay_result` itself and
  not by row security — a different kind of guarantee from a policy, stated as limitation
  15 of the prep report because the executed attack is what revealed it.
