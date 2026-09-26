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

-- `citext` and `pgcrypto` are installed here for the SAME reason, and the
-- reason was found by the P2-S8 rollback rehearsal (§39) rather than by
-- reading the files.
--
-- `0000_extensions.sql` issues `CREATE EXTENSION IF NOT EXISTS` for both.
-- That statement is a no-op when the extension is already installed and needs
-- no privilege at all — but on a FRESH database it is a real CREATE, and it
-- requires CREATE ON DATABASE, which `daftar_migrator` deliberately does not
-- hold. CI never noticed because CI applies migrations as the superuser; the
-- rehearsal applies them as `daftar_migrator`, the way §36 requires a
-- deployment to, and 0000 failed there with `permission denied to create
-- extension "citext"`.
--
-- The fix belongs here and not in 0000, which is frozen and would in any case
-- be the wrong place: installing an extension is a deployment-administrator
-- act, exactly as it already is for btree_gist. With these two lines the
-- migration principal needs no database-wide CREATE on any path, fresh or
-- upgraded.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Least-privilege roles (Security Gate Zero §11):
--   daftar_app      normal API runtime — RLS-enforced, cannot bypass RLS
--   daftar_platform platform administration (provisioning, plans, admin console)
--   daftar_identity auth runtime ONLY (users/sessions/refresh lineage/reset tokens)
--   daftar_worker   background workers (outbox relay) — dedicated boundary
--   daftar_provisioner narrow provisioning boundary (Stabilization §13–14):
--                     initial onboarding, additional business creation,
--                     invitation acceptance. NOTHING else.
--   daftar_reconciler READ-ONLY financial verification (P2-S8). A seventh
--                     runtime boundary, and a deliberate one: delivery
--                     authority and financial reconciliation authority are
--                     not the same trust boundary, so the credential that
--                     holds the SMTP transport and the credential decryption
--                     key ring does not also get to read every business's
--                     books. It holds SELECT on the accounting estate and
--                     EXECUTE on ONE narrow enumerator, and nothing else:
--                     no write anywhere, no financial command, no identity
--                     table, no key material, no RLS bypass.
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
--   daftar_inventory_internal
--                     (P3-S1, P3-AL-54 §C) the owner of the Phase 3 inventory
--                     routines and column guards, and the only principal
--                     that may write inventory configuration, base variants
--                     and warehouse-branch associations. The same NOLOGIN,
--                     NOINHERIT, passwordless shape, and a separate trust
--                     boundary from the accounting principal.
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
--   credential can assume it. daftar_inventory_internal is the same shape for
--   the same reason (P3-AL-54 §C).
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
  -- Reconciliation runtime (P2-S8). Every negative attribute is re-asserted on
  -- every run rather than set once at creation: a role that drifts into
  -- BYPASSRLS on an existing database would turn a scoped verifier into a
  -- global reader without a single line of the repository changing.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daftar_reconciler') THEN
    CREATE ROLE daftar_reconciler LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION
      PASSWORD '__RECONCILER_DB_PASSWORD__';
  ELSE
    ALTER ROLE daftar_reconciler LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION
      PASSWORD '__RECONCILER_DB_PASSWORD__';
  END IF;
  -- Internal accounting authority. NOLOGIN, NOINHERIT, never a password —
  -- re-asserted on every run so an existing database cannot drift into a
  -- seventh login role.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daftar_accounting_internal') THEN
    CREATE ROLE daftar_accounting_internal NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE daftar_accounting_internal NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL;
  END IF;
  -- Internal inventory authority (P3-AL-54 §C). The exact shape of the
  -- accounting principal above, and separate from it: inventory never runs as
  -- the accounting principal and accounting never as this one. NOLOGIN,
  -- NOINHERIT, never a password — re-asserted on every run.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daftar_inventory_internal') THEN
    CREATE ROLE daftar_inventory_internal NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE daftar_inventory_internal NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL;
  END IF;
  -- Deployment migration authority. NOSUPERUSER and NOBYPASSRLS are re-asserted
  -- on every run: DAFTAR must never silently require a superuser to migrate.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daftar_migrator') THEN
    CREATE ROLE daftar_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '__MIGRATOR_DB_PASSWORD__';
  ELSE
    ALTER ROLE daftar_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '__MIGRATOR_DB_PASSWORD__';
  END IF;
