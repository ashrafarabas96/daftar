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
