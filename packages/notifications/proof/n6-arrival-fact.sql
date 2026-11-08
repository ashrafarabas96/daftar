\set ON_ERROR_STOP on
\timing off
-- =====================================================================
-- P8 round 10 — N-6 direct-SQL proof, PostgreSQL 16 @ en_US.utf8.
-- Proves, on a PROTOTYPE of the §2/§4a relations of P8-DDL-SPEC.md (NOT
-- the repo's frozen migrations, which are byte-immutable and untouched):
--   PART A  the I-3 ladder refuses a regression on notifications.status
--   PART B  N-6 REPRODUCES: with I-8f as specified before this round, a
--           direct UPDATE releases the obligation of a READ delivery and
--           a second channel inserts — a duplicate customer message
--   PART C  with the set-once arrival fact added, the same sequence is
--           REFUSED, and the flag cannot be cleared
--   PART D  the fix does not withhold a genuine pre-arrival fallback
-- Every case names its expected outcome; any deviation aborts non-zero.
-- =====================================================================
CREATE TABLE businesses (id TEXT PRIMARY KEY);
INSERT INTO businesses VALUES ('b1');

CREATE TABLE notifications (
  business_id TEXT NOT NULL REFERENCES businesses(id),
  id          TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued','sent','delivered','read','failed')),
  PRIMARY KEY (business_id, id)
);

-- I-3: the ladder, with the arrival terminal (round 8 correction).
CREATE FUNCTION notifications_status_monotonic() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r_old INT; r_new INT;
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  r_old := CASE OLD.status WHEN 'queued' THEN 0 WHEN 'sent' THEN 1 WHEN 'failed' THEN 2
                           WHEN 'delivered' THEN 3 WHEN 'read' THEN 4 END;
  r_new := CASE NEW.status WHEN 'queued' THEN 0 WHEN 'sent' THEN 1 WHEN 'failed' THEN 2
                           WHEN 'delivered' THEN 3 WHEN 'read' THEN 4 END;
  IF r_new <= r_old THEN
    RAISE EXCEPTION 'notification.status_regression' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notifications_status_monotonic BEFORE UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION notifications_status_monotonic();

CREATE TABLE notification_deliveries (
  business_id            TEXT NOT NULL REFERENCES businesses(id),
  id                     TEXT NOT NULL,
  notification_id        TEXT NOT NULL,
  channel                TEXT NOT NULL,
  delivery_key           TEXT NOT NULL,
  delivery_state         TEXT NOT NULL
    CHECK (delivery_state IN ('queued','sending','accepted','unknown','retry_scheduled',
                              'dead','closed','withheld','suppressed')),
  final_status           TEXT NULL
    CHECK (final_status IS NULL OR final_status IN ('delivered','read','failed')),
  final_status_verified  BOOLEAN NOT NULL DEFAULT false
    CHECK (NOT final_status_verified OR final_status IS NOT NULL),
  PRIMARY KEY (business_id, id),
  FOREIGN KEY (business_id, notification_id) REFERENCES notifications(business_id, id),
  UNIQUE (business_id, delivery_key)
);

-- I-8f EXACTLY AS SPECIFIED BEFORE THIS ROUND (the subject of N-6).
CREATE UNIQUE INDEX deliveries_one_live_channel ON notification_deliveries (business_id, notification_id)
  WHERE delivery_state NOT IN ('dead','withheld','suppressed')
    AND NOT (delivery_state = 'closed' AND final_status = 'failed' AND final_status_verified);

\echo '--- PART A: I-3 refuses a regression where it is enforced'
INSERT INTO notifications VALUES ('b1','n-A','queued');
UPDATE notifications SET status='sent' WHERE id='n-A';
UPDATE notifications SET status='delivered' WHERE id='n-A';
UPDATE notifications SET status='read' WHERE id='n-A';
DO $$ BEGIN
  BEGIN
    UPDATE notifications SET status='failed' WHERE id='n-A';
    RAISE EXCEPTION 'A1 FAIL: read -> failed was ACCEPTED on notifications.status';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'A1 PASS: read -> failed refused (notification.status_regression)';
  END;
END $$;

\echo '--- PART B: N-6 reproduction — the premise is enforced on another relation'
INSERT INTO notifications VALUES ('b1','n-B','queued');
UPDATE notifications SET status='sent'      WHERE id='n-B';
UPDATE notifications SET status='delivered' WHERE id='n-B';
UPDATE notifications SET status='read'      WHERE id='n-B';
INSERT INTO notification_deliveries
  (business_id,id,notification_id,channel,delivery_key,delivery_state,final_status,final_status_verified)
  VALUES ('b1','d-B1','n-B','whatsapp','k-B1','closed','read',true);
-- The customer has READ the message. Now the direct UPDATE I-3 does not govern:
UPDATE notification_deliveries
   SET delivery_state='closed', final_status='failed', final_status_verified=true
 WHERE id='d-B1';
DO $$ DECLARE v TEXT; BEGIN
  SELECT final_status INTO v FROM notification_deliveries WHERE id='d-B1';
  IF v <> 'failed' THEN RAISE EXCEPTION 'B1 FAIL: the UPDATE did not land'; END IF;
  RAISE NOTICE 'B1 REPRODUCED: final_status read -> failed accepted; no trigger, no monotonic rule';
END $$;
DO $$ BEGIN
  INSERT INTO notification_deliveries
    (business_id,id,notification_id,channel,delivery_key,delivery_state,final_status,final_status_verified)
    VALUES ('b1','d-B2','n-B','sms','k-B2','queued',NULL,false);
  RAISE NOTICE 'B2 REPRODUCED: the second channel INSERTED — a customer who READ the message is messaged again';
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'B2 FAIL: the pre-fix schema already refused this, so N-6 is not reproducible and this proof is hollow';
END $$;

\echo '--- PART C: the fix — a set-once arrival fact, read by the release clause'
TRUNCATE notification_deliveries;
ALTER TABLE notification_deliveries
  ADD COLUMN arrival_ever_recorded BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT deliveries_arrival_fact_agrees
    CHECK (final_status IS NULL OR final_status NOT IN ('delivered','read') OR arrival_ever_recorded);

CREATE FUNCTION deliveries_arrival_fact_set_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.arrival_ever_recorded AND NOT NEW.arrival_ever_recorded THEN
    RAISE EXCEPTION 'notification.arrival_fact_cleared' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.final_status IN ('delivered','read') AND NEW.final_status_verified THEN
    NEW.arrival_ever_recorded := true;   -- derived from the landing, never from the caller
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deliveries_arrival_fact_set_once BEFORE UPDATE ON notification_deliveries
  FOR EACH ROW EXECUTE FUNCTION deliveries_arrival_fact_set_once();

DROP INDEX deliveries_one_live_channel;
CREATE UNIQUE INDEX deliveries_one_live_channel ON notification_deliveries (business_id, notification_id)
  WHERE delivery_state NOT IN ('dead','withheld','suppressed')
    AND NOT (delivery_state = 'closed' AND final_status = 'failed'
             AND final_status_verified AND NOT arrival_ever_recorded);

INSERT INTO notifications VALUES ('b1','n-C','queued');
UPDATE notifications SET status='sent'      WHERE id='n-C';
UPDATE notifications SET status='delivered' WHERE id='n-C';
UPDATE notifications SET status='read'      WHERE id='n-C';
INSERT INTO notification_deliveries
  (business_id,id,notification_id,channel,delivery_key,delivery_state,final_status,final_status_verified,arrival_ever_recorded)
  VALUES ('b1','d-C1','n-C','whatsapp','k-C1','closed','read',true,true);
UPDATE notification_deliveries
   SET delivery_state='closed', final_status='failed', final_status_verified=true
 WHERE id='d-C1';
DO $$ DECLARE f BOOLEAN; BEGIN
  SELECT arrival_ever_recorded INTO f FROM notification_deliveries WHERE id='d-C1';
  IF NOT f THEN RAISE EXCEPTION 'C1 FAIL: the arrival fact was lost by the same UPDATE'; END IF;
  RAISE NOTICE 'C1 PASS: the demotion still lands, but the arrival fact survives it';
END $$;
DO $$ BEGIN
  INSERT INTO notification_deliveries
    (business_id,id,notification_id,channel,delivery_key,delivery_state,final_status,final_status_verified)
    VALUES ('b1','d-C2','n-C','sms','k-C2','queued',NULL,false);
  RAISE EXCEPTION 'C2 FAIL: the second channel still inserted — the fix does not hold';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'C2 PASS: the second channel is REFUSED — the obligation is still held';
END $$;
DO $$ BEGIN
  BEGIN
    UPDATE notification_deliveries SET arrival_ever_recorded=false WHERE id='d-C1';
    RAISE EXCEPTION 'C3 FAIL: the arrival fact was cleared';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'C3 PASS: clearing the arrival fact is refused (notification.arrival_fact_cleared)';
  END;
END $$;
DO $$ BEGIN
  BEGIN
    INSERT INTO notification_deliveries
      (business_id,id,notification_id,channel,delivery_key,delivery_state,final_status,final_status_verified,arrival_ever_recorded)
      VALUES ('b1','d-C4','n-C','email','k-C4','closed','delivered',true,false);
    RAISE EXCEPTION 'C4 FAIL: an arrival was recorded with the fact unset';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'C4 PASS: an arrival with the fact unset is refused at INSERT too';
  END;
END $$;

\echo '--- PART D: a GENUINE pre-arrival failure still releases the obligation'
INSERT INTO notifications VALUES ('b1','n-D','queued');
UPDATE notifications SET status='sent'   WHERE id='n-D';
UPDATE notifications SET status='failed' WHERE id='n-D';
INSERT INTO notification_deliveries
  (business_id,id,notification_id,channel,delivery_key,delivery_state,final_status,final_status_verified)
  VALUES ('b1','d-D1','n-D','whatsapp','k-D1','closed','failed',true);
DO $$ BEGIN
  INSERT INTO notification_deliveries
    (business_id,id,notification_id,channel,delivery_key,delivery_state,final_status,final_status_verified)
    VALUES ('b1','d-D2','n-D','sms','k-D2','queued',NULL,false);
  RAISE NOTICE 'D1 PASS: the fallback is still permitted — the fix forbids the SECOND message, not the first';
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'D1 FAIL: a genuinely owed notification is now withheld';
END $$;
DO $$ BEGIN
  BEGIN
    INSERT INTO notification_deliveries
      (business_id,id,notification_id,channel,delivery_key,delivery_state,final_status,final_status_verified)
      VALUES ('b1','d-D3','n-D','email','k-D3','queued',NULL,false);
    RAISE EXCEPTION 'D2 FAIL: a THIRD live channel was permitted on one obligation';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'D2 PASS: only one live channel at a time (I-8f still holds)';
  END;
END $$;
\echo '--- ALL CASES REACHED THEIR STATED OUTCOME'
