-- DEFECT: renaming a key whose revoke has already passed is refused, although
-- the write touches nothing the invariant is about. True at write time, false
-- later by time alone.
DO $$
DECLARE st TEXT;
BEGIN
  BEGIN
    UPDATE p14s.api_keys SET name = 'renamed-by-owner' WHERE name = 'revoked-not-expired';
    RAISE EXCEPTION 'DEFECT NOT REPRODUCED: the unrelated rename succeeded';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
    RAISE NOTICE 'DEFECT CONFIRMED: an unrelated metadata UPDATE was refused, SQLSTATE %', st;
  END;
END $$;
