-- Cluster-wide roles for the scratch proof. NOT part of the migration
-- patch request: roles belong to `infrastructure/database/bootstrap.sql`,
-- whose owner is not this thread. These two exist so that every privilege
-- claim below is made by a NON-SUPERUSER, because a superuser bypasses
-- RLS and would turn an RLS proof into a tautology.
-- ROUND 8: the roles moved to `credit-ledger-bootstrap.sql`, which the
-- lane runs FIRST as the cluster superuser, because the schema owner is now
-- one of the roles being created. See the challenger's F-05.

GRANT USAGE ON SCHEMA p5scratch TO p5_app;
-- SELECT and INSERT only. Invariant (3): no UPDATE, no DELETE for the
-- application role. And nothing at all on the remainder table.
GRANT SELECT, INSERT ON p5scratch.platform_credit_adjustments TO p5_app;
-- ROUND 12: the grant on `businesses` moved to `credit-ledger-fixture.sql`
-- (fixture lane) and to the lane script (real-schema lane), because a
-- privilege on a BORROWED relation can only be granted by whoever owns it,
-- and in the real-schema lane that is `daftar_migrator`, not `p5owner`.
-- The application role needs SELECT on it either way, though NOT for the
-- reason this comment gave until round 14 (the coordinator's diff review
-- R-13): the LIVE tenant-membership policy on a relation that carries its
-- own `tenant_id` compares it DIRECTLY, with no subquery, so no policy of
-- this slice reads `businesses` at all. What needs the read is the lane's
-- own fixture work and the FK target, and a policy's subquery would run as
-- the invoking role if there were one.
-- ROUND 5: the invoice relation. SELECT, INSERT and UPDATE — an invoice is
-- NOT append-only (a draft becomes finalized), which is exactly why it is a
-- different relation from the ledger and not a column on it. No DELETE.
GRANT SELECT, INSERT, UPDATE ON p5scratch.subscription_invoices TO p5_app;
GRANT EXECUTE ON FUNCTION p5scratch.lock_grants_in_order(uuid, uuid, text) TO p5_app;
REVOKE ALL ON p5scratch.platform_credit_grant_remainders FROM p5_app;

-- ROUND 12: the admin policies name `CURRENT_USER`, not a literal role.
-- The policies are not role-agnostic — `pg_policies` records the role they
-- resolved to, so a reader of the catalogue still sees exactly who may do
-- what. What changed is that the SAME FILE now applies in both lanes: the
-- fixture lane's platform principal is `p5owner`, and the real-schema lane's
-- is `daftar_platform`, because there `app_bypass()` is the REAL function
-- and tests for that role by name. A literal `p5owner` here would have made
-- the real lane apply a different file, and then the two lanes would not be
-- proving the same schema.

-- The remainder table is under FORCE RLS, so even its owner is subject to
-- policy. The maintaining function is SECURITY DEFINER and runs as the
-- schema owner, so the owner needs one policy.
CREATE POLICY pcgr_owner_only ON p5scratch.platform_credit_grant_remainders
  FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);

-- ── ROUND 8: the admin principal, made explicit ──────────────────────
-- The schema owner is NOSUPERUSER NOBYPASSRLS from this round on (the
-- challenger's F-05), and FORCE RLS applies to a table's owner, so the admin
-- paths — the grant path, the fixtures, the migration principal — need
-- policies of their own. They are written as four named policies rather than
-- left to an implicit superuser bypass for one reason: a policy is in the
-- catalogue, where a reader of the schema can see who may do what, and a
-- superuser bypass is not. `pcgr_owner_only` above was always this; these
-- say the same thing about the other three relations.
CREATE POLICY pca_owner_admin ON p5scratch.platform_credit_adjustments
  FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);
CREATE POLICY si_owner_admin ON p5scratch.subscription_invoices
  FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);
CREATE POLICY sca_owner_admin ON p5scratch.subscription_charge_attempts
  FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);

-- ── ROUND 8, the challenger's F-01: the invariant's own reads ────────
-- `assert_invoice_credit_agrees` is SECURITY DEFINER, for the reasons
-- written above it in the schema, and it reads TWO relations: the invoice it
-- was handed, and the consumption rows naming that invoice. Both are under
-- FORCE RLS, so the definer is subject to policy on both and needs an
-- explicit read of each.
--
-- The definer is `p5_invariants`, NOT the schema owner, and that choice is
-- what keeps these two policies load-bearing. Owning the function by the
-- owner would have made them redundant with the three `*_owner_admin`
-- policies above — and this was MEASURED, not reasoned about: the mutation
-- that removes these two policies came back GREEN on the first attempt,
-- because the owner was still a superuser, and that is the whole shape of
-- F-01 repeating inside its own fix.
--
-- SELECT only, no LOGIN on the role, no write policy anywhere: an invariant
-- that must see everything never becomes a writer that may change anything.
GRANT USAGE ON SCHEMA p5scratch TO p5_invariants;
GRANT SELECT ON p5scratch.subscription_invoices TO p5_invariants;
GRANT SELECT ON p5scratch.platform_credit_adjustments TO p5_invariants;
CREATE POLICY si_invariant_read ON p5scratch.subscription_invoices
  FOR SELECT TO p5_invariants USING (true);
