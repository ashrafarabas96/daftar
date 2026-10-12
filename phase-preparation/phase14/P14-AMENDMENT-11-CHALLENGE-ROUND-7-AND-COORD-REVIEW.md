# P14 AMENDMENT 11 — challenge round 7, its addendum, and the coordinator's actual-diff review

**Status: `PREPARED / NOT PROMOTED`. `READY_TO_PROMOTE = NO`. Unsigned.**

| Report | Head | Verdict | sha256 as received |
|---|---|---|---|
| `P14-CHALLENGE-583a4a0.md` | `583a4a0` | **PASS-WITH-SCOPE** | `1655d5ea…` |
| `P14-CHALLENGE-583a4a0-ADDENDUM-01.md` | `583a4a0` | confirms `P2-05` **by execution**, raises it to P1, and settles the finding-label clash | `130be952…` |
| `P14-COORD-DIFF-REVIEW-583a4a0.md` | `6fc505d..583a4a0` | **COORDINATOR-ACCEPT-WITH-SCOPE-AND-RESIDUALS**, no P0 or P1 | `018a56a4…` |

All three committed unedited. **Twenty findings are answered here.** The
answered head is not any reviewer's head, so a further round is owed.

## Run commands and exit codes

| Command | Result | Exit |
|---|---|---|
| `tools/gate-sweep.sh` | every gate from **4 working directories** (pack, repo root, `/tmp`, a second worktree of the same repo) with identical codes, then 6 red proofs | **0** |
| `proofs/replay.sh` | `46 case(s) replayed, 0 not at their required exit code` | **0** |
| `proofs/replay.sh c7`, twice | `39 case(s), 0 off` | **0**, **0** |
| `proofs/replay.sh zzz` | an empty replay is an error | **2** |
| `proofs/redproof-preflight.sh` | `5 arm(s), 0 not red` | **0** |
| `proofs/redproof-preflight.sh` **with the cluster STOPPED** | `5 arm(s), 5 not red` — each says the mutation never applied | **1** (it was **0** before this round) |
| `proofs/run.sh p14_resolver cases/c1a_restrict_column_refused.sql` on the dirty end-state | `CONTROL FAILED` | **3** |
| `tools/citation-provenance.py --check` | current, and identical from all four directories | **0** |
| `tools/citation-provenance.py --check --repo /tmp` | `CONFIGURATION ERROR: --pack is not inside --repo` | **2** |
| `tools/manifest-digests.py --check` and `--dir . --check` | 28/28 rows | **0**, **0** |
| `tools/retracted-claims.py --check` | 7 retracted claims enforced across the pack | **0** |

## The one finding that was P1 in effect: the fence passed when nothing ran

