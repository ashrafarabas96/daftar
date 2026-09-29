# DAFTAR — P3-S2 Contract / عقد الشريحة P3-S2

> **What this is.** The implementation contract for P3-S2 (the immutable stock ledger), fixed by the Phase 3 coordinator before any P3-S2 code was written, under the Tech Lead's 2026-09-26 directive to complete Phase 3. It resolves the 29 ambiguities of `docs/PHASE_3_S2_PREPARATION.md` §5 as engineering rulings (§1) and fixes the database, error, package, harness, test and gate contracts every implementer follows. Where it and `docs/PHASE_3_ARCHITECTURE_LOCK.md` differ, the lock wins unless the ruling states why the lock's literal text cannot be implemented; those cases are listed as notes for the Tech Lead in §9, none of which blocks implementation. Line citations refer to the tree at `61b89d6`.

## 0. Conventions every agent follows

**Error convention.** Every stable refusal is raised as:

```sql
RAISE EXCEPTION '<code>: <text>' USING ERRCODE = 'P0001';
```

This is the precedent at `0054:361`, `:408`, `:545` and `0055:146-172`. Messages never carry quantities, costs or values (L:293, L:312).

**Routine discipline.** Every routine owned by `daftar_inventory_internal`:
- is `SECURITY DEFINER` with `SET search_path = pg_catalog, public, pg_temp`;
- is `LANGUAGE plpgsql` or `sql`;
- contains no dynamic SQL and no TEMP objects;
- never contains the word `EXECUTE` anywhere in its body, including string literals. The G-7 body scan (`/home/user/daftar/scripts/guards/inventory-definer-contract.ts`, `\bEXECUTE\b(?!\s+FUNCTION\b)`) would flag it.

**ACL order** (the inventory precedent at `0053:213-228`): `REVOKE ALL … FROM PUBLIC` while the migrator still owns the routine, then `CREATE TRIGGER`, then `ALTER FUNCTION … OWNER TO daftar_inventory_internal`. All of it happens inside a same-file `GRANT CREATE ON SCHEMA public TO daftar_inventory_internal` … `REVOKE CREATE …` bracket (`0053:52`, `:260`).

**Replacing a routine the internal role already owns** is done under `SET LOCAL ROLE daftar_inventory_internal` … `RESET ROLE`, inside the same bracket (`0040:411-466`; P:283).

**RLS predicates** use the 0052 UUID style (`0052:305-327`):

```sql
tenant_id   = nullif(app_tenant(), '')::uuid
business_id = nullif(app_business(), '')::uuid
```

Note that `app_bypass()` is platform-only (`0052:244-246`).

**Text that static guards scan:**
- Rule 6 scans whole migration files, comments included: `(amount|price|total|balance)\w*\s+(… NUMERIC(p,s))` (`/home/user/daftar/scripts/static-guards.ts:97-102`). So no PL/pgSQL local and no comment may read like `v_total NUMERIC(28,10)` or `balance NUMERIC(…)`. Declare locals as unconstrained `NUMERIC`.
- Rule 7 is `/\.stock\b.*UPDATE|UPDATE.*SET\s+stock\s*=/i` (`static-guards.ts:128-131`). Never alias a table `stock`.

**Isolation.** Correctness assumes READ COMMITTED, which the seam's plain `BEGIN` gives (PREP:386, E-32). Every VOLATILE plpgsql statement takes a fresh snapshot. Tests use the default isolation.

**Naming.**
- Migrations: `0059_inventory_stock_ledger.sql` holds the schema. `0060_inventory_stock_primitive.sql` holds the trusted routines.
- S2 suites are named `stock-ledger-*.test.ts`. They must **not** match the P3-S1 gate's `^inventory-.*\.test\.ts$` discovery (`phase3-s1-gate.ts:141-148`), so they are not double-run.

---

## 1. Rulings A-01 … A-29

**Class** is either **ENG** (an engineering ruling, binding for implementers) or **ENG+TL** (engineering and binding, and reported to the Tech Lead as a non-blocking note in §9).

**A-01 · The internal role's S2 grants.**
- **Class:** ENG+TL (TL-1).
- **Ruling:** the internal role gets exactly these grants:

  | Table | Grant |
  | --- | --- |
  | `stock_movements` | `SELECT, INSERT` |
  | `stock_levels` | `SELECT, INSERT`, plus `UPDATE (on_hand, valuation_base_minor, avg_unit_cost_base_minor, last_stock_seq)` |
  | `stock_source_bindings` | `INSERT` |
  | `stock_movement_kinds` | `SELECT` |
  | `inventory_operation_movement_kinds` | `SELECT` |
  | `negative_inventory_deficits` | `SELECT` |
  | `negative_deficit_coverages`, `stock_source_types` | nothing |

- **Justification:**
  - L:1783 ("SELECT … nothing else is added") literally contradicts L:173 ("every mutation is internal definer verifying invctl/1"), L:174, L:351-355 and P:147 (the primitive is owned by the internal role).
  - A definer runs with its owner's rights, so the owner must hold the DML. This is the only implementable reading: L:1783 enumerates the S2 *read* additions for §G and P3-AL-41.
  - `SELECT … FOR UPDATE` on `stock_levels` needs a column `UPDATE`, which the grant above supplies.
  - Referential-integrity checks run with the table owner's rights (`0042:425-427`), so no grant is needed on `stock_source_types`.

**A-02 · The primitive's API.**
- **Class:** ENG.
- **Ruling:** one batch primitive, `inventory_apply_stock_movements(p_requests inventory_movement_request[])`, specified in §2.5. The lock-order sort lives in the primitive, never in the caller (L:370).
- **Who computes `value_delta_base_minor`:** the primitive computes every value, with two exceptions:
  - a priced document's integer share, supplied by the entry routine and only for `purchase` / `inventory_opening` (L:1380);
  - a value-only amount, supplied by the entry routine per coverage, from P3-S4 on (L:1384).

  "Never by the caller" (L:452) means never by the HTTP caller. The entry routine is part of the trusted command (L:1990-1992).

**A-03 · Where precision and `insufficient_stock` live.**
- **Class:** ENG.
- **Ruling:** S2 proves both at the primitive, the only writer that exists at S2 (L:295, L:463). Each S3+ command re-proves "through every command" for its own kinds (P:160).

**A-04 · Refusal codes the lock does not name.**
- **Class:** ENG.
- **Ruling:** the stable codes of §3. SQLSTATE convention is also in §3.

**A-05 · Seeding `stock_movement_kinds`.**
- **Class:** ENG+TL (TL-9).
- **Ruling:** S2 seeds all ten Phase 3 kinds, `registered_by = 'P3-S2'` (table in §2.2). `stock_source_types` and `inventory_operation_movement_kinds` are seeded with nothing.
- **Justification:**
  - L:426-428 registers the ten "by Phase 3". S2 creates the table (P:141).
  - A movement kind grants no authority: authority is the op→kind mapping, which stays empty (L:1992).
  - L:432 states only three semantics. The other seven are derived from L:463 (the negative kinds) and L:1380-1385 (inbound and the stocktake variance).

**A-06 · Deficit and coverage shape.**
- **Class:** ENG+TL (TL-2).
- **Ruling:**
  - `negative_inventory_deficits` follows DM:266-279, with tenant and business binding added (DM:55).
  - `negative_deficit_coverages` follows the corrected detail model of L:498-500: `(business_id, id, adjustment_id, deficit_id, variant_id, qty_covered, provisional_unit_cost_base_minor, actual_unit_cost_base_minor)`.
  - Omitted:
    - `catch_up_amount_base_minor NUMERIC(28,10)`: contradicts P3-AL-49's `BIGINT` (L:1384) and static rule 6.
    - `receipt_stock_movement_id` and `journal_entry_id`: superseded by the coverage identity (L:503).
  - `adjustment_id` is a `NOT NULL` column now. Its FK to the header is added by P3-S4, which creates the header (P:41).
- **Justification:** L:490-501 explicitly supersedes the §10ب shape of L:469.

**A-07 · Storing `deficit_seq`.**
- **Class:** ENG.
- **Ruling:** no counter column. `inventory_next_deficit_seq(p_business_id, p_warehouse_id, p_variant_id)` locks the stock key `FOR UPDATE` and returns `max(deficit_seq) + 1`. Uniqueness is backed by `UNIQUE (business_id, warehouse_id, variant_id, deficit_seq)` (DM:278).
- **Justification:** L:469 requires "under the same stock-key lock"; L:157-162 lists `stock_levels` columns "at minimum".

**A-08 · Rounding scale.**
- **Class:** ENG.
- **Ruling:** values are integers at scale 0 (P3-AL-49 §C, L:1381-1385). Averages and snapshots use scale 10. The scale-10 wording at L:486 and L:2092 is superseded by §C (L:386).

**A-09 · Which vectors ship.**
- **Class:** ENG+TL (TL-3).
- **Ruling:**
  - 10 precision vectors (L:280-291);
  - 9 §D vectors A–I (L:1393-1405);
  - 5 P3-AL-08 arithmetic families, which are the L:390 list minus PPV: receipt weighted average; transfer (GOLD-44); positive adjustment; negative adjustment; catch-up (GOLD-54, GOLD-55, GOLD-72 as three cases).
  - Supplier-return PPV moves to P3-S5, the slice that creates supplier return.
- **Justification:** the plan's "five valuation vectors" (P:146) are exactly L:390's six minus PPV. P:161 separately requires the nine.

**A-10 · Journal and GL columns before any inventory accounting source exists.**
- **Class:** ENG+TL (TL-4).
- **Ruling:** prove them in one **rolled-back composite transaction** (§5, H-5):
  - Fixture movements go through the real primitive.
  - In the same connection, as `daftar_app`, `accounting_post_manual_adjustment` (`0046:386-392`, reached via `postAs` at `/home/user/daftar/tests/helpers/accounting-posting.ts:149-192`) posts each non-zero stored value, **read back from `stock_movements`**, to system account `inventory` (`0040:53`), offset to `opening_equity` (`0040:58`).
  - The test then queries the journal:
    - Σ over `inventory` lines = Σ stored values = cache valuation;
    - there are zero lines on `rounding` (`0040:64`).
  - A zero-value movement posts no line, because journal lines must be greater than 0 (`0042:221-225`).
  - P3-S3 re-proves this with the real inventory source.

**A-11 · Rolled-back versus committed fixtures.**
- **Class:** ENG.
- **Rolled back is the default** (L:1437, P:147). A "does not survive COMMIT" case either issues a real `COMMIT` (which fails and rolls the fixture back with it) or uses `SET CONSTRAINTS ALL IMMEDIATE` followed by `ROLLBACK`.
- **Committed fixtures are allowed only for the two-connection suites** (P:155-156, L:374):
  - installed in `beforeAll`, preceded by an idempotent cleanup;
  - removed in `afterAll` / `finally`;
  - followed by a post-cleanup assertion that the registries are back to the migration state.
  - This is safe because vitest runs `pool: 'forks', singleFork: true`.

**A-12 · The raw-SQL path of unit-matrix rows 3–4.**
- **Class:** ENG.
- **Raw `UPDATE` as `daftar_app`** returns `inventory.configuration_authority_required`: guard 1 fires first (P:169, L:1752).
- **Raw `UPDATE` executed as `daftar_inventory_internal`** returns `inventory.unit_identity_locked`: the one principal guard 1 admits (`0053:159-161`). The test uses `SET LOCAL ROLE` from the owner.
- **Control:** drop guard 1 in a transaction; guard 2 still refuses.
- **Justification:** P:169 itself states this resolution of L:338.

**A-13 · The P3-AL-41 disable rule and replacing the S1 routine.**
- **Class:** ENG.
- **Ruling:** S2 ships a `CREATE OR REPLACE` of `inventory_configure_product` in `0060`, under `SET LOCAL ROLE` plus the CREATE bracket. It is byte-identical to `0055:99-240` except for one new step after the product lock (`0055:155-163`):

  ```sql
  IF v_old_track AND NOT p_track
     AND EXISTS (SELECT 1 FROM stock_levels l
                 JOIN product_variants v ON v.business_id = l.business_id AND v.id = l.variant_id
                 WHERE v.business_id = v_business AND v.product_id = p_product_id AND l.on_hand <> 0) THEN
    RAISE EXCEPTION 'inventory.tracking_disable_requires_zero_stock: …' USING ERRCODE = 'P0001';
  END IF;
  ```

- **Re-enable semantics are unchanged:**
  - A NULL `p_unit_code` keeps the historical unit (`0055:166-168`). That is "reused without re-asking" (L:329).
  - A different unit is refused by guard 2.
- **Justification:** L:1705 and L:1783 ("from P3-S2") are more specific than the index's "S3" (L:78). Archival stays P3-S3 (L:1204).

**A-14 · A command-level unit-history check.**
- **Class:** ENG.
- **Ruling:** none. The trigger is the refusal (L:1755). L:316's "command-level refusal" cannot exist before the table does.

**A-15 · "Same statement".**
- **Class:** ENG.
- **Ruling:** literal. The movement INSERT, the binding INSERT and the cache UPDATE (including `last_stock_seq`) are one SQL statement, using data-modifying CTEs, per movement, under the key lock (L:174, L:188).

**A-16 · Rebuild authority.**
- **Class:** ENG+TL (TL-5).
- **Ruling:** S2 ships the algorithm (`inventory_stock_fold`) and verification mode (`inventory_stock_verify`). Both are internal, have no `EXECUTE`, and write nothing.
- **No swap routine exists at S2.** P:148 lists only "algorithm and verification mode". L:1992 says a swap "would need its own registered kind". L:1235 forbids any value-setting routine.
- **Justification:** PM-44's guard targets writers, and verify writes nothing.

**A-17 · Read grants.**
- **Class:** ENG.
- **Ruling:** `daftar_app` gets `SELECT` on `stock_movements` and `stock_levels` only (L:173). Every other runtime role gets nothing. Registries are granted to no runtime role.
- **Precedent:** `0042:433-443`, where registries are granted to nobody. The reconciler's read belongs to P3-S8 (L:1252).

