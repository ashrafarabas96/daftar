# P14 INDEPENDENT CHALLENGE — ROUND 27, at `d34763e`

Subject: `1b694d1..d34763e` (one commit, `phase14: close R26-P1-01 — the manifest's
own enumeration was a fail-open`), 8 files, +722/−16, nothing outside
`phase-preparation/phase14/`.

**VERDICT: PASS-WITH-SCOPE.** The three holes of `R26-P1-01` (extension, recursion,
case) are closed and each is armed; I rebuilt the arms and they discriminate. One
**P1** remains: the replacement enumeration's own declared exclusion is a hiding
place, and a document hidden in it **moves a figure published for this SHA**, so
`R26-P1-01` is NARROWED, not closed. Five P3s. No false measured claim found in
the range's prose.

**Signature scope.** I sign `d34763e` for what the range claims about the
enumeration's three closed holes and for the figures reproduced in §6. My
signature expressly does **NOT** cover the sentence *"this manifest pins this
pack"* — the coordinator's `R26` instruction gated exactly that sentence, and
`R27-P1-01` below is why it still cannot be made. Covers this SHA alone, with the
manifest digest `28468fc6547b` (`tools/`) and `ca5e3c405b15` (`proofs/`).

---

## 1. `R27-P1-01` (P1) — the structural exclusion is a hiding place, and the hidden document moves a published figure

The new enumeration prunes with `is_repo_dir(p)` — `HEAD` a file, `objects/` and
`refs/` directories. The comment beside it says a repository "is a repository, not
pack content, so neither this tool nor `retracted-claims.py` enumerates it — they
must agree on the domain". Those **two** tools do agree; I measured it. The pack
has **three** instruments.

Built in a clone of `d34763e`, one plant, `--check` re-run after it:

```
plant: zz-hide/{HEAD (a plain file), objects/, refs/, zz-doc.md}
manifest-digests.py --check   rc=0   0 refusals
   "every artifact row matches the file on disk, and every file has a row."
retracted-claims.py --check   rc=0   "...across 42 pack document(s)"  (unchanged)
citation-provenance.py --check rc=1  "GENERATED CITATION-PROVENANCE BLOCK IS STALE."
control, plant removed:        rc=0  "generated citation-provenance block is current."
```

`citation-provenance.py` prunes by **name** (`dirs[:] = [d for d in dirs if d !=
'.git']`, lines 200 and 358) while the other two prune by **structure**. So the
asymmetry `R26-P1-01` was about — one instrument reading what the pin cannot see —
is reintroduced in the instrument the comment does not name.

**The figure moves.** `citation-provenance.py --write` with the plant present:

```
-  taken from **42 document(s)**
+  taken from **43 document(s)**
+ | `apps/api/.../pos-permissions.ts` | **ABSENT at 6fc505d** | ... | zz-hide/zz-doc |
- | `apps/api/.../pos-permissions.ts` | **ABSENT at 6fc505d** | ... | P14-AMENDMENT-05-MISSION-V3, P14-MIGRATION-PATCH-REQUEST |
```

The planted document does not merely inflate the population; it becomes the
**named source** of a provenance row and displaces the honest attribution.

**It survives a commit.** `objects/` and `refs/` only have to exist, so
`zz-hide/{HEAD, objects/.keep, refs/.keep, zz-doc.md}` is committable. On my local
probe commit (`f75691a`, never pushed, discarded):

```
git ls-files -- zz-hide  ->  zz-hide/HEAD  zz-hide/objects/.keep
                             zz-hide/refs/.keep  zz-hide/zz-doc.md
manifest-digests.py --check      rc=0  "...and every file has a row."
retracted-claims.py --check      rc=0  "...across 42 pack document(s)"
citation-provenance.py --check   rc=0  (block regenerated: **43 document(s)**)
```

A head whose tree carries a pack document with **no row anywhere** passes all
three gates, the green line says *every file has a row*, and the two figures
published for that same head disagree about what the pack is (42 against 43).

Bounds, measured, in both directions:
* The hiding place costs **three** entries and **no git repository at all**:
  truncating `HEAD` to an empty file left `--check` at rc 0 with 0 refusals.
* It works **nested inside a declared subtree**: the same shape as
  `proofs/zz-hide/` left `--check` at rc 0, retracted-claims at 42.
