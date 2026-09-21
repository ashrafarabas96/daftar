-- 0040 — ACCOUNTING CHART OF ACCOUNTS (Phase 2, slice P2-S1).
--
-- Implements AL-05 (account lifecycle), AL-06 (localization without a
-- translation table), AL-07 (system_key is the engine identity) and AL-08
-- (atomic seeding for new businesses + backfill for existing ones).
--
-- What this migration deliberately does NOT do:
--   * no journal_entries, no journal_lines, no source bindings, no posting
--     primitive — those are P2-S2/P2-S3 and must not exist yet;
--   * no authoritative balance column anywhere (AL-15 / guard G-3): the
--     journal will be the single financial source of truth;
--   * no DML grant on accounts to any merchant runtime role — the chart is
--     created only by the seeding routine below;
--   * businesses.financial_started_at is NEVER written here. Owning a chart
--     is not a financial transaction, so the base currency stays unlocked.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The global, closed system-account-key registry.
--
-- This is the ACCOUNTING ENGINE identity. It is global (not business-scoped)
-- reference data, exactly like `currencies` in 0002/0006: no RLS, SELECT-only
-- grants, no DML reachable by any runtime role.
--
-- default_code is ONLY the default chart code. A country pack may renumber a
-- business's accounts later; system_key must survive that, which is why the
-- engine never addresses an account by code, name or UUID.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE accounting_system_account_keys (
  system_key   TEXT PRIMARY KEY CHECK (system_key ~ '^[a-z][a-z0-9_]{1,62}$'),
  account_type TEXT NOT NULL CHECK (account_type IN ('asset','liability','equity','revenue','expense')),
  default_code TEXT NOT NULL UNIQUE CHECK (default_code ~ '^[0-9]{4}$'),
  seed_name    TEXT NOT NULL CHECK (char_length(seed_name) BETWEEN 1 AND 120),
  sort_order   INTEGER NOT NULL UNIQUE CHECK (sort_order > 0),
  -- Composite target so `accounts` can bind (system_key, type) as ONE fact.
  UNIQUE (system_key, account_type)
);

COMMENT ON TABLE accounting_system_account_keys IS
  'Closed registry of DAFTAR accounting system identities (docs/DAFTAR_ACCOUNTING_RULES.md §2). system_key is the engine identity; default_code and seed_name are presentation defaults only.';

-- The 21 Phase 2 system identities. Names are the stable fallback labels; the
-- merchant-facing display name comes from the i18n key accounting.account.<system_key>
-- (AL-06) — persistence never depends on translated text.
INSERT INTO accounting_system_account_keys (system_key, account_type, default_code, seed_name, sort_order) VALUES
  ('cash',                      'asset',     '1000', 'Cash on Hand',              1),
  ('bank',                      'asset',     '1010', 'Bank',                      2),
  ('card_clearing',             'asset',     '1020', 'Card Clearing',             3),
  ('wallet_clearing',           'asset',     '1030', 'Wallet Clearing',           4),
  ('cheque_clearing',           'asset',     '1040', 'Cheques Clearing',          5),
  ('accounts_receivable',       'asset',     '1100', 'Accounts Receivable',       6),
  ('supplier_receivable',       'asset',     '1150', 'Supplier Receivable',       7),
  ('inventory',                 'asset',     '1200', 'Inventory',                 8),
  ('accounts_payable',          'liability', '2000', 'Accounts Payable',          9),
  ('tax_payable',               'liability', '2100', 'Tax Payable',              10),
  ('customer_refund_liability', 'liability', '2200', 'Customer Refund Liability', 11),
  ('customer_credit_liability', 'liability', '2210', 'Customer Credit Liability', 12),
  ('opening_equity',            'equity',    '3000', 'Equity / Opening',         13),
  ('sales_revenue',             'revenue',   '4000', 'Sales Revenue',            14),
  ('sales_returns',             'revenue',   '4100', 'Sales Returns',            15),
  ('discounts',                 'revenue',   '4200', 'Discounts',                16),
  ('fx_gain',                   'revenue',   '4900', 'Realized FX Gain',         17),
  ('cogs',                      'expense',   '5000', 'Cost of Goods Sold',       18),
  ('rounding',                  'expense',   '6100', 'Rounding Adjustment',      19),
  ('purchase_price_variance',   'expense',   '6200', 'Purchase Price Variance',  20),
  ('fx_loss',                   'expense',   '6900', 'Realized FX Loss',         21);