CREATE POLICY pca_invariant_read ON p5scratch.platform_credit_adjustments
  FOR SELECT TO p5_invariants USING (true);
-- PostgreSQL requires the incoming owner to hold CREATE on the schema for
-- an ownership transfer, so the privilege is granted for the transfer and
-- revoked immediately after it. The role is left with exactly USAGE on the
-- schema and SELECT on two tables, which is checked by a case rather than
-- asserted here.
GRANT CREATE ON SCHEMA p5scratch TO p5_invariants;
ALTER FUNCTION p5scratch.assert_invoice_credit_agrees(uuid) OWNER TO p5_invariants;

-- ROUND 14, and the measurement that goes with the coordinator's R-1/R-3:
-- the requested DDL now REVOKEs EXECUTE on all three definer routines from
-- PUBLIC, which is right, and the first run after it failed four cases with
-- `42501` — because the agreement invariant is PERFORMed from the two
-- CONSTRAINT TRIGGER functions, which are plain `SECURITY INVOKER`, so at
-- finalization time they run AS THE APPLICATION ROLE and need EXECUTE of
-- their own. PUBLIC had been supplying it silently.
--
-- So the grant is explicit, and the pair is the point: a revoke from PUBLIC
-- without the compensating grant is not a security fix, it is an outage, and
-- `P5-MIGRATION-PATCH-REQUEST.md` §16 now asks for both halves together.
-- The grant is made BY THE FUNCTION'S OWNER, which by this line is
-- `p5_invariants` and not the role running this file: ownership moved one
-- statement ago, and only an owner (or a superuser) may grant on an object.
-- The real-schema lane found this by failing — `permission denied for
-- function assert_invoice_credit_agrees` — because there the role applying
-- this file is `daftar_platform`, whose membership in `p5_invariants` is
-- `INHERIT FALSE, SET TRUE`: it may BECOME the role but does not hold its
-- rights passively. `SET ROLE` is how that membership is spent.
SET ROLE p5_invariants;
GRANT EXECUTE ON FUNCTION p5scratch.assert_invoice_credit_agrees(uuid) TO p5_app;
-- And to the admin principal applying this file, named as `SESSION_USER` so
-- that neither lane's role name appears here. It is not implied: in the
-- fixture lane that role INHERITS `p5_invariants` and had EXECUTE anyway,
-- while in the real lane its membership is `INHERIT FALSE`, so after the
-- revoke from PUBLIC it lost the invariant with 73 of 118 cases — measured,
-- and the clearest demonstration that a revoke needs its grant named.
GRANT EXECUTE ON FUNCTION p5scratch.assert_invoice_credit_agrees(uuid) TO SESSION_USER;
RESET ROLE;
REVOKE CREATE ON SCHEMA p5scratch FROM p5_invariants;

-- ROUND 15: the stranger gets USAGE on the schema and NOTHING else, which
-- is precisely the shape the challenger's F-14 second leg used. Without
-- USAGE the EXECUTE denial would be masked by a schema denial, and a case
-- that cannot tell which refusal it got is the defect F-11 closed.
GRANT USAGE ON SCHEMA p5scratch TO p5_stranger;

-- ROUND 8, the independent challenger's F-08. `createDraftInvoice` takes its
-- period index from `nextval('p5scratch.scratch_period_seq')`, and the grant
-- set never gave the application role USAGE on that sequence — so the
-- invoice-CREATION path had never been executed as the application role at
-- all, only its UPDATE half, and §7's grant set as written would have failed
-- in production at the first draft invoice. The challenger hit `42501` on it
-- while building the F-01 reproduction and worked around it by letting the
-- owner create the draft.
--
-- The sequence is a FIXTURE of this scratch schema and not part of the
-- requested DDL, so what §7 of the patch request carries is the RULE: the
-- application role needs USAGE on whatever supplies the period index, or the
-- command must supply the index itself. Recorded there as well as here.
GRANT USAGE ON SEQUENCE p5scratch.scratch_period_seq TO p5_app;

-- ROUND 6: the collection attempts. SELECT, INSERT and UPDATE — the UPDATE
-- is RECONCILIATION and nothing else, narrowed by
-- `sca_append_only_except_reconciliation`. §7 of the patch request granted
-- no UPDATE here; this round amends that, because recording the verdict an
-- attempt always had at the provider is the one write that must be possible.
-- No DELETE.
GRANT SELECT, INSERT, UPDATE ON p5scratch.subscription_charge_attempts TO p5_app;
