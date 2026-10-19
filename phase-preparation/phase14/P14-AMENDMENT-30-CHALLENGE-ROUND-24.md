# Phase 14 — amendment 30: challenge round 24 answered

**Subject reviewed:** `32017cf576a9784d67b9d26d2437533d1300dd3e`.
**Verdict received:** **PASS-WITH-SCOPE** — three residuals, all P3, none blocking; no false
measured claim and no fail-open at that head.
**Reviewer's words:** `P14-CHALLENGE-32017cf.md` (14,175 bytes,
`16776f02fc58641197f0c0ce41bc00be86133c9a6706da30134efa2560c28edc`), committed unedited and
hashed from the file on disk.

Their scope is `32017cf` and five digests they took themselves from a clone — manifest
`dec42e5a…` 90,997 B; `manifest-digests.py` `53ed4559…` 67,511 B; `citation-provenance.py`
`b09d43d9…` 32,228 B; `gate-sweep.sh` `8a92b1c3…` 96,554 B; `RETRACTED-CLAIMS.tsv` `9fd1d35b…`
11,423 B — and I re-verified all five from my own clone of the pushed head: all five match. It is
**NOT a promotion**, not completeness, not a statement about CI. **This head is not that SHA and
carries no part of it.** Phase 14 is **PREPARED / NOT PROMOTED**.

This amendment is the ONE commit the coordinator authorised after its own diff review returned,
and it closes all three residuals.

## 1. `R24-P3-01` — the guard I added last round had no arm, inside the commit that closed the same defect

`R-COORD-1` was *a correct refusal nothing would notice the removal of*. The commit that closed it
added a `try/except` to the **sibling** and shipped it **with no arm** — the same defect, one file
along, inside its own fix. The reviewer measured it directly rather than inferring it: the sibling
as shipped, against a pinned path holding an unrunnable `git`, answers **rc 2** with its own named
refusal; with the wrap deleted it answers **rc 1 and a traceback**. A real guard, working, and
unmeasured.

`sibling-unrunnable-refused` is the arm, built exactly like `git-binary-unrunnable-refused` — a
`git` on the pinned path whose shebang names a missing interpreter, so `shutil.which` selects it
and `exec` fails — pointed at `tools/citation-provenance.py` and keyed on **that tool's own
sentence**, `could not be run (…), so no provenance could be read`, so neither arm can pass on the
other tool's refusal. Premise asserted first: `which` selected that exact file, running it directly
exits non-zero, and the shipped pin appears verbatim once in the sibling.

**Guard-deletion, read by NAME, one deletion per copy — FOUR copies this time, and the fourth is
the row round 23 did not take:**

| the one thing deleted | arms that go FAIL beyond the baseline |
|---|---|
| nothing (baseline) | — |
| the `try/except` around the DIGEST tool's git call | `git-binary-unrunnable-refused` only |
| the SIBLING's `CONFIGURATION ERROR` block | `sibling-no-git-refused` only |
| the `try/except` around the SIBLING's git calls (both sites) | **`sibling-unrunnable-refused` only** — it red **nothing** at `32017cf` |

The reviewer's own run of my round-23 table reproduced row for row, and their fourth row is the
finding above.

## 2. `R24-P3-02` — a stale count, corrected in place

Amendment 29 §2 said "four copies … baseline included" over a table holding a baseline and two
deletions. Three. The word was carried verbatim from amendment 28 §4, where a baseline and three
deletions made four right. The reviewer's reading of why it matters is the part worth keeping: a
reader counting coverage concludes a third deletion was taken and red nothing, **and the third
deletion a reader reaches for is exactly `R24-P3-01`**. Corrected in place in amendment 29, and
the missing copy is taken in §1 above.

## 3. `R24-P3-03` — `npm run format` reads no file in this diff

Also corrected in place in amendment 29 §6. Measured with prettier's own answer rather than read
off `.prettierignore`:

    P14-AMENDMENT-29-CHALLENGE-ROUND-23.md   {"ignored":true,"inferredParser":null}
    tools/manifest-digests.py                {"ignored":false,"inferredParser":null}
    tools/gate-sweep.sh                      {"ignored":false,"inferredParser":null}
    tools/citation-provenance.py             {"ignored":false,"inferredParser":null}

`*.md` is ignored repository-wide and `.py`/`.sh` have no parser, so `prettier --check .` reads
**nothing** here. The old sentence was true and the rc 0 honest; what it left a reader to assume is
that the markdown was gated. **The correct derivation is that this diff's repository-gate set is
EMPTY** — which is also why no repository gate can go red on account of a commit in this pack. The
repository `format` rc 0 is reported below as a true statement about the repository, not as evidence
about the diff.

## 4. What the reviewer measured that this pack had not, recorded as theirs