**A-18 · RLS for the identity policy.**
- **Class:** ENG+TL (TL-8).
- **Ruling:**
  - `stock_movements` and `stock_levels` each carry `inventory_internal_read FOR SELECT TO daftar_inventory_internal USING (true)`.
  - Their RESTRICTIVE `business_isolation` **USING** admits `current_user = 'daftar_inventory_internal'`; its **WITH CHECK** does not. This is the precedent at `0042:388-393` and `0052:309-311`.
  - `product_variants` policies are **not** changed.
  - Instead, `products_20_unit_history_lock` fails closed with `inventory.scope_mismatch` when the writer's scope is not the product's business and tenant. Every non-superuser writer that can update the row is already in that scope (FORCE RLS on `products`, `0006:28-49`), so the refusal only closes the blind spot of a superuser writing out of scope.
- **Justification:** the history `EXISTS` must see every movement of the product (L:1748). It reaches the variants through `product_variants`, which is scope-bound.

**A-19 · `stock_movements` columns.**
- **Class:** ENG.
- **Ruling:** the §2.3 DDL. It has an `id` / PK, `tenant_id`, `actor_user_id` (the verified actor, L:1988) and `reason`. It has no `jti` and no `business_transaction_id`.
- The snapshot column is named `unit_cost_base_minor` (P:139, L:446), not DM's name.

**A-20 · FK delete actions and "never deleted".**
- **Class:** ENG.
- **Ruling:**
  - All FKs are `NO ACTION`, the 0042 precedent (`0042:149-150`).
  - `stock_levels` has no `DELETE` grant plus a `BEFORE DELETE` trigger `stock_levels_retain` raising `inventory.stock_level_not_deletable`.
  - Movements reference `stock_levels` by an immediate FK. A business, warehouse or variant with history therefore cannot be deleted (23503), which is exactly what L:1206 wants.
  - `TRUNCATE` is deliberately unguarded: E-24, and `resetData` uses it.
  - **Scope (clarified at implementation).** This ruling covers the S2 ledger tables. Source bridges follow the H-2 template instead: their line and binding FKs are `ON DELETE RESTRICT`, which `inventory_stock_source_guard_gaps()` requires (`confdeltype = 'r'`). Deleting a bound source line is refused on the bridge FK with `23001` (restrict_violation) on PostgreSQL 18 and `23503` on PostgreSQL 16–17; CI runs 16, the local embedded server 18. S3–S5 bridges copy the template, and any API mapping of this refusal maps both codes.

**A-21 · The binding-side mechanism and its naming.**
- **Class:** ENG.
- **Ruling:** per source type `<st>`, where `source_type` matches `^[a-z][a-z0-9_]{1,39}$` so every derived name is at most 63 characters:

  | Object | Name |
  | --- | --- |
  | Bridge table | `stock_source_bridge_<st>` |
  | Deferred constraint trigger on `stock_source_bindings`, and its function | `stock_binding_requires_<st>` |
  | Bridge append-only trigger | `stock_bridge_immutable_<st>` |

  - The binding trigger function is internal DEFINER. It is installed with `WHEN (NEW.source_type = '<st>')` and raises `inventory.stock_source_line_missing`.
  - No generic `TG_ARGV` function is used: identifiers are fixed at authoring time (L:1694).
  - Discovery goes through the catalogue-only `inventory_stock_source_guard_gaps()`.

**A-22 · Enforcing `on_hand = 0 ⇒ valuation = 0`.**
- **Class:** ENG.
- **Ruling:** a deferred constraint trigger, `stock_levels_zero_on_hand_zero_value`: `AFTER INSERT OR UPDATE ON stock_levels`, `DEFERRABLE INITIALLY DEFERRED`, internal DEFINER. It re-reads the row and raises `inventory.zero_stock_residual_value`.
- **Justification:** it is not a row CHECK, because P3-S4's receipt-then-catch-up is transiently zero-with-value (L:1387, PM:379). The GOLD-72 vector exercises that transient state.

**A-23 · The product-versus-stock-key lock protocol.**
- **Class:** ENG.
- **Ruling:**
  - The primitive takes `SELECT … FROM products … ORDER BY id FOR SHARE` for every product it touches, **before** any stock key.
  - It reads `track_inventory` and `unit_decimals` from that locking read.
  - `inventory_configure_product` holds `FOR UPDATE` on the product (`0055:156-160`); a raw internal `UPDATE` holds a no-key update lock. Both conflict with `FOR SHARE`.
  - Guard 2 and the disable rule are VOLATILE, so each statement sees what the other side committed.
  - This is deadlock-free, because no holder of an exclusive product lock takes a stock-key lock.
  - **Amended after the independent security review (M-1).** The protocol holds only under READ COMMITTED: under REPEATABLE READ or SERIALIZABLE the guard reads a transaction snapshot and would not see the committing side. The primitive, `inventory_configure_product`, `products_20_unit_history_lock` and `product_variants_20_stock_identity_lock` therefore refuse any other isolation level with `inventory.isolation_unsupported` before they read anything.
  - **Deviation (H-1).** The internal role has no UPDATE on `product_variants`, so the primitive cannot lock a variant row. A variant's product is instead frozen by `product_variants_20_stock_identity_lock` (BEFORE UPDATE OF `product_id`), which takes `FOR UPDATE` on the old product and refuses with `inventory.variant_stock_identity_locked` while any `stock_levels` row names the variant; and the primitive re-reads every variant→product mapping after its product locks (step 4b), refusing with `inventory.variant_stock_identity_changed` if one moved.
  - Accepted cost: a catalog `UPDATE` of a product waits for an in-flight stock command on that product.

**A-24 · Re-verifying the payload digest.**
- **Class:** ENG.
- **Ruling:** the primitive does not re-check the digest. `inventory_assertion_current` is exactly steps 1-4, 6 and 9 (L:1990). Every producing entry routine must bind every warehouse, variant and quantity it passes in its `invpl/1` fields. Each producing slice (S3+) proves this for its own routine.

**A-25 · `business_transaction_id` on movements.**
- **Class:** ENG.
- **Ruling:** omitted. It is an unauthenticated trace (L:1068-1072). Entry routines record it in their audit row, as `0055:229` does.

**A-26 · Bounds.**
- **Class:** ENG.
- **Ruling:**
  - `|value_delta_base_minor|` and `|valuation_base_minor|` ≤ 10^18: a CHECK plus `inventory.value_out_of_range`. This mirrors the journal cap (`0042:224-230`).
  - `|on_hand|` and `|qty_delta|` < 10^10: `inventory.quantity_out_of_range`. **Amended after the independent security review (M-3).** The first ruling used the NUMERIC(18,4) domain, 10^14. At that bound the reviewer reproduced a partial outbound at quantity ≥ 10^10 whose value exceeded the valuation it drew from. Below 10^10 the reproduction is refused and the bound-edge tests pass. The package's `QTY_LIMIT_Q4` follows the SQL bound (see §4).
  - Cost is ≥ 0 and < 10^18: `inventory.cost_invalid`.

**A-27 · The inbound snapshot.**
- **Class:** ENG.
- **Ruling:** the inbound snapshot is the **supplied** document unit cost, which must be exactly representable at 10 decimal places. The primitive never derives a snapshot from a share. For vector F the caller supplies `3.3333333333`.

**A-28 · `inventory_operation_movement_kinds` constraints.**
- **Class:** ENG+TL (TL-10).
- **Ruling:** `PRIMARY KEY (op_code, movement_kind)`, FKs to both registries, and a `registered_by` CHECK. There is **no** `UNIQUE (movement_kind)`.
- **Justification:**
  - Least authority is carried by the pair (L:1992).
  - Unlike the accounting twin (`0046:86-93`), a movement kind is physical semantics. L:1926 foresees several purchase commands (receive, cancel, reversal), and pinning one owner now would force a later weakening.

**A-29 · A merchant variant beside a base variant.**
- **Class:** ENG+TL (TL-7).
- **Ruling:** when the variant's product has a base variant (`is_base`), the primitive accepts movements **only** on that base variant; any other variant of that product raises `inventory.variant_not_stock_identity`. A product without a base variant accepts movements on its merchant variants.
- **Unchanged:** creating a merchant variant through raw `daftar_app` SQL, as in S1, and product conversion policy.
- **Justification:** before the first movement exists, this keeps one stock identity per simple product (P3-AL-03).

**N-01 · Lock tension (not an A-item).**
- **Class:** ENG+TL (TL-6).
- L:526 and L:390 say "source average unchanged" on transfer. Under the derived-average law (L:455, L:1227), that holds only when the average terminates, as in GOLD-44. It does not hold otherwise: vector F's 3.3333333333 becomes 3.5000000000 (L:1402).
- **Ruling:** the derived average governs, because the exact rebuild (P:158) requires it.

---

## 2. Database contract

### 2.1 Migrations

There are two files, both written by the **one** migration writer (Agent A).

**`0059_inventory_stock_ledger.sql` (schema).** Registries and seeds, tables, indexes, migrator-owned invoker triggers, RLS, grants, the catalogue-only function, and end-state assertion 0059-E. It performs **no** ownership transfer, so it has no CREATE bracket.

**`0060_inventory_stock_primitive.sql` (trusted routines).** It runs in this exact order:
1. `GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;`
2. `CREATE TYPE inventory_movement_request`.
3. `CREATE FUNCTION` for the eight routines in §2.5 (R1–R8).
4. `REVOKE ALL ON FUNCTION … FROM PUBLIC` for each, while the migrator owns them.
5. `CREATE TRIGGER products_20_unit_history_lock` and `CREATE CONSTRAINT TRIGGER stock_levels_zero_on_hand_zero_value`.
6. `ALTER FUNCTION … OWNER TO daftar_inventory_internal` for each.
7. `SET LOCAL ROLE daftar_inventory_internal;` then `CREATE OR REPLACE FUNCTION inventory_configure_product(UUID, BOOLEAN, TEXT, SMALLINT)` (A-13), then `RESET ROLE;`.
8. `REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;`
9. End-state assertion 0060-E.

The manifest is not touched until the Tech Lead accepts the slice.

### 2.2 Registries (0059)

All three registries have no RLS (like `inventory_operation_kinds`, `0054:52-56`), `REVOKE ALL … FROM PUBLIC`, and no runtime grant.

```sql
CREATE TABLE stock_movement_kinds (
  movement_kind   TEXT PRIMARY KEY CHECK (movement_kind ~ '^[a-z][a-z0-9_]{1,39}$'),
  qty_sign        TEXT NOT NULL CHECK (qty_sign IN ('positive','negative','either','zero')),
  requires_reason BOOLEAN NOT NULL,
  registered_by   TEXT NOT NULL CHECK (registered_by ~ '^P3-S[0-9]+$')
);
CREATE TABLE stock_source_types (
  source_type   TEXT PRIMARY KEY CHECK (source_type ~ '^[a-z][a-z0-9_]{1,39}$'),
  registered_by TEXT NOT NULL CHECK (registered_by ~ '^P3-S[0-9]+$')
);
CREATE TABLE inventory_operation_movement_kinds (
  op_code       TEXT NOT NULL REFERENCES inventory_operation_kinds (op_code),
  movement_kind TEXT NOT NULL REFERENCES stock_movement_kinds (movement_kind),
  registered_by TEXT NOT NULL CHECK (registered_by ~ '^P3-S[0-9]+$'),
  PRIMARY KEY (op_code, movement_kind)
);
```

**`qty_sign` semantics** (checked by the primitive):

| `qty_sign` | Requirement |
| --- | --- |
| `positive` | `qty > 0` |
| `negative` | `qty < 0` |
| `either` | `qty <> 0` |
| `zero` | `qty = 0` |

**Seed**, all with `registered_by = 'P3-S2'`:

| `movement_kind` | `qty_sign` | `requires_reason` | Basis |
| --- | --- | --- | --- |
| `purchase` | positive | false | L:1380 |
| `supplier_return` | negative | false | L:463 |
| `adjustment` | either | **true** | L:432 |
| `damage` | negative | **true** | L:432 |
| `transfer_out` | negative | false | L:463, L:1382 |
| `transfer_in` | positive | false | L:1383 |
| `stocktake` | either | false | L:1385 |
| `inventory_opening` | positive | false | L:1380 |
| `negative_inventory_cost_adjustment` | zero | false | L:432 |
| `purchase_reversal` | negative | false | reverses a receipt |

`stock_source_types` and `inventory_operation_movement_kinds` receive **no** INSERT.

### 2.3 Tables (0059)

Every table is created with `REVOKE ALL … FROM PUBLIC`. The referenced keys already exist: `businesses (tenant_id, id)` is UNIQUE (`0016:10`); `warehouses` PK `(business_id, id)` is at `0003:75`; `product_variants` PK `(business_id, id)` is at `0005:47`.

