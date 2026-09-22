-- 0045_accounting_post_entry.sql
-- P2-S3, part 2 of 2 — the secure posting engine (directive §18-§49).
--
-- This is DAFTAR's first real ledger writer. Until now the journal existed and
-- nobody could write it. After this migration exactly one principal can, in
-- exactly one way: `accounting_post_entry`, a SECURITY DEFINER primitive owned
-- by the unreachable NOLOGIN role `daftar_accounting_internal`, executable only
-- by `daftar_app`, and refusing everything that is not backed by an Accounting
-- Command Assertion minted by an authenticated, authorized merchant API.
--
-- ── The property that matters ────────────────────────────────────────────
--
-- A stolen `daftar_app` credential can set every GUC it likes, can name a real
-- active member of a victim business, and still cannot post: the actor, the
-- tenant, the business, the source and the payload FINGERPRINT are all read
-- from the verified assertion, never from `app.tenant_id`, `app.business_id`,
-- `app.actor_user_id`, or any function argument. GUCs remain read-isolation
-- context and nothing more (§18).
--
-- Because the fingerprint is signed, the payload is bound too. The primitive
-- recomputes the `acctfp/1` fingerprint from the lines it ACTUALLY received,
-- with account identities re-derived from persisted rows, and refuses a
-- mismatch before any ledger, audit or outbox row is written (§27). There is
-- no window in which a signed fingerprint and different lines can both be
-- accepted.
--
-- ── The order of operations IS the contract (§46) ────────────────────────
--
--   1. verify the assertion
--   2. stabilize the business row (currency + timezone under one lock)
--   3. parse the actual payload against an exact schema
--   4. resolve accounts and recompute the fingerprint
--   5. require recomputed == signed
--   6. take the same-source idempotency lock
--   7. look for an existing entry for that source
--   8. only if this is NEW truth: apply the dynamic rules (account must be
--      active, date policy) and write
--
-- Step 8 comes last on purpose. A retry of a posting made a year ago must
-- still return the existing entry even though the account has since been
-- deactivated (§30) or the business timezone has since changed (§48) — those
-- rules govern the creation of NEW truth, not the recognition of old truth.
--
-- Migrations 0000-0043 are frozen and untouched.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. §24 — the persisted FX snapshot must be exactly what the fingerprint
--    describes.
--
-- The Architecture Lock fixes `fx_rate_at` at SECOND precision, and the
-- canonical stream serializes it that way. `0042` is frozen, so the matching
-- constraint arrives here: without it, two rows differing only in milliseconds
-- would share one fingerprint, and the signed value would no longer describe
-- the stored truth.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE journal_lines
  ADD CONSTRAINT journal_lines_fx_rate_at_second_ck
  CHECK (date_trunc('second', fx_rate_at) = fx_rate_at);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The ownership-transfer authority, taken and returned inside this file
