# DAFTAR — Phase 3 Slice 2 Preparation (Immutable Stock Ledger) / تحضير الشريحة P3-S2

> **PREPARATION ONLY — not an authorization; P3-S2 implementation requires an explicit Tech Lead directive after P3-S1 acceptance.**
>
> هذه الصفحة تحضير فقط وليست تفويضًا: تنفيذ P3-S2 يتطلب توجيهًا صريحًا من قائد التقنية بعد قبول P3-S1.
>
> **What this page is.** A planning aid for whoever implements P3-S2 once it is authorized: what it consumes from P3-S1, what it builds, what it must prove, what can go wrong, where the lock is silent or self-contradictory, and how the work could be split. It creates no schema, no code, no migration and no test. It decides nothing: where the lock is ambiguous the ambiguity is listed in §5 with its exact lines and left open. Where this page and `docs/PHASE_3_ARCHITECTURE_LOCK.md` differ, the lock wins.
>
> **Baseline.** Branch `agent/p3-s1-s2-prep` at `ec08307`. P3-S1 is being implemented in parallel and **none of its objects exist in this tree** (`infrastructure/database/MIGRATION_MANIFEST.json:3` still reads `frozenThrough = 0052_…`). Every P3-S1 object below is therefore cited from the lock, not from code, and §1 marks which of them must be frozen before P3-S2 may start.

**Citation keys.** `L:n` = `docs/PHASE_3_ARCHITECTURE_LOCK.md` line n · `P:n` = `docs/PHASE_3_EXECUTION_PLAN.md` · `PM:n` = `docs/PHASE_3_PREMORTEM.md` · `IR:n` = `docs/DAFTAR_INVENTORY_RULES.md` · `DM:n` = `docs/DAFTAR_DATA_MODEL.md`. Other repo claims are cited `path:line`. **A-nn** refers to §5, **E-nn** to §4, **T-nn** to §3.

---

## 1. Dependency map — what P3-S2 consumes from P3-S1

P3-S2 is DB + package only: it creates no HTTP command and no merchant path (P:137–149; "no operation reaches the primitive at all", L:1992). It therefore consumes P3-S1's **database authority** and **package skeleton**, not its API.

**Freeze column.** **F** = must be accepted and byte-frozen (migration in the manifest) before P3-S2 starts, because P3-S2 SQL references it by name or replaces it. **S** = the signature/shape must be stable; the implementation may still move. **—** = not consumed.

| # | P3-S1 object / contract | Lock source | How P3-S2 uses it | Freeze |
| --- | --- | --- | --- | --- |
| D-01 | `daftar_inventory_internal` role: `NOLOGIN NOINHERIT …`, one member `daftar_migrator` `INHERIT FALSE, SET TRUE`, no `TEMPORARY`, created in `infrastructure/database/bootstrap.sql` | L:1663–1683 | Owns the movement primitive, the HALF_EVEN helper, `products_20_unit_history_lock`, the rebuild routines and every S2 definer trigger function; every S2 ownership transfer needs the `GRANT/REVOKE CREATE ON SCHEMA public` bracket (L:1651, L:1693; precedent `0042_accounting_journal.sql:471`, `:499`) | **F** |
| D-02 | `inventory_assertion_current(p_allowed_op_codes TEXT[]) RETURNS inventory_verified_actor` — steps 1–4, 6, 9, then requires an `inventory_assertion_uses` row with `xact = pg_current_xact_id()`, else `inventory.assertion_not_consumed` | L:1990 | First statement of the primitive; the returned `(actor_user_id, tenant_id, business_id, op_code, jti)` (L:1988) is the only source of actor/business for every S2 write | **F** (name, argument type, return type field names, error codes) |
| D-03 | `inventory_assertion_consume(p_op_code TEXT, p_payload_sha256 TEXT)` | L:1974–1986 | Not called by S2 production code; called by S2's **test fixture** entry routine (§3 harness H-2) and by any S2 replacement of `inventory_configure_product` (A-13) | **F** |
| D-04 | `inventory_operation_kinds (op_code PK, registered_by)` — seeded with exactly the three P3-S1 kinds | L:1863–1866, L:1908–1912 | FK target of the S2 table `inventory_operation_movement_kinds.op_code` (L:1992) | **F** |
| D-05 | `inventory_assertion_uses (jti, xact XID8, op_code, business_id, consumed_at)` | L:1856–1861 | Read (via D-02) to prove consumption in the current transaction | **F** |
| D-06 | `inventory_verified_actor` composite type | L:1974, L:1988 | Return type consumed by the primitive | **F** |
| D-07 | `products.track_inventory` / `unit_code` / `unit_decimals SMALLINT` + tracked-needs-unit `CHECK`; `units` registry | L:228–231, L:241–251 | Precision law reads the product's **frozen** `unit_decimals` (L:274); history lock guards `unit_code`/`unit_decimals` | **F** |
| D-08 | `products_10_inventory_config_authority` (`SECURITY INVOKER`, name fixed) | L:1719–1724, L:1745 | `products_20_unit_history_lock` must sort **after** it by name (L:1741–1746); S2 acceptance asserts the order (P:169) | **F** (name) |
| D-09 | `inventory_configure_product(p_product_id uuid, p_track boolean, p_unit_code text, p_unit_decimals smallint)` owned by the internal role | L:1705 | Row 3/4 "through the command" of the unit matrix (L:338–339); possibly **replaced** by S2 for the P3-AL-41 disable rule (A-13) — a replacement of a function the internal role owns must run under `SET LOCAL ROLE daftar_inventory_internal` (L:1652; `0040_accounting_chart.sql:411`, `:466`) | **F** |
| D-10 | `product_variants.is_base` + `product_variants_10_base_variant_authority` | L:1593–1595, L:1726–1731 | Stock key targets any variant (base or merchant) through the composite FK `(business_id, variant_id) → product_variants (business_id, id)` (`0005_catalog.sql:37–47`); S2 adds no variant write | **S** |
| D-11 | Internal-role grants from §H (`SELECT` on `products`, `product_variants`, `businesses`, `branches`, `warehouses`; `INSERT` on `audit_events`) | L:1766–1781 | Primitive reads product/variant/warehouse under RLS; S2 **extends** the matrix (A-01) | **S** |
| D-12 | Catalogue-discovered §D definer check in `tests/security/search-path-shadowing.test.ts` and the static guards; the PM-44 static guard "every internal-role writer calls consume/current first" | L:1687, PM:633–635 | Every S2 function owned by the internal role must pass both automatically; the rebuild swap is caught by the PM-44 guard (A-16) | **S** |
| D-13 | Live grant-matrix tests of §H (read from `role_table_grants`, `role_routine_grants`, `pg_policy`) | L:1762 | **Predecessor-evolution risk**: if S1 writes them as an *exact* privilege set for the internal role, S2's new stock grants turn them red. They must evolve by the P2-S4 §45 rule the lock already applies to F-4 (L:116–123, L:1060): keep the evidence, admit the authorized successor | **S** |
| D-14 | `@daftar/inventory` package skeleton (`package.json`, `tsconfig*`, `vitest.config.ts`, `src/index.ts`, `src/assertion.ts`, `src/payload.ts`, `vectors/invpl-vectors.json`) | L:1968, P:62 | S2 adds the fixed-point arithmetic "to the same package" (L:1968); the index export surface and vectors directory layout must not churn under S2 | **S** |
| D-15 | Test helpers: inventory test key/kid and an `invctl/1` test minter (the accounting precedent is `tests/helpers/test-app.ts:72–89`) | L:1870–1871 | Every S2 authority test mints assertions for fixture op kinds | **S** |
| D-16 | `gate:phase3:s1` script and its `package.json` entry | P:289–293 | `gate:phase3:s2` composes it | **S** |
| D-17 | `MIGRATION_MANIFEST.json` with the S1 migrations frozen | P:48, P:293 | S2's first migration number follows S1's last; `gate:phase3:s2` fails if S1 candidates are unfrozen or a migration beyond the slice exists | **F** |
| D-18 | `business_transaction_id` generation (API boundary) | L:1064–1073 | Only if movements carry it (IR:5) — source in the DB is unspecified (A-25) | — / **S** |
| D-19 | Seams `withBusinessInventoryTransaction` / `withBusinessInventoryAccountingTransaction` | L:975–987 | Not used by P3-S2 (no command); first used by P3-S3 (L:1010–1011) | — |
| D-20 | `branch_warehouses` and its lifecycle | L:549–647 | Not read by the primitive: warehouse authority is proved by the signed payload of the entry routine (L:1187, L:1709), not re-resolved | — |

