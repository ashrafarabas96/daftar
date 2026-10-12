-- PREREQUISITE: cases/c3_setup.sql  (creates p14s.webhook_deliveries) — this family EXTENDS the C3 relation with outbox_event_id and its FK
-- Declared and ASSERTED because round-3 CHALLENGE P2-02 found the C7 family is
-- a continuation of C3 and nothing in the pack said so: run in isolation it
-- failed with a bare "relation does not exist", and its own proof-of-proof
-- could not detect a missing base table because it only inspected the
-- constraint it adds. An ordering precondition that only ORDER's line numbers
-- encode is an undeclared dependency.
DO $$
BEGIN
  IF to_regclass('p14s.webhook_deliveries') IS NULL THEN
    RAISE EXCEPTION 'PREREQUISITE NOT MET: p14s.webhook_deliveries does not exist — run cases/c3_setup.sql first';
  END IF;
END $$;

-- owner: reproduce the daftar outbox_events shape measured at 93084f8 —
-- a BARE global primary key with a NULLABLE business_id
CREATE TABLE p14s.outbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID,            -- nullable, exactly as measured
  kind TEXT NOT NULL
);
INSERT INTO p14s.outbox_events (id, business_id, kind) VALUES
 ('0e000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','invoice.created'),
 ('0e000000-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','invoice.created'),
 ('0e000000-0000-0000-0000-000000000003', NULL,                                   'platform.event');
-- the only FK a global PK can carry: a GLOBAL single-column reference
ALTER TABLE p14s.webhook_deliveries
  ADD COLUMN outbox_event_id UUID,
  ADD CONSTRAINT webhook_deliveries_outbox_event_fkey
      FOREIGN KEY (outbox_event_id) REFERENCES p14s.outbox_events(id);
DO $$
DECLARE k TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO k FROM pg_constraint
   WHERE conname='webhook_deliveries_outbox_event_fkey';
  IF position('business_id' in k) > 0 THEN
    RAISE EXCEPTION 'UNEXPECTED: the FK is composite — the premise of SEC-02 is wrong'; END IF;
  RAISE NOTICE 'LANDED: the FK is single-column and global: %', k;
END $$;
