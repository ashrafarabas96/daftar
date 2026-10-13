# P14 — AMENDMENT 21: the anchor stops being a similarity score, and a false row of mine is retracted

**Answers** `P14-CHALLENGE-d14e14b.md` (round 15, verdict **REJECT**, three blockers) and the
coordinator's ruling on it, which ruled all three blocking. `PREPARED / NOT PROMOTED`; documents
and proof tooling only; no phase code, no migration, no CI change.

**What the round closed in my favour, for the record:** `R14-P0-01` is fixed — `npm run format` is
rc 0 at `d14e14b`, and the challenger checked that the green comes from the FILE and not from an
exclusion (empty diff over `package.json`, `.prettierignore`, `.prettierrc.json`,
`prettier.config.js` and `.gitattributes`; `02bf8ca` touches nothing outside
`phase-preparation/phase14/`). Five of its six attack worlds refuse by name, and the `:(top)`
premise is sound from four working directories.

---

## 1. `R15-P0-03` (BLOCKING, and the one that is mine twice over) — the `typecheck` row was false

Amendment 20 §6 published `npm run typecheck` as **0/0/0** under the sentence *"Nothing was run
from a checkout that had been built before"*, and concluded from it that `G6`'s typecheck half does
not reproduce. **Both the row and the conclusion were false, and the sentence above them was
false.** My measurement loop ran the four gates in sequence inside each clone, so `build` ran
immediately before `typecheck` in the same directory: every typecheck reading was taken in a tree
the previous gate had just populated with the packages' `dist/*.d.ts`.

Measured again, each reading in a clone that had run `npm ci` and **nothing else**, node v24.12.0 /
npm 11.6.2:

| gate | subject (this commit) | prev head `d14e14b` | merge-base `6fc505d` |
|---|---|---|---|
| `npm ci` | 0 | 0 | 0 |
| `npm run format` | **0** | **0** | **0** |
| `npm run lint` — **cold** | 1 (`4220 problems`) | 1 (`4220 problems`) | 1 (`4220 problems`) |
| `npm run lint` — after `build` | **0** | **0** | **0** |
| `npm run build` — **cold** | 1 (`TS2307 '@daftar/inventory'`) | 1 | 1 |
| `npm run build` — run again | **0** | **0** | **0** |
| `npm run typecheck` — **cold** | **2** | **2** | **2** |
| `npm run typecheck` — after `build` | 0 | 0 | 0 |

Each column is a pair of fresh clones at that revision with its own `npm ci` (rc 0 in all six):
one clone runs only the cold readings, the other runs `build` first and then the after-build ones,
so no number in the cold rows was taken in a tree another gate had populated. The subject column is
a clone of `d14e14b` with this commit's pack content applied; it differs from the commit only in
this amendment's own words, which are these numbers. Node v24.12.0 / npm 11.6.2, the Node the
repository declares.

**Two of my three "inherited from `main`" verdicts were also wrong, in the other direction.**
`lint` is not a standing red: it is rc 1 **cold** with 4,220 `no-unsafe-*` errors that come from
reading unbuilt `dist/*.d.ts`, and rc **0** once `build` has run. `build` itself is rc 1 on a cold
tree and rc **0** when run a second time in the same tree. So on `main` and on this branch alike,
**every one of the five gates is green in a tree where `build` has run twice**, and the reds are an
ordering artefact of the cold tree, not failures of the code. What is true of all three worlds
equally is only that: none of this is this branch's doing, and none of it is a standing failure
either.

So **`G6` reproduces as far as a cold tree goes** — cold on `main`, root `build` is rc 1 AND
`typecheck` is rc 2, which is what the index carried and what my correction wrongly struck — and it
is **narrower than the index says** in the other direction: both gates are green in a built tree,
and a second `build` run is green too. The 0s are an ORDER effect, not a verdict: `build` exits 1
and still emits enough declarations for `tsc --noEmit` and for `eslint` to resolve
`@daftar/inventory`. Every row is published in both orders from here on, and
`tools/RETRACTED-CLAIMS.tsv` fences my false ones by their own sentences.

**The lesson, and it is the one this pack keeps writing about other people's measurements:** a gate
measured after another gate ran in the same directory is not a cold reading. One clone per order,
or state the order beside the number. I wrote *"nothing was read from a warm tree"* in the same
document whose own loop warmed it.

---

## 2. `R15-P0-01` (BLOCKING, fail-open) — the anchor rested on git's rename-similarity score

The challenger's world `G2` is the round-14 world plus one thing: the promotion commit that
renames, moves and forges **also rewrites the manifest's prose**. Then both legs of the union miss
— the basename changed, and git no longer scores the rename — and the tool answered rc **0**
printing *"checked over all 1 revision(s)"* over a history of four. Their measurement of the
mechanism is the part that settles it: `--follow` default → 1, `-M50%` → 1, `-M20%` → 1,
`-M10%` → 4. **Tuning `-M` is the same lottery at different odds**, so the remedy removes the
dependency instead of tuning it, as the coordinator ruled.

