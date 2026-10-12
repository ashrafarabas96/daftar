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

-- owner: the 0014/0020 pattern, but the STRICTER variant Phase 14 recommends —
-- the role disjunct in USING ONLY, never in WITH CHECK
DROP POLICY business_isolation ON p14s.webhook_deliveries;
CREATE POLICY business_isolation ON p14s.webhook_deliveries AS RESTRICTIVE FOR ALL
  USING      (p14s.app_bypass() OR business_id::text = p14s.app_business()
              OR current_user = 'p14_worker')
  WITH CHECK (p14s.app_bypass() OR business_id::text = p14s.app_business());
DO $$
DECLARE u TEXT; c TEXT;
BEGIN
  SELECT qual, with_check INTO u, c FROM pg_policies
   WHERE tablename='webhook_deliveries' AND policyname='business_isolation';
  IF position('p14_worker' in u) = 0 THEN
    RAISE EXCEPTION 'MUTATION DID NOT LAND: USING lacks the disjunct'; END IF;
  IF position('p14_worker' in c) > 0 THEN
    RAISE EXCEPTION 'MUTATION WENT TOO FAR: WITH CHECK carries the disjunct'; END IF;
  RAISE NOTICE 'LANDED: disjunct in USING only (WITH CHECK untouched)';
END $$;