```sql
CREATE TABLE stock_levels (
  tenant_id                UUID NOT NULL,
  business_id              UUID NOT NULL,
  warehouse_id             UUID NOT NULL,
  variant_id               UUID NOT NULL,
  on_hand                  NUMERIC(18,4) NOT NULL DEFAULT 0,
  valuation_base_minor     BIGINT NOT NULL DEFAULT 0,
  avg_unit_cost_base_minor NUMERIC(28,10) NULL,
  last_stock_seq           BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (business_id, warehouse_id, variant_id),
  CONSTRAINT stock_levels_tenant_fk    FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT stock_levels_warehouse_fk FOREIGN KEY (business_id, warehouse_id) REFERENCES warehouses (business_id, id),
  CONSTRAINT stock_levels_variant_fk   FOREIGN KEY (business_id, variant_id) REFERENCES product_variants (business_id, id),
  CONSTRAINT stock_levels_valuation_range_ck CHECK (valuation_base_minor BETWEEN -1000000000000000000 AND 1000000000000000000),
  CONSTRAINT stock_levels_seq_ck CHECK (last_stock_seq >= 0)
);
CREATE INDEX stock_levels_variant_idx ON stock_levels (business_id, variant_id);   -- P3-AL-41 disable rule

CREATE TABLE stock_movements (
  tenant_id              UUID NOT NULL,
  business_id            UUID NOT NULL,
  id                     UUID NOT NULL,
  warehouse_id           UUID NOT NULL,
  variant_id             UUID NOT NULL,
  stock_seq              BIGINT NOT NULL CHECK (stock_seq >= 1),
  movement_kind          TEXT NOT NULL REFERENCES stock_movement_kinds (movement_kind),
  source_type            TEXT NOT NULL REFERENCES stock_source_types (source_type),
  source_id              UUID NOT NULL,
  source_line_id         UUID NOT NULL,
  qty_delta              NUMERIC(18,4) NOT NULL,
  unit_cost_base_minor   NUMERIC(28,10) NULL,
  value_delta_base_minor BIGINT NOT NULL,
  reason                 TEXT NULL,
  actor_user_id          UUID NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  CONSTRAINT stock_movements_key_seq_uq  UNIQUE (business_id, warehouse_id, variant_id, stock_seq),
  CONSTRAINT stock_movements_identity_uq UNIQUE (business_id, source_type, source_id, source_line_id, movement_kind),  -- NOT deferrable
  CONSTRAINT stock_movements_id_key_uq   UNIQUE (business_id, id, warehouse_id, variant_id),
  CONSTRAINT stock_movements_value_only_ck    CHECK (NOT (qty_delta = 0 AND value_delta_base_minor = 0)),
  CONSTRAINT stock_movements_cost_snapshot_ck CHECK ((qty_delta = 0) = (unit_cost_base_minor IS NULL)),
  CONSTRAINT stock_movements_cost_ck          CHECK (unit_cost_base_minor IS NULL OR unit_cost_base_minor >= 0),
  CONSTRAINT stock_movements_value_range_ck   CHECK (value_delta_base_minor BETWEEN -1000000000000000000 AND 1000000000000000000),
  CONSTRAINT stock_movements_reason_ck        CHECK (reason IS NULL OR char_length(btrim(reason)) BETWEEN 1 AND 500),
  CONSTRAINT stock_movements_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT stock_movements_level_fk  FOREIGN KEY (business_id, warehouse_id, variant_id)
                                        REFERENCES stock_levels (business_id, warehouse_id, variant_id)
);
CREATE INDEX stock_movements_variant_idx ON stock_movements (business_id, variant_id);   -- history lock

CREATE TABLE stock_source_bindings (                    -- L:1456-1464 verbatim, plus the tenant FK
  tenant_id      UUID NOT NULL,
  business_id    UUID NOT NULL,
  source_type    TEXT NOT NULL REFERENCES stock_source_types (source_type),
  source_id      UUID NOT NULL,
  source_line_id UUID NOT NULL,
  movement_kind  TEXT NOT NULL REFERENCES stock_movement_kinds (movement_kind),
  PRIMARY KEY (business_id, source_type, source_id, source_line_id, movement_kind),
  CONSTRAINT stock_source_bindings_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id)
);
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_binding_fk
  FOREIGN KEY (business_id, source_type, source_id, source_line_id, movement_kind)
  REFERENCES stock_source_bindings (business_id, source_type, source_id, source_line_id, movement_kind)
  DEFERRABLE INITIALLY DEFERRED;                        -- L:1470-1473
ALTER TABLE stock_source_bindings ADD CONSTRAINT stock_source_bindings_movement_fk
  FOREIGN KEY (business_id, source_type, source_id, source_line_id, movement_kind)
  REFERENCES stock_movements (business_id, source_type, source_id, source_line_id, movement_kind)
  DEFERRABLE INITIALLY DEFERRED;                        -- L:1476-1479

CREATE TABLE negative_inventory_deficits (              -- DM:266-279
  tenant_id                        UUID NOT NULL,
  business_id                      UUID NOT NULL,
  id                               UUID NOT NULL DEFAULT gen_random_uuid(),
  warehouse_id                     UUID NOT NULL,
  variant_id                       UUID NOT NULL,
  source_stock_movement_id         UUID NOT NULL,
  deficit_seq                      BIGINT NOT NULL CHECK (deficit_seq >= 1),
  original_deficit_qty             NUMERIC(18,4) NOT NULL,
  uncovered_qty                    NUMERIC(18,4) NOT NULL,
  provisional_unit_cost_base_minor NUMERIC(28,10) NOT NULL CHECK (provisional_unit_cost_base_minor >= 0),
  status                           TEXT NOT NULL CHECK (status IN ('open','partially_covered','closed')),
  created_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  CONSTRAINT negative_inventory_deficits_seq_uq     UNIQUE (business_id, warehouse_id, variant_id, deficit_seq),
  CONSTRAINT negative_inventory_deficits_variant_uq UNIQUE (business_id, id, variant_id),
  CONSTRAINT negative_inventory_deficits_original_ck CHECK (original_deficit_qty > 0),
  CONSTRAINT negative_inventory_deficits_uncovered_ck CHECK (uncovered_qty >= 0 AND uncovered_qty <= original_deficit_qty),
  CONSTRAINT negative_inventory_deficits_status_ck CHECK (
       (status = 'open' AND uncovered_qty = original_deficit_qty)
    OR (status = 'partially_covered' AND uncovered_qty > 0 AND uncovered_qty < original_deficit_qty)
    OR (status = 'closed' AND uncovered_qty = 0)),
  CONSTRAINT negative_inventory_deficits_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT negative_inventory_deficits_key_fk FOREIGN KEY (business_id, warehouse_id, variant_id)
    REFERENCES stock_levels (business_id, warehouse_id, variant_id),
  CONSTRAINT negative_inventory_deficits_movement_fk FOREIGN KEY (business_id, source_stock_movement_id, warehouse_id, variant_id)
    REFERENCES stock_movements (business_id, id, warehouse_id, variant_id)
);
CREATE INDEX negative_inventory_deficits_fifo_idx
  ON negative_inventory_deficits (business_id, warehouse_id, variant_id, status, deficit_seq);   -- DM:297

CREATE TABLE negative_deficit_coverages (               -- L:498-500
  tenant_id                        UUID NOT NULL,
  business_id                      UUID NOT NULL,
  id                               UUID NOT NULL DEFAULT gen_random_uuid(),
  adjustment_id                    UUID NOT NULL,        -- FK to the header added by P3-S4 (A-06)
  deficit_id                       UUID NOT NULL,
  variant_id                       UUID NOT NULL,
  qty_covered                      NUMERIC(18,4) NOT NULL CHECK (qty_covered > 0),
  provisional_unit_cost_base_minor NUMERIC(28,10) NOT NULL CHECK (provisional_unit_cost_base_minor >= 0),
  actual_unit_cost_base_minor      NUMERIC(28,10) NOT NULL CHECK (actual_unit_cost_base_minor >= 0),
  created_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  CONSTRAINT negative_deficit_coverages_tenant_fk  FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT negative_deficit_coverages_deficit_fk FOREIGN KEY (business_id, deficit_id, variant_id)
    REFERENCES negative_inventory_deficits (business_id, id, variant_id)
);
```

Neither `stock_levels` nor any other table may have a `reserved` or `available` column (L:1274).

**0059 also defines two migrator-owned functions** (neither is transferred, both are `REVOKE ALL FROM PUBLIC`, both pin the path; precedent `warehouses_home_branch_immutable`, `/home/user/daftar/tests/integration/migration-portability.test.ts:1130`):

- **`stock_ledger_append_only() RETURNS trigger`**: `LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp`. It unconditionally raises `inventory.ledger_immutable: <TG_TABLE_NAME> is append-only`.
- **`stock_levels_retain() RETURNS trigger`**: the same shape. It raises `inventory.stock_level_not_deletable`.

**0059 triggers:**

```sql
CREATE TRIGGER stock_movements_append_only            BEFORE UPDATE OR DELETE ON stock_movements            FOR EACH ROW EXECUTE FUNCTION stock_ledger_append_only();
CREATE TRIGGER stock_source_bindings_append_only      BEFORE UPDATE OR DELETE ON stock_source_bindings      FOR EACH ROW EXECUTE FUNCTION stock_ledger_append_only();
CREATE TRIGGER negative_deficit_coverages_append_only BEFORE UPDATE OR DELETE ON negative_deficit_coverages FOR EACH ROW EXECUTE FUNCTION stock_ledger_append_only();
CREATE TRIGGER stock_levels_retain                    BEFORE DELETE           ON stock_levels               FOR EACH ROW EXECUTE FUNCTION stock_levels_retain();
```

Future bridges attach `stock_ledger_append_only()` as `stock_bridge_immutable_<st>`.

**0059 catalogue function:**
- **Signature:** `inventory_stock_source_guard_gaps() RETURNS TABLE (source_type TEXT, missing TEXT)`, `LANGUAGE plpgsql STABLE SECURITY INVOKER`, pinned path, migrator-owned, `REVOKE ALL FROM PUBLIC`.
- **Open for P3-S3.** The review found the discovery checks names only (a trigger with the right name on the wrong table, or disabled, passes). With `stock_source_types` empty at S2 nothing depends on it; the first slice that registers a source type strengthens it in its own migration (table, timing, enabled state, function) before registering.
- **Missing items it reports**, for every row of `stock_source_types`:
  - `bridge`: no `to_regclass('public.stock_source_bridge_' || st)`.
  - `bridge_binding_fk`: no `pg_constraint` with `contype = 'f'` from the bridge to `stock_source_bindings` with `confdeltype = 'r'`.
  - `bridge_line_fk`: no `pg_constraint` with `contype = 'f'` from the bridge to any other relation with `confdeltype = 'r'`.
  - `bridge_immutable`: no enabled trigger `stock_bridge_immutable_<st>` on the bridge.
  - `binding_trigger`: no `pg_trigger` named `stock_binding_requires_<st>` on `stock_source_bindings` with `tgconstraint <> 0`, `tgdeferrable`, `tginitdeferred` and `tgenabled <> 'D'`, whose function is internal-owned and `prosecdef`.
- **Usage:** every migration that registers a source type (S3+) calls it in its end-state block (L:1530).

### 2.4 Triggers: the complete S2 set

| Trigger | Table | Timing / event | Function | Owner / security | Refusal |
| --- | --- | --- | --- | --- | --- |
| `stock_movements_append_only` | `stock_movements` | BEFORE UPDATE OR DELETE, row | `stock_ledger_append_only()` | migrator / INVOKER | `inventory.ledger_immutable` |
| `stock_source_bindings_append_only` | `stock_source_bindings` | same | same | same | same |
| `negative_deficit_coverages_append_only` | `negative_deficit_coverages` | same | same | same | same |
| `stock_levels_retain` | `stock_levels` | BEFORE DELETE, row | `stock_levels_retain()` | migrator / INVOKER | `inventory.stock_level_not_deletable` |
| `stock_levels_zero_on_hand_zero_value` | `stock_levels` | CONSTRAINT, AFTER INSERT OR UPDATE, DEFERRABLE INITIALLY DEFERRED, row | same name | internal / DEFINER | `inventory.zero_stock_residual_value` |
| `products_20_unit_history_lock` | `products` | BEFORE UPDATE, row, `WHEN (OLD.unit_code IS DISTINCT FROM NEW.unit_code OR OLD.unit_decimals IS DISTINCT FROM NEW.unit_decimals)` | same name | internal / DEFINER | `inventory.scope_mismatch` then `inventory.unit_identity_locked` |

`products_20_…` sorts after `products_10_inventory_config_authority` (`0053:219`) by name (L:1741-1746).

### 2.5 Routines (0060)

**The request type:**

```sql
CREATE TYPE inventory_movement_request AS (
  warehouse_id UUID, variant_id UUID, movement_kind TEXT, source_type TEXT,
  source_id UUID, source_line_id UUID,
  qty_delta NUMERIC, unit_cost_base_minor NUMERIC, value_delta_base_minor BIGINT, reason TEXT);
```

Its fields are deliberately unconstrained `NUMERIC`, so no typmod coercion can round silently.

**Every routine below:** internal owner, `SECURITY DEFINER`, `SET search_path = pg_catalog, public, pg_temp`, `REVOKE ALL … FROM PUBLIC`, **no EXECUTE grant to anyone**.

**R1. `inventory_half_even(p_numerator NUMERIC, p_denominator NUMERIC, p_scale INTEGER) RETURNS NUMERIC`**
- plpgsql, IMMUTABLE.
- Refuses when an argument is NULL, the denominator is 0, or the scale is not in {0, 10}: `inventory.arithmetic_invalid`.
- Algorithm (the 0043 precedent, `0043:227-237`, made sign-symmetric):

  ```
  neg := (p_numerator < 0) <> (p_denominator < 0)
  n   := abs(p_numerator) * (10000000000 or 1)
  d   := abs(p_denominator)
  q   := div(n, d);  r := n - q*d
  if 2r > d, or (2r = d and mod(q, 2) <> 0):  q := q + 1
  if neg:  q := -q
  return q * 0.0000000001   (scale 10)   or   q   (scale 0)
  ```

- Never uses `round()` or `/`.

**R2. `inventory_quantity_is_representable(p_qty NUMERIC, p_unit_decimals SMALLINT) RETURNS BOOLEAN`**
- plpgsql, IMMUTABLE: `abs(p_qty) = trunc(abs(p_qty), p_unit_decimals)` (L:271).
- `p_unit_decimals` NULL or outside 0..4: `inventory.arithmetic_invalid`.

**R3. The primitive.**

```sql
inventory_apply_stock_movements(p_requests inventory_movement_request[])
RETURNS TABLE (ordinal INTEGER, movement_id UUID, warehouse_id UUID, variant_id UUID, stock_seq BIGINT,
               movement_kind TEXT, qty_delta NUMERIC, unit_cost_base_minor NUMERIC, value_delta_base_minor BIGINT,
               on_hand NUMERIC, valuation_base_minor BIGINT, avg_unit_cost_base_minor NUMERIC)
```

It is VOLATILE and uses `#variable_conflict use_column` (`0055:113`). Steps, in order:

0. **First statement:**

   ```sql
   v_actor := inventory_assertion_current(ARRAY(SELECT DISTINCT m.op_code
                                                FROM inventory_operation_movement_kinds m ORDER BY 1));
   ```

   An empty mapping means `inventory.assertion_wrong_operation` (`0054:525-529`). `v_business := v_actor.business_id` and `v_tenant := v_actor.tenant_id`. **No GUC is read for identity.**

