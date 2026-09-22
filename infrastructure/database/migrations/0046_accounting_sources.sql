-- 0046_accounting_sources.sql
-- P2-S4, part 1 of 2 — the two correction sources (directive §7-§21, §38-§46).
--
-- P2-S3 ended with a hardened ledger writer that nothing in the product could
-- reach: `accounting_post_entry` existed, it was safe, and no business fact
-- was wired to it. This migration wires the first two — a merchant-authored
-- MANUAL ADJUSTMENT and a REVERSAL — and it does so by building ON TOP of
-- that writer rather than around it.
--
-- ── What each source is, in one line ─────────────────────────────────────
--
--   manual_adjustment  the merchant states the lines; they are ordinary new
--                      truth and ride `accounting_post_entry` unchanged.
--   reversal           the merchant states NOTHING but which entry and why;
--                      every line is derived from the persisted original.
--
-- ── Why a reversal needs a writer of its own (§15, §21) ──────────────────
--
-- A reversal is the one posting whose accounts are not a free choice. It
-- names exactly the accounts the original already named, and §15 requires it
-- to succeed even when one of those accounts has since been DEACTIVATED —
-- without reactivating it, without routing the amount elsewhere, and without
-- weakening the rule for ordinary postings.
--
-- `accounting_post_entry` refuses an inactive account (its step 8), and its
-- bytes are frozen at the hash P2-S3 was accepted at. So a reversal cannot go
-- through it. The honest consequence is a SECOND SECURITY DEFINER journal
-- writer, `accounting_post_reversal`, and the honest cost is that every
-- protection the first writer earned has to be re-earned here line by line
-- rather than inherited. Guard G-4 is widened in the same slice so that "the
-- writer must carry its protections" is a statement about EVERY routine
-- capable of a journal write, not about one function name.
--
-- The rule the new writer relaxes is stated once, here, and nowhere else:
--   * an account must be ACTIVE to receive NEW truth — that is what stops a
--     merchant filing fresh business into a retired account;
--   * a reversal creates no new account relationship. It removes one. The
--     accounts it names are already in the ledger's history, and refusing to
--     undo an entry because the account it used has been retired would make
--     deactivation a way to make a mistake permanent.
-- Nothing else is relaxed: authority, tenant binding, payload binding, the
-- base-currency rule, the date policy, account stabilization, the source
-- binding, audit and outbox are all present and all enforced.
--
-- ── Why a `reverse` operation kind (§19) ─────────────────────────────────
--
-- Two writers mean two authorities, and an assertion minted to post must not
-- drive a reversal. The assertion already carries an operation kind, which is
-- signed; `accounting_post_entry` accepts only `post` and the new writer
-- accepts only `reverse`, so neither can be driven by the other's authority.
-- Which kind may carry which source identity is DATA, in
-- `accounting_operation_kinds`, not a branch in a function.
--
-- ── Why a reversal-typed entry cannot be forged through the old path ─────
--
-- `accounting_post_entry` still accepts any registered source type, including
-- `reversal`. A deferred constraint trigger closes that: an entry whose
-- source type is `reversal` must be registered in `accounting_reversals` by
-- COMMIT, and only `accounting_post_reversal` can write that table. A `post`
-- assertion naming source type `reversal` therefore cannot leave a committed
-- row behind, and cannot squat the one reversal slot an entry has.
--
-- Migrations 0000-0045 are frozen and untouched. No 0048 exists.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The ownership-transfer authority, taken and returned inside this file.
--    Same dance as 0040/0042/0045: DDL is transactional, so none of the
--    temporary state ever exists in a committed database, and section 10
--    refuses to commit if any of it survived. Nothing assumes SUPERUSER.
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. `accounting_operation_kinds` — which authority may create which source.
--
-- AL-03 gave the assertion an operation kind and P2-S3 registered exactly
-- one. A second writer needs a second kind, and the pairing between a kind
-- and the source identities it may create is the kind of fact that belongs
-- in a table: a future slice registers a row instead of editing a routine.
--
-- The pairing is deliberately many-to-one in one direction only: a kind may
-- carry several source types, a source type belongs to exactly ONE kind. That
-- is what makes "an assertion minted to post cannot drive a reversal" a
-- property of the data rather than of a function's argument list.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE accounting_operation_kinds (
  operation_kind TEXT NOT NULL CHECK (operation_kind ~ '^[a-z][a-z0-9_]{1,30}$'),
  source_type    TEXT NOT NULL REFERENCES accounting_source_types (source_type),
  description    TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 200),
  PRIMARY KEY (operation_kind, source_type),
  -- One owner per source identity. This is the constraint that matters.
  UNIQUE (source_type)
);

COMMENT ON TABLE accounting_operation_kinds IS
  'Which signed operation kind may create which accounting source identity (AL-03, directive §19, §39). A source type belongs to exactly one kind, so an assertion minted for one workflow can never authorize another.';

INSERT INTO accounting_operation_kinds (operation_kind, source_type, description) VALUES
  ('post',    'manual_adjustment', 'Merchant-authored correction; the caller states the lines.'),
  ('post',    'opening_balance',   'Opening position; the caller states the positions, the engine derives the plug.'),
  ('reverse', 'reversal',          'Undo of an earlier entry; every line is derived from the persisted original.');

DO $$
DECLARE v_n INTEGER;
BEGIN
  SELECT count(*) INTO v_n FROM accounting_operation_kinds;
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'accounting.operation_kind_registry_invalid: expected exactly 3 pairings, found %', v_n;
  END IF;
  -- Every registered source type has an owning kind. A source nobody may
  -- create is a source that cannot be posted, which is worse than useless.
  IF EXISTS (SELECT 1 FROM accounting_source_types st
             WHERE NOT EXISTS (SELECT 1 FROM accounting_operation_kinds k WHERE k.source_type = st.source_type)) THEN
    RAISE EXCEPTION 'accounting.operation_kind_registry_incomplete: a registered source type has no owning operation kind';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. `accounting_manual_adjustments` — the narrative half of an adjustment.
