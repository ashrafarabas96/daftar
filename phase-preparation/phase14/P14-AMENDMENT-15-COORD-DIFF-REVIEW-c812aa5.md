# P14 — AMENDMENT 15: the coordinator's actual-diff review at `c812aa5`, answered

**Status: `PREPARED / NOT PROMOTED`. DOCS ONLY. ALL GATES UNMEASURED.**
**Base `93084f8`. Branch `claude/project-thread-1zqgj8`, cut from `6fc505d`; committed and
pushed on that branch only. No product code, no migration, no migration number.**
No timing or performance claim is made anywhere in this pack.
**Unsigned.** An author does not sign their own work, and this amendment signs nothing.

Reviewed head: `c812aa5`, range `583a4a0..c812aa5`.
Reviewer: the coordinator's diff-review worker, which wrote no part of this pack.
Report: `P14-COORD-DIFF-REVIEW-c812aa5.md`, sha256 `62269c4d16a4…70cb6229`, 31,955 bytes,
committed unedited and a row in `P14-HANDOFF-MANIFEST.md` §2.
Verdict: **REJECT (narrow)** — no P0, no P1, scope and authority clean, three blocking
findings and eleven named residuals.

**All three blocking findings were false sentences, not failed gates.** That is the third
consecutive round in which the defect was a sentence wider than the measurement under it, and
it is now the thing I expect of my own prose rather than a surprise: see §5.

## 1. `P2-01` (BLOCKING) — the revision walk was still anchored to the author

**What the pack said.** `P14-AMENDMENT-14` §2 presented "two witnesses the author's commits
cannot rewrite", the second being "**every revision** of the manifest", and
`P14-HANDOFF-MANIFEST.md`, `README-AR.md` and `P14-TASK-DAG.md` repeated it.

**What the code did.** `tools/manifest-digests.py` walked `git rev-list HEAD -- <manifest>`
**newest-first** with `signed_history.setdefault(name, digest)`, so the witness was the
**newest** committed digest. Whenever HEAD carried a digest, the witness *was* HEAD — written
by the same hand as the row. The reviewer measured it: tamper a reviewer's report, hand-forge
its row to the new digest, `git commit -am`, and both `--check` and `--write` return **0**
while printing *reviewer-row history checked over every revision of the manifest*. With the
counterpart directory edited in step, also 0. Round 10 closed the committed-**placeholder**
route; this is the committed-**forgery** route, the same species one step over. The
challenger's narrow check passed because its forged row was never committed.

**What is enforced now.** The walk is **oldest-first**:

| rule | code | what it refuses |
|---|---|---|
| the witness is the **OLDEST** digest any revision recorded — the one the report was received with | `manifest-digests.py` reversed `rev-list`, `if nm not in signed_history` | a file that no longer matches the digest it arrived with, whatever HEAD says |
| a **later** revision that records a different digest for the same report is itself a refusal | `moved[nm]`, `REVIEWER ROW REWRITTEN IN HISTORY` | the forgery commit, even if the file is afterwards restored |
| a **coordinator's** review is a reviewer's review (`R-03`) | `REVIEWER_PREFIXES` | tampering with, or re-signing, a `P14-COORD-DIFF-REVIEW-*` report |
| a signed name must keep its row (`R-02`) | `SIGNED REVIEWER ROW REMOVED` | deleting a received review together with its row |
| an incomplete history **does not answer** (`R-08`) | the graft list in `<git-dir>/shallow`, an unreadable `git show` | trusting the oldest digest that merely survived a truncation |

**The last of those is the one I would have got wrong.** A grafted commit reports **no
parents**, exactly as a true root commit does, so "the oldest revision adds the file" cannot
see a `--depth 1` clone at all: measured, such a clone answered *checked over every revision*
over one truncated revision. The graft list is where the truth is. `NOT CHECKED` now
**discards** the history witness instead of narrowing it, so in a shallow clone with no
counterpart every reviewer row answers `NO WITNESS` — loud, and fail-closed. This container's
own clone **is** shallow, and the manifest's first record is still above the boundary, so the
real pack is checked.

