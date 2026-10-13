# Phase 14 — independent challenge, round 16

**Subject:** `7f6f5356cee9204b99f897a2cbb4685c0c730a8c` (`7f6f535`), parent
`d14e14b01230da08dd88c0d31c4965b6d09990ce`. Resolved with replace objects disabled; the repository
serves no `refs/replace`. Subject clone `/tmp/g30`, fetched `--branch claude/project-thread-1zqgj8
--single-branch` from origin.

**Verdict: REJECT.** One fail-open in the anchor this round was convened to check, and one false
measured exit code in the guard-deletion matrix that accompanies it. Everything else the head
claims, I reproduced.

**Digest discipline.** This file was frozen before its digest was announced. Nothing was added to it
after the `sha256sum` whose value appears in the delivering message, and the delivering message
quotes the file on disk, not the reverse. Later findings will go in
`P14-CHALLENGE-7f6f535-ADDENDUM-01.md`, never by editing this file.

| id | sev | finding |
|---|---|---|
| `R16-P0-01` | P0 | The marker's two tests disagree by one byte. The subject side accepts `ln.rstrip() == MARKER`; both history legs demand `-E '^# P14-HANDOFF-MANIFEST\.md$'`. A manifest whose marker line carries a trailing space, or that was committed with CRLF line endings, therefore satisfies the subject check and is invisible to every history leg — and the tool still prints *"found by the marker it carries and by every path it has held"*. With the rename score defeated in the same commit, the forgery passes: rc **0**, *"checked over all 1 revision(s)"*, over a history of four. |
| `R16-P1-01` | P1 | `P14-AMENDMENT-21` §7, row *the subject-marker requirement*, column *marker stripped*, claims `NOT CHECKED`, and the prose under it says the requirement *"does not change the verdict, only the sentence"*. Measured with that one check deleted: rc **0**, no refusal of any name, and the sentence *"checked over all 4 revision(s) … found by the marker it carries"*. The verdict changes 1 → 0. |
| `R16-P3-01` | P3 | Same table, row `core.quotePath=false`, column *Arabic path*, claims `REWRITTEN IN HISTORY`. Measured: `NOT CHECKED`, naming the quoted path. The conclusion the author draws (the guard is load-bearing) is right and was reached by a separate isolation test; the cell and the sentence explaining it are wrong. |
| `R16-R-01` | — | Retraction of my own round-15 §6 sentence. See §6. |

---

## 1. What round 15 left open, closed by execution

Each line is the previous head's tool and this head's tool run against the identical world, same
command, no shell. `old` = `d14e14b` extracted to `/tmp/w21/md16-old.py`
(`bf6fd6f6c1e7276db29e0f8059d11f455aff9e14403aa6bcd415670f67254b17`), `new` = `7f6f535` extracted to
`/tmp/w21/md16-new.py` (`1852796660e784390b36bdd1ffcd1d56c8f44195ca73529fab5936342152918e`).

| world | attack | old | new |
|---|---|---|---|
| `B` | rename + move + prose rewrite + forge, one commit | **0** | **1** |
| `C` | three successive renames, then forge | **0** | **1** |
| `I` | move into an Arabic directory, forge | **0** (*"the manifest is ABSENT in 2 of them … removed and re-added"*) | **1** (3 revisions, no gaps) |

Premise asserted inside world `B`, not assumed: 1 revision by basename, 1 by `--follow`, 2 by the
marker leg, 4 total. The rename score is defeated, so the marker leg is what carries it.

Seven refusal routes confirmed **by name**, not by exit code: `D` marker in two files →
`AMBIGUOUS`; `D2` the marker's text mentioned inside a sentence → rc 0, honest, no refusal;
`E` marker stripped → `NOT ANCHORED (… carries the manifest marker 0 time(s), not once)`;
`J` a `"` in the filename → `NOT CHECKED`, naming the path; `H` `*.md binary` and `H2` `-diff` →
the `-G` leg is blinded (0 revisions) and the parents backstop fires → 1; `L` CRLF introduced only
in the forging commit → 1; `M` `* text eol=crlf` (git normalises to LF) → 1; `R` honest
remove-then-re-add → rc 0 with this head's cause-free gap sentence, *"git reports no file carrying
this manifest in 1 of them"*.

---

## 2. `R16-P0-01` — the anchor is disabled by one byte in the thing it anchors

The subject-side test and the history-side tests are not the same test:

    _subject_marks = sum(1 for ln in lines if ln.rstrip() == MARKER)      # subject: trailing ws stripped
    _g('grep','-l','--full-name','-E','^%s$' % re.escape(MARKER), rev, '--', ':(top)')   # history: exact
    _g('log','--format=%H','--no-renames','-G','^%s$' % re.escape(MARKER),'HEAD','--',':(top)')

