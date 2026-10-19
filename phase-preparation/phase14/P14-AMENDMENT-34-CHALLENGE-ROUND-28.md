# Phase 14 — amendment 34: challenge round 28 answered

**Subject reviewed:** `c603d39` (the head that closed `R27-P1-01`).
**Verdicts received:** challenger **REJECT** with **one P1 (a fail-open)**, one P2 and one P3;
coordinator **adopted the REJECT** and ruled the three remedies carried out here.
**Reviewer's words, committed unedited in this same commit and hashed from disk:**
`P14-CHALLENGE-c603d39.md` (12,074 B,
`61f85e70ca0d3de9480405784fb1642bdc43db6a9a02e3ff2fefe8259c8228b1`), the digest the challenger
announced for the frozen file.

`c603d39` carries **no signature**. Phase 14 remains **PREPARED / NOT PROMOTED**, and the sentence
"this manifest pins this pack" is **still not made anywhere in this pack**.

## 1. `R28-P1-01` (P1, a FAIL-OPEN) — a link to a directory was skipped in silence

Round 27 wrote, in this pack's own words, *"A link is neither the file it points at nor content of
its own … so it is refused by name rather than followed, digested or skipped"* — and then refused
links **only where `walk()` iterates `files`**. `os.walk` does not descend into a symbolic link to
a directory and does not list it among files, so that one shape passed through **both** branches.
The two arms shipped with the sentence were **the two shapes the reviewer had named** in round 27,
and the net was read as covering the variants of the shape it names. That is this pack's own
lesson, and it cost a round.

**Reproduced before anything was changed**, in a fresh clone of the pushed `c603d39`, one plant at
a time:

| planted | result |
|---|---|
| `zz-flink -> P14-HANDOFF-MANIFEST.md` | rc 1, `SYMBOLIC LINK IN THE PACK: zz-flink names …` |
| `zz-dlink -> <nothing>` (dangling) | rc 1, refused by name |
| `zz-link -> <an existing directory>` | **rc 0**, *"every artifact row matches the file on disk, and every file has a row"*, `81 file(s) at the top level` unchanged, `excluded as repositories: none`, and the string `zz-link` **absent from all three instruments' output** |
| `proofs/zz-link -> <the same directory>` | **rc 0**, `55 file(s) under 2 declared subtree(s)` unchanged and the `proofs/` row unmoved, while that row's prose says its digest covers every file beneath it at any depth |

**It defeats an ENFORCEMENT, not only a pin.** With a document behind the link carrying a claim
from `tools/RETRACTED-CLAIMS.tsv`: `retracted-claims.py --check` **rc 0**, 43 documents unchanged.
The **same bytes at the top level**: **rc 1**, `RETRACTED CLAIM PRESENT: zz-doc.md:3`. The
challenger also committed the link in a local probe (`120000 efd8ce62…`) and the manifest stayed
rc 0, so it is not only a working-tree shape.

### The fix

One refusal sentence, `_link_refusal`, reached from **both** branches of the walk, naming the kind
of link it found so the two branches cannot drift apart again. In the directories branch the test
runs **before git is asked anything**, because asking first would let a link *to a repository* be
**excluded** rather than refused — the same hole one step along.

**And the ruling's sweep for every other shape the walk does not descend into or cannot read as
bytes:**

* **an unreadable directory** — `os.walk` reports the listing error to an `onerror` handler this
  pack never set, and then yields **nothing** for that directory: invisible exactly as the link
  was. There is now a handler, and `classify_dirs` refuses by name a directory it cannot list.
* **anything that is not a regular file** — a FIFO, a socket or a device is listed among `files`,
  and `open(ap,'rb').read()` on a FIFO **does not return**. Refused by name rather than opened.

### Measured after the fix, in the probe clone, against a clean baseline

| world | manifest | `retracted-claims` | `citation-provenance` |
|---|---|---|---|
| baseline | rc 0 | rc 0 | rc 0 |
| `zz-link -> <directory>` (top level) | **rc 1** `SYMBOLIC LINK IN THE PACK: zz-link names … (a link to a directory)` | **rc 2** | **rc 2** |
| `proofs/zz-link -> <directory>` (subtree) | **rc 1** `proofs/: SYMBOLIC LINK IN THE PACK: zz-link` | **rc 2** | **rc 2** |
| the 20-byte repository forgery (§2) | **rc 1** `SUBTREE WITH NO ROW: zz-hide/` | **rc 1** (the planted retracted claim is now **enforced**) | **rc 1** |
| a FIFO | **rc 1** `NOT A REGULAR FILE IN THE PACK: zz-fifo` | **rc 2** | **rc 2** |
| baseline restored | rc 0 | rc 0 | rc 0 |

All three instruments now move on every one of these shapes, or none of them does. **rc 2 is
deliberate** for the two tools whose job is enforcement rather than pinning: a refused path means
the population they would have measured is **undecided**, and 2 is this pack's "nothing here is a
verdict" code — never 0, and never 1, which means *stale*.

