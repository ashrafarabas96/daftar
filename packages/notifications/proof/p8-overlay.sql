-- =====================================================================
-- Phase 8 — the DDL of `P8-DDL-SPEC.md`, applied as an OVERLAY ON THE REAL
-- FROZEN SCHEMA.
--
-- Round 10 transcribed the whole world: it wrote stand-ins for `businesses`,
-- `customers` and `users` and a prototype of `app_bypass()`. The fourth
-- independent challenge rejected that, and was right twice over — the
-- stand-in `users` had a `business_id` the real table does not have, and the
-- prototype `app_bypass()` read a session GUC any role may set, which inverted
-- every isolation result. Both defects were in the TRANSCRIPTION, not in the
-- spec. So this file transcribes nothing but Phase 8: the runner applies
-- migrations 0000–0086 unmodified first, as `daftar_migrator`, and everything
-- below builds on the real relations, the real keys and the real
-- `app_bypass()` / `app_business()` / `app_tenant()`.
--
-- It is still NOT a migration: it allocates no number and no filename, and the
-- Migration Owner allocates at promotion. It reads the frozen files and never
-- writes them.
-- =====================================================================

-- ---------------------------------------------------------------------
-- §2  notifications — the obligation ledger
-- ---------------------------------------------------------------------
CREATE TABLE notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  business_id     UUID NOT NULL,
  kind            TEXT NOT NULL
    CONSTRAINT notifications_kind_in_catalog
    CHECK (kind IN ('invoice_issued','payment_received','payment_overdue','customer_statement',
                    'booking_confirmed','booking_reminder','order_status_changed','low_stock',
                    'shift_reminder','password_changed')),
  consent_class   TEXT NOT NULL
    CONSTRAINT notifications_consent_class_in
    CHECK (consent_class IN ('transactional','operational','marketing')),
  customer_id     UUID NULL,
  user_id         UUID NULL,
  locale          TEXT NOT NULL CONSTRAINT notifications_locale_in CHECK (locale IN ('ar','en','tr')),
  subject_refs    JSONB NOT NULL
    CONSTRAINT notifications_subject_refs_is_object CHECK (jsonb_typeof(subject_refs) = 'object'),
  obligation_key  TEXT NOT NULL
    CONSTRAINT notifications_obligation_key_nonblank CHECK (btrim(obligation_key) <> ''),
  source_event_id UUID NULL,
  schedule_id     TEXT NULL,
  occurrence_key  TEXT NULL,
  status          TEXT NOT NULL DEFAULT 'queued'
    CONSTRAINT notifications_status_in CHECK (status IN ('queued','sent','delivered','read','failed')),
  last_error_code TEXT NULL
    CONSTRAINT notifications_error_code_is_safe
    CHECK (last_error_code IS NULL OR last_error_code IN
      ('PROVIDER_AUTH_FAILED','PROVIDER_RATE_LIMITED','PROVIDER_TIMEOUT','PROVIDER_UNAVAILABLE',
       'TEMPLATE_REJECTED','RECIPIENT_REJECTED','PROVIDER_NOT_CONFIGURED','DELIVERY_FAILED')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- I-4 no money, no body: enforced by the ABSENCE of a column; case I4 reads
  -- the catalogue rather than trusting this comment.
  CONSTRAINT notifications_exactly_one_origin
    CHECK ((source_event_id IS NOT NULL) <> (schedule_id IS NOT NULL)),
  CONSTRAINT notifications_occurrence_with_schedule
    CHECK ((schedule_id IS NULL) = (occurrence_key IS NULL)),
  CONSTRAINT notifications_occurrence_key_chars
    CHECK (occurrence_key IS NULL OR (occurrence_key NOT LIKE '%|%'
       AND occurrence_key NOT LIKE '%::%' AND occurrence_key NOT LIKE '%#%'
       AND occurrence_key NOT LIKE '%@%' AND btrim(occurrence_key) <> '')),
  CONSTRAINT notifications_recipient_xor
    CHECK ((customer_id IS NOT NULL) <> (user_id IS NOT NULL)),
  CONSTRAINT notifications_obligation_once UNIQUE (business_id, obligation_key),
  -- I-5b, the customer half: a COMPOSITE OWNERSHIP KEY against the real
  -- `customers` PK `(business_id, id)`. An FK matches the column SET and not
  -- its order, so this is creatable with no extra unique — measured, after the
  -- fourth challenge raised the question (its own check agreed).
  CONSTRAINT notifications_customer_owned
    FOREIGN KEY (customer_id, business_id) REFERENCES customers (id, business_id),
  -- I-5b, the user half: **NOT an ownership key, because one cannot exist.**
  -- `0002_identity.sql:1` — "users are GLOBAL (not tenant-bound; access via
  -- memberships)" — and the table has no `business_id`. I-5b's escape hatch
  -- ("where the parent does not expose the matching unique key, add that key or
  -- enforce the equality in a DB-level verifier") anticipated a missing KEY;
  -- what is missing is a DIMENSION, and no key can be added without
  -- contradicting 0002. So the reference is global and the tenant binding is
  -- the verifier below, over `memberships`, which is the relation that actually
  -- binds a user to a business and which an FK cannot traverse.
  CONSTRAINT notifications_user_exists FOREIGN KEY (user_id) REFERENCES users (id),
  -- D-4: the composite TENANT key, as `0075` uses twice on `customers` and
  -- `invoices`. Round 10's stand-in `businesses` had no `UNIQUE (tenant_id, id)`
  -- — which `0016_tenant_membership_invariant.sql:10` adds — so this constraint
  -- could not have been written there, and a notification carrying another
  -- tenant's id was accepted. RLS filters `business_id` alone, so nothing else
  -- would have noticed.
  CONSTRAINT notifications_tenant_fk
    FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id)
);

