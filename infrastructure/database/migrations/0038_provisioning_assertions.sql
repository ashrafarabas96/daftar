-- 0038_provisioning_assertions.sql
-- Final Release Blocker 1 — PROVISIONER ACTOR SPOOFING.
--
-- 0033 derived the actor from the transaction-local GUC app.actor_user_id.
-- A GUC is caller-controlled: a connection holding the daftar_provisioner
-- credential can `set_config('app.actor_user_id', <victim owner uuid>)` and
-- then EXECUTE provision_create_business() against the victim's tenant. The
-- GUC was never authentication proof.
--
-- After this migration the actor is carried by a PROVISIONING ASSERTION that
-- the caller cannot forge:
--
--   v1.<kid>.<actor uuid>.<kind>.<expires epoch s>.<jti uuid>.<hmac-sha256 hex>
--
-- The HMAC key lives in provisioning_assertion_keys, a table that NO runtime
-- role can read (no grants at all — not daftar_provisioner, not daftar_app,
-- not daftar_platform). Only provision_actor(), a SECURITY DEFINER function
-- owned by the schema owner (the migrator), reads it. The merchant API holds
-- the same key (PROVISIONING_ASSERTION_KEY) and mints an assertion for the
-- authenticated principal per provisioning transaction.
--
-- Trust model:
--   * daftar_provisioner alone (credential compromise): can EXECUTE the
--     commands but cannot mint an assertion → every command raises
--     PROV:FORBIDDEN. It also cannot read or install keys.
--   * merchant API process compromise (DB credential + assertion key): equals
--     the API's own authority, which is the inherent floor of any design where
--     the API provisions on behalf of authenticated users.
--   * an assertion captured in flight is bound to ONE operation kind, expires
--     within its TTL and is SINGLE-USE per transaction (jti registry), so it
--     cannot be replayed for a second business/acceptance.
--
-- The authority checks of 0033 (active tenant_owner of EXACTLY the target
-- tenant; invitation addressee match; actor-scoped idempotency) stay inside
-- the same SECURITY DEFINER commands — authorization and mutation remain one
-- atomic unit; only the actor DERIVATION changed.
--
-- Frozen migrations are untouched (Directive §51).

