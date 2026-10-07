# DAFTAR — PHASE 4 — P4-S9 CONTRACT PACK

**Release engineering. S9 IS EVIDENCE ONLY.**

> No product fix belongs to S9. Where this tooling exposed a product defect it
> is routed to the owning slice as a finding — it is **not** fixed here. Three
> such findings are routed below.

| | |
|---|---|
| slice | P4-S9 |
| branch | `p4s89/owner` |
| **base SHA** | **`6587460ba3632231e4324c5ce2af92e1589d0705`** |
| base branch | `phase/4-sales-pos-customers-receivables` |
| **`PHASE4_BASE`** | **`6fc505d33b7a6f7a49fa04ee3bc60bb1ddf3b595`** — verified against `git merge-base`, every run |
| maturity delivered | A–E |
| maturity NOT delivered | any performed deployment, any archive, any exact-SHA CI evidence, the seal |
| **READY_TO_PROMOTE** | **NO** |

---

## 1. What this slice built

| artefact | path | what it is |
|---|---|---|
| CI evidence law | `scripts/phase4-s9/evidence.ts` | `CiEvidenceRecord`, `releaseEvidenceVerdict`, the TD-08 vocabulary refusal, the merge-base validator, the 13-artefact evidence index, the report generator |
| release plan | `scripts/phase4-s9/release.ts` | 13 ordered steps, the skip-flag refusal, the audit refusals, the migration hash verifier, the archive + sibling checksum, both deployment procedures, the catalogue dimensions |
| trigger asymmetry | `scripts/phase4-s9/workflow-asymmetry.ts` | the push/PR secret-scan detector |
| resolution containment | `scripts/phase4-s9/resolution-containment.ts` | is the tree being judged the tree that resolved? |
| the Phase 4 secret scan | `scripts/phase4-secret-scan.ts` | delegates to the **accepted** Phase 3 engine, unchanged |
| registry + runner | `scripts/phase4-s9/index.ts`, `run.ts` | 21 checks |

### Current verdict

```
FAIL: 1 of 21 check(s) refuse this tree (13 pass, 7 waiting for an integrated surface)
```

The one FAIL is a **real live defect**, not a framework problem — see §3.

---

## 2. The no-fake-PASS law, reused and not reimplemented

S9's registry uses `FrameworkCheck` / `evaluateCheck` from
`scripts/phase4-s8/verdict.ts` **on purpose**. A second implementation of the
law would be a second law. A release gate is the single worst place for a
vacuous green, because its green is the thing a human reads *instead of* doing
the deployment themselves.

### Checks reporting `WAITING_FOR_INTEGRATED_SURFACE`, and why

| check | missing subject | why it cannot be asked | request |
|---|---|---|---|
| `secret-scan-phase4-alias` | npm script `scan:secrets:phase4` | release plan step 4 names a command that does not resolve | S9-002 |
| `rc-archive-builder` | npm script `export:release:phase4` | step 11 names a command that does not resolve, so no archive is produced | S9-002/003 |
| `release-gate-composed` | npm scripts `gate:phase4:release`, `gate:phase4:s8` | the integrated gate cannot exist until S5–S8 seal | S8-005, S9-002 |
| `ci-exact-sha-evidence` | `.github/workflows/phase4-s9-release.yml`, `release/phase4/ci-push-run.json` | no release-evidence workflow exists and no run at a seal SHA has happened | S9-004 |
| `archive-gate-rerun` | `release/phase4/archive-gate.json` | E-01 is produced by **performing** the re-run; the procedure exists, the evidence cannot until the archive does | S9-003 |
| `upgrade-rehearsal-evidence` | `release/phase4/upgrade-rehearsal.json` | proof (B) is proved by performing the upgrade; a procedure document is not the proof | — |
| `tier2-budget-evidence` | `release/phase4/budgets-tier2.json` | S8 **builds** the orchestrator; the coordinator runs it under an exclusive box. A measurement taken while other agents run is INVALID — RESOURCE CONTENTION, neither pass nor fail | — |