-- The one ladder. `status_rank` and `arrival_was_recorded` are the only places
-- the order is written, and every rule that needs it calls them.
--
-- **D-3 (fourth challenge, P2): the ladder is written once, its DOMAIN was
-- written twice.** A `CASE` with no `ELSE` returns NULL for an unknown token,
-- `NULL <= anything` is not true, so the trigger did not fire — and the CHECK
-- constraint masked it. Each guard looked sufficient while the other was
-- present. The challenger added one token to the CHECK and nothing else, and
-- measured `read → archived → queued` all succeeding with the suite still at
-- exit 0. Both halves are closed here: the functions RAISE on a token that is
-- not on the ladder, and case D3-a asserts the CHECK's domain and the ladder's
-- domain agree, read from the catalogue, so the drift itself reds.
CREATE FUNCTION p8_status_rank(s TEXT) RETURNS INT LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN CASE s WHEN 'queued' THEN 0 WHEN 'sent' THEN 1 WHEN 'failed' THEN 2
                WHEN 'delivered' THEN 3 WHEN 'read' THEN 4
           ELSE NULL END;
END $$;
CREATE FUNCTION p8_status_rank_strict(s TEXT) RETURNS INT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE r INT;
BEGIN
  r := p8_status_rank(s);
  IF r IS NULL THEN
    RAISE EXCEPTION 'notification.status_not_on_the_ladder: %', coalesce(s,'<null>')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN r;
END $$;
CREATE FUNCTION p8_arrival_was_recorded(s TEXT) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT p8_status_rank_strict(s) >= p8_status_rank_strict('delivered')
$$;

-- I-3 monotonic status — the ARRIVAL is terminal, not the failure.
CREATE FUNCTION notifications_status_monotonic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF p8_status_rank_strict(NEW.status) <= p8_status_rank_strict(OLD.status) THEN
    RAISE EXCEPTION 'notification.status_regression: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER notifications_status_monotonic BEFORE UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION notifications_status_monotonic();

-- I-5b, the user half: the DB-level verifier, over the real membership key.
CREATE FUNCTION notifications_user_is_a_member() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM memberships m
     WHERE m.business_id = NEW.business_id
       AND m.user_id = NEW.user_id
       AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'notification.recipient_not_a_member: user % is not an active member of business %',
      NEW.user_id, NEW.business_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notifications_user_is_a_member BEFORE INSERT OR UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION notifications_user_is_a_member();

CREATE INDEX notifications_customer_recent ON notifications (business_id, customer_id, created_at DESC);
CREATE INDEX notifications_user_recent ON notifications (business_id, user_id, created_at DESC);
CREATE INDEX notifications_unread ON notifications (business_id, created_at) WHERE status <> 'read';
ALTER TABLE notifications ADD CONSTRAINT notifications_id_business_key UNIQUE (id, business_id);

