# Phase 14 — independent challenge, round 25 (narrow, `32017cf..25d945d`)

**Subject:** `25d945d6b1eb1c1c7253b043295c33a465fed291`, parent
`32017cf576a9784d67b9d26d2437533d1300dd3e`, tree `9b69bb04939c85d207690ff86ea10ab2513159b0`,
author `Claude <noreply@anthropic.com>` — all four resolved in a clone made for this round.
**Verdict: PASS-WITH-SCOPE**, with one **P2** and one **P3**, neither a fail-open.

**What this verdict is not.** Not a promotion, not completeness, not a statement about CI. It
covers this SHA and the five files pinned in §8. My round-24 PASS-WITH-SCOPE covered `32017cf`
and does not reach here.

**The one figure I could not reproduce.** Amendment 30 §5 publishes, under *"Exit codes at this
head"*, `gate-sweep.sh` rc 0, **79 ok**, `0 gate(s)/proof(s) not as required`. I measure, at this
same head: **rc 1, 78 ok, `1 gate(s)/proof(s) not as required`** — `manifest-shared` FAILs. The
cause is §6's `R25-P2-01`, it fails closed, and it is not in the commit's content; but a
published figure a reviewer cannot reproduce is the thing this lane exists to prevent, so it
leads this report.

## 1. The three items of round 24, all closed

* **`R24-P3-01`** — `sibling-unrunnable-refused` is shipped, built like
  `git-binary-unrunnable-refused` (a `git` on the pinned path whose shebang names a missing
  interpreter), pointed at `citation-provenance.py` and keyed on **that tool's own sentence**,
  `could not be run (.*), so no provenance could be read`. I checked the keying rather than
  assuming it: the sibling's *absent*-git refusal does not contain "could not be run", and the
  digest tool's says "no **history** could be read", so neither arm can pass on the other
  refusal, and the two sibling arms cannot pass on each other. `named()` matches with `grep`
  (BRE), where `(` and `)` are literal and `.*` is any run of characters, so the pattern matches
  the real sentence; this is the first arm in the sweep that relies on that, and it relies on it
  correctly.
* **`R24-P3-02`** — struck and corrected in place in amendment 29 §2: *four* → **three**, with
  the reason and with the fourth copy taken in amendment 30 §1.
* **`R24-P3-03`** — struck and corrected in place in amendment 29 §6, and restated in amendment
  30 §3 with prettier's own output. I re-ran that measurement, including the fourth line the
  amendment added and which I had not supplied, plus amendment 30 itself:

      P14-AMENDMENT-29-CHALLENGE-ROUND-23.md   {"ignored":true,"inferredParser":null}
      P14-AMENDMENT-30-CHALLENGE-ROUND-24.md   {"ignored":true,"inferredParser":null}
      tools/manifest-digests.py                {"ignored":false,"inferredParser":null}
      tools/gate-sweep.sh                      {"ignored":false,"inferredParser":null}
      tools/citation-provenance.py             {"ignored":false,"inferredParser":null}

  All four published lines are correct.

## 2. Guard deletion — four copies, one deletion each, read by NAME

| the one thing deleted | arms that go FAIL beyond the baseline |
|---|---|
| nothing (baseline) | — (`manifest-shared` only, which is `R25-P2-01` and is in every copy) |
| the `try/except` around the **digest tool's** git call | `git-binary-unrunnable-refused` only |
| the **sibling's `CONFIGURATION ERROR`** block | `sibling-no-git-refused` only |
| the `try/except` around the **sibling's** git calls, both sites | **`sibling-unrunnable-refused` only** |

The fourth row red **nothing** at `32017cf` and reds its own arm here, which is `R24-P3-01`
closed by measurement rather than by assertion. No deletion reds a second arm, so the three arms
are keyed on three different refusals and none of them is a tautology.

## 3. What the diff is, and what it is not

`git diff --numstat 32017cf..25d945d` is six files: amendment 29 (+18/−4, the two in-place
corrections), amendment 30 (new), my round-24 report, the manifest, the patch request's generated
block, and `gate-sweep.sh` **+19/−0**. `git diff --stat 32017cf..25d945d -- . ':!phase-preparation'`
is **empty**. Both tool files I signed at `32017cf` are byte-identical here — `53ed4559…` and
`b09d43d9…` — so nothing in the code I signed last round moved, and nothing in this diff deletes
or weakens an existing arm.

**My round-24 report is committed unedited**: `cmp` against my frozen copy is clean and the file
is 14,175 B `16776f02fc58641197f0c0ce41bc00be86133c9a6706da30134efa2560c28edc`, the digest I
announced.

## 4. Figures re-measured by me

* **`tools/gate-sweep.sh` — rc 1, 78 ok, `1 gate(s)/proof(s) not as required`.** See §6.
* **`tools/manifest-digests.py --check --dir <my clone>` — rc 0, byte-identical from the pack
  directory and the repository root**: `72 artifact row(s) + the manifest itself; 72 file(s)`,
  `reviewer-row history checked over all 32 revision(s) … 1 of them found by the marker`.
* **All 72 rows verified against disk by my own script** — digest *and* byte size — **0
  mismatches**.
* **History, my own git commands in the fresh clone:** 32 revisions of the manifest path, 1 found
  by the marker ERE and it is `08d23da4e850b7498d03eefd893283d39309c712`; not shallow; 0 replace
  refs; no graft file.
* `tools/citation-provenance.py` rc 0, and `--check P14-MIGRATION-PATCH-REQUEST.md` rc 0.
* `tools/retracted-claims.py` rc 0: `27 retracted claim(s) enforced across 40 pack document(s);
  34 challenge report(s) exempt in code`.
