-- ===========================================================================
-- P11 PACK B — LOT / EXPIRY, UNNUMBERED
--
-- NO MIGRATION NUMBER. Not allocated, not reserved, not examined, not
-- exampled, not in this filename and not in any comment here. One Migration
-- Owner allocates at promotion, from the live prefix. This file is applied to
-- a THROW-AWAY scratch cluster, over the frozen prefix applied UNMODIFIED, to
-- make the laws of P11-CONSERVATION-LAWS-AND-RED-PROOFS.md something a run
-- can red rather than something a document asserts.
--
-- Scope of THIS file, stated so nobody reads more into it than ran:
--   IN  — the overlay's structure (lots, lot movements, the per-lot cache),
--         its append-only law, its no-money law, the deferred conservation
--         triggers, RLS, grants, the fold routine, and products' lot columns.
--   OUT — the writer change (patch request 3.6, `inventory_apply_stock_movements`)
--         and the FEFO picker. Until the writer carries lot assignments, the
--         triggers below are proven as TRIGGERS and the integration is
--         `WAITING_FOR_INTEGRATED_SURFACE`, never PASS.
--
-- OPTION B (`TL-P11-R1`, `P11-AL-02`): lot/serial extend the TRACEABILITY
-- identity and never the costing key. The costing key stays
-- (business_id, warehouse_id, variant_id) with its moving weighted average,
-- and NO relation here carries a monetary column — see the end-state
-- assertion, which fails the apply if one ever appears.
-- ===========================================================================

-- ─── 3.1 products: the lot switch, and its history lock ─────────────────────
ALTER TABLE products
  ADD COLUMN track_lot BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN expiry_policy TEXT NOT NULL DEFAULT 'refuse';

-- ONE admissible value in Phase 11 (`TL-P11-R4`). The column exists so a
-- future regulated pack can widen the CHECK with its own permission, audit
-- and policy; a second value that nothing enforces yet is an override waiting
-- to be set, so Phase 11 ships none.
ALTER TABLE products
  ADD CONSTRAINT products_expiry_policy_ck CHECK (expiry_policy IN ('refuse')),
  ADD CONSTRAINT products_lot_requires_tracking_ck CHECK (track_lot = false OR track_inventory = true);

-- ─── THE AUTHORITY THE PATCH REQUEST NEVER NAMED ───────────────────────────
-- `products_10_inventory_config_authority` binds `track_inventory`,
-- `unit_code` and `unit_decimals` to the owner of
-- `inventory_configure_product`: "inventory configuration is written only by
-- the inventory configuration command" (P3-AL-55). It cannot know about
-- `track_lot`, which did not exist when it froze — and the patch request
-- never said which principal owns the new column. As drafted, therefore,
-- `daftar_app` could switch lot tracking on any product itself, which is
-- inventory configuration written outside the inventory configuration
-- command. Found while building this pack's fixture, by reading that
-- trigger (PROVEN BY DATABASE CATALOGUE).
--
-- The frozen trigger is NOT edited. A new one is added at position `_05_`,
-- which fires FIRST in name order, because an authority check that runs
-- after another guard has already rewritten or refused the row is not an
-- authority check. It raises the SAME refusal as the existing site, because
-- it is the same law and a second name for one rule is a second truth.
CREATE FUNCTION products_05_lot_config_authority() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF current_user = 'daftar_inventory_internal' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.track_lot OR NEW.expiry_policy <> 'refuse' THEN
      RAISE EXCEPTION 'inventory.configuration_authority_required: inventory configuration is written only by the inventory configuration command'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.track_lot IS DISTINCT FROM OLD.track_lot
     OR NEW.expiry_policy IS DISTINCT FROM OLD.expiry_policy THEN
    RAISE EXCEPTION 'inventory.configuration_authority_required: inventory configuration is written only by the inventory configuration command'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER products_05_lot_config_authority BEFORE INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION products_05_lot_config_authority();

-- POSITION `_40_`, NOT `_30_`. `products_30_archive_requires_zero_stock`
-- already occupies 30 and PostgreSQL fires same-event triggers in NAME
-- order, so the patch request's `products_30_lot_history_lock` would have
-- been a silent ordering coin-flip between two guards — the same defect this
-- pack's apparel sibling already paid for on `product_variants`. Found here
-- by reading the catalogue BEFORE writing the file (PROVEN BY DATABASE
-- CATALOGUE), which is the only reason it cost nothing.
CREATE FUNCTION products_40_lot_history_lock() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.track_lot IS DISTINCT FROM OLD.track_lot
     AND EXISTS (SELECT 1 FROM stock_levels sl
                  JOIN product_variants v
                    ON v.business_id = sl.business_id AND v.id = sl.variant_id
                 WHERE v.business_id = OLD.business_id AND v.product_id = OLD.id) THEN
    RAISE EXCEPTION 'inventory.lot_tracking_history_locked: % already has stock history, so its lot tracking cannot change; the overlay would be missing for every movement already recorded', OLD.sku
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER products_40_lot_history_lock BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION products_40_lot_history_lock();

