-- 0093 — C6 / INV-INV-05, INV-INV-07: A TRANSFER CONSERVES VALUE, AND NOW A
-- GUARD SAYS SO.
--
-- WHAT WAS MEASURED, on origin/main, before this file existed:
--
--   * `stock_source_complete_inventory_transfer` (0061:901-925) demands one
--     `transfer_out` and one `transfer_in` matching warehouse, variant and
--     QUANTITY. Nothing outside the routine is bound on VALUE: the inbound
--     value is an assignment inside it, `v_value := -v_pair.val`
--     (0060_inventory_stock_primitive.sql:374).
--   * The guard registry `inventory_stock_source_guard_gaps()` is redefined by
--     six migrations and its EFFECTIVE definition is 0077. There, NINE
--     document types carry a `source_complete` arm and SEVEN carry a
--     `value_complete` arm. Two lack one: `sale`, which 0077:84 and 0077:497
--     DECLARE and explain -- its subject would be a stored cost total on
--     `sales`, the exact column P4-AL-05 and the no-authoritative-balance
--     guard refuse -- and `inventory_transfer`, which nothing declares.
--   * `inventory_transfers` (0061:506) carries no value column either, so the
--     existing arm's shape -- a document's stored total against the sum of its
--     movements (`inventory_source_value_complete()`, 0061:1126) -- is not
--     available here, and adding such a column is what the sealed rule
--     forbids.
--
-- SO THE ARM IS A DIFFERENT SHAPE, and it needs no column: the value deltas of
-- EACH TRANSFER LINE's own movements must SUM TO ZERO. That is the conservation
-- the quantity trigger cannot see, and a line written with an inbound value
-- that is not the negative of its outbound value is refused by name rather
-- than passing because both quantities matched.
--
-- PER LINE, AND THE DISTINCTION IS NOT PEDANTRY. The first form of this guard
-- summed over the whole DOCUMENT, which the card never asked for and which the
-- trigger's own name contradicts. On a two-line transfer -- `lines` is an array
-- in `inventory-movements.schemas.ts`, so an ordinary shape and not a rare one
-- -- line A written -100/+150 and line B written -100/+50 sum to ZERO across
-- the document. The completeness guard accepts each line, because quantities
-- match line by line, and a document-wide sum then stays SILENT while one
-- variant's valuation is inflated by 50 and another's is drained by 50, with
-- not one unit moved off a shelf. Cost of sales is then measured on a
-- manufactured average. The independent review of 798d6cdb found it.
--
-- WHAT THIS FILE DOES NOT DO: it does not edit a sealed migration. 0077's
-- registry function is READ and replaced by `CREATE OR REPLACE` here, with
-- exactly two insertions -- the new guard's prosrc digest and the row that
-- makes the gap guard demand the new trigger -- so the next migration's
-- end-state assertion keeps covering it.

-- §D bracket (measured from 0077:508 and 0077:819): the role that will own
-- the routine needs CREATE on the schema while it owns it, and the grant is
-- withdrawn after the last transfer in this file. The static guard
-- `inventory-definer-contract` refuses a hand-over without both halves, and
-- it refused THIS file until they were added.
GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;

CREATE OR REPLACE FUNCTION inventory_transfer_value_conserved() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_sum  NUMERIC;
  v_legs BIGINT;
