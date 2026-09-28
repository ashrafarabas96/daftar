# PHASE 3 — P3-S9 RELEASE CLOSURE

**Status: PHASE 3 RELEASE — closed under the Tech Lead's 2026-09-26 directive to complete Phase 3. PR #4 stays a draft and is not merged.**
**Scope: release closure. Zero migrations and no change under `packages/` or `infrastructure/`. One change under `apps/`: the R-ACC-06 correction the Tech Lead authorized on 2026-09-27 (§6).**

This page states what P3-S9 establishes and the mechanism that proves it. It carries no workflow run id, no timing and no archive digest, for the reason `docs/PHASE_2_S9_RELEASE.md` gives: a page that has to be edited to carry a run changes the head that the run described. Everything a run produces lives in `release/phase3-s9-release-evidence.json`, assembled by `scripts/phase3-s9-evidence.ts` from artefacts. The run ids are named in PR #4 and in the hand-off to the Tech Lead.

---

## 1. What P3-S9 is, and what it is not

P3-S9 closes Phase 3 (inventory, purchases and suppliers). It adds no migration, no feature, no API capability and no screen. Phase 4 does not start here.

| | |
|---|---|
| **Protects** | the Phase 3 migration prefix `0053`–`0069` as a literal invariant (`scripts/phase3-prefix.ts`), next to the Phase 2 prefix `0000`–`0052`; later migrations stay permitted |
| **Composes** | one release gate, `npm run gate:phase3:release`: the runner canaries, tree identity, the Phase 3 prefix, the document check, `gate:phase2:release` (which composes the Phase 1 release gate), `gate:phase3:s8` (which composes P3-S7 … P3-S1, P2-S8 … P2-S1 and Phase 1) and the deployed-database rehearsal |
| **Rehearses** | the business on a database the deployment principal `daftar_migrator` built, with no superuser in the path (`npm run rehearse:phase3:deployed`) |
| **Ships** | a Phase 3 release-candidate archive (`npm run export:release:phase3`) whose gate is run again inside the extracted archive, on a new database cluster |
| **Runs** | `.github/workflows/phase3-s9-release.yml` ("DAFTAR P3-S9 release evidence"), at an exact SHA |

## 2. The accepted boundary

`frozenThrough` = `0069_inventory_reconciliation_read_and_account_domain.sql`, 70 frozen migrations. The Phase 3 prefix, as `scripts/phase3-prefix.ts` and the manifest both carry it:

| migration | SHA-256 |
|---|---|
| `0053_inventory_units_and_product_configuration.sql` | `63940fbcf2c5a3cd99a20280cd83fe53198a0e2d0e2dc0db7ed80d31c47bd3e6` |
| `0054_inventory_assertion_authority.sql` | `7205dea79f090ecf8ded122557d92b2b9669463ce3e5aefca466a968ef9aa450` |
| `0055_inventory_configure_product.sql` | `6652cd5949ad2d9bdda559e23174b850f3cf6bcc2a54d307c5fb9a0a1f5fa2b7` |
| `0056_inventory_branch_warehouses.sql` | `2de288c370e90df5c304ccf354638d178452798662d83054c6a8df8c6f7195a5` |
| `0057_inventory_permissions.sql` | `f6c7b56f920215cc8ba3e84d24e4f353329edab8dccb8d4e43a66712f7c1941d` |
| `0058_accounting_entry_date_guard.sql` | `455973c26bfdf0a185112a4e20a24676d54b5c4c7d4d1232f3e2dce3046b431a` |
| `0059_inventory_stock_ledger.sql` | `4d613225cf880c653918d7106f7fdcecbbda6adfa64d6c7dc2b991e49eb6494d` |
| `0060_inventory_stock_primitive.sql` | `be240e163a7894dc2de4a384a9a86e47addf0ea10c60fadc0e8c6341c278d66b` |
| `0061_inventory_movement_sources.sql` | `7b785537a866606990ab2cfab2a783eb05fe7fb362a67f9ea127119d569f57ff` |
| `0062_inventory_movement_commands.sql` | `dc47df235cc563606705de2a3a991992e573486bfa8d6a8493eb744129bb4b91` |
| `0063_purchases_suppliers_sources.sql` | `bf505fbad5ac4b32d1de2dba729fcd61f7a0651b3b99c8f38e5c2c4980c0a5fe` |
| `0064_purchase_commands.sql` | `b82e01810568390d21156ae555a7fbd35a990e33d8b280361bc85eaa6c7074ad` |
| `0065_supplier_returns_reversals_sources.sql` | `fbf674d2663854da31024932df428ec9d16ccdbda15d3c83a10dbcf554b95e68` |
| `0066_supplier_return_reversal_commands.sql` | `a9d5e6175a99677db33ebbadfac6ac41310fbc97cbc8390ac669534679eeef9e` |
| `0067_payment_methods_supplier_settlement_sources.sql` | `81363f1adf8a296b94690baee4766bcacfa72520477b26f8044cccda398fe660` |
| `0068_supplier_settlement_commands.sql` | `dafad8c698b8668eef24b38315117b3813ceeeaad7cc84b9089ab66b3be89a04` |
| `0069_inventory_reconciliation_read_and_account_domain.sql` | `912299e90a937b684b1829df4be90d5815ee61bcee79d9a01c5e47c4d6fe3084` |

