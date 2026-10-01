-- 0075_phase4_customers_invoices_numbering.sql
-- Phase 4 / P4-S1 — the customer, invoice-document and numbering primitives
-- (the Tech Lead's P4-S0 FINAL CORRECTIVE SEAL DIRECTIVE §17-§20, step 6 of
-- the hard order; docs/PHASE_4_ARCHITECTURE_LOCK.md P4-AL-08, P4-AL-09,
-- P4-AL-11, P4-AL-12, P4-AL-16, P4-AL-24, P4-AL-31, P4-AL-38, P4-AL-44).
--
-- Migrations 0000-0073 are FROZEN and untouched. 0074 carried the four
-- registry widenings and nothing else of substance (P4-AL-84); this is the
-- first Phase 4 migration to create a relation.
--
-- ── What this file does ─────────────────────────────────────────────────
--
--   1. customers, customer_contacts, invoices, invoice_items and
--      invoice_sequences: five relations, every one carrying tenant_id and
--      business_id as real columns (P4-AL-08), every edge between two
--      commercial rows a composite foreign key that names business_id on
--      both sides (P4-AL-09).
--   2. Row security ENABLEd and FORCEd on all five, with the six policies of
--      an ordinary relation and the seventh, accounting_validator, on
--      invoices — the accounting-source relation (P4-AL-38 as corrected by
--      TL-P4-S1-C2). The tenant policy takes the DIRECT
--      `tenant_id = nullif(app_tenant(), '')::uuid` form that 0052 adopted
--      after measurement, never 0063's correlated subselect.
--   3. The lifecycle guards, in the slice that introduces the tables rather
--      than as a later hardening step (P4-AL-46): no delete, an identity that
--      is final, a status that only ever moves draft -> open -> void, posted
--      money that never changes, and the deferred walk-in constraint trigger
--      that refuses a receivable line behind a null customer (P4-AL-11).
--   4. Yearly document numbering: invoice_sequences is a row per
--      (business_id, document_kind, period) that exists to BE the lock and to
--      hold the format. There is no counter column and no PostgreSQL
--      sequence (P4-AL-31); the ordinal is allocated as max+1 under this
--      row's lock, backed by invoices_number_uq.
--   5. Four read functions: customer_ar_outstanding, customer_ar_aging,
--      invoice_outstanding, invoice_settlement_state — the readers-of-record
--      of P4-AL-05's derived column, SECURITY INVOKER by the
--      purchase_ap_outstanding precedent.
--   6. 0075-E: the end state, asserted against the live catalogues.
--
-- ── What this file does NOT do ──────────────────────────────────────────
--
--   No registry row, in any registry. No accounting source type: `invoice` is
--   registered by the slice that can post one, because
--   accounting_source_bindings.source_type carries a foreign key to
--   accounting_source_types and the registration would otherwise be
--   unreachable (P4-AL-47 binds the widening of the reversal guard's list to
--   the same migration that registers the type). No MIGRATION_MANIFEST entry
--   (TL-P4-S1-C8). No DML privilege for any principal, on any of the five
--   relations: daftar_app holds SELECT and EXECUTE and nothing else
--   (P4-AL-38), so in P4-S1 these relations are readable and, by
--   construction, empty. No table of a later slice — no sales, sale_items,
--   payments, credit_notes or pos_* relation (P4-AL-86). No tax: tax_minor
--   exists on both money-bearing relations with CHECK (tax_minor = 0), and
--   OD-03 stays open (P4-AL-44).
--
-- ── Header rules (P4-S1) ───────────────────────────────────────────────
--
--   R-P4-01 EVERY EDGE CARRIES THE BUSINESS (P4-AL-09). A reference between
--        two commercial rows names business_id on both sides, so a
--        cross-business binding is not representable. MATCH SIMPLE is not a
--        hole, because business_id is independently constrained on every one
--        of these relations by FOREIGN KEY (tenant_id, business_id)
--        REFERENCES businesses (tenant_id, id) over two NOT NULL columns.
--   R-P4-02 NO STORED DERIVED TRUTH (P4-AL-05, P4-AL-06). No balance, paid,
--        outstanding, due, owed, receivable, settled or collected column
--        anywhere in this file. An invoice's settlement is read through
--        invoice_outstanding and invoice_settlement_state; a customer's
--        receivable through customer_ar_outstanding. invoices.status is
--        lifecycle only (P4-AL-24).
--   R-P4-03 NO COUNTER AND NO SEQUENCE (P4-AL-31). A stored counter is a
--        derived number and therefore a second truth; a PostgreSQL sequence
--        is non-transactional and leaves gaps a legal document number may
--        not have; and a counter column takes the same lock as max+1, so it
--        buys no concurrency whatever.
--   R-P4-04 THE STATE MACHINE IS A PHYSICAL SHAPE (the 0047 / stocktake
--        pattern, as 0063:260 names it). One CHECK enumerates each status
--        with every column that must be null or non-null in it.
--   R-P4-05 GRANT BEFORE OWNER, AND THE CREATE BRACKET (P4-AL-39,
--        [[daftar-grant-before-owner]]). PUBLIC's EXECUTE is revoked, the
--        runtime grants issued and the triggers created while the migrator
--        still owns each function; only then is ownership handed over. A
--        GRANT by a non-owner without grant option is a WARNING, not an
--        error, so the reverse order would silently grant nothing on a
--        managed deployment.
--   R-P4-06 A GUARD THAT READS current_user RUNS AS THE WRITER
--        ([[daftar-a-guard-that-asks-who-must-run-as-the-writer]]). None of
--        the guards below authorizes by current_user: the authority is the
--        GRANT, and the trigger carries the invariant. They are therefore
--        SECURITY DEFINER with an internal NOLOGIN owner and the pinned
--        path, exactly as suppliers_no_delete and suppliers_revision_guard
--        are, and the P3-S8 definer law (T-05) judges them by that standard.
--   R-P4-07 THE READ FUNCTIONS ARE SECURITY INVOKER. daftar_app already
--        holds SELECT on these five relations, so a definer read would
--        bypass their row security and grant new authority for nothing.
--        purchase_ap_outstanding is the precedent: invoker, STABLE, pinned
--        path, EXECUTE to daftar_app and daftar_inventory_internal. Clauses
--        1, 2 and 7 of T-05 apply to definer routines only.
--   R-P4-08 THE LIVE CATALOGUE IS THE POLICY
--        ([[daftar-the-live-catalogue-is-the-policy]]). 0075-E reads
--        pg_class, pg_policy, pg_constraint, pg_proc and pg_trigger, never
--        the migration that wrote them.
--
-- ── Three seams this slice leaves open, deliberately and by name ────────
--
--   S-P4-01 invoices.sale_id carries no foreign key, because `sales` is
--        P4-S2's relation and P4-AL-86 refuses a later slice's table here.
--        The seam is safe rather than merely unenforced: P4-S1 grants no DML
--        to any principal and ships no command, so no invoice row can exist,
--        and P4-S2's ADD CONSTRAINT invoices_sale_fk FOREIGN KEY
--        (business_id, sale_id) REFERENCES sales (business_id, id) validates
--        over an empty table.
--   S-P4-02 the accounting source type `invoice` is not registered, for the
--        reason stated above. invoices.accounting_source_type and the
--        deferred invoices_binding_fk exist now, so the seam is a
--        registration, not a re-modelling.
--   S-P4-03 invoice_outstanding subtracts nothing, because nothing that
--        settles an invoice exists yet. It is not a claim that nothing ever
--        will: the permanent test that accompanies this migration discovers
--        the settlement relations FROM THE SCHEMA and requires this routine's
--        body to name each one that exists, so the day P4-S2 creates
--        payment_allocations the test turns red until the routine is
--        replaced ([[daftar-every-journal-writer-equally-protected]]).
--
--   All three are declared in scripts/phase4-s1-gate.ts, which fails if a
--   later Phase 4 migration closes one without removing its declaration, or
--   leaves one declared past the slice that owns it.
--
-- ── One narrowing, pending a Tech Lead ruling ───────────────────────────
--
--   The read surface types invoices.document_kind as 'invoice' | 'credit_note'
--   and reads the credit-note series' max(number_seq) from invoices, while
--   P4-AL-08 makes credit_notes its own P4-S5 relation. P4-S1 implements the
--   NARROWER reading, following the lock's own precedent for an unresolved
--   item: document_kind is CHECKed to 'invoice' here, and the day credit
--   notes are numbered in this series the widening is one migration dropping
--   one CHECK — the same shape as P4-AL-44's tax CHECK. A union type is
--   satisfied by a subset, so no response can carry a value its own DTO
--   forbids in the meantime.