-- ─── THE GRANT WITHOUT WHICH THE AUTHORITY CANNOT WRITE ITS OWN COLUMNS ────
-- Measured, after the fixture was refused with "permission denied for table
-- products": `daftar_inventory_internal` holds **column-level** UPDATE on
-- exactly `track_inventory`, `unit_code` and `unit_decimals` — and SELECT on
-- everything else. So the two columns added above are, as drafted, writable
-- by nobody: the trigger admits only the internal principal, and the
-- internal principal has no UPDATE privilege on them. Lot tracking could
-- never be switched on at all.
--
-- `daftar_app`, by contrast, holds TABLE-level UPDATE on `products`, which
-- is precisely why `products_05_lot_config_authority` above is the real
-- protection and this grant is only about letting the owner in.
--
-- This is a privilege on an existing shared relation, so it is listed in
-- `P11-MIGRATION-PATCH-REQUEST.md` for the Security Authority explicitly
-- rather than slipped in with the pack's own tables.
GRANT UPDATE (track_lot, expiry_policy) ON products TO daftar_inventory_internal;

-- ─── AND THE EXECUTE THE CANONICAL-FORM CHECK NEEDS ────────────────────────
-- Measured, after the lot fixture was refused with "permission denied for
-- function catalog_identifier_norm": a CHECK constraint's expression is
-- evaluated with the WRITING principal's privileges, and
-- `catalog_identifier_norm` is granted EXECUTE to `daftar_migrator` and
-- `daftar_catalog_internal` only. So `stock_lots_code_canonical_ck` — which
-- exists so the overlay does not grow a SECOND normalization truth — would
-- make the table unwritable by the inventory authority that owns it.
--
-- The grant is minimal and crosses no authority: the routine is IMMUTABLE,
-- pure, reads no table and writes nothing, so EXECUTE on it confers no
-- catalog write. The alternative — normalizing inside the writer and
-- dropping the CHECK — would move canonicality out of the database, which
-- is exactly the kind of guarantee only the database can keep. Listed for
-- the Security Authority in the patch request.
GRANT EXECUTE ON FUNCTION catalog_identifier_norm(TEXT, TEXT) TO daftar_inventory_internal;