**What P3-S2 must not touch.** Any of `0000`–`0052` (P:48) and, once accepted, any P3-S1 migration; the verifiers' semantics (L:1974–1992); the `invctl/1` wire format (L:1873–1902); the three P3-S1 operation kinds (L:1908–1912). P3-S2 registers **no** operation kind, **no** stock source type (L:1437) and **no** operation→movement mapping (L:1992, P:147).

---

## 2. P3-S2 object inventory

Each object is tied to the decision that requires it. Names in `code` are lock names; names in _italics_ are placeholders because the lock fixes none (A-02, A-21).

### 2.1 Tables

| Object | Shape the lock fixes | Decision |
| --- | --- | --- |
| `stock_movements` | stock key `(business_id, warehouse_id, variant_id)`; `stock_seq BIGINT NOT NULL`, `UNIQUE (business_id, warehouse_id, variant_id, stock_seq)`; `UNIQUE (business_id, source_type, source_id, source_line_id, movement_kind)` (must be a real, non-deferrable `UNIQUE` constraint: it is the FK target of §2.1 bindings); `qty_delta NUMERIC(18,4)`, `unit_cost_base_minor NUMERIC(28,10) NULL`, `value_delta_base_minor BIGINT`; `CHECK (NOT (qty_delta = 0 AND value_delta_base_minor = 0))`, `CHECK ((qty_delta = 0) = (unit_cost_base_minor IS NULL))`; `source_type` FK → `stock_source_types`; `movement_kind` FK → `stock_movement_kinds`; **no FK into any domain table**; deferred FK → `stock_source_bindings` | L:188–190, L:403, L:408, L:444–449, L:1332–1336, L:1420, L:1470–1473 |
| `stock_levels` | PK `(business_id, warehouse_id, variant_id)`; `on_hand NUMERIC(18,4)`, `valuation_base_minor BIGINT`, `avg_unit_cost_base_minor NUMERIC(28,10) NULL`, `last_stock_seq BIGINT`; never deleted; no `reserved` column | L:157–162, L:351, L:359, L:1274 |
| `stock_source_bindings` | movement-grained PK `(business_id, source_type, source_id, source_line_id, movement_kind)`; `tenant_id`; FKs to both registries; deferred FK → `stock_movements` | L:1456–1479 |
| `negative_inventory_deficits` | `deficit_seq` per stock key, `UNIQUE (business_id, warehouse_id, variant_id, deficit_seq)`, quantity CHECKs, FIFO index | L:469, L:480; DM:266–279, DM:295–297 |
| `negative_deficit_coverages` | shape **contested** — see A-06 | L:469, L:492–501; DM:281–292 |
| `inventory_operation_movement_kinds (op_code, movement_kind)` | created **empty**; FK to `inventory_operation_kinds` (D-04) and `stock_movement_kinds` | L:1992, P:147 |

Tenant/business binding follows the accepted pattern and is not re-litigated: `tenant_id` + `business_id` on every row (DM:55), composite `(tenant_id, business_id) → businesses (tenant_id, id)` (`0016_tenant_membership_invariant.sql:10`, used at `0042_accounting_journal.sql:149–150`), composite `(business_id, warehouse_id) → warehouses (business_id, id)` (`0003_tenancy.sql:67–78`) and `(business_id, variant_id) → product_variants (business_id, id)` (`0005_catalog.sql:37–47`). The delete action of those FKs is not fixed by the lock (A-20).

### 2.2 Registries

| Registry | Content at end of P3-S2 | Decision |
| --- | --- | --- |
| `stock_movement_kinds (movement_kind PK, qty_sign ∈ {positive, negative, zero, either}, requires_reason BOOLEAN)` | contested: all ten Phase 3 kinds, or none (A-05) | L:424–432, P:141 |
| `stock_source_types (source_type PK)` | **empty** | L:1437, P:143 |
| `inventory_operation_movement_kinds` | **empty** | L:1992 |

Precedent for a closed registry with data-carried policy and an apply-time count assertion: `0042_accounting_journal.sql:51–80`. Precedent for an operation→identity pairing table: `0046_accounting_sources.sql:86–118` (note its `UNIQUE (source_type)`; A-29).

### 2.3 Triggers

| Trigger | Timing / rights | Refusal | Decision |
| --- | --- | --- | --- |
| append-only on `stock_movements` | `BEFORE UPDATE OR DELETE FOR EACH ROW`, unconditional, refuses the schema owner too | UNSPECIFIED (A-04) | L:172, P:153; precedent `0004_infra.sql:18–23`, `0042_accounting_journal.sql:315–360` |
| append-only on `stock_source_bindings` (and, later, every bridge) | same | UNSPECIFIED (A-04) | L:1548 |
| `products_20_unit_history_lock` | `BEFORE UPDATE ON products FOR EACH ROW WHEN (OLD.unit_code IS DISTINCT FROM NEW.unit_code OR OLD.unit_decimals IS DISTINCT FROM NEW.unit_decimals)`; `SECURITY DEFINER`, owner `daftar_inventory_internal`; reads `stock_movements` through an identity `FOR SELECT` policy | `inventory.unit_identity_locked` | L:314, L:1746–1758, P:149; direct precedent `businesses_base_currency_lock` `0042_accounting_journal.sql:453–499` (definer so RLS cannot blind the `EXISTS`) |
| binding-side completeness mechanism | `DEFERRABLE INITIALLY DEFERRED` constraint trigger **on `stock_source_bindings`**, one per registered source type, requiring the bridge row at COMMIT; S2 ships the mechanism with zero instances | per-type, UNSPECIFIED | L:1522, L:1530, P:145; precedent `0036_catalog_translations_normalized.sql:107–112`, `0043_accounting_invariants.sql:292–300` |

### 2.4 Routines (all owned by `daftar_inventory_internal`, §D contract L:1685–1695)

| Routine | Responsibility | Runtime `EXECUTE` | Decision |
| --- | --- | --- | --- |
| _movement primitive_ (name not fixed, A-02) | first statement `inventory_assertion_current(...)`; refuse a movement kind the consumed op kind does not map to; every written `business_id` = verified business; P3-AL-06 three-step key lock; per-key `stock_seq`; precision law; `qty_sign`/`requires_reason`; `inventory.insufficient_stock`; value per P3-AL-49 §C; cache update; `on_hand = 0 ⇒ valuation_base_minor = 0` before COMMIT | **none** | L:173, L:351–357, L:463, L:1376–1387, L:1990–1992, P:147 |
| _HALF_EVEN helper_ | exact `NUMERIC` HALF_EVEN via `div()`/remainder, never `round()` (HALF_UP) and never NUMERIC `/` (bounded-scale rounding) | none | L:387, L:1389; precedent `0043_accounting_invariants.sql:211–243` |
| _rebuild verify_ | fold by `stock_seq ASC`, compare, report; writes nothing | open (A-16) | L:1220–1233 |
| _rebuild swap_ | replace the cache row in one statement per key under the key lock | none; would need its own registered kind (L:1992) | L:1232–1235 |
| `inventory_configure_product` (replacement, conditional) | P3-AL-41 disable-at-non-zero rule and re-enable semantics | `daftar_app` (unchanged) | L:1705, L:1783; A-13 |
| deficit-seq allocation | "under the same stock-key lock as `stock_seq`"; no producer in Phase 3 | none | L:469; A-07 |

