# DAFTAR — P2-S6 Acceptance / قبول الشريحة السادسة من المرحلة الثانية

> **What this is.** The evidence page for slice **P2-S6 — accounting periods**, submitted as a **CANDIDATE** for Tech Lead review. It states what is enforced by a mechanism and covered by a test, and, just as deliberately, what is not.
>
> **ما هذه الوثيقة.** سجل أدلة الشريحة P2-S6، مُقدَّمة كمرشّحة للمراجعة. العمود الحاسم هو الحالة: **ENFORCED** يعني أن قاعدة البيانات أو الـCI ترفض المخالفة اليوم ويوجد اختبار يثبت ذلك. تبني هذه الشريحة الفترات المحاسبية: مدى زمني للمنشأة يمكن إغلاقه، فترفض قاعدة البيانات أي قيد جديد بتاريخ داخله. لا ميزان مراجعة، ولا أرصدة، ولا إقفال سنوي، ولا تقارير.

## 0. The one sentence that matters

**DAFTAR never invents a merchant's fiscal calendar: a business with zero periods keeps exactly the posting rules it had yesterday, and the FIRST period it creates itself is what turns period-managed posting on.**

Shipping `0049` changes nothing for anybody. No period is created by the migration, for any existing business, ever. Once a merchant creates their first period, every NEW **ordinary** posting's `entry_date` must fall inside exactly one existing OPEN period: outside all of them is `accounting.period_missing_for_date`, inside a CLOSED one is `accounting.period_closed`. History is never rewritten — entries posted before the first period existed stay exactly as they are.

**The one exception, stated here because it is easy to get wrong.** An `opening_balance` whose `entry_date` is **strictly before the earliest period start** posts **without a covering period**. The first period is where the books begin in DAFTAR and the opening position is by definition what was carried in from before it, so refusing it would make the same financial fact valid or invalid depending on whether the merchant defined a period before or after stating it. The exception goes no further than that sentence:

- it remains subject to the universal no-future rule — no opening balance dated after today in the business timezone, period or no period;
- if its date falls **inside** a period, that period must be **OPEN**; inside a closed one it is refused exactly like any other entry;
- if its date is **after** the covered chain, or otherwise uncovered, it is refused for want of a covering period;
- **no other source** has it: a manual adjustment or a reversal dated before the earliest period is refused.

It is also bounded in quantity, which is worth stating because it is what keeps the exception from becoming a backdating channel: P2-S4 allows a business **at most one posted opening balance**, ever. So the exception admits exactly one entry per business over the lifetime of its books, not a class of entries.

`لا تخترع «دفتر» تقويمًا ماليًّا لأحد. المنشأة التي لا فترات لها تبقى على قواعدها كما هي تمامًا، وأول فترة ينشئها التاجر بنفسه هي ما يُفعِّل إدارة الفترات. بعدها يجب أن يقع تاريخ كل قيد جديد داخل فترة مفتوحة واحدة بالضبط، ولا يُعاد كتابة أي قيد سابق أبدًا. الاستثناء الوحيد: الرصيد الافتتاحي المؤرَّخ قبل بداية أقدم فترة يُقبل بلا فترة تغطّيه، لأن الرصيد الافتتاحي سابق للدفاتر بطبيعته؛ ولا يمتد هذا الاستثناء إلى مصدر آخر، ولا إلى تاريخ داخل فترة مغلقة، ولا إلى تاريخ مستقبلي.`

## 1. Candidate migration — P2-S6 is a CANDIDATE, NOT frozen

| migration | SHA-256 | state |
|---|---|---|
| `0049_accounting_periods.sql` | `f51094e4ab6047493094be434dc08fad6f8f6333aa9ffde49bcf84c62f4f93c0` | **CANDIDATE — not frozen** |

`MIGRATION_MANIFEST.json` is unchanged: it still records **49 frozen migrations** with `frozenThrough = 0048_accounting_fx_rates.sql`, and `0049` is deliberately absent from it. There is **no `0050`**. Freezing is the Tech Lead's act on acceptance, not a step of this work — a slice that froze its own migration would have certified itself — and `npm run gate:phase2:s6` FAILS today if the manifest records `0049`, if `frozenThrough` moves, or if any file beyond `0049` appears.

- Branch: `phase/2-accounting-core` · Draft PR: **#2** (stays draft for all of Phase 2)
- Starting accepted head (P2-S5): `ff382719de5e1e7a20999cc9db9e45ecceea2066`, exact-SHA workflow **35791858358**, all five jobs SUCCESS
- P2-S5 freeze commit (Stage A of this directive): `e1b7a95f64a1675f65e902dafb666491908243a9`, exact-SHA workflow **35797335350**, all five jobs SUCCESS

