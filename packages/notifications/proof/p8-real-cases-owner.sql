-- =====================================================================
-- Phase 8 — D-2, D-3, D-4, D-5 on the REAL relations
-- RUN AS daftar_migrator (the owner), under FORCED RLS with the real GUCs.
-- =====================================================================
SET search_path = p8, public;
BEGIN;
SET LOCAL app.tenant_id   = '11111111-1111-4111-8111-111111111111';
SET LOCAL app.business_id = 'bbbbbbbb-0000-4000-8000-000000000001';

-- =====================================================================
-- D-2  The user half, on the real `memberships`
-- =====================================================================
-- Round 10 proved this against an invented `memberships` of its own making, so
-- it proved nothing about the system. The rows these cases read were written in
-- part 1 of the fixtures, into the frozen relation, through its real policies,
-- and the statuses are the frozen token set's own words.

SELECT p8.case_permits('M1 an active member is permitted', $q$
  INSERT INTO notifications (tenant_id, business_id, kind, consent_class, user_id,
                             locale, subject_refs, obligation_key, source_event_id)
  VALUES ('11111111-1111-4111-8111-111111111111', 'bbbbbbbb-0000-4000-8000-000000000001',
          'shift_reminder', 'operational', 'aaaaaaaa-0000-4000-8000-00000000000a',
          'ar', '{}'::jsonb, 'B1|event:m1|shift_reminder|user:a',
          '0eeeeeee-0000-4000-8000-00000000000a')
$q$);

SELECT p8.case_refuses('M2 a user with no membership is refused by name', $q$
  INSERT INTO notifications (tenant_id, business_id, kind, consent_class, user_id,
                             locale, subject_refs, obligation_key, source_event_id)
  VALUES ('11111111-1111-4111-8111-111111111111', 'bbbbbbbb-0000-4000-8000-000000000001',
          'shift_reminder', 'operational', 'aaaaaaaa-0000-4000-8000-00000000000b',
          'ar', '{}'::jsonb, 'B1|event:m2|shift_reminder|user:b',
          '0eeeeeee-0000-4000-8000-00000000000b')
$q$, 'notification.recipient_not_a_member');

-- M2 would also pass if the outsider simply did not exist, so the FK and the
-- verifier have to be separated. The first attempt at M3 asserted that a user
-- id in no `users` row is refused by `notifications_user_exists`, and the run
-- refused it by `notification.recipient_not_a_member` instead: a BEFORE trigger
-- runs before the foreign key is checked, so THE VERIFIER MASKS THE FK on every
-- path where the user does not exist. That is the masking shape this project
-- has now met in five phases, and the remedy is the same one: drop the guard
-- that masks the other and assert each BY NAME.
--
-- M3 therefore records what actually happens, and M3c measures the FK with the
-- verifier disabled — inside this transaction, which ends in a rollback, so the
-- schema is unchanged. The FK is not redundant: it is what refuses a DELETE of
-- a referenced user, which the verifier never sees.
SELECT p8.case_refuses('M3 the verifier answers first, even for a user that does not exist', $q$
  INSERT INTO notifications (tenant_id, business_id, kind, consent_class, user_id,
                             locale, subject_refs, obligation_key, source_event_id)
  VALUES ('11111111-1111-4111-8111-111111111111', 'bbbbbbbb-0000-4000-8000-000000000001',
          'shift_reminder', 'operational', 'aaaaaaaa-0000-4000-8000-0000000000ff',
          'ar', '{}'::jsonb, 'B1|event:m3|shift_reminder|user:ff',
          '0eeeeeee-0000-4000-8000-0000000000ff')
$q$, 'notification.recipient_not_a_member');
-- M3b first tried to read the outsider out of `users` to show it exists. As the
-- owner that reads 0, and the reason matters: `users` carries FORCED RLS whose
-- only policies are `users_platform_only` (app_bypass()) and `identity_access`
-- (CURRENT_USER = 'daftar_identity'), so the migrator cannot see a user row at
-- all. The existence claim therefore moves to the platform file, which may read
-- it, and what is asserted here is the invisibility itself — because a verifier
-- that silently read an empty `users` would refuse everything and look correct.
SELECT p8.case_equals('M3b the owner cannot see users at all, and that is why M3b moved',
  (SELECT count(*) FROM users), 0::bigint);
