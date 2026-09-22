-- 0044_accounting_assertion_keys.sql
-- P2-S3, part 1 of 2 — the accounting assertion key domain (directive §13-§17).
--
-- AL-03 settled that a caller-settable GUC is not authorization. `app.tenant_id`,
-- `app.business_id` and `app.actor_user_id` can all be set by anything holding
-- the daftar_app credential, so a stolen credential could otherwise name a
-- victim's tenant, cite a genuinely active member, and post. The Accounting
-- Command Assertion closes that: the merchant API mints it AFTER
-- authentication, membership, RBAC and branch-scope checks, and the database
-- verifies its HMAC against key material no runtime role can read.
--
-- This file creates ONLY the key domain. The verifier and the posting
-- primitive are 0045, so that at no point does an assertion-checking function
-- exist without the registry it checks against, and at no point does a writer
-- exist without both.
--
-- ── Why this is NOT the provisioning key domain ───────────────────────────
--
-- 0038 already has provisioning_assertion_keys and provisioning_assertion_uses
-- for the same *shape* of problem. Reusing them would mean one stolen secret
-- compromises both business provisioning AND the general ledger, and that a
-- provisioning-key rotation silently invalidates every in-flight posting.
-- Two domains, two registries, two secrets, rotated independently (§13). The
-- application enforces the other half of the separation: §19 fails startup in
-- production if the two secrets ever decode to the same bytes.
--
-- ── Who can do what ──────────────────────────────────────────────────────
--
--   * NO runtime login role may SELECT a secret. Not daftar_app, not
--     daftar_platform, not the worker, not PUBLIC. There are no grants.
--   * daftar_platform may INSTALL and RETIRE keys, through two SECURITY
--     DEFINER commands — and cannot read what it installed. Writing a key is
--     an operational act; reading one back is not, and a platform credential
--     that could read key material could mint assertions.
--   * daftar_accounting_internal, the NOLOGIN principal from 0040, reads the
--     registry from inside the verifier in 0045. It is unreachable by any
--     credential: no LOGIN, no password, no CONNECT.
--   * The deployment migrator owns these tables and can therefore read them.
--     That is the deployment trust boundary (§77), not a runtime one, and it
--     is exactly why that credential is loaded by no service.
--
-- Migrations 0000-0043 are frozen and untouched.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The key registry.
--
-- The CHECKs mirror the application's own validation (parseAccountingAssertionKey)
-- so a misconfigured deployment is refused by the database too, rather than
-- only by whichever process happened to look first.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE accounting_assertion_keys (
  kid        TEXT PRIMARY KEY CHECK (kid ~ '^[A-Za-z0-9_-]{1,32}$'),
  secret     BYTEA NOT NULL CHECK (octet_length(secret) >= 32),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ,
  CONSTRAINT accounting_assertion_keys_retired_shape_ck
    CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);
