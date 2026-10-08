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

- `catalog_attributes_canonical(p_attributes JSONB) RETURNS JSONB` — IMMUTABLE, migrator-created, internal-owned: refuses a non-object, a nested value, a non-text value, a key outside the axis regex; returns the object with keys sorted so two equal maps have one text form.
- `product_variants_30_matrix_canonical()` — `BEFORE INSERT OR UPDATE` trigger on `product_variants`, `SECURITY INVOKER`, migrator-owned (the `products_20_unit_history_lock()` family, `0060:683`). It refuses:
  | refusal | when |
  |---|---|
  | `catalog.variant_attributes_shape_invalid` | `attributes` is not a flat `{axis_code: value_code}` object |
  | `catalog.variant_axis_unregistered` | an axis key is not in `product_matrix_axes` for that product |
  | `catalog.variant_axis_value_unregistered` | a value is not an active `product_attribute_values` row of that axis |
  | `catalog.variant_axis_set_incomplete` | the key set is not **exactly** the product's registered axis set (no partial combination) |
  | `catalog.variant_matrix_base_conflict` | `is_base` is true and `attributes <> '{}'` — restates `product_variants_base_shape_ck` (`0053:137-139`) at a nicer error |
  | `catalog.variant_matrix_locked` | the variant has a `stock_levels` row and its `attributes` are being changed (the `product_variants_20_stock_identity_lock()` precedent, `0060:683`) |

- `CREATE UNIQUE INDEX product_variants_matrix_uq ON product_variants (business_id, product_id, (catalog_attributes_canonical(attributes))) WHERE NOT is_base AND status <> 'archived';` — one variant per combination. (An expression index needs an IMMUTABLE function; that is why §2.4's first object is IMMUTABLE and why it may not read a table. The registry checks therefore live in the trigger, and the index enforces only uniqueness of the canonical form. Stated here so a reviewer does not expect the index to do the trigger's job.)

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
- `products_30_lot_history_lock()` — `BEFORE UPDATE` trigger refusing `inventory.lot_tracking_history_locked` when `track_lot` changes and any variant of the product already has a `stock_levels` row (P11-AL-16).

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
| `warranties` | `(business_id, id)` | `sale_id`, `sale_line_id` composite FK into the Phase 4 sale lines (**bound only when Phase 4 is sealed**), `serial_id NULL`, `starts_on`, `ends_on` with `CHECK (ends_on >= starts_on)`, `source IN ('business','vendor')`, `terms_translations JSONB` |
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
   `repair_part_billing_bindings` — PK `(business_id, repair_part_id)`, i.e. **one binding per consumption, enforced by the primary key rather than by a check in code** (condition 6); columns `sale_id`, `sale_line_id` with a composite FK into the Phase 4 sale lines, `qty NUMERIC(18,4) NOT NULL`, and the tenant FK pair. Constraints that carry the eight conditions:
   - `qty` must equal the bound `repair_parts.qty` exactly — a deferred trigger refusing `repair.billing_qty_mismatch` (condition 4); not reconciled, refused;
   - a deferred trigger refusing `repair.billing_without_consumption` unless a `stock_source_bindings` row exists for that `repair_parts.id` under `source_type='repair_part'` and `movement_kind='repair_part_consumption'` (condition 7 — **the fail-open case**, and the one a red proof must plant: a binding created before the consumption exists re-opens §60 by another door);
   - a deferred trigger refusing `repair.billing_second_stock_effect` if any `stock_movements` row exists for that sale line (condition 8);
   - the business and tenant are pinned by composite FK on both sides (condition 5).
   The binding is **written by the server from the repair record** (conditions 1 and 2): it is not a request field, and the request schema has no property for it — a refusal is not enough protection when `.strict()` can make the field unrepresentable.
3. **Revenue, AR and cash still go through the sales authority**, unchanged. No repair receivable, no repair payment, no repair credit, no repair balance; an intake deposit is a Phase 4 customer payment or customer credit.
4. **Labour is a service product** (`TL-P11-R6`), which **depends on a sealed Phase 10 `SERVICE` stock-effect capability**. Phase 11 does not own it, does not pre-empt it, and **registers nothing dead in Phase 10**; until it seals, repair labour is `BLOCKED`.
5. **Accounting Owner gate** (§62), before `repair_part_consumption` goes live: the debit account, the inventory credit, valuation from the canonical moving average, the correction/reversal path, and no duplicate COGS at invoice time. **Repairs author no journal logic.** If the current inventory posting map cannot represent repair consumption safely, this is an **Accounting-owner Contract Diff**, not a Phase 11 workaround.

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
14. no custody state named `abandoned` exists in any CHECK (§63).
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

## 11. Honest status

Nothing in this document has been applied to a cluster, parsed by PostgreSQL or executed. **A spec is design until a parser has had an opinion — and still design until the principal that will apply it has had one.** Every verdict is `UNMEASURED`. The first thing the implementing slice must do, before any TypeScript, is apply its own DDL as `daftar_migrator` on a throwaway cluster and read the errors; P4-S7 found eight of twelve defects that way, and two of them (a constraint trigger above its function, RLS forced with zero policies) are exactly the mistakes this shape invites.