`COORD-DIFF-REVIEW P2-05` found it by reading; the challenger's addendum
**executed** it. With no PostgreSQL process running at all,
`redproof-preflight.sh` printed `5 arm(s), 0 not red` and exited **0**, because
redness was decided by `rc -ne 0` and `psql`'s exit `2` means *cannot connect*.
Each arm's mutation exit code was discarded too, so an arm whose `CREATE
DATABASE` never ran still counted as proved.

**`P14-GATE-035` requires that script to exit 0. So the gate fencing every
run-identity assertion passed most reliably when nothing was running.** The
challenger's framing is exact and is adopted: *an assertion that cannot
distinguish "the law failed" from "the question was never asked"*. That is this
pack's own unfenced-assertion law, turned on the fence.

Each arm now requires three things instead of one: its **mutation** to apply,
the preflight to abort with the **specific claim that arm attacks** (not merely
non-zero, and `2` is rejected outright), and its **revert** to apply. And the
fix is itself fenced: `tools/gate-sweep.sh` **stops the cluster**, requires the
script to fail, restarts it, and requires it to pass again — so the no-cluster
case is a red proof and not a story.

## Gate honesty, in one place

Three reviewer findings were the same defect at different addresses
(`R7 P2-01`, `COORD P3-09`), and the pattern had already been "fixed" twice:

- `--repo` came from the **working directory** while `--pack` came from the
  script, so from a foreign cwd — or a second worktree of the same repo — the
  pathspec climbed out with `../..`, git refused it, `was_in_pack` answered
  **False for every token**, the deleted-scripts bucket collapsed, and the gate
  printed `BLOCK IS STALE`. **A location problem reported as a content
  verdict**, with two fixed points selected by cwd. The repository is derived
  from `--pack` now, which is the one argument that cannot be wrong.
- A pathspec that leaves the repository **refuses loudly** (exit 2) rather than
  answering False, so a misconfiguration can no longer become a silent
  misclassification.
- An **absolute** token is no longer resolved against the host filesystem.
- And the property is **measured rather than reasoned about**:
  `tools/gate-sweep.sh` runs every gate from four directories and fails if any
  two disagree — **and fails if they agree on a non-zero code**, because
  consistency is not the pass condition and printing `ok` beside a consistent
  failure would be this pack's recurring defect once more.

## Prose was the unfenced surface, and it now has a gate

`COORD P2-03`, `P2-04`, `P3-10`, `P3-13` and `P3-14` are all one class: a
sentence that described a world which had stopped existing, in a document that
was regenerated around it. The manifest said the pack was on a branch
**that never existed on the remote**, that there were **no commits** and
**nothing pushed**, that every artifact was **off-Git**, and that the
independent challenger was **NOT DISPATCHED** — after six rounds whose reports
are rows in the same table. `README-AR.md`, **the document the owner reads
first**, said nothing had been pushed, gave 45 runs where the evidence says 43,
seven blockers where the manifest lists eleven, and stopped at round 1.

Every one of those is corrected, with what it used to say recorded beside it.
And because `manifest-digests.py --check` validates digests, byte counts and
row/file correspondence while seeing nothing of the narrative, **retractions are
now data**: `tools/RETRACTED-CLAIMS.tsv` lists each retracted claim and the only
files allowed to contain it, and `tools/retracted-claims.py --check` exits 1
anywhere else, with a red proof in the sweep. A challenge report is exempt in
code — those are committed byte-for-byte as received, and editing one to satisfy
a gate would be falsifying a review.

`P14-AMENDMENT-08` now carries an annotation withdrawing its reading that clean
rounds validated the design, and `P14-AMENDMENT-09` carries the retraction of
the freeze-boundary sentence inline rather than having it rewritten away.

## The rest, each closed

- **`COORD P2-01`** — the locale revert was half done: `P14-EVIDENCE` still
  asserted the retracted `PATH` inference *and* added a claim nobody measured
  (*"which an unprivileged replayer can actually run"* — moot, since the harness
  needs root to `su claude`). Both are named as retracted in the row itself.
- **`R6 P3-04` / `COORD P2-02`** — the buckets counted **tokens while saying
  files**, overlapped, and summed to 60 against 59. They now partition the set
  by strict priority with folding for display only, the generator **asserts**
  the five buckets add to the token count, and two misclassifications are gone:
  the deleted orphan no longer leaks into PROPOSES (it leaked because `deleted`
  was folded before `future` was built from *"not in deleted"*), and another
  phase's document is its own category rather than a file Phase 14 proposes.
- **`COORD P3-06`** — `c1a`'s `IF st <> '42501'` was **unreachable**: the
  handler caught only `insufficient_privilege`. It is `WHEN OTHERS` now, and the
  arm is **red-proofed** by renaming the restricted column so the lookup fails
  `42703` while the control columns stay readable: `c1a_lawunproved_expect_3`,
  exit 3, with a proof-of-proof that the rename landed and did not touch the
  control columns, and a revert that asserts its own success. Amendment 10
  described a path that could not happen; it can now, and it is shown to.
- **`COORD P3-08`** — the generated prose credited `--check` with catching a
  proposed file that later appears. It cannot: resolution is pinned to
  `93084f8`. The claim is **withdrawn**, not reworded.
- **`COORD P3-11`** — disclosed: at `93084f8`, `MIGRATION_MANIFEST.json` has
  `frozenThrough = 0079` while its own `policy` text says *"0000–0078 are
  FROZEN"*. Read at the base, not inferred. Not Phase 14's to fix; raised with
  no number and no filename proposed.
- **`COORD P3-12`** — the population excluded `.md` and only top-level pack
  documents were read. `md` is admitted, the walk is recursive, and the block
  **prints how many documents it scanned and which are excluded**.
- **`COORD P3-15`** — the driver's comment misspelled the file in its own
  example and quoted a count that had gone stale. Both measured.
- **`R7 P3-16` / the addendum** — the label clash is settled by its author: the
  withdrawn item was **R5 P3-04**; **R6 P3-04** (the buckets) was open and is
  closed above. Findings carry their round number from here on.

## Still open, and not mine to close

**`COORD P3-07` is accepted and NOT yet closed:** a red proof is judged by exit
code 3 alone, and under `ON_ERROR_STOP` any SQL error exits 3, so an arm can
turn red for an unrelated reason. The proof-of-proof blocks reduce the risk and
do not remove it. The honest fix is an expected SQLSTATE or law name per
red-proof line in `ORDER`, checked by the driver; `c1a_lawunproved_expect_3`
above is the first arm written that way by hand. **It is recorded as OPEN rather
than claimed**, because doing it properly changes every red-proof line and the
next round should review it as its own change.

`OD-P14-09`, `OD-P14-10`, `OD-P14-11` are the owner's. `TL-P14-SEC-01`, `-02`,
`-03`, §7a's five options and §11a's ruling sit with the Security and Migration
Owners. **No migration number is written, reserved or exampled anywhere in this
pack**, and Phase 14 may not be given one before Phase 13 seals.

## What seven rounds plus a diff review actually say

No finding has landed against the architecture, and the reason is not that the
architecture is sound: **it is unexecuted.** There is no API, no DDL, no route
and no CI in Phase 14. The harness and the tools are the only executable things
here, which is exactly why every defect — twenty in this round alone — has been
found in a document, a citation, or the harness. The challenger has adopted this
framing in its own addendum. The first review of the executed phase should be
expected to be the worst one yet, and nothing in these seven rounds is credit
against it.
