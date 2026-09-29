-- 0070_definer_ownership_hardening.sql
-- Phase 3 corrective hardening — TD-18 (the Tech Lead's corrective directive
-- §6; P3-S9 review SR-3, SR-4). Not a Phase 4 migration.
--
-- ── The defect ──────────────────────────────────────────────────────────
--
-- Four pre-Phase-3 SECURITY DEFINER routines are owned by WHOEVER APPLIED THE
-- HISTORY, because 0037-0039 create them and never say OWNER TO:
--
--   catalog_identifiers_sync()                      (0039:58)
--   provision_actor(text[])                         (0038:80, body 0061)
--   provision_assertion_key_install(text, bytea)    (0038:58)
--   provision_assertion_key_retire(text)            (0038:68)
--
-- On a superuser-built database they run as `postgres`, which bypasses
-- row-level security; on the deployer-built database they run as
-- `daftar_migrator`, which does not. The same routine therefore had two
-- security semantics depending on who ran the migrations. Their effective
-- path is `public, pg_catalog, pg_temp` (0045 §9b appended pg_temp; the file
-- text of 0038:59, 0038:69 and 0039:59 never named it): `public` is searched
-- BEFORE `pg_catalog`, so an object in `public` named like a catalogue
-- function (`string_to_array`, `btrim`, `lower`, …) would be called instead
-- of it.
--
-- ── What this file does ─────────────────────────────────────────────────
--
--   1. Preconditions: the two NOLOGIN owners bootstrap.sql creates exist in
--      the exact internal shape, the deployer may SET ROLE to them and
--      nothing else is a member.
--   2. Each owner receives exactly the table privileges its bodies need:
--        daftar_catalog_internal       SELECT, INSERT, DELETE on
--                                      catalog_identifiers; SELECT (id,
--                                      tenant_id) on businesses (the
--                                      registry's tenant_membership policy
--                                      reads those two columns).
--        daftar_provisioning_internal  SELECT, INSERT, UPDATE on
--                                      provisioning_assertion_keys; SELECT,
--                                      INSERT, DELETE on
--                                      provisioning_assertion_uses.
--   3. The four bodies are re-created by their current owner, byte-for-byte
--      in behaviour, with `SET search_path = pg_catalog, public, pg_temp`
--      (the P3-AL-54 §D form: trusted schemas, pg_catalog first, pg_temp
--      named and last) and every relation and non-catalogue function
--      schema-qualified (`public.…`). catalog_identifier_norm(text, text),
--      which the sync trigger calls, gets the same path: it runs inside
--      the definer.
--   4. PUBLIC's EXECUTE is revoked and the one runtime grant (daftar_platform
--      on the three provisioning routines; nobody on the trigger function)
--      re-issued WHILE THE APPLIER STILL OWNS THEM: a GRANT by a non-owner
--      without grant option is only a WARNING, so the reverse order would
--      silently grant nothing on a managed deployment (0069's lesson).
--   5. Ownership is handed over inside the CREATE-on-public bracket of each
--      new owner (P3-AL-54 §J), then the bracket is closed.
--   3b. provision_assertion_key_install stops being an UPSERT: 0038's body
--      let the platform replace an ACTIVE kid's secret and reinstate a
--      RETIRED kid. It now has 0044's semantics (write once; the same bytes
--      again is a no-op; different bytes or a retired kid is
--      PROV:KEY_CONFLICT). Retirement is unchanged.
--   6. 0070-E: the end state against the live catalogue, including the
--      directive's own question — the applier owns NO SECURITY DEFINER
--      routine in `public` any more — so the owner is the same whether a
--      superuser or `daftar_migrator` applied the history.
--   5b. Every OTHER SECURITY DEFINER routine in `public` gets the same
--      pinned path (review I3). Thirteen older definers did not put pg_temp
--      last: the seven provisioning commands of 0006-0026 pin
--      `public, pg_catalog` (pg_temp is then searched FIRST for relations),
--      and six accounting routines of 0040-0047 pin
--      `public, pg_catalog, pg_temp` (public before pg_catalog). Only the
--      path changes (ALTER FUNCTION … SET search_path; bodies, owners and
--      grants untouched), each by a principal holding its owner's
--      privileges. Every one already carried a SET clause, so no function
--      loses inlining; no RLS helper is a definer. The one name `public`
--      and pg_catalog share is gen_random_uuid() (pgcrypto and the core
--      function, the same behaviour), so pg_catalog first changes nothing a
--      body calls. The discovered set must be exactly those thirteen.
--
-- ── Row security: the 0056 internal-principal admission ─────────────────
--
-- `catalog_identifiers` keeps its 0037 tenant and business policies. The
-- sync trigger's owner gets the admission 0056 gave daftar_inventory_internal
-- on branch_warehouses, and nothing wider: read, insert and delete for that
-- role alone, and the RESTRICTIVE business_isolation admits it across
-- businesses ONLY while no business scope is set. Wherever `app.business_id`
-- is set, a registry row must still belong to that business. The trigger
-- derives the business from the product or variant row that fired it, and
-- that row already passed its own table's policies as the writer; nobody may
-- call the routine directly. This makes the registry behave the same on a
-- superuser-built and a deployer-built database — the superuser owner
-- bypassed row security, the deployer owner was bound by it — which is the
-- point of TD-18. The provisioning tables have no row security; their only
-- readers are these routines.
--
-- Migrations 0000-0069 are FROZEN and untouched.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Preconditions.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_role TEXT;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['daftar_catalog_internal', 'daftar_provisioning_internal'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = v_role) THEN
      RAISE EXCEPTION 'authority.migration_precondition: % does not exist — re-run infrastructure/database/bootstrap.sql before 0070', v_role;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = v_role
                 AND (r.rolcanlogin OR r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolinherit)) THEN
      RAISE EXCEPTION 'authority.migration_precondition: % is not a NOLOGIN NOINHERIT role without attributes', v_role;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_auth_members a JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
                WHERE g.rolname = v_role AND (m.rolname <> 'daftar_migrator' OR a.inherit_option OR NOT a.set_option OR a.admin_option)) THEN
      RAISE EXCEPTION 'authority.migration_precondition: % has a member other than daftar_migrator (INHERIT FALSE, SET TRUE)', v_role;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_auth_members a JOIN pg_roles m ON m.oid = a.member WHERE m.rolname = v_role) THEN
      RAISE EXCEPTION 'authority.migration_precondition: % is a member of another role', v_role;
    END IF;
    IF has_database_privilege(v_role, current_database(), 'TEMPORARY') THEN
      RAISE EXCEPTION 'authority.migration_precondition: % holds TEMPORARY — re-run bootstrap.sql', v_role;
    END IF;
  END LOOP;
  IF to_regprocedure('public.catalog_identifiers_sync()') IS NULL
     OR to_regprocedure('public.provision_actor(text[])') IS NULL
     OR to_regprocedure('public.provision_assertion_key_install(text,bytea)') IS NULL
     OR to_regprocedure('public.provision_assertion_key_retire(text)') IS NULL THEN
    RAISE EXCEPTION 'authority.migration_precondition: one of the four TD-18 routines is missing';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The owners' table privileges: exactly what the bodies below need.