-- The registry is closed for Phase 2: exactly 21 identities, asserted here so
-- a future edit to the INSERT above cannot silently change the contract.
DO $$
DECLARE v_n INTEGER;
BEGIN
  SELECT count(*) INTO v_n FROM accounting_system_account_keys;
  IF v_n <> 21 THEN
    RAISE EXCEPTION 'accounting system key registry must hold exactly 21 Phase 2 identities, found %', v_n;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. accounts — business-owned chart of accounts.
--
-- Composite ownership follows the Phase 1 convention (branches/warehouses):
-- PRIMARY KEY (business_id, id), so a future journal_lines can reference
-- (business_id, account_id) without redesigning this table.
--
-- tenant_id is carried and composite-bound to businesses (tenant_id, id) via
-- the 0016 unique constraint, so an account can never claim tenant A while
-- belonging to a business of tenant B.
--
-- NO balance column, by design (AL-15, guard G-3).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE accounts (
  tenant_id   UUID NOT NULL,
  business_id UUID NOT NULL,
  id          UUID NOT NULL DEFAULT gen_random_uuid(),
  code        TEXT NOT NULL CHECK (code ~ '^[0-9A-Z][0-9A-Z._-]{0,31}$'),
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  type        TEXT NOT NULL CHECK (type IN ('asset','liability','equity','revenue','expense')),
  system_key  TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  UNIQUE (business_id, code),
  -- Ownership: the business must exist AND belong to the named tenant.
  CONSTRAINT accounts_tenant_business_fk
    FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  -- §7 — a system key may never be attached to the wrong account type.
  -- MATCH SIMPLE: with system_key NULL the constraint is satisfied, so a
  -- custom account may still carry any valid type.
  CONSTRAINT accounts_system_key_type_fk
    FOREIGN KEY (system_key, type) REFERENCES accounting_system_account_keys (system_key, account_type)
);

-- One account per system identity per business (AL-07).
CREATE UNIQUE INDEX accounts_business_system_key_uq
  ON accounts (business_id, system_key) WHERE system_key IS NOT NULL;

COMMENT ON COLUMN accounts.system_key IS
  'Engine identity (AL-07). NULL for merchant custom accounts. Immutable once set; written only by accounting_seed_chart().';
COMMENT ON COLUMN accounts.name IS
  'Display label only. System accounts render from the i18n key accounting.account.<system_key> (AL-06); accounting truth never reads this column.';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. System account immutability (AL-05 / AL-07), enforced physically.
--
-- For an account carrying a system_key: DELETE, system_key change/clearing,
-- code change, type change and deactivation are all refused. Renaming is
-- allowed — the name is presentation, the system_key is the identity.
--
-- No principal is exempt, not even the platform bypass: an engine identity
-- that an administrator can rewrite is not an identity.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION accounts_protect_system() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.system_key IS NOT NULL THEN
      RAISE EXCEPTION 'accounting.system_account_immutable: a system account cannot be deleted (%)', OLD.system_key
        USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;

  -- Ownership identity is immutable for EVERY account, system or custom.
  IF NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'accounting.account_ownership_immutable: an account cannot change owner or identity'
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.system_key IS NOT NULL THEN
    IF NEW.system_key IS DISTINCT FROM OLD.system_key THEN
      RAISE EXCEPTION 'accounting.system_account_immutable: system_key cannot be changed or cleared (%)', OLD.system_key
        USING ERRCODE = 'P0001';
    END IF;
    IF NEW.code IS DISTINCT FROM OLD.code THEN
      RAISE EXCEPTION 'accounting.system_account_immutable: the code of a system account cannot be changed (%)', OLD.system_key
        USING ERRCODE = 'P0001';
    END IF;
    IF NEW.type IS DISTINCT FROM OLD.type THEN
      RAISE EXCEPTION 'accounting.system_account_immutable: the type of a system account cannot be changed (%)', OLD.system_key
        USING ERRCODE = 'P0001';
    END IF;
    IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
      RAISE EXCEPTION 'accounting.system_account_immutable: a system account cannot be deactivated (%)', OLD.system_key
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.system_key IS NOT NULL THEN
    -- A custom account cannot be promoted into an engine identity outside the
    -- seeding routine; there is no merchant write path that could do this.
    RAISE EXCEPTION 'accounting.system_account_immutable: system_key is assigned only by the chart seeding routine'
      USING ERRCODE = 'P0001';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER accounts_system_guard
  BEFORE UPDATE OR DELETE ON accounts
  FOR EACH ROW EXECUTE FUNCTION accounts_protect_system();

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Row-Level Security — the proven Phase 1 two-policy business scoping
--    (permissive tenant membership + RESTRICTIVE business isolation, 0006).
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_membership ON accounts
  USING (app_bypass() OR EXISTS (
    SELECT 1 FROM businesses b WHERE b.id = accounts.business_id AND b.tenant_id::text = app_tenant()))
  WITH CHECK (app_bypass() OR EXISTS (
    SELECT 1 FROM businesses b WHERE b.id = accounts.business_id AND b.tenant_id::text = app_tenant()));

