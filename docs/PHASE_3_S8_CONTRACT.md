# DAFTAR — P3-S8 Contract / عقد الشريحة P3-S8

> **Coordinator rulings on this contract (2026-09-27).** Adopted as the P3-S8 implementation contract after P3-S7 was accepted and frozen; S8 did not start earlier, because S7's candidate gate refuses any grant after 0068. Every "S6C" citation is replaced by `docs/PHASE_3_S6_CONTRACT.md` and the frozen `0067`/`0068`; "S7C" by the adopted `docs/PHASE_3_S7_CONTRACT.md`. Line numbers are re-based to the S7 freeze commit.
>
> **Migration.** Exactly one: `0069_inventory_reconciliation_read_and_account_domain.sql` (0070 only if S7 admitted its index-only 0069). The gate derives it from the manifest.
>
> **B-1 was decided by the Tech Lead on 2026-09-27: R-B1a** (§2.4 as amended): refuse `manual_adjustment`/`opening_balance` entries with a line on `system_key = 'inventory'` once the business has any stock movement, read through an inventory-owned boolean helper (no accounting grant on `stock_movements`), deferred to COMMIT, reversals admitted, error 409, not in `AccountingErrorCode`. The R-B1a block is delimited so an R-B1b/c answer before freeze is a deletion.
>
> **S6/S7 facts S8 must honour.** 26 kinds (S6 at 0068:1442-1445). No Phase 3 routine posts: "financial" = the builder's accounting source types, equal by set to the 8 types registered after 0052 plus `reversal` (purchase.reverse); T-10 drives the composed command. `daftar_app` executes 28 Phase 3 routines (26 + `purchase_ap_outstanding`, `purchase_settlement_state`); S7 adds none. G-3 already covers payment methods and `settled`; the widening concerns 5 tables. Static guards stay at 23.
>
> **Amendments.** TL-3's exception set is `{provision_actor}` for clauses 1, 2 and 7; `accounting_actor` is internal-owned and passes. The rebuild-swap debt is **TD-17** (TD-15/16 are taken). New pin 16: the S2 H-5 composite (`stock-ledger-vectors.test.ts`) disables the R-B1a trigger inside its rolled-back transaction and gains one refusal case.
>
> **Budgets.** Budget A stays at 15 ms and no budget is raised; re-measured recorded figures only restate what was measured.
>
> **Ownership.** Annex R §4 replaces §8 of the body: agents M → D → T → G.
>
> **Adopted as engineering rulings:** A-01…A-21 and TL-1, TL-2, TL-4…TL-11 as amended above. OD-03 stays bounded.

> **Summary (Arabic).** عقد تنفيذ الشريحة P3-S8: الأمن، حقن الأعطال، المطابقة، التزامن، الأداء، وتمرين إعادة البناء.
> - **ترحيل واحد فقط، وله حاجة حقيقية.** المُطابِق `daftar_reconciler` لا يقرأ اليوم أي جدول مخزون، ولا يرى عمود `system_key` في `accounts`. لذلك لا يستطيع تنفيذ مطابقة المخزون مع الأستاذ العام التي تفرضها P3-AL-43. الترحيل يمنحه قراءة أعمدة محددة فقط، بلا أي دالة ولا سياسة ولا صلاحية كتابة.
> - **كل سيناريو في سجل ما قبل الفشل (PM-01 … PM-46) له اختبار واختبار ضابط سلبي.** الضابط السلبي يزيل الثابت نفسه فيفشل الاختبار. PM-44 وPM-45 وPM-46 تُعاد على أنواع العمليات الستة والعشرين المسجلة كلها، وتُكتشف من الكتالوج لا من قائمة مكتوبة.
> - **قاعدة الكاتب المخوَّل تُكتشف من الكتالوج.** كل دالة تكتب في جدول حقيقة من جداول المرحلة الثالثة تبدأ باستهلاك توكيد `invctl/1` أو بإعادة التحقق منه. الاستثناء الوحيد هو `warehouses_home_branch_maintain`.
> - **كل نوع عملية له دالة مستهلكة واحدة بالضبط، ولا نوع عامًّا.**
> - **المطابقة صفرية التسامح.** خمسة فحوص جديدة من R-INV-01 إلى R-INV-05 داخل إطار P2-S8، ونتائجها معرّفات وأعداد فقط، بلا مبالغ.
> - **مصفوفة صلاحيات وقت التشغيل ثابتة.** لا DML لأي دور تشغيلي على أي جدول من جداول المرحلة الثالثة. قانون `SECURITY DEFINER` يُطبَّق على كل دالة في المرحلة الثالثة. لا `TEMP` ولا `CREATE` على `public` لأي دور تشغيلي، والمُطابِق منها.
> - **توسيع الحراس G-2 وG-3 وG-4 وG-5 والقاعدة 22** لتغطي سطح المرحلة الثالثة كاملًا.
> - **إغلاق TD-12:** دالة `hmacKeysEquivalent` تُستعمل لكل زوج من مفاتيح التوكيد، ويتطور فحص بوابة P2-S3 في السطر 412 في الالتزام نفسه.
>
> **العائق الحقيقي الوحيد، B-1 (تعارض معماري).** تقول P3-AL-43 وPM-16 إن الفرق بين المخزون والأستاذ العام "لا مصدر مشروعًا له". لكن سطح المرحلة الثانية المعتمد يسمح بقيد تسوية يدوية على حساب المخزون 1200، والاختبارات الذهبية للمرحلة الثانية تفعل ذلك صراحةً. ويسمح كذلك برصيد افتتاحي فيه 1200 قبل تفكيكه (الحالة B). في هاتين الحالتين تكون مطابقة صفرية التسامح حمراء لدفاتر مشروعة. القرار للمسؤول التقني.
>
> لا ضريبة (OD-03 تبقى محدودة).

> **Status.** This is the candidate contract for P3-S8, written by the S8 contract agent. It is analysis only: no repository file was changed, nothing was committed, and PostgreSQL was not started.
>
> **Tree.** The worktree is reset to `95ff5a9`. At that point:
> - `infrastructure/database/MIGRATION_MANIFEST.json:3` holds `frozenThrough = 0066_supplier_return_reversal_commands.sql`.
> - `0067`/`0068` are the P3-S6 candidate: `scripts/phase3-s6-gate.ts:45-55` has `S6_ACCEPTED = {}`.
> - No `settlement-s6-*` suite exists yet. `scripts/phase3-s6-gate.ts:159-171` requires at least 18 of them.
> - P3-S7 lands between S6 and S8 with **zero migrations**. Its only exception is a conditional, index-only `0069` (S7C:145-150, S7C:551).
>
> **How this contract treats S6 and S7.** Every predecessor pin below is stated **as S6 and S7 will leave it**. S8 starts only after S7 is accepted: `S7_ACCEPTED_MARK = 'P3-S7 accepted'` (S7C:743).
>
> **Sources, in order of authority:**
> 1. Code and migrations `0000`–`0068`, read where cited.
> 2. Tests. §6.2 inventories them with file:line.
> 3. `docs/PHASE_3_ARCHITECTURE_LOCK.md` (L). The lock wins over every other document.
> 4. `docs/PHASE_3_EXECUTION_PLAN.md` (P) §10 (`P:261-265`) and §12–§14 (`P:275-319`).
> 5. `docs/PHASE_3_SLICE_MAP.md` (SM), `docs/PHASE_3_PREMORTEM.md` (PM), `TECHNICAL_DEBT.md` (TD), the S1–S6 contracts and acceptance pages (S1C…S6C), and the S7 candidate contract (S7C).
> 6. `docs/PHASE_2_PERFORMANCE_BASELINE.md` and `tests/performance/accounting-budgets.test.ts`.
>
> **Shape.** It mirrors `docs/PHASE_3_S5_CONTRACT.md` (S5C):
> - §0 conventions
> - §1 rulings
> - §2 database contract
> - §3 error model
> - §4 packages and application
> - §5 harness
> - §6 test plan, including the PM → test matrix
> - §7 gate, guards and predecessor pins
> - §8 file ownership
> - §9 real blockers and Tech Lead notes

---

## 0. Conventions

**Ruling classes.** These are the classes of S5C §0:
- **ENG** is an engineering ruling this contract makes. It stands unless the Tech Lead overturns it.
- **ENG+TL** is an engineering ruling the Tech Lead must confirm; it is listed in §9.2. The recommended option is written as normative text, so implementation can proceed on it.
- **BLOCKED** cannot be decided by engineering; it is listed in §9.1.

**Citations.** `file:line` or `file:a-b`. `L:n` is a line of the lock. `P:n` is the plan, `SM:n` the slice map, `PM:n` the premortem. `S7C:n` is the S7 candidate contract. Migration files are cited by their four-digit prefix, for example `0059:372`.

**SQL refusals** keep the accepted format `'<domain>.<code>: <safe text>'` with `ERRCODE = 'P0001'` (S5C §0).

**The Phase 3 surface — definitions used by every ruling below.**
- **Phase 3 table.** A relation in `public` that exists after the S8 head and does not exist in a database built from `0000`–`PHASE2_PREFIX_END`. `PHASE2_PREFIX_END` is `0052`, from `scripts/phase2-prefix.ts:6,104`. The difference is computed **from the live catalogue**, never from a list. At `95ff5a9` it holds 47 tables created by `0053`–`0068`.
- **Phase 3 column.** An attribute that exists after the S8 head on a table that already existed at `0052`, and not at `0052`. Examples are `products.track_inventory` and `unit_code`, and `product_variants.is_base`.
- **Phase 3 routine.** A `pg_proc` row in `public` that is absent at `0052`. It also includes a pre-Phase-3 routine whose `prosrc` differs from its `0052` definition. Replaced at `95ff5a9` are `provision_actor` (`0061:225`) and `accounting_actor` (`0061`).
- **Truth table.** A table on which `daftar_inventory_internal` holds `INSERT`, `UPDATE` or `DELETE` at table or column level, read from the ACL. Four tables are excluded by name, because they are the key domain and side-effect logs rather than domain truth: `inventory_assertion_keys`, `inventory_assertion_uses`, `audit_events`, `outbox_events` (L:1868; `0054:564-576`).
- **Runtime principal.** Every role with `rolcanlogin`, minus `daftar_migrator` and superusers. This is the seven roles of L:1660, `daftar_reconciler` included.

**The negative-control law** (PM cross-cutting 1, `PM:677`). Every test that S8 names as the proof of a PM invariant has a paired **negative control**. The control removes exactly that invariant in a scratch database built from the real migrations and shows that the attack then succeeds. The pattern is `tests/security/inventory-signed-authority.test.ts:1007-1117`. A PM row with no negative control is a gate failure (T-18).

**Migration number.** `<S8M>` means the next free number after the S7 head:
- `0069_inventory_reconciliation_read.sql` if S7 shipped no migration;
- `0070_inventory_reconciliation_read.sql` if S7's conditional `0069` exists (S7C:145-150).

The gate reads the S7 boundary from the manifest, never from a literal (§7.1).

---

## 1. Rulings

### A-01 · Slice scope and object inventory (ENG)

S8 delivers what P:263 lists and proves what P:265 lists.

**Database.** One migration, `<S8M>` (A-02). It contains read grants for the reconciler and nothing else, unless B-1 is decided R-B1a, which adds one guard.

**Packages.**
- In `@daftar/accounting`: five inventory reconciliation checks R-INV-01..05 (A-10), and the module `assertion-keys.ts` (A-19).
- `@daftar/inventory` loses its copy of `hmacKeysEquivalent` (A-19).

**Application.**
- The reconciler reader and service run R-INV-01..05 (A-10, A-11).
- `config.ts`, both minters and the three key-install scripts use `hmacKeysEquivalent` (A-19).

**Tests.**
- The signed-authority matrix over every registered operation kind (A-06).
- The catalogue-discovered writer-authority, operation-kind, grant and definer laws (A-04, A-05, A-07, A-08).
- The reconciliation suites (A-10).
- The rebuild rehearsal at scale (A-13).
- Failure injection (A-15) and concurrency (A-16).
- The missing negative controls (A-14).
- The S8 budgets (A-17).
- The TD-12 suites (A-19).
- The premortem matrix checker (T-18).

**Guards.** G-2, G-3, G-4, G-5 and Rule 22 are extended (A-18). No rule number is added: the static-guards count stays at S7's 23 (S7C:809).

**Gate.** `scripts/phase3-s8-gate.ts` composes `gate:phase3:s7` (§7).

### A-02 · Migration plan: exactly one migration, `<S8M>` (ENG)

P:45 expects "none", and the brief prefers zero. S8 needs one, because of a real gap between the lock and the tree:
- L:1252 requires "the read side runs as `daftar_reconciler`".
- L:1240-1250 requires two integer comparisons over `stock_movements`, `stock_levels` and the GL balance of the `inventory` system account.
- The reconciler holds **no privilege on any stock table**:
  - `0059:372-377` grants only `daftar_app` and the internal role;
  - the apply-time block `0059:516-523` asserts the reconciler reads none;
  - `0051` grants it `accounts (tenant_id, business_id, id, type)` only (`0051:173`; `infrastructure/database/reconciler-privilege-model.json:20`). That excludes `system_key`, the only stable identity of account 1200 (`0040:30,53`), which is the identity every Phase 3 guard uses (`0061:1423-1425`).
- The P2-S8 reader already reports a check whose columns it cannot read as `unavailable` rather than `ok`. It probes with `has_any_column_privilege`, in `apps/api/src/modules/accounting/accounting-reconciliation.reader.ts`. So without `<S8M>`, AL-43 can only ever answer "could not inspect".

**Content, in order:**
1. **Preconditions.** Refuse unless the S7 head is applied and `daftar_reconciler` exists.
2. **Column read grants.** Every grant is to `daftar_reconciler`, and every column is in the reconciler model:
   - `GRANT SELECT (tenant_id, business_id, id, warehouse_id, variant_id, stock_seq, movement_kind, source_type, source_id, source_line_id, qty_delta, value_delta_base_minor) ON stock_movements`. It excludes `reason` (free text), `actor_user_id`, `unit_cost_base_minor` and `created_at` (`0059` stock_movements definition).
   - `GRANT SELECT (tenant_id, business_id, warehouse_id, variant_id, on_hand, valuation_base_minor, last_stock_seq) ON stock_levels`. It excludes `avg_unit_cost_base_minor`, which is a derived quotient, never an input (L:1225-1229).
   - `GRANT SELECT (tenant_id, business_id, source_type, source_id, source_line_id, movement_kind) ON stock_source_bindings`, which is every column.
   - `GRANT SELECT (system_key) ON accounts`.
3. **Only under R-B1a**, the guard of §2.4.
4. **The end-state block**, §2.3.

**What `<S8M>` does not contain:**
- No table, view, index or policy. The existing RLS admits a scoped reader: `tenant_membership` plus the restrictive `business_isolation`, at `0059:322-339`. The reconciler reads inside the per-business scoped transaction of the P2-S8 reader.
- No function, except R-B1a's guard.
- No write privilege, no `REVOKE` of any existing grant, and no ownership transfer, except R-B1a's (§2.4).

