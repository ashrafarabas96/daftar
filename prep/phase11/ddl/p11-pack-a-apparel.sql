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

  -- ── The matrix of THIS product is held for the length of the write ─────
  -- Finding P1-N01 of the second challenge round added a guard on the ADD
  -- direction (product_matrix_axes_30_set_frozen below). Row locks cannot
  -- order a variant insert against an axis INSERT: the validator can lock
  -- every matrix row that exists, and the row the other transaction is
  -- about to add is not among them, while the freeze guard's read of
  -- product_variants cannot see an uncommitted variant either. Mutual
  -- invisibility, so neither side's lock serializes them — the same shape
  -- as the registry races, one relation up.
  --
  -- A transaction advisory lock keyed on (business_id, product_id) orders
  -- them without touching another phase's relation and without locking a
  -- row anything else contends for: the variant side takes it SHARED, so
  -- generating a grid of fifty cells in parallel is unaffected, and the
  -- matrix side takes it EXCLUSIVE, so an axis write waits for the variant
  -- writes in flight and then reads a state it can conclude from. It is
  -- taken on the INSERT path only; a DELETE-path lock order is a caller
  -- obligation (TL-P4-COORD-R62), and taking it after the executor's own
  -- lock on OLD is how a deadlock is built.
  PERFORM pg_advisory_xact_lock_shared(
            hashtextextended(NEW.business_id::text || '/' || NEW.product_id::text, 0));

  IF NEW.is_base THEN
    RETURN NEW;
  END IF;

  -- ── The THIRD door of C-APP-01, and the last state that reached it ─────
  -- Finding PA-01 of the third independent challenge. This early return used
  -- to read `NEW.is_base OR NEW.attributes = '{}'`, and the `'{}'` half asked
  -- nothing about the PRODUCT. Measured at 0db9450 on the world's TSHIRT,
  -- which registers two axes and holds one committed cell:
  --   INSERT INTO product_variants (… is_base=false, attributes='{}') -> rc=0
  --   non-base '{}' variants on this MATRIX product: 1   its own key: 5.0000
  -- One matrix cell set, one row outside it, both holding stock, under Option
  -- B where the variant IS the costing key. That is the same split identity
  -- P0-01 produced by blanking and P1-N01 produced by adding an axis — the
  -- third route to one state, reached with a single INSERT.
  --
  -- Three rounds have now found this clause through three different doors, so
  -- the lesson is about where the guard is derived FROM. Rounds 1 and 2 each
  -- guarded the statement that was reported. This round guards the STATE the
  -- freeze guard's own comment describes — "a non-base variant outside the
  -- product's matrix cell set, holding stock" — and then asks which
  -- statements can reach it:
  --   UPDATE a cell's attributes to '{}'      -> variant_matrix_immutable (P0-01)
  --   UPDATE them to a different combination  -> variant_matrix_immutable
  --   INSERT a partial / foreign combination  -> variant_axis_set_incomplete /
  --                                              variant_axis_unregistered
  --   INSERT a '{}' non-base variant          -> THIS branch (PA-01)
  --   INSERT an axis under existing variants  -> matrix_axis_set_frozen (P1-N01)
  --   DELETE/UPDATE an axis or a value in use -> the four in-use guards
  -- The set is closed over the two relations the state is written from, and
  -- every member is a red proof. The committed-state case
  -- ("no committed variant names other than exactly its product's set")
  -- measures the state itself rather than any one door, which is the case
  -- that would have caught all three.
  --
  -- `'{}'` is still right for a product that registers NO axes — that is
  -- every non-apparel product in the catalogue, and the reason the
  -- structural CHECK `(is_base OR attributes <> '{}')` is still unavailable
  -- (it cannot read another relation). So the predicate is "does THIS product
  -- have a matrix", read under the same lock discipline as the completeness
  -- count below, and the refusal is the completeness law's own name: the
  -- empty set names zero of the product's registered axes, which is exactly
  -- what `variant_axis_set_incomplete` says. One law, one name — the
  -- distinction the challenge credited Pack B for making.
  IF NEW.attributes = '{}'::jsonb THEN
    PERFORM 1 FROM product_matrix_axes ma
      WHERE ma.business_id = NEW.business_id AND ma.product_id = NEW.product_id
      FOR SHARE;
    IF FOUND THEN
      SELECT count(*) INTO v_registered FROM product_matrix_axes ma
       WHERE ma.business_id = NEW.business_id AND ma.product_id = NEW.product_id;
      RAISE EXCEPTION 'catalog.variant_axis_set_incomplete: attributes must name exactly the product''s % registered axes', v_registered
        USING ERRCODE = 'P0001';
    END IF;
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
--   · a principal that bypasses row-level security sees both, so the guard
--     fires — which at this head means a SUPERUSER or a role `app_bypass()`
--     names (`daftar_platform`), and NOT a role carrying BYPASSRLS, which
--     the first version of this comment said: `rolbypassrls` turns off the
--     policy machinery, while `app_bypass()` is a clause INSIDE the policy,
--     and they are different mechanisms reaching the same row;
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
  -- Finding P2-N02: "in use" was read as "named by a variant", and the
  -- comment above this function states the outcome it was written to
  -- prevent — "it leaves the row in place while the validator above stops
  -- treating it as an axis, which would freeze every matrix product that
  -- names it". A matrix that registers the axis with no variants yet is
  -- exactly that case, and it was not refused: measured, the archive
  -- succeeded, the product's FIRST variant insert was then refused
  -- catalog.variant_axis_archived, and the product could not get a variant
  -- at all. Recoverable (the matrix row can still be deleted while no
  -- variant names it) and therefore a trap rather than a corruption — but
  -- the guard's own reason covers it, so the guard covers it now.
  IF EXISTS (SELECT 1 FROM product_matrix_axes ma
              WHERE ma.business_id = OLD.business_id
                AND ma.axis_code   = OLD.axis_code) THEN
    RAISE EXCEPTION 'catalog.attribute_axis_in_use: axis % is registered by a product matrix and can be neither renamed nor archived while it is; take it off those products'' matrices first', OLD.axis_code
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

-- ── A POPULATED matrix's axis set is frozen (the ADD direction) ───────────
-- Finding P1-N01 of the second independent challenge, and it is the same
-- clause of C-APP-01 as P0-01 with the arrow reversed. Round 1 found the
-- clause "a matrix product's variant attributes name exactly its registered
-- axis set" enforced in the INSERT direction of the VARIANT only; this round
-- added every REMOVAL path on both registries. What was left is ADDING an
-- axis to a matrix that already has variants, and nothing refused it:
-- `_20_axis_active` only asks whether the axis is active, `_10_axis_in_use`
-- is about removal, and the completeness count (`v_supplied <> v_registered`)
-- runs on a VARIANT write and so never sees a matrix write at all.
--
-- Measured at 23a7139 on a product holding one committed `{size:m,color:blue}`:
-- `INSERT INTO product_matrix_axes … 'material',3` returned rc=0, the matrix
-- then registered three axes, and the committed 2-axis variant named exactly
-- two of them. The cost is not a duplicate cell this time; it is a variant
-- that NOTHING can address through the matrix (no 2-axis cell exists on a
-- 3-axis product) while it keeps its own stock key and its whole movement
-- history. The same split identity P0-01 produced, reached by the door a
-- merchant walks through on purpose: "add a material axis to this shirt".
--
-- So the axis set of a populated matrix is as immutable as a variant's
-- combination, and for the same reason: under Option B the variant IS the
-- costing key, so the set of axes that addresses it cannot change underneath
-- it. The merchant's path is the one the pack already chose for a mistyped
-- combination — archive the variants at zero stock (which
-- product_variants_30_archive_requires_zero_stock already permits) and
-- regenerate the grid. C-APP-01 now states the clause in both directions.
--
-- ANY non-base variant that is not archived freezes the set, including one
-- whose attributes are '{}': that is a plain product's single variant, it
-- holds the product's stock, and registering a first axis under it would
-- leave it exactly as unaddressable as the 2-axis row above. (The variant
-- side refuses that row outright once a matrix exists — finding PA-01 — so
-- the two guards now close the same state from both directions.) A product
-- with no live non-base variants can still be given, re-ordered and taken
-- off axes freely, which is the whole lifecycle a merchant building a grid
-- needs.
--
-- ── Why the read excludes ARCHIVED variants (finding PA-02) ────────────
-- The comment above offers the merchant a recovery path. The third
-- independent challenge measured it and it did not work: the read had no
-- `status` filter, so with both cells of TSHIRT at zero stock and archived
-- (which the pack permits: 2 archived, 0 live), the documented next step
--   INSERT INTO product_matrix_axes (… 'material', 3)  -> rc=3 matrix_axis_set_frozen
-- A wrongly registered grid could therefore never be corrected: archiving
-- was permitted and useless, the variant cannot be deleted once movements
-- name it, and the axis could not be added. A recovery path stated in a
-- comment is a claim, and a claim here gets measured.
--
-- So the filter is added, and the premise it rests on is stated rather than
-- assumed: `product_variants_30_archive_requires_zero_stock` (0061) refuses
-- the transition to `archived` while the variant's key holds stock OR its
-- movements net to anything but zero per warehouse, so an archived variant
-- is not a live costing identity. Its history stays addressable by id, which
-- is where a ledger addresses it from; the grid addresses only live cells.
-- C-APP-01 is therefore stated over LIVE non-base variants, in the law
-- document and in the committed-state case, rather than left ambiguous.
-- The pack's own uniqueness rule already reads the grid that way and has
-- since round 0: `product_variants_matrix_uq` is partial on
-- `NOT is_base AND status <> 'archived' AND attributes <> '{}'`, so an
-- archived cell does not occupy its combination and the regenerated grid can
-- re-create it. The guard was the only place in the pack that counted an
-- archived variant as part of the matrix, which is why the recovery path it
-- recommended was the one thing that could not be done.
--
-- The residual, MEASURED and routed rather than claimed away: nothing in the
-- frozen core refuses a movement onto an ARCHIVED variant. Measured at this
-- SHA — a `stock_levels` row with `on_hand 5.0000` on an archived variant is
-- accepted, and no trigger on `stock_levels` or `stock_movements` reads
-- `product_variants.status`. So the sequence "archive the cells, add an axis,
-- then post stock onto an archived cell" reaches the unaddressable state
-- again, one authority further on. Pack A cannot close it here: reading
-- `stock_levels` from this guard would be a cross-table read of an ABSENT
-- row, which cannot be locked (the measurement in
-- product_variants_40_matrix_canonical()'s comment), and taking a row lock on
-- another phase's ledger is what the `FOR SHARE` measurement in Pack B
-- warns against. It is MPR-09 to the inventory authority — a movement is not
-- posted onto an archived variant — and it is a declared limit of this fix,
-- not a hole the pack is unaware of.
--
-- SECURITY INVOKER, for the reason measured on the first guard: a DEFINER
-- variant owned by daftar_catalog_internal reads nothing through
-- product_variants' RESTRICTIVE policy. The advisory lock is what makes the
-- read conclusive against a CONCURRENT variant insert; see the matching
-- comment in product_variants_40_matrix_canonical().
CREATE FUNCTION product_matrix_axes_30_set_frozen()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
            hashtextextended(NEW.business_id::text || '/' || NEW.product_id::text, 0));
  PERFORM 1 FROM product_variants v
    WHERE v.business_id = NEW.business_id
      AND v.product_id  = NEW.product_id
      AND NOT v.is_base
      AND v.status <> 'archived'
    FOR SHARE;
  IF FOUND THEN
    RAISE EXCEPTION 'catalog.matrix_axis_set_frozen: this product already has live variants, so its axis set is frozen; archive them at zero stock and regenerate the grid'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER product_matrix_axes_30_set_frozen
  BEFORE INSERT ON product_matrix_axes
  FOR EACH ROW EXECUTE FUNCTION product_matrix_axes_30_set_frozen();