BEGIN
  -- A transfer moves value between two warehouses: it may not create or
  -- destroy any.
  --
  -- IT FIRES PER LINE, AND THAT IS NOT A DETAIL. On the header it fired FIRST
  -- -- the header is inserted before the lines, so its deferred event is
  -- queued first -- and it then answered for refusals that belong to another
  -- mechanism: `inventory-s3-transfer.test.ts` T-05 (the nine-state vector,
  -- H-6) asserts that an incomplete transfer is refused BY ITS NAMED
  -- MECHANISM, `inventory.source_movement_set_incomplete`, and CI 43831620333
  -- measured three of those cases reporting THIS law's code instead. An
  -- incomplete set has an unbalanced value too, so both guards were right and
  -- the wrong one spoke. Hung off `inventory_transfer_lines` with a name that
  -- sorts after `stock_source_complete_inventory_transfer`, PostgreSQL fires
  -- the completeness guard first for each line (triggers on the same event
  -- fire in alphabetical order by name) and this law speaks only about a set
  -- that is complete. The claim is a SUM over the LINE's movements and not a
  -- comparison against a stored total, because `inventory_transfers` carries
  -- no value column and may not carry one -- the same rule that leaves the
  -- `sale` source without a value_complete arm (P4-AL-05 and the
  -- no-authoritative-balance guard refuse exactly such a column).
  -- AND IT SPEAKS ONLY ABOUT A SET THAT HAS ITS LEGS, which is the second
  -- thing CI taught this guard. Run 43843250451 failed one case and one only:
  -- `inventory-s3-transfer.test.ts` T-05's NEGATIVE CONTROL for case 1 --
  -- "with stock_source_complete_inventory_transfer dropped, the half transfer
  -- would commit" -- and it failed because THIS law refused the half transfer
  -- in that mechanism's absence. A one-legged transfer is value-unbalanced
  -- too, so the two laws genuinely overlap on that input, and a control that
  -- proves the completeness guard is what refuses cannot do its work while
  -- another law refuses the same row.
  --
  -- THE SUBJECT IS THIS LINE, not the document. The trigger fires FOR EACH ROW
  -- on `inventory_transfer_lines` and is named `..._per_line`; summing the
  -- document here made the body disagree with its own name, with the card, and
  -- with the harm the card describes -- a two-line transfer can net to zero
  -- across the document while each line is out by the same amount in opposite
  -- directions, and nothing on a shelf has moved.
  --
  -- So the precondition is structural and coarse ON PURPOSE: exactly two
  -- movements for THIS line, or this law has nothing to say. It is NOT a copy
  -- of the completeness law -- that one also matches each leg's kind, warehouse
  -- and quantity, and none of that is repeated here. Where the count does not
  -- match, the set is incomplete and `source_movement_set_incomplete` owns the
  -- refusal; and that guard pins two legs PER LINE (0061:912-923), so where
  -- this law speaks at all the count is two.
  SELECT count(*) INTO v_legs
  FROM stock_source_bridge_inventory_transfer b
  JOIN stock_movements m ON m.business_id = b.business_id AND m.source_type = b.source_type AND m.source_id = b.source_id
                        AND m.source_line_id = b.source_line_id AND m.movement_kind = b.movement_kind
  WHERE b.business_id = NEW.business_id AND b.source_id = NEW.transfer_id AND b.source_line_id = NEW.id;
  IF v_legs <> 2 THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(sum(m.value_delta_base_minor), 0) INTO v_sum
  FROM stock_source_bridge_inventory_transfer b
  JOIN stock_movements m ON m.business_id = b.business_id AND m.source_type = b.source_type AND m.source_id = b.source_id
                        AND m.source_line_id = b.source_line_id AND m.movement_kind = b.movement_kind
  WHERE b.business_id = NEW.business_id AND b.source_id = NEW.transfer_id AND b.source_line_id = NEW.id;
  IF v_sum IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION 'inventory.transfer_value_not_conserved: a transfer line moves value between warehouses and must not create or destroy it' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION inventory_transfer_value_conserved() IS
  'C6 (INV-INV-05, INV-INV-07): the value deltas of EACH LINE of an inventory transfer sum to zero, per line and not merely across the document. A deferred constraint trigger, because the movements are written after the header in the same transaction. No stored total is read: inventory_transfers carries no value column and may not carry one (P4-AL-05).';

REVOKE ALL ON FUNCTION inventory_transfer_value_conserved() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER transfer_value_conserved_per_line
  AFTER INSERT ON inventory_transfer_lines DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION inventory_transfer_value_conserved();

-- Grants and the trigger first, ownership last ([[daftar-grant-before-owner]]).
ALTER FUNCTION inventory_transfer_value_conserved() OWNER TO daftar_inventory_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;