TD-12 needs no migration (A-19).

**Numbering.** The S8 gate derives the file name from the S7 boundary (§7.1). The plan's "none expected" (P:45) is superseded by this ruling. P:30 marks numbering as "planning only".

### A-03 · Discovering the Phase 3 surface (ENG)

Every S8 security law is evaluated over sets **discovered from the live catalogue**, per §0. A new helper, `tests/helpers/phase3-surface.ts`, builds them:
1. It builds a throwaway database from `migrationsUpTo('0052…')`, the helper at `tests/integration/migration-upgrade.test.ts:48`, and snapshots `pg_class`, `pg_attribute`, `pg_proc` (with `md5(prosrc)`) and `pg_roles`.
2. It diffs that snapshot against the shared S8-head database.

It exports:
- `phase3Tables()` and `phase3Columns()`
- `phase3Routines()` (created ∪ replaced)
- `truthTables()` (from the ACL)
- `runtimePrincipals()` (`rolcanlogin`, minus `daftar_migrator` and `rolsuper`)
- `registeredOpKinds()` (`SELECT op_code FROM inventory_operation_kinds`)

**Nothing in S8 enumerates a Phase 3 table, routine or kind by hand, except the exact exception sets this contract names.** Each exception set is asserted by equality, so a new member fails the test until a reviewer adds it here.

### A-04 · The writer-authority law, catalogue-discovered (ENG)

**Law.** For every Phase 3 routine, of any owner, whose body writes (`INSERT`, `UPDATE` or `DELETE`) a truth table:
1. **The first executable statement** calls `inventory_assertion_consume('<literal op>', …)` (an entry routine) or `inventory_assertion_current(…)` (a primitive or helper). This is the rule-22 shape of `scripts/guards/inventory-writer-authority.ts:102,175`.
2. **Every function called inside that statement's arguments** is `IMMUTABLE` or `STABLE` in `pg_proc.provolatile`, writes nothing, and is either a `pg_catalog` function or a routine owned by `daftar_inventory_internal`. This is a property check over `pg_proc`, not a name list.

   At `95ff5a9` the called set is:
   - `inventory_claimed_payload_digest` (`STABLE`, `0054:285-290`)
   - `inventory_fixed_text` and `inventory_reason_words` (`IMMUTABLE`, `0062:71-72,96-97`)
   - the built-ins `unnest`, `cardinality`, `to_char`, `lower`, `extract`, `trunc`, `generate_series` and `array_fill`
3. **No `EXCEPTION WHEN`** block and no `DECLARE` initialiser that runs a query. These are the existing rule-22 checks (`inventory-writer-authority.ts:195`).

**Exact exception set** (asserted by equality): `{ warehouses_home_branch_maintain }`. It is the derived home-association maintainer that L:1837-1839 and L:2161 exclude, because the frozen `provision_create_business` cannot mint an assertion. Its completeness and keep-one triggers write nothing.

The key-domain routines write only excluded tables, so they fall outside the law by the truth-table definition, not by exception:
- `inventory_assertion_key_install` and `inventory_assertion_key_retire` write the keys, under the L:1868 contract;
- `inventory_assertion_consume` writes the uses.

**Measured at `95ff5a9`** (a static simulation over the migrations, scratch `s8/scan.ts`):
- 123 routines are transferred to the internal role, and G-7 finds 0 violations.
- Every routine that writes a Phase 3 table outside the key domain opens with consume or current, except the maintainer.
- Rule 22 as written today would reject **18** entry routines if its table set were simply widened, because their consume arguments call the digest helpers. The affected routines are:
  - the six S3 stock commands;
  - `supplier_create` and `supplier_update`;
  - `purchase_save_draft` and `purchase_receive`;
  - `purchase_return` and `purchase_reverse`;
  - `payment_method_create` and `payment_method_update`;
  - `supplier_pay`, `supplier_allocate_credit` and `supplier_receive_refund`.

  That is why clause 2 replaces rule 22's "arguments call no function" with the purity property. The static widening is A-18(e).

**Dynamic half (T-02).** For every discovered writer that is not a trigger function:
- The test calls it as its owner (`SET ROLE`, in a superuser test session), with typed `NULL` for every argument and no `app.inventory_assertion`.
- It must refuse with `inventory.assertion_missing` or `inventory.assertion_not_consumed`, with every truth table byte-identical.
- Arguments cannot matter, because the assertion call is the first statement. A writer whose refusal code is anything else fails.

### A-05 · Operation kinds: exactly one consuming routine each, none generic (ENG)

Registered at `95ff5a9` plus the S6 candidate: **26 kinds**.

| Registered at | Kinds | Consuming routine (consume call) |
|---|---|---|
| `0054:58-61` (S1) | `inventory.configure_product`, `structure.associate_warehouse_branch`, `structure.dissociate_warehouse_branch` | `inventory_configure_product` (`0055:132`, replaced `0060:809`); `structure_associate_warehouse_branch` `0056:296`; `structure_dissociate_warehouse_branch` `0056:358` |
| `0062:1515-1518` (S3) | `inventory.transfer`, `.adjust`, `.damage`, `.stocktake_open`, `.stocktake_count`, `.stocktake_finalize`, `.opening` | `0062:265, 427, 621, 781, 886, 1053, 1299` |
| `0064:1499-1501` (S4) | `supplier.create`, `.update`, `.archive`, `.reactivate`; `purchase.draft`, `.cancel`, `.receive` | `0064:365, 446, 524, 595, 718, 1023, 1172` |
| `0066:886-887` (S5) | `purchase.return`, `purchase.reverse` | `0066:360, 680` |
| `0068:1277-1280` (S6) | `payment.create_method`, `.update_method`, `.deactivate_method`, `.activate_method`; `supplier.pay`, `.allocate_credit`, `.receive_refund` | `0068:74, 175, 280, 353, 526, 841, 1061` |

**Law (T-03), over the catalogue:**
1. For every `op_code` in `inventory_operation_kinds`, exactly one `pg_proc` row has a `prosrc` containing the literal `inventory_assertion_consume('<op_code>'`. It is owned by `daftar_inventory_internal`, and its `EXECUTE` grantees are exactly `{daftar_app}`.
2. Every routine that calls `inventory_assertion_consume` does so exactly once, and its first argument is a **string literal**. A parameter, a variable, a `CASE` or a concatenation is a failure. This means no routine accepts a kind on another's behalf (L:1928).
3. The `op` component of the digest call in the same statement equals that literal.
4. Every `op_code` named in any `inventory_assertion_current(ARRAY[…])` literal, and every `inventory_operation_movement_kinds.op_code`, is registered. The mappings are at `0062:1519-1522`, `0064:1502-1503` and `0066:888-889`.
5. No registered `op_code` equals or contains `inventory.write`, `inventory.execute`, `trusted_inventory_command`, `*`, `%` or `,`, and every one matches `^[a-z]+(\.[a-z_]+)+$` (L:1864, L:1928).
6. No routine consumes a kind that is not registered. The literal must be in the registry.

**Rebuild swap.** No kind is registered for it (A-13), consistent with L:1992.

### A-06 · PM-44…PM-46 re-run against every registered kind (ENG)

**Today's coverage is per slice and uneven:**

| Slice | Suite | Rows it covers |
|---|---|---|
| S1 | `tests/security/inventory-signed-authority.test.ts` | the full rows: scope `:369-393`, forgery `:426-580`, cross-protocol `:563`, expiry/TTL `:582-620`, wrong op `:625`, field alteration `:660`, replay `:689`, and a negative control `:1007-1117` |
| S3 | `tests/security/inventory-s3-authority.test.ts:76-168` | missing, wrong op, tamper, replay |
| S4 | `tests/security/purchase-s4-signed-authority.test.ts:67-190` | none, forged, expired, wrong op, tamper, replay, scope |
| S5 | `tests/security/purchase-s5-signed-authority.test.ts:177-340` | likewise |
| S6 | S6C T-02 | planned |

S3 has no cross-protocol row and no negative control. S4 and S5 have no cross-protocol row and no negative control.

**Ruling.** One suite, `tests/security/phase3-s8-signed-authority-matrix.test.ts` (T-01), is **driven by `registeredOpKinds()`**.

**Builders.** `tests/helpers/op-kind-builders.ts` exports `OP_KIND_BUILDERS: Record<string, OpKindBuilder>`, where each builder has:
- `prepare(fixture)`: the minimum preconditions, built through the real commands;
- `routine`: the discovered entry routine (A-05);
- `args(state)`;
- `fields`: every signed payload field, each with an alternative value;
- `financial`: `true` when the routine posts, discovered by a `prosrc` call to `accounting_post_entry` or `accounting_post_reversal`, and asserted equal to the builder's flag.

The builder keys must **equal** the registered set. A registered kind with no builder fails the suite, and so does a builder for an unregistered kind.

**Rows, for every kind.** "Tables identical" means every truth table, `inventory_assertion_uses` and the journal tables are byte-identical before and after (an ordered-row digest).

| # | Attack | Expected |
|---|---|---|
| a | no carrier | `inventory.assertion_missing`; tables identical |
| b | malformed carrier (9 components; bad base64) | `inventory.assertion_malformed` |
| c | unknown `kid` | `inventory.assertion_key_unknown` |
| d | MAC by a random 32-byte key | `inventory.assertion_invalid_signature` |
| e | expired; TTL over 60 s (L:2043) | `inventory.assertion_expired`; `inventory.assertion_ttl_exceeded` |
| f | minted for each of the **other 25** kinds | `inventory.assertion_wrong_operation` |
| g | each signed field altered in turn | `inventory.assertion_payload_mismatch` |
| h | tenant or business claim of another business; GUC ≠ claim | `inventory.assertion_scope_mismatch` |
| i | replay in the same transaction; replay in another transaction after commit | `inventory.assertion_replayed` (L:1994-2003) |
| j | first use rolled back, the same assertion re-presented within TTL | accepted exactly once, then `assertion_replayed` (L:2003) |
| k (PM-46) | the same claims MAC'd with the **accounting** key and with the **provisioning** key under the inventory `kid` | `inventory.assertion_invalid_signature`. For a financial kind, also: an `invctl/1` string in the accounting carrier is refused by the accounting verifier, and an accounting assertion in `app.inventory_assertion` is `inventory.assertion_malformed` |
| l (PM-44) | direct call from every runtime principal other than `daftar_app` | `42501`; `has_function_privilege` false for all of them and PUBLIC |

**Negative control.** In a scratch database, `inventory_assertion_consume` and `inventory_assertion_current` are replaced (as their owner) by stubs that return the claims unverified. Rows a–i must then **succeed** for at least one kind of every registering slice (S1, S3, S4, S5, S6). This proves the matrix measures the verifier, as `:1007-1117` does for S1.

**Size.** 26 kinds × about 40 rows, each in a rolled-back transaction. The CI budget is ≤ 120 s (A-17). The existing per-slice suites stay; T-01 does not replace them.

### A-07 · The runtime grant matrix (ENG)

The intended model is `infrastructure/database/phase3-runtime-grant-model.json`, a new file. It uses the reconciler-model pattern (`reconciler-privilege-model.json:4`, "the INTENDED model … compared in both directions"). It states, per runtime principal and per Phase 3 table:
- the exact `SELECT` (table or column level);
- **no** `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES` or `TRIGGER` at any level, for any runtime principal or PUBLIC, on any Phase 3 table;
- the Phase 3 routines each runtime principal may `EXECUTE`: `daftar_app` the 26 entry routines plus the read functions S7 adds; `daftar_platform` the two `inventory_assertion_key_*` (L:1868); every other principal nothing.

**T-04 compares the model with the live catalogue in both directions.** It covers `has_table_privilege` and `has_any_column_privilege` for every `(principal ∪ PUBLIC) × phase3Tables() × privilege`, plus `aclexplode` over `relacl` and `attacl`. It then proves the negative half with **real DML** from every runtime credential on every Phase 3 table, each refused with `42501`. This generalises `tests/security/stock-ledger-authority.test.ts:188-212` from `S2_RELATIONS` to the discovered set.

**Phase 3 columns on pre-Phase-3 tables.** Here the runtime table-level `UPDATE` is accepted Phase 1 surface: `0006:77-78`, the defect of L:9. T-04 asserts:
- the runtime DML on those tables is exactly the frozen Phase 1 set;
- every Phase 3 column on them is protected by its named invoker guard, `products_10_inventory_config_authority` and `product_variants_10_base_variant_authority` (L:1595). A raw `daftar_app` `UPDATE` of each Phase 3 column is refused with its stable code.

The existing proofs are `tests/integration/stock-ledger-unit-lock.test.ts:137` and `tests/integration/catalog-base-variant.test.ts:202`.

**Measured at `95ff5a9`.** Every Phase 3 grant to a runtime role is `SELECT`: `0053:249-250`, `0056:145`, `0059:372`, `0061:1813`, `0063:589`, `0065:520`, `0067:546`. Every write grant is to the internal role: `0061:1816-1825`, `0063:593-605`, `0065:522`, `0067:549-556`. T-04 is expected green on arrival. Its negative control is a scratch `GRANT INSERT ON supplier_payments TO daftar_app`, which T-04 must report.

### A-08 · The SECURITY DEFINER law over every Phase 3 routine (ENG; replaced pre-Phase-3 routines ENG+TL, TL-3)

**What exists today.** The §D sweep at `tests/security/search-path-shadowing.test.ts:469-643` is catalogue-discovered, but only over routines **owned by `daftar_inventory_internal`**. The accounting-owned Phase 3 routines are covered by the generic audit at `:281-467`. That audit checks path order and temp relations, **not** a NOLOGIN owner.

**The Phase 3 surface.** At `95ff5a9` there are 151 `SECURITY DEFINER` headers in `0053`–`0068`. Resolving `ALTER FUNCTION … OWNER TO` statically:
- 126 go to `daftar_inventory_internal` and 18 to `daftar_accounting_internal`;
- 7 need the catalogue to resolve (multi-line signatures).

**T-05, over `phase3Routines()`:**
1. Every `SECURITY DEFINER` routine has `proconfig` containing exactly `search_path=pg_catalog, public, pg_temp`. That means `pg_temp` is named and last (L:1689).
2. Its owner has `rolcanlogin = false` and is one of `{daftar_inventory_internal, daftar_accounting_internal}`.
3. `has_function_privilege('public', oid, 'EXECUTE')` is false for **every** Phase 3 routine, definer or invoker.
4. Trigger functions have no `EXECUTE` grantee at all (L:1691).
5. No Phase 3 routine creates or depends on a temporary relation. That means no `CREATE TEMP`/`TEMPORARY` in `prosrc`, and no `pg_depend` edge to a `pg_temp_*` namespace.
6. No dynamic SQL built from input: `EXECUTE` appears in `prosrc` only as `format()` with `%I`/`%L` over constants (L:1694).
7. No Phase 3 `SECURITY DEFINER` routine is owned by `daftar_migrator`, **except the exact set of replaced pre-Phase-3 routines** (TL-3). `provision_actor` was re-created "by its owner, the migrator" in `0061:134,225` for TD-13; `accounting_actor` was re-created in `0061`. These keep their accepted Phase 1/2 owner. Changing a Phase 1 owner is outside S8.

