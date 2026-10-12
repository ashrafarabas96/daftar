# P14 AMENDMENT 09 — challenge rounds 4 and 5, answered

**Status: `PREPARED / NOT PROMOTED`. `READY_TO_PROMOTE = NO`. Unsigned — this
thread wrote the pack and does not sign its own work.**

Two independent challenge reports are answered here:

| Report | Head reviewed | Verdict | sha256 of the report as received |
|---|---|---|---|
| `P14-CHALLENGE-fcb85f8.md` | `fcb85f8` | REJECT | `6c1ca856…` |
| `P14-CHALLENGE-23b24ca.md` | `23b24ca` | **PASS-WITH-SCOPE** | recorded in the manifest |

Both are committed unedited. The answered head is **not** the reviewed head in
either case, so a further round is owed and no signature carries forward.

## Run commands and exit codes (PART 19 / V3 §9)

Executed in this container on PostgreSQL **16.15** @ `en_US.utf8`, all four
roles under test `NOSUPERUSER` and `NOBYPASSRLS`:

| Command | Result | Exit |
|---|---|---|
| `proofs/replay.sh` | `43 case(s) replayed, 0 not at their required exit code` | **0** |
| `proofs/replay.sh c7` (straight after the full replay — the state round 5 measured as broken) | `36 case(s) replayed, 0 not at their required exit code` | **0** |
| `proofs/replay.sh c7` (immediately again, so a leftover-state failure would show) | same | **0** |
| `proofs/replay.sh c9` | `43 case(s) replayed, 0 …` (c9 is ORDER's last family, so the prefix is all of it) | **0** |
| `proofs/replay.sh nosuchfamily` | `no ORDER line matches … which is an error, not a pass` | **2** |
| `proofs/redproof-preflight.sh` | `5 arm(s), 0 not red` | **0** |
| `proofs/run.sh p14_merchant cases/c7c_assertion_inoperable.sql` on a deliberately dirty database | `PREREQUISITE NOT MET: p14_merchant ALREADY holds SELECT …` | **3** (the refusal, where it used to print a false verdict) |
| `tools/citation-provenance.py --check P14-MIGRATION-PATCH-REQUEST.md` | `generated citation-provenance block is current` | **0** |
| `tools/manifest-digests.py --check` (shared folder) | `22 artifact row(s); every artifact row matches the file on disk, and every file has a row` | **0** |
| `tools/manifest-digests.py --dir . --check` (the repo copy) | same | **0** |

Two things the sweep itself taught, both recorded because they are the round's
own lesson applied to the round's own instruments:

- **the manifest's digests are now generated too** (`tools/manifest-digests.py`,
  with the same `--check`), because they were typed, and this manifest has
  already carried a correct hash beside a wrong description once;
- **the provenance gate initially disagreed with itself**: `--repo` defaulted to
  the working directory, so `--check` said *current* from the repo root and
  *stale* from the pack directory. It now resolves the repository root. A gate
  whose verdict depends on where it is run from is not a gate.

`P14-GATE-035` is added to `P14-TASK-DAG.md` to hold all three of these plus
`redproof-preflight.sh`, and it **blocks any handoff**.

## Round 5 — `P2-01`, the documented one-family command. CLOSED, both halves.

The challenger's measurement is exact and the diagnosis is the one this thread
predicted in round 3: **the same defect, a third layer up.** With a filter,
`replay.sh` skipped the database recreation, the fixture **and** the preflight,
so it could not exit 0 in any state — and in the state a reader is actually in,
`c7d_setup_grant`'s `GRANT` survived into the next run and made
`c7c_assertion_inoperable` print **`FINDING REFUTED`** about the live
`TL-P14-SEC-02` ruling. A leftover grant printed a verdict.

The round-3 prerequisite assertions could not catch it, for the reason the
challenger gives: **they fence one direction only.** They assert that a relation
a case *needs* exists; nothing asserted that state a case needs to be **absent**
is absent. That is Phase 11's closure law tested in the `INSERT` direction only,
inside the machinery built to close the previous round.

Both remedies the report offers are taken, because neither alone is enough —
the driver stopping the fast path does not stop `run.sh` being called by hand,
and the case refusing does not give a reader a working command:

1. **One setup path, taken unconditionally.** The recreation, the fixture and
   the preflight now run whatever the arguments. A filter chooses *how far down
   `ORDER`* the replay goes — the prefix up to and including the last matching
   line, prerequisites included, since `ORDER` is topologically sorted — never
   whether the database is clean. A filter matching nothing exits `2`: an empty
   replay is an error, not a pass. So the one-family result is now fenced on the
   four run-identity claims too, which it was not.
2. **The case asserts the absence it requires.**
   `c7c_assertion_inoperable.sql` now refuses when
   `has_table_privilege('p14_merchant','p14s.outbox_events','SELECT')` is true,
   naming the leftover `GRANT` and the clean-replay command. Measured in the
   granted state it exits **3** with `PREREQUISITE NOT MET` instead of ruling.

**The law this round adds: a case that can rule on state it did not establish
will eventually rule on the wrong world, and it will do so in the pack's own
voice.** The one-directional fence is the mechanism; `FINDING REFUTED` about a
live security ruling is the cost.

## Round 5 — `P3-02`, the orphan script. CLOSED by deletion.

`cases/c7a_cross_business_accepted.sql` was committed, referenced by nothing —
not `ORDER`, not an `\ir`, not `evidence.psv`, not one document — and ended in
`DEFECT CONFIRMED` about `TL-P14-SEC-02`. It is superseded by
`c7a_fk_bypasses_privilege.sql`, which is run and which confirms the defect in
the stronger form, so no claim rested on it. **It is deleted**, because the
alternative leaves a reader holding a script that asserts a security defect with
no way to tell whether it is evidence or litter. 38 case scripts remain.

## Round 5 — `P3-03`, the preflight's unfenced arms. CLOSED on 5 of 6.

`proofs/redproof-preflight.sh` is committed and mutates, requires the preflight
to abort, and reverts, for **collation, encoding, `BYPASSRLS`, `SUPERUSER` and
role count** — 5 arms, 0 not red. The collation arm is the one the challenger
singled out and it matters most: it guards the settled deploy target, and Phase
9 lost a 75-case base to a result measured on the wrong collation.

**The version arm stays UNFENCED and is recorded as unfenced**, not as proved:
it needs a second cluster of a different major version, which this container
does not have. The challenger's own judgement ("may reasonably stay prose") is
not used to upgrade it.

## Round 5 — `P3-04`, `locale-gen`. CORRECTED, with the measurement.

`locale-gen` **does** exist on this image — at `/usr/sbin/locale-gen`, which is
not on a non-root `PATH`. So the finding stands as a defect in the recipe (step
one failed for the challenger and would fail for any unprivileged replayer)
while the stated cause is corrected.

> **BOTH HALVES RETRACTED at round 6.** The reviewer **withdrew** the finding
> after running the command, and this thread's own re-diagnosis — that the
> binary was present but off the `PATH` — was an inference it never executed:
> `/usr/sbin` IS on the unprivileged account's `PATH`. The documents are
> restored to `locale-gen`, the command actually run. See
> `P14-AMENDMENT-10-CHALLENGE-ROUND-6.md` and
> `P14-CHALLENGE-2430504-ADDENDUM-01.md`. The paragraph below records what this
> amendment claimed at the time.
>
> Both `proofs/README.md` and `P14-EVIDENCE-2026-10-12.md` then documented
`localedef -i en_US -f UTF-8 en_US.UTF-8`, gave the absolute path of the other,
and the evidence row still records that the **original** run used `locale-gen`,
because rewriting what was run would be inventing evidence.

## Round 4 — the four carried findings. CLOSED.

**`P2-01` — §15's table is now GENERATED.** `tools/citation-provenance.py`
scans every pack document for `` `path:line` `` citations, resolves each against
`git ls-tree` at the declared base `93084f8`, and compares blobs. The result:

> **35 cited files resolved — 5 DIFFER, 21 identical, 9 ABSENT at `6fc505d`.**

That figure is **this round's**, and it is kept as the record of this round
rather than maintained: `CHALLENGE R6 P2-01` found the scan's pattern carried
seven extensions and not `json`, so the population itself was narrower than the
sentence. The current measurement is only ever the generated block in §15.

