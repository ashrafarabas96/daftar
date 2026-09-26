-- 0059_inventory_stock_ledger.sql
-- P3-S2, part 1 — the immutable stock ledger's SCHEMA: the three registries,
-- the ledger and its per-key cache, the source bindings, the negative-deficit
-- detail tables, their append-only and retention triggers, row security,
-- grants, and the catalogue-only source-guard discovery function
-- (P3-AL-06, P3-AL-07, P3-AL-09, P3-AL-14, P3-AL-41, P3-AL-49, P3-AL-51;
-- docs/PHASE_3_S2_CONTRACT.md §2.2, §2.3, §2.4, §2.6, §2.7).
--
-- ── What this file creates ──────────────────────────────────────────────
--
--   * `stock_movement_kinds`, `stock_source_types`,
--     `inventory_operation_movement_kinds` — closed, migration-extended
--     registries. Only the ten Phase 3 movement kinds are seeded (A-05). A
--     movement kind grants no authority: authority is the op→kind mapping,
--     which stays EMPTY here, so after this file no invctl/1 operation can
--     write a single movement.
--   * `stock_levels` — the per-(business, warehouse, variant) cache. It is
--     derived state, written only by the trusted primitive of 0060 in the
--     same statement as the movement it reflects (A-15), and rebuildable
--     exactly from the ledger (P3-AL-07).
--   * `stock_movements` — the immutable ledger. Every stored value is an
--     integer in base minor units; every snapshot cost is exact at 10
--     decimal places; quantities are NUMERIC(18,4).
--   * `stock_source_bindings` — exactly the movement's five-part identity,
--     with a DEFERRABLE INITIALLY DEFERRED foreign key in each direction
--     (P3-AL-51 §A). A half-written pair cannot survive COMMIT.
--   * `negative_inventory_deficits` / `negative_deficit_coverages` — the
--     negative-inventory detail shape (A-06). Nothing writes them at P3-S2.
--   * `stock_ledger_append_only()` / `stock_levels_retain()` — migrator-owned
--     INVOKER trigger functions that refuse UPDATE/DELETE on the append-only
--     tables and DELETE on the cache, for every writer including the owner.
--   * `inventory_stock_source_guard_gaps()` — the catalogue check every
--     migration that registers a source type runs in its end state
--     (P3-AL-51 §B).
--
-- This file transfers NO ownership, so it takes no CREATE bracket. The
-- trusted routines, the unit-history lock and the zero-stock trigger are
-- 0060's.
--
-- Migrations 0000-0058 are FROZEN and untouched.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The registries (§2.2).
--
-- No row security (like `inventory_operation_kinds`, 0054): they carry no
-- business data. No runtime grant: nothing at runtime has a need to read
-- them, and referential-integrity checks run with the owner's rights.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE stock_movement_kinds (
  movement_kind   TEXT PRIMARY KEY CHECK (movement_kind ~ '^[a-z][a-z0-9_]{1,39}$'),
  qty_sign        TEXT NOT NULL CHECK (qty_sign IN ('positive', 'negative', 'either', 'zero')),
  requires_reason BOOLEAN NOT NULL,
  registered_by   TEXT NOT NULL CHECK (registered_by ~ '^P3-S[0-9]+$')
);
REVOKE ALL ON stock_movement_kinds FROM PUBLIC;

CREATE TABLE stock_source_types (
  source_type   TEXT PRIMARY KEY CHECK (source_type ~ '^[a-z][a-z0-9_]{1,39}$'),
  registered_by TEXT NOT NULL CHECK (registered_by ~ '^P3-S[0-9]+$')
);
REVOKE ALL ON stock_source_types FROM PUBLIC;

-- Least authority is carried by the PAIR (A-28): there is deliberately no
-- UNIQUE (movement_kind), because a movement kind is physical semantics and
-- several commands may legitimately produce the same kind.
CREATE TABLE inventory_operation_movement_kinds (
  op_code       TEXT NOT NULL REFERENCES inventory_operation_kinds (op_code),
  movement_kind TEXT NOT NULL REFERENCES stock_movement_kinds (movement_kind),
  registered_by TEXT NOT NULL CHECK (registered_by ~ '^P3-S[0-9]+$'),
  PRIMARY KEY (op_code, movement_kind)
);
REVOKE ALL ON inventory_operation_movement_kinds FROM PUBLIC;

