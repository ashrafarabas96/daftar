# DAFTAR — P3-S1 Acceptance / قبول الشريحة الأولى من المرحلة الثالثة

> **What this is.** The evidence page for slice **P3-S1 — Inventory and catalog primitives** (`docs/PHASE_3_EXECUTION_PLAN.md` §3). It maps each "Must prove" item of the plan to the permanent test that proves it, records every place where the lock and the code disagreed and how the conflict was ruled, and lists what P3-S1 found and did not close. It authorizes nothing: P3-S2 begins only when the Tech Lead says so.
>
> **ما هذه الوثيقة.** سجل أدلة الشريحة P3-S1. الهجرات `0053`–`0058` ما زالت **مرشّحة** وغير مجمّدة؛ تُجمَّد فقط بعد قبول القائد التقني. لا يوجد في هذه الشريحة أي جدول مخزون أو حركة أو شراء.

## 0. Status: READY FOR TECH LEAD REVIEW

- Branch: `phase/3-inventory-purchases-suppliers` · Draft PR **#4** into `main` (stays draft).
- Base: accepted P3-S0 checkpoint `ec08307d95ab0a50f826624a4e848d2c53398e51`, on `main` at `0f2b09e7f2bd1015053ff2cb79ad1ceafc25bc6f`.
- Candidate head and its exact-SHA CI run: recorded in the PR, not here (a commit cannot name its own hash).
- `MIGRATION_MANIFEST.json` is unchanged: 53 entries, `frozenThrough = 0052_accounting_journal_lines_rls_performance.sql`. The six P3-S1 files are candidates; `npm run gate:phase3:s1` asserts that none of them is frozen and that nothing past `0058` exists.

`READY FOR TECH LEAD REVIEW` means STOP. It does not freeze the candidates, create `0059`, or start P3-S2.

## 1. Candidate migrations

| migration | delivers | lock |
|---|---|---|
| `0053_inventory_units_and_product_configuration.sql` | `units` (11 codes) and `unit_names`; `products.track_inventory` / `unit_code` / `unit_decimals` with the tracked-needs-unit CHECK and no backfill guess; `product_variants.is_base`, the base-shape CHECK and `product_variants_one_base_uq`; the two invoker-rights column guards | P3-AL-03, -04, -05, -52, -54 §F |
| `0054_inventory_assertion_authority.sql` | `inventory_operation_kinds` (exactly three), `inventory_assertion_keys`, `inventory_assertion_uses`; key install/retire; the SQL `invpl/1` canonicalizer; `inventory_assertion_consume` / `_current` | P3-AL-55 |
| `0055_inventory_configure_product.sql` | `inventory_configure_product`, which consumes its assertion first, creates the base variant when needed and writes the audit row with the asserted actor | P3-AL-03, -04, -54 §E |
| `0056_inventory_branch_warehouses.sql` | `branch_warehouses` (ENABLE + FORCE RLS), the four home-association objects, the associate/dissociate routines | P3-AL-15 §A/§B, -54 §I |
| `0057_inventory_permissions.sql` | the eleven Phase 3 keys, seeded per P3-AL-38, with the five end-state assertions | P3-AL-38, -53 |
| `0058_accounting_entry_date_guard.sql` | TD-09: the `BEFORE INSERT` future-date trigger on `journal_entries`, business timezone, `SECURITY DEFINER` owned by `daftar_accounting_internal` | P3-AL-36 |

`infrastructure/database/bootstrap.sql` creates `daftar_inventory_internal` (`NOLOGIN NOINHERIT`, no attributes) and its one membership `daftar_migrator WITH INHERIT FALSE, SET TRUE`. Every ownership transfer to it is bracketed by `GRANT`/`REVOKE CREATE ON SCHEMA public` in the same file (static guard rule 20, `scripts/guards/inventory-definer-contract.ts`).

## 2. Must-prove → test

Suite names are file paths under `tests/` unless stated.

### 2.1 The authority acceptance of P3-AL-54

