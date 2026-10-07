# P4-S3 — the performance evidence, and the estimator behind it

This page records one change to the measurement method of the accepted
accounting budgets, the Tech Lead ruling that authorised it, and the findings
it produced. It changes no ceiling, no product code and no migration.

## What was wrong with the instrument

`tests/performance/accounting-budgets.test.ts` judges each budget by one
number: `p95` over the measured samples, against a ceiling. Budgets A (the
posting command inside an open transaction, 15 ms) and B (the manual-adjustment
endpoint end to end, 60 ms) were taking **thirty** measured iterations.

At n = 30 the percentile index is `min(n - 1, floor(0.95 · 30)) = 28`: the
**second-worst sample of the thirty**. A single stalled iteration was therefore
the verdict, in either direction — a lucky run passed and an unlucky one
failed, and neither outcome was about the product. On the pull-request runner
of `ee4322c` Budget A reported `p50 4.637 / p95 18.100` with ten of thirty
samples between 16.8 and 18.4 ms, while the push run of the **same commit**
was green on all six jobs.

## The ruling

The Tech Lead authorised exactly one change (2026-10-04, OPTION A): raise the
sample count of the two short percentile budgets to **200 measured
iterations**, and nothing else. Explicitly held fixed: the 15 ms and 60 ms
ceilings, `p95` as the percentile, the timing scope (COMMIT stays inside A,
the endpoint stays end-to-end in B), every sample counted, the same product
and the same dataset. Explicitly forbidden: raising a ceiling, `p95` → `p90`,
a trimmed percentile, winsorisation, deleting outliers or a top centile,
ignoring warm samples, retries inside the test, rerun-until-green,
cherry-picking a run, taking the green push run over the red pull-request run,
excluding COMMIT, `.skip` / `.todo` / `.only`.

The purpose was stated as improving the **estimator**, not the verdict: more
samples may show the ceiling is met, or show more firmly that it is not, and
both are evidence.

## The percentile, checked before anything relied on it

`tests/guards/accounting-budget-percentile-semantics.test.ts` is a new,
independent test of the index arithmetic, which now lives in
`tests/performance/percentile.ts` (moved unchanged so it could be asserted on
at all — it had no test of its own while it was deciding verdicts).

Its finding: `index = min(n - 1, floor(q · n))` over the ascending samples is
the **nearest-rank (inverse-CDF) percentile** whenever `q · n` is not a whole
number, and reads **one rank higher** — stricter, never looser — when it is.
It is not an arithmetic error, so the directive's STOP clause does not fire
and the method is left exactly as it was.

The positions are recorded rather than described:

| n | p50 | p95 | p99 |
| --- | --- | --- | --- |
| 30 | 15 | 28 (second-worst) | 29 (the maximum) |
| 100 | 50 | 95 | 99 |
| 200 | 100 | 190 (tenth-worst) | 198 |

The same file also recomputes the published red verdict from the published
samples, and measures what the prohibitions are worth: on that series `p90`,
a 5 % trim and the third quartile are all still above 15 ms. The failure was
not an outlier — a third of the iterations were slow — which is why no
softening was available even if one had been allowed.

## The diagnostics

For A and B the whole distribution is now computed and both printed and
recorded: iterations, min, p50, p95, p99, max, the complete ordered series,
the counts either side of the ceiling, the slow-to-fast ratios, the runner
event type (`push`, `pull_request` or `local`), the workflow run id, CPU
count, load average, process uptime and free memory. It is written into
`release/phase2-s8-performance-tier{1,2}.json` under `distributions`, and it
is carried in the assertion message, which is the one channel that is always
printed on the run that matters.

**Diagnostic data never changes the verdict.** No sample is excluded because
a host metric looked bad; `p95` is still taken over all of them.

## Scope of the change

- `tests/performance/accounting-budgets.test.ts` — sample count of A and B,
  and the diagnostic reporting.
- `tests/performance/percentile.ts` — the index arithmetic, moved unchanged.
- `tests/guards/accounting-budget-percentile-semantics.test.ts` — new.
- `docs/plan-evidence/plan-claim-inventory.json` — regenerated (line numbers).
- this page.

Nothing else: no product code, no accounting or POS implementation, no
permissions or RLS, no migration (`0079` is untouched and the freeze mechanics
written for the S3 seal stand), and no threshold.
