-- ─────────────────────────────────────────────────────────────────────────
-- 0078 — P4-S2: `sale_commit`, the trusted atomic sale command.
--
-- Decisions this file follows, with the citation beside each:
--
--   docs/PHASE_4_S2_CONTRACT.md C-09   — the 29-argument signature and the
--                                        eleven-step order of operations.
--   P4-AL-16  one transaction or no sale.
--   P4-AL-25  the COGS truth is Σ stock_movements.value_delta_base_minor.
--   P4-AL-30  no clock read, no DEFAULT: the fingerprint is the request.
--   P4-AL-31  no counter column; the ordinal is max+1 under the series row.
--   P4-AL-32  the sequence row is the LAST of the domain locks.
--   P4-AL-44  OD-03: tax is structurally zero and the routine writes the zero
--             itself, because there is no `p_tax_minor` to pass non-zero.
--   OD-P4-05  NO OVERSELL — and `inventory_apply_stock_movements` is NOT
--             touched. `0060:382-384` already raises
--             `inventory.insufficient_stock` under the stock key's own
--             `FOR UPDATE`, which is the same lock that decides the
--             last-item race. A request to change that routine is a Tech
--             Lead review point, so this file calls it and changes nothing.
--
-- ── What this file does ─────────────────────────────────────────────────
--
--   1. `sale_lock_commit_targets` — the `sale.commit` twin of
--      `purchase_lock_receipt_targets` (`0064:80`): the SHARED
--      `daftar.stock_target` advisory locks and the warehouse/variant/product
--      status re-checks, as seen AFTER the locks.
--   2. `sale_document_number` — the renderer of `invoice_sequences.number_format`.
--      Nothing in `0000`–`0077` renders it, because P4-S1 created no writer of
--      `invoices` at all, so the first writer brings the renderer with it.
--   3. `sale_bridge_commit` — the one writer of `stock_source_bridge_sale`,
--      on the `purchase_bridge_receipt` pattern (`0064:301`) and copying
--      `tenant_id` from the binding it bridges, at no extra read.
--   4. `sale_commit` — the entry routine, `SECURITY DEFINER`, owned by
--      `daftar_inventory_internal`, `EXECUTE` to `daftar_app` alone.
--   5. One `CREATE OR REPLACE` of `0077`'s `accounting_sale_entry_complete()`,
--      by its owner, correcting the COGS line's warehouse dimension. See §4.
--   6. 0078-E: the end state, asserted against the live catalogues.
--
-- ── What this file does NOT do ──────────────────────────────────────────
--
--   * It writes NO journal line. `accounting_post_entry` (`0045:490`) stays
--     the one ledger writer and the caller posts both entries through it.
--   * It adds NO refusal for the ZERO-VALUED sale. A sale of stock whose
--     stored valuation is zero is lawful: `0060:388-390` sets the emptying
--     movement's value to `-v_level_value`, which is 0 when the valuation is
--     0, and `journal_lines_money_cap_ck` (`0042:225`) refuses a zero-amount
--     line, so such a sale posts its revenue entry alone. The conditional
--     seam arm has landed (`packages/accounting/src/sale-posting.ts:632,713`),
--     and what makes it safe is the DEFERRED `sales_cogs_owed` trigger of
--     `0077`, not a second check here. A refusal here would refuse the
--     lawful case.
--   * It creates no `invoice_sequences` row AT APPLY TIME. The ROUTINE
--     creates the row of a `(business, year)` on FIRST USE — see the
--     corrected `R-P4-S2-78-03` — but this file inserts nothing, and
--     0078-E(8) still asserts the invoice relations are empty after it.
--   * It carries NO `MIGRATION_MANIFEST.json` entry (`TL-P4-S1-C8`), and
--     `0000`–`0077` are untouched.
--
-- ── Header rules ────────────────────────────────────────────────────────
--
--   R-P4-S2-78-01  NO CLOCK IN THE FINGERPRINT. `p_document_date` and
--     `p_due_date` are required arguments with no `DEFAULT` and there is no
--     `coalesce(p_*, current_date)` anywhere below. `now()` appears only in
--     `confirmed_at` and in the future-date comparison, neither of which is
--     hashed. A financial command whose fingerprint covers a server-resolved
--     date answers "success" to a command it never saw.
--
--   R-P4-S2-78-02  THE ROUTINE IS THE LAST RECOMPUTE. Every amount it stores
--     is re-derived from the catalogue under the locks and compared with its
--     own arguments; a disagreement is `sale.state_changed`. Client totals
--     are not authoritative and neither are the service's.
--
--   R-P4-S2-78-03  THE SERIES ROW IS CREATED ON FIRST USE (TL-P4-S2-R4).
--     `invoice_sequences` holds no counter (`0075:29-33`) and NOTHING in
--     `0000`–`0076` inserts a row into it, so the earlier reading of this
--     rule — refuse `sale.issue_invoice` until the merchant states a series
--     — left a CLEAN BUSINESS with no supported path to its first invoice.
--     That was reported as a product blocker and ruled on: a sale endpoint
--     that requires manual SQL setup is not a complete product path. The
--     Tech Lead's ruling fixes the default internal numbering format, and
--     step 10 below creates the row of a `(business, year)` the first time
--     one is needed, with that format, and then locks it.
--
--     WHAT THE DEFAULT IS AND IS NOT. `INV-{YYYY}-{SEQ:6}` renders
--     `INV-2026-000001`: a DAFTAR-INTERNAL document identifier and NOT a
--     claim of jurisdiction-specific fiscal or tax compliance. **OD-03
--     REMAINS OPEN.** No country's invoice law, VAT rule, registration
--     threshold or legal invoice field is researched or encoded here
--     (`P4-AL-45`), and a Country Pack may impose legal requirements of its
--     own later, independently of this default.
--
--     THE WIDTH IS SPELLED `{SEQ:6}` AND NOT `{SEQ:06}`, AND THAT IS NOT A
--     CHOICE THIS FILE MADE. `invoice_sequences_format_ck` (`0075:379`)
--     admits `\{SEQ:[1-9][0-9]?\}` — the first digit of the width cannot be
--     `0` — and `0075` is FROZEN. `{SEQ:6}` is this estate's spelling of
--     "zero-pad the ordinal to six", which is what the ruling's `{SEQ:06}`
--     asks for, and it renders the same six-digit number. The literal
--     string `{SEQ:06}` would need a frozen CHECK widened, which only the
--     Tech Lead may authorise; the deviation is reported rather than taken
--     quietly, and nothing below depends on which spelling wins.
--
--   R-P4-S2-78-04  THE SEQUENCE ROW IS CREATED ONCE, THEN LOCKED, AND ITS
--     FORMAT IS NEVER REWRITTEN. The initialiser is a single
--     `INSERT … ON CONFLICT (business_id, document_kind, period) DO
--     NOTHING`, which is the whole of the concurrency argument: two
--     concurrent first sales of a new year produce ONE row, because the
--     PRIMARY KEY decides it, and the loser's `DO NOTHING` waits on the
--     winner's transaction and then leaves the winner's `number_format`
--     exactly as it is. `DO UPDATE` would be the defect: it would hand
--     this writer the right to rewrite a merchant's format, which is
--     precisely the authority the column-level grant below withholds.
--     There is no retry loop and no second order
--     ([[daftar-lock-order-not-retry]]): the INSERT sits where the lock
--     already sat, at step 10, LAST (`P4-AL-32`), and its only FK —
--     `invoice_sequences_tenant_fk` on `businesses` — takes a `FOR KEY
--     SHARE` the `sales` insert of step 6 has already taken through
--     `sales_tenant_fk`, so no lock-order edge is added at all.
--     Then the row is LOCKED and never rewritten. The ordinal is
--     `coalesce(max(number_seq), 0) + 1` read from `invoices` while holding
--     the series row `FOR NO KEY UPDATE`, with `invoices_number_uq`
--     (`0075:286`) as the backstop that turns a missed lock into a refusal
--     rather than a duplicate number. Every locking clause needs `UPDATE`,
--     but ANY ONE COLUMN satisfies it (`0045:399` locks `businesses` through
--     `UPDATE (financial_started_at)` alone), so this file grants
--     `UPDATE (updated_at)` and NOT a table-level `UPDATE`: the latter is
--     authority to rewrite a merchant's `number_format`, which no law here
--     rests on. 0078-E(5) asserts that the routine's own body contains no
--     `UPDATE` and no `DELETE` of that relation, that it carries EXACTLY ONE
--     `INSERT` into it and that the insert is `ON CONFLICT … DO NOTHING`;
--     0078-E(7) asserts that the privilege itself is neither table-level nor
--     on any column but `updated_at` — so the UPDATE is the lock's and
--     nothing else's, by privilege and not only by body, and the INSERT can
--     create a row but can never overwrite one.
--
--   R-P4-S2-78-05  GRANT BEFORE OWNER ([[daftar-grant-before-owner]],
--     `P4-AL-39`): a `GRANT` issued after `OWNER TO` warns and commits, so
--     every privilege below is granted while the applier still owns the
--     object.
--
--   R-P4-S2-78-06  `inventory_apply_stock_movements` IS UNCHANGED. This file
--     does not `CREATE OR REPLACE` it, does not wrap it and does not pass it
--     a precomputed value: `unit_cost_base_minor` and
--     `value_delta_base_minor` are both NULL in every request, so the writer
--     computes the value under the stock key's own lock, which is also where
--     the no-oversell refusal is raised.
--
--   R-P4-S2-78-07  THE ASSERTION IS THE FIRST DECISION. `sale_commit`
--     consumes the `invctl/1` assertion before it reads anything, and
--     `inventory_apply_stock_movements` re-verifies the same assertion
--     non-consumingly through `inventory_assertion_current` against the
--     registry list (`0060:186`), which is why `0077` had to register
--     `sale.commit` in `inventory_operation_movement_kinds`.
-- ─────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────
-- 0. Preconditions. What this file assumes is already true, stated as
--    refusals, so a wrong head fails here and not halfway through.
-- ─────────────────────────────────────────────────────────────────────────
DO $pre$
DECLARE
  c_new CONSTANT TEXT[] := ARRAY['sale_commit', 'sale_lock_commit_targets', 'sale_document_number', 'sale_bridge_commit'];
  c_need CONSTANT TEXT[] := ARRAY['sales', 'sale_items', 'stock_source_bridge_sale', 'invoices', 'invoice_items',
                                  'invoice_sequences', 'customers', 'stock_source_bindings', 'stock_movements'];
  v_name TEXT;
