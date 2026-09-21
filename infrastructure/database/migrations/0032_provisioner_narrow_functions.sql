-- 0032_provisioner_narrow_functions.sql
-- Ultimate Closure §15–21 (CRITICAL): daftar_provisioner is REMOVED from the
-- global app_bypass(). No runtime role except the platform administrative
-- principal may bypass RLS. Provisioning authority is delegated through
-- NARROW SECURITY DEFINER functions owned by daftar_platform — the bypass
-- applies only INSIDE those functions, each of which performs exactly one
-- provisioning command with typed parameters and domain invariants enforced.
--
-- Provisioner after this migration:
--   - NO table CRUD (except: SELECT reserved_store_slugs — a global,
--     non-tenant lookup directory; onboarding_operations/audit/outbox go
--     through functions below).
--   - EXECUTE on exactly the provisioning commands it needs.
--   - Direct cross-tenant reads/writes are impossible (RLS + no grants).

-- §16: the ONLY approved global bypass is the platform administrative principal.
CREATE OR REPLACE FUNCTION app_bypass() RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT current_user = 'daftar_platform'
$$;

-- ── Revoke the 0030/0031 broad grant surface ──────────────────────────────
REVOKE ALL ON tenants, tenant_memberships, businesses, business_roles,
  role_permissions, memberships, membership_roles, branches, warehouses,
  member_branch_scopes, plans, plan_versions, plan_limits, plan_entitlements,
  business_entitlements, onboarding_operations, business_invitations,
  audit_events, outbox_events, entitlement_overrides
FROM daftar_provisioner;
-- What remains intentionally: SELECT on reserved_store_slugs (global lookup
-- directory with NO tenant data — same visibility the resolver role has).

-- ── Provisioning commands (SECURITY DEFINER, owned by daftar_platform) ────
-- §19 safety: pinned search_path, typed parameters, PUBLIC EXECUTE revoked,
-- actor context passed from the server (never a client-supplied flag),
-- domain invariants enforced inside, no dynamic SQL / no query tunnel.

-- Idempotency replay lookup (initial onboarding / create-business).
CREATE OR REPLACE FUNCTION provision_replay_operation(p_user_id uuid, p_key text)
RETURNS TABLE(kind text, payload_hash text, result_tenant_id uuid, result_business_id uuid, result_store_slug text)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog AS $$
  SELECT op.kind, op.payload_hash, op.result_tenant_id, op.result_business_id, b.store_slug
  FROM onboarding_operations op
  LEFT JOIN businesses b ON b.id = op.result_business_id
  WHERE op.user_id = p_user_id AND op.idempotency_key = p_key
$$;

CREATE OR REPLACE FUNCTION provision_persist_operation(
  p_user_id uuid, p_key text, p_kind text, p_payload_hash text,
  p_tenant_id uuid, p_business_id uuid
) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  INSERT INTO onboarding_operations (user_id, idempotency_key, kind, payload_hash, result_tenant_id, result_business_id)
  VALUES (p_user_id, p_key, p_kind, p_payload_hash, p_tenant_id, p_business_id)
$$;

