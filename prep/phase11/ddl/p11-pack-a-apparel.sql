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
CREATE FUNCTION catalog_policy_qual_is_tautology(p_relname TEXT, p_qual TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_col     TEXT;
  v_notnull BOOLEAN;
  v_val     BOOLEAN;
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
    SELECT a.attnotnull INTO v_notnull
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relname = p_relname
       AND a.attname = v_col AND a.attnum > 0 AND NOT a.attisdropped;
    IF coalesce(v_notnull, false) THEN
      RETURN true;
    END IF;
  END IF;
  RETURN false;
END;
$fn$;
REVOKE ALL ON FUNCTION catalog_policy_qual_is_tautology(TEXT, TEXT) FROM PUBLIC;

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
          AND catalog_policy_qual_is_tautology('product_matrix_axes','(business_id IS NOT NULL)')) THEN
    RAISE EXCEPTION 'catalog.migration_end_state_invalid: the tautology test does not catch the spellings it is documented to catch' USING ERRCODE='P0001';
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
