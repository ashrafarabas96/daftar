# DAFTAR — P2-S8 Acceptance / قبول الشريحة الثامنة من المرحلة الثانية

> **What this is.** The evidence page for slice **P2-S8 — security, failure, reconciliation and performance hardening**, submitted as a **CANDIDATE** for Tech Lead review. It states what is enforced by a mechanism and covered by a test, and, just as deliberately, what is not.
>
> **ما هذه الوثيقة.** سجل أدلة الشريحة P2-S8، وهي **مرشَّحة** بانتظار مراجعة القائد التقني. هذه الشريحة لا تضيف طريقة جديدة للكتابة في الدفاتر ولا للقراءة منها؛ تضيف **مبدأً واحدًا جديدًا يقرأ عبر كل الأعمال** لغرض واحد: التحقّق من أن الدفاتر ما زالت متّسقة. العمود الحاسم هو الحالة: **ENFORCED** يعني أن قاعدة البيانات أو الـCI ترفض المخالفة اليوم ويوجد اختبار يثبت ذلك.

## 0. The one sentence that matters

**Reconciliation reads every business's books under a credential that can do nothing else — no write anywhere, no financial command, no identity or key table, no RLS bypass — and a pass that could not look says so instead of saying it found nothing.**

The second half is the part that is easy to get wrong and impossible to notice afterwards. A reconciliation pass has exactly two failure modes that matter: it can miss a discrepancy, or it can *report* that there is none when in fact it never managed to look. The second is worse, because it produces a green signal that a human will rely on for months. So `unavailable` is a first-class outcome here, distinct from `ok`, and a cycle carrying even one of them is not a success.

The first half is the Tech Lead's decision, taken as Option B: a seventh database role, `daftar_reconciler`. The shorter path was to let `daftar_worker` do it, since that process already runs on a timer — and `daftar_worker` already holds the credential-delivery transport, the credential decryption key ring and the SMTP authority. Adding "can read every business's journal" to that same credential would have merged two unrelated trust boundaries into one blast radius: a stolen delivery credential would have become a financial reader.

`المطابقة تقرأ دفاتر كل الأعمال باعتماد لا يستطيع فعل أي شيء آخر: لا كتابة في أي جدول، ولا تنفيذ لأي أمر مالي، ولا وصول لجدول هوية أو مفتاح، ولا تجاوز لعزل الصفوف. والأهم: الدورة التي لم تستطع أن تنظر تقول ذلك صراحةً، ولا تقول إنها نظرت ولم تجد شيئًا. وصلاحية التسليم ليست صلاحية المطابقة المالية — لذلك دور سابع مستقل، لا توسيع لدور العامل.`

## 1. Migration — status

| migration | SHA-256 | state |
|---|---|---|
| `0051_accounting_reconciler_read.sql` | `2086c87564f5f66243ab64753e7c4f5338f896a1e29984ddf8977be8ba7587cc` | **CANDIDATE — NOT frozen, NOT in the manifest** |
| `0052_accounting_journal_lines_rls_performance.sql` | `0acf165003c678f8d3017797e77033fadf2e9e791be54f98048031108c72ad84` | **CANDIDATE — NOT frozen, NOT in the manifest** |

`MIGRATION_MANIFEST.json` is **unchanged**: 51 frozen migrations, `frozenThrough = 0050_accounting_report_indexes.sql`. P2-S8 froze nothing and created no `0053`. `gate:phase2:s8` enforces all of that as equalities rather than floors, because §44 is a hard stop and a gate that only checks a floor would let the stop be crossed quietly.

`0052` was authorized separately, on 2026-09-24, after the performance evidence was re-measured at acceptance scale and the first diagnosis was refuted — see §11 and `docs/PHASE_2_PERFORMANCE_BASELINE.md` §5.3. It was corrected **in place** rather than superseded by a `0053`: a candidate under review is not history, and a review that answers a correction with a new number leaves the reviewer reading two files to learn one thing.

`السجل لم يتغيّر: 51 ترحيلًا مجمَّدًا، والحدّ ما زال عند 0050. الترحيلان 0051 و0052 مرشَّحان فقط: موجودان على القرص، غائبان عن السجل. لم يُنشَأ 0053، والبوّابة تفرض ذلك كمساواة لا كحدٍّ أدنى.`

