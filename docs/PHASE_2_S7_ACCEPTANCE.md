# DAFTAR — P2-S7 Acceptance / قبول الشريحة السابعة من المرحلة الثانية

> **What this is.** The evidence page for slice **P2-S7 — financial reads**, **ACCEPTED and FROZEN**. It states what is enforced by a mechanism and covered by a test, and, just as deliberately, what is not.
>
> **ما هذه الوثيقة.** سجل أدلة الشريحة P2-S7 وهي **مقبولة ومجمَّدة**. العمود الحاسم هو الحالة: **ENFORCED** يعني أن قاعدة البيانات أو الـCI ترفض المخالفة اليوم ويوجد اختبار يثبت ذلك. تبني هذه الشريحة القراءات المالية: ميزان المراجعة، دفتر الأستاذ العام، أرصدة الحسابات، وقوائم القيود. لا تكتب هذه الشريحة أي شيء في الدفاتر، ولا تخزّن أي رصيد، ولا تنشئ أي مجال أعمال جديد.

## 0. The one sentence that matters

**Every figure DAFTAR reports is aggregated from `journal_entries` and `journal_lines` at the moment it is asked for; nothing is stored, cached or materialized, so there is never a second number that can disagree with the ledger.**

That is AL-15, and it is the decision the whole slice is built around. The alternative — a `balance` column, a rollup table, a refreshed view — is faster and is what most systems do, and its failure mode is the one a merchant cannot recover from: the stored number drifts from the journal, both are presented as authoritative, and nothing in the system says which one lied. A report that is slow can be measured and indexed, and this slice does exactly that (§11 below). A report that is wrong has already been believed.

Two consequences follow, and both are enforced rather than merely intended:

- **A GET is a GET.** No report writes a row, a timestamp, a cache entry or a repair. There is no lazy backfill and no reconciliation triggered by reading.
- **History is rendered as it was posted.** The exchange rate frozen on a line is the only rate a report may show; a deactivated account keeps every entry it ever carried; a reversed entry and its reversal are both visible, because a correction in DAFTAR is another journal entry and never an erasure.

`كل رقم تعرضه «دفتر» محسوب لحظة السؤال من قيود اليومية نفسها. لا رصيد مخزَّن، ولا ذاكرة مؤقتة، ولا جدول مُلخَّص — حتى لا يوجد أبدًا رقمان يختلفان ولا أحد يعرف أيّهما الصحيح. والقراءة قراءة فقط: لا تكتب التقارير شيئًا، ولا تعيد حساب سعر صرف قديم، ولا تخفي حسابًا أُغلق أو قيدًا عُكِس.`

## 1. Migration — status

| migration | SHA-256 | state |
|---|---|---|
| `0050_accounting_report_indexes.sql` | `ef20a42788c503317c1e4b9bb69ada47e547faf42330bb1bc0d8e0a2f4c18356` | **ACCEPTED and FROZEN** |

`MIGRATION_MANIFEST.json` records **51 frozen migrations** with `frozenThrough = 0050_accounting_report_indexes.sql`. The Tech Lead accepted P2-S7 at head `39a7503277a315c559291c15c34b66a4f4fab301`, exact-SHA workflow **35874918898**, all five jobs SUCCESS; `0050` was frozen at that acceptance, at the digest above. Its bytes are unchanged — freezing is a statement about them, not an edit to them. `gate:phase2:s7` is now a **permanent** regression gate carrying that digest as its own independent second source, and it no longer has any opinion about whether a later authorized migration exists.

`قَبِل القائد التقني الشريحة P2-S7، وجُمِّد الترحيل 0050 بالبصمة نفسها التي قُبِل بها. السجل يحمل الآن 51 ترحيلًا مجمَّدًا، وبوّابة الشريحة صارت دائمة تحمل البصمة المقبولة كمصدر ثانٍ مستقل.`