**And the consequence, which `CHALLENGE R11-P2-01` is right that this pack stated nowhere:** in a
truncated clone **with** a counterpart present, the committed forgery of §1 answers **0** again —
`NOT CHECKED` is printed, and the only witness left is the other directory, which the same hand
writes. `actions/checkout` defaults to `fetch-depth: 1`, so that is the CI shape and not an
exotic one. Three things follow, and all three are in the pack rather than in this paragraph
alone: the case is red-proofed **as it is** (`shallow-with-counterpart-passes` asserts rc `0`
*together with* `NOT CHECKED` in one output, so the blind spot cannot be lost quietly);
`--require-history` turns the announcement into a refusal for a caller that needs the guarantee,
and is proved to (`shallow-require-history-refuses`); and **`R10-ADD-01` is therefore
load-bearing, not theoretical** (`CHALLENGE R11-P3-02`) — whenever history is `NOT CHECKED` the
two-directory witness is the only one left, and no claim made after promotion should treat it as
a second witness. A gate that runs this check in CI needs `fetch-depth: 0` **and**
`--require-history`.

> **ANNOTATED AT ROUND 14 (`COORD-DIFF-REVIEW 03b3a0b`, `B1`, which BLOCKED).** Three things in
> the paragraph above never existed in any tool: the red proof
> `shallow-with-counterpart-passes`, the red proof `shallow-require-history-refuses`, and the flag
> `--require-history` (passing it exits **2**, `unrecognized arguments`, so a CI job following
> this instruction would break the gate it runs). They describe the **first attempt** at
> `R11-P2-01`, which had the flag as an opt-**in**; Amendment 16 §2 reversed that default and the
> flag is `--allow-unverified-history`. And the fourth claim is now false as well: in a truncated
> clone with a counterpart in step the forgery does **not** answer 0 — it refuses at rc **1**
> (`HISTORY NOT VERIFIED`), red-proofed as `shallow-counterpart-refused`. Read this paragraph as
> the state at `c812aa5` and nothing later. All four strings carry rows in
> `tools/RETRACTED-CLAIMS.tsv` so they cannot return.

**The limit that remains, stated and not guarded:** rewriting the manifest's own history.

> **ANNOTATION (`COORD-DIFF-REVIEW a725342 P2-01-bis`, which BLOCKED).** The sentence that stood
> here — *"A commit cannot move the witness; `git filter-branch` or a force-push can"* — is
> **false**, and the reviewer measured it on a full clone of the real repository. **Two ordinary
> commits** (`git rm` the manifest, then re-add it with the forged row) do not move the witness;
> they made the walk **discard** it, because the code read any unreadable revision — a deletion
> among them — as a truncation. Answered in
> `P14-AMENDMENT-16-COORD-RE-REVIEW-a725342.md` §1: a readable commit whose tree lacks the
> manifest is now skipped and recorded, only a missing object is `NOT CHECKED`, and `NOT CHECKED`
> itself no longer exits 0. Nothing inside a
repository the author can write to closes that, which is why the two-directory witness is the
other half and why `R10-ADD-01` (outside a repository, two copies written by the same hand are
one witness) stays open.

**Red proofs, each asserted by its own sentence:** `reviewer-row-committed-forgery` (forged row
committed, no counterpart), `reviewer-row-forged-both-dirs` (counterpart changed in step),
`reviewer-row-deleted`, `coord-review-protected`, `history-truncated-not-checked`.

## 2. `P2-02` (BLOCKING) — the pack's own tools, in the bucket of files that do not exist

