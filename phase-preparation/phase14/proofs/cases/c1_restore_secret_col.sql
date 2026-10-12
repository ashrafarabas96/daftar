-- Revert of cases/c1_rename_secret_col.sql, with its own proof of proof.
DO $$
BEGIN
  IF to_regclass('p14s.api_keys') IS NULL THEN
    RAISE EXCEPTION 'PREREQUISITE NOT MET: p14s.api_keys does not exist';
  END IF;
END $$;

ALTER TABLE p14s.api_keys RENAME COLUMN secret_sha256_renamed TO secret_sha256;

DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema='p14s' AND table_name='api_keys' AND column_name='secret_sha256';
  IF n <> 1 THEN RAISE EXCEPTION 'REVERT DID NOT LAND: secret_sha256 absent — every later case would measure a mutated fixture'; END IF;
  RAISE NOTICE 'REVERT LANDED: secret_sha256 restored';
END $$;
