-- 0063_purchases_suppliers_sources.sql
-- P3-S4, part 1 — the SOURCE side of suppliers and purchases: the supplier,
-- purchase, line, landed-cost and allocation tables; the negative-inventory
-- cost adjustment header (the coverage header); the coverage and deficit
-- additions; the two bridges and every stock-side guard; the replaced
-- source-guard discovery; the two stock source registrations; the
-- accounting-side objects (purchase FX read, two completeness triggers, the
-- replaced reversal guard) and the two accounting registrations
-- (docs/PHASE_3_S4_CONTRACT.md §2.1-§2.3, §2.6, §2.8, A-04, A-05, A-11-A-18).
--
-- ── What this file does NOT do ──────────────────────────────────────────
--
-- It registers no inventory operation kind and no op→movement mapping. After
-- it, no signed command can reach a single new table or write a single
-- movement: the runtime reach is 0064's, and only 0064's.
--
-- ── Header rules (§2.1) ─────────────────────────────────────────────────
--
--   R-15 THE GLOBAL LOCK ORDER, extended (never reordered) from 0061 R-13.
--        Every S4 path skips the steps it has no use for:
--          1  assertion consume / verify                  (no lock)
--          2  the per-document advisory key               ('daftar.purchase_id' |
--                                                          'daftar.supplier_id')
--          2a the document row FOR UPDATE                 (purchases | suppliers)
--          2b the supplier row FOR SHARE                  (purchase.draft,
--                                                          purchase.receive)
--          3-5 (not used by S4: no opening-balance step)
--          6  stock targets (shared advisory), products FOR SHARE (id
--             order), stock keys FOR UPDATE ((warehouse, variant) order)
--          6b deficit layers FOR UPDATE                   ((deficit_seq, id) per
--             key, keys in (warehouse, variant) order; only ever taken while
--             holding 6 for the same key)
--          7  accounting_post_entry, 'purchase' then
--             'negative_inventory_cost_adjustment'
--        No S4 path takes a purchase row after a supplier row, and no
--        supplier path touches a purchase, so 2a/2b form no cycle.
--   R-16 COVERAGE (A-16). One `negative_inventory_cost_adjustments` header
--        per receipt that covers anything (origin = the purchase, the line
--        NULL: one warehouse and one line per variant make the covering line
--        (origin, coverage.variant) exact). Each coverage row owns exactly one
--        value-only movement iff its catch-up value is non-zero (TL-5); the
--        value is −HALF_EVEN(c × (actual − provisional)), except the one
--        flush-eligible coverage of a line that closes every open layer of
--        its key (TL-6), which carries −valuation. Verified at COMMIT by
--        `stock_source_complete_negative_inventory_cost_adjustment`, whose
--        flush test is: last of its variant in its header by (deficit_seq,
--        id), the covering line's qty = Σ qty_covered of that variant in the
--        header, and no layer of the key open at COMMIT.
--   R-17 THE FX INSTANT (A-17, TL-2). A draft stores its currency only; the
--        snapshot is taken at receipt. Domestic: (no rate row, 1, 'base',
--        <document_date>T00:00:00Z). Foreign: the registry row in force at
--        ((document_date + 1)::timestamp AT TIME ZONE businesses.timezone)
--        − 1 second, the last second of the document date in the business
--        timezone; no clock is read, so the service and the routine compute
--        the same instant. `accounting_purchase_fx_rate` is the read.
--   R-18 THE TAX BOUND (A-12, OD-03). `purchases.tax_minor` exists and is
--        physically zero (`purchases_tax_policy_absent_ck`). No tax
--        arithmetic and no tax posting exists anywhere: every such element
--        is BLOCKED BY OD-03.
--
-- ── Engineering rulings taken here (documented for the report) ──────────
--
--   R-19 `purchase_lines.unit_price_txn_minor` is declared NUMERIC with a
--        CHECK that the value is exact at 10 places (`= trunc(value, 10)`),
--        non-negative and below 10^18, instead of the column typmod the
--        contract names. Static rule 6 (money is BIGINT minor units) refuses
--        any money-named column typed with a precision and scale; the CHECK
--        states the same exactness by testing the VALUE (a typmod would
--        round silently on the way in, the CHECK refuses).
--   R-20 The replaced `inventory_stock_source_guard_gaps()` keeps every S3
--        statement, the S3 line-table rows, the S3 per-type set and all
--        sixteen recorded S3 digests (the contract says "thirteen"; 0061
--        records sixteen, and every one is kept verbatim). The only edit to
--        an S3 statement is the strictness condition of bridge_line_fk,
--        bridge_immutable and binding_trigger, which reads
--        `NOT (v_s3 OR v_s4)` so the S4 types get the exact S3 treatment
--        (§2.3). The S4 per-type set is a separate loop, because two of its
--        guards run on `stock_ledger_append_only()`, a migrator-owned
--        INVOKER function: those rows require an invoker function with the
--        recorded body, the others an internal DEFINER one.
--   R-21 The two constraints of the coverage bridge are named
--        `stock_source_bridge_nica_line_fk` / `_binding_fk`: the S3 naming
--        (`stock_source_bridge_<type>_binding_fk`) exceeds PostgreSQL's
--        63-byte identifier limit for this type and would be truncated.
--   R-22 `accounting_purchase_fx_rate` converts to the business's own
--        `base_currency` (the contract's signature names no target) and
--        otherwise raises exactly what `accounting_fx_rate_lookup` raises
--        (accounting.fx_currency_unknown / fx_same_currency /
--        fx_rate_missing).
--   R-23 A supplier row whose identity or creation columns change is refused
--        `supplier.state_invalid` (A-15(g) names no code); a revision that is
--        not OLD + 1 is refused `supplier.revision_changed`.
--   R-24 Every new stock-side function — the supplier, landed-cost,
--        allocation and deficit guards included — is internal-owned
--        SECURITY DEFINER with the pinned path and no grantee, uniformly
--        (A-15, 0063-E (7)); none decides by `current_user`.
--
-- ── Security-review rulings (P3-S4 review, documented for the report) ───
--
--   R-34 NOTHING IS ADDED TO A RECEIVED OR CANCELLED PURCHASE (review M1).
--        The three freeze triggers `stock_source_freeze_purchase`,
--        `purchase_landed_costs_freeze` and
--        `purchase_landed_cost_allocations_freeze` are BEFORE INSERT OR
--        UPDATE OR DELETE (tgtype 31, not §2.3's 27): an INSERT is refused
--        `inventory.source_line_frozen` unless the parent purchase is a
--        draft (the draft replace of `purchase_save_draft` is the only
--        legitimate inserter), and a line is never inserted carrying the
--        receipt's base share or unit cost. At COMMIT, a line, landed cost
--        or allocation written in a transaction that leaves its purchase
--        cancelled is refused the same way: `stock_source_complete_purchase`
--        no longer accepts a movement-less line of a cancelled purchase, and
--        `purchase_allocations_consistent()` refuses a cancelled parent and
--        now also runs on landed-cost INSERT (the new deferred trigger
--        `purchase_landed_costs_consistent`, tgtype 5), so a landed cost
--        cannot commit without its allocations either.
--   R-35 THE INTERNAL PRINCIPAL WRITES ONLY IN ITS SCOPE (review L1). The
--        restrictive business isolation of every S4 table is split per
--        command: `business_isolation_read` (FOR SELECT) keeps the internal
--        admission; `business_isolation_insert`, `_update` and `_delete`
--        admit nobody but `app_bypass()` or the row whose `business_id` is
--        `app.business_id`. The tenant is held for UPDATE and DELETE by
--        `tenant_membership`, the only permissive policy those commands
--        have for the internal principal (its admission is FOR SELECT). Every
--        routine writes under its verified scope (the assertion binds
--        `app.tenant_id` / `app.business_id`); every guard only reads.
--   R-36 A COVERAGE IS WRITTEN ONLY WITH ITS HEADER (review L2).
--        `negative_deficit_coverages_same_transaction` (BEFORE INSERT,
--        tgtype 7, internal DEFINER) refuses
--        `inventory.source_document_immutable` a coverage whose header
--        exists but was not created in this transaction: the header's
--        `created_at` (DEFAULT now(), insert-only) must be this
--        transaction's `now()` AND its `business_transaction_id` this
--        transaction's trace. A coverage naming no header passes to the
--        immediate FK, so the S2 CHECK refusals keep their SQLSTATEs. The
--        completeness function requires the covering line
--        (`inventory.source_line_missing` when the variant is not a line of
--        the origin purchase), and `purchase_source_value_complete()` also
--        runs on coverage INSERT (the new deferred trigger
--        `negative_deficit_coverages_value_complete`, tgtype 5), so the
--        header total always equals Σ its movement values.
--   R-37 THE FLUSH EXEMPTION FAILS CLOSED (review I2). The deficit and
--        coverage reads it rests on are scoped by `app.tenant_id` /
--        `app.business_id` (0059 RLS); unless both GUCs are set and equal
--        the coverage's own tenant and business at COMMIT, no coverage is
--        flush-eligible and the formula value is required.
--   R-38 THE DISCOVERY SEES EVERY S4 GUARD (review I1). The purchase rows of
--        `inventory_stock_source_guard_gaps()` also report the two
--        landed-cost freeze triggers (`landed_cost_freeze`,
--        `allocation_freeze`), `purchase_allocations_consistent`
--        (`allocation_consistent`) and its landed-cost twin
--        (`landed_cost_consistent`); the coverage rows also report the
--        same-transaction guard (`coverage_same_transaction`), the coverage
--        value check (`coverage_value_complete`) and the two A-16(g) deficit
--        guards (`deficit_guard`, `deficit_consistent`). Each is checked for
--        table, name, tgtype, WHEN, column list, deferral, enabled state
--        ('O'/'A'), function, owner, DEFINER, path and the recorded body
--        digest, so a disabled, replica-only, re-pointed or body-changed
--        guard is reported. The sixteen S3 digests stay byte-identical.
--   R-39 A PURCHASE IS BORN A DRAFT (review follow-up to M1). The header
--        guard `purchases_immutable` is BEFORE INSERT OR UPDATE OR DELETE
--        (tgtype 31, not §2.3's 27): an INSERT is refused
--        `inventory.source_document_immutable` unless the row is
--        `status = 'draft'` at `revision = 1` with every receive and cancel
--        column (intents, FX snapshot, base total, supplier snapshots,
--        received_* / cancelled_*, binding_source_id) NULL, so no row can
--        enter already received or cancelled around its guards. The draft
--        create of `purchase_save_draft` is the only legitimate inserter.
--
-- Migrations 0000-0062 are FROZEN and untouched.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The six tables (§2.2, A-04, A-11, A-12, A-16(a)).
--
-- Money is BIGINT minor units, rates NUMERIC(20,10), quantities
-- NUMERIC(18,4), costs NUMERIC(28,10). A posting header carries a nullable
-- mirror of its own id, `binding_source_id`, bound to the accounting binding
-- registry by a DEFERRABLE foreign key (the 0047 shape).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE suppliers (
  tenant_id               UUID NOT NULL,
  business_id             UUID NOT NULL,
  id                      UUID NOT NULL,
  name                    TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200 AND name = btrim(name)),
  phone                   TEXT CHECK (phone IS NULL OR (char_length(phone) BETWEEN 1 AND 40 AND phone = btrim(phone))),
  email                   TEXT CHECK (email IS NULL OR (char_length(email) BETWEEN 3 AND 254 AND email = btrim(email))),
  tax_identifier          TEXT CHECK (tax_identifier IS NULL OR (char_length(tax_identifier) BETWEEN 1 AND 64 AND tax_identifier = btrim(tax_identifier))),
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
  CONSTRAINT suppliers_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id)
);
REVOKE ALL ON suppliers FROM PUBLIC;

CREATE TABLE purchases (
  tenant_id                        UUID NOT NULL,
  business_id                      UUID NOT NULL,
  id                               UUID NOT NULL,
  supplier_id                      UUID NOT NULL,
  warehouse_id                     UUID NOT NULL,
  currency_code                    CHAR(3) NOT NULL,
  document_date                    DATE NOT NULL,
  supplier_reference               TEXT CHECK (supplier_reference IS NULL
                                               OR (char_length(supplier_reference) BETWEEN 1 AND 200 AND supplier_reference = btrim(supplier_reference))),
  notes                            TEXT CHECK (notes IS NULL OR (char_length(notes) BETWEEN 1 AND 1000 AND notes = btrim(notes))),
  status                           TEXT NOT NULL CHECK (status IN ('draft', 'received', 'cancelled')),
  revision                         INTEGER NOT NULL CHECK (revision >= 1),
  draft_intent_sha256              TEXT NOT NULL CHECK (draft_intent_sha256 ~ '^[0-9a-f]{64}$'),
  receive_intent_sha256            TEXT CHECK (receive_intent_sha256 IS NULL OR receive_intent_sha256 ~ '^[0-9a-f]{64}$'),
  cancel_intent_sha256             TEXT CHECK (cancel_intent_sha256 IS NULL OR cancel_intent_sha256 ~ '^[0-9a-f]{64}$'),
  subtotal_txn_minor               BIGINT NOT NULL CHECK (subtotal_txn_minor BETWEEN 0 AND 1000000000000000000),
  landed_cost_txn_minor            BIGINT NOT NULL CHECK (landed_cost_txn_minor BETWEEN 0 AND 1000000000000000000),
  tax_minor                        BIGINT NOT NULL DEFAULT 0 CONSTRAINT purchases_tax_policy_absent_ck CHECK (tax_minor = 0),
  total_txn_minor                  BIGINT NOT NULL CHECK (total_txn_minor BETWEEN 1 AND 1000000000000000000),
  source_to_base_rate              NUMERIC(20,10) CHECK (source_to_base_rate IS NULL OR source_to_base_rate > 0),
  rate_source                      TEXT CHECK (rate_source IS NULL OR rate_source IN ('base', 'manual')),
  rate_timestamp                   TIMESTAMPTZ CHECK (rate_timestamp IS NULL OR date_trunc('second', rate_timestamp) = rate_timestamp),
  fx_rate_id                       UUID,
  total_base_minor                 BIGINT CHECK (total_base_minor IS NULL OR total_base_minor BETWEEN 1 AND 1000000000000000000),
  supplier_name_snapshot           TEXT,
  supplier_tax_identifier_snapshot TEXT,
  supplier_phone_snapshot          TEXT,
  received_by                      UUID REFERENCES users (id),
  received_at                      TIMESTAMPTZ,
  cancelled_by                     UUID REFERENCES users (id),
  cancelled_at                     TIMESTAMPTZ,
  business_transaction_id          UUID NOT NULL,
  created_by                       UUID NOT NULL REFERENCES users (id),
  created_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
  accounting_source_type           TEXT NOT NULL GENERATED ALWAYS AS ('purchase') STORED,
  binding_source_id                UUID,
  PRIMARY KEY (business_id, id),
  CONSTRAINT purchases_warehouse_uq UNIQUE (business_id, id, warehouse_id),
  CONSTRAINT purchases_total_ck CHECK (total_txn_minor = subtotal_txn_minor + landed_cost_txn_minor + tax_minor),
  CONSTRAINT purchases_binding_identity_ck CHECK (binding_source_id IS NULL OR binding_source_id = id),
  CONSTRAINT purchases_binding_owed_ck CHECK ((status = 'received') = (binding_source_id IS NOT NULL)),
  CONSTRAINT purchases_rate_shape_ck CHECK (
    rate_source IS NULL OR ((rate_source = 'base') = (fx_rate_id IS NULL AND source_to_base_rate = 1))),
  -- The state machine as a physical shape (the 0047 / stocktake pattern).
  CONSTRAINT purchases_state_ck CHECK (
    (status = 'draft'
       AND receive_intent_sha256 IS NULL AND cancel_intent_sha256 IS NULL
       AND source_to_base_rate IS NULL AND rate_source IS NULL AND rate_timestamp IS NULL AND fx_rate_id IS NULL
       AND total_base_minor IS NULL AND supplier_name_snapshot IS NULL AND supplier_tax_identifier_snapshot IS NULL
       AND supplier_phone_snapshot IS NULL AND received_by IS NULL AND received_at IS NULL
       AND cancelled_by IS NULL AND cancelled_at IS NULL)
    OR (status = 'received'
       AND receive_intent_sha256 IS NOT NULL AND cancel_intent_sha256 IS NULL
       AND source_to_base_rate IS NOT NULL AND rate_source IS NOT NULL AND rate_timestamp IS NOT NULL
       AND total_base_minor IS NOT NULL AND supplier_name_snapshot IS NOT NULL
       AND received_by IS NOT NULL AND received_at IS NOT NULL
       AND cancelled_by IS NULL AND cancelled_at IS NULL)
    OR (status = 'cancelled'
       AND cancel_intent_sha256 IS NOT NULL AND cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL
       AND receive_intent_sha256 IS NULL
       AND source_to_base_rate IS NULL AND rate_source IS NULL AND rate_timestamp IS NULL AND fx_rate_id IS NULL
       AND total_base_minor IS NULL AND supplier_name_snapshot IS NULL AND supplier_tax_identifier_snapshot IS NULL
       AND supplier_phone_snapshot IS NULL AND received_by IS NULL AND received_at IS NULL)
  ),
  CONSTRAINT purchases_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT purchases_supplier_fk FOREIGN KEY (business_id, supplier_id) REFERENCES suppliers (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT purchases_warehouse_fk FOREIGN KEY (business_id, warehouse_id) REFERENCES warehouses (business_id, id),
  CONSTRAINT purchases_currency_fk FOREIGN KEY (currency_code) REFERENCES currencies (code),
  CONSTRAINT purchases_fx_rate_fk FOREIGN KEY (business_id, fx_rate_id) REFERENCES accounting_fx_rates (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT purchases_binding_fk
    FOREIGN KEY (business_id, accounting_source_type, binding_source_id)
    REFERENCES accounting_source_bindings (business_id, source_type, source_id)
    DEFERRABLE INITIALLY DEFERRED
);
REVOKE ALL ON purchases FROM PUBLIC;

-- The supplier payable read (A-20) walks a supplier's received purchases.
CREATE INDEX purchases_supplier_idx ON purchases (business_id, supplier_id);

CREATE TABLE purchase_lines (
  tenant_id             UUID NOT NULL,
  business_id           UUID NOT NULL,
  purchase_id           UUID NOT NULL,
  id                    UUID NOT NULL,
  line_no               INTEGER NOT NULL CHECK (line_no > 0),
  variant_id            UUID NOT NULL,
  qty                   NUMERIC(18,4) NOT NULL CHECK (qty > 0 AND qty < 10000000000),
  -- R-19: exact at 10 places by value, not by typmod.
  unit_price_txn_minor  NUMERIC NOT NULL CHECK (unit_price_txn_minor >= 0 AND unit_price_txn_minor < 1000000000000000000
                                                AND unit_price_txn_minor = trunc(unit_price_txn_minor, 10)),
  gross_txn_minor       BIGINT NOT NULL CHECK (gross_txn_minor BETWEEN 0 AND 1000000000000000000),
  discount_txn_minor    BIGINT NOT NULL CHECK (discount_txn_minor >= 0 AND discount_txn_minor <= gross_txn_minor),
  net_txn_minor         BIGINT NOT NULL CHECK (net_txn_minor = gross_txn_minor - discount_txn_minor),
  landed_cost_txn_minor BIGINT NOT NULL CHECK (landed_cost_txn_minor BETWEEN 0 AND 1000000000000000000),
  base_share_minor      BIGINT CHECK (base_share_minor IS NULL OR base_share_minor BETWEEN 0 AND 1000000000000000000),
  unit_cost_base_minor  NUMERIC(28,10) CHECK (unit_cost_base_minor IS NULL OR unit_cost_base_minor >= 0),
  PRIMARY KEY (business_id, id),
  CONSTRAINT purchase_lines_bridge_uq UNIQUE (business_id, purchase_id, id),
  CONSTRAINT purchase_lines_line_no_uq UNIQUE (business_id, purchase_id, line_no),
  CONSTRAINT purchase_lines_variant_uq UNIQUE (business_id, purchase_id, variant_id),
  CONSTRAINT purchase_lines_receipt_shape_ck CHECK ((base_share_minor IS NULL) = (unit_cost_base_minor IS NULL)),
  CONSTRAINT purchase_lines_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT purchase_lines_header_fk FOREIGN KEY (business_id, purchase_id) REFERENCES purchases (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT purchase_lines_variant_fk FOREIGN KEY (business_id, variant_id) REFERENCES product_variants (business_id, id)
);
REVOKE ALL ON purchase_lines FROM PUBLIC;

CREATE TABLE purchase_landed_costs (
  tenant_id        UUID NOT NULL,
  business_id      UUID NOT NULL,
  purchase_id      UUID NOT NULL,
  id               UUID NOT NULL,
  cost_no          INTEGER NOT NULL CHECK (cost_no > 0),
  mode             TEXT NOT NULL CHECK (mode IN ('by_value', 'manual')),
  amount_txn_minor BIGINT NOT NULL CHECK (amount_txn_minor BETWEEN 1 AND 1000000000000000000),
  description      TEXT CHECK (description IS NULL OR (char_length(description) BETWEEN 1 AND 200 AND description = btrim(description))),
  PRIMARY KEY (business_id, id),
  CONSTRAINT purchase_landed_costs_cost_no_uq UNIQUE (business_id, purchase_id, cost_no),
  CONSTRAINT purchase_landed_costs_purchase_uq UNIQUE (business_id, purchase_id, id),
  CONSTRAINT purchase_landed_costs_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT purchase_landed_costs_header_fk FOREIGN KEY (business_id, purchase_id) REFERENCES purchases (business_id, id) ON DELETE RESTRICT
);
REVOKE ALL ON purchase_landed_costs FROM PUBLIC;

CREATE TABLE purchase_landed_cost_allocations (
  tenant_id        UUID NOT NULL,
  business_id      UUID NOT NULL,
  purchase_id      UUID NOT NULL,
  landed_cost_id   UUID NOT NULL,
  purchase_line_id UUID NOT NULL,
  amount_txn_minor BIGINT NOT NULL CHECK (amount_txn_minor BETWEEN 0 AND 1000000000000000000),
  PRIMARY KEY (business_id, landed_cost_id, purchase_line_id),
  CONSTRAINT purchase_landed_cost_allocations_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT purchase_landed_cost_allocations_cost_fk
    FOREIGN KEY (business_id, purchase_id, landed_cost_id) REFERENCES purchase_landed_costs (business_id, purchase_id, id) ON DELETE RESTRICT,
  CONSTRAINT purchase_landed_cost_allocations_line_fk
    FOREIGN KEY (business_id, purchase_id, purchase_line_id) REFERENCES purchase_lines (business_id, purchase_id, id) ON DELETE RESTRICT
);
REVOKE ALL ON purchase_landed_cost_allocations FROM PUBLIC;

CREATE TABLE negative_inventory_cost_adjustments (
  tenant_id               UUID NOT NULL,
  business_id             UUID NOT NULL,
  id                      UUID NOT NULL,
  warehouse_id            UUID NOT NULL,
  origin_source_type      TEXT NOT NULL CHECK (origin_source_type = 'purchase'),
  origin_source_id        UUID NOT NULL,
  -- R-16: NULL for the receipt-grain header of S4 (TL-7).
  origin_source_line_id   UUID CHECK (origin_source_line_id IS NULL),
  occurred_on             DATE NOT NULL,
  total_value_base_minor  BIGINT NOT NULL CHECK (total_value_base_minor BETWEEN -1000000000000000000 AND 1000000000000000000),
  actor_user_id           UUID NOT NULL REFERENCES users (id),
  business_transaction_id UUID NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  accounting_source_type  TEXT NOT NULL GENERATED ALWAYS AS ('negative_inventory_cost_adjustment') STORED,
  binding_source_id       UUID,
  PRIMARY KEY (business_id, id),
  CONSTRAINT negative_inventory_cost_adjustments_origin_uq UNIQUE (business_id, origin_source_type, origin_source_id),
  CONSTRAINT negative_inventory_cost_adjustments_binding_identity_ck CHECK (binding_source_id IS NULL OR binding_source_id = id),
  CONSTRAINT negative_inventory_cost_adjustments_binding_owed_ck CHECK ((total_value_base_minor <> 0) = (binding_source_id IS NOT NULL)),
  CONSTRAINT negative_inventory_cost_adjustments_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT negative_inventory_cost_adjustments_warehouse_fk FOREIGN KEY (business_id, warehouse_id) REFERENCES warehouses (business_id, id),
  CONSTRAINT negative_inventory_cost_adjustments_origin_fk
    FOREIGN KEY (business_id, origin_source_id, warehouse_id) REFERENCES purchases (business_id, id, warehouse_id),
  CONSTRAINT negative_inventory_cost_adjustments_binding_fk
    FOREIGN KEY (business_id, accounting_source_type, binding_source_id)
    REFERENCES accounting_source_bindings (business_id, source_type, source_id)
    DEFERRABLE INITIALLY DEFERRED
);
REVOKE ALL ON negative_inventory_cost_adjustments FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The coverage and deficit additions (A-16(g)(h)). Both constraints
--    validate existing rows; nothing produced a coverage before S4.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE negative_deficit_coverages ADD CONSTRAINT negative_deficit_coverages_bridge_uq UNIQUE (business_id, adjustment_id, id);
ALTER TABLE negative_deficit_coverages ADD CONSTRAINT negative_deficit_coverages_deficit_uq UNIQUE (business_id, adjustment_id, deficit_id);
ALTER TABLE negative_deficit_coverages ADD CONSTRAINT negative_deficit_coverages_adjustment_fk
  FOREIGN KEY (business_id, adjustment_id) REFERENCES negative_inventory_cost_adjustments (business_id, id) ON DELETE RESTRICT;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. The two bridges (A-15(a)): exactly the L:1501-1519 template.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE stock_source_bridge_purchase (
  business_id    UUID NOT NULL,
  source_id      UUID NOT NULL,
  source_line_id UUID NOT NULL,
  movement_kind  TEXT NOT NULL,
  source_type    TEXT NOT NULL GENERATED ALWAYS AS ('purchase') STORED,
  PRIMARY KEY (business_id, source_id, source_line_id, movement_kind),
  CONSTRAINT stock_source_bridge_purchase_line_fk
    FOREIGN KEY (business_id, source_id, source_line_id)
    REFERENCES purchase_lines (business_id, purchase_id, id) ON DELETE RESTRICT,
  CONSTRAINT stock_source_bridge_purchase_binding_fk
    FOREIGN KEY (business_id, source_type, source_id, source_line_id, movement_kind)
    REFERENCES stock_source_bindings (business_id, source_type, source_id, source_line_id, movement_kind) ON DELETE RESTRICT
);
REVOKE ALL ON stock_source_bridge_purchase FROM PUBLIC;

CREATE TABLE stock_source_bridge_negative_inventory_cost_adjustment (
  business_id    UUID NOT NULL,
  source_id      UUID NOT NULL,
  source_line_id UUID NOT NULL,
  movement_kind  TEXT NOT NULL,
  source_type    TEXT NOT NULL GENERATED ALWAYS AS ('negative_inventory_cost_adjustment') STORED,
  PRIMARY KEY (business_id, source_id, source_line_id, movement_kind),
  -- R-21: the S3 naming would exceed 63 bytes here.
  CONSTRAINT stock_source_bridge_nica_line_fk
    FOREIGN KEY (business_id, source_id, source_line_id)
    REFERENCES negative_deficit_coverages (business_id, adjustment_id, id) ON DELETE RESTRICT,
  CONSTRAINT stock_source_bridge_nica_binding_fk
    FOREIGN KEY (business_id, source_type, source_id, source_line_id, movement_kind)
    REFERENCES stock_source_bindings (business_id, source_type, source_id, source_line_id, movement_kind) ON DELETE RESTRICT
);
REVOKE ALL ON stock_source_bridge_negative_inventory_cost_adjustment FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Row security and grants on the S4 tables (§2.6, A-18).
--
-- The stock_movements layering: a tenant policy through the businesses
-- subquery, a restrictive business isolation that ADMITS the internal
-- principals for reading only (USING, never WITH CHECK), and permissive
-- FOR SELECT admissions for the principals whose triggers judge these rows.
-- R-35: the restrictive isolation is one policy per command, so the
-- internal admission exists on SELECT only; INSERT, UPDATE and DELETE hold
-- every principal but app_bypass() to the row's own app.business_id.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers FORCE ROW LEVEL SECURITY;
ALTER TABLE purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchases FORCE ROW LEVEL SECURITY;
ALTER TABLE purchase_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE purchase_landed_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_landed_costs FORCE ROW LEVEL SECURITY;
ALTER TABLE purchase_landed_cost_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_landed_cost_allocations FORCE ROW LEVEL SECURITY;
ALTER TABLE negative_inventory_cost_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE negative_inventory_cost_adjustments FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_source_bridge_purchase ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_source_bridge_purchase FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_source_bridge_negative_inventory_cost_adjustment ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_source_bridge_negative_inventory_cost_adjustment FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_membership ON suppliers
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = suppliers.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = suppliers.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON suppliers AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON suppliers AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON suppliers AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON suppliers AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON suppliers
  FOR SELECT TO daftar_inventory_internal USING (true);

CREATE POLICY tenant_membership ON purchases
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = purchases.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = purchases.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON purchases AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal') OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON purchases AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON purchases AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON purchases AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON purchases
  FOR SELECT TO daftar_inventory_internal USING (true);
CREATE POLICY accounting_validator ON purchases
  FOR SELECT TO daftar_accounting_internal USING (true);

CREATE POLICY tenant_membership ON purchase_lines
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = purchase_lines.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = purchase_lines.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON purchase_lines AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON purchase_lines AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON purchase_lines AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON purchase_lines AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON purchase_lines
  FOR SELECT TO daftar_inventory_internal USING (true);

CREATE POLICY tenant_membership ON purchase_landed_costs
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = purchase_landed_costs.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = purchase_landed_costs.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON purchase_landed_costs AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON purchase_landed_costs AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON purchase_landed_costs AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON purchase_landed_costs AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON purchase_landed_costs
  FOR SELECT TO daftar_inventory_internal USING (true);

CREATE POLICY tenant_membership ON purchase_landed_cost_allocations
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = purchase_landed_cost_allocations.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = purchase_landed_cost_allocations.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON purchase_landed_cost_allocations AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON purchase_landed_cost_allocations AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON purchase_landed_cost_allocations AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON purchase_landed_cost_allocations AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON purchase_landed_cost_allocations
  FOR SELECT TO daftar_inventory_internal USING (true);

CREATE POLICY tenant_membership ON negative_inventory_cost_adjustments
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = negative_inventory_cost_adjustments.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = negative_inventory_cost_adjustments.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON negative_inventory_cost_adjustments AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal') OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON negative_inventory_cost_adjustments AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON negative_inventory_cost_adjustments AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON negative_inventory_cost_adjustments AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON negative_inventory_cost_adjustments
  FOR SELECT TO daftar_inventory_internal USING (true);
CREATE POLICY accounting_validator ON negative_inventory_cost_adjustments
  FOR SELECT TO daftar_accounting_internal USING (true);

CREATE POLICY tenant_membership ON stock_source_bridge_purchase
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = stock_source_bridge_purchase.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = stock_source_bridge_purchase.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON stock_source_bridge_purchase AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON stock_source_bridge_purchase AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON stock_source_bridge_purchase AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON stock_source_bridge_purchase AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON stock_source_bridge_purchase
  FOR SELECT TO daftar_inventory_internal USING (true);

CREATE POLICY tenant_membership ON stock_source_bridge_negative_inventory_cost_adjustment
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b
                                WHERE b.id = stock_source_bridge_negative_inventory_cost_adjustment.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b
                                WHERE b.id = stock_source_bridge_negative_inventory_cost_adjustment.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON stock_source_bridge_negative_inventory_cost_adjustment AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON stock_source_bridge_negative_inventory_cost_adjustment AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON stock_source_bridge_negative_inventory_cost_adjustment AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON stock_source_bridge_negative_inventory_cost_adjustment AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON stock_source_bridge_negative_inventory_cost_adjustment
  FOR SELECT TO daftar_inventory_internal USING (true);

-- A-18. daftar_app reads the six documents and the two S2 coverage tables
-- (the A-07 bound read and the replay/read models) and holds no DML.
GRANT SELECT ON suppliers, purchases, purchase_lines, purchase_landed_costs, purchase_landed_cost_allocations,
                negative_inventory_cost_adjustments, negative_inventory_deficits, negative_deficit_coverages
  TO daftar_app;

GRANT SELECT, INSERT ON suppliers, purchases, purchase_lines, purchase_landed_costs, purchase_landed_cost_allocations,
                        negative_inventory_cost_adjustments, stock_source_bridge_purchase,
                        stock_source_bridge_negative_inventory_cost_adjustment, negative_deficit_coverages
  TO daftar_inventory_internal;
-- The draft replace only (every delete is refused by the freeze triggers
-- unless the parent is a draft).
GRANT DELETE ON purchase_lines, purchase_landed_costs, purchase_landed_cost_allocations TO daftar_inventory_internal;
GRANT UPDATE (name, phone, email, tax_identifier, notes, status, revision, last_intent_sha256, business_transaction_id, updated_by, updated_at)
  ON suppliers TO daftar_inventory_internal;
GRANT UPDATE (supplier_id, warehouse_id, currency_code, document_date, supplier_reference, notes, revision, draft_intent_sha256,
              subtotal_txn_minor, landed_cost_txn_minor, tax_minor, total_txn_minor, business_transaction_id, updated_at,
              status, receive_intent_sha256, cancel_intent_sha256, source_to_base_rate, rate_source, rate_timestamp, fx_rate_id,
              total_base_minor, supplier_name_snapshot, supplier_tax_identifier_snapshot, supplier_phone_snapshot,
              received_by, received_at, cancelled_by, cancelled_at, binding_source_id)
  ON purchases TO daftar_inventory_internal;
GRANT UPDATE (base_share_minor, unit_cost_base_minor) ON purchase_lines TO daftar_inventory_internal;
GRANT UPDATE (uncovered_qty, status) ON negative_inventory_deficits TO daftar_inventory_internal;
GRANT SELECT ON currencies TO daftar_inventory_internal;

-- A-14(d): the accounting principal reads the two posting headers.
GRANT SELECT ON purchases, negative_inventory_cost_adjustments TO daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Stock-side guard functions and triggers (A-15(b)-(h), A-16(g)).
--    Created while the migrator owns them; PUBLIC revoked and triggers
--    installed; then handed to the internal principal inside the CREATE
--    bracket (the S2/S3 order).
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;

-- (b) Binding → bridge, at COMMIT, one function per source type.
CREATE OR REPLACE FUNCTION stock_binding_requires_purchase() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM stock_source_bridge_purchase b
                  WHERE b.business_id = NEW.business_id AND b.source_id = NEW.source_id
                    AND b.source_line_id = NEW.source_line_id AND b.movement_kind = NEW.movement_kind) THEN
    RAISE EXCEPTION 'inventory.stock_source_line_missing: a purchase stock binding has no source line' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION stock_binding_requires_negative_inventory_cost_adjustment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM stock_source_bridge_negative_inventory_cost_adjustment b
                  WHERE b.business_id = NEW.business_id AND b.source_id = NEW.source_id
                    AND b.source_line_id = NEW.source_line_id AND b.movement_kind = NEW.movement_kind) THEN
    RAISE EXCEPTION 'inventory.stock_source_line_missing: a deficit-coverage stock binding has no source line' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- (d) Line → required movement set, at COMMIT. A line of a RECEIVED
--     purchase carries exactly its one purchase movement, found THROUGH the
--     bridge; any other line carries none. The line is re-read: a deferred
--     check judges the row as it is at COMMIT (a draft replace may have
--     deleted it since).
CREATE OR REPLACE FUNCTION stock_source_complete_purchase() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_line   RECORD;
  v_status TEXT;
  v_wh     UUID;
  v_all    INTEGER;
  v_ok     INTEGER;
BEGIN
  SELECT l.purchase_id, l.variant_id, l.qty, l.base_share_minor, l.unit_cost_base_minor INTO v_line
  FROM purchase_lines l WHERE l.business_id = NEW.business_id AND l.id = NEW.id;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM stock_source_bridge_purchase b
                WHERE b.business_id = NEW.business_id AND b.source_id = NEW.purchase_id AND b.source_line_id = NEW.id) THEN
      RAISE EXCEPTION 'inventory.source_movement_set_incomplete: a removed purchase line carries a movement' USING ERRCODE = 'P0001';
    END IF;
    RETURN NULL;
  END IF;
  SELECT p.status, p.warehouse_id INTO v_status, v_wh
  FROM purchases p WHERE p.business_id = NEW.business_id AND p.id = v_line.purchase_id;
  SELECT count(*),
         count(*) FILTER (WHERE m.movement_kind = 'purchase' AND m.warehouse_id = v_wh AND m.variant_id = v_line.variant_id
                            AND m.qty_delta = v_line.qty AND m.value_delta_base_minor = v_line.base_share_minor
                            AND m.unit_cost_base_minor = v_line.unit_cost_base_minor)
    INTO v_all, v_ok
  FROM stock_source_bridge_purchase b
  JOIN stock_movements m ON m.business_id = b.business_id AND m.source_type = b.source_type AND m.source_id = b.source_id
                        AND m.source_line_id = b.source_line_id AND m.movement_kind = b.movement_kind
  WHERE b.business_id = NEW.business_id AND b.source_id = v_line.purchase_id AND b.source_line_id = NEW.id;
  IF v_status = 'received' THEN
    IF v_all <> 1 OR v_ok <> 1 THEN
      RAISE EXCEPTION 'inventory.source_movement_set_incomplete: a received purchase line needs exactly its one purchase movement' USING ERRCODE = 'P0001';
    END IF;
  ELSIF v_status IS DISTINCT FROM 'draft' THEN
    -- R-34: a line written in a transaction that leaves its purchase
    -- cancelled (or without a purchase) is never accepted.
    RAISE EXCEPTION 'inventory.source_line_frozen: a line is never written to a cancelled purchase' USING ERRCODE = 'P0001';
  ELSIF v_all <> 0 THEN
    RAISE EXCEPTION 'inventory.source_movement_set_incomplete: a purchase line that is not received carries no movement' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- The header twin: a purchase that became received re-checks EVERY line, so
-- a receipt that touched no line cannot escape the line check.
CREATE OR REPLACE FUNCTION stock_source_complete_purchase_header() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_status TEXT;
  v_wh     UUID;
  v_lines  INTEGER;
  v_bad    INTEGER;
BEGIN
  SELECT p.status, p.warehouse_id INTO v_status, v_wh FROM purchases p WHERE p.business_id = NEW.business_id AND p.id = NEW.id;
  SELECT count(*),
         count(*) FILTER (WHERE
           CASE WHEN v_status = 'received' THEN
                  (SELECT count(*) FROM stock_source_bridge_purchase b
                    WHERE b.business_id = l.business_id AND b.source_id = l.purchase_id AND b.source_line_id = l.id) <> 1
                  OR NOT EXISTS (SELECT 1 FROM stock_source_bridge_purchase b
                                   JOIN stock_movements m ON m.business_id = b.business_id AND m.source_type = b.source_type
                                                         AND m.source_id = b.source_id AND m.source_line_id = b.source_line_id
                                                         AND m.movement_kind = b.movement_kind
                                  WHERE b.business_id = l.business_id AND b.source_id = l.purchase_id AND b.source_line_id = l.id
                                    AND m.movement_kind = 'purchase' AND m.warehouse_id = v_wh AND m.variant_id = l.variant_id
                                    AND m.qty_delta = l.qty AND m.value_delta_base_minor = l.base_share_minor
                                    AND m.unit_cost_base_minor = l.unit_cost_base_minor)
                ELSE EXISTS (SELECT 1 FROM stock_source_bridge_purchase b
                              WHERE b.business_id = l.business_id AND b.source_id = l.purchase_id AND b.source_line_id = l.id)
           END)
    INTO v_lines, v_bad
  FROM purchase_lines l
  WHERE l.business_id = NEW.business_id AND l.purchase_id = NEW.id;
  IF v_bad <> 0 OR (v_status = 'received' AND v_lines = 0) THEN
    RAISE EXCEPTION 'inventory.source_movement_set_incomplete: a purchase does not carry exactly its required movements' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- A coverage owns exactly one value-only movement iff its catch-up value is
-- non-zero (TL-5), for the formula value; the one flush-eligible coverage of
-- a line (TL-6, R-16) may carry any value, which the deferred zero-stock
-- check of 0060 pins physically.
CREATE OR REPLACE FUNCTION stock_source_complete_negative_inventory_cost_adjustment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_wh      UUID;
  v_origin  UUID;
  v_all     INTEGER;
  v_ok      INTEGER;
  v_val     BIGINT;
  v_value   NUMERIC;
  v_seq     BIGINT;
  v_last    BOOLEAN;
  v_qty     NUMERIC;
  v_covered NUMERIC;
  v_scoped  BOOLEAN;
  v_flush   BOOLEAN;
BEGIN
  SELECT a.warehouse_id, a.origin_source_id INTO v_wh, v_origin
  FROM negative_inventory_cost_adjustments a WHERE a.business_id = NEW.business_id AND a.id = NEW.adjustment_id;
  -- R-36: the covering line is (origin, variant); a coverage without one is
  -- not a coverage of its receipt.
  SELECT l.qty INTO v_qty FROM purchase_lines l
   WHERE l.business_id = NEW.business_id AND l.purchase_id = v_origin AND l.variant_id = NEW.variant_id;
  IF v_qty IS NULL THEN
    RAISE EXCEPTION 'inventory.source_line_missing: a coverage covers only a variant its origin purchase receives' USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*),
         count(*) FILTER (WHERE m.movement_kind = 'negative_inventory_cost_adjustment' AND m.warehouse_id = v_wh
                            AND m.variant_id = NEW.variant_id AND m.qty_delta = 0),
         min(m.value_delta_base_minor)
    INTO v_all, v_ok, v_val
  FROM stock_source_bridge_negative_inventory_cost_adjustment b
  JOIN stock_movements m ON m.business_id = b.business_id AND m.source_type = b.source_type AND m.source_id = b.source_id
                        AND m.source_line_id = b.source_line_id AND m.movement_kind = b.movement_kind
  WHERE b.business_id = NEW.business_id AND b.source_id = NEW.adjustment_id AND b.source_line_id = NEW.id;

  v_value := -inventory_half_even(NEW.qty_covered * (NEW.actual_unit_cost_base_minor - NEW.provisional_unit_cost_base_minor), 1, 0);

  SELECT d.deficit_seq INTO v_seq FROM negative_inventory_deficits d WHERE d.business_id = NEW.business_id AND d.id = NEW.deficit_id;
  v_last := NOT EXISTS (
    SELECT 1 FROM negative_deficit_coverages c
      JOIN negative_inventory_deficits d ON d.business_id = c.business_id AND d.id = c.deficit_id
     WHERE c.business_id = NEW.business_id AND c.adjustment_id = NEW.adjustment_id AND c.variant_id = NEW.variant_id
       AND (d.deficit_seq, d.id) > (v_seq, NEW.deficit_id));
  SELECT sum(c.qty_covered) INTO v_covered FROM negative_deficit_coverages c
   WHERE c.business_id = NEW.business_id AND c.adjustment_id = NEW.adjustment_id AND c.variant_id = NEW.variant_id;
  -- R-37: the deficit and coverage reads above are scoped by the session
  -- GUCs (0059 RLS). Unless both name this coverage's own tenant and
  -- business at COMMIT, they may have seen nothing, so nothing is exempt.
  v_scoped := nullif(current_setting('app.tenant_id', true), '')::uuid IS NOT DISTINCT FROM NEW.tenant_id
              AND nullif(current_setting('app.business_id', true), '')::uuid IS NOT DISTINCT FROM NEW.business_id;
  v_flush := v_scoped AND v_seq IS NOT NULL AND v_last AND v_qty = v_covered
             AND NOT EXISTS (SELECT 1 FROM negative_inventory_deficits d
                              WHERE d.business_id = NEW.business_id AND d.warehouse_id = v_wh AND d.variant_id = NEW.variant_id
                                AND d.status <> 'closed');

  IF v_flush THEN
    IF v_all > 1 OR v_all <> v_ok THEN
      RAISE EXCEPTION 'inventory.source_movement_set_incomplete: the flush coverage carries at most its one value-only movement' USING ERRCODE = 'P0001';
    END IF;
  ELSIF v_value <> 0 THEN
    IF v_all <> 1 OR v_ok <> 1 OR v_val::numeric <> v_value THEN
      RAISE EXCEPTION 'inventory.source_movement_set_incomplete: a coverage needs exactly its one catch-up movement for its value' USING ERRCODE = 'P0001';
    END IF;
  ELSIF v_all <> 0 THEN
    RAISE EXCEPTION 'inventory.source_movement_set_incomplete: a coverage with a zero catch-up carries no movement' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- (e) Freeze. A purchase line changes only while its purchase is a draft:
--     inserted or deleted by a replace, or given its base share and unit
--     cost once, by the receipt (which updates the lines BEFORE the header).
--     R-34: the INSERT is judged too.
CREATE OR REPLACE FUNCTION stock_source_freeze_purchase() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT p.status INTO v_status FROM purchases p WHERE p.business_id = NEW.business_id AND p.id = NEW.purchase_id;
    IF v_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'inventory.source_line_frozen: a line is added only to a draft purchase, by its replace' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.base_share_minor IS NOT NULL OR NEW.unit_cost_base_minor IS NOT NULL THEN
      RAISE EXCEPTION 'inventory.source_line_frozen: a draft line carries no receipt amounts until its receipt' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  SELECT p.status INTO v_status FROM purchases p WHERE p.business_id = OLD.business_id AND p.id = OLD.purchase_id;
  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'inventory.source_line_frozen: the lines of a received or cancelled purchase are final' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF OLD.base_share_minor IS NOT NULL OR OLD.unit_cost_base_minor IS NOT NULL
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.purchase_id IS DISTINCT FROM OLD.purchase_id OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.line_no IS DISTINCT FROM OLD.line_no OR NEW.variant_id IS DISTINCT FROM OLD.variant_id
     OR NEW.qty IS DISTINCT FROM OLD.qty OR NEW.unit_price_txn_minor IS DISTINCT FROM OLD.unit_price_txn_minor
     OR NEW.gross_txn_minor IS DISTINCT FROM OLD.gross_txn_minor OR NEW.discount_txn_minor IS DISTINCT FROM OLD.discount_txn_minor
     OR NEW.net_txn_minor IS DISTINCT FROM OLD.net_txn_minor OR NEW.landed_cost_txn_minor IS DISTINCT FROM OLD.landed_cost_txn_minor THEN
    RAISE EXCEPTION 'inventory.source_line_frozen: a draft purchase line changes only by a replace, or once by its receipt' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- Landed costs and their allocations: inserted and deleted by a draft
