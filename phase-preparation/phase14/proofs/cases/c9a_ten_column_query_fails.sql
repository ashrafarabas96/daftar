-- P1-01, EXECUTED: §1/§11.1's ten-column resolver SELECT under §3's eight-column
-- grant. The authentication path refuses EVERY request.
DO $$
DECLARE r RECORD; st TEXT;
BEGIN
  BEGIN
    EXECUTE $q$ SELECT key_id, id, tenant_id, business_id, subject_user_id, secret_sha256,
                       expires_at, revoked_at, revoke_scheduled, name
                  FROM p14s.api_keys WHERE key_id = $1 $q$
      INTO r USING '0a000000-0000-0000-0000-000000000001'::uuid;
    RAISE EXCEPTION 'P1-01 REFUTED: the ten-column query succeeded under the eight-column grant';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
    RAISE NOTICE 'P1-01 CONFIRMED: the ten-column auth query is refused with SQLSTATE % — the auth path refuses every request', st;
  END;
  -- isolate each omitted column, so the cause is named and not inferred
  BEGIN
    EXECUTE 'SELECT name FROM p14s.api_keys WHERE key_id = $1' INTO r
      USING '0a000000-0000-0000-0000-000000000001'::uuid;
    RAISE EXCEPTION 'name was readable';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'CAUSE: name is not granted'; END;
  BEGIN
    EXECUTE 'SELECT revoke_scheduled FROM p14s.api_keys WHERE key_id = $1' INTO r
      USING '0a000000-0000-0000-0000-000000000001'::uuid;
    RAISE EXCEPTION 'revoke_scheduled was readable';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'CAUSE: revoke_scheduled is not granted'; END;
END $$;