`rstrip()` removes a trailing space, a tab and a `\r`. `^…$` in git's ERE does not. So a manifest
whose marker line is `# P14-HANDOFF-MANIFEST.md␠` — or whose whole file was committed CRLF — passes
the subject requirement and is found by **no** revision of either history leg, while the summary
line still says the history was *found by the marker it carries*.

Two worlds, each three honest commits then one commit that renames the manifest, moves it, rewrites
enough prose to put the rename below git's similarity threshold, and forges the reviewer row. A
third world, `CTRL`, is the same attack with the marker spelled exactly — the control that makes the
one byte the only variable.

| world | marker line | marker@HEAD | `-G` revs | `--follow` | basename | total commits | old | new | patched |
|---|---|---|---|---|---|---|---|---|---|
| `CTRL` | exact, LF | `HEAD:promoted/HANDOFF.md` | 2 | 1 | 1 | 4 | 0 | **1** | 1 |
| `K2` | one trailing space | *(empty)* | **0** | 1 | 1 | 4 | 0 | **0** | **1** |
| `G2` | exact, file is CRLF | *(empty)* | **0** | 1 | 1 | 4 | 0 | **0** | **1** |

`CTRL` reds this head. `K2` and `G2` do not. Their output:

    forged / new 7f6f535     rc=0
      checked over all 1 revision(s) of this manifest reachable from HEAD, OLDEST first,
      found by the marker it carries and by every path it has held

Four revisions exist. One was read. The sentence names the leg that found nothing as the leg that
found it.

Before the forgery the same worlds already print the false sentence while honest — `marker@HEAD`
empty, `-G` 0 revisions, and the summary still claims the marker found the history. So the failure
is not a property of the attack; it is the steady state of any pack whose marker line ever acquires
a trailing space or a CRLF, and nothing in the pack forbids either.

**Remedy, measured.** `/tmp/w21/md16-patched.py`, two parts, both needed:

1. Both history legs match the marker with trailing whitespace tolerated, the way the subject does:
   `'^%s[[:space:]]*$' % re.escape(MARKER)`.
2. An assertion that the anchor actually anchored: if `_carriers('HEAD')` is empty, the verdict is
   `NOT ANCHORED` and no sentence claims the marker found anything.

Part 2 alone is not enough — it refuses the world instead of walking it — and part 1 alone leaves a
tab-spelled or otherwise unmatched marker printing the same false sentence. Together: `K2` and `G2`
go **0 → 1** with `REVIEWER ROW REWRITTEN IN HISTORY` over 4 revisions.

**Regression, all 25 worlds in `/tmp/t22` plus the real pack.** Patched against this head's tool,
same manifest, same command:

| result | worlds |
|---|---|
| unchanged rc 1 | `B` `C` `CTRL` `D` `G` `H` `H2` `I` `J` `K` `L` `M` `N` `N_tree0` `O2` `O_corrupt` `P` `Q` `E` `F` |
| unchanged rc 0 (honest) | `A` `D2` `R` |
| **0 → 1** | `K2` `G2` |

Nothing else moves, and no honest world is made red. Against `/mnt/project-files/phase14` the two
tools are byte-identical in verdict and in figures: 52 artifact rows + the manifest, 52 files, the
reviewer-row history *checked over all 23 revision(s)*, rc **0**.

---

## 3. `R16-P1-01` — a refusal claimed where there is none

§7's matrix is read by refusal name, which is the right way to read it. I rebuilt it with this
head's tool and five one-guard-deleted copies, and it reproduces in **22 of the 24 cells** §7
prints. The two that do not (the `J` column is mine, added as a second quoted-path reading):

| guard deleted | `CTRL` (their `G2`) | `I` Arabic dir | `J` quote in name | `D` decoy | `E` stripped |
|---|---|---|---|---|---|
| *(nothing deleted)* | REWRITTEN/1 | REWRITTEN/1 | NOT CHECKED/1 | AMBIGUOUS/1 | NOT ANCHORED/1 |
| the marker discovery legs | NOT CHECKED/1 | REWRITTEN/1 | no refusal/0 | no refusal/0 | NOT ANCHORED/1 |
| `core.quotePath=false` | REWRITTEN/1 | **NOT CHECKED/1** | NOT CHECKED/1 | AMBIGUOUS/1 | NOT ANCHORED/1 |
| the more-than-one-carrier refusal | REWRITTEN/1 | REWRITTEN/1 | NOT CHECKED/1 | no refusal/0 | NOT ANCHORED/1 |
| the subject-marker requirement | REWRITTEN/1 | REWRITTEN/1 | NOT CHECKED/1 | AMBIGUOUS/1 | **no refusal/0** |
| the marker in the parents test | REWRITTEN/1 | REWRITTEN/1 | NOT CHECKED/1 | AMBIGUOUS/1 | NOT ANCHORED/1 |