1. **Shape** (`inventory.movement_request_invalid`): the array is non-NULL with cardinality ≥ 1; each element and each of `warehouse_id`, `variant_id`, `movement_kind`, `source_type`, `source_id`, `source_line_id` and `qty_delta` is non-NULL; `reason` is NULL or 1..500 characters after `btrim`.

2. **Kind:** it must exist in `stock_movement_kinds` (`inventory.movement_kind_unknown`), and `(v_actor.op_code, kind)` must exist in the mapping (`inventory.movement_kind_not_authorized`).

3. **Scope:**
   - Each warehouse must be `warehouses WHERE business_id = v_business AND id = …` (`inventory.warehouse_not_found`).
   - Each variant must be `product_variants WHERE business_id = v_business AND id = …` (`inventory.variant_not_found`); record its `product_id`.

4. **Products:**

   ```sql
   SELECT p.id, p.track_inventory, p.unit_decimals FROM products p
   WHERE p.business_id = v_business AND p.id = ANY(v_product_ids) ORDER BY p.id FOR SHARE;
   ```

   - Not tracked: `inventory.product_not_tracked`.
   - A-29: if the product has an `is_base` variant and the requested variant is not it, `inventory.variant_not_stock_identity`.
   - Precision per request uses R2 with the **locked** `unit_decimals`: `inventory.quantity_precision_invalid`.
   - `abs(qty) >= 10^14`: `inventory.quantity_out_of_range`.

5. **Keys (P3-AL-06, P3-AL-07).** Take the distinct `(warehouse_id, variant_id)` pairs, sorted ascending as `uuid`. For each, in that order:

   ```sql
   INSERT INTO stock_levels (tenant_id, business_id, warehouse_id, variant_id, on_hand, valuation_base_minor,
                             avg_unit_cost_base_minor, last_stock_seq)
   VALUES (v_tenant, v_business, w, v, 0, 0, NULL, 0)
   ON CONFLICT (business_id, warehouse_id, variant_id) DO NOTHING;

   SELECT … FROM stock_levels WHERE <pk> FOR UPDATE;
   ```

   No check-then-insert and no `DO UPDATE` (L:357).

6. **Per request, in array order** (`ordinal` = index, 1-based). Re-read the locked cache row, then:

   a. **Identity.** If a `stock_movements` row already has the five-part identity, raise `inventory.movement_identity_conflict`. This check runs under the key lock, so a same-key race gets the stable code, not 23505.

   b. **Sign.** `qty_sign` violation: `inventory.quantity_sign_invalid`. `requires_reason` with a NULL reason: `inventory.reason_required`.

   c. **Value by class.** In every branch, a violation of the stated cost/value requirement raises `inventory.movement_shape_invalid`.

   | Class | When | Cost / value in the request | Stored value | Snapshot |
   | --- | --- | --- | --- | --- |
   | Value-only | `qty = 0` | cost NULL; value non-NULL and non-zero | the supplied value | NULL |
   | `transfer_in` | kind is `transfer_in` | both NULL | `−out.value_delta_base_minor` | `out.unit_cost_base_minor` |
   | Outbound | `qty < 0` | both NULL | see rules below | current average |
   | Inbound | `qty > 0`, any other kind | cost NOT NULL; value may be supplied only for `purchase` / `inventory_opening` | supplied value, or `inventory_half_even(qty*cost, 1, 0)` | the supplied cost |

   - **`transfer_in` pairing:** find the stored `transfer_out` with the same `(business, source_type, source_id, source_line_id)`. None: `inventory.transfer_pair_missing`. Different variant, same warehouse, or `out.qty ≠ −qty`: `inventory.transfer_pair_mismatch`.
   - **Outbound:** `abs(qty) > on_hand` raises `inventory.insufficient_stock`. `abs(qty) = on_hand` stores `−valuation_base_minor` (the flush). Otherwise it stores `−inventory_half_even(abs(qty) * avg, 1, 0)`. A NULL average here raises `inventory.arithmetic_invalid`.
   - **Inbound cost:** the cost must satisfy `cost >= 0`, `cost = trunc(cost, 10)` and `cost < 10^18`, else `inventory.cost_invalid`.
   - **Inbound supplied value:** must be ≥ 0.

   d. **Bounds and the next state.**
   - `abs(value) > 10^18`, or the new valuation outside ±10^18: `inventory.value_out_of_range`.
   - `abs(new on_hand) >= 10^14`: `inventory.quantity_out_of_range`.
   - New average: `inventory_half_even(new_valuation, new_on_hand, 10)` if `new_on_hand <> 0`, else the carried average.
   - `v_seq := last_stock_seq + 1`; `v_id := gen_random_uuid()`.

   e. **One statement (A-15):**

   ```sql
   WITH mv AS (INSERT INTO stock_movements (…) VALUES (v_tenant, v_business, v_id, …, v_seq, …, v_actor.actor_user_id) RETURNING 1),
        lv AS (UPDATE stock_levels l SET on_hand = …, valuation_base_minor = …, avg_unit_cost_base_minor = …, last_stock_seq = v_seq
               WHERE l.business_id = v_business AND l.warehouse_id = … AND l.variant_id = … RETURNING 1)
   INSERT INTO stock_source_bindings (tenant_id, business_id, source_type, source_id, source_line_id, movement_kind)
   SELECT v_tenant, v_business, … WHERE EXISTS (SELECT 1 FROM mv) AND EXISTS (SELECT 1 FROM lv);
   ```

   A ROW_COUNT other than 1 raises `inventory.arithmetic_invalid` (defensive).

   f. `RETURN NEXT`.

7. **No end-of-batch zero-value check.** The deferred trigger owns that invariant (A-22).

**R4. `inventory_next_deficit_seq(p_business_id UUID, p_warehouse_id UUID, p_variant_id UUID) RETURNS BIGINT`**
- VOLATILE.
- `p_business_id IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid`: `inventory.scope_mismatch`.
- Then `SELECT 1 FROM stock_levels WHERE <pk> FOR UPDATE`; not found: `inventory.stock_key_missing`.
- Returns `coalesce(max(deficit_seq), 0) + 1` for the key. Writes nothing.

**R5. `inventory_stock_fold(p_business_id UUID, p_warehouse_id UUID, p_variant_id UUID)`**
- **Returns:** `TABLE (on_hand NUMERIC, valuation_base_minor BIGINT, avg_unit_cost_base_minor NUMERIC, last_stock_seq BIGINT, movement_count BIGINT, sequence_gapless BOOLEAN)`.
- STABLE, with the same scope check as R4.
- `on_hand = coalesce(sum(qty_delta), 0)` and `valuation = coalesce(sum(value_delta_base_minor), 0)`.
- The average is R1 of the running `(valuation, on_hand)` at the **last** `stock_seq` whose running `on_hand <> 0`. A window ordered by `stock_seq` computes it; if there is no such row, it is NULL.
- `sequence_gapless = (count = max(stock_seq) AND min = 1)`, or true when there are no movements.
- Ordering is `stock_seq` only; never `created_at` or `id` (L:1231).

**R6. `inventory_stock_verify(p_business_id UUID, p_warehouse_id UUID, p_variant_id UUID)`**
- **Returns:** `TABLE (cache_on_hand, rebuilt_on_hand, cache_valuation, rebuilt_valuation, cache_avg, rebuilt_avg, cache_last_seq, rebuilt_last_seq, matches BOOLEAN)`.
- VOLATILE, with the scope check.
- It takes `FOR SHARE` on the key row (so it waits for a live writer), calls R5 and compares all four values with `IS NOT DISTINCT FROM` plus `sequence_gapless`.
- **Writes nothing** (L:1233, L:1236).

**R7. `products_20_unit_history_lock() RETURNS trigger`**
- VOLATILE.
- **Scope check first:** if `NEW.business_id IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid`, or `(SELECT b.tenant_id FROM businesses b WHERE b.id = NEW.business_id) IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid`, raise `inventory.scope_mismatch`.
- **Then the history check:**

  ```sql
  IF EXISTS (SELECT 1 FROM stock_movements m
             JOIN product_variants v ON v.business_id = m.business_id AND v.id = m.variant_id
             WHERE v.business_id = OLD.business_id AND v.product_id = OLD.id) THEN
    RAISE EXCEPTION 'inventory.unit_identity_locked: …' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
  ```

- It never reads `current_user` (L:1748).

**R8. `stock_levels_zero_on_hand_zero_value() RETURNS trigger`**
- Re-reads `(on_hand, valuation_base_minor)` of `NEW`'s key.
- If the row is found with `on_hand = 0 AND valuation_base_minor <> 0`, raise `inventory.zero_stock_residual_value`. Returns NULL.

**Replaced: `inventory_configure_product(UUID, BOOLEAN, TEXT, SMALLINT)`**
- Per A-13. Signature, return type, owner, ACL and `DEFINER` + pin are unchanged.
- The ACL is preserved by `CREATE OR REPLACE` issued by the owner.

### 2.6 RLS and grants (0059)

**Policies.** ENABLE and FORCE on `stock_movements`, `stock_levels`, `stock_source_bindings`, `negative_inventory_deficits` and `negative_deficit_coverages`. For each such `<t>`:

```sql
CREATE POLICY tenant_membership ON <t>
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation ON <t> AS RESTRICTIVE
  USING      (app_bypass() <IDENT> OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
```

`<IDENT>` is `OR current_user = 'daftar_inventory_internal'` **only** on `stock_movements` and `stock_levels`. Those two tables also get:

```sql
CREATE POLICY inventory_internal_read ON <t> FOR SELECT TO daftar_inventory_internal USING (true);
```

**Grants:**

```sql
REVOKE ALL ON <every S2 table and registry> FROM PUBLIC;
GRANT SELECT ON stock_movements, stock_levels TO daftar_app;
GRANT SELECT, INSERT ON stock_movements TO daftar_inventory_internal;
GRANT SELECT, INSERT ON stock_levels TO daftar_inventory_internal;
GRANT UPDATE (on_hand, valuation_base_minor, avg_unit_cost_base_minor, last_stock_seq) ON stock_levels TO daftar_inventory_internal;
GRANT INSERT ON stock_source_bindings TO daftar_inventory_internal;
GRANT SELECT ON stock_movement_kinds, inventory_operation_movement_kinds, negative_inventory_deficits TO daftar_inventory_internal;
```

Nothing else goes to anyone: no `daftar_platform`, `worker`, `identity`, `resolver`, `provisioner` or `reconciler` grant.

### 2.7 End-state assertions

Both blocks follow the `DO $$ … $$` precedent (`0053:269-399`, `0055:259-297`), with prefix `inventory.authority_leak:`. Privilege checks use `has_table_privilege`, `has_any_column_privilege` and `has_function_privilege`, never `information_schema` (`0053:265-267`).

**0059-E asserts:**
1. `stock_movement_kinds` is exactly the ten seed rows with their `qty_sign` / `requires_reason`.
2. `stock_source_types` and `inventory_operation_movement_kinds` have 0 rows.
3. `relrowsecurity AND relforcerowsecurity` on the five business tables.
4. For each of `daftar_app`, `daftar_platform`, `daftar_worker`, `daftar_identity`, `daftar_resolver`, `daftar_provisioner`, `daftar_reconciler` and `public`, and each S2 table and registry: no INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER at table or column level.
5. `daftar_app` has SELECT on exactly `stock_movements` and `stock_levels`.
6. The internal role holds exactly the A-01 set, and no DELETE/TRUNCATE on any S2 table.
7. Both P3-AL-51 FKs exist over the five columns with `condeferrable AND condeferred` (the 0042 check at `0042:589-595`); `stock_movements_identity_uq` is `contype = 'u'` and not deferrable.
8. The four append/retain triggers exist by name, enabled (`tgenabled = 'O'`).
9. `SELECT count(*) FROM inventory_stock_source_guard_gaps()` is 0.
10. `stock_levels` has no column named `reserved` or `available`.
11. `inventory_internal_read` exists exactly on `stock_movements` and `stock_levels`, with `polcmd = 'r'` and `polroles = {internal}`.
12. The internal role holds no CREATE on `public`.

**0060-E asserts:**
1. Each of R1–R8 and `inventory_configure_product` is internal-owned, `prosecdef`, with `proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']`.
2. R1–R8 have no EXECUTE for `public` or any runtime role; `inventory_configure_product` has EXECUTE for `daftar_app` only.
3. `products_20_unit_history_lock` exists on `products`: BEFORE UPDATE row, enabled, `tgqual IS NOT NULL`, function internal and `prosecdef`, and `tgname > 'products_10_inventory_config_authority'`.
4. `stock_levels_zero_on_hand_zero_value` has `tgconstraint <> 0`, `tgdeferrable` and `tginitdeferred`.
5. The internal role holds no CREATE on `public`.
6. Both registries are still empty.

---

## 3. Error model

**SQLSTATE convention:**

| Refusal | SQLSTATE |
| --- | --- |
| Stable-coded (message prefix `<code>:`) | `P0001` |
| Declarative FK | `23503` |
| Unique | `23505` |
| CHECK | `23514` |
| ACL | `42501` |

Tests assert both the SQLSTATE and the code prefix.

