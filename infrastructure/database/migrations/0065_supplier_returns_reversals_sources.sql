-- 0065_supplier_returns_reversals_sources.sql
-- P3-S5, part 1 — the SOURCE side of supplier returns, supplier credit
-- notes and purchase reversals: two candidate keys on S4 tables; the five
-- document tables and the two bridges; every stock-side guard; the owner
-- replacement of the stock primitive (R-B1a); the replaced source-guard
-- discovery; the two stock source registrations; the accounting-side objects
-- (the supplier-return completeness trigger, the owner-replaced reversal
-- guard, the purchase entry read) and the one accounting registration
-- (docs/PHASE_3_S5_CONTRACT.md §2.1-§2.4, §2.7, §2.8, A-04, A-05, A-09-A-15,
-- A-18; Tech Lead rulings R-B1a and R-B2a).
--
-- ── What this file does NOT do ──────────────────────────────────────────
--
-- It registers no inventory operation kind and no op→movement mapping, so
-- after it no signed command can reach a single new table or write a
-- `supplier_return` or `purchase_reversal` movement: the runtime reach is
-- 0066's, and only 0066's. `purchase_reversal` is registered as a STOCK
-- source type only (R-B2a): its accounting fact is a Phase 2 `reversal`.
-- Nothing here carries or computes an element OD-03 reserves (A-14).
--
-- ── Header rules (§2.1) ─────────────────────────────────────────────────
--
--   R-34 THE GLOBAL LOCK ORDER, extended (never reordered) from 0063 R-15.
--        Every S5 path skips the steps it has no use for:
--          1  assertion consume                           (no lock)
--          2  the per-document advisory key               ('daftar.supplier_return_id' |
--                                                          'daftar.purchase_id')
--          2a the purchase row FOR UPDATE                 (both commands)
--          2b the supplier row FOR SHARE                  (purchase.return only)
--          3-5 (not used by S5)
--          6  stock targets (shared 'daftar.stock_target' advisory),
--             products FOR SHARE (id order), stock keys FOR UPDATE
--             ((warehouse, variant) order)
--          7  accounting_post_entry ('supplier_return') |
--             accounting_post_reversal (the purchase entry)
--        A return takes its own key and then the purchase row; a reversal
--        and a receipt take the purchase key and then the row. No path takes
--        a return key after the purchase row, so 2/2a form no cycle with
--        R-15. Step 7's reversal holds `businesses` FOR SHARE before the
--        reversal guard's R-13 row lock, unchanged.
--   R-35 CARRYING VALUE AND AP (A-10). Per returned line
--        carrying_i = HALF_EVEN(t_i·(Q_i+q_i), qty_i) − HALF_EVEN(t_i·Q_i, qty_i)
--        (cumulative: never negative, exact at a full return; t_i = net +
--        landed, TL-11). AP first at purchase level (TL-10): ap = min(C, O),
--        credit = C − ap, O = purchase_ap_outstanding (0066). The base
--        release is cumulative and proportional, exact at clearing:
--        ap_base = HALF_EVEN(B·(X+ap), T) − HALF_EVEN(B·X, T), X = T − O; the
--        entry's AP line carries convert(ap) (the 0043 law) and a base-only
--        dust line carries ap_base − convert(ap) (TL-3). I is the stored
--        movement values at the return key's average (or the depletion
--        flush); ppv = ap_base + credit_base − I.
--   R-36 THE DERIVED `reversed` STATE (A-04, TL-2). A purchase is reversed
--        iff a `purchase_reversals` row exists for it (its id IS the
--        purchase id). `purchases` is never updated by S5, so every S4 guard
--        and every recorded S3/S4 body digest stays byte-identical.
--   R-37 THE REVERSAL VALUE RULE (B-1, R-B1a). `inventory_apply_stock_movements`
--        is replaced BY ITS OWNER with one new branch: a `purchase_reversal`
--        movement carries exactly the negation of the stored value of its
--        paired `purchase` movement (same source_id / source_line_id), with
--        that movement's snapshot, and is refused
--        `inventory.reversal_valuation_residue` when removing that value
--        would leave on_hand = 0 with a non-zero valuation or a positive
--        on_hand with a negative one (TL-8). Every other kind keeps the 0060
--        behaviour byte for byte.
--   R-38 THE REVERSAL GUARD (A-15(b), R-B2a). `accounting_reversals_20_domain_source_guard`
--        is replaced BY ITS OWNER: `supplier_return` joins the always-refused
--        domain types, and a `purchase` entry is admitted only when the
--        paired `purchase_reversals` row (id = the entry's source id,
--        original_entry_id = the reversed entry) already exists in this
--        transaction. The R-13 opening-balance block is kept verbatim.
--
-- ── The 0063 review hardenings, carried forward to every S5 table ───────
--
--   0063 R-34 (guards judge INSERT): every S5 table is insert-only and every
--        insert is judged — the deferred completeness, value and quantity
--        guards are AFTER INSERT, and each DETAIL table (return lines,
--        credit notes, reversal lines) also carries a BEFORE INSERT
--        same-transaction guard (0063 R-36, below).
--   0063 R-35 (the internal principal writes only in its scope): the
--        restrictive business isolation of every S5 table and bridge is one
--        policy per command; only `business_isolation_read` admits a
--        principal by name.
--   0063 R-36 (a detail is written only with its header): a return line or
--        credit note joins only a return, and a reversal line only a
--        reversal, created by this very transaction (the insert-only
--        header's created_at is this transaction's now() AND its
--        business_transaction_id this transaction's trace).
--   0063 R-37 (fail closed): no S5 guard exempts anything on a session GUC.
--   0063 R-38 (the discovery sees every guard): the S5 rows of
--        `inventory_stock_source_guard_gaps()` include the three
--        same-transaction triggers (`line_same_transaction` for each type,
--        `credit_note_same_transaction` for a return), and the eleven S5
--        guard function bodies are recorded as digests: the nine of §2.3
--        and the two same-transaction functions.
--   0063 R-40 (probes as a non-superuser): every 0065-E probe that
--        re-creates a trigger on an internal function lends the function's
--        owner TRIGGER on the table inside the rolled-back probe; a probe
--        that replaces a body lends CREATE on public the same way.
--   0063 R-41 (no new unclassified code): every S5 guard raises a code of
--        the contract's §3.
--
-- ── Engineering rulings taken here (documented for the report) ──────────
--
--   R-42 The purchase-line candidate key of §2.1(2) is named
--        `purchase_lines_line_variant_uq`: `purchase_lines_variant_uq`
--        already names 0063's (business_id, purchase_id, variant_id) key.
--   R-43 `supplier_returns.ap_released_before_txn_minor` stores X = T − O,
--        the txn AP the purchase had released before this return (A-10(d)).
--        It makes the base release verifiable at COMMIT without re-deriving
--        O: O is an S6 extension point (A-16), and a settlement fixture may
--        replace it inside a test database, so no guard may recompute it
--        from the other returns. The value guard requires
--        ap_base = HALF_EVEN(B·(X+ap), T) − HALF_EVEN(B·X, T) and X + ap ≤ T.
--   R-44 The purchase-reversal header guard also requires
--        `original_entry_id = accounting_purchase_entry_id(business, purchase)`
--        (A-15(c)), so a reversal row can pair only with its own purchase's
--        entry.
--   R-45 `accounting_purchase_entry_id` takes no scope check: it returns one
--        id, is executable only by the NOLOGIN internal inventory principal,
--        and is read by a COMMIT-time guard that must not depend on session
--        GUCs (0063 R-37).
--   R-46 The completeness check of a return entry pins every line's FX: an
--        AP or supplier-receivable line (A-10(g) lines 1, 3) carries the
--        purchase's stored snapshot — its currency, rate, rate_source and
--        rate_timestamp, a domestic purchase included; a base line (the AP
--        dust, inventory, PPV) carries rate 1, source 'base', txn = base, at
--        the return's document_date 00:00 UTC (the S3 domestic line).
--   R-47 Every S5 amount column is bounded by ±10^18, as every S4 amount.
--
-- Migrations 0000-0064 are FROZEN and untouched.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The two candidate keys on S4 tables (§2.1(2)). Both validate against
--    existing rows; neither adds a guard or a column.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE purchases ADD CONSTRAINT purchases_supplier_uq UNIQUE (business_id, id, supplier_id);
ALTER TABLE purchase_lines ADD CONSTRAINT purchase_lines_line_variant_uq UNIQUE (business_id, purchase_id, id, variant_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The five tables (§2.2, A-04, A-10, A-11).
--
-- Money is BIGINT minor units, rates NUMERIC(20,10), quantities
-- NUMERIC(18,4), costs NUMERIC(28,10). Every table is insert-only.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE supplier_returns (
  tenant_id                    UUID NOT NULL,
  business_id                  UUID NOT NULL,
  id                           UUID NOT NULL,
  purchase_id                  UUID NOT NULL,
  supplier_id                  UUID NOT NULL,
  warehouse_id                 UUID NOT NULL,
  currency_code                CHAR(3) NOT NULL,
  source_to_base_rate          NUMERIC(20,10) NOT NULL,
  document_date                DATE NOT NULL,
  reason                       TEXT CHECK (reason IS NULL OR (char_length(reason) BETWEEN 1 AND 500 AND reason = btrim(reason))),
  credit_note_id               UUID,
  carrying_txn_minor           BIGINT NOT NULL CHECK (carrying_txn_minor BETWEEN 0 AND 1000000000000000000),
  ap_txn_minor                 BIGINT NOT NULL CHECK (ap_txn_minor BETWEEN 0 AND 1000000000000000000),
  ap_base_minor                BIGINT NOT NULL CHECK (ap_base_minor BETWEEN 0 AND 1000000000000000000),
  ap_dust_base_minor           BIGINT NOT NULL CHECK (ap_dust_base_minor BETWEEN -1000000000000000000 AND 1000000000000000000),
  ap_released_before_txn_minor BIGINT NOT NULL CHECK (ap_released_before_txn_minor BETWEEN 0 AND 1000000000000000000),
  credit_txn_minor             BIGINT NOT NULL CHECK (credit_txn_minor BETWEEN 0 AND 1000000000000000000),
  credit_base_minor            BIGINT NOT NULL CHECK (credit_base_minor BETWEEN 0 AND 1000000000000000000),
  inventory_value_base_minor   BIGINT NOT NULL CHECK (inventory_value_base_minor BETWEEN 0 AND 1000000000000000000),
  ppv_base_minor               BIGINT NOT NULL CHECK (ppv_base_minor BETWEEN -1000000000000000000 AND 1000000000000000000),
  intent_sha256                TEXT NOT NULL CHECK (intent_sha256 ~ '^[0-9a-f]{64}$'),
  business_transaction_id      UUID NOT NULL,
  created_by                   UUID NOT NULL REFERENCES users (id),
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  accounting_source_type       TEXT NOT NULL GENERATED ALWAYS AS ('supplier_return') STORED,
  binding_source_id            UUID NOT NULL,
  PRIMARY KEY (business_id, id),
  CONSTRAINT supplier_returns_purchase_uq UNIQUE (business_id, id, purchase_id),
  CONSTRAINT supplier_returns_credit_note_uq UNIQUE (business_id, id, credit_note_id),
  CONSTRAINT supplier_returns_carrying_ck CHECK (carrying_txn_minor = ap_txn_minor + credit_txn_minor),
  CONSTRAINT supplier_returns_credit_base_ck CHECK ((credit_txn_minor = 0) = (credit_base_minor = 0)),
  CONSTRAINT supplier_returns_credit_note_ck CHECK ((credit_txn_minor = 0) = (credit_note_id IS NULL)),
  CONSTRAINT supplier_returns_ppv_ck CHECK (ppv_base_minor = ap_base_minor + credit_base_minor - inventory_value_base_minor),
  CONSTRAINT supplier_returns_value_zero_ck CHECK (NOT (carrying_txn_minor = 0 AND inventory_value_base_minor = 0)),
  CONSTRAINT supplier_returns_rate_ck CHECK (source_to_base_rate > 0 AND source_to_base_rate = trunc(source_to_base_rate, 10)),
  CONSTRAINT supplier_returns_binding_identity_ck CHECK (binding_source_id = id),
  CONSTRAINT supplier_returns_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT supplier_returns_purchase_fk
    FOREIGN KEY (business_id, purchase_id, supplier_id) REFERENCES purchases (business_id, id, supplier_id) ON DELETE RESTRICT,
  CONSTRAINT supplier_returns_warehouse_fk FOREIGN KEY (business_id, warehouse_id) REFERENCES warehouses (business_id, id),
  CONSTRAINT supplier_returns_currency_fk FOREIGN KEY (currency_code) REFERENCES currencies (code),
  CONSTRAINT supplier_returns_binding_fk
    FOREIGN KEY (business_id, accounting_source_type, binding_source_id)
    REFERENCES accounting_source_bindings (business_id, source_type, source_id)
    DEFERRABLE INITIALLY DEFERRED
);
REVOKE ALL ON supplier_returns FROM PUBLIC;

-- The quantity bound and the reversal precondition walk a purchase's returns.
CREATE INDEX supplier_returns_purchase_idx ON supplier_returns (business_id, purchase_id);

CREATE TABLE supplier_return_lines (
  tenant_id            UUID NOT NULL,
  business_id          UUID NOT NULL,
  return_id            UUID NOT NULL,
  id                   UUID NOT NULL,
  line_no              INTEGER NOT NULL CHECK (line_no > 0),
  purchase_id          UUID NOT NULL,
  purchase_line_id     UUID NOT NULL,
  variant_id           UUID NOT NULL,
  qty                  NUMERIC(18,4) NOT NULL CHECK (qty > 0 AND qty < 10000000000),
  carrying_txn_minor   BIGINT NOT NULL CHECK (carrying_txn_minor BETWEEN 0 AND 1000000000000000000),
  unit_cost_base_minor NUMERIC(28,10) NOT NULL CHECK (unit_cost_base_minor >= 0),
  value_out_base_minor BIGINT NOT NULL CHECK (value_out_base_minor BETWEEN 0 AND 1000000000000000000),
  PRIMARY KEY (business_id, id),
  CONSTRAINT supplier_return_lines_bridge_uq UNIQUE (business_id, return_id, id),
  CONSTRAINT supplier_return_lines_line_no_uq UNIQUE (business_id, return_id, line_no),
  CONSTRAINT supplier_return_lines_purchase_line_uq UNIQUE (business_id, return_id, purchase_line_id),
  CONSTRAINT supplier_return_lines_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT supplier_return_lines_header_fk
    FOREIGN KEY (business_id, return_id, purchase_id) REFERENCES supplier_returns (business_id, id, purchase_id) ON DELETE RESTRICT,
  CONSTRAINT supplier_return_lines_purchase_line_fk
    FOREIGN KEY (business_id, purchase_id, purchase_line_id, variant_id)
    REFERENCES purchase_lines (business_id, purchase_id, id, variant_id) ON DELETE RESTRICT
);
REVOKE ALL ON supplier_return_lines FROM PUBLIC;

-- Σ returned per purchase line (PM-13) and the reversal precondition (c).
CREATE INDEX supplier_return_lines_purchase_line_idx ON supplier_return_lines (business_id, purchase_id, purchase_line_id);

CREATE TABLE supplier_credit_notes (
  tenant_id                            UUID NOT NULL,
  business_id                          UUID NOT NULL,
  id                                   UUID NOT NULL,
  supplier_id                          UUID NOT NULL,
  supplier_return_id                   UUID NOT NULL,
  currency_code                        CHAR(3) NOT NULL,
  original_amount_minor                BIGINT NOT NULL CHECK (original_amount_minor BETWEEN 1 AND 1000000000000000000),
  remaining_amount_minor               BIGINT NOT NULL,
  original_carrying_base_amount_minor  BIGINT NOT NULL CHECK (original_carrying_base_amount_minor BETWEEN 1 AND 1000000000000000000),
  remaining_carrying_base_amount_minor BIGINT NOT NULL,
  source_to_base_rate                  NUMERIC(20,10) NOT NULL CHECK (source_to_base_rate > 0 AND source_to_base_rate = trunc(source_to_base_rate, 10)),
  rate_source                          TEXT NOT NULL CHECK (rate_source IN ('base', 'manual')),
  rate_timestamp                       TIMESTAMPTZ NOT NULL,
  issued_on                            DATE NOT NULL,
  business_transaction_id              UUID NOT NULL,
  created_by                           UUID NOT NULL REFERENCES users (id),
  created_at                           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  CONSTRAINT supplier_credit_notes_return_uq UNIQUE (business_id, supplier_return_id),
  CONSTRAINT supplier_credit_notes_remaining_ck CHECK (remaining_amount_minor BETWEEN 0 AND original_amount_minor),
  CONSTRAINT supplier_credit_notes_remaining_base_ck
    CHECK (remaining_carrying_base_amount_minor BETWEEN 0 AND original_carrying_base_amount_minor),
  CONSTRAINT supplier_credit_notes_zero_together_ck CHECK ((remaining_amount_minor = 0) = (remaining_carrying_base_amount_minor = 0)),
  CONSTRAINT supplier_credit_notes_rate_timestamp_ck CHECK (rate_timestamp = date_trunc('second', rate_timestamp)),
  CONSTRAINT supplier_credit_notes_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT supplier_credit_notes_return_fk
    FOREIGN KEY (business_id, supplier_return_id, id) REFERENCES supplier_returns (business_id, id, credit_note_id) ON DELETE RESTRICT,
  CONSTRAINT supplier_credit_notes_supplier_fk FOREIGN KEY (business_id, supplier_id) REFERENCES suppliers (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT supplier_credit_notes_currency_fk FOREIGN KEY (currency_code) REFERENCES currencies (code)
);
REVOKE ALL ON supplier_credit_notes FROM PUBLIC;

-- A supplier's credit notes (the A-19 read).
CREATE INDEX supplier_credit_notes_supplier_idx ON supplier_credit_notes (business_id, supplier_id);

-- The header's credit note, closed at COMMIT (the header is written first).
ALTER TABLE supplier_returns ADD CONSTRAINT supplier_returns_credit_note_fk
  FOREIGN KEY (business_id, credit_note_id) REFERENCES supplier_credit_notes (business_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE purchase_reversals (
  tenant_id               UUID NOT NULL,
  business_id             UUID NOT NULL,
  id                      UUID NOT NULL,
  purchase_id             UUID NOT NULL,
  warehouse_id            UUID NOT NULL,
  original_entry_id       UUID NOT NULL,
  reversal_date           DATE NOT NULL,
  reason                  TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500 AND reason = btrim(reason)),
  total_value_base_minor  BIGINT NOT NULL CHECK (total_value_base_minor BETWEEN 1 AND 1000000000000000000),
  intent_sha256           TEXT NOT NULL CHECK (intent_sha256 ~ '^[0-9a-f]{64}$'),
  business_transaction_id UUID NOT NULL,
  created_by              UUID NOT NULL REFERENCES users (id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  accounting_source_type  TEXT NOT NULL GENERATED ALWAYS AS ('reversal') STORED,
  binding_source_id       UUID NOT NULL,
  PRIMARY KEY (business_id, id),
  CONSTRAINT purchase_reversals_identity_ck CHECK (id = purchase_id),
  CONSTRAINT purchase_reversals_original_entry_uq UNIQUE (business_id, original_entry_id),
  CONSTRAINT purchase_reversals_binding_identity_ck CHECK (binding_source_id = original_entry_id),
  CONSTRAINT purchase_reversals_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT purchase_reversals_purchase_fk
    FOREIGN KEY (business_id, purchase_id, warehouse_id) REFERENCES purchases (business_id, id, warehouse_id) ON DELETE RESTRICT,
  CONSTRAINT purchase_reversals_binding_fk
    FOREIGN KEY (business_id, accounting_source_type, binding_source_id)
    REFERENCES accounting_source_bindings (business_id, source_type, source_id)
    DEFERRABLE INITIALLY DEFERRED
);
REVOKE ALL ON purchase_reversals FROM PUBLIC;

CREATE TABLE purchase_reversal_lines (
  tenant_id            UUID NOT NULL,
  business_id          UUID NOT NULL,
  reversal_id          UUID NOT NULL,
  id                   UUID NOT NULL,
  purchase_id          UUID NOT NULL,
  variant_id           UUID NOT NULL,
  qty                  NUMERIC(18,4) NOT NULL CHECK (qty > 0 AND qty < 10000000000),
  unit_cost_base_minor NUMERIC(28,10) NOT NULL CHECK (unit_cost_base_minor >= 0),
  value_base_minor     BIGINT NOT NULL CHECK (value_base_minor BETWEEN 0 AND 1000000000000000000),
  PRIMARY KEY (business_id, id),
  CONSTRAINT purchase_reversal_lines_identity_ck CHECK (reversal_id = purchase_id),
  CONSTRAINT purchase_reversal_lines_bridge_uq UNIQUE (business_id, reversal_id, id),
  CONSTRAINT purchase_reversal_lines_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT purchase_reversal_lines_header_fk
    FOREIGN KEY (business_id, reversal_id) REFERENCES purchase_reversals (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT purchase_reversal_lines_purchase_line_fk
    FOREIGN KEY (business_id, purchase_id, id, variant_id)
    REFERENCES purchase_lines (business_id, purchase_id, id, variant_id) ON DELETE RESTRICT
);
REVOKE ALL ON purchase_reversal_lines FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. The two bridges (§2.2): exactly the S4C A-15(a) template.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE stock_source_bridge_supplier_return (
  business_id    UUID NOT NULL,
  source_id      UUID NOT NULL,
  source_line_id UUID NOT NULL,
  movement_kind  TEXT NOT NULL,
  source_type    TEXT NOT NULL GENERATED ALWAYS AS ('supplier_return') STORED,
  PRIMARY KEY (business_id, source_id, source_line_id, movement_kind),
  CONSTRAINT stock_source_bridge_supplier_return_line_fk
    FOREIGN KEY (business_id, source_id, source_line_id)
    REFERENCES supplier_return_lines (business_id, return_id, id) ON DELETE RESTRICT,
  CONSTRAINT stock_source_bridge_supplier_return_binding_fk
    FOREIGN KEY (business_id, source_type, source_id, source_line_id, movement_kind)
    REFERENCES stock_source_bindings (business_id, source_type, source_id, source_line_id, movement_kind) ON DELETE RESTRICT
);
REVOKE ALL ON stock_source_bridge_supplier_return FROM PUBLIC;

CREATE TABLE stock_source_bridge_purchase_reversal (
  business_id    UUID NOT NULL,
  source_id      UUID NOT NULL,
  source_line_id UUID NOT NULL,
  movement_kind  TEXT NOT NULL,
  source_type    TEXT NOT NULL GENERATED ALWAYS AS ('purchase_reversal') STORED,
  PRIMARY KEY (business_id, source_id, source_line_id, movement_kind),
  CONSTRAINT stock_source_bridge_purchase_reversal_line_fk
    FOREIGN KEY (business_id, source_id, source_line_id)
    REFERENCES purchase_reversal_lines (business_id, reversal_id, id) ON DELETE RESTRICT,
  CONSTRAINT stock_source_bridge_purchase_reversal_binding_fk
    FOREIGN KEY (business_id, source_type, source_id, source_line_id, movement_kind)
    REFERENCES stock_source_bindings (business_id, source_type, source_id, source_line_id, movement_kind) ON DELETE RESTRICT
);
REVOKE ALL ON stock_source_bridge_purchase_reversal FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Row security and grants (§2.7, A-15(d), A-18).
--
-- The 0063 R-35 layering: a tenant policy through the businesses subquery;
-- a restrictive business isolation, one policy per command, where only the
-- FOR SELECT one admits the internal principals (the accounting principal
-- on the two posting headers it judges); permissive FOR SELECT admissions
-- for the principals whose guards read these rows.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE supplier_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_returns FORCE ROW LEVEL SECURITY;
ALTER TABLE supplier_return_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_return_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE supplier_credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_credit_notes FORCE ROW LEVEL SECURITY;
ALTER TABLE purchase_reversals ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_reversals FORCE ROW LEVEL SECURITY;
ALTER TABLE purchase_reversal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_reversal_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_source_bridge_supplier_return ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_source_bridge_supplier_return FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_source_bridge_purchase_reversal ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_source_bridge_purchase_reversal FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_membership ON supplier_returns
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = supplier_returns.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = supplier_returns.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON supplier_returns AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal') OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON supplier_returns AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON supplier_returns AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON supplier_returns AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON supplier_returns
  FOR SELECT TO daftar_inventory_internal USING (true);
CREATE POLICY accounting_validator ON supplier_returns
  FOR SELECT TO daftar_accounting_internal USING (true);

CREATE POLICY tenant_membership ON supplier_return_lines
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = supplier_return_lines.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = supplier_return_lines.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON supplier_return_lines AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON supplier_return_lines AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON supplier_return_lines AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON supplier_return_lines AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON supplier_return_lines
  FOR SELECT TO daftar_inventory_internal USING (true);

CREATE POLICY tenant_membership ON supplier_credit_notes
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = supplier_credit_notes.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = supplier_credit_notes.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON supplier_credit_notes AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON supplier_credit_notes AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON supplier_credit_notes AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON supplier_credit_notes AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON supplier_credit_notes
  FOR SELECT TO daftar_inventory_internal USING (true);

CREATE POLICY tenant_membership ON purchase_reversals
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = purchase_reversals.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = purchase_reversals.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON purchase_reversals AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal') OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON purchase_reversals AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON purchase_reversals AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON purchase_reversals AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON purchase_reversals
  FOR SELECT TO daftar_inventory_internal USING (true);
CREATE POLICY accounting_validator ON purchase_reversals
  FOR SELECT TO daftar_accounting_internal USING (true);

CREATE POLICY tenant_membership ON purchase_reversal_lines
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = purchase_reversal_lines.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = purchase_reversal_lines.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON purchase_reversal_lines AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON purchase_reversal_lines AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON purchase_reversal_lines AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON purchase_reversal_lines AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON purchase_reversal_lines
  FOR SELECT TO daftar_inventory_internal USING (true);

CREATE POLICY tenant_membership ON stock_source_bridge_supplier_return
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = stock_source_bridge_supplier_return.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = stock_source_bridge_supplier_return.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON stock_source_bridge_supplier_return AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON stock_source_bridge_supplier_return AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON stock_source_bridge_supplier_return AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON stock_source_bridge_supplier_return AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON stock_source_bridge_supplier_return
  FOR SELECT TO daftar_inventory_internal USING (true);

CREATE POLICY tenant_membership ON stock_source_bridge_purchase_reversal
  USING      (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = stock_source_bridge_purchase_reversal.business_id) = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR (SELECT b.tenant_id FROM businesses b WHERE b.id = stock_source_bridge_purchase_reversal.business_id) = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON stock_source_bridge_purchase_reversal AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON stock_source_bridge_purchase_reversal AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON stock_source_bridge_purchase_reversal AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON stock_source_bridge_purchase_reversal AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY inventory_internal_read ON stock_source_bridge_purchase_reversal
  FOR SELECT TO daftar_inventory_internal USING (true);

-- A-18. daftar_app reads the five documents (the A-07 bound read and the
-- replay/read models) and holds no DML; the internal principal inserts and
-- reads the five documents and the two bridges and never updates or deletes
-- them; the accounting principal reads the two posting headers (A-15(d)).
GRANT SELECT ON supplier_returns, supplier_return_lines, supplier_credit_notes, purchase_reversals, purchase_reversal_lines
  TO daftar_app;
GRANT SELECT, INSERT ON supplier_returns, supplier_return_lines, supplier_credit_notes, purchase_reversals, purchase_reversal_lines,
                        stock_source_bridge_supplier_return, stock_source_bridge_purchase_reversal
  TO daftar_inventory_internal;
GRANT SELECT ON supplier_returns, purchase_reversals TO daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Stock-side guard functions and triggers (§2.3, A-11(e), A-12).
--    Created while the migrator owns them; PUBLIC revoked and triggers
--    installed; then handed to the internal principal inside the CREATE
--    bracket (the S2/S3/S4 order). The primitive's owner replacement (§2.4,
--    section 6) is issued inside the same bracket.
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;

-- Binding → bridge, at COMMIT, one function per source type.
CREATE OR REPLACE FUNCTION stock_binding_requires_supplier_return() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM stock_source_bridge_supplier_return b
                  WHERE b.business_id = NEW.business_id AND b.source_id = NEW.source_id
                    AND b.source_line_id = NEW.source_line_id AND b.movement_kind = NEW.movement_kind) THEN
    RAISE EXCEPTION 'inventory.stock_source_line_missing: a supplier-return stock binding has no source line' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION stock_binding_requires_purchase_reversal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM stock_source_bridge_purchase_reversal b
                  WHERE b.business_id = NEW.business_id AND b.source_id = NEW.source_id
                    AND b.source_line_id = NEW.source_line_id AND b.movement_kind = NEW.movement_kind) THEN
    RAISE EXCEPTION 'inventory.stock_source_line_missing: a purchase-reversal stock binding has no source line' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- Line → its one movement, at COMMIT: the header warehouse, the line
-- variant, the negated quantity, the negated value out and the average
-- snapshot the line stores (found THROUGH the bridge).
CREATE OR REPLACE FUNCTION stock_source_complete_supplier_return() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_wh  UUID;
  v_all INTEGER;
  v_ok  INTEGER;
BEGIN
  SELECT r.warehouse_id INTO v_wh FROM supplier_returns r WHERE r.business_id = NEW.business_id AND r.id = NEW.return_id;
  SELECT count(*),
         count(*) FILTER (WHERE m.movement_kind = 'supplier_return' AND m.warehouse_id = v_wh AND m.variant_id = NEW.variant_id
                            AND m.qty_delta = -NEW.qty AND m.value_delta_base_minor = -NEW.value_out_base_minor
                            AND m.unit_cost_base_minor = NEW.unit_cost_base_minor)
    INTO v_all, v_ok
  FROM stock_source_bridge_supplier_return b
  JOIN stock_movements m ON m.business_id = b.business_id AND m.source_type = b.source_type AND m.source_id = b.source_id
                        AND m.source_line_id = b.source_line_id AND m.movement_kind = b.movement_kind
  WHERE b.business_id = NEW.business_id AND b.source_id = NEW.return_id AND b.source_line_id = NEW.id;
  IF v_wh IS NULL OR v_all <> 1 OR v_ok <> 1 THEN
    RAISE EXCEPTION 'inventory.source_movement_set_incomplete: a returned line needs exactly its one supplier_return movement' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- The header twin: at least one line; the purchase received, not reversed,
-- in the header's currency and rate; the credit note exactly iff a credit,
-- with the A-11(c) values.
CREATE OR REPLACE FUNCTION stock_source_complete_supplier_return_header() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_p     RECORD;
  v_lines INTEGER;
  v_notes INTEGER;
  v_good  INTEGER;
BEGIN
  SELECT count(*) INTO v_lines FROM supplier_return_lines l WHERE l.business_id = NEW.business_id AND l.return_id = NEW.id;
  IF v_lines = 0 THEN
    RAISE EXCEPTION 'inventory.source_movement_set_incomplete: a supplier return carries at least one line' USING ERRCODE = 'P0001';
  END IF;
  SELECT p.status, p.supplier_id, p.currency_code, p.source_to_base_rate, p.rate_source, p.rate_timestamp INTO v_p
  FROM purchases p WHERE p.business_id = NEW.business_id AND p.id = NEW.purchase_id;
  IF v_p.status IS DISTINCT FROM 'received' THEN
    RAISE EXCEPTION 'supplier_return.purchase_state_invalid: only a received purchase is returned to its supplier' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM purchase_reversals r WHERE r.business_id = NEW.business_id AND r.id = NEW.purchase_id) THEN
    RAISE EXCEPTION 'supplier_return.purchase_reversed: a reversed purchase takes no return' USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*),
         count(*) FILTER (WHERE n.id = NEW.credit_note_id AND n.supplier_id = NEW.supplier_id AND n.supplier_id = v_p.supplier_id
                            AND n.currency_code = NEW.currency_code
                            AND n.original_amount_minor = NEW.credit_txn_minor AND n.remaining_amount_minor = NEW.credit_txn_minor
                            AND n.original_carrying_base_amount_minor = NEW.credit_base_minor
                            AND n.remaining_carrying_base_amount_minor = NEW.credit_base_minor
                            AND n.source_to_base_rate = v_p.source_to_base_rate AND n.rate_source = v_p.rate_source
                            AND n.rate_timestamp = v_p.rate_timestamp AND n.issued_on = NEW.document_date)
    INTO v_notes, v_good
  FROM supplier_credit_notes n WHERE n.business_id = NEW.business_id AND n.supplier_return_id = NEW.id;
  IF NEW.currency_code IS DISTINCT FROM v_p.currency_code OR NEW.source_to_base_rate IS DISTINCT FROM v_p.source_to_base_rate
     OR NEW.supplier_id IS DISTINCT FROM v_p.supplier_id
     OR (NEW.credit_txn_minor > 0 AND (v_notes <> 1 OR v_good <> 1))
     OR (NEW.credit_txn_minor = 0 AND v_notes <> 0) THEN
    RAISE EXCEPTION 'inventory.source_value_mismatch: a supplier return does not carry exactly its purchase snapshot and its credit note' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- The header value, at COMMIT (A-10, R-35, R-43): Σ carrying; Σ value out