**Static half.** With G-5's frozen skip lifted for files after `0052` (A-18(d)), `findDefinerSearchPathViolations` reports **0** violations over `0053`–`0068` at `95ff5a9`. That was measured in scratch `s8/g5.ts`.

**Negative controls:**
- a scratch `ALTER FUNCTION supplier_pay(...) SET search_path = public, pg_temp, pg_catalog` (the order clause fails);
- a scratch `ALTER FUNCTION … OWNER TO daftar_migrator` (the owner clause fails);
- a scratch `GRANT EXECUTE … TO PUBLIC`.

### A-09 · Runtime TEMP and CREATE on public stay zero — the reconciler included (ENG)

`tests/security/search-path-shadowing.test.ts:57` lists six runtime roles and **omits `daftar_reconciler`**. `tests/helpers/stock-ledger.ts:49-57` has all seven. The reconciler's TEMP privilege is checked only by `tests/security/reconciler-authority-matrix.test.ts:129`.

S8 adds `daftar_reconciler` to `RUNTIME_ROLES` at `:57`, with its URL from the helpers (pin 5, §7.3). T-04 also asserts, for every member of `runtimePrincipals()`:
- `has_database_privilege(r, current_database(), 'TEMPORARY') = false`;
- `has_schema_privilege(r, 'public', 'CREATE') = false`;
- a real `CREATE TEMP TABLE` and `CREATE TABLE public.x` are each refused.

The discovered set equals the L:1660 seven exactly. A new login role fails until it is added to the model.

### A-10 · Inventory ↔ GL reconciliation: R-INV-01…05, zero tolerance (ENG; scope of R-INV-01 is **B-1**)

**Framework.** The checks are added to the P2-S8 framework (`packages/accounting/src/reconciliation.ts`) as a **second, separate id list**:

`INVENTORY_RECONCILIATION_CHECK_IDS = ['R-INV-01','R-INV-02','R-INV-03','R-INV-04','R-INV-05']`

The R-ACC list and its tests are untouched (TL-5). `RECONCILIATION_CHECK_IDS` stays at nine (`:32`). The planted suite computes `clean` over that list (`tests/security/accounting-reconciliation-planted.test.ts:146`), so adding to it would turn Phase 2 fixtures that post manual lines on 1200 red for a reason unrelated to their check.

The reconciler **service** runs both lists in one pass. `accounting-reconciliation.service.ts:75` logs `RECONCILIATION_CHECKS.length`; it becomes the combined count (pin 10).

**The result contract is unchanged:**
- statuses `ok`, `discrepancy`, `error` and `unavailable`;
- `offendingCount` plus at most `MAX_OFFENDING_IDS = 20` UUIDs (`:172`);
- `correction: NO_CORRECTION_NOTICE` (`:169`);
- **no amount, quantity or currency**, enforced by `assertSafeCheckResult` (`:295`).

**Semantics.** Every comparison is an **integer** equality: `BIGINT` sums taken as `numeric`, with no division and no rounding (L:1242-1247). Each check runs per business, inside the reader's scoped transaction.

| Id | Question | SQL shape | Offending ids |
|---|---|---|---|
| R-INV-01 | `Σ stock_movements.value_delta_base_minor = GL(Inventory)` (L:1244, PM-16, PM-31). GL(Inventory) is `Σ (debit_minor − credit_minor)` over `journal_lines` on the account with `system_key = 'inventory'`, the exact expression of `0061:1425` | two aggregates, one comparison | the business id |
| R-INV-02 | Cache = ledger, per key and in total (L:1245, PM-01, PM-26). For every `(warehouse, variant)`: `on_hand = Σ qty_delta`, `valuation_base_minor = Σ value_delta_base_minor`, `last_stock_seq = max(stock_seq) = count(*)` (gapless from 1, L:191); no movement without a level row; no non-zero level row without movements. And `Σ stock_levels.valuation_base_minor = Σ movements`, stated separately so both comparisons of L:1245 appear literally | `GROUP BY` over `stock_movements_key_seq_uq` | variant ids |
| R-INV-03 | Empty stock carries no value (PM-27): `on_hand = 0 ⇒ valuation_base_minor = 0` | cache scan | variant ids |
| R-INV-04 | No second rounding (PM-31, `PM:437`): no journal entry that has a line on `inventory` also has a line on `rounding` (`6100`, `0040:65`) | a join over lines and accounts | journal entry ids |
| R-INV-05 | Every movement has its binding, and every binding its movement (PM-29, `PM:407`). An anti-join both ways on `(business_id, source_type, source_id, source_line_id, movement_kind)` | two anti-joins | movement ids; the binding's `source_line_id` |

The source-line → movement half of PM-29's detection is already a permanent catalogue discovery: `inventory_stock_source_guard_gaps()`, via `tests/integration/purchase-s4-gaps.test.ts:127-154` and `purchase-s5-gaps.test.ts:102-131`. R-INV-05 does not re-derive it. That would need grants on every source table, against the column-minimal model of P2-S8 §13.

**Proof:**
- **T-06:** every check is `ok` over the long mixed sequence of T-08.
- **T-07:** planted defects, each in a scratch database, each firing **exactly** its own check with UUID-only output:
  - one level row nudged by one minor unit (R-INV-02);
  - one 1200 journal line raised by one unit on both sides (R-INV-01 only);
  - a zero-quantity key with value 1 (R-INV-03);
  - a 6100 line added to an inventory entry (R-INV-04);
  - a binding deleted and a movement orphaned, with the deferred FKs dropped in scratch (R-INV-05).
- **Tolerance negative control.** T-07 includes a planted `+1` and asserts `discrepancy`. A reconciler that compared within ±1 would have said `ok`. This is the literal proof of `PM:681` (cross-cutting 4).

### A-11 · Reconciler read authority (ENG)

**The model file.** `infrastructure/database/reconciler-privilege-model.json` gains:
- the three stock tables with exactly the `<S8M>` columns;
- `system_key` in `accounts` (`:20`);
- `mustNotRead` additions: `inventory_assertion_keys`, `inventory_assertion_uses` and `suppliers`. `suppliers` holds names, phones and tax identifiers (`tests/integration/purchase-s4-supplier.test.ts:299`).

`executableRoutines` stays exactly one (`:41`). `writePrivileges` stays empty, and `temporary`/`createOnSchemaPublic` stay false.

**Suites:**
- `tests/security/reconciler-authority-matrix.test.ts` already compares the model with the live catalogue in both directions (model `:4`). It needs no logic change.
- T-16 adds a real read of each new column as the reconciler under business scope (accepted), and a read of each excluded column (`reason`, `actor_user_id`, `unit_cost_base_minor`, `avg_unit_cost_base_minor`) refused with `42501`.
- T-16 also runs cross-business: the reconciler scoped to A reads zero rows of B.

**Process isolation is unchanged.** The reconciler still holds no assertion key (`apps/api/src/config.ts:127-220` pattern, L:1866).

### A-12 · The deferred reconciliation domains, truthfully (ENG+TL, TL-4)

`packages/accounting/src/reconciliation.ts:128-131` lists:
- `inventory-valuation`, "the inventory domain does not exist yet";
- `ar-ap-operational`, "customers and suppliers do not exist yet".

Both reasons are false after S6. S8:
1. **removes** `inventory-valuation`, which R-INV-01..05 now check;
2. **replaces** `ar-ap-operational` with two rows:
   - `ar-operational`: reason "customers do not exist yet", owning phase Phase 4.
   - `ap-operational`: reason "the supplier subledger ↔ Accounts Payable (2000) reconciliation is not in the Phase 3 plan (P:263 names inventory↔GL only)", owning phase "production pass".

No pin reads these strings (grep over `tests/` and `scripts/` at `95ff5a9`).

### A-13 · The rebuild rehearsal at scale, and the swap (ENG+TL, TL-1)

**The facts.**
- L:1234 requires "the rebuilt values replace the cache row in one statement, per key, inside the lock". L:1236 requires that "no endpoint, no admin command and no script … sets a cache value to a supplied number".
- `inventory_stock_fold` (`0060:517`) and `inventory_stock_verify` (`0060:581`) exist, have no `EXECUTE` grant, write nothing, and refuse `inventory.scope_mismatch` without a matching business GUC.
- **No swap routine exists.** S2C:180 says "No swap routine exists at S2". S2C:1445 (TL-5) deferred it to S8 with "its own slice and op kind". L:1992 says the swap "would need its own registered kind before any runtime path could reach it".

**Ruling. No stored swap routine is created.**

A stored routine that writes `stock_levels` must either consume an assertion or be a permanent exception to A-04:
- **Consuming** means registering a kind (for example `inventory.rebuild_key`), a minter path and an `EXECUTE` grant. That is a runtime path to a cache writer that no merchant command needs. It is exactly the "repair command" L:176 forbids in spirit.
- **An exception** weakens the one law S8 exists to make exact.

**The swap is therefore an operated incident procedure, rehearsed, not a product surface:**
1. **Detect.** R-INV-02 reports the key, or `inventory_stock_verify` does.
2. **Investigate.** Name the cause; L:1237 says the movements are truth.
3. **Authorize** a migration whose body is a `DO` block under `SET LOCAL ROLE daftar_inventory_internal`. That is the only way the migrator reaches the internal role's privileges (L:1809, P:283; `INHERIT FALSE`, `tests/security/inventory-db-authority.test.ts:175`). For each named key the block:
   - takes the key row `FOR UPDATE`, which is the lock of L:1232;
   - calls `inventory_stock_fold`;
   - `UPDATE`s the four columns the internal role may update (`0059:376`) to the folded values in **one statement**;
   - calls `inventory_stock_verify`, and raises unless it now reports equality.

   It never takes a supplied number.
4. **Re-run** R-INV-01..05.

The procedure text is `infrastructure/database/procedures/stock-rebuild-swap.sql.template`. It is **not** in `migrations/`, carries no function definition, and is recorded as TD-16. The debt text: "the rebuild swap is a rehearsed incident migration, not a stored routine; a runtime rebuild would need its own kind (L:1992)".

**The rehearsal (T-09), at the A-17 scale:**
1. **Clean verify.** Fold and verify every key of the scale dataset; every key reports equality. R-INV-02 is `ok`.
2. **Drift.** In a scratch database built from the real migrations, as the superuser, plant cache drift on 25 keys: ±1 minor on valuation, ±0.0001 on `on_hand`, a `last_stock_seq` off by one, and one level row for a key with no movement.
3. **Detection.** Verify and R-INV-02 report **exactly** those 25 keys. Nothing else is reported, and no amount appears.
4. **Swap.** Apply the template, instantiated for the 25 keys, **as `daftar_migrator`**, through the real migration runner as a throwaway migration file.
5. **Green.** Verify and R-INV-01..05 are all `ok`. The movement ledger is byte-identical before and after. Only `stock_levels` rows of the 25 keys changed.
6. **Concurrency negative control.** With the template's `FOR UPDATE` removed, a live `inventory.adjust` on one key interleaved between fold and `UPDATE` (with `waitUntilBlocked`) leaves verify red afterwards. With the lock present, the adjust waits and verify is green.
7. **Authority negative control.** Every runtime credential attempting the template's `UPDATE` gets `42501`. The migrator without `SET LOCAL ROLE` gets `42501`, because it holds no privilege on `stock_levels`.

### A-14 · The premortem as executable tests (ENG)

§6.2 maps PM-01…PM-46 to their existing tests (file:line) and states, per row:
- whether a negative control exists;
- what S8 adds.

The mapping is **machine-readable**: `tests/premortem/phase3-premortem-matrix.json`. It holds, for every `PM-xx`, `positive: [ "<file>::<it title prefix>" …]` and `negativeControl: [ … ]`.

T-18 (`tests/security/phase3-s8-premortem-matrix.test.ts`) asserts:
- the ids are exactly `PM-01`…`PM-46`;
- every referenced file exists;
- every referenced title prefix matches an `it(` in that file;
- every row has at least one of each.

The gate runs T-18 (§7.1). Where S4 and S5 have no labelled negative control, S8 adds it in `tests/integration/phase3-s8-negative-controls.test.ts` (T-12). Each control builds its scratch database with the shared helper, removes one named invariant, and shows the attack commits.

### A-15 · Failure injection across every financial kind (ENG)

**Today.** Atomicity is proven per slice:
- `tests/integration/inventory-s3-atomicity.test.ts:114-172`, cited PM-10/11;
- `purchase-s4-atomicity.test.ts` and `purchase-s5-atomicity.test.ts`;
- S6C plans its own.

**T-10** (`tests/integration/phase3-s8-failure-injection.test.ts`) is driven by the builders of A-06, restricted to kinds with `financial = true`. For each such kind it injects a fault at three points, using a scratch-database trigger that raises on a named condition:
1. after the stock half (the first `stock_movements` insert) and before the posting;
2. inside the posting (the first `journal_lines` insert);
3. at `COMMIT` (a deferred constraint trigger).

After each fault:
- nothing survives: no movement, level change, source row, binding, assertion use, journal entry or line, accounting binding, AP change, audit row or outbox row;
- the same assertion, re-presented within TTL, commits exactly once (L:2003).

**Negative control.** It uses the S3 seam negative control's technique, `tests/integration/inventory-seam-posting.test.ts:176`. The stock half is committed on a second connection (a split seam), and T-10 must then report the orphan and R-INV-01 must report the business.

### A-16 · Concurrency (ENG)

**Existing coverage is kept** (§6.2):
- PM-02: `tests/integration/stock-ledger-concurrency.test.ts:137-229`, `purchase-s4-concurrency.test.ts:89-143`
- PM-03: `stock-ledger-concurrency.test.ts:262-361`, `inventory-s3-concurrency.test.ts:140`
- PM-13: `purchase-s5-concurrency.test.ts`
- PM-15: S6C T-08

**T-11** (`tests/integration/phase3-s8-concurrency.test.ts`) adds a **cross-slice soak**. Two to four connections run 200 seeded-random commands over 4 warehouses × 20 variants × 3 suppliers: receipts, transfers in both directions, adjustments, returns, reversals, payments and credit allocations. It asserts:
- zero `40P01` (deadlock);
- every refusal is a stable domain code or `40001`, never an unclassified error;
- after the soak, R-INV-01..05 are `ok` and every key verifies.

The seed is printed, so a failure replays.

**Negative control.** In scratch, the S2 primitive (`0060:186` onward) is replaced by the internal role with one whose key-lock order is reversed for transfers. The soak must then observe `40P01` within its budget. This is the premortem's own PM-03 claim: "a retry where a lock order belongs" (`PM:682`).