-- The ten Phase 3 kinds (A-05). `qty_sign` is checked by the primitive:
-- positive ⇒ qty > 0, negative ⇒ qty < 0, either ⇒ qty <> 0, zero ⇒ qty = 0.
INSERT INTO stock_movement_kinds (movement_kind, qty_sign, requires_reason, registered_by) VALUES
  ('purchase',                           'positive', false, 'P3-S2'),
  ('supplier_return',                    'negative', false, 'P3-S2'),
  ('adjustment',                         'either',   true,  'P3-S2'),
  ('damage',                             'negative', true,  'P3-S2'),
  ('transfer_out',                       'negative', false, 'P3-S2'),
  ('transfer_in',                        'positive', false, 'P3-S2'),
  ('stocktake',                          'either',   false, 'P3-S2'),
  ('inventory_opening',                  'positive', false, 'P3-S2'),
  ('negative_inventory_cost_adjustment', 'zero',     false, 'P3-S2'),
  ('purchase_reversal',                  'negative', false, 'P3-S2');

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The cache (§2.3, P3-AL-07).
--
-- One row per stock key, created by the primitive with
-- INSERT … ON CONFLICT DO NOTHING and then locked FOR UPDATE — never
-- check-then-insert. `on_hand = 0 ⇒ valuation = 0` is enforced at COMMIT by
-- the deferred constraint trigger of 0060 (A-22), not by a row CHECK: a
-- receipt followed by its catch-up is transiently zero-with-value.
--
-- Deliberately no `reserved` and no `available` column (L:1274).
-- ─────────────────────────────────────────────────────────────────────────
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
REVOKE ALL ON stock_levels FROM PUBLIC;

