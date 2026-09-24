-- 0042 — IMMUTABLE JOURNAL STRUCTURAL CORE (Phase 2, slice P2-S2).
--
-- Implements the structural half of the ledger: the closed source-type and
-- system-actor registries, journal_entries, journal_lines, the bidirectional
-- source-binding registry (AL-01), the actor shape (AL-04), the money and FX
-- structural contracts (AL-09/AL-10), immutability (AL-02's second mechanism),
-- RLS, and the full REVOKE shape (AL-03/AL-18).
--
-- The commit-time invariants — balance, line count, FX arithmetic, binding
-- presence — are 0043. This file creates what they police.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO (AL-18, directive §11/§40):
--   * no accounting_post_entry, and no other writer of any kind. After this
--     migration NOTHING in the system can insert a journal row: not
--     daftar_app, not daftar_platform, not the internal accounting principal.
--     The tables exist, the invariants are armed, and the only way to write
--     one is a primitive that does not exist yet and will arrive in P2-S3
--     together with its authority boundary;
--   * no accounting_assertion_keys, no HMAC verification, no fingerprint
--     computation. posting_fingerprint is STORED and shape-checked here; P2-S3
--     computes and verifies it;
--   * no posting-date enforcement. AL-14's policy is recorded AS DATA on
--     accounting_source_types so the future primitive reads a row instead of
--     branching on a source name;
--   * no manual-adjustment, opening-balance or reversal tables, no periods, no
--     FX rate management, no read APIs;
--   * no authoritative balance column anywhere (AL-15 / guard G-3).

-- ─────────────────────────────────────────────────────────────────────────
-- 1. accounting_source_types — the closed source identity registry.
--
-- Global reference data, exactly like accounting_system_account_keys and
-- currencies: no RLS, no DML for anyone, extended only by migration.
--
-- AL-14 IS ENCODED HERE AS DATA. The posting-date rule genuinely differs by
-- source, and the earlier design expressed that as branching inside the
-- posting primitive. Two columns hold it instead, so a future source type
-- DECLARES its policy rather than editing the writer:
--
--   lower_bound_policy  'none'              — may predate onboarding by any
--                                             amount (an opening position is
--                                             historical by definition)
--                       'not_before_origin' — may not precede the entry it
--                                             derives from (a reversal)
--   upper_bound_policy  'not_after_today'   — no future posting, resolved in
--                                             the BUSINESS's timezone
--
-- The CHECK lists are the closed vocabulary: adding a policy is a migration,
-- never a free-form string.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE accounting_source_types (
  source_type        TEXT PRIMARY KEY CHECK (source_type ~ '^[a-z][a-z0-9_]{1,62}$'),
  lower_bound_policy TEXT NOT NULL CHECK (lower_bound_policy IN ('none', 'not_before_origin')),
  upper_bound_policy TEXT NOT NULL CHECK (upper_bound_policy IN ('not_after_today')),
  description        TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 200),
  sort_order         INTEGER NOT NULL UNIQUE CHECK (sort_order > 0)
);

COMMENT ON TABLE accounting_source_types IS
  'Closed registry of Phase-2-native accounting source identities. lower_bound_policy/upper_bound_policy carry AL-14 posting-date semantics as data; P2-S3 enforces them, P2-S2 only records them.';

-- Only the three Phase-2-native sources are registered. Operational sources
-- (sale, invoice, payment, purchase, refund, credit_note, period_close…)
-- belong to the phases that own them and must NOT be pre-registered here.
INSERT INTO accounting_source_types (source_type, lower_bound_policy, upper_bound_policy, description, sort_order) VALUES
  ('opening_balance',   'none',              'not_after_today', 'Opening position carried into DAFTAR; historical by definition.', 1),
  ('manual_adjustment', 'none',              'not_after_today', 'Merchant-authored correction; back-dating permitted and audited.',  2),
  ('reversal',          'not_before_origin', 'not_after_today', 'Reverses an earlier entry; never precedes the fact it reverses.',   3);

DO $$
DECLARE v_n INTEGER;
BEGIN
  SELECT count(*) INTO v_n FROM accounting_source_types;
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'accounting source type registry must hold exactly the 3 Phase-2-native identities, found %', v_n;
  END IF;
  -- Phase 2 forbids future-dated postings for EVERY source, uniformly.
  IF EXISTS (SELECT 1 FROM accounting_source_types WHERE upper_bound_policy <> 'not_after_today') THEN
    RAISE EXCEPTION 'every Phase 2 source type must refuse future-dated postings';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. accounting_system_actors — the closed system-actor registry, EMPTY.
