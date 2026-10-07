# PATCH-REQ-S9-001 — the secret-history range scan is skipped on the PUSH path

| | |
|---|---|
| raised by | P4-S9 (release engineering) |
| base SHA | `6587460ba3632231e4324c5ce2af92e1589d0705` |
| target file | `.github/workflows/ci.yml` |
| live subject | `ci.yml:702` (step name), `ci.yml:703` (`if:`), `ci.yml:712` (the command), `ci.yml:714` (the artefact upload) |
| owner | the CI / workflow owner (the coordinator) — **not S9** |
| severity | release-blocking for P4-S9 acceptance |
| detector | `scripts/phase4-s9/workflow-asymmetry.ts` → `secretScanCoverageProblems` |
| check | `scripts/phase4-s9/index.ts` → `secret-scan-push-coverage` (currently **FAIL** on the live tree) |
| test that requires it | `tests/guards/p4s89-framework-laws.test.ts::the trigger-asymmetry detector names the live ci.yml secret-scan step and its line` |

## The live text

```
702:      - name: Secret history range scan (every commit of the pull request)
703:        if: github.event_name == 'pull_request'
704:        env:
705:          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
706:          HEAD_REF: ${{ github.head_ref }}
707:          BASE_REF: ${{ github.base_ref }}
708:        run: |
...
712:          npm run scan:secrets:phase3 -- --head="$HEAD_SHA" --main-ref="origin/$BASE_REF" $base_arg --evidence=release/secret-history-scan.json
713:      - uses: actions/upload-artifact@v4
714:        if: always() && github.event_name == 'pull_request'
```

## Why this matters, precisely

`P4-AL-79` makes the **push** run at the seal commit's own SHA the authoritative
evidence: a Phase closes on a `push` run of `DAFTAR CI` at that exact SHA plus a
release-evidence run at the same SHA, and a `pull_request` run on a synthetic
merge commit is *equivalent-tree* evidence and is labelled as such.

So the ONE run that is exact-SHA evidence for the commit being released is the
one run in which the secret-history range scan **does not execute**.

The `gitleaks-action` step above it does run on both triggers, but its own step
comment records why it is not the cover: on a pull request it pages the first 30
**oldest** commits and scanned about 30 of 400 on PR #4. So on the push path the
candidate history is covered by nothing at all.

`[[daftar-a-check-only-asked-where-it-passes]]` in its purest form: the check
exists, it is green, and it is green on the path that is not the evidence.

## Required change

1. Remove `if: github.event_name == 'pull_request'` from the range-scan step and
   give it a trigger-independent head/base. On a `push` the head is
   `github.sha`; the base stays `PHASE4_BASE`, **verified** against
   `git merge-base` by the script itself (`P4-AL-78`), which is why no new
   trigger-specific base expression is needed:

   ```yaml
         - name: Secret history range scan (every commit of the candidate range)
           env:
             HEAD_SHA: ${{ github.event.pull_request.head.sha || github.sha }}
             HEAD_REF: ${{ github.head_ref || github.ref_name }}
             BASE_REF: ${{ github.base_ref || 'main' }}
   ```

2. Change the upload-artifact guard on line 714 from
   `if: always() && github.event_name == 'pull_request'` to `if: always()`, so
   the push run's evidence file is retrievable. Evidence that exists and cannot
   be fetched is not evidence.

3. The checkout for the `hygiene` job must have enough history for the range on
   a push (`fetch-depth: 0`, or a fetch of `PHASE4_BASE`). A range scan over a
   shallow clone silently covers a shorter range, which is the exact defect
   `scripts/phase3-secret-scan.ts:8-15` exists to prevent
   (`[[daftar-gitleaks-window-slides]]`).

## What is explicitly NOT the fix

- **No allowlist and no `.gitleaksignore` entry.** A false positive in
  *candidate* history is answered by rewriting that history
  (`[[daftar-clean-history-not-a-weaker-scan]]`). Accepted SHAs are immutable,
  so a finding inside a sealed range is a finding, not a rewrite candidate.
- **No weakening of the scan** — not the rule set, not `--ignore-gitleaks-allow`,
  not the pinned checksum-verified gitleaks `8.24.3`.
- **No second scanner.** `scripts/phase4-secret-scan.ts` delegates to the
  accepted Phase 3 engine unchanged; a rewrite would create two scanners that
  can disagree, and the disagreement would be discovered by a release.

## Why S9 did not edit the file

`.github/workflows/**` is the evidence surface for a slice currently in
acceptance (P4-S4). Editing it from here would change, mid-acceptance, the job
whose green tick that slice's evidence rests on. So S9 **detects** and this
request is the fix.

## Expected semantic diff

| | before | after |
|---|---|---|
| triggers the range scan runs on | `pull_request` only | `push` and `pull_request` |
| triggers with NO range-scan cover | `push` | none |
| `secretScanCoverage().uncoveredTriggers` | `['push']` | `[]` |
| `secret-scan-push-coverage` | FAIL | PASS |
| evidence artefact on a push run | not uploaded | uploaded |

## How to verify the patch

```
npx tsx scripts/phase4-s9/run.ts            # secret-scan-push-coverage must be PASS
npx vitest run tests/guards/p4s89-framework-laws.test.ts
```

The test asserts the live defect, so it goes **red** when the workflow is fixed,
and its message says so. That is the intended way for a recorded finding to
expire: the proof of the finding is also the proof it is gone. Update that one
`it(` block in the same patch, keeping the passing counterfactual it already
carries (`findTriggerAsymmetries(fixed, SECRET_HISTORY_COMMAND)` must be empty).