- Branch: `phase/2-accounting-core` · Draft PR: **#2** (stays draft for all of Phase 2)
- Starting accepted head (P2-S6): `74162f04bb5c54a918bd42441f871c1e8a05377c`, exact-SHA workflow **35852844774**, all five jobs SUCCESS
- P2-S6 freeze commit (Stage A of this directive): `1a2e3077665eda951f76592f33fe59f8f320ae8a`, exact-SHA workflow **35857478131**, all five jobs SUCCESS

**Evidence law.** CI SUCCESS is reported for a commit only when GitHub shows a workflow run whose head SHA is that exact commit.

## 2. Status legend

| status | meaning |
|---|---|
| **ENFORCED** | a mechanism in this repository refuses the violation today, and a named test exercises it |
| **SPECIFIED** | written in a binding document; nothing in code or tests enforces it |

## 3. What the slice added

| what | where |
|---|---|
| the read arithmetic: normal balance, presentation net, opening/running/closing walk, the whole-business balance assertion, the cursor codec | `packages/accounting/src/reports.ts` |
| the SELECT surface it runs on, as the caller under RLS | `apps/api/src/modules/accounting/accounting-reports.reader.ts` |
| authorization, branch scope, contract validation and the DTO mapping | `apps/api/src/modules/accounting/accounting-reports.service.ts` |
| six read DTOs, every amount a decimal string | `packages/shared-contracts/src/index.ts` |
| six GET routes, each requiring `accounting.view` | `apps/api/src/modules/accounting/accounting.controller.ts` |
| two indexes, created only after the measurement asked for them | `infrastructure/database/migrations/0050_accounting_report_indexes.sql` |
| guard **G-6** — the read surface is read-only, pages by keyset, renders the frozen snapshot | `scripts/guards/read-surface.ts`, rule 19 of `scripts/static-guards.ts` |
| guard **G-3**, widened: the watched set is discovered from the schema instead of listed | `scripts/guards/no-authoritative-balance.ts` |
| the slice gate | `scripts/phase2-s7-gate.ts`, `npm run gate:phase2:s7` |

### The six routes (§18)

| route | answers |
|---|---|
| `GET /businesses/:businessId/accounting/accounts` | the chart, including deactivated accounts |
| `GET /businesses/:businessId/accounting/entries` | journal entries, keyset-paged by `(entry_date, id)` |
| `GET /businesses/:businessId/accounting/entries/:entryId` | one entry, whole or not at all, as it was posted |
| `GET /businesses/:businessId/accounting/trial-balance` | debit, credit and signed net per account, `asOf` **or** `from`/`to` |
| `GET /businesses/:businessId/accounting/ledger` | one account over an inclusive range, with a running balance |
| `GET /businesses/:businessId/accounting/balances` | signed balances as of an inclusive date |

None of them mutates anything. All six require `accounting.view`, checked on the route by the guard and again in the service, because those two answer different callers.

## 4. Enforced by this slice

