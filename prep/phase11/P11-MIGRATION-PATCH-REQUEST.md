# P11 — MIGRATION PATCH REQUEST (no number allocated)

**to** the Migration Owner (Master directive Part 10 — exactly one migration owner; no agent reserves a number)
**from** the Phase 11 preparation thread, branch `claude/phase11-prep-re0epv`, base `93084f8`
**status** `PREPARED / NOT PROMOTED` — `SPEC ONLY` until PostgreSQL parses and applies it (§81).
**revised 2026-10-08** under `TL-P11-R1` … `TL-P11-R7` and §55/§60/§62/§63. **ADJ-P11-01 is ruled: Option B**, so §3 and §4 below now stand rather than being conditional, and §9 (the Option A outline) is retained only as the record of a closed question. Three substantive corrections: no monetary column anywhere (§55), repair-part billing binds instead of re-selling (§60, `TL-P11-R7`), and the expiry override is withdrawn (`TL-P11-R4`). **This document creates no file in `infrastructure/database/migrations/`, allocates no number — not allocated, not examined, not exampled, not in a filename and not in a comment — and must not be applied.** Every number appearing below is a **citation to an existing file on disk**, never a proposal. It also makes **no timing or performance claim**: none was measured and a number from this container would not be comparable.

---

## 0. Why there is no number here

At base `93084f8` the highest migration on disk is `0086_phase4_rls_quals_once_per_query.sql` and `frozenThrough` is `0079_phase4_pos_till_sessions_cart.sql`. So `0080`–`0086` are **unfrozen P4-S4 candidates**: they may still be corrected, renumbered or withdrawn before the S4 seal. A Phase 11 DDL written against a guessed next number and a candidate predecessor would be a claim about a tree that does not exist yet, and this project has already paid for reading a stale number instead of the live effective definition.

Therefore every statement below names its predecessor as **"the live effective definition at allocation time"**, and the Migration Owner, when Phase 11 is actually authorized, (a) reads the live prefix, (b) allocates serially, (c) re-reads every routine this request re-creates, (d) verifies a fresh install, (e) verifies a real upgrade from the then-frozen boundary.

**Hard preconditions before any of this is allocated:** Phase 4 sealed (S4…S9); the roadmap reached Phase 11 in promotion order (Phase 5 → … → Phase 10 → Phase 11, §88); a sealed Phase 10 `SERVICE` stock-effect capability before repair labour (`TL-P11-R6`); and the Accounting Owner's verification of the repair consumption posting before `repair_part_consumption` goes live (§62). **ADJ-P11-01 is ruled — Option B (`TL-P11-R1`)** — so §3 and §4 stand; §9 is kept as the record of the closed alternative, not as a live branch.

---

## 1. Shape rules every statement below obeys

Copied from the live tree, not from memory.

1. **Tenancy.** Every new relation carries `tenant_id UUID NOT NULL` and `business_id UUID NOT NULL`, PK `(business_id, …)`, and `CONSTRAINT <t>_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id)`. Every cross-table FK is **composite** on `(business_id, …)`.
2. **RLS.** `REVOKE ALL ON <t> FROM PUBLIC;` then `ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;` **and** `ALTER TABLE <t> FORCE ROW LEVEL SECURITY;` as a pair, then the policies of §6 in the `0086` scalar-subselect form.
3. **No relation gets RLS without its policies in the same migration.** A forced relation with zero policies does not fail closed usefully: it makes an internal validator refuse *everything* instead of only the incomplete cases (the P4-S7 `42501` defect). The end-state assertion checks **policy presence per relation**, not merely the `ENABLE`/`FORCE` pair.
4. **Grants.** Default deny. `SELECT` to `daftar_app` on truth relations; column-scoped `UPDATE` to `daftar_inventory_internal` on derived caches only; `INSERT` to the internal owner only; **no `DELETE`, no `TRUNCATE`**; `EXECUTE` to `daftar_app` on entry routines only; **no `EXECUTE` grant at all** on internal definer routines.
5. **Ownership bracket**, in this order (R-P4-S3-04, quoted at `0079:151-157`): `GRANT CREATE ON SCHEMA public TO daftar_inventory_internal` → create types and routines (migrator-owned) → `REVOKE ALL … FROM PUBLIC` → `COMMENT` → create triggers → `ALTER FUNCTION … OWNER TO daftar_inventory_internal` → `REVOKE CREATE ON SCHEMA public` → end-state assertion. P4-S7's H3 found three defects a superuser cannot meet, including an owner transfer placed before the function's own `REVOKE`/`COMMENT`; **this migration is rehearsed as `daftar_migrator`, never as the superuser.**
6. **Definers.** Every `SECURITY DEFINER` routine carries `SET search_path = pg_catalog, public, pg_temp` and is owned by `daftar_inventory_internal` (NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS).
7. **No guard counts rows to prove absence.** A DEFINER reading through one policy cannot distinguish "none exist" from "I can see none". Every Phase 11 guard derives its subject from the authoritative side — the movement row whose `qty_delta` it is checking, in the same statement that wrote it.
8. **No money, including no "non-authoritative" snapshot.** No Phase 11 relation carries `value_*_minor`, `valuation*`, `unit_cost*`, `avg_*` or any monetary column — `TL-P11-R2` and §55 refuse a copied cost column on a serial or lot row even when it is labelled report-only. A report needing an acquisition cost **joins back** to the canonical inventory and accounting history through the movement the overlay already names. The end-state assertion refuses such a column (law L-P11-02).
9. **Registry tags.** `stock_movement_kinds.registered_by` is `CHECK (registered_by ~ '^P3-S[0-9]+$')` at `0059:49-53`. Phase 4 already needed `sale` (`0077:1238-1239`), so the live effective CHECK must be re-read; if it still admits only `P3-S…`, **widening it to `^P(3|4|11)-S[0-9]+$` (or a general `^P[0-9]+-S[0-9]+$`) is part of this request** and is the Migration Owner's call.
10. **Frozen files are never edited.** Everything here is new DDL plus `ALTER`/`CREATE OR REPLACE` in a new file.

Normalization reused, not re-written: the identifier normalization already behind `catalog_identifiers` (`0037_catalog_identifiers.sql`) is the function serial and lot codes normalize through, so the two vocabularies cannot drift.

---

## 2. Pack A — Apparel / variant matrix (`catalog.variant-matrix`)

Touches catalog only. **No inventory relation, no movement kind, no source type.** Each axis combination is already a stock key, which is why this pack needs no overlay — and why it should be built first, as the cheapest end-to-end proof of the pack mechanism.

### 2.1 `product_attribute_axes`
| column | type | notes |
|---|---|---|
| `tenant_id` | UUID NOT NULL | tenant FK pair |
| `business_id` | UUID NOT NULL | |
| `axis_code` | TEXT NOT NULL | `CHECK (axis_code ~ '^[a-z][a-z0-9_]{0,31}$')` — the `units.unit_code` shape (`0053:66`) |
| `translations` | JSONB NOT NULL DEFAULT `'{}'` | business-authored names, `{locale: text}` over `ar|en|tr`; validated by `CHECK` on key set, like `products.translations` (`0005:14-35`) |
| `sort_order` | INTEGER NOT NULL | `UNIQUE (business_id, sort_order)` — stable screen order |
| `status` | TEXT NOT NULL DEFAULT `'active'` | `CHECK (status IN ('active','archived'))` |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT `now()` | |

PK `(business_id, axis_code)`.

### 2.2 `product_attribute_values`
PK `(business_id, axis_code, value_code)`; composite FK `(business_id, axis_code) → product_attribute_axes` `ON DELETE RESTRICT`; `value_code` same regex; `translations JSONB`; `sort_order INTEGER NOT NULL` with `UNIQUE (business_id, axis_code, sort_order)`; `status`.

### 2.3 `product_matrix_axes` — which axes a product's matrix uses
PK `(business_id, product_id, axis_code)`; composite FKs to `products` and to `product_attribute_axes`, both RESTRICT; `axis_position SMALLINT NOT NULL` with `UNIQUE (business_id, product_id, axis_position)`; `CHECK (axis_position BETWEEN 1 AND 4)` — a bounded matrix, because an unbounded cross product is a denial-of-service on the catalogue.

### 2.4 Canonicalization of `product_variants.attributes`
No column is added to `product_variants`. Two new objects:

