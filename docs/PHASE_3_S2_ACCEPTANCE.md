# DAFTAR — P3-S2 Acceptance / قبول الشريحة الثانية من المرحلة الثالثة

> **What this is.** The evidence page for slice **P3-S2 — The immutable stock ledger** (`docs/PHASE_3_EXECUTION_PLAN.md` §4), built to the contract `docs/PHASE_3_S2_CONTRACT.md`. It maps each "Must prove" item to the permanent test that proves it, records the independent security review and how each finding was closed, and lists what P3-S2 leaves open and to whom. P3-S2 was accepted and frozen by the Phase 3 coordinator under the Tech Lead's 2026-09-26 directive to complete Phase 3 slice by slice, which delegates each slice's internal acceptance and freeze and reserves the Tech Lead's own verdict for the single Phase 3 final report.
>
> **ما هذه الوثيقة.** سجل أدلة الشريحة P3-S2 (دفتر المخزون غير القابل للتعديل). قُبِلَت الشريحة داخليًا وجُمِّدَت هجرتاها `0059` و`0060` بموجب توجيه قائد الفريق بإكمال المرحلة الثالثة؛ من الآن لا تُعدَّل بايتاتهما أبدًا وأي تصحيح يكون بهجرة جديدة. لا يوجد منتِج حقيقي لأي حركة مخزون بعد هذه الشريحة: أول منتِج هو P3-S3.

## 0. Status: ACCEPTED (internal) / FROZEN