* **The `--write` lane under the NEW failure shape.** I had measured `--write` against the
  *absent*-git shape only. Theirs: rc 2, the named refusal, manifest byte-identical afterwards —
  **and with the guard deleted, rc 1 and the manifest still byte-identical**. That is the
  measurement behind P3 rather than P2: the defect was never about what gets written, only about
  which code and which sentence a reader is handed.
* `PermissionError` is reachable only inside the same import-to-call window, because `shutil.which`
  tests `X_OK` and will not select a mode-000 file; it enters by the same handler, so the arm covers
  the class.
* **A call-site sweep instead of a line read:** the digest tool has **one** `_GIT_BIN` call, the
  sibling **two** — the helper and the `--repo` bootstrap — all wrapped, and `retracted-claims.py`
  has none. The bootstrap site is the one a one-line patch forgets; it was not forgotten.
  `SystemExit` is a `BaseException`, so no `except OSError` elsewhere can swallow the refusal.
* They verified all **70 rows against disk with their own script, 0 mismatches**, and explained a
  thing I had not looked at: `P14-MIGRATION-PATCH-REQUEST.md` keeps 114,156 B across a changed
  digest because every edit in its generated block is a same-length substitution (38→39, 146→149,
  114→117, 121→124).
* Repository gates at `32017cf` in both columns, with `G6` reproducing, which is how they know the
  cold column was cold; and `git diff --stat 2091119..HEAD -- . ':!phase-preparation'` is **empty**,
  so that commit changed no input to any repository gate.
* `gate-sweep.sh` was +45/−0 and both tool diffs were additions plus wrapping: **nothing deletes or
  weakens an existing arm.**
* **Two runs of their own that they disclosed as void and quoted nowhere**: a sweep that collided
  with a detached earlier run of theirs into one log, and a set of deletion copies taken while a
  clean sweep was still mutating the pack. They discarded both and re-ran from a tree verified
  clean. Their own note is the one worth copying: *a baseline that refuses to be green caught it
  both times*. This pack's baseline row exists for that reason and earns its place here.

## 5. Exit codes at this head

Taken after the last write to any document of this round, which is the manifest itself. Per round
18's rule, **no count of the manifest's own revisions is quoted here**; that figure is measured in
a fresh clone of the pushed head and reported to the reviewers.

* `tools/gate-sweep.sh` — ~~rc 0, **79 ok**, `0 gate(s)/proof(s) not as required`, from four
  working directories, with the cluster up~~ — **STRUCK in
  `P14-AMENDMENT-31-CHALLENGE-ROUND-25.md` on the reviewer's `R25-P2-01` and `R25-P3-02`, and
  enforced as retracted claim 28.** The figure was true when it was taken and it is **not
  reproducible at this head**, which is what this section claims for it. The sweep's
  `manifest-shared` lane reads `/mnt/project-files/phase14`, a folder every session in this project
  writes; the coordinator's review of `32017cf` was written there at **09:08:24 UTC**, after this
  measurement and before the push, and from that moment the sweep answers **rc 1, 78 ok, `1
  gate(s)/proof(s) not as required`** at this same head, `manifest-shared` FAILing `STALE:
  P14-COORD-DIFF-REVIEW-32017cf.md: ARTIFACT WITH NO ROW`. The reproducible figure for a SHA is the
  clone-pinned lane in the next bullet. 78 ok at `32017cf`; the one added this round is
  `sibling-unrunnable-refused`, and that arm and its deletion row do reproduce.
* `tools/manifest-digests.py --check` — rc 0 ~~in both lanes~~ **in the clone-pinned lane**
  (`--dir` pointed at the pack inside a clone of this head), 72 artifact rows + the manifest,
  72 files, **1 revision found by the marker**. *"Both lanes" is struck for the same cause:* the
  default-`--dir` lane reads the shared folder, and from 09:08:24 UTC it answers 73 files there
  against 72 rows. The row and file counts above are the clone-pinned figures and they reproduce.
* `tools/citation-provenance.py` — rc 0, and `--check P14-MIGRATION-PATCH-REQUEST.md` rc 0.
* `tools/retracted-claims.py` — rc 0, 27 claims across 40 pack documents.
* repository `npm run format` — rc 0, reported as a statement about the repository: by §3 this
  diff's repository-gate set is **empty**, so no repository gate reads any file it changes.

## 6. Residuals at this head, signed by neither reviewer

* The in-pinned-set binary arm stays **absent and named**; both reviewers took that measurement by
  hand and neither would ship it as an arm.
* `parents-unknown` unwitnessed — five constructions between us, none reaching the state.
* `GIT_EXEC_PATH` **UNMEASURED** (not set in this container); the translated-git leg **UNMEASURED**
  (no git message catalogues here).
* **CI has never run a Phase 14 SHA, and no workflow in this tree runs this pack's gates.**
* `OD-P14-09`, `-10`, `-11` remain open with Ashraf, unchanged by any signature.
