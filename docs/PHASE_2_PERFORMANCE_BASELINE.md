# DAFTAR — Phase 2 Performance Baseline / خط أساس الأداء للمرحلة الثانية

> **P2-S8 §31–§37.** Measured, not estimated. Re-run with `npm run perf:phase2:s8` (tier 1, the default) or `P2S8_PERF_TIER=2 npm run perf:phase2:s8` (the acceptance sizes §34 names — **LOCAL only**, never CI). Each run writes `release/phase2-s8-performance-tier<N>.json`, and that file — not this page — is the evidence `npm run evidence:phase2:s8` reads.
>
> **ما هذه الوثيقة.** أرقام أداء مقيسة فعليًا للمرحلة الثانية، مع الآلة التي قيست عليها وحجم البيانات وطريقة القياس. الغرض منها شيئان: أن يُقارَن بها أي تراجع لاحق، وأن تُسجَّل فيها الميزانيتان اللتان لم تُستوفيا أول مرة وما الذي كشفه تشخيصهما. §34 يمنع توسيع أي ميزانية للحصول على نجاح، ولم تُوسَّع أي واحدة.

## 1. The budgets (§34, copied unchanged)

| # | What is measured | Ceiling |
|---|---|---:|
| A | `post()` of a 2–6 line entry, inside an existing transaction | p95 ≤ 15 ms |
| B | the manual-adjustment endpoint, end to end over HTTP | p95 ≤ 60 ms |
| C | whole-business trial balance, 100 000 journal lines, one period | p95 ≤ 500 ms |
| D | general ledger, one 50-row keyset page, 100 000 lines | p95 ≤ 150 ms |
| E | account balance as-of, a 100 000-line-class business | p95 ≤ 100 ms |
| F | one full reconciliation pass over 1 000 000 journal lines, one business | total ≤ 300 s |

The budgets live as named constants at the top of `tests/performance/accounting-budgets.test.ts`, one per section letter, so that raising one would show up in a diff as a changed number rather than as a changed expectation.

## 2. Two tiers (§35), and what each one is worth

**Tier 1** runs against a smaller dataset shaped like the real thing and asserts **the same ceilings**. That is a deliberately weaker claim: less data under the same budget. Its job is to catch an order-of-magnitude regression on every push, cheaply.

**Tier 2** is the acceptance run at the sizes §34 names. It is selected with `P2S8_PERF_TIER=2` and is **LOCAL, not CI** — a shared CI runner cannot produce a defensible millisecond figure, and a budget asserted on a contended host is a coin toss dressed up as evidence.

The evidence file records `tier` and `executedIn` beside every number, so no reader has to guess which claim they are looking at. `phase2-s8-evidence.ts` refuses to score a file that carries fewer measurements than the tier declares: a partial run is a partial run, not a pass.

`الطبقة الأولى تقيس على بيانات أصغر بنفس السقوف — ادّعاء أضعف عن قصد، غرضه كشف التراجع الكبير على كل دفعة. الطبقة الثانية هي قياس القبول بالأحجام الحقيقية، وتُشغَّل محليًا لا على CI، لأن آلة مشتركة لا تنتج رقمًا بالمللي ثانية يمكن الدفاع عنه.`

## 3. Measurement discipline (§33)

- Every case **warms up** (5 iterations, discarded) and then takes **30 measured iterations** at tier 1, 60 at tier 2.
- The reported figure is **p95**, alongside p50/p99/max/min. One lucky timing is not a measurement.
- The dataset is generated from a **fixed seed** (`tests/performance/accounting-dataset.ts`), so two runs on the same machine compare like with like.
- The machine, the Node and PostgreSQL versions, and the database settings that actually move these numbers (`shared_buffers`, `work_mem`, `effective_cache_size`) are captured into the evidence file beside the results. **A millisecond figure with no machine attached is not evidence of anything.**
- Nothing else runs on the box during a measured run. This was learned the hard way: an earlier run taken while a TypeScript build was competing for the same four cores produced numbers that were wrong in both directions, and the partial file it left behind was deleted rather than reported.

## 4. Tier 1 — the recorded run

**Machine.** 4 × Intel Xeon @ 2.80 GHz, 16 GB RAM, Linux 6.18. Node v22.22.2, npm 10.9.7, PostgreSQL 18.4 (embedded), `shared_buffers` 128 MB, `work_mem` 4 MB, `effective_cache_size` 4 GB, `max_parallel_workers_per_gather` 2, `jit` on.

**Dataset.** Seed `20260923`, one business, 6 000 entries, 2–6 lines each, 20 accounts, 35% of lines carrying a branch, spread over 730 days ending 2026-09-23, currency mix 90% ILS / 8% USD / 2% EUR — **21 614 journal lines**, asserted balanced and FX-complete by the suite itself before any timing is taken.

**Results — 30 measured iterations per case (F: one full pass).**

The recorded run is at `cd8a3047c2cbd56d0315d2eecdf6ddb903933af7`. A second, independent run of the same code on the same box is quoted beside it, because one run of a timing is an anecdote.

