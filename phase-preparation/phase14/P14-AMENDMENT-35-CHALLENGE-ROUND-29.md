# Phase 14 — amendment 35: challenge round 29 answered

**Subject reviewed:** `4fb37bf` (the head that closed `R28-P1-01`).
**Verdict received:** challenger **PASS-WITH-SCOPE** — `R28-P1-01` closed and armed from both
branches, every object-kind shape they could build handled, **no P1 and no false measured claim
about a static tree**; **two P2s and one P3**. Their signature expressly does **not** cover (a) any
statement that an excluded directory is a real repository with history of its own, or (b) any run
made while another process writes the directory under `--dir`. The coordinator's actual-diff review
of `4fb37bf` is running, so this head is **committed and not pushed** until it returns.
**Reviewer's words, committed unedited in this same commit and hashed from disk:**
`P14-CHALLENGE-4fb37bf.md` (10,655 B,
`182948f0391ee65f0789f915c3b8499efb9568ba32720b9c913121dabe0a200b`).

**The coordinator SIGNED `4fb37bf`** while this amendment was being written —
`P14-COORD-DIFF-REVIEW-4fb37bf.md` (5,835 B,
`b888a3e9b85b072f15d1e1f470745cd1fc5eafba41b2122172709e1075f69c32`), committed unedited here with
its row. With the challenger's PASS-WITH-SCOPE, **`4fb37bf` carries all three links, none
self-signed**, and the hold on this commit is lifted by that review.

**The coordinator's measured ratings are the ones recorded**, and they are lower than the
challenger's: `R29-P2-01` is **P2** — it reaches the clone lane, but it is **named rather than
silent**; `R29-P2-02` is **P3**, limited to the off-repository lane, and they reproduced the
traceback but **not** the silent skip, independently of this thread's own failure to reproduce it;
`R29-P3-01` is **P3**. They confirm the third leg is the right discriminator and add the
measurement that makes the shape of it necessary: **`count` alone does not discriminate, because a
fresh bare clone has `count: 0`** — it must be **loose + packed**, which is what §1's leg reads.
They also rate the `HOLDING AT LEAST ONE COMMIT` sentence at `pack-domain.py:55` as **P3 wording,
not measured-false**, to be reworded to match the new leg; **that is already done at this head**
(`THAT OWNS AT LEAST ONE GIT OBJECT OF ITS OWN`, with all three legs named in the sentence), and
the stale phrasing survives only inside the challenger's own report, which is committed unedited
because a reviewer's words are the record of what was claimed.

Phase 14 remains **PREPARED / NOT PROMOTED**, and the sentence "this manifest pins this pack" is
**still not made anywhere in this pack**.

## 1. `R29-P2-01` (P2) — the commit bar was satisfied by BORROWED objects

Round 28 made a repository prove itself by resolving a commit. `objects/info/alternates` is a file
**inside the candidate**, and neither `GIT_NO_REPLACE_OBJECTS` nor `GIT_GRAFT_FILE` reaches it — so
a directory owning **no git object at all** answers both legs rc 0. **Reproduced before anything
was changed**, with `HEAD` holding one sha, an empty `refs/`, and `alternates` naming this
repository's own object store:

```
rev-parse --git-dir                rc 0
rev-parse --verify HEAD^{commit}   rc 0
count-objects -v                   count: 0  in-pack: 0  packs: 0
                                   alternate: <the borrowed object store>
```

Through the instruments, with a document inside carrying a claim from `tools/RETRACTED-CLAIMS.tsv`:
**manifest rc 0** printing `1 directory(ies) were excluded as repositories: zz-hide` and *"every
file has a row"*, **retracted-claims rc 0**, **citation-provenance rc 0**. "A repository holding at
least one commit" was satisfied by a commit the directory does not hold, and the price of the
hiding place went from 20 bytes to a few dozen.