-- ─────────────────────────────────────────────────────────────────────────
-- 0. Preconditions: the 0074 head, the widened registries, and none of the
--    five relations already present.
-- ─────────────────────────────────────────────────────────────────────────
DO $pre$
DECLARE
  c_new CONSTANT TEXT[] := ARRAY['customers', 'customer_contacts', 'invoices', 'invoice_items', 'invoice_sequences'];
  v_name TEXT;
BEGIN
  FOREACH v_name IN ARRAY c_new LOOP
    IF to_regclass('public.' || v_name) IS NOT NULL THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: % already exists, so 0075 is not the migration that creates it', v_name
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- The four widenings of 0074 are the reason a Phase 4 registrant is
  -- expressible at all. 0075 registers nothing, but it applies on that head
  -- only, so a history missing 0074 is refused here rather than three
  -- migrations later.
  IF (SELECT count(*) FROM pg_constraint c
       WHERE c.conname IN ('inventory_operation_kinds_registered_by_check', 'stock_movement_kinds_registered_by_check',
                           'stock_source_types_registered_by_check', 'inventory_operation_movement_kinds_registered_by_check')
         AND pg_get_constraintdef(c.oid) LIKE '%P[0-9]+-S[0-9]+%') <> 4 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0075 applies on the 0074 head (the four widened registered_by CHECKs) only'
      USING ERRCODE = 'P0001';
  END IF;

  -- The parents every composite edge below names, and the registries the
  -- accounting quartet binds to.
  IF to_regclass('public.businesses') IS NULL OR to_regclass('public.branches') IS NULL
     OR to_regclass('public.products') IS NULL OR to_regclass('public.product_variants') IS NULL
     OR to_regclass('public.currencies') IS NULL OR to_regclass('public.accounting_fx_rates') IS NULL
     OR to_regclass('public.accounting_source_bindings') IS NULL OR to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: a parent relation 0075 references is missing' USING ERRCODE = 'P0001';
  END IF;

  -- A non-regression probe: no principal may already reach a Phase 4
  -- selling relation's name through a leftover object.
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname IN ('customer_ar_outstanding', 'customer_ar_aging',
                                                          'invoice_outstanding', 'invoice_settlement_state')) THEN
    RAISE EXCEPTION 'selling.authority_leak: a read function 0075 creates already exists, so its ACL is not reviewable'
      USING ERRCODE = 'P0001';
  END IF;
END
$pre$;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The customer.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE customers (
  tenant_id               UUID NOT NULL,
  business_id             UUID NOT NULL,
  id                      UUID NOT NULL,
  name                    TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200 AND name = btrim(name)),
  phone                   TEXT CHECK (phone IS NULL OR (char_length(phone) BETWEEN 1 AND 40 AND phone = btrim(phone))),
  email                   TEXT CHECK (email IS NULL OR (char_length(email) BETWEEN 3 AND 254 AND email = btrim(email))),
  notes                   TEXT CHECK (notes IS NULL OR (char_length(notes) BETWEEN 1 AND 1000 AND notes = btrim(notes))),
  status                  TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  revision                INTEGER NOT NULL CHECK (revision >= 1),
  create_intent_sha256    TEXT NOT NULL CHECK (create_intent_sha256 ~ '^[0-9a-f]{64}$'),
  last_intent_sha256      TEXT NOT NULL CHECK (last_intent_sha256 ~ '^[0-9a-f]{64}$'),
  business_transaction_id UUID NOT NULL,
  created_by              UUID NOT NULL REFERENCES users (id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by              UUID NOT NULL REFERENCES users (id),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  CONSTRAINT customers_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id)
);
REVOKE ALL ON customers FROM PUBLIC;

-- The customer list page is a keyset walk in name order (S-2).
CREATE INDEX customers_name_idx ON customers (business_id, name, id);

CREATE TABLE customer_contacts (
  tenant_id               UUID NOT NULL,
  business_id             UUID NOT NULL,
  customer_id             UUID NOT NULL,
  id                      UUID NOT NULL,
  contact_no              INTEGER NOT NULL CHECK (contact_no >= 1),
  name                    TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200 AND name = btrim(name)),
  phone                   TEXT CHECK (phone IS NULL OR (char_length(phone) BETWEEN 1 AND 40 AND phone = btrim(phone))),
  email                   TEXT CHECK (email IS NULL OR (char_length(email) BETWEEN 3 AND 254 AND email = btrim(email))),
  notes                   TEXT CHECK (notes IS NULL OR (char_length(notes) BETWEEN 1 AND 1000 AND notes = btrim(notes))),
  is_primary              BOOLEAN NOT NULL DEFAULT false,
  business_transaction_id UUID NOT NULL,
  created_by              UUID NOT NULL REFERENCES users (id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  CONSTRAINT customer_contacts_no_uq UNIQUE (business_id, customer_id, contact_no),
  CONSTRAINT customer_contacts_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT customer_contacts_customer_fk FOREIGN KEY (business_id, customer_id) REFERENCES customers (business_id, id) ON DELETE RESTRICT
);
REVOKE ALL ON customer_contacts FROM PUBLIC;

