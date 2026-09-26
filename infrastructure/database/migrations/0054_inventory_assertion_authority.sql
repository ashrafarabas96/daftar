-- 0054_inventory_assertion_authority.sql
-- P3-S1, part 2 — the signed inventory command authority: the `invctl/1` key
-- domain, the closed operation registry, the `invpl/1` canonicalizer and the
-- two internal verifiers (P3-AL-55 §C-§H; P3-AL-54 §D, §H, §J).
--
-- ── The defect this closes ───────────────────────────────────────────────
--
-- `EXECUTE` on a SECURITY DEFINER routine owned by `daftar_inventory_internal`
-- is transport reachability, not authority. `app.tenant_id`,
-- `app.business_id` and `app.actor_user_id` are set by whoever holds the
-- `daftar_app` credential, so a GUC is row isolation, never authorization
-- (0038:1-8, packages/accounting/src/assertion.ts:4-10). Every P3-S1 entry
-- routine therefore FIRST consumes a server-minted assertion whose MAC — under
-- key material no runtime role can read — binds the actor, tenant, business,
-- operation kind and a digest of the routine's own arguments.
--
-- ── A separate blast radius ──────────────────────────────────────────────
--
-- Its own key table, its own replay registry, its own preimage language.
-- The key domain is the exact shape of 0044; it is not 0044's table, so a
-- leaked accounting or provisioning secret mints nothing here, and the
-- reverse. The `invctl/1` preimage begins with the bytes `invctl/1` + LF,
-- which no posting (`v1.`), provisioning (`v1.`) or control (`acctctl/1` + LF)
-- preimage can begin with, so even an accidentally shared key could not turn
-- one protocol's signature into another's (P3-AL-55 §D).
--
-- ── Who can do what ──────────────────────────────────────────────────────
--
--   * NO runtime role holds ANY privilege on the key table or the replay
--     registry. Not daftar_app, not daftar_platform, not PUBLIC.
--   * daftar_platform may INSTALL and RETIRE keys through two SECURITY
--     DEFINER commands and cannot read what it installed.
--   * daftar_inventory_internal reads the keys and maintains the registry
--     from inside the verifiers, which nobody may EXECUTE: they are called
--     only by routines the same principal owns.
--
-- Migrations 0000-0052 are FROZEN and untouched.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The ownership-transfer authority, taken and returned inside this file.
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The closed operation registry (P3-AL-55 §E).
--
-- A row exists only for a command whose routine exists, and each routine
-- accepts exactly one kind. P3-S1 registers exactly its three; every later
-- slice registers its own kinds in its own migration. No wildcard, no kind
-- list, no generic `inventory.write`.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE inventory_operation_kinds (
  op_code       TEXT PRIMARY KEY CHECK (op_code ~ '^[a-z]+(\.[a-z_]+)+$'),
  registered_by TEXT NOT NULL CHECK (registered_by ~ '^P3-S[0-9]+$')
);
REVOKE ALL ON inventory_operation_kinds FROM PUBLIC;

INSERT INTO inventory_operation_kinds (op_code, registered_by) VALUES
  ('inventory.configure_product',          'P3-S1'),
  ('structure.associate_warehouse_branch', 'P3-S1'),
  ('structure.dissociate_warehouse_branch', 'P3-S1');

-- ─────────────────────────────────────────────────────────────────────────
-- 3. The key registry (P3-AL-55 §C) — 0044's shape, its own table.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE inventory_assertion_keys (
  kid        TEXT PRIMARY KEY CHECK (kid ~ '^[A-Za-z0-9_-]{1,32}$'),
  secret     BYTEA NOT NULL CHECK (octet_length(secret) >= 32),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ,
  CONSTRAINT inventory_assertion_keys_retired_shape_ck
    CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);