REVOKE ALL ON accounting_assertion_keys FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The replay registry.
--
-- An assertion's jti is bound to the FIRST transaction that presents it. The
-- conceptual model is 0038's, deliberately: several trusted accounting calls
-- may compose one workflow inside ONE transaction and legitimately present
-- the same assertion, while a later transaction presenting it is a replay and
-- is refused. Calling that "single use" would be wrong, which is why the
-- registry stores the transaction id rather than a boolean (§17).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE accounting_assertion_uses (
  jti     UUID PRIMARY KEY,
  xact    XID8 NOT NULL,
  used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
REVOKE ALL ON accounting_assertion_uses FROM PUBLIC;

CREATE INDEX accounting_assertion_uses_used_at_idx ON accounting_assertion_uses (used_at);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. The ownership-transfer authority, taken and returned inside this file.
--
-- PostgreSQL lets a non-superuser change a function's owner only when it can
-- SET ROLE to the new owner AND that owner holds CREATE on the schema. 0040
-- learned this the hard way; the same scaffolding is used here so a managed,
-- NOSUPERUSER migrator can apply this file. DDL is transactional, so the
-- grant never exists in any committed state, and section 6 asserts it is gone.
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;

-- The internal principal reads key material from inside the 0045 verifier, and
-- maintains the replay registry. It gets exactly that and nothing more: no
-- DELETE on keys, so it cannot destroy key material, and no UPDATE on a jti,
-- so a use cannot be rewritten to a different transaction.
GRANT SELECT, INSERT, UPDATE ON accounting_assertion_keys TO daftar_accounting_internal;
GRANT SELECT, INSERT, DELETE ON accounting_assertion_uses TO daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Key management — daftar_platform only, and write-only even for it.
-- ─────────────────────────────────────────────────────────────────────────

-- Install a key.
--
-- Idempotent for the SAME kid with the SAME secret, so a re-run of an ops job
-- is harmless. Loud for the same kid with DIFFERENT material: silently
-- replacing a secret under a live kid would invalidate every assertion in
-- flight and, worse, would let anyone who can reach this command swap the
-- key the verifier trusts (§16).
--
-- Retirement is terminal. Re-installing onto a retired kid is refused rather
-- than quietly reactivating it: an operator retires a key because they believe
-- it is compromised, and "preserve posting availability" is never a reason to
-- undo that decision (§16). Rotation is install-new → deploy → retire-old.
CREATE OR REPLACE FUNCTION accounting_assertion_key_install(p_kid TEXT, p_secret BYTEA) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  v_existing BYTEA;
  v_status   TEXT;
BEGIN
  IF p_kid IS NULL OR p_kid !~ '^[A-Za-z0-9_-]{1,32}$' THEN
    RAISE EXCEPTION 'accounting.assertion_key_invalid: the accounting assertion key id is malformed' USING ERRCODE = 'P0001';
  END IF;
  -- Never interpolated into a message: a secret must not reach a log line,
  -- an error, or a returned value (§16, §78).
  IF p_secret IS NULL OR octet_length(p_secret) < 32 THEN
    RAISE EXCEPTION 'accounting.assertion_key_invalid: an accounting assertion key must be at least 32 bytes' USING ERRCODE = 'P0001';
  END IF;

  SELECT k.secret, k.status INTO v_existing, v_status
  FROM accounting_assertion_keys k WHERE k.kid = p_kid;

  IF v_existing IS NULL THEN
    INSERT INTO accounting_assertion_keys (kid, secret, status) VALUES (p_kid, p_secret, 'active');
    RETURN;
  END IF;

  IF v_status = 'retired' THEN
    RAISE EXCEPTION 'accounting.assertion_key_conflict: accounting assertion key % is retired and cannot be reinstated', p_kid USING ERRCODE = 'P0001';
  END IF;

  IF v_existing IS DISTINCT FROM p_secret THEN
    RAISE EXCEPTION 'accounting.assertion_key_conflict: accounting assertion key % already exists with different key material', p_kid USING ERRCODE = 'P0001';
  END IF;

  -- Same kid, same material, still active: nothing to do.
END;
$$;

-- Retire a key. Terminal, and idempotent on an already-retired kid.
CREATE OR REPLACE FUNCTION accounting_assertion_key_retire(p_kid TEXT) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  UPDATE accounting_assertion_keys
  SET status = 'retired', retired_at = coalesce(retired_at, now())
  WHERE kid = p_kid AND status = 'active';
END;
$$;

REVOKE ALL ON FUNCTION accounting_assertion_key_install(TEXT, BYTEA) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_assertion_key_retire(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accounting_assertion_key_install(TEXT, BYTEA) TO daftar_platform;
GRANT EXECUTE ON FUNCTION accounting_assertion_key_retire(TEXT) TO daftar_platform;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Final ownership.
--
-- The commands run as daftar_accounting_internal rather than as a LOGIN
-- runtime role (§15). A SECURITY DEFINER function owned by daftar_platform
-- would mean a stolen platform password carries the function's authority
-- directly; owned by an unreachable NOLOGIN principal, it carries only the
-- right to CALL it.
-- ─────────────────────────────────────────────────────────────────────────
ALTER FUNCTION accounting_assertion_key_install(TEXT, BYTEA) OWNER TO daftar_accounting_internal;
ALTER FUNCTION accounting_assertion_key_retire(TEXT) OWNER TO daftar_accounting_internal;

-- Hand back the ownership-transfer authority from section 3.
REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. Refuse to commit unless the end state is exactly right.
--
-- Everything asserted here is also proven from the live catalogue by the
-- P2-S3 test matrix. Asserting it in the migration too means a deployment
-- that somehow diverges fails at deploy time rather than at the first
-- posting.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_role   TEXT;
  v_count  INTEGER;
BEGIN
  -- (a) No runtime login role holds ANY privilege on either table. The
  --     migrator is deliberately excluded: it owns these tables and
  --     PostgreSQL gives an owner rights that cannot be revoked.
  FOR v_role IN
    SELECT unnest(ARRAY['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver', 'daftar_provisioner'])
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants g
      WHERE g.table_name IN ('accounting_assertion_keys', 'accounting_assertion_uses')
        AND g.grantee = v_role
    ) THEN
      RAISE EXCEPTION 'accounting.key_domain_exposed: runtime role % holds a privilege on the accounting assertion key domain', v_role;
    END IF;
  END LOOP;

  -- (b) PUBLIC holds nothing either.
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants g
    WHERE g.table_name IN ('accounting_assertion_keys', 'accounting_assertion_uses')
      AND g.grantee = 'PUBLIC'
  ) THEN
    RAISE EXCEPTION 'accounting.key_domain_exposed: PUBLIC holds a privilege on the accounting assertion key domain';
  END IF;

  -- (c) The key domain is genuinely separate from the provisioning one.
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'provisioning_assertion_keys') THEN
    RAISE EXCEPTION 'accounting.key_domain_invalid: the provisioning key domain is missing — 0038 is a prerequisite';
  END IF;
  IF (SELECT count(*) FROM pg_class WHERE relname IN ('accounting_assertion_keys', 'provisioning_assertion_keys')) <> 2 THEN
    RAISE EXCEPTION 'accounting.key_domain_invalid: the accounting and provisioning key registries must be two distinct tables';
  END IF;

  -- (d) Both commands are owned by the unreachable internal principal.
  SELECT count(*) INTO v_count
  FROM pg_proc p
  JOIN pg_roles r ON r.oid = p.proowner
  WHERE p.proname IN ('accounting_assertion_key_install', 'accounting_assertion_key_retire')
    AND r.rolname = 'daftar_accounting_internal';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'accounting.key_domain_invalid: the key management commands must be owned by daftar_accounting_internal (got %)', v_count;
  END IF;

  -- (e) Only daftar_platform may execute them, and PUBLIC may not.
  IF has_function_privilege('daftar_app', 'accounting_assertion_key_install(text,bytea)', 'EXECUTE')
     OR has_function_privilege('daftar_worker', 'accounting_assertion_key_install(text,bytea)', 'EXECUTE') THEN
    RAISE EXCEPTION 'accounting.key_domain_exposed: a non-platform runtime role may install accounting assertion keys';
  END IF;
  IF NOT has_function_privilege('daftar_platform', 'accounting_assertion_key_install(text,bytea)', 'EXECUTE') THEN
    RAISE EXCEPTION 'accounting.key_domain_invalid: daftar_platform cannot install accounting assertion keys';
  END IF;

  -- (f) The temporary CREATE is gone.
  IF has_schema_privilege('daftar_accounting_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'accounting.key_domain_invalid: the temporary CREATE on schema public was not revoked';
  END IF;

  -- (g) The internal principal is still unreachable.
  IF EXISTS (SELECT 1 FROM pg_authid WHERE rolname = 'daftar_accounting_internal' AND (rolcanlogin OR rolbypassrls OR rolsuper)) THEN
    RAISE EXCEPTION 'accounting.key_domain_invalid: daftar_accounting_internal must remain NOLOGIN, NOBYPASSRLS and NOSUPERUSER';
  END IF;
END $$;

COMMENT ON TABLE accounting_assertion_keys IS
  'HMAC key material for Accounting Command Assertions (AL-03). No runtime login role may read it; daftar_platform may install and retire keys but cannot read them back. Deliberately separate from provisioning_assertion_keys so one compromise is not both.';
COMMENT ON TABLE accounting_assertion_uses IS
  'Replay registry: an assertion jti is bound to the first transaction that presents it. The same assertion may be reused inside that one transaction; a later transaction presenting it is a replay and is refused.';