--
-- The financial half IS the journal entry. This table exists so that "why"
-- survives next to "what", and so the source identity has a domain row the
-- way AL-01 describes: it references the BINDING, not `journal_entries`, so
-- deleting a detail row could never destroy the link even if a DELETE grant
-- appeared by accident (there is none).
--
-- `source_type` is a pinned constant column rather than a repeated literal:
-- it is what makes the composite foreign key to the binding registry
-- expressible at all, and the CHECK keeps it honest.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE accounting_manual_adjustments (
  tenant_id     UUID NOT NULL,
  business_id   UUID NOT NULL,
  id            UUID NOT NULL,
  source_type   TEXT NOT NULL DEFAULT 'manual_adjustment' CHECK (source_type = 'manual_adjustment'),
  reason        TEXT NOT NULL CHECK (btrim(reason) <> '' AND char_length(reason) BETWEEN 1 AND 500),
  actor_user_id UUID NOT NULL REFERENCES users (id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  CONSTRAINT accounting_manual_adjustments_tenant_business_fk
    FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT accounting_manual_adjustments_binding_fk
    FOREIGN KEY (business_id, source_type, id)
    REFERENCES accounting_source_bindings (business_id, source_type, source_id)
    DEFERRABLE INITIALLY DEFERRED
);

COMMENT ON TABLE accounting_manual_adjustments IS
  'Narrative detail of a merchant-authored adjustment (AL-01, directive §10). The financial truth is the journal entry; this row carries the mandatory reason and the actor, and is written only by accounting_post_manual_adjustment.';

-- ─────────────────────────────────────────────────────────────────────────
-- 4. `accounting_reversals` — AL-12, physically.
--
-- The source identity of a reversal IS the original entry's id. That single
-- decision is what makes a second reversal impossible without an application
-- check: `journal_entries (business_id, source_type, source_id)` is already
-- UNIQUE, and `accounting_source_bindings` says the same thing from its side.
-- `UNIQUE (business_id, original_entry_id)` here states it a third time, in
-- the table a reader will actually look at to ask "is this entry reversed?".
--
-- What is deliberately NOT here: a `reversed`, `reversed_at` or
-- `reversed_by_entry_id` column on `journal_entries`. Writing one would
-- mutate a posted entry, which the ledger's whole design refuses. The
-- question is answered by a join, forever.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE accounting_reversals (
  tenant_id         UUID NOT NULL,
  business_id       UUID NOT NULL,
  id                UUID NOT NULL,
  source_type       TEXT NOT NULL DEFAULT 'reversal' CHECK (source_type = 'reversal'),
  original_entry_id UUID NOT NULL,
  journal_entry_id  UUID NOT NULL,
  reason            TEXT NOT NULL CHECK (btrim(reason) <> '' AND char_length(reason) BETWEEN 1 AND 500),
  actor_kind        TEXT NOT NULL CHECK (actor_kind IN ('user', 'system')),
  actor_user_id     UUID REFERENCES users (id),
  actor_system_key  TEXT REFERENCES accounting_system_actors (system_key),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  -- The source identity IS the original entry (AL-12). Stated as a CHECK so
  -- no writer, present or future, can register a reversal under some other
  -- identity and quietly free the slot for a second one.
  CONSTRAINT accounting_reversals_identity_ck CHECK (id = original_entry_id),
  CONSTRAINT accounting_reversals_distinct_ck CHECK (journal_entry_id <> original_entry_id),
  UNIQUE (business_id, original_entry_id),
  UNIQUE (business_id, journal_entry_id),
  CONSTRAINT accounting_reversals_tenant_business_fk
    FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  -- Composite on business_id in BOTH directions: a reversal can never point
  -- at another business's entry, whichever end you read it from.
  CONSTRAINT accounting_reversals_original_fk
    FOREIGN KEY (business_id, original_entry_id) REFERENCES journal_entries (business_id, id),
  CONSTRAINT accounting_reversals_entry_fk
    FOREIGN KEY (business_id, journal_entry_id) REFERENCES journal_entries (business_id, id),
  CONSTRAINT accounting_reversals_binding_fk
    FOREIGN KEY (business_id, source_type, id)
    REFERENCES accounting_source_bindings (business_id, source_type, source_id)
    DEFERRABLE INITIALLY DEFERRED,
  -- AL-04 actor shape, the same physical rule the journal itself carries.
  CONSTRAINT accounting_reversals_actor_shape_ck CHECK (
    (actor_kind = 'user' AND actor_user_id IS NOT NULL AND actor_system_key IS NULL)
    OR (actor_kind = 'system' AND actor_user_id IS NULL AND actor_system_key IS NOT NULL)
  )
);

COMMENT ON TABLE accounting_reversals IS
  'AL-12 reversal registry. source identity = the original entry id, so a second reversal of one entry is structurally impossible. "Is this entry reversed?" is answered by joining here — never by a flag on the posted original.';

CREATE INDEX accounting_reversals_business_entry_idx
  ON accounting_reversals (business_id, journal_entry_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Immutability. These rows are inside the ledger perimeter.
--
-- A correction in accounting is another accounting fact: nothing here is ever
-- edited or deleted, including by the table owner. Two independent
-- mechanisms, deliberately redundant — no runtime role holds UPDATE or
-- DELETE (section 7), and these triggers raise unconditionally.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION accounting_manual_adjustments_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'accounting.source_immutable: a posted manual adjustment cannot be % (business %, source %)',
    lower(TG_OP), OLD.business_id, OLD.id USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER accounting_manual_adjustments_no_mutation
  BEFORE UPDATE OR DELETE ON accounting_manual_adjustments
  FOR EACH ROW EXECUTE FUNCTION accounting_manual_adjustments_immutable();

CREATE OR REPLACE FUNCTION accounting_reversals_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'accounting.source_immutable: a recorded reversal cannot be % (business %, entry %)',
    lower(TG_OP), OLD.business_id, OLD.original_entry_id USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER accounting_reversals_no_mutation
  BEFORE UPDATE OR DELETE ON accounting_reversals
  FOR EACH ROW EXECUTE FUNCTION accounting_reversals_immutable();

-- ─────────────────────────────────────────────────────────────────────────
-- 6. The completeness rule: a reversal entry must be a registered reversal.
--
-- Without this, an assertion minted with operation kind `post` and source
-- type `reversal` could drive the ORIGINAL primitive, invent its own lines,
-- and occupy the one reversal slot the entry has — leaving a journal entry
-- that claims to undo something while `accounting_reversals` knows nothing
-- about it. The pairing in section 2 is then only a statement about what the
-- application intends, and AL-12's guarantee would be an application-level
-- promise rather than a physical one.
--
-- DEFERRED, because the entry and its registration are written in one
-- transaction and the writer must be free to write them in either order —
-- exactly the reasoning AL-01 gives for the binding's own two directions.
--
-- SECURITY DEFINER, because `accounting_reversals` FORCEs row level security
-- and this check must see the same rows no matter which principal's INSERT
-- fired it. A visibility-dependent integrity check is not an integrity check.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION accounting_reversal_entry_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.source_type = 'reversal'
     AND NOT EXISTS (SELECT 1 FROM accounting_reversals r
                     WHERE r.business_id = NEW.business_id AND r.journal_entry_id = NEW.id) THEN
    RAISE EXCEPTION 'accounting.reversal_detail_missing: a reversal entry must be registered in accounting_reversals in the same transaction'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER journal_entries_reversal_complete
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION accounting_reversal_entry_complete();

-- ────────────────────────────────────────────────────────────────────────
-- 6b. The same rule, for the manual adjustment.
--
-- Section 6 makes "a reversal entry is a registered reversal" physically
-- true. The third native source needs the identical sentence, and the reason
-- it needs it is not only an attacker.
--
-- `accounting_post_entry` is generic by design: it posts whatever source type
-- the verified assertion names. An assertion for `operation_kind = post`,
-- `source_type = manual_adjustment` is not a forgery — it is exactly the
-- assertion `accounting_post_manual_adjustment` carries — so whoever holds
-- one can call the primitive DIRECTLY and get an entry, its lines, its
-- binding, its audit row and its outbox row while `accounting_manual_adjustments`
-- is never written. The result is an adjustment in the ledger with no reason
-- and no actor: the one source whose entire justification is "a person
-- decided this" would be the one source that fails to record who, or why.
--
-- Nobody has to be hostile to arrive there. `@daftar/accounting` offers
-- `post()` next to `adjust()`, and `post()` takes the source type as a
-- string. A domain written later, by somebody who has never read this file,
-- will reach for the general one. "The wrapper requires a reason" is then a
-- convention about which function people call, and a convention is not an
-- invariant. This trigger is what makes the sentence true at COMMIT whichever
-- internal API the caller picked.
--
-- `accounting_manual_adjustments_binding_fk` already proves the other
-- direction: a detail row must resolve to a real source binding. The two
-- together leave no orphan on either side.
--
-- DEFERRED and SECURITY DEFINER for precisely the reasons section 6 gives.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION accounting_manual_adjustment_entry_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.source_type = 'manual_adjustment'
     AND NOT EXISTS (SELECT 1 FROM accounting_manual_adjustments m
                     WHERE m.business_id = NEW.business_id AND m.id = NEW.source_id) THEN
    RAISE EXCEPTION 'accounting.adjustment_detail_missing: a manual-adjustment entry must be registered in accounting_manual_adjustments in the same transaction'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER journal_entries_manual_adjustment_complete
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION accounting_manual_adjustment_entry_complete();

-- ─────────────────────────────────────────────────────────────────────────
-- 7. RLS and grants — default deny, and no runtime writer anywhere.
--
-- End state:
--   daftar_app                     SELECT on both tables, nothing else
--   daftar_platform / _worker      SELECT
--   every other runtime role       nothing
--   daftar_accounting_internal     SELECT + INSERT, never UPDATE or DELETE
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE accounting_manual_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_manual_adjustments FORCE ROW LEVEL SECURITY;
ALTER TABLE accounting_reversals ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_reversals FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_membership ON accounting_manual_adjustments
  USING (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = accounting_manual_adjustments.business_id AND b.tenant_id::text = app_tenant()))
  WITH CHECK (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = accounting_manual_adjustments.business_id AND b.tenant_id::text = app_tenant()));