- Candidate head: `4d0ed0b` (full SHA and its `DAFTAR CI` run in PR #4), green on all five jobs on that exact SHA.
- Freeze: `0059` and `0060` appended to `MIGRATION_MANIFEST.json`, `frozenThrough = 0060_inventory_stock_primitive.sql` (61 frozen migrations), and `S2_ACCEPTED` filled in `scripts/phase3-s2-gate.ts` in the same commit, from two independent sources. The exact-SHA CI run of the freeze commit is recorded in PR #4 (a commit cannot contain its own hash).
- Frozen hashes:

| migration | SHA-256 | state |
|---|---|---|
| `0059_inventory_stock_ledger.sql` | `4d613225cf880c653918d7106f7fdcecbbda6adfa64d6c7dc2b991e49eb6494d` | FROZEN |
| `0060_inventory_stock_primitive.sql` | `be240e163a7894dc2de4a384a9a86e47addf0ea10c60fadc0e8c6341c278d66b` | FROZEN |

- `0053`–`0058` (P3-S1) and `0000`–`0052` (Phase 2 prefix) are byte-identical to their accepted digests (`check:migrations`, `gate:phase3:s1`, `scripts/phase2-prefix.ts`).

`npm run gate:phase3:s2` is a **permanent regression gate** in its accepted tense: `frozenThrough` is a floor at `0060`, both files must hash to `S2_ACCEPTED` on disk and in the manifest, `0059`–`0060` must hold exactly those files, and a successor is permitted. Proven red before it was trusted: a byte appended to `0060`, `frozenThrough` moved back to `0058`, and `0059` removed from the manifest are each refused. Its candidate tense (used until the freeze) required `frozenThrough = 0058`, neither file in the manifest and nothing else after `0058`.

## 1. The P3-S2 migrations

| migration | delivers | lock |
|---|---|---|
| `0059_inventory_stock_ledger.sql` | registries `stock_movement_kinds` (10 kinds), `stock_source_types` (empty), `inventory_operation_movement_kinds` (empty); `stock_levels`, `stock_movements`, `stock_source_bindings` (movement-grained, deferred FKs both ways), `negative_inventory_deficits`, `negative_deficit_coverages` (no producer); append-only and retain triggers; ENABLE + FORCE RLS with the internal read policy; `daftar_app` holds `SELECT` on movements and levels only; the catalogue-only `inventory_stock_source_guard_gaps()`; end-state block 0059-E | P3-AL-01, -02, -06, -09, -10, -11, -12, -13, -49, -50, -51 |
| `0060_inventory_stock_primitive.sql` | type `inventory_movement_request`; R1 `inventory_half_even`, R2 `inventory_quantity_is_representable`, R3 `inventory_apply_stock_movements` (assertion first, READ COMMITTED only, products `FOR SHARE` in id order, variant mapping re-read, keys in uuid order, one CTE statement), R4 `inventory_next_deficit_seq`, R5 `inventory_stock_fold`, R6 `inventory_stock_verify`, R7 `products_20_unit_history_lock`, R8 the deferred `stock_levels_zero_on_hand_zero_value`, `product_variants_20_stock_identity_lock`; `inventory_configure_product` replaced by its owner with the disable-at-zero rule; no `EXECUTE` to any runtime role; end-state block 0060-E | P3-AL-05 §D, -08, -41, -42, -49, -54 §D, -55 §G |

Every routine owned by `daftar_inventory_internal` is `SECURITY DEFINER` with `search_path = pg_catalog, public, pg_temp`, no dynamic SQL, and its ownership transfer is bracketed by `GRANT`/`REVOKE CREATE ON SCHEMA public` in the same file. The migration principal was not widened: the deployment-authority check builds the schema as the non-superuser migrator and compares the catalogue with a superuser build.

## 2. Must-prove → test

| plan bullet (§4) | test |
|---|---|
| `UPDATE`/`DELETE` on movements refused for every principal, owner included | `security/stock-ledger-structure.test.ts` T-01 (each trigger dropped in turn: T-01.N) |
| no runtime DML, from the live grant matrix | `security/stock-ledger-authority.test.ts` T-02 (extra grant reported: T-02.N); `security/inventory-db-authority.test.ts` exact table and column maps |
| concurrent first-touch: one row, two ordered movements | `integration/stock-ledger-concurrency.test.ts` T-03 (unlocked read-modify-write loses an update: T-03.N) |
| opposite multi-key commands do not deadlock, two connections | same, T-04 (payload-order locking deadlocks with 40P01: T-04.N) |
| shared vectors byte-identical in TS and SQL, HALF_EVEN ties | `packages/inventory/test/valuation-vectors.test.ts`, `rounding.test.ts`; `integration/stock-ledger-vectors.test.ts` T-05 (`round()` disagrees: T-05.N) |
| exact rebuild over hundreds of movements | `integration/stock-ledger-rebuild.test.ts` T-06; `packages/inventory/test/rebuild.test.ts` (`on_hand × avg` planted into the cache: T-06.N) |
| zero-quantity movement and value-only with a cost refused | `integration/stock-ledger-primitive.test.ts` T-07 (each CHECK dropped: T-07.N) |
| the ten quantity-precision vectors | same, T-08 via R2, R3 and the TS twin; `packages/inventory/test/quantity.test.ts` |
| the nine valuation vectors with journal, GL and reconciliation; B and C as negative controls | `integration/stock-ledger-vectors.test.ts` T-09 (the withdrawn aggregate rounding gives 1 ≠ 2 and 1 ≠ 0) |
| full depletion leaves valuation 0; cycle equality | same, T-10 (zero-value trigger dropped: T-10.2; CTRL-FLUSH and the bound proof: T-10.N) |
| no 6100 line on any inventory posting, from the entries | same, T-11 (a planted rounding line turns it red: T-11.N) |
| no `on_hand × avg` path, statically | `integration/stock-ledger-guards.test.ts` (rules 21, 22 and the G-2/G-3 extensions, each with planted violations) |
| source registry refuses an unregistered type | `security/stock-ledger-structure.test.ts` T-13 |
| source completeness, including the bridge's real FK | same, T-14 (guard moved to the source side: T-14.N) |
| binding cardinality: two per transfer line, not three | same, T-15 |
| primitive authority: no runtime `EXECUTE`, assertion consumed, operation→kind mapped, business matched | `security/stock-ledger-authority.test.ts` T-16 (stubbed `inventory_assertion_current`: T-16.N) |
| unit history lock, rows 3–6 and 8, by name and order | `integration/stock-ledger-unit-lock.test.ts` T-17; the `pg_trigger` catalogue in the authority suite (guard 2 dropped: T-17.N; the product `FOR SHARE` removed from R3: T-17.11.N) |

Tenant and business isolation: every DENY in T-16 and T-18 runs against a business in another tenant (`security/stock-ledger-authority.test.ts`), and `security/stock-ledger-same-owner.test.ts` repeats the reads, the primitive, the raw internal writes, R4–R6 and both locks against a second business of the same tenant and the same owner, each DENY paired with the matching ALLOW.

## 3. Independent security review

A reviewer who read the diff, the contract, the policies and the tests itself confirmed seven findings. All are closed in P3-S2 except L-4 (informational).

| id | finding | closure |
|---|---|---|
| H-1 | `daftar_app` could move a stocked variant to another product through its `UPDATE` on `product_variants.product_id`, detaching stock from its unit | `product_variants_20_stock_identity_lock` (refuses while any stock key names the variant, `inventory.variant_stock_identity_locked`, holding the old product `FOR UPDATE`) and R3's mapping re-read after its product locks (`inventory.variant_stock_identity_changed`). Both race orders proven with two connections, each with a control that removes one half |
| M-1 | under REPEATABLE READ or SERIALIZABLE the unit lock and the disable rule read a stale snapshot | R3, R7, the variant lock and `inventory_configure_product` refuse any isolation other than READ COMMITTED with `inventory.isolation_unsupported`; the reviewer's reproduction is a permanent test |
| M-2 | the DB-level suites and the live writer sweep were missing | the seven stock-ledger suites; the PM-44 sweep over `pg_proc` lives in the structure suite |
| M-3 | at the 10^14 quantity bound a partial outbound could value more than the valuation it drew from | the bound is 10^10 in SQL and in the package (`QTY_LIMIT_Q4 = 10^14` in Q4), with edge tests; inside the bound the flush and `HALF_EVEN(q × avg)` agree (T-10.N) |
| L-1, L-2, L-3 | static-guard evasions (MERGE, quoted and qualified names, procedures, `ALTER ROUTINE`, quoted owner, DECLARE initialisers, casts, `RENAME TO`, `ALTER COLUMN TYPE`) | rules 21 and 22 and G-2/G-3/G-7 extended; every evasion has a planted-violation test that failed against the old guards; no allowlist, no rule weakened |
| L-4 | a cross-key identity race surfaces as `23505`, not a stable code | informational; the transaction still refuses |

## 4. Rulings recorded during implementation

- A-20 covers the ledger tables; source bridges follow the H-2 `ON DELETE RESTRICT` template, which `inventory_stock_source_guard_gaps()` requires. PostgreSQL 18 reports that violation as `23001`, PostgreSQL 16 (CI) as `23503`; T-14.4 derives the expected code from the server.
- A-23: the lock protocol holds only under READ COMMITTED (M-1), and the variant is frozen by a trigger, not a row lock (H-1).
- A-26: quantity bound 10^10 (M-3).
- CTRL-FLUSH is outside the primitive's domain; the tests seed it raw and predict it with an unbounded copy of the rule.

## 5. Open, with owner

| item | owner |
|---|---|
| `inventory_stock_source_guard_gaps()` checks names only | P3-S3 strengthens it (table, timing, enabled state, function) in its own migration before registering the first source type |
| a cross-command deadlock across two calls in one transaction | P3-S3 commands call the primitive once per transaction |
| TD-13 plain `DELETE` prune | P3-S3 |
| TD-12 effective-key separation | P3-S8 |

## 6. Regression

`npm run gate:phase3:s2` PASS locally on the frozen tree, composing Phase 1, P2-S1 … P2-S8 and P3-S1, with the P3-S2 step at 216 tests; Tier 1 budget A p50 5.69 ms, p95 9.29 ms against 15 ms (P3-S1 closed at p50 5.21, p95 7.27). The same-owner isolation suite adds 26 tests. `check:migrations` 61 frozen; `check:guards` 22 rules; `@daftar/inventory` 318 tests; `phase2-release-prefix` and `phase2-s8-gate-tamper` 42 tests on the frozen tree.

## ملخص

دفتر المخزون جاهز ومجمَّد: جدول حركات لا يُعدَّل ولا يُحذف، ورصيد لكل مفتاح مخزون يُعاد بناؤه من الحركات بدقة كاملة، وحساب بالأعداد الصحيحة بلا أعداد عشرية ثنائية، ودالة واحدة موثوقة تكتب الحركات ولا تعمل إلا بتفويض موقَّع. راجعها مراجع أمني مستقل، وأُغلقت كل ملاحظاته المؤكَّدة باختبارات دائمة. لا يستطيع أي حساب تشغيل كتابة حركة بعد؛ أول من يكتب حركات حقيقية هو P3-S3.