-- The P3-AL-41 disable rule looks up every key of a product's variants.
CREATE INDEX stock_levels_variant_idx ON stock_levels (business_id, variant_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. The ledger (§2.3, A-19).
--
-- `stock_seq` is the per-key order and the ONLY order anything reads the
-- ledger in (P3-AL-06); `created_at` is observability. The five-part
-- identity is NOT deferrable, so a duplicate is refused at the statement.
-- A movement references its cache row by an immediate FK, so a business,
-- warehouse or variant with history cannot be deleted (A-20).
-- ─────────────────────────────────────────────────────────────────────────
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
  CONSTRAINT stock_movements_identity_uq UNIQUE (business_id, source_type, source_id, source_line_id, movement_kind),
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
REVOKE ALL ON stock_movements FROM PUBLIC;

-- The unit-history lock asks "does any movement of this product exist".
CREATE INDEX stock_movements_variant_idx ON stock_movements (business_id, variant_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 4. The source bindings (P3-AL-51 §A).
--
-- The binding carries exactly the movement's five-part identity, so both
-- directions reference a declared candidate key, and both are deferred to
-- COMMIT (the AL-01 shape of journal_entries ⇄ accounting_source_bindings).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE stock_source_bindings (
  tenant_id      UUID NOT NULL,
  business_id    UUID NOT NULL,
  source_type    TEXT NOT NULL REFERENCES stock_source_types (source_type),
  source_id      UUID NOT NULL,
  source_line_id UUID NOT NULL,
  movement_kind  TEXT NOT NULL REFERENCES stock_movement_kinds (movement_kind),
  PRIMARY KEY (business_id, source_type, source_id, source_line_id, movement_kind),
  CONSTRAINT stock_source_bindings_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id)
);
REVOKE ALL ON stock_source_bindings FROM PUBLIC;

ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_binding_fk
  FOREIGN KEY (business_id, source_type, source_id, source_line_id, movement_kind)
  REFERENCES stock_source_bindings (business_id, source_type, source_id, source_line_id, movement_kind)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE stock_source_bindings ADD CONSTRAINT stock_source_bindings_movement_fk
  FOREIGN KEY (business_id, source_type, source_id, source_line_id, movement_kind)
  REFERENCES stock_movements (business_id, source_type, source_id, source_line_id, movement_kind)
  DEFERRABLE INITIALLY DEFERRED;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Negative-inventory detail (A-06, DM §10ب as corrected by L:490-501).
--
-- `deficit_seq` has no counter column: `inventory_next_deficit_seq` (0060)
-- answers max + 1 under the stock-key lock, and the UNIQUE backs it (A-07).
-- The coverage's FK to its adjustment header is added by P3-S4, the slice
-- that creates the header.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE negative_inventory_deficits (
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
  status                           TEXT NOT NULL CHECK (status IN ('open', 'partially_covered', 'closed')),
  created_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  CONSTRAINT negative_inventory_deficits_seq_uq      UNIQUE (business_id, warehouse_id, variant_id, deficit_seq),
  CONSTRAINT negative_inventory_deficits_variant_uq  UNIQUE (business_id, id, variant_id),
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
REVOKE ALL ON negative_inventory_deficits FROM PUBLIC;

-- FIFO consumption reads open deficits per key in deficit_seq order (DM:297).
CREATE INDEX negative_inventory_deficits_fifo_idx
  ON negative_inventory_deficits (business_id, warehouse_id, variant_id, status, deficit_seq);

CREATE TABLE negative_deficit_coverages (
  tenant_id                        UUID NOT NULL,
  business_id                      UUID NOT NULL,
  id                               UUID NOT NULL DEFAULT gen_random_uuid(),
  adjustment_id                    UUID NOT NULL,
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
REVOKE ALL ON negative_deficit_coverages FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. Append-only and retention (§2.3, §2.4, A-20).
--
-- Migrator-owned INVOKER trigger functions (the 0056 precedent of
-- `warehouses_home_branch_immutable`): they read nothing and decide nothing
-- from who is writing, so they need no elevated owner. They refuse EVERY
-- writer, the schema owner included. TRUNCATE is deliberately unguarded
-- (E-24): it is a DDL-class owner operation the test harness relies on.
-- Future bridges attach `stock_ledger_append_only()` as
-- `stock_bridge_immutable_<source_type>`.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION stock_ledger_append_only() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'inventory.ledger_immutable: % is append-only', TG_TABLE_NAME USING ERRCODE = 'P0001';
END;
$$;

COMMENT ON FUNCTION stock_ledger_append_only() IS
  'P3-S2 (A-20). BEFORE UPDATE OR DELETE row trigger function: refuses every change to an append-only stock ledger table (stock_movements, stock_source_bindings, negative_deficit_coverages, and every stock_source_bridge_<st>) with inventory.ledger_immutable, for every writer including the owner. No EXECUTE grant.';

CREATE OR REPLACE FUNCTION stock_levels_retain() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'inventory.stock_level_not_deletable: a stock key, once created, is retained with its history' USING ERRCODE = 'P0001';
END;
$$;

COMMENT ON FUNCTION stock_levels_retain() IS
  'P3-S2 (A-20). BEFORE DELETE row trigger function on stock_levels: a stock key is never deleted (inventory.stock_level_not_deletable), for every writer including the owner. No EXECUTE grant.';

REVOKE ALL ON FUNCTION stock_ledger_append_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_levels_retain() FROM PUBLIC;

CREATE TRIGGER stock_movements_append_only
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_append_only();
CREATE TRIGGER stock_source_bindings_append_only
  BEFORE UPDATE OR DELETE ON stock_source_bindings
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_append_only();
CREATE TRIGGER negative_deficit_coverages_append_only
  BEFORE UPDATE OR DELETE ON negative_deficit_coverages
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_append_only();
CREATE TRIGGER stock_levels_retain
  BEFORE DELETE ON stock_levels
  FOR EACH ROW EXECUTE FUNCTION stock_levels_retain();

-- ─────────────────────────────────────────────────────────────────────────
-- 7. Row security (§2.6, A-18).
--
-- The 0052 UUID style. `stock_movements` and `stock_levels` additionally
-- admit the inventory principal for READ ONLY — a FOR SELECT policy plus
-- the restrictive USING admission — so the unit-history lock, the P3-AL-41
-- disable rule, the verifier and the zero-stock check see every row they
-- judge, whatever scope the writing session carries (the 0042 precedent
-- for the accounting principal). The restrictive WITH CHECK deliberately
-- omits it: the admission can never become a write path out of scope.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_levels FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_source_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_source_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE negative_inventory_deficits ENABLE ROW LEVEL SECURITY;
ALTER TABLE negative_inventory_deficits FORCE ROW LEVEL SECURITY;
ALTER TABLE negative_deficit_coverages ENABLE ROW LEVEL SECURITY;
ALTER TABLE negative_deficit_coverages FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_membership ON stock_movements
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation ON stock_movements AS RESTRICTIVE
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON stock_movements
  FOR SELECT TO daftar_inventory_internal USING (true);

CREATE POLICY tenant_membership ON stock_levels
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation ON stock_levels AS RESTRICTIVE
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON stock_levels
  FOR SELECT TO daftar_inventory_internal USING (true);

CREATE POLICY tenant_membership ON stock_source_bindings
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation ON stock_source_bindings AS RESTRICTIVE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);

CREATE POLICY tenant_membership ON negative_inventory_deficits
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation ON negative_inventory_deficits AS RESTRICTIVE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);

CREATE POLICY tenant_membership ON negative_deficit_coverages
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation ON negative_deficit_coverages AS RESTRICTIVE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);

