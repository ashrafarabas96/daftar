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

-- LAW AL-31: a RESTRICTIVE policy is not bypassed by adding a PERMISSIVE one.
-- The worker has NO app.business_id and NO bypass, exactly withWorkerTransaction.
DO $$
DECLARE n INT;
BEGIN
  IF current_setting('app.business_id', true) IS NOT NULL
     AND current_setting('app.business_id', true) <> '' THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: a business scope is set'; END IF;
  SELECT count(*) INTO n FROM p14s.webhook_deliveries;
  IF n <> 0 THEN
    RAISE EXCEPTION 'LAW VIOLATED: the PERMISSIVE policy admitted % row(s) past the RESTRICTIVE one', n;
  END IF;
  RAISE NOTICE 'LAW HELD: 0 rows — PERMISSIVE worker_delivery is inert against RESTRICTIVE business_isolation';
END $$;
