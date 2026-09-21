-- 0033_provisioner_atomic_authority.sql
-- Phase 1 Completion Directive §10–14: AUTHORIZATION + MUTATION ARE ATOMIC.
--
-- 0032 delegated provisioning to narrow SECURITY DEFINER commands, but left
-- create-business as TWO commands: provision_assert_tenant_owner() followed
-- by provision_create_business(). A credential that can EXECUTE the mutation
-- could simply skip the assert. Likewise the actor was a plain parameter
-- (p_user_id / p_actor_user_id) that the caller chose freely.
--
-- After this migration:
--   * The ACTOR is server-derived: the API sets the transaction-local GUC
--     app.actor_user_id from the authenticated principal, and every command
--     reads it via provision_actor(). No command takes a user id parameter.
--   * Every sensitive command verifies the actor's authority INSIDE the same
--     trusted boundary before it mutates anything:
--       - provision_create_business: actor must be an ACTIVE tenant_owner of
--         the target tenant (initial onboarding satisfies this because
--         provision_create_tenant just minted that membership for the actor).
--       - provision_accept_invitation: the actor's identity email must match
--         the invitation's addressee and the actor must be an active user.
--       - replay/persist idempotency records are keyed by the actor only.
--   * provision_assert_tenant_owner() is DROPPED — there is no separable
--     assert command any more.
-- Frozen migrations are untouched (Directive §51).

-- ── Server-derived actor ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION provision_actor() RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = public, pg_catalog AS $$
DECLARE
  v_raw text;
BEGIN
  v_raw := current_setting('app.actor_user_id', true);
  IF v_raw IS NULL OR v_raw = '' THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Provisioning requires a server-derived actor context';
  END IF;
  BEGIN
    RETURN v_raw::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Provisioning actor context is malformed';
  END;
END;
$$;
REVOKE ALL ON FUNCTION provision_actor() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION provision_actor() TO daftar_platform;

-- ── Retire the 0032 signatures (separable assert + caller-chosen actor) ──
DROP FUNCTION IF EXISTS provision_assert_tenant_owner(uuid, uuid);
DROP FUNCTION IF EXISTS provision_create_tenant(uuid, uuid);
DROP FUNCTION IF EXISTS provision_create_business(uuid, uuid, uuid, text, text, text, text, text, text, text[], text, jsonb, text, uuid);
DROP FUNCTION IF EXISTS provision_accept_invitation(text, uuid);
DROP FUNCTION IF EXISTS provision_replay_operation(uuid, text);
DROP FUNCTION IF EXISTS provision_persist_operation(uuid, text, text, text, uuid, uuid);

-- ── Idempotency records: keyed by the server-derived actor ─────────────────
CREATE OR REPLACE FUNCTION provision_replay_operation(p_key text)
RETURNS TABLE(kind text, payload_hash text, result_tenant_id uuid, result_business_id uuid, result_store_slug text)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog AS $$
  SELECT op.kind, op.payload_hash, op.result_tenant_id, op.result_business_id, b.store_slug
  FROM onboarding_operations op
  LEFT JOIN businesses b ON b.id = op.result_business_id
  WHERE op.user_id = provision_actor() AND op.idempotency_key = p_key
$$;

CREATE OR REPLACE FUNCTION provision_persist_operation(
  p_key text, p_kind text, p_payload_hash text, p_tenant_id uuid, p_business_id uuid
) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  INSERT INTO onboarding_operations (user_id, idempotency_key, kind, payload_hash, result_tenant_id, result_business_id)
  VALUES (provision_actor(), p_key, p_kind, p_payload_hash, p_tenant_id, p_business_id)
$$;

-- ── Initial onboarding #1: tenant + tenant_owner membership for the ACTOR ──
CREATE OR REPLACE FUNCTION provision_create_tenant(p_tenant_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  v_actor uuid := provision_actor();
BEGIN
  -- The actor must be a real, active identity — the provisioner cannot read
  -- users itself; this check runs inside the trusted boundary.
  PERFORM 1 FROM users WHERE id = v_actor AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Actor is not an active user';
  END IF;
  INSERT INTO tenants (id) VALUES (p_tenant_id);
  INSERT INTO tenant_memberships (tenant_id, user_id, role_key)
  VALUES (p_tenant_id, v_actor, 'tenant_owner');
END;
$$;

-- ── Business creation: AUTHORITY CHECK + MUTATION in ONE command ───────────
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
  p_role_permissions jsonb,      -- {"owner":[...],"manager":[...],"cashier":[...]}
  p_audit_action text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  v_actor uuid := provision_actor();
  v_key text;
  v_perms jsonb;
  v_role_id uuid;
  v_owner_role uuid;
  v_branch_id uuid;
BEGIN
  -- §11: the ONLY authority for creating a business in a tenant is an ACTIVE
  -- tenant_owner of EXACTLY that tenant. Checked here, in the same trusted
  -- boundary as the mutation — it cannot be skipped by calling this command
  -- directly with the provisioner credential.
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

  -- The business owner is the ACTOR — never a caller-supplied user id.
  INSERT INTO memberships (tenant_id, business_id, user_id, status, joined_at)
  VALUES (p_tenant_id, p_business_id, v_actor, 'active', now());
  INSERT INTO membership_roles (business_id, user_id, role_id)
  VALUES (p_business_id, v_actor, v_owner_role);

  -- Trial entitlement: free plan, latest PUBLISHED version, versioned trial days.
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

-- ── Invitation acceptance: addressee check + transition in ONE command ─────
CREATE OR REPLACE FUNCTION provision_accept_invitation(p_token_hash text)
RETURNS TABLE(o_invitation_id uuid, o_business_id uuid, o_tenant_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  v_actor uuid := provision_actor();
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

  -- §11–12: the invitation may ONLY be accepted by the active identity it was
  -- addressed to. Verified inside the boundary, against the identity table the
  -- provisioner itself cannot read.
  SELECT u.email::text INTO v_actor_email FROM users u WHERE u.id = v_actor AND u.status = 'active';
  IF v_actor_email IS NULL THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Actor is not an active user';
  END IF;
  IF lower(v_actor_email) <> lower(v_inv.email) THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Invitation is addressed to a different email';
  END IF;

  -- Reservation conversion FIRST: the accepted invitation releases its slot.
  UPDATE business_invitations
  SET status = 'accepted', accepted_by = v_actor, responded_at = now()
  WHERE id = v_inv.id;

  SELECT b.tenant_id INTO v_tenant FROM businesses b WHERE b.id = v_inv.business_id;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'PROV:BUSINESS_NOT_FOUND:Business not found';
  END IF;

  -- MAX_USERS quota (mirrors EntitlementService.assertCanConsume exactly):
  -- serialized per (business, limit); effective state gates; override wins;
  -- usage = active members + valid pending invitations; usage + 1 > limit fails.
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

  -- Tenant membership FIRST (WAVE 3 invariant).
  INSERT INTO tenant_memberships (tenant_id, user_id, role_key)
  VALUES (v_tenant, v_actor, 'tenant_member')
  ON CONFLICT (tenant_id, user_id) DO NOTHING;

  -- Membership state machine on accept (WAVE 1/4): no resurrection.
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
    -- removed: purge ALL previous authority, then re-add fresh.
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

-- ── Ownership + EXECUTE grants for the new signatures ──────────────────────
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