-- = −Σ bridged movement values; AP first against the txn AP released
-- before the return; the cumulative base release; the conversions and the
-- dust, recomputed from the purchase snapshot.
CREATE OR REPLACE FUNCTION supplier_return_value_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_p        RECORD;
  v_base_ccy TEXT;
  v_et       INTEGER;
  v_eb       INTEGER;
  v_carrying NUMERIC;
  v_out      NUMERIC;
  v_moved    NUMERIC;
  v_x        NUMERIC;
  v_ap_base  NUMERIC;
  v_ap_conv  NUMERIC;
  v_cr_conv  NUMERIC;
BEGIN
  SELECT coalesce(sum(l.carrying_txn_minor), 0), coalesce(sum(l.value_out_base_minor), 0) INTO v_carrying, v_out
  FROM supplier_return_lines l WHERE l.business_id = NEW.business_id AND l.return_id = NEW.id;
  SELECT coalesce(sum(m.value_delta_base_minor), 0) INTO v_moved
  FROM stock_source_bridge_supplier_return b
  JOIN stock_movements m ON m.business_id = b.business_id AND m.source_type = b.source_type AND m.source_id = b.source_id
                        AND m.source_line_id = b.source_line_id AND m.movement_kind = b.movement_kind
  WHERE b.business_id = NEW.business_id AND b.source_id = NEW.id;
  SELECT p.total_txn_minor, p.total_base_minor, p.source_to_base_rate, p.currency_code INTO v_p
  FROM purchases p WHERE p.business_id = NEW.business_id AND p.id = NEW.purchase_id;
  SELECT b.base_currency INTO v_base_ccy FROM businesses b WHERE b.id = NEW.business_id;
  SELECT c.minor_units INTO v_et FROM currencies c WHERE c.code = v_p.currency_code::text;
  SELECT c.minor_units INTO v_eb FROM currencies c WHERE c.code = v_base_ccy;
  IF v_p.total_txn_minor IS NULL OR v_p.total_base_minor IS NULL OR v_p.total_txn_minor <= 0 OR v_et IS NULL OR v_eb IS NULL THEN
    RAISE EXCEPTION 'inventory.source_value_mismatch: a supplier return needs its received purchase totals' USING ERRCODE = 'P0001';
  END IF;
  v_x       := NEW.ap_released_before_txn_minor;
  v_ap_base := inventory_half_even(v_p.total_base_minor::numeric * (v_x + NEW.ap_txn_minor), v_p.total_txn_minor, 0)
               - inventory_half_even(v_p.total_base_minor::numeric * v_x, v_p.total_txn_minor, 0);
  v_ap_conv := inventory_half_even(NEW.ap_txn_minor::numeric * v_p.source_to_base_rate * power(10::numeric, greatest(0, v_eb - v_et)),
                                   power(10::numeric, greatest(0, v_et - v_eb)), 0);
  v_cr_conv := inventory_half_even(NEW.credit_txn_minor::numeric * v_p.source_to_base_rate * power(10::numeric, greatest(0, v_eb - v_et)),
                                   power(10::numeric, greatest(0, v_et - v_eb)), 0);
  IF v_carrying <> NEW.carrying_txn_minor::numeric
     OR v_out <> NEW.inventory_value_base_minor::numeric OR v_moved <> -NEW.inventory_value_base_minor::numeric
     OR v_x + NEW.ap_txn_minor > v_p.total_txn_minor
     OR NEW.ap_txn_minor::numeric <> least(NEW.carrying_txn_minor::numeric, v_p.total_txn_minor - v_x)
     OR v_ap_base <> NEW.ap_base_minor::numeric
     OR NEW.ap_dust_base_minor::numeric <> v_ap_base - v_ap_conv
     OR v_cr_conv <> NEW.credit_base_minor::numeric
     OR (NEW.ap_txn_minor > 0 AND v_ap_conv = 0) THEN
    RAISE EXCEPTION 'inventory.source_value_mismatch: a supplier return''s amounts are not the A-10 amounts of its lines, movements and purchase' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- PM-13 at COMMIT: over every return of the purchase, a purchase line is