### 2.5 RLS, policies and grants (delta over P3-AL-54 §H)

- `ENABLE` + `FORCE` RLS with the accepted two-policy layering on `stock_movements`, `stock_levels`, `stock_source_bindings`, `negative_inventory_deficits`, `negative_deficit_coverages` (`0006_rls.sql:28–49`; `0042_accounting_journal.sql:379–411`).
- Identity `FOR SELECT` policy on `stock_movements` for `daftar_inventory_internal` (L:1748). In the accepted precedent the **restrictive** `business_isolation` policy must also admit the principal on `USING` and exclude it from `WITH CHECK` (`0042_accounting_journal.sql:389–393`); the lock does not say so (A-18).
- `daftar_app`: `SELECT` only on the stock tables (L:173); other read grants open (A-17). Registries: no runtime DML (L:1785); read grants open (A-17).
- `daftar_inventory_internal`: from P3-S2, `SELECT` on `stock_movements` and `stock_levels` (L:1783) — plus whatever the primitive must write, which L:1783 literally forbids (A-01).
- No runtime role holds `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE` on any S2 table (P:154, P:293).

### 2.6 Migration end-state assertions (the `0042` §10 pattern, `0042_accounting_journal.sql:501–620`)

Read from `aclexplode(relacl)` rather than `information_schema` (the reason is `0042_accounting_journal.sql:519–525`): no runtime DML on any S2 table; RLS `ENABLE`+`FORCE` on every business-scoped S2 table; both P3-AL-51 directional FKs present and `condeferrable AND condeferred` (P3-AL-51 §A, PM:451); `stock_source_types` and `inventory_operation_movement_kinds` empty; no registered source type lacks bridge + binding trigger (vacuous at S2, L:1530); `products_20_unit_history_lock` present by name, owned by the internal role, `prosecdef`, and sorting after `products_10_…` (L:318, P:169); every S2 function owned by the internal role, `search_path` ending in `pg_temp`, no `PUBLIC` `EXECUTE`; the internal role holds no `CREATE` on `public` at COMMIT (L:1693); prefix `inventory.authority_leak` (L:1683).

### 2.7 `@daftar/inventory` — fixed-point arithmetic (P3-AL-08, P3-AL-49)

| Module (placeholder) | Content | Decision |
| --- | --- | --- |
| _fixed-point_ | quantity as `bigint` × 10⁻⁴, unit cost as `bigint` × 10⁻¹⁰, value as `bigint` minor; exact decimal-string parse/format; no `number` ever holds cost or quantity | L:384 |
| _rounding_ | signed HALF_EVEN over an exact rational (the accepted positive-only algorithm is `packages/accounting/src/fx.ts:57–66`; inventory values can be negative, E-07) | L:385, L:1381–1385 |
| _quantity_ | `abs(qty) = trunc(abs(qty), unitDecimals)` on the value; the ten bound vectors | L:268–293 |
| _valuation_ | outbound partial `HALF_EVEN(qty × avg, 0)`; full-depletion flush `−valuation`; `transfer_in = −transfer_out`; value-only per coverage; average `HALF_EVEN(valuation / on_hand, 10)` | L:1376–1387, L:455 |
| _rebuild_ | pure fold over stored `(qty_delta, value_delta)` ordered by `stock_seq`; average derived afterwards; last average carried at zero | L:1220–1229, L:1411 |
| _vectors_ | JSON shared by TS and SQL: 10 precision vectors, 9 rounding/valuation vectors, the P3-AL-08 arithmetic vectors (A-09) | L:280–291, L:390, L:1393–1405 |

The landed-cost allocator (L:383) is not in the P3-S2 deliverable list (P:146) and belongs with P3-S4's first use.

### 2.8 Guards and gate

- `scripts/guards/no-float-rate.ts:29–30` watches `journal_lines`, `journal_entries`, `accounts` and the `accounting_` prefix only; P3-AL-08 extends it to the inventory tables (L:382).
- `scripts/guards/no-authoritative-balance.ts:24`, `:50` must **name** `stock_levels` as the one explicit exception rather than be weakened (L:1260).
- New static guard: no `on_hand × avg` valuation path in the package or migration SQL (P:164, PM:365); no `scale(` on a quantity (PM:351); no `round(` in inventory SQL (L:387).
- `scripts/static-guards.ts:103–123` (rule 6b) lists the TS directories where `Number(`/`parseInt` on money is forbidden; `packages/inventory/src` is not in it (rule 6 at `:85–94` already walks `packages`).
- `scripts/phase3-s2-gate.ts` and `gate:phase3:s2` in `package.json` (pattern `package.json:43–52`), composing `gate:phase3:s1` (P:289–293).
- Managed-PostgreSQL contract for the S2 migrations (P:275–285): fresh `0000 → S2 head`, upgrade `S1 head → S2 head`, rerun no-op, catalogue equal to a superuser build (`npm run check:deployment-authority`, `package.json:39`).

---

## 3. Test matrix

Every row is a permanent test. **ALLOW** rows prove the matrix can say yes (precedent: `tests/security/accounting-raw-sql-invariants.test.ts:167`). **DENY** rows name the exact refusal. `42501` = insufficient privilege, `23505` unique, `23503` FK, `23514` check, all SQLSTATEs. "UNSPECIFIED" means the lock names no code (A-04). Every DENY group carries a **negative control**: the same test with the invariant removed inside a rolled-back transaction must turn red (PM:677).

**Harness (not decisions — options the implementer needs because no producer exists at the end of S2, L:1992).**

- **H-1 owner raw SQL.** As the schema owner, raw SQL, one rolled-back transaction per case, reporting whether refusal came at the statement or at COMMIT (`tests/security/accounting-raw-sql-invariants.test.ts:1–21`, `:52–56`).
- **H-2 fixture producer.** Inside a transaction as the deployment/test authority: a fixture `op_code` in `inventory_operation_kinds` (must match `^[a-z]+(\.[a-z_]+)+$`, L:1864), its rows in `inventory_operation_movement_kinds`, a fixture `stock_source_types` row with its bridge and binding trigger, a fixture entry routine owned by the internal role that consumes the fixture kind and calls the primitive, and an assertion minted with the test key. The lock prescribes a **rolled-back** fixture (L:1437, P:147); the concurrency rows need **committed** fixtures (A-11).
- **H-3 two real connections, forced interleaving** (`tests/integration/accounting-concurrency.test.ts:18–31`).
- **H-4 one specification, two implementations**: the SQL side is interrogated through the primitive's own helper, never a test-only copy (`tests/integration/accounting-fx-parity.test.ts:1–22`).

### T-01 Append-only ledger (P:153; L:172, L:1548)

| # | Kind | Case | Path | Expected |
| --- | --- | --- | --- | --- |
| T-01.1 | ALLOW | insert a well-formed movement + binding + bridge (H-2) | fixture routine | commits |
| T-01.2 | DENY | `UPDATE stock_movements` any column | owner (H-1) | append-only trigger, UNSPECIFIED code |
| T-01.3 | DENY | `DELETE FROM stock_movements` | owner | same |
| T-01.4 | DENY | `UPDATE`/`DELETE stock_source_bindings` | owner | same |
| T-01.5 | DENY | the same four as `daftar_app` | raw `daftar_app` | `42501` (authorization, kept in a separate file: `tests/security/accounting-credential-matrix.test.ts:10–21`) |
| T-01.6 | NOTE | owner `TRUNCATE` is **not** refused; nothing may claim it is (E-24) | — | — |
| T-01.N | CONTROL | drop the trigger in-transaction → T-01.2 succeeds | owner | test red |