--    (the 0040/0044 pattern, so a NOSUPERUSER migrator can apply this).
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. `acctfp/1` — the PostgreSQL canonicalizer.
--
-- The twin of packages/accounting/src/fingerprint.ts. Both are tested against
-- the SAME vector file, so neither can drift alone (§21).
--
-- Everything is BYTEA, not TEXT. The NULL sentinel is the single byte 0x00 and
-- PostgreSQL TEXT cannot contain NUL, so a TEXT implementation would have to
-- fake it — with '\x00', an empty string or a literal backslash-zero — and
-- would then disagree with the TypeScript side on precisely the value an
-- attacker is most likely to send (§22).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION accounting_canonical_line(
  p_identity      TEXT,
  p_side          TEXT,
  p_base_minor    BIGINT,
  p_base_currency TEXT,
  p_txn_minor     BIGINT,
  p_txn_currency  TEXT,
  p_rate          NUMERIC,
  p_rate_source   TEXT,
  p_rate_at       TIMESTAMPTZ,
  p_branch        UUID,
  p_warehouse     UUID
) RETURNS BYTEA
-- Deliberately NOT STRICT: a NULL branch or warehouse is a legitimate
-- dimension that serializes to the 0x00 sentinel, and STRICT would collapse
-- the whole line to NULL instead.
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT convert_to(p_identity, 'UTF8')
      || decode('1f', 'hex') || convert_to(p_side, 'UTF8')
      || decode('1f', 'hex') || convert_to(p_base_minor::text, 'UTF8')
      || decode('1f', 'hex') || convert_to(upper(p_base_currency), 'UTF8')
      || decode('1f', 'hex') || convert_to(p_txn_minor::text, 'UTF8')
      || decode('1f', 'hex') || convert_to(upper(p_txn_currency), 'UTF8')
      -- Exactly ten fraction digits, matching NUMERIC(20,10) and the
      -- TypeScript canonical form. The leading `0` in the mask forces a digit
      -- before the point, so 0.709 is "0.7090000000" and never ".7090000000".
      || decode('1f', 'hex') || convert_to(to_char(p_rate, 'FM9999999990.0000000000'), 'UTF8')
      || decode('1f', 'hex') || convert_to(p_rate_source, 'UTF8')
      || decode('1f', 'hex') || convert_to(to_char(p_rate_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'UTF8')
      || decode('1f', 'hex') || CASE WHEN p_branch IS NULL THEN decode('00', 'hex') ELSE convert_to(lower(p_branch::text), 'UTF8') END
      || decode('1f', 'hex') || CASE WHEN p_warehouse IS NULL THEN decode('00', 'hex') ELSE convert_to(lower(p_warehouse::text), 'UTF8') END
$$;

-- The full stream and its digest.
--
-- Lines are ordered by their own BYTEA value — PostgreSQL's bytea ordering is
-- a plain unsigned byte comparison, which is exactly what `Buffer.compare` is
-- on the TypeScript side. Ordering by `line_no`, insertion order or a text
-- collation would let the same financial fact hash two ways (§25).
CREATE OR REPLACE FUNCTION accounting_fingerprint(
  p_tenant      UUID,
  p_business    UUID,
  p_source_type TEXT,
  p_source_id   UUID,
  p_entry_date  DATE,
  p_lines       BYTEA[]
) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT encode(
    digest(
      convert_to(
        'acctfp/1' || E'\n'
        || lower(p_tenant::text) || E'\n'
        || lower(p_business::text) || E'\n'
        || p_source_type || E'\n'
        || lower(p_source_id::text) || E'\n'
        || to_char(p_entry_date, 'YYYY-MM-DD') || E'\n',
        'UTF8')
      || coalesce(
           (SELECT string_agg(x.b || decode('1e', 'hex'), ''::bytea ORDER BY x.b)
            FROM unnest(p_lines) AS x(b)),
           ''::bytea),
      'sha256'),
    'hex')
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. `accounting_actor` — the trusted verifier (§18).
--
-- Returns every claim, all of them signed. A caller cannot supply any of
-- these: there is no actor argument, no tenant argument and no business
-- argument anywhere in the posting primitive's signature, precisely so that
-- no future edit can quietly start trusting one.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TYPE accounting_verified_actor AS (
  actor_user_id       UUID,
  tenant_id           UUID,
  business_id         UUID,
  operation_kind      TEXT,
  source_type         TEXT,
  source_id           UUID,
  posting_fingerprint TEXT
);

CREATE OR REPLACE FUNCTION accounting_actor(p_allowed_kinds TEXT[]) RETURNS accounting_verified_actor
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_raw      TEXT;
  v_parts    TEXT[];
  v_secret   BYTEA;
  v_expected TEXT;
  v_exp      BIGINT;
  v_jti      UUID;
  v_xact     XID8;
  v_out      accounting_verified_actor;
BEGIN
  v_raw := current_setting('app.accounting_assertion', true);
  IF v_raw IS NULL OR v_raw = '' THEN
    RAISE EXCEPTION 'accounting.assertion_missing: posting requires a server-minted accounting assertion' USING ERRCODE = 'P0001';
  END IF;

  v_parts := string_to_array(v_raw, '.');
  IF array_length(v_parts, 1) <> 12 OR v_parts[1] <> 'v1' THEN
    RAISE EXCEPTION 'accounting.assertion_malformed: the accounting assertion is malformed' USING ERRCODE = 'P0001';
  END IF;

  SELECT k.secret INTO v_secret
  FROM accounting_assertion_keys k
  WHERE k.kid = v_parts[2] AND k.status = 'active';
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'accounting.assertion_key_unknown: the accounting assertion key is unknown or retired' USING ERRCODE = 'P0001';
  END IF;

  -- The signature covers all eleven claims, so none of them can be swapped
  -- after minting.
  v_expected := encode(hmac(convert_to(array_to_string(v_parts[1:11], '.'), 'UTF8'), v_secret, 'sha256'), 'hex');
  IF length(v_parts[12]) <> 64 OR v_expected <> lower(v_parts[12]) THEN
    RAISE EXCEPTION 'accounting.assertion_invalid_signature: the accounting assertion signature is invalid' USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    v_out.actor_user_id       := v_parts[3]::uuid;
    v_out.tenant_id           := v_parts[4]::uuid;
    v_out.business_id         := v_parts[5]::uuid;
    v_out.operation_kind      := v_parts[6];
    v_out.source_type         := v_parts[7];
    v_out.source_id           := v_parts[8]::uuid;
    v_out.posting_fingerprint := lower(v_parts[9]);
    v_exp                     := v_parts[10]::bigint;
    v_jti                     := v_parts[11]::uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'accounting.assertion_malformed: the accounting assertion claims are malformed' USING ERRCODE = 'P0001';
  END;

  IF v_out.posting_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'accounting.assertion_malformed: the accounting assertion carries no valid posting fingerprint' USING ERRCODE = 'P0001';
  END IF;
  IF v_exp <= extract(epoch FROM now())::bigint THEN
    RAISE EXCEPTION 'accounting.assertion_expired: the accounting assertion has expired' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (v_out.operation_kind = ANY (p_allowed_kinds)) THEN
    RAISE EXCEPTION 'accounting.assertion_wrong_operation: the accounting assertion was minted for a different operation' USING ERRCODE = 'P0001';
  END IF;

  -- Replay: the jti belongs to the FIRST transaction that presents it. Several
  -- trusted calls composing one workflow inside that transaction may present
  -- it again; a later transaction may not (§17).
  INSERT INTO accounting_assertion_uses (jti, xact) VALUES (v_jti, pg_current_xact_id())
  ON CONFLICT (jti) DO NOTHING;
  SELECT u.xact INTO v_xact FROM accounting_assertion_uses u WHERE u.jti = v_jti;
  IF v_xact <> pg_current_xact_id() THEN
    RAISE EXCEPTION 'accounting.assertion_replayed: the accounting assertion was already used' USING ERRCODE = 'P0001';
  END IF;

  -- Opportunistic hygiene: a jti is useless once well past the longest TTL.
  DELETE FROM accounting_assertion_uses WHERE used_at < now() - interval '1 hour';

  RETURN v_out;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 4b. Account stability: the lock a posting holds, and the lock every
--     account mutation must wait for (§11, §12, §13).
--
-- ── Why this is not `SELECT ... FOR SHARE` ───────────────────────────────
--
-- FOR SHARE is the obvious mechanism and the first one tried. PostgreSQL
-- refuses it here: every row-locking clause, FOR KEY SHARE included, requires
-- ACL_UPDATE on the table (ACL_SELECT_FOR_UPDATE is a synonym for it), and
-- `daftar_accounting_internal` holds SELECT and INSERT on `accounts` and must
-- never hold UPDATE. Granting the ledger writer UPDATE on the chart so that it
-- could take a read lock would hand it the authority to rename and deactivate
-- accounts — trading a real boundary for a convenient lock. It is not on the
-- table.
--
-- So the mutual exclusion is explicit and symmetric instead: a posting takes a
-- transaction-scoped advisory lock per account it resolved, and EVERY update
-- or delete of an account row waits for the same lock, through the trigger
-- below. It needs no privilege on either side, it blocks exactly what FOR
-- SHARE would have blocked — a change to `code`, `type` or `is_active`, and a
-- delete — and unlike FOR SHARE it is visible in the schema as a rule rather
-- than as a clause someone could quietly drop from one query.
--
-- The pair is shared/exclusive, not exclusive/exclusive. A posting takes
-- `pg_advisory_xact_lock_shared`, so several postings may hold the same
-- account at once and none waits for another — the property FOR SHARE would
-- have given them, and one that an exclusive advisory lock would have
-- destroyed by serializing every posting that happened to touch cash. The
-- mutation trigger takes the exclusive mode, so it waits for all of them and
-- they wait for it.
--
-- The one honest limitation: a single statement updating SEVERAL account rows
-- takes their locks in whatever order the executor produces them, so it can
-- deadlock against a posting holding them in id order. PostgreSQL detects that
-- and aborts one side; no path in DAFTAR issues such a statement today, and
-- the account-management slice must lock in id order when it does.
-- ─────────────────────────────────────────────────────────────────────────

-- Callable by nobody, like every other helper this slice adds. The key it
-- returns is not a secret — anyone may compute the same hash from the two
-- identifiers with a built-in — but §68 says the runtime EXECUTE surface is
-- the posting primitive and the two key commands, and a helper that widened
-- that surface to four would be trading a stated invariant for nothing. The
-- trigger below therefore runs SECURITY DEFINER as the internal principal,
-- which owns this function, rather than as the role updating the account.
CREATE OR REPLACE FUNCTION accounting_account_lock_key(p_business UUID, p_account UUID) RETURNS BIGINT
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT hashtextextended('acct:' || lower(p_business::text) || '|' || lower(p_account::text), 0)
$$;

COMMENT ON FUNCTION accounting_account_lock_key(UUID, UUID) IS
  'The advisory lock key that serializes a posting against a mutation of the accounts it resolved. Composite by construction: an account is (business_id, id), never id alone.';

-- SECURITY DEFINER for one reason only: so it can call
-- `accounting_account_lock_key` without that helper having to be executable by
-- every role that maintains an account. It reads nothing, writes nothing and
-- decides nothing — it takes an advisory lock and returns the row unchanged —
-- so the elevated identity buys the caller no authority it did not have.
CREATE OR REPLACE FUNCTION accounts_posting_stability() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- Named `accounts_posting_stability` so it sorts before
  -- `accounts_system_guard` and `accounts_used_identity_lock`: PostgreSQL
  -- fires row triggers in name order, and waiting for the posting to finish
  -- BEFORE the identity guard looks for posted history is the whole point. A
  -- guard that decided first and waited afterwards would read the history of a
  -- posting that had not committed yet.
  PERFORM pg_advisory_xact_lock(accounting_account_lock_key(OLD.business_id, OLD.id));
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounts_posting_stability
  BEFORE UPDATE OR DELETE ON accounts
  FOR EACH ROW EXECUTE FUNCTION accounts_posting_stability();

-- ─────────────────────────────────────────────────────────────────────────
-- 5. §31 — a used custom account's identity is historical identity.
--
-- Once an account has posted history, its `code` is what the canonical
-- fingerprint of every one of those entries was computed from. Renaming the
-- code would change the identity a retry recomputes, so an idempotent replay
-- of a year-old posting would suddenly conflict. Type is locked for the same
-- reason it is locked on system accounts: it decides the account's meaning.
--
-- Rename stays allowed (the display name is not identity), and so do
-- deactivate and reactivate (lifecycle is not identity). System accounts keep
-- the stricter P2-S1 rules, which this does not touch.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION accounts_used_identity_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code OR NEW.type IS DISTINCT FROM OLD.type THEN
    -- Composite identity: an account is (business_id, id), never id alone.
    IF EXISTS (
      SELECT 1 FROM journal_lines jl
      WHERE jl.business_id = OLD.business_id AND jl.account_id = OLD.id
    ) THEN
      RAISE EXCEPTION 'accounting.account_identity_locked: account % has posted history and its code and type are historical identity', OLD.id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounts_used_identity_lock
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION accounts_used_identity_immutable();

-- ─────────────────────────────────────────────────────────────────────────
-- 6. §39 — `financial_started_at` is not arbitrary runtime-mutable state.
--
-- Note the deliberate difference from `0042`'s immutability triggers, which
-- consult no identity at all. This one MUST, because the rule is not "nobody
-- may change this" but "only the trusted posting authority may establish it,
-- once". A flag that any runtime credential could set would let an attacker
-- lock a business's base currency; one that could be cleared would let them
-- unlock it after real history existed.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION businesses_financial_start_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.financial_started_at IS DISTINCT FROM OLD.financial_started_at THEN
    IF OLD.financial_started_at IS NOT NULL THEN
      RAISE EXCEPTION 'accounting.financial_start_immutable: financial_started_at is established once and never changed or cleared'
        USING ERRCODE = 'P0001';
    END IF;
    IF NEW.financial_started_at IS NULL THEN
      RAISE EXCEPTION 'accounting.financial_start_immutable: financial_started_at cannot be cleared' USING ERRCODE = 'P0001';
    END IF;
    IF current_user <> 'daftar_accounting_internal' THEN
      RAISE EXCEPTION 'accounting.financial_start_forbidden: only the accounting posting authority may establish financial_started_at'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER businesses_financial_start_lock
  BEFORE UPDATE ON businesses
  FOR EACH ROW EXECUTE FUNCTION businesses_financial_start_guard();

-- ─────────────────────────────────────────────────────────────────────────
-- 7. The writer's authority — the minimum, and no more (§33, §34, §39).
--
-- INSERT only. No UPDATE, no DELETE, no TRUNCATE on any journal table: the
-- immutability triggers from `0042` remain untouched and still refuse
-- everyone, this principal included. On `businesses` the grant is
-- COLUMN-level, so this authority cannot rewrite a business's name, currency
-- or timezone — only establish the one timestamp §38 describes.
-- ─────────────────────────────────────────────────────────────────────────
GRANT INSERT ON journal_entries, journal_lines, accounting_source_bindings TO daftar_accounting_internal;
GRANT SELECT ON accounting_source_types TO daftar_accounting_internal;
GRANT INSERT ON audit_events TO daftar_accounting_internal;
GRANT INSERT ON outbox_events TO daftar_accounting_internal;
GRANT UPDATE (financial_started_at) ON businesses TO daftar_accounting_internal;

-- RLS. The journal tables FORCE row level security, so the writer needs an
-- identity policy of its own. `0042` deliberately left the internal clause out
-- of the RESTRICTIVE policy's WITH CHECK so that the validator's read policy
-- could never become a write path; now that a writer legitimately exists, the
-- clause is added here — and it admits exactly one unreachable NOLOGIN
-- principal, not a credential anyone can authenticate as.
--
-- Writing through an identity policy rather than through `app_business()` is
-- deliberate: the business being written comes from the VERIFIED ASSERTION,
-- and a row-level rule keyed on a caller-settable GUC would make a GUC
-- load-bearing for correctness, which §18 forbids.
CREATE POLICY accounting_writer ON journal_entries
  FOR INSERT WITH CHECK (current_user = 'daftar_accounting_internal');
CREATE POLICY accounting_writer ON journal_lines
  FOR INSERT WITH CHECK (current_user = 'daftar_accounting_internal');
CREATE POLICY accounting_writer ON accounting_source_bindings
  FOR INSERT WITH CHECK (current_user = 'daftar_accounting_internal');

ALTER POLICY business_isolation ON journal_entries
  USING (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id::text = app_business())
  WITH CHECK (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id::text = app_business());
ALTER POLICY business_isolation ON journal_lines
  USING (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id::text = app_business())
  WITH CHECK (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id::text = app_business());
ALTER POLICY business_isolation ON accounting_source_bindings
  USING (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id::text = app_business())
  WITH CHECK (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id::text = app_business());

-- Audit and outbox are business-scoped by GUC for ordinary app writes. The
-- posting authority writes rows whose business comes from the assertion, so it
-- gets its own narrow INSERT policy rather than depending on the GUC.
CREATE POLICY audit_accounting_writer ON audit_events
  FOR INSERT WITH CHECK (current_user = 'daftar_accounting_internal');
CREATE POLICY outbox_accounting_writer ON outbox_events
  FOR INSERT WITH CHECK (current_user = 'daftar_accounting_internal');

-- Establishing financial_started_at needs an UPDATE policy; the column grant
-- above is what limits WHAT may be written.
CREATE POLICY accounting_financial_start ON businesses
  FOR UPDATE USING (current_user = 'daftar_accounting_internal')
  WITH CHECK (current_user = 'daftar_accounting_internal');

-- ─────────────────────────────────────────────────────────────────────────
-- 8. `accounting_post_entry` — the one narrow write path (§32).
--
-- ── Why there is no scratch table here ───────────────────────────────────
--
-- The posting engine resolves N lines set-wise and inserts them set-wise, and
-- an earlier draft held the intermediate result in a `CREATE TEMP TABLE IF
-- NOT EXISTS accounting_posting_scratch`. That was a privilege escalation
-- with a performance justification.
--
-- PostgreSQL searches the session temporary schema for relation names FIRST,
-- ahead of every schema a function's search_path names, whether or not
-- `pg_temp` appears in it. A caller holding the daftar_app credential could
-- therefore create `pg_temp.accounting_posting_scratch` itself; `IF NOT
-- EXISTS` would then quietly decline to create the real one, and the elevated
-- routine would read, write and finally INSERT INTO journal_lines FROM a
-- relation the caller owns and controls. The same trick against
-- `accounting_assertion_keys` let a stolen credential choose the key the
-- verifier trusts — it forged a journal entry in
-- tests/security/search-path-shadowing.test.ts before this was corrected.
--
-- The answer is not a safer temp table. It is no session relation at all: the
-- intermediate result is an ARRAY of the composite type below, held in a
-- plpgsql variable. It cannot be named, shadowed, pre-created or granted away,
-- it still resolves every account in ONE statement and still inserts every
-- line in ONE statement, and it disappears with the variable rather than
-- depending on ON COMMIT DROP.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TYPE accounting_posting_line AS (
  line_no       INTEGER,
  account_id    UUID,
  identity      TEXT,
  is_active     BOOLEAN,
  side          TEXT,
  base_minor    BIGINT,
  base_currency TEXT,
  txn_minor     BIGINT,
  txn_currency  TEXT,
  rate          NUMERIC(20,10),
  rate_source   TEXT,
  rate_at       TIMESTAMPTZ,
  branch_id     UUID,
  warehouse_id  UUID,
  memo          TEXT,
  canonical     BYTEA
);

CREATE OR REPLACE FUNCTION accounting_post_entry(
  p_entry_date  DATE,
  p_description TEXT,
  p_request_id  TEXT,
  p_lines       JSONB
) RETURNS TABLE (entry_id UUID, created BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor     accounting_verified_actor;
  v_tenant    UUID;
  v_base      TEXT;
  v_tz        TEXT;
  v_started   TIMESTAMPTZ;
  v_first     BOOLEAN;
  v_keys      TEXT[] := ARRAY['account','side','base_amount_minor','base_currency','txn_amount_minor',
                              'txn_currency','fx_rate','fx_rate_source','fx_rate_at','branch_id',
                              'warehouse_id','memo'];
  v_bad       TEXT;
  v_count     INTEGER;
  v_want      UUID[];
  v_acct      UUID;
  v_lines     accounting_posting_line[];
  v_canon     BYTEA[];
  v_actualfp  TEXT;
  v_existing  UUID;
  v_existfp   TEXT;
  v_entry     UUID;
  v_lower     TEXT;
  v_today     DATE;
  v_origin    DATE;
BEGIN
  -- ── 1. Authority. Nothing before this line may touch the ledger. ────────
  v_actor := accounting_actor(ARRAY['post']);

  -- ── 2. One stable business snapshot (§40) ──────────────────────────────
  -- Probe first, then lock at the right strength, then RE-READ everything
  -- authoritative under that lock. The first posting takes FOR UPDATE so the
  -- financial_started_at transition is serialized; every later posting takes
  -- FOR SHARE, which still conflicts with Phase 1's FOR UPDATE on currency and
  -- timezone changes but lets ordinary postings proceed concurrently.
  SELECT (b.financial_started_at IS NULL) INTO v_first FROM businesses b WHERE b.id = v_actor.business_id;
  IF v_first IS NULL THEN
    RAISE EXCEPTION 'accounting.forbidden: the accounting assertion names a business that does not exist' USING ERRCODE = 'P0001';
  END IF;

  IF v_first THEN
    SELECT b.tenant_id, b.base_currency, b.timezone, b.financial_started_at
      INTO v_tenant, v_base, v_tz, v_started
    FROM businesses b WHERE b.id = v_actor.business_id FOR UPDATE;
  ELSE
    SELECT b.tenant_id, b.base_currency, b.timezone, b.financial_started_at
      INTO v_tenant, v_base, v_tz, v_started
    FROM businesses b WHERE b.id = v_actor.business_id FOR SHARE;
  END IF;

  -- The assertion's tenant claim must be the business's real tenant. A signed
  -- assertion naming the wrong pair is not authority for either.
  IF v_tenant IS DISTINCT FROM v_actor.tenant_id THEN
    RAISE EXCEPTION 'accounting.forbidden: the accounting assertion tenant does not own the named business' USING ERRCODE = 'P0001';
  END IF;

  -- ── 3. Exact payload schema (§26) ──────────────────────────────────────
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) < 2 THEN
    RAISE EXCEPTION 'accounting.payload_invalid: a posting needs an array of at least two lines' USING ERRCODE = 'P0001';
  END IF;

  SELECT string_agg(DISTINCT k, ', ') INTO v_bad
  FROM jsonb_array_elements(p_lines) e, jsonb_object_keys(e.value) k
  WHERE k <> ALL (v_keys);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'accounting.payload_unknown_field: the posting payload carries unknown field(s): %', v_bad USING ERRCODE = 'P0001';
  END IF;

  SELECT string_agg(DISTINCT k, ', ') INTO v_bad
  FROM jsonb_array_elements(p_lines) e, unnest(v_keys) k
  WHERE NOT (e.value ? k);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'accounting.payload_missing_field: the posting payload is missing field(s): %', v_bad USING ERRCODE = 'P0001';
  END IF;

  -- Money and rates are decimal STRINGS, parsed exactly. A JSON number would
  -- arrive as a double on its way here and could silently lose a BIGINT's low
  -- digits or a rate's tenth decimal.
  SELECT count(*) INTO v_count
  FROM jsonb_array_elements(p_lines) e
  WHERE jsonb_typeof(e.value->'base_amount_minor') <> 'string'
     OR jsonb_typeof(e.value->'txn_amount_minor') <> 'string'
     OR jsonb_typeof(e.value->'fx_rate') <> 'string'
     OR (e.value->>'base_amount_minor') !~ '^[1-9][0-9]{0,18}$'
     OR (e.value->>'txn_amount_minor') !~ '^[1-9][0-9]{0,18}$'
     OR (e.value->>'fx_rate') !~ '^[0-9]{1,10}\.[0-9]{10}$'
     OR (e.value->>'side') NOT IN ('D','C')
     OR (e.value->>'fx_rate_source') NOT IN ('base','manual','provider')
     OR (e.value->>'fx_rate_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
     OR jsonb_typeof(e.value->'account') <> 'object'
     OR (e.value->'account'->>'kind') NOT IN ('system','code')
     OR ((e.value->'account'->>'kind') = 'system' AND coalesce(e.value->'account'->>'system_key','') !~ '^[a-z0-9_]{1,64}$')
     OR ((e.value->'account'->>'kind') = 'code'   AND coalesce(e.value->'account'->>'code','') = '')
     OR (jsonb_typeof(e.value->'branch_id')    NOT IN ('string','null'))
     OR (jsonb_typeof(e.value->'warehouse_id') NOT IN ('string','null'))
     OR (jsonb_typeof(e.value->'memo')         NOT IN ('string','null'));
  IF v_count > 0 THEN
    RAISE EXCEPTION 'accounting.payload_invalid: % posting line(s) do not match the exact input schema', v_count USING ERRCODE = 'P0001';
  END IF;

  -- ── 4. Stabilize the accounts, then resolve under that lock (§11-§13) ──
  --
  -- An account's `code` and `type` ARE the identity the canonical fingerprint
  -- is computed from, and `is_active` decides whether NEW truth may name it.
  -- Reading those columns and then writing journal_lines without holding the
  -- rows still would mean persisting an identity that another transaction may
  -- have changed in between — the stored line would disagree with the
  -- fingerprint it was posted under, and a later idempotent replay of the same
  -- source would recompute a different fingerprint and conflict with itself.
  --
  -- So: resolve once WITHOUT a lock, only to learn which rows to hold; lock
  -- them; then resolve AGAIN against the locked rows and let the second
  -- resolution be the only one that counts.
  --
  -- The lock is the advisory one section 4b describes, taken here and released
  -- by this transaction ending; section 4b says why a row-locking clause was
  -- not available to a principal that must never hold UPDATE on `accounts`.
  --
  -- The accounts are locked in `id` order, never payload order (§13). Two
  -- postings naming cash and sales in opposite line order would otherwise
  -- each hold what the other wants and deadlock for no reason at all.
  SELECT coalesce(array_agg(DISTINCT a.id), ARRAY[]::uuid[]) INTO v_want
  FROM jsonb_array_elements(p_lines) AS t(e)
  JOIN accounts a
    ON a.business_id = v_actor.business_id
   AND ( (t.e->'account'->>'kind' = 'system' AND a.system_key = t.e->'account'->>'system_key')
      OR (t.e->'account'->>'kind' = 'code'   AND a.code       = t.e->'account'->>'code') );

  FOR v_acct IN SELECT u.id FROM unnest(v_want) AS u(id) ORDER BY u.id
  LOOP
    -- SHARED: several postings may hold the same account at once, which is
    -- what FOR SHARE would have given them. The exclusive counterpart is taken
    -- by the mutation trigger in section 4b, and that is the pair that makes
    -- this a read lock rather than a bottleneck.
    PERFORM pg_advisory_xact_lock_shared(accounting_account_lock_key(v_actor.business_id, v_acct));
  END LOOP;

  -- The authoritative resolution, restricted to the rows now held still.
  --
  -- Restricting the join to `v_want` is what makes the lock mean something: an
  -- account that only started matching this payload AFTER the unlocked read —
  -- because a concurrent rename freed the code — is not in the locked set, so
  -- the line resolves to nothing and the posting is refused by name rather
  -- than posted against a row nobody is holding. An account that stopped
  -- matching, for the same reason, is refused the same way. Neither case can
  -- post under an identity that no longer exists (§14 CASE A), and both are
  -- safely retryable by the caller.
  --
  -- Deliberately WITHOUT an is_active filter. Whether this is a retry of old
  -- truth is not yet known, and a retry must resolve an account that has since
  -- been deactivated (§30). The active rule is applied in step 8, for NEW
  -- truth only.
  WITH resolved AS (
    SELECT t.ord::int AS line_no,
           a.id       AS account_id,
           CASE WHEN t.e->'account'->>'kind' = 'system' THEN t.e->'account'->>'system_key'
                ELSE 'code:' || (t.e->'account'->>'code') END AS identity,
           a.is_active                          AS is_active,
           t.e->>'side'                         AS side,
           (t.e->>'base_amount_minor')::bigint  AS base_minor,
           upper(t.e->>'base_currency')         AS base_currency,
           (t.e->>'txn_amount_minor')::bigint   AS txn_minor,
           upper(t.e->>'txn_currency')          AS txn_currency,
           (t.e->>'fx_rate')::numeric(20,10)    AS rate,
           t.e->>'fx_rate_source'               AS rate_source,
           (t.e->>'fx_rate_at')::timestamptz    AS rate_at,
           (t.e->>'branch_id')::uuid            AS branch_id,
           (t.e->>'warehouse_id')::uuid         AS warehouse_id,
           t.e->>'memo'                         AS memo
    FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS t(e, ord)
    LEFT JOIN accounts a
      ON a.business_id = v_actor.business_id
     AND a.id = ANY (v_want)
     AND ( (t.e->'account'->>'kind' = 'system' AND a.system_key = t.e->'account'->>'system_key')
        OR (t.e->'account'->>'kind' = 'code'   AND a.code       = t.e->'account'->>'code') )
  )
  SELECT array_agg(
           row(r.line_no, r.account_id, r.identity, r.is_active, r.side, r.base_minor, r.base_currency,
               r.txn_minor, r.txn_currency, r.rate, r.rate_source, r.rate_at, r.branch_id, r.warehouse_id,
               r.memo,
               accounting_canonical_line(r.identity, r.side, r.base_minor, r.base_currency, r.txn_minor,
                                         r.txn_currency, r.rate, r.rate_source, r.rate_at,
                                         r.branch_id, r.warehouse_id))::accounting_posting_line
           ORDER BY r.line_no)
    INTO v_lines
  FROM resolved r;

  -- An unresolved reference is refused by the kind of name it used, so the
  -- caller learns whether a system account is missing from the chart or a
  -- code simply does not exist. Neither message carries a financial value.
  SELECT count(*) INTO v_count FROM unnest(v_lines) AS l WHERE l.account_id IS NULL AND l.identity NOT LIKE 'code:%';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'accounting.system_account_missing: the business chart has no system account for % line(s)', v_count USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*) INTO v_count FROM unnest(v_lines) AS l WHERE l.account_id IS NULL;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'accounting.account_not_found: % posting line(s) name an account this business does not have', v_count USING ERRCODE = 'P0001';
  END IF;

  -- Every line is denominated in the business's base currency, as it stands
  -- under the row lock taken above (§42). The frozen 0043 validator enforces
  -- the same rule at COMMIT and stays the authority; this check exists so the
  -- caller that loses a race with a base-currency change is refused HERE, by
  -- name, instead of learning at commit time that a deferred trigger rejected
  -- an entry it believed it had written.
  SELECT count(*) INTO v_count FROM unnest(v_lines) AS l WHERE l.base_currency <> v_base;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'accounting.entry_base_currency_mismatch: % posting line(s) are not denominated in the business base currency %', v_count, v_base
      USING ERRCODE = 'P0001';
  END IF;

  SELECT array_agg(l.canonical) INTO v_canon FROM unnest(v_lines) AS l;
  v_actualfp := accounting_fingerprint(v_actor.tenant_id, v_actor.business_id, v_actor.source_type,
                                       v_actor.source_id, p_entry_date, v_canon);

  -- ── 5. The signed fingerprint must describe THIS payload (§27) ─────────
  IF v_actualfp <> v_actor.posting_fingerprint THEN
    RAISE EXCEPTION 'accounting.assertion_payload_mismatch: the submitted payload is not the payload that was authorized' USING ERRCODE = 'P0001';
  END IF;

  -- ── 6. Serialize this source identity only (§45) ───────────────────────
  -- Narrow by construction: the lock covers one (business, source_type,
  -- source_id), never a whole business. A hash collision can only
  -- over-serialize unrelated commands; it cannot merge them, because the
  -- UNIQUE constraint below is the real identity.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_actor.business_id::text || '|' || v_actor.source_type || '|' || v_actor.source_id::text, 0));

  -- ── 7. Is this already posted? (§46, §47, §49) ─────────────────────────
  SELECT je.id, je.posting_fingerprint INTO v_existing, v_existfp
  FROM journal_entries je
  WHERE je.business_id = v_actor.business_id
    AND je.source_type = v_actor.source_type
    AND je.source_id   = v_actor.source_id;

  IF v_existing IS NOT NULL THEN
    IF v_existfp = v_actualfp THEN
      -- Same source, same financial truth: the original entry, unchanged. The
      -- narrative is NOT copied over — posted truth is immutable — and no
      -- second audit or outbox row is written (§35, §36).
      RETURN QUERY SELECT v_existing, false;
      RETURN;
    END IF;
    RAISE EXCEPTION 'accounting.idempotency_conflict: source % already has a journal entry describing different financial truth (entry %)',
      v_actor.source_id, v_existing USING ERRCODE = 'P0001';
  END IF;

  -- ── 8. NEW truth only: the dynamic rules (§29, §30, §44, §48) ──────────
  SELECT count(*) INTO v_count FROM unnest(v_lines) AS l WHERE NOT l.is_active;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'accounting.account_inactive: % posting line(s) name an inactive account', v_count USING ERRCODE = 'P0001';
  END IF;

  -- The date policy is DATA in accounting_source_types, not a branch on a
  -- hardcoded source name (§44).
  SELECT st.lower_bound_policy INTO v_lower FROM accounting_source_types st WHERE st.source_type = v_actor.source_type;
  IF v_lower IS NULL THEN
    RAISE EXCEPTION 'accounting.payload_invalid: the accounting assertion names an unregistered source type' USING ERRCODE = 'P0001';
  END IF;

  -- "Today" is the civil date in the BUSINESS's timezone, read under the same
  -- lock as its currency, not the server's date (§43).
  v_today := (now() AT TIME ZONE v_tz)::date;
  IF p_entry_date > v_today THEN
    RAISE EXCEPTION 'accounting.entry_date_in_future: an entry may not be dated after today in the business timezone' USING ERRCODE = 'P0001';
  END IF;

  IF v_lower = 'not_before_origin' THEN
    -- Composite identity again: the original is (business_id, source_id),
    -- never the UUID alone. When no original is resolvable the lower bound is
    -- simply not established — binding a reversal to its source record is
    -- P2-S4's, and inventing a refusal here would pre-empt that design.
    SELECT je.entry_date INTO v_origin
    FROM journal_entries je
    WHERE je.business_id = v_actor.business_id AND je.id = v_actor.source_id;
    IF v_origin IS NOT NULL AND p_entry_date < v_origin THEN
      RAISE EXCEPTION 'accounting.entry_date_before_original: a reversal may not precede the entry it reverses' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- ── 9. Write it all, atomically (§37) ──────────────────────────────────
  INSERT INTO journal_entries (tenant_id, business_id, entry_date, description, source_type, source_id,
                               actor_kind, actor_user_id, request_id, posting_fingerprint)
  VALUES (v_tenant, v_actor.business_id, p_entry_date, p_description, v_actor.source_type, v_actor.source_id,
          'user', v_actor.actor_user_id, p_request_id, v_actualfp)
  RETURNING id INTO v_entry;

  -- Set-wise line insertion: one statement for N lines (§79).
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
  VALUES (v_tenant, v_actor.business_id, v_actor.source_type, v_actor.source_id, v_entry);

  -- Audit: exactly one row per CREATED posting, carrying safe identifiers
  -- only. No amount, no rate, no balance, no assertion, no payload (§35).
  INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, request_id, metadata)
  VALUES (v_tenant, v_actor.business_id, v_actor.actor_user_id, 'accounting.entry_posted', 'journal_entry',
          v_entry::text, p_request_id,
          jsonb_build_object('sourceType', v_actor.source_type, 'sourceId', v_actor.source_id));

  -- Outbox: exactly one event, IDs only (§36). Reuses the Phase 1 outbox and
  -- its existing retry/backoff/dead-letter semantics.
  INSERT INTO outbox_events (tenant_id, business_id, type, payload)
  VALUES (v_tenant, v_actor.business_id, 'accounting.entry.posted',
          jsonb_build_object('entryId', v_entry, 'businessId', v_actor.business_id,
                             'sourceType', v_actor.source_type, 'sourceId', v_actor.source_id));

  -- ── 10. First financial activity (§38) ─────────────────────────────────
  -- In the SAME transaction as the entry, so a rollback leaves it NULL and a
  -- committed entry can never exist without it. Guarded by `IS NULL` so a
  -- later posting cannot rewrite it.
  IF v_started IS NULL THEN
    UPDATE businesses SET financial_started_at = now()
    WHERE id = v_actor.business_id AND financial_started_at IS NULL;
  END IF;

  RETURN QUERY SELECT v_entry, true;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 9. Ownership and the final ACL (§32, §68).