-- ── C-APP-01 AS A STATE, CHECKED AT COMMIT, NOT AS A LIST OF VERBS ────────
-- Finding P1-01 of the FOURTH independent challenge, and the reason this
-- section exists rather than a fifth per-verb guard.
--
-- The previous round narrowed the freeze guard's read to LIVE variants, so
-- that the recovery path its own message recommends could be walked (finding
-- PA-02). The narrowing was right and stays. What it did was make a verb
-- reachable that nothing watched: `UPDATE product_variants SET status =
-- 'active'`. Measured by the challenger at 04d87b3 on TSHIRT-RECOVER —
--   archive both cells        -> permitted (0061 requires zero stock, which held)
--   INSERT a third axis       -> permitted (no LIVE variant, so not frozen)
--   UPDATE … SET status='active' -> rc=0
-- and the committed state was one live non-base variant naming two of the
-- product's three axes, holding 7.0000 on its own stock key. The same
-- unaddressable split identity P0-01, P1-N01 and PA-01 each produced, by a
-- fourth door. `product_variants_40_matrix_canonical` fires BEFORE INSERT OR
-- UPDATE OF attributes, is_base, product_id — not of `status` — and 0061
-- fires only on the way INTO 'archived'. Nothing watched the way back.
--
-- Four rounds, four doors, one state. The lesson is not "add status to the
-- trigger's column list"; that is the fifth per-verb guard and the sixth door
-- would be whatever verb the next correct narrowing makes reachable. What is
-- stable is the STATE, which C-APP-01 states and which the freeze guard's own
-- comment has described since round 2:
--
--   For every (business, product): every LIVE non-base variant names
--   exactly the axis codes the product's matrix currently registers, and
--   every axis and value it names is active in the business's registries.
--
-- So it is recomputed, for the affected product, at COMMIT, by DEFERRABLE
-- INITIALLY DEFERRED constraint triggers on every relation the state is
-- written from — product_variants, product_matrix_axes,
-- product_attribute_axes, product_attribute_values — on INSERT, UPDATE and
-- DELETE alike. A verb nobody enumerated still lands in one of those four
-- relations, and the check does not ask which verb was used.
--
-- The per-verb guards above are NOT removed, and the distinction is worth
-- stating because a reviewer should be able to see which one answers:
--   * the BEFORE guards refuse at the STATEMENT, so a merchant is told which
--     write was wrong while the transaction can still be corrected, and they
--     refuse writes this check cannot see at all (a value archived with no
--     variant yet naming it, an axis removed from a matrix that has none);
--   * this check refuses at COMMIT, so a sequence whose individual statements
--     are each permissible cannot leave the forbidden state behind.
-- Both are proved, and they are PAIR-DROPPED in the mutation set (M7 drops
-- this check, M8 drops the four BEFORE guards, M9 drops both) so the log
-- shows which refusal each door actually meets rather than leaving one
-- defence masked by the other — the P5 R9 lesson, applied here before a
-- challenger has to apply it.
--
-- DEFERRED rather than IMMEDIATE, deliberately: generating a grid writes the
-- axes and then the cells, and every intermediate state of that transaction
-- names fewer cells than axes. An IMMEDIATE check would refuse the ordinary
-- act of building a matrix. The law is about what is COMMITTED, so it is
-- checked where commit is.
--
-- SECURITY INVOKER, for the reason measured three times in this pack: a
-- definer reads nothing through product_variants' RESTRICTIVE policy without
-- a session context. The premise that makes an invoker read conclusive is
-- that the writer must already satisfy business_isolation on the relation it
-- wrote, so the product's own variants and registry rows are in its scope.
-- That premise is not assumed: the check asserts it holds the privileges it
-- needs and REFUSES rather than passing if it cannot look — the Pack B D-32
-- shape ("a check that cannot look must not reassure"), stated here as a
-- name of its own, catalog.matrix_grid_unverifiable.
-- ── THE SESSION THAT JUDGES MUST BE THE SESSION THAT WROTE ────────────────
-- Finding P1-01 of the FIFTH independent challenge, and it is a fail-open in
-- the function the fourth round added, so it is the blocker of this round.
--
-- The blindness arm below tested `has_table_privilege`, which is a statement
-- about the GRANT. The condition that defeats a read of these relations is
-- VISIBILITY: they carry ENABLE + FORCE row-level security and `app_bypass()`
-- is a ROLE test (`CURRENT_USER = 'daftar_platform'`, 0052), so a principal
-- can hold SELECT on all four relations and read zero rows. The challenger
-- measured it in the shape of this pack's own D-32 red proof: run the whole
-- fourth-door chain lawfully in one transaction, then drop to `daftar_app`
-- and RESET the context immediately before COMMIT —
--   SELECT privilege on all four relations : true true true true
--   rows of this product daftar_app can see: 0
--   transaction                            : rc=0, NOT REFUSED
--   live non-base variants outside the grid: 1
-- The author's own case withdrew a GRANT, and a withdrawn grant and an empty
-- read are two different facts. This is the class this phase has now closed
-- four times (Phase 5's fail-open, the movement side in Pack B round 1, the
-- cache side in round 4 — that one found here — and now this): **the intent
-- carried forward and the condition did not.**
--
-- The fix is not a better visibility probe. There is no sound probe inside an
-- invoker's own read: "I see no rows" and "there are no rows" are the same
-- answer, which is exactly why the previous three instances of this class were
-- closed by refusing rather than by looking harder. What IS decidable is the
-- thing the exploit needs: **the principal or the context changed between the
-- last write and the COMMIT.** So the identity under which the state was
-- WRITTEN is recorded at statement time, in a transaction-local setting, and
-- the deferred check refuses unless the identity at COMMIT is the same one.
--
--   * recorded by a STATEMENT-level trigger, so a fifty-cell grid records once
--     per statement rather than once per row;
--   * recorded in a RELATION, `catalog_grid_ctx_ledger`, and NOT in a custom
--     GUC. That is finding P1-01 of the SIXTH round, and it is a fail-open the
--     fifth round's own remedy introduced: `p11.grid_ctx` was a custom setting
--     in an unreserved prefix, so the judged session could set it itself (no
--     grant, no check, measured `rc=0`), and "first write wins" then kept the
--     ATTACKER's string because a value already present was never overwritten.
--     One session-level `SET` covered every later transaction on a pooled
--     connection, with nothing beyond `daftar_app`'s own rights. A value that
--     must be unforgeable cannot live anywhere the judged session can write.
--   * UNANIMITY, not first-write-wins. Every statement appends its own row,
--     and the check requires that EVERY identity recorded by this transaction
--     is the same AND equal to the identity at COMMIT. This is what makes a
--     forged row harmless instead of decisive: a row the attacker inserts
--     carries the identity it held at that moment, so any disagreement is a
--     REFUSAL, and the attacker cannot remove the honest rows (no UPDATE and
--     no DELETE is granted to any writing role — measured, `permission denied
--     for table catalog_grid_ctx_ledger`). First-write-wins also passed a
--     transaction that wrote as A, wrote as B, and came back to A to commit;
--     unanimity refuses it.
--   * the identity itself is written by the SERVER, not by the caller:
--     `recorded_identity` is a column DEFAULT evaluated during the INSERT, and
--     the writing roles hold `INSERT (txid)` ONLY, so supplying the column
--     fails with `permission denied for table catalog_grid_ctx_ledger`
--     (measured). The column ACL is the mechanism this phase's own DDL digest
--     gained a `pg_attribute` arm for in round 5, which is why a drift in it
--     can no longer pass as a no-op.
--   * a row for ANOTHER transaction cannot be planted, and it is defended
--     ONCE, by the RLS `WITH CHECK (txid = pg_current_xact_id())` that
--     refuses the INSERT outright (`new row violates row-level security
--     policy`, measured by name as `daftar_app`). The sixth round paired that
--     policy with an `xmin` filter in the check and called the pair two
--     defences; the seventh round measured the filter as a fail-open and as a
--     refusal of lawful work, and it is DELETED. The reasoning is written out
--     at the read itself. What matters here is the correction to the claim:
--     the sixth round named that filter an UNMEASURED defence in depth
--     because no case reached it, and "unmeasured" was treated as "inert".
--     It was not inert. A layer no instrument reaches is a layer whose
--     BEHAVIOUR is unknown in both directions, and the only honest way to
--     learn which it is, is to reach it. `pg_current_xact_id()` is `xid8`,
--     epoch-extended, so the `txid` key does not wrap and nothing narrower
--     is compared anywhere.
--   * ABSENT is a refusal, not a pass: a check reached with no recorded
--     identity means the recorder is gone or was bypassed, and the whole
--     point of this finding is that an empty read must not reassure.
--
-- This closes the DELETE direction too, which a visibility probe could not: a
-- deleted row cannot be read back, so "can I still see what I wrote" has no
-- answer there, while "am I still who wrote it" has the same answer for every
-- statement kind.
CREATE FUNCTION catalog_grid_ctx_identity()
RETURNS TEXT
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT current_user::text
         || '|' || coalesce(current_setting('app.business_id', true), '')
         || '|' || coalesce(current_setting('app.tenant_id', true), '');
