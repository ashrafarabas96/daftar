-- 0060_inventory_stock_primitive.sql
-- P3-S2, part 2 — the TRUSTED routines of the stock ledger: exact HALF_EVEN
-- arithmetic, the precision test, the one batch stock-movement primitive,
-- the deficit sequencer, the rebuild algorithm and its verification mode,
-- the unit-history and variant stock-identity locks, the zero-stock-zero-value
-- COMMIT check, and the P3-AL-41 disable rule inside
-- `inventory_configure_product`. Every stock-relevant routine refuses to run
-- outside READ COMMITTED (`inventory.isolation_unsupported`): the lock
-- protocol relies on each statement taking a fresh snapshot
-- (P3-AL-06, P3-AL-07, P3-AL-08, P3-AL-14, P3-AL-41, P3-AL-49, P3-AL-54 §G;
-- docs/PHASE_3_S2_CONTRACT.md §2.1, §2.4, §2.5, §2.7, A-13, A-15, A-22, A-23).
--
-- ── Who can reach what ───────────────────────────────────────────────────
--
-- Every routine here is SECURITY DEFINER, owned by `daftar_inventory_internal`,
-- pins `pg_catalog, public, pg_temp`, and has NO EXECUTE grant to anyone: it is
-- reachable only from routines the same principal owns. The primitive's
-- FIRST statement re-verifies the transaction's invctl/1 assertion without
-- consuming it (`inventory_assertion_current`, 0054) against the operations
-- the op→kind registry maps, and every movement kind it writes must be
-- mapped to the VERIFIED operation (L:1992). The registry is empty after
-- this migration, so no operation can write a movement until the slice that
-- owns one registers it.
--
-- ── Arithmetic ───────────────────────────────────────────────────────────
--
-- Values are BIGINT base minor units, averages and snapshots NUMERIC at 10
-- decimal places, quantities NUMERIC(18,4). Every rounding is HALF_EVEN by
-- integer division and remainder (`inventory_half_even`) — never a built-in
-- rounding function and never `/`. A value is never derived from the
-- product of the current quantity and the current average: an outbound
-- movement values ITS OWN quantity at the average, and a full depletion
-- flushes exactly the stored valuation (P3-AL-49 §C).
--
-- ── Order of this file (contract §2.1) ──────────────────────────────────
--
--   1. GRANT CREATE ON SCHEMA public TO the internal principal
--   2. the request type
--   3. the nine routines (R1-R8 of §2.5, and R9, the H-1 variant lock)
--   4. REVOKE ALL … FROM PUBLIC while the migrator owns them
--   5. the three triggers
--   6. the ownership transfer
--   7. the owner replaces inventory_configure_product (SET LOCAL ROLE)
--   8. REVOKE CREATE
--   9. the end-state assertion
--
-- Migrations 0000-0058 are FROZEN and untouched.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The ownership-transfer authority, taken and returned inside this file.
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The request type (§2.5).
--
-- Unconstrained NUMERIC on purpose: a typmod on a request field would round
-- a caller's quantity or cost silently on the way in. The primitive proves
-- representability itself and refuses what does not fit.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TYPE inventory_movement_request AS (
  warehouse_id           UUID,
  variant_id             UUID,
  movement_kind          TEXT,
  source_type            TEXT,
  source_id              UUID,
  source_line_id         UUID,
  qty_delta              NUMERIC,
  unit_cost_base_minor   NUMERIC,
  value_delta_base_minor BIGINT,
  reason                 TEXT
);

COMMENT ON TYPE inventory_movement_request IS
  'P3-S2 §2.5. One requested stock movement for inventory_apply_stock_movements. Fields are unconstrained NUMERIC so no typmod coercion can round silently.';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. The routines (§2.5).
-- ─────────────────────────────────────────────────────────────────────────

-- R1. Exact HALF_EVEN of p_numerator / p_denominator at scale 0 or 10
--     (the 0043 algorithm, made sign-symmetric).
CREATE OR REPLACE FUNCTION inventory_half_even(p_numerator NUMERIC, p_denominator NUMERIC, p_scale INTEGER) RETURNS NUMERIC
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_neg BOOLEAN;
  v_n   NUMERIC;
  v_d   NUMERIC;
  v_q   NUMERIC;
  v_r   NUMERIC;
BEGIN
  IF p_numerator IS NULL OR p_denominator IS NULL OR p_scale IS NULL
     OR p_denominator = 0 OR p_scale NOT IN (0, 10) THEN
    RAISE EXCEPTION 'inventory.arithmetic_invalid: HALF_EVEN needs a numerator, a non-zero denominator and a scale of 0 or 10' USING ERRCODE = 'P0001';
  END IF;
  v_neg := (p_numerator < 0) <> (p_denominator < 0);
  v_n   := abs(p_numerator) * (CASE WHEN p_scale = 10 THEN 10000000000::numeric ELSE 1::numeric END);
  v_d   := abs(p_denominator);
  v_q   := div(v_n, v_d);
  v_r   := v_n - v_q * v_d;
  IF 2::numeric * v_r > v_d OR (2::numeric * v_r = v_d AND mod(v_q, 2::numeric) <> 0) THEN
    v_q := v_q + 1;
  END IF;
  IF v_neg THEN
    v_q := -v_q;
  END IF;
  IF p_scale = 10 THEN
    RETURN v_q * 0.0000000001;
  END IF;
  RETURN v_q;
END;
$$;

COMMENT ON FUNCTION inventory_half_even(NUMERIC, NUMERIC, INTEGER) IS
  'P3-AL-49. Exact, sign-symmetric HALF_EVEN of p_numerator / p_denominator at scale 0 or 10, by integer division and remainder. inventory.arithmetic_invalid on a NULL argument, a zero denominator or another scale. No EXECUTE grant.';

-- R2. Is a quantity exactly representable at the product's unit precision.
CREATE OR REPLACE FUNCTION inventory_quantity_is_representable(p_qty NUMERIC, p_unit_decimals SMALLINT) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_qty IS NULL OR p_unit_decimals IS NULL OR p_unit_decimals < 0 OR p_unit_decimals > 4 THEN
    RAISE EXCEPTION 'inventory.arithmetic_invalid: a precision test needs a quantity and a unit precision between 0 and 4' USING ERRCODE = 'P0001';
  END IF;
  RETURN abs(p_qty) = trunc(abs(p_qty), p_unit_decimals::integer);
END;
$$;

COMMENT ON FUNCTION inventory_quantity_is_representable(NUMERIC, SMALLINT) IS
  'P3-AL-49 (L:271). True when abs(p_qty) = trunc(abs(p_qty), p_unit_decimals): the quantity carries no digit beyond the unit precision. inventory.arithmetic_invalid on NULL or a precision outside 0..4. No EXECUTE grant.';

