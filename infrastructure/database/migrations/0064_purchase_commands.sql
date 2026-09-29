-- 0064_purchase_commands.sql
-- P3-S4, part 2 — the COMMAND side: the seven signed entry routines for
-- suppliers (create, update, archive, reactivate) and purchases (save draft,
-- cancel, receive), the three internal receipt helpers, and the seven
-- operation kinds with their two op→movement mappings, LAST
-- (docs/PHASE_3_S4_CONTRACT.md §2.4, §2.5, §2.8, A-03, A-07-A-13, A-16,
-- A-17, A-21).
--
-- Every entry routine is owned by daftar_inventory_internal, SECURITY
-- DEFINER with the pinned path, PUBLIC revoked, and reachable by daftar_app
-- only. Its FIRST statement consumes a signed invctl/1 assertion over the
-- digest of ALL its own arguments (the 0055/0062 pattern); nothing is read,
-- locked or written before that. No routine reads a clock for a bound date:
-- the FX instant is derived from the document date and the business
-- timezone (R-17). No tax arithmetic exists: a non-zero tax is refused
-- `purchase.tax_policy_absent` (A-12, OD-03).
--
-- ── Engineering rulings taken here (documented for the report) ──────────
--
--   R-25 THE RECEIPT TAKES THE STOCK KEYS THROUGH THE PRIMITIVE, TWICE.
--        `purchase_lock_receipt_targets` takes lock step 6's shared target
--        keys, the A-19 re-checks and the products FOR SHARE, but does NOT
--        pre-lock existing `stock_levels` rows: the internal principal may
--        not create a key outside the primitive, so pre-locking only the
--        existing keys would take keys out of the primitive's
--        (warehouse, variant) order — a deadlock against a concurrent
--        receipt that creates the missing key (0062 R-7). Instead the
--        purchase movements are applied first (one primitive call: it
--        creates and locks every key in order), the deficit layers are
--        locked and covered UNDER those key locks (6b, R-15), and the
--        coverage value-only movements are a second primitive call. Per
--        key the movement order is A-16(f)'s — the purchase movement, then
--        its coverages in FIFO order — because a purchase holds one line
--        per variant; only the cross-key interleaving of the ordinals
--        differs. The coverage arithmetic reads the key after the purchase
--        movement, exactly the state A-16(b)-(e) describes.
--   R-26 INTENTS AND THE DOCUMENT KEY. A full-payload command's intent
--        (A-10(b): supplier.*, purchase.draft, purchase.cancel) is its
--        verified payload digest: component 7 of the consumed carrier,
--        which consume has just proved equal to the digest of the routine's
--        own arguments. The receipt's intent is `inventory_payload_digest`
--        over (purchase_id, warehouse_id, draft_revision) under the verified
--        tenant and business. Every entry routine takes its document key
--        ('daftar.purchase_id' | 'daftar.supplier_id') BEFORE it reads any
--        intent or row (the R-14 analogue; 0064-E (6)).
--   R-27 `p_lc_allocations` is read in element order (row-major), so both a
--        landed_count × line_count array and its flat one-dimensional form
--        are accepted; the flat length must be landed_count × line_count.
--   R-28 `rate_at` is bound as its integral epoch seconds; an instant with a
--        fractional second has no canonical integer text, so its claimed
--        digest is NULL and no assertion can match it.
--   R-29 A field-shape error (missing or mis-sized array, NULL element,
--        untrimmed or empty text, a previous warehouse named when the
--        warehouse does not move, a line or landed-cost id repeated or used
--        by another purchase) is `inventory.payload_invalid`; the contract's
--        typed codes are raised wherever it names one.
--   R-30 A base total B ≤ 0 is `purchase.total_zero` (the journal refuses a
--        zero line, 0042); an amount beyond 10^18 is
--        `inventory.value_out_of_range`.
--   R-31 A create (expected revision 0, or supplier.create) against an
--        existing id whose stored intent differs is
--        `purchase.idempotency_conflict` / `supplier.idempotency_conflict`.
--   R-32 The FX read keeps the accounting codes of R-22; the service refuses
--        `purchase.fx_rate_missing` before minting (A-17).
--   R-33 A draft checks its warehouse and variants (existence, status,
--        tracking, stock identity, unit precision) without the stock-target
--        locks: a draft writes no stock, and the receipt re-checks all of it
--        under lock step 6 and in the primitive.
--
-- Migrations 0000-0063 are untouched.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Internal receipt helpers (no grant; §2.4 "Helpers").
-- ─────────────────────────────────────────────────────────────────────────

