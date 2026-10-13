# P14 — AMENDMENT 22: the anchor and its own test differed by one byte

**Answers** `P14-CHALLENGE-7f6f535.md` (round 16, verdict **REJECT**) and the coordinator's ruling,
which ruled both items blocking. `PREPARED / NOT PROMOTED`; documents and proof tooling only.

---

## 1. `R16-P0-01` (BLOCKING, fail-open) — the subject test normalised, the history legs did not

The marker anchor built in round 15 tested three things in two different ways:

* the subject, with `ln.rstrip() == MARKER`, which eats a trailing space, a tab and a CR;
* the two history legs, with an exact `^# P14-HANDOFF-MANIFEST[.]md$`, which do not.

So a manifest whose marker line carries **one trailing space**, or that is committed **CRLF**,
satisfies the subject requirement while **both** legs find nothing — and the summary still said
*found by the marker it carries and by every path it has held*. The challenger's point about the
steady state is the sharper half: such a pack runs with the anchor **silently inert from the day
the byte appears**, forgery or no forgery, and nothing in this pack forbids either spelling.

**Measured here, three worlds identical but for that one byte** — each is three honest commits and
then ONE commit that renames to a new basename, moves out of the pack, rewrites enough prose to
defeat the rename score, and forges a reviewer row. Premises read from git in every case: four
revisions exist, the basename leg sees 1, `--follow` sees 1.

| world | exact marker at HEAD | `7f6f535`'s tool | this commit's tool |
|---|---|---|---|
| **control** — marker exact, LF | `promoted/HANDOFF.md` | rc 1, `REWRITTEN IN HISTORY`, 3 revisions | rc 1, `REWRITTEN IN HISTORY`, 3 revisions |
| **K2** — one trailing space | *none* | **rc 0**, *checked over all 1 revision(s)*, *every artifact row matches* | **rc 1**, `REWRITTEN IN HISTORY`, 3 revisions |
| **CRLF** — committed CRLF | *none* | **rc 0**, same two sentences | **rc 1**, `REWRITTEN IN HISTORY`, 3 revisions |

The control is in the table and in the sweep because without it these two worlds would prove only
that something refuses.

**The remedy is in two parts, and the challenger measured that each alone is insufficient.**

1. **One normalisation, written once and used three times.** `MARKER_PY` and `MARKER_ERE` are
   derived from the same literal: the marker line is the literal followed by any run of ASCII
   whitespace and nothing else. `[[:space:]]` in the C locale is space, tab, newline, vertical tab,
   form feed and CR — exactly the Python class used for a single line, and a line cannot contain
   the newline. The `.` is escaped as `[.]` rather than with `re.escape`, because `re.escape` also
   escapes `#`, `-` and the space, and an ERE is not obliged to accept those as escapes.
2. **The anchor is asserted, not assumed.** Matching the three places alike does not protect
   against the next spelling nobody thought of. So: if the subject carries the marker and HEAD is
   in a readable repository where **no file carries it**, the tool refuses `NOT ANCHORED` by name
   instead of walking a revision set the marker had no part in choosing. Measured on a world whose
   committed manifest sits under a different heading while the working copy carries the marker:
   `7f6f535`'s tool says *checked over all 2 revision(s) … found by the marker*, this commit's says
   `NOT ANCHORED`. **Both exit 1** in that world — the forged row is caught by its digest — so this
   is not a 0 → 1 flip, and the proof's own comment says so. What changes is that no sentence
   claims the marker found anything when it found nothing.

**And the summary now reports what the legs contributed** — *N of them found by the marker it
carries, the rest by a path it has held* — so an inert anchor is visible in the output rather than
asserted away by it. ~~At this head, on the real pack, that count is 23 of 23.~~
**RETRACTED IN ROUND 17 (`R17-P3-01`).** Two things were wrong with that sentence. The figure
`23` was measured before this commit existed and the head prints `24`; and the count itself was
false, because the path-discovery loop added its own revisions to the marker set
(`R17-P1-01`), so the sentence *could never be low* and the inert-anchor world it claims to
expose printed its whole revision count back. On the real pack the marker leg's true
contribution is **1** of 24, which is `git log --no-renames -G`'s own answer. Corrected in
`P14-AMENDMENT-23-CHALLENGE-ROUND-17.md`; the code is corrected there too.

Four red proofs: `marker-ctrl-world`, `marker-space-world`, `marker-crlf-world`,
`marker-absent-from-head`, each asserting its premise from git before it runs.

---

## 2. `R16-P1-01` (BLOCKING, false measured exit code) — and my world was weaker than my prose

