-- PREREQUISITE: cases/c3_setup.sql  (creates p14s.webhook_deliveries)
-- Declared and ASSERTED because round-3 CHALLENGE P2-02 found the C7 family is
-- a continuation of C3 and nothing in the pack said so: run in isolation it
-- failed with a bare "relation does not exist", and its own proof-of-proof
-- could not detect a missing base table because it only inspected the
-- constraint it adds. An ordering precondition that only ORDER's line numbers
-- encode is an undeclared dependency.
DO $$
BEGIN
  IF to_regclass('p14s.webhook_deliveries') IS NULL THEN
    RAISE EXCEPTION 'PREREQUISITE NOT MET: p14s.webhook_deliveries does not exist — run cases/c3_setup.sql first';
  END IF;
END $$;

-- FINDING (AL-31, the other direction): app.bypass_rls relaxes only the
-- RESTRICTIVE half. A caller still needs a PERMISSIVE policy to admit it, so
-- bypass alone is NOT a god-mode read on this idiom.
SET app.bypass_rls = 'on';
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM p14s.webhook_deliveries;
  IF n <> 0 THEN RAISE EXCEPTION 'FINDING REFUTED: bypass alone read % rows', n; END IF;
  RAISE NOTICE 'FINDING CONFIRMED: bypass alone reads 0 rows (no PERMISSIVE policy admits this caller)';
END $$;
-- FENCE proper: satisfy the PERMISSIVE tenant_membership policy as well
SET app.tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001';
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM p14s.webhook_deliveries;
  IF n <> 2 THEN RAISE EXCEPTION 'FENCE FAILED: % rows, expected 2', n; END IF;
  RAISE NOTICE 'FENCE: % rows provably exist — a 0-row worker read is a refusal, not an empty table', n;
END $$;