-- Lock step 6 before the primitive (R-25): SHARED advisory keys on the
-- warehouse and every variant in id order (the archive triggers take them
-- EXCLUSIVE), the A-19 re-checks as seen after them, then the products
-- FOR SHARE in id order.
CREATE OR REPLACE FUNCTION purchase_lock_receipt_targets(p_warehouse UUID, p_variants UUID[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor   inventory_verified_actor;
  v_id      UUID;
  v_status  TEXT;
  v_pstatus TEXT;
  v_tracked BOOLEAN;
BEGIN
  v_actor := inventory_assertion_current(ARRAY['purchase.receive']);
  IF p_warehouse IS NULL OR p_variants IS NULL OR array_position(p_variants, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a receipt names its warehouse and variants' USING ERRCODE = 'P0001';
  END IF;
  FOR v_id IN
    SELECT DISTINCT x.id FROM unnest(ARRAY[p_warehouse] || p_variants) AS x(id) ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock_shared(hashtext('daftar.stock_target'), hashtext(v_id::text));
  END LOOP;

  SELECT w.status INTO v_status FROM warehouses w WHERE w.business_id = v_actor.business_id AND w.id = p_warehouse;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'inventory.warehouse_not_found: the warehouse does not exist in this business' USING ERRCODE = 'P0001';
  END IF;
  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'inventory.warehouse_archived: the warehouse is archived' USING ERRCODE = 'P0001';
  END IF;

  FOR v_id IN SELECT DISTINCT x.id FROM unnest(p_variants) AS x(id) ORDER BY 1 LOOP
    SELECT pv.status, p.status, p.track_inventory INTO v_status, v_pstatus, v_tracked
    FROM product_variants pv
    JOIN products p ON p.business_id = pv.business_id AND p.id = pv.product_id
    WHERE pv.business_id = v_actor.business_id AND pv.id = v_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'inventory.variant_not_found: the variant does not exist in this business' USING ERRCODE = 'P0001';
    END IF;
    IF v_status <> 'active' OR v_pstatus <> 'active' THEN
      RAISE EXCEPTION 'inventory.variant_archived: the variant or its product is archived' USING ERRCODE = 'P0001';
    END IF;
    IF NOT v_tracked THEN
      RAISE EXCEPTION 'inventory.product_not_tracked: the product does not track inventory' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  PERFORM 1 FROM products p
   WHERE p.business_id = v_actor.business_id
     AND p.id IN (SELECT pv.product_id FROM product_variants pv WHERE pv.business_id = v_actor.business_id AND pv.id = ANY (p_variants))
   ORDER BY p.id
   FOR SHARE;
END;
$$;

COMMENT ON FUNCTION purchase_lock_receipt_targets(UUID, UUID[]) IS
  'P3-S4 §2.4, R-15 step 6, R-25. Re-verifies the transaction''s consumed purchase.receive assertion, takes SHARED advisory locks (daftar.stock_target) on the warehouse and every variant in id order, requires the warehouse to exist and be active and every variant to exist, be active with an active product and be tracked (inventory.warehouse_not_found / _archived, variant_not_found / _archived, product_not_tracked), then locks the products FOR SHARE in id order. Stock keys are locked by the primitive, in its own order. Internal-owned, no grant.';

-- A-16(b)-(i): the coverage of the receipt's open deficit layers, run
-- AFTER the purchase movements (R-25) and under their key locks. Writes the
-- coverage header complete, its coverage rows and the deficit decrements;
-- returns the coverages in movement order (line_no, then FIFO) with the
-- value each one's value-only movement must carry (0: no movement, TL-5).
CREATE OR REPLACE FUNCTION purchase_cover_deficits(p_purchase_id UUID, p_adjustment_id UUID)
RETURNS TABLE (
  line_id                UUID,
  variant_id             UUID,
  coverage_id            UUID,
  deficit_id             UUID,
  qty_covered            NUMERIC,
  value_delta_base_minor BIGINT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_actor     inventory_verified_actor;
  v_business  UUID;
  v_wh        UUID;
  v_date      DATE;
  v_status    TEXT;
  v_trace     UUID;
  v_line      RECORD;
  v_layer     RECORD;
  v_actual    NUMERIC;
  v_on_hand   NUMERIC;
  v_val       NUMERIC;
  v_deficit   NUMERIC;
  v_remaining NUMERIC;
  v_c         NUMERIC;
  v_value     NUMERIC;
  v_closes    BOOLEAN;
  v_total     NUMERIC;
  v_n         INTEGER;
  v_lines     UUID[];
  v_variants  UUID[];
  v_ids       UUID[];
  v_deficits  UUID[];
  v_qtys      NUMERIC[];
  v_provs     NUMERIC[];
  v_actuals   NUMERIC[];
  v_values    BIGINT[];
BEGIN
  v_actor := inventory_assertion_current(ARRAY['purchase.receive']);
  v_business := v_actor.business_id;
  SELECT p.warehouse_id, p.document_date, p.status INTO v_wh, v_date, v_status
  FROM purchases p WHERE p.business_id = v_business AND p.id = p_purchase_id;
  IF NOT FOUND OR v_status <> 'draft' THEN
    RAISE EXCEPTION 'purchase.state_invalid: deficits are covered only by the receipt of a draft purchase' USING ERRCODE = 'P0001';
  END IF;

  -- Lock step 6b: every open layer of the receipt's keys, FOR UPDATE, keys
  -- in (warehouse, variant) order and (deficit_seq, id) within a key. The
  -- keys themselves are held by the primitive call that preceded this one.
  PERFORM 1 FROM negative_inventory_deficits d
   WHERE d.business_id = v_business AND d.warehouse_id = v_wh AND d.status <> 'closed'
     AND d.variant_id IN (SELECT l.variant_id FROM purchase_lines l WHERE l.business_id = v_business AND l.purchase_id = p_purchase_id)
   ORDER BY d.variant_id, d.deficit_seq, d.id
   FOR UPDATE;

  v_lines := ARRAY[]::uuid[];  v_variants := ARRAY[]::uuid[]; v_ids := ARRAY[]::uuid[]; v_deficits := ARRAY[]::uuid[];
  v_qtys := ARRAY[]::numeric[]; v_provs := ARRAY[]::numeric[]; v_actuals := ARRAY[]::numeric[]; v_values := ARRAY[]::bigint[];
  v_total := 0;

  FOR v_line IN
    SELECT l.id, l.variant_id, l.qty FROM purchase_lines l
    WHERE l.business_id = v_business AND l.purchase_id = p_purchase_id
    ORDER BY l.line_no
  LOOP
    -- The actual cost is the purchase movement's snapshot (A-16(c)).
    SELECT m.unit_cost_base_minor INTO v_actual FROM stock_movements m
     WHERE m.business_id = v_business AND m.source_type = 'purchase' AND m.source_id = p_purchase_id
       AND m.source_line_id = v_line.id AND m.movement_kind = 'purchase';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'inventory.deficit_state_invalid: a line is covered only after its purchase movement' USING ERRCODE = 'P0001';
    END IF;
    SELECT s.on_hand, s.valuation_base_minor INTO v_on_hand, v_val FROM stock_levels s
     WHERE s.business_id = v_business AND s.warehouse_id = v_wh AND s.variant_id = v_line.variant_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'inventory.deficit_state_invalid: a received key has no stock level' USING ERRCODE = 'P0001';
    END IF;
    -- A-16(b)3: the open layers hold exactly the key's deficit before the
    -- purchase movement.
    SELECT coalesce(sum(d.uncovered_qty), 0) INTO v_deficit FROM negative_inventory_deficits d
     WHERE d.business_id = v_business AND d.warehouse_id = v_wh AND d.variant_id = v_line.variant_id AND d.status <> 'closed';
    IF v_deficit <> greatest(0, -(v_on_hand - v_line.qty)) THEN
      RAISE EXCEPTION 'inventory.deficit_state_invalid: the open deficit layers do not hold the key''s deficit' USING ERRCODE = 'P0001';
    END IF;
    -- A-16(e): the line closes every open layer exactly.
    v_closes := v_deficit > 0 AND v_line.qty = v_deficit;
    v_remaining := v_line.qty;
    FOR v_layer IN
      SELECT d.id, d.uncovered_qty, d.provisional_unit_cost_base_minor AS prov FROM negative_inventory_deficits d
      WHERE d.business_id = v_business AND d.warehouse_id = v_wh AND d.variant_id = v_line.variant_id AND d.status <> 'closed'
      ORDER BY d.deficit_seq, d.id
    LOOP
      EXIT WHEN v_remaining = 0;
      v_c := least(v_layer.uncovered_qty, v_remaining);
      v_remaining := v_remaining - v_c;
      IF v_closes AND v_remaining = 0 THEN
        v_value := -v_val;
      ELSE
        v_value := -inventory_half_even(v_c * (v_actual - v_layer.prov), 1, 0);
      END IF;
      v_val := v_val + v_value;
      v_total := v_total + v_value;
      v_lines    := v_lines || v_line.id;
      v_variants := v_variants || v_line.variant_id;
      v_ids      := v_ids || gen_random_uuid();
      v_deficits := v_deficits || v_layer.id;
      v_qtys     := v_qtys || v_c;
      v_provs    := v_provs || v_layer.prov;
      v_actuals  := v_actuals || v_actual;
      v_values   := v_values || v_value::bigint;
    END LOOP;
  END LOOP;

  v_n := cardinality(v_ids);
  IF (v_n = 0) <> (p_adjustment_id IS NULL) THEN
    RAISE EXCEPTION 'inventory.valuation_changed: the deficits to cover changed since the command was prepared' USING ERRCODE = 'P0001';
  END IF;
  IF v_n = 0 THEN
    RETURN;
  END IF;
  IF abs(v_total) > 1000000000000000000 THEN
    RAISE EXCEPTION 'inventory.value_out_of_range: the catch-up value is outside the supported range' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM negative_inventory_cost_adjustments a WHERE a.business_id = v_business AND a.id = p_adjustment_id) THEN
    RAISE EXCEPTION 'inventory.payload_invalid: the coverage header id is already used' USING ERRCODE = 'P0001';
  END IF;
  v_trace := inventory_business_transaction_id();
  IF v_trace IS NULL THEN
    RAISE EXCEPTION 'inventory.trace_missing: a coverage header records its business transaction id' USING ERRCODE = 'P0001';
  END IF;

  -- A-16(a)(i): the header, complete at insert; a binding is owed iff N ≠ 0.
  INSERT INTO negative_inventory_cost_adjustments (tenant_id, business_id, id, warehouse_id, origin_source_type, origin_source_id,
                                                   origin_source_line_id, occurred_on, total_value_base_minor, actor_user_id,
                                                   business_transaction_id, binding_source_id)
  VALUES (v_actor.tenant_id, v_business, p_adjustment_id, v_wh, 'purchase', p_purchase_id,
          NULL, v_date, v_total::bigint, v_actor.actor_user_id, v_trace, CASE WHEN v_total <> 0 THEN p_adjustment_id END);

  -- A-16(h): the coverage rows, then (g) the deficit decrements.
  INSERT INTO negative_deficit_coverages (tenant_id, business_id, id, adjustment_id, deficit_id, variant_id, qty_covered,
                                          provisional_unit_cost_base_minor, actual_unit_cost_base_minor)
  SELECT v_actor.tenant_id, v_business, x.id, p_adjustment_id, x.deficit, x.variant, x.qty, x.prov, x.actual
  FROM unnest(v_ids, v_deficits, v_variants, v_qtys, v_provs, v_actuals) AS x(id, deficit, variant, qty, prov, actual);

  UPDATE negative_inventory_deficits d
     SET uncovered_qty = d.uncovered_qty - x.qty,
         status = CASE WHEN d.uncovered_qty - x.qty = 0 THEN 'closed' ELSE 'partially_covered' END
    FROM unnest(v_deficits, v_qtys) AS x(deficit, qty)
   WHERE d.business_id = v_business AND d.id = x.deficit;

  RETURN QUERY
  SELECT x.line, x.variant, x.id, x.deficit, x.qty, x.val
  FROM unnest(v_lines, v_variants, v_ids, v_deficits, v_qtys, v_values) WITH ORDINALITY AS x(line, variant, id, deficit, qty, val, o)
  ORDER BY x.o;
END;
$$;

COMMENT ON FUNCTION purchase_cover_deficits(UUID, UUID) IS
  'P3-S4 A-16, R-16, R-25. Re-verifies the transaction''s consumed purchase.receive assertion. After the receipt''s purchase movements, locks the open deficit layers of its keys FOR UPDATE (6b), and per line in line_no order requires Σ uncovered = max(0, −on_hand before the movement) (inventory.deficit_state_invalid), covers FIFO by (deficit_seq, id) with −HALF_EVEN(c × (actual − provisional)) — the last coverage of a line that closes every layer carrying −valuation (TL-6) — writes the header (binding iff N ≠ 0), the coverages and the deficit decrements, and returns the coverages in movement order. A coverage with no header id, or a header id with nothing to cover, is inventory.valuation_changed. Internal-owned, no grant.';

-- The one writer of the two S4 bridges (the 0062 R-5 pattern): every
-- binding the primitive wrote for the purchase and for its coverage header.
CREATE OR REPLACE FUNCTION purchase_bridge_receipt(p_purchase_id UUID, p_adjustment_id UUID) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor inventory_verified_actor;
  v_rows  INTEGER;
  v_more  INTEGER;
BEGIN
  v_actor := inventory_assertion_current(ARRAY['purchase.receive']);
  IF p_purchase_id IS NULL
     OR (p_adjustment_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM negative_inventory_cost_adjustments a
                          WHERE a.business_id = v_actor.business_id AND a.id = p_adjustment_id
                            AND a.origin_source_type = 'purchase' AND a.origin_source_id = p_purchase_id)) THEN
    RAISE EXCEPTION 'inventory.source_type_not_authorized: a receipt bridges only its own purchase and coverage header' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO stock_source_bridge_purchase (business_id, source_id, source_line_id, movement_kind)
  SELECT b.business_id, b.source_id, b.source_line_id, b.movement_kind
  FROM stock_source_bindings b
  WHERE b.business_id = v_actor.business_id AND b.source_type = 'purchase' AND b.source_id = p_purchase_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF p_adjustment_id IS NOT NULL THEN
    INSERT INTO stock_source_bridge_negative_inventory_cost_adjustment (business_id, source_id, source_line_id, movement_kind)
    SELECT b.business_id, b.source_id, b.source_line_id, b.movement_kind
    FROM stock_source_bindings b
    WHERE b.business_id = v_actor.business_id AND b.source_type = 'negative_inventory_cost_adjustment' AND b.source_id = p_adjustment_id;
    GET DIAGNOSTICS v_more = ROW_COUNT;
    v_rows := v_rows + v_more;
  END IF;
  RETURN v_rows;
END;
$$;

COMMENT ON FUNCTION purchase_bridge_receipt(UUID, UUID) IS
  'P3-S4 A-15(a), 0062 R-5. The one writer of stock_source_bridge_purchase and stock_source_bridge_negative_inventory_cost_adjustment. Re-verifies the transaction''s consumed purchase.receive assertion; p_adjustment_id, when given, must be the coverage header of p_purchase_id (inventory.source_type_not_authorized otherwise). Inserts one bridge row per stock binding of the purchase and of the header. Internal-owned, no grant.';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The four supplier entry routines (A-04, A-11).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION supplier_create(
  p_supplier_id    UUID,
  p_name           TEXT,
  p_phone          TEXT,
  p_email          TEXT,
  p_tax_identifier TEXT,
  p_notes          TEXT
) RETURNS TABLE (
  supplier_id UUID,
  replayed    BOOLEAN,
  revision    INTEGER,
  status      TEXT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_actor    inventory_verified_actor;
  v_business UUID;
  v_tenant   UUID;
  v_trace    UUID;
  v_intent   TEXT;
  v_stored   TEXT;
  v_replay   BOOLEAN;
BEGIN
  v_actor := inventory_assertion_consume('supplier.create', inventory_claimed_payload_digest('supplier.create',
    ARRAY['uuid'] || array_fill('integer'::text, ARRAY[40]),
    ARRAY[p_supplier_id::text] || inventory_reason_words(p_name) || inventory_reason_words(p_phone) || inventory_reason_words(p_email)
      || inventory_reason_words(p_tax_identifier) || inventory_reason_words(p_notes)));
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: inventory commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_business := v_actor.business_id;
  v_tenant   := v_actor.tenant_id;
  v_replay   := false;
  v_trace    := inventory_business_transaction_id();
  IF v_trace IS NULL THEN
    RAISE EXCEPTION 'inventory.trace_missing: a supplier records its business transaction id' USING ERRCODE = 'P0001';
  END IF;
  IF p_supplier_id IS NULL THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a supplier names its id' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('daftar.supplier_id'), hashtext(p_supplier_id::text));
  v_intent := split_part(current_setting('app.inventory_assertion', true), '.', 7);

  SELECT s.create_intent_sha256 INTO v_stored FROM suppliers s WHERE s.business_id = v_business AND s.id = p_supplier_id FOR UPDATE;
  IF FOUND THEN
    IF v_stored <> v_intent THEN
      RAISE EXCEPTION 'supplier.idempotency_conflict: this supplier id was used for a different supplier' USING ERRCODE = 'P0001';
    END IF;
    v_replay := true;
  ELSE
    IF p_name IS NULL OR p_name <> btrim(p_name) OR char_length(p_name) NOT BETWEEN 1 AND 200
       OR (p_phone IS NOT NULL AND (p_phone <> btrim(p_phone) OR char_length(p_phone) NOT BETWEEN 1 AND 40))
       OR (p_email IS NOT NULL AND (p_email <> btrim(p_email) OR char_length(p_email) NOT BETWEEN 3 AND 254))
       OR (p_tax_identifier IS NOT NULL AND (p_tax_identifier <> btrim(p_tax_identifier) OR char_length(p_tax_identifier) NOT BETWEEN 1 AND 64))
       OR (p_notes IS NOT NULL AND (p_notes <> btrim(p_notes) OR char_length(p_notes) NOT BETWEEN 1 AND 1000)) THEN
      RAISE EXCEPTION 'inventory.payload_invalid: a supplier has a trimmed name of 1..200 characters and trimmed, non-empty contacts within their limits' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO suppliers (tenant_id, business_id, id, name, phone, email, tax_identifier, notes, status, revision,
                           create_intent_sha256, last_intent_sha256, business_transaction_id, created_by, updated_by)
    VALUES (v_tenant, v_business, p_supplier_id, p_name, p_phone, p_email, p_tax_identifier, p_notes, 'active', 1,
            v_intent, v_intent, v_trace, v_actor.actor_user_id, v_actor.actor_user_id);

    INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
    VALUES (v_tenant, v_business, v_actor.actor_user_id, 'supplier.created', 'supplier', p_supplier_id::text,
            jsonb_build_object('revision', 1, 'assertionJti', v_actor.jti, 'business_transaction_id', v_trace));
    INSERT INTO outbox_events (tenant_id, business_id, type, payload)
    VALUES (v_tenant, v_business, 'supplier.created.v1',
            jsonb_build_object('businessId', v_business, 'supplierId', p_supplier_id, 'businessTransactionId', v_trace));
  END IF;

  RETURN QUERY
  SELECT s.id, v_replay, s.revision, s.status FROM suppliers s WHERE s.business_id = v_business AND s.id = p_supplier_id;
END;
$$;

COMMENT ON FUNCTION supplier_create(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) IS
  'P3-S4 §2.4, A-04, A-11. First consumes an invctl/1 assertion of kind supplier.create over its own arguments (A-09: id, then the eight words of name, phone, email, tax identifier and notes). Under the daftar.supplier_id key, an existing id replays when its create intent is equal and is supplier.idempotency_conflict otherwise. Creates an active supplier at revision 1. Audit supplier.created and its outbox row. EXECUTE: daftar_app only — reachability, not authority.';

CREATE OR REPLACE FUNCTION supplier_update(
  p_supplier_id       UUID,
  p_expected_revision INTEGER,
  p_name              TEXT,
  p_phone             TEXT,
  p_email             TEXT,
  p_tax_identifier    TEXT,
  p_notes             TEXT
) RETURNS TABLE (
  supplier_id UUID,
  replayed    BOOLEAN,
  revision    INTEGER,
  status      TEXT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_actor    inventory_verified_actor;
  v_business UUID;
  v_tenant   UUID;
  v_trace    UUID;
  v_intent   TEXT;
  v_row      RECORD;
  v_replay   BOOLEAN;
BEGIN
  v_actor := inventory_assertion_consume('supplier.update', inventory_claimed_payload_digest('supplier.update',
    ARRAY['uuid', 'integer'] || array_fill('integer'::text, ARRAY[40]),
    ARRAY[p_supplier_id::text, p_expected_revision::text] || inventory_reason_words(p_name) || inventory_reason_words(p_phone)
      || inventory_reason_words(p_email) || inventory_reason_words(p_tax_identifier) || inventory_reason_words(p_notes)));
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: inventory commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_business := v_actor.business_id;
  v_tenant   := v_actor.tenant_id;
  v_replay   := false;
  v_trace    := inventory_business_transaction_id();
  IF v_trace IS NULL THEN
    RAISE EXCEPTION 'inventory.trace_missing: a supplier records its business transaction id' USING ERRCODE = 'P0001';
  END IF;
  IF p_supplier_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 1 THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a supplier update names the supplier and the revision it replaces' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('daftar.supplier_id'), hashtext(p_supplier_id::text));
  v_intent := split_part(current_setting('app.inventory_assertion', true), '.', 7);

  SELECT s.revision, s.last_intent_sha256 INTO v_row FROM suppliers s WHERE s.business_id = v_business AND s.id = p_supplier_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'supplier.not_found: the supplier does not exist in this business' USING ERRCODE = 'P0001';
  END IF;
  IF v_row.revision = p_expected_revision + 1 AND v_row.last_intent_sha256 = v_intent THEN
    v_replay := true;
  ELSE
    IF v_row.revision <> p_expected_revision THEN
      RAISE EXCEPTION 'supplier.revision_changed: the supplier changed since it was read' USING ERRCODE = 'P0001';
    END IF;
    IF p_name IS NULL OR p_name <> btrim(p_name) OR char_length(p_name) NOT BETWEEN 1 AND 200
       OR (p_phone IS NOT NULL AND (p_phone <> btrim(p_phone) OR char_length(p_phone) NOT BETWEEN 1 AND 40))
       OR (p_email IS NOT NULL AND (p_email <> btrim(p_email) OR char_length(p_email) NOT BETWEEN 3 AND 254))
       OR (p_tax_identifier IS NOT NULL AND (p_tax_identifier <> btrim(p_tax_identifier) OR char_length(p_tax_identifier) NOT BETWEEN 1 AND 64))
       OR (p_notes IS NOT NULL AND (p_notes <> btrim(p_notes) OR char_length(p_notes) NOT BETWEEN 1 AND 1000)) THEN
      RAISE EXCEPTION 'inventory.payload_invalid: a supplier has a trimmed name of 1..200 characters and trimmed, non-empty contacts within their limits' USING ERRCODE = 'P0001';
    END IF;
    UPDATE suppliers s
       SET name = p_name, phone = p_phone, email = p_email, tax_identifier = p_tax_identifier, notes = p_notes,
           revision = s.revision + 1, last_intent_sha256 = v_intent, business_transaction_id = v_trace,
           updated_by = v_actor.actor_user_id, updated_at = now()
     WHERE s.business_id = v_business AND s.id = p_supplier_id;

    INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
    VALUES (v_tenant, v_business, v_actor.actor_user_id, 'supplier.updated', 'supplier', p_supplier_id::text,
            jsonb_build_object('revision', p_expected_revision + 1, 'assertionJti', v_actor.jti, 'business_transaction_id', v_trace));
    INSERT INTO outbox_events (tenant_id, business_id, type, payload)
    VALUES (v_tenant, v_business, 'supplier.updated.v1',
            jsonb_build_object('businessId', v_business, 'supplierId', p_supplier_id, 'businessTransactionId', v_trace));
  END IF;

  RETURN QUERY
  SELECT s.id, v_replay, s.revision, s.status FROM suppliers s WHERE s.business_id = v_business AND s.id = p_supplier_id;
END;
$$;

COMMENT ON FUNCTION supplier_update(UUID, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT) IS
  'P3-S4 §2.4, A-04, A-11. First consumes an invctl/1 assertion of kind supplier.update over its own arguments (A-09: id, expected revision, the five word groups). Under the daftar.supplier_id key: supplier.not_found; a stored revision of expected + 1 with an equal last intent replays; any other revision is supplier.revision_changed. States the whole supplier (an omitted contact is cleared); never touches a document. Audit supplier.updated and its outbox row. EXECUTE: daftar_app only.';

CREATE OR REPLACE FUNCTION supplier_archive(p_supplier_id UUID, p_expected_revision INTEGER)
RETURNS TABLE (
  supplier_id UUID,
  replayed    BOOLEAN,
  revision    INTEGER,
  status      TEXT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_actor    inventory_verified_actor;
  v_business UUID;
  v_tenant   UUID;
  v_trace    UUID;
  v_intent   TEXT;
  v_row      RECORD;
  v_replay   BOOLEAN;
BEGIN
  v_actor := inventory_assertion_consume('supplier.archive', inventory_claimed_payload_digest('supplier.archive',
    ARRAY['uuid', 'integer'], ARRAY[p_supplier_id::text, p_expected_revision::text]));
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: inventory commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_business := v_actor.business_id;
  v_tenant   := v_actor.tenant_id;
  v_replay   := false;
  v_trace    := inventory_business_transaction_id();
  IF v_trace IS NULL THEN
    RAISE EXCEPTION 'inventory.trace_missing: a supplier records its business transaction id' USING ERRCODE = 'P0001';
  END IF;
  IF p_supplier_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 1 THEN
    RAISE EXCEPTION 'inventory.payload_invalid: an archive names the supplier and the revision it replaces' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('daftar.supplier_id'), hashtext(p_supplier_id::text));
  v_intent := split_part(current_setting('app.inventory_assertion', true), '.', 7);

  SELECT s.revision, s.status, s.last_intent_sha256 INTO v_row FROM suppliers s WHERE s.business_id = v_business AND s.id = p_supplier_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'supplier.not_found: the supplier does not exist in this business' USING ERRCODE = 'P0001';
  END IF;
  IF v_row.revision = p_expected_revision + 1 AND v_row.last_intent_sha256 = v_intent THEN
    v_replay := true;
  ELSE
    IF v_row.revision <> p_expected_revision THEN
      RAISE EXCEPTION 'supplier.revision_changed: the supplier changed since it was read' USING ERRCODE = 'P0001';
    END IF;
    IF v_row.status <> 'active' THEN
      RAISE EXCEPTION 'supplier.state_invalid: only an active supplier is archived' USING ERRCODE = 'P0001';
    END IF;
    UPDATE suppliers s
       SET status = 'inactive', revision = s.revision + 1, last_intent_sha256 = v_intent, business_transaction_id = v_trace,
           updated_by = v_actor.actor_user_id, updated_at = now()
     WHERE s.business_id = v_business AND s.id = p_supplier_id;

    INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
    VALUES (v_tenant, v_business, v_actor.actor_user_id, 'supplier.archived', 'supplier', p_supplier_id::text,
            jsonb_build_object('revision', p_expected_revision + 1, 'assertionJti', v_actor.jti, 'business_transaction_id', v_trace));
    INSERT INTO outbox_events (tenant_id, business_id, type, payload)
    VALUES (v_tenant, v_business, 'supplier.archived.v1',
            jsonb_build_object('businessId', v_business, 'supplierId', p_supplier_id, 'businessTransactionId', v_trace));
  END IF;

  RETURN QUERY
  SELECT s.id, v_replay, s.revision, s.status FROM suppliers s WHERE s.business_id = v_business AND s.id = p_supplier_id;
END;
$$;

COMMENT ON FUNCTION supplier_archive(UUID, INTEGER) IS
  'P3-S4 §2.4, A-04. First consumes an invctl/1 assertion of kind supplier.archive over its own arguments (id, expected revision). Under the daftar.supplier_id key: supplier.not_found; revision expected + 1 with an equal last intent replays; supplier.revision_changed; supplier.state_invalid unless active. active → inactive, revision + 1. Audit supplier.archived and its outbox row. EXECUTE: daftar_app only.';

CREATE OR REPLACE FUNCTION supplier_reactivate(p_supplier_id UUID, p_expected_revision INTEGER)
RETURNS TABLE (
  supplier_id UUID,
  replayed    BOOLEAN,
  revision    INTEGER,
  status      TEXT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_actor    inventory_verified_actor;
  v_business UUID;
  v_tenant   UUID;
  v_trace    UUID;
  v_intent   TEXT;
  v_row      RECORD;
  v_replay   BOOLEAN;
BEGIN
  v_actor := inventory_assertion_consume('supplier.reactivate', inventory_claimed_payload_digest('supplier.reactivate',
    ARRAY['uuid', 'integer'], ARRAY[p_supplier_id::text, p_expected_revision::text]));
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: inventory commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_business := v_actor.business_id;
  v_tenant   := v_actor.tenant_id;
  v_replay   := false;
  v_trace    := inventory_business_transaction_id();
  IF v_trace IS NULL THEN
    RAISE EXCEPTION 'inventory.trace_missing: a supplier records its business transaction id' USING ERRCODE = 'P0001';
  END IF;
  IF p_supplier_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 1 THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a reactivation names the supplier and the revision it replaces' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('daftar.supplier_id'), hashtext(p_supplier_id::text));
  v_intent := split_part(current_setting('app.inventory_assertion', true), '.', 7);

  SELECT s.revision, s.status, s.last_intent_sha256 INTO v_row FROM suppliers s WHERE s.business_id = v_business AND s.id = p_supplier_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'supplier.not_found: the supplier does not exist in this business' USING ERRCODE = 'P0001';
  END IF;
  IF v_row.revision = p_expected_revision + 1 AND v_row.last_intent_sha256 = v_intent THEN
    v_replay := true;
  ELSE
    IF v_row.revision <> p_expected_revision THEN
      RAISE EXCEPTION 'supplier.revision_changed: the supplier changed since it was read' USING ERRCODE = 'P0001';
    END IF;
    IF v_row.status <> 'inactive' THEN
      RAISE EXCEPTION 'supplier.state_invalid: only an inactive supplier is reactivated' USING ERRCODE = 'P0001';
    END IF;
    UPDATE suppliers s
       SET status = 'active', revision = s.revision + 1, last_intent_sha256 = v_intent, business_transaction_id = v_trace,
           updated_by = v_actor.actor_user_id, updated_at = now()
     WHERE s.business_id = v_business AND s.id = p_supplier_id;

    INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
    VALUES (v_tenant, v_business, v_actor.actor_user_id, 'supplier.reactivated', 'supplier', p_supplier_id::text,
            jsonb_build_object('revision', p_expected_revision + 1, 'assertionJti', v_actor.jti, 'business_transaction_id', v_trace));
    INSERT INTO outbox_events (tenant_id, business_id, type, payload)
    VALUES (v_tenant, v_business, 'supplier.reactivated.v1',
            jsonb_build_object('businessId', v_business, 'supplierId', p_supplier_id, 'businessTransactionId', v_trace));
  END IF;

  RETURN QUERY
  SELECT s.id, v_replay, s.revision, s.status FROM suppliers s WHERE s.business_id = v_business AND s.id = p_supplier_id;
END;
$$;

COMMENT ON FUNCTION supplier_reactivate(UUID, INTEGER) IS
  'P3-S4 §2.4, A-04 (TL-3). First consumes an invctl/1 assertion of kind supplier.reactivate over its own arguments (id, expected revision). Under the daftar.supplier_id key: supplier.not_found; revision expected + 1 with an equal last intent replays; supplier.revision_changed; supplier.state_invalid unless inactive. inactive → active, revision + 1. Audit supplier.reactivated and its outbox row. EXECUTE: daftar_app only.';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. The purchase draft (A-04, A-12, A-13 steps 1-5): create or replace.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION purchase_save_draft(
  p_purchase_id           UUID,
  p_expected_revision     INTEGER,
  p_supplier_id           UUID,
  p_warehouse_id          UUID,
  p_previous_warehouse_id UUID,
  p_currency_code         CHAR(3),
  p_document_date         DATE,
  p_supplier_reference    TEXT,
  p_notes                 TEXT,
  p_tax_minor             BIGINT,
  p_line_ids              UUID[],
  p_variant_ids           UUID[],
  p_qtys                  NUMERIC[],
  p_unit_prices           NUMERIC[],
  p_discounts             BIGINT[],
  p_lc_ids                UUID[],
  p_lc_modes              TEXT[],
  p_lc_amounts            BIGINT[],
  p_lc_descriptions       TEXT[],
  p_lc_allocations        BIGINT[]
) RETURNS TABLE (
  purchase_id                UUID,
  replayed                   BOOLEAN,
  revision                   INTEGER,
  status                     TEXT,
  subtotal_txn_minor         BIGINT,
  landed_cost_txn_minor      BIGINT,
  total_txn_minor            BIGINT,
  line_id                    UUID,
  line_no                    INTEGER,
  variant_id                 UUID,
  net_txn_minor              BIGINT,
  line_landed_cost_txn_minor BIGINT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  c_limit     CONSTANT NUMERIC := 1000000000000000000;
  v_actor     inventory_verified_actor;
  v_business  UUID;
  v_tenant    UUID;
  v_trace     UUID;
  v_intent    TEXT;
  v_row       RECORD;
  v_replay    BOOLEAN;
  v_create    BOOLEAN;
  v_n         INTEGER;
  v_k         INTEGER;
  v_i         INTEGER;
  v_j         INTEGER;
  v_flat      BIGINT[];
  v_sstatus   TEXT;
  v_wstatus   TEXT;
  v_var       RECORD;
  v_base      UUID;
  v_gross     BIGINT[];
  v_net       BIGINT[];
  v_landed    BIGINT[];
  v_alloc     BIGINT[];
  v_share     BIGINT[];
  v_value     NUMERIC;
  v_sum       NUMERIC;
  v_subtotal  NUMERIC;
  v_lc_total  NUMERIC;
  v_total     NUMERIC;
BEGIN
  v_actor := inventory_assertion_consume('purchase.draft', inventory_claimed_payload_digest('purchase.draft',
    ARRAY['uuid', 'integer', 'uuid', 'uuid', 'uuid', 'code', 'integer'] || array_fill('integer'::text, ARRAY[18])
      || ARRAY(SELECT f.t FROM unnest(p_line_ids, p_variant_ids, p_qtys, p_unit_prices, p_discounts) WITH ORDINALITY AS l(li, v, q, u, d, i)
               CROSS JOIN LATERAL unnest(ARRAY['uuid', 'uuid', 'integer', 'integer', 'integer']) WITH ORDINALITY AS f(t, j) ORDER BY l.i, f.j)
      || ARRAY['integer']
      || ARRAY(SELECT f.t FROM unnest(p_lc_ids, p_lc_modes, p_lc_amounts, p_lc_descriptions) WITH ORDINALITY AS c(id, m, a, d, k)
               CROSS JOIN LATERAL unnest(ARRAY['uuid', 'code', 'integer'] || array_fill('integer'::text, ARRAY[8 + coalesce(cardinality(p_line_ids), 0)]))
                 WITH ORDINALITY AS f(t, j) ORDER BY c.k, f.j),
    ARRAY[p_purchase_id::text, p_expected_revision::text, p_supplier_id::text, p_warehouse_id::text, p_previous_warehouse_id::text,
          lower(p_currency_code::text), to_char(p_document_date, 'YYYYMMDD')]
      || inventory_reason_words(p_supplier_reference) || inventory_reason_words(p_notes)
      || ARRAY[p_tax_minor::text, coalesce(cardinality(p_line_ids), 0)::text]
      || ARRAY(SELECT f.x FROM unnest(p_line_ids, p_variant_ids, p_qtys, p_unit_prices, p_discounts) WITH ORDINALITY AS l(li, v, q, u, d, i)
               CROSS JOIN LATERAL unnest(ARRAY[l.li::text, l.v::text, inventory_fixed_text(l.q, 4), inventory_fixed_text(l.u, 10), l.d::text])
                 WITH ORDINALITY AS f(x, j) ORDER BY l.i, f.j)
      || ARRAY[coalesce(cardinality(p_lc_ids), 0)::text]
      || ARRAY(SELECT f.x FROM unnest(p_lc_ids, p_lc_modes, p_lc_amounts, p_lc_descriptions) WITH ORDINALITY AS c(id, m, a, d, k)
               CROSS JOIN LATERAL unnest(ARRAY[c.id::text, c.m, c.a::text] || inventory_reason_words(c.d)
                                         || ARRAY(SELECT (SELECT u.x FROM unnest(p_lc_allocations) WITH ORDINALITY AS u(x, o)
                                                           WHERE u.o = (c.k - 1) * coalesce(cardinality(p_line_ids), 0) + g.i)::text
                                                  FROM generate_series(1, coalesce(cardinality(p_line_ids), 0)) AS g(i) ORDER BY g.i))
                 WITH ORDINALITY AS f(x, j) ORDER BY c.k, f.j)));
  -- A-12 (OD-03): a signed non-zero tax still never writes.
  IF p_tax_minor IS DISTINCT FROM 0 THEN
    IF p_tax_minor IS NULL THEN
      RAISE EXCEPTION 'inventory.payload_invalid: a draft states its tax amount' USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION 'purchase.tax_policy_absent: purchase tax is not supported until its policy is decided' USING ERRCODE = 'P0001';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: inventory commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_business := v_actor.business_id;
  v_tenant   := v_actor.tenant_id;
  v_replay   := false;
  v_trace    := inventory_business_transaction_id();
  IF v_trace IS NULL THEN
    RAISE EXCEPTION 'inventory.trace_missing: a purchase records its business transaction id' USING ERRCODE = 'P0001';
  END IF;
  IF p_purchase_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 0 THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a draft names its purchase and the revision it replaces (0 to create)' USING ERRCODE = 'P0001';
  END IF;

  -- A-10(d): the document key, then the intent, then the row and the proof.
  PERFORM pg_advisory_xact_lock(hashtext('daftar.purchase_id'), hashtext(p_purchase_id::text));
  v_intent := split_part(current_setting('app.inventory_assertion', true), '.', 7);

  SELECT p.status, p.revision, p.draft_intent_sha256, p.warehouse_id INTO v_row
  FROM purchases p WHERE p.business_id = v_business AND p.id = p_purchase_id FOR UPDATE;
  v_create := NOT FOUND;
  IF NOT v_create THEN
    IF v_row.revision = p_expected_revision + 1 AND v_row.draft_intent_sha256 = v_intent THEN
      v_replay := true;
    ELSIF p_expected_revision = 0 THEN
      RAISE EXCEPTION 'purchase.idempotency_conflict: this purchase id was used for a different draft' USING ERRCODE = 'P0001';
    ELSIF v_row.status <> 'draft' THEN
      RAISE EXCEPTION 'purchase.state_invalid: only a draft purchase is replaced' USING ERRCODE = 'P0001';
    ELSIF v_row.revision <> p_expected_revision THEN
      RAISE EXCEPTION 'purchase.draft_changed: the draft changed since it was read' USING ERRCODE = 'P0001';
    END IF;
  ELSIF p_expected_revision <> 0 THEN
    RAISE EXCEPTION 'purchase.not_found: the purchase does not exist in this business' USING ERRCODE = 'P0001';
  END IF;

  IF NOT v_replay THEN
    -- Shape (R-29).
    v_n := coalesce(cardinality(p_line_ids), 0);
    v_k := coalesce(cardinality(p_lc_ids), 0);
    IF v_n = 0 THEN
      RAISE EXCEPTION 'purchase.lines_required: a purchase has at least one line' USING ERRCODE = 'P0001';
    END IF;
    v_flat := ARRAY(SELECT u.x FROM unnest(coalesce(p_lc_allocations, ARRAY[]::bigint[])) WITH ORDINALITY AS u(x, o) ORDER BY u.o);
    IF v_n > 200 OR v_k > 10 OR array_ndims(p_line_ids) <> 1 OR array_lower(p_line_ids, 1) <> 1
       OR p_variant_ids IS NULL OR array_ndims(p_variant_ids) <> 1 OR array_lower(p_variant_ids, 1) <> 1 OR cardinality(p_variant_ids) <> v_n
       OR p_qtys IS NULL OR array_ndims(p_qtys) <> 1 OR array_lower(p_qtys, 1) <> 1 OR cardinality(p_qtys) <> v_n
       OR p_unit_prices IS NULL OR array_ndims(p_unit_prices) <> 1 OR array_lower(p_unit_prices, 1) <> 1 OR cardinality(p_unit_prices) <> v_n
       OR p_discounts IS NULL OR array_ndims(p_discounts) <> 1 OR array_lower(p_discounts, 1) <> 1 OR cardinality(p_discounts) <> v_n
       OR array_position(p_line_ids, NULL) IS NOT NULL OR array_position(p_variant_ids, NULL) IS NOT NULL
       OR array_position(p_qtys, NULL) IS NOT NULL OR array_position(p_unit_prices, NULL) IS NOT NULL
       OR array_position(p_discounts, NULL) IS NOT NULL
       OR (v_k > 0 AND (array_ndims(p_lc_ids) <> 1 OR array_lower(p_lc_ids, 1) <> 1
                        OR p_lc_modes IS NULL OR array_ndims(p_lc_modes) <> 1 OR array_lower(p_lc_modes, 1) <> 1 OR cardinality(p_lc_modes) <> v_k
                        OR p_lc_amounts IS NULL OR array_ndims(p_lc_amounts) <> 1 OR array_lower(p_lc_amounts, 1) <> 1
                        OR cardinality(p_lc_amounts) <> v_k
                        OR (p_lc_descriptions IS NOT NULL AND (array_ndims(p_lc_descriptions) <> 1 OR array_lower(p_lc_descriptions, 1) <> 1
                                                               OR cardinality(p_lc_descriptions) <> v_k))
                        OR array_position(p_lc_ids, NULL) IS NOT NULL OR array_position(p_lc_modes, NULL) IS NOT NULL
                        OR array_position(p_lc_amounts, NULL) IS NOT NULL))
       OR (v_k = 0 AND (coalesce(cardinality(p_lc_modes), 0) <> 0 OR coalesce(cardinality(p_lc_amounts), 0) <> 0
                        OR coalesce(cardinality(p_lc_descriptions), 0) <> 0))
       OR cardinality(v_flat) <> v_k * v_n
       OR p_supplier_id IS NULL OR p_warehouse_id IS NULL OR p_document_date IS NULL OR p_currency_code IS NULL
       OR (p_supplier_reference IS NOT NULL AND (p_supplier_reference <> btrim(p_supplier_reference)
                                                 OR char_length(p_supplier_reference) NOT BETWEEN 1 AND 200))
       OR (p_notes IS NOT NULL AND (p_notes <> btrim(p_notes) OR char_length(p_notes) NOT BETWEEN 1 AND 1000)) THEN
      RAISE EXCEPTION 'inventory.payload_invalid: a draft has a supplier, a warehouse, a currency, a date, 1..200 complete lines, 0..10 complete landed costs and trimmed text within its limits' USING ERRCODE = 'P0001';
    END IF;
    IF (SELECT count(DISTINCT x.id) FROM unnest(p_line_ids || coalesce(p_lc_ids, ARRAY[]::uuid[])) AS x(id)) <> v_n + v_k
       OR EXISTS (SELECT 1 FROM purchase_lines l WHERE l.business_id = v_business AND l.id = ANY (p_line_ids) AND l.purchase_id <> p_purchase_id)
       OR EXISTS (SELECT 1 FROM purchase_landed_costs c WHERE c.business_id = v_business AND c.id = ANY (p_lc_ids) AND c.purchase_id <> p_purchase_id) THEN
      RAISE EXCEPTION 'inventory.payload_invalid: a line or landed-cost id is unique and belongs to this purchase' USING ERRCODE = 'P0001';
    END IF;
    IF (SELECT count(DISTINCT x.id) FROM unnest(p_variant_ids) AS x(id)) <> v_n THEN
      RAISE EXCEPTION 'purchase.duplicate_variant: a variant appears once per purchase' USING ERRCODE = 'P0001';
    END IF;
    -- The warehouse moves only from the stored one (A-03 scope).
    IF v_create OR v_row.warehouse_id = p_warehouse_id THEN
      IF p_previous_warehouse_id IS NOT NULL THEN
        RAISE EXCEPTION 'inventory.payload_invalid: a previous warehouse is named only when a replace moves the draft' USING ERRCODE = 'P0001';
      END IF;
    ELSIF p_previous_warehouse_id IS DISTINCT FROM v_row.warehouse_id THEN
      RAISE EXCEPTION 'purchase.draft_changed: the draft''s warehouse changed since it was read' USING ERRCODE = 'P0001';
    END IF;

    -- Lock step 2b: the supplier, which must be active.
    SELECT s.status INTO v_sstatus FROM suppliers s WHERE s.business_id = v_business AND s.id = p_supplier_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'supplier.not_found: the supplier does not exist in this business' USING ERRCODE = 'P0001';
    END IF;
    IF v_sstatus <> 'active' THEN
      RAISE EXCEPTION 'purchase.supplier_inactive: an inactive supplier takes no purchase' USING ERRCODE = 'P0001';
    END IF;

    -- Warehouse, variants and currency (R-33).
    SELECT w.status INTO v_wstatus FROM warehouses w WHERE w.business_id = v_business AND w.id = p_warehouse_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'inventory.warehouse_not_found: the warehouse does not exist in this business' USING ERRCODE = 'P0001';
    END IF;
    IF v_wstatus <> 'active' THEN
      RAISE EXCEPTION 'inventory.warehouse_archived: the warehouse is archived' USING ERRCODE = 'P0001';
    END IF;
    FOR v_i IN 1 .. v_n LOOP
      SELECT pv.status AS vstatus, p.status AS pstatus, p.track_inventory, p.unit_decimals, p.id AS product_id INTO v_var
      FROM product_variants pv JOIN products p ON p.business_id = pv.business_id AND p.id = pv.product_id
      WHERE pv.business_id = v_business AND pv.id = p_variant_ids[v_i];
      IF NOT FOUND THEN
        RAISE EXCEPTION 'inventory.variant_not_found: the variant does not exist in this business' USING ERRCODE = 'P0001';
      END IF;
      IF v_var.vstatus <> 'active' OR v_var.pstatus <> 'active' THEN
        RAISE EXCEPTION 'inventory.variant_archived: the variant or its product is archived' USING ERRCODE = 'P0001';
      END IF;
      IF NOT v_var.track_inventory THEN
        RAISE EXCEPTION 'inventory.product_not_tracked: the product does not track inventory' USING ERRCODE = 'P0001';
      END IF;
      SELECT pv.id INTO v_base FROM product_variants pv WHERE pv.business_id = v_business AND pv.product_id = v_var.product_id AND pv.is_base;
      IF FOUND AND v_base <> p_variant_ids[v_i] THEN
        RAISE EXCEPTION 'inventory.variant_not_stock_identity: a product with a base variant holds stock only on its base variant' USING ERRCODE = 'P0001';
      END IF;
      IF p_qtys[v_i] <= 0 OR p_qtys[v_i] >= 10000000000 THEN
        RAISE EXCEPTION 'inventory.quantity_out_of_range: a purchase line quantity is positive and within the supported range' USING ERRCODE = 'P0001';
      END IF;
      IF NOT inventory_quantity_is_representable(p_qtys[v_i], v_var.unit_decimals) THEN
        RAISE EXCEPTION 'inventory.quantity_precision_invalid: the quantity has more decimal places than the product unit allows' USING ERRCODE = 'P0001';
      END IF;
    END LOOP;
    IF p_currency_code::text !~ '^[A-Z]{3}$' OR NOT EXISTS (SELECT 1 FROM currencies c WHERE c.code = p_currency_code::text) THEN
      RAISE EXCEPTION 'purchase.currency_unknown: the purchase currency is not a registered currency' USING ERRCODE = 'P0001';
    END IF;

    -- A-13 steps 1-2: gross and net per line.
    v_gross := ARRAY[]::bigint[];
    v_net   := ARRAY[]::bigint[];
    v_subtotal := 0;
    FOR v_i IN 1 .. v_n LOOP
      IF p_unit_prices[v_i] < 0 OR p_unit_prices[v_i] >= c_limit THEN
        RAISE EXCEPTION 'inventory.payload_invalid: a unit price is non-negative and below the limit' USING ERRCODE = 'P0001';
      END IF;
      v_value := inventory_half_even(p_qtys[v_i] * p_unit_prices[v_i], 1, 0);
      IF v_value > c_limit THEN
        RAISE EXCEPTION 'inventory.value_out_of_range: a line amount is outside the supported range' USING ERRCODE = 'P0001';
      END IF;
      IF p_discounts[v_i] < 0 OR p_discounts[v_i] > v_value THEN
        RAISE EXCEPTION 'purchase.discount_invalid: a line discount is between zero and the line amount' USING ERRCODE = 'P0001';
      END IF;
      v_gross := v_gross || v_value::bigint;
      v_net   := v_net || (v_value - p_discounts[v_i])::bigint;
      v_subtotal := v_subtotal + (v_value - p_discounts[v_i]);
    END LOOP;

    -- A-13 step 3: each landed cost allocated separately, row-major into
    -- v_alloc (cost k, line i at (k - 1) × n + i).
    v_alloc  := ARRAY[]::bigint[];
    v_landed := array_fill(0::bigint, ARRAY[v_n]);
    v_lc_total := 0;
    FOR v_j IN 1 .. v_k LOOP
      IF p_lc_modes[v_j] NOT IN ('by_value', 'manual') OR p_lc_amounts[v_j] < 1 OR p_lc_amounts[v_j] > c_limit THEN
        RAISE EXCEPTION 'purchase.landed_cost_invalid: a landed cost is by_value or manual with a positive amount' USING ERRCODE = 'P0001';
      END IF;
      IF p_lc_descriptions IS NOT NULL AND p_lc_descriptions[v_j] IS NOT NULL
         AND (p_lc_descriptions[v_j] <> btrim(p_lc_descriptions[v_j]) OR char_length(p_lc_descriptions[v_j]) NOT BETWEEN 1 AND 200) THEN
        RAISE EXCEPTION 'inventory.payload_invalid: a landed-cost description is trimmed text of 1..200 characters' USING ERRCODE = 'P0001';
      END IF;
      IF p_lc_modes[v_j] = 'by_value' THEN
        IF EXISTS (SELECT 1 FROM unnest(v_flat[(v_j - 1) * v_n + 1 : v_j * v_n]) AS x(a) WHERE x.a IS NOT NULL) THEN
          RAISE EXCEPTION 'purchase.landed_cost_invalid: a by_value landed cost carries no manual allocation' USING ERRCODE = 'P0001';
        END IF;
        IF v_subtotal = 0 THEN
          RAISE EXCEPTION 'purchase.landed_cost_denominator_zero: a by_value landed cost needs a non-zero line value to allocate by' USING ERRCODE = 'P0001';
        END IF;
        v_share := inventory_largest_remainder(v_net::numeric[], p_lc_amounts[v_j]);
      ELSE
        v_share := v_flat[(v_j - 1) * v_n + 1 : v_j * v_n];
        IF array_position(v_share, NULL) IS NOT NULL OR EXISTS (SELECT 1 FROM unnest(v_share) AS x(a) WHERE x.a < 0) THEN
          RAISE EXCEPTION 'purchase.landed_cost_invalid: a manual landed cost states a non-negative amount for every line' USING ERRCODE = 'P0001';
        END IF;
        SELECT sum(x.a) INTO v_sum FROM unnest(v_share) AS x(a);
        IF v_sum <> p_lc_amounts[v_j] THEN
          RAISE EXCEPTION 'purchase.landed_cost_allocation_mismatch: a manual allocation adds up to its landed cost exactly' USING ERRCODE = 'P0001';
        END IF;
      END IF;
      v_alloc := v_alloc || v_share;
      FOR v_i IN 1 .. v_n LOOP
        v_landed[v_i] := v_landed[v_i] + v_share[v_i];
      END LOOP;
      v_lc_total := v_lc_total + p_lc_amounts[v_j];
    END LOOP;

    -- A-13 steps 4-5: T = Σ t_i + tax (= 0), positive and in range.
    v_total := v_subtotal + v_lc_total + p_tax_minor;
    IF v_total <= 0 THEN
      RAISE EXCEPTION 'purchase.total_zero: a purchase total is positive' USING ERRCODE = 'P0001';
    END IF;
    IF v_total > c_limit THEN
      RAISE EXCEPTION 'inventory.value_out_of_range: the purchase total is outside the supported range' USING ERRCODE = 'P0001';
    END IF;

    -- Write: replace (delete the old lines, costs and allocations; the
    -- header advances one revision) or create (revision 1).
    IF v_create THEN
      INSERT INTO purchases (tenant_id, business_id, id, supplier_id, warehouse_id, currency_code, document_date, supplier_reference, notes,
                             status, revision, draft_intent_sha256, subtotal_txn_minor, landed_cost_txn_minor, tax_minor, total_txn_minor,
                             business_transaction_id, created_by)
      VALUES (v_tenant, v_business, p_purchase_id, p_supplier_id, p_warehouse_id, p_currency_code, p_document_date, p_supplier_reference, p_notes,
              'draft', 1, v_intent, v_subtotal::bigint, v_lc_total::bigint, p_tax_minor, v_total::bigint, v_trace, v_actor.actor_user_id);
    ELSE
      DELETE FROM purchase_landed_cost_allocations a WHERE a.business_id = v_business AND a.purchase_id = p_purchase_id;
      DELETE FROM purchase_landed_costs c WHERE c.business_id = v_business AND c.purchase_id = p_purchase_id;
      DELETE FROM purchase_lines l WHERE l.business_id = v_business AND l.purchase_id = p_purchase_id;
      UPDATE purchases p
         SET supplier_id = p_supplier_id, warehouse_id = p_warehouse_id, currency_code = p_currency_code, document_date = p_document_date,
             supplier_reference = p_supplier_reference, notes = p_notes, revision = p.revision + 1, draft_intent_sha256 = v_intent,
             subtotal_txn_minor = v_subtotal::bigint, landed_cost_txn_minor = v_lc_total::bigint, tax_minor = p_tax_minor,
             total_txn_minor = v_total::bigint, business_transaction_id = v_trace, updated_at = now()
       WHERE p.business_id = v_business AND p.id = p_purchase_id;
    END IF;

    INSERT INTO purchase_lines (tenant_id, business_id, purchase_id, id, line_no, variant_id, qty, unit_price_txn_minor,
                                gross_txn_minor, discount_txn_minor, net_txn_minor, landed_cost_txn_minor)
    SELECT v_tenant, v_business, p_purchase_id, x.id, x.o::integer, x.variant, x.qty, x.price, x.gross, x.discount, x.net, x.landed
    FROM unnest(p_line_ids, p_variant_ids, p_qtys, p_unit_prices, v_gross, p_discounts, v_net, v_landed)
           WITH ORDINALITY AS x(id, variant, qty, price, gross, discount, net, landed, o);
    IF v_k > 0 THEN
      INSERT INTO purchase_landed_costs (tenant_id, business_id, purchase_id, id, cost_no, mode, amount_txn_minor, description)
      SELECT v_tenant, v_business, p_purchase_id, x.id, x.o::integer, x.mode, x.amount, x.description
      FROM unnest(p_lc_ids, p_lc_modes, p_lc_amounts, coalesce(p_lc_descriptions, array_fill(NULL::text, ARRAY[v_k])))
             WITH ORDINALITY AS x(id, mode, amount, description, o);
      INSERT INTO purchase_landed_cost_allocations (tenant_id, business_id, purchase_id, landed_cost_id, purchase_line_id, amount_txn_minor)
      SELECT v_tenant, v_business, p_purchase_id, p_lc_ids[c.k], p_line_ids[l.i], v_alloc[(c.k - 1) * v_n + l.i]
      FROM generate_series(1, v_k) AS c(k) CROSS JOIN generate_series(1, v_n) AS l(i);
    END IF;

    INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
    VALUES (v_tenant, v_business, v_actor.actor_user_id, 'purchase.draft_saved', 'purchase', p_purchase_id::text,
            jsonb_build_object('revision', p_expected_revision + 1, 'supplierId', p_supplier_id, 'warehouseId', p_warehouse_id,
                               'previousWarehouseId', p_previous_warehouse_id, 'lineCount', v_n, 'landedCostCount', v_k,
                               'assertionJti', v_actor.jti, 'business_transaction_id', v_trace));
    INSERT INTO outbox_events (tenant_id, business_id, type, payload)
    VALUES (v_tenant, v_business, 'purchase.draft_saved.v1',
            jsonb_build_object('businessId', v_business, 'purchaseId', p_purchase_id, 'businessTransactionId', v_trace));
  END IF;

  RETURN QUERY
  SELECT p.id, v_replay, p.revision, p.status, p.subtotal_txn_minor, p.landed_cost_txn_minor, p.total_txn_minor,
         l.id, l.line_no, l.variant_id, l.net_txn_minor, l.landed_cost_txn_minor
  FROM purchases p
  JOIN purchase_lines l ON l.business_id = p.business_id AND l.purchase_id = p.id
  WHERE p.business_id = v_business AND p.id = p_purchase_id
  ORDER BY l.line_no;
END;
$$;

COMMENT ON FUNCTION purchase_save_draft(UUID, INTEGER, UUID, UUID, UUID, CHAR(3), DATE, TEXT, TEXT, BIGINT, UUID[], UUID[], NUMERIC[], NUMERIC[], BIGINT[], UUID[], TEXT[], BIGINT[], TEXT[], BIGINT[]) IS
  'P3-S4 §2.4, A-04, A-12, A-13. First consumes an invctl/1 assertion of kind purchase.draft over its own arguments (A-09). A non-zero tax is purchase.tax_policy_absent (OD-03). Under the daftar.purchase_id key: revision expected + 1 with an equal draft intent replays; purchase.idempotency_conflict (create over another draft), purchase.state_invalid, purchase.draft_changed, purchase.not_found. The supplier FOR SHARE must be active; warehouse, variants and currency are checked; A-13 steps 1-5 (purchase.discount_invalid, landed_cost_invalid, landed_cost_denominator_zero, landed_cost_allocation_mismatch, total_zero). A replace deletes and re-inserts the lines, landed costs and every allocation and advances the revision. No movement, no entry. Audit purchase.draft_saved and its outbox row. EXECUTE: daftar_app only.';

-- ─────────────────────────────────────────────────────────────────────────
-- 4. The purchase cancel (A-04): draft → cancelled, terminal.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION purchase_cancel(p_purchase_id UUID, p_warehouse_id UUID, p_draft_revision INTEGER)
RETURNS TABLE (
  purchase_id UUID,
  replayed    BOOLEAN,
  status      TEXT,
  revision    INTEGER
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_actor    inventory_verified_actor;
  v_business UUID;
  v_tenant   UUID;
  v_trace    UUID;
  v_intent   TEXT;
  v_row      RECORD;
  v_replay   BOOLEAN;
BEGIN
  v_actor := inventory_assertion_consume('purchase.cancel', inventory_claimed_payload_digest('purchase.cancel',
    ARRAY['uuid', 'uuid', 'integer'], ARRAY[p_purchase_id::text, p_warehouse_id::text, p_draft_revision::text]));
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: inventory commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_business := v_actor.business_id;
  v_tenant   := v_actor.tenant_id;
  v_replay   := false;
  v_trace    := inventory_business_transaction_id();
  IF v_trace IS NULL THEN
    RAISE EXCEPTION 'inventory.trace_missing: a purchase records its business transaction id' USING ERRCODE = 'P0001';
  END IF;
  IF p_purchase_id IS NULL OR p_warehouse_id IS NULL OR p_draft_revision IS NULL THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a cancel names the purchase, its warehouse and its draft revision' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('daftar.purchase_id'), hashtext(p_purchase_id::text));
  v_intent := split_part(current_setting('app.inventory_assertion', true), '.', 7);

  SELECT p.status, p.revision, p.warehouse_id, p.cancel_intent_sha256 INTO v_row
  FROM purchases p WHERE p.business_id = v_business AND p.id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase.not_found: the purchase does not exist in this business' USING ERRCODE = 'P0001';
  END IF;
  IF v_row.status = 'cancelled' AND v_row.cancel_intent_sha256 = v_intent THEN
    v_replay := true;
  ELSE
    IF v_row.status <> 'draft' THEN
      RAISE EXCEPTION 'purchase.state_invalid: only a draft purchase is cancelled' USING ERRCODE = 'P0001';
    END IF;
    IF v_row.revision <> p_draft_revision OR v_row.warehouse_id <> p_warehouse_id THEN
      RAISE EXCEPTION 'purchase.draft_changed: the draft changed since it was read' USING ERRCODE = 'P0001';
    END IF;
    UPDATE purchases p
       SET status = 'cancelled', cancel_intent_sha256 = v_intent, cancelled_by = v_actor.actor_user_id, cancelled_at = now(),
           business_transaction_id = v_trace, updated_at = now()
     WHERE p.business_id = v_business AND p.id = p_purchase_id;

    INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
    VALUES (v_tenant, v_business, v_actor.actor_user_id, 'purchase.cancelled', 'purchase', p_purchase_id::text,
            jsonb_build_object('revision', p_draft_revision, 'warehouseId', p_warehouse_id,
                               'assertionJti', v_actor.jti, 'business_transaction_id', v_trace));
    INSERT INTO outbox_events (tenant_id, business_id, type, payload)
    VALUES (v_tenant, v_business, 'purchase.cancelled.v1',
            jsonb_build_object('businessId', v_business, 'purchaseId', p_purchase_id, 'businessTransactionId', v_trace));
  END IF;

  RETURN QUERY
  SELECT p.id, v_replay, p.status, p.revision FROM purchases p WHERE p.business_id = v_business AND p.id = p_purchase_id;
END;
$$;

COMMENT ON FUNCTION purchase_cancel(UUID, UUID, INTEGER) IS
  'P3-S4 §2.4, A-04. First consumes an invctl/1 assertion of kind purchase.cancel over its own arguments (id, warehouse, draft revision). Under the daftar.purchase_id key: purchase.not_found; cancelled with an equal cancel intent replays; purchase.state_invalid unless a draft; purchase.draft_changed when the revision or warehouse moved. draft → cancelled, terminal. Audit purchase.cancelled and its outbox row. EXECUTE: daftar_app only.';

-- ─────────────────────────────────────────────────────────────────────────
-- 5. The purchase receipt (§2.4 statement order, A-07, A-13, A-16, A-17,
--    R-25): draft → received, the purchase movements, the coverage and its
--    catch-up movements, the bridges. The journal entries are posted by the
--    service afterwards, in the same transaction (A-06).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION purchase_receive(
  p_purchase_id            UUID,
  p_warehouse_id           UUID,
  p_draft_revision         INTEGER,
  p_supplier_id            UUID,
  p_supplier_revision      INTEGER,
  p_document_date          DATE,
  p_currency_code          CHAR(3),
  p_rate_id                UUID,
  p_rate                   NUMERIC,
  p_rate_source            TEXT,
  p_rate_at                TIMESTAMPTZ,
  p_total_txn_minor        BIGINT,
  p_total_base_minor       BIGINT,
  p_coverage_adjustment_id UUID,
  p_line_ids               UUID[],
  p_variant_ids            UUID[],
  p_qtys                   NUMERIC[],
  p_base_shares            BIGINT[],
  p_covered_qtys           NUMERIC[],
  p_catch_ups              BIGINT[]
) RETURNS TABLE (
  purchase_id                      UUID,
  replayed                         BOOLEAN,
  business_transaction_id          UUID,
  total_txn_minor                  BIGINT,
  total_base_minor                 BIGINT,
  fx_rate_id                       UUID,
  source_to_base_rate              NUMERIC,
  rate_source                      TEXT,
  rate_timestamp                   TIMESTAMPTZ,
  coverage_adjustment_id           UUID,
  coverage_total_value_base_minor  BIGINT,
  row_kind                         TEXT,
  line_id                          UUID,
  line_no                          INTEGER,
  variant_id                       UUID,
  qty                              NUMERIC,
  base_share_minor                 BIGINT,
  unit_cost_base_minor             NUMERIC,
  movement_id                      UUID,
  coverage_id                      UUID,
  deficit_id                       UUID,
  qty_covered                      NUMERIC,
  provisional_unit_cost_base_minor NUMERIC,
  actual_unit_cost_base_minor      NUMERIC,
  value_delta_base_minor           BIGINT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_actor     inventory_verified_actor;
  v_business  UUID;
  v_tenant    UUID;
  v_trace     UUID;
  v_intent    TEXT;
  v_p         RECORD;
  v_s         RECORD;
  v_replay    BOOLEAN;
  v_n         INTEGER;
  v_i         INTEGER;
  v_tz        TEXT;
  v_base_ccy  TEXT;
  v_et        INTEGER;
  v_eb        INTEGER;
  v_fx        accounting_fx_rate_snapshot;
  v_rate_id   UUID;
  v_rate      NUMERIC;
  v_source    TEXT;
  v_at        TIMESTAMPTZ;
  v_lc        RECORD;
  v_nets      BIGINT[];
  v_t         BIGINT[];
  v_ids       UUID[];
  v_variants  UUID[];
  v_qtys      NUMERIC[];
  v_sum_t         NUMERIC;
  v_base_total         NUMERIC;
  v_shares    BIGINT[];
  v_costs     NUMERIC[];
  v_reqs      inventory_movement_request[];
  v_mv        RECORD;
  v_cov       RECORD;
  v_cov_qty   NUMERIC[];
  v_cov_val   NUMERIC[];
  v_covered   NUMERIC;
  v_rows      INTEGER;
BEGIN
  v_actor := inventory_assertion_consume('purchase.receive', inventory_claimed_payload_digest('purchase.receive',
    ARRAY['uuid', 'uuid', 'integer', 'uuid', 'integer', 'integer', 'code', 'uuid', 'integer', 'code', 'integer', 'integer', 'integer', 'uuid', 'integer']
      || ARRAY(SELECT f.t FROM unnest(p_line_ids, p_variant_ids, p_qtys, p_base_shares, p_covered_qtys, p_catch_ups)
                                 WITH ORDINALITY AS l(li, v, q, s, c, u, i)
               CROSS JOIN LATERAL unnest(ARRAY['uuid', 'uuid', 'integer', 'integer', 'integer', 'integer']) WITH ORDINALITY AS f(t, j)
               ORDER BY l.i, f.j),
    ARRAY[p_purchase_id::text, p_warehouse_id::text, p_draft_revision::text, p_supplier_id::text, p_supplier_revision::text,
          to_char(p_document_date, 'YYYYMMDD'), lower(p_currency_code::text), p_rate_id::text, inventory_fixed_text(p_rate, 10),
          p_rate_source,
          CASE WHEN extract(epoch FROM p_rate_at) = trunc(extract(epoch FROM p_rate_at))
               THEN trunc(extract(epoch FROM p_rate_at))::text ELSE extract(epoch FROM p_rate_at)::text END,
          p_total_txn_minor::text, p_total_base_minor::text, p_coverage_adjustment_id::text, coalesce(cardinality(p_line_ids), 0)::text]
      || ARRAY(SELECT f.x FROM unnest(p_line_ids, p_variant_ids, p_qtys, p_base_shares, p_covered_qtys, p_catch_ups)
                                 WITH ORDINALITY AS l(li, v, q, s, c, u, i)
               CROSS JOIN LATERAL unnest(ARRAY[l.li::text, l.v::text, inventory_fixed_text(l.q, 4), l.s::text, inventory_fixed_text(l.c, 4), l.u::text])
                 WITH ORDINALITY AS f(x, j)
               ORDER BY l.i, f.j)));
  -- 2. Isolation and trace.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: stock commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_business := v_actor.business_id;
  v_tenant   := v_actor.tenant_id;
  v_replay   := false;
  v_trace    := inventory_business_transaction_id();
  IF v_trace IS NULL THEN
    RAISE EXCEPTION 'inventory.trace_missing: a stock document records its business transaction id' USING ERRCODE = 'P0001';
  END IF;
  IF p_purchase_id IS NULL OR p_warehouse_id IS NULL OR p_draft_revision IS NULL THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a receipt names the purchase, its warehouse and its draft revision' USING ERRCODE = 'P0001';
  END IF;

  -- 3. The document key, then the intent (A-10(b): id, warehouse, revision).
  PERFORM pg_advisory_xact_lock(hashtext('daftar.purchase_id'), hashtext(p_purchase_id::text));
  v_intent := inventory_payload_digest('purchase.receive', v_tenant, v_business, ARRAY['uuid', 'uuid', 'integer'],
                                       ARRAY[p_purchase_id::text, p_warehouse_id::text, p_draft_revision::text]);

  -- 4. The purchase FOR UPDATE and the proof, before any other read.
  SELECT p.status, p.revision, p.warehouse_id, p.supplier_id, p.currency_code, p.document_date, p.receive_intent_sha256,
         p.tax_minor, p.total_txn_minor
    INTO v_p
  FROM purchases p WHERE p.business_id = v_business AND p.id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase.not_found: the purchase does not exist in this business' USING ERRCODE = 'P0001';
  END IF;
  IF v_p.status = 'received' AND v_p.receive_intent_sha256 = v_intent THEN
    v_replay := true;
  ELSE
    IF v_p.status <> 'draft' THEN
      RAISE EXCEPTION 'purchase.state_invalid: only a draft purchase is received' USING ERRCODE = 'P0001';
    END IF;
    v_n := coalesce(cardinality(p_line_ids), 0);
    IF v_n = 0 OR v_n > 200 OR array_ndims(p_line_ids) <> 1 OR array_lower(p_line_ids, 1) <> 1
       OR p_variant_ids IS NULL OR array_ndims(p_variant_ids) <> 1 OR array_lower(p_variant_ids, 1) <> 1 OR cardinality(p_variant_ids) <> v_n
       OR p_qtys IS NULL OR array_ndims(p_qtys) <> 1 OR array_lower(p_qtys, 1) <> 1 OR cardinality(p_qtys) <> v_n
       OR p_base_shares IS NULL OR array_ndims(p_base_shares) <> 1 OR array_lower(p_base_shares, 1) <> 1 OR cardinality(p_base_shares) <> v_n
       OR p_covered_qtys IS NULL OR array_ndims(p_covered_qtys) <> 1 OR array_lower(p_covered_qtys, 1) <> 1 OR cardinality(p_covered_qtys) <> v_n
       OR p_catch_ups IS NULL OR array_ndims(p_catch_ups) <> 1 OR array_lower(p_catch_ups, 1) <> 1 OR cardinality(p_catch_ups) <> v_n
       OR array_position(p_line_ids, NULL) IS NOT NULL OR array_position(p_variant_ids, NULL) IS NOT NULL
       OR array_position(p_qtys, NULL) IS NOT NULL OR array_position(p_base_shares, NULL) IS NOT NULL
       OR array_position(p_covered_qtys, NULL) IS NOT NULL OR array_position(p_catch_ups, NULL) IS NOT NULL
       OR p_supplier_id IS NULL OR p_supplier_revision IS NULL OR p_document_date IS NULL OR p_currency_code IS NULL
       OR p_rate IS NULL OR p_rate_source IS NULL OR p_rate_at IS NULL OR p_total_txn_minor IS NULL OR p_total_base_minor IS NULL THEN
      RAISE EXCEPTION 'inventory.payload_invalid: a receipt binds its supplier, date, currency, rate, totals and 1..200 complete lines' USING ERRCODE = 'P0001';
    END IF;
    SELECT array_agg(l.id ORDER BY l.line_no), array_agg(l.variant_id ORDER BY l.line_no), array_agg(l.qty ORDER BY l.line_no),
           array_agg(l.net_txn_minor ORDER BY l.line_no), array_agg(l.net_txn_minor + l.landed_cost_txn_minor ORDER BY l.line_no)
      INTO v_ids, v_variants, v_qtys, v_nets, v_t
    FROM purchase_lines l WHERE l.business_id = v_business AND l.purchase_id = p_purchase_id;
    IF v_p.revision <> p_draft_revision OR v_p.warehouse_id <> p_warehouse_id
       OR v_ids IS DISTINCT FROM p_line_ids OR v_variants IS DISTINCT FROM p_variant_ids OR v_qtys IS DISTINCT FROM p_qtys
       OR v_p.document_date <> p_document_date OR v_p.currency_code <> p_currency_code THEN
      RAISE EXCEPTION 'purchase.draft_changed: the draft changed since it was read' USING ERRCODE = 'P0001';
    END IF;

    -- 5. Lock step 2b: the supplier at the bound revision, active.
    SELECT s.id, s.revision, s.status, s.name, s.tax_identifier, s.phone INTO v_s
    FROM suppliers s WHERE s.business_id = v_business AND s.id = v_p.supplier_id FOR SHARE;
    IF v_p.supplier_id <> p_supplier_id OR v_s.revision <> p_supplier_revision THEN
      RAISE EXCEPTION 'purchase.supplier_changed: the supplier changed since the receipt was prepared' USING ERRCODE = 'P0001';
    END IF;
    IF v_s.status <> 'active' THEN
      RAISE EXCEPTION 'purchase.supplier_inactive: an inactive supplier takes no purchase' USING ERRCODE = 'P0001';
    END IF;

    -- 6. The document date, early (the 0058 rule).
    SELECT b.timezone, b.base_currency INTO v_tz, v_base_ccy FROM businesses b WHERE b.id = v_business;
    IF v_p.document_date > (now() AT TIME ZONE v_tz)::date THEN
      RAISE EXCEPTION 'purchase.document_date_in_future: a purchase is received on or before today in the business timezone' USING ERRCODE = 'P0001';
    END IF;

    -- 7. The FX snapshot (A-17, R-17): no clock; the instant is derived.
    IF v_p.currency_code::text = v_base_ccy THEN
      v_rate_id := NULL;
      v_rate    := 1;
      v_source  := 'base';
      v_at      := v_p.document_date::timestamp AT TIME ZONE 'UTC';
    ELSE
      v_fx := accounting_purchase_fx_rate(v_business, v_p.currency_code,
                                          ((v_p.document_date + 1)::timestamp AT TIME ZONE v_tz) - interval '1 second');
      v_rate_id := v_fx.rate_id;
      v_rate    := v_fx.rate;
      v_source  := v_fx.source;
      v_at      := v_fx.effective_at;
    END IF;
    IF p_rate_id IS DISTINCT FROM v_rate_id OR p_rate <> v_rate OR p_rate_source <> v_source OR p_rate_at <> v_at THEN
      RAISE EXCEPTION 'purchase.fx_rate_changed: the exchange rate changed since the receipt was prepared' USING ERRCODE = 'P0001';
    END IF;

    -- 8. A-13 recomputed from the stored draft: every by_value allocation
    --    re-derived, T, B = HALF_EVEN(T × rate × 10^(e_b − e_t)), s_i = LR(B; t_i).
    FOR v_lc IN
      SELECT c.id, c.amount_txn_minor,
             (SELECT array_agg(a.amount_txn_minor ORDER BY l.line_no)
                FROM purchase_landed_cost_allocations a
                JOIN purchase_lines l ON l.business_id = a.business_id AND l.purchase_id = a.purchase_id AND l.id = a.purchase_line_id
               WHERE a.business_id = c.business_id AND a.landed_cost_id = c.id) AS stored
      FROM purchase_landed_costs c
      WHERE c.business_id = v_business AND c.purchase_id = p_purchase_id AND c.mode = 'by_value'
      ORDER BY c.cost_no
    LOOP
      IF v_lc.stored IS DISTINCT FROM inventory_largest_remainder(v_nets::numeric[], v_lc.amount_txn_minor) THEN
        RAISE EXCEPTION 'inventory.valuation_changed: the landed-cost allocation no longer follows its draft' USING ERRCODE = 'P0001';
      END IF;
    END LOOP;
    SELECT sum(x.t) INTO v_sum_t FROM unnest(v_t) AS x(t);
    v_sum_t := v_sum_t + v_p.tax_minor;
    IF v_sum_t <> v_p.total_txn_minor OR v_sum_t <> p_total_txn_minor THEN
      RAISE EXCEPTION 'inventory.valuation_changed: the purchase total changed since the receipt was prepared' USING ERRCODE = 'P0001';
    END IF;
    SELECT c.minor_units INTO v_et FROM currencies c WHERE c.code = v_p.currency_code::text;
    SELECT c.minor_units INTO v_eb FROM currencies c WHERE c.code = v_base_ccy;
    v_base_total := inventory_half_even(v_sum_t * v_rate * power(10::numeric, greatest(0, v_eb - v_et)), power(10::numeric, greatest(0, v_et - v_eb)), 0);
    IF v_base_total <= 0 THEN
      RAISE EXCEPTION 'purchase.total_zero: a purchase total is positive in the base currency' USING ERRCODE = 'P0001';
    END IF;
    IF v_base_total > 1000000000000000000 THEN
      RAISE EXCEPTION 'inventory.value_out_of_range: the purchase base total is outside the supported range' USING ERRCODE = 'P0001';
    END IF;
    v_shares := inventory_largest_remainder(v_t::numeric[], v_base_total::bigint);
    IF v_base_total <> p_total_base_minor OR v_shares IS DISTINCT FROM p_base_shares THEN
      RAISE EXCEPTION 'inventory.valuation_changed: the base amounts changed since the receipt was prepared' USING ERRCODE = 'P0001';
    END IF;
    v_costs := ARRAY[]::numeric[];
    FOR v_i IN 1 .. v_n LOOP
      v_costs := v_costs || inventory_half_even(v_shares[v_i], v_qtys[v_i], 10);
    END LOOP;

    -- 9. Lock step 6: targets, re-checks, products.
    PERFORM purchase_lock_receipt_targets(v_p.warehouse_id, v_variants);

    -- 10. The purchase movements (A-16(f) per key): the primitive creates
    --     and locks every key in (warehouse, variant) order (R-25).
    v_reqs := ARRAY[]::inventory_movement_request[];
    FOR v_i IN 1 .. v_n LOOP
      v_reqs := v_reqs
        || ROW(v_p.warehouse_id, v_variants[v_i], 'purchase', 'purchase', p_purchase_id, v_ids[v_i],
               v_qtys[v_i], v_costs[v_i], v_shares[v_i], NULL)::inventory_movement_request;
    END LOOP;
    FOR v_mv IN SELECT r.ordinal, r.value_delta_base_minor AS val, r.unit_cost_base_minor AS cost FROM inventory_apply_stock_movements(v_reqs) AS r LOOP
      IF v_mv.val IS DISTINCT FROM v_shares[v_mv.ordinal] OR v_mv.cost IS DISTINCT FROM v_costs[v_mv.ordinal] THEN
        RAISE EXCEPTION 'inventory.valuation_changed: the stock value changed since the command was prepared' USING ERRCODE = 'P0001';
      END IF;
    END LOOP;

    -- 11. The coverage (A-16) under the key locks, then its catch-up
    --     movements; every covered quantity and catch-up must be the bound one.
    v_cov_qty := array_fill(0::numeric, ARRAY[v_n]);
    v_cov_val := array_fill(0::numeric, ARRAY[v_n]);
    v_reqs := ARRAY[]::inventory_movement_request[];
    FOR v_cov IN SELECT c.line_id AS line, c.variant_id AS variant, c.coverage_id AS id, c.qty_covered AS qty, c.value_delta_base_minor AS val
                 FROM purchase_cover_deficits(p_purchase_id, p_coverage_adjustment_id) AS c LOOP
      v_i := array_position(v_ids, v_cov.line);
      v_cov_qty[v_i] := v_cov_qty[v_i] + v_cov.qty;
      v_cov_val[v_i] := v_cov_val[v_i] + v_cov.val;
      IF v_cov.val <> 0 THEN
        v_reqs := v_reqs
          || ROW(v_p.warehouse_id, v_cov.variant, 'negative_inventory_cost_adjustment', 'negative_inventory_cost_adjustment',
                 p_coverage_adjustment_id, v_cov.id, 0, NULL, v_cov.val, NULL)::inventory_movement_request;
      END IF;
    END LOOP;
    IF v_cov_qty IS DISTINCT FROM p_covered_qtys::numeric[] OR v_cov_val IS DISTINCT FROM p_catch_ups::numeric[] THEN
      RAISE EXCEPTION 'inventory.valuation_changed: the deficit coverage changed since the receipt was prepared' USING ERRCODE = 'P0001';
    END IF;
    IF cardinality(v_reqs) > 0 THEN
      FOR v_mv IN SELECT r.ordinal, r.value_delta_base_minor AS val FROM inventory_apply_stock_movements(v_reqs) AS r LOOP
        IF v_mv.val IS DISTINCT FROM v_reqs[v_mv.ordinal].value_delta_base_minor THEN
          RAISE EXCEPTION 'inventory.valuation_changed: the stock value changed since the command was prepared' USING ERRCODE = 'P0001';
        END IF;
      END LOOP;
    END IF;

    IF EXISTS (SELECT 1 FROM product_variants pv JOIN products p ON p.business_id = pv.business_id AND p.id = pv.product_id
                WHERE pv.business_id = v_business AND pv.id = ANY (v_variants) AND p.status <> 'active') THEN
      RAISE EXCEPTION 'inventory.variant_archived: the variant or its product is archived' USING ERRCODE = 'P0001';
    END IF;

    -- 12. The lines (shares and costs), THEN the header: received.
    UPDATE purchase_lines l SET base_share_minor = x.share, unit_cost_base_minor = x.cost
      FROM unnest(v_ids, v_shares, v_costs) AS x(id, share, cost)
     WHERE l.business_id = v_business AND l.purchase_id = p_purchase_id AND l.id = x.id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> v_n THEN
      RAISE EXCEPTION 'purchase.draft_changed: the draft lines changed while the receipt ran' USING ERRCODE = 'P0001';
    END IF;
    UPDATE purchases p
       SET status = 'received', source_to_base_rate = v_rate, rate_source = v_source, rate_timestamp = v_at, fx_rate_id = v_rate_id,
           total_base_minor = v_base_total::bigint, supplier_name_snapshot = v_s.name, supplier_tax_identifier_snapshot = v_s.tax_identifier,
           supplier_phone_snapshot = v_s.phone, received_by = v_actor.actor_user_id, received_at = now(),
           receive_intent_sha256 = v_intent, binding_source_id = p_purchase_id, business_transaction_id = v_trace, updated_at = now()
     WHERE p.business_id = v_business AND p.id = p_purchase_id;

    -- 13. The bridges.
    PERFORM purchase_bridge_receipt(p_purchase_id, p_coverage_adjustment_id);

    -- 14. Audit and outbox (A-21): ids, not amounts.
    INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
    VALUES (v_tenant, v_business, v_actor.actor_user_id, 'purchase.received', 'purchase', p_purchase_id::text,
            jsonb_build_object('warehouseId', v_p.warehouse_id, 'supplierId', v_p.supplier_id, 'lineCount', v_n,
                               'coverageAdjustmentId', p_coverage_adjustment_id,
                               'assertionJti', v_actor.jti, 'business_transaction_id', v_trace));
    INSERT INTO outbox_events (tenant_id, business_id, type, payload)
    VALUES (v_tenant, v_business, 'purchase.received.v1',
            jsonb_build_object('businessId', v_business, 'purchaseId', p_purchase_id, 'businessTransactionId', v_trace));
    IF p_coverage_adjustment_id IS NOT NULL THEN
      SELECT sum(x.q) INTO v_covered FROM unnest(v_cov_qty) AS x(q);
      INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
      VALUES (v_tenant, v_business, v_actor.actor_user_id, 'inventory.deficit_covered', 'negative_inventory_cost_adjustment',
              p_coverage_adjustment_id::text,
              jsonb_build_object('purchaseId', p_purchase_id, 'warehouseId', v_p.warehouse_id,
                                 'coverageCount', (SELECT count(*) FROM negative_deficit_coverages c
                                                    WHERE c.business_id = v_business AND c.adjustment_id = p_coverage_adjustment_id),
                                 'assertionJti', v_actor.jti, 'business_transaction_id', v_trace));
      INSERT INTO outbox_events (tenant_id, business_id, type, payload)
      VALUES (v_tenant, v_business, 'inventory.deficit_covered.v1',
              jsonb_build_object('businessId', v_business, 'adjustmentId', p_coverage_adjustment_id, 'purchaseId', p_purchase_id,
                                 'businessTransactionId', v_trace));
    END IF;
  END IF;

  -- 15. The stored rows: the lines with their movements, then each line's
  --     coverages in FIFO order with their movements (A-10(e)).
  RETURN QUERY
  SELECT x.pid, v_replay, x.btx, x.ttx, x.tbase, x.fxid, x.rate, x.src, x.rts, x.aid, x.atotal,
         x.kind, x.lid, x.lno, x.vid, x.q, x.share, x.cost, x.mid, x.cid, x.did, x.qc, x.prov, x.act, x.val
  FROM (
    SELECT p.id AS pid, p.business_transaction_id AS btx, p.total_txn_minor AS ttx, p.total_base_minor AS tbase, p.fx_rate_id AS fxid,
           p.source_to_base_rate::numeric AS rate, p.rate_source AS src, p.rate_timestamp AS rts, a.id AS aid,
           a.total_value_base_minor AS atotal, 'line'::text AS kind, l.id AS lid, l.line_no AS lno, l.variant_id AS vid,
           l.qty::numeric AS q, l.base_share_minor AS share, l.unit_cost_base_minor::numeric AS cost, m.id AS mid,
           NULL::uuid AS cid, NULL::uuid AS did, NULL::numeric AS qc, NULL::numeric AS prov, NULL::numeric AS act,
           m.value_delta_base_minor AS val, 0 AS ord, 0::bigint AS seq
    FROM purchases p
    JOIN purchase_lines l ON l.business_id = p.business_id AND l.purchase_id = p.id
    LEFT JOIN negative_inventory_cost_adjustments a
      ON a.business_id = p.business_id AND a.origin_source_type = 'purchase' AND a.origin_source_id = p.id
    LEFT JOIN stock_source_bridge_purchase b ON b.business_id = l.business_id AND b.source_id = l.purchase_id AND b.source_line_id = l.id
    LEFT JOIN stock_movements m
      ON m.business_id = b.business_id AND m.source_type = b.source_type AND m.source_id = b.source_id
     AND m.source_line_id = b.source_line_id AND m.movement_kind = b.movement_kind
    WHERE p.business_id = v_business AND p.id = p_purchase_id
    UNION ALL
    SELECT p.id, p.business_transaction_id, p.total_txn_minor, p.total_base_minor, p.fx_rate_id, p.source_to_base_rate::numeric,
           p.rate_source, p.rate_timestamp, a.id, a.total_value_base_minor, 'coverage'::text, l.id, l.line_no, c.variant_id,
           NULL::numeric, NULL::bigint, NULL::numeric, m.id, c.id, c.deficit_id, c.qty_covered::numeric,
           c.provisional_unit_cost_base_minor::numeric, c.actual_unit_cost_base_minor::numeric, m.value_delta_base_minor, 1, d.deficit_seq
    FROM purchases p
    JOIN negative_inventory_cost_adjustments a
      ON a.business_id = p.business_id AND a.origin_source_type = 'purchase' AND a.origin_source_id = p.id
    JOIN negative_deficit_coverages c ON c.business_id = a.business_id AND c.adjustment_id = a.id
    JOIN negative_inventory_deficits d ON d.business_id = c.business_id AND d.id = c.deficit_id
    JOIN purchase_lines l ON l.business_id = p.business_id AND l.purchase_id = p.id AND l.variant_id = c.variant_id
    LEFT JOIN stock_source_bridge_negative_inventory_cost_adjustment b
      ON b.business_id = c.business_id AND b.source_id = c.adjustment_id AND b.source_line_id = c.id
    LEFT JOIN stock_movements m
      ON m.business_id = b.business_id AND m.source_type = b.source_type AND m.source_id = b.source_id
     AND m.source_line_id = b.source_line_id AND m.movement_kind = b.movement_kind
    WHERE p.business_id = v_business AND p.id = p_purchase_id
  ) AS x
  ORDER BY x.lno, x.ord, x.seq, x.did;
END;
$$;

COMMENT ON FUNCTION purchase_receive(UUID, UUID, INTEGER, UUID, INTEGER, DATE, CHAR(3), UUID, NUMERIC, TEXT, TIMESTAMPTZ, BIGINT, BIGINT, UUID, UUID[], UUID[], NUMERIC[], BIGINT[], NUMERIC[], BIGINT[]) IS
  'P3-S4 §2.4, A-07, A-13, A-16, A-17, R-25. First consumes an invctl/1 assertion of kind purchase.receive over its own arguments (A-09). Under the daftar.purchase_id key, with the intent (id, warehouse, draft revision): received with an equal intent returns the stored rows (replayed); purchase.state_invalid; purchase.draft_changed (revision, warehouse, lines, date, currency); the supplier FOR SHARE at the bound revision (purchase.supplier_changed / supplier_inactive); purchase.document_date_in_future; the FX snapshot at the R-17 instant (purchase.fx_rate_changed); A-13 recomputed (inventory.valuation_changed; purchase.total_zero). Then lock step 6, the purchase movements, the coverage and its catch-up movements (bound quantities and values, inventory.valuation_changed), the lines and the header (received, snapshots, binding), the bridges, audit purchase.received (and inventory.deficit_covered). The journal entries are posted by the caller in the same transaction. EXECUTE: daftar_app only.';

-- ─────────────────────────────────────────────────────────────────────────
-- 6. Privileges, then the ownership transfer (the 0062 order).
-- ─────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION purchase_lock_receipt_targets(UUID, UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION purchase_cover_deficits(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION purchase_bridge_receipt(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION supplier_create(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION supplier_update(UUID, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION supplier_archive(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION supplier_reactivate(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION purchase_save_draft(UUID, INTEGER, UUID, UUID, UUID, CHAR(3), DATE, TEXT, TEXT, BIGINT, UUID[], UUID[], NUMERIC[], NUMERIC[], BIGINT[], UUID[], TEXT[], BIGINT[], TEXT[], BIGINT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION purchase_cancel(UUID, UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION purchase_receive(UUID, UUID, INTEGER, UUID, INTEGER, DATE, CHAR(3), UUID, NUMERIC, TEXT, TIMESTAMPTZ, BIGINT, BIGINT, UUID, UUID[], UUID[], NUMERIC[], BIGINT[], NUMERIC[], BIGINT[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION supplier_create(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO daftar_app;
GRANT EXECUTE ON FUNCTION supplier_update(UUID, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT) TO daftar_app;
GRANT EXECUTE ON FUNCTION supplier_archive(UUID, INTEGER) TO daftar_app;
GRANT EXECUTE ON FUNCTION supplier_reactivate(UUID, INTEGER) TO daftar_app;
GRANT EXECUTE ON FUNCTION purchase_save_draft(UUID, INTEGER, UUID, UUID, UUID, CHAR(3), DATE, TEXT, TEXT, BIGINT, UUID[], UUID[], NUMERIC[], NUMERIC[], BIGINT[], UUID[], TEXT[], BIGINT[], TEXT[], BIGINT[]) TO daftar_app;
GRANT EXECUTE ON FUNCTION purchase_cancel(UUID, UUID, INTEGER) TO daftar_app;
GRANT EXECUTE ON FUNCTION purchase_receive(UUID, UUID, INTEGER, UUID, INTEGER, DATE, CHAR(3), UUID, NUMERIC, TEXT, TIMESTAMPTZ, BIGINT, BIGINT, UUID, UUID[], UUID[], NUMERIC[], BIGINT[], NUMERIC[], BIGINT[]) TO daftar_app;

GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;

ALTER FUNCTION purchase_lock_receipt_targets(UUID, UUID[]) OWNER TO daftar_inventory_internal;
ALTER FUNCTION purchase_cover_deficits(UUID, UUID) OWNER TO daftar_inventory_internal;
ALTER FUNCTION purchase_bridge_receipt(UUID, UUID) OWNER TO daftar_inventory_internal;
ALTER FUNCTION supplier_create(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) OWNER TO daftar_inventory_internal;
ALTER FUNCTION supplier_update(UUID, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT) OWNER TO daftar_inventory_internal;
ALTER FUNCTION supplier_archive(UUID, INTEGER) OWNER TO daftar_inventory_internal;
ALTER FUNCTION supplier_reactivate(UUID, INTEGER) OWNER TO daftar_inventory_internal;
ALTER FUNCTION purchase_save_draft(UUID, INTEGER, UUID, UUID, UUID, CHAR(3), DATE, TEXT, TEXT, BIGINT, UUID[], UUID[], NUMERIC[], NUMERIC[], BIGINT[], UUID[], TEXT[], BIGINT[], TEXT[], BIGINT[]) OWNER TO daftar_inventory_internal;
ALTER FUNCTION purchase_cancel(UUID, UUID, INTEGER) OWNER TO daftar_inventory_internal;
ALTER FUNCTION purchase_receive(UUID, UUID, INTEGER, UUID, INTEGER, DATE, CHAR(3), UUID, NUMERIC, TEXT, TIMESTAMPTZ, BIGINT, BIGINT, UUID, UUID[], UUID[], NUMERIC[], BIGINT[], NUMERIC[], BIGINT[]) OWNER TO daftar_inventory_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 7. Registrations (§2.5): the seven kinds and the two op→movement pairs.
--    Last, so no kind names a routine that does not exist yet.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO inventory_operation_kinds (op_code, registered_by) VALUES
  ('supplier.create','P3-S4'), ('supplier.update','P3-S4'), ('supplier.archive','P3-S4'), ('supplier.reactivate','P3-S4'),
  ('purchase.draft','P3-S4'), ('purchase.cancel','P3-S4'), ('purchase.receive','P3-S4');
INSERT INTO inventory_operation_movement_kinds (op_code, movement_kind, registered_by) VALUES
  ('purchase.receive','purchase','P3-S4'), ('purchase.receive','negative_inventory_cost_adjustment','P3-S4');

-- ─────────────────────────────────────────────────────────────────────────
-- 8. Refuse to commit unless the end state is exactly right (0064-E, §2.8).
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_role    TEXT;
  v_proc    REGPROCEDURE;
  v_detail  TEXT;
  v_first   TEXT;
  v_src     TEXT;
  v_key     INTEGER;
  v_read    INTEGER;
  c_runtime CONSTANT TEXT[] := ARRAY['daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver',
                                     'daftar_provisioner', 'daftar_reconciler', 'public'];
  c_entry   CONSTANT REGPROCEDURE[] := ARRAY[
    'supplier_create(uuid,text,text,text,text,text)'::regprocedure,
    'supplier_update(uuid,integer,text,text,text,text,text)'::regprocedure,
    'supplier_archive(uuid,integer)'::regprocedure,
    'supplier_reactivate(uuid,integer)'::regprocedure,
    'purchase_save_draft(uuid,integer,uuid,uuid,uuid,char,date,text,text,bigint,uuid[],uuid[],numeric[],numeric[],bigint[],uuid[],text[],bigint[],text[],bigint[])'::regprocedure,
    'purchase_cancel(uuid,uuid,integer)'::regprocedure,
    'purchase_receive(uuid,uuid,integer,uuid,integer,date,char,uuid,numeric,text,timestamptz,bigint,bigint,uuid,uuid[],uuid[],numeric[],bigint[],numeric[],bigint[])'::regprocedure];
  c_helpers CONSTANT REGPROCEDURE[] := ARRAY[
    'purchase_lock_receipt_targets(uuid,uuid[])'::regprocedure,
    'purchase_cover_deficits(uuid,uuid)'::regprocedure,
    'purchase_bridge_receipt(uuid,uuid)'::regprocedure];
BEGIN
  -- (1) The operation registry: the three S1, seven S3 and seven S4 kinds.
  SELECT string_agg(k.op_code || ':' || k.registered_by, ', ' ORDER BY k.op_code) INTO v_detail FROM inventory_operation_kinds k;
  IF v_detail IS DISTINCT FROM
     'inventory.adjust:P3-S3, inventory.configure_product:P3-S1, inventory.damage:P3-S3, inventory.opening:P3-S3, '
     'inventory.stocktake_count:P3-S3, inventory.stocktake_finalize:P3-S3, inventory.stocktake_open:P3-S3, inventory.transfer:P3-S3, '
     'purchase.cancel:P3-S4, purchase.draft:P3-S4, purchase.receive:P3-S4, '
     'structure.associate_warehouse_branch:P3-S1, structure.dissociate_warehouse_branch:P3-S1, '
     'supplier.archive:P3-S4, supplier.create:P3-S4, supplier.reactivate:P3-S4, supplier.update:P3-S4' THEN
    RAISE EXCEPTION 'purchase.migration_end_state_invalid: inventory_operation_kinds is not the S1 three, the S3 seven and the S4 seven, found %', v_detail;
  END IF;

  -- (2) The six S3 pairs plus exactly the two S4 pairs.
  SELECT string_agg(m.op_code || '>' || m.movement_kind || ':' || m.registered_by, ', ' ORDER BY m.op_code, m.movement_kind) INTO v_detail
  FROM inventory_operation_movement_kinds m;
  IF v_detail IS DISTINCT FROM
     'inventory.adjust>adjustment:P3-S3, inventory.damage>damage:P3-S3, inventory.opening>inventory_opening:P3-S3, '
     'inventory.stocktake_finalize>stocktake:P3-S3, inventory.transfer>transfer_in:P3-S3, inventory.transfer>transfer_out:P3-S3, '
     'purchase.receive>negative_inventory_cost_adjustment:P3-S4, purchase.receive>purchase:P3-S4' THEN
    RAISE EXCEPTION 'purchase.migration_end_state_invalid: inventory_operation_movement_kinds is not exactly the S3 and S4 mappings, found %', v_detail;
  END IF;

  -- (3) The seven entry routines and three helpers: internal-owned DEFINER
  --     with the pinned path, exactly ten.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_detail
  FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
  WHERE p.oid = ANY (c_entry || c_helpers)
    AND (r.rolname <> 'daftar_inventory_internal' OR NOT p.prosecdef
         OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']);
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'purchase.migration_end_state_invalid: routine(s) not internal-owned SECURITY DEFINER with the pinned path: %', v_detail;
  END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.oid = ANY (c_entry || c_helpers)) <> 10
     OR (SELECT count(*) FROM pg_proc p WHERE p.proname IN ('supplier_create', 'supplier_update', 'supplier_archive', 'supplier_reactivate',
                                                            'purchase_save_draft', 'purchase_cancel', 'purchase_receive',
                                                            'purchase_lock_receipt_targets', 'purchase_cover_deficits',
                                                            'purchase_bridge_receipt')) <> 10 THEN
    RAISE EXCEPTION 'purchase.migration_end_state_invalid: the S4 routines are not exactly the seven entry routines and three helpers';
  END IF;

  -- (4) daftar_app reaches each entry routine, nobody else does; nobody
  --     reaches a helper.
  FOREACH v_proc IN ARRAY c_entry LOOP
    IF NOT has_function_privilege('daftar_app', v_proc, 'EXECUTE') THEN
      RAISE EXCEPTION 'purchase.migration_end_state_invalid: daftar_app cannot reach %', v_proc;
    END IF;
    FOREACH v_role IN ARRAY c_runtime || ARRAY['daftar_accounting_internal'] LOOP
      IF has_function_privilege(v_role, v_proc, 'EXECUTE') THEN
        RAISE EXCEPTION 'purchase.migration_end_state_invalid: % may call %', v_role, v_proc;
      END IF;
    END LOOP;
    SELECT string_agg(x.grantee::regrole::text, ',' ORDER BY x.grantee::regrole::text) INTO v_detail
    FROM pg_proc p, aclexplode(p.proacl) x
    WHERE p.oid = v_proc AND x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner;
    IF v_detail IS DISTINCT FROM 'daftar_app' THEN
      RAISE EXCEPTION 'purchase.migration_end_state_invalid: % must be executable by daftar_app only, found %', v_proc, v_detail;
    END IF;
  END LOOP;
  FOREACH v_proc IN ARRAY c_helpers LOOP
    FOREACH v_role IN ARRAY c_runtime || ARRAY['daftar_app', 'daftar_accounting_internal'] LOOP
      IF has_function_privilege(v_role, v_proc, 'EXECUTE') THEN
        RAISE EXCEPTION 'purchase.migration_end_state_invalid: % may call the helper %', v_role, v_proc;
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
                WHERE p.oid = v_proc AND x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner) THEN
      RAISE EXCEPTION 'purchase.migration_end_state_invalid: the helper % has an EXECUTE grantee', v_proc;
    END IF;
  END LOOP;

  -- (5) The first statement of every entry routine consumes the assertion;
  --     every helper opens with the re-verification (rule 22 at deploy time).
  FOREACH v_proc IN ARRAY c_entry LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_proc;
    v_first := btrim(split_part(substr(v_src, position(E'\nBEGIN\n' IN v_src) + 7), ';', 1));
    IF position(E'\nBEGIN\n' IN v_src) = 0 OR v_first !~ '^v_actor := inventory_assertion_consume\(' THEN
      RAISE EXCEPTION 'purchase.migration_end_state_invalid: % does not consume its assertion as its first statement', v_proc;
    END IF;
  END LOOP;
  FOREACH v_proc IN ARRAY c_helpers LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_proc;
    v_first := btrim(split_part(substr(v_src, position(E'\nBEGIN\n' IN v_src) + 7), ';', 1));
    IF position(E'\nBEGIN\n' IN v_src) = 0 OR v_first !~ '^v_actor := inventory_assertion_current\(ARRAY\[' THEN
      RAISE EXCEPTION 'purchase.migration_end_state_invalid: % does not re-verify the assertion as its first statement', v_proc;
    END IF;
  END LOOP;

  -- (6) The R-14 analogue (R-26): the document key precedes the intent read
  --     and the row read in the draft and the receipt (and in every S4 entry
  --     routine).
  FOREACH v_proc IN ARRAY c_entry LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_proc;
    v_key  := greatest(position('PERFORM pg_advisory_xact_lock(hashtext(''daftar.purchase_id''), hashtext(p_purchase_id::text));' IN v_src),
                       position('PERFORM pg_advisory_xact_lock(hashtext(''daftar.supplier_id''), hashtext(p_supplier_id::text));' IN v_src));
    v_read := position('v_intent :=' IN v_src);
    IF v_key = 0 OR v_read = 0 OR v_key > v_read
       OR v_key > position(' FOR UPDATE;' IN v_src) OR position(' FOR UPDATE;' IN v_src) < v_read THEN
      RAISE EXCEPTION 'purchase.migration_end_state_invalid: % does not take its document key before its intent and row reads (R-26)', v_proc;
    END IF;
  END LOOP;

  -- (7) stock_source_types unchanged since 0063, and fully guarded.
  IF (SELECT string_agg(t.source_type || ':' || t.registered_by, ',' ORDER BY t.source_type) FROM stock_source_types t)
     IS DISTINCT FROM 'inventory_adjustment:P3-S3,inventory_opening:P3-S3,inventory_transfer:P3-S3,'
                      'negative_inventory_cost_adjustment:P3-S4,purchase:P3-S4,stocktake:P3-S3' THEN
    RAISE EXCEPTION 'purchase.migration_end_state_invalid: stock_source_types changed after 0063';
  END IF;
  IF (SELECT count(*) FROM inventory_stock_source_guard_gaps()) <> 0 THEN
    RAISE EXCEPTION 'inventory.source_guard_missing: a registered stock source type lacks a guard';
  END IF;

  -- (8) No CREATE left on public for either internal principal.
  IF has_schema_privilege('daftar_inventory_internal', 'public', 'CREATE')
     OR has_schema_privilege('daftar_accounting_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'purchase.migration_end_state_invalid: an internal principal still holds CREATE on schema public';
  END IF;
END $$;
