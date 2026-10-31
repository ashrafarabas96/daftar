-- 0081_phase4_customer_payments_credits.sql
-- Phase 4 / P4-S4 — THE CUSTOMER SETTLEMENT SOURCES AND THEIR COMMANDS:
-- the received-money document `payments`, its accounting source
-- `payment_allocations`, the liability document `customer_credits` and its
-- accounting source `customer_credit_applications`; the invoice-chain and
-- credit verifiers; the guards; the two signed commands; the corrected
-- reader-of-record; and the registrations, LAST.
--
-- Migrations 0000-0079 are FROZEN and untouched. `0080` is a CANDIDATE and is
-- untouched: this file builds on its corrected `invoice_outstanding` body and
-- replaces it once more, which is the accepted extension-point manner
-- (`0067:1379-1424` replaced two P3-S5 readers exactly so).
--
-- ── Rulings taken here (the coordinator's P4-S4 BUILD CONTRACT) ─────────
--
--   R-81 THE SETTLEMENT ARITHMETIC IS REUSED, NEVER RE-IMPLEMENTED. Every
--        release, conversion and remaining-carrying value below is computed
--        by `supplier_convert_base`, `supplier_ap_release` and
--        `supplier_credit_remaining_carrying` (`0067:671/683/696`). They are
--        IMMUTABLE, take plain BIGINTs and contain nothing supplier-specific
--        but their names. A second body of that arithmetic would be a second
--        financial truth, so there is none. See the comment at the first call
--        site.
--   R-82 THE AR CARRYING. For an invoice T = total_txn_minor,
--        B = total_base_minor, R = source_to_base_rate, O = the outstanding
--        `invoice_outstanding` reports, X = T - O.
--        rel = supplier_ap_release(B, T, X, a) = HALF_EVEN(B(X+a), T) -
--        HALF_EVEN(B·X, T); conv_R(x) = the 0043 law; ar_dust = rel - conv_R(a),
--        a base-only line on the SAME account as the principal (OQ-9:
--        `accounts_receivable` for an allocation, `customer_credit_liability`
--        for a credit application). The realized remainder is FX and goes to
--        `fx_gain` (4900) or `fx_loss` (6900) only — never 6100, never 6200.
--   R-83 THE INVOICE CHAIN. Over every reducer of an invoice — S4's
--        `payment_allocations` and `customer_credit_applications`, and from
--        S5/S6 one more UNION ALL branch each — ordered by X ascending: each
--        row's X is the sum of the amounts ordered before it (no gap, no
--        overlap), each row's release is the release of its own X,
--        Sigma amount <= T and Sigma rel = HALF_EVEN(B · Sigma amount, T).
--        `invoice_settlement_verify` proves it at COMMIT, through a
--        `CREATE CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` on each
--        reducer relation: two writers that computed from the same O overlap
--        and are refused even if a lock were missing.
--   R-84 DEPARTURE A — THE INVOICE-SIDE FK TAKES THE EXISTING KEY. Both
--        reducer relations reference `invoices (business_id, id)`, the primary
--        key, and NOT `(business_id, id, customer_id)`. `invoices` is an
--        earlier slice's applied table and adding a candidate key to it is an
--        ownership question the Tech Lead has not answered. What the narrower
--        key stops proving moves onto `invoice_settlement_verify`:
--          (a) the customer identity pin — a reducer's customer_id equals the
--              invoice's: `invoice_settlement.customer_mismatch`;
--          (b) the walk-in law — an invoice whose customer_id IS NULL carries
--              no reducer at all: `invoice_settlement.walkin_not_settleable`.
--        Cross-business linkage stays unrepresentable either way, because ONE
--        business_id column feeds every foreign key on the row and there is
--        nowhere to put a second. See the comment at each declaration site.
--   R-85 DEPARTURE B — `payment_method_guard()` IS NOT TOUCHED. Its
--        `posting_account_locked` arm names `supplier_payments` and
--        `supplier_refunds` only (`0067:839-841`), so a method that has taken
--        a CUSTOMER payment may still move its posting account. Extending it
--        would mean replacing a Phase 3 body and re-recording its SHA-256
--        inside `supplier_settlement_guard_gaps()` (`0067:1801`, `0068:1331`)
--        with the probe ritual, which is cross-phase surface the Tech Lead has
--        not ruled on. The gap is REAL and DISCLOSED, and it is bounded: each
--        `payments` row pins its own posting_account_id through its
--        three-column FK into the method row, so no existing row is rewritten
--        and no entry is retroactively changed. Only a FUTURE payment could
--        post to a different account than past ones.
--   R-86 THE COMMAND SHAPE IS THE SUPPLIER SHAPE (OQ-3). The caller passes the
--        pre-computed release, dust, base and FX figures; the routine
--        recomputes every one of them under the locks and refuses
--        `...settlement_changed` on any disagreement, exactly as `supplier_pay`
--        does at `0068:760-764`. It is not the `sale_commit`
--        recompute-everything shape.
--   R-87 ZERO ALLOCATIONS ARE IN SCOPE (OQ-4). `allocation_count` is
--        `BETWEEN 0 AND 50`, so pure on-account money is representable, and the
--        one closure the document owes is
--        Sigma allocation payment amounts + Sigma credit created = amount_minor,
--        verified at COMMIT by `payment_closure_verify`. It is stated in the
--        PAYMENT'S OWN CURRENCY, which is the only currency the three terms
--        share: the four-column payment FK pins every allocation's
--        payment_currency to the payment's currency_code and the four-column
--        origin FK pins every created credit's currency_code to it too, so the
--        sum has one unit by construction. In the payment's own currency an
--        allocation's invoice_amount_applied_minor EQUALS its
--        payment_amount_minor (`payment_allocations_same_currency_ck`), which is
--        why this is the same law the contract states in terms of the applied
--        amount; across currencies only the payment-side statement is a sum of
--        commensurable quantities.
--   R-88 LEVEL UNIQUENESS, BOTH HALVES (OQ-1). Each reducer relation carries
--        `UNIQUE (business_id, invoice_id, ar_released_before_txn_minor)` and
--        `customer_credit_applications` also carries the credit-side
--        `UNIQUE (business_id, credit_id, credit_remaining_before_minor)`
--        (`0067:435` exactly). A per-relation UNIQUE cannot see across the two
--        relations, so it is a fast backstop and the cross-relation guarantee
--        rests on `invoice_settlement_verify`. Said again at each declaration.
--   R-89 THE WALK-IN AND CASH LAWS. A walk-in invoice is refused by R-84(b).
--        A CASH-settled invoice reports outstanding = 0 (`0080`), so X = T and
--        X + a > T refuses every allocation by the chain arithmetic itself; the
--        guards say so by name rather than leaving it to a subtraction.
--   R-90 NO SECOND BALANCE, NO SECOND WRITER. Nothing here stores a paid,
--        outstanding, due or allocated amount; `customer_credits`'s remaining
--        pair is a fact of the source document (P4-AL-14) and is moved only by
--        `customer_credit_consume`, the one writer, judged by
--        `customer_credit_guard` — the `0068:439-480` / `0067:1336-1370` pair.
--   R-91 ONE JOURNAL ENTRY PER REDUCER ROW, source_id = the row id. Both
--        reducer relations carry the generated `accounting_source_type`, the
--        `binding_source_id = id` CHECK and the deferred binding FK
--        (`0067:383-404`), so collapsing N allocations into one entry is not
--        expressible: there is nowhere to put the other N-1 source ids.
--   R-92 OD-03 STAYS OPEN. No tax rule is inferred, researched or written.
--        Sales tax remains structurally zero and nothing here carries a tax
--        element.
--   R-93 THE SURPLUS CREDIT IS ITS OWN ACCOUNTING SOURCE. A positive surplus
--        moves money — the posting account is debited and
--        `customer_credit_liability` (2210) credited — and under R-87 a
--        payment may have ZERO allocations, so there is no allocation entry
--        for that leg to ride. Nor could it be bolted onto one when
--        allocations do exist: the allocation entry's completeness validator
--        pins its line multiset EXACTLY (`0067:1998-2027`). So
--        `customer_credits` is a THIRD source type, `customer_credit`, with
--        `source_id` = the credit's id, carrying the same generated
--        `accounting_source_type` + `binding_source_id = id` CHECK + deferred
--        binding FK as the two reducers (R-91): one entry per row, one source
--        identity per entry, nothing polymorphic, no second writer. The
--        surplus entry belongs to the `customer_credits` row, never to a
--        payment allocation.

-- ─────────────────────────────────────────────────────────────────────────
-- 0081-PRE: the head this file applies on, and the absence it closes.
-- ─────────────────────────────────────────────────────────────────────────
DO $pre$
DECLARE
  c_arith CONSTANT TEXT[] := ARRAY['supplier_convert_base(bigint,numeric,integer,integer)',
                                   'supplier_ap_release(bigint,bigint,bigint,bigint)',
                                   'supplier_credit_remaining_carrying(bigint,bigint,bigint)'];
  v_name  TEXT;
BEGIN
  -- (1) THE HEAD IS 0080. P4-S3's two POS relations are there, and the live
  --     `invoice_outstanding` already reads its sale's settlement mode —
  --     which is `0080`'s whole change and nothing earlier produces.
  IF to_regclass('public.pos_till_sessions') IS NULL OR to_regclass('public.pos_cart_lines') IS NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0081 applies on the 0080 head, which includes P4-S3''s POS relations'
      USING ERRCODE = 'P0001';
  END IF;
  IF to_regprocedure('public.invoice_outstanding(UUID, UUID)') IS NULL
     OR pg_get_functiondef(to_regprocedure('public.invoice_outstanding(UUID, UUID)')) NOT LIKE '%settlement_mode%' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the live invoice_outstanding does not read its sale''s settlement mode, so 0080 is not the head'
      USING ERRCODE = 'P0001';
  END IF;

  -- (2) THE ABSENCE THIS FILE CLOSES IS PROVED PRESENT FIRST. A migration
  --     whose subject is already there is a migration nobody can tell from a
  --     no-op ([[daftar-a-green-gate-must-prove-it-can-be-red]]).
  FOREACH v_name IN ARRAY ARRAY['payments', 'payment_allocations', 'customer_credits', 'customer_credit_applications'] LOOP
    IF to_regclass('public.' || v_name) IS NOT NULL THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: % already exists, so 0081 has no relation to create', v_name
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  IF pg_get_functiondef(to_regprocedure('public.invoice_outstanding(UUID, UUID)')) LIKE '%payment_allocations%' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: invoice_outstanding already reads payment_allocations, so seam S-P4-03 is not open'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM accounting_source_types t
              WHERE t.source_type IN ('customer_payment_allocation', 'customer_credit_application', 'customer_credit')) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: a P4-S4 accounting source type is already registered' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM inventory_operation_kinds k
              WHERE k.op_code IN ('customer.collect_payment', 'customer.apply_credit')) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: a P4-S4 operation kind is already registered' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.accounting_reversals_20_domain_source_guard()'))
     LIKE '%customer_payment_allocation%' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the generic reversal guard already names a P4-S4 source type' USING ERRCODE = 'P0001';
  END IF;

  -- (3) The parents this file binds to, and the system accounts OQ-9 names,
  --     exist. A composite FK to a table that is not there fails loudly; a
  --     system key that is not there fails at the first posting instead, so it
  --     is read now.
  IF to_regclass('public.invoices') IS NULL OR to_regclass('public.customers') IS NULL
     OR to_regclass('public.payment_methods') IS NULL OR to_regclass('public.sales') IS NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: a parent relation 0081 binds to is missing' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conname = 'payment_methods_account_uq' AND c.conrelid = 'public.payment_methods'::regclass AND c.contype = 'u') THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: payment_methods_account_uq is missing, so the three-column method FK is not expressible'
      USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(DISTINCT k.system_key) FROM accounting_system_account_keys k
       WHERE k.system_key IN ('accounts_receivable', 'customer_credit_liability', 'fx_gain', 'fx_loss')) <> 4 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the four system account keys the P4-S4 line shapes name are not all in the closed chart'
      USING ERRCODE = 'P0001';
  END IF;

  -- (4) R-81: the three arithmetic primitives are the accepted ones. Their
  --     bodies are captured here and compared, unchanged, in the end state —
  --     a file that calls them must not have replaced them on the way past.
  FOREACH v_name IN ARRAY c_arith LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                    WHERE p.oid = v_name::regprocedure
                      AND p.provolatile = 'i' AND p.prosecdef AND r.rolname = 'daftar_inventory_internal'
                      AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']) THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: % is not the accepted IMMUTABLE internal-owned arithmetic primitive', v_name
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  PERFORM set_config('daftar.p4s4_pre_arithmetic',
    (SELECT string_agg(encode(digest(p.prosrc, 'sha256'), 'hex'), '|' ORDER BY p.oid::regprocedure::text)
       FROM pg_proc p WHERE p.oid = ANY (ARRAY(SELECT x::regprocedure FROM unnest(c_arith) x))), true);

  -- (5) The capture `0080` takes of its own replacement target, taken again:
  --     this file replaces the same routine and must move the BODY and nothing
  --     else.
  PERFORM set_config('daftar.p4s4_pre_invoice_outstanding',
    (SELECT format('%s|%s|%s|%s', p.proowner::regrole, p.prosecdef, coalesce(p.proconfig::text, '-'), coalesce(p.proacl::text, '-'))
       FROM pg_proc p WHERE p.oid = to_regprocedure('public.invoice_outstanding(UUID, UUID)')), true);
  PERFORM set_config('daftar.p4s4_pre_readers_above',
    (SELECT pg_catalog.md5(pg_catalog.string_agg(pg_get_functiondef(f.oid), '|' ORDER BY f.oid))
       FROM (SELECT to_regprocedure('public.invoice_settlement_state(UUID, UUID)') AS oid
             UNION ALL SELECT to_regprocedure('public.customer_ar_outstanding(UUID, UUID)')
             UNION ALL SELECT to_regprocedure('public.customer_ar_aging(UUID, UUID, DATE, INTEGER[])')) f), true);
  -- And the Phase 3 guard body R-85 deliberately leaves alone, so the end
  -- state can prove the departure was taken rather than forgotten.
  PERFORM set_config('daftar.p4s4_pre_method_guard',
    (SELECT encode(digest(p.prosrc, 'sha256'), 'hex') FROM pg_proc p
      WHERE p.oid = to_regprocedure('public.payment_method_guard()')), true);
END
$pre$;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The four relations.
--
-- Money is BIGINT minor units bounded by +/-10^18, rates NUMERIC(20,10) exact
-- at ten places. No column names a balance, an outstanding, a paid, a due or
-- an allocated amount (G-3 as extended to the whole Phase 4 surface): every
-- open amount is derived (P4-AL-05, P4-AL-06).
-- ─────────────────────────────────────────────────────────────────────────