The generated block in `P14-MIGRATION-PATCH-REQUEST.md` §15 said **12 files** "this phase
PROPOSES and that correctly do not exist yet", and three of them were
`tools/citation-provenance.py`, `tools/gate-sweep.sh` and `tools/retracted-claims.py` — in the
pack, being run by the gate that printed the sentence.

**Cause.** `in_pack()` and `was_in_pack()` searched `''`, `proofs` and `proofs/cases`: a
**hand-kept list of directories**, which is the very thing round 6 said it had replaced with
measurement, and `tools` was never added when the tools arrived at `8123830`. Both `--check`
and the sweep stayed green because the block agreed with its own generator.

**Remedy.** Not "add `tools`" — that fixes three tokens and leaves the next directory for the
next reviewer. The list is gone: the pack is **walked** (`os.walk`), a token belongs to it when
it is a real file under it at any depth matched at a path boundary, and `was_in_pack()` uses a
`:(glob)<pack>/**/<token>` pathspec over the whole pack, refusing with a configuration error if
git rejects the pathspec. A `./` prefix is normalised, which also moved
`./redproof-preflight.sh` out of the DELETED bucket where it did not belong.

**Measured after the fix:** the PROPOSES bucket lists **nine files**, all genuinely absent from
both trees and from the pack, and no `tools/*` file is in it. **The other bucket sizes are not
typed here** — I typed them in an earlier edition of this very amendment and they were stale
within the hour, because every document added to the pack changes them
(`COORD-DIFF-REVIEW a725342`, a P3, and the same lesson as `P2-03` one paragraph away from where
I had just written it). They are in the generated block in §15 of
`P14-MIGRATION-PATCH-REQUEST.md`, which the gate regenerates and `--check` holds to the trees.
The sentence "the generator asserts the four add up" now names however many buckets there
are — six, since a misspelled pack-document name got its own (`COORD-DIFF-REVIEW a725342`).

## 3. `P2-03` (BLOCKING) — typed counts, again, on the pages a handoff reader reads first

| where | said | there were |
|---|---|---|
| `P14-HANDOFF-MANIFEST.md` §1 "Commits on it" | eight | 17 |
| §1 "Worktree" | "any of the eight commits" | every commit on the branch |
| §2 lead | "All **29** live at …" | 37 rows (38 files) |
| §3 "Independent Challenger" | "**SEVEN ROUNDS RUN**" + seven verdicts | ten rounds, four addenda |
| `README-AR.md` §1 | «ثلاث عشرة دفعة» (thirteen commits) | 17 |
| §footer, `P14-AMENDMENT-03/04/05` headers, `P14-AMENDMENT-03` §10 | stale as of `COORD-DIFF-REVIEW R1` | — |

**Remedy taken: delete the figures and point at what generates them.** Not "generate them
here": a count generated into a document that is then committed is **one commit stale by
construction**, which is exactly how *eight* became seventeen — the row was regenerated in
every commit and the number was in the prose, not in the generated block. So the commit count,
the row count and the round count are gone; the rows, the branch and `git rev-list` are cited
instead, the manifest's own generated line prints the row count on every run, and each former
figure is recorded with what it used to say. The three amendment headers carry an annotation
rather than an edit: an amendment is dated evidence. `P14-AMENDMENT-03` §10's "205 lines" now
points at the generated table.

Three of these sentences are added to `tools/RETRACTED-CLAIMS.tsv`, so they cannot return in a
later edition: the witness claim of §1, `SEVEN ROUNDS RUN`, and the generated PROPOSES list
that named the pack's own tools.

## 4. The eleven named residuals

