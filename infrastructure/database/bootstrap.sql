-- Idempotent role + extension bootstrap. Passwords substituted by the runner.
--
-- ── Extensions the schema depends on (P2-S6 §12) ────────────────────────────
-- `btree_gist` supplies the GiST operator class that lets migration 0049 put
-- an equality column (business_id) beside a range column in ONE exclusion
-- constraint — the only mechanism that makes overlapping accounting periods
-- physically impossible rather than merely checked for.
--
-- It is installed HERE, as the deployment administrator that already creates
-- the roles below, and NOT by the migration. PostgreSQL 13+ marks the
-- extension `trusted`, so a non-superuser can install it — but only with
-- CREATE ON DATABASE, which `daftar_migrator` deliberately does not hold and
-- which would be a permanent, far broader authority bought for one statement.
-- An already-installed extension needs no privilege at all, so 0049's
-- `CREATE EXTENSION IF NOT EXISTS` is a no-op under CONNECT alone. That is
-- the shape this deployment uses: the deployment contract moved, the
-- migration principal's privileges did not.
CREATE EXTENSION IF NOT EXISTS btree_gist;

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
--                     no credential for it can exist or be stolen, and it is
--                     NOINHERIT. Its authority is reachable only by calling
--                     the SECURITY DEFINER routine it owns, which in turn is
--                     reachable only from the businesses trigger and the
--                     migration. A platform administrator is not a financial
--                     configuration authority.
--
-- DEPLOYMENT principal, NOT a runtime (P2-S1 managed-PostgreSQL correction):
--   daftar_migrator   the schema-migration principal. It is a LOGIN role, but
--                     it is not an application runtime: no service loads its
--                     credential and it appears in no runtime connection URL.
--                     Runtime authority and deployment authority are two
--                     different trust boundaries; this is the second one.
--
-- THE ONE INTENTIONAL MEMBERSHIP.
--   daftar_migrator is a member of daftar_accounting_internal WITH INHERIT
--   FALSE, SET TRUE. PostgreSQL requires a non-superuser that transfers
--   function ownership to be able to SET ROLE to the new owner, so without
--   this a managed deployment could not run migration 0040 at all without a
--   superuser. INHERIT FALSE means the membership is not accounting authority
--   in itself: it has to be assumed deliberately, and only a deployment
--   credential can assume it.
--   NO RUNTIME PRINCIPAL MAY BE A MEMBER. The P2-S1 gate fails if one is.
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
  -- Deployment migration authority. NOSUPERUSER and NOBYPASSRLS are re-asserted
  -- on every run: DAFTAR must never silently require a superuser to migrate.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daftar_migrator') THEN
    CREATE ROLE daftar_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '__MIGRATOR_DB_PASSWORD__';
  ELSE
    ALTER ROLE daftar_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '__MIGRATOR_DB_PASSWORD__';
  END IF;
END $$;
GRANT CONNECT ON DATABASE daftar TO daftar_app, daftar_platform, daftar_worker, daftar_resolver, daftar_identity, daftar_provisioner;
GRANT USAGE ON SCHEMA public TO daftar_app, daftar_platform, daftar_worker, daftar_resolver, daftar_identity, daftar_provisioner;
-- The internal accounting principal gets schema USAGE only. It is NOLOGIN, so
-- it deliberately receives no CONNECT: nothing can open a session as it. It
-- gets no CREATE here either — migration 0040 takes CREATE on public only for
-- the one statement PostgreSQL requires it for, and revokes it in the same file.
GRANT USAGE ON SCHEMA public TO daftar_accounting_internal;

-- ── Deployment migration authority ──────────────────────────────────────────
-- Separate from every runtime grant above, and loaded by no service.
GRANT CONNECT ON DATABASE daftar TO daftar_migrator;
GRANT USAGE, CREATE ON SCHEMA public TO daftar_migrator;
-- The one membership. SET TRUE is what lets a non-superuser migrator give the
-- seeding routines their final owner; INHERIT FALSE is what stops the
-- membership from being accounting authority in its own right. Any membership
-- beyond this one — above all a runtime role — fails the P2-S1 gate.
GRANT daftar_accounting_internal TO daftar_migrator WITH INHERIT FALSE, SET TRUE;

-- ── Default deny on every namespace a caller could write (P2-S3 correction) ─
--
-- PostgreSQL grants TEMPORARY on a database to PUBLIC, and it has to be taken
-- away explicitly. That matters far more than it looks, because of a second
-- default: a function's `search_path` that does not name `pg_temp` is not a
-- path without `pg_temp`. The session temporary schema is still searched for
-- relation and type names — FIRST, ahead of every schema that IS named.
-- Leaving it out does not exclude it; it only forfeits the choice of where it
-- sits.
--
-- Put together, those two defaults are a complete authority bypass. A stolen
-- runtime credential can create `pg_temp.accounting_assertion_keys`, grant the
-- elevated principal SELECT on the table it now owns, and the SECURITY DEFINER
-- verifier running as daftar_accounting_internal will read the attacker's key
-- material instead of the registry — and then accept an assertion the attacker
-- signed. That is not hypothetical: it is the regression in
-- tests/security/search-path-shadowing.test.ts, which forged a journal entry
-- from the daftar_app credential alone before these lines existed.
--
-- This is the boundary that closes the class, for every SECURITY DEFINER
-- routine in the database at once — including the frozen Phase 1 ones, whose
-- bytes may not be changed and whose owners the deployment migrator may not
-- assume. Hardening individual search_paths is defence in depth on top of it,
-- never instead of it.
--
-- Default deny: nothing here grants TEMPORARY back to anybody.
--
-- `current_database()` rather than the literal name the GRANTs above use.
-- REVOKE takes no expression, so this needs dynamic SQL — and it is worth it:
-- a privilege boundary that only lands when the database happens to be called
-- `daftar` is a boundary that a scratch database, a staging restore under
-- another name, or a per-tenant deployment would silently not have.
DO $$
DECLARE
  v_db TEXT := current_database();
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', v_db);
  EXECUTE format(
    'REVOKE TEMPORARY ON DATABASE %I FROM daftar_app, daftar_platform, daftar_worker, daftar_resolver, daftar_identity, daftar_provisioner',
    v_db);
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM daftar_accounting_internal', v_db);
END $$;

-- The other caller-writable namespace. PostgreSQL 15 and later no longer give
-- PUBLIC CREATE on schema public, but a database created earlier and upgraded
-- carries the old grant, and a deployment must not depend on which one it got.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM
  daftar_app, daftar_platform, daftar_worker, daftar_resolver, daftar_identity, daftar_provisioner;