--
-- AL-04: a system actor is a registered key, never a synthetic user row. The
-- registry exists from day one so a future worker-initiated posting registers
-- a key instead of inventing a fake user — and it is seeded EMPTY, so in
-- Phase 2 a system-attributed entry cannot be persisted at all: the actor FK
-- has nothing to point at.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE accounting_system_actors (
  system_key  TEXT PRIMARY KEY CHECK (system_key ~ '^[a-z][a-z0-9_]{1,62}$'),
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 200),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE accounting_system_actors IS
  'Closed registry of non-human posting actors (AL-04). Seeded EMPTY in Phase 2: every Phase 2 posting is actor_kind=''user'' because no system actor exists to name.';

DO $$
DECLARE v_n INTEGER;
BEGIN
  SELECT count(*) INTO v_n FROM accounting_system_actors;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'accounting_system_actors must be EMPTY in Phase 2, found % row(s)', v_n;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. journal_entries — immutable posted financial truth.
--
-- Composite ownership follows the Phase 1 convention: PRIMARY KEY
-- (business_id, id), and (tenant_id, business_id) bound to businesses through
-- the 0016 unique constraint, so an entry can never claim tenant A while
-- belonging to a business of tenant B.
--
-- status has exactly one legal value. There is no draft journal, no void
-- journal and no mutable state machine: correction is reversal (AL-12), never
-- mutation.
--
-- posting_fingerprint is stored and shape-checked (lowercase SHA-256 hex).
-- P2-S2 makes NO claim about its contents — computing it from the canonical
-- payload and refusing a mismatch is P2-S3's job, and saying otherwise here
-- would be documentation claiming more than the database guarantees.
--
-- request_id is TEXT, the type audit_events.request_id already uses (0004).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE journal_entries (
  tenant_id           UUID NOT NULL,
  business_id         UUID NOT NULL,
  id                  UUID NOT NULL DEFAULT gen_random_uuid(),
  entry_date          DATE NOT NULL,
  description         TEXT CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 500),
  source_type         TEXT NOT NULL REFERENCES accounting_source_types (source_type),
  source_id           UUID NOT NULL,
  status              TEXT NOT NULL DEFAULT 'posted' CHECK (status = 'posted'),
  actor_kind          TEXT NOT NULL CHECK (actor_kind IN ('user', 'system')),
  actor_user_id       UUID REFERENCES users (id),
  actor_system_key    TEXT REFERENCES accounting_system_actors (system_key),
  request_id          TEXT CHECK (request_id IS NULL OR char_length(request_id) BETWEEN 1 AND 120),
  posting_fingerprint CHAR(64) NOT NULL CHECK (posting_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  -- One entry per source identity. The binding registry enforces the same
  -- fact from its side; stating it here too makes a duplicate structurally
  -- impossible rather than merely detected at COMMIT.
  UNIQUE (business_id, source_type, source_id),
  CONSTRAINT journal_entries_tenant_business_fk
    FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  -- AL-04 actor shape, physically.
  CONSTRAINT journal_entries_actor_shape_ck CHECK (
    (actor_kind = 'user' AND actor_user_id IS NOT NULL AND actor_system_key IS NULL)
    OR (actor_kind = 'system' AND actor_user_id IS NULL AND actor_system_key IS NOT NULL)
  )
);

COMMENT ON COLUMN journal_entries.posting_fingerprint IS
  'Canonical payload digest, lowercase SHA-256 hex. P2-S2 stores and shape-checks it only; P2-S3 recomputes it from the submitted payload and refuses a mismatch (AL-03/AL-11).';