-- never returned beyond its purchased quantity.
CREATE OR REPLACE FUNCTION supplier_return_quantity_bound() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_qty      NUMERIC;
  v_returned NUMERIC;
BEGIN
  SELECT l.qty INTO v_qty FROM purchase_lines l
   WHERE l.business_id = NEW.business_id AND l.purchase_id = NEW.purchase_id AND l.id = NEW.purchase_line_id;
  SELECT coalesce(sum(r.qty), 0) INTO v_returned FROM supplier_return_lines r
   WHERE r.business_id = NEW.business_id AND r.purchase_id = NEW.purchase_id AND r.purchase_line_id = NEW.purchase_line_id;
  IF v_qty IS NULL OR v_returned > v_qty THEN
    RAISE EXCEPTION 'supplier_return.quantity_exceeds_purchased: the returned quantity exceeds the purchased quantity of the line' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- Line → its one movement, at COMMIT: exactly the negation of the paired
-- purchase movement of the same purchase line (R-37), with its snapshot.
CREATE OR REPLACE FUNCTION stock_source_complete_purchase_reversal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_wh   UUID;
  v_all  INTEGER;
  v_ok   INTEGER;
  v_pair INTEGER;
BEGIN
  SELECT r.warehouse_id INTO v_wh FROM purchase_reversals r WHERE r.business_id = NEW.business_id AND r.id = NEW.reversal_id;
  SELECT count(*) INTO v_pair
  FROM stock_movements m
  WHERE m.business_id = NEW.business_id AND m.source_type = 'purchase' AND m.source_id = NEW.purchase_id
    AND m.source_line_id = NEW.id AND m.movement_kind = 'purchase'
    AND m.warehouse_id = v_wh AND m.variant_id = NEW.variant_id AND m.qty_delta = NEW.qty
    AND m.value_delta_base_minor = NEW.value_base_minor AND m.unit_cost_base_minor = NEW.unit_cost_base_minor;
  SELECT count(*),
         count(*) FILTER (WHERE m.movement_kind = 'purchase_reversal' AND m.warehouse_id = v_wh AND m.variant_id = NEW.variant_id
                            AND m.qty_delta = -NEW.qty AND m.value_delta_base_minor = -NEW.value_base_minor
                            AND m.unit_cost_base_minor = NEW.unit_cost_base_minor)
    INTO v_all, v_ok
  FROM stock_source_bridge_purchase_reversal b
  JOIN stock_movements m ON m.business_id = b.business_id AND m.source_type = b.source_type AND m.source_id = b.source_id
                        AND m.source_line_id = b.source_line_id AND m.movement_kind = b.movement_kind
  WHERE b.business_id = NEW.business_id AND b.source_id = NEW.reversal_id AND b.source_line_id = NEW.id;
  IF v_wh IS NULL OR v_pair <> 1 OR v_all <> 1 OR v_ok <> 1 THEN
    RAISE EXCEPTION 'inventory.source_movement_set_incomplete: a reversed line needs exactly the negation of its purchase movement' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- The header twin (A-09(c)(e), R-44): every purchase line reversed, and
-- only those; no return and no deficit coverage on the purchase; the
-- purchase received; the reversed entry is the purchase's own entry.
CREATE OR REPLACE FUNCTION stock_source_complete_purchase_reversal_header() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_status TEXT;
BEGIN
  SELECT p.status INTO v_status FROM purchases p WHERE p.business_id = NEW.business_id AND p.id = NEW.purchase_id;
  IF v_status IS DISTINCT FROM 'received' THEN
    RAISE EXCEPTION 'purchase.state_invalid: only a received purchase is reversed' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM supplier_return_lines l WHERE l.business_id = NEW.business_id AND l.purchase_id = NEW.purchase_id) THEN
    RAISE EXCEPTION 'purchase_reversal.returned: a purchase with a supplier return is not reversed' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM negative_inventory_cost_adjustments a
              WHERE a.business_id = NEW.business_id AND a.origin_source_type = 'purchase' AND a.origin_source_id = NEW.purchase_id) THEN
    RAISE EXCEPTION 'purchase_reversal.deficit_coverage_present: a purchase whose receipt covered a deficit is not reversed' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM purchase_reversal_lines r WHERE r.business_id = NEW.business_id AND r.reversal_id = NEW.id)
     OR EXISTS (SELECT 1 FROM purchase_lines l
                 WHERE l.business_id = NEW.business_id AND l.purchase_id = NEW.purchase_id
                   AND NOT EXISTS (SELECT 1 FROM purchase_reversal_lines r
                                    WHERE r.business_id = l.business_id AND r.reversal_id = NEW.id AND r.id = l.id
                                      AND r.variant_id = l.variant_id AND r.qty = l.qty))
     OR EXISTS (SELECT 1 FROM purchase_reversal_lines r
                 WHERE r.business_id = NEW.business_id AND r.reversal_id = NEW.id
                   AND NOT EXISTS (SELECT 1 FROM purchase_lines l
                                    WHERE l.business_id = r.business_id AND l.purchase_id = NEW.purchase_id AND l.id = r.id)) THEN
    RAISE EXCEPTION 'inventory.source_movement_set_incomplete: a purchase reversal carries exactly every line of its purchase' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.original_entry_id IS DISTINCT FROM accounting_purchase_entry_id(NEW.business_id, NEW.purchase_id) THEN
    RAISE EXCEPTION 'inventory.source_value_mismatch: a purchase reversal reverses exactly its purchase''s entry' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- The header value, at COMMIT: total = Σ line values = −Σ reversal
-- movement values = Σ purchase movement values = the purchase base total.
CREATE OR REPLACE FUNCTION purchase_reversal_value_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_lines    NUMERIC;
  v_reversed NUMERIC;
  v_received NUMERIC;
  v_total    BIGINT;
BEGIN
  SELECT coalesce(sum(r.value_base_minor), 0) INTO v_lines
  FROM purchase_reversal_lines r WHERE r.business_id = NEW.business_id AND r.reversal_id = NEW.id;
  SELECT coalesce(sum(m.value_delta_base_minor), 0) INTO v_reversed
  FROM stock_source_bridge_purchase_reversal b
  JOIN stock_movements m ON m.business_id = b.business_id AND m.source_type = b.source_type AND m.source_id = b.source_id
                        AND m.source_line_id = b.source_line_id AND m.movement_kind = b.movement_kind
  WHERE b.business_id = NEW.business_id AND b.source_id = NEW.id;
  SELECT coalesce(sum(m.value_delta_base_minor), 0) INTO v_received
  FROM stock_source_bridge_purchase b
  JOIN stock_movements m ON m.business_id = b.business_id AND m.source_type = b.source_type AND m.source_id = b.source_id
                        AND m.source_line_id = b.source_line_id AND m.movement_kind = b.movement_kind
  WHERE b.business_id = NEW.business_id AND b.source_id = NEW.purchase_id;
  SELECT p.total_base_minor INTO v_total FROM purchases p WHERE p.business_id = NEW.business_id AND p.id = NEW.purchase_id;
  IF v_lines <> NEW.total_value_base_minor::numeric OR v_reversed <> -NEW.total_value_base_minor::numeric
     OR v_received <> NEW.total_value_base_minor::numeric OR v_total IS DISTINCT FROM NEW.total_value_base_minor THEN
    RAISE EXCEPTION 'inventory.source_value_mismatch: a purchase reversal total is not exactly what its receipt added' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- 0063 R-36 carried forward: a return line or credit note joins only a
-- return created by this very transaction (the insert-only header's
-- created_at is this transaction's now() and its business_transaction_id
-- this transaction's trace). A detail naming no header at all is left to
-- the immediate FK.
CREATE OR REPLACE FUNCTION supplier_return_detail_same_transaction() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_header  UUID;
  v_created TIMESTAMPTZ;
  v_trace   UUID;
BEGIN
  IF TG_TABLE_NAME = 'supplier_credit_notes' THEN
    v_header := NEW.supplier_return_id;
  ELSE
    v_header := NEW.return_id;
  END IF;
  SELECT r.created_at, r.business_transaction_id INTO v_created, v_trace
  FROM supplier_returns r WHERE r.business_id = NEW.business_id AND r.id = v_header;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF v_created IS DISTINCT FROM now() OR v_trace IS DISTINCT FROM inventory_business_transaction_id() THEN
    RAISE EXCEPTION 'inventory.source_document_immutable: a return line or credit note is added only by the transaction that created its return' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION purchase_reversal_detail_same_transaction() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_created TIMESTAMPTZ;
  v_trace   UUID;
BEGIN
  SELECT r.created_at, r.business_transaction_id INTO v_created, v_trace
  FROM purchase_reversals r WHERE r.business_id = NEW.business_id AND r.id = NEW.reversal_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF v_created IS DISTINCT FROM now() OR v_trace IS DISTINCT FROM inventory_business_transaction_id() THEN
    RAISE EXCEPTION 'inventory.source_document_immutable: a reversal line is added only by the transaction that created its reversal' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- A-11(e): a credit note is immutable in S5, for every role including the
-- table owner. S6 replaces this function, as its owner, to admit the AL-31
-- decrement.
CREATE OR REPLACE FUNCTION supplier_credit_note_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'supplier_credit_note.immutable: a supplier credit note is never changed or deleted' USING ERRCODE = 'P0001';
END;
$$;

REVOKE ALL ON FUNCTION stock_binding_requires_supplier_return() FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_binding_requires_purchase_reversal() FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_source_complete_supplier_return() FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_source_complete_supplier_return_header() FROM PUBLIC;
REVOKE ALL ON FUNCTION supplier_return_value_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION supplier_return_quantity_bound() FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_source_complete_purchase_reversal() FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_source_complete_purchase_reversal_header() FROM PUBLIC;
REVOKE ALL ON FUNCTION purchase_reversal_value_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION supplier_return_detail_same_transaction() FROM PUBLIC;
REVOKE ALL ON FUNCTION purchase_reversal_detail_same_transaction() FROM PUBLIC;
REVOKE ALL ON FUNCTION supplier_credit_note_guard() FROM PUBLIC;

-- ── The stock-side triggers (§2.3) ──────────────────────────────────────
CREATE CONSTRAINT TRIGGER stock_binding_requires_supplier_return
  AFTER INSERT ON stock_source_bindings DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source_type = 'supplier_return')
  EXECUTE FUNCTION stock_binding_requires_supplier_return();
