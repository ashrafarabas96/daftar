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
--
-- ── Why every routine below pins `pg_catalog, public, pg_temp` ───────────
--
-- A `search_path` that does not name `pg_temp` is not a path without
-- `pg_temp`. PostgreSQL still searches the session temporary schema for
-- relation and type names, and it searches it FIRST — ahead of every schema
-- that IS named. Omitting it does not exclude it; it forfeits the choice of
-- where it sits. Naming it last is the only way to put it after the trusted
-- schemas.
--
-- That matters here because `accounting_assertion_keys` is read by name from
-- inside an elevated routine. A caller that could create
-- `pg_temp.accounting_assertion_keys` would be choosing the key material the
-- verifier trusts. `bootstrap.sql` takes TEMPORARY away from PUBLIC and from
-- every runtime role, which is the boundary that actually closes the class
-- (it covers the frozen Phase 1 routines too, whose bytes may not change).
-- This line is the second lock on the same door.
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
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
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
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE accounting_assertion_keys
  SET status = 'retired', retired_at = coalesce(retired_at, now())
  WHERE kid = p_kid AND status = 'active';
END;
$$;

-- The ACL is set while the MIGRATOR still owns these functions, and the
-- ownership transfer follows in section 5. That order matters on a managed
-- PostgreSQL: a non-superuser migrator is a member of the internal principal
-- WITH INHERIT FALSE, so once the function belongs to that principal a REVOKE
-- issued by the migrator matches no grantor, PostgreSQL emits a WARNING
-- rather than an error, and the migration commits with PUBLIC still able to
-- execute (§72). Do not reorder these two sections.
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
  v_table  TEXT;
  v_priv   TEXT;
  v_count  INTEGER;
BEGIN
  -- (a) No runtime login role holds ANY privilege on either table, and
  --     neither does PUBLIC. The migrator is deliberately excluded: it owns
  --     these tables and PostgreSQL gives an owner rights that cannot be
  --     revoked.
  --
  --     `has_table_privilege`, not `information_schema.role_table_grants`:
  --     that view only shows grants involving a role the CURRENT user can
  --     enable, so under a non-superuser deployment migrator it would hide
  --     exactly the rows this is looking for and the check would pass by
  --     seeing nothing (§72). A check another session's role membership can
  --     silence is not a check.
  FOR v_role IN
    SELECT unnest(ARRAY['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver', 'daftar_provisioner', 'public'])
  LOOP
    FOR v_table IN SELECT unnest(ARRAY['accounting_assertion_keys', 'accounting_assertion_uses'])
    LOOP
      FOR v_priv IN SELECT unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
      LOOP
        IF has_table_privilege(v_role, v_table, v_priv) THEN
          RAISE EXCEPTION 'accounting.key_domain_exposed: % holds % on %', v_role, v_priv, v_table;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

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
  FOR v_role IN
    SELECT unnest(ARRAY['daftar_app','daftar_worker','daftar_identity','daftar_resolver','daftar_provisioner','public'])
  LOOP
    IF has_function_privilege(v_role, 'accounting_assertion_key_install(text,bytea)', 'EXECUTE')
       OR has_function_privilege(v_role, 'accounting_assertion_key_retire(text)', 'EXECUTE') THEN
      RAISE EXCEPTION 'accounting.key_domain_exposed: % may install or retire accounting assertion keys', v_role;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('daftar_platform', 'accounting_assertion_key_install(text,bytea)', 'EXECUTE')
     OR NOT has_function_privilege('daftar_platform', 'accounting_assertion_key_retire(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'accounting.key_domain_invalid: daftar_platform cannot manage accounting assertion keys';
  END IF;

  -- (f) The temporary CREATE is gone.
  IF has_schema_privilege('daftar_accounting_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'accounting.key_domain_invalid: the temporary CREATE on schema public was not revoked';
  END IF;

  -- (f2) Both commands put pg_temp last, so a caller-created temporary
  --      relation cannot shadow the key registry they read by name.
  FOR v_table IN SELECT unnest(ARRAY['accounting_assertion_key_install', 'accounting_assertion_key_retire'])
  LOOP
    SELECT count(*) INTO v_count
    FROM pg_proc p
    WHERE p.proname = v_table
      AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS c
                  WHERE c ~ '^search_path=.*,\s*pg_temp$');
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'accounting.key_domain_invalid: % does not pin pg_temp last in its search_path', v_table;
    END IF;
  END LOOP;

  -- (g) The internal principal is still unreachable.
  -- pg_roles, not pg_authid: the latter is superuser-only, and a check that
  -- only a superuser can run is a check a managed deployment cannot run at
  -- all (§72). pg_roles is the public view over the same columns, minus the
  -- password hash this has no business reading.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daftar_accounting_internal' AND (rolcanlogin OR rolbypassrls OR rolsuper)) THEN
    RAISE EXCEPTION 'accounting.key_domain_invalid: daftar_accounting_internal must remain NOLOGIN, NOBYPASSRLS and NOSUPERUSER';
  END IF;
END $$;

COMMENT ON TABLE accounting_assertion_keys IS
  'HMAC key material for Accounting Command Assertions (AL-03). No runtime login role may read it; daftar_platform may install and retire keys but cannot read them back. Deliberately separate from provisioning_assertion_keys so one compromise is not both.';
COMMENT ON TABLE accounting_assertion_uses IS
  'Replay registry: an assertion jti is bound to the first transaction that presents it. The same assertion may be reused inside that one transaction; a later transaction presenting it is a replay and is refused.';