-- ─────────────────────────────────────────────────────────────────────────
-- 8. Grants — default deny (§2.6, A-01, A-17).
--
--   daftar_app                 SELECT on stock_movements and stock_levels
--                              only; no DML anywhere; no registry.
--   daftar_inventory_internal  the A-01 set: the owner of the 0060
--                              primitive must hold the DML its definer
--                              rights run with. No DELETE, no TRUNCATE, and
--                              UPDATE of exactly the four cache columns.
--   everyone else              nothing.
-- ─────────────────────────────────────────────────────────────────────────
GRANT SELECT ON stock_movements, stock_levels TO daftar_app;

GRANT SELECT, INSERT ON stock_movements TO daftar_inventory_internal;
GRANT SELECT, INSERT ON stock_levels TO daftar_inventory_internal;
GRANT UPDATE (on_hand, valuation_base_minor, avg_unit_cost_base_minor, last_stock_seq) ON stock_levels TO daftar_inventory_internal;
GRANT INSERT ON stock_source_bindings TO daftar_inventory_internal;
GRANT SELECT ON stock_movement_kinds, inventory_operation_movement_kinds, negative_inventory_deficits TO daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 9. Source-guard discovery (§2.3, P3-AL-51 §B).
--
-- Read-only and catalogue-only. For every registered source type it reports
-- each guard that is missing: the bridge table, its RESTRICT FK to the
-- binding, its RESTRICT FK to the real domain line, its append-only trigger,
-- and the deferred binding-side constraint trigger with an internal-owned
-- DEFINER function. Every migration that registers a source type (S3+)
-- calls it in its end state; a non-empty answer refuses that migration.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION inventory_stock_source_guard_gaps()
RETURNS TABLE (source_type TEXT, missing TEXT)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_type   TEXT;
  v_bridge REGCLASS;
  v_bind   REGCLASS := 'public.stock_source_bindings'::regclass;