- Branch: `phase/2-accounting-core` · Draft PR: **#2** (stays draft for all of Phase 2)

## 2. What 0051 contains, and why each part is the narrowest thing that works

| part | what it does | why not the obvious alternative |
|---|---|---|
| one `SECURITY DEFINER` enumerator | returns `(tenant_id, business_id)` pairs in keyset order | `businesses` is RLS-scoped and since `0032` the only exempt principal is `daftar_platform`. Widening `app_bypass()` or granting `BYPASSRLS` would have traded a narrow need — a list of ids — for a global capability: every row of every table. That is the wrong trade by two orders of magnitude |
| owned by `daftar_accounting_internal`, `NOLOGIN` | a definer routine runs as its owner, so the owner *is* the authority | owning it with a login role would make the authority reachable by connecting |
| `SET search_path = pg_catalog, public, pg_temp` | pins resolution | a definer routine without a pinned path is a privilege escalation waiting for a shadowing schema |
| `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE … TO daftar_reconciler` | one grantee | PostgreSQL grants `EXECUTE` to `PUBLIC` by default, so the revoke is not optional |
| keyset cursor, limit clamped to 1000 | bounded pages, no caller predicate | `OFFSET` re-scans every page and silently skips a business when one is created mid-pass (§24). A caller-supplied predicate would make the enumerator a query tunnel |
| six **column-level** `SELECT` grants | exactly the columns the nine checks read | `GRANT SELECT ON businesses` is one line and hands a financial verifier the merchant's store slug, contact details and locale for no reason. Column grants are the difference between a stolen reconciliation credential being an accounting reader and its being a customer-data reader |
| ten live-catalogue assertions before commit | the file refuses to commit unless the boundary it describes is the boundary the database ended up with | a migration that describes a privilege model and does not verify it has documented an intention, not built a boundary |

**No RLS policy was changed, and none needed to be.** The existing `tenant_membership` and `business_isolation` policies written in `0040`, `0042` and `0049` already admit any principal presenting the right tenant and business scope. A correctly scoped reconciler is therefore admitted by rules that already existed. `app_bypass()` is untouched.

`لم تُعدَّل أي سياسة عزل صفوف، ولم يكن ذلك ضروريًا: السياسات القائمة منذ 0040 تقبل أي مبدأ يقدّم النطاق الصحيح. و`app_bypass()` كما هي: `daftar_platform` وحدها.`

### 2.1 The assertion block earned its place on the first try

`0051`'s first revision set the enumerator's ownership **before** its privileges. Every superuser-applied suite passed, because a superuser may grant anything. The managed-PostgreSQL portability matrix — which applies the whole history as `daftar_migrator`, with no superuser anywhere in the path — failed, with the migration's own words:

> `accounting.reconciler_authority_invalid: daftar_reconciler may execute exactly one non-public routine, found 0`

The cause is a PostgreSQL behaviour worth knowing: a `GRANT` issued by a role that does not hold grant option on the object **does not raise**. It emits `WARNING: no privileges were granted` and the transaction commits. A migration runner reads exit statuses, not warnings, so the migration would have "succeeded" on a managed deployment and produced a reconciler that could not execute its own enumerator — and the first sign of it would have been a reconciliation cycle reporting `unavailable` in production.

The fix is the order `0040`, `0045` and `0049` already use: set the privileges first, while the migration principal still owns what it just created, and hand ownership over last. Changing the owner keeps the grants, because PostgreSQL substitutes the new owner wherever the old one appears in the ACL.

Two things are worth taking from this beyond the fix. The assertion block is not ceremony: it is the only reason this was a red CI job instead of a production incident. And a suite that only ever runs as a superuser cannot see a privilege defect at all — the portability matrix exists because the deployment principal is not the one the test suite is most convenient with.