-- ─────────────────────────────────────────────────────────────────────────
-- 4. journal_lines — the authoritative amounts.
--
-- Money is BIGINT minor units; the FX rate is NUMERIC(20,10) (AL-09/AL-10).
-- No FLOAT, no DOUBLE PRECISION, no REAL anywhere in this file — guard G-2
-- refuses a regression mechanically.
--
-- MAX_MONEY_MINOR = 10^18, as a literal below. Every amount satisfies
-- 0 < amount <= 10^18, leaving ~9.2x headroom under the BIGINT limit so that
-- sums cannot approach the type boundary. The commit-time checker still sums
-- in NUMERIC (0043), because a cap on each line is not a cap on their total.
--
-- line_no is the financial identity of a line within its entry. Insertion
-- order is not identity: two lines of one entry can never share a line_no.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE journal_lines (
  tenant_id         UUID NOT NULL,
  business_id       UUID NOT NULL,
  id                UUID NOT NULL DEFAULT gen_random_uuid(),
  journal_entry_id  UUID NOT NULL,
  line_no           INTEGER NOT NULL CHECK (line_no > 0),
  account_id        UUID NOT NULL,

  debit_minor       BIGINT NOT NULL,
  credit_minor      BIGINT NOT NULL,
  base_amount_minor BIGINT NOT NULL,
  base_currency     TEXT NOT NULL REFERENCES currencies (code),

  txn_currency      TEXT NOT NULL REFERENCES currencies (code),
  txn_amount_minor  BIGINT NOT NULL,
  fx_rate           NUMERIC(20, 10) NOT NULL,
  fx_rate_source    TEXT NOT NULL CHECK (fx_rate_source IN ('base', 'manual', 'provider')),
  fx_rate_at        TIMESTAMPTZ NOT NULL,

  branch_id         UUID,
  warehouse_id      UUID,

  memo              TEXT CHECK (memo IS NULL OR char_length(memo) BETWEEN 1 AND 500),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (business_id, id),
  UNIQUE (business_id, journal_entry_id, line_no),

  CONSTRAINT journal_lines_tenant_business_fk
    FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  -- Same business as its entry, by construction rather than by validation.
  CONSTRAINT journal_lines_entry_fk
    FOREIGN KEY (business_id, journal_entry_id) REFERENCES journal_entries (business_id, id),
  -- A line for Business A can never reference Business B's account (§25).
  CONSTRAINT journal_lines_account_fk
    FOREIGN KEY (business_id, account_id) REFERENCES accounts (business_id, id),
  -- Nullable reporting dimensions, same-business composite FKs (MATCH SIMPLE:
  -- a NULL dimension satisfies the constraint, so a business-level entry does
  -- not need an invented branch or warehouse).
  CONSTRAINT journal_lines_branch_fk
    FOREIGN KEY (business_id, branch_id) REFERENCES branches (business_id, id),
  CONSTRAINT journal_lines_warehouse_fk
    FOREIGN KEY (business_id, warehouse_id) REFERENCES warehouses (business_id, id),

  -- ── Money shape (AL-09 structural completeness, AL-10 cap) ──
  CONSTRAINT journal_lines_one_side_ck CHECK (((debit_minor > 0)::int + (credit_minor > 0)::int) = 1),
  CONSTRAINT journal_lines_non_negative_ck CHECK (debit_minor >= 0 AND credit_minor >= 0),
  CONSTRAINT journal_lines_base_amount_ck CHECK (base_amount_minor = GREATEST(debit_minor, credit_minor)),
  CONSTRAINT journal_lines_money_cap_ck CHECK (
    base_amount_minor > 0
    AND base_amount_minor <= 1000000000000000000
    AND debit_minor <= 1000000000000000000
    AND credit_minor <= 1000000000000000000
  ),
  CONSTRAINT journal_lines_txn_amount_ck CHECK (txn_amount_minor > 0 AND txn_amount_minor <= 1000000000000000000),

  -- ── FX snapshot shape (AL-09) ──
  -- A partially populated FX snapshot is structurally impossible: fx_rate_at
  -- is NOT NULL for both shapes, a domestic line must carry the explicit
  -- 'base' sentinel with rate 1 and equal amounts, and a foreign line must
  -- name a real rate source.
  CONSTRAINT journal_lines_fx_rate_ck CHECK (fx_rate > 0),
  CONSTRAINT journal_lines_fx_shape_ck CHECK (
    (
      txn_currency = base_currency
      AND fx_rate = 1
      AND txn_amount_minor = base_amount_minor
      AND fx_rate_source = 'base'
    )
    OR (
      txn_currency <> base_currency
      AND fx_rate > 0
      AND fx_rate_source IN ('manual', 'provider')
    )
  )
);