- `catalog_attributes_canonical(p_attributes JSONB) RETURNS JSONB` — IMMUTABLE STRICT, migrator-created, internal-owned, `SET search_path`: refuses a non-object, a nested value, a non-text value, a key or value outside the axis regex, by returning `NULL` (which the index and the trigger both treat as invalid). **It does not sort keys.** The first draft aggregated with `jsonb_object_agg(k, v ORDER BY k)` "so that two equal maps have one text form"; execution proved that sort **inert** — **jsonb canonicalizes object key order itself**, by key length then bytewise, and that is the real source of the expression index's correctness (defect 6 of the live proof). The function validates shape and returns its input. It must also be written so the type guard precedes the deconstruction: `jsonb_each` **raises** on a scalar, so a `WHERE`-clause guard in the same query is too late.
- `product_variants_40_matrix_canonical()` — `BEFORE INSERT OR UPDATE` trigger on `product_variants`, `SECURITY INVOKER`, migrator-owned (the `products_20_unit_history_lock()` family, `0060:683`). **Position `_40_`, not `_30_`:** `product_variants_30_archive_requires_zero_stock` already occupies 30, and PostgreSQL fires same-event triggers in **name order**, so the first draft's name was a silent ordering coin-flip between two guards (defect 3). `_40_` also states the intended order — the base-variant authority (10) and the stock-identity and archive guards (20, 30) decide first. It refuses:
  | refusal | when |
  |---|---|
  | `catalog.variant_attributes_shape_invalid` | `attributes` is not a flat `{axis_code: value_code}` object |
  | `catalog.variant_axis_unregistered` | an axis key is not in `product_matrix_axes` for that product. **The registry row is read `FOR SHARE`, not with a bare `SELECT` and not `FOR KEY SHARE`:** an unlocked read does not protect the row, and race B of the live proof showed a concurrent `DELETE` of the axis and an `INSERT` naming it both committing, leaving a variant naming an axis that no longer exists (defect 7). With the row locked the deleter waits and the loser is refused. **`FOR KEY SHARE` is not strong enough and that was measured** (independent challenge at `1a8ba15`, finding P1-03): it conflicts with a DELETE and with a key update, but not with an ordinary UPDATE of a non-key column, so `UPDATE product_attribute_values SET status='archived'` walked straight through it and a committed variant named an archived value. `FOR SHARE` conflicts with every write to the row while two validators still share it. |
  | `catalog.variant_axis_value_unregistered` | a value is not an active `product_attribute_values` row of that axis |
  | `catalog.variant_axis_set_incomplete` | the key set is not **exactly** the product's registered axis set (no partial combination) |
  | `catalog.variant_matrix_immutable` | `attributes` are being changed **at all**, on any variant, whether or not stock exists |

  **Two withdrawals, both proved by execution and both recorded rather than quietly dropped:**

  - `catalog.variant_matrix_base_conflict` ("`is_base` and `attributes <> '{}'`") is **withdrawn as dead code** (defect 5). `product_variants_10_base_variant_authority` fires first and refuses the write with `catalog.base_variant_not_mutable`, and `product_variants_base_shape_ck` makes the state structurally impossible. The proof suite asserts the **pre-existing** guard instead, which is the stronger statement because it holds whether or not Phase 11 ships.
  - `catalog.variant_matrix_locked` ("the variant has a `stock_levels` row and `attributes` are being changed") is **withdrawn as unfixable in that shape** (defect 8). Its condition is a cross-table read of a row that **may not exist yet**: race C ran `UPDATE attributes` while no stock existed against a concurrent insert of the variant's **first** `stock_levels` row, and both committed, producing exactly the forbidden state. **An absent row cannot be locked** — only `SERIALIZABLE` gives a predicate lock, and that is not this database's isolation level — so no lock order repairs it. It is replaced by **unconditional immutability**: a combination is an identity (`P11-AL-04`), so the merchant path for a wrong combination is to archive the variant and create the right one. This keeps the refusal entirely inside Pack A's own table and therefore needs **no lock contract with the inventory authority and no second patch request**.

- `product_matrix_axes_10_axis_in_use()` — **new**, `BEFORE DELETE` on `product_matrix_axes`, `SECURITY INVOKER`, migrator-owned. Refuses `catalog.matrix_axis_in_use` when any non-base, non-archived variant of that product names the axis. This is the other half of race B: the key-share read makes the two transactions serialize, and this guard decides which way. Without it the closure invariant would depend on arrival order.

  **It is a refusal guard and not a lock-order device, and the distinction is load-bearing** (`TL-P4-COORD-R62`, measured in the Phase 4 thread): a `BEFORE ROW DELETE` trigger **cannot** take a lock before the row being deleted, because the executor produces `OLD` through `GetTupleForTrigger`, **which locks that tuple before the trigger body is called**. So the ordering must be established by the **inserting** side (the `FOR KEY SHARE` above), never by this trigger, and no implementation note here may promise otherwise. What the mechanism does give is the guard's correctness in the reverse arrival order: the deleter blocks on the key-share lock, so by the time this body runs the variant is committed and visible — proved as race B2.

- `CREATE UNIQUE INDEX product_variants_matrix_uq ON product_variants (business_id, product_id, (catalog_attributes_canonical(attributes))) WHERE NOT is_base AND status <> 'archived' AND attributes <> '{}'::jsonb;` — one variant per combination. (The `attributes <> '{}'` arm is not decoration: without it every attributeless variant of one product collides. Race A proved the index **blocks** the second session while the first holds its speculative insert, rather than letting both proceed to a check — which is the property a `SELECT`-then-`INSERT` uniqueness guard would have failed while passing every serial test.) (An expression index needs an IMMUTABLE function; that is why §2.4's first object is IMMUTABLE and why it may not read a table. The registry checks therefore live in the trigger, and the index enforces only uniqueness of the canonical form. Stated here so a reviewer does not expect the index to do the trigger's job.)

### 2.5 Entry routine
`catalog_generate_variant_matrix(p_product_id UUID, p_axis_codes TEXT[], p_value_codes TEXT[][])` — `VOLATILE SECURITY DEFINER`, owner `daftar_catalog_internal` (the catalog authority already exists, `bootstrap.sql:175`), consuming one assertion through `inventory_assertion_consume` exactly as every entry routine does (`0054:344`). Creates the cross product in one transaction; refuses `catalog.variant_matrix_too_large` above a stated bound; refuses `catalog.variant_matrix_combination_exists` rather than silently skipping; returns the created variant ids in a stable order. `GRANT EXECUTE … TO daftar_app`.

### 2.6 Registry rows
Feature registry: `INSERT INTO features (key, description) VALUES ('VARIANT_MATRIX','Apparel variant matrices')` — append-only; the registry is an FK target so the key must exist before any plan references it.

---

## 3. Pack B — Lot / batch / expiry (`inventory.lot-expiry`) — **Option B shape**

### 3.1 `products` additions
`ALTER TABLE products ADD COLUMN track_lot BOOLEAN NOT NULL DEFAULT false, ADD COLUMN expiry_policy TEXT NOT NULL DEFAULT 'refuse';`
- `CHECK (expiry_policy IN ('refuse'))` — **one admissible value in Phase 11** (`TL-P11-R4`). The column exists so a future country or regulated pack can widen the CHECK with its own permission, audit and policy; Phase 11 ships **no** override value, because a column whose second value nothing enforces yet is an override waiting to be set.
- `CONSTRAINT products_lot_requires_tracking_ck CHECK (track_lot = false OR track_inventory = true)` — a lot of something that holds no stock is meaningless.
- `products_40_lot_history_lock()` — `BEFORE UPDATE` trigger refusing `inventory.lot_tracking_history_locked` when `track_lot` changes and any variant of the product already has a `stock_levels` row (P11-AL-16). **Position `_40_`, not `_30_` as this request first said: `products_30_archive_requires_zero_stock` already holds that name** (defect 17, found by applying it), and trigger name order decides firing order for the same event.
- `products_05_lot_config_authority()` — **new, defect 18.** `track_lot` had no configuration authority at all, so `daftar_app` could switch lot tracking on by itself. This fires FIRST in name order and raises the same `inventory.configuration_authority_required` the existing inventory-configuration guard raises, for both INSERT and UPDATE.
- **Owed to the inventory authority (defect 19): a new registered op code for lot configuration.** `inventory_configure_product`'s authority digest pins its four arguments in a fixed field order, so the frozen command **cannot** carry `track_lot`. The executed proof uses a fixture definer for the configuration step and labels it as a fixture; the production path needs the authority's own new operation.
- **Owed to the Security Authority (defect 20): `GRANT UPDATE (track_lot, expiry_policy) ON products TO daftar_inventory_internal`.** Without it even the authority cannot write the columns it owns.
- **Owed to the Security Authority (defect 21): `GRANT EXECUTE ON FUNCTION catalog_identifier_norm(TEXT, TEXT) TO daftar_inventory_internal`.** `stock_lots_code_canonical_ck` calls it, and **a CHECK expression is evaluated with the writing principal's privileges**, so every writer of `stock_lots` needs EXECUTE on it. Found by applying it, not by reading it.

### 3.2 `stock_lots`
| column | type | notes |
|---|---|---|
| `tenant_id`, `business_id` | UUID NOT NULL | tenant FK pair |
| `id` | UUID NOT NULL | |
| `variant_id` | UUID NOT NULL | composite FK `(business_id, variant_id) → product_variants (business_id, id)` RESTRICT |
| `lot_code_norm` | TEXT NOT NULL | normalized through the catalog identifier normalizer; `CHECK (length between 1 and 64)` |
| `lot_code_input` | TEXT NOT NULL | what the user typed, for display only |
| `expiry_date` | DATE NULL | |
| `produced_on` | DATE NULL | `CHECK (expiry_date IS NULL OR produced_on IS NULL OR expiry_date >= produced_on)` |
| `received_seq` | BIGINT NOT NULL | `>= 1`, per `(business_id, variant_id)`, allocated by the writer; the FIFO/FEFO tiebreak input |
| `status` | TEXT NOT NULL DEFAULT `'active'` | `CHECK (status IN ('active','blocked','closed'))` — `blocked` is a quarantine, not a value change |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT `now()` | |