CREATE OR REPLACE FUNCTION inventory_stock_source_guard_gaps()
RETURNS TABLE (source_type TEXT, missing TEXT)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_type     TEXT;
  v_bridge   REGCLASS;
  v_bind     REGCLASS := 'public.stock_source_bindings'::regclass;
  v_fn       REGPROCEDURE;
  v_s3       BOOLEAN;
  v_s4       BOOLEAN;
  v_s5       BOOLEAN;
  v_s6       BOOLEAN;
  v_line_tbl REGCLASS;
  v_line_key TEXT[];
  v_g        RECORD;
  -- SHA-256 (hex) of each S3 guard function's prosrc, recorded at migration time
  -- (0061), then of each S4 guard function's prosrc (0063), then of each S5
  -- guard function's prosrc (0065).
  c_digest   CONSTANT JSONB := '{
    "stock_ledger_append_only()": "2b6be55eba2569a34816d6ad4154ece7138500f58f0f58253c52d2a891e1f01a",
    "stock_binding_requires_inventory_transfer()": "f8a0aaa2ba51e777ff3992750237601ebfb927636a55f1a1816a507ff2d2d430",
    "stock_binding_requires_inventory_adjustment()": "3e54199bec0101135d4ea687c858dc514244a6cbd4f4e2aa7225f293b34dcdba",
    "stock_binding_requires_stocktake()": "4695f38364e51b8f19fb97627b94123e41792fb9e0889b6613b3734e305ad4f9",
    "stock_binding_requires_inventory_opening()": "7a8363f5b004f9853c935eca03339bfabc30c340cfbef93e7d56fe9d19b5b59d",
    "stock_source_complete_inventory_transfer()": "d4ca51a9d61eb6fdba9be52f6c3e9fa2fc4b4f1da67fdc792ed5e889ac13d9bc",
    "stock_source_complete_inventory_adjustment()": "893163f6bcfd133c4e5e270647870dec1c9ce9a017952e66a1c5aa9d767702af",
    "stock_source_complete_stocktake()": "0e192f181e2512b74051c668ccfbaf4549ff2793008a8581ed992e0c65c602d5",
    "stock_source_complete_stocktake_header()": "3bd8424be82ab8aa94707d3f1b2d04ad74abacaea8ae32f860ea16aaa4716c15",
    "stock_source_complete_inventory_opening()": "71b4f35571d748bf76b7a9b2b8bfa407af755dc4420c39e26532f9905659686f",
    "stock_source_freeze_inventory_transfer()": "e70ba4c9c0c87a4b76050f77afb9e36d8bfac7195439d2438871d2822f488d45",
    "stock_source_freeze_inventory_adjustment()": "049e3e439c8d4e33a79bc932c937dc45b824b79718587604e627a1cfa2fb7c4a",
    "stock_source_freeze_stocktake()": "2e29261988cc961a5c9a052709b78a32a6fd49509d263875b97527992b905717",
    "stock_source_freeze_inventory_opening()": "507f40e4d0d472a6e787865b5a779c6f69ecfb651875ba14df57fe8fd8f54cbe",
    "inventory_source_header_guard()": "4d646c5d5db4aa49e544033d02cc24fd007899dab833637cb8020a49611c2828",
    "inventory_source_value_complete()": "908bc14db1094becba6402c0171237a5d91481874a55dd16eef17894cc59d5d4",
    "stock_binding_requires_purchase()": "2f4a78a635df4ea85a0eb9a898752c80860badd64a68ce4038a3c081d9075e3f",
    "stock_binding_requires_negative_inventory_cost_adjustment()": "bf707fa32e584fb9e01f88a4766f8788dc32f2b96b5d59fd50ed9861e8b75cfa",
    "stock_source_complete_purchase()": "7a49c422e4e56c628ac1b4e6e45d8af0c9dcdc049bcc614e0f7829f80a050b58",
    "stock_source_complete_purchase_header()": "28f7f06240e62911f7b68efa3256e753443bf67c4ecf893ab174895a79582154",
    "stock_source_complete_negative_inventory_cost_adjustment()": "6c6522559afc458e9fd9ce230214372b5f95c65938ca869ce435f326dd4fd19f",
    "stock_source_freeze_purchase()": "97adaaaa95a5b2c18e80d34ea26a4eee5e397e1bf25dd727ddfc9a0cf86f31ab",
    "purchase_header_guard()": "09da86dc079e39ef7a60f1625c364b6e4644aad9b795b87245cc6d6749a3db4c",
    "purchase_source_value_complete()": "033535f199feae9d1747772d3cf32cfbe9f07979fa05f48471ac73475b4e7a9e",
    "purchase_landed_cost_freeze()": "3eda69587e6a9a8046ff1d7852e1ac7d0dec0d05ae633d1b78663a091634379a",
    "purchase_allocations_consistent()": "ac783691817646b8ac3528766a3203ec30c3f594a6f997b7f5779504ab625748",
    "negative_deficit_coverage_same_transaction()": "77e09d0b7e15b2368ca2ace6f7de5933964777c5b3e5a1f58fb5723eb156b663",
    "negative_inventory_deficits_coverage_guard()": "a6fb57abb419fea3eb0f75c1c81ee0189226c5354fca7fe6197fb0f1ae76a925",
    "negative_inventory_deficits_coverage_consistent()": "883da444f892ddbb0ad16f5d77c124057f46304e966262b80a63c3bfc1867b6b",
    "stock_binding_requires_supplier_return()": "d9b6af529194f9378353b3d3b4b519f0a2fb39cf9bef9e9223b4a3b4512b626d",
    "stock_binding_requires_purchase_reversal()": "945338f56ba61ec93b980a7053b10478eec00da32a2bdcecb80cac87b3b7b40e",
    "stock_source_complete_supplier_return()": "bfbcfd7696131c5222a277a7cdcffedfa221b1dd69b9036614d5a00ece553679",
    "stock_source_complete_supplier_return_header()": "0257473d6c4e53e3ffb415905cdf499e41bf29bc8fa34b1d1be9a9c18185aea4",
    "supplier_return_value_complete()": "851cbdf05fdacd8ca2277e9b7aedcb76fc9cdb1d6cf6aa62b0100bc3a5776fe2",
    "supplier_return_quantity_bound()": "1ac8224efb6b2f7c036d57207afcbfd08c7e469d745b3657271a0eb2cbadbe26",
    "stock_source_complete_purchase_reversal()": "61d96c8dfe2c30fb6d7689bf771bd677ce03a2541beb33c48b4d1476b1efdcba",
    "stock_source_complete_purchase_reversal_header()": "24b99c06756f9acd5190d12d1f693cb90c9ab023480a4172c382ccd98e6686e1",
    "purchase_reversal_value_complete()": "55d5d4f779fe497263a70445a869aa8f9fc1e235fc350f389c07ceccab72e3e0",
    "supplier_return_detail_same_transaction()": "68a8c04daa668ef1574f6e7109ca1756a33310005d82455118047f328717aa49",
    "purchase_reversal_detail_same_transaction()": "e408924187c911f6b1d61f46ce1ae7e6ff965f2807562c9cfaa176508c5838bf",
    "supplier_credit_note_guard()": "a21031b39170a8cec024de3947b8de6ee70c7def674235fcdbff01f27d99177e",
    "stock_binding_requires_sale()": "740afbde38f3497a3850f5c76cd61a51ded5fd047e2ac879fa48cb907238615d",
    "stock_source_complete_sale()": "0d66d946ae01292345ded8215710f96283e7cb60ad8a6cb3a8219a7cec96ba5b",
    "stock_source_complete_sale_header()": "6aa21ff188d72c53cc887c0a88e5c302953f78d58e7dc95a0909b01a830c89b1",
    "sale_header_guard()": "b5d218c0114b7ea43e9e84fe4470f383be2a5c9d86486749e1312126d7a6bcc3",
    "inventory_transfer_value_conserved()": "49e7db9679170a7cf272ff61e8eca14a731cb5f89b0f87cc843817b4b5f6b725"
  }';