* The exclusion is **declared** in the refusal's own domain sentence ("excluding
  only this manifest and any directory that IS a git repository"), and the claim
  that spelling does not pass is **true**: `zz.git/x.md` refused by name,
  `SUBTREE WITH NO ROW: zz.git/`.
* No execution path: `python3 -I` still reports `safe_path: True`, so nothing in
  the hiding place is importable by an instrument.

Because the pre-range enumeration hid the same document (and more), this is
`R26-P1-01`'s **residue**, not a defect introduced here. The remedy is one line:
`citation-provenance.py` must prune with the same `is_repo_dir`, and the
population sentence must say what it excludes.

## 2. `R27-P2-01` (P2) — the subtree-digest law is measured false

The refusal and both subtree rows publish a law: *"an added, removed, renamed or
edited file moves this digest."* `subtree_digest` joins `'%s  %s\n' % (hash,
relpath)` over sorted rows, and a path may contain a newline, so a row is
forgeable from a **file name**.

Measured with the tool, through a declared row I added and `--write` filled:

```
tree A  zz-sub/{a: "content one" (11 B), b: "" (0 B)}
        --write  ->  row `14e1dced77c0...` over 11 bytes;  --check rc=0
tree B  zz-sub/ holding ONE file named  a\n<sha256 of empty>  b   with A's content
        (file `b` REMOVED, file `a` RENAMED, 2 files -> 1)
        --check rc=0, no refusal; manifest byte-identical (cmp clean)
```

So two different directories carry one digest **and** one byte total, and
`--check` cannot tell them apart. `subtree_digest` already computes the file
count; the row does not pin it, and it appears only inside the refusal text. A
fix is cheap: pin the count in the row, or delimit the rows with `\0` /
percent-escape the path.

## 3. `R27-P3-02` (P3) — the published recomputation recipe does not agree with the tool

The `tools/` row offers a reviewer the `find | sort | sha256sum` recipe quoted
beside `subtree_digest` as a way to recompute "without this tool". Measured:

```
ordinary tree A:                 recipe 14e1dced...  == tool 14e1dced...   (faithful)
tree A + symlink  zz-sub/c -> a: tool rc=1  "3 file(s) ... 65c357e07ca8 over 22 bytes"
                                 recipe 14e1dced...  (the PINNED value, unchanged)
tree B (the §2 world):           recipe errors twice, returns a924fd4171d6
```

`find -type f` skips symlinks; `open(fp,'rb').read()` follows them, and the
symlink's target bytes are counted twice. On a tree with one symlink the reviewer
following the pack's own recipe computes the pinned digest and concludes nothing
drifted, while the instrument refuses. The direction is safe (the tool is
stricter) but the offer of an independent recomputation does not hold.

## 4. `R27-P3-03` (P3) — a dangling symlink in a declared subtree is an unnamed failure

```
zz-sub/c -> nowhere-at-all
manifest-digests.py --check  rc=1
  Traceback ... line 777 in main: sh, sbytes, sfiles = subtree_digest(sd)
            line 75 in subtree_digest: b = open(fp,'rb').read()
  FileNotFoundError: [Errno 2] No such file or directory: './zz-sub/c'
