-- Idempotent role bootstrap. Passwords substituted by the runner.
-- Least-privilege roles (Security Gate Zero §11):
--   daftar_app      normal API runtime — RLS-enforced, cannot bypass RLS
--   daftar_platform platform administration (provisioning, plans, admin console)
--   daftar_identity auth runtime ONLY (users/sessions/refresh lineage/reset tokens)
--   daftar_worker   background workers (outbox relay) — dedicated boundary
--   daftar_provisioner narrow provisioning boundary (Stabilization §13–14):
--                     initial onboarding, additional business creation,
--                     invitation acceptance. NOTHING else.
--
-- INTERNAL, NON-LOGIN principal (P2-S1 authority correction):
--   daftar_accounting_internal
--                     the ONLY principal holding physical INSERT on the
--                     accounting chart. It is NOLOGIN and has no password, so
--                     no credential for it can exist or be stolen; it is
--                     NOINHERIT and is granted to nobody, so no runtime role
--                     can assume it. Its authority is reachable only by
--                     calling the SECURITY DEFINER routine it owns, which in
--                     turn is reachable only from the businesses trigger and
--                     the migration. A platform administrator is not a
--                     financial configuration authority.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daftar_app') THEN
    CREATE ROLE daftar_app LOGIN PASSWORD '__APP_DB_PASSWORD__';
  ELSE
    ALTER ROLE daftar_app LOGIN PASSWORD '__APP_DB_PASSWORD__';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daftar_platform') THEN
    CREATE ROLE daftar_platform LOGIN PASSWORD '__PLATFORM_DB_PASSWORD__';
  ELSE
    ALTER ROLE daftar_platform LOGIN PASSWORD '__PLATFORM_DB_PASSWORD__';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daftar_worker') THEN
    CREATE ROLE daftar_worker LOGIN PASSWORD '__WORKER_DB_PASSWORD__';
  ELSE
    ALTER ROLE daftar_worker LOGIN PASSWORD '__WORKER_DB_PASSWORD__';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daftar_resolver') THEN
    CREATE ROLE daftar_resolver LOGIN PASSWORD '__RESOLVER_DB_PASSWORD__';
  ELSE
    ALTER ROLE daftar_resolver LOGIN PASSWORD '__RESOLVER_DB_PASSWORD__';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daftar_identity') THEN
    CREATE ROLE daftar_identity LOGIN PASSWORD '__IDENTITY_DB_PASSWORD__';
  ELSE
    ALTER ROLE daftar_identity LOGIN PASSWORD '__IDENTITY_DB_PASSWORD__';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daftar_provisioner') THEN
    CREATE ROLE daftar_provisioner LOGIN PASSWORD '__PROVISIONER_DB_PASSWORD__';
  ELSE
    ALTER ROLE daftar_provisioner LOGIN PASSWORD '__PROVISIONER_DB_PASSWORD__';
  END IF;
  -- Internal accounting authority. NOLOGIN, NOINHERIT, never a password —
  -- re-asserted on every run so an existing database cannot drift into a
  -- seventh login role.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daftar_accounting_internal') THEN
    CREATE ROLE daftar_accounting_internal NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE daftar_accounting_internal NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL;
  END IF;
END $$;
GRANT CONNECT ON DATABASE daftar TO daftar_app, daftar_platform, daftar_worker, daftar_resolver, daftar_identity, daftar_provisioner;
GRANT USAGE ON SCHEMA public TO daftar_app, daftar_platform, daftar_worker, daftar_resolver, daftar_identity, daftar_provisioner;
-- The internal accounting principal gets schema USAGE only. It is NOLOGIN, so
-- it deliberately receives no CONNECT: nothing can open a session as it.
GRANT USAGE ON SCHEMA public TO daftar_accounting_internal;