* **Repository gates.** The diff touches nothing outside `phase-preparation` (measured above), so
  by `R24-P3-03` its repository-gate set is empty. Warm, in a tree built at the parent, run in the
  order format → lint → typecheck → build: all four rc 0. The cold column I measured this morning
  at `32017cf` in a clone made fresh from GitHub — format 0, lint 1 / 4,220 problems, typecheck
  2 / 286 errors, build 1 then 0 — is the `G6` ordering artefact present on `main`; I did **not**
  re-take a cold column at this head, and I say so rather than implying one.

## 5. The five files this verdict pins

| file | sha256 | bytes |
|---|---|---|
| `P14-HANDOFF-MANIFEST.md` | `757a4162b0c7fea635d3eacb675e906e97be60ba0007b9199b36b888e5f16d42` | 93,890 |
| `tools/manifest-digests.py` | `53ed45590a2147a5adc783c61ee2b16fbfe2775a2b982b9459de3113ba19c550` | 67,511 |
| `tools/citation-provenance.py` | `b09d43d988ebd5ce8c6364aa35138408df8aee22a5d2e1fab5c67341b2804a72` | 32,228 |
| `tools/gate-sweep.sh` | `efc92780b0c68d6e360cdb48e5c0ad576199daa4c0740147ebf05def2b273d87` | 97,854 |
| `tools/RETRACTED-CLAIMS.tsv` | `9fd1d35bec9cc55db923c9d82a7c896f13c530ae3122b3bafe2bf7bb9c7ce866` | 11,423 |

All five match the digests the author announced, taken here from my own clone.

## 6. Findings

### `R25-P2-01` — the head does not carry the coordinator's review of `32017cf`, and the pack's own gate is red because of it

`P14-COORD-DIFF-REVIEW-32017cf.md` exists in the shared pack — 17,335 B, written at
**09:08:24 UTC**, which is **before** the push — and `git cat-file -e
25d945d:phase-preparation/phase14/P14-COORD-DIFF-REVIEW-32017cf.md` answers *does not exist*. The
manifest gained exactly two rows this round, my report and amendment 30, where every earlier round
committed **both** reviewer reports with their rows.

Measured consequences, not inferred:

* `manifest-shared` FAILs identically from all four working directories, first line
  `STALE: P14-COORD-DIFF-REVIEW-32017cf.md: ARTIFACT WITH NO ROW`, and the lane reports
  `72 artifact row(s) + the manifest itself; 73 file(s) in /mnt/project-files/phase14`. So the
  sweep at this head is rc 1 / 78 ok / 1 not as required.
* **The cause is exactly that one file.** On a copy of the shared folder: as-is, rc 1 with that
  sentence; with that single file removed and nothing else changed, **rc 0, 72 rows, 72 files**.
* The tree at this head therefore carries no record of the third link for `32017cf`. The SIGN is
  asserted to me out of band and I cannot verify it from the pack; a reader of this head cannot
  either.

It fails closed and the commit's own content is sound — the clone lane is rc 0 — so this is a
named residual rather than a blocker. But amendment 30 §5 states its figure as *"at this head"*,
and at this head it is not true: it was true when the author measured it, before 09:08:24. The
remedy is one commit: the coordinator's report committed unedited with its manifest row, which
restores the three-link record and takes the lane to 73 rows / 73 files.

### `R25-P3-02` — a gate whose subject is a directory outside the repository has no verdict about a commit

`gate-sweep.sh` line 163 runs `manifest-digests.py --dir $SHARED --check` with
`SHARED=/mnt/project-files/phase14`. That folder is written by every session in this project. So
`manifest-shared`'s exit code is not a property of any SHA: any session adding, removing or
rewriting a file there flips it, for every head at once, and a figure taken at build time cannot
be reproduced by a reviewer afterwards — which is what happened to amendment 30 §5 within two
minutes of the push. This is the same hazard the author disclosed this morning from the writer's
side (mirroring while a review was running); this is the reader's side of it, and it is not about
mirror timing — moving the mirror after the push does not fix a gate whose subject anyone may
write.

What I would do, and it costs nothing: quote the head's figure from the lane pinned to a clone
(`--dir <clone>`, which is `manifest-digests` and is rc 0 here), and report `manifest-shared`
separately, beside the folder's state and the time it was read. A sweep figure published for a
SHA should be reproducible from that SHA alone.

## 7. Answering the author's question about my round-24 figures

They asked whether any figure of mine came from the shared folder during their mirror window
(08:45:53 and 08:46:21 UTC). **None did.** Every measurement of round 24 finished by **08:36:16
UTC**: the clean sweep's log last wrote at 08:19:28, the `--check` lanes at 08:19:47 and 08:19:53,
citation-provenance at 08:19:52, retracted-claims at 08:19:16, the four deletion sweeps between
08:23:32 and 08:27:08, and the cold gate column at 08:36:16. My `--check` of that round did read
the shared folder through the default `--dir`, and it read it before the window: rc 0, 70 rows,
70 files, consistent with `32017cf`'s pack. My 70-row verification was against my clone, not the
folder. Nothing of round 24 needs striking.

## 8. What stays open, signed by no one

* The in-pinned-set `git` arm, absent and named.
* `parents-unknown` unwitnessed; `GIT_EXEC_PATH` and the translated-git leg UNMEASURED here.
* **CI has never run a Phase 14 SHA, and no workflow in this tree runs this pack's gates.**
* `OD-P14-09`, `-10`, `-11` open with Ashraf.
* Phase 14 remains **PREPARED / NOT PROMOTED**.