| # | finding | state |
|---|---|---|
| `R-01` | `retracted-claims.py` skipped `tools` by a **substring** test on the absolute path, so a pack checked out under any `…/tools/…` path reported "across 0 pack document(s)" with exit 0 | **CLOSED.** The skip is relative to `--pack`, and an empty population refuses (rc 2). Measured: a planted claim reds (rc 1) from both `…/plain/phase14` and `…/tools/phase14`, 25 documents either way |
| `R-02` | a received review could be deleted with its row and the pack lane stayed green | **CLOSED.** `SIGNED REVIEWER ROW REMOVED`, red-proofed |
| `R-03` | only `P14-CHALLENGE-*` rows were protected, so a coordinator's review could be tampered with and re-signed | **CLOSED.** `REVIEWER_PREFIXES` covers `P14-COORD-DIFF-REVIEW-*`; red-proofed. The same prefix is exempted in `retracted-claims.py`, because a review quotes the sentences this pack retracts — that is what a review does |
| `R-04` | every lock failure — unwritable directory, bad descriptor, no `flock` — printed "another red-proof run holds the lock" and exited 4. The **fifth** instance of the wrong-cause class | **CLOSED.** Each step is checked and names what it found, with exit **5** for "this run cannot take the lock at all" against **4** for "another run holds it". Measured: no `flock` on PATH → 5; an uncreatable lock directory → 5, quoting `mkdir`'s own error |
| `R-05` | `no-cluster` and `rolecount-discriminates` required only *non-zero*, so a lock refusal satisfied them without measuring anything | **CLOSED.** Each requires exit **1** and its own sentence (`no cluster is listening`; `the required message is absent`) |
| `R-06` | `c1a`'s `WHEN OTHERS` caught its own `LAW VIOLATED` raise, relabelling a violation as `LAW UNPROVED … SQLSTATE P0001` | **CLOSED.** `IF st = 'P0001' THEN RAISE; END IF;` — the violation is re-raised as itself. Measured on the cluster as the MECHANISM, both shapes side by side in one script: the old handler answers `LAW UNPROVED: … SQLSTATE P0001`, the new one `ERROR: LAW VIOLATED: lookup on an ungranted column SUCCEEDED`, exit 3. **Scope:** a real violation of this law needs `p14_resolver` to hold `secret_sha256`, which only the full replay sequence sets up and which I did not construct, so what is measured is the handler, not the case. The case itself still passes in the replay (46 cases, exit 0) and its red proof `c1a_lawunproved_expect_3` still exits 3 |
| `R-07` | "the pattern is written the same way in **every** filter" was wrong by one: `no-cluster-revert` had no fallback, so an exit-4 refusal printed an empty payload | **CLOSED.** Fallback added, and the stray `''` inside the unified pattern removed. Amendment 14's claim is annotated with what it was measured against |
| `R-08` | a shallow clone and an unreadable revision were labelled "checked" | **CLOSED.** See §1 |
| `R-09` | `redproof-preflight.sh <unknown-arm>` exited **0** with "0 arm(s), 0 not red", while this pack's own `replay.sh` refuses a no-match | **CLOSED.** Exit 2, naming the arms. Measured: `nosucharm` → rc 2 |
| `R-10` | an allow-list entry named a file that does not exist (`P14-AMENDMENT-11-CHALLENGE-ROUND-7.md`) | **CLOSED.** The name is corrected, and an allow-list naming a document the run did not scan now refuses (rc 2) — measured by the refusal firing on the uncorrected new rows |
| `R-11` | the sweep mutates the live pack with no `trap`, so an interrupted run left a reviewer's report tampered | **CLOSED.** Every file any proof touches is backed up once and restored on `EXIT INT TERM HUP`, and the worktree is removed by the same hand |

## 5. What I am carrying out of this round

- **Three rounds, one defect class: a sentence wider than the measurement under it.** `R10-P2-01`,
  this review's `P2-01` and `R-07` are all the same shape — the gate's verdict was sound every
  time and the description of it was not. The rule I take: **write the sentence from the branch
  that executes**, and treat a sentence as a claim to be measured, which is what a reviewer's
  sentence already is in this pack.
- **A count in a committed document is stale by construction.** The remedy is not a better
  generator but **no number**: cite the generator, the branch, the rows.