**The challenger measured a discriminator rather than proposing one**, and also named the
instrument to avoid: `cat-file --batch-all-objects` reads **through** alternates and does not
discriminate at all. So the third leg is `count-objects -v`, and a directory is outside this pack's
domain only if it **owns at least one object itself** (loose + packed > 0). Measured here:

| candidate | `count` | `in-pack` | verdict |
|---|---|---|---|
| the alternates world | 0 | 0 | **in the domain** |
| a bare repository built by plumbing | 3 | 0 | excluded |
| this repository's real `.git` | 0 | 7155 | excluded |

A `--shared` clone fails this leg and therefore **stays in the domain**, which is fail-closed and
is the direction this pack refuses in. Output this leg cannot parse is also refused.

**Measured after the fix:** the alternates world gives **manifest rc 1**
(`SUBTREE WITH NO ROW: zz-hide/ holds 3 file(s)`), **retracted-claims rc 1**
(`RETRACTED CLAIM PRESENT: zz-hide/zz-doc.md:3` — the enforcement is back), **citation rc 1**; a
real repository that owns its objects is still excluded and still **named** in the summary; and the
run from the repository root, where the real `.git` is a candidate, is still rc 0. Armed as
`plant-repo-with-borrowed-objects`.

## 2. `R29-P2-02` (P2) — a directory swapped for a link mid-walk handed back both closed shapes

`classify_dirs` refuses a link **before** asking git, which is right, but `os.walk` then makes its
**own** descent-time decision, and between the two the answer can change. The challenger's 30 runs
against one concurrent swapper: 16 refused by name, 2 found the moved copy, **4 ended rc 0 saying
nothing about the directory** — `R28-P1-01`'s silent skip — and the rest ended **rc 1 with an
unhandled `FileNotFoundError` at `retracted-claims.py:159`**, which is `R23-P2-01`'s class where
rc 1 means **stale**. It is reachable rather than theoretical: three lanes read
`/mnt/project-files/phase14`, which every session writes, and round 25's finding was exactly a
concurrent write there ninety seconds before a push.

**Reproduced before the fix**, by sweeping the delay of a concurrent remover from 5 ms to 445 ms in
10 ms steps, 45 runs of `retracted-claims.py --check`:

```
rc 0, the directory was already gone before the walk reached it   40
named refusal (the walk's onerror handler, added in round 28)      1
UNHANDLED TRACEBACK at rc 1, FileNotFoundError, line 159           4
```

**Measured after the fix, the same sweep:**

```
rc 0, the directory was already gone before the walk reached it   41
named refusal from the WALK, rc 2                                  1
named refusal from the READ, rc 2                                  3
unhandled tracebacks                                               0
```

**Two changes.** `os.walk(..., followlinks=True)`, with the explicit link refusal **kept** — which
is what makes it safe: the walk no longer makes a second decision about what a path is, so a swap
lands either on the refusal or on real rows that must be pinned, and **never on silence**. It
cannot loop on a cycle inside the pack, because a link is refused and never descended from. And a
**named refusal at every read that can fail under us** — in `subtree_digest`, in the manifest's row
read and its counterpart-copy read, in `retracted-claims.py:159` and in the provenance document
scan. A file enumerated and then unreadable is not a digest and not a document that was checked, so
the run says so **by name** at the code that means *cannot measure*, never at the code that means
*stale*.

**What this amendment does NOT claim:** the silent-skip half of the race was **not reproduced in
this container** — of 75 runs across two timing strategies, every swap landed on the refusal, on
the moved copy, or on the traceback. The fix is applied on the challenger's measurement, and the
measurement that stands here is the traceback half: **4 of 45 before, 0 of 45 after**. These
refusals are reached by a concurrent writer, so they are armed by that sweep and **not** by a
deterministic plant, which is said in `gate-sweep.sh` beside the arms rather than implied.

## 3. `R29-P3-01` (P3) — a sentence naming four shapes, with one arm