BEGIN
  FOR v_type IN SELECT t.source_type FROM stock_source_types t ORDER BY t.source_type LOOP
    v_bridge := to_regclass('public.stock_source_bridge_' || v_type);
    IF v_bridge IS NULL THEN
      source_type := v_type; missing := 'bridge'; RETURN NEXT;
    ELSE
      IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                      WHERE c.contype = 'f' AND c.conrelid = v_bridge AND c.confrelid = v_bind AND c.confdeltype = 'r') THEN
        source_type := v_type; missing := 'bridge_binding_fk'; RETURN NEXT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                      WHERE c.contype = 'f' AND c.conrelid = v_bridge AND c.confrelid <> v_bind
                        AND c.confrelid <> v_bridge AND c.confdeltype = 'r') THEN
        source_type := v_type; missing := 'bridge_line_fk'; RETURN NEXT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                      WHERE g.tgrelid = v_bridge AND NOT g.tgisinternal
                        AND g.tgname = 'stock_bridge_immutable_' || v_type AND g.tgenabled <> 'D') THEN
        source_type := v_type; missing := 'bridge_immutable'; RETURN NEXT;
      END IF;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                     JOIN pg_proc p ON p.oid = g.tgfoid
                     JOIN pg_roles r ON r.oid = p.proowner
                    WHERE g.tgrelid = v_bind
                      AND g.tgname = 'stock_binding_requires_' || v_type
                      AND g.tgconstraint <> 0 AND g.tgdeferrable AND g.tginitdeferred AND g.tgenabled <> 'D'
                      AND r.rolname = 'daftar_inventory_internal' AND p.prosecdef) THEN
      source_type := v_type; missing := 'binding_trigger'; RETURN NEXT;
    END IF;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION inventory_stock_source_guard_gaps() IS
  'P3-AL-51 §B. Catalogue-only discovery: for every stock_source_types row, reports each missing guard (bridge, bridge_binding_fk, bridge_line_fk, bridge_immutable, binding_trigger). Every migration that registers a source type asserts it returns no row. Migrator-owned INVOKER; no EXECUTE grant.';

REVOKE ALL ON FUNCTION inventory_stock_source_guard_gaps() FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────
-- 10. Refuse to commit unless the end state is exactly right (0059-E).
--
-- `has_*_privilege`, never `information_schema` (0053:265-267).
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_role     TEXT;
  v_table    TEXT;
  v_priv     TEXT;
  v_detail   TEXT;
  v_n        INTEGER;
  v_expected TEXT[];
  v_actual   TEXT[];
  c_tables   CONSTANT TEXT[] := ARRAY['stock_movement_kinds', 'stock_source_types', 'inventory_operation_movement_kinds',
                                      'stock_levels', 'stock_movements', 'stock_source_bindings',
                                      'negative_inventory_deficits', 'negative_deficit_coverages'];
  c_business CONSTANT TEXT[] := ARRAY['stock_levels', 'stock_movements', 'stock_source_bindings',
                                      'negative_inventory_deficits', 'negative_deficit_coverages'];
  c_privs    CONSTANT TEXT[] := ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