CREATE POLICY accounting_writer ON accounting_manual_adjustments
  FOR INSERT WITH CHECK (current_user = 'daftar_accounting_internal');
CREATE POLICY accounting_validator ON accounting_manual_adjustments
  FOR SELECT USING (current_user = 'daftar_accounting_internal');
CREATE POLICY business_isolation ON accounting_manual_adjustments AS RESTRICTIVE
  USING (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id::text = app_business())
  WITH CHECK (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id::text = app_business());

CREATE POLICY tenant_membership ON accounting_reversals
  USING (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = accounting_reversals.business_id AND b.tenant_id::text = app_tenant()))
  WITH CHECK (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = accounting_reversals.business_id AND b.tenant_id::text = app_tenant()));
CREATE POLICY accounting_writer ON accounting_reversals
  FOR INSERT WITH CHECK (current_user = 'daftar_accounting_internal');
CREATE POLICY accounting_validator ON accounting_reversals
  FOR SELECT USING (current_user = 'daftar_accounting_internal');
CREATE POLICY business_isolation ON accounting_reversals AS RESTRICTIVE
  USING (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id::text = app_business())
  WITH CHECK (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id::text = app_business());

REVOKE ALL ON accounting_manual_adjustments, accounting_reversals, accounting_operation_kinds FROM PUBLIC;