### T-02 Live grant matrix (P:154, P:293; L:173, L:1760–1787)

| # | Kind | Case | Expected |
| --- | --- | --- | --- |
| T-02.1 | DENY | every runtime role × `INSERT/UPDATE/DELETE/TRUNCATE` × every S2 table, **discovered from the catalogue** (`tests/security/accounting-credential-matrix.test.ts:22–27`) | `42501` |
| T-02.2 | DENY | every runtime role × `EXECUTE` on the primitive, the HALF_EVEN helper, rebuild verify/swap, the history-lock function | `42501` |
| T-02.3 | ALLOW | `daftar_app` `SELECT` on `stock_movements` / `stock_levels` in its business | rows of its business only |
| T-02.4 | DENY | membership in `daftar_inventory_internal` for any runtime role, transitively | none (L:1679) |
| T-02.5 | DENY | every S2 function owned by the internal role: `search_path` not ending `pg_temp`, `PUBLIC` `EXECUTE`, owner can log in | none (L:1689–1695, PM:617) |
| T-02.N | CONTROL | grant `INSERT` on `stock_levels` to `daftar_app` in-transaction → T-02.1 red | — |

### T-03 First-touch concurrency (P:155; L:351–357; PM:25–37)

| # | Kind | Case | Expected |
| --- | --- | --- | --- |
| T-03.1 | ALLOW | two connections, first movement on the same **new** key, interleaved so B's `INSERT … ON CONFLICT DO NOTHING` runs while A holds the row | one `stock_levels` row; movements `stock_seq` 1 and 2; average equal to the serial result |
| T-03.2 | ALLOW | same with A rolling back | B commits with `stock_seq = 1`; `last_stock_seq = 1` (gapless) |
| T-03.3 | DENY | identical-identity retry racing on one key | one movement; loser gets the idempotent result, not `23505` surfaced to the caller (PM:57–59); no seq gap (E-04) |
| T-03.N | CONTROL | replace the locking read with a plain read → lost update observed | — |

### T-04 Multi-key lock order (P:156; L:367–374; PM:39–51)

| # | Kind | Case | Expected |
| --- | --- | --- | --- |
| T-04.1 | ALLOW | two real connections, fixture multi-key command A→B and B→A, same variant | both complete; no `40P01` |
| T-04.2 | ALLOW | payload order deliberately reversed relative to UUID order | keys still locked in ascending `(warehouse_id, variant_id)` `uuid` order (observable via `pg_locks`/blocking order) |
| T-04.3 | DENY | any retry loop around a deadlock | forbidden by construction (L:372); static check that no retry exists |
| T-04.N | CONTROL | fixture that locks in payload order → deadlock reproduced | — |

### T-05 TS ↔ SQL parity (P:157; L:390, L:1393)

| # | Kind | Case | Expected |
| --- | --- | --- | --- |
| T-05.1 | ALLOW | every vector in the shared JSON through `@daftar/inventory` and through the primitive's own SQL helper (H-4) | byte-identical integers and 10-decimal averages |
| T-05.2 | ALLOW | HALF_EVEN ties `+0.5 → 0`, `+1.5 → 2`, `+2.5 → 2`, and the negative mirrors `−0.5 → 0`, `−1.5 → −2` | identical in both |
| T-05.N | CONTROL | substitute PostgreSQL `round()` → `+0.5 → 1` disagrees (L:1389) | — |

### T-06 Exact rebuild (P:158; L:1214–1236; L:1409–1411; PM:11–23)

| # | Kind | Case | Expected |
| --- | --- | --- | --- |
| T-06.1 | ALLOW | key with hundreds of movements incl. value-only, repeating averages, full depletions, transfer legs | rebuilt `on_hand` equal to 4 dp, `valuation_base_minor` equal to the unit, average equal to 10 dp |
| T-06.2 | ALLOW | key that empties and refills | average carried at zero, recomputed on refill |
| T-06.3 | ALLOW | key whose row exists with `last_stock_seq = 0` and no movement (E-29) | rebuild equals cache |
| T-06.4 | ALLOW | verify mode on a drifted cache (drift planted by owner) | reports mismatch, **writes nothing** (L:1233, L:1236) |
| T-06.5 | DENY | any routine that sets a cache value to a supplied number | none exists (L:1235) — catalogue + static check |
| T-06.6 | ALLOW | rebuild concurrent with a live movement on the same key | rebuild waits on the key lock; final cache equals fold (L:1232) |
| T-06.N | CONTROL | fold using `on_hand × avg` → valuation differs (PM:367) | — |

### T-07 Movement shape (P:159; L:444–453)

| # | Kind | Case | Expected |
| --- | --- | --- | --- |
| T-07.1 | ALLOW | quantity movement: `qty ≠ 0`, cost snapshot, value any integer incl. `0` (vector C) | accepted |
| T-07.2 | ALLOW | value-only: `qty = 0`, cost `NULL`, value `≠ 0` | accepted |
| T-07.3 | DENY | `qty = 0` with non-NULL `unit_cost_base_minor` | `23514` |
| T-07.4 | DENY | `qty ≠ 0` with `NULL` cost | `23514` |
| T-07.5 | DENY | `qty = 0` and `value = 0` | `23514` |
| T-07.6 | DENY | kind whose `qty_sign` forbids the sign (e.g. negative on a `positive` kind; non-zero on a `zero` kind) | UNSPECIFIED (A-04) |
| T-07.7 | DENY | `requires_reason` kind with no reason | UNSPECIFIED; storage of the reason unspecified (A-19) |

### T-08 Quantity precision (P:160; L:268–295; PM:81–93, PM:347–359)

| # | Kind | `unit_decimals` | qty | Expected |
| --- | --- | --- | --- | --- |
| T-08.1 | ALLOW | 0 | `1`, `1.0000` | accepted |
| T-08.2 | ALLOW | 0 | `-3.0000` on a kind whose `qty_sign` admits negatives | accepted |
| T-08.3 | DENY | 0 | `0.5`, `1.0001` | `inventory.quantity_precision_invalid` |
| T-08.4 | ALLOW | 2 | `1.23`, `1.2300` | accepted |
| T-08.5 | DENY | 2 | `1.234`, `0.0001` | `inventory.quantity_precision_invalid` |
| T-08.6 | ALLOW | 4 | `1.2345` | accepted |
| T-08.7 | ALLOW | 0, after `units.default_decimals` for the unit is changed to 3 by the owner | `1` accepted, `0.5` refused — the product's frozen value governs (L:274) |
| T-08.N | CONTROL | swap in `scale(qty) > unit_decimals` → T-08.1 refused (PM:355) | — |

### T-09 The nine rounding and valuation vectors (P:161; L:1391–1407)

One test per vector A–I, each asserting stored movement value(s), `stock_levels.valuation_base_minor`, Inventory journal line(s), rounding treatment, GL total and the reconciliation equation. **B and C** are also kept as negative controls: the withdrawn aggregate-rounding query gives `1` where the model gives `2` and `0` (PM:437). How the journal/GL columns are proved before any inventory accounting source exists is A-10.

### T-10 Full depletion (P:162; L:1382, L:1387; PM:375–387)

| # | Kind | Case | Expected |
| --- | --- | --- | --- |
| T-10.1 | ALLOW | vector G: receive 3 @ 10, issue 1, 1, 1 | values `+10, −3, −4, −3`; cache `10 → 7 → 3 → 0`; outbound total = inbound total |
| T-10.2 | DENY | any committed state `on_hand = 0 AND valuation_base_minor <> 0` for a touched key | refused before COMMIT; mechanism and code open (A-22, A-04) |
| T-10.N | CONTROL | price the last issue at `HALF_EVEN(qty × avg)` instead of the flush → valuation `≠ 0` (PM:381) | — |