COMMENT ON COLUMN journal_lines.fx_rate IS
  'AL-09: 1 major unit of txn_currency = fx_rate major units of base_currency. NUMERIC(20,10), never float; guard G-2 refuses a float rate mechanically.';
COMMENT ON COLUMN journal_lines.base_currency IS
  'Denormalised from the owning business so the FX CHECK is self-contained. 0043 proves at COMMIT that it equals businesses.base_currency and is uniform across the entry.';

-- ─────────────────────────────────────────────────────────────────────────
-- 5. accounting_source_bindings — source identity, bound in BOTH directions.
--
-- AL-01, corrected: a one-way foreign key from a source table to the journal
-- proves the journal row exists when the source references it. It does NOT
-- prove that every journal entry has a source. Two DEFERRABLE INITIALLY
-- DEFERRED foreign keys, one in each direction, verified at COMMIT, are what
-- actually earn that guarantee — and they let the posting transaction write
-- the two rows in either order.
--
-- The binding registry IS the source identity. A future domain registers a
-- source_type and points ITS table at the binding; journal_entries is never
-- altered again, and there is no polymorphic FK and no growing column list of
-- nullable per-domain keys. The journal stays domain-agnostic forever.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE accounting_source_bindings (
  tenant_id        UUID NOT NULL,
  business_id      UUID NOT NULL,
  source_type      TEXT NOT NULL REFERENCES accounting_source_types (source_type),
  source_id        UUID NOT NULL,
  journal_entry_id UUID NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Duplicate source identity is impossible.
  PRIMARY KEY (business_id, source_type, source_id),
  -- Exactly one source identity per entry.
  UNIQUE (business_id, journal_entry_id),
  CONSTRAINT accounting_source_bindings_tenant_business_fk
    FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  -- Direction 1 — binding → entry. Composite on business_id, so a binding can
  -- never point at another business's journal entry.
  CONSTRAINT accounting_source_bindings_entry_fk
    FOREIGN KEY (business_id, journal_entry_id) REFERENCES journal_entries (business_id, id)
    DEFERRABLE INITIALLY DEFERRED
);

-- Direction 2 — entry → binding. An entry that reaches COMMIT without a
-- registered source identity is refused by the database itself.
ALTER TABLE journal_entries
  ADD CONSTRAINT journal_entries_binding_fk
  FOREIGN KEY (business_id, source_type, source_id)
  REFERENCES accounting_source_bindings (business_id, source_type, source_id)
  DEFERRABLE INITIALLY DEFERRED;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. Immutability — posted truth is never rewritten (§20, §27, AL-12).
--
-- Deliberately redundant with the grant shape in section 8. Grants answer
-- "may this credential write?"; the trigger answers "may this row change at
-- all?", and it answers no to everyone — the platform bypass, the schema
-- owner, a support session and a migration credential alike. Whoever runs the
-- migrations owns these tables and PostgreSQL gives an owner rights that
-- cannot be refused by grant, so the trigger is the mechanism that still
-- refuses THEM. There is no admin bypass, and adding one later would be
-- visible in this file's diff.
--
-- The functions read nothing, so they need no elevated identity.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION journal_entries_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'accounting.journal_immutable: a posted journal entry cannot be deleted (entry %)', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  RAISE EXCEPTION 'accounting.journal_immutable: a posted journal entry cannot be modified (entry %)', OLD.id
    USING ERRCODE = 'P0001';
END $$;

CREATE TRIGGER journal_entries_no_mutation
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entries_immutable();

CREATE OR REPLACE FUNCTION journal_lines_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'accounting.journal_immutable: a posted journal line cannot be deleted (entry %, line %)', OLD.journal_entry_id, OLD.line_no
      USING ERRCODE = 'P0001';
  END IF;
  RAISE EXCEPTION 'accounting.journal_immutable: a posted journal line cannot be modified (entry %, line %)', OLD.journal_entry_id, OLD.line_no
    USING ERRCODE = 'P0001';
END $$;

CREATE TRIGGER journal_lines_no_mutation
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION journal_lines_immutable();

CREATE OR REPLACE FUNCTION accounting_source_bindings_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'accounting.binding_immutable: a source binding cannot be deleted (entry %)', OLD.journal_entry_id
      USING ERRCODE = 'P0001';
  END IF;
  RAISE EXCEPTION 'accounting.binding_immutable: a source binding cannot be modified (entry %)', OLD.journal_entry_id
    USING ERRCODE = 'P0001';