The refusal names a FIFO, a socket and a device; only the FIFO had a plant. The challenger built
all four and each was refused correctly — which is the finding, not a reprieve: by the lesson that
cost round 28, a shape that is **named and unarmed** is covered by nothing but luck. Each now has
its own arm: `plant-socket-in-the-pack` (AF_UNIX), `plant-zz-chardev` (`mknod c 1 3`),
`plant-zz-blockdev` (`mknod b 7 0`), beside `plant-fifo-in-the-pack`.

A **hard link** has an arm too, and it is the opposite kind: a hard link is an ordinary directory
entry for an ordinary file, indistinguishable from any other name for the same inode, so it must be
**pinned and not refused**. `plant-hard-link-is-pinned` holds that distinction, because a later
widening of the link refusal would otherwise swallow it in silence.

## 4. What the challenger measured and could not break, recorded because it bounds the claim

Hard links are pinned, not refused, in both directions they tried. A `mount --bind` into the pack
is fail-closed (`SUBTREE WITH NO ROW` and the retracted claim caught). **Replace refs would be a
bypass** — a candidate whose `HEAD` names a nonexistent sha with `refs/replace/<sha>` at a real
commit resolves rc 0 with replace enabled — and this pack's env hardening closes it (rc 128 as the
tools run it), so that hardening is **load-bearing and now has a measurement on the record**.
Grafts are rc 128 under `GIT_GRAFT_FILE=/dev/null`, and a graft cannot bring a missing object into
existence. Case-colliding names both demand rows on this case-sensitive container, and the
case-insensitive filesystem is recorded as **unmeasured**. They also reproduced independently the
reason the unreadable-directory refusal is unmeasured here, and wrote that declaring it beats
shipping a plant that passes for the wrong reason.

They disclose that §2 of their report deliberately mutated their own clone's pack while a gate was
running — that is what the finding is about — that the clone is back at `4fb37bf` clean, that they
hold no commit at this head, and that they wrote nothing into the shared folder but their report.

## 5. Exit codes at this head

Taken after the last write to any document of this round, which is the manifest itself. Per round
18's rule, **no count of the manifest's own revisions is quoted here**; that figure is re-measured
in a fresh clone **of the pushed head**, and this head is **held, not pushed**, so no pushed-head
figure exists yet. Per `R25-P3-02` the sweep figure is the one reproducible from this commit alone
and the off-repository lanes are reported apart from it.

* `tools/gate-sweep.sh --no-db` — **101 ok, `0 gate(s)/proof(s) not as required`**, from four
  working directories, re-run after the coordinator's review and its row were added so the figure
  is the finished tree's. 96 at `4fb37bf`; the five added are the shapes `R29-P3-01` named and the
  world `R29-P2-01` is about, as they printed:

```
ok  plant-socket-in-the-pack          rc=1  NOT A REGULAR FILE IN THE PACK: zz-sock
ok  plant-zz-chardev                  rc=1  NOT A REGULAR FILE IN THE PACK: zz-chardev
ok  plant-zz-blockdev                 rc=1  NOT A REGULAR FILE IN THE PACK: zz-blockdev
ok  plant-hard-link-is-pinned         rc=1  zz-hard: ARTIFACT WITH NO ROW
ok  plant-repo-with-borrowed-objects  rc=1  SUBTREE WITH NO ROW: zz-hide/
```

* `tools/gate-sweep.sh`, the off-repository lanes — **3 differ**, so the script exits **1**,
  fail-closed, and none is in the figure above. Read line as printed:
  `/mnt/project-files/phase14 — 85 file(s), newest 2026-10-19T12:42:43Z, read at
  2026-10-19T12:51:56Z`. `manifest-shared` differs because that folder is the pre-push mirror of
  `4fb37bf` and by amendment 31 §1 it is written only after a push — and this head is **not
  pushed**, so it stays the mirror of `4fb37bf` until the coordinator's review returns.
  `reports-in-tree` and `reports-at-head` both name `P14-CHALLENGE-4fb37bf.md`, the report this
  commit adds, **the lane working**.