Each of those four `evaluate` bodies returns a loud **NOT IMPLEMENTED** problem
rather than an empty array. A stub returning no problems once the subject became
real would be a fake PASS **over real evidence**, which is worse than over no
evidence.

---

## 3. The live finding: the secret-history range scan skips the PUSH path

**`.github/workflows/ci.yml:702-703`, with the command at `:712` and the
artefact upload guarded at `:714`.**

```
702:      - name: Secret history range scan (every commit of the pull request)
703:        if: github.event_name == 'pull_request'
712:          npm run scan:secrets:phase3 -- --head="$HEAD_SHA" … --evidence=release/secret-history-scan.json
714:        if: always() && github.event_name == 'pull_request'
```

`P4-AL-79` makes the **push** run at the seal commit's own SHA the authoritative
evidence. So the ONE run that is exact-SHA evidence for the commit being
released is the one run in which this scan **does not execute**. The
`gitleaks-action` above it runs on both triggers, but its own step comment
records why it is not the cover: on a pull request it pages the first 30
**oldest** commits and scanned about 30 of 400 on PR #4. On the push path the
candidate history is covered by **nothing**.

`[[daftar-a-check-only-asked-where-it-passes]]` in its purest form: the check
exists, it is green, and it is green on the path that is not the evidence.

→ **PATCH-REQ-S9-001.** S9 detects; S9 does not edit `.github/workflows/**`,
which is the evidence surface for a slice currently in acceptance (P4-S4).

The detector finds the step by **what it runs**, not what it is called, so a
rename does not hide it; and an `if:` expression it cannot parse is treated as
admitting **both** triggers, so an unreadable condition is never reported as an
asymmetry. A detector that guessed would cry wolf once and be ignored for ever.

---

## 4. CI terminology — precise, because the imprecision is the defect

| term | means |
|---|---|
| **PUSH evidence** | the exact branch-head SHA. The commit being released. |
| **PR evidence** | the merge tree / equivalent tree. A **synthetic** merge commit, not the commit being released. |

Every record carries: **branch head SHA, base SHA, synthetic merge SHA, run id,
attempt.** `releaseEvidenceVerdict` returns exactly one of
`EXACT_SHA_GREEN` / `EQUIVALENT_TREE_ONLY` / `NO_RUN_FOR_THIS_SHA`.

**Never** claim a PR run is the same commit unless it genuinely is. **Never**
report CI SUCCESS for a commit unless a workflow run exists for that exact SHA.

### TD-08 — branch protection is **OPEN / EXTERNAL / UNVERIFIED**

Inspection returns **403**. Accordingly this
slice makes no statement about the repository branch-protection settings. The correct vocabulary is **"the six repository CI
jobs"** / **"the six expected release checks"**. `FORBIDDEN_PHRASES` refuses
five phrasings and `releaseReportProblems` runs the scanner over the **generated
report**, so a report cannot make the claim even if its input data happened to
be truthful.

It refuses a **denial** of the claim too. The first draft of the report's TD-08
paragraph DENIED the forbidden claim about the branch-protection settings,
and the scanner matched it — **correctly**: a lexical scanner cannot tell a
denial from a claim, and neither can a reader who quotes one sentence out of a
release report. The phrase is now absent in every grammatical mood.

The six compensating controls (CC-1…CC-6) are what stands in for TD-08: PR only;
no direct push to main; no force push; the PR stays Draft; six jobs green before
release acceptance; no main merge without explicit owner authorization. **Exactly
one is verifiable from this tooling**, and the report says which.

---

## 5. The two deployment proofs, which are **not** the same proof

| | proof (A) | proof (B) |
|---|---|---|
| what | a fresh cluster, `0000` → candidate, then a second pass that must be a **no-op** | a **REAL upgrade** from the frozen predecessor prefix to the candidate |
| applied by | the from-zero runner | **`daftar_migrator`**, never a superuser |
| artefact | E-02 | E-03 |
| procedure | `RELEASE_PLAN` step 8 | `UPGRADE_REHEARSAL_PROCEDURE` U-1…U-7, step 9 |