-- ---------------------------------------------------------------------
-- §3  notification_preferences
-- ---------------------------------------------------------------------
CREATE TABLE notification_preferences (
  tenant_id          UUID NOT NULL,
  business_id        UUID NOT NULL,
  subject_kind       TEXT NOT NULL CONSTRAINT prefs_subject_kind_in CHECK (subject_kind IN ('customer','user')),
  subject_id         UUID NOT NULL,
  channel            TEXT NOT NULL CONSTRAINT prefs_channel_in CHECK (channel IN ('whatsapp','sms','email','inapp')),
  state              TEXT NOT NULL CONSTRAINT prefs_state_in CHECK (state IN ('opted_in','opted_out','unset')),
  effective_from     TIMESTAMPTZ NOT NULL,
  quiet_start_minute SMALLINT NULL,
  quiet_end_minute   SMALLINT NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id UUID NULL REFERENCES users (id),
  PRIMARY KEY (business_id, subject_kind, subject_id, channel),
  CONSTRAINT prefs_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT prefs_quiet_hours_paired CHECK ((quiet_start_minute IS NULL) = (quiet_end_minute IS NULL)),
  CONSTRAINT prefs_quiet_hours_in_day
    CHECK ((quiet_start_minute IS NULL OR quiet_start_minute BETWEEN 0 AND 1439)
       AND (quiet_end_minute IS NULL OR quiet_end_minute BETWEEN 0 AND 1439)),
  CONSTRAINT prefs_inapp_not_opted_out CHECK (channel <> 'inapp' OR state <> 'opted_out')
);

-- ---------------------------------------------------------------------
-- §4a  notification_deliveries
-- ---------------------------------------------------------------------
CREATE TABLE notification_deliveries (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL,
  business_id              UUID NOT NULL,
  notification_id          UUID NOT NULL,
  channel                  TEXT NOT NULL CONSTRAINT deliveries_channel_in CHECK (channel IN ('whatsapp','sms','email','inapp')),
  provider                 TEXT NOT NULL,
  delivery_key             TEXT NOT NULL,
  delivery_state           TEXT NOT NULL DEFAULT 'queued'
    CONSTRAINT deliveries_state_in
    CHECK (delivery_state IN ('queued','sending','accepted','unknown','retry_scheduled',
                              'dead','closed','withheld','suppressed')),
  unknown_reason           TEXT NULL
    CONSTRAINT deliveries_unknown_reason_in
    CHECK (unknown_reason IS NULL OR unknown_reason IN
      ('timeout_after_send','invalid_success_response','transport_interrupted')),
  attempts_made            INTEGER NOT NULL DEFAULT 0 CONSTRAINT deliveries_attempts_nonneg CHECK (attempts_made >= 0),
  next_attempt_after       TIMESTAMPTZ NULL,
  provider_message_id      TEXT NULL,
  provider_server_side_idempotency BOOLEAN NOT NULL DEFAULT false,
  withheld_reason          TEXT NULL,
  last_error_code          TEXT NULL
    CONSTRAINT deliveries_error_code_is_safe
    CHECK (last_error_code IS NULL OR last_error_code IN
      ('PROVIDER_AUTH_FAILED','PROVIDER_RATE_LIMITED','PROVIDER_TIMEOUT','PROVIDER_UNAVAILABLE',
       'TEMPLATE_REJECTED','RECIPIENT_REJECTED','PROVIDER_NOT_CONFIGURED','DELIVERY_FAILED')),
  final_status             TEXT NULL
    CONSTRAINT deliveries_final_status_in
    CHECK (final_status IS NULL OR final_status IN ('delivered','read','failed')),
  final_status_verified    BOOLEAN NOT NULL DEFAULT false,
  arrival_ever_recorded    BOOLEAN NOT NULL DEFAULT false,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT deliveries_notification_owned
    FOREIGN KEY (notification_id, business_id) REFERENCES notifications (id, business_id),
  CONSTRAINT deliveries_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT deliveries_delivery_key_once UNIQUE (business_id, delivery_key),
  CONSTRAINT deliveries_unknown_reason_exactly_when_unknown
    CHECK ((delivery_state = 'unknown') = (unknown_reason IS NOT NULL)),
  CONSTRAINT deliveries_provider_message_id_nonblank
    CHECK (provider_message_id IS NULL OR btrim(provider_message_id) <> ''),
  CONSTRAINT deliveries_accepted_has_provider_message_id
    CHECK (delivery_state <> 'accepted' OR provider_message_id IS NOT NULL),
  CONSTRAINT deliveries_unknown_not_blindly_retried
    CHECK (delivery_state <> 'unknown' OR next_attempt_after IS NULL OR provider_server_side_idempotency),
  CONSTRAINT deliveries_next_attempt_only_when_scheduled
    CHECK (next_attempt_after IS NULL OR delivery_state IN ('retry_scheduled','unknown')),
  CONSTRAINT deliveries_verified_needs_final_status
    CHECK (NOT final_status_verified OR final_status IS NOT NULL),
  -- I-8h, the INSERT half (round 10, third challenge N-6).
  CONSTRAINT deliveries_arrival_fact_agrees
    CHECK (final_status IS NULL OR final_status NOT IN ('delivered','read') OR arrival_ever_recorded),
  CONSTRAINT deliveries_withheld_has_reason
    CHECK ((delivery_state = 'withheld') = (withheld_reason IS NOT NULL))
);
ALTER TABLE notification_deliveries ADD CONSTRAINT deliveries_id_business_key UNIQUE (id, business_id);