**Evidence law.** CI SUCCESS is reported for a commit only when GitHub shows a workflow run whose head SHA is that exact commit.

## 2. Status legend

| status | meaning |
|---|---|
| **ENFORCED** | a mechanism in this repository refuses the violation today, and a named test exercises it |
| **SPECIFIED** | written in a binding document; nothing in code or tests enforces it |

## 3. What the slice added

**Migration `0049_accounting_periods.sql`** (the one migration this slice created — 1 297 lines, two tables, eleven routines, four triggers)

- `accounting_periods` — the period itself. `start_date DATE` and `end_date DATE`, both **inclusive** and both civil dates with no time and no zone, because a boundary carrying a time would make "which period is 2026-03-31 in?" depend on where you stand. `status` CHECK-pinned to exactly `'open'` and `'closed'`. Creation, closure and reopening each carry their actor and their instant, and a reopening carries its reason. A composite `(tenant_id, business_id) → businesses (tenant_id, id)` so no row can claim a tenant that does not own its business. A CHECK refuses `'infinity'` and `'-infinity'`, because `daterange` accepts them and an infinite period would swallow every future posting date forever.
- `EXCLUDE USING gist (business_id WITH =, daterange(start_date, end_date, '[]') WITH &&)` — a **real PostgreSQL exclusion constraint**, not a unique index and not a rule the command is trusted to keep. See §5.
- `accounting_period_operations` — the append-only command registry (§18). One row per performed operation, binding the operation kind, the period, the canonical payload fingerprint, the resulting status, the actor and the instant. This is what makes a replay answerable: see §6.
- `accounting_periods_no_delete()` on `BEFORE DELETE`, `accounting_periods_transition()` on `BEFORE UPDATE`, and `accounting_period_operations_immutable()` on `BEFORE UPDATE OR DELETE` — all three **unconditional**, with **no identity exemption**, so the schema owner is refused exactly as a merchant is.
- `accounting_period_guard_posting()` on `BEFORE INSERT ON journal_entries` — the refusal, in the database. See §4 and §7.
- `accounting_period_reason_digest(...)`, `accounting_period_canonical(...)`, `accounting_period_fingerprint(...)` — the `acctperiod/1` canonical byte stream and its SHA-256, all `IMMUTABLE`, the PostgreSQL half of a specification whose TypeScript half is `packages/accounting/src/period.ts` and whose single vector source is `packages/accounting/vectors/acctperiod-vectors.json`.
- `accounting_period_topology_lock_key(...)` — one advisory key **per business**. There is no global accounting lock: one merchant closing their books does not queue behind another's.
- `accounting_period_create(...)`, `accounting_period_close(...)`, `accounting_period_reopen(...)` — the three commands. Each `SECURITY DEFINER`, owned by `daftar_accounting_internal`, `EXECUTE` granted to `daftar_app` alone, and each one gated by a verified `acctctl/1` control assertion rather than by the connection's identity.
- A final `DO $$ … $$` verification block that refuses to COMMIT the migration unless the end state is right: the exclusion constraint exists and is `contype = 'x'`, the posting trigger exists on `journal_entries`, all eleven routines pin `pg_temp` last, the eight elevated ones are owned by the internal principal, `accounting_periods` holds **zero rows**, and no DAFTAR role holds `BYPASSRLS`.

**`infrastructure/database/bootstrap.sql`** — one added line: `CREATE EXTENSION IF NOT EXISTS btree_gist;`, installed once by the deployment administrator. See §5.

**`packages/accounting/src/period.ts`** — `acctperiod/1`: the canonical stream, the fingerprint, the reason-identity contract, `derivePeriodId` and `derivePeriodOperationId`. Everything in it is pure: it reads no clock, no configuration and no connection, and there is deliberately **no** function that produces a period from a year, a quarter or a month.

**`packages/accounting/src/control-assertion.ts`** — extended, not replaced. `acctctl/1` gains exactly three command kinds: `period_create`, `period_close`, `period_reopen`. P2-S6 invented **no third assertion protocol**.

**`packages/domain-core/src/permissions.ts`** — exactly two new keys, both SENSITIVE: `accounting.period.manage` (create and close) and `accounting.period.reopen` (reopen, and nothing else). No built-in accountant role; C-12 still holds.

**The merchant surface** — four routes under `/v1/businesses/:businessId/accounting/periods`: `POST` to create, `POST …/:periodId/close`, `POST …/:periodId/reopen`, and `GET` to list. All three mutations require an `Idempotency-Key`. There is no `PATCH`, no `PUT` and no `DELETE`: a period's boundaries are immutable and a period is never deleted, so a generic update route would be a door with nothing behind it but a mistake.

