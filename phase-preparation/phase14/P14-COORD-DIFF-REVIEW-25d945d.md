# Phase 14 — coordinator diff review, `32017cf..25d945d`

**Subject:** `25d945d6b1eb1c1c7253b043295c33a465fed291`, tree `9b69bb04939c85d207690ff86ea10ab2513159b0`,
parent `32017cf576a9784d67b9d26d2437533d1300dd3e`; both fetched by full SHA into a fresh clone, tree exported via `git archive` before measuring.
**Input verified:** `P14-CHALLENGE-25d945d.md` 10,856 B, sha256 `cbaba779d9962976ee1cc3d390b7c2d3ce65bff873c7e244e856ab978115ad82` (wc -c / sha256sum on disk).

## Verdict: **SIGN** for `25d945d6b1eb1c1c7253b043295c33a465fed291` only

No measured-false claim in the commit's content and no fail-open. Two named residuals below. Not a promotion; Phase 14 remains PREPARED / NOT PROMOTED; CI has never run a Phase 14 SHA.

## 1. The diff

Six files, all under `phase-preparation/phase14` (amendment 29, amendment 30 new, challenger round-24 report, manifest, patch-request block, `gate-sweep.sh` +19/−0). `git diff --stat 32017cf..25d945d -- . ':!phase-preparation' | wc -c` → `0`. The repo-gate set the diff touches is therefore empty; no npm/format/lint/typecheck/build gate was run for that reason (stated, not implied).
`cmp` of committed `P14-CHALLENGE-32017cf.md` against the shared copy: identical.

Pinned files at head (sha256sum from my clone), all matching challenger §5:

    757a4162b0c7fea635d3eacb675e906e97be60ba0007b9199b36b888e5f16d42  P14-HANDOFF-MANIFEST.md
    53ed45590a2147a5adc783c61ee2b16fbfe2775a2b982b9459de3113ba19c550  tools/manifest-digests.py
    b09d43d988ebd5ce8c6364aa35138408df8aee22a5d2e1fab5c67341b2804a72  tools/citation-provenance.py
    efc92780b0c68d6e360cdb48e5c0ad576199daa4c0740147ebf05def2b273d87  tools/gate-sweep.sh
    9fd1d35bec9cc55db923c9d82a7c896f13c530ae3122b3bafe2bf7bb9c7ce866  tools/RETRACTED-CLAIMS.tsv

## 2. The new arm (`sibling-unrunnable-refused`) — measured by deletion

Head, `gate-sweep.sh --no-db`: rc=1, 70 `ok` lines (DB lanes not run; the 78/79 figures include DB lanes I did not take), and

    FAIL  manifest-shared            rc=1 identical from 4 directories — consistent, but FAILING
    ok    sibling-unrunnable-refused rc=2, refused with could not be run (.*), so no provenance could be read
    == 1 gate(s)/proof(s) not as required

Mutant (separate clone; one line `raise exc` inserted at the top of `_refuse_unrunnable_git` in `citation-provenance.py`):

    FAIL  manifest-shared            rc=1 identical from 4 directories — consistent, but FAILING
    FAIL  sibling-unrunnable-refused rc=1 (required 2), and the message was not could not be run (.*), so no provenance could be read: Traceback (most recent call last):
    == 2 gate(s)/proof(s) not as required

The guard now has an arm that reds on its removal and on nothing else. R24-P3-01 closed by measurement.

## 3. Residuals, severity measured by me

### R25-P2-01 → measured **P3** (named residual, fails closed)
`git cat-file -e HEAD:phase-preparation/phase14/P14-COORD-DIFF-REVIEW-32017cf.md` → `fatal: ... does not exist in 'HEAD'`, rc 128. Shared lane at head:

    STALE: P14-CHALLENGE-25d945d.md: ARTIFACT WITH NO ROW
    STALE: P14-COORD-DIFF-REVIEW-32017cf.md: ARTIFACT WITH NO ROW
    manifest: 72 artifact row(s) + the manifest itself; 74 file(s) in /mnt/project-files/phase14; ...
    shared rc=1

(Now two files, not one: the challenger's own round-25 report has since landed in the folder — which itself demonstrates R25-P3-02.) Clone lane, the SHA's own check:

    manifest: 72 artifact row(s) + the manifest itself; 72 file(s) in .../repo/phase-preparation/phase14; ...
    every artifact row matches the file on disk, and every file has a row.
    clone rc=0

On a copy of the shared folder with those two files removed: `72 file(s)`, rc 0. So the red is caused entirely by documents written after/outside the commit. The commit's content is internally consistent; the missing coordinator report is a record-completeness gap, not a false claim in a file of this SHA. Amendment 30 §5's "at this head" sweep figure is not reproducible now, but it was a time-of-measurement figure of a mutable folder (see P3-02), not a false property of the SHA. I rate it P3, not P2: nothing in the tree is wrong, the gate fails closed, and the remedy is to commit the review with its row in the next round.

### R25-P3-02 → measured **P3** (named residual, not fail-open)
`gate-sweep.sh:21 SHARED=/mnt/project-files/phase14`, `:163 gate manifest-shared ... --dir $SHARED --check`. Attack on a copy: adding one stray file `P14-STRAY.md` flips the lane to `STALE: P14-STRAY.md: ARTIFACT WITH NO ROW`, rc 120 (nonzero); removing files flips it back to 0. So the lane's exit code is a property of the folder, not the SHA — confirmed. Fail-open test: can a folder writer make the sweep green over a bad SHA? No — the `manifest-digests` lane (`--dir $PACK`, the clone) is independent of the folder and stays the SHA's verdict; corrupting the folder can only add red or remove red from `manifest-shared` itself. Not fail-open; P3. Recommended: publish the per-SHA sweep figure with `manifest-shared` reported separately with its read time.

## 4. Still open, signed by no one
In-pinned-set `git` arm; `parents-unknown` unwitnessed; `GIT_EXEC_PATH`/translated-git leg UNMEASURED; DB lanes not run by me this round; CI never run on a Phase 14 SHA; `OD-P14-09/-10/-11` open with Ashraf.
