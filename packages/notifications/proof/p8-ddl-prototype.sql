-- =====================================================================
-- Phase 8 — a PROTOTYPE of the DDL specified in `P8-DDL-SPEC.md`,
-- written to be APPLIED, so that the spec's invariants stop being a
-- reading of text and become refusals a parser and a planner agree with.
--
-- What this file is NOT:
--   * not a migration, and it allocates no migration number or filename
--     (one Migration Owner allocates at promotion — the spec's own rule);
--   * not a copy of anything under `db/migrations`, which is
--     byte-immutable, including for mutation testing. Nothing here reads,
--     applies or alters those files;
--   * not the repo's `app_bypass()` / `app_business()` helpers. It defines
--     PROTOTYPES of them with the same contract so the policies can be
--     executed here; the real ones are the live ones, and a policy proved
--     against a prototype helper is evidence about the POLICY shape only.
--
-- It is applied by a NOSUPERUSER NOBYPASSRLS role, because a suite that
-- runs as the superuser cannot see an RLS defect at all (spec §6).
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS p8;
SET search_path = p8, public;

-- ---------------------------------------------------------------------
-- Prototype context helpers. Same contract as the live pair: the tenant
-- comes from the session, never from a caller's argument.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_business() RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.business_id', true), '')::UUID
$$;
CREATE FUNCTION app_bypass() RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.bypass_rls', true), 'off') = 'on'
$$;

-- Stand-ins for the relations Phase 8 only REFERENCES. They exist so the
-- composite ownership keys of I-5b are real foreign keys here.
CREATE TABLE businesses (id UUID PRIMARY KEY, tenant_id UUID NOT NULL);
CREATE TABLE customers (
  business_id UUID NOT NULL REFERENCES businesses(id), id UUID NOT NULL,
  PRIMARY KEY (business_id, id), UNIQUE (id, business_id)
);
CREATE TABLE users (
  business_id UUID NOT NULL REFERENCES businesses(id), id UUID NOT NULL,
  PRIMARY KEY (business_id, id), UNIQUE (id, business_id)
);

-- =====================================================================
-- §2  notifications — the obligation ledger
-- =====================================================================
CREATE TABLE notifications (
  id              UUID PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  business_id     UUID NOT NULL REFERENCES businesses(id),
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
  obligation_key  TEXT NOT NULL CONSTRAINT notifications_obligation_key_nonblank CHECK (btrim(obligation_key) <> ''),
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
  -- I-4 no money, no body: enforced by the ABSENCE of a column. §9 case I4
  -- asserts that absence against the catalogue rather than trusting this comment.
  -- I-2 exactly one trigger.
  CONSTRAINT notifications_exactly_one_origin
    CHECK ((source_event_id IS NOT NULL) <> (schedule_id IS NOT NULL)),
  CONSTRAINT notifications_occurrence_with_schedule
    CHECK ((schedule_id IS NULL) = (occurrence_key IS NULL)),
  -- I-1b the occurrence key's character rule: ':' is legal, the other four are not.
  CONSTRAINT notifications_occurrence_key_chars
    CHECK (occurrence_key IS NULL OR (occurrence_key NOT LIKE '%|%'
       AND occurrence_key NOT LIKE '%::%' AND occurrence_key NOT LIKE '%#%'
       AND occurrence_key NOT LIKE '%@%' AND btrim(occurrence_key) <> '')),
  -- I-5 typed recipient, XOR.
  CONSTRAINT notifications_recipient_xor
    CHECK ((customer_id IS NOT NULL) <> (user_id IS NOT NULL)),
  -- I-5b tenant-consistent recipient (§39): composite ownership keys.
  CONSTRAINT notifications_customer_owned
    FOREIGN KEY (customer_id, business_id) REFERENCES customers (id, business_id),
  CONSTRAINT notifications_user_owned
    FOREIGN KEY (user_id, business_id) REFERENCES users (id, business_id),
  -- I-1 once-only, per OBLIGATION.
  CONSTRAINT notifications_obligation_once UNIQUE (business_id, obligation_key)
);

ALTER TABLE notifications ADD CONSTRAINT notifications_id_business_key UNIQUE (id, business_id);