**A's success never implies B's safety.** `releasePlanProblems` and
`evidenceIndexProblems` each refuse a plan or an index missing either one, and
the refusal says `A never implies B`.

> A suite that applies migrations as a superuser is never asked the two
> questions that decide whether a deployment works: **who owns it** and **who
> may do what to it**. So: prove a deployment by **performing** it, then diff
> the catalogue against a superuser build.

The diff covers **12 dimensions**: relations, columns, constraints, indexes,
policies, routines, **grants**, **ownership**, `row-security-forced`, triggers,
sequences, types. Grants and ownership are the two most often missing, and are
exactly the two a superuser build cannot be asked about. A **GRANT issued
without grant option WARNS and COMMITS**, so an ordering mistake produces a
green migration and a missing privilege — `[[daftar-grant-before-owner]]`.

U-7 is explicit: a diff is reported as a **finding against the owning slice**,
never as something S9 fixes.

---

## 6. The release gate plan — 13 steps, and why the order is load-bearing

| # | step | notes |
|---|---|---|
| 1 | **runner canary** | FIRST, always. Every exit status read before it is unreadable. |
| 2 | `RELEASE_GATE_SKIP_*` refusal | fails **before running anything**, never a reduced matrix |
| 3 | merge-base verification | `PHASE4_BASE` verified, never assumed |
| 4 | secret-history range scan | E-05 |
| 5 | migration hash verification | E-04, inside the extracted archive |
| 6 | dependency audit | E-07, **release-blocking** |
| 7 | inventories fresh | E-13 |
| 8 | **fresh cluster — proof (A)** | E-02 |
| 9 | **upgrade rehearsal — proof (B)** | E-03 |
| 10 | composed gates | E-01, ONE command, no workflow around it |
| 11 | RC archive | E-06, **after** the audit |
| 12 | archive re-run | E-01, from the extracted archive on a new cluster |
| 13 | evidence index + report | the TD-08 vocabulary refused in both |

> A gate that reads a verdict out of an exit status must **first** prove that
> status can say NO. DAFTAR's runner once exited 0 over failing tests and hid
> four of them.

`releasePlanProblems` refuses: a canary that is not first; a step reading an
exit status before the canary; a blocking step with no command; the skip refusal
not near the front; a missing proof (A) or (B); the archive re-run before the
build; and **the archive built before the audit** — because any security
dependency fix must be folded into the **FINAL** RC checksum.

### The extracted-archive procedure (A-1…A-7)

The gate failed **three times** the first time it ran on a clean runner and
inside an extracted archive, and **none of the three was a product defect**.
Every step exists because of one of those classes of failure: a new empty
directory; `npm ci` from the archive's own lockfile; a new cluster on a unique
`PG_DIR`/`PG_PORT`; **A-4, the resolution-containment assertion** (see §8); no
inherited environment; runnable as one command; and no `.git`, with every
history-dependent check reporting that it **cannot run** rather than passing.

---

## 7. Supply chain and secret scan — what is and is not a fix

### Dependency audit

Release-blocking at `--audit-level=high`. Refused by `auditProblems`: `--force`,
a lowered level, an advisory ignore, an allowlist. `sharp` is pinned at
**`0.35.5`**, read from the **lockfile** and not from a `package.json` range.
Any security dependency fix is narrow, reviewed, documented in the lockfile, and
folded into the final RC checksum.

### Secret scan

The engine is the **accepted** `scripts/phase3-secret-scan.ts`, reused
unchanged: the same pinned checksum-verified gitleaks `8.24.3` (archive digest
and binary digest both), the same default rule set with a `.gitleaks.toml`
refused, the same `--ignore-gitleaks-allow`, the same bare clone. Rewriting it
would create a second scanner that can disagree with the accepted one, and the
disagreement would be discovered by a **release**.

What is Phase 4's is the **base**. The delegation is sound only while the
merge-base of head and `main` **is** `PHASE4_BASE` — so that condition is
**asserted** (`delegationPreconditionProblems`), not assumed, and a result that
took the engine's already-merged-Phase-3 path is reported as **not a Phase 4
scan**. An empty range is refused too: nothing to scan is not evidence of
anything.

