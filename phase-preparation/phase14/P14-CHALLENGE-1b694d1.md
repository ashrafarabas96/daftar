# Phase 14 — independent challenge, round 26 (narrow, `25d945d..1b694d1`, two commits)

**Subject:** `1b694d1f4a1b948698bc4e4a2b4b3e2e8b61a048`, tree
`d1d0d0b9e7bfa114fb18bd698bbf85a023ebf6e9`; parent
`dac688dc5b3f2355c711f61ceaa91bd5b6840add` (tree `21f6f300c3e935ee380115ad1b3899731e638a14`),
grandparent `25d945d6b1eb1c1c7253b043295c33a465fed291`. All resolved in a clone made for this
round.
**Verdict: PASS-WITH-SCOPE** on this range. **One P1 against the instrument** — the
coordinator's question, answered **yes** — and one P3, neither introduced by these two commits.

**What this verdict is not.** Not a promotion, not completeness, not a statement about CI. It
covers these two commits and the five files pinned in §5, and it **expressly does not cover any
statement that this manifest pins this pack**: §6 measures why.

## 1. The coordinator's question: is the `.md`/`.yaml` enumeration a fail-open?

**Yes.** `manifest-digests.py:800` builds the set of files that must have rows as

    on_disk = sorted(f for f in os.listdir(a.dir)
                     if f.endswith(('.md','.yaml')) and f != 'P14-HANDOFF-MANIFEST.md')

so the `ARTIFACT WITH NO ROW` refusal is blind outside that set. Measured on a copy of this head's
pack, one plant at a time, `--check` re-run after each and the plant removed before the next:

| what I dropped into the pack | `--check` | `ARTIFACT WITH NO ROW` |
|---|---|---|
| `zz-planted.txt`, top level | **rc 0** | none |
| `tools/zz-planted.md`, one directory down | **rc 0** | none |
| `proofs/zz-planted.md`, one directory down | **rc 0** | none |
| `P14-CHALLENGE-ZZZZZZZ.MD` — a reviewer-named report, uppercase extension | **rc 0** | none |
| `P14-CHALLENGE-ZZZZZZZ.md` — the same bytes, lowercase (control) | **rc 1** | `zz…: ARTIFACT WITH NO ROW` |

So the hole is **wider than the author named**: it is not only *another extension*, it is also
**any extension one directory down**, because the enumeration is `os.listdir`, not a walk — and it
is **case-sensitive**, so a reviewer-named report with `.MD` sits in the pinned folder unseen while
the identical bytes under `.md` are caught.

**In the author's favour, and measured too:** the manifest declares its own domain at line 47 —
*"Every row below lives at `/mnt/project-files/phase14/`"* — and no row names a subdirectory, so
the top-level-only reach is the declared domain rather than a silent narrowing. What is **not**
consistent with it is §2.

## 2. The reach, measured in both directions

A fail-open is worth what it reaches, so I built the attack rather than rating it.

* **No code-execution path, and I checked instead of assuming one.** Every tool is invoked
  `python3 -I`, and on this container's Python **3.13.16** that reports `isolated: 1`,
  `safe_path: True`, with `sys.path[0]` the stdlib zip and **not** the script's directory. So a
  planted sibling module — the obvious escalation from "I can add an unseen `.py` next to the
  instruments" — is not importable by them. The hole does not reach execution.
* **It does reach a published figure.** With `proofs/zz-planted.md` planted and `--check` still
  rc 0, `retracted-claims.py --check` moved from `41 pack document(s)` to **`42`**. That tool walks
  the pack recursively; the pin stops at the top level. So a file this manifest cannot see can
  enter the evidence base of a number this pack publishes for a SHA — which is the asymmetry
  nothing in the pack names.
* The shared folder's top level today holds 77 files and the lane reports 76 rows + the manifest:
  I checked, and every one of those 77 is `.md` or `.yaml`, so that difference is the manifest
  itself and **not** an instance of this hole. Stating it because the two numbers sit one line
  apart in the sweep output and invite the wrong inference.

**Rating.** A named refusal that does not fire for shapes inside the directory it reads is a
fail-open, so this is a **P1 against `manifest-digests.py`** — not against these two commits,
which neither introduced it nor claim it closed. The author names it in amendment 31 §7 and
publishes the failed first attempt that exposed it, which is the right way to carry it. The fix is
small: walk with `os.walk`, drop the extension filter, keep an explicit **rowed** exclusion list,
and let the refusal name the domain it enforces.

## 3. The off-repository separation, re-proved on my own construction

The author proved the separation with a copy of the pack holding one extra document. I built a
harsher subject — a directory holding **one** file — and ran the pair myself, `--no-db` both times,
differing in nothing but `P14_SHARED`:

| run | off-repository subject | `ok` | gate figure | off-repository figure | rc |
|---|---|---|---|---|---|
| baseline | the mirrored shared folder (matching) | **70** | `0 … not as required` | `0 … differ` | **0** |
| mine | a directory holding one unrelated file | **70** | `0 … not as required` | **`1 … differ`** | **1** |