- **A hand-kept list reappears as a tuple.** Round 6 replaced a name pattern with measurement
  and left three directory names in the measurement. Walk the population.
- **A graft reports no parents.** "Reachability" has to be asked of the graft list, not of the
  parent pointers, or an incomplete history looks complete.
- **The fifth wrong-cause instance was mine again** (`R-04`). A refusal must name the cause it
  measured, and "something went wrong near a lock" is not one cause.

## 6. Still open, and whose it is

- `COORD P3-07` for the SQL proofs: a red proof judged by exit 3 alone cannot name its own law.
  Closed for the provenance, reviewer-row, lock and cluster lanes; open for the `ORDER` cases,
  where the honest fix is an expected SQLSTATE or law name per line and is its own change.
- `R10-ADD-01`: outside a repository, two copies changed in step are one witness. Closing it
  needs a witness neither copy's author controls.
- The version arm stays **UNFENCED** for "a real PG 17 cluster is refused"; **concurrency and
  performance are UNMEASURED**, and no timing claim is made from this container.
- `TL-P14-SEC-01/-02/-03`, §7a's five options and §11a: the Security and Migration Owners'.
  **No migration number is written here, and none may be.**
- `OD-P14-09`, `OD-P14-10`, `OD-P14-11`: the owner's, and the service refuses to boot before
  they are set.

## 6a. The challenger's narrow check at `a725342`, and the four residuals it filed

Verdict **PASS-WITH-SCOPE, nothing blocking** (`P14-CHALLENGE-a725342.md`, sha256
`d6917dbbd9fb…fd0c3d3e`, committed unedited, a row in §2). It closed the coordinator's `P2-01`
**by execution**: the challenger built the committed-forgery plant itself, with the report
tampered in **both** directories so the two-directory witness could not be what refuses, and ran
that one world against two tools — this head **1** (`REVIEWER ROW REWRITTEN IN HISTORY`, naming
the forging revision), `c812aa5`'s extracted `manifest-digests.py` **0** while printing *history
checked over every revision*. That is the finding and its remedy measured against each other in
the same world, which is stronger than my own proof of it.

| # | finding | what I did |
|---|---|---|
| `R11-P2-01` (**round-14 annotation: the proof name and the flag in this row never existed, and the world refuses at 1 since `8f6c849`**) | in a `--depth 1` clone **with** a matching counterpart the forgery answers 0 again; announced and red-proofed, but the consequence was stated nowhere, and my own §7 evidence row dropped the qualifier §1 carried | **Closed.** The consequence is stated in §1, the row is corrected, the case is red-proofed as it is (`shallow-with-counterpart-passes`, rc 0 **with** `NOT CHECKED`), and `--require-history` refuses for a caller that needs the guarantee (`shallow-require-history-refuses`) |
| `R11-P2-02` | the `NO WITNESS` sentence said *no digest in any revision of this manifest* in a clone that cannot see seventeen revisions that do record one. The **sixth** instance of one class | **Closed.** The refusal is written from the variable it read: when `history` is `NOT CHECKED` it says *no digest for it is visible in the revisions this clone has*, and points at `fetch-depth: 0`. Red proof `shallow-no-witness-names-the-clone` |
| `R11-P3-01` | the `moved` refusal printed *restore the row to the digest the report arrived with* — which the reviewer had already done; the refusal is permanent by design | **Closed as a sentence.** It now says the refusal **cannot be cleared from here**, that this is deliberate because the forging revision stays in the record, and what can be done instead: say so in the handoff and have the reviewer re-send the report |
| `R11-P3-02` | `R10-ADD-01` is load-bearing, not theoretical | **Recorded** in §1 and in §6: whenever history is `NOT CHECKED` the two-directory witness is the only one, and it is not to be called a second witness in any post-promotion claim |

