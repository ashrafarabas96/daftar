-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE 11 · PACK A — APPAREL / VARIANT MATRIX  (capability `catalog.variant-matrix`)
--
-- UNNUMBERED BY LAW. This file carries no migration number and no
-- number-shaped name. One Migration Owner allocates, at promotion, from the
-- live prefix. This is the scratch proof the Master Continuous Mission §18
-- requires: "execute unnumbered DDL for a scratch proof, then the Owner's
-- allocation at promotion".
--
-- Applied as `daftar_migrator` on a throw-away cluster over the frozen
-- prefix applied UNMODIFIED. Nothing here edits, reads around, or depends on
-- a byte of 0000-0079.
--
-- Catalog only. No inventory relation, no movement kind, no source type, no
-- money column, no assertion consumption. Every size/colour combination is
-- an ordinary `product_variants` row and therefore already an ordinary stock
-- key, which is why this pack needs no overlay and is built first.
--
-- CORRECTED AGAINST THE LIVE CATALOGUE (four findings, recorded in
-- P11-LIVE-DDL-PROOF.md):
--   1. Business-authored names are per-entity translation ROW tables keyed
--      (business_id, <entity>_id, locale) — `category_translations`,
--      `product_translations` — NOT a `translations JSONB` column. `products`
--      has no such column at all, so the spec's cited precedent did not
--      exist. Following the spec would have created a second pattern for one
--      truth.
--   2. Catalog relations carry NO denormalized `tenant_id`; their
--      `tenant_membership` is the EXISTS-over-`businesses` form. The
--      tenant_id + composite-FK shape is the inventory / Phase-4 convention.
--   3. Trigger position `_30_` on `product_variants` is already taken by
--      `product_variants_30_archive_requires_zero_stock`; the canonicalizer
--      is `_40_` so it fires after the existing authority and archive guards.
--   4. There is no catalog entry-routine precedent: `daftar_catalog_internal`
--      owns exactly one routine, a trigger function, and
--      `inventory_operation_kinds` is an INVENTORY registry. A catalog
--      routine consuming an inventory assertion would borrow the inventory
--      authority for a catalog write. Matrix generation is therefore an
--      ordinary authorized application command over existing catalog writes;
--      the database enforces closure, canonicality and uniqueness.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Axis registry ────────────────────────────────────────────────────────
CREATE TABLE product_attribute_axes (
  business_id UUID NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  axis_code   TEXT NOT NULL,
  sort_order  INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, axis_code),
  CONSTRAINT product_attribute_axes_code_ck   CHECK (axis_code ~ '^[a-z][a-z0-9_]{0,31}$'),
  CONSTRAINT product_attribute_axes_status_ck CHECK (status IN ('active','archived')),
  CONSTRAINT product_attribute_axes_sort_uq   UNIQUE (business_id, sort_order)
);

CREATE TABLE product_attribute_axis_translations (
  business_id UUID NOT NULL,
  axis_code   TEXT NOT NULL,
  locale      TEXT NOT NULL,
  name        TEXT NOT NULL,
  PRIMARY KEY (business_id, axis_code, locale),
  CONSTRAINT product_attribute_axis_translations_axis_fk
    FOREIGN KEY (business_id, axis_code) REFERENCES product_attribute_axes (business_id, axis_code) ON DELETE CASCADE,
  CONSTRAINT product_attribute_axis_translations_locale_check CHECK (locale IN ('ar','en','tr')),
  CONSTRAINT product_attribute_axis_translations_name_check   CHECK (char_length(name) >= 1 AND char_length(name) <= 200)
);

-- ── 2. Axis value registry ──────────────────────────────────────────────────
CREATE TABLE product_attribute_values (
  business_id UUID NOT NULL,
  axis_code   TEXT NOT NULL,
  value_code  TEXT NOT NULL,
  sort_order  INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, axis_code, value_code),
  CONSTRAINT product_attribute_values_axis_fk
    FOREIGN KEY (business_id, axis_code) REFERENCES product_attribute_axes (business_id, axis_code) ON DELETE RESTRICT,
  CONSTRAINT product_attribute_values_code_ck   CHECK (value_code ~ '^[a-z][a-z0-9_]{0,31}$'),
  CONSTRAINT product_attribute_values_status_ck CHECK (status IN ('active','archived')),
  CONSTRAINT product_attribute_values_sort_uq   UNIQUE (business_id, axis_code, sort_order)
);

