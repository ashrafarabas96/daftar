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

-- The schema owner must be able to SET ROLE to `p5_invariants` in order to
-- hand it ownership of the invariant function. Membership only: it adds
-- nothing the owner does not already hold through the `*_owner_admin`
-- policies, and it does not affect what the function sees, because a
-- SECURITY DEFINER function runs as its OWNER whoever called it.
GRANT p5_invariants TO p5owner;