| # | property | test |
|---|---|---|
| 1 | raw `UPDATE`/`INSERT` of the three configuration columns as `daftar_app` → `inventory.configuration_authority_required` | `security/inventory-db-authority.test.ts` "the column guards"; `security/inventory-signed-authority.test.ts` row A |
| 2 | catalog price, category, SKU, barcode and `products.unit` updates still work | `integration/catalog-base-variant.test.ts`; the accepted catalog suites, unchanged |
| 3 | configure succeeds only after `inventory.adjust` and a consumed assertion; no body field, query flag or presented assertion skips either; revocation applies on the next request | `security/inventory-http-authority.test.ts` "P3-AL-54 item 3"; `integration/inventory-configuration.test.ts`; `integration/inventory-db-routines.test.ts` "inventory_configure_product" |
| 4 | base-variant `INSERT`/`UPDATE` as `daftar_app` → `catalog.base_variant_not_mutable`; `DELETE` → `42501`; internal role inserting `is_base = false` → refused | `security/inventory-db-authority.test.ts` "the column guards" |
| 5–6 | the internal role's attributes, membership and privileges | `security/inventory-db-authority.test.ts` "the inventory principal" |
| 7 | no `PUBLIC` `EXECUTE`; every internal-owned function passes the §D check; the two guards are the only invokers | `security/search-path-shadowing.test.ts`; `integration/inventory-db-guard.test.ts` (G-7, each protection removed in turn) |
| 8 | no DML on `branch_warehouses` for any runtime role | `security/inventory-db-authority.test.ts` "the §H grant matrix" |
| 9 | onboarding creates warehouse and home association atomically; a forced maintainer failure rolls onboarding back | `integration/inventory-db-routines.test.ts` "the warehouse ↔ home-branch lifecycle"; `integration/inventory-warehouse-matrix.test.ts` row L |
| 10 | managed-PostgreSQL run as a non-superuser migrator; catalogue equal to a superuser build | `integration/migration-portability.test.ts`; `scripts/phase2-deployment-authority.ts` (run by `gate:phase2:s8`) |
| 11 | no Phase 1 or Phase 2 regression | §4 below |

### 2.2 The signed-authority matrix of P3-AL-55 (rows A–R)

Rows A–K, N and O run over a raw connection as `daftar_app` in `security/inventory-signed-authority.test.ts`, each paired with a negative control that removes verification and shows the row turning green for the attacker. Rows L and M go through HTTP in `security/inventory-http-authority.test.ts`, `integration/warehouse-branch-association.test.ts` and `integration/inventory-warehouse-matrix.test.ts` (minter call counter zero for the assigned-scope actor, including one assigned to every branch; routine-written audit row naming the all-scope actor with its consumed jti and trace id). Row P: `integration/inventory-config.test.ts`, including an HMAC-equivalent key (`K‖0x00`) under a different base64 spelling. Row Q: `security/inventory-payload-parity.test.ts`, `integration/inventory-db-routines.test.ts` "invpl/1 and invctl/1 parity" and `packages/inventory/test/vectors.test.ts`. Row R: `integration/migration-portability.test.ts`.

### 2.2a Tenant isolation, ALLOW and DENY (directive §19)

`security/inventory-tenant-isolation.test.ts` pairs every DENY with the matching ALLOW in the same shape, against another tenant **and** a second business of the same tenant owned by the same person — the stronger case, since refusal then depends only on binding the command to the asserted business. It covers the three routines under a genuine assertion naming foreign ids, raw `SELECT`/`UPDATE` as `daftar_app`, the internal role under a business scope, and the HTTP routes and reads, with the minter call counter at zero on every refusal. The internal role's admission when **no** business scope is set is the documented onboarding exception (§3 ruling 1), not a DENY case.

### 2.3 TD-09 (P3-AL-36)

`integration/inventory-db-routines.test.ts` "TD-09" proves the business-timezone boundary both ways. `security/accounting-raw-sql-invariants.test.ts` now asserts **both** halves refuse a future-dated entry: the raw insert by the schema owner (`accounting.entry_date_in_future`) and the three commands. That assertion used to state that the schema accepts it; changing it is the repayment P3-AL-36 required, not a weakened test.

### 2.4 Catalog, units and warehouses

| property | test |
|---|---|
| a tracked product cannot exist without canonical units; no existing product became tracked | `integration/inventory-db-routines.test.ts` "inventory_configure_product"; `integration/migration-upgrade.test.ts` P3-S1 checkpoint |
| enabling tracking creates exactly one base variant, idempotently | same |
| base-variant proofs of P3-AL-52, rows 1–8 | `integration/catalog-base-variant.test.ts` (row 7 both through the catalog commands and as raw SQL); `security/inventory-db-authority.test.ts` "the column guards" |
| unit lifecycle rows 2 and 7 of P3-AL-05 §D | `integration/inventory-configuration.test.ts` |
| warehouse matrix of P3-AL-15 §C, rows A–M | `integration/inventory-warehouse-matrix.test.ts`, `integration/warehouse-branch-association.test.ts`, `integration/inventory-db-routines.test.ts` |
| Phase 3 permissions, five assertions, backfilled and freshly provisioned businesses equal | `integration/inventory-db-routines.test.ts` "Phase 3 permissions" (including "0057 refuses to commit a wrong end state"); `integration/inventory-permissions-provisioning.test.ts` |

### 2.5 The seam matrix of P3-AL-32

`integration/inventory-seam.test.ts` rows 1–6, 6a and 8, plus the compile-time half of rows 3, 4 and 6a; `integration/inventory-seam-posting.test.ts` row 7 (an accepted Phase 2 posting and the P3-S1 command on one handle, one commit). P3-AL-35: the trace id is required, must be a canonical lowercase UUID, and travels as `app.business_transaction_id` for observability only.

## 3. Conflicts found and how they were ruled

The directive's order of truth is code > tests > CI > migrations > docs > decisions > plan. Where the lock disagreed with the accepted code, the code won and the conflict is written down here.