-- ─── 3.2 stock_lots ────────────────────────────────────────────────────────
CREATE TABLE stock_lots (
  tenant_id      UUID NOT NULL,
  business_id    UUID NOT NULL,
  id             UUID NOT NULL,
  variant_id     UUID NOT NULL,
  lot_code_norm  TEXT NOT NULL,
  lot_code_input TEXT NOT NULL,
  expiry_date    DATE,
  produced_on    DATE,
  received_seq   BIGINT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT stock_lots_pkey PRIMARY KEY (business_id, id),
  CONSTRAINT stock_lots_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT stock_lots_variant_fk FOREIGN KEY (business_id, variant_id) REFERENCES product_variants (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT stock_lots_code_uq UNIQUE (business_id, variant_id, lot_code_norm),
  CONSTRAINT stock_lots_seq_uq UNIQUE (business_id, variant_id, received_seq),
  -- so an overlay row can carry a composite FK that PINS the variant
  CONSTRAINT stock_lots_variant_key_uq UNIQUE (business_id, id, variant_id),
  CONSTRAINT stock_lots_code_norm_ck CHECK (char_length(lot_code_norm) BETWEEN 1 AND 64),
  CONSTRAINT stock_lots_code_input_ck CHECK (char_length(btrim(lot_code_input)) BETWEEN 1 AND 64),
  -- the normalizer is the catalogue's own, not a second normalization truth
  CONSTRAINT stock_lots_code_canonical_ck CHECK (lot_code_norm = catalog_identifier_norm('sku', lot_code_input)),
  CONSTRAINT stock_lots_dates_ck CHECK (expiry_date IS NULL OR produced_on IS NULL OR expiry_date >= produced_on),
  CONSTRAINT stock_lots_seq_ck CHECK (received_seq >= 1),
  -- `blocked` is a QUARANTINE, not a value change: a blocked lot keeps its
  -- quantity and its history and is merely unpickable.
  CONSTRAINT stock_lots_status_ck CHECK (status IN ('active','blocked','closed'))
);

CREATE INDEX stock_lots_picker_idx ON stock_lots (business_id, variant_id, expiry_date, received_seq);

-- ─── 3.3 stock_lot_movements — the overlay. No value column, ever ──────────
CREATE TABLE stock_lot_movements (
  tenant_id         UUID NOT NULL,
  business_id       UUID NOT NULL,
  stock_movement_id UUID NOT NULL,
  warehouse_id      UUID NOT NULL,
  variant_id        UUID NOT NULL,
  lot_id            UUID NOT NULL,
  qty_delta         NUMERIC(18,4) NOT NULL,
  CONSTRAINT stock_lot_movements_pkey PRIMARY KEY (business_id, stock_movement_id, lot_id),
  CONSTRAINT stock_lot_movements_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  -- FOUR columns, which `stock_movements_id_key_uq` is exactly the index for:
  -- the overlay row cannot name a movement of a different stock key.
  CONSTRAINT stock_lot_movements_movement_fk FOREIGN KEY (business_id, stock_movement_id, warehouse_id, variant_id)
    REFERENCES stock_movements (business_id, id, warehouse_id, variant_id),
  -- a lot of ANOTHER VARIANT is structurally impossible
  CONSTRAINT stock_lot_movements_lot_fk FOREIGN KEY (business_id, lot_id, variant_id)
    REFERENCES stock_lots (business_id, id, variant_id) ON DELETE RESTRICT,
  CONSTRAINT stock_lot_movements_qty_ck CHECK (qty_delta <> 0)
);

CREATE INDEX stock_lot_movements_lot_idx ON stock_lot_movements (business_id, warehouse_id, variant_id, lot_id);

-- The `stock_ledger_append_only()` twin. Reused rather than re-implemented:
-- it raises `inventory.ledger_immutable` naming TG_TABLE_NAME, which is
-- exactly this law, so a second function would be a second truth about the
-- same rule.
CREATE TRIGGER stock_lot_movements_append_only
  BEFORE UPDATE OR DELETE ON stock_lot_movements
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_append_only();

-- ─── 3.4 stock_lot_levels — derived cache, foldable ────────────────────────
CREATE TABLE stock_lot_levels (
  tenant_id         UUID NOT NULL,
  business_id       UUID NOT NULL,
  warehouse_id      UUID NOT NULL,
  variant_id        UUID NOT NULL,
  lot_id            UUID NOT NULL,
  on_hand           NUMERIC(18,4) NOT NULL,
  last_movement_seq BIGINT NOT NULL,
  CONSTRAINT stock_lot_levels_pkey PRIMARY KEY (business_id, warehouse_id, variant_id, lot_id),
  CONSTRAINT stock_lot_levels_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT stock_lot_levels_level_fk FOREIGN KEY (business_id, warehouse_id, variant_id)
    REFERENCES stock_levels (business_id, warehouse_id, variant_id),
  CONSTRAINT stock_lot_levels_lot_fk FOREIGN KEY (business_id, lot_id, variant_id)
    REFERENCES stock_lots (business_id, id, variant_id) ON DELETE RESTRICT,
  CONSTRAINT stock_lot_levels_on_hand_ck CHECK (on_hand >= 0),
  CONSTRAINT stock_lot_levels_seq_ck CHECK (last_movement_seq >= 0)
);

-- ─── 3.5 the deferred conservation triggers ────────────────────────────────
-- C-LOT-01 and its siblings. DEFERRABLE INITIALLY DEFERRED so a transaction
-- may write the movement and its overlay rows in either order and is judged
-- only on what it COMMITS — the `stock_levels_zero_on_hand_zero_value`
-- pattern. Written to survive `SET CONSTRAINTS ALL IMMEDIATE`, which is how
-- the Phase 3 R-94 finding was reached and how Phase 4 round 13's defect was
-- found: a deferred trigger that only holds while deferred is not a law.
CREATE FUNCTION stock_lot_movement_conservation() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_business  UUID;
  v_movement  UUID;
  v_warehouse UUID;
  v_variant   UUID;
  v_tracked   BOOLEAN;
  v_qty       NUMERIC;
  v_sum       NUMERIC;
  v_key       NUMERIC;
  v_cache     NUMERIC;
  v_rows      BIGINT;
  v_bad_sign  BIGINT;
BEGIN
  -- One function for both installations: the subject is the movement, and
  -- which table fired decides only where its id is read from.
  IF TG_TABLE_NAME = 'stock_movements' THEN
    v_business := NEW.business_id; v_movement := NEW.id;
  ELSE
    v_business := NEW.business_id; v_movement := NEW.stock_movement_id;
  END IF;

  -- ── FAIL CLOSED, and the comment this replaces was measurably wrong ──
  -- Finding P1-02 of the first independent challenge. This read is
  -- row-level-security filtered, and the arm below used to `RETURN NULL`:
  -- so a COMMIT by a principal or in a context that cannot SEE the movement
  -- skipped the whole law — missing allocation, sign disagreement and sum
  -- mismatch alike. Measured: the official command wrote a movement of 7 for
  -- a lot-tracked variant, the session then dropped to `daftar_app` and
  -- RESET both context settings, and the COMMIT returned 0 with a committed
  -- movement of 7 units belonging to no lot.
  --
  -- The justification written here was *"the movement was rolled back inside
  -- this transaction"*, and the challenger measured that it cannot reach this
  -- arm: PostgreSQL DISCARDS the queued after-trigger events of an aborted
  -- subtransaction, so a rolled-back INSERT never fires its own constraint
  -- trigger. Control measured on scratch objects: INSERT + COMMIT fires;
  -- INSERT inside a savepoint, ROLLBACK TO SAVEPOINT, COMMIT does not fire.
  -- The arm was therefore not a rollback accommodation — it was an RLS
  -- escape hatch with a comment on it.
  --
  -- This is the project's twice-ruled class (Phase 5's "a deferred check that
  -- reads under RLS fails open", Phase 13's case 11) and the remedy is the
  -- settled one: a fail-closed branch, NOT `SECURITY DEFINER` — a definer
  -- cannot satisfy the RESTRICTIVE `business_isolation` on these relations
  -- anyway, which Pack A measured this same day. A read that comes back
  -- empty no longer decides anything: it refuses, naming the fact that the
  -- law could not be evaluated, which is a different statement from the law
  -- being broken and says so.
  --
  -- No row lock is taken on the movement, and that is measured rather than
  -- assumed: `SELECT … FOR SHARE` needs UPDATE-class privilege on the
  -- relation, which every writer of `stock_movements` deliberately lacks
  -- (the ledger is append-only), so a first version of this read with
  -- `FOR SHARE` turned the fail-closed refusal into `permission denied for
  -- table stock_movements` — a refusal from the grant instead of from the
  -- law. Nothing is lost: the row was inserted by this same transaction and
  -- the relation is append-only, so there is no concurrent writer to order
  -- against. The cache side is a different question, answered in its own
  -- comment below.
  SELECT m.qty_delta INTO v_qty FROM stock_movements m
   WHERE m.business_id = v_business AND m.id = v_movement;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'inventory.lot_conservation_unverifiable: movement % cannot be read at COMMIT, so its lot allocation cannot be judged; the law refuses rather than passes', v_movement
      USING ERRCODE = 'P0001';
  END IF;

  SELECT p.track_lot, m.warehouse_id, m.variant_id INTO v_tracked, v_warehouse, v_variant
    FROM stock_movements m
    JOIN product_variants v ON v.business_id = m.business_id AND v.id = m.variant_id
    JOIN products p ON p.business_id = v.business_id AND p.id = v.product_id
   WHERE m.business_id = v_business AND m.id = v_movement;
  IF NOT FOUND THEN
    -- The same fail-closed rule one join further: the movement is visible but
    -- its product is not, so `track_lot` is unknown and `coalesce(…, false)`
    -- below would read "not lot-tracked" from an invisible row — an absence
    -- used as a negative answer, which is the defect class this round is
    -- about. (The read above is the catalogue's, under the same RLS.)
    RAISE EXCEPTION 'inventory.lot_conservation_unverifiable: the product of movement % cannot be read at COMMIT, so whether it is lot-tracked cannot be judged', v_movement
      USING ERRCODE = 'P0001';
  END IF;

  SELECT coalesce(sum(lm.qty_delta), 0), count(*),
         count(*) FILTER (WHERE sign(lm.qty_delta) <> sign(v_qty))
    INTO v_sum, v_rows, v_bad_sign
    FROM stock_lot_movements lm
   WHERE lm.business_id = v_business AND lm.stock_movement_id = v_movement;

  IF NOT coalesce(v_tracked, false) THEN
    IF v_rows > 0 THEN
      RAISE EXCEPTION 'inventory.lot_allocation_forbidden: movement % is for a variant that is not lot-tracked, so it may carry no lot allocation', v_movement
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NULL;
  END IF;

  IF v_rows = 0 THEN
    RAISE EXCEPTION 'inventory.lot_allocation_missing: movement % is for a lot-tracked variant and carries no lot allocation', v_movement
      USING ERRCODE = 'P0001';
  END IF;
  IF v_bad_sign > 0 THEN
    RAISE EXCEPTION 'inventory.lot_allocation_sign_invalid: movement % has a lot allocation whose sign disagrees with the movement', v_movement
      USING ERRCODE = 'P0001';
  END IF;
  IF v_sum <> v_qty THEN
    RAISE EXCEPTION 'inventory.lot_allocation_sum_mismatch: movement % moves % but its lot allocation sums to %', v_movement, v_qty, v_sum
      USING ERRCODE = 'P0001';
  END IF;

  -- ── C-LOT-03 from the side that MOVES the key (finding P1-01) ─────────
  -- The cache-versus-key comparison existed only as a constraint trigger on
  -- `stock_lot_levels`, so it fired only when the CACHE was written. The
  -- quantity it is compared against lives in `stock_levels`, and nothing
  -- fired when THAT side moved: a transaction that moved the key and wrote
  -- no cache row was not a transaction the law examined at all. Measured
  -- from a state every law in this pack accepts (key 8, cache 8): one more
  -- lot-tracked movement through the official command, with its allocation
  -- and no cache write, committed with **the key at 12 against a cache
  -- summing to 8** — two quantity truths disagreeing by 4, under
  -- `SET CONSTRAINTS ALL IMMEDIATE`. It was item 6 of this preparation's own
  -- "what a challenger should attack" list, and it attacked successfully.
  -- A guard on one write path is not a guard.
  --
  -- The comparison is therefore made HERE, where the movement is: this
  -- trigger has the key in hand and fires on every movement. It raises the
  -- SAME error as the cache-side trigger, deliberately — one law, one name,
  -- two reachable sites, rather than a second truth about the same rule.
  --
  -- SCOPE, stated rather than widened: the law enforced is *a per-lot cache
  -- that EXISTS for a key folds to that key's on-hand*. A key with NO cache
  -- row is still lawful, because the writer that maintains the cache is the
  -- integration of patch request §3.6 and does not exist at this SHA —
  -- `C-LOT-03`'s other half ("every lot-tracked key HAS a cache") stays
  -- `WAITING_FOR_INTEGRATED_SURFACE` and is not claimed. Enforcing it now
  -- would make this pack demand a writer nothing has written yet, which is
  -- how a preparation starts inventing the surface it is waiting for.
  --
  -- The `stock_levels` row is read WITHOUT a row lock, stated as a limit:
  -- `FOR SHARE` needs UPDATE-class privilege there too, and the principal a
  -- COMMIT runs as is not always the writer that holds it. In the official
  -- path nothing is lost, because `inventory_adjust_stock` holds a stronger
  -- lock on that very row in this same transaction — the lock is already
  -- held by the time this trigger fires. What is NOT proved by that is the
  -- case where the cache is written by one transaction while another moves
  -- the key: the cache writer is the integration that does not exist yet, so
  -- that race has no second party to run against at this SHA. It is carried
  -- as `UNMEASURED` in the laws document rather than reasoned away here, and
  -- the lock order belongs with the writer when it lands.
  PERFORM 1 FROM stock_lot_levels ll
   WHERE ll.business_id = v_business AND ll.warehouse_id = v_warehouse AND ll.variant_id = v_variant;
  IF FOUND THEN
    SELECT sl.on_hand INTO v_key FROM stock_levels sl
     WHERE sl.business_id = v_business AND sl.warehouse_id = v_warehouse AND sl.variant_id = v_variant;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'inventory.lot_conservation_unverifiable: the stock key of movement % cannot be read at COMMIT, so the per-lot cache cannot be judged against it', v_movement
        USING ERRCODE = 'P0001';
    END IF;
    SELECT coalesce(sum(ll.on_hand), 0) INTO v_cache FROM stock_lot_levels ll
     WHERE ll.business_id = v_business AND ll.warehouse_id = v_warehouse AND ll.variant_id = v_variant;
    IF v_cache <> v_key THEN
      RAISE EXCEPTION 'inventory.lot_level_conservation_violated: per-lot on-hand sums to % but the stock key holds % after movement %', v_cache, v_key, v_movement
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NULL;
END; $$;

CREATE CONSTRAINT TRIGGER stock_movements_lot_conservation
  AFTER INSERT ON stock_movements
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION stock_lot_movement_conservation();

CREATE CONSTRAINT TRIGGER stock_lot_movements_conservation
  AFTER INSERT ON stock_lot_movements
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION stock_lot_movement_conservation();

-- C-LOT-03: the per-lot cache folds to the stock key's own on-hand. The
-- cache is derived, so this is the law that makes it safe to read.
CREATE FUNCTION stock_lot_level_conservation() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_key_on_hand NUMERIC;
  v_lot_sum     NUMERIC;
BEGIN
  SELECT sl.on_hand INTO v_key_on_hand FROM stock_levels sl
   WHERE sl.business_id = NEW.business_id AND sl.warehouse_id = NEW.warehouse_id
     AND sl.variant_id = NEW.variant_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT coalesce(sum(ll.on_hand), 0) INTO v_lot_sum FROM stock_lot_levels ll
   WHERE ll.business_id = NEW.business_id AND ll.warehouse_id = NEW.warehouse_id
     AND ll.variant_id = NEW.variant_id;

  IF v_lot_sum <> v_key_on_hand THEN
    RAISE EXCEPTION 'inventory.lot_level_conservation_violated: per-lot on-hand sums to % but the stock key holds %', v_lot_sum, v_key_on_hand
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END; $$;

CREATE CONSTRAINT TRIGGER stock_lot_levels_conservation
  AFTER INSERT OR UPDATE ON stock_lot_levels
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION stock_lot_level_conservation();

-- ─── 3.7 the fold ─────────────────────────────────────────────────────────
-- The `inventory_stock_fold` twin, including its scope guard: a fold that
-- can be asked about another business's key is a cross-tenant read with a
-- friendly name. It folds QUANTITY ONLY — there is no per-lot value to fold,
-- which is Option B restated as code.
CREATE FUNCTION inventory_lot_fold(p_business_id UUID, p_warehouse_id UUID, p_variant_id UUID, p_lot_id UUID)
RETURNS TABLE(on_hand NUMERIC, last_movement_seq BIGINT, movement_count BIGINT)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  IF p_business_id IS NULL
     OR p_business_id IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'inventory.scope_mismatch: the stock key is not in the transaction''s business' USING ERRCODE = 'P0001';
  END IF;
  -- Finding P2-04: the fold refused on the business and ANSWERED on the
  -- tenant. With the right business and the tenant context dropped or
  -- foreign, row-level security filtered every row and the fold returned a
  -- confident `0` — measured against a lot that really held 3.0000. For a
  -- picker or an availability page `0` means "this lot is empty", and this
  -- project's standing lesson is that an RLS-hidden zero is never proof of
  -- absence. A function that refuses on one half of its scope and answers on
  -- the other is the inconsistency; the tenant half is now explicit, and it
  -- is checked here rather than left to RLS precisely because RLS answers by
  -- hiding rows and this function's answer is a NUMBER.
  --
  -- Measured by the challenger, and worth keeping: the frozen
  -- `inventory_stock_fold` does NOT behave this way — it answers with the
  -- tenant dropped, because the core relations carry a permissive
  -- `*_internal_read` policy for the principal it is reached through. The
  -- silent zero was this pack's own, not inherited.
  IF nullif(current_setting('app.tenant_id', true), '') IS NULL THEN
    RAISE EXCEPTION 'inventory.scope_mismatch: the transaction has no tenant context, so a per-lot quantity cannot be answered' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM stock_lots l
                  WHERE l.business_id = p_business_id AND l.id = p_lot_id AND l.variant_id = p_variant_id) THEN
    -- The lot is not visible to this caller: either it does not exist or the
    -- caller's tenant is not its tenant. Both are a refusal rather than a
    -- zero, for the same reason — a sum over rows nobody can see is not a
    -- measurement of anything.
    RAISE EXCEPTION 'inventory.scope_mismatch: lot % of this variant is not visible in the transaction''s scope, so its quantity is not answered as zero', p_lot_id USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  SELECT coalesce(sum(lm.qty_delta), 0)::NUMERIC,
         coalesce(max(m.stock_seq), 0)::BIGINT,
         count(*)::BIGINT
    FROM stock_lot_movements lm
    JOIN stock_movements m ON m.business_id = lm.business_id AND m.id = lm.stock_movement_id
   WHERE lm.business_id = p_business_id AND lm.warehouse_id = p_warehouse_id
     AND lm.variant_id = p_variant_id AND lm.lot_id = p_lot_id;
END; $$;

-- Finding P2-03: this function is `SECURITY DEFINER`, is owned by
-- `daftar_migrator` (which owns every relation in the pack), and carried NO
-- grant of its own — so `EXECUTE` was PUBLIC by default. Measured as
-- `daftar_reconciler`, a role with no privilege of any kind on the overlay:
-- a direct `SELECT` on `stock_lot_movements` was refused "permission denied",
-- and the same quantity came back through this function. The frozen twin it
-- is modelled on does not have that shape: `inventory_stock_fold` is owned by
-- `daftar_inventory_internal` and its ACL names that role explicitly. Row-level
-- security still scoped the read, so this was a GRANT boundary and not a
-- tenant boundary — and a definer function owned by the tables' owner is
-- exactly the object whose reach has to be stated. Stated here, and asserted
-- over `proacl` in the end-state block so it cannot drift.
REVOKE EXECUTE ON FUNCTION inventory_lot_fold(UUID, UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_lot_fold(UUID, UUID, UUID, UUID) TO daftar_inventory_internal;
GRANT EXECUTE ON FUNCTION inventory_lot_fold(UUID, UUID, UUID, UUID) TO daftar_app;

-- ─── 3.8 lot FACTS are not freely rewritable (P3 of the challenge) ────────
-- `expiry_policy` admits only `refuse`, and a policy of refusal over a
-- rewritable date is weaker than it reads: measured,
-- `UPDATE stock_lots SET expiry_date = '2099-01-01'` on an expired lot
-- returned rc=0, and `received_seq` — which the picker's index orders by —
-- deserved the same question. Nothing in the pack CLAIMED these were
-- immutable, so this is a gap in the law set rather than a broken law, and
-- it is closed in the direction the pack already chose for a mistyped
-- variant combination: correctable while nothing depends on it, frozen once
-- history does. A receipt typo is real and must be fixable; a lot whose
-- movements exist is a thing the ledger has already spoken about.
CREATE FUNCTION stock_lots_10_facts_frozen_once_moved() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.expiry_date IS NOT DISTINCT FROM OLD.expiry_date
     AND NEW.produced_on IS NOT DISTINCT FROM OLD.produced_on
     AND NEW.received_seq IS NOT DISTINCT FROM OLD.received_seq
     AND NEW.lot_code_norm IS NOT DISTINCT FROM OLD.lot_code_norm THEN
    RETURN NEW;
  END IF;
  -- The same fail-closed discipline as the conservation trigger: this read
  -- is RLS-filtered, and an empty read here would license the rewrite. The
  -- ledger is append-only, so a lot that any movement names is frozen; the
  -- read is of the overlay the pack owns.
  -- Plain read, for the same measured reason as the conservation trigger:
  -- the overlay is append-only and no writer holds UPDATE-class privilege on
  -- it, so `FOR SHARE` would answer `permission denied` instead of the law.
  PERFORM 1 FROM stock_lot_movements lm
   WHERE lm.business_id = OLD.business_id AND lm.lot_id = OLD.id;
  IF FOUND THEN
    RAISE EXCEPTION 'inventory.lot_facts_frozen: lot % is named by movements, so its code, dates and receipt order are facts the ledger has already recorded; quarantine it (status blocked) or receive a new lot', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER stock_lots_10_facts_frozen_once_moved
  BEFORE UPDATE OF expiry_date, produced_on, received_seq, lot_code_norm, lot_code_input ON stock_lots
  FOR EACH ROW EXECUTE FUNCTION stock_lots_10_facts_frozen_once_moved();

-- ─── RLS: the inventory family's shape, measured not assumed ───────────────
-- `tenant_id` denormalized with the composite FK, the restrictive
-- `business_isolation` naming the internal principal in USING ONLY (so the
-- internal role may read across businesses but write only its own), the
-- `*_internal_read` policy, and `tenant_membership` with BOTH clauses — and
-- all of it in the same file that enables RLS, because P4-S7 learned that a
-- relation with RLS and zero policies refuses everything rather than only
-- the incomplete cases.
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['stock_lots','stock_lot_movements','stock_lot_levels'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', r);
    EXECUTE format($f$CREATE POLICY business_isolation ON %I AS RESTRICTIVE
      USING (app_bypass() OR CURRENT_USER = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid)
      WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid)$f$, r);
    EXECUTE format($f$CREATE POLICY tenant_membership ON %I
      USING (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
      WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)$f$, r);
    -- `TO daftar_inventory_internal`, and the clause is not optional.
    -- MEASURED: without it the policy is PERMISSIVE and applies to PUBLIC,
    -- and permissive policies are OR-ed — so a blanket `USING (true)` for
    -- everyone silently switches `tenant_membership` OFF for every SELECT,
    -- leaving only the restrictive business check. The overlay then let a
    -- session with the right business and the WRONG TENANT read its rows.
    -- Caught by the negative case that sets a foreign tenant and expects
    -- zero rows; no positive test can see it. The live `stock_levels`
    -- carries the role clause, which is what this now copies.
    EXECUTE format($f$CREATE POLICY inventory_internal_read ON %I FOR SELECT TO daftar_inventory_internal USING (true)$f$, r);
    EXECUTE format('GRANT SELECT ON %I TO daftar_app', r);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO daftar_inventory_internal', r);
  END LOOP;
  -- The cache is the only relation the writer UPDATEs, and only these two
  -- columns. No DELETE anywhere: a lot level, once created, is retained with
  -- its history, exactly as `stock_levels` is.
  EXECUTE 'GRANT UPDATE (on_hand, last_movement_seq) ON stock_lot_levels TO daftar_inventory_internal';
END $$;

-- ─── END-STATE ASSERTION ──────────────────────────────────────────────────
-- The apply FAILS if any of this is not true, so a silent partial install is
-- not a possible outcome.
DO $$
DECLARE n INT; bad TEXT;
BEGIN
  -- L-P11-02: no monetary column on any Phase 11 relation, not even one
  -- commented as report-only. The names are the inventory family's own
  -- monetary vocabulary.
  SELECT string_agg(table_name||'.'||column_name, ', ') INTO bad
    FROM information_schema.columns
   WHERE table_name IN ('stock_lots','stock_lot_movements','stock_lot_levels')
     AND (column_name ~ '(minor|price|cost|value|amount|currency|valuation)');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'P11 end-state: a monetary column appeared on the overlay: %', bad; END IF;

  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
   WHERE ns.nspname='public' AND c.relname IN ('stock_lots','stock_lot_movements','stock_lot_levels')
     AND c.relrowsecurity AND c.relforcerowsecurity;
  IF n <> 3 THEN RAISE EXCEPTION 'P11 end-state: RLS enabled+forced on % of 3 overlay relations', n; END IF;

  SELECT count(*) INTO n FROM pg_policy
   WHERE polrelid IN ('stock_lots'::regclass,'stock_lot_movements'::regclass,'stock_lot_levels'::regclass);
  IF n <> 9 THEN RAISE EXCEPTION 'P11 end-state: % policies on the overlay, expected 9', n; END IF;

  -- append-only, and the twin rather than a second implementation
  SELECT count(*) INTO n FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
   WHERE t.tgrelid='stock_lot_movements'::regclass AND NOT t.tgisinternal
     AND p.proname='stock_ledger_append_only';
  IF n <> 1 THEN RAISE EXCEPTION 'P11 end-state: the overlay ledger is not append-only by the existing twin'; END IF;

  -- the deferred conservation triggers exist AND are deferred
  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgname IN ('stock_movements_lot_conservation','stock_lot_movements_conservation','stock_lot_levels_conservation')
     AND tgdeferrable AND tginitdeferred;
  IF n <> 3 THEN RAISE EXCEPTION 'P11 end-state: % of 3 conservation triggers are DEFERRABLE INITIALLY DEFERRED', n; END IF;

  -- no DELETE privilege for any runtime principal on any overlay relation
  SELECT string_agg(grantee||' on '||table_name, ', ') INTO bad
    FROM information_schema.table_privileges
   WHERE table_name IN ('stock_lots','stock_lot_movements','stock_lot_levels')
     AND privilege_type='DELETE' AND grantee <> 'daftar_migrator';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'P11 end-state: a runtime principal may DELETE overlay history: %', bad; END IF;

  -- the expiry policy admits exactly one value
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid='products'::regclass AND conname='products_expiry_policy_ck'
     AND pg_get_constraintdef(oid) ~ 'refuse';
  IF n <> 1 THEN RAISE EXCEPTION 'P11 end-state: the expiry policy CHECK is not the single-value one'; END IF;

  -- the history lock sits at 40, after the three occupied positions
  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgrelid='products'::regclass AND tgname='products_40_lot_history_lock';
  IF n <> 1 THEN RAISE EXCEPTION 'P11 end-state: the lot history lock is not at position 40 on products'; END IF;

  -- the new column is authority-bound, and its guard fires before the others
  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgrelid='products'::regclass AND tgname='products_05_lot_config_authority';
  IF n <> 1 THEN RAISE EXCEPTION 'P11 end-state: track_lot is not bound to the inventory configuration authority'; END IF;

  -- the authority can actually write the columns it owns
  SELECT count(*) INTO n FROM information_schema.column_privileges
   WHERE table_name='products' AND grantee='daftar_inventory_internal'
     AND privilege_type='UPDATE' AND column_name IN ('track_lot','expiry_policy');
  IF n <> 2 THEN RAISE EXCEPTION 'P11 end-state: the inventory authority cannot UPDATE its own lot columns (% of 2 grants)', n; END IF;

  -- and may execute the normalizer its own CHECK calls
  IF NOT has_function_privilege('daftar_inventory_internal', 'catalog_identifier_norm(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P11 end-state: the lot writer cannot execute the canonical-form function its own CHECK calls';
  END IF;

  -- no permissive policy on the overlay applies to PUBLIC: that is how a
  -- blanket read policy disables tenant isolation.
  SELECT string_agg(c.relname||'.'||p.polname, ', ') INTO bad
    FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
   WHERE c.relname IN ('stock_lots','stock_lot_movements','stock_lot_levels')
     AND p.polpermissive AND p.polroles = '{0}'::oid[]
     AND pg_get_expr(p.polqual, p.polrelid) = 'true';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'P11 end-state: a blanket permissive policy applies to PUBLIC, which switches tenant isolation off for SELECT: %', bad; END IF;

  -- Finding P2-03: the definer fold's own reach, asserted so it cannot drift
  -- back to the default. PUBLIC must hold no EXECUTE on it, and the two
  -- principals the convention names must hold one.
  IF has_function_privilege('public', 'inventory_lot_fold(uuid,uuid,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P11 end-state: PUBLIC may EXECUTE the SECURITY DEFINER fold, so a role with no privilege on the overlay reads quantities through it';
  END IF;
  IF NOT (has_function_privilege('daftar_inventory_internal', 'inventory_lot_fold(uuid,uuid,uuid,uuid)', 'EXECUTE')
          AND has_function_privilege('daftar_app', 'inventory_lot_fold(uuid,uuid,uuid,uuid)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'P11 end-state: the fold is not executable by the principals that need it';
  END IF;

  -- Finding P1-01: the cache-versus-key comparison must be reachable from the
  -- side that MOVES the key, not only from the side that writes the cache.
  -- Asserted on the function's own text, because the defect was that one of
  -- two sites existed: a future edit that removes the comparison from the
  -- movement path would leave the other trigger in place and the hole open.
  IF position('lot_level_conservation_violated' in
              pg_get_functiondef('stock_lot_movement_conservation()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'P11 end-state: the movement-side conservation trigger no longer compares the per-lot cache with the stock key';
  END IF;
  -- Finding P1-02: and it must FAIL CLOSED when it cannot read the movement.
  IF position('lot_conservation_unverifiable' in
              pg_get_functiondef('stock_lot_movement_conservation()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'P11 end-state: the conservation trigger has no fail-closed arm, so a COMMIT that cannot see its movement would skip the law';
  END IF;

  -- P3: lot facts are frozen once the ledger names the lot
  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgrelid='stock_lots'::regclass AND tgname='stock_lots_10_facts_frozen_once_moved';
  IF n <> 1 THEN RAISE EXCEPTION 'P11 end-state: a lot''s dates and receipt order are rewritable after it has movements'; END IF;

  RAISE NOTICE 'P11 PACK B end-state assertion passed: 17 checks';
END $$;
