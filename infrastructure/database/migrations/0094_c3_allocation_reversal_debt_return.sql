-- ─────────────────────────────────────────────────────────────────────────
-- 0094 — C3, THE DEBT RETURN HALF: reversing a payment allocation.
--
-- ITS BASE IS `mvp03/ar-source-document-guard` @ `9ea18edf`, NOT `main`.
-- §G below replaces a function that `0090` creates in that branch, and a
-- widening written against an absent allow-list is a list written from
-- memory. So this file is read as a branch stacked on PR #64 and its diff is
-- this file alone; whoever reviews it must not be shown #64's commits twice.
--
-- THE AUTHORITY THIS FILE RESTS ON. The owner's third option, relayed
-- 2026-11-16: `C3` is confined to the DEBT RETURNING, and RE-EXTINGUISHING an
-- invoice after a reversal is deferred by card, because it would need a branch
-- inside `invoice_settlement_verify` (`0081:755-765`), a sealed function, and
-- that is a stop condition. Nothing in this file touches it.
--
-- WHY A NEW RELATION AND NOT A COMPENSATING ROW. Measured on `0081`, and this
-- is the whole reason the slice costs a table at all:
--   * `payment_amount_minor` (`:309`), `payment_base_amount_minor` (`:312`)
--     and `invoice_amount_applied_minor` are `CHECK (… BETWEEN 1 AND 1e18)`
--     ⇒ there is no negative and no zero allocation row.
--   * `payment_allocation_guard` (`:982`) refuses anything but `INSERT` and
--     demands `payments.created_at = now()` with the same
--     `inventory_business_transaction_id()` ⇒ no allocation row can ever be
--     written in a later transaction.
--   * `payment_allocations_invoice_uq` (`:326`) is
--     `(business_id, payment_id, invoice_id)` ⇒ not even a second row for the
--     same pair.
--   * the other reducer, `customer_credit_applications`, needs a
--     `customer_credits` row (`:2321-2324`).
-- So the reversal is a NEW EVENT in a NEW RELATION. That is an effect of
-- existing constraints, not a design preference.
--
-- WHY THE READER MUST BE REPLACED, AND WHY THAT IS NOT A SEALED-BODY CHANGE.
-- `INVOICE_REDUCER_VOCABULARY` (`scripts/phase4-s1-gate.ts:1634`) names
-- `allocation_reversals` literally, and seam `S-P4-03` (`:1986`) requires the
-- reader of record to read every settling relation that exists. And
-- `invoice_outstanding`'s own comment says it in those words: "Replaced by the
-- slice that adds a reducer relation, which appends one UNION ALL branch."
-- The body carries no rounding: the branch is `sum` over two STORED columns,
-- so a reversal row carrying the allocation's own stored magnitudes returns
-- the sum exactly. The cumulative identity lives in the WRITER in `0081`, not
-- here. Measured: `0084:576-580` is prose about `ROW_COUNT`, above the
-- signature at `:593`, and not an identity in this body.
--
-- THE ONE LINE THIS FILE NOW CARRIES, after the owner signed it as `DR-168`
-- on 2026-11-16 with two blocking conditions (row security ENABLEd and FORCEd
-- with a business_id policy, and a red test that another merchant reads zero
-- rows through the reader). What follows was written while it was still
-- missing and is kept, corrected by addition and not deleted, because it is
-- the measurement that made the case for the line. `invoice_outstanding` is `STABLE` and SECURITY INVOKER — "daftar_app
-- holds SELECT on `invoices`, `sales` and both reducers" (`0084:588`) — so the
-- third branch needs `GRANT SELECT ON allocation_reversals TO daftar_app` and
-- a matching entry in `select.daftar_app.tables` of
-- `infrastructure/database/phase3-runtime-grant-model.json` (the precedent is
-- `purchase_reversals` at `:95` of that file; `:34` is a Phase-3 inventory and
-- not the law). That line is reserved to the owner, and the grant model's own
-- note says the two land together: "a migration that grants SELECT on a new
-- table is red until a reviewer records the grant here", and its `T-04`
-- compares both directions — an entry with no grant is a broken deployment, a
-- grant with no entry is an unreviewed privilege. So this file is COMPLETE
-- EXCEPT THAT LINE, is red by necessity if split, and MUST NOT be applied to
-- any environment or pushed until the owner rules. The card is
-- `.local-context/cards/L3_C3_GRANT_LINE_FOR_ALLOCATION_REVERSALS_AR.md`,
-- the queue line is `L3-ق-15`.
--
-- WHAT THIS FILE DOES NOT DO: it writes no journal entry. Posting is the
-- CALLER's, measured on `0081:1765` — "accounting_post_entry, one per
-- allocation or application, by the CALLER, after this routine returns" — so
-- the API half (`apps/api/src/modules/receivables`) posts the two lines this
-- file's validator demands, in the same transaction, and the deferred binding
-- FK and the deferred validator settle the order at COMMIT.
-- ─────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────
-- §A  PRECONDITIONS. Everything this file builds on, asserted rather than
--     assumed, so a wrong base fails here instead of halfway through.
-- ─────────────────────────────────────────────────────────────────────────
DO $pre$
DECLARE
  v_max_sort INTEGER;