PK `(business_id, id)`; `UNIQUE (business_id, variant_id, lot_code_norm)`; `UNIQUE (business_id, variant_id, received_seq)`; `UNIQUE (business_id, id, variant_id)` (so overlay rows can carry a composite FK that pins the variant); index `(business_id, variant_id, expiry_date, received_seq)` for the picker.

### 3.3 `stock_lot_movements` — **the overlay; no value column, ever**
| column | type | notes |
|---|---|---|
| `tenant_id`, `business_id` | UUID NOT NULL | |
| `stock_movement_id` | UUID NOT NULL | composite FK `(business_id, stock_movement_id, warehouse_id, variant_id) → stock_movements (business_id, id, warehouse_id, variant_id)` — the existing `stock_movements_id_key_uq` (`0059:129-158`) is exactly the index that makes this four-column FK possible, so the overlay row cannot name a movement of a different key |
| `warehouse_id`, `variant_id` | UUID NOT NULL | carried for that FK and for the cache |
| `lot_id` | UUID NOT NULL | composite FK `(business_id, lot_id, variant_id) → stock_lots (business_id, id, variant_id)` RESTRICT — a lot of another variant is structurally impossible |
| `qty_delta` | NUMERIC(18,4) NOT NULL | `CHECK (qty_delta <> 0)` |

PK `(business_id, stock_movement_id, lot_id)`. Append-only: `stock_lot_movements_append_only()`, the `stock_ledger_append_only()` twin (`0059:264`), refusing UPDATE and DELETE.

### 3.4 `stock_lot_levels` — derived cache, foldable
PK `(business_id, warehouse_id, variant_id, lot_id)`; columns `on_hand NUMERIC(18,4) NOT NULL`, `last_movement_seq BIGINT NOT NULL`; `CHECK (on_hand >= 0)`; composite FKs to `stock_levels (business_id, warehouse_id, variant_id)` and to `stock_lots`. Written only by the writer of §3.6, in the same statement as the movement. Column-scoped `UPDATE (on_hand, last_movement_seq)` to `daftar_inventory_internal`; no `DELETE`.

**The read policy on all three overlay relations is `FOR SELECT TO daftar_inventory_internal`, never to PUBLIC (defect 22).** As first written it was a permissive `USING (true)` applied to PUBLIC, which ORs with `tenant_membership` and **silently switched tenant isolation off for SELECT**: a wrong-tenant read returned 2 rows where it must return 0. The end-state assertion now forbids a blanket permissive policy on PUBLIC for every relation of the pack. No positive test could have found this; only a wrong-tenant negative case did.

### 3.5 Deferred conservation triggers
- `stock_lot_movement_conservation()` — `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` on `stock_movements` **and** on `stock_lot_movements`, firing at COMMIT, refusing:
  | refusal | law |
  |---|---|
  | `inventory.lot_allocation_missing` | the movement's variant is lot-tracked and it has no overlay rows |
  | `inventory.lot_allocation_sum_mismatch` | `Σ overlay qty_delta <> stock_movements.qty_delta` (**C-LOT-01**) |
  | `inventory.lot_allocation_sign_invalid` | an overlay delta's sign disagrees with the movement's |
  | `inventory.lot_allocation_forbidden` | the variant is **not** lot-tracked and overlay rows exist |
  Pattern copied from `stock_levels_zero_on_hand_zero_value` (`0060:655`, installed `:739-742`), including the `SET CONSTRAINTS … IMMEDIATE` behaviour the Phase 3 R-94 finding required a guard to survive.
- `stock_lot_level_conservation()` — deferred, refusing `inventory.lot_level_conservation_violated` when `Σ per-lot on_hand <> stock_levels.on_hand` for a lot-tracked key (**C-LOT-03**).

### 3.6 Writer change — the one core routine this pack must touch
`inventory_apply_stock_movements(inventory_movement_request[])` (live effective definition at allocation time; `0060:133-148` at base) is the only writer of `stock_movements`/`stock_levels`/`stock_source_bindings`. The lot assignment must be part of **its** request, or a second writer appears.

**Required form — additive, never a return-shape change.** P4-S7 was rejected over an invalid `CREATE OR REPLACE` return-shape change, and `base_minor` had to be preserved. So:
1. `CREATE TYPE inventory_lot_assignment AS (lot_code_norm TEXT, lot_code_input TEXT, expiry_date DATE, produced_on DATE, qty_delta NUMERIC);`
2. `ALTER TYPE inventory_movement_request ADD ATTRIBUTE lot_assignments inventory_lot_assignment[];` — nullable, so every existing caller's composite literal stays valid. *(The Migration Owner must confirm `ALTER TYPE … ADD ATTRIBUTE` is acceptable here against the live callers and the `CASCADE` it needs; the alternative is a new named type plus an overload, and that alternative is the fallback, not a redesign.)*
3. The function body gains one step, between its existing "step c" (value and snapshot) and its level write: allocate/lock lots, write `stock_lot_movements`, update `stock_lot_levels` **under the lot level rows' locks in a deterministic order** (`lot_id` ascending, after the existing stock-target lock order of `inventory_lock_stock_targets`, so the global lock order gains a suffix and never an interleave), refusing `inventory.lot_insufficient_stock` per lot.
4. **The return shape does not change.** Per-lot results are read back with the fold routine, not returned.

Nothing else in the body changes: the value arithmetic of `0060:349-420` is untouched, and law **C-LOT-04** proves by execution that consuming lot A and lot B of one variant yields the identical `value_delta_base_minor`.

### 3.7 Fold, verify, pick
- `inventory_lot_fold(business UUID, warehouse UUID, variant UUID, lot UUID) RETURNS …` — STABLE, the `inventory_stock_fold` twin (`0060:517-574`), folding on-hand and last-seq from `stock_lot_movements` ordered by the movement's `stock_seq` only.
- `inventory_lot_verify(...)` — locks the lot level `FOR SHARE` and compares cache against fold, the `inventory_stock_verify` twin (`0060:581-622`).
- `inventory_pick_lots(business UUID, warehouse UUID, variant UUID, qty NUMERIC, as_of DATE, policy TEXT) RETURNS TABLE (lot_id UUID, qty NUMERIC)` — **STABLE**, `as_of` **supplied, never `now()`**; order `FEFO = (expiry_date NULLS LAST, received_seq, lot_id)`, `FIFO = (received_seq, lot_id)`; skips `blocked` and `closed` lots; skips lots expired as of `as_of` (the only Phase 11 policy, `TL-P11-R4`); refuses `inventory.lot_selection_insufficient` with **no partial pick**; refuses `inventory.lot_expired` when the only way to satisfy the quantity is an expired lot. The picker proposes; §3.6 still refuses under its locks, so the picker can never over-promise (**C-FEFO-01**).

### 3.8 Registry rows
No new movement kind and no new source type: a lot-tracked purchase is still `purchase`, a lot-tracked sale is still `sale`. **That is the point** — the overlay rides the existing kinds. Feature registry: `LOT_EXPIRY` already seeded (`0007:94-96`); nothing to add.

---

### 3.9 What the executed proof learned about the FIXTURE, which the next pack will meet too

Neither of these is a defect of the pack; both are authorities correctly refusing a
shortcut, and they are recorded because the shortcut produces green cases over a state
no production path can create.

- **A movement cannot be written by hand (defect 23).** An adjustment binding requires a
  row in `stock_source_bridge_inventory_adjustment`, and its **one writer**
  (`inventory_bridge_source_lines`, `0062`) refuses unless this transaction's entry
  routine consumed an inventory assertion for an operation that owns that source type.
  Eight cases failed on `inventory.stock_source_line_missing` until the fixture stopped
  writing movements and started calling **`inventory_adjust_stock`**, minting the
  assertion the command demands and calling it as `daftar_app`. Every overlay case is now
  an overlay over a movement written by the real writer.
- **A valued document owes an accounting binding (defect 24).**
  `inventory_adjustments_binding_owed_ck` makes a non-zero total owe a row in
  `accounting_source_bindings`, which only the accounting authority may write — so the
  cases use a **zero-value receipt**, which owes none. That is the right fixture anyway:
  the overlay is value-neutral by law (`C-LOT-04`), so no case here needs money to exist.
  **This phase may state an accounting question and may not answer one.**

## 4. Pack C — Serial / IMEI (`inventory.serial-tracking`) — **Option B shape**

### 4.1 `products` additions
`ALTER TABLE products ADD COLUMN track_serial BOOLEAN NOT NULL DEFAULT false;`
- `CONSTRAINT products_serial_requires_tracking_ck CHECK (track_serial = false OR track_inventory = true)`
- `CONSTRAINT products_serial_requires_countable_ck CHECK (track_serial = false OR unit_decimals = 0)` — a serialized item is countable; this is a precondition, not a preference.
- `products_31_serial_history_lock()` — refuses `inventory.serial_tracking_history_locked` on the same rule as §3.1.