-- replace (R-34), never updated.
CREATE OR REPLACE FUNCTION purchase_landed_cost_freeze() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT p.status INTO v_status FROM purchases p WHERE p.business_id = NEW.business_id AND p.id = NEW.purchase_id;
    IF v_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'inventory.source_line_frozen: a landed cost or allocation is added only to a draft purchase, by its replace' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  SELECT p.status INTO v_status FROM purchases p WHERE p.business_id = OLD.business_id AND p.id = OLD.purchase_id;
  IF TG_OP <> 'DELETE' OR v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'inventory.source_line_frozen: a landed cost or allocation is replaced with its draft, never changed' USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$$;

-- Header immutability: born a draft at revision 1 (R-39); draft → draft
-- (revision + 1), draft → received, draft → cancelled; never a delete; a
-- received or cancelled purchase allows nothing.
CREATE OR REPLACE FUNCTION purchase_header_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'draft' OR NEW.revision IS DISTINCT FROM 1
       OR NEW.receive_intent_sha256 IS NOT NULL OR NEW.cancel_intent_sha256 IS NOT NULL
       OR NEW.source_to_base_rate IS NOT NULL OR NEW.rate_source IS NOT NULL OR NEW.rate_timestamp IS NOT NULL
       OR NEW.fx_rate_id IS NOT NULL OR NEW.total_base_minor IS NOT NULL
       OR NEW.supplier_name_snapshot IS NOT NULL OR NEW.supplier_tax_identifier_snapshot IS NOT NULL
       OR NEW.supplier_phone_snapshot IS NOT NULL OR NEW.received_by IS NOT NULL OR NEW.received_at IS NOT NULL
       OR NEW.cancelled_by IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.binding_source_id IS NOT NULL THEN
      RAISE EXCEPTION 'inventory.source_document_immutable: a purchase is created only as a draft at revision 1' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory.source_document_immutable: a purchase is never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'inventory.source_document_immutable: a % purchase is final', OLD.status USING ERRCODE = 'P0001';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'inventory.source_document_immutable: the identity of a purchase is final' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'draft' THEN
    IF NEW.revision IS DISTINCT FROM OLD.revision + 1 THEN
      RAISE EXCEPTION 'inventory.source_document_immutable: a draft is replaced one revision at a time' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id OR NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id
     OR NEW.currency_code IS DISTINCT FROM OLD.currency_code OR NEW.document_date IS DISTINCT FROM OLD.document_date
     OR NEW.supplier_reference IS DISTINCT FROM OLD.supplier_reference OR NEW.notes IS DISTINCT FROM OLD.notes
     OR NEW.draft_intent_sha256 IS DISTINCT FROM OLD.draft_intent_sha256
     OR NEW.subtotal_txn_minor IS DISTINCT FROM OLD.subtotal_txn_minor
     OR NEW.landed_cost_txn_minor IS DISTINCT FROM OLD.landed_cost_txn_minor
     OR NEW.tax_minor IS DISTINCT FROM OLD.tax_minor OR NEW.total_txn_minor IS DISTINCT FROM OLD.total_txn_minor THEN
    RAISE EXCEPTION 'inventory.source_document_immutable: receiving or cancelling a draft changes its closing fields only' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- (f) Header value completeness, at COMMIT: a received purchase's bridged
