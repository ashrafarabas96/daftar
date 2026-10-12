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

**The limit that remains, stated and not guarded:** rewriting the manifest's own history. A
commit cannot move the witness; `git filter-branch` or a force-push can. Nothing inside a
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

**Measured after the fix:** PROPOSES **9 files / 10 tokens**, all genuinely absent from both
trees; in-pack **84 files / 89 tokens**; DELETED 1; absolute 8; other documents 1; and the
partition assertion holds against 110 unresolved tokens. The sentence "the generator asserts
the four add up" now says **five**, which is how many buckets there are.

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
| the committed-forgery worlds (§1), `--check` and `--write` | scratch repositories under the session scratchpad | **1** / **1** in both witness shapes; a `--depth 1` clone answers `NO WITNESS` |
| the `R-06` handler, both shapes in one script | `p14scratch` on the cluster | old: `LAW UNPROVED … P0001`; new: `ERROR: LAW VIOLATED`, exit **3** |

**Order of the record.** The sweep above ran after the last content edit; the manifest digests
and the shared-folder copies were then regenerated, and the sweep was run again with the same
codes. The only files that differ between the two runs are this one and
`P14-HANDOFF-MANIFEST.md`'s own generated cells. After the sweep `git status` showed only the
files this amendment changes — the `trap` of `R-11` put every mutated proof target back.

*`PREPARED` / `CHALLENGED` / `NOT PROMOTED`. `READY_TO_PROMOTE` = **NO**.*
