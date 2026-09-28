-- 0072_purchase_sub_unit_residue.sql
-- Phase 3 corrective hardening — TD-16 (the Tech Lead's corrective directive
-- §3, BLOCKER A). Not a Phase 4 migration.
--
-- ── The defect ──────────────────────────────────────────────────────────
--
-- A frozen P3-S5 partial return releases ap = least(C, O) of the purchase's
-- outstanding AP and leaves O − ap under no residue rule (0066; S5 review L2,
-- S6 review M1, 0067 R-69(b)). With a pilot currency the remainder can be
-- a positive transaction amount whose conversion at the purchase's snapshot
-- is 0 base minor units: TRY at 0.11 in an ILS business, lines 49.99 + 0.01,
-- the 49.99 returned → O = 1 kurus, conv_R(1) = HALF_EVEN(0.11) = 0. Every
-- merchant path then refuses — pay or allocate 0 < a ≤ O converts to 0
-- (`…amount_below_base_unit`), a > O is over-allocation, a return of the
-- remaining goods releases ap > 0 converting to 0
-- (`supplier_return.amount_below_base_unit`), and the reversal is
-- `purchase_reversal.returned` — so the purchase stays open for ever.
--
-- ── The design ──────────────────────────────────────────────────────────
--
-- Two halves, both required by §3.
--
-- (1) PREVENTION (R-95). A return may not CREATE such a residue: the new
--     deferred constraint trigger `supplier_returns_residue_bound` (AFTER
--     INSERT ON supplier_returns, DEFERRABLE INITIALLY DEFERRED) refuses at
--     COMMIT a return with ap > 0 whose stored chain leaves
--     0 < O' = T − X − ap and conv_R(O') = 0, with
--     `supplier_return.residue_below_base_unit` — the purchase-side twin of
--     the S6 rule R-77, judged on the stored row exactly as R-77's COMMIT
--     guards are, so a forged row cannot create one either. The API refuses
--     the same case before minting (the package's
--     `supplierReturnLeavesSubUnitResidue`), so the merchant sees a 422 and
--     nothing is written. The frozen `purchase_return` body (0066) is not
--     replaced: every S5 value it stores is unchanged, only the one state it
--     could leave is refused. The lawful paths stay open: return the rest of
--     the goods with it (O' = 0), pay first (the return then issues a
--     credit), or return a quantity that leaves O' = 0 or conv_R(O') ≥ 1.
--
--     S6 already never creates one (R-77, R-78); a purchase is born with
--     conv_R(T) = B ≥ 1; a reversal leaves 0. After this trigger no Phase 3
--     writer can leave 0 < O with conv_R(O) = 0.
--
-- (2) CLOSURE of the states the frozen S5 behaviour already left (R-96): the
--     signed, permissioned, idempotent command `purchase.write_off_residue`
--     (routine `purchase_write_off_residue`, API
--     `POST /v1/purchases/:purchaseId/residue-write-off`, `suppliers.pay`,
--     business-wide). It is lawful ONLY when, under the purchase row lock:
--       · the purchase is received and not reversed, and a supplier return
--         released part of its AP (the one origin);
--       · 0 < O = purchase_ap_outstanding and conv_R(O) = 0 — an O converting
--         to one base minor unit or more is 422
--         `purchase_residue.not_below_base_unit` (pay or allocate it);
--       · the stated amount is exactly O (409 `purchase_residue.amount_mismatch`
--         otherwise, the optimistic S6 form).
--     It stores one immutable `purchase_residue_write_offs` row (the purchase
--     is its identity: at most one per purchase), which the replaced
--     `purchase_ap_outstanding` subtracts, so O becomes exactly 0 and every
--     outstanding read, payable read and later command sees a closed
--     purchase. The row carries the exact txn residue O, the chain point
--     X = T − O it closes, and the base the ledger still carries for it,
--     rb = HALF_EVEN(B·T, T) − HALF_EVEN(B·X, T) = B − HALF_EVEN(B·X, T),
--     the same release law as every other AP reducer (0065 R-35).
--
--     THE BASE. With conv_R(O) = 0 the ledger's remaining AP base rb is 0 or
--     1 (B·O/T < O·R + O/(2T) ≤ 1, so rb ≤ HALF_EVEN(B·O/T + ½) ≤ 1):
--       · rb = 0 (the 0.11 reproduction): nothing is posted. No journal line
--         may carry base 0 (0042 journal_lines_money_cap_ck, the 0043
--         per-line law), and none is needed: the base ledger already owes
--         nothing. The txn memo O on the AP lines stays as posted —
--         immutable history — and the payable reads subtract the write-off's
--         txn exactly as they subtract any other reducer's.
--       · rb = 1 (reachable: e.g. T = 14 kurus, B = 2, a return of 10 leaves
--         O = 4, conv 0, rb = 1): the release is posted as one
--         `purchase_residue_write_off` entry, base lines only — Dr Accounts
--         Payable rb / Cr FX gain rb (4900), on the purchase warehouse's
--         branch at the write-off date — exactly the S6 "the final
--         consumption releases the entire residue" dust rule (DM §7ج, 0067
--         R-69(a)). The deferred completeness trigger
--         `journal_entries_purchase_residue_write_off_complete` proves the
--         entry equals its row; the row's deferred binding FK proves the
--         entry exists; the generic reversal guard refuses to undo it.
--     So base AP ends exactly 0, txn AP ends exactly 0, and no base-0 line
--     is ever written.
--
--     CONCURRENCY. The routine takes the S4 purchase key
--     (`daftar.purchase_id`, the receipt's and the reversal's) and then the
--     purchase FOR UPDATE — advisory key before row lock, the order every
--     purchase command follows — so two write-offs, or a write-off and a
--     payment, return or reversal of the same purchase, serialize; the
--     loser re-reads O under the lock (0 → `nothing_outstanding`, moved →
--     `amount_mismatch`). The identity is the purchase: a replay of the same
--     intent answers the stored row, another intent is
--     `purchase_residue.already_written_off`.
--
--     AT COMMIT (`purchase_residue_write_offs_value_complete`): the purchase
--     is received, not reversed, of the row's supplier, currency and rate; a
--     return released AP; X equals the sum of every other reducer (returns,
--     payment and credit allocations) and X + O = T (the write-off is the
--     terminal reducer); conv_R(O) = 0; rb is the release law's value.
--     Otherwise `purchase_residue.settlement_inconsistent`.
--
-- Mechanisms compared (the report states the choice; §3 "not the easiest"):
--   A (this) a bounded write-off row + the replaced outstanding function,
--     with a base entry only when the ledger still carries one base unit;
--   B a journal write-off of the txn residue — needs a line of base 0,
--     which the ledger forbids, or a fabricated rate: refused;
--   C redefining "outstanding" as 0 whenever conv_R(O) = 0 — unaudited,
--     undoes no ledger base (rb = 1 would stay owed) and silently changes
--     every accepted S5/S6 read: refused;
--   D letting a later return absorb the residue (ap > C) — breaks the
--     supplier_returns C = ap + credit invariant and needs goods to return:
--     refused;
--   E having pay/allocate absorb it — the AP txn line would carry base 0:
--     refused.
--
-- The operation kind is registered with `registered_by = 'P3-C'`. 0054's
-- registry CHECK admits only '^P3-S[0-9]+$' (a slice label); a corrective
-- pass is not a slice, so the CHECK is replaced here — explicitly, by the
-- migrator, asserted by 0072-E — with the same pattern OR the one literal
-- 'P3-C'. No other registry is widened.
--
-- Replaced by their owners, bodies otherwise verbatim: purchase_ap_outstanding
-- (the migrator's INVOKER extension point, 0067; + the write-offs),
-- supplier_settlement_guard_gaps (the migrator's discovery, 0068; the new
-- outstanding digest and the three new guards), and
-- accounting_reversals_20_domain_source_guard (the accounting principal's,
-- 0067; + the new source type in the always-refused list).
--
-- Migrations 0000-0071 are FROZEN or accepted and untouched.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Preconditions: the S5/S6 objects are here, the TD-16 objects are not.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regprocedure('public.purchase_return(uuid,uuid,uuid,date,text,uuid,bigint,bigint,bigint,bigint,bigint,bigint,bigint,uuid[],uuid[],uuid[],numeric[],bigint[],bigint[])') IS NULL
     OR to_regprocedure('public.purchase_ap_outstanding(uuid,uuid)') IS NULL
     OR to_regprocedure('public.supplier_settlement_guard_gaps()') IS NULL
     OR to_regprocedure('public.supplier_convert_base(bigint,numeric,integer,integer)') IS NULL
     OR to_regprocedure('public.supplier_ap_release(bigint,bigint,bigint,bigint)') IS NULL
     OR to_regprocedure('public.accounting_inventory_reversal_domain_guard()') IS NULL THEN
    RAISE EXCEPTION 'purchase_residue.migration_precondition: 0072 needs the S5/S6 objects and 0071';
  END IF;
  IF to_regclass('public.purchase_residue_write_offs') IS NOT NULL
     OR to_regprocedure('public.supplier_return_residue_bound()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM inventory_operation_kinds k WHERE k.op_code = 'purchase.write_off_residue')
     OR EXISTS (SELECT 1 FROM accounting_source_types s WHERE s.source_type = 'purchase_residue_write_off') THEN
    RAISE EXCEPTION 'purchase_residue.migration_precondition: a TD-16 object already exists before 0072';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The accounting registry first (the table's binding FK and the entry's
--    source FK need it): the source type and its one owning kind (0046).
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO accounting_source_types (source_type, lower_bound_policy, upper_bound_policy, description, sort_order) VALUES
  ('purchase_residue_write_off', 'none', 'not_after_today',
   'A purchase''s sub-unit AP residue written off: Dr Accounts Payable / Cr FX gain, base only, when the ledger still carries one base unit (TD-16).', 12);
INSERT INTO accounting_operation_kinds (operation_kind, source_type, description) VALUES
  ('post', 'purchase_residue_write_off', 'Purchase residue write-off; derived by the write-off command.');

-- ─────────────────────────────────────────────────────────────────────────
-- 3. The table: one immutable row per written-off purchase.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE purchase_residue_write_offs (
  tenant_id                 UUID NOT NULL,
  business_id               UUID NOT NULL,
  id                        UUID NOT NULL,
  purchase_id               UUID NOT NULL,
  supplier_id               UUID NOT NULL,
  currency_code             CHAR(3) NOT NULL,
  source_to_base_rate       NUMERIC(20,10) NOT NULL CHECK (source_to_base_rate > 0 AND source_to_base_rate = trunc(source_to_base_rate, 10)),
  write_off_date            DATE NOT NULL,
  reason                    TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500 AND reason = btrim(reason)),
  residue_txn_minor         BIGINT NOT NULL CHECK (residue_txn_minor BETWEEN 1 AND 1000000000000000000),
  released_before_txn_minor BIGINT NOT NULL CHECK (released_before_txn_minor BETWEEN 1 AND 1000000000000000000),
  residue_base_minor        BIGINT NOT NULL CHECK (residue_base_minor BETWEEN 0 AND 1000000000000000000),
  intent_sha256             TEXT NOT NULL CHECK (intent_sha256 ~ '^[0-9a-f]{64}$'),
  business_transaction_id   UUID NOT NULL,
  created_by                UUID NOT NULL REFERENCES users (id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  accounting_source_type    TEXT NOT NULL GENERATED ALWAYS AS ('purchase_residue_write_off') STORED,
  binding_source_id         UUID,
  PRIMARY KEY (business_id, id),
  CONSTRAINT purchase_residue_write_offs_identity_ck CHECK (id = purchase_id),
  CONSTRAINT purchase_residue_write_offs_purchase_uq UNIQUE (business_id, purchase_id),
  -- An entry exists exactly when the ledger still carries base for the residue.
  CONSTRAINT purchase_residue_write_offs_binding_ck
    CHECK ((residue_base_minor = 0 AND binding_source_id IS NULL) OR (residue_base_minor > 0 AND binding_source_id = id)),
  CONSTRAINT purchase_residue_write_offs_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT purchase_residue_write_offs_purchase_fk
    FOREIGN KEY (business_id, purchase_id, supplier_id) REFERENCES purchases (business_id, id, supplier_id) ON DELETE RESTRICT,
  CONSTRAINT purchase_residue_write_offs_currency_fk FOREIGN KEY (currency_code) REFERENCES currencies (code),
  CONSTRAINT purchase_residue_write_offs_binding_fk
    FOREIGN KEY (business_id, accounting_source_type, binding_source_id)
    REFERENCES accounting_source_bindings (business_id, source_type, source_id)
    DEFERRABLE INITIALLY DEFERRED
);
REVOKE ALL ON purchase_residue_write_offs FROM PUBLIC;

COMMENT ON TABLE purchase_residue_write_offs IS
  'Phase 3 corrective (TD-16, 0072 R-96). A purchase''s sub-unit AP residue — 0 < O with conv_R(O) = 0, left by a frozen S5 partial return — written off: the exact txn residue, the chain point it closes, the base the ledger still carried (0 or 1; a base-only entry when 1), the reason and the actor. One per purchase (id = purchase_id), written only by purchase_write_off_residue, never changed or deleted. purchase_ap_outstanding subtracts it.';

-- The 0063 R-35 layering (the S6 tables'): tenant, four restrictive
-- per-command business isolations (only _read admits the internal
-- principals), and permissive reads for the principals whose guards read it.
ALTER TABLE purchase_residue_write_offs ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_residue_write_offs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_membership ON purchase_residue_write_offs
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = purchase_residue_write_offs.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = purchase_residue_write_offs.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON purchase_residue_write_offs AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal') OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON purchase_residue_write_offs AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON purchase_residue_write_offs AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON purchase_residue_write_offs AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON purchase_residue_write_offs
  FOR SELECT TO daftar_inventory_internal USING (true);
CREATE POLICY accounting_validator ON purchase_residue_write_offs
  FOR SELECT TO daftar_accounting_internal USING (true);

-- daftar_app reads (the outstanding function it calls, the replay read, the
-- payable reads) and holds no DML; the internal principal inserts and
-- reads; the accounting principal reads (the completeness trigger).
GRANT SELECT ON purchase_residue_write_offs TO daftar_app;
GRANT SELECT, INSERT ON purchase_residue_write_offs TO daftar_inventory_internal;
GRANT SELECT ON purchase_residue_write_offs TO daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. The extension point, replaced by its owner (the migrator; 0067 R-79):
--    0067's body verbatim plus the write-offs. Same signature, INVOKER
--    STABLE, pinned path; CREATE OR REPLACE keeps its ACL (daftar_app,
--    daftar_inventory_internal).
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
  SELECT coalesce(pg_catalog.sum(r.ap_txn_minor), 0) INTO v_released
  FROM supplier_returns r WHERE r.business_id = p_business_id AND r.purchase_id = p_purchase_id;
  RETURN (v_total - v_released
          - coalesce((SELECT pg_catalog.sum(a.purchase_amount_applied_minor) FROM supplier_payment_allocations a
                       WHERE a.business_id = p_business_id AND a.purchase_id = p_purchase_id), 0)
          - coalesce((SELECT pg_catalog.sum(c.purchase_amount_applied_minor) FROM supplier_credit_allocations c
                       WHERE c.business_id = p_business_id AND c.purchase_id = p_purchase_id), 0)
          - coalesce((SELECT pg_catalog.sum(w.residue_txn_minor) FROM purchase_residue_write_offs w
                       WHERE w.business_id = p_business_id AND w.purchase_id = p_purchase_id), 0))::bigint;
END;
$$;

COMMENT ON FUNCTION purchase_ap_outstanding(UUID, UUID) IS
  'P3-S5 A-16, replaced by P3-S6 (0067, A-13) and by the Phase 3 corrective 0072 (TD-16). The purchase''s outstanding AP in its own currency: T - the sum of ap_txn_minor over its supplier returns - the sum of purchase_amount_applied_minor over its supplier payment allocations - the same over its supplier credit allocations - the residue_txn_minor of its residue write-off; 0 when the purchase is not received or is reversed (R-52); purchase.not_found when the caller cannot see it. INVOKER, reads through the caller''s row security, writes nothing. EXECUTE: daftar_app and daftar_inventory_internal.';

-- ─────────────────────────────────────────────────────────────────────────
-- 5. The inventory-owned guards and the command, created by the applier,
--    PUBLIC revoked and the one EXECUTE grant issued, the triggers created
--    while the applier owns them (0065 section 5 order), then handed to
--    daftar_inventory_internal inside the CREATE bracket.
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;

-- (a) R-95: a return never leaves its purchase a sub-unit residue. Judged
--     at COMMIT on the stored row (the R-77 form): O' = T − X − ap.
CREATE FUNCTION supplier_return_residue_bound() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_p        RECORD;
  v_base_ccy TEXT;
  v_et       INTEGER;
  v_eb       INTEGER;
  v_left     BIGINT;
BEGIN
  IF NEW.ap_txn_minor = 0 THEN
    RETURN NULL;
  END IF;
  SELECT p.currency_code, p.total_txn_minor, p.source_to_base_rate INTO v_p
  FROM purchases p WHERE p.business_id = NEW.business_id AND p.id = NEW.purchase_id;
  SELECT b.base_currency INTO v_base_ccy FROM businesses b WHERE b.id = NEW.business_id;
  SELECT c.minor_units INTO v_et FROM currencies c WHERE c.code = v_p.currency_code::text;
  SELECT c.minor_units INTO v_eb FROM currencies c WHERE c.code = v_base_ccy;
  IF v_p.total_txn_minor IS NULL OR v_et IS NULL OR v_eb IS NULL
     OR NEW.ap_released_before_txn_minor + NEW.ap_txn_minor > v_p.total_txn_minor THEN
    RAISE EXCEPTION 'inventory.source_value_mismatch: a supplier return needs its received purchase totals' USING ERRCODE = 'P0001';
  END IF;
  v_left := v_p.total_txn_minor - NEW.ap_released_before_txn_minor - NEW.ap_txn_minor;
  IF v_left > 0 AND supplier_convert_base(v_left, v_p.source_to_base_rate, v_et, v_eb) = 0 THEN
    RAISE EXCEPTION 'supplier_return.residue_below_base_unit: a return would leave its purchase an outstanding amount converting to less than one base minor unit'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION supplier_return_residue_bound() IS
  'Phase 3 corrective (TD-16, 0072 R-95). At COMMIT, for a supplier return that releases AP (ap > 0): the purchase''s remaining O'' = T - X - ap is 0 or converts at the purchase snapshot to at least one base minor unit; otherwise supplier_return.residue_below_base_unit. The purchase-side twin of 0067 R-77. Internal-owned DEFINER, pinned, no grant; reads only.';

-- (b) The row guard: inserted now by its own command's transaction; never
--     changed or deleted.
CREATE FUNCTION purchase_residue_write_off_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'purchase_residue.immutable: a residue write-off is never changed or deleted' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.created_at IS DISTINCT FROM pg_catalog.now() OR NEW.business_transaction_id IS DISTINCT FROM inventory_business_transaction_id() THEN
    RAISE EXCEPTION 'purchase_residue.immutable: a residue write-off is written only by its own command''s transaction' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION purchase_residue_write_off_guard() IS
  'Phase 3 corrective (TD-16, 0072 R-96). BEFORE INSERT OR UPDATE OR DELETE on purchase_residue_write_offs: an insert carries created_at = now() and this transaction''s business transaction id; an update or delete is purchase_residue.immutable. Internal-owned DEFINER, pinned, no grant.';

-- (c) At COMMIT: the write-off is the purchase's terminal reducer, of a
--     residue converting to 0, releasing exactly the base the law leaves.
CREATE FUNCTION purchase_residue_write_off_value_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_p        RECORD;
  v_base_ccy TEXT;
  v_et       INTEGER;
  v_eb       INTEGER;
  v_others   NUMERIC;
  v_floor    DATE;
BEGIN
  SELECT p.status, p.supplier_id, p.currency_code, p.total_txn_minor, p.total_base_minor, p.source_to_base_rate INTO v_p
  FROM purchases p WHERE p.business_id = NEW.business_id AND p.id = NEW.purchase_id;
  SELECT b.base_currency INTO v_base_ccy FROM businesses b WHERE b.id = NEW.business_id;
  SELECT c.minor_units INTO v_et FROM currencies c WHERE c.code = v_p.currency_code::text;
  SELECT c.minor_units INTO v_eb FROM currencies c WHERE c.code = v_base_ccy;
  SELECT coalesce((SELECT pg_catalog.sum(r.ap_txn_minor) FROM supplier_returns r
                    WHERE r.business_id = NEW.business_id AND r.purchase_id = NEW.purchase_id), 0)
       + coalesce((SELECT pg_catalog.sum(a.purchase_amount_applied_minor) FROM supplier_payment_allocations a
                    WHERE a.business_id = NEW.business_id AND a.purchase_id = NEW.purchase_id), 0)
       + coalesce((SELECT pg_catalog.sum(c.purchase_amount_applied_minor) FROM supplier_credit_allocations c
                    WHERE c.business_id = NEW.business_id AND c.purchase_id = NEW.purchase_id), 0)
    INTO v_others;
  SELECT greatest(
           (SELECT pg_catalog.max(r.document_date) FROM supplier_returns r
             WHERE r.business_id = NEW.business_id AND r.purchase_id = NEW.purchase_id AND r.ap_txn_minor > 0),
           (SELECT pg_catalog.max(sp.payment_date) FROM supplier_payment_allocations a
              JOIN supplier_payments sp ON sp.business_id = a.business_id AND sp.id = a.payment_id
             WHERE a.business_id = NEW.business_id AND a.purchase_id = NEW.purchase_id),
           (SELECT pg_catalog.max(c.allocation_date) FROM supplier_credit_allocations c
             WHERE c.business_id = NEW.business_id AND c.purchase_id = NEW.purchase_id)) INTO v_floor;
  IF v_p.status IS DISTINCT FROM 'received'
     OR NEW.write_off_date < v_floor
     OR EXISTS (SELECT 1 FROM purchase_reversals r WHERE r.business_id = NEW.business_id AND r.id = NEW.purchase_id)
     OR NOT EXISTS (SELECT 1 FROM supplier_returns r
                     WHERE r.business_id = NEW.business_id AND r.purchase_id = NEW.purchase_id AND r.ap_txn_minor > 0)
     OR v_et IS NULL OR v_eb IS NULL
     OR NEW.supplier_id IS DISTINCT FROM v_p.supplier_id
     OR NEW.currency_code IS DISTINCT FROM v_p.currency_code
     OR NEW.source_to_base_rate IS DISTINCT FROM v_p.source_to_base_rate
     OR v_others IS DISTINCT FROM NEW.released_before_txn_minor::numeric
     OR NEW.released_before_txn_minor + NEW.residue_txn_minor <> v_p.total_txn_minor
     OR supplier_convert_base(NEW.residue_txn_minor, v_p.source_to_base_rate, v_et, v_eb) <> 0
     OR NEW.residue_base_minor <> supplier_ap_release(v_p.total_base_minor, v_p.total_txn_minor,
                                                      NEW.released_before_txn_minor, NEW.residue_txn_minor) THEN
    RAISE EXCEPTION 'purchase_residue.settlement_inconsistent: a residue write-off is not the terminal sub-unit release of its returned purchase'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION purchase_residue_write_off_value_complete() IS
  'Phase 3 corrective (TD-16, 0072 R-96). At COMMIT, for a residue write-off: its purchase is received, not reversed, of the row''s supplier, currency and rate, and a supplier return released part of its AP; the row is dated on or after the latest return with AP, payment and credit allocation of the purchase; the row''s X equals the sum of every other reducer (returns'' ap, payment and credit allocations) and X + residue = T; the residue converts to 0 base minor units; residue_base_minor = supplier_ap_release(B, T, X, residue). Otherwise purchase_residue.settlement_inconsistent. Internal-owned DEFINER, pinned, no grant; reads only.';

REVOKE ALL ON FUNCTION supplier_return_residue_bound() FROM PUBLIC;
REVOKE ALL ON FUNCTION purchase_residue_write_off_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION purchase_residue_write_off_value_complete() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER supplier_returns_residue_bound
  AFTER INSERT ON supplier_returns DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION supplier_return_residue_bound();
CREATE TRIGGER purchase_residue_write_offs_guard
  BEFORE INSERT OR UPDATE OR DELETE ON purchase_residue_write_offs
  FOR EACH ROW EXECUTE FUNCTION purchase_residue_write_off_guard();
CREATE CONSTRAINT TRIGGER purchase_residue_write_offs_value_complete
  AFTER INSERT ON purchase_residue_write_offs DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION purchase_residue_write_off_value_complete();

-- (d) purchase.write_off_residue (R-96).
CREATE FUNCTION purchase_write_off_residue(
  p_purchase_id               UUID,
  p_write_off_date            DATE,
  p_reason                    TEXT,
  p_residue_txn_minor         BIGINT,
  p_released_before_txn_minor BIGINT,
  p_residue_base_minor        BIGINT
) RETURNS TABLE (
  purchase_id UUID,
  replayed    BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_floor    DATE;
  v_actor    inventory_verified_actor;
  v_business UUID;
  v_tenant   UUID;
  v_trace    UUID;
  v_intent   TEXT;
  v_stored   TEXT;
  v_replay   BOOLEAN;
  v_p        RECORD;
  v_tz       TEXT;
  v_base_ccy TEXT;
  v_et       INTEGER;
  v_eb       INTEGER;
  v_o        BIGINT;
  v_x        BIGINT;
  v_rb       BIGINT;
BEGIN
  -- 1. The consume, over the routine's own arguments: purchase_id,
  --    write_off_date, reason_w1..w8, residue, released_before, residue_base.
  v_actor := inventory_assertion_consume('purchase.write_off_residue', inventory_claimed_payload_digest('purchase.write_off_residue',
    ARRAY['uuid', 'integer'] || pg_catalog.array_fill('integer'::text, ARRAY[8]) || ARRAY['integer', 'integer', 'integer'],
    ARRAY[p_purchase_id::text, pg_catalog.to_char(p_write_off_date, 'YYYYMMDD')]
      || inventory_reason_words(p_reason)
      || ARRAY[p_residue_txn_minor::text, p_released_before_txn_minor::text, p_residue_base_minor::text]));
  -- 2. Isolation, trace and shape before any state read.
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: inventory commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_business := v_actor.business_id;
  v_tenant   := v_actor.tenant_id;
  v_replay   := false;
  v_trace    := inventory_business_transaction_id();
  IF v_trace IS NULL THEN
    RAISE EXCEPTION 'inventory.trace_missing: a residue write-off records its business transaction id' USING ERRCODE = 'P0001';
  END IF;
  IF p_purchase_id IS NULL OR p_write_off_date IS NULL OR p_residue_txn_minor IS NULL OR p_released_before_txn_minor IS NULL
     OR p_residue_base_minor IS NULL OR p_residue_txn_minor <= 0 OR p_released_before_txn_minor <= 0 OR p_residue_base_minor < 0 THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a residue write-off names its purchase, its date, a positive residue and its chain point' USING ERRCODE = 'P0001';
  END IF;

  -- 3. The S4 purchase key (the receipt's and the reversal's), then the
  --    intent: purchase, date, reason, residue.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('daftar.purchase_id'), pg_catalog.hashtext(p_purchase_id::text));
  v_intent := inventory_payload_digest('purchase.write_off_residue', v_tenant, v_business,
    ARRAY['uuid', 'integer'] || pg_catalog.array_fill('integer'::text, ARRAY[8]) || ARRAY['integer'],
    ARRAY[p_purchase_id::text, pg_catalog.to_char(p_write_off_date, 'YYYYMMDD')] || inventory_reason_words(p_reason) || ARRAY[p_residue_txn_minor::text]);

  -- 4. The purchase FOR UPDATE, then the replay read.
  SELECT p.status, p.supplier_id, p.currency_code, p.document_date, p.total_txn_minor, p.total_base_minor, p.source_to_base_rate
    INTO v_p
  FROM purchases p WHERE p.business_id = v_business AND p.id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase.not_found: the purchase does not exist in this business' USING ERRCODE = 'P0001';
  END IF;
  SELECT w.intent_sha256 INTO v_stored FROM purchase_residue_write_offs w WHERE w.business_id = v_business AND w.id = p_purchase_id;
  IF FOUND THEN
    IF v_stored <> v_intent THEN
      RAISE EXCEPTION 'purchase_residue.already_written_off: the purchase''s residue is already written off' USING ERRCODE = 'P0001';
    END IF;
    v_replay := true;
  ELSE
    IF v_p.status <> 'received' THEN
      RAISE EXCEPTION 'purchase.state_invalid: only a received purchase has a residue to write off' USING ERRCODE = 'P0001';
    END IF;

    -- 5. The reason (the audit trail's why) and the dates.
    IF p_reason IS NULL OR p_reason <> pg_catalog.btrim(p_reason) OR pg_catalog.char_length(p_reason) NOT BETWEEN 1 AND 500 THEN
      RAISE EXCEPTION 'purchase_residue.reason_required: a write-off states a trimmed reason of 1..500 characters' USING ERRCODE = 'P0001';
    END IF;
    SELECT b.timezone, b.base_currency INTO v_tz, v_base_ccy FROM businesses b WHERE b.id = v_business;
    IF p_write_off_date < v_p.document_date THEN
      RAISE EXCEPTION 'purchase_residue.date_before_purchase: a write-off is dated on or after its purchase' USING ERRCODE = 'P0001';
    END IF;
    -- Review L1: never before the last release of the purchase's AP (the
    -- return that left the residue, or a later payment or credit allocation).
    SELECT greatest(
           (SELECT pg_catalog.max(r.document_date) FROM supplier_returns r
             WHERE r.business_id = v_business AND r.purchase_id = p_purchase_id AND r.ap_txn_minor > 0),
           (SELECT pg_catalog.max(sp.payment_date) FROM supplier_payment_allocations a
              JOIN supplier_payments sp ON sp.business_id = a.business_id AND sp.id = a.payment_id
             WHERE a.business_id = v_business AND a.purchase_id = p_purchase_id),
           (SELECT pg_catalog.max(c.allocation_date) FROM supplier_credit_allocations c
             WHERE c.business_id = v_business AND c.purchase_id = p_purchase_id)) INTO v_floor;
    IF p_write_off_date < v_floor THEN
      RAISE EXCEPTION 'purchase_residue.date_before_settlement: a write-off is dated on or after the last return, payment or credit allocation of its purchase' USING ERRCODE = 'P0001';
    END IF;
    IF p_write_off_date > (pg_catalog.now() AT TIME ZONE v_tz)::date THEN
      RAISE EXCEPTION 'purchase_residue.date_in_future: a write-off is dated on or before today in the business timezone' USING ERRCODE = 'P0001';
    END IF;

    -- 6. The residue under the lock: something outstanding, converting to 0.
    v_o := purchase_ap_outstanding(v_business, p_purchase_id);
    IF v_o = 0 THEN
      RAISE EXCEPTION 'purchase_residue.nothing_outstanding: the purchase has no outstanding amount to write off' USING ERRCODE = 'P0001';
    END IF;
    SELECT c.minor_units INTO v_et FROM currencies c WHERE c.code = v_p.currency_code::text;
    SELECT c.minor_units INTO v_eb FROM currencies c WHERE c.code = v_base_ccy;
    IF supplier_convert_base(v_o, v_p.source_to_base_rate, v_et, v_eb) <> 0 THEN
      RAISE EXCEPTION 'purchase_residue.not_below_base_unit: the outstanding amount converts to at least one base minor unit; pay or allocate it' USING ERRCODE = 'P0001';
    END IF;
    v_x  := v_p.total_txn_minor - v_o;
    v_rb := supplier_ap_release(v_p.total_base_minor, v_p.total_txn_minor, v_x, v_o);
    IF p_residue_txn_minor <> v_o OR p_released_before_txn_minor <> v_x OR p_residue_base_minor <> v_rb THEN
      RAISE EXCEPTION 'purchase_residue.amount_mismatch: the outstanding residue changed since the write-off was prepared' USING ERRCODE = 'P0001';
    END IF;
    -- The one origin: a return released part of the AP (the COMMIT guard
    -- proves it again). Unreachable otherwise: S6 never leaves a residue.
    IF NOT EXISTS (SELECT 1 FROM supplier_returns r WHERE r.business_id = v_business AND r.purchase_id = p_purchase_id AND r.ap_txn_minor > 0) THEN
      RAISE EXCEPTION 'purchase_residue.settlement_inconsistent: a residue arises only from a supplier return' USING ERRCODE = 'P0001';
    END IF;

    -- 7. The row, then audit and outbox (ids, not amounts).
    INSERT INTO purchase_residue_write_offs (tenant_id, business_id, id, purchase_id, supplier_id, currency_code, source_to_base_rate,
                                             write_off_date, reason, residue_txn_minor, released_before_txn_minor, residue_base_minor,
                                             intent_sha256, business_transaction_id, created_by, binding_source_id)
    VALUES (v_tenant, v_business, p_purchase_id, p_purchase_id, v_p.supplier_id, v_p.currency_code, v_p.source_to_base_rate,
            p_write_off_date, p_reason, v_o, v_x, v_rb, v_intent, v_trace, v_actor.actor_user_id,
            CASE WHEN v_rb > 0 THEN p_purchase_id END);
    INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
    VALUES (v_tenant, v_business, v_actor.actor_user_id, 'purchase.residue_written_off', 'purchase', p_purchase_id::text,
            pg_catalog.jsonb_build_object('purchaseId', p_purchase_id, 'supplierId', v_p.supplier_id, 'posted', v_rb > 0,
                               'assertionJti', v_actor.jti, 'business_transaction_id', v_trace));
    INSERT INTO outbox_events (tenant_id, business_id, type, payload)
    VALUES (v_tenant, v_business, 'purchase.residue_written_off.v1',
            pg_catalog.jsonb_build_object('businessId', v_business, 'purchaseId', p_purchase_id, 'supplierId', v_p.supplier_id,
                               'businessTransactionId', v_trace));
  END IF;

  RETURN QUERY SELECT p_purchase_id, v_replay;
END;
$$;

COMMENT ON FUNCTION purchase_write_off_residue(UUID, DATE, TEXT, BIGINT, BIGINT, BIGINT) IS
  'Phase 3 corrective (TD-16, 0072 R-96). First consumes an invctl/1 assertion of kind purchase.write_off_residue over its own arguments. Under the daftar.purchase_id key, with the intent (purchase, date, reason, residue): the purchase FOR UPDATE (purchase.not_found); a stored write-off with an equal intent is replayed, another is purchase_residue.already_written_off; purchase.state_invalid; purchase_residue.reason_required, date_before_purchase, date_before_settlement (before the latest return with AP, payment or credit allocation of the purchase), date_in_future; O = purchase_ap_outstanding: nothing_outstanding (O = 0), not_below_base_unit (conv_R(O) >= 1), amount_mismatch (stated residue, X or rb moved); settlement_inconsistent without a return that released AP. Inserts the row (the purchase is its id; binding_source_id iff rb > 0), audit purchase.residue_written_off and its outbox row. The caller posts the purchase_residue_write_off entry iff rb > 0. EXECUTE: daftar_app only.';

REVOKE ALL ON FUNCTION purchase_write_off_residue(UUID, DATE, TEXT, BIGINT, BIGINT, BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purchase_write_off_residue(UUID, DATE, TEXT, BIGINT, BIGINT, BIGINT) TO daftar_app;

ALTER FUNCTION supplier_return_residue_bound() OWNER TO daftar_inventory_internal;
ALTER FUNCTION purchase_residue_write_off_guard() OWNER TO daftar_inventory_internal;
ALTER FUNCTION purchase_residue_write_off_value_complete() OWNER TO daftar_inventory_internal;
ALTER FUNCTION purchase_write_off_residue(UUID, DATE, TEXT, BIGINT, BIGINT, BIGINT) OWNER TO daftar_inventory_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. The accounting side: the completeness trigger, and the reversal guard
--    replaced BY ITS OWNER (0067 (c)'s body; the always-refused list gains
--    the new type — no write-off entry is undone by a generic reversal).
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;

CREATE FUNCTION accounting_purchase_residue_write_off_entry_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_w        RECORD;
  v_base_ccy TEXT;
  v_branch   UUID;
  v_base     TEXT;
  v_expected TEXT[];
  v_actual   TEXT[];
BEGIN
  SELECT w.purchase_id, w.write_off_date, w.residue_base_minor INTO v_w
  FROM purchase_residue_write_offs w
  WHERE w.business_id = NEW.business_id AND w.binding_source_id = NEW.source_id;
  IF NOT FOUND OR v_w.residue_base_minor <= 0 THEN
    RAISE EXCEPTION 'accounting.inventory_detail_missing: a purchase residue write-off entry must be registered by its write-off in the same transaction'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT b.base_currency INTO v_base_ccy FROM businesses b WHERE b.id = NEW.business_id;
  SELECT w.branch_id INTO v_branch
  FROM purchases p JOIN warehouses w ON w.business_id = p.business_id AND w.id = p.warehouse_id
  WHERE p.business_id = NEW.business_id AND p.id = v_w.purchase_id;
  v_base := pg_catalog.concat_ws('|', (1::numeric(20,10))::text, 'base', extract(epoch FROM (v_w.write_off_date::timestamp AT TIME ZONE 'UTC'))::text);

  -- Exactly two base lines: Dr Accounts Payable rb, Cr FX gain rb.
  v_expected := ARRAY[
    pg_catalog.concat_ws('|', 'accounts_payable', 'D', v_w.residue_base_minor::text, v_base_ccy, v_w.residue_base_minor::text, v_base, '-',
              coalesce(v_branch::text, '-')),
    pg_catalog.concat_ws('|', 'fx_gain', 'C', v_w.residue_base_minor::text, v_base_ccy, v_w.residue_base_minor::text, v_base, '-',
              coalesce(v_branch::text, '-'))];
  SELECT pg_catalog.array_agg(x ORDER BY x) INTO v_expected FROM pg_catalog.unnest(v_expected) AS x;

  SELECT pg_catalog.array_agg(s ORDER BY s) INTO v_actual
  FROM (
    SELECT pg_catalog.concat_ws('|', coalesce(a.system_key, '-'),
             CASE WHEN l.debit_minor > 0 AND l.credit_minor = 0 THEN 'D' WHEN l.credit_minor > 0 AND l.debit_minor = 0 THEN 'C' ELSE '?' END,
             greatest(l.debit_minor, l.credit_minor)::text, l.txn_currency, l.txn_amount_minor::text, l.fx_rate::text, l.fx_rate_source,
             extract(epoch FROM l.fx_rate_at)::text,
             coalesce(l.warehouse_id::text, '-'), coalesce(l.branch_id::text, '-')) AS s
    FROM journal_lines l
    JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
    WHERE l.business_id = NEW.business_id AND l.journal_entry_id = NEW.id
  ) AS x;

  IF NEW.entry_date IS DISTINCT FROM v_w.write_off_date OR v_base_ccy IS NULL OR v_branch IS NULL
     OR v_expected IS NULL OR v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'accounting.inventory_entry_mismatch: a purchase residue write-off entry is not exactly the two base lines of its write-off'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION accounting_purchase_residue_write_off_entry_complete() IS
  'Phase 3 corrective (TD-16, 0072 R-96). At COMMIT, for a purchase_residue_write_off entry: its write-off row exists (binding_source_id = source_id) with residue_base_minor > 0, and the entry is exactly Dr Accounts Payable rb / Cr FX gain rb, both base lines at rate 1 (source base, the write-off date), on the purchase warehouse''s branch, no warehouse, dated the write-off date. Otherwise accounting.inventory_detail_missing / accounting.inventory_entry_mismatch. Accounting-owned DEFINER, pinned, no grant.';

REVOKE ALL ON FUNCTION accounting_purchase_residue_write_off_entry_complete() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER journal_entries_purchase_residue_write_off_complete
  AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source_type = 'purchase_residue_write_off')
  EXECUTE FUNCTION accounting_purchase_residue_write_off_entry_complete();

ALTER FUNCTION accounting_purchase_residue_write_off_entry_complete() OWNER TO daftar_accounting_internal;

SET LOCAL ROLE daftar_accounting_internal;

CREATE OR REPLACE FUNCTION accounting_reversals_20_domain_source_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_ob UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM journal_entries je
              WHERE je.business_id = NEW.business_id AND je.id = NEW.original_entry_id
                AND (je.source_type IN ('inventory_adjustment', 'inventory_opening', 'negative_inventory_cost_adjustment', 'supplier_return', 'supplier_payment', 'supplier_credit_allocation', 'supplier_refund', 'purchase_residue_write_off')
                     OR (je.source_type = 'purchase'
                         AND NOT EXISTS (SELECT 1 FROM purchase_reversals r
                                          WHERE r.business_id = NEW.business_id AND r.id = je.source_id
                                            AND r.original_entry_id = NEW.original_entry_id)))) THEN
    RAISE EXCEPTION 'accounting.reversal_source_domain_owned: an entry owned by the inventory domain is not reversed by the generic reversal workflow'
      USING ERRCODE = 'P0001';
  END IF;
  -- R-13: the opening balance's ROW, not the workflow key. The frozen
  -- reversal routine already holds `businesses` FOR SHARE here; the advisory
  -- key would invert R-1's key → businesses order.
  SELECT ob.id INTO v_ob FROM accounting_opening_balances ob
   WHERE ob.business_id = NEW.business_id AND ob.journal_entry_id = NEW.original_entry_id
   FOR NO KEY UPDATE;
  IF v_ob IS NOT NULL
     AND EXISTS (SELECT 1 FROM inventory_openings o
                  WHERE o.business_id = NEW.business_id AND o.status = 'posted'
                    AND o.case_kind = 'opening_balance_bound' AND o.opening_balance_id = v_ob) THEN
    RAISE EXCEPTION 'accounting.opening_balance_inventory_bound: the inventory opening is decomposed against this opening position, whose entry therefore cannot be reversed'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

RESET ROLE;

REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 7. The S6 guard discovery, re-created by the migrator (0068 6a's body):
--    every row and digest verbatim except purchase_ap_outstanding's, which
--    is section 4's, and three rows more — R-95's trigger on the S5 table
--    and R-96's two. Same signature, owner, INVOKER STABLE, pinned path, no
--    grantee.
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
  -- the two replaced extension points included (R-79), of the R-73
  -- credit-note writer (0068), and of the three TD-16 guards and the
  -- extension point as 0072 replaces it.
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
    "supplier_return_value_settled()": "4912571c347258ae4aa66ceb9666c5a0f448a462382c9a9905422d5706f0d2ac",
    "purchase_settlement_verify(uuid,uuid)": "4fcbb7931c06fbf9cf11fc2ede6e4b97357d24b038ed412329c55a48cbafe8ba",
    "supplier_credit_note_verify(uuid,uuid)": "9d18ee17cfdd5f778ee3a767351506d6bbd2209c15d839ed6a295d601abbf76e",
    "supplier_convert_base(bigint,numeric,integer,integer)": "38d765449e2844c1d84971f09277b5857bbddbf741b62a3d8b4c1d4e532e39cf",
    "supplier_ap_release(bigint,bigint,bigint,bigint)": "47eb15a7fc56e1871b5c521ca189782bfbafb8dca3e7bd0bb3adc417016236a9",
    "supplier_credit_remaining_carrying(bigint,bigint,bigint)": "941082099606f825336b0249a76658e65e592df6bbe06f3081576a5be0205144",
    "purchase_ap_outstanding(uuid,uuid)": "e595436066e320ee57cbae16e0da8cbdd391791753c46513228f8cd21279443a",
    "purchase_settlement_state(uuid,uuid)": "b236cda5fe48a2b00c818e0f88f8e9b8de9a3c5b61d04c5cf677e56960d7037b",
    "supplier_credit_note_consume(uuid,bigint,bigint)": "1754d8ac0581a8738c4d0e088671180e9b681ed7fb42575283b1c21d00b98c5b",
    "supplier_return_residue_bound()": "bad7df09dced23b2471c71426c27bb7e750a65e4511cce7255307ef1137574f5",
    "purchase_residue_write_off_guard()": "badf76c0475f6a96cedb5b707307424ebb98b758797d4828289b8b0df98ad1b9",
    "purchase_residue_write_off_value_complete()": "3f75eac6e394c1a438c7887418a2430b4a1a6ca7471a22baf1ad3d288d5caff5"
  }';
BEGIN
  -- The extension points' expected owner: the migrator, who owns this discovery.
  SELECT r.rolname::text INTO v_me
  FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
  WHERE p.oid = 'public.supplier_settlement_guard_gaps()'::regprocedure;
  FOR v_g IN
    SELECT e.tbl, e.tg, e.typ, e.deferred, e.fn, (e.ord IN (20, 21)) AS invoker
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
      (14, 'supplier_returns',             'supplier_returns_value_settled',              5,    true,  'supplier_return_value_settled()'),
      (15, '-', 'purchase_settlement_verify(uuid,uuid)',                    NULL, NULL, 'purchase_settlement_verify(uuid,uuid)'),
      (16, '-', 'supplier_credit_note_verify(uuid,uuid)',                   NULL, NULL, 'supplier_credit_note_verify(uuid,uuid)'),
      (17, '-', 'supplier_convert_base(bigint,numeric,integer,integer)',    NULL, NULL, 'supplier_convert_base(bigint,numeric,integer,integer)'),
      (18, '-', 'supplier_ap_release(bigint,bigint,bigint,bigint)',         NULL, NULL, 'supplier_ap_release(bigint,bigint,bigint,bigint)'),
      (19, '-', 'supplier_credit_remaining_carrying(bigint,bigint,bigint)', NULL, NULL, 'supplier_credit_remaining_carrying(bigint,bigint,bigint)'),
      (20, '-', 'purchase_ap_outstanding(uuid,uuid)',                       NULL, NULL, 'purchase_ap_outstanding(uuid,uuid)'),
      (21, '-', 'purchase_settlement_state(uuid,uuid)',                     NULL, NULL, 'purchase_settlement_state(uuid,uuid)'),
      (22, '-', 'supplier_credit_note_consume(uuid,bigint,bigint)',         NULL, NULL, 'supplier_credit_note_consume(uuid,bigint,bigint)'),
      (23, 'supplier_returns',             'supplier_returns_residue_bound',              5,    true,  'supplier_return_residue_bound()'),
      (24, 'purchase_residue_write_offs',  'purchase_residue_write_offs_guard',           31,   false, 'purchase_residue_write_off_guard()'),
      (25, 'purchase_residue_write_offs',  'purchase_residue_write_offs_value_complete',  5,    true,  'purchase_residue_write_off_value_complete()')
    ) AS e(ord, tbl, tg, typ, deferred, fn)
    ORDER BY e.ord
  LOOP
    v_fn := pg_catalog.to_regprocedure('public.' || v_g.fn);
    IF v_g.tbl <> '-' THEN
      SELECT g.tgenabled::text AS enabled, g.tgtype::integer AS typ, g.tgfoid,
             (g.tgqual IS NULL AND pg_catalog.cardinality(g.tgattr::int2[]) = 0) AS plain,
             (g.tgconstraint <> 0 AND g.tgdeferrable AND g.tginitdeferred) AS deferred
        INTO v_tg
      FROM pg_trigger g
      WHERE g.tgrelid = pg_catalog.to_regclass('public.' || v_g.tbl) AND g.tgname = v_g.tg AND NOT g.tgisinternal;
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
    SELECT r.rolname::text AS owner, p.prosecdef, p.proconfig, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex') AS digest
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
  'P3-S6 §2.3 (0067, R-70(a); re-created by 0068, R-79, and by the Phase 3 corrective 0072, TD-16). Catalogue-only discovery of the S6 guards: for each of the fourteen triggers (the thirteen of §2.3 and R-80''s) (payment_methods_guard, payment_methods_named, payment_method_names_guard, supplier_payments_guard, supplier_payments_complete, supplier_payment_allocations_guard, supplier_payment_allocations_value_complete, supplier_credit_allocations_guard, supplier_credit_allocations_value_complete, supplier_refunds_guard, supplier_refunds_value_complete, the S5 supplier_credit_notes_immutable on its replaced function, purchase_reversals_unsettled, and supplier_returns_value_settled on the S5 table (R-80)) and the three TD-16 triggers (supplier_returns_residue_bound, purchase_residue_write_offs_guard, purchase_residue_write_offs_value_complete) reports trigger_missing, trigger_disabled (tgenabled other than O) and trigger_shape (tgtype, deferral, WHEN, column list, function); for each trigger function, the two verification helpers, the three arithmetic functions and the credit-note writer supplier_credit_note_consume (table_name -, trigger_name the signature) reports function_owner (not daftar_inventory_internal), function_not_definer, function_search_path and function_body (the SHA-256 of prosrc recorded at migration time); for the two replaced extension points purchase_ap_outstanding and purchase_settlement_state reports function_owner (not this discovery''s migrator owner), function_not_invoker, function_search_path and function_body. Migrator-owned INVOKER; no EXECUTE grant.';

REVOKE ALL ON FUNCTION supplier_settlement_guard_gaps() FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────
-- 8. The operation registry, LAST: the CHECK replaced explicitly (a
--    corrective pass is not a slice), then the one kind. No op→movement
--    pair: the write-off moves no stock.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE inventory_operation_kinds DROP CONSTRAINT inventory_operation_kinds_registered_by_check;
ALTER TABLE inventory_operation_kinds ADD CONSTRAINT inventory_operation_kinds_registered_by_check
  CHECK (registered_by ~ '^P3-S[0-9]+$' OR registered_by = 'P3-C');

INSERT INTO inventory_operation_kinds (op_code, registered_by) VALUES
  ('purchase.write_off_residue', 'P3-C');

-- ─────────────────────────────────────────────────────────────────────────
-- 9. Refuse to commit unless the end state is exactly right (0072-E),
--    against the live catalogue.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_role   TEXT;
  v_actual TEXT[];
  v_detail TEXT;
  c_cmd    CONSTANT REGPROCEDURE := 'purchase_write_off_residue(uuid,date,text,bigint,bigint,bigint)'::regprocedure;
  c_guards CONSTANT REGPROCEDURE[] := ARRAY['supplier_return_residue_bound()'::regprocedure,
                                             'purchase_residue_write_off_guard()'::regprocedure,
                                             'purchase_residue_write_off_value_complete()'::regprocedure];
  c_entry  CONSTANT REGPROCEDURE := 'accounting_purchase_residue_write_off_entry_complete()'::regprocedure;
  c_out    CONSTANT REGPROCEDURE := 'purchase_ap_outstanding(uuid,uuid)'::regprocedure;
  c_fn     REGPROCEDURE;
  c_runtime CONSTANT TEXT[] := ARRAY['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver',
                                     'daftar_provisioner', 'daftar_reconciler', 'public'];
BEGIN
  -- (1) The table: row security forced, the seven policies, the grants.
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = 'public.purchase_residue_write_offs'::regclass
                  AND c.relrowsecurity AND c.relforcerowsecurity) THEN
    RAISE EXCEPTION 'purchase_residue.migration_end_state_invalid: purchase_residue_write_offs does not force row security';
  END IF;
  SELECT array_agg(p.polname::text || ':' || p.polcmd::text || ':' || p.polpermissive::text ORDER BY p.polname) INTO v_actual
  FROM pg_policy p WHERE p.polrelid = 'public.purchase_residue_write_offs'::regclass;
  IF v_actual IS DISTINCT FROM ARRAY['accounting_validator:r:true', 'business_isolation_delete:d:false', 'business_isolation_insert:a:false',
                                     'business_isolation_read:r:false', 'business_isolation_update:w:false', 'inventory_internal_read:r:true',
                                     'tenant_membership:*:true'] THEN
    RAISE EXCEPTION 'purchase_residue.migration_end_state_invalid: purchase_residue_write_offs policies are %', v_actual;
  END IF;
  SELECT array_agg(g.grantee::text || ':' || g.privilege_type ORDER BY g.grantee, g.privilege_type) INTO v_actual
  FROM information_schema.role_table_grants g
  WHERE g.table_schema = 'public' AND g.table_name = 'purchase_residue_write_offs'
    AND g.grantee IN ('PUBLIC', 'daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver', 'daftar_provisioner',
                      'daftar_reconciler', 'daftar_inventory_internal', 'daftar_accounting_internal', 'daftar_catalog_internal',
                      'daftar_provisioning_internal');
  IF v_actual IS DISTINCT FROM ARRAY['daftar_accounting_internal:SELECT', 'daftar_app:SELECT', 'daftar_inventory_internal:INSERT',
                                     'daftar_inventory_internal:SELECT'] THEN
    RAISE EXCEPTION 'purchase_residue.migration_end_state_invalid: purchase_residue_write_offs grants are %', v_actual;
  END IF;

  -- (2) The command: inventory-owned DEFINER, pinned, EXECUTE daftar_app only.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                  WHERE p.oid = c_cmd AND r.rolname = 'daftar_inventory_internal' AND p.prosecdef
                    AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']) THEN
    RAISE EXCEPTION 'purchase_residue.migration_end_state_invalid: purchase_write_off_residue is not the inventory-owned pinned DEFINER';
  END IF;
  SELECT array_agg(x.grantee::regrole::text || ':' || x.privilege_type ORDER BY 1) INTO v_actual
  FROM pg_proc p, aclexplode(p.proacl) x WHERE p.oid = c_cmd AND x.grantee <> p.proowner;
  IF v_actual IS DISTINCT FROM ARRAY['daftar_app:EXECUTE'] THEN
    RAISE EXCEPTION 'purchase_residue.migration_end_state_invalid: purchase_write_off_residue must be executable by daftar_app only, found %', v_actual;
  END IF;

  -- (3) The guards: inventory-owned DEFINER trigger functions, pinned, no grantee.
  FOREACH c_fn IN ARRAY c_guards LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                    WHERE p.oid = c_fn AND r.rolname = 'daftar_inventory_internal' AND p.prosecdef AND p.prorettype = 'trigger'::regtype
                      AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp'])
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x WHERE p.oid = c_fn AND x.grantee <> p.proowner) THEN
      RAISE EXCEPTION 'purchase_residue.migration_end_state_invalid: % is not an inventory-owned pinned DEFINER trigger function without grantee', c_fn;
    END IF;
  END LOOP;
  FOREACH v_role IN ARRAY c_runtime LOOP
    IF has_function_privilege(v_role, 'supplier_return_residue_bound()'::regprocedure, 'EXECUTE')
       OR has_function_privilege(v_role, 'purchase_residue_write_off_value_complete()'::regprocedure, 'EXECUTE')
       OR has_function_privilege(v_role, c_entry, 'EXECUTE') THEN
      RAISE EXCEPTION 'purchase_residue.migration_end_state_invalid: % may run a TD-16 guard', v_role;
    END IF;
  END LOOP;

  -- (4) The accounting completeness guard and its trigger; the replaced
  --     reversal guard still the accounting principal's, naming the type.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                  WHERE p.oid = c_entry AND r.rolname = 'daftar_accounting_internal' AND p.prosecdef
                    AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp'])
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x WHERE p.oid = c_entry AND x.grantee <> p.proowner)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger g
                     WHERE g.tgrelid = 'public.journal_entries'::regclass AND g.tgname = 'journal_entries_purchase_residue_write_off_complete'
                       AND g.tgfoid = c_entry AND g.tgenabled = 'O' AND g.tgtype = 5 AND g.tgdeferrable AND g.tginitdeferred
                       AND position('WHEN ((new.source_type = ''purchase_residue_write_off''::text))' IN pg_get_triggerdef(g.oid)) > 0) THEN
    RAISE EXCEPTION 'purchase_residue.migration_end_state_invalid: the write-off entry completeness guard is not in place';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                  WHERE p.oid = 'accounting_reversals_20_domain_source_guard()'::regprocedure AND r.rolname = 'daftar_accounting_internal'
                    AND p.prosecdef AND position('''purchase_residue_write_off''' IN p.prosrc) > 0) THEN
    RAISE EXCEPTION 'purchase_residue.migration_end_state_invalid: the reversal guard does not refuse a write-off entry';
  END IF;

  -- (5) The extension point: migrator-owned INVOKER, pinned, its ACL kept.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = c_out AND NOT p.prosecdef AND p.provolatile = 's'
                  AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
                  AND position('purchase_residue_write_offs' IN p.prosrc) > 0
                  AND p.proowner = (SELECT q.proowner FROM pg_proc q WHERE q.oid = 'supplier_settlement_guard_gaps()'::regprocedure)) THEN
    RAISE EXCEPTION 'purchase_residue.migration_end_state_invalid: purchase_ap_outstanding is not the migrator''s INVOKER subtracting write-offs';
  END IF;
  SELECT array_agg(x.grantee::regrole::text || ':' || x.privilege_type ORDER BY 1) INTO v_actual
  FROM pg_proc p, aclexplode(p.proacl) x WHERE p.oid = c_out AND x.grantee <> p.proowner;
  IF v_actual IS DISTINCT FROM ARRAY['daftar_app:EXECUTE', 'daftar_inventory_internal:EXECUTE'] THEN
    RAISE EXCEPTION 'purchase_residue.migration_end_state_invalid: purchase_ap_outstanding grants are %', v_actual;
  END IF;

  -- (6) The discovery sees every S6 and TD-16 guard as recorded.
  SELECT string_agg(g.table_name || ':' || g.trigger_name || ':' || g.missing, ', ') INTO v_detail FROM supplier_settlement_guard_gaps() g;
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'purchase_residue.migration_end_state_invalid: supplier_settlement_guard_gaps reports %', v_detail;
  END IF;

  -- (7) The registries.
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
       WHERE c.conrelid = 'public.inventory_operation_kinds'::regclass AND c.conname = 'inventory_operation_kinds_registered_by_check')
     IS DISTINCT FROM 'CHECK (((registered_by ~ ''^P3-S[0-9]+$''::text) OR (registered_by = ''P3-C''::text)))'
     OR (SELECT count(*) FROM inventory_operation_kinds) <> 27
     OR (SELECT string_agg(k.op_code, ',') FROM inventory_operation_kinds k WHERE k.registered_by = 'P3-C') IS DISTINCT FROM 'purchase.write_off_residue'
     OR EXISTS (SELECT 1 FROM inventory_operation_movement_kinds m WHERE m.op_code = 'purchase.write_off_residue')
     OR NOT EXISTS (SELECT 1 FROM accounting_operation_kinds o WHERE o.operation_kind = 'post' AND o.source_type = 'purchase_residue_write_off') THEN
    RAISE EXCEPTION 'purchase_residue.migration_end_state_invalid: the operation and source registries are not the TD-16 end state';
  END IF;

  -- (8) No internal principal keeps CREATE on public.
  IF has_schema_privilege('daftar_accounting_internal', 'public', 'CREATE')
     OR has_schema_privilege('daftar_inventory_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'purchase_residue.migration_end_state_invalid: an internal principal still holds CREATE on schema public';
  END IF;
END $$;
