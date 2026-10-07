# PATCH-REQ-S8-005 — the integrated `gate:phase4:s8` and its CI wiring

| | |
|---|---|
| raised by | P4-S8 |
| base SHA | `6587460ba3632231e4324c5ce2af92e1589d0705` |
| target files | `scripts/phase4-s8-gate.ts` (new), `package.json`, `.github/workflows/ci.yml` |
| owner | the gate owner / the CI owner (the coordinator) |
| check waiting on it | `release-gate-composed` (via its `gate:phase4:s8` subject) |
| blocked until | S5, S6 and S7 seal |

## Required change, in this order and not before the dependency

1. `scripts/phase4-s8-gate.ts` — composes `gate:phase4:s7` VERBATIM and
   INTERNALLY, then runs the S8 framework (`scripts/phase4-s8/run.ts`), the
   reconciliation rosters, the deadlock matrix, the browser matrix, the
   Tier-1 budgets on their own `PG_DIR`, and the two scenarios.
2. `package.json`: `"gate:phase4:s8": "tsx scripts/phase4-s8-gate.ts"`.
3. `.github/workflows/ci.yml`: a visible step of the `backend` job.

## Why S8 shipped a runner and not the gate

A gate wired while **red by design** can never show a real regression
appearing: the slice's own owner reads past the red, and so does everyone else.
`npx tsx scripts/phase4-s8/run.ts` is therefore a runner with no npm alias, and
its one-line verdict says `FRAMEWORK_READY (NOT A PASS OF THE INVARIANTS)`
whenever any check is WAITING, so a green exit from it can never be quoted as
the invariants holding. Five S8 checks are WAITING today and three FAIL.

## The two things the gate must do that the runner cannot

- **Prove the runner can report failure.** `[[daftar-a-green-gate-must-prove-it-can-be-red]]`,
  and concretely: DAFTAR's test runner once exited 0 over four failing tests and
  hid them. So the gate's FIRST step is the runner canary, asked OUTSIDE
  Vitest, and `exitStatusProofProblems` (`scripts/phase4-s8/verdict.ts`) is the
  value that must be produced before any exit status in the run is readable.
- **Run the executed halves.** `deadlock-matrix-execution`,
  `lifecycle-scenario-execution` and `isolation-scenario-execution` are
  WAITING because they need a cluster and the predecessor relations. The plans
  exist now (42 ordered pairs over 21 unordered, both directions, deterministic
  barriers and no probabilistic sleeps; 14 lifecycle stages; 7 isolation steps
  across two arms); the executions are the gate's.

## A constraint on the CI step

Record this where the gate is wired: `npm test` is a step of the `backend` job
**ahead of** the first database step, and it runs five workspace unit trees
(`packages/{domain-core,accounting,shared-contracts,inventory}/test` and
`apps/web/test`) that no `tests/**` run and no slice gate reaches. Its failure
therefore skips the integration tests, the goldens and every gate.
`unitTreeReachProblems` asserts that ordering, so if it ever changes the
consequence documented here stops being true and the check says so.

## Expected semantic diff

| | before | after |
|---|---|---|
| `npm run gate:phase4:s8` | missing script | the integrated gate |
| the `backend` job | no S8 step | a visible S8 step |
| `release-gate-composed` | WAITING on two npm scripts | WAITING on one, then evaluates |
