-- 0048_accounting_fx_rates.sql
-- P2-S5 — the FX rate foundation (directive §9-§46, §64-§70).
--
-- P2-S4 ended with three merchant-facing sources, each of which carries an FX
-- snapshot the CALLER states on every line. That is correct and stays correct:
-- the journal's per-line snapshot is historical authority forever. What did
-- not exist was any record of WHERE a rate came from, so a merchant who
-- wanted to post a USD purchase had to restate the rate on every command and
-- nothing in the system could say whether two commands used the same rate or
-- two different ones.
--
-- This migration creates that record, and nothing else.
--
-- ── What an FX rate IS here ──────────────────────────────────────────────
--
-- A rate row is a STATED FACT about one business, one ordered currency pair
-- and one instant: "from this moment, this business converts USD to ILS at
-- 3.7100000000". It is manual, it is append-only, and it is never consulted
-- by anything that has already been posted. A future domain that needs a rate
-- LOOKS ONE UP and COPIES it into the line it is about to write; the line
-- then owns that snapshot for the rest of time, exactly as it does today.
--
-- ── What this file deliberately does NOT build (§9) ──────────────────────
--
--   * no external provider, no HTTP client, no credential, no sync job. The
--     only source value that exists is 'manual', and there is no enum slot
--     waiting for a second one.
--   * no unrealized revaluation, no period, no close, no reopen.
--   * no trial balance, no ledger or balance read model.
--   * no reciprocal, no cross-rate. The registry stores the pairs a merchant
--     stated and answers about those pairs only (§19, §20).
--
-- ── Why a SECOND assertion format (§29, §30) ─────────────────────────────
--
-- Entering a rate is not a posting. It writes no journal entry, it has no
-- lines, it has no entry date and it is not a source. Reusing the posting
-- assertion for it would mean either inventing a fake source type — which
-- §28 forbids, and which would corrupt `accounting_source_types` — or
-- widening `accounting_actor` until "verified authority to post" and
-- "verified authority to configure" were one sentence.
--
-- So there is a second, domain-separated format, `acctctl/1`, on the SAME key
-- material. The separation is cryptographic, not structural: the MAC is taken
-- over a preimage that begins with the literal bytes `acctctl/1` and a
-- newline, and no posting preimage can begin with those bytes because a
-- posting's components are UUIDs, hex digits and `[a-z_]` words joined by
-- dots. A posting assertion presented to the control verifier fails the MAC
-- even after it is padded to the right shape, and a control assertion
-- presented to `accounting_actor` fails there for the same reason. §30 asks
-- for exactly that, and the P2-S5 suites prove it in both directions.
--
-- Migrations 0000-0047 are FROZEN and untouched. No 0049 exists.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The ownership-transfer authority, taken and returned inside this file.
--    Same dance as 0040/0042/0044/0045/0046: DDL is transactional, nothing
--    temporary survives into a committed database, and section 10 refuses to
--    commit if any of it did. Nothing assumes SUPERUSER (§70).
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. `accounting_fx_rates` — the history (§11-§17).
--
-- Every column here is immutable truth, which is why there are no `status`,
-- `is_current`, `superseded_by` or `last_used_at` columns. A rate is not a
-- setting that changes; a NEW rate at a LATER `effective_at` is how a
-- merchant corrects one (§18), and "the rate in force at instant X" is a
-- query, not a flag.
--
-- `rate NUMERIC(20,10)`: AL-09's type, the same one `journal_lines.fx_rate`
-- carries, so a snapshot copied out of here into a line is bit-for-bit the
-- value the ledger will validate against. Guard G-2 fails CI on any float or
-- under-scaled rate in an `accounting_*` table, which now covers this one.
--
-- `source` is a CHECK-pinned constant rather than an enum with room in it.
-- A `provider` value that nothing can write is a promise the schema makes and
-- the code cannot keep; when a provider exists it will arrive with its own
-- migration, its own credentials and its own review (§10, §40).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE accounting_fx_rates (
  tenant_id          UUID NOT NULL,
  business_id        UUID NOT NULL,
  id                 UUID NOT NULL,
  from_currency      TEXT NOT NULL REFERENCES currencies (code),
  to_currency        TEXT NOT NULL REFERENCES currencies (code),
  rate               NUMERIC(20,10) NOT NULL,
  source             TEXT NOT NULL DEFAULT 'manual' CHECK (source = 'manual'),
  effective_at       TIMESTAMPTZ NOT NULL,
  entered_by_user_id UUID NOT NULL REFERENCES users (id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),

  -- §12: composite ownership, in both components. A row can never claim
  -- tenant A while naming a business tenant B owns.
  CONSTRAINT accounting_fx_rates_tenant_business_fk
    FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),

  -- §14: a same-currency "rate" is not a rate. Domestic money uses the
  -- posting sentinel (fx_rate = 1.0000000000, fx_rate_source = 'base') and
  -- has no business in rate history at all.
  CONSTRAINT accounting_fx_rates_distinct_pair_ck CHECK (from_currency <> to_currency),

  -- §15: strictly positive. Zero and negative are not "unusual rates", they
  -- are values no conversion can be performed with.
  CONSTRAINT accounting_fx_rates_positive_ck CHECK (rate > 0),

  -- §16: UTC second precision, physically. The instant stored here is the
  -- instant a future journal line will carry as `fx_rate_at`, and `acctfp/1`
  -- refuses sub-second precision there; a rate registry that accepted
  -- milliseconds would hand the ledger a value it cannot fingerprint.
  CONSTRAINT accounting_fx_rates_second_precision_ck
    CHECK (date_trunc('second', effective_at) = effective_at),

  -- §17: one business, one pair, one instant, one truth.
  CONSTRAINT accounting_fx_rates_identity_uk UNIQUE (business_id, from_currency, to_currency, effective_at)
);