BEGIN
  IF to_regclass('public.payment_allocations') IS NULL THEN
    RAISE EXCEPTION '0094 precondition: payment_allocations is missing (0081)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = 'invoice_outstanding'
                   AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'p_business_id uuid, p_invoice_ids uuid[]') THEN
    RAISE EXCEPTION '0094 precondition: invoice_outstanding(UUID, UUID[]) is missing (0084), and this file REPLACES it';
  END IF;
  -- The guard this file widens is `0090`'s, and it must already be here: a
  -- widening written against an absent list is a list invented from memory.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'accounting_ar_control_line_source_document') THEN
    RAISE EXCEPTION '0094 precondition: accounting_ar_control_line_source_document() is missing (0090, PR #64) — this file widens its two allow-lists and cannot be written against an absent one';
  END IF;
  SELECT max(sort_order) INTO v_max_sort FROM accounting_source_types;
  IF v_max_sort <> 17 THEN
    RAISE EXCEPTION '0094 precondition: accounting_source_types tops out at % and not 17, so the sort_order this file claims (18) is not the free one — remeasure', v_max_sort;
  END IF;
END;
$pre$;

-- ─────────────────────────────────────────────────────────────────────────
-- §B  THE RELATION. Shaped on `payment_allocations` (`0081:300`) down to the
--     generated source type and the `binding_source_id = id` identity, so a
--     reader of one reads the other without learning a second convention.
--
--     The magnitudes are COPIES of the allocation's own stored figures, and
--     §D asserts they are copies rather than numbers someone typed. They are
--     stored POSITIVE, exactly as the allocation stores them, and the reader
--     subtracts them; a negative column here would be a second representation
--     of the same fact and the `CHECK (… BETWEEN 1 AND …)` convention of this
--     estate forbids it anyway.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE allocation_reversals (
  tenant_id                            UUID NOT NULL,
  business_id                          UUID NOT NULL,
  id                                   UUID NOT NULL,
  -- The allocation being undone. One reversal per allocation, for ever.
  allocation_id                        UUID NOT NULL,
  -- Denormalised for the same reason `0081:306` denormalises `customer_id`:
  -- it is what lets a single row pin both ends of the fact to one customer.
  payment_id                           UUID NOT NULL,
  customer_id                          UUID NOT NULL,
  invoice_id                           UUID NOT NULL,
  reversal_date                        DATE NOT NULL,
  invoice_currency                     CHAR(3) NOT NULL,
  invoice_amount_applied_minor         BIGINT NOT NULL CHECK (invoice_amount_applied_minor BETWEEN 1 AND 1000000000000000000),
  invoice_historical_to_base_rate      NUMERIC(20,10) NOT NULL
    CHECK (invoice_historical_to_base_rate > 0 AND invoice_historical_to_base_rate = trunc(invoice_historical_to_base_rate, 10)),
  invoice_carrying_base_released_minor BIGINT NOT NULL CHECK (invoice_carrying_base_released_minor BETWEEN 0 AND 1000000000000000000),
  reason                               TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 200),
  business_transaction_id              UUID NOT NULL,
  created_by                           UUID NOT NULL REFERENCES users (id),
  created_at                           TIMESTAMPTZ NOT NULL DEFAULT now(),
  accounting_source_type               TEXT NOT NULL GENERATED ALWAYS AS ('allocation_reversal') STORED,
  binding_source_id                    UUID NOT NULL,
  PRIMARY KEY (business_id, id),
  -- AN ALLOCATION IS REVERSED AT MOST ONCE. Without this a second reversal
  -- would subtract the same magnitude twice and the invoice would report more
  -- owing than it ever did.
  CONSTRAINT allocation_reversals_allocation_uq UNIQUE (business_id, allocation_id),
  CONSTRAINT allocation_reversals_binding_identity_ck CHECK (binding_source_id = id),
  CONSTRAINT allocation_reversals_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT allocation_reversals_allocation_fk
    FOREIGN KEY (business_id, allocation_id) REFERENCES payment_allocations (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT allocation_reversals_invoice_fk
    FOREIGN KEY (business_id, invoice_id) REFERENCES invoices (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT allocation_reversals_binding_fk
    FOREIGN KEY (business_id, accounting_source_type, binding_source_id)
    REFERENCES accounting_source_bindings (business_id, source_type, source_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX allocation_reversals_invoice_idx ON allocation_reversals (business_id, invoice_id);

ALTER TABLE allocation_reversals ENABLE ROW LEVEL SECURITY;
ALTER TABLE allocation_reversals FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_membership ON allocation_reversals
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON allocation_reversals AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal')
              OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON allocation_reversals AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR current_user = 'daftar_inventory_internal'
              OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON allocation_reversals AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON allocation_reversals AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON allocation_reversals
  FOR SELECT USING (current_user = 'daftar_inventory_internal');
CREATE POLICY accounting_internal_read ON allocation_reversals
  FOR SELECT USING (current_user = 'daftar_accounting_internal');

-- THE GRANT, AND IT IS THE OWNER'S LINE, NOT MINE. Signed as `DR-168`:
-- "GRANT SELECT alone for daftar_app, and zero INSERT/UPDATE/DELETE/TRUNCATE/
-- REFERENCES/TRIGGER for any principal and PUBLIC, on the precedent of
-- purchase_reversals" -- with two blocking conditions, both proved on this
-- branch: row security ENABLEd AND FORCEd with a business_id policy (§B
-- above, and `tests/integration/l3-c3-allocation-reversals-rls.test.ts`
-- asserts it on a live cluster with a negative control), and a red test that
-- another merchant reads ZERO rows THROUGH THE READER.
--
-- The shape is the sibling's, measured and not invented: `0081:615-618`
-- grants `SELECT` to `daftar_app`, `SELECT, INSERT` to the inventory writer
-- and `SELECT` to the accounting principal on `payment_allocations` and its
-- siblings. Nothing else is granted here, to anybody: the grant model forbids
-- INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER to every runtime
-- principal and to PUBLIC, at table and at column level
-- (`phase3-runtime-grant-model.json:62-63`).
GRANT INSERT, SELECT ON allocation_reversals TO daftar_inventory_internal;
GRANT SELECT ON allocation_reversals TO daftar_accounting_internal;
GRANT SELECT ON allocation_reversals TO daftar_app;

-- ─────────────────────────────────────────────────────────────────────────
-- §C  APPEND ONLY. A reversal is a fact, not a field: it is never changed and
--     never deleted, which is the same rule `0081:939` states for a payment.
--     Unlike the allocation guard this does NOT demand that the payment be
--     created in this transaction — reversing a payment made last month is
--     the entire purpose.
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;

CREATE FUNCTION allocation_reversal_append_only() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'allocation_reversal.immutable: an allocation reversal is never changed or deleted' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.created_at IS DISTINCT FROM now()
     OR NEW.business_transaction_id IS DISTINCT FROM inventory_business_transaction_id() THEN
    RAISE EXCEPTION 'allocation_reversal.immutable: a reversal is written by the command of its own transaction' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER allocation_reversals_append_only
  BEFORE INSERT OR UPDATE OR DELETE ON allocation_reversals
  FOR EACH ROW EXECUTE FUNCTION allocation_reversal_append_only();

-- ─────────────────────────────────────────────────────────────────────────
-- §D  THE MONEY LAW: the stored magnitudes ARE the allocation's own.
--
--     This is the one that matters. If a reversal could carry any figure, the
--     reader would subtract a number nobody checked and an invoice would
--     report an outstanding of its author's choosing. Deferred, because the
--     row and its allocation are written in one transaction and the lock order
--     puts the invoice first.
-- ─────────────────────────────────────────────────────────────────────────
CREATE FUNCTION allocation_reversal_value_conserved() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_a RECORD;
BEGIN
  SELECT a.payment_id, a.customer_id, a.invoice_id, a.invoice_currency,
         a.invoice_amount_applied_minor, a.invoice_historical_to_base_rate,
         a.invoice_carrying_base_released_minor
    INTO v_a
  FROM payment_allocations a
  WHERE a.business_id = NEW.business_id AND a.id = NEW.allocation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'allocation_reversal.allocation_not_found: a reversal names an allocation that does not exist in this business'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.payment_id IS DISTINCT FROM v_a.payment_id
     OR NEW.customer_id IS DISTINCT FROM v_a.customer_id
     OR NEW.invoice_id IS DISTINCT FROM v_a.invoice_id
     OR NEW.invoice_currency IS DISTINCT FROM v_a.invoice_currency
     OR NEW.invoice_amount_applied_minor IS DISTINCT FROM v_a.invoice_amount_applied_minor
     OR NEW.invoice_historical_to_base_rate IS DISTINCT FROM v_a.invoice_historical_to_base_rate
     OR NEW.invoice_carrying_base_released_minor IS DISTINCT FROM v_a.invoice_carrying_base_released_minor THEN
    RAISE EXCEPTION 'allocation_reversal.value_not_conserved: a reversal carries figures that are not its allocation''s (allocation %, invoice %)',
      NEW.allocation_id, NEW.invoice_id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER allocation_reversals_value_conserved
  AFTER INSERT ON allocation_reversals DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION allocation_reversal_value_conserved();

-- ─────────────────────────────────────────────────────────────────────────
-- §E  THE COMMAND. It writes the fact and returns what the caller needs to
--     post. It does not post: `0081:1765` keeps posting with the caller.
--
--     THE LOCK ORDER is `0081`'s, unchanged and in the same places: the
--     per-document advisory key, then the invoice FOR UPDATE (the cap lock),
--     then the customer FOR SHARE. Nothing new is locked, so no cycle is
--     added.
-- ─────────────────────────────────────────────────────────────────────────
CREATE FUNCTION customer_reverse_allocation(
  p_reversal_id   UUID,
  p_allocation_id UUID,
  p_reversal_date DATE,
  p_reason        TEXT
) RETURNS TABLE (reversal_id UUID, invoice_id UUID, customer_id UUID,
                 invoice_currency CHAR(3), invoice_amount_applied_minor BIGINT,
                 invoice_carrying_base_released_minor BIGINT,
                 invoice_historical_to_base_rate NUMERIC(20,10))
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor    inventory_verified_actor;
  v_business UUID;
  v_tenant   UUID;
  v_a        RECORD;
BEGIN
  -- 1. THE CONSUME, over this routine's OWN ARGUMENTS in declaration order,
  --    exactly as `0081:1847` does it. There is no `app_user()` helper in this
  --    estate — `0079:78` says so in those words, and I had written one before
  --    measuring — so the actor, the business and the tenant all come from the
  --    verified assertion and from nowhere else.
  --
  --    AND THE GRAMMAR IS CLOSED, which is what shapes this argument list:
  --    `inventory_payload_field_is_canonical` accepts `uuid`, `boolean`,
  --    `integer` and `code` and NOTHING else (`0054:200-207`). So the DATE is
  --    digested as an integer in `YYYYMMDD`, which is what `0081` does with
  --    the payment date, and the free-text reason goes through
  --    `inventory_reason_words` — the SHA-256 of its exact bytes as eight
  --    32-bit words (`0062:96`) — which is how a reason is bound under a
  --    grammar with no text field.
  v_actor := inventory_assertion_consume('customer.reverse_allocation', inventory_claimed_payload_digest('customer.reverse_allocation',
    ARRAY['uuid', 'uuid', 'integer'] || array_fill('integer'::text, ARRAY[8]),
    ARRAY[p_reversal_id::text, p_allocation_id::text, to_char(p_reversal_date, 'YYYYMMDD')] || inventory_reason_words(p_reason)));

  -- 2. Isolation and trace, as every command in this estate asserts them.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: inventory commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_business := v_actor.business_id;
  v_tenant   := v_actor.tenant_id;

  PERFORM pg_advisory_xact_lock(hashtext('daftar.allocation_reversal_id'), hashtext(p_reversal_id::text));

  SELECT a.payment_id, a.customer_id, a.invoice_id, a.invoice_currency,
         a.invoice_amount_applied_minor, a.invoice_historical_to_base_rate,
         a.invoice_carrying_base_released_minor
    INTO v_a
  FROM payment_allocations a
  WHERE a.business_id = v_business AND a.id = p_allocation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'allocation_reversal.allocation_not_found: no such allocation in this business' USING ERRCODE = 'P0001';
  END IF;

  -- THE CAP LOCK, in `0081`'s order: the invoice first.
  PERFORM 1 FROM invoices i WHERE i.business_id = v_business AND i.id = v_a.invoice_id FOR UPDATE;
  PERFORM 1 FROM customers c WHERE c.business_id = v_business AND c.id = v_a.customer_id FOR SHARE;

  INSERT INTO allocation_reversals (
    tenant_id, business_id, id, allocation_id, payment_id, customer_id, invoice_id,
    reversal_date, invoice_currency, invoice_amount_applied_minor,
    invoice_historical_to_base_rate, invoice_carrying_base_released_minor,
    reason, business_transaction_id, created_by, binding_source_id
  ) VALUES (
    v_tenant, v_business, p_reversal_id, p_allocation_id, v_a.payment_id, v_a.customer_id, v_a.invoice_id,
    p_reversal_date, v_a.invoice_currency, v_a.invoice_amount_applied_minor,
    v_a.invoice_historical_to_base_rate, v_a.invoice_carrying_base_released_minor,
    p_reason, inventory_business_transaction_id(), v_actor.actor_user_id, p_reversal_id
  );

  RETURN QUERY SELECT p_reversal_id, v_a.invoice_id, v_a.customer_id, v_a.invoice_currency,
                      v_a.invoice_amount_applied_minor, v_a.invoice_carrying_base_released_minor,
                      v_a.invoice_historical_to_base_rate;
END;
$$;

-- The op code belongs to the CLOSED operation registry (`0054:52`), and a
-- command whose code is not registered is refused by the consume itself
-- (`0054:407`). `registered_by` is `'P4-S4'`: the `^P3-S[0-9]+$` check was
-- widened in `0072:812` and `0074:129`, and `0081:2480` registers its two
-- customer codes with exactly that tag.
INSERT INTO inventory_operation_kinds (op_code, registered_by) VALUES
  ('customer.reverse_allocation', 'P4-S4');

REVOKE ALL ON FUNCTION allocation_reversal_append_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION allocation_reversal_value_conserved() FROM PUBLIC;
REVOKE ALL ON FUNCTION customer_reverse_allocation(UUID, UUID, DATE, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION customer_reverse_allocation(UUID, UUID, DATE, TEXT) TO daftar_app;
ALTER FUNCTION allocation_reversal_append_only() OWNER TO daftar_inventory_internal;
ALTER FUNCTION allocation_reversal_value_conserved() OWNER TO daftar_inventory_internal;
ALTER FUNCTION customer_reverse_allocation(UUID, UUID, DATE, TEXT) OWNER TO daftar_inventory_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- §F  THE ACCOUNTING IDENTITY. A registered source type, and the completeness
--     validator every registered type in this estate has.
--
--     MEASURED, and it is why the validator is written rather than assumed to
--     be optional: all SEVENTEEN registered source types have an
--     `accounting_<type>_entry_complete()`, with zero exception — and NO law
--     enumerates the registry to demand one. The per-phase gates carry
--     hardcoded (source, fn, trigger) triples instead
--     (`scripts/phase2-s4-gate.ts:717-719`). So a new type without a
--     validator would be caught by nothing at all, and a validator with no
--     triple in the gate would have nothing watching for its disappearance.
--     The three land together: the row, the validator with its trigger, and
--     the triple in `scripts/phase4-s1-gate.ts`.
--
--     `lower_bound_policy` is `'none'` and NOT `'not_before_origin'`, and the
--     reason is measured rather than preferred: the engine resolves an origin
--     date only for `'reversal'` (`0046:638` reads the policy for that type by
--     name), so claiming `'not_before_origin'` here would state a bound
--     nothing enforces — a law with no enforcement is worse than no law. That
--     a reversal may not predate its allocation is left to the API half and
--     named here as owed.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO accounting_source_types (source_type, lower_bound_policy, upper_bound_policy, description, sort_order) VALUES
  ('allocation_reversal', 'none', 'not_after_today', 'Undoes one payment allocation; the debt returns and the cash becomes a customer obligation.', 18);

GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;

CREATE FUNCTION accounting_allocation_reversal_entry_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_r        RECORD;
  v_nlines   BIGINT;
  v_expected TEXT[];
  v_actual   TEXT[];
BEGIN
  SELECT r.invoice_currency, r.invoice_amount_applied_minor,
         r.invoice_carrying_base_released_minor, r.invoice_historical_to_base_rate
    INTO v_r
  FROM allocation_reversals r
  WHERE r.business_id = NEW.business_id AND r.binding_source_id = NEW.source_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accounting.selling_detail_missing: an allocation reversal entry must be registered by its reversal in the same transaction'
      USING ERRCODE = 'P0001';
  END IF;

  -- The two lines, and exactly two: the debt returns to the receivable, and
  -- the cash the merchant still holds becomes a customer obligation.
  v_expected := ARRAY[]::text[];
  v_expected := v_expected || concat_ws('|', 'accounts_receivable', 'D', v_r.invoice_carrying_base_released_minor::text,
    v_r.invoice_currency::text, v_r.invoice_amount_applied_minor::text, v_r.invoice_historical_to_base_rate::text);
  v_expected := v_expected || concat_ws('|', 'customer_credit_liability', 'C', v_r.invoice_carrying_base_released_minor::text,
    v_r.invoice_currency::text, v_r.invoice_amount_applied_minor::text, v_r.invoice_historical_to_base_rate::text);
  SELECT array_agg(x ORDER BY x) INTO v_expected FROM unnest(v_expected) AS x;

  -- The non-vacuity canary (`0077:1461-1474`, and `0081:1686` for the exact
  -- form): the shape is unconditional, so the count is not merely non-zero
  -- but TWO. Without this a validator that read no lines would pass.
  SELECT count(*) INTO v_nlines FROM journal_lines l
   WHERE l.business_id = NEW.business_id AND l.journal_entry_id = NEW.id;
  IF v_nlines <> 2 THEN
    RAISE EXCEPTION 'accounting.selling_detail_missing: an allocation reversal entry must be posted with the two lines this validator can read'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT array_agg(s ORDER BY s) INTO v_actual
  FROM (
    SELECT concat_ws('|', coalesce(a.system_key, '-'),
             CASE WHEN l.debit_minor > 0 AND l.credit_minor = 0 THEN 'D'
                  WHEN l.credit_minor > 0 AND l.debit_minor = 0 THEN 'C' ELSE '?' END,
             greatest(l.debit_minor, l.credit_minor)::text,
             l.txn_currency, l.txn_amount_minor::text, l.fx_rate::text) AS s
      FROM journal_lines l
      JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
     WHERE l.business_id = NEW.business_id AND l.journal_entry_id = NEW.id
  ) z;

  IF v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'accounting.selling_detail_mismatch: an allocation reversal entry must post exactly the two lines its reversal states (expected %, posted %)',
      v_expected, v_actual
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- WHAT THIS VALIDATOR DOES NOT COMPARE, said out loud rather than left to a
-- reader: `fx_rate_source` and `fx_rate_at`. `0081:1654`'s credit validator
-- compares them because `customer_credits` STORES that snapshot; a
-- `payment_allocations` row does not, so a reversal copied from it has no such
-- figure to compare against, and a validator that invented one would be
-- asserting the poster against itself. The rate VALUE is compared, which is
-- the figure the money depends on.

REVOKE ALL ON FUNCTION accounting_allocation_reversal_entry_complete() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER journal_entries_allocation_reversal_complete
  AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source_type = 'allocation_reversal')
  EXECUTE FUNCTION accounting_allocation_reversal_entry_complete();

ALTER FUNCTION accounting_allocation_reversal_entry_complete() OWNER TO daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- §G  `0090`'s TWO ALLOW-LISTS, WIDENED BY ONE NAME EACH.
--
--     `0090` refuses any `journal_lines` row on `accounts_receivable` or
--     `customer_credit_liability` whose entry is not one of that account's
--     sales documents. An allocation reversal posts on BOTH accounts, so
--     without this it would be refused by name — and that refusal is correct
--     until the type exists, which is why this widening belongs here and not
--     in `0090`.
--
--     The body below is `0090`'s, with `allocation_reversal` added to the
--     receivable list and to the credit-liability list and NOTHING else
--     changed. It is a REPLACE of this lane's own function and touches no
--     sealed one; the two fingerprints are in this commit's message
--     (`DR-103`/7).
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;

CREATE OR REPLACE FUNCTION accounting_ar_control_line_source_document()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_system_key  TEXT;
  v_source_type TEXT;
  v_source_id   UUID;
  v_origin_type TEXT;
  v_judged      TEXT;
BEGIN
  SELECT a.system_key, e.source_type, e.source_id
    INTO v_system_key, v_source_type, v_source_id
    FROM accounts a
    JOIN journal_entries e
      ON e.business_id = NEW.business_id AND e.id = NEW.journal_entry_id
   WHERE a.business_id = NEW.business_id
     AND a.id = NEW.account_id
     AND a.system_key IN ('accounts_receivable', 'customer_credit_liability');
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_judged := v_source_type;
  IF v_source_type = 'reversal' THEN
    SELECT o.source_type INTO v_origin_type
      FROM journal_entries o
     WHERE o.business_id = NEW.business_id AND o.id = v_source_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'accounting.ar_source_document_required: MVP03_AR_SOURCE_DOCUMENT_GUARD — a reversal on % must name the entry it reverses, and entry % was not found in this business',
        v_system_key, v_source_id
        USING ERRCODE = 'P0001';
    END IF;
    v_judged := v_origin_type;
  END IF;

  IF (v_system_key = 'accounts_receivable'
        AND v_judged IN ('invoice', 'customer_payment_allocation', 'customer_credit_application', 'allocation_reversal'))
     OR (v_system_key = 'customer_credit_liability'
        AND v_judged IN ('customer_credit', 'customer_credit_application', 'allocation_reversal'))
  THEN
    RETURN NULL;
  END IF;

  RAISE EXCEPTION
    'accounting.ar_source_document_required: MVP03_AR_SOURCE_DOCUMENT_GUARD — a journal line on % must belong to a sales document; source_type % (judged as %) is not one, so this money would belong to no customer. Correct the customer through a sales document.',
    v_system_key, v_source_type, v_judged
    USING ERRCODE = 'P0001';
END;
$$;

ALTER FUNCTION accounting_ar_control_line_source_document() OWNER TO daftar_accounting_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- §H  THE READER OF RECORD, REPLACED: one UNION ALL branch appended.
--
--     The signature and the `RETURNS TABLE` are `0084:593-596` to the
--     character, because `CREATE OR REPLACE` refuses anything else and a
--     `DROP` here would be a stop condition. `STABLE` is kept and SECURITY
--     INVOKER is kept — this is a reader of record (R-P4-07), and a definer
--     read would bypass the row security of the relations it reads.
--
--     The new branch SUBTRACTS: it selects the reversal's stored magnitudes
--     negated, so the existing `sum` needs no arithmetic of its own and the
--     delegator at `0084:526` stays a pure delegator (TL-P4-S4-SEAM-01).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION invoice_outstanding(p_business_id UUID, p_invoice_ids UUID[])
RETURNS TABLE (invoice_id UUID, paid_txn_minor BIGINT, paid_base_minor BIGINT,
               outstanding_txn_minor BIGINT, outstanding_base_minor BIGINT,
               currency_code TEXT, due_date DATE, issue_date DATE)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_found BIGINT;
  v_asked BIGINT;
BEGIN
  RETURN QUERY
    SELECT i.id,
           CASE WHEN i.status <> 'open' THEN 0::BIGINT
                WHEN s.settlement_mode = 'cash' THEN i.total_txn_minor
                ELSE coalesce(r.paid_txn, 0)::BIGINT END,
           CASE WHEN i.status <> 'open' THEN 0::BIGINT
                WHEN s.settlement_mode = 'cash' THEN i.total_base_minor
                ELSE coalesce(r.paid_base, 0)::BIGINT END,
           CASE WHEN i.status <> 'open' OR s.settlement_mode = 'cash' THEN 0::BIGINT
                ELSE (i.total_txn_minor - coalesce(r.paid_txn, 0))::BIGINT END,
           CASE WHEN i.status <> 'open' OR s.settlement_mode = 'cash' THEN 0::BIGINT
                ELSE (i.total_base_minor - coalesce(r.paid_base, 0))::BIGINT END,
           i.currency_code::TEXT,
           i.due_date,
           i.issue_date
      FROM public.invoices i
      JOIN public.sales s ON s.business_id = i.business_id AND s.id = i.sale_id
      LEFT JOIN (
        SELECT d.invoice_id AS invoice_id,
               pg_catalog.sum(d.amount) AS paid_txn,
               pg_catalog.sum(d.rel) AS paid_base
          FROM (
            SELECT a.invoice_id AS invoice_id,
                   a.invoice_amount_applied_minor AS amount,
                   a.invoice_carrying_base_released_minor AS rel
              FROM public.payment_allocations a
             WHERE a.business_id = p_business_id AND a.invoice_id = ANY(p_invoice_ids)
            UNION ALL
            SELECT c.invoice_id AS invoice_id,
                   c.invoice_amount_applied_minor AS amount,
                   c.invoice_carrying_base_released_minor AS rel
              FROM public.customer_credit_applications c
             WHERE c.business_id = p_business_id AND c.invoice_id = ANY(p_invoice_ids)
            UNION ALL
            SELECT v.invoice_id AS invoice_id,
                   -v.invoice_amount_applied_minor AS amount,
                   -v.invoice_carrying_base_released_minor AS rel
              FROM public.allocation_reversals v
             WHERE v.business_id = p_business_id AND v.invoice_id = ANY(p_invoice_ids)
          ) d
         GROUP BY d.invoice_id
      ) r ON r.invoice_id = i.id
     WHERE i.business_id = p_business_id AND i.id = ANY(p_invoice_ids);
  GET DIAGNOSTICS v_found = ROW_COUNT;
  IF v_found <> coalesce(pg_catalog.cardinality(p_invoice_ids), 0) THEN
    SELECT pg_catalog.count(*) INTO v_asked FROM (SELECT DISTINCT x.id FROM pg_catalog.unnest(p_invoice_ids) AS x(id)) k;
    IF v_found <> v_asked THEN
      RAISE EXCEPTION 'invoice.not_found: the invoice does not exist in this business' USING ERRCODE = 'P0001';
    END IF;
  END IF;
END;
$fn$;

COMMENT ON FUNCTION invoice_outstanding(UUID, UUID[]) IS
  'P4-S4 (0083, replaced by 0084, replaced by 0094; P4-AL-05, P4-AL-07, seam S-P4-03): THE ONE DEFINITION of the settlement sum, set-based, now over THREE reducer relations. 0094 appends one UNION ALL branch for allocation_reversals, selected NEGATED, exactly as 0084''s own comment said the slice that adds a reducer relation would do. Everything else is 0084''s body unchanged: a cash-settled invoice reports paid = total and outstanding = 0, a draft or void document reports zeros, an unknown id raises invoice.not_found behind the free ROW_COUNT check, and currency_code, due_date and issue_date are passthrough off the invoices row. The reversal carries its allocation''s own stored magnitudes, proved by allocation_reversal_value_conserved, so subtracting them restores the invoice to the minor unit and no rounding is performed here. STABLE and SECURITY INVOKER, so daftar_app needs SELECT on all three reducers; the grant for the third is the owner''s line and is not in this file. invoice_outstanding(business, invoice) stays a pure delegator and holds no arithmetic.';

-- ─────────────────────────────────────────────────────────────────────────
-- §I  END STATE, asserted. A migration that only writes is silent on success
--     (RULE-29), so what it was for is read back here.
-- ─────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_src TEXT;
BEGIN
  IF to_regclass('public.allocation_reversals') IS NULL THEN
    RAISE EXCEPTION '0094 end state: allocation_reversals was not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM accounting_source_types WHERE source_type = 'allocation_reversal' AND sort_order = 18) THEN
    RAISE EXCEPTION '0094 end state: the allocation_reversal source type is not registered at 18';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM inventory_operation_kinds WHERE op_code = 'customer.reverse_allocation') THEN
    RAISE EXCEPTION '0094 end state: the op code is not in the closed operation registry, so the command could never be consumed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'journal_entries_allocation_reversal_complete' AND NOT tgisinternal) THEN
    RAISE EXCEPTION '0094 end state: the completeness trigger is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'allocation_reversals_value_conserved' AND NOT tgisinternal) THEN
    RAISE EXCEPTION '0094 end state: the value-conservation trigger is missing';
  END IF;
  -- The reader really reads the third relation, and it is THIS definition that
  -- is live — read out of the catalogue and not off the file.
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.proname = 'invoice_outstanding'
     AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'p_business_id uuid, p_invoice_ids uuid[]';
  IF v_src IS NULL OR position('allocation_reversals' IN v_src) = 0 THEN
    RAISE EXCEPTION '0094 end state: the live invoice_outstanding(UUID, UUID[]) does not read allocation_reversals';
  END IF;
  IF (SELECT p.provolatile FROM pg_proc p
       WHERE p.proname = 'invoice_outstanding'
         AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'p_business_id uuid, p_invoice_ids uuid[]') <> 's' THEN
    RAISE EXCEPTION '0094 end state: invoice_outstanding is no longer STABLE';
  END IF;
  IF (SELECT p.prosecdef FROM pg_proc p
       WHERE p.proname = 'invoice_outstanding'
         AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'p_business_id uuid, p_invoice_ids uuid[]') THEN
    RAISE EXCEPTION '0094 end state: invoice_outstanding became SECURITY DEFINER, which R-P4-07 forbids for a reader of record';
  END IF;
  -- And `0090`'s guard now names the new type on both accounts.
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.proname = 'accounting_ar_control_line_source_document';
  IF v_src IS NULL OR position('allocation_reversal''' IN v_src) = 0 THEN
    RAISE EXCEPTION '0094 end state: the AR control guard does not name allocation_reversal';
  END IF;
END;
$post$;