`P14-AMENDMENT-21` §7 published, for the row *the subject-marker requirement* and the column
*marker stripped*, the cell `NOT CHECKED`, and said in prose that the requirement *"does not change
the verdict, only the sentence"*. The challenger deleted **only those nine lines** and measured
**rc 0** — *checked over all 4 revision(s) … found by the marker it carries*, plus *every artifact
row matches the file on disk*. The verdict changes **1 → 0**, so that check was the **only** defence
for that world.

Two things were wrong, and the second is the one worth carrying:

* **The prose inferred a deleted-guard behaviour from what the other guards cover, instead of
  deleting it and running it.** That is the method this pack has used against everyone else's
  claims, applied to its own.
* **My world could not have shown the defect.** The stripped-marker world in §7 is a pack copied
  into a plain directory with **no git repository at all**, so there is no history to walk and the
  answer is `NOT CHECKED` whatever the guard does. The challenger's world has the revisions from
  before the marker was stripped, so the walk is not empty: it is a walk of a lineage the subject
  no longer belongs to, and it comes back clean. A guard-deletion cell measured in a world that
  cannot reach the guarded state measures nothing.

The head was never fail-open here — the check is present — but the claim a reader would rely on
when deciding the check could be simplified away was false, and it is corrected in place in §7 of
amendment 21 together with a pointer to §4 below.

**What I could NOT reproduce, stated as a gap.** At the head that answers this round I built the
same shape — strip the marker, rename, move and forge in one commit, in a repository with three
honest revisions before it — and with the subject check deleted it still refuses
(`REWRITTEN IN HISTORY`), because the removal of a marker line is itself a `-G` hit, so the
pre-strip revisions are found and the honest digest is read; with both the subject check and the
new HEAD assertion deleted it also still refuses, for the same reason. **So I cannot show rc 0 at
this head, and I am not claiming the challenger's cell is wrong:** it was measured at `7f6f535`, in
their world, and it stands for that head. What the matrix below reports is this head's behaviour.

---

## 3. `R16-P3-01` — the Arabic cell named a mechanism that is not the one that fires

§7's `core.quotePath=false` row, Arabic-path column, said `REWRITTEN IN HISTORY` and explained it by
the discovery leg finding those revisions by content. Measured by the challenger: the refusal is
`NOT CHECKED`, naming the path — *git reported the manifest at revision 517d250f168c under a path
this tool cannot use verbatim* — because this head's own quoted-path refusal catches it one layer
earlier. Both exit 1, so nothing was fail-open; the mechanism named was not the one that fires.
Corrected in place. Their conclusion that the guard is load-bearing, isolated against `d14e14b`
where that world goes 0 → 1, is unaffected and they reproduced it. 22 of §7's 24 cells reproduce.

---

## 4. The deletion matrix re-run at this head, by refusal name

Seven guards, six worlds, every cell from deleting that guard in a copy of the tool and running it.
Exit codes are not reported alone because every one of these worlds also refuses for unrelated
reasons; what is read is the refusal's NAME. **Every cell below is rc 1.**

| guard deleted | G2 rename+move+rewrite | Arabic path | marker decoy | stripped (no repo) | K2 trailing space | marker absent from HEAD |
|---|---|---|---|---|---|---|
| *(nothing deleted)* | REWRITTEN | REWRITTEN | AMBIGUOUS | NOT ANCHORED | REWRITTEN | NOT ANCHORED |
| the one normalisation (exact `^marker$` only) | REWRITTEN | REWRITTEN | AMBIGUOUS | NOT ANCHORED | **NOT ANCHORED** | NOT ANCHORED |
| the HEAD-anchored assertion | REWRITTEN | REWRITTEN | AMBIGUOUS | NOT ANCHORED | REWRITTEN | **(no history refusal)** |
| the subject-marker check | REWRITTEN | REWRITTEN | AMBIGUOUS | **NOT CHECKED** | REWRITTEN | NOT ANCHORED |
| the marker discovery legs | **NOT CHECKED** | **(none)** | **(none)** | NOT ANCHORED | **NOT CHECKED** | **(none)** |
| the more-than-one-carrier refusal | REWRITTEN | REWRITTEN | **(none)** | NOT ANCHORED | REWRITTEN | NOT ANCHORED |
| `core.quotePath=false` | REWRITTEN | REWRITTEN | AMBIGUOUS | NOT ANCHORED | REWRITTEN | NOT ANCHORED |
| the marker in the parents test | REWRITTEN | REWRITTEN | AMBIGUOUS | NOT ANCHORED | REWRITTEN | NOT ANCHORED |