**Armed:** `plant-link-to-directory`, `plant-link-to-directory-subtree`,
`plant-retracted-behind-link` (rc 2 by name) with `plant-retracted-at-top-level` as its control
(rc 1 `RETRACTED CLAIM PRESENT`), `plant-fifo-in-the-pack`, and `plant-repo-without-commit`.

**Not armed, and said rather than implied:** the **unreadable-directory** refusal is
**UNMEASURED-at-runtime**. This container runs as **uid 0**, where `chmod 000` does not stop a
listing — measured: `os.listdir` on a 000 directory **succeeds** here. The refusal is in the code
and in the domain sentence; no plant in this container can make it fire, and none pretends to.

## 2. `R28-P2-01` (P2) — a repository must resolve a commit

`git --git-dir=<d> rev-parse --git-dir` alone accepts a **20-byte** forgery: `HEAD` holding
`ref: refs/heads/main` with no trailing newline, plus two **empty** directories — the same entry
count as round 27's forgery. git checks neither that the branch exists nor that `objects/` holds
anything. **Reproduced here:**

```
<forgery>  rev-parse --git-dir               rc 0
<forgery>  rev-parse --verify HEAD^{commit}  rc 128
the real .git  rev-parse --git-dir               rc 0
the real .git  rev-parse --verify HEAD^{commit}  rc 0
```

So the question is **composite**, as the coordinator ruled: a directory is a repository, and
therefore outside this pack's domain, only if git accepts it **and it resolves a commit**. A
repository with no commits fails the second half and **stays in the domain**, which is the
direction this pack refuses in; the `plant-real-repo-excluded` arm therefore now builds a bare
repository that **does** resolve a commit, by plumbing and with no worktree.

**The enforcement consequence, which §6 of amendment 33 did not state:** inside an excluded
repository a retraction this pack enforces is **not enforced**, because no instrument reads those
files. With the forgery no longer excluded, the planted retracted claim is caught (rc 1 in the
table above). Inside a **genuine** repository it is still not caught, and that is now written into
§6 rather than left as "pinned by no instrument".

## 3. `R28-P3-01` (P3) — the recipe's clause

At this head the published recipe is exact and the challenger **ran** it rather than reading it
(`tools/` and `proofs/` both reproducing their rows). But `find -type f` descends into a directory
git accepts as a repository and the tool does not, so the sentence needed its bound. It now reads:
the recipe reproduces the row **when the run reports 0 excluded directories**, and is faithful only
on a tree the tool would **accept** — a refused name, link, FIFO or unreadable directory makes the
tool refuse and leaves the shell hashing something the pack does not contain. Both directions are
safe (the tool is the stricter), and both are stated.

## 4. What the challenger could not break, recorded because it bounds the claim

