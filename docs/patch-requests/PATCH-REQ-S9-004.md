# PATCH-REQ-S9-004 — the release-evidence workflow at an exact SHA

| | |
|---|---|
| raised by | P4-S9 |
| base SHA | `6587460ba3632231e4324c5ce2af92e1589d0705` |
| target file | `.github/workflows/phase4-s9-release.yml` (new) |
| owner | the CI / workflow owner (the coordinator) |
| check waiting on it | `ci-exact-sha-evidence` |

## Required change

A `workflow_dispatch` workflow taking the seal SHA as an input, checking out
**that exact SHA**, and recording, for every run it reports:

- the branch head SHA,
- the base SHA,
- the synthetic merge SHA (for a `pull_request` run; absent otherwise),
- the run id,
- the attempt.

It runs the Tier-2 budgets under an exclusive-box attestation, the extracted-
archive gate, and the upgrade rehearsal, and uploads `release/phase4/*.json`.

`scripts/phase4-s9/evidence.ts` already carries the record shape
(`CiEvidenceRecord`), the verdict law (`releaseEvidenceVerdict`:
`EXACT_SHA_GREEN` / `EQUIVALENT_TREE_ONLY` / `NO_RUN_FOR_THIS_SHA`) and the
report generator, so the workflow emits and does not decide.

## Vocabulary constraint — TD-08

TD-08 is **OPEN / EXTERNAL / UNVERIFIED**: branch-protection inspection returns
403. Neither this workflow, nor its summary, nor the release report may state
anything about the repository branch-protection settings: not that a check is
enforced, not that protection is switched on, not that `main` cannot be written
to directly, not that there are "six required checks", and not that GitHub
itself refuses the merge. The correct vocabulary is **"the six repository CI jobs"** /
**"the six expected release checks"**. `vocabularyProblems` refuses all five
phrasings (the exact patterns are in `scripts/phase4-s9/evidence.ts`), and
`releaseReportProblems` runs it over the generated report. It refuses a DENIAL of the claim too: the scanner is lexical and cannot
tell a denial from a claim, and neither can a reader quoting one sentence.

What stands in for TD-08 is six compensating controls (`COMPENSATING_CONTROLS`,
CC-1…CC-6): PR only, no direct push to main, no force push, the PR stays Draft,
six jobs green before release acceptance, and no main merge without explicit
owner authorization. Exactly one of them is verifiable from this tooling; the
report says which.

## Expected semantic diff

| | before | after |
|---|---|---|
| a release-evidence run at the seal SHA | impossible | dispatchable |
| `ci-exact-sha-evidence` | WAITING (workflow absent) | evaluates |
| `releaseEvidenceVerdict(sealSha, [])` | `NO_RUN_FOR_THIS_SHA` | unchanged until a run exists |

## Why S9 did not create the file

`.github/workflows/**` is the evidence surface for a slice currently in
acceptance (P4-S4). A new file in that directory changes which workflows a
push triggers, mid-acceptance.