## 4. Enforced by this slice

| # | rule | mechanism | test | status |
|---|---|---|---|---|
| 1 | The migration creates no period for anybody | `0049` contains exactly one `INSERT INTO accounting_periods`, inside `accounting_period_create`; the final verification block refuses to commit unless the table is empty | `accounting-periods.test.ts` — "a fresh business has ZERO periods and this migration created none" (counts across the whole database); `migration-upgrade.test.ts` — P2-S6 §42 case | **ENFORCED** |
| 2 | With zero periods, posting behaves exactly as before | the guard returns `NEW` unchanged when the business has no period at all | `accounting-periods.test.ts` — activation group | **ENFORCED** |
| 3 | The FIRST period activates period-managed posting | after one period exists, the guard requires a covering period for every new entry | `accounting-periods.test.ts` — activation group; `accounting-periods-concurrency.test.ts` — the activation race | **ENFORCED** |
| 4 | A posting outside every period is refused | `accounting.period_missing_for_date`, raised by the trigger | `accounting-periods.test.ts` — posting matrix | **ENFORCED** |
| 5 | A posting into a closed period is refused | `accounting.period_closed`, raised by the trigger | `accounting-periods.test.ts` — posting matrix, for `manual_adjustment` and `opening_balance` alike | **ENFORCED** |
| 5a | An `opening_balance` dated strictly BEFORE the earliest period start posts without a covering period | the one source-specific branch of `accounting_period_guard_posting()` | `accounting-periods-opening-balance.test.ts` — cases A, B, C | **ENFORCED** |
| 5b | The same opening balance is accepted whether the first period was created before or after it | the same branch; the rule reads persisted facts only, so setup order cannot reach it | `accounting-periods-opening-balance.test.ts` — FLOW 1 and FLOW 2, ending in a byte comparison of the two businesses' posted entries | **ENFORCED** |
| 5c | The exception stops at the earliest boundary: an opening balance ON the earliest start, INSIDE a closed period, or AFTER the chain is refused like any other entry | strict `<` against the earliest start, then the ordinary covering-period rule | `accounting-periods-opening-balance.test.ts` — cases D, F, F2, G, H | **ENFORCED** |
| 5d | No other source has the exception | the branch names `opening_balance` and nothing else; the gate fails on a second source literal | `accounting-periods-opening-balance.test.ts` — a manual adjustment one day before and far before, and a reversal outside coverage | **ENFORCED** |
| 5e | The exception survives the first-period race in both winner orders | one lock order, business row before period row, on both paths | `accounting-periods-concurrency.test.ts` — the two `obrace` cases, each asserting the same final books | **ENFORCED** |
| 6 | The refusal is the DATABASE's, not the application's | `BEFORE INSERT ON journal_entries`, independent of Nest, TypeScript and HTTP | `accounting-periods.test.ts` — provoked through the frozen posting primitive rather than a service, AND by a DIRECT `INSERT` issued as the schema OWNER, which reaches no command, no routine and no application at all | **ENFORCED** |
| 7 | Existing history is never rewritten | `0049` issues no `UPDATE` or `DELETE` against `journal_entries`, `journal_lines`, bindings, sources or FX rates | `migration-upgrade.test.ts` — a digest of every protected table, taken before and compared after; `gate:phase2:s6` scope checks | **ENFORCED** |
| 8 | No business's financial life begins because periods shipped | `0049` never writes `businesses.financial_started_at` | `migration-upgrade.test.ts`; `gate:phase2:s6` | **ENFORCED** |
| 9 | An idempotent replay of an EARLIER posting still succeeds after a later close | the frozen `accounting_post_entry` returns from its registry before it reaches `INSERT`, so a replay never fires the guard | `accounting-periods.test.ts` — "the idempotent replay succeeds after a close" | **ENFORCED** |
| 10 | The universal no-future rule is not relaxed inside an open period | P2-S3's frozen writer is untouched; `0049` does not redefine `accounting_post_entry` | `accounting-periods.test.ts` — a future date inside an open period in `Pacific/Kiritimati` still yields `accounting.entry_date_in_future` | **ENFORCED** |
| 11 | Two periods of one business can never overlap | gist `EXCLUDE` on `(business_id =, daterange(start,end,'[]') &&)` | `accounting-periods.test.ts` — the ten-case overlap matrix, plus two businesses holding identical dates | **ENFORCED** |
| 12 | A one-day period is legal | `start_date = end_date` satisfies the range CHECK | `accounting-periods.test.ts` | **ENFORCED** |
| 13 | A backwards range is refused by the DATABASE, independently of the engine | `CHECK (start_date <= end_date)` plus a command-level refusal; proved separately by minting an assertion over an arbitrary fingerprint so the schema answers first | `accounting-periods.test.ts` — two cases, engine and database | **ENFORCED** |
| 14 | A later period must join the existing range exactly | the command refuses a gap with `accounting.period_not_contiguous` — no inference, no silent merge, no gap-filling | `accounting-periods.test.ts` — contiguity matrix; `accounting-periods-http.test.ts` — 409 with the domain sentence | **ENFORCED** |
| 15 | The exclusion constraint's NAME never reaches a caller | `exclusion_violation` is caught and re-raised as `accounting.period_overlap` | `accounting-periods-concurrency.test.ts` — the response is asserted NOT to match the constraint name | **ENFORCED** |
| 16 | A period's boundaries are immutable | `accounting_periods_transition()` refuses any change to `start_date` or `end_date` | `accounting-periods.test.ts` — asked through the OWNER pool, so it is the invariant and not an ACL | **ENFORCED** |
| 17 | A period is never deleted, by anybody | `BEFORE DELETE` trigger, unconditional, no identity exemption; nobody holds `DELETE` | `accounting-periods.test.ts` — owner-pool `DELETE` refused | **ENFORCED** |
| 18 | Only `open → closed` and `closed → open` are possible | the transition trigger admits exactly those two and refuses every other field change | `accounting-periods.test.ts` — transition matrix, including a no-op `UPDATE` and a `created_at` rewrite | **ENFORCED** |
| 19 | A close carries its actor and its instant | `CHECK` stated as an equivalence, plus the transition trigger | `accounting-periods.test.ts`; `accounting-periods-http.test.ts` — neither is a field a client can send | **ENFORCED** |
| 20 | A reopen REQUIRES a reason | `accounting.period_reopen_reason_required`, plus a `CHECK` bounding the stored reason to 1–500 trimmed characters | `accounting-periods-http.test.ts` — absent, blank, whitespace-only and oversized all refused | **ENFORCED** |
| 21 | The reopen reason is audited | the reopen's audit event carries it | `accounting-periods-concurrency.test.ts` — audit shape | **ENFORCED** |
| 22 | The reopen reason NEVER enters the outbox | the outbox insert names identifiers, dates and state only | `accounting-periods-concurrency.test.ts` — outbox shape; `gate:phase2:s6` reads the statement | **ENFORCED** |
| 23 | The operation registry is append-only | `BEFORE UPDATE OR DELETE` trigger, unconditional | `accounting-periods.test.ts` — owner-pool mutation refused | **ENFORCED** |
| 24 | A replay returns the original result and transitions nothing | every command consults the registry BEFORE it inspects any state | `accounting-periods.test.ts`; `accounting-periods-http.test.ts` — replay returns `changed: false` | **ENFORCED** |
| 25 | An old reopen replayed after a later re-close does NOT reopen again | the registry decides first, so the command never reads "it is closed, so reopen it" | `accounting-periods.test.ts` — the §18 hazard, end to end: reopen → re-close → replay the original reopen → still closed | **ENFORCED** |
| 26 | One key with a different payload is a named refusal | `accounting.idempotency_conflict`, never a raw unique violation | `accounting-periods.test.ts`; `accounting-periods-http.test.ts` — 409 | **ENFORCED** |
| 27 | Two connections replaying one reopen key produce one outcome | the registry lookup happens under the topology lock | `accounting-periods-concurrency.test.ts` | **ENFORCED** |
| 28 | A close and a posting never produce a closed period containing a later-committed entry | one lock order — business, then period — on the command path and the posting path alike | `accounting-periods-concurrency.test.ts` — Case A (posting first, close waits) and Case B (close first, posting REFUSED and nothing written) | **ENFORCED** |
| 29 | Close-versus-post never deadlocks | the single lock order above | `accounting-periods-concurrency.test.ts` — four rounds of alternating ordering, asserting no outcome mentions a deadlock | **ENFORCED** |
| 30 | A reopen racing a posting is deterministic in both directions | same lock order; commit and rollback variants both proved | `accounting-periods-concurrency.test.ts` | **ENFORCED** |
| 31 | Two concurrent first-period creations yield exactly one period | the topology lock plus the exclusion constraint; the loser gets `accounting.period_overlap` | `accounting-periods-concurrency.test.ts` — one row remains | **ENFORCED** |
| 32 | Period management is serialized per BUSINESS, not globally | the advisory key is derived from the business id | `accounting-periods-concurrency.test.ts` — two businesses proceed concurrently under a 5 s race guard; `gate:phase2:s6` | **ENFORCED** |
| 33 | Ordinary postings keep P2-S3's concurrency | the guard takes `FOR SHARE` on the business and on the covering period | `accounting-periods-concurrency.test.ts`; the whole P2-S3 matrix runs in this slice's gate | **ENFORCED** |
| 34 | Exactly one audit event per created state change | one `INSERT INTO audit_events` per command, none on a replay | `accounting-periods-concurrency.test.ts`; `gate:phase2:s6` counts the statements | **ENFORCED** |
| 35 | Exactly one outbox event per created state change | one `INSERT INTO outbox_events` per command, none on a replay | `accounting-periods-concurrency.test.ts`; `gate:phase2:s6` | **ENFORCED** |
| 36 | An audit or outbox failure rolls the WHOLE command back | both are written inside the command's transaction; no routine commits its own | `accounting-periods-concurrency.test.ts` — failure injected by a temporary trigger on the target table, with **no production failpoint** | **ENFORCED** |
| 37 | `accounting.period.reopen` is NOT implied by `accounting.period.manage` | two registry keys, two route declarations, no fallback at any layer | `domain-core.test.ts` — the registry itself; `accounting-periods-http.test.ts` — a manage-only member creates and closes, and is REFUSED the reopen the owner can perform | **ENFORCED** |
| 38 | Both keys are SENSITIVE | `SENSITIVE_PERMISSIONS` | `domain-core.test.ts`; `gate:phase2:s6` | **ENFORCED** |
| 39 | The owner holds both by identity; manager and cashier hold neither | `BUILTIN_ROLE_PERMISSIONS` | `domain-core.test.ts`; `accounting-permissions.test.ts` — through the real onboarding path, and no other role anywhere persists either | **ENFORCED** |
| 40 | The 0041 backfill reaches every existing owner role with BOTH keys | the permission backfill in `0049` §11, with a completeness check and an overreach check | `migration-upgrade.test.ts` — grouped by role and permission, `owner` only, both keys, two businesses | **ENFORCED** |
| 41 | A period mutation requires business-wide authority | the service refuses `branch_scope_mode ≠ 'all'` | `accounting-periods-http.test.ts` — a branch-scoped member holding `accounting.period.manage` is refused, then accepted once widened | **ENFORCED** |
| 42 | Reading the periods follows `accounting.view` | the `GET` route's declared permission | `accounting-periods-http.test.ts` — a branch-scoped member CAN read | **ENFORCED** |
| 43 | The authority is the signed assertion, never the GUC or a client claim | every command resolves its actor through `accounting_control_actor` | `accounting-periods.test.ts`; `gate:phase2:s6` | **ENFORCED** |
| 44 | No third assertion protocol was invented | `acctctl/1` gained exactly three kinds | `gate:phase2:s6`; the P2-S5 authority matrix runs unchanged in this slice's gate | **ENFORCED** |
| 45 | TypeScript and PostgreSQL agree on `acctperiod/1`, byte for byte | one vector file read by both halves; both canonicalizers `IMMUTABLE`/pure | `accounting-period-parity.test.ts` — 30 cases comparing the canonical BYTES and the digest | **ENFORCED** |
| 46 | The fingerprint binds the operation id, so one period under two keys is two commands | the operation id is a field of the stream | `accounting-period-parity.test.ts` | **ENFORCED** |
| 47 | The three kinds can never collide | `kind` is the second field of the stream | `accounting-period-parity.test.ts` — the three streams are distinct | **ENFORCED** |
| 48 | The reopen reason enters the fingerprint as a DIGEST, under a defined contract | trim exactly SPACE, TAB, LF, CR; SHA-256 of the UTF-8 bytes | `accounting-period-parity.test.ts` — padded, Arabic, U+00A0-bearing and two spellings of one accented word, all agreeing on both sides | **ENFORCED** |
| 49 | RLS is enabled AND forced on both tables | `ALTER TABLE … ENABLE/FORCE ROW LEVEL SECURITY` | `journal-privilege-matrix.test.ts` — the validator policy list; `migration-portability.test.ts` — read through the non-superuser connection | **ENFORCED** |
| 50 | No runtime role writes a period, and nobody holds DELETE on either table | the grant model, compared against the live catalogue | `journal-privilege-matrix.test.ts` (G-1); `gate:phase2:s6` reads the model | **ENFORCED** |
| 51 | `daftar_app` reads periods and nothing of the operation registry | the grants | `migration-upgrade.test.ts` — the exact grant list is asserted whole | **ENFORCED** |
| 52 | Nobody gained `BYPASSRLS`, and `app_bypass()` was not widened | `0049` confers neither; the final verification block refuses to commit if any DAFTAR role holds it | `journal-privilege-matrix.test.ts`; `migration-portability.test.ts`; `gate:phase2:s6` | **ENFORCED** |
| 53 | Every elevated routine pins its search path with `pg_temp` LAST | guard G-5, over the whole tree | `check:guards`; `gate:phase2:s6` | **ENFORCED** |
| 54 | The list is an OBJECT with `items`, never a bare array | `AccountingPeriodListDto` | `accounting-periods-http.test.ts` — exactly six keys per item, ordered by `startDate`, civil dates verbatim | **ENFORCED** |
| 55 | The list exposes no assertion, no operation id and no audit internal | the adapter selects named columns from `accounting_periods` alone | `accounting-periods-http.test.ts` — the key set is asserted exactly; `gate:phase2:s6` | **ENFORCED** |
| 56 | There is no generic period `PATCH` to reach | no such route exists | `accounting-periods-http.test.ts` — `PATCH` returns 404; `gate:phase2:s6` | **ENFORCED** |
| 57 | The payload is strict | `.strict()` Zod schemas on both bodies | `accounting-periods-http.test.ts` — twelve payload cases, plus a missing `Idempotency-Key` and a non-UUID period id | **ENFORCED** |
| 58 | `0049` applies under a NOSUPERUSER, NOBYPASSRLS migration principal | no step of it needs elevation | `migration-portability.test.ts` — 0049 alone onto the frozen 0048 boundary, read back through the same non-superuser connection | **ENFORCED** |
| 59 | A fresh `0000 → 0049` ends at 0049 with no 0050, and a rerun is a no-op | the runner's checksum history | `migration-portability.test.ts` | **ENFORCED** |
| 60 | A failing migration leaves nothing behind | each file runs in its own transaction | `migration-portability.test.ts` — a fixture migration that creates a table and then divides by zero leaves neither the table nor the history row | **ENFORCED** |
| 61 | `0048 → 0049` upgrades an existing deployment with its books intact | the upgrade path, from the boundary production actually sits at | `migration-upgrade.test.ts` — protected-table digest unchanged, zero periods, protections present on arrival | **ENFORCED** |

