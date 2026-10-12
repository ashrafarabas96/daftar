# P14 — AMENDMENT 16: the coordinator's re-review at `a725342`, and the challenger's narrow check, answered

**Status: `PREPARED / NOT PROMOTED`. DOCS ONLY. ALL GATES UNMEASURED.**
**Base `93084f8`. Branch `claude/project-thread-1zqgj8`, cut from `6fc505d`; committed and
pushed on that branch only. No product code, no migration, no migration number.**
No timing or performance claim is made anywhere in this pack.
**Unsigned.** An author does not sign their own work.

Two reviews of `a725342` arrived within minutes of each other and are answered in one commit,
as the coordinator asked:

| review | file, as received | verdict |
|---|---|---|
| **Coordinator actual-diff re-review** of `c812aa5..a725342` | `P14-COORD-DIFF-REVIEW-a725342.md`, sha256 `5cc8305d561c…ed8a2bb38`, 23,705 bytes | **REJECT (narrow)** — blockers 2 and 3 CLOSED, blocker 1 closed for every measured world **except one new route**, plus six P3s |
| **Independent challenger narrow check** at `a725342` | `P14-CHALLENGE-a725342.md`, sha256 `d6917dbbd9fb…fd0c3d3e`, 11,507 bytes | **PASS-WITH-SCOPE**, nothing blocking, four residuals |

Both are committed unedited with a row each in `P14-HANDOFF-MANIFEST.md` §2.

## 1. `P2-01-bis` (BLOCKING) — a deletion revision is not a truncation, and I had made it one

**The route.** Two ordinary commits: `git rm P14-HANDOFF-MANIFEST.md`, then re-add the file
carrying a forged reviewer row. Nothing is force-pushed, rebased or filtered.

**Why it worked.** `tools/manifest-digests.py` treated **any** revision it could not read as a
truncation: it emptied `signed_history` and `moved` and labelled the history `NOT CHECKED`. A
deletion commit is unreadable in exactly that way, so two commits **discarded** a witness that
seventeen readable revisions still carried — and with the counterpart edited in step, both
`--check` and `--write` answered **0** on a world Amendment 15 claimed was closed and red-proofed
as `reviewer-row-forged-both-dirs`.

**The sentences that were wider than the code, and are corrected here:**

- `P14-AMENDMENT-15:…` §1: *"A commit cannot move the witness; `git filter-branch` or a
  force-push can."* **False**: two commits do not move it, they discard it.
- `tools/manifest-digests.py`'s own comment: *"which no later commit can erase"*.
- `P14-TASK-DAG.md` `P14-GATE-035`: *"What a commit still can do is rewrite the manifest's
  history; that is named, not guarded."*
- `README-AR.md` §6: «وأي مراجعة لاحقة تخالفها تُرفض بذاتها» — after a drop and re-add no
  revision was compared at all.

**What is enforced now.** The walk distinguishes the two cases it had conflated, because they are
not the same fact:

| what the walk meets | what it does | why |
|---|---|---|
| the revision's **commit object** is missing (graft boundary, unfetched, corrupt) | `NOT CHECKED`, and the witness is **discarded** | the records at and below it are genuinely gone; the oldest digest visible may already be a forgery |
| the commit is readable and the **manifest is absent** in it (a deletion, or a rename) | the revision is **skipped and recorded** | the revisions BEFORE it are readable, and so is the digest the report was received with. A deletion erases nothing |
| the commit is readable, the path is there, the **blob** cannot be read | `NOT CHECKED` | unreadable is unreadable |

> **ANNOTATED AT ROUND 12 (`R12-P1-01`, BLOCKING).** The third row of that table was **the
> design, not the code**. The walk asked `git cat-file -e <rev>:<path>`, which fails for the
> second row and the third row alike, so a tree entry with an unavailable blob was recorded as a
> deletion and the history still printed *checked*. The table was a sentence wider than the
> measurement under it; the discrimination it describes is enforced from
> `P14-AMENDMENT-17-CHALLENGE-ROUND-12.md` onward, by asking `git ls-tree` instead. Read this
> table as the intent of that commit and not as its behaviour.

The history line now also says how many revisions the manifest is absent in and names them, so a
drop and re-add is visible to the reader rather than inferred: *"checked over every revision …
and the manifest is ABSENT in 1 of them (a43f7894dca5) — removed and re-added, which does not
erase the records before it"*.

**Measured**, in a constructed world (four commits: received → one line appended to a received
report → `git rm` the manifest → re-add it with the forged row), counterpart edited in step:

