-- PREREQUISITE: cases/c7_setup.sql  (creates p14s.webhook_deliveries)
-- Declared and ASSERTED because round-3 CHALLENGE P2-02 found the C7 family is
-- a continuation of C3 and nothing in the pack said so: run in isolation it
-- failed with a bare "relation does not exist", and its own proof-of-proof
-- could not detect a missing base table because it only inspected the
-- constraint it adds. An ordering precondition that only ORDER's line numbers
-- encode is an undeclared dependency.
DO $$
BEGIN
  IF to_regclass('p14s.webhook_deliveries') IS NULL THEN
    RAISE EXCEPTION 'PREREQUISITE NOT MET: p14s.webhook_deliveries does not exist — run cases/c7_setup.sql first';
  END IF;
END $$;

-- owner: the §7a proposal — a BEFORE INSERT assertion, NOT a SECURITY DEFINER
DELETE FROM p14s.webhook_deliveries WHERE endpoint_id='0d000000-0000-0000-0000-00000000000a';
CREATE OR REPLACE FUNCTION p14s.assert_outbox_same_business() RETURNS TRIGGER
LANGUAGE plpgsql AS $f$
DECLARE src UUID; found BOOLEAN;
BEGIN
  IF NEW.outbox_event_id IS NULL THEN RETURN NEW; END IF;
  SELECT business_id, true INTO src, found FROM p14s.outbox_events WHERE id = NEW.outbox_event_id;
  -- AL-38: an ABSENT record is a refusal, never a reconstruction
  IF NOT coalesce(found,false) THEN
    RAISE EXCEPTION 'OUTBOX_EVENT_NOT_VISIBLE' USING ERRCODE = '23503';
  END IF;
  IF src IS NOT DISTINCT FROM NEW.business_id THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'OUTBOX_EVENT_BUSINESS_MISMATCH' USING ERRCODE = '23514';
END $f$;
CREATE TRIGGER t_outbox_same_business BEFORE INSERT ON p14s.webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION p14s.assert_outbox_same_business();
DO $$
DECLARE sd BOOLEAN;
BEGIN
  SELECT prosecdef INTO sd FROM pg_proc WHERE proname='assert_outbox_same_business';
  IF sd THEN RAISE EXCEPTION 'LAW VIOLATED: the assertion is SECURITY DEFINER'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='t_outbox_same_business' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'MUTATION DID NOT LAND: trigger absent'; END IF;
  RAISE NOTICE 'LANDED: BEFORE INSERT assertion present and NOT SECURITY DEFINER';
END $$;
