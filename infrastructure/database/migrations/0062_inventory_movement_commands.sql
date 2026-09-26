-- 0062_inventory_movement_commands.sql
-- P3-S3, part 2 — the COMMAND side: the seven signed entry routines for
-- transfers, adjustments, damage, stocktakes (open, count, finalize/cancel)
-- and the inventory opening, their internal helpers, and the seven operation
-- kinds with their op→movement mappings (docs/PHASE_3_S3_CONTRACT.md §2.4,
-- §2.5, A-03, A-07-A-13, A-23-A-25).
--
-- Every entry routine is owned by daftar_inventory_internal, SECURITY
-- DEFINER with the pinned path, PUBLIC revoked, and reachable by daftar_app
-- only. Its FIRST statement consumes a signed invctl/1 assertion over the
-- digest of its OWN arguments (the 0055/0060 pattern); nothing is read,
-- locked or written before that. No routine reads a clock inside a digest.
--
-- ── Engineering rulings taken here (documented for the report) ──────────
--
--   R-5  Bridge writes. Rule 22 requires a routine that writes a stock table
--        (bridges included) to open with a bare assertion call whose
--        arguments call nothing; an entry routine's consume call must hash
--        its arguments (a call), so entry routines never write a stock
--        table themselves. The bridges are written by one internal helper,
--        `inventory_bridge_source_lines`, whose first statement is
--        `inventory_assertion_current(...)` and which bridges only the
--        source type the VERIFIED operation owns. The primitive stays the
--        only writer of movements, levels and bindings.
--   R-6  Idempotency order. The proof is a SELECT of the header by
--        (business_id, id) right after consume, before any other read;
--        the header INSERT ... ON CONFLICT DO NOTHING follows the shape and
--        scope checks (so a missing warehouse is `inventory.warehouse_not_found`,
--        not a raw foreign-key error), and a 0-row insert re-proves against
--        the committed header (A-10(d)'s concurrent case).
--   R-7  Stocktake finalize valuation. The internal principal may not create
--        stock_levels rows outside the primitive, so a key with no row cannot
--        be pre-locked, and locking the existing keys alone would take keys
--        out of the primitive's global order (a deadlock hazard). Instead the
--        routine reads each key's average and last_stock_seq, and requires
--        every movement the primitive writes to carry stock_seq = that
--        last_stock_seq + 1: no movement came between the read and the
--        primitive's own key lock, so the average used IS the current one.
--        Otherwise `inventory.valuation_changed` (409, retryable), the A-07
--        discipline.
--   R-8  A-03 says "seven rows"; its own table and §2.5 list SIX
--        (2+1+1+1+1). The six rows of §2.5 are registered and asserted.
--   R-9  Every document stores a NOT NULL business_transaction_id (a
--        stocktake also the trace of its close, 0061 R-16); a command that
--        writes one without the trace carrier is refused
--        `inventory.trace_missing` rather than by a raw NOT NULL.
--   R-10 A variant whose product is archived is refused
--        `inventory.variant_archived` (§3 names no product_archived code).
--   R-11 `inventory.opening_valuation_mismatch` carries no amount in its
--        message (§3: messages never carry a value; the service pre-check
--        returns the typed totals).
--   R-12 Stocktake count lines must arrive in strictly ascending variant
--        order (A-09's canonical order), else `inventory.payload_invalid`.
--   R-14 Opening idempotency under concurrency (review F2). Like adjust,
--        damage and stocktake_open, `inventory_record_opening` takes a
--        per-document-id advisory key (`daftar.inventory_opening_id`)
--        after consume and BEFORE the header SELECT, so a second identical
--        call waits for the first and replays it instead of reading
--        `inventory.opening_already_posted`. The key is step 2 of the one
--        global order (0061 R-13): document key, then the R-1 opening-balance
--        key (the position read), then the balance row, then the stock
--        targets and the primitive's own order. Nothing takes the document
--        key after the R-1 key, so the two cannot form a cycle.
--
-- Migrations 0000-0061 are untouched.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Pure helpers (A-09): the fixed-point text of a quantity or cost, and
--    the eight 32-bit words of a reason's SHA-256.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION inventory_fixed_text(p_value NUMERIC, p_scale INTEGER) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_scaled NUMERIC;
BEGIN
  IF p_scale IS NULL OR p_scale NOT IN (4, 10) THEN
    RAISE EXCEPTION 'inventory.arithmetic_invalid: a fixed-point payload field has 4 or 10 decimal places' USING ERRCODE = 'P0001';
  END IF;
  IF p_value IS NULL THEN
    RETURN NULL;
  END IF;
  v_scaled := p_value * (CASE WHEN p_scale = 4 THEN 10000::numeric ELSE 10000000000::numeric END);
  IF v_scaled <> trunc(v_scaled) THEN
    IF p_scale = 4 THEN
      RAISE EXCEPTION 'inventory.quantity_precision_invalid: a quantity is exact at 4 decimal places' USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION 'inventory.cost_invalid: a unit cost is exact at 10 decimal places' USING ERRCODE = 'P0001';
  END IF;
  RETURN trunc(v_scaled)::text;
END;
$$;

COMMENT ON FUNCTION inventory_fixed_text(NUMERIC, INTEGER) IS
  'P3-S3 A-09. The invpl/1 integer text of p_value x 10^p_scale, p_scale being 4 for a Q4 quantity or 10 for a C10 cost; NULL for NULL. Refuses a value that is not exact at those places with inventory.quantity_precision_invalid or inventory.cost_invalid, and any other number of places with inventory.arithmetic_invalid. Internal-owned, no grant.';

CREATE OR REPLACE FUNCTION inventory_reason_words(p_reason TEXT) RETURNS TEXT[]
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_digest BYTEA;
  v_words  TEXT[];
  v_i      INTEGER;
BEGIN
  IF p_reason IS NULL THEN
    RETURN ARRAY[NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL]::text[];
  END IF;
  v_digest := digest(convert_to(p_reason, 'UTF8'), 'sha256');
  v_words  := ARRAY[]::text[];
  FOR v_i IN 0 .. 7 LOOP
    v_words := v_words || ((get_byte(v_digest, 4 * v_i)::bigint * 16777216)
                         + (get_byte(v_digest, 4 * v_i + 1)::bigint * 65536)
                         + (get_byte(v_digest, 4 * v_i + 2)::bigint * 256)
                         +  get_byte(v_digest, 4 * v_i + 3)::bigint)::text;
  END LOOP;
  RETURN v_words;
END;
$$;

COMMENT ON FUNCTION inventory_reason_words(TEXT) IS
  'P3-S3 A-09 (TL-4). The SHA-256 of the exact UTF-8 bytes of p_reason as eight unsigned 32-bit big-endian words, each base-10 text (w1..w8); eight NULLs for NULL. Binds a free-text reason under the locked invpl/1 grammar. Internal-owned, no grant.';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Internal helpers that act for a verified command (no grant).
-- ─────────────────────────────────────────────────────────────────────────

-- A-19 serialization and the A-11/A-12/A-23 status checks: SHARED advisory
-- locks on every warehouse and variant a command names (the archive
-- triggers take them EXCLUSIVE), then the targets as seen AFTER the locks.
CREATE OR REPLACE FUNCTION inventory_lock_stock_targets(p_warehouse_ids UUID[], p_variant_ids UUID[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor   inventory_verified_actor;
  v_id      UUID;
  v_status  TEXT;
  v_pstatus TEXT;
  v_tracked BOOLEAN;
BEGIN
  v_actor := inventory_assertion_current(ARRAY['inventory.adjust', 'inventory.damage', 'inventory.opening', 'inventory.stocktake_count',
                                               'inventory.stocktake_finalize', 'inventory.stocktake_open', 'inventory.transfer']);
  FOR v_id IN
    SELECT DISTINCT x.id FROM unnest(coalesce(p_warehouse_ids, ARRAY[]::uuid[]) || coalesce(p_variant_ids, ARRAY[]::uuid[])) AS x(id)
    WHERE x.id IS NOT NULL ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock_shared(hashtext('daftar.stock_target'), hashtext(v_id::text));
  END LOOP;

  FOR v_id IN SELECT DISTINCT x.id FROM unnest(p_warehouse_ids) AS x(id) ORDER BY 1 LOOP
    SELECT w.status INTO v_status FROM warehouses w WHERE w.business_id = v_actor.business_id AND w.id = v_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'inventory.warehouse_not_found: the warehouse does not exist in this business' USING ERRCODE = 'P0001';
    END IF;
    IF v_status <> 'active' THEN
      RAISE EXCEPTION 'inventory.warehouse_archived: the warehouse is archived' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  FOR v_id IN SELECT DISTINCT x.id FROM unnest(p_variant_ids) AS x(id) ORDER BY 1 LOOP
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
END;
$$;

COMMENT ON FUNCTION inventory_lock_stock_targets(UUID[], UUID[]) IS
  'P3-S3 A-19, A-23. Re-verifies the transaction''s consumed S3 assertion, takes SHARED advisory locks (daftar.stock_target) on every named warehouse and variant in id order, then requires each warehouse to exist in the verified business and be active (inventory.warehouse_not_found / _archived) and each variant to exist there, be active with an active product (inventory.variant_not_found / _archived) and be tracked (inventory.product_not_tracked). Internal-owned, no grant.';

-- The one bridge writer (R-5). Called after the primitive: every binding the
-- primitive wrote for the document gets its bridge row, for exactly the
-- source type the verified operation owns.
CREATE OR REPLACE FUNCTION inventory_bridge_source_lines(p_source_type TEXT, p_source_id UUID) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor inventory_verified_actor;
  v_type  TEXT;
  v_rows  INTEGER;
BEGIN
  v_actor := inventory_assertion_current(ARRAY['inventory.adjust', 'inventory.damage', 'inventory.opening', 'inventory.stocktake_finalize', 'inventory.transfer']);
  v_type := CASE v_actor.op_code
              WHEN 'inventory.transfer'           THEN 'inventory_transfer'
              WHEN 'inventory.adjust'             THEN 'inventory_adjustment'
              WHEN 'inventory.damage'             THEN 'inventory_adjustment'
              WHEN 'inventory.stocktake_finalize' THEN 'stocktake'
              WHEN 'inventory.opening'            THEN 'inventory_opening'
            END;
  IF p_source_id IS NULL OR v_type IS DISTINCT FROM p_source_type THEN
    RAISE EXCEPTION 'inventory.source_type_not_authorized: the verified operation does not own this stock source type' USING ERRCODE = 'P0001';
  END IF;

  IF v_type = 'inventory_transfer' THEN
    INSERT INTO stock_source_bridge_inventory_transfer (business_id, source_id, source_line_id, movement_kind)
    SELECT b.business_id, b.source_id, b.source_line_id, b.movement_kind
    FROM stock_source_bindings b
    WHERE b.business_id = v_actor.business_id AND b.source_type = 'inventory_transfer' AND b.source_id = p_source_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  ELSIF v_type = 'inventory_adjustment' THEN
    INSERT INTO stock_source_bridge_inventory_adjustment (business_id, source_id, source_line_id, movement_kind)
    SELECT b.business_id, b.source_id, b.source_line_id, b.movement_kind
    FROM stock_source_bindings b
    WHERE b.business_id = v_actor.business_id AND b.source_type = 'inventory_adjustment' AND b.source_id = p_source_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  ELSIF v_type = 'stocktake' THEN
    INSERT INTO stock_source_bridge_stocktake (business_id, source_id, source_line_id, movement_kind)
    SELECT b.business_id, b.source_id, b.source_line_id, b.movement_kind
    FROM stock_source_bindings b
    WHERE b.business_id = v_actor.business_id AND b.source_type = 'stocktake' AND b.source_id = p_source_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  ELSE
    INSERT INTO stock_source_bridge_inventory_opening (business_id, source_id, source_line_id, movement_kind)
    SELECT b.business_id, b.source_id, b.source_line_id, b.movement_kind
    FROM stock_source_bindings b
    WHERE b.business_id = v_actor.business_id AND b.source_type = 'inventory_opening' AND b.source_id = p_source_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  END IF;
  RETURN v_rows;
END;
$$;

COMMENT ON FUNCTION inventory_bridge_source_lines(TEXT, UUID) IS
  'P3-S3 A-15(g), R-5. The one writer of the four S3 bridges. First re-verifies the transaction''s consumed assertion (inventory_assertion_current over the five movement-writing S3 operations); p_source_type must be the source type the verified operation owns (inventory.source_type_not_authorized otherwise). Inserts one bridge row per stock binding of (verified business, that type, p_source_id). Internal-owned, no grant.';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. The seven entry routines (§2.4).
-- ─────────────────────────────────────────────────────────────────────────

-- 3.1 Transfer (A-04, §2.4): one command, 2n movements, no posting.
CREATE OR REPLACE FUNCTION inventory_transfer_stock(
  p_transfer_id              UUID,
  p_source_warehouse_id      UUID,
  p_destination_warehouse_id UUID,
  p_variant_ids              UUID[],
  p_qtys                     NUMERIC[]
) RETURNS TABLE (
  document_id            UUID,
  replayed               BOOLEAN,
  line_id                UUID,
  variant_id             UUID,
  value_moved_base_minor BIGINT
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
  v_n        INTEGER;
  v_i        INTEGER;
  v_rows     INTEGER;
  v_line_ids UUID[];
  v_reqs     inventory_movement_request[];
BEGIN
  v_actor := inventory_assertion_consume('inventory.transfer', inventory_claimed_payload_digest('inventory.transfer',
    ARRAY['uuid', 'uuid', 'uuid', 'integer']
      || ARRAY(SELECT f.t FROM unnest(p_variant_ids, p_qtys) WITH ORDINALITY AS l(v, q, i)
               CROSS JOIN LATERAL unnest(ARRAY['uuid', 'integer']) WITH ORDINALITY AS f(t, j) ORDER BY l.i, f.j),
    ARRAY[p_transfer_id::text, p_source_warehouse_id::text, p_destination_warehouse_id::text, coalesce(cardinality(p_variant_ids), 0)::text]
      || ARRAY(SELECT f.x FROM unnest(p_variant_ids, p_qtys) WITH ORDINALITY AS l(v, q, i)
               CROSS JOIN LATERAL unnest(ARRAY[l.v::text, inventory_fixed_text(l.q, 4)]) WITH ORDINALITY AS f(x, j) ORDER BY l.i, f.j)));
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: stock commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_business := v_actor.business_id;
  v_tenant   := v_actor.tenant_id;
  v_trace    := inventory_business_transaction_id();
  v_replay   := false;
  IF v_trace IS NULL THEN
    RAISE EXCEPTION 'inventory.trace_missing: a stock document records its business transaction id' USING ERRCODE = 'P0001';
  END IF;
  IF p_transfer_id IS NULL THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a transfer names its id' USING ERRCODE = 'P0001';
  END IF;

  -- The intent is the whole A-09 list: a transfer binds no server value.
  v_intent := inventory_payload_digest('inventory.transfer', v_tenant, v_business,
    ARRAY['uuid', 'uuid', 'uuid', 'integer']
      || ARRAY(SELECT f.t FROM unnest(p_variant_ids, p_qtys) WITH ORDINALITY AS l(v, q, i)
               CROSS JOIN LATERAL unnest(ARRAY['uuid', 'integer']) WITH ORDINALITY AS f(t, j) ORDER BY l.i, f.j),
    ARRAY[p_transfer_id::text, p_source_warehouse_id::text, p_destination_warehouse_id::text, coalesce(cardinality(p_variant_ids), 0)::text]
      || ARRAY(SELECT f.x FROM unnest(p_variant_ids, p_qtys) WITH ORDINALITY AS l(v, q, i)
               CROSS JOIN LATERAL unnest(ARRAY[l.v::text, inventory_fixed_text(l.q, 4)]) WITH ORDINALITY AS f(x, j) ORDER BY l.i, f.j));

  -- The idempotency proof, before any other read (A-10).
  SELECT t.intent_sha256 INTO v_stored FROM inventory_transfers t WHERE t.business_id = v_business AND t.id = p_transfer_id;
  IF FOUND THEN
    IF v_stored <> v_intent THEN
      RAISE EXCEPTION 'inventory.idempotency_conflict: this transfer id was used for a different transfer' USING ERRCODE = 'P0001';
    END IF;
    v_replay := true;
  ELSE
    v_n := coalesce(cardinality(p_variant_ids), 0);
    IF v_n = 0 THEN
      RAISE EXCEPTION 'inventory.lines_required: a transfer has at least one line' USING ERRCODE = 'P0001';
    END IF;
    IF v_n > 200 OR array_ndims(p_variant_ids) <> 1 OR array_lower(p_variant_ids, 1) <> 1
       OR p_qtys IS NULL OR array_ndims(p_qtys) <> 1 OR array_lower(p_qtys, 1) <> 1 OR cardinality(p_qtys) <> v_n
       OR array_position(p_variant_ids, NULL) IS NOT NULL OR array_position(p_qtys, NULL) IS NOT NULL
       OR p_source_warehouse_id IS NULL OR p_destination_warehouse_id IS NULL THEN
      RAISE EXCEPTION 'inventory.payload_invalid: a transfer has 1..200 lines, each with a variant and a quantity' USING ERRCODE = 'P0001';
    END IF;
    IF p_source_warehouse_id = p_destination_warehouse_id THEN
      RAISE EXCEPTION 'inventory.transfer_same_warehouse: a transfer moves stock between two different warehouses' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(p_qtys) AS q(qty) WHERE q.qty <= 0) THEN
      RAISE EXCEPTION 'inventory.quantity_sign_invalid: a transfer line moves a positive quantity' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(p_qtys) AS q(qty) WHERE q.qty >= 10000000000) THEN
      RAISE EXCEPTION 'inventory.quantity_out_of_range: the quantity is outside the supported range' USING ERRCODE = 'P0001';
    END IF;
    IF (SELECT count(DISTINCT x.id) FROM unnest(p_variant_ids) AS x(id)) <> v_n THEN
      RAISE EXCEPTION 'inventory.duplicate_line: a variant appears once per transfer' USING ERRCODE = 'P0001';
    END IF;

    PERFORM inventory_lock_stock_targets(ARRAY[p_source_warehouse_id, p_destination_warehouse_id], p_variant_ids);

    INSERT INTO inventory_transfers (tenant_id, business_id, id, source_warehouse_id, destination_warehouse_id, intent_sha256,
                                     actor_user_id, business_transaction_id)
    VALUES (v_tenant, v_business, p_transfer_id, p_source_warehouse_id, p_destination_warehouse_id, v_intent,
            v_actor.actor_user_id, v_trace)
    ON CONFLICT (business_id, id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN
      SELECT t.intent_sha256 INTO v_stored FROM inventory_transfers t WHERE t.business_id = v_business AND t.id = p_transfer_id;
      IF v_stored IS DISTINCT FROM v_intent THEN
        RAISE EXCEPTION 'inventory.idempotency_conflict: this transfer id was used for a different transfer' USING ERRCODE = 'P0001';
      END IF;
      v_replay := true;
    ELSE
      v_line_ids := ARRAY[]::uuid[];
      v_reqs     := ARRAY[]::inventory_movement_request[];
      FOR v_i IN 1 .. v_n LOOP
        v_line_ids := v_line_ids || gen_random_uuid();
        INSERT INTO inventory_transfer_lines (tenant_id, business_id, transfer_id, id, line_no, variant_id, qty)
        VALUES (v_tenant, v_business, p_transfer_id, v_line_ids[v_i], v_i, p_variant_ids[v_i], p_qtys[v_i]);
        v_reqs := v_reqs
          || ROW(p_source_warehouse_id, p_variant_ids[v_i], 'transfer_out', 'inventory_transfer', p_transfer_id, v_line_ids[v_i],
                 -p_qtys[v_i], NULL, NULL, NULL)::inventory_movement_request
          || ROW(p_destination_warehouse_id, p_variant_ids[v_i], 'transfer_in', 'inventory_transfer', p_transfer_id, v_line_ids[v_i],
                 p_qtys[v_i], NULL, NULL, NULL)::inventory_movement_request;
      END LOOP;

      PERFORM 1 FROM inventory_apply_stock_movements(v_reqs);

      -- R-2: the primitive's FOR SHARE waited for any product archiver.
      IF EXISTS (SELECT 1 FROM product_variants pv JOIN products p ON p.business_id = pv.business_id AND p.id = pv.product_id
                  WHERE pv.business_id = v_business AND pv.id = ANY (p_variant_ids) AND p.status <> 'active') THEN
        RAISE EXCEPTION 'inventory.variant_archived: the variant or its product is archived' USING ERRCODE = 'P0001';
      END IF;

      PERFORM inventory_bridge_source_lines('inventory_transfer', p_transfer_id);

      INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
      VALUES (v_tenant, v_business, v_actor.actor_user_id, 'inventory.transfer_completed', 'inventory_transfer', p_transfer_id::text,
              jsonb_build_object('sourceWarehouseId', p_source_warehouse_id, 'destinationWarehouseId', p_destination_warehouse_id,
                                 'lineCount', v_n, 'assertionJti', v_actor.jti, 'business_transaction_id', v_trace));
      INSERT INTO outbox_events (tenant_id, business_id, type, payload)
      VALUES (v_tenant, v_business, 'inventory.transfer_completed.v1',
              jsonb_build_object('businessId', v_business, 'documentId', p_transfer_id, 'businessTransactionId', v_trace));
    END IF;
  END IF;

  -- The answer is what was STORED, fresh or replayed (A-10(f)).
  RETURN QUERY
  SELECT p_transfer_id, v_replay, l.id, l.variant_id, m.value_delta_base_minor
  FROM inventory_transfer_lines l
  JOIN stock_source_bridge_inventory_transfer b
    ON b.business_id = l.business_id AND b.source_id = l.transfer_id AND b.source_line_id = l.id AND b.movement_kind = 'transfer_in'
  JOIN stock_movements m
    ON m.business_id = b.business_id AND m.source_type = b.source_type AND m.source_id = b.source_id
   AND m.source_line_id = b.source_line_id AND m.movement_kind = b.movement_kind
  WHERE l.business_id = v_business AND l.transfer_id = p_transfer_id
  ORDER BY l.line_no;
END;
$$;

COMMENT ON FUNCTION inventory_transfer_stock(UUID, UUID, UUID, UUID[], NUMERIC[]) IS
  'P3-S3 §2.4. First consumes an invctl/1 assertion of kind inventory.transfer over its own arguments (transfer_id, source, destination, line_count, per line variant and Q4 quantity). Proves idempotency by the stored intent (replay, or inventory.idempotency_conflict) before any other read; then 1..200 distinct lines, distinct warehouses, positive quantities; shared target locks and status checks; header, lines, one primitive call with a transfer_out and a transfer_in per line, bridges, audit inventory.transfer_completed and its outbox row. Returns the stored lines with the value moved. No journal entry. EXECUTE: daftar_app only — reachability, not authority.';

-- 3.2 Adjustment (A-12): signed lines, explicit cost on gains, bound values.
CREATE OR REPLACE FUNCTION inventory_adjust_stock(
  p_adjustment_id   UUID,
  p_warehouse_id    UUID,
  p_occurred_on     DATE,
  p_reason          TEXT,
  p_variant_ids     UUID[],
  p_qty_deltas      NUMERIC[],
  p_unit_costs      NUMERIC[],
  p_expected_values BIGINT[]
) RETURNS TABLE (
  document_id            UUID,
  replayed               BOOLEAN,
  total_value_base_minor BIGINT,
  line_id                UUID,
  variant_id             UUID,
  value_delta_base_minor BIGINT
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
  v_n        INTEGER;
  v_i        INTEGER;
  v_rows     INTEGER;
  v_total    NUMERIC;
  v_line_ids UUID[];
  v_reqs     inventory_movement_request[];
  v_mv       RECORD;
BEGIN
  v_actor := inventory_assertion_consume('inventory.adjust', inventory_claimed_payload_digest('inventory.adjust',
    ARRAY['uuid', 'uuid', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer']
      || ARRAY(SELECT f.t FROM unnest(p_variant_ids, p_qty_deltas, p_unit_costs, p_expected_values) WITH ORDINALITY AS l(v, q, c, e, i)
               CROSS JOIN LATERAL unnest(ARRAY['uuid', 'integer', 'integer', 'integer']) WITH ORDINALITY AS f(t, j) ORDER BY l.i, f.j),
    ARRAY[p_adjustment_id::text, p_warehouse_id::text, to_char(p_occurred_on, 'YYYYMMDD')]
      || inventory_reason_words(p_reason)
      || ARRAY[coalesce(cardinality(p_variant_ids), 0)::text]
      || ARRAY(SELECT f.x FROM unnest(p_variant_ids, p_qty_deltas, p_unit_costs, p_expected_values) WITH ORDINALITY AS l(v, q, c, e, i)
               CROSS JOIN LATERAL unnest(ARRAY[l.v::text, inventory_fixed_text(l.q, 4), inventory_fixed_text(l.c, 10), l.e::text])
                 WITH ORDINALITY AS f(x, j) ORDER BY l.i, f.j)));
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: stock commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_business := v_actor.business_id;
  v_tenant   := v_actor.tenant_id;
  v_trace    := inventory_business_transaction_id();
  v_replay   := false;
  IF v_trace IS NULL THEN
    RAISE EXCEPTION 'inventory.trace_missing: a stock document records its business transaction id' USING ERRCODE = 'P0001';
  END IF;
  IF p_adjustment_id IS NULL THEN
    RAISE EXCEPTION 'inventory.payload_invalid: an adjustment names its id' USING ERRCODE = 'P0001';
  END IF;

  -- The intent omits the server-derived expected values (A-10(b)).
  v_intent := inventory_payload_digest('inventory.adjust', v_tenant, v_business,
    ARRAY['uuid', 'uuid', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer']
      || ARRAY(SELECT f.t FROM unnest(p_variant_ids, p_qty_deltas, p_unit_costs) WITH ORDINALITY AS l(v, q, c, i)
               CROSS JOIN LATERAL unnest(ARRAY['uuid', 'integer', 'integer']) WITH ORDINALITY AS f(t, j) ORDER BY l.i, f.j),
    ARRAY[p_adjustment_id::text, p_warehouse_id::text, to_char(p_occurred_on, 'YYYYMMDD')]
      || inventory_reason_words(p_reason)
      || ARRAY[coalesce(cardinality(p_variant_ids), 0)::text]
      || ARRAY(SELECT f.x FROM unnest(p_variant_ids, p_qty_deltas, p_unit_costs) WITH ORDINALITY AS l(v, q, c, i)
               CROSS JOIN LATERAL unnest(ARRAY[l.v::text, inventory_fixed_text(l.q, 4), inventory_fixed_text(l.c, 10)])
                 WITH ORDINALITY AS f(x, j) ORDER BY l.i, f.j));

  -- A-10(e): adjustments and stocktakes share one accounting source id space.
  PERFORM pg_advisory_xact_lock(hashtext('daftar.inventory_adjustment_id'), hashtext(p_adjustment_id::text));

  SELECT a.intent_sha256 INTO v_stored FROM inventory_adjustments a WHERE a.business_id = v_business AND a.id = p_adjustment_id;
  IF FOUND THEN
    IF v_stored <> v_intent THEN
      RAISE EXCEPTION 'inventory.idempotency_conflict: this adjustment id was used for a different document' USING ERRCODE = 'P0001';
    END IF;
    v_replay := true;
  ELSE
    IF EXISTS (SELECT 1 FROM stocktakes s WHERE s.business_id = v_business AND s.id = p_adjustment_id) THEN
      RAISE EXCEPTION 'inventory.document_id_conflict: this id already names a stocktake' USING ERRCODE = 'P0001';
    END IF;
    v_n := coalesce(cardinality(p_variant_ids), 0);
    IF v_n = 0 THEN
      RAISE EXCEPTION 'inventory.lines_required: an adjustment has at least one line' USING ERRCODE = 'P0001';
    END IF;
    IF v_n > 200 OR array_ndims(p_variant_ids) <> 1 OR array_lower(p_variant_ids, 1) <> 1
       OR p_qty_deltas IS NULL OR array_ndims(p_qty_deltas) <> 1 OR array_lower(p_qty_deltas, 1) <> 1 OR cardinality(p_qty_deltas) <> v_n
       OR p_unit_costs IS NULL OR array_ndims(p_unit_costs) <> 1 OR array_lower(p_unit_costs, 1) <> 1 OR cardinality(p_unit_costs) <> v_n
       OR p_expected_values IS NULL OR array_ndims(p_expected_values) <> 1 OR array_lower(p_expected_values, 1) <> 1
       OR cardinality(p_expected_values) <> v_n
       OR array_position(p_variant_ids, NULL) IS NOT NULL OR array_position(p_qty_deltas, NULL) IS NOT NULL
       OR array_position(p_expected_values, NULL) IS NOT NULL
       OR p_warehouse_id IS NULL OR p_occurred_on IS NULL THEN
      RAISE EXCEPTION 'inventory.payload_invalid: an adjustment has a warehouse, a date and 1..200 complete lines' USING ERRCODE = 'P0001';
    END IF;
    IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
      RAISE EXCEPTION 'inventory.reason_required: an adjustment states a reason of 1..500 characters' USING ERRCODE = 'P0001';
    END IF;
    IF (SELECT count(DISTINCT x.id) FROM unnest(p_variant_ids) AS x(id)) <> v_n THEN
      RAISE EXCEPTION 'inventory.duplicate_line: a variant appears once per adjustment' USING ERRCODE = 'P0001';
    END IF;
    FOR v_i IN 1 .. v_n LOOP
      IF p_qty_deltas[v_i] = 0 THEN
        RAISE EXCEPTION 'inventory.quantity_sign_invalid: an adjustment line changes the quantity' USING ERRCODE = 'P0001';
      END IF;
      IF abs(p_qty_deltas[v_i]) >= 10000000000 THEN
        RAISE EXCEPTION 'inventory.quantity_out_of_range: the quantity is outside the supported range' USING ERRCODE = 'P0001';
      END IF;
      IF p_qty_deltas[v_i] > 0 AND p_unit_costs[v_i] IS NULL THEN
        RAISE EXCEPTION 'inventory.unit_cost_required: a stock gain states its unit cost' USING ERRCODE = 'P0001';
      END IF;
      IF p_qty_deltas[v_i] < 0 AND p_unit_costs[v_i] IS NOT NULL THEN
        RAISE EXCEPTION 'inventory.unit_cost_not_applicable: a stock loss is valued at the current average' USING ERRCODE = 'P0001';
      END IF;
      IF p_unit_costs[v_i] < 0 OR p_unit_costs[v_i] >= 1000000000000000000 THEN
        RAISE EXCEPTION 'inventory.cost_invalid: a unit cost is non-negative and below the limit' USING ERRCODE = 'P0001';
      END IF;
    END LOOP;
    SELECT sum(x.val) INTO v_total FROM unnest(p_expected_values) AS x(val);
    IF abs(v_total) > 1000000000000000000 THEN
      RAISE EXCEPTION 'inventory.value_out_of_range: the document value is outside the supported range' USING ERRCODE = 'P0001';
    END IF;

    PERFORM inventory_lock_stock_targets(ARRAY[p_warehouse_id], p_variant_ids);

    INSERT INTO inventory_adjustments (tenant_id, business_id, id, kind, warehouse_id, occurred_on, reason, intent_sha256,
                                       total_value_base_minor, binding_source_id, actor_user_id, business_transaction_id)
    VALUES (v_tenant, v_business, p_adjustment_id, 'adjustment', p_warehouse_id, p_occurred_on, p_reason, v_intent,
            v_total::bigint, CASE WHEN v_total <> 0 THEN p_adjustment_id END, v_actor.actor_user_id, v_trace)
    ON CONFLICT (business_id, id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN
      SELECT a.intent_sha256 INTO v_stored FROM inventory_adjustments a WHERE a.business_id = v_business AND a.id = p_adjustment_id;
      IF v_stored IS DISTINCT FROM v_intent THEN
        RAISE EXCEPTION 'inventory.idempotency_conflict: this adjustment id was used for a different document' USING ERRCODE = 'P0001';
      END IF;
      v_replay := true;
    ELSE
      v_line_ids := ARRAY[]::uuid[];
      v_reqs     := ARRAY[]::inventory_movement_request[];
      FOR v_i IN 1 .. v_n LOOP
        v_line_ids := v_line_ids || gen_random_uuid();
        INSERT INTO inventory_adjustment_lines (tenant_id, business_id, adjustment_id, id, line_no, variant_id, qty_delta, unit_cost_base_minor)
        VALUES (v_tenant, v_business, p_adjustment_id, v_line_ids[v_i], v_i, p_variant_ids[v_i], p_qty_deltas[v_i], p_unit_costs[v_i]);
        v_reqs := v_reqs
          || ROW(p_warehouse_id, p_variant_ids[v_i], 'adjustment', 'inventory_adjustment', p_adjustment_id, v_line_ids[v_i],
                 p_qty_deltas[v_i], p_unit_costs[v_i], NULL, p_reason)::inventory_movement_request;
      END LOOP;

      -- A-07: the stored value of every movement is the bound value.
      FOR v_mv IN SELECT r.ordinal, r.value_delta_base_minor AS val FROM inventory_apply_stock_movements(v_reqs) AS r LOOP
        IF v_mv.val IS DISTINCT FROM p_expected_values[v_mv.ordinal] THEN
          RAISE EXCEPTION 'inventory.valuation_changed: the stock value changed since the command was prepared' USING ERRCODE = 'P0001';
        END IF;
      END LOOP;

      IF EXISTS (SELECT 1 FROM product_variants pv JOIN products p ON p.business_id = pv.business_id AND p.id = pv.product_id
                  WHERE pv.business_id = v_business AND pv.id = ANY (p_variant_ids) AND p.status <> 'active') THEN
        RAISE EXCEPTION 'inventory.variant_archived: the variant or its product is archived' USING ERRCODE = 'P0001';
      END IF;

      PERFORM inventory_bridge_source_lines('inventory_adjustment', p_adjustment_id);

      INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
      VALUES (v_tenant, v_business, v_actor.actor_user_id, 'inventory.stock_adjusted', 'inventory_adjustment', p_adjustment_id::text,
              jsonb_build_object('warehouseId', p_warehouse_id, 'occurredOn', p_occurred_on, 'reason', p_reason, 'lineCount', v_n,
                                 'totalValueBaseMinor', v_total::bigint::text,
                                 'assertionJti', v_actor.jti, 'business_transaction_id', v_trace));
      INSERT INTO outbox_events (tenant_id, business_id, type, payload)
      VALUES (v_tenant, v_business, 'inventory.stock_adjusted.v1',
              jsonb_build_object('businessId', v_business, 'documentId', p_adjustment_id, 'businessTransactionId', v_trace));
    END IF;
  END IF;

  RETURN QUERY
  SELECT p_adjustment_id, v_replay, a.total_value_base_minor, l.id, l.variant_id, m.value_delta_base_minor
  FROM inventory_adjustments a
  JOIN inventory_adjustment_lines l ON l.business_id = a.business_id AND l.adjustment_id = a.id
  JOIN stock_source_bridge_inventory_adjustment b
    ON b.business_id = l.business_id AND b.source_id = l.adjustment_id AND b.source_line_id = l.id
  JOIN stock_movements m
    ON m.business_id = b.business_id AND m.source_type = b.source_type AND m.source_id = b.source_id
   AND m.source_line_id = b.source_line_id AND m.movement_kind = b.movement_kind
  WHERE a.business_id = v_business AND a.id = p_adjustment_id
  ORDER BY l.line_no;
END;
$$;

COMMENT ON FUNCTION inventory_adjust_stock(UUID, UUID, DATE, TEXT, UUID[], NUMERIC[], NUMERIC[], BIGINT[]) IS
  'P3-S3 §2.4, A-12. First consumes an invctl/1 assertion of kind inventory.adjust over its own arguments (A-09: id, warehouse, date, reason words, line_count, per line variant, Q4 delta, C10 cost or NULL, expected value). Idempotency by the stored intent (expected values excluded); the id may not name a stocktake (inventory.document_id_conflict). Losses are valued by the primitive at the average, gains at their explicit cost (inventory.unit_cost_required); every stored value must equal the bound one (inventory.valuation_changed). Header binding owed iff the total is non-zero. Audit inventory.stock_adjusted and its outbox row. EXECUTE: daftar_app only — reachability, not authority.';

-- 3.3 Damage (A-12): positive magnitudes written off, never a gain.
CREATE OR REPLACE FUNCTION inventory_record_damage(
  p_adjustment_id   UUID,
  p_warehouse_id    UUID,
  p_occurred_on     DATE,
  p_reason          TEXT,
  p_variant_ids     UUID[],
  p_qtys            NUMERIC[],
  p_expected_values BIGINT[]
) RETURNS TABLE (
  document_id            UUID,
  replayed               BOOLEAN,
  total_value_base_minor BIGINT,
  line_id                UUID,
  variant_id             UUID,
  value_delta_base_minor BIGINT
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
  v_n        INTEGER;
  v_i        INTEGER;
  v_rows     INTEGER;
  v_total    NUMERIC;
  v_line_ids UUID[];
  v_reqs     inventory_movement_request[];
  v_mv       RECORD;
BEGIN
  v_actor := inventory_assertion_consume('inventory.damage', inventory_claimed_payload_digest('inventory.damage',
    ARRAY['uuid', 'uuid', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer']
      || ARRAY(SELECT f.t FROM unnest(p_variant_ids, p_qtys, p_expected_values) WITH ORDINALITY AS l(v, q, e, i)
               CROSS JOIN LATERAL unnest(ARRAY['uuid', 'integer', 'integer']) WITH ORDINALITY AS f(t, j) ORDER BY l.i, f.j),
    ARRAY[p_adjustment_id::text, p_warehouse_id::text, to_char(p_occurred_on, 'YYYYMMDD')]
      || inventory_reason_words(p_reason)
      || ARRAY[coalesce(cardinality(p_variant_ids), 0)::text]
      || ARRAY(SELECT f.x FROM unnest(p_variant_ids, p_qtys, p_expected_values) WITH ORDINALITY AS l(v, q, e, i)
               CROSS JOIN LATERAL unnest(ARRAY[l.v::text, inventory_fixed_text(l.q, 4), l.e::text])
                 WITH ORDINALITY AS f(x, j) ORDER BY l.i, f.j)));
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: stock commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_business := v_actor.business_id;
  v_tenant   := v_actor.tenant_id;
  v_trace    := inventory_business_transaction_id();
  v_replay   := false;
  IF v_trace IS NULL THEN
    RAISE EXCEPTION 'inventory.trace_missing: a stock document records its business transaction id' USING ERRCODE = 'P0001';
  END IF;
  IF p_adjustment_id IS NULL THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a damage record names its id' USING ERRCODE = 'P0001';
  END IF;

  v_intent := inventory_payload_digest('inventory.damage', v_tenant, v_business,
    ARRAY['uuid', 'uuid', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer']
      || ARRAY(SELECT f.t FROM unnest(p_variant_ids, p_qtys) WITH ORDINALITY AS l(v, q, i)
               CROSS JOIN LATERAL unnest(ARRAY['uuid', 'integer']) WITH ORDINALITY AS f(t, j) ORDER BY l.i, f.j),
    ARRAY[p_adjustment_id::text, p_warehouse_id::text, to_char(p_occurred_on, 'YYYYMMDD')]
      || inventory_reason_words(p_reason)
      || ARRAY[coalesce(cardinality(p_variant_ids), 0)::text]
      || ARRAY(SELECT f.x FROM unnest(p_variant_ids, p_qtys) WITH ORDINALITY AS l(v, q, i)
               CROSS JOIN LATERAL unnest(ARRAY[l.v::text, inventory_fixed_text(l.q, 4)]) WITH ORDINALITY AS f(x, j) ORDER BY l.i, f.j));

  PERFORM pg_advisory_xact_lock(hashtext('daftar.inventory_adjustment_id'), hashtext(p_adjustment_id::text));

  SELECT a.intent_sha256 INTO v_stored FROM inventory_adjustments a WHERE a.business_id = v_business AND a.id = p_adjustment_id;
  IF FOUND THEN
    IF v_stored <> v_intent THEN
      RAISE EXCEPTION 'inventory.idempotency_conflict: this adjustment id was used for a different document' USING ERRCODE = 'P0001';
    END IF;
    v_replay := true;
  ELSE
    IF EXISTS (SELECT 1 FROM stocktakes s WHERE s.business_id = v_business AND s.id = p_adjustment_id) THEN
      RAISE EXCEPTION 'inventory.document_id_conflict: this id already names a stocktake' USING ERRCODE = 'P0001';
    END IF;
    v_n := coalesce(cardinality(p_variant_ids), 0);
    IF v_n = 0 THEN
      RAISE EXCEPTION 'inventory.lines_required: a damage record has at least one line' USING ERRCODE = 'P0001';
    END IF;
    IF v_n > 200 OR array_ndims(p_variant_ids) <> 1 OR array_lower(p_variant_ids, 1) <> 1
       OR p_qtys IS NULL OR array_ndims(p_qtys) <> 1 OR array_lower(p_qtys, 1) <> 1 OR cardinality(p_qtys) <> v_n
       OR p_expected_values IS NULL OR array_ndims(p_expected_values) <> 1 OR array_lower(p_expected_values, 1) <> 1
       OR cardinality(p_expected_values) <> v_n
       OR array_position(p_variant_ids, NULL) IS NOT NULL OR array_position(p_qtys, NULL) IS NOT NULL
       OR array_position(p_expected_values, NULL) IS NOT NULL
       OR p_warehouse_id IS NULL OR p_occurred_on IS NULL THEN
      RAISE EXCEPTION 'inventory.payload_invalid: a damage record has a warehouse, a date and 1..200 complete lines' USING ERRCODE = 'P0001';
    END IF;
    IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
      RAISE EXCEPTION 'inventory.reason_required: a damage record states a reason of 1..500 characters' USING ERRCODE = 'P0001';
    END IF;
    IF (SELECT count(DISTINCT x.id) FROM unnest(p_variant_ids) AS x(id)) <> v_n THEN
      RAISE EXCEPTION 'inventory.duplicate_line: a variant appears once per damage record' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(p_qtys) AS q(qty) WHERE q.qty <= 0) THEN
      RAISE EXCEPTION 'inventory.quantity_sign_invalid: a damage line writes off a positive quantity' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(p_qtys) AS q(qty) WHERE q.qty >= 10000000000) THEN
      RAISE EXCEPTION 'inventory.quantity_out_of_range: the quantity is outside the supported range' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(p_expected_values) AS x(val) WHERE x.val > 0) THEN
      RAISE EXCEPTION 'inventory.payload_invalid: a damage line never adds value' USING ERRCODE = 'P0001';
    END IF;
    SELECT sum(x.val) INTO v_total FROM unnest(p_expected_values) AS x(val);
    IF abs(v_total) > 1000000000000000000 THEN
      RAISE EXCEPTION 'inventory.value_out_of_range: the document value is outside the supported range' USING ERRCODE = 'P0001';
    END IF;

    PERFORM inventory_lock_stock_targets(ARRAY[p_warehouse_id], p_variant_ids);

    INSERT INTO inventory_adjustments (tenant_id, business_id, id, kind, warehouse_id, occurred_on, reason, intent_sha256,
                                       total_value_base_minor, binding_source_id, actor_user_id, business_transaction_id)
    VALUES (v_tenant, v_business, p_adjustment_id, 'damage', p_warehouse_id, p_occurred_on, p_reason, v_intent,
            v_total::bigint, CASE WHEN v_total <> 0 THEN p_adjustment_id END, v_actor.actor_user_id, v_trace)
    ON CONFLICT (business_id, id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN
      SELECT a.intent_sha256 INTO v_stored FROM inventory_adjustments a WHERE a.business_id = v_business AND a.id = p_adjustment_id;
      IF v_stored IS DISTINCT FROM v_intent THEN
        RAISE EXCEPTION 'inventory.idempotency_conflict: this adjustment id was used for a different document' USING ERRCODE = 'P0001';
      END IF;
      v_replay := true;
    ELSE
      v_line_ids := ARRAY[]::uuid[];
      v_reqs     := ARRAY[]::inventory_movement_request[];
      FOR v_i IN 1 .. v_n LOOP
        v_line_ids := v_line_ids || gen_random_uuid();
        INSERT INTO inventory_adjustment_lines (tenant_id, business_id, adjustment_id, id, line_no, variant_id, qty_delta, unit_cost_base_minor)
        VALUES (v_tenant, v_business, p_adjustment_id, v_line_ids[v_i], v_i, p_variant_ids[v_i], -p_qtys[v_i], NULL);
        v_reqs := v_reqs
          || ROW(p_warehouse_id, p_variant_ids[v_i], 'damage', 'inventory_adjustment', p_adjustment_id, v_line_ids[v_i],
                 -p_qtys[v_i], NULL, NULL, p_reason)::inventory_movement_request;
      END LOOP;

      FOR v_mv IN SELECT r.ordinal, r.value_delta_base_minor AS val FROM inventory_apply_stock_movements(v_reqs) AS r LOOP
        IF v_mv.val IS DISTINCT FROM p_expected_values[v_mv.ordinal] THEN
          RAISE EXCEPTION 'inventory.valuation_changed: the stock value changed since the command was prepared' USING ERRCODE = 'P0001';
        END IF;
      END LOOP;

      IF EXISTS (SELECT 1 FROM product_variants pv JOIN products p ON p.business_id = pv.business_id AND p.id = pv.product_id
                  WHERE pv.business_id = v_business AND pv.id = ANY (p_variant_ids) AND p.status <> 'active') THEN
        RAISE EXCEPTION 'inventory.variant_archived: the variant or its product is archived' USING ERRCODE = 'P0001';
      END IF;

      PERFORM inventory_bridge_source_lines('inventory_adjustment', p_adjustment_id);

      INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
      VALUES (v_tenant, v_business, v_actor.actor_user_id, 'inventory.stock_damaged', 'inventory_adjustment', p_adjustment_id::text,
              jsonb_build_object('warehouseId', p_warehouse_id, 'occurredOn', p_occurred_on, 'reason', p_reason, 'lineCount', v_n,
                                 'totalValueBaseMinor', v_total::bigint::text,
                                 'assertionJti', v_actor.jti, 'business_transaction_id', v_trace));
      INSERT INTO outbox_events (tenant_id, business_id, type, payload)
      VALUES (v_tenant, v_business, 'inventory.stock_damaged.v1',
              jsonb_build_object('businessId', v_business, 'documentId', p_adjustment_id, 'businessTransactionId', v_trace));
    END IF;
  END IF;

  RETURN QUERY
  SELECT p_adjustment_id, v_replay, a.total_value_base_minor, l.id, l.variant_id, m.value_delta_base_minor
  FROM inventory_adjustments a
  JOIN inventory_adjustment_lines l ON l.business_id = a.business_id AND l.adjustment_id = a.id
  JOIN stock_source_bridge_inventory_adjustment b
    ON b.business_id = l.business_id AND b.source_id = l.adjustment_id AND b.source_line_id = l.id
  JOIN stock_movements m
    ON m.business_id = b.business_id AND m.source_type = b.source_type AND m.source_id = b.source_id
   AND m.source_line_id = b.source_line_id AND m.movement_kind = b.movement_kind
  WHERE a.business_id = v_business AND a.id = p_adjustment_id
  ORDER BY l.line_no;
END;
$$;

COMMENT ON FUNCTION inventory_record_damage(UUID, UUID, DATE, TEXT, UUID[], NUMERIC[], BIGINT[]) IS
  'P3-S3 §2.4, A-12. First consumes an invctl/1 assertion of kind inventory.damage over its own arguments (A-09: id, warehouse, date, reason words, line_count, per line variant, Q4 magnitude, expected value <= 0). Idempotency by the stored intent; the id may not name a stocktake. Writes damage movements of -qty valued by the primitive; every stored value must equal the bound one (inventory.valuation_changed). Audit inventory.stock_damaged and its outbox row. EXECUTE: daftar_app only — reachability, not authority.';

-- 3.4 Stocktake open (A-11): one draft per warehouse.
CREATE OR REPLACE FUNCTION inventory_stocktake_open(p_stocktake_id UUID, p_warehouse_id UUID)
RETURNS TABLE (stocktake_id UUID, replayed BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_actor    inventory_verified_actor;
  v_business UUID;
  v_tenant   UUID;
  v_trace    UUID;
  v_intent   TEXT;
  v_stored   TEXT;
  v_rows     INTEGER;
BEGIN
  v_actor := inventory_assertion_consume('inventory.stocktake_open', inventory_claimed_payload_digest('inventory.stocktake_open',
    ARRAY['uuid', 'uuid'], ARRAY[p_stocktake_id::text, p_warehouse_id::text]));
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: stock commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_business := v_actor.business_id;
  v_tenant   := v_actor.tenant_id;
  v_trace    := inventory_business_transaction_id();
  IF v_trace IS NULL THEN
    RAISE EXCEPTION 'inventory.trace_missing: a stock document records its business transaction id' USING ERRCODE = 'P0001';
  END IF;
  IF p_stocktake_id IS NULL OR p_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a stocktake names its id and its warehouse' USING ERRCODE = 'P0001';
  END IF;
  v_intent := inventory_payload_digest('inventory.stocktake_open', v_tenant, v_business,
    ARRAY['uuid', 'uuid'], ARRAY[p_stocktake_id::text, p_warehouse_id::text]);

  PERFORM pg_advisory_xact_lock(hashtext('daftar.inventory_adjustment_id'), hashtext(p_stocktake_id::text));

  SELECT s.intent_sha256 INTO v_stored FROM stocktakes s WHERE s.business_id = v_business AND s.id = p_stocktake_id;
  IF FOUND THEN
    IF v_stored <> v_intent THEN
      RAISE EXCEPTION 'inventory.idempotency_conflict: this stocktake id was used for a different stocktake' USING ERRCODE = 'P0001';
    END IF;
    stocktake_id := p_stocktake_id;
    replayed     := true;
    RETURN NEXT;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM inventory_adjustments a WHERE a.business_id = v_business AND a.id = p_stocktake_id) THEN
    RAISE EXCEPTION 'inventory.document_id_conflict: this id already names an adjustment' USING ERRCODE = 'P0001';
  END IF;

  PERFORM inventory_lock_stock_targets(ARRAY[p_warehouse_id], NULL::uuid[]);

  -- One draft per warehouse, decided under an exclusive per-warehouse lock
  -- (the partial unique index is the physical backstop).
  PERFORM pg_advisory_xact_lock(hashtext('daftar.stocktake_draft'), hashtext(p_warehouse_id::text));
  IF EXISTS (SELECT 1 FROM stocktakes s WHERE s.business_id = v_business AND s.warehouse_id = p_warehouse_id AND s.status = 'draft') THEN
    RAISE EXCEPTION 'inventory.stocktake_already_open: the warehouse already has a stocktake in progress' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO stocktakes (tenant_id, business_id, id, warehouse_id, status, intent_sha256, opened_by, business_transaction_id)
  VALUES (v_tenant, v_business, p_stocktake_id, p_warehouse_id, 'draft', v_intent, v_actor.actor_user_id, v_trace)
  ON CONFLICT (business_id, id) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    SELECT s.intent_sha256 INTO v_stored FROM stocktakes s WHERE s.business_id = v_business AND s.id = p_stocktake_id;
    IF v_stored IS DISTINCT FROM v_intent THEN
      RAISE EXCEPTION 'inventory.idempotency_conflict: this stocktake id was used for a different stocktake' USING ERRCODE = 'P0001';
    END IF;
    stocktake_id := p_stocktake_id;
    replayed     := true;
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
  VALUES (v_tenant, v_business, v_actor.actor_user_id, 'inventory.stocktake_opened', 'stocktake', p_stocktake_id::text,
          jsonb_build_object('warehouseId', p_warehouse_id, 'assertionJti', v_actor.jti, 'business_transaction_id', v_trace));

  stocktake_id := p_stocktake_id;
  replayed     := false;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION inventory_stocktake_open(UUID, UUID) IS
  'P3-S3 §2.4, A-11. First consumes an invctl/1 assertion of kind inventory.stocktake_open over (stocktake_id, warehouse_id). Idempotency by the stored intent; the id may not name an adjustment (inventory.document_id_conflict); the warehouse exists and is active; at most one draft per warehouse (inventory.stocktake_already_open). Opens the draft and audits inventory.stocktake_opened. EXECUTE: daftar_app only — reachability, not authority.';

-- 3.5 Stocktake count (A-11): capture expected-at-capture with the count.
CREATE OR REPLACE FUNCTION inventory_stocktake_count(
  p_stocktake_id  UUID,
  p_warehouse_id  UUID,
  p_variant_ids   UUID[],
  p_counted_qtys  NUMERIC[]
) RETURNS TABLE (
  line_id                 UUID,
  variant_id              UUID,
  expected_qty_at_capture NUMERIC,
  captured_at_stock_seq   BIGINT,
  counted_qty             NUMERIC,
  variance_qty            NUMERIC,
  changed                 BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_actor    inventory_verified_actor;
  v_business UUID;
  v_tenant   UUID;
  v_trace    UUID;
  v_n        INTEGER;
  v_i        INTEGER;
  v_wh       UUID;
  v_status   TEXT;
  v_dec      SMALLINT;
  v_base     UUID;
  v_line     UUID;
  v_old      NUMERIC;
  v_on_hand  NUMERIC;
  v_seq      BIGINT;
  v_changed  BOOLEAN[];
  v_any      BOOLEAN;
BEGIN
  v_actor := inventory_assertion_consume('inventory.stocktake_count', inventory_claimed_payload_digest('inventory.stocktake_count',
    ARRAY['uuid', 'uuid', 'integer']
      || ARRAY(SELECT f.t FROM unnest(p_variant_ids, p_counted_qtys) WITH ORDINALITY AS l(v, q, i)
               CROSS JOIN LATERAL unnest(ARRAY['uuid', 'integer']) WITH ORDINALITY AS f(t, j) ORDER BY l.i, f.j),
    ARRAY[p_stocktake_id::text, p_warehouse_id::text, coalesce(cardinality(p_variant_ids), 0)::text]
      || ARRAY(SELECT f.x FROM unnest(p_variant_ids, p_counted_qtys) WITH ORDINALITY AS l(v, q, i)
               CROSS JOIN LATERAL unnest(ARRAY[l.v::text, inventory_fixed_text(l.q, 4)]) WITH ORDINALITY AS f(x, j) ORDER BY l.i, f.j)));
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: stock commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_business := v_actor.business_id;
  v_tenant   := v_actor.tenant_id;
  v_trace    := inventory_business_transaction_id();

  v_n := coalesce(cardinality(p_variant_ids), 0);
  IF v_n = 0 THEN
    RAISE EXCEPTION 'inventory.lines_required: a count records at least one line' USING ERRCODE = 'P0001';
  END IF;
  IF p_stocktake_id IS NULL OR p_warehouse_id IS NULL
     OR v_n > 200 OR array_ndims(p_variant_ids) <> 1 OR array_lower(p_variant_ids, 1) <> 1
     OR p_counted_qtys IS NULL OR array_ndims(p_counted_qtys) <> 1 OR array_lower(p_counted_qtys, 1) <> 1
     OR cardinality(p_counted_qtys) <> v_n
     OR array_position(p_variant_ids, NULL) IS NOT NULL OR array_position(p_counted_qtys, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a count names its stocktake and warehouse and has 1..200 complete lines' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(DISTINCT x.id) FROM unnest(p_variant_ids) AS x(id)) <> v_n THEN
    RAISE EXCEPTION 'inventory.duplicate_line: a variant appears once per count' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM generate_series(2, v_n) AS g(k) WHERE p_variant_ids[g.k] <= p_variant_ids[g.k - 1]) THEN
    RAISE EXCEPTION 'inventory.payload_invalid: count lines are in ascending variant order' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_counted_qtys) AS q(qty) WHERE q.qty < 0) THEN
    RAISE EXCEPTION 'inventory.quantity_sign_invalid: a counted quantity is not negative' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_counted_qtys) AS q(qty) WHERE q.qty >= 10000000000) THEN
    RAISE EXCEPTION 'inventory.quantity_out_of_range: the quantity is outside the supported range' USING ERRCODE = 'P0001';
  END IF;

  -- The draft, locked so counts and the closing decision serialize.
  SELECT s.warehouse_id, s.status INTO v_wh, v_status
  FROM stocktakes s WHERE s.business_id = v_business AND s.id = p_stocktake_id
  FOR UPDATE;
  IF NOT FOUND OR v_wh IS DISTINCT FROM p_warehouse_id THEN
    RAISE EXCEPTION 'inventory.stocktake_not_found: no such stocktake in this warehouse' USING ERRCODE = 'P0001';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'inventory.stocktake_state_invalid: a closed stocktake takes no count' USING ERRCODE = 'P0001';
  END IF;

  PERFORM inventory_lock_stock_targets(ARRAY[p_warehouse_id], p_variant_ids);

  FOR v_i IN 1 .. v_n LOOP
    SELECT p.unit_decimals,
           (SELECT b.id FROM product_variants b WHERE b.business_id = pv.business_id AND b.product_id = pv.product_id AND b.is_base)
      INTO v_dec, v_base
    FROM product_variants pv
    JOIN products p ON p.business_id = pv.business_id AND p.id = pv.product_id
    WHERE pv.business_id = v_business AND pv.id = p_variant_ids[v_i];
    IF v_base IS NOT NULL AND v_base <> p_variant_ids[v_i] THEN
      RAISE EXCEPTION 'inventory.variant_not_stock_identity: a product with a base variant holds stock only on its base variant' USING ERRCODE = 'P0001';
    END IF;
    IF v_dec IS NULL OR NOT inventory_quantity_is_representable(p_counted_qtys[v_i], v_dec) THEN
      RAISE EXCEPTION 'inventory.quantity_precision_invalid: the quantity has more decimal places than the product unit allows' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM stocktake_lines l
       WHERE l.business_id = v_business AND l.stocktake_id = p_stocktake_id AND NOT (l.variant_id = ANY (p_variant_ids))) + v_n > 2000 THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a stocktake holds at most 2000 lines' USING ERRCODE = 'P0001';
  END IF;

  v_changed := ARRAY[]::boolean[];
  v_any     := false;
  FOR v_i IN 1 .. v_n LOOP
    SELECT l.id, l.counted_qty INTO v_line, v_old
    FROM stocktake_lines l
    WHERE l.business_id = v_business AND l.stocktake_id = p_stocktake_id AND l.variant_id = p_variant_ids[v_i];
    IF v_line IS NOT NULL AND v_old = p_counted_qtys[v_i] THEN
      v_changed := v_changed || false;
      CONTINUE;
    END IF;
    -- The capture: on-hand and sequence of the key in ONE statement, no lock.
    SELECT l.on_hand, l.last_stock_seq INTO v_on_hand, v_seq
    FROM stock_levels l
    WHERE l.business_id = v_business AND l.warehouse_id = p_warehouse_id AND l.variant_id = p_variant_ids[v_i];
    IF NOT FOUND THEN
      v_on_hand := 0;
      v_seq     := 0;
    END IF;
    IF v_line IS NULL THEN
      INSERT INTO stocktake_lines (tenant_id, business_id, stocktake_id, id, variant_id, expected_qty_at_capture,
                                   captured_at_stock_seq, counted_qty, captured_at)
      VALUES (v_tenant, v_business, p_stocktake_id, gen_random_uuid(), p_variant_ids[v_i], v_on_hand, v_seq, p_counted_qtys[v_i], now());
    ELSE
      UPDATE stocktake_lines l
         SET counted_qty = p_counted_qtys[v_i], expected_qty_at_capture = v_on_hand, captured_at_stock_seq = v_seq, captured_at = now()
       WHERE l.business_id = v_business AND l.stocktake_id = p_stocktake_id AND l.id = v_line;
    END IF;
    v_changed := v_changed || true;
    v_any     := true;
  END LOOP;

  IF v_any THEN
    INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
    VALUES (v_tenant, v_business, v_actor.actor_user_id, 'inventory.stocktake_counted', 'stocktake', p_stocktake_id::text,
            jsonb_build_object('warehouseId', p_warehouse_id, 'lineCount', v_n,
                               'changedCount', (SELECT count(*) FROM unnest(v_changed) AS c(ch) WHERE c.ch),
                               'assertionJti', v_actor.jti, 'business_transaction_id', v_trace));
  END IF;

  RETURN QUERY
  SELECT l.id, l.variant_id, l.expected_qty_at_capture, l.captured_at_stock_seq, l.counted_qty, l.variance_qty, c.ch
  FROM unnest(p_variant_ids, v_changed) WITH ORDINALITY AS c(va, ch, k)
  JOIN stocktake_lines l ON l.business_id = v_business AND l.stocktake_id = p_stocktake_id AND l.variant_id = c.va
  ORDER BY c.k;
END;
$$;

COMMENT ON FUNCTION inventory_stocktake_count(UUID, UUID, UUID[], NUMERIC[]) IS
  'P3-S3 §2.4, A-11. First consumes an invctl/1 assertion of kind inventory.stocktake_count over (stocktake_id, warehouse_id, line_count, per line in ascending variant order: variant, Q4 counted). The stocktake must be a draft of that warehouse; variants active, tracked, the stock identity, and the count representable at the unit precision. Per line an idempotent upsert: the same count leaves the capture untouched (changed = false); otherwise on_hand and last_stock_seq are captured in one statement with the count. At most 2000 lines per stocktake. Audits inventory.stocktake_counted when anything changed. EXECUTE: daftar_app only — reachability, not authority.';

-- 3.6 Stocktake finalize / cancel (A-11): the one closing command.
CREATE OR REPLACE FUNCTION inventory_stocktake_finalize(
  p_stocktake_id    UUID,
  p_warehouse_id    UUID,
  p_outcome         TEXT,
  p_occurred_on     DATE,
  p_variant_ids     UUID[],
  p_variances       NUMERIC[],
  p_unit_costs      NUMERIC[],
  p_expected_values BIGINT[]
) RETURNS TABLE (
  stocktake_id           UUID,
  replayed               BOOLEAN,
  status                 TEXT,
  total_value_base_minor BIGINT,
  line_id                UUID,
  variant_id             UUID,
  value_delta_base_minor BIGINT
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
  v_wh       UUID;
  v_status   TEXT;
  v_n        INTEGER;
  v_i        INTEGER;
  v_k        INTEGER;
  v_total    NUMERIC;
  v_avg      NUMERIC;
  v_seq      BIGINT;
  v_cost     NUMERIC;
  v_explicit BOOLEAN;
  v_line     UUID;
  v_pre_seq  BIGINT[];
  v_expected BIGINT[];
  v_moving   UUID[];
  v_reqs     inventory_movement_request[];
  v_mv       RECORD;
BEGIN
  v_actor := inventory_assertion_consume('inventory.stocktake_finalize', inventory_claimed_payload_digest('inventory.stocktake_finalize',
    ARRAY['uuid', 'uuid', 'code', 'integer', 'integer']
      || ARRAY(SELECT f.t FROM unnest(p_variant_ids, p_variances, p_unit_costs, p_expected_values) WITH ORDINALITY AS l(v, q, c, e, i)
               CROSS JOIN LATERAL unnest(ARRAY['uuid', 'integer', 'integer', 'integer']) WITH ORDINALITY AS f(t, j) ORDER BY l.i, f.j),
    ARRAY[p_stocktake_id::text, p_warehouse_id::text, p_outcome, to_char(p_occurred_on, 'YYYYMMDD'), coalesce(cardinality(p_variant_ids), 0)::text]
      || ARRAY(SELECT f.x FROM unnest(p_variant_ids, p_variances, p_unit_costs, p_expected_values) WITH ORDINALITY AS l(v, q, c, e, i)
               CROSS JOIN LATERAL unnest(ARRAY[l.v::text, inventory_fixed_text(l.q, 4), inventory_fixed_text(l.c, 10), l.e::text])
                 WITH ORDINALITY AS f(x, j) ORDER BY l.i, f.j)));
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: stock commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_business := v_actor.business_id;
  v_tenant   := v_actor.tenant_id;
  v_trace    := inventory_business_transaction_id();
  v_replay   := false;
  IF v_trace IS NULL THEN
    RAISE EXCEPTION 'inventory.trace_missing: a stock document records its business transaction id' USING ERRCODE = 'P0001';
  END IF;
  IF p_stocktake_id IS NULL OR p_warehouse_id IS NULL OR p_outcome IS NULL OR p_outcome NOT IN ('finalized', 'cancelled') THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a stocktake is closed as finalized or cancelled' USING ERRCODE = 'P0001';
  END IF;

  -- The intent omits the server-derived variances and expected values.
  v_intent := inventory_payload_digest('inventory.stocktake_finalize', v_tenant, v_business,
    ARRAY['uuid', 'uuid', 'code', 'integer', 'integer']
      || ARRAY(SELECT f.t FROM unnest(p_variant_ids, p_unit_costs) WITH ORDINALITY AS l(v, c, i)
               CROSS JOIN LATERAL unnest(ARRAY['uuid', 'integer']) WITH ORDINALITY AS f(t, j) ORDER BY l.i, f.j),
    ARRAY[p_stocktake_id::text, p_warehouse_id::text, p_outcome, to_char(p_occurred_on, 'YYYYMMDD'), coalesce(cardinality(p_variant_ids), 0)::text]
      || ARRAY(SELECT f.x FROM unnest(p_variant_ids, p_unit_costs) WITH ORDINALITY AS l(v, c, i)
               CROSS JOIN LATERAL unnest(ARRAY[l.v::text, inventory_fixed_text(l.c, 10)]) WITH ORDINALITY AS f(x, j) ORDER BY l.i, f.j));

  -- The stocktake, locked: its own state is the idempotency record (A-10(g)).
  SELECT s.warehouse_id, s.status, s.finalize_intent_sha256 INTO v_wh, v_status, v_stored
  FROM stocktakes s WHERE s.business_id = v_business AND s.id = p_stocktake_id
  FOR UPDATE;
  IF NOT FOUND OR v_wh IS DISTINCT FROM p_warehouse_id THEN
    RAISE EXCEPTION 'inventory.stocktake_not_found: no such stocktake in this warehouse' USING ERRCODE = 'P0001';
  END IF;

  IF v_status <> 'draft' THEN
    IF v_stored IS DISTINCT FROM v_intent THEN
      RAISE EXCEPTION 'inventory.stocktake_state_invalid: the stocktake was already closed by a different decision' USING ERRCODE = 'P0001';
    END IF;
    v_replay := true;
  ELSIF p_outcome = 'cancelled' THEN
    IF p_occurred_on IS NOT NULL OR coalesce(cardinality(p_variant_ids), 0) <> 0 OR coalesce(cardinality(p_variances), 0) <> 0
       OR coalesce(cardinality(p_unit_costs), 0) <> 0 OR coalesce(cardinality(p_expected_values), 0) <> 0 THEN
      RAISE EXCEPTION 'inventory.payload_invalid: a cancellation carries no date and no line' USING ERRCODE = 'P0001';
    END IF;
    UPDATE stocktakes s
       SET status = 'cancelled', finalize_intent_sha256 = v_intent, cancelled_at = now(), closed_by = v_actor.actor_user_id,
           closed_business_transaction_id = v_trace
     WHERE s.business_id = v_business AND s.id = p_stocktake_id;
    INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
    VALUES (v_tenant, v_business, v_actor.actor_user_id, 'inventory.stocktake_cancelled', 'stocktake', p_stocktake_id::text,
            jsonb_build_object('warehouseId', p_warehouse_id, 'assertionJti', v_actor.jti, 'business_transaction_id', v_trace));
    INSERT INTO outbox_events (tenant_id, business_id, type, payload)
    VALUES (v_tenant, v_business, 'inventory.stocktake_cancelled.v1',
            jsonb_build_object('businessId', v_business, 'documentId', p_stocktake_id, 'businessTransactionId', v_trace));
  ELSE
    v_n := coalesce(cardinality(p_variant_ids), 0);
    IF p_occurred_on IS NULL OR v_n > 2000
       OR (v_n > 0 AND (array_ndims(p_variant_ids) <> 1 OR array_lower(p_variant_ids, 1) <> 1
            OR p_variances IS NULL OR array_ndims(p_variances) <> 1 OR array_lower(p_variances, 1) <> 1 OR cardinality(p_variances) <> v_n
            OR p_unit_costs IS NULL OR array_ndims(p_unit_costs) <> 1 OR array_lower(p_unit_costs, 1) <> 1 OR cardinality(p_unit_costs) <> v_n
            OR p_expected_values IS NULL OR array_ndims(p_expected_values) <> 1 OR array_lower(p_expected_values, 1) <> 1
            OR cardinality(p_expected_values) <> v_n
            OR array_position(p_variant_ids, NULL) IS NOT NULL OR array_position(p_variances, NULL) IS NOT NULL
            OR array_position(p_expected_values, NULL) IS NOT NULL)) THEN
      RAISE EXCEPTION 'inventory.payload_invalid: a finalization carries its date and every line of the stocktake' USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM stocktake_lines l WHERE l.business_id = v_business AND l.stocktake_id = p_stocktake_id) THEN
      RAISE EXCEPTION 'inventory.stocktake_empty: a stocktake with no counted line cannot be finalized' USING ERRCODE = 'P0001';
    END IF;
    -- The bound line set is the stored line set, variants and variances.
    IF (SELECT array_agg(l.variant_id ORDER BY l.variant_id) FROM stocktake_lines l
         WHERE l.business_id = v_business AND l.stocktake_id = p_stocktake_id) IS DISTINCT FROM p_variant_ids
       OR (SELECT array_agg(l.variance_qty ORDER BY l.variant_id) FROM stocktake_lines l
            WHERE l.business_id = v_business AND l.stocktake_id = p_stocktake_id) IS DISTINCT FROM p_variances THEN
      RAISE EXCEPTION 'inventory.stocktake_changed: the counted lines changed since the finalization was prepared' USING ERRCODE = 'P0001';
    END IF;

    PERFORM inventory_lock_stock_targets(ARRAY[p_warehouse_id], p_variant_ids);

    v_total    := 0;
    v_k        := 0;
    v_pre_seq  := ARRAY[]::bigint[];
    v_expected := ARRAY[]::bigint[];
    v_moving   := ARRAY[]::uuid[];
    v_reqs     := ARRAY[]::inventory_movement_request[];
    FOR v_i IN 1 .. v_n LOOP
      IF p_variances[v_i] = 0 THEN
        IF p_unit_costs[v_i] IS NOT NULL OR p_expected_values[v_i] <> 0 THEN
          RAISE EXCEPTION 'inventory.payload_invalid: a line without a variance carries no cost and no value' USING ERRCODE = 'P0001';
        END IF;
        CONTINUE;
      END IF;
      -- R-7: the key as it is now; the primitive must write the very next
      --      sequence, or the state valued here is no longer current.
      SELECT l.avg_unit_cost_base_minor, l.last_stock_seq INTO v_avg, v_seq
      FROM stock_levels l
      WHERE l.business_id = v_business AND l.warehouse_id = p_warehouse_id AND l.variant_id = p_variant_ids[v_i];
      IF NOT FOUND THEN
        v_avg := NULL;
        v_seq := 0;
      END IF;
      v_explicit := false;
      IF p_variances[v_i] < 0 THEN
        IF p_unit_costs[v_i] IS NOT NULL THEN
          RAISE EXCEPTION 'inventory.unit_cost_not_applicable: a stock loss is valued at the current average' USING ERRCODE = 'P0001';
        END IF;
        v_cost := NULL;
      ELSIF v_avg IS NOT NULL THEN
        IF p_unit_costs[v_i] IS NOT NULL THEN
          RAISE EXCEPTION 'inventory.unit_cost_not_applicable: a gain on a key with an average cost is valued at that average' USING ERRCODE = 'P0001';
        END IF;
        v_cost := v_avg;
      ELSE
        IF p_unit_costs[v_i] IS NULL THEN
          RAISE EXCEPTION 'inventory.unit_cost_required: a gain on a key that never held valued stock states its unit cost' USING ERRCODE = 'P0001';
        END IF;
        IF p_unit_costs[v_i] < 0 OR p_unit_costs[v_i] >= 1000000000000000000 THEN
          RAISE EXCEPTION 'inventory.cost_invalid: a unit cost is non-negative and below the limit' USING ERRCODE = 'P0001';
        END IF;
        v_cost     := p_unit_costs[v_i];
        v_explicit := true;
      END IF;

      SELECT l.id INTO v_line FROM stocktake_lines l
      WHERE l.business_id = v_business AND l.stocktake_id = p_stocktake_id AND l.variant_id = p_variant_ids[v_i];
      UPDATE stocktake_lines l
         SET applied_value_base_minor = p_expected_values[v_i],
             unit_cost_base_minor     = CASE WHEN v_explicit THEN v_cost END
       WHERE l.business_id = v_business AND l.stocktake_id = p_stocktake_id AND l.id = v_line;

      v_k        := v_k + 1;
      v_pre_seq  := v_pre_seq || v_seq;
      v_expected := v_expected || p_expected_values[v_i];
      v_moving   := v_moving || p_variant_ids[v_i];
      v_total    := v_total + p_expected_values[v_i];
      v_reqs     := v_reqs
        || ROW(p_warehouse_id, p_variant_ids[v_i], 'stocktake', 'stocktake', p_stocktake_id, v_line,
               p_variances[v_i], v_cost, NULL, NULL)::inventory_movement_request;
    END LOOP;
    IF abs(v_total) > 1000000000000000000 THEN
      RAISE EXCEPTION 'inventory.value_out_of_range: the document value is outside the supported range' USING ERRCODE = 'P0001';
    END IF;

    IF v_k > 0 THEN
      FOR v_mv IN SELECT r.ordinal, r.stock_seq AS seq, r.value_delta_base_minor AS val FROM inventory_apply_stock_movements(v_reqs) AS r LOOP
        IF v_mv.val IS DISTINCT FROM v_expected[v_mv.ordinal] OR v_mv.seq IS DISTINCT FROM v_pre_seq[v_mv.ordinal] + 1 THEN
          RAISE EXCEPTION 'inventory.valuation_changed: the stock value changed since the finalization was prepared' USING ERRCODE = 'P0001';
        END IF;
      END LOOP;
      IF EXISTS (SELECT 1 FROM product_variants pv JOIN products p ON p.business_id = pv.business_id AND p.id = pv.product_id
                  WHERE pv.business_id = v_business AND pv.id = ANY (v_moving) AND p.status <> 'active') THEN
        RAISE EXCEPTION 'inventory.variant_archived: the variant or its product is archived' USING ERRCODE = 'P0001';
      END IF;
      PERFORM inventory_bridge_source_lines('stocktake', p_stocktake_id);
    END IF;

    UPDATE stocktakes s
       SET status = 'finalized', occurred_on = p_occurred_on, total_value_base_minor = v_total::bigint,
           binding_source_id = CASE WHEN v_total <> 0 THEN p_stocktake_id END,
           finalize_intent_sha256 = v_intent, finalized_at = now(), closed_by = v_actor.actor_user_id,
           closed_business_transaction_id = v_trace
     WHERE s.business_id = v_business AND s.id = p_stocktake_id;

    INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
    VALUES (v_tenant, v_business, v_actor.actor_user_id, 'inventory.stocktake_finalized', 'stocktake', p_stocktake_id::text,
            jsonb_build_object('warehouseId', p_warehouse_id, 'occurredOn', p_occurred_on, 'lineCount', v_n, 'movedCount', v_k,
                               'totalValueBaseMinor', v_total::bigint::text,
                               'explicitCostVariantIds', (SELECT coalesce(jsonb_agg(l.variant_id ORDER BY l.variant_id), '[]'::jsonb)
                                                            FROM stocktake_lines l
                                                           WHERE l.business_id = v_business AND l.stocktake_id = p_stocktake_id
                                                             AND l.unit_cost_base_minor IS NOT NULL),
                               'assertionJti', v_actor.jti, 'business_transaction_id', v_trace));
    INSERT INTO outbox_events (tenant_id, business_id, type, payload)
    VALUES (v_tenant, v_business, 'inventory.stocktake_finalized.v1',
            jsonb_build_object('businessId', v_business, 'documentId', p_stocktake_id, 'businessTransactionId', v_trace));
  END IF;

  -- The stored answer: one row per line of a finalized stocktake, one row
  -- without a line for a cancelled one.
  RETURN QUERY
  SELECT s.id, v_replay, s.status, s.total_value_base_minor, l.id, l.variant_id, m.value_delta_base_minor
  FROM stocktakes s
  LEFT JOIN stocktake_lines l ON s.status = 'finalized' AND l.business_id = s.business_id AND l.stocktake_id = s.id
  LEFT JOIN stock_source_bridge_stocktake b
    ON b.business_id = l.business_id AND b.source_id = l.stocktake_id AND b.source_line_id = l.id
  LEFT JOIN stock_movements m
    ON m.business_id = b.business_id AND m.source_type = b.source_type AND m.source_id = b.source_id
   AND m.source_line_id = b.source_line_id AND m.movement_kind = b.movement_kind
  WHERE s.business_id = v_business AND s.id = p_stocktake_id
  ORDER BY l.variant_id;
END;
$$;

COMMENT ON FUNCTION inventory_stocktake_finalize(UUID, UUID, TEXT, DATE, UUID[], NUMERIC[], NUMERIC[], BIGINT[]) IS
  'P3-S3 §2.4, A-11. First consumes an invctl/1 assertion of kind inventory.stocktake_finalize over its own arguments (A-09: id, warehouse, outcome, date or NULL, line_count, per line in variant order: variant, Q4 variance, C10 cost or NULL, expected value). A closed stocktake answers a repeat of its own decision (finalize_intent_sha256) and refuses any other (inventory.stocktake_state_invalid). Cancel closes a draft and changes nothing else. Finalize requires a non-empty draft (inventory.stocktake_empty) whose stored lines equal the bound ones (inventory.stocktake_changed); losses are valued at the average, gains at the average when the key has one (inventory.unit_cost_not_applicable) else at the bound explicit cost (inventory.unit_cost_required); each movement must carry the bound value and the next stock sequence of the key read (inventory.valuation_changed). Audit and outbox inventory.stocktake_finalized / _cancelled. EXECUTE: daftar_app only — reachability, not authority.';

-- 3.7 Opening (A-13): one document across warehouses, Case A or Case B.
CREATE OR REPLACE FUNCTION inventory_record_opening(
  p_opening_id         UUID,
  p_occurred_on        DATE,
  p_opening_balance_id UUID,
  p_position_minor     BIGINT,
  p_warehouse_ids      UUID[],
  p_variant_ids        UUID[],
  p_qtys               NUMERIC[],
  p_unit_costs         NUMERIC[]
) RETURNS TABLE (
  document_id            UUID,
  replayed               BOOLEAN,
  case_kind              TEXT,
  total_value_base_minor BIGINT,
  line_id                UUID,
  warehouse_id           UUID,
  variant_id             UUID,
  value_delta_base_minor BIGINT
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
  v_n        INTEGER;
  v_i        INTEGER;
  v_rows     INTEGER;
  v_ob       UUID;
  v_pos      BIGINT;
  v_weights  NUMERIC[];
  v_total    NUMERIC;
  v_shares   BIGINT[];
  v_split_w  UUID[];
  v_split_v  BIGINT[];
  v_case     TEXT;
  v_line_ids UUID[];
  v_reqs     inventory_movement_request[];
  v_mv       RECORD;
BEGIN
  v_actor := inventory_assertion_consume('inventory.opening', inventory_claimed_payload_digest('inventory.opening',
    ARRAY['uuid', 'integer', 'uuid', 'integer', 'integer']
      || ARRAY(SELECT f.t FROM unnest(p_warehouse_ids, p_variant_ids, p_qtys, p_unit_costs) WITH ORDINALITY AS l(w, v, q, c, i)
               CROSS JOIN LATERAL unnest(ARRAY['uuid', 'uuid', 'integer', 'integer']) WITH ORDINALITY AS f(t, j) ORDER BY l.i, f.j),
    ARRAY[p_opening_id::text, to_char(p_occurred_on, 'YYYYMMDD'), p_opening_balance_id::text, p_position_minor::text,
          coalesce(cardinality(p_variant_ids), 0)::text]
      || ARRAY(SELECT f.x FROM unnest(p_warehouse_ids, p_variant_ids, p_qtys, p_unit_costs) WITH ORDINALITY AS l(w, v, q, c, i)
               CROSS JOIN LATERAL unnest(ARRAY[l.w::text, l.v::text, inventory_fixed_text(l.q, 4), inventory_fixed_text(l.c, 10)])
                 WITH ORDINALITY AS f(x, j) ORDER BY l.i, f.j)));
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: stock commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_business := v_actor.business_id;
  v_tenant   := v_actor.tenant_id;
  v_trace    := inventory_business_transaction_id();
  v_replay   := false;
  IF v_trace IS NULL THEN
    RAISE EXCEPTION 'inventory.trace_missing: a stock document records its business transaction id' USING ERRCODE = 'P0001';
  END IF;
  IF p_opening_id IS NULL THEN
    RAISE EXCEPTION 'inventory.payload_invalid: an opening names its id' USING ERRCODE = 'P0001';
  END IF;

  -- The intent omits the server-derived opening position (A-10(b)).
  v_intent := inventory_payload_digest('inventory.opening', v_tenant, v_business,
    ARRAY['uuid', 'integer', 'integer']
      || ARRAY(SELECT f.t FROM unnest(p_warehouse_ids, p_variant_ids, p_qtys, p_unit_costs) WITH ORDINALITY AS l(w, v, q, c, i)
               CROSS JOIN LATERAL unnest(ARRAY['uuid', 'uuid', 'integer', 'integer']) WITH ORDINALITY AS f(t, j) ORDER BY l.i, f.j),
    ARRAY[p_opening_id::text, to_char(p_occurred_on, 'YYYYMMDD'), coalesce(cardinality(p_variant_ids), 0)::text]
      || ARRAY(SELECT f.x FROM unnest(p_warehouse_ids, p_variant_ids, p_qtys, p_unit_costs) WITH ORDINALITY AS l(w, v, q, c, i)
               CROSS JOIN LATERAL unnest(ARRAY[l.w::text, l.v::text, inventory_fixed_text(l.q, 4), inventory_fixed_text(l.c, 10)])
                 WITH ORDINALITY AS f(x, j) ORDER BY l.i, f.j));

  -- R-14: a concurrent identical opening waits here and then replays; it
  -- never reaches the one-posted-opening check ahead of the first's commit.
  PERFORM pg_advisory_xact_lock(hashtext('daftar.inventory_opening_id'), hashtext(p_opening_id::text));

  SELECT o.intent_sha256 INTO v_stored FROM inventory_openings o WHERE o.business_id = v_business AND o.id = p_opening_id;
  IF FOUND THEN
    IF v_stored <> v_intent THEN
      RAISE EXCEPTION 'inventory.idempotency_conflict: this opening id was used for a different opening' USING ERRCODE = 'P0001';
    END IF;
    v_replay := true;
  ELSE
    v_n := coalesce(cardinality(p_variant_ids), 0);
    IF v_n = 0 THEN
      RAISE EXCEPTION 'inventory.lines_required: an opening has at least one line' USING ERRCODE = 'P0001';
    END IF;
    IF v_n > 200 OR array_ndims(p_variant_ids) <> 1 OR array_lower(p_variant_ids, 1) <> 1
       OR p_warehouse_ids IS NULL OR array_ndims(p_warehouse_ids) <> 1 OR array_lower(p_warehouse_ids, 1) <> 1 OR cardinality(p_warehouse_ids) <> v_n
       OR p_qtys IS NULL OR array_ndims(p_qtys) <> 1 OR array_lower(p_qtys, 1) <> 1 OR cardinality(p_qtys) <> v_n
       OR p_unit_costs IS NULL OR array_ndims(p_unit_costs) <> 1 OR array_lower(p_unit_costs, 1) <> 1 OR cardinality(p_unit_costs) <> v_n
       OR array_position(p_warehouse_ids, NULL) IS NOT NULL OR array_position(p_variant_ids, NULL) IS NOT NULL
       OR array_position(p_qtys, NULL) IS NOT NULL OR array_position(p_unit_costs, NULL) IS NOT NULL
       OR p_occurred_on IS NULL OR ((p_opening_balance_id IS NULL) <> (p_position_minor IS NULL)) THEN
      RAISE EXCEPTION 'inventory.payload_invalid: an opening has a date, a coherent opening position and 1..200 complete lines' USING ERRCODE = 'P0001';
    END IF;
    IF (SELECT count(*) FROM (SELECT DISTINCT l.w, l.v FROM unnest(p_warehouse_ids, p_variant_ids) AS l(w, v)) d) <> v_n THEN
      RAISE EXCEPTION 'inventory.duplicate_line: a warehouse and variant pair appears once per opening' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(p_qtys) AS q(qty) WHERE q.qty <= 0) THEN
      RAISE EXCEPTION 'inventory.quantity_sign_invalid: an opening line holds a positive quantity' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(p_qtys) AS q(qty) WHERE q.qty >= 10000000000) THEN
      RAISE EXCEPTION 'inventory.quantity_out_of_range: the quantity is outside the supported range' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(p_unit_costs) AS c(cost) WHERE c.cost < 0 OR c.cost >= 1000000000000000000) THEN
      RAISE EXCEPTION 'inventory.cost_invalid: a unit cost is non-negative and below the limit' USING ERRCODE = 'P0001';
    END IF;

    -- The case decision, serialized with the opening-balance workflow by
    -- the lock the accounting-owned read takes (R-1).
    SELECT o.opening_balance_id, o.inventory_net_minor INTO v_ob, v_pos FROM accounting_inventory_opening_position(v_business) AS o;
    IF v_ob IS DISTINCT FROM p_opening_balance_id OR v_pos IS DISTINCT FROM p_position_minor THEN
      RAISE EXCEPTION 'inventory.opening_case_changed: the opening position changed since the opening was prepared' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM inventory_openings o WHERE o.business_id = v_business AND o.status = 'posted') THEN
      RAISE EXCEPTION 'inventory.opening_already_posted: the business already has a posted inventory opening' USING ERRCODE = 'P0001';
    END IF;

    PERFORM inventory_lock_stock_targets(p_warehouse_ids, p_variant_ids);

    -- A-13 valuation: exact weights, T = HALF_EVEN(sum), largest remainder.
    v_weights := ARRAY(SELECT l.q * l.c FROM unnest(p_qtys, p_unit_costs) WITH ORDINALITY AS l(q, c, i) ORDER BY l.i);
    v_total   := inventory_half_even((SELECT sum(x.w) FROM unnest(v_weights) AS x(w)), 1, 0);
    IF v_total > 1000000000000000000 THEN
      RAISE EXCEPTION 'inventory.value_out_of_range: the document value is outside the supported range' USING ERRCODE = 'P0001';
    END IF;
    v_shares := inventory_largest_remainder(v_weights, v_total::bigint);
    -- 0061 R-15: the per-warehouse split of T the header carries (ascending
    -- warehouse id; only warehouses whose shares sum to > 0).
    SELECT coalesce(array_agg(w.wh ORDER BY w.wh), ARRAY[]::uuid[]), coalesce(array_agg(w.v ORDER BY w.wh), ARRAY[]::bigint[])
      INTO v_split_w, v_split_v
    FROM (SELECT l.wh, sum(l.share)::bigint AS v FROM unnest(p_warehouse_ids, v_shares) AS l(wh, share)
           GROUP BY l.wh HAVING sum(l.share) > 0) w;
    IF p_opening_balance_id IS NOT NULL THEN
      IF v_total <> p_position_minor THEN
        RAISE EXCEPTION 'inventory.opening_valuation_mismatch: the stock total does not equal the Inventory opening position' USING ERRCODE = 'P0001';
      END IF;
      v_case := 'opening_balance_bound';
    ELSE
      v_case := 'ledger_posting';
    END IF;

    INSERT INTO inventory_openings (tenant_id, business_id, id, status, case_kind, occurred_on, opening_balance_id,
                                    matched_amount_base_minor, total_value_base_minor, split_warehouse_ids, split_values_base_minor,
                                    binding_source_id, intent_sha256, actor_user_id, business_transaction_id)
    VALUES (v_tenant, v_business, p_opening_id, 'posted', v_case, p_occurred_on, p_opening_balance_id,
            CASE WHEN v_case = 'opening_balance_bound' THEN v_total::bigint END, v_total::bigint, v_split_w, v_split_v,
            CASE WHEN v_case = 'ledger_posting' AND v_total > 0 THEN p_opening_id END, v_intent,
            v_actor.actor_user_id, v_trace)
    ON CONFLICT (business_id, id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN
      SELECT o.intent_sha256 INTO v_stored FROM inventory_openings o WHERE o.business_id = v_business AND o.id = p_opening_id;
      IF v_stored IS DISTINCT FROM v_intent THEN
        RAISE EXCEPTION 'inventory.idempotency_conflict: this opening id was used for a different opening' USING ERRCODE = 'P0001';
      END IF;
      v_replay := true;
    ELSE
      v_line_ids := ARRAY[]::uuid[];
      v_reqs     := ARRAY[]::inventory_movement_request[];
      FOR v_i IN 1 .. v_n LOOP
        v_line_ids := v_line_ids || gen_random_uuid();
        INSERT INTO inventory_opening_lines (tenant_id, business_id, opening_id, id, line_no, warehouse_id, variant_id, qty, unit_cost_base_minor)
        VALUES (v_tenant, v_business, p_opening_id, v_line_ids[v_i], v_i, p_warehouse_ids[v_i], p_variant_ids[v_i], p_qtys[v_i], p_unit_costs[v_i]);
        v_reqs := v_reqs
          || ROW(p_warehouse_ids[v_i], p_variant_ids[v_i], 'inventory_opening', 'inventory_opening', p_opening_id, v_line_ids[v_i],
                 p_qtys[v_i], p_unit_costs[v_i], v_shares[v_i], NULL)::inventory_movement_request;
      END LOOP;

      FOR v_mv IN SELECT r.ordinal, r.value_delta_base_minor AS val FROM inventory_apply_stock_movements(v_reqs) AS r LOOP
        IF v_mv.val IS DISTINCT FROM v_shares[v_mv.ordinal] THEN
          RAISE EXCEPTION 'inventory.valuation_changed: an opening movement does not carry its allocated share' USING ERRCODE = 'P0001';
        END IF;
      END LOOP;

      IF EXISTS (SELECT 1 FROM product_variants pv JOIN products p ON p.business_id = pv.business_id AND p.id = pv.product_id
                  WHERE pv.business_id = v_business AND pv.id = ANY (p_variant_ids) AND p.status <> 'active') THEN
        RAISE EXCEPTION 'inventory.variant_archived: the variant or its product is archived' USING ERRCODE = 'P0001';
      END IF;

      PERFORM inventory_bridge_source_lines('inventory_opening', p_opening_id);

      INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
      VALUES (v_tenant, v_business, v_actor.actor_user_id, 'inventory.opening_posted', 'inventory_opening', p_opening_id::text,
              jsonb_build_object('case', v_case, 'occurredOn', p_occurred_on, 'openingBalanceId', p_opening_balance_id,
                                 'matchedAmountMinor', CASE WHEN v_case = 'opening_balance_bound' THEN v_total::bigint::text END,
                                 'totalValueBaseMinor', v_total::bigint::text, 'lineCount', v_n,
                                 'assertionJti', v_actor.jti, 'business_transaction_id', v_trace));
      INSERT INTO outbox_events (tenant_id, business_id, type, payload)
      VALUES (v_tenant, v_business, 'inventory.opening_posted.v1',
              jsonb_build_object('businessId', v_business, 'documentId', p_opening_id, 'businessTransactionId', v_trace));
    END IF;
  END IF;

  RETURN QUERY
  SELECT p_opening_id, v_replay, o.case_kind, o.total_value_base_minor, l.id, l.warehouse_id, l.variant_id, m.value_delta_base_minor
  FROM inventory_openings o
  JOIN inventory_opening_lines l ON l.business_id = o.business_id AND l.opening_id = o.id
  JOIN stock_source_bridge_inventory_opening b
    ON b.business_id = l.business_id AND b.source_id = l.opening_id AND b.source_line_id = l.id
  JOIN stock_movements m
    ON m.business_id = b.business_id AND m.source_type = b.source_type AND m.source_id = b.source_id
   AND m.source_line_id = b.source_line_id AND m.movement_kind = b.movement_kind
  WHERE o.business_id = v_business AND o.id = p_opening_id
  ORDER BY l.line_no;
END;
$$;

COMMENT ON FUNCTION inventory_record_opening(UUID, DATE, UUID, BIGINT, UUID[], UUID[], NUMERIC[], NUMERIC[]) IS
  'P3-S3 §2.4, A-13. First consumes an invctl/1 assertion of kind inventory.opening over its own arguments (A-09: id, date, opening_balance_id and position or both NULL, line_count, per line warehouse, variant, Q4 quantity, C10 cost). Idempotency by the stored intent (position excluded), serialized on the opening id before the proof so a concurrent identical call replays (R-14). The bound case must equal accounting_inventory_opening_position (inventory.opening_case_changed); one posted opening per business (inventory.opening_already_posted). T = HALF_EVEN(sum qty x cost), shares by largest remainder; Case B requires T = the position (inventory.opening_valuation_mismatch) and owes no entry, Case A owes one iff T > 0. Audit and outbox inventory.opening_posted. EXECUTE: daftar_app only — reachability, not authority.';

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Privileges, then the ownership transfer.
-- ─────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION inventory_fixed_text(NUMERIC, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION inventory_reason_words(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION inventory_lock_stock_targets(UUID[], UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION inventory_bridge_source_lines(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION inventory_transfer_stock(UUID, UUID, UUID, UUID[], NUMERIC[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION inventory_adjust_stock(UUID, UUID, DATE, TEXT, UUID[], NUMERIC[], NUMERIC[], BIGINT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION inventory_record_damage(UUID, UUID, DATE, TEXT, UUID[], NUMERIC[], BIGINT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION inventory_stocktake_open(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION inventory_stocktake_count(UUID, UUID, UUID[], NUMERIC[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION inventory_stocktake_finalize(UUID, UUID, TEXT, DATE, UUID[], NUMERIC[], NUMERIC[], BIGINT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION inventory_record_opening(UUID, DATE, UUID, BIGINT, UUID[], UUID[], NUMERIC[], NUMERIC[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION inventory_transfer_stock(UUID, UUID, UUID, UUID[], NUMERIC[]) TO daftar_app;
GRANT EXECUTE ON FUNCTION inventory_adjust_stock(UUID, UUID, DATE, TEXT, UUID[], NUMERIC[], NUMERIC[], BIGINT[]) TO daftar_app;
GRANT EXECUTE ON FUNCTION inventory_record_damage(UUID, UUID, DATE, TEXT, UUID[], NUMERIC[], BIGINT[]) TO daftar_app;
GRANT EXECUTE ON FUNCTION inventory_stocktake_open(UUID, UUID) TO daftar_app;
GRANT EXECUTE ON FUNCTION inventory_stocktake_count(UUID, UUID, UUID[], NUMERIC[]) TO daftar_app;
GRANT EXECUTE ON FUNCTION inventory_stocktake_finalize(UUID, UUID, TEXT, DATE, UUID[], NUMERIC[], NUMERIC[], BIGINT[]) TO daftar_app;
GRANT EXECUTE ON FUNCTION inventory_record_opening(UUID, DATE, UUID, BIGINT, UUID[], UUID[], NUMERIC[], NUMERIC[]) TO daftar_app;

GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;

ALTER FUNCTION inventory_fixed_text(NUMERIC, INTEGER) OWNER TO daftar_inventory_internal;
ALTER FUNCTION inventory_reason_words(TEXT) OWNER TO daftar_inventory_internal;
ALTER FUNCTION inventory_lock_stock_targets(UUID[], UUID[]) OWNER TO daftar_inventory_internal;
ALTER FUNCTION inventory_bridge_source_lines(TEXT, UUID) OWNER TO daftar_inventory_internal;
ALTER FUNCTION inventory_transfer_stock(UUID, UUID, UUID, UUID[], NUMERIC[]) OWNER TO daftar_inventory_internal;
ALTER FUNCTION inventory_adjust_stock(UUID, UUID, DATE, TEXT, UUID[], NUMERIC[], NUMERIC[], BIGINT[]) OWNER TO daftar_inventory_internal;
ALTER FUNCTION inventory_record_damage(UUID, UUID, DATE, TEXT, UUID[], NUMERIC[], BIGINT[]) OWNER TO daftar_inventory_internal;
ALTER FUNCTION inventory_stocktake_open(UUID, UUID) OWNER TO daftar_inventory_internal;
ALTER FUNCTION inventory_stocktake_count(UUID, UUID, UUID[], NUMERIC[]) OWNER TO daftar_inventory_internal;
ALTER FUNCTION inventory_stocktake_finalize(UUID, UUID, TEXT, DATE, UUID[], NUMERIC[], NUMERIC[], BIGINT[]) OWNER TO daftar_inventory_internal;
ALTER FUNCTION inventory_record_opening(UUID, DATE, UUID, BIGINT, UUID[], UUID[], NUMERIC[], NUMERIC[]) OWNER TO daftar_inventory_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Registrations (§2.5): the seven kinds and the six op→movement pairs
--    (R-8). Last, so no kind names a routine that does not exist yet.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO inventory_operation_kinds (op_code, registered_by) VALUES
  ('inventory.transfer', 'P3-S3'), ('inventory.adjust', 'P3-S3'), ('inventory.damage', 'P3-S3'),
  ('inventory.stocktake_open', 'P3-S3'), ('inventory.stocktake_count', 'P3-S3'),
  ('inventory.stocktake_finalize', 'P3-S3'), ('inventory.opening', 'P3-S3');
INSERT INTO inventory_operation_movement_kinds (op_code, movement_kind, registered_by) VALUES
  ('inventory.transfer', 'transfer_out', 'P3-S3'), ('inventory.transfer', 'transfer_in', 'P3-S3'),
  ('inventory.adjust', 'adjustment', 'P3-S3'), ('inventory.damage', 'damage', 'P3-S3'),
  ('inventory.stocktake_finalize', 'stocktake', 'P3-S3'), ('inventory.opening', 'inventory_opening', 'P3-S3');

-- ─────────────────────────────────────────────────────────────────────────
-- 6. Refuse to commit unless the end state is exactly right (0062-E, §2.9).
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_role    TEXT;
  v_proc    REGPROCEDURE;
  v_detail  TEXT;
  v_first   TEXT;
  v_src     TEXT;
  c_runtime CONSTANT TEXT[] := ARRAY['daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver',
                                     'daftar_provisioner', 'daftar_reconciler', 'public'];
  c_entry   CONSTANT REGPROCEDURE[] := ARRAY[
    'inventory_transfer_stock(uuid,uuid,uuid,uuid[],numeric[])'::regprocedure,
    'inventory_adjust_stock(uuid,uuid,date,text,uuid[],numeric[],numeric[],bigint[])'::regprocedure,
    'inventory_record_damage(uuid,uuid,date,text,uuid[],numeric[],bigint[])'::regprocedure,
    'inventory_stocktake_open(uuid,uuid)'::regprocedure,
    'inventory_stocktake_count(uuid,uuid,uuid[],numeric[])'::regprocedure,
    'inventory_stocktake_finalize(uuid,uuid,text,date,uuid[],numeric[],numeric[],bigint[])'::regprocedure,
    'inventory_record_opening(uuid,date,uuid,bigint,uuid[],uuid[],numeric[],numeric[])'::regprocedure];
  c_helpers CONSTANT REGPROCEDURE[] := ARRAY[
    'inventory_fixed_text(numeric,integer)'::regprocedure,
    'inventory_reason_words(text)'::regprocedure,
    'inventory_lock_stock_targets(uuid[],uuid[])'::regprocedure,
    'inventory_bridge_source_lines(text,uuid)'::regprocedure,
    'inventory_largest_remainder(numeric[],bigint)'::regprocedure];
BEGIN
  -- (1) The operation registry: the three S1 kinds and exactly the seven S3.
  SELECT string_agg(k.op_code || ':' || k.registered_by, ', ' ORDER BY k.op_code) INTO v_detail FROM inventory_operation_kinds k;
  IF v_detail IS DISTINCT FROM
     'inventory.adjust:P3-S3, inventory.configure_product:P3-S1, inventory.damage:P3-S3, inventory.opening:P3-S3, '
     'inventory.stocktake_count:P3-S3, inventory.stocktake_finalize:P3-S3, inventory.stocktake_open:P3-S3, inventory.transfer:P3-S3, '
     'structure.associate_warehouse_branch:P3-S1, structure.dissociate_warehouse_branch:P3-S1' THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: inventory_operation_kinds is not the S1 three plus the S3 seven, found %', v_detail;
  END IF;

  -- (2) Exactly the six §2.5 pairs; least authority is a catalogue fact.
  SELECT string_agg(m.op_code || '>' || m.movement_kind || ':' || m.registered_by, ', ' ORDER BY m.op_code, m.movement_kind) INTO v_detail
  FROM inventory_operation_movement_kinds m;
  IF v_detail IS DISTINCT FROM
     'inventory.adjust>adjustment:P3-S3, inventory.damage>damage:P3-S3, inventory.opening>inventory_opening:P3-S3, '
     'inventory.stocktake_finalize>stocktake:P3-S3, inventory.transfer>transfer_in:P3-S3, inventory.transfer>transfer_out:P3-S3' THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: inventory_operation_movement_kinds is not exactly the S3 mappings, found %', v_detail;
  END IF;
  IF EXISTS (SELECT 1 FROM inventory_operation_movement_kinds m WHERE m.op_code = 'inventory.adjust' AND m.movement_kind = 'transfer_in') THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: inventory.adjust may write transfer_in';
  END IF;

  -- (3) The seven routines: internal-owned DEFINER with the pinned path,
  --     reachable by daftar_app and by no other runtime role or PUBLIC.
  --     (4) The helpers: the same shape, no grantee at all.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_detail
  FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
  WHERE p.oid = ANY (c_entry || c_helpers)
    AND (r.rolname <> 'daftar_inventory_internal' OR NOT p.prosecdef
         OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']);
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: routine(s) not internal-owned SECURITY DEFINER with the pinned path: %', v_detail;
  END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.oid = ANY (c_entry || c_helpers)) <> 12 THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: an S3 routine is missing';
  END IF;
  FOREACH v_proc IN ARRAY c_entry LOOP
    IF NOT has_function_privilege('daftar_app', v_proc, 'EXECUTE') THEN
      RAISE EXCEPTION 'inventory.migration_end_state_invalid: daftar_app cannot reach %', v_proc;
    END IF;
    FOREACH v_role IN ARRAY c_runtime LOOP
      IF has_function_privilege(v_role, v_proc, 'EXECUTE') THEN
        RAISE EXCEPTION 'inventory.migration_end_state_invalid: % may call %', v_role, v_proc;
      END IF;
    END LOOP;
  END LOOP;
  FOREACH v_proc IN ARRAY c_helpers LOOP
    FOREACH v_role IN ARRAY c_runtime || ARRAY['daftar_app', 'daftar_accounting_internal'] LOOP
      IF has_function_privilege(v_role, v_proc, 'EXECUTE') THEN
        RAISE EXCEPTION 'inventory.migration_end_state_invalid: % may call the helper %', v_role, v_proc;
      END IF;
    END LOOP;
  END LOOP;

  -- (5) The first statement of every entry routine consumes the assertion,
  --     and the two stock-writing helpers open with the re-verification
  --     (rule 22 at deploy time).
  FOREACH v_proc IN ARRAY c_entry LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_proc;
    v_first := btrim(split_part(substr(v_src, position(E'\nBEGIN\n' IN v_src) + 7), ';', 1));
    IF position(E'\nBEGIN\n' IN v_src) = 0 OR v_first !~ '^v_actor := inventory_assertion_consume\(' THEN
      RAISE EXCEPTION 'inventory.migration_end_state_invalid: % does not consume its assertion as its first statement', v_proc;
    END IF;
  END LOOP;
  -- (5b) R-14: the opening serializes on its document id before its
  --      idempotency proof, and before the R-1 key its position read takes.
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = 'inventory_record_opening(uuid,date,uuid,bigint,uuid[],uuid[],numeric[],numeric[])'::regprocedure;
  IF position('pg_advisory_xact_lock(hashtext(''daftar.inventory_opening_id''), hashtext(p_opening_id::text))' IN v_src) = 0
     OR position('pg_advisory_xact_lock(hashtext(''daftar.inventory_opening_id'')' IN v_src) > position('SELECT o.intent_sha256 INTO v_stored' IN v_src)
     OR position('SELECT o.intent_sha256 INTO v_stored' IN v_src) > position('accounting_inventory_opening_position(v_business)' IN v_src) THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: inventory_record_opening does not take its document key before its idempotency proof (R-14)';
  END IF;
  FOREACH v_proc IN ARRAY ARRAY['inventory_lock_stock_targets(uuid[],uuid[])'::regprocedure, 'inventory_bridge_source_lines(text,uuid)'::regprocedure] LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_proc;
    v_first := btrim(split_part(substr(v_src, position(E'\nBEGIN\n' IN v_src) + 7), ';', 1));
    IF position(E'\nBEGIN\n' IN v_src) = 0 OR v_first !~ '^v_actor := inventory_assertion_current\(ARRAY\[' THEN
      RAISE EXCEPTION 'inventory.migration_end_state_invalid: % does not re-verify the assertion as its first statement', v_proc;
    END IF;
  END LOOP;

  -- (6) No CREATE left on public for either internal principal.
  IF has_schema_privilege('daftar_inventory_internal', 'public', 'CREATE')
     OR has_schema_privilege('daftar_accounting_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: an internal principal still holds CREATE on schema public';
  END IF;

  -- The 0061 source side still holds.
  IF (SELECT count(*) FROM inventory_stock_source_guard_gaps()) <> 0 THEN
    RAISE EXCEPTION 'inventory.source_guard_missing: a registered stock source type lacks a guard';
  END IF;
  IF (SELECT string_agg(t.source_type, ',' ORDER BY t.source_type) FROM stock_source_types t)
     IS DISTINCT FROM 'inventory_adjustment,inventory_opening,inventory_transfer,stocktake' THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: stock_source_types changed after 0061';
  END IF;
END $$;