### 4.2 `stock_serials`
PK `(business_id, id)`; `variant_id` with composite FK; `kind TEXT NOT NULL CHECK (kind IN ('serial','imei'))`; `value_norm TEXT NOT NULL`, `value_input TEXT NOT NULL`; `custody_state TEXT NOT NULL CHECK (custody_state IN ('in_stock','sold','in_repair','returned_to_vendor','written_off'))`; `warehouse_id UUID NULL` with composite FK, and `CHECK ((custody_state = 'in_stock') = (warehouse_id IS NOT NULL))`; `last_event_seq BIGINT NOT NULL DEFAULT 0`; `created_at`.
`UNIQUE (business_id, kind, value_norm)` — **business-wide, per kind** (P11-AL-15, OD-P11-03). `UNIQUE (business_id, id, variant_id)`. Index `(business_id, variant_id, custody_state, warehouse_id)`.
**Not in `catalog_identifiers`**: that relation's triggers watch `products` and `product_variants` (`0037:33-36`) and a serial's lifecycle is movements, not catalog edits.
**No cost column on a serial** (§55): the acquisition cost of a serialized unit is reached by joining through `stock_serial_events.stock_movement_id` to `stock_movements`, which already carries the authoritative figures. The first draft proposed a report-only snapshot here; it was refused, and rightly — "non-authoritative" is not a property a column has.

### 4.3 `stock_serial_events` — append-only custody chain
PK `(business_id, serial_id, event_seq)`; `event_seq BIGINT NOT NULL CHECK (event_seq >= 1)`; `stock_movement_id UUID NOT NULL` with the same four-column composite FK as §3.3; `direction TEXT NOT NULL CHECK (direction IN ('in','out'))`; `warehouse_id`, `variant_id`; `UNIQUE (business_id, stock_movement_id, serial_id)` — one event per serial per movement. Append-only trigger as §3.3.

### 4.4 Deferred conservation triggers
- `stock_serial_event_conservation()` — deferred constraint trigger refusing:
  | refusal | law |
  |---|---|
  | `inventory.serial_assignment_missing` | serial-tracked variant, movement with no events |
  | `inventory.serial_assignment_count_mismatch` | event count `<> abs(qty_delta)` (**C-SER-03**) |
  | `inventory.serial_assignment_direction_invalid` | an event's direction disagrees with the movement's sign |
  | `inventory.serial_assignment_forbidden` | not serial-tracked, events exist |
  | `inventory.serial_quantity_not_countable` | `qty_delta` is not an integer for a serial-tracked variant |
- `stock_serial_chain_integrity()` — deferred: the chain is gap-free and strictly alternating `in`/`out` from `in`, and `custody_state`/`warehouse_id` equal the chain's last event (**C-SER-02**). A serial is in at most one warehouse because `custody_state = 'in_stock'` pins exactly one `warehouse_id`.
- Conservation to on-hand (**C-SER-01**): deferred, `count(serials in_stock at that warehouse) = stock_levels.on_hand`, refusing `inventory.serial_custody_conservation_violated`.

### 4.5 Reads and the deliberate double guard
`inventory_serial_assert_available(business UUID, serial_id UUID, warehouse UUID) RETURNS BOOLEAN` — STABLE, used by the sale and repair paths *before* the write for a good error message. The authoritative check is in §3.6's writer, under the serial row's `FOR UPDATE` lock, refusing `inventory.serial_not_available` — **because a precondition at a call site is not a property of the function.** The duplication is deliberate and documented in the routine's `COMMENT`, and the write-side one is the one the tests attack (**C-SER-04**: two concurrent sales of one serial, real connections, transaction barriers, exactly one commit).

### 4.6 Registry rows
`SERIAL_TRACKING` already seeded. No new movement kind, no new source type.

---

## 5. Pack D — Repair tickets and warranty (`repairs` — a new capability)

### 5.1 The structural prohibition first
**A customer's device is not inventory.** There is **no `repair_intake` source type**, no movement kind for it, and no value column anywhere in §5. The device never reaches `stock_movements`, `stock_levels` or any valuation. The end-state assertion refuses a registered source type whose name matches an intake, and the gate carries a red proof that registering one turns it red (**C-REP-01**).

### 5.2 Relations
| relation | PK | notes |
|---|---|---|
| `repair_tickets` | `(business_id, id)` | `branch_id`, `customer_id` (composite FKs), `ticket_no` with `UNIQUE (business_id, ticket_no)` allocated through the **existing** document-numbering mechanism (`0075_phase4_customers_invoices_numbering.sql`), never a new sequence; `status`; `opened_at`; `promised_on DATE NULL`; `closed_at NULL` |
| `repair_devices` | `(business_id, id)` | `ticket_id`; free-text make/model; `serial_id UUID NULL` composite FK to `stock_serials` **only when the device was sold by this business** — otherwise `serial_input TEXT` recorded as plain data; `CHECK (serial_id IS NULL OR serial_input IS NULL)`; `accessories_note`, `condition_note` |
| `repair_device_custody_events` | `(business_id, device_id, event_seq)` | append-only; `custody_state IN ('received','in_workshop','awaiting_parts','ready','handed_back','uncollected')` — **`uncollected`, not `abandoned`** (§63): abandonment is a legal conclusion and no column name takes it before business and legal policy define it; `actor_user_id`; `occurred_at`; gap-free, monotonic, and `handed_back`/`uncollected` are terminal |
| `repair_diagnoses` | `(business_id, id)` | `ticket_id`, `technician_user_id`, `summary`, `recorded_at`; append-only (a corrected diagnosis is a new row) |
| `repair_parts` | `(business_id, id)` | **the document line the inventory bridge binds**: `ticket_id`, `variant_id`, `warehouse_id`, `qty NUMERIC(18,4) CHECK (qty > 0)`; `UNIQUE (business_id, id, ticket_id)` |
| `repair_status_events` | `(business_id, ticket_id, event_seq)` | append-only ticket lifecycle, separate from device custody because the two genuinely diverge (a ticket can close while the device is unclaimed) |
| `warranties` | `(business_id, id)` | **anchored and append-only (PART 70, `P11-AL-23`)**: `sale_id`, `sale_line_id` as **one composite FK** `(business_id, sale_id, sale_line_id)` into the Phase 4 sale lines, both `NOT NULL` (**bound only when Phase 4 is sealed**), so an unanchored warranty is unrepresentable rather than merely refused; `serial_id NULL` with a composite FK to `stock_serials` where applicable; `starts_on`, `ends_on` with `CHECK (ends_on >= starts_on)`, `source IN ('business','vendor')`, `terms_translations JSONB`; a derived `current_state` maintained only by the internal owner. A BEFORE UPDATE trigger refuses any change to `sale_id`, `sale_line_id`, `serial_id`, `starts_on`, `ends_on` or `source`, and a BEFORE DELETE trigger refuses the row outright — both `warranty.history_immutable`. An issuance trigger requires the named sale to be **committed**; a draft sale issues no warranty |
| `warranty_lifecycle_events` | `(business_id, warranty_id, event_seq)` | **new.** Append-only, gap-free and monotonic from 1, exactly the `repair_device_custody_events` shape; `state IN ('issued','cancelled','ended','voided-by-return')` with `issued` only at `event_seq = 1` and the other three **terminal**; `reason`, `actor_user_id`, `occurred_at`. `warranties.current_state` equals the last event's state, carried by a deferred COMMIT trigger and foldable, so the derived column is provable against its chain the way the stock caches are. A return or reversal **appends `voided-by-return`**; it never deletes the issuance |
| `warranty_claims` | `(business_id, id)` | `warranty_id`, `ticket_id`, `claimed_at`, `outcome IN ('open','accepted','rejected')`, `reason` |

### 5.3 The inventory bridge for parts
Exactly the `0061:732-745` shape, nothing invented:
```
CREATE TABLE stock_source_bridge_repair_part (
  business_id    UUID NOT NULL,
  source_id      UUID NOT NULL,              -- repair_parts.id
  source_line_id UUID NOT NULL,
  movement_kind  TEXT NOT NULL,
  source_type    TEXT GENERATED ALWAYS AS ('repair_part') STORED,
  PRIMARY KEY (business_id, source_id, source_line_id, movement_kind),
  CONSTRAINT …_line_fk FOREIGN KEY (business_id, source_id) REFERENCES repair_parts (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT …_binding_fk FOREIGN KEY (business_id, source_type, source_id, source_line_id, movement_kind)
    REFERENCES stock_source_bindings (business_id, source_type, source_id, source_line_id, movement_kind) ON DELETE RESTRICT
);
```
Registry rows (tag `P11-S…`, subject to §1.9):
```
INSERT INTO stock_movement_kinds (movement_kind, qty_sign, requires_reason, registered_by)
  VALUES ('repair_part_consumption','negative',false,'P11-S…');
INSERT INTO stock_source_types (source_type, registered_by) VALUES ('repair_part','P11-S…');
INSERT INTO inventory_operation_kinds (op_code, registered_by) VALUES ('repair.consume_parts','P11-S…'), …;
INSERT INTO inventory_operation_movement_kinds (op_code, movement_kind, registered_by)
  VALUES ('repair.consume_parts','repair_part_consumption','P11-S…');
```
A movement kind grants no authority; the op→kind row does (`0059:66-71`). `inventory_stock_source_guard_gaps()` (`0059:390`) reds the end-state assertion if the source type is registered without its guard, which is why the bridge and the registry rows land in the same migration.