| Code | Raised by | Condition |
| --- | --- | --- |
| `inventory.assertion_*` (existing, `0054`) | R3 via `inventory_assertion_current` | missing, malformed, key, signature, wrong_operation, scope_mismatch, not_consumed |
| `inventory.movement_request_invalid` | R3 | NULL or empty array, NULL element or field, bad reason |
| `inventory.movement_kind_unknown` | R3 | kind not registered |
| `inventory.movement_kind_not_authorized` | R3 | op→kind pair not mapped (L:1992) |
| `inventory.warehouse_not_found` / `inventory.variant_not_found` | R3 | not in the verified business |
| `inventory.product_not_tracked` | R3 | `track_inventory = false` |
| `inventory.variant_not_stock_identity` | R3 | A-29 |
| `inventory.quantity_precision_invalid` | R3 (lock-named, L:293) | not representable |
| `inventory.quantity_out_of_range` | R3 | `abs(qty)` or `abs(on_hand)` ≥ 10^10 (A-26, amended) |
| `inventory.isolation_unsupported` | R3, R7, configure, variant lock | transaction isolation is not READ COMMITTED (A-23, amended) |
| `inventory.variant_stock_identity_locked` | `product_variants_20_stock_identity_lock` | a variant with a stock key moved to another product (A-23, H-1) |
| `inventory.variant_stock_identity_changed` | R3 step 4b | a variant's product changed between the request and the product lock (A-23, H-1) |
| `inventory.quantity_sign_invalid` | R3 | `qty_sign` violated |
| `inventory.reason_required` | R3 | `requires_reason` and no reason |
| `inventory.movement_shape_invalid` | R3 | cost/value presence against class |
| `inventory.cost_invalid` | R3 | negative, over 10 dp, or ≥ 10^18 |
| `inventory.insufficient_stock` | R3 (lock-named, L:463) | outbound over `on_hand` |
| `inventory.transfer_pair_missing` / `inventory.transfer_pair_mismatch` | R3 | P3-AL-14 pairing |
| `inventory.movement_identity_conflict` | R3 | five-part identity exists |
| `inventory.value_out_of_range` | R3 | over ±10^18 |
| `inventory.arithmetic_invalid` | R1, R2, R3 | divisor 0, bad scale, defensive |
| `inventory.scope_mismatch` | R4, R5, R6, R7 | argument or row business not the scope |
| `inventory.stock_key_missing` | R4 | no cache row |
| `inventory.ledger_immutable` | append-only triggers | UPDATE or DELETE |
| `inventory.stock_level_not_deletable` | `stock_levels_retain` | DELETE |
| `inventory.zero_stock_residual_value` | R8 | at COMMIT |
| `inventory.unit_identity_locked` | R7 (lock-named, L:312) | unit change with history |
| `inventory.tracking_disable_requires_zero_stock` | configure (A-13) | disable at non-zero stock |
| `inventory.stock_source_line_missing` | per-source binding trigger (S3+; fixture at S2) | no bridge row at COMMIT |
| `inventory.source_line_frozen` | per-source freeze trigger (S3+; fixture at S2) | finalized line edited |
| `inventory.source_guard_missing` | registering migrations' end state (S3+; T-14.6) | gaps is non-empty |

---

## 4. Package contract: `@daftar/inventory` (`/home/user/daftar/packages/inventory`)

**Boundaries.** Do not touch `src/assertion.ts` or `src/payload.ts`. The package must not import `pg`, `@nestjs/*`, `express` or `process.env`. No `number` ever holds a quantity, cost or value: rule 6 (`static-guards.ts:87-96`) plus the new rule 21. `index.ts` gains `export * from './fixed-point'`, `'./rounding'`, `'./quantity'`, `'./valuation'` and `'./rebuild'`.

**`src/errors.ts`.** Extend the `InventoryErrorCode` union (`errors.ts:18`) with:
- `'inventory.quantity_invalid'`
- `'inventory.cost_invalid'`
- `'inventory.unit_decimals_invalid'`
- `'inventory.quantity_precision_invalid'`
- `'inventory.insufficient_stock'`
- `'inventory.arithmetic_invalid'`
- `'inventory.value_out_of_range'`
- `'inventory.quantity_out_of_range'`
- `'inventory.movement_shape_invalid'`
- `'inventory.transfer_pair_mismatch'`
- `'inventory.rebuild_sequence_invalid'`

The class is unchanged.

**`src/fixed-point.ts`:**

```ts
export const QTY_SCALE = 4; export const COST_SCALE = 10;
export const QTY_LIMIT_Q4 = 10n ** 14n;          // |qty| < 10^10 units (A-26, amended; mirrors the SQL bound)
export const VALUE_LIMIT_MINOR = 10n ** 18n;     // |value| <= 10^18
export const COST_LIMIT_C10 = 10n ** 28n;        // cost < 10^18
export interface ExactDecimal { readonly units: bigint; readonly scale: number }
export function parseDecimal(text: string): ExactDecimal;   // ^-?(0|[1-9][0-9]*)(\.[0-9]+)?$, else inventory.arithmetic_invalid
export function parseQuantity(text: string): bigint;        // Q4; <=4 fraction digits and |q| < 10^14, else inventory.quantity_invalid
export function formatQuantity(q4: bigint): string;         // always 4 fraction digits, e.g. "-3.0000"
export function parseUnitCost(text: string): bigint;        // C10; >= 0; <=10 fraction digits; < 10^18, else inventory.cost_invalid
export function formatUnitCost(c10: bigint): string;        // always 10 fraction digits
export function parseMinor(text: string): bigint;           // ^-?(0|[1-9][0-9]*)$, |v| <= 10^18, else inventory.value_out_of_range
export function formatMinor(v: bigint): string;
```

**`src/rounding.ts`:**

```ts
export function roundHalfEven(numerator: bigint, denominator: bigint): bigint;   // exact, sign-symmetric, denominator 0 => inventory.arithmetic_invalid
export function roundHalfEvenDecimal(n: ExactDecimal, d: ExactDecimal, scale: 0 | 10): ExactDecimal;
```

This generalizes the positive-only `packages/accounting/src/fx.ts:57-66` to signed values (E-07).

**`src/quantity.ts`:**

```ts
export function isQuantityRepresentable(q4: bigint, unitDecimals: number): boolean;     // abs(q4) % 10^(4-d) === 0n; d not in 0..4 => inventory.unit_decimals_invalid
export function assertQuantityRepresentable(q4: bigint, unitDecimals: number): void;    // throws inventory.quantity_precision_invalid
```

**`src/valuation.ts`.** It mirrors R3 step 6 exactly. Units: `onHand` is Q4, `valuation` is minor, `avg` is C10.

```ts
export type MovementKind = 'purchase'|'supplier_return'|'adjustment'|'damage'|'transfer_out'|'transfer_in'|'stocktake'|'inventory_opening'|'negative_inventory_cost_adjustment'|'purchase_reversal';
export interface StockState { readonly onHand: bigint; readonly valuation: bigint; readonly avg: bigint | null; readonly lastStockSeq: bigint }
export const EMPTY_STOCK_STATE: StockState;   // 0, 0, null, 0
export function averageUnitCost(valuation: bigint, onHandQ4: bigint, carried: bigint | null): bigint | null;  // onHand ≠ 0 ? roundHalfEven(valuation * 10n**14n, onHandQ4) : carried
export function inboundValue(qtyQ4: bigint, costC10: bigint): bigint;                                          // roundHalfEven(q*c, 10n**14n)
export function outboundValue(state: StockState, qtyQ4: bigint): { value: bigint; unitCostSnapshot: bigint }; // qty<0; |q|>onHand => insufficient_stock; = => -valuation; avg < 0 => arithmetic_invalid (mirrors R3's defensive refusal); else -roundHalfEven(|q|*avg, 10n**14n)
export function transferInValue(transferOutValue: bigint): bigint;                                             // -transferOutValue
export function catchUpValue(qtyCoveredQ4: bigint, actualC10: bigint, provisionalC10: bigint): bigint;         // -roundHalfEven(q*(a-p), 10n**14n)  (sign: GOLD-54, IR:86-88)
export function applyMovement(state: StockState, qtyQ4: bigint, value: bigint): StockState;                    // adds; derives avg; seq+1; bounds
export interface MovementInput { kind: MovementKind; qtyQ4: bigint; costC10: bigint | null; value: bigint | null; pairedOut?: { value: bigint; costC10: bigint; qtyQ4: bigint } }
export function simulateMovement(state: StockState, m: MovementInput): { value: bigint; unitCostSnapshot: bigint | null; next: StockState };
```

**`src/rebuild.ts`:**

```ts
export interface StoredMovement { readonly stockSeq: bigint; readonly qtyQ4: bigint; readonly value: bigint }
export function foldMovements(movements: readonly StoredMovement[]): StockState;   // requires stockSeq = 1..n ascending, else inventory.rebuild_sequence_invalid; uses applyMovement
```

**Vectors.**
- Data: `packages/inventory/vectors/valuation-vectors.json`.
- Generator: `packages/inventory/scripts/generate-valuation-vectors.ts`, from **literal** cases in `packages/inventory/scripts/valuation-vector-cases.ts`. The cases are not computed by the functions. The pattern is the existing `scripts/generate-vectors.ts`.
- Test: `packages/inventory/test/valuation-vectors.test.ts` regenerates the file byte-identically and asserts that every expected value equals the TS functions' output.

**JSON schema (`version: "invval/1"`):**

```ts
{ version: 'invval/1';
  precision: { id: string; unitDecimals: 0|2|4; qty: string; valid: boolean }[];                         // exactly 10
  rounding:  { id: string; numerator: string; denominator: string; scale: 0|10; halfEven: string; halfUp: string|null }[];
  scenarios: { id: string; group: 'P3-AL-49-D'|'P3-AL-08'; keys: string[];
    steps: { key: string; kind: MovementKind; qty: string; unitCost: string|null; value: string|null; reason?: string;
             pairOf?: number; seededByOwner?: true; catchUp?: { qtyCovered: string; actual: string; provisional: string };
             expect: { value: string; unitCostSnapshot: string|null; onHand: string; valuation: string; avg: string|null; stockSeq: number } }[];
    journal: { inventoryLineAmounts: string[]; postedLineCount: number; rounding6100Lines: 0; glInventory: string } | { none: 'transfer' };
    reconciliation: { sumMovementValues: string; sumCacheValuation: string };
    withdrawnAggregate?: { exact: string; roundedHalfEven: string };
    cycle?: { totalInbound: string; totalOutbound: string }; cogs?: string }[];
  controls: /* same shape as scenarios */ [] }
```

Formatting: quantities are 4-dp strings, costs and averages 10-dp strings, values integer strings.

**Precision vectors (P-01 … P-10, L:280-291):**

| ID | Decimals | Quantity | Valid? |
| --- | --- | --- | --- |
| P-01 | 0 | `1` | valid |
| P-02 | 0 | `1.0000` | valid |
| P-03 | 0 | `-3.0000` | valid |
| P-04 | 0 | `0.5` | invalid |
| P-05 | 0 | `1.0001` | invalid |
| P-06 | 2 | `1.23` | valid |
| P-07 | 2 | `1.2300` | valid |
| P-08 | 2 | `1.234` | invalid |
| P-09 | 2 | `0.0001` | invalid |
| P-10 | 4 | `1.2345` | valid |

**Rounding vectors** (HALF_EVEN, with HALF_UP given where it differs or is a tie):

| ID | Numerator / denominator | Scale | HALF_EVEN | HALF_UP |
| --- | --- | --- | --- | --- |
| R-01 | 1/2 | 0 | 0 | 1 |
| R-02 | 3/2 | 0 | 2 | 2 |
| R-03 | 5/2 | 0 | 2 | 3 |
| R-04 | −1/2 | 0 | 0 | −1 |
| R-05 | −3/2 | 0 | −2 | −2 |
| R-06 | −5/2 | 0 | −2 | −3 |
| R-07 | 6/10 | 0 | 1 | — |
| R-08 | 4/10 | 0 | 0 | — |
| R-09 | −6/10 | 0 | −1 | — |
| R-10 | 10/3 | 10 | 3.3333333333 | — |
| R-11 | 20/3 | 10 | 6.6666666667 | — |
| R-12 | 2500/15 | 10 | 166.6666666667 | — |
| R-13 | −520/−6 | 10 | 86.6666666667 | — |
| R-14 | 1/20000000000 | 10 | 0.0000000000 | 0.0000000001 |
| R-15 | 3/20000000000 | 10 | 0.0000000002 | 0.0000000002 |
| R-16 | 3315/10 | 0 | 332 | 332 |
| R-17 | −3315/10 | 0 | −332 | −332 |
| R-18 | 7/2 | 0 | 4 | 4 |
| R-19 | 1/30000000000 | 10 | 0.0000000000 | — |

**§D scenarios (L:1397-1405).**
- Keys: K1 and K2 are two warehouses, same variant.
- "Issue" uses `damage` with reason `vector`.
- The P3-AL-49 L:1397-1401 "exact computed" cases are purchases of `qty 1.0000` at the stated cost with a computed value.

Each step reads as: kind, quantity @ cost, then the resulting stored value → cache state `on_hand / valuation / avg`, `#seq`.

- **A:** purchase 1 @ 0.6000000000 → value 1; cache 1.0000 / 1 / 1.0000000000, #1. Journal [1]. GL 1.
- **B:**
  - Two such purchases: 1, then 1; final cache 2.0000 / 2 / 1.0000000000.
  - Journal [1, 1]. GL 2. Withdrawn aggregate: exact 1.2 → 1.
- **C:**
  - purchase 1 @ 0.4 → 0; cache 1.0000 / 0 / 0.0000000000.
  - purchase 1 @ 0.4 → 0; cache 2.0000 / 0 / 0.0000000000.
  - Journal amounts [0, 0], 0 posted lines. GL 0. Withdrawn aggregate: 0.8 → 1.
- **D:** purchase 1 @ 0.5 → 0; cache 1.0000 / 0 / 0.0000000000. GL 0. `round()` would give 1.
- **E:** purchase 1 @ 1.5 → 2; cache 1.0000 / 2 / 2.0000000000. GL 2.
- **F:**
  - purchase 3.0000 @ 3.3333333333, value `10` supplied → 10; cache 3.0000 / 10 / 3.3333333333, #1.
  - damage −1.0000 → −3, snapshot 3.3333333333; cache 2.0000 / 7 / 3.5000000000, #2.
  - GL 7.
- **G:**
  - F's two steps.
  - damage −1 → −4 (tie to even), snapshot 3.5000000000; cache 1.0000 / 3 / 3.0000000000, #3.
  - damage −1 → −3 (flush), snapshot 3.0000000000; cache 0.0000 / 0 / 3.0000000000 (carried), #4.
  - GL 0. Cycle: inbound 10 = outbound 10.
- **H:**
  - F's two steps.
  - K1 transfer_out −2.0000 → −7 (flush), snapshot 3.5000000000; K1 cache 0.0000 / 0 / 3.5000000000, #3.
  - K2 transfer_in +2.0000, `pairOf` = step 3 → +7, snapshot 3.5000000000; K2 cache 2.0000 / 7 / 3.5000000000, #1.
  - Journal: F's lines [10, −3]; the transfer legs have none. GL 7. Business delta of the transfer is 0.
