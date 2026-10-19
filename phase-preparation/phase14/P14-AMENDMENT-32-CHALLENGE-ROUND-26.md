# Phase 14 — amendment 32: challenge round 26 answered

**Subject reviewed:** `1b694d1f4a1b948698bc4e4a2b4b3e2e8b61a048`.
**Verdicts received:** challenger **PASS-WITH-SCOPE** on `25d945d..1b694d1` with **one P1** and one
P3; coordinator **SIGN** for `1b694d1` alone. With both, that SHA carries all three links — and
**this head is not that SHA**.
**Reviewers' words, committed unedited and hashed from disk:**
`P14-CHALLENGE-1b694d1.md` (10,325 B, `9db03084f64cbe725171b38ac7c1820f3b42a9b8fb4b913a6de56b70b35b43fb`)
and `P14-COORD-DIFF-REVIEW-1b694d1.md` (4,977 B,
`49f560a648441e2876e5a3547b1ae2911528af294e2f7b6fa6ae32cfec0c888c`).

The challenger's signature of that range **expressly does not cover any claim that this manifest
pins this pack**, and the coordinator's instruction is that the enumeration must be fixed **before
any such statement is made**. This amendment is that fix. Phase 14 remains **PREPARED / NOT
PROMOTED**.

## 1. `R26-P1-01` — a FAIL-OPEN in this manifest's own enumeration

**Reproduced before anything was changed**, in a fresh clone of `1b694d1`, one plant at a time,
each removed before the next, baseline rc 0 with 41 pack documents:

| planted | `manifest-digests --check` | `retracted-claims --check` |
|---|---|---|
| `zz-planted.txt` (top level) | **rc 0, nothing reds** | 41 pack documents |
| `tools/zz-planted.md` | **rc 0, nothing reds** | 41 |
| `proofs/zz-planted.md` | **rc 0, nothing reds** | **42** |
| `P14-CHALLENGE-ZZZZZZZ.MD` (upper case) | **rc 0, nothing reds** | 41 |
| `P14-CHALLENGE-ZZZZZZZ.md` (same bytes, lower case) | rc 1, `ARTIFACT WITH NO ROW` | 41 |

The cause was two lines: `os.listdir`, which is not a walk, and `endswith(('.md','.yaml'))`, which
is case-sensitive. **Why it is a fail-open and not a shape residual, which is the challenger's
argument and I adopt it:** the invisible file **reaches a published figure**. `retracted-claims.py`
walks recursively, so with `proofs/zz-planted.md` planted this pack's own document count moved from
41 to 42 while the pin that is supposed to describe the pack stayed green. The coordinator added a
plant this pack had not: the same file carrying a **retracted phrase** turns `retracted-claims.py`
**red at rc 1** while `--check` stays at rc 0. A pin that stops where another instrument keeps
reading is not a pin, and the asymmetry — not the invisibility — is the defect.

**What the fix is.** The domain is now **every file under the pack directory, at any depth, in any
extension and in any case**:

* The enumeration is `os.walk` with **no extension filter and no case folding**. A top-level file
  needs a row, whatever it is called.
* A first-level directory is pinned by **one row named with a trailing slash** — `tools/` and
  `proofs/` — whose digest is taken over the name, size and SHA-256 of **every file beneath it at
  any depth**, sorted by path, with the byte count as the total. An added, removed, renamed or
  edited file beneath it moves that digest and `--check` refuses by name. The recipe to recompute
  it **without this tool** is quoted beside `subtree_digest`, and a reviewer can run it in one
  `find | sort | sha256sum` pipeline.
* A first-level directory **no row declares** refuses with `SUBTREE WITH NO ROW`, and that refusal
  **names the domain it enforces** rather than only the file it found.
* The summary line now states the domain and the two counts: top-level files, and files under
  declared subtrees.

**The exclusions, and there are exactly two.** The manifest itself, because a file cannot carry its
own digest; and a directory that **IS** a git repository — `HEAD`, `objects` and `refs` all present.
The second is **structural, not by name**, so a directory merely called `x.git` is still pinned. It
exists because this pack's own attack worlds legitimately carry a repository inside a synthetic pack
directory, and three of those proofs must measure what they are about rather than this enumeration;
**at this head the real pack contains no such directory, so the exclusion excludes nothing.**

