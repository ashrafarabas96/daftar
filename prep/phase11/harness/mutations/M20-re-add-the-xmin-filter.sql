-- M20 (round 7). The INVERSE of what M16 used to be, and the reason M16 and
-- M19 are gone from this directory.
--
-- The sixth round shipped the deferred check with
-- `AND l.xmin = pg_current_xact_id()::xid` beside the `txid` predicate and
-- called it a second defence against a planted row. M16 dropped that clause
-- and reded nothing, and round 6 concluded from the green that the clause was
-- defence in depth whose effect was UNMEASURED. That conclusion was wrong in
-- a way worth writing down: a layer no instrument reaches is a layer whose
-- behaviour is unknown IN BOTH DIRECTIONS, and "unmeasured" is not "inert".
-- The seventh challenge round reached it, and the clause was both a fail-open
-- and a refusal of lawful work, because `pg_current_xact_id()` returns the
-- TOP-LEVEL transaction id while a row written inside a SUBtransaction
-- carries the subtransaction's id as `xmin`.
--
-- So the clause is deleted from the pack, and this file is the red proof of
-- the DELETION: it puts the clause back, and the suite must go RED. A
-- mutation that restores a defect is as much a red proof as one that removes
-- a guard, and it is the only kind available once the remedy is an absence.
--
-- MEASURED with this file applied through the step-5c hook on a fresh
-- database (figures in P11-LIVE-DDL-PROOF.md 15.3). Pack A 115 cases,
-- 6 failed on pass 1 and 21 on pass 2; Pack B 53 cases 0 failed on both;
-- EXIT_PROOFS_A 1, EXIT_SCRIPT 1; digest before 4f3ea2f9... after cfb0e4d7...
-- The two ATTRIBUTABLE flips, which are the point of the file:
--   PA7-S1 (the harmful chain inside a RELEASEd savepoint) fails with
--          `no error` -- i.e. the exploit COMMITS again. The fail-open is
--          restored, and PA7-S6 reads the state it left: sp=2, outside=1,
--          one live variant outside its grid.
--   PA7-S3 (a wholly lawful build inside a RELEASEd savepoint) is REFUSED.
--          The refusal of lawful work is restored.
-- And the honest limit of the other arms, stated rather than counted: once
-- PA7-S1 commits, PA7-S2 and PA7-S8 fail on `duplicate key value violates
-- unique constraint` against the state PA7-S1 left behind, and PA7-S6's
-- assertion fails because that state exists. Those three failures are
-- COLLATERAL of the fail-open landing, not three independent measurements of
-- it -- every arm runs on one shared database, and an exploit that commits
-- changes what the later arms meet. The pair that attributes the defect to
-- the subtransaction and to nothing else is PA7-S1 against PA7-S2 on the
-- UNMUTATED schema, where both are refused.
-- The surgery is done on the LIVE body (`pg_get_functiondef`) rather than on a
-- pasted copy, and it refuses outright if the body it finds is not the body it
-- expects, so this file cannot quietly test nothing after the function
-- changes.
DO $m20$
DECLARE
  v_def  TEXT;
  v_new  TEXT;
  v_from TEXT := '   WHERE l.txid = pg_current_xact_id();';
  v_to   TEXT := '   WHERE l.txid = pg_current_xact_id()' || chr(10)
                 || '     AND l.xmin = pg_current_xact_id()::xid;';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'catalog_grid_closed_check';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'M20: catalog_grid_closed_check is not in public; the mutation has no subject';
  END IF;
  IF position(v_from in v_def) = 0 THEN
    RAISE EXCEPTION 'M20: the ledger read is not the one this mutation targets, so it would silently test nothing';
  END IF;
  IF position(v_to in v_def) <> 0 THEN
    RAISE EXCEPTION 'M20: the xmin filter is ALREADY in the live body; the remedy this file red-proofs is not in place';
  END IF;
  v_new := replace(v_def, v_from, v_to);
  EXECUTE v_new;
  -- And it proves it mutated, by name, in the direction it claims.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'catalog_grid_closed_check';
  IF position(v_to in v_def) = 0 THEN
    RAISE EXCEPTION 'M20: the replacement did not take; the xmin filter is not in the live body';
  END IF;
END;
$m20$;
