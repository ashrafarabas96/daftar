-- LAW P14: SELECT is required on a column the query RESTRICTS on, not only returns.
DO $$
DECLARE got TEXT; st TEXT;
BEGIN
  BEGIN
    EXECUTE 'SELECT name FROM p14s.api_keys WHERE secret_sha256 = $1'
      INTO got USING repeat('a',64);
    RAISE EXCEPTION 'LAW VIOLATED: lookup on an ungranted column SUCCEEDED, returned %', got;
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
    RAISE NOTICE 'LAW HELD: refused with SQLSTATE % (expected 42501)', st;
  END;
  -- and the same role CAN read the columns it was granted, so the refusal is
  -- about the restricted column and not about table access at all
  EXECUTE 'SELECT name FROM p14s.api_keys WHERE business_id = $1 ORDER BY name LIMIT 1'
    INTO got USING '11111111-1111-1111-1111-111111111111'::uuid;
  IF got IS NULL THEN RAISE EXCEPTION 'CONTROL FAILED: granted columns unreadable'; END IF;
  RAISE NOTICE 'CONTROL: granted-column read works, returned %', got;
END $$;