retracted-claims.py --check  rc=0   (unaffected)
```

rc 1 with a traceback where rc 1 means STALE: the defect class of `R23-P2-01` and
`R24-P3-01`, inside code added here. `named()` in the sweep would catch it; a
human reading the exit code would not.

## 5. `--reports-in-tree`, three P3s

* **`R27-P3-04`** — **the INDEX satisfies a refusal headed `NOT IN THIS COMMIT`.**
  With the report staged and never committed: gate **rc 0**, while
  `git cat-file -e HEAD:phase-preparation/phase14/P14-CHALLENGE-zzzzzzz.md` is
  **rc 128** (`exists on disk, but not in 'HEAD'`). Unstaged, the same world
  refuses by name at rc 1. Nothing in the sweep reads HEAD alone, so a green lane
  does not imply the pushed head carries the report — which is the failure the
  lane exists for. A `--at-head` leg, run after committing, closes it.
* **`R27-P3-05`** — **with no repository it blames the commit.** On a `git
  archive` export of `d34763e` (the coordinator's own documented method), for a
  report the commit **does** carry and the directory **does** hold:
  `REVIEWER REPORT NOT IN THIS COMMIT: P14-CHALLENGE-1b694d1.md ... this commit
  does not carry it (neither the index nor HEAD has ...) ... Commit the file
  unedited with its row BEFORE pushing`, while the same run's `read:` line says
  `repository NONE (no repository was walked)`. The cause is disclosed elsewhere
  in the output; the refusal states a false fact about a commit, and a reader
  sent to that sentence would commit a file that is already committed.
* **`R27-P3-06`** — **the new check's own enumeration is the shape `R26-P1-01` was
  about.** `os.listdir(_rdir)` with a case-sensitive prefix:
  `P14-CHALLENGE-zzzzzzz.md` rc 1 named; `P14-COORD-DIFF-REVIEW-zzzzzzz.md` rc 1
  named; `p14-challenge-zzzzzzz.md` **rc 0**; `sub/P14-CHALLENGE-zzzzzzz.md`
  **rc 0**. It narrows a warning rather than a pin, which is why it is P3.

## 6. What I reproduced, and the arms

* **`gate-sweep.sh` at the head, my own single run in my own clone:
  rc 0, 87 ok, 0 gate(s)/proof(s) not as required, 0 off-repository lane(s)
  differ.** Exactly the author's figure.
* **All 81 rows verified against disk by my own script, not the tool**: 79 file
  rows + 2 subtree rows, **0 mismatches**, and both subtree digests reproduced
  independently — `tools/` 5 files / 235,911 B / `28468fc6547b`, `proofs/` 49
  files / 107,024 B / `ca5e3c405b15`. 5 + 49 = 54, matching the tool's "54
  file(s) under 2 declared subtree(s)".
* **35** manifest revisions reachable from HEAD (`git rev-list HEAD -- <manifest>
  | wc -l`), matching "all 35 revision(s)".
* Both reviewer reports of the previous round are committed **byte-identical** to
  the frozen files and to their rows: `P14-CHALLENGE-1b694d1.md`
  `9db03084f64c…` / 10,325 B (mine, the digest I announced) and
  `P14-COORD-DIFF-REVIEW-1b694d1.md` `49f560a64844…` / 4,977 B; both `cmp`-clean
  against the shared copies.
* **The nine plant arms discriminate**, and the deletion table's arithmetic is
  right this time (baseline + five deletions = six copies, the `R24-P3-02`
  lesson applied).
* **`R27-P3-07` (P3): the exclusion is armed on its OUTCOME and not on its
  DISCIPLINE.** Two guard-deletion copies, each in its own clone of `d34763e`,
  one change in each and `--write`-refreshed after it, both `--no-db`:
  * `is_repo_dir` -> `return False` (the exclusion **deleted**): **75 ok, 4 not
    as required** — `shallow-optin-prints-the-limit`,
    `blobless-optin-prints-the-limit` and `shallow-no-counterpart-optin` all red
    with `SUBTREE WITH NO ROW: .git/ holds 29 file(s)`, and `pinned-path-order`
    loses its premise. Every one of them moves because its own synthetic pack
    sits at the root of a repository — they measure the exclusion's **enabling
    purpose**, which is what the comment says it is for.
  * `is_repo_dir` **widened from structure to spelling** (`basename == '.git' or
    endswith('.git')`): **79 ok, 0 not as required.** Nothing reds. So the
    comment's own discipline sentence — *"the test is structure and not spelling,
    so a directory merely CALLED `x.git` is still pinned"* — is true at this head
    and **wholly unarmed**, and no plant asks what the exclusion makes
    invisible. That is the two-sweep rule of `P4 R32`: sentences about a guard's
    outcome and sentences about its discipline share no words.

  In both copies one off-repository lane differs (`manifest-shared`, `tools/:
  row says 610e3b44eefb`), because the edit I made lives inside the declared
  `tools/` subtree and moves its digest. That belongs to my method, not to the
  head.

## 7. Disclosures about my own runs

* I made one local commit in my own clone (`f75691a`) to measure §1's committed
  world. It was never pushed, the clone is back at `d34763e` with an empty
  `git status --porcelain` and `--check` rc 0.
* The §2 and §3 worlds were built inside a declared subtree I added for the
  purpose (`zz-sub/` with its own row), filled by `--write`, and removed; the
  manifest was restored from the index and HEAD and re-verified at rc 0.
* The `--reports-in-tree` worlds used `--witness` pointed at a directory of my
  own (`/tmp/w21/wit27`). **I did not write anything into
  `/mnt/project-files/phase14` except this report**, because a gate whose subject
  is that folder certifies no commit.
* Figures in §6 come from one run each, in a clone of `d34763e`, with no other
  sweep running.