| # | rule | mechanism | test | status |
|---|---|---|---|---|
| R-1 | the journal is the only financial truth; no stored, cached or materialized balance | G-3 (schema-wide), G-6, `gate:phase2:s7` | `accounting-guards.test.ts` | **ENFORCED** |
| R-2 | no report writes any accounting table | G-4 (repository-wide), G-6 (reporting modules) | `accounting-guards.test.ts` | **ENFORCED** |
| R-3 | a whole-business trial balance that does not balance is refused, not rendered | `AccountingReports.trialBalance` → `accounting.report_unbalanced` (409) | `accounting-report-unbalanced.test.ts` | **ENFORCED** |
| R-4 | a branch-filtered report is a DIMENSION and may legitimately not balance; it says so | `kind`, `isBalanced` on the report | `accounting-reports-authorization.test.ts` | **ENFORCED** |
| R-5 | the business-level (`branch_id IS NULL`) opening position never leaks into a branch report | `branch_id = ANY(...)` excludes NULL by SQL semantics | `accounting-reports-authorization.test.ts` | **ENFORCED** |
| R-6 | `accounting.view` is required on every read; `accounting.post` grants none | `@RequiresPermission` + `AccountingReportsService.authorize` | `accounting-reports-authorization.test.ts` | **ENFORCED** |
| R-7 | an assigned-scope member may not have an unfiltered business-wide aggregate | `AccountingReportsService.branchScope` | `accounting-reports-authorization.test.ts` | **ENFORCED** |
| R-8 | an entry reaches an assigned-scope member only if EVERY line is inside their allowance | `NOT EXISTS` visibility predicate + a second check on the detail | `accounting-reports-authorization.test.ts` | **ENFORCED** |
| R-9 | another business's ids are NOT FOUND, indistinguishably from invented ones | `business_id` in every predicate, RLS beneath, 404 mapping | `accounting-reports.test.ts`, `accounting-reports-authorization.test.ts` | **ENFORCED** |
| R-10 | pagination is keyset, never OFFSET; the cursor carries the complete ordering tuple | row-comparison predicate identical to the `ORDER BY` | `accounting-ledger-pagination.test.ts` | **ENFORCED** |
| R-11 | a malformed, foreign-shaped or oversized cursor is refused before it reaches a predicate | `decodeLedgerCursor` / `decodeEntryCursor` | `packages/accounting/test/reports.test.ts` | **ENFORCED** |
| R-12 | a ledger's opening figure is everything **strictly before** `from` | `entry_date < $from`, never `<=` | `accounting-reports.test.ts` | **ENFORCED** |
| R-13 | amounts are exact: `SUM(bigint)` → NUMERIC → decimal string → `bigint`, never `Number` | `exactMinor`, `::text`, G-6 | `accounting-reports.test.ts`, `reports.test.ts` | **ENFORCED** |
| R-14 | the normal-balance rule is stated once and covers all five account types | `normalBalanceOf` / `presentationNet` | `packages/accounting/test/reports.test.ts` | **ENFORCED** |
| R-15 | a rate entered today never changes a posting from last year | the report reads the line's own snapshot; G-6 forbids a current lookup | `accounting-reports.test.ts` | **ENFORCED** |
| R-16 | a deactivated account keeps its history everywhere | no historical query filters on `accounts.is_active`; G-6 | `accounting-reports.test.ts` | **ENFORCED** |
| R-17 | an original, its reversal and its replacement are all visible, and net to the current position | nothing is hidden by a later entry | `accounting-reports.test.ts` | **ENFORCED** |
| R-18 | no entry detail carries assertion material (fingerprint, jti, kid, HMAC) | `toEntryDetailDto`, `gate:phase2:s7` | `accounting-reports.test.ts` | **ENFORCED** |
| R-19 | `asOf` and `from`/`to` are mutually exclusive, and one is required | contract validation + `resolveTrialBalanceRange` | `accounting-reports.test.ts` | **ENFORCED** |
| R-20 | the page size is the server's decision, whatever the caller asks | `boundPage`, Zod bounds | `accounting-ledger-pagination.test.ts` | **ENFORCED** |
| R-21 | the reported figures equal an INDEPENDENT recomputation from the journal rows | a reference calculator sharing no code with the implementation | `accounting-reports.test.ts` | **ENFORCED** |
| R-22 | a report never runs as an elevated principal | the reader holds no SECURITY DEFINER call; `daftar_app` has SELECT only | `journal-privilege-matrix.test.ts` | **ENFORCED** |

## 5. The first architectural decision that needs stating — a branch is a dimension, not a second set of books

A branch-filtered trial balance **may not balance**, and DAFTAR reports it that way.

An entry whose debit sits in one branch and whose credit sits in another is a real and ordinary fact — stock moved, a payment was taken at one counter for a sale made at another. Filtering the journal to one branch splits that entry, and a split entry does not balance. There are exactly three things a system can do about it, and two of them are lies:

- **invent a branch clearing account**, so each side balances against a fiction nobody posted;
- **discard mixed entries**, so the columns agree and the merchant's revenue quietly shrinks;
- **say so** — which is what `kind: 'branch_dimension'` and `isBalanced: false` do.

The whole-business report is the one that must balance, and if it ever does not, it is **refused** (`accounting.report_unbalanced`, HTTP 409) rather than rendered, because a rendered unbalanced trial balance gets pasted into a tax return.

## 6. The second architectural decision that needs stating — `is_active` is about the future