`النسخة الأولى من 0051 نقلت الملكية قبل منح الصلاحيات. نجحت كل الاختبارات التي تُطبَّق بصلاحية المدير، وفشلت مصفوفة PostgreSQL المُدارة التي تطبّق التاريخ بمبدأ الترحيل العادي. السبب أن GRANT من دور لا يملك حقّ المنح لا يُخطئ في PostgreSQL، بل يُصدر تحذيرًا ويُكمل — فكان الترحيل "ينجح" وينتج مبدأ مطابقة لا يستطيع تنفيذ دالّته. أُصلح الترتيب كما في 0040 و0045 و0049. والدرس: كتلة التحقّق داخل الترحيل هي وحدها ما حوّل هذا إلى فشل في CI بدل حادثة في الإنتاج.`

## 3. The process boundary

| property | state |
|---|---|
| `PROCESS_MODE=reconciler` | ENFORCED — a fifth mode with its own `ReconcilerModule` |
| HTTP surface | **NONE** — no controllers, booted as an ApplicationContext |
| its own connection string | `RECONCILER_DATABASE_URL`, with **no fallback** — without it the pool does not exist |
| the pool's identity | verified at connect to be `daftar_reconciler` |
| every other process's secret | **physically refused** in reconciler mode: 17 keys, including `SMTP_URL`, `JWT_SECRET`, `CREDENTIAL_PAYLOAD_KEY`, `ACCOUNTING_ASSERTION_KEY` and every other database URL |
| and the converse | `RECONCILER_DATABASE_URL` is refused in `merchant-api`, `platform-api` and `worker` |
| when the refusal applies | **every environment**, not only production — a check inside `if (NODE_ENV === 'production')` is a check that is off in every test that would have caught the mistake |
| shutdown | SIGTERM/SIGINT drain the in-flight cycle before closing; an interrupted cycle is never reported as a success |
| the worker | `WorkerModule` cannot reach reconciliation at all, and `0051` asserts at apply time that `daftar_worker` gained no accounting `SELECT` and cannot execute the enumerator |

## 4. Detect, never repair

Reconciliation has no write path anywhere: the reader, the service and the worker issue no `INSERT`, `UPDATE`, `DELETE` or `TRUNCATE`, hold no write privilege on any table in the database, and cannot execute any financial command. This is asserted three times over, at three different layers, because a verifier that quietly repairs is a system where nobody can tell a real discrepancy from one that was papered over:

- **statically**, by the gate, over the source;
- **at apply time**, by `0051`'s own assertion block, over the live catalogue, for *every* table in `public` rather than only the six it grants;
- **at run time**, by `tests/security/reconciler-authority-matrix.test.ts`, from the reconciler credential itself.

## 5. The nine checks, proved by planting what they look for

`tests/security/accounting-reconciliation-planted.test.ts` does not assert that the checks return `ok` on healthy books — that proves nothing. It **plants each discrepancy** and asserts the check catches it, on a throwaway transaction that is rolled back.

Doing this corrected two beliefs that were wrong before it was written:

- **R-ACC-03 is insensitive to a pure account-type re-label.** Re-labelling an account moves both sides of the identity and they cancel. The suite now trips it with a deleted account and carries a companion test asserting that a re-label correctly does *not* trip it.
- **R-ACC-07's real gap is a business changing its base currency**, not a malformed FX row — `fx_rate` is `NOT NULL` and `journal_lines_fx_shape_ck` holds, so a malformed row cannot exist.

The frozen row-level `CHECK` constraints fire even under `session_replication_role = replica`, so a plant has to move `debit_minor`, `base_amount_minor` and `txn_amount_minor` together. That is not an inconvenience; it is the schema demonstrating that the corruption these checks look for is already hard to create.

## 6. Failure injection — FI-01 … FI-12

All twelve, in `tests/security/accounting-failure-injection.test.ts`, and **no production debug switch was added to make any of them possible** (§30). There is no bypass header, no disable-constraint route, no special admin endpoint and no `if (test)` branch in the accounting core; the gate sweeps every production source file for exactly those shapes. FI-09 and FI-10 are proved *structurally* — from `pg_get_functiondef` and `prokind` — precisely because proving them behaviourally would have required such a switch.

## 7. Rollback / restore rehearsal — **PASS**