### A-17 · Performance and scale (ENG; the numbers are ENG+TL, TL-7)

**Budget A stays at 15 ms** (`tests/performance/accounting-budgets.test.ts:54`).
- It is re-measured in isolation after `<S8M>`, as the S5 gate does (`scripts/phase3-s6-gate.ts:538-571` pattern).
- Under R-B1a, Budget B (60 ms, `:56`) is re-measured too, because the guard fires at `COMMIT` of a manual adjustment.
- Recorded P3 acceptances: S2 p95 9.29 ms, S3 p95 9.75 ms.

**Scale datasets** (`tests/performance/phase3-dataset.ts`, seeded and deterministic, `ANALYZE` on every measured table as `docs/PHASE_2_PERFORMANCE_BASELINE.md` §3 requires):

| Dataset | Built by | Tier 1 (CI, every push) | Tier 2 (local, `P3S8_PERF_TIER=2`) |
|---|---|---|---|
| **D-GL**: real commands, real GL | the real routines through the builders: receipts (10 lines each, 10 % foreign currency, landed cost on 5 %), transfers, adjustments, damage, one stocktake, returns, reversals, payments | 1,000 receipts, 300 transfers, 300 adjustments, 200 returns, 100 reversals, 1 stocktake of 500 lines, 300 payments: about 13,000 movements and 30,000 journal lines, 2,000 variants × 3 warehouses | ×10 |
| **D-LEDGER**: ledger-only volume | the S2 fixture path (`tests/helpers/stock-ledger.ts:579` `installStockFixture`, batched through `inventory_apply_stock_movements`) in a scratch database. No GL, so only R-INV-02/03/05 and fold/verify are measured on it | 60,000 movements over 6,000 keys | 1,000,000 movements over 50,000 keys |

**S8 budgets.** These are initial. The acceptance page records the actuals. A budget may be tightened; it is never loosened without the TL.

| Id | Measure | Tier 1 | Tier 2 |
|---|---|---|---|
| S8-R1 | R-INV-01..05, one business, D-GL | ≤ 20 s total | ≤ 120 s |
| S8-R2 | R-INV-02/03/05, D-LEDGER | ≤ 30 s | ≤ 300 s (matching Budget F, `:64`) |
| S8-V | fold + verify of **every** key, D-LEDGER | ≤ 60 s | ≤ 600 s |
| S8-B | dataset build, both datasets | ≤ 240 s | not bounded (recorded) |
| S8-M | T-01 matrix wall time | ≤ 120 s | — |
| A | Budget A p95 | ≤ 15 ms (unchanged) | — |

Tier 1 budgets run with **no parallel load** (SM:36), as a separate gate step after the functional suites.

### A-18 · Guard extensions to the Phase 3 surface (ENG)

| # | Rule | Where | What it misses today | Change |
|---|---|---|---|---|
| a | **G-3** no-authoritative-balance (Rule 15, `scripts/static-guards.ts:281-386`) | `scripts/guards/no-authoritative-balance.ts:202,328,331` | Discovery is by name: `INVENTORY_TABLE_NAME` (`:202`) and `SUPPLIER_TABLE_NAME` (`:328`). Seven Phase 3 tables escape both: `units`, `unit_names`, `branch_warehouses`, `stocktakes`, `stocktake_lines`, `payment_methods`, `payment_method_names` | The Phase 3 set becomes "every stored relation `discoverStoredRelations` finds in a migration after `PHASE2_PREFIX_END`". The names stay only to choose which column vocabulary applies. `STOCK_CACHE_EXCEPTION = 'stock_levels'` (`:205`) stays the one named exception. The `balance`/`settled` vocabulary and `payment_methods` are added **if S6 has not already** (S6C §7.2 plans it). Columns ending `_id` are exempt from the vocabulary, because `inventory_openings.opening_balance_id` (`0061:666`) is a reference, not a stored figure. This subsumes S7C TL-10 (S7C:902) |
| b | **G-2** no-float (Rule 16, `:388-419`) | `scripts/guards/no-float-rate.ts:116,159` | `INVENTORY_TABLE_RE` has the same prefixes, so the same seven tables escape the inventory numeric checks | Same discovery as (a) |
| c | **G-4** posting-surface (Rule 17, `:421-444`) | `scripts/guards/posting-surface.ts` | The ledger perimeter bans app-code DML and runtime DML grants **for ledger tables only**. There is no inventory equivalent | Add `INVENTORY_PERIMETER` = the (a) discovery set. (1) No `INSERT INTO`, `UPDATE` or `DELETE FROM` against a perimeter table in `apps/**` or `packages/**/src`. (2) No migration after `0052` `GRANT`s `INSERT`, `UPDATE`, `DELETE` or `TRUNCATE` on a perimeter table to any `daftar_*` role other than `daftar_inventory_internal`/`daftar_accounting_internal`. It is clean at `95ff5a9` (A-07) |
| d | **G-5** definer-search-path (Rule 18, `:446-470`) | `scripts/guards/definer-search-path.ts:154-163,213` | A frozen file is skipped entirely (`:163`, `:213`). Every Phase 3 file up to `0066` is therefore unchecked statically once frozen | The frozen skip applies only to files up to `PHASE2_PREFIX_END`. Files after it are checked forever. It is clean today: 0 violations with the skip lifted (A-08). A Phase 3 file's bytes cannot change (the manifest check), so this costs nothing and makes the static claim of P:265 true |
| e | **Rule 22** writer authority (`:546-560`) | `scripts/guards/inventory-writer-authority.ts:52,175` | `STOCK_WRITE_TABLES` (`:52`) covers the stock tables and `supplier_credit_notes` only | The table set becomes the static analogue of A-04's truth set: every table a migration after `0052` grants `INSERT`, `UPDATE` or `DELETE` to `daftar_inventory_internal`, minus the four excluded tables. `assertionFirstProblem` (`:175`) admits calls to (i) routines whose own `CREATE FUNCTION` header in the migrations says `IMMUTABLE` or `STABLE` and whose body contains no DML, and (ii) the built-ins listed in A-04 clause 2, whose volatility T-02 proves live. The exception set is exactly `{warehouses_home_branch_maintain}`. The test pin is `tests/integration/inventory-db-guard.test.ts:185` (§7.3 pin 8) |

**Guard tests.** `tests/integration/phase3-s8-guards.test.ts` (T-14) shows each extended rule firing on a fixture migration or source file, and clean on the real tree:
- (a)/(b): a stored `balance` column added to `payment_methods`, and a `REAL` column added to `units`;
- (c): an `UPDATE stock_levels` in an `apps/api` file, and a `GRANT INSERT ON suppliers TO daftar_app` in a migration;
- (d): a Phase 3 definer with `pg_temp` first;
- (e): a routine writing `purchases` without an assertion, and a consume argument calling a `VOLATILE` helper.

### A-19 · TD-12: one effective-key comparison for every pair of assertion keys (ENG+TL, TL-2)

**Facts.**
- TD-12 is at `TECHNICAL_DEBT.md:21` and routed to S8 by SM:72.
- `hmacKeysEquivalent` (`packages/inventory/src/assertion.ts:160`) compares the **effective** HMAC-SHA-256 key: keys over 64 bytes are hashed, and trailing zero bytes are stripped (RFC 2104). Its tests are `packages/inventory/test/assertion.test.ts:308-367`.
- It is used by `apps/api/src/config.ts:2,331,334`, `apps/api/src/modules/inventory/inventory-assertion.minter.ts:6,52,55` and `scripts/install-inventory-key.ts:34,46,50`.
- **The accounting/provisioning pair compares bytes** in three places:
  - `config.ts:306-315` uses `Buffer.equals`, the only `equals(` in the file;
  - `apps/api/src/modules/accounting/accounting-assertion.minter.ts:34-38` uses `secretsAreIdentical` (`packages/accounting/src/assertion.ts:91`);
  - `scripts/install-accounting-key.ts:38-41` uses `.equals`.
- `scripts/install-provisioning-key.ts:28-29` checks no pair at all.
- The permanent P2-S3 gate reads the comparison's shape at `scripts/phase2-s3-gate.ts:412`: `/equals\(|timingSafeEqual|compare\(/`. It turns red the moment `config.ts:310` stops using `equals(`.

**Where the single implementation lives: `@daftar/accounting`**, new module `packages/accounting/src/assertion-keys.ts`. It exports `effectiveHmacKey(key: Buffer): Buffer` and `hmacKeysEquivalent(a: Buffer, b: Buffer): boolean`. The body moves verbatim, using `node:crypto` only. It is re-exported from `packages/accounting/src/index.ts`.

Why not the alternatives:
- **Not a new workspace.** The exact workspace set is pinned by the permanent `scripts/phase1-gate.ts:64-77`, twice by `.github/workflows/ci.yml:30,36,43`, and by `scripts/check-supply-chain.ts:105`. Four permanent pins churn for a 30-line function.
- **Not `@daftar/domain-core`.** It reaches the web bundle through `@daftar/shared-contracts` (`packages/shared-contracts/src/index.ts:392`), and CommonJS `main: dist/index.js` would load `node:crypto` there.
- **Not left in `@daftar/inventory`.** Accepted Phase 2 accounting code would then import a Phase 3 domain package.
- `@daftar/inventory` has **no internal caller** of the function. Removing it therefore leaves the S3 gate's import rule (`scripts/phase3-s3-gate.ts:391-400`) untouched: the inventory package still imports only `./` and `node:`.

**Every pair, at every site.** "Every pair" means accounting↔provisioning, inventory↔provisioning and inventory↔accounting.

| Site | Pairs checked after S8 |
|---|---|
| `apps/api/src/config.ts` (production validation) | accounting↔provisioning (`:306-315`, now `hmacKeysEquivalent(Buffer.from(c.ACCOUNTING_ASSERTION_KEY,'base64'), Buffer.from(c.PROVISIONING_ASSERTION_KEY,'base64'))`); inventory↔both (`:331,334`, import moved to `@daftar/accounting`) |
| `accounting-assertion.minter.ts:34-38` (every mode, at key load) | accounting↔provisioning |
| `inventory-assertion.minter.ts:52,55` | inventory↔both (import moved) |
| `scripts/install-accounting-key.ts:38-41` | accounting↔provisioning; **added:** accounting↔inventory when `INVENTORY_ASSERTION_KEY` is set |
| `scripts/install-inventory-key.ts:46,50` | inventory↔both (import path `../packages/accounting/src/assertion-keys`) |
| `scripts/install-provisioning-key.ts:28-29` | **added:** provisioning↔accounting and provisioning↔inventory when either is set. The check runs before any connection, as the other two scripts do |

**Unchanged:**
- `apps/api/src/infra/provisioning-assertion.ts`, which is Phase 1 surface. The pair is enforced from the other side at key load in every mode.
- `secretsAreIdentical` in both packages stays exported: it is accepted API with tests at `packages/accounting/test/assertion.test.ts:166-168` and `packages/inventory/test/assertion.test.ts:297-304`. It is no longer used at any key-pair site. The S8 gate asserts this (§7.1).

**The P2-S3 gate evolves in the same commit** (pin 6, the P2-S4 §45 form). `scripts/phase2-s3-gate.ts:412` becomes:
- **ok** when `config.ts` contains a `hmacKeysEquivalent(` call whose argument text names both `ACCOUNTING_ASSERTION_KEY` and `PROVISIONING_ASSERTION_KEY`;
- **fail**, with the existing §16 message, otherwise;
- **fail** additionally when `config.ts` contains `.equals(` at all. A byte comparison anywhere in key validation is the defect TD-12 names.

The `ok` text becomes "the configuration refuses to start when the accounting key is HMAC-equivalent to the provisioning key".

TD-12 is closed in `TECHNICAL_DEBT.md` at S8 acceptance. TD-14 is **not** absorbed: the key-install model is unchanged (SM:73).

### A-20 · OD-03 stays bounded (ENG)

S8 adds no tax object, column or line. T-04's catalogue sweep additionally asserts that no Phase 3 table has a column matching `(^|_)tax(_|$)` other than those the S4/S5 tax suites pin:
- `purchases.tax_minor`, held at zero by `purchases_tax_policy_absent_ck` (`tests/security/purchase-s4-tax.test.ts:153`);
- the supplier tax identifier, which is a text snapshot, not an amount.

The existing proofs are `purchase-s4-tax.test.ts:88-153` and `purchase-s5-tax.test.ts:44-53`.

### A-21 · What S8 does not do (ENG)

S8 does not:
- create a stored swap routine or a rebuild operation kind (A-13);
- add a reversal of an S6 payment, allocation or refund. That is TD-15, and PM-12's recovery keeps no path (TL-8);
- change the key-install model (TD-14);
- add web UX;
- add a customer/AR reconciliation;
- add a new refusal code, other than R-B1a's;
- reorder or rename any accepted guard rule;
- edit a frozen file.

---

## 2. Database contract

### 2.1 `<S8M>` order (normative)

1. **Header.** It cites this contract, A-02 and L:1252.
2. **Preconditions** (`DO`). The S7 head relation set exists. `daftar_reconciler` exists with `rolcanlogin`, and not `rolsuper` or `rolbypassrls`. The four target tables exist with the named columns.
3. **The four `GRANT SELECT (…)` statements** of A-02.
4. **Only under R-B1a:** §2.4.
5. **End-state block**, §2.3. It raises `inventory.authority_leak: …`, the accepted code of `0059:516-523`.

### 2.2 Grants produced

| Grantee | Object | Privilege |
|---|---|---|
| `daftar_reconciler` | `stock_movements` (12 columns, A-02) | `SELECT` column-level |
| `daftar_reconciler` | `stock_levels` (7 columns) | `SELECT` column-level |
| `daftar_reconciler` | `stock_source_bindings` (6 columns) | `SELECT` column-level |
| `daftar_reconciler` | `accounts.system_key` | `SELECT` column-level |
| `daftar_accounting_internal` (R-B1a only) | `stock_movements.business_id` | `SELECT` column-level |

No other grant, revoke or ownership change, except R-B1a's function ownership bracket (§2.4).

### 2.3 End-state assertions

1. `daftar_reconciler` holds, on every Phase 3 table, column `SELECT` on **exactly** the §2.2 columns and nothing else. There is no table-level `SELECT` on any of them (P2-S8 §13 column-grant law, `scripts/phase2-s8-gate.ts:612-618`). It holds no write privilege anywhere, and `TEMPORARY`/`CREATE ON SCHEMA public` are false.
2. The `daftar_app` read set on `stock_movements`/`stock_levels` is unchanged (`0059:372`). No other runtime role reads a stock table.
3. No function or policy was created, except R-B1a's function and trigger.
4. `SELECT count(*) FROM inventory_operation_kinds` equals the S7 head's count (26 at the S6 candidate). S8 registers nothing.

### 2.4 Only under R-B1a: the inventory-account domain guard (ENG, **B-1**)