### T-11 No second conversion (P:163; L:389, L:1359–1364)

| # | Kind | Case | Expected |
| --- | --- | --- | --- |
| T-11.1 | DENY | any inventory posting touching `rounding` (6100) | zero such lines, **queried from the entries** — blocked on A-10 at S2 |
| T-11.2 | ALLOW | journal Inventory line = Σ stored movement values of the operation (equation (3), L:1352) | equality — blocked on A-10 at S2 |

### T-12 Static guards (P:164; PM:365, PM:351)

| # | Kind | Case | Expected |
| --- | --- | --- | --- |
| T-12.1 | DENY | `on_hand * avg…` (any spelling the guard defines) in `packages/inventory/src` or inventory migration SQL | guard fails |
| T-12.2 | DENY | `scale(` applied to a quantity; `round(` in inventory SQL; `FLOAT`/`REAL`/`DOUBLE PRECISION` in any inventory table | guard fails |
| T-12.3 | DENY | an ordering over movements or deficits by `created_at` (PM:295) | guard fails |
| T-12.4 | ALLOW | `stock_levels` passes the balance guard **by name** only | exception is explicit (L:1260) |
| T-12.N | CONTROL | each guard run against a planted violation fixture file fails | — |

### T-13 Source registry (P:165; L:1414–1439)

| # | Kind | Case | Expected |
| --- | --- | --- | --- |
| T-13.1 | DENY | movement / binding with `source_type` `'purchase '`, `'Purchase'`, `'sale'` | `23503` at the statement |
| T-13.2 | ALLOW | registered fixture type inside H-2 | accepted |
| T-13.3 | ALLOW | registry row count after migration | `0` |

### T-14 Source completeness (P:166; L:1449–1548; PM:403–415, PM:459–471)

| # | Kind | Case | Expected |
| --- | --- | --- | --- |
| T-14.1 | DENY | movement without binding | `23503` **at COMMIT** |
| T-14.2 | DENY | binding without movement | `23503` at COMMIT |
| T-14.3 | DENY | movement + binding whose `source_line_id` has no bridge / no domain line (fixture type with its binding trigger) | binding trigger at COMMIT; bridge FK `23503` |
| T-14.4 | DENY | delete the bound fixture source line | `23503` (`ON DELETE RESTRICT` on the bridge) |
| T-14.5 | DENY | update a finalized fixture line's quantity / cost / variant / warehouse | fixture freeze trigger (the mechanism S2 hands to each source slice, L:1548) |
| T-14.6 | DENY | migration-time assertion with a registered type lacking bridge or trigger | migration refuses to commit (L:1530) |
| T-14.N | CONTROL | install the check as a **source-side** trigger only → T-14.3 commits (PM:467) | — |

### T-15 Binding cardinality (P:167; L:1484–1492; PM:445–457)

| # | Kind | Case | Expected |
| --- | --- | --- | --- |
| T-15.1 | ALLOW | one fixture line, two kinds (`transfer_out`, `transfer_in` if registered, else two fixture kinds) | two bindings, two movements, both FKs resolve |
| T-15.2 | DENY | third binding for the same line and kind | `23505` |
| T-15.3 | ALLOW | `pg_constraint` shows both FKs over the five-part key, deferrable, initially deferred | present |

### T-16 Primitive authority (P:168; L:1990–1992, L:2042; PM:627–657)

| # | Kind | Case | Path | Expected |
| --- | --- | --- | --- | --- |
| T-16.1 | DENY | call the primitive | each runtime role | `42501` |
| T-16.2 | DENY | reach the primitive with no consumed assertion in the transaction (owner calling it directly, carrier set) | owner | `inventory.assertion_not_consumed` |
| T-16.3 | DENY | carrier absent | owner | `inventory.assertion_missing` |
| T-16.4 | DENY | consumed fixture kind that does not map to the requested movement kind | H-2 | refused, UNSPECIFIED (A-04) |
| T-16.5 | DENY | consumed assertion for business B; movement names a key of business B while GUC is A | H-2 | `inventory.assertion_scope_mismatch` (step 9) |
| T-16.6 | DENY | verified business A; movement arguments name a warehouse/variant of business B | H-2 | refused; code UNSPECIFIED; composite FK `23503` as backstop |
| T-16.7 | DENY | assertion consumed in an **earlier** transaction, primitive reached in a later one | H-2 | `inventory.assertion_not_consumed` |
| T-16.8 | ALLOW | consumed fixture kind mapped to the movement kind | H-2 | movement written; actor = verified actor, never `app.actor_user_id` |
| T-16.N | CONTROL | primitive without its `inventory_assertion_current` call → T-16.2 succeeds (PM:635) | — | — |

### T-17 Unit history lock (P:169; L:298–343, L:1739–1758; PM:517–531)

| # | Kind | Case | Path | Expected |
| --- | --- | --- | --- | --- |
| T-17.1 | ALLOW | tracked, no movement: change `unit_code` (row 2, S1-owned but re-run) | `inventory_configure_product` | allowed |
| T-17.2 | DENY | after first movement: change `unit_code` (row 3) | `inventory_configure_product` | `inventory.unit_identity_locked` |
| T-17.3 | DENY | same, raw `UPDATE` | raw `daftar_app` | `inventory.configuration_authority_required` (guard 1 fires first) — conflicts with L:338 (A-12) |
| T-17.4 | DENY | same, raw `UPDATE` executed **as** `daftar_inventory_internal` (test does `SET ROLE` from the owner) | internal role | `inventory.unit_identity_locked` — proves guard 2 independently of guard 1 |
| T-17.5 | DENY | same, raw `UPDATE` by the owner with **no** business GUC | owner | refused (guard 1); with guard 1 dropped in-transaction, guard 2 still refuses — proves the definer read is not RLS-blinded (`0042_accounting_journal.sql:455–462`) |
| T-17.6 | DENY | rows 3–5 for `unit_decimals` (row 4) and after stock returns to zero (row 5) | command + raw | as T-17.2–T-17.5 |
| T-17.7 | ALLOW | disable tracking at zero, re-enable (row 6) | command | historical unit unchanged; argument semantics open (A-13) |
| T-17.8 | ALLOW | owner changes `units.default_decimals` (row 8) | owner | every product's persisted `unit_decimals` unchanged |
| T-17.9 | ALLOW | change `products.unit` (free label) with history (row 7) | catalog path | allowed; guard 2 not fired (`WHEN` clause) |
| T-17.10 | ALLOW | `pg_trigger` shows `products_20_unit_history_lock` by name, after `products_10_…` | catalogue | present, ordered |
| T-17.11 | DENY | unit change racing a first movement on the same product (E-05) | H-3 | never both commit — mechanism open (A-23) |
| T-17.N | CONTROL | drop guard 2 in-transaction → T-17.2 allowed | — | — |

### T-18 Tenant isolation (cross-cutting)

| # | Kind | Case | Expected |
| --- | --- | --- | --- |
| T-18.1 | DENY | `daftar_app` with business A GUC reads stock rows of business B | zero rows (precedent `tests/security/db-privileges.test.ts:57`) |
| T-18.2 | DENY | `daftar_app` sets `app.bypass_rls = true` | no extra rows (`0010_db_roles.sql:8–11`) |
| T-18.3 | DENY | stock row whose `tenant_id` differs from its business's tenant | `23503` via `(tenant_id, business_id)` |
| T-18.4 | DENY | binding/movement pair split across businesses | `23503` (business in every composite FK) |
| T-18.5 | DENY | internal role's identity `SELECT` policy used to **write** another business's row | `WITH CHECK` refuses (restrictive policy excludes the identity, `0042_accounting_journal.sql:391–393`; A-18) |
| T-18.6 | DENY | rebuild verify called for business A returns anything about business B | nothing |