GRANT SELECT ON accounting_manual_adjustments, accounting_reversals
  TO daftar_app, daftar_platform, daftar_worker;
GRANT SELECT, INSERT ON accounting_manual_adjustments, accounting_reversals
  TO daftar_accounting_internal;
GRANT SELECT ON accounting_operation_kinds TO daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 8. `accounting_post_manual_adjustment` — the thinnest possible command.
--
-- It adds authority narrowing and a mandatory reason, and then hands the
-- lines to the hardened primitive untouched. It does NOT re-validate balance,
-- currency, accounts, dates or branch: every one of those is the primitive's,
-- and a second copy here would be a second place for the two to disagree.
--
-- The detail row is written AFTER the post, so the binding it references
-- already exists. `ON CONFLICT DO NOTHING` is not laxity: an idempotent
-- replay of an adjustment posted a year ago must return the original entry
-- and must not rewrite the narrative of posted truth.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION accounting_post_manual_adjustment(
  p_entry_date  DATE,
  p_description TEXT,
  p_reason      TEXT,
  p_request_id  TEXT,
  p_lines       JSONB
) RETURNS TABLE (entry_id UUID, created BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor   accounting_verified_actor;
  v_tenant  UUID;
  v_entry   UUID;
  v_created BOOLEAN;
BEGIN
  -- Authority first, and narrowed to this workflow's source identity. A
  -- `post` assertion minted for an opening balance cannot land here.
  v_actor := accounting_actor(ARRAY['post']);
  IF NOT EXISTS (SELECT 1 FROM accounting_operation_kinds k
                 WHERE k.operation_kind = v_actor.operation_kind
                   AND k.source_type = v_actor.source_type
                   AND k.source_type = 'manual_adjustment') THEN
    RAISE EXCEPTION 'accounting.assertion_wrong_source: this authority does not create manual adjustments' USING ERRCODE = 'P0001';
  END IF;

  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'accounting.adjustment_reason_required: a manual adjustment must state a reason' USING ERRCODE = 'P0001';
  END IF;
  IF char_length(btrim(p_reason)) > 500 THEN
    RAISE EXCEPTION 'accounting.payload_invalid: the adjustment reason is too long' USING ERRCODE = 'P0001';
  END IF;

  SELECT p.entry_id, p.created INTO v_entry, v_created
  FROM accounting_post_entry(p_entry_date, p_description, p_request_id, p_lines) AS p;

  SELECT je.tenant_id INTO v_tenant
  FROM journal_entries je WHERE je.business_id = v_actor.business_id AND je.id = v_entry;

  INSERT INTO accounting_manual_adjustments (tenant_id, business_id, id, reason, actor_user_id)
  VALUES (v_tenant, v_actor.business_id, v_actor.source_id, btrim(p_reason), v_actor.actor_user_id)
  ON CONFLICT (business_id, id) DO NOTHING;

  RETURN QUERY SELECT v_entry, v_created;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 9. `accounting_post_reversal` — the second journal writer (§12-§21).
--
-- The caller supplies WHICH entry, WHEN and WHY. It supplies no account, no
-- amount, no currency, no rate and no dimension: every one of those is read
-- from the persisted original, so a caller cannot reverse an entry into
-- something the entry never said. There is no parameter through which it
-- could, which is stronger than validating one away.
--
-- The signed fingerprint still binds the payload. The merchant API derives
-- the same mirror from the same persisted original and signs its digest; this
-- routine derives its own and refuses any difference. Two independent
-- derivations of one fact, exactly like the two canonicalizers — a bug in
-- either is a refusal, never a wrong entry.
--
-- The order of operations mirrors `accounting_post_entry` step for step, and
-- the two places it differs are stated in the header of this file.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION accounting_post_reversal(
  p_original_entry_id UUID,
  p_entry_date        DATE,
  p_reason            TEXT,
  p_request_id        TEXT
) RETURNS TABLE (entry_id UUID, created BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor      accounting_verified_actor;
  v_tenant     UUID;
  v_base       TEXT;
  v_tz         TEXT;
  v_started    TIMESTAMPTZ;
  v_orig_type  TEXT;
  v_orig_date  DATE;
  v_today      DATE;
  v_date       DATE;
  v_lower      TEXT;
  v_want       UUID[];
  v_acct       UUID;
  v_lines      accounting_posting_line[];
  v_canon      BYTEA[];
  v_actualfp   TEXT;
  v_existing   UUID;
  v_existfp    TEXT;
  v_existdate  DATE;
  v_existreason TEXT;
  v_entry      UUID;
  v_count      INTEGER;
BEGIN
  -- ── 1. Authority, narrowed to reversal and to THIS original ────────────
  -- A `post` assertion cannot reach this routine at all: the verifier is
  -- asked for `reverse` and refuses anything else with
  -- accounting.assertion_wrong_operation.
  v_actor := accounting_actor(ARRAY['reverse']);
  IF NOT EXISTS (SELECT 1 FROM accounting_operation_kinds k
                 WHERE k.operation_kind = v_actor.operation_kind
                   AND k.source_type = v_actor.source_type
                   AND k.source_type = 'reversal') THEN
    RAISE EXCEPTION 'accounting.assertion_wrong_source: this authority does not create reversals' USING ERRCODE = 'P0001';
  END IF;
  -- The signed source id IS the original entry. An argument that disagreed
  -- with the signature would be an unsigned instruction.
  IF v_actor.source_id IS DISTINCT FROM p_original_entry_id THEN
    RAISE EXCEPTION 'accounting.assertion_payload_mismatch: the reversal authority names a different original entry' USING ERRCODE = 'P0001';
  END IF;

  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'accounting.reversal_reason_required: a reversal must state a reason' USING ERRCODE = 'P0001';
  END IF;
  IF char_length(btrim(p_reason)) > 500 THEN
    RAISE EXCEPTION 'accounting.payload_invalid: the reversal reason is too long' USING ERRCODE = 'P0001';
  END IF;

  -- The accounting date is the MERCHANT's, and it is required HERE, before
  -- anything financial is derived, rather than only at the boundaries above.
  --
  -- The fingerprint covers the entry date, so a date this routine chose would
  -- make the command's signed identity a function of when the call arrived.
  -- An at-least-once client retrying across local midnight would then be
  -- asking for a different fact than the one it asked for a second earlier,
  -- and the reversal — which carries no idempotency key, because the original
  -- entry id IS its identity — would answer `accounting.reversal_exists` to a
  -- caller that changed nothing.
  --
  -- The DTO, the Zod schema, the service and the engine all require it now.
  -- This is the lowest authorized boundary, and a routine reachable by a
  -- later phase's worker or a support script may not hold a weaker contract
  -- than the HTTP route in front of it: an invariant only the callers enforce
  -- is a convention. The business clock is still consulted below, for the one
  -- question it owns — is this stated date in the future? It never answers
  -- what date the reversal should carry.
  IF p_entry_date IS NULL THEN
    RAISE EXCEPTION 'accounting.entry_date_required: a reversal must state the accounting date it is posted on' USING ERRCODE = 'P0001';
  END IF;

  -- ── 2. One stable business snapshot ────────────────────────────────────
  -- FOR SHARE only: a reversal cannot be a business's first financial
  -- activity, because it needs an original, so the financial_started_at
  -- transition is not in play here.
  SELECT b.tenant_id, b.base_currency, b.timezone, b.financial_started_at
    INTO v_tenant, v_base, v_tz, v_started
  FROM businesses b WHERE b.id = v_actor.business_id FOR SHARE;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'accounting.forbidden: the accounting assertion names a business that does not exist' USING ERRCODE = 'P0001';
  END IF;
  IF v_tenant IS DISTINCT FROM v_actor.tenant_id THEN
    RAISE EXCEPTION 'accounting.forbidden: the accounting assertion tenant does not own the named business' USING ERRCODE = 'P0001';
  END IF;

  -- ── 3. Serialize this source identity ──────────────────────────────────
  -- The same key `accounting_post_entry` uses, so the two writers cannot
  -- race each other over one reversal slot either.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_actor.business_id::text || '|reversal|' || p_original_entry_id::text, 0));

  -- ── 4. The original, by COMPOSITE identity ─────────────────────────────
  -- (business_id, id), never the uuid alone: an entry of another business is
  -- simply not found, which is also the only thing the caller learns.
  SELECT je.source_type, je.entry_date INTO v_orig_type, v_orig_date
  FROM journal_entries je
  WHERE je.business_id = v_actor.business_id AND je.id = p_original_entry_id;
  IF v_orig_type IS NULL THEN
    RAISE EXCEPTION 'accounting.entry_not_found: no journal entry of this business has that id' USING ERRCODE = 'P0001';
  END IF;
  IF v_orig_type = 'reversal' THEN
    RAISE EXCEPTION 'accounting.reversal_of_reversal: a reversal may not itself be reversed' USING ERRCODE = 'P0001';
  END IF;

  -- ── 5. Derive the mirror from persistence, under account stabilization ─
  -- The accounts are locked in id order, shared, exactly as the primitive
  -- does; the exclusive counterpart is the accounts_posting_stability
  -- trigger 0045 installed. An account's identity cannot change once it has
  -- posted history (accounts_used_identity_lock), so the mirror's identities
  -- are the original's identities, not today's names for them.
  SELECT coalesce(array_agg(DISTINCT l.account_id), ARRAY[]::uuid[]) INTO v_want
  FROM journal_lines l
  WHERE l.business_id = v_actor.business_id AND l.journal_entry_id = p_original_entry_id;

  FOR v_acct IN SELECT u.id FROM unnest(v_want) AS u(id) ORDER BY u.id
  LOOP
    PERFORM pg_advisory_xact_lock_shared(accounting_account_lock_key(v_actor.business_id, v_acct));
  END LOOP;

  -- Debit becomes credit and credit becomes debit. Everything else — both
  -- amounts, both currencies, the rate, its source, its instant, the branch,
  -- the warehouse and the memo — is copied verbatim. The rate is NEVER
  -- recomputed at today's rate; that prohibition is absolute
  -- (DAFTAR_ACCOUNTING_RULES.md §5.2, AL-12).
  WITH mirrored AS (
    SELECT row_number() OVER (ORDER BY l.line_no)::int AS line_no,
           l.account_id,
           CASE WHEN a.system_key IS NOT NULL THEN a.system_key ELSE 'code:' || a.code END AS identity,
           a.is_active,
           CASE WHEN l.debit_minor > 0 THEN 'C' ELSE 'D' END AS side,
           l.base_amount_minor AS base_minor,
           l.base_currency,
           l.txn_amount_minor  AS txn_minor,
           l.txn_currency,
           l.fx_rate           AS rate,
           l.fx_rate_source    AS rate_source,
           l.fx_rate_at        AS rate_at,
           l.branch_id,
           l.warehouse_id,
           l.memo
    FROM journal_lines l
    JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
    WHERE l.business_id = v_actor.business_id AND l.journal_entry_id = p_original_entry_id
  )
  SELECT array_agg(
           row(m.line_no, m.account_id, m.identity, m.is_active, m.side, m.base_minor, m.base_currency,
               m.txn_minor, m.txn_currency, m.rate, m.rate_source, m.rate_at, m.branch_id, m.warehouse_id,
               m.memo,
               accounting_canonical_line(m.identity, m.side, m.base_minor, m.base_currency, m.txn_minor,
                                         m.txn_currency, m.rate, m.rate_source, m.rate_at,
                                         m.branch_id, m.warehouse_id))::accounting_posting_line
           ORDER BY m.line_no)
    INTO v_lines
  FROM mirrored m;

  IF v_lines IS NULL OR array_length(v_lines, 1) < 2 THEN
    -- Unreachable through the ledger's own invariants; stated so that a
    -- corrupted original is refused rather than mirrored into a second bad
    -- entry.
    RAISE EXCEPTION 'accounting.entry_not_found: the original entry has no lines to reverse' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_count FROM unnest(v_lines) AS l WHERE l.base_currency <> v_base;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'accounting.entry_base_currency_mismatch: % mirrored line(s) are not denominated in the business base currency %', v_count, v_base
      USING ERRCODE = 'P0001';
  END IF;

  -- ── 6. Dates (AL-14, §44) ──────────────────────────────────────────────
  -- The effective date is the stated one, with no fallback: section 1 already
  -- refused NULL. "Today" in the BUSINESS's timezone, read under the same
  -- lock as its currency, is the upper bound and nothing else.
  v_today := (now() AT TIME ZONE v_tz)::date;
  v_date  := p_entry_date;
  IF v_date > v_today THEN
    RAISE EXCEPTION 'accounting.entry_date_in_future: an entry may not be dated after today in the business timezone' USING ERRCODE = 'P0001';
  END IF;

  -- The lower bound is DATA in accounting_source_types, exactly as it is in
  -- accounting_post_entry (§44). This routine writes reversals and nothing
  -- else, so it would be easy to hardcode "not before the original" here —
  -- and then the policy would live in two places and drift. It reads the row
  -- instead, so the registry stays the single statement of the rule and a
  -- change to the row changes both writers at once.
  SELECT st.lower_bound_policy INTO v_lower FROM accounting_source_types st WHERE st.source_type = 'reversal';
  IF v_lower IS NULL THEN
    RAISE EXCEPTION 'accounting.payload_invalid: the reversal source type is not registered' USING ERRCODE = 'P0001';
  END IF;
  IF v_lower = 'not_before_origin' AND v_date < v_orig_date THEN
    RAISE EXCEPTION 'accounting.entry_date_before_original: a reversal may not precede the entry it reverses' USING ERRCODE = 'P0001';
  END IF;

  -- ── 7. The signed fingerprint must describe THIS mirror ────────────────
  SELECT array_agg(l.canonical) INTO v_canon FROM unnest(v_lines) AS l;
  v_actualfp := accounting_fingerprint(v_actor.tenant_id, v_actor.business_id, 'reversal',
                                       p_original_entry_id, v_date, v_canon);
  IF v_actualfp <> v_actor.posting_fingerprint THEN
    RAISE EXCEPTION 'accounting.assertion_payload_mismatch: the derived reversal is not the reversal that was authorized' USING ERRCODE = 'P0001';
  END IF;

  -- ── 8. Already reversed? ───────────────────────────────────────────────
  -- An exact retry of the SAME command returns the existing reversal, which
  -- is what an at-least-once client needs. Anything else — a different date,
  -- a second reversal of the same original — is refused by name, and the
  -- UNIQUE constraints in section 4 are the physical backstop underneath.
  SELECT je.id, je.posting_fingerprint, je.entry_date, r.reason
    INTO v_existing, v_existfp, v_existdate, v_existreason
  FROM journal_entries je
  LEFT JOIN accounting_reversals r
    ON r.business_id = je.business_id AND r.journal_entry_id = je.id
  WHERE je.business_id = v_actor.business_id
    AND je.source_type = 'reversal'
    AND je.source_id   = p_original_entry_id;

  IF v_existing IS NOT NULL THEN
    -- The reason is narrative, not arithmetic, so it is not in the
    -- fingerprint — but it IS persisted, in the entry's description and in
    -- accounting_reversals. A caller presenting a different reason is asking
    -- for a different fact, and answering "done already" would silently
    -- discard the words they meant to put in the ledger. Only a command
    -- identical in all three respects replays.
    IF v_existfp = v_actualfp AND v_existdate = v_date AND v_existreason IS NOT DISTINCT FROM btrim(p_reason) THEN
      RETURN QUERY SELECT v_existing, false;
      RETURN;
    END IF;
    RAISE EXCEPTION 'accounting.reversal_exists: this entry has already been reversed' USING ERRCODE = 'P0001';
  END IF;

  -- ── 9. Write it all, atomically ────────────────────────────────────────
  -- The entry's own narrative is the reason, so the ledger reads correctly
  -- on its own; the authoritative copy lives in accounting_reversals.
  INSERT INTO journal_entries (tenant_id, business_id, entry_date, description, source_type, source_id,
                               actor_kind, actor_user_id, request_id, posting_fingerprint)
  VALUES (v_tenant, v_actor.business_id, v_date, left(btrim(p_reason), 500), 'reversal', p_original_entry_id,
          'user', v_actor.actor_user_id, p_request_id, v_actualfp)
  RETURNING id INTO v_entry;

  INSERT INTO journal_lines (tenant_id, business_id, journal_entry_id, line_no, account_id,
                             debit_minor, credit_minor, base_amount_minor, base_currency,
                             txn_currency, txn_amount_minor, fx_rate, fx_rate_source, fx_rate_at,
                             branch_id, warehouse_id, memo)
  SELECT v_tenant, v_actor.business_id, v_entry, l.line_no, l.account_id,
         CASE WHEN l.side = 'D' THEN l.base_minor ELSE 0 END,
         CASE WHEN l.side = 'C' THEN l.base_minor ELSE 0 END,
         l.base_minor, l.base_currency, l.txn_currency, l.txn_minor, l.rate, l.rate_source, l.rate_at,
         l.branch_id, l.warehouse_id, l.memo
  FROM unnest(v_lines) AS l
  ORDER BY l.line_no;

  INSERT INTO accounting_source_bindings (tenant_id, business_id, source_type, source_id, journal_entry_id)
  VALUES (v_tenant, v_actor.business_id, 'reversal', p_original_entry_id, v_entry);

  INSERT INTO accounting_reversals (tenant_id, business_id, id, original_entry_id, journal_entry_id,
                                    reason, actor_kind, actor_user_id)
  VALUES (v_tenant, v_actor.business_id, p_original_entry_id, p_original_entry_id, v_entry,
          btrim(p_reason), 'user', v_actor.actor_user_id);

  -- Exactly one audit row and one outbox event, carrying identifiers only —
  -- no amount, no rate, no balance, no reason text, no assertion (§35, §36).
  INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, request_id, metadata)
  VALUES (v_tenant, v_actor.business_id, v_actor.actor_user_id, 'accounting.entry_reversed', 'journal_entry',
          v_entry::text, p_request_id,
          jsonb_build_object('originalEntryId', p_original_entry_id, 'sourceType', 'reversal',
                             'sourceId', p_original_entry_id));

  INSERT INTO outbox_events (tenant_id, business_id, type, payload)
  VALUES (v_tenant, v_actor.business_id, 'accounting.entry.reversed',
          jsonb_build_object('entryId', v_entry, 'originalEntryId', p_original_entry_id,
                             'businessId', v_actor.business_id, 'sourceType', 'reversal',
                             'sourceId', p_original_entry_id));

  -- A reversal cannot be a business's first financial activity. If it somehow
  -- is, the ledger's history is not what it claims and nothing should commit.
  IF v_started IS NULL THEN
    RAISE EXCEPTION 'accounting.entry_not_found: the business has no financial history to reverse' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY SELECT v_entry, true;