BEGIN
  FOREACH v_name IN ARRAY c_new LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = v_name) THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: %() already exists, so 0078 is not the migration that creates it', v_name
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  FOREACH v_name IN ARRAY c_need LOOP
    IF to_regclass('public.' || v_name) IS NULL THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: % does not exist, so 0077 did not run before 0078', v_name
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- The edge 0077 added, and the registrations its routine depends on.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_sale_fk' AND conrelid = 'public.invoices'::regclass) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: invoices_sale_fk is absent, so 0077 did not complete' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM inventory_operation_kinds k WHERE k.op_code = 'sale.commit')
     OR NOT EXISTS (SELECT 1 FROM inventory_operation_movement_kinds m WHERE m.op_code = 'sale.commit' AND m.movement_kind = 'sale') THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: sale.commit is not registered, so the stock writer would refuse this routine''s own assertion'
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM stock_source_types t WHERE t.source_type = 'sale')
     OR NOT EXISTS (SELECT 1 FROM accounting_source_types t WHERE t.source_type = 'sale')
     OR NOT EXISTS (SELECT 1 FROM accounting_source_types t WHERE t.source_type = 'invoice') THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the P4-S2 source types are not registered' USING ERRCODE = 'P0001';
  END IF;

  -- The helpers it calls, each by its exact signature: a routine that is not
  -- there is a refusal now rather than a `42883` on the first sale.
  FOREACH v_name IN ARRAY ARRAY['inventory_assertion_consume(text,text)', 'inventory_claimed_payload_digest(text,text[],text[])',
                                'inventory_payload_digest(text,uuid,uuid,text[],text[])', 'inventory_business_transaction_id()',
                                'inventory_fixed_text(numeric,integer)', 'inventory_reason_words(text)',
                                'inventory_half_even(numeric,numeric,integer)', 'inventory_largest_remainder(numeric[],bigint)',
                                'inventory_apply_stock_movements(inventory_movement_request[])',
                                'accounting_purchase_fx_rate(uuid,char,timestamptz)',
                                'inventory_sale_cost_base_minor(uuid,uuid)',
                                'accounting_sale_entry_complete()', 'sales_cogs_owed()'] LOOP
    IF to_regprocedure(v_name) IS NULL THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: % is absent, so this routine cannot be built on it', v_name USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- The relation it is about must be empty: a sale written by any other
  -- route would not carry this routine's fingerprint.
  IF EXISTS (SELECT 1 FROM sales) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: sales already holds rows, so no routine on disk wrote them' USING ERRCODE = 'P0001';
  END IF;
END;
$pre$;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The privileges the routine's OWNER needs, granted before anything is
--    owned by it (R-P4-S2-78-05).
--
--    `daftar_inventory_internal` already reads all five P4-S1 relations
--    (`0075:495`) and already holds `INSERT` on `audit_events` (`0055:52`)
--    and `outbox_events` (`0061:1827`). What it does not yet hold is the
--    right to WRITE the invoice and its lines — P4-S1 created no writer —
--    and the `UPDATE` privilege that a row lock on the series requires.
--
--    THE SERIES GRANT IS COLUMN-LEVEL, AND THAT IS THE WHOLE POINT. Every
--    PostgreSQL locking clause needs `UPDATE` — `FOR UPDATE`, `FOR NO KEY
--    UPDATE`, `FOR SHARE` and `FOR KEY SHARE` alike — but the privilege is
--    satisfied by `UPDATE` on ANY ONE COLUMN, which is why `0045:399` lets
--    `daftar_accounting_internal` lock `businesses` through
--    `UPDATE (financial_started_at)` alone. The series row is LOCKED and
--    NEVER REWRITTEN (`R-P4-S2-78-03`: `invoice_sequences` holds no counter,
--    so there is nothing on it to advance), so a TABLE-LEVEL `UPDATE` would
--    hand this writer the right to rewrite a merchant's `number_format` —
--    authority no law here rests on. The named column is `updated_at`: the
--    lifecycle column, the one a legitimate rewrite of the series would
--    touch, and the narrowest grant that still carries the lock. 0078-E(5)
--    proves the routine's body never UPDATEs or DELETEs the series row;
--    0078-E(7) proves the privilege itself cannot be used for more.
--
--    AND THE SERIES ALSO TAKES AN `INSERT`, WHICH IS A DIFFERENT AUTHORITY.
--    TL-P4-S2-R4 made the first-use row a product path, so the writer must
--    be able to CREATE a `(business, year)` series. `INSERT` creates; it
--    cannot overwrite. Combined with the `ON CONFLICT … DO NOTHING` of step
--    10 and the withheld table-level `UPDATE`, a merchant's stated
--    `number_format` is unreachable from this routine by construction: there
--    is no statement it is privileged to issue that could change one.
--    `invoice_sequences_key_guard` (`0075:639`) is BEFORE UPDATE OR DELETE
--    only, so an INSERT is not something it was written to refuse, and the
--    row-security side is unchanged: the RESTRICTIVE
--    `business_isolation_insert` (`0075:480`) and the PERMISSIVE
--    `tenant_membership` (`0075:475`) are the same two policies the
--    `invoices` insert of step 10 already satisfies, under the same
--    `app_business()` / `app_tenant()` settings, and NEITHER carries a
--    `current_user = 'daftar_inventory_internal'` exemption — so the
--    initialiser is admitted by the tenancy of the REQUEST and by nothing
--    about who owns the routine. Asserted against the live catalogues in
--    0078-E(7) and behaviourally in
--    `tests/integration/sale-s2-sequence-init.test.ts`.
-- ─────────────────────────────────────────────────────────────────────────
GRANT INSERT ON invoices, invoice_items TO daftar_inventory_internal;
GRANT INSERT ON invoice_sequences TO daftar_inventory_internal;
GRANT UPDATE (updated_at) ON invoice_sequences TO daftar_inventory_internal;
-- The name snapshot the sale and the invoice both store is read from
-- `product_translations` (`0036:9`), which `0053:253` did not grant to this
-- role because no inventory routine needed a product NAME before. A read
-- grant, and nothing else: the writer never writes a translation.
GRANT SELECT ON product_translations TO daftar_inventory_internal;

GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The three internal helpers. No grant on any of them: they are
--    reachable only from the routines `daftar_inventory_internal` owns, and
--    `EXECUTE` is new authority rather than mere reachability
--    ([[daftar-execute-is-reachability-not-authority]], `P4-AL-39`).
-- ─────────────────────────────────────────────────────────────────────────

