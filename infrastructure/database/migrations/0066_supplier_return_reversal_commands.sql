-- 0066_supplier_return_reversal_commands.sql
-- P3-S5, part 2 — the COMMAND side: the two INVOKER read functions that are
-- the S6 extension points, the four internal helpers, the two signed entry
-- routines `purchase_return` and `purchase_reverse`, and the two operation
-- kinds with their two op→movement mappings, LAST
-- (docs/PHASE_3_S5_CONTRACT.md §2.5, §2.6, §2.8, A-03, A-07-A-13, A-16,
-- A-17, A-20).
--
-- Every entry routine and helper is owned by daftar_inventory_internal,
-- SECURITY DEFINER with the pinned path, PUBLIC revoked; the two entry
-- routines are reachable by daftar_app only and the helpers by nobody. An
-- entry routine's FIRST statement consumes a signed invctl/1 assertion over
-- the digest of ALL its own arguments; a helper's first statement
-- re-verifies it. No routine reads a clock for a bound date or rate: the
-- dates are bound client input, the FX of a return is the purchase's stored
-- snapshot, and now() appears only in the "not in the future" comparison.
-- Nothing here carries or computes an element OD-03 reserves (A-14).
--
-- ── Engineering rulings taken here (documented for the report) ──────────
--
--   R-48 THE DOCUMENT KEY BEFORE THE INTENT (0064 R-26). §2.5 step 3 names
--        "the intent digest, then the advisory lock"; the intent is a pure
--        function of the routine's own arguments and the verified scope, so
--        both routines take the document key FIRST and compute the intent
--        right after it — the 0064-E (6) / 0066-E (6) shape, with the same
--        effect.
--   R-49 LOCK STEP 6 LOCKS EXISTING KEYS ONLY. `purchase_lock_stock_keys`
--        locks the `stock_levels` rows that exist, in (warehouse, variant)
--        order. Both commands take stock OUT of every key they name and
--        refuse unless the key holds at least the quantity, so a key with
--        no row is refused (`inventory.insufficient_stock` /
--        `purchase_reversal.insufficient_stock`) before the primitive could
--        create it: no key is ever created or locked out of the primitive's
--        order (the 0062 R-7 / 0064 R-25 hazard does not arise).
--   R-50 A missing identifying argument (return, purchase, warehouse, date)
--        or a NULL bound amount is `inventory.payload_invalid` (0064 R-29);
--        a line-shape error or an untrimmed/overlong reason is
--        `supplier_return.lines_invalid`, a reversal's
--        `purchase_reversal.reason_required` (§2.5 step 5). A return line id
--        already used by another return, or a credit note id already
--        stored, is `supplier_return.lines_invalid` /
--        `inventory.payload_invalid` rather than a raw key violation.
--   R-51 `purchase.reversed`'s audit row and event carry the ORIGINAL entry
--        id (A-20 names "the reversal entry id"): the reversal entry is
--        posted by the service after the routine returns, so inside the
--        routine only the original is known; the reversal entry is its
--        `accounting_reversals` row, one join away.
--   R-52 `purchase_ap_outstanding` answers 0 for a purchase that is not
--        received OR is reversed: a reversed purchase's AP is cleared by the
--        Phase 2 mirror of its entry, so the ledger AP of T-12 is 0 too.
--   R-55 THE CREDIT NOTE HAS ITS OWN WRITER (§7.2 rule 22). §7.2 puts
--        `supplier_credit_notes` in rule 22's stock write tables, and rule
--        22 (L-1) requires a writer's first statement to be an assertion
--        call whose arguments call nothing; `purchase_return`'s consume
--        computes its digest in its arguments. So the insert moves to the
--        helper `purchase_bridge_credit_note(return_id)` — the
--        `purchase_bridge_return` shape: internal-owned DEFINER, pinned,
--        no grantee, first statement `inventory_assertion_current` — called
--        at the same point (after the lines, before the movements) with the
--        same values, read back from the stored header and the locked
--        purchase. No lock is taken or reordered.
--
-- Migrations 0000-0065 are untouched.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The two read functions (A-16): the S6 extension points. Migrator-owned
--    SECURITY INVOKER STABLE, pinned; they read only through the caller's
--    row security, write nothing and decide nothing by role.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION purchase_ap_outstanding(p_business_id UUID, p_purchase_id UUID) RETURNS BIGINT
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_status   TEXT;
  v_total    BIGINT;
  v_released NUMERIC;
BEGIN
  SELECT p.status, p.total_txn_minor INTO v_status, v_total
  FROM purchases p WHERE p.business_id = p_business_id AND p.id = p_purchase_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase.not_found: the purchase does not exist in this business' USING ERRCODE = 'P0001';
  END IF;
  IF v_status <> 'received'
     OR EXISTS (SELECT 1 FROM purchase_reversals r WHERE r.business_id = p_business_id AND r.id = p_purchase_id) THEN
    RETURN 0;
  END IF;
  SELECT coalesce(sum(r.ap_txn_minor), 0) INTO v_released
  FROM supplier_returns r WHERE r.business_id = p_business_id AND r.purchase_id = p_purchase_id;
  RETURN (v_total - v_released)::bigint;
END;
$$;

COMMENT ON FUNCTION purchase_ap_outstanding(UUID, UUID) IS
  'P3-S5 A-16 (S6 extension point). The purchase''s outstanding AP in its own currency: T - the sum of ap_txn_minor over its supplier returns; 0 when the purchase is not received or is reversed (R-52); purchase.not_found when the caller cannot see it. INVOKER, reads through the caller''s row security, writes nothing. S6 replaces it to subtract supplier-payment and supplier-credit allocations. EXECUTE: daftar_app and daftar_inventory_internal.';

CREATE OR REPLACE FUNCTION purchase_settlement_state(p_business_id UUID, p_purchase_id UUID,
                                                     OUT payment_allocated BOOLEAN, OUT credit_allocated BOOLEAN)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- S5: no allocation table exists; S6 replaces this body with EXISTS over its allocations.
  payment_allocated := false;
  credit_allocated  := false;
END;
$$;

COMMENT ON FUNCTION purchase_settlement_state(UUID, UUID) IS
  'P3-S5 A-16 (S6 extension point, TL-9). Whether a supplier payment or a supplier credit is allocated to the purchase: false, false in S5, where no allocation table exists; S6 replaces it with EXISTS over its allocation tables. INVOKER, writes nothing. EXECUTE: daftar_app and daftar_inventory_internal.';