-- At most one primary contact per customer (the branches_one_default shape).
CREATE UNIQUE INDEX customer_contacts_one_primary ON customer_contacts (business_id, customer_id) WHERE is_primary;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The invoice document, its lines, and the numbering row.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE invoices (
  tenant_id               UUID NOT NULL,
  business_id             UUID NOT NULL,
  id                      UUID NOT NULL,
  sale_id                 UUID NOT NULL,
  customer_id             UUID,
  branch_id               UUID NOT NULL,
  document_kind           TEXT NOT NULL CONSTRAINT invoices_document_kind_ck CHECK (document_kind = 'invoice'),
  document_number         TEXT NOT NULL CHECK (char_length(document_number) BETWEEN 1 AND 64 AND document_number = btrim(document_number)),
  number_seq              BIGINT NOT NULL CHECK (number_seq >= 1),
  period                  TEXT NOT NULL CHECK (period ~ '^[0-9]{4}$'),
  issue_date              DATE NOT NULL,
  due_date                DATE,
  currency_code           CHAR(3) NOT NULL,
  status                  TEXT NOT NULL CHECK (status IN ('draft', 'open', 'void')),
  notes                   TEXT CHECK (notes IS NULL OR (char_length(notes) BETWEEN 1 AND 1000 AND notes = btrim(notes))),
  subtotal_txn_minor      BIGINT NOT NULL CHECK (subtotal_txn_minor BETWEEN 0 AND 1000000000000000000),
  discount_txn_minor      BIGINT NOT NULL CHECK (discount_txn_minor BETWEEN 0 AND 1000000000000000000),
  tax_minor               BIGINT NOT NULL DEFAULT 0 CONSTRAINT invoices_tax_policy_absent_ck CHECK (tax_minor = 0),
  total_txn_minor         BIGINT NOT NULL CHECK (total_txn_minor BETWEEN 1 AND 1000000000000000000),
  total_base_minor        BIGINT NOT NULL CHECK (total_base_minor BETWEEN 1 AND 1000000000000000000),
  source_to_base_rate     NUMERIC(20,10) NOT NULL CHECK (source_to_base_rate > 0),
  rate_source             TEXT NOT NULL CHECK (rate_source IN ('base', 'manual', 'provider')),
  rate_timestamp          TIMESTAMPTZ NOT NULL CHECK (date_trunc('second', rate_timestamp) = rate_timestamp),
  fx_rate_id              UUID,
  customer_name_snapshot  TEXT CHECK (customer_name_snapshot IS NULL
                                      OR (char_length(customer_name_snapshot) BETWEEN 1 AND 200 AND customer_name_snapshot = btrim(customer_name_snapshot))),
  customer_phone_snapshot TEXT CHECK (customer_phone_snapshot IS NULL
                                      OR (char_length(customer_phone_snapshot) BETWEEN 1 AND 40 AND customer_phone_snapshot = btrim(customer_phone_snapshot))),
  issue_intent_sha256     TEXT NOT NULL CHECK (issue_intent_sha256 ~ '^[0-9a-f]{64}$'),
  void_intent_sha256      TEXT CHECK (void_intent_sha256 IS NULL OR void_intent_sha256 ~ '^[0-9a-f]{64}$'),
  voided_by               UUID REFERENCES users (id),
  voided_at               TIMESTAMPTZ,
  business_transaction_id UUID NOT NULL,
  created_by              UUID NOT NULL REFERENCES users (id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  accounting_source_type  TEXT NOT NULL GENERATED ALWAYS AS ('invoice') STORED,
  binding_source_id       UUID,
  PRIMARY KEY (business_id, id),
  -- The series, and the rendered number, each unique within the business:
  -- the key of both carries business_id, so two businesses of one tenant
  -- hold independent series and no tenant-level mixing is expressible
  -- (P4-AL-31, GOLD-48).
  CONSTRAINT invoices_number_uq UNIQUE (business_id, document_kind, period, number_seq),
  CONSTRAINT invoices_document_number_uq UNIQUE (business_id, document_kind, document_number),
  CONSTRAINT invoices_sale_uq UNIQUE (business_id, sale_id, document_kind),
  -- The period is the calendar year of the issue date, which is what makes
  -- the ordinal's restart and the rendered number agree (TL-P4-S1-C9).
  CONSTRAINT invoices_period_ck CHECK (issue_date >= make_date(period::integer, 1, 1)
                                       AND issue_date < make_date(period::integer + 1, 1, 1)),
  CONSTRAINT invoices_total_ck CHECK (total_txn_minor = subtotal_txn_minor - discount_txn_minor + tax_minor),
  CONSTRAINT invoices_discount_ck CHECK (discount_txn_minor <= subtotal_txn_minor),
  CONSTRAINT invoices_rate_shape_ck CHECK ((rate_source = 'base') = (fx_rate_id IS NULL AND source_to_base_rate = 1)),
  CONSTRAINT invoices_binding_identity_ck CHECK (binding_source_id IS NULL OR binding_source_id = id),
  -- A draft owes no binding; a document that has been posted owes one and
  -- keeps it, because voiding is a new reversal entry and never the removal
  -- of the original posting (P4-AL-10, P4-AL-16 / TL-P4-S1-C6).
  CONSTRAINT invoices_binding_owed_ck CHECK ((status IN ('open', 'void')) = (binding_source_id IS NOT NULL)),
  -- The state machine as a physical shape (R-P4-04). void is the terminal
  -- state of a POSTED document: a draft is not voided, it is left.
  CONSTRAINT invoices_state_ck CHECK (
    (status = 'draft'
       AND void_intent_sha256 IS NULL AND voided_by IS NULL AND voided_at IS NULL)
    OR (status = 'open'
       AND void_intent_sha256 IS NULL AND voided_by IS NULL AND voided_at IS NULL)
    OR (status = 'void'
       AND void_intent_sha256 IS NOT NULL AND voided_by IS NOT NULL AND voided_at IS NOT NULL)
  ),
  -- A walk-in sale carries a null customer_id and no snapshot of a customer
  -- who does not exist; it also carries no credit terms, because a due date
  -- with nobody to owe it is what a receivable behind a null customer looks
  -- like on the way in (P4-AL-11).
  CONSTRAINT invoices_customer_snapshot_ck CHECK ((customer_id IS NULL) = (customer_name_snapshot IS NULL)),
  CONSTRAINT invoices_walkin_terms_ck CHECK (customer_id IS NOT NULL OR due_date IS NULL),
  CONSTRAINT invoices_due_date_ck CHECK (due_date IS NULL OR due_date >= issue_date),
  CONSTRAINT invoices_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT invoices_customer_fk FOREIGN KEY (business_id, customer_id) REFERENCES customers (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT invoices_branch_fk FOREIGN KEY (business_id, branch_id) REFERENCES branches (business_id, id),
  CONSTRAINT invoices_currency_fk FOREIGN KEY (currency_code) REFERENCES currencies (code),
  CONSTRAINT invoices_fx_rate_fk FOREIGN KEY (business_id, fx_rate_id) REFERENCES accounting_fx_rates (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT invoices_binding_fk
    FOREIGN KEY (business_id, accounting_source_type, binding_source_id)
    REFERENCES accounting_source_bindings (business_id, source_type, source_id)
    DEFERRABLE INITIALLY DEFERRED
);
REVOKE ALL ON invoices FROM PUBLIC;

-- The customer receivable, aging and open-invoice reads (S-4, S-6, S-7) all
-- walk one customer's invoices in issue order.
CREATE INDEX invoices_customer_idx ON invoices (business_id, customer_id, issue_date, id);
-- The invoice list page is a keyset walk in issue order (S-8).
CREATE INDEX invoices_issue_idx ON invoices (business_id, issue_date, id);

CREATE TABLE invoice_items (
  tenant_id            UUID NOT NULL,
  business_id          UUID NOT NULL,
  invoice_id           UUID NOT NULL,
  id                   UUID NOT NULL,
  line_no              INTEGER NOT NULL CHECK (line_no >= 1),
  product_id           UUID NOT NULL,
  variant_id           UUID,
  name_snapshot        TEXT NOT NULL CHECK (char_length(name_snapshot) BETWEEN 1 AND 200 AND name_snapshot = btrim(name_snapshot)),
  quantity             NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  unit_price_txn_minor BIGINT NOT NULL CHECK (unit_price_txn_minor BETWEEN 0 AND 1000000000000000000),
  gross_txn_minor      BIGINT NOT NULL CHECK (gross_txn_minor BETWEEN 0 AND 1000000000000000000),
  discount_txn_minor   BIGINT NOT NULL CHECK (discount_txn_minor BETWEEN 0 AND 1000000000000000000),
  net_txn_minor        BIGINT NOT NULL CHECK (net_txn_minor BETWEEN 0 AND 1000000000000000000),
  tax_minor            BIGINT NOT NULL DEFAULT 0 CONSTRAINT invoice_items_tax_policy_absent_ck CHECK (tax_minor = 0),
  base_share_minor     BIGINT NOT NULL CHECK (base_share_minor BETWEEN 0 AND 1000000000000000000),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  CONSTRAINT invoice_items_line_uq UNIQUE (business_id, invoice_id, line_no),
  CONSTRAINT invoice_items_net_ck CHECK (net_txn_minor = gross_txn_minor - discount_txn_minor + tax_minor),
  CONSTRAINT invoice_items_discount_ck CHECK (discount_txn_minor <= gross_txn_minor),
  CONSTRAINT invoice_items_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT invoice_items_invoice_fk FOREIGN KEY (business_id, invoice_id) REFERENCES invoices (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT invoice_items_product_fk FOREIGN KEY (business_id, product_id) REFERENCES products (business_id, id),
  CONSTRAINT invoice_items_variant_fk FOREIGN KEY (business_id, variant_id) REFERENCES product_variants (business_id, id)
);
REVOKE ALL ON invoice_items FROM PUBLIC;

-- The item read walks one invoice in line order (S-10).
CREATE INDEX invoice_items_invoice_idx ON invoice_items (business_id, invoice_id, line_no);

-- The numbering row. It exists to BE the lock and to hold the format, not to
-- hold the count (R-P4-03). number_format carries the year and a zero-padded
-- ordinal placeholder, and the CHECK requires the ordinal: a format with no
-- place for the number renders every document identically.
CREATE TABLE invoice_sequences (
  tenant_id     UUID NOT NULL,
  business_id   UUID NOT NULL,
  document_kind TEXT NOT NULL CONSTRAINT invoice_sequences_document_kind_ck CHECK (document_kind = 'invoice'),
  period        TEXT NOT NULL CHECK (period ~ '^[0-9]{4}$'),
  number_format TEXT NOT NULL CONSTRAINT invoice_sequences_format_ck
                  CHECK (char_length(number_format) BETWEEN 8 AND 64
                         AND number_format = btrim(number_format)
                         AND number_format ~ '^[A-Za-z0-9/-]*\{YYYY\}[A-Za-z0-9/-]*\{SEQ:[1-9][0-9]?\}[A-Za-z0-9/-]*$'),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, document_kind, period),
  CONSTRAINT invoice_sequences_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id)
);
REVOKE ALL ON invoice_sequences FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Row security: ENABLE and FORCE on all five, then the policies.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
ALTER TABLE customer_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_contacts FORCE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
ALTER TABLE invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_items FORCE ROW LEVEL SECURITY;
ALTER TABLE invoice_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_sequences FORCE ROW LEVEL SECURITY;

-- R-35: the restrictive isolation is one policy per command, so the internal
-- admission exists on SELECT only; INSERT, UPDATE and DELETE hold every
-- principal but app_bypass() to the row's own app.business_id. The tenant
-- policy takes the DIRECT form 0052 adopted after measurement: the
-- correlated subselect of 0063 is a second per-row cost
-- ([[daftar-rls-policy-shape-is-a-cost]]).
CREATE POLICY tenant_membership ON customers
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON customers AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON customers AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON customers AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON customers AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON customers
  FOR SELECT TO daftar_inventory_internal USING (true);

CREATE POLICY tenant_membership ON customer_contacts
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON customer_contacts AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON customer_contacts AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON customer_contacts AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON customer_contacts AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON customer_contacts
  FOR SELECT TO daftar_inventory_internal USING (true);

-- invoices is an accounting-source relation, so it carries the SEVENTH
-- policy and admits the accounting principal in the restrictive read
-- (TL-P4-S1-C2). Omitting accounting_validator under FORCE ROW LEVEL
-- SECURITY would make the deferred completeness validator read zero rows and
-- pass vacuously: a green gate over an unchecked invariant.
CREATE POLICY tenant_membership ON invoices
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON invoices AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal')
              OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON invoices AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON invoices AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON invoices AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON invoices
  FOR SELECT TO daftar_inventory_internal USING (true);
CREATE POLICY accounting_validator ON invoices
  FOR SELECT TO daftar_accounting_internal USING (true);

CREATE POLICY tenant_membership ON invoice_items
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON invoice_items AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON invoice_items AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON invoice_items AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON invoice_items AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON invoice_items
  FOR SELECT TO daftar_inventory_internal USING (true);

CREATE POLICY tenant_membership ON invoice_sequences
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON invoice_sequences AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON invoice_sequences AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON invoice_sequences AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON invoice_sequences AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON invoice_sequences
  FOR SELECT TO daftar_inventory_internal USING (true);

-- ─────────────────────────────────────────────────────────────────────────
-- 4. The privileges. daftar_app reads the five relations and holds no DML
--    (P4-AL-38); the internal principals read what their policies admit.
-- ─────────────────────────────────────────────────────────────────────────
GRANT SELECT ON customers, customer_contacts, invoices, invoice_items, invoice_sequences TO daftar_app;
GRANT SELECT ON customers, customer_contacts, invoices, invoice_items, invoice_sequences TO daftar_inventory_internal;
GRANT SELECT ON invoices TO daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. The lifecycle guards (P4-AL-46: they are part of the slice that
--    introduces the table). GRANT BEFORE OWNER and the CREATE bracket as in
--    0069 (R-P4-05). None of them authorizes by current_user, so each is
--    SECURITY DEFINER with an internal NOLOGIN owner and the pinned path,
--    exactly as suppliers_no_delete is (R-P4-06).
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;

CREATE FUNCTION customers_no_delete() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'customer.not_deletable: a customer is archived, never deleted' USING ERRCODE = 'P0001';
END;
$$;
COMMENT ON FUNCTION customers_no_delete() IS
  'P4-S1 (P4-AL-46): refuses every DELETE on customers. A customer accumulates financial history, so the correction is status = inactive. Owner daftar_inventory_internal; no EXECUTE grantee but the owner.';

CREATE FUNCTION customers_revision_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.create_intent_sha256 IS DISTINCT FROM OLD.create_intent_sha256
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'customer.state_invalid: the identity of a customer is final' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.revision IS DISTINCT FROM OLD.revision + 1 THEN
    RAISE EXCEPTION 'customer.revision_changed: a customer changes one revision at a time' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION customers_revision_guard() IS
  'P4-S1 (P4-AL-46): the identity of a customer is final and every change advances the revision by exactly one. Owner daftar_inventory_internal; no EXECUTE grantee but the owner.';

CREATE FUNCTION invoices_no_delete() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'invoice.not_deletable: an invoice is voided by a new reversal, never deleted' USING ERRCODE = 'P0001';
END;
$$;
COMMENT ON FUNCTION invoices_no_delete() IS
  'P4-S1 (P4-AL-10, P4-AL-46): financial history is append-only, so no DELETE reaches invoices. Owner daftar_inventory_internal; no EXECUTE grantee but the owner.';

-- The lifecycle, as the only shape an UPDATE may take. It is not a
-- convention the command layer keeps: the trusted generic UPDATE still
-- reaches this table, and a rule only the wrapper enforces is a convention
-- ([[daftar-wrapper-is-not-an-invariant]]).
CREATE FUNCTION invoices_lifecycle_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.sale_id IS DISTINCT FROM OLD.sale_id
     OR NEW.branch_id IS DISTINCT FROM OLD.branch_id OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.document_kind IS DISTINCT FROM OLD.document_kind OR NEW.document_number IS DISTINCT FROM OLD.document_number
     OR NEW.number_seq IS DISTINCT FROM OLD.number_seq OR NEW.period IS DISTINCT FROM OLD.period
     OR NEW.issue_date IS DISTINCT FROM OLD.issue_date OR NEW.issue_intent_sha256 IS DISTINCT FROM OLD.issue_intent_sha256
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'invoice.state_invalid: the identity of an invoice is final' USING ERRCODE = 'P0001';
  END IF;
  -- The money of a document that has been posted is what the journal entry
  -- was built from, so it never changes afterwards: a commercial mistake is
  -- corrected by a new document (P4-AL-46).
  IF OLD.status <> 'draft'
     AND (NEW.subtotal_txn_minor IS DISTINCT FROM OLD.subtotal_txn_minor
          OR NEW.discount_txn_minor IS DISTINCT FROM OLD.discount_txn_minor
          OR NEW.tax_minor IS DISTINCT FROM OLD.tax_minor
          OR NEW.total_txn_minor IS DISTINCT FROM OLD.total_txn_minor
          OR NEW.total_base_minor IS DISTINCT FROM OLD.total_base_minor
          OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
          OR NEW.source_to_base_rate IS DISTINCT FROM OLD.source_to_base_rate
          OR NEW.rate_source IS DISTINCT FROM OLD.rate_source
          OR NEW.rate_timestamp IS DISTINCT FROM OLD.rate_timestamp
          OR NEW.fx_rate_id IS DISTINCT FROM OLD.fx_rate_id
          OR NEW.customer_name_snapshot IS DISTINCT FROM OLD.customer_name_snapshot
          OR NEW.customer_phone_snapshot IS DISTINCT FROM OLD.customer_phone_snapshot) THEN
    RAISE EXCEPTION 'invoice.posted_amount_immutable: the amounts of a posted invoice are final' USING ERRCODE = 'P0001';
  END IF;
  -- The binding, once owed, is the entry that exists: it is never moved and
  -- never withdrawn.
  IF OLD.binding_source_id IS NOT NULL AND NEW.binding_source_id IS DISTINCT FROM OLD.binding_source_id THEN
    RAISE EXCEPTION 'invoice.binding_immutable: the accounting binding of a posted invoice is final' USING ERRCODE = 'P0001';
  END IF;
  -- draft -> open -> void, and nothing else. status is lifecycle only
  -- (P4-AL-24): there is no settlement status here for a payment to write.
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT ((OLD.status, NEW.status) IN (('draft', 'open'), ('open', 'void'))) THEN
    RAISE EXCEPTION 'invoice.status_transition_invalid: an invoice moves draft to open to void, and no other way' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION invoices_lifecycle_guard() IS
  'P4-S1 (P4-AL-24, P4-AL-46): the identity and the posted amounts of an invoice are final, the binding is never moved, and status advances draft -> open -> void only. Owner daftar_inventory_internal; no EXECUTE grantee but the owner.';

CREATE FUNCTION invoice_items_no_mutation() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'invoice.line_immutable: an invoice line is written once; a correction is a new document' USING ERRCODE = 'P0001';
END;
$$;
COMMENT ON FUNCTION invoice_items_no_mutation() IS
  'P4-S1 (P4-AL-10, P4-AL-46): refuses every UPDATE and DELETE on invoice_items. Owner daftar_inventory_internal; no EXECUTE grantee but the owner.';

CREATE FUNCTION invoice_sequences_key_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invoice.sequence_not_deletable: a document series is the lock its documents were numbered under' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.document_kind IS DISTINCT FROM OLD.document_kind OR NEW.period IS DISTINCT FROM OLD.period
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'invoice.sequence_state_invalid: the key of a document series is final' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION invoice_sequences_key_guard() IS
  'P4-S1 (P4-AL-31): the key of a document series is final and the row is never deleted; only number_format and updated_at may change. Owner daftar_inventory_internal; no EXECUTE grantee but the owner.';

REVOKE ALL ON FUNCTION customers_no_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION customers_revision_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION invoices_no_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION invoices_lifecycle_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION invoice_items_no_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION invoice_sequences_key_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION customers_no_delete() TO daftar_inventory_internal;
GRANT EXECUTE ON FUNCTION customers_revision_guard() TO daftar_inventory_internal;
GRANT EXECUTE ON FUNCTION invoices_no_delete() TO daftar_inventory_internal;
GRANT EXECUTE ON FUNCTION invoices_lifecycle_guard() TO daftar_inventory_internal;
GRANT EXECUTE ON FUNCTION invoice_items_no_mutation() TO daftar_inventory_internal;
GRANT EXECUTE ON FUNCTION invoice_sequences_key_guard() TO daftar_inventory_internal;

-- The triggers are created while the migrator still owns the functions (a
-- non-superuser must hold EXECUTE on a function to create a trigger on it).
CREATE TRIGGER customers_no_delete BEFORE DELETE ON customers FOR EACH ROW EXECUTE FUNCTION customers_no_delete();
CREATE TRIGGER customers_revision_guard BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION customers_revision_guard();
CREATE TRIGGER invoices_no_delete BEFORE DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION invoices_no_delete();
CREATE TRIGGER invoices_lifecycle_guard BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION invoices_lifecycle_guard();
CREATE TRIGGER invoice_items_no_mutation BEFORE UPDATE OR DELETE ON invoice_items FOR EACH ROW EXECUTE FUNCTION invoice_items_no_mutation();
CREATE TRIGGER invoice_sequences_key_guard BEFORE UPDATE OR DELETE ON invoice_sequences FOR EACH ROW EXECUTE FUNCTION invoice_sequences_key_guard();

-- The ownership transfer (after the ACL and the triggers).
ALTER FUNCTION customers_no_delete() OWNER TO daftar_inventory_internal;
ALTER FUNCTION customers_revision_guard() OWNER TO daftar_inventory_internal;
ALTER FUNCTION invoices_no_delete() OWNER TO daftar_inventory_internal;
ALTER FUNCTION invoices_lifecycle_guard() OWNER TO daftar_inventory_internal;
ALTER FUNCTION invoice_items_no_mutation() OWNER TO daftar_inventory_internal;
ALTER FUNCTION invoice_sequences_key_guard() OWNER TO daftar_inventory_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. The walk-in invariant (P4-AL-11), as a DEFERRABLE INITIALLY DEFERRED
--    constraint trigger, because the invoice row and its journal entry are
--    written in one transaction and neither can be checked before the other
--    exists. It reads the journal, so it belongs to the accounting
--    principal and gets its own CREATE bracket.
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;

CREATE FUNCTION invoices_walkin_no_ar() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.customer_id IS NOT NULL OR NEW.binding_source_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.accounting_source_bindings b
      JOIN public.journal_lines l
        ON l.business_id = b.business_id AND l.journal_entry_id = b.journal_entry_id
      JOIN public.accounts a
        ON a.business_id = l.business_id AND a.id = l.account_id
     WHERE b.business_id = NEW.business_id
       AND b.source_type = NEW.accounting_source_type
       AND b.source_id = NEW.binding_source_id
       AND a.system_key = 'accounts_receivable'
  ) THEN
    RAISE EXCEPTION 'invoice.walkin_receivable_forbidden: an invoice with no customer may not carry a receivable line'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
COMMENT ON FUNCTION invoices_walkin_no_ar() IS
  'P4-S1 (P4-AL-11): a null customer_id means no AR line. Deferred to the end of the transaction because the invoice and its entry are written together. Owner daftar_accounting_internal; no EXECUTE grantee but the owner.';

REVOKE ALL ON FUNCTION invoices_walkin_no_ar() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invoices_walkin_no_ar() TO daftar_accounting_internal;

CREATE CONSTRAINT TRIGGER invoices_walkin_no_ar
  AFTER INSERT OR UPDATE ON invoices
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION invoices_walkin_no_ar();

ALTER FUNCTION invoices_walkin_no_ar() OWNER TO daftar_accounting_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 7. The readers-of-record of P4-AL-05's derived column. SECURITY INVOKER
--    (R-P4-07): daftar_app already holds SELECT on these relations, so a
--    definer read would bypass their row security and grant new authority
--    for nothing. purchase_ap_outstanding is the precedent in every
--    particular — invoker, STABLE, the pinned path, EXECUTE to daftar_app
--    and daftar_inventory_internal — and it computes from the DOCUMENT
--    tables, never from the journal, which is also why journal_lines needs
--    no customer dimension it does not have.
--
--    None of them reads the clock: customer_ar_aging takes its as-of date
--    from the caller and there is no coalesce(p_as_of, current_date)
--    anywhere in this file ([[daftar-a-command-must-not-read-the-clock]],
--    P4-AL-30).
-- ─────────────────────────────────────────────────────────────────────────

-- S-P4-03. What settles an invoice is a payment allocation, an applied
-- credit note or a customer credit, and in P4-S1 none of those relations
-- exists, so this subtracts nothing and says so. It is NOT a claim that
-- nothing ever will: the permanent test beside this migration discovers the
-- settlement relations from the schema and requires this body to name each
-- one that exists, so the day P4-S2 creates payment_allocations the test is
-- red until this routine is replaced.
CREATE FUNCTION invoice_outstanding(p_business_id UUID, p_invoice_id UUID)
RETURNS TABLE (paid_txn_minor BIGINT, paid_base_minor BIGINT, outstanding_txn_minor BIGINT, outstanding_base_minor BIGINT)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_status     TEXT;
  v_total_txn  BIGINT;
  v_total_base BIGINT;
BEGIN
  SELECT i.status, i.total_txn_minor, i.total_base_minor
    INTO v_status, v_total_txn, v_total_base
    FROM public.invoices i
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
  RETURN QUERY SELECT 0::BIGINT, 0::BIGINT, v_total_txn, v_total_base;
END;
$$;
COMMENT ON FUNCTION invoice_outstanding(UUID, UUID) IS
  'P4-S1 (P4-AL-05, P4-AL-07): the reader-of-record of an invoice paid and outstanding amount, which is refused as a stored column by P4-AL-06. Seam S-P4-03: replaced by the slice that creates the relations that settle an invoice.';

CREATE FUNCTION invoice_settlement_state(p_business_id UUID, p_invoice_id UUID) RETURNS TEXT
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_total BIGINT;
  v_paid  BIGINT;
BEGIN
  SELECT i.total_txn_minor INTO v_total FROM public.invoices i
   WHERE i.business_id = p_business_id AND i.id = p_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice.not_found: the invoice does not exist in this business' USING ERRCODE = 'P0001';
  END IF;
  SELECT o.paid_txn_minor INTO v_paid FROM public.invoice_outstanding(p_business_id, p_invoice_id) o;
  -- The three values the product names, derived from the pair above and
  -- never stored: invoices.status is lifecycle only (P4-AL-24), so a
  -- document that has been voided reports nothing paid rather than a fourth
  -- state its own response type does not carry.
  IF v_paid <= 0 THEN
    RETURN 'unpaid';
  ELSIF v_paid >= v_total THEN
    RETURN 'paid';
  END IF;
  RETURN 'partial';
END;
$$;
COMMENT ON FUNCTION invoice_settlement_state(UUID, UUID) IS
  'P4-S1 (P4-AL-05, P4-AL-24): the reader-of-record of an invoice settlement state, derived from invoice_outstanding and never stored as a status.';

CREATE FUNCTION customer_ar_outstanding(p_business_id UUID, p_customer_id UUID)
RETURNS TABLE (currency_code TEXT, txn_minor BIGINT, base_minor BIGINT)
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT i.currency_code::TEXT,
         pg_catalog.sum(o.outstanding_txn_minor)::BIGINT,
         pg_catalog.sum(o.outstanding_base_minor)::BIGINT
    FROM public.invoices i
    JOIN LATERAL public.invoice_outstanding(i.business_id, i.id) o ON TRUE
   WHERE i.business_id = p_business_id
     AND i.customer_id = p_customer_id
     AND i.status = 'open'
   GROUP BY i.currency_code
  HAVING pg_catalog.sum(o.outstanding_txn_minor) <> 0;
$$;
COMMENT ON FUNCTION customer_ar_outstanding(UUID, UUID) IS
  'P4-S1 (P4-AL-05, P4-AL-06): the reader-of-record of a customer receivable, per transaction currency, which is refused as a stored balance column. Computed from the open invoices, never from a cached total.';

-- The aging buckets. p_bucket_days holds the ascending day thresholds, so
-- n thresholds make n+1 buckets: bucket 1 is everything not yet past the
-- first threshold (including an invoice with no due date, which is not past
-- due at all), and bucket n+1 is everything beyond the last. The as-of date
-- is the caller's, never today's.
CREATE FUNCTION customer_ar_aging(p_business_id UUID, p_customer_id UUID, p_as_of DATE, p_bucket_days INTEGER[])
RETURNS TABLE (bucket_no INTEGER, currency_code TEXT, txn_minor BIGINT, base_minor BIGINT, invoice_count INTEGER)
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT b.bucket_no,
         b.currency_code,
         pg_catalog.sum(b.txn_minor)::BIGINT,
         pg_catalog.sum(b.base_minor)::BIGINT,
         pg_catalog.count(*)::INTEGER
    FROM (
      SELECT (1 + (SELECT pg_catalog.count(*)
                     FROM pg_catalog.unnest(p_bucket_days) AS t(threshold)
                    WHERE i.due_date IS NOT NULL AND (p_as_of - i.due_date) > t.threshold))::INTEGER AS bucket_no,
             i.currency_code::TEXT AS currency_code,
             o.outstanding_txn_minor AS txn_minor,
             o.outstanding_base_minor AS base_minor
        FROM public.invoices i
        JOIN LATERAL public.invoice_outstanding(i.business_id, i.id) o ON TRUE
       WHERE i.business_id = p_business_id
         AND i.customer_id = p_customer_id
         AND i.status = 'open'
         AND o.outstanding_txn_minor <> 0
    ) b
   GROUP BY b.bucket_no, b.currency_code;
$$;
COMMENT ON FUNCTION customer_ar_aging(UUID, UUID, DATE, INTEGER[]) IS
  'P4-S1 (P4-AL-05): the aging of a customer receivable, computed from the open invoices and a supplied as-of date. There is no materialised aging table (P4-AL-06) and the routine does not read the clock (P4-AL-30).';

REVOKE ALL ON FUNCTION invoice_outstanding(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION invoice_settlement_state(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION customer_ar_outstanding(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION customer_ar_aging(UUID, UUID, DATE, INTEGER[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invoice_outstanding(UUID, UUID) TO daftar_app, daftar_inventory_internal;
GRANT EXECUTE ON FUNCTION invoice_settlement_state(UUID, UUID) TO daftar_app, daftar_inventory_internal;
GRANT EXECUTE ON FUNCTION customer_ar_outstanding(UUID, UUID) TO daftar_app, daftar_inventory_internal;
GRANT EXECUTE ON FUNCTION customer_ar_aging(UUID, UUID, DATE, INTEGER[]) TO daftar_app, daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 8. 0075-E: the end state, read from the live catalogues and never from
--    this file's own statements (R-P4-08).
-- ─────────────────────────────────────────────────────────────────────────
DO $end$
DECLARE
  c_relations CONSTANT TEXT[] := ARRAY['customers', 'customer_contacts', 'invoices', 'invoice_items', 'invoice_sequences'];
  c_ordinary  CONSTANT TEXT[] := ARRAY['business_isolation_delete', 'business_isolation_insert', 'business_isolation_read',
                                       'business_isolation_update', 'inventory_internal_read', 'tenant_membership'];
  c_source    CONSTANT TEXT[] := ARRAY['accounting_validator', 'business_isolation_delete', 'business_isolation_insert',
                                       'business_isolation_read', 'business_isolation_update', 'inventory_internal_read',
                                       'tenant_membership'];
  -- Every runtime principal, and public: the closed list the migrations
  -- treat as the runtime set.
  c_runtime   CONSTANT TEXT[] := ARRAY['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver',
                                       'daftar_provisioner', 'daftar_reconciler', 'public'];
  c_dml       CONSTANT TEXT[] := ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  c_column_dml CONSTANT TEXT[] := ARRAY['INSERT', 'UPDATE', 'REFERENCES'];
  c_guards    CONSTANT TEXT[] := ARRAY['customers_no_delete()', 'customers_revision_guard()', 'invoices_no_delete()',
                                       'invoices_lifecycle_guard()', 'invoice_items_no_mutation()', 'invoice_sequences_key_guard()'];
  c_reads     CONSTANT TEXT[] := ARRAY['invoice_outstanding(uuid,uuid)', 'invoice_settlement_state(uuid,uuid)',
                                       'customer_ar_outstanding(uuid,uuid)', 'customer_ar_aging(uuid,uuid,date,integer[])'];
  -- R-P4-02's vocabulary, as TL-P4-S1-C1 fixed it, with guard G-3's own
  -- exemptions: an identity, an actor, an instant, a classifier or an
  -- ordering is not a stored quantity, because only a stored NUMBER can
  -- drift from the journal — EXCEPT a derived settlement instant, which is
  -- read off the allocations exactly as its amount is. This is the migration
  -- asserting its own model against the live column list; it is not a
  -- substitute for G-3, which runs over the SQL in CI.
  c_forbidden CONSTANT TEXT := '(^|_)(balance|outstanding|paid|unpaid|due|owed|payable|receivable|settled|refunded|collected|allocated)($|_)';
  c_instant   CONSTANT TEXT := '_(id|ids|at|date|by|status|kind|type|code|name|currency|seq)$';
  c_derived   CONSTANT TEXT := '(^|_)(settled|paid|collected|allocated|refunded)_(at|date)($|_)';
  v_name      TEXT;
  v_role      TEXT;
  v_priv      TEXT;
  v_sig       TEXT;
  v_n         INTEGER;
  v_actual    TEXT[];
BEGIN
  -- 1. The five relations exist, row security is enabled AND forced on every
  --    one of them, and each carries tenant_id and business_id as real
  --    columns (P4-AL-08).
  SELECT count(*) INTO v_n FROM pg_class c
   WHERE c.oid = ANY (SELECT ('public.' || x)::regclass FROM unnest(c_relations) x)
     AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity;
  IF v_n <> 5 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: row security is not enabled and forced on all five P4-S1 relations (found %)', v_n
      USING ERRCODE = 'P0001';
  END IF;
  FOREACH v_name IN ARRAY c_relations LOOP
    IF (SELECT count(*) FROM pg_attribute a
         WHERE a.attrelid = ('public.' || v_name)::regclass AND a.attnum > 0 AND NOT a.attisdropped
           AND a.attname IN ('tenant_id', 'business_id') AND a.attnotnull) <> 2 THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: % does not carry tenant_id and business_id as NOT NULL columns', v_name
        USING ERRCODE = 'P0001';
    END IF;
    -- No stored derived truth, asserted over the live column list.
    IF EXISTS (SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = ('public.' || v_name)::regclass AND a.attnum > 0 AND NOT a.attisdropped
                  AND (a.attname ~ c_derived
                       OR (a.attname ~ c_forbidden AND a.attname !~ c_instant))) THEN
      RAISE EXCEPTION 'selling.derived_truth_stored: % carries a column of the vocabulary P4-AL-06 refuses', v_name
        USING ERRCODE = 'P0001';
    END IF;
    -- No floating point anywhere in Phase 4 (P4-AL-15b).
    IF EXISTS (SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = ('public.' || v_name)::regclass AND a.attnum > 0 AND NOT a.attisdropped
                  AND a.atttypid IN ('real'::regtype, 'double precision'::regtype)) THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: % carries a floating-point column', v_name USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- 2. The policy inventory: six on an ordinary relation, seven on the
  --    accounting source. Read from pg_policy
  --    ([[daftar-the-live-catalogue-is-the-policy]]).
  FOREACH v_name IN ARRAY c_relations LOOP
    SELECT array_agg(p.polname::TEXT ORDER BY p.polname) INTO v_actual
      FROM pg_policy p WHERE p.polrelid = ('public.' || v_name)::regclass;
    IF v_actual IS DISTINCT FROM (CASE WHEN v_name = 'invoices' THEN c_source ELSE c_ordinary END) THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: the policies on % are %, not the accepted set', v_name, v_actual
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  -- The tenant policy takes the direct form, on every one of the five: a
  -- correlated subselect here is the second per-row cost 0052 measured away.
  IF (SELECT count(*) FROM pg_policy p
       WHERE p.polrelid = ANY (SELECT ('public.' || x)::regclass FROM unnest(c_relations) x)
         AND p.polname = 'tenant_membership'
         AND pg_get_expr(p.polqual, p.polrelid) LIKE '%tenant_id%'
         AND pg_get_expr(p.polqual, p.polrelid) NOT LIKE '%businesses%') <> 5 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: a tenant_membership policy is not the direct tenant_id form of 0052'
      USING ERRCODE = 'P0001';
  END IF;

  -- 3. Privileges. daftar_app reads and holds nothing else; no runtime
  --    principal and not public holds any DML, at table or column level
  --    (P4-AL-38).
  FOREACH v_name IN ARRAY c_relations LOOP
    IF NOT has_table_privilege('daftar_app', 'public.' || v_name, 'SELECT') THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: daftar_app cannot read %', v_name USING ERRCODE = 'P0001';
    END IF;
    FOREACH v_role IN ARRAY c_runtime LOOP
      FOREACH v_priv IN ARRAY c_dml LOOP
        -- Both grains. PostgreSQL knows column privileges for SELECT,
        -- INSERT, UPDATE and REFERENCES only, so DELETE, TRUNCATE and
        -- TRIGGER are asked at the table grain alone — which is the only
        -- grain they exist at.
        IF has_table_privilege(v_role, 'public.' || v_name, v_priv)
           OR (v_priv = ANY (c_column_dml) AND has_any_column_privilege(v_role, 'public.' || v_name, v_priv)) THEN
          RAISE EXCEPTION 'selling.authority_leak: % holds % on %, and no runtime principal writes a Phase 4 relation in P4-S1',
            v_role, v_priv, v_name USING ERRCODE = 'P0001';
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  -- 4. Every foreign key from one of the five to a parent that is itself
  --    business-scoped names business_id on BOTH sides (P4-AL-09 / G-03),
  --    and every one of them is validated.
  FOR v_sig, v_name IN
    SELECT c.conname::TEXT, c.conrelid::regclass::TEXT
      FROM pg_constraint c
     WHERE c.contype = 'f'
       AND c.conrelid = ANY (SELECT ('public.' || x)::regclass FROM unnest(c_relations) x)
       AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.confrelid AND a.attname = 'business_id' AND a.attnum > 0 AND NOT a.attisdropped)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
       WHERE c.conname = v_sig AND c.conrelid = v_name::regclass
         AND c.convalidated
         AND (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attname = 'business_id') = ANY (c.conkey)
         AND (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = c.confrelid AND a.attname = 'business_id') = ANY (c.confkey)
    ) THEN
      RAISE EXCEPTION 'selling.cross_business_binding_expressible: % on % does not carry business_id on both sides, or is not validated',
        v_sig, v_name USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- 5. No counter and no sequence (R-P4-03): neither a relation of kind S
  --    owned by any of the five, nor a default that draws from one.
  IF EXISTS (
    SELECT 1 FROM pg_depend d
      JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
     WHERE d.refclassid = 'pg_class'::regclass
       AND d.refobjid = ANY (SELECT ('public.' || x)::regclass FROM unnest(c_relations) x)
  ) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: a P4-S1 relation is backed by a sequence, and a document number is not'
      USING ERRCODE = 'P0001';
  END IF;

  -- 6. The seven guards: definer, an internal NOLOGIN owner, the pinned
  --    path, and no EXECUTE grantee but the owner (the P3-S8 definer law,
  --    T-05, judges every routine created after 0052).
  FOREACH v_sig IN ARRAY c_guards LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.oid = ('public.' || v_sig)::regprocedure
         AND r.rolname = 'daftar_inventory_internal' AND NOT r.rolcanlogin
         AND p.prosecdef AND p.prorettype = 'trigger'::regtype
         AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
    ) THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: % is not an internal-owned definer trigger function with the pinned path', v_sig
        USING ERRCODE = 'P0001';
    END IF;
    SELECT array_agg(x.grantee::regrole::TEXT || ':' || x.privilege_type ORDER BY 1) INTO v_actual
      FROM pg_proc p, aclexplode(p.proacl) x
     WHERE p.oid = ('public.' || v_sig)::regprocedure AND x.grantee <> p.proowner;
    IF v_actual IS NOT NULL THEN
      RAISE EXCEPTION 'selling.authority_leak: % has EXECUTE grantees % beyond its owner', v_sig, v_actual USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.oid = 'public.invoices_walkin_no_ar()'::regprocedure
       AND r.rolname = 'daftar_accounting_internal' AND NOT r.rolcanlogin
       AND p.prosecdef AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
  ) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: invoices_walkin_no_ar is not owned by the accounting principal with the pinned path'
      USING ERRCODE = 'P0001';
  END IF;

  -- 7. The seven triggers, by exact definition, so a guard that exists but
  --    is not attached — or is attached to the wrong command — is caught.
  SELECT array_agg(t.tgname::TEXT || ' ' || pg_get_triggerdef(t.oid) ORDER BY t.tgname) INTO v_actual
    FROM pg_trigger t
   WHERE t.tgrelid = ANY (SELECT ('public.' || x)::regclass FROM unnest(c_relations) x)
     AND NOT t.tgisinternal;
  IF coalesce(array_length(v_actual, 1), 0) <> 7 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the P4-S1 relations carry % non-internal triggers, not the seven guards',
      coalesce(array_length(v_actual, 1), 0) USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.invoices'::regclass AND t.tgname = 'invoices_walkin_no_ar'
       AND t.tgconstraint <> 0 AND t.tgdeferrable AND t.tginitdeferred AND t.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: invoices_walkin_no_ar is not a DEFERRABLE INITIALLY DEFERRED constraint trigger'
      USING ERRCODE = 'P0001';
  END IF;

  -- 8. The four read functions: INVOKER, STABLE, the pinned path, and
  --    exactly the two EXECUTE grantees the precedent has (R-P4-07).
  FOREACH v_sig IN ARRAY c_reads LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.oid = ('public.' || v_sig)::regprocedure
         AND NOT p.prosecdef AND p.provolatile = 's'
         AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
    ) THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: % is not a STABLE SECURITY INVOKER routine with the pinned path', v_sig
        USING ERRCODE = 'P0001';
    END IF;
    SELECT array_agg(x.grantee::regrole::TEXT || ':' || x.privilege_type ORDER BY 1) INTO v_actual
      FROM pg_proc p, aclexplode(p.proacl) x
     WHERE p.oid = ('public.' || v_sig)::regprocedure AND x.grantee <> p.proowner;
    IF v_actual IS DISTINCT FROM ARRAY['daftar_app:EXECUTE', 'daftar_inventory_internal:EXECUTE'] THEN
      RAISE EXCEPTION 'selling.authority_leak: the EXECUTE grantees of % are %, not the two the precedent has', v_sig, v_actual
        USING ERRCODE = 'P0001';
    END IF;
    IF has_function_privilege('public', ('public.' || v_sig)::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'selling.authority_leak: PUBLIC may execute %', v_sig USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- 9. CREATE on the schema was handed back at the end of each bracket.
  IF has_schema_privilege('daftar_inventory_internal', 'public', 'CREATE')
     OR has_schema_privilege('daftar_accounting_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'selling.authority_leak: an internal principal keeps CREATE on schema public after its bracket' USING ERRCODE = 'P0001';
  END IF;

  -- 10. P4-S1 ships no writer, which is what makes seam S-P4-01 safe: the
  --     FK that P4-S2 adds for invoices.sale_id validates over an empty
  --     table. Asserted, not asserted-about.
  FOREACH v_name IN ARRAY c_relations LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', v_name) INTO v_n;
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: % holds % rows, and P4-S1 creates no row in any Phase 4 relation', v_name, v_n
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
END
$end$;