-- R3. THE primitive: the only writer of stock_movements, stock_levels and
--     stock_source_bindings.
CREATE OR REPLACE FUNCTION inventory_apply_stock_movements(p_requests inventory_movement_request[])
RETURNS TABLE (
  ordinal                  INTEGER,
  movement_id              UUID,
  warehouse_id             UUID,
  variant_id               UUID,
  stock_seq                BIGINT,
  movement_kind            TEXT,
  qty_delta                NUMERIC,
  unit_cost_base_minor     NUMERIC,
  value_delta_base_minor   BIGINT,
  on_hand                  NUMERIC,
  valuation_base_minor     BIGINT,
  avg_unit_cost_base_minor NUMERIC
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  c_value_limit   CONSTANT NUMERIC := 1000000000000000000;
  -- |qty| and |on_hand| < 10^10 (A-26 as amended, M-3): the average is exact
  -- to 0.5e-10 per unit, so below 10^10 units a partial outbound valued at
  -- the average can never take more than the key holds.
  c_qty_limit     CONSTANT NUMERIC := 10000000000;
  v_actor         inventory_verified_actor;
  v_business      UUID;
  v_tenant        UUID;
  v_lo            INTEGER;
  v_n             INTEGER;
  v_i             INTEGER;
  v_req           inventory_movement_request;
  v_products      UUID[] := ARRAY[]::uuid[];
  v_decimals      SMALLINT[] := ARRAY[]::smallint[];
  v_product       UUID;
  v_base          UUID;
  v_prod          RECORD;
  v_key           RECORD;
  v_pair          RECORD;
  v_sign          TEXT;
  v_needs_reason  BOOLEAN;
  v_qty           NUMERIC;
  v_level_qty     NUMERIC;
  v_level_value   NUMERIC;
  v_level_avg     NUMERIC;
  v_level_seq     BIGINT;
  v_snapshot      NUMERIC;
  v_value         NUMERIC;
  v_next_qty      NUMERIC;
  v_next_value    NUMERIC;
  v_next_avg      NUMERIC;
  v_seq           BIGINT;
  v_id            UUID;
  v_rows          BIGINT;
BEGIN
  v_actor := inventory_assertion_current(ARRAY(SELECT DISTINCT m.op_code FROM inventory_operation_movement_kinds m ORDER BY 1));
  -- The lock protocol (A-23) relies on a fresh snapshot per statement (M-1).
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: stock commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_business := v_actor.business_id;
  v_tenant   := v_actor.tenant_id;

  -- 1. Shape. Every identifying field and the quantity are required; a
  --    reason, when given, is 1..500 characters of content.
  IF p_requests IS NULL OR cardinality(p_requests) < 1 OR array_ndims(p_requests) <> 1 THEN
    RAISE EXCEPTION 'inventory.movement_request_invalid: a stock command carries at least one movement request' USING ERRCODE = 'P0001';
  END IF;
  v_lo := array_lower(p_requests, 1);
  v_n  := cardinality(p_requests);
  FOR v_i IN 1 .. v_n LOOP
    v_req := p_requests[v_lo + v_i - 1];
    IF v_req.warehouse_id IS NULL OR v_req.variant_id IS NULL OR v_req.movement_kind IS NULL
       OR v_req.source_type IS NULL OR v_req.source_id IS NULL OR v_req.source_line_id IS NULL
       OR v_req.qty_delta IS NULL
       OR (v_req.reason IS NOT NULL AND char_length(btrim(v_req.reason)) NOT BETWEEN 1 AND 500) THEN
      RAISE EXCEPTION 'inventory.movement_request_invalid: a movement request names its warehouse, variant, kind, source and quantity' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- 2 and 3. Kind and scope. The kind must be registered and mapped to the
  --    VERIFIED operation; the warehouse and the variant must belong to the
  --    VERIFIED business. No GUC is read for identity.
  FOR v_i IN 1 .. v_n LOOP
    v_req := p_requests[v_lo + v_i - 1];
    IF NOT EXISTS (SELECT 1 FROM stock_movement_kinds k WHERE k.movement_kind = v_req.movement_kind) THEN
      RAISE EXCEPTION 'inventory.movement_kind_unknown: the movement kind is not registered' USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM inventory_operation_movement_kinds m
                    WHERE m.op_code = v_actor.op_code AND m.movement_kind = v_req.movement_kind) THEN
      RAISE EXCEPTION 'inventory.movement_kind_not_authorized: the verified operation may not write this movement kind' USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM warehouses w WHERE w.business_id = v_business AND w.id = v_req.warehouse_id) THEN
      RAISE EXCEPTION 'inventory.warehouse_not_found: the warehouse does not exist in this business' USING ERRCODE = 'P0001';
    END IF;
    SELECT pv.product_id INTO v_product
    FROM product_variants pv
    WHERE pv.business_id = v_business AND pv.id = v_req.variant_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'inventory.variant_not_found: the variant does not exist in this business' USING ERRCODE = 'P0001';
    END IF;
    v_products[v_i] := v_product;
    v_decimals[v_i] := NULL;
  END LOOP;

  -- 4. Products, locked FOR SHARE in id order BEFORE any stock key (A-23):
  --    a configuration change of the same product holds a conflicting lock,
  --    so tracking, unit and precision cannot change under this command.
  FOR v_prod IN
    SELECT p.id, p.track_inventory, p.unit_decimals
    FROM products p
    WHERE p.business_id = v_business AND p.id = ANY (v_products)
    ORDER BY p.id
    FOR SHARE
  LOOP
    IF NOT v_prod.track_inventory THEN
      RAISE EXCEPTION 'inventory.product_not_tracked: the product does not track inventory' USING ERRCODE = 'P0001';
    END IF;
    SELECT pv.id INTO v_base
    FROM product_variants pv
    WHERE pv.business_id = v_business AND pv.product_id = v_prod.id AND pv.is_base;
    FOR v_i IN 1 .. v_n LOOP
      IF v_products[v_i] = v_prod.id THEN
        v_req := p_requests[v_lo + v_i - 1];
        IF v_base IS NOT NULL AND v_req.variant_id <> v_base THEN
          RAISE EXCEPTION 'inventory.variant_not_stock_identity: a product with a base variant holds stock only on its base variant' USING ERRCODE = 'P0001';
        END IF;
        IF NOT inventory_quantity_is_representable(v_req.qty_delta, v_prod.unit_decimals) THEN
          RAISE EXCEPTION 'inventory.quantity_precision_invalid: the quantity has more decimal places than the product unit allows' USING ERRCODE = 'P0001';
        END IF;
        IF abs(v_req.qty_delta) >= c_qty_limit THEN
          RAISE EXCEPTION 'inventory.quantity_out_of_range: the quantity is outside the supported range' USING ERRCODE = 'P0001';
        END IF;
        v_decimals[v_i] := v_prod.unit_decimals;
      END IF;
    END LOOP;
  END LOOP;
  FOR v_i IN 1 .. v_n LOOP
    IF v_decimals[v_i] IS NULL THEN
      RAISE EXCEPTION 'inventory.variant_not_found: the variant''s product does not exist in this business' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- 4b. The variant→product mapping, re-read now that the products are
  --     locked (H-1). A reparent takes FOR UPDATE on the variant's current
  --     product (product_variants_20_stock_identity_lock), which conflicts
  --     with the FOR SHARE above, so from here on no requested variant can
  --     change product until this command ends. A reparent that committed
  --     between step 3 and the lock is seen here: this statement takes a fresh
  --     READ COMMITTED snapshot. (The internal principal holds no UPDATE on
  --     product_variants, so it cannot lock variant rows itself.)
  FOR v_i IN 1 .. v_n LOOP
    v_req := p_requests[v_lo + v_i - 1];
    IF NOT EXISTS (SELECT 1 FROM product_variants pv
                    WHERE pv.business_id = v_business AND pv.id = v_req.variant_id AND pv.product_id = v_products[v_i]) THEN
      RAISE EXCEPTION 'inventory.variant_stock_identity_changed: the variant moved to another product while the command ran' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- 5. Stock keys (P3-AL-06, P3-AL-07): every distinct key, in ascending
  --    uuid order whatever the payload order, is created if absent and then
  --    locked. Two commands over the same keys therefore lock them in the
  --    same order.
  FOR v_key IN
    SELECT DISTINCT r.warehouse_id AS wh, r.variant_id AS va
    FROM unnest(p_requests) AS r
    ORDER BY 1, 2
  LOOP
    INSERT INTO stock_levels (tenant_id, business_id, warehouse_id, variant_id, on_hand, valuation_base_minor,
                              avg_unit_cost_base_minor, last_stock_seq)
    VALUES (v_tenant, v_business, v_key.wh, v_key.va, 0, 0, NULL, 0)
    ON CONFLICT (business_id, warehouse_id, variant_id) DO NOTHING;

    PERFORM 1 FROM stock_levels l
     WHERE l.business_id = v_business AND l.warehouse_id = v_key.wh AND l.variant_id = v_key.va
       FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'inventory.arithmetic_invalid: the stock key could not be locked' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- 6. Each request, in array order, against the locked cache row.
  FOR v_i IN 1 .. v_n LOOP
    v_req := p_requests[v_lo + v_i - 1];
    v_qty := v_req.qty_delta;

    SELECT l.on_hand, l.valuation_base_minor, l.avg_unit_cost_base_minor, l.last_stock_seq
      INTO v_level_qty, v_level_value, v_level_avg, v_level_seq
    FROM stock_levels l
    WHERE l.business_id = v_business AND l.warehouse_id = v_req.warehouse_id AND l.variant_id = v_req.variant_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'inventory.arithmetic_invalid: the locked stock key vanished' USING ERRCODE = 'P0001';
    END IF;

    -- a. The five-part identity, checked under the key lock so a same-key
    --    race answers with the stable code.
    IF EXISTS (SELECT 1 FROM stock_movements m
                WHERE m.business_id = v_business AND m.source_type = v_req.source_type
                  AND m.source_id = v_req.source_id AND m.source_line_id = v_req.source_line_id
                  AND m.movement_kind = v_req.movement_kind) THEN
      RAISE EXCEPTION 'inventory.movement_identity_conflict: this source line already carries a movement of this kind' USING ERRCODE = 'P0001';
    END IF;

    -- b. Sign and reason.
    SELECT k.qty_sign, k.requires_reason INTO v_sign, v_needs_reason
    FROM stock_movement_kinds k
    WHERE k.movement_kind = v_req.movement_kind;
    IF (v_sign = 'positive' AND v_qty <= 0)
       OR (v_sign = 'negative' AND v_qty >= 0)
       OR (v_sign = 'either' AND v_qty = 0)
       OR (v_sign = 'zero' AND v_qty <> 0) THEN
      RAISE EXCEPTION 'inventory.quantity_sign_invalid: the quantity sign is not allowed for this movement kind' USING ERRCODE = 'P0001';
    END IF;
    IF v_needs_reason AND v_req.reason IS NULL THEN
      RAISE EXCEPTION 'inventory.reason_required: this movement kind requires a reason' USING ERRCODE = 'P0001';
    END IF;

    -- c. The stored value and the snapshot, by class.
    IF v_qty = 0 THEN
      -- Value-only: the caller's value, no snapshot.
      IF v_req.unit_cost_base_minor IS NOT NULL OR v_req.value_delta_base_minor IS NULL OR v_req.value_delta_base_minor = 0 THEN
        RAISE EXCEPTION 'inventory.movement_shape_invalid: a value-only movement carries a non-zero value and no cost' USING ERRCODE = 'P0001';
      END IF;
      v_value    := v_req.value_delta_base_minor;
      v_snapshot := NULL;
    ELSIF v_req.movement_kind = 'transfer_in' THEN
      -- The incoming leg carries exactly what the outgoing leg took out.
      IF v_req.unit_cost_base_minor IS NOT NULL OR v_req.value_delta_base_minor IS NOT NULL THEN
        RAISE EXCEPTION 'inventory.movement_shape_invalid: a transfer_in movement takes its cost and value from its transfer_out' USING ERRCODE = 'P0001';
      END IF;
      SELECT m.warehouse_id AS wh, m.variant_id AS va, m.qty_delta AS qty, m.unit_cost_base_minor AS snap,
             m.value_delta_base_minor AS val
        INTO v_pair
      FROM stock_movements m
      WHERE m.business_id = v_business AND m.source_type = v_req.source_type
        AND m.source_id = v_req.source_id AND m.source_line_id = v_req.source_line_id
        AND m.movement_kind = 'transfer_out';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'inventory.transfer_pair_missing: a transfer_in needs the transfer_out of the same source line' USING ERRCODE = 'P0001';
      END IF;
      IF v_pair.va <> v_req.variant_id OR v_pair.wh = v_req.warehouse_id OR v_pair.qty <> -v_qty THEN
        RAISE EXCEPTION 'inventory.transfer_pair_mismatch: a transfer moves the same variant and quantity between two warehouses' USING ERRCODE = 'P0001';
      END IF;
      v_value    := -v_pair.val;
      v_snapshot := v_pair.snap;
    ELSIF v_qty < 0 THEN
      -- Outbound: its own quantity at the current average, or the stored
      -- valuation exactly when it empties the key.
      IF v_req.unit_cost_base_minor IS NOT NULL OR v_req.value_delta_base_minor IS NOT NULL THEN
        RAISE EXCEPTION 'inventory.movement_shape_invalid: an outbound movement is valued at the current average, not by its caller' USING ERRCODE = 'P0001';
      END IF;
      IF abs(v_qty) > v_level_qty THEN
        RAISE EXCEPTION 'inventory.insufficient_stock: the warehouse does not hold enough of this variant' USING ERRCODE = 'P0001';
      END IF;
      IF v_level_avg IS NULL OR v_level_avg < 0 THEN
        RAISE EXCEPTION 'inventory.arithmetic_invalid: the stock key has no usable average cost' USING ERRCODE = 'P0001';
      END IF;
      IF abs(v_qty) = v_level_qty THEN
        v_value := -v_level_value;
      ELSE
        v_value := -inventory_half_even(abs(v_qty) * v_level_avg, 1, 0);
      END IF;
      v_snapshot := v_level_avg;
    ELSE
      -- Inbound: the supplied document cost is the snapshot (A-27); the value
      -- is the supplied integer share for a priced document, else HALF_EVEN of
      -- quantity times cost.
      IF v_req.unit_cost_base_minor IS NULL
         OR (v_req.value_delta_base_minor IS NOT NULL AND v_req.movement_kind NOT IN ('purchase', 'inventory_opening')) THEN
        RAISE EXCEPTION 'inventory.movement_shape_invalid: an inbound movement carries its unit cost, and only a priced document supplies its value' USING ERRCODE = 'P0001';
      END IF;
      v_snapshot := v_req.unit_cost_base_minor;
      IF v_snapshot < 0 OR v_snapshot <> trunc(v_snapshot, 10) OR v_snapshot >= c_value_limit THEN
        RAISE EXCEPTION 'inventory.cost_invalid: a unit cost is non-negative, below the limit and exact at 10 decimal places' USING ERRCODE = 'P0001';
      END IF;
      IF v_req.value_delta_base_minor IS NOT NULL THEN
        IF v_req.value_delta_base_minor < 0 THEN
          RAISE EXCEPTION 'inventory.movement_shape_invalid: a supplied inbound value is not negative' USING ERRCODE = 'P0001';
        END IF;
        v_value := v_req.value_delta_base_minor;
      ELSE
        v_value := inventory_half_even(v_qty * v_snapshot, 1, 0);
      END IF;
    END IF;

    -- d. Bounds and the next state. The average is DERIVED from the stored
    --    valuation and quantity, and carried when the key reaches zero.
    IF abs(v_value) > c_value_limit THEN
      RAISE EXCEPTION 'inventory.value_out_of_range: the movement value is outside the supported range' USING ERRCODE = 'P0001';
    END IF;
    v_next_value := v_level_value + v_value;
    IF abs(v_next_value) > c_value_limit THEN
      RAISE EXCEPTION 'inventory.value_out_of_range: the resulting valuation is outside the supported range' USING ERRCODE = 'P0001';
    END IF;
    v_next_qty := v_level_qty + v_qty;
    IF abs(v_next_qty) >= c_qty_limit THEN
      RAISE EXCEPTION 'inventory.quantity_out_of_range: the resulting quantity is outside the supported range' USING ERRCODE = 'P0001';
    END IF;
    IF v_next_qty <> 0 THEN
      v_next_avg := inventory_half_even(v_next_value, v_next_qty, 10);
    ELSE
      v_next_avg := v_level_avg;
    END IF;
    IF v_next_avg IS NOT NULL AND abs(v_next_avg) >= c_value_limit THEN
      RAISE EXCEPTION 'inventory.value_out_of_range: the resulting average cost is outside the supported range' USING ERRCODE = 'P0001';
    END IF;
    v_seq := v_level_seq + 1;
    v_id  := gen_random_uuid();

    -- e. ONE statement (A-15): the movement, the cache and the binding.
    WITH mv AS (
      INSERT INTO stock_movements (tenant_id, business_id, id, warehouse_id, variant_id, stock_seq, movement_kind,
                                   source_type, source_id, source_line_id, qty_delta, unit_cost_base_minor,
                                   value_delta_base_minor, reason, actor_user_id)
      VALUES (v_tenant, v_business, v_id, v_req.warehouse_id, v_req.variant_id, v_seq, v_req.movement_kind,
              v_req.source_type, v_req.source_id, v_req.source_line_id, v_qty, v_snapshot,
              v_value::bigint, v_req.reason, v_actor.actor_user_id)
      RETURNING 1
    ), lv AS (
      UPDATE stock_levels l
         SET on_hand                  = v_next_qty,
             valuation_base_minor     = v_next_value::bigint,
             avg_unit_cost_base_minor = v_next_avg,
             last_stock_seq           = v_seq
       WHERE l.business_id = v_business AND l.warehouse_id = v_req.warehouse_id AND l.variant_id = v_req.variant_id
      RETURNING 1
    )
    INSERT INTO stock_source_bindings (tenant_id, business_id, source_type, source_id, source_line_id, movement_kind)
    SELECT v_tenant, v_business, v_req.source_type, v_req.source_id, v_req.source_line_id, v_req.movement_kind
    WHERE EXISTS (SELECT 1 FROM mv) AND EXISTS (SELECT 1 FROM lv);
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'inventory.arithmetic_invalid: the movement, cache and binding were not written together' USING ERRCODE = 'P0001';
    END IF;

    -- f. Answer with what was STORED, as stored.
    SELECT m.qty_delta, m.unit_cost_base_minor, m.value_delta_base_minor
      INTO qty_delta, unit_cost_base_minor, value_delta_base_minor
    FROM stock_movements m
    WHERE m.business_id = v_business AND m.id = v_id;
    SELECT l.on_hand, l.valuation_base_minor, l.avg_unit_cost_base_minor
      INTO on_hand, valuation_base_minor, avg_unit_cost_base_minor
    FROM stock_levels l
    WHERE l.business_id = v_business AND l.warehouse_id = v_req.warehouse_id AND l.variant_id = v_req.variant_id;
    ordinal       := v_i;
    movement_id   := v_id;
    warehouse_id  := v_req.warehouse_id;
    variant_id    := v_req.variant_id;
    stock_seq     := v_seq;
    movement_kind := v_req.movement_kind;
    RETURN NEXT;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION inventory_apply_stock_movements(inventory_movement_request[]) IS
  'P3-S2 §2.5 R3. The only writer of stock_movements, stock_levels and stock_source_bindings. First re-verifies the transaction''s consumed invctl/1 assertion (inventory_assertion_current) against the mapped operations; every kind must be mapped to the verified operation. Validates shape, kind, scope, product tracking, base-variant identity, precision and ranges; locks products FOR SHARE in id order, then creates and locks every stock key in uuid order; then per request writes the movement, the cache and the binding in one statement, with every value computed here by HALF_EVEN (inbound supplied share only for purchase/inventory_opening). Returns what was stored. No EXECUTE grant.';