`npm run rehearse:phase2:rollback` performs the question rather than reasoning about it: a real PostgreSQL 16 cluster at the frozen Phase 1 boundary `0039`, data seeded through Phase 1's **own HTTP flows** by the **accepted Phase 1 build** from a temporary git worktree at `2e01dbab3df2cf112cb0a7d5ac827a5578c61b81`, a real `pg_dump -Fc`, a restore into a clean database, the Phase 2 migrations applied to the restored copy, and then the accepted Phase 1 application run against that upgraded database.

All twelve steps pass. Row counts are preserved, every business has a chart of accounts, no membership is orphaned, the rerun is a no-op, the current application reads the accounting routes, and **seventeen Phase 1 paths answer correctly on the upgraded schema** — including a catalog write, a branch write that correctly answers `409 FEATURE_NOT_ENTITLED`, and a second onboarding that correctly answers `403`.

### Three findings the rehearsal produced, each reported rather than worked around

**7.1 `bootstrap.sql` installed `btree_gist` but not `citext` or `pgcrypto`.** Migration `0000` creates all three with `CREATE EXTENSION IF NOT EXISTS`. That statement is a no-op when the extension is already installed and needs no privilege at all — but on a *fresh* database it is a real `CREATE` and requires `CREATE ON DATABASE`, which `daftar_migrator` deliberately does not hold. CI never noticed because CI applies migrations as the superuser. The two extensions are now installed in `bootstrap.sql`, which is the same answer `0049`'s extension already had: a deployment-administrator act, never a widening of the migration principal.

**7.2 `daftar_migrator` cannot apply the accepted migration history at all.** Directive §36 asks for `0051` to be applied using `daftar_migrator`. The rehearsal tried, recorded the refusal from the attempt rather than inferring it from the SQL, and reports:

- `0032`, `0033` and `0038` transfer routine ownership to `daftar_platform`, which the applying principal must be able to `SET ROLE` to. `daftar_migrator` is a member of `daftar_accounting_internal` and of nothing else.
- Every accounting migration from `0040` onward — `0051` included — opens with `GRANT CREATE ON SCHEMA public TO daftar_accounting_internal` and revokes it at the end. Granting a privilege onward requires holding it `WITH GRANT OPTION`; `daftar_migrator` holds plain `CREATE`.
- After a restore, every table belongs to the principal that applied the history, so an `ALTER TABLE` by anyone else is refused outright.

Each is answered the same way, and it is the way P2-S1 already settled: **the migration principal is never widened to make a migration apply.** DAFTAR's deployment principal is the administrator, which is what CI has always used. This is a property of the accepted history, not of `0051`, and it is put to the Tech Lead as such.

**7.3 The rehearsal caught itself lying.** Its first version symlinked the worktree's `node_modules` to the main tree's — an obvious shortcut, and the root dependency sets at `2e01dbab` and HEAD are identical, so it looked safe. It is not: npm workspaces put `node_modules/@daftar/domain-core` in that directory as a link to `ROOT/packages/domain-core`, so the "Phase 1" application was importing HEAD's domain packages. Migration `0041` refused the upgrade with `accounting.period_permissions_premature`, because HEAD's permission list seeded the P2-S6 period permissions. The migration was right and the rehearsal was wrong. The worktree now links and builds its own packages.

`البروفة كشفت خطأ نفسها: كان «تطبيق المرحلة الأولى» يستورد حِزَم HEAD، والترحيل 0041 هو الذي رفض الترقية وكشف ذلك. الترحيل كان على حق والبروفة كانت على خطأ.`

## 8. Observability

Sentinel values — a distinctive amount, a memo, a rate, an assertion, a secret, a fingerprint — are seeded into real postings, a full reconciliation pass runs against a production-shaped `pino` logger writing into a buffer, and the rendered output is searched for **the values, not the keys**. Redacting a key called `secret` while the same string appears in a message is the failure this is designed to catch. The metric contract refuses a label that names a business, an entry or an amount, and also refuses a label *value* shaped like an identifier whatever the label is called — because the dangerous case is not a label called `businessId`, it is a label called `scope` whose value is a UUID. Outbox lag is computed from `created_at` and `published_at`; no column was added and no money appears in any label.

## 9. Supply-chain hygiene (§47)

`npm run check:supply-chain` is deterministic and offline, so its verdict is reproducible from a commit rather than from whatever an advisory database says today. It deliberately does not run `npm audit`: advisories are a review activity, the rules below are a boundary.