**The anchor is now a MARKER the manifest carries** — the fixed literal `# P14-HANDOFF-MANIFEST.md`
as a whole line, held in the tool and not read from the file, because a marker the subject chooses
is not an anchor. Four mechanisms, each measured:

1. **Identity.** The file given as `--manifest` must carry the marker **exactly once**, or the run
   refuses `NOT ANCHORED` before any history is read. An attacker who strips the marker to escape
   the grep does not get a 0; measured, rc **1**.
2. **Discovery.** `git log --no-renames -G '^marker$'` lists every HEAD-reachable revision whose
   patch adds or removes a marker line — which is every revision that created, deleted, moved or
   renamed the manifest, whatever it was called. `--no-renames` is load-bearing and measured: WITH
   rename detection a move is presented as a rename whose unchanged lines are not in the patch, and
   this leg found 1 revision of 3 in `G2`; without it, 2 of 3, the add and the move.
3. **Resolution.** `git grep -l --full-name -E '^marker$' <rev>` says which file in that revision
   carries it, so the path is read from the tree rather than guessed from a name. `git grep` has no
   `-x` ("unknown switch", measured) and `-F` matches a **substring**, which made this tool's own
   source a carrier on the first attempt — hence the explicit anchors.
4. **Closure.** Every path so discovered seeds `rev-list HEAD -- <that path>`, and resolution runs
   again on whatever that adds, until no new path appears. This is what makes the set complete
   across a CHAIN of moves: a commit that moves the file changes both the old and the new path, so
   it is listed by the old path's `rev-list`, and its own grep then yields the next path.

The legs that round 14 built — basename anywhere in the tree, and `--follow` — are kept and
unioned, and **neither is the anchor any more.**

**And the backstop that holds even if every discovery leg finds nothing but the forging revision:**
the completeness test asked only the BASENAME of the parents of the oldest revision, so a parent
carrying the manifest under its OLD name looked empty and the forging commit passed as *the commit
that added it*. It now asks the marker as well, so that parent is seen and the history is
`NOT CHECKED`.

**Measured on the world, both tools, same directory:**

| | `d14e14b`'s tool | this commit's tool |
|---|---|---|
| `G2` (rename + move + prose rewrite + forge, one commit) | **rc 0**, *checked over all 1 revision(s)* | **rc 1**, `REVIEWER ROW REWRITTEN IN HISTORY`, 2 revisions |

Premise asserted in the proof itself: 1 revision by basename, **1** by `--follow`, more than one by
the marker. If a future git scores that rename, the premise fails and the proof **FAILS** rather
than passing quietly.

---

## 3. `R15-P0-02` (BLOCKING, fail-open) — a path git quotes was read as a path that is absent

`core.quotePath` defaults **true**, so every git command that emits a path quotes a non-ASCII one
(`"\331\205..."`). That string was handed straight back to `ls-tree -- <path>`, which answers
**empty at rc 0** — indistinguishable here from *the path is not in this tree*. In the challenger's
world `M` — the manifest added and amended at an Arabic path, then moved to a new basename with the
forge — **both revisions holding the true digest were counted as gaps** and the tool printed rc 0
with *"the manifest is ABSENT in 2 of them — removed and re-added"*. This is an ar/en/tr product;
that path shape is ordinary, not exotic.

**Every git call of this tool now runs with `-c core.quotePath=false`**, and a path that still
arrives quoted or escaped is a **named refusal**, never a skip, because a skipped revision is a
record that was never compared. Measured on the world: `d14e14b`'s tool rc **0** with the false
cause; this commit's tool rc **1**, three revisions, no gaps.

---

## 4. `R15-P3-01` — the gap sentence named a cause that was not the cause

*"ABSENT in N of them — removed and re-added"* is a CAUSE; what is measured under it is only that
git reports no file carrying the manifest in those trees. In world `M` it was reached by a lookup
failure where nothing had been removed at all. The sentence now claims what was read, and names the
two states it is consistent with. Eighth instance of this species, and the red proof that reads
the sentence follows it.

---

## 5. `R15-P1-01` — `GATE-035`'s 55 had an undeclared precondition, and it is a CI line, not an owner decision

From a clean single-branch clone of this branch the sweep is rc **1** — 4 × `citation-provenance`
rc 2, *CONFIGURATION ERROR: --repo … does not contain 93084f8* — because the migration-freeze
anchor is reachable from neither `main` nor this branch, so no clone of either carries it. The
failure is **fail-closed and correct**: a provenance table cannot be verified against a tree that is
not there. What was wrong was that nothing in the pack said so.