END $$;
GRANT CONNECT ON DATABASE daftar TO daftar_app, daftar_platform, daftar_worker, daftar_resolver, daftar_identity, daftar_provisioner, daftar_reconciler;
GRANT USAGE ON SCHEMA public TO daftar_app, daftar_platform, daftar_worker, daftar_resolver, daftar_identity, daftar_provisioner, daftar_reconciler;
-- The internal accounting principal gets schema USAGE only. It is NOLOGIN, so
-- it deliberately receives no CONNECT: nothing can open a session as it. It
-- gets no CREATE here either — migration 0040 takes CREATE on public only for
-- the one statement PostgreSQL requires it for, and revokes it in the same file.
GRANT USAGE ON SCHEMA public TO daftar_accounting_internal;
-- The internal inventory principal (P3-AL-54 §C): the same USAGE-only shape,
-- no CONNECT, no CREATE. Migrations 0053 onward take CREATE for the ownership
-- transfer and revoke it in the same file.
GRANT USAGE ON SCHEMA public TO daftar_inventory_internal;

-- ── Deployment migration authority ──────────────────────────────────────────
-- Separate from every runtime grant above, and loaded by no service.
GRANT CONNECT ON DATABASE daftar TO daftar_migrator;
GRANT USAGE, CREATE ON SCHEMA public TO daftar_migrator;