| # | case | p50 | **p95** | p99 | max | ceiling | verdict | p95, repeat run |
|---|---|---:|---:|---:|---:|---:|---|---:|
| A | `post()` in an open transaction | 8.8 | **11.2** | 14.7 | 14.7 | 15 ms | **PASS** | 13.0 |
| B | manual-adjustment endpoint, end to end | 19.5 | **24.6** | 27.7 | 27.7 | 60 ms | **PASS** | 28.2 |
| C | whole-business trial balance | 464.8 | **504.5** | 534.3 | 534.3 | 500 ms | **FAIL — §5.2** | 524.0 |
| D | 50-row general-ledger page | 51.2 | **63.9** | 76.8 | 76.8 | 150 ms | **PASS** | 75.0 |
| E | account balance as-of | 42.3 | **49.7** | 67.2 | 67.2 | 100 ms | **PASS** (was 488.6 — §5.1) | 55.8 |
| F | one full reconciliation pass (total) | — | — | — | **1 863.2** | 300 000 ms | **PASS** | 3 877.6 |

**C misses in both runs, and by a margin that moves** — 504.5 ms and 524.0 ms against a 500 ms ceiling. Read the margin and the miss separately: the margin is a few per cent and varies run to run, as a millisecond figure on a four-core container does; the miss is in both runs, and §5.2 shows it is a property of the query's plan rather than of the host's mood. The number that should worry a reader is not the 4.5 ms of overshoot — it is that a trial balance over **21 614** lines sits on a ceiling written for **100 000**.

F is the honest weak claim in this table: 1.9 s (3.9 s in the repeat run) is a full pass over **21 614** lines, not the 1 000 000 that §34 names. It says the pass is not accidentally quadratic; it does not say the 300 s budget is met at scale. Only the tier-2 run says that.

`الملخّص: خمس ميزانيات من ست ضمن السقف على الطبقة الأولى. الميزانية C — ميزان المراجعة — تجاوزت السقف بنحو ٥٪، والسبب مُشخَّص في البند ٥.٢ وهو ليس ضجيج قياس.`

## 5. The two budgets that missed, and what diagnosing them found

§36 is explicit: a missed budget is a **FAIL until diagnosed**, and the diagnosis — not the number — decides what happens next. Both misses were diagnosed by reading actual plans under the actual principal (`daftar_app`, with the scope GUCs set exactly as a request sets them), never by reasoning about the SQL.

### 5.1 E — balance as-of: a restriction applied too late (FIXED, application-level)

**Symptom.** E measured **488.6 ms** against a 100 ms ceiling — nearly five times over, for a query that asks for *one account's* balance.

**Cause.** `balanceTotals` put the account restriction in the outer query only:

```sql
FROM accounts a
LEFT JOIN ( SELECT l.account_id, sum(...) FROM journal_lines l JOIN journal_entries e ...
             WHERE l.business_id = $1 AND e.entry_date <= $2      -- every line in the business
             GROUP BY l.account_id ) t ON t.account_id = a.id
WHERE a.business_id = $1 AND a.id = ANY($3)                        -- the restriction, after the fact
```

The subquery summed **every line in the business**; the `LEFT JOIN` then threw away all but the asked-for account. The answer was right, and the work was proportional to the business rather than to the question.

**Fix.** The same restriction inside the aggregate. It restricts the very column the `GROUP BY` keys on, so no surviving group's total can change — the fix is answer-preserving by construction, and the measurement confirmed it row for row.

| balance as-of, one account, 100 k-line class | p95 | shared blocks | identical rows |
|---|---:|---:|---|
| as shipped | 420.1 ms | 68 108 | — |
| restriction pushed into the aggregate | **29.3 ms** | **5 644** | yes |

End to end over HTTP the budget case went from **488.6 ms to 55.8 ms**, inside the 100 ms ceiling, with **no schema change and no new index**. The measurement is repeated in a comment beside the line in `accounting-reports.reader.ts`, because the line reads as redundant to anyone who has not seen the plan.

`السبب أن تقييد الحساب كان يُطبَّق خارج التجميع لا داخله، فتُجمَع سطور العمل كلها ثم يُرمى أغلبها. بنقل نفس الشرط إلى داخل الاستعلام المُجمِّع صار القياس ٥٥٫٨ مللي ثانية بدل ٤٨٨٫٦ بنفس النتائج تمامًا، دون أي تغيير في المخطَّط ودون فهرس جديد.`

### 5.2 C — trial balance: the RLS policy on `journal_lines` is evaluated per row (DIAGNOSED, NOT FIXED)

**Symptom.** C measured **504.5 ms** and, in an independent repeat, **524.0 ms**, against a 500 ms ceiling — a small miss of a size a reviewer is tempted to call noise, in both runs. One measurement settles whether it is noise, and it also shows why the small margin is the least interesting part: the query is **34× more expensive than it needs to be**, and it only *looks* borderline because tier 1 runs one fifth of the volume the ceiling was written for.

