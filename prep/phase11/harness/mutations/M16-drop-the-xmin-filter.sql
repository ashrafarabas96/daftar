-- M16 (round 6). The SECOND defence against a planted row: the deferred check
-- counts only ledger rows whose system column `xmin` equals this
-- transaction's id, so a row that exists for this `txid` without having been
-- written by this transaction is ignored rather than counted.
--
-- The mutation is applied by TEXT SURGERY on the live function body rather
-- than by pasting a copy of it. A pasted copy is a second implementation that
-- drifts: it would keep reding long after the real function changed, and the
-- log would still say the guard was tested. This way the mutation refuses
-- outright if the line it targets is not in the body it finds.
--
-- Expected, and this is the honest part: **nothing reds.** The RLS write
-- policy of M15 makes the plant impossible in the first place, so no case in
-- the suite can reach a state where the `xmin` filter is the arm that
-- answers. That makes it defence in depth whose effect is UNMEASURED, not a
-- guard this suite proves, and it is named as a residual in
-- P11-LIVE-DDL-PROOF.md 14.5 rather than counted as a layer that was tested.
-- A mutation that reds nothing is information, which is why the hook digests
-- the schema and refuses a mutation that changed nothing at all (M10): this
-- one DOES change the schema, and reds no case.
DO $m16$
DECLARE
  v_def  TEXT;
  v_new  TEXT;
  v_line TEXT := '     AND l.xmin = pg_current_xact_id()::xid';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'catalog_grid_closed_check';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'M16: catalog_grid_closed_check is not in public; the mutation has no subject';
  END IF;
  IF position(v_line in v_def) = 0 THEN
    RAISE EXCEPTION 'M16: the xmin filter is not in the live body, so this mutation would silently test nothing';
  END IF;
  v_new := replace(v_def, v_line, '');
  EXECUTE v_new;
  -- And the mutation proves it mutated, by name, in the direction it claims.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'catalog_grid_closed_check';
  IF position(v_line in v_def) <> 0 THEN
    RAISE EXCEPTION 'M16: the replacement did not take; the xmin filter is still in the live body';
  END IF;
END;
$m16$;