`accounts.is_active` answers "may this account take a NEW posting?". It says nothing about the past, and no historical query filters on it.

A merchant who closes a seasonal stall deactivates its expense account. The 300.00 they spent on it last summer is still 300.00 they spent, and it is still in the trial balance, the general ledger, the balances list and the entry detail — with `isActive: false` beside it, so the reader can see both facts at once. A report that hid it would be telling the merchant their own history did not happen; the totals would shrink, the books would stop balancing, and nothing on the screen would say why.

## 7. The third architectural decision that needs stating — keyset pagination, and what it does and does not promise

Every list pages by a **keyset cursor** over its complete ordering tuple: `(entry_date, journal_entry_id, line_no)` for the ledger, `(entry_date, id)` for the entry list. The cursor is versioned (`glc/1`, `gec/1`), length-bounded, strictly parsed, and opaque to the client. It is never `OFFSET`, which reads and discards what it skips — so page N costs N pages — and which shifts every later page when a row lands mid-walk, meaning a ledger line the merchant never sees.

**What the consistency model actually is, stated plainly because the wrong claim here is worse than no claim:** the traversal is **append-stable**, not a snapshot. Walking a range while the merchant keeps posting is guaranteed never to repeat a row and never to skip one that existed when the walk began. A row appended during the walk **may** appear on a later page, because the pages are separate transactions and the journal is append-only. DAFTAR does not hold a snapshot across pages and does not claim to; `accounting-ledger-pagination.test.ts` proves exactly this property, with a real posting made between two real page requests.

## 8. What the arithmetic is made of, exactly

`SUM(bigint)` in PostgreSQL is **NUMERIC**, and that is not an accident of the driver: a single line is capped at 10<sup>18</sup> by `journal_lines_money_cap_ck`, but a cumulative total over a merchant's whole history is capped by nothing. So the aggregate stays NUMERIC in the database, crosses to JavaScript as an **exact decimal string**, and becomes a `bigint`. It is never cast back to `BIGINT` in SQL, and it never passes through a JavaScript `number`, which is exact only until the merchant is successful. `accounting-reports.test.ts` proves a cumulative total of `20000000000000000000` — past the range of a signed 64-bit integer — is reported exactly.

The normal direction of each account type is stated **once**, in `normalBalanceOf`: `asset` and `expense` are debit-normal, `liability`, `equity` and `revenue` are credit-normal. Signed nets are exact and may be negative — a contra account, an overdrawn bank, a refund-heavy revenue line — and are never clamped.

## 9. The authorization model, stated exactly

Two independent checks, in this order, on every one of the six routes:

1. **`accounting.view`**, and only `accounting.view`. It is not implied by `accounting.post`: the authority to create a financial fact through a source workflow is not the authority to read the business's books. The built-in `manager` and `cashier` roles hold neither.
2. **Phase 1 branch scope**, resolved from the membership and never from the query string. A member with `branch_scope_mode = 'all'` may read the whole business, and may ask for a branch as a dimensional filter. A member with `assigned` **must name a branch they hold** for any aggregate; a foreign, unassigned or invented branch id is refused identically, so the refusal does not say which it was. The entry LIST is the single exception, and only because the visibility predicate has already done the work: an entry reaches them only when **every** line is inside their allowance and no line carries the business-level NULL dimension.

An entry is **whole or invisible**. A journal rendered without some of its lines does not balance, and a reader who did not notice would be looking at a false document — so a partial entry is never returned; the entry is 404.

## 10. What this slice deliberately did NOT build

- no reconciliation job, alert worker or scheduled recompute (there is nothing to reconcile);
- no materialized view, rollup table, Redis balance or dashboard cache;
- no million-line performance dataset, latency budget, DR rehearsal or penetration suite — those are P2-S8's;
- no inventory, purchases, sales, POS, customer or supplier domain;
- no export, no PDF, no scheduled report delivery;
- no `0051`, and no freeze of `0050`.

## 11. The index decision, and the measurement it rests on

`0050` was **optional**, and the order was: build the reports against the schema `0049` froze, measure, and create a migration only if the evidence asks for one.