Each digest is also carried by its slice gate's accepted tense (`S2_ACCEPTED` … `S8_ACCEPTED`), so one commit cannot move a migration and its recorded hash together. The slices and their acceptance pages:

| slice | migrations | page |
|---|---|---|
| P3-S1 inventory foundations | `0053`–`0058` | `docs/PHASE_3_S1_ACCEPTANCE.md` |
| P3-S2 stock ledger | `0059`–`0060` | `docs/PHASE_3_S2_ACCEPTANCE.md` |
| P3-S3 transfers, adjustments, damage, stocktake, opening | `0061`–`0062` | `docs/PHASE_3_S3_ACCEPTANCE.md` |
| P3-S4 suppliers, purchases, receiving, landed cost | `0063`–`0064` | `docs/PHASE_3_S4_ACCEPTANCE.md` |
| P3-S5 supplier returns, PPV, credit notes, purchase reversal | `0065`–`0066` | `docs/PHASE_3_S5_ACCEPTANCE.md` |
| P3-S6 payment methods and supplier settlement | `0067`–`0068` | `docs/PHASE_3_S6_ACCEPTANCE.md` |
| P3-S7 reads and merchant web UX | none | `docs/PHASE_3_S7_ACCEPTANCE.md` |
| P3-S8 security, reconciliation, concurrency, performance | `0069` | `docs/PHASE_3_S8_ACCEPTANCE.md` |

## 3. The release gate

`npm run gate:phase3:release` first builds the library packages from source in dependency order, then runs eight mandatory steps in order and stops at the first failure. A `RELEASE_GATE_SKIP_*` variable is refused before anything runs, and the refusal still writes a FAIL artefact.

