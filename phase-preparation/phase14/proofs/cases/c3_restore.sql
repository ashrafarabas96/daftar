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

DROP POLICY business_isolation ON p14s.webhook_deliveries;
CREATE POLICY business_isolation ON p14s.webhook_deliveries AS RESTRICTIVE FOR ALL
  USING      (p14s.app_bypass() OR business_id::text = p14s.app_business())
  WITH CHECK (p14s.app_bypass() OR business_id::text = p14s.app_business());
DO $$
DECLARE u TEXT;
BEGIN
  SELECT qual INTO u FROM pg_policies WHERE tablename='webhook_deliveries' AND policyname='business_isolation';
  IF position('p14_worker' in u) > 0 THEN RAISE EXCEPTION 'MUTATION DID NOT LAND: disjunct still present'; END IF;
  RAISE NOTICE 'LANDED: restored to USING without the worker disjunct';
END $$;