`tests/performance/accounting-read-plans.test.ts` seeds **4,000 entries / 8,000 lines across 21 accounts** — two years of a small merchant — and runs each read under `EXPLAIN (ANALYZE, BUFFERS)`.

**Before `0050`:**

| read | plan | execution |
|---|---|---|
| trial balance (whole history) | Seq Scan on `journal_lines`, Seq Scan on `journal_entries` | ~12.8 ms |
| ledger page (one account, first 50 rows) | Seq Scan on `journal_entries`, Seq Scan on `journal_lines` | ~3.7 ms |
| account balance as of a date | Seq Scan on `journal_entries`, Seq Scan on `journal_lines` | ~6.0 ms |

The middle row is what decided it. A merchant opening **one** account's ledger and asking for the **first fifty rows** caused PostgreSQL to read every line and every entry the business had ever posted, join them, sort the result and throw almost all of it away. That cost is not a constant a bigger server absorbs — it is proportional to the merchant's entire history, so the ledger gets slower every day the business trades.

**After `0050`:**

| read | plan | execution |
|---|---|---|
| trial balance (whole history) | aggregate over the whole journal, as it must be | ~25 ms |
| ledger page (one account, first 50 rows) | Index Scan using `journal_lines_business_account_idx` | ~1.2 ms |
| entry list keyset page | Index Only Scan using `journal_entries_business_date_idx` | ~0.1 ms |
| account balance as of a date | index-assisted | ~1.6 ms |

So `0050` creates exactly two indexes and nothing else:

- `journal_lines (business_id, account_id, journal_entry_id, line_no)` — reaches one account's lines without reading the others, and carries the tail of the ledger's ordering tuple;
- `journal_entries (business_id, entry_date, id)` — the entry list's keyset tuple and the date bound of every report.

**The trial balance got no index, deliberately.** It aggregates every line of the business by construction, so reading them all *is* the correct plan and no index changes that. An index added for it would be schema nobody could point at a reason for.

**This measurement is not the P2-S8 performance gate.** There is no latency budget here and no throughput target; the only question it answers is whether the planner can reach one account's lines without reading the whole journal.

## 11a. A defect found during this slice that is not about this slice — the runner could not always report failure

This was found while verifying the P2-S7 gate and it invalidates nothing less than the way every gate in this repository reaches a verdict, so it is recorded here rather than mentioned in passing.

**What was wrong.** `npx vitest run` could leave with status 0 while its own output said `Tests  10 failed`.

**Why.** `embedded-postgres` registers a graceful-shutdown hook at import time through `async-exit-hook`, and `async-exit-hook` subscribes to `beforeExit` with a hardcoded exit code of zero:

```
add.hookEvent('beforeExit', 0);                      // async-exit-hook/index.js
process.nextTick(process.exit.bind(null, code));     // code === 0
```

`beforeExit` fires when the event loop drains naturally. At that moment Vitest has already recorded its verdict the only way it can, by setting `process.exitCode = 1`, but has not yet reached its own exit path. An explicit argument to `process.exit` overwrites `process.exitCode`, so the 1 was erased.

The hook is registered on import, not on use, so it applied in CI as well, where a real PostgreSQL service is reached and no embedded cluster is ever started.

**Why it survived.** Which path ran first was a race between the shutdown hook and Vitest's own teardown, so the failure was reported some of the time and swallowed the rest. A defect that lies intermittently is worse than one that lies always, because the times it tells the truth are taken as proof that it can be trusted.

**What it meant.** Phase 1's gate, P2-S1 through P2-S7, `test:integration` and `test:golden` all decide PASS or FAIL from that exit status. A green verdict issued before this fix is not, by itself, evidence that the suites behind it passed.

**The fix** (`tests/helpers/exit-code.ts`) refuses exactly one transition: an explicit zero may not lower a non-zero `process.exitCode`. Nothing else changes — a clean run still exits 0, an explicit non-zero code is still honoured, and a caller may still raise the code. The direction is the point: the guard can only preserve a failure that was already recorded. It cannot create one and it cannot hide one. The shutdown hook itself is left in place, because reaping the cluster is wanted; only the hardcoded zero is made harmless.