## 5. The first architectural decision that needs stating

**Non-overlap is a REAL PostgreSQL exclusion constraint, and the extension it needs is installed by the deployment administrator rather than bought with a privilege.**

§12 asks for `EXCLUDE USING gist (business_id WITH =, daterange(start_date, end_date, '[]') WITH &&)`. A gist exclusion that compares a UUID for equality needs `btree_gist`, and `0000` never installed it. `CREATE EXTENSION` is not something a `NOSUPERUSER` role may do on a database it merely connects to, which left three roads:

1. **Grant `daftar_migrator` CREATE on the database.** Refused. That is the right to install arbitrary C code, handed permanently to a deployment principal, to buy one extension once.
2. **Drop the constraint and enforce non-overlap in the command.** Refused. That is exactly the "wrapper is not an invariant" defect this project has already paid for once: a rule only the command keeps is a convention the next writer forgets, and the table's own owner could still write the overlapping row.
3. **Install it once, in `bootstrap.sql`, as the deployment administrator** — the same script that creates the roles, run by the same credential, before any migration. `0049` then only *asserts* that the extension is present, and if it is not it raises `accounting.period_extension_missing` with a sentence naming the fix.

Road 3 is what shipped, and it is measured rather than believed: `migration-portability.test.ts` runs `bootstrap.sql` as the administrator, hands the settled schema to `daftar_migrator`, asserts that the migrator holds **no** CREATE on the database, and then applies `0049` over that connection.

