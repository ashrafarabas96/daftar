# P4-D's fat-tail-over-median ratio — remedy options, measured, **no decision taken**

**Status: OPTIONS FOR THE OWNER. Nothing here is decided, nothing is
implemented, and no limit is changed by this document.** The constant
`BALANCE_FATTAIL_OVER_MEDIAN.max = 3` is untouched, and `OD-P4-14` keeps it
calibration-derived and tighten-only: it may never be raised to obtain a pass.

The subject is one case in
`tests/performance/receivables-s4-budgets.test.ts`:

```
RATIO (host-independent, P4-AL-72): p95(fat-tail) <= 3 x p95(median)
```

## 1. What the gate judges today, read from the code

| | |
|---|---|
| Numerator | `p95` of the WALL-CLOCK series of `GET /v1/customers/{id}/receivable` for the fat-tail customer, 2 000 open invoices, 200 measured iterations |
| Denominator | `p95` of the WALL-CLOCK series of the SAME route for a median customer, 3 open invoices, 200 iterations |
| Limit | 3, provisional: no |

The ceiling case of the same budget was converted to the in-database clock by
DR-98 (`assertInDatabaseWithin`), **but this ratio was not**: it reads
`fat.samplesMs` and `med.samplesMs`. Measured on three revisions — this
branch's base, `origin/main` (`4c878e0f`) and `9eb26bec` (after #48) — the
string `'in-database'` occurs three times in the file and **exactly one call
site passes it**: the `P4-D` reads loop, i.e. the numerator. The denominator is
measured with five arguments and therefore carries no in-database series, which
the code states in place:

> the median and the two RLS halves below are not budgets — they are the
> denominators of host-independent ratios — and stay on the wall clock on both
> sides of their ratio

So **the denominator's in-database time has never been measured**, in any run.

## 2. The measurements — eight backend runs