--     movement values sum to its base total and to its lines' shares; a
--     coverage header's total is the sum of its bridged movement values,
--     judged on the header's INSERT and on every coverage INSERT (R-36).
CREATE OR REPLACE FUNCTION purchase_source_value_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_status TEXT;
  v_total  BIGINT;
  v_sum    NUMERIC;
  v_shares NUMERIC;
  v_nulls  INTEGER;
  v_n      INTEGER;
  v_header UUID;
BEGIN
  IF TG_TABLE_NAME = 'purchases' THEN
    SELECT p.status, p.total_base_minor INTO v_status, v_total FROM purchases p WHERE p.business_id = NEW.business_id AND p.id = NEW.id;
    SELECT count(*), coalesce(sum(m.value_delta_base_minor), 0) INTO v_n, v_sum
    FROM stock_source_bridge_purchase b
    JOIN stock_movements m ON m.business_id = b.business_id AND m.source_type = b.source_type AND m.source_id = b.source_id
                          AND m.source_line_id = b.source_line_id AND m.movement_kind = b.movement_kind
    WHERE b.business_id = NEW.business_id AND b.source_id = NEW.id;
    SELECT sum(l.base_share_minor), count(*) FILTER (WHERE l.base_share_minor IS NULL) INTO v_shares, v_nulls
    FROM purchase_lines l WHERE l.business_id = NEW.business_id AND l.purchase_id = NEW.id;
    IF v_status = 'received' THEN
      IF v_total IS NULL OR v_sum <> v_total::numeric OR v_shares IS DISTINCT FROM v_total::numeric OR v_nulls <> 0 THEN
        RAISE EXCEPTION 'inventory.source_value_mismatch: a received purchase total is not the sum of its line shares and movement values' USING ERRCODE = 'P0001';
      END IF;
    ELSIF v_n <> 0 THEN
      RAISE EXCEPTION 'inventory.source_value_mismatch: a purchase that is not received carries no movement value' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    IF TG_TABLE_NAME = 'negative_deficit_coverages' THEN
      v_header := NEW.adjustment_id;
    ELSE
      v_header := NEW.id;
    END IF;
    SELECT a.total_value_base_minor INTO v_total FROM negative_inventory_cost_adjustments a WHERE a.business_id = NEW.business_id AND a.id = v_header;
    SELECT coalesce(sum(m.value_delta_base_minor), 0) INTO v_sum
    FROM stock_source_bridge_negative_inventory_cost_adjustment b
    JOIN stock_movements m ON m.business_id = b.business_id AND m.source_type = b.source_type AND m.source_id = b.source_id
                          AND m.source_line_id = b.source_line_id AND m.movement_kind = b.movement_kind
    WHERE b.business_id = NEW.business_id AND b.source_id = v_header;
    IF v_sum IS DISTINCT FROM v_total::numeric THEN
      RAISE EXCEPTION 'inventory.source_value_mismatch: a coverage header total is not the sum of its movement values' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

-- (g) Supplier guards: no delete, ever; identity and creation are final and
--     every change is exactly one revision (R-23).
CREATE OR REPLACE FUNCTION suppliers_no_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'supplier.not_deletable: a supplier is archived, never deleted' USING ERRCODE = 'P0001';
END;
$$;

CREATE OR REPLACE FUNCTION suppliers_revision_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.create_intent_sha256 IS DISTINCT FROM OLD.create_intent_sha256
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'supplier.state_invalid: the identity of a supplier is final' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.revision IS DISTINCT FROM OLD.revision + 1 THEN
    RAISE EXCEPTION 'supplier.revision_changed: a supplier changes one revision at a time' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- (h) Allocation consistency (P:212 as a database fact), at COMMIT, over the
--     whole purchase of the inserted allocation or landed cost (R-34); never
--     for a purchase the transaction leaves cancelled.
CREATE OR REPLACE FUNCTION purchase_allocations_consistent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_p     RECORD;
  v_lines INTEGER;
BEGIN
  SELECT p.status, p.subtotal_txn_minor, p.landed_cost_txn_minor, p.tax_minor, p.total_txn_minor INTO v_p
  FROM purchases p WHERE p.business_id = NEW.business_id AND p.id = NEW.purchase_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_p.status = 'cancelled' THEN
    RAISE EXCEPTION 'inventory.source_line_frozen: a landed cost or allocation is never written to a cancelled purchase' USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*) INTO v_lines FROM purchase_lines l WHERE l.business_id = NEW.business_id AND l.purchase_id = NEW.purchase_id;
  IF EXISTS (SELECT 1 FROM purchase_landed_costs c
              WHERE c.business_id = NEW.business_id AND c.purchase_id = NEW.purchase_id
                AND ((SELECT coalesce(sum(a.amount_txn_minor), 0) FROM purchase_landed_cost_allocations a
                       WHERE a.business_id = c.business_id AND a.landed_cost_id = c.id) <> c.amount_txn_minor
                  OR (SELECT count(*) FROM purchase_landed_cost_allocations a
                       WHERE a.business_id = c.business_id AND a.landed_cost_id = c.id) <> v_lines))
     OR EXISTS (SELECT 1 FROM purchase_lines l
                 WHERE l.business_id = NEW.business_id AND l.purchase_id = NEW.purchase_id
                   AND l.landed_cost_txn_minor <> (SELECT coalesce(sum(a.amount_txn_minor), 0) FROM purchase_landed_cost_allocations a
                                                    WHERE a.business_id = l.business_id AND a.purchase_id = l.purchase_id
                                                      AND a.purchase_line_id = l.id))
     OR v_p.landed_cost_txn_minor <> (SELECT coalesce(sum(c.amount_txn_minor), 0) FROM purchase_landed_costs c
                                       WHERE c.business_id = NEW.business_id AND c.purchase_id = NEW.purchase_id)
     OR v_p.subtotal_txn_minor <> (SELECT coalesce(sum(l.net_txn_minor), 0) FROM purchase_lines l
                                    WHERE l.business_id = NEW.business_id AND l.purchase_id = NEW.purchase_id)
     OR v_p.total_txn_minor <> v_p.subtotal_txn_minor + v_p.landed_cost_txn_minor + v_p.tax_minor THEN
    RAISE EXCEPTION 'purchase.landed_cost_allocation_mismatch: the landed-cost allocations do not add up to their costs and lines' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- A-16(g): a deficit changes only by coverage — its uncovered quantity
-- decreases and its status follows — and the decrease is exactly what its
-- coverages record, at COMMIT. INSERT stays unguarded (the owner seeds
-- deficits in tests, L:470).
CREATE OR REPLACE FUNCTION negative_inventory_deficits_coverage_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory.deficit_immutable: a negative-inventory deficit is never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id
     OR NEW.variant_id IS DISTINCT FROM OLD.variant_id OR NEW.source_stock_movement_id IS DISTINCT FROM OLD.source_stock_movement_id
     OR NEW.deficit_seq IS DISTINCT FROM OLD.deficit_seq OR NEW.original_deficit_qty IS DISTINCT FROM OLD.original_deficit_qty
     OR NEW.provisional_unit_cost_base_minor IS DISTINCT FROM OLD.provisional_unit_cost_base_minor
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.uncovered_qty > OLD.uncovered_qty THEN
    RAISE EXCEPTION 'inventory.deficit_immutable: a deficit changes only by coverage, its uncovered quantity decreasing' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION negative_inventory_deficits_coverage_consistent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_original  NUMERIC;
  v_uncovered NUMERIC;
  v_covered   NUMERIC;
BEGIN
  SELECT d.original_deficit_qty, d.uncovered_qty INTO v_original, v_uncovered
  FROM negative_inventory_deficits d WHERE d.business_id = NEW.business_id AND d.id = NEW.id;
  SELECT coalesce(sum(c.qty_covered), 0) INTO v_covered
  FROM negative_deficit_coverages c WHERE c.business_id = NEW.business_id AND c.deficit_id = NEW.id;
  IF v_original - v_uncovered IS DISTINCT FROM v_covered THEN
    RAISE EXCEPTION 'inventory.deficit_coverage_mismatch: a deficit''s covered quantity is not the sum of its coverages' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- R-36: a coverage joins only a header created by this very transaction:
-- the insert-only header's created_at is this transaction's now() and its
-- business_transaction_id this transaction's trace. A coverage naming no
-- header at all is left to the immediate FK (after the S2 CHECKs).
CREATE OR REPLACE FUNCTION negative_deficit_coverage_same_transaction() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_created TIMESTAMPTZ;
  v_trace   UUID;
BEGIN
  SELECT a.created_at, a.business_transaction_id INTO v_created, v_trace
  FROM negative_inventory_cost_adjustments a WHERE a.business_id = NEW.business_id AND a.id = NEW.adjustment_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF v_created IS DISTINCT FROM now() OR v_trace IS DISTINCT FROM inventory_business_transaction_id() THEN
    RAISE EXCEPTION 'inventory.source_document_immutable: a coverage is added to its header only by the transaction that created it' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION stock_binding_requires_purchase() FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_binding_requires_negative_inventory_cost_adjustment() FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_source_complete_purchase() FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_source_complete_purchase_header() FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_source_complete_negative_inventory_cost_adjustment() FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_source_freeze_purchase() FROM PUBLIC;
REVOKE ALL ON FUNCTION purchase_landed_cost_freeze() FROM PUBLIC;
REVOKE ALL ON FUNCTION purchase_header_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION purchase_source_value_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION suppliers_no_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION suppliers_revision_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION purchase_allocations_consistent() FROM PUBLIC;
REVOKE ALL ON FUNCTION negative_inventory_deficits_coverage_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION negative_inventory_deficits_coverage_consistent() FROM PUBLIC;
REVOKE ALL ON FUNCTION negative_deficit_coverage_same_transaction() FROM PUBLIC;

-- ── The stock-side triggers (§2.3, A-15, A-16(g)) ───────────────────────
CREATE CONSTRAINT TRIGGER stock_binding_requires_purchase
  AFTER INSERT ON stock_source_bindings DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source_type = 'purchase')
  EXECUTE FUNCTION stock_binding_requires_purchase();