CREATE POLICY business_isolation ON accounts AS RESTRICTIVE
  USING (app_bypass() OR business_id::text = app_business())
  WITH CHECK (app_bypass() OR business_id::text = app_business());

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Grants — default deny.
--
--   daftar_app        SELECT only. P2-S1 exposes no chart mutation at all, so
--                     the merchant runtime gets no INSERT/UPDATE/DELETE. A
--                     future account command earns its own narrow authority.
--   daftar_platform   SELECT (support/console read) + INSERT. The INSERT
--                     exists for exactly ONE reason: accounting_seed_chart()
--                     below is SECURITY DEFINER owned by daftar_platform,
--                     which is how every provisioning routine in this schema
--                     already writes (0032/0033/0038). It gets no UPDATE and
--                     no DELETE, so it can never rewrite or remove a chart.
--   daftar_identity / daftar_resolver / daftar_provisioner / daftar_worker
--                     nothing at all.
-- ─────────────────────────────────────────────────────────────────────────
GRANT SELECT ON accounting_system_account_keys TO daftar_app, daftar_platform;
GRANT SELECT ON accounts TO daftar_app;
GRANT SELECT, INSERT ON accounts TO daftar_platform;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. accounting_seed_chart — the one idempotent, concurrency-safe,
--    loud-on-conflict chart seeding routine (AL-08).
--
-- Contract:
--   * validates the target business exists and reads its owning tenant from
--     trusted persistence (never from a caller-supplied argument);
--   * takes a business-scoped advisory transaction lock, so concurrent or
--     repeated seeding is deterministic;
--   * seeds exactly the 21 required system accounts, set-wise;
--   * leaves an existing (possibly renamed) system account untouched;
--   * NEVER repairs a conflicting chart — it raises;
--   * asserts completeness before returning;
--   * never touches businesses.financial_started_at.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION accounting_seed_chart(p_business_id UUID) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  v_tenant   UUID;
  v_required INTEGER;
  v_present  INTEGER;
  v_detail   TEXT;
BEGIN
  IF p_business_id IS NULL THEN
    RAISE EXCEPTION 'accounting.chart_seed_invalid_business: business id is required' USING ERRCODE = 'P0001';
  END IF;

  -- Trusted persistence is the only source of the owning tenant.
  SELECT b.tenant_id INTO v_tenant FROM businesses b WHERE b.id = p_business_id;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'accounting.chart_seed_invalid_business: business % does not exist', p_business_id
      USING ERRCODE = 'P0001';
  END IF;

  -- Deterministic under concurrency and under repeated calls.
  PERFORM pg_advisory_xact_lock(hashtext(p_business_id::text), hashtext('ACCOUNTING_CHART'));

  SELECT count(*) INTO v_required FROM accounting_system_account_keys;

  -- ── No silent repair (§32). Every conflicting shape fails loudly. ──

  -- (a) a required system account exists but is inactive.
  SELECT string_agg(a.system_key, ', ' ORDER BY a.system_key) INTO v_detail
  FROM accounts a
  JOIN accounting_system_account_keys k ON k.system_key = a.system_key
  WHERE a.business_id = p_business_id AND NOT a.is_active;
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'accounting.chart_conflict: required system account(s) are inactive for business %: %', p_business_id, v_detail
      USING ERRCODE = 'P0001';
  END IF;

  -- (b) a required system account exists on the wrong tenant row.
  IF EXISTS (SELECT 1 FROM accounts a WHERE a.business_id = p_business_id AND a.tenant_id <> v_tenant) THEN
    RAISE EXCEPTION 'accounting.chart_conflict: account rows of business % name a different tenant', p_business_id
      USING ERRCODE = 'P0001';
  END IF;

  -- (c) a code this seeding needs is already owned by a different account.
  SELECT string_agg(k.system_key || '→' || k.default_code, ', ' ORDER BY k.system_key) INTO v_detail
  FROM accounting_system_account_keys k
  WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.business_id = p_business_id AND a.system_key = k.system_key)
    AND EXISTS (SELECT 1 FROM accounts a WHERE a.business_id = p_business_id AND a.code = k.default_code);
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'accounting.chart_conflict: required account code(s) already belong to another account in business %: %', p_business_id, v_detail
      USING ERRCODE = 'P0001';
  END IF;

  -- ── Seed set-wise; existing identities (renamed or not) are left alone. ──
  INSERT INTO accounts (tenant_id, business_id, code, name, type, system_key)
  SELECT v_tenant, p_business_id, k.default_code, k.seed_name, k.account_type, k.system_key
  FROM accounting_system_account_keys k
  WHERE NOT EXISTS (
    SELECT 1 FROM accounts a WHERE a.business_id = p_business_id AND a.system_key = k.system_key);

  -- ── Completeness, or a loud failure. Never "best effort". ──
  SELECT count(*) INTO v_present
  FROM accounts a
  JOIN accounting_system_account_keys k ON k.system_key = a.system_key AND k.account_type = a.type
  WHERE a.business_id = p_business_id AND a.is_active AND a.tenant_id = v_tenant;

  IF v_present <> v_required THEN
    RAISE EXCEPTION 'accounting.chart_incomplete: business % has %/% required system accounts', p_business_id, v_present, v_required
      USING ERRCODE = 'P0001';
  END IF;
