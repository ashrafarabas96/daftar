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

-- ── 0. The baseline the end-state assertion compares against ──────────────
-- Taken before the pack's first statement so that "this pack registered
-- nothing in inventory" is a comparison of COUNTS and not a LIKE pattern
-- over names (finding P3-10).
--
-- Held in session settings rather than in a temporary table, and the reason
-- was measured: `daftar_migrator` has no TEMP privilege on the database
-- ("permission denied to create temporary tables"), and an absence law is
-- not worth widening the migration principal's rights for. A custom setting
-- needs no privilege, leaves nothing behind when the session ends, and is
-- unreadable by any other session. The assertion in section 7 refuses the
-- pack when it is missing, so the law cannot be silently skipped.
SELECT set_config('p11.baseline_src',  (SELECT count(*)::text FROM stock_source_types),        false),
       set_config('p11.baseline_kind', (SELECT count(*)::text FROM stock_movement_kinds),      false),
       set_config('p11.baseline_op',   (SELECT count(*)::text FROM inventory_operation_kinds), false);

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
  -- ── Immutability FIRST, and the reason is the independent challenge ────
  -- Finding P0-01, measured at 1a8ba15: this check used to sit BELOW the
  -- early return, so `UPDATE … SET attributes = '{}'::jsonb` never reached
  -- it. Measured on a variant holding on_hand 5.0000: the combination was
  -- blanked and committed; the partial unique index excludes a blanked row
  -- (`WHERE … attributes <> '{}'`), so a second variant for the SAME cell
  -- was then accepted. One matrix cell with two stock identities — the
  -- blanked row holding the stock and the whole movement history, the new
  -- row being the addressable cell. Option B's costing key is
  -- (business, warehouse, variant), so that is a silent split of one cell's
  -- cost and quantity: the exact shape TL-P11-R1 rests on not happening.
  --
  -- The law is therefore stated over the TRANSITION, not over the new value:
  -- a non-base variant's attributes never change, to anything, including to
  -- '{}' and from '{}'. It is checked before any early return and before
  -- shape validation, because '{}' is a valid shape.
  --
  -- The structural half the challenge asks for — CHECK (is_base OR
  -- attributes <> '{}') — is NOT available, and the measurement says why: a
  -- product that registers no axes legitimately carries non-base variants
  -- whose attributes are '{}', which is every non-apparel product in the
  -- catalogue (proved by the case "a plain product's non-base variant may
  -- carry no combination at all"). The condition that separates the two is
  -- "does this product register axes", which is cross-table and therefore
  -- not expressible in a CHECK. Recorded as a limit of the fix rather than
  -- claimed as done.
  IF TG_OP = 'UPDATE' AND NOT OLD.is_base AND NEW.attributes IS DISTINCT FROM OLD.attributes THEN
    RAISE EXCEPTION 'catalog.variant_matrix_immutable: a variant''s combination is its identity and never changes; archive it and create the right one'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.is_base OR NEW.attributes = '{}'::jsonb THEN
    RETURN NEW;
  END IF;

  v_canonical := catalog_attributes_canonical(NEW.attributes);
  IF v_canonical IS NULL THEN
    RAISE EXCEPTION 'catalog.variant_attributes_shape_invalid: attributes must be a flat {axis_code: value_code} object'
      USING ERRCODE = 'P0001';
  END IF;

  -- ── The combination is immutable, and the reason is a measured race ──────
  -- The first draft made this conditional: attributes were fixed only once
  -- `stock_levels` carried a row for the variant, on the
  -- product_variants_20_stock_identity_lock precedent (0060). V2 of the
  -- Master Continuous Mission ordered the race proved, and it failed:
  --   T1  UPDATE attributes  -- reads stock_levels, sees no row, allows it
  --   T2  INSERT the variant's FIRST stock_levels row
  --   both COMMIT  ->  a variant whose combination changed AND has stock
  -- A cross-table read of an ABSENT row cannot be locked: there is no row to
  -- lock, and only SERIALIZABLE gives a predicate lock. The lock that would
  -- serialize it has to be taken by whoever creates the first stock row, and
  -- that path belongs to the inventory authority, not to this pack.
  --
  -- So the invariant is made unconditional instead, which Pack A owns
  -- entirely: **a non-base variant's combination never changes.** The cell
  -- IS the identity. A mistyped combination on a variant with no history is
  -- archived (product_variants_30_archive_requires_zero_stock already allows
  -- that at zero stock) and replaced, which costs a merchant one extra tap
  -- and removes a whole class of concurrency failure. No cross-table read,
  -- nothing to race, no second authority asked for anything.
  -- The check itself is at the TOP of this function, above the early return.
  -- It was here until the independent challenge measured that `'{}'` never
  -- reached it; see the comment there. Nothing is checked twice.

  -- ── Each registry row is LOCKED, not merely read, and with FOR SHARE ───
  -- Finding P1-03, measured at 1a8ba15: the lock was `FOR KEY SHARE`, which
  -- conflicts with DELETE and with a KEY update and NOT with an ordinary
  -- UPDATE of a non-key column. `product_attribute_values.status` is not a
  -- key column, so `UPDATE … SET status='archived'` ran straight through the
  -- lock the concurrency law credited for serialization: T2 did not block,
  -- both committed, and a committed variant named an archived value. The
  -- same hole let `UPDATE product_matrix_axes SET axis_code=…` repoint a row
  -- the validator had "locked".
  --
  -- `FOR SHARE` conflicts with FOR NO KEY UPDATE / FOR UPDATE / DELETE —
  -- that is, with every write to the row — while two concurrent validators
  -- still share it, so inserting different cells of one product in parallel
  -- is unaffected. The cost is paid only by a registry MUTATION racing a
  -- variant insert, which is the race that must serialize.
  -- Also a measured race. Reading the registry and then trusting the read is
  -- a snapshot promise: T1 deleted an axis of this product while T2 inserted
  -- a variant naming it, and both committed, leaving a committed variant
  -- whose attributes named an axis the matrix no longer registers. `FOR KEY
  -- SHARE` makes the concurrent DELETE wait instead, so one of the two
  -- transactions sees the other's outcome and the closure invariant survives
  -- both orderings. The matching structural half is
  -- product_matrix_axes_10_axis_in_use() below.
  FOR v_axis, v_value IN SELECT e.key, e.value #>> '{}' FROM jsonb_each(v_canonical) e LOOP
    PERFORM 1 FROM product_matrix_axes ma
      WHERE ma.business_id = NEW.business_id
        AND ma.product_id  = NEW.product_id
        AND ma.axis_code   = v_axis
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'catalog.variant_axis_unregistered: axis % is not an axis of this product''s matrix', v_axis
        USING ERRCODE = 'P0001';
    END IF;
    -- Finding P2-06: this function read `product_attribute_values.status`
    -- and never `product_attribute_axes.status`, so the same column was a
    -- lifecycle on one registry and decoration on the other — and a new
    -- matrix cell on an ARCHIVED axis committed (measured). A status that
    -- nothing reads will be trusted by the first screen that shows it.
    PERFORM 1 FROM product_attribute_axes ax
      WHERE ax.business_id = NEW.business_id
        AND ax.axis_code   = v_axis
        AND ax.status      = 'active'
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'catalog.variant_axis_archived: axis % is not an active axis of this business', v_axis
        USING ERRCODE = 'P0001';
    END IF;
    PERFORM 1 FROM product_attribute_values av
      WHERE av.business_id = NEW.business_id
        AND av.axis_code   = v_axis
        AND av.value_code  = v_value
        AND av.status      = 'active'
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'catalog.variant_axis_value_unregistered: % is not an active value of axis %', v_value, v_axis
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- The axis COUNT is read under the same lock discipline: counting rows a
  -- concurrent transaction is deleting is the same snapshot promise one line
  -- further down.
  PERFORM 1 FROM product_matrix_axes ma
    WHERE ma.business_id = NEW.business_id AND ma.product_id = NEW.product_id
    FOR SHARE;

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

-- ── The structural half of the axis race ───────────────────────────────────
-- A lock makes the two transactions serialize; this makes the losing order
-- REFUSE rather than succeed. Without it, the axis delete simply wins after
-- the variant insert waits, and the committed state is still inconsistent —
-- and worse, it orphans variants that were already there, which is not even
-- a race but an unguarded delete.
-- SECURITY INVOKER, and that is a REJECTION of finding P2-07's recommended
-- fix, with the measurement that rejects it.
--
-- The finding is right about the mechanism: this guard's refusal is the
-- NEGATION of a read, and under SECURITY INVOKER that read is filtered by
-- the deleting principal's row-level security — a zero read, which this
-- project has ruled may not be used as proof of absence. The recommended
-- fix was SECURITY DEFINER owned by `daftar_catalog_internal`, with the
-- column-scoped read and role-scoped policy that 0070 already uses.
--
-- IT WAS IMPLEMENTED AND MEASURED, AND IT CREATED THE BYPASS IT WAS MEANT TO
-- PREVENT. `product_variants` carries a RESTRICTIVE `business_isolation`
-- policy (`app_bypass() OR business_id = app_business()`) for ALL commands.
-- Restrictive policies AND with everything, so the definer's own
-- `USING (true)` read cannot satisfy it: as `daftar_catalog_internal` with
-- no business context set, `SELECT count(*) FROM product_variants` returned
-- **0** where the same read with context returned **3** (measured on this
-- cluster). So every in-use guard became a silent allow for any principal
-- that deletes without session context — and the run showed exactly that:
-- five removal cases that had been refusals reported "no error", including
-- the axis-delete case that was green before the change.
--
-- Under SECURITY INVOKER the three principals that can reach these rows all
-- behave correctly, because FORCE row-level security makes visibility of the
-- registry row and visibility of the variants the SAME scope:
--   · a bypassrls principal sees both, so the guard fires;
--   · `daftar_app` with its own context sees its business's variants, so the
--     guard fires — measured, as `daftar_app`, in proofs.py;
--   · a principal with no context cannot see or delete the registry row at
--     all, so there is nothing for the guard to miss.
-- The DEFINER variant breaks the first of those three. The finding's real
-- content — that a FUTURE policy narrowing `product_variants` by status,
-- branch or channel would convert this refusal into a silent allow — is not
-- answered by a definer either. It is answered by a tripwire: section 7 pins
-- the policy SET on `product_variants`, so a pack installed over an
-- unexpected policy set refuses itself, and P11-MIGRATION-PATCH-REQUEST.md
-- §3 asks the Security Authority to pin the same set in the standing RLS
-- invariant check (PR-SEC-P11-01), which is the only place that runs after
-- a later migration adds one.
CREATE FUNCTION product_matrix_axes_10_axis_in_use()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- Finding P1-04: this trigger was BEFORE DELETE only, so
  -- `UPDATE product_matrix_axes SET axis_code='material' WHERE axis_code='color'`
  -- removed `color` from the matrix without deleting a row, and a committed
  -- variant then named an axis the matrix no longer registered (measured).
  -- Removal is a transition, not a statement kind: UPDATE OF axis_code is
  -- the same removal and is refused by the same condition, read from OLD.
  IF EXISTS (SELECT 1 FROM product_variants v
              WHERE v.business_id = OLD.business_id
                AND v.product_id  = OLD.product_id
                AND NOT v.is_base
                AND v.attributes ? OLD.axis_code) THEN
    RAISE EXCEPTION 'catalog.matrix_axis_in_use: axis % is named by existing variants of this product and cannot be removed', OLD.axis_code
      USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER product_matrix_axes_10_axis_in_use
  BEFORE DELETE OR UPDATE OF axis_code ON product_matrix_axes
  FOR EACH ROW EXECUTE FUNCTION product_matrix_axes_10_axis_in_use();

-- ── The same guard on the VALUE registry, which had none at all ───────────
-- Finding P0-02, and it is the finding with no concurrency in it:
-- `DELETE FROM product_attribute_values WHERE axis_code='color' AND
-- value_code='blue'` was accepted with two committed variants naming it, and
-- `UPDATE … SET status='archived'` likewise (P1-03). `product_variants.attributes`
-- is jsonb, so there is no foreign key into this registry and nothing but a
-- guard can hold the closure invariant. Pack A built this shape one table
-- over and not here; the DDL comment on the axis guard — "it orphans
-- variants that were already there, which is not even a race but an
-- unguarded delete" — was true of this table at that head.
--
-- Three transitions are the same removal: DELETE, a repointing UPDATE of the
-- identifying columns, and an UPDATE of `status` away from 'active'. An
-- un-archiving UPDATE (back to 'active') and a translation change are not
-- removals and are not refused.
-- SECURITY INVOKER for the reason measured on the axis guard above.
CREATE FUNCTION product_attribute_values_10_value_in_use()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.business_id = OLD.business_id
     AND NEW.axis_code   = OLD.axis_code
     AND NEW.value_code  = OLD.value_code
     AND NEW.status      = 'active' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM product_variants v
              WHERE v.business_id = OLD.business_id
                AND NOT v.is_base
                AND v.attributes ->> OLD.axis_code = OLD.value_code) THEN
    RAISE EXCEPTION 'catalog.attribute_value_in_use: value % of axis % is named by existing variants and can be neither removed nor archived', OLD.value_code, OLD.axis_code
      USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER product_attribute_values_10_value_in_use
  BEFORE DELETE OR UPDATE OF business_id, axis_code, value_code, status ON product_attribute_values
  FOR EACH ROW EXECUTE FUNCTION product_attribute_values_10_value_in_use();