-- I-3 monotonic status — the ARRIVAL is terminal, not the failure.
-- The ladder is written ONCE, here, and every other rule that needs it
-- reads this function rather than restating the order.
CREATE FUNCTION status_rank(s TEXT) RETURNS INT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE s WHEN 'queued' THEN 0 WHEN 'sent' THEN 1 WHEN 'failed' THEN 2
                WHEN 'delivered' THEN 3 WHEN 'read' THEN 4 END
$$;
CREATE FUNCTION arrival_was_recorded(s TEXT) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT status_rank(s) >= status_rank('delivered')
$$;
CREATE FUNCTION notifications_status_monotonic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF status_rank(NEW.status) <= status_rank(OLD.status) THEN
    RAISE EXCEPTION 'notification.status_regression: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER notifications_status_monotonic BEFORE UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION notifications_status_monotonic();

CREATE INDEX notifications_customer_recent ON notifications (business_id, customer_id, created_at DESC);
CREATE INDEX notifications_user_recent ON notifications (business_id, user_id, created_at DESC);
CREATE INDEX notifications_unread ON notifications (business_id, created_at) WHERE status <> 'read';

-- =====================================================================
-- §3  notification_preferences
-- =====================================================================
CREATE TABLE notification_preferences (
  tenant_id          UUID NOT NULL,
  business_id        UUID NOT NULL REFERENCES businesses(id),
  subject_kind       TEXT NOT NULL CONSTRAINT prefs_subject_kind_in CHECK (subject_kind IN ('customer','user')),
  subject_id         UUID NOT NULL,
  channel            TEXT NOT NULL CONSTRAINT prefs_channel_in CHECK (channel IN ('whatsapp','sms','email','inapp')),
  state              TEXT NOT NULL CONSTRAINT prefs_state_in CHECK (state IN ('opted_in','opted_out','unset')),
  effective_from     TIMESTAMPTZ NOT NULL,
  quiet_start_minute SMALLINT NULL,
  quiet_end_minute   SMALLINT NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id UUID NULL,
  PRIMARY KEY (business_id, subject_kind, subject_id, channel),
  CONSTRAINT prefs_quiet_hours_paired
    CHECK ((quiet_start_minute IS NULL) = (quiet_end_minute IS NULL)),
  CONSTRAINT prefs_quiet_hours_in_day
    CHECK ((quiet_start_minute IS NULL OR quiet_start_minute BETWEEN 0 AND 1439)
       AND (quiet_end_minute IS NULL OR quiet_end_minute BETWEEN 0 AND 1439)),
  -- I-6 in-app cannot be opted out.
  CONSTRAINT prefs_inapp_not_opted_out CHECK (channel <> 'inapp' OR state <> 'opted_out')
  -- I-7b there is deliberately NO consent column on `notifications`; the
  -- absence is the invariant, and §9 case I7B asserts it on the catalogue.
);

