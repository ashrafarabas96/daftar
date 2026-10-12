-- PREREQUISITE: fixture.sql  (creates p14s.api_keys)
-- Declared and ASSERTED because round-3 CHALLENGE P2-02 found the C7 family is
-- a continuation of C3 and nothing in the pack said so: run in isolation it
-- failed with a bare "relation does not exist", and its own proof-of-proof
-- could not detect a missing base table because it only inspected the
-- constraint it adds. An ordering precondition that only ORDER's line numbers
-- encode is an undeclared dependency.
DO $$
BEGIN
  IF to_regclass('p14s.api_keys') IS NULL THEN
    RAISE EXCEPTION 'PREREQUISITE NOT MET: p14s.api_keys does not exist — run fixture.sql first';
  END IF;
END $$;

-- owner: the COMPOSITE rotation FK that case c8_rotation tests.
-- CHALLENGE P1-02: this constraint previously existed only in an ad-hoc psql
-- command, so c8_rotation's recorded exit 0 could not be regenerated from the
-- committed files. A refusal arm whose constraint is never proved to exist is
-- the §4 lesson in the other direction: an unfenced PRESENT result settles
-- nothing either.
ALTER TABLE p14s.api_keys
  ADD CONSTRAINT api_keys_replaces_fkey
  FOREIGN KEY (business_id, replaces_api_key_id)
  REFERENCES p14s.api_keys(business_id, id);
DO $$
DECLARE def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conname = 'api_keys_replaces_fkey';
  IF def IS NULL THEN RAISE EXCEPTION 'MUTATION DID NOT LAND: the constraint does not exist'; END IF;
  IF position('business_id' in def) = 0 THEN
    RAISE EXCEPTION 'MUTATION DID NOT LAND: the FK is not composite: %', def; END IF;
  RAISE NOTICE 'LANDED: %', def;
END $$;
