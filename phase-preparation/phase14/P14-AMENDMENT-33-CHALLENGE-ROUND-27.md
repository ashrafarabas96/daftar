# Phase 14 — amendment 33: challenge round 27 answered

**Subject reviewed:** `d34763e` (the head that closed `R26-P1-01`).
**Verdicts received:** challenger **PASS-WITH-SCOPE** with **one P1 (a fail-open)**, **one P2 (a
measured-false law)** and **six P3s**; coordinator **REFUSED TO SIGN** `d34763e` and ruled the two
blockers and three remedies that this amendment carries out.
**Reviewer's words, committed unedited in this same commit and hashed from disk:**
`P14-CHALLENGE-d34763e.md` (12,666 B,
`10f569104af1387644d2661a24e306a0e957618662393bbee6fc91d3fbb820b8`), the digest the challenger
announced for the frozen file.

`d34763e` carries **no signature**. Phase 14 remains **PREPARED / NOT PROMOTED**, and the sentence
"this manifest pins this pack" is **still not made anywhere in this pack** — §1 and §6 say why.

## 1. `R27-P1-01` (P1, a FAIL-OPEN) — round 26's own remedy was a hiding place

Round 26 replaced a non-recursive, case-sensitive `os.listdir` with a walk, and excluded the one
directory that is not pack content — a git repository — by **structure**: `HEAD`, `objects/` and
`refs/` all present. It wrote the rule *"two instruments over one directory must enumerate the same
domain"* and then proved that sentence against **the two tools it was thinking of**. The pack has
**three**. `citation-provenance.py` pruned by **name** (`d != '.git'`) at both of its walks.

**Reproduced before anything was changed**, in a fresh clone of `d34763e`, with
`zz-hide/{HEAD, objects/, refs/, zz-doc.md}` planted (`HEAD` empty):

| instrument | verdict with the plant present |
|---|---|
| `manifest-digests.py --check` | **rc 0**, printing *"every artifact row matches the file on disk, and every file has a row"* |
| `retracted-claims.py --check` | **42 pack document(s)** — unchanged, the plant invisible to it too |
| `citation-provenance.py --check` | rc 1 |
| `citation-provenance.py --write` | **moved a PUBLISHED figure from `42 document(s)` to `43`** and made the planted file the **named source** of a provenance row |

So the defect is not the invisibility, it is the **asymmetry**: a document no instrument of this
pack pinned, which one instrument published a count of and attributed a row to.

**And the structural test was itself too weak.** The challenger's cheapest forgery is those three
entries with an **empty `HEAD`** — which **git rejects** and a `HEAD`/`objects`/`refs` test
**accepts**. Measured on this container with every `GIT_*` scrubbed, replace objects and grafts
disabled, and the binary resolved once on the pinned path:

```
git --git-dir=<a real bare repository> rev-parse --git-dir   rc 0
git --git-dir=.git                     rev-parse --git-dir   rc 0
git --git-dir=proofs/                  rev-parse --git-dir   rc 128
git --git-dir=<HEAD empty + objects/ + refs/> rev-parse --git-dir   rc 128
```

`git -C <dir> rev-parse` is the wrong question: it answers rc 0 for **every** directory inside a
repository and would have excluded `proofs/`.

### The fix, as the coordinator ruled it

**One shared enumeration, loaded by digest, for all three instruments.** The domain now lives in
`tools/pack-domain.py`. Each instrument reads it **by path** and **refuses unless its sha256 equals
a literal pinned in that instrument**, then `exec`s it. The three cannot drift: there is one walk.
An edited domain refuses in all three until each pin is updated deliberately. (The tools run under
`python3 -I`, where `sys.path[0]` is the stdlib zip and a sibling module is **not importable** — the
challenger verified there is no execution path — so it is loaded by path and not imported.) The
file is inside the declared `tools/` subtree, so the manifest pins its bytes as well.

The repository question is now **put to git**, and a directory git **cannot be asked about** is
neither excluded nor silently kept: it stays in the domain **and** the run carries a named
refusal, because this pack's standing rule is to refuse what it cannot classify.

### Measured after the fix, in the probe clone, one plant at a time

| world | git's verdict | manifest | `retracted-claims` | `citation-provenance` |
|---|---|---|---|---|
| baseline | — | rc 0 | 42 documents | rc 0 |
| `zz-hide/` (empty `HEAD`, structure-shaped) | **rc 128** | **rc 1**, `SUBTREE WITH NO ROW: zz-hide/ … (zz-doc.md)` | **43** | **rc 1** |
| `zz.git/` (spelling only, no structure) | — | **rc 1**, `SUBTREE WITH NO ROW: zz.git/` | **43** | **rc 1** |
| `zz-real/` (a real bare repository) | **rc 0** | rc 0, naming `excluded as repositories: zz-real` | 42 | rc 0 |
| baseline restored | — | rc 0 | 42 | rc 0 |