COMMENT ON TABLE accounting_fx_rates IS
  'Append-only manual FX rate history (directive §11-§18). One row states one business''s rate for one ordered currency pair from one instant. Rows are never updated or deleted: a correction is a NEW row at a later effective_at. The journal''s per-line snapshot, not this table, is the historical authority for anything already posted.';
COMMENT ON COLUMN accounting_fx_rates.rate IS
  'NUMERIC(20,10), strictly positive (AL-09/G-2). Never REAL, FLOAT or DOUBLE PRECISION: two systems converting at the "same" inexact rate disagree by a minor unit, and in a ledger that difference becomes history.';
COMMENT ON COLUMN accounting_fx_rates.effective_at IS
  'UTC at SECOND precision, enforced physically. Directly usable as a journal line''s fx_rate_at, which acctfp/1 fingerprints and therefore cannot carry milliseconds.';
COMMENT ON COLUMN accounting_fx_rates.source IS
  'Always ''manual'' in P2-S5. There is no provider value, and no slot for one: a caller cannot claim provenance that never existed (§10, §40).';

-- §24: ONE index, and it is the uniqueness constraint's own. Its leading
-- columns are (business_id, from_currency, to_currency, effective_at), which
-- is exactly the lookup's predicate followed by its ORDER BY ... DESC LIMIT 1.
-- PostgreSQL reads a B-tree backwards as happily as forwards, so a second
-- DESC index would buy nothing and cost every INSERT. No speculative index.

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Immutability (§18, §45).
--
-- Two independent mechanisms, deliberately redundant. No runtime role holds
-- UPDATE or DELETE (section 5), and this trigger raises unconditionally — so
-- the rule is answered by the TRIGGER rather than by a missing grant even
-- when the caller is the schema owner, which is the one principal a privilege
-- check can never stop. §45 requires exactly that distinction: `permission
-- denied` is evidence about an ACL, not about immutability.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION accounting_fx_rates_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'accounting.fx_rate_immutable: an entered FX rate cannot be % (business %, rate %) — a correction is a new rate at a later effective time',
    lower(TG_OP), OLD.business_id, OLD.id USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER accounting_fx_rates_no_mutation
  BEFORE UPDATE OR DELETE ON accounting_fx_rates
  FOR EACH ROW EXECUTE FUNCTION accounting_fx_rates_immutable();

-- ─────────────────────────────────────────────────────────────────────────
-- 4. RLS — the established business-scoped model, unchanged (§43).
--
-- `app_bypass()` is not touched and nothing gains BYPASSRLS. The internal
-- principal gets exactly one INSERT policy, because the business it writes
-- comes from the VERIFIED assertion rather than from a GUC, and a row-level
-- rule keyed on a caller-settable GUC would make that GUC load-bearing.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE accounting_fx_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_fx_rates FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_membership ON accounting_fx_rates
  USING (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = accounting_fx_rates.business_id AND b.tenant_id::text = app_tenant()))
  WITH CHECK (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = accounting_fx_rates.business_id AND b.tenant_id::text = app_tenant()));
CREATE POLICY accounting_writer ON accounting_fx_rates
  FOR INSERT WITH CHECK (current_user = 'daftar_accounting_internal');
CREATE POLICY accounting_validator ON accounting_fx_rates
  FOR SELECT USING (current_user = 'daftar_accounting_internal');