-- ─────────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, DELETE ON catalog_identifiers TO daftar_catalog_internal;
GRANT SELECT (id, tenant_id) ON businesses TO daftar_catalog_internal;
GRANT SELECT, INSERT, UPDATE ON provisioning_assertion_keys TO daftar_provisioning_internal;
GRANT SELECT, INSERT, DELETE ON provisioning_assertion_uses TO daftar_provisioning_internal;

-- The internal admission on the registry (see the header): 0056's shape.
ALTER POLICY business_isolation ON catalog_identifiers
  USING      (app_bypass() OR business_id::text = app_business()
              OR (current_user = 'daftar_catalog_internal' AND coalesce(app_business(), '') = ''))
  WITH CHECK (app_bypass() OR business_id::text = app_business()
              OR (current_user = 'daftar_catalog_internal' AND coalesce(app_business(), '') = ''));
CREATE POLICY catalog_internal_read ON catalog_identifiers
  FOR SELECT TO daftar_catalog_internal USING (true);
CREATE POLICY catalog_internal_insert ON catalog_identifiers
  FOR INSERT TO daftar_catalog_internal WITH CHECK (true);
CREATE POLICY catalog_internal_delete ON catalog_identifiers
  FOR DELETE TO daftar_catalog_internal USING (true);


-- ─────────────────────────────────────────────────────────────────────────
-- 3. The four bodies, re-created by their current owner (the applier). The
--    behaviour of each is its accepted definition's; only the path and the
--    qualification change.
-- ─────────────────────────────────────────────────────────────────────────