Their report measures, and this amendment does not re-assert: no TOCTOU in the three loaders (one
read into one buffer, hashed and exec'd); the pin firing in one voice; swapping one pin leaving the
sibling and the manifest at rc 2, and swapping all three reddening the manifest's own `tools/` row;
no leakage under `GIT_DIR`, `GIT_CEILING_DIRECTORIES`, `GIT_WORK_TREE`, `GIT_OBJECT_DIRECTORY`,
`GIT_CONFIG_COUNT`/`KEY_0`/`VALUE_0` with `safe.directory = *`, `HOME` or `XDG_CONFIG_HOME`; and
round 27's exact collision construction now refusing at `UNNAMEABLE PATH`. They also confirm the
`c4` null result of amendment 33 §5 — with newline, CR and NUL refused before the digest, no
admitted world distinguishes the count prefix.

## 5. Exit codes at this head

Taken after the last write to any document of this round, which is the manifest itself. Per round
18's rule, **no count of the manifest's own revisions is quoted here**; that figure is re-measured
in a fresh clone of the pushed head and reported to the reviewers. Per `R25-P3-02` the sweep figure
is the one reproducible from this commit alone, and the off-repository lanes are reported apart
from it.

* `tools/gate-sweep.sh --no-db` — **96 ok, `0 gate(s)/proof(s) not as required`**, from four
  working directories. 90 at `c603d39`; the six added are `plant-repo-without-commit`,
  `plant-link-to-directory`, `plant-link-to-directory-subtree`, `plant-retracted-behind-link`,
  `plant-retracted-at-top-level` and `plant-fifo-in-the-pack`, as they printed:

```
ok  plant-repo-without-commit        rc=1  SUBTREE WITH NO ROW: zz-hide/
ok  plant-link-to-directory          rc=1  SYMBOLIC LINK IN THE PACK: zz-link names …
ok  plant-link-to-directory-subtree  rc=1  proofs/: SYMBOLIC LINK IN THE PACK: zz-link
ok  plant-retracted-behind-link      rc=2  SYMBOLIC LINK IN THE PACK: zz-rlink
ok  plant-retracted-at-top-level     rc=1  RETRACTED CLAIM PRESENT: zz-doc.md
ok  plant-fifo-in-the-pack           rc=1  NOT A REGULAR FILE IN THE PACK: zz-fifo
ok  plant-real-repo-excluded         rc=0  excluded as repositories: zz-real
```

* `tools/gate-sweep.sh`, the off-repository lanes — **3 differ**, so the script exits **1**,
  fail-closed, and none of the three is in the figure above. Read line as printed:
  `/mnt/project-files/phase14 — 83 file(s), newest 2026-10-19T12:15:36Z, read at
  2026-10-19T12:24:43Z`. `manifest-shared` differs because that folder is the pre-push mirror of
  `c603d39` and by amendment 31 §1 it is written only **after** a push; `reports-in-tree` and
  `reports-at-head` both name `P14-CHALLENGE-c603d39.md`, the report this commit adds, which is
  **the lane working** — the sweep above was run before the commit existed.
* `tools/manifest-digests.py --check` — **rc 0**, identical from the pack directory and the
  repository root: **85 rows + the manifest itself** (83 artifacts and 2 declared subtrees), **83
  files at the top level and 55 under the two subtrees**, `0 directory(ies) were excluded as
  repositories: none`, and the domain sentence printed in full with its new clauses.
* `tools/retracted-claims.py --check` — rc 0: **28 retracted claims enforced across 44 pack
  documents; 41 challenge reports exempt in code.** No claim was added this round; the counts move
  by this amendment and this round's committed report.
* `tools/citation-provenance.py --check P14-MIGRATION-PATCH-REQUEST.md` — rc 0 after the generated
  block was regenerated for this round's documents.
* repository `npm run format` — not re-run and no number quoted: by `R24-P3-03` this diff's
  repository-gate set is **EMPTY**, measured with `git diff --stat HEAD -- . ':!phase-preparation'`
  (empty). npm 10.9.4. **No cold column was taken at this head and none is implied.**
* **Guard deletion, one deletion per copy, read by NAME** — three copies, each in its own local
  clone with this head's pack copied in, one guard deleted in each and nothing else, every copy
  `--write`-refreshed after the deletion (baseline rc 0 in all three), all `--no-db`:

| copy | one deletion | result | arms that moved, by name |
|---|---|---|---|
| c1 | the link test in `classify_dirs` -> `if False` | 93 ok, **3 not as required** | `plant-link-to-directory`, `plant-link-to-directory-subtree`, `plant-retracted-behind-link` |
| c2 | the `HEAD^{commit}` half of the repository test | 95 ok, **1 not as required** | `plant-repo-without-commit` |
| c3 | the not-a-regular-file refusal -> `if False` | 95 ok, **1 not as required** | `plant-fifo-in-the-pack` |

  c1 is `R28-P1-01` reproduced through the suite rather than by hand: with the one test removed,
  `plant-retracted-behind-link` answers **rc 0** again. c3's deletion does not hang the tool, and
  the reason is worth stating rather than leaving to luck: the FIFO falls through to
  `zz-fifo: ARTIFACT WITH NO ROW`, because a file with **no row** is refused before it is read.
  The hang needs a row to exist — measured separately: `open(<fifo>,'rb').read()` under
  `timeout 3` is killed at rc 124, so it does not return. The refusal is what keeps that out of
  reach, and the arm reads the refusal **by name** rather than the exit code, which is why c3 moves
  at all.

## 6. Residuals, named and not claimed as closed

* **Inside a REAL repository directory inside the pack — one that git accepts AND that resolves a
  commit — no instrument of this pack pins a file, AND no retraction this pack enforces is
  enforced.** Amendment 33 §6 said the first half and not the second; `R28-P2-01` is what made the
  omission matter. All three instruments skip such a directory identically, so no published figure
  moves and no two figures disagree — and that, together with this paragraph, is why the sentence
  "this manifest pins this pack" is still not made anywhere in it. `plant-real-repo-excluded`
  measures the exclusion and the summary names the directory, so a head that silently starts
  pinning it, or silently stops naming it, reds.
* **The unreadable-directory refusal is UNMEASURED-at-runtime in this container** (§1): uid 0 can
  list a 000 directory, so no plant can make it fire here. It is code and a sentence, not a
  measured guard.
* **The count prefix inside the subtree digest is unarmed** — deleting it moves no gate, because
  the refusals shipped beside it make the shape it defends against unconstructible inside this
  pack. The challenger reproduced that null result this round.
* **A reviewer report nested in a subdirectory of the counterpart folder reds rather than being
  located.** The lane names the relative path; the pack mirrors top-level names only. Fail-closed,
  and the refusal says what it looked for.
* **The `tools/` row's digest covers the file that defines the domain**, which is why the sibling
  pin lives in each instrument rather than being read from the file, and why `domain-sibling-mutated`
  arms it independently. The challenger's measurement stands: the weakest link is a `--write` of
  the manifest by whoever already controls the tools.