CREATE TABLE product_attribute_value_translations (
  business_id UUID NOT NULL,
  axis_code   TEXT NOT NULL,
  value_code  TEXT NOT NULL,
  locale      TEXT NOT NULL,
  name        TEXT NOT NULL,
  PRIMARY KEY (business_id, axis_code, value_code, locale),
  CONSTRAINT product_attribute_value_translations_value_fk
    FOREIGN KEY (business_id, axis_code, value_code)
      REFERENCES product_attribute_values (business_id, axis_code, value_code) ON DELETE CASCADE,
  CONSTRAINT product_attribute_value_translations_locale_check CHECK (locale IN ('ar','en','tr')),
  CONSTRAINT product_attribute_value_translations_name_check   CHECK (char_length(name) >= 1 AND char_length(name) <= 200)
);

-- ── 3. Which axes a product's matrix uses ───────────────────────────────────
CREATE TABLE product_matrix_axes (
  business_id   UUID NOT NULL,
  product_id    UUID NOT NULL,
  axis_code     TEXT NOT NULL,
  axis_position SMALLINT NOT NULL,
  PRIMARY KEY (business_id, product_id, axis_code),
  CONSTRAINT product_matrix_axes_product_fk
    FOREIGN KEY (business_id, product_id) REFERENCES products (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT product_matrix_axes_axis_fk
    FOREIGN KEY (business_id, axis_code) REFERENCES product_attribute_axes (business_id, axis_code) ON DELETE RESTRICT,
  -- A bounded matrix: an unbounded cross product is a denial of service on
  -- the catalogue, paid for by the business that opens the screen.
  CONSTRAINT product_matrix_axes_position_ck CHECK (axis_position BETWEEN 1 AND 4),
  CONSTRAINT product_matrix_axes_position_uq UNIQUE (business_id, product_id, axis_position)
);

-- ── 4. Canonical form of product_variants.attributes ────────────────────────
-- IMMUTABLE and therefore unable to read a table: it decides SHAPE and
-- canonical TEXT only. Registry membership is the trigger's job. Stated so a
-- reviewer does not expect the unique index below to do the trigger's work.
CREATE FUNCTION catalog_attributes_canonical(p_attributes JSONB)
RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- Guarded in this order on purpose: jsonb_each RAISES on a scalar rather
  -- than returning no rows, so a single SQL expression that deconstructs
  -- first and type-checks in a CASE cannot work. Found by applying it.
  IF jsonb_typeof(p_attributes) <> 'object' THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each(p_attributes) e
              WHERE jsonb_typeof(e.value) <> 'string'
                 OR e.key !~ '^[a-z][a-z0-9_]{0,31}$'
                 OR (e.value #>> '{}') !~ '^[a-z][a-z0-9_]{0,31}$') THEN
    RETURN NULL;
  END IF;
  -- MEASURED, and it corrected this function: jsonb normalizes object key
  -- order ITSELF (by key length, then bytewise), so two maps written in
  -- different orders are already the same jsonb value and the same index
  -- key. An earlier draft aggregated with ORDER BY k to "canonicalize" the
  -- order; the proof run showed the stored value as {"size": .., "color": ..}
  -- — not sorted — while the reversed-key uniqueness case still hit the
  -- index. The ORDER BY was inert and the property held for a different
  -- reason. Validation is this function's whole job; the canonical form is
  -- the input, unchanged.
  RETURN p_attributes;
END;
$$;

COMMENT ON FUNCTION catalog_attributes_canonical(JSONB) IS
  'Phase 11 Pack A. Returns the attribute map when it is a flat {axis_code: value_code} object, else NULL. jsonb canonicalizes key order itself, so this function validates shape only. IMMUTABLE: index-usable, table-blind.';

CREATE FUNCTION product_variants_40_matrix_canonical()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_canonical JSONB;
  v_axis      TEXT;
  v_value     TEXT;
  v_registered INTEGER;
  v_supplied   INTEGER;
BEGIN
  -- NO base-variant refusal here, and its absence is the finding.
  -- The spec proposed `catalog.variant_matrix_base_conflict`. The proof run
  -- showed it is unreachable: `product_variants_10_base_variant_authority`
  -- (position 10, so it fires first) already refuses ANY base-variant write
  -- from every principal but `daftar_inventory_internal`, and refuses a
  -- non-base insert FROM that principal — and the CHECK constraint
  -- `product_variants_base_shape_ck` makes `is_base AND attributes <> '{}'`
  -- impossible regardless. A refusal with no reachable caller is dead code,
  -- dead code cannot be mutation-tested, and this project has already paid
  -- for learning that the answer is structural rather than another case.
  -- So Pack A adds nothing here and the existing guard is proved instead.
  IF NEW.is_base OR NEW.attributes = '{}'::jsonb THEN
    RETURN NEW;
  END IF;

  v_canonical := catalog_attributes_canonical(NEW.attributes);
  IF v_canonical IS NULL THEN
    RAISE EXCEPTION 'catalog.variant_attributes_shape_invalid: attributes must be a flat {axis_code: value_code} object'
      USING ERRCODE = 'P0001';
  END IF;

  -- Identity-shaping facts stop being editable once stock exists: history
  -- recorded against one combination cannot be reinterpreted as another.
  -- The precedent is product_variants_20_stock_identity_lock (0060).
  IF TG_OP = 'UPDATE'
     AND NEW.attributes <> OLD.attributes
     AND EXISTS (SELECT 1 FROM stock_levels sl
                            WHERE sl.business_id = OLD.business_id
                              AND sl.variant_id  = OLD.id) THEN
    RAISE EXCEPTION 'catalog.variant_matrix_locked: this variant has stock history; its attributes are fixed'
      USING ERRCODE = 'P0001';
  END IF;

  FOR v_axis, v_value IN SELECT e.key, e.value #>> '{}' FROM jsonb_each(v_canonical) e LOOP
    IF NOT EXISTS (SELECT 1 FROM product_matrix_axes ma
                              WHERE ma.business_id = NEW.business_id
                                AND ma.product_id  = NEW.product_id
                                AND ma.axis_code   = v_axis) THEN
      RAISE EXCEPTION 'catalog.variant_axis_unregistered: axis % is not an axis of this product''s matrix', v_axis
        USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM product_attribute_values av
                              WHERE av.business_id = NEW.business_id
                                AND av.axis_code   = v_axis
                                AND av.value_code  = v_value
                                AND av.status      = 'active') THEN
      RAISE EXCEPTION 'catalog.variant_axis_value_unregistered: % is not an active value of axis %', v_value, v_axis
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  SELECT count(*) INTO v_registered FROM product_matrix_axes ma
   WHERE ma.business_id = NEW.business_id
     AND ma.product_id  = NEW.product_id;
  SELECT count(*) INTO v_supplied FROM jsonb_each(v_canonical);

  -- No partial combination. A variant naming two of three axes is not a
  -- smaller matrix cell; it is a cell that cannot be addressed.
  IF v_registered = 0 OR v_supplied <> v_registered THEN
    RAISE EXCEPTION 'catalog.variant_axis_set_incomplete: attributes must name exactly the product''s % registered axes', v_registered
      USING ERRCODE = 'P0001';
  END IF;

  NEW.attributes := v_canonical;
  RETURN NEW;
END;
$$;

CREATE TRIGGER product_variants_40_matrix_canonical
  BEFORE INSERT OR UPDATE OF attributes, is_base, product_id ON product_variants
  FOR EACH ROW EXECUTE FUNCTION product_variants_40_matrix_canonical();

-- One variant per combination. The trigger has already rewritten
-- `attributes` into canonical form, so the expression is a canonicalization
-- of an already-canonical value: stable, and still correct if a future path
-- writes a differently-ordered map.
CREATE UNIQUE INDEX product_variants_matrix_uq
  ON product_variants (business_id, product_id, (catalog_attributes_canonical(attributes)))
  WHERE NOT is_base AND status <> 'archived' AND attributes <> '{}'::jsonb;

-- ── 5. Security: the catalog's own shape, copied, not reinvented ────────────
REVOKE ALL ON product_attribute_axes, product_attribute_axis_translations,
              product_attribute_values, product_attribute_value_translations,
              product_matrix_axes FROM PUBLIC;

ALTER TABLE product_attribute_axes               ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_attribute_axes               FORCE  ROW LEVEL SECURITY;
ALTER TABLE product_attribute_axis_translations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_attribute_axis_translations  FORCE  ROW LEVEL SECURITY;
ALTER TABLE product_attribute_values             ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_attribute_values             FORCE  ROW LEVEL SECURITY;
ALTER TABLE product_attribute_value_translations ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_attribute_value_translations FORCE  ROW LEVEL SECURITY;
ALTER TABLE product_matrix_axes                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_matrix_axes                  FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_membership ON product_attribute_axes
  USING (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = product_attribute_axes.business_id AND b.tenant_id::text = app_tenant()))
  WITH CHECK (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = product_attribute_axes.business_id AND b.tenant_id::text = app_tenant()));