REVOKE ALL ON FUNCTION purchase_ap_outstanding(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION purchase_settlement_state(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purchase_ap_outstanding(UUID, UUID) TO daftar_app;
GRANT EXECUTE ON FUNCTION purchase_ap_outstanding(UUID, UUID) TO daftar_inventory_internal;
GRANT EXECUTE ON FUNCTION purchase_settlement_state(UUID, UUID) TO daftar_app;
GRANT EXECUTE ON FUNCTION purchase_settlement_state(UUID, UUID) TO daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Internal helpers (no grant; §2.5 "Helpers").
-- ─────────────────────────────────────────────────────────────────────────

-- Lock step 6 (R-34, R-49): SHARED advisory keys on the warehouse and every
-- variant in id order (the archive triggers take them EXCLUSIVE), the S3
-- A-19 re-checks as seen after them, the products FOR SHARE in id order,
-- then the existing stock keys FOR UPDATE in (warehouse, variant) order.
CREATE OR REPLACE FUNCTION purchase_lock_stock_keys(p_warehouse UUID, p_variants UUID[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor   inventory_verified_actor;
  v_id      UUID;
  v_status  TEXT;
  v_pstatus TEXT;
  v_tracked BOOLEAN;
BEGIN
  v_actor := inventory_assertion_current(ARRAY['purchase.return', 'purchase.reverse']);
  IF p_warehouse IS NULL OR p_variants IS NULL OR cardinality(p_variants) = 0 OR array_position(p_variants, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a stock lock names its warehouse and variants' USING ERRCODE = 'P0001';
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

  PERFORM 1 FROM stock_levels l
   WHERE l.business_id = v_actor.business_id AND l.warehouse_id = p_warehouse AND l.variant_id = ANY (p_variants)
   ORDER BY l.warehouse_id, l.variant_id
   FOR UPDATE;
END;
$$;

COMMENT ON FUNCTION purchase_lock_stock_keys(UUID, UUID[]) IS
  'P3-S5 §2.5, R-34 step 6, R-49. Re-verifies the transaction''s consumed purchase.return or purchase.reverse assertion, takes SHARED advisory locks (daftar.stock_target) on the warehouse and every variant in id order, requires the warehouse to exist and be active and every variant to exist, be active with an active product and be tracked (inventory.warehouse_not_found / _archived, variant_not_found / _archived, product_not_tracked), locks the products FOR SHARE in id order, then the existing stock keys FOR UPDATE in (warehouse, variant) order; the caller reads the locked rows. Internal-owned, no grant.';

-- The one writer of the supplier-return bridge (the 0062 R-5 pattern).
CREATE OR REPLACE FUNCTION purchase_bridge_return(p_return_id UUID) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor inventory_verified_actor;
  v_rows  INTEGER;
BEGIN
  v_actor := inventory_assertion_current(ARRAY['purchase.return']);
  IF p_return_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM supplier_returns r WHERE r.business_id = v_actor.business_id AND r.id = p_return_id) THEN
    RAISE EXCEPTION 'inventory.source_type_not_authorized: a return bridges only its own stored return' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO stock_source_bridge_supplier_return (business_id, source_id, source_line_id, movement_kind)
  SELECT b.business_id, b.source_id, b.source_line_id, b.movement_kind
  FROM stock_source_bindings b
  WHERE b.business_id = v_actor.business_id AND b.source_type = 'supplier_return' AND b.source_id = p_return_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

COMMENT ON FUNCTION purchase_bridge_return(UUID) IS
  'P3-S5 §2.5, 0062 R-5. The one writer of stock_source_bridge_supplier_return. Re-verifies the transaction''s consumed purchase.return assertion; p_return_id must be a stored return of the verified business (inventory.source_type_not_authorized otherwise). Inserts one bridge row per supplier_return stock binding of the return. Internal-owned, no grant.';

-- The one writer of a supplier credit note (R-55): rule 22 counts
-- supplier_credit_notes as a stock write table, so it is written only by a
-- routine whose first statement re-reads the verified assertion. Every
-- value is the stored return header's (the routine's own values) and the
-- purchase's rate source and timestamp (the purchase row is locked).
CREATE OR REPLACE FUNCTION purchase_bridge_credit_note(p_return_id UUID) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor inventory_verified_actor;
  v_rows  INTEGER;
BEGIN
  v_actor := inventory_assertion_current(ARRAY['purchase.return']);
  IF p_return_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM supplier_returns r
                     WHERE r.business_id = v_actor.business_id AND r.id = p_return_id
                       AND r.credit_note_id IS NOT NULL AND r.credit_txn_minor > 0) THEN
    RAISE EXCEPTION 'inventory.source_type_not_authorized: a credit note is written only for its own stored return with a credit' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO supplier_credit_notes (tenant_id, business_id, id, supplier_id, supplier_return_id, currency_code,
                                     original_amount_minor, remaining_amount_minor,
                                     original_carrying_base_amount_minor, remaining_carrying_base_amount_minor,
                                     source_to_base_rate, rate_source, rate_timestamp, issued_on, business_transaction_id, created_by)
  SELECT r.tenant_id, r.business_id, r.credit_note_id, r.supplier_id, r.id, r.currency_code,
         r.credit_txn_minor, r.credit_txn_minor, r.credit_base_minor, r.credit_base_minor,
         r.source_to_base_rate, p.rate_source, p.rate_timestamp, r.document_date, r.business_transaction_id, r.created_by
  FROM supplier_returns r
  JOIN purchases p ON p.business_id = r.business_id AND p.id = r.purchase_id
  WHERE r.business_id = v_actor.business_id AND r.id = p_return_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

COMMENT ON FUNCTION purchase_bridge_credit_note(UUID) IS
  'P3-S5 §2.5, A-11, R-55. The one writer of supplier_credit_notes. Re-verifies the transaction''s consumed purchase.return assertion; p_return_id must be a stored return of the verified business with a credit note id and a positive credit (inventory.source_type_not_authorized otherwise). Inserts the return''s credit note from the stored header (credit_txn, credit_base, supplier, currency, rate, date, trace, actor) and its purchase''s rate source and timestamp. Internal-owned, no grant.';

-- The one writer of the purchase-reversal bridge.
CREATE OR REPLACE FUNCTION purchase_bridge_reversal(p_purchase_id UUID) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor inventory_verified_actor;
  v_rows  INTEGER;
BEGIN
  v_actor := inventory_assertion_current(ARRAY['purchase.reverse']);
  IF p_purchase_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM purchase_reversals r WHERE r.business_id = v_actor.business_id AND r.id = p_purchase_id) THEN
    RAISE EXCEPTION 'inventory.source_type_not_authorized: a reversal bridges only its own stored reversal' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO stock_source_bridge_purchase_reversal (business_id, source_id, source_line_id, movement_kind)
  SELECT b.business_id, b.source_id, b.source_line_id, b.movement_kind
  FROM stock_source_bindings b
  WHERE b.business_id = v_actor.business_id AND b.source_type = 'purchase_reversal' AND b.source_id = p_purchase_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

COMMENT ON FUNCTION purchase_bridge_reversal(UUID) IS
  'P3-S5 §2.5, 0062 R-5. The one writer of stock_source_bridge_purchase_reversal. Re-verifies the transaction''s consumed purchase.reverse assertion; p_purchase_id must be a stored reversal of the verified business (inventory.source_type_not_authorized otherwise). Inserts one bridge row per purchase_reversal stock binding of the reversal. Internal-owned, no grant.';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. purchase_return (§2.5, A-07, A-10, A-11, A-12, A-13, A-17).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION purchase_return(
  p_return_id                  UUID,
  p_purchase_id                UUID,
  p_warehouse_id               UUID,
  p_document_date              DATE,
  p_reason                     TEXT,
  p_credit_note_id             UUID,
  p_carrying_txn_minor         BIGINT,
  p_ap_txn_minor               BIGINT,
  p_ap_base_minor              BIGINT,
  p_credit_txn_minor           BIGINT,
  p_credit_base_minor          BIGINT,
  p_inventory_value_base_minor BIGINT,
  p_ppv_base_minor             BIGINT,
  p_line_ids                   UUID[],
  p_purchase_line_ids          UUID[],
  p_variant_ids                UUID[],
  p_qtys                       NUMERIC[],
  p_carrying_txns              BIGINT[],
  p_values_out                 BIGINT[]
) RETURNS TABLE (
  return_id                    UUID,
  replayed                     BOOLEAN,
  purchase_id                  UUID,
  supplier_id                  UUID,
  warehouse_id                 UUID,
  document_date                DATE,
  reason                       TEXT,
  currency_code                TEXT,
  source_to_base_rate          NUMERIC,
  carrying_txn_minor           BIGINT,
  ap_txn_minor                 BIGINT,
  ap_base_minor                BIGINT,
  ap_dust_base_minor           BIGINT,
  ap_released_before_txn_minor BIGINT,
  credit_txn_minor             BIGINT,
  credit_base_minor            BIGINT,
  inventory_value_base_minor   BIGINT,
  ppv_base_minor               BIGINT,
  business_transaction_id      UUID,
  credit_note_id               UUID,
  credit_note_issued_on        DATE,
  line_id                      UUID,
  line_no                      INTEGER,
  purchase_line_id             UUID,
  variant_id                   UUID,
  qty                          NUMERIC,
  line_carrying_txn_minor      BIGINT,
  unit_cost_base_minor         NUMERIC,
  value_out_base_minor         BIGINT,
  movement_id                  UUID,
  value_delta_base_minor       BIGINT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_actor     inventory_verified_actor;
  v_business  UUID;
  v_tenant    UUID;
  v_trace     UUID;
  v_intent    TEXT;
  v_stored    TEXT;
  v_replay    BOOLEAN;
  v_p         RECORD;
  v_l         RECORD;
  v_sstatus   TEXT;
  v_tz        TEXT;
  v_base_ccy  TEXT;
  v_et        INTEGER;
  v_eb        INTEGER;
  v_n         INTEGER;
  v_i         INTEGER;
  v_pqty      NUMERIC[];
  v_t         NUMERIC[];
  v_before    NUMERIC;
  v_carry     BIGINT[];
  v_c         NUMERIC;
  v_o         NUMERIC;
  v_x         NUMERIC;
  v_ap        NUMERIC;
  v_credit    NUMERIC;
  v_ap_base   NUMERIC;
  v_ap_conv   NUMERIC;
  v_cr_base   NUMERIC;
  v_on_hand   NUMERIC;
  v_avg       NUMERIC;
  v_snap      NUMERIC[];
  v_reqs      inventory_movement_request[];
  v_mv        RECORD;
  v_inv       NUMERIC;
BEGIN
  v_actor := inventory_assertion_consume('purchase.return', inventory_claimed_payload_digest('purchase.return',
    ARRAY['uuid', 'uuid', 'uuid', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer',
          'uuid', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer']
      || ARRAY(SELECT f.t FROM unnest(p_line_ids, p_purchase_line_ids, p_variant_ids, p_qtys, p_carrying_txns, p_values_out)
                                 WITH ORDINALITY AS l(li, pl, v, q, c, o, i)
               CROSS JOIN LATERAL unnest(ARRAY['uuid', 'uuid', 'uuid', 'integer', 'integer', 'integer']) WITH ORDINALITY AS f(t, j)
               ORDER BY l.i, f.j),
    ARRAY[p_return_id::text, p_purchase_id::text, p_warehouse_id::text, to_char(p_document_date, 'YYYYMMDD')]
      || inventory_reason_words(p_reason)
      || ARRAY[p_credit_note_id::text, p_carrying_txn_minor::text, p_ap_txn_minor::text, p_ap_base_minor::text, p_credit_txn_minor::text,
               p_credit_base_minor::text, p_inventory_value_base_minor::text, p_ppv_base_minor::text,
               coalesce(cardinality(p_line_ids), 0)::text]
      || ARRAY(SELECT f.x FROM unnest(p_line_ids, p_purchase_line_ids, p_variant_ids, p_qtys, p_carrying_txns, p_values_out)
                                 WITH ORDINALITY AS l(li, pl, v, q, c, o, i)
               CROSS JOIN LATERAL unnest(ARRAY[l.li::text, l.pl::text, l.v::text, inventory_fixed_text(l.q, 4), l.c::text, l.o::text])
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
  IF p_return_id IS NULL OR p_purchase_id IS NULL OR p_warehouse_id IS NULL OR p_document_date IS NULL THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a return names itself, its purchase, its warehouse and its date' USING ERRCODE = 'P0001';
  END IF;

  -- 3. The document key, then the intent (R-48; A-17: id, purchase,
  --    warehouse, date, reason, and per line id, purchase line, quantity).
  PERFORM pg_advisory_xact_lock(hashtext('daftar.supplier_return_id'), hashtext(p_return_id::text));
  v_intent := inventory_payload_digest('purchase.return', v_tenant, v_business,
    ARRAY['uuid', 'uuid', 'uuid', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer',
          'integer']
      || ARRAY(SELECT f.t FROM unnest(p_line_ids, p_purchase_line_ids, p_qtys) WITH ORDINALITY AS l(li, pl, q, i)
               CROSS JOIN LATERAL unnest(ARRAY['uuid', 'uuid', 'integer']) WITH ORDINALITY AS f(t, j)
               ORDER BY l.i, f.j),
    ARRAY[p_return_id::text, p_purchase_id::text, p_warehouse_id::text, to_char(p_document_date, 'YYYYMMDD')]
      || inventory_reason_words(p_reason)
      || ARRAY[coalesce(cardinality(p_line_ids), 0)::text]
      || ARRAY(SELECT f.x FROM unnest(p_line_ids, p_purchase_line_ids, p_qtys) WITH ORDINALITY AS l(li, pl, q, i)
               CROSS JOIN LATERAL unnest(ARRAY[l.li::text, l.pl::text, inventory_fixed_text(l.q, 4)]) WITH ORDINALITY AS f(x, j)
               ORDER BY l.i, f.j));

  -- 4. The proof, before any other read: an equal intent replays, another
  --    is a conflict.
  SELECT r.intent_sha256 INTO v_stored FROM supplier_returns r WHERE r.business_id = v_business AND r.id = p_return_id;
  IF FOUND THEN
    IF v_stored <> v_intent THEN
      RAISE EXCEPTION 'supplier_return.idempotency_conflict: this return id was already used for another return' USING ERRCODE = 'P0001';
    END IF;
    v_replay := true;
  ELSE
    -- 5. Shape, before any state read.
    v_n := coalesce(cardinality(p_line_ids), 0);
    IF v_n = 0 OR v_n > 200 OR array_ndims(p_line_ids) <> 1 OR array_lower(p_line_ids, 1) <> 1
       OR p_purchase_line_ids IS NULL OR array_ndims(p_purchase_line_ids) <> 1 OR array_lower(p_purchase_line_ids, 1) <> 1
       OR cardinality(p_purchase_line_ids) <> v_n
       OR p_variant_ids IS NULL OR array_ndims(p_variant_ids) <> 1 OR array_lower(p_variant_ids, 1) <> 1 OR cardinality(p_variant_ids) <> v_n
       OR p_qtys IS NULL OR array_ndims(p_qtys) <> 1 OR array_lower(p_qtys, 1) <> 1 OR cardinality(p_qtys) <> v_n
       OR p_carrying_txns IS NULL OR array_ndims(p_carrying_txns) <> 1 OR array_lower(p_carrying_txns, 1) <> 1
       OR cardinality(p_carrying_txns) <> v_n
       OR p_values_out IS NULL OR array_ndims(p_values_out) <> 1 OR array_lower(p_values_out, 1) <> 1 OR cardinality(p_values_out) <> v_n
       OR array_position(p_line_ids, NULL) IS NOT NULL OR array_position(p_purchase_line_ids, NULL) IS NOT NULL
       OR array_position(p_variant_ids, NULL) IS NOT NULL OR array_position(p_qtys, NULL) IS NOT NULL
       OR array_position(p_carrying_txns, NULL) IS NOT NULL OR array_position(p_values_out, NULL) IS NOT NULL
       OR (SELECT count(DISTINCT x.id) FROM unnest(p_line_ids) AS x(id)) <> v_n
       OR (SELECT count(DISTINCT x.id) FROM unnest(p_purchase_line_ids) AS x(id)) <> v_n
       OR EXISTS (SELECT 1 FROM unnest(p_qtys) AS x(q) WHERE x.q <= 0)
       OR EXISTS (SELECT 1 FROM unnest(p_carrying_txns) AS x(c) WHERE x.c < 0)
       OR EXISTS (SELECT 1 FROM unnest(p_values_out) AS x(o) WHERE x.o < 0)
       OR (p_reason IS NOT NULL AND (p_reason <> btrim(p_reason) OR char_length(p_reason) NOT BETWEEN 1 AND 500)) THEN
      RAISE EXCEPTION 'supplier_return.lines_invalid: a return binds 1..200 distinct lines of positive quantity and an optional trimmed reason' USING ERRCODE = 'P0001';
    END IF;
    IF p_carrying_txn_minor IS NULL OR p_ap_txn_minor IS NULL OR p_ap_base_minor IS NULL OR p_credit_txn_minor IS NULL
       OR p_credit_base_minor IS NULL OR p_inventory_value_base_minor IS NULL OR p_ppv_base_minor IS NULL THEN
      RAISE EXCEPTION 'inventory.payload_invalid: a return binds every amount it stores' USING ERRCODE = 'P0001';
    END IF;

    -- 6. Lock step 2a: the purchase FOR UPDATE; received, not reversed.
    SELECT p.status, p.supplier_id, p.currency_code, p.document_date, p.total_txn_minor, p.total_base_minor,
           p.source_to_base_rate, p.rate_source, p.rate_timestamp
      INTO v_p
    FROM purchases p WHERE p.business_id = v_business AND p.id = p_purchase_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'purchase.not_found: the purchase does not exist in this business' USING ERRCODE = 'P0001';
    END IF;
    IF v_p.status <> 'received' THEN
      RAISE EXCEPTION 'supplier_return.purchase_state_invalid: only a received purchase is returned to its supplier' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM purchase_reversals r WHERE r.business_id = v_business AND r.id = p_purchase_id) THEN
      RAISE EXCEPTION 'supplier_return.purchase_reversed: a reversed purchase takes no return' USING ERRCODE = 'P0001';
    END IF;

    -- 7. Lock step 2b: the supplier FOR SHARE (TL-14, AL-40).
    SELECT s.status INTO v_sstatus FROM suppliers s WHERE s.business_id = v_business AND s.id = v_p.supplier_id FOR SHARE;
    IF v_sstatus IS DISTINCT FROM 'active' AND p_credit_txn_minor > 0 THEN
      RAISE EXCEPTION 'supplier_return.supplier_inactive: an inactive supplier takes goods back against its AP, never a new credit' USING ERRCODE = 'P0001';
    END IF;

    -- 8. The dates (the 0058 rule): not before the purchase, not after today.
    SELECT b.timezone, b.base_currency INTO v_tz, v_base_ccy FROM businesses b WHERE b.id = v_business;
    IF p_document_date < v_p.document_date THEN
      RAISE EXCEPTION 'supplier_return.date_before_purchase: a return is dated on or after its purchase' USING ERRCODE = 'P0001';
    END IF;
    IF p_document_date > (now() AT TIME ZONE v_tz)::date THEN
      RAISE EXCEPTION 'supplier_return.document_date_in_future: a return is dated on or before today in the business timezone' USING ERRCODE = 'P0001';
    END IF;

    -- 9. The lines against the purchase, then PM-13 under the row lock.
    v_pqty := ARRAY[]::numeric[];
    v_t    := ARRAY[]::numeric[];
    FOR v_i IN 1 .. v_n LOOP
      SELECT l.variant_id, l.qty, l.net_txn_minor + l.landed_cost_txn_minor AS t INTO v_l
      FROM purchase_lines l
      WHERE l.business_id = v_business AND l.purchase_id = p_purchase_id AND l.id = p_purchase_line_ids[v_i];
      IF NOT FOUND OR v_l.variant_id <> p_variant_ids[v_i] THEN
        RAISE EXCEPTION 'supplier_return.lines_invalid: a return line names a line of its purchase with that line''s variant' USING ERRCODE = 'P0001';
      END IF;
      v_pqty := v_pqty || v_l.qty::numeric;
      v_t    := v_t || v_l.t::numeric;
    END LOOP;
    IF EXISTS (SELECT 1 FROM supplier_return_lines r WHERE r.business_id = v_business AND r.id = ANY (p_line_ids)) THEN
      RAISE EXCEPTION 'supplier_return.lines_invalid: a return line id is already used by another return' USING ERRCODE = 'P0001';
    END IF;
    IF p_credit_note_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM supplier_credit_notes n WHERE n.business_id = v_business AND n.id = p_credit_note_id) THEN
      RAISE EXCEPTION 'inventory.payload_invalid: the credit note id is already used' USING ERRCODE = 'P0001';
    END IF;
    v_carry := ARRAY[]::bigint[];
    FOR v_i IN 1 .. v_n LOOP
      SELECT coalesce(sum(r.qty), 0) INTO v_before FROM supplier_return_lines r
       WHERE r.business_id = v_business AND r.purchase_id = p_purchase_id AND r.purchase_line_id = p_purchase_line_ids[v_i];
      IF v_before + p_qtys[v_i] > v_pqty[v_i] THEN
        RAISE EXCEPTION 'supplier_return.quantity_exceeds_purchased: the returned quantity would exceed the purchased quantity of the line' USING ERRCODE = 'P0001';
      END IF;
      -- A-10(a): cumulative, never negative, exact at a full return.
      v_carry := v_carry || (inventory_half_even(v_t[v_i] * (v_before + p_qtys[v_i]), v_pqty[v_i], 0)
                             - inventory_half_even(v_t[v_i] * v_before, v_pqty[v_i], 0))::bigint;
    END LOOP;

    -- 10. A-10(b)-(d) recomputed from the purchase snapshot (no new FX).
    SELECT sum(x.c) INTO v_c FROM unnest(v_carry) AS x(c);
    v_o      := purchase_ap_outstanding(v_business, p_purchase_id);
    v_x      := v_p.total_txn_minor - v_o;
    v_ap     := least(v_c, v_o);
    v_credit := v_c - v_ap;
    v_ap_base := inventory_half_even(v_p.total_base_minor::numeric * (v_x + v_ap), v_p.total_txn_minor, 0)
                 - inventory_half_even(v_p.total_base_minor::numeric * v_x, v_p.total_txn_minor, 0);
    SELECT c.minor_units INTO v_et FROM currencies c WHERE c.code = v_p.currency_code::text;
    SELECT c.minor_units INTO v_eb FROM currencies c WHERE c.code = v_base_ccy;
    v_ap_conv := inventory_half_even(v_ap * v_p.source_to_base_rate * power(10::numeric, greatest(0, v_eb - v_et)),
                                     power(10::numeric, greatest(0, v_et - v_eb)), 0);
    v_cr_base := inventory_half_even(v_credit * v_p.source_to_base_rate * power(10::numeric, greatest(0, v_eb - v_et)),
                                     power(10::numeric, greatest(0, v_et - v_eb)), 0);
    IF (v_ap > 0 AND v_ap_conv = 0) OR (v_credit > 0 AND v_cr_base = 0) THEN
      RAISE EXCEPTION 'supplier_return.amount_below_base_unit: a returned amount converts to less than one base minor unit' USING ERRCODE = 'P0001';
    END IF;
    IF v_c = 0 AND p_inventory_value_base_minor = 0 THEN
      RAISE EXCEPTION 'supplier_return.value_zero: a return with no carrying value and no inventory value posts nothing' USING ERRCODE = 'P0001';
    END IF;
    IF v_carry IS DISTINCT FROM p_carrying_txns OR v_c <> p_carrying_txn_minor OR v_ap <> p_ap_txn_minor OR v_ap_base <> p_ap_base_minor
       OR v_credit <> p_credit_txn_minor OR v_cr_base <> p_credit_base_minor
       OR (p_credit_note_id IS NULL) <> (v_credit = 0)
       OR (SELECT sum(x.o) FROM unnest(p_values_out) AS x(o)) <> p_inventory_value_base_minor
       OR p_ppv_base_minor <> p_ap_base_minor + p_credit_base_minor - p_inventory_value_base_minor THEN
      RAISE EXCEPTION 'inventory.valuation_changed: the purchase''s carrying value or AP changed since the return was prepared' USING ERRCODE = 'P0001';
    END IF;

    -- 11. Lock step 6 (R-49), then every key holds the quantity.
    PERFORM purchase_lock_stock_keys(p_warehouse_id, p_variant_ids);
    v_snap := ARRAY[]::numeric[];
    FOR v_i IN 1 .. v_n LOOP
      SELECT l.on_hand, l.avg_unit_cost_base_minor INTO v_on_hand, v_avg
      FROM stock_levels l
      WHERE l.business_id = v_business AND l.warehouse_id = p_warehouse_id AND l.variant_id = p_variant_ids[v_i];
      IF NOT FOUND OR v_on_hand < p_qtys[v_i] THEN
        RAISE EXCEPTION 'inventory.insufficient_stock: the warehouse does not hold enough of this variant' USING ERRCODE = 'P0001';
      END IF;
      v_snap := v_snap || v_avg;
    END LOOP;

    -- 12. The header, the lines (the locked key's average as the snapshot),
    --     the credit note iff a credit (A-11).
    INSERT INTO supplier_returns (tenant_id, business_id, id, purchase_id, supplier_id, warehouse_id, currency_code, source_to_base_rate,
                                  document_date, reason, credit_note_id, carrying_txn_minor, ap_txn_minor, ap_base_minor,
                                  ap_dust_base_minor, ap_released_before_txn_minor, credit_txn_minor, credit_base_minor,
                                  inventory_value_base_minor, ppv_base_minor, intent_sha256, business_transaction_id, created_by,
                                  binding_source_id)
    VALUES (v_tenant, v_business, p_return_id, p_purchase_id, v_p.supplier_id, p_warehouse_id, v_p.currency_code, v_p.source_to_base_rate,
            p_document_date, p_reason, p_credit_note_id, v_c::bigint, v_ap::bigint, v_ap_base::bigint,
            (v_ap_base - v_ap_conv)::bigint, v_x::bigint, v_credit::bigint, v_cr_base::bigint,
            p_inventory_value_base_minor, p_ppv_base_minor, v_intent, v_trace, v_actor.actor_user_id,
            p_return_id);
    INSERT INTO supplier_return_lines (tenant_id, business_id, return_id, id, line_no, purchase_id, purchase_line_id, variant_id, qty,
                                       carrying_txn_minor, unit_cost_base_minor, value_out_base_minor)
    SELECT v_tenant, v_business, p_return_id, x.li, x.i::integer, p_purchase_id, x.pl, x.v, x.q, x.c, v_snap[x.i], x.o
    FROM unnest(p_line_ids, p_purchase_line_ids, p_variant_ids, p_qtys, p_carrying_txns, p_values_out) WITH ORDINALITY AS x(li, pl, v, q, c, o, i);
    IF v_credit > 0 THEN
      PERFORM purchase_bridge_credit_note(p_return_id);
    END IF;

    -- 13. The movements: each line leaves the return key at its average (or
    --     flushes it); every stored value and snapshot must be the bound one.
    v_reqs := ARRAY[]::inventory_movement_request[];
    FOR v_i IN 1 .. v_n LOOP
      v_reqs := v_reqs
        || ROW(p_warehouse_id, p_variant_ids[v_i], 'supplier_return', 'supplier_return', p_return_id, p_line_ids[v_i],
               -p_qtys[v_i], NULL, NULL, NULL)::inventory_movement_request;
    END LOOP;
    v_inv := 0;
    FOR v_mv IN SELECT r.ordinal, r.value_delta_base_minor AS val, r.unit_cost_base_minor AS cost FROM inventory_apply_stock_movements(v_reqs) AS r LOOP
      IF -v_mv.val IS DISTINCT FROM p_values_out[v_mv.ordinal] OR v_mv.cost IS DISTINCT FROM v_snap[v_mv.ordinal] THEN
        RAISE EXCEPTION 'inventory.valuation_changed: the stock value changed since the return was prepared' USING ERRCODE = 'P0001';
      END IF;
      v_inv := v_inv - v_mv.val;
    END LOOP;
    IF v_inv <> p_inventory_value_base_minor OR p_ppv_base_minor <> v_ap_base + v_cr_base - v_inv THEN
      RAISE EXCEPTION 'inventory.valuation_changed: the stock value changed since the return was prepared' USING ERRCODE = 'P0001';
    END IF;

    -- 14. The bridge.
    PERFORM purchase_bridge_return(p_return_id);

    -- 15. Audit and outbox (A-20): ids, not amounts.
    INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
    VALUES (v_tenant, v_business, v_actor.actor_user_id, 'purchase.returned', 'supplier_return', p_return_id::text,
            jsonb_build_object('purchaseId', p_purchase_id, 'warehouseId', p_warehouse_id, 'creditNoteId', p_credit_note_id,
                               'lineCount', v_n, 'assertionJti', v_actor.jti, 'business_transaction_id', v_trace));
    INSERT INTO outbox_events (tenant_id, business_id, type, payload)
    VALUES (v_tenant, v_business, 'purchase.returned.v1',
            jsonb_build_object('businessId', v_business, 'returnId', p_return_id, 'purchaseId', p_purchase_id,
                               'warehouseId', p_warehouse_id, 'creditNoteId', p_credit_note_id, 'businessTransactionId', v_trace));
  END IF;

  -- 16. The stored rows: the header, its credit note, each line with its
  --     movement, in line order.
  RETURN QUERY
  SELECT r.id, v_replay, r.purchase_id, r.supplier_id, r.warehouse_id, r.document_date, r.reason, r.currency_code::text,
         r.source_to_base_rate::numeric, r.carrying_txn_minor, r.ap_txn_minor, r.ap_base_minor, r.ap_dust_base_minor,
         r.ap_released_before_txn_minor, r.credit_txn_minor, r.credit_base_minor, r.inventory_value_base_minor, r.ppv_base_minor,
         r.business_transaction_id, n.id, n.issued_on,
         l.id, l.line_no, l.purchase_line_id, l.variant_id, l.qty::numeric, l.carrying_txn_minor, l.unit_cost_base_minor::numeric,
         l.value_out_base_minor, m.id, m.value_delta_base_minor
  FROM supplier_returns r
  JOIN supplier_return_lines l ON l.business_id = r.business_id AND l.return_id = r.id
  LEFT JOIN supplier_credit_notes n ON n.business_id = r.business_id AND n.supplier_return_id = r.id
  LEFT JOIN stock_source_bridge_supplier_return b ON b.business_id = l.business_id AND b.source_id = l.return_id AND b.source_line_id = l.id
  LEFT JOIN stock_movements m
    ON m.business_id = b.business_id AND m.source_type = b.source_type AND m.source_id = b.source_id
   AND m.source_line_id = b.source_line_id AND m.movement_kind = b.movement_kind
  WHERE r.business_id = v_business AND r.id = p_return_id
  ORDER BY l.line_no;
END;
$$;

COMMENT ON FUNCTION purchase_return(UUID, UUID, UUID, DATE, TEXT, UUID, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, UUID[], UUID[], UUID[], NUMERIC[], BIGINT[], BIGINT[]) IS
  'P3-S5 §2.5, A-07, A-10-A-13, A-17. First consumes an invctl/1 assertion of kind purchase.return over its own arguments. Under the daftar.supplier_return_id key, with the intent (id, purchase, warehouse, date, reason, lines): an equal stored intent returns the stored rows (replayed), another is supplier_return.idempotency_conflict. Then the shape (supplier_return.lines_invalid), the purchase FOR UPDATE (purchase.not_found, supplier_return.purchase_state_invalid / purchase_reversed), the supplier FOR SHARE (supplier_return.supplier_inactive when a credit would be issued), the dates (date_before_purchase, document_date_in_future), the lines (lines_invalid, quantity_exceeds_purchased), A-10 recomputed from the purchase snapshot and purchase_ap_outstanding (amount_below_base_unit, value_zero, inventory.valuation_changed), lock step 6 (inventory.insufficient_stock), the header, lines and credit note, the supplier_return movements at the key average (inventory.valuation_changed), the bridge, audit purchase.returned. The supplier_return entry is posted by the caller in the same transaction. EXECUTE: daftar_app only.';

-- ─────────────────────────────────────────────────────────────────────────
-- 4. purchase_reverse (§2.5, A-07, A-09, A-17; R-B1a, R-B2a).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION purchase_reverse(
  p_purchase_id            UUID,
  p_warehouse_id           UUID,
  p_reversal_date          DATE,
  p_reason                 TEXT,
  p_original_entry_id      UUID,
  p_total_value_base_minor BIGINT,
  p_line_ids               UUID[],
  p_variant_ids            UUID[],
  p_qtys                   NUMERIC[],
  p_values                 BIGINT[]
) RETURNS TABLE (
  purchase_id             UUID,
  replayed                BOOLEAN,
  warehouse_id            UUID,
  original_entry_id       UUID,
  reversal_date           DATE,
  reason                  TEXT,
  total_value_base_minor  BIGINT,
  business_transaction_id UUID,
  line_id                 UUID,
  line_no                 INTEGER,
  variant_id              UUID,
  qty                     NUMERIC,
  unit_cost_base_minor    NUMERIC,
  value_base_minor        BIGINT,
  movement_id             UUID,
  value_delta_base_minor  BIGINT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_actor     inventory_verified_actor;
  v_business  UUID;
  v_tenant    UUID;
  v_trace     UUID;
  v_intent    TEXT;
  v_stored    TEXT;
  v_replay    BOOLEAN;
  v_p         RECORD;
  v_st        RECORD;
  v_tz        TEXT;
  v_n         INTEGER;
  v_i         INTEGER;
  v_ids       UUID[];
  v_variants  UUID[];
  v_qtys      NUMERIC[];
  v_values    BIGINT[];
  v_costs     NUMERIC[];
  v_on_hand   NUMERIC;
  v_valuation NUMERIC;
  v_reqs      inventory_movement_request[];
  v_mv        RECORD;
BEGIN
  v_actor := inventory_assertion_consume('purchase.reverse', inventory_claimed_payload_digest('purchase.reverse',
    ARRAY['uuid', 'uuid', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer',
          'uuid', 'integer', 'integer']
      || ARRAY(SELECT f.t FROM unnest(p_line_ids, p_variant_ids, p_qtys, p_values) WITH ORDINALITY AS l(li, v, q, s, i)
               CROSS JOIN LATERAL unnest(ARRAY['uuid', 'uuid', 'integer', 'integer']) WITH ORDINALITY AS f(t, j)
               ORDER BY l.i, f.j),
    ARRAY[p_purchase_id::text, p_warehouse_id::text, to_char(p_reversal_date, 'YYYYMMDD')]
      || inventory_reason_words(p_reason)
      || ARRAY[p_original_entry_id::text, p_total_value_base_minor::text, coalesce(cardinality(p_line_ids), 0)::text]
      || ARRAY(SELECT f.x FROM unnest(p_line_ids, p_variant_ids, p_qtys, p_values) WITH ORDINALITY AS l(li, v, q, s, i)
               CROSS JOIN LATERAL unnest(ARRAY[l.li::text, l.v::text, inventory_fixed_text(l.q, 4), l.s::text]) WITH ORDINALITY AS f(x, j)
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
  IF p_purchase_id IS NULL OR p_warehouse_id IS NULL OR p_reversal_date IS NULL THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a reversal names its purchase, its warehouse and its date' USING ERRCODE = 'P0001';
  END IF;

  -- 3. The document key (the S4 purchase key: a reversal and a receipt of
  --    one purchase serialize), then the intent (R-48; A-17).
  PERFORM pg_advisory_xact_lock(hashtext('daftar.purchase_id'), hashtext(p_purchase_id::text));
  v_intent := inventory_payload_digest('purchase.reverse', v_tenant, v_business,
    ARRAY['uuid', 'uuid', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer'],
    ARRAY[p_purchase_id::text, p_warehouse_id::text, to_char(p_reversal_date, 'YYYYMMDD')] || inventory_reason_words(p_reason));

  -- 4. The purchase FOR UPDATE and the proof, before any other read.
  SELECT p.status, p.warehouse_id, p.document_date, p.total_base_minor INTO v_p
  FROM purchases p WHERE p.business_id = v_business AND p.id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase.not_found: the purchase does not exist in this business' USING ERRCODE = 'P0001';
  END IF;
  SELECT r.intent_sha256 INTO v_stored FROM purchase_reversals r WHERE r.business_id = v_business AND r.id = p_purchase_id;
  IF FOUND THEN
    IF v_stored <> v_intent THEN
      RAISE EXCEPTION 'purchase_reversal.already_reversed: the purchase is already reversed' USING ERRCODE = 'P0001';
    END IF;
    v_replay := true;
  ELSE
    IF v_p.status <> 'received' THEN
      RAISE EXCEPTION 'purchase.state_invalid: only a received purchase is reversed' USING ERRCODE = 'P0001';
    END IF;

    -- 5. Shape: the reason (accounting_post_reversal needs one), the dates.
    IF p_reason IS NULL OR p_reason <> btrim(p_reason) OR char_length(p_reason) NOT BETWEEN 1 AND 500 THEN
      RAISE EXCEPTION 'purchase_reversal.reason_required: a reversal states a trimmed reason of 1..500 characters' USING ERRCODE = 'P0001';
    END IF;
    IF p_reversal_date < v_p.document_date THEN
      RAISE EXCEPTION 'purchase_reversal.date_before_purchase: a reversal is dated on or after its purchase' USING ERRCODE = 'P0001';
    END IF;
    SELECT b.timezone INTO v_tz FROM businesses b WHERE b.id = v_business;
    IF p_reversal_date > (now() AT TIME ZONE v_tz)::date THEN
      RAISE EXCEPTION 'purchase_reversal.date_in_future: a reversal is dated on or before today in the business timezone' USING ERRCODE = 'P0001';
    END IF;

    -- 6. A-09 (a), (b), (c), (e), in that order, under the purchase row lock.
    SELECT s.payment_allocated, s.credit_allocated INTO v_st FROM purchase_settlement_state(v_business, p_purchase_id) AS s;
    IF v_st.payment_allocated THEN
      RAISE EXCEPTION 'purchase_reversal.payment_allocated: a supplier payment is allocated to the purchase' USING ERRCODE = 'P0001';
    END IF;
    IF v_st.credit_allocated THEN
      RAISE EXCEPTION 'purchase_reversal.credit_allocated: a supplier credit is allocated to the purchase' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM supplier_return_lines l WHERE l.business_id = v_business AND l.purchase_id = p_purchase_id) THEN
      RAISE EXCEPTION 'purchase_reversal.returned: a supplier return references the purchase' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM negative_inventory_cost_adjustments a
                WHERE a.business_id = v_business AND a.origin_source_type = 'purchase' AND a.origin_source_id = p_purchase_id) THEN
      RAISE EXCEPTION 'purchase_reversal.deficit_coverage_present: the receipt covered a negative-inventory deficit' USING ERRCODE = 'P0001';
    END IF;

    -- 7. Bound versus stored: the warehouse, the entry, every line with its
    --    stored purchase movement in line order, the total.
    SELECT array_agg(l.id ORDER BY l.line_no), array_agg(l.variant_id ORDER BY l.line_no), array_agg(l.qty::numeric ORDER BY l.line_no),
           array_agg(m.value_delta_base_minor ORDER BY l.line_no), array_agg(m.unit_cost_base_minor::numeric ORDER BY l.line_no)
      INTO v_ids, v_variants, v_qtys, v_values, v_costs
    FROM purchase_lines l
    LEFT JOIN stock_movements m
      ON m.business_id = l.business_id AND m.source_type = 'purchase' AND m.source_id = l.purchase_id
     AND m.source_line_id = l.id AND m.movement_kind = 'purchase'
    WHERE l.business_id = v_business AND l.purchase_id = p_purchase_id;
    v_n := coalesce(cardinality(v_ids), 0);
    IF p_warehouse_id <> v_p.warehouse_id
       OR p_original_entry_id IS DISTINCT FROM accounting_purchase_entry_id(v_business, p_purchase_id)
       OR v_n = 0 OR v_ids IS DISTINCT FROM p_line_ids OR v_variants IS DISTINCT FROM p_variant_ids
       OR v_qtys IS DISTINCT FROM p_qtys OR v_values IS DISTINCT FROM p_values
       OR p_total_value_base_minor IS DISTINCT FROM v_p.total_base_minor THEN
      RAISE EXCEPTION 'purchase_reversal.purchase_changed: the purchase changed since the reversal was prepared' USING ERRCODE = 'P0001';
    END IF;

    -- 8. Lock step 6 (R-49), then A-09 (d) and (f) per line in line order.
    PERFORM purchase_lock_stock_keys(v_p.warehouse_id, v_variants);
    FOR v_i IN 1 .. v_n LOOP
      SELECT l.on_hand, l.valuation_base_minor INTO v_on_hand, v_valuation
      FROM stock_levels l
      WHERE l.business_id = v_business AND l.warehouse_id = v_p.warehouse_id AND l.variant_id = v_variants[v_i];
      IF NOT FOUND OR v_on_hand < v_qtys[v_i] THEN
        RAISE EXCEPTION 'purchase_reversal.insufficient_stock: reversing would drive a stock key negative' USING ERRCODE = 'P0001';
      END IF;
    END LOOP;
    FOR v_i IN 1 .. v_n LOOP
      SELECT l.on_hand, l.valuation_base_minor INTO v_on_hand, v_valuation
      FROM stock_levels l
      WHERE l.business_id = v_business AND l.warehouse_id = v_p.warehouse_id AND l.variant_id = v_variants[v_i];
      IF (v_on_hand - v_qtys[v_i] = 0 AND v_valuation - v_values[v_i] <> 0)
         OR (v_on_hand - v_qtys[v_i] > 0 AND v_valuation - v_values[v_i] < 0) THEN
        RAISE EXCEPTION 'purchase_reversal.valuation_residue: removing the receipt value would leave an unlawful key valuation' USING ERRCODE = 'P0001';
      END IF;
    END LOOP;

    -- 9. The header (its id IS the purchase id; binding = the original
    --    entry), then the lines (their ids ARE the purchase line ids), value
    --    and snapshot copied from the stored purchase movement.
    INSERT INTO purchase_reversals (tenant_id, business_id, id, purchase_id, warehouse_id, original_entry_id, reversal_date, reason,
                                    total_value_base_minor, intent_sha256, business_transaction_id, created_by, binding_source_id)
    VALUES (v_tenant, v_business, p_purchase_id, p_purchase_id, v_p.warehouse_id, p_original_entry_id, p_reversal_date, p_reason,
            v_p.total_base_minor, v_intent, v_trace, v_actor.actor_user_id, p_original_entry_id);
    INSERT INTO purchase_reversal_lines (tenant_id, business_id, reversal_id, id, purchase_id, variant_id, qty, unit_cost_base_minor,
                                         value_base_minor)
    SELECT v_tenant, v_business, p_purchase_id, x.id, p_purchase_id, x.v, x.q, x.c, x.s
    FROM unnest(v_ids, v_variants, v_qtys, v_costs, v_values) AS x(id, v, q, c, s);

    -- 10. The inverse movements: each the exact negation of its pair (R-B1a).
    v_reqs := ARRAY[]::inventory_movement_request[];
    FOR v_i IN 1 .. v_n LOOP
      v_reqs := v_reqs
        || ROW(v_p.warehouse_id, v_variants[v_i], 'purchase_reversal', 'purchase_reversal', p_purchase_id, v_ids[v_i],
               -v_qtys[v_i], NULL, NULL, NULL)::inventory_movement_request;
    END LOOP;
    FOR v_mv IN SELECT r.ordinal, r.value_delta_base_minor AS val FROM inventory_apply_stock_movements(v_reqs) AS r LOOP
      IF v_mv.val IS DISTINCT FROM -p_values[v_mv.ordinal] THEN
        RAISE EXCEPTION 'purchase_reversal.purchase_changed: a reversal movement is not the negation of its purchase movement' USING ERRCODE = 'P0001';
      END IF;
    END LOOP;

    -- 11. The bridge.
    PERFORM purchase_bridge_reversal(p_purchase_id);

    -- 12. Audit and outbox (A-20, R-51): ids, not amounts.
    INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
    VALUES (v_tenant, v_business, v_actor.actor_user_id, 'purchase.reversed', 'purchase', p_purchase_id::text,
            jsonb_build_object('warehouseId', v_p.warehouse_id, 'originalEntryId', p_original_entry_id, 'lineCount', v_n,
                               'assertionJti', v_actor.jti, 'business_transaction_id', v_trace));
    INSERT INTO outbox_events (tenant_id, business_id, type, payload)
    VALUES (v_tenant, v_business, 'purchase.reversed.v1',
            jsonb_build_object('businessId', v_business, 'purchaseId', p_purchase_id, 'originalEntryId', p_original_entry_id,
                               'businessTransactionId', v_trace));
  END IF;

  -- 13. The stored rows: the header and each line with its movement, in the
  --     purchase's line order.
  RETURN QUERY
  SELECT r.purchase_id, v_replay, r.warehouse_id, r.original_entry_id, r.reversal_date, r.reason, r.total_value_base_minor,
         r.business_transaction_id, l.id, pl.line_no, l.variant_id, l.qty::numeric, l.unit_cost_base_minor::numeric, l.value_base_minor,
         m.id, m.value_delta_base_minor
  FROM purchase_reversals r
  JOIN purchase_reversal_lines l ON l.business_id = r.business_id AND l.reversal_id = r.id
  JOIN purchase_lines pl ON pl.business_id = l.business_id AND pl.purchase_id = l.purchase_id AND pl.id = l.id
  LEFT JOIN stock_source_bridge_purchase_reversal b ON b.business_id = l.business_id AND b.source_id = l.reversal_id AND b.source_line_id = l.id
  LEFT JOIN stock_movements m
    ON m.business_id = b.business_id AND m.source_type = b.source_type AND m.source_id = b.source_id
   AND m.source_line_id = b.source_line_id AND m.movement_kind = b.movement_kind
  WHERE r.business_id = v_business AND r.id = p_purchase_id
  ORDER BY pl.line_no;
END;
$$;

COMMENT ON FUNCTION purchase_reverse(UUID, UUID, DATE, TEXT, UUID, BIGINT, UUID[], UUID[], NUMERIC[], BIGINT[]) IS
  'P3-S5 §2.5, A-07, A-09, A-17; R-B1a, R-B2a. First consumes an invctl/1 assertion of kind purchase.reverse over its own arguments. Under the daftar.purchase_id key, with the intent (purchase, warehouse, date, reason): the purchase FOR UPDATE (purchase.not_found); a stored reversal with an equal intent returns the stored rows (replayed), another is purchase_reversal.already_reversed; purchase.state_invalid; purchase_reversal.reason_required, date_before_purchase, date_in_future; A-09 (a) payment_allocated, (b) credit_allocated, (c) returned, (e) deficit_coverage_present; the bound warehouse, original entry, lines and total against the stored ones (purchase_reversal.purchase_changed); lock step 6, then (d) insufficient_stock and (f) valuation_residue per line; the header and lines; the purchase_reversal movements, each the exact negation of its purchase movement; the bridge; audit purchase.reversed. The caller then posts accounting_post_reversal of the original entry in the same transaction. EXECUTE: daftar_app only.';

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Privileges, then the ownership transfer (the 0062/0064 order).
-- ─────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION purchase_lock_stock_keys(UUID, UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION purchase_bridge_return(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION purchase_bridge_credit_note(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION purchase_bridge_reversal(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION purchase_return(UUID, UUID, UUID, DATE, TEXT, UUID, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, UUID[], UUID[], UUID[], NUMERIC[], BIGINT[], BIGINT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION purchase_reverse(UUID, UUID, DATE, TEXT, UUID, BIGINT, UUID[], UUID[], NUMERIC[], BIGINT[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION purchase_return(UUID, UUID, UUID, DATE, TEXT, UUID, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, UUID[], UUID[], UUID[], NUMERIC[], BIGINT[], BIGINT[]) TO daftar_app;
GRANT EXECUTE ON FUNCTION purchase_reverse(UUID, UUID, DATE, TEXT, UUID, BIGINT, UUID[], UUID[], NUMERIC[], BIGINT[]) TO daftar_app;

GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;

ALTER FUNCTION purchase_lock_stock_keys(UUID, UUID[]) OWNER TO daftar_inventory_internal;
ALTER FUNCTION purchase_bridge_return(UUID) OWNER TO daftar_inventory_internal;
ALTER FUNCTION purchase_bridge_credit_note(UUID) OWNER TO daftar_inventory_internal;
ALTER FUNCTION purchase_bridge_reversal(UUID) OWNER TO daftar_inventory_internal;
ALTER FUNCTION purchase_return(UUID, UUID, UUID, DATE, TEXT, UUID, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, UUID[], UUID[], UUID[], NUMERIC[], BIGINT[], BIGINT[]) OWNER TO daftar_inventory_internal;
ALTER FUNCTION purchase_reverse(UUID, UUID, DATE, TEXT, UUID, BIGINT, UUID[], UUID[], NUMERIC[], BIGINT[]) OWNER TO daftar_inventory_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. Registrations (§2.6): the two kinds and the two op→movement pairs.
--    Last, so no kind names a routine that does not exist yet.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO inventory_operation_kinds (op_code, registered_by) VALUES
  ('purchase.return', 'P3-S5'), ('purchase.reverse', 'P3-S5');
INSERT INTO inventory_operation_movement_kinds (op_code, movement_kind, registered_by) VALUES
  ('purchase.return', 'supplier_return', 'P3-S5'), ('purchase.reverse', 'purchase_reversal', 'P3-S5');

-- ─────────────────────────────────────────────────────────────────────────
-- 7. Refuse to commit unless the end state is exactly right (0066-E, §2.8).
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
    'purchase_return(uuid,uuid,uuid,date,text,uuid,bigint,bigint,bigint,bigint,bigint,bigint,bigint,uuid[],uuid[],uuid[],numeric[],bigint[],bigint[])'::regprocedure,
    'purchase_reverse(uuid,uuid,date,text,uuid,bigint,uuid[],uuid[],numeric[],bigint[])'::regprocedure];
  c_helpers CONSTANT REGPROCEDURE[] := ARRAY[
    'purchase_lock_stock_keys(uuid,uuid[])'::regprocedure,
    'purchase_bridge_return(uuid)'::regprocedure,
    'purchase_bridge_credit_note(uuid)'::regprocedure,
    'purchase_bridge_reversal(uuid)'::regprocedure];
  c_reads   CONSTANT REGPROCEDURE[] := ARRAY[
    'purchase_ap_outstanding(uuid,uuid)'::regprocedure,
    'purchase_settlement_state(uuid,uuid)'::regprocedure];
BEGIN
  -- (1) The operation registry: the S1 three, S3 seven, S4 seven, S5 two.
  SELECT string_agg(k.op_code || ':' || k.registered_by, ', ' ORDER BY k.op_code) INTO v_detail FROM inventory_operation_kinds k;
  IF v_detail IS DISTINCT FROM
     'inventory.adjust:P3-S3, inventory.configure_product:P3-S1, inventory.damage:P3-S3, inventory.opening:P3-S3, '
     'inventory.stocktake_count:P3-S3, inventory.stocktake_finalize:P3-S3, inventory.stocktake_open:P3-S3, inventory.transfer:P3-S3, '
     'purchase.cancel:P3-S4, purchase.draft:P3-S4, purchase.receive:P3-S4, purchase.return:P3-S5, purchase.reverse:P3-S5, '
     'structure.associate_warehouse_branch:P3-S1, structure.dissociate_warehouse_branch:P3-S1, '
     'supplier.archive:P3-S4, supplier.create:P3-S4, supplier.reactivate:P3-S4, supplier.update:P3-S4' THEN
    RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: inventory_operation_kinds is not the S1 three, S3 seven, S4 seven and S5 two, found %', v_detail;
  END IF;

  -- (2) The six S3 pairs, the two S4 pairs and exactly the two S5 pairs.
  SELECT string_agg(m.op_code || '>' || m.movement_kind || ':' || m.registered_by, ', ' ORDER BY m.op_code, m.movement_kind) INTO v_detail
  FROM inventory_operation_movement_kinds m;
  IF v_detail IS DISTINCT FROM
     'inventory.adjust>adjustment:P3-S3, inventory.damage>damage:P3-S3, inventory.opening>inventory_opening:P3-S3, '
     'inventory.stocktake_finalize>stocktake:P3-S3, inventory.transfer>transfer_in:P3-S3, inventory.transfer>transfer_out:P3-S3, '
     'purchase.receive>negative_inventory_cost_adjustment:P3-S4, purchase.receive>purchase:P3-S4, '
     'purchase.return>supplier_return:P3-S5, purchase.reverse>purchase_reversal:P3-S5' THEN
    RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: inventory_operation_movement_kinds is not exactly the S3, S4 and S5 mappings, found %', v_detail;
  END IF;

  -- (3) The two entry routines and four helpers: internal-owned DEFINER
  --     with the pinned path, exactly six S5 internal routines.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_detail
  FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
  WHERE p.oid = ANY (c_entry || c_helpers)
    AND (r.rolname <> 'daftar_inventory_internal' OR NOT p.prosecdef
         OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']);
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: routine(s) not internal-owned SECURITY DEFINER with the pinned path: %', v_detail;
  END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.oid = ANY (c_entry || c_helpers)) <> 6
     OR (SELECT count(*) FROM pg_proc p WHERE p.proname IN ('purchase_return', 'purchase_reverse', 'purchase_lock_stock_keys',
                                                            'purchase_bridge_return', 'purchase_bridge_credit_note',
                                                            'purchase_bridge_reversal')) <> 6 THEN
    RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: the S5 routines are not exactly the two entry routines and four helpers';
  END IF;

  -- (4) daftar_app reaches each entry routine, nobody else does; nobody
  --     reaches a helper; the two read functions are migrator-owned INVOKER,
  --     executable by exactly daftar_app and daftar_inventory_internal.
  FOREACH v_proc IN ARRAY c_entry LOOP
    IF NOT has_function_privilege('daftar_app', v_proc, 'EXECUTE') THEN
      RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: daftar_app cannot reach %', v_proc;
    END IF;
    FOREACH v_role IN ARRAY c_runtime || ARRAY['daftar_accounting_internal'] LOOP
      IF has_function_privilege(v_role, v_proc, 'EXECUTE') THEN
        RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: % may call %', v_role, v_proc;
      END IF;
    END LOOP;
    SELECT string_agg(x.grantee::regrole::text, ',' ORDER BY x.grantee::regrole::text) INTO v_detail
    FROM pg_proc p, aclexplode(p.proacl) x
    WHERE p.oid = v_proc AND x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner;
    IF v_detail IS DISTINCT FROM 'daftar_app' THEN
      RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: % must be executable by daftar_app only, found %', v_proc, v_detail;
    END IF;
  END LOOP;
  FOREACH v_proc IN ARRAY c_helpers LOOP
    FOREACH v_role IN ARRAY c_runtime || ARRAY['daftar_app', 'daftar_accounting_internal'] LOOP
      IF has_function_privilege(v_role, v_proc, 'EXECUTE') THEN
        RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: % may call the helper %', v_role, v_proc;
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
                WHERE p.oid = v_proc AND x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner) THEN
      RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: the helper % has an EXECUTE grantee', v_proc;
    END IF;
  END LOOP;
  FOREACH v_proc IN ARRAY c_reads LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p
                WHERE p.oid = v_proc
                  AND (p.prosecdef OR p.provolatile <> 's' OR p.proowner::regrole::text <> current_user
                       OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp'])) THEN
      RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: % is not a migrator-owned pinned STABLE INVOKER function', v_proc;
    END IF;
    SELECT string_agg(x.grantee::regrole::text, ',' ORDER BY x.grantee::regrole::text) INTO v_detail
    FROM pg_proc p, aclexplode(p.proacl) x
    WHERE p.oid = v_proc AND x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner;
    IF v_detail IS DISTINCT FROM 'daftar_app,daftar_inventory_internal' THEN
      RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: % must be executable by daftar_app and daftar_inventory_internal only, found %', v_proc, v_detail;
    END IF;
    FOREACH v_role IN ARRAY c_runtime || ARRAY['daftar_accounting_internal'] LOOP
      IF has_function_privilege(v_role, v_proc, 'EXECUTE') THEN
        RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: % may call %', v_role, v_proc;
      END IF;
    END LOOP;
  END LOOP;

  -- (5) The first statement of every entry routine consumes the assertion;
  --     every helper opens with the re-verification (rule 22 at deploy time).
  FOREACH v_proc IN ARRAY c_entry LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_proc;
    v_first := btrim(split_part(substr(v_src, position(E'\nBEGIN\n' IN v_src) + 7), ';', 1));
    IF position(E'\nBEGIN\n' IN v_src) = 0 OR v_first !~ '^v_actor := inventory_assertion_consume\(' THEN
      RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: % does not consume its assertion as its first statement', v_proc;
    END IF;
  END LOOP;
  FOREACH v_proc IN ARRAY c_helpers LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_proc;
    v_first := btrim(split_part(substr(v_src, position(E'\nBEGIN\n' IN v_src) + 7), ';', 1));
    IF position(E'\nBEGIN\n' IN v_src) = 0 OR v_first !~ '^v_actor := inventory_assertion_current\(ARRAY\[' THEN
      RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: % does not re-verify the assertion as its first statement', v_proc;
    END IF;
  END LOOP;

  -- (6) R-26/R-48: the document key precedes the intent read and the row
  --     reads; in purchase_return the replay read of supplier_returns
  --     precedes the first read of purchases.
  FOREACH v_proc IN ARRAY c_entry LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_proc;
    v_key  := greatest(position('PERFORM pg_advisory_xact_lock(hashtext(''daftar.supplier_return_id''), hashtext(p_return_id::text));' IN v_src),
                       position('PERFORM pg_advisory_xact_lock(hashtext(''daftar.purchase_id''), hashtext(p_purchase_id::text));' IN v_src));
    v_read := position('v_intent :=' IN v_src);
    IF v_key = 0 OR v_read = 0 OR v_key > v_read
       OR v_key > position(' FOR UPDATE;' IN v_src) OR position(' FOR UPDATE;' IN v_src) < v_read THEN
      RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: % does not take its document key before its intent and row reads (R-26)', v_proc;
    END IF;
  END LOOP;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = c_entry[1];
  IF position('FROM supplier_returns r WHERE r.business_id = v_business AND r.id = p_return_id' IN v_src) = 0
     OR position('FROM supplier_returns r WHERE r.business_id = v_business AND r.id = p_return_id' IN v_src)
        > position('FROM purchases' IN v_src) THEN
    RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: purchase_return does not prove its replay before it reads the purchase';
  END IF;

  -- (7) stock_source_types unchanged since 0065, and fully guarded.
  IF (SELECT string_agg(t.source_type || ':' || t.registered_by, ',' ORDER BY t.source_type) FROM stock_source_types t)
     IS DISTINCT FROM 'inventory_adjustment:P3-S3,inventory_opening:P3-S3,inventory_transfer:P3-S3,'
                      'negative_inventory_cost_adjustment:P3-S4,purchase:P3-S4,purchase_reversal:P3-S5,stocktake:P3-S3,'
                      'supplier_return:P3-S5' THEN
    RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: stock_source_types changed after 0065';
  END IF;
  IF (SELECT count(*) FROM inventory_stock_source_guard_gaps()) <> 0 THEN
    RAISE EXCEPTION 'inventory.source_guard_missing: a registered stock source type lacks a guard';
  END IF;

  -- (8) No CREATE left on public for either internal principal.
  IF has_schema_privilege('daftar_inventory_internal', 'public', 'CREATE')
     OR has_schema_privilege('daftar_accounting_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: an internal principal still holds CREATE on schema public';
  END IF;
END $$;