**The rule the round adds, and it is the deeper one:** *two instruments reading one directory must
enumerate the same domain.* The same structural exclusion is therefore written into
`retracted-claims.py` as well, beside its existing declared skip of `tools/`. Without that, closing
the hole in one tool would have re-opened the same asymmetry at `.git`-shaped paths.

**Seven arms, in the sweep, each a plant, one at a time, each removed before the next, between two
baselines that must be green or every arm is vacuous.** They run against the current pack copied
into a second worktree of this repository — a real checkout, so the history leg is readable — and
never against the real pack, so an interrupted run cannot leave a planted file in it:

| arm | required refusal |
|---|---|
| `plant-baseline` | rc 0, `every artifact row matches the file on disk` |
| `plant-txt-top-level` | `zz-planted.txt: ARTIFACT WITH NO ROW` |
| `plant-upper-case-md` | `P14-CHALLENGE-ZZZZZZZ.MD: ARTIFACT WITH NO ROW` |
| `plant-lower-case-md` | `P14-CHALLENGE-ZZZZZZZ.md: ARTIFACT WITH NO ROW` |
| `plant-under-tools` | `tools/: row says` |
| `plant-under-proofs` | `proofs/: row says` |
| `plant-two-deep` (`proofs/cases/zz-planted.sql`) | `proofs/: row says` |
| `plant-new-subdirectory` | `SUBTREE WITH NO ROW: zz-dir/` |
| `plant-baseline-restored` | rc 0 again, so no plant is carried into the rest of the run |

`plant-two-deep` is mine and not the reviewers': their deepest plant was one directory down, and a
subtree claim that says *at any depth* is tested at depth two.

## 2. `R26-P3-02` — the comparison moved before the commit instead of after the push

The coordinator's wording: *"add the shared-folder comparison as a pre-commit step in the build, so
an uncommitted reviewer report reds before the push."* Twice in consecutive rounds a reviewer's
report sat in the shared folder while the commit went out without it — 09:08:24 and 09:30:26 UTC —
and both times what found it was a lane read **after** the push.

`manifest-digests.py --reports-in-tree` asks it **before**: every reviewer-prefixed file in the
counterpart directory must have a row here **and** be carried by this commit, where **the index
counts, not only HEAD**, because a file staged for the commit about to be made is in it. It refuses
by name, `REVIEWER REPORT NOT IN THIS COMMIT`, and says which of the two conditions failed. It runs
in the sweep as an **off-repository lane**, since its subject includes a directory every session
writes, so it is reported apart from the figure quoted for a SHA and still moves the exit code.

**Measured, and it is why this section is not a claim:** the first run of it, before either
round-26 report was staged, named **both of them** — `P14-CHALLENGE-1b694d1.md` and
`P14-COORD-DIFF-REVIEW-1b694d1.md`, each *"has no row in this manifest and this commit does not
carry it"*. That is exactly the omission of `dac688d`, caught this time **before** a push rather
than after one.

**And the first version of it was right for the wrong reason, which I found because the lane
stayed red when it should have gone green.** A pathspec given to `git ls-files` resolves against
the **current directory** of the git call — the manifest's directory here — while a `HEAD:<path>`
name resolves against the repository **root**. So the index leg was asking about
`phase-preparation/phase14/phase-preparation/phase14/<report>`, found nothing, and printed the
right-looking sentence about a staged file. The pathspec now carries `:(top)` so the two legs mean
the same path. This pack already has that lesson written down for `GIT_DIR`; it cost a second
reading here, and a refusal that fires for a cause other than the one it names is the defect class
this pack has spent six rounds on. The falsification above — unstage, rc 1; re-stage, rc 0 — is
what distinguishes the fixed check from the broken one, and it is published for that reason.

## 3. Found while building the arms, disclosed by me: eight arms that asked nothing