-- R4. The next deficit sequence of a key, under the key lock (A-07).
CREATE OR REPLACE FUNCTION inventory_next_deficit_seq(p_business_id UUID, p_warehouse_id UUID, p_variant_id UUID) RETURNS BIGINT
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_next BIGINT;
BEGIN
  IF p_business_id IS NULL
     OR p_business_id IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'inventory.scope_mismatch: the stock key is not in the transaction''s business' USING ERRCODE = 'P0001';
  END IF;
  PERFORM 1 FROM stock_levels l
   WHERE l.business_id = p_business_id AND l.warehouse_id = p_warehouse_id AND l.variant_id = p_variant_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'inventory.stock_key_missing: the stock key does not exist' USING ERRCODE = 'P0001';
  END IF;
  SELECT coalesce(max(d.deficit_seq), 0) + 1 INTO v_next
  FROM negative_inventory_deficits d
  WHERE d.business_id = p_business_id AND d.warehouse_id = p_warehouse_id AND d.variant_id = p_variant_id;
  RETURN v_next;
END;
$$;

COMMENT ON FUNCTION inventory_next_deficit_seq(UUID, UUID, UUID) IS
  'P3-S2 A-07 R4. Locks the stock key and returns max(deficit_seq) + 1 for it; writes nothing. inventory.scope_mismatch outside the transaction''s business, inventory.stock_key_missing without a cache row. No EXECUTE grant.';