> The hygiene job's gitleaks window is a **sliding range**. A false positive in
> **candidate** history is answered by **rewriting that history** — never an
> allowlist, never weakening the scan. **Accepted SHAs are immutable**, so a
> finding inside a sealed range is a finding.

### Performance thresholds — immutable

No threshold increase. No p95→p90. No sample reduction. No outlier deletion. No
host multiplier. No cherry-picking runs. No hiding noisy results. All seven
refused by name, and additionally by comparison against an **independent second
copy** of the numbers (`DECLARED_THRESHOLDS`) — added because the first version
of the plan law accepted a table whose every ceiling had been doubled.

---

## 8. Is the tree being judged the tree that resolved?

npm writes workspace links as **relative** symlinks
(`node_modules/@daftar/inventory -> ../../packages/inventory`). A worktree whose
whole `node_modules` is a symlink to another checkout therefore resolves every
`@daftar/*` import to **that** checkout's packages, while the worktree's own
`tests/`, `scripts/` and `apps/` sources are still compiled — tsconfig includes
them by **path**. The run is green and the green is a statement about a tree
nobody edited. It bit two people in this container on one day.

A release gate's whole claim is "this commit, this tree, these results", and the
hazard is **invisible**: nothing fails, a number is simply about the wrong
thing. So it is now asserted rather than assumed:

- the check `resolution-containment`, which reads the **resolution** out of the
  filesystem and compares it against the root it was told to judge;
- step **A-4** of the extracted-archive procedure, which is where it bites
  hardest: an archive extracted beside a repository, with a `node_modules`
  leading back into it, would run the whole release gate against the
  repository's packages.

The check reports three distinct conditions, because they need different
actions: a link **escaping** the root; a declared entry point that **does not
exist** (every import then `TS2307`, which reads as a defect in the *importing*
code); and a build output **older than its sources** — which *resolves*, and
answers from code that is not the code in the tree. That last one produced a
`TS2305` after a merge that added package exports, and it read as a defect in
the merged code.

It found a real gap on its first run: `@daftar/design-system` unbuilt in this
very worktree, with at least eleven files under `apps/admin/src/app/**`
importing it. → **PATCH-REQ-S9-005.**

An **empty** `@daftar` scope is **not** a pass: nothing resolves, so nothing was
judged. In an extracted archive before `npm ci` the check reports
`WAITING_FOR_INTEGRATED_SURFACE` rather than answering yes.

---

## 9. The evidence index — 13 artefacts

E-01 archive gate · E-02 fresh cluster (A) · E-03 upgrade rehearsal (B) ·
E-04 migration hashes · E-05 secret-history range scan · E-06 RC archive +
sibling `.sha256` · E-07 supply chain · E-08 push run, six jobs, exact SHA ·
E-09 release-evidence run, same SHA · E-10 Tier-2 budgets under an exclusive
box · E-11 browser matrix · E-12 reconciliation · E-13 inventories.

11 of 13 are **exact-SHA bound**; all 13 are required. Every artefact carries a
**claim**, because an artefact with no claim is a file. `evidenceIndexProblems`
refuses a duplicate id, a claimless artefact, forbidden TD-08 vocabulary in any
claim, and a missing E-02 or E-03.

### The RC archive and its checksum

`DAFTAR_PHASE_4_RC.zip`, with the checksum as a **SIBLING** file in `sha256sum`
format. A checksum file **inside** the archive it describes is not computable:
adding it changes the bytes it is a hash of. `archiveProblems` asserts the
sibling exists, hashes the archive that actually shipped, and **names** the file
it describes — otherwise `sha256sum -c` cannot use it.

### Migration hash verification

Three independent sources: the file on disk, `MIGRATION_MANIFEST.json`, and the
prefix-module literals in `scripts/phase4-prefix.ts`. A **candidate** past
`frozenThrough` is legitimately absent from the manifest and is **not** a
finding — `[[daftar-a-closure-rule-is-not-an-invariant]]`: nothing says "no
migration may exist after N". The honest weakness: one commit could change all
three. Recorded, not claimed away. **No file under
`infrastructure/database/migrations/` was written, edited or numbered by this
slice.**