CREATE POLICY business_isolation ON product_attribute_axes AS RESTRICTIVE
  USING (app_bypass() OR business_id::text = app_business())
  WITH CHECK (app_bypass() OR business_id::text = app_business());

CREATE POLICY tenant_membership ON product_attribute_axis_translations
  USING (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = product_attribute_axis_translations.business_id AND b.tenant_id::text = app_tenant()))
  WITH CHECK (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = product_attribute_axis_translations.business_id AND b.tenant_id::text = app_tenant()));
CREATE POLICY business_isolation ON product_attribute_axis_translations AS RESTRICTIVE
  USING (app_bypass() OR business_id::text = app_business())
  WITH CHECK (app_bypass() OR business_id::text = app_business());

CREATE POLICY tenant_membership ON product_attribute_values
  USING (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = product_attribute_values.business_id AND b.tenant_id::text = app_tenant()))
  WITH CHECK (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = product_attribute_values.business_id AND b.tenant_id::text = app_tenant()));
CREATE POLICY business_isolation ON product_attribute_values AS RESTRICTIVE
  USING (app_bypass() OR business_id::text = app_business())
  WITH CHECK (app_bypass() OR business_id::text = app_business());

CREATE POLICY tenant_membership ON product_attribute_value_translations
  USING (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = product_attribute_value_translations.business_id AND b.tenant_id::text = app_tenant()))
  WITH CHECK (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = product_attribute_value_translations.business_id AND b.tenant_id::text = app_tenant()));
