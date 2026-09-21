-- 0013 — EXPLICIT DB ROLE AUTHORITY (Final Closure Directive §5–13, §59, §65).
-- 1. app_bypass() is EXPLICIT: only daftar_platform bypasses RLS. Not "anyone
--    except daftar_app". Future new roles get NO automatic bypass.
-- 2. daftar_resolver: dedicated membership-resolution role — narrow SELECT
--    grants + own permissive policies; membership resolution no longer needs
--    platform super-privilege (§10).
-- 3. Entitlement ownership (§11–12, §59): merchant runtime (daftar_app) can
--    READ effective entitlement state but can NEVER mutate it — plan
--    assignment, overrides, subscription state belong to the platform/billing
--    boundary only.
-- 4. Platform minimization (§8, §65): daftar_platform loses write access to
--    merchant catalog data (products/categories/variants/media). It keeps
--    identity, membership, invitations, plan/flag management, and the
--    structural INSERTs onboarding needs (businesses, branches, warehouses).

CREATE OR REPLACE FUNCTION app_bypass() RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT current_user = 'daftar_platform'
$$;

-- (2) Membership resolver role: least-privilege read path for resolveMembership.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['memberships','membership_roles','business_roles','role_permissions','businesses'] LOOP
    EXECUTE format('CREATE POLICY resolver_read ON %I USING (current_user = ''daftar_resolver'')', t);
  END LOOP;
END $$;
GRANT SELECT ON memberships, membership_roles, business_roles, role_permissions, businesses TO daftar_resolver;
-- The RESTRICTIVE business_isolation policies apply to EVERY role — the
-- resolver reads across businesses by design, so exempt it explicitly on the
-- membership tables it is granted on.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['memberships','membership_roles','business_roles','role_permissions'] LOOP
    EXECUTE format('DROP POLICY business_isolation ON %I', t);
    EXECUTE format('CREATE POLICY business_isolation ON %I AS RESTRICTIVE
      USING (app_bypass() OR current_user = ''daftar_resolver'' OR business_id::text = app_business())
      WITH CHECK (app_bypass() OR current_user = ''daftar_resolver'' OR business_id::text = app_business())', t);
  END LOOP;
END $$;

-- (3) Merchant runtime loses ALL entitlement mutations.
REVOKE INSERT ON entitlement_overrides FROM daftar_app;
REVOKE INSERT, UPDATE ON business_entitlements FROM daftar_app;

-- (4) Platform role loses merchant catalog writes (keeps SELECT for admin reads).
REVOKE INSERT, UPDATE, DELETE ON products, categories, product_variants, media, product_media FROM daftar_platform;
-- Structural: platform onboards (INSERT only); day-to-day branch/warehouse
-- management runs as the merchant app role.
REVOKE UPDATE, DELETE ON branches, warehouses FROM daftar_platform;
REVOKE UPDATE, DELETE ON businesses FROM daftar_platform;
