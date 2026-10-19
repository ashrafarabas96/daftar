# Phase 14 — amendment 23: challenge round 17 answered

**Subject reviewed:** `b49d612da3164e746c26ef10ce612f648bc3933b`.
**Verdict received:** REJECT, one blocking finding, in a sentence that commit added.
**Reviewer's words:** `P14-CHALLENGE-b49d612.md` (12,568 bytes,
`1ed42b9bdc2049a48bc29c3d62f68c798fa3cd110adced105e27d1826d843787`) and
`P14-CHALLENGE-b49d612-ADDENDUM-01.md` (3,843 bytes,
`78e9c5eea257ef814a358337479ff382e3029aec55a3ab63c8acf6a87d1b0dfd`), both committed unedited
and both hashed from the file on disk, not from the message that announced them.

This amendment is the ONE commit owed. Phase 14 remains **PREPARED / NOT PROMOTED** and has
**no signed head at any SHA**.

## 1. `R17-P1-01` — CONCEDED, and it is mine twice over

The finding is correct as written, and I reproduced it before changing anything.

`_marker_revs.add(_r2)` sat inside the **path**-discovery loop:

    for _r2 in _rl.stdout.split():          # the PATH leg's own output
        _marker_revs.add(_r2)               # credited to the MARKER leg

so the set the summary reports as *found by the marker it carries* was written by both legs. Two
consequences, both measured:

* On the real pack the sentence printed **24 of them found by the marker**. The marker leg's own
  command —
  `git log --format=%H --no-renames -G '^# P14-HANDOFF-MANIFEST[.]md[[:space:]]*$' HEAD -- ':(top)'`
  — answers **1**. The figure in the output was not the figure the command returns.
* The count **could never be low**, so the one world the sentence exists to expose — an *inert
  anchor*, where the marker leg matches nothing at all — printed its whole revision count back as
  marker-found. Amendment 22 claimed this sentence makes *"an inert anchor visible in the output
  rather than asserted away by it"*. It did the opposite, which is the harsher reading and the
  correct one.

It is **not a fail-open**: `rc` is unchanged in every world the reviewer and I built. It is a false
measured claim, which the stopping rule treats as blocking, and the reviewer applied that rule
rather than the softer one available to them.

**The fix is the deletion the reviewer asked for.** The line is gone; `_marker_revs` is now written
**once**, from the marker leg's own output, with a comment saying nothing else may add to it. No
other behaviour moves: the revision set still comes from both legs, and only the attribution
changes.

Measured, with the marker leg's figure read from git in each world before either tool runs:

| world | marker leg (`git log -G`) | path leg | `b49d612` printed | this head prints |
|---|---|---|---|---|
| the REAL pack, `/mnt/project-files/phase14` | 1 of 24 | 24 | **24 of them found by the marker** | **1 of them**, rc 0 |
| honest text world, 2 revisions | 1 | 2 | **2 of them**, rc 0 | **1 of them**, rc 0 |
| `*.md binary`, an INERT anchor, honest manifest | **0** | 2 | **2 of them**, rc 0 | **0 of them**, rc 0 |

The third row is the point: `*.md binary` makes git produce no textual diff, so `-G` cannot match a
marker that is still there verbatim and still found at `HEAD` by `git grep` — an anchor inert
through no fault of the manifest. The old tool reported it as fully marker-found. This head reports
zero, which is what the leg returns.

**Two red proofs now cover the count**, which nothing did before — the reviewer names that absence
as the reason the defect survived into `b49d612`. `marker-count-plain` and `marker-count-binary`
build those two worlds, read the marker leg's figure, the path leg's figure and the carrier at
`HEAD` **from git**, fail loudly as `premise not built` if any of them is not what the world is
supposed to be, and then require the output to contain *— `<that figure>` of them found by the
marker*. A tool that credits path revisions to the marker leg cannot satisfy a message built from
git's own answer.

## 2. `R17-P3-01` — CONCEDED

Amendment 22 §1 said *"At this head, on the real pack, that count is 23 of 23."* Wrong twice: the
figure was measured before this commit existed (the head printed 24), and the count itself was the
mixed one. The sentence is struck in place in `P14-AMENDMENT-22-CHALLENGE-ROUND-16.md` with a
pointer here, and `23 of 23` is now row 24 of `tools/RETRACTED-CLAIMS.tsv`, enforced against every
pack document and allowed only in that amendment and in reviewer reports.

This is the **eleventh** instance of *a sentence wider than the measurement under it*, and the
second time in two rounds that the wider sentence was a figure I had quoted from an earlier run
instead of re-measuring at the head. The rule the pack already carries — re-count every number a
document claims, with the command the document names — is the rule I broke.

## 3. What the reviewer closed, recorded as theirs