**The function.** `accounting_inventory_account_domain_guard() RETURNS trigger`:
- `LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp`;
- owned by **`daftar_accounting_internal`**, because an accounting guard belongs to accounting authority (L:1105);
- `REVOKE ALL … FROM PUBLIC`, and no `EXECUTE` grant.

The ownership transfer is bracketed by `GRANT`/`REVOKE CREATE ON SCHEMA public` in the same file (`0040:247-263`, P:283).

**The trigger.** `journal_entries_45_inventory_account_domain` is a `CONSTRAINT TRIGGER AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.source_type IN ('manual_adjustment','opening_balance'))`. It is deferred because the lines follow the header, like the `0061` completeness triggers.

**The body.**
- If the entry has a line on the account whose `system_key = 'inventory'`, **and** `EXISTS (SELECT 1 FROM stock_movements WHERE business_id = NEW.business_id)`, it raises `accounting.inventory_account_domain_owned: after a business's first stock movement, the Inventory account changes only through an inventory or purchasing operation`.
- Otherwise it returns `NULL`.

RLS admits the read: postings run business-scoped, and `app_bypass()` admits all rows (`0059:322-327`). An owner or superuser session bypasses RLS.

**What it does not refuse:**
- a `reversal` entry. Reversing a pre-foundation manual or opening entry is the correction path for pre-foundation residue, and it always moves GL(1200) toward `Σ movements`;
- the entry of a business with no stock movement. Phase 2 behaviour is byte-identical there, which keeps the Phase 2 goldens unchanged (`tests/golden-regression/phase2/02-report-shapes.golden.test.ts:245,266`; `tests/integration/accounting-reports.test.ts:233-235`).

### 2.5 Managed PostgreSQL (P:275-285)

As `daftar_migrator`:
- fresh `0000 → <S8M>`;
- upgrade from the S7 head;
- rerun is a no-op;
- catalogue equivalent to a superuser build (`check:deployment-authority`).

T-17 adds the `<S8M>` checkpoint to `tests/integration/migration-upgrade.test.ts`, after the `:1988` checkpoint pattern. The migrator is never widened.

---

## 3. Error model

**SQL.** No new code, except under R-B1a: `accounting.inventory_account_domain_owned` (P0001).
- The application's accounting error map gains it with HTTP 422, in the same file that maps `accounting.reversal_source_domain_owned`.
- `@daftar/shared-contracts` gains the message key in all three locales. The localization check (`npm run check:localization`) proves parity.

**Reconciliation.** There are no new statuses. A check whose columns the reader cannot read is `unavailable`, never `ok`: that is the reader's existing `has_any_column_privilege` probe. A deployment without `<S8M>` therefore reports R-INV-01..05 `unavailable`, and T-16 proves it on a database migrated only to the S7 head.

**Tests and the gate.** They use the accepted failure labels, `fail('<area>', '<detail>')`. The S8 gate areas are `boundary`, `migration`, `reconciler-model`, `td12`, `suites`, `premortem`, `guards`, `perf` and `predecessor`.

---

## 4. Packages and application

### 4.1 `@daftar/accounting`

- **`src/reconciliation.ts`:**
  - adds `INVENTORY_RECONCILIATION_CHECK_IDS`, the type `InventoryReconciliationCheckId`, and five `ReconciliationCheckDefinition` rows with their `requires`: `stock_movements`, `stock_levels`, `stock_source_bindings`, `journal_lines`, `journal_entries` and `accounts`;
  - adds `ALL_RECONCILIATION_CHECK_IDS = [...RECONCILIATION_CHECK_IDS, ...INVENTORY_RECONCILIATION_CHECK_IDS]`;
  - updates `DEFERRED_RECONCILIATION_DOMAINS` per A-12.

  `reconcile()` keeps `options.checks ?? RECONCILIATION_CHECK_IDS` as its default (`:353`), so every Phase 2 caller is unchanged.
- **`src/assertion-keys.ts`** (A-19) and its re-export in `src/index.ts`.
- **`test/assertion-keys.test.ts`:** the vectors of `packages/inventory/test/assertion.test.ts:308-367`, moved verbatim, plus accounting/provisioning-named cases.

### 4.2 `@daftar/inventory`

- It removes `hmacKeysEquivalent` (and any helper used only by it) from `src/assertion.ts:160`, and the moved tests from `test/assertion.test.ts:308-367`.
- `secretsAreIdentical` (`:128`) and its tests (`:297-304`) stay.
- No other change. The S3 gate import rule stays green.

### 4.3 `apps/api`

- **`modules/accounting/accounting-reconciliation.reader.ts`:** the SQL for R-INV-01..05, in the reader's existing per-business scoped transaction with its statement timeout. Each check is guarded by the same `has_any_column_privilege` probe over its `requires`.
- **`modules/accounting/accounting-reconciliation.service.ts`:** it runs `ALL_RECONCILIATION_CHECK_IDS`, and logs and reports that count (`:75`).
- **`config.ts`, `accounting-assertion.minter.ts` and `inventory-assertion.minter.ts`:** A-19.
- **Under R-B1a:** the error map entry (§3).

### 4.4 Scripts

- `scripts/install-accounting-key.ts`, `install-inventory-key.ts` and `install-provisioning-key.ts`: A-19.
- `scripts/phase2-s3-gate.ts:412`: A-19.
- `scripts/phase2-s8-gate.ts:929-940`: §7.3 pin 2.
- `scripts/phase3-s8-gate.ts`: §7.1.
- `scripts/guards/*`: A-18.

### 4.5 Operations artefacts

- `infrastructure/database/procedures/stock-rebuild-swap.sql.template` (A-13).
- `infrastructure/database/phase3-runtime-grant-model.json` (A-07).
- The reconciler model update (A-11).
- `TECHNICAL_DEBT.md`: TD-12 closed, TD-16 opened, at acceptance.

---

## 5. Harness

**New helpers:**
- `tests/helpers/phase3-surface.ts` (A-03). It builds the `0052` prefix database once per run into its own `PG_DIR`. Budget: ≤ 30 s.
- `tests/helpers/op-kind-builders.ts` (A-06). One builder per registered kind. It reuses:
  - `mintFixtureAssertion` (`tests/helpers/stock-ledger.ts:382`)
  - `withRolledBackFixture` (`:588`)
  - `installStockFixture` (`:579`)
  - `expectRefused`, `atCommit`, `waitUntilBlocked`
  - the purchase and settlement helpers of S4, S5 and S6
- `tests/helpers/scratch-db.ts`: the scratch-database builder for every negative control. It is lifted from the pattern at `inventory-signed-authority.test.ts:1007-1117`, and builds from the real migration files, never from a copy.
- `tests/helpers/table-digest.ts`: an ordered-row digest of a table set, for "byte-identical" assertions.
- `tests/performance/phase3-dataset.ts` (A-17).
- `tests/premortem/phase3-premortem-matrix.json` (A-14).

**Isolation.** One `PG_DIR` per agent (SM:36). Tier 1 budgets run alone.

**Runtime budget.** The S8 suites, excluding performance, must fit **≤ 12 minutes** of CI wall time on the backend job. The largest are T-01 (≤ 120 s), T-09 (≤ 240 s including the D-LEDGER build) and T-11 (≤ 90 s).

---

## 6. Test plan

### 6.1 New suites

All run under `npm run test:integration`, except T-13 (`perf:phase2:s8` runs `tests/performance`) and T-15a (the package unit suite).

| # | File | Proves | Ruling |
|---|---|---|---|
| T-01 | `tests/security/phase3-s8-signed-authority-matrix.test.ts` | PM-44/45/46 × 26 kinds; negative control with the verifier stubbed | A-06 |
| T-02 | `tests/security/phase3-s8-writer-authority.test.ts` | the catalogue writer law, exact exception set, NULL-argument refusal, purity of consume arguments; negative control: a scratch writer without the assertion call | A-04 |
| T-03 | `tests/security/phase3-s8-operation-kinds.test.ts` | one consumer per kind, literal-only, digest-op coherence, current/mapping ⊆ registry, no generic kind; negative controls: a second consumer of `inventory.adjust`; `consume(p_op, …)` | A-05 |
| T-04 | `tests/security/phase3-s8-grant-matrix.test.ts` | model ↔ catalogue both ways; real DML refused; Phase 3 columns' guards; TEMP/CREATE for all seven; tax-column sweep; negative control: a scratch runtime `INSERT` grant | A-07, A-09, A-20 |
| T-05 | `tests/security/phase3-s8-definer-law.test.ts` | the seven clauses over `phase3Routines()`, with the TL-3 exception set; negative controls: path order, migrator owner, PUBLIC EXECUTE | A-08 |
| T-06 | `tests/integration/phase3-s8-reconciliation.test.ts` | R-INV-01..05 `ok` after the T-08 sequence; UUID-only output; `unavailable` at the S7 head | A-10 |
| T-07 | `tests/security/phase3-s8-reconciliation-planted.test.ts` | each planted defect fires exactly its check; the ±1 tolerance control; the reconciler cannot write (`42501` on every stock table) | A-10 |
| T-08 | `tests/integration/phase3-s8-mixed-sequence.test.ts` | PM-16's "long mixed sequence" (`PM:227`): receipts, transfers, adjustments, damage, stocktake, opening, supplier return, reversal, landed cost, foreign currency, payments, credit allocation and refund. R-INV-01 exact after every step. Negative control: the split seam of A-15 | A-10, A-15 |
| T-09 | `tests/integration/phase3-s8-rebuild-rehearsal.test.ts` | A-13 steps 1–7 at Tier 1 scale | A-13 |
| T-10 | `tests/integration/phase3-s8-failure-injection.test.ts` | three fault points × every financial kind; rollback-retry | A-15 |
| T-11 | `tests/integration/phase3-s8-concurrency.test.ts` | cross-slice soak; negative control with reversed lock order | A-16 |
| T-12 | `tests/integration/phase3-s8-negative-controls.test.ts` | every negative control §6.2 marks **S8 adds** | A-14 |
| T-13 | `tests/performance/phase3-s8-budgets.test.ts` | S8-R1, R2, V, B and M; Budget A (and B under R-B1a) in isolation | A-17 |
| T-14 | `tests/integration/phase3-s8-guards.test.ts` | A-18 (a)–(e) fire on fixtures and are clean on the tree | A-18 |
| T-15a | `packages/accounting/test/assertion-keys.test.ts` | the effective-key vectors | A-19 |
| T-15b | `tests/integration/assertion-key-separation.test.ts` | production config refuses accounting ≡ provisioning for `K`/`K‖0x00` and for a 65-byte key against its digest; both minters refuse at key load; each install script exits non-zero with the separation message **before connecting**, spawned with a dummy `BOOTSTRAP_DATABASE_URL`. Negative control: with `config.ts:310` reverted to `.equals` in a tree copy, the `K‖0x00` config is accepted | A-19 |
| T-15c | `tests/security/phase3-s8-gate-tamper.test.ts` | a hard-linked tree copy, as `tests/security/phase2-s8-gate-tamper.test.ts` does. (1) `hmacKeysEquivalent(` replaced by `.equals(`: `gate:phase2:s3` fails `key-separation`. (2) One `<S8M>` column added: the S8 gate fails `migration`. (3) One PM row removed from the matrix JSON: it fails `premortem` | A-19, §7 |
| T-16 | `tests/security/phase3-s8-reconciler-authority.test.ts` | per-column reads allowed and refused; cross-business zero rows; model equality | A-11 |
| T-17 | `tests/integration/phase3-s8-upgrade.test.ts` plus the `migration-upgrade.test.ts` checkpoint | §2.5 | A-02 |
| T-18 | `tests/security/phase3-s8-premortem-matrix.test.ts` | the matrix JSON is complete and resolves to real `it(` titles | A-14 |

### 6.2 The premortem matrix: PM-01 … PM-46

"NC" means a labelled negative control. It is marked **present** only where the file carries one per the S2–S3 labelling. S4 and S5 suites carry none. **S8 adds** means T-12 (or the named S8 suite) adds it.