CREATE CONSTRAINT TRIGGER stock_binding_requires_purchase_reversal
  AFTER INSERT ON stock_source_bindings DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source_type = 'purchase_reversal')
  EXECUTE FUNCTION stock_binding_requires_purchase_reversal();

CREATE TRIGGER stock_bridge_immutable_supplier_return
  BEFORE UPDATE OR DELETE ON stock_source_bridge_supplier_return
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_append_only();
CREATE TRIGGER stock_bridge_immutable_purchase_reversal
  BEFORE UPDATE OR DELETE ON stock_source_bridge_purchase_reversal
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_append_only();

-- supplier_return: completeness, value, quantity bound (deferred, judged on
-- INSERT: the only write), freeze and immutability (append-only), and the
-- same-transaction guard of each detail table.
CREATE CONSTRAINT TRIGGER stock_source_complete_supplier_return
  AFTER INSERT ON supplier_return_lines DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION stock_source_complete_supplier_return();
CREATE CONSTRAINT TRIGGER supplier_returns_complete
  AFTER INSERT ON supplier_returns DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION stock_source_complete_supplier_return_header();
CREATE TRIGGER stock_source_freeze_supplier_return
  BEFORE UPDATE OR DELETE ON supplier_return_lines
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_append_only();
CREATE TRIGGER supplier_returns_immutable
  BEFORE UPDATE OR DELETE ON supplier_returns
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_append_only();
CREATE CONSTRAINT TRIGGER supplier_returns_value_complete
  AFTER INSERT ON supplier_returns DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION supplier_return_value_complete();
CREATE CONSTRAINT TRIGGER supplier_return_lines_quantity_bound
  AFTER INSERT ON supplier_return_lines DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION supplier_return_quantity_bound();
CREATE TRIGGER supplier_return_lines_same_transaction
  BEFORE INSERT ON supplier_return_lines
  FOR EACH ROW EXECUTE FUNCTION supplier_return_detail_same_transaction();
CREATE TRIGGER supplier_credit_notes_same_transaction
  BEFORE INSERT ON supplier_credit_notes
  FOR EACH ROW EXECUTE FUNCTION supplier_return_detail_same_transaction();
CREATE TRIGGER supplier_credit_notes_immutable
  BEFORE UPDATE OR DELETE ON supplier_credit_notes
  FOR EACH ROW EXECUTE FUNCTION supplier_credit_note_guard();

-- purchase_reversal: the same set.
CREATE CONSTRAINT TRIGGER stock_source_complete_purchase_reversal
  AFTER INSERT ON purchase_reversal_lines DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION stock_source_complete_purchase_reversal();
CREATE CONSTRAINT TRIGGER purchase_reversals_complete
  AFTER INSERT ON purchase_reversals DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION stock_source_complete_purchase_reversal_header();
CREATE TRIGGER stock_source_freeze_purchase_reversal
  BEFORE UPDATE OR DELETE ON purchase_reversal_lines
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_append_only();
CREATE TRIGGER purchase_reversals_immutable
  BEFORE UPDATE OR DELETE ON purchase_reversals
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_append_only();
CREATE CONSTRAINT TRIGGER purchase_reversals_value_complete
  AFTER INSERT ON purchase_reversals DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION purchase_reversal_value_complete();
CREATE TRIGGER purchase_reversal_lines_same_transaction
  BEFORE INSERT ON purchase_reversal_lines
  FOR EACH ROW EXECUTE FUNCTION purchase_reversal_detail_same_transaction();

-- The ownership transfer (after the ACL and the triggers).
ALTER FUNCTION stock_binding_requires_supplier_return() OWNER TO daftar_inventory_internal;
ALTER FUNCTION stock_binding_requires_purchase_reversal() OWNER TO daftar_inventory_internal;
ALTER FUNCTION stock_source_complete_supplier_return() OWNER TO daftar_inventory_internal;
ALTER FUNCTION stock_source_complete_supplier_return_header() OWNER TO daftar_inventory_internal;
ALTER FUNCTION supplier_return_value_complete() OWNER TO daftar_inventory_internal;
ALTER FUNCTION supplier_return_quantity_bound() OWNER TO daftar_inventory_internal;
ALTER FUNCTION stock_source_complete_purchase_reversal() OWNER TO daftar_inventory_internal;
ALTER FUNCTION stock_source_complete_purchase_reversal_header() OWNER TO daftar_inventory_internal;
ALTER FUNCTION purchase_reversal_value_complete() OWNER TO daftar_inventory_internal;
ALTER FUNCTION supplier_return_detail_same_transaction() OWNER TO daftar_inventory_internal;
ALTER FUNCTION purchase_reversal_detail_same_transaction() OWNER TO daftar_inventory_internal;
ALTER FUNCTION supplier_credit_note_guard() OWNER TO daftar_inventory_internal;


-- ─────────────────────────────────────────────────────────────────────────
-- 6. R-B1a (§2.4, R-37): the stock primitive replaced BY ITS OWNER.
--
-- `inventory_apply_stock_movements` is owned by the internal principal
-- (0060), so only that principal may replace it: the migrator assumes it
-- through its SET-enabled, non-inheriting membership, inside this CREATE
-- bracket, and returns at once (the 0060 precedent for
-- `inventory_configure_product`). CREATE OR REPLACE by the owner keeps the
-- signature, the return type, the owner and the ACL (no EXECUTE grantee).
-- The body is 0060's, byte for byte, with ONE new branch in step 6c
-- between `transfer_in` and the outbound branch; every other movement kind
-- takes exactly the 0060 path.
-- ─────────────────────────────────────────────────────────────────────────
SET LOCAL ROLE daftar_inventory_internal;