CREATE POLICY business_isolation ON accounting_fx_rates AS RESTRICTIVE
  USING (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id::text = app_business())
  WITH CHECK (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id::text = app_business());

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Grants — default deny, minimum read, no runtime writer (§25, §44).
--
-- End state:
--   daftar_app                  SELECT, and nothing else. The merchant UI
--                               will list a business's rates, and the lookup
--                               runs as the CALLER so RLS decides what it
--                               can see.
--   every other runtime role    nothing at all. Neither the platform nor the
--                               worker credential has a reason to read one
--                               business's exchange rates today, and §44 says
--                               default deny rather than "might be useful".
--   daftar_accounting_internal  SELECT + INSERT. Never UPDATE or DELETE:
--                               even the writer cannot rewrite what it wrote.
-- ─────────────────────────────────────────────────────────────────────────
REVOKE ALL ON accounting_fx_rates FROM PUBLIC;
GRANT SELECT ON accounting_fx_rates TO daftar_app;
GRANT SELECT, INSERT ON accounting_fx_rates TO daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. `acctctl/1` — the control-command assertion, and its verifier (§29-§31).
--
-- Ten signed claims and a MAC, in this order:
--
--   acctctl1 . kid . actor . tenant . business . command_kind . resource_id
--            . payload_fingerprint . exp . jti . hmac
--
-- ── The domain separation (§30) ──────────────────────────────────────────
--
-- The MAC is taken over:
--
--   'acctctl/1' || E'\n' || <the ten claims joined by '.'>
--
-- and NOT over the claims alone. That prefix is what makes the separation
-- cryptographic rather than structural. A posting assertion's preimage is
-- `v1.<kid>.…` — ten of its own claims joined by dots, with no prefix — and
-- every component of it is drawn from `[0-9a-f-]`, `[a-z_]` or digits. The
-- bytes `acctctl/1\n` contain `/` and a newline, neither of which can occur
-- in any posting preimage, so the two preimage sets are disjoint and no
-- string is a valid MAC input for both formats. Padding a posting assertion
-- to this shape does not help: the MAC is recomputed here with the prefix and
-- will not match. The same is true in the other direction, because
-- `accounting_actor` requires twelve components whose first is `v1` and
-- computes its MAC without a prefix.
--
-- ── Why a different GUC ──────────────────────────────────────────────────
--
-- `app.accounting_control_assertion`, not `app.accounting_assertion`. It is
-- the third independent separation and the cheapest: a transaction that set
-- only the posting GUC cannot reach this verifier at all, so a compromised
-- caller cannot smuggle a control command into a posting workflow by reusing
-- the connection's existing setting.
--
-- ── The replay registry (§31) ────────────────────────────────────────────
--
-- `accounting_assertion_uses` is reused, and the reuse is genuine rather than
-- convenient: its schema is (jti PRIMARY KEY, xact, used_at), it binds a jti
-- to the FIRST transaction that presented it, and that is exactly the
-- contract a control command needs — several trusted calls composing one
-- transaction may present one assertion, a later transaction may not. jtis
-- are random UUIDs, so the two formats share a namespace without colliding,
-- and a second registry would be a second place for the two to disagree
-- about what "already used" means.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TYPE accounting_verified_control_actor AS (
  actor_user_id      UUID,
  tenant_id          UUID,
  business_id        UUID,
  command_kind       TEXT,
  resource_id        UUID,
  payload_fingerprint TEXT
);

CREATE OR REPLACE FUNCTION accounting_control_actor(p_allowed_kinds TEXT[]) RETURNS accounting_verified_control_actor
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_raw      TEXT;
  v_parts    TEXT[];
  v_secret   BYTEA;
  v_expected TEXT;
  v_exp      BIGINT;
  v_jti      UUID;
  v_xact     XID8;
  v_out      accounting_verified_control_actor;
BEGIN
  v_raw := current_setting('app.accounting_control_assertion', true);
  IF v_raw IS NULL OR v_raw = '' THEN
    RAISE EXCEPTION 'accounting.assertion_missing: an accounting control command requires a server-minted control assertion' USING ERRCODE = 'P0001';
  END IF;

  v_parts := string_to_array(v_raw, '.');
  IF array_length(v_parts, 1) <> 11 OR v_parts[1] <> 'acctctl1' THEN
    RAISE EXCEPTION 'accounting.assertion_malformed: the accounting control assertion is malformed' USING ERRCODE = 'P0001';
  END IF;

  SELECT k.secret INTO v_secret
  FROM accounting_assertion_keys k
  WHERE k.kid = v_parts[2] AND k.status = 'active';
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'accounting.assertion_key_unknown: the accounting assertion key is unknown or retired' USING ERRCODE = 'P0001';
  END IF;

  -- The domain prefix is part of the signed bytes. See the header above for
  -- why this, and not the component count, is what separates the two formats.
  v_expected := encode(hmac(convert_to('acctctl/1' || E'\n' || array_to_string(v_parts[1:10], '.'), 'UTF8'), v_secret, 'sha256'), 'hex');
  IF length(v_parts[11]) <> 64 OR v_expected <> lower(v_parts[11]) THEN
    RAISE EXCEPTION 'accounting.assertion_invalid_signature: the accounting control assertion signature is invalid' USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    v_out.actor_user_id       := v_parts[3]::uuid;
    v_out.tenant_id           := v_parts[4]::uuid;
    v_out.business_id         := v_parts[5]::uuid;
    v_out.command_kind        := v_parts[6];
    v_out.resource_id         := v_parts[7]::uuid;
    v_out.payload_fingerprint := lower(v_parts[8]);
    v_exp                     := v_parts[9]::bigint;
    v_jti                     := v_parts[10]::uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'accounting.assertion_malformed: the accounting control assertion claims are malformed' USING ERRCODE = 'P0001';
  END;

  IF v_out.payload_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'accounting.assertion_malformed: the accounting control assertion carries no valid payload fingerprint' USING ERRCODE = 'P0001';
  END IF;
  IF v_exp <= extract(epoch FROM now())::bigint THEN
    RAISE EXCEPTION 'accounting.assertion_expired: the accounting control assertion has expired' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (v_out.command_kind = ANY (p_allowed_kinds)) THEN
    RAISE EXCEPTION 'accounting.assertion_wrong_operation: the accounting control assertion was minted for a different command' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO accounting_assertion_uses (jti, xact) VALUES (v_jti, pg_current_xact_id())
  ON CONFLICT (jti) DO NOTHING;
  SELECT u.xact INTO v_xact FROM accounting_assertion_uses u WHERE u.jti = v_jti;
  IF v_xact <> pg_current_xact_id() THEN
    RAISE EXCEPTION 'accounting.assertion_replayed: the accounting control assertion was already used' USING ERRCODE = 'P0001';
  END IF;

  RETURN v_out;
END;
$$;