END $$;

CREATE TRIGGER accounting_source_bindings_no_mutation
  BEFORE UPDATE OR DELETE ON accounting_source_bindings
  FOR EACH ROW EXECUTE FUNCTION accounting_source_bindings_immutable();

-- ─────────────────────────────────────────────────────────────────────────
-- 7. Row-Level Security — the proven Phase 1 two-layer model (0006).
--
-- RLS here is READ isolation. It is not, and must not be mistaken for,
-- posting authorization: app_tenant()/app_business() are caller-settable
-- GUCs, so they scope what a session may see and prove nothing about who may
-- write. Nothing may write at all in P2-S2; P2-S3 brings the unforgeable
-- command boundary.
--
-- The third policy admits the internal accounting principal BY IDENTITY, for
-- SELECT only — the same shape 0014 uses for daftar_resolver and 0040 for the
-- chart seeder. It exists because the commit-time validators (0043) and the
-- base-currency lock (section 9) must see EVERY line of the entry they judge,
-- whatever GUC context the writing session happens to carry. A validator that
-- RLS can blind passes vacuously, which is the worst possible failure for a
-- ledger check. The principal is NOLOGIN and passwordless, so no credential
-- reaches this policy, and it is SELECT-only, so it cannot become a write
-- path: the RESTRICTIVE policy's WITH CHECK deliberately omits it.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE accounting_source_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_source_bindings FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_membership ON journal_entries
  USING (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = journal_entries.business_id AND b.tenant_id::text = app_tenant()))
  WITH CHECK (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = journal_entries.business_id AND b.tenant_id::text = app_tenant()));
CREATE POLICY accounting_validator ON journal_entries
  FOR SELECT USING (current_user = 'daftar_accounting_internal');
CREATE POLICY business_isolation ON journal_entries AS RESTRICTIVE
  USING (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id::text = app_business())
  WITH CHECK (app_bypass() OR business_id::text = app_business());

CREATE POLICY tenant_membership ON journal_lines
  USING (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = journal_lines.business_id AND b.tenant_id::text = app_tenant()))
  WITH CHECK (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = journal_lines.business_id AND b.tenant_id::text = app_tenant()));
CREATE POLICY accounting_validator ON journal_lines
  FOR SELECT USING (current_user = 'daftar_accounting_internal');
CREATE POLICY business_isolation ON journal_lines AS RESTRICTIVE
  USING (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id::text = app_business())
  WITH CHECK (app_bypass() OR business_id::text = app_business());

CREATE POLICY tenant_membership ON accounting_source_bindings
  USING (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = accounting_source_bindings.business_id AND b.tenant_id::text = app_tenant()))
  WITH CHECK (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = accounting_source_bindings.business_id AND b.tenant_id::text = app_tenant()));
CREATE POLICY accounting_validator ON accounting_source_bindings
  FOR SELECT USING (current_user = 'daftar_accounting_internal');
CREATE POLICY business_isolation ON accounting_source_bindings AS RESTRICTIVE
  USING (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id::text = app_business())
  WITH CHECK (app_bypass() OR business_id::text = app_business());

-- ─────────────────────────────────────────────────────────────────────────
-- 8. Grants — default deny, and no writer anywhere (§32, §33, AL-03).
--
-- The end state this migration must reach:
--
--   daftar_app / daftar_platform / daftar_worker   SELECT on the three
--                                                  journal tables, nothing else
--   daftar_identity / daftar_resolver
--   daftar_provisioner                             no journal access at all
--   daftar_accounting_internal                     SELECT only, and only so
--                                                  the commit-time validators
--                                                  cannot be blinded by RLS
--   EVERYONE, without exception                    no INSERT, no UPDATE,
--                                                  no DELETE, no TRUNCATE
--
-- The two reference registries get NO grants: nothing in P2-S2 has a real
-- runtime need to read them, and "it might be useful someday" is not a
-- reason to open a table. Referential integrity checks do not need them —
-- PostgreSQL runs RI queries with the referencing table owner's rights.
-- ─────────────────────────────────────────────────────────────────────────
REVOKE ALL ON journal_entries, journal_lines, accounting_source_bindings FROM PUBLIC;
REVOKE ALL ON accounting_source_types, accounting_system_actors FROM PUBLIC;

