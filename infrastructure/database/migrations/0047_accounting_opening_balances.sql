-- 0047_accounting_opening_balances.sql
-- P2-S4, part 2 of 2 — the opening position (directive §22-§34, AL-13).
--
-- An opening balance is the one accounting fact a business states about a
-- time before DAFTAR existed. It is historical by definition, it is entered
-- once, and getting it wrong is the most expensive kind of wrong there is:
-- every report the merchant ever reads is measured from it.
--
-- ── The state machine, exactly as AL-13 resolves it ──────────────────────
--
--   draft ──post──▶ posted ──supersede──▶ superseded
--     │
--     └──discard──▶ (row deleted, no journal entry ever existed)
--
-- Only `status` moves after posting, and only posted → superseded. Lines,
-- `as_of_date`, `journal_entry_id` and the source identity are frozen the
-- moment the journal entry exists, and the supersession has a precondition
-- the database checks rather than the application promises: the opening
-- balance's own journal entry must ALREADY have been reversed. A merchant
-- cannot quietly replace an opening position; they reverse it, which is an
-- accounting fact of its own, and only then may a new one take its place.
--
-- The journal itself never has a draft. `journal_entries.status` is CHECKed
-- to `'posted'` and 0042 is frozen. The draft lives here, in the source, and
-- a discarded draft leaves nothing behind because nothing was ever posted.
--
-- ── The equity plug is a line, not an adjustment ─────────────────────────
--
-- Assets and liabilities carried in from the past do not balance by
-- themselves; the difference is the owners' accumulated position. It is
-- written as an explicit, visible line to the `opening_equity` system
-- account. The engine computes it from the persisted positions — the caller
-- cannot state it, cannot round it and cannot suppress it.
--
-- The exact zero case is documented rather than hidden: when the positions
-- already balance among themselves the plug is zero, and NO plug line is
-- emitted. A zero-amount line is not a smaller line, it is a line the ledger
-- refuses (`journal_lines` CHECKs every amount > 0), and an opening position
-- whose equity is nil has nothing to say about equity. The test matrix pins
-- all three cases: positive plug, negative plug, and no plug at all.
--
-- ── Why this one rides `accounting_post_entry` unchanged ─────────────────
--
-- Unlike a reversal, an opening balance is new truth about accounts the
-- merchant is choosing today, so every rule the primitive enforces is the
-- rule that should apply — including that an account must be ACTIVE. The
-- command below therefore derives the lines and hands them to the primitive;
-- it is not a third journal writer, and there is nothing about the ledger it
-- knows that the primitive does not.
--
-- Migrations 0000-0045 are frozen and untouched. 0046 and 0047 are the only
-- migrations of this slice, and no 0048 exists.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Ownership-transfer authority, taken and returned inside this file.
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. `accounting_opening_balances` — the source row and its state.
--
-- `binding_source_id` deserves a word. AL-01 says a domain detail table
-- references the BINDING registry, so that deleting a detail row can never
-- destroy the journal link. A draft has no binding yet, and a NOT NULL
-- composite foreign key cannot express "not yet". The column is therefore a
-- nullable mirror of `id`: NULL while the row is a draft, equal to `id` from
-- the moment it is posted, and the foreign key is satisfied vacuously in the
-- first case and strictly in the second. A CHECK keeps it from ever being
-- anything other than this row's own identity.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE accounting_opening_balances (
  tenant_id         UUID NOT NULL,
  business_id       UUID NOT NULL,
  id                UUID NOT NULL,
  source_type       TEXT NOT NULL DEFAULT 'opening_balance' CHECK (source_type = 'opening_balance'),
  status            TEXT NOT NULL CHECK (status IN ('draft', 'posted', 'superseded')),
  as_of_date        DATE NOT NULL,
  journal_entry_id  UUID,
  binding_source_id UUID,
  actor_user_id     UUID NOT NULL REFERENCES users (id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_at         TIMESTAMPTZ,
  superseded_at     TIMESTAMPTZ,
  PRIMARY KEY (business_id, id),
  UNIQUE (business_id, journal_entry_id),
  CONSTRAINT accounting_opening_balances_binding_identity_ck
    CHECK (binding_source_id IS NULL OR binding_source_id = id),
  -- The state machine as a physical shape: every status has exactly one
  -- legal combination of the columns that record how it got there.
  CONSTRAINT accounting_opening_balances_state_ck CHECK (
    (status = 'draft'      AND journal_entry_id IS NULL     AND binding_source_id IS NULL
                           AND posted_at IS NULL            AND superseded_at IS NULL)
    OR (status = 'posted'     AND journal_entry_id IS NOT NULL AND binding_source_id IS NOT NULL
                              AND posted_at IS NOT NULL        AND superseded_at IS NULL)
    OR (status = 'superseded' AND journal_entry_id IS NOT NULL AND binding_source_id IS NOT NULL
                              AND posted_at IS NOT NULL        AND superseded_at IS NOT NULL)
  ),
  CONSTRAINT accounting_opening_balances_tenant_business_fk
    FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT accounting_opening_balances_entry_fk
    FOREIGN KEY (business_id, journal_entry_id) REFERENCES journal_entries (business_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT accounting_opening_balances_binding_fk
    FOREIGN KEY (business_id, source_type, binding_source_id)
    REFERENCES accounting_source_bindings (business_id, source_type, source_id)
    DEFERRABLE INITIALLY DEFERRED
);

COMMENT ON TABLE accounting_opening_balances IS
  'AL-13 opening position. draft → posted → superseded, with supersession refused unless this row''s own journal entry has already been reversed. Exactly one posted set per business, enforced by a partial unique index.';

-- Exactly one CURRENT opening position per business, forever. This is also
-- what makes replacement impossible without superseding first: the new row
-- cannot reach `posted` while the old one is still there.
CREATE UNIQUE INDEX accounting_opening_balances_posted_uq
  ON accounting_opening_balances (business_id) WHERE status = 'posted';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. `accounting_opening_balance_lines` — the merchant's positions.
--
-- These are POSITIONS, not journal lines. They carry no branch and no
-- warehouse because an opening balance is stated at business level (§31);
-- the columns are absent rather than nullable, so there is nothing for a
-- future caller to populate by accident.
--
-- A foreign position carries a COMPLETE FX snapshot whose source is
-- `manual`: there is no rate provider for a date that predates the
-- merchant's arrival, and pretending otherwise would put a fabricated
-- provenance on the most historical number in the system.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE accounting_opening_balance_lines (
  tenant_id          UUID NOT NULL,
  business_id        UUID NOT NULL,
  opening_balance_id UUID NOT NULL,
  line_no            INTEGER NOT NULL CHECK (line_no > 0),
  account_ref_kind   TEXT NOT NULL CHECK (account_ref_kind IN ('system', 'code')),
  account_system_key TEXT CHECK (account_system_key IS NULL OR account_system_key ~ '^[a-z0-9_]{1,64}$'),
  account_code       TEXT CHECK (account_code IS NULL OR char_length(account_code) BETWEEN 1 AND 64),
  side               TEXT NOT NULL CHECK (side IN ('D', 'C')),
  base_amount_minor  BIGINT NOT NULL CHECK (base_amount_minor > 0 AND base_amount_minor <= 1000000000000000000),
  base_currency      TEXT NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$'),
  txn_amount_minor   BIGINT NOT NULL CHECK (txn_amount_minor > 0 AND txn_amount_minor <= 1000000000000000000),
  txn_currency       TEXT NOT NULL CHECK (txn_currency ~ '^[A-Z]{3}$'),
  fx_rate            NUMERIC(20, 10) NOT NULL CHECK (fx_rate > 0),
  fx_rate_source     TEXT NOT NULL CHECK (fx_rate_source IN ('base', 'manual')),
  fx_rate_at         TIMESTAMPTZ NOT NULL CHECK (date_trunc('second', fx_rate_at) = fx_rate_at),
  memo               TEXT CHECK (memo IS NULL OR char_length(memo) BETWEEN 1 AND 500),
  PRIMARY KEY (business_id, opening_balance_id, line_no),
  CONSTRAINT accounting_opening_balance_lines_ref_ck CHECK (
    (account_ref_kind = 'system' AND account_system_key IS NOT NULL AND account_code IS NULL)
    OR (account_ref_kind = 'code' AND account_code IS NOT NULL AND account_system_key IS NULL)
  ),
  -- A domestic position carries the base rate source and equal amounts; a
  -- foreign one is manual. The same shape `journal_lines` requires, stated
  -- here so a draft cannot hold a position the ledger would later refuse.
  CONSTRAINT accounting_opening_balance_lines_fx_ck CHECK (
    (txn_currency = base_currency AND fx_rate_source = 'base' AND txn_amount_minor = base_amount_minor)
    OR (txn_currency <> base_currency AND fx_rate_source = 'manual')
  ),
  CONSTRAINT accounting_opening_balance_lines_parent_fk
    FOREIGN KEY (business_id, opening_balance_id)
    REFERENCES accounting_opening_balances (business_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE accounting_opening_balance_lines IS
  'The merchant-stated positions of an opening balance. Editable while the parent is a draft, frozen the moment it is posted. No branch or warehouse: an opening position is stated at business level (AL-13, directive §31).';

-- ─────────────────────────────────────────────────────────────────────────
-- 4. The state machine, as triggers.
--
-- AL-13's table of "what is immutable after posting" is written out here as
-- the only transitions the database will admit. Two mechanisms again: no
-- runtime role holds UPDATE or DELETE on either table, and these triggers
-- refuse everything the machine does not name — including for the one
-- principal that does hold those privileges.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION accounting_opening_balances_state() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A draft may be abandoned. A posted or superseded opening balance is
    -- history and is never deleted, by anyone.
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'accounting.opening_balance_state_invalid: a % opening balance cannot be discarded', OLD.status
        USING ERRCODE = 'P0001';
    END IF;
    IF OLD.journal_entry_id IS NOT NULL
       OR EXISTS (SELECT 1 FROM accounting_source_bindings b
                  WHERE b.business_id = OLD.business_id AND b.source_type = 'opening_balance' AND b.source_id = OLD.id) THEN
      RAISE EXCEPTION 'accounting.opening_balance_state_invalid: this draft already has a journal identity and cannot be discarded'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;

  -- Identity never changes, in any state.
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.source_type IS DISTINCT FROM OLD.source_type
     OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'accounting.opening_balance_state_invalid: the identity of an opening balance is immutable'
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.status = 'draft' THEN
    IF NEW.status = 'draft' THEN
      -- Editing a draft: the as-of date may move, nothing else may.
      IF NEW.journal_entry_id IS NOT NULL OR NEW.binding_source_id IS NOT NULL
         OR NEW.posted_at IS NOT NULL OR NEW.superseded_at IS NOT NULL THEN
        RAISE EXCEPTION 'accounting.opening_balance_state_invalid: a draft carries no journal identity'
          USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.status = 'posted' THEN
      IF NEW.as_of_date IS DISTINCT FROM OLD.as_of_date THEN
        RAISE EXCEPTION 'accounting.opening_balance_state_invalid: the as-of date is fixed when the opening balance is posted'
          USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'accounting.opening_balance_state_invalid: a draft may only be posted or discarded'
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.status = 'posted' THEN
    -- The ONE transition a posted opening balance has. Everything that makes
    -- it a financial fact must be byte-identical on both sides.
    IF NEW.status <> 'superseded' THEN
      RAISE EXCEPTION 'accounting.opening_balance_state_invalid: a posted opening balance may only be superseded'
        USING ERRCODE = 'P0001';
    END IF;
    IF NEW.as_of_date IS DISTINCT FROM OLD.as_of_date
       OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id
       OR NEW.binding_source_id IS DISTINCT FROM OLD.binding_source_id
       OR NEW.posted_at IS DISTINCT FROM OLD.posted_at THEN
      RAISE EXCEPTION 'accounting.opening_balance_state_invalid: superseding changes the status and nothing else'
        USING ERRCODE = 'P0001';
    END IF;
    -- The precondition AL-13 makes physical: this opening balance's own
    -- journal entry must already have been reversed. A merchant replaces an
    -- opening position by first admitting, in the ledger, that the previous
    -- one was wrong.
    IF NOT EXISTS (SELECT 1 FROM accounting_reversals r
                   WHERE r.business_id = OLD.business_id AND r.original_entry_id = OLD.journal_entry_id) THEN
      RAISE EXCEPTION 'accounting.supersede_without_reversal: an opening balance may not be superseded until its journal entry has been reversed'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'accounting.opening_balance_state_invalid: a superseded opening balance is history and cannot be changed'
    USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER accounting_opening_balances_state_lock
  BEFORE UPDATE OR DELETE ON accounting_opening_balances
  FOR EACH ROW EXECUTE FUNCTION accounting_opening_balances_state();

CREATE OR REPLACE FUNCTION accounting_opening_balance_lines_state() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_status TEXT;
  v_row    accounting_opening_balance_lines;
BEGIN
  v_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  SELECT ob.status INTO v_status
  FROM accounting_opening_balances ob
  WHERE ob.business_id = v_row.business_id AND ob.id = v_row.opening_balance_id;
  -- A cascade from discarding a draft deletes the parent first, so the parent
  -- is already gone by the time this fires; that is the one legitimate way a
  -- line disappears.
  IF v_status IS NULL THEN
    RETURN v_row;
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'accounting.opening_balance_state_invalid: the positions of a % opening balance are immutable', v_status
      USING ERRCODE = 'P0001';
  END IF;
  RETURN v_row;
END;
$$;

CREATE TRIGGER accounting_opening_balance_lines_state_lock
  BEFORE INSERT OR UPDATE OR DELETE ON accounting_opening_balance_lines
  FOR EACH ROW EXECUTE FUNCTION accounting_opening_balance_lines_state();

-- ─────────────────────────────────────────────────────────────────────────
-- 5. The completeness rule, the opening-balance half.
--
-- The reasoning is 0046 section 6's, applied to the second derived source: a
-- `post` assertion naming source type `opening_balance` could otherwise drive
-- the primitive directly, state its own lines and its own equity plug, and
-- occupy the business's one opening-balance slot without ever passing
-- through the state machine above.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION accounting_opening_balance_entry_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.source_type = 'opening_balance'
     AND NOT EXISTS (SELECT 1 FROM accounting_opening_balances ob
                     WHERE ob.business_id = NEW.business_id AND ob.journal_entry_id = NEW.id
                       AND ob.status IN ('posted', 'superseded')) THEN
    RAISE EXCEPTION 'accounting.opening_balance_detail_missing: an opening-balance entry must be registered in accounting_opening_balances in the same transaction'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER journal_entries_opening_balance_complete
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION accounting_opening_balance_entry_complete();

-- ─────────────────────────────────────────────────────────────────────────
-- 6. RLS and grants.
--
-- This is the one place in the accounting perimeter where the internal
-- authority holds UPDATE and DELETE, and it is worth being explicit about
-- why that is not a hole. The journal is append-only because a posted entry
-- is a historical claim. An opening-balance SOURCE row is a workflow record
-- whose financial content becomes immutable at exactly the moment a journal
-- entry exists for it — before that it is a draft nobody has relied on, and
-- after that the triggers in section 4 admit exactly one status change and
-- nothing else. No runtime role holds either privilege, in any state.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE accounting_opening_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_opening_balances FORCE ROW LEVEL SECURITY;
ALTER TABLE accounting_opening_balance_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_opening_balance_lines FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_membership ON accounting_opening_balances
  USING (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = accounting_opening_balances.business_id AND b.tenant_id::text = app_tenant()))
  WITH CHECK (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = accounting_opening_balances.business_id AND b.tenant_id::text = app_tenant()));
CREATE POLICY accounting_writer ON accounting_opening_balances
  USING (current_user = 'daftar_accounting_internal')
  WITH CHECK (current_user = 'daftar_accounting_internal');
CREATE POLICY business_isolation ON accounting_opening_balances AS RESTRICTIVE
  USING (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id::text = app_business())
  WITH CHECK (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id::text = app_business());

CREATE POLICY tenant_membership ON accounting_opening_balance_lines
  USING (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = accounting_opening_balance_lines.business_id AND b.tenant_id::text = app_tenant()))
  WITH CHECK (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = accounting_opening_balance_lines.business_id AND b.tenant_id::text = app_tenant()));
