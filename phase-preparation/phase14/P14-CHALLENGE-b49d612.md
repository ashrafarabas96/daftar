# Phase 14 — independent challenge, round 17 (narrow)

**Subject:** `b49d612da3164e746c26ef10ce612f648bc3933b` (`b49d612`), parent
`7f6f5356cee9204b99f897a2cbb4685c0c730a8c` — ONE commit, as asked. Read with replace objects
disabled; the repository serves no `refs/replace`. Clones `/tmp/g32` (gates, pack) and `/tmp/g33`
(sweep), both `--branch claude/project-thread-1zqgj8 --single-branch` from origin.

**Verdict: REJECT.** One false measured count, and it is the count the commit added in order to make
a false sentence honest. Everything else in this round's five groups I measured, and all of it holds:
the one-byte fail-open of `R16-P0-01` is **closed**, the new `NOT ANCHORED` assertion is
**load-bearing (0 → 1)**, and `R16-P1-01` is **closed at this head** — the author is right that they
cannot reproduce rc 0 here, and I reproduce their reason.

**Digest discipline.** Frozen before the digest was announced. Nothing added after the `sha256sum`
whose value appears in the delivering message; later findings go in
`P14-CHALLENGE-b49d612-ADDENDUM-01.md`, never by editing this file.

**Your words, committed unedited.** `P14-CHALLENGE-7f6f535.md` at this head is 17,906 bytes,
`30f962e608e91cf736f63a1169d6994d4726d8f96cabd50229f704fd727157d9` — byte-identical to what I
delivered, with a manifest row that quotes it fairly, including my own `R16-P1-01` described as a
false measured exit code of mine. I note that without being asked to.

| id | sev | finding |
|---|---|---|
| `R17-P1-01` | P1 | The new summary count is not the legs' contribution. `_marker_revs.add(_r2)` sits **inside** the path-discovery loop, so every revision found by a PATH is counted as found by the marker. On the real pack the marker leg contributes **1** revision of 24 and the gate prints *"24 of them found by the marker it carries"*; with the `-G` leg fully blinded (`*.md binary`) the true contribution is **0** and it prints *"4 of them"*. The sentence was added so *"an inert anchor is visible in the output rather than asserted away by it"*; as written it cannot ever show one. Remedy: delete that one line — the real pack then prints **1**, matching `git log -G` exactly. |
| `R17-P3-01` | P3 | §1 of `P14-AMENDMENT-22` states *"At this head, on the real pack, that count is 23 of 23."* At this head it is **24 of 24** (and, correctly counted, 1 of 24). A figure measured before the commit existed, reported as the head's. |

---

## 1. One normalisation, shared by the subject and both legs — seven spellings measured

`MARKER_PY = ^…[ \t\r\f\v]*$` and `MARKER_ERE = ^…[[:space:]]*$`, written once and used three
times. I did not take the comment's word that the two classes agree; I measured each spelling as an
honest pack and then under the full attack (rename + move + prose rewrite past the similarity
threshold + forged reviewer row, all in one commit).

| subject marker | honest, `7f6f535` | honest, `b49d612` | forged, `7f6f535` | forged, `b49d612` |
|---|---|---|---|---|
| exact, LF (control) | 0 | 0 | **1**, 4 revisions | **1**, 4 revisions |
| **one trailing space** | 0 | 0 | **0**, *"all 1 revision(s)"* | **1**, 4 revisions |
| **one trailing tab** | 0 | 0 | **0**, *"all 1 revision(s)"* | **1**, 4 revisions |
| **file committed CRLF** | 0 | 0 | **0**, *"all 1 revision(s)"* | **1**, 4 revisions |
| trailing NBSP (U+00A0) | 0 | **1** `NOT ANCHORED` | **0** | **1** `NOT ANCHORED` |
| BOM at file start | **1** `NOT ANCHORED` | **1** `NOT ANCHORED` | **1** | **1** |
| one leading space | **1** `NOT ANCHORED` | **1** `NOT ANCHORED` | **1** | **1** |