CREATE CONSTRAINT TRIGGER stock_binding_requires_negative_inventory_cost_adjustment
  AFTER INSERT ON stock_source_bindings DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source_type = 'negative_inventory_cost_adjustment')
  EXECUTE FUNCTION stock_binding_requires_negative_inventory_cost_adjustment();

CREATE TRIGGER stock_bridge_immutable_purchase
  BEFORE UPDATE OR DELETE ON stock_source_bridge_purchase
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_append_only();
CREATE TRIGGER stock_bridge_immutable_negative_inventory_cost_adjustment
  BEFORE UPDATE OR DELETE ON stock_source_bridge_negative_inventory_cost_adjustment
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_append_only();

CREATE CONSTRAINT TRIGGER stock_source_complete_purchase
  AFTER INSERT OR UPDATE ON purchase_lines DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION stock_source_complete_purchase();
CREATE CONSTRAINT TRIGGER purchases_received_complete
  AFTER UPDATE ON purchases DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION stock_source_complete_purchase_header();
CREATE CONSTRAINT TRIGGER stock_source_complete_negative_inventory_cost_adjustment
  AFTER INSERT ON negative_deficit_coverages DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION stock_source_complete_negative_inventory_cost_adjustment();

-- R-34: the three freeze triggers judge INSERT too (tgtype 31).
CREATE TRIGGER stock_source_freeze_purchase
  BEFORE INSERT OR UPDATE OR DELETE ON purchase_lines
  FOR EACH ROW EXECUTE FUNCTION stock_source_freeze_purchase();
CREATE TRIGGER purchase_landed_costs_freeze
  BEFORE INSERT OR UPDATE OR DELETE ON purchase_landed_costs
  FOR EACH ROW EXECUTE FUNCTION purchase_landed_cost_freeze();
CREATE TRIGGER purchase_landed_cost_allocations_freeze
  BEFORE INSERT OR UPDATE OR DELETE ON purchase_landed_cost_allocations
  FOR EACH ROW EXECUTE FUNCTION purchase_landed_cost_freeze();
-- R-39: the header guard judges INSERT too (tgtype 31).
CREATE TRIGGER purchases_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON purchases
  FOR EACH ROW EXECUTE FUNCTION purchase_header_guard();
CREATE TRIGGER negative_inventory_cost_adjustments_immutable
  BEFORE UPDATE OR DELETE ON negative_inventory_cost_adjustments
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_append_only();

CREATE CONSTRAINT TRIGGER purchases_value_complete
  AFTER UPDATE ON purchases DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION purchase_source_value_complete();
CREATE CONSTRAINT TRIGGER negative_inventory_cost_adjustments_value_complete
  AFTER INSERT ON negative_inventory_cost_adjustments DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION purchase_source_value_complete();
-- R-36: the header's Σ is re-judged for every coverage written to it, and a
-- coverage joins only a header of its own transaction.
CREATE CONSTRAINT TRIGGER negative_deficit_coverages_value_complete
  AFTER INSERT ON negative_deficit_coverages DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION purchase_source_value_complete();
CREATE TRIGGER negative_deficit_coverages_same_transaction
  BEFORE INSERT ON negative_deficit_coverages
  FOR EACH ROW EXECUTE FUNCTION negative_deficit_coverage_same_transaction();

CREATE TRIGGER suppliers_no_delete
  BEFORE DELETE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION suppliers_no_delete();
CREATE TRIGGER suppliers_revision_guard
  BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION suppliers_revision_guard();

CREATE CONSTRAINT TRIGGER purchase_allocations_consistent
  AFTER INSERT ON purchase_landed_cost_allocations DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION purchase_allocations_consistent();
-- R-34: a landed cost written without its allocations cannot commit.
CREATE CONSTRAINT TRIGGER purchase_landed_costs_consistent
  AFTER INSERT ON purchase_landed_costs DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION purchase_allocations_consistent();

CREATE TRIGGER negative_inventory_deficits_coverage_guard
  BEFORE UPDATE OR DELETE ON negative_inventory_deficits
  FOR EACH ROW EXECUTE FUNCTION negative_inventory_deficits_coverage_guard();
CREATE CONSTRAINT TRIGGER negative_inventory_deficits_coverage_consistent
  AFTER UPDATE ON negative_inventory_deficits DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION negative_inventory_deficits_coverage_consistent();

-- The ownership transfer (after the ACL and the triggers).
ALTER FUNCTION stock_binding_requires_purchase() OWNER TO daftar_inventory_internal;
ALTER FUNCTION stock_binding_requires_negative_inventory_cost_adjustment() OWNER TO daftar_inventory_internal;
ALTER FUNCTION stock_source_complete_purchase() OWNER TO daftar_inventory_internal;
ALTER FUNCTION stock_source_complete_purchase_header() OWNER TO daftar_inventory_internal;
ALTER FUNCTION stock_source_complete_negative_inventory_cost_adjustment() OWNER TO daftar_inventory_internal;
ALTER FUNCTION stock_source_freeze_purchase() OWNER TO daftar_inventory_internal;
ALTER FUNCTION purchase_landed_cost_freeze() OWNER TO daftar_inventory_internal;
ALTER FUNCTION purchase_header_guard() OWNER TO daftar_inventory_internal;
ALTER FUNCTION purchase_source_value_complete() OWNER TO daftar_inventory_internal;
ALTER FUNCTION suppliers_no_delete() OWNER TO daftar_inventory_internal;
ALTER FUNCTION suppliers_revision_guard() OWNER TO daftar_inventory_internal;
ALTER FUNCTION purchase_allocations_consistent() OWNER TO daftar_inventory_internal;
ALTER FUNCTION negative_inventory_deficits_coverage_guard() OWNER TO daftar_inventory_internal;
ALTER FUNCTION negative_inventory_deficits_coverage_consistent() OWNER TO daftar_inventory_internal;
ALTER FUNCTION negative_deficit_coverage_same_transaction() OWNER TO daftar_inventory_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;

-- 6. The replaced source-guard discovery (§2.3, R-20), BEFORE the two S4
--    source types are registered.
--
-- Everything 0061 checks is kept: every S3 statement, the S3 line-table
-- rows, the S3 per-type set and all sixteen recorded S3 digests, verbatim.
-- The S4 types get the exact S3 treatment of the bridge line FK, the bridge
-- immutability trigger and the binding trigger (`NOT (v_s3 OR v_s4)`), and
-- their own per-type set (§2.3's table) checked the same way; two of its
-- guards run on the migrator-owned INVOKER `stock_ledger_append_only()`,
-- whose rows require an invoker function with the recorded body. Every S4
-- guard function's body is recorded as the SHA-256 of its prosrc.
-- R-38: the purchase set also covers the landed-cost freeze and
-- consistency guards, the coverage set the same-transaction and coverage
-- value guards and the two A-16(g) deficit guards; the three freeze
-- triggers and the header guard are tgtype 31 (R-34, R-39).
--
-- The 0061 description of the S3 strengthening follows unchanged:
--
--
-- The S2 body checked NAMES: a trigger of the right name on the wrong event,
-- with the wrong function, or enabled only for replica sessions ('R') passed.
-- This body checks the SHAPE of every guard. Same owner (the migrator), same
-- signature, still SECURITY INVOKER, STABLE and pinned; strictly stronger.
--
-- For the four P3-S3 types it also checks (review F3) the rest of each
-- type's §2.3 set — line completeness, line freeze, header immutability,
-- header value completeness and the stocktake header twin — by table, name,
-- event, column list, WHEN, deferral, enabled state and function; the
-- bridge's line FK against the exact line table and key columns; and every
-- guard function's BODY: the SHA-256 of `pg_proc.prosrc` must equal the
-- digest recorded below at migration time, so a same-oid, same-owner
-- CREATE OR REPLACE that neuters a body is reported. The record is of THIS
-- file's bodies: a digest that drifted from them fails 0061's own end state.
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
  v_line_tbl REGCLASS;
  v_line_key TEXT[];
  v_g        RECORD;
  -- SHA-256 (hex) of each S3 guard function's prosrc, recorded at migration time
  -- (0061), then of each S4 guard function's prosrc (0063).
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
    "stock_source_complete_negative_inventory_cost_adjustment()": "5d7ecf37ab953d1409412aa8ce4f8896e9ae566272e5076f408bdbbc18b25c68",
    "stock_source_freeze_purchase()": "97adaaaa95a5b2c18e80d34ea26a4eee5e397e1bf25dd727ddfc9a0cf86f31ab",
    "purchase_header_guard()": "09da86dc079e39ef7a60f1625c364b6e4644aad9b795b87245cc6d6749a3db4c",
    "purchase_source_value_complete()": "033535f199feae9d1747772d3cf32cfbe9f07979fa05f48471ac73475b4e7a9e",
    "purchase_landed_cost_freeze()": "3eda69587e6a9a8046ff1d7852e1ac7d0dec0d05ae633d1b78663a091634379a",
    "purchase_allocations_consistent()": "ac783691817646b8ac3528766a3203ec30c3f594a6f997b7f5779504ab625748",
    "negative_deficit_coverage_same_transaction()": "77e09d0b7e15b2368ca2ace6f7de5933964777c5b3e5a1f58fb5723eb156b663",
    "negative_inventory_deficits_coverage_guard()": "a6fb57abb419fea3eb0f75c1c81ee0189226c5354fca7fe6197fb0f1ae76a925",
    "negative_inventory_deficits_coverage_consistent()": "883da444f892ddbb0ad16f5d77c124057f46304e966262b80a63c3bfc1867b6b"
  }';
