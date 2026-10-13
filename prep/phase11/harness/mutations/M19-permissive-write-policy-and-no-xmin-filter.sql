-- M19 (round 6). The PAIR of M18 and M16 together: the write policy made
-- permissive AND the `xmin` filter removed. This is the only arrangement in
-- which a row planted for another transaction is actually COUNTED by the
-- deferred check, and it is therefore the only arrangement in which the
-- `xmin` filter's effect is observable at all.
--
-- Expected: PA6-L2 goes red, as under M18. Whether anything else moves is the
-- measurement this file exists to take, and the answer is written into
-- P11-LIVE-DDL-PROOF.md 14.4 rather than predicted here -- a mutation file
-- that states its result in advance and is not re-read is how this phase
-- shipped a false expectation in M13 and again in M15.
--
-- What NO mutation in this set can show, stated plainly: that a planted row
-- turns the law into a fail-OPEN. It cannot, because unanimity makes a
-- disagreeing row a refusal. The exposure a plant creates is a denial --
-- someone else's lawful transaction refusing -- and this suite has no case that
-- plants a row for a transaction id another session will later use, because
-- transaction ids are assigned by the server and not chosen by the test.
DROP POLICY catalog_grid_ctx_ledger_own_txid_insert ON catalog_grid_ctx_ledger;
CREATE POLICY catalog_grid_ctx_ledger_own_txid_insert ON catalog_grid_ctx_ledger
  FOR INSERT WITH CHECK (true);
DO $m19$
DECLARE
  v_def  TEXT;
  v_line TEXT := '     AND l.xmin = pg_current_xact_id()::xid';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'catalog_grid_closed_check';
  IF position(v_line in v_def) = 0 THEN
    RAISE EXCEPTION 'M19: the xmin filter is not in the live body, so this mutation would silently test nothing';
  END IF;
  EXECUTE replace(v_def, v_line, '');
END;
$m19$;