**And the remedy is smaller than I first wrote.** A coordinator relay of the Phase 8 challenger's
measurement said GitHub serves the commit by its full object name, and I re-measured it in a clean
CI-shaped clone rather than repeat it: `git fetch --depth 1 origin 93084f8` is refused
(*couldn't find remote ref*), and
`git fetch --depth 1 origin 93084f82b8e36ad49ebb207c0b6e7435d7fcb49f` succeeds, after which
`git cat-file -t` on it answers `commit` and `citation-provenance --check` in that same clone is rc
**0**. In a clone without the fetch it is rc 2. **So this needs no new ref and no owner action** —
it is one line in a CI job — and the earlier sentence that it "waits on Ashraf" is retracted in
`tools/RETRACTED-CLAIMS.tsv`.

The gate's own output now says it: the refusal names the anchor, says a plain clone does not carry
it, gives the full-object-name fetch, and says the abbreviation is refused by the server. The
`P14-GATE-035` row and the handoff say it too.

**One thing the same relay prompted, measured here rather than assumed:** `--base` defaulted to the
7-character abbreviation, and an abbreviation is not an anchor — it can become ambiguous as the
repository grows, and a `replace` object can stand another tree in its place. The full 40-character
object name is now pinned in `tools/citation-provenance.py`; when the default `--base` is used,
what it resolves to is required to BE that literal, with a named refusal when it is not; and every
git call of that tool runs `--no-replace-objects`.

**One line the handoff now carries, on the coordinator's instruction:** CI must never pass
`--allow-unverified-history`. It is the deliberate opt-out for a history that cannot be read, it
prints its own limit, and a job that passes it is asserting nothing.

---

## 6. What is still open at this head

The revision figure for the manifest's own history is **22** at `d14e14b`, not the 21 I reported in
that handoff — 21 was `02bf8ca`'s number and `d14e14b` touched the manifest. Carried, unchanged:
`R14-P3-01` and `R-1` as named residuals; `COORD P3-07`; `R10-ADD-01`; the PROPOSES-new-directory
property; the preflight version arm UNFENCED; concurrency and performance UNMEASURED; `npm run
lint` and `npm run build` inherited from `main`; `TL-P14-SEC-01/-02/-03`; §7a and §11a with the
Security and Migration Owners, no migration number named; and `OD-P14-09`, `OD-P14-10`,
`OD-P14-11` with the owner.

**No head of this phase is signed, and this one is not either until the challenger and the
coordinator return.** The new anchor is a union of mechanisms a commit can still touch — a marker
can be reproduced, and the refusal for that is `AMBIGUOUS` — so the next round is asked to attack
the anchor itself rather than the legs around it.

---

## 7. Each new guard deleted, and what that measured

The challenger's method, run here before handing the head over: delete one guard at a time in a
copy of the tool and see whether the world it protects comes back. The exit code alone does not
answer that — these worlds refuse for several reasons at once — so what is read is the **refusal by
name**.

| guard deleted | `G2` | Arabic path | marker decoy | marker stripped |
|---|---|---|---|---|
| *(nothing deleted)* | REWRITTEN IN HISTORY | REWRITTEN IN HISTORY | AMBIGUOUS | NOT ANCHORED |
| the marker discovery legs | **NOT CHECKED** | REWRITTEN IN HISTORY | **no history refusal** | NOT ANCHORED |
| `core.quotePath=false` | REWRITTEN IN HISTORY | REWRITTEN IN HISTORY | AMBIGUOUS | NOT ANCHORED |
| the more-than-one-carrier refusal | REWRITTEN IN HISTORY | REWRITTEN IN HISTORY | **no history refusal** | NOT ANCHORED |
| the subject-marker requirement | REWRITTEN IN HISTORY | REWRITTEN IN HISTORY | AMBIGUOUS | **NOT CHECKED** |
| the marker in the parents test | REWRITTEN IN HISTORY | REWRITTEN IN HISTORY | AMBIGUOUS | NOT ANCHORED |

**Two of the six rows say something I would otherwise have claimed falsely.**

*The quoting guard looks dead in that table and is not.* Deleting it alone leaves every world
refused, because the marker discovery leg finds those revisions by content and does not need the
path lookup that the quoted string broke. So it was isolated against the head it fixes instead:
`d14e14b`'s tool with **nothing added but `-c core.quotePath=false`** turns the Arabic world from
rc **0** ("every artifact row matches") to rc **1**. The guard is load-bearing; in this head two
independent defences cover that world, and neither is claimed as the only one. This is the
[two-defences-one-unreachable] shape read the right way round: both are reachable here, and the
measurement says so rather than the design.

*The subject-marker requirement does not change the verdict, only the sentence.* With it deleted,
a manifest whose marker has been stripped is still refused — as `NOT CHECKED`, because nothing can
then be found in history. Its contribution is the NAME: *the file you gave me is not anchorable*,
said before a history is walked, instead of a reader having to infer it from an empty walk. That
is what the row above claims and nothing more.

The other four rows are the ordinary result: deleting the discovery legs loses `G2`'s
`REWRITTEN IN HISTORY` (the parents backstop still refuses, fail-closed) and loses the decoy
refusal entirely; deleting the carrier-count refusal loses the decoy and nothing else; and the
parents-test marker is covered by the discovery legs in this world set, which is why §2 names it a
backstop rather than the anchor.