GRANT SELECT ON journal_entries, journal_lines, accounting_source_bindings
  TO daftar_app, daftar_platform, daftar_worker;

GRANT SELECT ON journal_entries, journal_lines, accounting_source_bindings
  TO daftar_accounting_internal;
-- The validators read businesses.base_currency and currencies.minor_units.
-- SELECT on businesses is already granted by 0040; currencies is not.
GRANT SELECT ON currencies TO daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 9. Base-currency lock (§26, DAFTAR_MULTI_CURRENCY §4).
--
-- Once a business has a posted journal entry, its base currency is history
-- and may not be changed. Creating a chart does NOT lock it — owning accounts
-- is not a financial transaction — so businesses.financial_started_at stays
-- NULL after P2-S1 seeding and this migration neither reads nor writes it.
--
-- WHY THIS IS SECURITY DEFINER. daftar_app holds UPDATE on businesses (0006),
-- so the lock is genuinely reachable from a runtime credential. journal_entries
-- FORCEs RLS, so a plain trigger function would evaluate its EXISTS through
-- the caller's row-visibility: a session whose app.business_id GUC names a
-- different business would see zero entries and the lock would silently let
-- the change through. Running as the internal principal, which the SELECT
-- policy in section 7 admits by identity, makes the check see the same rows
-- no matter who triggered it.
--
-- Sections 9a–9c are the managed-PostgreSQL ownership-transfer dance proved
-- by 0040: take CREATE on the schema, transfer ownership, install the trigger
-- while EXECUTE is still open, revoke PUBLIC EXECUTE as the owner, give the
-- CREATE back. DDL is transactional, so none of the temporary state ever
-- exists in a committed database, and section 10 refuses to commit if any of
-- it survived. Nothing here assumes SUPERUSER.
-- ─────────────────────────────────────────────────────────────────────────

-- 9a. Temporary ownership-transfer authority.
GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;

CREATE OR REPLACE FUNCTION businesses_base_currency_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  IF NEW.base_currency IS DISTINCT FROM OLD.base_currency
     AND EXISTS (SELECT 1 FROM journal_entries je WHERE je.business_id = OLD.id) THEN
    RAISE EXCEPTION 'accounting.base_currency_locked: the base currency of a business with posted journal entries cannot be changed (business %)', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

ALTER FUNCTION businesses_base_currency_lock() OWNER TO daftar_accounting_internal;

-- 9b. Installed while EXECUTE is still open — the legal route for a
--     non-superuser migrator. PostgreSQL checks EXECUTE on a trigger function
--     at CREATE TRIGGER time, never when it fires, so the revoke below does
--     not disarm it.
CREATE TRIGGER businesses_base_currency_lock
  BEFORE UPDATE OF base_currency ON businesses
  FOR EACH ROW EXECUTE FUNCTION businesses_base_currency_lock();

-- 9c. Close the door. Only the owner may revoke, so assume that identity.
SET LOCAL ROLE daftar_accounting_internal;
REVOKE ALL ON FUNCTION businesses_base_currency_lock() FROM PUBLIC;
RESET ROLE;

REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 10. Prove the end state, or refuse to commit.
--
-- A migration that asserts nothing has verified nothing. Everything below is
-- a claim this slice makes in its acceptance evidence, checked here against
-- the live catalogue rather than against the author's intention.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_detail TEXT;
  v_n      INTEGER;