-- ── And on the AXIS registry, for the same reason ────────────────────────
-- A DELETE here is already refused by `product_matrix_axes_axis_fk` (ON
-- DELETE RESTRICT) whenever a matrix registers the axis, and by
-- `product_attribute_values_axis_fk` whenever a value does — so the FK, not
-- a trigger, is the structural half of removal. Archiving is what no FK can
-- see: it leaves the row in place while the validator above stops treating
-- it as an axis, which would freeze every matrix product that names it.
-- SECURITY INVOKER for the reason measured on the axis guard above.
CREATE FUNCTION product_attribute_axes_10_axis_in_use()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'active' AND NEW.axis_code = OLD.axis_code AND NEW.business_id = OLD.business_id THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM product_variants v
              WHERE v.business_id = OLD.business_id
                AND NOT v.is_base
                AND v.attributes ? OLD.axis_code) THEN
    RAISE EXCEPTION 'catalog.attribute_axis_in_use: axis % is named by existing variants and can be neither renamed nor archived', OLD.axis_code
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER product_attribute_axes_10_axis_in_use
  BEFORE UPDATE OF business_id, axis_code, status ON product_attribute_axes
  FOR EACH ROW EXECUTE FUNCTION product_attribute_axes_10_axis_in_use();

-- ── An archived axis cannot be added to a matrix ─────────────────────────
-- The other half of P2-06: the validator now refuses a VARIANT on an
-- archived axis, which makes a matrix row naming one unusable rather than
-- harmful. Refusing it at the matrix write is where a merchant can still be
-- told why.
CREATE FUNCTION product_matrix_axes_20_axis_active()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM 1 FROM product_attribute_axes ax
    WHERE ax.business_id = NEW.business_id
      AND ax.axis_code   = NEW.axis_code
      AND ax.status      = 'active'
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'catalog.variant_axis_archived: axis % is not an active axis of this business', NEW.axis_code
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER product_matrix_axes_20_axis_active
  BEFORE INSERT OR UPDATE OF axis_code ON product_matrix_axes
  FOR EACH ROW EXECUTE FUNCTION product_matrix_axes_20_axis_active();

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