CREATE OR REPLACE FUNCTION inventory_apply_stock_movements(p_requests inventory_movement_request[])
RETURNS TABLE (
  ordinal                  INTEGER,
  movement_id              UUID,
  warehouse_id             UUID,
  variant_id               UUID,
  stock_seq                BIGINT,
  movement_kind            TEXT,
  qty_delta                NUMERIC,
  unit_cost_base_minor     NUMERIC,
  value_delta_base_minor   BIGINT,
  on_hand                  NUMERIC,
  valuation_base_minor     BIGINT,
  avg_unit_cost_base_minor NUMERIC
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  c_value_limit   CONSTANT NUMERIC := 1000000000000000000;
  -- |qty| and |on_hand| < 10^10 (A-26 as amended, M-3): the average is exact
  -- to 0.5e-10 per unit, so below 10^10 units a partial outbound valued at
  -- the average can never take more than the key holds.
  c_qty_limit     CONSTANT NUMERIC := 10000000000;
  v_actor         inventory_verified_actor;
  v_business      UUID;
  v_tenant        UUID;
  v_lo            INTEGER;
  v_n             INTEGER;
  v_i             INTEGER;
  v_req           inventory_movement_request;
  v_products      UUID[] := ARRAY[]::uuid[];
  v_decimals      SMALLINT[] := ARRAY[]::smallint[];
  v_product       UUID;
  v_base          UUID;
  v_prod          RECORD;
  v_key           RECORD;
  v_pair          RECORD;
  v_sign          TEXT;
  v_needs_reason  BOOLEAN;
  v_qty           NUMERIC;
  v_level_qty     NUMERIC;
  v_level_value   NUMERIC;
  v_level_avg     NUMERIC;
  v_level_seq     BIGINT;
  v_snapshot      NUMERIC;
  v_value         NUMERIC;
  v_next_qty      NUMERIC;
  v_next_value    NUMERIC;
  v_next_avg      NUMERIC;
  v_seq           BIGINT;
  v_id            UUID;
  v_rows          BIGINT;
BEGIN
  v_actor := inventory_assertion_current(ARRAY(SELECT DISTINCT m.op_code FROM inventory_operation_movement_kinds m ORDER BY 1));
  -- The lock protocol (A-23) relies on a fresh snapshot per statement (M-1).
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'inventory.isolation_unsupported: stock commands run only at READ COMMITTED' USING ERRCODE = 'P0001';
  END IF;
  v_business := v_actor.business_id;
  v_tenant   := v_actor.tenant_id;

  -- 1. Shape. Every identifying field and the quantity are required; a
  --    reason, when given, is 1..500 characters of content.
  IF p_requests IS NULL OR cardinality(p_requests) < 1 OR array_ndims(p_requests) <> 1 THEN
    RAISE EXCEPTION 'inventory.movement_request_invalid: a stock command carries at least one movement request' USING ERRCODE = 'P0001';
  END IF;
  v_lo := array_lower(p_requests, 1);
  v_n  := cardinality(p_requests);
  FOR v_i IN 1 .. v_n LOOP
    v_req := p_requests[v_lo + v_i - 1];
    IF v_req.warehouse_id IS NULL OR v_req.variant_id IS NULL OR v_req.movement_kind IS NULL
       OR v_req.source_type IS NULL OR v_req.source_id IS NULL OR v_req.source_line_id IS NULL
       OR v_req.qty_delta IS NULL
       OR (v_req.reason IS NOT NULL AND char_length(btrim(v_req.reason)) NOT BETWEEN 1 AND 500) THEN
      RAISE EXCEPTION 'inventory.movement_request_invalid: a movement request names its warehouse, variant, kind, source and quantity' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- 2 and 3. Kind and scope. The kind must be registered and mapped to the
  --    VERIFIED operation; the warehouse and the variant must belong to the
  --    VERIFIED business. No GUC is read for identity.
  FOR v_i IN 1 .. v_n LOOP
    v_req := p_requests[v_lo + v_i - 1];
    IF NOT EXISTS (SELECT 1 FROM stock_movement_kinds k WHERE k.movement_kind = v_req.movement_kind) THEN
      RAISE EXCEPTION 'inventory.movement_kind_unknown: the movement kind is not registered' USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM inventory_operation_movement_kinds m
                    WHERE m.op_code = v_actor.op_code AND m.movement_kind = v_req.movement_kind) THEN
      RAISE EXCEPTION 'inventory.movement_kind_not_authorized: the verified operation may not write this movement kind' USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM warehouses w WHERE w.business_id = v_business AND w.id = v_req.warehouse_id) THEN
      RAISE EXCEPTION 'inventory.warehouse_not_found: the warehouse does not exist in this business' USING ERRCODE = 'P0001';
    END IF;
    SELECT pv.product_id INTO v_product
    FROM product_variants pv
    WHERE pv.business_id = v_business AND pv.id = v_req.variant_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'inventory.variant_not_found: the variant does not exist in this business' USING ERRCODE = 'P0001';
    END IF;
    v_products[v_i] := v_product;
    v_decimals[v_i] := NULL;
  END LOOP;

  -- 4. Products, locked FOR SHARE in id order BEFORE any stock key (A-23):
  --    a configuration change of the same product holds a conflicting lock,
  --    so tracking, unit and precision cannot change under this command.
  FOR v_prod IN
    SELECT p.id, p.track_inventory, p.unit_decimals
    FROM products p
    WHERE p.business_id = v_business AND p.id = ANY (v_products)
    ORDER BY p.id
    FOR SHARE
  LOOP
    IF NOT v_prod.track_inventory THEN
      RAISE EXCEPTION 'inventory.product_not_tracked: the product does not track inventory' USING ERRCODE = 'P0001';
    END IF;
    SELECT pv.id INTO v_base
    FROM product_variants pv
    WHERE pv.business_id = v_business AND pv.product_id = v_prod.id AND pv.is_base;
    FOR v_i IN 1 .. v_n LOOP
      IF v_products[v_i] = v_prod.id THEN
        v_req := p_requests[v_lo + v_i - 1];
        IF v_base IS NOT NULL AND v_req.variant_id <> v_base THEN
          RAISE EXCEPTION 'inventory.variant_not_stock_identity: a product with a base variant holds stock only on its base variant' USING ERRCODE = 'P0001';
        END IF;
        IF NOT inventory_quantity_is_representable(v_req.qty_delta, v_prod.unit_decimals) THEN
          RAISE EXCEPTION 'inventory.quantity_precision_invalid: the quantity has more decimal places than the product unit allows' USING ERRCODE = 'P0001';
        END IF;
        IF abs(v_req.qty_delta) >= c_qty_limit THEN
          RAISE EXCEPTION 'inventory.quantity_out_of_range: the quantity is outside the supported range' USING ERRCODE = 'P0001';
        END IF;
        v_decimals[v_i] := v_prod.unit_decimals;
      END IF;
    END LOOP;
  END LOOP;
  FOR v_i IN 1 .. v_n LOOP
    IF v_decimals[v_i] IS NULL THEN
      RAISE EXCEPTION 'inventory.variant_not_found: the variant''s product does not exist in this business' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- 4b. The variant→product mapping, re-read now that the products are
  --     locked (H-1). A reparent takes FOR UPDATE on the variant's current
  --     product (product_variants_20_stock_identity_lock), which conflicts
  --     with the FOR SHARE above, so from here on no requested variant can
  --     change product until this command ends. A reparent that committed
  --     between step 3 and the lock is seen here: this statement takes a fresh
  --     READ COMMITTED snapshot. (The internal principal holds no UPDATE on
  --     product_variants, so it cannot lock variant rows itself.)
  FOR v_i IN 1 .. v_n LOOP
    v_req := p_requests[v_lo + v_i - 1];
    IF NOT EXISTS (SELECT 1 FROM product_variants pv
                    WHERE pv.business_id = v_business AND pv.id = v_req.variant_id AND pv.product_id = v_products[v_i]) THEN
      RAISE EXCEPTION 'inventory.variant_stock_identity_changed: the variant moved to another product while the command ran' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- 5. Stock keys (P3-AL-06, P3-AL-07): every distinct key, in ascending
  --    uuid order whatever the payload order, is created if absent and then
  --    locked. Two commands over the same keys therefore lock them in the
  --    same order.
  FOR v_key IN
    SELECT DISTINCT r.warehouse_id AS wh, r.variant_id AS va
    FROM unnest(p_requests) AS r
    ORDER BY 1, 2
  LOOP
    INSERT INTO stock_levels (tenant_id, business_id, warehouse_id, variant_id, on_hand, valuation_base_minor,
                              avg_unit_cost_base_minor, last_stock_seq)
    VALUES (v_tenant, v_business, v_key.wh, v_key.va, 0, 0, NULL, 0)
    ON CONFLICT (business_id, warehouse_id, variant_id) DO NOTHING;

    PERFORM 1 FROM stock_levels l
     WHERE l.business_id = v_business AND l.warehouse_id = v_key.wh AND l.variant_id = v_key.va
       FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'inventory.arithmetic_invalid: the stock key could not be locked' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- 6. Each request, in array order, against the locked cache row.
  FOR v_i IN 1 .. v_n LOOP
    v_req := p_requests[v_lo + v_i - 1];
    v_qty := v_req.qty_delta;

    SELECT l.on_hand, l.valuation_base_minor, l.avg_unit_cost_base_minor, l.last_stock_seq
      INTO v_level_qty, v_level_value, v_level_avg, v_level_seq
    FROM stock_levels l
    WHERE l.business_id = v_business AND l.warehouse_id = v_req.warehouse_id AND l.variant_id = v_req.variant_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'inventory.arithmetic_invalid: the locked stock key vanished' USING ERRCODE = 'P0001';
    END IF;

    -- a. The five-part identity, checked under the key lock so a same-key
    --    race answers with the stable code.
    IF EXISTS (SELECT 1 FROM stock_movements m
                WHERE m.business_id = v_business AND m.source_type = v_req.source_type
                  AND m.source_id = v_req.source_id AND m.source_line_id = v_req.source_line_id
                  AND m.movement_kind = v_req.movement_kind) THEN
      RAISE EXCEPTION 'inventory.movement_identity_conflict: this source line already carries a movement of this kind' USING ERRCODE = 'P0001';
    END IF;

    -- b. Sign and reason.
    SELECT k.qty_sign, k.requires_reason INTO v_sign, v_needs_reason
    FROM stock_movement_kinds k
    WHERE k.movement_kind = v_req.movement_kind;
    IF (v_sign = 'positive' AND v_qty <= 0)
       OR (v_sign = 'negative' AND v_qty >= 0)
       OR (v_sign = 'either' AND v_qty = 0)
       OR (v_sign = 'zero' AND v_qty <> 0) THEN
      RAISE EXCEPTION 'inventory.quantity_sign_invalid: the quantity sign is not allowed for this movement kind' USING ERRCODE = 'P0001';
    END IF;
    IF v_needs_reason AND v_req.reason IS NULL THEN
      RAISE EXCEPTION 'inventory.reason_required: this movement kind requires a reason' USING ERRCODE = 'P0001';
    END IF;

    -- c. The stored value and the snapshot, by class.
    IF v_qty = 0 THEN
      -- Value-only: the caller's value, no snapshot.
      IF v_req.unit_cost_base_minor IS NOT NULL OR v_req.value_delta_base_minor IS NULL OR v_req.value_delta_base_minor = 0 THEN
        RAISE EXCEPTION 'inventory.movement_shape_invalid: a value-only movement carries a non-zero value and no cost' USING ERRCODE = 'P0001';
      END IF;
      v_value    := v_req.value_delta_base_minor;
      v_snapshot := NULL;
    ELSIF v_req.movement_kind = 'transfer_in' THEN
      -- The incoming leg carries exactly what the outgoing leg took out.
      IF v_req.unit_cost_base_minor IS NOT NULL OR v_req.value_delta_base_minor IS NOT NULL THEN
        RAISE EXCEPTION 'inventory.movement_shape_invalid: a transfer_in movement takes its cost and value from its transfer_out' USING ERRCODE = 'P0001';
      END IF;
      SELECT m.warehouse_id AS wh, m.variant_id AS va, m.qty_delta AS qty, m.unit_cost_base_minor AS snap,
             m.value_delta_base_minor AS val
        INTO v_pair
      FROM stock_movements m
      WHERE m.business_id = v_business AND m.source_type = v_req.source_type
        AND m.source_id = v_req.source_id AND m.source_line_id = v_req.source_line_id
        AND m.movement_kind = 'transfer_out';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'inventory.transfer_pair_missing: a transfer_in needs the transfer_out of the same source line' USING ERRCODE = 'P0001';
      END IF;
      IF v_pair.va <> v_req.variant_id OR v_pair.wh = v_req.warehouse_id OR v_pair.qty <> -v_qty THEN
        RAISE EXCEPTION 'inventory.transfer_pair_mismatch: a transfer moves the same variant and quantity between two warehouses' USING ERRCODE = 'P0001';
      END IF;
      v_value    := -v_pair.val;
      v_snapshot := v_pair.snap;
    ELSIF v_req.movement_kind = 'purchase_reversal' THEN
      -- The inverse of a receipt carries exactly what the receipt added (P3-AL-20),
      -- the transfer_in precedent: a paired stored value, never recomputed.
      IF v_req.unit_cost_base_minor IS NOT NULL OR v_req.value_delta_base_minor IS NOT NULL THEN
        RAISE EXCEPTION 'inventory.movement_shape_invalid: a purchase_reversal movement takes its cost and value from its purchase movement' USING ERRCODE = 'P0001';
      END IF;
      IF abs(v_qty) > v_level_qty THEN
        RAISE EXCEPTION 'inventory.insufficient_stock: the warehouse does not hold enough of this variant' USING ERRCODE = 'P0001';
      END IF;
      IF v_req.source_type <> 'purchase_reversal' THEN
        RAISE EXCEPTION 'inventory.movement_shape_invalid: a purchase_reversal movement belongs to a purchase reversal' USING ERRCODE = 'P0001';
      END IF;
      SELECT m.warehouse_id AS wh, m.variant_id AS va, m.qty_delta AS qty, m.unit_cost_base_minor AS snap,
             m.value_delta_base_minor AS val
        INTO v_pair
      FROM stock_movements m
      WHERE m.business_id = v_business AND m.source_type = 'purchase'
        AND m.source_id = v_req.source_id AND m.source_line_id = v_req.source_line_id
        AND m.movement_kind = 'purchase';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'inventory.reversal_pair_missing: a purchase_reversal needs the purchase movement of the same line' USING ERRCODE = 'P0001';
      END IF;
      IF v_pair.va <> v_req.variant_id OR v_pair.wh <> v_req.warehouse_id OR v_pair.qty <> -v_qty THEN
        RAISE EXCEPTION 'inventory.reversal_pair_mismatch: a reversal removes the same variant and quantity from the same warehouse' USING ERRCODE = 'P0001';
      END IF;
      v_value    := -v_pair.val;
      v_snapshot := v_pair.snap;
      IF (v_level_qty + v_qty = 0 AND v_level_value + v_value <> 0)
         OR (v_level_qty + v_qty > 0 AND v_level_value + v_value < 0) THEN
        RAISE EXCEPTION 'inventory.reversal_valuation_residue: removing the receipt value would leave an unlawful key valuation' USING ERRCODE = 'P0001';
      END IF;
    ELSIF v_qty < 0 THEN
      -- Outbound: its own quantity at the current average, or the stored
      -- valuation exactly when it empties the key.
      IF v_req.unit_cost_base_minor IS NOT NULL OR v_req.value_delta_base_minor IS NOT NULL THEN
        RAISE EXCEPTION 'inventory.movement_shape_invalid: an outbound movement is valued at the current average, not by its caller' USING ERRCODE = 'P0001';
      END IF;
      IF abs(v_qty) > v_level_qty THEN
        RAISE EXCEPTION 'inventory.insufficient_stock: the warehouse does not hold enough of this variant' USING ERRCODE = 'P0001';
      END IF;
      IF v_level_avg IS NULL OR v_level_avg < 0 THEN
        RAISE EXCEPTION 'inventory.arithmetic_invalid: the stock key has no usable average cost' USING ERRCODE = 'P0001';
      END IF;
      IF abs(v_qty) = v_level_qty THEN
        v_value := -v_level_value;
      ELSE
        v_value := -inventory_half_even(abs(v_qty) * v_level_avg, 1, 0);
      END IF;
      v_snapshot := v_level_avg;
    ELSE
      -- Inbound: the supplied document cost is the snapshot (A-27); the value
      -- is the supplied integer share for a priced document, else HALF_EVEN of
      -- quantity times cost.
      IF v_req.unit_cost_base_minor IS NULL
         OR (v_req.value_delta_base_minor IS NOT NULL AND v_req.movement_kind NOT IN ('purchase', 'inventory_opening')) THEN
        RAISE EXCEPTION 'inventory.movement_shape_invalid: an inbound movement carries its unit cost, and only a priced document supplies its value' USING ERRCODE = 'P0001';
      END IF;
      v_snapshot := v_req.unit_cost_base_minor;
      IF v_snapshot < 0 OR v_snapshot <> trunc(v_snapshot, 10) OR v_snapshot >= c_value_limit THEN
        RAISE EXCEPTION 'inventory.cost_invalid: a unit cost is non-negative, below the limit and exact at 10 decimal places' USING ERRCODE = 'P0001';
      END IF;
      IF v_req.value_delta_base_minor IS NOT NULL THEN
        IF v_req.value_delta_base_minor < 0 THEN
          RAISE EXCEPTION 'inventory.movement_shape_invalid: a supplied inbound value is not negative' USING ERRCODE = 'P0001';
        END IF;
        v_value := v_req.value_delta_base_minor;
      ELSE
        v_value := inventory_half_even(v_qty * v_snapshot, 1, 0);
      END IF;
    END IF;

    -- d. Bounds and the next state. The average is DERIVED from the stored
    --    valuation and quantity, and carried when the key reaches zero.
    IF abs(v_value) > c_value_limit THEN
      RAISE EXCEPTION 'inventory.value_out_of_range: the movement value is outside the supported range' USING ERRCODE = 'P0001';
    END IF;
    v_next_value := v_level_value + v_value;
    IF abs(v_next_value) > c_value_limit THEN
      RAISE EXCEPTION 'inventory.value_out_of_range: the resulting valuation is outside the supported range' USING ERRCODE = 'P0001';
    END IF;
    v_next_qty := v_level_qty + v_qty;
    IF abs(v_next_qty) >= c_qty_limit THEN
      RAISE EXCEPTION 'inventory.quantity_out_of_range: the resulting quantity is outside the supported range' USING ERRCODE = 'P0001';
    END IF;
    IF v_next_qty <> 0 THEN
      v_next_avg := inventory_half_even(v_next_value, v_next_qty, 10);
    ELSE
      v_next_avg := v_level_avg;
    END IF;
    IF v_next_avg IS NOT NULL AND abs(v_next_avg) >= c_value_limit THEN
      RAISE EXCEPTION 'inventory.value_out_of_range: the resulting average cost is outside the supported range' USING ERRCODE = 'P0001';
    END IF;
    v_seq := v_level_seq + 1;
    v_id  := gen_random_uuid();

    -- e. ONE statement (A-15): the movement, the cache and the binding.
    WITH mv AS (
      INSERT INTO stock_movements (tenant_id, business_id, id, warehouse_id, variant_id, stock_seq, movement_kind,
                                   source_type, source_id, source_line_id, qty_delta, unit_cost_base_minor,
                                   value_delta_base_minor, reason, actor_user_id)
      VALUES (v_tenant, v_business, v_id, v_req.warehouse_id, v_req.variant_id, v_seq, v_req.movement_kind,
              v_req.source_type, v_req.source_id, v_req.source_line_id, v_qty, v_snapshot,
              v_value::bigint, v_req.reason, v_actor.actor_user_id)
      RETURNING 1
    ), lv AS (
      UPDATE stock_levels l
         SET on_hand                  = v_next_qty,
             valuation_base_minor     = v_next_value::bigint,
             avg_unit_cost_base_minor = v_next_avg,
             last_stock_seq           = v_seq
       WHERE l.business_id = v_business AND l.warehouse_id = v_req.warehouse_id AND l.variant_id = v_req.variant_id
      RETURNING 1
    )
    INSERT INTO stock_source_bindings (tenant_id, business_id, source_type, source_id, source_line_id, movement_kind)
    SELECT v_tenant, v_business, v_req.source_type, v_req.source_id, v_req.source_line_id, v_req.movement_kind
    WHERE EXISTS (SELECT 1 FROM mv) AND EXISTS (SELECT 1 FROM lv);
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'inventory.arithmetic_invalid: the movement, cache and binding were not written together' USING ERRCODE = 'P0001';
    END IF;

    -- f. Answer with what was STORED, as stored.
    SELECT m.qty_delta, m.unit_cost_base_minor, m.value_delta_base_minor
      INTO qty_delta, unit_cost_base_minor, value_delta_base_minor
    FROM stock_movements m
    WHERE m.business_id = v_business AND m.id = v_id;
    SELECT l.on_hand, l.valuation_base_minor, l.avg_unit_cost_base_minor
      INTO on_hand, valuation_base_minor, avg_unit_cost_base_minor
    FROM stock_levels l
    WHERE l.business_id = v_business AND l.warehouse_id = v_req.warehouse_id AND l.variant_id = v_req.variant_id;
    ordinal       := v_i;
    movement_id   := v_id;
    warehouse_id  := v_req.warehouse_id;
    variant_id    := v_req.variant_id;
    stock_seq     := v_seq;
    movement_kind := v_req.movement_kind;
    RETURN NEXT;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION inventory_apply_stock_movements(inventory_movement_request[]) IS
  'P3-S2 §2.5 R3. The only writer of stock_movements, stock_levels and stock_source_bindings. First re-verifies the transaction''s consumed invctl/1 assertion (inventory_assertion_current) against the mapped operations; every kind must be mapped to the verified operation. Validates shape, kind, scope, product tracking, base-variant identity, precision and ranges; locks products FOR SHARE in id order, then creates and locks every stock key in uuid order; then per request writes the movement, the cache and the binding in one statement, with every value computed here by HALF_EVEN (inbound supplied share only for purchase/inventory_opening). Returns what was stored. P3-S5 (R-B1a, 0065): purchase_reversal: the exact negation of its paired purchase movement — the stored value and snapshot of the purchase movement of the same source line, never the average; inventory.reversal_pair_missing without it, inventory.reversal_pair_mismatch for another variant, warehouse or quantity, inventory.reversal_valuation_residue when the key would be left at on_hand = 0 with a non-zero valuation or a positive on_hand with a negative one. No EXECUTE grant.';

RESET ROLE;

-- Hand back the ownership-transfer authority of section 5.
REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 7. The replaced source-guard discovery (§2.3), BEFORE the two S5 source
--    types are registered. Migrator-owned INVOKER STABLE, same signature,
--    pinned; strictly stronger.
--
-- Everything 0063 checks is kept byte for byte: every S3 and S4 statement,
-- the six line-table rows, the S3 and S4 per-type sets and all twenty-nine
-- recorded S3/S4 digests (0063 records twenty-nine: the contract's
-- "twenty-four" counts the tree before the P3-S4 review added five). The
-- S5 types get the S4 treatment (`NOT (v_s3 OR v_s4 OR v_s5)`), their two
-- line-table rows and their own per-type set, checked in the S4 loop's
-- shape; four of its guards run on the migrator-owned INVOKER
-- `stock_ledger_append_only()`. Every S5 guard function's body is recorded
-- as the SHA-256 of its prosrc, of THIS file's bodies.
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
    "supplier_return_value_complete()": "825986a1357e35d3aa5ee3fd7a7e17b46a4d0a49cfc93e98ce27085bb79f3ab7",
    "supplier_return_quantity_bound()": "1ac8224efb6b2f7c036d57207afcbfd08c7e469d745b3657271a0eb2cbadbe26",
    "stock_source_complete_purchase_reversal()": "61d96c8dfe2c30fb6d7689bf771bd677ce03a2541beb33c48b4d1476b1efdcba",
    "stock_source_complete_purchase_reversal_header()": "24b99c06756f9acd5190d12d1f693cb90c9ab023480a4172c382ccd98e6686e1",
    "purchase_reversal_value_complete()": "55d5d4f779fe497263a70445a869aa8f9fc1e235fc350f389c07ceccab72e3e0",
    "supplier_return_detail_same_transaction()": "68a8c04daa668ef1574f6e7109ca1756a33310005d82455118047f328717aa49",
    "purchase_reversal_detail_same_transaction()": "e408924187c911f6b1d61f46ce1ae7e6ff965f2807562c9cfaa176508c5838bf"
  }';
