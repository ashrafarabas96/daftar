-- Idempotent role bootstrap. Passwords substituted by the runner.
-- Least-privilege roles (Security Gate Zero §11):
--   daftar_app      normal API runtime — RLS-enforced, cannot bypass RLS
--   daftar_platform platform administration (provisioning, plans, admin console)
--   daftar_identity auth runtime ONLY (users/sessions/refresh lineage/reset tokens)
--   daftar_worker   background workers (outbox relay) — dedicated boundary
--   daftar_provisioner narrow provisioning boundary (Stabilization §13–14):
--                     initial onboarding, additional business creation,
--                     invitation acceptance. NOTHING else.
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
END $$;
GRANT CONNECT ON DATABASE daftar TO daftar_app, daftar_platform, daftar_worker, daftar_resolver, daftar_identity, daftar_provisioner;
GRANT USAGE ON SCHEMA public TO daftar_app, daftar_platform, daftar_worker, daftar_resolver, daftar_identity, daftar_provisioner;