1. The runner failure canaries, root and web, outside Vitest (`scripts/runner-canary.ts`).
2. Tree identity; a delivery manifest, if present, says phase 3.
3. The Phase 3 prefix `0053`–`0069` intact; later migrations permitted.
4. No authoritative Phase 3 document contradicts the accepted state, and no acceptance or release page carries a placeholder. This page is one of the pages checked.
5. `gate:phase2:release`, verbatim: toolchain, manifest, `db-from-zero --release`, guards, localization, format, lint, typecheck, unit, integration and security (every Phase 3 suite), golden, the API, web and admin builds, Android, audit, artefact and secret scans, the Phase 2 prefix and the deployment-authority matrix.
6. The source tree is a source tree again (the API build output removed).
7. `gate:phase3:corrective` (the corrective directive §19). It composes `gate:phase3:s8` first, and through it every Phase 3 and Phase 2 slice gate and Phase 1: structural checks, suites and the Tier 1 budgets. Then it proves each corrected blocker:
   - the corrective migration boundary: the Phase 3 prefix stays intact, and the files after `0069` are exactly the declared corrective list, each called "Phase 3 corrective hardening". While a candidate, none of them is in the manifest. Once accepted, each hashes to its recorded digest;
   - the corrective suites, root and web, as an exact named list. A listed suite that is missing or skips fails the gate, and so does a `p3c-*` suite that no entry lists;
   - the review-index check and the explicit Phase 3 secret range scan from `0f2b09e7…`;
   - the real-browser red proof, then the full ar/en/tr × 360×640, 768×1024, 1280×800 matrix on the production build. The gate declares this matrix, and dropping a locale, a viewport or a planted-defect kind fails it before anything runs;
   - Budget A and B in isolation, last.

   Any entry the coordinator has not filled yet is a FAIL, never a skip. Every red proof it names must resolve to a test (`tests/security/p3c-corrective-gate-tamper.test.ts` and the DB stream's suites).
8. The deployed-database rehearsal.

Where each closure claim is proved is tabled in `docs/PHASE_3_S9_CONTRACT.md` §2 and §4.

## 4. Archive and clean environment

The workflow checks out the exact SHA and asserts `git rev-parse HEAD` equals it. It then runs the gate in the repository against the job's PostgreSQL 16 service, exports `release/DAFTAR_PHASE_3_RC.zip` with its `.sha256` sidecar, and extracts it outside the checkout with no `.git` reachable. There it runs `npm ci` and the gate again, on a **new embedded cluster** (`PG_DIR=$RUNNER_TEMP/pg-archive`, `PG_PORT=55432`) that no earlier step touched. In P2-S9 the archive run reused the repository run's already-migrated database; this run migrates the history from zero through the harness. The evidence assembler requires `delivery.sourceCommit` to equal the SHA, and the `git archive` of that SHA to carry the same tree hash, so the archive is proven to be that commit by two independent routes.

Tests that read the file list from git fall back to `DELIVERY_MANIFEST.json` inside the archive (`tests/helpers/delivered-files.ts`). `tests/security/archive-portability.test.ts` refuses a new bare `git` call in `tests/**` or `scripts/**`. Before that fallback, 16 of 52 tree-copy tests failed in a local extraction; after it, 52 of 52 passed.

## 5. The deployed database

`npm run check:deployment-authority` builds the history twice, once as `daftar_migrator` and once as a superuser. It asserts the deployer's exact memberships, compares the two catalogues in 12 families, upgrades one accepted Phase 3 slice head at a time to the current head (Case H), and checks that no runtime role and not `PUBLIC` holds `TEMPORARY` or `CREATE` on `public`, on both builds.

`npm run rehearse:phase3:deployed` then runs the business on the database `daftar_migrator` built: 7 pinned suites, 116 tests, reconciliation included. It records the migration history before and after and requires it unchanged.

**What the rehearsal found.** Four `SECURITY DEFINER` routines are owned by whoever applies the migrations, because `0037`–`0039` create them without `OWNER TO`:

- `catalog_identifiers_sync()`
- `provision_actor(p_allowed_kinds text[])`
- `provision_assertion_key_install(p_kid text, p_secret bytea)`
- `provision_assertion_key_retire(p_kid text)`

On every CI database the superuser owns them and they bypass row-level security. On a deployed database `daftar_migrator` owns them and row-level security binds them. The catalogue comparison could not see this, because it treats the applying principal's name as interchangeable by design.

Every production path was exercised on the deployed build, through the real API and the real scripts, and passes:

- product create, SKU change, search and archive, as `daftar_app`;
- onboarding and a second business, through `provision_actor`;
- the three key installs and retirements, as `daftar_platform`.

What failed was a test fixture that wrote a variant as a superuser with no tenant context. The fixture now carries the context a real write carries, and no assertion changed. The four routines are pinned: a fifth applier-owned definer, or one handed to another owner, turns the matrix (10b) and the rehearsal (7.3) red. The security review found no runtime path through the four that grants more than intended on either build: each body is fixed SQL, no runtime role can create in `public` or a temporary table, and nobody is a member of the deployer. Their ownership and a `search_path` that does not name `pg_temp` are TD-18.

## 6. Defects the release work found

One is a defect in Phase 3 product code, and the Tech Lead authorized its correction in P3-S9 on 2026-09-27 (decision card, "fix it now"). This deviates from the contract's A-15, which said S9 changes no product code.

- **R-ACC-06 answered `discrepancy` for every business with a Phase 3 posting.** The check requires every posted source type to be one the running application knows. It compared against the three Phase 2 native types only, and P3-S3 … P3-S6 never added the eight domain types (inventory adjustment and opening, purchase, negative-inventory cost adjustment, supplier return, payment, credit allocation and refund). So the daily reconciliation raised a false alarm for every business that used inventory, purchases or supplier settlement. The data was never wrong. The reader now compares against both lists (`apps/api/src/modules/accounting/accounting-reconciliation.reader.ts`). The gap existed because no suite ran the nine Phase 2 checks over a business with Phase 3 postings. T-06 now runs all fourteen checks over every business the reader enumerates. It was red on the old reader, reporting R-ACC-06 with 16 and 1 offending entries in two businesses, and it is green on the new one. Because T-06 is one of the deployed rehearsal's pinned suites, the same assertion runs again on the database `daftar_migrator` built.

The other defects are not in Phase 3 product code:

- `npm run check:key-retirement` (Phase 1) never ran: top-level await does not compile for this repository's CommonJS scripts. It now runs, and `tests/integration/check-key-retirement.test.ts` runs the real script for its three answers, all red on the old script.
- The root TypeScript project (`tests/**`, `scripts/**`) was compiled by no CI step and carried 57 errors. They are fixed, and `npm run typecheck` now compiles it; a planted type error fails it.
- The first release-workflow run at an exact SHA stopped at the runner canary on the clean runner: the canary runs the root test setup, which imports the `@daftar/*` packages through their built entry points, and nothing was built yet. Every earlier run had used a tree where they were built. The gate now builds them first, in dependency order, as the Phase 1 release gate does. With every `packages/*/dist` removed, the canary alone fails the same way, and the gate builds the packages and the canary passes.
- The rehearsal first reported FAIL with exit 0, because `embedded-postgres` forces status 0 on exit, and then hung, because a synchronous child stopped the server's log pipe from draining. Both are fixed and pinned by T-10.
- In a composed run over an hour long, four P3-S3 … P3-S5 atomicity and seam suites counted accounting-assertion rows that the frozen consumers prune after an hour. They now count the uses a case added (P3-S8, `docs/PHASE_3_S8_ACCEPTANCE.md` §3).

## 7. Performance at scale

The Tier 2 evidence of the slices still describes this head. From the P3-S8 freeze, `packages/` and `infrastructure/` are unchanged. Under `apps/` the only change is the list R-ACC-06 compares against, a check neither Tier 2 run measures.

- **S7 T-17 Tier 2** (scale 1): the four read budgets passed, with the largest p95 at 78 ms against 250 ms (`docs/PHASE_3_S7_ACCEPTANCE.md`).
- **S8 T-13 Tier 2** (`P3S8_PERF_TIER=2`, local, fresh embedded PostgreSQL; supporting evidence): 7 of 7 passed. D-GL was built by the real commands at ×10: 137,000 movements and 42,904 journal lines. R-INV-01 … 05 over it took 1.3 s against 120 s (S8-R1). D-LEDGER held 1,000,020 movements over 50,001 keys. R-INV-02/03/05 took 6.7 s against 300 s (S8-R2), and fold and verify of every key took 10.9 s against 600 s, with 0 mismatched keys and 0 gaps (S8-V). The build took 27 minutes (S8-B, recorded, not bounded). The first Tier 2 run stopped building D-GL, because ×10 made one stocktake of 5,000 lines and the product bounds a stocktake at 2,000. The dataset now counts them in stocktakes of at most 2,000.
- **Budget A** stays at 15 ms and passes in isolation in every slice gate.

## 8. Final reviews

- **Security:** no High and no Medium finding; S-1 … S-12 pass. The reviewer ran the deployment matrix (exit 0) and `npm audit --audit-level=high` (0 high or critical; 2 moderate in dev dependencies), and confirmed that the S9 diff adds no runtime surface. Three Low findings are fixed: the release workflow took its `ci_run` dispatch input into the script text (SR-1), and it now reads it from the environment; the job is now `permissions: contents: read` without a persisted checkout token (SR-2); a usage line named the wrong credential (SR-7). Two Low findings are TD-18 (SR-3, SR-4). Two are information: the rehearsal compares the migration history rather than the whole catalogue before and after the suites (SR-5), and the evidence assembler does not re-derive the eight step names (SR-6); the gate cannot write PASS with a step missing.
- **Data integrity:** D-2 … D-8 pass: exact integer comparisons with no rounding and no stored balance; each R-INV check red on its planted defect; the rebuild rehearsal exact; both prefixes and 70 frozen migrations verified; results carry identifiers, counts and timings only. D-1 found one defect, R-ACC-06 (§6), now corrected: the five S8 reconciliation suites and T-06's fourteen-check case pass, and the deployed rehearsal passes on the deployer's database. The reviewer confirmed that the S8 residue I-1 and TD-16 can only be reported and cannot corrupt data, and that no S8/S9 test edit can turn a failure into a pass: the jti-set counting is stricter than the row count it replaced, and the chunked stocktake still asserts every planned movement.
- **UX, in a real browser:** clean. The harness was first proven red: a planted 400-px element and a planted missing key on `/stock` were reported in all four locale and width combinations. Then the header and thirteen flows covering the twelve S7 routes ran in ar and en at 360×640 and 1280×800, in headless Chromium against `next start` and the real API, with the business seeded through the API: 56 runs, 126 screenshots, 0 issues. No page is wider than its viewport, nothing is clipped, and there is no raw key, no U+FFFD, no API error, no CSP violation, no tax field and no accounting word. `dir` is `rtl` in ar, the menu toggles on phones, and rows are reachable by keyboard. The pass found one Phase 1 defect outside the Phase 3 screens, TD-19: the web server's calls to the API share one per-IP refresh allowance, and a 429 logs the user out. It also found two cosmetic items, TD-20.

## 9. What stays open

- **OD-03, purchase tax: OPEN, and every tax element is BLOCKED BY OD-03.** A purchase with a non-zero tax is refused with `purchase.tax_policy_absent`. No tax rate, tax account or tax posting exists in Phase 3.
- **`MAIN_PROTECTION_EXTERNAL_BLOCKER` (TD-08):** `main` has no branch protection or ruleset. Only a repository administrator can configure it; it is recorded, never described as configured.
- **Tech Lead decisions recorded in the slices:**
  - P3-S3 B-1: superseding a posted inventory opening is refused; a wrong opening is corrected with a reasoned adjustment.
  - P3-S4 R-B1: one receipt may consume several single-use accounting assertions. This is the working default; the Tech Lead has not confirmed it.
  - P3-S6 TL-11: the inventory-assertion sequence, a sibling of R-B1, awaits the same confirmation.
  - P3-S8 I-1: after the first stock movement, reversing one of two offsetting pre-movement manual Inventory lines opens a difference that R-INV-01 reports.
- **Debt:** TD-06 (no browser job in CI), TD-10 (symmetric assertion keys, bounded), TD-14 (a platform credential chooses the assertion key it installs), TD-15 (no supplier-payment reversal), TD-16 (a sub-unit AP residue from a pilot-currency partial return), TD-17 (no stored stock rebuild swap), TD-18 (four applier-owned pre-Phase-3 definers), TD-19 (the web server's calls to the API share one per-IP auth allowance; Phase 1) and TD-20 (two cosmetic interface items). TD-09, TD-11, TD-12 and TD-13 are closed.
- **The hygiene scan window.** On a pull request, gitleaks scans a sliding 30-commit window of PR #4. Accepted commit `61b89d6` carries three SHA-256 migration digests that the generic-api-key rule flags as false positives. The window has moved past it and does not return. A full-history local scan finds only those three.

## ملخص

أُغلقت المرحلة الثالثة (المخزون والمشتريات والموردون) بلا هجرة جديدة، وبتغيير واحد في كود المنتج أذن به قائد الفريق في 2026-09-27: تصحيح R-ACC-06 (§6):

- الهجرات `0053`–`0069` محمية كبادئة ثابتة إلى جانب بادئة المرحلة الثانية.
- بوابة إصدار واحدة تجمع بوابة إصدار المرحلة الثانية وكل بوابات شرائح المرحلة الثالثة، وتمرينًا كاملًا على قاعدة بيانات بناها حساب النشر دون أي مستخدم خارق.
- تُشغَّل البوابة مرتين: في المستودع، وداخل الأرشيف المستخرج على قاعدة بيانات جديدة.
- كشف التمرين أن أربع دوال بصلاحيات مالكها يملكها من يطبّق الهجرات. مسارات الإنتاج كلها تعمل على قاعدة النشر، والفرق مثبّت الآن باختبار.
- القرار OD-03 (ضريبة الشراء) ما زال مفتوحًا: كل عنصر ضريبي محجوب، وأي شراء بضريبة غير صفرية يُرفض.
- حماية الفرع `main` خارج صلاحياتنا وتحتاج مسؤول المستودع.
- كان فحص R-ACC-06 يُبلغ عن فرق كاذب لكل نشاط استخدم المخزون أو المشتريات أو تسوية الموردين، لأنه لم يعرف أنواع المصادر الثمانية للمرحلة الثالثة. البيانات لم تكن خاطئة قط. الفحص يعرفها الآن، واختبار يشغّل الفحوص الأربعة عشر على كل نشاط كان أحمر قبل التصحيح وأخضر بعده.
