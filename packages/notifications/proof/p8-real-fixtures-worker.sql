-- =====================================================================
-- Phase 8 — committed baseline for the WORKER case file (round 24, O-4)
-- RUN AS daftar_migrator, AFTER the three rolled-back case files.
-- =====================================================================
-- WHY THIS FILE EXISTS. Round 15's O-4 (P2) measured that `daftar_worker` was
-- never a case principal, while the overlay grants it a column-scoped
-- `UPDATE (status, last_error_code, updated_at)` on `notifications`, an
-- append-only `INSERT` on `notification_attempts` and an `INSERT` on the
-- quarantine. Those grants were live and exercised by nothing. The retired
-- prototype's `W-*` family tested them, and the retirement therefore left
-- eleven acceptance cases with no principal.
--
-- The worker CANNOT create an obligation — that refusal is case W-3 — so its
-- cases need rows that already exist. Each live case file is its own
-- transaction and ends in `ROLLBACK`, so no earlier file can leave a row here.
-- Hence a committed baseline, written by the owner, with three properties that
-- are deliberate and are measured rather than assumed:
--
--   * it is applied AFTER the app, owner and platform files, so no count they
--     assert can see these rows (`A2 sees its own row` counts `notifications`
--     within B1 and expects exactly 1);
--   * it is REMOVED again by `p8-real-fixtures-worker-teardown.sql`, which
--     refuses unless the relations are back to the row counts it found, so
--     nothing that runs after the worker file — the race proof commits —
--     inherits this state either;
--   * it writes no business, no membership and no user, so `P4a`/`P4b`, which
--     count across tenants with the platform's bypass, are untouched.
--
-- Every statement goes through the real policies: the owner is not exempt
-- (`FORCE ROW LEVEL SECURITY`), so the session GUCs below are load-bearing and
-- a wrong one is a refusal rather than a write into the wrong business.
-- =====================================================================
SET search_path = p8, public;

BEGIN;

-- ---- business B1, tenant T1: the worker's own scope ----
SET LOCAL app.tenant_id   = '11111111-1111-4111-8111-111111111111';
SET LOCAL app.business_id = 'bbbbbbbb-0000-4000-8000-000000000001';

-- N_A: the obligation whose status the worker may move, and the one its
-- attempt is appended against.
INSERT INTO notifications (id, tenant_id, business_id, kind, consent_class, customer_id,
                           locale, subject_refs, obligation_key, source_event_id)
VALUES ('0fffffff-0000-4000-8000-0000000000a1',
        '11111111-1111-4111-8111-111111111111', 'bbbbbbbb-0000-4000-8000-000000000001',
        'invoice_issued', 'transactional', 'cccccccc-0000-4000-8000-000000000001',
        'ar', '{}'::jsonb, 'B1|event:w1|invoice_issued|customer:1',
        '0eeeeeee-0000-4000-8000-0000000000a1');

-- N_B: the ladder's upward chain, queued -> sent -> delivered -> read.
INSERT INTO notifications (id, tenant_id, business_id, kind, consent_class, customer_id,
                           locale, subject_refs, obligation_key, source_event_id)
VALUES ('0fffffff-0000-4000-8000-0000000000a2',
        '11111111-1111-4111-8111-111111111111', 'bbbbbbbb-0000-4000-8000-000000000001',
        'payment_overdue', 'transactional', 'cccccccc-0000-4000-8000-000000000001',
        'ar', '{}'::jsonb, 'B1|event:w2|payment_overdue|customer:1',
        '0eeeeeee-0000-4000-8000-0000000000a2');

-- N_D: the failure path, queued -> failed -> delivered, which is the half that
-- keeps the ladder honest: a late arrival is EVIDENCE, not a regression.
INSERT INTO notifications (id, tenant_id, business_id, kind, consent_class, customer_id,
                           locale, subject_refs, obligation_key, source_event_id)
VALUES ('0fffffff-0000-4000-8000-0000000000a3',
        '11111111-1111-4111-8111-111111111111', 'bbbbbbbb-0000-4000-8000-000000000001',
        'booking_reminder', 'operational', 'cccccccc-0000-4000-8000-000000000001',
        'ar', '{}'::jsonb, 'B1|event:w3|booking_reminder|customer:1',
        '0eeeeeee-0000-4000-8000-0000000000a3');

-- D_A: the delivery the worker's attempt hangs off.
INSERT INTO notification_deliveries (id, tenant_id, business_id, notification_id, channel,
                                     provider, delivery_key, delivery_state)
VALUES ('0ddddddd-0000-4000-8000-0000000000a1',
        '11111111-1111-4111-8111-111111111111', 'bbbbbbbb-0000-4000-8000-000000000001',
        '0fffffff-0000-4000-8000-0000000000a1', 'whatsapp', 'meta_cloud',
        'B1|event:w1|invoice_issued|customer:1::whatsapp', 'queued');

-- ---- business B1B, same tenant: the business with NO configured bound ----
-- `p8-real-fixtures-owner.sql` writes B1B's settings row with
-- `max_consent_age_seconds` NULL, which is what case W-7 needs: the consent
-- staleness bound is configuration and it FAILS CLOSED.
SET LOCAL app.business_id = 'bbbbbbbb-0000-4000-8000-000000000002';

INSERT INTO notifications (id, tenant_id, business_id, kind, consent_class, customer_id,
                           locale, subject_refs, obligation_key, source_event_id)
VALUES ('0fffffff-0000-4000-8000-0000000000b1',
        '11111111-1111-4111-8111-111111111111', 'bbbbbbbb-0000-4000-8000-000000000002',
        'invoice_issued', 'transactional', 'cccccccc-0000-4000-8000-000000000002',
        'en', '{}'::jsonb, 'B1B|event:w4|invoice_issued|customer:2',
        '0eeeeeee-0000-4000-8000-0000000000b1');

INSERT INTO notification_deliveries (id, tenant_id, business_id, notification_id, channel,
                                     provider, delivery_key, delivery_state)
VALUES ('0ddddddd-0000-4000-8000-0000000000b1',
        '11111111-1111-4111-8111-111111111111', 'bbbbbbbb-0000-4000-8000-000000000002',
        '0fffffff-0000-4000-8000-0000000000b1', 'sms', 'twilio',
        'B1B|event:w4|invoice_issued|customer:2::sms', 'queued');

COMMIT;