-- (a) The stock targets, as seen AFTER the locks. The exact shape of
--     `purchase_lock_receipt_targets` (`0064:80`), pinned to this slice's
--     operation: the archive triggers take the same advisory key EXCLUSIVE
--     (`0061:1210,1223`), so a variant cannot be archived between the check
--     and the movement.
--
--     It refuses a product that does not track inventory, which is what the
--     landed service already refuses (`sale-commit.service.ts:533`) and what
--     `0077`'s `stock_source_complete_sale()` requires: that guard asserts a
--     bridged movement for EVERY `sale_items` line, so a line with no
--     movement is not representable. The accounting contract's §E-03
--     describes a non-tracked product as "simply sellable"; the code refuses
--     it, and the code wins. Reported as a conflict rather than followed.
CREATE OR REPLACE FUNCTION sale_lock_commit_targets(p_warehouse UUID, p_variants UUID[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor   inventory_verified_actor;
  v_id      UUID;
  v_status  TEXT;
  v_pstatus TEXT;
  v_tracked BOOLEAN;
BEGIN
  v_actor := inventory_assertion_current(ARRAY['sale.commit']);
  IF p_warehouse IS NULL OR p_variants IS NULL OR array_position(p_variants, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a sale names its warehouse and variants' USING ERRCODE = 'P0001';
  END IF;
  FOR v_id IN SELECT DISTINCT x.id FROM unnest(ARRAY[p_warehouse] || p_variants) AS x(id) ORDER BY 1 LOOP
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

  FOR v_id IN
    SELECT DISTINCT pv.product_id FROM product_variants pv
     WHERE pv.business_id = v_actor.business_id AND pv.id = ANY (p_variants) ORDER BY 1
  LOOP
    PERFORM 1 FROM products p WHERE p.business_id = v_actor.business_id AND p.id = v_id FOR SHARE;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION sale_lock_commit_targets(UUID, UUID[]) IS
  'P4-S2 C-09 step 5, on the 0064:80 shape. Re-verifies the transaction''s consumed sale.commit assertion, takes SHARED advisory locks (daftar.stock_target) on the warehouse and every variant in id order, then requires the warehouse to exist and be active and every variant to exist, be active with an active product and be tracked (inventory.warehouse_not_found / _archived, variant_not_found / _archived, product_not_tracked), and locks the products FOR SHARE in id order. Stock keys are locked by the primitive, in its own order. Internal-owned, no grant.';

-- (b) The rendered document number. `invoice_sequences.number_format`
--     (`0075:376-381`) is `…{YYYY}…{SEQ:n}…` over `[A-Za-z0-9/-]`, and its
--     CHECK requires both placeholders, so neither replacement can be a
--     no-op. `n` is the zero-padded width; an ordinal wider than `n` is
--     rendered in full rather than truncated, because a truncated number
--     would collide with an earlier one under
--     `invoices_document_number_uq` and a collision is not a numbering rule.
CREATE OR REPLACE FUNCTION sale_document_number(p_format TEXT, p_period TEXT, p_seq BIGINT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_width INTEGER;
  v_out   TEXT;
BEGIN
  IF p_format IS NULL OR p_period IS NULL OR p_seq IS NULL OR p_seq < 1 THEN
    RAISE EXCEPTION 'selling.payload_invalid: a document number is rendered from a format, a period and a positive ordinal' USING ERRCODE = 'P0001';
  END IF;
  v_width := (regexp_match(p_format, '\{SEQ:([1-9][0-9]?)\}'))[1]::integer;
  IF v_width IS NULL OR position('{YYYY}' IN p_format) = 0 THEN
    RAISE EXCEPTION 'selling.sequence_format_invalid: a number format states both the year and the ordinal' USING ERRCODE = 'P0001';
  END IF;
  v_out := replace(p_format, '{YYYY}', p_period);
  -- `lpad` TRUNCATES a string longer than its length, so an ordinal wider
  -- than its field would silently become an earlier document's number and
  -- collide under `invoices_document_number_uq`. The width is a MINIMUM here.
  v_out := regexp_replace(v_out, '\{SEQ:[1-9][0-9]?\}',
                          CASE WHEN char_length(p_seq::text) >= v_width THEN p_seq::text
                               ELSE lpad(p_seq::text, v_width, '0') END);
  IF char_length(v_out) < 1 OR char_length(v_out) > 64 OR v_out <> btrim(v_out) THEN
    RAISE EXCEPTION 'selling.sequence_format_invalid: the rendered document number is not within the invoices CHECK' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_out;
END;
$$;

COMMENT ON FUNCTION sale_document_number(TEXT, TEXT, BIGINT) IS
  'P4-S2. Renders invoice_sequences.number_format for a period and an ordinal: {YYYY} becomes the period and {SEQ:n} the ordinal zero-padded to n (never truncated — a truncated number would collide under invoices_document_number_uq). Refuses a format missing either placeholder, and a rendering outside the invoices.document_number CHECK, with selling.sequence_format_invalid. The first renderer in the tree, because P4-S1 created no writer of invoices. Internal-owned, no grant.';

-- (c) The bridge. The one writer of `stock_source_bridge_sale`, on the
--     `purchase_bridge_receipt` pattern (`0064:301`): one bridge row per
--     stock binding of the sale, with `tenant_id` COPIED from the binding
--     it bridges. `stock_source_bindings` carries `tenant_id` already with
--     the same composite FK and sits at the same grain, so the column the
--     ruling added to the bridge costs no extra read.
CREATE OR REPLACE FUNCTION sale_bridge_commit(p_sale_id UUID) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor inventory_verified_actor;
  v_rows  INTEGER;
BEGIN
  v_actor := inventory_assertion_current(ARRAY['sale.commit']);
  IF p_sale_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM sales s WHERE s.business_id = v_actor.business_id AND s.id = p_sale_id) THEN
    RAISE EXCEPTION 'inventory.source_type_not_authorized: a sale bridges only its own stock bindings' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO stock_source_bridge_sale (tenant_id, business_id, source_id, source_line_id, movement_kind)
  SELECT b.tenant_id, b.business_id, b.source_id, b.source_line_id, b.movement_kind
  FROM stock_source_bindings b
  WHERE b.business_id = v_actor.business_id AND b.source_type = 'sale' AND b.source_id = p_sale_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

COMMENT ON FUNCTION sale_bridge_commit(UUID) IS
  'P4-S2 C-09 step 9, on the 0064:301 pattern. The ONE writer of stock_source_bridge_sale. Re-verifies the transaction''s consumed sale.commit assertion, requires p_sale_id to be a sale of the verified business (inventory.source_type_not_authorized otherwise), and inserts one bridge row per stock_source_bindings row of that sale, copying tenant_id from the binding. Internal-owned, no grant.';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. `sale_commit` — C-09's signature, argument for argument, and its
--    eleven steps in its order.
--
--    29 positional arguments, 18 scalars then 11 parallel arrays, exactly as
--    `SALE_COMMIT_SQL` (`apps/api/src/modules/selling/sale-commit.service.ts:758`)
--    sends them. There is deliberately no `p_tax_minor`: the only admissible
--    tax is zero, and an argument for it is an argument somebody can pass
--    non-zero. There is no `DEFAULT` on any argument.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION sale_commit(
  p_sale_id              UUID,
  p_invoice_id           UUID,
  p_settlement_mode      TEXT,
  p_customer_id          UUID,
  p_warehouse_id         UUID,
  p_branch_id            UUID,
  p_document_date        DATE,
  p_due_date             DATE,
  p_currency             CHAR(3),
  p_rate_id              UUID,
  p_rate                 NUMERIC,
  p_rate_source          TEXT,
  p_rate_at              TIMESTAMPTZ,
  p_subtotal_txn_minor   BIGINT,
  p_discount_txn_minor   BIGINT,
  p_total_txn_minor      BIGINT,
  p_total_base_minor     BIGINT,
  p_notes                TEXT,
  p_line_ids             UUID[],
  p_product_ids          UUID[],
  p_merchant_variant_ids UUID[],
  p_stock_variant_ids    UUID[],
  p_name_snapshots       TEXT[],
  p_quantities           NUMERIC[],
  p_unit_prices          BIGINT[],
  p_gross                BIGINT[],
  p_discounts            BIGINT[],
  p_nets                 BIGINT[],
  p_base_shares          BIGINT[]
) RETURNS TABLE (replayed BOOLEAN, cogs_base_minor BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_actor      inventory_verified_actor;
  v_business   UUID;
  v_tenant     UUID;
  v_trace      UUID;
  v_intent     TEXT;
  v_n          INTEGER;
  v_i          INTEGER;
  v_tz         TEXT;
  v_base_ccy   TEXT;
  v_et         INTEGER;
  v_eb         INTEGER;
  v_fx         accounting_fx_rate_snapshot;
  v_rate_id    UUID;
  v_rate       NUMERIC;
  v_source     TEXT;
  v_at         TIMESTAMPTZ;
  v_c          RECORD;
  v_s          RECORD;
  v_cust_name  TEXT;
  v_cust_phone TEXT;
  v_branch     UUID;
  v_gross      BIGINT[];
  v_nets       BIGINT[];
  v_names      TEXT[];
  v_products   UUID[];
  v_prices     BIGINT[];
  v_base_total NUMERIC;
  v_shares     BIGINT[];
  v_reqs       inventory_movement_request[];
  v_bridged    INTEGER;
  v_period     TEXT;
  v_seq        BIGINT;
  v_format     TEXT;
  v_number     TEXT;
  v_cogs       BIGINT;
BEGIN
  -- ── Step 1. The assertion, and nothing before it. ────────────────────
  --
  -- `inventory_assertion_consume` is the verifier that CONSUMES; it reads the
  -- allowed-kind question from `inventory_operation_kinds` at step 6 of its
  -- own body (`0054:406-410`), which is the registry-before-state mechanism
  -- C-09 step 1 names. The nested `inventory_apply_stock_movements` then
  -- re-verifies this very assertion non-consumingly through
  -- `inventory_assertion_current` against the registry list (`0060:186`).
  --
  -- The digest is over the routine's OWN 29 arguments in payload order, so an
  -- argument the authority was not minted over fails step 7 of the verifier
  -- rather than being stored. `p_gross` and `p_name_snapshots` are absent
  -- from this stream on purpose: both are derivable, and a derivable field in
  -- a fingerprint is a second truth. They are RECOMPUTED at step 6 instead.
  v_actor := inventory_assertion_consume('sale.commit', inventory_claimed_payload_digest('sale.commit',
    ARRAY['uuid', 'code', 'uuid', 'uuid', 'uuid', 'uuid', 'integer', 'integer', 'code', 'uuid', 'integer', 'code', 'integer',
          'integer', 'integer', 'integer', 'integer', 'integer']
      || ARRAY['integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer']
      || ARRAY['integer']
      || ARRAY(SELECT f.t FROM unnest(p_line_ids, p_product_ids, p_merchant_variant_ids, p_stock_variant_ids,
                                      p_quantities, p_discounts, p_unit_prices, p_nets, p_base_shares)
                                 WITH ORDINALITY AS l(li, pr, mv, sv, q, d, u, nt, bs, i)
               CROSS JOIN LATERAL unnest(ARRAY['uuid', 'uuid', 'uuid', 'uuid', 'integer', 'integer', 'integer', 'integer', 'integer'])
                 WITH ORDINALITY AS f(t, j)
               ORDER BY l.i, f.j),
    ARRAY[p_sale_id::text, p_settlement_mode, p_customer_id::text, p_warehouse_id::text, p_branch_id::text, p_invoice_id::text,
          to_char(p_document_date, 'YYYYMMDD'), to_char(p_due_date, 'YYYYMMDD'), lower(p_currency::text),
          p_rate_id::text, inventory_fixed_text(p_rate, 10), p_rate_source,
          CASE WHEN extract(epoch FROM p_rate_at) = trunc(extract(epoch FROM p_rate_at))
               THEN trunc(extract(epoch FROM p_rate_at))::text ELSE extract(epoch FROM p_rate_at)::text END,
          p_subtotal_txn_minor::text, p_discount_txn_minor::text, '0', p_total_txn_minor::text, p_total_base_minor::text]
      || inventory_reason_words(p_notes)
      || ARRAY[coalesce(cardinality(p_line_ids), 0)::text]
      || ARRAY(SELECT f.x FROM unnest(p_line_ids, p_product_ids, p_merchant_variant_ids, p_stock_variant_ids,
                                      p_quantities, p_discounts, p_unit_prices, p_nets, p_base_shares)
                                 WITH ORDINALITY AS l(li, pr, mv, sv, q, d, u, nt, bs, i)
               CROSS JOIN LATERAL unnest(ARRAY[l.li::text, l.pr::text, l.mv::text, l.sv::text,
                                               inventory_fixed_text(l.q, 4), l.d::text,
                                               inventory_fixed_text(l.u::numeric, 10), l.nt::text, l.bs::text])
                 WITH ORDINALITY AS f(x, j)
               ORDER BY l.i, f.j)));

  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: stock commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_business := v_actor.business_id;
  v_tenant   := v_actor.tenant_id;
  v_trace    := inventory_business_transaction_id();
  IF v_trace IS NULL THEN
    RAISE EXCEPTION 'inventory.trace_missing: a stock document records its business transaction id' USING ERRCODE = 'P0001';
  END IF;

  -- ── Step 2. The per-document lock, FIRST. ────────────────────────────
  --
  -- Before the idempotency read, so two identical commits of one sale id
  -- serialise here and the loser sees the winner's row rather than racing it
  -- to the primary key.
  IF p_sale_id IS NULL OR p_invoice_id IS NULL THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a sale names itself and its invoice' USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('daftar.sale_id'), hashtext(p_sale_id::text));

  -- ── Step 3. The intent, re-derived, and compared BEFORE ANY STATE. ───
  --
  -- The INTENT subset is computable from the request alone
  -- (`packages/inventory/src/sale-payloads.ts:213-245`): the sale, the
  -- settlement mode, the customer, the warehouse, the document date, the due
  -- date, the zero tax, the notes words, the line count, and per line the
  -- line id, the product, the MERCHANT variant, the quantity and the
  -- requested discount. It carries no price, no rate and no total, which is
  -- what lets this comparison happen before the catalogue is read
  -- ([[daftar-registry-before-state]]): a fingerprint over a resolved price
  -- would turn every price change into a false conflict.
  v_intent := inventory_payload_digest('sale.commit', v_tenant, v_business,
    ARRAY['uuid', 'code', 'uuid', 'uuid', 'integer', 'integer', 'integer']
      || ARRAY['integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer']
      || ARRAY['integer']
      || ARRAY(SELECT f.t FROM unnest(p_line_ids, p_product_ids, p_merchant_variant_ids, p_quantities, p_discounts)
                                 WITH ORDINALITY AS l(li, pr, mv, q, d, i)
               CROSS JOIN LATERAL unnest(ARRAY['uuid', 'uuid', 'uuid', 'integer', 'integer']) WITH ORDINALITY AS f(t, j)
               ORDER BY l.i, f.j),
    ARRAY[p_sale_id::text, p_settlement_mode, p_customer_id::text, p_warehouse_id::text,
          to_char(p_document_date, 'YYYYMMDD'), to_char(p_due_date, 'YYYYMMDD'), '0']
      || inventory_reason_words(p_notes)
      || ARRAY[coalesce(cardinality(p_line_ids), 0)::text]
      || ARRAY(SELECT f.x FROM unnest(p_line_ids, p_product_ids, p_merchant_variant_ids, p_quantities, p_discounts)
                                 WITH ORDINALITY AS l(li, pr, mv, q, d, i)
               CROSS JOIN LATERAL unnest(ARRAY[l.li::text, l.pr::text, l.mv::text, inventory_fixed_text(l.q, 4), l.d::text])
                 WITH ORDINALITY AS f(x, j)
               ORDER BY l.i, f.j));

  SELECT s.status, s.commit_intent_sha256 INTO v_s
  FROM sales s WHERE s.business_id = v_business AND s.id = p_sale_id FOR UPDATE;
  IF FOUND THEN
    IF v_s.commit_intent_sha256 <> v_intent THEN
      RAISE EXCEPTION 'sale.idempotency_conflict: this sale id already carries a different command' USING ERRCODE = 'P0001';
    END IF;
    -- The identical command, already committed: answer from the stored rows,
    -- having written nothing. The COGS is re-read from the ledger, never
    -- recomputed, because the ledger is where P4-AL-25 puts the truth.
    RETURN QUERY SELECT true, inventory_sale_cost_base_minor(v_business, p_sale_id);
    RETURN;
  END IF;

  -- ── Step 4. The shape. Eleven arrays of one length, nothing null. ────
  v_n := coalesce(cardinality(p_line_ids), 0);
  IF v_n = 0 OR v_n > 200 OR array_ndims(p_line_ids) <> 1 OR array_lower(p_line_ids, 1) <> 1 THEN
    RAISE EXCEPTION 'sale.lines_required: a sale carries 1..200 lines' USING ERRCODE = 'P0001';
  END IF;
  IF p_product_ids IS NULL OR cardinality(p_product_ids) <> v_n OR array_lower(p_product_ids, 1) <> 1
     OR p_merchant_variant_ids IS NULL OR cardinality(p_merchant_variant_ids) <> v_n OR array_lower(p_merchant_variant_ids, 1) <> 1
     OR p_stock_variant_ids IS NULL OR cardinality(p_stock_variant_ids) <> v_n OR array_lower(p_stock_variant_ids, 1) <> 1
     OR p_name_snapshots IS NULL OR cardinality(p_name_snapshots) <> v_n OR array_lower(p_name_snapshots, 1) <> 1
     OR p_quantities IS NULL OR cardinality(p_quantities) <> v_n OR array_lower(p_quantities, 1) <> 1
     OR p_unit_prices IS NULL OR cardinality(p_unit_prices) <> v_n OR array_lower(p_unit_prices, 1) <> 1
     OR p_gross IS NULL OR cardinality(p_gross) <> v_n OR array_lower(p_gross, 1) <> 1
     OR p_discounts IS NULL OR cardinality(p_discounts) <> v_n OR array_lower(p_discounts, 1) <> 1
     OR p_nets IS NULL OR cardinality(p_nets) <> v_n OR array_lower(p_nets, 1) <> 1
     OR p_base_shares IS NULL OR cardinality(p_base_shares) <> v_n OR array_lower(p_base_shares, 1) <> 1
     OR array_position(p_line_ids, NULL) IS NOT NULL OR array_position(p_product_ids, NULL) IS NOT NULL
     OR array_position(p_stock_variant_ids, NULL) IS NOT NULL OR array_position(p_name_snapshots, NULL) IS NOT NULL
     OR array_position(p_quantities, NULL) IS NOT NULL OR array_position(p_unit_prices, NULL) IS NOT NULL
     OR array_position(p_gross, NULL) IS NOT NULL OR array_position(p_discounts, NULL) IS NOT NULL
     OR array_position(p_nets, NULL) IS NOT NULL OR array_position(p_base_shares, NULL) IS NOT NULL
     OR p_settlement_mode IS NULL OR p_warehouse_id IS NULL OR p_branch_id IS NULL OR p_document_date IS NULL
     OR p_currency IS NULL OR p_rate IS NULL OR p_rate_source IS NULL OR p_rate_at IS NULL
     OR p_subtotal_txn_minor IS NULL OR p_discount_txn_minor IS NULL OR p_total_txn_minor IS NULL OR p_total_base_minor IS NULL THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a sale binds its mode, warehouse, branch, date, currency, rate, totals and complete lines'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_settlement_mode NOT IN ('cash', 'credit') THEN
    RAISE EXCEPTION 'sale.state_invalid: a settlement mode is cash or credit' USING ERRCODE = 'P0001';
  END IF;
  -- The two shapes `invoices_walkin_no_ar` (`0075:660`) would refuse at
  -- COMMIT, refused on the way in so no stock moves for a sale that cannot
  -- be posted.
  IF p_settlement_mode = 'credit' AND p_customer_id IS NULL THEN
    RAISE EXCEPTION 'sale.credit_requires_customer: a credit sale names the customer who owes it' USING ERRCODE = 'P0001';
  END IF;
  IF p_due_date IS NOT NULL AND (p_customer_id IS NULL OR p_settlement_mode <> 'credit') THEN
    RAISE EXCEPTION 'sale.walkin_terms_forbidden: a due date belongs to a credit sale with a named customer' USING ERRCODE = 'P0001';
  END IF;
  IF p_due_date IS NOT NULL AND p_due_date < p_document_date THEN
    RAISE EXCEPTION 'sale.due_date_invalid: a due date is not before the document date' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_line_ids) AS x(id) GROUP BY x.id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'sale.duplicate_line: two lines of one sale claim the same line id' USING ERRCODE = 'P0001';
  END IF;

  -- ── Step 5. The domain locks, in SALE_COMMIT_LOCK_ORDER, ONE order. ──
  --
  -- `businesses` (shared) → `customers` → then, inside the stock writer,
  -- `stock_levels` ascending by (warehouse_id, variant_id) → then, at step
  -- 10, `invoice_sequences` LAST (`P4-AL-32`). Never a retry
  -- ([[daftar-lock-order-not-retry]]): a retry is a second order.
  -- `businesses` and `customers` are READ here, not ROW-LOCKED, and the
  -- reason is a privilege rule rather than a preference. EVERY PostgreSQL
  -- locking clause — `FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE` and
  -- `FOR KEY SHARE` alike — requires `UPDATE` on the relation (relation
  -- level, or on any one column), so `SELECT … FOR SHARE` on the tenancy
  -- root would mean granting the inventory writer the right to WRITE
  -- `businesses`. That is a much larger authority than the lock is worth and
  -- no law in this slice rests on it: `purchase_receive` reads the same two
  -- business columns unlocked (`0064:1248`), and the two locks the slice's
  -- laws DO rest on are taken and paid for — `stock_levels` `FOR UPDATE`
  -- inside the writer (OD-P4-05, the last-item race) and
  -- `invoice_sequences` `FOR NO KEY UPDATE` at step 10 (P4-AL-31/32), for
  -- which §1 grants exactly one `UPDATE`.
  --
  -- The customer instead takes a SHARED ADVISORY lock on its own id, which
  -- PUBLIC may execute and which therefore adds no privilege at all: two
  -- concurrent sales of one customer serialise here. A true row lock on
  -- `customers` is a privilege decision, and it is reported as a Tech Lead
  -- review point rather than taken quietly.
  SELECT b.timezone, b.base_currency INTO v_tz, v_base_ccy
  FROM businesses b WHERE b.id = v_business;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'inventory.forbidden: the business does not exist' USING ERRCODE = 'P0001';
  END IF;
  IF p_customer_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock_shared(hashtext('daftar.customer_id'), hashtext(p_customer_id::text));
    SELECT c.name, c.phone, c.status INTO v_c
    FROM customers c WHERE c.business_id = v_business AND c.id = p_customer_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'sale.customer_not_found: the customer does not exist in this business' USING ERRCODE = 'P0001';
    END IF;
    IF v_c.status <> 'active' THEN
      RAISE EXCEPTION 'sale.customer_inactive: an inactive customer takes no sale' USING ERRCODE = 'P0001';
    END IF;
    v_cust_name  := v_c.name;
    v_cust_phone := v_c.phone;
  END IF;
  PERFORM sale_lock_commit_targets(p_warehouse_id, p_stock_variant_ids);

  -- ── Step 6. The last recompute (R-P4-S2-78-02). ──────────────────────
  --
  -- The branch is the WAREHOUSE's, never the client's: the service already
  -- resolves it that way and a sale whose branch disagreed with its
  -- warehouse would post its revenue to a dimension the stock never touched.
  SELECT w.branch_id INTO v_branch FROM warehouses w WHERE w.business_id = v_business AND w.id = p_warehouse_id;
  IF v_branch IS DISTINCT FROM p_branch_id THEN
    RAISE EXCEPTION 'sale.state_changed: the warehouse''s branch is not the bound one' USING ERRCODE = 'P0001';
  END IF;

  -- The document date, in the business timezone, read from the catalogue and
  -- not from any argument: `now()` here decides nothing that is hashed.
  IF p_document_date > (now() AT TIME ZONE v_tz)::date THEN
    RAISE EXCEPTION 'sale.document_date_in_future: a sale is committed on or before today in the business timezone' USING ERRCODE = 'P0001';
  END IF;

  -- The catalogue, per line, in the service's own order: the product the
  -- stock variant belongs to, its price in its own currency, and its name in
  -- the first readable locale. One currency for the whole sale; a mixed
  -- basket is refused rather than converted at a cross-rate nobody stated.
  SELECT array_agg(x.product ORDER BY x.i), array_agg(x.price ORDER BY x.i), array_agg(x.nm ORDER BY x.i)
    INTO v_products, v_prices, v_names
  FROM (
    SELECT l.i AS i, p.id AS product,
           coalesce(pv.price_minor, p.base_price_minor) AS price,
           -- The name is read from `product_translations` (`0036:9`) and NOT
           -- from a `products.translations` JSONB column: `0036` normalized
           -- the translations into their own relation and DROPPED that
           -- column, so a query against it raises `42703`
           -- ([[daftar-the-live-catalogue-is-the-policy]]). The locale
           -- preference is ar, then en, then tr, which is the order the
           -- reader states.
           (SELECT t.name FROM product_translations t
             WHERE t.business_id = p.business_id AND t.product_id = p.id
             ORDER BY array_position(ARRAY['ar', 'en', 'tr'], t.locale) LIMIT 1) AS nm,
           p.price_currency AS ccy
    FROM unnest(p_stock_variant_ids) WITH ORDINALITY AS l(variant, i)
    JOIN product_variants pv ON pv.business_id = v_business AND pv.id = l.variant
    JOIN products p ON p.business_id = pv.business_id AND p.id = pv.product_id
  ) AS x;
  IF coalesce(cardinality(v_products), 0) <> v_n THEN
    RAISE EXCEPTION 'sale.product_not_found: a sale line names a variant this business does not hold' USING ERRCODE = 'P0001';
  END IF;
  IF array_position(v_prices, NULL) IS NOT NULL OR array_position(v_names, NULL) IS NOT NULL
     OR EXISTS (SELECT 1 FROM unnest(v_names) AS x(nm) WHERE btrim(x.nm) = '') THEN
    RAISE EXCEPTION 'sale.product_not_priced: a sale line names a product with no price or no readable name' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(p_stock_variant_ids) AS l(variant)
    JOIN product_variants pv ON pv.business_id = v_business AND pv.id = l.variant
    JOIN products p ON p.business_id = pv.business_id AND p.id = pv.product_id
    WHERE p.price_currency IS DISTINCT FROM p_currency::text
  ) THEN
    RAISE EXCEPTION 'sale.currency_unknown: every line of a sale is priced in one currency' USING ERRCODE = 'P0001';
  END IF;
  IF v_products IS DISTINCT FROM p_product_ids OR v_prices IS DISTINCT FROM p_unit_prices
     OR v_names IS DISTINCT FROM p_name_snapshots THEN
    RAISE EXCEPTION 'sale.state_changed: the catalogue changed since the sale was priced' USING ERRCODE = 'P0001';
  END IF;

  -- gross = HALF_EVEN(qty_q4 × price_minor / 10^4), ONCE, from the exact
  -- fixed-point operands — the same arithmetic as `halfEvenDiv` in the
  -- service and as `inventory_half_even`, because a second rounding rule
  -- disagrees only on the numbers nobody tested
  -- ([[daftar-rounding-is-not-additive]]).
  v_gross := ARRAY[]::bigint[];
  v_nets  := ARRAY[]::bigint[];
  FOR v_i IN 1 .. v_n LOOP
    IF p_quantities[v_i] <= 0 THEN
      RAISE EXCEPTION 'sale.quantity_invalid: a sale line quantity is positive' USING ERRCODE = 'P0001';
    END IF;
    v_gross := v_gross || inventory_half_even(p_quantities[v_i] * 10000::numeric * v_prices[v_i]::numeric, 10000::numeric, 0)::bigint;
    IF p_discounts[v_i] < 0 OR p_discounts[v_i] > v_gross[v_i] THEN
      RAISE EXCEPTION 'sale.discount_invalid: a line discount is between zero and its gross' USING ERRCODE = 'P0001';
    END IF;
    v_nets := v_nets || (v_gross[v_i] - p_discounts[v_i]);
  END LOOP;
  IF v_gross IS DISTINCT FROM p_gross OR v_nets IS DISTINCT FROM p_nets THEN
    RAISE EXCEPTION 'sale.state_changed: the line amounts changed since the sale was priced' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT sum(x.g) FROM unnest(v_gross) AS x(g)) <> p_subtotal_txn_minor
     OR (SELECT sum(x.d) FROM unnest(p_discounts) AS x(d)) <> p_discount_txn_minor
     OR p_total_txn_minor <> p_subtotal_txn_minor - p_discount_txn_minor THEN
    RAISE EXCEPTION 'sale.state_changed: the sale totals are not the sum of its lines' USING ERRCODE = 'P0001';
  END IF;
  IF p_total_txn_minor <= 0 THEN
    RAISE EXCEPTION 'sale.total_zero: a sale total is positive' USING ERRCODE = 'P0001';
  END IF;

  -- The FX snapshot, re-derived at the instant the document date implies —
  -- no clock, the instant is derived (A-17, R-17). `accounting_purchase_fx_rate`
  -- (`0063:1656`) is the accounting-owned, business-scoped reader already
  -- granted to this role (`0063:1704`); its body is generic and a sale needs
  -- exactly what it does. Its NAME says purchase and cannot be changed,
  -- because `0063` is immutable — reported rather than worked around.
  IF p_currency::text = v_base_ccy THEN
    v_rate_id := NULL;
    v_rate    := 1;
    v_source  := 'base';
    v_at      := p_document_date::timestamp AT TIME ZONE 'UTC';
  ELSE
    v_fx := accounting_purchase_fx_rate(v_business, p_currency,
                                        ((p_document_date + 1)::timestamp AT TIME ZONE v_tz) - interval '1 second');
    v_rate_id := v_fx.rate_id;
    v_rate    := v_fx.rate;
    v_source  := v_fx.source;
    v_at      := v_fx.effective_at;
  END IF;
  IF p_rate_id IS DISTINCT FROM v_rate_id OR p_rate <> v_rate OR p_rate_source <> v_source OR p_rate_at <> v_at THEN
    RAISE EXCEPTION 'sale.state_changed: the exchange rate changed since the sale was priced' USING ERRCODE = 'P0001';
  END IF;

  -- B = HALF_EVEN(T × rate × 10^(e_b − e_t)), and the shares are the LARGEST
  -- REMAINDER partition of that ONE conversion over the line nets — never
  -- `n` separate conversions, and never a rounding account (`P4-AL-19`).
  SELECT c.minor_units INTO v_et FROM currencies c WHERE c.code = p_currency::text;
  SELECT c.minor_units INTO v_eb FROM currencies c WHERE c.code = v_base_ccy;
  IF v_et IS NULL OR v_eb IS NULL THEN
    RAISE EXCEPTION 'sale.currency_unknown: a sale is priced in a registered currency' USING ERRCODE = 'P0001';
  END IF;
  v_base_total := inventory_half_even(p_total_txn_minor * v_rate * power(10::numeric, greatest(0, v_eb - v_et)),
                                      power(10::numeric, greatest(0, v_et - v_eb)), 0);
  IF v_base_total <= 0 THEN
    RAISE EXCEPTION 'sale.total_zero: a sale total is positive in the base currency' USING ERRCODE = 'P0001';
  END IF;
  IF v_base_total > 1000000000000000000 THEN
    RAISE EXCEPTION 'inventory.value_out_of_range: the sale base total is outside the supported range' USING ERRCODE = 'P0001';
  END IF;
  v_shares := inventory_largest_remainder(v_nets::numeric[], v_base_total::bigint);
  IF v_base_total <> p_total_base_minor OR v_shares IS DISTINCT FROM p_base_shares THEN
    RAISE EXCEPTION 'sale.state_changed: the base amounts changed since the sale was priced' USING ERRCODE = 'P0001';
  END IF;

  -- ── Step 7. The header, then the lines. ──────────────────────────────
  --
  -- INSERTed as `confirmed`, and with NO accounting binding yet.
  --
  -- C-09 step 7 says `binding_source_id = id`, and that is right for every
  -- sale that owes a COGS entry — but it cannot be UNCONDITIONAL once the
  -- zero-cost sale is real. A sale of stock whose stored valuation is zero
  -- owes NO `sale` entry (`journal_lines_money_cap_ck`, `0042:225`, refuses a
  -- zero-amount line), so a `binding_source_id` written here would leave the
  -- deferred `sales_binding_fk` pointing at a binding nobody posts and the
  -- COMMIT would fail with `23503` — which is exactly what it did before this
  -- was fixed, and it refused the lawful sale rather than an unlawful one.
  --
  -- The obligation is conditional on a number no row holds, and the movements
  -- that carry it cannot exist before this header does, because
  -- `sale_items_sale_fk` and the bridge's line FK are both immediate. So the
  -- header goes in with NULL, step 9b learns the cost from the movements
  -- already written, and sets the binding exactly when the cost is non-zero.
  -- `0077`'s `sale_header_guard()` admits that one transition and no other:
  -- NULL may become this sale's own id, once.
  --
  -- `tax_minor` is written as 0 by this routine and by nobody's argument.
  INSERT INTO sales (tenant_id, business_id, id, customer_id, branch_id, warehouse_id, status, settlement_mode,
                     document_date, currency_code, subtotal_txn_minor, discount_txn_minor, tax_minor,
                     total_txn_minor, total_base_minor, source_to_base_rate, rate_source, rate_timestamp, fx_rate_id,
                     customer_name_snapshot, notes, commit_intent_sha256, confirmed_by, confirmed_at,
                     business_transaction_id, created_by)
  VALUES (v_tenant, v_business, p_sale_id, p_customer_id, v_branch, p_warehouse_id, 'confirmed', p_settlement_mode,
          p_document_date, p_currency, p_subtotal_txn_minor, p_discount_txn_minor, 0,
          p_total_txn_minor, v_base_total::bigint, v_rate, v_source, v_at, v_rate_id,
          v_cust_name, p_notes, v_intent, v_actor.actor_user_id, now(),
          v_trace, v_actor.actor_user_id);

  INSERT INTO sale_items (tenant_id, business_id, sale_id, id, line_no, product_id, variant_id, name_snapshot,
                          quantity, unit_price_txn_minor, gross_txn_minor, discount_txn_minor, net_txn_minor,
                          tax_minor, base_share_minor)
  SELECT v_tenant, v_business, p_sale_id, x.line_id, x.i, x.product, x.variant, x.nm,
         x.qty, x.price, x.gross, x.disc, x.net, 0, x.share
  FROM unnest(p_line_ids, v_products, p_stock_variant_ids, v_names, p_quantities, v_prices, v_gross, p_discounts, v_nets, v_shares)
         WITH ORDINALITY AS x(line_id, product, variant, nm, qty, price, gross, disc, net, share, i);

  -- ── Step 8. The movements. The writer is NOT changed (R-P4-S2-78-06). ─
  --
  -- One request per line, `movement_kind = 'sale'`, `qty_delta = -quantity` —
  -- the sign is the ROUTINE's and never the client's, which states a positive
  -- quantity — and both cost columns NULL, so the value is computed under the
  -- stock key's own `FOR UPDATE`. That is also where
  -- `inventory.insufficient_stock` is raised (OD-P4-05), and it is the
  -- last-item race mechanism.
  v_reqs := ARRAY[]::inventory_movement_request[];
  FOR v_i IN 1 .. v_n LOOP
    v_reqs := v_reqs
      || ROW(p_warehouse_id, p_stock_variant_ids[v_i], 'sale', 'sale', p_sale_id, p_line_ids[v_i],
             -p_quantities[v_i], NULL, NULL, NULL)::inventory_movement_request;
  END LOOP;
  PERFORM 1 FROM inventory_apply_stock_movements(v_reqs);

  -- ── Step 9. The bridge, from the bindings the writer just created. ───
  v_bridged := sale_bridge_commit(p_sale_id);
  IF v_bridged <> v_n THEN
    RAISE EXCEPTION 'inventory.source_binding_missing: the sale bridged % of its % lines', v_bridged, v_n USING ERRCODE = 'P0001';
  END IF;

  -- ── Step 9b. The cost, and the binding it decides. ──────────────────
  --
  -- Σ of the stored `value_delta_base_minor` integers of the movements this
  -- transaction just wrote, read back through `inventory_sale_cost_base_minor`
  -- (`0077`). NEVER `quantity × average_cost` (`P4-AL-25`). NULL means no
  -- bridged movement at all, which step 9 already refused, and is refused
  -- again here rather than treated as a cost of zero — the difference between
  -- "nothing was owed" and "nothing was measured" is the whole vacuity
  -- question.
  --
  -- It is 0 — not NULL — for a sale of stock whose stored valuation is zero:
  -- the bridge rows exist and their movements carry a zero value
  -- (`0060:388-390`), and a zero-valued key is reachable because
  -- `0060:398-406` accepts an INBOUND at a unit cost of exactly 0, its only
  -- gate being `v_snapshot < 0`. That case is LAWFUL and is deliberately NOT
  -- refused: the caller posts the revenue entry alone, this sale takes no
  -- binding, and the DEFERRED `sales_cogs_owed` proves at COMMIT that
  -- nothing was owed.
  v_cogs := inventory_sale_cost_base_minor(v_business, p_sale_id);
  IF v_cogs IS NULL THEN
    RAISE EXCEPTION 'inventory.source_binding_missing: the committed sale carries no bridged movement, so its cost cannot be judged'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_cogs <> 0 THEN
    UPDATE sales s SET binding_source_id = p_sale_id
     WHERE s.business_id = v_business AND s.id = p_sale_id;
  END IF;

  -- ── Step 10. The number, LAST of the domain locks (P4-AL-32). ────────
  --
  -- The series row is CREATED ON FIRST USE, then held `FOR NO KEY UPDATE`,
  -- and the ordinal is read as `max + 1` from `invoices` under that lock;
  -- there is no counter column to bump (`0075:29-33`, `P4-AL-31`) and the
  -- ordinal is never stored on the series row (R-P4-S2-78-04).
  -- `invoices_number_uq` is the backstop: a missed lock is a refusal, never
  -- a duplicate number.
  --
  -- The period is the DOCUMENT DATE's year and nothing else — not `now()`,
  -- not the business timezone's today (R-P4-S2-78-01): a series the server
  -- picked from the clock is a series the fingerprint does not cover.
  v_period := to_char(p_document_date, 'YYYY');

  -- TL-P4-S2-R4. The first invoice of a `(business, year)` creates its own
  -- series row rather than refusing. `DO NOTHING` — never `DO UPDATE` — so a
  -- row that is ALREADY there keeps its `number_format` untouched, whatever
  -- the merchant has set it to; and two concurrent first sales of a new year
  -- produce exactly ONE row, because the loser's insert waits on the
  -- winner's transaction and then does nothing. The INSERT is HERE, at step
  -- 10, and not earlier: `invoice_sequences` is LAST in the lock order
  -- (`P4-AL-32`) and this statement must not move it forward. It adds no
  -- lock-order edge of its own — its one FK, `invoice_sequences_tenant_fk`,
  -- needs the same `businesses` `FOR KEY SHARE` that `sales_tenant_fk` took
  -- at step 6. No retry loop: a retry is a second order
  -- ([[daftar-lock-order-not-retry]]).
  --
  -- `INV-{YYYY}-{SEQ:6}` is the DEFAULT OUT-OF-BOX DAFTAR-INTERNAL format
  -- and is NOT a claim of fiscal or tax compliance in any jurisdiction
  -- (OD-03 REMAINS OPEN, `P4-AL-45`). `{SEQ:6}` rather than the ruling's
  -- `{SEQ:06}` because `invoice_sequences_format_ck` (`0075:379`) admits no
  -- leading zero in the width and `0075` is frozen; both spell the same
  -- six-digit zero-padded ordinal. See R-P4-S2-78-03.
  INSERT INTO invoice_sequences (tenant_id, business_id, document_kind, period, number_format)
  VALUES (v_tenant, v_business, 'invoice', v_period, 'INV-{YYYY}-{SEQ:6}')
  ON CONFLICT (business_id, document_kind, period) DO NOTHING;

  -- THEN the lock, on that exact row. After the statement above, in READ
  -- COMMITTED, the row is there and visible: either this transaction
  -- inserted it, or the concurrent inserter it waited on committed its own.
  -- The `NOT FOUND` arm is therefore a can't-happen backstop and no longer
  -- the product's answer to a clean business — it survives as a refusal
  -- rather than as a silent NULL `number_format`.
  SELECT s.number_format INTO v_format
  FROM invoice_sequences s
  WHERE s.business_id = v_business AND s.document_kind = 'invoice' AND s.period = v_period
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sale.issue_invoice: the invoice series for % could not be read back after its initialisation', v_period
      USING ERRCODE = 'P0001';
  END IF;
  SELECT coalesce(max(i.number_seq), 0) + 1 INTO v_seq
  FROM invoices i
  WHERE i.business_id = v_business AND i.document_kind = 'invoice' AND i.period = v_period;
  v_number := sale_document_number(v_format, v_period, v_seq);

  -- INSERTed directly as `open`: `invoices_lifecycle_guard` is BEFORE UPDATE
  -- only (`0075:553`), so an INSERT in the posted state is permitted and a
  -- draft nobody asked for is not created. `binding_source_id = id` makes the
  -- invoice's own deferred FK the all-or-nothing mechanism of the revenue
  -- entry, exactly as the sale's is of the COGS entry.
  INSERT INTO invoices (tenant_id, business_id, id, sale_id, customer_id, branch_id, document_kind, document_number,
                        number_seq, period, issue_date, due_date, currency_code, status, notes,
                        subtotal_txn_minor, discount_txn_minor, tax_minor, total_txn_minor, total_base_minor,
                        source_to_base_rate, rate_source, rate_timestamp, fx_rate_id,
                        customer_name_snapshot, customer_phone_snapshot, issue_intent_sha256,
                        business_transaction_id, created_by, binding_source_id)
  VALUES (v_tenant, v_business, p_invoice_id, p_sale_id, p_customer_id, v_branch, 'invoice', v_number,
          v_seq, v_period, p_document_date, p_due_date, p_currency, 'open', p_notes,
          p_subtotal_txn_minor, p_discount_txn_minor, 0, p_total_txn_minor, v_base_total::bigint,
          v_rate, v_source, v_at, v_rate_id,
          v_cust_name, v_cust_phone, v_intent,
          v_trace, v_actor.actor_user_id, p_invoice_id);

  -- The invoice line carries the MERCHANT variant the request named, which is
  -- nullable because a product with no merchant variants has none and the
  -- hidden base variant never leaves the server (P3-AL-52). The sale line
  -- carries the resolved STOCK variant, which is what the movement is keyed
  -- on. Two columns, two different facts, and neither is derivable from the
  -- other.
  INSERT INTO invoice_items (tenant_id, business_id, invoice_id, id, line_no, product_id, variant_id, name_snapshot,
                             quantity, unit_price_txn_minor, gross_txn_minor, discount_txn_minor, net_txn_minor,
                             tax_minor, base_share_minor)
  SELECT v_tenant, v_business, p_invoice_id, x.line_id, x.i, x.product, x.variant, x.nm,
         x.qty, x.price, x.gross, x.disc, x.net, 0, x.share
  FROM unnest(p_line_ids, v_products, p_merchant_variant_ids, v_names, p_quantities, v_prices, v_gross, p_discounts, v_nets, v_shares)
         WITH ORDINALITY AS x(line_id, product, variant, nm, qty, price, gross, disc, net, share, i);

  -- Audit and outbox (A-21): ids, not amounts.
  INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
  VALUES (v_tenant, v_business, v_actor.actor_user_id, 'sale.committed', 'sale', p_sale_id::text,
          jsonb_build_object('warehouseId', p_warehouse_id, 'customerId', p_customer_id, 'invoiceId', p_invoice_id,
                             'settlementMode', p_settlement_mode, 'lineCount', v_n,
                             'assertionJti', v_actor.jti, 'business_transaction_id', v_trace));
  INSERT INTO outbox_events (tenant_id, business_id, type, payload)
  VALUES (v_tenant, v_business, 'sale.committed.v1',
          jsonb_build_object('businessId', v_business, 'saleId', p_sale_id, 'invoiceId', p_invoice_id,
                             'businessTransactionId', v_trace));

  -- ── Step 11. The COGS the caller compares against its signed figure. ─
  --
  -- The figure A-08's mechanism 1 compares against the signed prediction,
  -- measured at step 9b from the one place the truth lives. The replay path
  -- returns the same function's value, so the two paths cannot disagree.
  RETURN QUERY SELECT false, v_cogs;
END;
$$;

COMMENT ON FUNCTION sale_commit(UUID, UUID, TEXT, UUID, UUID, UUID, DATE, DATE, CHAR(3), UUID, NUMERIC, TEXT, TIMESTAMPTZ,
                                BIGINT, BIGINT, BIGINT, BIGINT, TEXT, UUID[], UUID[], UUID[], UUID[], TEXT[], NUMERIC[],
                                BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[]) IS
  'P4-S2 C-09. The trusted atomic sale command: consumes the sale.commit invctl/1 assertion over its own 29 arguments, takes the per-document advisory lock, re-derives and compares the request-only intent digest before reading any state (replay returns (true, the stored COGS) having written nothing; a different intent is sale.idempotency_conflict), takes the domain locks in SALE_COMMIT_LOCK_ORDER, RECOMPUTES every amount from the catalogue and refuses sale.state_changed on any disagreement, inserts sales as confirmed with NO binding and sale_items, calls inventory_apply_stock_movements with both cost columns NULL so the writer values the movement and raises inventory.insufficient_stock under the stock key lock, bridges the bindings, sets binding_source_id to the sale itself exactly when the bridged value is non-zero (a zero-cost sale owes no COGS entry, so it keeps a NULL binding), creates the (business, document-date year) invoice series row on first use with the default DAFTAR-internal format INV-{YYYY}-{SEQ:6} if it is not there (INSERT ... ON CONFLICT DO NOTHING, so an existing number_format is never overwritten; TL-P4-S2-R4, and no jurisdiction fiscal rule is implied - OD-03 is OPEN), allocates the invoice ordinal as max+1 while holding that series row FOR NO KEY UPDATE and inserts invoices as open with invoice_items, and returns (false, the summed value deltas). Writes NO journal line. Reads NO clock into anything hashed. Admits the ZERO-valued sale, whose COGS is 0 and whose obligation is judged by the deferred sales_cogs_owed. SECURITY DEFINER, owned by daftar_inventory_internal, EXECUTE to daftar_app only.';

-- ─────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────
-- 4. One correction to `0077`, as a REPLACEMENT rather than an edit.
--
--    `0077`'s `accounting_sale_entry_complete()` requires the COGS line to
--    carry a NULL `warehouse_id`, on the purchase entry's precedent
--    (`0063:1584-1585`, where the counter-account is Accounts Payable). That
--    is WRONG for a sale, and the landed accounting code says so with a
--    better citation: `deriveSaleCogsEntryLines`
--    (`packages/accounting/src/sale-posting.ts:632-650`) puts the sale's
--    warehouse on BOTH lines, because the one accepted Inventory/COGS PAIR in
--    the tree — `accounting_negative_inventory_cost_adjustment_entry_complete`
--    (`0063:1640-1643`) — requires `warehouse_id IS NOT DISTINCT FROM v_wh`
--    on every line of the entry, its COGS line included. Accounts Payable is
--    a supplier fact with no warehouse; cost of goods sold is not.
--
--    Measured, not reasoned: with `0077`'s arm in force the first end-to-end
--    sale is refused `accounting.selling_entry_mismatch` at COMMIT, and the
--    whole P4-AL-16 atomic path is unreachable.
--
--    `0077` is NOT edited. It is merged, other agents have applied it, and an
--    edit would change its checksum and fail every one of their databases
--    with `Migration tampered after apply`. A `CREATE OR REPLACE` in a NEW
--    migration is the accepted mechanism and the one `0063`, `0065`, `0067`
--    and `0072` each used on this very estate. The body below is `0077`'s
--    text byte for byte except the one `warehouse_id` comparison, and it is
--    replaced BY ITS OWNER, so no ownership changes hands.
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;
SET LOCAL ROLE daftar_accounting_internal;

CREATE OR REPLACE FUNCTION accounting_sale_entry_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_s      RECORD;
  v_branch UUID;
  v_cost   BIGINT;
  v_lines  INTEGER;
  v_inv    INTEGER;
  v_cogs   INTEGER;
  v_inv_ok BOOLEAN;
  v_cogs_ok BOOLEAN;
BEGIN
  SELECT s.id, s.document_date, s.warehouse_id, s.status INTO v_s
  FROM sales s
  WHERE s.business_id = NEW.business_id AND s.binding_source_id = NEW.source_id AND s.status <> 'draft';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accounting.selling_detail_missing: a sale entry must be registered by its confirmed sale in the same transaction'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT w.branch_id INTO v_branch FROM warehouses w WHERE w.business_id = NEW.business_id AND w.id = v_s.warehouse_id;
  v_cost := inventory_sale_cost_base_minor(NEW.business_id, v_s.id);
  -- NULL means the sale carries no bridged movement at all, and zero means a
  -- sale of zero-average-cost stock, which posts NO `sale` entry — this
  -- validator judges an entry that EXISTS, so either one means the entry
  -- should not be here. The opposite direction (a non-zero cost with no
  -- entry) is `sales_cogs_owed`'s, because no entry exists for a trigger on
  -- `journal_entries` to fire on.
  IF v_cost IS NULL OR v_cost <= 0 THEN
    RAISE EXCEPTION 'accounting.selling_detail_missing: a sale entry must be posted for the cost its own stock movements carry'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE a.system_key = 'inventory'),
         count(*) FILTER (WHERE a.system_key = 'cogs'),
         coalesce(bool_and(l.credit_minor = v_cost AND l.debit_minor = 0
                           AND l.warehouse_id IS NOT DISTINCT FROM v_s.warehouse_id AND l.branch_id IS NOT DISTINCT FROM v_branch)
                    FILTER (WHERE a.system_key = 'inventory'), false),
         coalesce(bool_and(l.debit_minor = v_cost AND l.credit_minor = 0
                           AND l.warehouse_id IS NOT DISTINCT FROM v_s.warehouse_id
                           AND l.branch_id IS NOT DISTINCT FROM v_branch)
                    FILTER (WHERE a.system_key = 'cogs'), false)
    INTO v_lines, v_inv, v_cogs, v_inv_ok, v_cogs_ok
  FROM journal_lines l
  JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
  WHERE l.business_id = NEW.business_id AND l.journal_entry_id = NEW.id;

  IF NEW.entry_date IS DISTINCT FROM v_s.document_date OR v_branch IS NULL
     OR v_lines <> 2 OR v_inv <> 1 OR v_cogs <> 1 OR NOT v_inv_ok OR NOT v_cogs_ok
     OR EXISTS (SELECT 1 FROM journal_lines l
                 WHERE l.business_id = NEW.business_id AND l.journal_entry_id = NEW.id
                   AND (l.txn_currency IS DISTINCT FROM l.base_currency
                        OR l.txn_amount_minor IS DISTINCT FROM v_cost
                        OR l.fx_rate_source IS DISTINCT FROM 'base')) THEN
    RAISE EXCEPTION 'accounting.selling_entry_mismatch: a sale entry is not exactly the COGS debit and Inventory credit of its own stock movements'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Two performed proofs, BEFORE the privileges are narrowed.
