-- M21 (round 9, finding R9-F1). PA8-O1's red proof, which was owed.
--
-- The eighth round added `PA8-O1`: the plant of a row for another transaction
-- is refused for the ledger's OWNER as well as for `daftar_app`, because the
-- ledger is FORCE ROW LEVEL SECURITY and a policy therefore binds its owner.
-- That case passed from the moment it was written, and a passing case measures
-- nothing until something can make it fail. By this phase's own standard -- a
-- claim the DDL makes should rest on this tree's instrument -- the mutation was
-- owed, and this is it.
--
-- WHY THIS MUTATION AND NOT AN EXISTING ONE. The ninth round measured all three
-- candidates rather than reasoning about them, and only one of them isolates
-- the FORCE leg:
--   * `M15` (drop the own-transaction INSERT policy): `PA8-O1` STAYS GREEN. A
--     FORCE RLS table with no INSERT policy is default-deny, so the plant is
--     still refused -- for a different reason. A mutation that leaves the case
--     green attributes nothing.
--   * `M18` (make the write policy PERMISSIVE): BOTH arms commit. It reds the
--     predicate for every role at once, so it cannot say the owner was ever
--     bound by anything.
--   * NO FORCE with the policy kept -- this file: the only one that flips
--     exactly ONE of the two arms.
--
-- EXPECTED, and this is the whole design of the file: `PA8-O1` goes from
-- refused to COMMITTED (a row 7000 ahead of its own txid lands), while its
-- `daftar_app` sibling `PA6-L2` STAYS REFUSED. The sibling is the isolating
-- control: if both flipped, the mutation would be measuring the policy rather
-- than the FORCE leg, which is exactly what M18 does.
--
-- The apply-time half is defended separately and is NOT what this file tests:
-- removing the `ALTER TABLE ... FORCE ROW LEVEL SECURITY` line from a COPY of
-- Pack A makes the rebuild exit 7 with
-- `catalog.migration_end_state_invalid: catalog_grid_ctx_ledger does not have
-- row-level security both ENABLED and FORCED`. That is the end-state
-- assertion refusing the install, measured by the ninth round on its own copy.
-- This file runs at step 5c, AFTER that assertion has already passed, which is
-- the documented ordering limit of the mutation hook (see M13) and is what
-- makes a post-pack mutation of the live catalogue possible at all.
DO $m21$
DECLARE
  v_force BOOLEAN;
BEGIN
  SELECT c.relforcerowsecurity INTO v_force
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relname = 'catalog_grid_ctx_ledger';
  IF v_force IS NULL THEN
    RAISE EXCEPTION 'M21: catalog_grid_ctx_ledger is not in public; the mutation has no subject';
  END IF;
  IF NOT v_force THEN
    RAISE EXCEPTION 'M21: the ledger is already NO FORCE, so the leg this file red-proves is not in place';
  END IF;
  ALTER TABLE catalog_grid_ctx_ledger NO FORCE ROW LEVEL SECURITY;
  -- And it proves it mutated, by name, in the direction it claims -- and that
  -- it changed ONLY that: row-level security must still be ENABLED and both
  -- policies must still be there, or the flip below would not be the FORCE
  -- leg's.
  SELECT c.relforcerowsecurity INTO v_force
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relname = 'catalog_grid_ctx_ledger';
  IF v_force THEN
    RAISE EXCEPTION 'M21: the ALTER did not take; the ledger is still FORCE ROW LEVEL SECURITY';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace
                  AND relname = 'catalog_grid_ctx_ledger' AND relrowsecurity) THEN
    RAISE EXCEPTION 'M21: row-level security is no longer ENABLED either, so this mutation changed more than the FORCE leg';
  END IF;
  IF (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
       WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'catalog_grid_ctx_ledger') <> 2 THEN
    RAISE EXCEPTION 'M21: the ledger no longer carries its two policies, so this mutation changed more than the FORCE leg';
  END IF;
END;
$m21$;