### 5.4 Money — and the double-consumption correction
**The first draft was wrong here and the ruling returned it (§60).** It billed a repair by putting the consumed parts on the invoice as ordinary sale lines, *after* they had already left stock through the repair source. A tracked part on a sale line moves stock, so the same part would have been decremented twice and its COGS posted twice.

The corrected shape, per `TL-P11-R7`:
1. **One physical consumption**, under the repair part consumption authority of §5.3 — one movement, five-part identity, through the single writer.
2. **A preconsumed sale-line binding** carries the billing. New relation:
   `repair_part_billing_bindings` — PK `(business_id, repair_part_id)`, i.e. **one binding per consumption, enforced by the primary key rather than by a check in code** (condition 6); columns `ticket_id`, `variant_id`, `sale_id`, `sale_line_id` with a composite FK into the Phase 4 sale lines, `qty NUMERIC(18,4) NOT NULL`, and the tenant FK pair. **There is deliberately no quantity-claimed column** — see the v1 rule at the end of this section. Constraints that carry the **ten** conditions:
   - `qty` must equal the bound `repair_parts.qty` exactly — a deferred trigger refusing `repair.billing_qty_mismatch` (condition 4); not reconciled, refused;
   - a deferred trigger refusing `repair.billing_without_consumption` unless a `stock_source_bindings` row exists for that `repair_parts.id` under `source_type='repair_part'` and `movement_kind='repair_part_consumption'` (condition 7 — **the fail-open case**, and the one a red proof must plant: a binding created before the consumption exists re-opens §60 by another door);
   - a deferred trigger refusing `repair.billing_second_stock_effect` if any `stock_movements` row exists for that sale line (condition 8);
   - the business and tenant are pinned by composite FK on both sides (condition 5);
   - **the exact repair ticket** (condition 3a, PART 67): `ticket_id` is `NOT NULL` with a composite FK `(business_id, repair_part_id, ticket_id)` into `repair_parts (business_id, id, ticket_id)` — which is exactly what the `UNIQUE (business_id, id, ticket_id)` on `repair_parts` in §5.2 exists for. The ticket is therefore **structurally** the consumption's own ticket, not a value anyone supplies and a trigger compares; a mismatching ticket is unrepresentable. The deferred trigger `repair.billing_ticket_mismatch` remains as the second layer for the path where the FK is dropped in a future edit;
   - **the same customer / custody context, where applicable** (condition 3b, PART 67): a deferred trigger refusing `repair.billing_custody_context_mismatch` unless the bound sale's `customer_id` equals the ticket's `customer_id`. This is the condition whose absence no single-customer fixture can expose: without it, every other condition holds while a part consumed on one customer's device is billed on another customer's invoice. "Where applicable" is the walk-in case — a ticket with no customer bills only a sale with no customer, and the trigger states that symmetry rather than skipping the check when either side is null, because `NULL`-skipping is how this class of guard fails open;
   The binding is **written by the server from the repair record** (conditions 1 and 2): it is not a request field, and the request schema has no property for it — a refusal is not enough protection when `.strict()` can make the field unrepresentable.
   **v1 billing granularity (PART 67), and why it is a structure and not a rule:** **one consumption is billed at most once, for its full consumed quantity.** Partial split billing of a single consumption row is **not supported in v1**, because it needs a ledger recording how much of the consumption each binding claims and refusing the sum exceeding the whole — i.e. **a second allocation authority** next to the Phase 4 one for payments and credits, and two authorities over "how much of this has been applied" is two truths. The structure is therefore unable to express a partial claim: PK `(business_id, repair_part_id)` admits one row per consumption and there is **no `qty_claimed` column**, so `qty` can only equal the consumption's `qty` (`repair.billing_qty_mismatch`). A business that must bill half consumes half — a real inventory fact — rather than claiming half of one. Partial billing, if ever wanted, is a later phase with an allocation ledger of its own, never a column added here.
3. **Revenue, AR and cash still go through the sales authority**, unchanged. No repair receivable, no repair payment, no repair credit, no repair balance.
3a. **The deposit (PART 69, `P11-AL-22`), and the relation that is deliberately absent.** A customer deposit taken **before** the final repair invoice is **not** a sale, **not** a paid invoice and **not** a repair-owned money balance. It is received and later applied through the **sealed Phase 4 unapplied customer payment / customer credit liability authority**, applied to the repair sale by the **canonical payment/credit allocation**. So this patch request creates **no deposit relation at all** — no `repair_deposits`, no amount column on any repair relation, nothing with `balance`, `prepayment` or `advance` in its name. Four prohibitions, each closing the shortcut that would otherwise be built: no repair-specific deposit ledger (a second place customer money is owed, and two balances for one liability drift the first time one is written without the other); no fake sale and no fake paid invoice at intake (revenue before anything was sold, and an invoice no sale line explains); **no allocation to a nonexistent invoice** — the allocation target is a committed invoice, and a repair ticket is not a receivable; and **no double AR reduction**. The repair ticket may *display* the customer's unapplied balance, read from the Phase 4 authority; a read, never a store. Until Phase 4's payment and credit contract seals, this flow is `WAITING_FOR_INTEGRATED_SURFACE` — the design is settled, the surface it binds to is not. Law `C-REP-04`.
4. **Labour is a service product** (`TL-P11-R6`), which **depends on a sealed Phase 10 `SERVICE` stock-effect capability**. Phase 11 does not own it, does not pre-empt it, and **registers nothing dead in Phase 10**; until it seals, repair labour is `BLOCKED`.
5. **Accounting Owner gate** (§62), before `repair_part_consumption` goes live: the debit account, the inventory credit, valuation from the canonical moving average, the correction/reversal path, and no duplicate COGS at invoice time. **Repairs author no journal logic.** The five things the owner must establish, named by PART 68: the **inventory credit**; the **correct expense / COGS / WIP debit according to the accepted accounting model**; the **moving-average valuation source**; the **correction / reversal path**; and **no invoice-time duplicate COGS**. **Phase 11 does not guess the debit**, not even as a default to be corrected later. If the current inventory posting map cannot represent repair consumption safely, this is an **Accounting-owner Contract Diff**, not a Phase 11 workaround.
   **Scope, stated because the first draft left it open (PART 68):** if the accounting model is **not yet settled**, **only this subfeature is blocked — not the rest of Phase 11 preparation.** Apparel, lot/expiry, serial tracking, custody, warranty and the billing binding's structure all proceed and may seal. What waits is the registration of `repair_part_consumption` and anything posting through it. The honest label is `BLOCKED` for that one item and unchanged for the phase (`P11-AL-24`).

### 5.5 Registry rows outside SQL
`features`: a repair key (`REPAIR_PACK`, mirroring the seeded `RESTAURANT_PACK`). `capabilities.ts`: a new `repairs` definition — named in the header comment at `:6` but absent from `DEFINITIONS`. `industry-profiles.ts`: a `repair` profile key. None of these is a migration except the `features` row.

---

## 6. RLS, verbatim shape

For each new relation, in the `0086` form (helpers wrapped in a scalar subselect so they evaluate once per query, `0086:346-370`):
```sql
REVOKE ALL ON <t> FROM PUBLIC;
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_membership ON <t>
  USING      ((SELECT app_bypass()) OR tenant_id = (SELECT nullif(app_tenant(), '')::uuid))
  WITH CHECK ((SELECT app_bypass()) OR tenant_id = (SELECT nullif(app_tenant(), '')::uuid));

CREATE POLICY business_isolation ON <t> AS RESTRICTIVE
  USING      ((SELECT app_bypass()) OR current_user = 'daftar_inventory_internal' OR business_id = (SELECT nullif(app_business(), '')::uuid))
  WITH CHECK ((SELECT app_bypass()) OR business_id = (SELECT nullif(app_business(), '')::uuid));

CREATE POLICY inventory_internal_read ON <t>
  FOR SELECT TO daftar_inventory_internal USING (true);
```
Three rules that are not negotiable, each because a defect was found by breaking it:
1. The internal principal appears on the **restrictive `USING` only, never `WITH CHECK`** (`0059:300-310`) — read admission must never become a write path.
2. `WITH CHECK` on `tenant_membership` is kept and **measured**: own-tenant write admitted, other-tenant denied, unset GUC denied (`0086:248-281, 394-403, 614-647`).
3. No policy assembles a role name by concatenation (`0086:222, 588`).
For the catalog relations of §2, substitute `daftar_catalog_internal`; for §5's relations, both internal readers as required by the routines that read them — and the `*_internal_read` policy ships **in the same migration that forces RLS**, never later.

