-- 0077_phase4_sales_sale_items_sources.sql
-- Phase 4 / P4-S2 — the sale documents, the stock-source apparatus and the two
-- accounting source types (docs/PHASE_4_ARCHITECTURE_LOCK.md P4-AL-08,
-- P4-AL-09, P4-AL-11, P4-AL-12, P4-AL-16, P4-AL-20, P4-AL-25, P4-AL-27,
-- P4-AL-28, P4-AL-29, P4-AL-29b, P4-AL-33, P4-AL-38, P4-AL-39, P4-AL-44,
-- P4-AL-46, P4-AL-47; rulings TL-P4-S1-R1, TL-P4-S1-R2, TL-P4-S1-C2,
-- TL-P4-S1-C6, TL-P4-S1-C17; coordinator corrections TL-P4-S2-K1…K4).
--
-- Migrations 0000-0076 are FROZEN and untouched. This is the first P4-S2
-- migration and it is permitted only because the general Phase 4 RLS
-- ENABLE/FORCE discovery law exists and is red-proven (TL-P4-S1-R2):
-- scripts/guards/phase4-rls-force.ts, tests/guards/phase4-rls-force-guard.test.ts.
--
-- ── What this file does ─────────────────────────────────────────────────
--
--   1. sales and sale_items: the commercial and inventory truth of what left
--      the shelf (P4-AL-12), each carrying tenant_id and business_id as real
--      columns (P4-AL-08) and every edge to another commercial row a
--      composite foreign key naming business_id on both sides (P4-AL-09).
--      sale_items carries UNIQUE (business_id, sale_id, id), which is the
--      candidate key P4-AL-29b needs for the bridge's line foreign key.
--   2. invoices_sale_fk: seam S-P4-01 closed. The parent now exists, so
--      invoices.sale_id owes its composite foreign key to it.
--   3. stock_source_bridge_sale and the whole P4-AL-29b apparatus, with
--      inventory_stock_source_guard_gaps() REPLACED to carry a `sale` arm —
--      see the header rule R-P4-S2-03 below for why a replacement rather
--      than the generic arm.
--   4. The registry rows: the `sale` stock source type, the `sale` movement
--      kind, the `sale.commit` operation kind and its op→kind row.
--   5. The `sale` and `invoice` ACCOUNTING source types with their operation
--      kinds and their deferred completeness validators (TL-P4-S1-R1 moved
--      the invoice half here), and the generic reversal guard widened in the
--      same migration that registers them (P4-AL-47, seam S-P4-02).
--   6. sales_walkin_no_ar (P4-AL-11).
--   7. Row security ENABLEd and FORCEd on all three new relations, with the
--      six policies of an ordinary relation and the seventh,
--      accounting_validator, on sales — the accounting-source relation
--      (P4-AL-38 as corrected by TL-P4-S1-C2 and TL-P4-S2-K2).
--   8. 0077-E: the end state, asserted against the live catalogues.
--
-- ── What this file does NOT do ──────────────────────────────────────────
--
--   No command. sale_commit and the bridge writer are 0078's, on the
--   0063/0064, 0065/0066, 0067/0068 precedent, so no principal can write a
--   row here and every relation this file creates is EMPTY on arrival —
--   which is what makes invoices_sale_fk validate over an empty invoices.
--   No change to inventory_apply_stock_movements (P4-AL-29): a sale is a new
--   operation kind and a new movement kind consumed by the existing writer,
--   and OD-P4-05 stays NO OVERSELL. No new signing key and no second
--   assertion protocol (P4-AL-27). No sale.void and no sale.return operation
--   kind (TL-P4-S2-K1). No new internal owner role (TL-P4-S1-C17). No
--   MIGRATION_MANIFEST entry (TL-P4-S1-C8). No tax: tax_minor exists on both
--   money-bearing relations with CHECK (tax_minor = 0) and OD-03 stays open
--   (P4-AL-44).
--
-- ── Header rules (P4-S2) ───────────────────────────────────────────────
--
--   R-P4-S2-01 THE LIVE CATALOGUE IS THE POLICY
--        ([[daftar-the-live-catalogue-is-the-policy]]). The pre-flight block
--        reads pg_constraint, pg_proc and pg_class TODAY, never the migration
--        that wrote them. In particular the body this file replaces is
--        0067's — the FIFTH version of inventory_stock_source_guard_gaps()
--        (0059, 0061, 0063, 0065, 0067) — and P4-AL-29b's citation of
--        0061:307-481 points at a body the database does not hold.
--   R-P4-S2-02 EVERY EDGE CARRIES THE BUSINESS (P4-AL-09). MATCH SIMPLE is
--        not a hole, because business_id is independently constrained on
--        every relation here by FOREIGN KEY (tenant_id, business_id)
--        REFERENCES businesses (tenant_id, id) over two NOT NULL columns.
--   R-P4-S2-03 THE SALE SOURCE IS PINNED LIKE EVERY OTHER SOURCE. For a
--        source type that is none of S3/S4/S5 the live guard leaves the
--        bridge's line foreign key TARGET AND KEY unpinned (0067:1551-1564)
--        and records no body digest (0067:1574, :1593). Measured on a
--        from-zero database: a sale bridge whose line FK pointed at
--        invoice_items instead of sale_items was reported as no gap at all.
--        Leaving the generic arm would make the sale the least-protected
--        source in the registry — [[daftar-every-journal-writer-equally-protected]].
--        So the routine is replaced with a `sale` arm, which is the accepted
--        mechanism: 0063, 0065 and 0067 each replaced it.
--   R-P4-S2-04 NO STORED DERIVED TRUTH (P4-AL-05, P4-AL-06). There is no
--        cogs column and no cost total on sales or sale_items: the COGS
--        input is stock_movements.value_delta_base_minor, and a per-line cost
--        needed before the movement is written is a transient in the
--        routine, not a column. A consequence is recorded at the guard
--        itself: the `sale` source carries NO value_complete arm, because its
--        subject would be exactly that forbidden column.
--   R-P4-S2-05 GRANT BEFORE OWNER, AND THE CREATE BRACKET (P4-AL-39,
--        [[daftar-grant-before-owner]]). PUBLIC's EXECUTE is revoked, the
--        runtime grants issued and the triggers created while the migrator
--        still owns each function; only then is ownership handed over. A
--        GRANT by a non-owner without grant option is a WARNING, not an
--        error, so the reverse order would silently grant nothing.
--   R-P4-S2-06 A GUARD THAT READS current_user RUNS AS THE WRITER
--        ([[daftar-a-guard-that-asks-who-must-run-as-the-writer]]). None of
--        the guards below authorizes by current_user: the authority is the
--        GRANT and the trigger carries the invariant, so each is SECURITY
--        DEFINER with an internal NOLOGIN owner and the pinned path — which
--        is also what inventory_stock_source_guard_gaps() demands of them.
--   R-P4-S2-07 A CLOSURE RULE IS NOT AN INVARIANT (P4-AL-88). 0077-E
--        CAPTURES each registry's contents before it writes and asserts the
--        difference, so no literal here states what a later phase may hold.
--
-- ── Two things this file states as the recommended reading, pending a
--    Tech Lead ruling ──────────────────────────────────────────────────
--
--   D-1 THE CASH SALE'S BALANCING DEBIT. P4-AL-16 lists a cash sale's
--       payment, allocation and settlement entry inside the atomic sale, and
--       P4-AL-17 requires one entry per ALLOCATION — but `payments` and
--       `payment_allocations` are P4-S4's relations and P4-AL-86 refuses a
--       later slice's table here. The RECOMMENDED reading, which this file
--       implements and which is on a decision card: the minimal cash sale
--       balances against the `cash` SYSTEM ACCOUNT directly, with no payment
--       document; the settlement mode is a stored INPUT on the sale header
--       (settlement_mode), which is a fact the merchant states and not a
--       derived truth, so P4-AL-24's "settlement state is derived, never a
--       status" is untouched — nothing recomputes settlement_mode and no
--       later command rewrites it. P4-S4 adds the payment document lifecycle
--       without rewriting an accepted row. A credit sale balances against AR.
--   D-2 REVENUE IS RECOGNISED NET. invoices_total_ck (0075:294) is
--       `total = subtotal - discount + tax`, so the invoice's own total is
--       already the net, and a gross revenue credit with a contra `discounts`
--       debit would need a BASE figure for the discount that no stored column
--       carries — and deriving one here would be the second rounding
--       P4-AL-19 refuses. So the invoice entry is exactly two lines and the
--       validator REFUSES a `discounts` line and a `tax_payable` line. A
--       gross presentation is a later slice's change to this validator, with
--       the base share stored on the line that needs it.

-- ─────────────────────────────────────────────────────────────────────────
-- 0. Preconditions, read from the live catalogue (R-P4-S2-01).
-- ─────────────────────────────────────────────────────────────────────────
DO $pre$
DECLARE
  c_new CONSTANT TEXT[] := ARRAY['sales', 'sale_items', 'stock_source_bridge_sale'];
  v_name TEXT;
  v_n    INTEGER;
BEGIN
  FOREACH v_name IN ARRAY c_new LOOP
    IF to_regclass('public.' || v_name) IS NOT NULL THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: % already exists, so 0077 is not the migration that creates it', v_name
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- The P4-S1 head: the five relations exist and the four registry CHECKs are
  -- widened, so a Phase 4 registrant is expressible at all.
  IF to_regclass('public.invoices') IS NULL OR to_regclass('public.invoice_items') IS NULL
     OR to_regclass('public.customers') IS NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0077 applies on the P4-S1 head (customers, invoices, invoice_items) only'
      USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(*) FROM pg_constraint c
       WHERE c.conname IN ('inventory_operation_kinds_registered_by_check', 'stock_movement_kinds_registered_by_check',
                           'stock_source_types_registered_by_check', 'inventory_operation_movement_kinds_registered_by_check')
         AND pg_get_constraintdef(c.oid) LIKE '%P[0-9]+-S[0-9]+%') <> 4 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: 0077 applies on the 0074 head (the four widened registered_by CHECKs) only'
      USING ERRCODE = 'P0001';
  END IF;

  -- Seam S-P4-01 was safe because P4-S1 shipped no writer. The FK below
  -- validates over an empty table, and that is asserted TODAY rather than
  -- inherited from 0075's own assertion about 0075.
  SELECT count(*) INTO v_n FROM invoices;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: invoices holds % rows, so invoices_sale_fk would not validate over an empty table', v_n
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint c
              WHERE c.conrelid = 'public.invoices'::regclass AND c.contype = 'f'
                AND (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attname = 'sale_id') = ANY (c.conkey)) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: invoices.sale_id already carries a foreign key, so seam S-P4-01 is not 0077''s to close'
      USING ERRCODE = 'P0001';
  END IF;

  -- The registries this file writes to hold none of its rows yet.
  IF EXISTS (SELECT 1 FROM stock_source_types WHERE source_type = 'sale')
     OR EXISTS (SELECT 1 FROM stock_movement_kinds WHERE movement_kind = 'sale')
     OR EXISTS (SELECT 1 FROM inventory_operation_kinds WHERE op_code LIKE 'sale.%')
     OR EXISTS (SELECT 1 FROM accounting_source_types WHERE source_type IN ('sale', 'invoice')) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: a registry already holds a P4-S2 row' USING ERRCODE = 'P0001';
  END IF;

  -- The parents every edge names, and the accounting objects the quartet binds to.
  IF to_regclass('public.businesses') IS NULL OR to_regclass('public.branches') IS NULL
     OR to_regclass('public.warehouses') IS NULL OR to_regclass('public.products') IS NULL
     OR to_regclass('public.product_variants') IS NULL OR to_regclass('public.currencies') IS NULL
     OR to_regclass('public.accounting_fx_rates') IS NULL OR to_regclass('public.accounting_source_bindings') IS NULL
     OR to_regclass('public.stock_source_bindings') IS NULL OR to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: a parent relation 0077 references is missing' USING ERRCODE = 'P0001';
  END IF;

  -- The two system account keys the validators read must already be keys the
  -- chart can carry; 0077 invents no account key.
  IF (SELECT count(*) FROM accounting_system_account_keys
       WHERE system_key IN ('cogs', 'inventory', 'sales_revenue', 'accounts_receivable', 'cash')) <> 5 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: a system account key the sale and invoice validators read is missing'
      USING ERRCODE = 'P0001';
  END IF;

  -- No routine this file creates may already exist: an ACL that is already
  -- there is an ACL nobody reviewed.
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname IN ('stock_binding_requires_sale', 'stock_source_complete_sale',
                                                          'sale_header_guard', 'sales_walkin_no_ar', 'sales_cogs_owed',
                                                          'accounting_sale_entry_complete', 'accounting_invoice_entry_complete')) THEN
    RAISE EXCEPTION 'selling.authority_leak: a routine 0077 creates already exists, so its ACL is not reviewable' USING ERRCODE = 'P0001';
  END IF;

  -- And the guard this file is judged by reports no gap BEFORE it starts, so
  -- a gap blamed on 0077 is a gap 0077 made.
  IF EXISTS (SELECT 1 FROM inventory_stock_source_guard_gaps()) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: inventory_stock_source_guard_gaps() already reports a gap before 0077 writes anything'
      USING ERRCODE = 'P0001';
  END IF;