### T-19 Managed PostgreSQL and upgrade (P:275–285; L:1802–1810)

Fresh `0000 → S2 head` and upgrade `S1 head → S2 head` as `daftar_migrator` (`rolsuper = false`, `rolbypassrls = false`); rerun no-op; catalogue diff against a superuser build empty; every ownership transfer bracketed in the same file; any replacement of an internal-role function (A-13) under `SET LOCAL ROLE` (L:1809). Extends `tests/integration/migration-portability.test.ts` and `scripts/phase2-deployment-authority.ts`.

### T-20 Deficit entities, ordering only (L:469, L:480; PM:277–303)

| # | Kind | Case | Expected |
| --- | --- | --- | --- |
| T-20.1 | DENY | `original_deficit_qty <= 0`; `uncovered_qty < 0`; `uncovered_qty > original_deficit_qty` | `23514` (DM:275–277) |
| T-20.2 | DENY | duplicate `deficit_seq` per key | `23505` (DM:278) |
| T-20.3 | ALLOW | two deficits seeded by the owner in one transaction (equal `created_at`) | FIFO read by `(deficit_seq, id)` is deterministic across runs (PM:297) |
| T-20.4 | DENY | coverage with `qty_covered <= 0` | `23514` — column set per A-06 |

### T-21 Negative-stock boundary (L:463; IR:163) — ownership flagged

| # | Kind | Case | Expected |
| --- | --- | --- | --- |
| T-21.1 | DENY | outbound quantity `> on_hand` at the locked row, any negative kind | `inventory.insufficient_stock` |
| T-21.2 | ALLOW | outbound exactly `= on_hand` | accepted; full-depletion flush |

P3-AL-12 places the refusal "in the trusted command, under the lock" (L:463) and splits the slice as "P3-S2 (entities) and P3-S4 (coverage)" (L:461); plan §4 lists no `insufficient_stock` proof (P:151–169). If the primitive owns the check, S2 should prove it; see A-03.

---

## 4. Edge-case and threat inventory

| # | Scenario | Where it bites in S2 | Source | Required control / test |
| --- | --- | --- | --- | --- |
| E-01 | Two first-touches of a new key | primitive step 1–2 | PM:25–37, L:357 | `ON CONFLICT DO NOTHING` then unconditional `FOR UPDATE`; T-03 |
| E-02 | `ON CONFLICT DO UPDATE` with a computed value (arithmetic outside the lock) | primitive | L:357 | forbidden; code review + T-03.N |
| E-03 | Opposite multi-key commands deadlock; "fixed" with a retry | lock order | PM:39–51, L:372 | sort after parse, before first lock; T-04 |
| E-04 | Idempotent retry detected **after** `stock_seq` was allocated or the cache updated → gap or double count | primitive ordering | PM:31, PM:57 | identity check under the key lock before seq allocation; T-03.3 |
| E-05 | Unit change committed concurrently with a product's first movement: the history lock's `EXISTS` cannot see the uncommitted movement, so both commit and history is silently reinterpreted | history lock vs primitive | PM:517–531 | needs a row-lock protocol between `products` and stock keys the lock does not state (A-23); T-17.11 |
| E-06 | Tracking disabled at `on_hand = 0` while an uncommitted receipt raises it | configure vs primitive | L:1208–1209 | same as E-05 (A-13, A-23) |
| E-07 | HALF_EVEN on **negative** exact values; PostgreSQL `round()` is HALF_UP; NUMERIC `/` rounds at a bounded scale | helper, average, value-only | L:1389; `0043_accounting_invariants.sql:214–219`; `packages/accounting/src/fx.ts:59–60` (positive-only) | sign-symmetric helper via `div()`/remainder; T-05.2 |
| E-08 | Valuation reconstructed from `on_hand × avg` | primitive, rebuild, reports | PM:361–373, L:1370 | static guard + T-06.N |
| E-09 | Emptied key keeps residual value | primitive | PM:375–387 | flush; T-10 |
| E-10 | Aggregate rounding in reconciliation | vectors | PM:431–443 | integers only; T-09 B/C |
| E-11 | `scale(qty)` reintroduced | precision | PM:347–359 | guard + T-08.N |
| E-12 | A `number` holds cost/quantity in TS | package | L:384; `scripts/static-guards.ts:85–94` | rule 6; add package to rule 6b (§2.8) |
| E-13 | Fake source; line-grained binding; source-side-only trigger | bindings | PM:403–471 | T-13–T-15 |
| E-14 | History lock blinded by RLS for an owner/platform writer with no business GUC | history lock | L:1748; `0042_accounting_journal.sql:455–462` | definer + identity policy; T-17.5 |
| E-15 | `search_path` hijack via `pg_temp` | every S2 definer | PM:611–625 | §D; T-02.5 |
| E-16 | Primitive reachable without an assertion | primitive | PM:627–641, L:2042 | no runtime `EXECUTE`; `inventory_assertion_current` first; T-16 |
| E-17 | A consumed assertion of one kind drives another movement kind | primitive | PM:643–657, L:1992 | mapping table; T-16.4 |
| E-18 | Identity `SELECT` policy lets the internal role read **every** business's movements; a primitive bug then reads across tenants | primitive, rebuild | L:1748 | every S2 query filters by the verified business; T-18.6 |
| E-19 | The primitive re-verifies kind and business but **not** the payload digest, so an entry routine bug could move stock in a warehouse the signed payload never named | primitive boundary | L:1990 (step 7 not repeated) | A-24 |
| E-20 | Rebuild run before the defect is fixed destroys the evidence | rebuild swap | PM:21, PM:371 | verify-then-report; swap only by deliberate authority (A-16) |
| E-21 | A tolerance is introduced "temporarily" | reconciliation, rebuild | PM:680 | zero tolerance everywhere; no epsilon helpers in the package |
| E-22 | A test that only ever passes | all | PM:677 | negative control per group (§3) |
| E-23 | `scripts/static-guards.ts:96–101` rule 6 matches `(amount\|price\|total\|balance)\w*\s+NUMERIC(p,s)` anywhere in a migration — a PL/pgSQL local such as `v_total_exact NUMERIC(38,14)` or DM:288's `catch_up_amount_base_minor NUMERIC(28,10)` fails the build | primitive, deficits | `scripts/static-guards.ts:96–101` | naming discipline; A-06 |
| E-24 | Owner `TRUNCATE` bypasses row triggers; `resetData` truncates `businesses … CASCADE` | test harness | `tests/helpers/test-app.ts:138–146`; `0042_accounting_journal.sql:426` | do not add a `TRUNCATE` trigger without changing the harness; do not claim `TRUNCATE` is refused |
| E-25 | `created_at` ties (transaction-start `now()`) | FIFO, rebuild | PM:291–303, L:186 | order by `stock_seq` / `(deficit_seq, id)`; T-12.3, T-20.3 |
| E-26 | `qty × cost` exceeds `BIGINT` (14 integer digits × 18) or the journal cap 10¹⁸ | primitive | `0042_accounting_journal.sql:168–170`; `packages/accounting/src/types.ts:25` | A-26 |
| E-27 | Negative `on_hand` (Phase 4 deficits) and negative averages | fold, average | IR:80, L:469 | package and SQL fold defined for signed values even though Phase 3 cannot produce them |
| E-28 | Vector C (a zero-value quantity movement) confused with "invented zero cost" (L:670) | tests | L:1399, L:670 | tests distinguish rounding-to-zero from a zero unit cost |
| E-29 | A key row locked by a command that then writes no movement on it | rebuild | L:353 | rebuild of a movement-less row equals `(0, 0, NULL, 0)`; T-06.3 |
| E-30 | One carrier per transaction (`app.inventory_assertion`), strict single consumption | harness | L:1902, L:2002 | tests composing a fixture movement and a configure call re-set the carrier between calls |
| E-31 | Guard order depends on trigger **names** | products triggers | L:1741 | T-17.10; renaming either trigger is a breaking change |
| E-32 | Lock-then-read correctness assumes `READ COMMITTED` | primitive | `apps/api/src/infra/database.ts:169` (plain `BEGIN`) | a seam that raises isolation would change every S2 concurrency result; T-03 under the real seam default |

