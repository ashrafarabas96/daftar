-- NEW FINDING against my own §11.1: the column-scoped merchant INSERT set is
-- UNSATISFIABLE. secret_sha256 is NOT NULL and is not in the merchant's INSERT
-- set, so there is NO merchant INSERT that both respects the grant and the
-- constraint. A grant matrix must be satisfiable, not merely safe.
DO $$
DECLARE st TEXT; msg TEXT;
BEGIN
  BEGIN
    EXECUTE $q$ INSERT INTO p14s.api_keys (tenant_id, business_id, name)
       VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
               '11111111-1111-1111-1111-111111111111','merchant-minimal') $q$;
    RAISE EXCEPTION 'EXPECTED UNSATISFIABLE, GOT A SUCCESS';
  EXCEPTION WHEN not_null_violation THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
    RAISE NOTICE 'FINDING CONFIRMED: SQLSTATE % — %', st, msg;
  END;
  -- and supplying it is refused by the grant, so neither branch can succeed
  BEGIN
    EXECUTE $q$ INSERT INTO p14s.api_keys (tenant_id, business_id, name, secret_sha256)
       VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
               '11111111-1111-1111-1111-111111111111','merchant-minimal', repeat('e',64)) $q$;
    RAISE EXCEPTION 'EXPECTED A REFUSAL ON THE OTHER BRANCH';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
    RAISE NOTICE 'OTHER BRANCH ALSO REFUSED: SQLSTATE % — both branches closed', st;
  END;
  RAISE NOTICE 'CONCLUSION: key creation cannot be a direct merchant INSERT';
END $$;
