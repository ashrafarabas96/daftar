-- Cluster roles for the scratch proof, created by the CLUSTER SUPERUSER
-- before any schema exists.
--
-- ROUND 8, the independent challenger's F-05, a P2. Until this round the
-- lane ran `initdb … -U p5owner`, which makes `p5owner` the cluster's
-- BOOTSTRAP SUPERUSER. Measured in the lane's own cluster:
--
--     p5owner rolsuper=true rolbypassrls=true
--
-- So `FORCE ROW LEVEL SECURITY` did not constrain the schema owner at all,
-- the `pcgr_owner_only` policy was never consulted, and the evidence
-- ledger's claim that "no RLS claim in this lane is made as a superuser"
-- was true only by accident — the seven cases that assert RLS do connect as
-- `p5_app`, but the eighteen-odd atomicity and concurrency WRITERS did not,
-- and that principal is exactly what concealed F-01, a P1 that committed an
-- invoice claiming unbacked platform credit. The same trap is on record for
-- Phase 6: a DDL proof run as SUPERUSER is a narrower proof than it looks.
--
-- Nothing here is part of the migration patch request: roles belong to
-- `infrastructure/database/bootstrap.sql`, whose owner is not this thread.
-- This file is what the lane needs in order to make a proof about
-- non-superuser principals at all, and §7 of the patch request carries the
-- RULES as a REQUEST to that owner.

-- The schema owner. `NOSUPERUSER NOBYPASSRLS` is the whole point of the
-- round-8 change: every policy below is now consulted for this role too, so
-- a policy that is decoration reds a case instead of passing silently.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'p5owner') THEN
    CREATE ROLE p5owner LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
  END IF;
END $$;
GRANT CREATE ON DATABASE postgres TO p5owner;

-- The application role: what the API connects as.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'p5_app') THEN
    CREATE ROLE p5_app LOGIN PASSWORD 'p5apppw' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

-- The INVARIANT principal, new in round 8.
--
-- `assert_invoice_credit_agrees` is now `SECURITY DEFINER`, and the question
-- that answers is: definer of WHAT. Owning it by the schema owner would give
-- the invariant every privilege the admin path has, and would make its two
-- read policies redundant with the owner's own — which is how a policy stops
-- being load-bearing and starts being decoration. This role exists so the
-- invariant's principal is the smallest one that can state the invariant:
-- SELECT on the two relations it compares, no LOGIN, and nothing else. It
-- cannot write, so an invariant that must see everything never becomes a
-- writer that may change anything.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'p5_invariants') THEN
    CREATE ROLE p5_invariants NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

-- ROUND 15: a role that holds NOTHING but the right to enter the schema.
-- The independent challenger's F-14 second leg: `REVOKE … FROM PUBLIC` was
-- missing from every definer routine, and it measured that a role with
-- USAGE on the schema and no other privilege could read another tenant's
-- grant count through the PUBLIC EXECUTE default. The revoke landed at
-- round 14; this role is what proves it, because a catalogue law over
-- `proacl` says what the grant table holds and not what a stranger can do.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'p5_stranger') THEN
    CREATE ROLE p5_stranger LOGIN PASSWORD 'p5strangerpw' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

-- The schema owner must be able to SET ROLE to `p5_invariants` in order to
-- hand it ownership of the invariant function. Membership only: it adds
-- nothing the owner does not already hold through the `*_owner_admin`
-- policies, and it does not affect what the function sees, because a
-- SECURITY DEFINER function runs as its OWNER whoever called it.
GRANT p5_invariants TO p5owner;

-- ROUND 18, GAP 1: the OBSERVER must be able to see a wait it does not own.
--
-- Gap 1 is "concurrency under more than one writer in one principal": every
-- interleaving pair in `credit-ledger-concurrency.test.ts` opened on
-- `ownerUrl()`, the bypass principal in both lanes, so no concurrency claim
-- in this pack had been measured under RLS as the APPLICATION role. Moving
-- the writers to `appUrl()` made two of the new cases fail in the barrier
-- rather than in the assertion:
--
--     second finalization, as the application role: backend 3580 never
--     waited on a lock; and B had not settled either
--
-- The diagnosis is not in the schema under test. `waitUntilBlocked` reads
-- `pg_stat_activity.wait_event_type`, and PostgreSQL hides `state`, `query`
-- and the wait columns of a backend belonging to a role the observer is not
-- a member of. Measured on this lane's cluster (PG 16.15, port 54331), with
-- one `p5_app` session holding `pg_advisory_xact_lock(987654)` and a second
-- `p5_app` session queued behind it:
--
--     observer = p5owner    (rolsuper=f)  Lock-waiting backends visible: 0
--     observer = postgres   (rolsuper=t)  Lock-waiting backends visible: 1
--
-- and after the grant below, p5owner reads 1 as well. So the barrier was
-- reporting the observer's BLINDNESS as the absence of a wait — the same
-- class as P14's "a missing BLOB counted as a deletion": an instrument that
-- cannot see reports what it cannot see as a negative observation.
--
-- `pg_read_all_stats` is the smallest remedy and the right one: it is a
-- monitoring role, it confers NO data privilege and does NOT bypass row
-- level security, so the observer stays NOSUPERUSER NOBYPASSRLS and the
-- lane's own principal guard — which runs after this file and refuses
-- anything but `false:false` — still covers it. A superuser observer would
-- have worked too and would have been the wrong fix: this lane's round-8
-- finding (F-05) is precisely that a superuser in the room makes the
-- surrounding claims narrower than they read.
--
-- Granted to whichever observer exists: `p5owner` in the fixture lane,
-- `daftar_platform` in the real-schema lane, since `ownerUrl()` is the
-- observing connection in both.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'p5owner') THEN
    EXECUTE 'GRANT pg_read_all_stats TO p5owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daftar_platform') THEN
    EXECUTE 'GRANT pg_read_all_stats TO daftar_platform';
  END IF;
END $$;