The `ok` count and the gate figure are identical; the exit code is not. So the lane is out of the
arithmetic a reader may quote for a SHA **and** still fails closed, which is exactly what the
`offrepo` design claims. In the full run at this head the lane printed
`read manifest-shared /mnt/project-files/phase14 — 77 file(s), newest 2026-10-19T09:56:25Z, read at
2026-10-19T10:00:53Z` and then `obs … rc=0`, so the directory, its size, its newest mtime and the
instant of the reading are all on the page: an observation with its time, which is what I asked
for and more than I asked for.

## 4. Figures at this head, re-measured by me

* **`tools/gate-sweep.sh` — rc 0, `78 ok`, `0 gate(s)/proof(s) not as required`**, four working
  directories, cluster up, off-repository lane `0 … differ`. The author's figure reproduces
  exactly, and it is now reproducible *from the commit alone*, which is the point of the round.
* **`--check --dir <my clone>` — rc 0, byte-identical from the pack directory and the repository
  root**: `76 artifact row(s) + the manifest itself; 76 file(s)`, `…all 34 revision(s)… 1 of them
  found by the marker`.
* **All 76 rows verified against disk by my own script** — digest *and* byte size — **0
  mismatches**.
* **History in the fresh clone:** 34 revisions, marker leg 1 and it is
  `08d23da4e850b7498d03eefd893283d39309c712`; not shallow; 0 replace refs.
* `citation-provenance.py` rc 0 and `--check P14-MIGRATION-PATCH-REQUEST.md` rc 0;
  `retracted-claims.py` rc 0 with `28 retracted claim(s) enforced across 41 pack document(s); 37
  challenge report(s) exempt`.
* **The three reports are committed unedited**, `cmp`-clean against the frozen copies, at the
  announced digests: `P14-CHALLENGE-25d945d.md` 10,856 B `cbaba779…`;
  `P14-COORD-DIFF-REVIEW-25d945d.md` 5,353 B `68fd206f…`;
  `P14-COORD-DIFF-REVIEW-32017cf.md` 17,335 B `876afe4a…`. So this head finally carries, in the
  tree, the words behind every signature of its two parents.
* **Amendment 30 §5 is struck in place and enforced as retracted claim 28.** I read both: the
  strike says the figure was true when taken and is not reproducible at that head, names the cause,
  the file and the 09:08:24 UTC instant, and points the reader at the clone-pinned lane. The
  retraction row says the same. The author kept the stricter rating for their own figure after the
  coordinator offered a lighter one; that is theirs to decide and it is the right direction to err
  in.
* `git diff --stat 25d945d..HEAD -- . ':!phase-preparation'` is **empty**, so by `R24-P3-03` this
  range's repository-gate set is empty; no repository gate reads any file it changes.

## 5. The five files this verdict pins

Hashed from the files on disk in my clone.

| file | sha256 | bytes |
|---|---|---|
| `P14-HANDOFF-MANIFEST.md` | `1222c39551bc1bf9e56cce528bb7436f92a2f062dca3ed09c59a0598ab04641d` | 99,397 |
| `tools/manifest-digests.py` | `53ed45590a2147a5adc783c61ee2b16fbfe2775a2b982b9459de3113ba19c550` | 67,511 |
| `tools/citation-provenance.py` | `b09d43d988ebd5ce8c6364aa35138408df8aee22a5d2e1fab5c67341b2804a72` | 32,228 |
| `tools/gate-sweep.sh` | `e82fa30ba02e6e45c19031bb3dee999851ff5e0a22603ac5ea42da2452e81110` | 102,160 |
| `tools/RETRACTED-CLAIMS.tsv` | `e74c6804cbac16a881768ecd3dba1ce6ebbf64426a68f0d9dcf60c8d0f652ac9` | 12,710 |

`manifest-digests.py` and `citation-provenance.py` are byte-identical to the files I signed at
`32017cf` and `25d945d`; the manifest, the sweep and the retraction table moved this round.

## 6. Findings

### `R26-P1-01` — the unlisted-artifact refusal is a fail-open, wider than named

§1 and §2 are the finding: five plants, four of them invisible, one control caught; no execution
reach, measured; one published figure moved by an invisible file, measured. Pre-existing, named by
the author, not introduced here, and **my signature does not cover any claim that this manifest
pins this pack** — it covers the rows that exist, which I verified, and the five files above.

### `R26-P3-02` — the gap that produced the same omission twice is still unarmed

Nothing in this pack reads, at commit time, whether a reviewer's report sitting in the shared
folder is in the tree. The author names this, and `1b694d1` exists because it happened again: the
coordinator's review of `25d945d` had been in the folder since **09:30:26 UTC**, nineteen minutes
before `dac688d` was pushed without it. Two occurrences in two consecutive rounds is a pattern,
not an accident, and the thing that caught it the second time was the newly separated lane — after
the commit, not before it. The instrument that would catch it before is the same comparison the
lane makes, run in the build step: the reviewer-prefixed files in the shared folder against the
manifest's rows. Also unarmed, by the author's own statement: **no permanent arm asserts §3's
separation**; it rests on two published runs, now four counting mine.

## 7. What stays open, signed by no one

* The in-pinned-set `git` arm, absent and named; `parents-unknown` unwitnessed; `GIT_EXEC_PATH`
  and the translated-git leg UNMEASURED here.
* **CI has never run a Phase 14 SHA, and no workflow in this tree runs this pack's gates.**
* `OD-P14-09`, `-10`, `-11` open with Ashraf.
* Phase 14 remains **PREPARED / NOT PROMOTED**.