---

## 7. Grants

```
GRANT SELECT ON product_attribute_axes, product_attribute_values, product_matrix_axes,
                stock_lots, stock_lot_movements, stock_lot_levels,
                stock_serials, stock_serial_events,
                repair_tickets, repair_devices, repair_device_custody_events,
                repair_diagnoses, repair_parts, repair_status_events,
                warranties, warranty_claims
  TO daftar_app;

GRANT SELECT, INSERT ON stock_lots, stock_lot_movements, stock_serials, stock_serial_events TO daftar_inventory_internal;
GRANT SELECT, INSERT ON stock_lot_levels TO daftar_inventory_internal;
GRANT UPDATE (on_hand, last_movement_seq) ON stock_lot_levels TO daftar_inventory_internal;
GRANT UPDATE (custody_state, warehouse_id, last_event_seq) ON stock_serials TO daftar_inventory_internal;
GRANT SELECT, INSERT ON stock_source_bridge_repair_part TO daftar_inventory_internal;

GRANT EXECUTE ON FUNCTION catalog_generate_variant_matrix(UUID, TEXT[], TEXT[][]) TO daftar_app;
GRANT EXECUTE ON FUNCTION repair_open_ticket(…), repair_record_diagnosis(…), repair_consume_parts(…),
                          repair_change_status(…), repair_hand_back(…) TO daftar_app;
```
No `DELETE`, no `TRUNCATE`, no `EXECUTE` on `inventory_pick_lots`, `inventory_lot_fold`, `inventory_lot_verify`, `inventory_serial_assert_available` or any other internal definer — those are reached only from inside the authority. `daftar_app` writes no Phase 11 relation directly; every write goes through an entry routine that consumes an assertion.

---

## 8. End-state assertion (the migration's last statement)

One `DO $$ … $$` that refuses the migration unless, for the relations and routines it created:
1. every relation has `relrowsecurity` **and** `relforcerowsecurity`;
2. every relation has **at least** `tenant_membership`, a restrictive `business_isolation`, and — where an internal routine reads it — its `*_internal_read` policy. *Policy presence per relation, not just the flags* (the P4-S7 `42501` lesson);
3. `tenant_membership` still carries a `WITH CHECK`;
4. no policy names a role by concatenation;
5. `PUBLIC` holds no privilege on any of them;
6. every `SECURITY DEFINER` routine created here is owned by the right internal role and has `search_path = pg_catalog, public, pg_temp`;
7. no routine created here carries an `EXECUTE` grant to `PUBLIC` or to `daftar_app` unless it is in the §7 entry list;
8. **no column of any relation created here matches** `value_%_minor`, `valuation%`, `unit_cost%`, `avg_%` (law **L-P11-02**);
9. `inventory_stock_source_guard_gaps()` returns no row;
10. no `stock_source_types` row names a repair intake (**C-REP-01**);
11. `schema public` is no longer creatable by the internal role;
12. `products.expiry_policy`'s CHECK admits exactly one value (`TL-P11-R4`);
13. `repair_part_billing_bindings` is keyed one-per-consumption, and its three deferred triggers exist and are `DEFERRABLE INITIALLY DEFERRED` (`TL-P11-R7`);
14. no custody state named `abandoned` exists in any CHECK (§63);
15. **no column of any relation created here matches** `%amount%minor`, `%balance%`, `%deposit%`, `%paid%` or `%due%`, and **no relation created here has a name matching** `%deposit%`, `%prepayment%` or `%advance%` (law **C-REP-04**, PART 69 — the deposit relation that must not exist is checked for by its absence, not assumed absent);
16. `repair_part_billing_bindings` has **no column matching** `qty_claimed%` or `%_claimed%` and its primary key is exactly `(business_id, repair_part_id)` — the structural half of PART 67's v1 one-time full-quantity rule;
17. `warranties` carries its composite sale-line FK with both columns `NOT NULL`, its BEFORE UPDATE and BEFORE DELETE triggers exist, and `warranty_lifecycle_events`' CHECK admits exactly `('issued','cancelled','ended','voided-by-return')` with the three terminal states terminal (**C-WAR-01**, PART 70).
Failure raises `inventory.migration_end_state_invalid: <exact reason>` with `ERRCODE = 'P0001'`, on the `0059:552,579,603` / `0060:969` precedent.

---

## 9. The closed alternative — Option A, for the record only

*`TL-P11-R1` ruled Option B. This section is kept because a closed question should stay answered with its reasons attached, not deleted.* Had Option A been chosen:

§3 and §4 would have been withdrawn and replaced by a key-widening migration whose shape this document deliberately does **not** specify, because it is a different and much heavier piece of work and it should not be sketched casually. What the Migration Owner would be asked for instead, in outline, and what each item costs:
1. a sentinel lot (or an expression-based uniqueness over `COALESCE`) for every existing and future **untracked** variant — the untracked majority of the catalogue pays for the feature;
2. dropping and recreating the primary key of `stock_levels` and widening `stock_movements_key_seq_uq` and `stock_movements_identity_uq` — all structures the Phase 3 gate pins, in a frozen file that is never edited but whose shape is being changed by a later one;
3. a change to `inventory_apply_stock_movements`' request type **and** return shape — the hazard P4-S7 was rejected over;
4. a **ruling on OD-P11-01 and OD-P11-02 in the same breath**, because per-key costing makes per-lot and per-serial costing the law whether or not anyone writes it down;
5. a backfill, upgrade rehearsal and reconciliation for every existing business's valuation, and an answer to what the Phase 3 golden suite should now report.
That is why §1's preconditions name the ruling: this is not a shape that should be discovered halfway through an implementation.

---

## 10. What the Migration Owner is asked to decide

| id | question |
|---|---|
| MPR-01 | Is `stock_movement_kinds.registered_by`'s live CHECK already widened past `^P3-S[0-9]+$`? If not, widen it here or in a separate hygiene migration — Owner's call. |
| MPR-02 | `ALTER TYPE inventory_movement_request ADD ATTRIBUTE` versus a new named type plus an overload (§3.6 step 2). The `ALTER` keeps every existing caller's literal valid; the overload avoids touching a type the single writer binds to. |
| MPR-03 | Does the repair ticket number come from the existing `0075` numbering mechanism, as §5.2 assumes, or does it need its own sequence family? (§5.2 assumes the former and asks for no new mechanism.) |
| MPR-04 | Split or single file: four packs is a large migration. Recommended split — one per pack, allocated consecutively, catalog first, so each is independently rehearsable. |
| MPR-05 | **New, from PART 69.** The repair deposit binds to the Phase 4 **unapplied customer payment / customer credit liability** authority, which is not sealed. The Migration Owner is asked only to confirm that Phase 11 creates **no** money relation of its own; the deposit flow's own DDL — if it needs any at all beyond reads — belongs to whoever owns that Phase 4 contract, and this request deliberately specifies none. |
| MPR-06 | **New, from PART 70.** `warranties`' anchor is a composite FK into Phase 4 sale lines, which seals with S4. The Owner is asked whether the warranty pack is allocated **after** that seal (recommended: yes, so the FK is to frozen columns) or earlier with the FK added by a follow-up — the second being the path that leaves a window in which an unanchored warranty is representable, which is the thing `C-WAR-01` exists to prevent. |

## 11. Honest status

Nothing in this document has been applied to a cluster, parsed by PostgreSQL or executed. **A spec is design until a parser has had an opinion — and still design until the principal that will apply it has had one.** Every verdict is `UNMEASURED`. The first thing the implementing slice must do, before any TypeScript, is apply its own DDL as `daftar_migrator` on a throwaway cluster and read the errors; P4-S7 found eight of twelve defects that way, and two of them (a constraint trigger above its function, RLS forced with zero policies) are exactly the mistakes this shape invites.

---

## 12. The challenge round's additions, and what is owed to whom

The independent challenge at `1a8ba15` rejected Pack A on five defects of the
**removal direction** (`P11-LIVE-DDL-PROOF.md` §7). All five fixes are **inside Pack A's
own relations**, which is what the challenge said and what the implementation confirms:
**no authority is asked for anything to close them.** This section records what changed
and the one thing that is owed.

### 12.1 Inside Pack A, nothing owed

| what | why |
|---|---|
| the immutability check moved **above** the validator's early return, stated over the transition (`NOT OLD.is_base AND NEW.attributes IS DISTINCT FROM OLD.attributes`) | `'{}'` was the early return's own argument, so blanking a combination committed and split one matrix cell into two stock identities |
| the registry reads take **`FOR SHARE`** instead of `FOR KEY SHARE` | the archive path is a non-key UPDATE, which key-share does not conflict with |
| `product_matrix_axes_10_axis_in_use` is `BEFORE DELETE **OR UPDATE OF axis_code**` | a repointing UPDATE is the same removal |
| new `product_attribute_values_10_value_in_use`, `BEFORE DELETE OR UPDATE OF business_id, axis_code, value_code, status` | this registry had **no** guard on any removal path |
| new `product_attribute_axes_10_axis_in_use`, `BEFORE UPDATE OF business_id, axis_code, status` | the same for the axis registry; its DELETE is already structural (two `ON DELETE RESTRICT` FKs), its archive is not |
| the validator reads `product_attribute_axes.status`, and new `product_matrix_axes_20_axis_active` at trigger position **`_20_`** on that relation | `status` was a lifecycle on the value registry and decoration on the axis registry |