EXCEPTION
  WHEN unique_violation THEN
    -- The physical backstop, surfaced as the domain's own word rather than as
    -- an index name. Any other unique violation would be a bug in this
    -- routine, so it is re-raised rather than renamed.
    IF SQLERRM LIKE '%accounting_reversals%' OR SQLERRM LIKE '%journal_entries_business_id_source_type_source_id%'
       OR SQLERRM LIKE '%accounting_source_bindings_pkey%' THEN
      RAISE EXCEPTION 'accounting.reversal_exists: this entry has already been reversed' USING ERRCODE = 'P0001';
    END IF;
    RAISE;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 10. Ownership and the final ACL.
--
-- The ACL comes FIRST and the ownership transfer second, for the reason 0045
-- spells out: a non-superuser deployment migrator is a MEMBER of
-- daftar_accounting_internal WITH INHERIT FALSE, so once a function belongs
-- to that role a REVOKE issued by the migrator matches no grantor, emits a
-- WARNING, changes nothing, and the migration still commits. Doing the ACL
-- while the migrator still owns the functions avoids that entirely.
-- ─────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION accounting_post_manual_adjustment(DATE, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_post_reversal(UUID, DATE, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_manual_adjustments_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_reversals_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_reversal_entry_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_manual_adjustment_entry_complete() FROM PUBLIC;

-- The merchant runtime, and nobody else. Not the platform administrator:
-- platform administration is not financial authority.
GRANT EXECUTE ON FUNCTION accounting_post_manual_adjustment(DATE, TEXT, TEXT, TEXT, JSONB) TO daftar_app;
GRANT EXECUTE ON FUNCTION accounting_post_reversal(UUID, DATE, TEXT, TEXT) TO daftar_app;

COMMENT ON FUNCTION accounting_post_manual_adjustment(DATE, TEXT, TEXT, TEXT, JSONB) IS
  'Posts a merchant-authored adjustment through accounting_post_entry and records its mandatory reason. Adds authority narrowing and narrative; re-validates no financial rule, because the primitive owns every one of them.';
COMMENT ON FUNCTION accounting_post_reversal(UUID, DATE, TEXT, TEXT) IS
  'The second journal writer (AL-12). Derives every line of the mirror from the persisted original — the caller supplies no account, amount, currency, rate or dimension — verifies the derivation against the signed fingerprint, and writes entry, lines, binding, reversal registration, audit and outbox in one transaction. Requires an assertion whose operation kind is reverse, and an EXPLICIT accounting date: a NULL date is refused with accounting.entry_date_required rather than resolved from the business clock, so the command is a pure function of the original entry, the stated date, the reason and the verified authority.';

ALTER FUNCTION accounting_reversal_entry_complete() OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_manual_adjustment_entry_complete() OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_post_manual_adjustment(DATE, TEXT, TEXT, TEXT, JSONB) OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_post_reversal(UUID, DATE, TEXT, TEXT) OWNER TO daftar_accounting_internal;

-- Hand back the ownership-transfer authority from section 1.
REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 11. Refuse to commit unless the end state is exactly right.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_role  TEXT;
  v_table TEXT;
  v_priv  TEXT;
  v_fn    TEXT;
  v_n     INTEGER;
  v_cfg   TEXT[];
  v_path  TEXT;
BEGIN
  -- (a) No runtime role holds direct DML on a source table. The writers are
  --     functions, not grants. `has_table_privilege`, never
  --     information_schema: that view hides grants involving roles the
  --     current user cannot enable, so under a non-superuser migrator it
  --     would pass by seeing nothing.
  FOR v_role IN
    SELECT unnest(ARRAY['daftar_app','daftar_platform','daftar_worker','daftar_identity','daftar_resolver','daftar_provisioner','public'])
  LOOP
    FOR v_table IN SELECT unnest(ARRAY['accounting_manual_adjustments','accounting_reversals','accounting_operation_kinds'])
    LOOP
      FOR v_priv IN SELECT unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE'])
      LOOP
        IF has_table_privilege(v_role, v_table, v_priv) THEN
          RAISE EXCEPTION 'accounting.writer_exposed: % holds direct % on %', v_role, v_priv, v_table;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  -- (b) The internal authority may INSERT the two detail tables, and may
  --     never rewrite or delete what it wrote.
  FOR v_table IN SELECT unnest(ARRAY['accounting_manual_adjustments','accounting_reversals'])
  LOOP
    FOR v_priv IN SELECT unnest(ARRAY['UPDATE','DELETE','TRUNCATE'])
    LOOP
      IF has_table_privilege('daftar_accounting_internal', v_table, v_priv) THEN
        RAISE EXCEPTION 'accounting.writer_exposed: the posting authority holds % on %', v_priv, v_table;
      END IF;
    END LOOP;
    IF NOT has_table_privilege('daftar_accounting_internal', v_table, 'INSERT') THEN
      RAISE EXCEPTION 'accounting.writer_invalid: the posting authority cannot INSERT into %', v_table;
    END IF;
  END LOOP;
  -- The pairing registry is reference data: readable by the writer, writable
  -- by nobody at runtime.
  IF has_table_privilege('daftar_accounting_internal', 'accounting_operation_kinds', 'INSERT') THEN
    RAISE EXCEPTION 'accounting.writer_exposed: the operation-kind registry must not be runtime-writable';
  END IF;

  -- (c) Exactly daftar_app may execute the two commands.
  FOR v_fn IN
    SELECT unnest(ARRAY['accounting_post_manual_adjustment(date,text,text,text,jsonb)','accounting_post_reversal(uuid,date,text,text)'])
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

  -- (d) The trigger functions are internals, not an API.
  FOR v_role IN
    SELECT unnest(ARRAY['daftar_app','daftar_platform','daftar_worker','daftar_identity','daftar_resolver','daftar_provisioner','public'])
  LOOP
    IF has_function_privilege(v_role, 'accounting_reversal_entry_complete()', 'EXECUTE')
       OR has_function_privilege(v_role, 'accounting_manual_adjustments_immutable()', 'EXECUTE')
       OR has_function_privilege(v_role, 'accounting_reversals_immutable()', 'EXECUTE') THEN
      RAISE EXCEPTION 'accounting.writer_exposed: % may execute an internal accounting helper directly', v_role;
    END IF;
  END LOOP;

  -- (e) Both source tables FORCE row level security, so even their owner is
  --     subject to the isolation policies.
  FOR v_table IN SELECT unnest(ARRAY['accounting_manual_adjustments','accounting_reversals'])
  LOOP
    SELECT count(*) INTO v_n FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    WHERE c.relname = v_table AND c.relrowsecurity AND c.relforcerowsecurity;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'accounting.rls_missing: % does not force row level security', v_table;
    END IF;
  END LOOP;

  -- (f) The completeness rule exists, fires on journal_entries, and is
  --     DEFERRABLE INITIALLY DEFERRED — an immediate one could not be
  --     satisfied by a writer that registers the reversal after the entry.
  SELECT count(*) INTO v_n
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
  WHERE c.relname = 'journal_entries' AND t.tgname = 'journal_entries_reversal_complete'
    AND t.tgdeferrable AND t.tginitdeferred AND NOT t.tgisinternal;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'accounting.completeness_missing: the deferred reversal-completeness trigger is not installed';
  END IF;

  -- (g) G-5, asserted against the live catalogue rather than only against the
  --     migration text: every routine this migration introduces pins a safe
  --     search_path with pg_temp named EXPLICITLY and LAST. Omitting pg_temp
  --     does not exclude it — it only forfeits the choice of where it sits,
  --     and PostgreSQL then searches it FIRST.
  FOR v_fn, v_cfg IN
    SELECT p.proname, p.proconfig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
    WHERE p.proname IN ('accounting_post_manual_adjustment','accounting_post_reversal',
                        'accounting_reversal_entry_complete','accounting_manual_adjustments_immutable',
                        'accounting_reversals_immutable')
  LOOP
    SELECT c INTO v_path FROM unnest(coalesce(v_cfg, ARRAY[]::text[])) AS c WHERE strpos(c, 'search_path=') = 1;
    IF v_path IS NULL THEN
      RAISE EXCEPTION 'accounting.search_path_unpinned: % resolves names through its caller''s search_path', v_fn;
    END IF;
    IF v_path <> 'search_path=pg_catalog, public, pg_temp' THEN
      RAISE EXCEPTION 'accounting.search_path_unpinned: % pins %, which is not the repository standard', v_fn, v_path;
    END IF;
  END LOOP;

  -- (h) No routine introduced here creates or reads a session temporary
  --     relation: the caller can pre-create and own that name (TH-27).
  SELECT count(*) INTO v_n
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE p.proname IN ('accounting_post_manual_adjustment','accounting_post_reversal','accounting_reversal_entry_complete')
    AND (p.prosrc ~* '\mtemporary\M' OR p.prosrc ~* '\mtemp\s+table\M' OR p.prosrc ~* '\mcreate\s+temp\M');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'accounting.temp_relation_used: an elevated routine builds a session temporary relation';
  END IF;

  -- (i) The temporary ownership-transfer authority from section 1 is gone.
  IF has_schema_privilege('daftar_accounting_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'accounting.schema_authority_leaked: daftar_accounting_internal still holds CREATE on schema public';
  END IF;

  -- (j) Every source identity still has exactly one owning operation kind,
  --     and `reversal` is not owned by the kind that drives the primitive.
  SELECT count(*) INTO v_n FROM accounting_operation_kinds WHERE source_type = 'reversal' AND operation_kind = 'reverse';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'accounting.operation_kind_registry_invalid: reversal must be owned by the reverse operation kind';
  END IF;
  SELECT count(*) INTO v_n FROM accounting_operation_kinds WHERE operation_kind = 'reverse' AND source_type <> 'reversal';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'accounting.operation_kind_registry_invalid: the reverse operation kind may create nothing but reversals';
  END IF;
END $$;