* **`R16-P0-01` CLOSED** over seven spellings of the marker (exact LF, trailing space, trailing tab,
  committed CRLF, trailing NBSP, BOM, leading space), each under the full attack — rename, move,
  prose rewrite past the similarity threshold, forge, in one commit. Space, tab and CRLF are
  `rc 0 → rc 1`. NBSP was a fail-open at `7f6f535` and is a named `NOT ANCHORED` here; BOM and
  leading space refuse at both heads. They did not take the code comment's word that the Python
  class and `[[:space:]]` agree — they measured the ASCII equivalence and recorded that everything
  outside ASCII lands on the fail-closed side.
* **The HEAD assertion is load-bearing, and in their world it is a genuine `0 → 1`**, not the
  rc-1-at-both-heads I measured: the subject inside the repository, `HEAD`'s committed copy filed
  under a different heading, so `carriers(HEAD)` is empty — `7f6f535` rc 0 over 4 revisions,
  `b49d612` rc 1 `NOT ANCHORED`. They also checked that another file's carriership cannot satisfy
  the assertion on the subject's behalf.
* **`R16-P1-01` CLOSED**, with their cell standing for `7f6f535` and retired at `b49d612`, and with
  my inability to reproduce their rc 0 at this head confirmed rather than disputed.
* **Repository gates**: one never-built clone, Node v24.21.0 / npm 11.19.0, in order — `ci` 0,
  `format` 0, `lint` COLD 1 (4,220 problems), `typecheck` COLD 2, `build` FIRST 1, `build` SECOND 0,
  then `lint` 0, `typecheck` 0, `format` 0. Identical to `7f6f535` and to the merge-base, so no
  repository red is added by this branch.

## 4. The parents branch — still a named residual, and still not witnessed

The reviewer's fifth construction (a root commit without the manifest, with only that commit's tree
object deleted) refuses identically at both heads and **upstream of my branch**: `rev-list` reads
that tree before the parents test is reached, so the refusal is `NOT CHECKED (… fatal: unable to
read tree …)`. Five constructions between us, none reaching the state. The change is right by
reading, fails closed in direction, and is **reasoned, not witnessed**. Neither of us signs it as
reproduced, and it is recorded as a residual under `P14-RULE-TOOLING-STOP`, not as a closed
fail-open.

## 5. The addendum's named residual, now written down

Addendum 01 §1 measured the four attacks I had declared unattempted — a second committed carrier,
add-here/remove-there in one commit, the marker inside a fenced code block, the parent backstop
under a graft boundary — and found all four already refused by name at both heads, so none is
behaviour this commit introduced. Its residual is a convention the pack depended on and never
stated: **any other pack document carrying the manifest's marker on a line of its own turns this
gate `AMBIGUOUS`**, fail-closed but surprising to the author of the next amendment. It is now the
third precondition in §2 of `P14-HANDOFF-MANIFEST.md`. No code change: the refusal is correct, and
the constraint was the undocumented part.

## 6. Exit codes at this head

Every figure below was taken at the head this amendment is committed in, after the last document
write, which is the manifest itself.

* `tools/gate-sweep.sh` — **rc 0, 67 ok, `0 gate(s)/proof(s) not as required`**, from four working
  directories, with the anchor `93084f82b8e3` present in the repository so `citation-provenance` can
  run. 65 at `b49d612`; the two added are `marker-count-plain` and `marker-count-binary`.
* `tools/manifest-digests.py --check` — rc 0, 57 artifact rows + the manifest, 57 files,
  ~~24 revisions~~, **1 of them found by the marker**, in both lanes.
  **`24 revisions` RETRACTED IN ROUND 18 (`R18-P1-01`).** That is the PARENT's figure: at
  `c001cd9` the manifest's own history is **25** revisions, because the commit publishing this
  amendment modifies the manifest and so adds the revision being counted. Rows, files and the
  marker count reproduce exactly; the revision count did not. See
  `P14-AMENDMENT-24-CHALLENGE-ROUND-18.md` §2 for the rule this adds: a history-derived number
  cannot be made safe by measuring it after the last document write, and has to be re-measured in
  a clone of the PUSHED head.
* `tools/citation-provenance.py` — rc 0. Its generated block in `P14-MIGRATION-PATCH-REQUEST.md`
  was regenerated this round and then re-checked, because this round's documents moved it.
* `tools/retracted-claims.py` — rc 0, 24 claims across 33 pack documents, 26 reviewer reports
  exempt in code. `23 of 23` is allowed in three files, each of which quotes it AS retracted: the
  amendment that published it, this amendment, and the manifest row that records the round.
* repository `npm run format` — rc 0.

## 7. The order these numbers were taken in

Every figure in §6 comes from a run made **after** the last write to any document of this round. The
last write of all is to `P14-HANDOFF-MANIFEST.md`, which carries no row for itself, so that write
cannot retire a quoted run — the rule this pack has been applying since round 13. The sweep count
was re-measured after that write and is the same 67.

Three documents were written before those runs and are therefore covered by them:
`P14-AMENDMENT-22-CHALLENGE-ROUND-16.md` (the struck sentence), `tools/RETRACTED-CLAIMS.tsv` (row 24
and its allowed list) and `P14-MIGRATION-PATCH-REQUEST.md` (the regenerated provenance block).