- **I:**
  - purchases 1 @ 0.6, 0.6, 0.4, 0.4 → 1, 1, 0, 0.
  - Averages after each step: 1.0000000000, 1.0000000000, 0.6666666667, 0.5000000000.
  - Final cache 4.0000 / 2. GL 2. Aggregate exact 2.0 → 2 (coincides).

**P3-AL-08 scenarios.** Seeds (`seededByOwner`) stand in for a Phase 4 oversell, using kind `adjustment`, reason `seed`.

- **AL08-RECEIPT:**
  - purchase 10 @ 200 → 2000; average 200.0000000000.
  - purchase 5 @ 100 → 500; cache 15.0000 / 2500 / 166.6666666667.
- **AL08-TRANSFER-GOLD44:**
  - K1 purchase 10 @ 100 → 1000.
  - K2 purchase 10 @ 200 → 2000.
  - K1 transfer_out −5 → −500, snapshot 100.0000000000; K1 cache 5.0000 / 500 / 100.0000000000.
  - K2 transfer_in +5 → +500; K2 cache 15.0000 / 2500 / 166.6666666667.
  - Business total 3000 before and after.
- **AL08-ADJ-POS:**
  - purchase 10 @ 100 → 1000.
  - adjustment +3.0000 @ 110.5000000000 → 332 (331.5 tie → 332); cache 13.0000 / 1332 / 102.4615384615.
- **AL08-ADJ-NEG:**
  - AL08-ADJ-POS's steps.
  - adjustment −4.0000 → −410, snapshot 102.4615384615; cache 9.0000 / 922 / 102.4444444444.
- **AL08-CATCHUP-GOLD54:**
  - seed −5 @ 100, value −500 → cache −5.0000 / −500 / 100.0000000000.
  - purchase 10 @ 120 → 1200; cache 5.0000 / 700 / 140.0000000000.
  - negative_inventory_cost_adjustment, qty 0, catchUp(5, 120, 100) → −100; cache 5.0000 / 600 / 120.0000000000.
  - GL 600. COGS 600.
- **AL08-CATCHUP-GOLD55:**
  - seed −5 @ 0, value 0 → average 0.0000000000.
  - purchase 10 @ 120 → 1200; cache 5.0000 / 1200 / 240.0000000000.
  - catchUp(5, 120, 0) → −600; cache 5.0000 / 600 / 120.0000000000.
- **AL08-CATCHUP-GOLD72:**
  - seed −10 @ 100, value −1000.
  - purchase 4 @ 120 → 480; cache −6.0000 / −520 / 86.6666666667.
  - catchUp(4, 120, 100) → −80; cache −600 / 100.0000000000.
  - purchase 6 @ 130 → 780; cache 0.0000 / 180 / 100.0000000000 (carried).
  - catchUp(6, 130, 100) → −180; cache 0.0000 / 0 / 100.0000000000.
  - Total catch-up 260. COGS 1260 (IR:104). GL 0.

**Control (not counted):**
- **CTRL-FLUSH:**
  - purchase 30000000000.0000 @ 0.0000000000, value `1` → cache val 1, avg 0.0000000000 (R-19).
  - damage −30000000000.0000 → flush −1, cache val 0.
  - The withdrawn `HALF_EVEN(q × avg)` gives 0, leaving residual 1.
  - Used by T-10.N and T-06.N.
  - **Amended after A-26 moved to 10^10.** Quantity 3·10^10 is outside the primitive's domain, so R3 refuses both steps with `inventory.quantity_out_of_range`, and the control is seeded raw into the ledger and cache by the tests. Inside |on_hand| < 10^10 the flush and `HALF_EVEN(q × avg)` cannot diverge on full depletion: the gap `|q·avg − V|` is at most `q·½·10^-10 < ½`. T-10.N therefore has three parts: the seeded control (the TS twin still predicts the residual), the domain refusal, and a bound test at q = 9999999999 proving the two rules agree. The flush stays: it is the rule, and the bound is what makes the withdrawn rule harmless, not a reason to restore it.

---

## 5. Test harness contract: `/home/user/daftar/tests/helpers/stock-ledger.ts` (Agent C)

**H-1: owner raw SQL.**
- `ownerPool()` (`tests/helpers/test-app.ts`) runs one transaction per case and reports whether the refusal came at the statement or at `COMMIT`. Precedent: `tests/security/accounting-raw-sql-invariants.test.ts`.
- `seedOwnerMovement(c, …)` writes, as a chain:
  1. the fixture line and bridge row;
  2. the movement, binding and cache row, with the given stored values (used for the §4 seeds);
  3. scope GUCs set, so the binding trigger can see the bridge.

**H-2: fixture producer.**

Constants:

```ts
FIXTURE_OP = 'fixture.stock_move'
FIXTURE_OP_OTHER = 'fixture.stock_other'
FIXTURE_SOURCE_TYPE = 'fixture_line'
```

`installStockFixture(c: PoolClient)` runs, as superuser, in the caller's transaction:

1. **Kinds and mappings:**

   ```sql
   INSERT INTO inventory_operation_kinds (op_code, registered_by)
   VALUES ('fixture.stock_move', 'P3-S2'), ('fixture.stock_other', 'P3-S2');
   ```

   The regex is at `0054:53-54`. Map `fixture.stock_move` to the nine kinds other than `purchase_reversal`; map `fixture.stock_other` to `purchase_reversal` only.
2. `INSERT INTO stock_source_types VALUES ('fixture_line', 'P3-S2')`.
3. **Fixture line table:** `stock_fixture_lines (business_id UUID, source_id UUID, id UUID, warehouse_id UUID, variant_id UUID, qty NUMERIC(18,4), unit_cost_base_minor NUMERIC(28,10), PRIMARY KEY (business_id, source_id, id))`.
4. **Bridge `stock_source_bridge_fixture_line`:** exactly the L:1501-1519 template, with `source_type GENERATED ALWAYS AS ('fixture_line') STORED`. It has a line FK `ON DELETE RESTRICT` to `stock_fixture_lines` and a binding FK `ON DELETE RESTRICT`. RLS matches `stock_movements`: tenant via the `businesses` subquery, the identity read policy, and a restrictive policy with internal USING admission. Grants: internal SELECT and INSERT. It carries trigger `stock_bridge_immutable_fixture_line` using `stock_ledger_append_only()`. **This is the template S3–S5 copy.**
5. **Binding trigger function** `stock_binding_requires_fixture_line()`: plpgsql DEFINER, pinned, PUBLIC revoked, `ALTER … OWNER TO daftar_inventory_internal`. It raises `inventory.stock_source_line_missing` when there is no bridge row for `NEW`'s `(business_id, source_id, source_line_id, movement_kind)`. Installed as:

   ```sql
   CREATE CONSTRAINT TRIGGER stock_binding_requires_fixture_line
     AFTER INSERT ON stock_source_bindings DEFERRABLE INITIALLY DEFERRED
     FOR EACH ROW WHEN (NEW.source_type = 'fixture_line')
     EXECUTE FUNCTION stock_binding_requires_fixture_line();
   ```

6. **Freeze trigger** `stock_fixture_lines_freeze`: BEFORE UPDATE on the line table. It raises `inventory.source_line_frozen` when `qty`, `unit_cost_base_minor`, `variant_id` or `warehouse_id` changes while a bridge row references the line.
7. **Entry routines:**
   - `stock_fixture_apply(p_nonce UUID, p_requests inventory_movement_request[], p_bridge BOOLEAN DEFAULT true)`
   - `stock_fixture_apply_other(…)` (same signature)

   Each is internal DEFINER, pinned, PUBLIC revoked, `GRANT EXECUTE … TO daftar_app`. The first statement is:

   ```sql
   v := inventory_assertion_consume('fixture.stock_move',
          inventory_claimed_payload_digest('fixture.stock_move', ARRAY['uuid'], ARRAY[p_nonce::text]));
   ```

   (`_other` uses its own op.) Then it upserts one fixture line per distinct `(source_id, source_line_id)`, inserts bridge rows only if `p_bridge`, and `RETURN QUERY SELECT * FROM inventory_apply_stock_movements(p_requests)`.
8. **Control variant** `stock_fixture_lock_in_payload_order(...)`: used only by T-04.N. It locks keys `FOR UPDATE` in payload order.

**Minting.** `mintFixtureAssertion({ opCode, actorUserId, tenantId, businessId, nonce, jti?, now?, ttlSeconds? })`. The package minter refuses unregistered kinds (`packages/inventory/src/assertion.ts:168-173`), so this helper builds the assertion by hand:

```ts
digest = sha256hex(`invpl/1\n${opCode}\n${tenantId}\n${businessId}\n${nonce}\n`)
// cross-checked once per suite against: SELECT inventory_payload_digest($op, $t, $b, ARRAY['uuid'], ARRAY[$nonce])  (0054:214-262)
signed = [INVCTL_VERSION, INVENTORY_ASSERTION_KID, actor, tenant, business, opCode.replace(/\./g, ':'),
          digest, String(floor(now/1000) + ttl), jti ?? randomUUID()]
mac = createHmac('sha256', inventoryAssertionKey().secret).update(inventoryAssertionPreimage(signed)).digest('hex')
// INVCTL_VERSION and inventoryAssertionPreimage: assertion.ts:41, :184-187; key: tests/helpers/test-app.ts:98-104
assertion = `${signed.join('.')}.${mac}`
```

**Calling.** `applyAsApp(c, { assertion, tenantId, businessId, nonce, requests, other?, bridge? })`:

```sql
SELECT set_config('app.tenant_id', …, true), set_config('app.business_id', …, true),
       set_config('app.inventory_assertion', …, true);
SET LOCAL ROLE daftar_app;
SELECT * FROM stock_fixture_apply($1::uuid, $2::inventory_movement_request[], $3);
RESET ROLE;
```

**Seeding.** `seedStockBusiness(pool, slug)` creates:
- a tenant, a business, a user, a branch and two warehouses (the pattern at `tests/helpers/accounting-posting.ts:226-256`);
- products, configured with `SET LOCAL ROLE daftar_inventory_internal` under scope, as `tests/security/inventory-db-authority.test.ts:446-452` does:
  - tracked `piece`/0 with its base variant;
  - tracked with decimals 2 and with decimals 4, each with a base variant;
  - an untracked product;
  - a tracked variant product with two merchant variants and no base;
- a second tenant and business.

**Lifecycle:**
- **Rolled back (default):** `withRolledBackFixture(fn)` runs `BEGIN`, `installStockFixture`, `fn`, `ROLLBACK`.
- **Committed (H-3 suites only):** `installCommittedFixture()` first calls `removeCommittedFixture()`, which is idempotent, then installs and commits.
- **`removeCommittedFixture()`:**
  1. `TRUNCATE stock_source_bindings, stock_movements, stock_levels, negative_deficit_coverages, negative_inventory_deficits, stock_source_bridge_fixture_line, stock_fixture_lines` (append-only blocks DELETE; TRUNCATE is allowed, E-24).
  2. Drop the fixture triggers, functions and tables.
  3. `DELETE FROM inventory_assertion_uses WHERE op_code LIKE 'fixture.%'`; delete the mapping rows, the source type and the two kinds.
  4. Assert the migration state: registries empty and exactly the 3 S1 kinds.

**H-3: two real connections with forced interleaving.**
- Two superuser `Client`s, each doing `BEGIN`, GUCs, `SET LOCAL ROLE daftar_app`, and a fixture call with its own assertion.
- Blocking is observed through `pg_stat_activity.wait_event_type = 'Lock'` for the other pid. Precedent: `tests/integration/accounting-concurrency.test.ts:18-31`.

**H-4: one specification, two implementations.** The SQL side is always R1, R2 or R3 itself, never a test-only copy.

**H-5: the A-10 composite.** One superuser client runs, in one transaction that ends in `ROLLBACK`:
1. `BEGIN`; install the fixture; set scope.
2. `SET LOCAL ROLE daftar_app`; the fixture movements.
3. For each non-zero stored value `v` (read with `SELECT value_delta_base_minor FROM stock_movements WHERE …`), `postAs(assertionFor(cmd, fx.userId), cmd, {}, client)` (`accounting-posting.ts:113-127`, `:149-192`). `cmd` is a `manual_adjustment` whose lines are `{account: {kind: 'system', systemKey: 'inventory'}, side: v > 0 ? 'D' : 'C', baseAmountMinor: |v|, ILS, rate '1', 'base'}` plus the mirrored `opening_equity` line (shape of `simpleCommand`, `:265-304`).
4. `RESET ROLE`; query `journal_lines` joined to `accounts`, by system key; `ROLLBACK`.

---

## 6. Test plan

**Owners:**
- **C:** S2 tests and harness.
- **B:** package and guards.
- **D:** coordinator and predecessors.

Every DENY group has a negative control, marked `.N`, that removes the invariant inside a rolled-back transaction and shows the test turning red.

### 6.1 Plan §4 must-prove bullets

| Plan bullet | Test file (owner) | Proof | Negative control |
| --- | --- | --- | --- |
| P:153 UPDATE/DELETE on movements refused, owner included | `tests/security/stock-ledger-structure.test.ts` (C) | T-01 | T-01.N |
| P:154 no runtime DML, from the live matrix | `tests/security/stock-ledger-authority.test.ts` (C) | T-02 | T-02.N |
| P:155 concurrent first-touch | `tests/integration/stock-ledger-concurrency.test.ts` (C) | T-03 | T-03.N |
| P:156 opposite multi-key commands, no deadlock | same | T-04 | T-04.N |
| P:157 byte-identical TS/SQL, ties | `packages/inventory/test/valuation-vectors.test.ts`, `rounding.test.ts` (B); `tests/integration/stock-ledger-vectors.test.ts` (C) | T-05 | T-05.N |
| P:158 exact rebuild over hundreds of movements | `tests/integration/stock-ledger-rebuild.test.ts` (C); `packages/inventory/test/rebuild.test.ts` (B) | T-06 | T-06.N |
| P:159 `qty = 0` quantity movement refused; value-only with cost refused | `tests/integration/stock-ledger-primitive.test.ts` (C) | T-07 | CHECK dropped in-transaction, then accepted |
| P:160 ten precision vectors | primitive test (C); `quantity.test.ts` (B) | T-08 | T-08.N |
| P:161 nine vectors with journal/GL; B and C as negative controls | vectors test (C) plus the package (B) | T-09 | withdrawn aggregate: 1 ≠ 2 and 1 ≠ 0 |
| P:162 full depletion and the `on_hand = 0` invariant; cycle equality | vectors test (C) | T-10 | T-10.N |
| P:163 no 6100 line, queried from entries | vectors test (C, H-5) | T-11 | 6100 line planted in-transaction, query goes red |
| P:164 no `on_hand × avg` path, static | `tests/integration/stock-ledger-guards.test.ts` (B) | T-12 | T-12.N |
| P:165 source registry | structure test (C) | T-13 | — (FK, declarative) |
| P:166 source completeness | structure test (C) | T-14 | T-14.N |
| P:167 binding cardinality | structure test (C) | T-15 | third binding |
| P:168 primitive authority | authority test (C) | T-16 | T-16.N |
| P:169 unit history lock, rows 3–6 and 8, name and order | `tests/integration/stock-ledger-unit-lock.test.ts` (C); catalogue part in the authority test | T-17 | T-17.N |