**The class is now six, and five of the six are mine.** `R8-P3-05`, `R9-P3-01`, `R10-P3-01`,
`R-04` and `R11-P2-02` are all *a fail-closed refusal naming a cause that is measurably not the
cause*. The reviewer's formulation is the rule I take from this phase: **write the refusal from
the variable it actually read.** Every one of these had the true cause already in a local
variable — `history`, `serr`, the arm's own name — and typed a guess beside it.

## 7. What was executed, with the path each code was measured from

Host `vm`. Pack `/home/user/daftar/phase-preparation/phase14`, repository `/home/user/daftar`
(**a shallow clone**, which is why `R-08` is measured rather than assumed), shared folder
`/mnt/project-files/phase14`, cluster PostgreSQL 16.15 on `/tmp/p14pg/sock:54314`,
`en_US.utf8`. **No timing or performance figure is taken from this container.**

| command | cwd | rc |
|---|---|---|
| `bash tools/gate-sweep.sh` (run `2026-10-12T18:00:46Z`) | `/home/user/daftar/phase-preparation/phase14` | **0** — 33 `ok` lines, `0 gate(s)/proof(s) not as required` |
| the six gates, each from four directories | `…/phase14`, `/home/user/daftar`, `/tmp`, `/tmp/tmp.*/wt` | **0** identical from all four, printed beside each |
| three gates with the **pack itself under `/tmp`** | `/tmp/tmp.*/wt/phase-preparation/phase14` | **0** each |
| 24 red proofs, incl. the five new ones | `/tmp` | each at its required code, five asserted by their own new sentences |
| `bash proofs/replay.sh` | `…/phase14` | **0** — 46 cases, 0 not at their required exit code |
| `bash proofs/redproof-preflight.sh` | `…/phase14` | **0** — 5 arms, 0 not red; the version arm UNFENCED |
| `bash proofs/redproof-preflight.sh nosucharm` | `…/phase14` | **2** (`R-09`) |
| `PATH=/nonexistent … redproof-preflight.sh`; lock directory uncreatable | `…/phase14` | **5** each, naming `flock` and `mkdir`'s own error (`R-04`) |
| `retracted-claims.py --check` with a planted claim, pack at `…/plain/phase14` and `…/tools/phase14` | `…/phase14` | **1** and **1**, 25 documents either way (`R-01`); empty pack → **2** |
| `manifest-digests.py --check`, pack and shared folder | `/home/user/daftar/phase-preparation/phase14`, `/mnt/project-files/phase14` | **0** / **0**, 39 rows each, both directories byte-identical |
| the committed-forgery worlds (§1), `--check` and `--write` | scratch repositories under the session scratchpad | **1** / **1** in both witness shapes; a `--depth 1` clone **with no counterpart** answers `NO WITNESS`, and **with a matching counterpart answers 0** with `NOT CHECKED` printed (`CHALLENGE R11-P2-01`: this row read as a property of the clone, and it is a property of that constructed world) |
| the `R-06` handler, both shapes in one script | `p14scratch` on the cluster | old: `LAW UNPROVED … P0001`; new: `ERROR: LAW VIOLATED`, exit **3** |
| the three shallow-clone worlds (§6a) — **see the round-14 annotation above: the flag named here never existed, and the first world refuses at 1 since `8f6c849`** | scratch clones under the session scratchpad | counterpart in step → **0** with `NOT CHECKED`; `--require-history` → **1**; no counterpart → **1**, naming the clone |

**Order of the record.** The sweep above ran after the last content edit; the manifest digests
and the shared-folder copies were then regenerated, and the sweep was run again with the same
codes. The only files that differ between the two runs are this one and
`P14-HANDOFF-MANIFEST.md`'s own generated cells. After the sweep `git status` showed only the
files this amendment changes — the `trap` of `R-11` put every mutated proof target back.

*`PREPARED` / `CHALLENGED` / `NOT PROMOTED`. `READY_TO_PROMOTE` = **NO**.*