-- The verifier reads `memberships`, which the owner CAN see under its scope.
-- If that ever read zero too, every M-case would pass for the wrong reason.
SELECT p8.case_equals('M3b2 but the owner can see this business''s memberships',
  (SELECT count(*) FROM memberships WHERE business_id = 'bbbbbbbb-0000-4000-8000-000000000001'),
  3::bigint);

ALTER TABLE notifications DISABLE TRIGGER notifications_user_is_a_member;
SELECT p8.case_refuses('M3c with the verifier dropped, the FK refuses by its own name', $q$
  INSERT INTO notifications (tenant_id, business_id, kind, consent_class, user_id,
                             locale, subject_refs, obligation_key, source_event_id)
  VALUES ('11111111-1111-4111-8111-111111111111', 'bbbbbbbb-0000-4000-8000-000000000001',
          'shift_reminder', 'operational', 'aaaaaaaa-0000-4000-8000-0000000000ff',
          'ar', '{}'::jsonb, 'B1|event:m3c|shift_reminder|user:ff',
          '0eeeeeee-0000-4000-8000-0000000000fc')
$q$, 'notifications_user_exists');
-- And with the verifier dropped, the OUTSIDER is accepted — which is the proof
-- that M2's refusal came from the verifier and from nothing else.
SELECT p8.case_permits('M3d with the verifier dropped, the outsider is accepted', $q$
  INSERT INTO notifications (tenant_id, business_id, kind, consent_class, user_id,
                             locale, subject_refs, obligation_key, source_event_id)
  VALUES ('11111111-1111-4111-8111-111111111111', 'bbbbbbbb-0000-4000-8000-000000000001',
          'shift_reminder', 'operational', 'aaaaaaaa-0000-4000-8000-00000000000b',
          'ar', '{}'::jsonb, 'B1|event:m3d|shift_reminder|user:b',
          '0eeeeeee-0000-4000-8000-0000000000fd')
$q$);
ALTER TABLE notifications ENABLE TRIGGER notifications_user_is_a_member;
SELECT p8.case_equals('M3e and the verifier is back on',
  (SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'notifications'::regclass
     AND tgname = 'notifications_user_is_a_member'), 'O'::"char");

-- The verifier reads `status = 'active'`: an ALLOW-LIST, so a token nobody has
-- thought of yet is refused rather than admitted. Both non-active tokens the
-- frozen CHECK allows are measured, by their own names.
SELECT p8.case_refuses('M4 a suspended member is refused', $q$
  INSERT INTO notifications (tenant_id, business_id, kind, consent_class, user_id,
                             locale, subject_refs, obligation_key, source_event_id)
  VALUES ('11111111-1111-4111-8111-111111111111', 'bbbbbbbb-0000-4000-8000-000000000001',
          'shift_reminder', 'operational', 'aaaaaaaa-0000-4000-8000-00000000000c',
          'ar', '{}'::jsonb, 'B1|event:m4|shift_reminder|user:c',
          '0eeeeeee-0000-4000-8000-00000000000c')
$q$, 'notification.recipient_not_a_member');

SELECT p8.case_refuses('M5 a removed member is refused', $q$
  INSERT INTO notifications (tenant_id, business_id, kind, consent_class, user_id,
                             locale, subject_refs, obligation_key, source_event_id)
  VALUES ('11111111-1111-4111-8111-111111111111', 'bbbbbbbb-0000-4000-8000-000000000001',
          'shift_reminder', 'operational', 'aaaaaaaa-0000-4000-8000-00000000000d',
          'ar', '{}'::jsonb, 'B1|event:m5|shift_reminder|user:d',
          '0eeeeeee-0000-4000-8000-00000000000d')
$q$, 'notification.recipient_not_a_member');