`القرار المعماري الأول: منع التداخل قيد فيزيائي في قاعدة البيانات، لا قاعدة يحرسها الأمر البرمجي. الامتداد اللازم يُثبَّت مرة واحدة في bootstrap.sql بيد مدير النشر، ولم يُمنح مبدأ الترحيل أي صلاحية إضافية — وهذا مُقاس باختبار لا مُفترَض.`

## 6. The second architectural decision that needs stating

**A replay is decided by the operation registry BEFORE any state is read, which is the only reason the reopen-after-reclose hazard has an answer.**

§18 names the hazard: an old reopen request, replayed after the period has since been re-closed, must **not** reopen it again. A command that decided from current state would read "the period is closed, and this is a reopen" and do exactly the wrong thing — and it would look correct in every test that did not replay across a later transition.

So every one of the three commands follows the same order: verify the assertion, take the per-business topology lock, lock the business row, **then look the operation up in `accounting_period_operations`**, and only after that inspect the period. A row in the registry means this exact command already ran; the original result is returned, `changed` is `false`, and nothing transitions, audits or publishes a second time. A row under the same key with a *different* payload fingerprint is `accounting.idempotency_conflict` — never a raw unique violation the caller has to interpret.

The proof is end to end rather than structural: reopen, re-close, replay the original reopen, assert the period is still closed and that no second audit or outbox row exists.