CREATE POLICY accounting_writer ON accounting_opening_balance_lines
  USING (current_user = 'daftar_accounting_internal')
  WITH CHECK (current_user = 'daftar_accounting_internal');
CREATE POLICY business_isolation ON accounting_opening_balance_lines AS RESTRICTIVE
  USING (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id::text = app_business())
  WITH CHECK (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id::text = app_business());

REVOKE ALL ON accounting_opening_balances, accounting_opening_balance_lines FROM PUBLIC;

GRANT SELECT ON accounting_opening_balances, accounting_opening_balance_lines
  TO daftar_app, daftar_platform, daftar_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON accounting_opening_balances, accounting_opening_balance_lines
  TO daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 7. The draft domain capability (§37).
--
-- Five commands, because the lifecycle AL-13 specifies has five moves. Only
-- one of them is reachable over HTTP — §35 fixes the surface at three
-- endpoints — and that is deliberate: a capability the domain genuinely has
-- is not the same thing as a URL, and faking a draft by writing and deleting
-- journal rows (the alternative a missing capability invites) would be a
-- catastrophe in an append-only ledger.
--
-- Every command takes its authority from the same signed assertion: source
-- type `opening_balance`, source id equal to the row it names. The assertion
-- is what proves the business and the actor; the argument only says which
-- row, and a disagreement between the two is refused rather than resolved.
-- ─────────────────────────────────────────────────────────────────────────