$fn$;
-- EXECUTE is REVOKED from PUBLIC and granted to exactly the roles that hold a
-- write privilege on the four relations, enumerated from the catalogue below
-- rather than from a hand-written list. Round 5 kept PUBLIC EXECUTE and gave a
-- measured reason: a blanket REVOKE made the lot fixture fail with
-- `permission denied for function catalog_grid_ctx_identity`, because the
-- statement trigger runs as `daftar_inventory_internal` too (base variants,
-- 0053), and a guard that breaks a lawful write is a worse defect than the one
-- it closes. The sixth round's answer is not to widen or to narrow by
-- judgement but to GENERATE the grant from the same `relacl`/`attacl` sweep
-- that found `daftar_app`'s write path on `product_variants`: every role that
-- can fire the recorder can execute it, and no other role can. The function
-- still returns only `current_user` and two of the caller's own settings, so
-- the tightening is hygiene rather than a secret — the identity's integrity
-- comes from the ledger's column ACL, never from this function being private.
-- It is kept as ONE function rather than inlined precisely because "one of two
-- sites carries the arm" is the defect shape this phase has paid for three
-- times.

-- THE LEDGER. One row per writing statement. Nothing in it is supplied by the
-- caller except the transaction id, which RLS pins to the caller's own
-- transaction, and the row cannot be changed or removed afterwards by any role
-- that can write it.
CREATE TABLE catalog_grid_ctx_ledger (
  id                BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  txid              xid8        NOT NULL,
  recorded_identity TEXT        NOT NULL DEFAULT catalog_grid_ctx_identity(),
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX catalog_grid_ctx_ledger_txid_idx ON catalog_grid_ctx_ledger (txid);

COMMENT ON TABLE catalog_grid_ctx_ledger IS
  'Phase 11 Pack A, finding P1-01 (SIXTH challenge round). The write identities of one transaction, one row per statement that touched a relation C-APP-01 can be written from. It replaces the custom GUC p11.grid_ctx, which the judged session could set itself. recorded_identity is a column DEFAULT evaluated by the server during the INSERT and the writing roles hold INSERT (txid) only, so a caller cannot choose what is recorded; no role holding INSERT holds UPDATE or DELETE, so a recorded row cannot be removed; and RLS pins every row to the inserting transaction. catalog_grid_closed_check requires UNANIMITY across this transaction''s rows and equality with the identity at COMMIT. Rows outlive their transaction and are dead weight after it: pruning is a Migration Owner decision, recorded as MPR-10.';

COMMENT ON COLUMN catalog_grid_ctx_ledger.recorded_identity IS
  'Server-written. The writing roles hold INSERT (txid) only; supplying this column fails with permission denied for table catalog_grid_ctx_ledger (measured).';

ALTER TABLE catalog_grid_ctx_ledger ENABLE  ROW LEVEL SECURITY;
ALTER TABLE catalog_grid_ctx_ledger FORCE   ROW LEVEL SECURITY;

-- A session reads ONLY its own transaction's rows, and the predicate is the
-- transaction id rather than the business, so a reset request context does not
-- make the ledger unreadable: the refusal a blind session gets must be the
-- identity refusal with its two identities named, not a second blindness.
CREATE POLICY catalog_grid_ctx_ledger_own_txid_select ON catalog_grid_ctx_ledger
  FOR SELECT USING (txid = pg_current_xact_id());

-- And writes ONLY for its own transaction. This is now the ONLY defence
-- against a row planted for another transaction, because the seventh round
-- deleted the `xmin` filter that used to stand beside it; M18 is its red
-- proof (replacing it with a permissive policy opens the plant) and M15
-- measures the other direction (dropping it outright permits no write at
-- all, so it is fail-closed and broken rather than open).
CREATE POLICY catalog_grid_ctx_ledger_own_txid_insert ON catalog_grid_ctx_ledger
  FOR INSERT WITH CHECK (txid = pg_current_xact_id());

CREATE FUNCTION catalog_grid_90_ctx_record()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  -- Every statement appends. There is deliberately no "only if empty" test
  -- here: that test is what made the fifth round's store forgeable, because a
  -- value already present was never overwritten and the check then read the
  -- attacker's string as if a trigger had put it there. The check requires
  -- unanimity instead, which needs every write's identity, not the first.
  INSERT INTO catalog_grid_ctx_ledger (txid) VALUES (pg_current_xact_id());
  RETURN NULL;
END;
$fn$;

COMMENT ON FUNCTION catalog_grid_90_ctx_record() IS
  'Phase 11 Pack A, finding P1-01 (fifth challenge round, store replaced in the sixth). AFTER STATEMENT trigger function on the four relations C-APP-01 is written from: appends the principal and the request context of EVERY write of the transaction to catalog_grid_ctx_ledger, whose identity column is server-written. catalog_grid_closed_check requires that all of them agree and that they equal the identity at COMMIT. A deferred check run by a session that is no longer the session that wrote cannot see what it is judging, and an empty read must not reassure. EXECUTE is not granted: a trigger function is callable only as a trigger.';

CREATE FUNCTION catalog_grid_closed_check(p_business UUID, p_product UUID)
RETURNS VOID
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  r RECORD;
  v_rel TEXT;
  v_at_write TEXT;
  v_rows BIGINT;
  v_identities BIGINT;
BEGIN
  -- Blindness is a refusal, not a pass. Privilege is checkable; row-level
  -- visibility is not checkable from inside the read, so the privilege test
  -- is stated as what it is — the half that can be measured — and the
  -- visibility half rests on the writer's own policy obligation above.
  FOREACH v_rel IN ARRAY ARRAY['product_variants','product_matrix_axes',
                               'product_attribute_axes','product_attribute_values'] LOOP
    IF NOT has_table_privilege(v_rel, 'SELECT') THEN
      RAISE EXCEPTION 'catalog.matrix_grid_unverifiable: the grid-closure law cannot read %, so the state it is asked to judge is unknown; it refuses rather than passes', v_rel
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- The privilege test above is necessary and NOT sufficient, and finding
  -- P1-01 of the fifth round is the measurement that says so: every privilege
  -- can be held while the read returns nothing. See the long comment above
  -- catalog_grid_ctx_record(). The identity under which the state was written
  -- is recorded at statement time; if it is absent, or differs from the
  -- identity at this COMMIT, the read below is not a measurement.
  -- Read the ledger. The predicate is the transaction id and NOTHING ELSE,
  -- and the seventh challenge round is why: this read used to carry
  -- `AND l.xmin = pg_current_xact_id()::xid` as a second defence against a
  -- planted row, and that clause was a fail-open AND a refusal of lawful
  -- work. `pg_current_xact_id()` returns the TOP-LEVEL transaction id, while
  -- a row inserted inside a SUBtransaction carries the subtransaction's id as
  -- `xmin` -- measured in one probe, top level 20097 == 20097 true, the row
  -- written after `SAVEPOINT s1` 20098 vs 20097 false. A savepoint, a
  -- PL/pgSQL `BEGIN ... EXCEPTION` block and a nested transaction in most
  -- ORMs all open that subtransaction, so the clause silently discarded the
  -- ledger rows of an ordinary application shape. Both faces were measured as
  -- `daftar_app`:
  --   * FAIL-OPEN. The round-4 door run with the harmful chain inside a
  --     RELEASEd savepoint and one lawful top-level write under the
  --     committing identity: rc 0, NOT REFUSED, 1 live variant outside its
  --     grid committed. The identical chain at top level: rc 3,
  --     catalog.matrix_grid_unverifiable. The savepoint was the whole
  --     difference -- the ledger held the harmful row and the clause threw it
  --     away, so unanimity saw one agreeing identity and the closure read was
  --     then blind, which is the exact state the fifth and sixth rounds were
  --     spent closing.
  --   * AND A REFUSAL OF LAWFUL WORK. A wholly lawful grid build inside a
  --     RELEASEd savepoint: rc 3, because every row the recorder wrote was
  --     discarded and the check took its `v_rows = 0` branch. That is this
  --     file's own standing rule -- a guard that breaks a lawful write is a
  --     worse defect than the one it closes.
  -- The clause is DELETED, not repaired, and that is a claim about what it
  -- protected: nothing the `txid` predicate does not already protect. A row
  -- visible here with `txid = pg_current_xact_id()` can only have been
  -- written by this transaction. Another transaction cannot insert one --
  -- the RLS `WITH CHECK (txid = pg_current_xact_id())` refuses it, measured
  -- by name as `daftar_app` -- and an uncommitted stranger's row is not
  -- visible in this snapshot at all. `txid` is `xid8`, epoch-extended, so the
  -- key does not wrap and there is no 32-bit comparison left to stand alone.
  -- Rows written inside a ROLLED BACK savepoint stay invisible, which is
  -- correct: work that was undone has no identity to answer for.
  -- PostgreSQL does not expose the subtransaction-to-top-level mapping from
  -- SQL, so a repaired comparison was not available even in principle; the
  -- deletion is the remedy. Re-adding the clause is mutation M20, and M20 is
  -- NOT green: measured, the savepoint exploit COMMITS again (PA7-S1 fails
  -- with `no error`, and PA7-S6 then reads sp=2, outside=1) while the lawful
  -- savepoint build is REFUSED (PA7-S3). Pack A 115 cases, 6 failed on pass 1
  -- and 21 on pass 2; the later arms' failures are collateral of the exploit
  -- landing on a shared database, and M20's own header says so.
  SELECT count(*), count(DISTINCT l.recorded_identity), min(l.recorded_identity)
    INTO v_rows, v_identities, v_at_write
    FROM catalog_grid_ctx_ledger l
   WHERE l.txid = pg_current_xact_id();

  IF v_rows = 0 THEN
    RAISE EXCEPTION 'catalog.matrix_grid_unverifiable: no write identity was recorded for this transaction, so the grid-closure law cannot know whether the session judging the state is the session that wrote it; it refuses rather than passes'
      USING ERRCODE = 'P0001';
  END IF;
  -- UNANIMITY. Not "the first write agrees with the commit": a transaction
  -- that wrote as A, wrote as B and came back to A to commit passed that test
  -- and does not pass this one. It is also what makes a forged row harmless:
  -- any row whose identity disagrees is a refusal, never a pass.
  IF v_identities > 1 THEN
    RAISE EXCEPTION 'catalog.matrix_grid_unverifiable: this transaction recorded % different write identities across % writing statements, so the grid-closure law cannot say which session wrote the state it is judging; it refuses rather than passes', v_identities, v_rows
      USING ERRCODE = 'P0001';
  END IF;
  IF v_at_write <> catalog_grid_ctx_identity() THEN
    RAISE EXCEPTION 'catalog.matrix_grid_unverifiable: this transaction wrote as [%] and is committing as [%]; the committing session cannot see what the writing session wrote, so the law refuses rather than passing on an empty read', v_at_write, catalog_grid_ctx_identity()
      USING ERRCODE = 'P0001';
  END IF;

  FOR r IN
    SELECT v.id,
           v.attributes,
           jsonb_typeof(v.attributes) AS vtype,
           (SELECT coalesce(array_agg(k ORDER BY k), ARRAY[]::TEXT[])
              FROM jsonb_object_keys(v.attributes) k
             WHERE jsonb_typeof(v.attributes) = 'object')              AS named,
           (SELECT coalesce(array_agg(ma.axis_code ORDER BY ma.axis_code), ARRAY[]::TEXT[])
              FROM product_matrix_axes ma
             WHERE ma.business_id = v.business_id
               AND ma.product_id  = v.product_id)                      AS registered
      FROM product_variants v
     WHERE v.business_id = p_business
       AND v.product_id  = p_product
       AND NOT v.is_base
       AND v.status <> 'archived'
  LOOP
    IF r.vtype <> 'object' THEN
      RAISE EXCEPTION 'catalog.variant_attributes_shape_invalid: live variant % carries attributes that are not a flat object [deferred grid closure at COMMIT]', r.id
        USING ERRCODE = 'P0001';
    END IF;
    -- One law, one name: the empty set names zero of the product's axes and
    -- a partial set names some of them, which is what
    -- variant_axis_set_incomplete has said since round 0. The site is named
    -- in the message so a pair-drop can tell which defence answered.
    IF r.named IS DISTINCT FROM r.registered THEN
      RAISE EXCEPTION 'catalog.variant_axis_set_incomplete: live variant % names {%} while its product''s matrix registers {%}; a variant outside the grid is a costing identity nothing can address [deferred grid closure at COMMIT]',
        r.id, array_to_string(r.named, ','), array_to_string(r.registered, ',')
        USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_each_text(r.attributes) e
                WHERE NOT EXISTS (SELECT 1 FROM product_attribute_axes ax
                                   WHERE ax.business_id = p_business
                                     AND ax.axis_code   = e.key
                                     AND ax.status      = 'active')) THEN
      RAISE EXCEPTION 'catalog.variant_axis_archived: live variant % names an axis that is not active in this business [deferred grid closure at COMMIT]', r.id
        USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_each_text(r.attributes) e
                WHERE NOT EXISTS (SELECT 1 FROM product_attribute_values av
                                   WHERE av.business_id = p_business
                                     AND av.axis_code   = e.key
                                     AND av.value_code  = e.value
                                     AND av.status      = 'active')) THEN
      RAISE EXCEPTION 'catalog.variant_axis_value_unregistered: live variant % names a value that is not an active value of its axis [deferred grid closure at COMMIT]', r.id
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
END;
$fn$;
REVOKE ALL ON FUNCTION catalog_grid_closed_check(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog_grid_closed_check(UUID, UUID) TO daftar_app;

COMMENT ON FUNCTION catalog_grid_closed_check(UUID, UUID) IS
  'Phase 11 Pack A, finding P1-01 (fourth challenge round). Recomputes C-APP-01 for one (business, product): every LIVE non-base variant names exactly the matrix''s current axis codes, and every axis and value it names is active. Raises variant_axis_set_incomplete / variant_axis_archived / variant_axis_value_unregistered, each tagged "deferred grid closure at COMMIT", or matrix_grid_unverifiable when it lacks the privilege to look. SECURITY INVOKER: a definer reads nothing through product_variants'' restrictive policy.';

-- The trigger adapter. Which products a write can disturb depends on which
-- relation was written, and that mapping is the only per-relation knowledge
-- here: the LAW itself is one function, called once per affected product.
--   product_variants, product_matrix_axes  -> the row's own product
--   product_attribute_axes                 -> every product of the business
--                                             whose live variants name the axis
--   product_attribute_values               -> every product of the business
--                                             whose live variants name the value
-- A base-variant write returns without reading this pack's registries,
-- because the law is about non-base variants and because
-- `daftar_inventory_internal` — the only principal 0053 allows to write a base
-- variant — holds no SELECT on them. A check that refused that lawful write would be a new
-- defect, so the early return is deliberate and is asserted in section 7.
CREATE FUNCTION product_grid_90_closed()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_row     RECORD;
  r         RECORD;
BEGIN
  v_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  -- The relation test is NESTED rather than conjoined, and that is a
  -- measured correction rather than a style choice: plpgsql evaluates an IF
  -- condition as one SQL expression with no short-circuit, so
  -- `TG_TABLE_NAME = 'product_variants' AND v_row.is_base` raised
  -- `record "v_row" has no field "is_base"` on the first registry write of
  -- the fixture. A guard that errors on a lawful write is a worse defect
  -- than the one it was added to close.
  -- ── THE READ-BACK OF THE ROW THAT QUEUED THIS CHECK, AND WHY IT IS NOT HERE ──
  -- Finding P1-01 of the fifth round came with two remedies, and the
  -- challenger and the coordinator both preferred the second: have this
  -- function hand the written row's identity into the check and refuse when it
  -- cannot read back the very row whose write queued it. One EXISTS. "A
  -- deferred check that cannot see the row that fired it is blind by
  -- definition."
  --
  -- It was implemented, in exactly that form, and MEASURED -- and the
  -- measurement rejects it as a refusal. A transaction that INSERTs a row and
  -- DELETEs it again before COMMIT is lawful and ordinary (this suite's own
  -- sweep does it twice, to exercise an INSERT privilege without leaving the
  -- fixture changed). At COMMIT the queued INSERT's row is absent, the
  -- read-back fails, and the law refuses a transaction that broke nothing:
  --   INSERT product_attribute_axes 'sightedaxis'; ...; DELETE it; COMMIT;
  --   -> catalog.matrix_grid_unverifiable   (a lawful write, refused)
  -- "Absent" has two causes -- invisible, and deleted later in the same
  -- transaction -- and this function cannot tell them apart: that is the same
  -- sentence as the finding itself, one level down. A guard that refuses a
  -- lawful write is a worse defect than the one it closes (measured twice in
  -- this pack now: this, and the plpgsql IF that errored on a registry write).
  --
  -- So the arm that closes the finding is the WRITE-IDENTITY comparison in
  -- catalog_grid_closed_check: it answers "am I still the session that wrote
  -- this", which has one cause, has the same answer for every statement kind
  -- (a deleted row cannot be read back at all, so the read-back has no answer
  -- for DELETE), and refuses exactly the thing the exploit needs. The
  -- recommended remedy is recorded here as REJECTED BY MEASUREMENT rather than
  -- silently dropped, the way this pack recorded the SECURITY DEFINER
  -- recommendation of the first round.
  IF TG_TABLE_NAME IN ('product_variants', 'product_matrix_axes') THEN
    IF TG_TABLE_NAME = 'product_variants' THEN
      IF v_row.is_base THEN
        RETURN NULL;
      END IF;
    END IF;
    PERFORM catalog_grid_closed_check(v_row.business_id, v_row.product_id);
    -- An UPDATE that MOVES a row between products leaves two products to
    -- judge, and judging only the new one is how a verb escapes a state
    -- check. Both are judged whenever the key moved.
    IF TG_OP = 'UPDATE' AND (OLD.business_id, OLD.product_id)
                         IS DISTINCT FROM (NEW.business_id, NEW.product_id) THEN
      PERFORM catalog_grid_closed_check(OLD.business_id, OLD.product_id);
    END IF;
  ELSE
    FOR r IN
      SELECT DISTINCT v.business_id, v.product_id
        FROM product_variants v
       WHERE v.business_id = v_row.business_id
         AND NOT v.is_base
         AND v.status <> 'archived'
         AND v.attributes ? CASE WHEN TG_OP = 'DELETE' THEN OLD.axis_code ELSE NEW.axis_code END
    LOOP
      PERFORM catalog_grid_closed_check(r.business_id, r.product_id);
    END LOOP;
    IF TG_OP = 'UPDATE' AND OLD.axis_code IS DISTINCT FROM NEW.axis_code THEN
      FOR r IN
        SELECT DISTINCT v.business_id, v.product_id
          FROM product_variants v
         WHERE v.business_id = OLD.business_id
           AND NOT v.is_base
           AND v.status <> 'archived'
           AND v.attributes ? OLD.axis_code
      LOOP
        PERFORM catalog_grid_closed_check(r.business_id, r.product_id);
      END LOOP;
    END IF;
  END IF;
  RETURN NULL;
END;
$fn$;

COMMENT ON FUNCTION product_grid_90_closed() IS
  'Phase 11 Pack A, finding P1-01. Deferred constraint trigger function on product_variants, product_matrix_axes, product_attribute_axes and product_attribute_values, for INSERT, UPDATE and DELETE. Derives the affected (business, product) set from the written row and calls catalog_grid_closed_check for each. Returns without reading for a base-variant write, which the law does not cover and whose only principal holds no SELECT on this pack''s registries. No EXECUTE grant.';

CREATE TRIGGER product_variants_01_grid_ctx
  AFTER INSERT OR UPDATE OR DELETE ON product_variants
  FOR EACH STATEMENT EXECUTE FUNCTION catalog_grid_90_ctx_record();

CREATE TRIGGER product_matrix_axes_01_grid_ctx
  AFTER INSERT OR UPDATE OR DELETE ON product_matrix_axes
  FOR EACH STATEMENT EXECUTE FUNCTION catalog_grid_90_ctx_record();

CREATE TRIGGER product_attribute_axes_01_grid_ctx
  AFTER INSERT OR UPDATE OR DELETE ON product_attribute_axes
  FOR EACH STATEMENT EXECUTE FUNCTION catalog_grid_90_ctx_record();

CREATE TRIGGER product_attribute_values_01_grid_ctx
  AFTER INSERT OR UPDATE OR DELETE ON product_attribute_values
  FOR EACH STATEMENT EXECUTE FUNCTION catalog_grid_90_ctx_record();


CREATE CONSTRAINT TRIGGER product_variants_90_grid_closed
  AFTER INSERT OR UPDATE OR DELETE ON product_variants
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION product_grid_90_closed();

CREATE CONSTRAINT TRIGGER product_matrix_axes_90_grid_closed
  AFTER INSERT OR UPDATE OR DELETE ON product_matrix_axes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION product_grid_90_closed();

CREATE CONSTRAINT TRIGGER product_attribute_axes_90_grid_closed
  AFTER INSERT OR UPDATE OR DELETE ON product_attribute_axes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION product_grid_90_closed();

CREATE CONSTRAINT TRIGGER product_attribute_values_90_grid_closed
  AFTER INSERT OR UPDATE OR DELETE ON product_attribute_values
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION product_grid_90_closed();

-- ── What this check does NOT close, measured rather than assumed ──────────
-- MPR-09 stands and is now narrower. "No stock outside the grid" has a
-- second half this pack cannot reach: a movement posted onto an ARCHIVED
-- variant. Nothing in the frozen core refuses it (measured in round 3: a
-- stock_levels row with on_hand 5.0000 on an archived variant is accepted,
-- and no trigger on stock_levels or stock_movements reads
-- product_variants.status), and this check cannot see it either — it judges
-- LIVE variants, and a transaction that writes only the ledger fires no
-- trigger of this pack at all. Reading stock_levels from here would not fix
-- that: the write that creates the forbidden state is in the OTHER
-- transaction, so there is nothing to judge at this commit.
-- So the residual is stated exactly: the grid is closed over the catalogue,
-- and "a movement is not posted onto an archived variant" is the inventory
-- authority's obligation, requested as MPR-09. Under Option B the variant IS
-- the costing key, so a live variant outside the grid is a stock identity
-- outside the grid whether or not it currently holds units — which is why
-- the law above is stated over the catalogue's own relations and is
-- decidable there, and why the ledger read was NOT added as a clause that
-- would be sound only inside one transaction.

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

-- ── The decidable part of "a qualifier true of every row" (finding PA-04) ──
-- The third independent challenge attacked the NAMED tautology list this
-- pack's end-state assertion carried, as the author asked it to, and
-- measured two spellings through it: `2 > 1` and `business_id IS NOT NULL`,
-- both stored by the catalogue as qualifiers, both true of every row, both
-- passing a list of four literal spellings. The challenge is right that no
-- form of this test can be both sound and complete — "true of every row" is
-- not decidable in SQL — and right that the list is the weakest of the sound
-- forms. It named two stronger ones, and both are taken here:
--
--   Form 1, the list, kept for the spellings a reviewer will recognise.
--   Form 2, EVALUATION: a qualifier that parses with no relation in scope
--           names no column of the relation, so its value does not vary by
--           row — the engine's own parser decides that, not a pattern. The
--           expression is evaluated; if it is TRUE, it is a tautology for
--           every row of that relation. `2 > 1` and any arithmetic constant
--           are in this class.
--   Form 3, NOT NULL: `(col IS NOT NULL)` over a column the catalogue marks
--           `attnotnull` is provably true of every row.
--
-- Sound and still incomplete, which is the same bargain the list made with
-- more reach, and the residual (a qualifier true of every row that none of
-- the three forms sees) stays routed to PR-SEC-P11-01 rather than claimed
-- closed. Two limits of form 2 are stated because they are real: it is
-- evaluated under the INSTALLING session's settings, so a qualifier like
-- `app_bypass()` alone reads false at install and could read true later; and
-- a volatile function inside it is called once here rather than per row. Its
-- input is never user text — it is `pg_get_expr` of a policy already stored
-- on one of this pack's five relations, and the set pin above means the
-- qualifier can only be one of two policies the pack installed itself.
-- ── The same text-pin weakness Pack B measured, fixed in this pack too ────
-- Finding P3-01 of the fourth round was reported against Pack B: an
-- end-state assertion searching `pg_get_functiondef` for the name of the arm
-- it pins proves WHICH FUNCTION WAS EXAMINED, not what the function does,
-- because `pg_get_functiondef` includes the comments. Two of this pack's
-- proof cases have the same shape (`proofs.py`, the unreachable
-- archived-axis branch and the MPR-09 trigger count), so the same stripper
-- exists here rather than waiting for a challenger to report the identical
-- finding against this file. It reads `prosrc`, so the header and the
-- COMMENT ON are not part of the subject, and it removes `--` and `/* */`
-- comments from the body.
--
-- The two packs now carry the same function under two names, which is
-- deliberate and recorded: a pack must not require a relation or a routine
-- created by another pack (it is applied alone, in its own transaction).
-- ONE implementation at assembly is MPR-10's work, and MPR-10 now names
-- this pair as well as the tautology test.
CREATE FUNCTION catalog_prosrc_uncommented(p_fn TEXT)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT regexp_replace(
           regexp_replace(p.prosrc, '/\*.*?\*/', ' ', 'gs'),
           '--[^' || chr(10) || ']*', ' ', 'g')
    FROM pg_proc p
   WHERE p.oid = p_fn::regprocedure;
$fn$;
REVOKE ALL ON FUNCTION catalog_prosrc_uncommented(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog_prosrc_uncommented(TEXT) TO daftar_app;

COMMENT ON FUNCTION catalog_prosrc_uncommented(TEXT) IS
  'Phase 11 Pack A, finding P3-01 (reported against Pack B, fixed in both). The comment-stripped prosrc of a function, for text pins: pg_get_functiondef includes comments, so a pin over it can be satisfied by a comment. Weaker than a behavioural case and labelled as such wherever it is used. MPR-10: one implementation with Pack B''s inventory_prosrc_uncommented at assembly.';

-- Form 3 and form 4 both rest on one catalogue fact -- is this column NOT
-- NULL -- so it is read in one place. Namespace-qualified, which is the
-- class the third challenge round made this pack fix everywhere (finding
-- PA-03): `relname` alone is not a name.
CREATE FUNCTION catalog_relation_column_is_notnull(p_relname TEXT, p_col TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT coalesce((SELECT a.attnotnull
                     FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
                    WHERE c.relnamespace = 'public'::regnamespace
                      AND c.relname = p_relname
                      AND a.attname  = p_col
                      AND a.attnum > 0 AND NOT a.attisdropped), false);
$fn$;
REVOKE ALL ON FUNCTION catalog_relation_column_is_notnull(TEXT, TEXT) FROM PUBLIC;

CREATE FUNCTION catalog_policy_qual_is_tautology(p_relname TEXT, p_qual TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_col TEXT;
  v_val BOOLEAN;
BEGIN
  IF p_qual IS NULL OR btrim(p_qual) = '' THEN
    RETURN true;                      -- no USING clause at all
  END IF;
  IF p_qual IN ('true', '(1 = 1)', 'true::boolean', '(true)') THEN
    RETURN true;                      -- form 1
  END IF;
  BEGIN                               -- form 2
    EXECUTE format('SELECT (%s) IS TRUE', p_qual) INTO v_val;
    IF v_val THEN
      RETURN true;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;                             -- it names a column, or will not evaluate
  END;
  v_col := substring(p_qual from '^\(?([a-z_][a-z0-9_]*) IS NOT NULL\)?$');
  IF v_col IS NOT NULL THEN           -- form 3
    IF catalog_relation_column_is_notnull(p_relname, v_col) THEN
      RETURN true;
    END IF;
  END IF;
  -- ── Form 4: the column compared with ITSELF (finding P2-01, round 4) ────
  -- The fourth independent challenge measured six of fifteen spellings
  -- through this function, and one of them is not a spelling at all but a
  -- working hole: `(business_id = business_id)` installed as the USING and
  -- WITH CHECK of `tenant_membership` -- the policy NAME unchanged, so the
  -- set pin three lines up passes -- made a cross-tenant read return 6 rows
  -- instead of 0 and a cross-tenant INSERT return rc=0 instead of rc=3.
  -- Measured in BOTH directions, which is why it is answered here rather
  -- than routed. It is decidable by exactly the test form 3 already uses: a
  -- column compared with itself is TRUE of every row the column is not NULL
  -- in, so over an attnotnull column it is true of every row, full stop.
  --
  -- `IS NOT DISTINCT FROM` needs no such premise: it is true of every row
  -- including the NULL ones, so nullability is not consulted for it. The
  -- negated form `NOT (col <> col)` is the same tautology written backwards
  -- and is matched over an attnotnull column for the same reason as `=`.
  --
  -- This does NOT make the function complete, and the four spellings the
  -- challenge measured as still passing (`(business_id = ANY (ARRAY[...]))`
  -- over the full key set among them) stay named in
  -- P11-MIGRATION-PATCH-REQUEST.md §12.2 as PR-SEC-P11-01's work. The
  -- function is a list of DECIDABLE forms, not a decision procedure, and
  -- the end-state assertion beside it says so.
  v_col := substring(p_qual from '^\(?([a-z_][a-z0-9_]*) IS NOT DISTINCT FROM \1\)?$');
  IF v_col IS NOT NULL THEN
    RETURN true;
  END IF;
  v_col := substring(p_qual from '^\(?([a-z_][a-z0-9_]*) = \1\)?$');
  IF v_col IS NULL THEN
    v_col := substring(p_qual from '^\(?NOT \(?([a-z_][a-z0-9_]*) <> \1\)?\)?$');
  END IF;
  IF v_col IS NOT NULL AND catalog_relation_column_is_notnull(p_relname, v_col) THEN
    RETURN true;
  END IF;
  RETURN false;
END;
$fn$;
REVOKE ALL ON FUNCTION catalog_policy_qual_is_tautology(TEXT, TEXT) FROM PUBLIC;

-- ── THE LEDGER'S GRANTS, GENERATED FROM THE CATALOGUE ───────────────────────
-- Not a hand-written role list. Every role that holds ANY write privilege on
-- any of the four relations can fire the recorder, so every such role needs
-- `INSERT (txid)` on the ledger, `SELECT` on it, and `EXECUTE` on the identity
-- function — and no other role needs any of them. The enumeration is the same
-- `relacl`/`attacl` sweep that found `daftar_app`'s write path on
-- `product_variants` by generation rather than by review (round 4, P1-01), and
-- `information_schema` is NOT used: its views filter by the enabled role and
-- hide column-scoped grants (the P5 §7 lesson).
--
-- It runs HERE, after every grant this pack makes, and the honest account of
-- why is a PRECAUTION, not a fix: measured both ways, the two positions
-- enumerate the same three roles (`daftar_app`, `daftar_inventory_internal`
-- and the owner), because `daftar_app`'s write path on `product_variants`
-- comes from frozen history rather than from this pack's own grants. It is
-- placed last so that a grant added to this pack LATER cannot leave a writer
-- unable to fire the recorder without anything saying so -- a sweep over the
-- catalogue measures the catalogue as it is at the moment it runs, and the
-- moment is a property of the file's order.
--
-- What is deliberately NOT granted, to anyone: UPDATE and DELETE on the
-- ledger, and INSERT on `recorded_identity`. Those three absences are what
-- make a recorded identity unforgeable and unremovable, and the end-state
-- assertion below re-reads all three from the catalogue rather than trusting
-- this block to have run.
DO $grants$
DECLARE
  v_role TEXT;
  v_n    INT := 0;
BEGIN
  FOR v_role IN
    SELECT DISTINCT grantee FROM (
      SELECT coalesce(g.rolname, 'PUBLIC') AS grantee, a.privilege_type
        FROM pg_class c
        CROSS JOIN LATERAL aclexplode(c.relacl) a
        LEFT  JOIN pg_roles g ON g.oid = a.grantee
       WHERE c.relnamespace = 'public'::regnamespace
         AND c.relname IN ('product_variants','product_matrix_axes',
                           'product_attribute_axes','product_attribute_values')
      UNION ALL
      SELECT coalesce(g.rolname, 'PUBLIC') AS grantee, a.privilege_type
        FROM pg_attribute att
        JOIN pg_class c ON c.oid = att.attrelid
        CROSS JOIN LATERAL aclexplode(att.attacl) a
        LEFT  JOIN pg_roles g ON g.oid = a.grantee
       WHERE c.relnamespace = 'public'::regnamespace
         AND c.relname IN ('product_variants','product_matrix_axes',
                           'product_attribute_axes','product_attribute_values')
         AND att.attnum > 0 AND NOT att.attisdropped
    ) q
     WHERE q.privilege_type IN ('INSERT','UPDATE','DELETE')
       AND q.grantee <> 'PUBLIC'
     ORDER BY 1
  LOOP
    EXECUTE format('GRANT SELECT ON catalog_grid_ctx_ledger TO %I', v_role);
    EXECUTE format('GRANT INSERT (txid) ON catalog_grid_ctx_ledger TO %I', v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION catalog_grid_ctx_identity() TO %I', v_role);
    v_n := v_n + 1;
  END LOOP;
  -- A sweep that grants to nobody would leave every lawful write failing on
  -- the recorder, which is the shape this pack refuses to ship: a guard that
  -- breaks a lawful write is worse than the defect it closes.
  IF v_n = 0 THEN
    RAISE EXCEPTION 'catalog.migration_end_state_invalid: the generated ledger grant found no role holding a write privilege on the four relations, so either the sweep is wrong or the relations are ungranted; refusing to apply a recorder no role can fire'
      USING ERRCODE = 'P0001';
  END IF;
  RAISE NOTICE 'Phase 11 Pack A: ledger grants generated for % role(s) from relacl/attacl', v_n;
END;
$grants$;

-- PUBLIC loses EXECUTE on the identity function; the enumerated roles keep it.
REVOKE EXECUTE ON FUNCTION catalog_grid_ctx_identity() FROM PUBLIC;

-- ── 7. End-state assertion: the migration refuses itself rather than warn ───
DO $$
DECLARE
  r RECORD;
  r2 RECORD;
  v_rels TEXT[] := ARRAY['product_attribute_axes','product_attribute_axis_translations',
                         'product_attribute_values','product_attribute_value_translations',
                         'product_matrix_axes'];
  v_name TEXT;
BEGIN
  -- ── Every catalogue lookup below is NAMESPACE-QUALIFIED (finding PA-03) ─
  -- The third independent challenge measured the policy-set pin against a
  -- `chal_other.product_matrix_axes` carrying one wide policy: the pin's own
  -- query returned `{business_isolation,tenant_membership,zzz_wide}`, three
  -- policies of two different relations in one array. It fails CLOSED — the
  -- pack refuses to install, naming a policy set that is not its relation's
  -- — so it was a diagnosability defect rather than a hole; and it is the
  -- same unqualified-catalogue shape that was fixed for `pg_proc.proname` one
  -- round earlier, found again in the place the fix did not look. So the
  -- class is closed rather than the instance: every lookup in this block
  -- carries `c.relnamespace = 'public'::regnamespace` (or `table_schema`),
  -- not only the one that was reported. `relname` alone is not a name.
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
         WHERE c.relnamespace = 'public'::regnamespace AND c.relname = v_name AND p.polname = 'tenant_membership' AND p.polwithcheck IS NOT NULL) <> 1 THEN
      RAISE EXCEPTION 'catalog.migration_end_state_invalid: % lacks tenant_membership WITH CHECK', v_name USING ERRCODE='P0001';
    END IF;
    IF (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
         WHERE c.relnamespace = 'public'::regnamespace AND c.relname = v_name AND p.polname = 'business_isolation' AND NOT p.polpermissive) <> 1 THEN
      RAISE EXCEPTION 'catalog.migration_end_state_invalid: % lacks a restrictive business_isolation', v_name USING ERRCODE='P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.role_table_grants
                          WHERE table_schema = 'public' AND table_name = v_name AND grantee = 'PUBLIC') THEN
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
                          WHERE c.relnamespace = 'public'::regnamespace AND c.relname = v_name AND a.attnum > 0 AND NOT a.attisdropped
                            AND format_type(a.atttypid, NULL) IN ('numeric','money','double precision','real','bigint')) THEN
      RAISE EXCEPTION 'catalog.migration_end_state_invalid: % carries a column of a monetary type', v_name USING ERRCODE='P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
                          WHERE c.relnamespace = 'public'::regnamespace AND c.relname = v_name AND a.attnum > 0 AND NOT a.attisdropped
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
    -- ── The PUBLIC-policy pin, and what it can actually assert ──────────
    -- Finding P2-07's other half: a permissive policy applied to PUBLIC ORs
    -- with tenant_membership and switches isolation off for the commands it
    -- names. Measured in this phase's Pack B round, where a wrong-tenant
    -- read returned another business's rows.
    --
    -- Finding P3-N03.3 is right that the first form of this assertion was
    -- narrow: it added `coalesce(pg_get_expr(polqual,polrelid),'true') =
    -- 'true'`, so a permissive PUBLIC policy qualified `1=1`, or
    -- `business_id IS NOT NULL`, passed an assertion whose message claims
    -- the general case. The recommended form — pin on
    -- `polroles = '{0}' AND polpermissive` alone, since these relations own
    -- no legitimate PUBLIC policy at all — was implemented and MEASURED,
    -- and it is false: it refused the pack on its own `tenant_membership`,
    -- which is permissive and carries no TO clause, so `polroles = '{0}'`.
    -- Every relation of this pack owns exactly one such policy by design.
    --
    -- The thing the assertion is actually about — "a qualifier that is true
    -- of every row" — is not decidable in SQL, so no form of it can be both
    -- sound and complete. What IS decidable is the policy SET: the pack
    -- refuses to install unless each of its relations carries exactly the
    -- two policies it reasoned about, which catches an added PUBLIC policy
    -- whatever its qualifier, and catches a removed one too. The qualifier
    -- test is kept beside it for the one case the set pin cannot see — the
    -- two policies themselves rewritten to a tautology — against a NAMED
    -- list of tautology spellings, stated as a list and not as a decision
    -- procedure. The residual (a qualifier true of every row that is not on
    -- the list) is answered by PR-SEC-P11-01, not pretended away here.
    IF (SELECT array_agg(p.polname::TEXT ORDER BY p.polname) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
         WHERE c.relnamespace = 'public'::regnamespace AND c.relname = v_name)
       IS DISTINCT FROM ARRAY['business_isolation','tenant_membership']::TEXT[] THEN
      RAISE EXCEPTION 'catalog.migration_end_state_invalid: % carries a policy set this pack did not install (%)', v_name,
        coalesce((SELECT string_agg(p.polname, ',' ORDER BY p.polname) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE c.relnamespace = 'public'::regnamespace AND c.relname = v_name), 'none')
        USING ERRCODE='P0001';
    END IF;
    FOR r2 IN SELECT p.polname::TEXT AS polname,
                     coalesce(pg_get_expr(p.polqual, p.polrelid), 'true') AS qual,
                     coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') AS chk
                FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
               WHERE c.relnamespace = 'public'::regnamespace
                 AND c.relname = v_name AND p.polpermissive LOOP
      IF catalog_policy_qual_is_tautology(v_name, r2.qual) THEN
        RAISE EXCEPTION 'catalog.migration_end_state_invalid: %''s permissive policy % is qualified by a tautology (%), which switches tenant isolation off for the commands it names', v_name, r2.polname, r2.qual USING ERRCODE='P0001';
      END IF;
      -- The WITH CHECK half is the write direction of the same hole, and it
      -- was not asserted at all before this round: a permissive policy whose
      -- USING is sound and whose WITH CHECK is a tautology accepts another
      -- tenant's INSERT. Measured in Pack B's round 1 in the read direction;
      -- asserted here in both.
      IF r2.chk <> '' AND catalog_policy_qual_is_tautology(v_name, r2.chk) THEN
        RAISE EXCEPTION 'catalog.migration_end_state_invalid: %''s permissive policy % has a tautological WITH CHECK (%), which accepts a write from any tenant', v_name, r2.polname, r2.chk USING ERRCODE='P0001';
      END IF;
    END LOOP;
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
      ('product_matrix_axes_10_axis_in_use',       'product_matrix_axes',      false, true,  true),
      ('product_attribute_values_10_value_in_use', 'product_attribute_values', false, true,  true),
      ('product_attribute_axes_10_axis_in_use',    'product_attribute_axes',   false, false, true),
      ('product_matrix_axes_20_axis_active',       'product_matrix_axes',      true,  false, true),
      -- Finding P1-N01: the ADD direction. INSERT only, and the assertion
      -- says INSERT only, because a guard that also fired on UPDATE OF
      -- axis_position would refuse re-ordering a grid nobody has populated.
      ('product_matrix_axes_30_set_frozen',        'product_matrix_axes',      true,  false, false)
    ) AS t(tg, rel, needs_insert, needs_delete, needs_update)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
                    WHERE g.tgname = r.tg AND c.relnamespace = 'public'::regnamespace AND c.relname = r.rel AND NOT g.tgisinternal
                      AND (g.tgtype & 4)  = CASE WHEN r.needs_insert THEN 4  ELSE 0 END
                      AND (g.tgtype & 8)  = CASE WHEN r.needs_delete THEN 8  ELSE 0 END
                      AND (g.tgtype & 16) = CASE WHEN r.needs_update THEN 16 ELSE 0 END) THEN
      RAISE EXCEPTION 'catalog.migration_end_state_invalid: trigger % on % is absent or does not cover the statement kinds it must', r.tg, r.rel USING ERRCODE='P0001';
    END IF;
    -- INVOKER, deliberately and measurably: a DEFINER variant of these
    -- guards cannot satisfy product_variants' RESTRICTIVE business_isolation
    -- without a session context, and silently allowed every removal (see the
    -- comment above the first guard). Asserted so the "fix" cannot be
    -- re-applied later without this assertion refusing it.
    -- The challenger's second note: this matched `pg_proc.proname` with no
    -- schema, so a same-named function in another schema would have
    -- answered for the one actually attached to the trigger. The function
    -- under test is the one the trigger calls, so it is read through
    -- pg_trigger.tgfoid.
    IF EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
                JOIN pg_proc pr ON pr.oid = g.tgfoid
                WHERE g.tgname = r.tg AND c.relnamespace = 'public'::regnamespace AND c.relname = r.rel AND NOT g.tgisinternal
                  AND pr.prosecdef) THEN
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
       WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'product_variants')
     IS DISTINCT FROM ARRAY['business_isolation','tenant_membership']::TEXT[] THEN
    RAISE EXCEPTION 'catalog.migration_end_state_invalid: product_variants carries a policy set this pack did not reason about (%); the three in-use guards conclude absence from a read of it and must be re-proved against the new set',
      (SELECT string_agg(p.polname, ',' ORDER BY p.polname) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'product_variants')
      USING ERRCODE='P0001';
  END IF;
  -- ── The deferred grid-closure check, finding P1-01 of the fourth round ──
  -- Four doors in four rounds reached one state, so the state is checked at
  -- COMMIT on every relation it is written from. The assertion names the
  -- relation, the three statement kinds, the DEFERRED timing and the fact
  -- that it is a constraint trigger -- because each of those is a way the
  -- check could be present and not answer: an IMMEDIATE copy would refuse
  -- the ordinary act of building a grid, and a non-constraint AFTER trigger
  -- would fire per statement and see the half-built one.
  FOR r IN SELECT unnest(ARRAY['product_variants','product_matrix_axes',
                               'product_attribute_axes','product_attribute_values']) AS rel
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
                    WHERE c.relnamespace = 'public'::regnamespace AND c.relname = r.rel
                      AND g.tgname = r.rel || '_90_grid_closed' AND NOT g.tgisinternal
                      AND g.tgconstraint <> 0            -- it IS a constraint trigger
                      AND g.tgdeferrable AND g.tginitdeferred
                      AND (g.tgtype & 2) = 0             -- AFTER, not BEFORE
                      AND (g.tgtype & 1) = 1             -- FOR EACH ROW
                      AND (g.tgtype & 4) = 4 AND (g.tgtype & 8) = 8 AND (g.tgtype & 16) = 16) THEN
      RAISE EXCEPTION 'catalog.migration_end_state_invalid: the deferred grid-closure constraint trigger on % is absent, is not deferred, or does not cover INSERT, UPDATE and DELETE', r.rel USING ERRCODE='P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_proc pr ON pr.oid = g.tgfoid
                JOIN pg_class c ON c.oid = g.tgrelid
                WHERE c.relnamespace = 'public'::regnamespace AND c.relname = r.rel
                  AND g.tgname = r.rel || '_90_grid_closed' AND pr.prosecdef) THEN
      RAISE EXCEPTION 'catalog.migration_end_state_invalid: the grid-closure check on % is SECURITY DEFINER; it concludes from a read of product_variants and a definer cannot satisfy its restrictive policy without a session context', r.rel USING ERRCODE='P0001';
    END IF;
  END LOOP;
  -- The law itself, asserted BEHAVIOURALLY rather than by name. A text pin
  -- over pg_get_functiondef proves which function was examined and not what
  -- it does -- that is finding P3-01 of Pack B's fourth round, and the same
  -- shape would be wrong here. So the function is CALLED.
  --
  -- The fourth round called it on a nonexistent product and asserted that it
  -- returned QUIETLY, and said the blindness arm could not be staged from
  -- inside an install that owns everything. Finding P1-01 of the FIFTH round
  -- turned that around: the installing session has written nothing to the four
  -- relations, so no write identity is recorded, so the check must REFUSE.
  -- That makes the blindness arm assertable here after all, behaviourally,
  -- at the one moment the pack can still refuse itself -- and an install whose
  -- check had been reverted to passing on an empty read is refused instead of
  -- shipped.
  BEGIN
    PERFORM catalog_grid_closed_check('00000000-0000-0000-0000-000000000000'::UUID,
                                      '00000000-0000-0000-0000-000000000000'::UUID);
    RAISE EXCEPTION 'catalog.migration_end_state_invalid: the grid-closure check returned quietly although this session recorded no write identity, so its blindness arm passes on an empty read' USING ERRCODE='P0001';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF position('catalog.matrix_grid_unverifiable' in SQLERRM) = 0 THEN
      RAISE;
    END IF;
  END;
  -- And the recorder itself, which the comparison depends on: four
  -- STATEMENT-level triggers, one per relation. A recorder that is absent
  -- makes every judgement refuse (fail closed), which is safe but would
  -- break every lawful write, so its absence is a refusal to install.
  FOR r IN SELECT unnest(ARRAY['product_variants','product_matrix_axes',
                               'product_attribute_axes','product_attribute_values']) AS rel
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
                    WHERE c.relnamespace = 'public'::regnamespace AND c.relname = r.rel
                      AND g.tgname = r.rel || '_01_grid_ctx' AND NOT g.tgisinternal
                      AND (g.tgtype & 1) = 0            -- FOR EACH STATEMENT
                      AND (g.tgtype & 2) = 0            -- AFTER
                      AND (g.tgtype & 4) = 4 AND (g.tgtype & 8) = 8 AND (g.tgtype & 16) = 16) THEN
      RAISE EXCEPTION 'catalog.migration_end_state_invalid: the write-identity recorder on % is absent or does not cover INSERT, UPDATE and DELETE as an AFTER STATEMENT trigger', r.rel USING ERRCODE='P0001';
    END IF;
  END LOOP;
  -- ── THE LEDGER, finding P1-01 of the SIXTH round ───────────────────────
  -- The remedy's content was right and its STORAGE was forgeable: the judged
  -- session could set the custom GUC the identity lived in. What is asserted
  -- here is not that the ledger exists but that the three ABSENCES which make
  -- a recorded identity unforgeable are real, read from the catalogue and not
  -- from the GRANT block above having run:
  --   (a) no role may write `recorded_identity` — it is a server-evaluated
  --       column DEFAULT, and a column ACL that admitted a writer would let a
  --       caller choose what is recorded about itself;
  --   (b) no role holding INSERT holds UPDATE or DELETE — a removable row
  --       defeats unanimity, because an attacker could delete the honest rows
  --       and leave its own;
  --   (c) RLS is ENABLED and FORCED and both own-transaction policies exist —
  --       the write policy is what makes a row planted for another
  --       transaction impossible rather than merely harmless.
  -- Each is a separate RAISE, so the log says which one is missing.
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace
                  AND relname = 'catalog_grid_ctx_ledger' AND relkind = 'r') THEN
    RAISE EXCEPTION 'catalog.migration_end_state_invalid: the write-identity ledger is absent, so the grid-closure check has nowhere unforgeable to read its identity from' USING ERRCODE='P0001';
  END IF;
  IF EXISTS (SELECT 1
               FROM pg_attribute att
               JOIN pg_class c ON c.oid = att.attrelid
               CROSS JOIN LATERAL aclexplode(att.attacl) a
              WHERE c.relnamespace = 'public'::regnamespace
                AND c.relname = 'catalog_grid_ctx_ledger'
                AND att.attname IN ('recorded_identity','recorded_at','id')
                AND a.grantee <> c.relowner
                AND a.privilege_type = 'INSERT') THEN
    RAISE EXCEPTION 'catalog.migration_end_state_invalid: a role may write catalog_grid_ctx_ledger.recorded_identity (or id/recorded_at) directly, so a caller can choose the identity recorded about itself and the comparison proves nothing' USING ERRCODE='P0001';
  END IF;
  -- The OWNER is excluded, and that is a limit rather than an oversight: an
  -- ACL materialises with the owner's own full entry as soon as any grant is
  -- made, and the owner of every relation in this schema can UPDATE, DELETE
  -- and DROP it in any case. The boundary this assertion defends is the set of
  -- roles the application runs as; the migration owner is outside it, which is
  -- the same statement every relation in the schema already rests on. The
  -- first version of this assertion did not exclude the owner and REFUSED the
  -- pack's own install -- recorded because a guard that refuses a lawful
  -- install is the shape this pack has now measured three times.
  IF EXISTS (SELECT 1
               FROM pg_class c
               CROSS JOIN LATERAL aclexplode(c.relacl) a
              WHERE c.relnamespace = 'public'::regnamespace
                AND c.relname = 'catalog_grid_ctx_ledger'
                AND a.grantee <> c.relowner
                AND a.privilege_type IN ('UPDATE','DELETE','TRUNCATE')) THEN
    RAISE EXCEPTION 'catalog.migration_end_state_invalid: a role holds UPDATE, DELETE or TRUNCATE on catalog_grid_ctx_ledger; a recorded identity that can be removed defeats unanimity, because the honest rows can be deleted and a forged one left behind' USING ERRCODE='P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace
                  AND relname = 'catalog_grid_ctx_ledger' AND relrowsecurity AND relforcerowsecurity) THEN
    RAISE EXCEPTION 'catalog.migration_end_state_invalid: catalog_grid_ctx_ledger does not have row-level security both ENABLED and FORCED, so a session can read or write another transaction''s recorded identity' USING ERRCODE='P0001';
  END IF;
  IF (SELECT array_agg(p.polname::TEXT ORDER BY p.polname) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
       WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'catalog_grid_ctx_ledger')
     IS DISTINCT FROM ARRAY['catalog_grid_ctx_ledger_own_txid_insert',
                            'catalog_grid_ctx_ledger_own_txid_select']::TEXT[] THEN
    RAISE EXCEPTION 'catalog.migration_end_state_invalid: catalog_grid_ctx_ledger carries a policy set this pack did not reason about; the own-transaction INSERT policy is one of the two defences against a planted row' USING ERRCODE='P0001';
  END IF;
  -- And the grant the recorder needs, in the other direction: a ledger no
  -- role can INSERT into makes every lawful write fail on the recorder. The
  -- generated block above refuses on zero roles; this re-reads the result.
  IF NOT EXISTS (SELECT 1
                   FROM pg_attribute att
                   JOIN pg_class c ON c.oid = att.attrelid
                   CROSS JOIN LATERAL aclexplode(att.attacl) a
                  WHERE c.relnamespace = 'public'::regnamespace
                    AND c.relname = 'catalog_grid_ctx_ledger'
                    AND att.attname = 'txid'
                    AND a.grantee <> c.relowner
                    AND a.privilege_type = 'INSERT') THEN
    RAISE EXCEPTION 'catalog.migration_end_state_invalid: no role holds INSERT (txid) on catalog_grid_ctx_ledger, so the recorder cannot run and every lawful write to the four relations would fail' USING ERRCODE='P0001';
  END IF;
  -- R7-06, the seventh challenge round. TRUNCATE on the four relations is a
  -- write NO TRIGGER COVERS: a statement trigger fires for INSERT, UPDATE and
  -- DELETE, and PostgreSQL's TRUNCATE triggers are a separate event this pack
  -- does not declare, so a role holding TRUNCATE could empty a product's grid
  -- with no ledger row written, no deferred check queued and nothing for
  -- unanimity to judge. Nothing in this pack or in frozen history grants it,
  -- which is exactly why it is asserted rather than assumed: an absence no
  -- instrument reads is the shape this phase keeps paying for, and the
  -- previous round paid for it again by calling an unreached clause inert.
  IF EXISTS (SELECT 1
               FROM pg_class c
               CROSS JOIN LATERAL aclexplode(c.relacl) a
              WHERE c.relnamespace = 'public'::regnamespace
                AND c.relname IN ('product_variants','product_matrix_axes',
                                  'product_attribute_axes','product_attribute_values')
                AND a.grantee <> c.relowner
                AND a.privilege_type = 'TRUNCATE') THEN
    RAISE EXCEPTION 'catalog.migration_end_state_invalid: a role holds TRUNCATE on one of the four relations the grid laws govern; TRUNCATE fires no statement trigger here, so it would empty the state with no recorded write identity and no deferred closure check' USING ERRCODE='P0001';
  END IF;
  IF (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'product_variants_matrix_uq' AND relkind = 'i') <> 1 THEN
    RAISE EXCEPTION 'catalog.migration_end_state_invalid: the matrix uniqueness index is absent' USING ERRCODE='P0001';
  END IF;
  -- The tautology test is now a function, so it is one implementation the
  -- proof suite can call directly with the spellings the challenge measured
  -- rather than a copy of the assertion's own SQL. Its reach is asserted
  -- here, so a pack whose function silently answered `false` to everything
  -- would refuse to install: the four spellings that must be caught, the
  -- pack's own real qualifier that must NOT be, and no EXECUTE for PUBLIC.
  IF NOT (catalog_policy_qual_is_tautology('product_matrix_axes','true')
          AND catalog_policy_qual_is_tautology('product_matrix_axes','(1 = 1)')
          AND catalog_policy_qual_is_tautology('product_matrix_axes','(2 > 1)')
          AND catalog_policy_qual_is_tautology('product_matrix_axes','(business_id IS NOT NULL)')
          -- Form 4, finding P2-01 of the fourth round. The first of these
          -- was MEASURED as a working cross-tenant hole with the policy name
          -- left intact, so the set pin above cannot see it; it is asserted
          -- here as well as in the proof suite because an install is the
          -- last moment at which this pack can refuse itself.
          AND catalog_policy_qual_is_tautology('product_matrix_axes','(business_id = business_id)')
          AND catalog_policy_qual_is_tautology('product_matrix_axes','(business_id IS NOT DISTINCT FROM business_id)')
          AND catalog_policy_qual_is_tautology('product_matrix_axes','(NOT (business_id <> business_id))')) THEN
    RAISE EXCEPTION 'catalog.migration_end_state_invalid: the tautology test does not catch the spellings it is documented to catch' USING ERRCODE='P0001';
  END IF;
  -- And the other direction, which is the arm that keeps the list honest: a
  -- function that answered `true` to everything would pass every assertion
  -- above. `(axis_position = 1)` is true of SOME rows and must not be called
  -- a tautology, and `(axis_code = axis_code)` over a NULLABLE column would
  -- not be one either -- there is no nullable column on this relation to
  -- state that with, so the premise is asserted on the catalogue directly.
  IF catalog_policy_qual_is_tautology('product_matrix_axes','(axis_position = 1)') THEN
    RAISE EXCEPTION 'catalog.migration_end_state_invalid: the tautology test calls a row-selective qualifier a tautology, so it would refuse correct installs' USING ERRCODE='P0001';
  END IF;
  IF NOT catalog_relation_column_is_notnull('product_matrix_axes','business_id')
     OR catalog_relation_column_is_notnull('product_matrix_axes','no_such_column') THEN
    RAISE EXCEPTION 'catalog.migration_end_state_invalid: the NOT NULL lookup forms 3 and 4 rest on does not answer from the catalogue' USING ERRCODE='P0001';
  END IF;
  -- The comment stripper, proved on this install rather than trusted: both
  -- failure directions of finding P3-01's remedy are arms here. A stripper
  -- that returned nothing would make every pin that uses it vacuous; one
  -- that returned the body unchanged would leave the pins exactly as weak as
  -- the ones they replace.
  IF coalesce(catalog_prosrc_uncommented('public.product_variants_40_matrix_canonical()'), '') = '' THEN
    RAISE EXCEPTION 'catalog.migration_end_state_invalid: the comment stripper returns nothing, so every text pin over it is vacuous' USING ERRCODE='P0001';
  END IF;
  IF catalog_prosrc_uncommented('public.product_variants_40_matrix_canonical()') ~ '-- ' THEN
    RAISE EXCEPTION 'catalog.migration_end_state_invalid: the comment stripper left a comment in the body, so a pin over it can still be satisfied by a comment' USING ERRCODE='P0001';
  END IF;
  IF catalog_policy_qual_is_tautology('product_matrix_axes',
       (SELECT pg_get_expr(p.polqual, p.polrelid) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
         WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'product_matrix_axes'
           AND p.polname = 'tenant_membership')) THEN
    RAISE EXCEPTION 'catalog.migration_end_state_invalid: the tautology test calls this pack''s own tenant qualifier a tautology, so it would refuse every correct install' USING ERRCODE='P0001';
  END IF;
  IF has_function_privilege('public', 'catalog_policy_qual_is_tautology(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'catalog.migration_end_state_invalid: PUBLIC holds EXECUTE on the tautology test' USING ERRCODE='P0001';
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
