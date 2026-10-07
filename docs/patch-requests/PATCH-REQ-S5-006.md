# PATCH-REQ-S5-006 — the CI chain row, the gate script and the plan-evidence wiring for `gate:phase4:s5`

| field | value |
|---|---|
| requested by | P4-S5 owner |
| base of record | `phase/4-sales-pos-customers-receivables` @ `6587460` |
| target files | `tests/guards/required-ci-chain-composition.test.ts` (the `CHAIN` table, `:118-124`), `.github/workflows/ci.yml`, `package.json` (the `gate:phase4:s5` script), `scripts/phase4-s5-gate.ts` (new) |
| owner of target | `.github/workflows/**`, `scripts/phase4-s*-gate.ts` and the existing S4-owned suites are all shared, high-risk areas |
| depends on | S4 sealing, because the pairwise ordering the chain asserts must put S5 after S4 |
| blocks | the integrated S5 gate (level G). Nothing at levels A–E |

## Required change

**(a) `tests/guards/required-ci-chain-composition.test.ts:118-124`.** `CHAIN` is a table of
four rows and the suite states in its own words that *"adding a slice to this table is the whole
edit"*. Add the S5 row. **The job step `name` is part of the claim**, so the row's name string
must match the workflow step's exactly, and the pairwise ordering must place S5 after S4.

**(b) `.github/workflows/ci.yml`.** Add the `gate:phase4:s5` step to the required backend job,
after the S4 step.

**(c) `package.json`.** `"gate:phase4:s5": "tsx scripts/phase4-s5-gate.ts"`.

**(d) `scripts/phase4-s5-gate.ts`.** The gate itself, in the shape the four before it share:
exported devices, one `ok`/`FAIL` line per check, a roster of red proofs it requires to exist,
and a `--structural-only` mode. Its structure is specified in
`docs/PHASE_4_S5_CONTRACT_PACK.md` §11.

**(e) the budget ratchet.** `npm run check:budget-ratchet`
(`scripts/phase4-budget-ratchet.ts`, law at `tests/guards/p4s4-budget-ratchet-law.test.ts`) — a
new command path needs its MEASURED budget, tighten-only. The three S5 command paths and the two
page reads each get one, measured and not estimated.

## Reason

`tests/performance/plan-evidence-contract.test.ts:247` requires every plan-gate file to be
reachable from a step of the required backend job, and `:158` refuses a stale committed
inventory. **So declaring `gate:phase4:s5` in `package.json` WITHOUT the workflow wiring makes
that suite red** — which is why (b) and (c) are one request and not two, and why neither may
land alone.

## Why S5 does not make the change itself

Every target is a shared, high-risk area the operating directive names: the workflow files, the
gate scripts, and an existing suite that belongs to S4. A parallel-development slice editing the
required CI job is how a green main becomes a red one for every other agent at once.

## The test that requires it

- `tests/guards/required-ci-chain-composition.test.ts` itself, which is the law that (a)
  satisfies;
- `tests/performance/plan-evidence-contract.test.ts:158` and `:247`, which are the laws that
  make (b)+(c) inseparable;
- `tests/guards/p4s4-budget-ratchet-law.test.ts`, for (e).

## Expected semantic diff

- `CHAIN` goes from four rows to five, and the pairwise-ordering assertion gains one pair;
- the required backend job gains one step, and the plan-evidence reachability set gains the S5
  gate file;
- `npm run check:budget-ratchet` gains five measured budgets and loosens none. A ratchet that
  loosened an existing budget to admit S5 would be the opposite of this patch.

## What this patch must NOT do

- it must not touch any assertion of the S4 rows, or reorder them;
- it must not relax `plan-evidence-contract`'s reachability rule to admit an unwired gate;
- it must not add an S5 budget by estimate. Tighten-only means measured-only.