All three in-use guards are **`SECURITY INVOKER`**, deliberately: the `SECURITY DEFINER`
variant was implemented, measured, and **silently disabled every one of them** for a
principal with no session context, because `product_variants`' RESTRICTIVE
`business_isolation` policy cannot be satisfied by a definer's own `USING (true)`.
The end-state assertion now refuses a definer variant **by name**. See §7.2 of the proof
document for the measurement.

### 12.2 Owed to the Security Authority — one item, and it is not a privilege

**PR-SEC-P11-01.** The three in-use guards conclude from the **absence** of a row in
`product_variants`, read under the invoker's row-level security. That is sound while
`product_variants` is narrowed by **business and tenant only**, because the registry row
being removed is in that same scope. A later policy narrowing it by status, branch or
channel would convert each refusal into a **silent allow**, and no test would notice.

Pack A's end-state assertion pins the policy set on `product_variants` to exactly
`{business_isolation, tenant_membership}`, so the pack refuses to install over a set it
did not reason about — but an assertion inside a migration **cannot see a policy added
after it**. The Security Authority is asked to pin the same set in the **standing RLS
invariant check**, with a pointer to these three guards, so that a future policy on
`product_variants` fails that check instead of quietly weakening a catalogue invariant.

**This asks for no privilege and no policy change.** An earlier draft of this round
granted `daftar_catalog_internal` a column-scoped SELECT on `product_variants` and added
a role-scoped read policy to it, to support the definer design; both are **removed**.
Pack A changes no grant and no policy outside its own five relations.

### 12.3 Owed to the Migration Owner

**MPR-07.** The **five** triggers above occupy `product_matrix_axes._10_` / `._20_` /
**`._30_`** (the freeze guard of the ADD direction, added in the second challenge
round), `product_attribute_values._10_` and `product_attribute_axes._10_`, and the
validator on `product_variants` stays at `_40_`. The position of `._30_` is not
decorative: `._20_` (an archived axis cannot be registered) must fire **before** it, so
a merchant registering an archived axis on an empty grid is told which of the two
reasons applies. Pack A's end-state assertion asserts each trigger's **statement kinds**
(`INSERT` / `DELETE` / `UPDATE`) and not merely its existence, so a renumbering that
also changed an event would be caught. Trigger **name order decides firing order for the
same event**, so the Owner is asked to confirm these positions when the pack is
allocated — and, if another phase has since taken one, to renumber rather than let two
guards race for first.


---

## 13. The second challenge round, and what it owes whom

The round's three findings are answered in `P11-LIVE-DDL-PROOF.md` §9 and nothing
in it is owed to another authority: all three fixes are **inside Pack A**, and
Pack A still changes no grant and no policy outside its own five relations.

### 13.1 What changed inside the pack

| | |
|---|---|
| `product_matrix_axes_30_set_frozen` | new `BEFORE INSERT` guard, `SECURITY INVOKER`, refusing `catalog.matrix_axis_set_frozen` when the product already carries a non-base variant |
| `product_variants_40_matrix_canonical` | takes `pg_advisory_xact_lock_shared(hashtextextended(business_id || '/' || product_id, 0))` above its early return; the freeze guard takes the **exclusive** form of the same key. Nothing else about the function changed |
| `product_attribute_axes_10_axis_in_use` | second `EXISTS`, on `product_matrix_axes`, which is the relation its own comment was about |
| the end-state assertion | the trigger table asserts `INSERT` as well as `DELETE`/`UPDATE`; the DEFINER refusal reads `pg_trigger.tgfoid` instead of an unqualified `pg_proc.proname`; the PUBLIC-policy pin became a **policy-SET pin per relation** plus a named tautology list (§13.2) |

### 13.2 A recommendation measured and refused, for the second time in this phase

The challenger asked for the PUBLIC-policy assertion to pin on
`polroles = '{0}' AND polpermissive` alone, *"since the pack's own relations own no
legitimate PUBLIC policy at all"*. Implemented, the pack **refused itself**: every one
of its five relations carries exactly such a policy by design — its own permissive
`tenant_membership`, with no `TO` clause, so `polroles = '{0}'`. The thing the
assertion is about, *a qualifier true of every row*, is not decidable in SQL, so the
assertion pins the **policy set** (decidable, and it catches an added PUBLIC policy
whatever its qualifier) and keeps a named list of tautology spellings for the case the
set pin cannot see. `PR-SEC-P11-01` is unchanged and is still the only place the
residual can be answered.

### 13.3 Owed, unchanged

