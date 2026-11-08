-- =====================================================================
-- Phase 8 — fixtures on the REAL frozen relations (part 1: the identity half)
-- RUN AS daftar_platform.
-- =====================================================================
-- Round 10 invented `users` and `businesses` so the cases had something to
-- point at, and the challenger was right to reject that: an isolation proof
-- over an invented schema proves the invention, not the system. These rows go
-- into the real `tenants`, `users`, `businesses`, `tenant_memberships` and
-- `memberships`, through the real policies, with nothing redefined and no
-- frozen file touched.
--
-- WHY THIS FILE IS SPLIT FROM THE NEXT. `users` is writable only by
-- `daftar_platform` (policy `users_platform_only`, USING app_bypass()) or by
-- `daftar_identity`; the migrator cannot write a user at all. `customers`
-- grants `daftar_platform` nothing — Phase 4 did not grant it — so customers
-- are written in part 2 by the owner under the real policies with the session
-- GUCs set, which is also the only path that exercises them. The split is a
-- property of the frozen schema; it is measured, not assumed.
--
-- THE CAST, and what each row is for:
--   tenant T1 .. business B1  — the subject business
--   tenant T1 .. business B1B — a SECOND business in the SAME tenant, so that
--                               `business_isolation` can be shown to do work
--                               that `tenant_membership` does not do
--   tenant T2 .. business B2  — a different tenant entirely
--   U_MEMBER    active in B1
--   U_OUTSIDER  a real user with NO membership in B1
--   U_SUSPENDED membership row present, status 'suspended'
--   U_REMOVED   membership row present, status 'removed'
-- `suspended` and `removed` are the frozen token set's own words
-- (memberships_status_check), not words chosen here.
-- =====================================================================

INSERT INTO tenants (id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222');

INSERT INTO users (id, email, password_hash, display_name, preferred_locale) VALUES
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'member@p8.test',    'x', 'P8 Member',    'ar'),
  ('aaaaaaaa-0000-4000-8000-00000000000b', 'outsider@p8.test',  'x', 'P8 Outsider',  'en'),
  ('aaaaaaaa-0000-4000-8000-00000000000c', 'suspended@p8.test', 'x', 'P8 Suspended', 'ar'),
  ('aaaaaaaa-0000-4000-8000-00000000000d', 'removed@p8.test',   'x', 'P8 Removed',   'tr');

INSERT INTO businesses (id, tenant_id, name, store_slug, country_code, base_currency, timezone) VALUES
  ('bbbbbbbb-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
   'P8 Business One', 'p8-business-one', 'JO', 'JOD', 'Asia/Amman'),
  ('bbbbbbbb-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
   'P8 Business One B', 'p8-business-one-b', 'JO', 'JOD', 'Asia/Amman'),
  ('bbbbbbbb-0000-4000-8000-000000000003', '22222222-2222-4222-8222-222222222222',
   'P8 Business Two', 'p8-business-two', 'TR', 'TRY', 'Europe/Istanbul');

-- A business membership requires a tenant membership first
-- (memberships_tenant_member_fk). The outsider gets one too, on purpose: the
-- case must fail for the BUSINESS membership that is missing, not for a
-- tenant row that happens to be missing as well.
INSERT INTO tenant_memberships (tenant_id, user_id, role_key, status) VALUES
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-00000000000a', 'tenant_owner',  'active'),
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-00000000000b', 'tenant_member', 'active'),
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-00000000000c', 'tenant_member', 'active'),
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-00000000000d', 'tenant_member', 'active');

INSERT INTO memberships (business_id, user_id, tenant_id, status) VALUES
  ('bbbbbbbb-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a',
   '11111111-1111-4111-8111-111111111111', 'active'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000c',
   '11111111-1111-4111-8111-111111111111', 'suspended'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000d',
   '11111111-1111-4111-8111-111111111111', 'removed');