1. **`app_bypass()` does not admit the internal role.** Lock §I assumed it does. It is `current_user = 'daftar_platform'` (`0032:17`, restated in `0052:244`), and a definer routine's `current_user` is its owner. Ruling: the `branch_warehouses` restrictive policy admits `daftar_inventory_internal` by name, and only when no business scope is set (onboarding through the frozen `provision_create_business`). Test: `security/inventory-db-authority.test.ts` "branch_warehouses isolation of the internal principal".
2. **Only the owner role is `is_system`.** `0033:137` marks the owner alone. `0057` identifies Manager and Cashier by template key.
3. **`branch_warehouses_keep_home` fails open for an unscoped superuser** — a documented limit of a deferred trigger with no business scope; no runtime role is a superuser.
4. **`0041`'s permission backfill was vacuous under a non-superuser migrator** because of FORCE RLS. `0056`/`0057` lift FORCE for their own backfill and restore it in the same transaction, asserting the result.
5. **No variant-creating command exists** for P3-AL-52 row 7 "through the command". The command half is proved as "no ordinary catalog command can reach a base variant" (every variant read and search excludes it), and the raw-SQL half as a refusal by the column guard and by privilege.
6. **Removal does not refuse archived targets**, as the lock states for association only.

## 4. Regression

Recorded in the PR body and the section-49 report with the exact commands and counts: `npm ci`, `check:migrations`, `check:guards`, `check:localization`, `format`, `lint`, `typecheck`, `npm test`, `test:integration`, `test:golden`, `build`, `gate:phase3:s1` (which runs `gate:phase2:s8` and therefore every earlier permanent gate).

### 4.1 Performance budget A

One combined run failed budget A (`post()` in an open transaction, p95 21.0 ms against 15 ms) while four agents shared the machine. Measured before any conclusion:

- Interleaved runs of `tests/performance/accounting-budgets.test.ts`, base `ec08307` against head, three each: base p95 6.70 / 6.68 / 6.96 ms; head p95 6.79 / 16.32 / 9.82 ms; p50 equal (5.5–6.4 ms). The two high head values come from one or two outliers of 30 samples (38.8 ms and 16.3 ms), not from a shifted distribution.
- The only P3-S1 object on that path is the `0058` trigger. Measured in isolation with `EXPLAIN ANALYZE` over 40 inserts: median **0.13 ms**, max 0.31 ms warm — the same as the accepted `accounting_period_guard` trigger beside it (median 0.13 ms). It cannot produce a 10–30 ms tail.

The budget was not raised. The result is confirmed by the final gate run on an idle machine.

## 5. Security review

An independent review ran against a real database migrated to `0058` and HTTP probes of the domain commands. No critical, high or medium finding. With any single runtime credential, no attack succeeded.

| finding | outcome |
|---|---|
| Low #1 — HMAC-equivalent keys (`K` vs `K‖0x00`) passed the key-separation check | **fixed** for the inventory key (`hmacKeysEquivalent`, tested in `packages/inventory/test/assertion.test.ts` and `integration/inventory-config.test.ts`); the accounting/provisioning pair is TD-12 |
| Low #2 — use-hygiene `DELETE` made one tenant's consumer wait on another's | **fixed** in `0054` (advisory-lock winner prunes, others skip); the test fails when the old `DELETE` is restored; the frozen copies are TD-13 |
| Info — platform + app credentials together can forge; `kid` conflict is a guess oracle | TD-14 |
| Observation — MAC compared with `<>` in SQL | not measurable through a database round trip; left as is |
| Observation — a merchant variant can be inserted beside a base variant by raw SQL | unreachable through the API; P3-S2 ambiguity A-29 |

## 6. Known conflict: `gate:phase2:release`

`gate:phase2:release` answers questions about the Phase 2 release candidate: it asserts that P2-S9 created no migration, and `db-from-zero --release` refuses unfrozen candidates. On a tree carrying P3-S1 candidates both are expected to fail, by design. The gate is not modified; it applies again to a frozen Phase 3 release.

## 7. Not in P3-S1

No stock, movement, transfer, adjustment or purchase table, and no path that moves stock. `products_20_unit_history_lock` and the movement primitive are P3-S2. The preparation for P3-S2 is analysis only: `docs/PHASE_3_S2_PREPARATION.md`.

## ملخص

الشريحة P3-S1 جاهزة لمراجعة القائد التقني. الهجرات `0053`–`0058` مرشّحة وغير مجمّدة، والتجميد الحالي باقٍ عند `0052`. كل بند «يجب إثباته» في الخطة له اختبار دائم مذكور أعلاه. المراجعة الأمنية المستقلة لم تجد ثغرة حرجة أو عالية أو متوسطة، وأُصلحت الملاحظتان المنخفضتان في نطاق المخزون. المُشغِّل الجديد لا يسبب فشل ميزانية الأداء؛ كلفته مقيسة 0.13ms. الخطوة التالية الوحيدة المسموح بها هي قرار القائد التقني.