CREATE POLICY business_isolation ON product_attribute_value_translations AS RESTRICTIVE
  USING (app_bypass() OR business_id::text = app_business())
  WITH CHECK (app_bypass() OR business_id::text = app_business());

CREATE POLICY tenant_membership ON product_matrix_axes
  USING (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = product_matrix_axes.business_id AND b.tenant_id::text = app_tenant()))
  WITH CHECK (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = product_matrix_axes.business_id AND b.tenant_id::text = app_tenant()));
CREATE POLICY business_isolation ON product_matrix_axes AS RESTRICTIVE
  USING (app_bypass() OR business_id::text = app_business())
  WITH CHECK (app_bypass() OR business_id::text = app_business());

GRANT SELECT, INSERT, UPDATE, DELETE ON product_attribute_axes, product_attribute_axis_translations,
                                        product_attribute_values, product_attribute_value_translations,
                                        product_matrix_axes TO daftar_app;

-- ── 6. Feature registry row (the registry is an FK target) ──────────────────
INSERT INTO features (key, description)
  VALUES ('VARIANT_MATRIX','Apparel variant matrices')
  ON CONFLICT (key) DO NOTHING;

-- ── 7. End-state assertion: the migration refuses itself rather than warn ───
DO $$
DECLARE
  r RECORD;
  v_rels TEXT[] := ARRAY['product_attribute_axes','product_attribute_axis_translations',
                         'product_attribute_values','product_attribute_value_translations',
                         'product_matrix_axes'];
  v_name TEXT;