### 6.2 T-rows (PREP:142-345), bound to the rulings

**T-01 · Append-only (structure test, C).**
- **T-01.1:** H-2 fixture movement, binding and bridge commit — shown via `SET CONSTRAINTS ALL IMMEDIATE` then `ROLLBACK`.
- **T-01.2 – T-01.4:** as owner, UPDATE any column and DELETE on `stock_movements`, `stock_source_bindings` and `negative_deficit_coverages` → `P0001 inventory.ledger_immutable`. DELETE on `stock_levels` → `inventory.stock_level_not_deletable`.
- **T-01.5:** the same as `daftar_app` → `42501`.
- **T-01.6:** an owner `TRUNCATE` succeeds, documented and not claimed.
- **T-01.N:** drop the trigger in-transaction; the UPDATE then succeeds.

**T-02 · Live grant matrix (authority test, C).**
- **T-02.1:** S2 relations are discovered from `pg_class` (`stock_%`, `negative_%`, `inventory_operation_movement_kinds`). For every runtime role and `public`, table- and column-level INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER are false. Real DML as `daftar_app` → `42501`.
- **T-02.2:** EXECUTE on R1–R8 is false for every runtime role.
- **T-02.3:** `daftar_app` SELECT sees its own business only.
- **T-02.4:** no runtime role is a member of the internal role, transitively.
- **T-02.5:** every internal-owned S2 routine has the pinned path, no PUBLIC EXECUTE, and an owner that cannot log in. The internal role holds exactly the A-01 set.
- **T-02.N:** `GRANT INSERT ON stock_levels TO daftar_app` in-transaction makes the checker report the leak.

**T-03 · First-touch concurrency (concurrency test, committed fixture, C).**
- **T-03.1:** A holds a new key uncommitted. B's call blocks in `INSERT … ON CONFLICT`, which is observed. A commits. The result is one row and `stock_seq` 1 and 2, with the average equal to the serial TS simulation.
- **T-03.2:** A rolls back; B gets seq 1 and `last_stock_seq = 1`.
- **T-03.3:** the same five-part identity from both sides. The loser gets `inventory.movement_identity_conflict`, never 23505, and no sequence gap.
- **T-03.N:** a control fixture routine that reads the level without `FOR UPDATE` shows a lost update.

**T-04 · Multi-key order (concurrency test, C).**
- **T-04.1:** 50 rounds of opposite K1/K2 transfers on two connections: no `40P01`.
- **T-04.2:** a third connection holds K_min. A's call, whose payload lists K_max first, blocks. A probe `SELECT … FOR UPDATE NOWAIT` on K_max succeeds, which proves the payload order is not the lock order.
- **T-04.3:** rule 21 finds no `40P01` / `deadlock_detected` handling (static).
- **T-04.N:** `stock_fixture_lock_in_payload_order` reproduces `40P01`.

**T-05 · Parity (vectors test C; package B).**
- **T-05.1:** every R-row through `SELECT inventory_half_even(...)::text`; every scenario through the primitive, comparing stored values, cache, snapshots and averages as text. They are byte-equal to the JSON and to the TS output.
- **T-05.2:** the ties R-01 … R-06 and R-14.
- **T-05.N:** PostgreSQL `round(0.5)`, and `round()` in general, disagrees with the `halfEven` column.

**T-06 · Rebuild (rebuild test, C; B for the pure part).**
- **T-06.1:** a deterministic seeded generator (TS) produces at least 300 movements across K1/K2 and one variant: purchases with 10-dp costs and 2-dp quantities, damages (partial and full), adjustments of both signs, transfers, and value-only movements while `on_hand > 0`. Each batch is a fixture call with its own assertion, all in one rolled-back transaction. Then `inventory_stock_verify(...)` gives `matches = true`, `foldMovements` over the stored rows equals the cache, and the TS `simulateMovement` stream predicted every stored value.
- **T-06.2:** a key that empties and refills carries its average.
- **T-06.3:** a row with `last_stock_seq = 0` and no movement matches.
- **T-06.4:** an owner-planted valuation drift gives `matches = false`, and the cache is unchanged afterwards.
- **T-06.5:** a catalogue scan: the only internal-owned `prosrc` matching `UPDATE\s+stock_levels` is R3.
- **T-06.6** (concurrency test): verify waits on a live uncommitted movement, then matches.
- **T-06.N:** folding with `on_hand × avg` on CTRL-FLUSH gives 0 ≠ 1.

**T-07 · Shape (primitive test, C).**
- **T-07.1 / T-07.2:** accept vector C (value 0) and a value-only movement.
- **T-07.3 – T-07.5:** as owner raw → `23514` (the named CHECKs); via the primitive → `inventory.movement_shape_invalid`.
- **T-07.6:** `inventory.quantity_sign_invalid` for negative on `purchase`, non-zero on `negative_inventory_cost_adjustment`, and zero on `adjustment`.
- **T-07.7:** `inventory.reason_required` for `damage` and `adjustment`; the reason is stored.

**T-08 · Precision (primitive test, C).**
- P-01 … P-10 through R2 and through the primitive. P-03 runs after a +3 purchase and uses `damage`.
- **T-08.7:** owner sets `units.default_decimals` for `piece` to 3 in-transaction; the product's 0 still governs.
- **T-08.N:** a control using `scale(qty) <= d` refuses `1.0000`.

**T-09 · The nine vectors (vectors test C, H-5).** Per scenario A–I, assert:
- the stored value(s);
- `stock_levels.valuation_base_minor`;
- the Inventory journal lines (the posted ones), the 6100 count = 0, and the GL;
- the reconciliation `Σ movement values = Σ cache = GL`.

**T-10 · Full depletion (vectors test, C).**
- **T-10.1:** vector G.
- **T-10.2:** an owner UPDATE of the cache to `on_hand = 0, valuation = 5`, then `COMMIT`, raises `inventory.zero_stock_residual_value` (at COMMIT).
- **T-10.N:** CTRL-FLUSH, where the withdrawn rule leaves 1.

**T-11 · No second conversion (vectors test, C, H-5).**
- **T-11.1:** zero `rounding` lines.
- **T-11.2:** the Inventory line total equals Σ stored values.

**T-12 · Static guards (guards test, B).**
- **T-12.1 – T-12.3:** rule 21 fires on planted strings: `on_hand * avg`, `onHand * avg`, `round(`, `scale(`, `FLOAT` on an inventory table, `ORDER BY created_at` over movements or deficits, and `40P01`.
- **T-12.4:** `stock_levels` passes the balance guard by name only; a planted `stock_levels.reserved` or a `stock_balances` table fails.
- **T-12.N:** each guard fails on its own planted violation file.

**T-13 · Source registry (structure test, C).**
- **T-13.1:** owner inserts with `'purchase '`, `'Purchase'` and `'sale'` → `23503` at the statement.
- **T-13.2:** the fixture type is accepted.
- **T-13.3:** after migration, `count = 0` (also in 0059-E).

**T-14 · Completeness (structure test, C).**
- **T-14.1 / T-14.2:** an owner-raw movement without a binding, and a binding without a movement → `23503` at COMMIT.
- **T-14.3:** a fixture call with `p_bridge = false` → `inventory.stock_source_line_missing` at COMMIT.
- **T-14.4:** deleting a bound fixture line is refused on the bridge's line FK: `23001` from PostgreSQL 18, `23503` before (the H-2 template is `ON DELETE RESTRICT`; see A-20, scope). The test derives the expected code from `server_version_num`.
- **T-14.5:** updating its qty, cost, variant or warehouse → `inventory.source_line_frozen`.
- **T-14.6:** in-transaction, register `fixture_orphan` in `stock_source_types` without a bridge. The 0059-E gap check (`DO $$ … IF EXISTS (SELECT 1 FROM inventory_stock_source_guard_gaps()) THEN RAISE 'inventory.source_guard_missing …'`) refuses.
- **T-14.N:** drop the binding trigger and add a source-side trigger only; T-14.3 then commits.

**T-15 · Cardinality (structure test, C).**
- **T-15.1:** one fixture line carries `transfer_out` and `transfer_in`: two bindings, and both FKs resolve.
- **T-15.2:** a third, same-kind binding → `23505`.
- **T-15.3:** `pg_constraint` shows both FKs over five columns, deferrable and initially deferred.

**T-16 · Primitive authority (authority test, C).**
- **T-16.1:** each runtime role calling R3 → `42501`.
- **T-16.2:** the owner calls R3 with a valid, unconsumed fixture carrier and the mapping present → `inventory.assertion_not_consumed`.
- **T-16.3:** no carrier → `inventory.assertion_missing`.
- **T-16.4:** an `_other` assertion requesting `purchase` → `inventory.movement_kind_not_authorized`.
- **T-16.5:** assertion for business B with scope A → `inventory.assertion_scope_mismatch`.
- **T-16.6:** verified A naming B's warehouse or variant → `inventory.warehouse_not_found` / `inventory.variant_not_found`; the owner-raw cross-business insert → `23503`.
- **T-16.7:** the owner inserts a uses row for the carrier's jti with `xact = '1'::xid8`; R3 → `inventory.assertion_not_consumed`.
- **T-16.8:** the mapped kind is written, and `actor_user_id` equals the signed actor even with `app.actor_user_id` spoofed.
- **T-16.9:** at end-of-migration state, where the mapping is empty, a consumed fixture op → `inventory.assertion_wrong_operation`.
- **T-16.N:** replace `inventory_assertion_current(text[])` in-transaction with a stub returning the claims; T-16.2 then succeeds.
- **PM-44 live sweep:** every internal-owned `prosrc` that INSERTs into, UPDATEs or DELETEs from a stock table has `inventory_assertion_(consume|current)(` as its first statement. The expected set is {R3}. Control: an in-transaction violating function is flagged.

**T-17 · Unit lock (unit-lock test, C).** Runs through the real `inventory_configure_product`, with the S1 minter via `mintTestInventoryAssertion` (`tests/helpers/test-app.ts:107-108`).
- **T-17.1:** row 2 is allowed.
- **T-17.2:** row 3 → `inventory.unit_identity_locked`.
- **T-17.3:** raw `daftar_app` → `inventory.configuration_authority_required`.
- **T-17.4:** raw, `SET LOCAL ROLE` internal with scope → `inventory.unit_identity_locked`.
- **T-17.5:** guard 1 dropped in-transaction, superuser, unscoped or another business's scope → `inventory.scope_mismatch`; with the product's scope → `inventory.unit_identity_locked`.
- **T-17.6:** rows 4 and 5 (the decimals change; stock back to 0).
- **T-17.7:**
  - Row 6: disable at zero, then re-enable with a NULL unit → the unit is unchanged.
  - Re-enable with a different unit → locked.
  - Disable at non-zero → `inventory.tracking_disable_requires_zero_stock`.
- **T-17.8:** row 8 (`default_decimals` changed by the owner).
- **T-17.9:** row 7 (`products.unit` label) is allowed.
- **T-17.10:** `pg_trigger` shows the trigger by name, the `WHEN` clause, DEFINER owner, and order after `products_10`.
- **T-17.11** (concurrency test): race the first movement against a unit change, in both orders. Never both commit; the second waits on the product lock (A-23). The same holds for the disable race.
- **T-17.N:** drop guard 2; T-17.2 is then allowed.

**T-18 · Isolation (authority test, C).**
- **T-18.1:** reads across businesses → 0 rows.
- **T-18.2:** `app.bypass_rls = true` does not widen them.
- **T-18.3 / T-18.4:** a tenant mismatch or a split pair → `23503`.
- **T-18.5:** an internal role (`SET LOCAL ROLE`, scope A) inserting a B row → RLS WITH CHECK refusal.
- **T-18.6:** R5 or R6 for B under scope A → `inventory.scope_mismatch`.

**T-19 · Managed PostgreSQL (D).**
- `migration-portability`: fresh `0000 → 0060` as `daftar_migrator` equals the superuser catalogue; rerun is a no-op.
- `migration-upgrade`: `0058 → 0060` with S1-era data (tracked product plus base variant). After the upgrade: no stock rows, 10 kinds, empty registries, the trigger present, and configure still works.
- `npm run check:deployment-authority`.

**T-20 · Deficits (structure test, C).**
- **T-20.1:** the CHECKs → `23514`, including the status consistency CHECK.
- **T-20.2:** a duplicate `deficit_seq` → `23505`.
- **T-20.3:** two owner-seeded deficits with equal `created_at` read back in `ORDER BY deficit_seq, id` deterministically. R4 returns max + 1 under the key lock; with no key it raises `inventory.stock_key_missing`.
- **T-20.4:** a coverage with `qty_covered <= 0` → `23514`; coverages are append-only.

**T-21 · Insufficient stock (primitive test, C).**
- **T-21.1:** each negative kind (`supplier_return`, `transfer_out`, `damage`, negative `adjustment` and `stocktake`, `purchase_reversal` via `_other`) with `abs(qty) > on_hand` → `inventory.insufficient_stock`.
- **T-21.2:** `abs(qty) = on_hand` is accepted and flushes.