- 496 locked packages, every one a registry tarball with an integrity hash; no git, file or off-registry dependency.
- 11 packages run an install script, and every one is on a reviewed list **with its reason** — an install script runs with CI's full environment before a single test executes.
- The lockfile matches every workspace manifest; no third-party dependency carries a floating major (the seven `*` ranges are workspace links, and the check proves that from the lockfile rather than trusting the `@daftar/` prefix).
- `@daftar/accounting`, `@daftar/domain-core` and `@daftar/shared-contracts` have **no third-party runtime dependency**.

## 10. KMS signer review (§43, §44) — REVIEW ONLY, nothing implemented

`docs/PHASE_2_KMS_SIGNER_REVIEW.md` answers all six questions. The conclusion is not the favourable one:

**With a symmetric HMAC, moving the signer behind a KMS does not remove the secret from the trust boundary — it moves it from the merchant API process to PostgreSQL.** Verification needs the same key that signing needs, and `pgcrypto` cannot verify Ed25519, so only an asymmetric redesign actually removes it. Remote HMAC would buy revocability and observability, which are real, but not secrecy. No fake KMS was built and nothing is claimed to be implemented. Recorded as **TD-10** and escalated to the Tech Lead as a design decision.

## 11. Performance — **all six budgets met, at the FULL acceptance scale**

The blocker is closed. The table that matters is the tier-2 one, because tier 1 is a smoke test and the ceilings were written for tier-2 volumes.

**Tier 2 — the acceptance measurement.** 104 478 journal lines for the reporting cases, 1 042 966 for the reconciliation pass, 60 iterations each:

| # | case | p50 | p95 | ceiling | verdict |
|---|---|---:|---:|---:|---|
| A | `post()` in an open transaction | 6.2 ms | 9.2 ms | 15 ms | PASS |
| B | manual-adjustment endpoint | 14.8 ms | 20.9 ms | 60 ms | PASS |
| C | whole-business trial balance | **179.0 ms** | **205.7 ms** | 500 ms | **PASS** |
| D | 50-row ledger page | 62.9 ms | 92.0 ms | 150 ms | PASS |
| E | account balance as-of | 47.9 ms | 74.0 ms | 100 ms | PASS |
| F | full reconciliation pass (total) | 13 977.8 ms | 13 977.8 ms | 300 000 ms | PASS |

**Tier 1 — the smaller dataset**, 21 614 lines, 30 iterations, run twice **locally**: A 7.8 / B 18.4 / **C 93.2** / D 24.7 / E 38.0 ms p95. C was **504.5 ms** and, on an independent repeat, **524.0 ms** before the correction. Earlier revisions of this page called Tier 1 "the per-push run" while nothing in CI ran it; that sentence was false and is withdrawn. Tier 1 is now a step inside `gate:phase2:s8`, which the `backend` job runs on every push and pull request — see §13 for what each kind of evidence does and does not prove.

**Two evidence defects were found and fixed while re-measuring, and they are worth naming.** The tier-2 dataset was producing 90 086 lines where the spec claimed 100 000 and 899 304 where it claimed 1 000 000 — a budget declared met at 90 % of the stated size is not met. The entry counts were raised until the real line counts cleared both figures. And the tier-2 validity assertion was comparing one business's line count against the sum of both datasets, so it could never have caught the first defect.

**What closed C, and the claim this page withdraws.** §11 of the previous revision said the cause was a correlated `EXISTS` planned per row on `journal_lines`. **That claim is withdrawn.** It was measured at tier 1 and refuted at acceptance scale: removing the subplan changed 118 828 shared blocks into 118 827 and the report was no faster. The dominant costs were elsewhere — three policy helpers PostgreSQL could not inline because they carried `SET search_path`, and a cast on the compared column that destroyed the row estimate. Candidate `0052` fixes both, across the three tables the trial balance reads, because every partial correction measured **slower than no correction at all**. The full sequence, the numbers, and what was refuted by what: `docs/PHASE_2_PERFORMANCE_BASELINE.md` §5.3.