---

## 10. Reading a verdict

> A verdict is read only from fields that **NAME** something. A classifier that
> scanned a whole response body matched its SQLSTATE pattern inside a random
> request id about **one run in four thousand**.

`readVerdictField` and `readSqlstateField` read from a named field out of a
parsed object and from nowhere else; `refuseBlobClassification` refuses a call
site that passed the body text, at run time, because a body string is a legal
`unknown` and cannot be type-checked into correctness.

---

## 11. Prohibited assumptions

1. That a `pull_request` run is evidence for the commit being released.
2. Anything at all about the repository branch-protection settings: that a
   check is enforced, that `main` cannot be written to directly, or that a
   GitHub itself refuses the merge. TD-08 is **UNVERIFIED**; inspection returns 403.
3. That proof (A) implies proof (B).
4. That a superuser migration run answers who owns an object or who may do what
   to it.
5. That a false positive in candidate history may be allowlisted.
6. That an audit level, a threshold, a percentile or a sample count may be
   lowered to obtain a pass.
7. That an exit status can be read before a canary has proved one can be
   non-zero.
8. That a green run is about the tree it was pointed at, unless the resolution
   was checked.
9. That S9 may fix a product defect. It may not — it routes it.

---

## 12. Findings routed out of S9 (evidence only)

| finding | routed to | request |
|---|---|---|
| the secret-history range scan is skipped on the PUSH path, `ci.yml:702-703` | the CI / workflow owner | S9-001 |
| the worktree repoint script leaves `@daftar/design-system` unbuilt | the container-tooling owner | S9-005 |
| (S8's three product findings) | P4-S4 / the architecture-lock owner | S8-002, S8-003, S8-004 |

---

## 13. READY_TO_PROMOTE = **NO**

What would make it YES:

- [ ] PATCH-REQ-S9-001 landed — the range scan runs on the **push** path, its artefact uploads there, and the `hygiene` checkout has history for the range.
- [ ] PATCH-REQ-S9-002 and S9-003 landed — the two npm aliases and `export-release.ts --phase=4`.
- [ ] PATCH-REQ-S9-004 landed — the release-evidence workflow, dispatchable at an exact SHA.
- [ ] PATCH-REQ-S9-005 landed — the repoint script builds `design-system`.
- [ ] PATCH-REQ-S8-005 landed — `gate:phase4:s8`, so `gate:phase4:release` can compose it.
- [ ] `gate:phase4:release` existing and composing `gate:phase3:release` and `gate:phase4:s8` VERBATIM and INTERNALLY.
- [ ] **Proof (A) performed**: a fresh cluster `0000` → candidate, second pass a no-op. E-02.
- [ ] **Proof (B) performed**: the real upgrade as `daftar_migrator` from the frozen predecessor prefix, catalogue diffed against a superuser build across all 12 dimensions. E-03.
- [ ] The RC archive built **after** the audit, with its sibling `.sha256`, and the gate re-run **from the extracted archive on a new cluster**. E-01, E-06.
- [ ] The dependency audit green at `--audit-level=high` with no forbidden remedy. E-07.
- [ ] The Phase 4 secret-history range scan green over `PHASE4_BASE..head`, base verified. E-05.
- [ ] A **PUSH** run of `DAFTAR CI` green on all six repository CI jobs at the seal commit's own SHA, **plus** a release-evidence run at the **same** SHA, both recorded with run id and attempt. E-08, E-09.
- [ ] The Tier-2 budgets measured under an **exclusive-box attestation**, every sample kept, `planningStatistics` non-null. E-10.
- [ ] `npx tsx scripts/phase4-s9/run.ts` reporting `PASS` with **zero** WAITING and zero FAIL.
- [ ] `releaseEvidenceVerdict(sealSha, records)` returning **`EXACT_SHA_GREEN`**.