**What this says, and what it does not.** The K2 column moves when the normalisation is reverted —
to `NOT ANCHORED` rather than to rc 0, because the HEAD assertion then catches what the normalisation
no longer matches, which is the defence-in-depth the two-part remedy was built for; the challenger's
`7f6f535` measurement of rc 0 is what the same world does with **neither** part present. The
marker-absent column moves only when the assertion is deleted. The decoy column moves when either
the carrier-count refusal or the discovery legs go. Two rows do not move in any column here —
`core.quotePath=false` and the parents marker — and neither is claimed as dead on that basis:
quoting is isolated against `d14e14b` in §7 of amendment 21 (0 → 1 with that one option added), and
the parents marker is a backstop whose own world I have not reached (§5).

---

## 5. The parents collapse — fixed in code, reasoned and NOT reached

Found by reading `7f6f535` while holding, before this round asked for it: in the parents
completeness test, `_paths_at()` and `_carriers()` each return `None` for *that tree could not be
read* and `[]` for *the manifest is not in it*, and the expression collapsed both to falsy — so an
unreadable parent tree read as *the parent does not contain the manifest*, which is the permissive
value and makes the oldest discovered revision look like the commit that added it. Sixth instance
of unknown-resolving-to-permissive in this lane. Unknown is now `NOT CHECKED` by name.

**It has no red proof, and it is not reported as a closed fail-open.** Seven constructions between
us, every one refused upstream of the state: mine — deleting the parent's root tree object (also
breaks `rev-list --` and `log -G`, so the walk refuses first), a `--filter=tree:0` clone of a local
repo (the local server ignores the filter), a dead promisor on a full clone (changes nothing); and
the challenger's four — `--filter=tree:0` with the promisor unreachable, the oldest revision's
parent tree deleted, a merge whose second parent's tree is deleted, and a shallow clone with the
forgery across `.git/shallow`. They state plainly that they are not signing it as reproduced. So:
**a code-level correction resting on a reading, with the attempts named.**

---

## 6. `R16-R-01` — the CI recipe, now exact, and the sweep's header reworded

Both of us measured it independently and the figures agree. In a fresh **depth-1** clone of this
branch: the anchor fetch by full object name succeeds (`cat-file -t` → `commit`), and
`citation-provenance --check` then exits **2** naming a *second* missing object, `6fc505d`; after
fetching that too it exits **1**, `GENERATED CITATION-PROVENANCE BLOCK IS STALE` — **not 0**. A
`--write` in that clone moves exactly one file, which is the cause: with full history
`cases/c7a_cross_business_accepted.sql` is *deleted and still named*, without history the same file
falls into *PROPOSES and correctly does not exist yet*, and two counts move with it. In a
full-history clone plus the one anchor fetch: rc **0**.

**So the declaration is `fetch-depth: 0` AND one
`git fetch origin 93084f82b8e36ad49ebb207c0b6e7435d7fcb49f`, both, not one or the other** — and a
depth-1 checkout cannot pass however many objects are fetched, because a classification in the block
is derived from history. That is fail-closed and correct. `tools/gate-sweep.sh`'s header said
*fetch-depth: 0 does not help*, which is true of `fetch-depth: 0` alone and reads as an alternative
to the fetch; it now says both, and says why depth-1 cannot be rescued.

---

## 7. The repository's gates, and what is still open

The challenger re-ran all five in three worlds on **node v24.21.0 / npm 11.19.0**, one clone per
column, cold readings before any build: `format` 0/0/0; `lint` **1 cold, 0 after build**;
`typecheck` **2 cold, 0 after build**; `build` **1 first, 0 second**; and `format` still 0 after a
build at this head. That is the same table §1 of amendment 21 published on node v24.12.0 / npm
11.6.2, on a different Node, which is the control my own table did not have. `R14-P0-01` stays
closed, and `lint`/`typecheck` red-cold-green-built **at the merge-base too** is `G6`, not this
branch.

Pack gates at this head: `gate-sweep.sh` from four directories, `manifest-digests --check` in both
lanes, `citation-provenance --check`, `retracted-claims --check` — exit codes in the handoff message
rather than typed here, because a count typed into a document is one commit stale by construction
(`R-1`, still a named residual).

Carried, unchanged: `R14-P3-01`, `R-1`, `COORD P3-07`, `R10-ADD-01`, the PROPOSES-new-directory
property, the preflight version arm UNFENCED, concurrency and performance UNMEASURED,
`TL-P14-SEC-01/-02/-03`, §7a and §11a with the Security and Migration Owners (no migration number
named), and `OD-P14-09/-10/-11` with the owner.

**No head of this phase is signed.** The anchor is now tested by its own assertion rather than
trusted, which is the first time in this lane that a defence can report its own inertness — and the
next round is asked to find the spelling that satisfies both the subject test and the legs while
meaning a different line.