**E missed first, at 488.6 ms, and was fixed at the application level**: the account restriction was applied outside the aggregate, so one account's balance cost a whole-business scan. Pushing the same restriction inside the aggregate — provably answer-preserving, since it restricts the `GROUP BY` key — took that query from 420 ms and 68 108 blocks to 29 ms and 5 644. No schema change, no new index.

**The answer did not change.** The trial balance was captured at every stage of the correction and is byte-identical throughout, which `tests/performance/accounting-rls-equivalence.test.ts` asserts independently of any timing.

`كل الميزانيات الستّ مستوفاة عند حجم القبول الكامل: الميزانية C من ٥٠٤٫٥ إلى ٢٠٥٫٧ مللي ثانية (p95) مقابل سقف ٥٠٠، على ١٠٤٬٤٧٨ سطرًا. وقد سُحب ادعاء النسخة السابقة عن سبب البطء صراحةً: القياس عند حجم القبول فنّده. كما صُحّح عيبان في الأدلة نفسها: مجموعة بيانات المستوى الثاني كانت أصغر من الحجم المعلن، والتحقق من صحّتها كان يقارن الرقم الخطأ.`

See `docs/PHASE_2_PERFORMANCE_BASELINE.md` for the machine, the dataset and the plans. The dataset generator is deterministic (seeded PRNG, fixed end date) and financially valid by construction: it mirrors the database's own banker's-rounding rule in `BigInt`, because the deferred validators frozen in `0043` reject anything else.

**No materialization was added.** AL-15 stands: every figure is still aggregated from the journal at read time, there is no stored balance, no rollup table and no materialized view, and the gate sweeps the whole schema and the whole application for all three.

## 12. What this slice did NOT close

| id | finding | why it is open |
|---|---|---|
| **TD-09** | The refusal of a future-dated entry lives in the three posting commands, not in a schema constraint. Raw SQL by the schema owner can insert one | Not reachable by any application path, and the raw-SQL matrix asserts **both halves** — the commands refuse it, the schema does not. Closing it needs a `CHECK` on `journal_entries.entry_date`, and `0000–0050` are frozen while `0051` was authorized to carry the reconciliation authority and nothing else |
| **TD-10** | Assertion signing is symmetric and the secret lives in the merchant API process | The KMS review's own conclusion: the change is a redesign, not a configuration. Escalated |
| ~~**TD-11**~~ | ~~Budget C misses~~ | **CLOSED by candidate `0052`.** Kept in this table with its outcome rather than deleted, because the first diagnosis of it was recorded here as settled and later refuted; see §11 and `PHASE_2_PERFORMANCE_BASELINE.md` §5.3. It reopens if `0052` is not accepted |
| **§36** | `daftar_migrator` cannot apply the accepted migration history | See §7.2. Answering it would mean widening the migration principal, which P2-S1 forbids |

## 13. Where each claim was proved, and what a green tick means

A gate that only ever runs on somebody's laptop is not an acceptance gate, and a JSON file GitHub never produced or consumed is supporting material rather than CI proof. P2-S8's evidence is therefore in **three kinds**, and this page names which kind every claim rests on rather than letting a reader assume the strongest one.

| kind | what runs it | what it proves | what it does NOT prove |
|---|---|---|---|
| **Level A — the per-push gate** | `npm run gate:phase2:s8`, as the step `Phase 2 slice gate — P2-S8` in the `backend` job of `.github/workflows/ci.yml` | The structure of this exact commit; the security, isolation, reconciliation and failure-injection suites against a real PostgreSQL; supply-chain hygiene; the runner-failure canary outside Vitest; that the exit-code guard is installed and not merely present; and the six budgets at **Tier 1** | Anything at acceptance scale. It never reads `release/` |
| **Level B — the acceptance evidence** | `.github/workflows/phase2-s8-evidence.yml`, dispatched at an exact SHA | **Tier 2** at 100 000 reporting lines and 1 000 000 reconciliation lines; the before/after RLS answer equivalence across the `0051 → 0052` boundary; the rollback and restore rehearsal against a real `pg_dump`; and the evidence document with zero mandatory checks skipped and zero failed | Nothing about a commit other than the one it checked out. Its artefacts are **uploaded, never committed** |
| **Local runs** | the same commands on a developer machine | That a defect exists, or that a fix works, quickly | Acceptance. Every number produced this way is labelled local on this page |

