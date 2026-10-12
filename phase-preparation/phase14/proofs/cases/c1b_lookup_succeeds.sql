-- positive arm: with the full ten-column grant the resolver read works
DO $$
DECLARE r RECORD;
BEGIN
  EXECUTE 'SELECT key_id, id, tenant_id, business_id, subject_user_id, expires_at,
                  revoked_at, revoke_scheduled, name
             FROM p14s.api_keys WHERE secret_sha256 = $1'
    INTO r USING repeat('a',64);
  IF r.name IS DISTINCT FROM 'live-never-expires' THEN
    RAISE EXCEPTION 'POSITIVE ARM FAILED: got %', r;
  END IF;
  RAISE NOTICE 'LAW HELD: resolver read returned % (key_id %, id %)', r.name, r.key_id, r.id;
END $$;
