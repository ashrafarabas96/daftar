-- the same forging INSERT must now be refused
DO $$
DECLARE st TEXT;
BEGIN
  BEGIN
    EXECUTE $q$ INSERT INTO p14s.api_keys
        (tenant_id, business_id, subject_user_id, secret_sha256, name)
        VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
                '11111111-1111-1111-1111-111111111111',
                '0c000000-0000-0000-0000-0000000000ff',
                repeat('f',64), 'FORGED-BY-MERCHANT') $q$;
    RAISE EXCEPTION 'LAW VIOLATED: the forging INSERT still succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
    RAISE NOTICE 'LAW HELD: forgery refused with SQLSTATE %', st;
  END;
  -- control: the columns the merchant MAY set still work
  EXECUTE $q$ INSERT INTO p14s.api_keys (tenant_id, business_id, name)
     VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
             '11111111-1111-1111-1111-111111111111','merchant-legitimate') $q$;
  RAISE NOTICE 'CONTROL: the permitted column set still inserts';
EXCEPTION WHEN not_null_violation THEN
  RAISE NOTICE 'CONTROL: refused by NOT NULL on a column the merchant may not set (secret_sha256) — expected';
END $$;