**The two levels are independent in one direction only.** `gate:phase2:s8` reads the repository and the exit status of commands it runs itself, and nothing under `release/`, so it passes on a clean checkout — `tests/security/phase2-s8-gate-tamper.test.ts` proves exactly that as its control case. `evidence:phase2:s8` **runs** the gate and **reads** the produced artefacts. `gate:phase2:s8:release` reads the artefacts and the evidence document. Nothing reads a file that records its own verdict, which is why the old gate's "ignore these two rows" special case is gone rather than documented.

**Every artefact names the commit it was measured on** (head SHA, both candidate digests, Node, PostgreSQL where relevant, dataset tier, actual line counts, iteration counts, and the workflow run when a workflow produced it). The release gate refuses a set in which any two artefacts disagree, which is the case where a migration was edited between two measurements and the two halves of the evidence describe different schemas.

**And the gate is known to be able to say no.** `tests/security/phase2-s8-gate-tamper.test.ts` builds a throwaway hard-linked copy of the checkout, breaks exactly one thing in it, and runs the real gate against the copy: 0051 removed, 0052 removed, a 0053 added, either candidate frozen early, a write privilege granted to the reconciler, an accounting read granted to `daftar_worker`, `app_bypass()` widened, a load-bearing composite foreign key dropped, the policy correction applied to five of six policies, the exit-code guard un-wired, the lockfile's integrity removed, and a Tier 1 budget exceeded. Nothing in this repository is modified to produce any of those cases.

`ثلاثة أنواع من الأدلة، وهذه الصفحة تسمّي النوع الذي يستند إليه كل ادعاء: بوّابة تعمل مع كل دفعة على GitHub، وسير عمل منفصل ينتج أدلة القبول على SHA محدّد بالضبط، وتشغيل محلي لا يُعدّ قبولًا ويُوسَم كذلك. البوّابة لا تقرأ مجلّد release إطلاقًا، فهي تنجح على نسخة نظيفة؛ وملفات الأدلة تُرفَع كمرفقات ولا تُودَع في المستودع أبدًا. وكل ملف دليل يحمل الـSHA وبصمتَي الترحيلين، والبوّابة ترفض أي مجموعة تتعارض فيها ملفّان. وأخيرًا: البوّابة مُثبَت أنها قادرة على الرفض، باثني عشر اختبارًا تُفسد نسخة مؤقتة من الشجرة ولا تمسّ المستودع.`

## 14. The verdict and the hard stop

**`READY FOR TECH LEAD REVIEW`.** The blocker that held this slice — TD-11, budget C — is closed by candidate `0052`, under the authorization of 2026-09-24. All six budgets are met at the FULL acceptance scale, not only at tier 1, and the accounting answer is byte-identical before and after the change. Nothing in this document is a conditional pass: where something is still open it is listed in §12 with its reason.

The blocker's own history is part of the evidence rather than tidied out of it. The first diagnosis was wrong about the dominant cause, it was written into this page and into the baseline as if it were settled, and it was refuted by a measurement taken at the scale the budget is actually written for. Both the claim and its retraction are kept, because a reader who only sees the corrected version cannot tell which parts of it were checked.

`الحكم: جاهزة لمراجعة القائد التقني. العائق TD-11 أُغلق بالترحيل المرشَّح 0052 بموجب تفويض ٢٤ أيلول، والميزانيات الستّ كلها مستوفاة عند حجم القبول الكامل لا عند المستوى الأول فقط، والإجابة المحاسبية متطابقة حرفيًا قبل التغيير وبعده. التشخيص الأول كان خاطئًا في تحديد السبب المهيمن، وقد حُفظ مع سحبه صراحةً بدل حذفه.`

`0051` is **not frozen**. `0052` is **not frozen**. There is **no `0053`**. **P2-S9 has not begun.** Only a new explicit Tech Lead directive lifts any of the four.

`الترحيلان 0051 و0052 غير مجمَّدين، ولا وجود لـ0053، ولم تبدأ P2-S9. ولا يرفع أيًّا من الأربعة إلا توجيه صريح جديد من القائد التقني.`