BEGIN
  -- (a) NOBODY holds write authority on the journal. Not a runtime role, not
  --     the internal principal, not PUBLIC.
  --
  --     This reads pg_class.relacl through aclexplode() rather than
  --     information_schema.role_table_grants, because that view only shows
  --     grants whose grantor or grantee is an enabled role for the current
  --     session. Under a managed, non-superuser migrator that filter could
  --     hide the very grant this check exists to find, and a privilege check
  --     that can be blinded is not a check. aclexplode() is unfiltered.
  --
  --     grantee = 0 is PUBLIC. The table OWNER is excluded and only the
  --     owner: PostgreSQL gives an owner rights that cannot be revoked, which
  --     is why whoever runs the migrations holds a deployment credential no
  --     service loads — and why the immutability triggers refuse the owner
  --     too.
  SELECT string_agg(format('%s:%s on %s', coalesce(r.rolname, 'PUBLIC'), a.privilege_type, c.relname), ', '
                    ORDER BY coalesce(r.rolname, 'PUBLIC'), c.relname, a.privilege_type)
    INTO v_detail
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
  LEFT JOIN pg_roles r ON r.oid = a.grantee
  WHERE n.nspname = 'public'
    AND c.relname IN ('journal_entries', 'journal_lines', 'accounting_source_bindings', 'accounting_source_types', 'accounting_system_actors')
    AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    AND a.grantee <> c.relowner;
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'accounting.journal_writer_exists: refusing to finish 0042 — journal DML is granted: %', v_detail;
  END IF;

  -- (b) The intended read shape, exactly. Not "at least"; exactly.
  SELECT string_agg(format('%s on %s', coalesce(r.rolname, 'PUBLIC'), c.relname), ', '
                    ORDER BY coalesce(r.rolname, 'PUBLIC'), c.relname) INTO v_detail
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
  LEFT JOIN pg_roles r ON r.oid = a.grantee
  WHERE n.nspname = 'public'
    AND c.relname IN ('journal_entries', 'journal_lines', 'accounting_source_bindings')
    AND a.grantee <> c.relowner
    AND coalesce(r.rolname, 'PUBLIC') NOT IN ('daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_accounting_internal');
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'accounting.journal_read_unexpected: refusing to finish 0042 — unintended journal privilege: %', v_detail;
  END IF;

  -- (c) The reference registries are reachable by nobody at all.
  SELECT string_agg(format('%s:%s on %s', coalesce(r.rolname, 'PUBLIC'), a.privilege_type, c.relname), ', '
                    ORDER BY coalesce(r.rolname, 'PUBLIC')) INTO v_detail
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
  LEFT JOIN pg_roles r ON r.oid = a.grantee
  WHERE n.nspname = 'public'
    AND c.relname IN ('accounting_source_types', 'accounting_system_actors')
    AND a.grantee <> c.relowner;
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'accounting.registry_grant_unexpected: refusing to finish 0042 — reference registry is granted: %', v_detail;
  END IF;

  -- (d) No writer routine was introduced (§40).
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname IN ('accounting_post_entry', 'accounting_actor')) THEN
    RAISE EXCEPTION 'accounting.writer_exists: accounting_post_entry/accounting_actor belong to P2-S3 and must not exist after 0042';
  END IF;

  -- (e) RLS is real on all three business-scoped tables.
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO v_detail
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('journal_entries', 'journal_lines', 'accounting_source_bindings')
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'accounting.rls_missing: refusing to finish 0042 — RLS not ENABLED+FORCED on: %', v_detail;
  END IF;

  -- (f) Both directions of AL-01 exist and are DEFERRABLE INITIALLY DEFERRED.
  SELECT count(*) INTO v_n
  FROM pg_constraint
  WHERE conname IN ('accounting_source_bindings_entry_fk', 'journal_entries_binding_fk')
    AND contype = 'f' AND condeferrable AND condeferred;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'accounting.binding_fk_missing: both AL-01 directions must be DEFERRABLE INITIALLY DEFERRED, found %', v_n;
  END IF;

  -- (g) The temporary CREATE from 9a is gone, and the principal is still
  --     unreachable and unelevated.
  IF has_schema_privilege('daftar_accounting_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'accounting.temporary_create_survived: daftar_accounting_internal still holds CREATE on schema public';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daftar_accounting_internal'
             AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
    RAISE EXCEPTION 'accounting.internal_principal_reachable: daftar_accounting_internal is no longer an unreachable, unelevated principal';
  END IF;

  -- (h) The lock routine is owned by the internal principal, and PUBLIC
  --     cannot call it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'businesses_base_currency_lock' AND r.rolname = 'daftar_accounting_internal'
  ) THEN
    RAISE EXCEPTION 'accounting.lock_owner_wrong: businesses_base_currency_lock() must be owned by daftar_accounting_internal';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'businesses_base_currency_lock'
               AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proacl, '{}'::aclitem[])) acl WHERE acl::text LIKE '=%')) THEN
    RAISE EXCEPTION 'accounting.lock_execute_public: PUBLIC still holds EXECUTE on businesses_base_currency_lock()';
  END IF;
END $$;