---

## 5. Open ambiguities in the lock for P3-S2 (listed, not resolved)

| # | Ambiguity | Exact lines | Why it matters for S2 |
| --- | --- | --- | --- |
| A-01 | The internal role's P3-S2 grants: §H says it "additionally holds `SELECT` on `stock_movements` … and on `stock_levels` …; **nothing else is added**", while the primitive it owns must `INSERT` movements, bindings and cache rows and `UPDATE` the cache | L:1783 vs L:173–174, L:351–355, P:147 | the grant matrix test (T-02) cannot be written until the exact set is fixed |
| A-02 | The movement primitive has no name, signature or granularity (one movement vs a multi-line batch); where lock-order sorting lives (entry routine vs primitive); who computes `value_delta_base_minor` — "computed and stored by the command (never by the caller)" vs a priced document's largest-remainder share that only the document-level caller can compute | L:452, L:367–370, L:1380, L:1990–1992, P:147 | decides the primitive's API and every S3–S5 caller |
| A-03 | The precision refusal and `inventory.insufficient_stock` live "in the trusted command" / "through every command", but at S2 the only writer is the primitive and no command exists | L:295, L:463, P:160, PM:87 | whether S2 proves them at the primitive or S3 re-proves per command |
| A-04 | Refusal codes the lock does not name: append-only on `stock_movements`/bindings; `stock_levels` deletion; `qty_sign` violation; missing reason; unmapped op→movement kind ("refused"); other-business movement ("refused"); `on_hand = 0 ⇒ valuation = 0` violation; untracked product / archived variant or warehouse; value/quantity overflow | L:172, L:359, L:432, L:1387, L:1992, P:168 | tests must assert a stable code, not a message fragment |
| A-05 | Which slice seeds `stock_movement_kinds`: "Registered by Phase 3" with no slice, while its twin registries follow "registered by the slice that implements it"; `qty_sign` / `requires_reason` are stated for only three of the ten kinds | L:426–432 vs L:1056, L:1422, L:1437; P:141 | S2 either seeds ten rows or none; S3 mappings depend on it |
| A-06 | `negative_deficit_coverages` shape: "exactly as `DAFTAR_DATA_MODEL.md` §10ب" (`receipt_stock_movement_id`, `catch_up_amount_base_minor NUMERIC(28,10)`, `journal_entry_id`) vs the header/detail model (`adjustment_id` → `negative_inventory_cost_adjustments`) vs the plan placing the header/detail source in P3-S4 vs IR's movement-id layers; the NUMERIC catch-up column also contradicts P3-AL-49's `BIGINT` value and trips static rule 6 | L:469 vs L:492–501, L:1384; DM:281–292; P:41 vs P:142; IR:99–100; `scripts/static-guards.ts:96–101` | S2 cannot create the table without choosing a column set |
| A-07 | Storage of the `deficit_seq` counter "under the same stock-key lock as `stock_seq`" — no counter column is listed on `stock_levels` (whose columns are "at minimum") | L:155–162, L:469 | shape of `stock_levels` |
| A-08 | Stale rounding scale: value-only catch-up `HALF_EVEN(…, 10)` and the self-review row `HALF_EVEN(exact(qty × unit_cost), 10)` vs §C's scale-0 integer; P3-AL-08 still describes the persistence boundary as `NUMERIC(28,10)` | L:486, L:2092, L:385–386 vs L:1381–1385 | which scale the package and helper implement for values |
| A-09 | Vector sets: plan "the **five** valuation vectors"; lock "**all nine**" (§D); P3-AL-08 "**six**" arithmetic vectors of which GOLD-44/54/55/72 are "the first four" although its own list order is receipt, transfer, +adj, −adj, PPV, catch-up | P:146 vs L:1393, L:390 | the vector file's contents and the S2 acceptance count |
| A-10 | The §D vectors require "the Inventory journal line, … the GL total and the reconciliation equation", and plan §4 requires "no inventory posting carries a 6100 line — asserted by querying the entries", but no inventory accounting source type exists until P3-S3 and posting one needs registry changes guarded by permanent predecessor assertions | L:1393, P:161, P:163 vs L:1042–1043, L:116–123 | either a fixture accounting source (in a rolled-back transaction) or a deferral of those columns to S3 |
| A-11 | Fixtures are prescribed "inside a rolled-back fixture" / "inside a rolled-back transaction", but the two-connection concurrency proofs need fixture rows visible to a second session, i.e. committed | L:1437, P:147 vs P:155–156, L:374, PM:31 | T-03/T-04 harness |
| A-12 | Unit matrix rows 3–4 require `inventory.unit_identity_locked` "through the command **and** as raw SQL", but guard 1 fires first for any raw writer other than the internal role and answers `inventory.configuration_authority_required` | L:338–339 vs L:1752, P:169 | the expected code for the raw path (T-17.3/T-17.4) |
| A-13 | P3-AL-41 ownership and the configure routine: index says P3-S3; §E and §H say the disable-at-non-zero rule applies "from P3-S2"; unit row 6 (disable at zero, re-enable) is owned by P3-S2; no refusal code for disabling with stock; whether re-enabling ignores, requires-equal or refuses a different `p_unit_code` is not stated; replacing the S1-owned routine is itself an S2 work item the plan does not list | L:78, L:1202–1210, L:1705, L:1783, L:308, L:329, L:341; P:137–149 | whether S2 ships a `CREATE OR REPLACE` of an S1 routine (under `SET LOCAL ROLE`, L:1652) |
| A-14 | "P3-S1 creates … the command-level refusal" of unit change after history, which cannot exist before `stock_movements` does; §G shows the refusal coming from the trigger only | L:316 vs L:1755 | whether S2 adds a command-level check or relies on the trigger |
| A-15 | "In the same statement" for the cache write and `last_stock_seq` write-back: literal single SQL statement (data-modifying CTE) or same transaction under the lock | L:174, L:188; PM:13 | primitive structure and its tests |
| A-16 | Rebuild authority: the swap "is likewise internal, has no runtime `EXECUTE`, and would need its own registered kind"; the PM-44 guard requires every internal-role writer of a stock table to call consume/current first; who may run verify mode (reconciler is S8's read principal) is unstated; how S2 acceptance invokes the swap is unstated | L:1992, L:1233, L:1252, PM:633–635, P:148 | owner, grants and callability of the two rebuild routines |
| A-17 | Read grants on the stock tables beyond `daftar_app` (`daftar_platform`, `daftar_worker`, `daftar_reconciler`) and on the new registries | L:173; precedent `0042_accounting_journal.sql:436–440` (journal readable by app/platform/worker; registries granted to nobody) | T-02 exact matrix |
| A-18 | The identity `FOR SELECT` policy on `stock_movements` is specified alone; in the accepted precedent the restrictive `business_isolation` policy must also admit the principal on `USING` (and not on `WITH CHECK`) or the permissive policy is inert; whether `stock_levels` needs the same for the disable rule | L:1748, L:1783; `0042_accounting_journal.sql:389–393` | RLS DDL |
| A-19 | `stock_movements` columns beyond the value triple: `id`/PK (DM's deficits reference a movement id), `tenant_id`, actor, `business_transaction_id`, reason text for `requires_reason`, consumed `jti`; DM names the snapshot `movement_unit_cost_base_minor`; DM still says the average "is never an input to any write", which §B withdrew | L:1332–1336, L:1368–1372; IR:5; DM:243–244, DM:268 | table DDL and T-07.7 |
| A-20 | FK delete actions from the stock tables to `businesses` / `warehouses` / `product_variants`, and the mechanism behind "`stock_levels` rows are never deleted" (trigger or privilege only); a `BEFORE DELETE` trigger would also block owner-level cascades | L:359, L:1206, L:1730; `0005_catalog.sql:37–48` (cascade chain) | DDL; interacts with E-24 |
| A-21 | The binding-side trigger's naming convention (needed for catalogue discovery) and whether one generic function parameterized by `TG_ARGV` satisfies "no dynamic SQL built from caller input … identifiers fixed at authoring time" | L:1522, L:1530, L:1694 | the mechanism S2 hands to S3–S5 |
| A-22 | Mechanism for `on_hand = 0 ⇒ valuation_base_minor = 0`: "asserted inside the command, under the lock, before COMMIT" — a row `CHECK` would refuse P3-S4's transient state inside a receipt that covers deficits (receipt movement then catch-up) | L:1387, L:484–488, PM:379 | S2 must not ship a constraint that breaks S4 |
| A-23 | No lock protocol between the `products` row and stock keys: the history lock and the disable rule read movements/levels without a lock that orders them against a concurrent first movement (E-05, E-06); P3-AL-07 orders stock keys only | L:367, L:1748, L:1208 | concurrency correctness of the unit lock |
| A-24 | The primitive's re-verification omits the payload digest (step 7): it binds kind and business, not the warehouse/variant/quantity the entry routine was authorized for | L:1990, L:1187, L:1966 | whether the primitive must receive and check the authorized key set |
| A-25 | `business_transaction_id` on movements (listed in IR) has no database source: it is not in any `invpl/1` field list and is "not financial authority" | IR:5; L:1068–1072, L:1956–1964 | column presence and its (unauthenticated) origin |
| A-26 | No upper bound on `value_delta_base_minor`, `valuation_base_minor` or `on_hand`; the journal caps amounts at 10¹⁸ | `0042_accounting_journal.sql:168–170`, `:226–230`; `packages/accounting/src/types.ts:25` | overflow refusal and its code |
| A-27 | An inbound movement's `unit_cost_base_minor` snapshot is "its own cost": for a priced document's integer share, whether it is `HALF_EVEN(share / qty, 10)` or the supplied line cost | L:452, L:385, L:1380 | snapshot semantics fixed by the primitive's API |
| A-28 | `inventory_operation_movement_kinds` constraints: the accounting twin pins `UNIQUE (source_type)` (one owner per identity); whether a movement kind may be reachable from more than one operation kind is not stated | L:1992; `0046_accounting_sources.sql:86–93` | table DDL; least-authority argument of L:1992 |

---

## 6. Proposed agent split and file ownership (for when P3-S2 is authorized)

Principles carried from the common rules: one owner per file; no agent edits a frozen migration; two migration files rather than two agents in one file (precedent: structure `0042` separate from invariants `0043` and the primitive `0045`); the plan promises no migration count (P:32). Migration names below are placeholders numbered after P3-S1's last frozen file.

| Agent | Owns (exclusive) | Depends on | Delivers |
| --- | --- | --- | --- |
| **S2-A · ledger schema** | `infrastructure/database/migrations/<n>_inventory_stock_ledger.sql` | D-01, D-04, D-17; resolutions of A-01, A-05, A-06, A-07, A-17–A-20, A-28 | §2.1–§2.3 tables, registries, append-only triggers, RLS, grants, end-state assertions (§2.6) |
| **S2-B · trusted routines** | `infrastructure/database/migrations/<n+1>_inventory_movement_primitive.sql` | S2-A; D-02, D-05, D-06, D-08, D-09; vectors from S2-C; A-02, A-03, A-13–A-16, A-21–A-24, A-26, A-27 | primitive, HALF_EVEN helper, `products_20_unit_history_lock`, rebuild verify/swap, binding-trigger mechanism, conditional configure replacement |
| **S2-C · package arithmetic** | `packages/inventory/src/` new modules only (not `assertion.ts`/`payload.ts`), `packages/inventory/vectors/` new files, `packages/inventory/test/` new files | D-14; A-08, A-09 | §2.7; the vector JSON is the contract S2-B and S2-D consume — S2-C publishes it first |
| **S2-D · security tests** | `tests/security/inventory-ledger-*.test.ts`, `tests/helpers/inventory-ledger.ts` (H-1/H-2 harness) | S2-A, S2-B, D-15 | T-01, T-02, T-07, T-13–T-16, T-18 |
| **S2-E · integration tests** | `tests/integration/inventory-ledger-*.test.ts` | S2-A, S2-B, S2-C, S2-D harness; A-10, A-11 | T-03–T-06, T-08–T-12 (runtime half), T-17, T-19, T-20, T-21 |
| **S2-F · guards and gate** | `scripts/guards/*` edits named in §2.8, `scripts/static-guards.ts`, `scripts/phase3-s2-gate.ts`, `package.json` script line | S2-A, S2-B | §2.8; T-12 guard half |
| **Agent 0 · coordinator** | `infrastructure/database/MIGRATION_MANIFEST.json` (only on acceptance), `tests/integration/migration-upgrade.test.ts`, `tests/integration/migration-portability.test.ts`, `scripts/phase2-deployment-authority.ts`, `infrastructure/database/bootstrap.sql` comment for the owner list (`bootstrap.sql:192`), any predecessor-test evolution (D-13), acceptance document, full regression (P:297–317) | all | integration, T-19 wiring, gate evidence |

**Order.** (1) Tech Lead resolves or explicitly defers the §5 items that block DDL (A-01, A-02, A-05, A-06, A-07, A-11, A-19, A-20); (2) S2-C publishes vectors while S2-A writes the schema; (3) S2-B against S2-A; (4) S2-D and S2-E against S2-B, S2-D's harness first; (5) S2-F last so its guards read the final SQL; (6) Agent 0 runs the P:297–317 regression and `gate:phase3:s2`.

**Parallelism budget.** The machine has 4 CPUs (common brief); only one agent at a time should run the embedded-PostgreSQL integration suites, each on its own `PG_DIR`/`PG_PORT`.

---

## ملخص

- **التبعيات:** تستهلك P3-S2 من P3-S1 الدورَ الداخلي `daftar_inventory_internal`، والمتحقّق غير المستهلِك `inventory_assertion_current`، وسجل أنواع العمليات، وأعمدة الوحدة المجمَّدة على المنتج، واسم الحارس `products_10_…`، وهيكل الحزمة `@daftar/inventory`. يجب تجميد ترحيلات P3-S1 قبل البدء (§1).
- **ما يُبنى:** دفتر حركات إلحاقي فقط، وذاكرة `stock_levels` قابلة لإعادة البناء، وسجلات مغلقة فارغة للمصادر والربط بين العمليات والحركات، وكيانات العجز بلا مُنتِج، والأولية الموثوقة التي تعيد التحقق من التوكيد، وحارس تاريخ الوحدة، وحساب ثابت الفاصلة بـ`BigInt` (§2).
- **الإثبات:** مصفوفة سماح/رفض لكل بند «يجب إثباته» في الخطة، مع ضابط سلبي لكل مجموعة (§3).
- **الغموض:** ثمانية وعشرون موضعًا في القفل تحتاج قرارًا من قائد التقنية قبل كتابة DDL، أبرزها صلاحيات الدور الداخلي في P3-S2 (A-01)، وشكل جدول تغطيات العجز (A-06)، وتعارض التجهيزات المُتراجَع عنها مع اختبارات التزامن باتصالين (A-11) (§5).
