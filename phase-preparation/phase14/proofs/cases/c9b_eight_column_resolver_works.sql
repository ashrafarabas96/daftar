-- THE RESOLUTION: the resolver's query, derived from what the resolver actually
-- DOES, needs EIGHT columns. revoke_scheduled is excluded because the pack's own
-- law forbids any reader consulting it to decide usability; name is management
-- data the business transaction reads later. So §3 was right and §1/§11.1 were
-- wrong — the fix is to narrow §1 and §11.1, not to widen §3.
DO $$
DECLARE r RECORD; usable BOOLEAN;
BEGIN
  EXECUTE $q$ SELECT key_id, id, tenant_id, business_id, subject_user_id,
                     secret_sha256, expires_at, revoked_at
                FROM p14s.api_keys WHERE key_id = $1 $q$
    INTO r USING '0a000000-0000-0000-0000-000000000001'::uuid;
  IF r.key_id IS NULL THEN RAISE EXCEPTION 'RESOLVER ARM FAILED: no row'; END IF;
  usable := (r.revoked_at IS NULL OR r.revoked_at > now())
        AND (r.expires_at IS NULL OR r.expires_at > now());
  IF NOT usable THEN RAISE EXCEPTION 'RESOLVER ARM FAILED: the live key read as unusable'; END IF;
  RAISE NOTICE 'LAW HELD: the eight-column resolver read and the usability predicate both execute; usable = %', usable;
  RAISE NOTICE 'DERIVATION: digest check needs secret_sha256; the lookup needs key_id; the context is tenant_id/business_id/subject_user_id/id; usability needs expires_at/revoked_at. Eight.';
END $$;
