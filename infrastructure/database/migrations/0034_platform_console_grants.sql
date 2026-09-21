-- 0034_platform_console_grants.sql
-- Completion Directive §28–29: the plan builder edits a DRAFT version's
-- feature/limit sets in place (full replace). The daftar_platform principal
-- had INSERT/UPDATE on the children but no DELETE, so a key could never be
-- removed from a draft. The DRAFT-only trigger (0022 plan_children_draft_only)
-- remains the arbiter: published children stay immutable regardless of grants.
GRANT DELETE ON plan_entitlements, plan_limits TO daftar_platform;
