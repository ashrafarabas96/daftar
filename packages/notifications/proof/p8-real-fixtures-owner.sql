-- =====================================================================
-- Phase 8 — fixtures on the REAL frozen relations (part 2: the scoped half)
-- RUN AS daftar_migrator, with the session GUCs set per business.
-- =====================================================================
-- Part 1 explains why this is a second file. Two more facts were MEASURED
-- while writing it, and both are owner items, not things to paper over here:
--
--   * `customers` grants `daftar_platform` no privilege at all, so the
--     provisioning identity cannot write a customer.
--   * `notification_settings` is a per-business CONFIGURATION relation and the
--     frozen role set contains no principal that may write it: this file
--     writes it as the owner, which is not a deployment path. Phase 8 needs a
--     writer named for it at promotion. Recorded in the handoff, not invented.
--
-- Every statement below goes through the real policies: `tenant_membership`
-- (PERMISSIVE) and `business_isolation_insert` (RESTRICTIVE) on `customers`
-- both read the session GUCs, so a wrong GUC here is a refusal, not a silent
-- write into the wrong business.

-- ---- business B1, tenant T1 ----
SET LOCAL app.tenant_id   = '11111111-1111-4111-8111-111111111111';
SET LOCAL app.business_id = 'bbbbbbbb-0000-4000-8000-000000000001';

INSERT INTO customers (tenant_id, business_id, id, name, phone, status, revision,
                       create_intent_sha256, last_intent_sha256,
                       business_transaction_id, created_by, updated_by) VALUES
  ('11111111-1111-4111-8111-111111111111', 'bbbbbbbb-0000-4000-8000-000000000001',
   'cccccccc-0000-4000-8000-000000000001', 'P8 Customer One', '+962790000001', 'active', 1,
   repeat('1', 64), repeat('1', 64),
   '0ddddddd-0000-4000-8000-000000000001',
   'aaaaaaaa-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-00000000000a');

INSERT INTO notification_settings (business_id, tenant_id, max_consent_age_seconds) VALUES
  ('bbbbbbbb-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 2592000);

-- ---- business B1B, same tenant T1 ----
SET LOCAL app.business_id = 'bbbbbbbb-0000-4000-8000-000000000002';
INSERT INTO customers (tenant_id, business_id, id, name, phone, status, revision,
                       create_intent_sha256, last_intent_sha256,
                       business_transaction_id, created_by, updated_by) VALUES
  ('11111111-1111-4111-8111-111111111111', 'bbbbbbbb-0000-4000-8000-000000000002',
   'cccccccc-0000-4000-8000-000000000002', 'P8 Customer One B', '+962790000002', 'active', 1,
   repeat('2', 64), repeat('2', 64),
   '0ddddddd-0000-4000-8000-000000000002',
   'aaaaaaaa-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-00000000000a');
INSERT INTO notification_settings (business_id, tenant_id, max_consent_age_seconds) VALUES
  ('bbbbbbbb-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', NULL);

-- ---- business B2, tenant T2 ----
SET LOCAL app.tenant_id   = '22222222-2222-4222-8222-222222222222';
SET LOCAL app.business_id = 'bbbbbbbb-0000-4000-8000-000000000003';
INSERT INTO customers (tenant_id, business_id, id, name, phone, status, revision,
                       create_intent_sha256, last_intent_sha256,
                       business_transaction_id, created_by, updated_by) VALUES
  ('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-0000-4000-8000-000000000003',
   'cccccccc-0000-4000-8000-000000000003', 'P8 Customer Two', '+905000000003', 'active', 1,
   repeat('3', 64), repeat('3', 64),
   '0ddddddd-0000-4000-8000-000000000003',
   'aaaaaaaa-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-00000000000a');
INSERT INTO notification_settings (business_id, tenant_id, max_consent_age_seconds) VALUES
  ('bbbbbbbb-0000-4000-8000-000000000003', '22222222-2222-4222-8222-222222222222', NULL);