-- I-8e the state machine, and I-8h's set-once half.
CREATE FUNCTION deliveries_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.delivery_state IN ('dead','closed') AND NEW.delivery_state <> OLD.delivery_state THEN
    RAISE EXCEPTION 'notification.delivery_state_terminal: % -> %', OLD.delivery_state, NEW.delivery_state
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.delivery_state = 'unknown' AND NEW.delivery_state = 'accepted'
     AND btrim(coalesce(NEW.provider_message_id,'')) = '' THEN
    RAISE EXCEPTION 'notification.acceptance_without_provider_message_id' USING ERRCODE = 'check_violation';
  END IF;
  -- The refusal comes BEFORE the derivation, deliberately: derive-then-check
  -- silently REPAIRS an attempt to clear the arrival fact — correct row, no
  -- answer, and a caller that keeps trying. Case N6-c measures the order.
  IF OLD.arrival_ever_recorded AND NOT NEW.arrival_ever_recorded THEN
    RAISE EXCEPTION 'notification.arrival_fact_cleared' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.final_status IS NOT NULL AND NEW.final_status_verified
     AND p8_arrival_was_recorded(NEW.final_status) THEN
    NEW.arrival_ever_recorded := true;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER deliveries_transition BEFORE UPDATE ON notification_deliveries
  FOR EACH ROW EXECUTE FUNCTION deliveries_transition();

CREATE INDEX deliveries_send_queue ON notification_deliveries (business_id, next_attempt_after)
  WHERE delivery_state IN ('queued','sending','retry_scheduled');
CREATE INDEX deliveries_reconcile_queue ON notification_deliveries (business_id, next_attempt_after)
  WHERE delivery_state = 'unknown';

-- I-8f, with I-8h's conjunct.
CREATE UNIQUE INDEX deliveries_one_live_channel ON notification_deliveries (business_id, notification_id)
  WHERE delivery_state NOT IN ('dead','withheld','suppressed')
    AND NOT (delivery_state = 'closed' AND final_status = 'failed'
             AND final_status_verified AND NOT arrival_ever_recorded);

-- ---------------------------------------------------------------------
-- §4  notification_attempts — append-only
-- ---------------------------------------------------------------------
CREATE TABLE notification_settings (
  business_id UUID PRIMARY KEY REFERENCES businesses (id),
  tenant_id   UUID NOT NULL,
  max_consent_age_seconds INTEGER NULL
    CONSTRAINT settings_consent_age_positive CHECK (max_consent_age_seconds IS NULL OR max_consent_age_seconds > 0),
  CONSTRAINT settings_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id)
);