BEGIN
  FOR v_type IN SELECT t.source_type FROM stock_source_types t ORDER BY t.source_type LOOP
    v_s3 := v_type IN ('inventory_adjustment', 'inventory_opening', 'inventory_transfer', 'stocktake');
    v_s4 := v_type IN ('negative_inventory_cost_adjustment', 'purchase');
    v_s5 := v_type IN ('purchase_reversal', 'supplier_return');
    v_s6 := v_type IN ('sale');
    v_line_tbl := NULL;
    v_line_key := NULL;
    SELECT to_regclass('public.' || e.tbl), e.cols INTO v_line_tbl, v_line_key
    FROM (VALUES ('inventory_transfer',   'inventory_transfer_lines',   ARRAY['business_id', 'transfer_id', 'id']),
                 ('inventory_adjustment', 'inventory_adjustment_lines', ARRAY['business_id', 'adjustment_id', 'id']),
                 ('stocktake',            'stocktake_lines',            ARRAY['business_id', 'stocktake_id', 'id']),
                 ('inventory_opening',    'inventory_opening_lines',    ARRAY['business_id', 'opening_id', 'id']),
                 ('purchase',             'purchase_lines',             ARRAY['business_id', 'purchase_id', 'id']),
                 ('negative_inventory_cost_adjustment', 'negative_deficit_coverages', ARRAY['business_id', 'adjustment_id', 'id']),
                 ('supplier_return',      'supplier_return_lines',      ARRAY['business_id', 'return_id', 'id']),
                 ('purchase_reversal',    'purchase_reversal_lines',    ARRAY['business_id', 'reversal_id', 'id']),
                 ('sale',                 'sale_items',                 ARRAY['business_id', 'sale_id', 'id'])) AS e(st, tbl, cols)
    WHERE e.st = v_type;
    v_bridge := to_regclass('public.stock_source_bridge_' || v_type);
    IF v_bridge IS NULL OR NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = v_bridge AND c.relkind = 'r') THEN
      source_type := v_type; missing := 'bridge'; RETURN NEXT;
    ELSE
      IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = v_bridge AND c.relrowsecurity AND c.relforcerowsecurity) THEN
        source_type := v_type; missing := 'bridge_rls'; RETURN NEXT;
      END IF;
      IF (SELECT array_agg(a.attname::text ORDER BY k.ord)
            FROM pg_constraint c
            CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
           WHERE c.conrelid = v_bridge AND c.contype = 'p')
         IS DISTINCT FROM ARRAY['business_id', 'source_id', 'source_line_id', 'movement_kind'] THEN
        source_type := v_type; missing := 'bridge_pk'; RETURN NEXT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                      WHERE a.attrelid = v_bridge AND a.attname = 'source_type' AND NOT a.attisdropped
                        AND a.attgenerated = 's'
                        AND pg_get_expr(d.adbin, d.adrelid) = quote_literal(v_type) || '::text') THEN
        source_type := v_type; missing := 'bridge_source_type'; RETURN NEXT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                      WHERE c.contype = 'f' AND c.conrelid = v_bridge AND c.confrelid = v_bind AND c.confdeltype = 'r' AND c.convalidated
                        AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
                               FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
                            = ARRAY['business_id', 'source_type', 'source_id', 'source_line_id', 'movement_kind']
                        AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
                               FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                               JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum)
                            = ARRAY['business_id', 'source_type', 'source_id', 'source_line_id', 'movement_kind']) THEN
        source_type := v_type; missing := 'bridge_binding_fk'; RETURN NEXT;
      END IF;
      -- The line FK: for an S3, S4 or S5 type to exactly its line table and key,
      -- for any other type to some third table (the S2 template).
      IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                      WHERE c.contype = 'f' AND c.conrelid = v_bridge AND c.confrelid <> v_bind
                        AND c.confrelid <> v_bridge AND c.confdeltype = 'r' AND c.convalidated
                        AND (NOT (v_s3 OR v_s4 OR v_s5 OR v_s6) OR c.confrelid = v_line_tbl)
                        AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
                               FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
                            = ARRAY['business_id', 'source_id', 'source_line_id']
                        AND (NOT (v_s3 OR v_s4 OR v_s5 OR v_s6)
                             OR (SELECT array_agg(a.attname::text ORDER BY k.ord)
                                   FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                                   JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum)
                                = v_line_key)) THEN
        source_type := v_type; missing := 'bridge_line_fk'; RETURN NEXT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                       JOIN pg_proc p ON p.oid = g.tgfoid
                      WHERE g.tgrelid = v_bridge AND NOT g.tgisinternal
                        AND g.tgname = 'stock_bridge_immutable_' || v_type
                        AND g.tgtype = 27                -- ROW | BEFORE | DELETE | UPDATE, nothing else
                        AND g.tgenabled IN ('O', 'A')
                        AND g.tgqual IS NULL AND cardinality(g.tgattr::int2[]) = 0
                        AND g.tgfoid = 'public.stock_ledger_append_only()'::regprocedure
                        AND (NOT (v_s3 OR v_s4 OR v_s5 OR v_s6) OR encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex')
                                                   = c_digest ->> 'stock_ledger_append_only()')) THEN
        source_type := v_type; missing := 'bridge_immutable'; RETURN NEXT;
      END IF;
    END IF;
    v_fn := to_regprocedure('public.stock_binding_requires_' || v_type || '()');
    IF v_fn IS NULL OR NOT EXISTS (
         SELECT 1 FROM pg_trigger g
           JOIN pg_proc p ON p.oid = g.tgfoid
           JOIN pg_roles r ON r.oid = p.proowner
          WHERE g.tgrelid = v_bind
            AND g.tgname = 'stock_binding_requires_' || v_type
            AND g.tgtype = 5                              -- ROW | AFTER | INSERT, nothing else
            AND g.tgconstraint <> 0 AND g.tgdeferrable AND g.tginitdeferred
            AND g.tgenabled IN ('O', 'A')
            AND g.tgfoid = v_fn
            AND r.rolname = 'daftar_inventory_internal' AND p.prosecdef
            AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']
            AND position('WHEN ((new.source_type = ' || quote_literal(v_type) || '::text))' IN pg_get_triggerdef(g.oid)) > 0
            AND (NOT (v_s3 OR v_s4 OR v_s5 OR v_s6) OR encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex')
                                       = c_digest ->> ('stock_binding_requires_' || v_type || '()'))) THEN
      source_type := v_type; missing := 'binding_trigger'; RETURN NEXT;
    END IF;

    -- The rest of an S3 type's §2.3 set, on its own document tables: each
    -- unconditional, on every column of its events, on its expected
    -- internal DEFINER function with the pinned path and the recorded body.
    IF v_s3 THEN
      FOR v_g IN
        SELECT e.missing, e.tbl, e.tg, e.typ, e.deferred, e.fn
        FROM (VALUES
          ('inventory_transfer',   'source_complete',  'inventory_transfer_lines',   'stock_source_complete_inventory_transfer',   5,  true,  'stock_source_complete_inventory_transfer()'),
          ('inventory_transfer',   'source_freeze',    'inventory_transfer_lines',   'stock_source_freeze_inventory_transfer',     27, false, 'stock_source_freeze_inventory_transfer()'),
          ('inventory_transfer',   'header_immutable', 'inventory_transfers',        'inventory_transfers_immutable',              27, false, 'inventory_source_header_guard()'),
          ('inventory_transfer',   'value_complete',   'inventory_transfer_lines',   'transfer_value_conserved_per_line',         5,  true,  'inventory_transfer_value_conserved()'),
          ('inventory_adjustment', 'source_complete',  'inventory_adjustment_lines', 'stock_source_complete_inventory_adjustment', 5,  true,  'stock_source_complete_inventory_adjustment()'),
          ('inventory_adjustment', 'source_freeze',    'inventory_adjustment_lines', 'stock_source_freeze_inventory_adjustment',   27, false, 'stock_source_freeze_inventory_adjustment()'),
          ('inventory_adjustment', 'header_immutable', 'inventory_adjustments',      'inventory_adjustments_immutable',            27, false, 'inventory_source_header_guard()'),
          ('inventory_adjustment', 'value_complete',   'inventory_adjustments',      'inventory_adjustments_value_complete',       21, true,  'inventory_source_value_complete()'),
          ('stocktake',            'source_complete',  'stocktake_lines',            'stock_source_complete_stocktake',            21, true,  'stock_source_complete_stocktake()'),
          ('stocktake',            'header_complete',  'stocktakes',                 'stocktakes_finalized_complete',              17, true,  'stock_source_complete_stocktake_header()'),
          ('stocktake',            'source_freeze',    'stocktake_lines',            'stock_source_freeze_stocktake',              27, false, 'stock_source_freeze_stocktake()'),
          ('stocktake',            'header_immutable', 'stocktakes',                 'stocktakes_immutable',                       27, false, 'inventory_source_header_guard()'),
          ('stocktake',            'value_complete',   'stocktakes',                 'stocktakes_value_complete',                  21, true,  'inventory_source_value_complete()'),
          ('inventory_opening',    'source_complete',  'inventory_opening_lines',    'stock_source_complete_inventory_opening',    5,  true,  'stock_source_complete_inventory_opening()'),
          ('inventory_opening',    'source_freeze',    'inventory_opening_lines',    'stock_source_freeze_inventory_opening',      27, false, 'stock_source_freeze_inventory_opening()'),
          ('inventory_opening',    'header_immutable', 'inventory_openings',         'inventory_openings_immutable',               27, false, 'inventory_source_header_guard()'),
          ('inventory_opening',    'value_complete',   'inventory_openings',         'inventory_openings_value_complete',          21, true,  'inventory_source_value_complete()')
        ) AS e(st, missing, tbl, tg, typ, deferred, fn)
        WHERE e.st = v_type
        ORDER BY e.missing
      LOOP
        IF to_regclass('public.' || v_g.tbl) IS NULL OR to_regprocedure('public.' || v_g.fn) IS NULL OR NOT EXISTS (
             SELECT 1 FROM pg_trigger g
               JOIN pg_proc p ON p.oid = g.tgfoid
               JOIN pg_roles r ON r.oid = p.proowner
              WHERE g.tgrelid = to_regclass('public.' || v_g.tbl) AND g.tgname = v_g.tg AND NOT g.tgisinternal
                AND g.tgtype = v_g.typ AND g.tgenabled IN ('O', 'A')
                AND g.tgqual IS NULL AND cardinality(g.tgattr::int2[]) = 0
                AND (g.tgconstraint <> 0 AND g.tgdeferrable AND g.tginitdeferred) = v_g.deferred
                AND g.tgfoid = to_regprocedure('public.' || v_g.fn)
                AND r.rolname = 'daftar_inventory_internal' AND p.prosecdef
                AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']
                AND encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') = c_digest ->> v_g.fn) THEN
          source_type := v_type; missing := v_g.missing; RETURN NEXT;
        END IF;
      END LOOP;
    END IF;

    -- The S4 per-type set (§2.3), the same shape checks; `internal` says
    -- whether the function is an internal DEFINER one or the migrator-owned
    -- INVOKER `stock_ledger_append_only()`.
    IF v_s4 THEN
      FOR v_g IN
        SELECT e.missing, e.tbl, e.tg, e.typ, e.deferred, e.fn, e.internal
        FROM (VALUES
          ('purchase', 'source_complete',  'purchase_lines', 'stock_source_complete_purchase', 21, true,  'stock_source_complete_purchase()',        true),
          ('purchase', 'header_complete',  'purchases',      'purchases_received_complete',    17, true,  'stock_source_complete_purchase_header()', true),
          ('purchase', 'source_freeze',    'purchase_lines', 'stock_source_freeze_purchase',   31, false, 'stock_source_freeze_purchase()',          true),
          ('purchase', 'header_immutable', 'purchases',      'purchases_immutable',            31, false, 'purchase_header_guard()',                 true),
          ('purchase', 'value_complete',   'purchases',      'purchases_value_complete',       17, true,  'purchase_source_value_complete()',        true),
          -- R-38: the landed-cost guards (R-34 events).
          ('purchase', 'landed_cost_freeze',     'purchase_landed_costs',            'purchase_landed_costs_freeze',            31, false,
           'purchase_landed_cost_freeze()', true),
          ('purchase', 'allocation_freeze',      'purchase_landed_cost_allocations', 'purchase_landed_cost_allocations_freeze', 31, false,
           'purchase_landed_cost_freeze()', true),
          ('purchase', 'allocation_consistent',  'purchase_landed_cost_allocations', 'purchase_allocations_consistent',         5,  true,
           'purchase_allocations_consistent()', true),
          ('purchase', 'landed_cost_consistent', 'purchase_landed_costs',            'purchase_landed_costs_consistent',        5,  true,
           'purchase_allocations_consistent()', true),
          ('negative_inventory_cost_adjustment', 'source_complete', 'negative_deficit_coverages',
           'stock_source_complete_negative_inventory_cost_adjustment', 5, true, 'stock_source_complete_negative_inventory_cost_adjustment()', true),
          ('negative_inventory_cost_adjustment', 'source_freeze', 'negative_deficit_coverages',
           'negative_deficit_coverages_append_only', 27, false, 'stock_ledger_append_only()', false),
          ('negative_inventory_cost_adjustment', 'header_immutable', 'negative_inventory_cost_adjustments',
           'negative_inventory_cost_adjustments_immutable', 27, false, 'stock_ledger_append_only()', false),
          ('negative_inventory_cost_adjustment', 'value_complete', 'negative_inventory_cost_adjustments',
           'negative_inventory_cost_adjustments_value_complete', 5, true, 'purchase_source_value_complete()', true),
          -- R-38: the coverage guards (R-36) and the A-16(g) deficit guards.
          ('negative_inventory_cost_adjustment', 'coverage_same_transaction', 'negative_deficit_coverages',
           'negative_deficit_coverages_same_transaction', 7, false, 'negative_deficit_coverage_same_transaction()', true),
          ('negative_inventory_cost_adjustment', 'coverage_value_complete', 'negative_deficit_coverages',
           'negative_deficit_coverages_value_complete', 5, true, 'purchase_source_value_complete()', true),
          ('negative_inventory_cost_adjustment', 'deficit_guard', 'negative_inventory_deficits',
           'negative_inventory_deficits_coverage_guard', 27, false, 'negative_inventory_deficits_coverage_guard()', true),
          ('negative_inventory_cost_adjustment', 'deficit_consistent', 'negative_inventory_deficits',
           'negative_inventory_deficits_coverage_consistent', 17, true, 'negative_inventory_deficits_coverage_consistent()', true)
        ) AS e(st, missing, tbl, tg, typ, deferred, fn, internal)
        WHERE e.st = v_type
        ORDER BY e.missing
      LOOP
        IF to_regclass('public.' || v_g.tbl) IS NULL OR to_regprocedure('public.' || v_g.fn) IS NULL OR NOT EXISTS (
             SELECT 1 FROM pg_trigger g
               JOIN pg_proc p ON p.oid = g.tgfoid
               JOIN pg_roles r ON r.oid = p.proowner
              WHERE g.tgrelid = to_regclass('public.' || v_g.tbl) AND g.tgname = v_g.tg AND NOT g.tgisinternal
                AND g.tgtype = v_g.typ AND g.tgenabled IN ('O', 'A')
                AND g.tgqual IS NULL AND cardinality(g.tgattr::int2[]) = 0
                AND (g.tgconstraint <> 0 AND g.tgdeferrable AND g.tginitdeferred) = v_g.deferred
                AND g.tgfoid = to_regprocedure('public.' || v_g.fn)
                AND CASE WHEN v_g.internal THEN r.rolname = 'daftar_inventory_internal' AND p.prosecdef
                         ELSE r.rolname <> 'daftar_inventory_internal' AND NOT p.prosecdef END
                AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']
                AND encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') = c_digest ->> v_g.fn) THEN
          source_type := v_type; missing := v_g.missing; RETURN NEXT;
        END IF;
      END LOOP;
    END IF;
    -- The S5 per-type set (§2.3, 0063 R-38 carried forward), the S4 loop's
    -- shape exactly.
    IF v_s5 THEN
      FOR v_g IN
        SELECT e.missing, e.tbl, e.tg, e.typ, e.deferred, e.fn, e.internal
        FROM (VALUES
          ('supplier_return', 'source_complete',  'supplier_return_lines', 'stock_source_complete_supplier_return', 5, true,
           'stock_source_complete_supplier_return()', true),
          ('supplier_return', 'header_complete',  'supplier_returns',      'supplier_returns_complete',             5, true,
           'stock_source_complete_supplier_return_header()', true),
          ('supplier_return', 'source_freeze',    'supplier_return_lines', 'stock_source_freeze_supplier_return',   27, false,
           'stock_ledger_append_only()', false),
          ('supplier_return', 'header_immutable', 'supplier_returns',      'supplier_returns_immutable',            27, false,
           'stock_ledger_append_only()', false),
          ('supplier_return', 'value_complete',   'supplier_returns',      'supplier_returns_value_complete',       5, true,
           'supplier_return_value_complete()', true),
          ('supplier_return', 'quantity_bound',   'supplier_return_lines', 'supplier_return_lines_quantity_bound',  5, true,
           'supplier_return_quantity_bound()', true),
          ('supplier_return', 'line_same_transaction', 'supplier_return_lines', 'supplier_return_lines_same_transaction', 7, false,
           'supplier_return_detail_same_transaction()', true),
          ('supplier_return', 'credit_note_same_transaction', 'supplier_credit_notes', 'supplier_credit_notes_same_transaction', 7, false,
           'supplier_return_detail_same_transaction()', true),
          -- R-53: the A-11(e) credit-note immutability guard.
          ('supplier_return', 'credit_note_immutable', 'supplier_credit_notes', 'supplier_credit_notes_immutable', 27, false,
           'supplier_credit_note_guard()', true),
          ('purchase_reversal', 'source_complete',  'purchase_reversal_lines', 'stock_source_complete_purchase_reversal', 5, true,
           'stock_source_complete_purchase_reversal()', true),
          ('purchase_reversal', 'header_complete',  'purchase_reversals',      'purchase_reversals_complete',             5, true,
           'stock_source_complete_purchase_reversal_header()', true),
          ('purchase_reversal', 'source_freeze',    'purchase_reversal_lines', 'stock_source_freeze_purchase_reversal',   27, false,
           'stock_ledger_append_only()', false),
          ('purchase_reversal', 'header_immutable', 'purchase_reversals',      'purchase_reversals_immutable',            27, false,
           'stock_ledger_append_only()', false),
          ('purchase_reversal', 'value_complete',   'purchase_reversals',      'purchase_reversals_value_complete',       5, true,
           'purchase_reversal_value_complete()', true),
          ('purchase_reversal', 'line_same_transaction', 'purchase_reversal_lines', 'purchase_reversal_lines_same_transaction', 7, false,
           'purchase_reversal_detail_same_transaction()', true)
        ) AS e(st, missing, tbl, tg, typ, deferred, fn, internal)
        WHERE e.st = v_type
        ORDER BY e.missing
      LOOP
        IF to_regclass('public.' || v_g.tbl) IS NULL OR to_regprocedure('public.' || v_g.fn) IS NULL OR NOT EXISTS (
             SELECT 1 FROM pg_trigger g
               JOIN pg_proc p ON p.oid = g.tgfoid
               JOIN pg_roles r ON r.oid = p.proowner
              WHERE g.tgrelid = to_regclass('public.' || v_g.tbl) AND g.tgname = v_g.tg AND NOT g.tgisinternal
                AND g.tgtype = v_g.typ AND g.tgenabled IN ('O', 'A')
                AND g.tgqual IS NULL AND cardinality(g.tgattr::int2[]) = 0
                AND (g.tgconstraint <> 0 AND g.tgdeferrable AND g.tginitdeferred) = v_g.deferred
                AND g.tgfoid = to_regprocedure('public.' || v_g.fn)
                AND CASE WHEN v_g.internal THEN r.rolname = 'daftar_inventory_internal' AND p.prosecdef
                         ELSE r.rolname <> 'daftar_inventory_internal' AND NOT p.prosecdef END
                AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']
                AND encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') = c_digest ->> v_g.fn) THEN
          source_type := v_type; missing := v_g.missing; RETURN NEXT;
        END IF;
      END LOOP;
    END IF;
    -- The S6 per-type set (P4-AL-29b, TL-P4-S2-K3), the S4/S5 loop's shape
    -- exactly. There is NO value_complete row: its subject would be a stored
    -- cost total on `sales`, which P4-AL-05 forbids and the no-authoritative-
    -- balance guard's DERIVED_COST_COLUMN refuses by name. The amount is
    -- pinned in the ledger and read from it; see 0077 §6(e).
    IF v_s6 THEN
      FOR v_g IN
        SELECT e.missing, e.tbl, e.tg, e.typ, e.deferred, e.fn, e.internal
        FROM (VALUES
          ('sale', 'source_complete',  'sale_items', 'stock_source_complete_sale', 5, true,
           'stock_source_complete_sale()', true),
          ('sale', 'header_complete',  'sales',      'sales_confirmed_complete',   17, true,
           'stock_source_complete_sale_header()', true),
          ('sale', 'source_freeze',    'sale_items', 'sale_items_append_only',     27, false,
           'stock_ledger_append_only()', false),
          ('sale', 'header_immutable', 'sales',      'sales_immutable',            31, false,
           'sale_header_guard()', true)
        ) AS e(st, missing, tbl, tg, typ, deferred, fn, internal)
        WHERE e.st = v_type
        ORDER BY e.missing
      LOOP
        IF to_regclass('public.' || v_g.tbl) IS NULL OR to_regprocedure('public.' || v_g.fn) IS NULL OR NOT EXISTS (
             SELECT 1 FROM pg_trigger g
               JOIN pg_proc p ON p.oid = g.tgfoid
               JOIN pg_roles r ON r.oid = p.proowner
              WHERE g.tgrelid = to_regclass('public.' || v_g.tbl) AND g.tgname = v_g.tg AND NOT g.tgisinternal
                AND g.tgtype = v_g.typ AND g.tgenabled IN ('O', 'A')
                AND g.tgqual IS NULL AND cardinality(g.tgattr::int2[]) = 0
                AND (g.tgconstraint <> 0 AND g.tgdeferrable AND g.tginitdeferred) = v_g.deferred
                AND g.tgfoid = to_regprocedure('public.' || v_g.fn)
                AND CASE WHEN v_g.internal THEN r.rolname = 'daftar_inventory_internal' AND p.prosecdef
                         ELSE r.rolname <> 'daftar_inventory_internal' AND NOT p.prosecdef END
                AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']
                AND encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') = c_digest ->> v_g.fn) THEN
          source_type := v_type; missing := v_g.missing; RETURN NEXT;
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END;
$$;

-- The end state this migration claims, asserted here rather than reviewed: the
-- gap guard must report NOTHING, which covers the new trigger by table, name,
-- event, deferral, enabled state, owner, SECURITY DEFINER, pinned search_path
-- and the SHA-256 of its body.
DO $$
DECLARE
  v_n   INTEGER;
  v_def TEXT;
BEGIN
  SELECT count(*), coalesce(string_agg(g.source_type || '/' || g.missing, ', ' ORDER BY g.source_type, g.missing), '')
    INTO v_n, v_def
    FROM inventory_stock_source_guard_gaps() g;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: inventory_stock_source_guard_gaps() reports % gap(s): %', v_n, v_def
      USING ERRCODE = 'P0001';
  END IF;
END $$;