-- R5. The rebuild algorithm (P3-AL-07): the key's state folded from its
--     movements in stock_seq order only.
CREATE OR REPLACE FUNCTION inventory_stock_fold(p_business_id UUID, p_warehouse_id UUID, p_variant_id UUID)
RETURNS TABLE (
  on_hand                  NUMERIC,
  valuation_base_minor     BIGINT,
  avg_unit_cost_base_minor NUMERIC,
  last_stock_seq           BIGINT,
  movement_count           BIGINT,
  sequence_gapless         BOOLEAN
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_qty       NUMERIC;
  v_value     NUMERIC;
  v_count     BIGINT;
  v_max       BIGINT;
  v_min       BIGINT;
  v_run_qty   NUMERIC;
  v_run_value NUMERIC;
BEGIN
  IF p_business_id IS NULL
     OR p_business_id IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'inventory.scope_mismatch: the stock key is not in the transaction''s business' USING ERRCODE = 'P0001';
  END IF;

  SELECT coalesce(sum(m.qty_delta), 0), coalesce(sum(m.value_delta_base_minor), 0), count(*), max(m.stock_seq), min(m.stock_seq)
    INTO v_qty, v_value, v_count, v_max, v_min
  FROM stock_movements m
  WHERE m.business_id = p_business_id AND m.warehouse_id = p_warehouse_id AND m.variant_id = p_variant_id;

  -- The average after the LAST movement at which the running quantity was
  -- not zero; afterwards it is carried, exactly as the primitive carries it.
  SELECT t.run_qty, t.run_value INTO v_run_qty, v_run_value
  FROM (
    SELECT m.stock_seq AS seq,
           sum(m.qty_delta) OVER w              AS run_qty,
           sum(m.value_delta_base_minor) OVER w AS run_value
    FROM stock_movements m
    WHERE m.business_id = p_business_id AND m.warehouse_id = p_warehouse_id AND m.variant_id = p_variant_id
    WINDOW w AS (ORDER BY m.stock_seq ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
  ) t
  WHERE t.run_qty <> 0
  ORDER BY t.seq DESC
  LIMIT 1;

  on_hand              := v_qty;
  valuation_base_minor := v_value::bigint;
  IF v_run_qty IS NULL THEN
    avg_unit_cost_base_minor := NULL;
  ELSE
    avg_unit_cost_base_minor := inventory_half_even(v_run_value, v_run_qty, 10);
  END IF;
  last_stock_seq   := coalesce(v_max, 0);
  movement_count   := v_count;
  sequence_gapless := v_count = 0 OR (v_count = v_max AND v_min = 1);
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION inventory_stock_fold(UUID, UUID, UUID) IS
  'P3-AL-07 R5. Rebuilds a stock key''s on_hand, valuation, average, last sequence and movement count from stock_movements ordered by stock_seq only, and reports whether the sequence is 1..n without gaps. Writes nothing. inventory.scope_mismatch outside the transaction''s business. No EXECUTE grant.';

-- R6. Verification mode (P3-AL-07): compares the cache with the rebuild.
--     Writes nothing; waits for a live writer of the key.
CREATE OR REPLACE FUNCTION inventory_stock_verify(p_business_id UUID, p_warehouse_id UUID, p_variant_id UUID)
RETURNS TABLE (
  cache_on_hand     NUMERIC,
  rebuilt_on_hand   NUMERIC,
  cache_valuation   BIGINT,
  rebuilt_valuation BIGINT,
  cache_avg         NUMERIC,
  rebuilt_avg       NUMERIC,
  cache_last_seq    BIGINT,
  rebuilt_last_seq  BIGINT,
  matches           BOOLEAN
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_found   BOOLEAN;
  v_gapless BOOLEAN;
BEGIN
  IF p_business_id IS NULL
     OR p_business_id IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'inventory.scope_mismatch: the stock key is not in the transaction''s business' USING ERRCODE = 'P0001';
  END IF;

  SELECT l.on_hand, l.valuation_base_minor, l.avg_unit_cost_base_minor, l.last_stock_seq
    INTO cache_on_hand, cache_valuation, cache_avg, cache_last_seq
  FROM stock_levels l
  WHERE l.business_id = p_business_id AND l.warehouse_id = p_warehouse_id AND l.variant_id = p_variant_id
  FOR SHARE;
  v_found := FOUND;

  SELECT f.on_hand, f.valuation_base_minor, f.avg_unit_cost_base_minor, f.last_stock_seq, f.sequence_gapless
    INTO rebuilt_on_hand, rebuilt_valuation, rebuilt_avg, rebuilt_last_seq, v_gapless
  FROM inventory_stock_fold(p_business_id, p_warehouse_id, p_variant_id) f;

  matches := v_found
         AND cache_on_hand IS NOT DISTINCT FROM rebuilt_on_hand
         AND cache_valuation IS NOT DISTINCT FROM rebuilt_valuation
         AND cache_avg IS NOT DISTINCT FROM rebuilt_avg
         AND cache_last_seq IS NOT DISTINCT FROM rebuilt_last_seq
         AND v_gapless;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION inventory_stock_verify(UUID, UUID, UUID) IS
  'P3-AL-07 R6. Locks the stock key FOR SHARE, rebuilds it with inventory_stock_fold and compares on_hand, valuation, average and last sequence with the cache (IS NOT DISTINCT FROM) plus a gapless sequence. A key without a cache row does not match. Writes nothing. No EXECUTE grant.';

-- R7. The unit-history lock (P3-AL-54 §G, guard 2). DEFINER so the history
--     it reads is not narrowed by the writer's row security; it never
--     decides by who is writing.
CREATE OR REPLACE FUNCTION products_20_unit_history_lock() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: a product unit is changed only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.business_id IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid
     OR (SELECT b.tenant_id FROM businesses b WHERE b.id = NEW.business_id)
        IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'inventory.scope_mismatch: a product unit is changed only within the product''s own business and tenant scope' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM stock_movements m
             JOIN product_variants v ON v.business_id = m.business_id AND v.id = m.variant_id
             WHERE v.business_id = OLD.business_id AND v.product_id = OLD.id) THEN
    RAISE EXCEPTION 'inventory.unit_identity_locked: the product has stock history, so its unit and precision can no longer change' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION products_20_unit_history_lock() IS
  'P3-AL-54 §G guard 2. BEFORE UPDATE row trigger on products, fired only when unit_code or unit_decimals changes: inventory.isolation_unsupported outside READ COMMITTED, then inventory.scope_mismatch unless the writer''s scope is the product''s business and tenant, then inventory.unit_identity_locked when any movement of any variant of the product exists. Fires after products_10_inventory_config_authority. No EXECUTE grant.';

-- R8. on_hand = 0 ⇒ valuation = 0, at COMMIT (A-22).
CREATE OR REPLACE FUNCTION stock_levels_zero_on_hand_zero_value() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_qty   NUMERIC;
  v_value BIGINT;
BEGIN
  SELECT l.on_hand, l.valuation_base_minor INTO v_qty, v_value
  FROM stock_levels l
  WHERE l.business_id = NEW.business_id AND l.warehouse_id = NEW.warehouse_id AND l.variant_id = NEW.variant_id;
  IF FOUND AND v_qty = 0 AND v_value <> 0 THEN
    RAISE EXCEPTION 'inventory.zero_stock_residual_value: a stock key with no quantity must hold no value' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION stock_levels_zero_on_hand_zero_value() IS
  'P3-S2 A-22 R8. Deferred constraint trigger on stock_levels: at COMMIT, re-reads the key and refuses on_hand = 0 with a non-zero valuation (inventory.zero_stock_residual_value). DEFINER so the writer''s row security cannot blind it. No EXECUTE grant.';

-- R9. The variant stock-identity lock (H-1). `daftar_app` holds table-level
--     UPDATE on product_variants (0006), product_id included. A variant that
--     has a stock key is bound to its product for good: moving it would carry
--     its history out from under the product's unit-history lock, its
--     tracking-disable rule and its base-variant identity. DEFINER so the
--     writer's row security cannot blind the check; it never decides by who
--     is writing. It first takes FOR UPDATE on the variant's current product,
--     which conflicts with the stock primitive's FOR SHARE: a reparent waits
--     for an in-flight stock command on that product, then sees its key.
CREATE OR REPLACE FUNCTION product_variants_20_stock_identity_lock() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: a variant is moved to another product only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.business_id IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid
     OR OLD.business_id IS DISTINCT FROM NEW.business_id
     OR (SELECT b.tenant_id FROM businesses b WHERE b.id = NEW.business_id)
        IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'inventory.scope_mismatch: a variant is moved only within its own business and tenant scope' USING ERRCODE = 'P0001';
  END IF;
  PERFORM 1 FROM products p
   WHERE p.business_id = OLD.business_id AND p.id = OLD.product_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'inventory.scope_mismatch: the variant''s product is not visible in this scope' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM stock_levels l WHERE l.business_id = OLD.business_id AND l.variant_id = OLD.id) THEN
    RAISE EXCEPTION 'inventory.variant_stock_identity_locked: the variant has a stock key, so it can no longer move to another product' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION product_variants_20_stock_identity_lock() IS
  'P3-S2 H-1. BEFORE UPDATE OF product_id row trigger on product_variants, fired only when product_id changes: inventory.isolation_unsupported outside READ COMMITTED, inventory.scope_mismatch unless the writer''s scope is the variant''s business and tenant, then locks the current product FOR UPDATE (waiting for any in-flight stock command on it) and refuses with inventory.variant_stock_identity_locked when any stock_levels row exists for the variant. Fires after product_variants_10_base_variant_authority. No EXECUTE grant.';

-- ─────────────────────────────────────────────────────────────────────────
-- 4. The ACL while the MIGRATOR still owns every routine (0044:177-199 —
--    do not reorder). No routine of this file is granted to anyone.
-- ─────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION inventory_half_even(NUMERIC, NUMERIC, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION inventory_quantity_is_representable(NUMERIC, SMALLINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION inventory_apply_stock_movements(inventory_movement_request[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION inventory_next_deficit_seq(UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION inventory_stock_fold(UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION inventory_stock_verify(UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION products_20_unit_history_lock() FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_levels_zero_on_hand_zero_value() FROM PUBLIC;
REVOKE ALL ON FUNCTION product_variants_20_stock_identity_lock() FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. The triggers, installed while the migrator still owns the functions.
--
-- `products_20_…` sorts after `products_10_inventory_config_authority` by
-- name, so WHO is asked before WHEN (P3-AL-54 §G). Its WHEN clause keeps it
-- off every ordinary catalog update.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TRIGGER products_20_unit_history_lock
  BEFORE UPDATE ON products
  FOR EACH ROW
  WHEN (OLD.unit_code IS DISTINCT FROM NEW.unit_code OR OLD.unit_decimals IS DISTINCT FROM NEW.unit_decimals)
  EXECUTE FUNCTION products_20_unit_history_lock();

CREATE CONSTRAINT TRIGGER stock_levels_zero_on_hand_zero_value
  AFTER INSERT OR UPDATE ON stock_levels
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION stock_levels_zero_on_hand_zero_value();

-- `product_variants_20_…` sorts after `product_variants_10_base_variant_authority`.
CREATE TRIGGER product_variants_20_stock_identity_lock
  BEFORE UPDATE OF product_id ON product_variants
  FOR EACH ROW
  WHEN (OLD.product_id IS DISTINCT FROM NEW.product_id)
  EXECUTE FUNCTION product_variants_20_stock_identity_lock();

-- ─────────────────────────────────────────────────────────────────────────
-- 6. The ownership transfer.
-- ─────────────────────────────────────────────────────────────────────────
ALTER FUNCTION inventory_half_even(NUMERIC, NUMERIC, INTEGER) OWNER TO daftar_inventory_internal;
ALTER FUNCTION inventory_quantity_is_representable(NUMERIC, SMALLINT) OWNER TO daftar_inventory_internal;
ALTER FUNCTION inventory_apply_stock_movements(inventory_movement_request[]) OWNER TO daftar_inventory_internal;
ALTER FUNCTION inventory_next_deficit_seq(UUID, UUID, UUID) OWNER TO daftar_inventory_internal;
ALTER FUNCTION inventory_stock_fold(UUID, UUID, UUID) OWNER TO daftar_inventory_internal;
ALTER FUNCTION inventory_stock_verify(UUID, UUID, UUID) OWNER TO daftar_inventory_internal;
ALTER FUNCTION products_20_unit_history_lock() OWNER TO daftar_inventory_internal;
ALTER FUNCTION stock_levels_zero_on_hand_zero_value() OWNER TO daftar_inventory_internal;
ALTER FUNCTION product_variants_20_stock_identity_lock() OWNER TO daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 7. The P3-AL-41 disable rule (A-13).
--
-- `inventory_configure_product` is already owned by the internal principal
-- (0055), so only that principal may replace it: the migrator assumes it
-- through its SET-enabled, non-inheriting membership, inside the CREATE
-- bracket of section 1, and returns at once. CREATE OR REPLACE by the owner
-- keeps the signature, the return type, the owner and the ACL (EXECUTE for
-- daftar_app only). The body is 0055's, byte for byte, with ONE new step
-- (3b) after the product lock.
-- ─────────────────────────────────────────────────────────────────────────
SET LOCAL ROLE daftar_inventory_internal;

CREATE OR REPLACE FUNCTION inventory_configure_product(
  p_product_id    UUID,
  p_track         BOOLEAN,
  p_unit_code     TEXT,
  p_unit_decimals SMALLINT
) RETURNS TABLE (
  product_id      UUID,
  track_inventory BOOLEAN,
  unit_code       TEXT,
  unit_decimals   SMALLINT,
  base_variant_id UUID,
  changed         BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_actor      inventory_verified_actor;
  v_business   UUID;
  v_old_track  BOOLEAN;
  v_old_unit   TEXT;
  v_old_dec    SMALLINT;
  v_new_unit   TEXT;
  v_new_dec    SMALLINT;
  v_default    SMALLINT;
  v_merchant   BOOLEAN;
  v_base       UUID;
  v_created    BOOLEAN := false;
  v_changed    BOOLEAN;
  v_trace      UUID;
BEGIN
  -- 1. Authority first. The digest is computed from this routine's OWN
  --    arguments, in the P3-AL-55 §F field order, so an assertion minted for
  --    any other value of any of them is refused here.
  v_actor := inventory_assertion_consume(
    'inventory.configure_product',
    inventory_claimed_payload_digest(
      'inventory.configure_product',
      ARRAY['uuid', 'boolean', 'code', 'integer'],
      ARRAY[p_product_id::text, p_track::text, p_unit_code, p_unit_decimals::text]
    )
  );
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: inventory configuration runs only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_business := v_actor.business_id;
  v_trace    := inventory_business_transaction_id();

  -- 2. Shape. A signed NULL product or flag cannot occur (the minter refuses
  --    it), so these are programming errors surfaced with a stable code.
  IF p_product_id IS NULL OR p_track IS NULL THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a product configuration names its product and its tracking flag' USING ERRCODE = 'P0001';
  END IF;
  IF p_unit_decimals IS NOT NULL AND p_unit_code IS NULL THEN
    RAISE EXCEPTION 'inventory.unit_required: a unit precision is given only together with its unit' USING ERRCODE = 'P0001';
  END IF;
  IF p_unit_decimals IS NOT NULL AND (p_unit_decimals < 0 OR p_unit_decimals > 4) THEN
    RAISE EXCEPTION 'inventory.unit_decimals_invalid: a unit precision is between 0 and 4 decimal places' USING ERRCODE = 'P0001';
  END IF;

  -- 3. The product, in the asserted business only, locked for the decision.
  SELECT p.track_inventory, p.unit_code, p.unit_decimals
    INTO v_old_track, v_old_unit, v_old_dec
  FROM products p
  WHERE p.business_id = v_business AND p.id = p_product_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'inventory.product_not_found: the product does not exist in this business' USING ERRCODE = 'P0001';
  END IF;

  -- 3b. P3-AL-41 (P3-S2): tracking is disabled only when no stock key of any
  --     variant of the product holds a quantity. The product lock above
  --     conflicts with the stock primitive's FOR SHARE, so no movement of
  --     this product can commit between this test and the change.
  IF v_old_track AND NOT p_track
     AND EXISTS (SELECT 1 FROM stock_levels l
                 JOIN product_variants v ON v.business_id = l.business_id AND v.id = l.variant_id
                 WHERE v.business_id = v_business AND v.product_id = p_product_id AND l.on_hand <> 0) THEN
    RAISE EXCEPTION 'inventory.tracking_disable_requires_zero_stock: inventory tracking can be disabled only when the product holds no stock' USING ERRCODE = 'P0001';
  END IF;

  -- 4. The resulting unit. Never cleared: NULL keeps what is there.
  IF p_unit_code IS NULL THEN
    v_new_unit := v_old_unit;
    v_new_dec  := v_old_dec;
  ELSE
    SELECT u.default_decimals INTO v_default FROM units u WHERE u.unit_code = p_unit_code;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'inventory.unit_unknown: the unit is not a canonical unit' USING ERRCODE = 'P0001';
    END IF;
    v_new_unit := p_unit_code;
    v_new_dec  := coalesce(p_unit_decimals,
                           CASE WHEN p_unit_code = v_old_unit THEN v_old_dec END,
                           v_default);
  END IF;

  -- 5. Tracked ⇒ a canonical unit (P3-AL-04).
  IF p_track AND v_new_unit IS NULL THEN
    RAISE EXCEPTION 'inventory.unit_required: tracking inventory requires a canonical unit' USING ERRCODE = 'P0001';
  END IF;

  -- 6. Write only what changes. The UPDATE fires the column guard, which
  --    admits it because this routine runs as daftar_inventory_internal.
  v_changed := v_old_track IS DISTINCT FROM p_track
            OR v_old_unit  IS DISTINCT FROM v_new_unit
            OR v_old_dec   IS DISTINCT FROM v_new_dec;
  IF v_changed THEN
    UPDATE products p
       SET track_inventory = p_track, unit_code = v_new_unit, unit_decimals = v_new_dec
     WHERE p.business_id = v_business AND p.id = p_product_id;
  END IF;

  -- 7. The hidden base variant (P3-AL-03). Only when the product ends
  --    tracked and has no merchant variant in any status: a product with
  --    variants tracks them, and an archived merchant variant is still a
  --    variant. The partial unique index makes a second base variant
  --    impossible, so a concurrent or repeated call is a no-op.
  IF p_track THEN
    SELECT EXISTS (SELECT 1 FROM product_variants v
                    WHERE v.business_id = v_business AND v.product_id = p_product_id AND NOT v.is_base)
      INTO v_merchant;
    IF NOT v_merchant THEN
      INSERT INTO product_variants (business_id, id, product_id, is_base)
      VALUES (v_business, gen_random_uuid(), p_product_id, true)
      ON CONFLICT (business_id, product_id) WHERE is_base DO NOTHING;
      v_created := FOUND;
    END IF;
  END IF;

  SELECT v.id INTO v_base
  FROM product_variants v
  WHERE v.business_id = v_business AND v.product_id = p_product_id AND v.is_base;

  -- 8. Audit, with the SIGNED actor, only when something happened.
  IF v_changed OR v_created THEN
    INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
    VALUES (v_actor.tenant_id, v_business, v_actor.actor_user_id, 'inventory.product_configured', 'product', p_product_id::text,
            jsonb_build_object(
              'trackInventory', p_track,
              'unitCode', v_new_unit,
              'unitDecimals', v_new_dec,
              'previous', jsonb_build_object('trackInventory', v_old_track, 'unitCode', v_old_unit, 'unitDecimals', v_old_dec),
              'baseVariantId', v_base,
              'baseVariantCreated', v_created,
              'assertionJti', v_actor.jti,
              'business_transaction_id', v_trace));
  END IF;

  product_id      := p_product_id;
  track_inventory := p_track;
  unit_code       := v_new_unit;
  unit_decimals   := v_new_dec;
  base_variant_id := v_base;
  changed         := v_changed OR v_created;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION inventory_configure_product(UUID, BOOLEAN, TEXT, SMALLINT) IS
  'P3-AL-54 §E, P3-AL-55 §G. The only writer of products.track_inventory/unit_code/unit_decimals and of base variants. First consumes an invctl/1 assertion of kind inventory.configure_product over the digest of its own arguments; the business is the asserted one. Then: product in that business (inventory.product_not_found), tracking disabled only at zero stock in every key of the product (inventory.tracking_disable_requires_zero_stock, P3-AL-41 from P3-S2), unit in the registry (inventory.unit_unknown), precision 0..4 given only with a unit (inventory.unit_decimals_invalid, inventory.unit_required), tracked => unit (inventory.unit_required); a NULL unit keeps the current one. A unit change of a product with stock history is refused by products_20_unit_history_lock (inventory.unit_identity_locked). Creates the hidden base variant when the product ends tracked and has no merchant variant, idempotently. Audits inventory.product_configured with the signed actor when anything changed. EXECUTE: daftar_app only — reachability, not authority.';

RESET ROLE;

-- Hand back the ownership-transfer authority from section 1.
REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 9. Refuse to commit unless the end state is exactly right (0060-E).
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_role   TEXT;
  v_proc   REGPROCEDURE;
  v_detail TEXT;
  c_routines CONSTANT REGPROCEDURE[] := ARRAY[
    'inventory_half_even(numeric,numeric,integer)'::regprocedure,
    'inventory_quantity_is_representable(numeric,smallint)'::regprocedure,
    'inventory_apply_stock_movements(inventory_movement_request[])'::regprocedure,
    'inventory_next_deficit_seq(uuid,uuid,uuid)'::regprocedure,
    'inventory_stock_fold(uuid,uuid,uuid)'::regprocedure,
    'inventory_stock_verify(uuid,uuid,uuid)'::regprocedure,
    'products_20_unit_history_lock()'::regprocedure,
    'stock_levels_zero_on_hand_zero_value()'::regprocedure,
    'product_variants_20_stock_identity_lock()'::regprocedure];
  c_configure CONSTANT REGPROCEDURE := 'inventory_configure_product(uuid,boolean,text,smallint)'::regprocedure;
BEGIN
  -- (1) R1-R9 and the replaced configure routine: internal-owned, DEFINER,
  --     pinned path.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_detail
  FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
  WHERE p.oid = ANY (c_routines || c_configure)
    AND (r.rolname <> 'daftar_inventory_internal' OR NOT p.prosecdef
         OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']);
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'inventory.authority_leak: routine(s) not internal-owned SECURITY DEFINER with the pinned search_path: %', v_detail;
  END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.oid = ANY (c_routines || c_configure)) <> 10 THEN
    RAISE EXCEPTION 'inventory.authority_leak: a P3-S2 routine is missing';
  END IF;

  -- (2) Nobody may call R1-R9; only daftar_app may call the configure routine.
  FOREACH v_proc IN ARRAY c_routines LOOP
    FOREACH v_role IN ARRAY ARRAY['daftar_app','daftar_platform','daftar_worker','daftar_identity','daftar_resolver','daftar_provisioner','daftar_reconciler','public'] LOOP
      IF has_function_privilege(v_role, v_proc, 'EXECUTE') THEN
        RAISE EXCEPTION 'inventory.authority_leak: % may execute %', v_role, v_proc;
      END IF;
    END LOOP;
  END LOOP;
  IF NOT has_function_privilege('daftar_app', c_configure, 'EXECUTE') THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_app cannot reach inventory_configure_product';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['daftar_platform','daftar_worker','daftar_identity','daftar_resolver','daftar_provisioner','daftar_reconciler','public'] LOOP
    IF has_function_privilege(v_role, c_configure, 'EXECUTE') THEN
      RAISE EXCEPTION 'inventory.authority_leak: % may execute inventory_configure_product', v_role;
    END IF;
  END LOOP;

  -- (3) The unit-history lock: BEFORE UPDATE, row, enabled, conditional,
  --     internal DEFINER, and ordered after the authority guard.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                   JOIN pg_proc p ON p.oid = g.tgfoid
                   JOIN pg_roles r ON r.oid = p.proowner
                  WHERE g.tgrelid = 'products'::regclass AND NOT g.tgisinternal
                    AND g.tgname = 'products_20_unit_history_lock'
                    AND g.tgfoid = 'products_20_unit_history_lock()'::regprocedure
                    AND g.tgtype = 19            -- ROW (1) | BEFORE (2) | UPDATE (16)
                    AND g.tgenabled = 'O' AND g.tgqual IS NOT NULL
                    AND r.rolname = 'daftar_inventory_internal' AND p.prosecdef
                    AND g.tgname > 'products_10_inventory_config_authority') THEN
    RAISE EXCEPTION 'inventory.authority_leak: products_20_unit_history_lock is missing or not a conditional BEFORE UPDATE row trigger on an internal DEFINER function';
  END IF;

  -- (3b) The variant stock-identity lock: BEFORE UPDATE OF product_id, row,
  --      enabled, conditional, internal DEFINER, ordered after the
  --      base-variant guard.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                   JOIN pg_proc p ON p.oid = g.tgfoid
                   JOIN pg_roles r ON r.oid = p.proowner
                  WHERE g.tgrelid = 'product_variants'::regclass AND NOT g.tgisinternal
                    AND g.tgname = 'product_variants_20_stock_identity_lock'
                    AND g.tgfoid = 'product_variants_20_stock_identity_lock()'::regprocedure
                    AND g.tgtype = 19            -- ROW (1) | BEFORE (2) | UPDATE (16)
                    AND g.tgattr::text = (SELECT a.attnum::text FROM pg_attribute a
                                           WHERE a.attrelid = 'product_variants'::regclass AND a.attname = 'product_id')
                    AND g.tgenabled = 'O' AND g.tgqual IS NOT NULL
                    AND r.rolname = 'daftar_inventory_internal' AND p.prosecdef
                    AND g.tgname > 'product_variants_10_base_variant_authority') THEN
    RAISE EXCEPTION 'inventory.authority_leak: product_variants_20_stock_identity_lock is missing or not a conditional BEFORE UPDATE OF product_id row trigger on an internal DEFINER function';
  END IF;

  -- (4) The zero-stock check is a deferred constraint trigger.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                  WHERE g.tgrelid = 'stock_levels'::regclass
                    AND g.tgname = 'stock_levels_zero_on_hand_zero_value'
                    AND g.tgfoid = 'stock_levels_zero_on_hand_zero_value()'::regprocedure
                    AND g.tgtype = 21            -- ROW (1) | INSERT (4) | UPDATE (16), AFTER
                    AND g.tgenabled = 'O'
                    AND g.tgconstraint <> 0 AND g.tgdeferrable AND g.tginitdeferred) THEN
    RAISE EXCEPTION 'inventory.authority_leak: stock_levels_zero_on_hand_zero_value is missing or not DEFERRABLE INITIALLY DEFERRED';
  END IF;

  -- (5) The CREATE bracket closed.
  IF has_schema_privilege('daftar_inventory_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_inventory_internal still holds CREATE on schema public';
  END IF;

  -- (6) No operation may write a movement, and no source type exists,
  --     because this migration ran.
  IF EXISTS (SELECT 1 FROM stock_source_types) OR EXISTS (SELECT 1 FROM inventory_operation_movement_kinds) THEN
    RAISE EXCEPTION 'inventory.authority_leak: stock_source_types and inventory_operation_movement_kinds must be empty after 0060';
  END IF;
END $$;