-- The frozen CHECK allows FOUR tokens. Only `active` is on the allow-list, so
-- three must be refused; `invited` has no fixture, and this case asserts the
-- allow-list's SHAPE from the catalogue instead of adding a fourth row: if the
-- frozen token set ever grows, the number here stops matching and the case
-- reds, which is the only way a case can speak about a token that does not
-- exist yet.
SELECT p8.case_equals('M6 the frozen membership token set is the one the verifier was written against',
  (SELECT string_agg(t, ',' ORDER BY t) FROM (
     SELECT unnest(regexp_matches(pg_get_constraintdef(oid), '''([a-z_]+)''::text', 'g')) AS t
       FROM pg_constraint WHERE conname = 'memberships_status_check') x),
  'active,invited,removed,suspended');

-- The verifier reads a relation that is itself under RLS, so when the session
-- has no business scope it sees no membership and refuses. I expected the RLS
-- WITH CHECK to answer first and wrote the case that way; the run showed the
-- VERIFIER answering first, because a BEFORE trigger runs before the policy is
-- evaluated. Both are refusals and the direction is the fail-closed one, but
-- the order is now measured rather than assumed, and the refusal is attributed
-- to the guard that actually produced it.
SET LOCAL app.business_id = '';
SELECT p8.case_refuses('M7 with no business scope the verifier refuses first, and refuses', $q$
  INSERT INTO notifications (tenant_id, business_id, kind, consent_class, user_id,
                             locale, subject_refs, obligation_key, source_event_id)
  VALUES ('11111111-1111-4111-8111-111111111111', 'bbbbbbbb-0000-4000-8000-000000000001',
          'shift_reminder', 'operational', 'aaaaaaaa-0000-4000-8000-00000000000a',
          'ar', '{}'::jsonb, 'B1|event:m7|shift_reminder|user:a',
          '0eeeeeee-0000-4000-8000-00000000000e')
$q$, 'notification.recipient_not_a_member');
-- And the policy is not idle behind it: with the verifier disabled and no
-- scope, the RESTRICTIVE policy refuses the same row by its own name. Without
-- this half, M7 would be evidence about the trigger only.
ALTER TABLE notifications DISABLE TRIGGER notifications_user_is_a_member;
SELECT p8.case_refuses('M7b and behind it the policy refuses by name too', $q$
  INSERT INTO notifications (tenant_id, business_id, kind, consent_class, user_id,
                             locale, subject_refs, obligation_key, source_event_id)
  VALUES ('11111111-1111-4111-8111-111111111111', 'bbbbbbbb-0000-4000-8000-000000000001',
          'shift_reminder', 'operational', 'aaaaaaaa-0000-4000-8000-00000000000a',
          'ar', '{}'::jsonb, 'B1|event:m7b|shift_reminder|user:a',
          '0eeeeeee-0000-4000-8000-00000000000f')
$q$, 'row-level security policy "business_isolation" for table "notifications"');
ALTER TABLE notifications ENABLE TRIGGER notifications_user_is_a_member;
SET LOCAL app.business_id = 'bbbbbbbb-0000-4000-8000-000000000001';

-- =====================================================================
-- D-4  The composite TENANT key
-- =====================================================================
-- Round 10's stand-in `businesses` had no `UNIQUE (tenant_id, id)`, so this
-- constraint could not have existed there and a notification carrying another
-- tenant's id was accepted with nothing noticing: RLS filters `business_id`
-- alone. Here the real key is present (`businesses_tenant_id_uq`, added by
-- `0016`), and each of the five relations is measured by its own constraint
-- name rather than by one example standing in for the rest.
-- MEASURED FIRST, AND IT CHANGED THE CASE. A wrong tenant is refused by the
-- PERMISSIVE `tenant_membership` policy before the foreign key is reached, so
-- the FK is MASKED by RLS exactly as it was masked by the trigger in M3. Note
-- also that a PERMISSIVE violation is reported WITHOUT the policy's name, while
-- the RESTRICTIVE one in A4 and M7b names itself — so the unnamed refusal below
-- is attributed by construction: `tenant_membership` is the only PERMISSIVE
-- policy on the relation.
SELECT p8.case_refuses('T1 a wrong tenant is refused by the tenant policy first', $q$
  INSERT INTO notifications (tenant_id, business_id, kind, consent_class, customer_id,
                             locale, subject_refs, obligation_key, source_event_id)
  VALUES ('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-0000-4000-8000-000000000001',
          'invoice_issued', 'transactional', 'cccccccc-0000-4000-8000-000000000001',
          'ar', '{}'::jsonb, 'B1|event:t1|invoice_issued|customer:1',
          '0eeeeeee-0000-4000-8000-000000000011')
$q$, 'row-level security policy for table "notifications"');

-- With the owner exempted from its own policies, the composite key answers by
-- its own name. FORCE is restored immediately and asserted back on, and the
-- whole block rolls back regardless.
ALTER TABLE notifications NO FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_deliveries NO FORCE ROW LEVEL SECURITY;
SELECT p8.case_refuses('T1b behind the policy, notifications_tenant_fk refuses by name', $q$
  INSERT INTO notifications (tenant_id, business_id, kind, consent_class, customer_id,
                             locale, subject_refs, obligation_key, source_event_id)
  VALUES ('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-0000-4000-8000-000000000001',
          'invoice_issued', 'transactional', 'cccccccc-0000-4000-8000-000000000001',
          'ar', '{}'::jsonb, 'B1|event:t1b|invoice_issued|customer:1',
          '0eeeeeee-0000-4000-8000-000000000012')
$q$, 'notifications_tenant_fk');

-- The same question on the delivery, which the worker writes. A delivery needs
-- a notification to own it, so one is created in scope first.
INSERT INTO notifications (id, tenant_id, business_id, kind, consent_class, customer_id,
                           locale, subject_refs, obligation_key, source_event_id)
VALUES ('0fffffff-0000-4000-8000-000000000001',
        '11111111-1111-4111-8111-111111111111', 'bbbbbbbb-0000-4000-8000-000000000001',
        'invoice_issued', 'transactional', 'cccccccc-0000-4000-8000-000000000001',
        'ar', '{}'::jsonb, 'B1|event:t3|invoice_issued|customer:1',
        '0eeeeeee-0000-4000-8000-000000000013');
SELECT p8.case_refuses('T1c and deliveries_tenant_fk refuses by name', $q$
  INSERT INTO notification_deliveries (tenant_id, business_id, notification_id, channel,
                                       provider, delivery_key, delivery_state)
  VALUES ('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-0000-4000-8000-000000000001',
          '0fffffff-0000-4000-8000-000000000001', 'whatsapp', 'meta_cloud',
          'B1|event:t3|invoice_issued|customer:1::whatsapp', 'queued')
$q$, 'deliveries_tenant_fk');
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_deliveries FORCE ROW LEVEL SECURITY;
SELECT p8.case_equals('T1d FORCE is back on both relations',
  (SELECT count(*) FROM pg_class
    WHERE oid IN ('notifications'::regclass, 'notification_deliveries'::regclass)
      AND relforcerowsecurity), 2::bigint);

-- Two of the five are proved by an EXECUTED refusal above. The other three
-- (`notification_attempts`, `notification_provider_statuses`,
-- `notification_settings`) are proved by SHAPE only — this case — and that
-- limit is stated here rather than left for a reader to discover.
SELECT p8.case_equals('T2 all five scoped relations carry a composite tenant key',
  (SELECT count(*) FROM pg_constraint
    WHERE conname IN ('notifications_tenant_fk','deliveries_tenant_fk','attempts_tenant_fk',
                      'provider_statuses_tenant_fk','settings_tenant_fk')
      AND contype = 'f'
      AND confrelid = 'businesses'::regclass
      AND (SELECT array_agg(attname::text ORDER BY attname::text) FROM pg_attribute
             WHERE attrelid = confrelid AND attnum = ANY(confkey)) = ARRAY['id','tenant_id']),
  5::bigint);

-- =====================================================================
-- D-3  Catalogue agreement — the ladder's DOMAIN is written more than once
-- =====================================================================
-- The ladder itself is written once. Its DOMAIN is written three times: the
-- status CHECK, the ranking function, and the arrival CHECK's token list. The
-- fourth challenge added one token to the CHECK and nothing else and measured
-- `read -> archived -> queued` succeeding with the suite still green, because a
-- `CASE` with no `ELSE` returns NULL and `NULL <= anything` is not true. The
-- strict function closed the trigger half. These cases close the other half:
-- they read EVERY side out of the catalogue and compare them, so the drift reds
-- wherever it is introduced.
SELECT p8.case_equals('D3a the status CHECK and the ladder agree',
  (SELECT string_agg(t, ',' ORDER BY t) FROM (
     SELECT unnest(regexp_matches(pg_get_constraintdef(oid), '''([a-z_]+)''::text', 'g')) AS t
       FROM pg_constraint WHERE conname = 'notifications_status_in') x),
  (SELECT string_agg(t, ',' ORDER BY t) FROM (
     SELECT unnest(regexp_matches(prosrc, 'WHEN ''([a-z_]+)''', 'g')) AS t
       FROM pg_proc WHERE proname = 'p8_status_rank') y));

-- The same question for the delivery's own token set, and for the arrival
-- derivation. `deliveries_arrival_fact_agrees` lists the arriving tokens in
-- prose; `p8_arrival_was_recorded` derives them from the ladder. The case
-- derives the first list from the catalogue, derives the second by CALLING the
-- function on every token the delivery CHECK allows, and compares.
SELECT p8.case_equals('D3b the arrival CHECK''s token list is exactly what the ladder calls an arrival',
  (SELECT string_agg(t, ',' ORDER BY t) FROM (
     SELECT unnest(regexp_matches(pg_get_constraintdef(oid), '''([a-z_]+)''::text', 'g')) AS t
       FROM pg_constraint WHERE conname = 'deliveries_arrival_fact_agrees') x),
  (SELECT string_agg(t, ',' ORDER BY t) FROM (
     SELECT unnest(regexp_matches(pg_get_constraintdef(oid), '''([a-z_]+)''::text', 'g')) AS t
       FROM pg_constraint WHERE conname = 'deliveries_final_status_in') y
   WHERE p8_arrival_was_recorded(t)));

-- And the delivery's final-status domain must be a SUBSET of the notification
-- ladder: a delivery cannot end in a state the notification cannot hold.
SELECT p8.case_equals('D3c every final status is on the ladder', (
  SELECT count(*) FROM (
    SELECT unnest(regexp_matches(pg_get_constraintdef(oid), '''([a-z_]+)''::text', 'g')) AS t
      FROM pg_constraint WHERE conname = 'deliveries_final_status_in') z
   WHERE p8_status_rank(t) IS NULL), 0::bigint);

-- A token that is not on the ladder must be refused BY NAME by the strict
-- function, and the refusal must come from the function and not from the CHECK:
-- the function is called directly here, with no table in the way.
SELECT p8.case_refuses('D3d the strict ladder refuses an unknown token by name',
  $q$SELECT p8_status_rank_strict('archived')$q$, 'notification.status_not_on_the_ladder');
SELECT p8.case_refuses('D3e and so does the arrival derivation',
  $q$SELECT p8_arrival_was_recorded('archived')$q$, 'notification.status_not_on_the_ladder');

-- =====================================================================
-- D-5  TRUNCATE on the attempt history
-- =====================================================================
-- An append-only history guarded only against DELETE is not append-only: the
-- owner can empty it in one statement, and `TRUNCATE` fires no row trigger.
-- The guard is a STATEMENT trigger, and it is measured as the OWNER, which is
-- the only principal that could do it.
SELECT p8.case_refuses('X1 the owner may not truncate the attempt history',
  'TRUNCATE notification_attempts', 'notification.attempt_history_is_append_only');
SELECT p8.case_refuses('X2 nor truncate it as part of a longer statement',
  'TRUNCATE notification_attempts, notification_provider_statuses',
  'notification.attempt_history_is_append_only');
SELECT p8.case_equals('X3 the guard is a STATEMENT trigger on TRUNCATE, not a row trigger', (
  SELECT count(*) FROM pg_trigger
   WHERE tgrelid = 'notification_attempts'::regclass AND tgname = 'attempts_no_truncate'
     AND (tgtype & 32) <> 0      -- TRUNCATE
     AND (tgtype & 1) = 0), 1::bigint);  -- not FOR EACH ROW

ROLLBACK;