All three instruments now move together, or none of them does.

### Armed in `gate-sweep.sh`

`plant-repo-shaped-forgery` (the forgery reds **by name**), `plant-spelling-dot-git` (spelling is
not structure — this is `R27-P3-07`, below), `plant-real-repo-excluded` (the exclusion's other
side: green **and** the directory named in the summary), `domain-pin-manifest` /
`domain-pin-retracted` / `domain-pin-provenance` (one byte appended to the shared domain must make
**all three** refuse at rc 2 with the same named refusal — the mechanism that guarantees the
ruling), and `domain-sibling-absent` / `domain-sibling-mutated` (the two ways the new dependency
can fail, both the CONFIGURATION code and never rc 1, which is this gate's STALE code).

## 2. `R27-P2-01` (P2) — the subtree-digest law was measured FALSE

The `tools/` and `proofs/` rows each claim *"an added, removed, renamed or edited file moves this
digest"*. A record of the form `"<digest>  <relpath>\n"` is **not injective**, because a **file name
may contain a newline**. **Reproduced before the fix:**

```
tree A: {a: 11 bytes, b: 0 bytes}
tree B: ONE file named "a\n<sha256 of empty>  b" holding the same 11 bytes
both:   73c805c216a6051b45912d7c1aedf619ba9844df471f14881c7c4e59dd1d7332   total 11 bytes
collide: True
```

**Two changes answer it**, both in the shared domain. The **file count is inside the digested
text** (`"<n> file(s)\n"` first, then the rows), so two trees of different sizes cannot agree; and a
name a line-based record cannot carry — **NUL, newline, carriage return** — is **REFUSED by name**
rather than digested.

**Symbolic links are refused by name too, dangling ones included** (`R27-P3-02` and `R27-P3-03`).
`find -type f` skips a link; `open(fp,'rb').read()` followed it and counted the target's bytes
twice, so a reviewer using the published recipe computed the pinned digest while the tool refused —
and a **dangling** link raised an unhandled `FileNotFoundError` **at rc 1**, which is this gate's
STALE code, from inside the digest. A link is neither the file it names nor content of its own.

**The published recipe now reproduces the tool exactly** (`R27-P3-02`), rather than being merely
close — a published recipe that is close is a false sentence about how a figure was made:

```
  { printf '%s file(s)\n' "$(find <dir> -type f | wc -l)"; \
    find <dir> -type f | LC_ALL=C sort | while read -r f; do \
      printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "${f#<dir>/}"; done; } \
    | sha256sum
```

Falsified against the tool on a three-file tree, two levels deep:

```
tool   bcdd28ed2d15d8a389ef7c46d2fb75ec1a6bc5cf7596f0c6f8a474d58851ca45  8 bytes  3 files
recipe bcdd28ed2d15d8a389ef7c46d2fb75ec1a6bc5cf7596f0c6f8a474d58851ca45
```

The recipe is faithful **only on a tree the tool would accept**, and that is said where it is
offered: a refused name or link makes the tool refuse and leaves the shell hashing something the
pack does not contain. Armed as `plant-symlink-in-subtree`, `plant-dangling-symlink` and
`plant-newline-in-name`.

**Both subtree digests therefore move at this head** (`proofs/` holds the identical 49 files and
107,024 bytes, and its digest changes because the count line is now inside it). That is the law
being repaired, not content drifting.

## 3. `--reports-in-tree`, the three P3s and the coordinator's third remedy

* **`R27-P3-04`** — the index satisfied a refusal headed `NOT IN THIS COMMIT`. A staged file is in
  the index and not in the commit, so a green lane did not imply the pushed head carried the
  report, which is the failure the lane exists for. There is now an **`--at-head` leg that reads
  HEAD alone** (`--reports-at-head`), run in the sweep **after** the commit, and the refusal's
  heading **names the leg it ran** (`NOT CARRIED BY THIS COMMIT (INDEX OR HEAD)` or `NOT CARRIED BY
  HEAD ITSELF`) instead of claiming one and testing the other.
* **`R27-P3-05`** — with no repository to ask, the refusal **blamed a commit it had not looked at**:
  on a `git archive` export it printed *"this commit does not carry it"* for a report the commit
  does carry, while the same run's `read:` line said `repository NONE`. A reader sent to that
  sentence would commit a file that is already committed. It is now a **named refusal**:

```
NO REPOSITORY TO ASK: this pack was read at ., where git reports no repository
(`rev-parse --show-toplevel` rc 128, `--show-prefix` rc 128), so whether HEAD itself carries
the reviewer report(s) in <dir> is a question that COULD NOT BE PUT and nothing here is a
verdict about it. Run this lane in a checkout.
```

* **`R27-P3-06`** — the new check's own enumeration was `R26-P1-01`'s shape inside `R26-P3-02`'s
  fix: `os.listdir` with a case-sensitive prefix. It is now the **shared walk**, recursive and
  case-insensitive. Measured at this head, both of the challenger's rc-0 worlds now red by name:

```
NOT CARRIED BY THIS COMMIT (INDEX OR HEAD): p14-challenge-zzzzzzz.md
NOT CARRIED BY THIS COMMIT (INDEX OR HEAD): sub/P14-CHALLENGE-yyyyyyy.md
```

* **`R27-P3-07`** — the exclusion was armed on its **outcome** and not on its **discipline**: the
  challenger deleted round 26's exclusion and four arms moved, then **widened it from structure to
  spelling** and **nothing moved**, so the comment's own sentence *"the test is structure and not
  spelling"* was true and wholly unarmed. That is `P4 R32`'s two-sweep rule — sentences about a
  guard's outcome and sentences about its discipline share no words. `plant-real-repo-excluded`
  arms the outcome; `plant-spelling-dot-git` arms the discipline.

**This commit's own `--reports-at-head` lane was RED until the commit was made**, naming
`P14-CHALLENGE-d34763e.md`, which is the lane working.

## 4. A disclosure about how this head was built

The first patch that wired `manifest-digests.py` to the shared domain computed its deletion range
by index and **silently removed five module constants with it** (`REVIEWER_PREFIXES`, `MARKER`,
`MARKER_PY`, `MARKER_ERE`, `_PINNED_PATH`, `_GIT_BIN` and the `_refuse_unrunnable_git` wrapper).
`ast.parse` reported the file **syntactically valid**, and so did I. What found it was **running
the tool**: `NameError: name '_GIT_BIN' is not defined`, at rc 1 — this gate's STALE code. The
file was reverted and the patch reapplied as six narrow replacements, each asserting it matched
exactly once; the diff against `d34763e` was then read line by line for deletions, and it now
removes exactly the four intended blocks. **A syntax check is not a deletion check**, and a tool
that is not run has not been checked.

## 5. Exit codes at this head

Taken after the last write to any document of this round, which is the manifest itself. Per round
18's rule, **no count of the manifest's own revisions is quoted here**; that figure is re-measured
in a fresh clone of the pushed head and reported to the reviewers. Per `R25-P3-02`, the sweep
figure below is the one reproducible from this commit alone and the off-repository lanes are
reported apart from it.

* `tools/gate-sweep.sh --no-db` — the figure reproducible from this commit alone: **90 ok, `0
  gate(s)/proof(s) not as required`**, from four working directories. 88 at `d34763e`; the arms
  added are `plant-repo-shaped-forgery`, `plant-spelling-dot-git`, `plant-real-repo-excluded`,
  `domain-pin-manifest`, `domain-pin-retracted`, `domain-pin-provenance`, `domain-sibling-absent`,
  `domain-sibling-mutated`, `plant-symlink-in-subtree`, `plant-dangling-symlink`,
  `plant-newline-in-name` and the `reports-at-head` lane, and two of the figures moved out of `ok`
  into the off-repository group.
* `tools/gate-sweep.sh`, the off-repository lanes — **3 differ**, so the script exits **1**,
  fail-closed, and none of the three is part of the figure above. Read line as printed:
  `/mnt/project-files/phase14 — 81 file(s), newest 2026-10-19T11:20:46Z, read at
  2026-10-19T11:50:17Z`.
  * `manifest-shared` — first line `STALE: P14-MIGRATION-PATCH-REQUEST.md: row says
    712055431561/114,350 bytes, file is f47db62c155a/114263 bytes`. That folder is the pre-push
    mirror of `d34763e` and by amendment 31 §1 it is written only **after** a push.
  * `reports-in-tree` — `REVIEWER REPORT NOT CARRIED BY THIS COMMIT (INDEX OR HEAD):
    P14-CHALLENGE-d34763e.md`.
  * `reports-at-head` — `REVIEWER REPORT NOT CARRIED BY HEAD ITSELF: P14-CHALLENGE-d34763e.md`.

  Both reports lanes name the report this commit adds, which is **the lane working**: the sweep
  above was run before the commit existed. The `--at-head` leg's own difference from the index leg
  is what `R27-P3-04` asked for, and it is visible in those two sentences.
* `tools/manifest-digests.py --check` — **rc 0**, identical from the pack directory and the
  repository root: **83 rows + the manifest itself** (81 artifacts and 2 declared subtrees), **81
  files at the top level and 55 under the two subtrees**, `0 directory(ies) were excluded as
  repositories: none` at this head, and the domain sentence printed in full. The `tools/` digest
  moves because `pack-domain.py` joins the subtree; the `proofs/` digest moves over the **identical
  49 files and 107,024 bytes**, because the count line is now inside the digested text — that is §2
  being repaired, not content drifting.
* `tools/citation-provenance.py --check P14-MIGRATION-PATCH-REQUEST.md` — rc 0 after the generated
  block was regenerated for this round's documents, with the walk now shared.
* `tools/retracted-claims.py --check` — rc 0: **28 retracted claims enforced across 43 pack
  documents; 40 challenge reports exempt in code.** No claim was added this round; the counts move
  by exactly this amendment and this round's committed report.
* repository `npm run format` — not re-run, and no number is quoted: by `R24-P3-03` this diff's
  repository-gate set is **EMPTY**. Measured, not assumed: `git diff --stat HEAD -- .
  ':!phase-preparation'` is empty, and every path in the commit is under
  `phase-preparation/phase14`. npm 10.9.4. **No cold column was taken at this head and none is
  implied.**
* **Guard deletion, one deletion per copy, read by NAME** — four copies, each in its own local
  clone of this repository at `d34763e` with this head's pack copied in, **one guard deleted in
  each and nothing else**, and every copy **`--write`-refreshed after the deletion** (the pin over
  `tools/` makes every deletion stale by construction, so an unrefreshed copy measures the pin and
  not the guard). All `--no-db`:

| copy | one deletion | result | arms that moved, by name |
|---|---|---|---|
| c1 | the `_DOMAIN_SHA` pin check in `manifest-digests.py` -> `if False` | 88 ok, **2 not as required** | `domain-pin-manifest`, `domain-sibling-mutated` |
| c2 | the unnameable-name refusal in `pack-domain.py` -> `return None` | 89 ok, **1 not as required** | `plant-newline-in-name` |
| c3 | the symlink refusal in `pack-domain.py` -> `if False` | 88 ok, **2 not as required** | `plant-symlink-in-subtree`, `plant-dangling-symlink` |
| c4 | the **count prefix** in `subtree_digest` -> rows only | **90 ok, 0 not as required** | **none** |

  c1 moves only the two arms that read *this* tool's pin, because only this tool's pin was deleted;
  `domain-pin-retracted` and `domain-pin-provenance` stay green, which is one deletion per copy
  working as intended. Each of c2, c3 and c4 edits the shared domain, so each copy's three pins were
  updated to **its own** domain first, or every instrument would have refused on the pin instead of
  running the guard under test; that is disclosed here rather than left to a reader.

  **c4 is a measurement, not a pass.** The count prefix is the half of §2's fix that is **not**
  itself a refusal, and no plant in this pack can arm it, because the refusals shipped beside it
  make the ambiguous shape unconstructible: a name carrying a newline is refused before any digest
  is taken. It is defence in depth whose own contribution is **unarmed at this head**, measured and
  named in §6 rather than asserted to be covered.

## 6. Residuals, named and not claimed as closed

* **A file inside a REAL repository directory inside the pack is pinned by no instrument of this
  pack.** All three now skip it identically, so no published figure moves and no two figures
  disagree — and that is exactly why the sentence "this manifest pins this pack" is still not made
  anywhere in it. `plant-real-repo-excluded` measures the exclusion and names the directory in the
  summary, so a head that silently starts pinning it, or silently stops naming it, reds.
* **A reviewer report nested in a subdirectory of the counterpart folder reds rather than being
  located.** The lane names the relative path; the pack mirrors top-level names only. Fail-closed,
  and the refusal says what it looked for.
* **The count prefix inside the subtree digest is unarmed.** Deleting it moves no gate (§5, c4),
  because the refusals shipped beside it make the shape it defends against unconstructible inside
  this pack. Both halves of §2's fix are kept — the refusal that can be armed, and the prefix that
  cannot — and the prefix is named here rather than counted as covered.
* **The `tools/` row's own digest covers the file that defines the domain.** The pin over
  `pack-domain.py` is therefore computed by an instrument that loads it — which is why the
  *sibling* digest pin exists in each tool and is armed independently (`domain-sibling-mutated`),
  and why the pin literal is in the instrument rather than read from the file.