COMMENT ON FUNCTION accounting_control_actor(TEXT[]) IS
  'Verifies an acctctl/1 accounting CONTROL assertion (directive §29-§31). Same key material as the posting format, different cryptographic domain: the MAC covers a preimage prefixed with acctctl/1 and a newline, which no posting preimage can equal. Returns every signed claim; a caller can supply none of them.';

-- ─────────────────────────────────────────────────────────────────────────
-- 7. `fxrate/1` — the canonical FX-command fingerprint (§32).
--
-- The PostgreSQL half of a specification implemented twice. The TypeScript
-- half is `packages/accounting/src/fx-rate.ts` and the shared vectors in
-- `packages/accounting/vectors/fxrate-vectors.json` are what keep them
-- byte-identical; neither can drift without the other failing.
--
-- The stream, UTF-8, newline-separated, with a trailing newline:
--
--   fxrate/1 \n tenant \n business \n rate_id \n from \n to \n rate \n
--   effective_at \n source \n
--
-- Every field is an immutable rate fact and every immutable rate fact is a
-- field. There is no request id, no memo and no description: a retry that
-- changed only narrative would otherwise sign a different command, and there
-- IS no narrative on a rate entry (§32).
--
-- Not `JSON.stringify` and not `row_to_json`: key order, unicode escaping,
-- number formatting and whitespace are all implementation-defined and none of
-- them is stable across two languages. The rate is emitted at exactly ten
-- fraction digits — the storage scale — so "3.71", "3.7100000000" and the
-- stored NUMERIC all fingerprint identically, and the timestamp at RFC3339
-- UTC second precision for the reason section 2 gives.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION accounting_fx_rate_canonical(
  p_tenant       UUID,
  p_business     UUID,
  p_rate_id      UUID,
  p_from         TEXT,
  p_to           TEXT,
  p_rate         NUMERIC,
  p_effective_at TIMESTAMPTZ,
  p_source       TEXT
) RETURNS BYTEA
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT convert_to(
    'fxrate/1' || E'\n' ||
    lower(p_tenant::text) || E'\n' ||
    lower(p_business::text) || E'\n' ||
    lower(p_rate_id::text) || E'\n' ||
    upper(p_from) || E'\n' ||
    upper(p_to) || E'\n' ||
    to_char(p_rate, 'FM9999999990.0000000000') || E'\n' ||
    to_char(p_effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || E'\n' ||
    p_source || E'\n',
    'UTF8')
$$;

CREATE OR REPLACE FUNCTION accounting_fx_rate_fingerprint(
  p_tenant       UUID,
  p_business     UUID,
  p_rate_id      UUID,
  p_from         TEXT,
  p_to           TEXT,
  p_rate         NUMERIC,
  p_effective_at TIMESTAMPTZ,
  p_source       TEXT
) RETURNS TEXT
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT encode(digest(accounting_fx_rate_canonical(p_tenant, p_business, p_rate_id, p_from, p_to, p_rate, p_effective_at, p_source), 'sha256'), 'hex')
$$;

COMMENT ON FUNCTION accounting_fx_rate_fingerprint(UUID, UUID, UUID, TEXT, TEXT, NUMERIC, TIMESTAMPTZ, TEXT) IS
  'fxrate/1: the SHA-256 of a canonical byte stream over every immutable fact of one rate entry (directive §32). One specification, two implementations — this one and packages/accounting/src/fx-rate.ts — kept byte-identical by shared vectors.';

-- ─────────────────────────────────────────────────────────────────────────
-- 8. The serialization key (§36).
--
-- Narrow by construction: one business, one ordered pair, one instant. A rate
-- entry for USD->ILS never waits on one for EUR->ILS, and never waits on a
-- posting. A hash collision can only over-serialize unrelated entries; it
-- cannot merge them, because the UNIQUE constraint is the real identity.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION accounting_fx_rate_lock_key(p_business UUID, p_from TEXT, p_to TEXT, p_effective_at TIMESTAMPTZ) RETURNS BIGINT
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT hashtextextended(
    'fxrate:' || lower(p_business::text) || '|' || upper(p_from) || '|' || upper(p_to) || '|' ||
    to_char(p_effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 0)
$$;

CREATE OR REPLACE FUNCTION accounting_fx_rate_identity_lock_key(p_business UUID, p_rate_id UUID) RETURNS BIGINT
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT hashtextextended('fxrateid:' || lower(p_business::text) || '|' || lower(p_rate_id::text), 0)
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 9. `accounting_fx_rate_enter` — the one narrow write path (§25-§27, §33-§42).
--
-- The caller states the pair, the rate and the instant. It states NO actor,
-- NO tenant, NO business, NO rate id and NO source: every one of those comes
-- from the verified assertion or is fixed here, and there is no parameter
-- through which a caller could supply one, which is stronger than validating
-- one away (§27, §37, §40).
--
-- ── Why the rate arrives as TEXT ─────────────────────────────────────────
--
-- A NUMERIC parameter would already have been parsed by the time this routine
-- sees it, so `3.71000000001`, `3.7e0` and a driver's float coercion would
-- all be indistinguishable from an exact, in-contract rate — and PostgreSQL
-- would silently round the first to fit NUMERIC(20,10). §15 says REFUSE, not
-- round, and the only place that decision can be made is before the cast.
-- So the contract is a string with an exact shape, checked here, at the
-- lowest boundary rather than only in a DTO no direct caller goes through.
--
-- ── The order of operations IS the contract ──────────────────────────────
--
--   1. verified authority, narrowed to `fx_rate_enter`
--   2. the payload is well-formed (currencies, pair, rate shape, instant)
--   3. the signed fingerprint describes THIS payload
--   4. serialize the two identities this command can collide on
--   5. same rate id?   -> replay or accounting.idempotency_conflict
--   6. same pair/time? -> replay or accounting.fx_rate_conflict
--   7. insert, audit, outbox — one transaction, all or nothing
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION accounting_fx_rate_enter(
  p_from         TEXT,
  p_to           TEXT,
  p_rate         TEXT,
  p_effective_at TIMESTAMPTZ,
  p_request_id   TEXT
) RETURNS TABLE (rate_id UUID, created BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_actor    accounting_verified_control_actor;
  v_from     TEXT;
  v_to       TEXT;
  v_rate     NUMERIC(20,10);
  v_fp       TEXT;
  v_existing accounting_fx_rates%ROWTYPE;
BEGIN
  -- ── 1. Authority (§26, §27) ────────────────────────────────────────────
  v_actor := accounting_control_actor(ARRAY['fx_rate_enter']);

  -- ── 2. The payload, refused by name before anything is derived ─────────
  --
  -- The instant is checked FIRST and never defaulted: §64 forbids a
  -- clock-derived effective time, and the fingerprint covers it, so a routine
  -- that filled in `now()` would sign an identity chosen by when the call
  -- arrived. There is no `coalesce` over this parameter anywhere in the file.
  IF p_effective_at IS NULL THEN
    RAISE EXCEPTION 'accounting.fx_effective_at_required: a rate must state the instant it takes effect' USING ERRCODE = 'P0001';
  END IF;
  IF date_trunc('second', p_effective_at) <> p_effective_at THEN
    RAISE EXCEPTION 'accounting.fx_effective_at_precision: a rate takes effect at a whole second, never a fraction of one' USING ERRCODE = 'P0001';
  END IF;

  v_from := upper(btrim(coalesce(p_from, '')));
  v_to   := upper(btrim(coalesce(p_to, '')));
  IF v_from = '' OR v_to = '' THEN
    RAISE EXCEPTION 'accounting.payload_missing_field: a rate must state both currencies' USING ERRCODE = 'P0001';
  END IF;
  -- The REGISTRY decides what a currency is, not a three-letter shape: `ZZZ`
  -- matches [A-Z]{3} and is not money (§13).
  IF NOT EXISTS (SELECT 1 FROM currencies c WHERE c.code = v_from)
     OR NOT EXISTS (SELECT 1 FROM currencies c WHERE c.code = v_to) THEN
    RAISE EXCEPTION 'accounting.fx_currency_unknown: a rate must be stated between two registered currencies' USING ERRCODE = 'P0001';
  END IF;
  IF v_from = v_to THEN
    RAISE EXCEPTION 'accounting.fx_same_currency: a currency has no exchange rate against itself — domestic money uses the base sentinel' USING ERRCODE = 'P0001';
  END IF;

  -- §15, exactly: an unsigned decimal, at most ten fraction digits, no
  -- exponent, no sign, no NaN, no Infinity. Everything this refuses is
  -- something PostgreSQL would otherwise accept and silently reshape.
  IF p_rate IS NULL OR btrim(p_rate) !~ '^(0|[1-9][0-9]{0,9})(\.[0-9]{1,10})?$' THEN
    RAISE EXCEPTION 'accounting.fx_rate_invalid: a rate is an exact decimal with at most ten fraction digits, stated as text' USING ERRCODE = 'P0001';
  END IF;
  v_rate := btrim(p_rate)::numeric(20,10);
  IF v_rate <= 0 THEN
    RAISE EXCEPTION 'accounting.fx_rate_invalid: a rate must be greater than zero' USING ERRCODE = 'P0001';
  END IF;

  -- ── 3. The signed fingerprint must describe THIS payload (§32) ─────────
  v_fp := accounting_fx_rate_fingerprint(
    v_actor.tenant_id, v_actor.business_id, v_actor.resource_id, v_from, v_to, v_rate, p_effective_at, 'manual');
  IF v_fp <> v_actor.payload_fingerprint THEN
    RAISE EXCEPTION 'accounting.assertion_payload_mismatch: the submitted rate is not the rate that was authorized' USING ERRCODE = 'P0001';
  END IF;

  -- ── 4. Serialize, narrowly and in a fixed order (§36) ──────────────────
  --
  -- Two locks, because there are two ways two calls can collide: the same
  -- idempotency key (same rate id, §33) and the same pair at the same instant
  -- under DIFFERENT keys (§34). The identity lock is ALWAYS taken first, so
  -- the two can never form a cycle. Neither lock is business-wide: entering a
  -- USD rate does not block entering a EUR one, and neither blocks a posting.
  PERFORM pg_advisory_xact_lock(accounting_fx_rate_identity_lock_key(v_actor.business_id, v_actor.resource_id));
  PERFORM pg_advisory_xact_lock(accounting_fx_rate_lock_key(v_actor.business_id, v_from, v_to, p_effective_at));

  -- ── 5. The same transport key (§33) ────────────────────────────────────
  SELECT * INTO v_existing FROM accounting_fx_rates r
  WHERE r.business_id = v_actor.business_id AND r.id = v_actor.resource_id;

  IF FOUND THEN
    IF v_existing.from_currency = v_from AND v_existing.to_currency = v_to
       AND v_existing.rate = v_rate AND v_existing.effective_at = p_effective_at
       AND v_existing.source = 'manual' THEN
      -- The identical request, again. The existing row, unchanged, and no
      -- second audit or outbox event (§42, §63).
      RETURN QUERY SELECT v_existing.id, false;
      RETURN;
    END IF;
    RAISE EXCEPTION 'accounting.idempotency_conflict: this idempotency key already recorded a different rate' USING ERRCODE = 'P0001';
  END IF;

  -- ── 6. The same pair at the same instant, under another key (§34) ──────
  SELECT * INTO v_existing FROM accounting_fx_rates r
  WHERE r.business_id = v_actor.business_id
    AND r.from_currency = v_from AND r.to_currency = v_to
    AND r.effective_at = p_effective_at;

  IF FOUND THEN
    IF v_existing.rate = v_rate AND v_existing.source = 'manual' THEN
      -- Materially identical truth, stated twice. The registry already says
      -- it; saying it again creates nothing and announces nothing.
      RETURN QUERY SELECT v_existing.id, false;
      RETURN;
    END IF;
    -- Never first, never last, never overwritten. Two different answers to
    -- one question is a question only the merchant can settle (§34).
    RAISE EXCEPTION 'accounting.fx_rate_conflict: this business already states a different rate for that pair at that instant' USING ERRCODE = 'P0001';
  END IF;

  -- ── 7. The row, its audit and its event — one transaction (§41, §42) ───
  INSERT INTO accounting_fx_rates (tenant_id, business_id, id, from_currency, to_currency, rate, source, effective_at, entered_by_user_id)
  VALUES (v_actor.tenant_id, v_actor.business_id, v_actor.resource_id, v_from, v_to, v_rate, 'manual', p_effective_at, v_actor.actor_user_id);

  -- Identifiers and safe labels only. The RATE VALUE is deliberately absent
  -- from both: an audit trail and an event bus are read by more eyes and more
  -- systems than the ledger is, and a rate is commercially sensitive (§41).
  INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, request_id, metadata)
  VALUES (v_actor.tenant_id, v_actor.business_id, v_actor.actor_user_id, 'accounting.fx_rate_entered', 'accounting_fx_rate',
          v_actor.resource_id::text, p_request_id,
          jsonb_build_object('fromCurrency', v_from, 'toCurrency', v_to,
                             'effectiveAt', to_char(p_effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                             'source', 'manual'));

  INSERT INTO outbox_events (tenant_id, business_id, type, payload)
  VALUES (v_actor.tenant_id, v_actor.business_id, 'accounting.fx_rate.entered',
          jsonb_build_object('rateId', v_actor.resource_id, 'businessId', v_actor.business_id,
                             'fromCurrency', v_from, 'toCurrency', v_to,
                             'effectiveAt', to_char(p_effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                             'source', 'manual'));

  RETURN QUERY SELECT v_actor.resource_id, true;
EXCEPTION
  WHEN unique_violation THEN
    -- The physical backstop under true concurrency, surfaced as the domain's
    -- own sentence. No SQLSTATE, no index name, no raw SQL reaches a caller
    -- (§17, §35). Anything else would be a bug in this routine, so it is
    -- re-raised rather than renamed.
    IF SQLERRM LIKE '%accounting_fx_rates%' THEN
      RAISE EXCEPTION 'accounting.fx_rate_conflict: this business already states a rate for that pair at that instant' USING ERRCODE = 'P0001';
    END IF;
    RAISE;
END;
$$;

COMMENT ON FUNCTION accounting_fx_rate_enter(TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT) IS
  'The ONLY write path into accounting_fx_rates (directive §25, §26). Requires a verified acctctl/1 assertion for command kind fx_rate_enter; the actor, tenant, business and rate id come from it and from nowhere else. The rate arrives as TEXT so an out-of-contract precision is REFUSED rather than silently rounded, and the effective instant is never derived from a clock.';

-- ─────────────────────────────────────────────────────────────────────────
-- 10. `accounting_fx_rate_lookup` — the deterministic read (§21-§24).
--
-- One indexed query: the latest rate this business stated for this exact
-- ordered pair at or before the fact's instant. Nothing else is ever
-- returned — not a future rate, not the nearest one, not the reciprocal, not
-- a cross-rate through a third currency, not an implicit 1 for a foreign
-- pair, and not another business's rate.
--
-- ── Why this is NOT SECURITY DEFINER ─────────────────────────────────────
--
-- Every other accounting routine is elevated because it WRITES. This one
-- reads, and running it as the CALLER is what makes §21's isolation a
-- property of row level security rather than of a predicate somebody
-- remembered to write. A caller that names another business's id does not get
-- a refusal that depends on this function's arithmetic; it gets no rows,
-- because RLS never showed them to it. The explicit `business_id` predicate
-- is the second lock on the same door.
--
-- It writes nothing: no `last_used_at`, no audit, no outbox, no counter.
-- Making historical truth depend on mutable usage metadata is exactly the
-- dependency §23 forbids, and `STABLE` states that at the catalogue level.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TYPE accounting_fx_rate_snapshot AS (
  rate_id      UUID,
  rate         NUMERIC(20,10),
  source       TEXT,
  effective_at TIMESTAMPTZ
);

CREATE OR REPLACE FUNCTION accounting_fx_rate_lookup(
  p_business UUID,
  p_from     TEXT,
  p_to       TEXT,
  p_at       TIMESTAMPTZ
) RETURNS accounting_fx_rate_snapshot
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_from TEXT;
  v_to   TEXT;
  v_out  accounting_fx_rate_snapshot;
BEGIN
  IF p_business IS NULL OR p_at IS NULL THEN
    RAISE EXCEPTION 'accounting.payload_missing_field: a rate lookup states a business and an instant' USING ERRCODE = 'P0001';
  END IF;
  v_from := upper(btrim(coalesce(p_from, '')));
  v_to   := upper(btrim(coalesce(p_to, '')));

  -- §46: an unregistered currency is refused rather than answered with
  -- "missing", so a typo is distinguishable from an unstated rate.
  IF NOT EXISTS (SELECT 1 FROM currencies c WHERE c.code = v_from)
     OR NOT EXISTS (SELECT 1 FROM currencies c WHERE c.code = v_to) THEN
    RAISE EXCEPTION 'accounting.fx_currency_unknown: a rate is looked up between two registered currencies' USING ERRCODE = 'P0001';
  END IF;

  -- §46, §21: a currency does not convert to itself out of history. There is
  -- no implicit 1 here for a FOREIGN pair either — the refusal below is what
  -- a missing rate gets, and a caller that wanted 1 must state 1.
  IF v_from = v_to THEN
    RAISE EXCEPTION 'accounting.fx_same_currency: a currency has no exchange rate against itself — domestic money uses the base sentinel' USING ERRCODE = 'P0001';
  END IF;

  SELECT r.id, r.rate, r.source, r.effective_at INTO v_out
  FROM accounting_fx_rates r
  WHERE r.business_id = p_business
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

COMMENT ON FUNCTION accounting_fx_rate_lookup(UUID, TEXT, TEXT, TIMESTAMPTZ) IS
  'The deterministic rate read (directive §21-§23): the latest rate this business stated for this exact ordered pair at or before the given instant, or accounting.fx_rate_missing. Never a future rate, a reciprocal, a cross-rate, an implicit 1 or another business''s row. Runs as the CALLER, so isolation is row level security''s answer and not this function''s. Writes nothing.';

-- ─────────────────────────────────────────────────────────────────────────
-- 11. Ownership and the final ACL (§25, §26, §67).
--
-- The ACL is set while the MIGRATOR still owns these functions, and the
-- ownership transfer follows. That order matters on a managed PostgreSQL: a
-- non-superuser migrator is a member of the internal principal WITH INHERIT
-- FALSE, so once a function belongs to that principal a REVOKE issued by the
-- migrator matches no grantor, PostgreSQL emits a WARNING instead of an error,
-- and the migration commits with PUBLIC still able to execute. Do not reorder.
-- ─────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION accounting_control_actor(TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_fx_rate_canonical(UUID, UUID, UUID, TEXT, TEXT, NUMERIC, TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_fx_rate_fingerprint(UUID, UUID, UUID, TEXT, TEXT, NUMERIC, TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_fx_rate_lock_key(UUID, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_fx_rate_identity_lock_key(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_fx_rates_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_fx_rate_enter(TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_fx_rate_lookup(UUID, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;

-- The merchant runtime, and no other runtime role. Entering a rate is
-- financial configuration; a platform or worker credential has no part in it.
GRANT EXECUTE ON FUNCTION accounting_fx_rate_enter(TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT) TO daftar_app;
GRANT EXECUTE ON FUNCTION accounting_fx_rate_lookup(UUID, TEXT, TEXT, TIMESTAMPTZ) TO daftar_app;

-- The elevated command runs AS the internal principal and calls the four
-- helpers by name, so they are OWNED by it rather than granted to it. That is
-- 0045's pattern for exactly the same reason: an EXECUTE grant would be an
-- ACL entry on an internal routine, and §68's surface is "no runtime role or
-- PUBLIC may call an internal accounting routine" — a rule stated as an empty
-- ACL, which a convenience grant would quietly weaken.
ALTER FUNCTION accounting_control_actor(TEXT[]) OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_fx_rate_canonical(UUID, UUID, UUID, TEXT, TEXT, NUMERIC, TIMESTAMPTZ, TEXT) OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_fx_rate_fingerprint(UUID, UUID, UUID, TEXT, TEXT, NUMERIC, TIMESTAMPTZ, TEXT) OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_fx_rate_lock_key(UUID, TEXT, TEXT, TIMESTAMPTZ) OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_fx_rate_identity_lock_key(UUID, UUID) OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_fx_rate_enter(TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT) OWNER TO daftar_accounting_internal;
-- `accounting_fx_rates_immutable` is deliberately NOT re-owned, exactly as
-- 0046 leaves its two immutability triggers: it is not SECURITY DEFINER, it
-- reads nothing and it only raises, so elevating it would widen the internal
-- principal's surface for no property gained.

-- Hand back the ownership-transfer authority from section 1.
REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 12. Refuse to commit unless the end state is exactly right.
--
-- Everything asserted here is also proven from the live catalogue by the
-- P2-S5 matrices. Asserting it in the migration too means a deployment that
-- somehow diverges fails at deploy time rather than at the first rate entry.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_role  TEXT;
  v_priv  TEXT;
  v_count INTEGER;
BEGIN
  -- (a) No runtime login role may WRITE the rate history, and PUBLIC may not
  --     touch it at all. The migrator is excluded: it owns the table and
  --     PostgreSQL gives an owner rights that cannot be revoked — which is
  --     precisely why the immutability trigger refuses it too.
  FOR v_role IN
    SELECT unnest(ARRAY['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver', 'daftar_provisioner', 'public'])
  LOOP
    FOR v_priv IN SELECT unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'])
    LOOP
      IF has_table_privilege(v_role, 'accounting_fx_rates', v_priv) THEN
        RAISE EXCEPTION 'accounting.fx_registry_exposed: % holds % on accounting_fx_rates', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;

  -- (b) Exactly one runtime reader, by decision rather than by accident.
  FOR v_role IN SELECT unnest(ARRAY['daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver', 'daftar_provisioner', 'public'])
  LOOP
    IF has_table_privilege(v_role, 'accounting_fx_rates', 'SELECT') THEN
      RAISE EXCEPTION 'accounting.fx_registry_exposed: % may read accounting_fx_rates and has no requirement to (§44)', v_role;
    END IF;
  END LOOP;
  IF NOT has_table_privilege('daftar_app', 'accounting_fx_rates', 'SELECT') THEN
    RAISE EXCEPTION 'accounting.fx_registry_invalid: the merchant runtime cannot read the rate history it is meant to show';
  END IF;

  -- (c) The write command is executable by the merchant runtime and nobody else.
  FOR v_role IN SELECT unnest(ARRAY['daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver', 'daftar_provisioner', 'public'])
  LOOP
    IF has_function_privilege(v_role, 'accounting_fx_rate_enter(text,text,text,timestamptz,text)', 'EXECUTE') THEN
      RAISE EXCEPTION 'accounting.fx_registry_exposed: % may enter FX rates (§25, §26)', v_role;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('daftar_app', 'accounting_fx_rate_enter(text,text,text,timestamptz,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'accounting.fx_registry_invalid: the merchant runtime cannot enter a rate';
  END IF;
  IF has_function_privilege('public', 'accounting_control_actor(text[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'accounting.fx_registry_exposed: PUBLIC may execute the control-assertion verifier';
  END IF;

  -- (d) The elevated routines belong to the unreachable NOLOGIN principal.
  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
  WHERE p.proname IN ('accounting_control_actor', 'accounting_fx_rate_enter', 'accounting_fx_rate_canonical',
                      'accounting_fx_rate_fingerprint', 'accounting_fx_rate_lock_key', 'accounting_fx_rate_identity_lock_key')
    AND r.rolname = 'daftar_accounting_internal';
  IF v_count <> 6 THEN
    RAISE EXCEPTION 'accounting.fx_registry_invalid: the elevated FX routines must be owned by daftar_accounting_internal (got %)', v_count;
  END IF;

  -- (e) G-5: every routine this file adds pins pg_temp LAST.
  SELECT count(*) INTO v_count
  FROM pg_proc p
  WHERE p.proname IN ('accounting_control_actor', 'accounting_fx_rate_enter', 'accounting_fx_rate_lookup',
                      'accounting_fx_rate_canonical', 'accounting_fx_rate_fingerprint',
                      'accounting_fx_rate_lock_key', 'accounting_fx_rate_identity_lock_key', 'accounting_fx_rates_immutable')
    AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS c WHERE c ~ '^search_path=.*,\s*pg_temp$');
  IF v_count <> 8 THEN
    RAISE EXCEPTION 'accounting.fx_registry_invalid: % of 8 P2-S5 routines pin pg_temp last in their search_path (G-5)', v_count;
  END IF;

  -- (f) The rate lookup is a READ. A definer read would make isolation this
  --     function's arithmetic instead of row level security's answer.
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'accounting_fx_rate_lookup' AND prosecdef) THEN
    RAISE EXCEPTION 'accounting.fx_registry_invalid: the rate lookup must not be SECURITY DEFINER (§21)';
  END IF;

  -- (g) The table FORCEs row level security, so even its owner is filtered.
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'accounting_fx_rates' AND relrowsecurity AND relforcerowsecurity) THEN
    RAISE EXCEPTION 'accounting.fx_registry_invalid: accounting_fx_rates must ENABLE and FORCE row level security (§43)';
  END IF;

  -- (h) FX rate entry is NOT a journal source, and P2-S5 registered none (§28).
  IF EXISTS (SELECT 1 FROM accounting_source_types WHERE source_type LIKE 'fx%') THEN
    RAISE EXCEPTION 'accounting.fx_registry_invalid: an FX source type was registered — a rate entry is not a journal source (§28)';
  END IF;

  -- (i) The temporary CREATE is gone.
  IF has_schema_privilege('daftar_accounting_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'accounting.fx_registry_invalid: the temporary CREATE on schema public was not revoked';
  END IF;

  -- (j) Nothing gained BYPASSRLS, and the internal principal stays unreachable.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daftar_accounting_internal' AND (rolcanlogin OR rolbypassrls OR rolsuper)) THEN
    RAISE EXCEPTION 'accounting.fx_registry_invalid: daftar_accounting_internal must remain NOLOGIN, NOBYPASSRLS and NOSUPERUSER';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname LIKE 'daftar\_%' AND rolbypassrls) THEN
    RAISE EXCEPTION 'accounting.fx_registry_invalid: a DAFTAR role holds BYPASSRLS (§43)';
  END IF;
END $$;
