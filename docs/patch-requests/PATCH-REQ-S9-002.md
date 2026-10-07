# PATCH-REQ-S9-002 — the `scan:secrets:phase4` and `export:release:phase4` npm aliases

| | |
|---|---|
| raised by | P4-S9 |
| base SHA | `6587460ba3632231e4324c5ce2af92e1589d0705` |
| target file | `package.json` (the root `scripts` block) |
| owner | the build / tooling owner (the coordinator) |
| checks waiting on it | `secret-scan-phase4-alias`, `rc-archive-builder` (both `WAITING_FOR_INTEGRATED_SURFACE`) |
| test that requires it | `tests/guards/p4s89-waiting-status-law.test.ts::secret-scan-phase4-alias reports WAITING_FOR_INTEGRATED_SURFACE and never PASS` and `::rc-archive-builder reports WAITING_FOR_INTEGRATED_SURFACE and never PASS` |

## Required change

```json
"scan:secrets:phase4": "tsx scripts/phase4-secret-scan.ts",
"export:release:phase4": "tsx scripts/export-release.ts --phase=4",
```

## Reason

`RELEASE_PLAN` step 4 names `npm run scan:secrets:phase4` and step 11 names
`npm run export:release:phase4` (`scripts/phase4-s9/release.ts`). Neither
script exists, so both steps would fail as a missing npm script rather than as
a verdict. The release plan is written against the commands it will run, and
`secret-scan-phase4-alias` additionally asserts that the alias invokes
`scripts/phase4-secret-scan.ts` and NOT the Phase 3 engine directly under a
Phase 4 name — the Phase 4 entry point is what verifies `PHASE4_BASE` against
`git merge-base` before delegating (`P4-AL-78`).

## Dependency

`export:release:phase4` additionally needs `scripts/export-release.ts` to accept
`--phase=4`. That file is the export owner's; this request covers only the
aliases, and the `--phase=4` arm is **PATCH-REQ-S9-003**.

## Why S9 did not edit the file

`package.json` carries every slice's gate alias; a concurrent slice editing it
at the same time is a guaranteed conflict in a file whose merge resolution
nobody reviews line by line. The alias is also the point at which the integrated
gate becomes runnable, and that must happen once, deliberately, after the
predecessor slices seal.

## Expected semantic diff

| | before | after |
|---|---|---|
| `npm run scan:secrets:phase4` | missing script | runs the Phase 4 range scan |
| `npm run export:release:phase4` | missing script | builds `DAFTAR_PHASE_4_RC.zip` |
| `secret-scan-phase4-alias` | WAITING (subject absent) | evaluates — PASS if the alias names the Phase 4 entry point |
| `rc-archive-builder` | WAITING (subject absent) | evaluates — FAIL until an archive and its sibling `.sha256` exist |

Note the second row of that table: making the subject real does **not** make the
check green. `rc-archive-builder` will then report FAIL, because the archive
does not exist yet. That is the correct progression — WAITING means "cannot be
asked", not "would pass".