-- 0037:25. The normaliser the sync trigger calls. It is not a definer and
-- keeps its owner, but it runs INSIDE the definer, and 0045 §9b left it
-- `public, pg_catalog, pg_temp`: a `public.btrim` would be called by the
-- trigger through it. Same expression, catalogue functions qualified, the
-- same pinned path as its caller.
CREATE OR REPLACE FUNCTION catalog_identifier_norm(p_kind TEXT, p_value TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN p_kind OPERATOR(pg_catalog.=) 'sku' THEN pg_catalog.lower(pg_catalog.btrim(p_value)) ELSE pg_catalog.btrim(p_value) END
$$;

-- 0039:58. The registry's only writer, driven by product and variant writes.
CREATE OR REPLACE FUNCTION catalog_identifiers_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_new        JSONB := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE pg_catalog.to_jsonb(NEW) END;
  v_old        JSONB := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE pg_catalog.to_jsonb(OLD) END;
  v_owner_type TEXT := CASE WHEN TG_TABLE_NAME = 'products' THEN 'product' ELSE 'variant' END;
  v_owner_id   UUID := COALESCE((v_new ->> 'id')::uuid, (v_old ->> 'id')::uuid);
  v_business   UUID := COALESCE((v_new ->> 'business_id')::uuid, (v_old ->> 'business_id')::uuid);
  v_live       BOOLEAN := TG_OP <> 'DELETE' AND (v_new ->> 'status') <> 'archived';
  v_sku        TEXT := v_new ->> 'sku';
  v_barcode    TEXT := v_new ->> 'barcode';
  v_product    UUID := CASE WHEN v_owner_type = 'product' THEN v_owner_id END;
  v_variant    UUID := CASE WHEN v_owner_type = 'variant' THEN v_owner_id END;
BEGIN
  -- Release everything this owner held, then re-register the live values.
  DELETE FROM public.catalog_identifiers
   WHERE business_id = v_business AND owner_type = v_owner_type AND owner_id = v_owner_id;
  IF v_live THEN
    IF v_sku IS NOT NULL AND pg_catalog.btrim(v_sku) <> '' THEN
      INSERT INTO public.catalog_identifiers (business_id, kind, value_norm, owner_type, owner_id, product_id, variant_id)
      VALUES (v_business, 'sku', public.catalog_identifier_norm('sku', v_sku), v_owner_type, v_owner_id, v_product, v_variant);
    END IF;
    IF v_barcode IS NOT NULL AND pg_catalog.btrim(v_barcode) <> '' THEN
      INSERT INTO public.catalog_identifiers (business_id, kind, value_norm, owner_type, owner_id, product_id, variant_id)
      VALUES (v_business, 'barcode', public.catalog_identifier_norm('barcode', v_barcode), v_owner_type, v_owner_id, v_product, v_variant);
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- 0038:58. Key management: platform principal only. 0038's body was an
-- UPSERT: the platform could replace an ACTIVE kid's secret and bring a
-- RETIRED kid back. Both are refused now, with the semantics 0044 gave the
-- accounting domain and 0054 the inventory domain: a kid is written once;
-- re-installing the same kid with the same bytes while it is active is a
-- no-op (the documented re-run of scripts/install-provisioning-key.ts and of
-- the test harness); different bytes, or a retired kid, is a conflict. The
-- secret never reaches a message. Two concurrent first installs of one kid
-- serialise on the primary key (ON CONFLICT waits), then compare.
CREATE OR REPLACE FUNCTION provision_assertion_key_install(p_kid TEXT, p_secret BYTEA) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_existing BYTEA;
  v_status   TEXT;
  v_n        INTEGER;
BEGIN
  IF p_kid IS NULL OR p_kid !~ '^[A-Za-z0-9_-]{1,32}$' THEN
    RAISE EXCEPTION 'PROV:INVALID_KEY:the provisioning assertion key id is malformed';
  END IF;
  IF p_secret IS NULL OR pg_catalog.octet_length(p_secret) < 32 THEN
    RAISE EXCEPTION 'PROV:INVALID_KEY:provisioning assertion key must be at least 32 bytes';
  END IF;

  INSERT INTO public.provisioning_assertion_keys (kid, secret, status) VALUES (p_kid, p_secret, 'active')
  ON CONFLICT (kid) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RETURN;
  END IF;

  SELECT k.secret, k.status INTO v_existing, v_status
  FROM public.provisioning_assertion_keys k WHERE k.kid = p_kid FOR UPDATE;
  IF v_status = 'retired' THEN
    RAISE EXCEPTION 'PROV:KEY_CONFLICT:provisioning assertion key % is retired and cannot be reinstated', p_kid;
  END IF;
  IF v_existing IS DISTINCT FROM p_secret THEN
    RAISE EXCEPTION 'PROV:KEY_CONFLICT:provisioning assertion key % already exists with different key material', p_kid;
  END IF;
  -- Same kid, same material, still active: nothing to do.
END;
$$;

-- 0038:68.
CREATE OR REPLACE FUNCTION provision_assertion_key_retire(p_kid TEXT) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  UPDATE public.provisioning_assertion_keys SET status = 'retired' WHERE kid = p_kid
$$;

-- 0038:80 with 0061's advisory-lock prune (TD-13), verbatim in behaviour.
CREATE OR REPLACE FUNCTION provision_actor(p_allowed_kinds TEXT[]) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_raw      TEXT;
  v_parts    TEXT[];
  v_secret   BYTEA;
  v_expected TEXT;
  v_exp      BIGINT;
  v_actor    UUID;
  v_jti      UUID;
  v_xact     XID8;
BEGIN
  v_raw := pg_catalog.current_setting('app.provisioning_assertion', true);
  IF v_raw IS NULL OR v_raw = '' THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Provisioning requires a server-minted assertion';
  END IF;
  v_parts := pg_catalog.string_to_array(v_raw, '.');
  IF pg_catalog.array_length(v_parts, 1) <> 7 OR v_parts[1] <> 'v1' THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Provisioning assertion is malformed';
  END IF;

  SELECT k.secret INTO v_secret FROM public.provisioning_assertion_keys k WHERE k.kid = v_parts[2] AND k.status = 'active';
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Provisioning assertion key is unknown or retired';
  END IF;

  -- Signature over every claim (version, kid, actor, kind, exp, jti).
  v_expected := pg_catalog.encode(public.hmac(pg_catalog.convert_to(pg_catalog.array_to_string(v_parts[1:6], '.'), 'UTF8'), v_secret, 'sha256'), 'hex');
  IF pg_catalog.length(v_parts[7]) <> 64 OR v_expected <> pg_catalog.lower(v_parts[7]) THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Provisioning assertion signature is invalid';
  END IF;

  BEGIN
    v_actor := v_parts[3]::uuid;
    v_exp   := v_parts[5]::bigint;
    v_jti   := v_parts[6]::uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Provisioning assertion claims are malformed';
  END;

  IF v_exp <= extract(epoch FROM pg_catalog.now())::bigint THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Provisioning assertion has expired';
  END IF;
  IF NOT (v_parts[4] = ANY (p_allowed_kinds)) THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Provisioning assertion was minted for a different operation (%)', v_parts[4];
  END IF;

  -- Single use: the jti belongs to the first transaction that presents it.
  INSERT INTO public.provisioning_assertion_uses (jti, xact) VALUES (v_jti, pg_catalog.pg_current_xact_id())
  ON CONFLICT (jti) DO NOTHING;
  SELECT u.xact INTO v_xact FROM public.provisioning_assertion_uses u WHERE u.jti = v_jti;
  IF v_xact <> pg_catalog.pg_current_xact_id() THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Provisioning assertion was already used';
  END IF;
  -- Opportunistic hygiene: expired jtis are useless after the longest TTL.
  -- TD-13 (P3-S3): never make a consumer wait on another's row locks.
  IF pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('daftar.provisioning_assertion_uses'), pg_catalog.hashtext('hygiene')) THEN
    DELETE FROM public.provisioning_assertion_uses WHERE used_at < pg_catalog.now() - interval '1 hour';
  END IF;

  RETURN v_actor;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. GRANT BEFORE OWNER: PUBLIC revoked, the one runtime grant re-issued,