`R16-P0-01` is **closed**: the three spellings that failed open at the parent go **0 → 1**, and the
two spellings the shared class does not cover — a non-ASCII space and a BOM — are refused **by name**
before any history is walked, which is the fail-closed direction. The NBSP row is a behaviour change
worth naming: at `7f6f535` an NBSP-suffixed marker was *accepted* by the subject side and invisible to
the legs, which is the fail-open; at this head it is refused. I am satisfied the two classes are
equivalent over ASCII and that everything outside ASCII lands on `NOT ANCHORED`.

## 2. `R17-P1-01` — the count that was supposed to expose an inert anchor

    _marker_revs = set(_gm.stdout.split()) if _gm.returncode == 0 else set()   # the -G leg: correct
    ...
            _rl = _g('rev-list', 'HEAD', '--', ':(top)%s' % _c)                # the PATH leg
            for _r2 in _rl.stdout.split():
                _marker_revs.add(_r2)                                          # <-- path revisions
                                                                               #     counted as marker
    history = ('checked over all %d revision(s) … — %d of them found by the marker it carries,'
               ' the rest by a path it has held' % (_nrevs, len(_marker_revs & set(_revmap))))

Measured three ways, with the true figure taken from the leg's own command
(`git log --no-renames -G '^# P14-HANDOFF-MANIFEST[.]md[[:space:]]*$' HEAD -- ':(top)'`):

| world | true marker-leg revisions | printed by `b49d612` | printed with the one line deleted |
|---|---|---|---|
| **the real pack**, `/mnt/project-files/phase14` | **1** of 24 | *"**24** of them found by the marker"* | *"**1** of them"* |
| `*.md binary`, forged in place | **0** of 4 | *"**4** of them found by the marker"* | *"**0** of them"* |
| plain, forged in place | **1** of 4 | *"**4** of them found by the marker"* | *"**1** of them"* |

The verdict is rc 1 in both forged worlds and rc 0 on the honest pack with either tool, so this is
**not a fail-open** — it is a false count, and the stopping rule names a false measured count as
blocking. It also defeats its own purpose exactly: the binary world is an anchor that found nothing,
and the output says the marker found all of it. The remedy is one deleted line; the count then equals
`git log -G`'s own answer in all three worlds, and nothing else in the output moves.

## 3. `R16-P1-01` — closed at this head, and the author's reason reproduced

The author says they cannot reproduce rc 0 here. **They are right, and the new assertion is why.**
Same stripped-marker world, measured at both heads:

| tool | result |
|---|---|
| `b49d612`, nothing deleted | 1, `NOT ANCHORED (… carries the manifest marker 0 time(s), not once)` |
| `b49d612`, **subject-marker check deleted** | **1**, `NOT ANCHORED` — now from the HEAD-carrier assertion |
| `7f6f535`, subject-marker check deleted | **0**, *"checked over all 4 revision(s) … found by the marker"* |

So the cell I reported stands for `7f6f535` and is retired at `b49d612`: two independent defences now
cover that world, which is what the amendment claims and what I measure.

## 4. The new `NOT ANCHORED` against HEAD — load-bearing, and a 0 → 1 in my world

The author's own world for this is rc 1 at both heads, and their amendment says so plainly. Mine is
not: subject inside the repository carrying the marker, HEAD's committed copy filed under a
different heading, so **no file in HEAD carries the marker**.

    carriers at HEAD = []
    7f6f535   rc 0   "checked over all 4 revision(s) … found by the marker it carries and by every path it has held"
    b49d612   rc 1   NOT ANCHORED (the file given as the manifest carries the marker, but no file in HEAD does,
                   so the marker found nothing to walk)

A **0 → 1** on the assertion alone, in a world where the marker spelling is irrelevant. I also probed
whether a *different* file's carriership can satisfy the assertion on the subject's behalf — honest
manifest committed, forged untracked copy handed in as the subject — and it is caught at rc 1 by the
committed lineage's digest, so the assertion is not weaker than it reads.

## 5. The parents `NOT CHECKED` change — still unwitnessed, by me and by the author

By reading, the fix is right and is the species this pack has closed repeatedly: `_paths_at` and
`_carriers` both return `None` for *unreadable* and `[]` for *absent*, the old
`_paths_at(_p) or (_carriers(_p) or [])` collapsed both to falsy, and unknown resolved to the
permissive value. The new `elif … is None` branch sends unknown to `NOT CHECKED` with a message that
names the parent.