END $$;

ALTER FUNCTION accounting_seed_chart(uuid) OWNER TO daftar_platform;
REVOKE ALL ON FUNCTION accounting_seed_chart(uuid) FROM PUBLIC;
-- No runtime EXECUTE grant: the only caller is the businesses trigger below
-- and the migration-time backfill. A narrow account command earns its own
-- grant when its slice arrives.

-- ─────────────────────────────────────────────────────────────────────────
-- 7. New-business atomicity (AL-08 / §12).
--
-- The trigger attaches to the TABLE, not to the caller, so the frozen
-- provisioning migrations are untouched: provision_create_business() inserts
-- into businesses and the chart is seeded inside that same transaction. Any
-- failure here aborts the whole business creation — the safe failure mode is
-- no business, never a chart-less business.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION accounting_seed_chart_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  PERFORM accounting_seed_chart(NEW.id);
  RETURN NEW;
END $$;

ALTER FUNCTION accounting_seed_chart_trg() OWNER TO daftar_platform;
REVOKE ALL ON FUNCTION accounting_seed_chart_trg() FROM PUBLIC;

CREATE TRIGGER businesses_seed_chart
  AFTER INSERT ON businesses
  FOR EACH ROW EXECUTE FUNCTION accounting_seed_chart_trg();

-- ─────────────────────────────────────────────────────────────────────────
-- 8. Backfill every existing business, then PROVE completeness.
--
-- If a single business would be left without a complete, correctly typed,
-- active chart, this migration rolls back. No best-effort migration.
-- financial_started_at is not read and not written.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  b RECORD;
  v_required INTEGER;
  v_bad TEXT;
BEGIN
  SELECT count(*) INTO v_required FROM accounting_system_account_keys;

  FOR b IN SELECT id FROM businesses ORDER BY created_at, id LOOP
    PERFORM accounting_seed_chart(b.id);
  END LOOP;

  -- Independent verification — not a re-run of the seeding routine's own check.
  SELECT string_agg(x.id::text || ' (' || x.n || '/' || v_required || ')', ', ' ORDER BY x.id) INTO v_bad
  FROM (
    SELECT b2.id,
           (SELECT count(*) FROM accounts a
            JOIN accounting_system_account_keys k ON k.system_key = a.system_key AND k.account_type = a.type
            WHERE a.business_id = b2.id AND a.is_active AND a.tenant_id = b2.tenant_id) AS n
    FROM businesses b2
  ) x
  WHERE x.n <> v_required;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'accounting.chart_backfill_incomplete: refusing to finish 0040 — business(es) without a complete chart: %', v_bad;
  END IF;

  -- Duplicate semantic identity is impossible by index, but prove it anyway:
  -- a migration that asserts nothing has verified nothing.
  IF EXISTS (
    SELECT 1 FROM accounts WHERE system_key IS NOT NULL
    GROUP BY business_id, system_key HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'accounting.chart_backfill_incomplete: duplicate system account identity detected';
  END IF;
END $$;