--    while the applier still owns each routine.
-- ─────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION catalog_identifiers_sync() FROM PUBLIC;
-- The normaliser is called only by the sync trigger (nothing in the API or a
-- worker names it): its sole grantee is the trigger's owner.
REVOKE ALL ON FUNCTION catalog_identifier_norm(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog_identifier_norm(TEXT, TEXT) TO daftar_catalog_internal;
REVOKE ALL ON FUNCTION provision_actor(TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION provision_assertion_key_install(TEXT, BYTEA) FROM PUBLIC;
REVOKE ALL ON FUNCTION provision_assertion_key_retire(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION provision_actor(TEXT[]) TO daftar_platform;
GRANT EXECUTE ON FUNCTION provision_assertion_key_install(TEXT, BYTEA) TO daftar_platform;
GRANT EXECUTE ON FUNCTION provision_assertion_key_retire(TEXT) TO daftar_platform;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. The hand-over, each inside its owner's CREATE bracket.
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_catalog_internal;
ALTER FUNCTION catalog_identifiers_sync() OWNER TO daftar_catalog_internal;
REVOKE CREATE ON SCHEMA public FROM daftar_catalog_internal;

GRANT CREATE ON SCHEMA public TO daftar_provisioning_internal;
ALTER FUNCTION provision_actor(TEXT[]) OWNER TO daftar_provisioning_internal;
ALTER FUNCTION provision_assertion_key_install(TEXT, BYTEA) OWNER TO daftar_provisioning_internal;
ALTER FUNCTION provision_assertion_key_retire(TEXT) OWNER TO daftar_provisioning_internal;
REVOKE CREATE ON SCHEMA public FROM daftar_provisioning_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 5b. Every other SECURITY DEFINER routine in public: the same pinned path
--     (review I3). One DO block, so the set is discovered and altered
--     atomically; the accounting routines are altered AS their owner (the
--     deployer's membership there is INHERIT FALSE, SET TRUE), the platform
--     commands by the deployer's inherited platform membership.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  r        RECORD;
  v_found  TEXT[];
  c_expect CONSTANT TEXT[] := ARRAY[
    'accounting_assert_entry_valid(uuid,uuid):daftar_accounting_internal',
    'accounting_seed_chart(uuid):daftar_accounting_internal',
    'accounting_seed_chart_trg():daftar_accounting_internal',
    'accounting_validate_entry():daftar_accounting_internal',
    'accounting_validate_entry_of_line():daftar_accounting_internal',
    'businesses_base_currency_lock():daftar_accounting_internal',
    'provision_accept_invitation(text):daftar_platform',
    'provision_create_business(uuid,uuid,text,text,text,text,text,text,text[],text,jsonb,text):daftar_platform',
    'provision_create_tenant(uuid):daftar_platform',
    'provision_expire_invitation(uuid):daftar_platform',
    'provision_peek_invitation(text):daftar_platform',
    'provision_persist_operation(text,text,text,uuid,uuid):daftar_platform',
    'provision_replay_operation(text):daftar_platform'];
BEGIN
  SELECT pg_catalog.array_agg(pg_catalog.format('%s(%s):%s', p.proname, pg_catalog.replace(pg_catalog.oidvectortypes(p.proargtypes), ', ', ','),
                                                pg_catalog.pg_get_userbyid(p.proowner))
                              ORDER BY p.proname COLLATE "C")
    INTO v_found
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
   WHERE p.prosecdef
     AND p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
                       AND d.objid = p.oid AND d.deptype = 'e');
  IF v_found IS DISTINCT FROM c_expect THEN
    RAISE EXCEPTION 'authority.migration_precondition: the SECURITY DEFINER routines without the pinned path are %, not the thirteen 0070 re-pins', v_found;
  END IF;
  FOR r IN
    SELECT p.oid::pg_catalog.regprocedure AS fn, pg_catalog.pg_get_userbyid(p.proowner) AS owner
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
     WHERE p.prosecdef
       AND p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
                         AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    IF r.owner = 'daftar_accounting_internal' THEN
      SET LOCAL ROLE daftar_accounting_internal;
      EXECUTE pg_catalog.format('ALTER FUNCTION %s SET search_path = pg_catalog, public, pg_temp', r.fn);
      RESET ROLE;
    ELSE
      EXECUTE pg_catalog.format('ALTER FUNCTION %s SET search_path = pg_catalog, public, pg_temp', r.fn);
    END IF;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. 0070-E: refuse to commit unless the end state is exactly right.
--    Catalogue reads and has_*_privilege only, so a non-superuser migrator
--    runs it unchanged.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  r          RECORD;
  v_actual   TEXT[];
  v_detail   TEXT;
  v_role     TEXT;
  c_pinned   CONSTANT TEXT[] := ARRAY['search_path=pg_catalog, public, pg_temp'];
  c_runtime  CONSTANT TEXT[] := ARRAY['daftar_app', 'daftar_worker', 'daftar_identity', 'daftar_resolver', 'daftar_provisioner',
                                      'daftar_reconciler', 'public'];
  c_internal CONSTANT TEXT[] := ARRAY['daftar_catalog_internal', 'daftar_provisioning_internal'];
  c_writes   CONSTANT TEXT[] := ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
BEGIN
  -- (1) Owner, DEFINER and the pinned path, per routine.
  FOR r IN
    SELECT * FROM (VALUES
      ('catalog_identifiers_sync()'::regprocedure,                  'daftar_catalog_internal'),
      ('provision_actor(text[])'::regprocedure,                     'daftar_provisioning_internal'),
      ('provision_assertion_key_install(text,bytea)'::regprocedure, 'daftar_provisioning_internal'),
      ('provision_assertion_key_retire(text)'::regprocedure,        'daftar_provisioning_internal')) AS x(fn, owner)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = r.fn AND pg_get_userbyid(p.proowner) = r.owner
                     AND p.prosecdef AND p.proconfig IS NOT DISTINCT FROM c_pinned) THEN
      RAISE EXCEPTION 'authority.definer_invalid: % is not the % owned DEFINER with search_path pg_catalog, public, pg_temp', r.fn, r.owner;
    END IF;
  END LOOP;

  -- (1b) The normaliser the trigger calls pins the same path.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'catalog_identifier_norm(text,text)'::regprocedure
                   AND NOT p.prosecdef AND p.proconfig IS NOT DISTINCT FROM c_pinned) THEN
    RAISE EXCEPTION 'authority.definer_invalid: catalog_identifier_norm(text,text) does not pin search_path pg_catalog, public, pg_temp';
  END IF;
  SELECT array_agg(x.grantee::regrole::text || ':' || x.privilege_type || ':' || x.is_grantable::text ORDER BY 1) INTO v_actual
  FROM pg_proc p, aclexplode(p.proacl) x WHERE p.oid = 'catalog_identifier_norm(text,text)'::regprocedure AND x.grantee <> p.proowner;
  IF v_actual IS DISTINCT FROM ARRAY['daftar_catalog_internal:EXECUTE:false'] THEN
    RAISE EXCEPTION 'authority.definer_invalid: catalog_identifier_norm grantees are %, not the sync trigger''s owner alone', v_actual;
  END IF;

  -- (1c) The registry's policies: the 0037 pair plus the internal admission.
  IF (SELECT array_agg(pol.polname::text || ':' || pol.polcmd::text || ':' || pol.polpermissive::text || ':'
                       || (SELECT coalesce(string_agg(CASE WHEN x = 0 THEN 'public' ELSE pg_get_userbyid(x) END, ','), '') FROM unnest(pol.polroles) x)
                       ORDER BY pol.polname COLLATE "C")
        FROM pg_policy pol WHERE pol.polrelid = 'public.catalog_identifiers'::regclass)
     IS DISTINCT FROM ARRAY['business_isolation:*:false:public',
                            'catalog_internal_delete:d:true:daftar_catalog_internal',
                            'catalog_internal_insert:a:true:daftar_catalog_internal',
                            'catalog_internal_read:r:true:daftar_catalog_internal',
                            'tenant_membership:*:true:public']
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.catalog_identifiers'::regclass AND relrowsecurity AND relforcerowsecurity)
     OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.catalog_identifiers'::regclass AND polname = 'business_isolation'
                      AND pg_get_expr(polqual, polrelid) LIKE '%daftar_catalog_internal%app_business()%'
                      AND pg_get_expr(polwithcheck, polrelid) LIKE '%daftar_catalog_internal%app_business()%') THEN
    RAISE EXCEPTION 'authority.definer_invalid: catalog_identifiers policies are not exactly the 0037 pair plus the internal admission';
  END IF;

  -- (2) The ACLs, exactly: the trigger function has no grantee; the three
  --     provisioning routines one, daftar_platform, without grant option.
  SELECT array_agg(x.grantee::regrole::text ORDER BY 1) INTO v_actual
  FROM pg_proc p, aclexplode(p.proacl) x WHERE p.oid = 'catalog_identifiers_sync()'::regprocedure AND x.grantee <> p.proowner;
  IF v_actual IS NOT NULL THEN
    RAISE EXCEPTION 'authority.definer_invalid: catalog_identifiers_sync has an EXECUTE grantee: %', v_actual;
  END IF;
  FOR r IN SELECT unnest(ARRAY['provision_actor(text[])'::regprocedure, 'provision_assertion_key_install(text,bytea)'::regprocedure,
                               'provision_assertion_key_retire(text)'::regprocedure]) AS fn
  LOOP
    SELECT array_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END || ':' || x.privilege_type || ':' || x.is_grantable::text
                     ORDER BY 1) INTO v_actual
    FROM pg_proc p, aclexplode(p.proacl) x WHERE p.oid = r.fn AND x.grantee <> p.proowner;
    IF v_actual IS DISTINCT FROM ARRAY['daftar_platform:EXECUTE:false'] THEN
      RAISE EXCEPTION 'authority.definer_invalid: % must be executable by daftar_platform only, found %', r.fn, v_actual;
    END IF;
  END LOOP;
  FOREACH v_role IN ARRAY c_runtime LOOP
    IF has_function_privilege(v_role, 'catalog_identifiers_sync()', 'EXECUTE')
       OR has_function_privilege(v_role, 'provision_actor(text[])', 'EXECUTE')
       OR has_function_privilege(v_role, 'provision_assertion_key_install(text,bytea)', 'EXECUTE')
       OR has_function_privilege(v_role, 'provision_assertion_key_retire(text)', 'EXECUTE') THEN
      RAISE EXCEPTION 'authority.definer_invalid: % may execute a TD-18 routine', v_role;
    END IF;
  END LOOP;

  -- (3) The two triggers still run the sync function, and only they do.
  SELECT array_agg((c.relname || '.' || g.tgname) COLLATE "C" ORDER BY (c.relname || '.' || g.tgname) COLLATE "C") INTO v_actual
  FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
  WHERE g.tgfoid = 'catalog_identifiers_sync()'::regprocedure AND NOT g.tgisinternal AND g.tgenabled = 'O';
  IF v_actual IS DISTINCT FROM ARRAY['product_variants.product_variants_identifiers_sync', 'products.products_identifiers_sync'] THEN
    RAISE EXCEPTION 'authority.definer_invalid: the identifier sync triggers are not the two 0037 triggers, found %', v_actual;
  END IF;

  -- (4) Each owner's table surface is exactly section 2's.
  SELECT string_agg(c.relname::text || ':' || p || ':' || g.role, ', ' ORDER BY 1) INTO v_detail
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  CROSS JOIN unnest(ARRAY['SELECT'] || c_writes) AS p
  CROSS JOIN unnest(c_internal) AS g(role)
  WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f')
    AND (has_table_privilege(g.role, c.oid, p)
         OR (p IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') AND has_any_column_privilege(g.role, c.oid, p)))
    AND (g.role, c.relname::text, p) NOT IN (
          ('daftar_catalog_internal', 'catalog_identifiers', 'SELECT'), ('daftar_catalog_internal', 'catalog_identifiers', 'INSERT'),
          ('daftar_catalog_internal', 'catalog_identifiers', 'DELETE'), ('daftar_catalog_internal', 'businesses', 'SELECT'),
          ('daftar_provisioning_internal', 'provisioning_assertion_keys', 'SELECT'),
          ('daftar_provisioning_internal', 'provisioning_assertion_keys', 'INSERT'),
          ('daftar_provisioning_internal', 'provisioning_assertion_keys', 'UPDATE'),
          ('daftar_provisioning_internal', 'provisioning_assertion_uses', 'SELECT'),
          ('daftar_provisioning_internal', 'provisioning_assertion_uses', 'INSERT'),
          ('daftar_provisioning_internal', 'provisioning_assertion_uses', 'DELETE'));
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'authority.definer_invalid: an internal owner holds a privilege 0070 does not grant: %', v_detail;
  END IF;
  IF has_table_privilege('daftar_catalog_internal', 'public.businesses', 'SELECT')
     OR (SELECT array_agg(a.attname::text ORDER BY 1) FROM pg_attribute a
          WHERE a.attrelid = 'public.businesses'::regclass AND a.attnum > 0 AND NOT a.attisdropped
            AND has_column_privilege('daftar_catalog_internal', 'public.businesses'::regclass, a.attnum, 'SELECT'))
        IS DISTINCT FROM ARRAY['id', 'tenant_id'] THEN
    RAISE EXCEPTION 'authority.definer_invalid: daftar_catalog_internal must read exactly businesses.id and businesses.tenant_id';
  END IF;

  -- (5) Neither owner keeps CREATE on public or holds TEMPORARY.
  FOREACH v_role IN ARRAY c_internal LOOP
    IF has_schema_privilege(v_role, 'public', 'CREATE') OR has_database_privilege(v_role, current_database(), 'TEMPORARY') THEN
      RAISE EXCEPTION 'authority.definer_invalid: % may create in public or in a temporary schema', v_role;
    END IF;
  END LOOP;

  -- (6) TD-18 itself: the principal applying this file owns no SECURITY
  --     DEFINER routine in public (extensions' own functions aside), so no
  --     routine's security depends on who applied the history.
  SELECT array_agg(p.oid::regprocedure::text ORDER BY 1) INTO v_actual
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE p.prosecdef AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e');
  IF v_actual IS NOT NULL THEN
    RAISE EXCEPTION 'authority.definer_invalid: the applier % still owns SECURITY DEFINER routine(s): %', current_user, v_actual;
  END IF;

  -- (7) Review I3: EVERY SECURITY DEFINER routine in public (extensions'
  --     own aside) pins exactly pg_catalog, public, pg_temp — pg_catalog
  --     before public, pg_temp named and last — and no other setting.
  SELECT array_agg(p.oid::regprocedure::text || ' ' || coalesce(p.proconfig::text, 'no path') ORDER BY 1) INTO v_actual
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE p.prosecdef AND p.proconfig IS DISTINCT FROM c_pinned
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e');
  IF v_actual IS NOT NULL THEN
    RAISE EXCEPTION 'authority.definer_invalid: SECURITY DEFINER routine(s) without the pinned path pg_catalog, public, pg_temp: %', v_actual;
  END IF;
END $$;