`القرار المعماري الثاني: إعادة المحاولة يحسمها سجل العمليات قبل قراءة أي حالة. الخطر المقصود هو إعادة فتح مكرّرة تصل بعد إغلاق لاحق؛ الأمر الذي يقرّر من الحالة الراهنة سيفتح الفترة من جديد، والأمر الذي يقرّر من السجل يعيد النتيجة الأصلية دون أي تغيير.`

## 7. The third architectural decision that needs stating

**There is one lock order — business, then period — and the posting guard obeys it too.**

§25 asks that a close and a posting never produce a closed period containing an entry committed after its close, and that the two never deadlock. Those two requirements pull in opposite directions unless a single order is imposed everywhere, so P2-S6 extends DAFTAR's existing order by exactly one level:

1. verify the assertion (no lock)
2. `pg_advisory_xact_lock` on the per-business topology key
3. the `businesses` row — `FOR UPDATE` on the command path, `FOR SHARE` on the posting path
4. the period row
5. mutate

The frozen posting primitive already takes the `businesses` row at step 2, and the guard fires after it, so a posting in flight holds the business before it reads a period — while a close holds it before it writes one. Case A (posting commits first, the close then waits and succeeds) and Case B (the close commits first, the posting is REFUSED with `accounting.period_closed` and nothing is written) are both proved with real two-connection races, and four rounds of alternating ordering assert that no outcome mentions a deadlock.