**The evidence.** `tests/integration/runner-exit-code.test.ts` starts a real child `vitest run`, under a configuration identical to the root one except for which files it collects, and reads the status a shell would read: non-zero over `failing.fixture.ts`, zero over `passing.fixture.ts`.

That proof is circular in the one case that matters most — a runner that cannot report failure cannot report *that* failure either — so the P2-S7 gate makes the same check itself, in a process that is not Vitest, from the exit status directly, and makes it **first**: if the canary comes back 0, the gate refuses to run the regression matrix at all and says that no test result in the run is evidence.

`عيب وُجد أثناء هذه الشريحة ولا يخصّها وحدها: كان مشغّل الاختبارات قادرًا على الخروج بحالة نجاح رغم فشل اختبارات، لأن خطّاف إغلاق في embedded-postgres ينادي process.exit(0) فيمحو رمز الفشل الذي سجّله Vitest. وكل بوّابات المستودع تقرّر حكمها من حالة الخروج هذه. الإصلاح يمنع انتقالًا واحدًا فقط: الصفر لا يمحو فشلًا مُسجَّلًا. والبرهان يشغّل المشغّل نفسه على ملف فاشل عمدًا، وبوّابة P2-S7 تعيد البرهان من خارج Vitest قبل أن تصدّق أي نتيجة في تشغيلها.`

## 11a-bis. A correction to §11a — the first version of the guard had a hole in the path that mattered most

Recorded here rather than silently amended, because §11a is an evidence claim and it was incomplete.

The guard as first written forwarded every call as `native(code)`. That is wrong for a call made with no argument at all, and Node says why in its own source:

```
function exit(code) {
  if (arguments.length !== 0) { process.exitCode = code; }
  ...
  process.reallyExit(process.exitCode || kNoFailure);
}
```

`process.exit()` honours a recorded `process.exitCode`. `process.exit(undefined)` counts as supplying a code, sets it to `undefined`, and leaves as **0**. A forwarder written as `native(code)` turns the first into the second — so the guard erased exactly the failure it existed to preserve.

Which exit path a run takes decides whether that matters. Vitest's shutdown hook calls `process.exit(0)` with an explicit zero, and the guard handled that correctly from the start. Its close-timeout path calls `process.exit()` with none, and that is the path taken whenever something holds the event loop open — which the Vite server routinely does. So the end-to-end canary passed on runs that took the first path and would have failed on runs that took the second.

It was caught by the mechanism built for it: the P2-S7 gate's own canary, run outside Vitest before anything else, refused to run the regression matrix and said the runner could not report failure.

The guard now preserves arity: everything but an explicit zero over a recorded failure is forwarded with the same number of arguments it arrived with. And the rule no longer depends on which path a run happens to take — `guardedExit` is asserted directly, argument by argument, in `tests/integration/runner-exit-code.test.ts`, alongside the end-to-end proof.

`تصحيح للفقرة 11أ: النسخة الأولى من الحارس كانت تمرّر النداء بصيغة `native(code)`، وهذا خطأ حين يُنادى `process.exit()` بلا وسيط أصلًا، لأن Node يعتبر تمرير `undefined` تحديدًا لرمز خروج فيمحو الفشل المُسجَّل. المسار الذي يسلكه التشغيل هو ما يحدّد ظهور العيب، ولذلك نجح البرهان الشامل أحيانًا. اكتشفته الآلية نفسها التي بُنيت له: كناري البوّابة، خارج Vitest، رفض تشغيل المصفوفة. الحارس الآن يحافظ على عدد الوسائط، والقاعدة تُختبَر مباشرة وسيطًا وسيطًا بدل الاعتماد على المسار.`

## 11b. What the first trustworthy CI run then found — a leak assertion that was right about the rule and wrong about the string

With the runner able to report failure, the first CI run turned the P2-S6 gate red on one test in an accepted slice: `accounting-periods-closed-books.test.ts` → *the refusal names no table, constraint or SQLSTATE*.