-- ── The deployment principal owns the schema it migrates (P2-S9, RB-P2-01) ──
--
-- `public` belongs to `pg_database_owner` by default, so the migrator held
-- CREATE without grant option. That is enough to CREATE an object and not
-- enough to hand one over: migration 0040 and the eight files after it
-- lend `CREATE ON SCHEMA public` to the role they are about to make owner
-- and take it back in the same transaction, and a non-owner cannot issue
-- that GRANT at all. A deployment as the real production authority failed
-- here with `permission denied for schema public`; a superuser never does,
-- which is why CI could not see it.
--
-- `tests/integration/migration-portability.test.ts` has always modelled the
-- managed-PostgreSQL shape this way — it hands the schema and every object
-- in it to `daftar_migrator` before applying anything — so this line makes
-- the deployment contract say what the portability matrix already proves,
-- rather than leaving the two disagreeing.
--
-- It is not a widening: the migrator already holds CREATE here, so it can
-- already create an object in `public`. Ownership adds the ability to grant
-- that same privilege onward, which is precisely what the frozen history
-- requires of its deployer and nothing more. Every runtime role's CREATE on
-- this schema is revoked at the bottom of this file and stays revoked.
ALTER SCHEMA public OWNER TO daftar_migrator;
-- ── The memberships, and why there are exactly three (P2-S9, RB-P2-01, P3-S1)
--
-- PostgreSQL will not let a non-superuser run `ALTER ... OWNER TO r` unless it
-- can `SET ROLE` to r. The migration history hands ownership to exactly three
-- roles, and the deployment principal therefore needs exactly three
-- memberships. The set is not a judgement call: it is read off the frozen
-- files, and `scripts/deployment-authority.ts` re-derives it from the history
-- on every run so that a future migration naming a third owner is a red gate
-- rather than a failed production deployment.
--
--   daftar_accounting_internal  0040, 0042–0049, 0051 — the accounting
--                               routines' final owner (P2-S1).
--   daftar_platform             0032, 0033, 0038 — the eight provisioning
--                               functions whose bypass boundary exists only
--                               inside them (Phase 1).
--   daftar_inventory_internal   0053 onward — the Phase 3 inventory routines'
--                               and column guards' final owner (P3-AL-54 §C).
--
-- The second one was missing until P2-S9, and `daftar_migrator` could not
-- apply the accepted history end to end: a fresh deployment died at
-- `0032_provisioner_narrow_functions.sql` with `must be able to SET ROLE
-- "daftar_platform"`. It was invisible because CI applies migrations as the
-- superuser and the rollback rehearsal restores a Phase 1 backup whose
-- 0032 had already been applied by one. That is release blocker RB-P2-01,
-- and this line is its fix.
--
-- WHY A MEMBERSHIP IN A RUNTIME ROLE IS NOT A WIDENING HERE. The deployment
-- principal owns every table and every function in the schema, so it can
-- already `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY` on anything it owns
-- and read it. `SET ROLE daftar_platform` gives it no capability it did not
-- have; it makes an existing one cheaper. The direction that WOULD be a
-- widening — a runtime role gaining deployment or accounting authority — is
-- the one that stays closed: no runtime role is a member of anything here,
-- `daftar_accounting_internal`'s and `daftar_inventory_internal`'s only
-- member is still `daftar_migrator`, and the deployment credential appears in
-- no runtime connection URL. The alternative — a second deployment credential
-- holding the same memberships — would add a credential without removing any authority.
--
-- WHY THE MEMBERSHIPS ARE NOT ALL THE SAME SHAPE. `INHERIT FALSE` is the
-- preferred form and the accounting membership keeps it: the financial
-- authority must be assumed deliberately, never held passively, and with
-- SET TRUE the migrator can still perform 0040's handover. The platform
-- membership cannot be that shape, and the reason is a property of
-- PostgreSQL rather than a preference. `0038_provisioning_assertions.sql`
-- issues `CREATE OR REPLACE FUNCTION` on eight functions that `0032` already
-- made `daftar_platform`'s, and replacing an existing function is an
-- OWNERSHIP check — `has_privs_of_role`, which reads the INHERIT bit and
-- ignores SET. With `INHERIT FALSE` the accepted history stops at 0038 with
-- `must be owner of function provision_replay_operation`. There is no
-- narrower privilege to grant instead: PostgreSQL has no "may replace this
-- function" permission, and the file mixes those statements with `CREATE
-- TABLE`, so it cannot be run under `SET ROLE daftar_platform` either.
--
-- What inheriting `daftar_platform` actually adds is the ability to EXECUTE
-- the eight provisioning functions without assuming the role first. It adds
-- no reach over data: the migrator owns every table in the schema already.
-- The alternative is a superuser deployment, which is strictly more.
GRANT daftar_accounting_internal TO daftar_migrator WITH INHERIT FALSE, SET TRUE;
GRANT daftar_platform TO daftar_migrator WITH INHERIT TRUE, SET TRUE;
-- The third owner, in the accounting membership's shape and for the same
-- reason: inventory authority is assumed deliberately, never held passively.
-- SET TRUE is what lets the migrator hand routine ownership over; INHERIT
-- FALSE means it holds none of the role's table privileges while it does.
-- No runtime role is, or may become, a member (P3-AL-54 §C).
GRANT daftar_inventory_internal TO daftar_migrator WITH INHERIT FALSE, SET TRUE;

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
    'REVOKE TEMPORARY ON DATABASE %I FROM daftar_app, daftar_platform, daftar_worker, daftar_resolver, daftar_identity, daftar_provisioner, daftar_reconciler',
    v_db);
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM daftar_accounting_internal', v_db);
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM daftar_inventory_internal', v_db);
END $$;

-- The other caller-writable namespace. PostgreSQL 15 and later no longer give
-- PUBLIC CREATE on schema public, but a database created earlier and upgraded
-- carries the old grant, and a deployment must not depend on which one it got.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM
  daftar_app, daftar_platform, daftar_worker, daftar_resolver, daftar_identity, daftar_provisioner, daftar_reconciler;