| PM | Invariant | Existing positive test (file:line) | NC | S8 adds |
|---|---|---|---|---|
| 01 | cache = ledger | `tests/integration/stock-ledger-rebuild.test.ts:152` (T-06.1, ≥300 movements), drift `:311`, gap `:337` | present, `:398` T-06.N | R-INV-02 (T-06/T-07); rehearsal at scale (T-09) |
| 02 | concurrent receipts keep the average | `stock-ledger-concurrency.test.ts:137-229` (T-03); `purchase-s4-concurrency.test.ts:89-143` | present for S2 (T-03.N); **absent for S4** | S4 negative control: the primitive's key lock removed in scratch gives a wrong average (T-12); soak (T-11) |
| 03 | lock order, no deadlock | `stock-ledger-concurrency.test.ts:262-361` (T-04); `inventory-s3-concurrency.test.ts:140` | present (T-04.N) | cross-slice soak and its negative control (T-11) |
| 04 | a retry makes no duplicate movement | `stock-ledger-primitive.test.ts:343-357`; `inventory-s3-idempotency`; `purchase-s4-idempotency`; `purchase-s5-idempotency` | present for S2/S3; **absent for S4/S5** | scratch `DROP CONSTRAINT stock_movements_identity_uq` with the replay guard removed: a receipt replay duplicates (T-12) |
| 05 | a simple product has a variant | `tests/integration/catalog-base-variant.test.ts:12-245` | **absent** | scratch `inventory_configure_product` without base-variant creation: a tracked product has no stock key (T-12) |
| 06 | unit precision | `stock-ledger-primitive.test.ts:421-464` (T-08) | present (.N) | — |
| 07 | stocktake vs receipts | `tests/integration/inventory-s3-stocktake.test.ts` (cites PM-07) | present | — |
| 08 | landed cost rounds once | `purchase-s4-landed-cost.test.ts:68-167` | **absent** (tamper tests only) | scratch drop of the deferred allocation trigger: the `:111` tampered allocation commits (T-12) |
| 09 | a duplicate variant line | `purchase-s4-draft.test.ts:259-267` (`purchase.duplicate_variant`) | **absent** | scratch removal of the duplicate check: the average becomes order-dependent (T-12) |
| 10 | stock commits but accounting fails | `inventory-s3-atomicity.test.ts:114-172`; `purchase-s4-atomicity`; `purchase-s5-atomicity`; S6C atomicity | S3 present; S4/S5 **absent** | T-10 over every financial kind; split-seam negative control |
| 11 | accounting commits but stock fails | same | same | T-10 |
| 12 | payment over-allocates AP | S6C T-05 (`settlement-s6-*`, planned) | per S6C | presence pinned by the S8 gate via the S6 gate; recovery = TD-15 (TL-8) |
| 13 | return > received quantity | `purchase-s5-quantity-bound.test.ts`; `purchase-s5-concurrency.test.ts` (cite PM-13) | **absent** | scratch removal of the quantity-bound guard: an over-return commits (T-12) |
| 14 | return > warehouse stock | `purchase-s5-stock-bound.test.ts` (cites PM-14) | **absent** | scratch removal of the stock-bound check: stock goes negative (T-12) |
| 15 | credit consumed twice | S6C T-08 (planned) | per S6C | presence pinned; soak includes allocations (T-11) |
| 16 | GL ↔ valuation | `purchase-s5-reversal-exact.test.ts:67` ("the three agree"); `tests/helpers/purchase-returns.ts` | **absent**; no reconciliation check existed | R-INV-01 (T-06/T-07); long mixed sequence plus split-seam negative control (T-08) |
| 17 | future-dated entry | `inventory-db-routines.test.ts:836`; `accounting-sources.test.ts:270,522`; migration `0058` | **absent** | scratch drop of the `0058` trigger: the owner's raw `INSERT` dated tomorrow commits (T-12) |
| 18 | branch-scoped warehouse authority | `tests/security/inventory-s3-isolation.test.ts` (cites PM-18); `purchase-s4-isolation`; `purchase-s5-isolation` | S3 present | — (the S6 isolation stays with S6C) |
| 19 | historical rows never deleted | `inventory-s3-archival.test.ts:85-142`; `purchase-s4-immutability.test.ts:153-232` | present, `:142` | T-04 proves no runtime `DELETE` on any Phase 3 table; scratch drop of the purchase immutability trigger: a received line is deleted (T-12) |
| 20 | deficit covered twice | `purchase-s4-concurrency.test.ts:89-143` (T-09) | **absent** | scratch removal of the coverage lock: double coverage commits (T-12) |
| 21 | FIFO by `stock_seq`, never timestamps | `purchase-s4-coverage.test.ts:131-311`; static `stock-ledger-guards.test.ts:113` (T-12.3) | present (static) | — |
| 22 | receive-and-pay is one model | `purchase-s4-receipt.test.ts` (cites PM-22); S6C T-13 | per S6C | — |
| 23 | no invented tax | `purchase-s4-tax.test.ts:88-153`; `purchase-s5-tax.test.ts:44-53` | **absent** | scratch drop of `purchases_tax_policy_absent_ck`: `tax_minor = 1` commits (T-12); the T-04 tax sweep |
| 24 | the key stays in one process | `tests/integration/inventory-config.test.ts:125-184,281`; `process-composition` | present for inventory | T-15b, all three pairs |
| 25 | a whole unit is not padded | `stock-ledger-primitive.test.ts:421-464` | present | — |
| 26 | the rounded average never feeds valuation | `stock-ledger-vectors.test.ts:451-479` (T-05); rebuild T-06 | present | R-INV-02 at scale (T-09, T-13) |
| 27 | empty stock carries no value | `stock-ledger-vectors.test.ts:590-708` (T-10) | present | R-INV-03 (T-06/T-07) |
| 28 | no fake assertion, no split commit | `inventory-seam-posting.test.ts:147-197`; `inventory-seam.test.ts` | present | — |
| 29 | no movement without a source | `tests/security/stock-ledger-structure.test.ts` (T-14); `inventory-s3-transfer.test.ts:373` | present, `:693` | R-INV-05 plus planted orphan (T-07) |
| 30 | a line over many layers keeps every coverage | `purchase-s4-coverage.test.ts:294` (T-08.2) | **absent** | scratch coverage writer dropping all but the first coverage: Σ mismatch caught (T-12) |
| 31 | one rounding only | `stock-ledger-vectors.test.ts:496-577` (T-09/T-11) | present (.N) | R-INV-04; R-INV-01 at scale |
| 32 | one line, two movements, one binding each | `stock-ledger-structure.test.ts` (T-14) | present | — |
| 33 | binding for a line that never existed | `stock-ledger-structure.test.ts:693-710` | present | — |
| 34 | S1 atomicity is real | `inventory-seam-posting.test.ts:147-176` | present | — |
| 35 | manager does not silently gain authority | `inventory-permissions-provisioning.test.ts:126-139` | **absent** | a scratch provisioning writer that appends one Phase 3 key to manager: the exact-list test fails (T-12) |
| 36 | a new warehouse is reachable, and only by the right people | `inventory-warehouse-matrix.test.ts:204-346` | present, `:303` | — |
| 37 | unit locked after history | `stock-ledger-unit-lock.test.ts:104-188` | present, `:125` T-17.N | — |
| 38 | the base variant stays hidden | `catalog-base-variant.test.ts:112-245` | **absent** | scratch drop of `product_variants_10_base_variant_authority`: the `:202` raw `UPDATE` commits (T-12) |
| 39 | a catalogue `UPDATE` cannot change the unit | `stock-ledger-unit-lock.test.ts:137` (T-17.3) | present, `:188` | — |
| 40 | a catalogue `UPDATE` cannot enable tracking | `inventory-signed-authority.test.ts` (cites PM-40) | present | — |
| 41 | the onboarding maintainer can write its association | `inventory-warehouse-matrix.test.ts:281-303` | present, `:303` | — |
| 42 | no runtime role in the internal role | `stock-ledger-authority.test.ts:242` (T-02.4); `inventory-db-authority.test.ts:175,191` | present (`stock-ledger-authority` labelled) | T-04 repeats it over `runtimePrincipals()` |
| 43 | definer hijack; login owner | `search-path-shadowing.test.ts:469-643`; `inventory-db-authority.test.ts:155` | present | T-05 over every Phase 3 routine, with its negative controls |
| 44 | direct EXECUTE is not authority | S1 `inventory-signed-authority.test.ts:1007-1117`; S3 `inventory-s3-authority.test.ts:76-168`; S4 `purchase-s4-signed-authority.test.ts:67-190`; S5 `purchase-s5-signed-authority.test.ts:177-340` | S1 only | T-01 rows a, l × 26 kinds, with the verifier-stub negative control |
| 45 | one assertion is not stretched | as PM-44 | S1 only | T-01 rows f–j × 26 |
| 46 | key domains never collapse | S1 `inventory-signed-authority.test.ts:563` | S1 only | T-01 row k × 26; T-15b |

---

## 7. Gate, guards and predecessor evolution

### 7.1 `scripts/phase3-s8-gate.ts` (two tenses, the form of `scripts/phase3-s6-gate.ts`)

**Constants:**
- `S7_BOUNDARY`: the last file S7 accepted. That is `'0068_supplier_settlement_commands.sql'` (S7C:741), or S7's `0069_…` if admitted. It is written as a literal at S8 start, from S7's accepted gate.
- `S8_MIGRATIONS = ['<S8M>']`: exactly one file.
- `S8_ACCEPTED: Readonly<Record<string,string>> = {}`: its digest at freeze.
- `ACCEPTED = Object.keys(S8_ACCEPTED).length > 0`, which is the S6 form (`scripts/phase3-s6-gate.ts:55-57`).
- `RECONCILER_S8_COLUMNS`: the §2.2 map.
- `REQUIRED_SUITE_NAMES`: T-01 … T-18.
- `TD12_SITES`: the six A-19 sites.
- `EXPECTED_RULE_FLOOR = 23`, S7's count as a FLOOR, not an equality: the live count is derived from `scripts/static-guards.ts` itself, so a later phase that adds rule 24 does not turn this accepted gate red.

**Tenses:**

| Tense | Structural boundary |
|---|---|
| Candidate | `frozenThrough === S7_BOUNDARY`, and the files after it are exactly `S8_MIGRATIONS` |
| Accepted | `frozenThrough ≥ <S8M>` is a floor, and `<S8M>` hashes to `S8_ACCEPTED` |

**Structural checks, in both tenses:**
1. **Migration content.** Every `GRANT` in `<S8M>` is `SELECT (<columns>) … TO daftar_reconciler`, with exactly `RECONCILER_S8_COLUMNS`. There is no table-level `SELECT`, no `REVOKE`, no `CREATE TABLE`, `VIEW`, `INDEX` or `POLICY`, and no `CREATE FUNCTION`. Under R-B1a the gate allows exactly one `CREATE FUNCTION accounting_inventory_account_domain_guard`, exactly one `CREATE CONSTRAINT TRIGGER`, the `CREATE` bracket, and the one grant of §2.2 to `daftar_accounting_internal`.
2. **Reconciler model.** `reconciler-privilege-model.json` `selectColumns` ⊇ `RECONCILER_S8_COLUMNS` exactly for the S8 tables. `mustNotRead` ⊇ the A-11 additions, and `executableRoutines.length === 1`.
3. **Reconciliation domain.**
   - `packages/accounting/src/reconciliation.ts` defines the five R-INV ids and `ALL_RECONCILIATION_CHECK_IDS`;
   - `DEFERRED_RECONCILIATION_DOMAINS` has no `inventory-valuation`;
   - the reader contains a `has_any_column_privilege` probe naming `stock_movements`;
   - no R-INV SQL contains `round(`, `numeric(28` or a `::float` cast (L:1243).
4. **No stored swap.** No migration after `0052` defines a function whose body `UPDATE`s `stock_levels` other than the primitive and its owner replacement. Rule 22 enforces this, and the gate names it. The procedure template exists outside `migrations/`.
5. **TD-12.**
   - `hmacKeysEquivalent` is defined exactly once in the repository, in `packages/accounting/src/assertion-keys.ts`;
   - each `TD12_SITES` file calls it and contains neither `.equals(` nor `secretsAreIdentical(`;
   - `scripts/install-provisioning-key.ts` references both other key names;
   - `packages/inventory/src` does not define it.
6. **Suites.** Every `REQUIRED_SUITE_NAMES` file exists (the S6 `SUITE_PATTERN` form, `:159-171`).
7. **Premortem.** The matrix JSON is complete; the gate runs a static version of T-18, so a missing row fails before any database starts.
8. **Guards.** `npm run check:guards` prints `PASS (N rules)` with N >= `EXPECTED_RULE_FLOOR` (23); the requirement is the floor, never equality with 23. The gate greps that the extended rules reference `PHASE2_PREFIX_END` (a, b, d) and `INVENTORY_PERIMETER` (c).
9. **No skip.** No `RELEASE_GATE_SKIP_*` and no `it.skip` or `describe.skip` in any S8 suite.

**Runtime steps, in order:**
1. The runner canary. The exit status must be able to carry a refusal (PM cross-cutting 2, `PM:678`).
2. `npm run gate:phase3:s7` (the permanent predecessor). Through the chain it composes S6 … S1, P2-S8 … P2-S1 and Phase 1, including the evolved `gate:phase2:s3` of A-19.
3. `npm run test -w @daftar/accounting` and `-w @daftar/inventory`.
4. The S8 functional suites T-01 … T-12, T-14 … T-18.
5. The Tier 1 budgets (T-13), alone.
6. Budget A (and B under R-B1a) in isolation.

**CI.** The backend job's Phase 3 gate step becomes `npm run gate:phase3:s8`, replacing `gate:phase3:s7` as S7C:785 prescribes for its own step. Predecessor steps named per slice are kept (`ci.yml:141-268` convention).

### 7.2 Guards

Covered by A-18. Summary:
- Rules 15, 16, 17 and 18 widen from name-regex or unfrozen scope to "after `PHASE2_PREFIX_END`".
- Rule 17 gains the inventory perimeter.
- Rule 22 widens to the truth set with argument purity.
- There are no new rule numbers, and no accepted rule's `why` text is reworded except to add its Phase 3 counterpart.

### 7.3 Predecessor pins that S8 turns red, and their evolution (ENG, the P2-S4 §45 form)

| # | Pin | Why it turns red | Evolution |
|---|---|---|---|
| 1 | `infrastructure/database/reconciler-privilege-model.json:18-41` | the reconciler gains columns, and the matrix suite compares both directions | Add the §2.2 columns and the A-11 `mustNotRead` entries. The `note` (`:4`) stays: the change is a reviewed widening |
| 2 | `scripts/phase2-s8-gate.ts:929-940` (the model's tables must equal 0051's `GRANTED_TABLES`, `:162`) | the model now names three more tables | The model's tables must equal `GRANTED_TABLES ∪` the tables granted to `daftar_reconciler` by migrations **after `PHASE2_PREFIX_END`**, parsed with the same regex (`:601`). The 0051 checks (`:600-640`) are unchanged |
| 3 | `tests/security/reconciler-authority-matrix.test.ts` | it reads the model (`:37-71,147-163`) | none, if it only reads the model. If a count is pinned, it evolves with pin 1 |
| 4 | `tests/security/stock-ledger-authority.test.ts:79-107` (`APP_READABLE`, `runtimeMatrixDeviations`) and `:192-212` (the real `SELECT` as each role) | the reconciler now reads three S2 relations at column level | Add `RECONCILER_COLUMN_READABLE = {stock_movements, stock_levels, stock_source_bindings}`. The expected `has_any_column_privilege(SELECT)` is true for the reconciler on those; `has_table_privilege(SELECT)` stays false. The real `SELECT count(*)` as the reconciler is accepted **under business scope** |
| 5 | `tests/security/search-path-shadowing.test.ts:57` (`RUNTIME_ROLES`, six) | A-09 | Add `daftar_reconciler` with `reconcilerDbUrl` |
| 6 | `scripts/phase2-s3-gate.ts:412-416` | A-19 removes `equals(` from `config.ts` | As A-19 |
| 7 | `packages/inventory/src/assertion.ts:160`, `packages/inventory/test/assertion.test.ts:308-367`, imports at `apps/api/src/config.ts:2`, `inventory-assertion.minter.ts:6`, `scripts/install-inventory-key.ts:34` | the function moves | As A-19 and §4.2 |
| 8 | `tests/integration/inventory-db-guard.test.ts:185` ("rule 22: the only stock writers are …") and the rule-22 cases of `stock-ledger-guards.test.ts` | Rule 22's table set widens | The expected writer set becomes the A-04 set computed from the migrations. The existing named writers remain members |
| 9 | the rule tests for G-2, G-3, G-4 and G-5 (`tests/integration/posting-surface-guard.test.ts` and the G-3/G-5 cases) | the wider discovery | Add Phase 3 fixtures; keep every accepted fixture byte-identical |
| 10 | `apps/api/src/modules/accounting/accounting-reconciliation.service.ts:75` and any test pinning the service's `checkCount` | the service runs 14 checks | `checkCount = ALL_RECONCILIATION_CHECK_IDS.length`. `tests/integration/accounting-reconciliation.test.ts:131-151` calls `reconcile()` with its default and stays unchanged |
| 11 | `packages/accounting/src/reconciliation.ts:128-131` | A-12 | As A-12 |
| 12 | `.github/workflows/ci.yml` (the Phase 3 gate step S7 leaves) | A new gate | As §7.1 |
| 13 | `tests/integration/migration-upgrade.test.ts` | a new head | Add the `<S8M>` checkpoint (T-17). The earlier checkpoints are untouched: `0059:516-523` is apply-time only, and an upgrade applies it before `<S8M>` |
| 14 | the S7 gate's accepted-tense range check (S7C:751) | a file after `S7_BOUNDARY` | Nothing to change: S7C:751 admits a file "a later slice's gate owns". The S8 gate owns `<S8M>` |
| 15 | under R-B1a: `tests/performance/accounting-budgets.test.ts` recorded figures | the guard is on the manual-adjustment `COMMIT` | Re-measure A and B; the budgets themselves are unchanged |

