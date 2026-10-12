-- =====================================================================
-- THE BORROWED RELATIONS — the FIXTURE half of the Phase 5 scratch lane.
--
-- Everything in this file is a copy of something the FROZEN schema already
-- owns. None of it is requested by `P5-MIGRATION-PATCH-REQUEST.md`, and
-- none of it may ever reach a migration: the real objects exist.
--
-- It is a SEPARATE FILE as of round 12 for one reason: the lane can now run
-- against the REAL schema instead, by applying the frozen history with the
-- project's own runner (`npm run migrate` as `daftar_migrator`) and leaving
-- this file out. `credit-ledger-scratch.sql` references every borrowed
-- object UNQUALIFIED, so the same DDL resolves to these copies in the
-- fixture lane and to `public`'s real relations in the real-schema lane.
-- A proof is then labelled by WHICH of the two it ran against, because they
-- are not the same claim.
--
-- `P5-CHECKPOINT.md` §9 states what is still missing from these copies.
-- =====================================================================

DROP SCHEMA IF EXISTS p5scratch CASCADE;
CREATE SCHEMA p5scratch;

-- From `0001_platform.sql`, verbatim in shape and in seed. `minor_units`
-- is why it is here: a currency's precision is a FACT OF THIS TABLE, and
-- JOD has three minor units while every other seeded currency has two.
-- A three-letter shape CHECK cannot know that, and `ZZZ` passes a shape
-- CHECK while naming no currency at all.
CREATE TABLE p5scratch.currencies (
  code         text     PRIMARY KEY,
  numeric_code text     NOT NULL UNIQUE,
  minor_units  smallint NOT NULL CHECK (minor_units BETWEEN 0 AND 3)
);
INSERT INTO p5scratch.currencies (code, numeric_code, minor_units) VALUES
  ('ILS','376',2), ('JOD','400',3), ('LBP','422',2), ('SYP','760',2),
  ('TRY','949',2), ('USD','840',2), ('EUR','978',2);

-- The relation the real `businesses.tenant_id` references. One column of
-- it is enough for a reference to be a reference; the point is that the
-- fixture no longer omits the parent.
CREATE TABLE p5scratch.tenants (
  id uuid NOT NULL PRIMARY KEY
);

CREATE TABLE p5scratch.businesses (
  tenant_id     uuid NOT NULL REFERENCES p5scratch.tenants (id),
  id            uuid NOT NULL PRIMARY KEY,
  -- The four NOT NULL columns with no default, with the live CHECKs from
  -- `0003_tenancy.sql`. They are unnamed here exactly as they are there.
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  store_slug    text NOT NULL UNIQUE CHECK (store_slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  country_code  text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  base_currency text NOT NULL REFERENCES p5scratch.currencies (code),
  CONSTRAINT businesses_tenant_id_id_uq UNIQUE (tenant_id, id)
);

-- From `0007_entitlements.sql` with the state set `0021_saas_enforcement.sql`
-- replaced it with. It is here for ONE purpose: to show that this slice has
-- no write path into it. The subscription state machine is not Phase 5's to
-- move, and `P5-ENTITLEMENT-RECONCILIATION-CONTRACT.md` says who owns it and
-- what P5 may do instead. Keyed by `business_id` ALONE, as the real table is.
CREATE TABLE p5scratch.business_entitlements (
  business_id uuid NOT NULL PRIMARY KEY REFERENCES p5scratch.businesses (id),
  state       text NOT NULL CHECK (state IN ('trial','active','grace_period','past_due','paused',
                                             'cancel_at_period_end','cancelled','expired','complimentary'))
);


-- ── the RLS context functions, copied from the LIVE definitions ──────
--
-- ROUND 12 FIRST COPIED `0006_rls.sql` and that was WRONG, which the
-- real-schema lane found within its first run. `app_bypass()` has been
-- redefined FIVE times since 0006, and the whole chain matters because
-- `CREATE OR REPLACE FUNCTION` leaves nothing at the original site, so the
-- first definition still reads as current however many supersede it:
--   0006  the GUC `app.bypass_rls`
--   0010_db_roles.sql                      the GUC AND current_user <> 'daftar_app'
--   0013_security_boundary.sql             a ROLE test, current_user = 'daftar_platform'
--   0030_provisioner_role.sql              widened to include daftar_provisioner
--   0032_provisioner_narrow_functions.sql  narrowed back to the platform role
--   0052_accounting_…_rls_performance.sql  the same predicate hardened
-- The live
-- body, read from `pg_proc` on a cluster with the whole history applied, is
--
--     RETURN CURRENT_USER OPERATOR(pg_catalog.=) 'daftar_platform'::pg_catalog.name
--
-- so no `set_config('app.bypass_rls', …)` can grant a bypass to anything.
-- A lane that copied 0006 would have proved the opposite of the deployed
-- behaviour while looking like the house pattern — the same mistake the
-- challenger made in its own §5 and corrected: read the HISTORY of an
-- object, not the file that first created it.
--
-- The platform principal here is `p5owner`, which is this lane's schema
-- owner and its stand-in for the platform/migration authority. That
-- substitution is the one difference from the live body, and it is why the
-- real-schema lane needs the fixture's admin connection to be
-- `daftar_platform` instead — recorded in `P5-CHECKPOINT.md` §9.
CREATE OR REPLACE FUNCTION p5scratch.app_tenant() RETURNS TEXT LANGUAGE sql STABLE PARALLEL SAFE
  RETURN current_setting('app.tenant_id'::text, true);
CREATE OR REPLACE FUNCTION p5scratch.app_business() RETURNS TEXT LANGUAGE sql STABLE PARALLEL SAFE
  RETURN current_setting('app.business_id'::text, true);
CREATE OR REPLACE FUNCTION p5scratch.app_bypass() RETURNS BOOLEAN LANGUAGE sql STABLE PARALLEL SAFE
  RETURN CURRENT_USER OPERATOR(pg_catalog.=) 'p5owner'::pg_catalog.name;

-- The application role reads `businesses` because the house
-- tenant-membership policy is an EXISTS over it, evaluated as the invoking
-- role. In the real-schema lane the same grant is issued by the lane
-- script as the relation's real owner.
GRANT SELECT ON p5scratch.businesses TO p5_app;
GRANT EXECUTE ON FUNCTION p5scratch.app_tenant(), p5scratch.app_business(), p5scratch.app_bypass() TO p5_app, p5_invariants;