-- The received-money document. The `supplier_payments` mirror (`0067:324-356`)
-- with two departures: `allocation_count` admits 0 (R-87) and the closure law
-- is the one the document genuinely owes rather than full allocation.
CREATE TABLE payments (
  tenant_id               UUID NOT NULL,
  business_id             UUID NOT NULL,
  id                      UUID NOT NULL,
  customer_id             UUID NOT NULL,
  payment_method_id       UUID NOT NULL,
  posting_account_id      UUID NOT NULL,
  currency_code           CHAR(3) NOT NULL,
  amount_minor            BIGINT NOT NULL CHECK (amount_minor BETWEEN 1 AND 1000000000000000000),
  payment_to_base_rate    NUMERIC(20,10) NOT NULL CHECK (payment_to_base_rate > 0 AND payment_to_base_rate = trunc(payment_to_base_rate, 10)),
  rate_source             TEXT NOT NULL CHECK (rate_source IN ('base', 'manual')),
  rate_timestamp          TIMESTAMPTZ NOT NULL CHECK (rate_timestamp = date_trunc('second', rate_timestamp)),
  fx_rate_id              UUID,
  base_amount_minor       BIGINT NOT NULL CHECK (base_amount_minor BETWEEN 1 AND 1000000000000000000),
  payment_date            DATE NOT NULL,
  reference               TEXT CHECK (reference IS NULL OR (char_length(reference) BETWEEN 1 AND 100 AND reference = btrim(reference))),
  -- R-87: ZERO is admitted, where `0067:341` admits 1..50. A customer
  -- overpayment with no allocation at all is money on account, which the
  -- Customer Credit Law requires to be representable; the closure the
  -- document owes is `payment_closure_verify`'s, not full allocation.
  allocation_count        INTEGER NOT NULL CHECK (allocation_count BETWEEN 0 AND 50),
  intent_sha256           TEXT NOT NULL CHECK (intent_sha256 ~ '^[0-9a-f]{64}$'),
  business_transaction_id UUID NOT NULL,
  created_by              UUID NOT NULL REFERENCES users (id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  -- The candidate key the allocation's four-column payment FK and the
  -- credit's four-column origin FK both target: it pins business, customer
  -- AND currency in one edge, so a child in another customer's name or in a
  -- currency the payment was not in is not representable.
  CONSTRAINT payments_identity_uq UNIQUE (business_id, id, customer_id, currency_code),
  CONSTRAINT payments_rate_ck CHECK ((rate_source = 'base') = (fx_rate_id IS NULL AND payment_to_base_rate = 1)),
  CONSTRAINT payments_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT payments_customer_fk FOREIGN KEY (business_id, customer_id) REFERENCES customers (business_id, id) ON DELETE RESTRICT,
  -- The posting account is PART OF THE KEY into the method row (`0067:351-354`),
  -- so the client cannot choose a general-ledger account: a (method of A,
  -- account of B) pair, and a (method, account) pair the method does not
  -- carry, are both unrepresentable.
  CONSTRAINT payments_method_fk
    FOREIGN KEY (business_id, payment_method_id, posting_account_id)
    REFERENCES payment_methods (business_id, id, posting_account_id) ON DELETE RESTRICT,
  CONSTRAINT payments_currency_fk FOREIGN KEY (currency_code) REFERENCES currencies (code),
  CONSTRAINT payments_fx_rate_fk FOREIGN KEY (business_id, fx_rate_id) REFERENCES accounting_fx_rates (business_id, id) ON DELETE RESTRICT
);
REVOKE ALL ON payments FROM PUBLIC;

-- A customer's payments, and the method-in-use test R-85 documents as not yet
-- consulted by `payment_method_guard()`.
CREATE INDEX payments_customer_idx ON payments (business_id, customer_id, payment_date, id);
CREATE INDEX payments_method_idx ON payments (business_id, payment_method_id);

-- The first accounting source: one journal entry per row, source_id = id
-- (R-91). The `supplier_payment_allocations` mirror (`0067:362-404`).
CREATE TABLE payment_allocations (
  tenant_id                            UUID NOT NULL,
  business_id                          UUID NOT NULL,
  id                                   UUID NOT NULL,
  payment_id                           UUID NOT NULL,
  -- Denormalised ON PURPOSE (`0067:366` does the same with supplier_id): it is
  -- what lets the payment edge pin both ends of the row to one customer, and
  -- it is the column `invoice_settlement_verify` pins against the invoice
  -- under R-84(a).
  customer_id                          UUID NOT NULL,
  invoice_id                           UUID NOT NULL,
  line_no                              INTEGER NOT NULL CHECK (line_no BETWEEN 1 AND 50),
  payment_currency                     CHAR(3) NOT NULL,
  payment_amount_minor                 BIGINT NOT NULL CHECK (payment_amount_minor BETWEEN 1 AND 1000000000000000000),
  payment_to_base_rate                 NUMERIC(20,10) NOT NULL
    CHECK (payment_to_base_rate > 0 AND payment_to_base_rate = trunc(payment_to_base_rate, 10)),
  payment_base_amount_minor            BIGINT NOT NULL CHECK (payment_base_amount_minor BETWEEN 1 AND 1000000000000000000),
  invoice_currency                     CHAR(3) NOT NULL,
  invoice_amount_applied_minor         BIGINT NOT NULL CHECK (invoice_amount_applied_minor BETWEEN 1 AND 1000000000000000000),
  invoice_historical_to_base_rate      NUMERIC(20,10) NOT NULL
    CHECK (invoice_historical_to_base_rate > 0 AND invoice_historical_to_base_rate = trunc(invoice_historical_to_base_rate, 10)),
  ar_released_before_txn_minor         BIGINT NOT NULL CHECK (ar_released_before_txn_minor BETWEEN 0 AND 1000000000000000000),
  invoice_carrying_base_released_minor BIGINT NOT NULL CHECK (invoice_carrying_base_released_minor BETWEEN 0 AND 1000000000000000000),
  ar_dust_base_minor                   BIGINT NOT NULL CHECK (ar_dust_base_minor BETWEEN -1000000000000000000 AND 1000000000000000000),
  realized_fx_gain_loss_minor          BIGINT NOT NULL CHECK (realized_fx_gain_loss_minor BETWEEN -1000000000000000000 AND 1000000000000000000),
  created_at                           TIMESTAMPTZ NOT NULL DEFAULT now(),
  accounting_source_type               TEXT NOT NULL GENERATED ALWAYS AS ('customer_payment_allocation') STORED,
  binding_source_id                    UUID NOT NULL,
  PRIMARY KEY (business_id, id),
  CONSTRAINT payment_allocations_line_no_uq UNIQUE (business_id, payment_id, line_no),
  CONSTRAINT payment_allocations_invoice_uq UNIQUE (business_id, payment_id, invoice_id),
  -- R-88 LEVEL UNIQUENESS. Two allocations computed from the same chain
  -- position cannot both exist. It is a FAST PER-RELATION BACKSTOP and not the
  -- invariant: a UNIQUE index cannot see across `payment_allocations` and
  -- `customer_credit_applications`, which can each occupy the same level, so
  -- the cross-relation guarantee rests on `invoice_settlement_verify`. The
  -- supplier precedent carries this on the note chain (`0067:435`) and not on
  -- the purchase chain; adding it here is strictly stronger and costs nothing.
  CONSTRAINT payment_allocations_level_uq UNIQUE (business_id, invoice_id, ar_released_before_txn_minor),
  CONSTRAINT payment_allocations_realized_ck
    CHECK (realized_fx_gain_loss_minor = payment_base_amount_minor - invoice_carrying_base_released_minor),
  CONSTRAINT payment_allocations_same_currency_ck
    CHECK (payment_currency <> invoice_currency OR payment_amount_minor = invoice_amount_applied_minor),
  CONSTRAINT payment_allocations_binding_identity_ck CHECK (binding_source_id = id),
  CONSTRAINT payment_allocations_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT payment_allocations_payment_fk
    FOREIGN KEY (business_id, payment_id, customer_id, payment_currency)
    REFERENCES payments (business_id, id, customer_id, currency_code) ON DELETE RESTRICT,
  -- R-84 DEPARTURE A. This edge names the EXISTING primary key of `invoices`,
  -- not `(business_id, id, customer_id)`. A
  -- `UNIQUE (business_id, id, customer_id)` on `invoices` would make the
  -- customer identity pin and the walk-in law STRUCTURAL, and `0067:274` is
  -- the accepted precedent for adding exactly such a key to an earlier
  -- slice's table ("It contains the primary key, so it validates on any
  -- data."). It is DEFERRED TO A TECH LEAD RULING ON SLICE OWNERSHIP rather
  -- than forgotten: until then both laws are enforced by
  -- `invoice_settlement_verify`, a deferred constraint trigger, with the
  -- refusal codes `invoice_settlement.customer_mismatch` and
  -- `invoice_settlement.walkin_not_settleable`, and each has a permanent test
  -- and a planted red proof.
  CONSTRAINT payment_allocations_invoice_fk
    FOREIGN KEY (business_id, invoice_id) REFERENCES invoices (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT payment_allocations_binding_fk
    FOREIGN KEY (business_id, accounting_source_type, binding_source_id)
    REFERENCES accounting_source_bindings (business_id, source_type, source_id)
    DEFERRABLE INITIALLY DEFERRED
);
REVOKE ALL ON payment_allocations FROM PUBLIC;

-- The invoice's reducers (R-83, and the reader-of-record's subtraction).
CREATE INDEX payment_allocations_invoice_idx ON payment_allocations (business_id, invoice_id);

-- The liability document. The `supplier_credit_notes` mirror image, whose
-- remaining pair is the one mutable thing in this file and moves only through
-- `customer_credit_consume` (R-90).
CREATE TABLE customer_credits (
  tenant_id                            UUID NOT NULL,
  business_id                          UUID NOT NULL,
  id                                   UUID NOT NULL,
  customer_id                          UUID NOT NULL,
  -- A SINGLE NAMED ORIGIN, never a polymorphic one (G-19: the financial core
  -- has no polymorphic FK). In S4 an overpayment is the only origin; a later
  -- slice that adds another adds a named column and its own edge, and G-12
  -- forbids a refund relation naming a payment at all.
  origin_payment_id                    UUID NOT NULL,
  currency_code                        CHAR(3) NOT NULL,
  original_amount_minor                BIGINT NOT NULL CHECK (original_amount_minor BETWEEN 1 AND 1000000000000000000),
  original_carrying_base_amount_minor  BIGINT NOT NULL
    CHECK (original_carrying_base_amount_minor BETWEEN 1 AND 1000000000000000000),
  credit_to_base_rate                  NUMERIC(20,10) NOT NULL
    CHECK (credit_to_base_rate > 0 AND credit_to_base_rate = trunc(credit_to_base_rate, 10)),
  rate_source                          TEXT NOT NULL CHECK (rate_source IN ('base', 'manual')),
  rate_timestamp                       TIMESTAMPTZ NOT NULL CHECK (rate_timestamp = date_trunc('second', rate_timestamp)),
  fx_rate_id                           UUID,
  remaining_amount_minor               BIGINT NOT NULL CHECK (remaining_amount_minor BETWEEN 0 AND 1000000000000000000),
  remaining_carrying_base_amount_minor BIGINT NOT NULL
    CHECK (remaining_carrying_base_amount_minor BETWEEN 0 AND 1000000000000000000),
  credit_date                          DATE NOT NULL,
  intent_sha256                        TEXT NOT NULL CHECK (intent_sha256 ~ '^[0-9a-f]{64}$'),
  business_transaction_id              UUID NOT NULL,
  created_by                           UUID NOT NULL REFERENCES users (id),
  created_at                           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- R-93: the credit is an accounting SOURCE in its own right, not a tail on
  -- an allocation entry.
  accounting_source_type               TEXT NOT NULL GENERATED ALWAYS AS ('customer_credit') STORED,
  binding_source_id                    UUID NOT NULL,
  PRIMARY KEY (business_id, id),
  CONSTRAINT customer_credits_customer_uq UNIQUE (business_id, id, customer_id, currency_code),
  CONSTRAINT customer_credits_binding_identity_ck CHECK (binding_source_id = id),
  CONSTRAINT customer_credits_remaining_ck CHECK (remaining_amount_minor <= original_amount_minor),
  -- g(0) = 0 and g(r > 0) >= 1, so the two halves reach zero TOGETHER and
  -- neither can be zero while the other is not. The full identity
  -- `remaining_carrying = g(original, original_carrying, remaining)` is proved
  -- by `customer_credit_verify` at COMMIT; this is the half a row CHECK can
  -- state without calling a function.
  CONSTRAINT customer_credits_remaining_pair_ck
    CHECK ((remaining_amount_minor = 0) = (remaining_carrying_base_amount_minor = 0)),
  CONSTRAINT customer_credits_rate_ck
    CHECK ((rate_source = 'base') = (fx_rate_id IS NULL AND credit_to_base_rate = 1)),
  CONSTRAINT customer_credits_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT customer_credits_customer_fk FOREIGN KEY (business_id, customer_id) REFERENCES customers (business_id, id) ON DELETE RESTRICT,
  -- Four columns: business, customer AND currency in one edge, so a credit can
  -- never be born from another customer's payment or in a currency the payment
  -- was not in. It is also what makes R-87's closure a sum of commensurable
  -- quantities.
  CONSTRAINT customer_credits_origin_fk
    FOREIGN KEY (business_id, origin_payment_id, customer_id, currency_code)
    REFERENCES payments (business_id, id, customer_id, currency_code) ON DELETE RESTRICT,
  CONSTRAINT customer_credits_currency_fk FOREIGN KEY (currency_code) REFERENCES currencies (code),
  CONSTRAINT customer_credits_fx_rate_fk FOREIGN KEY (business_id, fx_rate_id) REFERENCES accounting_fx_rates (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT customer_credits_binding_fk
    FOREIGN KEY (business_id, accounting_source_type, binding_source_id)
    REFERENCES accounting_source_bindings (business_id, source_type, source_id)
    DEFERRABLE INITIALLY DEFERRED
);
REVOKE ALL ON customer_credits FROM PUBLIC;

CREATE INDEX customer_credits_customer_idx ON customer_credits (business_id, customer_id, credit_date, id);
CREATE INDEX customer_credits_origin_idx ON customer_credits (business_id, origin_payment_id);

-- The second accounting source: the exact mirror of
-- `supplier_credit_allocations` (`0067:409-453`).
CREATE TABLE customer_credit_applications (
  tenant_id                            UUID NOT NULL,
  business_id                          UUID NOT NULL,
  id                                   UUID NOT NULL,
  customer_id                          UUID NOT NULL,
  credit_id                            UUID NOT NULL,
  invoice_id                           UUID NOT NULL,
  application_date                     DATE NOT NULL,
  credit_currency                      CHAR(3) NOT NULL,
  credit_amount_consumed_minor         BIGINT NOT NULL CHECK (credit_amount_consumed_minor BETWEEN 1 AND 1000000000000000000),
  credit_to_base_rate                  NUMERIC(20,10) NOT NULL
    CHECK (credit_to_base_rate > 0 AND credit_to_base_rate = trunc(credit_to_base_rate, 10)),
  credit_remaining_before_minor        BIGINT NOT NULL CHECK (credit_remaining_before_minor BETWEEN 1 AND 1000000000000000000),
  credit_carrying_base_released_minor  BIGINT NOT NULL
    CHECK (credit_carrying_base_released_minor BETWEEN 0 AND 1000000000000000000),
  credit_dust_base_minor               BIGINT NOT NULL CHECK (credit_dust_base_minor BETWEEN -1000000000000000000 AND 1000000000000000000),
  invoice_currency                     CHAR(3) NOT NULL,
  invoice_amount_applied_minor         BIGINT NOT NULL CHECK (invoice_amount_applied_minor BETWEEN 1 AND 1000000000000000000),
  invoice_historical_to_base_rate      NUMERIC(20,10) NOT NULL
    CHECK (invoice_historical_to_base_rate > 0 AND invoice_historical_to_base_rate = trunc(invoice_historical_to_base_rate, 10)),
  ar_released_before_txn_minor         BIGINT NOT NULL CHECK (ar_released_before_txn_minor BETWEEN 0 AND 1000000000000000000),
  invoice_carrying_base_released_minor BIGINT NOT NULL CHECK (invoice_carrying_base_released_minor BETWEEN 0 AND 1000000000000000000),
  ar_dust_base_minor                   BIGINT NOT NULL CHECK (ar_dust_base_minor BETWEEN -1000000000000000000 AND 1000000000000000000),
  realized_fx_gain_loss_minor          BIGINT NOT NULL CHECK (realized_fx_gain_loss_minor BETWEEN -1000000000000000000 AND 1000000000000000000),
  intent_sha256                        TEXT NOT NULL CHECK (intent_sha256 ~ '^[0-9a-f]{64}$'),
  business_transaction_id              UUID NOT NULL,
  created_by                           UUID NOT NULL REFERENCES users (id),
  created_at                           TIMESTAMPTZ NOT NULL DEFAULT now(),
  accounting_source_type               TEXT NOT NULL GENERATED ALWAYS AS ('customer_credit_application') STORED,
  binding_source_id                    UUID NOT NULL,
  PRIMARY KEY (business_id, id),
  -- The credit-side level uniqueness, `0067:435` exactly.
  CONSTRAINT customer_credit_applications_level_uq UNIQUE (business_id, credit_id, credit_remaining_before_minor),
  -- R-88 again, on the invoice side, with the same standing: a fast
  -- per-relation backstop whose cross-relation half is
  -- `invoice_settlement_verify`'s.
  CONSTRAINT customer_credit_applications_invoice_level_uq UNIQUE (business_id, invoice_id, ar_released_before_txn_minor),
  CONSTRAINT customer_credit_applications_consumed_ck
    CHECK (credit_amount_consumed_minor <= credit_remaining_before_minor),
  CONSTRAINT customer_credit_applications_realized_ck
    CHECK (realized_fx_gain_loss_minor = credit_carrying_base_released_minor - invoice_carrying_base_released_minor),
  CONSTRAINT customer_credit_applications_same_currency_ck
    CHECK (credit_currency <> invoice_currency OR credit_amount_consumed_minor = invoice_amount_applied_minor),
  CONSTRAINT customer_credit_applications_binding_identity_ck CHECK (binding_source_id = id),
  CONSTRAINT customer_credit_applications_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT customer_credit_applications_credit_fk
    FOREIGN KEY (business_id, credit_id, customer_id, credit_currency)
    REFERENCES customer_credits (business_id, id, customer_id, currency_code) ON DELETE RESTRICT,
  -- R-84 DEPARTURE A, the same edge and the same deferral as on
  -- `payment_allocations`: the existing `invoices (business_id, id)` primary
  -- key, with the customer identity pin and the walk-in law carried by
  -- `invoice_settlement_verify` until a Tech Lead ruling allows the
  -- `UNIQUE (business_id, id, customer_id)` that `0067:274` is the precedent
  -- for.
  CONSTRAINT customer_credit_applications_invoice_fk
    FOREIGN KEY (business_id, invoice_id) REFERENCES invoices (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT customer_credit_applications_binding_fk
    FOREIGN KEY (business_id, accounting_source_type, binding_source_id)
    REFERENCES accounting_source_bindings (business_id, source_type, source_id)
    DEFERRABLE INITIALLY DEFERRED
);
REVOKE ALL ON customer_credit_applications FROM PUBLIC;

CREATE INDEX customer_credit_applications_invoice_idx ON customer_credit_applications (business_id, invoice_id);
CREATE INDEX customer_credit_applications_credit_idx ON customer_credit_applications (business_id, credit_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Row security and grants.
--
-- All four relations are accounting-visible, so each takes the SEVEN-policy
-- set: a `tenant_membership` policy, four `AS RESTRICTIVE` per-command
-- business-isolation policies of which only the `FOR SELECT` one admits the
-- internal principals, a permissive `inventory_internal_read`, and
-- `accounting_validator FOR SELECT TO daftar_accounting_internal`
-- (`0067:571-602`, as `0075:442-458` writes the same set on `invoices`).
--
-- The `tenant_membership` body is the DIRECT form. The map says "verbatim from
-- 0067:571-602", which is the correlated `businesses` subselect; every Phase 4
-- relation in the accepted tree uses the direct `tenant_id = ...` form instead
-- (`0075:442-444`, `0077`'s own end-state block at `0077:1810-1817` REQUIRES
-- it and names the correlated form as the one it refuses, `0079:634-636`), and
-- these relations carry `tenant_id NOT NULL`, so the direct form is both the
-- measured house style and strictly cheaper. The POLICY NAME SET — which is
-- what the guards and the end-state blocks read — is identical either way.
--
-- A policy without the matching grant, and a grant without the matching
-- policy, each read ZERO ROWS and let a deferred validator pass loudest
-- (`0077:1247-1251` found exactly that on `invoice_items`), so both halves are
-- written here and both are read back from the live catalogue in 0081-E.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations FORCE ROW LEVEL SECURITY;
ALTER TABLE customer_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_credits FORCE ROW LEVEL SECURITY;
ALTER TABLE customer_credit_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_credit_applications FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_membership ON payments
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON payments AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal')
              OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON payments AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON payments AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON payments AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON payments
  FOR SELECT TO daftar_inventory_internal USING (true);
CREATE POLICY accounting_validator ON payments
  FOR SELECT TO daftar_accounting_internal USING (true);

CREATE POLICY tenant_membership ON payment_allocations
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON payment_allocations AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal')
              OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON payment_allocations AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON payment_allocations AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON payment_allocations AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON payment_allocations
  FOR SELECT TO daftar_inventory_internal USING (true);
CREATE POLICY accounting_validator ON payment_allocations
  FOR SELECT TO daftar_accounting_internal USING (true);

CREATE POLICY tenant_membership ON customer_credits
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON customer_credits AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal')
              OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON customer_credits AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON customer_credits AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON customer_credits AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON customer_credits
  FOR SELECT TO daftar_inventory_internal USING (true);
CREATE POLICY accounting_validator ON customer_credits
  FOR SELECT TO daftar_accounting_internal USING (true);

CREATE POLICY tenant_membership ON customer_credit_applications
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON customer_credit_applications AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal')
              OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON customer_credit_applications AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON customer_credit_applications AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON customer_credit_applications AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON customer_credit_applications
  FOR SELECT TO daftar_inventory_internal USING (true);
CREATE POLICY accounting_validator ON customer_credit_applications
  FOR SELECT TO daftar_accounting_internal USING (true);

-- `daftar_app` READS the four relations (the bound read, the replay and the
-- read models) and holds NO DML at all: every write goes through a routine
-- whose authority was checked (P4-AL-38). The inventory principal inserts and
-- reads them and holds exactly the two column UPDATEs R-90's one writer
-- needs. The accounting principal reads what its validators are judged on —
-- a validator that cannot read its source row passes vacuously.
GRANT SELECT ON payments, payment_allocations, customer_credits, customer_credit_applications TO daftar_app;
GRANT SELECT, INSERT ON payments, payment_allocations, customer_credits, customer_credit_applications TO daftar_inventory_internal;
GRANT UPDATE (remaining_amount_minor, remaining_carrying_base_amount_minor) ON customer_credits TO daftar_inventory_internal;
GRANT SELECT ON payments, payment_allocations, customer_credits, customer_credit_applications TO daftar_accounting_internal;

-- THE ROW-LOCK ACL, AND NOTHING ELSE. PostgreSQL requires, for a locking
-- clause, SELECT **plus one of** UPDATE/DELETE/TRUNCATE on the locked table —
-- SELECT alone raises `permission denied for table …` before any body logic
-- runs. The two SECURITY DEFINER routines below, owned by
-- `daftar_inventory_internal`, take five such locks:
--
--   `0081:1987`  invoices        FOR UPDATE  (`customer_collect_payment`, the
--                                             cap lock, in id order)
--   `0081:2014`  customers       FOR SHARE   (lock step 2b)
--   `0081:2024`  payment_methods FOR SHARE   (lock step 2c)
--   `0081:2299`  invoices        FOR UPDATE  (`customer_apply_credit`, its cap lock)
--   `0081:2345`  customers       FOR SHARE   (`customer_apply_credit`)
--
-- `0075:495` already supplies the SELECT half for `invoices` and `customers`;
-- the locking half is what was missing, and only for those two.
-- `payment_methods` needs nothing: `0067:648-650` already holds a column
-- UPDATE on it. `customer_credits` (locked FOR UPDATE at `0081:2321`) is
-- covered by `0081:617` above. Both were measured on a live cluster, not
-- assumed.
--
-- The privilege exists SOLELY to satisfy that ACL. NEITHER ROUTINE ISSUES ANY
-- `UPDATE` ON EITHER TABLE — every `UPDATE` token in either body is the word
-- inside a `FOR UPDATE` clause, and the only DML they carry is INSERT
-- (`payments`, `payment_allocations`, `customer_credits`,
-- `customer_credit_applications`, `audit_events`, `outbox_events`). A
-- permanent assertion holds that true:
-- `tests/guards/p4s4-settlement-surface-laws.test.ts`.
--
-- So it is column-level and ONE column each — the narrowest list the ACL
-- accepts, since PostgreSQL honours a locking clause on the strength of
-- UPDATE on ANY single column — and never a table-level UPDATE, DELETE or
-- TRUNCATE. `status` on both: a column an UPDATE could in principle touch, so
-- the privilege is not a fiction, and on both tables any UPDATE is bounded by
-- a guard this role cannot lift. `invoices_lifecycle_guard()` (`0075:546`,
-- trigger at `0075:637`) advances the status draft → open → void and refuses
-- anything else; `customers_revision_guard()` (`0075:516`, trigger at
-- `0075:635`) bounds a customer revision. The role owns the guard FUNCTIONS
-- but NOT the TABLES — `0075:642-647` alters only functions, and the tables
-- stay with the migrator — so it cannot `ALTER TABLE … DISABLE TRIGGER` them
-- ("must be owner of table invoices").
GRANT UPDATE (status) ON invoices TO daftar_inventory_internal;
GRANT UPDATE (status) ON customers TO daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. The inventory bracket. Every function below is created while the
--    migrator owns it, PUBLIC's EXECUTE revoked and its trigger installed (a
--    non-superuser migrator must still hold EXECUTE to create a trigger on
--    it), then handed to the internal principal — the `0067:658-664` order.
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;

-- (a) The verification helpers. No grantee, not triggers in themselves: each
--     is PERFORMed by the deferred value guards below, because the
--     application wrapper computes the plan and the DEFERRED CONSTRAINT
--     TRIGGER on the table is what actually refuses the row
--     ([[a wrapper is not an invariant]]).

-- R-83 over every reducer of the invoice, plus the two laws R-84 (Departure A)
-- moves onto this function and the two identities the contract makes it carry.
--
-- THE ARITHMETIC IS REUSED, NEVER RE-IMPLEMENTED (R-81). This is the first
-- call site of `supplier_ap_release`: the name is HISTORICAL — P3-S6 created it
-- for the accounts-payable side — and the arithmetic is GENERAL. It is
-- IMMUTABLE, takes four plain BIGINTs, reads no table and contains nothing
-- supplier-specific whatever: `rel(B, T, X, a) = HALF_EVEN(B(X+a), T) -
-- HALF_EVEN(B·X, T)` is the Tech Lead's `R(X+a) - R(X)` and is the same
-- function on a receivable as on a payable. The same holds for
-- `supplier_convert_base` (the 0043 conversion law) and
-- `supplier_credit_remaining_carrying` (the `g` of a remaining pair). A second
-- body of any of them would be a second financial truth, so this file writes
-- none and calls these.
CREATE OR REPLACE FUNCTION invoice_settlement_verify(p_business_id UUID, p_invoice_id UUID) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_i        RECORD;
  v_settle   TEXT;
  v_bad      BIGINT;
  v_sum      NUMERIC;
  v_rel      NUMERIC;
  v_payment  UUID;
  v_credit   UUID;
BEGIN
  SELECT i.customer_id, i.status, i.total_txn_minor, i.total_base_minor INTO v_i
  FROM invoices i WHERE i.business_id = p_business_id AND i.id = p_invoice_id;
  IF NOT FOUND OR v_i.total_txn_minor IS NULL OR v_i.total_base_minor IS NULL
     OR v_i.total_txn_minor <= 0 OR v_i.total_base_minor <= 0 THEN
    RAISE EXCEPTION 'invoice_settlement.settlement_inconsistent: a settled invoice needs its own totals' USING ERRCODE = 'P0001';
  END IF;
  -- A draft was never posted and a void document was reversed, so neither has
  -- a receivable a reducer could reduce.
  IF v_i.status <> 'open' THEN
    RAISE EXCEPTION 'invoice_settlement.invoice_state_invalid: only an open invoice is settled' USING ERRCODE = 'P0001';
  END IF;

  -- R-84(b) THE WALK-IN LAW. An invoice with no customer carries NO reducer at
  -- all. This is the law a `UNIQUE (business_id, id, customer_id)` on
  -- `invoices` would have made structural — a NOT NULL child column cannot
  -- match a tuple whose customer is NULL — and which Departure A moves here
  -- until that key is ruled on. `invoices_walkin_no_ar()` (`0075:661-684`) is
  -- the backstop on the journal side; this is the refusal on the document
  -- side, and it comes first because a walk-in invoice must never reach a
  -- chain computation at all.
  IF v_i.customer_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM payment_allocations a WHERE a.business_id = p_business_id AND a.invoice_id = p_invoice_id)
       OR EXISTS (SELECT 1 FROM customer_credit_applications c WHERE c.business_id = p_business_id AND c.invoice_id = p_invoice_id) THEN
      RAISE EXCEPTION 'invoice_settlement.walkin_not_settleable: a walk-in invoice carries no customer and is settled by nothing' USING ERRCODE = 'P0001';
    END IF;
    RETURN;
  END IF;

  -- R-84(a) THE CUSTOMER IDENTITY PIN. Every reducer's customer_id is the
  -- invoice's own. The other half of what the narrower key stops proving.
  IF EXISTS (SELECT 1 FROM payment_allocations a
              WHERE a.business_id = p_business_id AND a.invoice_id = p_invoice_id AND a.customer_id <> v_i.customer_id)
     OR EXISTS (SELECT 1 FROM customer_credit_applications c
                 WHERE c.business_id = p_business_id AND c.invoice_id = p_invoice_id AND c.customer_id <> v_i.customer_id) THEN
    RAISE EXCEPTION 'invoice_settlement.customer_mismatch: an invoice is settled only by its own customer''s payment or credit' USING ERRCODE = 'P0001';
  END IF;

  -- R-89 THE CASH LAW. A cash-settled invoice was paid where it was issued and
  -- the ledger debited `cash` for its whole total (`0077:1457`), so it carries
  -- no receivable and has no chain. The arithmetic refuses it anyway — its
  -- outstanding is 0, so X = T and X + a > T — but a law stated by name is a
  -- law somebody can find.
  SELECT s.settlement_mode INTO v_settle
  FROM invoices i JOIN sales s ON s.business_id = i.business_id AND s.id = i.sale_id
  WHERE i.business_id = p_business_id AND i.id = p_invoice_id;
  IF v_settle = 'cash' THEN
    RAISE EXCEPTION 'invoice_settlement.cash_not_settleable: a cash-settled invoice carries no receivable and is settled by nothing' USING ERRCODE = 'P0001';
  END IF;

  -- THE CHAIN (R-83), a UNION ALL over a SET of reducer relations in the
  -- `purchase_settlement_verify` style (`0067:731-744`), so P4-S5's
  -- `credit_note_applications` and P4-S6's append-only negative reducer each
  -- add one branch rather than rewriting this.
  WITH reducers AS (
    SELECT a.ar_released_before_txn_minor AS x, a.invoice_amount_applied_minor AS amount,
           a.invoice_carrying_base_released_minor AS rel
    FROM payment_allocations a
    WHERE a.business_id = p_business_id AND a.invoice_id = p_invoice_id
    UNION ALL
    SELECT c.ar_released_before_txn_minor, c.invoice_amount_applied_minor, c.invoice_carrying_base_released_minor
    FROM customer_credit_applications c
    WHERE c.business_id = p_business_id AND c.invoice_id = p_invoice_id
  ), chained AS (
    SELECT d.x, d.amount, d.rel,
           coalesce(sum(d.amount) OVER (ORDER BY d.x, d.amount ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS before
    FROM reducers d
  )
  SELECT count(*) FILTER (WHERE CASE WHEN h.x <> h.before OR h.x + h.amount > v_i.total_txn_minor THEN true
                                     ELSE h.rel <> supplier_ap_release(v_i.total_base_minor, v_i.total_txn_minor, h.x, h.amount) END),
         coalesce(sum(h.amount), 0), coalesce(sum(h.rel), 0)
    INTO v_bad, v_sum, v_rel
  FROM chained h;
  -- `h.x <> h.before` is BOTH halves at once: a gap makes X too large and an
  -- overlap makes it too small, and ordering oldest-first by X is what makes
  -- `before` the sum of the amounts genuinely ahead of this row. The
  -- cumulative identity `Sigma rel = HALF_EVEN(B · Sigma amount, T)` is the one
  -- that makes rounding non-additive-safe and is why the last reducer releases
  -- the entire residue and strands nothing.
  IF v_bad > 0 OR v_sum > v_i.total_txn_minor
     OR v_rel <> inventory_half_even(v_i.total_base_minor::numeric * v_sum, v_i.total_txn_minor, 0) THEN
    RAISE EXCEPTION 'invoice_settlement.settlement_inconsistent: the invoice''s reducers do not chain from zero to at most its total' USING ERRCODE = 'P0001';
  END IF;

  -- The two identities the contract makes this function carry as well, each
  -- through the ONE body that states it, so there is no second copy of either
  -- law: the closure of every payment that reduces this invoice, and the
  -- remaining pair of every credit that does.
  FOR v_payment IN SELECT DISTINCT a.payment_id FROM payment_allocations a
                    WHERE a.business_id = p_business_id AND a.invoice_id = p_invoice_id LOOP
    PERFORM payment_closure_verify(p_business_id, v_payment);
  END LOOP;
  FOR v_credit IN SELECT DISTINCT c.credit_id FROM customer_credit_applications c
                   WHERE c.business_id = p_business_id AND c.invoice_id = p_invoice_id LOOP
    PERFORM customer_credit_verify(p_business_id, v_credit);
  END LOOP;
END;
$$;

-- R-87's closure, in the payment's own currency (the coordinator's ruling 1 of
-- 2026-10-04, which struck OQ-4's `Sigma invoice_amount_applied` wording:
-- `invoice_amount_applied_minor` is in the INVOICE's currency and cannot be
-- summed against `amount_minor`, and the accepted trigger `0067:950-955` sums
-- `payment_amount_minor` against `amount_minor` and `payment_base_amount_minor`
-- against `base_amount_minor`).
--
-- The money received is accounted for exactly once, as allocations or as credit
-- or as both, in TWO identities side by side exactly as the accepted trigger
-- states them:
--
--   Sigma payment_amount_minor      + Sigma credit original_amount_minor               = amount_minor
--   Sigma payment_base_amount_minor + Sigma credit original_carrying_base_amount_minor = base_amount_minor
--
-- The base identity is ruling 2: without the created credit's carrying base a
-- pure on-account collection would be UNINSERTABLE, because with no allocation
-- the sum of allocation bases is 0 and `base_amount_minor`'s own
-- `CHECK (BETWEEN 1 AND 10^18)` could never hold. Each term is its OWN single
-- HALF_EVEN of a stored original — a sum of roundings, never one rounding of a
-- sum, so no rounded quotient is an input to the next step (P4-AL-25).
--
-- One body, two call sites — `payments_complete` fires it for every payment
-- (including one with ZERO allocations, which no invoice could reach) and
-- `invoice_settlement_verify` fires it again for every payment that reduces
-- the invoice it is verifying.
CREATE OR REPLACE FUNCTION payment_closure_verify(p_business_id UUID, p_payment_id UUID) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_h        RECORD;
  v_n        BIGINT;
  v_bad      BIGINT;
  v_max      INTEGER;
  v_sum      NUMERIC;
  v_base     NUMERIC;
  v_credit   NUMERIC;
  v_credit_b NUMERIC;
BEGIN
  SELECT h.customer_id, h.currency_code, h.payment_to_base_rate, h.amount_minor, h.base_amount_minor, h.allocation_count INTO v_h
  FROM payments h WHERE h.business_id = p_business_id AND h.id = p_payment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_payment.allocations_invalid: a closed payment must exist' USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*),
         count(*) FILTER (WHERE a.payment_currency <> v_h.currency_code OR a.payment_to_base_rate <> v_h.payment_to_base_rate
                            OR a.customer_id <> v_h.customer_id),
         max(a.line_no), coalesce(sum(a.payment_amount_minor), 0), coalesce(sum(a.payment_base_amount_minor), 0)
    INTO v_n, v_bad, v_max, v_sum, v_base
  FROM payment_allocations a WHERE a.business_id = p_business_id AND a.payment_id = p_payment_id;
  -- Every credit BORN OF THIS PAYMENT, in BOTH units. The four-column origin FK
  -- pins each one's currency to the payment's, so each sum is of commensurable
  -- quantities; `original_amount_minor` and
  -- `original_carrying_base_amount_minor` are the credit AS CREATED and are
  -- immutable, so the closure is a statement about the moment of creation and
  -- is not disturbed by a later consumption of the credit.
  SELECT coalesce(sum(c.original_amount_minor), 0), coalesce(sum(c.original_carrying_base_amount_minor), 0)
    INTO v_credit, v_credit_b
  FROM customer_credits c WHERE c.business_id = p_business_id AND c.origin_payment_id = p_payment_id;
  -- R-87: zero allocations is legal, so `v_n < 1` is NOT a refusal here where
  -- `0067:954` has one, and `max(line_no)` over no rows is NULL rather than 0 —
  -- hence the `nullif`. `line_no` is still 1..n and the count is still
  -- `allocation_count`.
  IF v_n <> v_h.allocation_count
     OR v_max IS DISTINCT FROM nullif(v_h.allocation_count, 0)
     OR v_bad > 0
     OR v_sum + v_credit <> v_h.amount_minor::numeric
     OR v_base + v_credit_b <> v_h.base_amount_minor::numeric THEN
    RAISE EXCEPTION 'customer_payment.allocations_invalid: a payment is exactly the sum of its allocations and the credit it created, in its own currency and rate'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- The credit's own chain and its stored pair: over the credit's consumers
-- ordered by remaining-before DESCENDING, each rb is OA - Sigma earlier c, each
-- release is g(rb) - g(rb - c), the stored remaining is OA - Sigma c, the stored
-- carrying is g OF IT — never of a previous step's already-rounded value — and
-- Sigma release is OB - g(remaining). `supplier_credit_note_verify`
-- (`0067:763-805`) exactly, with S4's one consumer relation; S5's refund adds
-- one UNION ALL branch.
CREATE OR REPLACE FUNCTION customer_credit_verify(p_business_id UUID, p_credit_id UUID) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_c   RECORD;
  v_bad BIGINT;
  v_sum NUMERIC;
  v_rel NUMERIC;
BEGIN
  SELECT c.original_amount_minor, c.original_carrying_base_amount_minor, c.remaining_amount_minor,
         c.remaining_carrying_base_amount_minor INTO v_c
  FROM customer_credits c WHERE c.business_id = p_business_id AND c.id = p_credit_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_credit.consumption_inconsistent: a consumed customer credit must exist' USING ERRCODE = 'P0001';
  END IF;
  WITH consumers AS (
    SELECT a.credit_remaining_before_minor AS rb, a.credit_amount_consumed_minor AS amount,
           a.credit_carrying_base_released_minor AS rel
    FROM customer_credit_applications a
    WHERE a.business_id = p_business_id AND a.credit_id = p_credit_id
  ), chained AS (
    SELECT d.rb, d.amount, d.rel,
           coalesce(sum(d.amount) OVER (ORDER BY d.rb DESC, d.amount ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS before
    FROM consumers d
  )
  SELECT count(*) FILTER (WHERE CASE WHEN h.rb <> v_c.original_amount_minor - h.before OR h.amount > h.rb THEN true
                                     ELSE h.rel <> supplier_credit_remaining_carrying(v_c.original_amount_minor,
                                                                                      v_c.original_carrying_base_amount_minor, h.rb)
                                                   - supplier_credit_remaining_carrying(v_c.original_amount_minor,
                                                                                        v_c.original_carrying_base_amount_minor,
                                                                                        h.rb - h.amount) END),
         coalesce(sum(h.amount), 0), coalesce(sum(h.rel), 0)
    INTO v_bad, v_sum, v_rel
  FROM chained h;
  IF v_bad > 0 OR v_sum > v_c.original_amount_minor
     OR v_c.remaining_amount_minor::numeric <> v_c.original_amount_minor - v_sum
     OR v_c.remaining_carrying_base_amount_minor
        <> supplier_credit_remaining_carrying(v_c.original_amount_minor, v_c.original_carrying_base_amount_minor,
                                              v_c.remaining_amount_minor)
     OR v_rel <> v_c.original_carrying_base_amount_minor::numeric - v_c.remaining_carrying_base_amount_minor THEN
    RAISE EXCEPTION 'customer_credit.consumption_inconsistent: the credit''s consumers do not chain from its original to its stored remaining values'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- (b) The guard functions. Each table has a BEFORE INSERT OR UPDATE OR DELETE
--     guard that JUDGES THE INSERT as well as refusing change, and each
--     deferred value guard is AFTER INSERT (the `0063 R-34` layering).

-- payments: inserted only by its own command's transaction, through an active
-- method whose account it names, for an active customer, to an eligible
-- account (`0067:900-933`); never changed or deleted.
CREATE OR REPLACE FUNCTION payment_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_active  BOOLEAN;
  v_account UUID;
  v_status  TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'customer_payment.immutable: a customer payment is never changed or deleted' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.created_at IS DISTINCT FROM now() OR NEW.business_transaction_id IS DISTINCT FROM inventory_business_transaction_id() THEN
    RAISE EXCEPTION 'customer_payment.immutable: a customer payment is written only by its own command''s transaction' USING ERRCODE = 'P0001';
  END IF;
  SELECT m.is_active, m.posting_account_id INTO v_active, v_account
  FROM payment_methods m WHERE m.business_id = NEW.business_id AND m.id = NEW.payment_method_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment_method.not_found: a customer payment names a payment method of its business' USING ERRCODE = 'P0001';
  END IF;
  IF NOT v_active THEN
    RAISE EXCEPTION 'payment_method.inactive: a customer payment is collected through an active payment method' USING ERRCODE = 'P0001';
  END IF;
  -- R-85's bound, stated where it bites: the row PINS its own posting account
  -- through the three-column FK, and this re-reads the method's current one, so
  -- a payment never posts to an account the method does not carry AT THE TIME
  -- IT IS WRITTEN. What Departure B leaves open is only that a LATER payment
  -- could post to a different account than this one; no existing row moves.
  IF v_account IS DISTINCT FROM NEW.posting_account_id THEN
    RAISE EXCEPTION 'payment_method.state_invalid: a customer payment posts to its method''s posting account' USING ERRCODE = 'P0001';
  END IF;
  IF accounting_settlement_account_eligibility(NEW.business_id, NEW.posting_account_id) IS DISTINCT FROM 'eligible' THEN
    RAISE EXCEPTION 'payment_method.posting_account_ineligible: a customer payment posts to an active settlement asset account' USING ERRCODE = 'P0001';
  END IF;
  SELECT c.status INTO v_status FROM customers c WHERE c.business_id = NEW.business_id AND c.id = NEW.customer_id;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'customer_payment.customer_inactive: a customer payment is collected from an active customer' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- At COMMIT: R-87's closure, through the one body that states it.
CREATE OR REPLACE FUNCTION payment_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM payment_closure_verify(NEW.business_id, NEW.id);
  RETURN NULL;
END;
$$;

-- payment_allocations: joins only a payment created by this very transaction
-- (`0063 R-36`, `0067:963-983`); never changed or deleted.
CREATE OR REPLACE FUNCTION payment_allocation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_created TIMESTAMPTZ;
  v_trace   UUID;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'customer_payment.immutable: a payment allocation is never changed or deleted' USING ERRCODE = 'P0001';
  END IF;
  SELECT h.created_at, h.business_transaction_id INTO v_created, v_trace
  FROM payments h WHERE h.business_id = NEW.business_id AND h.id = NEW.payment_id;
  IF NOT FOUND OR v_created IS DISTINCT FROM now() OR v_trace IS DISTINCT FROM inventory_business_transaction_id()
     OR NEW.created_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'customer_payment.immutable: an allocation joins only a payment created by the same transaction' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- At COMMIT (`0067:987-1045`): the invoice is open and settleable; the
-- allocation carries the invoice and payment snapshots; the release, the dust,
-- the payment base and the realized FX are RECOMPUTED and compared; conv(a) > 0;
-- the residue law; then the invoice chain, which is also where R-84's two laws
-- are judged.
CREATE OR REPLACE FUNCTION payment_allocation_value_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_i        RECORD;
  v_h        RECORD;
  v_base_ccy TEXT;
  v_et       INTEGER;
  v_ep       INTEGER;
  v_eb       INTEGER;
  v_rel      BIGINT;
  v_conv     BIGINT;
  v_pb       BIGINT;
BEGIN
  SELECT i.status, i.currency_code, i.total_txn_minor, i.total_base_minor, i.source_to_base_rate INTO v_i
  FROM invoices i WHERE i.business_id = NEW.business_id AND i.id = NEW.invoice_id;
  IF v_i.status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'customer_payment.invoice_state_invalid: only an open invoice is settled' USING ERRCODE = 'P0001';
  END IF;
  SELECT h.currency_code, h.payment_to_base_rate INTO v_h
  FROM payments h WHERE h.business_id = NEW.business_id AND h.id = NEW.payment_id;
  SELECT b.base_currency INTO v_base_ccy FROM businesses b WHERE b.id = NEW.business_id;
  SELECT c.minor_units INTO v_et FROM currencies c WHERE c.code = v_i.currency_code::text;
  SELECT c.minor_units INTO v_ep FROM currencies c WHERE c.code = v_h.currency_code::text;
  SELECT c.minor_units INTO v_eb FROM currencies c WHERE c.code = v_base_ccy;
  IF v_i.total_txn_minor IS NULL OR v_i.total_base_minor IS NULL OR v_h.currency_code IS NULL
     OR v_et IS NULL OR v_ep IS NULL OR v_eb IS NULL
     OR NEW.ar_released_before_txn_minor + NEW.invoice_amount_applied_minor > v_i.total_txn_minor THEN
    RAISE EXCEPTION 'customer_payment.settlement_inconsistent: an allocation settles at most its open invoice''s total' USING ERRCODE = 'P0001';
  END IF;
  v_rel  := supplier_ap_release(v_i.total_base_minor, v_i.total_txn_minor, NEW.ar_released_before_txn_minor,
                                NEW.invoice_amount_applied_minor);
  v_conv := supplier_convert_base(NEW.invoice_amount_applied_minor, v_i.source_to_base_rate, v_et, v_eb);
  v_pb   := supplier_convert_base(NEW.payment_amount_minor, v_h.payment_to_base_rate, v_ep, v_eb);
  -- Judged FIRST, before the residue law (`0067:1019-1029` order).
  IF v_conv = 0 OR v_pb = 0 THEN
    RAISE EXCEPTION 'customer_payment.amount_below_base_unit: an applied amount converts to at least one base unit' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.ar_released_before_txn_minor + NEW.invoice_amount_applied_minor < v_i.total_txn_minor
     AND supplier_convert_base(v_i.total_txn_minor - NEW.ar_released_before_txn_minor - NEW.invoice_amount_applied_minor,
                               v_i.source_to_base_rate, v_et, v_eb) = 0 THEN
    RAISE EXCEPTION 'customer_payment.residue_below_base_unit: an allocation leaves its invoice nothing outstanding or an amount converting to at least one base unit'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.invoice_currency IS DISTINCT FROM v_i.currency_code
     OR NEW.invoice_historical_to_base_rate IS DISTINCT FROM v_i.source_to_base_rate
     OR NEW.payment_currency IS DISTINCT FROM v_h.currency_code
     OR NEW.payment_to_base_rate IS DISTINCT FROM v_h.payment_to_base_rate
     OR NEW.invoice_carrying_base_released_minor <> v_rel
     OR NEW.ar_dust_base_minor <> v_rel - v_conv
     OR NEW.payment_base_amount_minor <> v_pb
     OR NEW.realized_fx_gain_loss_minor <> v_pb - v_rel THEN
    RAISE EXCEPTION 'customer_payment.settlement_inconsistent: an allocation''s amounts are not the R-82 amounts of its invoice and payment'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM invoice_settlement_verify(NEW.business_id, NEW.invoice_id);
  RETURN NULL;
END;
$$;

-- customer_credits: born of its own command's transaction with the remaining
-- pair at the original, and thereafter IMMUTABLE except for ONE backed
-- decrement of BOTH remaining values — the `supplier_credit_note_guard`
-- pattern (`0067:1336-1370`), which is what makes R-90's single writer the only
-- way the pair can move.
CREATE OR REPLACE FUNCTION customer_credit_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_n INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'customer_credit.immutable: a customer credit is consumed, never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_at IS DISTINCT FROM now() OR NEW.business_transaction_id IS DISTINCT FROM inventory_business_transaction_id() THEN
      RAISE EXCEPTION 'customer_credit.immutable: a customer credit is written only by its own command''s transaction' USING ERRCODE = 'P0001';
    END IF;
    -- A credit is BORN WHOLE: the remaining pair is the original pair, so the
    -- identity `remaining_carrying = g(remaining)` holds at g(OA) = OB without
    -- a function call, and every later state is one backed decrement away.
    IF NEW.remaining_amount_minor IS DISTINCT FROM NEW.original_amount_minor
       OR NEW.remaining_carrying_base_amount_minor IS DISTINCT FROM NEW.original_carrying_base_amount_minor THEN
      RAISE EXCEPTION 'customer_credit.immutable: a customer credit is born with its remaining pair at its original pair' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.business_id, NEW.id, NEW.customer_id, NEW.origin_payment_id, NEW.currency_code,
      NEW.original_amount_minor, NEW.original_carrying_base_amount_minor, NEW.credit_to_base_rate, NEW.rate_source,
      NEW.rate_timestamp, NEW.fx_rate_id, NEW.credit_date, NEW.intent_sha256, NEW.business_transaction_id,
      NEW.created_by, NEW.created_at, NEW.binding_source_id)
     IS NOT DISTINCT FROM
     (OLD.tenant_id, OLD.business_id, OLD.id, OLD.customer_id, OLD.origin_payment_id, OLD.currency_code,
      OLD.original_amount_minor, OLD.original_carrying_base_amount_minor, OLD.credit_to_base_rate, OLD.rate_source,
      OLD.rate_timestamp, OLD.fx_rate_id, OLD.credit_date, OLD.intent_sha256, OLD.business_transaction_id,
      OLD.created_by, OLD.created_at, OLD.binding_source_id)
     AND NEW.remaining_amount_minor < OLD.remaining_amount_minor
     AND NEW.remaining_carrying_base_amount_minor
         = supplier_credit_remaining_carrying(OLD.original_amount_minor, OLD.original_carrying_base_amount_minor,
                                              NEW.remaining_amount_minor)
  THEN
    -- The BACKING ROW must already exist: this transaction's own application of
    -- exactly this credit, at exactly this level, for exactly these two
    -- decrements. One, never two.
    SELECT count(*) INTO v_n
    FROM customer_credit_applications a
     WHERE a.business_id = OLD.business_id AND a.credit_id = OLD.id
       AND a.credit_remaining_before_minor = OLD.remaining_amount_minor
       AND a.credit_amount_consumed_minor = OLD.remaining_amount_minor - NEW.remaining_amount_minor
       AND a.credit_carrying_base_released_minor = OLD.remaining_carrying_base_amount_minor - NEW.remaining_carrying_base_amount_minor
       AND a.created_at = now() AND a.business_transaction_id = inventory_business_transaction_id();
    IF v_n = 1 THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'customer_credit.immutable: a customer credit changes only by one backed consumption of both remaining values' USING ERRCODE = 'P0001';
END;
$$;

-- customer_credit_applications: inserted now by this transaction; never
-- changed or deleted (its "detail" is the credit decrement).
CREATE OR REPLACE FUNCTION customer_credit_application_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'customer_credit_application.immutable: a customer credit application is never changed or deleted' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.created_at IS DISTINCT FROM now() OR NEW.business_transaction_id IS DISTINCT FROM inventory_business_transaction_id() THEN
    RAISE EXCEPTION 'customer_credit_application.immutable: a customer credit application is written only by its own command''s transaction'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- At COMMIT (`0067:1063-1131`): the AR side as for an allocation; the credit
-- side against the credit's own snapshot and g; neither residue below one base
-- unit; the realized FX cr_rel - rel; then both chains.
CREATE OR REPLACE FUNCTION customer_credit_application_value_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_i        RECORD;
  v_c        RECORD;
  v_base_ccy TEXT;
  v_et       INTEGER;
  v_en       INTEGER;
  v_eb       INTEGER;
  v_rel      BIGINT;
  v_conv     BIGINT;
  v_cr_rel   BIGINT;
  v_cr_conv  BIGINT;
BEGIN
  SELECT i.status, i.currency_code, i.total_txn_minor, i.total_base_minor, i.source_to_base_rate INTO v_i
  FROM invoices i WHERE i.business_id = NEW.business_id AND i.id = NEW.invoice_id;
  IF v_i.status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'customer_credit_application.invoice_state_invalid: a customer credit is applied to an open invoice only' USING ERRCODE = 'P0001';
  END IF;
  SELECT c.currency_code, c.credit_to_base_rate, c.original_amount_minor, c.original_carrying_base_amount_minor INTO v_c
  FROM customer_credits c WHERE c.business_id = NEW.business_id AND c.id = NEW.credit_id;
  SELECT b.base_currency INTO v_base_ccy FROM businesses b WHERE b.id = NEW.business_id;
  SELECT c.minor_units INTO v_et FROM currencies c WHERE c.code = v_i.currency_code::text;
  SELECT c.minor_units INTO v_en FROM currencies c WHERE c.code = v_c.currency_code::text;
  SELECT c.minor_units INTO v_eb FROM currencies c WHERE c.code = v_base_ccy;
  IF v_i.total_txn_minor IS NULL OR v_i.total_base_minor IS NULL OR v_c.currency_code IS NULL
     OR v_et IS NULL OR v_en IS NULL OR v_eb IS NULL
     OR NEW.ar_released_before_txn_minor + NEW.invoice_amount_applied_minor > v_i.total_txn_minor THEN
    RAISE EXCEPTION 'customer_payment.settlement_inconsistent: a credit application settles at most its open invoice''s total' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.credit_remaining_before_minor > v_c.original_amount_minor THEN
    RAISE EXCEPTION 'customer_credit.consumption_inconsistent: a credit application consumes within its credit''s original amount' USING ERRCODE = 'P0001';
  END IF;
  v_rel     := supplier_ap_release(v_i.total_base_minor, v_i.total_txn_minor, NEW.ar_released_before_txn_minor,
                                   NEW.invoice_amount_applied_minor);
  v_conv    := supplier_convert_base(NEW.invoice_amount_applied_minor, v_i.source_to_base_rate, v_et, v_eb);
  v_cr_conv := supplier_convert_base(NEW.credit_amount_consumed_minor, v_c.credit_to_base_rate, v_en, v_eb);
  IF v_conv = 0 OR v_cr_conv = 0 THEN
    RAISE EXCEPTION 'customer_credit_application.amount_below_base_unit: an applied or consumed amount converts to at least one base unit'
      USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.ar_released_before_txn_minor + NEW.invoice_amount_applied_minor < v_i.total_txn_minor
      AND supplier_convert_base(v_i.total_txn_minor - NEW.ar_released_before_txn_minor - NEW.invoice_amount_applied_minor,
                                v_i.source_to_base_rate, v_et, v_eb) = 0)
     OR (NEW.credit_amount_consumed_minor < NEW.credit_remaining_before_minor
         AND supplier_convert_base(NEW.credit_remaining_before_minor - NEW.credit_amount_consumed_minor,
                                   v_c.credit_to_base_rate, v_en, v_eb) = 0) THEN
    RAISE EXCEPTION 'customer_credit_application.residue_below_base_unit: an application leaves its invoice and its credit each nothing or an amount converting to at least one base unit'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.invoice_currency IS DISTINCT FROM v_i.currency_code
     OR NEW.invoice_historical_to_base_rate IS DISTINCT FROM v_i.source_to_base_rate
     OR NEW.invoice_carrying_base_released_minor <> v_rel
     OR NEW.ar_dust_base_minor <> v_rel - v_conv THEN
    RAISE EXCEPTION 'customer_payment.settlement_inconsistent: a credit application''s AR amounts are not the R-82 amounts of its invoice'
      USING ERRCODE = 'P0001';
  END IF;
  -- `g` of the credit's ORIGINAL pair and the current remaining, never of a
  -- previous step's stored remaining carrying (P4-AL-25).
  v_cr_rel := supplier_credit_remaining_carrying(v_c.original_amount_minor, v_c.original_carrying_base_amount_minor,
                                                 NEW.credit_remaining_before_minor)
              - supplier_credit_remaining_carrying(v_c.original_amount_minor, v_c.original_carrying_base_amount_minor,
                                                   NEW.credit_remaining_before_minor - NEW.credit_amount_consumed_minor);
  IF NEW.credit_currency IS DISTINCT FROM v_c.currency_code
     OR NEW.credit_to_base_rate IS DISTINCT FROM v_c.credit_to_base_rate
     OR NEW.credit_carrying_base_released_minor <> v_cr_rel
     OR NEW.credit_dust_base_minor <> v_cr_rel - v_cr_conv
     OR NEW.realized_fx_gain_loss_minor <> v_cr_rel - v_rel THEN
    RAISE EXCEPTION 'customer_credit.consumption_inconsistent: a credit application''s credit amounts are not the R-82 amounts of its credit'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM invoice_settlement_verify(NEW.business_id, NEW.invoice_id);
  PERFORM customer_credit_verify(NEW.business_id, NEW.credit_id);
  RETURN NULL;
END;
$$;

-- (c) R-90: the ONE writer of the remaining pair. Internal-owned DEFINER, no
--     grantee, its first statement a re-read of the transaction's verified
--     assertion — the `supplier_credit_note_consume` shape (`0068:439-480`).
--     It exists because a stock-write table's writer must have an assertion
--     call as its first statement whose arguments call nothing, and an entry
--     routine's consume computes its digest in its arguments.
CREATE OR REPLACE FUNCTION customer_credit_consume(p_credit_id UUID, p_remaining_before BIGINT, p_consumed BIGINT) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor inventory_verified_actor;
  v_rows  INTEGER;
BEGIN
  v_actor := inventory_assertion_current(ARRAY['customer.apply_credit']);
  IF p_credit_id IS NULL OR p_remaining_before IS NULL OR p_consumed IS NULL OR p_consumed <= 0 OR p_consumed > p_remaining_before
     OR NOT EXISTS (SELECT 1 FROM customer_credit_applications a
                     WHERE a.business_id = v_actor.business_id AND a.credit_id = p_credit_id
                       AND a.credit_remaining_before_minor = p_remaining_before AND a.credit_amount_consumed_minor = p_consumed
                       AND a.created_at = now() AND a.business_transaction_id = inventory_business_transaction_id()) THEN
    RAISE EXCEPTION 'inventory.source_type_not_authorized: a customer credit is decremented only for its own application stored by this transaction'
      USING ERRCODE = 'P0001';
  END IF;
  UPDATE customer_credits c
     SET remaining_amount_minor = c.remaining_amount_minor - p_consumed,
         remaining_carrying_base_amount_minor = supplier_credit_remaining_carrying(c.original_amount_minor,
                                                                                   c.original_carrying_base_amount_minor,
                                                                                   c.remaining_amount_minor - p_consumed)
   WHERE c.business_id = v_actor.business_id AND c.id = p_credit_id AND c.remaining_amount_minor = p_remaining_before;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'customer_credit.consumption_inconsistent: the credit no longer holds the remaining amount its application read' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION invoice_settlement_verify(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION payment_closure_verify(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION customer_credit_verify(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION payment_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION payment_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION payment_allocation_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION payment_allocation_value_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION customer_credit_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION customer_credit_application_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION customer_credit_application_value_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION customer_credit_consume(UUID, BIGINT, BIGINT) FROM PUBLIC;

-- ── The triggers: R-34 events, no WHEN, no column list ──────────────────
--
-- R-83's enforcement is the two `CREATE CONSTRAINT TRIGGER ... DEFERRABLE
-- INITIALLY DEFERRED` below — the same class the purchase chain already relies
-- on (`0067:1289-1292`). It is the point of the whole design: the command
-- computes the plan, and the DEFERRED CONSTRAINT TRIGGER on the table is what
-- refuses the row, so two writers that computed from the same outstanding
-- overlap and are refused at COMMIT even if a lock were missing.
CREATE TRIGGER payments_guard
  BEFORE INSERT OR UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION payment_guard();
CREATE CONSTRAINT TRIGGER payments_complete
  AFTER INSERT ON payments DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION payment_complete();
CREATE TRIGGER payment_allocations_guard
  BEFORE INSERT OR UPDATE OR DELETE ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION payment_allocation_guard();
CREATE CONSTRAINT TRIGGER payment_allocations_value_complete
  AFTER INSERT ON payment_allocations DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION payment_allocation_value_complete();
CREATE TRIGGER customer_credits_guard
  BEFORE INSERT OR UPDATE OR DELETE ON customer_credits
  FOR EACH ROW EXECUTE FUNCTION customer_credit_guard();
CREATE TRIGGER customer_credit_applications_guard
  BEFORE INSERT OR UPDATE OR DELETE ON customer_credit_applications
  FOR EACH ROW EXECUTE FUNCTION customer_credit_application_guard();
CREATE CONSTRAINT TRIGGER customer_credit_applications_value_complete
  AFTER INSERT ON customer_credit_applications DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION customer_credit_application_value_complete();

-- (d) The ownership transfer (after the ACL and the triggers).
ALTER FUNCTION invoice_settlement_verify(UUID, UUID) OWNER TO daftar_inventory_internal;
ALTER FUNCTION payment_closure_verify(UUID, UUID) OWNER TO daftar_inventory_internal;
ALTER FUNCTION customer_credit_verify(UUID, UUID) OWNER TO daftar_inventory_internal;
ALTER FUNCTION payment_guard() OWNER TO daftar_inventory_internal;
ALTER FUNCTION payment_complete() OWNER TO daftar_inventory_internal;
ALTER FUNCTION payment_allocation_guard() OWNER TO daftar_inventory_internal;
ALTER FUNCTION payment_allocation_value_complete() OWNER TO daftar_inventory_internal;
ALTER FUNCTION customer_credit_guard() OWNER TO daftar_inventory_internal;
ALTER FUNCTION customer_credit_application_guard() OWNER TO daftar_inventory_internal;
ALTER FUNCTION customer_credit_application_value_complete() OWNER TO daftar_inventory_internal;
ALTER FUNCTION customer_credit_consume(UUID, BIGINT, BIGINT) OWNER TO daftar_inventory_internal;

-- Hand back the ownership-transfer authority of this section.
REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. The reader-of-record, replaced by the migrator — the accepted
--    extension-point manner (`0067:1379-1424`, the `0080` shape). Same
--    signature, owner, STABLE, SECURITY INVOKER, pinned path and ACL, which
--    `CREATE OR REPLACE` keeps and 0081-E reads back.
--
--    SEAM S-P4-03 CLOSES HERE. `0080` corrected the cash-invoice defect and
--    said in its own body that it subtracts nothing because nothing that
--    settles an invoice existed yet; this file creates two such relations, so
--    the seam guard is red until this body reads both by name. The three
--    readers above it — `invoice_settlement_state`, `customer_ar_outstanding`,
--    `customer_ar_aging` — need NO CHANGE AT ALL, because they compose over
--    this one (`0075:762, 780-786, 808-816`). That is the whole value of the
--    seam, and 0081-E proves they came out byte-identical.
--
--    The subtraction is a UNION ALL over a SET of reducer relations, not two
--    hard-coded sums, so P4-S5 appends one branch rather than rewriting it.
--    `paid_base` is Sigma of the CARRYING RELEASED, never a conversion of the
--    paid transaction amount: the cumulative identity
--    `Sigma rel = HALF_EVEN(B · Sigma a, T)` is what makes
--    `outstanding_base = 0` EXACTLY when the last reducer closes the invoice,
--    and a per-step conversion would strand a minor unit there.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION invoice_outstanding(p_business_id UUID, p_invoice_id UUID)
RETURNS TABLE (paid_txn_minor BIGINT, paid_base_minor BIGINT, outstanding_txn_minor BIGINT, outstanding_base_minor BIGINT)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_status     TEXT;
  v_settle     TEXT;
  v_total_txn  BIGINT;
  v_total_base BIGINT;
  v_paid_txn   BIGINT;
  v_paid_base  BIGINT;
BEGIN
  SELECT i.status, s.settlement_mode, i.total_txn_minor, i.total_base_minor
    INTO v_status, v_settle, v_total_txn, v_total_base
    FROM public.invoices i
    JOIN public.sales s ON s.business_id = i.business_id AND s.id = i.sale_id
   WHERE i.business_id = p_business_id AND i.id = p_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice.not_found: the invoice does not exist in this business' USING ERRCODE = 'P0001';
  END IF;
  -- A draft was never posted and a void document was reversed, so neither
  -- owes anything.
  IF v_status <> 'open' THEN
    RETURN QUERY SELECT 0::BIGINT, 0::BIGINT, 0::BIGINT, 0::BIGINT;
    RETURN;
  END IF;
  -- `0080`, unchanged: a CASH-settled invoice was paid where it was issued, the
  -- ledger debited `cash` for its whole total and never touched the receivable
  -- account (`0077:1457`), so the customer owes nothing on it.
  IF v_settle = 'cash' THEN
    RETURN QUERY SELECT v_total_txn, v_total_base, 0::BIGINT, 0::BIGINT;
    RETURN;
  END IF;
  SELECT coalesce(pg_catalog.sum(r.amount), 0)::BIGINT, coalesce(pg_catalog.sum(r.rel), 0)::BIGINT
    INTO v_paid_txn, v_paid_base
    FROM (
      SELECT a.invoice_amount_applied_minor AS amount, a.invoice_carrying_base_released_minor AS rel
        FROM public.payment_allocations a
       WHERE a.business_id = p_business_id AND a.invoice_id = p_invoice_id
      UNION ALL
      SELECT c.invoice_amount_applied_minor, c.invoice_carrying_base_released_minor
        FROM public.customer_credit_applications c
       WHERE c.business_id = p_business_id AND c.invoice_id = p_invoice_id
    ) r;
  RETURN QUERY SELECT v_paid_txn, v_paid_base, v_total_txn - v_paid_txn, v_total_base - v_paid_base;
END;
$$;
COMMENT ON FUNCTION invoice_outstanding(UUID, UUID) IS
  'P4-S1, replaced by P4-S4 (0080 then 0081; P4-AL-05, P4-AL-07, seam S-P4-03). The reader-of-record of an invoice paid and outstanding amount, which is refused as a stored column by P4-AL-06: the total minus the sum of invoice_amount_applied_minor over its payment allocations and its customer credit applications, with the paid base the sum of invoice_carrying_base_released_minor so that the base closes to zero exactly when the last reducer closes the invoice. A cash-settled invoice reports paid = total and outstanding = 0 (0080). A draft or void document reports zeros. INVOKER, reads through the caller''s row security, writes nothing. EXECUTE: daftar_app and daftar_inventory_internal. Replaced again by the slice that adds a reducer relation.';

-- ─────────────────────────────────────────────────────────────────────────
-- 5. The accounting side. Every function is owned by
--    daftar_accounting_internal, DEFINER, pinned, PUBLIC revoked, inside the
--    accounting CREATE bracket (`0058:40-71`, the `0067:1907-1911` order).
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;

-- (a) The reversal guard, replaced BY ITS OWNER: `0077`'s body byte for byte
--     with `'customer_payment_allocation'`, `'customer_credit_application'`
--     and `'customer_credit'` APPENDED to the always-refused list, in that
--     order. Appended, not inserted, because `0067:2790`, `0072:903` and
--     `0077` each assert a SUBSTRING of this list and a reordering would
--     make a frozen migration's own end-state claim read false against the
--     body the database then holds.
--
--     P4-AL-47 and the deferred seam S-P4-02: a registration and this list
--     move together, in the same file. All three new types go in the plain
--     refusal arm and none gets a `purchase`-style escape, because this slice
--     ships no reversal document for any of them — P4-S6 does, and it will
--     add the paired clause when it ships the writer.
SET LOCAL ROLE daftar_accounting_internal;

CREATE OR REPLACE FUNCTION accounting_reversals_20_domain_source_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_ob UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM journal_entries je
              WHERE je.business_id = NEW.business_id AND je.id = NEW.original_entry_id
                AND (je.source_type IN ('inventory_adjustment', 'inventory_opening', 'negative_inventory_cost_adjustment', 'supplier_return', 'supplier_payment', 'supplier_credit_allocation', 'supplier_refund', 'purchase_residue_write_off', 'sale', 'invoice', 'customer_payment_allocation', 'customer_credit_application', 'customer_credit')
                     OR (je.source_type = 'purchase'
                         AND NOT EXISTS (SELECT 1 FROM purchase_reversals r
                                          WHERE r.business_id = NEW.business_id AND r.id = je.source_id
                                            AND r.original_entry_id = NEW.original_entry_id)))) THEN
    RAISE EXCEPTION 'accounting.reversal_source_domain_owned: an entry owned by the inventory domain is not reversed by the generic reversal workflow'
      USING ERRCODE = 'P0001';
  END IF;
  -- R-13: the opening balance's ROW, not the workflow key. The frozen
  -- reversal routine already holds `businesses` FOR SHARE here; the advisory
  -- key would invert R-1's key -> businesses order.
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

-- (b) The two deferred completeness validators. Each is a
--     `CREATE CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` on
--     `journal_entries`, fired `WHEN (NEW.source_type = '<type>')`, and each
--     refuses an entry whose lines are not EXACTLY the R-82 lines of its one
--     source row. Lines are compared as a MULTISET OF SIGNATURES — account
--     (the stored posting account as `posting`, else the system key), side,
--     base amount, transaction currency and amount, rate, rate source, rate
--     instant, warehouse (none) and branch — the `0067:2016-2027` shape.
--
--     THE LINE SHAPES (R-82, the coordinator's OQ-9 and its ruling 3 of
--     2026-10-04). The dust is a SECOND LINE ON THE SAME ACCOUNT AS ITS OWN
--     PRINCIPAL, in base currency at rate 1, signed by the sign of the dust,
--     present only when it is non-zero. There is no `rounding_difference`
--     column, no 6100 line and no write-off anywhere in this path. A credit
--     application therefore carries TWO dusts on TWO accounts, exactly as
--     `apLines` and `creditLines` do on the supplier side
--     (`packages/inventory/src/supplier-settlement.ts:259-280`):
--     `ar_dust_base_minor` sits on `accounts_receivable` and
--     `credit_dust_base_minor` on `customer_credit_liability` (2210).
--     The remaining imbalance is REALIZED FX and goes to `fx_gain` (4900) or
--     `fx_loss` (6900) only — never 6100, never 6200, never tax. The sides are
--     the supplier shapes MIRRORED: a receivable is CREDITED as it releases
--     where a payable is debited, so a positive realized figure is a GAIN here
--     and a loss there.
CREATE OR REPLACE FUNCTION accounting_customer_payment_allocation_entry_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_a        RECORD;
  v_h        RECORD;
  v_i        RECORD;
  v_base_ccy TEXT;
  v_one      TEXT;
  v_isnap    TEXT;
  v_hsnap    TEXT;
  v_base     TEXT;
  v_conv     BIGINT;
  v_nlines   BIGINT;
  v_expected TEXT[];
  v_actual   TEXT[];
BEGIN
  SELECT a.payment_id, a.invoice_id, a.payment_currency, a.payment_amount_minor, a.payment_base_amount_minor, a.invoice_currency,
         a.invoice_amount_applied_minor, a.invoice_carrying_base_released_minor, a.ar_dust_base_minor, a.realized_fx_gain_loss_minor
    INTO v_a
  FROM payment_allocations a
  WHERE a.business_id = NEW.business_id AND a.binding_source_id = NEW.source_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accounting.selling_detail_missing: a customer payment allocation entry must be registered by its allocation in the same transaction'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT h.payment_date, h.posting_account_id, h.payment_to_base_rate, h.rate_source, h.rate_timestamp INTO v_h
  FROM payments h WHERE h.business_id = NEW.business_id AND h.id = v_a.payment_id;
  SELECT i.branch_id, i.source_to_base_rate, i.rate_source, i.rate_timestamp INTO v_i
  FROM invoices i WHERE i.business_id = NEW.business_id AND i.id = v_a.invoice_id;
  SELECT b.base_currency INTO v_base_ccy FROM businesses b WHERE b.id = NEW.business_id;
  v_one   := (1::numeric(20,10))::text;
  v_conv  := v_a.invoice_carrying_base_released_minor - v_a.ar_dust_base_minor;
  v_isnap := concat_ws('|', v_i.source_to_base_rate::text, v_i.rate_source, extract(epoch FROM v_i.rate_timestamp)::text);
  v_hsnap := concat_ws('|', v_h.payment_to_base_rate::text, v_h.rate_source, extract(epoch FROM v_h.rate_timestamp)::text);
  v_base  := concat_ws('|', v_one, 'base', extract(epoch FROM (v_h.payment_date::timestamp AT TIME ZONE 'UTC'))::text);

  v_expected := ARRAY[]::text[];
  v_expected := v_expected || concat_ws('|', 'accounts_receivable', 'C', v_conv::text, v_a.invoice_currency::text,
    v_a.invoice_amount_applied_minor::text, v_isnap, '-', coalesce(v_i.branch_id::text, '-'));
  IF v_a.ar_dust_base_minor <> 0 THEN
    v_expected := v_expected || concat_ws('|', 'accounts_receivable', CASE WHEN v_a.ar_dust_base_minor > 0 THEN 'C' ELSE 'D' END,
      abs(v_a.ar_dust_base_minor)::text, v_base_ccy, abs(v_a.ar_dust_base_minor)::text, v_base, '-', coalesce(v_i.branch_id::text, '-'));
  END IF;
  v_expected := v_expected || concat_ws('|', 'posting', 'D', v_a.payment_base_amount_minor::text, v_a.payment_currency::text,
    v_a.payment_amount_minor::text, v_hsnap, '-', coalesce(v_i.branch_id::text, '-'));
  IF v_a.realized_fx_gain_loss_minor > 0 THEN
    v_expected := v_expected || concat_ws('|', 'fx_gain', 'C', v_a.realized_fx_gain_loss_minor::text, v_base_ccy,
      v_a.realized_fx_gain_loss_minor::text, v_base, '-', coalesce(v_i.branch_id::text, '-'));
  ELSIF v_a.realized_fx_gain_loss_minor < 0 THEN
    v_expected := v_expected || concat_ws('|', 'fx_loss', 'D', abs(v_a.realized_fx_gain_loss_minor)::text, v_base_ccy,
      abs(v_a.realized_fx_gain_loss_minor)::text, v_base, '-', coalesce(v_i.branch_id::text, '-'));
  END IF;
  SELECT array_agg(x ORDER BY x) INTO v_expected FROM unnest(v_expected) AS x;

  -- THE NON-VACUITY CANARY (`0077:1461-1474`). `array_agg` over no rows is
  -- NULL, so a validator that only compares aggregates passes LOUDEST when it
  -- can see nothing at all — which is what FORCE ROW LEVEL SECURITY does to a
  -- DEFINER read whose policy set is missing the seventh policy. The COUNT is
  -- therefore asserted first and separately.
  SELECT count(*) INTO v_nlines FROM journal_lines l
   WHERE l.business_id = NEW.business_id AND l.journal_entry_id = NEW.id;
  IF v_nlines < 1 THEN
    RAISE EXCEPTION 'accounting.selling_detail_missing: a customer payment allocation entry must be posted with lines this validator can read'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT array_agg(s ORDER BY s) INTO v_actual
  FROM (
    SELECT concat_ws('|', CASE WHEN l.account_id = v_h.posting_account_id THEN 'posting' ELSE coalesce(a.system_key, '-') END,
             CASE WHEN l.debit_minor > 0 AND l.credit_minor = 0 THEN 'D' WHEN l.credit_minor > 0 AND l.debit_minor = 0 THEN 'C' ELSE '?' END,
             greatest(l.debit_minor, l.credit_minor)::text, l.txn_currency, l.txn_amount_minor::text, l.fx_rate::text, l.fx_rate_source,
             extract(epoch FROM l.fx_rate_at)::text,
             coalesce(l.warehouse_id::text, '-'), coalesce(l.branch_id::text, '-')) AS s
    FROM journal_lines l
    JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
    WHERE l.business_id = NEW.business_id AND l.journal_entry_id = NEW.id
  ) AS x;

  IF NEW.entry_date IS DISTINCT FROM v_h.payment_date OR v_base_ccy IS NULL OR v_i.branch_id IS NULL
     OR v_i.rate_timestamp IS NULL OR v_h.rate_timestamp IS NULL OR v_expected IS NULL OR v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'accounting.selling_entry_mismatch: a customer payment allocation entry is not exactly the R-82 lines of its allocation'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION accounting_customer_credit_application_entry_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_c        RECORD;
  v_i        RECORD;
  v_base_ccy TEXT;
  v_one      TEXT;
  v_isnap    TEXT;
  v_csnap    TEXT;
  v_base     TEXT;
  v_conv     BIGINT;
  v_cr_conv  BIGINT;
  v_nlines   BIGINT;
  v_expected TEXT[];
  v_actual   TEXT[];
BEGIN
  SELECT c.credit_id, c.invoice_id, c.application_date, c.credit_currency, c.credit_amount_consumed_minor, c.credit_to_base_rate,
         c.credit_carrying_base_released_minor, c.credit_dust_base_minor, c.invoice_currency, c.invoice_amount_applied_minor,
         c.invoice_carrying_base_released_minor, c.ar_dust_base_minor, c.realized_fx_gain_loss_minor
    INTO v_c
  FROM customer_credit_applications c
  WHERE c.business_id = NEW.business_id AND c.binding_source_id = NEW.source_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accounting.selling_detail_missing: a customer credit application entry must be registered by its application in the same transaction'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT i.branch_id, i.source_to_base_rate, i.rate_source, i.rate_timestamp INTO v_i
  FROM invoices i WHERE i.business_id = NEW.business_id AND i.id = v_c.invoice_id;
  SELECT b.base_currency INTO v_base_ccy FROM businesses b WHERE b.id = NEW.business_id;
  v_one     := (1::numeric(20,10))::text;
  v_conv    := v_c.invoice_carrying_base_released_minor - v_c.ar_dust_base_minor;
  v_cr_conv := v_c.credit_carrying_base_released_minor - v_c.credit_dust_base_minor;
  v_isnap   := concat_ws('|', v_i.source_to_base_rate::text, v_i.rate_source, extract(epoch FROM v_i.rate_timestamp)::text);
  SELECT concat_ws('|', v_c.credit_to_base_rate::text, k.rate_source, extract(epoch FROM k.rate_timestamp)::text) INTO v_csnap
  FROM customer_credits k WHERE k.business_id = NEW.business_id AND k.id = v_c.credit_id;
  v_base    := concat_ws('|', v_one, 'base', extract(epoch FROM (v_c.application_date::timestamp AT TIME ZONE 'UTC'))::text);

  v_expected := ARRAY[]::text[];
  v_expected := v_expected || concat_ws('|', 'accounts_receivable', 'C', v_conv::text, v_c.invoice_currency::text,
    v_c.invoice_amount_applied_minor::text, v_isnap, '-', coalesce(v_i.branch_id::text, '-'));
  IF v_c.ar_dust_base_minor <> 0 THEN
    v_expected := v_expected || concat_ws('|', 'accounts_receivable', CASE WHEN v_c.ar_dust_base_minor > 0 THEN 'C' ELSE 'D' END,
      abs(v_c.ar_dust_base_minor)::text, v_base_ccy, abs(v_c.ar_dust_base_minor)::text, v_base, '-', coalesce(v_i.branch_id::text, '-'));
  END IF;
  v_expected := v_expected || concat_ws('|', 'customer_credit_liability', 'D', v_cr_conv::text, v_c.credit_currency::text,
    v_c.credit_amount_consumed_minor::text, v_csnap, '-', coalesce(v_i.branch_id::text, '-'));
  IF v_c.credit_dust_base_minor <> 0 THEN
    v_expected := v_expected || concat_ws('|', 'customer_credit_liability', CASE WHEN v_c.credit_dust_base_minor > 0 THEN 'D' ELSE 'C' END,
      abs(v_c.credit_dust_base_minor)::text, v_base_ccy, abs(v_c.credit_dust_base_minor)::text, v_base, '-',
      coalesce(v_i.branch_id::text, '-'));
  END IF;
  IF v_c.realized_fx_gain_loss_minor > 0 THEN
    v_expected := v_expected || concat_ws('|', 'fx_gain', 'C', v_c.realized_fx_gain_loss_minor::text, v_base_ccy,
      v_c.realized_fx_gain_loss_minor::text, v_base, '-', coalesce(v_i.branch_id::text, '-'));
  ELSIF v_c.realized_fx_gain_loss_minor < 0 THEN
    v_expected := v_expected || concat_ws('|', 'fx_loss', 'D', abs(v_c.realized_fx_gain_loss_minor)::text, v_base_ccy,
      abs(v_c.realized_fx_gain_loss_minor)::text, v_base, '-', coalesce(v_i.branch_id::text, '-'));
  END IF;
  SELECT array_agg(x ORDER BY x) INTO v_expected FROM unnest(v_expected) AS x;

  SELECT count(*) INTO v_nlines FROM journal_lines l
   WHERE l.business_id = NEW.business_id AND l.journal_entry_id = NEW.id;
  IF v_nlines < 1 THEN
    RAISE EXCEPTION 'accounting.selling_detail_missing: a customer credit application entry must be posted with lines this validator can read'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT array_agg(s ORDER BY s) INTO v_actual
  FROM (
    SELECT concat_ws('|', coalesce(a.system_key, '-'),
             CASE WHEN l.debit_minor > 0 AND l.credit_minor = 0 THEN 'D' WHEN l.credit_minor > 0 AND l.debit_minor = 0 THEN 'C' ELSE '?' END,
             greatest(l.debit_minor, l.credit_minor)::text, l.txn_currency, l.txn_amount_minor::text, l.fx_rate::text, l.fx_rate_source,
             extract(epoch FROM l.fx_rate_at)::text,
             coalesce(l.warehouse_id::text, '-'), coalesce(l.branch_id::text, '-')) AS s
    FROM journal_lines l
    JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
    WHERE l.business_id = NEW.business_id AND l.journal_entry_id = NEW.id
  ) AS x;

  IF NEW.entry_date IS DISTINCT FROM v_c.application_date OR v_base_ccy IS NULL OR v_i.branch_id IS NULL
     OR v_i.rate_timestamp IS NULL OR v_csnap IS NULL OR v_expected IS NULL OR v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'accounting.selling_entry_mismatch: a customer credit application entry is not exactly the R-82 lines of its application'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- (c) R-93's third validator: the surplus credit's own entry. EXACTLY TWO
--     LINES, because a surplus has no second currency and no second rate: the
--     credit carries the payment's own snapshot, so both legs are the same
--     amount, the same currency and the same rate. Hence NO DUST LINE and NO
--     FX LINE here — not "omitted", but arithmetically absent, which is why
--     the expected multiset is built unconditionally and the entry's line
--     count is pinned at two.
--
--       Dr the origin payment's posting account   base = original carrying
--       Cr customer_credit_liability (2210)       base = original carrying
--
--     `warehouse` and `branch` are both absent: a pure on-account collection
--     is attributable to no branch by any document in this slice, and
--     `journal_lines.branch_id` is nullable (`0042:195`). The allocation and
--     application validators above take their branch from the INVOICE; a
--     credit has no invoice, so there is nothing to take.
CREATE OR REPLACE FUNCTION accounting_customer_credit_entry_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_k        RECORD;
  v_h        RECORD;
  v_base_ccy TEXT;
  v_ksnap    TEXT;
  v_nlines   BIGINT;
  v_expected TEXT[];
  v_actual   TEXT[];
BEGIN
  SELECT k.origin_payment_id, k.credit_date, k.currency_code, k.original_amount_minor, k.original_carrying_base_amount_minor,
         k.credit_to_base_rate, k.rate_source, k.rate_timestamp
    INTO v_k
  FROM customer_credits k
  WHERE k.business_id = NEW.business_id AND k.binding_source_id = NEW.source_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accounting.selling_detail_missing: a customer credit entry must be registered by its credit in the same transaction'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT h.posting_account_id INTO v_h FROM payments h
   WHERE h.business_id = NEW.business_id AND h.id = v_k.origin_payment_id;
  SELECT b.base_currency INTO v_base_ccy FROM businesses b WHERE b.id = NEW.business_id;
  v_ksnap := concat_ws('|', v_k.credit_to_base_rate::text, v_k.rate_source, extract(epoch FROM v_k.rate_timestamp)::text);

  v_expected := ARRAY[]::text[];
  v_expected := v_expected || concat_ws('|', 'posting', 'D', v_k.original_carrying_base_amount_minor::text,
    v_k.currency_code::text, v_k.original_amount_minor::text, v_ksnap, '-', '-');
  v_expected := v_expected || concat_ws('|', 'customer_credit_liability', 'C', v_k.original_carrying_base_amount_minor::text,
    v_k.currency_code::text, v_k.original_amount_minor::text, v_ksnap, '-', '-');
  SELECT array_agg(x ORDER BY x) INTO v_expected FROM unnest(v_expected) AS x;

  -- The non-vacuity canary again (`0077:1461-1474`), and here it is exact:
  -- the shape is unconditional, so the count is not merely non-zero but TWO.
  SELECT count(*) INTO v_nlines FROM journal_lines l
   WHERE l.business_id = NEW.business_id AND l.journal_entry_id = NEW.id;
  IF v_nlines <> 2 THEN
    RAISE EXCEPTION 'accounting.selling_detail_missing: a customer credit entry must be posted with the two lines this validator can read'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT array_agg(s ORDER BY s) INTO v_actual
  FROM (
    SELECT concat_ws('|', CASE WHEN l.account_id = v_h.posting_account_id THEN 'posting' ELSE coalesce(a.system_key, '-') END,
             CASE WHEN l.debit_minor > 0 AND l.credit_minor = 0 THEN 'D' WHEN l.credit_minor > 0 AND l.debit_minor = 0 THEN 'C' ELSE '?' END,
             greatest(l.debit_minor, l.credit_minor)::text, l.txn_currency, l.txn_amount_minor::text, l.fx_rate::text, l.fx_rate_source,
             extract(epoch FROM l.fx_rate_at)::text,
             coalesce(l.warehouse_id::text, '-'), coalesce(l.branch_id::text, '-')) AS s
    FROM journal_lines l
    JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
    WHERE l.business_id = NEW.business_id AND l.journal_entry_id = NEW.id
  ) AS x;

  IF NEW.entry_date IS DISTINCT FROM v_k.credit_date OR v_base_ccy IS NULL OR v_h.posting_account_id IS NULL
     OR v_k.rate_timestamp IS NULL OR v_expected IS NULL OR v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'accounting.selling_entry_mismatch: a customer credit entry is not exactly the two R-93 lines of its credit'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION accounting_customer_payment_allocation_entry_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_customer_credit_application_entry_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_customer_credit_entry_complete() FROM PUBLIC;

-- All three validators are AFTER INSERT only, on `journal_entries`, which is
-- append-only: an entry's own row is never updated, so no second deferred
-- event for the same row can exist and `NEW` cannot be a stale snapshot.
-- What they read THROUGH that key — the source row and the entry's lines — is
-- read by query at COMMIT, as the staleness problem requires.
CREATE CONSTRAINT TRIGGER journal_entries_customer_payment_allocation_complete
  AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source_type = 'customer_payment_allocation')
  EXECUTE FUNCTION accounting_customer_payment_allocation_entry_complete();
CREATE CONSTRAINT TRIGGER journal_entries_customer_credit_application_complete
  AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source_type = 'customer_credit_application')
  EXECUTE FUNCTION accounting_customer_credit_application_entry_complete();
CREATE CONSTRAINT TRIGGER journal_entries_customer_credit_complete
  AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source_type = 'customer_credit')
  EXECUTE FUNCTION accounting_customer_credit_entry_complete();

ALTER FUNCTION accounting_customer_payment_allocation_entry_complete() OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_customer_credit_application_entry_complete() OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_customer_credit_entry_complete() OWNER TO daftar_accounting_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. The two signed entry routines. Each is internal-owned SECURITY DEFINER
--    with the pinned path, its FIRST STATEMENT consumes an `invctl/1`
--    assertion over its own arguments, and `daftar_app` is its only grantee —
--    as both accepted commands do (`0068:7-10`, `0078:1024`).
--
--    THE SHAPE IS THE SUPPLIER SHAPE (R-86). The caller passes the
--    pre-computed release, dust, base and FX figures; each routine RECOMPUTES
--    every one of them under the locks and refuses `...settlement_changed` on
--    any disagreement, exactly as `supplier_pay` does at `0068:760-764`. A
--    stale figure is a refusal, never a silently-adjusted amount.
--
--    THE LOCK ORDER, DECLARED (P4-AL's declared-lock-order rule). Every path
--    skips the steps it has no use for:
--      1   assertion consume                       (no lock)
--      2   the per-document advisory key           ('daftar.payment_id' |
--                                                   'daftar.customer_credit_application_id')
--      2a  invoices FOR UPDATE, in id order        <- THE CAP LOCK
--      2a' customer_credits FOR UPDATE             (apply_credit)
--      2b  the customer FOR SHARE
--      2c  the payment method FOR SHARE            (collect_payment)
--      7   accounting_post_entry, one per allocation or application, by the
--          CALLER, after this routine returns
--    It extends `0067 R-60` and reorders nothing: no S4/S5/S6 path locks an
--    invoice or a customer credit, so 2a/2a' add no cycle.
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;

-- customer.collect_payment. Money received in one currency, allocated to
-- 0..50 open credit invoices of its customer, with any surplus becoming ONE
-- customer credit in the payment's own currency at the payment's own rate.
CREATE OR REPLACE FUNCTION customer_collect_payment(
  p_payment_id                 UUID,
  p_customer_id                UUID,
  p_payment_method_id          UUID,
  p_posting_account_id         UUID,
  p_payment_date               DATE,
  p_currency_code              CHAR(3),
  p_amount_minor               BIGINT,
  p_rate_id                    UUID,
  p_rate                       NUMERIC,
  p_rate_source                TEXT,
  p_rate_at                    TIMESTAMPTZ,
  p_base_amount_minor          BIGINT,
  p_reference                  TEXT,
  p_credit_id                  UUID,
  p_credit_amount_minor        BIGINT,
  p_credit_carrying_base_minor BIGINT,
  p_allocation_ids             UUID[],
  p_invoice_ids                UUID[],
  p_invoice_currencies         TEXT[],
  p_payment_amounts            BIGINT[],
  p_payment_bases              BIGINT[],
  p_applied                    BIGINT[],
  p_released_before            BIGINT[],
  p_carrying_released          BIGINT[],
  p_ar_dusts                   BIGINT[],
  p_realized                   BIGINT[]
) RETURNS TABLE (
  payment_id    UUID,
  allocation_id UUID,
  line_no       INTEGER,
  invoice_id    UUID,
  credit_id     UUID,
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
  v_cstatus  TEXT;
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
  v_settle   TEXT;
  v_o        BIGINT;
  v_x        BIGINT;
  v_rel      BIGINT;
  v_conv     BIGINT;
  v_pb       BIGINT;
  v_sum_pa   NUMERIC;
  v_sum_pb   NUMERIC;
  v_cb       BIGINT;
BEGIN
  -- 1. The consume, over the routine's OWN ARGUMENTS in declaration order.
  v_actor := inventory_assertion_consume('customer.collect_payment', inventory_claimed_payload_digest('customer.collect_payment',
    ARRAY['uuid', 'uuid', 'uuid', 'uuid', 'integer', 'code', 'integer', 'uuid', 'integer', 'code', 'integer', 'integer']
      || array_fill('integer'::text, ARRAY[8])
      || ARRAY['uuid', 'integer', 'integer', 'integer']
      || ARRAY(SELECT f.t FROM unnest(p_allocation_ids, p_invoice_ids, p_invoice_currencies, p_payment_amounts, p_payment_bases,
                                      p_applied, p_released_before, p_carrying_released, p_ar_dusts, p_realized)
                                 WITH ORDINALITY AS l(al, iv, cu, pa, pb, ap, rb, cr, ad, re, i)
               CROSS JOIN LATERAL unnest(ARRAY['uuid', 'uuid', 'code', 'integer', 'integer', 'integer', 'integer', 'integer',
                                               'integer', 'integer']) WITH ORDINALITY AS f(t, j)
               ORDER BY l.i, f.j),
    ARRAY[p_payment_id::text, p_customer_id::text, p_payment_method_id::text, p_posting_account_id::text,
          to_char(p_payment_date, 'YYYYMMDD'), lower(p_currency_code::text), p_amount_minor::text, p_rate_id::text,
          inventory_fixed_text(p_rate, 10), p_rate_source,
          CASE WHEN extract(epoch FROM p_rate_at) = trunc(extract(epoch FROM p_rate_at))
               THEN trunc(extract(epoch FROM p_rate_at))::text ELSE extract(epoch FROM p_rate_at)::text END,
          p_base_amount_minor::text]
      || inventory_reason_words(p_reference)
      || ARRAY[p_credit_id::text, p_credit_amount_minor::text, p_credit_carrying_base_minor::text,
               coalesce(cardinality(p_allocation_ids), 0)::text]
      || ARRAY(SELECT f.x FROM unnest(p_allocation_ids, p_invoice_ids, p_invoice_currencies, p_payment_amounts, p_payment_bases,
                                      p_applied, p_released_before, p_carrying_released, p_ar_dusts, p_realized)
                                 WITH ORDINALITY AS l(al, iv, cu, pa, pb, ap, rb, cr, ad, re, i)
               CROSS JOIN LATERAL unnest(ARRAY[l.al::text, l.iv::text, lower(l.cu), l.pa::text, l.pb::text, l.ap::text,
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
    RAISE EXCEPTION 'inventory.trace_missing: a customer payment records its business transaction id' USING ERRCODE = 'P0001';
  END IF;
  IF p_payment_id IS NULL THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a customer payment names its id' USING ERRCODE = 'P0001';
  END IF;

  -- 3. The document key, then the intent. THE INTENT IS REQUEST-ONLY: ids,
  --    the date, the currency, the amount, the reference, the credit id and
  --    amount, and per allocation its id, invoice, paid and applied amounts.
  --    It carries no derived release, dust, base or FX figure, so the
  --    comparison happens before any catalogue is read and a rate change is
  --    not a false conflict ([[daftar-registry-before-state]]).
  PERFORM pg_advisory_xact_lock(hashtext('daftar.payment_id'), hashtext(p_payment_id::text));
  v_intent := inventory_payload_digest('customer.collect_payment', v_tenant, v_business,
    ARRAY['uuid', 'uuid', 'uuid', 'integer', 'code', 'integer'] || array_fill('integer'::text, ARRAY[8])
      || ARRAY['uuid', 'integer', 'integer']
      || ARRAY(SELECT f.t FROM unnest(p_allocation_ids, p_invoice_ids, p_payment_amounts, p_applied)
                                 WITH ORDINALITY AS l(al, iv, pa, ap, i)
               CROSS JOIN LATERAL unnest(ARRAY['uuid', 'uuid', 'integer', 'integer']) WITH ORDINALITY AS f(t, j)
               ORDER BY l.i, f.j),
    ARRAY[p_payment_id::text, p_customer_id::text, p_payment_method_id::text, to_char(p_payment_date, 'YYYYMMDD'),
          lower(p_currency_code::text), p_amount_minor::text]
      || inventory_reason_words(p_reference)
      || ARRAY[p_credit_id::text, p_credit_amount_minor::text, coalesce(cardinality(p_allocation_ids), 0)::text]
      || ARRAY(SELECT f.x FROM unnest(p_allocation_ids, p_invoice_ids, p_payment_amounts, p_applied)
                                 WITH ORDINALITY AS l(al, iv, pa, ap, i)
               CROSS JOIN LATERAL unnest(ARRAY[l.al::text, l.iv::text, l.pa::text, l.ap::text]) WITH ORDINALITY AS f(x, j)
               ORDER BY l.i, f.j));

  -- 4. The replay read, BEFORE any other read: an equal intent replays and
  --    writes nothing, another is a stable conflict.
  SELECT h.intent_sha256 INTO v_stored FROM payments h WHERE h.business_id = v_business AND h.id = p_payment_id;
  IF FOUND THEN
    IF v_stored <> v_intent THEN
      RAISE EXCEPTION 'customer_payment.idempotency_conflict: this payment id was already used for another payment' USING ERRCODE = 'P0001';
    END IF;
    v_replay := true;
  ELSE
    -- 5. Shape, before any state read.
    IF p_customer_id IS NULL OR p_payment_method_id IS NULL OR p_posting_account_id IS NULL OR p_payment_date IS NULL
       OR p_currency_code IS NULL OR p_amount_minor IS NULL OR p_rate IS NULL OR p_rate_source IS NULL OR p_rate_at IS NULL
       OR p_base_amount_minor IS NULL THEN
      RAISE EXCEPTION 'inventory.payload_invalid: a customer payment binds its customer, method, account, date, currency, amount and rate snapshot'
        USING ERRCODE = 'P0001';
    END IF;
    v_n := coalesce(cardinality(p_allocation_ids), 0);
    -- R-87: ZERO allocations is legal — pure on-account money — so the lower
    -- bound is 0 where `0068:617` has 1. Everything else about the arrays is
    -- the accepted shape, including the all-or-none NULL and distinctness
    -- rules, read over an empty array as vacuously true.
    -- A plpgsql `IF` reads its condition up to the FIRST `THEN` token, so a
    -- `CASE ... THEN ... END` may not appear in one: the dimension and lower
    -- bound are therefore asserted under `v_n > 0`, which also states the
    -- intent plainly — an EMPTY array has no dimension to check.
    IF v_n > 50 OR p_allocation_ids IS NULL
       OR (v_n > 0 AND (array_ndims(p_allocation_ids) <> 1 OR array_lower(p_allocation_ids, 1) <> 1))
       OR p_invoice_ids IS NULL OR coalesce(cardinality(p_invoice_ids), 0) <> v_n
       OR p_invoice_currencies IS NULL OR coalesce(cardinality(p_invoice_currencies), 0) <> v_n
       OR p_payment_amounts IS NULL OR coalesce(cardinality(p_payment_amounts), 0) <> v_n
       OR p_payment_bases IS NULL OR coalesce(cardinality(p_payment_bases), 0) <> v_n
       OR p_applied IS NULL OR coalesce(cardinality(p_applied), 0) <> v_n
       OR p_released_before IS NULL OR coalesce(cardinality(p_released_before), 0) <> v_n
       OR p_carrying_released IS NULL OR coalesce(cardinality(p_carrying_released), 0) <> v_n
       OR p_ar_dusts IS NULL OR coalesce(cardinality(p_ar_dusts), 0) <> v_n
       OR p_realized IS NULL OR coalesce(cardinality(p_realized), 0) <> v_n
       OR array_position(p_allocation_ids, NULL) IS NOT NULL OR array_position(p_invoice_ids, NULL) IS NOT NULL
       OR array_position(p_invoice_currencies, NULL) IS NOT NULL OR array_position(p_payment_amounts, NULL) IS NOT NULL
       OR array_position(p_payment_bases, NULL) IS NOT NULL OR array_position(p_applied, NULL) IS NOT NULL
       OR array_position(p_released_before, NULL) IS NOT NULL OR array_position(p_carrying_released, NULL) IS NOT NULL
       OR array_position(p_ar_dusts, NULL) IS NOT NULL OR array_position(p_realized, NULL) IS NOT NULL
       OR (SELECT count(DISTINCT x.id) FROM unnest(p_allocation_ids) AS x(id)) <> v_n
       OR (SELECT count(DISTINCT x.id) FROM unnest(p_invoice_ids) AS x(id)) <> v_n
       OR p_amount_minor <= 0
       OR EXISTS (SELECT 1 FROM unnest(p_payment_amounts) AS x(a) WHERE x.a <= 0)
       OR EXISTS (SELECT 1 FROM unnest(p_applied) AS x(a) WHERE x.a <= 0)
       OR (p_reference IS NOT NULL AND (p_reference <> btrim(p_reference) OR char_length(p_reference) NOT BETWEEN 1 AND 100)) THEN
      RAISE EXCEPTION 'customer_payment.allocations_invalid: a payment is allocated to 0..50 distinct open invoices in positive amounts, with an optional trimmed reference'
        USING ERRCODE = 'P0001';
    END IF;
    -- R-87's closure, as a SHAPE rule first: the paid amounts and the surplus
    -- credit account for the whole payment, and the credit's three arguments
    -- are all-or-none.
    v_sum_pa := coalesce((SELECT sum(x.a) FROM unnest(p_payment_amounts) AS x(a)), 0);
    IF (p_credit_id IS NULL) <> (p_credit_amount_minor IS NULL)
       OR (p_credit_id IS NULL) <> (p_credit_carrying_base_minor IS NULL)
       OR (p_credit_amount_minor IS NOT NULL AND p_credit_amount_minor <= 0)
       OR (p_credit_carrying_base_minor IS NOT NULL AND p_credit_carrying_base_minor <= 0)
       OR v_sum_pa + coalesce(p_credit_amount_minor, 0) <> p_amount_minor THEN
      RAISE EXCEPTION 'customer_payment.closure_invalid: the allocated amounts and the surplus credit are exactly the payment amount'
        USING ERRCODE = 'P0001';
    END IF;
    -- R-74: an allocation id, and the credit id, are idempotency keys and
    -- accounting source ids. A stable domain refusal, never a raw key
    -- violation.
    IF (v_n > 0 AND EXISTS (SELECT 1 FROM payment_allocations a WHERE a.business_id = v_business AND a.id = ANY (p_allocation_ids)))
       OR (p_credit_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM customer_credits k WHERE k.business_id = v_business AND k.id = p_credit_id)) THEN
      RAISE EXCEPTION 'customer_payment.allocations_invalid: an allocation id or the credit id is already used by another document'
        USING ERRCODE = 'P0001';
    END IF;

    -- 6. Lock step 2a: every allocated invoice FOR UPDATE, IN ID ORDER. This
    --    is the cap lock: two racing allocations serialise on the invoice row
    --    and the loser is refused by its own recomputation at step 10.
    IF v_n > 0 THEN
      SELECT count(*) INTO v_found
      FROM (SELECT i.id FROM invoices i WHERE i.business_id = v_business AND i.id = ANY (p_invoice_ids) ORDER BY i.id FOR UPDATE) AS k;
      IF v_found <> v_n THEN
        RAISE EXCEPTION 'invoice.not_found: the invoice does not exist in this business' USING ERRCODE = 'P0001';
      END IF;
      FOR v_i IN 1 .. v_n LOOP
        SELECT i.status, i.customer_id, i.currency_code, i.issue_date, i.sale_id INTO v_q
        FROM invoices i WHERE i.business_id = v_business AND i.id = p_invoice_ids[v_i];
        IF v_q.customer_id IS NULL THEN
          RAISE EXCEPTION 'invoice_settlement.walkin_not_settleable: a walk-in invoice carries no customer and is settled by nothing' USING ERRCODE = 'P0001';
        END IF;
        IF v_q.customer_id <> p_customer_id THEN
          RAISE EXCEPTION 'invoice_settlement.customer_mismatch: a payment settles invoices of its own customer only' USING ERRCODE = 'P0001';
        END IF;
        IF v_q.status <> 'open' THEN
          RAISE EXCEPTION 'customer_payment.invoice_state_invalid: only an open invoice is settled' USING ERRCODE = 'P0001';
        END IF;
        SELECT s.settlement_mode INTO v_settle FROM sales s WHERE s.business_id = v_business AND s.id = v_q.sale_id;
        IF v_settle = 'cash' THEN
          RAISE EXCEPTION 'invoice_settlement.cash_not_settleable: a cash-settled invoice carries no receivable and is settled by nothing' USING ERRCODE = 'P0001';
        END IF;
        IF v_q.currency_code::text <> p_invoice_currencies[v_i] THEN
          RAISE EXCEPTION 'customer_payment.settlement_changed: an invoice changed since the payment was prepared' USING ERRCODE = 'P0001';
        END IF;
      END LOOP;
    END IF;

    -- 7. Lock step 2b: the customer FOR SHARE.
    SELECT c.status INTO v_cstatus FROM customers c WHERE c.business_id = v_business AND c.id = p_customer_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'customer.not_found: the customer does not exist in this business' USING ERRCODE = 'P0001';
    END IF;
    IF v_cstatus <> 'active' THEN
      RAISE EXCEPTION 'customer_payment.customer_inactive: a customer payment is collected from an active customer' USING ERRCODE = 'P0001';
    END IF;

    -- 8. Lock step 2c: the method FOR SHARE.
    SELECT m.is_active, m.posting_account_id, m.requires_reference INTO v_m
    FROM payment_methods m WHERE m.business_id = v_business AND m.id = p_payment_method_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'payment_method.not_found: the payment method does not exist in this business' USING ERRCODE = 'P0001';
    END IF;
    IF NOT v_m.is_active THEN
      RAISE EXCEPTION 'payment_method.inactive: a customer payment is collected through an active payment method' USING ERRCODE = 'P0001';
    END IF;
    IF v_m.posting_account_id <> p_posting_account_id THEN
      RAISE EXCEPTION 'customer_payment.settlement_changed: the payment method''s posting account changed since the payment was prepared'
        USING ERRCODE = 'P0001';
    END IF;
    IF accounting_settlement_account_eligibility(v_business, v_m.posting_account_id) IS DISTINCT FROM 'eligible' THEN
      RAISE EXCEPTION 'payment_method.posting_account_ineligible: a payment method posts to an active settlement asset account of its business'
        USING ERRCODE = 'P0001';
    END IF;
    IF v_m.requires_reference AND p_reference IS NULL THEN
      RAISE EXCEPTION 'customer_payment.reference_required: this payment method requires a reference' USING ERRCODE = 'P0001';
    END IF;

    -- 9. The dates: not before any settled invoice, not after today. The
    --    clock is read for TODAY only and never to fill a document date
    --    (P4-AL-30).
    SELECT b.timezone, b.base_currency INTO v_tz, v_base_ccy FROM businesses b WHERE b.id = v_business;
    IF v_n > 0 AND EXISTS (SELECT 1 FROM invoices i
                            WHERE i.business_id = v_business AND i.id = ANY (p_invoice_ids) AND i.issue_date > p_payment_date) THEN
      RAISE EXCEPTION 'customer_payment.date_before_invoice: a payment is dated on or after every invoice it settles' USING ERRCODE = 'P0001';
    END IF;
    IF p_payment_date > (now() AT TIME ZONE v_tz)::date THEN
      RAISE EXCEPTION 'customer_payment.date_in_future: a payment is dated on or before today in the business timezone' USING ERRCODE = 'P0001';
    END IF;

    -- 10. The payment FX snapshot: no clock, the instant is derived.
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
      RAISE EXCEPTION 'customer_payment.fx_rate_changed: the exchange rate changed since the payment was prepared' USING ERRCODE = 'P0001';
    END IF;

    -- 11. Per allocation, in array order, UNDER THE INVOICE LOCKS: O is
    --     re-read from the reader-of-record, X, the release, the dust, the
    --     payment base and the FX are recomputed, and EVERY ONE of the
    --     caller's figures must agree (R-86).
    SELECT c.minor_units INTO v_ep FROM currencies c WHERE c.code = p_currency_code::text;
    SELECT c.minor_units INTO v_eb FROM currencies c WHERE c.code = v_base_ccy;
    v_sum_pb := 0;
    FOR v_i IN 1 .. v_n LOOP
      SELECT i.currency_code, i.total_txn_minor, i.total_base_minor, i.source_to_base_rate INTO v_q
      FROM invoices i WHERE i.business_id = v_business AND i.id = p_invoice_ids[v_i];
      SELECT c.minor_units INTO v_et FROM currencies c WHERE c.code = v_q.currency_code::text;
      SELECT o.outstanding_txn_minor INTO v_o FROM invoice_outstanding(v_business, p_invoice_ids[v_i]) o;
      IF p_applied[v_i] > v_o THEN
        RAISE EXCEPTION 'customer_payment.amount_exceeds_outstanding: an allocation applies more than the invoice''s outstanding amount'
          USING ERRCODE = 'P0001';
      END IF;
      IF p_currency_code::text = v_q.currency_code::text AND p_payment_amounts[v_i] <> p_applied[v_i] THEN
        RAISE EXCEPTION 'customer_payment.amount_mismatch: in the invoice''s own currency the paid and applied amounts are equal' USING ERRCODE = 'P0001';
      END IF;
      v_x    := v_q.total_txn_minor - v_o;
      v_rel  := supplier_ap_release(v_q.total_base_minor, v_q.total_txn_minor, v_x, p_applied[v_i]);
      v_conv := supplier_convert_base(p_applied[v_i], v_q.source_to_base_rate, v_et, v_eb);
      v_pb   := supplier_convert_base(p_payment_amounts[v_i], v_rate, v_ep, v_eb);
      IF v_conv = 0 OR v_pb = 0 THEN
        RAISE EXCEPTION 'customer_payment.amount_below_base_unit: an allocated amount converts to less than one base minor unit' USING ERRCODE = 'P0001';
      END IF;
      IF p_applied[v_i] < v_o AND supplier_convert_base(v_o - p_applied[v_i], v_q.source_to_base_rate, v_et, v_eb) = 0 THEN
        RAISE EXCEPTION 'customer_payment.residue_below_base_unit: an allocation would leave the invoice an outstanding amount converting to less than one base minor unit'
          USING ERRCODE = 'P0001';
      END IF;
      IF p_released_before[v_i] <> v_x OR p_carrying_released[v_i] <> v_rel OR p_ar_dusts[v_i] <> v_rel - v_conv
         OR p_payment_bases[v_i] <> v_pb OR p_realized[v_i] <> v_pb - v_rel THEN
        RAISE EXCEPTION 'customer_payment.settlement_changed: an invoice''s outstanding amount changed since the payment was prepared'
          USING ERRCODE = 'P0001';
      END IF;
      v_sum_pb := v_sum_pb + v_pb;
    END LOOP;
    -- The surplus credit's carrying base is its OWN single HALF_EVEN of its own
    -- stored original at the payment's rate — never the payment base minus the
    -- allocation bases, which would make a rounded quotient an input
    -- (P4-AL-25). The base closure is then a SUM OF ROUNDINGS.
    IF p_credit_id IS NOT NULL THEN
      v_cb := supplier_convert_base(p_credit_amount_minor, v_rate, v_ep, v_eb);
      IF v_cb = 0 THEN
        RAISE EXCEPTION 'customer_payment.amount_below_base_unit: a surplus credit converts to less than one base minor unit' USING ERRCODE = 'P0001';
      END IF;
      IF p_credit_carrying_base_minor <> v_cb THEN
        RAISE EXCEPTION 'customer_payment.settlement_changed: the surplus credit''s carrying base changed since the payment was prepared'
          USING ERRCODE = 'P0001';
      END IF;
      v_sum_pb := v_sum_pb + v_cb;
    END IF;
    IF v_sum_pb <> p_base_amount_minor THEN
      RAISE EXCEPTION 'customer_payment.settlement_changed: the payment base is not the sum of its allocations'' bases and its surplus credit''s carrying base'
        USING ERRCODE = 'P0001';
    END IF;

    -- 12. The header, then the allocations (line_no = ordinal,
    --     binding_source_id = id), then the surplus credit.
    INSERT INTO payments (tenant_id, business_id, id, customer_id, payment_method_id, posting_account_id, currency_code, amount_minor,
                          payment_to_base_rate, rate_source, rate_timestamp, fx_rate_id, base_amount_minor, payment_date, reference,
                          allocation_count, intent_sha256, business_transaction_id, created_by)
    VALUES (v_tenant, v_business, p_payment_id, p_customer_id, p_payment_method_id, p_posting_account_id, p_currency_code, p_amount_minor,
            v_rate, v_source, v_at, v_rate_id, p_base_amount_minor, p_payment_date, p_reference,
            v_n, v_intent, v_trace, v_actor.actor_user_id);
    IF v_n > 0 THEN
      INSERT INTO payment_allocations (tenant_id, business_id, id, payment_id, customer_id, invoice_id, line_no, payment_currency,
                                       payment_amount_minor, payment_to_base_rate, payment_base_amount_minor, invoice_currency,
                                       invoice_amount_applied_minor, invoice_historical_to_base_rate, ar_released_before_txn_minor,
                                       invoice_carrying_base_released_minor, ar_dust_base_minor, realized_fx_gain_loss_minor,
                                       binding_source_id)
      SELECT v_tenant, v_business, x.al, p_payment_id, p_customer_id, x.iv, x.i::integer, p_currency_code,
             x.pa, v_rate, x.pb, i.currency_code,
             x.ap, i.source_to_base_rate, x.rb,
             x.cr, x.ad, x.re,
             x.al
      FROM unnest(p_allocation_ids, p_invoice_ids, p_payment_amounts, p_payment_bases, p_applied, p_released_before,
                  p_carrying_released, p_ar_dusts, p_realized) WITH ORDINALITY AS x(al, iv, pa, pb, ap, rb, cr, ad, re, i)
      JOIN invoices i ON i.business_id = v_business AND i.id = x.iv
      ORDER BY x.i;
    END IF;
    IF p_credit_id IS NOT NULL THEN
      INSERT INTO customer_credits (tenant_id, business_id, id, customer_id, origin_payment_id, currency_code,
                                    original_amount_minor, original_carrying_base_amount_minor, credit_to_base_rate,
                                    rate_source, rate_timestamp, fx_rate_id, remaining_amount_minor,
                                    remaining_carrying_base_amount_minor, credit_date, intent_sha256, business_transaction_id, created_by,
                                    binding_source_id)
      VALUES (v_tenant, v_business, p_credit_id, p_customer_id, p_payment_id, p_currency_code,
              p_credit_amount_minor, v_cb, v_rate,
              v_source, v_at, v_rate_id, p_credit_amount_minor,
              v_cb, p_payment_date, v_intent, v_trace, v_actor.actor_user_id,
              p_credit_id);
    END IF;

    -- 13. Audit and outbox: ids, NEVER an amount.
    INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
    VALUES (v_tenant, v_business, v_actor.actor_user_id, 'customer.payment_collected', 'payment', p_payment_id::text,
            jsonb_build_object('customerId', p_customer_id, 'allocationIds', to_jsonb(p_allocation_ids), 'creditId', p_credit_id,
                               'assertionJti', v_actor.jti, 'business_transaction_id', v_trace));
    INSERT INTO outbox_events (tenant_id, business_id, type, payload)
    VALUES (v_tenant, v_business, 'customer.payment_collected.v1',
            jsonb_build_object('businessId', v_business, 'paymentId', p_payment_id, 'customerId', p_customer_id,
                               'allocationIds', to_jsonb(p_allocation_ids), 'creditId', p_credit_id,
                               'businessTransactionId', v_trace));
  END IF;

  -- 14. The stored rows, in line order. A LEFT JOIN, because a payment with
  --     ZERO allocations (R-87) still has a row to return.
  RETURN QUERY
  SELECT h.id, a.id, a.line_no, a.invoice_id,
         (SELECT k.id FROM customer_credits k WHERE k.business_id = v_business AND k.origin_payment_id = h.id), v_replay
  FROM payments h
  LEFT JOIN payment_allocations a ON a.business_id = h.business_id AND a.payment_id = h.id
  WHERE h.business_id = v_business AND h.id = p_payment_id
  ORDER BY a.line_no NULLS FIRST;
END;
$$;

COMMENT ON FUNCTION customer_collect_payment(UUID, UUID, UUID, UUID, DATE, CHAR(3), BIGINT, UUID, NUMERIC, TEXT, TIMESTAMPTZ, BIGINT, TEXT, UUID, BIGINT, BIGINT, UUID[], UUID[], TEXT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[]) IS
  'P4-S4 (R-86, R-87). First consumes an invctl/1 assertion of kind customer.collect_payment over its own arguments. Under the daftar.payment_id key, with the request-only intent (id, customer, method, date, currency, amount, reference, credit id and amount, and per allocation id, invoice, paid and applied amounts): an equal stored intent returns the stored rows (replayed), another is customer_payment.idempotency_conflict. Then the shape (inventory.payload_invalid; customer_payment.allocations_invalid for the array law and the R-74 child-id law; customer_payment.closure_invalid for R-87), the invoices FOR UPDATE in id order (invoice.not_found, invoice_settlement.walkin_not_settleable, invoice_settlement.customer_mismatch, invoice_settlement.cash_not_settleable, customer_payment.invoice_state_invalid, settlement_changed), the customer FOR SHARE (customer.not_found, customer_inactive), the method FOR SHARE (payment_method.not_found, inactive, posting_account_ineligible; settlement_changed; reference_required), the dates (date_before_invoice, date_in_future), the FX snapshot (purchase.currency_unknown, fx_rate_changed), and per allocation O, X, the release, the dust, the base and the FX RECOMPUTED and compared (amount_exceeds_outstanding, amount_mismatch, amount_below_base_unit, residue_below_base_unit, settlement_changed). Inserts the payment, its 0..50 allocations and its surplus credit; audit customer.payment_collected and its outbox row. ZERO allocations is in scope: pure on-account money. The caller posts one customer_payment_allocation entry per allocation in line order, and one customer_credit entry for the surplus credit when there is one (R-93). EXECUTE: daftar_app only.';

-- customer.apply_credit. One existing customer credit consumed against one
-- open credit invoice of the same customer; the credit is decremented by the
-- R-90 writer AFTER the application row exists.
CREATE OR REPLACE FUNCTION customer_apply_credit(
  p_application_id           UUID,
  p_credit_id                UUID,
  p_invoice_id               UUID,
  p_application_date         DATE,
  p_credit_currency          CHAR(3),
  p_consumed_minor           BIGINT,
  p_remaining_before_minor   BIGINT,
  p_credit_released_minor    BIGINT,
  p_credit_dust_minor        BIGINT,
  p_invoice_currency         CHAR(3),
  p_applied_minor            BIGINT,
  p_ar_released_before_minor BIGINT,
  p_ar_released_minor        BIGINT,
  p_ar_dust_minor            BIGINT,
  p_realized_minor           BIGINT
) RETURNS TABLE (
  application_id UUID,
  replayed       BOOLEAN
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
  v_i        RECORD;
  v_c        RECORD;
  v_tz       TEXT;
  v_base_ccy TEXT;
  v_settle   TEXT;
  v_cstatus  TEXT;
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
  -- 1. The consume, over the routine's own arguments in declaration order.
  v_actor := inventory_assertion_consume('customer.apply_credit', inventory_claimed_payload_digest('customer.apply_credit',
    ARRAY['uuid', 'uuid', 'uuid', 'integer', 'code', 'integer', 'integer', 'integer', 'integer', 'code', 'integer', 'integer',
          'integer', 'integer', 'integer'],
    ARRAY[p_application_id::text, p_credit_id::text, p_invoice_id::text, to_char(p_application_date, 'YYYYMMDD'),
          lower(p_credit_currency::text), p_consumed_minor::text, p_remaining_before_minor::text, p_credit_released_minor::text,
          p_credit_dust_minor::text, lower(p_invoice_currency::text), p_applied_minor::text, p_ar_released_before_minor::text,
          p_ar_released_minor::text, p_ar_dust_minor::text, p_realized_minor::text]));
  -- 2. Isolation and trace.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: inventory commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_business := v_actor.business_id;
  v_tenant   := v_actor.tenant_id;
  v_replay   := false;
  v_trace    := inventory_business_transaction_id();
  IF v_trace IS NULL THEN
    RAISE EXCEPTION 'inventory.trace_missing: a customer credit application records its business transaction id' USING ERRCODE = 'P0001';
  END IF;
  IF p_application_id IS NULL THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a customer credit application names its id' USING ERRCODE = 'P0001';
  END IF;

  -- 3. The document key, then the request-only intent.
  PERFORM pg_advisory_xact_lock(hashtext('daftar.customer_credit_application_id'), hashtext(p_application_id::text));
  v_intent := inventory_payload_digest('customer.apply_credit', v_tenant, v_business,
    ARRAY['uuid', 'uuid', 'uuid', 'integer', 'integer', 'integer'],
    ARRAY[p_application_id::text, p_credit_id::text, p_invoice_id::text, to_char(p_application_date, 'YYYYMMDD'),
          p_consumed_minor::text, p_applied_minor::text]);

  -- 4. The replay read, before any other read.
  SELECT a.intent_sha256 INTO v_stored FROM customer_credit_applications a
   WHERE a.business_id = v_business AND a.id = p_application_id;
  IF FOUND THEN
    IF v_stored <> v_intent THEN
      RAISE EXCEPTION 'customer_credit_application.idempotency_conflict: this application id was already used for another credit application'
        USING ERRCODE = 'P0001';
    END IF;
    v_replay := true;
  ELSE
    -- 5. Shape, before any state read.
    IF p_credit_id IS NULL OR p_invoice_id IS NULL OR p_application_date IS NULL OR p_credit_currency IS NULL
       OR p_consumed_minor IS NULL OR p_remaining_before_minor IS NULL OR p_credit_released_minor IS NULL
       OR p_credit_dust_minor IS NULL OR p_invoice_currency IS NULL OR p_applied_minor IS NULL
       OR p_ar_released_before_minor IS NULL OR p_ar_released_minor IS NULL OR p_ar_dust_minor IS NULL OR p_realized_minor IS NULL
       OR p_consumed_minor <= 0 OR p_applied_minor <= 0 THEN
      RAISE EXCEPTION 'inventory.payload_invalid: a customer credit application binds its credit, invoice, date and positive amounts'
        USING ERRCODE = 'P0001';
    END IF;

    -- 6. Lock step 2a: the target invoice FOR UPDATE — the cap lock.
    SELECT i.status, i.customer_id, i.currency_code, i.issue_date, i.sale_id, i.total_txn_minor, i.total_base_minor,
           i.source_to_base_rate
      INTO v_i
    FROM invoices i WHERE i.business_id = v_business AND i.id = p_invoice_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invoice.not_found: the invoice does not exist in this business' USING ERRCODE = 'P0001';
    END IF;
    IF v_i.customer_id IS NULL THEN
      RAISE EXCEPTION 'invoice_settlement.walkin_not_settleable: a walk-in invoice carries no customer and is settled by nothing' USING ERRCODE = 'P0001';
    END IF;
    IF v_i.status <> 'open' THEN
      RAISE EXCEPTION 'customer_credit_application.invoice_state_invalid: a customer credit is applied to an open invoice only' USING ERRCODE = 'P0001';
    END IF;
    SELECT s.settlement_mode INTO v_settle FROM sales s WHERE s.business_id = v_business AND s.id = v_i.sale_id;
    IF v_settle = 'cash' THEN
      RAISE EXCEPTION 'invoice_settlement.cash_not_settleable: a cash-settled invoice carries no receivable and is settled by nothing' USING ERRCODE = 'P0001';
    END IF;
    IF v_i.currency_code <> p_invoice_currency THEN
      RAISE EXCEPTION 'customer_credit_application.settlement_changed: the invoice changed since the application was prepared' USING ERRCODE = 'P0001';
    END IF;

    -- 7. Lock step 2a': the credit FOR UPDATE.
    SELECT c.customer_id, c.currency_code, c.original_amount_minor, c.original_carrying_base_amount_minor, c.remaining_amount_minor,
           c.credit_to_base_rate, c.credit_date
      INTO v_c
    FROM customer_credits c WHERE c.business_id = v_business AND c.id = p_credit_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'customer_credit.not_found: the customer credit does not exist in this business' USING ERRCODE = 'P0001';
    END IF;
    -- R-84(a), under the locks and at the command boundary too, so a caller
    -- gets the right refusal rather than a COMMIT-time one.
    IF v_c.customer_id <> v_i.customer_id THEN
      RAISE EXCEPTION 'invoice_settlement.customer_mismatch: a customer credit is applied to an invoice of the same customer' USING ERRCODE = 'P0001';
    END IF;
    IF v_c.remaining_amount_minor = 0 THEN
      RAISE EXCEPTION 'customer_credit_application.credit_exhausted: the customer credit has no remaining amount' USING ERRCODE = 'P0001';
    END IF;
    IF p_consumed_minor > v_c.remaining_amount_minor THEN
      RAISE EXCEPTION 'customer_credit_application.amount_exceeds_credit: an application consumes more than the credit''s remaining amount'
        USING ERRCODE = 'P0001';
    END IF;
    IF p_remaining_before_minor <> v_c.remaining_amount_minor OR v_c.currency_code <> p_credit_currency THEN
      RAISE EXCEPTION 'customer_credit_application.settlement_changed: the customer credit changed since the application was prepared'
        USING ERRCODE = 'P0001';
    END IF;

    -- 8. Lock step 2b: the customer FOR SHARE. An inactive customer may still
    --    have a credit applied: the money is already theirs and refusing it
    --    would strand it.
    SELECT c.status INTO v_cstatus FROM customers c WHERE c.business_id = v_business AND c.id = v_i.customer_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'customer.not_found: the customer does not exist in this business' USING ERRCODE = 'P0001';
    END IF;

    -- 9. The dates: not before the invoice or the credit, not after today.
    SELECT b.timezone, b.base_currency INTO v_tz, v_base_ccy FROM businesses b WHERE b.id = v_business;
    IF p_application_date < greatest(v_i.issue_date, v_c.credit_date) THEN
      RAISE EXCEPTION 'customer_credit_application.date_before_source: an application is dated on or after its invoice and its credit'
        USING ERRCODE = 'P0001';
    END IF;
    IF p_application_date > (now() AT TIME ZONE v_tz)::date THEN
      RAISE EXCEPTION 'customer_credit_application.date_in_future: an application is dated on or before today in the business timezone'
        USING ERRCODE = 'P0001';
    END IF;

    -- 10. The AR side and the credit side, each at its OWN stored snapshot;
    --     no new FX is looked up (the credit carries its own rate).
    SELECT c.minor_units INTO v_et FROM currencies c WHERE c.code = v_i.currency_code::text;
    SELECT c.minor_units INTO v_en FROM currencies c WHERE c.code = v_c.currency_code::text;
    SELECT c.minor_units INTO v_eb FROM currencies c WHERE c.code = v_base_ccy;
    SELECT o.outstanding_txn_minor INTO v_o FROM invoice_outstanding(v_business, p_invoice_id) o;
    IF p_applied_minor > v_o THEN
      RAISE EXCEPTION 'customer_credit_application.amount_exceeds_outstanding: an application applies more than the invoice''s outstanding amount'
        USING ERRCODE = 'P0001';
    END IF;
    IF v_c.currency_code = v_i.currency_code AND p_consumed_minor <> p_applied_minor THEN
      RAISE EXCEPTION 'customer_credit_application.amount_mismatch: in one currency the consumed and applied amounts are equal' USING ERRCODE = 'P0001';
    END IF;
    v_x       := v_i.total_txn_minor - v_o;
    v_rel     := supplier_ap_release(v_i.total_base_minor, v_i.total_txn_minor, v_x, p_applied_minor);
    v_conv    := supplier_convert_base(p_applied_minor, v_i.source_to_base_rate, v_et, v_eb);
    v_cr_rel  := supplier_credit_remaining_carrying(v_c.original_amount_minor, v_c.original_carrying_base_amount_minor,
                                                    v_c.remaining_amount_minor)
                 - supplier_credit_remaining_carrying(v_c.original_amount_minor, v_c.original_carrying_base_amount_minor,
                                                      v_c.remaining_amount_minor - p_consumed_minor);
    v_cr_conv := supplier_convert_base(p_consumed_minor, v_c.credit_to_base_rate, v_en, v_eb);
    IF v_conv = 0 OR v_cr_conv = 0 THEN
      RAISE EXCEPTION 'customer_credit_application.amount_below_base_unit: an applied or consumed amount converts to less than one base minor unit'
        USING ERRCODE = 'P0001';
    END IF;
    IF (p_applied_minor < v_o AND supplier_convert_base(v_o - p_applied_minor, v_i.source_to_base_rate, v_et, v_eb) = 0)
       OR (p_consumed_minor < v_c.remaining_amount_minor
           AND supplier_convert_base(v_c.remaining_amount_minor - p_consumed_minor, v_c.credit_to_base_rate, v_en, v_eb) = 0) THEN
      RAISE EXCEPTION 'customer_credit_application.residue_below_base_unit: an application would leave the invoice or the credit a remaining amount converting to less than one base minor unit'
        USING ERRCODE = 'P0001';
    END IF;
    IF p_ar_released_before_minor <> v_x OR p_ar_released_minor <> v_rel OR p_ar_dust_minor <> v_rel - v_conv
       OR p_credit_released_minor <> v_cr_rel OR p_credit_dust_minor <> v_cr_rel - v_cr_conv
       OR p_realized_minor <> v_cr_rel - v_rel THEN
      RAISE EXCEPTION 'customer_credit_application.settlement_changed: the invoice''s outstanding amount or the credit changed since the application was prepared'
        USING ERRCODE = 'P0001';
    END IF;

    -- 11. The application, BEFORE the credit decrement: the writer's own
    --     authority check reads this very row.
    INSERT INTO customer_credit_applications (tenant_id, business_id, id, customer_id, credit_id, invoice_id, application_date,
                                              credit_currency, credit_amount_consumed_minor, credit_to_base_rate,
                                              credit_remaining_before_minor, credit_carrying_base_released_minor,
                                              credit_dust_base_minor, invoice_currency, invoice_amount_applied_minor,
                                              invoice_historical_to_base_rate, ar_released_before_txn_minor,
                                              invoice_carrying_base_released_minor, ar_dust_base_minor, realized_fx_gain_loss_minor,
                                              intent_sha256, business_transaction_id, created_by, binding_source_id)
    VALUES (v_tenant, v_business, p_application_id, v_i.customer_id, p_credit_id, p_invoice_id, p_application_date,
            v_c.currency_code, p_consumed_minor, v_c.credit_to_base_rate,
            p_remaining_before_minor, p_credit_released_minor,
            p_credit_dust_minor, v_i.currency_code, p_applied_minor,
            v_i.source_to_base_rate, p_ar_released_before_minor,
            p_ar_released_minor, p_ar_dust_minor, p_realized_minor,
            v_intent, v_trace, v_actor.actor_user_id, p_application_id);

    -- 12. The credit: both remaining values in ONE decrement, by the one writer.
    PERFORM customer_credit_consume(p_credit_id, p_remaining_before_minor, p_consumed_minor);

    -- 13. Audit and outbox: ids, never an amount.
    INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
    VALUES (v_tenant, v_business, v_actor.actor_user_id, 'customer.credit_applied', 'customer_credit_application', p_application_id::text,
            jsonb_build_object('creditId', p_credit_id, 'invoiceId', p_invoice_id, 'assertionJti', v_actor.jti,
                               'business_transaction_id', v_trace));
    INSERT INTO outbox_events (tenant_id, business_id, type, payload)
    VALUES (v_tenant, v_business, 'customer.credit_applied.v1',
            jsonb_build_object('businessId', v_business, 'applicationId', p_application_id, 'creditId', p_credit_id,
                               'invoiceId', p_invoice_id, 'businessTransactionId', v_trace));
  END IF;

  RETURN QUERY
  SELECT a.id, v_replay FROM customer_credit_applications a WHERE a.business_id = v_business AND a.id = p_application_id;
END;
$$;

COMMENT ON FUNCTION customer_apply_credit(UUID, UUID, UUID, DATE, CHAR(3), BIGINT, BIGINT, BIGINT, BIGINT, CHAR(3), BIGINT, BIGINT, BIGINT, BIGINT, BIGINT) IS
  'P4-S4 (R-86, R-90). First consumes an invctl/1 assertion of kind customer.apply_credit over its own arguments. Under the daftar.customer_credit_application_id key, with the request-only intent (id, credit, invoice, date, consumed, applied): an equal stored intent replays, another is customer_credit_application.idempotency_conflict. Then the shape (inventory.payload_invalid), the invoice FOR UPDATE (invoice.not_found, invoice_settlement.walkin_not_settleable, invoice_settlement.cash_not_settleable, invoice_state_invalid, settlement_changed), the credit FOR UPDATE (customer_credit.not_found, invoice_settlement.customer_mismatch, credit_exhausted, amount_exceeds_credit, settlement_changed), the customer FOR SHARE (inactive allowed: the money is already theirs), the dates (date_before_source, date_in_future), and the AR and credit sides RECOMPUTED at their stored snapshots (amount_exceeds_outstanding, amount_mismatch, amount_below_base_unit, residue_below_base_unit, settlement_changed). Inserts the application, then decrements the credit through customer_credit_consume. The caller posts the customer_credit_application entry. EXECUTE: daftar_app only.';

-- Privileges, then the ownership transfer (the `0068:1277-1308` order).
REVOKE ALL ON FUNCTION customer_collect_payment(UUID, UUID, UUID, UUID, DATE, CHAR(3), BIGINT, UUID, NUMERIC, TEXT, TIMESTAMPTZ, BIGINT, TEXT, UUID, BIGINT, BIGINT, UUID[], UUID[], TEXT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION customer_apply_credit(UUID, UUID, UUID, DATE, CHAR(3), BIGINT, BIGINT, BIGINT, BIGINT, CHAR(3), BIGINT, BIGINT, BIGINT, BIGINT, BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION customer_collect_payment(UUID, UUID, UUID, UUID, DATE, CHAR(3), BIGINT, UUID, NUMERIC, TEXT, TIMESTAMPTZ, BIGINT, TEXT, UUID, BIGINT, BIGINT, UUID[], UUID[], TEXT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[]) TO daftar_app;
GRANT EXECUTE ON FUNCTION customer_apply_credit(UUID, UUID, UUID, DATE, CHAR(3), BIGINT, BIGINT, BIGINT, BIGINT, CHAR(3), BIGINT, BIGINT, BIGINT, BIGINT, BIGINT) TO daftar_app;

ALTER FUNCTION customer_collect_payment(UUID, UUID, UUID, UUID, DATE, CHAR(3), BIGINT, UUID, NUMERIC, TEXT, TIMESTAMPTZ, BIGINT, TEXT, UUID, BIGINT, BIGINT, UUID[], UUID[], TEXT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[], BIGINT[]) OWNER TO daftar_inventory_internal;
ALTER FUNCTION customer_apply_credit(UUID, UUID, UUID, DATE, CHAR(3), BIGINT, BIGINT, BIGINT, BIGINT, CHAR(3), BIGINT, BIGINT, BIGINT, BIGINT, BIGINT) OWNER TO daftar_inventory_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 7. Registrations, LAST (the `0067:2280-2288` / `0077:1701-1707` order). A
--    registry row is a registration of AUTHORITY, and a live authority whose
--    guards are not yet installed is exactly what the house rule refuses — so
--    these go after every table, policy, guard, validator and command above.
--
--    `sort_order` 15, 16 and 17: P4-S2 took 13 and 14 (`0077:1702-1703`).
--    The third is `customer_credit` (R-93) — the surplus is a source in its
--    own right, not a tail on an allocation entry.
--
--    The operation codes are `customer.*` because the op-code pattern
--    `^[a-z]+(\.[a-z_]+)+$` is frozen inside `inventory_payload_digest`
--    (`0054:229`) and forbids an underscore in the FIRST segment: `0074:62-70`
--    proves by probe that `customer.collect_payment` is admitted and
--    `customer_payment.collect` is refused. The source types are the row's own
--    domain, singular — a different namespace with no such constraint, which
--    is why the two deliberately differ.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO accounting_source_types (source_type, lower_bound_policy, upper_bound_policy, description, sort_order) VALUES
  ('customer_payment_allocation', 'none', 'not_after_today',
   'A customer payment allocation: Cr Accounts Receivable at its carrying release / Dr the posting account, the base dust on the receivable, the realized FX on 4900 or 6900 (R-82).', 15),
  ('customer_credit_application', 'none', 'not_after_today',
   'A customer credit applied to an invoice: Cr Accounts Receivable / Dr Customer Credit Liability, each at its own carrying release and base dust, the realized FX on 4900 or 6900 (R-82).', 16),
  ('customer_credit', 'none', 'not_after_today',
   'A customer overpayment surplus: Dr the posting account of its origin payment / Cr Customer Credit Liability at the credit snapshot, no dust and no FX; one entry per credit row (R-93).', 17);
INSERT INTO accounting_operation_kinds (operation_kind, source_type, description) VALUES
  ('post', 'customer_payment_allocation', 'Customer payment allocation; derived by the collect payment command.'),
  ('post', 'customer_credit_application', 'Customer credit application; derived by the apply credit command.'),
  ('post', 'customer_credit', 'Customer overpayment surplus credit; derived by the collect payment command.');

INSERT INTO inventory_operation_kinds (op_code, registered_by) VALUES
  ('customer.collect_payment', 'P4-S4'),
  ('customer.apply_credit', 'P4-S4');

-- ─────────────────────────────────────────────────────────────────────────
-- 8. 0081-E: the end state, read from the LIVE CATALOGUES and never from this
--    file's own statements. A migration that asserts what it just wrote
--    asserts nothing; every claim below is a catalogue read.
-- ─────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  c_relations CONSTANT TEXT[] := ARRAY['payments', 'payment_allocations', 'customer_credits', 'customer_credit_applications'];
  c_source    CONSTANT TEXT[] := ARRAY['accounting_validator', 'business_isolation_delete', 'business_isolation_insert',
                                       'business_isolation_read', 'business_isolation_update', 'inventory_internal_read',
                                       'tenant_membership'];
  c_runtime   CONSTANT TEXT[] := ARRAY['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver',
                                       'daftar_provisioner', 'daftar_reconciler', 'public'];
  c_dml       CONSTANT TEXT[] := ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  c_arith     CONSTANT TEXT[] := ARRAY['supplier_convert_base(bigint,numeric,integer,integer)',
                                       'supplier_ap_release(bigint,bigint,bigint,bigint)',
                                       'supplier_credit_remaining_carrying(bigint,bigint,bigint)'];
  c_inv_fns   CONSTANT TEXT[] := ARRAY['invoice_settlement_verify(uuid,uuid)', 'payment_closure_verify(uuid,uuid)',
                                       'customer_credit_verify(uuid,uuid)', 'payment_guard()', 'payment_complete()',
                                       'payment_allocation_guard()', 'payment_allocation_value_complete()',
                                       'customer_credit_guard()', 'customer_credit_application_guard()',
                                       'customer_credit_application_value_complete()', 'customer_credit_consume(uuid,bigint,bigint)'];
  c_acc_fns   CONSTANT TEXT[] := ARRAY['accounting_customer_payment_allocation_entry_complete()',
                                       'accounting_customer_credit_application_entry_complete()',
                                       'accounting_customer_credit_entry_complete()'];
  c_cmds      CONSTANT REGPROCEDURE[] := ARRAY[
    'customer_collect_payment(uuid,uuid,uuid,uuid,date,character,bigint,uuid,numeric,text,timestamp with time zone,bigint,text,uuid,bigint,bigint,uuid[],uuid[],text[],bigint[],bigint[],bigint[],bigint[],bigint[],bigint[],bigint[])'::regprocedure,
    'customer_apply_credit(uuid,uuid,uuid,date,character,bigint,bigint,bigint,bigint,character,bigint,bigint,bigint,bigint,bigint)'::regprocedure];
  -- R-P4-02's vocabulary with guard G-3's own exemptions: an identity, an
  -- actor, an instant, a classifier or an ordering is not a stored quantity,
  -- because only a stored NUMBER can drift from the journal.
  c_forbidden CONSTANT TEXT := '(^|_)(balance|outstanding|paid|unpaid|due|owed|payable|receivable|settled|refunded|collected|allocated|cogs|cost|debt|debts|overdue|arrears|aging|ageing|reserved|available)($|_)';
  c_instant   CONSTANT TEXT := '_(id|ids|at|date|by|status|kind|type|code|name|currency|seq|no)$';
  v_name      TEXT;
  v_sig       TEXT;
  v_n         INTEGER;
  v_def       TEXT;
  v_actual    TEXT[];
  v_proc      REGPROCEDURE;
  v_role      TEXT;
  v_detail    TEXT;
BEGIN
  -- (1) The four relations exist as plain tables, row security is ENABLED AND
  --     FORCED on every one, and each carries tenant_id and business_id as
  --     real NOT NULL columns — the two dimensions the Phase 4 RLS/FORCE
  --     discovery guard partitions on. Exactly one of them would be a
  --     P4-AL-08 violation and ENABLE+FORCE is not a substitute for either.
  SELECT count(*) INTO v_n FROM pg_class c
   WHERE c.oid = ANY (SELECT ('public.' || x)::regclass FROM unnest(c_relations) x)
     AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity;
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: row security is not enabled and forced on all four P4-S4 relations (found %)', v_n
      USING ERRCODE = 'P0001';
  END IF;
  FOREACH v_name IN ARRAY c_relations LOOP
    IF (SELECT count(*) FROM pg_attribute a
         WHERE a.attrelid = ('public.' || v_name)::regclass AND a.attnum > 0 AND NOT a.attisdropped
           AND a.attname IN ('tenant_id', 'business_id') AND a.attnotnull) <> 2 THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: % does not carry tenant_id and business_id as NOT NULL columns', v_name
        USING ERRCODE = 'P0001';
    END IF;
    -- No stored derived truth, over the LIVE column list (P4-AL-05/06, G-3).
    IF EXISTS (SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = ('public.' || v_name)::regclass AND a.attnum > 0 AND NOT a.attisdropped
                  AND a.attname ~ c_forbidden AND a.attname !~ c_instant) THEN
      RAISE EXCEPTION 'selling.derived_truth_stored: % carries a column of the vocabulary P4-AL-05/06 refuses', v_name
        USING ERRCODE = 'P0001';
    END IF;
    -- No float money anywhere in Phase 4 (P4-AL-15b).
    IF EXISTS (SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = ('public.' || v_name)::regclass AND a.attnum > 0 AND NOT a.attisdropped
                  AND format_type(a.atttypid, NULL) IN ('real', 'double precision', 'money')) THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: % carries a floating point or money column', v_name
        USING ERRCODE = 'P0001';
    END IF;
    -- PUBLIC holds nothing, no runtime principal holds DML, and none holds a
    -- column privilege: every write goes through a routine whose authority was
    -- checked. The one column UPDATE in this file is the internal principal's,
    -- which is not a runtime principal.
    IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) x
                WHERE c.oid = ('public.' || v_name)::regclass
                  AND x.grantee::regrole::text = ANY (c_runtime) AND x.privilege_type = ANY (c_dml)) THEN
      RAISE EXCEPTION 'selling.authority_leak: a runtime principal holds DML on %', v_name USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute a, aclexplode(a.attacl) x
                WHERE a.attrelid = ('public.' || v_name)::regclass AND a.attnum > 0 AND NOT a.attisdropped
                  AND x.grantee::regrole::text = ANY (c_runtime)) THEN
      RAISE EXCEPTION 'selling.authority_leak: a runtime principal holds a column privilege on %', v_name USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- (2) THE POLICY-NAME SETS, read from pg_policy and compared BY NAME: all
  --     four are accounting-source relations and carry EXACTLY the seven. And
  --     the grant beside each policy, because a policy without the grant and a
  --     grant without the policy each read zero rows and pass vacuously.
  FOREACH v_name IN ARRAY c_relations LOOP
    SELECT array_agg(p.polname::text ORDER BY p.polname) INTO v_actual
      FROM pg_policy p WHERE p.polrelid = ('public.' || v_name)::regclass;
    IF v_actual IS DISTINCT FROM c_source THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: % does not carry exactly the seven accounting-source policies (found %)', v_name, v_actual
        USING ERRCODE = 'P0001';
    END IF;
    IF (SELECT pg_get_expr(p.polqual, p.polrelid) FROM pg_policy p
         WHERE p.polrelid = ('public.' || v_name)::regclass AND p.polname = 'business_isolation_read')
       NOT LIKE '%daftar_accounting_internal%' THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: %''s restrictive read shuts the accounting validator out', v_name
        USING ERRCODE = 'P0001';
    END IF;
    -- The tenant policy is the DIRECT form every Phase 4 relation uses
    -- (`0075:442`, `0077:1810-1817`, `0079:634`), never a correlated
    -- `businesses` subselect.
    IF (SELECT pg_get_expr(p.polqual, p.polrelid) FROM pg_policy p
         WHERE p.polrelid = ('public.' || v_name)::regclass AND p.polname = 'tenant_membership')
       NOT LIKE '%tenant_id = (NULLIF(app_tenant()%' THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: %''s tenant policy is not the direct form', v_name USING ERRCODE = 'P0001';
    END IF;
    IF NOT has_table_privilege('daftar_accounting_internal', 'public.' || v_name, 'SELECT')
       OR NOT has_table_privilege('daftar_app', 'public.' || v_name, 'SELECT')
       OR NOT has_table_privilege('daftar_inventory_internal', 'public.' || v_name, 'SELECT') THEN
      RAISE EXCEPTION 'selling.authority_leak: a principal that is judged on or reads % cannot select it', v_name USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- (3) R-84 DEPARTURE A, read from the catalogue: both reducer relations
  --     reach `invoices` through a VALIDATED composite edge naming business_id
  --     on both sides, and that edge targets the PRIMARY KEY (business_id, id)
  --     rather than a three-column key. This asserts the departure was TAKEN,
  --     so the day the Tech Lead rules the other way the assertion changes
  --     with the edge and nobody has to rediscover why it was narrow.
  FOREACH v_name IN ARRAY ARRAY['payment_allocations', 'customer_credit_applications'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conname = v_name || '_invoice_fk' AND c.conrelid = ('public.' || v_name)::regclass
                      AND c.contype = 'f' AND c.convalidated AND c.confrelid = 'public.invoices'::regclass
                      AND c.confdeltype = 'r'
                      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
                             FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
                          = ARRAY['business_id', 'invoice_id']
                      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
                             FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                             JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum)
                          = ARRAY['business_id', 'id']) THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: %''s invoice edge is not the validated two-column RESTRICT edge to invoices (business_id, id) Departure A specifies', v_name
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  -- And the key Departure A declines to add is still ABSENT, so the comment at
  -- each declaration site describes the database and not a wish.
  IF EXISTS (SELECT 1 FROM pg_constraint c
              WHERE c.conrelid = 'public.invoices'::regclass AND c.contype = 'u'
                AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
                       FROM unnest(c.conkey) AS k(attnum)
                       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
                    = ARRAY['business_id', 'customer_id', 'id']) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: invoices now carries the (business_id, id, customer_id) key Departure A defers, so the narrow edge above is the wrong one'
      USING ERRCODE = 'P0001';
  END IF;

  -- (4) The THREE deferred BINDING edges and the generated source-type
  --     constants: the all-or-nothing mechanism of R-91, and R-93's surplus
  --     credit under the same mechanism. A source row cannot commit without
  --     its own journal entry and the entry cannot commit without the
  --     binding, so one entry per row is structural.
  FOREACH v_name IN ARRAY ARRAY['payment_allocations', 'customer_credit_applications', 'customer_credits'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conname = v_name || '_binding_fk' AND c.conrelid = ('public.' || v_name)::regclass
                      AND c.contype = 'f' AND c.condeferrable AND c.condeferred
                      AND c.confrelid = 'public.accounting_source_bindings'::regclass) THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: %_binding_fk is not the deferred binding edge', v_name USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                    WHERE a.attrelid = ('public.' || v_name)::regclass AND a.attname = 'accounting_source_type'
                      AND NOT a.attisdropped AND a.attgenerated = 's') THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: %.accounting_source_type is not a stored generated constant', v_name
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- (5) R-88's level uniqueness, as real UNIQUE constraints over real columns,
  --     and R-83's enforcement as real DEFERRED CONSTRAINT TRIGGERS. Both are
  --     needed and neither is the other: the UNIQUEs are per-relation
  --     backstops, the triggers carry the cross-relation law.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conname = 'payment_allocations_level_uq' AND c.conrelid = 'public.payment_allocations'::regclass AND c.contype = 'u')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                     WHERE c.conname = 'customer_credit_applications_invoice_level_uq'
                       AND c.conrelid = 'public.customer_credit_applications'::regclass AND c.contype = 'u')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                     WHERE c.conname = 'customer_credit_applications_level_uq'
                       AND c.conrelid = 'public.customer_credit_applications'::regclass AND c.contype = 'u') THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: a P4-S4 level-uniqueness constraint is missing' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t
       WHERE NOT t.tgisinternal AND t.tgconstraint <> 0 AND t.tgdeferrable AND t.tginitdeferred
         AND t.tgname IN ('payments_complete', 'payment_allocations_value_complete',
                          'customer_credit_applications_value_complete',
                          'journal_entries_customer_payment_allocation_complete',
                          'journal_entries_customer_credit_application_complete',
                          'journal_entries_customer_credit_complete')) <> 6 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the six P4-S4 deferred constraint triggers are not all installed, deferrable and initially deferred'
      USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t
       WHERE NOT t.tgisinternal AND t.tgname IN ('payments_guard', 'payment_allocations_guard', 'customer_credits_guard',
                                                 'customer_credit_applications_guard')
         AND t.tgtype = 31) <> 4 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the four P4-S4 row guards are not BEFORE INSERT OR UPDATE OR DELETE FOR EACH ROW'
      USING ERRCODE = 'P0001';
  END IF;

  -- (6) R-81: THE ARITHMETIC ROUTINES THIS FILE CALLS ARE THE ACCEPTED ONES
  --     AND UNCHANGED. Their bodies' digests compare EQUAL to the capture
  --     taken before anything in this file ran, so no second body of the
  --     settlement arithmetic was introduced and no accepted one was replaced.
  IF (SELECT string_agg(encode(digest(p.prosrc, 'sha256'), 'hex'), '|' ORDER BY p.oid::regprocedure::text)
        FROM pg_proc p WHERE p.oid = ANY (ARRAY(SELECT x::regprocedure FROM unnest(c_arith) x)))
     IS DISTINCT FROM current_setting('daftar.p4s4_pre_arithmetic', true) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0081 changed the body of an accepted settlement arithmetic primitive'
      USING ERRCODE = 'P0001';
  END IF;
  -- And there is NO SECOND BODY of that arithmetic: nothing in this file
  -- created a routine of a settlement-arithmetic shape under another name.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public'
                AND p.proname ~ '(convert_base|ap_release|ar_release|remaining_carrying|half_even)$'
                AND p.oid <> ALL (ARRAY(SELECT x::regprocedure::oid FROM unnest(c_arith) x))
                AND p.proname <> 'inventory_half_even') THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: a second body of the settlement arithmetic exists under another name'
      USING ERRCODE = 'P0001';
  END IF;
  -- Every call site in this file's own routines names one of the three.
  FOREACH v_name IN ARRAY c_inv_fns LOOP
    v_def := (SELECT p.prosrc FROM pg_proc p WHERE p.oid = v_name::regprocedure);
    IF v_def ~ 'inventory_half_even\s*\(' AND v_name NOT IN ('invoice_settlement_verify(uuid,uuid)') THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: % rounds for itself instead of calling the accepted primitives', v_name
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- (7) Every routine this file created in the inventory bracket is
  --     internal-owned SECURITY DEFINER with the pinned path and no grantee;
  --     every one in the accounting bracket is accounting-owned the same way.
  FOREACH v_name IN ARRAY c_inv_fns LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                    WHERE p.oid = v_name::regprocedure AND p.prosecdef AND r.rolname = 'daftar_inventory_internal'
                      AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']) THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: % is not an internal-owned SECURITY DEFINER with the pinned path', v_name
        USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
                WHERE p.oid = v_name::regprocedure AND x.grantee <> p.proowner) THEN
      RAISE EXCEPTION 'selling.authority_leak: % has a grantee, and a guard, verifier or writer has none', v_name USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  FOREACH v_name IN ARRAY c_acc_fns LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                    WHERE p.oid = v_name::regprocedure AND p.prosecdef AND r.rolname = 'daftar_accounting_internal'
                      AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']) THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: % is not an accounting-owned SECURITY DEFINER with the pinned path', v_name
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  -- Neither bracket's CREATE authority was left behind.
  IF has_schema_privilege('daftar_inventory_internal', 'public', 'CREATE')
     OR has_schema_privilege('daftar_accounting_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'selling.authority_leak: an internal principal still holds CREATE on schema public' USING ERRCODE = 'P0001';
  END IF;

  -- (8) THE EXECUTE PRIVILEGES ARE EXACTLY THE INTENDED ROLES AND NO OTHER
  --     GRANTEE. `daftar_app` reaches each command and nobody else does;
  --     nobody at all reaches the verifiers, the guards or the one credit
  --     writer (asserted in (7) above).
  FOREACH v_proc IN ARRAY c_cmds LOOP
    IF NOT has_function_privilege('daftar_app', v_proc, 'EXECUTE') THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: daftar_app cannot reach %', v_proc USING ERRCODE = 'P0001';
    END IF;
    FOREACH v_role IN ARRAY ARRAY['daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver', 'daftar_provisioner',
                                  'daftar_reconciler', 'public', 'daftar_accounting_internal'] LOOP
      IF has_function_privilege(v_role, v_proc, 'EXECUTE') THEN
        RAISE EXCEPTION 'selling.authority_leak: % may call %', v_role, v_proc USING ERRCODE = 'P0001';
      END IF;
    END LOOP;
    SELECT string_agg(x.grantee::regrole::text, ',' ORDER BY x.grantee::regrole::text) INTO v_detail
    FROM pg_proc p, aclexplode(p.proacl) x
    WHERE p.oid = v_proc AND x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner;
    IF v_detail IS DISTINCT FROM 'daftar_app' THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: % must be executable by daftar_app only, found %', v_proc, v_detail
        USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                    WHERE p.oid = v_proc AND p.prosecdef AND r.rolname = 'daftar_inventory_internal'
                      AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']) THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: % is not an internal-owned SECURITY DEFINER with the pinned path', v_proc
        USING ERRCODE = 'P0001';
    END IF;
    -- Each command's FIRST STATEMENT consumes an invctl/1 assertion over its
    -- own arguments, which is what makes it a signed entry routine rather
    -- than a function anybody holding EXECUTE could drive.
    IF (SELECT p.prosrc FROM pg_proc p WHERE p.oid = v_proc) NOT LIKE '%inventory_assertion_consume(%' THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: % does not consume an invctl/1 assertion', v_proc USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- (9) SEAM S-P4-03 IS CLOSED, in the LIVE catalogue: the reader-of-record
  --     reads both relations that now settle an invoice, and still reads the
  --     settlement mode `0080` taught it.
  v_def := pg_get_functiondef(to_regprocedure('public.invoice_outstanding(UUID, UUID)'));
  IF v_def NOT LIKE '%payment_allocations%' OR v_def NOT LIKE '%customer_credit_applications%'
     OR v_def NOT LIKE '%settlement_mode%' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the live invoice_outstanding does not read both P4-S4 reducers and its sale''s settlement mode'
      USING ERRCODE = 'P0001';
  END IF;
  -- ONLY THE BODY MOVED: owner, SECURITY INVOKER, pinned path and the whole
  -- ACL compare EQUAL to the capture taken before the replacement.
  IF (SELECT format('%s|%s|%s|%s', p.proowner::regrole, p.prosecdef, coalesce(p.proconfig::text, '-'), coalesce(p.proacl::text, '-'))
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.invoice_outstanding(UUID, UUID)'))
     IS DISTINCT FROM current_setting('daftar.p4s4_pre_invoice_outstanding', true) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the replacement changed the owner, security, path or ACL of invoice_outstanding'
      USING ERRCODE = 'P0001';
  END IF;
  -- And the accepted configuration stated ABSOLUTELY, not only as "unchanged":
  -- a capture compared against itself proves nothing if the function was
  -- already wrong before this file ran.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = to_regprocedure('public.invoice_outstanding(UUID, UUID)')
                    AND p.provolatile = 's' AND NOT p.prosecdef
                    AND EXISTS (SELECT 1 FROM unnest(p.proconfig) AS c WHERE c = 'search_path=pg_catalog, public, pg_temp')) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: invoice_outstanding is no longer a STABLE, SECURITY INVOKER routine with its pinned search_path'
      USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT array_agg(x.grantee::regrole::text ORDER BY x.grantee::regrole::text)
        FROM pg_proc p, aclexplode(p.proacl) x
       WHERE p.oid = to_regprocedure('public.invoice_outstanding(UUID, UUID)')
         AND x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner)
     IS DISTINCT FROM ARRAY['daftar_app', 'daftar_inventory_internal'] THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: EXECUTE on invoice_outstanding is not exactly the two accepted roles'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
              WHERE p.oid = to_regprocedure('public.invoice_outstanding(UUID, UUID)') AND x.grantee = 0) THEN
    RAISE EXCEPTION 'selling.authority_leak: PUBLIC holds a privilege on invoice_outstanding' USING ERRCODE = 'P0001';
  END IF;
  -- The three readers ABOVE it are BYTE-IDENTICAL: the correction reaches them
  -- through composition, and a copy of this subtraction in any of them would
  -- be a second place to keep it right.
  IF (SELECT pg_catalog.md5(pg_catalog.string_agg(pg_get_functiondef(f.oid), '|' ORDER BY f.oid))
        FROM (SELECT to_regprocedure('public.invoice_settlement_state(UUID, UUID)') AS oid
              UNION ALL SELECT to_regprocedure('public.customer_ar_outstanding(UUID, UUID)')
              UNION ALL SELECT to_regprocedure('public.customer_ar_aging(UUID, UUID, DATE, INTEGER[])')) f)
     IS DISTINCT FROM current_setting('daftar.p4s4_pre_readers_above', true) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: a reader above invoice_outstanding was changed by 0081' USING ERRCODE = 'P0001';
  END IF;

  -- (10) THE REGISTRATIONS, and P4-AL-47 / seam S-P4-02: each new source type
  --      is named in the generic reversal guard's always-refused list IN THIS
  --      SAME FILE, so `daftar_app` cannot reverse any of the three entries
  --      through the generic path. The frozen substring every earlier
  --      migration asserts is still a prefix of the list, because the three
  --      names were APPENDED.
  IF (SELECT count(*) FROM accounting_source_types t
       WHERE t.source_type IN ('customer_payment_allocation', 'customer_credit_application', 'customer_credit')
         AND t.lower_bound_policy = 'none' AND t.upper_bound_policy = 'not_after_today') <> 3
     OR (SELECT count(*) FROM accounting_source_types t WHERE t.sort_order IN (15, 16, 17)) <> 3 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the three P4-S4 accounting source types are not registered at sort order 15, 16 and 17'
      USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(*) FROM accounting_operation_kinds k
       WHERE k.operation_kind = 'post'
         AND k.source_type IN ('customer_payment_allocation', 'customer_credit_application', 'customer_credit')) <> 3 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the three P4-S4 accounting operation kinds are not registered' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(*) FROM inventory_operation_kinds k
       WHERE k.op_code IN ('customer.collect_payment', 'customer.apply_credit') AND k.registered_by = 'P4-S4') <> 2 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the two P4-S4 operation kinds are not registered by P4-S4' USING ERRCODE = 'P0001';
  END IF;
  v_def := (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.accounting_reversals_20_domain_source_guard()'));
  IF v_def NOT LIKE '%''customer_payment_allocation''%' OR v_def NOT LIKE '%''customer_credit_application''%'
     OR v_def NOT LIKE '%''customer_credit''%'
     OR v_def NOT LIKE '%''supplier_payment'', ''supplier_credit_allocation'', ''supplier_refund''%'
     OR v_def NOT LIKE '%''sale'', ''invoice'', ''customer_payment_allocation'', ''customer_credit_application'', ''customer_credit''%' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the generic reversal guard does not name all three P4-S4 source types appended after the accepted list'
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                  WHERE p.oid = to_regprocedure('public.accounting_reversals_20_domain_source_guard()')
                    AND r.rolname = 'daftar_accounting_internal' AND p.prosecdef) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the reversal guard is no longer accounting-owned SECURITY DEFINER' USING ERRCODE = 'P0001';
  END IF;

  -- (11) R-85 DEPARTURE B, asserted as TAKEN: `payment_method_guard()`'s body
  --      is BYTE-IDENTICAL to what it was before this file ran, so the
  --      Phase 3 cross-phase surface was not touched and the digest recorded
  --      in `supplier_settlement_guard_gaps()` (`0067:1801`, `0068:1331`) is
  --      still true of the database. The disclosed consequence — a method's
  --      posting account is still mutable once CUSTOMER payments exist — is
  --      recorded as an open item, and the day it closes this assertion
  --      changes with it.
  IF (SELECT encode(digest(p.prosrc, 'sha256'), 'hex') FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.payment_method_guard()'))
     IS DISTINCT FROM current_setting('daftar.p4s4_pre_method_guard', true) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0081 changed payment_method_guard(), which Departure B says it does not touch'
      USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.payment_method_guard()')) LIKE '%FROM payments %' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: payment_method_guard() now reads payments, so Departure B was not taken as written'
      USING ERRCODE = 'P0001';
  END IF;

  -- (12) Nothing else moved. 0000-0080 are untouched by this file, which is
  --      checked where it can be checked from inside the database: the three
  --      arithmetic primitives (6), the Phase 3 method guard (11), the readers
  --      above the reader-of-record (9), and the frozen prefix of the reversal
  --      list (10). The manifest and `frozenThrough` are NOT moved here: only
  --      an acceptance commit freezes a digest, so `0081` stays a CANDIDATE
  --      exactly as `0080` is.
  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
         AND c.relname IN ('payments', 'payment_allocations', 'customer_credits', 'customer_credit_applications')) <> 4 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the four P4-S4 relations are not all plain tables in public' USING ERRCODE = 'P0001';
  END IF;
END
$post$;