---

## 8. File ownership (SAFE_CONCURRENCY = 5, SM:46; `MAX_ACTIVE_AGENTS = 6`, SM:36)

| Agent | Owns | Depends on |
|---|---|---|
| **C — Coordinator, gate, premortem matrix** | `scripts/phase3-s8-gate.ts`; root `package.json` (`gate:phase3:s8`); `ci.yml`; `tests/premortem/phase3-premortem-matrix.json`; T-15c, T-18; `tests/helpers/scratch-db.ts`, `table-digest.ts`; pins 2, 12, 14; the acceptance page; `TECHNICAL_DEBT.md` | all; lands last |
| **M — Migration and reconciliation** (the **only** schema writer) | `<S8M>`; `reconciler-privilege-model.json`; `packages/accounting/src/reconciliation.ts`; the reader and service; `stock-rebuild-swap.sql.template`; T-06, T-07, T-09, T-16, T-17; pins 1, 3, 4, 10, 11, 13; under R-B1a the guard, its error map and locale keys | — ; lands first |
| **S — Security adversary** | `tests/helpers/phase3-surface.ts`, `op-kind-builders.ts`; `phase3-runtime-grant-model.json`; T-01 … T-05; pin 5 | M merged (T-04/T-05 see the new grants) |
| **R — Failure, concurrency, negative controls** | T-08, T-10, T-11, T-12 | S's builders (day 1 interface), M |
| **G — Guards, performance, TD-12** | `scripts/guards/{no-authoritative-balance,no-float-rate,posting-surface,definer-search-path,inventory-writer-authority}.ts`; `scripts/static-guards.ts` wiring; T-13, T-14, T-15a, T-15b; `tests/performance/phase3-dataset.ts`; `packages/accounting/src/assertion-keys.ts` (+ test), `packages/inventory/src/assertion.ts`, `config.ts`, both minters, the three install scripts, `scripts/phase2-s3-gate.ts`; pins 6–9, 15 | M for T-13 |

**Merge order:** M → S ∥ G → R → C.

**Rules:**
- The embedded-PostgreSQL suites run on one `PG_DIR` per agent.
- T-13 runs only when no other agent's suites run (SM:36).
- No agent edits a frozen migration or another agent's files. A needed change is a message to its owner.

---

## 9. Real blockers and Tech Lead notes

### 9.1 Real blockers

**B-1 · Inventory ↔ GL divergence has legitimate sources in accepted surfaces (architectural contradiction).**

*The contradiction.*
- L:1247 says "an exact match is achievable and anything else is a defect". L:1248 says "a mismatch raises a reconciliation alert and the check fails". `PM:223` says "Divergence therefore has no legitimate source".
- Accepted surfaces produce GL(1200) with no movement:
  1. **Manual adjustments on the Inventory account.** `packages/accounting/src/post.ts:310-338` restricts a manual adjustment to its source type and a reason, not to an account. No migration from `0045` through `0068` refuses a `manual_adjustment` line on `system_key = 'inventory'`: the `0061` guards cover `inventory_adjustment`/`inventory_opening` entries only (`0061:1395-1500`). Accepted Phase 2 tests and goldens post exactly that: `tests/golden-regression/phase2/02-report-shapes.golden.test.ts:245,266` and `tests/integration/accounting-reports.test.ts:233,235`.
  2. **A posted opening balance carrying an Inventory position before its Case B decomposition.** L:712-725 and `0061:664-698`. Until the merchant decomposes, GL(1200) ≠ 0 and Σ movements = 0.
- A zero-tolerance R-INV-01 is therefore **red for legitimate books**. That includes every Phase 2 business that used 1200 manually, without any defect. Leaving it red trains operators to ignore the one check PM-16 calls "genuinely detective". Adding a tolerance is forbidden (`PM:681`).
- Engineering cannot pick which accepted rule yields. One option refuses accepted Phase 2 behaviour going forward; the other amends a locked equation.

*Options.*
- **R-B1a — forward closure plus truthful detection** (recommended):
  - `<S8M>` adds the §2.4 guard. After a business's first stock movement, a `manual_adjustment` or `opening_balance` entry with an Inventory line is refused with `accounting.inventory_account_domain_owned`. Businesses with no stock movement keep Phase 2 behaviour byte-identical, so the goldens are unchanged.
  - R-INV-01 stays exactly L:1244, with no scope exclusion. Pre-foundation residue is reported as a `discrepancy` naming the business.
  - The merchant's correction path is explicit and has its own source identity. It is either the Case B decomposition (L:712) or a Phase 2 reversal of the pre-foundation entry. The guard never refuses reversals.
  - Costs: one accounting-owned trigger, and a Budget A/B re-measurement.
  - Needs: the TL's confirmation that refusing post-foundation manual 1200 lines is an authorized evolution of accepted Phase 2 behaviour, and that L:1248's "alert" for pre-foundation residue is the intended merchant signal.
- **R-B1b — R-B1a, with the untracked population reported separately.** It is as R-B1a, but R-INV-01 runs only for businesses with at least one stock movement. A sixth check, R-INV-06 ("Inventory balance with no stock ledger"), reports businesses with GL(1200) ≠ 0 and no movement. The zero-tolerance check then answers PM-16 only for businesses that use inventory, and Phase 2-only books do not paint it red. This amends L:1249's "per business" scope, so it needs the TL.
- **R-B1c — no guard.** R-INV-01 is detective only. The lock is amended to say that a manual Inventory line makes the check red by design. Not recommended: it leaves a permanent unexplained-red path, which is exactly the condition PM-31's failure mode warns will breed a tolerance.

*What it blocks.* The acceptance claim "reconciliation is exact with zero tolerance" **for production books**. It does not block S8's start. A-10's checks, T-06/T-07 and the rehearsal run on fixtures that never post manual 1200 lines. Only §2.4's presence in `<S8M>`, and the scope of R-INV-01, wait on the decision.

There is **no other real blocker**:
- no product-constitution ambiguity;
- no legal or tax question (OD-03 stays bounded, A-20);
- no paid provider;
- no destructive data decision (S8 deletes and rewrites nothing; the rehearsal writes only a scratch database);
- no external credential.

### 9.2 Tech Lead notes (engineering rulings to confirm)

- **TL-1 · The rebuild swap is a rehearsed incident migration, not a stored routine (A-13).**
  - The alternative is a stored `inventory_stock_rebuild_swap` with no runtime `EXECUTE`. That is a permanent exception to A-04, or a new operation kind with a runtime path (L:1992).
  - Recommended: the template plus the T-09 rehearsal, with TD-16 opened. S2C TL-5 (S2C:1445) is thereby answered.
- **TL-2 · TD-12's shared home is `@daftar/accounting` (A-19), not a new workspace.** A new workspace touches four permanent pins: `phase1-gate.ts:64-77`, `ci.yml:30,36,43` and `check-supply-chain.ts:105`. The P2-S3 gate `:412` evolves in the same commit, and `install-provisioning-key.ts` gains pair checks it never had.
- **TL-3 · Replaced pre-Phase-3 routines keep their accepted owners (A-08 clause 7).**
  - `provision_actor`, re-created by the migrator in `0061:134,225` (the TD-13 fix), stays migrator-owned. So does `accounting_actor` (`0061`).
  - The exception set is asserted exactly. Hardening Phase 1/2 routine ownership is outside Phase 3.
- **TL-4 · Deferred domains (A-12).** The `ap-operational` reconciliation (supplier subledger ↔ Accounts Payable 2000) is **not** in S8. It has the same manual-adjustment class as B-1, on `accounts_payable`, and is deferred to the production pass, truthfully labelled.
- **TL-5 · R-INV checks form a separate id list** run in the same pass, so the accepted P2-S8 fixtures and their `clean` computation (`accounting-reconciliation-planted.test.ts:146`) are not disturbed.
- **TL-6 · Offending ids.** R-INV-01 names the business, R-INV-02/03 the variant, R-INV-04 the journal entry, and R-INV-05 the movement or source line. All are UUIDs, with no amount (P2-S8 result contract).
- **TL-7 · The S8 budgets (A-17) are initial numbers.** The acceptance page records actuals. Tier 2 runs locally and uploads evidence on the `phase2-s8-evidence.yml` pattern (`ci.yml:249`).
- **TL-8 · PM-12 recovery has no path (TD-15).** S8 proves PM-12's prevention (S6C T-05) and detection. It does not add a reversal of settlement. This stays open debt.
- **TL-9 · Scheduling.** PM-01's detection is "a scheduled rebuild verify". S8 delivers the check, R-INV-02 in the reconciler pass. Scheduling the reconciler is an operations concern for P3-S9 or the production pass.
- **TL-10 · Guard discovery by migration position (A-18).** It replaces name-regex discovery for G-2 and G-3 and subsumes S7C TL-10. G-5's frozen skip ends at `PHASE2_PREFIX_END`. Every future Phase 3 file stays statically checked after freezing.
- **TL-11 · `<S8M>` breaks P:45's "none expected".** The reason is AL-43's reader (A-02). The plan's §2 is "planning only" (P:30). The acceptance page names the supersession rather than editing the plan.

---

## Annex R. Reconciliation against the frozen P3-S6 and the P3-S7 candidate (coordinator, 2026-09-27)

The rulings header above takes precedence over the body wherever they differ.

### 1. Mismatch table (draft → reality → correction)

| # | Draft says | Reality (file:line) | Correction |
|---|---|---|---|
| 1 | Tree `95ff5a9`; S6 candidate, `S6_ACCEPTED = {}`; S7 known only as S7C | S6 accepted/frozen at 01dae04 (docs/PHASE_3_S6_ACCEPTANCE.md §0; phase3-s6-gate.ts:55,60). S7 contract adopted with a rulings header (s7int docs/PHASE_3_S7_CONTRACT.md:3-17) | Re-base every citation; "S6C" → PHASE_3_S6_CONTRACT.md + frozen code; S7C line refs shift (0069 exception :176-181; §7.1 constants :772-775; accepted tense :782; CI step :816; TL-10 :933) |
| 2 | `<S8M>` = 0069 or 0070 | No `0069*` anywhere in s7int (find over repo) | **0069** `_inventory_reconciliation_read.sql` (rename to `…_read_and_account_domain.sql` under R-B1a). If S7 later admits its index-only 0069 → 0070. S8 cannot start before S7's freeze mark: the S7 *candidate* tense reads every file after 0068 and fails any `GRANT`/`FUNCTION` (phase3-s7-gate.ts:159,231-255); the accepted tense checks nothing after 0068 (:14-17,:213), so pin 14 needs no change |
| 3 | S6 kinds registered `0068:1277-1280`; consumes at `0068:74,175,280,353,526,841,1061` | Registered M:0068:1442-1445; consumes M:0068:95,196,301,374,547,866,1092 | Fix lines. Other slices' lines verified (0054:58-61; 0062:1515-1518 & consumes 265…1299; 0064:1499-1501 & 365…1172; 0066:886-887 & 360,680; 0055:132; 0056:296,358; 0060:809) |
| 4 | 26 kinds | 3+7+7+2+7 = 26 ✓ | — |
| 5 | A-04: 18 entry routines fail a naïve rule-22 widening, S6 = pay/allocate/refund + method create/update | All 7 S6 entry routines put `inventory_claimed_payload_digest` in the consume args (0068:95…1092), incl. `payment_method_deactivate`/`_activate`; helper `supplier_credit_note_consume` opens with `inventory_assertion_current(ARRAY[…])` (0068:439-444) | Re-measure the count on the frozen tree (≥20); law text unchanged |
| 6 | A-06 `financial` discovered from a `prosrc` call to `accounting_post_entry/_reversal` | **Zero** Phase 3 routines call either (grep M:0060-0068; only a comment at 0065:34). Postings are app-side in the same txn (S6 acceptance §1; 0068 §3 header "The caller then posts") | Builder declares `accountingSourceTypes`; union must equal `accounting_source_types` rows added after 0052 (8: 0061:1656, 0063:1723-1725, 0067:2280-2283, 0065:1908) plus `reversal` for `purchase.reverse` (0065:1749-1762). T-10 must drive the composed API command (routine + post), not the SQL routine alone |
| 7 | A-07 `daftar_app` EXECUTE = 26 routines "plus the read functions S7 adds" | S7 adds no DB object. Live set = 26 entry routines + `purchase_ap_outstanding`, `purchase_settlement_state` (0067 grants); `daftar_platform` = the two `inventory_assertion_key_*` | Model states exactly 28 for `daftar_app` |
| 8 | A-08 counts 151 / 126 / 18 / 7 | Stale (pre-S6-freeze); now 178 `SECURITY DEFINER` tokens incl. comments, single-line `OWNER TO` 124 inventory / 15 accounting | Record counts from the catalogue at S8 start, not in the contract |
| 9 | TL-3: `provision_actor` **and** `accounting_actor` keep a migrator owner; exempt from clause 7 only | `accounting_actor` is owned by `daftar_accounting_internal` (0045:878; replaced under `SET LOCAL ROLE` 0061:139; asserted 0061:2208) with canonical path (0061:142). `provision_actor` is migrator-owned with path `public, pg_catalog, pg_temp` (0061:225-226). Computed replaced set = exactly {accounting_actor, provision_actor} | Exception set = `{provision_actor(text[])}` only, exempt from clauses **1, 2 and 7**; `accounting_actor` must pass all clauses |
| 10 | A-18(a): 7 tables escape G-3; add `payment_methods` and `settled` "if S6 has not" | S6 did: `SUPPLIER_TABLE_NAME` incl. `payment_methods|payment_method_*` and `settled` (s7int scripts/guards/no-authoritative-balance.ts:336,339) | 5 escape: `units, unit_names, branch_warehouses, stocktakes, stocktake_lines`; cite :336 not :328 |
| 11 | static-guards.ts rule lines 281/388/421/446/546; count 23 | s7int: R15 :282, R16 :389, R17 :422, R18 :447, R22 :557, R23 (web-responsive) :574, `PASS (23 rules)` :595. daftar@01dae04 still prints 22 (:567) | An equality on the rule count holds only on the S7-accepted base ✓ — and Phase 4 proved it: adding rule 24 made this accepted gate refuse every later tree, so the pin is now `EXPECTED_RULE_FLOOR = 23` with the count derived from `scripts/static-guards.ts` |
| 12 | Pin 8 `inventory-db-guard.test.ts:185` | :221 (writer-set it) and :458 (rule-22 describe) | Fix |
| 13 | Helpers `stock-ledger.ts:382/579/588`; `migrationsUpTo` "helper" at migration-upgrade.test.ts:48 | :418 mintFixtureAssertion, :615 installStockFixture, :624 withRolledBackFixture, :298 atCommit; `migrationsUpTo` is file-local (:51) | `phase3-surface.ts` re-implements it (or T extracts it to tests/helpers) |
| 14 | TD-16 = no stored rebuild swap | TECHNICAL_DEBT.md:24 TD-15 (no settlement reversal), :25 TD-16 (S5 sub-unit AP residue). S7 adds no TD (edits TD-06 only) | Swap debt = **TD-17**; §4.5, A-13, TL-1 text updated |
| 15 | TD-12 sites | Confirmed: `hmacKeysEquivalent` still in packages/inventory/src/assertion.ts:160; importers config.ts:2,331,334, inventory-assertion.minter.ts:6,52,55, install-inventory-key.ts:34,46,50. Byte compares: config.ts:308-311, accounting-assertion.minter.ts:36 (`secretsAreIdentical`), install-accounting-key.ts:39; install-provisioning-key.ts none; gate regex phase2-s3-gate.ts:412 | TL-2 home `@daftar/accounting` stands |
| 16 | §3: new code → HTTP **422**; locale key in `@daftar/shared-contracts` | Sibling S3 accounting guard codes return **409** (apps/api/src/common/error.filter.ts:176-187) and are not in `AccountingErrorCode` (packages/accounting/src/errors.ts:15). Web keys live in apps/web/src/messages/{ar,en,tr}.json and are demanded for every `AccountingErrorCode` (apps/web/test/helpers/refusal-codes.ts:92) | 409 in error.filter.ts's S3 block; do **not** add to `AccountingErrorCode`; no locale key required (no web manual-journal screen) |
| 17 | §2.4 guard reads `stock_movements` via `GRANT SELECT(business_id) … TO daftar_accounting_internal` | RLS `business_isolation` exempts only `daftar_inventory_internal` (0059:325-329); posting identity comes from the assertion, not GUCs (0045:16) → with unset/foreign GUCs the EXISTS sees 0 rows: **fail-open** | Replace by an inventory-owned boolean helper (§2) |
| 18 | PM-12/15/22 "S6C planned"; PM-44/45 S6 absent | settlement-s6-over-allocation (PM-12), settlement-s6-credit-concurrency (PM-15), settlement-s6-receive-and-pay.test.ts:108 (PM-22), settlement-s6-atomicity (PM-10/11), security/settlement-s6-isolation (PM-18), security/settlement-s6-signed-authority.test.ts:208-374 (PM-44/45: no cross-protocol row, no NC) | Fill §6.2; S6 rows NC = absent → T-12 adds for PM-12/15; T-01 covers PM-46 for S6 |
| 19 | Predecessor pins under R-B1a: only Budgets A/B | **tests/integration/stock-ledger-vectors.test.ts:344-373,437-447**: the S2 H-5 composite posts `manual_adjustment` lines on Inventory after writing movements, then `atCommit` (SET CONSTRAINTS ALL IMMEDIATE, stock-ledger.ts:298-301) → red for every scenario; run by gate:phase3:s2 (phase3-s2-gate.ts:156) | New pin 16 (see §2.8) |
| 20 | R-B1a "a reversal always moves GL(1200) toward Σ movements" | False with offsetting pre-foundation residues (+x and −x net 0; reversing one opens a gap) | Reword: a reversal removes exactly one pre-foundation contribution; R-INV-01 reports whatever remains |
| 21 | 6100 at `0040:65` | `rounding` row 0040:64; `inventory` 1200 0040:53 ✓ | Fix |
| 22 | S7 reads | Modules apps/api/src/modules/inventory/{inventory-reads,read-scope}.ts, purchasing/{purchasing-reads,supplier-balance-reads}.ts; guards read-surface (G-6, R19), merchant-jargon, web-responsive (R23). No S8 dependency except: A-18(c) `INVENTORY_PERIMETER` must stay clean over these read modules | Add "clean over S7 read modules" to T-14 |
| 23 | CI step replaced is `gate:phase3:s7` | s7int ci.yml:268 still runs `gate:phase3:s6` (S7 advances it at freeze) | "replace the Phase 3 gate step S7 leaves" (wording already hedged) |

