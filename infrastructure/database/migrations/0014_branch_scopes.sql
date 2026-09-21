-- 0014 — BRANCH SCOPES FOR REAL (Final Closure Mission WAVE 6 / §32–37).
-- member_branch_scopes got standard RLS in 0008; this migration wires the
-- resolver role (membership resolution now carries branch scope) and adds the
-- DELETE grant scope replacement needs.

-- Resolver reads scopes across businesses by design (narrow SELECT only).
CREATE POLICY resolver_read ON member_branch_scopes USING (current_user = 'daftar_resolver');
GRANT SELECT ON member_branch_scopes TO daftar_resolver;

-- The RESTRICTIVE business_isolation policy applies to EVERY role — exempt
-- the resolver explicitly (same pattern as 0013 on the membership tables).
DROP POLICY business_isolation ON member_branch_scopes;
CREATE POLICY business_isolation ON member_branch_scopes AS RESTRICTIVE
  USING (app_bypass() OR current_user = 'daftar_resolver' OR business_id::text = app_business())
  WITH CHECK (app_bypass() OR current_user = 'daftar_resolver' OR business_id::text = app_business());

-- Scope replacement needs DELETE (0008 granted only SELECT/INSERT/UPDATE).
GRANT DELETE ON member_branch_scopes TO daftar_app;
-- Platform boundary purges scopes on remove/re-accept (WAVE 1 lifecycle).
GRANT DELETE ON member_branch_scopes TO daftar_platform;
