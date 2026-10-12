-- LAW: the boundary instant. A key is usable while expires_at is in the FUTURE;
-- at exactly expires_at it is NOT usable. '>' is correct, '>=' is off by one instant.
DO $$
DECLARE T TIMESTAMPTZ := '2026-10-12T12:00:00Z';
        gt INT; ge INT;
BEGIN
  CREATE TEMP TABLE c5 (name TEXT, expires_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ);
  INSERT INTO c5 VALUES ('at-the-instant', T, NULL),
                        ('one-us-before',  T + interval '1 microsecond', NULL),
                        ('one-us-after',   T - interval '1 microsecond', NULL);
  -- evaluated AT the instant T, not at a moving now()
  SELECT count(*) INTO gt FROM c5 WHERE name='at-the-instant' AND (expires_at IS NULL OR expires_at >  T);
  SELECT count(*) INTO ge FROM c5 WHERE name='at-the-instant' AND (expires_at IS NULL OR expires_at >= T);
  IF gt <> 0 THEN RAISE EXCEPTION 'LAW VIOLATED: ">" accepted the key AT its expiry instant'; END IF;
  IF ge <> 1 THEN RAISE EXCEPTION 'CONTROL FAILED: ">=" did not accept it, so the arms are not distinguishing'; END IF;
  RAISE NOTICE 'LAW HELD: at the expiry instant ">" refuses (0) and ">=" would accept (1) — the two differ by exactly this key';
  -- the neighbours settle the direction
  SELECT count(*) INTO gt FROM c5 WHERE name='one-us-before' AND expires_at > T;
  IF gt <> 1 THEN RAISE EXCEPTION 'LAW VIOLATED: a key expiring 1us later was refused'; END IF;
  SELECT count(*) INTO gt FROM c5 WHERE name='one-us-after' AND expires_at > T;
  IF gt <> 0 THEN RAISE EXCEPTION 'LAW VIOLATED: a key expired 1us ago was accepted'; END IF;
  RAISE NOTICE 'LAW HELD: 1us before T usable, 1us after T refused — microsecond resolution confirmed';
END $$;