The row that matters is the fifth. §7 claims `NOT CHECKED` there and explains that the requirement
contributes only a name, *"because nothing can then be found in history"*. Measured, with only
those nine lines removed from the tool:

    E / subject-marker check DELETED   rc=0
      reviewer-row history checked over all 4 revision(s) of this manifest reachable from HEAD,
      OLDEST first, found by the marker it carries …
      every artifact row matches the file on disk, and every file has a row.

    E / nothing deleted                rc=1
      reviewer-row history NOT ANCHORED (the file given as the manifest carries the manifest
      marker 0 time(s), not once)

Something **is** found in history — the revisions from before the marker was stripped — so the walk
is not empty, it is a walk of a lineage the subject no longer belongs to, and it comes back clean.
The requirement is the only defence for that world, not a label on a defence that holds without it.
The head itself is not fail-open here, because the check is present; what is wrong is the claim
about what the rest of the tool covers, and that claim is what a reader would rely on when deciding
whether the check may be simplified away.

---

## 4. `R16-P3-01` — the quoting cell

Same table, the `core.quotePath=false` row, Arabic column. §7 says `REWRITTEN IN HISTORY` and
explains it with *"the marker discovery leg finds those revisions by content and does not need the
path lookup that the quoted string broke"*. Measured:

    I / quotePath DELETED   rc=1
      NOT CHECKED (git reported the manifest at revision 517d250f168c under a path this tool
      cannot use verbatim: "\331\205\330\261\330\255\331\204\330\251/M.md")

    I / nothing deleted     rc=1
      checked over all 3 revision(s) … REVIEWER ROW REWRITTEN IN HISTORY

Both are rc 1, so nothing here is a fail-open; the refusal is a different one, and the explanation
is the wrong mechanism. What actually catches it is the named quoted-path refusal this very head
added, firing one layer earlier than the leg the prose credits. §7's own conclusion — the guard is
load-bearing, proven by isolating it against `d14e14b` where the Arabic world goes 0 → 1 — is
unaffected, and I reproduce that isolation.

---

## 5. Repository gates, three worlds, nine readings each

`npm ci` first in every clone, then the readings in the order printed. Node **v24.21.0 / npm
11.19.0** throughout. *Cold* = a fresh clone after `npm ci` and nothing else; *after build* = the
same clone immediately after `npm run build`.

| reading | `/tmp/g30` `7f6f535` | `/tmp/g25` `d14e14b` | `/tmp/g26` `6fc505d` (merge-base) |
|---|---|---|---|
| `npm ci` | 0 | 0 | 0 |
| `npm run format` | **0** | **0** | **0** |
| `npm run lint` — cold | 1 (`4220 problems`) | 1 | 1 |
| `npm run typecheck` — cold | 2 | 2 | 2 |
| `npm run build` — first | 1 | 1 | 1 |
| `npm run build` — second | **0** | **0** | **0** |
| `npm run lint` — after build | **0** | **0** | **0** |
| `npm run typecheck` — after build | **0** | 0 | 0 |
| `npm run format` — after build | **0** | — | — |

`R14-P0-01` stays closed: `prettier --check .` is green at this head, and green at the merge-base,
so the branch adds no format red. `lint` and `typecheck` are red cold and green on a built tree at
**all three** heads including the merge-base, which is `G6` and not this branch's defect. The first
`build` being rc 1 and the second rc 0 in the same tree is the same fact from the other side: the
root `--workspaces` build runs apps before packages. Every cell above was measured in the order
listed, in one clone per column, so no cell is a warm reading presented as cold.

---

## 6. `R16-R-01` — retracting my own round-15 sentence, and confirming the author's narrowing

My round-15 §6 said a depth-1 clone needs the anchor **and** the merge-base and then passes. The
first half is right; the conclusion is wrong, and the author said so before I re-measured. My own
measurement, fresh depth-1 clone `/tmp/g31` at `7f6f535`:

    git clone --depth 1 --branch claude/project-thread-1zqgj8 --single-branch …   rc 0
    git fetch --depth 1 origin 93084f82b8e36ad49ebb207c0b6e7435d7fcb49f           rc 0   (cat-file -t = commit)
    citation-provenance.py --check …   rc 2   CONFIGURATION ERROR: … does not contain 6fc505d
    git fetch --depth 1 origin 6fc505d33b7a6f7a49fa04ee3bc60bb1ddf3b595           rc 0
    citation-provenance.py --check …   rc 1   GENERATED CITATION-PROVENANCE BLOCK IS STALE

