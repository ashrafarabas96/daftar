# PATCH-REQ-S9-003 — `export-release.ts --phase=4`, and the sibling checksum

| | |
|---|---|
| raised by | P4-S9 |
| base SHA | `6587460ba3632231e4324c5ce2af92e1589d0705` |
| target file | `scripts/export-release.ts` |
| owner | the release-export owner |
| check waiting on it | `rc-archive-builder` |
| detector | `scripts/phase4-s9/release.ts` → `archiveProblems`, `renderSiblingChecksum` |

## Required change

A `--phase=4` arm producing `release/DAFTAR_PHASE_4_RC.zip` plus
`release/DAFTAR_PHASE_4_RC.zip.sha256`, the checksum file in `sha256sum`
format (`<64 hex>  <filename>\n`) so an operator verifies it with the tool they
already have.

## Reason, and the one constraint that is not negotiable

The checksum is a **SIBLING** file, never a member of the archive. A checksum
file inside the archive it describes is not computable: adding it changes the
bytes it is a hash of. `archiveProblems` asserts the sibling exists, that it
hashes the archive that actually shipped, and that it NAMES the file it
describes (otherwise `sha256sum -c` cannot use it).

## Ordering constraint

The archive is built **after** the dependency audit (`RELEASE_PLAN` step 11
follows step 6). Any security dependency fix is narrow, reviewed, documented in
the lockfile and folded into the FINAL RC checksum — an archive built before the
audit ships a checksum of a tree that predates the fix. `releasePlanProblems`
refuses the reverse order and names this reason.

## Expected semantic diff

| | before | after |
|---|---|---|
| `release/DAFTAR_PHASE_4_RC.zip` | absent | built |
| `release/DAFTAR_PHASE_4_RC.zip.sha256` | absent | sibling, `sha256sum -c`-verifiable |
| `archiveProblems(root)` | `['DAFTAR_PHASE_4_RC.zip is absent — nothing to checksum']` | `[]` |

## Test that requires it

`tests/guards/p4s89-waiting-status-law.test.ts::leaves WAITING once its subject
becomes real, and then says something about it` builds the minimal tree in which
`export:release:phase4` exists and asserts that `rc-archive-builder` then
reports FAIL naming `DAFTAR_PHASE_4_RC.zip` — i.e. it asks for the archive
rather than passing over its absence.