`القرار المعماري الثالث: ترتيب قفل واحد — المنشأة ثم الفترة — على مسار الأوامر ومسار الترحيل معًا. هذا ما يجعل التسابق بين الإغلاق والترحيل سباقًا له فائز محدّد لا تعارضًا في الأقفال.`

## 8. The reason-identity contract, and why it has no Unicode step

A reopen's reason is part of the command's identity: the same key with a different reason is a different payload and is refused as a conflict. So the contract must be exact, and it is two steps:

1. strip leading and trailing **SPACE, TAB, LF and CR** — those four code points and no others;
2. SHA-256 of the **UTF-8 bytes**, lowercase hex.

Step 1 is spelled out rather than delegated because `String.trim()` removes every Unicode whitespace character and `btrim(x)` removes spaces, and neither is wrong — which is the problem. A fingerprint whose two halves disagreed about one invisible character would refuse a command the merchant never changed.

There was a Unicode NFC step, and it came out. PostgreSQL's `normalize(text, NFC)` raises `Unicode normalization can only be performed if server encoding is UTF8`, and DAFTAR requires no UTF8 server encoding of a deployment today — the test cluster is the proof, since it is not one. Keeping it would have meant either a new, unstated deployment requirement that nothing enforces and a restored database could silently fail to meet, or a PostgreSQL half that quietly does less than the TypeScript one — exactly the drift the shared vectors exist to catch. So the contract takes the bytes verbatim, and the cost is small and precise: a reason typed with a decomposed accent and the same reason typed with a composed one are two different reasons, and a retry that changed spelling is REFUSED as a payload mismatch rather than silently accepted. Both halves are tested to agree that they are distinct.

`عقد هوية السبب: تُزال المسافات والجدولة وسطرا التنقّل من الطرفين فقط، ثم SHA-256 على بايتات UTF-8. لا توجد خطوة تطبيع Unicode لأن PostgreSQL لا يستطيع تنفيذها إلا على ترميز UTF8، وهو ما لا تشترطه «دفتر» على النشر — والثمن معروف ومُختبَر: كتابتان مختلفتان لحرف واحد هما سببان مختلفان، فيُرفض الطلب بدل قبوله صامتًا.`

## 9. The activation model, stated exactly (§9)

| the business's state | what happens to a NEW posting |
|---|---|
| zero periods | exactly what happened before `0049` shipped — the P2-S3 date rules, unchanged |
| periods exist; the date falls in one OPEN period | posted |
| periods exist; the date falls in one CLOSED period | `accounting.period_closed` |
| periods exist; the date falls in none of them | `accounting.period_missing_for_date` |
| periods exist; the source is `opening_balance` and the date is STRICTLY BEFORE the earliest period start | posted — the one exception, because an opening position predates the books |
| periods exist; the source is `opening_balance` and the date is anywhere else | exactly the three rows above: open period posts, closed period refuses, uncovered refuses |
| any of the above, and the date is in the future in the business's timezone | `accounting.entry_date_in_future` — the universal rule is unchanged and is checked by the frozen writer, not by this slice |
| an idempotent replay of an entry posted BEFORE the close | succeeds — the primitive returns from its own registry before it reaches the insert, so the guard never fires |