**The decisive measurement.** The same SQL, the same rows, the same box — run once as `daftar_app` under row level security, and once as a principal for whom `app_bypass()` is true, so the policy is never evaluated:

| the identical trial-balance query | p50 | p95 | shared blocks | join shape |
|---|---:|---:|---:|---|
| **with RLS** (`daftar_app`) | 437.7 ms | 489.3 ms | **67 866** | Nested Loop + Nested Loop |
| **without RLS** (policy not evaluated) | **12.9 ms** | **15.1 ms** | **724** | Nested Loop + Hash Join |

**34× the time and 94× the blocks, from the policy alone.** The plan says why:

- On `journal_entries`, the permissive `tenant_membership` policy is planned **once** and reused — `ANY (business_id = (hashed SubPlan 6).col1)`.
- On `journal_lines`, the *same* policy is planned as a **correlated `EXISTS(SubPlan 3)`, evaluated per row** — `Filter: (app_bypass() OR EXISTS(SubPlan 3) OR ...)`.
- With that filter in the way the planner estimates **1 119** rows where **21 684** are returned — 19× under — and on that estimate it chooses a nested loop into `journal_entries` with **6 035** loops.

**Four query-level rewrites, all measured, none of them a fix** (each returned byte-identical rows):

| rewrite | p50 | p95 | shared blocks | join shape |
|---|---:|---:|---:|---|
| as shipped | 437.7 | 489.3 | 67 866 | Nested Loop + Nested Loop |
| entries pre-materialised in a `MATERIALIZED` CTE | 449.8 | 479.8 | 67 866 | Nested Loop + Nested Loop |
| explicit `tenant_id` predicate on both sides | 477.1 | 549.5 | 67 866 | Nested Loop + Nested Loop |
| lines-only aggregate, dates via `IN (SELECT … FROM journal_entries …)` | 452.1 | 570.6 | 67 866 | Nested Loop + Nested Loop |
| *(reference only)* `enable_nestloop = off` | 230.1 | 257.4 | 12 646 | Merge Join + Merge Join |

Also ruled out by measurement: stale statistics (present; an explicit `ANALYZE` changes nothing).

The block count is the tell — every rewrite reads exactly **67 866** blocks, because they all change the join and none of them changes what the policy costs per row. Even the planner-knob reference still reads 17× the no-RLS figure, so the join order is a symptom and the per-row policy evaluation is the cause. And `enable_nestloop` is a session knob: shipping one to make a financial report meet its budget hides a defect rather than repairing it.

**The repair is to the shape of the policy on `journal_lines`**, so the planner can hash it once as it already does on `journal_entries`. That policy lives in a **frozen** migration: `0000`–`0050` are byte-immutable, and the one migration this slice may add (`0051`) is restricted to the reconciler authority. The repair therefore cannot be made inside P2-S8 without breaking one of the two rules that exist to prevent exactly this kind of drive-by change.

**Per §36 this is reported, not fixed: the performance evidence justifies a schema change, and authorising that change is the Tech Lead's decision.** It is carried into `TECHNICAL_DEBT.md` so it cannot be lost.

`القياس الحاسم: نفس الاستعلام على نفس الصفوف، مرّة بعزل الصفوف ومرّة بمبدأ يتجاوزه — ٤٣٧ مللي ثانية و٦٧٬٨٦٦ كتلة مقابل ١٢٫٩ مللي ثانية و٧٢٤ كتلة. السبب أن سياسة العزل على جدول سطور القيود تُقيَّم لكل صف، بينما نفس السياسة على جدول القيود تُخطَّط مرّة واحدة. جُرِّبت أربع صياغات بديلة للاستعلام، كلها بنفس النتائج وبنفس عدد الكتل تمامًا: لا إصلاح على مستوى الاستعلام. الإصلاح في شكل السياسة نفسها، وهي داخل ترحيل مجمَّد. لذلك تُرفَع المسألة قرارًا للقائد التقني.`

## 6. What this page does NOT claim

- **No tier-2 acceptance run is recorded here.** Until `release/phase2-s8-performance-tier2.json` exists, nothing on this page is a claim about 100 000 or 1 000 000 lines.
- **No multi-instance, multi-tenant or network-latency measurement.** One process, one local database, one business.
- **No claim that these milliseconds transfer to production hardware.** Compare **ordering and ratios** first — C is the most expensive read by an order of magnitude, D and E are tens of milliseconds, A and B are single- to low-double-digit — and re-measure on a quiet host before calling any absolute number a regression.

`ما لا تدّعيه هذه الوثيقة: لا قياس على أحجام القبول الكاملة، ولا قياس متعدّد النُسخ أو عبر الشبكة، ولا نقل لهذه الأرقام إلى عتاد الإنتاج. قارِن الترتيب والنِّسب أولًا، وأعد القياس على آلة هادئة قبل اعتبار أي رقم تراجعًا.`