--
--    They run here and not at the end because the applier is not a grantee
--    of either routine once section 5 has run: `REVOKE ALL … FROM PUBLIC`
--    and `OWNER TO daftar_inventory_internal` leave `EXECUTE` with
--    `daftar_app` alone, and a proof the applier cannot perform is not a
--    proof. Behaviour is what is proven, and behaviour does not depend on
--    who may call it. Each PERFORMS the claim in a subtransaction and
--    rolls it back, and each handler reads CONSTRAINT_NAME / SQLSTATE so a
--    probe that trips something else is reported as a DEFECTIVE PROBE rather
--    than as a proof (the 0074 pattern).
-- ─────────────────────────────────────────────────────────────────────────
DO $proof$
DECLARE
  v_msg TEXT;
BEGIN
  -- (a) The renderer pads and never truncates, and refuses a format that
  --     states only one of the two placeholders.
  -- The DEFAULT of TL-P4-S2-R4, rendered: a six-digit zero-padded first
  -- ordinal, and a format `invoice_sequences_format_ck` (`0075:379`) admits.
  -- A DAFTAR-INTERNAL identifier; no jurisdiction's law is encoded (OD-03
  -- is OPEN, `P4-AL-45`).
  IF sale_document_number('INV-{YYYY}-{SEQ:6}', '2026', 1) <> 'INV-2026-000001' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the default internal numbering format does not render a six-digit zero-padded first ordinal'
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 WHERE 'INV-{YYYY}-{SEQ:6}' ~ '^[A-Za-z0-9/-]*\{YYYY\}[A-Za-z0-9/-]*\{SEQ:[1-9][0-9]?\}[A-Za-z0-9/-]*$'
                              AND char_length('INV-{YYYY}-{SEQ:6}') BETWEEN 8 AND 64) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the default internal numbering format is not one invoice_sequences_format_ck admits'
      USING ERRCODE = 'P0001';
  END IF;
  IF sale_document_number('INV-{YYYY}-{SEQ:5}', '2026', 7) <> 'INV-2026-00007' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: proof(a): the renderer does not pad the ordinal' USING ERRCODE = 'P0001';
  END IF;
  IF sale_document_number('INV-{YYYY}-{SEQ:2}', '2026', 1234) <> 'INV-2026-1234' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: proof(a): the renderer truncates an ordinal wider than its field' USING ERRCODE = 'P0001';
  END IF;
  BEGIN
    PERFORM sale_document_number('INV-{YYYY}-X', '2026', 1);
    RAISE EXCEPTION 'selling.migration_end_state_invalid: proof(a): a format with no ordinal placeholder was accepted' USING ERRCODE = 'P0001';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF position('selling.sequence_format_invalid' IN v_msg) = 0 THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: proof(a) is a DEFECTIVE PROBE — it raised %', v_msg USING ERRCODE = 'P0001';
    END IF;
  END;

  -- (b) The unsigned-call refusal is NOT performed here, and the reason is
  --      worth recording rather than hiding behind a missing probe. Before
  --      section 5 the routine is still owned by the applier, so its
  --      `SECURITY DEFINER` body runs as the applier and dies on
  --      `permission denied for function inventory_fixed_text` — the digest
  --      helper is evaluated as an ARGUMENT of
  --      `inventory_assertion_consume`, before the verifier is entered at
  --      all, which is the house pattern `purchase_receive` has too. After
  --      section 5 the applier is not a grantee. So the claim is made
  --      structurally instead, at 0078-E(11): the first executable statement
  --      of the body is the consume. A PERFORMED proof of the refusal is
  --      owed by a suite with fixtures, which can call it as `daftar_app`.