BEGIN
  FOR v_type IN SELECT t.source_type FROM stock_source_types t ORDER BY t.source_type LOOP
    v_s3 := v_type IN ('inventory_adjustment', 'inventory_opening', 'inventory_transfer', 'stocktake');
    v_s4 := v_type IN ('negative_inventory_cost_adjustment', 'purchase');
    v_s5 := v_type IN ('purchase_reversal', 'supplier_return');
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
                 ('purchase_reversal',    'purchase_reversal_lines',    ARRAY['business_id', 'reversal_id', 'id'])) AS e(st, tbl, cols)
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
                        AND (NOT (v_s3 OR v_s4 OR v_s5) OR c.confrelid = v_line_tbl)
                        AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
                               FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
                            = ARRAY['business_id', 'source_id', 'source_line_id']
                        AND (NOT (v_s3 OR v_s4 OR v_s5)
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
                        AND (NOT (v_s3 OR v_s4 OR v_s5) OR encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex')
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
            AND (NOT (v_s3 OR v_s4 OR v_s5) OR encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex')
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
  END LOOP;
END;
$$;

COMMENT ON FUNCTION inventory_stock_source_guard_gaps() IS
  'P3-AL-51 §B, strengthened by P3-S3 (A-16, review F3). Catalogue-only discovery: for every stock_source_types row, reports each missing or mis-shaped guard — bridge (a plain table), bridge_rls (enabled and forced), bridge_pk (exactly business_id, source_id, source_line_id, movement_kind), bridge_source_type (a stored generated constant equal to the type), bridge_binding_fk (validated RESTRICT, five columns in order), bridge_line_fk (validated RESTRICT, business_id, source_id, source_line_id; for an S3 type to exactly its line table and key), bridge_immutable (ROW BEFORE UPDATE OR DELETE on every column, no WHEN, enabled for origin sessions, on stock_ledger_append_only()), binding_trigger (ROW AFTER INSERT deferred constraint trigger on its own internal DEFINER function with the pinned path and the WHEN on the type). For the four S3 types also source_complete, source_freeze, header_immutable, value_complete and (stocktake) header_complete, each by table, name, event, column list, WHEN, deferral, enabled state and expected internal DEFINER pinned function; and every S3 guard function''s body against the SHA-256 of its prosrc recorded at migration time. Replaced by P3-S4 (0063, §2.3): the two S4 types (purchase, negative_inventory_cost_adjustment) get the S3 bridge_line_fk (purchase_lines / negative_deficit_coverages), bridge_immutable and binding_trigger checks, and their own set — source_complete, header_complete (purchase), source_freeze, header_immutable, value_complete — with every S4 guard function''s body recorded the same way (the two stock_ledger_append_only() guards as migrator-owned INVOKER); per the P3-S4 review also landed_cost_freeze, allocation_freeze, allocation_consistent, landed_cost_consistent (purchase) and coverage_same_transaction, coverage_value_complete, deficit_guard, deficit_consistent (negative_inventory_cost_adjustment), the three freeze triggers and the header guard judging INSERT too. Replaced by P3-S5 (0065, §2.3): the two S5 types (supplier_return, purchase_reversal) get the same bridge_line_fk (supplier_return_lines / purchase_reversal_lines), bridge_immutable and binding_trigger checks and their own set — source_complete, header_complete, source_freeze, header_immutable, value_complete, line_same_transaction, and (supplier_return) quantity_bound and credit_note_same_transaction — with every S5 guard function''s body recorded the same way; the S3 and S4 parts are unchanged. Every migration that registers a source type asserts it returns no row. Migrator-owned INVOKER; no EXECUTE grant.';

REVOKE ALL ON FUNCTION inventory_stock_source_guard_gaps() FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────
-- 8. Stock-source registration (A-05): after every guard above exists and
--    the discovery that proves them is replaced. `purchase_reversal` is a
--    STOCK source type only (R-B2a).
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO stock_source_types (source_type, registered_by) VALUES
  ('purchase_reversal', 'P3-S5'), ('supplier_return', 'P3-S5');

-- ─────────────────────────────────────────────────────────────────────────
-- 9. The accounting side (A-15). Every function is owned by
--    daftar_accounting_internal, DEFINER, pinned, PUBLIC revoked, inside the
--    accounting CREATE bracket (0058:40-71).
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;

-- (b) The reversal guard, replaced BY ITS OWNER (R-38, R-B2a): byte-identical
--     to 0063's except the domain test. `supplier_return` joins the
--     always-refused types; a `purchase` entry is admitted only when the
--     paired `purchase_reversals` row (its id the entry's source id, its
--     original_entry_id the reversed entry) was written first in this
--     transaction by `purchase_reverse`. The R-13 block is kept verbatim.
SET LOCAL ROLE daftar_accounting_internal;

CREATE OR REPLACE FUNCTION accounting_reversals_20_domain_source_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_ob UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM journal_entries je
              WHERE je.business_id = NEW.business_id AND je.id = NEW.original_entry_id
                AND (je.source_type IN ('inventory_adjustment', 'inventory_opening', 'negative_inventory_cost_adjustment', 'supplier_return')
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

-- (a) Detail completeness (AL-01 re-proved): a `supplier_return` entry
--     cannot commit without exactly its return, in exactly the A-10(g)
--     shape, for exactly the return's stored amounts. Lines are compared as
--     a multiset of signatures: account key, side, base amount, txn
--     currency and amount, rate, rate source, rate instant and dimensions
--     (R-46: a purchase-currency line carries the purchase's stored
--     snapshot; a base line rate 1, source base, at the return's
--     document_date 00:00 UTC).
CREATE OR REPLACE FUNCTION accounting_supplier_return_entry_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_r        RECORD;
  v_p        RECORD;
  v_base_ccy TEXT;
  v_pbranch  UUID;
  v_rbranch  UUID;
  v_one      TEXT;
  v_snap     TEXT;
  v_base     TEXT;
  v_ap_conv  BIGINT;
  v_expected TEXT[];
  v_actual   TEXT[];
BEGIN
  SELECT r.purchase_id, r.warehouse_id, r.document_date, r.currency_code, r.ap_txn_minor, r.ap_base_minor, r.ap_dust_base_minor,
         r.credit_txn_minor, r.credit_base_minor, r.inventory_value_base_minor, r.ppv_base_minor
    INTO v_r
  FROM supplier_returns r
  WHERE r.business_id = NEW.business_id AND r.binding_source_id = NEW.source_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accounting.inventory_detail_missing: a supplier return entry must be registered by its return in the same transaction'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT p.warehouse_id, p.currency_code, p.source_to_base_rate, p.rate_source, p.rate_timestamp INTO v_p
  FROM purchases p WHERE p.business_id = NEW.business_id AND p.id = v_r.purchase_id;
  SELECT b.base_currency INTO v_base_ccy FROM businesses b WHERE b.id = NEW.business_id;
  SELECT w.branch_id INTO v_pbranch FROM warehouses w WHERE w.business_id = NEW.business_id AND w.id = v_p.warehouse_id;
  SELECT w.branch_id INTO v_rbranch FROM warehouses w WHERE w.business_id = NEW.business_id AND w.id = v_r.warehouse_id;
  v_one     := (1::numeric(20,10))::text;
  v_ap_conv := v_r.ap_base_minor - v_r.ap_dust_base_minor;
  v_snap    := concat_ws('|', v_p.source_to_base_rate::text, v_p.rate_source, extract(epoch FROM v_p.rate_timestamp)::text);
  v_base    := concat_ws('|', v_one, 'base', extract(epoch FROM (v_r.document_date::timestamp AT TIME ZONE 'UTC'))::text);

  -- The expected lines (A-10(g)), each present only when its amount ≠ 0.
  v_expected := ARRAY[]::text[];
  IF v_r.ap_txn_minor <> 0 THEN
    v_expected := v_expected || concat_ws('|', 'accounts_payable', 'D', v_ap_conv::text, v_p.currency_code::text,
      v_r.ap_txn_minor::text, v_snap, '-', coalesce(v_pbranch::text, '-'));
  END IF;
  IF v_r.ap_dust_base_minor <> 0 THEN
    v_expected := v_expected || concat_ws('|', 'accounts_payable', CASE WHEN v_r.ap_dust_base_minor > 0 THEN 'D' ELSE 'C' END,
      abs(v_r.ap_dust_base_minor)::text, v_base_ccy, abs(v_r.ap_dust_base_minor)::text, v_base,
      '-', coalesce(v_pbranch::text, '-'));
  END IF;
  IF v_r.credit_txn_minor <> 0 THEN
    v_expected := v_expected || concat_ws('|', 'supplier_receivable', 'D', v_r.credit_base_minor::text, v_p.currency_code::text,
      v_r.credit_txn_minor::text, v_snap, '-', coalesce(v_pbranch::text, '-'));
  END IF;
  IF v_r.inventory_value_base_minor <> 0 THEN
    v_expected := v_expected || concat_ws('|', 'inventory', 'C', v_r.inventory_value_base_minor::text, v_base_ccy,
      v_r.inventory_value_base_minor::text, v_base, v_r.warehouse_id::text, coalesce(v_rbranch::text, '-'));
  END IF;
  IF v_r.ppv_base_minor <> 0 THEN
    v_expected := v_expected || concat_ws('|', 'purchase_price_variance', CASE WHEN v_r.ppv_base_minor > 0 THEN 'C' ELSE 'D' END,
      abs(v_r.ppv_base_minor)::text, v_base_ccy, abs(v_r.ppv_base_minor)::text, v_base,
      v_r.warehouse_id::text, coalesce(v_rbranch::text, '-'));
  END IF;
  SELECT array_agg(x ORDER BY x) INTO v_expected FROM unnest(v_expected) AS x;

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

  IF NEW.entry_date IS DISTINCT FROM v_r.document_date OR v_base_ccy IS NULL OR v_pbranch IS NULL OR v_rbranch IS NULL
     OR v_p.rate_timestamp IS NULL OR v_expected IS NULL OR v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'accounting.inventory_entry_mismatch: a supplier return entry is not exactly the A-10 lines of its return'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- (c) The purchase entry read (A-07, A-15(c), R-45): the id of the
--     `purchase` entry of a purchase, or NULL. Reachable only by the NOLOGIN
--     internal inventory principal (the routine's bound-value re-check and
--     the reversal header guard); it returns one id and reads no session
--     GUC, so a COMMIT-time guard may call it.
CREATE OR REPLACE FUNCTION accounting_purchase_entry_id(p_business_id UUID, p_purchase_id UUID) RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_id UUID;
BEGIN
  SELECT je.id INTO v_id FROM journal_entries je
   WHERE je.business_id = p_business_id AND je.source_type = 'purchase' AND je.source_id = p_purchase_id;
  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION accounting_purchase_entry_id(UUID, UUID) IS
  'P3-S5 A-15(c). The id of the journal entry of source type purchase for p_purchase_id in p_business_id, or NULL. STABLE, writes nothing. EXECUTE: daftar_inventory_internal only (the purchase reversal''s bound original entry, A-07, and its header guard); the inventory principal gains no SELECT on journal_entries.';

REVOKE ALL ON FUNCTION accounting_supplier_return_entry_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_purchase_entry_id(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accounting_purchase_entry_id(UUID, UUID) TO daftar_inventory_internal;

CREATE CONSTRAINT TRIGGER journal_entries_supplier_return_complete
  AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source_type = 'supplier_return')
  EXECUTE FUNCTION accounting_supplier_return_entry_complete();

ALTER FUNCTION accounting_supplier_return_entry_complete() OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_purchase_entry_id(UUID, UUID) OWNER TO daftar_accounting_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;

-- (e) The registries (A-05), with the owning operation kind the 0046 rule
--     requires. R-B2a: `purchase_reversal` is not an accounting source type;
--     its entry is a Phase 2 `reversal`.
INSERT INTO accounting_source_types (source_type, lower_bound_policy, upper_bound_policy, description, sort_order) VALUES
  ('supplier_return', 'none', 'not_after_today',
   'A supplier return: AP first, excess to supplier receivable, inventory at current average, PPV (P3-AL-29/30).', 8);
INSERT INTO accounting_operation_kinds (operation_kind, source_type, description) VALUES
  ('post', 'supplier_return', 'Supplier return; derived by the supplier return command.');

-- ─────────────────────────────────────────────────────────────────────────
-- 10. Refuse to commit unless the end state is exactly right (0065-E, §2.8).
--     `has_*_privilege` against the live catalogue. Every probe that
--     re-creates a trigger or replaces a body lends the internal owner the
--     privilege it needs inside the rolled-back block only (0063 R-40), so
--     the block runs unchanged as a non-superuser migrator.
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
  v_digest   TEXT;
  c_docs     CONSTANT TEXT[] := ARRAY['purchase_reversal_lines', 'purchase_reversals', 'supplier_credit_notes', 'supplier_return_lines',
                                      'supplier_returns'];
  c_bridges  CONSTANT TEXT[] := ARRAY['stock_source_bridge_purchase_reversal', 'stock_source_bridge_supplier_return'];
  c_runtime  CONSTANT TEXT[] := ARRAY['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver',
                                      'daftar_provisioner', 'daftar_reconciler', 'public'];
  c_privs    CONSTANT TEXT[] := ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  c_inv_fns  CONSTANT REGPROCEDURE[] := ARRAY[
    'stock_binding_requires_supplier_return()'::regprocedure,
    'stock_binding_requires_purchase_reversal()'::regprocedure,
    'stock_source_complete_supplier_return()'::regprocedure,
    'stock_source_complete_supplier_return_header()'::regprocedure,
    'supplier_return_value_complete()'::regprocedure,
    'supplier_return_quantity_bound()'::regprocedure,
    'stock_source_complete_purchase_reversal()'::regprocedure,
    'stock_source_complete_purchase_reversal_header()'::regprocedure,
    'purchase_reversal_value_complete()'::regprocedure,
    'supplier_return_detail_same_transaction()'::regprocedure,
    'purchase_reversal_detail_same_transaction()'::regprocedure,
    'supplier_credit_note_guard()'::regprocedure];
  c_acc_fns  CONSTANT REGPROCEDURE[] := ARRAY[
    'accounting_supplier_return_entry_complete()'::regprocedure,
    'accounting_purchase_entry_id(uuid,uuid)'::regprocedure,
    'accounting_reversals_20_domain_source_guard()'::regprocedure];
  -- The twenty-nine S3/S4 digests 0063 records (§2.3 "kept byte-for-byte").
  c_s3s4_digests CONSTANT TEXT[] := ARRAY[
    '2b6be55eba2569a34816d6ad4154ece7138500f58f0f58253c52d2a891e1f01a',
    'f8a0aaa2ba51e777ff3992750237601ebfb927636a55f1a1816a507ff2d2d430',
    '3e54199bec0101135d4ea687c858dc514244a6cbd4f4e2aa7225f293b34dcdba',
    '4695f38364e51b8f19fb97627b94123e41792fb9e0889b6613b3734e305ad4f9',
    '7a8363f5b004f9853c935eca03339bfabc30c340cfbef93e7d56fe9d19b5b59d',
    'd4ca51a9d61eb6fdba9be52f6c3e9fa2fc4b4f1da67fdc792ed5e889ac13d9bc',
    '893163f6bcfd133c4e5e270647870dec1c9ce9a017952e66a1c5aa9d767702af',
    '0e192f181e2512b74051c668ccfbaf4549ff2793008a8581ed992e0c65c602d5',
    '3bd8424be82ab8aa94707d3f1b2d04ad74abacaea8ae32f860ea16aaa4716c15',
    '71b4f35571d748bf76b7a9b2b8bfa407af755dc4420c39e26532f9905659686f',
    'e70ba4c9c0c87a4b76050f77afb9e36d8bfac7195439d2438871d2822f488d45',
    '049e3e439c8d4e33a79bc932c937dc45b824b79718587604e627a1cfa2fb7c4a',
    '2e29261988cc961a5c9a052709b78a32a6fd49509d263875b97527992b905717',
    '507f40e4d0d472a6e787865b5a779c6f69ecfb651875ba14df57fe8fd8f54cbe',
    '4d646c5d5db4aa49e544033d02cc24fd007899dab833637cb8020a49611c2828',
    '908bc14db1094becba6402c0171237a5d91481874a55dd16eef17894cc59d5d4',
    '2f4a78a635df4ea85a0eb9a898752c80860badd64a68ce4038a3c081d9075e3f',
    'bf707fa32e584fb9e01f88a4766f8788dc32f2b96b5d59fd50ed9861e8b75cfa',
    '7a49c422e4e56c628ac1b4e6e45d8af0c9dcdc049bcc614e0f7829f80a050b58',
    '28f7f06240e62911f7b68efa3256e753443bf67c4ecf893ab174895a79582154',
    '6c6522559afc458e9fd9ce230214372b5f95c65938ca869ce435f326dd4fd19f',
    '97adaaaa95a5b2c18e80d34ea26a4eee5e397e1bf25dd727ddfc9a0cf86f31ab',
    '09da86dc079e39ef7a60f1625c364b6e4644aad9b795b87245cc6d6749a3db4c',
    '033535f199feae9d1747772d3cf32cfbe9f07979fa05f48471ac73475b4e7a9e',
    '3eda69587e6a9a8046ff1d7852e1ac7d0dec0d05ae633d1b78663a091634379a',
    'ac783691817646b8ac3528766a3203ec30c3f594a6f997b7f5779504ab625748',
    '77e09d0b7e15b2368ca2ace6f7de5933964777c5b3e5a1f58fb5723eb156b663',
    'a6fb57abb419fea3eb0f75c1c81ee0189226c5354fca7fe6197fb0f1ae76a925',
    '883da444f892ddbb0ad16f5d77c124057f46304e966262b80a63c3bfc1867b6b'];
BEGIN
  -- (1) The four S3, the two S4 and exactly the two S5 stock source types.
  SELECT array_agg(t.source_type || ':' || t.registered_by ORDER BY t.source_type) INTO v_actual FROM stock_source_types t;
  IF v_actual IS DISTINCT FROM ARRAY['inventory_adjustment:P3-S3', 'inventory_opening:P3-S3', 'inventory_transfer:P3-S3',
                                     'negative_inventory_cost_adjustment:P3-S4', 'purchase:P3-S4', 'purchase_reversal:P3-S5',
                                     'stocktake:P3-S3', 'supplier_return:P3-S5'] THEN
    RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: stock_source_types is not exactly the P3-S3, P3-S4 and P3-S5 types, found %', v_actual;
  END IF;

  -- (2) Every registered source type is fully guarded, the S3/S4 digests are
  --     kept verbatim, and the replaced discovery is live for S5: each §2.3
  --     mutation, inside a rolled-back block, is reported.
  IF EXISTS (SELECT 1 FROM inventory_stock_source_guard_gaps()) THEN
    SELECT string_agg(g.source_type || ':' || g.missing, ', ') INTO v_detail FROM inventory_stock_source_guard_gaps() g;
    RAISE EXCEPTION 'inventory.source_guard_missing: a registered stock source type lacks a guard: %', v_detail;
  END IF;
  SELECT p.prosrc INTO v_def FROM pg_proc p WHERE p.oid = 'inventory_stock_source_guard_gaps()'::regprocedure;
  FOREACH v_digest IN ARRAY c_s3s4_digests LOOP
    IF position(v_digest IN v_def) = 0 THEN
      RAISE EXCEPTION 'inventory.source_guard_missing: the replaced discovery lost the recorded S3/S4 digest %', v_digest;
    END IF;
  END LOOP;
  IF cardinality(c_s3s4_digests) <> 29 THEN
    RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: the S3/S4 digest record is not the twenty-nine of 0063';
  END IF;
  BEGIN
    ALTER TABLE stock_source_bridge_supplier_return DISABLE TRIGGER stock_bridge_immutable_supplier_return;
    SELECT string_agg(g.source_type || ':' || g.missing, ', ' ORDER BY g.source_type, g.missing) INTO v_detail FROM inventory_stock_source_guard_gaps() g;
    RAISE EXCEPTION 'inventory.probe_rollback: %', coalesce(v_detail, '');
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_detail = MESSAGE_TEXT;
  END;
  IF v_detail IS DISTINCT FROM 'inventory.probe_rollback: supplier_return:bridge_immutable' THEN
    RAISE EXCEPTION 'inventory.source_guard_missing: the replaced discovery did not report a disabled supplier-return bridge guard (%)', v_detail;
  END IF;
  -- The body digest: the owner replaces the reversal line guard with a
  -- no-op of the same signature, owner, security and path.
  BEGIN
    GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;
    SET LOCAL ROLE daftar_inventory_internal;
    CREATE OR REPLACE FUNCTION stock_source_complete_purchase_reversal() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $probe$
    BEGIN
      RETURN NULL;
    END;
    $probe$;
    RESET ROLE;
    REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;
    SELECT string_agg(g.source_type || ':' || g.missing, ', ' ORDER BY g.source_type, g.missing) INTO v_detail FROM inventory_stock_source_guard_gaps() g;
    RAISE EXCEPTION 'inventory.probe_rollback: %', coalesce(v_detail, '');
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_detail = MESSAGE_TEXT;
  END;
  IF v_detail IS DISTINCT FROM 'inventory.probe_rollback: purchase_reversal:source_complete' THEN
    RAISE EXCEPTION 'inventory.source_guard_missing: the replaced discovery did not report a neutered reversal line guard body (%)', v_detail;
  END IF;
  -- The quantity bound re-pointed at another S5 function (R-40: the owner
  -- re-creates it under a TRIGGER privilege lent inside the probe only).
  BEGIN
    DROP TRIGGER supplier_return_lines_quantity_bound ON supplier_return_lines;
    GRANT TRIGGER ON supplier_return_lines TO daftar_inventory_internal;
    SET LOCAL ROLE daftar_inventory_internal;
    CREATE CONSTRAINT TRIGGER supplier_return_lines_quantity_bound AFTER INSERT ON supplier_return_lines
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION supplier_return_value_complete();
    RESET ROLE;
    SELECT string_agg(g.source_type || ':' || g.missing, ', ' ORDER BY g.source_type, g.missing) INTO v_detail FROM inventory_stock_source_guard_gaps() g;
    RAISE EXCEPTION 'inventory.probe_rollback: %', coalesce(v_detail, '');
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_detail = MESSAGE_TEXT;
  END;
  IF v_detail IS DISTINCT FROM 'inventory.probe_rollback: supplier_return:quantity_bound' THEN
    RAISE EXCEPTION 'inventory.source_guard_missing: the replaced discovery did not report a re-pointed quantity bound (%)', v_detail;
  END IF;
  BEGIN
    ALTER TABLE supplier_returns ENABLE REPLICA TRIGGER supplier_returns_value_complete;
    SELECT string_agg(g.source_type || ':' || g.missing, ', ' ORDER BY g.source_type, g.missing) INTO v_detail FROM inventory_stock_source_guard_gaps() g;
    RAISE EXCEPTION 'inventory.probe_rollback: %', coalesce(v_detail, '');
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_detail = MESSAGE_TEXT;
  END;
  IF v_detail IS DISTINCT FROM 'inventory.probe_rollback: supplier_return:value_complete' THEN
    RAISE EXCEPTION 'inventory.source_guard_missing: the replaced discovery did not report a replica-only value guard (%)', v_detail;
  END IF;
  -- 0063 R-36/R-38 carried forward: the same-transaction guards are seen
  -- with a neutered body, and INSERT-blind.
  BEGIN
    GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;
    SET LOCAL ROLE daftar_inventory_internal;
    CREATE OR REPLACE FUNCTION purchase_reversal_detail_same_transaction() RETURNS trigger
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
  IF v_detail IS DISTINCT FROM 'inventory.probe_rollback: purchase_reversal:line_same_transaction' THEN
    RAISE EXCEPTION 'inventory.source_guard_missing: the replaced discovery did not report a neutered same-transaction body (%)', v_detail;
  END IF;
  BEGIN
    DROP TRIGGER supplier_credit_notes_same_transaction ON supplier_credit_notes;
    GRANT TRIGGER ON supplier_credit_notes TO daftar_inventory_internal;
    SET LOCAL ROLE daftar_inventory_internal;
    CREATE TRIGGER supplier_credit_notes_same_transaction BEFORE UPDATE ON supplier_credit_notes
      FOR EACH ROW EXECUTE FUNCTION supplier_return_detail_same_transaction();
    RESET ROLE;
    SELECT string_agg(g.source_type || ':' || g.missing, ', ' ORDER BY g.source_type, g.missing) INTO v_detail FROM inventory_stock_source_guard_gaps() g;
    RAISE EXCEPTION 'inventory.probe_rollback: %', coalesce(v_detail, '');
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_detail = MESSAGE_TEXT;
  END;
  IF v_detail IS DISTINCT FROM 'inventory.probe_rollback: supplier_return:credit_note_same_transaction' THEN
    RAISE EXCEPTION 'inventory.source_guard_missing: the replaced discovery did not report an INSERT-blind credit-note guard (%)', v_detail;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgname = 'stock_bridge_immutable_supplier_return' AND g.tgenabled = 'O')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgname = 'supplier_returns_value_complete' AND g.tgenabled = 'O')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgname = 'supplier_return_lines_quantity_bound'
                      AND g.tgfoid = 'supplier_return_quantity_bound()'::regprocedure)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgname = 'supplier_credit_notes_same_transaction' AND g.tgtype = 7)
     OR EXISTS (SELECT 1 FROM inventory_stock_source_guard_gaps())
     OR has_schema_privilege('daftar_inventory_internal', 'public', 'CREATE')
     OR has_table_privilege('daftar_inventory_internal', 'supplier_return_lines', 'TRIGGER')
     OR has_table_privilege('daftar_inventory_internal', 'supplier_credit_notes', 'TRIGGER') THEN
    RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: a discovery probe did not roll back';
  END IF;

  -- (3) The accounting source registry: the seven earlier rows unchanged plus
  --     supplier_return at 8, and no purchase_reversal (R-B2a); every
  --     registered source type owned (0046).
  SELECT array_agg(s.source_type || ':' || s.lower_bound_policy || ':' || s.upper_bound_policy || ':' || s.sort_order ORDER BY s.sort_order)
    INTO v_actual FROM accounting_source_types s WHERE s.sort_order > 3;
  IF v_actual IS DISTINCT FROM ARRAY['inventory_adjustment:none:not_after_today:4', 'inventory_opening:none:not_after_today:5',
                                     'purchase:none:not_after_today:6', 'negative_inventory_cost_adjustment:none:not_after_today:7',
                                     'supplier_return:none:not_after_today:8'] THEN
    RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: accounting_source_types beyond the natives is not exactly the P3-S3, P3-S4 and P3-S5 rows, found %', v_actual;
  END IF;
  SELECT array_agg(s.source_type ORDER BY s.sort_order) INTO v_actual FROM accounting_source_types s WHERE s.sort_order <= 3;
  IF v_actual IS DISTINCT FROM ARRAY['opening_balance', 'manual_adjustment', 'reversal'] THEN
    RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: the native accounting source types changed, found %', v_actual;
  END IF;
  SELECT array_agg(k.operation_kind || ':' || k.source_type ORDER BY k.source_type) INTO v_actual FROM accounting_operation_kinds k;
  IF v_actual IS DISTINCT FROM ARRAY['post:inventory_adjustment', 'post:inventory_opening', 'post:manual_adjustment',
                                     'post:negative_inventory_cost_adjustment', 'post:opening_balance', 'post:purchase',
                                     'reverse:reversal', 'post:supplier_return'] THEN
    RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: accounting_operation_kinds is not the earlier seven plus the P3-S5 pair, found %', v_actual;
  END IF;
  IF EXISTS (SELECT 1 FROM accounting_source_types st
              WHERE NOT EXISTS (SELECT 1 FROM accounting_operation_kinds k
                                 WHERE k.source_type = st.source_type AND k.operation_kind IN ('post', 'reverse'))) THEN
    RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: a registered accounting source type has no post or reverse kind';
  END IF;

  -- (4) The two candidate keys and every S5 FK, validated; the two identity
  --     CHECKs present.
  IF (SELECT count(*) FROM pg_constraint c
       WHERE c.convalidated AND c.contype = 'u'
         AND ((c.conname = 'purchases_supplier_uq' AND c.conrelid = 'public.purchases'::regclass)
           OR (c.conname = 'purchase_lines_line_variant_uq' AND c.conrelid = 'public.purchase_lines'::regclass))) <> 2 THEN
    RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: a P3-S5 candidate key on an S4 table is missing or not validated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint c
              WHERE c.contype = 'f' AND NOT c.convalidated
                AND c.conrelid = ANY (ARRAY(SELECT ('public.' || t)::regclass FROM unnest(c_docs || c_bridges) AS t)))
     OR (SELECT count(*) FROM pg_constraint c
          WHERE c.contype = 'f'
            AND c.conrelid = ANY (ARRAY(SELECT ('public.' || t)::regclass FROM unnest(c_docs || c_bridges) AS t))) <> 26 THEN
    RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: the P3-S5 foreign keys are not exactly the twenty-six validated ones';
  END IF;
  IF (SELECT count(*) FROM pg_constraint c
       WHERE c.contype = 'c'
         AND ((c.conname = 'purchase_reversals_identity_ck' AND c.conrelid = 'public.purchase_reversals'::regclass
               AND pg_get_constraintdef(c.oid) = 'CHECK ((id = purchase_id))')
           OR (c.conname = 'purchase_reversal_lines_identity_ck' AND c.conrelid = 'public.purchase_reversal_lines'::regclass
               AND pg_get_constraintdef(c.oid) = 'CHECK ((reversal_id = purchase_id))'))) <> 2 THEN
    RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: a reversal identity CHECK is missing';
  END IF;

  -- (5) The A-18 grant matrix, exactly: no runtime role holds DML on an S5
  --     table; daftar_app reads exactly the five documents; the internal
  --     principal holds exactly INSERT, SELECT on the five and the two
  --     bridges; the accounting principal reads the two posting headers.
  FOREACH v_table IN ARRAY c_docs || c_bridges LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = ('public.' || v_table)::regclass
                     AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity) THEN
      RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: row security is not enabled and forced on %', v_table;
    END IF;
    FOREACH v_role IN ARRAY c_runtime LOOP
      FOREACH v_priv IN ARRAY c_privs LOOP
        IF has_table_privilege(v_role, v_table, v_priv)
           AND NOT (v_role = 'daftar_app' AND v_priv = 'SELECT' AND v_table <> ALL (c_bridges)) THEN
          RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: % holds % on %', v_role, v_priv, v_table;
        END IF;
      END LOOP;
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
        IF has_any_column_privilege(v_role, v_table, v_priv)
           AND NOT (v_role = 'daftar_app' AND v_priv = 'SELECT' AND v_table <> ALL (c_bridges)) THEN
          RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: % holds column-level % on %', v_role, v_priv, v_table;
        END IF;
      END LOOP;
    END LOOP;
    IF v_table <> ALL (c_bridges) AND NOT has_table_privilege('daftar_app', v_table, 'SELECT') THEN
      RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: daftar_app cannot read %', v_table;
    END IF;
  END LOOP;

  -- 0063 R-35: on every S5 table the restrictive isolation is exactly one
  -- policy per command, and only the FOR SELECT one admits a principal by
  -- name.
  FOREACH v_table IN ARRAY c_docs || c_bridges LOOP
    SELECT array_agg(p.polname::text || ':' || p.polcmd::text ORDER BY p.polname) INTO v_actual
    FROM pg_policy p WHERE p.polrelid = ('public.' || v_table)::regclass AND NOT p.polpermissive;
    IF v_actual IS DISTINCT FROM ARRAY['business_isolation_delete:d', 'business_isolation_insert:a',
                                       'business_isolation_read:r', 'business_isolation_update:w'] THEN
      RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: % restrictive isolation is not one policy per command, found %', v_table, v_actual;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policy p
                WHERE p.polrelid = ('public.' || v_table)::regclass AND NOT p.polpermissive AND p.polcmd <> 'r'
                  AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '(app_bypass() OR (business_id = (NULLIF(app_business(), ''''::text))::uuid))')
                         <> '(app_bypass() OR (business_id = (NULLIF(app_business(), ''''::text))::uuid))'
                       OR coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '(app_bypass() OR (business_id = (NULLIF(app_business(), ''''::text))::uuid))')
                         <> '(app_bypass() OR (business_id = (NULLIF(app_business(), ''''::text))::uuid))')) THEN
      RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: a restrictive write policy on % admits more than its own business', v_table;
    END IF;
  END LOOP;

  v_expected := ARRAY[]::text[];
  FOREACH v_table IN ARRAY c_docs || c_bridges LOOP
    v_expected := v_expected || (v_table || ':INSERT') || (v_table || ':SELECT');
  END LOOP;
  SELECT array_agg(x ORDER BY x) INTO v_expected FROM unnest(v_expected) AS x;
  SELECT array_agg(t || ':' || p ORDER BY t || ':' || p) INTO v_actual
  FROM unnest(c_docs || c_bridges) AS t CROSS JOIN unnest(c_privs) AS p
  WHERE has_table_privilege('daftar_inventory_internal', t, p)
     OR CASE WHEN p IN ('UPDATE', 'REFERENCES') THEN has_any_column_privilege('daftar_inventory_internal', t, p) ELSE false END;
  IF v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: daftar_inventory_internal privileges on the S5 tables are not exactly A-18, found %', v_actual;
  END IF;
  SELECT array_agg(t || ':' || p ORDER BY t || ':' || p) INTO v_actual
  FROM unnest(c_docs || c_bridges) AS t CROSS JOIN unnest(c_privs) AS p
  WHERE has_table_privilege('daftar_accounting_internal', t, p)
     OR CASE WHEN p IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
             THEN has_any_column_privilege('daftar_accounting_internal', t, p) ELSE false END;
  IF v_actual IS DISTINCT FROM ARRAY['purchase_reversals:SELECT', 'supplier_returns:SELECT'] THEN
    RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: daftar_accounting_internal holds more than A-15(d) on the S5 tables, found %', v_actual;
  END IF;

  -- (6) Every new function: owner, DEFINER, pinned path; no runtime role
  --     executes it; accounting_purchase_entry_id by the internal inventory
  --     principal only. Every trigger by table, name, tgtype, function,
  --     deferral and enabled state.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_detail
  FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
  WHERE (p.oid = ANY (c_inv_fns) AND r.rolname <> 'daftar_inventory_internal')
     OR (p.oid = ANY (c_acc_fns) AND r.rolname <> 'daftar_accounting_internal')
     OR ((p.oid = ANY (c_inv_fns) OR p.oid = ANY (c_acc_fns))
         AND (NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']));
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: function(s) with the wrong owner, security or path: %', v_detail;
  END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.oid = ANY (c_inv_fns) OR p.oid = ANY (c_acc_fns)) <> 15 THEN
    RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: a P3-S5 source-side function is missing';
  END IF;
  FOREACH v_fn IN ARRAY c_inv_fns || c_acc_fns || ARRAY['inventory_stock_source_guard_gaps()'::regprocedure,
                                                          'inventory_apply_stock_movements(inventory_movement_request[])'::regprocedure] LOOP
    FOREACH v_role IN ARRAY c_runtime || ARRAY['daftar_accounting_internal'] LOOP
      IF has_function_privilege(v_role, v_fn, 'EXECUTE')
         AND NOT (v_role = 'daftar_accounting_internal' AND v_fn = ANY (c_acc_fns)) THEN
        RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: % may execute %', v_role, v_fn;
      END IF;
    END LOOP;
    IF v_fn <> 'accounting_purchase_entry_id(uuid,uuid)'::regprocedure
       AND (SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) x
             WHERE p.oid = v_fn AND x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner) > 0 THEN
      RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: % has an EXECUTE grantee', v_fn;
    END IF;
  END LOOP;
  SELECT array_agg(x.grantee::regrole::text ORDER BY x.grantee::regrole::text) INTO v_actual
  FROM pg_proc p, aclexplode(p.proacl) x
  WHERE p.oid = 'accounting_purchase_entry_id(uuid,uuid)'::regprocedure AND x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner;
  IF v_actual IS DISTINCT FROM ARRAY['daftar_inventory_internal']
     OR (SELECT p.provolatile FROM pg_proc p WHERE p.oid = 'accounting_purchase_entry_id(uuid,uuid)'::regprocedure) <> 's' THEN
    RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: accounting_purchase_entry_id must be STABLE and executable by daftar_inventory_internal only, found %', v_actual;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'inventory_stock_source_guard_gaps()'::regprocedure
               AND (p.prosecdef OR p.provolatile <> 's' OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
                    OR pg_get_function_result(p.oid) <> 'TABLE(source_type text, missing text)'
                    OR p.proowner::regrole::text <> current_user)) THEN
    RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: inventory_stock_source_guard_gaps changed its contract';
  END IF;

  WITH expected (tbl, tg, typ, fn, owner, definer, deferred) AS (VALUES
    ('stock_source_bindings', 'stock_binding_requires_supplier_return', 5, 'stock_binding_requires_supplier_return()', 'daftar_inventory_internal', true, true),
    ('stock_source_bindings', 'stock_binding_requires_purchase_reversal', 5, 'stock_binding_requires_purchase_reversal()', 'daftar_inventory_internal', true, true),
    ('stock_source_bridge_supplier_return', 'stock_bridge_immutable_supplier_return', 27, 'stock_ledger_append_only()', NULL, false, false),
    ('stock_source_bridge_purchase_reversal', 'stock_bridge_immutable_purchase_reversal', 27, 'stock_ledger_append_only()', NULL, false, false),
    ('supplier_return_lines', 'stock_source_complete_supplier_return', 5, 'stock_source_complete_supplier_return()', 'daftar_inventory_internal', true, true),
    ('supplier_returns', 'supplier_returns_complete', 5, 'stock_source_complete_supplier_return_header()', 'daftar_inventory_internal', true, true),
    ('supplier_return_lines', 'stock_source_freeze_supplier_return', 27, 'stock_ledger_append_only()', NULL, false, false),
    ('supplier_returns', 'supplier_returns_immutable', 27, 'stock_ledger_append_only()', NULL, false, false),
    ('supplier_returns', 'supplier_returns_value_complete', 5, 'supplier_return_value_complete()', 'daftar_inventory_internal', true, true),
    ('supplier_return_lines', 'supplier_return_lines_quantity_bound', 5, 'supplier_return_quantity_bound()', 'daftar_inventory_internal', true, true),
    ('supplier_return_lines', 'supplier_return_lines_same_transaction', 7, 'supplier_return_detail_same_transaction()',
     'daftar_inventory_internal', true, false),
    ('supplier_credit_notes', 'supplier_credit_notes_same_transaction', 7, 'supplier_return_detail_same_transaction()',
     'daftar_inventory_internal', true, false),
    ('supplier_credit_notes', 'supplier_credit_notes_immutable', 27, 'supplier_credit_note_guard()', 'daftar_inventory_internal', true, false),
    ('purchase_reversal_lines', 'stock_source_complete_purchase_reversal', 5, 'stock_source_complete_purchase_reversal()',
     'daftar_inventory_internal', true, true),
    ('purchase_reversals', 'purchase_reversals_complete', 5, 'stock_source_complete_purchase_reversal_header()',
     'daftar_inventory_internal', true, true),
    ('purchase_reversal_lines', 'stock_source_freeze_purchase_reversal', 27, 'stock_ledger_append_only()', NULL, false, false),
    ('purchase_reversals', 'purchase_reversals_immutable', 27, 'stock_ledger_append_only()', NULL, false, false),
    ('purchase_reversals', 'purchase_reversals_value_complete', 5, 'purchase_reversal_value_complete()', 'daftar_inventory_internal', true, true),
    ('purchase_reversal_lines', 'purchase_reversal_lines_same_transaction', 7, 'purchase_reversal_detail_same_transaction()',
     'daftar_inventory_internal', true, false),
    ('journal_entries', 'journal_entries_supplier_return_complete', 5, 'accounting_supplier_return_entry_complete()',
     'daftar_accounting_internal', true, true),
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
    RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: trigger(s) missing or mis-shaped: %', v_detail;
  END IF;
  -- The WHEN filters that keep Budget A and the other source types
  -- untouched, and no S5 document guard is conditional; the S5 tables carry
  -- no other trigger.
  IF (SELECT count(*) FROM pg_trigger g
       WHERE g.tgname IN ('journal_entries_supplier_return_complete', 'stock_binding_requires_supplier_return',
                          'stock_binding_requires_purchase_reversal')
         AND g.tgqual IS NOT NULL) <> 3
     OR EXISTS (SELECT 1 FROM pg_trigger g
                 WHERE g.tgrelid = ANY (ARRAY(SELECT ('public.' || t)::regclass FROM unnest(c_docs || c_bridges) AS t))
                   AND NOT g.tgisinternal AND (g.tgqual IS NOT NULL OR cardinality(g.tgattr::int2[]) <> 0))
     OR (SELECT count(*) FROM pg_trigger g
          WHERE g.tgrelid = ANY (ARRAY(SELECT ('public.' || t)::regclass FROM unnest(c_docs || c_bridges) AS t))
            AND NOT g.tgisinternal) <> 17 THEN
    RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: a P3-S5 trigger lost its WHEN clause, a document guard gained one, or an S5 table carries another trigger';
  END IF;

  -- (7) The reversal guard names the four always-refused domain types, the
  --     paired purchase_reversals row, and keeps its R-13 refusal.
  SELECT p.prosrc INTO v_def FROM pg_proc p WHERE p.oid = 'accounting_reversals_20_domain_source_guard()'::regprocedure;
  IF position('''inventory_adjustment'', ''inventory_opening'', ''negative_inventory_cost_adjustment'', ''supplier_return''' IN v_def) = 0
     OR position('je.source_type = ''purchase''' IN v_def) = 0 OR position('FROM purchase_reversals r' IN v_def) = 0
     OR position('r.original_entry_id = NEW.original_entry_id' IN v_def) = 0
     OR position('FROM accounting_opening_balances ob' IN v_def) = 0 OR position('FOR NO KEY UPDATE' IN v_def) = 0
     OR position('accounting.opening_balance_inventory_bound:' IN v_def) = 0 THEN
    RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: the reversal guard does not refuse the domain-owned source types as R-38 states';
  END IF;

  -- (8) R-B1a: the primitive carries the purchase_reversal branch, keeps its
  --     owner and has no EXECUTE grantee.
  SELECT p.prosrc INTO v_def FROM pg_proc p WHERE p.oid = 'inventory_apply_stock_movements(inventory_movement_request[])'::regprocedure;
  IF position('movement_kind = ''purchase_reversal''' IN v_def) = 0 OR position('inventory.reversal_valuation_residue' IN v_def) = 0
     OR (SELECT r.rolname FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
          WHERE p.oid = 'inventory_apply_stock_movements(inventory_movement_request[])'::regprocedure) <> 'daftar_inventory_internal'
     OR NOT (SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp'] FROM pg_proc p
              WHERE p.oid = 'inventory_apply_stock_movements(inventory_movement_request[])'::regprocedure) THEN
    RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: the stock primitive does not carry the R-B1a reversal branch under its owner';
  END IF;

  -- (9) The credit-note guard (A-11(e)): checked in the trigger matrix
  --     above (tgtype 27, enabled, no WHEN, internal DEFINER pinned); its
  --     body refuses unconditionally.
  SELECT p.prosrc INTO v_def FROM pg_proc p WHERE p.oid = 'supplier_credit_note_guard()'::regprocedure;
  IF position('supplier_credit_note.immutable:' IN v_def) = 0 OR position('RETURN' IN v_def) > 0 THEN
    RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: supplier_credit_note_guard does not refuse every change';
  END IF;

  -- (10) Neither internal principal keeps CREATE on public, and no role
  --      gained an attribute; nothing can reach the new tables yet.
  IF has_schema_privilege('daftar_inventory_internal', 'public', 'CREATE')
     OR has_schema_privilege('daftar_accounting_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: an internal principal still holds CREATE on schema public';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('daftar_inventory_internal', 'daftar_accounting_internal')
               AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolinherit)) THEN
    RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: an internal principal is no longer an unreachable NOLOGIN NOINHERIT role';
  END IF;
  IF EXISTS (SELECT 1 FROM inventory_operation_kinds k WHERE k.op_code IN ('purchase.return', 'purchase.reverse'))
     OR EXISTS (SELECT 1 FROM inventory_operation_movement_kinds m WHERE m.movement_kind IN ('supplier_return', 'purchase_reversal')) THEN
    RAISE EXCEPTION 'supplier_return.migration_end_state_invalid: an S5 operation kind or mapping exists before its routine (0066)';
  END IF;
END $$;

COMMENT ON TABLE supplier_returns IS
  'P3-S5 A-04, A-10. A supplier return: insert-only, one purchase and one warehouse; AP first at purchase level, the excess to a supplier credit note; inventory out at the return key''s average; PPV = ap_base + credit_base - inventory_value. Posts one supplier_return entry.';
COMMENT ON TABLE supplier_return_lines IS
  'P3-S5 A-10(a), A-12. One returned purchase line: its cumulative carrying value, its movement''s average snapshot and value out. Insert-only.';
COMMENT ON TABLE supplier_credit_notes IS
  'P3-S5 A-11. The excess of a return over the purchase''s outstanding AP, in the purchase currency and snapshot. Immutable in S5 (supplier_credit_note_guard); S6 admits the AL-31 decrement.';
COMMENT ON TABLE purchase_reversals IS
  'P3-S5 A-04, A-09. The reversal of a received purchase; its id IS the purchase id, so a purchase is reversed iff this row exists (the derived state, R-36). Posts the Phase 2 reversal of the purchase entry (R-B2a).';
COMMENT ON TABLE purchase_reversal_lines IS
  'P3-S5 A-09. One reversed purchase line (its id IS the purchase line id): the exact negation of its purchase movement (R-37). Insert-only.';
