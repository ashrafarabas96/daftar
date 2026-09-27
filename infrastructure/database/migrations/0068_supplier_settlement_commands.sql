-- 0068_supplier_settlement_commands.sql
-- P3-S6, part 2 — the seven signed entry routines of payment methods and
-- supplier settlement, the one credit-note writer they share, and the seven
-- operation kinds, registered LAST (docs/PHASE_3_S6_CONTRACT.md §2.6, §2.8,
-- §2.9, A-03, A-06-A-11, A-15, A-16, A-20).
--
-- Every routine is internal-owned SECURITY DEFINER with the pinned path, its
-- first statement consumes an invctl/1 assertion over its own arguments in
-- the A-16 order, and daftar_app is its only grantee. No routine moves stock
-- or writes a bridge: no op→movement mapping is registered.
--
-- ── Rulings taken here (documented for the report) ──────────────────────
--
--   R-73 THE CREDIT-NOTE WRITER (0066 R-55 carried forward; the one
--        departure from §2.6 "No helpers"). Rule 22 counts
--        `supplier_credit_notes` as a stock write table, and requires a
--        writer's first statement to be an assertion call whose arguments
--        call nothing; an entry routine's consume computes its digest in
--        its arguments. So the AL-31 decrement moves to the helper
--        `supplier_credit_note_consume(credit_note_id, remaining_before,
--        consumed)` — internal-owned DEFINER, pinned, no grantee, first
--        statement `inventory_assertion_current` over the two consuming
--        kinds — called at §2.6 step 12/13, after the consumer row is
--        inserted (A-12(4)). It admits only a consumer row of this very
--        transaction naming exactly that note, level and amount, and
--        decrements both values in one UPDATE judged by the R-66 guard.
--   R-74 THE ALLOCATION IDS of a payment are idempotency keys and accounting
--        source ids: an allocation id already stored under another payment
--        is `supplier_payment.allocations_invalid` (the 0066 R-50
--        precedent), never a raw key violation.
--   R-75 A MISSING SCALAR ARGUMENT (an id, a date, a rate, a bound amount) is
--        `inventory.payload_invalid`, as in every earlier routine; the
--        document shape codes of §2.6 (`supplier_payment.allocations_invalid`,
--        `payment_method.name_invalid` / `name_required`) are kept for what
--        §2.6 names.
--   R-76 A PAYMENT's currency, and a refund's receipt currency, is judged
--        as bound: an unregistered code is `purchase.currency_unknown`
--        (§2.6 step 10); no case folding (the payload carries it lower-case,
--        the row stores the registered code).
--
-- ── Review rulings (S6 independent review; the rules are stated in 0067) ─
--
--   R-77 supplier_pay (step 11) and supplier_allocate_credit (step 10) refuse
--        an allocation that leaves its purchase an outstanding O − a > 0
--        with conv_R(O − a) = 0: 422 `supplier_payment.residue_below_base_unit`
--        / `supplier_credit_allocation.residue_below_base_unit`, judged right
--        after `…amount_below_base_unit` and before any write.
--   R-78 supplier_allocate_credit (step 10) and supplier_receive_refund (step
--        11) refuse a consumption that leaves its note a remaining
--        rb − c > 0 with conv_Rn(rb − c) = 0: 422
--        `supplier_credit_allocation.residue_below_base_unit` /
--        `supplier_refund.residue_below_base_unit`, at the same point.
--   R-79 `supplier_settlement_guard_gaps()` is re-created here (section 6a),
--        by the migrator, same signature, owner, INVOKER STABLE, pinned path
--        and no grantee, with every 0067 row and digest verbatim and one
--        more row: the R-73 writer `supplier_credit_note_consume`
--        (internal-owned DEFINER, pinned, its prosrc SHA-256). 0068-E(8)
--        probes it.
--
-- Migrations 0000-0067 are untouched; this file replaces one 0067 object,
-- the S6 discovery (R-79).

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The four payment-method routines (A-06; the S4 supplier pattern,
--    0064:341-650). The intent is the payload digest itself (A-16).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION payment_method_create(
  p_payment_method_id  UUID,
  p_system_type        TEXT,
  p_posting_account_id UUID,
  p_requires_reference BOOLEAN,
  p_sort_order         INTEGER,
  p_name_ar            TEXT,
  p_name_en            TEXT,
  p_name_tr            TEXT
) RETURNS TABLE (
  payment_method_id UUID,
  replayed          BOOLEAN,
  revision          INTEGER,
  is_active         BOOLEAN
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
  v_elig     TEXT;
BEGIN
  v_actor := inventory_assertion_consume('payment.create_method', inventory_claimed_payload_digest('payment.create_method',
    ARRAY['uuid', 'code', 'uuid', 'boolean', 'integer'] || array_fill('integer'::text, ARRAY[24]),
    ARRAY[p_payment_method_id::text, p_system_type, p_posting_account_id::text, p_requires_reference::text, p_sort_order::text]
      || inventory_reason_words(p_name_ar) || inventory_reason_words(p_name_en) || inventory_reason_words(p_name_tr)));
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: inventory commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_business := v_actor.business_id;
  v_tenant   := v_actor.tenant_id;
  v_replay   := false;
  v_trace    := inventory_business_transaction_id();
  IF v_trace IS NULL THEN
    RAISE EXCEPTION 'inventory.trace_missing: a payment method records its business transaction id' USING ERRCODE = 'P0001';
  END IF;
  IF p_payment_method_id IS NULL THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a payment method names its id' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('daftar.payment_method_id'), hashtext(p_payment_method_id::text));
  v_intent := split_part(current_setting('app.inventory_assertion', true), '.', 7);

  SELECT m.create_intent_sha256 INTO v_stored
  FROM payment_methods m WHERE m.business_id = v_business AND m.id = p_payment_method_id FOR UPDATE;
  IF FOUND THEN
    IF v_stored <> v_intent THEN
      RAISE EXCEPTION 'payment_method.idempotency_conflict: this payment method id was used for a different method' USING ERRCODE = 'P0001';
    END IF;
    v_replay := true;
  ELSE
    IF p_system_type IS NULL OR p_system_type NOT IN ('cash', 'card', 'bank_transfer', 'wallet', 'cheque', 'other')
       OR p_posting_account_id IS NULL OR p_requires_reference IS NULL
       OR p_sort_order IS NULL OR p_sort_order NOT BETWEEN 0 AND 10000 THEN
      RAISE EXCEPTION 'inventory.payload_invalid: a payment method states its type, posting account, reference rule and a sort order of 0..10000' USING ERRCODE = 'P0001';
    END IF;
    IF (p_name_ar IS NOT NULL AND (p_name_ar <> btrim(p_name_ar) OR char_length(p_name_ar) NOT BETWEEN 1 AND 100))
       OR (p_name_en IS NOT NULL AND (p_name_en <> btrim(p_name_en) OR char_length(p_name_en) NOT BETWEEN 1 AND 100))
       OR (p_name_tr IS NOT NULL AND (p_name_tr <> btrim(p_name_tr) OR char_length(p_name_tr) NOT BETWEEN 1 AND 100)) THEN
      RAISE EXCEPTION 'payment_method.name_invalid: a payment method name is trimmed and 1..100 characters' USING ERRCODE = 'P0001';
    END IF;
    IF p_name_ar IS NULL AND p_name_en IS NULL AND p_name_tr IS NULL THEN
      RAISE EXCEPTION 'payment_method.name_required: a payment method carries at least one name' USING ERRCODE = 'P0001';
    END IF;
    v_elig := accounting_settlement_account_eligibility(v_business, p_posting_account_id);
    IF v_elig = 'not_found' THEN
      RAISE EXCEPTION 'payment_method.posting_account_not_found: the posting account does not exist in this business' USING ERRCODE = 'P0001';
    END IF;
    IF v_elig IS DISTINCT FROM 'eligible' THEN
      RAISE EXCEPTION 'payment_method.posting_account_ineligible: a payment method posts to an active settlement asset account of its business' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO payment_methods (tenant_id, business_id, id, system_type, posting_account_id, is_active, requires_reference, sort_order,
                                 revision, create_intent_sha256, last_intent_sha256, business_transaction_id, created_by, updated_by)
    VALUES (v_tenant, v_business, p_payment_method_id, p_system_type, p_posting_account_id, true, p_requires_reference, p_sort_order,
            1, v_intent, v_intent, v_trace, v_actor.actor_user_id, v_actor.actor_user_id);
    INSERT INTO payment_method_names (tenant_id, business_id, payment_method_id, locale, display_name)
    SELECT v_tenant, v_business, p_payment_method_id, x.locale, x.display_name
    FROM (VALUES ('ar', p_name_ar), ('en', p_name_en), ('tr', p_name_tr)) AS x(locale, display_name)
    WHERE x.display_name IS NOT NULL;

    INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
    VALUES (v_tenant, v_business, v_actor.actor_user_id, 'payment_method.created', 'payment_method', p_payment_method_id::text,
            jsonb_build_object('revision', 1, 'assertionJti', v_actor.jti, 'business_transaction_id', v_trace));
    INSERT INTO outbox_events (tenant_id, business_id, type, payload)
    VALUES (v_tenant, v_business, 'payment_method.created.v1',
            jsonb_build_object('businessId', v_business, 'paymentMethodId', p_payment_method_id, 'businessTransactionId', v_trace));
  END IF;

  RETURN QUERY
  SELECT m.id, v_replay, m.revision, m.is_active FROM payment_methods m WHERE m.business_id = v_business AND m.id = p_payment_method_id;
END;
$$;

COMMENT ON FUNCTION payment_method_create(UUID, TEXT, UUID, BOOLEAN, INTEGER, TEXT, TEXT, TEXT) IS
  'P3-S6 §2.6, A-06, A-16. First consumes an invctl/1 assertion of kind payment.create_method over its own arguments (id, type, posting account, reference rule, sort order, the eight words of each name). Under the daftar.payment_method_id key an existing id replays when its create intent (the payload digest) is equal and is payment_method.idempotency_conflict otherwise. Shape (inventory.payload_invalid, payment_method.name_invalid, name_required); the R-65 policy (payment_method.posting_account_not_found, posting_account_ineligible). Creates an active method at revision 1 and its names. Audit payment_method.created and its outbox row. EXECUTE: daftar_app only.';

CREATE OR REPLACE FUNCTION payment_method_update(
  p_payment_method_id  UUID,
  p_expected_revision  INTEGER,
  p_posting_account_id UUID,
  p_requires_reference BOOLEAN,
  p_sort_order         INTEGER,
  p_name_ar            TEXT,
  p_name_en            TEXT,
  p_name_tr            TEXT
) RETURNS TABLE (
  payment_method_id UUID,
  replayed          BOOLEAN,
  revision          INTEGER,
  is_active         BOOLEAN
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
  v_elig     TEXT;
BEGIN
  v_actor := inventory_assertion_consume('payment.update_method', inventory_claimed_payload_digest('payment.update_method',
    ARRAY['uuid', 'integer', 'uuid', 'boolean', 'integer'] || array_fill('integer'::text, ARRAY[24]),
    ARRAY[p_payment_method_id::text, p_expected_revision::text, p_posting_account_id::text, p_requires_reference::text, p_sort_order::text]
      || inventory_reason_words(p_name_ar) || inventory_reason_words(p_name_en) || inventory_reason_words(p_name_tr)));
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: inventory commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_business := v_actor.business_id;
  v_tenant   := v_actor.tenant_id;
  v_replay   := false;
  v_trace    := inventory_business_transaction_id();
  IF v_trace IS NULL THEN
    RAISE EXCEPTION 'inventory.trace_missing: a payment method records its business transaction id' USING ERRCODE = 'P0001';
  END IF;
  IF p_payment_method_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 1 THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a payment method update names the method and the revision it replaces' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('daftar.payment_method_id'), hashtext(p_payment_method_id::text));
  v_intent := split_part(current_setting('app.inventory_assertion', true), '.', 7);

  SELECT m.revision, m.last_intent_sha256, m.posting_account_id INTO v_row
  FROM payment_methods m WHERE m.business_id = v_business AND m.id = p_payment_method_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment_method.not_found: the payment method does not exist in this business' USING ERRCODE = 'P0001';
  END IF;
  IF v_row.revision = p_expected_revision + 1 AND v_row.last_intent_sha256 = v_intent THEN
    v_replay := true;
  ELSE
    IF v_row.revision <> p_expected_revision THEN
      RAISE EXCEPTION 'payment_method.revision_changed: the payment method changed since it was read' USING ERRCODE = 'P0001';
    END IF;
    IF p_posting_account_id IS NULL OR p_requires_reference IS NULL OR p_sort_order IS NULL OR p_sort_order NOT BETWEEN 0 AND 10000 THEN
      RAISE EXCEPTION 'inventory.payload_invalid: a payment method states its posting account, reference rule and a sort order of 0..10000' USING ERRCODE = 'P0001';
    END IF;
    IF (p_name_ar IS NOT NULL AND (p_name_ar <> btrim(p_name_ar) OR char_length(p_name_ar) NOT BETWEEN 1 AND 100))
       OR (p_name_en IS NOT NULL AND (p_name_en <> btrim(p_name_en) OR char_length(p_name_en) NOT BETWEEN 1 AND 100))
       OR (p_name_tr IS NOT NULL AND (p_name_tr <> btrim(p_name_tr) OR char_length(p_name_tr) NOT BETWEEN 1 AND 100)) THEN
      RAISE EXCEPTION 'payment_method.name_invalid: a payment method name is trimmed and 1..100 characters' USING ERRCODE = 'P0001';
    END IF;
    IF p_name_ar IS NULL AND p_name_en IS NULL AND p_name_tr IS NULL THEN
      RAISE EXCEPTION 'payment_method.name_required: a payment method carries at least one name' USING ERRCODE = 'P0001';
    END IF;
    IF p_posting_account_id IS DISTINCT FROM v_row.posting_account_id THEN
      IF EXISTS (SELECT 1 FROM supplier_payments s WHERE s.business_id = v_business AND s.payment_method_id = p_payment_method_id)
         OR EXISTS (SELECT 1 FROM supplier_refunds f WHERE f.business_id = v_business AND f.payment_method_id = p_payment_method_id) THEN
        RAISE EXCEPTION 'payment_method.posting_account_locked: a payment method that has posted keeps its posting account' USING ERRCODE = 'P0001';
      END IF;
      v_elig := accounting_settlement_account_eligibility(v_business, p_posting_account_id);
      IF v_elig = 'not_found' THEN
        RAISE EXCEPTION 'payment_method.posting_account_not_found: the posting account does not exist in this business' USING ERRCODE = 'P0001';
      END IF;
      IF v_elig IS DISTINCT FROM 'eligible' THEN
        RAISE EXCEPTION 'payment_method.posting_account_ineligible: a payment method posts to an active settlement asset account of its business' USING ERRCODE = 'P0001';
      END IF;
    END IF;
    UPDATE payment_methods m
       SET posting_account_id = p_posting_account_id, requires_reference = p_requires_reference, sort_order = p_sort_order,
           revision = m.revision + 1, last_intent_sha256 = v_intent, business_transaction_id = v_trace,
           updated_by = v_actor.actor_user_id, updated_at = now()
     WHERE m.business_id = v_business AND m.id = p_payment_method_id;
    DELETE FROM payment_method_names n
     WHERE n.business_id = v_business AND n.payment_method_id = p_payment_method_id
       AND n.locale IN (SELECT x.locale FROM (VALUES ('ar', p_name_ar), ('en', p_name_en), ('tr', p_name_tr)) AS x(locale, display_name)
                         WHERE x.display_name IS NULL);
    INSERT INTO payment_method_names (tenant_id, business_id, payment_method_id, locale, display_name)
    SELECT v_tenant, v_business, p_payment_method_id, x.locale, x.display_name
    FROM (VALUES ('ar', p_name_ar), ('en', p_name_en), ('tr', p_name_tr)) AS x(locale, display_name)
    WHERE x.display_name IS NOT NULL
    ON CONFLICT ON CONSTRAINT payment_method_names_pkey DO UPDATE SET display_name = EXCLUDED.display_name;

    INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
    VALUES (v_tenant, v_business, v_actor.actor_user_id, 'payment_method.updated', 'payment_method', p_payment_method_id::text,
            jsonb_build_object('revision', p_expected_revision + 1, 'assertionJti', v_actor.jti, 'business_transaction_id', v_trace));
    INSERT INTO outbox_events (tenant_id, business_id, type, payload)
    VALUES (v_tenant, v_business, 'payment_method.updated.v1',
            jsonb_build_object('businessId', v_business, 'paymentMethodId', p_payment_method_id, 'businessTransactionId', v_trace));
  END IF;

  RETURN QUERY
  SELECT m.id, v_replay, m.revision, m.is_active FROM payment_methods m WHERE m.business_id = v_business AND m.id = p_payment_method_id;
END;
$$;

COMMENT ON FUNCTION payment_method_update(UUID, INTEGER, UUID, BOOLEAN, INTEGER, TEXT, TEXT, TEXT) IS
  'P3-S6 §2.6, A-06, A-16. First consumes an invctl/1 assertion of kind payment.update_method over its own arguments. Under the daftar.payment_method_id key: payment_method.not_found; revision expected + 1 with an equal last intent replays; payment_method.revision_changed. Shape as create; an account change needs a method nothing posted through (payment_method.posting_account_locked) and an eligible account (R-65). States the whole method: its account, reference rule, sort order and names (a locale passed as NULL is removed). Never changes the type or the active flag. Audit payment_method.updated and its outbox row. EXECUTE: daftar_app only.';

CREATE OR REPLACE FUNCTION payment_method_deactivate(p_payment_method_id UUID, p_expected_revision INTEGER)
RETURNS TABLE (
  payment_method_id UUID,
  replayed          BOOLEAN,
  revision          INTEGER,
  is_active         BOOLEAN
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
  v_actor := inventory_assertion_consume('payment.deactivate_method', inventory_claimed_payload_digest('payment.deactivate_method',
    ARRAY['uuid', 'integer'], ARRAY[p_payment_method_id::text, p_expected_revision::text]));
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: inventory commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_business := v_actor.business_id;
  v_tenant   := v_actor.tenant_id;
  v_replay   := false;
  v_trace    := inventory_business_transaction_id();
  IF v_trace IS NULL THEN
    RAISE EXCEPTION 'inventory.trace_missing: a payment method records its business transaction id' USING ERRCODE = 'P0001';
  END IF;
  IF p_payment_method_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 1 THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a deactivation names the method and the revision it replaces' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('daftar.payment_method_id'), hashtext(p_payment_method_id::text));
  v_intent := split_part(current_setting('app.inventory_assertion', true), '.', 7);

  SELECT m.revision, m.last_intent_sha256, m.is_active INTO v_row
  FROM payment_methods m WHERE m.business_id = v_business AND m.id = p_payment_method_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment_method.not_found: the payment method does not exist in this business' USING ERRCODE = 'P0001';
  END IF;
  IF v_row.revision = p_expected_revision + 1 AND v_row.last_intent_sha256 = v_intent THEN
    v_replay := true;
  ELSE
    IF v_row.revision <> p_expected_revision THEN
      RAISE EXCEPTION 'payment_method.revision_changed: the payment method changed since it was read' USING ERRCODE = 'P0001';
    END IF;
    IF NOT v_row.is_active THEN
      RAISE EXCEPTION 'payment_method.state_invalid: only an active payment method is deactivated' USING ERRCODE = 'P0001';
    END IF;
    UPDATE payment_methods m
       SET is_active = false, revision = m.revision + 1, last_intent_sha256 = v_intent, business_transaction_id = v_trace,
           updated_by = v_actor.actor_user_id, updated_at = now()
     WHERE m.business_id = v_business AND m.id = p_payment_method_id;

    INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
    VALUES (v_tenant, v_business, v_actor.actor_user_id, 'payment_method.deactivated', 'payment_method', p_payment_method_id::text,
            jsonb_build_object('revision', p_expected_revision + 1, 'assertionJti', v_actor.jti, 'business_transaction_id', v_trace));
    INSERT INTO outbox_events (tenant_id, business_id, type, payload)
    VALUES (v_tenant, v_business, 'payment_method.deactivated.v1',
            jsonb_build_object('businessId', v_business, 'paymentMethodId', p_payment_method_id, 'businessTransactionId', v_trace));
  END IF;

  RETURN QUERY
  SELECT m.id, v_replay, m.revision, m.is_active FROM payment_methods m WHERE m.business_id = v_business AND m.id = p_payment_method_id;
END;
$$;

COMMENT ON FUNCTION payment_method_deactivate(UUID, INTEGER) IS
  'P3-S6 §2.6, A-06. First consumes an invctl/1 assertion of kind payment.deactivate_method over its own arguments (id, expected revision). Under the daftar.payment_method_id key: payment_method.not_found; revision expected + 1 with an equal last intent replays; payment_method.revision_changed; payment_method.state_invalid unless active. Changes is_active only (posted entries never reference the method). Audit payment_method.deactivated and its outbox row. EXECUTE: daftar_app only.';

CREATE OR REPLACE FUNCTION payment_method_activate(p_payment_method_id UUID, p_expected_revision INTEGER)
RETURNS TABLE (
  payment_method_id UUID,
  replayed          BOOLEAN,
  revision          INTEGER,
  is_active         BOOLEAN
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
  v_elig     TEXT;
BEGIN
  v_actor := inventory_assertion_consume('payment.activate_method', inventory_claimed_payload_digest('payment.activate_method',
    ARRAY['uuid', 'integer'], ARRAY[p_payment_method_id::text, p_expected_revision::text]));
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: inventory commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_business := v_actor.business_id;
  v_tenant   := v_actor.tenant_id;
  v_replay   := false;
  v_trace    := inventory_business_transaction_id();
  IF v_trace IS NULL THEN
    RAISE EXCEPTION 'inventory.trace_missing: a payment method records its business transaction id' USING ERRCODE = 'P0001';
  END IF;
  IF p_payment_method_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 1 THEN
    RAISE EXCEPTION 'inventory.payload_invalid: an activation names the method and the revision it replaces' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('daftar.payment_method_id'), hashtext(p_payment_method_id::text));
  v_intent := split_part(current_setting('app.inventory_assertion', true), '.', 7);

  SELECT m.revision, m.last_intent_sha256, m.is_active, m.posting_account_id INTO v_row
  FROM payment_methods m WHERE m.business_id = v_business AND m.id = p_payment_method_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment_method.not_found: the payment method does not exist in this business' USING ERRCODE = 'P0001';
  END IF;
  IF v_row.revision = p_expected_revision + 1 AND v_row.last_intent_sha256 = v_intent THEN
    v_replay := true;
  ELSE
    IF v_row.revision <> p_expected_revision THEN
      RAISE EXCEPTION 'payment_method.revision_changed: the payment method changed since it was read' USING ERRCODE = 'P0001';
    END IF;
    IF v_row.is_active THEN
      RAISE EXCEPTION 'payment_method.state_invalid: only an inactive payment method is activated' USING ERRCODE = 'P0001';
    END IF;
    v_elig := accounting_settlement_account_eligibility(v_business, v_row.posting_account_id);
    IF v_elig = 'not_found' THEN
      RAISE EXCEPTION 'payment_method.posting_account_not_found: the posting account does not exist in this business' USING ERRCODE = 'P0001';
    END IF;
    IF v_elig IS DISTINCT FROM 'eligible' THEN
      RAISE EXCEPTION 'payment_method.posting_account_ineligible: a payment method posts to an active settlement asset account of its business' USING ERRCODE = 'P0001';
    END IF;
    UPDATE payment_methods m
       SET is_active = true, revision = m.revision + 1, last_intent_sha256 = v_intent, business_transaction_id = v_trace,
           updated_by = v_actor.actor_user_id, updated_at = now()
     WHERE m.business_id = v_business AND m.id = p_payment_method_id;

    INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
    VALUES (v_tenant, v_business, v_actor.actor_user_id, 'payment_method.activated', 'payment_method', p_payment_method_id::text,
            jsonb_build_object('revision', p_expected_revision + 1, 'assertionJti', v_actor.jti, 'business_transaction_id', v_trace));
    INSERT INTO outbox_events (tenant_id, business_id, type, payload)
    VALUES (v_tenant, v_business, 'payment_method.activated.v1',
            jsonb_build_object('businessId', v_business, 'paymentMethodId', p_payment_method_id, 'businessTransactionId', v_trace));
  END IF;

  RETURN QUERY
  SELECT m.id, v_replay, m.revision, m.is_active FROM payment_methods m WHERE m.business_id = v_business AND m.id = p_payment_method_id;
END;
$$;

COMMENT ON FUNCTION payment_method_activate(UUID, INTEGER) IS
  'P3-S6 §2.6, A-06 (MP-1). First consumes an invctl/1 assertion of kind payment.activate_method over its own arguments (id, expected revision). Under the daftar.payment_method_id key: payment_method.not_found; revision expected + 1 with an equal last intent replays; payment_method.revision_changed; payment_method.state_invalid unless inactive; the stored account re-checked by the R-65 policy (posting_account_not_found, posting_account_ineligible). Audit payment_method.activated and its outbox row. EXECUTE: daftar_app only.';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The credit-note writer (R-73; 0066 R-55's shape). Internal-owned, no
--    grantee; its first statement re-reads the verified assertion.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION supplier_credit_note_consume(p_credit_note_id UUID, p_remaining_before BIGINT, p_consumed BIGINT) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor inventory_verified_actor;
  v_rows  INTEGER;
BEGIN
  v_actor := inventory_assertion_current(ARRAY['supplier.allocate_credit', 'supplier.receive_refund']);
  IF p_credit_note_id IS NULL OR p_remaining_before IS NULL OR p_consumed IS NULL OR p_consumed <= 0 OR p_consumed > p_remaining_before
     OR NOT ((v_actor.op_code = 'supplier.allocate_credit'
              AND EXISTS (SELECT 1 FROM supplier_credit_allocations a
                           WHERE a.business_id = v_actor.business_id AND a.credit_note_id = p_credit_note_id
                             AND a.credit_remaining_before_minor = p_remaining_before AND a.credit_amount_consumed_minor = p_consumed
                             AND a.created_at = now() AND a.business_transaction_id = inventory_business_transaction_id()))
          OR (v_actor.op_code = 'supplier.receive_refund'
              AND EXISTS (SELECT 1 FROM supplier_refunds f
                           WHERE f.business_id = v_actor.business_id AND f.credit_note_id = p_credit_note_id
                             AND f.credit_remaining_before_minor = p_remaining_before AND f.source_amount_consumed_minor = p_consumed
                             AND f.created_at = now() AND f.business_transaction_id = inventory_business_transaction_id()))) THEN
    RAISE EXCEPTION 'inventory.source_type_not_authorized: a credit note is decremented only for its own consumer stored by this transaction' USING ERRCODE = 'P0001';
  END IF;
  UPDATE supplier_credit_notes n
     SET remaining_amount_minor = n.remaining_amount_minor - p_consumed,
         remaining_carrying_base_amount_minor = supplier_credit_remaining_carrying(n.original_amount_minor, n.original_carrying_base_amount_minor,
                                                                                   n.remaining_amount_minor - p_consumed)
   WHERE n.business_id = v_actor.business_id AND n.id = p_credit_note_id AND n.remaining_amount_minor = p_remaining_before;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'supplier_credit_note.consumption_inconsistent: the credit note no longer holds the remaining amount its consumer read' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_rows;
END;
$$;

COMMENT ON FUNCTION supplier_credit_note_consume(UUID, BIGINT, BIGINT) IS
  'P3-S6 R-73 (0066 R-55 carried forward), A-10, A-12. The one S6 writer of supplier_credit_notes. Re-verifies the transaction''s consumed supplier.allocate_credit or supplier.receive_refund assertion; requires this transaction''s consumer row of that kind naming the note, p_remaining_before and p_consumed (inventory.source_type_not_authorized otherwise); decrements both remaining values in one UPDATE to (r - c, g(r - c)), judged by supplier_credit_note_guard (R-66); supplier_credit_note.consumption_inconsistent unless exactly the note at p_remaining_before is changed. Internal-owned, no grant.';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. supplier.pay (§2.6, A-07-A-09, A-11, A-15, A-16). A payment in one
--    currency, fully allocated to 1..50 received purchases of its supplier,
--    every derived amount bound by the caller and recomputed here under the
--    locks. The caller then posts one supplier_payment entry per allocation.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION supplier_pay(
  p_payment_id          UUID,
  p_supplier_id         UUID,
  p_payment_method_id   UUID,
  p_posting_account_id  UUID,
  p_payment_date        DATE,
  p_currency_code       CHAR(3),
  p_amount_minor        BIGINT,
  p_rate_id             UUID,
  p_rate                NUMERIC,
  p_rate_source         TEXT,
  p_rate_at             TIMESTAMPTZ,
  p_base_amount_minor   BIGINT,
  p_reference           TEXT,
  p_allocation_ids      UUID[],
  p_purchase_ids        UUID[],
  p_warehouse_ids       UUID[],
  p_purchase_currencies TEXT[],
  p_payment_amounts     BIGINT[],
  p_payment_bases       BIGINT[],
  p_applied             BIGINT[],
  p_released_before     BIGINT[],
  p_carrying_released   BIGINT[],
  p_ap_dusts            BIGINT[],
  p_realized            BIGINT[]
) RETURNS TABLE (
  payment_id    UUID,
  allocation_id UUID,
  line_no       INTEGER,
  purchase_id   UUID,
  replayed      BOOLEAN
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
  v_found    INTEGER;
  v_q        RECORD;
  v_m        RECORD;
  v_sstatus  TEXT;
  v_tz       TEXT;
  v_base_ccy TEXT;
  v_ep       INTEGER;
  v_et       INTEGER;
  v_eb       INTEGER;
  v_fx       accounting_fx_rate_snapshot;
  v_rate_id  UUID;
  v_rate     NUMERIC;
  v_source   TEXT;
  v_at       TIMESTAMPTZ;
  v_o        BIGINT;
  v_x        BIGINT;
  v_rel      BIGINT;
  v_conv     BIGINT;
  v_pb       BIGINT;
  v_sum_pb   NUMERIC;
BEGIN
  -- 1. The consume, over the routine's own arguments in the A-16 order.
  v_actor := inventory_assertion_consume('supplier.pay', inventory_claimed_payload_digest('supplier.pay',
    ARRAY['uuid', 'uuid', 'uuid', 'uuid', 'integer', 'code', 'integer', 'uuid', 'integer', 'code', 'integer', 'integer']
      || array_fill('integer'::text, ARRAY[8]) || ARRAY['integer']
      || ARRAY(SELECT f.t FROM unnest(p_allocation_ids, p_purchase_ids, p_warehouse_ids, p_purchase_currencies, p_payment_amounts,
                                      p_payment_bases, p_applied, p_released_before, p_carrying_released, p_ap_dusts, p_realized)
                                 WITH ORDINALITY AS l(al, pu, wh, cu, pa, pb, ap, rb, cr, ad, re, i)
               CROSS JOIN LATERAL unnest(ARRAY['uuid', 'uuid', 'uuid', 'code', 'integer', 'integer', 'integer', 'integer', 'integer',
                                               'integer', 'integer']) WITH ORDINALITY AS f(t, j)
               ORDER BY l.i, f.j),
    ARRAY[p_payment_id::text, p_supplier_id::text, p_payment_method_id::text, p_posting_account_id::text,
          to_char(p_payment_date, 'YYYYMMDD'), lower(p_currency_code::text), p_amount_minor::text, p_rate_id::text,
          inventory_fixed_text(p_rate, 10), p_rate_source,
          CASE WHEN extract(epoch FROM p_rate_at) = trunc(extract(epoch FROM p_rate_at))
               THEN trunc(extract(epoch FROM p_rate_at))::text ELSE extract(epoch FROM p_rate_at)::text END,
          p_base_amount_minor::text]
      || inventory_reason_words(p_reference)
      || ARRAY[coalesce(cardinality(p_allocation_ids), 0)::text]
      || ARRAY(SELECT f.x FROM unnest(p_allocation_ids, p_purchase_ids, p_warehouse_ids, p_purchase_currencies, p_payment_amounts,
                                      p_payment_bases, p_applied, p_released_before, p_carrying_released, p_ap_dusts, p_realized)
                                 WITH ORDINALITY AS l(al, pu, wh, cu, pa, pb, ap, rb, cr, ad, re, i)
               CROSS JOIN LATERAL unnest(ARRAY[l.al::text, l.pu::text, l.wh::text, lower(l.cu), l.pa::text, l.pb::text, l.ap::text,
                                               l.rb::text, l.cr::text, l.ad::text, l.re::text]) WITH ORDINALITY AS f(x, j)
               ORDER BY l.i, f.j)));
  -- 2. Isolation and trace.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: inventory commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_business := v_actor.business_id;
  v_tenant   := v_actor.tenant_id;
  v_replay   := false;
  v_trace    := inventory_business_transaction_id();
  IF v_trace IS NULL THEN
    RAISE EXCEPTION 'inventory.trace_missing: a supplier payment records its business transaction id' USING ERRCODE = 'P0001';
  END IF;
  IF p_payment_id IS NULL THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a supplier payment names its id' USING ERRCODE = 'P0001';
  END IF;

  -- 3. The document key, then the intent (R-26; A-16: id, supplier, method,
  --    date, currency, amount, reference, and per allocation id, purchase,
  --    payment amount, applied amount).
  PERFORM pg_advisory_xact_lock(hashtext('daftar.supplier_payment_id'), hashtext(p_payment_id::text));
  v_intent := inventory_payload_digest('supplier.pay', v_tenant, v_business,
    ARRAY['uuid', 'uuid', 'uuid', 'integer', 'code', 'integer'] || array_fill('integer'::text, ARRAY[8]) || ARRAY['integer']
      || ARRAY(SELECT f.t FROM unnest(p_allocation_ids, p_purchase_ids, p_payment_amounts, p_applied) WITH ORDINALITY AS l(al, pu, pa, ap, i)
               CROSS JOIN LATERAL unnest(ARRAY['uuid', 'uuid', 'integer', 'integer']) WITH ORDINALITY AS f(t, j)
               ORDER BY l.i, f.j),
    ARRAY[p_payment_id::text, p_supplier_id::text, p_payment_method_id::text, to_char(p_payment_date, 'YYYYMMDD'),
          lower(p_currency_code::text), p_amount_minor::text]
      || inventory_reason_words(p_reference)
      || ARRAY[coalesce(cardinality(p_allocation_ids), 0)::text]
      || ARRAY(SELECT f.x FROM unnest(p_allocation_ids, p_purchase_ids, p_payment_amounts, p_applied) WITH ORDINALITY AS l(al, pu, pa, ap, i)
               CROSS JOIN LATERAL unnest(ARRAY[l.al::text, l.pu::text, l.pa::text, l.ap::text]) WITH ORDINALITY AS f(x, j)
               ORDER BY l.i, f.j));

  -- 4. The replay read, before any other read: an equal intent replays,
  --    another is a conflict.
  SELECT s.intent_sha256 INTO v_stored FROM supplier_payments s WHERE s.business_id = v_business AND s.id = p_payment_id;
  IF FOUND THEN
    IF v_stored <> v_intent THEN
      RAISE EXCEPTION 'supplier_payment.idempotency_conflict: this payment id was already used for another payment' USING ERRCODE = 'P0001';
    END IF;
    v_replay := true;
  ELSE
    -- 5. Shape, before any state read.
    IF p_supplier_id IS NULL OR p_payment_method_id IS NULL OR p_posting_account_id IS NULL OR p_payment_date IS NULL
       OR p_currency_code IS NULL OR p_amount_minor IS NULL OR p_rate IS NULL OR p_rate_source IS NULL OR p_rate_at IS NULL
       OR p_base_amount_minor IS NULL THEN
      RAISE EXCEPTION 'inventory.payload_invalid: a supplier payment binds its supplier, method, account, date, currency, amount and rate snapshot' USING ERRCODE = 'P0001';
    END IF;
    v_n := coalesce(cardinality(p_allocation_ids), 0);
    IF v_n = 0 OR v_n > 50 OR array_ndims(p_allocation_ids) <> 1 OR array_lower(p_allocation_ids, 1) <> 1
       OR p_purchase_ids IS NULL OR array_ndims(p_purchase_ids) <> 1 OR array_lower(p_purchase_ids, 1) <> 1 OR cardinality(p_purchase_ids) <> v_n
       OR p_warehouse_ids IS NULL OR array_ndims(p_warehouse_ids) <> 1 OR array_lower(p_warehouse_ids, 1) <> 1 OR cardinality(p_warehouse_ids) <> v_n
       OR p_purchase_currencies IS NULL OR array_ndims(p_purchase_currencies) <> 1 OR array_lower(p_purchase_currencies, 1) <> 1
       OR cardinality(p_purchase_currencies) <> v_n
       OR p_payment_amounts IS NULL OR array_ndims(p_payment_amounts) <> 1 OR array_lower(p_payment_amounts, 1) <> 1
       OR cardinality(p_payment_amounts) <> v_n
       OR p_payment_bases IS NULL OR array_ndims(p_payment_bases) <> 1 OR array_lower(p_payment_bases, 1) <> 1 OR cardinality(p_payment_bases) <> v_n
       OR p_applied IS NULL OR array_ndims(p_applied) <> 1 OR array_lower(p_applied, 1) <> 1 OR cardinality(p_applied) <> v_n
       OR p_released_before IS NULL OR array_ndims(p_released_before) <> 1 OR array_lower(p_released_before, 1) <> 1
       OR cardinality(p_released_before) <> v_n
       OR p_carrying_released IS NULL OR array_ndims(p_carrying_released) <> 1 OR array_lower(p_carrying_released, 1) <> 1
       OR cardinality(p_carrying_released) <> v_n
       OR p_ap_dusts IS NULL OR array_ndims(p_ap_dusts) <> 1 OR array_lower(p_ap_dusts, 1) <> 1 OR cardinality(p_ap_dusts) <> v_n
       OR p_realized IS NULL OR array_ndims(p_realized) <> 1 OR array_lower(p_realized, 1) <> 1 OR cardinality(p_realized) <> v_n
       OR array_position(p_allocation_ids, NULL) IS NOT NULL OR array_position(p_purchase_ids, NULL) IS NOT NULL
       OR array_position(p_warehouse_ids, NULL) IS NOT NULL OR array_position(p_purchase_currencies, NULL) IS NOT NULL
       OR array_position(p_payment_amounts, NULL) IS NOT NULL OR array_position(p_payment_bases, NULL) IS NOT NULL
       OR array_position(p_applied, NULL) IS NOT NULL OR array_position(p_released_before, NULL) IS NOT NULL
       OR array_position(p_carrying_released, NULL) IS NOT NULL OR array_position(p_ap_dusts, NULL) IS NOT NULL
       OR array_position(p_realized, NULL) IS NOT NULL
       OR (SELECT count(DISTINCT x.id) FROM unnest(p_allocation_ids) AS x(id)) <> v_n
       OR (SELECT count(DISTINCT x.id) FROM unnest(p_purchase_ids) AS x(id)) <> v_n
       OR p_amount_minor <= 0
       OR EXISTS (SELECT 1 FROM unnest(p_payment_amounts) AS x(a) WHERE x.a <= 0)
       OR EXISTS (SELECT 1 FROM unnest(p_applied) AS x(a) WHERE x.a <= 0)
       OR (SELECT sum(x.a) FROM unnest(p_payment_amounts) AS x(a)) <> p_amount_minor
       OR (p_reference IS NOT NULL AND (p_reference <> btrim(p_reference) OR char_length(p_reference) NOT BETWEEN 1 AND 100)) THEN
      RAISE EXCEPTION 'supplier_payment.allocations_invalid: a payment is fully allocated to 1..50 distinct purchases in positive amounts, with an optional trimmed reference' USING ERRCODE = 'P0001';
    END IF;
    -- R-74: an allocation id is an idempotency key and an accounting source id.
    IF EXISTS (SELECT 1 FROM supplier_payment_allocations a WHERE a.business_id = v_business AND a.id = ANY (p_allocation_ids)) THEN
      RAISE EXCEPTION 'supplier_payment.allocations_invalid: an allocation id is already used by another payment' USING ERRCODE = 'P0001';
    END IF;

    -- 6. Lock step 2a: every allocated purchase FOR UPDATE, in id order.
    SELECT count(*) INTO v_found
    FROM (SELECT p.id FROM purchases p WHERE p.business_id = v_business AND p.id = ANY (p_purchase_ids) ORDER BY p.id FOR UPDATE) AS k;
    IF v_found <> v_n THEN
      RAISE EXCEPTION 'purchase.not_found: the purchase does not exist in this business' USING ERRCODE = 'P0001';
    END IF;
    FOR v_i IN 1 .. v_n LOOP
      SELECT p.status, p.supplier_id, p.warehouse_id, p.currency_code INTO v_q
      FROM purchases p WHERE p.business_id = v_business AND p.id = p_purchase_ids[v_i];
      IF v_q.supplier_id <> p_supplier_id THEN
        RAISE EXCEPTION 'supplier_payment.purchase_supplier_mismatch: a payment settles purchases of its own supplier only' USING ERRCODE = 'P0001';
      END IF;
      IF v_q.status <> 'received' THEN
        RAISE EXCEPTION 'supplier_payment.purchase_state_invalid: only a received purchase is settled' USING ERRCODE = 'P0001';
      END IF;
      IF EXISTS (SELECT 1 FROM purchase_reversals r WHERE r.business_id = v_business AND r.id = p_purchase_ids[v_i]) THEN
        RAISE EXCEPTION 'supplier_payment.purchase_reversed: a reversed purchase is not settled' USING ERRCODE = 'P0001';
      END IF;
      IF v_q.warehouse_id <> p_warehouse_ids[v_i] OR v_q.currency_code::text <> p_purchase_currencies[v_i] THEN
        RAISE EXCEPTION 'supplier_payment.settlement_changed: a purchase changed since the payment was prepared' USING ERRCODE = 'P0001';
      END IF;
    END LOOP;

    -- 7. Lock step 2b: the supplier FOR SHARE.
    SELECT s.status INTO v_sstatus FROM suppliers s WHERE s.business_id = v_business AND s.id = p_supplier_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'supplier.not_found: the supplier does not exist in this business' USING ERRCODE = 'P0001';
    END IF;
    IF v_sstatus <> 'active' THEN
      RAISE EXCEPTION 'supplier_payment.supplier_inactive: a supplier payment is made to an active supplier' USING ERRCODE = 'P0001';
    END IF;

    -- 8. Lock step 2c: the method FOR SHARE (R-65).
    SELECT m.is_active, m.posting_account_id, m.requires_reference INTO v_m
    FROM payment_methods m WHERE m.business_id = v_business AND m.id = p_payment_method_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'payment_method.not_found: the payment method does not exist in this business' USING ERRCODE = 'P0001';
    END IF;
    IF NOT v_m.is_active THEN
      RAISE EXCEPTION 'payment_method.inactive: a supplier payment is made through an active payment method' USING ERRCODE = 'P0001';
    END IF;
    IF v_m.posting_account_id <> p_posting_account_id THEN
      RAISE EXCEPTION 'supplier_payment.settlement_changed: the payment method''s posting account changed since the payment was prepared' USING ERRCODE = 'P0001';
    END IF;
    IF accounting_settlement_account_eligibility(v_business, v_m.posting_account_id) IS DISTINCT FROM 'eligible' THEN
      RAISE EXCEPTION 'payment_method.posting_account_ineligible: a payment method posts to an active settlement asset account of its business' USING ERRCODE = 'P0001';
    END IF;
    IF v_m.requires_reference AND p_reference IS NULL THEN
      RAISE EXCEPTION 'supplier_payment.reference_required: this payment method requires a reference' USING ERRCODE = 'P0001';
    END IF;

    -- 9. The dates: not before any allocated purchase, not after today.
    SELECT b.timezone, b.base_currency INTO v_tz, v_base_ccy FROM businesses b WHERE b.id = v_business;
    IF EXISTS (SELECT 1 FROM purchases p WHERE p.business_id = v_business AND p.id = ANY (p_purchase_ids) AND p.document_date > p_payment_date) THEN
      RAISE EXCEPTION 'supplier_payment.date_before_purchase: a payment is dated on or after every purchase it settles' USING ERRCODE = 'P0001';
    END IF;
    IF p_payment_date > (now() AT TIME ZONE v_tz)::date THEN
      RAISE EXCEPTION 'supplier_payment.date_in_future: a payment is dated on or before today in the business timezone' USING ERRCODE = 'P0001';
    END IF;

    -- 10. The payment FX snapshot (A-15, R-17): no clock; the instant is derived.
    IF p_currency_code::text !~ '^[A-Z]{3}$' OR NOT EXISTS (SELECT 1 FROM currencies c WHERE c.code = p_currency_code::text) THEN
      RAISE EXCEPTION 'purchase.currency_unknown: the payment currency is not a registered currency' USING ERRCODE = 'P0001';
    END IF;
    IF p_currency_code::text = v_base_ccy THEN
      v_rate_id := NULL;
      v_rate    := 1;
      v_source  := 'base';
      v_at      := p_payment_date::timestamp AT TIME ZONE 'UTC';
    ELSE
      v_fx := accounting_purchase_fx_rate(v_business, p_currency_code, ((p_payment_date + 1)::timestamp AT TIME ZONE v_tz) - interval '1 second');
      v_rate_id := v_fx.rate_id;
      v_rate    := v_fx.rate;
      v_source  := v_fx.source;
      v_at      := v_fx.effective_at;
    END IF;
    IF p_rate_id IS DISTINCT FROM v_rate_id OR p_rate <> v_rate OR p_rate_source <> v_source OR p_rate_at <> v_at THEN
      RAISE EXCEPTION 'supplier_payment.fx_rate_changed: the exchange rate changed since the payment was prepared' USING ERRCODE = 'P0001';
    END IF;

    -- 11. Per allocation, in array order, under the purchase locks (A-08,
    --     A-09, MP-3): O, X, the release, the dust, the payment base, the FX.
    SELECT c.minor_units INTO v_ep FROM currencies c WHERE c.code = p_currency_code::text;
    SELECT c.minor_units INTO v_eb FROM currencies c WHERE c.code = v_base_ccy;
    v_sum_pb := 0;
    FOR v_i IN 1 .. v_n LOOP
      SELECT p.currency_code, p.total_txn_minor, p.total_base_minor, p.source_to_base_rate INTO v_q
      FROM purchases p WHERE p.business_id = v_business AND p.id = p_purchase_ids[v_i];
      SELECT c.minor_units INTO v_et FROM currencies c WHERE c.code = v_q.currency_code::text;
      v_o := purchase_ap_outstanding(v_business, p_purchase_ids[v_i]);
      IF p_applied[v_i] > v_o THEN
        RAISE EXCEPTION 'supplier_payment.amount_exceeds_outstanding: an allocation applies more than the purchase''s outstanding amount' USING ERRCODE = 'P0001';
      END IF;
      IF p_currency_code::text = v_q.currency_code::text AND p_payment_amounts[v_i] <> p_applied[v_i] THEN
        RAISE EXCEPTION 'supplier_payment.amount_mismatch: in the purchase''s own currency the paid and applied amounts are equal' USING ERRCODE = 'P0001';
      END IF;
      v_x    := v_q.total_txn_minor - v_o;
      v_rel  := supplier_ap_release(v_q.total_base_minor, v_q.total_txn_minor, v_x, p_applied[v_i]);
      v_conv := supplier_convert_base(p_applied[v_i], v_q.source_to_base_rate, v_et, v_eb);
      v_pb   := supplier_convert_base(p_payment_amounts[v_i], v_rate, v_ep, v_eb);
      IF v_conv = 0 OR v_pb = 0 THEN
        RAISE EXCEPTION 'supplier_payment.amount_below_base_unit: an allocated amount converts to less than one base minor unit' USING ERRCODE = 'P0001';
      END IF;
      -- R-77: never a sub-unit residue — O − a is 0 or converts to ≥ 1.
      IF p_applied[v_i] < v_o AND supplier_convert_base(v_o - p_applied[v_i], v_q.source_to_base_rate, v_et, v_eb) = 0 THEN
        RAISE EXCEPTION 'supplier_payment.residue_below_base_unit: an allocation would leave the purchase an outstanding amount converting to less than one base minor unit' USING ERRCODE = 'P0001';
      END IF;
      IF p_released_before[v_i] <> v_x OR p_carrying_released[v_i] <> v_rel OR p_ap_dusts[v_i] <> v_rel - v_conv
         OR p_payment_bases[v_i] <> v_pb OR p_realized[v_i] <> v_pb - v_rel THEN
        RAISE EXCEPTION 'supplier_payment.settlement_changed: a purchase''s outstanding amount changed since the payment was prepared' USING ERRCODE = 'P0001';
      END IF;
      v_sum_pb := v_sum_pb + v_pb;
    END LOOP;
    IF v_sum_pb <> p_base_amount_minor THEN
      RAISE EXCEPTION 'supplier_payment.settlement_changed: the payment base is not the sum of its allocations'' bases' USING ERRCODE = 'P0001';
    END IF;

    -- 12. The header, then the allocations (line_no = ordinal, binding = id).
    INSERT INTO supplier_payments (tenant_id, business_id, id, supplier_id, payment_method_id, posting_account_id, currency_code, amount_minor,
                                   payment_to_base_rate, rate_source, rate_timestamp, fx_rate_id, base_amount_minor, payment_date, reference,
                                   allocation_count, intent_sha256, business_transaction_id, created_by)
    VALUES (v_tenant, v_business, p_payment_id, p_supplier_id, p_payment_method_id, p_posting_account_id, p_currency_code, p_amount_minor,
            v_rate, v_source, v_at, v_rate_id, p_base_amount_minor, p_payment_date, p_reference,
            v_n, v_intent, v_trace, v_actor.actor_user_id);
    INSERT INTO supplier_payment_allocations (tenant_id, business_id, id, payment_id, supplier_id, purchase_id, line_no, payment_currency,
                                              payment_amount_minor, payment_to_base_rate, payment_base_amount_minor, purchase_currency,
                                              purchase_amount_applied_minor, purchase_historical_to_base_rate, ap_released_before_txn_minor,
                                              purchase_carrying_base_released_minor, ap_dust_base_minor, realized_fx_gain_loss_minor,
                                              binding_source_id)
    SELECT v_tenant, v_business, x.al, p_payment_id, p_supplier_id, x.pu, x.i::integer, p_currency_code,
           x.pa, v_rate, x.pb, p.currency_code,
           x.ap, p.source_to_base_rate, x.rb,
           x.cr, x.ad, x.re,
           x.al
    FROM unnest(p_allocation_ids, p_purchase_ids, p_payment_amounts, p_payment_bases, p_applied, p_released_before, p_carrying_released,
                p_ap_dusts, p_realized) WITH ORDINALITY AS x(al, pu, pa, pb, ap, rb, cr, ad, re, i)
    JOIN purchases p ON p.business_id = v_business AND p.id = x.pu
    ORDER BY x.i;

    -- 13. Audit and outbox (A-20): ids, never an amount.
    INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
    VALUES (v_tenant, v_business, v_actor.actor_user_id, 'supplier.paid', 'supplier_payment', p_payment_id::text,
            jsonb_build_object('supplierId', p_supplier_id, 'allocationIds', to_jsonb(p_allocation_ids), 'assertionJti', v_actor.jti,
                               'business_transaction_id', v_trace));
    INSERT INTO outbox_events (tenant_id, business_id, type, payload)
    VALUES (v_tenant, v_business, 'supplier.paid.v1',
            jsonb_build_object('businessId', v_business, 'paymentId', p_payment_id, 'supplierId', p_supplier_id,
                               'allocationIds', to_jsonb(p_allocation_ids), 'businessTransactionId', v_trace));
  END IF;

  -- 14. The stored rows, in line order.
  RETURN QUERY
  SELECT a.payment_id, a.id, a.line_no, a.purchase_id, v_replay
  FROM supplier_payment_allocations a
  WHERE a.business_id = v_business AND a.payment_id = p_payment_id
  ORDER BY a.line_no;
END;
$$;

COMMENT ON FUNCTION supplier_pay(UUID, UUID, UUID, UUID, DATE, CHAR(3), BIGINT, UUID, NUMERIC, TEXT, TIMESTAMPTZ, BIGINT, TEXT, UUID[], UUID[], UUID[], TEXT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[]) IS
  'P3-S6 §2.6, A-07-A-09, A-11, A-15, A-16. First consumes an invctl/1 assertion of kind supplier.pay over its own arguments. Under the daftar.supplier_payment_id key, with the intent (id, supplier, method, date, currency, amount, reference, per allocation id, purchase, paid and applied amounts): an equal stored intent returns the stored rows (replayed), another is supplier_payment.idempotency_conflict. Then the shape (inventory.payload_invalid; supplier_payment.allocations_invalid, R-74), the purchases FOR UPDATE in id order (purchase.not_found, purchase_supplier_mismatch, purchase_state_invalid, purchase_reversed, settlement_changed), the supplier FOR SHARE (supplier_inactive), the method FOR SHARE (payment_method.not_found, inactive, posting_account_ineligible; settlement_changed; reference_required), the dates (date_before_purchase, date_in_future), the FX snapshot (purchase.currency_unknown, fx_rate_changed), per allocation O, X, the release, dust, base and FX recomputed (amount_exceeds_outstanding, amount_mismatch, amount_below_base_unit, residue_below_base_unit R-77, settlement_changed). Inserts the payment and its allocations; audit supplier.paid and its outbox row. The caller posts one supplier_payment entry per allocation in line order. EXECUTE: daftar_app only.';

-- ─────────────────────────────────────────────────────────────────────────
-- 4. supplier.allocate_credit (§2.6, A-08, A-10, AL-31). A supplier credit
--    consumed against one received purchase of the same supplier; the note
--    is decremented by the R-73 writer after the allocation row exists.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION supplier_allocate_credit(
  p_allocation_id            UUID,
  p_credit_note_id           UUID,
  p_purchase_id              UUID,
  p_warehouse_id             UUID,
  p_allocation_date          DATE,
  p_credit_currency          CHAR(3),
  p_consumed_minor           BIGINT,
  p_remaining_before_minor   BIGINT,
  p_credit_released_minor    BIGINT,
  p_credit_dust_minor        BIGINT,
  p_purchase_currency        CHAR(3),
  p_applied_minor            BIGINT,
  p_ap_released_before_minor BIGINT,
  p_ap_released_minor        BIGINT,
  p_ap_dust_minor            BIGINT,
  p_realized_minor           BIGINT
) RETURNS TABLE (
  allocation_id UUID,
  replayed      BOOLEAN
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
  v_p        RECORD;
  v_note     RECORD;
  v_tz       TEXT;
  v_base_ccy TEXT;
  v_et       INTEGER;
  v_en       INTEGER;
  v_eb       INTEGER;
  v_o        BIGINT;
  v_x        BIGINT;
  v_rel      BIGINT;
  v_conv     BIGINT;
  v_cr_rel   BIGINT;
  v_cr_conv  BIGINT;
BEGIN
  -- 1. The consume, over the routine's own arguments in the A-16 order.
  v_actor := inventory_assertion_consume('supplier.allocate_credit', inventory_claimed_payload_digest('supplier.allocate_credit',
    ARRAY['uuid', 'uuid', 'uuid', 'uuid', 'integer', 'code', 'integer', 'integer', 'integer', 'integer', 'code', 'integer', 'integer',
          'integer', 'integer', 'integer'],
    ARRAY[p_allocation_id::text, p_credit_note_id::text, p_purchase_id::text, p_warehouse_id::text, to_char(p_allocation_date, 'YYYYMMDD'),
          lower(p_credit_currency::text), p_consumed_minor::text, p_remaining_before_minor::text, p_credit_released_minor::text,
          p_credit_dust_minor::text, lower(p_purchase_currency::text), p_applied_minor::text, p_ap_released_before_minor::text,
          p_ap_released_minor::text, p_ap_dust_minor::text, p_realized_minor::text]));
  -- 2. Isolation and trace.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: inventory commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_business := v_actor.business_id;
  v_tenant   := v_actor.tenant_id;
  v_replay   := false;
  v_trace    := inventory_business_transaction_id();
  IF v_trace IS NULL THEN
    RAISE EXCEPTION 'inventory.trace_missing: a supplier credit allocation records its business transaction id' USING ERRCODE = 'P0001';
  END IF;
  IF p_allocation_id IS NULL THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a supplier credit allocation names its id' USING ERRCODE = 'P0001';
  END IF;

  -- 3. The document key, then the intent (A-16: id, note, purchase, date,
  --    consumed, applied).
  PERFORM pg_advisory_xact_lock(hashtext('daftar.supplier_credit_allocation_id'), hashtext(p_allocation_id::text));
  v_intent := inventory_payload_digest('supplier.allocate_credit', v_tenant, v_business,
    ARRAY['uuid', 'uuid', 'uuid', 'integer', 'integer', 'integer'],
    ARRAY[p_allocation_id::text, p_credit_note_id::text, p_purchase_id::text, to_char(p_allocation_date, 'YYYYMMDD'),
          p_consumed_minor::text, p_applied_minor::text]);

  -- 4. The replay read, before any other read.
  SELECT c.intent_sha256 INTO v_stored FROM supplier_credit_allocations c WHERE c.business_id = v_business AND c.id = p_allocation_id;
  IF FOUND THEN
    IF v_stored <> v_intent THEN
      RAISE EXCEPTION 'supplier_credit_allocation.idempotency_conflict: this allocation id was already used for another credit allocation' USING ERRCODE = 'P0001';
    END IF;
    v_replay := true;
  ELSE
    -- 5. Shape, before any state read.
    IF p_credit_note_id IS NULL OR p_purchase_id IS NULL OR p_warehouse_id IS NULL OR p_allocation_date IS NULL
       OR p_credit_currency IS NULL OR p_consumed_minor IS NULL OR p_remaining_before_minor IS NULL OR p_credit_released_minor IS NULL
       OR p_credit_dust_minor IS NULL OR p_purchase_currency IS NULL OR p_applied_minor IS NULL OR p_ap_released_before_minor IS NULL
       OR p_ap_released_minor IS NULL OR p_ap_dust_minor IS NULL OR p_realized_minor IS NULL
       OR p_consumed_minor <= 0 OR p_applied_minor <= 0 THEN
      RAISE EXCEPTION 'inventory.payload_invalid: a supplier credit allocation binds its note, purchase, date and positive amounts' USING ERRCODE = 'P0001';
    END IF;

    -- 6. Lock step 2a: the target purchase FOR UPDATE.
    SELECT p.status, p.supplier_id, p.warehouse_id, p.currency_code, p.document_date, p.total_txn_minor, p.total_base_minor,
           p.source_to_base_rate
      INTO v_p
    FROM purchases p WHERE p.business_id = v_business AND p.id = p_purchase_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'purchase.not_found: the purchase does not exist in this business' USING ERRCODE = 'P0001';
    END IF;
    IF v_p.status <> 'received' THEN
      RAISE EXCEPTION 'supplier_credit_allocation.purchase_state_invalid: a supplier credit is applied to a received purchase only' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM purchase_reversals r WHERE r.business_id = v_business AND r.id = p_purchase_id) THEN
      RAISE EXCEPTION 'supplier_credit_allocation.purchase_reversed: a supplier credit is not applied to a reversed purchase' USING ERRCODE = 'P0001';
    END IF;
    IF v_p.warehouse_id <> p_warehouse_id OR v_p.currency_code <> p_purchase_currency THEN
      RAISE EXCEPTION 'supplier_credit_allocation.settlement_changed: the purchase changed since the allocation was prepared' USING ERRCODE = 'P0001';
    END IF;

    -- 7. Lock step 2a': the note FOR UPDATE (MP-6, PM-15).
    SELECT n.supplier_id, n.currency_code, n.original_amount_minor, n.original_carrying_base_amount_minor, n.remaining_amount_minor,
           n.source_to_base_rate, n.issued_on
      INTO v_note
    FROM supplier_credit_notes n WHERE n.business_id = v_business AND n.id = p_credit_note_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'supplier_credit_note.not_found: the supplier credit note does not exist in this business' USING ERRCODE = 'P0001';
    END IF;
    IF v_note.supplier_id <> v_p.supplier_id THEN
      RAISE EXCEPTION 'supplier_credit_allocation.supplier_mismatch: a supplier credit is applied to a purchase of the same supplier' USING ERRCODE = 'P0001';
    END IF;
    IF v_note.remaining_amount_minor = 0 THEN
      RAISE EXCEPTION 'supplier_credit_allocation.credit_exhausted: the supplier credit note has no remaining amount' USING ERRCODE = 'P0001';
    END IF;
    IF p_consumed_minor > v_note.remaining_amount_minor THEN
      RAISE EXCEPTION 'supplier_credit_allocation.amount_exceeds_credit: an allocation consumes more than the note''s remaining amount' USING ERRCODE = 'P0001';
    END IF;
    IF p_remaining_before_minor <> v_note.remaining_amount_minor OR v_note.currency_code <> p_credit_currency THEN
      RAISE EXCEPTION 'supplier_credit_allocation.settlement_changed: the credit note changed since the allocation was prepared' USING ERRCODE = 'P0001';
    END IF;

    -- 8. Lock step 2b: the supplier FOR SHARE; an inactive one is allowed (TL-13).
    PERFORM 1 FROM suppliers s WHERE s.business_id = v_business AND s.id = v_p.supplier_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'supplier.not_found: the supplier does not exist in this business' USING ERRCODE = 'P0001';
    END IF;

    -- 9. The dates: not before the purchase or the note, not after today.
    SELECT b.timezone, b.base_currency INTO v_tz, v_base_ccy FROM businesses b WHERE b.id = v_business;
    IF p_allocation_date < greatest(v_p.document_date, v_note.issued_on) THEN
      RAISE EXCEPTION 'supplier_credit_allocation.date_before_source: an allocation is dated on or after its purchase and its credit note' USING ERRCODE = 'P0001';
    END IF;
    IF p_allocation_date > (now() AT TIME ZONE v_tz)::date THEN
      RAISE EXCEPTION 'supplier_credit_allocation.date_in_future: an allocation is dated on or before today in the business timezone' USING ERRCODE = 'P0001';
    END IF;

    -- 10. The AP side (A-08) and the credit side (A-10), each at its own
    --     stored snapshot; no new FX.
    SELECT c.minor_units INTO v_et FROM currencies c WHERE c.code = v_p.currency_code::text;
    SELECT c.minor_units INTO v_en FROM currencies c WHERE c.code = v_note.currency_code::text;
    SELECT c.minor_units INTO v_eb FROM currencies c WHERE c.code = v_base_ccy;
    v_o := purchase_ap_outstanding(v_business, p_purchase_id);
    IF p_applied_minor > v_o THEN
      RAISE EXCEPTION 'supplier_credit_allocation.amount_exceeds_outstanding: an allocation applies more than the purchase''s outstanding amount' USING ERRCODE = 'P0001';
    END IF;
    IF v_note.currency_code = v_p.currency_code AND p_consumed_minor <> p_applied_minor THEN
      RAISE EXCEPTION 'supplier_credit_allocation.amount_mismatch: in one currency the consumed and applied amounts are equal' USING ERRCODE = 'P0001';
    END IF;
    v_x       := v_p.total_txn_minor - v_o;
    v_rel     := supplier_ap_release(v_p.total_base_minor, v_p.total_txn_minor, v_x, p_applied_minor);
    v_conv    := supplier_convert_base(p_applied_minor, v_p.source_to_base_rate, v_et, v_eb);
    v_cr_rel  := supplier_credit_remaining_carrying(v_note.original_amount_minor, v_note.original_carrying_base_amount_minor, v_note.remaining_amount_minor)
                 - supplier_credit_remaining_carrying(v_note.original_amount_minor, v_note.original_carrying_base_amount_minor,
                                                      v_note.remaining_amount_minor - p_consumed_minor);
    v_cr_conv := supplier_convert_base(p_consumed_minor, v_note.source_to_base_rate, v_en, v_eb);
    IF v_conv = 0 OR v_cr_conv = 0 THEN
      RAISE EXCEPTION 'supplier_credit_allocation.amount_below_base_unit: an applied or consumed amount converts to less than one base minor unit' USING ERRCODE = 'P0001';
    END IF;
    -- R-77 / R-78: never a sub-unit residue on the purchase or on the note.
    IF (p_applied_minor < v_o AND supplier_convert_base(v_o - p_applied_minor, v_p.source_to_base_rate, v_et, v_eb) = 0)
       OR (p_consumed_minor < v_note.remaining_amount_minor
           AND supplier_convert_base(v_note.remaining_amount_minor - p_consumed_minor, v_note.source_to_base_rate, v_en, v_eb) = 0) THEN
      RAISE EXCEPTION 'supplier_credit_allocation.residue_below_base_unit: an allocation would leave the purchase or the note a remaining amount converting to less than one base minor unit' USING ERRCODE = 'P0001';
    END IF;
    IF p_ap_released_before_minor <> v_x OR p_ap_released_minor <> v_rel OR p_ap_dust_minor <> v_rel - v_conv
       OR p_credit_released_minor <> v_cr_rel OR p_credit_dust_minor <> v_cr_rel - v_cr_conv OR p_realized_minor <> v_cr_rel - v_rel THEN
      RAISE EXCEPTION 'supplier_credit_allocation.settlement_changed: the purchase''s outstanding amount or the note changed since the allocation was prepared' USING ERRCODE = 'P0001';
    END IF;

    -- 11. The allocation, before the note decrement (A-12(4)).
    INSERT INTO supplier_credit_allocations (tenant_id, business_id, id, supplier_id, credit_note_id, purchase_id, allocation_date,
                                             credit_currency, credit_amount_consumed_minor, credit_to_base_rate, credit_remaining_before_minor,
                                             credit_carrying_base_released_minor, credit_dust_base_minor, purchase_currency,
                                             purchase_amount_applied_minor, purchase_historical_to_base_rate, ap_released_before_txn_minor,
                                             purchase_carrying_base_released_minor, ap_dust_base_minor, realized_fx_gain_loss_minor,
                                             intent_sha256, business_transaction_id, created_by, binding_source_id)
    VALUES (v_tenant, v_business, p_allocation_id, v_p.supplier_id, p_credit_note_id, p_purchase_id, p_allocation_date,
            v_note.currency_code, p_consumed_minor, v_note.source_to_base_rate, p_remaining_before_minor,
            p_credit_released_minor, p_credit_dust_minor, v_p.currency_code,
            p_applied_minor, v_p.source_to_base_rate, p_ap_released_before_minor,
            p_ap_released_minor, p_ap_dust_minor, p_realized_minor,
            v_intent, v_trace, v_actor.actor_user_id, p_allocation_id);

    -- 12. The note: both remaining values in one decrement, by the R-73 writer.
    PERFORM supplier_credit_note_consume(p_credit_note_id, p_remaining_before_minor, p_consumed_minor);

    -- 13. Audit and outbox (A-20): ids, never an amount.
    INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
    VALUES (v_tenant, v_business, v_actor.actor_user_id, 'supplier.credit_allocated', 'supplier_credit_allocation', p_allocation_id::text,
            jsonb_build_object('creditNoteId', p_credit_note_id, 'purchaseId', p_purchase_id, 'assertionJti', v_actor.jti,
                               'business_transaction_id', v_trace));
    INSERT INTO outbox_events (tenant_id, business_id, type, payload)
    VALUES (v_tenant, v_business, 'supplier.credit_allocated.v1',
            jsonb_build_object('businessId', v_business, 'allocationId', p_allocation_id, 'creditNoteId', p_credit_note_id,
                               'purchaseId', p_purchase_id, 'businessTransactionId', v_trace));
  END IF;

  RETURN QUERY
  SELECT c.id, v_replay FROM supplier_credit_allocations c WHERE c.business_id = v_business AND c.id = p_allocation_id;
END;
$$;

COMMENT ON FUNCTION supplier_allocate_credit(UUID, UUID, UUID, UUID, DATE, CHAR(3), BIGINT, BIGINT, BIGINT, BIGINT, CHAR(3), BIGINT, BIGINT, BIGINT, BIGINT, BIGINT) IS
  'P3-S6 §2.6, A-08, A-10, A-11, A-16. First consumes an invctl/1 assertion of kind supplier.allocate_credit over its own arguments. Under the daftar.supplier_credit_allocation_id key, with the intent (id, note, purchase, date, consumed, applied): an equal stored intent replays, another is supplier_credit_allocation.idempotency_conflict. Then the shape (inventory.payload_invalid), the purchase FOR UPDATE (purchase.not_found, purchase_state_invalid, purchase_reversed, settlement_changed), the note FOR UPDATE (supplier_credit_note.not_found, supplier_mismatch, credit_exhausted, amount_exceeds_credit, settlement_changed), the supplier FOR SHARE (inactive allowed), the dates (date_before_source, date_in_future), the AP and credit sides recomputed at their stored snapshots (amount_exceeds_outstanding, amount_mismatch, amount_below_base_unit, residue_below_base_unit R-77/R-78, settlement_changed). Inserts the allocation, then decrements the note through supplier_credit_note_consume (R-73); audit supplier.credit_allocated and its outbox row. The caller posts the supplier_credit_allocation entry. EXECUTE: daftar_app only.';

-- ─────────────────────────────────────────────────────────────────────────
-- 5. supplier.receive_refund (§2.6, A-10, A-15, AL-31). A supplier credit
--    refunded in money through a payment method, at the receipt's own FX
--    snapshot; the note is decremented by the R-73 writer.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION supplier_receive_refund(
  p_refund_id              UUID,
  p_credit_note_id         UUID,
  p_payment_method_id      UUID,
  p_posting_account_id     UUID,
  p_refund_date            DATE,
  p_source_currency        CHAR(3),
  p_consumed_minor         BIGINT,
  p_remaining_before_minor BIGINT,
  p_source_released_minor  BIGINT,
  p_source_dust_minor      BIGINT,
  p_receipt_currency       CHAR(3),
  p_receipt_amount_minor   BIGINT,
  p_rate_id                UUID,
  p_rate                   NUMERIC,
  p_rate_source            TEXT,
  p_rate_at                TIMESTAMPTZ,
  p_receipt_base_minor     BIGINT,
  p_realized_minor         BIGINT,
  p_reference              TEXT
) RETURNS TABLE (
  refund_id UUID,
  replayed  BOOLEAN
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
  v_note     RECORD;
  v_m        RECORD;
  v_tz       TEXT;
  v_base_ccy TEXT;
  v_en       INTEGER;
  v_er       INTEGER;
  v_eb       INTEGER;
  v_fx       accounting_fx_rate_snapshot;
  v_rate_id  UUID;
  v_rate     NUMERIC;
  v_source   TEXT;
  v_at       TIMESTAMPTZ;
  v_cr_rel   BIGINT;
  v_cr_conv  BIGINT;
  v_mb       BIGINT;
BEGIN
  -- 1. The consume, over the routine's own arguments in the A-16 order.
  v_actor := inventory_assertion_consume('supplier.receive_refund', inventory_claimed_payload_digest('supplier.receive_refund',
    ARRAY['uuid', 'uuid', 'uuid', 'uuid', 'integer', 'code', 'integer', 'integer', 'integer', 'integer', 'code', 'integer', 'uuid',
          'integer', 'code', 'integer', 'integer', 'integer'] || array_fill('integer'::text, ARRAY[8]),
    ARRAY[p_refund_id::text, p_credit_note_id::text, p_payment_method_id::text, p_posting_account_id::text, to_char(p_refund_date, 'YYYYMMDD'),
          lower(p_source_currency::text), p_consumed_minor::text, p_remaining_before_minor::text, p_source_released_minor::text,
          p_source_dust_minor::text, lower(p_receipt_currency::text), p_receipt_amount_minor::text, p_rate_id::text,
          inventory_fixed_text(p_rate, 10), p_rate_source,
          CASE WHEN extract(epoch FROM p_rate_at) = trunc(extract(epoch FROM p_rate_at))
               THEN trunc(extract(epoch FROM p_rate_at))::text ELSE extract(epoch FROM p_rate_at)::text END,
          p_receipt_base_minor::text, p_realized_minor::text]
      || inventory_reason_words(p_reference)));
  -- 2. Isolation and trace.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: inventory commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_business := v_actor.business_id;
  v_tenant   := v_actor.tenant_id;
  v_replay   := false;
  v_trace    := inventory_business_transaction_id();
  IF v_trace IS NULL THEN
    RAISE EXCEPTION 'inventory.trace_missing: a supplier refund records its business transaction id' USING ERRCODE = 'P0001';
  END IF;
  IF p_refund_id IS NULL THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a supplier refund names its id' USING ERRCODE = 'P0001';
  END IF;

  -- 3. The document key, then the intent (A-16: id, note, method, date,
  --    consumed, receipt currency and amount, reference).
  PERFORM pg_advisory_xact_lock(hashtext('daftar.supplier_refund_id'), hashtext(p_refund_id::text));
  v_intent := inventory_payload_digest('supplier.receive_refund', v_tenant, v_business,
    ARRAY['uuid', 'uuid', 'uuid', 'integer', 'integer', 'code', 'integer'] || array_fill('integer'::text, ARRAY[8]),
    ARRAY[p_refund_id::text, p_credit_note_id::text, p_payment_method_id::text, to_char(p_refund_date, 'YYYYMMDD'), p_consumed_minor::text,
          lower(p_receipt_currency::text), p_receipt_amount_minor::text]
      || inventory_reason_words(p_reference));

  -- 4. The replay read, before any other read.
  SELECT f.intent_sha256 INTO v_stored FROM supplier_refunds f WHERE f.business_id = v_business AND f.id = p_refund_id;
  IF FOUND THEN
    IF v_stored <> v_intent THEN
      RAISE EXCEPTION 'supplier_refund.idempotency_conflict: this refund id was already used for another refund' USING ERRCODE = 'P0001';
    END IF;
    v_replay := true;
  ELSE
    -- 5. Shape, before any state read.
    IF p_credit_note_id IS NULL OR p_payment_method_id IS NULL OR p_posting_account_id IS NULL OR p_refund_date IS NULL
       OR p_source_currency IS NULL OR p_consumed_minor IS NULL OR p_remaining_before_minor IS NULL OR p_source_released_minor IS NULL
       OR p_source_dust_minor IS NULL OR p_receipt_currency IS NULL OR p_receipt_amount_minor IS NULL OR p_rate IS NULL
       OR p_rate_source IS NULL OR p_rate_at IS NULL OR p_receipt_base_minor IS NULL OR p_realized_minor IS NULL
       OR p_consumed_minor <= 0 OR p_receipt_amount_minor <= 0
       OR (p_reference IS NOT NULL AND (p_reference <> btrim(p_reference) OR char_length(p_reference) NOT BETWEEN 1 AND 100)) THEN
      RAISE EXCEPTION 'inventory.payload_invalid: a supplier refund binds its note, method, date, positive amounts, rate snapshot and an optional trimmed reference' USING ERRCODE = 'P0001';
    END IF;

    -- 6. Lock step 2a': the note FOR UPDATE (MP-6, PM-15).
    SELECT n.supplier_id, n.currency_code, n.original_amount_minor, n.original_carrying_base_amount_minor, n.remaining_amount_minor,
           n.source_to_base_rate, n.issued_on
      INTO v_note
    FROM supplier_credit_notes n WHERE n.business_id = v_business AND n.id = p_credit_note_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'supplier_credit_note.not_found: the supplier credit note does not exist in this business' USING ERRCODE = 'P0001';
    END IF;
    IF v_note.remaining_amount_minor = 0 THEN
      RAISE EXCEPTION 'supplier_refund.credit_exhausted: the supplier credit note has no remaining amount' USING ERRCODE = 'P0001';
    END IF;
    IF p_consumed_minor > v_note.remaining_amount_minor THEN
      RAISE EXCEPTION 'supplier_refund.amount_exceeds_credit: a refund consumes more than the note''s remaining amount' USING ERRCODE = 'P0001';
    END IF;
    IF p_remaining_before_minor <> v_note.remaining_amount_minor OR v_note.currency_code <> p_source_currency THEN
      RAISE EXCEPTION 'supplier_refund.settlement_changed: the credit note changed since the refund was prepared' USING ERRCODE = 'P0001';
    END IF;

    -- 7. Lock step 2b: the note's supplier FOR SHARE; an inactive one is allowed.
    PERFORM 1 FROM suppliers s WHERE s.business_id = v_business AND s.id = v_note.supplier_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'supplier.not_found: the supplier does not exist in this business' USING ERRCODE = 'P0001';
    END IF;

    -- 8. Lock step 2c: the method FOR SHARE (R-65).
    SELECT m.is_active, m.posting_account_id, m.requires_reference INTO v_m
    FROM payment_methods m WHERE m.business_id = v_business AND m.id = p_payment_method_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'payment_method.not_found: the payment method does not exist in this business' USING ERRCODE = 'P0001';
    END IF;
    IF NOT v_m.is_active THEN
      RAISE EXCEPTION 'payment_method.inactive: a supplier refund is received through an active payment method' USING ERRCODE = 'P0001';
    END IF;
    IF v_m.posting_account_id <> p_posting_account_id THEN
      RAISE EXCEPTION 'supplier_refund.settlement_changed: the payment method''s posting account changed since the refund was prepared' USING ERRCODE = 'P0001';
    END IF;
    IF accounting_settlement_account_eligibility(v_business, v_m.posting_account_id) IS DISTINCT FROM 'eligible' THEN
      RAISE EXCEPTION 'payment_method.posting_account_ineligible: a payment method posts to an active settlement asset account of its business' USING ERRCODE = 'P0001';
    END IF;
    IF v_m.requires_reference AND p_reference IS NULL THEN
      RAISE EXCEPTION 'supplier_refund.reference_required: this payment method requires a reference' USING ERRCODE = 'P0001';
    END IF;

    -- 9. The dates: not before the note, not after today.
    SELECT b.timezone, b.base_currency INTO v_tz, v_base_ccy FROM businesses b WHERE b.id = v_business;
    IF p_refund_date < v_note.issued_on THEN
      RAISE EXCEPTION 'supplier_refund.date_before_credit: a refund is dated on or after its credit note' USING ERRCODE = 'P0001';
    END IF;
    IF p_refund_date > (now() AT TIME ZONE v_tz)::date THEN
      RAISE EXCEPTION 'supplier_refund.date_in_future: a refund is dated on or before today in the business timezone' USING ERRCODE = 'P0001';
    END IF;

    -- 10. The receipt FX snapshot (A-15, R-17) at the refund date.
    IF p_receipt_currency::text !~ '^[A-Z]{3}$' OR NOT EXISTS (SELECT 1 FROM currencies c WHERE c.code = p_receipt_currency::text) THEN
      RAISE EXCEPTION 'purchase.currency_unknown: the receipt currency is not a registered currency' USING ERRCODE = 'P0001';
    END IF;
    IF p_receipt_currency::text = v_base_ccy THEN
      v_rate_id := NULL;
      v_rate    := 1;
      v_source  := 'base';
      v_at      := p_refund_date::timestamp AT TIME ZONE 'UTC';
    ELSE
      v_fx := accounting_purchase_fx_rate(v_business, p_receipt_currency, ((p_refund_date + 1)::timestamp AT TIME ZONE v_tz) - interval '1 second');
      v_rate_id := v_fx.rate_id;
      v_rate    := v_fx.rate;
      v_source  := v_fx.source;
      v_at      := v_fx.effective_at;
    END IF;
    IF p_rate_id IS DISTINCT FROM v_rate_id OR p_rate <> v_rate OR p_rate_source <> v_source OR p_rate_at <> v_at THEN
      RAISE EXCEPTION 'supplier_refund.fx_rate_changed: the exchange rate changed since the refund was prepared' USING ERRCODE = 'P0001';
    END IF;

    -- 11. The credit side (A-10) at the note's snapshot, the receipt base
    --     and the realized FX mb − cr_rel.
    IF p_receipt_currency = v_note.currency_code AND p_receipt_amount_minor <> p_consumed_minor THEN
      RAISE EXCEPTION 'supplier_refund.amount_mismatch: in the note''s own currency the consumed and received amounts are equal' USING ERRCODE = 'P0001';
    END IF;
    SELECT c.minor_units INTO v_en FROM currencies c WHERE c.code = v_note.currency_code::text;
    SELECT c.minor_units INTO v_er FROM currencies c WHERE c.code = p_receipt_currency::text;
    SELECT c.minor_units INTO v_eb FROM currencies c WHERE c.code = v_base_ccy;
    v_cr_rel  := supplier_credit_remaining_carrying(v_note.original_amount_minor, v_note.original_carrying_base_amount_minor, v_note.remaining_amount_minor)
                 - supplier_credit_remaining_carrying(v_note.original_amount_minor, v_note.original_carrying_base_amount_minor,
                                                      v_note.remaining_amount_minor - p_consumed_minor);
    v_cr_conv := supplier_convert_base(p_consumed_minor, v_note.source_to_base_rate, v_en, v_eb);
    v_mb      := supplier_convert_base(p_receipt_amount_minor, v_rate, v_er, v_eb);
    IF v_cr_conv = 0 OR v_mb = 0 THEN
      RAISE EXCEPTION 'supplier_refund.amount_below_base_unit: a consumed or received amount converts to less than one base minor unit' USING ERRCODE = 'P0001';
    END IF;
    -- R-78: never a sub-unit residue on the note.
    IF p_consumed_minor < v_note.remaining_amount_minor
       AND supplier_convert_base(v_note.remaining_amount_minor - p_consumed_minor, v_note.source_to_base_rate, v_en, v_eb) = 0 THEN
      RAISE EXCEPTION 'supplier_refund.residue_below_base_unit: a refund would leave the note a remaining amount converting to less than one base minor unit' USING ERRCODE = 'P0001';
    END IF;
    IF p_source_released_minor <> v_cr_rel OR p_source_dust_minor <> v_cr_rel - v_cr_conv OR p_receipt_base_minor <> v_mb
       OR p_realized_minor <> v_mb - v_cr_rel THEN
      RAISE EXCEPTION 'supplier_refund.settlement_changed: the credit note changed since the refund was prepared' USING ERRCODE = 'P0001';
    END IF;

    -- 12. The refund, before the note decrement (A-12(4)).
    INSERT INTO supplier_refunds (tenant_id, business_id, id, supplier_id, credit_note_id, payment_method_id, posting_account_id, refund_date,
                                  reference, source_currency, source_amount_consumed_minor, source_to_base_rate, credit_remaining_before_minor,
                                  source_carrying_base_released_minor, source_dust_base_minor, receipt_currency, receipt_amount_minor,
                                  receipt_to_base_rate, receipt_base_amount_minor, rate_source, rate_timestamp, fx_rate_id,
                                  realized_fx_gain_loss_minor, intent_sha256, business_transaction_id, created_by, binding_source_id)
    VALUES (v_tenant, v_business, p_refund_id, v_note.supplier_id, p_credit_note_id, p_payment_method_id, p_posting_account_id, p_refund_date,
            p_reference, v_note.currency_code, p_consumed_minor, v_note.source_to_base_rate, p_remaining_before_minor,
            p_source_released_minor, p_source_dust_minor, p_receipt_currency, p_receipt_amount_minor,
            v_rate, p_receipt_base_minor, v_source, v_at, v_rate_id,
            p_realized_minor, v_intent, v_trace, v_actor.actor_user_id, p_refund_id);

    -- 13. The note: both remaining values in one decrement, by the R-73 writer.
    PERFORM supplier_credit_note_consume(p_credit_note_id, p_remaining_before_minor, p_consumed_minor);

    -- 14. Audit and outbox (A-20): ids, never an amount.
    INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
    VALUES (v_tenant, v_business, v_actor.actor_user_id, 'supplier.refund_received', 'supplier_refund', p_refund_id::text,
            jsonb_build_object('creditNoteId', p_credit_note_id, 'assertionJti', v_actor.jti, 'business_transaction_id', v_trace));
    INSERT INTO outbox_events (tenant_id, business_id, type, payload)
    VALUES (v_tenant, v_business, 'supplier.refund_received.v1',
            jsonb_build_object('businessId', v_business, 'refundId', p_refund_id, 'creditNoteId', p_credit_note_id,
                               'businessTransactionId', v_trace));
  END IF;

  RETURN QUERY
  SELECT f.id, v_replay FROM supplier_refunds f WHERE f.business_id = v_business AND f.id = p_refund_id;
END;
$$;

COMMENT ON FUNCTION supplier_receive_refund(UUID, UUID, UUID, UUID, DATE, CHAR(3), BIGINT, BIGINT, BIGINT, BIGINT, CHAR(3), BIGINT, UUID, NUMERIC, TEXT, TIMESTAMPTZ, BIGINT, BIGINT, TEXT) IS
  'P3-S6 §2.6, A-10, A-11, A-15, A-16. First consumes an invctl/1 assertion of kind supplier.receive_refund over its own arguments. Under the daftar.supplier_refund_id key, with the intent (id, note, method, date, consumed, receipt currency and amount, reference): an equal stored intent replays, another is supplier_refund.idempotency_conflict. Then the shape (inventory.payload_invalid), the note FOR UPDATE (supplier_credit_note.not_found, credit_exhausted, amount_exceeds_credit, settlement_changed), the supplier FOR SHARE (inactive allowed), the method FOR SHARE (payment_method.not_found, inactive, posting_account_ineligible; settlement_changed; reference_required), the dates (date_before_credit, date_in_future), the receipt FX snapshot (purchase.currency_unknown, fx_rate_changed), the credit side, receipt base and FX recomputed (amount_mismatch, amount_below_base_unit, residue_below_base_unit R-78, settlement_changed). Inserts the refund, then decrements the note through supplier_credit_note_consume (R-73); audit supplier.refund_received and its outbox row. The caller posts the supplier_refund entry. EXECUTE: daftar_app only.';

-- ─────────────────────────────────────────────────────────────────────────
-- 6. Privileges, then the ownership transfer (the 0062/0064/0066 order).
-- ─────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION payment_method_create(UUID, TEXT, UUID, BOOLEAN, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION payment_method_update(UUID, INTEGER, UUID, BOOLEAN, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION payment_method_deactivate(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION payment_method_activate(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION supplier_credit_note_consume(UUID, BIGINT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION supplier_pay(UUID, UUID, UUID, UUID, DATE, CHAR(3), BIGINT, UUID, NUMERIC, TEXT, TIMESTAMPTZ, BIGINT, TEXT, UUID[], UUID[], UUID[], TEXT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION supplier_allocate_credit(UUID, UUID, UUID, UUID, DATE, CHAR(3), BIGINT, BIGINT, BIGINT, BIGINT, CHAR(3), BIGINT, BIGINT, BIGINT, BIGINT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION supplier_receive_refund(UUID, UUID, UUID, UUID, DATE, CHAR(3), BIGINT, BIGINT, BIGINT, BIGINT, CHAR(3), BIGINT, UUID, NUMERIC, TEXT, TIMESTAMPTZ, BIGINT, BIGINT, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION payment_method_create(UUID, TEXT, UUID, BOOLEAN, INTEGER, TEXT, TEXT, TEXT) TO daftar_app;
GRANT EXECUTE ON FUNCTION payment_method_update(UUID, INTEGER, UUID, BOOLEAN, INTEGER, TEXT, TEXT, TEXT) TO daftar_app;
GRANT EXECUTE ON FUNCTION payment_method_deactivate(UUID, INTEGER) TO daftar_app;
GRANT EXECUTE ON FUNCTION payment_method_activate(UUID, INTEGER) TO daftar_app;
GRANT EXECUTE ON FUNCTION supplier_pay(UUID, UUID, UUID, UUID, DATE, CHAR(3), BIGINT, UUID, NUMERIC, TEXT, TIMESTAMPTZ, BIGINT, TEXT, UUID[], UUID[], UUID[], TEXT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[]) TO daftar_app;
GRANT EXECUTE ON FUNCTION supplier_allocate_credit(UUID, UUID, UUID, UUID, DATE, CHAR(3), BIGINT, BIGINT, BIGINT, BIGINT, CHAR(3), BIGINT, BIGINT, BIGINT, BIGINT, BIGINT) TO daftar_app;
GRANT EXECUTE ON FUNCTION supplier_receive_refund(UUID, UUID, UUID, UUID, DATE, CHAR(3), BIGINT, BIGINT, BIGINT, BIGINT, CHAR(3), BIGINT, UUID, NUMERIC, TEXT, TIMESTAMPTZ, BIGINT, BIGINT, TEXT) TO daftar_app;

GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;

ALTER FUNCTION payment_method_create(UUID, TEXT, UUID, BOOLEAN, INTEGER, TEXT, TEXT, TEXT) OWNER TO daftar_inventory_internal;
ALTER FUNCTION payment_method_update(UUID, INTEGER, UUID, BOOLEAN, INTEGER, TEXT, TEXT, TEXT) OWNER TO daftar_inventory_internal;
ALTER FUNCTION payment_method_deactivate(UUID, INTEGER) OWNER TO daftar_inventory_internal;
ALTER FUNCTION payment_method_activate(UUID, INTEGER) OWNER TO daftar_inventory_internal;
ALTER FUNCTION supplier_credit_note_consume(UUID, BIGINT, BIGINT) OWNER TO daftar_inventory_internal;
ALTER FUNCTION supplier_pay(UUID, UUID, UUID, UUID, DATE, CHAR(3), BIGINT, UUID, NUMERIC, TEXT, TIMESTAMPTZ, BIGINT, TEXT, UUID[], UUID[], UUID[], TEXT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[]) OWNER TO daftar_inventory_internal;
ALTER FUNCTION supplier_allocate_credit(UUID, UUID, UUID, UUID, DATE, CHAR(3), BIGINT, BIGINT, BIGINT, BIGINT, CHAR(3), BIGINT, BIGINT, BIGINT, BIGINT, BIGINT) OWNER TO daftar_inventory_internal;
ALTER FUNCTION supplier_receive_refund(UUID, UUID, UUID, UUID, DATE, CHAR(3), BIGINT, BIGINT, BIGINT, BIGINT, CHAR(3), BIGINT, UUID, NUMERIC, TEXT, TIMESTAMPTZ, BIGINT, BIGINT, TEXT) OWNER TO daftar_inventory_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 6a. The S6 guard discovery, re-created by the migrator (R-79): the 0067
--     function with every row and digest verbatim and one more row, the R-73
--     writer (internal-owned DEFINER, pinned, its prosrc SHA-256), which
--     0067 could not record because it is created here. Same signature,
--     owner, INVOKER STABLE, pinned path, no grantee.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION supplier_settlement_guard_gaps()
RETURNS TABLE (table_name TEXT, trigger_name TEXT, missing TEXT)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_g   RECORD;
  v_tg  RECORD;
  v_p   RECORD;
  v_fn  REGPROCEDURE;
  v_me  TEXT;
  -- SHA-256 (hex) of each S6 guard, helper and arithmetic function's prosrc,
  -- recorded at migration time (0067), the replaced credit-note guard and
  -- the two replaced extension points included (R-79), and of the R-73
  -- credit-note writer (0068).
  c_digest CONSTANT JSONB := '{
    "payment_method_guard()": "e1ebd743f99dae8e059d903d8fb73c65858cabb70ffc5dcb2fbd45407dadb162",
    "payment_method_named()": "07cdc55fa3181e6b4de214ff4a34a72674d2802de1c045c51662dcf6c2637390",
    "payment_method_name_guard()": "d0414ced4449ddb1cad3b312aa9674174a4a3df9717e2cdaddca794d050628fa",
    "supplier_payment_guard()": "f373f9ef42dbf417253913300ec96a53523b33ef9282c4fbdd9e6ef44ca62fca",
    "supplier_payment_complete()": "0c409912d2936944253c5f08534a4e8108eed0283ffead0e8f567c6f3dcfad54",
    "supplier_payment_allocation_guard()": "aaf2efe1e56207a406fb4ef956ee427ec26cc26a6d92db8a0a22286425e09b8d",
    "supplier_payment_allocation_value_complete()": "75116b059a15e70a6c34583a4802912eed0f36cdad6b9fe26e62a4790a3054ad",
    "supplier_credit_allocation_guard()": "0120e79f3e7be686632df65199bf46d65742d43094d5ab5d026810d8774c5886",
    "supplier_credit_allocation_value_complete()": "184a467ce6d59945f0c49fcaa16685722fbadb582f0a30f9adea04690aadc054",
    "supplier_refund_guard()": "72cb27729e52a82547bf70cd83f57e9d5abfd104890fe98bd64f339173630f15",
    "supplier_refund_value_complete()": "a82873ddad98bd9946c4d3c2213c998933487a8cc928bb966c724c3e121e4307",
    "supplier_credit_note_guard()": "a21031b39170a8cec024de3947b8de6ee70c7def674235fcdbff01f27d99177e",
    "purchase_reversal_unsettled()": "d84f8b51c5033fb47ceb4c03fccd41a7576faf4ed5529dc4a1c31a64bc9508bf",
    "purchase_settlement_verify(uuid,uuid)": "4fcbb7931c06fbf9cf11fc2ede6e4b97357d24b038ed412329c55a48cbafe8ba",
    "supplier_credit_note_verify(uuid,uuid)": "9d18ee17cfdd5f778ee3a767351506d6bbd2209c15d839ed6a295d601abbf76e",
    "supplier_convert_base(bigint,numeric,integer,integer)": "38d765449e2844c1d84971f09277b5857bbddbf741b62a3d8b4c1d4e532e39cf",
    "supplier_ap_release(bigint,bigint,bigint,bigint)": "47eb15a7fc56e1871b5c521ca189782bfbafb8dca3e7bd0bb3adc417016236a9",
    "supplier_credit_remaining_carrying(bigint,bigint,bigint)": "941082099606f825336b0249a76658e65e592df6bbe06f3081576a5be0205144",
    "purchase_ap_outstanding(uuid,uuid)": "74091f5ea48dd4873664692bb06cf1d9de025d1b98093c3d2b39bbd300d3b036",
    "purchase_settlement_state(uuid,uuid)": "b236cda5fe48a2b00c818e0f88f8e9b8de9a3c5b61d04c5cf677e56960d7037b",
    "supplier_credit_note_consume(uuid,bigint,bigint)": "1754d8ac0581a8738c4d0e088671180e9b681ed7fb42575283b1c21d00b98c5b"
  }';
BEGIN
  -- The extension points' expected owner: the migrator, who owns this discovery.
  SELECT r.rolname::text INTO v_me
  FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
  WHERE p.oid = 'public.supplier_settlement_guard_gaps()'::regprocedure;
  FOR v_g IN
    SELECT e.tbl, e.tg, e.typ, e.deferred, e.fn, (e.ord IN (19, 20)) AS invoker
    FROM (VALUES
      (1,  'payment_methods',              'payment_methods_guard',                       31,   false, 'payment_method_guard()'),
      (2,  'payment_methods',              'payment_methods_named',                       21,   true,  'payment_method_named()'),
      (3,  'payment_method_names',         'payment_method_names_guard',                  31,   false, 'payment_method_name_guard()'),
      (4,  'supplier_payments',            'supplier_payments_guard',                     31,   false, 'supplier_payment_guard()'),
      (5,  'supplier_payments',            'supplier_payments_complete',                  5,    true,  'supplier_payment_complete()'),
      (6,  'supplier_payment_allocations', 'supplier_payment_allocations_guard',          31,   false, 'supplier_payment_allocation_guard()'),
      (7,  'supplier_payment_allocations', 'supplier_payment_allocations_value_complete', 5,    true,  'supplier_payment_allocation_value_complete()'),
      (8,  'supplier_credit_allocations',  'supplier_credit_allocations_guard',           31,   false, 'supplier_credit_allocation_guard()'),
      (9,  'supplier_credit_allocations',  'supplier_credit_allocations_value_complete',  5,    true,  'supplier_credit_allocation_value_complete()'),
      (10, 'supplier_refunds',             'supplier_refunds_guard',                      31,   false, 'supplier_refund_guard()'),
      (11, 'supplier_refunds',             'supplier_refunds_value_complete',             5,    true,  'supplier_refund_value_complete()'),
      (12, 'supplier_credit_notes',        'supplier_credit_notes_immutable',             27,   false, 'supplier_credit_note_guard()'),
      (13, 'purchase_reversals',           'purchase_reversals_unsettled',                5,    true,  'purchase_reversal_unsettled()'),
      (14, '-', 'purchase_settlement_verify(uuid,uuid)',                    NULL, NULL, 'purchase_settlement_verify(uuid,uuid)'),
      (15, '-', 'supplier_credit_note_verify(uuid,uuid)',                   NULL, NULL, 'supplier_credit_note_verify(uuid,uuid)'),
      (16, '-', 'supplier_convert_base(bigint,numeric,integer,integer)',    NULL, NULL, 'supplier_convert_base(bigint,numeric,integer,integer)'),
      (17, '-', 'supplier_ap_release(bigint,bigint,bigint,bigint)',         NULL, NULL, 'supplier_ap_release(bigint,bigint,bigint,bigint)'),
      (18, '-', 'supplier_credit_remaining_carrying(bigint,bigint,bigint)', NULL, NULL, 'supplier_credit_remaining_carrying(bigint,bigint,bigint)'),
      (19, '-', 'purchase_ap_outstanding(uuid,uuid)',                       NULL, NULL, 'purchase_ap_outstanding(uuid,uuid)'),
      (20, '-', 'purchase_settlement_state(uuid,uuid)',                     NULL, NULL, 'purchase_settlement_state(uuid,uuid)'),
      (21, '-', 'supplier_credit_note_consume(uuid,bigint,bigint)',         NULL, NULL, 'supplier_credit_note_consume(uuid,bigint,bigint)')
    ) AS e(ord, tbl, tg, typ, deferred, fn)
    ORDER BY e.ord
  LOOP
    v_fn := to_regprocedure('public.' || v_g.fn);
    IF v_g.tbl <> '-' THEN
      SELECT g.tgenabled::text AS enabled, g.tgtype::integer AS typ, g.tgfoid,
             (g.tgqual IS NULL AND cardinality(g.tgattr::int2[]) = 0) AS plain,
             (g.tgconstraint <> 0 AND g.tgdeferrable AND g.tginitdeferred) AS deferred
        INTO v_tg
      FROM pg_trigger g
      WHERE g.tgrelid = to_regclass('public.' || v_g.tbl) AND g.tgname = v_g.tg AND NOT g.tgisinternal;
      IF NOT FOUND THEN
        table_name := v_g.tbl; trigger_name := v_g.tg; missing := 'trigger_missing'; RETURN NEXT;
        CONTINUE;
      END IF;
      IF v_tg.enabled <> 'O' THEN
        table_name := v_g.tbl; trigger_name := v_g.tg; missing := 'trigger_disabled'; RETURN NEXT;
      END IF;
      IF v_tg.typ <> v_g.typ OR v_tg.deferred <> v_g.deferred OR NOT v_tg.plain OR v_fn IS NULL OR v_tg.tgfoid <> v_fn THEN
        table_name := v_g.tbl; trigger_name := v_g.tg; missing := 'trigger_shape'; RETURN NEXT;
      END IF;
    END IF;
    SELECT r.rolname::text AS owner, p.prosecdef, p.proconfig, encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') AS digest
      INTO v_p
    FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
    WHERE p.oid = v_fn;
    IF NOT FOUND THEN
      table_name := v_g.tbl; trigger_name := v_g.tg; missing := 'function_body'; RETURN NEXT;
      CONTINUE;
    END IF;
    IF v_p.owner IS DISTINCT FROM (CASE WHEN v_g.invoker THEN v_me ELSE 'daftar_inventory_internal' END) THEN
      table_name := v_g.tbl; trigger_name := v_g.tg; missing := 'function_owner'; RETURN NEXT;
    END IF;
    IF NOT v_g.invoker AND NOT v_p.prosecdef THEN
      table_name := v_g.tbl; trigger_name := v_g.tg; missing := 'function_not_definer'; RETURN NEXT;
    END IF;
    IF v_g.invoker AND v_p.prosecdef THEN
      table_name := v_g.tbl; trigger_name := v_g.tg; missing := 'function_not_invoker'; RETURN NEXT;
    END IF;
    IF v_p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp'] THEN
      table_name := v_g.tbl; trigger_name := v_g.tg; missing := 'function_search_path'; RETURN NEXT;
    END IF;
    IF v_p.digest IS DISTINCT FROM c_digest ->> v_g.fn THEN
      table_name := v_g.tbl; trigger_name := v_g.tg; missing := 'function_body'; RETURN NEXT;
    END IF;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION supplier_settlement_guard_gaps() IS
  'P3-S6 §2.3 (0067, R-70(a); re-created by 0068, R-79). Catalogue-only discovery of the S6 guards: for each of the thirteen §2.3 triggers (payment_methods_guard, payment_methods_named, payment_method_names_guard, supplier_payments_guard, supplier_payments_complete, supplier_payment_allocations_guard, supplier_payment_allocations_value_complete, supplier_credit_allocations_guard, supplier_credit_allocations_value_complete, supplier_refunds_guard, supplier_refunds_value_complete, the S5 supplier_credit_notes_immutable on its replaced function, purchase_reversals_unsettled) reports trigger_missing, trigger_disabled (tgenabled other than O) and trigger_shape (tgtype, deferral, WHEN, column list, function); for each trigger function, the two verification helpers, the three arithmetic functions and the credit-note writer supplier_credit_note_consume (table_name -, trigger_name the signature) reports function_owner (not daftar_inventory_internal), function_not_definer, function_search_path and function_body (the SHA-256 of prosrc recorded at migration time); for the two replaced extension points purchase_ap_outstanding and purchase_settlement_state reports function_owner (not this discovery''s migrator owner), function_not_invoker, function_search_path and function_body. Migrator-owned INVOKER; no EXECUTE grant.';

REVOKE ALL ON FUNCTION supplier_settlement_guard_gaps() FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────
-- 7. Registrations (§2.8), LAST: the seven kinds. No op→movement pair: no
--    S6 command moves stock.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO inventory_operation_kinds (op_code, registered_by) VALUES
  ('payment.create_method', 'P3-S6'), ('payment.update_method', 'P3-S6'), ('payment.deactivate_method', 'P3-S6'),
  ('payment.activate_method', 'P3-S6'), ('supplier.pay', 'P3-S6'), ('supplier.allocate_credit', 'P3-S6'),
  ('supplier.receive_refund', 'P3-S6');

-- ─────────────────────────────────────────────────────────────────────────
-- 8. Refuse to commit unless the end state is exactly right (0068-E, §2.9).
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
  v_replay  INTEGER;
  c_runtime CONSTANT TEXT[] := ARRAY['daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver',
                                     'daftar_provisioner', 'daftar_reconciler', 'public'];
  c_entry   CONSTANT REGPROCEDURE[] := ARRAY[
    'payment_method_create(uuid,text,uuid,boolean,integer,text,text,text)'::regprocedure,
    'payment_method_update(uuid,integer,uuid,boolean,integer,text,text,text)'::regprocedure,
    'payment_method_deactivate(uuid,integer)'::regprocedure,
    'payment_method_activate(uuid,integer)'::regprocedure,
    'supplier_pay(uuid,uuid,uuid,uuid,date,character,bigint,uuid,numeric,text,timestamp with time zone,bigint,text,uuid[],uuid[],uuid[],text[],bigint[],bigint[],bigint[],bigint[],bigint[],bigint[],bigint[])'::regprocedure,
    'supplier_allocate_credit(uuid,uuid,uuid,uuid,date,character,bigint,bigint,bigint,bigint,character,bigint,bigint,bigint,bigint,bigint)'::regprocedure,
    'supplier_receive_refund(uuid,uuid,uuid,uuid,date,character,bigint,bigint,bigint,bigint,character,bigint,uuid,numeric,text,timestamp with time zone,bigint,bigint,text)'::regprocedure];
  c_writer  CONSTANT REGPROCEDURE := 'supplier_credit_note_consume(uuid,bigint,bigint)'::regprocedure;
BEGIN
  -- (1) The operation registry: the S1 three, S3 seven, S4 seven, S5 two and
  --     S6 seven (26).
  SELECT string_agg(k.op_code || ':' || k.registered_by, ', ' ORDER BY k.op_code) INTO v_detail FROM inventory_operation_kinds k;
  IF v_detail IS DISTINCT FROM
     'inventory.adjust:P3-S3, inventory.configure_product:P3-S1, inventory.damage:P3-S3, inventory.opening:P3-S3, '
     'inventory.stocktake_count:P3-S3, inventory.stocktake_finalize:P3-S3, inventory.stocktake_open:P3-S3, inventory.transfer:P3-S3, '
     'payment.activate_method:P3-S6, payment.create_method:P3-S6, payment.deactivate_method:P3-S6, payment.update_method:P3-S6, '
     'purchase.cancel:P3-S4, purchase.draft:P3-S4, purchase.receive:P3-S4, purchase.return:P3-S5, purchase.reverse:P3-S5, '
     'structure.associate_warehouse_branch:P3-S1, structure.dissociate_warehouse_branch:P3-S1, '
     'supplier.allocate_credit:P3-S6, supplier.archive:P3-S4, supplier.create:P3-S4, supplier.pay:P3-S6, supplier.reactivate:P3-S4, '
     'supplier.receive_refund:P3-S6, supplier.update:P3-S4'
     OR (SELECT count(*) FROM inventory_operation_kinds) <> 26 THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: inventory_operation_kinds is not the S1 three, S3 seven, S4 seven, S5 two and S6 seven, found %', v_detail;
  END IF;

  -- (2) The op→movement registry is unchanged since 0066.
  SELECT string_agg(m.op_code || '>' || m.movement_kind || ':' || m.registered_by, ', ' ORDER BY m.op_code, m.movement_kind) INTO v_detail
  FROM inventory_operation_movement_kinds m;
  IF v_detail IS DISTINCT FROM
     'inventory.adjust>adjustment:P3-S3, inventory.damage>damage:P3-S3, inventory.opening>inventory_opening:P3-S3, '
     'inventory.stocktake_finalize>stocktake:P3-S3, inventory.transfer>transfer_in:P3-S3, inventory.transfer>transfer_out:P3-S3, '
     'purchase.receive>negative_inventory_cost_adjustment:P3-S4, purchase.receive>purchase:P3-S4, '
     'purchase.return>supplier_return:P3-S5, purchase.reverse>purchase_reversal:P3-S5' THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: inventory_operation_movement_kinds changed after 0066, found %', v_detail;
  END IF;

  -- (3) The seven entry routines and the R-73 writer: internal-owned
  --     DEFINER with the pinned path, and no other routine of those names.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_detail
  FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
  WHERE p.oid = ANY (c_entry || c_writer)
    AND (r.rolname <> 'daftar_inventory_internal' OR NOT p.prosecdef
         OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']);
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: routine(s) not internal-owned SECURITY DEFINER with the pinned path: %', v_detail;
  END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.oid = ANY (c_entry || c_writer)) <> 8
     OR (SELECT count(*) FROM pg_proc p WHERE p.proname IN ('payment_method_create', 'payment_method_update', 'payment_method_deactivate',
                                                            'payment_method_activate', 'supplier_pay', 'supplier_allocate_credit',
                                                            'supplier_receive_refund', 'supplier_credit_note_consume')) <> 8 THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: the S6 routines are not exactly the seven entry routines and the credit-note writer';
  END IF;

  -- (4) daftar_app reaches each entry routine and nobody else does; nobody
  --     reaches the writer.
  FOREACH v_proc IN ARRAY c_entry LOOP
    IF NOT has_function_privilege('daftar_app', v_proc, 'EXECUTE') THEN
      RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: daftar_app cannot reach %', v_proc;
    END IF;
    FOREACH v_role IN ARRAY c_runtime || ARRAY['daftar_accounting_internal'] LOOP
      IF has_function_privilege(v_role, v_proc, 'EXECUTE') THEN
        RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: % may call %', v_role, v_proc;
      END IF;
    END LOOP;
    SELECT string_agg(x.grantee::regrole::text, ',' ORDER BY x.grantee::regrole::text) INTO v_detail
    FROM pg_proc p, aclexplode(p.proacl) x
    WHERE p.oid = v_proc AND x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner;
    IF v_detail IS DISTINCT FROM 'daftar_app' THEN
      RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: % must be executable by daftar_app only, found %', v_proc, v_detail;
    END IF;
  END LOOP;
  FOREACH v_role IN ARRAY c_runtime || ARRAY['daftar_app', 'daftar_accounting_internal'] LOOP
    IF has_function_privilege(v_role, c_writer, 'EXECUTE') THEN
      RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: % may call the writer %', v_role, c_writer;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
              WHERE p.oid = c_writer AND x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner) THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: the writer % has an EXECUTE grantee', c_writer;
  END IF;

  -- (5) Every entry routine consumes its assertion as its first statement;
  --     the writer re-verifies it as its first (rule 22 at deploy time).
  FOREACH v_proc IN ARRAY c_entry LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_proc;
    v_first := btrim(split_part(substr(v_src, position(E'\nBEGIN\n' IN v_src) + 7), ';', 1));
    v_first := btrim(regexp_replace(v_first, '^(\s*--[^\n]*\n)+', ''));
    IF position(E'\nBEGIN\n' IN v_src) = 0 OR v_first !~ '^v_actor := inventory_assertion_consume\(' THEN
      RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: % does not consume its assertion as its first statement', v_proc;
    END IF;
  END LOOP;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = c_writer;
  v_first := btrim(split_part(substr(v_src, position(E'\nBEGIN\n' IN v_src) + 7), ';', 1));
  IF position(E'\nBEGIN\n' IN v_src) = 0 OR v_first !~ '^v_actor := inventory_assertion_current\(ARRAY\[' THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: % does not re-verify the assertion as its first statement', c_writer;
  END IF;

  -- (6) R-26: in every routine the document key precedes the intent and
  --     every row read; in the three settlement routines the replay read
  --     precedes the first read of purchases and of supplier_credit_notes.
  FOREACH v_proc IN ARRAY c_entry LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_proc;
    v_key  := position('PERFORM pg_advisory_xact_lock(hashtext(''daftar.' IN v_src);
    v_read := position('v_intent :=' IN v_src);
    IF v_key = 0 OR v_read = 0 OR v_key > v_read
       OR position('FROM payment_methods' IN v_src) BETWEEN 1 AND v_key
       OR position('FROM purchases' IN v_src) BETWEEN 1 AND v_key
       OR position('FROM supplier_credit_notes' IN v_src) BETWEEN 1 AND v_key THEN
      RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: % does not take its document key before its intent and row reads (R-26)', v_proc;
    END IF;
  END LOOP;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = c_entry[5];
  v_replay := position('FROM supplier_payments s WHERE s.business_id = v_business AND s.id = p_payment_id' IN v_src);
  IF v_replay = 0 OR v_replay > position('FROM purchases' IN v_src) THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: supplier_pay does not prove its replay before it reads a purchase';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = c_entry[6];
  v_replay := position('FROM supplier_credit_allocations c WHERE c.business_id = v_business AND c.id = p_allocation_id' IN v_src);
  IF v_replay = 0 OR v_replay > position('FROM purchases' IN v_src) OR v_replay > position('FROM supplier_credit_notes' IN v_src) THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: supplier_allocate_credit does not prove its replay before it reads the purchase and the note';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = c_entry[7];
  v_replay := position('FROM supplier_refunds f WHERE f.business_id = v_business AND f.id = p_refund_id' IN v_src);
  IF v_replay = 0 OR v_replay > position('FROM supplier_credit_notes' IN v_src) THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: supplier_receive_refund does not prove its replay before it reads the note';
  END IF;

  -- (7) A-12(4) with R-73: each consumer row is inserted before the note is
  --     decremented, and only the writer decrements it.
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = c_entry[6];
  IF position('INSERT INTO supplier_credit_allocations' IN v_src) = 0
     OR position('INSERT INTO supplier_credit_allocations' IN v_src) > position('PERFORM supplier_credit_note_consume(' IN v_src) THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: supplier_allocate_credit must insert its allocation before it decrements the note';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = c_entry[7];
  IF position('INSERT INTO supplier_refunds' IN v_src) = 0
     OR position('INSERT INTO supplier_refunds' IN v_src) > position('PERFORM supplier_credit_note_consume(' IN v_src) THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: supplier_receive_refund must insert its refund before it decrements the note';
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_detail
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.prosrc ~* 'UPDATE\s+supplier_credit_notes'
    AND p.oid <> c_writer;
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: only supplier_credit_note_consume updates supplier_credit_notes, found %', v_detail;
  END IF;

  -- (8) Both discoveries are empty.
  IF (SELECT count(*) FROM supplier_settlement_guard_gaps()) <> 0 THEN
    RAISE EXCEPTION 'supplier_payment.guard_missing: an S6 guard is missing, disabled or replaced';
  END IF;
  IF (SELECT count(*) FROM inventory_stock_source_guard_gaps()) <> 0 THEN
    RAISE EXCEPTION 'inventory.source_guard_missing: a registered stock source type lacks a guard';
  END IF;
  -- R-79: the re-created discovery keeps its 0067 shape, and it reports a
  -- neutered credit-note writer and a replaced extension point, each inside
  -- a rolled-back block (0063 R-40: CREATE is lent inside the block only).
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.oid = 'supplier_settlement_guard_gaps()'::regprocedure
                AND (p.prosecdef OR p.provolatile <> 's' OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
                     OR p.proowner::regrole::text <> current_user))
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
                 WHERE p.oid = 'supplier_settlement_guard_gaps()'::regprocedure AND x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner)
     OR pg_get_function_result('supplier_settlement_guard_gaps()'::regprocedure) <> 'TABLE(table_name text, trigger_name text, missing text)' THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: the re-created S6 discovery is not migrator-owned INVOKER STABLE pinned without a grantee';
  END IF;
  BEGIN
    GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;
    SET LOCAL ROLE daftar_inventory_internal;
    CREATE OR REPLACE FUNCTION supplier_credit_note_consume(p_credit_note_id UUID, p_remaining_before BIGINT, p_consumed BIGINT) RETURNS INTEGER
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $probe$
    BEGIN
      RETURN 1;
    END;
    $probe$;
    RESET ROLE;
    REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;
    SELECT string_agg(g.table_name || ':' || g.trigger_name || ':' || g.missing, ', ' ORDER BY g.table_name, g.trigger_name, g.missing)
      INTO v_detail FROM supplier_settlement_guard_gaps() g;
    RAISE EXCEPTION 'inventory.probe_rollback: %', coalesce(v_detail, '');
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_detail = MESSAGE_TEXT;
  END;
  IF v_detail IS DISTINCT FROM 'inventory.probe_rollback: -:supplier_credit_note_consume(uuid,bigint,bigint):function_body' THEN
    RAISE EXCEPTION 'inventory.source_guard_missing: the S6 discovery did not report a neutered credit-note writer (%)', v_detail;
  END IF;
  BEGIN
    CREATE OR REPLACE FUNCTION purchase_ap_outstanding(p_business_id UUID, p_purchase_id UUID) RETURNS BIGINT
    LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $probe$
    BEGIN
      RETURN 0;
    END;
    $probe$;
    SELECT string_agg(g.table_name || ':' || g.trigger_name || ':' || g.missing, ', ' ORDER BY g.table_name, g.trigger_name, g.missing)
      INTO v_detail FROM supplier_settlement_guard_gaps() g;
    RAISE EXCEPTION 'inventory.probe_rollback: %', coalesce(v_detail, '');
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_detail = MESSAGE_TEXT;
  END;
  IF v_detail IS DISTINCT FROM 'inventory.probe_rollback: -:purchase_ap_outstanding(uuid,uuid):function_body' THEN
    RAISE EXCEPTION 'inventory.source_guard_missing: the S6 discovery did not report a replaced purchase_ap_outstanding (%)', v_detail;
  END IF;
  IF (SELECT count(*) FROM supplier_settlement_guard_gaps()) <> 0 THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: a discovery probe did not roll back';
  END IF;

  -- (9) No CREATE left on public for either internal principal.
  IF has_schema_privilege('daftar_inventory_internal', 'public', 'CREATE')
     OR has_schema_privilege('daftar_accounting_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'supplier_payment.migration_end_state_invalid: an internal principal still holds CREATE on schema public';
  END IF;
END $$;