END
$pre$;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The sale document and its lines (P4-AL-12).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE sales (
  tenant_id               UUID NOT NULL,
  business_id             UUID NOT NULL,
  id                      UUID NOT NULL,
  customer_id             UUID,
  branch_id               UUID NOT NULL,
  warehouse_id            UUID NOT NULL,
  status                  TEXT NOT NULL CHECK (status IN ('draft', 'confirmed', 'returned_partial', 'returned_full', 'void')),
  settlement_mode         TEXT NOT NULL CHECK (settlement_mode IN ('cash', 'credit')),
  document_date           DATE NOT NULL,
  currency_code           CHAR(3) NOT NULL,
  subtotal_txn_minor      BIGINT NOT NULL CHECK (subtotal_txn_minor BETWEEN 0 AND 1000000000000000000),
  discount_txn_minor      BIGINT NOT NULL CHECK (discount_txn_minor BETWEEN 0 AND 1000000000000000000),
  tax_minor               BIGINT NOT NULL DEFAULT 0 CONSTRAINT sales_tax_policy_absent_ck CHECK (tax_minor = 0),
  total_txn_minor         BIGINT NOT NULL CONSTRAINT sales_total_range_ck CHECK (total_txn_minor BETWEEN 1 AND 1000000000000000000),
  total_base_minor        BIGINT NOT NULL CHECK (total_base_minor BETWEEN 1 AND 1000000000000000000),
  source_to_base_rate     NUMERIC(20,10) NOT NULL CHECK (source_to_base_rate > 0),
  rate_source             TEXT NOT NULL CHECK (rate_source IN ('base', 'manual', 'provider')),
  rate_timestamp          TIMESTAMPTZ NOT NULL CHECK (date_trunc('second', rate_timestamp) = rate_timestamp),
  fx_rate_id              UUID,
  customer_name_snapshot  TEXT CHECK (customer_name_snapshot IS NULL
                                      OR (char_length(customer_name_snapshot) BETWEEN 1 AND 200 AND customer_name_snapshot = btrim(customer_name_snapshot))),
  notes                   TEXT CHECK (notes IS NULL OR (char_length(notes) BETWEEN 1 AND 1000 AND notes = btrim(notes))),
  commit_intent_sha256    TEXT NOT NULL CHECK (commit_intent_sha256 ~ '^[0-9a-f]{64}$'),
  confirmed_by            UUID REFERENCES users (id),
  confirmed_at            TIMESTAMPTZ,
  void_intent_sha256      TEXT CHECK (void_intent_sha256 IS NULL OR void_intent_sha256 ~ '^[0-9a-f]{64}$'),
  voided_by               UUID REFERENCES users (id),
  voided_at               TIMESTAMPTZ,
  business_transaction_id UUID NOT NULL,
  created_by              UUID NOT NULL REFERENCES users (id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  accounting_source_type  TEXT NOT NULL GENERATED ALWAYS AS ('sale') STORED,
  binding_source_id       UUID,
  PRIMARY KEY (business_id, id),
  CONSTRAINT sales_total_ck CHECK (total_txn_minor = subtotal_txn_minor - discount_txn_minor + tax_minor),
  CONSTRAINT sales_discount_ck CHECK (discount_txn_minor BETWEEN 0 AND subtotal_txn_minor),
  CONSTRAINT sales_rate_shape_ck CHECK ((rate_source = 'base') = (fx_rate_id IS NULL AND source_to_base_rate = 1)),
  CONSTRAINT sales_binding_identity_ck CHECK (binding_source_id IS NULL OR binding_source_id = id),
  -- A draft owes NO binding, and that half is a row CHECK because it needs
  -- nothing but the row. The other half — what a COMMITTED sale owes — is NOT
  -- a CHECK, and C-01's strict `(status <> 'draft') = (binding_source_id IS
  -- NOT NULL)` is therefore WEAKENED HERE DELIBERATELY, on C-07's reasoning
  -- and the coordinator's ruling: a sale of ZERO-average-cost stock is
  -- reachable (`0060:388-390` sets the emptying movement's value to
  -- `-v_level_value`, which is 0 when the stored valuation is 0) and
  -- `journal_lines_money_cap_ck` (`0042:225`) refuses a zero-amount line, so
  -- such a sale legitimately posts its REVENUE entry and NO COGS entry and
  -- owes no `sale` binding at all. The obligation is conditional on a value NO
  -- ROW HOLDS — `sales` may carry no cost column (P4-AL-05) and storing the
  -- sum here to make it checkable is exactly the forbidden second truth — so
  -- it is carried by the DEFERRED constraint trigger `sales_cogs_owed` below,
  -- which states the IFF against the ledger. A CHECK cannot read another
  -- table; a trigger can, and a rule only the writer enforces is a convention
  -- while the trusted primitive can still write the row.
  CONSTRAINT sales_binding_owed_ck CHECK (status <> 'draft' OR binding_source_id IS NULL),
  -- The state machine as a physical shape (the 0047 / stocktake pattern, as
  -- 0063:260 names it): one CHECK enumerating each status with every column
  -- that must be null or non-null in it (P4-AL-33).
  CONSTRAINT sales_state_ck CHECK (
    (status = 'draft'
       AND confirmed_by IS NULL AND confirmed_at IS NULL
       AND void_intent_sha256 IS NULL AND voided_by IS NULL AND voided_at IS NULL)
    OR (status IN ('confirmed', 'returned_partial', 'returned_full')
       AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL
       AND void_intent_sha256 IS NULL AND voided_by IS NULL AND voided_at IS NULL)
    OR (status = 'void'
       AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL
       AND void_intent_sha256 IS NOT NULL AND voided_by IS NOT NULL AND voided_at IS NOT NULL)
  ),
  -- A walk-in sale carries a null customer_id and no snapshot of a customer
  -- who does not exist, and it is settled in cash: a credit sale with nobody
  -- to owe it is what a receivable behind a null customer looks like on the
  -- way in (P4-AL-11).
  CONSTRAINT sales_customer_snapshot_ck CHECK ((customer_id IS NULL) = (customer_name_snapshot IS NULL)),
  CONSTRAINT sales_credit_customer_ck CHECK (settlement_mode = 'cash' OR customer_id IS NOT NULL),
  CONSTRAINT sales_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT sales_customer_fk FOREIGN KEY (business_id, customer_id) REFERENCES customers (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT sales_branch_fk FOREIGN KEY (business_id, branch_id) REFERENCES branches (business_id, id),
  CONSTRAINT sales_warehouse_fk FOREIGN KEY (business_id, warehouse_id) REFERENCES warehouses (business_id, id),
  CONSTRAINT sales_currency_fk FOREIGN KEY (currency_code) REFERENCES currencies (code),
  CONSTRAINT sales_fx_rate_fk FOREIGN KEY (business_id, fx_rate_id) REFERENCES accounting_fx_rates (business_id, id) ON DELETE RESTRICT,
  -- The all-or-nothing mechanism of P4-AL-16: this deferred FK is what fails
  -- the COMMIT when a confirmed sale has no journal entry.
  -- AccountingAssertionSequence.assertComplete() does not, because presenting
  -- NONE is deliberately allowed (apps/api/src/infra/database.ts:484-490).
  CONSTRAINT sales_binding_fk
    FOREIGN KEY (business_id, accounting_source_type, binding_source_id)
    REFERENCES accounting_source_bindings (business_id, source_type, source_id)
    DEFERRABLE INITIALLY DEFERRED
);
REVOKE ALL ON sales FROM PUBLIC;

-- One customer's sales in occurrence order, and the sale list as a keyset walk.
CREATE INDEX sales_customer_idx ON sales (business_id, customer_id, document_date, id);
CREATE INDEX sales_document_date_idx ON sales (business_id, document_date, id);

CREATE TABLE sale_items (
  tenant_id            UUID NOT NULL,
  business_id          UUID NOT NULL,
  sale_id              UUID NOT NULL,
  id                   UUID NOT NULL,
  line_no              INTEGER NOT NULL CHECK (line_no >= 1),
  product_id           UUID NOT NULL,
  variant_id           UUID NOT NULL,
  name_snapshot        TEXT NOT NULL CHECK (char_length(name_snapshot) BETWEEN 1 AND 200 AND name_snapshot = btrim(name_snapshot)),
  quantity             NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  unit_price_txn_minor BIGINT NOT NULL CHECK (unit_price_txn_minor BETWEEN 0 AND 1000000000000000000),
  gross_txn_minor      BIGINT NOT NULL CHECK (gross_txn_minor BETWEEN 0 AND 1000000000000000000),
  discount_txn_minor   BIGINT NOT NULL CHECK (discount_txn_minor BETWEEN 0 AND 1000000000000000000),
  net_txn_minor        BIGINT NOT NULL CHECK (net_txn_minor BETWEEN 0 AND 1000000000000000000),
  tax_minor            BIGINT NOT NULL DEFAULT 0 CONSTRAINT sale_items_tax_policy_absent_ck CHECK (tax_minor = 0),
  base_share_minor     BIGINT NOT NULL CHECK (base_share_minor BETWEEN 0 AND 1000000000000000000),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  -- The candidate key P4-AL-29b requires so the bridge's three-column line
  -- foreign key is expressible at all (the 0063:392 shape).
  CONSTRAINT sale_items_bridge_uq UNIQUE (business_id, sale_id, id),
  CONSTRAINT sale_items_line_uq UNIQUE (business_id, sale_id, line_no),
  CONSTRAINT sale_items_net_ck CHECK (net_txn_minor = gross_txn_minor - discount_txn_minor + tax_minor),
  CONSTRAINT sale_items_discount_ck CHECK (discount_txn_minor <= gross_txn_minor),
  CONSTRAINT sale_items_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT sale_items_sale_fk FOREIGN KEY (business_id, sale_id) REFERENCES sales (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT sale_items_product_fk FOREIGN KEY (business_id, product_id) REFERENCES products (business_id, id),
  CONSTRAINT sale_items_variant_fk FOREIGN KEY (business_id, variant_id) REFERENCES product_variants (business_id, id)
);
REVOKE ALL ON sale_items FROM PUBLIC;

CREATE INDEX sale_items_sale_idx ON sale_items (business_id, sale_id, line_no);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Seam S-P4-01, closed: the parent exists, so the edge is owed
--    (P4-AL-09; scripts/phase4-s1-gate.ts:1117-1128).
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE invoices ADD CONSTRAINT invoices_sale_fk
  FOREIGN KEY (business_id, sale_id) REFERENCES sales (business_id, id);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. The stock-source bridge (P4-AL-29b).
--
--    tenant_id is a real column OUTSIDE the primary key. The lock left this
--    unresolved (§25, "stock_source_bridge_sale's tenant carriage"): P4-AL-08
--    requires it and the accepted stock_source_bridge_purchase (0063:397-412)
--    does not carry it. There is no conflict. The live guard pins the
--    bridge's PRIMARY KEY column list and nothing else about its shape
--    (0067:1523-1529), so a column outside the key is invisible to it —
--    measured both ways on a from-zero database: 0 gaps with tenant_id
--    present, and exactly `sale | bridge_pk` when it is moved INTO the key.
--    Three facts make the column the better reading: stock_source_bindings,
--    the relation this bridge's five-column FK points at and the one at the
--    same grain, already carries it with the same (tenant_id, business_id)
--    FK; it is what lets the tenant policy take P4-AL-38's DIRECT form
--    instead of 0063:555-557's correlated subselect; and the writer can
--    supply it, because 0064:318-321 already reads the bridge row out of
--    stock_source_bindings. The general RLS/FORCE law settles it in the same
--    direction and more strictly: a Phase 4 relation carrying business_id and
--    not tenant_id is reported as a P4-AL-08 violation in its own right
--    (scripts/guards/phase4-rls-force.ts).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE stock_source_bridge_sale (
  tenant_id      UUID NOT NULL,
  business_id    UUID NOT NULL,
  source_id      UUID NOT NULL,
  source_line_id UUID NOT NULL,
  movement_kind  TEXT NOT NULL,
  source_type    TEXT NOT NULL GENERATED ALWAYS AS ('sale') STORED,
  PRIMARY KEY (business_id, source_id, source_line_id, movement_kind),
  CONSTRAINT stock_source_bridge_sale_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT stock_source_bridge_sale_line_fk
    FOREIGN KEY (business_id, source_id, source_line_id)
    REFERENCES sale_items (business_id, sale_id, id) ON DELETE RESTRICT,
  CONSTRAINT stock_source_bridge_sale_binding_fk
    FOREIGN KEY (business_id, source_type, source_id, source_line_id, movement_kind)
    REFERENCES stock_source_bindings (business_id, source_type, source_id, source_line_id, movement_kind) ON DELETE RESTRICT
);
REVOKE ALL ON stock_source_bridge_sale FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Row security: ENABLE and FORCE on all three (TL-P4-S1-R2), then the
--    policies. Six on an ordinary relation and SEVEN on the accounting
--    source (P4-AL-38 as corrected by TL-P4-S1-C2; the plan's "five" on the
--    bridge is corrected by TL-P4-S2-K2). The tenant policy takes the DIRECT
--    form 0052 adopted after measurement, never 0063's correlated subselect
--    ([[daftar-rls-policy-shape-is-a-cost]]).
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales FORCE ROW LEVEL SECURITY;
ALTER TABLE sale_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_items FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_source_bridge_sale ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_source_bridge_sale FORCE ROW LEVEL SECURITY;

-- sales is an accounting-source relation, so it carries the SEVENTH policy
-- and admits the accounting principal in the restrictive read. Omitting
-- accounting_validator under FORCE ROW LEVEL SECURITY would make
-- accounting_sale_entry_complete() read zero rows and pass vacuously: a green
-- gate over an unchecked invariant (TL-P4-S1-C2).
CREATE POLICY tenant_membership ON sales
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON sales AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal')
              OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON sales AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON sales AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON sales AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON sales
  FOR SELECT TO daftar_inventory_internal USING (true);
CREATE POLICY accounting_validator ON sales
  FOR SELECT TO daftar_accounting_internal USING (true);

-- sale_items: ordinary. The restrictive read admits the inventory principal
-- because stock_source_complete_sale() reads the lines; the accounting
-- validators read the sales header and stock_movements and never the lines,
-- so the accounting principal is NOT admitted here. Each guard's reads were
-- re-derived from its own body below; an assumed read is how a vacuous pass
-- gets in.
CREATE POLICY tenant_membership ON sale_items
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON sale_items AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON sale_items AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON sale_items AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON sale_items AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON sale_items
  FOR SELECT TO daftar_inventory_internal USING (true);

CREATE POLICY tenant_membership ON stock_source_bridge_sale
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON stock_source_bridge_sale AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON stock_source_bridge_sale AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON stock_source_bridge_sale AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON stock_source_bridge_sale AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON stock_source_bridge_sale
  FOR SELECT TO daftar_inventory_internal USING (true);

-- ─────────────────────────────────────────────────────────────────────────
-- 5. The privileges (P4-AL-38): daftar_app reads and holds no DML, so every
--    write goes through a routine whose authority was checked —
--    [[daftar-wrapper-is-not-an-invariant]] is closed by the grant, not by
--    the wrapper. The internal principals get what their own writers need;
--    0077 ships no writer, so nothing writes a row in this file.
--
--    Column-level UPDATE on sales, never table-level: a table-level UPDATE
--    would let the trusted generic primitive write a column the lifecycle
--    guard happens not to name (the 0063:597 shape).
-- ─────────────────────────────────────────────────────────────────────────
GRANT SELECT ON sales, sale_items TO daftar_app;
GRANT SELECT ON sales, sale_items TO daftar_inventory_internal;
GRANT SELECT ON sales TO daftar_accounting_internal;
GRANT INSERT ON sales, sale_items, stock_source_bridge_sale TO daftar_inventory_internal;
GRANT SELECT ON stock_source_bridge_sale TO daftar_inventory_internal;
GRANT UPDATE (status, confirmed_by, confirmed_at, void_intent_sha256, voided_by, voided_at,
              binding_source_id, business_transaction_id) ON sales TO daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. The stock-side guards (P4-AL-29b, the 0063:621-1211 order exactly):
--    created while the migrator still owns them, PUBLIC revoked, the
--    triggers installed, and only then handed to the internal principal
--    inside the CREATE bracket. The order is not cosmetic — a GRANT without
--    grant option warns and commits, so every privilege is set while the
--    migrator is still the owner ([[daftar-grant-before-owner]]).
--
--    R-P4-S2-05: there is NO `value_complete` arm for the `sale` source,
--    although P4-AL-29b's object table lists one. Its subject would have to
--    be a stored cost total on `sales`, and P4-AL-05 together with the
--    guard's own DERIVED_COST_COLUMN (scripts/guards/no-authoritative-
--    balance.ts:317) refuses exactly that column. The sale's cost truth is
--    `stock_movements.value_delta_base_minor` and nothing else, so the
--    amount is pinned where it lives: `stock_source_complete_sale()` pins
--    the movement set, and the accounting validator reads the same sum
--    through `inventory_sale_cost_base_minor()` below. Reported as a Tech
--    Lead review point rather than silently dropped.
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;

-- (a) Binding → bridge, at COMMIT (the 0063:624 shape). A binding row that
--     names no bridge row is a movement with no source line, which is the
--     one thing a unique tuple cannot refuse
--     ([[daftar-a-unique-tuple-is-not-a-source-proof]]).
CREATE FUNCTION stock_binding_requires_sale() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM stock_source_bridge_sale b
                  WHERE b.business_id = NEW.business_id AND b.source_id = NEW.source_id
                    AND b.source_line_id = NEW.source_line_id AND b.movement_kind = NEW.movement_kind) THEN
    RAISE EXCEPTION 'inventory.stock_source_line_missing: a sale stock binding has no source line' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- (b) Line → required movement set, at COMMIT. A line of a sale that is no
--     longer a draft carries exactly its one `sale` movement, found THROUGH
--     the bridge; a draft's line carries none.
--
--     The movement's VALUE is deliberately not compared against anything on
--     the line, because the line carries no cost and must not: the ledger's
--     `value_delta_base_minor` is the inventory value truth (P4-AL-05,
--     [[daftar-inventory-value-is-the-ledger]]). What is pinned is the
--     quantity, the warehouse, the variant and the SIGN — a sale consumes
--     stock, so both deltas are strictly negative. OD-P4-05 (NO OVERSELL)
--     is `inventory_apply_stock_movements`'s, which this file does not
--     touch; this guard does not restate it.
CREATE FUNCTION stock_source_complete_sale() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_line   RECORD;
  v_status TEXT;
  v_wh     UUID;
  v_all    INTEGER;
  v_ok     INTEGER;
BEGIN
  SELECT l.sale_id, l.variant_id, l.quantity INTO v_line
  FROM sale_items l WHERE l.business_id = NEW.business_id AND l.id = NEW.id;
  IF NOT FOUND THEN
    -- sale_items is append-only, so this is unreachable by construction; it
    -- is still answered, because a guard that assumes its own neighbour is
    -- a guard that reports nothing when the neighbour is replaced.
    IF EXISTS (SELECT 1 FROM stock_source_bridge_sale b
                WHERE b.business_id = NEW.business_id AND b.source_id = NEW.sale_id AND b.source_line_id = NEW.id) THEN
      RAISE EXCEPTION 'inventory.source_movement_set_incomplete: a removed sale line carries a movement' USING ERRCODE = 'P0001';
    END IF;
    RETURN NULL;
  END IF;
  SELECT s.status, s.warehouse_id INTO v_status, v_wh
  FROM sales s WHERE s.business_id = NEW.business_id AND s.id = v_line.sale_id;
  SELECT count(*),
         count(*) FILTER (WHERE m.movement_kind = 'sale' AND m.warehouse_id = v_wh AND m.variant_id = v_line.variant_id
                            AND m.qty_delta = -v_line.quantity
                            AND m.value_delta_base_minor < 0)
    INTO v_all, v_ok
  FROM stock_source_bridge_sale b
  JOIN stock_movements m ON m.business_id = b.business_id AND m.source_type = b.source_type AND m.source_id = b.source_id
                        AND m.source_line_id = b.source_line_id AND m.movement_kind = b.movement_kind
  WHERE b.business_id = NEW.business_id AND b.source_id = v_line.sale_id AND b.source_line_id = NEW.id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'inventory.source_movement_set_incomplete: a sale line names no sale' USING ERRCODE = 'P0001';
  ELSIF v_status = 'draft' THEN
    IF v_all <> 0 THEN
      RAISE EXCEPTION 'inventory.source_movement_set_incomplete: a draft sale line carries no movement' USING ERRCODE = 'P0001';
    END IF;
  ELSIF v_status = 'void' THEN
    -- A void sale's lines keep the movements the confirmation made: voiding
    -- posts the inverse, it does not unmake the original
    -- ([[daftar-a-closure-rule-is-not-an-invariant]] read forward — the
    -- inverse movements belong to the slice that ships the writer).
    IF v_all <> 1 OR v_ok <> 1 THEN
      RAISE EXCEPTION 'inventory.source_movement_set_incomplete: a voided sale line keeps exactly its one sale movement' USING ERRCODE = 'P0001';
    END IF;
  ELSIF v_all <> 1 OR v_ok <> 1 THEN
    RAISE EXCEPTION 'inventory.source_movement_set_incomplete: a confirmed sale line needs exactly its one sale movement' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- (c) The header twin, and it is not redundant: a draft that becomes
--     confirmed by an UPDATE touches no line, so without this a sale could
--     be confirmed with movements for none of its lines (the
--     `purchases_received_complete` hole, 0063:1132).
CREATE FUNCTION stock_source_complete_sale_header() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_status TEXT;
  v_wh     UUID;
  v_lines  INTEGER;
  v_bad    INTEGER;
BEGIN
  SELECT s.status, s.warehouse_id INTO v_status, v_wh FROM sales s WHERE s.business_id = NEW.business_id AND s.id = NEW.id;
  SELECT count(*),
         count(*) FILTER (WHERE
           CASE WHEN v_status = 'draft' THEN
                  EXISTS (SELECT 1 FROM stock_source_bridge_sale b
                           WHERE b.business_id = l.business_id AND b.source_id = l.sale_id AND b.source_line_id = l.id)
                ELSE
                  (SELECT count(*) FROM stock_source_bridge_sale b
                    WHERE b.business_id = l.business_id AND b.source_id = l.sale_id AND b.source_line_id = l.id) <> 1
                  OR NOT EXISTS (SELECT 1 FROM stock_source_bridge_sale b
                                   JOIN stock_movements m ON m.business_id = b.business_id AND m.source_type = b.source_type
                                                         AND m.source_id = b.source_id AND m.source_line_id = b.source_line_id
                                                         AND m.movement_kind = b.movement_kind
                                  WHERE b.business_id = l.business_id AND b.source_id = l.sale_id AND b.source_line_id = l.id
                                    AND m.movement_kind = 'sale' AND m.warehouse_id = v_wh AND m.variant_id = l.variant_id
                                    AND m.qty_delta = -l.quantity AND m.value_delta_base_minor < 0)
           END)
    INTO v_lines, v_bad
  FROM sale_items l
  WHERE l.business_id = NEW.business_id AND l.sale_id = NEW.id;
  IF v_bad <> 0 OR (v_status <> 'draft' AND v_lines = 0) THEN
    RAISE EXCEPTION 'inventory.source_movement_set_incomplete: a sale does not carry exactly its required movements' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- (d) The lifecycle guard, judging INSERT too (tgtype 31, the
--     `purchase_header_guard()` shape at 0063:872). It is one function and
--     it is the stock guard's `header_immutable` entry as well, because the
--     two obligations are the same obligation: what a sale row may become.
--
--     R-P4-S2-06: a sale may be INSERTed either as a `draft` (a parked
--     basket) or directly as `confirmed` — the minimal POS atomic path
--     writes the sale, its lines, its movements and its entry in ONE
--     transaction, so demanding a draft first would demand two. Both
--     openings are stated here as one physical shape rather than left to
--     the writer, because a writer is not an invariant
--     ([[daftar-wrapper-is-not-an-invariant]]).
CREATE FUNCTION sale_header_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('draft', 'confirmed')
       OR NEW.void_intent_sha256 IS NOT NULL OR NEW.voided_by IS NOT NULL OR NEW.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'selling.source_document_immutable: a sale is created as a draft or a confirmed sale, never already void' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.status = 'draft' AND NEW.binding_source_id IS NOT NULL THEN
      RAISE EXCEPTION 'selling.source_document_immutable: a draft sale is created without an accounting binding' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'selling.source_document_immutable: a sale is never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.business_transaction_id IS DISTINCT FROM OLD.business_transaction_id THEN
    RAISE EXCEPTION 'selling.source_document_immutable: the identity of a sale is final' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'void' THEN
    RAISE EXCEPTION 'selling.source_document_immutable: a void sale is final' USING ERRCODE = 'P0001';
  END IF;
  -- A draft may be replaced in place, one state at a time; anything that has
  -- been confirmed has had its commercial facts posted, and those facts are
  -- final whatever the sale later becomes.
  IF OLD.status = 'draft' THEN
    IF NEW.status NOT IN ('draft', 'confirmed') THEN
      RAISE EXCEPTION 'selling.source_document_immutable: a draft sale becomes a confirmed sale and nothing else' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id
     OR NEW.settlement_mode IS DISTINCT FROM OLD.settlement_mode
     OR NEW.document_date IS DISTINCT FROM OLD.document_date
     OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
     OR NEW.subtotal_txn_minor IS DISTINCT FROM OLD.subtotal_txn_minor
     OR NEW.discount_txn_minor IS DISTINCT FROM OLD.discount_txn_minor
     OR NEW.tax_minor IS DISTINCT FROM OLD.tax_minor
     OR NEW.total_txn_minor IS DISTINCT FROM OLD.total_txn_minor
     OR NEW.total_base_minor IS DISTINCT FROM OLD.total_base_minor
     OR NEW.source_to_base_rate IS DISTINCT FROM OLD.source_to_base_rate
     OR NEW.rate_source IS DISTINCT FROM OLD.rate_source
     OR NEW.rate_timestamp IS DISTINCT FROM OLD.rate_timestamp
     OR NEW.fx_rate_id IS DISTINCT FROM OLD.fx_rate_id
     OR NEW.customer_name_snapshot IS DISTINCT FROM OLD.customer_name_snapshot
     OR NEW.commit_intent_sha256 IS DISTINCT FROM OLD.commit_intent_sha256
     OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
     OR NEW.binding_source_id IS DISTINCT FROM OLD.binding_source_id THEN
    RAISE EXCEPTION 'selling.source_document_immutable: the commercial facts of a confirmed sale are final' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status NOT IN ('confirmed', 'returned_partial', 'returned_full', 'void') THEN
    RAISE EXCEPTION 'selling.source_document_immutable: a confirmed sale does not return to a draft' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- (e) The sale's cost, published BY the domain that owns it.
--
--     R-P4-S2-07, and this is the one authority decision in the file. The
--     `sale` entry is the COGS/Inventory pair (PHASE_4_ARCHITECTURE_LOCK.md
--     :341), and its amount is the sum of the movements' value deltas —
--     there is no stored cost total to read, by law. The accounting
--     validator therefore needs that sum, and it is a NOLOGIN principal in
--     another domain. The alternative — granting daftar_accounting_internal
--     SELECT on `stock_movements` and adding it a policy on a FROZEN
--     Phase 3 relation — buys a table-wide read and changes a frozen
--     relation's policy set to get one number. A function that publishes
--     exactly that number does not: the precedent is
--     `inventory_business_has_stock_movements(UUID)` at 0069:212, granted
--     to this very principal for this very reason.
--
--     It returns NULL, never 0, when the sale has no bridged movement, so
--     the caller cannot read "no movements" as "a cost of nothing" — the
--     vacuous pass the deferred-validator failure mode is made of.
CREATE FUNCTION inventory_sale_cost_base_minor(p_business_id UUID, p_sale_id UUID) RETURNS BIGINT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT -sum(m.value_delta_base_minor)
  FROM stock_source_bridge_sale b
  JOIN stock_movements m ON m.business_id = b.business_id AND m.source_type = b.source_type AND m.source_id = b.source_id
                        AND m.source_line_id = b.source_line_id AND m.movement_kind = b.movement_kind
  WHERE b.business_id = p_business_id AND b.source_id = p_sale_id;
$$;

COMMENT ON FUNCTION inventory_sale_cost_base_minor(UUID, UUID) IS
  'P4-S2 (P4-AL-05, P4-AL-29b): the cost of a sale in base minor units, as the negated sum of its bridged stock movements'' value_delta_base_minor — the inventory value truth, never quantity times a rounded average. NULL when the sale carries no bridged movement, so an empty set is never read as a zero cost. STABLE, writes nothing. Owner daftar_inventory_internal, DEFINER because the bridge and the ledger are the inventory domain''s. EXECUTE: daftar_accounting_internal only — reachability for the sale entry''s deferred completeness validator, not runtime reach ([[daftar-execute-is-reachability-not-authority]]).';

REVOKE ALL ON FUNCTION stock_binding_requires_sale() FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_source_complete_sale() FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_source_complete_sale_header() FROM PUBLIC;
REVOKE ALL ON FUNCTION sale_header_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION inventory_sale_cost_base_minor(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_sale_cost_base_minor(UUID, UUID) TO daftar_accounting_internal;

-- ── The stock-side triggers (P4-AL-29b, the 0063:1113-1191 shapes) ──────
CREATE CONSTRAINT TRIGGER stock_binding_requires_sale
  AFTER INSERT ON stock_source_bindings DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source_type = 'sale')
  EXECUTE FUNCTION stock_binding_requires_sale();

CREATE TRIGGER stock_bridge_immutable_sale
  BEFORE UPDATE OR DELETE ON stock_source_bridge_sale
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_append_only();

CREATE CONSTRAINT TRIGGER stock_source_complete_sale
  AFTER INSERT ON sale_items DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION stock_source_complete_sale();
CREATE CONSTRAINT TRIGGER sales_confirmed_complete
  AFTER UPDATE ON sales DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION stock_source_complete_sale_header();

-- A sale line is append-only: it is reused rather than re-created, exactly
-- as `negative_deficit_coverages_append_only` reuses the migrator-owned
-- INVOKER `stock_ledger_append_only()` (0063's `internal = false` row).
CREATE TRIGGER sale_items_append_only
  BEFORE UPDATE OR DELETE ON sale_items
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_append_only();

CREATE TRIGGER sales_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON sales
  FOR EACH ROW EXECUTE FUNCTION sale_header_guard();

ALTER FUNCTION stock_binding_requires_sale() OWNER TO daftar_inventory_internal;
ALTER FUNCTION stock_source_complete_sale() OWNER TO daftar_inventory_internal;
ALTER FUNCTION stock_source_complete_sale_header() OWNER TO daftar_inventory_internal;
ALTER FUNCTION sale_header_guard() OWNER TO daftar_inventory_internal;
ALTER FUNCTION inventory_sale_cost_base_minor(UUID, UUID) OWNER TO daftar_inventory_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 7. The stock-source guard discovery, REPLACED (TL-P4-S2-K3).
--
--    Why a replacement and not a new function: the live catalogue is the
--    policy ([[daftar-the-live-catalogue-is-the-policy]]), and the live body
--    is 0067:1438 — the FIFTH version (0059:390 → 0061:308 → 0063:1247 →
--    0065:1396 → 0067:1438). P4-AL-29b cites 0061:307-481, a body the
--    database does not hold, so a reader reasoning from the citation gets a
--    materially wrong answer about what the `sale` source must provide.
--    Replacement is the accepted mechanism and not an edit to a frozen
--    file: 0063, 0065 and 0067 each replaced this very function.
--
--    Why it MUST be replaced rather than left alone: in the live body, for a
--    source type that is none of S3/S4/S5 the bridge's line foreign key has
--    its TARGET TABLE AND KEY UNPINNED — the body's own comment says "for
--    any other type to some third table (the S2 template)" (0067:1551-1564)
--    — no prosrc digest is recorded, and none of source_complete /
--    source_freeze / header_immutable is required. Measured on a from-zero
--    database: a `stock_source_bridge_sale` whose line foreign key pointed
--    at `invoice_items` instead of `sale_items` was reported as NO GAP AT
--    ALL. Without this replacement the sale would be the least-protected
--    source in the registry, which
--    [[daftar-every-journal-writer-equally-protected]] refuses.
--
--    This is 0067's text byte for byte — every S3/S4/S5 row and all
--    forty-one recorded digests — plus exactly five additions: the `v_s6`
--    flag, the four new digests, the `sale` line-table row, `OR v_s6` in
--    each of the four conditions that pin a non-S3/S4/S5 type loosely, and
--    the S6 per-type block. Same signature, owner (the migrator), INVOKER
--    STABLE, pinned path and ACL.
-- ─────────────────────────────────────────────────────────────────────────
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
    "stock_source_complete_sale()": "eb0fdfe309da5d5fdf606c7a6901f0ff674f060b9497369aa107bfe17ded8c8c",
    "stock_source_complete_sale_header()": "0eafdbf85adce5d3ea9c7ff925e30bf96fc5a4ec8fd6ef1213b9448485bdd88a",
    "sale_header_guard()": "11b3103b3f15cb4158c31850bc4cc75c8369857dfc45c6daf463463eabb16553"
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

COMMENT ON FUNCTION inventory_stock_source_guard_gaps() IS
  'P3-AL-51 §B as replaced through P3-S4, P3-S5 and P3-S6, now replaced by P4-S2 (0077, TL-P4-S2-K3). 0067''s body exactly, with one addition: the `sale` source type becomes an S6 type, so its bridge line foreign key is pinned to exactly sale_items (business_id, sale_id, id), its bridge_immutable and binding_trigger bodies are checked against recorded prosrc digests, and its own set is required — source_complete (sale_items), header_complete (sales), source_freeze (sale_items, the migrator-owned INVOKER stock_ledger_append_only()) and header_immutable (sales). There is deliberately NO value_complete row for `sale`: its subject would be a stored cost total on `sales`, which P4-AL-05 forbids and the no-authoritative-balance guard refuses by name; the sale''s cost is pinned in stock_movements.value_delta_base_minor and published to the accounting validator by inventory_sale_cost_base_minor(UUID, UUID). Before this replacement a sale bridge whose line foreign key pointed at the wrong table was reported as no gap at all. Every migration that registers a source type asserts it returns no row. Migrator-owned INVOKER; no EXECUTE grant.';

REVOKE ALL ON FUNCTION inventory_stock_source_guard_gaps() FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────
-- 8. Stock-source registration (P4-AL-29b), AFTER every guard above exists
--    and after the discovery that proves them has been replaced. The order
--    is the whole point: a registry row that names a type whose guards are
--    not yet there is a live authority with no protection.
--
--    `sale.commit` ALONE (TL-P4-S2-K1). An inventory_operation_kinds row is
--    a registration of AUTHORITY, and a live authority with no writer is
--    exactly what TL-P4-S1-R1 refused. `sale.void` and `sale.return` are
--    registered by the slices that supply their writers.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO stock_movement_kinds (movement_kind, qty_sign, requires_reason, registered_by) VALUES
  ('sale', 'negative', false, 'P4-S2');
INSERT INTO stock_source_types (source_type, registered_by) VALUES
  ('sale', 'P4-S2');
INSERT INTO inventory_operation_kinds (op_code, registered_by) VALUES
  ('sale.commit', 'P4-S2');
INSERT INTO inventory_operation_movement_kinds (op_code, movement_kind, registered_by) VALUES
  ('sale.commit', 'sale', 'P4-S2');

-- ─────────────────────────────────────────────────────────────────────────
-- 9. The accounting side (P4-AL-16, TL-P4-S1-R1). Every function is owned
--    by daftar_accounting_internal, DEFINER, pinned, PUBLIC revoked, inside
--    the accounting CREATE bracket (0058:40-71, the 0063:1521 order).
--
--    THE SPLIT, and it is the lock's not mine (PHASE_4_ARCHITECTURE_LOCK.md
--    :341-342): the `sale` entry is the COGS/Inventory pair; the `invoice`
--    entry is the revenue and settlement set. Nothing is posted twice.
-- ─────────────────────────────────────────────────────────────────────────
-- ─────────────────────────────────────────────────────────────────────────
-- 8b. THE VACUOUS-PASS TRAP ON A FROZEN RELATION (TL-P4-S1-C2), and it is
--     live. `invoice_items` carries exactly SIX policies (0075:460-473) and
--     its RESTRICTIVE read admits `daftar_inventory_internal` alone, so the
--     deferred invoice validator below — a DEFINER owned by
--     daftar_accounting_internal — would read ZERO LINES under FORCE ROW
--     LEVEL SECURITY and pass. Not fail: PASS. A green gate over an
--     unchecked invariant is the failure mode this law was written for, and
--     measuring it was the only way to find it: the shape of the validator
--     is correct either way.
--
--     The correction is HERE and never an edit to 0075, which is frozen.
--     `invoice_items` becomes an accounting-source-reading relation and so
--     takes the SEVENTH policy, exactly as `invoices` does; the restrictive
--     read is widened to the same two principals 0075 already names on
--     `invoices` (0075:458-460), by ALTER POLICY so the policy keeps its
--     name and nothing is dropped and re-created under a reader.
ALTER POLICY business_isolation_read ON invoice_items
  USING      (app_bypass() OR current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal')
              OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY accounting_validator ON invoice_items
  FOR SELECT TO daftar_accounting_internal USING (true);
GRANT SELECT ON invoice_items TO daftar_accounting_internal;

GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;

-- (a) The reversal guard, replaced BY ITS OWNER (the 0063:1521 / 0072:633
--     shape): 0072's body byte for byte with `'sale'` and `'invoice'`
--     APPENDED to the always-refused list. Appended, not inserted, because
--     0067:2790 and 0072:903 each assert a SUBSTRING of this list, and a
--     reordering would make a frozen migration's own end-state claim read
--     false against the body the database then holds.
--
--     Both go in the plain refusal arm and neither gets a `purchase`-style
--     escape: there is no sale-reversal or invoice-reversal document in this
--     slice, so until a slice ships that writer the generic workflow may not
--     reverse either. That is the hole PHASE_4_ARCHITECTURE_LOCK.md:967
--     names — a mirrored revenue reversal with no paired stock movements.
SET LOCAL ROLE daftar_accounting_internal;

CREATE OR REPLACE FUNCTION accounting_reversals_20_domain_source_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_ob UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM journal_entries je
              WHERE je.business_id = NEW.business_id AND je.id = NEW.original_entry_id
                AND (je.source_type IN ('inventory_adjustment', 'inventory_opening', 'negative_inventory_cost_adjustment', 'supplier_return', 'supplier_payment', 'supplier_credit_allocation', 'supplier_refund', 'purchase_residue_write_off', 'sale', 'invoice')
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

-- (b) The `sale` entry's deferred completeness validator (P4-AL-16, the
--     0063:1556 shape). The sale entry is the COST pair and nothing else:
--     exactly Dr COGS / Cr Inventory for the ledger's own value, base-only,
--     dated the sale's occurrence date.
--
--     The amount is read from `inventory_sale_cost_base_minor()` — the
--     inventory domain's published sum of `value_delta_base_minor` — and
--     NEVER from a column on `sales`, because no such column may exist
--     (P4-AL-05, [[daftar-inventory-value-is-the-ledger]]). A NULL from
--     that function means the sale carries no bridged movement, which is
--     refused rather than treated as a cost of zero: that is the vacuous
--     pass a deferred validator is made of.
--
--     `document_date` is a caller-supplied NOT NULL column and is used as it
--     stands. There is no `coalesce(p_entry_date, today)` here or anywhere
--     ([[daftar-no-coalesce-entry-date]]).
CREATE FUNCTION accounting_sale_entry_complete() RETURNS trigger
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
                           AND l.warehouse_id IS NULL AND l.branch_id IS NOT DISTINCT FROM v_branch)
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

-- (c) The `invoice` entry's deferred completeness validator.
--
--     ▲ DESIGNED AGAINST THE RECOMMENDED OPTION, PENDING THE TECH LEAD'S
--       CARD. The balancing side of the revenue entry is taken from
--       `sales.settlement_mode` — a STORED INPUT, a fact the merchant
--       states and not a derived truth, so [[daftar-no-stored-derived-truth]]
--       is untouched: `cash` debits the `cash` system account DIRECTLY, with
--       no payment document and no P4-S4 relation; `credit` debits
--       `accounts_receivable`. §11 of the directive places the minimal
--       cash-sale atomic path inside P4-S2 and excludes only payment
--       workflows BEYOND it. If the ruling goes the other way, this
--       function is the only thing in 0077 that changes, and it changes by
--       REPLACEMENT in a later migration, never by an edit here.
--
--     ▲ D-2, also recommended-reading: revenue is recognised NET. The
--       invoice's `total_txn_minor` is already subtotal − discount + tax,
--       and `tax_minor = 0` is a CHECK on the row (OD-03 is OPEN: sales tax
--       is structurally zero and a non-zero tax is REFUSED, not computed).
--       Requiring EXACTLY TWO lines is what refuses a separate `discounts`
--       contra line and a `tax_payable` line: a third line of any kind
--       fails, so a gross-plus-contra shape cannot be posted behind this
--       validator's back.
CREATE FUNCTION accounting_invoice_entry_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_i      RECORD;
  v_settle TEXT;
  v_key    TEXT;
  v_lines  INTEGER;
  v_rev    INTEGER;
  v_bal    INTEGER;
  v_rev_ok BOOLEAN;
  v_bal_ok BOOLEAN;
  v_nlines INTEGER;
  v_shares NUMERIC;
BEGIN
  SELECT i.sale_id, i.issue_date, i.branch_id, i.total_txn_minor, i.total_base_minor, i.currency_code,
         i.source_to_base_rate, i.rate_source, i.rate_timestamp
    INTO v_i
  FROM invoices i
  WHERE i.business_id = NEW.business_id AND i.binding_source_id = NEW.source_id AND i.status <> 'draft';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accounting.selling_detail_missing: an invoice entry must be registered by its issued invoice in the same transaction'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT s.settlement_mode INTO v_settle
  FROM sales s WHERE s.business_id = NEW.business_id AND s.id = v_i.sale_id AND s.status <> 'draft';
  IF v_settle IS NULL THEN
    RAISE EXCEPTION 'accounting.selling_detail_missing: an invoice entry must name the confirmed sale whose settlement mode balances it'
      USING ERRCODE = 'P0001';
  END IF;
  v_key := CASE v_settle WHEN 'cash' THEN 'cash' ELSE 'accounts_receivable' END;

  -- THE NON-VACUITY CANARY. `sum()` over no rows is NULL, so a validator
  -- that only compares sums passes loudest when it can see nothing at all —
  -- which is precisely what FORCE ROW LEVEL SECURITY did to this read until
  -- section 8b. The line COUNT is therefore asserted first and separately,
  -- and a NULL share sum raises rather than compares.
  SELECT count(*), sum(it.base_share_minor) INTO v_nlines, v_shares
  FROM invoice_items it
  WHERE it.business_id = NEW.business_id AND it.invoice_id = NEW.source_id;
  IF v_nlines < 1 OR v_shares IS NULL THEN
    RAISE EXCEPTION 'accounting.selling_detail_missing: an invoice entry must be posted for an invoice that has lines this validator can read'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_shares <> v_i.total_base_minor::numeric THEN
    RAISE EXCEPTION 'accounting.selling_entry_mismatch: an invoice total is not the sum of its lines'' base shares (R-SAL-03)'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE a.system_key = 'sales_revenue'),
         count(*) FILTER (WHERE a.system_key = v_key),
         coalesce(bool_and(l.credit_minor = v_i.total_base_minor AND l.debit_minor = 0
                           AND l.warehouse_id IS NULL AND l.branch_id IS NOT DISTINCT FROM v_i.branch_id)
                    FILTER (WHERE a.system_key = 'sales_revenue'), false),
         coalesce(bool_and(l.debit_minor = v_i.total_base_minor AND l.credit_minor = 0
                           AND l.warehouse_id IS NULL AND l.branch_id IS NOT DISTINCT FROM v_i.branch_id)
                    FILTER (WHERE a.system_key = v_key), false)
    INTO v_lines, v_rev, v_bal, v_rev_ok, v_bal_ok
  FROM journal_lines l
  JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
  WHERE l.business_id = NEW.business_id AND l.journal_entry_id = NEW.id;

  IF NEW.entry_date IS DISTINCT FROM v_i.issue_date
     OR v_lines <> 2 OR v_rev <> 1 OR v_bal <> 1 OR NOT v_rev_ok OR NOT v_bal_ok
     OR EXISTS (SELECT 1 FROM journal_lines l
                 WHERE l.business_id = NEW.business_id AND l.journal_entry_id = NEW.id
                   AND (l.txn_amount_minor IS DISTINCT FROM v_i.total_txn_minor
                        OR l.txn_currency IS DISTINCT FROM v_i.currency_code::text
                        OR l.fx_rate IS DISTINCT FROM v_i.source_to_base_rate
                        OR l.fx_rate_source IS DISTINCT FROM v_i.rate_source
                        OR l.fx_rate_at IS DISTINCT FROM v_i.rate_timestamp)) THEN
    RAISE EXCEPTION 'accounting.selling_entry_mismatch: an invoice entry is not exactly the net Sales Revenue credit and its settlement debit'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- (d) `sales_cogs_owed` (C-07, and the coordinator's ruling on the zero-cost
--     sale). The COGS obligation stated as an IFF, at COMMIT, against the
--     ledger:
--
--         Σ stock_movements.value_delta_base_minor over this sale's bridged
--         movements is non-zero  ⟺  the sale carries a `sale` binding.
--
--     Both directions matter and each refuses a real, reachable state:
--
--       → a sale whose goods had value and whose COGS entry never happened is
--         an inventory decrement with no cost — the sixth state P4-AL-16
--         forbids, and the one `AccountingAssertionSequence.assertComplete()`
--         cannot catch, because presenting NONE is deliberately allowed
--         (apps/api/src/infra/database.ts:484-490);
--       ← a sale of zero-average-cost stock that carries a binding anyway
--         means a zero-amount journal line, which `journal_lines_money_cap_ck`
--         (`0042:225`) refuses — so the binding would be to an entry that
--         cannot exist.
--
--     It is a TRIGGER and not a row CHECK because the condition is a value no
--     row holds and must not: `sales` may carry no cost column (P4-AL-05,
--     DERIVED_COST_COLUMN), and storing the sum to make it checkable is
--     precisely the forbidden second truth. It is DEFERRED because the sale
--     row, its movements and its entry are written in one transaction and none
--     of them can be judged before the others exist. And it is in the DATABASE
--     and not in `sale_commit`, because a rule only the wrapper enforces is a
--     convention while the trusted primitive can still write the row
--     ([[daftar-wrapper-is-not-an-invariant]]).
--
--     A draft is out of scope: `sales_binding_owed_ck` already refuses a draft
--     a binding, and a draft has no movements to value.
CREATE FUNCTION sales_cogs_owed() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_cost BIGINT;
BEGIN
  IF NEW.status = 'draft' THEN
    RETURN NULL;
  END IF;
  v_cost := inventory_sale_cost_base_minor(NEW.business_id, NEW.id);
  -- No bridged movement at all for a sale that is not a draft. The stock-side
  -- guards own that refusal; this one does not pass it off as a zero cost,
  -- because reading an empty set as "nothing of value left the shelf" is the
  -- vacuous pass a deferred validator is made of.
  IF v_cost IS NULL THEN
    RAISE EXCEPTION 'selling.sale_cogs_owed: a committed sale carries no bridged stock movement, so its cost cannot be judged'
      USING ERRCODE = 'P0001';
  END IF;
  IF (v_cost <> 0) AND NEW.binding_source_id IS NULL THEN
    RAISE EXCEPTION 'selling.sale_cogs_owed: a committed sale whose goods carry value owes a COGS entry, and this one has none'
      USING ERRCODE = 'P0001';
  END IF;
  IF (v_cost = 0) AND NEW.binding_source_id IS NOT NULL THEN
    RAISE EXCEPTION 'selling.sale_cogs_owed: a committed sale of zero-cost stock carries no COGS entry, so it owes no accounting binding'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- (e) The walk-in invariant for the sale (P4-AL-11, the third of the three
--     the lock names at PHASE_4_ARCHITECTURE_LOCK.md:332). The sale entry
--     is the cost pair, so it carries no receivable by construction — and
--     the law is stated anyway, because "by construction" is a reading of
--     today's shape and this is a guard against tomorrow's.
CREATE FUNCTION sales_walkin_no_ar() RETURNS TRIGGER
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
    RAISE EXCEPTION 'selling.walkin_receivable_forbidden: a sale with no customer may not carry a receivable line'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION accounting_sale_entry_complete() IS
  'P4-S2 (P4-AL-16, TL-P4-S1-R1). At COMMIT, for a `sale` entry: its sale row exists (binding_source_id = source_id) and is not a draft; the cost is inventory_sale_cost_base_minor(), refused when NULL or not positive; the entry is exactly Dr COGS / Cr Inventory for that cost, base-only at the base sentinel, the Inventory line on the sale''s warehouse and the COGS line on its branch with no warehouse, dated the sale''s document_date. Otherwise accounting.selling_detail_missing / accounting.selling_entry_mismatch. Accounting-owned DEFINER, pinned, no grantee but the owner.';
COMMENT ON FUNCTION accounting_invoice_entry_complete() IS
  'P4-S2 (P4-AL-16, TL-P4-S1-R1), the invoice half of the split at PHASE_4_ARCHITECTURE_LOCK.md:341-342. At COMMIT, for an `invoice` entry: its invoice row exists (binding_source_id = source_id) and is not a draft, its sale is confirmed, and the entry is exactly two lines — Cr sales_revenue for total_base_minor and Dr the settlement account for the same, both on the invoice''s branch with no warehouse, carrying the invoice''s own FX snapshot, dated its issue_date. Revenue is NET: exactly two lines is what refuses a discounts contra line and a tax_payable line (OD-03 is open; tax_minor = 0 is a row CHECK). The settlement account is `cash` when the sale''s settlement_mode is cash and `accounts_receivable` when it is credit — DESIGNED AGAINST THE RECOMMENDED OPTION, pending the Tech Lead''s card; a different ruling is a REPLACEMENT in a later migration. Accounting-owned DEFINER, pinned, no grantee but the owner.';
COMMENT ON FUNCTION sales_cogs_owed() IS
  'P4-S2 (C-07, P4-AL-16): the sale''s COGS obligation as an IFF, at COMMIT — the sum of its bridged stock movements'' value_delta_base_minor is non-zero if and only if the sale carries a `sale` accounting binding. A committed sale with no bridged movement at all is refused outright rather than read as a zero cost. A trigger and not a row CHECK because the condition is a value no row holds and must not (P4-AL-05): storing the sum on `sales` to make it checkable is the forbidden second truth, and a CHECK cannot read another table. Deferred because the sale, its movements and its entry are written in one transaction. Owner daftar_accounting_internal, DEFINER, reading the inventory domain''s own published sum through inventory_sale_cost_base_minor(UUID, UUID); no EXECUTE grantee but the owner.';
COMMENT ON FUNCTION sales_walkin_no_ar() IS
  'P4-S2 (P4-AL-11): a null customer_id means no AR line, for the sale as invoices_walkin_no_ar() states it for the invoice. Deferred to the end of the transaction because the sale and its entry are written together. Owner daftar_accounting_internal; no EXECUTE grantee but the owner.';

REVOKE ALL ON FUNCTION accounting_sale_entry_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_invoice_entry_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION sales_cogs_owed() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sales_cogs_owed() TO daftar_accounting_internal;
REVOKE ALL ON FUNCTION sales_walkin_no_ar() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sales_walkin_no_ar() TO daftar_accounting_internal;

CREATE CONSTRAINT TRIGGER journal_entries_sale_complete
  AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source_type = 'sale')
  EXECUTE FUNCTION accounting_sale_entry_complete();
CREATE CONSTRAINT TRIGGER journal_entries_invoice_complete
  AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source_type = 'invoice')
  EXECUTE FUNCTION accounting_invoice_entry_complete();

CREATE CONSTRAINT TRIGGER sales_cogs_owed
  AFTER INSERT OR UPDATE ON sales
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION sales_cogs_owed();
CREATE CONSTRAINT TRIGGER sales_walkin_no_ar
  AFTER INSERT OR UPDATE ON sales
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION sales_walkin_no_ar();

ALTER FUNCTION accounting_sale_entry_complete() OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_invoice_entry_complete() OWNER TO daftar_accounting_internal;
ALTER FUNCTION sales_cogs_owed() OWNER TO daftar_accounting_internal;
ALTER FUNCTION sales_walkin_no_ar() OWNER TO daftar_accounting_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;

-- The registries, with the owning operation kind the 0046 rule requires.
INSERT INTO accounting_source_types (source_type, lower_bound_policy, upper_bound_policy, description, sort_order) VALUES
  ('sale',    'none', 'not_after_today', 'A confirmed sale''s cost: Dr COGS / Cr Inventory for its own stock movements'' value (P4-AL-05, P4-AL-16).', 13),
  ('invoice', 'none', 'not_after_today', 'An issued invoice''s revenue: Cr Sales Revenue net / Dr cash or Accounts Receivable by the sale''s settlement mode (P4-AL-11, P4-AL-16).', 14);
INSERT INTO accounting_operation_kinds (operation_kind, source_type, description) VALUES
  ('post', 'sale',    'Sale cost posting; derived by the sale commit command.'),
  ('post', 'invoice', 'Invoice revenue posting; derived by the sale commit command.');

-- ─────────────────────────────────────────────────────────────────────────
-- 10. 0077-E: the end state, read from the LIVE catalogues and never from
--     this file's own statements (R-P4-08). A migration that asserts what
--     it just wrote asserts nothing; every claim below is a catalogue read.
-- ─────────────────────────────────────────────────────────────────────────
DO $end$
DECLARE
  c_relations CONSTANT TEXT[] := ARRAY['sales', 'sale_items', 'stock_source_bridge_sale'];
  c_ordinary  CONSTANT TEXT[] := ARRAY['business_isolation_delete', 'business_isolation_insert', 'business_isolation_read',
                                       'business_isolation_update', 'inventory_internal_read', 'tenant_membership'];
  c_source    CONSTANT TEXT[] := ARRAY['accounting_validator', 'business_isolation_delete', 'business_isolation_insert',
                                       'business_isolation_read', 'business_isolation_update', 'inventory_internal_read',
                                       'tenant_membership'];
  c_runtime   CONSTANT TEXT[] := ARRAY['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver',
                                       'daftar_provisioner', 'daftar_reconciler', 'public'];
  c_dml       CONSTANT TEXT[] := ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  c_inv_fns   CONSTANT TEXT[] := ARRAY['stock_binding_requires_sale()', 'stock_source_complete_sale()',
                                       'stock_source_complete_sale_header()', 'sale_header_guard()'];
  c_acc_fns   CONSTANT TEXT[] := ARRAY['accounting_sale_entry_complete()', 'accounting_invoice_entry_complete()',
                                       'sales_walkin_no_ar()', 'sales_cogs_owed()'];
  -- R-P4-02's vocabulary as TL-P4-S1-C1 fixed it, with guard G-3's own
  -- exemptions: an identity, an actor, an instant, a classifier or an
  -- ordering is not a stored quantity, because only a stored NUMBER can
  -- drift from the journal.
  c_forbidden CONSTANT TEXT := '(^|_)(balance|outstanding|paid|unpaid|due|owed|payable|receivable|settled|refunded|collected|allocated|cogs|cost)($|_)';
  c_instant   CONSTANT TEXT := '_(id|ids|at|date|by|status|kind|type|code|name|currency|seq|no)$';
  v_name      TEXT;
  v_sig       TEXT;
  v_n         INTEGER;
  v_def       TEXT;
  v_actual    TEXT[];
  v_con       TEXT;
BEGIN
  -- (1) The three relations exist as plain tables, row security is enabled
  --     AND forced on every one, and each carries tenant_id and business_id
  --     as real NOT NULL columns. This is the law Agent A's RLS/FORCE
  --     discovery guard enforces over the whole Phase 4 surface; 0077
  --     states it about its own three so a failure names the file.
  SELECT count(*) INTO v_n FROM pg_class c
   WHERE c.oid = ANY (SELECT ('public.' || x)::regclass FROM unnest(c_relations) x)
     AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity;
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: row security is not enabled and forced on all three P4-S2 relations (found %)', v_n
      USING ERRCODE = 'P0001';
  END IF;
  FOREACH v_name IN ARRAY c_relations LOOP
    IF (SELECT count(*) FROM pg_attribute a
         WHERE a.attrelid = ('public.' || v_name)::regclass AND a.attnum > 0 AND NOT a.attisdropped
           AND a.attname IN ('tenant_id', 'business_id') AND a.attnotnull) <> 2 THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: % does not carry tenant_id and business_id as NOT NULL columns', v_name
        USING ERRCODE = 'P0001';
    END IF;
    -- No stored derived truth and no stored cost, over the LIVE column list
    -- (P4-AL-05, P4-AL-06; DERIVED_COST_COLUMN at
    -- scripts/guards/no-authoritative-balance.ts:317).
    IF EXISTS (SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = ('public.' || v_name)::regclass AND a.attnum > 0 AND NOT a.attisdropped
                  AND a.attname ~ c_forbidden AND a.attname !~ c_instant) THEN
      RAISE EXCEPTION 'selling.derived_truth_stored: % carries a column of the vocabulary P4-AL-05/06 refuses', v_name
        USING ERRCODE = 'P0001';
    END IF;
    -- No floating point anywhere in Phase 4 (P4-AL-15b): money is integer
    -- minor units and a quantity is NUMERIC.
    IF EXISTS (SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = ('public.' || v_name)::regclass AND a.attnum > 0 AND NOT a.attisdropped
                  AND format_type(a.atttypid, NULL) IN ('real', 'double precision', 'money')) THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: % carries a floating point or money column', v_name
        USING ERRCODE = 'P0001';
    END IF;
    -- No runtime principal holds DML, and none holds anything at column
    -- level: every write goes through a routine whose authority was checked
    -- ([[daftar-wrapper-is-not-an-invariant]] closed by the grant).
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

  -- (2) The policy sets, by NAME and not by count: six on an ordinary
  --     relation, SEVEN on an accounting-source one (P4-AL-38 as corrected
  --     by TL-P4-S1-C2). The sale bridge takes six, not five (TL-P4-S2-K2).
  SELECT array_agg(p.polname::text ORDER BY p.polname) INTO v_actual
    FROM pg_policy p WHERE p.polrelid = 'public.sales'::regclass;
  IF v_actual IS DISTINCT FROM c_source THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: sales does not carry exactly the seven accounting-source policies (found %)', v_actual
      USING ERRCODE = 'P0001';
  END IF;
  FOREACH v_name IN ARRAY ARRAY['sale_items', 'stock_source_bridge_sale'] LOOP
    SELECT array_agg(p.polname::text ORDER BY p.polname) INTO v_actual
      FROM pg_policy p WHERE p.polrelid = ('public.' || v_name)::regclass;
    IF v_actual IS DISTINCT FROM c_ordinary THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: % does not carry exactly the six ordinary policies (found %)', v_name, v_actual
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  -- The tenant policy is the DIRECT form 0052:305-330 adopted after
  -- measurement, never 0063's correlated `businesses` subselect.
  FOREACH v_name IN ARRAY c_relations LOOP
    IF (SELECT pg_get_expr(p.polqual, p.polrelid) FROM pg_policy p
         WHERE p.polrelid = ('public.' || v_name)::regclass AND p.polname = 'tenant_membership')
       NOT LIKE '%tenant_id = (NULLIF(app_tenant()%' THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: %''s tenant policy is not the direct form', v_name USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- (2b) The vacuous-pass correction of section 8b, read from the live
  --      catalogue: `invoice_items` now carries the SEVEN
  --      accounting-source policies, its restrictive read names the
  --      accounting principal, and that principal holds SELECT on the
  --      table. All three are needed — a policy without the grant and a
  --      grant without the policy each read zero rows and pass.
  SELECT array_agg(p.polname::text ORDER BY p.polname) INTO v_actual
    FROM pg_policy p WHERE p.polrelid = 'public.invoice_items'::regclass;
  IF v_actual IS DISTINCT FROM c_source THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: invoice_items does not carry exactly the seven accounting-source policies (found %)', v_actual
      USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT pg_get_expr(p.polqual, p.polrelid) FROM pg_policy p
       WHERE p.polrelid = 'public.invoice_items'::regclass AND p.polname = 'business_isolation_read')
     NOT LIKE '%daftar_accounting_internal%' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: invoice_items''s restrictive read still shuts the accounting validator out'
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT has_table_privilege('daftar_accounting_internal', 'public.invoice_items', 'SELECT')
     OR NOT has_table_privilege('daftar_accounting_internal', 'public.sales', 'SELECT')
     OR NOT has_table_privilege('daftar_accounting_internal', 'public.invoices', 'SELECT') THEN
    RAISE EXCEPTION 'selling.authority_leak: the accounting validator cannot read a table it is judged on' USING ERRCODE = 'P0001';
  END IF;

  -- (3) Seam S-P4-01 is closed: invoices.sale_id carries a VALIDATED
  --     composite foreign key naming business_id on both sides, to sales.
  --     MATCH SIMPLE is safe because invoices_tenant_fk already constrains
  --     business_id independently (P4-AL-08).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conname = 'invoices_sale_fk' AND c.conrelid = 'public.invoices'::regclass
                    AND c.contype = 'f' AND c.convalidated AND c.confrelid = 'public.sales'::regclass
                    AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
                           FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
                        = ARRAY['business_id', 'sale_id']
                    AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
                           FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                           JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum)
                        = ARRAY['business_id', 'id']) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: invoices_sale_fk is not the validated composite edge to sales that closes S-P4-01'
      USING ERRCODE = 'P0001';
  END IF;

  -- (4) The two deferred binding foreign keys are the all-or-nothing
  --     mechanism (P4-AL-16): DEFERRABLE INITIALLY DEFERRED, to
  --     accounting_source_bindings, on the generated source_type constant.
  --     AccountingAssertionSequence.assertComplete() is NOT that mechanism —
  --     presenting none is deliberately allowed
  --     (apps/api/src/infra/database.ts:484-490).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conname = 'sales_binding_fk' AND c.conrelid = 'public.sales'::regclass
                    AND c.contype = 'f' AND c.condeferrable AND c.condeferred
                    AND c.confrelid = 'public.accounting_source_bindings'::regclass) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: sales_binding_fk is not the deferred binding edge' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                  WHERE a.attrelid = 'public.sales'::regclass AND a.attname = 'accounting_source_type'
                    AND NOT a.attisdropped AND a.attgenerated = 's'
                    AND pg_get_expr(d.adbin, d.adrelid) = quote_literal('sale') || '::text') THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: sales.accounting_source_type is not a stored generated constant' USING ERRCODE = 'P0001';
  END IF;

  -- (5) The bridge's own shape, read from the catalogue and not from the
  --     DDL above: the PK is EXACTLY the four pinned columns in order, with
  --     tenant_id a real column OUTSIDE it, and both foreign keys are
  --     validated ON DELETE RESTRICT.
  IF (SELECT array_agg(a.attname::text ORDER BY k.ord)
        FROM pg_constraint c
        CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
       WHERE c.conrelid = 'public.stock_source_bridge_sale'::regclass AND c.contype = 'p')
     IS DISTINCT FROM ARRAY['business_id', 'source_id', 'source_line_id', 'movement_kind'] THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the sale bridge''s primary key is not the four pinned columns' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(*) FROM pg_constraint c
       WHERE c.conrelid = 'public.stock_source_bridge_sale'::regclass AND c.contype = 'f'
         AND c.convalidated AND c.confdeltype = 'r') <> 2 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the sale bridge does not carry its two validated RESTRICT edges (the binding edge and the line edge)'
      USING ERRCODE = 'P0001';
  END IF;
  -- tenant_id is a real column OUTSIDE the pinned key, and its edge is the
  -- composite one to businesses (tenant_id, id) that makes MATCH SIMPLE safe
  -- by constraining business_id independently. A's RLS/FORCE law settles the
  -- lock's one open item in the same direction more strictly: a Phase 4
  -- relation carrying business_id and not tenant_id is a P4-AL-08 violation
  -- in its own right.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conname = 'stock_source_bridge_sale_tenant_fk'
                    AND c.conrelid = 'public.stock_source_bridge_sale'::regclass
                    AND c.contype = 'f' AND c.convalidated AND c.confrelid = 'public.businesses'::regclass
                    AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
                           FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
                        = ARRAY['tenant_id', 'business_id']) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the sale bridge''s tenant edge is not the composite edge to businesses'
      USING ERRCODE = 'P0001';
  END IF;

  -- (6) THE CLAIM THE WHOLE FILE IS JUDGED BY, and it is the live
  --     catalogue's answer and not this file's
  --     ([[daftar-the-live-catalogue-is-the-policy]]): the replaced
  --     discovery reports NO GAP for any registered source type, the `sale`
  --     type included. Before the replacement a sale bridge whose line
  --     foreign key pointed at the wrong table was reported as no gap at
  --     all, so this assertion is only worth something because section 7
  --     ran first.
  SELECT count(*) INTO v_n FROM inventory_stock_source_guard_gaps();
  IF v_n <> 0 THEN
    SELECT string_agg(g.source_type || '/' || g.missing, ', ' ORDER BY g.source_type, g.missing) INTO v_def
      FROM inventory_stock_source_guard_gaps() g;
    RAISE EXCEPTION 'selling.migration_end_state_invalid: inventory_stock_source_guard_gaps() reports % gap(s): %', v_n, v_def
      USING ERRCODE = 'P0001';
  END IF;
  -- And it is still the migrator's INVOKER STABLE with a pinned path and no
  -- grantee: a discovery anyone may replace is not a discovery.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'public.inventory_stock_source_guard_gaps()'::regprocedure
                    AND NOT p.prosecdef AND p.provolatile = 's'
                    AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']
                    -- "the migrator's": the same owner as the frozen registry
                    -- the discovery reads, rather than a role named here.
                    AND p.proowner = (SELECT c.relowner FROM pg_class c WHERE c.oid = 'public.stock_source_types'::regclass))
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
                 WHERE p.oid = 'public.inventory_stock_source_guard_gaps()'::regprocedure AND x.grantee <> p.proowner) THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the replaced discovery is not the migrator''s unexecutable INVOKER' USING ERRCODE = 'P0001';
  END IF;

  -- (7) The four new stock-side guard functions: internal DEFINER, owned by
  --     daftar_inventory_internal, pinned path, and NO grantee but the
  --     owner. EXECUTE is reachability, not authority
  --     ([[daftar-execute-is-reachability-not-authority]]) — a trigger
  --     function needs none at all.
  FOREACH v_sig IN ARRAY c_inv_fns LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                    WHERE p.oid = ('public.' || v_sig)::regprocedure
                      AND r.rolname = 'daftar_inventory_internal' AND p.prosecdef
                      AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp'])
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
                   WHERE p.oid = ('public.' || v_sig)::regprocedure AND x.grantee <> p.proowner) THEN
      RAISE EXCEPTION 'selling.authority_leak: % is not the inventory principal''s pinned DEFINER with no grantee', v_sig USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  -- The cost reader: the same owner, STABLE, and EXACTLY one grantee.
  SELECT array_agg(x.grantee::regrole::text || ':' || x.privilege_type ORDER BY 1) INTO v_actual
    FROM pg_proc p, aclexplode(p.proacl) x
   WHERE p.oid = 'public.inventory_sale_cost_base_minor(uuid,uuid)'::regprocedure AND x.grantee <> p.proowner;
  IF v_actual IS DISTINCT FROM ARRAY['daftar_accounting_internal:EXECUTE']
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                     WHERE p.oid = 'public.inventory_sale_cost_base_minor(uuid,uuid)'::regprocedure
                       AND r.rolname = 'daftar_inventory_internal' AND p.prosecdef AND p.provolatile = 's'
                       AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']) THEN
    RAISE EXCEPTION 'selling.authority_leak: inventory_sale_cost_base_minor is not the inventory principal''s STABLE DEFINER reachable by the accounting principal alone (ACL %)', v_actual
      USING ERRCODE = 'P0001';
  END IF;

  -- (8) The three accounting-side functions: accounting-owned DEFINER,
  --     pinned, no grantee but the owner (TL-P4-S1-C17 — no fifth principal
  --     was introduced, and `daftar_sales_internal` does not exist).
  FOREACH v_sig IN ARRAY c_acc_fns LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                    WHERE p.oid = ('public.' || v_sig)::regprocedure
                      AND r.rolname = 'daftar_accounting_internal' AND p.prosecdef
                      AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp'])
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
                   WHERE p.oid = ('public.' || v_sig)::regprocedure
                     AND x.grantee <> p.proowner AND x.grantee::regrole::text <> 'daftar_accounting_internal') THEN
      RAISE EXCEPTION 'selling.authority_leak: % is not the accounting principal''s pinned DEFINER with no outside grantee', v_sig USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'daftar_sales_internal') THEN
    RAISE EXCEPTION 'selling.authority_leak: daftar_sales_internal exists, which TL-P4-S1-C17 refused in this slice' USING ERRCODE = 'P0001';
  END IF;

  -- (9) The two deferred completeness validators are installed on
  --     journal_entries as DEFERRABLE INITIALLY DEFERRED row triggers with
  --     the WHEN on their own source type, and nothing else.
  FOREACH v_name IN ARRAY ARRAY['sale', 'invoice'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                    WHERE g.tgrelid = 'public.journal_entries'::regclass
                      AND g.tgname = 'journal_entries_' || v_name || '_complete'
                      AND NOT g.tgisinternal AND g.tgtype = 5 AND g.tgenabled IN ('O', 'A')
                      AND g.tgconstraint <> 0 AND g.tgdeferrable AND g.tginitdeferred
                      AND g.tgfoid = ('public.accounting_' || v_name || '_entry_complete()')::regprocedure
                      AND position('WHEN ((new.source_type = ' || quote_literal(v_name) || '::text))' IN pg_get_triggerdef(g.oid)) > 0) THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: the % entry completeness validator is not installed as a deferred constraint trigger', v_name
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- (9b) The two deferred obligations on `sales` are installed as DEFERRABLE
  --      INITIALLY DEFERRED constraint triggers: `sales_cogs_owed`, which
  --      carries the COGS obligation a row CHECK cannot express (C-07), and
  --      `sales_walkin_no_ar`. Read from the catalogue, because a trigger this
  --      file created and a trigger the database holds are different claims.
  FOREACH v_name IN ARRAY ARRAY['sales_cogs_owed', 'sales_walkin_no_ar'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                    WHERE g.tgrelid = 'public.sales'::regclass AND g.tgname = v_name
                      AND NOT g.tgisinternal AND g.tgtype = 21 AND g.tgenabled IN ('O', 'A')
                      AND g.tgconstraint <> 0 AND g.tgdeferrable AND g.tginitdeferred
                      AND g.tgfoid = ('public.' || v_name || '()')::regprocedure) THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: % is not installed on sales as a deferred constraint trigger', v_name
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  -- And the COGS obligation is NOT expressible as a row CHECK, which is why it
  -- is a trigger: assert the weakened CHECK really is the weak one, so a later
  -- hand cannot quietly restore the strict form and make a lawful zero-cost
  -- sale uncommittable again.
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
       WHERE c.conrelid = 'public.sales'::regclass AND c.conname = 'sales_binding_owed_ck')
     IS DISTINCT FROM 'CHECK (((status <> ''draft''::text) OR (binding_source_id IS NULL)))' THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: sales_binding_owed_ck is not the draft-only half C-07 leaves it (found %)',
      (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
        WHERE c.conrelid = 'public.sales'::regclass AND c.conname = 'sales_binding_owed_ck')
      USING ERRCODE = 'P0001';
  END IF;

  -- (10) The reversal guard's live BODY refuses both new types, and keeps
  --      every refusal it already carried. Read from prosrc, because the
  --      replacement in section 9(a) is a claim about what the database now
  --      holds and not about what this file said.
  SELECT p.prosrc INTO v_def FROM pg_proc p WHERE p.oid = 'public.accounting_reversals_20_domain_source_guard()'::regprocedure;
  IF position('''inventory_adjustment'', ''inventory_opening'', ''negative_inventory_cost_adjustment'', ''supplier_return'', ''supplier_payment'', ''supplier_credit_allocation'', ''supplier_refund''' IN v_def) = 0
     OR position('''purchase_residue_write_off''' IN v_def) = 0
     OR position('''sale''' IN v_def) = 0 OR position('''invoice''' IN v_def) = 0
     OR position('je.source_type = ''purchase''' IN v_def) = 0 OR position('FROM purchase_reversals r' IN v_def) = 0
     OR position('r.original_entry_id = NEW.original_entry_id' IN v_def) = 0
     OR position('FROM accounting_opening_balances ob' IN v_def) = 0 OR position('FOR NO KEY UPDATE' IN v_def) = 0
     OR position('accounting.opening_balance_inventory_bound:' IN v_def) = 0 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the reversal guard does not refuse the sale and invoice sources while keeping every earlier refusal'
      USING ERRCODE = 'P0001';
  END IF;

  -- (11) The registry rows, each attributed to P4-S2, and `sale.commit`
  --      ALONE (TL-P4-S2-K1): a registered authority with no writer is what
  --      TL-P4-S1-R1 refused, so sale.void and sale.return belong to the
  --      slices that supply theirs. Asserted as an EXACT equality on the
  --      P4-S2-registered subset, never as a count over the whole registry
  --      — a closure rule is not an invariant
  --      ([[daftar-a-closure-rule-is-not-an-invariant]]).
  SELECT array_agg(k.op_code::text ORDER BY k.op_code) INTO v_actual
    FROM inventory_operation_kinds k WHERE k.registered_by = 'P4-S2';
  IF v_actual IS DISTINCT FROM ARRAY['sale.commit'] THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: P4-S2 registers % and not sale.commit alone', v_actual USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM stock_movement_kinds k
                  WHERE k.movement_kind = 'sale' AND k.qty_sign = 'negative' AND NOT k.requires_reason AND k.registered_by = 'P4-S2')
     OR NOT EXISTS (SELECT 1 FROM stock_source_types t WHERE t.source_type = 'sale' AND t.registered_by = 'P4-S2')
     OR NOT EXISTS (SELECT 1 FROM inventory_operation_movement_kinds m
                     WHERE m.op_code = 'sale.commit' AND m.movement_kind = 'sale' AND m.registered_by = 'P4-S2') THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the sale stock registrations are not exactly as P4-S2 states them' USING ERRCODE = 'P0001';
  END IF;
  SELECT array_agg(t.source_type::text || '/' || t.sort_order::text ORDER BY t.sort_order) INTO v_actual
    FROM accounting_source_types t WHERE t.source_type IN ('sale', 'invoice');
  IF v_actual IS DISTINCT FROM ARRAY['sale/13', 'invoice/14'] THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: the two accounting source types are not registered at 13 and 14 (found %)', v_actual
      USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(*) FROM accounting_operation_kinds k
       WHERE k.source_type IN ('sale', 'invoice') AND k.operation_kind = 'post') <> 2 THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: each new accounting source type does not own its post operation kind (0046)'
      USING ERRCODE = 'P0001';
  END IF;

  -- (12) `inventory_apply_stock_movements` is UNCHANGED. 0077 registers a
  --      movement kind and a source type; it does not touch the primitive,
  --      and OD-P4-05 (NO OVERSELL) stays exactly where it lives. A request
  --      to change it is a Tech Lead review point, not a migration.
  IF to_regproc('public.inventory_apply_stock_movements') IS NULL THEN
    RAISE EXCEPTION 'selling.migration_end_state_invalid: inventory_apply_stock_movements is missing' USING ERRCODE = 'P0001';
  END IF;

  -- (13) 0077 ships NO writer, which is the other half of TL-P4-S2-K1: no
  --      routine in this file writes a sale, a line, a bridge row or an
  --      entry. `sale_commit` is 0078's. Asserted physically: the only new
  --      routines are the five guards, the cost reader and the two
  --      validators, and none of them is granted to a runtime principal.
  SELECT count(*) INTO v_n FROM pg_proc p, aclexplode(p.proacl) x
   WHERE p.proname IN ('stock_binding_requires_sale', 'stock_source_complete_sale', 'stock_source_complete_sale_header',
                       'sale_header_guard', 'inventory_sale_cost_base_minor', 'accounting_sale_entry_complete',
                       'accounting_invoice_entry_complete', 'sales_walkin_no_ar', 'sales_cogs_owed')
     AND x.grantee::regrole::text = ANY (c_runtime);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'selling.authority_leak: a runtime principal may execute one of 0077''s routines (% grants)', v_n USING ERRCODE = 'P0001';
  END IF;
END
$end$;

-- ─────────────────────────────────────────────────────────────────────────
-- 11. The performed proofs (the 0074:150-300 three-block pattern): a claim
--     read from the catalogue is a claim about shape, and a shape can be
--     right while the behaviour is wrong. Each block below PERFORMS the
--     refusal inside a subtransaction and rolls it back, and each handler
--     reads GET STACKED DIAGNOSTICS CONSTRAINT_NAME or the SQLERRM, so a
--     probe that trips a DIFFERENT refusal is reported as a DEFECTIVE PROBE
--     and never as a proof.
--
--     These three need no fixture row, which is why they are here: a
--     migration must not create a business, a branch and a warehouse to
--     prove something, and the `invoices_sale_fk` behaviour therefore stays
--     a catalogue claim (section 10(3)) with its performed proof owed by
--     the slice that has a fixture — recorded, not hidden.
-- ─────────────────────────────────────────────────────────────────────────
DO $proof$
DECLARE
  v_msg      TEXT;
  v_tenant   UUID := gen_random_uuid();
  v_business UUID := gen_random_uuid();
BEGIN
  -- (a) A sale is never INSERTed already void.
  BEGIN
    INSERT INTO sales (tenant_id, business_id, id, branch_id, warehouse_id, status, settlement_mode, document_date,
                       currency_code, subtotal_txn_minor, discount_txn_minor, total_txn_minor, total_base_minor,
                       source_to_base_rate, rate_source, rate_timestamp, commit_intent_sha256,
                       confirmed_by, confirmed_at, void_intent_sha256, voided_by, voided_at,
                       business_transaction_id, created_by)
      VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
              'void', 'cash', DATE '2026-01-01', 'USD', 100, 0, 100, 100, 1, 'base', date_trunc('second', now()),
              repeat('a', 64), gen_random_uuid(), now(), repeat('b', 64), gen_random_uuid(), now(),
              gen_random_uuid(), gen_random_uuid());
    RAISE EXCEPTION 'selling.migration_end_state_invalid: a sale was INSERTed already void' USING ERRCODE = 'P0001';
  EXCEPTION
    WHEN OTHERS THEN
      v_msg := SQLERRM;
      IF position('selling.source_document_immutable' IN v_msg) = 0 THEN
        RAISE EXCEPTION 'selling.migration_end_state_invalid: the already-void probe is DEFECTIVE — it tripped % instead of the lifecycle guard', v_msg
          USING ERRCODE = 'P0001';
      END IF;
  END;

  -- (b) A draft sale is never INSERTed carrying an accounting binding.
  BEGIN
    INSERT INTO sales (tenant_id, business_id, id, branch_id, warehouse_id, status, settlement_mode, document_date,
                       currency_code, subtotal_txn_minor, discount_txn_minor, total_txn_minor, total_base_minor,
                       source_to_base_rate, rate_source, rate_timestamp, commit_intent_sha256,
                       business_transaction_id, created_by, binding_source_id)
      VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
              'draft', 'cash', DATE '2026-01-01', 'USD', 100, 0, 100, 100, 1, 'base', date_trunc('second', now()),
              repeat('a', 64), gen_random_uuid(), gen_random_uuid(), gen_random_uuid());
    RAISE EXCEPTION 'selling.migration_end_state_invalid: a draft sale was INSERTed with a binding' USING ERRCODE = 'P0001';
  EXCEPTION
    WHEN OTHERS THEN
      v_msg := SQLERRM;
      -- sales_binding_owed_ck and the guard both refuse this; either is the
      -- claim, and anything else is a defective probe.
      IF position('selling.source_document_immutable' IN v_msg) = 0
         AND position('sales_binding_owed_ck' IN v_msg) = 0 THEN
        RAISE EXCEPTION 'selling.migration_end_state_invalid: the draft-with-binding probe is DEFECTIVE — it tripped %', v_msg
          USING ERRCODE = 'P0001';
      END IF;
  END;

  -- (c) A non-zero tax is REFUSED and never computed. OD-03 is OPEN: sales
  --     tax is structurally zero in this slice, and no jurisdiction's rule
  --     is encoded anywhere in this file.
  --
  --     This probe needs the row to REACH its CHECK constraints, and under
  --     FORCE ROW LEVEL SECURITY the WITH CHECK of the two insert policies is
  --     evaluated FIRST — measured, not assumed: without a satisfied tenant
  --     context the probe trips "new row violates row-level security policy"
  --     and this block reports itself DEFECTIVE, which is exactly what it is
  --     for. It is satisfied the only way that widens nothing: the probe
  --     STATES a tenant and a business context and inserts a row in it.
  --     `app.bypass_rls` would not do — the live app_bypass() is
  --     `current_user = 'daftar_platform'`, not the setting 0006:11 defined,
  --     which is itself a reminder that the live catalogue is the policy.
  PERFORM set_config('app.tenant_id', v_tenant::text, true);
  PERFORM set_config('app.business_id', v_business::text, true);
  BEGIN
    INSERT INTO sales (tenant_id, business_id, id, branch_id, warehouse_id, status, settlement_mode, document_date,
                       currency_code, subtotal_txn_minor, discount_txn_minor, tax_minor, total_txn_minor, total_base_minor,
                       source_to_base_rate, rate_source, rate_timestamp, commit_intent_sha256,
                       business_transaction_id, created_by)
      VALUES (v_tenant, v_business, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
              'draft', 'cash', DATE '2026-01-01', 'USD', 100, 0, 15, 115, 115, 1, 'base', date_trunc('second', now()),
              repeat('a', 64), gen_random_uuid(), gen_random_uuid());
    RAISE EXCEPTION 'selling.migration_end_state_invalid: a sale carrying a non-zero tax was accepted' USING ERRCODE = 'P0001';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS v_msg = CONSTRAINT_NAME;
      IF v_msg IS DISTINCT FROM 'sales_tax_policy_absent_ck' THEN
        RAISE EXCEPTION 'selling.migration_end_state_invalid: the tax probe is DEFECTIVE — it tripped % instead of sales_tax_policy_absent_ck', v_msg
          USING ERRCODE = 'P0001';
      END IF;
    WHEN OTHERS THEN
      RAISE EXCEPTION 'selling.migration_end_state_invalid: the tax probe is DEFECTIVE — it tripped %', SQLERRM USING ERRCODE = 'P0001';
  END;
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.business_id', '', true);
END
$proof$;