The plant arms were first written inside the worktree block, which sits **above** the definition of
the sweep's `named` helper. Every one of them printed `tools/gate-sweep.sh: line NNN: named:
command not found` — and **the sweep carried on and no line said so**. Eight arms asked nothing and
the run still printed a figure. That is this pack's own recurring defect in a new place: *a lane
that reports nothing reads as a lane that passed.* Two changes, both in this commit: the block was
moved to where the helper exists, and `plant` now **refuses by name** if `named` is ever absent
(`the \`named\` helper does not exist here, so this arm asked nothing`), with a further `FAIL` if
there is no second worktree to plant in at all. The eight silent lines are published here because
they are the measurement that found it.

## 4. What the reviewers measured that this pack had not, recorded as theirs

* **The challenger checked for an execution path rather than assuming there was none.** `python3 -I`
  on this container's Python **3.13.16** reports `isolated: 1`, `safe_path: True` and `sys.path[0]`
  the stdlib zip, not the script directory — so a planted sibling module beside the instruments is
  **not importable** by them. The escalation that would have made this a P0 is closed, and they say
  so rather than leaving it implied.
* **In this pack's favour, and measured:** the manifest declares its domain in prose ("every row
  below lives at `/mnt/project-files/phase14/`") and no row named a subdirectory, so the top-level
  reach was **declared, not silently narrowed**. They also noted the shared folder's extra file at
  the time was the manifest itself and **not** an instance of the hole, so nobody would infer a
  sixth plant from this pack's own output.
* **The coordinator rebuilt every plant independently** in its own scratch clone and added the
  retracted-phrase plant above; it rates `R26-P1-01` **P2**, pre-existing, not blocking `1b694d1`
  because the range touches neither the file nor the gap, and `R26-P3-02` **P3**. Both ratings are
  theirs; this amendment treats the finding as a fail-open and fixes it, which is the stricter
  reading and the one the challenger measured.
* **The `offrepo` separation was re-proved twice more, by both of them**, on subjects harsher than
  this pack's: the challenger pointed `P14_SHARED` at a directory holding one **unrelated** file,
  the coordinator at a mirror with one unrowed reviewer-named document. Both: identical `ok` count
  and identical gate figure, exit code moving to 1. Four published runs now, none of them an arm —
  see §6.
* **The challenger reproduced this pack's head figure exactly** — 78 ok, 0 not as required, from
  the commit alone — and verified all 76 rows against disk by digest **and** size with 0
  mismatches, 34 revisions, 1 by the marker.

## 5. Exit codes at this head

Taken after the last write to any document of this round, which is the manifest itself. Per round
18's rule, **no count of the manifest's own revisions is quoted here**; that figure is measured in a
fresh clone of the pushed head and reported to the reviewers. Per `R25-P3-02`, the sweep figure
below is the one reproducible from this commit alone and the off-repository lanes are reported apart
from it.

* `tools/gate-sweep.sh` — the figure reproducible from this commit alone: **87 ok, `0
  gate(s)/proof(s) not as required`**, from four working directories, with the cluster up. 78 ok at
  `1b694d1`; the nine added are the plant arms and their two baselines, less the one lane that
  moved out of the `ok` count into `obs`.
* `tools/gate-sweep.sh`, the off-repository lanes — `manifest-shared` **differs** — `1 off-repository lane(s) differ`, so
  the script exits **1**, fail-closed. Read line as printed: `/mnt/project-files/phase14 — 79
  file(s), newest 2026-10-19T10:13:13Z, read at 2026-10-19T10:52:04Z`; first line `STALE:
  P14-MIGRATION-PATCH-REQUEST.md: row says f47db62c155a/114,263 bytes, file is
  946d2052d111/114156 bytes`. That folder is the **pre-push mirror of `1b694d1`** and by the rule
  of amendment 31 §1 it is written only after a push. `reports-in-tree` is **`obs` rc 0**: both
  round-26 reports have rows and are carried by this commit. Neither figure is part of the
  commit's.
* `tools/manifest-digests.py --check` — rc 0, byte-identical from the pack directory and the repository root:
  **81 rows + the manifest itself** (79 artifacts and 2 declared subtrees), **79 files at the top
  level and 54 under the two subtrees**, and *"reviewer-row history checked over all 34
  revisions … 1 of them found by the marker it carries"*. The revision count is this working
  tree's; the pushed-head figure is re-measured in a fresh clone and reported to the reviewers.
  `--reports-in-tree` rc 0, and **falsified both ways at this head**: with one report unstaged,
  rc 1 and `REVIEWER REPORT NOT IN THIS COMMIT`; re-staged, rc 0.