-- Initial onboarding command #1: create the tenant + its owner membership.
CREATE OR REPLACE FUNCTION provision_create_tenant(p_tenant_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  INSERT INTO tenants (id) VALUES (p_tenant_id);
  INSERT INTO tenant_memberships (tenant_id, user_id, role_key)
  VALUES (p_tenant_id, p_user_id, 'tenant_owner');
END;
$$;

-- Create-business gate: caller must be an ACTIVE tenant_owner of the target.
CREATE OR REPLACE FUNCTION provision_assert_tenant_owner(p_tenant_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  PERFORM 1 FROM tenant_memberships
  WHERE user_id = p_user_id AND tenant_id = p_tenant_id
    AND role_key = 'tenant_owner' AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROV:FORBIDDEN:Only an active tenant owner of this tenant can create a business in it';
  END IF;
END;
$$;

-- Provisioning command #2: business + system roles + owner membership +
-- trial entitlement + default structure + outbox + audit, atomically.
CREATE OR REPLACE FUNCTION provision_create_business(
  p_tenant_id uuid,
  p_user_id uuid,
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
  p_audit_action text,
  p_actor_user_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  v_key text;
  v_perms jsonb;
  v_role_id uuid;
  v_owner_role uuid;
  v_branch_id uuid;
BEGIN
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
  VALUES (p_tenant_id, p_business_id, p_user_id, 'active', now());
  INSERT INTO membership_roles (business_id, user_id, role_id)
  VALUES (p_business_id, p_user_id, v_owner_role);

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
  VALUES (p_tenant_id, p_business_id, p_actor_user_id, p_audit_action, 'business', p_business_id);
END;
$$;

-- Invitation acceptance, step 1 (lock-free): resolve by token hash.
CREATE OR REPLACE FUNCTION provision_peek_invitation(p_token_hash text)
RETURNS TABLE(id uuid, email text, expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog AS $$
  SELECT id, email::text, expires_at FROM business_invitations
  WHERE token_hash = p_token_hash AND status = 'pending'
$$;

-- Expiry is a committed state transition of its own.
CREATE OR REPLACE FUNCTION provision_expire_invitation(p_invitation_id uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  UPDATE business_invitations SET status = 'expired', responded_at = now()
  WHERE id = p_invitation_id AND status = 'pending'
$$;

-- Invitation acceptance, step 2 (atomic cross-scope transition):
-- lock → convert reservation → quota → tenant member → membership state
-- machine (no resurrection of historical authority) → role → audit.
CREATE OR REPLACE FUNCTION provision_accept_invitation(p_token_hash text, p_user_id uuid)
RETURNS TABLE(o_invitation_id uuid, o_business_id uuid, o_tenant_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  v_inv record;
  v_tenant uuid;
  v_member_status text;
  v_eff_state text;
  v_limit bigint;
  v_usage bigint;
BEGIN
  SELECT i.id, i.business_id, i.role_id, i.invited_by
  INTO v_inv
  FROM business_invitations i
  WHERE i.token_hash = p_token_hash AND i.status = 'pending'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROV:INVITATION_NOT_FOUND:Invitation not found';
  END IF;

  -- Reservation conversion FIRST: the accepted invitation releases its slot.
  UPDATE business_invitations
  SET status = 'accepted', accepted_by = p_user_id, responded_at = now()
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
  VALUES (v_tenant, p_user_id, 'tenant_member')
  ON CONFLICT (tenant_id, user_id) DO NOTHING;

  -- Membership state machine on accept (WAVE 1/4): no resurrection.
  SELECT m.status INTO v_member_status
  FROM memberships m
  WHERE m.business_id = v_inv.business_id AND m.user_id = p_user_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_member_status IN ('active','invited') THEN
      RAISE EXCEPTION 'PROV:ALREADY_MEMBER:User is already a member';
    END IF;
    IF v_member_status = 'suspended' THEN
      RAISE EXCEPTION 'PROV:MEMBER_SUSPENDED:Member is suspended — use the reactivate command';
    END IF;
    -- removed: purge ALL previous authority, then re-add fresh.
    DELETE FROM membership_roles WHERE business_id = v_inv.business_id AND user_id = p_user_id;
    DELETE FROM member_branch_scopes WHERE business_id = v_inv.business_id AND user_id = p_user_id;
    UPDATE memberships
    SET status = 'active', disabled_at = NULL, branch_scope_mode = 'all',
        invited_by = v_inv.invited_by, joined_at = now(), updated_at = now()
    WHERE business_id = v_inv.business_id AND user_id = p_user_id;
  ELSE
    INSERT INTO memberships (tenant_id, business_id, user_id, status, invited_by, joined_at)
    VALUES (v_tenant, v_inv.business_id, p_user_id, 'active', v_inv.invited_by, now());
  END IF;

  INSERT INTO membership_roles (business_id, user_id, role_id)
  VALUES (v_inv.business_id, p_user_id, v_inv.role_id);

  INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id)
  VALUES (v_tenant, v_inv.business_id, p_user_id, 'structure.invitation_accepted', 'invitation', v_inv.id);

  o_invitation_id := v_inv.id;
  o_business_id := v_inv.business_id;
  o_tenant_id := v_tenant;
  RETURN NEXT;
END;
$$;

-- Owner: the platform principal — the bypass boundary exists ONLY inside
-- these functions. EXECUTE is granted to the provisioner exclusively.
DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'provision_replay_operation(uuid,text)',
    'provision_persist_operation(uuid,text,text,text,uuid,uuid)',
    'provision_create_tenant(uuid,uuid)',
    'provision_assert_tenant_owner(uuid,uuid)',
    'provision_create_business(uuid,uuid,uuid,text,text,text,text,text,text,text[],text,jsonb,text,uuid)',
    'provision_peek_invitation(text)',
    'provision_expire_invitation(uuid)',
    'provision_accept_invitation(text,uuid)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO daftar_platform', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO daftar_provisioner', f);
  END LOOP;
END $$;