BEGIN
  -- (1) The movement-kind seed is exactly the ten Phase 3 kinds.
  SELECT array_agg(k.movement_kind || ':' || k.qty_sign || ':' || k.requires_reason::text || ':' || k.registered_by
                   ORDER BY k.movement_kind) INTO v_actual
  FROM stock_movement_kinds k;
  IF v_actual IS DISTINCT FROM ARRAY[
       'adjustment:either:true:P3-S2',
       'damage:negative:true:P3-S2',
       'inventory_opening:positive:false:P3-S2',
       'negative_inventory_cost_adjustment:zero:false:P3-S2',
       'purchase:positive:false:P3-S2',
       'purchase_reversal:negative:false:P3-S2',
       'stocktake:either:false:P3-S2',
       'supplier_return:negative:false:P3-S2',
       'transfer_in:positive:false:P3-S2',
       'transfer_out:negative:false:P3-S2'] THEN
    RAISE EXCEPTION 'inventory.authority_leak: stock_movement_kinds is not exactly the ten P3-S2 seed rows';
  END IF;

  -- (2) No source type and no op→kind mapping: no operation can write a
  --     movement because this migration ran.
  IF EXISTS (SELECT 1 FROM stock_source_types) OR EXISTS (SELECT 1 FROM inventory_operation_movement_kinds) THEN
    RAISE EXCEPTION 'inventory.authority_leak: stock_source_types and inventory_operation_movement_kinds must be empty after 0059';
  END IF;

  -- (3) Row security is enabled AND forced on the five business tables.
  SELECT string_agg(t, ', ' ORDER BY t) INTO v_detail
  FROM unnest(c_business) AS t
  WHERE NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE n.nspname = 'public' AND c.relname = t AND c.relkind = 'r'
                       AND c.relrowsecurity AND c.relforcerowsecurity);
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'inventory.authority_leak: row security is not enabled and forced on: %', v_detail;
  END IF;

  -- (4) No runtime role and not PUBLIC holds any write-class privilege on any
  --     S2 table or registry, at table or column level.
  FOREACH v_role IN ARRAY ARRAY['daftar_app','daftar_platform','daftar_worker','daftar_identity','daftar_resolver','daftar_provisioner','daftar_reconciler','public'] LOOP
    FOREACH v_table IN ARRAY c_tables LOOP
      FOREACH v_priv IN ARRAY ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
        IF has_table_privilege(v_role, v_table, v_priv) THEN
          RAISE EXCEPTION 'inventory.authority_leak: % holds % on %', v_role, v_priv, v_table;
        END IF;
      END LOOP;
      FOREACH v_priv IN ARRAY ARRAY['INSERT','UPDATE','REFERENCES'] LOOP
        IF has_any_column_privilege(v_role, v_table, v_priv) THEN
          RAISE EXCEPTION 'inventory.authority_leak: % holds column-level % on %', v_role, v_priv, v_table;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  -- (5) daftar_app reads exactly the ledger and the cache; every other
  --     runtime role and PUBLIC reads nothing.
  SELECT array_agg(t ORDER BY t) INTO v_actual
  FROM unnest(c_tables) AS t WHERE has_table_privilege('daftar_app', t, 'SELECT') OR has_any_column_privilege('daftar_app', t, 'SELECT');
  IF v_actual IS DISTINCT FROM ARRAY['stock_levels', 'stock_movements'] THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_app must read exactly stock_levels and stock_movements, found %', v_actual;
  END IF;
  FOREACH v_role IN ARRAY ARRAY['daftar_platform','daftar_worker','daftar_identity','daftar_resolver','daftar_provisioner','daftar_reconciler','public'] LOOP
    FOREACH v_table IN ARRAY c_tables LOOP
      IF has_table_privilege(v_role, v_table, 'SELECT') OR has_any_column_privilege(v_role, v_table, 'SELECT') THEN
        RAISE EXCEPTION 'inventory.authority_leak: % may read % and has no requirement to', v_role, v_table;
      END IF;
    END LOOP;
  END LOOP;

  -- (6) The internal principal holds exactly the A-01 set.
  v_expected := ARRAY[
    'inventory_operation_movement_kinds:SELECT',
    'negative_inventory_deficits:SELECT',
    'stock_levels:INSERT',
    'stock_levels:SELECT',
    'stock_movement_kinds:SELECT',
    'stock_movements:INSERT',
    'stock_movements:SELECT',
    'stock_source_bindings:INSERT'];
  SELECT array_agg(t || ':' || p ORDER BY t || ':' || p) INTO v_actual
  FROM unnest(c_tables) AS t CROSS JOIN unnest(c_privs) AS p
  WHERE has_table_privilege('daftar_inventory_internal', t, p);
  IF v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_inventory_internal table privileges are not exactly the A-01 set, found %', v_actual;
  END IF;
  SELECT array_agg(a.attname::text ORDER BY a.attname) INTO v_actual
  FROM pg_attribute a
  WHERE a.attrelid = 'stock_levels'::regclass AND a.attnum > 0 AND NOT a.attisdropped
    AND has_column_privilege('daftar_inventory_internal', 'stock_levels', a.attname, 'UPDATE');
  IF v_actual IS DISTINCT FROM ARRAY['avg_unit_cost_base_minor', 'last_stock_seq', 'on_hand', 'valuation_base_minor'] THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_inventory_internal may UPDATE stock_levels column(s) %, not exactly the four cache columns', v_actual;
  END IF;
  FOREACH v_table IN ARRAY c_tables LOOP
    IF v_table <> 'stock_levels' AND has_any_column_privilege('daftar_inventory_internal', v_table, 'UPDATE') THEN
      RAISE EXCEPTION 'inventory.authority_leak: daftar_inventory_internal holds column-level UPDATE on %', v_table;
    END IF;
    IF has_any_column_privilege('daftar_inventory_internal', v_table, 'REFERENCES') THEN
      RAISE EXCEPTION 'inventory.authority_leak: daftar_inventory_internal holds REFERENCES on %', v_table;
    END IF;
    IF NOT (v_table = ANY (ARRAY['stock_levels', 'stock_movements', 'stock_source_bindings']))
       AND has_any_column_privilege('daftar_inventory_internal', v_table, 'INSERT') THEN
      RAISE EXCEPTION 'inventory.authority_leak: daftar_inventory_internal holds column-level INSERT on %', v_table;
    END IF;
    IF NOT (v_table = ANY (ARRAY['stock_levels', 'stock_movements', 'stock_movement_kinds', 'inventory_operation_movement_kinds', 'negative_inventory_deficits']))
       AND has_any_column_privilege('daftar_inventory_internal', v_table, 'SELECT') THEN
      RAISE EXCEPTION 'inventory.authority_leak: daftar_inventory_internal holds column-level SELECT on %', v_table;
    END IF;
  END LOOP;

  -- (7) Both P3-AL-51 directions exist over the five columns, deferred to
  --     COMMIT; the identity itself is a plain, immediate UNIQUE.
  SELECT count(*) INTO v_n
  FROM pg_constraint c
  WHERE c.contype = 'f' AND c.condeferrable AND c.condeferred AND cardinality(c.conkey) = 5
    AND ((c.conname = 'stock_movements_binding_fk' AND c.conrelid = 'stock_movements'::regclass
          AND c.confrelid = 'stock_source_bindings'::regclass)
      OR (c.conname = 'stock_source_bindings_movement_fk' AND c.conrelid = 'stock_source_bindings'::regclass
          AND c.confrelid = 'stock_movements'::regclass));
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'inventory.authority_leak: both P3-AL-51 binding directions must be five-column DEFERRABLE INITIALLY DEFERRED FKs, found %', v_n;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conname = 'stock_movements_identity_uq' AND c.conrelid = 'stock_movements'::regclass
                    AND c.contype = 'u' AND NOT c.condeferrable AND cardinality(c.conkey) = 5) THEN
    RAISE EXCEPTION 'inventory.authority_leak: stock_movements_identity_uq must be a non-deferrable five-column UNIQUE';
  END IF;

  -- (8) The append-only and retention triggers exist by name, enabled.
  SELECT count(*) INTO v_n
  FROM pg_trigger g
  WHERE NOT g.tgisinternal AND g.tgenabled = 'O'
    AND ((g.tgname = 'stock_movements_append_only' AND g.tgrelid = 'stock_movements'::regclass
          AND g.tgfoid = 'stock_ledger_append_only()'::regprocedure)
      OR (g.tgname = 'stock_source_bindings_append_only' AND g.tgrelid = 'stock_source_bindings'::regclass
          AND g.tgfoid = 'stock_ledger_append_only()'::regprocedure)
      OR (g.tgname = 'negative_deficit_coverages_append_only' AND g.tgrelid = 'negative_deficit_coverages'::regclass
          AND g.tgfoid = 'stock_ledger_append_only()'::regprocedure)
      OR (g.tgname = 'stock_levels_retain' AND g.tgrelid = 'stock_levels'::regclass
          AND g.tgfoid = 'stock_levels_retain()'::regprocedure));
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'inventory.authority_leak: the append-only and retention triggers are not all present and enabled, found %', v_n;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.oid IN ('stock_ledger_append_only()'::regprocedure, 'stock_levels_retain()'::regprocedure,
                              'inventory_stock_source_guard_gaps()'::regprocedure)
                AND (p.prosecdef
                     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
                     OR has_function_privilege('public', p.oid, 'EXECUTE'))) THEN
    RAISE EXCEPTION 'inventory.authority_leak: a 0059 function is SECURITY DEFINER, unpinned or PUBLIC-executable';
  END IF;

  -- (9) Every registered source type is fully guarded (vacuously today).
  IF EXISTS (SELECT 1 FROM inventory_stock_source_guard_gaps()) THEN
    RAISE EXCEPTION 'inventory.source_guard_missing: a registered stock source type lacks its bridge or binding guard';
  END IF;

  -- (10) The cache carries no reservation column (L:1274).
  IF EXISTS (SELECT 1 FROM pg_attribute a
              WHERE a.attrelid = 'stock_levels'::regclass AND a.attnum > 0 AND NOT a.attisdropped
                AND a.attname IN ('reserved', 'available')) THEN
    RAISE EXCEPTION 'inventory.authority_leak: stock_levels carries a reservation column';
  END IF;

  -- (11) The internal read admission exists on exactly the ledger and the
  --      cache, FOR SELECT, for the internal principal only.
  SELECT array_agg(c.relname::text ORDER BY c.relname) INTO v_actual
  FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
  WHERE p.polname = 'inventory_internal_read' AND c.relname = ANY (c_tables);
  IF v_actual IS DISTINCT FROM ARRAY['stock_levels', 'stock_movements'] THEN
    RAISE EXCEPTION 'inventory.authority_leak: inventory_internal_read must exist on exactly stock_levels and stock_movements, found %', v_actual;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
              WHERE p.polname = 'inventory_internal_read' AND c.relname IN ('stock_levels', 'stock_movements')
                AND (p.polcmd <> 'r' OR NOT p.polpermissive
                     OR p.polroles IS DISTINCT FROM ARRAY[(SELECT r.oid FROM pg_roles r WHERE r.rolname = 'daftar_inventory_internal')]::oid[])) THEN
    RAISE EXCEPTION 'inventory.authority_leak: inventory_internal_read is not a permissive FOR SELECT policy for daftar_inventory_internal only';
  END IF;

  -- (12) This file took no ownership-transfer authority, and none survived.
  IF has_schema_privilege('daftar_inventory_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_inventory_internal holds CREATE on schema public';
  END IF;
END $$;

COMMENT ON TABLE stock_movement_kinds IS
  'P3-S2 (A-05). Closed registry of stock movement kinds and their quantity-sign and reason rules. Extended only by migrations. A kind grants no authority: authority is inventory_operation_movement_kinds.';
COMMENT ON TABLE stock_source_types IS
  'P3-AL-51. Closed registry of stock source types. A row may exist only together with its bridge and binding guard (inventory_stock_source_guard_gaps).';
COMMENT ON TABLE inventory_operation_movement_kinds IS
  'P3-S2 (A-28, L:1992). Which invctl/1 operation may write which movement kind. The primitive refuses any pair not listed here. Extended only by the migration of the slice that owns the operation.';
COMMENT ON TABLE stock_levels IS
  'P3-AL-07. Derived per-key cache, written only by inventory_apply_stock_movements in the same statement as its movement; rebuildable exactly from stock_movements by stock_seq. Never deleted. on_hand = 0 implies valuation 0 at COMMIT.';
COMMENT ON TABLE stock_movements IS
  'P3-AL-06/P3-AL-09. The immutable stock ledger. Append-only for every writer; ordered by stock_seq per key, never by created_at. Values are integer base minor units.';
COMMENT ON TABLE stock_source_bindings IS
  'P3-AL-51 §A. Exactly one row per movement five-part identity, bound to its movement by deferred FKs in both directions. Append-only.';
COMMENT ON TABLE negative_inventory_deficits IS
  'P3-AL-08 / A-06. Negative-inventory deficits per stock key, sequenced by deficit_seq under the stock-key lock.';
COMMENT ON TABLE negative_deficit_coverages IS
  'P3-AL-08 / A-06 (L:498-500). Append-only coverage detail of a deficit by a later receipt. adjustment_id is bound to its header by P3-S4.';