R-INV-01..05 column names verified against 0059 (`stock_movements` 16 cols, `stock_levels` 8, `stock_source_bindings` 6); GL(Inventory) expression = 0061:1425 ✓; PM-44..46 row letters stand (f = "the other 25").

### 2. R-B1a — complete implementation spec (default until the TL answers B-1)

2.1 **Rule.** After a business's first stock movement, no journal entry of source type `manual_adjustment` or `opening_balance` may carry a line on that business's Inventory system account. Refusal: `accounting.inventory_account_domain_owned: after a business's first stock movement, the Inventory account changes only through an inventory or purchasing operation` (P0001, no amount).
2.2 **Writer paths covered** (all Phase 2 merchant-stated lines reach `journal_entries` with one of these two types): `accounting_post_manual_adjustment` (M:0046:386; `source_type='manual_adjustment'`, detail enforced by 0046:311-327) and `accounting_open_balance_post` (M:0047:778, entry at :1001, status update :1003). **Not covered, on purpose:** `reversal` (M:0046:449) — lines are derived from the persisted original, `purchase.reverse` uses it for `purchase` entries (0065:1749-1762), reversal-of-reversal is already refused (0046:554), and it is the correction path for pre-foundation residue; every inventory/purchasing/settlement type (they own 1200 by construction; settlement accounts cannot be 1200, 0067:1940).
2.3 **Account identity.** `journal_lines l JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id WHERE a.system_key = 'inventory'` (identity per 0040:30,53, same expression as 0061:1423-1425). Never the code `1200` (presentation; renamable). Opening-balance lines stated by code resolve to the same `account_id`, so both `account_ref_kind`s are covered. Merchant-created asset accounts without `system_key` are out of scope (R-INV-01 reads only the system account).
2.4 **"Has stock movements".** `EXISTS (SELECT 1 FROM stock_movements WHERE business_id = p)` — any kind, including movements written earlier in the same transaction; judged at COMMIT. Read through a new helper `inventory_business_has_stock_movements(p_business_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp`, owned by `daftar_inventory_internal` (its `inventory_internal_read` policy and business-isolation exemption, 0059:325-329, make it GUC-independent → fail-closed), `REVOKE ALL FROM PUBLIC`, `GRANT EXECUTE` to `daftar_accounting_internal` only; G-7-compliant (CREATE bracket, 0067:665 pattern). Index `stock_movements_variant_idx (business_id, variant_id)` (0059:162) makes it O(1). No grant on `stock_movements` to the accounting role.
2.5 **Guard.** `accounting_inventory_account_domain_guard() RETURNS trigger`, plpgsql, SECURITY DEFINER, pinned path, owner `daftar_accounting_internal` (reads lines/accounts via the 0045:420-427 identity policies), no EXECUTE grantee. Body: if the entry has a 2.3 line **and** the 2.4 helper is true → raise 2.1; else `RETURN NULL`. Trigger `journal_entries_inventory_account_domain`: `CREATE CONSTRAINT TRIGGER … AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.source_type IN ('manual_adjustment','opening_balance'))` (sibling shape 0046:324-327, 0061:1639-1646).
2.6 **Concurrency.** No lock added (posting account locks are shared, 0045:263). If a first movement commits after the guard's COMMIT-time read, the serial order is "manual entry first", i.e. pre-foundation residue that R-INV-01 reports — the same class R-B1a already accepts. Adding a lock would invert existing orders (opening-balance lock → account lock, 0047/0061 R-1) and is forbidden.
2.7 **Interplay.** No frozen byte changes; precedent for new `journal_entries` triggers in 0058/0061/0063/0065/0067; apply-time name-filtered trigger checks (e.g. 0067:2817-2830) are unaffected; accounting-source-completeness.test.ts:325-390 names its triggers → unaffected. Existing immediate guards fire first: `accounting_opening_balances_30_inventory_opening_guard` (BEFORE UPDATE OF status, 0061:1550-1575) still answers `opening_balance_inventory_conflict` after a Case A opening (tests inventory-s3-opening.test.ts:428-440, inventory-s3-concurrency.test.ts:395-410 unchanged); `…_bound` refusals unchanged. Case B stays: an opening balance with Inventory must be posted before the first movement; afterwards the merchant uses Case A (no Inventory line) — the refusal text should say so in the error docs.
2.8 **Pins it turns red.** (a) stock-ledger-vectors.test.ts composite (§1 #19): inside its rolled-back txn, `ALTER TABLE journal_entries DISABLE TRIGGER journal_entries_inventory_account_domain` before `postInventoryValue`, with a comment citing R-B1a; add one case asserting the undisabled composite is refused with 2.1. (b) Budget A/B recorded figures (accounting-budgets.test.ts:54,56) re-measured. Phase 2 goldens (02-report-shapes.golden.test.ts:245,266; accounting-reports.test.ts:233-235,411) have no movements → byte-identical.
2.9 **Error surface.** 409 via error.filter.ts:176-187; not in `AccountingErrorCode`; no web key (§1 #16).
2.10 **Tests (new T-19 `tests/integration/phase3-s8-inventory-account-domain.test.ts`).** no-movement business: manual & opening 1200 accepted; committed movement then manual 1200 → refused at COMMIT, nothing written; same-txn movement then manual → refused; manual on non-Inventory accounts accepted; opening balance with/without Inventory after movements; reversal of a pre-foundation manual 1200 entry and `purchase.reverse` accepted; GUCs unset/foreign → still refused; HTTP 409 `ACCOUNTING_REFUSED` with `details.code`; catalogue shape (deferred, owners, paths, EXECUTE = {accounting internal}); race manual ∥ first receipt ends in one of the two serial outcomes; **NC**: trigger dropped in scratch → accepted and R-INV-01 = `discrepancy`.
2.11 **Gate.** `<S8M>` content check admits exactly: 4 reconciler column grants, 2 `CREATE FUNCTION` (guard, helper), 1 `CREATE CONSTRAINT TRIGGER`, the two CREATE brackets, 2 `ALTER FUNCTION … OWNER`, 2 `REVOKE ALL … FROM PUBLIC`, 1 `GRANT EXECUTE … TO daftar_accounting_internal`. Constant `B1_RULING = 'R-B1a'`; the section is delimited in the file so an R-B1c answer before freeze is one deletion + one constant.

### 3. Proposed header for the S8 contract

> **Coordinator rulings on this contract (2026-09-27).** Adopted as the P3-S8 implementation contract after P3-S7 is accepted (`S7_ACCEPTED_MARK = 'P3-S7 accepted'`); S8 does not start earlier, because S7's candidate gate refuses any grant after 0068. Every "S6C" citation is replaced by `docs/PHASE_3_S6_CONTRACT.md` and the frozen `0067`/`0068`; "S7C" by the adopted `docs/PHASE_3_S7_CONTRACT.md`. Line numbers are re-based to the S7 freeze commit.
>
> **Migration.** Exactly one: `0069_inventory_reconciliation_read_and_account_domain.sql` (0070 only if S7 admitted its index-only 0069). The gate derives it from the manifest.
>
> **B-1 was decided by the Tech Lead on 2026-09-27: R-B1a** (§2.4 as amended): refuse `manual_adjustment`/`opening_balance` entries with a line on `system_key = 'inventory'` once the business has any stock movement, read through an inventory-owned boolean helper (no accounting grant on `stock_movements`), deferred to COMMIT, reversals admitted, error 409, not in `AccountingErrorCode`. The R-B1a block is delimited so an R-B1b/c answer before freeze is a deletion.
>
> **S6/S7 facts S8 must honour.** 26 kinds (S6 at 0068:1442-1445). No Phase 3 routine posts: "financial" = the builder's accounting source types, equal by set to the 8 types registered after 0052 plus `reversal` (purchase.reverse); T-10 drives the composed command. `daftar_app` executes 28 Phase 3 routines (26 + `purchase_ap_outstanding`, `purchase_settlement_state`); S7 adds none. G-3 already covers payment methods and `settled`; the widening concerns 5 tables. Static guards stay at 23.
>
> **Amendments.** TL-3's exception set is `{provision_actor}` for clauses 1, 2 and 7; `accounting_actor` is internal-owned and passes. The rebuild-swap debt is **TD-17** (TD-15/16 are taken). New pin 16: the S2 H-5 composite (`stock-ledger-vectors.test.ts`) disables the R-B1a trigger inside its rolled-back transaction and gains one refusal case.
>
> **Adopted as engineering rulings:** A-01…A-21 and TL-1, TL-2, TL-4…TL-11 as amended above. OD-03 stays bounded.

### 4. File ownership — 4 agents

| Agent | Owns |
|---|---|
| **M** migration (only schema writer) | `M:0069_…sql`; `infrastructure/database/reconciler-privilege-model.json` (pin 1); `infrastructure/database/phase3-runtime-grant-model.json`; `infrastructure/database/procedures/stock-rebuild-swap.sql.template` |
| **D** packages + API + scripts | `packages/accounting/src/{reconciliation,assertion-keys,index}.ts` + `test/assertion-keys.test.ts` (T-15a); `packages/inventory/src/assertion.ts`, `test/assertion.test.ts`; `apps/api/src/modules/accounting/accounting-reconciliation.{reader,service}.ts`; `apps/api/src/config.ts`; both minters; `apps/api/src/common/error.filter.ts`; `scripts/install-{accounting,inventory,provisioning}-key.ts`; `scripts/phase2-s3-gate.ts:412` (same commit as config.ts, pin 6) |
| **T** tests | helpers (`phase3-surface`, `op-kind-builders`, `scratch-db`, `table-digest`); T-01…T-12, T-15b, T-16, T-17, T-19; pins 3, 4, 5, 10(test side), 13, 16 (`stock-ledger-authority`, `search-path-shadowing:57`, `migration-upgrade`, `stock-ledger-vectors`) |
| **G** gate + guards + perf | `scripts/guards/{no-authoritative-balance,no-float-rate,posting-surface,definer-search-path,inventory-writer-authority}.ts`; `scripts/static-guards.ts` (comments only, count 23); `scripts/phase2-s8-gate.ts` (pin 2); `scripts/phase3-s8-gate.ts`; `package.json`; `.github/workflows/ci.yml`; `tests/premortem/phase3-premortem-matrix.json`; T-13 + `tests/performance/phase3-dataset.ts`; T-14, T-15c, T-18; pins 8, 9, 15 |

Coordinator keeps `TECHNICAL_DEBT.md` (TD-12 closed, TD-17 opened), the acceptance page and the manifest freeze.

**Order.** (1) M lands first (day 1; T/G can read the contract meanwhile). (2) D ∥ G-guards ∥ T-harness, all against M's head. (3) T's reader-dependent suites (T-06/07/16/19-HTTP) after D; T-01/T-10 builders after the harness. (4) G's gate, matrix JSON and T-13 last, once suite names and actuals exist. Merge: **M → D → T → G**. One `PG_DIR` per agent; T-13 runs alone.