`PR-SEC-P11-01` (Security Authority), `MPR-07` (Migration Owner, now five triggers),
the Pack B grants and the registered operation code for lot configuration (inventory
authority), and `OD-P11-07` (the owner's). **No migration number exists**, and a third
challenge round is owed before anything here is signed.

---

## 14. The first challenge of Pack B, and what it owes whom

All four fixes are **inside Pack B** and nothing is owed to another authority.
Pack B still changes no grant and no policy outside its own three relations
and the two `products` columns the inventory authority owns — with one
addition that is its own function's ACL:

| | |
|---|---|
| `stock_lot_movement_conservation()` | a **fail-closed** arm (`inventory.lot_conservation_unverifiable`) replacing the `RETURN NULL` on an unreadable movement, the same rule one join further for an unreadable product, and the **cache-versus-key comparison** moved into reach of the side that moves the key |
| `inventory_lot_fold` | `REVOKE EXECUTE … FROM PUBLIC`; `GRANT EXECUTE` to `daftar_inventory_internal` and `daftar_app`; an explicit **tenant** half of its scope guard, and a refusal rather than a `0` for a lot it cannot see |
| `stock_lots_10_facts_frozen_once_moved` | new `BEFORE UPDATE OF expiry_date, produced_on, received_seq, lot_code_norm, lot_code_input` guard (`inventory.lot_facts_frozen`) |
| the end-state assertion | five more checks (17 total): PUBLIC holds no `EXECUTE` on the fold, the two principals do, the movement-side comparison and the fail-closed arm are both present in the installed function, and the lot-facts guard exists |

### 14.1 Two things measured that changed a fix

- **`FOR SHARE` is not available on an append-only relation.** The first
  version of the fail-closed read took a row lock, and the COMMIT then failed
  `permission denied for table stock_movements`: `SELECT … FOR SHARE` needs
  UPDATE-class privilege, which every writer of a ledger deliberately lacks. A
  refusal from the grant is not the law's refusal, so the lock was removed and
  the reason written into the file.
- **No runtime role holds `UPDATE` on `stock_lots`.** The lot-facts guard is
  therefore proved against the **owner**, and the merchant-facing correction
  path is a grant that does not exist yet. Recorded as a case, not as prose.

### 14.2 Owed to the Migration Owner (`MPR-08`)

`stock_lots` gains `stock_lots_10_facts_frozen_once_moved` at position `_10_`;
`products` keeps `_05_lot_config_authority` and `_40_lot_history_lock`; the two
conservation constraint triggers on `stock_movements` and
`stock_lot_movements` are unchanged in name. The Owner is asked to confirm
`_10_` on `stock_lots` at allocation, as `MPR-07` asks for Pack A's positions.

### 14.3 Still owed, unchanged

The Pack B grants and the registered operation code for lot configuration
(inventory authority); `PR-SEC-P11-01` (Security Authority); `OD-P11-07` (the
owner's). **Concurrency for Pack B is `UNMEASURED`** and the lock order
belongs with §3.6's cache writer when it lands — no document may read it as
cleared. **No migration number exists**, and a second challenge round for Pack
B is owed.

---

## 15. The third challenge round, and what it owes whom

Pack A `REJECT` at `0db9450`, Pack B `PASS-WITH-SCOPE` at `b7ee445`
(`P11-LIVE-DDL-PROOF.md` §11). Answered at `22e8e2d`.

### 15.1 What changed inside the packs

Nothing outside Phase 11's own relations and functions, and no grant or policy
on another phase's relation. Pack A: the validator's `'{}'` path now reads
`product_matrix_axes` before it returns (refusing
`catalog.variant_axis_set_incomplete` on a matrix product), the freeze guard's
read excludes archived variants, every catalogue lookup in the end-state
assertion is namespace-qualified, and the tautology test became the function
`catalog_policy_qual_is_tautology(text,text)` — **one new function, owner-only
EXECUTE, `REVOKE … FROM PUBLIC` in the file.** Pack B: the cache-side
conservation trigger gained the fail-closed arm its twin already had, and the
end-state assertion went from 17 to 19 checks.

### 15.2 Owed to the inventory authority — `MPR-09`, and it is a caller obligation

**`MPR-09`. A stock movement, and a stock key, must not be posted onto an
ARCHIVED variant.** Measured at this SHA: a `stock_levels` row with
`on_hand 5.0000` on an archived variant is accepted, and **no trigger on
`stock_levels` or `stock_movements` reads `product_variants.status`**
(`triggers_reading_variant_status = 0`).

Why it is owed to that authority rather than fixed here. Pack A's freeze guard
now treats an archived non-base variant as outside the grid, on the premise that
`product_variants_30_archive_requires_zero_stock` (0061) refuses archiving while
the variant holds stock or its movements do not net to zero. That premise is
about the moment of archiving, and nothing re-establishes it afterwards. Pack A
cannot close the gap in its own guard: a cross-table read of an **absent**
`stock_levels` row cannot be locked (the race C measurement in
`P11-LIVE-DDL-PROOF.md` §7), and taking a row lock on another phase's ledger is
what §10.2's `FOR SHARE` measurement warns against — a refusal from the grant
instead of from the law. So the obligation is stated where the writer is, as
`TL-P4-COORD-R62` states the DELETE-path lock order: **a caller obligation,
disclosed as a limit of Pack A's fix rather than claimed as covered.** If the
authority declines it, the alternative is the strict reading — archived variants
freeze the axis set too — and then the pack owes the merchant a different
recovery path, which is a design decision and not this document's to take.

### 15.3 Owed to the Migration Owner — `MPR-10`

**`MPR-10`. At assembly, the two packs should share ONE implementation of the
PUBLIC-policy arm.** Pack A's is now the three-form function
`catalog_policy_qual_is_tautology`; Pack B's is still the narrow form
(`polroles = '{0}' AND polpermissive AND pg_get_expr(polqual,…) = 'true'`),
because a pack must not require a function another pack creates, and at
preparation time the two files are applied independently. When the Owner
allocates the numbers and the files are ordered, the catalog pack's function
exists before the inventory pack runs, and Pack B's arm should call it. The
Owner is asked only to confirm the ORDER (catalog first, which `MPR-04` already
recommends); the edit itself is one line and belongs to whoever owns the
assembled file. **Pack B's expected policy set is three names, not two** —
`business_isolation`, `inventory_internal_read`, `tenant_membership` — because
the overlay copies the live `stock_levels`' role-scoped read policy, whose
qualifier is a deliberate `USING (true)` applied TO
`daftar_inventory_internal`; a tautology arm that ignored the role clause would
refuse the pack on a policy it installed on purpose.

### 15.4 Owed to the Security Authority — `PR-SEC-P11-01`, unchanged in substance, narrower in residual

The pin asked for there is unchanged. What changed is the size of what it has to
cover: the three sound forms now catch the literal spellings, any qualifier that
names no column (by evaluating it), and `(col IS NOT NULL)` over a `NOT NULL`
column. The residual handed to the standing RLS invariant check is a qualifier
true of every row that is none of those — and the two limits of the evaluation
form, written into the DDL: it runs under the installing session's settings, so
`app_bypass()` alone reads false at install, and a volatile function in a
qualifier is called once there rather than per row.

### 15.5 Still owed, unchanged

The Pack B grants and the registered operation code for lot configuration
(inventory authority); `MPR-07` (five Pack A trigger positions, now **six**:
`catalog_policy_qual_is_tautology` is a function and not a trigger, so the
positions are unchanged, and this line says so rather than leaving the Owner to
check); `MPR-08` (`stock_lots._10_`); `OD-P11-07` (the owner's). **Pack B's
concurrency is now measured for the writers that exist** — four races, both
arrival orders, 0 findings, in this pack's own harness — and what remains
`UNMEASURED` is a lawful cache writer that moves the cache without moving the
key, which no principal can be today; the lock order still belongs with §3.6's
writer. **No migration number exists**, and a FOURTH challenge round is owed on
both packs.

---

## 16. After the FOURTH independent challenge round

### 16.1 `MPR-09`, restated and narrower — a movement onto an ARCHIVED variant

**Unchanged in substance, corrected in premise.** Round 3 routed this as "the
inventory authority should refuse a movement posted onto an archived variant",
resting on the sentence *"an archived variant holds no stock, because 0061
refuses the transition to `archived` while its key holds stock"*. The fourth
challenge round showed that sentence is a fact about **the moment of
archiving**: 0061 tests it on the way in, and nothing re-tested it on the way
back, which is how the un-archive door existed at all.

Pack A now holds the catalogue side at COMMIT (the deferred grid-closure check,
`P11-LIVE-DDL-PROOF.md` §12.1), so the request to the inventory authority is
exactly this and no more: **`inventory_post_movement` and the stock command
refuse a movement or a stock key whose variant is `archived`.** Pack A cannot
close it from here, and the reason is now sharper than "a read of an absent row
cannot be locked": the transaction that creates the forbidden state writes only
the ledger, so it fires no trigger of this pack and there is nothing for a check
of ours to judge at that commit. Reading `stock_levels` from the deferred check
would not help.

### 16.2 `MPR-10` — now THREE routines to fold at assembly, not one

Each pack is applied alone, in its own transaction, so a pack may not require a
relation or a routine another pack created. That is why the following exist
twice, and why one implementation is the Migration Owner's work at assembly:

| in Pack A | in Pack B | what it is |
|---|---|---|
| `catalog_policy_qual_is_tautology(text,text)` | the inline PUBLIC-policy arm in Pack B's end-state | the tautology test. Pack A's now carries **four** forms; Pack B's relations have no qualifier test of their own at all, which is `P3-03` of the fourth round |
| `catalog_relation_column_is_notnull(text,text)` | — | the `attnotnull` lookup forms 3 and 4 rest on |
| `catalog_prosrc_uncommented(text)` | `inventory_prosrc_uncommented(text)` | the comment stripper the end-state text pins read through, because `pg_get_functiondef` includes comments (`P3-01` of the fourth round) |

At assembly: one tautology test, available to **both** packs' relations and
carrying form 4 (`(col = col)` / `NOT (col <> col)` over an `attnotnull`
column, `col IS NOT DISTINCT FROM col` unconditionally); one comment stripper;
one `attnotnull` lookup. Pack B's role-scoped permissive qualifier is currently
defended only by its NAME in the policy-set pin, and that is what the folded
test closes.

### 16.3 `PR-SEC-P11-01` — the residual is four named spellings

Form 4 moves `(business_id = business_id)` out of the residual and into the
decided set, which matters because that spelling was **measured as a working
cross-tenant hole in both directions** with the policy name left intact, so the
set pin could not see it. What the standing RLS invariant check still has to
cover is asserted as still-passing in the proof suite, so the list cannot grow
quietly: `(business_id = ANY (ARRAY[…]))` over the full key set,
`(business_id IS NOT NULL OR business_id IS NULL)`, the `coalesce` form, and
any qualifier true of every row that none of the four forms sees.

### 16.4 Still owed, unchanged

The Pack B grants and the registered operation code for lot configuration
(inventory authority); `MPR-07` (the Pack A trigger positions — **now seven**:
the four `_90_grid_closed` constraint triggers are at position 90 on their four
relations, after every existing `_NN_` guard on each, and they are constraint
triggers so their firing order among themselves does not matter);
`MPR-08` (`stock_lots._10_`); `OD-P11-07` (the owner's). **No migration number
exists**, and a FIFTH challenge round is owed on both packs.

### 16.5 `MPR-10` — the eighth item, from the seventh challenge round (`R7-06`)

**`TRUNCATE` on the four relations the Pack A grid laws govern.** A
`FOR EACH STATEMENT` trigger fires for `INSERT`, `UPDATE` and `DELETE`;
`TRUNCATE` is a **separate trigger event** this pack does not declare. So a
role holding `TRUNCATE` could empty a product's grid with **no** write identity
recorded, **no** deferred closure check queued, and nothing for unanimity to
judge.

What this pack does about it, and the limit of it:

* an end-state assertion refuses the install if any **non-owner** role holds
  `TRUNCATE` on `product_variants`, `product_matrix_axes`,
  `product_attribute_axes` or `product_attribute_values`
  (`catalog.migration_end_state_invalid`);
* `PA7-S9` reads the refusal **by name** as `daftar_app`
  (`permission denied for table product_variants`);
* nothing in this pack or in frozen history grants it.

**What is `UNMEASURED` and is the Migration Owner's to decide:** what would
happen if a later migration *did* grant it. The two options are to declare
`TRUNCATE` triggers on the four relations (which also changes behaviour under
`pg_restore` and logical-replica apply, the same trade-off as the
`ENABLE ALWAYS TRIGGER` item in this list), or to keep the privilege out by
assertion only and accept that the assertion is the whole defence. This pack
makes no claim about the first and ships the second.

`MPR-10` therefore now carries **eight** items: the shared tautology test, the
comment stripper, form 4 for Pack B's relations, the `session_replication_role`
decision, the `ENABLE ALWAYS TRIGGER` question, ledger pruning, whether the
ledger should be `UNLOGGED`, and this one. **No migration number exists**, and
an EIGHTH challenge round is owed on Pack A.
