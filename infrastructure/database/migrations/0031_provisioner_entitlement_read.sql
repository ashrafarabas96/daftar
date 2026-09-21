-- 0031: provisioner read-only access for quota evaluation.
-- completeOnboarding / invitation acceptance evaluate plan limits
-- (assertCanConsume -> getLimit) which reads entitlement_overrides.
-- Provisioner may READ overrides to compute effective limits, but may
-- NOT write them (no INSERT/UPDATE/DELETE grants).
GRANT SELECT ON entitlement_overrides TO daftar_provisioner;
