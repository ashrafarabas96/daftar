DO $$
DECLARE st TEXT; n INT;
BEGIN
  -- the unrelated write now succeeds
  UPDATE p14s.api_keys SET name = 'renamed-by-owner' WHERE name = 'revoked-not-expired';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'LAW VIOLATED: the unrelated rename updated % rows', n; END IF;
  RAISE NOTICE 'LAW HELD: an unrelated metadata UPDATE succeeds';
  -- un-revoking is still refused
  BEGIN
    UPDATE p14s.api_keys SET revoked_at = NULL WHERE name = 'renamed-by-owner';
    RAISE EXCEPTION 'LAW VIOLATED: a revoked key was UN-revoked';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
    RAISE NOTICE 'LAW HELD: un-revoking refused, SQLSTATE %', st;
  END;
  -- moving the revocation LATER is refused
  BEGIN
    UPDATE p14s.api_keys SET revoked_at = now() + interval '1 day' WHERE name = 'renamed-by-owner';
    RAISE EXCEPTION 'LAW VIOLATED: the revocation was moved LATER';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'LAW HELD: moving the revocation later refused';
  END;
  -- moving it EARLIER is allowed
  UPDATE p14s.api_keys SET revoked_at = now() - interval '2 days' WHERE name = 'renamed-by-owner';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'LAW VIOLATED: moving the revocation earlier was refused'; END IF;
  RAISE NOTICE 'LAW HELD: moving the revocation EARLIER is accepted';
END $$;