BEGIN
  FOR v_type IN SELECT t.source_type FROM stock_source_types t ORDER BY t.source_type LOOP
    v_s3 := v_type IN ('inventory_adjustment', 'inventory_opening', 'inventory_transfer', 'stocktake');
    v_s4 := v_type IN ('negative_inventory_cost_adjustment', 'purchase');
    v_line_tbl := NULL;
    v_line_key := NULL;
    SELECT to_regclass('public.' || e.tbl), e.cols INTO v_line_tbl, v_line_key
    FROM (VALUES ('inventory_transfer',   'inventory_transfer_lines',   ARRAY['business_id', 'transfer_id', 'id']),
                 ('inventory_adjustment', 'inventory_adjustment_lines', ARRAY['business_id', 'adjustment_id', 'id']),
                 ('stocktake',            'stocktake_lines',            ARRAY['business_id', 'stocktake_id', 'id']),
                 ('inventory_opening',    'inventory_opening_lines',    ARRAY['business_id', 'opening_id', 'id']),
                 ('purchase',             'purchase_lines',             ARRAY['business_id', 'purchase_id', 'id']),
                 ('negative_inventory_cost_adjustment', 'negative_deficit_coverages', ARRAY['business_id', 'adjustment_id', 'id'])) AS e(st, tbl, cols)
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
      -- The line FK: for an S3 or S4 type to exactly its line table and key,
      -- for any other type to some third table (the S2 template).
      IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                      WHERE c.contype = 'f' AND c.conrelid = v_bridge AND c.confrelid <> v_bind
                        AND c.confrelid <> v_bridge AND c.confdeltype = 'r' AND c.convalidated
                        AND (NOT (v_s3 OR v_s4) OR c.confrelid = v_line_tbl)
                        AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
                               FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
                            = ARRAY['business_id', 'source_id', 'source_line_id']
                        AND (NOT (v_s3 OR v_s4)
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
                        AND (NOT (v_s3 OR v_s4) OR encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex')
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
            AND (NOT (v_s3 OR v_s4) OR encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex')
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
  END LOOP;
END;
$$;

COMMENT ON FUNCTION inventory_stock_source_guard_gaps() IS
  'P3-AL-51 §B, strengthened by P3-S3 (A-16, review F3). Catalogue-only discovery: for every stock_source_types row, reports each missing or mis-shaped guard — bridge (a plain table), bridge_rls (enabled and forced), bridge_pk (exactly business_id, source_id, source_line_id, movement_kind), bridge_source_type (a stored generated constant equal to the type), bridge_binding_fk (validated RESTRICT, five columns in order), bridge_line_fk (validated RESTRICT, business_id, source_id, source_line_id; for an S3 type to exactly its line table and key), bridge_immutable (ROW BEFORE UPDATE OR DELETE on every column, no WHEN, enabled for origin sessions, on stock_ledger_append_only()), binding_trigger (ROW AFTER INSERT deferred constraint trigger on its own internal DEFINER function with the pinned path and the WHEN on the type). For the four S3 types also source_complete, source_freeze, header_immutable, value_complete and (stocktake) header_complete, each by table, name, event, column list, WHEN, deferral, enabled state and expected internal DEFINER pinned function; and every S3 guard function''s body against the SHA-256 of its prosrc recorded at migration time. Replaced by P3-S4 (0063, §2.3): the two S4 types (purchase, negative_inventory_cost_adjustment) get the S3 bridge_line_fk (purchase_lines / negative_deficit_coverages), bridge_immutable and binding_trigger checks, and their own set — source_complete, header_complete (purchase), source_freeze, header_immutable, value_complete — with every S4 guard function''s body recorded the same way (the two stock_ledger_append_only() guards as migrator-owned INVOKER); per the P3-S4 review also landed_cost_freeze, allocation_freeze, allocation_consistent, landed_cost_consistent (purchase) and coverage_same_transaction, coverage_value_complete, deficit_guard, deficit_consistent (negative_inventory_cost_adjustment), the three freeze triggers and the header guard judging INSERT too. Every migration that registers a source type asserts it returns no row. Migrator-owned INVOKER; no EXECUTE grant.';

REVOKE ALL ON FUNCTION inventory_stock_source_guard_gaps() FROM PUBLIC;


-- ─────────────────────────────────────────────────────────────────────────
-- 7. Stock-source registration (A-05): after every guard above exists and
--    the discovery that proves them is replaced.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO stock_source_types (source_type, registered_by) VALUES
  ('purchase', 'P3-S4'), ('negative_inventory_cost_adjustment', 'P3-S4');

-- ─────────────────────────────────────────────────────────────────────────
-- 8. The accounting side (A-14). Every function is owned by
--    daftar_accounting_internal, DEFINER, pinned, PUBLIC revoked, inside the
--    accounting CREATE bracket (0058:40-71).
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;

-- (b) The reversal guard, replaced BY ITS OWNER: byte-identical to 0061
--     except that the domain-owned list names the two S4 source types. The
--     generic workflow could otherwise reverse a purchase entry without its
--     inverse movements (PM-16); S5 admits its own purchase reversal.
SET LOCAL ROLE daftar_accounting_internal;

CREATE OR REPLACE FUNCTION accounting_reversals_20_domain_source_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_ob UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM journal_entries je
              WHERE je.business_id = NEW.business_id AND je.id = NEW.original_entry_id
                AND je.source_type IN ('inventory_adjustment', 'inventory_opening', 'purchase', 'negative_inventory_cost_adjustment')) THEN
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

-- (a) Detail completeness (AL-01 re-proved, L:1054-1056): an entry of an S4
--     source cannot commit without exactly its document, in exactly the A-05
--     shape, for exactly the document's amounts.
CREATE OR REPLACE FUNCTION accounting_purchase_entry_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_p      RECORD;
  v_branch UUID;
  v_lines  INTEGER;
  v_inv    INTEGER;
  v_ap     INTEGER;
  v_inv_ok BOOLEAN;
  v_ap_ok  BOOLEAN;
BEGIN
  SELECT p.document_date, p.total_txn_minor, p.total_base_minor, p.currency_code, p.source_to_base_rate, p.rate_source,
         p.rate_timestamp, p.warehouse_id
    INTO v_p
  FROM purchases p
  WHERE p.business_id = NEW.business_id AND p.binding_source_id = NEW.source_id AND p.status = 'received';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accounting.inventory_detail_missing: a purchase entry must be registered by its received purchase in the same transaction'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT w.branch_id INTO v_branch FROM warehouses w WHERE w.business_id = NEW.business_id AND w.id = v_p.warehouse_id;

  SELECT count(*),
         count(*) FILTER (WHERE a.system_key = 'inventory'),
         count(*) FILTER (WHERE a.system_key = 'accounts_payable'),
         coalesce(bool_and(l.debit_minor = v_p.total_base_minor AND l.credit_minor = 0
                           AND l.warehouse_id IS NOT DISTINCT FROM v_p.warehouse_id AND l.branch_id IS NOT DISTINCT FROM v_branch)
                    FILTER (WHERE a.system_key = 'inventory'), false),
         coalesce(bool_and(l.credit_minor = v_p.total_base_minor AND l.debit_minor = 0
                           AND l.warehouse_id IS NULL AND l.branch_id IS NOT DISTINCT FROM v_branch)
                    FILTER (WHERE a.system_key = 'accounts_payable'), false)
    INTO v_lines, v_inv, v_ap, v_inv_ok, v_ap_ok
  FROM journal_lines l
  JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
  WHERE l.business_id = NEW.business_id AND l.journal_entry_id = NEW.id;

  IF NEW.entry_date IS DISTINCT FROM v_p.document_date OR v_branch IS NULL
     OR v_lines <> 2 OR v_inv <> 1 OR v_ap <> 1 OR NOT v_inv_ok OR NOT v_ap_ok
     OR EXISTS (SELECT 1 FROM journal_lines l
                 WHERE l.business_id = NEW.business_id AND l.journal_entry_id = NEW.id
                   AND (l.txn_amount_minor IS DISTINCT FROM v_p.total_txn_minor
                        OR l.txn_currency IS DISTINCT FROM v_p.currency_code::text
                        OR l.fx_rate IS DISTINCT FROM v_p.source_to_base_rate
                        OR l.fx_rate_source IS DISTINCT FROM v_p.rate_source
                        OR l.fx_rate_at IS DISTINCT FROM v_p.rate_timestamp)) THEN
    RAISE EXCEPTION 'accounting.inventory_entry_mismatch: a purchase entry is not exactly the Inventory debit and Accounts Payable credit of its purchase'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION accounting_negative_inventory_cost_adjustment_entry_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_date     DATE;
  v_total    BIGINT;
  v_wh       UUID;
  v_branch   UUID;
  v_lines    INTEGER;
  v_inv      INTEGER;
  v_cogs     INTEGER;
  v_inv_net  NUMERIC;
  v_cogs_net NUMERIC;
  v_dims     BOOLEAN;
BEGIN
  SELECT a.occurred_on, a.total_value_base_minor, a.warehouse_id INTO v_date, v_total, v_wh
  FROM negative_inventory_cost_adjustments a
  WHERE a.business_id = NEW.business_id AND a.binding_source_id = NEW.source_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accounting.inventory_detail_missing: a deficit catch-up entry must be registered by its coverage header in the same transaction'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT w.branch_id INTO v_branch FROM warehouses w WHERE w.business_id = NEW.business_id AND w.id = v_wh;

  SELECT count(*),
         count(*) FILTER (WHERE a.system_key = 'inventory'),
         count(*) FILTER (WHERE a.system_key = 'cogs'),
         coalesce(sum(l.debit_minor::numeric - l.credit_minor::numeric) FILTER (WHERE a.system_key = 'inventory'), 0),
         coalesce(sum(l.debit_minor::numeric - l.credit_minor::numeric) FILTER (WHERE a.system_key = 'cogs'), 0),
         coalesce(bool_and(l.warehouse_id IS NOT DISTINCT FROM v_wh AND l.branch_id IS NOT DISTINCT FROM v_branch
                           AND l.txn_currency = l.base_currency AND l.fx_rate_source = 'base'), false)
    INTO v_lines, v_inv, v_cogs, v_inv_net, v_cogs_net, v_dims
  FROM journal_lines l
  JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
  WHERE l.business_id = NEW.business_id AND l.journal_entry_id = NEW.id;

  IF NEW.entry_date IS DISTINCT FROM v_date OR v_total IS NULL OR v_total = 0 OR v_branch IS NULL
     OR v_lines <> 2 OR v_inv <> 1 OR v_cogs <> 1
     OR v_inv_net <> v_total::numeric OR v_cogs_net <> -v_total::numeric OR NOT v_dims THEN
    RAISE EXCEPTION 'accounting.inventory_entry_mismatch: a deficit catch-up entry is not exactly the net Inventory/COGS pair of its coverage header'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- (c) The purchase FX snapshot read (A-17, R-17, R-22). Reachable only from
--     signed inventory routines (the one grant is to the NOLOGIN internal
--     inventory principal); the business must be the transaction's.
CREATE OR REPLACE FUNCTION accounting_purchase_fx_rate(p_business_id UUID, p_currency CHAR(3), p_at TIMESTAMPTZ)
RETURNS accounting_fx_rate_snapshot
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_from TEXT;
  v_to   TEXT;
  v_out  accounting_fx_rate_snapshot;
BEGIN
  IF p_business_id IS NULL
     OR p_business_id IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'accounting.scope_mismatch: a purchase rate is read only for the transaction''s business' USING ERRCODE = 'P0001';
  END IF;
  IF p_at IS NULL THEN
    RAISE EXCEPTION 'accounting.payload_missing_field: a rate lookup states a business and an instant' USING ERRCODE = 'P0001';
  END IF;
  v_from := upper(btrim(coalesce(p_currency::text, '')));
  SELECT b.base_currency INTO v_to FROM businesses b WHERE b.id = p_business_id;

  IF NOT EXISTS (SELECT 1 FROM currencies c WHERE c.code = v_from)
     OR NOT EXISTS (SELECT 1 FROM currencies c WHERE c.code = v_to) THEN
    RAISE EXCEPTION 'accounting.fx_currency_unknown: a rate is looked up between two registered currencies' USING ERRCODE = 'P0001';
  END IF;
  IF v_from = v_to THEN
    RAISE EXCEPTION 'accounting.fx_same_currency: a currency has no exchange rate against itself — domestic money uses the base sentinel' USING ERRCODE = 'P0001';
  END IF;

  SELECT r.id, r.rate, r.source, r.effective_at INTO v_out
  FROM accounting_fx_rates r
  WHERE r.business_id = p_business_id
    AND r.from_currency = v_from
    AND r.to_currency = v_to
    AND r.effective_at <= p_at
  ORDER BY r.effective_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'accounting.fx_rate_missing: this business has stated no % to % rate in force at that instant', v_from, v_to USING ERRCODE = 'P0001';
  END IF;
  RETURN v_out;
END;
$$;

COMMENT ON FUNCTION accounting_purchase_fx_rate(UUID, CHAR(3), TIMESTAMPTZ) IS
  'P3-S4 A-14(c), A-17. The purchase FX snapshot: the accounting_fx_rate_lookup query from p_currency to the business''s base currency at p_at (the latest rate in force at or before it), raising what that lookup raises (accounting.fx_currency_unknown, fx_same_currency, fx_rate_missing); accounting.scope_mismatch unless p_business_id is the transaction''s business. STABLE, writes nothing. EXECUTE: daftar_inventory_internal only (reachability for signed routines, not runtime reach).';

REVOKE ALL ON FUNCTION accounting_purchase_entry_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_negative_inventory_cost_adjustment_entry_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_purchase_fx_rate(UUID, CHAR(3), TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accounting_purchase_fx_rate(UUID, CHAR(3), TIMESTAMPTZ) TO daftar_inventory_internal;

CREATE CONSTRAINT TRIGGER journal_entries_purchase_complete
  AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source_type = 'purchase')
  EXECUTE FUNCTION accounting_purchase_entry_complete();
CREATE CONSTRAINT TRIGGER journal_entries_negative_inventory_cost_adjustment_complete
  AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source_type = 'negative_inventory_cost_adjustment')
  EXECUTE FUNCTION accounting_negative_inventory_cost_adjustment_entry_complete();

ALTER FUNCTION accounting_purchase_entry_complete() OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_negative_inventory_cost_adjustment_entry_complete() OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_purchase_fx_rate(UUID, CHAR(3), TIMESTAMPTZ) OWNER TO daftar_accounting_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;

-- (e) The registries (L:1038-1048), with the owning operation kind the 0046
--     rule requires.
INSERT INTO accounting_source_types (source_type, lower_bound_policy, upper_bound_policy, description, sort_order) VALUES
  ('purchase',                           'none', 'not_after_today', 'A received supplier purchase: Dr Inventory / Cr Accounts Payable (P3-AL-24).', 6),
  ('negative_inventory_cost_adjustment', 'none', 'not_after_today', 'The catch-up of covered negative-inventory deficits against COGS (P3-AL-13).', 7);
INSERT INTO accounting_operation_kinds (operation_kind, source_type, description) VALUES
  ('post', 'purchase',                           'Purchase receipt; derived by the purchase command.'),
  ('post', 'negative_inventory_cost_adjustment', 'Deficit catch-up; derived by the purchase receipt.');

-- ─────────────────────────────────────────────────────────────────────────
-- 9. Refuse to commit unless the end state is exactly right (0063-E, §2.8).
--    `has_*_privilege` against the live catalogue.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_role     TEXT;
  v_table    TEXT;
  v_priv     TEXT;
  v_detail   TEXT;
  v_actual   TEXT[];
  v_expected TEXT[];
  v_def      TEXT;
  v_fn       REGPROCEDURE;
  c_docs     CONSTANT TEXT[] := ARRAY['negative_inventory_cost_adjustments', 'purchase_landed_cost_allocations', 'purchase_landed_costs',
                                      'purchase_lines', 'purchases', 'suppliers'];
  c_bridges  CONSTANT TEXT[] := ARRAY['stock_source_bridge_negative_inventory_cost_adjustment', 'stock_source_bridge_purchase'];
  c_s2       CONSTANT TEXT[] := ARRAY['negative_deficit_coverages', 'negative_inventory_deficits'];
  c_runtime  CONSTANT TEXT[] := ARRAY['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver',
                                      'daftar_provisioner', 'daftar_reconciler', 'public'];
  c_privs    CONSTANT TEXT[] := ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  c_inv_fns  CONSTANT REGPROCEDURE[] := ARRAY[
    'stock_binding_requires_purchase()'::regprocedure,
    'stock_binding_requires_negative_inventory_cost_adjustment()'::regprocedure,
    'stock_source_complete_purchase()'::regprocedure,
    'stock_source_complete_purchase_header()'::regprocedure,
    'stock_source_complete_negative_inventory_cost_adjustment()'::regprocedure,
    'stock_source_freeze_purchase()'::regprocedure,
    'purchase_landed_cost_freeze()'::regprocedure,
    'purchase_header_guard()'::regprocedure,
    'purchase_source_value_complete()'::regprocedure,
    'suppliers_no_delete()'::regprocedure,
    'suppliers_revision_guard()'::regprocedure,
    'purchase_allocations_consistent()'::regprocedure,
    'negative_inventory_deficits_coverage_guard()'::regprocedure,
    'negative_inventory_deficits_coverage_consistent()'::regprocedure,
    'negative_deficit_coverage_same_transaction()'::regprocedure];
  c_acc_fns  CONSTANT REGPROCEDURE[] := ARRAY[
    'accounting_purchase_entry_complete()'::regprocedure,
    'accounting_negative_inventory_cost_adjustment_entry_complete()'::regprocedure,
    'accounting_purchase_fx_rate(uuid,char,timestamptz)'::regprocedure,
    'accounting_reversals_20_domain_source_guard()'::regprocedure];
BEGIN
  -- (1) The four S3 stock source types plus exactly the two S4 types.
  SELECT array_agg(t.source_type || ':' || t.registered_by ORDER BY t.source_type) INTO v_actual FROM stock_source_types t;
  IF v_actual IS DISTINCT FROM ARRAY['inventory_adjustment:P3-S3', 'inventory_opening:P3-S3', 'inventory_transfer:P3-S3',
                                     'negative_inventory_cost_adjustment:P3-S4', 'purchase:P3-S4', 'stocktake:P3-S3'] THEN
    RAISE EXCEPTION 'purchase.migration_end_state_invalid: stock_source_types is not exactly the four P3-S3 and the two P3-S4 types, found %', v_actual;
  END IF;

  -- (2) Every registered source type is fully guarded, and the replaced
  --     discovery is live for S4: each §2.3 mutation, inside a rolled-back
  --     block, is reported.
  IF EXISTS (SELECT 1 FROM inventory_stock_source_guard_gaps()) THEN
    SELECT string_agg(g.source_type || ':' || g.missing, ', ') INTO v_detail FROM inventory_stock_source_guard_gaps() g;
    RAISE EXCEPTION 'inventory.source_guard_missing: a registered stock source type lacks a guard: %', v_detail;
  END IF;
  BEGIN
    ALTER TABLE stock_source_bridge_purchase DISABLE TRIGGER stock_bridge_immutable_purchase;
    SELECT string_agg(g.source_type || ':' || g.missing, ', ') INTO v_detail FROM inventory_stock_source_guard_gaps() g;
    RAISE EXCEPTION 'inventory.probe_rollback: %', coalesce(v_detail, '');
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_detail = MESSAGE_TEXT;
  END;
  IF v_detail IS DISTINCT FROM 'inventory.probe_rollback: purchase:bridge_immutable' THEN
    RAISE EXCEPTION 'inventory.source_guard_missing: the replaced discovery did not report a disabled purchase bridge guard (%)', v_detail;
  END IF;
  -- The body digest: the owner replaces the coverage completeness guard with
  -- a no-op of the same signature, owner, security and path.
  BEGIN
    GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;
    SET LOCAL ROLE daftar_inventory_internal;
    CREATE OR REPLACE FUNCTION stock_source_complete_negative_inventory_cost_adjustment() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $probe$
    BEGIN
      RETURN NULL;
    END;
    $probe$;
    RESET ROLE;
    REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;
    SELECT string_agg(g.source_type || ':' || g.missing, ', ') INTO v_detail FROM inventory_stock_source_guard_gaps() g;
    RAISE EXCEPTION 'inventory.probe_rollback: %', coalesce(v_detail, '');
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_detail = MESSAGE_TEXT;
  END;
  IF v_detail IS DISTINCT FROM 'inventory.probe_rollback: negative_inventory_cost_adjustment:source_complete' THEN
    RAISE EXCEPTION 'inventory.source_guard_missing: the replaced discovery did not report a neutered coverage guard body (%)', v_detail;
  END IF;
  BEGIN
    DROP TRIGGER purchases_immutable ON purchases;
    CREATE TRIGGER purchases_immutable BEFORE INSERT OR UPDATE OR DELETE ON purchases FOR EACH ROW EXECUTE FUNCTION stock_ledger_append_only();
    SELECT string_agg(g.source_type || ':' || g.missing, ', ') INTO v_detail FROM inventory_stock_source_guard_gaps() g;
    RAISE EXCEPTION 'inventory.probe_rollback: %', coalesce(v_detail, '');
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_detail = MESSAGE_TEXT;
  END;
  IF v_detail IS DISTINCT FROM 'inventory.probe_rollback: purchase:header_immutable' THEN
    RAISE EXCEPTION 'inventory.source_guard_missing: the replaced discovery did not report a header guard on another function (%)', v_detail;
  END IF;
  -- R-39: the header guard back on its pre-review events (INSERT-blind).
  BEGIN
    DROP TRIGGER purchases_immutable ON purchases;
    CREATE TRIGGER purchases_immutable BEFORE UPDATE OR DELETE ON purchases FOR EACH ROW EXECUTE FUNCTION purchase_header_guard();
    SELECT string_agg(g.source_type || ':' || g.missing, ', ') INTO v_detail FROM inventory_stock_source_guard_gaps() g;
    RAISE EXCEPTION 'inventory.probe_rollback: %', coalesce(v_detail, '');
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_detail = MESSAGE_TEXT;
  END;
  IF v_detail IS DISTINCT FROM 'inventory.probe_rollback: purchase:header_immutable' THEN
    RAISE EXCEPTION 'inventory.source_guard_missing: the replaced discovery did not report an INSERT-blind header guard (%)', v_detail;
  END IF;
  -- R-38 (review I1): the added guards are seen disabled, replica-only,
  -- re-pointed, back on the old events, or with a changed body.
  BEGIN
    ALTER TABLE purchase_landed_costs DISABLE TRIGGER purchase_landed_costs_freeze;
    ALTER TABLE purchase_landed_cost_allocations ENABLE REPLICA TRIGGER purchase_allocations_consistent;
    SELECT string_agg(g.source_type || ':' || g.missing, ', ' ORDER BY g.source_type, g.missing) INTO v_detail FROM inventory_stock_source_guard_gaps() g;
    RAISE EXCEPTION 'inventory.probe_rollback: %', coalesce(v_detail, '');
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_detail = MESSAGE_TEXT;
  END;
  IF v_detail IS DISTINCT FROM 'inventory.probe_rollback: purchase:allocation_consistent, purchase:landed_cost_freeze' THEN
    RAISE EXCEPTION 'inventory.source_guard_missing: the replaced discovery did not report a disabled or replica-only landed-cost guard (%)', v_detail;
  END IF;
  BEGIN
    DROP TRIGGER stock_source_freeze_purchase ON purchase_lines;
    CREATE TRIGGER stock_source_freeze_purchase BEFORE UPDATE OR DELETE ON purchase_lines
      FOR EACH ROW EXECUTE FUNCTION stock_source_freeze_purchase();
    DROP TRIGGER negative_deficit_coverages_value_complete ON negative_deficit_coverages;
    CREATE CONSTRAINT TRIGGER negative_deficit_coverages_value_complete AFTER INSERT ON negative_deficit_coverages
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stock_source_complete_negative_inventory_cost_adjustment();
    SELECT string_agg(g.source_type || ':' || g.missing, ', ' ORDER BY g.source_type, g.missing) INTO v_detail FROM inventory_stock_source_guard_gaps() g;
    RAISE EXCEPTION 'inventory.probe_rollback: %', coalesce(v_detail, '');
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_detail = MESSAGE_TEXT;
  END;
  IF v_detail IS DISTINCT FROM 'inventory.probe_rollback: negative_inventory_cost_adjustment:coverage_value_complete, purchase:source_freeze' THEN
    RAISE EXCEPTION 'inventory.source_guard_missing: the replaced discovery did not report a re-pointed or INSERT-blind guard (%)', v_detail;
  END IF;
  BEGIN
    GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;
    SET LOCAL ROLE daftar_inventory_internal;
    CREATE OR REPLACE FUNCTION negative_deficit_coverage_same_transaction() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $probe$
    BEGIN
      RETURN NEW;
    END;
    $probe$;
    RESET ROLE;
    REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;
    SELECT string_agg(g.source_type || ':' || g.missing, ', ' ORDER BY g.source_type, g.missing) INTO v_detail FROM inventory_stock_source_guard_gaps() g;
    RAISE EXCEPTION 'inventory.probe_rollback: %', coalesce(v_detail, '');
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_detail = MESSAGE_TEXT;
  END;
  IF v_detail IS DISTINCT FROM 'inventory.probe_rollback: negative_inventory_cost_adjustment:coverage_same_transaction' THEN
    RAISE EXCEPTION 'inventory.source_guard_missing: the replaced discovery did not report a neutered same-transaction guard body (%)', v_detail;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgname = 'stock_bridge_immutable_purchase' AND g.tgenabled = 'O')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgname = 'purchases_immutable'
                      AND g.tgfoid = 'purchase_header_guard()'::regprocedure AND g.tgtype = 31)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgname = 'purchase_landed_costs_freeze' AND g.tgenabled = 'O')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgname = 'purchase_allocations_consistent' AND g.tgenabled = 'O')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgname = 'stock_source_freeze_purchase' AND g.tgtype = 31)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgname = 'negative_deficit_coverages_value_complete'
                      AND g.tgfoid = 'purchase_source_value_complete()'::regprocedure)
     OR EXISTS (SELECT 1 FROM inventory_stock_source_guard_gaps())
     OR has_schema_privilege('daftar_inventory_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: a discovery probe did not roll back';
  END IF;

  -- (3) The accounting source registry: the five earlier rows unchanged plus
  --     the two S4 rows at 6/7; every registered source type owned (0046).
  SELECT array_agg(s.source_type || ':' || s.lower_bound_policy || ':' || s.upper_bound_policy || ':' || s.sort_order ORDER BY s.sort_order)
    INTO v_actual FROM accounting_source_types s WHERE s.sort_order > 3;
  IF v_actual IS DISTINCT FROM ARRAY['inventory_adjustment:none:not_after_today:4', 'inventory_opening:none:not_after_today:5',
                                     'purchase:none:not_after_today:6', 'negative_inventory_cost_adjustment:none:not_after_today:7'] THEN
    RAISE EXCEPTION 'purchase.migration_end_state_invalid: accounting_source_types beyond the natives is not exactly the P3-S3 and P3-S4 rows, found %', v_actual;
  END IF;
  SELECT array_agg(s.source_type ORDER BY s.sort_order) INTO v_actual FROM accounting_source_types s WHERE s.sort_order <= 3;
  IF v_actual IS DISTINCT FROM ARRAY['opening_balance', 'manual_adjustment', 'reversal'] THEN
    RAISE EXCEPTION 'purchase.migration_end_state_invalid: the native accounting source types changed, found %', v_actual;
  END IF;
  SELECT array_agg(k.operation_kind || ':' || k.source_type ORDER BY k.source_type) INTO v_actual FROM accounting_operation_kinds k;
  IF v_actual IS DISTINCT FROM ARRAY['post:inventory_adjustment', 'post:inventory_opening', 'post:manual_adjustment',
                                     'post:negative_inventory_cost_adjustment', 'post:opening_balance', 'post:purchase',
                                     'reverse:reversal'] THEN
    RAISE EXCEPTION 'purchase.migration_end_state_invalid: accounting_operation_kinds is not the earlier five plus the two P3-S4 pairs, found %', v_actual;
  END IF;
  IF EXISTS (SELECT 1 FROM accounting_source_types st
              WHERE NOT EXISTS (SELECT 1 FROM accounting_operation_kinds k
                                 WHERE k.source_type = st.source_type AND k.operation_kind IN ('post', 'reverse'))) THEN
    RAISE EXCEPTION 'purchase.migration_end_state_invalid: a registered accounting source type has no post or reverse kind';
  END IF;

  -- (4) The coverage FK and the three new candidate keys, validated.
  IF (SELECT count(*) FROM pg_constraint c
       WHERE c.convalidated
         AND ((c.conname = 'negative_deficit_coverages_adjustment_fk' AND c.contype = 'f'
               AND c.conrelid = 'public.negative_deficit_coverages'::regclass
               AND c.confrelid = 'public.negative_inventory_cost_adjustments'::regclass
               AND c.confdeltype = 'r' AND NOT c.condeferrable)
           OR (c.conname = 'negative_deficit_coverages_bridge_uq' AND c.contype = 'u'
               AND c.conrelid = 'public.negative_deficit_coverages'::regclass)
           OR (c.conname = 'negative_deficit_coverages_deficit_uq' AND c.contype = 'u'
               AND c.conrelid = 'public.negative_deficit_coverages'::regclass)
           OR (c.conname = 'purchases_warehouse_uq' AND c.contype = 'u'
               AND c.conrelid = 'public.purchases'::regclass))) <> 4 THEN
    RAISE EXCEPTION 'purchase.migration_end_state_invalid: the coverage FK or a new candidate key is missing or not validated';
  END IF;

  -- (5) The tax bound (A-12, OD-03).
  SELECT pg_get_constraintdef(c.oid) INTO v_def FROM pg_constraint c
   WHERE c.conname = 'purchases_tax_policy_absent_ck' AND c.conrelid = 'public.purchases'::regclass AND c.contype = 'c';
  IF v_def IS DISTINCT FROM 'CHECK ((tax_minor = 0))' THEN
    RAISE EXCEPTION 'purchase.migration_end_state_invalid: purchases_tax_policy_absent_ck is not CHECK ((tax_minor = 0)), found %', v_def;
  END IF;

  -- (6) The A-18 grant matrix, exactly: no runtime role holds DML on an S4
  --     table; daftar_app reads exactly the A-18 set.
  FOREACH v_table IN ARRAY c_docs || c_bridges || c_s2 LOOP
    IF v_table <> ALL (c_s2) AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = ('public.' || v_table)::regclass
                     AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity) THEN
      RAISE EXCEPTION 'purchase.migration_end_state_invalid: row security is not enabled and forced on %', v_table;
    END IF;
    FOREACH v_role IN ARRAY c_runtime LOOP
      FOREACH v_priv IN ARRAY c_privs LOOP
        IF has_table_privilege(v_role, v_table, v_priv)
           AND NOT (v_role = 'daftar_app' AND v_priv = 'SELECT' AND v_table <> ALL (c_bridges)) THEN
          RAISE EXCEPTION 'purchase.migration_end_state_invalid: % holds % on %', v_role, v_priv, v_table;
        END IF;
      END LOOP;
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
        IF has_any_column_privilege(v_role, v_table, v_priv)
           AND NOT (v_role = 'daftar_app' AND v_priv = 'SELECT' AND v_table <> ALL (c_bridges)) THEN
          RAISE EXCEPTION 'purchase.migration_end_state_invalid: % holds column-level % on %', v_role, v_priv, v_table;
        END IF;
      END LOOP;
    END LOOP;
    IF v_table <> ALL (c_bridges) AND NOT has_table_privilege('daftar_app', v_table, 'SELECT') THEN
      RAISE EXCEPTION 'purchase.migration_end_state_invalid: daftar_app cannot read %', v_table;
    END IF;
  END LOOP;

  -- R-35 (review L1): on every S4 table the restrictive isolation is exactly
  -- one policy per command, and only the FOR SELECT one admits a principal
  -- by name; no restrictive write policy admits anything but the row's own
  -- business (or app_bypass()).
  FOREACH v_table IN ARRAY c_docs || c_bridges LOOP
    SELECT array_agg(p.polname::text || ':' || p.polcmd::text ORDER BY p.polname) INTO v_actual
    FROM pg_policy p WHERE p.polrelid = ('public.' || v_table)::regclass AND NOT p.polpermissive;
    IF v_actual IS DISTINCT FROM ARRAY['business_isolation_delete:d', 'business_isolation_insert:a',
                                       'business_isolation_read:r', 'business_isolation_update:w'] THEN
      RAISE EXCEPTION 'purchase.migration_end_state_invalid: % restrictive isolation is not one policy per command, found %', v_table, v_actual;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policy p
                WHERE p.polrelid = ('public.' || v_table)::regclass AND NOT p.polpermissive AND p.polcmd <> 'r'
                  AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '(app_bypass() OR (business_id = (NULLIF(app_business(), ''''::text))::uuid))')
                         <> '(app_bypass() OR (business_id = (NULLIF(app_business(), ''''::text))::uuid))'
                       OR coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '(app_bypass() OR (business_id = (NULLIF(app_business(), ''''::text))::uuid))')
                         <> '(app_bypass() OR (business_id = (NULLIF(app_business(), ''''::text))::uuid))')) THEN
      RAISE EXCEPTION 'purchase.migration_end_state_invalid: a restrictive write policy on % admits more than its own business', v_table;
    END IF;
  END LOOP;

  -- The internal principal: SELECT, INSERT on the six tables, the two
  -- bridges and the coverages; DELETE on the three draft-replaced tables;
  -- SELECT on the deficits; exactly the A-18 column UPDATEs.
  v_expected := ARRAY['negative_deficit_coverages:INSERT', 'negative_deficit_coverages:SELECT', 'negative_inventory_deficits:SELECT',
                      'purchase_landed_cost_allocations:DELETE', 'purchase_landed_costs:DELETE', 'purchase_lines:DELETE'];
  FOREACH v_table IN ARRAY c_docs || c_bridges LOOP
    v_expected := v_expected || (v_table || ':INSERT') || (v_table || ':SELECT');
  END LOOP;
  SELECT array_agg(x ORDER BY x) INTO v_expected FROM unnest(v_expected) AS x;
  SELECT array_agg(t || ':' || p ORDER BY t || ':' || p) INTO v_actual
  FROM unnest(c_docs || c_bridges || c_s2) AS t CROSS JOIN unnest(c_privs) AS p
  WHERE has_table_privilege('daftar_inventory_internal', t, p);
  IF v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'purchase.migration_end_state_invalid: daftar_inventory_internal table privileges on the S4 tables are not exactly A-18, found %', v_actual;
  END IF;
  SELECT array_agg(c.relname || '.' || a.attname ORDER BY c.relname, a.attname) INTO v_actual
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
  WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY (c_docs || c_bridges || c_s2)
    AND a.attnum > 0 AND NOT a.attisdropped
    AND has_column_privilege('daftar_inventory_internal', c.oid, a.attnum, 'UPDATE');
  IF v_actual IS DISTINCT FROM ARRAY[
       'negative_inventory_deficits.status', 'negative_inventory_deficits.uncovered_qty',
       'purchase_lines.base_share_minor', 'purchase_lines.unit_cost_base_minor',
       'purchases.binding_source_id', 'purchases.business_transaction_id', 'purchases.cancel_intent_sha256', 'purchases.cancelled_at',
       'purchases.cancelled_by', 'purchases.currency_code', 'purchases.document_date', 'purchases.draft_intent_sha256',
       'purchases.fx_rate_id', 'purchases.landed_cost_txn_minor', 'purchases.notes', 'purchases.rate_source', 'purchases.rate_timestamp',
       'purchases.receive_intent_sha256', 'purchases.received_at', 'purchases.received_by', 'purchases.revision',
       'purchases.source_to_base_rate', 'purchases.status', 'purchases.subtotal_txn_minor', 'purchases.supplier_id',
       'purchases.supplier_name_snapshot', 'purchases.supplier_phone_snapshot', 'purchases.supplier_reference',
       'purchases.supplier_tax_identifier_snapshot', 'purchases.tax_minor', 'purchases.total_base_minor', 'purchases.total_txn_minor',
       'purchases.updated_at', 'purchases.warehouse_id',
       'suppliers.business_transaction_id', 'suppliers.email', 'suppliers.last_intent_sha256', 'suppliers.name', 'suppliers.notes',
       'suppliers.phone', 'suppliers.revision', 'suppliers.status', 'suppliers.tax_identifier', 'suppliers.updated_at',
       'suppliers.updated_by'] THEN
    RAISE EXCEPTION 'purchase.migration_end_state_invalid: daftar_inventory_internal column UPDATE is not exactly the A-18 set, found %', v_actual;
  END IF;
  IF NOT has_table_privilege('daftar_inventory_internal', 'currencies', 'SELECT')
     OR NOT has_function_privilege('daftar_inventory_internal', 'accounting_purchase_fx_rate(uuid,char,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'purchase.migration_end_state_invalid: daftar_inventory_internal does not hold its A-18 currency read and FX snapshot read';
  END IF;
  -- The accounting principal reads the two posting headers, nothing else here.
  SELECT array_agg(t || ':' || p ORDER BY t || ':' || p) INTO v_actual
  FROM unnest(c_docs || c_bridges || c_s2) AS t CROSS JOIN unnest(c_privs) AS p
  WHERE has_table_privilege('daftar_accounting_internal', t, p)
     OR CASE WHEN p IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
             THEN has_any_column_privilege('daftar_accounting_internal', t, p) ELSE false END;
  IF v_actual IS DISTINCT FROM ARRAY['negative_inventory_cost_adjustments:SELECT', 'purchases:SELECT'] THEN
    RAISE EXCEPTION 'purchase.migration_end_state_invalid: daftar_accounting_internal holds more than A-14(d) on the S4 tables, found %', v_actual;
  END IF;

  -- (7) Every new function: owner, DEFINER, pinned path; no runtime role
  --     executes it; every trigger by table, name, tgtype, function,
  --     deferral and enabled state.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_detail
  FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
  WHERE (p.oid = ANY (c_inv_fns) AND r.rolname <> 'daftar_inventory_internal')
     OR (p.oid = ANY (c_acc_fns) AND r.rolname <> 'daftar_accounting_internal')
     OR ((p.oid = ANY (c_inv_fns) OR p.oid = ANY (c_acc_fns))
         AND (NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']));
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'purchase.migration_end_state_invalid: function(s) with the wrong owner, security or path: %', v_detail;
  END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.oid = ANY (c_inv_fns) OR p.oid = ANY (c_acc_fns)) <> 19 THEN
    RAISE EXCEPTION 'purchase.migration_end_state_invalid: a P3-S4 source-side function is missing';
  END IF;
  FOREACH v_fn IN ARRAY c_inv_fns || c_acc_fns || ARRAY['inventory_stock_source_guard_gaps()'::regprocedure] LOOP
    FOREACH v_role IN ARRAY c_runtime LOOP
      IF has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION 'purchase.migration_end_state_invalid: % may execute %', v_role, v_fn;
      END IF;
    END LOOP;
    IF v_fn <> 'accounting_purchase_fx_rate(uuid,char,timestamptz)'::regprocedure
       AND (SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) x
             WHERE p.oid = v_fn AND x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner) > 0 THEN
      RAISE EXCEPTION 'purchase.migration_end_state_invalid: % has an EXECUTE grantee', v_fn;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'inventory_stock_source_guard_gaps()'::regprocedure
               AND (p.prosecdef OR p.provolatile <> 's' OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
                    OR pg_get_function_result(p.oid) <> 'TABLE(source_type text, missing text)'
                    OR p.proowner::regrole::text <> current_user)) THEN
    RAISE EXCEPTION 'purchase.migration_end_state_invalid: inventory_stock_source_guard_gaps changed its contract';
  END IF;

  WITH expected (tbl, tg, typ, fn, owner, definer, deferred) AS (VALUES
    ('stock_source_bindings', 'stock_binding_requires_purchase', 5, 'stock_binding_requires_purchase()', 'daftar_inventory_internal', true, true),
    ('stock_source_bindings', 'stock_binding_requires_negative_inventory_cost_adjustment', 5,
     'stock_binding_requires_negative_inventory_cost_adjustment()', 'daftar_inventory_internal', true, true),
    ('stock_source_bridge_purchase', 'stock_bridge_immutable_purchase', 27, 'stock_ledger_append_only()', NULL, false, false),
    ('stock_source_bridge_negative_inventory_cost_adjustment', 'stock_bridge_immutable_negative_inventory_cost_adjustment', 27,
     'stock_ledger_append_only()', NULL, false, false),
    ('purchase_lines', 'stock_source_complete_purchase', 21, 'stock_source_complete_purchase()', 'daftar_inventory_internal', true, true),
    ('purchases', 'purchases_received_complete', 17, 'stock_source_complete_purchase_header()', 'daftar_inventory_internal', true, true),
    ('negative_deficit_coverages', 'stock_source_complete_negative_inventory_cost_adjustment', 5,
     'stock_source_complete_negative_inventory_cost_adjustment()', 'daftar_inventory_internal', true, true),
    ('negative_deficit_coverages', 'negative_deficit_coverages_append_only', 27, 'stock_ledger_append_only()', NULL, false, false),
    ('purchase_lines', 'stock_source_freeze_purchase', 31, 'stock_source_freeze_purchase()', 'daftar_inventory_internal', true, false),
    ('purchase_landed_costs', 'purchase_landed_costs_freeze', 31, 'purchase_landed_cost_freeze()', 'daftar_inventory_internal', true, false),
    ('purchase_landed_cost_allocations', 'purchase_landed_cost_allocations_freeze', 31, 'purchase_landed_cost_freeze()',
     'daftar_inventory_internal', true, false),
    ('purchase_landed_costs', 'purchase_landed_costs_consistent', 5, 'purchase_allocations_consistent()',
     'daftar_inventory_internal', true, true),
    ('negative_deficit_coverages', 'negative_deficit_coverages_same_transaction', 7, 'negative_deficit_coverage_same_transaction()',
     'daftar_inventory_internal', true, false),
    ('negative_deficit_coverages', 'negative_deficit_coverages_value_complete', 5, 'purchase_source_value_complete()',
     'daftar_inventory_internal', true, true),
    ('purchases', 'purchases_immutable', 31, 'purchase_header_guard()', 'daftar_inventory_internal', true, false),
    ('negative_inventory_cost_adjustments', 'negative_inventory_cost_adjustments_immutable', 27, 'stock_ledger_append_only()', NULL, false, false),
    ('purchases', 'purchases_value_complete', 17, 'purchase_source_value_complete()', 'daftar_inventory_internal', true, true),
    ('negative_inventory_cost_adjustments', 'negative_inventory_cost_adjustments_value_complete', 5, 'purchase_source_value_complete()',
     'daftar_inventory_internal', true, true),
    ('suppliers', 'suppliers_no_delete', 11, 'suppliers_no_delete()', 'daftar_inventory_internal', true, false),
    ('suppliers', 'suppliers_revision_guard', 19, 'suppliers_revision_guard()', 'daftar_inventory_internal', true, false),
    ('purchase_landed_cost_allocations', 'purchase_allocations_consistent', 5, 'purchase_allocations_consistent()',
     'daftar_inventory_internal', true, true),
    ('negative_inventory_deficits', 'negative_inventory_deficits_coverage_guard', 27, 'negative_inventory_deficits_coverage_guard()',
     'daftar_inventory_internal', true, false),
    ('negative_inventory_deficits', 'negative_inventory_deficits_coverage_consistent', 17, 'negative_inventory_deficits_coverage_consistent()',
     'daftar_inventory_internal', true, true),
    ('journal_entries', 'journal_entries_purchase_complete', 5, 'accounting_purchase_entry_complete()', 'daftar_accounting_internal', true, true),
    ('journal_entries', 'journal_entries_negative_inventory_cost_adjustment_complete', 5,
     'accounting_negative_inventory_cost_adjustment_entry_complete()', 'daftar_accounting_internal', true, true),
    ('accounting_reversals', 'accounting_reversals_20_domain_source_guard', 7, 'accounting_reversals_20_domain_source_guard()',
     'daftar_accounting_internal', true, false)
  )
  SELECT string_agg(e.tg, ', ' ORDER BY e.tg) INTO v_detail
  FROM expected e
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_trigger g
      JOIN pg_proc p ON p.oid = g.tgfoid
      JOIN pg_roles r ON r.oid = p.proowner
     WHERE g.tgrelid = ('public.' || e.tbl)::regclass AND g.tgname = e.tg AND NOT g.tgisinternal
       AND g.tgtype = e.typ AND g.tgenabled = 'O'
       AND g.tgfoid = ('public.' || e.fn)::regprocedure
       AND (g.tgconstraint <> 0 AND g.tgdeferrable AND g.tginitdeferred) = e.deferred
       AND (e.owner IS NULL OR r.rolname = e.owner)
       AND p.prosecdef = e.definer
       AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']);
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'purchase.migration_end_state_invalid: trigger(s) missing or mis-shaped: %', v_detail;
  END IF;
  -- The WHEN filters that keep Budget A and the other source types untouched,
  -- and no other new trigger is conditional.
  IF (SELECT count(*) FROM pg_trigger g
       WHERE g.tgname IN ('journal_entries_purchase_complete', 'journal_entries_negative_inventory_cost_adjustment_complete',
                          'stock_binding_requires_purchase', 'stock_binding_requires_negative_inventory_cost_adjustment')
         AND g.tgqual IS NOT NULL) <> 4
     OR EXISTS (SELECT 1 FROM pg_trigger g
                 WHERE g.tgrelid = ANY (ARRAY['public.suppliers'::regclass, 'public.purchases'::regclass, 'public.purchase_lines'::regclass,
                                              'public.purchase_landed_costs'::regclass, 'public.purchase_landed_cost_allocations'::regclass,
                                              'public.negative_inventory_cost_adjustments'::regclass,
                                              'public.negative_inventory_deficits'::regclass, 'public.negative_deficit_coverages'::regclass])
                   AND NOT g.tgisinternal AND (g.tgqual IS NOT NULL OR cardinality(g.tgattr::int2[]) <> 0)) THEN
    RAISE EXCEPTION 'purchase.migration_end_state_invalid: a P3-S4 trigger lost its WHEN clause, or a document guard gained one';
  END IF;

  -- (8) The FX snapshot read: the internal inventory principal only.
  SELECT array_agg(x.grantee::regrole::text ORDER BY x.grantee::regrole::text) INTO v_actual
  FROM pg_proc p, aclexplode(p.proacl) x
  WHERE p.oid = 'accounting_purchase_fx_rate(uuid,char,timestamptz)'::regprocedure AND x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner;
  IF v_actual IS DISTINCT FROM ARRAY['daftar_inventory_internal'] THEN
    RAISE EXCEPTION 'purchase.migration_end_state_invalid: accounting_purchase_fx_rate must be executable by daftar_inventory_internal only, found %', v_actual;
  END IF;
  IF (SELECT p.provolatile FROM pg_proc p WHERE p.oid = 'accounting_purchase_fx_rate(uuid,char,timestamptz)'::regprocedure) <> 's' THEN
    RAISE EXCEPTION 'purchase.migration_end_state_invalid: accounting_purchase_fx_rate is not STABLE';
  END IF;

  -- (9) The reversal guard names the four domain-owned source types, and
  --     keeps its R-13 opening-balance refusal.
  SELECT p.prosrc INTO v_def FROM pg_proc p WHERE p.oid = 'accounting_reversals_20_domain_source_guard()'::regprocedure;
  IF position('je.source_type IN (''inventory_adjustment'', ''inventory_opening'', ''purchase'', ''negative_inventory_cost_adjustment'')' IN v_def) = 0
     OR position('FROM accounting_opening_balances ob' IN v_def) = 0 OR position('FOR NO KEY UPDATE' IN v_def) = 0
     OR position('accounting.opening_balance_inventory_bound:' IN v_def) = 0 THEN
    RAISE EXCEPTION 'purchase.migration_end_state_invalid: the reversal guard does not refuse the four domain-owned source types';
  END IF;

  -- (10) Neither internal principal keeps CREATE on public, and no role
  --      gained an attribute; nothing can reach the new tables yet.
  IF has_schema_privilege('daftar_inventory_internal', 'public', 'CREATE')
     OR has_schema_privilege('daftar_accounting_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'purchase.migration_end_state_invalid: an internal principal still holds CREATE on schema public';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('daftar_inventory_internal', 'daftar_accounting_internal')
               AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolinherit)) THEN
    RAISE EXCEPTION 'purchase.migration_end_state_invalid: an internal principal is no longer an unreachable NOLOGIN NOINHERIT role';
  END IF;
  IF EXISTS (SELECT 1 FROM inventory_operation_kinds k WHERE k.op_code LIKE 'supplier.%' OR k.op_code LIKE 'purchase.%')
     OR EXISTS (SELECT 1 FROM inventory_operation_movement_kinds m WHERE m.movement_kind IN ('purchase', 'negative_inventory_cost_adjustment')) THEN
    RAISE EXCEPTION 'purchase.migration_end_state_invalid: an S4 operation kind or mapping exists before its routine (0064)';
  END IF;
END $$;

COMMENT ON TABLE suppliers IS
  'P3-S4 A-04/A-11. A supplier: active ⇄ inactive, never deleted; every change is one revision. Documents keep their own snapshot at receipt.';
COMMENT ON TABLE purchases IS
  'P3-S4 A-04. draft → received | cancelled; terminal states immutable. A received purchase posts Dr Inventory / Cr Accounts Payable for its total; tax_minor is physically zero (OD-03).';
COMMENT ON TABLE purchase_lines IS
  'P3-S4 A-13. One variant per line; the base share and unit cost are written once, by the receipt; a received line owns exactly one purchase movement.';
COMMENT ON TABLE purchase_landed_costs IS
  'P3-S4 A-13. A landed cost in the purchase currency, allocated by value or manually; replaced with its draft, never changed.';
COMMENT ON TABLE purchase_landed_cost_allocations IS
  'P3-S4 A-13, A-15(h). One landed cost''s amount on one line; per cost the allocations sum to its amount exactly.';
COMMENT ON TABLE negative_inventory_cost_adjustments IS
  'P3-S4 A-16. The coverage header of one receipt, insert-only; total_value_base_minor = Σ its coverage movement values; binding_source_id = id exactly when a catch-up entry is owed.';