**I still cannot reach the state.** A fifth construction this round — a root commit that does not
contain the manifest, so it is the parent of the oldest discovered revision, with **only that
commit's tree object deleted** — refuses identically at both heads, upstream of the branch:

    7f6f535   rc 1   NOT CHECKED (this is a git repository, but it could not list the revisions of this
                     manifest: fatal: unable to read tree 330316db28a2…)
    b49d612   rc 1   the same, byte for byte

`rev-list` reads that tree before the parents test is ever reached. With the four constructions of
round 16, that is five. **The branch is reasoned, not witnessed, and I am not signing it as
reproduced** — by me or by the author, who records the same gap. It is fail-closed in direction, so
it is a named residual and not a blocker.

## 6. Pack gates at this head

| gate | result |
|---|---|
| `manifest-digests.py --check`, pack lane | rc **0** — 54 artifact rows + the manifest, 54 files, history over **24** revisions |
| `manifest-digests.py --check`, shared-folder lane | rc **0**, identical figures |
| `gate-sweep.sh`, 4 working directories | rc **0** — **65 ok / 0 FAIL** (61 at the parent; four new red proofs) |

The sweep's four new proofs are `marker-ctrl-world`, `marker-space-world`, `marker-crlf-world` and
`marker-absent-from-head`, each asserting its premise from git before it runs — they cover both halves
of `R16-P0-01`, and they match my §1 and §4 row for row. **No proof covers the count of §2**, which is
why it survived into the head. My round-16 residual on the sweep's header is **closed**: it now reads
*"it is fetch-depth: 0 AND that fetch, not one or the other. A depth-1 checkout cannot pass even with
the anchor AND …"*, which is the measurement the author and I reached separately.

## 7. Repository gates

`npm ci` first, then the readings in the order printed, in one clone that had never been built.
Node **v24.21.0 / npm 11.19.0**.

| reading | `/tmp/g32` `b49d612` | `7f6f535` (round 16) | `6fc505d` merge-base (round 16) |
|---|---|---|---|
| `npm ci` | 0 | 0 | 0 |
| `npm run format` | **0** | 0 | 0 |
| `npm run lint` — cold | 1 (`4220 problems`) | 1 (`4220 problems`) | 1 |
| `npm run typecheck` — cold | 2 | 2 | 2 |
| `npm run build` — first | 1 | 1 | 1 |
| `npm run build` — second | **0** | 0 | 0 |
| `npm run lint` — after build | **0** | 0 | 0 |
| `npm run typecheck` — after build | **0** | 0 | 0 |
| `npm run format` — after build | **0** | 0 | — |

The format gate stays green, so this commit adds no repository red; `lint` and `typecheck` behave
exactly as at the parent and at the merge-base, which is `G6` and not this branch.

## 8. Signature, withheld

**I do not sign `b49d612da3164e746c26ef10ce612f648bc3933b`.** One false measured count
(`R17-P1-01`), in the sentence this commit added to stop a false sentence, with the real pack as the
witness and a one-line remedy; plus `R17-P3-01`, the same count quoted as 23 of 23 for a head where
it reads 24 of 24.

What I will stand behind at a head that closes it: §1's seven spellings at both heads, §3's closure of
my own `R16-P1-01`, §4's 0 → 1 on the HEAD assertion, §6's pack figures and §7's gate readings. The
parents branch of §5 I will not sign either way until something witnesses it.

**Restated, unchanged since round 4:** nothing in this lane has landed on Phase 14's
**architecture**, which is unexecuted — no API, no DDL, no route, no CI job. Seventeen rounds have
measured the pack's own tooling and prose. None of it is credit against the first review of an
executed Phase 14.

**What I did not do.** No file of the author's was edited, in the pack or in the shared folder;
nothing was pushed; no migration was numbered; no history was rewritten and nothing was force-pushed.
The patched tool and the guard-deletion copy are copies under `/tmp/w21` and were never written into
the pack. No `--write` was run against the pack or the shared folder this round. The cluster was the
scratch cluster on `/tmp/p14pg`, restarted by the sweep's own `db-precondition` arm and reverted by
it. This report has no manifest row yet, so the shared-folder lane will read `ARTIFACT WITH NO ROW`
until the author writes one.