BEGIN
  FOREACH v_name IN ARRAY v_rels LOOP
    SELECT c.relrowsecurity, c.relforcerowsecurity INTO r
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = v_name;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'catalog.migration_end_state_invalid: relation % was not created', v_name USING ERRCODE='P0001';
    END IF;
    IF NOT (r.relrowsecurity AND r.relforcerowsecurity) THEN
      RAISE EXCEPTION 'catalog.migration_end_state_invalid: % lacks ENABLE+FORCE row level security', v_name USING ERRCODE='P0001';
    END IF;
    IF (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
         WHERE c.relname = v_name AND p.polname = 'tenant_membership' AND p.polwithcheck IS NOT NULL) <> 1 THEN
      RAISE EXCEPTION 'catalog.migration_end_state_invalid: % lacks tenant_membership WITH CHECK', v_name USING ERRCODE='P0001';
    END IF;
    IF (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
         WHERE c.relname = v_name AND p.polname = 'business_isolation' AND NOT p.polpermissive) <> 1 THEN
      RAISE EXCEPTION 'catalog.migration_end_state_invalid: % lacks a restrictive business_isolation', v_name USING ERRCODE='P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.role_table_grants
                          WHERE table_name = v_name AND grantee = 'PUBLIC') THEN
      RAISE EXCEPTION 'catalog.migration_end_state_invalid: PUBLIC holds a privilege on %', v_name USING ERRCODE='P0001';
    END IF;
    -- L-P11-02: no money anywhere in this pack, including a column a comment
    -- calls report-only.
    IF EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
                          WHERE c.relname = v_name AND a.attnum > 0 AND NOT a.attisdropped
                            AND (a.attname LIKE 'value%minor' OR a.attname LIKE 'valuation%'
                              OR a.attname LIKE 'unit_cost%' OR a.attname LIKE 'avg_%'
                              OR a.attname LIKE '%amount%minor' OR a.attname LIKE '%balance%'
                              OR a.attname LIKE '%price%' OR a.attname LIKE '%deposit%')) THEN
      RAISE EXCEPTION 'catalog.migration_end_state_invalid: % carries a monetary column', v_name USING ERRCODE='P0001';
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_trigger WHERE tgname = 'product_variants_40_matrix_canonical' AND NOT tgisinternal) <> 1 THEN
    RAISE EXCEPTION 'catalog.migration_end_state_invalid: the canonicalization trigger is absent' USING ERRCODE='P0001';
  END IF;
  IF (SELECT count(*) FROM pg_class WHERE relname = 'product_variants_matrix_uq' AND relkind = 'i') <> 1 THEN
    RAISE EXCEPTION 'catalog.migration_end_state_invalid: the matrix uniqueness index is absent' USING ERRCODE='P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM features WHERE key = 'VARIANT_MATRIX') THEN
    RAISE EXCEPTION 'catalog.migration_end_state_invalid: the VARIANT_MATRIX feature key is unregistered' USING ERRCODE='P0001';
  END IF;
  -- This pack touches no inventory truth: it must have registered nothing there.
  IF EXISTS (SELECT 1 FROM stock_source_types WHERE source_type LIKE '%matrix%' OR source_type LIKE '%apparel%')
     OR EXISTS (SELECT 1 FROM stock_movement_kinds WHERE movement_kind LIKE '%matrix%' OR movement_kind LIKE '%apparel%') THEN
    RAISE EXCEPTION 'catalog.migration_end_state_invalid: Pack A registered an inventory source type or movement kind' USING ERRCODE='P0001';
  END IF;
END;
$$;
