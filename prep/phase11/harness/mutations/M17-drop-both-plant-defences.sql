-- M17 (round 6). The pair of M15 and M16 dropped TOGETHER, which is the whole
-- reason this phase pair-drops: a one-at-a-time sweep cannot see two defences
-- that mask each other (the P5 R9 lesson).
--
-- Expected: PA6-L2 goes red, as under M15 alone, and nothing more. That result
-- is the honest finding of the pair-drop and is reported as such: the two
-- defences are NOT symmetric. The RLS write policy is the one the suite
-- measures; the `xmin` filter has no case that can reach it, because the
-- policy makes the state it defends against unreachable. The pair-drop is
-- what makes that visible instead of letting two green layers imply two
-- tested layers.
DROP POLICY catalog_grid_ctx_ledger_own_txid_insert ON catalog_grid_ctx_ledger;
DO $m17$
DECLARE
  v_def  TEXT;
  v_line TEXT := '     AND l.xmin = pg_current_xact_id()::xid';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'catalog_grid_closed_check';
  IF position(v_line in v_def) = 0 THEN
    RAISE EXCEPTION 'M17: the xmin filter is not in the live body, so this mutation would silently test nothing';
  END IF;
  EXECUTE replace(v_def, v_line, '');
END;
$m17$;