The hand-kept table's "six of the fourteen" was wrong, and so was the eleven
inferred from it. The count now lives nowhere but the generated block, and
**`P14-GATE-032` runs `tools/citation-provenance.py --check`**, which exits `1`
when the block has drifted from the trees — the manifest row,
`P14-AMENDMENT-05` and `P14-TASK-DAG` are corrected to the generated figures and
to that obligation. A table that cannot detect its own staleness is a typed
claim again.

**The generator's own first run was wrong, which is this pattern's fourth
appearance.** It reported `absent=0` while `0079` is genuinely absent at
`6fc505d`, because `git rev-parse <rev>:<missing path>` exits non-zero **but
still echoes the ref to stdout**, so a missing file read as a present blob while
only stdout was checked. `0079`'s absence was confirmed against `git` directly
before either the generator or the challenge report was believed; the fix is one
line and the explanation is a comment in the script. **The instrument written to
replace a hand-kept claim must itself be measured.**

A second property of the same kind was found while making the check idempotent:
**the generated block is full of backticked paths, so a scan that read it would
count its own rows** and never reach a fixed point. The generated region is
stripped before scanning. The hand-kept table had the same property, silently,
and that is part of why its count was never going to be right.

**`P2-02` — the per-citation provenance claim is RESTATED, not inflated.** §15
used to read as though each citation carried its own recorded tree. It does not.
The pack has **one declared base**, `93084f8`; the per-*file* record of what
that costs a reader on another tree is the generated table, which also names
which documents cite each file. §15 now says exactly that and no longer implies
per-*citation* provenance.

**`P3-03` — the frozen-migration sentence is CORRECTED.** *Every cited frozen
migration is byte-identical at both trees* was false: `0076`, `0079` and `0086`
do not exist at `6fc505d` at all, all three being Phase 4's unmerged work. The
conclusion survives **for a reason now stated rather than assumed**: every
migration cited *for an RLS policy, a grant or a role* — `0002`, `0003`, `0004`,
`0006`, `0010`, `0014`, `0020`, `0025`, `0045`, `0054` — is byte-identical at
both, and a reader on `6fc505d` cannot check the three absent ones at all rather
than checking them wrongly, which is the better of the two failures.

**And the report's second consequence is recorded, not generalised away.** It is
not true that all three absences are route-surface facts: `0079` is cited as
the **freeze boundary itself** (`frozenThrough =
0079_phase4_pos_till_sessions_cart.sql`, in four places), so **a reader on
`6fc505d` the freeze line is not simply unverifiable.**

> **RETRACTED at round 6, and the retraction is recorded here rather than
> rewritten away.** This paragraph originally said a reader there *could not
> verify the boundary at all*. It was never measured: the boundary is a FIELD,
> in `infrastructure/database/MIGRATION_MANIFEST.json`, which exists at both
> trees and reads `0073_default_warehouse_locale_name.sql` at `6fc505d`. A
> reader verifies it and gets an answer six migrations wrong, which is worse.
> See §15 and `P14-AMENDMENT-10-CHALLENGE-ROUND-6.md`.

**`P3-04` — the ambiguous citations are CITED BY PATH.** An unqualified
errors.ts matched three real files and an unqualified tokens.ts matched two
(written here without backticks on purpose: the generator scans backticked
tokens, so citing them in the paragraph that retires them would resurrect them
in the table). They are now `packages/domain-core/src/errors.ts:6-31` and
`apps/api/src/modules/auth/tokens.ts:105`/`:112`, both verified at `93084f8`.
With the ambiguity gone the generated set is *smaller*: three rows of the
pre-fix run existed only because a basename matched a file the pack never cited.

## What is still owed, and to whom

Unchanged by this amendment: `OD-P14-09`, `OD-P14-10` and `OD-P14-11` are the
owner's; `TL-P14-SEC-01`, `-02` and `-03` sit with their owners; §7a's five
options and §11a's ruling are the Security and Migration Owners'; **no migration
number is written, reserved or exampled anywhere in this pack**, and Phase 14
may not be given one before Phase 13 seals.