-- The exact position payload. Deliberately its own list, NOT the journal
-- line schema: an opening position has no branch and no warehouse, and a
-- caller that sends one is refused by name rather than silently ignored.
CREATE OR REPLACE FUNCTION accounting_opening_balance_check_payload(p_lines JSONB) RETURNS VOID
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_keys TEXT[] := ARRAY['account','side','base_amount_minor','base_currency','txn_amount_minor',
                         'txn_currency','fx_rate','fx_rate_source','fx_rate_at','memo'];
  v_bad  TEXT;
  v_n    INTEGER;
BEGIN
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) < 1 THEN
    RAISE EXCEPTION 'accounting.payload_invalid: an opening balance needs at least one position' USING ERRCODE = 'P0001';
  END IF;

  SELECT string_agg(DISTINCT k, ', ') INTO v_bad
  FROM jsonb_array_elements(p_lines) e, jsonb_object_keys(e.value) k
  WHERE k <> ALL (v_keys);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'accounting.payload_unknown_field: the opening balance payload carries unknown field(s): %', v_bad USING ERRCODE = 'P0001';
  END IF;

  SELECT string_agg(DISTINCT k, ', ') INTO v_bad
  FROM jsonb_array_elements(p_lines) e, unnest(v_keys) k
  WHERE NOT (e.value ? k);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'accounting.payload_missing_field: the opening balance payload is missing field(s): %', v_bad USING ERRCODE = 'P0001';
  END IF;

  -- Money and rates are decimal STRINGS, exactly as the primitive requires. A
  -- JSON number would arrive as a double and could lose a BIGINT's low digits
  -- or a rate's tenth decimal with no error anywhere.
  SELECT count(*) INTO v_n
  FROM jsonb_array_elements(p_lines) e
  WHERE jsonb_typeof(e.value->'base_amount_minor') <> 'string'
     OR jsonb_typeof(e.value->'txn_amount_minor') <> 'string'
     OR jsonb_typeof(e.value->'fx_rate') <> 'string'
     OR (e.value->>'base_amount_minor') !~ '^[1-9][0-9]{0,18}$'
     OR (e.value->>'txn_amount_minor') !~ '^[1-9][0-9]{0,18}$'
     OR (e.value->>'fx_rate') !~ '^[0-9]{1,10}\.[0-9]{10}$'
     OR (e.value->>'side') NOT IN ('D','C')
     OR (e.value->>'base_currency') !~ '^[A-Z]{3}$'
     OR (e.value->>'txn_currency') !~ '^[A-Z]{3}$'
     OR (e.value->>'fx_rate_source') NOT IN ('base','manual')
     OR (e.value->>'fx_rate_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
     OR jsonb_typeof(e.value->'account') <> 'object'
     OR (e.value->'account'->>'kind') NOT IN ('system','code')
     OR ((e.value->'account'->>'kind') = 'system' AND coalesce(e.value->'account'->>'system_key','') !~ '^[a-z0-9_]{1,64}$')
     OR ((e.value->'account'->>'kind') = 'code'   AND coalesce(e.value->'account'->>'code','') = '')
     OR (jsonb_typeof(e.value->'memo') NOT IN ('string','null'));
  IF v_n > 0 THEN
    RAISE EXCEPTION 'accounting.payload_invalid: % opening balance position(s) do not match the exact input schema', v_n USING ERRCODE = 'P0001';
  END IF;

  -- The plug is the engine's to compute, so a caller may not state a
  -- position against the equity account it will be written to (§28). A
  -- merchant who could would be writing two equity lines, one of them
  -- invisible to the arithmetic that balances the entry.
  SELECT count(*) INTO v_n
  FROM jsonb_array_elements(p_lines) e
  WHERE e.value->'account'->>'kind' = 'system' AND e.value->'account'->>'system_key' = 'opening_equity';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'accounting.payload_invalid: the opening equity plug is computed by the engine and may not be stated as a position' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- Authority + the row this command is allowed to touch, in one place.
CREATE OR REPLACE FUNCTION accounting_opening_balance_authority(p_id UUID) RETURNS accounting_verified_actor
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_actor accounting_verified_actor;
BEGIN
  v_actor := accounting_actor(ARRAY['post']);
  IF NOT EXISTS (SELECT 1 FROM accounting_operation_kinds k
                 WHERE k.operation_kind = v_actor.operation_kind
                   AND k.source_type = v_actor.source_type
                   AND k.source_type = 'opening_balance') THEN
    RAISE EXCEPTION 'accounting.assertion_wrong_source: this authority does not create opening balances' USING ERRCODE = 'P0001';
  END IF;
  IF p_id IS NOT NULL AND v_actor.source_id IS DISTINCT FROM p_id THEN
    RAISE EXCEPTION 'accounting.assertion_payload_mismatch: the authority names a different opening balance' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_actor;
END;
$$;

-- 7a. CREATE — open a draft, or re-open the one this identity already has.
CREATE OR REPLACE FUNCTION accounting_open_balance_draft(
  p_as_of_date DATE,
  p_lines      JSONB
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor  accounting_verified_actor;
  v_tenant UUID;
  v_tz     TEXT;
  v_today  DATE;
  v_status TEXT;
BEGIN
  v_actor := accounting_opening_balance_authority(NULL);
  PERFORM accounting_opening_balance_check_payload(p_lines);

  SELECT b.tenant_id, b.timezone INTO v_tenant, v_tz
  FROM businesses b WHERE b.id = v_actor.business_id FOR SHARE;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'accounting.forbidden: the accounting assertion names a business that does not exist' USING ERRCODE = 'P0001';
  END IF;
  IF v_tenant IS DISTINCT FROM v_actor.tenant_id THEN
    RAISE EXCEPTION 'accounting.forbidden: the accounting assertion tenant does not own the named business' USING ERRCODE = 'P0001';
  END IF;

  -- AL-14: no lower bound at all — a company founded in 1974 has a real
  -- opening position older than any window anyone would invent — and never
  -- later than today in the BUSINESS's timezone.
  v_today := (now() AT TIME ZONE v_tz)::date;
  IF p_as_of_date IS NULL OR p_as_of_date > v_today THEN
    RAISE EXCEPTION 'accounting.entry_date_in_future: an opening balance may not be dated after today in the business timezone' USING ERRCODE = 'P0001';
  END IF;

  SELECT ob.status INTO v_status
  FROM accounting_opening_balances ob
  WHERE ob.business_id = v_actor.business_id AND ob.id = v_actor.source_id;

  IF v_status IS NULL THEN
    INSERT INTO accounting_opening_balances (tenant_id, business_id, id, status, as_of_date, actor_user_id)
    VALUES (v_tenant, v_actor.business_id, v_actor.source_id, 'draft', p_as_of_date, v_actor.actor_user_id);
  ELSIF v_status = 'draft' THEN
    -- The same identity re-stated is an EDIT, which is what a retry of an
    -- abandoned attempt looks like from here.
    PERFORM accounting_open_balance_edit(v_actor.source_id, p_as_of_date, p_lines);
    RETURN v_actor.source_id;
  ELSE
    -- Posted or superseded: the content is history. The caller learns the
    -- identity exists; `post` below is what returns the existing entry.
    RETURN v_actor.source_id;
  END IF;

  INSERT INTO accounting_opening_balance_lines (
    tenant_id, business_id, opening_balance_id, line_no, account_ref_kind, account_system_key, account_code,
    side, base_amount_minor, base_currency, txn_amount_minor, txn_currency, fx_rate, fx_rate_source, fx_rate_at, memo)
  SELECT v_tenant, v_actor.business_id, v_actor.source_id, t.ord::int,
         t.e->'account'->>'kind',
         CASE WHEN t.e->'account'->>'kind' = 'system' THEN t.e->'account'->>'system_key' END,
         CASE WHEN t.e->'account'->>'kind' = 'code'   THEN t.e->'account'->>'code' END,
         t.e->>'side',
         (t.e->>'base_amount_minor')::bigint, upper(t.e->>'base_currency'),
         (t.e->>'txn_amount_minor')::bigint,  upper(t.e->>'txn_currency'),
         (t.e->>'fx_rate')::numeric(20,10), t.e->>'fx_rate_source', (t.e->>'fx_rate_at')::timestamptz,
         t.e->>'memo'
  FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS t(e, ord);

  RETURN v_actor.source_id;
END;
$$;

-- 7b. EDIT — replace a draft's positions and as-of date. Draft only.
CREATE OR REPLACE FUNCTION accounting_open_balance_edit(
  p_id         UUID,
  p_as_of_date DATE,
  p_lines      JSONB
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor  accounting_verified_actor;
  v_tenant UUID;
  v_tz     TEXT;
  v_today  DATE;
  v_status TEXT;
BEGIN
  v_actor := accounting_opening_balance_authority(p_id);
  PERFORM accounting_opening_balance_check_payload(p_lines);

  SELECT b.tenant_id, b.timezone INTO v_tenant, v_tz
  FROM businesses b WHERE b.id = v_actor.business_id FOR SHARE;
  v_today := (now() AT TIME ZONE v_tz)::date;
  IF p_as_of_date IS NULL OR p_as_of_date > v_today THEN
    RAISE EXCEPTION 'accounting.entry_date_in_future: an opening balance may not be dated after today in the business timezone' USING ERRCODE = 'P0001';
  END IF;

  SELECT ob.status INTO v_status
  FROM accounting_opening_balances ob
  WHERE ob.business_id = v_actor.business_id AND ob.id = p_id FOR UPDATE;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'accounting.opening_balance_state_invalid: no opening balance of this business has that id' USING ERRCODE = 'P0001';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'accounting.opening_balance_state_invalid: a % opening balance cannot be edited', v_status USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM accounting_opening_balance_lines
  WHERE business_id = v_actor.business_id AND opening_balance_id = p_id;

  INSERT INTO accounting_opening_balance_lines (
    tenant_id, business_id, opening_balance_id, line_no, account_ref_kind, account_system_key, account_code,
    side, base_amount_minor, base_currency, txn_amount_minor, txn_currency, fx_rate, fx_rate_source, fx_rate_at, memo)
  SELECT v_tenant, v_actor.business_id, p_id, t.ord::int,
         t.e->'account'->>'kind',
         CASE WHEN t.e->'account'->>'kind' = 'system' THEN t.e->'account'->>'system_key' END,
         CASE WHEN t.e->'account'->>'kind' = 'code'   THEN t.e->'account'->>'code' END,
         t.e->>'side',
         (t.e->>'base_amount_minor')::bigint, upper(t.e->>'base_currency'),
         (t.e->>'txn_amount_minor')::bigint,  upper(t.e->>'txn_currency'),
         (t.e->>'fx_rate')::numeric(20,10), t.e->>'fx_rate_source', (t.e->>'fx_rate_at')::timestamptz,
         t.e->>'memo'
  FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS t(e, ord);

  UPDATE accounting_opening_balances SET as_of_date = p_as_of_date
  WHERE business_id = v_actor.business_id AND id = p_id;
END;
$$;

-- 7c. DISCARD — abandon a draft. Possible only while nothing depends on it.
CREATE OR REPLACE FUNCTION accounting_open_balance_discard(p_id UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor  accounting_verified_actor;
  v_status TEXT;
BEGIN
  v_actor := accounting_opening_balance_authority(p_id);
  SELECT ob.status INTO v_status
  FROM accounting_opening_balances ob
  WHERE ob.business_id = v_actor.business_id AND ob.id = p_id FOR UPDATE;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'accounting.opening_balance_state_invalid: no opening balance of this business has that id' USING ERRCODE = 'P0001';
  END IF;
  -- The trigger in section 4 refuses anything but a draft with no journal
  -- identity; this raise exists only so the caller reads a sentence rather
  -- than a trigger message.
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'accounting.opening_balance_state_invalid: a % opening balance cannot be discarded', v_status USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM accounting_opening_balances WHERE business_id = v_actor.business_id AND id = p_id;
END;
$$;

-- 7d. SUPERSEDE — retire a posted opening balance whose entry was reversed.
CREATE OR REPLACE FUNCTION accounting_open_balance_supersede(p_id UUID, p_request_id TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor  accounting_verified_actor;
  v_tenant UUID;
  v_status TEXT;
  v_entry  UUID;
BEGIN
  -- Superseding is done in the same breath as posting the replacement, so the
  -- authority is the replacement's. The argument names the row being retired,
  -- which is a different id from the one the assertion carries; the business
  -- and the actor still come only from the assertion.
  v_actor := accounting_opening_balance_authority(NULL);

  SELECT ob.tenant_id, ob.status, ob.journal_entry_id INTO v_tenant, v_status, v_entry
  FROM accounting_opening_balances ob
  WHERE ob.business_id = v_actor.business_id AND ob.id = p_id FOR UPDATE;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'accounting.opening_balance_state_invalid: no opening balance of this business has that id' USING ERRCODE = 'P0001';
  END IF;
  IF v_status <> 'posted' THEN
    RAISE EXCEPTION 'accounting.opening_balance_state_invalid: a % opening balance cannot be superseded', v_status USING ERRCODE = 'P0001';
  END IF;

  -- The trigger enforces this too, physically and unconditionally. Checking
  -- here as well is what turns a trigger message into the domain's own word.
  IF NOT EXISTS (SELECT 1 FROM accounting_reversals r
                 WHERE r.business_id = v_actor.business_id AND r.original_entry_id = v_entry) THEN
    RAISE EXCEPTION 'accounting.supersede_without_reversal: an opening balance may not be superseded until its journal entry has been reversed'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE accounting_opening_balances
  SET status = 'superseded', superseded_at = now()
  WHERE business_id = v_actor.business_id AND id = p_id;

  INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, request_id, metadata)
  VALUES (v_tenant, v_actor.business_id, v_actor.actor_user_id, 'accounting.opening_balance_superseded', 'accounting_opening_balance',
          p_id::text, p_request_id, jsonb_build_object('journalEntryId', v_entry));
END;
$$;

-- 7e. POST — derive the journal from the persisted draft and hand it to the
--     hardened primitive.
--
-- The caller states no journal line here either: the positions were
-- persisted by `draft`, the plug is arithmetic over them, and the entry that
-- results is whatever those two produce. The merchant API derives the same
-- lines from the same rows and signs their digest; the primitive recomputes
-- it a third time from what it actually receives and refuses any difference.
CREATE OR REPLACE FUNCTION accounting_open_balance_post(
  p_id          UUID,
  p_description TEXT,
  p_request_id  TEXT
) RETURNS TABLE (entry_id UUID, created BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor    accounting_verified_actor;
  v_tenant   UUID;
  v_base     TEXT;
  v_tz       TEXT;
  v_today    DATE;
  v_status   TEXT;
  v_as_of    DATE;
  v_entry    UUID;
  v_created  BOOLEAN;
  v_dr       NUMERIC;
  v_cr       NUMERIC;
  v_plug     NUMERIC;
  v_side     TEXT;
  v_lines    JSONB;
  v_prev     UUID;
  v_prev_je  UUID;
  v_count    INTEGER;
BEGIN
  v_actor := accounting_opening_balance_authority(p_id);

  SELECT b.tenant_id, b.base_currency, b.timezone INTO v_tenant, v_base, v_tz
  FROM businesses b WHERE b.id = v_actor.business_id FOR SHARE;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'accounting.forbidden: the accounting assertion names a business that does not exist' USING ERRCODE = 'P0001';
  END IF;
  IF v_tenant IS DISTINCT FROM v_actor.tenant_id THEN
    RAISE EXCEPTION 'accounting.forbidden: the accounting assertion tenant does not own the named business' USING ERRCODE = 'P0001';
  END IF;

  -- One opening-balance posting per business at a time. The partial unique
  -- index is the real guarantee; this lock is what turns the loser's outcome
  -- from an index name into a sentence.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_actor.business_id::text || '|opening_balance', 0));

  SELECT ob.status, ob.as_of_date, ob.journal_entry_id INTO v_status, v_as_of, v_entry
  FROM accounting_opening_balances ob
  WHERE ob.business_id = v_actor.business_id AND ob.id = p_id FOR UPDATE;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'accounting.opening_balance_state_invalid: no opening balance of this business has that id' USING ERRCODE = 'P0001';
  END IF;
  IF v_status = 'posted' THEN
    -- An at-least-once retry of a posting that already happened.
    RETURN QUERY SELECT v_entry, false;
    RETURN;
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'accounting.opening_balance_state_invalid: a % opening balance cannot be posted', v_status USING ERRCODE = 'P0001';
  END IF;

  v_today := (now() AT TIME ZONE v_tz)::date;
  IF v_as_of > v_today THEN
    RAISE EXCEPTION 'accounting.entry_date_in_future: an opening balance may not be dated after today in the business timezone' USING ERRCODE = 'P0001';
  END IF;

  -- Every position is denominated in the business's base currency, read under
  -- the same lock as the currency itself. The primitive refuses this too; the
  -- check here names the count rather than letting a deferred validator
  -- reject at COMMIT an entry the caller believed it had written.
  SELECT count(*) INTO v_count
  FROM accounting_opening_balance_lines l
  WHERE l.business_id = v_actor.business_id AND l.opening_balance_id = p_id AND l.base_currency <> v_base;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'accounting.entry_base_currency_mismatch: % opening position(s) are not denominated in the business base currency %', v_count, v_base
      USING ERRCODE = 'P0001';
  END IF;

  -- ── The equity plug (§28) ──────────────────────────────────────────────
  -- Summed in NUMERIC, never BIGINT: a cap on each position is not a cap on
  -- their total, and the arithmetic that decides the plug must not be the
  -- thing that overflows.
  SELECT coalesce(sum(CASE WHEN l.side = 'D' THEN l.base_amount_minor ELSE 0 END), 0),
         coalesce(sum(CASE WHEN l.side = 'C' THEN l.base_amount_minor ELSE 0 END), 0)
    INTO v_dr, v_cr
  FROM accounting_opening_balance_lines l
  WHERE l.business_id = v_actor.business_id AND l.opening_balance_id = p_id;

  IF v_dr + v_cr = 0 THEN
    RAISE EXCEPTION 'accounting.payload_invalid: an opening balance needs at least one position' USING ERRCODE = 'P0001';
  END IF;

  v_plug := abs(v_dr - v_cr);
  v_side := CASE WHEN v_dr > v_cr THEN 'C' ELSE 'D' END;
  IF v_plug > 1000000000000000000 THEN
    RAISE EXCEPTION 'accounting.payload_invalid: the opening equity plug exceeds the money cap' USING ERRCODE = 'P0001';
  END IF;

  SELECT jsonb_agg(
           jsonb_build_object(
             'account', CASE WHEN l.account_ref_kind = 'system'
                             THEN jsonb_build_object('kind', 'system', 'system_key', l.account_system_key)
                             ELSE jsonb_build_object('kind', 'code', 'code', l.account_code) END,
             'side', l.side,
             'base_amount_minor', l.base_amount_minor::text,
             'base_currency', l.base_currency,
             'txn_amount_minor', l.txn_amount_minor::text,
             'txn_currency', l.txn_currency,
             'fx_rate', l.fx_rate::text,
             'fx_rate_source', l.fx_rate_source,
             'fx_rate_at', to_char(l.fx_rate_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
             'branch_id', NULL::text,
             'warehouse_id', NULL::text,
             'memo', l.memo)
           ORDER BY l.line_no)
    INTO v_lines
  FROM accounting_opening_balance_lines l
  WHERE l.business_id = v_actor.business_id AND l.opening_balance_id = p_id;

  -- The plug's own snapshot instant is the as-of date at midnight UTC:
  -- deterministic, derived from the opening balance itself, and therefore
  -- reproducible by the independent derivation that signed the fingerprint.
  -- A wall-clock `now()` here would make the digest unreproducible and every
  -- posting would fail with a payload mismatch.
  IF v_plug > 0 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account', jsonb_build_object('kind', 'system', 'system_key', 'opening_equity'),
      'side', v_side,
      'base_amount_minor', v_plug::bigint::text,
      'base_currency', v_base,
      'txn_amount_minor', v_plug::bigint::text,
      'txn_currency', v_base,
      'fx_rate', '1.0000000000',
      'fx_rate_source', 'base',
      'fx_rate_at', to_char(v_as_of, 'YYYY-MM-DD') || 'T00:00:00Z',
      'branch_id', NULL::text,
      'warehouse_id', NULL::text,
      'memo', NULL::text));
  END IF;

  -- ── Replacement: reverse, then supersede, then post (§32) ──────────────
  SELECT ob.id, ob.journal_entry_id INTO v_prev, v_prev_je
  FROM accounting_opening_balances ob
  WHERE ob.business_id = v_actor.business_id AND ob.status = 'posted' AND ob.id <> p_id;

  IF v_prev IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM accounting_reversals r
                   WHERE r.business_id = v_actor.business_id AND r.original_entry_id = v_prev_je) THEN
      RAISE EXCEPTION 'accounting.opening_balance_exists: this business already has a posted opening balance; reverse it before stating another'
        USING ERRCODE = 'P0001';
    END IF;
    PERFORM accounting_open_balance_supersede(v_prev, p_request_id);
  END IF;

  SELECT p.entry_id, p.created INTO v_entry, v_created
  FROM accounting_post_entry(v_as_of, p_description, p_request_id, v_lines) AS p;

  UPDATE accounting_opening_balances
  SET status = 'posted', journal_entry_id = v_entry, binding_source_id = p_id, posted_at = now()
  WHERE business_id = v_actor.business_id AND id = p_id;

  INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, request_id, metadata)
  VALUES (v_tenant, v_actor.business_id, v_actor.actor_user_id, 'accounting.opening_balance_posted', 'accounting_opening_balance',
          p_id::text, p_request_id, jsonb_build_object('journalEntryId', v_entry, 'sourceType', 'opening_balance', 'sourceId', p_id));

  INSERT INTO outbox_events (tenant_id, business_id, type, payload)
  VALUES (v_tenant, v_actor.business_id, 'accounting.opening_balance.posted',
          jsonb_build_object('openingBalanceId', p_id, 'entryId', v_entry, 'businessId', v_actor.business_id,
                             'sourceType', 'opening_balance', 'sourceId', p_id));

  RETURN QUERY SELECT v_entry, v_created;