**Also in the primitive test (C):**
- A-29: a merchant variant beside the base → `inventory.variant_not_stock_identity`; the base variant and a variant-product's variants are accepted.
- Transfer pair missing and mismatch.
- Bounds: `inventory.value_out_of_range`, `inventory.quantity_out_of_range`, `inventory.cost_invalid`.
- An untracked product → `inventory.product_not_tracked`.
- `inventory.movement_kind_unknown`.

---

## 7. Gate, guards and predecessor evolution

### 7.1 `scripts/phase3-s2-gate.ts` (D)

Model it on `phase3-s1-gate.ts`. `package.json` gains `"gate:phase3:s2": "tsx scripts/phase3-s2-gate.ts"` after the line at `package.json:55`.

**Constants:**

```ts
S2_MIGRATIONS = ['0059_inventory_stock_ledger.sql', '0060_inventory_stock_primitive.sql']
S2_ACCEPTED   = {}   // Agent D fills the digests only on Tech Lead acceptance
```

**Checks:**

1. **Boundary.**
   - `manifest.frozenThrough` must be `0058_…` or `0060_…`. If `0058`, neither S2 file may appear in the manifest (no premature freeze). If `0060`, `S2_ACCEPTED` must be non-empty and match both disk and manifest.
   - The files named `> '0058'` must be exactly `S2_MIGRATIONS`, so any later migration fails the gate (P:293).
2. **Scope.** In 0059 and 0060, with comments stripped, none of the following may appear:
   - `INSERT INTO (stock_source_types|inventory_operation_movement_kinds|inventory_operation_kinds)`;
   - `GRANT EXECUTE`;
   - `CREATE TABLE` for `negative_inventory_cost_adjustments|purchase\w*|supplier\w*|inventory_transfer\w*|stocktake\w*|stock_source_bridge_\w+`;
   - a column `reserved|available`;
   - any `LATER_OPERATION_KINDS` (`phase3-s1-gate.ts:87-95`).
3. **Required objects** by regex:
   - the six tables and three registries;
   - the six triggers of §2.4;
   - R1–R8, `stock_ledger_append_only`, `stock_levels_retain` and `inventory_stock_source_guard_gaps`;
   - `SET LOCAL ROLE daftar_inventory_internal` before `CREATE OR REPLACE FUNCTION inventory_configure_product` in 0060;
   - the CREATE bracket in 0060.
4. **Package:**
   - `src/{fixed-point,rounding,quantity,valuation,rebuild}.ts` and `vectors/valuation-vectors.json` exist.
   - The JSON has exactly 10 precision IDs P-01…P-10.
   - The scenario IDs are exactly `A…I` plus `AL08-RECEIPT`, `AL08-TRANSFER-GOLD44`, `AL08-ADJ-POS`, `AL08-ADJ-NEG`, `AL08-CATCHUP-GOLD54`, `AL08-CATCHUP-GOLD55` and `AL08-CATCHUP-GOLD72`.
   - No framework or `pg` import in `packages/inventory/src`.
5. **Suites:** the files in `P3_S2_TESTS` (§8) exist, and at least one `stock-ledger-*.test.ts` is discovered.
6. **Runner canary** (`phase3-s1-gate.ts:310-323`).
7. **STEPS:**
   1. `npm run gate:phase3:s1`. This composes P2-S8…, check:migrations, check:guards, check:deployment-authority, the `@daftar/inventory` unit suite and every S1 and predecessor suite, including the evolved ones.
   2. `npx vitest run <P3_S2_TESTS ∪ discovered stock-ledger-*>`.

### 7.2 Guards (B). They evolve only additively; existing exports are unchanged.

**`scripts/guards/no-float-rate.ts`:**
- Add `INVENTORY_TABLE_RE = /^(stock_[a-z0-9_]+|negative_[a-z0-9_]+|inventory_[a-z0-9_]+)$/` and `findInventoryNumericViolations(sql)`.
- Any `REAL`/`FLOAT`/`DOUBLE PRECISION` column on such a table is a violation.
- Type pins:
  - `qty_delta`, `on_hand`, `*_qty` and `qty_*` must be `NUMERIC(18,4)`;
  - `*_cost_base_minor` must be `NUMERIC(28,10)`;
  - `value_delta_base_minor` and `valuation_base_minor` must be `BIGINT`.
- Rule 16 (`static-guards.ts:316-329`) calls it and fails if `stock_movements` is absent ("watching nothing").

**`scripts/guards/no-authoritative-balance.ts`:**
- Add `discoverInventoryTables(sql)` with the same regex, `STOCK_CACHE_EXCEPTION = 'stock_levels'` and `STOCK_CACHE_COLUMNS = ['on_hand','valuation_base_minor','avg_unit_cost_base_minor','last_stock_seq']`.
- Forbidden column patterns on inventory tables: the existing patterns (`:114`) plus `(^|_)(on_hand|valuation|reserved|available)($|_)`. Separately, `INVENTORY_NOT_A_QUANTITY = /_(id|ids|at|by|status|kind|type|code|name|currency|seq)$/` is used **only** for inventory tables, so `stock_seq` and `deficit_seq` pass and accounting behaviour is unchanged.
- `stock_levels` may hold exactly the four named columns and never `reserved` / `available`.
- Forbidden inventory table names: `/(^|_)(stock|inventory)_(balances?|summar(y|ies)|snapshots?|rollups?|caches?)($|_)/`.
- Rule 15 fails if `stock_levels` is absent.

**New `scripts/guards/inventory-arithmetic.ts` (rule 21).** Scope: `packages/inventory/src/**/*.ts` and every migration whose name contains `inventory`, comments stripped. It forbids:
- `/\bon_?hand\w*\s*\*\s*\w*avg|\bavg\w*\s*\*\s*\w*on_?hand|onHand\s*\*\s*\w*avg|avg\w*\s*\*\s*onHand/i`;
- `\bround\s*\(` and `\bscale\s*\(` in SQL;
- `ORDER\s+BY[^;]*\bcreated_at\b` in a statement mentioning `stock_movements` or `negative_inventory_deficits`;
- `40P01|deadlock_detected` in SQL and in `apps/api/src/modules/inventory`;
- `Math\.round|toFixed|parseFloat|Number\(` in `packages/inventory/src`.

The frozen 0053–0058 contain no `round(`, `scale(` or created_at ordering (checked).

**New `scripts/guards/inventory-writer-authority.ts` (rule 22, the PM-44 static half, PM:633).** For every routine transferred to the internal role (reuse the parsing in `inventory-definer-contract.ts`), each **definition** whose body INSERTs into, UPDATEs or DELETEs from `stock_movements|stock_levels|stock_source_bindings|negative_inventory_deficits|negative_deficit_coverages|stock_source_bridge_\w+` must have `inventory_assertion_(consume|current)\(` as its first statement after `BEGIN`.

**`scripts/guards/inventory-definer-contract.ts` (strengthened).** Validate **every** `CREATE FUNCTION` definition of a transferred routine in every file, not only the last one (`:86-99`). This is required because 0060 replaces `inventory_configure_product`. The existing mutation tests at `tests/integration/inventory-db-guard.test.ts:72`, `:119` and `:124` mutate the 0055 definition, and would otherwise go blind.

**`scripts/static-guards.ts`:**
- Add `'packages/inventory/src'` to the rule 6b list (`:108-115`).
- Add rules 21 and 22.
- The final line becomes `PASS (22 rules)`.

### 7.3 Predecessor evolution (without weakening)

| File | Owner | Change |
| --- | --- | --- |
| `tests/security/inventory-db-authority.test.ts:217-236` | D | The exact map gains: `inventory_operation_movement_kinds: 'SELECT'`, `negative_inventory_deficits: 'SELECT'`, `stock_levels: 'INSERT,SELECT'`, `stock_movement_kinds: 'SELECT'`, `stock_movements: 'INSERT,SELECT'`, `stock_source_bindings: 'INSERT'`. It stays exact equality. |
| same, `:238-252` | D | Adds `{ t: 'stock_levels', p: 'UPDATE', cols: 'avg_unit_cost_base_minor,last_stock_seq,on_hand,valuation_base_minor' }`. Tests at `:254-273` and `:295-312` are unchanged. |
| `tests/security/search-path-shadowing.test.ts:483-494` | D | Adds the eight S2 relations to `INVENTORY_TRUSTED_RELATIONS`. `EXECUTE_MATRIX` (`:475-481`) is unchanged, since S2 grants none. |
| `tests/integration/migration-portability.test.ts:1096-1136` | D | The owners list adds internal R1–R8, and the `IN (...)` list plus expectations add migrator-owned `stock_ledger_append_only`, `stock_levels_retain` and `inventory_stock_source_guard_gaps` (definer false, pinned). |
| `tests/integration/migration-upgrade.test.ts` | D | New case `0058 → 0060` (T-19). |
| `tests/integration/inventory-db-guard.test.ts:47-64` | B | The exact `transferred` list adds R1–R8. New mutation cases: a 0060 replacement turned INVOKER, and a stock writer without a first-statement assertion (rule 22). |
| `scripts/phase2-deployment-authority.ts` | D | Change only if it fails, and then only additively. |
| `/home/user/daftar/infrastructure/database/bootstrap.sql:192` | D | Owner-list comment. Optional; comment only. |

---

## 8. File ownership (four agents, one migration writer)

| Agent | Owns exclusively | Starts after |
| --- | --- | --- |
| **A · DB (sole migration writer)** | `infrastructure/database/migrations/0059_inventory_stock_ledger.sql`, `infrastructure/database/migrations/0060_inventory_stock_primitive.sql` | this contract |
| **B · package and guards** | `packages/inventory/src/{fixed-point,rounding,quantity,valuation,rebuild}.ts`, `src/errors.ts` (union only), `src/index.ts` (exports only); `packages/inventory/scripts/{generate-valuation-vectors,valuation-vector-cases}.ts`; `packages/inventory/vectors/valuation-vectors.json`; `packages/inventory/test/{fixed-point,rounding,quantity,valuation,rebuild,valuation-vectors}.test.ts`; `scripts/guards/{no-float-rate,no-authoritative-balance,inventory-definer-contract}.ts` (additive); new `scripts/guards/{inventory-arithmetic,inventory-writer-authority}.ts`; `scripts/static-guards.ts`; `tests/integration/stock-ledger-guards.test.ts`; `tests/integration/inventory-db-guard.test.ts` | the package at once; the guards after A's SQL is final |
| **C · S2 tests** | `tests/helpers/stock-ledger.ts`; `tests/security/stock-ledger-authority.test.ts`; `tests/security/stock-ledger-structure.test.ts`; `tests/integration/stock-ledger-{primitive,vectors,rebuild,concurrency,unit-lock}.test.ts` | A (DB) and B's vectors JSON |
| **D · coordinator** | the predecessor files of §7.3 (except B's); `scripts/phase3-s2-gate.ts`; `package.json` (one gate line); `infrastructure/database/MIGRATION_MANIFEST.json` (on acceptance only); `bootstrap.sql` comment; the acceptance document; the full regression (P:297-317) | A, B, C |

`P3_S2_TESTS` in the gate:
- `tests/security/stock-ledger-authority.test.ts`
- `tests/security/stock-ledger-structure.test.ts`
- `tests/integration/stock-ledger-primitive.test.ts`
- `tests/integration/stock-ledger-vectors.test.ts`
- `tests/integration/stock-ledger-rebuild.test.ts`
- `tests/integration/stock-ledger-concurrency.test.ts`
- `tests/integration/stock-ledger-unit-lock.test.ts`
- `tests/integration/stock-ledger-guards.test.ts`

**Order:**
1. **In parallel:** A writes 0059, then 0060. B writes the package and publishes `valuation-vectors.json`.
2. C writes the harness first (H-2's self-test of the digest cross-check), then the suites.
3. B writes the guards against A's final SQL.
4. D evolves the predecessors against the real catalogue, then writes the gate.
5. D runs `gate:phase3:s2` and the full P:297-317 regression.

**Discipline:**
- Only one agent at a time runs embedded-PostgreSQL suites (PREP:442).
- Nobody edits 0053–0058, `assertion.ts` or `payload.ts`.
- Nobody but A touches a migration.

---

## 9. Tech Lead notes (non-blocking; none gates implementation)

- **TL-1:** L:1783's "nothing else is added" should list the A-01 writer grants.
- **TL-2:** L:469's "exactly as DM §10ب" should defer to L:490-501. DM:281-292 should drop the NUMERIC catch-up, receipt-movement and journal columns.
- **TL-3:** PPV vectors (L:390) move to P3-S5. P:146's "five" is the L:390 list minus PPV.
- **TL-4:** P3-S3 must re-prove P:161 and P:163 with the real inventory accounting source (A-10).
- **TL-5:** the rebuild swap (L:1232-1234) needs a slice and an op kind; P3-S8 is proposed.
- **TL-6:** L:526, L:390 and P:188 ("source average unchanged") hold only for terminating averages (N-01). Suggested wording: "recomputed from stored values".
- **TL-7:** the policy for converting a simple product that has stock into a variant product (A-29).
- **TL-8:** the history lock's fail-closed `inventory.scope_mismatch` (A-18).
- **TL-9:** the derived `qty_sign` / `requires_reason` for the seven kinds L:432 leaves unstated (A-05).
- **TL-10:** no `UNIQUE (movement_kind)` on the mapping (A-28).

### Critical Files for Implementation

- /home/user/daftar/infrastructure/database/migrations/0059_inventory_stock_ledger.sql (new)
- /home/user/daftar/infrastructure/database/migrations/0060_inventory_stock_primitive.sql (new; replaces `inventory_configure_product` from /home/user/daftar/infrastructure/database/migrations/0055_inventory_configure_product.sql and relies on `inventory_assertion_current` in /home/user/daftar/infrastructure/database/migrations/0054_inventory_assertion_authority.sql:482-550)
- /home/user/daftar/packages/inventory/src/valuation.ts (new, with `fixed-point.ts`, `rounding.ts`, `quantity.ts`, `rebuild.ts` and `vectors/valuation-vectors.json`)
- /home/user/daftar/tests/helpers/stock-ledger.ts (new; the H-1 to H-5 harness)
- /home/user/daftar/scripts/phase3-s2-gate.ts (new; composes /home/user/daftar/scripts/phase3-s1-gate.ts)