* `tools/manifest-digests.py --check` — **rc 0**, identical from the pack directory and the
  repository root: **88 rows + the manifest itself** (86 artifacts and 2 declared subtrees), **86
  files at the top level and 55 under the two subtrees**, `0 directory(ies) were excluded as
  repositories: none`, and the domain sentence printed with its third leg. The two figures above
  `4fb37bf`'s are this round's amendment and the two reviewer reports committed with it.
* `tools/retracted-claims.py --check` — rc 0: **28 retracted claims enforced across 45 pack
  documents; 43 challenge reports exempt in code.** No claim was added this round; the exempt
  count moves by the coordinator's review committed here.
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
| c1 | the `count-objects` third leg (manifest) | 100 ok, **1 not as required** | `plant-repo-with-borrowed-objects` (back to **rc 0**: the hiding place restored) |
| c2 | the not-a-regular-file refusal -> `if False` | 97 ok, **4 not as required** | `plant-fifo-in-the-pack`, `plant-socket-in-the-pack`, `plant-zz-chardev`, `plant-zz-blockdev` |
| c3 | `followlinks=True` reverted | **101 ok, 0 not as required** | **none** |

  c2 is `R29-P3-01` answered and then **proved**: before this head one deletion would have moved
  one arm, and now it moves all four — which is the whole of that finding.

  **c3 is a measurement, not a pass**, and it is the same shape as amendment 33's `c4`: the change
  `R29-P2-02` asks for cannot be armed by a deterministic plant, because the window it closes is
  reached only by a concurrent writer. Reverting it moves nothing in a static sweep. What stands in
  its place is the delay sweep of §2 — **4 unhandled tracebacks of 45 before, 0 of 45 after** — and
  §6 records that the change is otherwise unarmed. The arms beside it in `gate-sweep.sh` say the
  same thing where a reader of the suite will see it.

## 6. Residuals, named and not claimed as closed

* **An excluded directory may hold any history at all, and this pack asserts nothing about it.**
  The three legs establish that git accepts it, that it resolves a commit and that it owns at least
  one object of its own — **not** that its history is genuine, related to this repository, or
  anything else. The challenger scoped their signature the same way. Inside such a directory
  nothing is pinned **and** no retraction this pack enforces is enforced; all three instruments
  skip it identically, so no published figure moves and no two figures disagree, and that is why
  the sentence "this manifest pins this pack" is still not made.
* **No figure from a run made while another process writes the directory under `--dir` is sound**,
  and the challenger's signature excludes that case as well. What this head changes is the FAILURE
  MODE: a concurrent change now lands on a named refusal at the cannot-measure code instead of on
  silence or on a traceback at the stale code. It does not make such a run's figure quotable. The
  three off-repository lanes read a folder every session writes, which is exactly why they are
  reported apart from the figure quoted for a SHA.
* **The silent-skip half of `R29-P2-02` is not reproduced in this container** (§2). It is fixed on
  the challenger's measurement, and this pack's own measurement covers the traceback half only.
* **`followlinks=True` is unarmed by any deterministic plant** — reverting it moves nothing in a
  static sweep (§5, c3). It is kept on the challenger's measurement and on the failure-mode
  argument, not on a green suite.
* **The VANISHED-FILE and UNREADABLE-DIRECTORY refusals are not armed by a plant** — the first
  needs a concurrent writer, the second needs a uid that is not 0. Both are measured or declared,
  neither is counted as covered.
* **The count prefix inside the subtree digest is still unarmed**, confirmed again this round:
  with newline, CR and NUL refused before the digest, no admitted world distinguishes it.
* **A reviewer report nested in a subdirectory of the counterpart folder reds rather than being
  located.** Fail-closed, and the refusal says what it looked for.
* **The `tools/` row's digest covers the file that defines the domain**, so the sibling pin lives
  in each instrument and is armed separately. The weakest link remains a `--write` by whoever
  already controls the tools.
* **A case-insensitive filesystem is UNMEASURED.** This container is case-sensitive; two names
  differing only in case both demanded rows here, which says nothing about a filesystem that would
  collapse them.