| tool | `--check` | `--write` | refusal |
|---|---|---|---|
| this head | **1** | **1** | `REVIEWER ROW REWRITTEN IN HISTORY: … recorded as 2d853e577c51 when it was received, and a later revision (fab16b22f49b) records 9c4be3cfada0` |
| `a725342`'s `manifest-digests.py`, extracted with `git show` | **0** | — | none; `NOT CHECKED (revision a43f7894dca5 … could not be read)` |

Red proofs: `manifest-dropped-and-readded` and `manifest-dropped-and-readded-write`, both built
by the sweep itself and asserted by that sentence.

## 2. `NOT CHECKED` no longer exits 0 — which closes the challenger's `R11-P2-01` with the same change

The coordinator and the challenger found one root between them: **an announced blind spot still
exits 0, and an exit code is what a gate is read by.** The challenger's world was a `--depth 1`
clone with a matching counterpart; the coordinator's was the drop/re-add route. The second is now
a refusal because the witness survives; the first is a real limit — nothing inside a truncated
clone can see the digest a report arrived with — so it is a **refusal by default**:

- default: history `NOT CHECKED` **and** a reviewer row present → `HISTORY NOT VERIFIED`, rc 1.
- `--allow-unverified-history`: the caller accepts the limit deliberately; the limit is still
  printed, and the proof requires that it is.

My first attempt at this, earlier in the same working session, had the default the other way
round (`--require-history` as an opt-**in**). That is the same mistake in the opposite direction:
**the safe thing has to be what happens when nobody passes a flag.** A CI job needs
`fetch-depth: 0`, because `actions/checkout` defaults to depth 1.

Red proofs: `shallow-counterpart-refused` (rc 1, `HISTORY NOT VERIFIED`),
`shallow-optin-prints-the-limit` (rc 0 **with** `NOT CHECKED` in the same output, so the opt-in
cannot hide it), `shallow-no-witness-names-the-clone`.

## 3. The challenger's four residuals

| # | finding | what I did |
|---|---|---|
| `R11-P2-01` | a truncated clone with a counterpart answered 0, announced but with the consequence stated nowhere, and Amendment 15's evidence row dropped the qualifier §1 carried | **Closed by §2**, which refuses instead of announcing. The consequence is stated in Amendment 15 §1 and the evidence row carries the qualifier |
| `R11-P2-02` | `NO WITNESS` said *no digest in any revision of this manifest* in a clone that cannot see seventeen revisions that record one — the **sixth** instance of one class | **Closed.** The refusal is written from the variable it read: `no digest for it is visible in the revisions this clone has`, pointing at `fetch-depth: 0` |
| `R11-P3-01` | the `moved` refusal printed a remedy the reviewer had already carried out | **Closed as a sentence.** It says the refusal **cannot be cleared from here**, that this is deliberate because the forging revision stays in the record, and what to do instead: say so in the handoff and have the reviewer re-send the report |
| `R11-P3-02` | `R10-ADD-01` is load-bearing, not theoretical | **Recorded** in Amendment 15 §1 and §6. With `NOT CHECKED` now refusing, the case where the two-directory witness is the only one left is a refusal rather than a pass — but the limit itself stands and is not to be called a second witness after promotion |

## 4. The coordinator's six P3s

| # | finding | what I did |
|---|---|---|
| `--write` exited 0 while printing `SIGNED REVIEWER ROW REMOVED` | a gate reading the code alone saw a pass | **Closed.** That refusal is in the refused list, so `--write` exits 1 |
| the same refusal called an amendment's row a *reviewer* row | *"A received review is not deleted"* for a document that is not a review — the class again | **Closed.** A non-reviewer row gets its own sentence: a pack document may be withdrawn, but not silently |
| a committed-then-reverted forgery stays red forever, with an unachievable remedy | the behaviour is intended; the sentence was not | **Closed as a sentence**, as `R11-P3-01` above |
| `R-11` only partial: the trap was installed after the worktree, and `INT`/`TERM` did not stop the sweep | a signal in between left a worktree registered, and the sweep carried on cleaning up under itself | **Closed.** The trap is installed **first**, restores only what it finds, removes the worktree, and `INT`/`TERM`/`HUP` print one line and exit 130/143 |
| the generated *outside documents* bucket listed a misspelled pack document name | which is a false sentence about it: `P14-AMENDMENT-11-CHALLENGE-ROUND-7.md` lives nowhere | **Closed.** A token spelled like one of this pack's own documents and absent from the pack gets its own bucket and its own sentence — a name that exists nowhere, either a typo or a wrong name quoted as wrong. The partition assertion now covers six buckets |
| typed counts inside Amendment 15 itself (84/89, 1, 110) and *ten of eleven* | the P2-03 lesson broken in the document that records it | **Closed.** The bucket sizes are not typed; they are cited to the generated block. All eleven residuals were closed, and `R-11`'s partial state is now stated where it is claimed |