With both objects present, a depth-1 clone is **rc 1, not 0**. The cause is one classification that
is derived from history, not from the two anchor commits — `--write` in that clone moves exactly one
file:

    -  1 file(s) (2 tokens) … proof scripts this pack DELETED and still names: cases/c7a_cross_business_accepted.sql
    - 10 file(s) (11 tokens) … PROPOSES and that correctly do not exist yet
    + 11 file(s) (13 tokens) … PROPOSES … including cases/c7a_cross_business_accepted.sql

A depth-1 clone cannot see the deletion, so the file reads as never-existing and two counts move.
The full clone with the one anchor fetch is rc **0**. **The correct CI declaration is
`fetch-depth: 0` AND one `git fetch origin 93084f82b8e36ad49ebb207c0b6e7435d7fcb49f`** — both, and
the second by the full 40-character object name, which `gate-sweep.sh`'s header now states. The
header's sentence *"fetch-depth: 0 does not help"* is true of `fetch-depth: 0` alone and is not an
alternative to it; a reader could take it as one.

---

## 7. Pack gates at this head

`manifest-digests.py --check`: rc **0** in both lanes, 52 artifact rows + the manifest, 52 files,
reviewer-row history over **23** revisions. The author's round-15 figure of 22 at `d14e14b` is
consistent with 23 at a head one commit later; this is not a discrepancy.

`gate-sweep.sh`, four working directories: **rc 1, 57 ok / 4 FAIL** in a clone that does not yet
hold the anchor, with all four failures being `citation-provenance` / `provenance-*` refusing at
rc 2 — fail-closed, and the sweep's own header names the precondition and the exact full-SHA fetch
command before the failures appear. After `git fetch --depth 1 origin
93084f82b8e36ad49ebb207c0b6e7435d7fcb49f` (rc 0): **rc 0, 61 ok / 0 FAIL**. The sweep also detected
that my scratch cluster had been stopped and restarted it via its `db-precondition` arm, then
reverted its own world (`no-cluster-revert` rc 0).

---

## 8. What I could not reach, stated as a gap and not as a pass

The coordinator asked me to hand over a red proof for the unknown-to-permissive collapse in the
parents test if my graft-boundary world reached that state. **It did not.** Four constructions, each
refused upstream of the state:

| construction | where it stopped |
|---|---|
| `N_tree0` — `--filter=tree:0` partial clone with the promisor made unreachable | `NOT CHECKED (this is a git repository, but it could not list the revisions …)`, rc 1 |
| `O2` — the oldest revision's parent tree object deleted | same named `NOT CHECKED`, rc 1 |
| `O_corrupt` — a merge whose second parent's tree is deleted | caught earlier as `REWRITTEN IN HISTORY`, rc 1 |
| `P` — shallow clone, forgery across the `.git/shallow` boundary | same named `NOT CHECKED`, rc 1 |

Every one of them fails closed at the named refusal, so I can neither confirm nor reproduce the
collapse the author found by reading the code. Their finding stands on their reading; it does not
stand on any measurement of mine, and I am not signing it as reproduced. `Q` separately confirms the
`--no-renames` leg is load-bearing for completeness: 2 revisions with it, 1 without.

---

## 9. Signature, withheld

**I do not sign `7f6f5356cee9204b99f897a2cbb4685c0c730a8c`.** One fail-open in the anchor
(`R16-P0-01`) and one false measured exit code in the matrix that documents the guards
(`R16-P1-01`).

What I will stand behind at a head that closes them: §1's three old-0-against-new-1 measurements and
seven named refusal routes, §5's twenty-five gate readings, §7's pack figures, and §3's matrix in the
22 cells that reproduce.

**Restated, unchanged since round 4:** nothing in this lane has landed on Phase 14's
**architecture**, which is unexecuted — no API, no DDL, no route, no CI job. Sixteen rounds have
measured the pack's own tooling and prose. None of it is credit against the first review of an
executed Phase 14.

**What I did not do.** No file of the author's was edited, in the pack or in the shared folder;
nothing was pushed; no migration was numbered; no branch was force-pushed and no history rewritten.
The patched tool is a copy under `/tmp/w21` and was never written into the pack. The one `--write`
I ran was `citation-provenance.py --write` inside my own throwaway depth-1 clone `/tmp/g31`, to read
the diff quoted in §6; `/mnt/project-files/phase14` and every clone of the branch were left
unmodified. The cluster was the scratch cluster on `/tmp/p14pg`, and no frozen migration was read or
written. This report has no manifest row yet, so the shared-folder lane will read
`ARTIFACT WITH NO ROW` until the author writes one.