Every row is read from that run's own `backend` job log: the `RATIO — P4-D
fat-tail over median` line for the two `p95` figures, the
`P4-S4-MONITOR-D-RECEIVABLE` line for the numerator's in-database and residual
figures, and the median arm's own `DISTRIBUTION` block for its `p50`. The
positive control for each row is that the monitor line and the median
distribution block are both present; the two shortest logs are at the ~32 MB
truncation boundary, which is why absence is never read as a zero here.

| Run | Head | wall p95 fat | wall p95 median | **wall ratio** | in-db p95 fat | residual p50 | median p50 | wall p50 fat |
|---|---|---|---|---|---|---|---|---|
| `42501714040` att 3 | `e58d465b` | 16.257 | 4.696 | **3.462 FAIL** | 10.197 | 4.958 | 4.255 | 14.591 |
| `42818676678` | `a7d3ec5f` | 27.380 | 9.103 | **3.008 FAIL** | 17.119 | 7.876 | 7.875 | 23.458 |
| `42721062044` att 1 | `57fbc5b6` | 24.216 | 8.422 | 2.875 | 15.974 | 7.642 | 7.633 | 23.014 |
| `42862295659` | `f379eeda` | 25.206 | 9.154 | 2.754 | 16.163 | 7.872 | 7.981 | 23.371 |
| `42817846240` | `9eb26bec` (main) | 22.927 | 8.848 | 2.591 | 14.811 | 7.509 | 7.561 | 21.847 |
| `42840906664` | `b1c9121f` | 24.704 | 9.544 | 2.588 | 16.109 | 7.812 | 8.854 | 23.373 |
| `42721062044` att 2 | `57fbc5b6` | 18.967 | 7.332 | 2.587 | 12.391 | 6.083 | 5.777 | 18.266 |
| `42721062044` att 3 | `57fbc5b6` | 24.504 | 9.614 | 2.549 | 15.994 | 8.127 | 8.796 | 23.383 |

Three of those rows are the same commit, `57fbc5b6`, measured three times with
no change to the tree: **2.875 / 2.587 / 2.549**, a spread of **0.326**. The
widest passing reading in the eight is 2.875, so the margin to the limit is
**0.125, which is 4.2 %**. All eight ran on a four-CPU runner with
`serverVersionNum = 160015`, so the spread is not a change of runner
generation.

The two failures are not one phenomenon. `e58d465b` has the **smallest
denominator of the eight** (4.696 ms, 36 % below the next) and also the
smallest numerator, on the lightest-loaded runner (`loadAverage[0] = 0.24`
against 0.42–0.70 elsewhere). `a7d3ec5f` has the **largest numerator of the
eight** (27.380 ms) at an ordinary load of 0.42. A story about a faster runner
raising the quotient fits the first and does not fit the second.

## 3. Option A — judge the ratio on the in-database clock, with the constant re-anchored

Convert both arms to `inDatabaseMs`, as DR-98 did for this budget's ceiling,
and derive a new constant from the measured distribution of the converted
quantity.

**Why the conversion cannot be done alone.** Both arms carry the same constant
per-request cost `c` — the HTTP envelope and response serialisation — and for
`a > b > c > 0`,

```
(a − c) / (b − c)  >  a / b
```

so removing a shared constant from both sides of a quotient above 1 **raises
it**, and raises it most when the denominator is small. The numerator's
residual is measured above at 4.958–8.127 ms while the denominator's whole wall
`p95` is 4.696–9.614 ms. A conversion that left the constant at 3 would
therefore turn a sound law red for a reason that is not a regression — which is
how a law gets disabled.

**What this option is NOT able to supply today, stated plainly.** The new
constant cannot be anchored from the eight runs, because the denominator's
in-database series does not exist in any of them. What the eight runs do give
is:

- a **valid measured lower bound**: the in-database quotient exceeds the wall
  quotient in every run by the inequality above, so it is **> 2.549** in all
  eight and **> 3.0** in the two that failed;
- an **estimate, named an estimate**, obtained by subtracting the numerator's
  residual `p50` from the denominator's wall `p95` — an assumption that the two
  arms pay the same constant: **9.30, 9.92, 10.76, 11.06, 12.61, 13.95, 20.48**
  for seven runs, and for `e58d465b` a **negative denominator (−0.262)**, i.e.
  an arithmetically impossible result. Percentiles are not additive, so this
  subtraction is unsound, and the one impossible row is the proof of that
  rather than an outlier to discard.

So Option A is a **two-stage** job: first a print-only change that measures the
denominator in-database and prints both arms every run, judging nothing; then,
after at least five runs, the owner sets the constant from the measured
distribution. The second stage is a **re-anchoring of a different quantity**,
not a relaxation of this one, and it needs the owner to say so explicitly,
because the number will be far above 3 while `OD-P4-14` forbids raising this
constant.

Cost of the first stage: one argument on the denominator's `measure` call, one
monitor line, a numerator-only delay knob and two negative-control steps in the
pattern of the existing steps 54 and 55, a `-t` filter measured to match
exactly one `it`, and a non-empty control on each. No limit moves.

## 4. Option B — judge work done, not time spent

Replace the time quotient with a **work** quotient taken from
`EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)` on the two arms' own
captured statements: shared blocks hit plus read, and actual rows and loops.

A block is a block on any runner, so this measure is host-independent by
construction rather than by hoping a quotient cancels the host out. The
machinery already exists: `plansOf(path)` runs `EXPLAIN (FORMAT JSON)` through
`db.scoped` as `daftar_app` with the request's own GUCs and parameters, so the
change is the plan options, not a new query.

**Numbers available today: none.** No run has recorded `ANALYZE`/`BUFFERS` for
these two statements, and they cannot be produced on the development machine:
this repository's performance suites require a PostgreSQL that the machine does
not host, and local PG18/`C` readings are not accepted as plan evidence for the
deployed PG16/`en_US.utf8` side.

**The honest limit of this option.** A buffers ratio can stay flat while time
blows up, because `invoice_outstanding` is a `plpgsql` `STABLE` function that is
never inlined: a regression in how often it is called is CPU, not blocks. So
work is the right measure of **growth**, and it must be **added** to a time
budget rather than replace one.

## 5. Option C — keep the wall clock and the limit 3, change the statistic to `p50/p50`

This is the only option whose numbers exist already, and **the measurement
refutes it**, which is why it is written down rather than proposed.

| Run | Head | `p50` fat | `p50` median | **`p50` ratio** |
|---|---|---|---|---|
| `42501714040` att 3 | `e58d465b` | 14.591 | 4.255 | **3.429** |
| `42721062044` att 2 | `57fbc5b6` | 18.266 | 5.777 | **3.162** |
| `42721062044` att 1 | `57fbc5b6` | 23.014 | 7.633 | **3.015** |
| `42818676678` | `a7d3ec5f` | 23.458 | 7.875 | 2.979 |
| `42862295659` | `f379eeda` | 23.371 | 7.981 | 2.928 |
| `42817846240` | `9eb26bec` | 21.847 | 7.561 | 2.889 |
| `42721062044` att 3 | `57fbc5b6` | 23.383 | 8.796 | 2.658 |
| `42840906664` | `b1c9121f` | 23.373 | 8.854 | 2.640 |

Three of the eight exceed 3, against two for the `p95` form, and on the one
commit measured three times the spread is **0.504** against **0.326** for
`p95`. The median statistic is therefore **noisier here, not calmer**, and
adopting it would redden a run that passes today. Option C is rejected on
measurement.

## 6. What is forbidden in every option

Raising `BALANCE_FATTAIL_OVER_MEDIAN.max`, a timeout, `retry`, `skip`,
`continue-on-error`, discarding an outlier after measuring it, and changing the
definition of `p95`. A run that this ratio reddens still has 17 or 18 later
steps skipped, **including the negative controls**, so such a run carries no
verdict for those controls and is never read as a green for them.

## 7. Open question for the owner

Which option is to be designed into a PR: A's first stage (measure the
denominator in-database, judging nothing), B's first stage (record
`ANALYZE`/`BUFFERS` for the two arms, judging nothing), both, or neither.
Nothing proceeds before that answer.