**The gap the coordinator notes and I agree with:** there is still no red proof that plants a pack
file in a **new** directory and requires it to stay out of PROPOSES. The `os.walk` removes the
hand-kept list that caused it, but the property is not fenced. Recorded as a residual rather than
claimed.

## 5. What I take from this round

- **I fixed `NOT CHECKED` discarding the witness and did not ask who can create a gap.** The
  graft boundary is outside the author's hand; a deletion commit is inside it. One rule covered
  both, and the inside-the-hand case is the one that matters. **Ask of every "cannot read" branch:
  who can cause it?**
- **An announced limit is not a closed one.** Printing `NOT CHECKED` and exiting 0 is a pass, and
  a reader of a gate reads the code. Two reviewers found that from two directions in one hour.
- **Three rounds, one defect class, and this is the fourth:** the sentence was wider than the
  measurement. The cure that is working is mechanical — each false sentence becomes a row in
  `tools/RETRACTED-CLAIMS.tsv`, so it cannot return in a later edition.
- **The wrong-cause class is now seven instances**, counting the amendment row called a reviewer
  row. The rule stands: **write the refusal from the variable it actually read.**

## 6. What was executed, with the path each code was measured from

Host `vm`. Pack `/home/user/daftar/phase-preparation/phase14`, repository `/home/user/daftar`
(a shallow clone whose boundary is far below the manifest's first record, so the history lane is
`checked` here), shared folder `/mnt/project-files/phase14`, PostgreSQL 16.15 on
`/tmp/p14pg/sock:54314`, `en_US.utf8`. **No timing or performance figure is taken from this
container.**

| command | cwd | rc |
|---|---|---|
| `bash tools/gate-sweep.sh` (run `2026-10-12T20:25:53Z`, cluster up) | `…/phase14` | **0** — 38 `ok` lines, `0 gate(s)/proof(s) not as required`; the six gates 0 identical from four directories and 0 again with the pack under `/tmp` |
| the drop/re-add world, `--check` and `--write` | `…/scratchpad/bis/pack` | **1**, **1** |
| the same world against `a725342`'s extracted tool | same | **0** |
| shallow clone + counterpart, default | `…/scratchpad/sh3` | **1** (`HISTORY NOT VERIFIED`) |
| shallow clone + counterpart, `--allow-unverified-history` | same | **0**, with `NOT CHECKED` printed |
| shallow clone, no counterpart | same | **1** (`NO WITNESS`, naming the clone) |
| `manifest-digests.py --check`, pack and shared folder | both directories | **0** / **0**, 42 rows each |
| `citation-provenance.py --check` | `…/phase14` | **0**, six buckets asserted |
| `retracted-claims.py --check` | `…/phase14` | **0** |
| `redproof-preflight.sh` with the cluster STOPPED, standalone | `…/phase14` | **1**, with `CAUSE: no cluster is listening …` printed by all five arms |

**Order of the record.** The run named above was made after the last content edit; the manifest digests and the shared-folder copies were then regenerated, and the sweep was run again at `2026-10-12T20:27:15Z` with the same codes (rc 0, 38 `ok`), together with `replay.sh` (46 cases, rc 0) and `redproof-preflight.sh` (5 arms, rc 0). The only files differing between the two runs are this one and the manifest's generated cells.

**One run is recorded as failed, and its cause is NOT claimed.** An earlier sweep in this working
session (`2026-10-12T20:24:17Z`, same pack) exited **1** on three lines: the two database gate
lanes (`replay`, `redproof-preflight`), and `no-cluster`, which answered rc 1 as required but
whose required sentence (`no cluster is listening`) was not found in its output. The cluster had
been left **stopped** by a manual measurement of mine before that run, which explains the two
gate lanes — a precondition of the run, not a property of the commit. It does **not** explain the
missing sentence: standalone, with the cluster stopped, the same script prints that sentence five
times and exits 1, which I measured immediately afterwards. So the sentence failure is
**unreproduced and its cause unnamed**, recorded here as a residual rather than explained with a
guess — which is the rule six instances of the wrong-cause class have earned.

## 7. Status

`PREPARED` / `CHALLENGED` / `NOT PROMOTED`. `READY_TO_PROMOTE` = **NO**.
Still open and named: `COORD P3-07` for the SQL proofs, `R10-ADD-01`, the unfenced
new-directory property of §4, the version arm, concurrency and performance (UNMEASURED),
`TL-P14-SEC-01/-02/-03`, §7a and §11a with the Security and Migration Owners, and
`OD-P14-09/-10/-11` with the owner.