--
-- EXECUTE for daftar_app and nobody else. Not the platform administrator:
-- platform administration is not financial authority, and a stolen platform
-- credential must not be able to post. The helper functions get no runtime
-- EXECUTE at all — they are internals of the primitive, not an API.
--
-- ── The ACL comes FIRST, then the ownership transfer (§72) ───────────────
--
-- The order is not cosmetic. A non-superuser deployment migrator is a MEMBER
-- of daftar_accounting_internal (WITH INHERIT FALSE, which is what lets it
-- run ALTER FUNCTION ... OWNER TO at all) but does not hold that role's
-- privileges. PostgreSQL resolves the implicit grantor of a GRANT or REVOKE
-- through inheritance, so once the function belongs to the internal
-- principal, a REVOKE issued by the migrator matches no grantor and
-- PostgreSQL emits a WARNING and changes nothing.
--
-- A warning is not an error, so the migration would commit, CI would be
-- green, and on a managed PostgreSQL the posting primitive would be left
-- executable by PUBLIC — the exact opposite of what these lines say. Doing
-- the ACL while the migrator still owns the functions avoids that entirely;
-- ALTER ... OWNER then rewrites the old owner's ACL entries to the new one
-- and leaves the explicit grant to daftar_app intact.
-- ─────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION accounting_canonical_line(TEXT, TEXT, BIGINT, TEXT, BIGINT, TEXT, NUMERIC, TEXT, TIMESTAMPTZ, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_fingerprint(UUID, UUID, TEXT, UUID, DATE, BYTEA[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_actor(TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_post_entry(DATE, TEXT, TEXT, JSONB) FROM PUBLIC;
-- The two trigger functions as well. PostgreSQL checks EXECUTE when a trigger
-- is CREATED, never when it fires, so revoking here does not disarm the
-- triggers installed above — and it does stop anyone calling a guard function
-- directly. `businesses_financial_start_guard` in particular reads
-- `current_user`, and a routine whose decision depends on who is calling it
-- should not be callable by everyone.
REVOKE ALL ON FUNCTION accounts_used_identity_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION businesses_financial_start_guard() FROM PUBLIC;
-- The account-stabilization pair from section 4b, for the same reason: §68's
-- runtime EXECUTE surface is three routines, and it stays three.
REVOKE ALL ON FUNCTION accounting_account_lock_key(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts_posting_stability() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION accounting_post_entry(DATE, TEXT, TEXT, JSONB) TO daftar_app;

-- The comment goes on before the ownership transfer for the same reason the
-- ACL does: COMMENT ON requires ownership, and the deployment migrator holds
-- membership without inheritance.
COMMENT ON FUNCTION accounting_post_entry(DATE, TEXT, TEXT, JSONB) IS
  'The only write path into the journal. Derives actor, tenant, business, source and the authorized payload fingerprint from a verified Accounting Command Assertion; recomputes the acctfp/1 fingerprint from the submitted lines and refuses any mismatch before writing. Writes entry, lines, source binding, audit event and outbox event in one transaction, and establishes businesses.financial_started_at on the first successful posting.';

ALTER FUNCTION accounting_canonical_line(TEXT, TEXT, BIGINT, TEXT, BIGINT, TEXT, NUMERIC, TEXT, TIMESTAMPTZ, UUID, UUID)
  OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_fingerprint(UUID, UUID, TEXT, UUID, DATE, BYTEA[]) OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_actor(TEXT[]) OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounts_used_identity_immutable() OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_account_lock_key(UUID, UUID) OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounts_posting_stability() OWNER TO daftar_accounting_internal;
ALTER FUNCTION businesses_financial_start_guard() OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_post_entry(DATE, TEXT, TEXT, JSONB) OWNER TO daftar_accounting_internal;

-- Hand back the ownership-transfer authority from section 2.
REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 9b. Effective-state hardening of every routine the frozen files left
--     resolving names through the caller's schemas (§8).
--
-- 0000-0043 are frozen and their bytes may not change. A function's
-- `search_path` is not bytes in a file, though — it is configuration held in
-- the catalogue, and `ALTER FUNCTION ... SET search_path` changes the
-- effective state without touching a frozen migration. That is what this
-- block does, and it is the only kind of correction available for code that
-- may not be rewritten.
--
-- Two shapes are corrected:
--
--   * a routine that pins `public, pg_catalog` — 29 of them, including every
--     SECURITY DEFINER provisioning command — gains `, pg_temp` at the END.
--   * a routine that pins NOTHING, and so resolves every name through
--     whatever search_path its caller happens to have set, gains the
--     repository's standard path. Most of these are constraint and
--     immutability trigger functions, which is precisely the code whose
--     reading of a table must not be redirectable.
--
-- The existing ORDER is preserved and pg_temp is only appended. Reordering a
-- frozen routine's path would be a behavioural change to code that cannot be
-- re-reviewed: `public` holds pgcrypto's digest/hmac and citext's operator
-- overloads, so which schema is searched first is not a free choice. Putting
-- pg_temp last is the entire fix; moving anything else is not part of it.
--
-- ── The one set this deliberately does NOT touch ─────────────────────────
--
-- Routines owned by `daftar_platform`. A non-superuser deployment migrator is
-- not a member of daftar_platform, and must not become one: a deployment
-- credential that can assume platform authority is a worse problem than the
-- one being fixed. Hardening them would therefore succeed on a superuser
-- deployment and fail on a managed one — the effective schema would differ
-- between CI and production, which is worse than a boundary that is the same
-- everywhere.
--
-- What protects them instead is bootstrap.sql revoking TEMPORARY from PUBLIC
-- and from every runtime role. With no relation to find, it does not matter
-- where pg_temp sits in a path. THAT is the boundary; this block is defence
-- in depth on the set that can be hardened identically in every environment.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  r        RECORD;
  v_path   TEXT;
  v_role   TEXT := current_user;
  v_fixed  INTEGER := 0;
  v_left   INTEGER := 0;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig,
           o.rolname                 AS owner,
           (SELECT c FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS c WHERE c LIKE 'search\_path=%') AS cfg
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles    o ON o.oid = p.proowner
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      -- Never an extension's own function. pgcrypto and citext install ~130
      -- of them in `public`, and rewriting an extension's catalogue entries
      -- is not this migration's business: the change would not survive a
      -- DROP/CREATE EXTENSION or a dump-and-restore, so it would be a
      -- difference between two databases that both claim to be DAFTAR.
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
    ORDER BY 1
  LOOP
    IF r.owner = 'daftar_platform' THEN
      v_left := v_left + 1;
      CONTINUE;
    END IF;

    IF r.cfg IS NULL THEN
      v_path := 'public, pg_catalog';
    ELSE
      v_path := substring(r.cfg FROM length('search_path=') + 1);
      CONTINUE WHEN v_path ~ ',\s*pg_temp$';
      -- Only the shapes this repository actually writes are rewritten. A
      -- migration that silently rewrites a search_path it does not recognise
      -- is worse than one that stops and says so.
      IF v_path !~ '^[a-z_, ]+$' THEN
        RAISE EXCEPTION 'accounting.search_path_invalid: % has an unrecognised search_path (%)', r.sig, v_path;
      END IF;
    END IF;

    IF r.owner = 'daftar_accounting_internal' THEN
      -- The migrator holds this membership WITH SET TRUE for exactly this
      -- kind of statement, and holds it WITH INHERIT FALSE so it is never
      -- accounting authority by accident.
      EXECUTE 'SET LOCAL ROLE daftar_accounting_internal';
      EXECUTE format('ALTER FUNCTION %s SET search_path = %s, pg_temp', r.sig, v_path);
      EXECUTE format('SET LOCAL ROLE %I', v_role);
    ELSE
      EXECUTE format('ALTER FUNCTION %s SET search_path = %s, pg_temp', r.sig, v_path);
    END IF;
    v_fixed := v_fixed + 1;
  END LOOP;
  EXECUTE 'RESET ROLE';
  RAISE NOTICE 'P2-S3: pg_temp pinned last on % routine(s); % left to the privilege boundary (owned by daftar_platform)', v_fixed, v_left;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 10. Refuse to commit unless the end state is exactly right.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_role  TEXT;
  v_table TEXT;
  v_priv  TEXT;
  v_n     INTEGER;
BEGIN
  -- (a) No runtime role holds direct journal DML. The writer is a function,
  --     not a grant.
  --     `has_table_privilege`, not `information_schema.role_table_grants`:
  --     that view only shows grants involving a role the CURRENT user can
  --     enable, so under a non-superuser deployment migrator it would hide
  --     exactly the rows this is looking for and the check would pass by
  --     seeing nothing (§72). A check another session's role membership can
  --     silence is not a check.
  FOR v_role IN
    SELECT unnest(ARRAY['daftar_app','daftar_platform','daftar_worker','daftar_identity','daftar_resolver','daftar_provisioner','public'])
  LOOP
    FOR v_table IN SELECT unnest(ARRAY['journal_entries','journal_lines','accounting_source_bindings'])
    LOOP
      FOR v_priv IN SELECT unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE'])
      LOOP
        IF has_table_privilege(v_role, v_table, v_priv) THEN
          RAISE EXCEPTION 'accounting.writer_exposed: % holds direct % on %', v_role, v_priv, v_table;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  -- (b) The internal authority may INSERT, and still may not UPDATE or DELETE.
  FOR v_table IN SELECT unnest(ARRAY['journal_entries','journal_lines','accounting_source_bindings'])
  LOOP
    FOR v_priv IN SELECT unnest(ARRAY['UPDATE','DELETE','TRUNCATE'])
    LOOP
      IF has_table_privilege('daftar_accounting_internal', v_table, v_priv) THEN
        RAISE EXCEPTION 'accounting.writer_exposed: the posting authority holds % on % — it may INSERT and never rewrite posted truth', v_priv, v_table;
      END IF;
    END LOOP;
    IF NOT has_table_privilege('daftar_accounting_internal', v_table, 'INSERT') THEN
      RAISE EXCEPTION 'accounting.writer_invalid: the posting authority cannot INSERT into % — the writer would be unable to write', v_table;
    END IF;
  END LOOP;

  -- (c) Only daftar_app may execute the primitive.
  FOR v_role IN
    SELECT unnest(ARRAY['daftar_platform','daftar_worker','daftar_identity','daftar_resolver','daftar_provisioner'])
  LOOP
    IF has_function_privilege(v_role, 'accounting_post_entry(date,text,text,jsonb)', 'EXECUTE') THEN
      RAISE EXCEPTION 'accounting.writer_exposed: runtime role % may execute the posting primitive', v_role;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('daftar_app', 'accounting_post_entry(date,text,text,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'accounting.writer_invalid: daftar_app cannot execute the posting primitive';
  END IF;

  -- (d) Every helper is an internal of the primitive, not an API. PUBLIC is
  --     checked too: a function nobody revoked is executable by everyone, and
  --     that is the default, not an oversight anyone has to commit.
  FOR v_role IN
    SELECT unnest(ARRAY['daftar_app','daftar_platform','daftar_worker','daftar_identity','daftar_resolver','daftar_provisioner','public'])
  LOOP
    IF has_function_privilege(v_role, 'accounting_actor(text[])', 'EXECUTE')
       OR has_function_privilege(v_role, 'accounting_canonical_line(text,text,bigint,text,bigint,text,numeric,text,timestamptz,uuid,uuid)', 'EXECUTE')
       OR has_function_privilege(v_role, 'accounting_fingerprint(uuid,uuid,text,uuid,date,bytea[])', 'EXECUTE')
       OR has_function_privilege(v_role, 'accounts_used_identity_immutable()', 'EXECUTE')
       OR has_function_privilege(v_role, 'businesses_financial_start_guard()', 'EXECUTE')
       OR has_function_privilege(v_role, 'accounting_account_lock_key(uuid,uuid)', 'EXECUTE')
       OR has_function_privilege(v_role, 'accounts_posting_stability()', 'EXECUTE') THEN
      RAISE EXCEPTION 'accounting.writer_exposed: % may execute an internal accounting helper directly', v_role;
    END IF;
  END LOOP;

  -- (e) Every routine this slice adds is owned by the unreachable principal.
  SELECT count(*) INTO v_n
  FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
  WHERE p.proname IN ('accounting_post_entry','accounting_actor','accounting_fingerprint','accounting_canonical_line',
                      'accounts_used_identity_immutable','businesses_financial_start_guard',
                      'accounting_account_lock_key','accounts_posting_stability')
    AND r.rolname = 'daftar_accounting_internal';
  IF v_n <> 8 THEN
    RAISE EXCEPTION 'accounting.writer_invalid: expected 8 routines owned by daftar_accounting_internal, found %', v_n;
  END IF;

  -- (f) The business grant is column-level, not a blanket UPDATE. The two
  --     functions differ exactly here: has_table_privilege answers about the
  --     TABLE privilege, has_column_privilege about the one column.
  IF has_table_privilege('daftar_accounting_internal', 'businesses', 'UPDATE') THEN
    RAISE EXCEPTION 'accounting.writer_exposed: the posting authority holds table-wide UPDATE on businesses';
  END IF;
  IF NOT has_column_privilege('daftar_accounting_internal', 'businesses', 'financial_started_at', 'UPDATE') THEN
    RAISE EXCEPTION 'accounting.writer_invalid: the posting authority cannot establish financial_started_at';
  END IF;

  -- (g) The temporary CREATE is gone and the principal is still unreachable.
  IF has_schema_privilege('daftar_accounting_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'accounting.writer_invalid: the temporary CREATE on schema public was not revoked';
  END IF;
  -- pg_roles, not pg_authid: the latter is superuser-only, and a check that
  -- only a superuser can run is a check a managed deployment cannot run at
  -- all (§72). pg_roles is the public view over the same columns, minus the
  -- password hash this has no business reading.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daftar_accounting_internal' AND (rolcanlogin OR rolbypassrls OR rolsuper)) THEN
    RAISE EXCEPTION 'accounting.writer_invalid: daftar_accounting_internal must remain NOLOGIN, NOBYPASSRLS and NOSUPERUSER';
  END IF;

  -- (h) app_bypass() was not widened (§3).
  IF pg_get_functiondef('app_bypass()'::regprocedure) NOT LIKE '%current_user = ''daftar_platform''%' THEN
    RAISE EXCEPTION 'accounting.writer_invalid: app_bypass() was modified by this slice';
  END IF;

  -- (i) The boundary that actually closes the pg_temp shadowing class (§4).
  --     This is asserted HERE, in the migration, and not only in the test
  --     suite, because it lives in bootstrap.sql: a deployment that applied
  --     migrations without re-running the role bootstrap would otherwise end
  --     up with a posting primitive whose caller can still choose what
  --     `accounting_assertion_keys` means. Failing at deploy time is the
  --     correct outcome; the fix is to run bootstrap.sql.
  FOR v_role IN
    SELECT unnest(ARRAY['daftar_app','daftar_platform','daftar_worker','daftar_identity','daftar_resolver','daftar_provisioner','public'])
  LOOP
    IF has_database_privilege(v_role, current_database(), 'TEMPORARY') THEN
      RAISE EXCEPTION 'accounting.temp_schema_writable: % holds TEMPORARY on %, so it can shadow any relation an elevated routine reads by name — re-run bootstrap.sql', v_role, current_database();
    END IF;
    IF has_schema_privilege(v_role, 'public', 'CREATE') THEN
      RAISE EXCEPTION 'accounting.schema_writable: % may CREATE in schema public, which every accounting routine searches — re-run bootstrap.sql', v_role;
    END IF;
  END LOOP;

  -- (j) Every routine section 9b was allowed to touch puts pg_temp last.
  --     That block either did it or raised; this proves the end state rather
  --     than trusting the loop that produced it. daftar_platform's routines
  --     are excluded for the reason stated there, and the TEMPORARY check
  --     above is what covers them.
  SELECT count(*) INTO v_n
  FROM pg_proc p
  JOIN pg_namespace ns ON ns.oid = p.pronamespace
  JOIN pg_roles     o  ON o.oid  = p.proowner
  WHERE ns.nspname = 'public'
    AND p.prokind = 'f'
    AND o.rolname <> 'daftar_platform'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
    AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS c
                    WHERE c ~ '^search_path=.*,\s*pg_temp$');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'accounting.search_path_invalid: % routine(s) do not pin pg_temp last', v_n;
  END IF;

  -- (k) The writer depends on no session relation at all (§5).
  IF pg_get_functiondef('accounting_post_entry(date,text,text,jsonb)'::regprocedure) ~* 'create\s+(temp|temporary)' THEN
    RAISE EXCEPTION 'accounting.writer_invalid: the posting primitive creates a temporary relation, which its caller can pre-create and own';
  END IF;
END $$;
