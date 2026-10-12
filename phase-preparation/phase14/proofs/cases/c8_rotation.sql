-- LAW: rotation and revocation across the four instants, evaluated AT a fixed
-- instant and never at a moving now(). Plus the composite FK on the rotation link.
DO $$
DECLARE T TIMESTAMPTZ := '2026-11-01T00:00:00Z';
        oldid UUID; newid UUID; usable BOOLEAN; st TEXT; n INT;
BEGIN
  -- the key being rotated out: revocation SCHEDULED at T, intent recorded
  INSERT INTO p14s.api_keys (tenant_id, business_id, subject_user_id, secret_sha256,
                             revoked_at, revoke_scheduled, name)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
          '0c000000-0000-0000-0000-000000000001', repeat('1',64), T, true, 'rotating-out')
  RETURNING id INTO oldid;
  -- the replacement, linked by the COMPOSITE key
  INSERT INTO p14s.api_keys (tenant_id, business_id, subject_user_id, secret_sha256,
                             name, replaces_api_key_id)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
          '0c000000-0000-0000-0000-000000000001', repeat('2',64), 'rotating-in', oldid)
  RETURNING id INTO newid;

  -- INSTANT 1: well before T — the old key is still usable, the intent flag is
  -- recorded and is NOT consulted
  SELECT (revoked_at IS NULL OR revoked_at > T - interval '1 day')
     AND (expires_at IS NULL OR expires_at > T - interval '1 day') INTO usable
    FROM p14s.api_keys WHERE id = oldid;
  IF NOT usable THEN RAISE EXCEPTION 'INSTANT 1 FAILED: usable before the scheduled revoke'; END IF;
  RAISE NOTICE 'INSTANT 1 (T-1d): old key usable = % (revoke_scheduled is recorded, not consulted)', usable;

  -- INSTANT 2: one microsecond before T — still usable
  SELECT (revoked_at IS NULL OR revoked_at > T - interval '1 microsecond') INTO usable
    FROM p14s.api_keys WHERE id = oldid;
  IF NOT usable THEN RAISE EXCEPTION 'INSTANT 2 FAILED'; END IF;
  RAISE NOTICE 'INSTANT 2 (T-1us): old key usable = %', usable;

  -- INSTANT 3: exactly T — NOT usable. '>' not '>='.
  SELECT (revoked_at IS NULL OR revoked_at > T) INTO usable
    FROM p14s.api_keys WHERE id = oldid;
  IF usable THEN RAISE EXCEPTION 'INSTANT 3 FAILED: usable AT the revocation instant'; END IF;
  RAISE NOTICE 'INSTANT 3 (T exactly): old key usable = % — revoked at its own instant', usable;

  -- INSTANT 4: after T — still not usable, and revoke_scheduled is STILL true.
  -- The boolean does not become false on its own; a passed schedule IS a revocation.
  SELECT (revoked_at IS NULL OR revoked_at > T + interval '1 day'), revoke_scheduled
    INTO usable, st FROM p14s.api_keys WHERE id = oldid;
  IF usable THEN RAISE EXCEPTION 'INSTANT 4 FAILED'; END IF;
  RAISE NOTICE 'INSTANT 4 (T+1d): old key usable = %, revoke_scheduled still = % — a passed schedule IS a revocation', usable, st;

  -- the replacement is usable at every one of the four instants
  SELECT count(*) INTO n FROM p14s.api_keys
   WHERE id = newid
     AND (revoked_at IS NULL) AND (expires_at IS NULL);
  IF n <> 1 THEN RAISE EXCEPTION 'ROTATION FAILED: the replacement is not unconditionally usable'; END IF;
  RAISE NOTICE 'ROTATION: the replacement is usable across all four instants — the overlap window is real';

  -- the rotation link is COMPOSITE: business 2 may not name business 1's key
  BEGIN
    INSERT INTO p14s.api_keys (tenant_id, business_id, subject_user_id, secret_sha256,
                               name, replaces_api_key_id)
    VALUES ('aaaaaaaa-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222',
            '0c000000-0000-0000-0000-000000000001', repeat('3',64), 'cross-business-rotation', oldid);
    RAISE EXCEPTION 'LAW VIOLATED: business 2 rotated business 1 key';
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
    RAISE NOTICE 'LAW HELD: a cross-business rotation link is refused by the COMPOSITE FK, SQLSTATE %', st;
  END;
  -- and a NULL link is accepted: an ordinary first key replaces nothing
  INSERT INTO p14s.api_keys (tenant_id, business_id, subject_user_id, secret_sha256, name)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222',
          '0c000000-0000-0000-0000-000000000001', repeat('4',64), 'first-key-no-predecessor');
  RAISE NOTICE 'CONTROL: a NULL rotation link is accepted (MATCH SIMPLE) — a first key replaces nothing';
END $$;