CREATE TABLE notification_attempts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL,
  business_id         UUID NOT NULL,
  delivery_id         UUID NOT NULL,
  notification_id     UUID NOT NULL,
  attempt_no          INTEGER NOT NULL CONSTRAINT attempts_no_positive CHECK (attempt_no >= 1),
  attempt_key         TEXT NOT NULL,
  outcome             TEXT NOT NULL CONSTRAINT attempts_outcome_in CHECK (outcome IN ('accepted','rejected','unknown')),
  retryable           BOOLEAN NULL,
  unknown_reason      TEXT NULL
    CONSTRAINT attempts_unknown_reason_in
    CHECK (unknown_reason IS NULL OR unknown_reason IN
      ('timeout_after_send','invalid_success_response','transport_interrupted')),
  provider_message_id TEXT NULL,
  error_code          TEXT NULL
    CONSTRAINT attempts_error_code_is_safe
    CHECK (error_code IS NULL OR error_code IN
      ('PROVIDER_AUTH_FAILED','PROVIDER_RATE_LIMITED','PROVIDER_TIMEOUT','PROVIDER_UNAVAILABLE',
       'TEMPLATE_REJECTED','RECIPIENT_REJECTED','PROVIDER_NOT_CONFIGURED','DELIVERY_FAILED')),
  consent_read_at     TIMESTAMPTZ NOT NULL,
  consent_source      TEXT NOT NULL,
  attempted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT attempts_delivery_owned
    FOREIGN KEY (delivery_id, business_id) REFERENCES notification_deliveries (id, business_id),
  CONSTRAINT attempts_notification_owned
    FOREIGN KEY (notification_id, business_id) REFERENCES notifications (id, business_id),
  CONSTRAINT attempts_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT attempts_dense_per_delivery UNIQUE (delivery_id, attempt_no),
  CONSTRAINT attempts_key_once UNIQUE (business_id, attempt_key),
  CONSTRAINT attempts_rejected_iff_retryable CHECK ((outcome = 'rejected') = (retryable IS NOT NULL)),
  CONSTRAINT attempts_unknown_iff_reason CHECK ((outcome = 'unknown') = (unknown_reason IS NOT NULL)),
  CONSTRAINT attempts_accepted_has_provider_message_id
    CHECK (outcome <> 'accepted' OR btrim(coalesce(provider_message_id,'')) <> ''),
  CONSTRAINT attempts_consent_read_before_attempt CHECK (consent_read_at <= attempted_at)
);

-- I-9a1: the staleness bound is configuration, and it FAILS CLOSED.
CREATE FUNCTION attempts_consent_freshness() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bound INTEGER;
BEGIN
  SELECT max_consent_age_seconds INTO bound FROM notification_settings WHERE business_id = NEW.business_id;
  IF bound IS NULL THEN
    RAISE EXCEPTION 'notification.consent_staleness_bound_not_configured' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.attempted_at - NEW.consent_read_at > make_interval(secs => bound) THEN
    RAISE EXCEPTION 'notification.consent_read_too_old' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attempts_consent_freshness BEFORE INSERT ON notification_attempts
  FOR EACH ROW EXECUTE FUNCTION attempts_consent_freshness();