-- ── Key registry: readable by NOBODY except provision_actor() ──────────────
CREATE TABLE provisioning_assertion_keys (
  kid        TEXT PRIMARY KEY CHECK (kid ~ '^[A-Za-z0-9_-]{1,32}$'),
  secret     BYTEA NOT NULL CHECK (octet_length(secret) >= 32),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
REVOKE ALL ON provisioning_assertion_keys FROM PUBLIC;

-- ── Single-use registry: an assertion (jti) is bound to the FIRST transaction that uses it ──
CREATE TABLE provisioning_assertion_uses (
  jti     UUID PRIMARY KEY,
  xact    XID8 NOT NULL,
  used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
REVOKE ALL ON provisioning_assertion_uses FROM PUBLIC;

-- ── Key management: platform principal only (ops job under BOOTSTRAP_DATABASE_URL) ──
CREATE OR REPLACE FUNCTION provision_assertion_key_install(p_kid TEXT, p_secret BYTEA) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  IF p_secret IS NULL OR octet_length(p_secret) < 32 THEN
    RAISE EXCEPTION 'PROV:INVALID_KEY:provisioning assertion key must be at least 32 bytes';
  END IF;
  INSERT INTO provisioning_assertion_keys (kid, secret, status) VALUES (p_kid, p_secret, 'active')
  ON CONFLICT (kid) DO UPDATE SET secret = EXCLUDED.secret, status = 'active';
END;
$$;
CREATE OR REPLACE FUNCTION provision_assertion_key_retire(p_kid TEXT) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  UPDATE provisioning_assertion_keys SET status = 'retired' WHERE kid = p_kid
$$;
REVOKE ALL ON FUNCTION provision_assertion_key_install(TEXT, BYTEA) FROM PUBLIC;
REVOKE ALL ON FUNCTION provision_assertion_key_retire(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION provision_assertion_key_install(TEXT, BYTEA) TO daftar_platform;
GRANT EXECUTE ON FUNCTION provision_assertion_key_retire(TEXT) TO daftar_platform;

-- ── The server-derived actor: verify the assertion, never trust a GUC ──────
DROP FUNCTION IF EXISTS provision_actor();

CREATE OR REPLACE FUNCTION provision_actor(p_allowed_kinds TEXT[]) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
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
  v_raw := current_setting('app.provisioning_assertion', true);
  IF v_raw IS NULL OR v_raw = '' THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Provisioning requires a server-minted assertion';
  END IF;
  v_parts := string_to_array(v_raw, '.');
  IF array_length(v_parts, 1) <> 7 OR v_parts[1] <> 'v1' THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Provisioning assertion is malformed';
  END IF;

  SELECT k.secret INTO v_secret FROM provisioning_assertion_keys k WHERE k.kid = v_parts[2] AND k.status = 'active';
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Provisioning assertion key is unknown or retired';
  END IF;

  -- Signature over every claim (version, kid, actor, kind, exp, jti).
  v_expected := encode(hmac(convert_to(array_to_string(v_parts[1:6], '.'), 'UTF8'), v_secret, 'sha256'), 'hex');
  IF length(v_parts[7]) <> 64 OR v_expected <> lower(v_parts[7]) THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Provisioning assertion signature is invalid';
  END IF;

  BEGIN
    v_actor := v_parts[3]::uuid;
    v_exp   := v_parts[5]::bigint;
    v_jti   := v_parts[6]::uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Provisioning assertion claims are malformed';
  END;

  IF v_exp <= extract(epoch FROM now())::bigint THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Provisioning assertion has expired';
  END IF;
  IF NOT (v_parts[4] = ANY (p_allowed_kinds)) THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Provisioning assertion was minted for a different operation (%)', v_parts[4];
  END IF;

  -- Single use: the jti belongs to the first transaction that presents it.
  INSERT INTO provisioning_assertion_uses (jti, xact) VALUES (v_jti, pg_current_xact_id())
  ON CONFLICT (jti) DO NOTHING;
  SELECT u.xact INTO v_xact FROM provisioning_assertion_uses u WHERE u.jti = v_jti;
  IF v_xact <> pg_current_xact_id() THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Provisioning assertion was already used';
  END IF;
  -- Opportunistic hygiene: expired jtis are useless after the longest TTL.
  DELETE FROM provisioning_assertion_uses WHERE used_at < now() - interval '1 hour';

  RETURN v_actor;
END;
$$;
REVOKE ALL ON FUNCTION provision_actor(TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION provision_actor(TEXT[]) TO daftar_platform;

-- ── Re-issue the provisioning commands against the verified actor ──────────
-- Bodies are those of 0033 with ONE change each: provision_actor(<kinds>).
-- CREATE OR REPLACE keeps the 0033 ownership (daftar_platform) and grants
-- (EXECUTE → daftar_provisioner only).

CREATE OR REPLACE FUNCTION provision_replay_operation(p_key text)
RETURNS TABLE(kind text, payload_hash text, result_tenant_id uuid, result_business_id uuid, result_store_slug text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  -- Derived FIRST, unconditionally: a volatile call inside WHERE would only
  -- run per candidate row and be skipped entirely for an unknown key.
  v_actor uuid := provision_actor(ARRAY['onboarding', 'create_business']);
BEGIN
  RETURN QUERY
  SELECT op.kind, op.payload_hash, op.result_tenant_id, op.result_business_id, b.store_slug
  FROM onboarding_operations op
  LEFT JOIN businesses b ON b.id = op.result_business_id
  WHERE op.user_id = v_actor AND op.idempotency_key = p_key;
END;
$$;

CREATE OR REPLACE FUNCTION provision_persist_operation(
  p_key text, p_kind text, p_payload_hash text, p_tenant_id uuid, p_business_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  v_actor uuid := provision_actor(ARRAY['onboarding', 'create_business']);
BEGIN
  INSERT INTO onboarding_operations (user_id, idempotency_key, kind, payload_hash, result_tenant_id, result_business_id)
  VALUES (v_actor, p_key, p_kind, p_payload_hash, p_tenant_id, p_business_id);
END;
$$;

CREATE OR REPLACE FUNCTION provision_create_tenant(p_tenant_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  v_actor uuid := provision_actor(ARRAY['onboarding']);
BEGIN
  PERFORM 1 FROM users WHERE id = v_actor AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Actor is not an active user';
  END IF;
  INSERT INTO tenants (id) VALUES (p_tenant_id);
  INSERT INTO tenant_memberships (tenant_id, user_id, role_key)
  VALUES (p_tenant_id, v_actor, 'tenant_owner');
END;
$$;

CREATE OR REPLACE FUNCTION provision_create_business(
  p_tenant_id uuid,
  p_business_id uuid,
  p_name text,
  p_slug text,
  p_country_code text,
  p_base_currency text,
  p_industry_profile_key text,
  p_locale text,
  p_enabled_locales text[],
  p_timezone text,
  p_role_permissions jsonb,
  p_audit_action text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  v_actor uuid := provision_actor(ARRAY['onboarding', 'create_business']);
  v_key text;
  v_perms jsonb;
  v_role_id uuid;
  v_owner_role uuid;
  v_branch_id uuid;
BEGIN
  PERFORM 1 FROM tenant_memberships
  WHERE user_id = v_actor AND tenant_id = p_tenant_id
    AND role_key = 'tenant_owner' AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Only an active tenant owner of this tenant can create a business in it';
  END IF;

  IF EXISTS (SELECT 1 FROM reserved_store_slugs WHERE slug = p_slug) THEN
    RAISE EXCEPTION 'PROV:SLUG_RESERVED:This store slug is reserved';
  END IF;

  INSERT INTO businesses (id, tenant_id, name, store_slug, country_code, base_currency,
    industry_profile_key, default_locale, enabled_locales, timezone, storefront_locale)
  VALUES (p_business_id, p_tenant_id, p_name, p_slug, p_country_code, p_base_currency,
    p_industry_profile_key, p_locale, p_enabled_locales, p_timezone, p_locale);

  FOR v_key, v_perms IN SELECT e.key, e.value FROM jsonb_each(p_role_permissions) e LOOP
    v_role_id := gen_random_uuid();
    INSERT INTO business_roles (business_id, id, key, name, is_system)
    VALUES (p_business_id, v_role_id, v_key, v_key, v_key = 'owner');
    INSERT INTO role_permissions (business_id, role_id, permission)
    SELECT p_business_id, v_role_id, jsonb_array_elements_text(v_perms);
    IF v_key = 'owner' THEN v_owner_role := v_role_id; END IF;
  END LOOP;
  IF v_owner_role IS NULL THEN
    RAISE EXCEPTION 'PROV:INTERNAL:owner role template missing';
  END IF;

  INSERT INTO memberships (tenant_id, business_id, user_id, status, joined_at)
  VALUES (p_tenant_id, p_business_id, v_actor, 'active', now());
  INSERT INTO membership_roles (business_id, user_id, role_id)
  VALUES (p_business_id, v_actor, v_owner_role);

  INSERT INTO business_entitlements (business_id, plan_version_id, state, trial_ends_at)
  SELECT p_business_id, pv.id, 'trial', now() + make_interval(days => pv.trial_days)
  FROM plan_versions pv
  WHERE pv.plan_key = 'free' AND pv.state = 'PUBLISHED'
  ORDER BY pv.version DESC LIMIT 1;

  INSERT INTO branches (business_id, id, name, is_default)
  VALUES (p_business_id, gen_random_uuid(), 'Main', true)
  RETURNING id INTO v_branch_id;
  INSERT INTO warehouses (business_id, id, branch_id, name, is_default)
  VALUES (p_business_id, gen_random_uuid(), v_branch_id, 'Main warehouse', true);

  INSERT INTO outbox_events (tenant_id, business_id, type, payload)
  VALUES (p_tenant_id, p_business_id, 'business.created',
    jsonb_build_object('businessId', p_business_id, 'tenantId', p_tenant_id,
      'storeSlug', p_slug, 'countryCode', p_country_code, 'baseCurrency', p_base_currency));

  INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id)
  VALUES (p_tenant_id, p_business_id, v_actor, p_audit_action, 'business', p_business_id);
END;
$$;

CREATE OR REPLACE FUNCTION provision_accept_invitation(p_token_hash text)
RETURNS TABLE(o_invitation_id uuid, o_business_id uuid, o_tenant_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  v_actor uuid := provision_actor(ARRAY['accept_invitation']);
  v_inv record;
  v_actor_email text;
  v_tenant uuid;
  v_member_status text;
  v_eff_state text;
  v_limit bigint;
  v_usage bigint;
BEGIN
  SELECT i.id, i.business_id, i.role_id, i.invited_by, i.email::text AS email
  INTO v_inv
  FROM business_invitations i
  WHERE i.token_hash = p_token_hash AND i.status = 'pending'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROV:INVITATION_NOT_FOUND:Invitation not found';
  END IF;

  SELECT u.email::text INTO v_actor_email FROM users u WHERE u.id = v_actor AND u.status = 'active';
  IF v_actor_email IS NULL THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Actor is not an active user';
  END IF;
  IF lower(v_actor_email) <> lower(v_inv.email) THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Invitation is addressed to a different email';
  END IF;

  UPDATE business_invitations
  SET status = 'accepted', accepted_by = v_actor, responded_at = now()
  WHERE id = v_inv.id;

  SELECT b.tenant_id INTO v_tenant FROM businesses b WHERE b.id = v_inv.business_id;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'PROV:BUSINESS_NOT_FOUND:Business not found';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(v_inv.business_id::text), hashtext('MAX_USERS'));
  SELECT CASE
    WHEN be.state = 'trial' AND be.trial_ends_at IS NOT NULL AND be.trial_ends_at <= now() THEN 'expired'
    WHEN be.state = 'cancel_at_period_end' AND be.period_ends_at IS NOT NULL AND be.period_ends_at <= now() THEN 'cancelled'
    WHEN be.state = 'grace_period' AND be.period_ends_at IS NOT NULL AND be.period_ends_at <= now() THEN 'past_due'
    ELSE be.state END
  INTO v_eff_state
  FROM business_entitlements be WHERE be.business_id = v_inv.business_id;
  IF v_eff_state IS NULL OR v_eff_state NOT IN ('trial','active','grace_period','past_due','complimentary') THEN
    v_limit := 0;
  ELSE
    SELECT COALESCE(
      (SELECT eo.limit_value FROM entitlement_overrides eo
       WHERE eo.business_id = v_inv.business_id AND eo.limit_key = 'MAX_USERS' AND eo.revoked_at IS NULL
         AND eo.starts_at <= now() AND (eo.ends_at IS NULL OR eo.ends_at > now())
       ORDER BY eo.created_at DESC LIMIT 1),
      (SELECT pl.limit_value FROM business_entitlements be2
       JOIN plan_limits pl ON pl.plan_version_id = be2.plan_version_id
       WHERE be2.business_id = v_inv.business_id AND pl.limit_key = 'MAX_USERS'),
      0
    ) INTO v_limit;
  END IF;
  IF v_limit <> -1 THEN
    SELECT (SELECT count(*) FROM memberships m WHERE m.business_id = v_inv.business_id AND m.status = 'active')
         + (SELECT count(*) FROM business_invitations bi
            WHERE bi.business_id = v_inv.business_id AND bi.status = 'pending' AND bi.expires_at > now())
    INTO v_usage;
    IF v_usage + 1 > v_limit THEN
      RAISE EXCEPTION 'PROV:PLAN_LIMIT_EXCEEDED:Plan limit reached';
    END IF;
  END IF;

  INSERT INTO tenant_memberships (tenant_id, user_id, role_key)
  VALUES (v_tenant, v_actor, 'tenant_member')
  ON CONFLICT (tenant_id, user_id) DO NOTHING;

  SELECT m.status INTO v_member_status
  FROM memberships m
  WHERE m.business_id = v_inv.business_id AND m.user_id = v_actor
  FOR UPDATE;
  IF FOUND THEN
    IF v_member_status IN ('active','invited') THEN
      RAISE EXCEPTION 'PROV:ALREADY_MEMBER:User is already a member';
    END IF;
    IF v_member_status = 'suspended' THEN
      RAISE EXCEPTION 'PROV:MEMBER_SUSPENDED:Member is suspended — use the reactivate command';
    END IF;
    DELETE FROM membership_roles WHERE business_id = v_inv.business_id AND user_id = v_actor;
    DELETE FROM member_branch_scopes WHERE business_id = v_inv.business_id AND user_id = v_actor;
    UPDATE memberships
    SET status = 'active', disabled_at = NULL, branch_scope_mode = 'all',
        invited_by = v_inv.invited_by, joined_at = now(), updated_at = now()
    WHERE business_id = v_inv.business_id AND user_id = v_actor;
  ELSE
    INSERT INTO memberships (tenant_id, business_id, user_id, status, invited_by, joined_at)
    VALUES (v_tenant, v_inv.business_id, v_actor, 'active', v_inv.invited_by, now());
  END IF;

  INSERT INTO membership_roles (business_id, user_id, role_id)
  VALUES (v_inv.business_id, v_actor, v_inv.role_id);

  INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id)
  VALUES (v_tenant, v_inv.business_id, v_actor, 'structure.invitation_accepted', 'invitation', v_inv.id);

  o_invitation_id := v_inv.id;
  o_business_id := v_inv.business_id;
  o_tenant_id := v_tenant;
  RETURN NEXT;
END;
$$;

-- Ownership + grants are unchanged by CREATE OR REPLACE, but state them once
-- more so a reader of THIS file sees the complete boundary.
DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'provision_replay_operation(text)',
    'provision_persist_operation(text,text,text,uuid,uuid)',
    'provision_create_tenant(uuid)',
    'provision_create_business(uuid,uuid,text,text,text,text,text,text,text[],text,jsonb,text)',
    'provision_accept_invitation(text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO daftar_platform', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO daftar_provisioner', f);
  END LOOP;
END $$;