-- ── No privilege and no policy of another phase's relation is touched ─────
-- An earlier draft of this round granted `daftar_catalog_internal` a
-- column-scoped SELECT on `product_variants` and added a role-scoped
-- `catalog_internal_read` policy to it, to support the SECURITY DEFINER
-- guards that finding P2-07 recommended. Both are GONE with that design:
-- the measurement above shows the definer made the guards weaker, and with
-- SECURITY INVOKER guards nothing here needs a privilege on a relation Pack
-- A does not own. So this pack changes no grant and no policy outside its
-- own five relations, and the Security Authority is asked for nothing it
-- would have to review. Recorded because the privilege was briefly in this
-- file and a reader of the diff will see it appear and disappear.

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
    -- L-P11-02, asserted on the column's TYPE against an allow-list rather
    -- than on its NAME against eight patterns. Finding P3-10: the name-shaped
    -- form is satisfied by any name outside the patterns, so `cost_per_unit`
    -- or `fee` would have passed it. A money column has to be numeric,
    -- decimal, money, or an integer holding minor units — so the assertion
    -- is: NO column of a monetary type at all, and every numeric column in
    -- this pack is one of the two ordering columns, by name AND by type.
    IF EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
                          WHERE c.relname = v_name AND a.attnum > 0 AND NOT a.attisdropped
                            AND format_type(a.atttypid, NULL) IN ('numeric','money','double precision','real','bigint')) THEN
      RAISE EXCEPTION 'catalog.migration_end_state_invalid: % carries a column of a monetary type', v_name USING ERRCODE='P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
                          WHERE c.relname = v_name AND a.attnum > 0 AND NOT a.attisdropped
                            AND format_type(a.atttypid, NULL) IN ('integer','smallint')
                            AND (a.attname, format_type(a.atttypid, NULL)) NOT IN
                                (('sort_order','integer'), ('axis_position','smallint'))) THEN
      RAISE EXCEPTION 'catalog.migration_end_state_invalid: % carries a numeric column outside the pack''s two ordering columns', v_name USING ERRCODE='P0001';
    END IF;
    -- Finding P2-07's other half: a permissive policy applied to PUBLIC ORs
    -- with tenant_membership and switches isolation off for the commands it
    -- names. Measured in this phase's Pack B round, where a wrong-tenant
    -- read returned another business's rows. Asserted here for every
    -- relation of this pack, so the mistake cannot be made silently later.
    IF EXISTS (SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
                WHERE c.relname = v_name AND p.polpermissive AND p.polroles = '{0}'
                  AND coalesce(pg_get_expr(p.polqual, p.polrelid), 'true') = 'true') THEN
      RAISE EXCEPTION 'catalog.migration_end_state_invalid: % carries a permissive policy applied to PUBLIC with no qualifier', v_name USING ERRCODE='P0001';
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_trigger WHERE tgname = 'product_variants_40_matrix_canonical' AND NOT tgisinternal) <> 1 THEN
    RAISE EXCEPTION 'catalog.migration_end_state_invalid: the canonicalization trigger is absent' USING ERRCODE='P0001';
  END IF;
  -- Every guard of the REMOVAL direction, present, on the statement kinds it
  -- must cover, and owned by the definer it was given. The independent
  -- challenge found four of these five absent or half-scoped at 1a8ba15, so
  -- the assertion now names the trigger's events and its function's owner
  -- rather than only its existence. tgtype bit 2 = BEFORE, 3 = INSERT,
  -- 4 = DELETE, 5 = UPDATE (pg_trigger).
  FOR r IN
    SELECT * FROM (VALUES
      ('product_matrix_axes_10_axis_in_use',       'product_matrix_axes',      true,  true),
      ('product_attribute_values_10_value_in_use', 'product_attribute_values', true,  true),
      ('product_attribute_axes_10_axis_in_use',    'product_attribute_axes',   false, true),
      ('product_matrix_axes_20_axis_active',       'product_matrix_axes',      false, true)
    ) AS t(tg, rel, needs_delete, needs_update)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
                    WHERE g.tgname = r.tg AND c.relname = r.rel AND NOT g.tgisinternal
                      AND (g.tgtype & 8)  = CASE WHEN r.needs_delete THEN 8  ELSE 0 END
                      AND (g.tgtype & 16) = CASE WHEN r.needs_update THEN 16 ELSE 0 END) THEN
      RAISE EXCEPTION 'catalog.migration_end_state_invalid: trigger % on % is absent or does not cover the statement kinds it must', r.tg, r.rel USING ERRCODE='P0001';
    END IF;
    -- INVOKER, deliberately and measurably: a DEFINER variant of these
    -- guards cannot satisfy product_variants' RESTRICTIVE business_isolation
    -- without a session context, and silently allowed every removal (see the
    -- comment above the first guard). Asserted so the "fix" cannot be
    -- re-applied later without this assertion refusing it.
    IF EXISTS (SELECT 1 FROM pg_proc pr WHERE pr.proname = r.tg AND pr.prosecdef) THEN
      RAISE EXCEPTION 'catalog.migration_end_state_invalid: % is SECURITY DEFINER; these guards conclude from a read of product_variants and a definer cannot satisfy its restrictive policy without a session context', r.tg USING ERRCODE='P0001';
    END IF;
  END LOOP;

  -- ── The tripwire the in-use guards actually need ────────────────────────
  -- Finding P2-07's real content: the three guards allow when they SEE no
  -- variant, and that read runs under the invoker's row-level security. It
  -- is sound while `product_variants` is narrowed by business and tenant
  -- ONLY, because the registry row being removed is in that same scope. A
  -- later policy narrowing it by status, branch or channel would convert
  -- each refusal into a silent allow, and no test would notice.
  --
  -- So the policy SET is pinned here: this pack refuses to install over a
  -- `product_variants` whose policies are not exactly the two it reasoned
  -- about. It cannot catch a policy added AFTER this pack — only the
  -- standing RLS invariant check can, which is why
  -- P11-MIGRATION-PATCH-REQUEST.md §12.2 (PR-SEC-P11-01) asks the Security
  -- Authority for the same pin there. Stated as a limit, not as cover.
  IF (SELECT array_agg(p.polname::TEXT ORDER BY p.polname) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
       WHERE c.relname = 'product_variants')
     IS DISTINCT FROM ARRAY['business_isolation','tenant_membership']::TEXT[] THEN
    RAISE EXCEPTION 'catalog.migration_end_state_invalid: product_variants carries a policy set this pack did not reason about (%); the three in-use guards conclude absence from a read of it and must be re-proved against the new set',
      (SELECT string_agg(p.polname, ',' ORDER BY p.polname) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relname = 'product_variants')
      USING ERRCODE='P0001';
  END IF;
  IF (SELECT count(*) FROM pg_class WHERE relname = 'product_variants_matrix_uq' AND relkind = 'i') <> 1 THEN
    RAISE EXCEPTION 'catalog.migration_end_state_invalid: the matrix uniqueness index is absent' USING ERRCODE='P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM features WHERE key = 'VARIANT_MATRIX') THEN
    RAISE EXCEPTION 'catalog.migration_end_state_invalid: the VARIANT_MATRIX feature key is unregistered' USING ERRCODE='P0001';
  END IF;
  -- This pack touches no inventory truth: it must have registered nothing
  -- there. Finding P3-10: the earlier form matched the two registries' text
  -- against '%matrix%' / '%apparel%', which any other name passes. The
  -- set-shaped assertion is that the two registries' ROW COUNTS are
  -- unchanged across this pack, measured before the first statement of it
  -- (section 0) and compared here.
  IF coalesce(current_setting('p11.baseline_src', true), '') = ''
     OR coalesce(current_setting('p11.baseline_kind', true), '') = ''
     OR coalesce(current_setting('p11.baseline_op', true), '') = '' THEN
    RAISE EXCEPTION 'catalog.migration_end_state_invalid: the pack''s own baseline is missing, so no absence can be asserted' USING ERRCODE='P0001';
  END IF;
  IF current_setting('p11.baseline_src')::BIGINT  <> (SELECT count(*) FROM stock_source_types)
     OR current_setting('p11.baseline_kind')::BIGINT <> (SELECT count(*) FROM stock_movement_kinds)
     OR current_setting('p11.baseline_op')::BIGINT   <> (SELECT count(*) FROM inventory_operation_kinds) THEN
    RAISE EXCEPTION 'catalog.migration_end_state_invalid: Pack A changed the row count of an inventory registry' USING ERRCODE='P0001';
  END IF;
END;
$$;