-- I-8 append-only. **D-5 (fourth challenge, P3): row triggers do not fire on
-- TRUNCATE**, so the owner could empty the history with no refusal — inside the
-- very claim that the trigger is what constrains the owner. A statement trigger
-- closes it. (The same gap exists on `audit_events` (`0004_infra.sql:18-23`) and
-- on `0059`'s stock ledger, which claims to refuse "every change for every
-- writer including the owner"; that is project-wide and raised, not fixed here.)
CREATE FUNCTION attempts_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'notification.attempt_history_is_append_only' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER attempts_no_update BEFORE UPDATE ON notification_attempts
  FOR EACH ROW EXECUTE FUNCTION attempts_append_only();
CREATE TRIGGER attempts_no_delete BEFORE DELETE ON notification_attempts
  FOR EACH ROW EXECUTE FUNCTION attempts_append_only();
CREATE TRIGGER attempts_no_truncate BEFORE TRUNCATE ON notification_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION attempts_append_only();

-- ---------------------------------------------------------------------
-- §5  notification_provider_statuses, and the quarantine relation
-- ---------------------------------------------------------------------
CREATE TABLE notification_provider_statuses (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL,
  business_id         UUID NOT NULL,
  delivery_id         UUID NOT NULL,
  provider            TEXT NOT NULL,
  provider_message_id TEXT NULL,
  provider_event_id   TEXT NULL,
  status              TEXT NOT NULL
    CONSTRAINT provider_statuses_status_in CHECK (status IN ('queued','sent','delivered','read','failed')),
  verification        TEXT NOT NULL
    CONSTRAINT provider_statuses_verification_in
    CHECK (verification IN ('verified','signature_missing','signature_malformed',
                            'signature_mismatch','secret_not_configured')),
  received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_status_text     TEXT NULL,
  CONSTRAINT provider_statuses_delivery_owned
    FOREIGN KEY (delivery_id, business_id) REFERENCES notification_deliveries (id, business_id),
  CONSTRAINT provider_statuses_tenant_fk
    FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT provider_statuses_verified_has_message_id
    CHECK (verification <> 'verified' OR provider_message_id IS NOT NULL),
  -- NAMED GAP, round 27 (the coordinator's F-4, P3; it predates this commit and
  -- is not introduced by it). `provider_event_id` is NULLABLE, and in
  -- PostgreSQL a UNIQUE index treats NULLs as DISTINCT, so this constraint does
  -- NOT de-duplicate two landings that arrive with no provider event id: both
  -- insert. The name says "event once" and the guarantee is "once per event id
  -- THAT EXISTS". Nothing in this pack claims more than that today, and no case
  -- asserts the NULL pair is refused — which is the honest state, not a silent
  -- one. Tightening it (NULLS NOT DISTINCT, or requiring the id and refusing a
  -- landing without one) is a DDL decision with a real consequence for a
  -- provider that omits the field, so it is an owner decision and is raised as
  -- one rather than taken here. Until it is taken, a reader should read this
  -- constraint as scoped to landings that carry an id.
  CONSTRAINT provider_statuses_event_once UNIQUE (provider, provider_event_id)
);

-- The quarantine has NO tenant and NO business, and that is the point: an
-- event whose signature did not verify carries no attribution we are entitled
-- to believe. Because it cannot be scoped, it cannot be isolated by RLS
-- either, so it is not readable by a business-tier role at all (see §6).
CREATE TABLE notification_provider_quarantine (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          TEXT NOT NULL,
  provider_event_id TEXT NULL,
  status_token      TEXT NULL,
  verification      TEXT NOT NULL
    CONSTRAINT quarantine_verification_in
    -- The token set is the NON-verified half of
    -- `provider_statuses_verification_in`, and `verified` is refused by name:
    -- a verified event belongs in the attributed relation, never here.
    CHECK (verification IN ('signature_missing','signature_malformed',
                            'signature_mismatch','secret_not_configured')),
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- §6  Isolation, roles and grants — the REAL roles and the REAL helpers
-- ---------------------------------------------------------------------
-- No role is created here. The frozen role set is what it is, and a new
-- principal is an administrator's act at promotion. Phase 8's §6 also names a
-- WEBHOOK writer, and the frozen set has no such role: that is an open owner
-- item, recorded in the manifest, not a role invented here.
GRANT SELECT, INSERT ON notifications TO daftar_app;
GRANT SELECT, INSERT, UPDATE ON notification_preferences TO daftar_app;
GRANT SELECT ON notification_deliveries TO daftar_app;
GRANT SELECT ON notification_settings TO daftar_app, daftar_worker;

GRANT SELECT ON notifications TO daftar_worker;
GRANT UPDATE (status, last_error_code, updated_at) ON notifications TO daftar_worker;
GRANT SELECT, INSERT ON notification_deliveries TO daftar_worker;
GRANT UPDATE (delivery_state, unknown_reason, attempts_made, next_attempt_after,
              provider_message_id, last_error_code, updated_at,
              final_status, final_status_verified, arrival_ever_recorded)
  ON notification_deliveries TO daftar_worker;
GRANT SELECT, INSERT ON notification_attempts TO daftar_worker;
GRANT SELECT, INSERT ON notification_provider_statuses TO daftar_worker;
-- INSERT only, deliberately: see the relation's own comment. Reading the
-- quarantine is a platform act, and the frozen role set has no principal for
-- it, so no SELECT is granted to anyone here.
GRANT INSERT ON notification_provider_quarantine TO daftar_worker;
GRANT SELECT ON notification_preferences TO daftar_worker;

-- RLS in the live shape: a PERMISSIVE tenant-membership policy and a
-- RESTRICTIVE business-scoping policy, both over the real helpers, with FORCE
-- so the owner is not exempt. Copied from what the cluster reports for
-- `customers`, not from memory.
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['notifications','notification_preferences','notification_deliveries',
                           'notification_attempts','notification_provider_statuses',
                           'notification_settings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY tenant_membership ON %I AS PERMISSIVE FOR ALL
                      USING (app_bypass() OR tenant_id = (nullif(app_tenant(), ''))::uuid)
                      WITH CHECK (app_bypass() OR tenant_id = (nullif(app_tenant(), ''))::uuid)$f$, t);
    EXECUTE format($f$CREATE POLICY business_isolation ON %I AS RESTRICTIVE FOR ALL
                      USING (app_bypass() OR business_id = (nullif(app_business(), ''))::uuid)
                      WITH CHECK (app_bypass() OR business_id = (nullif(app_business(), ''))::uuid)$f$, t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- §7  The overlay asserts its own shape, so ABSENCE fails too
-- ---------------------------------------------------------------------
-- A check that only catches drift is half a check: it has to fail when the
-- thing is simply missing. Every relation named below must come out of this
-- file with FORCE RLS and BOTH policies, and the count is generated, never
-- written down.
DO $$
DECLARE
  v_scoped TEXT[] := ARRAY['notifications','notification_preferences','notification_deliveries',
                           'notification_attempts','notification_provider_statuses',
                           'notification_settings'];
  t TEXT; n INTEGER;
BEGIN
  FOREACH t IN ARRAY v_scoped LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = t::regclass
                     AND relrowsecurity AND relforcerowsecurity) THEN
      RAISE EXCEPTION 'P8-OVERLAY-E(1): % is not under FORCED row level security', t;
    END IF;
    SELECT count(*) INTO n FROM pg_policies
      WHERE tablename = t AND policyname IN ('tenant_membership','business_isolation');
    IF n <> 2 THEN
      RAISE EXCEPTION 'P8-OVERLAY-E(2): % carries % of the 2 required policies', t, n;
    END IF;
    -- The quals must MENTION the live helpers. A policy that scopes by a
    -- literal, or by a column alone, reads as a policy and isolates nothing.
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t
                     AND policyname = 'business_isolation'
                     AND qual LIKE '%app_bypass()%' AND qual LIKE '%app_business()%') THEN
      RAISE EXCEPTION 'P8-OVERLAY-E(3): %.business_isolation does not read the live helpers', t;
    END IF;
  END LOOP;

  -- The quarantine is the one relation that must NOT be scoped, and must not
  -- be readable by a business-tier role. Assert both, by name.
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid = 'notification_provider_quarantine'::regclass
               AND relrowsecurity) THEN
    RAISE EXCEPTION 'P8-OVERLAY-E(4): the quarantine claims an isolation it cannot have';
  END IF;
  IF has_table_privilege('daftar_app', 'notification_provider_quarantine', 'SELECT')
     OR has_table_privilege('daftar_worker', 'notification_provider_quarantine', 'SELECT') THEN
    RAISE EXCEPTION 'P8-OVERLAY-E(5): a business-tier role can read unattributed events';
  END IF;

  -- §6 of the spec says isolation holds because the bypass is an IDENTITY, not
  -- a session setting a tenant can set. That is a claim about the repo, so it
  -- is measured here: if the repo ever moves the bypass to a GUC, this file
  -- must stop claiming what it claims.
  IF pg_get_functiondef('app_bypass()'::regprocedure) NOT LIKE '%CURRENT_USER%' THEN
    RAISE EXCEPTION 'P8-OVERLAY-E(6): app_bypass() is no longer identity-based; §6 must be rewritten';
  END IF;
  IF pg_get_functiondef('app_bypass()'::regprocedure) LIKE '%current_setting%' THEN
    RAISE EXCEPTION 'P8-OVERLAY-E(7): app_bypass() reads a session setting; the bypass is forgeable';
  END IF;
END $$;