* `tools/citation-provenance.py` — rc 0, and `--check P14-MIGRATION-PATCH-REQUEST.md` rc 0 after the generated
  block was regenerated for this round's documents.
* `tools/retracted-claims.py` — rc 0: **28 retracted claims enforced across 42 pack documents; 39
  challenge reports exempt in code.** No claim was added this round. I first wrote 41 here, which
  was the count before this amendment existed; the document that publishes the figure is inside the
  set the figure counts, and it is corrected rather than carried.
* repository `npm run format` — rc 0, npm 10.9.4, warm, reported as a statement **about the repository**:
  this diff touches `.md` files, two `.py` files and one `.sh` file under `phase-preparation`, so
  by `R24-P3-03` its repository-gate set is **empty** and `git diff --stat -- . ':!phase-preparation'`
  is empty. No cold column was taken at this head and none is implied.
* **Guard deletion, one deletion per copy, read by NAME** — six copies of this pack, each inside its own local clone of this
  repository so the history leg is readable, **one guard deleted in each and nothing else**, every
  copy `--write`-refreshed after the deletion (see below), all `--no-db`:

| the one thing deleted | arms that go FAIL beyond the baseline |
|---|---|
| nothing (baseline) | — (78 ok; the one red is named below) |
| the enumeration's extension filter and case-insensitivity restored | `plant-txt-top-level`, `plant-upper-case-md` — **and only those** |
| the `SUBTREE WITH NO ROW` refusal | `plant-new-subdirectory` only |
| the subtree-digest drift refusal | `plant-under-tools`, `plant-under-proofs`, `plant-two-deep` only |
| the recursion inside `subtree_digest` (top level of the subtree only) | `plant-two-deep` only |
| the `REVIEWER REPORT NOT IN THIS COMMIT` refusal | **reversed row:** the `reports-in-tree` lane, red by construction in every other copy, turns `obs` rc 0 — the only copy where it is green is the one with the guard deleted |

  No deletion reds an arm belonging to another guard, so the five guards are keyed on five
  different refusals and none of the arms is a tautology. `plant-two-deep` separates the two
  halves of the subtree claim: deleting the drift refusal reds all three subtree arms, deleting
  only the recursion reds the depth-two arm alone.

  **Two things about the method, both mine and both measured.** First, the deletion lives *inside*
  the declared `tools/` subtree, so it moves that subtree's digest and the manifest is stale **by
  construction**: my first run of these worlds reported `plant-baseline` FAILing in three copies,
  which was the new pin reporting the deletion, not a guard. The published runs `--write` the copy
  after the deletion, so each arm measures the guard and not the digest. Second, every copy
  including the baseline carries the same one red, `citation-provenance` rc 1 with `GENERATED
  CITATION-PROVENANCE BLOCK IS STALE`: the copies hold this round's uncommitted documents over a
  clone whose HEAD predates them, and one classification in that block is derived from history. It
  is attributed, identical in all six copies, and no deletion moved it.

## 6. Residuals at this head, signed by neither reviewer

* **A document hidden inside a directory that is a real git repository is read by no instrument of
  this pack.** Both now skip it, so nothing is asymmetric and the hole that reached a published
  figure is closed; neither pins it. At this head no such directory exists in the pack.
* **No permanent arm asserts the `offrepo` separation.** It rests on four published runs — two of
  mine, one of the challenger's, one of the coordinator's — and not on an arm inside the sweep.
* **The pre-commit report check reads the index, so it cannot see a report a committer has neither
  copied nor staged on another machine.** It catches the omission this thread made twice; it is not
  a proof about anyone else's working tree.
* The **in-pinned-set `git` arm** is absent and named; `parents-unknown` **unwitnessed**;
  `GIT_EXEC_PATH` and the translated-git leg **UNMEASURED** here.
* **CI has never run a Phase 14 SHA**, and no workflow in this tree runs this pack's gates.
* `OD-P14-09`, `-10`, `-11` **open with Ashraf**.
* Phase 14 remains **PREPARED / NOT PROMOTED**. No signature in this pack covers this head.