Two periods can never overlap, so "one OPEN period" is a physical fact rather than a hope. Entries posted before the first period existed are never revisited: `0049` rewrites nothing.

The exception row is the cross-slice correction, and it is worth saying why it is a rule about PLACEMENT rather than about a privileged source. P2-S4 already registers `opening_balance` with `lower_bound_policy = 'none'` — it has no historical floor, because a merchant's opening position can be any age. Periods narrow where NEW truth may be written, and applied without this row they would have turned that into: state your opening position before you define your first period and it is accepted; define the period first and the same position is refused. The correction removes the order dependence, and the four bullets in §0 are what keeps it from becoming a backdating bypass.

## 10. What this slice deliberately did NOT build

- **No trial balance, no general ledger, no balances, no report indexes and no materialized balances.** A period is a rule about what may be written; reporting is a different slice with a different risk.
- **No reconciliation worker.**
- **No period-end automatic journals, no retained-earnings close, no year-end close automation and no tax close.** Every one of those posts something, and a slice whose job is to REFUSE postings does not get to make any.
- **No fiscal calendar generator, anywhere.** Not in the migration, not in the engine, not as a convenience helper. A function that offered to turn a year into twelve periods is the seam through which DAFTAR eventually guesses a merchant's books, and the gate fails if one appears.
- **No inventory, sales, purchases, payments, POS, customers or suppliers.**
- **No FX provider.** P2-S5's limit is unchanged.
- **No `0050`.**

## 11. The stated limit

These controls do not protect against an attacker who has compromised the `merchant-api` process itself: that process holds the signing key, so it can mint a control assertion for any authority it can reach. That is the same limit P2-S3 declared and every later slice has inherited, and P2-S6 does not narrow it.

What this slice *does* add to the attacker's cost is stated precisely: a stolen `daftar_app` credential cannot create, close or reopen a period, because each command refuses without a verified `acctctl/1` assertion and no login role holds INSERT or UPDATE on `accounting_periods`; a stolen or replayed assertion cannot perform a second operation, because the jti is single-use and the registry answers a replay with the original result; a compromised process still cannot move a period's boundaries or delete one, because both triggers are unconditional and admit no identity exemption; and the closed-period refusal survives the application entirely, because it lives on `journal_entries` itself.

`الحدّ المُعلن: هذه الضوابط لا تحمي من اختراق عملية merchant-api نفسها لأنها تحمل مفتاح التوقيع. لكن بيانات اعتماد قاعدة البيانات وحدها لا تكفي لإنشاء فترة أو إغلاقها أو إعادة فتحها، ولا أحد — ولا حتى مالك المخطط — يستطيع تحريك حدود فترة أو حذفها، ورفض الترحيل داخل فترة مغلقة يعيش في قاعدة البيانات لا في التطبيق.`

## 12. Test inventory

| suite | cases | what it proves |
|---|---|---|
| `tests/integration/accounting-periods.test.ts` | 47 | activation, the overlap and contiguity matrices, immutability asked through the schema authority, the posting matrix, the transition matrix and the replayed-reopen hazard |
| `tests/integration/accounting-period-parity.test.ts` | 30 | TypeScript and PostgreSQL agree on `acctperiod/1`, byte for byte, including Arabic and the two spellings of one accented word |
| `tests/integration/accounting-periods-concurrency.test.ts` | 15 | close-versus-post in both directions, no deadlock, the activation race, concurrent first creations, audit and outbox shape and failure injection, the per-business topology lock, and the opening balance racing the first period in BOTH winner orders |
| `tests/integration/accounting-periods-http.test.ts` | 33 | the four routes, the authorization matrix (§21, §22), the list contract (§32) and the strict payload contract |
| `tests/integration/accounting-periods-opening-balance.test.ts` | 18 | the cross-slice correction: order independence, the nine-case opening-balance period matrix, the refusal of every other source before the earliest period, and the schema owner's two direct `INSERT`s failing at different rules |
| | **143** | |

Plus the extended `migration-upgrade.test.ts` (7 cases) and `migration-portability.test.ts` (7 cases), the permission suites, and the whole predecessor chain composed by `npm run gate:phase2:s6`.

## 13. Review status

**P2-S6 IS A CANDIDATE AWAITING TECH LEAD REVIEW.** `0049_accounting_periods.sql` is NOT frozen, is absent from `MIGRATION_MANIFEST.json`, and is the last migration in the tree. Nothing here authorizes freezing it, creating a `0050`, or starting P2-S7.

`الشريحة P2-S6 مرشّحة وبانتظار مراجعة القائد التقني. الترحيل 0049 غير مجمَّد وغير مُدرَج في السجل، ولا يوجد 0050. لا شيء هنا يأذن بتجميده ولا ببدء الشريحة التالية.`