EXCEPTION
  WHEN unique_violation THEN
    IF SQLERRM LIKE '%accounting_opening_balances_posted_uq%' THEN
      RAISE EXCEPTION 'accounting.opening_balance_exists: this business already has a posted opening balance; reverse it before stating another'
        USING ERRCODE = 'P0001';
    END IF;
    RAISE;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 8. Ownership and the final ACL. ACL first, ownership second — 0045 §9.
-- ─────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION accounting_opening_balance_check_payload(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_opening_balance_authority(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_opening_balances_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_opening_balance_lines_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_opening_balance_entry_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_open_balance_draft(DATE, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_open_balance_edit(UUID, DATE, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_open_balance_discard(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_open_balance_supersede(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_open_balance_post(UUID, TEXT, TEXT) FROM PUBLIC;

-- The four moves a merchant can actually make. `supersede` is NOT among them:
-- retiring an opening position is only ever correct as part of posting its
-- replacement, so it stays an internal step of `post` rather than a verb
-- anyone can reach on its own.
GRANT EXECUTE ON FUNCTION accounting_open_balance_draft(DATE, JSONB) TO daftar_app;
GRANT EXECUTE ON FUNCTION accounting_open_balance_edit(UUID, DATE, JSONB) TO daftar_app;
GRANT EXECUTE ON FUNCTION accounting_open_balance_discard(UUID) TO daftar_app;
GRANT EXECUTE ON FUNCTION accounting_open_balance_post(UUID, TEXT, TEXT) TO daftar_app;

COMMENT ON FUNCTION accounting_open_balance_post(UUID, TEXT, TEXT) IS
  'Derives an opening balance''s journal from its persisted positions plus the engine-computed opening_equity plug, posts it through accounting_post_entry, and moves the source from draft to posted in the same transaction. Supersedes a previous posted set only when that set''s journal entry has already been reversed.';

ALTER FUNCTION accounting_opening_balance_check_payload(JSONB) OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_opening_balance_authority(UUID) OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_opening_balances_state() OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_opening_balance_lines_state() OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_opening_balance_entry_complete() OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_open_balance_draft(DATE, JSONB) OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_open_balance_edit(UUID, DATE, JSONB) OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_open_balance_discard(UUID) OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_open_balance_supersede(UUID, TEXT) OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_open_balance_post(UUID, TEXT, TEXT) OWNER TO daftar_accounting_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 9. Refuse to commit unless the end state is exactly right.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_role TEXT;
  v_tbl  TEXT;
  v_priv TEXT;
  v_fn   TEXT;
  v_n    INTEGER;
  v_cfg  TEXT[];
  v_path TEXT;
BEGIN
  -- (a) No runtime role may write either table directly, in any state.
  FOR v_role IN
    SELECT unnest(ARRAY['daftar_app','daftar_platform','daftar_worker','daftar_identity','daftar_resolver','daftar_provisioner','public'])
  LOOP
    FOR v_tbl IN SELECT unnest(ARRAY['accounting_opening_balances','accounting_opening_balance_lines'])
    LOOP
      FOR v_priv IN SELECT unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE'])
      LOOP
        IF has_table_privilege(v_role, v_tbl, v_priv) THEN
          RAISE EXCEPTION 'accounting.writer_exposed: % holds direct % on %', v_role, v_priv, v_tbl;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  -- (b) Exactly one posted opening balance per business is a physical index,
  --     not a convention.
  SELECT count(*) INTO v_n FROM pg_indexes
  WHERE schemaname = 'public' AND indexname = 'accounting_opening_balances_posted_uq'
    AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%WHERE (status = ''posted''::text)%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'accounting.opening_balance_uniqueness_missing: the partial unique index is not installed as specified';
  END IF;

  -- (c) The state machine and the completeness rule are installed, and the
  --     completeness rule is deferred.
  SELECT count(*) INTO v_n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
  WHERE c.relname = 'accounting_opening_balances' AND t.tgname = 'accounting_opening_balances_state_lock' AND NOT t.tgisinternal;
  IF v_n <> 1 THEN RAISE EXCEPTION 'accounting.state_machine_missing: the opening balance state trigger is not installed'; END IF;

  SELECT count(*) INTO v_n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
  WHERE c.relname = 'accounting_opening_balance_lines' AND t.tgname = 'accounting_opening_balance_lines_state_lock' AND NOT t.tgisinternal;
  IF v_n <> 1 THEN RAISE EXCEPTION 'accounting.state_machine_missing: the opening balance line trigger is not installed'; END IF;

  SELECT count(*) INTO v_n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
  WHERE c.relname = 'journal_entries' AND t.tgname = 'journal_entries_opening_balance_complete'
    AND t.tgdeferrable AND t.tginitdeferred AND NOT t.tgisinternal;
  IF v_n <> 1 THEN RAISE EXCEPTION 'accounting.completeness_missing: the deferred opening-balance completeness trigger is not installed'; END IF;

  -- (d) Both tables FORCE row level security.
  FOR v_tbl IN SELECT unnest(ARRAY['accounting_opening_balances','accounting_opening_balance_lines'])
  LOOP
    SELECT count(*) INTO v_n FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    WHERE c.relname = v_tbl AND c.relrowsecurity AND c.relforcerowsecurity;
    IF v_n <> 1 THEN RAISE EXCEPTION 'accounting.rls_missing: % does not force row level security', v_tbl; END IF;
  END LOOP;

  -- (e) The merchant runtime reaches exactly the four draft-lifecycle verbs,
  --     and no other role reaches any of them.
  FOR v_fn IN
    SELECT unnest(ARRAY['accounting_open_balance_draft(date,jsonb)','accounting_open_balance_edit(uuid,date,jsonb)',
                        'accounting_open_balance_discard(uuid)','accounting_open_balance_post(uuid,text,text)'])
  LOOP
    FOR v_role IN
      SELECT unnest(ARRAY['daftar_platform','daftar_worker','daftar_identity','daftar_resolver','daftar_provisioner','public'])
    LOOP
      IF has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION 'accounting.writer_exposed: runtime role % may execute %', v_role, v_fn;
      END IF;
    END LOOP;
    IF NOT has_function_privilege('daftar_app', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'accounting.writer_invalid: daftar_app cannot execute %', v_fn;
    END IF;
  END LOOP;

  -- (f) Superseding is not a verb anyone can reach on its own.
  FOR v_role IN
    SELECT unnest(ARRAY['daftar_app','daftar_platform','daftar_worker','daftar_identity','daftar_resolver','daftar_provisioner','public'])
  LOOP
    IF has_function_privilege(v_role, 'accounting_open_balance_supersede(uuid,text)', 'EXECUTE')
       OR has_function_privilege(v_role, 'accounting_opening_balance_authority(uuid)', 'EXECUTE')
       OR has_function_privilege(v_role, 'accounting_opening_balance_check_payload(jsonb)', 'EXECUTE')
       OR has_function_privilege(v_role, 'accounting_opening_balances_state()', 'EXECUTE')
       OR has_function_privilege(v_role, 'accounting_opening_balance_lines_state()', 'EXECUTE')
       OR has_function_privilege(v_role, 'accounting_opening_balance_entry_complete()', 'EXECUTE') THEN
      RAISE EXCEPTION 'accounting.writer_exposed: % may execute an internal opening-balance routine directly', v_role;
    END IF;
  END LOOP;

  -- (g) G-5 against the live catalogue: pg_temp explicit and LAST, on every
  --     routine this migration introduces.
  FOR v_fn, v_cfg IN
    SELECT p.proname, p.proconfig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
    WHERE p.proname LIKE 'accounting_open%' OR p.proname LIKE 'accounting_opening%'
  LOOP
    SELECT c INTO v_path FROM unnest(coalesce(v_cfg, ARRAY[]::text[])) AS c WHERE strpos(c, 'search_path=') = 1;
    IF v_path IS NULL OR v_path <> 'search_path=pg_catalog, public, pg_temp' THEN
      RAISE EXCEPTION 'accounting.search_path_unpinned: % does not pin the repository standard search_path', v_fn;
    END IF;
  END LOOP;

  -- (h) No routine here builds a session temporary relation (TH-27).
  SELECT count(*) INTO v_n
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE (p.proname LIKE 'accounting_open%' OR p.proname LIKE 'accounting_opening%')
    AND (p.prosrc ~* '\mtemporary\M' OR p.prosrc ~* '\mtemp\s+table\M' OR p.prosrc ~* '\mcreate\s+temp\M');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'accounting.temp_relation_used: an elevated routine builds a session temporary relation';
  END IF;

  -- (i) The temporary ownership-transfer authority is gone.
  IF has_schema_privilege('daftar_accounting_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'accounting.schema_authority_leaked: daftar_accounting_internal still holds CREATE on schema public';
  END IF;

  -- (j) This slice created exactly two migrations' worth of source tables and
  --     no accounting period, FX registry or read model came with them.
  SELECT count(*) INTO v_n FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  WHERE c.relkind = 'r' AND c.relname IN ('accounting_periods','accounting_fx_rates','accounting_balances','accounting_trial_balance');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'accounting.scope_exceeded: P2-S4 must not create periods, an FX registry or a read model';
  END IF;
END $$;
