-- M11 (round 5, rewritten for the round-6 store). The red proof of the
-- write-identity arm itself.
--
-- Round 5's version replaced catalog_grid_closed_check with a pasted copy of
-- its body minus the identity test. That is a second implementation of a
-- function this phase keeps changing, and a pasted copy drifts: it would keep
-- reding long after the real function moved on, and the log would still say
-- the guard was tested. So the mutation now defeats the arm at its narrowest
-- point instead -- the identity function stops distinguishing sessions:
-- every identity becomes equal, unanimity is trivially satisfied, and the
-- comparison with the identity at COMMIT always holds.
--
-- Expected: every case that rests on the arm goes red by name, including the
-- round-5 challenger's exploit, the DELETE sibling, and the round-6 forgeries
-- PA6-05, PA6-06 and PA6-09, whose refusal comes from this comparison and not
-- from the GUC they forge. The RLS-scoping control stays green: the read is
-- scoped, not broken, and this mutation does not touch row-level security.
--
-- Note for a reader: a constant identity is NOT the same mutation as dropping
-- the ledger. The ledger still records a row per statement; what is gone is
-- its ability to tell two sessions apart. That is the arm being tested.
CREATE OR REPLACE FUNCTION catalog_grid_ctx_identity()
RETURNS TEXT
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT 'one-identity-for-every-session'::text;
$fn$;