REVOKE ALL ON inventory_assertion_keys FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. The replay registry (P3-AL-55 §H).
--
-- STRICTER than 0044. There, a jti is bound to its first transaction and may
-- be presented again inside it. Here one minted assertion authorizes ONE
-- entry-routine invocation: a second presentation — another transaction or
-- the same one — is a replay. Composition inside one command happens through
-- internal primitives that RE-VERIFY without consuming
-- (`inventory_assertion_current`), and they need the transaction id to know
-- the consumption happened in THIS transaction.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE inventory_assertion_uses (
  jti          UUID PRIMARY KEY,
  xact         XID8 NOT NULL,
  op_code      TEXT NOT NULL REFERENCES inventory_operation_kinds (op_code),
  business_id  UUID NOT NULL,
  consumed_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON inventory_assertion_uses FROM PUBLIC;

CREATE INDEX inventory_assertion_uses_consumed_at_idx ON inventory_assertion_uses (consumed_at);

-- The internal principal reads key material and the registry from inside the
-- verifiers, and maintains the replay registry. No DELETE on keys: it cannot
-- destroy key material. No UPDATE on a use: a use cannot be moved to another
-- transaction (P3-AL-55 §C).
GRANT SELECT, INSERT, UPDATE ON inventory_assertion_keys TO daftar_inventory_internal;
GRANT SELECT, INSERT, DELETE ON inventory_assertion_uses TO daftar_inventory_internal;
GRANT SELECT ON inventory_operation_kinds TO daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Key management — daftar_platform only, and write-only even for it
--    (0044:120-199, P3-AL-55 §C).
--
-- Same kid + same secret: idempotent. Same kid + different secret: refused.
-- A retired kid is never reinstated. Rotation is install-new → deploy →
-- retire-old. No secret is interpolated into any message.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION inventory_assertion_key_install(p_kid TEXT, p_secret BYTEA) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_existing BYTEA;
  v_status   TEXT;
BEGIN
  IF p_kid IS NULL OR p_kid !~ '^[A-Za-z0-9_-]{1,32}$' THEN
    RAISE EXCEPTION 'inventory.assertion_key_invalid: the inventory assertion key id is malformed' USING ERRCODE = 'P0001';
  END IF;
  IF p_secret IS NULL OR octet_length(p_secret) < 32 THEN
    RAISE EXCEPTION 'inventory.assertion_key_invalid: an inventory assertion key must be at least 32 bytes' USING ERRCODE = 'P0001';
  END IF;

  SELECT k.secret, k.status INTO v_existing, v_status
  FROM inventory_assertion_keys k WHERE k.kid = p_kid;

  IF v_existing IS NULL THEN
    INSERT INTO inventory_assertion_keys (kid, secret, status) VALUES (p_kid, p_secret, 'active');
    RETURN;
  END IF;

  IF v_status = 'retired' THEN
    RAISE EXCEPTION 'inventory.assertion_key_conflict: inventory assertion key % is retired and cannot be reinstated', p_kid USING ERRCODE = 'P0001';
  END IF;

  IF v_existing IS DISTINCT FROM p_secret THEN
    RAISE EXCEPTION 'inventory.assertion_key_conflict: inventory assertion key % already exists with different key material', p_kid USING ERRCODE = 'P0001';
  END IF;
  -- Same kid, same material, still active: nothing to do.
END;
$$;

COMMENT ON FUNCTION inventory_assertion_key_install(TEXT, BYTEA) IS
  'P3-AL-55 §C. Installs an invctl/1 HMAC key. Idempotent for the same kid and secret; inventory.assertion_key_conflict for the same kid with different material or for a retired kid. EXECUTE: daftar_platform only. Returns nothing — the platform can install, never read.';

CREATE OR REPLACE FUNCTION inventory_assertion_key_retire(p_kid TEXT) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE inventory_assertion_keys
  SET status = 'retired', retired_at = coalesce(retired_at, now())
  WHERE kid = p_kid AND status = 'active';
END;
$$;

COMMENT ON FUNCTION inventory_assertion_key_retire(TEXT) IS
  'P3-AL-55 §C. Retires an invctl/1 key. Terminal and idempotent. EXECUTE: daftar_platform only.';

-- ─────────────────────────────────────────────────────────────────────────
-- 6. `invpl/1` — the PostgreSQL canonicalizer (P3-AL-55 §F).
--
-- The twin of `packages/inventory/src/payload.ts`; both are held to the same
-- shared vectors (`packages/inventory/vectors/invpl-vectors.json`).
--
-- The stream is BYTEA, because NULL is a byte:
--
--   'invpl/1' LF  op_code LF  tenant LF  business LF  field_1 LF … field_n LF
--
-- LF (0x0A) terminates EVERY line, the last included. The digest is the
-- lowercase hex SHA-256 of the stream.
--
-- Fields arrive as (type, canonical text) pairs and each one must ALREADY be
-- canonical — this function validates, it never normalizes:
--
--   uuid     36 bytes, lowercase hex, hyphenated 8-4-4-4-12
--   boolean  `true` or `false`
--   integer  base-10; `-` only for a negative value; no `+`, no leading zero,
--            zero is `0`
--   code     a registry code, `^[a-z][a-z0-9_]{0,31}$`; no case folding, no
--            trimming, no Unicode normalization
--   NULL     the single byte 0x00 and nothing else on the line
--
-- A non-canonical field is refused BEFORE hashing (inventory.payload_invalid).
-- No field can contain 0x0A or 0x00: every accepted pattern excludes both,
-- and PostgreSQL TEXT cannot hold 0x00 at all.
--
-- `op_code` (dotted registry form), tenant and business are inside the stream
-- as well as in the assertion's claims, so two kinds with the same field
-- shape — associate and dissociate — never share a digest, and a digest
-- cannot be carried to another business.
--
-- SECURITY DEFINER although it reads no table: P3-AL-54 §D admits exactly two
-- invoker-rights functions owned by daftar_inventory_internal — the column
-- guards of 0053 — and a pure function loses nothing by the uniform rule. It
-- has no EXECUTE grant; only routines the internal role owns call it.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION inventory_payload_field_is_canonical(p_type TEXT, p_value TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE p_type
    WHEN 'uuid'    THEN p_value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    WHEN 'boolean' THEN p_value IN ('true', 'false')
    WHEN 'integer' THEN p_value ~ '^(0|-?[1-9][0-9]*)$'
    WHEN 'code'    THEN p_value ~ '^[a-z][a-z0-9_]{0,31}$'
    ELSE false
  END IS TRUE
$$;

COMMENT ON FUNCTION inventory_payload_field_is_canonical(TEXT, TEXT) IS
  'P3-AL-55 §F. TRUE when p_value is already the canonical invpl/1 text of a non-NULL field of type p_type (uuid, boolean, integer, code). The one statement of the field grammar; the canonicalizer and the routines both read it. No EXECUTE grant.';

CREATE OR REPLACE FUNCTION inventory_payload_digest(
  p_op_code      TEXT,
  p_tenant       UUID,
  p_business     UUID,
  p_field_types  TEXT[],
  p_field_values TEXT[]
) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_stream BYTEA;
  v_n      INTEGER;
  v_type   TEXT;
  v_value  TEXT;
  i        INTEGER;
BEGIN
  IF p_op_code IS NULL OR p_op_code !~ '^[a-z]+(\.[a-z_]+)+$' THEN
    RAISE EXCEPTION 'inventory.payload_invalid: the operation code is not canonical' USING ERRCODE = 'P0001';
  END IF;
  IF p_tenant IS NULL OR p_business IS NULL THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a payload names its tenant and business' USING ERRCODE = 'P0001';
  END IF;
  IF p_field_types IS NULL OR p_field_values IS NULL
     OR array_ndims(p_field_types) IS DISTINCT FROM array_ndims(p_field_values)
     OR coalesce(array_length(p_field_types, 1), 0) <> coalesce(array_length(p_field_values, 1), 0) THEN
    RAISE EXCEPTION 'inventory.payload_invalid: every payload field has exactly one type' USING ERRCODE = 'P0001';
  END IF;

  v_stream := convert_to('invpl/1' || E'\n' || p_op_code || E'\n' || lower(p_tenant::text) || E'\n' || lower(p_business::text) || E'\n', 'UTF8');

  v_n := coalesce(array_length(p_field_types, 1), 0);
  FOR i IN 1 .. v_n LOOP
    v_type  := p_field_types[i];
    v_value := p_field_values[i];
    IF v_type IS NULL OR v_type NOT IN ('uuid', 'boolean', 'integer', 'code') THEN
      RAISE EXCEPTION 'inventory.payload_invalid: payload field % has no known type', i USING ERRCODE = 'P0001';
    END IF;
    IF v_value IS NULL THEN
      v_stream := v_stream || '\x00'::bytea || '\x0a'::bytea;
      CONTINUE;
    END IF;
    IF NOT inventory_payload_field_is_canonical(v_type, v_value) THEN
      RAISE EXCEPTION 'inventory.payload_invalid: payload field % is not a canonical %', i, v_type USING ERRCODE = 'P0001';
    END IF;
    v_stream := v_stream || convert_to(v_value, 'UTF8') || '\x0a'::bytea;
  END LOOP;

  RETURN encode(digest(v_stream, 'sha256'), 'hex');
END;
$$;

COMMENT ON FUNCTION inventory_payload_digest(TEXT, UUID, UUID, TEXT[], TEXT[]) IS
  'P3-AL-55 §F. The invpl/1 canonicalizer: lowercase hex SHA-256 of the LF-terminated stream invpl/1, op_code, tenant, business, then one line per field (NULL = the single byte 0x00). Validates canonical form and refuses otherwise (inventory.payload_invalid); never normalizes. Held byte-identical to packages/inventory/src/payload.ts by the shared vectors.';

-- The digest an entry routine hands to `inventory_assertion_consume`.
--
-- The `invpl/1` stream names the tenant and the business, and an entry
-- routine's arguments do not: the business comes from the verified assertion,
-- never from an argument (P3-AL-15 §B, P3-AL-54 §E). So the routine hashes
-- its OWN arguments under the tenant and business the carrier CLAIMS in
-- components 4 and 5 — exactly the pair the minter hashed. Nothing here is
-- trusted: `inventory_assertion_consume` then verifies the MAC over those very
-- components (step 4), compares this digest with component 7 (step 7) and
-- requires the transaction scope to equal them (step 9). A claim that was
-- tampered with fails the MAC; a digest over the wrong arguments fails step 7.
--
-- NULL — which no assertion can match, so the call is refused by an earlier
-- step or by step 7 — when the carrier is absent or not ten components with
-- UUID claims, or when an argument is not canonical. A non-canonical argument
-- is one no minter can have signed (the TypeScript canonicalizer refuses it),
-- and answering it with an assertion refusal rather than a payload error keeps
-- the assertion the first thing every entry routine decides on.
CREATE OR REPLACE FUNCTION inventory_claimed_payload_digest(
  p_op_code      TEXT,
  p_field_types  TEXT[],
  p_field_values TEXT[]
) RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  c_uuid  CONSTANT TEXT := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_parts TEXT[];
  i       INTEGER;
BEGIN
  IF p_field_types IS NULL OR p_field_values IS NULL
     OR coalesce(array_length(p_field_types, 1), 0) <> coalesce(array_length(p_field_values, 1), 0) THEN
    RAISE EXCEPTION 'inventory.payload_invalid: every payload field has exactly one type' USING ERRCODE = 'P0001';
  END IF;

  v_parts := string_to_array(coalesce(current_setting('app.inventory_assertion', true), ''), '.');
  IF coalesce(array_length(v_parts, 1), 0) <> 10 OR v_parts[4] !~ c_uuid OR v_parts[5] !~ c_uuid THEN
    RETURN NULL;
  END IF;

  FOR i IN 1 .. coalesce(array_length(p_field_types, 1), 0) LOOP
    IF p_field_values[i] IS NOT NULL AND NOT inventory_payload_field_is_canonical(p_field_types[i], p_field_values[i]) THEN
      RETURN NULL;
    END IF;
  END LOOP;

  RETURN inventory_payload_digest(p_op_code, v_parts[4]::uuid, v_parts[5]::uuid, p_field_types, p_field_values);
END;
$$;

COMMENT ON FUNCTION inventory_claimed_payload_digest(TEXT, TEXT[], TEXT[]) IS
  'P3-AL-55 §F-§G. The invpl/1 digest of an entry routine''s own arguments under the tenant and business CLAIMED by app.inventory_assertion (components 4 and 5), for inventory_assertion_consume to verify. NULL — which no assertion matches — when the carrier is absent or malformed or an argument is not canonical. Trusts nothing: consume verifies the MAC over the claims, the digest and the scope. No EXECUTE grant.';

-- ─────────────────────────────────────────────────────────────────────────
-- 7. The verifiers (P3-AL-55 §G).
--
-- `invctl/1`: exactly ten ASCII components separated by `.`:
--
--   invctl1 . kid . actor . tenant . business . op . payload_sha256 . exp . jti . mac
--
-- `op` is the registry op_code with every `.` written as `:`. The MAC is
-- HMAC-SHA-256(secret, 'invctl/1' || LF || c1 '.' … '.' c9), lowercase hex.
-- A non-canonical component is REFUSED — never lowercased, trimmed or
-- normalized into acceptance.
--
-- The carrier is `app.inventory_assertion`, set transaction-locally by the
-- seam. It is worthless unless its MAC verifies. No routine reads the actor,
-- tenant or business from any other GUC; `app.actor_user_id` is never read.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TYPE inventory_verified_actor AS (
  actor_user_id UUID,
  tenant_id     UUID,
  business_id   UUID,
  op_code       TEXT,
  jti           UUID
);

-- Steps 1-11 of P3-AL-55 §G, in that order.
CREATE OR REPLACE FUNCTION inventory_assertion_consume(p_op_code TEXT, p_payload_sha256 TEXT) RETURNS inventory_verified_actor
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  c_uuid     CONSTANT TEXT := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_raw      TEXT;
  v_parts    TEXT[];
  v_secret   BYTEA;
  v_expected TEXT;
  v_now      NUMERIC;
  v_op       TEXT;
  v_owner    UUID;
  v_rows     INTEGER;
  v_out      inventory_verified_actor;
BEGIN
  -- 1. Present.
  v_raw := current_setting('app.inventory_assertion', true);
  IF v_raw IS NULL OR v_raw = '' THEN
    RAISE EXCEPTION 'inventory.assertion_missing: this inventory command requires a server-minted inventory assertion' USING ERRCODE = 'P0001';
  END IF;

  -- 2. Exactly ten canonical components.
  v_parts := string_to_array(v_raw, '.');
  IF coalesce(array_length(v_parts, 1), 0) <> 10
     OR v_parts[1] IS DISTINCT FROM 'invctl1'
     OR v_parts[2] !~ '^[A-Za-z0-9_-]{1,32}$'
     OR v_parts[3] !~ c_uuid
     OR v_parts[4] !~ c_uuid
     OR v_parts[5] !~ c_uuid
     OR v_parts[6] !~ '^[a-z]+(:[a-z_]+)+$'
     OR v_parts[7] !~ '^[0-9a-f]{64}$'
     OR v_parts[8] !~ '^[1-9][0-9]{0,18}$'
     OR v_parts[9] !~ c_uuid
     OR v_parts[10] !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'inventory.assertion_malformed: the inventory assertion is malformed' USING ERRCODE = 'P0001';
  END IF;

  -- 3. An active key.
  SELECT k.secret INTO v_secret
  FROM inventory_assertion_keys k
  WHERE k.kid = v_parts[2] AND k.status = 'active';
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'inventory.assertion_key_unknown: the inventory assertion key is unknown or retired' USING ERRCODE = 'P0001';
  END IF;

  -- 4. The MAC, over the domain-prefixed preimage of components 1-9.
  v_expected := encode(hmac(convert_to('invctl/1' || E'\n' || array_to_string(v_parts[1:9], '.'), 'UTF8'), v_secret, 'sha256'), 'hex');
  IF v_expected <> v_parts[10] THEN
    RAISE EXCEPTION 'inventory.assertion_invalid_signature: the inventory assertion signature is invalid' USING ERRCODE = 'P0001';
  END IF;

  -- 5. Expiry, and the TTL ceiling: 60 s plus a fixed 5 s skew allowance, so
  --    even a defective minter cannot issue a long-lived assertion.
  v_now := extract(epoch FROM clock_timestamp());
  IF v_parts[8]::numeric <= v_now THEN
    RAISE EXCEPTION 'inventory.assertion_expired: the inventory assertion has expired' USING ERRCODE = 'P0001';
  END IF;
  IF v_parts[8]::numeric > v_now + 65 THEN
    RAISE EXCEPTION 'inventory.assertion_ttl_exceeded: the inventory assertion expires too far in the future' USING ERRCODE = 'P0001';
  END IF;

  -- 6. A registered kind, and exactly the one this routine consumes.
  v_op := replace(v_parts[6], ':', '.');
  IF p_op_code IS NULL OR v_op <> p_op_code
     OR NOT EXISTS (SELECT 1 FROM inventory_operation_kinds k WHERE k.op_code = v_op) THEN
    RAISE EXCEPTION 'inventory.assertion_wrong_operation: the inventory assertion was minted for a different operation' USING ERRCODE = 'P0001';
  END IF;

  -- 7. The payload the routine actually received.
  IF p_payload_sha256 IS NULL OR v_parts[7] <> p_payload_sha256 THEN
    RAISE EXCEPTION 'inventory.assertion_payload_mismatch: the submitted payload is not the payload that was authorized' USING ERRCODE = 'P0001';
  END IF;

  v_out.actor_user_id := v_parts[3]::uuid;
  v_out.tenant_id     := v_parts[4]::uuid;
  v_out.business_id   := v_parts[5]::uuid;
  v_out.op_code       := v_op;
  v_out.jti           := v_parts[9]::uuid;

  -- 8. The business exists and belongs to the asserted tenant.
  --
  --    Read under row level security as this principal (never bypassed:
  --    app_bypass() is true only for daftar_platform), so what it can see is
  --    bounded by the transaction's tenant scope. A business it CAN see is
  --    judged exactly. One it cannot see is judged here only when the tenant
  --    scope equals the asserted tenant — then it truly is not that
  --    tenant's — and otherwise falls to step 9, which refuses the scope
  --    mismatch that hid it.
  SELECT b.tenant_id INTO v_owner FROM businesses b WHERE b.id = v_out.business_id;
  IF FOUND THEN
    IF v_owner <> v_out.tenant_id THEN
      RAISE EXCEPTION 'inventory.forbidden: the inventory assertion tenant does not own the named business' USING ERRCODE = 'P0001';
    END IF;
  ELSIF coalesce(current_setting('app.tenant_id', true), '') = v_parts[4] THEN
    RAISE EXCEPTION 'inventory.forbidden: the inventory assertion names a business that does not exist in its tenant' USING ERRCODE = 'P0001';
  END IF;

  -- 9. Scope coherence: the rows RLS admits are the asserted business's.
  IF coalesce(current_setting('app.tenant_id', true), '') <> v_parts[4]
     OR coalesce(current_setting('app.business_id', true), '') <> v_parts[5] THEN
    RAISE EXCEPTION 'inventory.assertion_scope_mismatch: the transaction scope is not the asserted tenant and business' USING ERRCODE = 'P0001';
  END IF;

  -- 10. Consumption. Strictly one entry-routine call per assertion: a jti
  --     already present — from another transaction or from this one — is a
  --     replay. A rolled-back first use rolls its row back with it, so the
  --     identical payload may be retried inside the TTL.
  INSERT INTO inventory_assertion_uses (jti, xact, op_code, business_id)
  VALUES (v_out.jti, pg_current_xact_id(), v_out.op_code, v_out.business_id)
  ON CONFLICT (jti) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'inventory.assertion_replayed: the inventory assertion was already used' USING ERRCODE = 'P0001';
  END IF;

  -- 11. Opportunistic hygiene: a use is worthless long after the TTL ceiling.
  DELETE FROM inventory_assertion_uses WHERE consumed_at < clock_timestamp() - interval '1 hour';

  RETURN v_out;
END;
$$;

COMMENT ON FUNCTION inventory_assertion_consume(TEXT, TEXT) IS
  'P3-AL-55 §G. Verifies and CONSUMES the invctl/1 assertion in app.inventory_assertion for exactly p_op_code and the digest the calling routine computed from its own arguments. Steps: missing, malformed, key, MAC, expiry/TTL, operation, payload, business/tenant, scope, single consumption, hygiene. Returns the signed actor, tenant, business, op_code and jti. No EXECUTE grant: callable only from routines daftar_inventory_internal owns.';

-- Non-consuming re-verification for INTERNAL primitives (P3-S2 onward): steps
-- 1-4, 6 against the allowed list, and 9, and then the requirement that the
-- entry routine of THIS transaction consumed this very assertion.
CREATE OR REPLACE FUNCTION inventory_assertion_current(p_allowed_op_codes TEXT[]) RETURNS inventory_verified_actor
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  c_uuid     CONSTANT TEXT := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_raw      TEXT;
  v_parts    TEXT[];
  v_secret   BYTEA;
  v_expected TEXT;
  v_op       TEXT;
  v_out      inventory_verified_actor;
BEGIN
  v_raw := current_setting('app.inventory_assertion', true);
  IF v_raw IS NULL OR v_raw = '' THEN
    RAISE EXCEPTION 'inventory.assertion_missing: this inventory primitive requires the transaction''s inventory assertion' USING ERRCODE = 'P0001';
  END IF;

  v_parts := string_to_array(v_raw, '.');
  IF coalesce(array_length(v_parts, 1), 0) <> 10
     OR v_parts[1] IS DISTINCT FROM 'invctl1'
     OR v_parts[2] !~ '^[A-Za-z0-9_-]{1,32}$'
     OR v_parts[3] !~ c_uuid
     OR v_parts[4] !~ c_uuid
     OR v_parts[5] !~ c_uuid
     OR v_parts[6] !~ '^[a-z]+(:[a-z_]+)+$'
     OR v_parts[7] !~ '^[0-9a-f]{64}$'
     OR v_parts[8] !~ '^[1-9][0-9]{0,18}$'
     OR v_parts[9] !~ c_uuid
     OR v_parts[10] !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'inventory.assertion_malformed: the inventory assertion is malformed' USING ERRCODE = 'P0001';
  END IF;

  SELECT k.secret INTO v_secret
  FROM inventory_assertion_keys k
  WHERE k.kid = v_parts[2] AND k.status = 'active';
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'inventory.assertion_key_unknown: the inventory assertion key is unknown or retired' USING ERRCODE = 'P0001';
  END IF;

  v_expected := encode(hmac(convert_to('invctl/1' || E'\n' || array_to_string(v_parts[1:9], '.'), 'UTF8'), v_secret, 'sha256'), 'hex');
  IF v_expected <> v_parts[10] THEN
    RAISE EXCEPTION 'inventory.assertion_invalid_signature: the inventory assertion signature is invalid' USING ERRCODE = 'P0001';
  END IF;

  v_op := replace(v_parts[6], ':', '.');
  IF p_allowed_op_codes IS NULL OR NOT (v_op = ANY (p_allowed_op_codes))
     OR NOT EXISTS (SELECT 1 FROM inventory_operation_kinds k WHERE k.op_code = v_op) THEN
    RAISE EXCEPTION 'inventory.assertion_wrong_operation: the inventory assertion was minted for a different operation' USING ERRCODE = 'P0001';
  END IF;

  IF coalesce(current_setting('app.tenant_id', true), '') <> v_parts[4]
     OR coalesce(current_setting('app.business_id', true), '') <> v_parts[5] THEN
    RAISE EXCEPTION 'inventory.assertion_scope_mismatch: the transaction scope is not the asserted tenant and business' USING ERRCODE = 'P0001';
  END IF;

  v_out.actor_user_id := v_parts[3]::uuid;
  v_out.tenant_id     := v_parts[4]::uuid;
  v_out.business_id   := v_parts[5]::uuid;
  v_out.op_code       := v_op;
  v_out.jti           := v_parts[9]::uuid;

  IF NOT EXISTS (SELECT 1 FROM inventory_assertion_uses u
                  WHERE u.jti = v_out.jti AND u.xact = pg_current_xact_id()
                    AND u.op_code = v_out.op_code AND u.business_id = v_out.business_id) THEN
    RAISE EXCEPTION 'inventory.assertion_not_consumed: no entry routine of this transaction consumed the inventory assertion' USING ERRCODE = 'P0001';
  END IF;

  RETURN v_out;
END;
$$;

COMMENT ON FUNCTION inventory_assertion_current(TEXT[]) IS
  'P3-AL-55 §G. Non-consuming re-verification for internal primitives: steps 1-4, 6 (against p_allowed_op_codes) and 9 of inventory_assertion_consume, then requires that this jti was consumed by THIS transaction (inventory.assertion_not_consumed otherwise). No EXECUTE grant.';

-- ─────────────────────────────────────────────────────────────────────────
-- 8. The final ACL, set while the MIGRATOR still owns every function, then
--    the ownership transfer (0044:177-199 — do not reorder).
-- ─────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION inventory_assertion_key_install(TEXT, BYTEA) FROM PUBLIC;
REVOKE ALL ON FUNCTION inventory_assertion_key_retire(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION inventory_payload_field_is_canonical(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION inventory_payload_digest(TEXT, UUID, UUID, TEXT[], TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION inventory_claimed_payload_digest(TEXT, TEXT[], TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION inventory_assertion_consume(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION inventory_assertion_current(TEXT[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION inventory_assertion_key_install(TEXT, BYTEA) TO daftar_platform;
GRANT EXECUTE ON FUNCTION inventory_assertion_key_retire(TEXT) TO daftar_platform;

ALTER FUNCTION inventory_assertion_key_install(TEXT, BYTEA) OWNER TO daftar_inventory_internal;
ALTER FUNCTION inventory_assertion_key_retire(TEXT) OWNER TO daftar_inventory_internal;
ALTER FUNCTION inventory_payload_field_is_canonical(TEXT, TEXT) OWNER TO daftar_inventory_internal;
ALTER FUNCTION inventory_payload_digest(TEXT, UUID, UUID, TEXT[], TEXT[]) OWNER TO daftar_inventory_internal;
ALTER FUNCTION inventory_claimed_payload_digest(TEXT, TEXT[], TEXT[]) OWNER TO daftar_inventory_internal;
ALTER FUNCTION inventory_assertion_consume(TEXT, TEXT) OWNER TO daftar_inventory_internal;
ALTER FUNCTION inventory_assertion_current(TEXT[]) OWNER TO daftar_inventory_internal;

-- Hand back the ownership-transfer authority from section 1.
REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 9. Refuse to commit unless the end state is exactly right.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_role   TEXT;
  v_table  TEXT;
  v_priv   TEXT;
  v_detail TEXT;
BEGIN
  -- (a) The internal principal is still exactly what §C says.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daftar_inventory_internal'
               AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolinherit)) THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_inventory_internal is no longer an unreachable NOLOGIN NOINHERIT principal';
  END IF;
  SELECT string_agg(m.rolname, ', ' ORDER BY m.rolname) INTO v_detail
  FROM pg_auth_members a JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
  WHERE g.rolname = 'daftar_inventory_internal' AND (m.rolname <> 'daftar_migrator' OR a.inherit_option OR a.admin_option);
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'inventory.authority_leak: unexpected membership in daftar_inventory_internal: %', v_detail;
  END IF;
  IF has_schema_privilege('daftar_inventory_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_inventory_internal still holds CREATE on schema public';
  END IF;
  IF has_database_privilege('daftar_inventory_internal', current_database(), 'TEMPORARY') THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_inventory_internal holds TEMPORARY';
  END IF;

  -- (b) No runtime role and not PUBLIC holds ANY privilege on the key domain
  --     or the registry (P3-AL-55 §C; matrix O).
  FOR v_role IN SELECT unnest(ARRAY['daftar_app','daftar_platform','daftar_worker','daftar_identity','daftar_resolver','daftar_provisioner','daftar_reconciler','public']) LOOP
    FOR v_table IN SELECT unnest(ARRAY['inventory_assertion_keys','inventory_assertion_uses','inventory_operation_kinds']) LOOP
      FOR v_priv IN SELECT unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) LOOP
        IF has_table_privilege(v_role, v_table, v_priv) THEN
          RAISE EXCEPTION 'inventory.authority_leak: % holds % on %', v_role, v_priv, v_table;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  IF has_table_privilege('daftar_inventory_internal', 'inventory_assertion_keys', 'DELETE')
     OR has_table_privilege('daftar_inventory_internal', 'inventory_assertion_uses', 'UPDATE')
     OR has_table_privilege('daftar_inventory_internal', 'inventory_operation_kinds', 'INSERT')
     OR has_table_privilege('daftar_inventory_internal', 'inventory_operation_kinds', 'UPDATE')
     OR has_table_privilege('daftar_inventory_internal', 'inventory_operation_kinds', 'DELETE') THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_inventory_internal holds more than §H on the key domain';
  END IF;

  -- (c) The registry is exactly the three P3-S1 kinds.
  IF (SELECT array_agg(op_code ORDER BY op_code) FROM inventory_operation_kinds)
     IS DISTINCT FROM ARRAY['inventory.configure_product', 'structure.associate_warehouse_branch', 'structure.dissociate_warehouse_branch'] THEN
    RAISE EXCEPTION 'inventory.authority_leak: the operation registry is not exactly the three P3-S1 kinds';
  END IF;

  -- (d) The seven functions are owned by the internal principal, are SECURITY
  --     DEFINER, and pin pg_temp last (P3-AL-54 §D — the column guards of
  --     0053 are the only invoker-rights functions the role may own).
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_detail
  FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
  WHERE p.proname IN ('inventory_assertion_key_install','inventory_assertion_key_retire','inventory_assertion_consume',
                      'inventory_assertion_current','inventory_payload_digest','inventory_payload_field_is_canonical',
                      'inventory_claimed_payload_digest')
    AND (r.rolname <> 'daftar_inventory_internal'
         OR NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS c WHERE c = 'search_path=pg_catalog, public, pg_temp')
         OR has_function_privilege('public', p.oid, 'EXECUTE'));
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'inventory.authority_leak: key-domain routine(s) with the wrong owner, path or PUBLIC EXECUTE: %', v_detail;
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE prosecdef AND proname IN
        ('inventory_assertion_key_install','inventory_assertion_key_retire','inventory_assertion_consume',
         'inventory_assertion_current','inventory_payload_digest','inventory_payload_field_is_canonical',
         'inventory_claimed_payload_digest')) <> 7 THEN
    RAISE EXCEPTION 'inventory.authority_leak: the key commands, the canonicalizer and the verifiers must be SECURITY DEFINER';
  END IF;

  -- (e) Only daftar_platform may install or retire; nobody may call the
  --     verifiers or the canonicalizer.
  FOR v_role IN SELECT unnest(ARRAY['daftar_app','daftar_worker','daftar_identity','daftar_resolver','daftar_provisioner','daftar_reconciler','public']) LOOP
    IF has_function_privilege(v_role, 'inventory_assertion_key_install(text,bytea)', 'EXECUTE')
       OR has_function_privilege(v_role, 'inventory_assertion_key_retire(text)', 'EXECUTE') THEN
      RAISE EXCEPTION 'inventory.authority_leak: % may install or retire inventory assertion keys', v_role;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('daftar_platform', 'inventory_assertion_key_install(text,bytea)', 'EXECUTE')
     OR NOT has_function_privilege('daftar_platform', 'inventory_assertion_key_retire(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_platform cannot manage inventory assertion keys';
  END IF;
  FOR v_role IN SELECT unnest(ARRAY['daftar_app','daftar_platform','daftar_worker','daftar_identity','daftar_resolver','daftar_provisioner','daftar_reconciler','public']) LOOP
    IF has_function_privilege(v_role, 'inventory_assertion_consume(text,text)', 'EXECUTE')
       OR has_function_privilege(v_role, 'inventory_assertion_current(text[])', 'EXECUTE')
       OR has_function_privilege(v_role, 'inventory_payload_digest(text,uuid,uuid,text[],text[])', 'EXECUTE')
       OR has_function_privilege(v_role, 'inventory_payload_field_is_canonical(text,text)', 'EXECUTE')
       OR has_function_privilege(v_role, 'inventory_claimed_payload_digest(text,text[],text[])', 'EXECUTE') THEN
      RAISE EXCEPTION 'inventory.authority_leak: % may execute an internal inventory verifier', v_role;
    END IF;
  END LOOP;

  -- (f) The three key domains are three distinct tables.
  IF (SELECT count(*) FROM pg_class WHERE relname IN ('inventory_assertion_keys','accounting_assertion_keys','provisioning_assertion_keys') AND relkind = 'r') <> 3 THEN
    RAISE EXCEPTION 'inventory.authority_leak: the inventory, accounting and provisioning key registries must be three distinct tables';
  END IF;
END $$;

COMMENT ON TABLE inventory_assertion_keys IS
  'P3-AL-55 §C. HMAC key material for invctl/1 inventory command assertions. No runtime role may read it; daftar_platform may install and retire keys but cannot read them back. Separate from the accounting and provisioning key domains so one compromise is not all three.';
COMMENT ON TABLE inventory_assertion_uses IS
  'P3-AL-55 §H. Strict single consumption: one invctl/1 assertion authorizes one entry-routine call. xact records the consuming transaction so internal primitives can require that THIS transaction consumed it.';
COMMENT ON TABLE inventory_operation_kinds IS
  'P3-AL-55 §E. Closed registry of invctl/1 operation kinds. A row exists only for a command whose routine exists; each routine accepts exactly one kind. Extended only by migrations.';
