-- LAW P14: SELECT is required on a column the query RESTRICTS on, not only returns.
--
-- ROUND-6 CHALLENGE P3-03: the control that makes this law meaningful -- that
-- the same role CAN read the columns it WAS granted, so the refusal is about
-- the restricted column and not about table access -- used to run AFTER the
-- arm had already printed `LAW HELD`. Run against a database whose grants had
-- moved on (p14_resolver holding eight columns that exclude `name`), the arm
-- was refused for the WRONG REASON and the notice said the law held anyway;
-- the script then exited 3 on the control, so the exit code was right and the
-- log line was false. A control that runs after the conclusion cannot defend
-- the conclusion, so it runs FIRST, and the SQLSTATE is asserted rather than
-- printed next to the word "expected".
DO $$
DECLARE got TEXT; st TEXT;
BEGIN
  -- CONTROL FIRST: the granted columns are readable. If this fails, nothing
  -- below is a statement about the restricted column.
  BEGIN
    EXECUTE 'SELECT name FROM p14s.api_keys WHERE business_id = $1 ORDER BY name LIMIT 1'
      INTO got USING '11111111-1111-1111-1111-111111111111'::uuid;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'CONTROL FAILED: p14_resolver cannot read the GRANTED columns (name, business_id) in this state, so a refusal below would say nothing about the RESTRICTED column. Replay from a clean database: ./replay.sh';
  END;
  IF got IS NULL THEN RAISE EXCEPTION 'CONTROL FAILED: granted columns readable but empty — the fixture did not load'; END IF;
  RAISE NOTICE 'CONTROL: granted-column read works, returned %', got;

  -- and only now the law itself
  BEGIN
    EXECUTE 'SELECT name FROM p14s.api_keys WHERE secret_sha256 = $1'
      INTO got USING repeat('a',64);
    RAISE EXCEPTION 'LAW VIOLATED: lookup on an ungranted column SUCCEEDED, returned %', got;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
    IF st <> '42501' THEN
      RAISE EXCEPTION 'LAW UNPROVED: the lookup failed with SQLSTATE %, not 42501 — a failure for another reason is not this law', st;
    END IF;
    RAISE NOTICE 'LAW HELD: refused with SQLSTATE 42501, and the control above proves the granted columns were readable';
  END;
END $$;