END;
$proof$;

-- 6. Privileges, then ownership (R-P4-S2-78-05).
-- ─────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION sale_lock_commit_targets(UUID, UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION sale_document_number(TEXT, TEXT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION sale_bridge_commit(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION sale_commit(UUID, UUID, TEXT, UUID, UUID, UUID, DATE, DATE, CHAR(3), UUID, NUMERIC, TEXT, TIMESTAMPTZ,
                                   BIGINT, BIGINT, BIGINT, BIGINT, TEXT, UUID[], UUID[], UUID[], UUID[], TEXT[], NUMERIC[],
                                   BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION sale_commit(UUID, UUID, TEXT, UUID, UUID, UUID, DATE, DATE, CHAR(3), UUID, NUMERIC, TEXT, TIMESTAMPTZ,
                                      BIGINT, BIGINT, BIGINT, BIGINT, TEXT, UUID[], UUID[], UUID[], UUID[], TEXT[], NUMERIC[],
                                      BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[]) TO daftar_app;

ALTER FUNCTION sale_lock_commit_targets(UUID, UUID[]) OWNER TO daftar_inventory_internal;
ALTER FUNCTION sale_document_number(TEXT, TEXT, BIGINT) OWNER TO daftar_inventory_internal;
ALTER FUNCTION sale_bridge_commit(UUID) OWNER TO daftar_inventory_internal;
ALTER FUNCTION sale_commit(UUID, UUID, TEXT, UUID, UUID, UUID, DATE, DATE, CHAR(3), UUID, NUMERIC, TEXT, TIMESTAMPTZ,
                           BIGINT, BIGINT, BIGINT, BIGINT, TEXT, UUID[], UUID[], UUID[], UUID[], TEXT[], NUMERIC[],
                           BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[]) OWNER TO daftar_inventory_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 7. 0078-E — the end state, read from the live catalogues and not from this
--    file's own text. Every claim is numbered so a failure names itself.
-- ─────────────────────────────────────────────────────────────────────────
DO $end$
DECLARE
  c_commit CONSTANT TEXT := 'sale_commit(uuid,uuid,text,uuid,uuid,uuid,date,date,char,uuid,numeric,text,timestamptz,'
                         || 'bigint,bigint,bigint,bigint,text,uuid[],uuid[],uuid[],uuid[],text[],numeric[],'
                         || 'bigint[],bigint[],bigint[],bigint[],bigint[])';
  v_def      TEXT;
  v_n        INTEGER;
  v_defaults INTEGER;
  v_name     TEXT;
BEGIN
  -- (1) The four routines exist, at exactly these signatures.
  FOREACH v_name IN ARRAY ARRAY[c_commit, 'sale_lock_commit_targets(uuid,uuid[])',
                                'sale_document_number(text,text,bigint)', 'sale_bridge_commit(uuid)'] LOOP
    IF to_regprocedure(v_name) IS NULL THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: 0078-E(1): % is not in the catalogue', v_name USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- (2) The routine takes 29 arguments, none of them with a DEFAULT, and
  --     returns the two-column set the service selects from.
  SELECT p.pronargs, p.pronargdefaults INTO v_n, v_defaults
  FROM pg_proc p WHERE p.oid = c_commit::regprocedure;
  IF v_n <> 29 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0078-E(2): sale_commit takes % arguments, not C-09''s 29', v_n USING ERRCODE = 'P0001';
  END IF;
  IF v_defaults <> 0 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0078-E(2): an argument of sale_commit carries a DEFAULT, which C-09 forbids'
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = c_commit::regprocedure
                  AND p.proretset AND p.proargmodes IS NOT NULL
                  AND (SELECT count(*) FROM unnest(p.proargmodes) AS m(x) WHERE m.x = 't') = 2) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0078-E(2): sale_commit does not RETURN TABLE with exactly two columns'
      USING ERRCODE = 'P0001';
  END IF;

  -- (3) Security mode, path and owner, for all four.
  FOREACH v_name IN ARRAY ARRAY[c_commit, 'sale_lock_commit_targets(uuid,uuid[])',
                                'sale_document_number(text,text,bigint)', 'sale_bridge_commit(uuid)'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_name::regprocedure
                    AND p.prosecdef
                    AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']
                    AND p.proowner = (SELECT r.oid FROM pg_roles r WHERE r.rolname = 'daftar_inventory_internal')) THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: 0078-E(3): % is not a pinned-path SECURITY DEFINER owned by daftar_inventory_internal', v_name
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- (4) EXECUTE on the entry routine belongs to daftar_app and to nobody
  --     else but its owner; the three helpers have NO grantee but the owner.
  IF NOT has_function_privilege('daftar_app', c_commit::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0078-E(4): daftar_app cannot execute sale_commit' USING ERRCODE = 'P0001';
  END IF;
  FOR v_name IN
    SELECT x.grantee::text FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS x
    WHERE p.oid = c_commit::regprocedure AND x.privilege_type = 'EXECUTE'
      AND x.grantee <> p.proowner AND x.grantee <> (SELECT r.oid FROM pg_roles r WHERE r.rolname = 'daftar_app')
  LOOP
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0078-E(4): % also holds EXECUTE on sale_commit', v_name USING ERRCODE = 'P0001';
  END LOOP;
  FOREACH v_name IN ARRAY ARRAY['sale_lock_commit_targets(uuid,uuid[])', 'sale_document_number(text,text,bigint)',
                                'sale_bridge_commit(uuid)'] LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p
                CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS x
                WHERE p.oid = v_name::regprocedure AND x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner) THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: 0078-E(4): % carries an EXECUTE grant, and reachability is authority', v_name
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- (5) The body, read from `pg_proc.prosrc` rather than from this file:
  --     no clock default, and the sequence row is CREATED ONCE, LOCKED, and
  --     never rewritten. TL-P4-S2-R4 replaced the older reading of this
  --     check — which asserted the routine writes `invoice_sequences`
  --     NOWHERE — because a routine that cannot create the row leaves a
  --     clean business with no path to its first invoice. What the privilege
  --     argument actually needs is narrower and is what is asserted now:
  --     exactly ONE insert, `ON CONFLICT … DO NOTHING`, and no UPDATE or
  --     DELETE at all. A `DO UPDATE` would overwrite a merchant's
  --     `number_format` with the default on every sale, which is the defect
  --     the old blanket check was standing in for.
  SELECT p.prosrc INTO v_def FROM pg_proc p WHERE p.oid = c_commit::regprocedure;
  IF v_def ~* 'coalesce\s*\(\s*p_(document_date|due_date)' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0078-E(5): a date argument is defaulted inside the routine (P4-AL-30)'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_def ~* '\mupdate\s+(public\.)?invoice_sequences\M' OR v_def ~* 'delete\s+from\s+(public\.)?invoice_sequences' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0078-E(5): the routine UPDATEs or DELETEs invoice_sequences, so the UPDATE privilege is not only the lock''s and a merchant''s number_format is reachable from it'
      USING ERRCODE = 'P0001';
  END IF;
  -- The first-use initialiser: exactly one, and it can only CREATE.
  IF (SELECT count(*) FROM regexp_matches(v_def, 'insert\s+into\s+(public\.)?invoice_sequences', 'gi')) <> 1 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0078-E(5): the routine does not carry EXACTLY ONE insert into invoice_sequences, so the first-use initialiser of TL-P4-S2-R4 is missing or duplicated'
      USING ERRCODE = 'P0001';
  END IF;
  IF position('ON CONFLICT (business_id, document_kind, period) DO NOTHING' IN v_def) = 0 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0078-E(5): the series initialiser is not ON CONFLICT (business_id, document_kind, period) DO NOTHING, so two concurrent first sales of a year are not decided by the primary key'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_def ~* 'on\s+conflict[^;]*do\s+update' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0078-E(5): the series initialiser upserts, so it would overwrite a merchant''s number_format with the default'
      USING ERRCODE = 'P0001';
  END IF;
  -- The default format itself, pinned in the body: a default silently
  -- changed is every later document of every business renamed.
  IF position('''INV-{YYYY}-{SEQ:6}''' IN v_def) = 0 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0078-E(5): the default internal numbering format INV-{YYYY}-{SEQ:6} is not the one the initialiser writes (TL-P4-S2-R4; a DAFTAR-internal identifier, not a fiscal-compliance claim — OD-03 is OPEN)'
      USING ERRCODE = 'P0001';
  END IF;
  IF position('FOR NO KEY UPDATE' IN v_def) = 0 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0078-E(5): the routine does not lock the series row' USING ERRCODE = 'P0001';
  END IF;
  IF v_def ~* 'accounting_post_entry|INSERT\s+INTO\s+journal_' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0078-E(5): the routine touches the ledger, and accounting_post_entry is the one writer'
      USING ERRCODE = 'P0001';
  END IF;

  -- (6) `inventory_apply_stock_movements` is UNCHANGED by this file: it is
  --     still owned by daftar_inventory_internal and still the only writer
  --     of stock_movements, and 0078 did not replace it. A replacement would
  --     show as a changed prosrc digest, which is what this pins.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'inventory_apply_stock_movements') <> 1 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0078-E(6): inventory_apply_stock_movements is not exactly one routine'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT p.prosrc INTO v_def FROM pg_proc p
   WHERE p.oid = 'inventory_apply_stock_movements(inventory_movement_request[])'::regprocedure;
  -- The no-oversell refusal, still raised under the key lock, read from the
  -- live body: this is what OD-P4-05 is, and 0078 must not have moved it.
  IF position('inventory.insufficient_stock' IN v_def) = 0
     OR position('abs(v_qty) > v_level_qty' IN v_def) = 0
     OR position('FOR UPDATE' IN v_def) = 0 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0078-E(6): the stock writer no longer refuses an oversell under the key lock (OD-P4-05)'
      USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT p.proowner FROM pg_proc p
       WHERE p.oid = 'inventory_apply_stock_movements(inventory_movement_request[])'::regprocedure)
     <> (SELECT r.oid FROM pg_roles r WHERE r.rolname = 'daftar_inventory_internal') THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0078-E(6): the stock writer changed owner' USING ERRCODE = 'P0001';
  END IF;

  -- (7) The privileges the owner needs, and NO MORE: INSERT on the invoice
  --     relations and on the series (the first-use initialiser of
  --     TL-P4-S2-R4, which can create a row and can never overwrite one),
  --     the column-level UPDATE on the series that carries the row lock and
  --     nothing else, and still NO DML for daftar_app on any Phase 4
  --     relation (P4-AL-38).
  IF NOT has_table_privilege('daftar_inventory_internal', 'invoices', 'INSERT')
     OR NOT has_table_privilege('daftar_inventory_internal', 'invoice_items', 'INSERT')
     OR NOT has_table_privilege('daftar_inventory_internal', 'invoice_sequences', 'INSERT')
     OR NOT has_column_privilege('daftar_inventory_internal', 'invoice_sequences', 'updated_at', 'UPDATE') THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0078-E(7): the routine''s owner cannot write what the routine writes'
      USING ERRCODE = 'P0001';
  END IF;
  -- The lock privilege is a LOCK privilege. A table-level UPDATE on the
  -- series would let this writer rewrite a merchant's number_format, and
  -- `information_schema.role_table_grants` — which the estate's authority
  -- law reads — would then report this append-only writer as a rewriter of
  -- a relation beyond the accepted prefix. Pinned here so no later
  -- migration can widen it back by habit.
  IF has_table_privilege('daftar_inventory_internal', 'invoice_sequences', 'UPDATE') THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0078-E(7): the series UPDATE is table-level, which is authority to rewrite a number_format rather than authority to take a row lock'
      USING ERRCODE = 'P0001';
  END IF;
  IF has_table_privilege('daftar_inventory_internal', 'invoice_sequences', 'DELETE') THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0078-E(7): the writer can DELETE a series row, and a deleted series is a renumbered business'
      USING ERRCODE = 'P0001';
  END IF;
  -- The INSERT the initialiser needs is for the INTERNAL writer alone. A
  -- runtime principal holding it would be a client that can name its own
  -- document format, which P4-AL-38 refuses from the other side.
  -- PUBLIC needs no row of its own: `has_table_privilege` counts a privilege
  -- granted to PUBLIC as held by every role, so a PUBLIC grant shows up here
  -- as every principal holding it.
  FOR v_name IN
    SELECT r.rolname::text FROM pg_roles r
     WHERE r.rolname = ANY (ARRAY['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_identity',
                                  'daftar_resolver', 'daftar_provisioner', 'daftar_reconciler'])
     ORDER BY 1
  LOOP
    IF has_table_privilege(v_name, 'invoice_sequences', 'INSERT') THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: 0078-E(7): % holds INSERT on invoice_sequences, so a client could state the format its own documents are numbered with', v_name
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM information_schema.column_privileges
              WHERE grantee = 'daftar_inventory_internal' AND table_schema = 'public'
                AND table_name = 'invoice_sequences' AND privilege_type = 'UPDATE'
                AND column_name <> 'updated_at') THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0078-E(7): the series UPDATE names a column beyond updated_at, and one column is all a lock needs'
      USING ERRCODE = 'P0001';
  END IF;
  FOREACH v_name IN ARRAY ARRAY['sales', 'sale_items', 'invoices', 'invoice_items', 'invoice_sequences', 'customers'] LOOP
    IF has_table_privilege('daftar_app', v_name, 'INSERT')
       OR has_table_privilege('daftar_app', v_name, 'UPDATE')
       OR has_table_privilege('daftar_app', v_name, 'DELETE') THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: 0078-E(7): daftar_app holds DML on %, which P4-AL-38 refuses', v_name
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- (8) The sale relations are still empty: this file created a writer, not
  --     a row.
  IF EXISTS (SELECT 1 FROM sales) OR EXISTS (SELECT 1 FROM invoices) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0078-E(8): 0078 wrote a document, and a migration is not a writer' USING ERRCODE = 'P0001';
  END IF;

  -- (9) The stock source guard still reports no gap: nothing above loosened
  --     a protection 0077 installed.
  IF EXISTS (SELECT 1 FROM inventory_stock_source_guard_gaps()) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0078-E(9): inventory_stock_source_guard_gaps() reports a gap after 0078'
      USING ERRCODE = 'P0001';
  END IF;

  -- (11) The assertion is the first decision (R-P4-S2-78-07), claimed from
  --      the live body: the first executable statement of `sale_commit` is
  --      the `inventory_assertion_consume` assignment, so no read of any
  --      relation precedes it.
  SELECT p.prosrc INTO v_def FROM pg_proc p WHERE p.oid = c_commit::regprocedure;
  IF (SELECT x.line FROM unnest(string_to_array(substring(v_def FROM position('BEGIN' IN v_def)), E'\n')) AS x(line)
       WHERE btrim(x.line) <> '' AND btrim(x.line) NOT LIKE '--%' AND btrim(x.line) <> 'BEGIN'
       LIMIT 1) NOT LIKE '%inventory_assertion_consume%' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0078-E(11): the first statement of sale_commit is not the assertion consume'
      USING ERRCODE = 'P0001';
  END IF;

  -- (10) The schema's CREATE privilege was handed back.
  IF has_schema_privilege('daftar_inventory_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0078-E(10): daftar_inventory_internal still holds CREATE ON SCHEMA public'
      USING ERRCODE = 'P0001';
  END IF;
END;
$end$;
