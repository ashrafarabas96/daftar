-- =====================================================================
-- Phase 8 — removal of the worker baseline (round 24, O-4)
-- RUN AS daftar_migrator, immediately after the worker case file.
-- =====================================================================
-- The worker file rolls itself back, so the only committed rows are the five
-- this undoes. It REFUSES unless every one of them is gone afterwards, because
-- a teardown that silently leaves a row behind makes the next thing that runs
-- — the race proof, which commits — depend on the order of this file.
--
-- `notification_attempts` is append-only for every principal INCLUDING the
-- owner (triggers `attempts_no_update`, `attempts_no_delete`,
-- `attempts_no_truncate`), so nothing here deletes an attempt: the worker's
-- appended attempt was rolled back with its own transaction, which is the only
-- way it can disappear. That is asserted, not assumed.
-- =====================================================================
SET search_path = p8, public;

BEGIN;

SET LOCAL app.tenant_id   = '11111111-1111-4111-8111-111111111111';
SET LOCAL app.business_id = 'bbbbbbbb-0000-4000-8000-000000000001';
DELETE FROM notification_deliveries WHERE id = '0ddddddd-0000-4000-8000-0000000000a1';
DELETE FROM notifications WHERE id IN ('0fffffff-0000-4000-8000-0000000000a1',
                                       '0fffffff-0000-4000-8000-0000000000a2',
                                       '0fffffff-0000-4000-8000-0000000000a3');

SET LOCAL app.business_id = 'bbbbbbbb-0000-4000-8000-000000000002';
DELETE FROM notification_deliveries WHERE id = '0ddddddd-0000-4000-8000-0000000000b1';
DELETE FROM notifications WHERE id = '0fffffff-0000-4000-8000-0000000000b1';

DO $$
DECLARE n BIGINT;
BEGIN
  PERFORM set_config('app.business_id', 'bbbbbbbb-0000-4000-8000-000000000001', true);
  SELECT count(*) INTO n FROM notifications;
  IF n <> 0 THEN RAISE EXCEPTION 'WORKER TEARDOWN FAIL: % notification row(s) left in B1', n; END IF;
  SELECT count(*) INTO n FROM notification_deliveries;
  IF n <> 0 THEN RAISE EXCEPTION 'WORKER TEARDOWN FAIL: % delivery row(s) left in B1', n; END IF;
  SELECT count(*) INTO n FROM notification_attempts;
  IF n <> 0 THEN
    RAISE EXCEPTION 'WORKER TEARDOWN FAIL: % attempt row(s) left in B1 — the worker file did not roll back, '
                    'and an attempt cannot be deleted by anyone', n;
  END IF;
  PERFORM set_config('app.business_id', 'bbbbbbbb-0000-4000-8000-000000000002', true);
  SELECT count(*) INTO n FROM notifications;
  IF n <> 0 THEN RAISE EXCEPTION 'WORKER TEARDOWN FAIL: % notification row(s) left in B1B', n; END IF;
  SELECT count(*) INTO n FROM notification_deliveries;
  IF n <> 0 THEN RAISE EXCEPTION 'WORKER TEARDOWN FAIL: % delivery row(s) left in B1B', n; END IF;
  RAISE NOTICE 'WORKER TEARDOWN PASS the worker baseline is gone and no attempt survived';
END $$;

COMMIT;