The claim is correct and worth making: a merchant who closes periods out of order must get a sentence about their books, never a PostgreSQL error class. What was wrong was how the claim was spelled. The refusal legitimately carries the business and period ids, and the pattern for a SQLSTATE in class 23 was unbounded:

```
/accounting_periods|trigger|constraint|23\d\d\d|P0001/i
```

A UUID's hex runs contain decimal digits, so the id `79b263dc-82da-5b20-86b0-8c98d23726f8` satisfies `23\d\d\d` at `23726`. The test was a coin toss that came up tails on a few percent of runs, on ids that are generated fresh each time — and until `tests/helpers/exit-code.ts` the tails could be swallowed.

Four assertions of this shape were corrected, in `accounting-periods-closed-books.test.ts`, `accounting-periods.test.ts`, `accounting-periods-concurrency.test.ts` and `accounting-fx-http.test.ts`. Each numeric SQLSTATE pattern is now word-bounded (`\b23\d{3}\b`, `\b40001\b`, `\b23505\b`, `\bP0001\b`). A SQLSTATE appears in text as a token of its own, so the bound refuses exactly the leak the test is about; and because a UUID's segments are 8, 4, 4, 4 and 12 characters long, a five-digit run inside one can never sit between two word boundaries. The correction makes the assertion strictly more precise: nothing it used to catch stops being caught.

`ما وجده أول تشغيل جدير بالثقة لـCI: اختبار في شريحة مقبولة كان يتحقق من أن الرفض لا يسرّب رمز خطأ من قاعدة البيانات، لكنه كتب النمط بلا حدود كلمة، فصار يطابق أرقامًا عشرية داخل معرّف UUID يحمله الرفض بحق. أربعة اختبارات من هذا الشكل صُحِّحت بإضافة حدود الكلمة، والتصحيح يجعل التحقق أدقّ ولا يُسقط شيئًا كان يُمسَك من قبل.`

## 12. Test inventory

| suite | what it proves |
|---|---|
| `tests/integration/accounting-reports.test.ts` | the reports against a real ledger, each figure compared to an independent recomputation; the ledger opening boundary; the FX snapshot; inactive-account history; reversal and replacement visibility; a cumulative total past BIGINT |
| `tests/integration/accounting-reports-authorization.test.ts` | the permission matrix, the branch matrix and the tenant matrix, over all six routes |
| `tests/integration/accounting-ledger-pagination.test.ts` | keyset traversal at seven page sizes, a page boundary inside one busy date, a posting appended between two page requests, server-bounded page sizes |
| `tests/integration/accounting-report-unbalanced.test.ts` | the whole-business balance refusal, proven by damaging the journal out of band and repairing it |
| `tests/golden-regression/phase2/02-report-shapes.golden.test.ts` | a hand-computed trial balance and cash ledger over eleven entries covering every shape §46 lists |
| `packages/accounting/test/reports.test.ts` | the normal-balance rule over all five types, exact-integer parsing, the cursor codec and the page bound |
| `tests/performance/accounting-read-plans.test.ts` | the query plans the index decision rests on |
| `tests/integration/accounting-guards.test.ts` | G-3's discovered watched set and G-6, each asserted to fire as well as to pass |
| `tests/integration/runner-exit-code.test.ts` | that a failing `vitest run` leaves with a non-zero status, and a clean one with zero — the property every gate verdict in this repository rests on (§11a) |

## 13. Review status

**P2-S7 IS ACCEPTED AND FROZEN.** `0050_accounting_report_indexes.sql` is in the manifest at its accepted digest; `frozenThrough` is `0050_accounting_report_indexes.sql` with 51 frozen migrations. Those bytes are immutable from here on. `gate:phase2:s7` is permanent and carries the accepted digest independently of the manifest, so one commit cannot move the migration and its recorded hash together.

`الشريحة P2-S7 مقبولة ومجمَّدة. الترحيل 0050 مُدرَج في السجل ببصمته المقبولة، وحدّ التجميد صار 0050 بواقع 51 ترحيلًا. هذه البايتات صارت غير قابلة للتغيير من الآن.`
