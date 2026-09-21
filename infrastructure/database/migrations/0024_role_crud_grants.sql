-- 0024_role_crud_grants.sql — §69–74 team role CRUD completion.
-- updateRole replaces a role's permission set (DELETE + INSERT on
-- role_permissions); deleteRole removes the role row and its permissions.
-- daftar_app previously had no DELETE on either table, so the commands could
-- not exist at all. System roles remain protected by the
-- business_roles_system_guard trigger regardless of this grant.
GRANT DELETE ON business_roles, role_permissions TO daftar_app;
