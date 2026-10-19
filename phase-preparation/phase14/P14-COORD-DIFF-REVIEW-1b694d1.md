# Phase 14 — coordinator diff review, `25d945d..1b694d1` (two commits)

**Subject:** `1b694d1f4a1b948698bc4e4a2b4b3e2e8b61a048` (parent `dac688d`), fresh clone, SHA pinned, tree exported with `git archive`.
**Verdict: SIGN** for `1b694d1f4a1b948698bc4e4a2b4b3e2e8b61a048` alone. Not a promotion, not a statement about CI.

Challenger input verified before reading: `P14-CHALLENGE-1b694d1.md` 10325 B, sha256 `9db03084f64cbe725171b38ac7c1820f3b42a9b8fb4b913a6de56b70b35b43fb`.

## 1. Scope
`git diff --name-only 25d945d HEAD | grep -v '^phase-preparation/'` gives no output (rc=1). 9 files, +893/-13, all under `phase-preparation/phase14/`. Code touched: `tools/gate-sweep.sh` (+75/-12) and one row in `tools/RETRACTED-CLAIMS.tsv`. **`tools/manifest-digests.py` is not in the range.**

## 2. Committed reviews against their digests (read from the exported tree)
```
10856 cbaba779d9962976ee1cc3d390b7c2d3ce65bff873c7e244e856ab978115ad82  P14-CHALLENGE-25d945d.md
5353 68fd206f1b40b6e0574f29fbd2a604957108a07ea28fa897f1ecf92cec8b0eda  P14-COORD-DIFF-REVIEW-25d945d.md
17335 876afe4ab155a9cd196a1cbe6cd85d8421f8687d9950c3b07ea086c90f8de594  P14-COORD-DIFF-REVIEW-32017cf.md
```
All three match, and each one has a manifest row.

## 3. Repo gates at the pinned clone
```
manifest: 76 artifact row(s) + the manifest itself; 76 file(s) in .; reviewer-row history checked over all 34 revision(s) ...
every artifact row matches the file on disk, and every file has a row.
rc=0
28 retracted claim(s) enforced across 41 pack document(s); 37 challenge report(s) exempt in code ...
rc=0
P14-MIGRATION-PATCH-REQUEST.md: generated citation-provenance block is current.
rc=0
```
`bash -n gate-sweep.sh` gives rc 0. (On the exported tree, which has no `.git`, manifest-digests fails closed with HISTORY NOT VERIFIED and citation-provenance gives CONFIGURATION ERROR. That is the expected refusal, not a defect.)

## 4. The `offrepo` lane (new in this range), measured
I ran the full `gate-sweep.sh --no-db` twice. `P14_SHARED` pointed first at a clean mirror of the pack and then at the same mirror with one unrowed `P14-COORD-DIFF-REVIEW-zzzzzzz.md` added:
```
clean rc=0 ok=70   ... obs   manifest-shared rc=0 identical from 4 directories
                   == 0 gate(s)/proof(s) not as required ... == 0 off-repository lane(s) differ
stale rc=1 ok=70   ... OFF-REPO-DIFFERS manifest-shared rc=1 identical from 4 directories ...
                   == 0 gate(s)/proof(s) not as required ... == 1 off-repository lane(s) differ
```
The SHA figure (`ok` count and `fail`) is identical in both runs, while the exit code moves to 1. So the shared lane is kept out of the quotable figure and still fails closed. Confirmed.

## 5. R26-P1-01 (manifest enumeration), rebuilt myself
I worked on a scratch clone at the same SHA and ran one plant at a time, removing each before the next:
```
baseline: manifest rc=0 norow=0 | retracted rc=0 across 41 pack
zz.txt: manifest rc=0 norow=0 | retracted rc=0 across 41 pack
tools/zz.md: manifest rc=0 norow=0 | retracted rc=0 across 41 pack
proofs/zz.md: manifest rc=0 norow=0 | retracted rc=0 across 42 pack
P14-CHALLENGE-ZZZZZZZ.MD: manifest rc=0 norow=0 | retracted rc=0 across 41 pack
P14-CHALLENGE-ZZZZZZZ.md: manifest rc=1 norow=1 | retracted rc=0 across 41 pack
proofs/zz.md with retracted phrase: manifest rc=0 norow=0 | retracted rc=1 across 42 pack
```
The challenger's measurement reproduces. The cause is `manifest-digests.py:800-801`, a non-recursive `os.listdir` with a case-sensitive `.md`/`.yaml` filter.

**Does it block this SHA? No.**
- The file is untouched by the range.
- Every file the range adds is a top-level lowercase `.md`, and each one has a row (the gate gives rc 0 with 76 rows and 76 files).
- The new lane uses the same command, so it inherits the gap. It does not widen it, and nothing in the range relies on the gap.

**Own severity: P2, pre-existing named residual.**
- It is a coverage gap in the "every file has a row" claim.
- Content in a subdirectory is still seen by retracted-claims. The last line above shows a planted retracted phrase in `proofs/` turning that gate red.
- Any committed plant shows in `git diff`.
- It must be fixed before any "this manifest pins the pack" statement is made: walk recursively, compare extensions case-insensitively, or refuse unknown files.

## 6. R26-P3-02 (uncommitted reviewer reports in the shared folder)
This is a read-only check of the real folder now:
```
  STALE: P14-CHALLENGE-1b694d1.md: ARTIFACT WITH NO ROW
manifest: 76 artifact row(s) + the manifest itself; 77 file(s) in /mnt/project-files/phase14; ...
rc=1
```
The sweep's offrepo lane detects this when it runs, but no pre-commit check exists. **Own severity: P3, process residual.** It does not block.

## Residuals carried
- P2: manifest enumeration is non-recursive and case-sensitive (pre-existing).
- P3: no pre-commit check for shared-folder reports.

**SIGN `1b694d1f4a1b948698bc4e4a2b4b3e2e8b61a048`.**
