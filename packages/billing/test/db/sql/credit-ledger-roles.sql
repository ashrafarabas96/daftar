-- Cluster-wide roles for the scratch proof. NOT part of the migration
-- patch request: roles belong to `infrastructure/database/bootstrap.sql`,
-- whose owner is not this thread. These two exist so that every privilege
-- claim below is made by a NON-SUPERUSER, because a superuser bypasses
-- RLS and would turn an RLS proof into a tautology.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'p5_app') THEN
    CREATE ROLE p5_app LOGIN PASSWORD 'p5apppw' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA p5scratch TO p5_app;
-- SELECT and INSERT only. Invariant (3): no UPDATE, no DELETE for the
-- application role. And nothing at all on the remainder table.
GRANT SELECT, INSERT ON p5scratch.platform_credit_adjustments TO p5_app;
GRANT SELECT ON p5scratch.businesses TO p5_app;
-- ROUND 5: the invoice relation. SELECT, INSERT and UPDATE — an invoice is
-- NOT append-only (a draft becomes finalized), which is exactly why it is a
-- different relation from the ledger and not a column on it. No DELETE.
GRANT SELECT, INSERT, UPDATE ON p5scratch.subscription_invoices TO p5_app;
GRANT EXECUTE ON FUNCTION p5scratch.lock_grants_in_order(uuid, uuid, text) TO p5_app;
REVOKE ALL ON p5scratch.platform_credit_grant_remainders FROM p5_app;

-- The remainder table is under FORCE RLS, so even its owner is subject to
-- policy. The maintaining function is SECURITY DEFINER and runs as the
-- schema owner, so the owner needs one policy — and it is the only one.
CREATE POLICY pcgr_owner_only ON p5scratch.platform_credit_grant_remainders
  FOR ALL TO p5owner USING (true) WITH CHECK (true);

-- ROUND 6: the collection attempts. SELECT, INSERT and UPDATE — the UPDATE
-- is RECONCILIATION and nothing else, narrowed by
-- `sca_append_only_except_reconciliation`. §7 of the patch request granted
-- no UPDATE here; this round amends that, because recording the verdict an
-- attempt always had at the provider is the one write that must be possible.
-- No DELETE.
GRANT SELECT, INSERT, UPDATE ON p5scratch.subscription_charge_attempts TO p5_app;