-- =====================================================================
-- §4a  notification_deliveries — the durable delivery state
-- =====================================================================
CREATE TABLE notification_deliveries (
  id                       UUID PRIMARY KEY,
  tenant_id                UUID NOT NULL,
  business_id              UUID NOT NULL REFERENCES businesses(id),
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
  CONSTRAINT deliveries_unknown_reason_exactly_when_unknown
    CHECK ((delivery_state = 'unknown') = (unknown_reason IS NOT NULL)),
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
  -- I-8h (round 10, the challenger's N-6): the ARRIVAL FACT. Set once from a
  -- verified landing, never cleared, and read by I-8f's release clause — so the
  -- release depends on a fact recorded on THIS row rather than on an ordering
  -- enforced on another column of another relation.
  arrival_ever_recorded    BOOLEAN NOT NULL DEFAULT false,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (notification_id, business_id) REFERENCES notifications (id, business_id),
  -- I-8a one delivery per logical send.
  CONSTRAINT deliveries_delivery_key_once UNIQUE (business_id, delivery_key),
  -- I-8b an empty provider id is never an acceptance.
  CONSTRAINT deliveries_provider_message_id_nonblank
    CHECK (provider_message_id IS NULL OR btrim(provider_message_id) <> ''),
  CONSTRAINT deliveries_accepted_has_provider_message_id
    CHECK (delivery_state <> 'accepted' OR provider_message_id IS NOT NULL),
  -- I-8c an ambiguous delivery is not scheduled for a blind retry.
  CONSTRAINT deliveries_unknown_not_blindly_retried
    CHECK (delivery_state <> 'unknown' OR next_attempt_after IS NULL
           OR provider_server_side_idempotency),
  CONSTRAINT deliveries_next_attempt_only_when_scheduled
    CHECK (next_attempt_after IS NULL OR delivery_state IN ('retry_scheduled','unknown')),
  CONSTRAINT deliveries_verified_needs_final_status
    CHECK (NOT final_status_verified OR final_status IS NOT NULL),
  -- I-8h, the INSERT half: an arrival may not be recorded with the fact unset.
  CONSTRAINT deliveries_arrival_fact_agrees
    CHECK (final_status IS NULL OR final_status NOT IN ('delivered','read') OR arrival_ever_recorded),
  -- I-8g a withheld channel is recorded, not omitted.
  CONSTRAINT deliveries_withheld_has_reason
    CHECK ((delivery_state = 'withheld') = (withheld_reason IS NOT NULL))
);


ALTER TABLE notification_deliveries ADD CONSTRAINT deliveries_id_business_key UNIQUE (id, business_id);

-- I-8e the state machine is enforced in the database, and I-8h's set-once half.
CREATE FUNCTION deliveries_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.delivery_state IN ('dead','closed') AND NEW.delivery_state <> OLD.delivery_state THEN
    RAISE EXCEPTION 'notification.delivery_state_terminal: % -> %', OLD.delivery_state, NEW.delivery_state
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.delivery_state = 'unknown' AND NEW.delivery_state = 'accepted'
     AND btrim(coalesce(NEW.provider_message_id,'')) = '' THEN
    RAISE EXCEPTION 'notification.acceptance_without_provider_message_id'
      USING ERRCODE = 'check_violation';
  END IF;
  -- I-8h: the arrival fact cannot be cleared, and is DERIVED from a verified
  -- landing rather than supplied by the caller. `arrival_was_recorded` reads the
  -- one ladder, so the order is written in a single place.
  --
  -- The two clauses are in this order deliberately, and the order is what the
  -- case N6-c measures. Derive-then-check silently REPAIRS an attempt to clear
  -- the fact: the row ends up correct and the caller is told nothing, so a
  -- component trying to clear it keeps trying and no refusal is ever named.
  -- Check-then-derive refuses the attempt by name.
  IF OLD.arrival_ever_recorded AND NOT NEW.arrival_ever_recorded THEN
    RAISE EXCEPTION 'notification.arrival_fact_cleared' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.final_status IS NOT NULL AND NEW.final_status_verified
     AND arrival_was_recorded(NEW.final_status) THEN
    NEW.arrival_ever_recorded := true;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER deliveries_transition BEFORE UPDATE ON notification_deliveries
  FOR EACH ROW EXECUTE FUNCTION deliveries_transition();

-- I-8d open work is queryable: two queues, because their work differs.
CREATE INDEX deliveries_send_queue ON notification_deliveries (business_id, next_attempt_after)
  WHERE delivery_state IN ('queued','sending','retry_scheduled');
CREATE INDEX deliveries_reconcile_queue ON notification_deliveries (business_id, next_attempt_after)
  WHERE delivery_state = 'unknown';

-- I-8f at most one channel of an obligation may hold a delivery that could
-- produce a message. Written as an EXCLUSION, so a state added later is INSIDE
-- the index and refuses the second channel — the failure that withholds a
-- notification rather than duplicating one. The release reads the arrival fact
-- (I-8h) and not an ordering enforced elsewhere.
CREATE UNIQUE INDEX deliveries_one_live_channel ON notification_deliveries (business_id, notification_id)
  WHERE delivery_state NOT IN ('dead','withheld','suppressed')
    AND NOT (delivery_state = 'closed' AND final_status = 'failed'
             AND final_status_verified AND NOT arrival_ever_recorded);

-- =====================================================================
-- §4  notification_attempts — append-only, one row per provider call
-- =====================================================================
CREATE TABLE notification_attempts (
  id                  UUID PRIMARY KEY,
  tenant_id           UUID NOT NULL,
  business_id         UUID NOT NULL REFERENCES businesses(id),
  delivery_id         UUID NOT NULL,
  notification_id     UUID NOT NULL,
  attempt_no          INTEGER NOT NULL CONSTRAINT attempts_no_positive CHECK (attempt_no >= 1),
  attempt_key         TEXT NOT NULL,
  outcome             TEXT NOT NULL
    CONSTRAINT attempts_outcome_in CHECK (outcome IN ('accepted','rejected','unknown')),
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
  -- I-9a1 (V3): evidence that can be ABSENT, in place of a column pinned to a
  -- constant. `max_consent_age_seconds` is business configuration, REQUIRED at
  -- promotion (§41), and the bound fails closed: with no configured value the
  -- attempt is refused. The prototype carries the parameter as a settings row
  -- so the fail-closed direction is executable; it invents no value.
  consent_read_at     TIMESTAMPTZ NOT NULL,
  consent_source      TEXT NOT NULL,
  attempted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (delivery_id, business_id) REFERENCES notification_deliveries (id, business_id),
  FOREIGN KEY (notification_id, business_id) REFERENCES notifications (id, business_id),
  -- I-9 attempt numbers are dense per LOGICAL DELIVERY.
  CONSTRAINT attempts_dense_per_delivery UNIQUE (delivery_id, attempt_no),
  CONSTRAINT attempts_key_once UNIQUE (business_id, attempt_key),
  -- I-9b the three outcomes are structurally exclusive.
  CONSTRAINT attempts_rejected_iff_retryable CHECK ((outcome = 'rejected') = (retryable IS NOT NULL)),
  CONSTRAINT attempts_unknown_iff_reason CHECK ((outcome = 'unknown') = (unknown_reason IS NOT NULL)),
  CONSTRAINT attempts_accepted_has_provider_message_id
    CHECK (outcome <> 'accepted' OR btrim(coalesce(provider_message_id,'')) <> ''),
  CONSTRAINT attempts_consent_read_before_attempt CHECK (consent_read_at <= attempted_at)
);

CREATE TABLE notification_settings (
  business_id UUID PRIMARY KEY REFERENCES businesses(id),
  max_consent_age_seconds INTEGER NULL   -- NULL = not configured; the bound then REFUSES.
    CONSTRAINT settings_consent_age_positive CHECK (max_consent_age_seconds IS NULL OR max_consent_age_seconds > 0)
);

-- The staleness bound is a trigger rather than a CHECK because its parameter
-- lives in configuration. It FAILS CLOSED: an unconfigured business refuses.
CREATE FUNCTION attempts_consent_freshness() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bound INTEGER;
BEGIN
  SELECT max_consent_age_seconds INTO bound FROM notification_settings WHERE business_id = NEW.business_id;
  IF bound IS NULL THEN
    RAISE EXCEPTION 'notification.consent_staleness_bound_not_configured'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.attempted_at - NEW.consent_read_at > make_interval(secs => bound) THEN
    RAISE EXCEPTION 'notification.consent_read_too_old' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attempts_consent_freshness BEFORE INSERT ON notification_attempts
  FOR EACH ROW EXECUTE FUNCTION attempts_consent_freshness();

-- I-8 append-only, exactly as `audit_events` is.
CREATE FUNCTION attempts_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'notification.attempt_history_is_append_only' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER attempts_no_update BEFORE UPDATE ON notification_attempts
  FOR EACH ROW EXECUTE FUNCTION attempts_append_only();
CREATE TRIGGER attempts_no_delete BEFORE DELETE ON notification_attempts
  FOR EACH ROW EXECUTE FUNCTION attempts_append_only();

-- =====================================================================
-- §5  notification_provider_statuses — webhook landings (tenant data)
-- =====================================================================
CREATE TABLE notification_provider_statuses (
  id                  UUID PRIMARY KEY,
  tenant_id           UUID NOT NULL,
  business_id         UUID NOT NULL REFERENCES businesses(id),
  delivery_id         UUID NOT NULL,
  provider            TEXT NOT NULL,
  provider_message_id TEXT NULL,
  provider_event_id   TEXT NULL,
  -- I-9c3 the status token is constrained: the same five values as `DeliveryStatus`.
  status              TEXT NOT NULL
    CONSTRAINT provider_statuses_status_in CHECK (status IN ('queued','sent','delivered','read','failed')),
  -- I-10b the verdict is a COMPUTED verdict, not a claim.
  verification        TEXT NOT NULL
    CONSTRAINT provider_statuses_verification_in
    CHECK (verification IN ('verified','signature_missing','signature_malformed',
                            'signature_mismatch','secret_not_configured')),
  received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_status_text     TEXT NULL,
  FOREIGN KEY (delivery_id, business_id) REFERENCES notification_deliveries (id, business_id),
  CONSTRAINT provider_statuses_verified_has_message_id
    CHECK (verification <> 'verified' OR provider_message_id IS NOT NULL),
  -- I-11 replay is not an event.
  CONSTRAINT provider_statuses_event_once UNIQUE (provider, provider_event_id)
);

-- I-9c2 an unmatched landing goes to QUARANTINE, not to tenant data: no tenant
-- column, no FK, no transition power. §9 case I9C2 asserts those absences.
CREATE TABLE notification_provider_quarantine (
  id                UUID PRIMARY KEY,
  provider          TEXT NOT NULL,
  provider_event_id TEXT NULL,
  status_token      TEXT NULL,
  verification      TEXT NOT NULL,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
-- §6  Isolation, roles and grants
-- =====================================================================
-- The roles are NOT created here. The migrator is NOCREATEROLE, as the deploy
-- role is, so role creation is the cluster administrator's step and this file
-- only grants to roles that already exist. It fails CLOSED when one is absent,
-- rather than quietly granting to a role it invented.
DO $$ DECLARE r TEXT; BEGIN
  FOREACH r IN ARRAY ARRAY['p8_app','p8_worker','p8_webhook'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      RAISE EXCEPTION 'notification.grantee_role_absent: %', r USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
END $$;
GRANT USAGE ON SCHEMA p8 TO p8_app, p8_worker, p8_webhook;

-- daftar_app: may read and create an obligation; may NEVER decide a status.
GRANT SELECT, INSERT ON notifications TO p8_app;
GRANT SELECT, INSERT, UPDATE ON notification_preferences TO p8_app;
GRANT SELECT ON notification_deliveries TO p8_app;   -- read whether something was sent; never decide it
GRANT SELECT ON notification_settings TO p8_app, p8_worker;

-- daftar_worker: column-scoped UPDATE only.
GRANT SELECT ON notifications TO p8_worker;
GRANT UPDATE (status, last_error_code, updated_at) ON notifications TO p8_worker;
GRANT SELECT, INSERT ON notification_deliveries TO p8_worker;
GRANT UPDATE (delivery_state, unknown_reason, attempts_made, next_attempt_after,
              provider_message_id, last_error_code, updated_at,
              final_status, final_status_verified, arrival_ever_recorded)
  ON notification_deliveries TO p8_worker;
GRANT SELECT, INSERT ON notification_attempts TO p8_worker;
GRANT SELECT, INSERT ON notification_provider_statuses TO p8_worker;
GRANT SELECT ON notification_preferences TO p8_worker;
-- the webhook role writes landings and quarantine, and nothing else.
GRANT INSERT ON notification_provider_statuses TO p8_webhook;
GRANT INSERT, SELECT ON notification_provider_quarantine TO p8_webhook;

-- RLS on all five tenant relations, FORCED so the owner is not exempt.
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['notifications','notification_preferences','notification_deliveries',
                           'notification_attempts','notification_provider_statuses'] LOOP
    EXECUTE format('ALTER TABLE p8.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE p8.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY %I ON p8.%I AS RESTRICTIVE FOR ALL
                      USING (p8.app_bypass() OR business_id = p8.app_business())
                      WITH CHECK (p8.app_bypass() OR business_id = p8.app_business())$f$,
                   t || '_business_isolation', t);
    EXECUTE format($f$CREATE POLICY %I ON p8.%I AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true)$f$,
                   t || '_permissive_base', t);
  END LOOP;
END $$;
