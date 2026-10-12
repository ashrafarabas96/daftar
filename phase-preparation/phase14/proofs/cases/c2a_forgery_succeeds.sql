-- LAW AL-37: an ABSENT privilege is not a mechanism. Withholding SELECT on
-- secret_sha256 does NOT withhold INSERT into it — the merchant can forge a key
-- whose digest and subject it chose and can never read back.
DO $$
DECLARE n INT;
BEGIN
  EXECUTE $q$ INSERT INTO p14s.api_keys
      (tenant_id, business_id, subject_user_id, secret_sha256, name)
      VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
              '11111111-1111-1111-1111-111111111111',
              '0c000000-0000-0000-0000-0000000000ff',
              repeat('f',64), 'FORGED-BY-MERCHANT') $q$;
  RAISE NOTICE 'DEFECT CONFIRMED: the forging INSERT SUCCEEDED under a narrowed SELECT';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE EXCEPTION 'EXPECTED THE DEFECT, GOT A REFUSAL: the table-wide INSERT was already scoped';
END $$;
