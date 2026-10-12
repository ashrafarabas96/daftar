-- PREREQUISITE: cases/c1_grant_narrow.sql (p14s.api_keys exists and p14_resolver
-- holds SELECT on name and business_id)
--
-- MUTATION for the red proof of c1a's SQLSTATE assertion
-- (COORD-DIFF-REVIEW R1 P3-06). The assertion `IF st <> '42501'` was
-- unreachable while the handler caught only `insufficient_privilege`; the
-- handler is `WHEN OTHERS` now, and this mutation is what SHOWS the arm can
-- fire. Renaming the restricted column makes the lookup fail with 42703
-- (undefined_column) while the CONTROL columns (name, business_id) stay
-- readable -- so the control passes, the law arm fails for the wrong reason,
-- and c1a must report LAW UNPROVED instead of LAW HELD.
DO $$
BEGIN
  IF to_regclass('p14s.api_keys') IS NULL THEN
    RAISE EXCEPTION 'PREREQUISITE NOT MET: p14s.api_keys does not exist — run cases/c1_grant_narrow.sql first';
  END IF;
END $$;

ALTER TABLE p14s.api_keys RENAME COLUMN secret_sha256 TO secret_sha256_renamed;

-- PROOF OF PROOF: the mutation landed, read from the catalogue rather than
-- assumed, and the control columns are still there.
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema='p14s' AND table_name='api_keys' AND column_name='secret_sha256';
  IF n <> 0 THEN RAISE EXCEPTION 'MUTATION DID NOT LAND: secret_sha256 still exists'; END IF;
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema='p14s' AND table_name='api_keys' AND column_name='secret_sha256_renamed';
  IF n <> 1 THEN RAISE EXCEPTION 'MUTATION DID NOT LAND: secret_sha256_renamed absent'; END IF;
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema='p14s' AND table_name='api_keys' AND column_name IN ('name','business_id');
  IF n <> 2 THEN RAISE EXCEPTION 'MUTATION TOO WIDE: the control columns are gone, so the red proof would prove the control, not the law'; END IF;
  RAISE NOTICE 'MUTATION LANDED: secret_sha256 -> secret_sha256_renamed, control columns intact';
END $$;
