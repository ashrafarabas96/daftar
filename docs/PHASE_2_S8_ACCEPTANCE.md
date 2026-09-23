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
| `0051_accounting_reconciler_read.sql` | `cd86976fe4f9b098bd8fde8fd8734f0ed68bdefa27ad399f66cba54d79a86245` | **CANDIDATE — NOT frozen, NOT in the manifest** |

`MIGRATION_MANIFEST.json` is **unchanged**: 51 frozen migrations, `frozenThrough = 0050_accounting_report_indexes.sql`. P2-S8 froze nothing and created no `0052`. `gate:phase2:s8` enforces all three as equalities rather than floors, because §44 is a hard stop and a gate that only checks a floor would let the stop be crossed quietly.

`السجل لم يتغيّر: 51 ترحيلًا مجمَّدًا، والحدّ ما زال عند 0050. الترحيل 0051 مرشَّح فقط: موجود على القرص، غائب عن السجل. لم يُنشَأ 0052، والبوّابة تفرض ذلك كمساواة لا كحدٍّ أدنى.`

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

## 11. Performance — **five budgets of six met; C misses, and the miss is why this slice is BLOCKED**

| # | case | p95 | ceiling | verdict |
|---|---|---:|---:|---|
| A | `post()` in an open transaction | 11.2 ms | 15 ms | PASS |
| B | manual-adjustment endpoint | 24.6 ms | 60 ms | PASS |
| C | whole-business trial balance | **504.5 ms** | 500 ms | **FAIL** |
| D | 50-row ledger page | 63.9 ms | 150 ms | PASS |
| E | account balance as-of | 49.7 ms | 100 ms | PASS |
| F | full reconciliation pass (total) | 1 863.2 ms | 300 000 ms | PASS |

Measured at `cd8a3047c2cbd56d0315d2eecdf6ddb903933af7`, 30 iterations each, over 21 614 journal lines on an idle four-core box. An independent repeat of the same code gave 13.0 / 28.2 / **524.0** / 75.0 / 55.8 ms: C misses in both.

**E missed first, at 488.6 ms, and was fixed here**: the account restriction was applied outside the aggregate, so one account's balance cost a whole-business scan. Pushing the same restriction inside the aggregate — provably answer-preserving, since it restricts the `GROUP BY` key — took the query from 420 ms and 68 108 blocks to 29 ms and 5 644, and the budget case to 55.8 ms. No schema change, no new index.

**C is diagnosed and NOT fixed.** The identical query, same rows, same box: **437.7 ms and 67 866 blocks** under RLS, **12.9 ms and 724 blocks** with the policy not evaluated. The overshoot is small and the cause is not: the read costs 34× what it needs to, and it only looks borderline because tier 1 runs 21 614 lines against a ceiling written for 100 000. The permissive `tenant_membership` policy is planned as a correlated `EXISTS` **per row** on `journal_lines`, while the same policy is hashed once on `journal_entries`. Four query-level rewrites were measured; all returned byte-identical rows and **all read exactly the same 67 866 blocks**. The repair is to the policy's shape, which lives in a frozen migration — so §36 applies and the decision is the Tech Lead's. Full numbers and plans: `docs/PHASE_2_PERFORMANCE_BASELINE.md` §5.2; registered as **TD-11**.

`خمس ميزانيات من ست ضمن السقف. الميزانية E أُصلحت هنا على مستوى التطبيق. الميزانية C مُشخَّصة ولم تُصلَح: السبب شكل سياسة عزل الصفوف على جدول سطور القيود، وهي داخل ترحيل مجمَّد — لذلك القرار للقائد التقني، وهذا سبب حالة BLOCKED.`

See `docs/PHASE_2_PERFORMANCE_BASELINE.md` for the measured numbers, the dataset that produced them and the machine they were measured on. The dataset generator is deterministic (seeded PRNG, fixed end date) and financially valid by construction: it mirrors the database's own banker's-rounding rule in `BigInt`, because the deferred validators frozen in `0043` reject anything else.

**No materialization was added.** AL-15 stands: every figure is still aggregated from the journal at read time, there is no stored balance, no rollup table and no materialized view, and the gate sweeps the whole schema and the whole application for all three.

## 12. What this slice did NOT close

| id | finding | why it is open |
|---|---|---|
| **TD-09** | The refusal of a future-dated entry lives in the three posting commands, not in a schema constraint. Raw SQL by the schema owner can insert one | Not reachable by any application path, and the raw-SQL matrix asserts **both halves** — the commands refuse it, the schema does not. Closing it needs a `CHECK` on `journal_entries.entry_date`, and `0000–0050` are frozen while `0051` was authorized to carry the reconciliation authority and nothing else |
| **TD-10** | Assertion signing is symmetric and the secret lives in the merchant API process | The KMS review's own conclusion: the change is a redesign, not a configuration. Escalated |
| **TD-11** | Budget C misses: the RLS policy on `journal_lines` is planned per row, costing 34× the same read without the policy | **This is the blocker.** No application-level fix exists — five rewrites measured, all identical in rows and in blocks read. The repair is a schema change to a frozen migration, which P2-S8 may not make |
| **§36** | `daftar_migrator` cannot apply the accepted migration history | See §7.2. Answering it would mean widening the migration principal, which P2-S1 forbids |

## 13. The verdict and the hard stop

**`P2-S8 BLOCKED — PERFORMANCE EVIDENCE JUSTIFIES A SCHEMA CHANGE`** (§36). Everything else in this document stands on its own evidence and is ready to read; the slice is not ready to accept, because one of its six budgets is missed for a reason that cannot be repaired without a change this slice is not authorized to make. Per §42 there is no conditional pass and no "ready apart from".

`الحكم: P2-S8 محجوبة — دليل الأداء يبرّر تغييرًا في المخطَّط. بقية الشريحة مكتملة وموثَّقة، لكنها لا تُقبَل ما دامت إحدى الميزانيات الستّ غير مستوفاة لسبب لا يُصلَح إلا بتغيير غير مأذون به في هذه الشريحة. ولا يوجد قبول مشروط.`

`0051` is **not frozen**. There is **no `0052`**. **P2-S9 has not begun.** Only a new explicit Tech Lead directive lifts any of the three.

`الترحيل 0051 غير مجمَّد، ولا وجود لـ0052، ولم تبدأ P2-S9. ولا يرفع أيًّا من الثلاثة إلا توجيه صريح جديد من القائد التقني.`
