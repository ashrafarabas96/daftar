-- P9-BOOKING-DDL-SPEC.sql
-- P9-S1 — the universal booking model's SCHEMA and its physical invariants
-- (master directive Part 29; Part 9 PREPARED / NOT PROMOTED; Part 10 one
-- migration train; Part 39 real concurrency; Part 40 proof-of-proof).
--
-- THIS FILE IS NOT A MIGRATION. It carries no number, it is not in
-- infrastructure/database/migrations/, and it is absent from
-- MIGRATION_MANIFEST.json by design. Part 10 gives exactly one Migration
-- Owner the authority to allocate a number; this file is the DDL half of the
-- MIGRATION PATCH REQUEST in docs/phase9/P9-MIGRATION-PATCH-REQUEST.md, and
-- the Migration Owner is the only principal that may turn it into a numbered
-- migration file. This file names no number and proposes none.
--
-- It is, however, EXECUTABLE, and it is executed: tests/phase9-prep extracts
-- it from this path and applies it to a real PostgreSQL cluster on top of the
-- migrations 0000-0073, then races real transactions against it. A spec that
-- a parser and a live server have never had an opinion about is design, not
-- engineering (the lesson P4-S7-1 paid for twice).
--
-- ── What this file creates ───────────────────────────────────────────────
--   booking_services             what a merchant schedules, and its buffers
--   booking_resources            the thing that can be double-booked
--   booking_service_resources    which resource may perform which service
--   booking_resource_schedules   recurring weekly availability
--   booking_resource_exceptions  dated availability overrides (open/closed)
--   bookings                     appointments AND resource blocks, one table
--   booking_operations           durable command identity (idempotency)
--   five trigger functions + their triggers
--   row security on all seven relations, and the grant model
--   the end-state block (P9-E)
--
-- ── What this file does NOT do ───────────────────────────────────────────
--   * It allocates no migration number and edits no frozen migration.
--   * It writes NO command function. The command layer (booking_create,
--     booking_cancel, booking_reschedule) needs a booking authority
--     assertion and its key, which is its own slice; §9's grants already
--     put every runtime role in the position that layer requires, so the
--     command slice adds routines and changes no grant.
--   * It touches NO money. A booking that bills posts through the canonical
--     sales/accounting authority when Phase 4 is sealed (Part 11: one
--     financial truth). There is no price, no tax and no amount column
--     anywhere below, and that is deliberate, not an omission.
--   * It does not enforce schedule CONTAINMENT — does this booking fall
--     inside the resource's working hours, on that resource's own civil day?
--     The input exists (`businesses.timezone`, an IANA name validated at the
--     database boundary since 0023), so this is a deferral, not a gap: the
--     rule is stated in §4 and belongs to the command slice, because
--     containment is a VALIDATION, not a concurrency invariant. Two
--     concurrent bookings both outside working hours are two independently
--     wrong rows, not a corrupted one; two concurrent bookings on the same
--     hour are one corrupted resource, and that is what §5 makes
--     impossible.
--
-- ── Header rules ─────────────────────────────────────────────────────────
-- R-P9-01  Overlap is PHYSICAL, never a trigger that looks for a conflict.
--          0049:228-233 already settled this for accounting periods: two
--          concurrent inserts can both look and both find nothing. An
--          exclusion constraint is the only mechanism correct under
--          concurrency. §7 of the proof suite plants the SELECT-then-INSERT
--          implementation and shows it committing a double booking.
-- R-P9-02  The excluded range is the BLOCKING window, not the service
--          window. A buffer enforced in application code is not enforced:
--          the constraint would allow a booking that starts inside the
--          previous one's clean-up time. The customer-facing span and the
--          span that occupies the resource are therefore two different
--          things, and only the second one is indexed.
-- R-P9-03  `blocking_window` is a stored column pinned by a CHECK, not a
--          generated column. `timestamptz - interval` is STABLE, not
--          IMMUTABLE, so PostgreSQL 18 refuses it in a generation
--          expression with 42P17 — measured, not assumed. A CHECK accepts a
--          STABLE expression, and because `make_interval(mins => n)` yields
--          a pure time interval, the arithmetic is exact and carries no
--          timezone dependence; §TZ of the proof suite re-evaluates the
--          invariant under four DST zones. The CHECK is what stops a caller
--          supplying a narrower window than its own times imply (23514),
--          which is the only way a client could otherwise slip past the
--          exclusion constraint. No BEFORE trigger recomputes the column:
--          a trigger that overwrote it would make the CHECK a guard that
--          can never fire, and a dead guard is worse than none (Part 40).
-- R-P9-04  Adjacency is not overlap. `'[)'` — inclusive start, exclusive
--          end — is what a clock span means: 10:00-11:00 and 11:00-12:00 are
--          back-to-back, not conflicting. 0049 uses `'[]'` because a civil
--          DATE period is inclusive at both ends; a timestamp span is not,
--          and copying `'[]'` here would refuse every correctly adjacent
--          appointment.
-- R-P9-05  A CLOSURE IS A ROW IN `bookings`. A resource block (holiday,
--          maintenance, lunch) occupies a resource exactly as an appointment
--          does, so it lives in the same relation under the same exclusion
--          constraint. Modelled as a separate table it would need a trigger
--          to check bookings against closures — and that trigger would lose
--          the same race R-P9-01 describes, in the other direction: a
--          closure and a booking could both be inserted concurrently and
--          both find nothing. One table, one physical invariant, no race.
-- R-P9-06  Eligibility is a composite FK, not a trigger. "This resource may
--          perform this service" is `FOREIGN KEY (business_id, service_id,
--          resource_id) REFERENCES booking_service_resources`, which is
--          MATCH SIMPLE and therefore skipped when `service_id` is NULL —
--          exactly the behaviour a resource block needs.
-- R-P9-07  The buffers are COPIED onto the booking and checked against the
--          service once, at INSERT, by a constraint trigger. They are
--          deliberately NOT a composite FK into the service's buffers:
--          that would make a buffer edit impossible for any service with a
--          booking (ON UPDATE RESTRICT) or silently move every existing
--          booking's blocking window (ON UPDATE CASCADE). A booking's
--          occupied span is what was agreed with the customer; a later
--          catalogue edit does not reach backwards into it.
-- R-P9-08  Append-only in the ways that matter. No row is ever deleted. The
--          window, the resource, the service, the customer and the buffers
--          are immutable after INSERT; only `state` and its transition
--          metadata may change, and only along the state machine in §6.
--          A reschedule is a NEW row plus a transition on the old one, in
--          one transaction, in that order.
-- R-P9-09  Money is absent, not zero. See "What this file does NOT do".
-- R-P9-11  A BOOKING COMMAND TAKES THE RESOURCE'S ADVISORY LOCK FIRST.
--          Measured, not foreseen: with two transactions inserting
--          overlapping rows straight into the exclusion index, each inserts
--          its own index entry, then finds the other's and waits on it — so
--          they wait on each other and PostgreSQL's deadlock detector kills
--          one after `deadlock_timeout` with 40P01. The OUTCOME is still
--          correct (exactly one booking commits; there is no double booking
--          at any point), but the refusal a customer gets is
--          `deadlock_detected` instead of `exclusion_violation`, and a
--          deadlock is not a sentence any UI can turn into "that time has
--          just been taken".
--
--          `booking_resource_lock_key` and `pg_advisory_xact_lock` are the
--          fix, and it is 0049's own idiom: one key per (business, resource),
--          taken as the command's FIRST act, so every booking on a resource
--          queues on one lock in one order and no cycle can form. The loser
--          then waits on the LOCK, and reaches the index only after the
--          winner has committed — where it gets a clean 23P01 every time.
--          §7 of the proof suite shows the deadlock happening without the
--          lock and not happening with it; that negative control is the only
--          reason to believe the lock is load-bearing rather than decorative.
--
-- R-P9-10  Every refusal is `'<domain>.<snake_case_condition>: sentence'`
--          with `ERRCODE = 'P0001'`, the convention of every migration from
--          0053 on. Domain prefix `booking.`.
--
-- Migrations 0000-0073 are FROZEN and untouched. This file adds no migration.

-- ─────────────────────────────────────────────────────────────────────────
-- 0. Preconditions. Nothing below is attempted unless the deployment is
--    already in the shape this schema needs.
--
--    (a) btree_gist. Physical non-overlap over (business, resource, range)
--        needs a GiST opclass that holds equality columns beside a range
--        column, and that lives in btree_gist. 0049:111-151 measured the
--        three privilege shapes and settled on the one that adds NO
--        privilege: the deployment administrator installs the extension in
--        bootstrap.sql, and a migration only asserts it. bootstrap.sql:18
--        already does exactly that, for 0049 — so Phase 9 needs no change
--        to the deployment contract for the extension. This block is the
--        assertion, in 0049's words and with its own code.
--
--    (b) daftar_booking_internal. The internal NOLOGIN authority that owns
--        the definer surface and holds the only DML on these relations.
--        It does NOT exist yet: bootstrap.sql creates four such roles
--        (accounting, inventory, catalog, provisioning) and this is the
--        fifth. Creating a role is a deployment-administrator act, exactly
--        as installing an extension is, so it is a PATCH REQUEST against
--        bootstrap.sql (§1 of P9-MIGRATION-PATCH-REQUEST.md) and NOT
--        something this file does. The precondition refuses loudly instead,
--        in 0070:96-128's shape, because a migration that silently created
--        its own authority would put the deployment's role inventory
--        somewhere nobody audits.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') THEN
    BEGIN
      CREATE EXTENSION btree_gist;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'booking.extension_missing: the booking model requires the btree_gist extension, which the migration principal may not install. Install it once as the deployment administrator — infrastructure/database/bootstrap.sql does exactly that — and re-run this migration.' USING ERRCODE = 'P0001';
    END;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daftar_booking_internal') THEN
    RAISE EXCEPTION 'authority.migration_precondition: daftar_booking_internal does not exist — re-run infrastructure/database/bootstrap.sql before the booking migration' USING ERRCODE = 'P0001';
  END IF;
END $$;

-- The ownership-transfer authority, taken here and returned in §10. DDL is
-- transactional and §11 refuses to commit if any of it survived.
GRANT CREATE ON SCHEMA public TO daftar_booking_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. `booking_services` — what the merchant schedules.
--
-- The buffers live here because they are a property of the work, not of one
-- appointment: a haircut needs ten minutes of clean-up whoever books it.
-- They are copied onto each booking at INSERT (R-P9-07) and the copy is what
-- the physical invariant uses.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE booking_services (
  tenant_id                 UUID NOT NULL,
  business_id               UUID NOT NULL,
  id                        UUID NOT NULL,
  code                      TEXT NOT NULL,
  display_name              TEXT NOT NULL,
  default_duration_minutes  INTEGER NOT NULL,
  lead_buffer_minutes       INTEGER NOT NULL DEFAULT 0,
  trail_buffer_minutes      INTEGER NOT NULL DEFAULT 0,
  status                    TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by_user_id        UUID NOT NULL REFERENCES users (id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),

  CONSTRAINT booking_services_tenant_business_fk
    FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),

  CONSTRAINT booking_services_code_uq UNIQUE (business_id, code),
  CONSTRAINT booking_services_code_ck CHECK (code = btrim(code) AND code ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  CONSTRAINT booking_services_display_name_ck CHECK (display_name = btrim(display_name) AND char_length(display_name) BETWEEN 1 AND 120),

  -- A service lasts at least a minute and at most a day. The upper bound is
  -- not decoration: it is what keeps a typo from reserving a resource for a
  -- decade, and the booking window's own bound (§5) depends on it.
  CONSTRAINT booking_services_duration_ck CHECK (default_duration_minutes BETWEEN 1 AND 1440),
  CONSTRAINT booking_services_buffers_ck CHECK (
    lead_buffer_minutes BETWEEN 0 AND 1440 AND trail_buffer_minutes BETWEEN 0 AND 1440
  )
);
REVOKE ALL ON booking_services FROM PUBLIC;

COMMENT ON TABLE booking_services IS
  'P9-S1. What a merchant schedules: a named unit of work with a default duration and the buffers it needs around it. Carries no price — a booking that bills posts through the canonical sales authority, and a second price column here would be a second financial truth (master directive Part 11).';
COMMENT ON COLUMN booking_services.lead_buffer_minutes IS
  'Minutes the resource is occupied BEFORE the customer-facing start (set-up, travel). Copied onto each booking at INSERT and never read from here afterwards: a later edit to this service does not move an agreed appointment (R-P9-07).';
COMMENT ON COLUMN booking_services.trail_buffer_minutes IS
  'Minutes the resource is occupied AFTER the customer-facing end (clean-up, turnaround). Same copy-at-INSERT contract as lead_buffer_minutes.';
COMMENT ON COLUMN booking_services.default_duration_minutes IS
  'The duration the booking UI proposes. It is a DEFAULT, not a constraint: a booking carries its own start and end, because real appointments run long and a universal model that refused that would be unusable.';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. `booking_resources` — the thing that can be double-booked.
--
-- Capacity is deliberately ONE. An exclusion constraint expresses "no two
-- overlapping rows", not "at most N overlapping rows", and there is no
-- declarative way to say the second. A room for six is six resources, or a
-- documented follow-up; it is NOT a `capacity INTEGER` column that the
-- physical invariant cannot see. See §12 (OPEN) — this is the one place the
-- model knowingly stops short, and it stops short honestly rather than
-- carrying a column no constraint enforces.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE booking_resources (
  tenant_id          UUID NOT NULL,
  business_id        UUID NOT NULL,
  branch_id          UUID NOT NULL,
  id                 UUID NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('staff', 'room', 'equipment')),
  display_name       TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by_user_id UUID NOT NULL REFERENCES users (id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),

  CONSTRAINT booking_resources_tenant_business_fk
    FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT booking_resources_branch_fk
    FOREIGN KEY (business_id, branch_id) REFERENCES branches (business_id, id),

  CONSTRAINT booking_resources_display_name_ck CHECK (display_name = btrim(display_name) AND char_length(display_name) BETWEEN 1 AND 120)
);
REVOKE ALL ON booking_resources FROM PUBLIC;

COMMENT ON TABLE booking_resources IS
  'P9-S1. The scarce thing a booking consumes — a staff member, a room, a machine. Exactly one booking may occupy a resource at a time; that is the whole invariant of this slice and it is physical (bookings_no_overlap). Capacity greater than one is NOT modelled: see §12.';
COMMENT ON COLUMN booking_resources.branch_id IS
  'The branch the resource belongs to. Branch scope is an application-side authorization check (there is no app.branch_id GUC, by the ruling in apps/api/src/infra/database.ts); this column is what that check reads.';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. `booking_service_resources` — eligibility, and the FK target that makes
--    it declarative (R-P9-06).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE booking_service_resources (
  tenant_id   UUID NOT NULL,
  business_id UUID NOT NULL,
  service_id  UUID NOT NULL,
  resource_id UUID NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, service_id, resource_id),

  CONSTRAINT booking_service_resources_tenant_business_fk
    FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT booking_service_resources_service_fk
    FOREIGN KEY (business_id, service_id) REFERENCES booking_services (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT booking_service_resources_resource_fk
    FOREIGN KEY (business_id, resource_id) REFERENCES booking_resources (business_id, id) ON DELETE RESTRICT
);
REVOKE ALL ON booking_service_resources FROM PUBLIC;

COMMENT ON TABLE booking_service_resources IS
  'P9-S1. Which resource may perform which service. Its primary key is the FK target that makes eligibility a declarative property of every appointment row rather than a trigger (R-P9-06).';

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Availability: the recurring week, and the dated overrides.
--
-- These two relations describe when a resource is OFFERED. They are not the
-- overlap invariant and they are not in its path: a booking's legality
-- against them is a validation the command layer performs (§6, R-P9-07),
-- and a closure that must physically exclude bookings is a row in
-- `bookings` instead (R-P9-05).
--
-- `weekday` is ISO-8601: 1 = Monday … 7 = Sunday, matching
-- `EXTRACT(ISODOW FROM …)` so the lookup needs no translation table.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE booking_resource_schedules (
  tenant_id     UUID NOT NULL,
  business_id   UUID NOT NULL,
  resource_id   UUID NOT NULL,
  id            UUID NOT NULL,
  weekday       SMALLINT NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  opens_at      TIME NOT NULL,
  closes_at     TIME NOT NULL,
  effective_from DATE NOT NULL,
  effective_to   DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),

  CONSTRAINT booking_resource_schedules_tenant_business_fk
    FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT booking_resource_schedules_resource_fk
    FOREIGN KEY (business_id, resource_id) REFERENCES booking_resources (business_id, id) ON DELETE RESTRICT,

  -- A window inside one civil day, opening strictly before it closes. A
  -- resource open across midnight is two rows, which keeps every row
  -- answerable by one weekday.
  CONSTRAINT booking_resource_schedules_window_ck CHECK (opens_at < closes_at),
  CONSTRAINT booking_resource_schedules_effective_ck CHECK (effective_to IS NULL OR effective_from <= effective_to),
  CONSTRAINT booking_resource_schedules_finite_ck CHECK (
    effective_from <> 'infinity'::date AND effective_from <> '-infinity'::date
    AND (effective_to IS NULL OR (effective_to <> 'infinity'::date AND effective_to <> '-infinity'::date))
  )
);
REVOKE ALL ON booking_resource_schedules FROM PUBLIC;

COMMENT ON TABLE booking_resource_schedules IS
  'P9-S1. A resource''s recurring weekly availability. weekday is ISO-8601 (1 = Monday … 7 = Sunday) so it matches EXTRACT(ISODOW FROM …) with no translation. Describes what is OFFERED; it does not and cannot enforce non-overlap (R-P9-05).';

CREATE TABLE booking_resource_exceptions (
  tenant_id          UUID NOT NULL,
  business_id        UUID NOT NULL,
  resource_id        UUID NOT NULL,
  id                 UUID NOT NULL,
  on_date            DATE NOT NULL,
  effect             TEXT NOT NULL CHECK (effect IN ('closed', 'open')),
  opens_at           TIME,
  closes_at          TIME,
  reason             TEXT,
  created_by_user_id UUID NOT NULL REFERENCES users (id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),

  CONSTRAINT booking_resource_exceptions_tenant_business_fk
    FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT booking_resource_exceptions_resource_fk
    FOREIGN KEY (business_id, resource_id) REFERENCES booking_resources (business_id, id) ON DELETE RESTRICT,

  -- Stated as an equivalence rather than two one-way checks, so neither an
  -- 'open' override without a window nor a 'closed' day carrying one can
  -- exist even for the duration of one statement (0049:208-212's shape).
  CONSTRAINT booking_resource_exceptions_shape_ck CHECK (
    (effect = 'open') = (opens_at IS NOT NULL AND closes_at IS NOT NULL)
  ),
  CONSTRAINT booking_resource_exceptions_window_ck CHECK (opens_at IS NULL OR opens_at < closes_at),
  CONSTRAINT booking_resource_exceptions_day_uq UNIQUE (business_id, resource_id, on_date),
  CONSTRAINT booking_resource_exceptions_reason_ck CHECK (
    reason IS NULL OR (btrim(reason, E' \t\n\r') = reason AND char_length(reason) BETWEEN 1 AND 500)
  ),
  CONSTRAINT booking_resource_exceptions_finite_ck CHECK (
    on_date <> 'infinity'::date AND on_date <> '-infinity'::date
  )
);
REVOKE ALL ON booking_resource_exceptions FROM PUBLIC;

COMMENT ON TABLE booking_resource_exceptions IS
  'P9-S1. A dated override of the weekly schedule: a holiday that closes a day, or extra hours that open one. Marking a day ''closed'' changes what is OFFERED; it does not evict or exclude a booking already standing on that day — to physically hold time against bookings, insert a resource_block row in `bookings` (R-P9-05).';

-- ─────────────────────────────────────────────────────────────────────────
-- 5. `bookings` — appointments AND resource blocks, under one invariant.
--
-- This is the whole slice. Everything above describes the world; this table
-- is the thing concurrency attacks, and `bookings_no_overlap` is the answer.
--
-- Why one table for two kinds (R-P9-05): a block and an appointment occupy a
-- resource identically, so they must be excluded by the same index. Two
-- tables would need a trigger to compare them, and that trigger would lose
-- exactly the race R-P9-01 names — a block and an appointment inserted
-- concurrently could both look, both find nothing, and both commit.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE bookings (
  tenant_id            UUID NOT NULL,
  business_id          UUID NOT NULL,
  branch_id            UUID NOT NULL,
  id                   UUID NOT NULL,

  kind                 TEXT NOT NULL CHECK (kind IN ('appointment', 'resource_block')),
  resource_id          UUID NOT NULL,
  service_id           UUID,
  customer_id          UUID,

  starts_at            TIMESTAMPTZ NOT NULL,
  ends_at              TIMESTAMPTZ NOT NULL,
  lead_buffer_minutes  INTEGER NOT NULL DEFAULT 0,
  trail_buffer_minutes INTEGER NOT NULL DEFAULT 0,

  -- R-P9-02, R-P9-03. The span that OCCUPIES the resource: the agreed times
  -- widened by the buffers. Stored, pinned by a CHECK to the columns it is
  -- derived from, and the only thing the exclusion constraint looks at.
  blocking_window      TSTZRANGE NOT NULL,

  state                TEXT NOT NULL DEFAULT 'booked'
    CHECK (state IN ('booked', 'completed', 'no_show', 'cancelled', 'rescheduled')),

  rescheduled_to_id    UUID,
  rescheduled_from_id  UUID,
  settled_at           TIMESTAMPTZ,
  settled_by_user_id   UUID REFERENCES users (id),
  settle_reason        TEXT,

  intent_sha256        TEXT NOT NULL CHECK (intent_sha256 ~ '^[0-9a-f]{64}$'),
  created_by_user_id   UUID NOT NULL REFERENCES users (id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (business_id, id),

  CONSTRAINT bookings_tenant_business_fk
    FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT bookings_branch_fk
    FOREIGN KEY (business_id, branch_id) REFERENCES branches (business_id, id),
  CONSTRAINT bookings_resource_fk
    FOREIGN KEY (business_id, resource_id) REFERENCES booking_resources (business_id, id) ON DELETE RESTRICT,

  -- R-P9-06. Eligibility, declaratively. MATCH SIMPLE: with service_id NULL
  -- the row is a resource block and the check does not apply.
  CONSTRAINT bookings_eligible_resource_fk
    FOREIGN KEY (business_id, service_id, resource_id)
    REFERENCES booking_service_resources (business_id, service_id, resource_id) ON DELETE RESTRICT,

  -- An appointment is for a customer, for a service. A block is for neither.
  -- Stated as two equivalences so a half-formed row of either kind cannot
  -- exist for the duration of one statement.
  CONSTRAINT bookings_kind_shape_ck CHECK (
    (kind = 'appointment') = (service_id IS NOT NULL)
    AND (kind = 'appointment') = (customer_id IS NOT NULL)
  ),

  -- A booking occupies time. Zero-length is not a booking, and `<` rather
  -- than `<=` is what makes the blocking window non-empty — an empty range
  -- overlaps nothing, so a zero-length row would be invisible to the
  -- exclusion constraint and could be stacked without limit.
  CONSTRAINT bookings_order_ck CHECK (starts_at < ends_at),

  -- FINITE. PostgreSQL TIMESTAMPTZ has 'infinity', and an infinite booking
  -- would swallow a resource's entire future while remaining a legal row.
  CONSTRAINT bookings_finite_ck CHECK (
    starts_at <> 'infinity'::timestamptz AND starts_at <> '-infinity'::timestamptz
    AND ends_at <> 'infinity'::timestamptz AND ends_at <> '-infinity'::timestamptz
  ),

  -- Whole minutes, bounded. The bound is the same 1440 the service duration
  -- carries: a longer span is a series of bookings or a resource block.
  CONSTRAINT bookings_duration_ck CHECK (
    ends_at - starts_at <= interval '1440 minutes'
    AND date_trunc('minute', starts_at) = starts_at
    AND date_trunc('minute', ends_at) = ends_at
  ),
  CONSTRAINT bookings_buffers_ck CHECK (
    lead_buffer_minutes BETWEEN 0 AND 1440 AND trail_buffer_minutes BETWEEN 0 AND 1440
  ),

  -- R-P9-03. The blocking window IS the times widened by the buffers, and a
  -- caller that supplies anything else is refused with 23514. Without this
  -- line the exclusion constraint would guard a value the client chooses,
  -- which is no guard at all.
  CONSTRAINT bookings_blocking_window_ck CHECK (
    blocking_window = tstzrange(
      starts_at - make_interval(mins => lead_buffer_minutes),
      ends_at   + make_interval(mins => trail_buffer_minutes),
      '[)')
  ),

  -- A reschedule points forward exactly when it was rescheduled, and the
  -- new row is never its own predecessor.
  CONSTRAINT bookings_reschedule_shape_ck CHECK ((state = 'rescheduled') = (rescheduled_to_id IS NOT NULL)),
  CONSTRAINT bookings_reschedule_self_ck CHECK (rescheduled_to_id IS DISTINCT FROM id AND rescheduled_from_id IS DISTINCT FROM id),
  CONSTRAINT bookings_reschedule_to_fk
    FOREIGN KEY (business_id, rescheduled_to_id) REFERENCES bookings (business_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT bookings_reschedule_from_fk
    FOREIGN KEY (business_id, rescheduled_from_id) REFERENCES bookings (business_id, id) DEFERRABLE INITIALLY DEFERRED,

  -- A settlement (completed / no_show / cancelled / rescheduled) is recorded
  -- in full or not at all: who, when. The reason is required for the two
  -- states a human chose and forbidden for neither of the others.
  CONSTRAINT bookings_settled_shape_ck CHECK (
    (state <> 'booked') = (settled_at IS NOT NULL AND settled_by_user_id IS NOT NULL)
  ),
  CONSTRAINT bookings_settle_reason_ck CHECK (
    settle_reason IS NULL
    OR (btrim(settle_reason, E' \t\n\r') = settle_reason AND char_length(settle_reason) BETWEEN 1 AND 500)
  ),
  CONSTRAINT bookings_cancel_reason_ck CHECK (state <> 'cancelled' OR settle_reason IS NOT NULL),

  -- ═══════════════════════════════════════════════════════════════════════
  -- R-P9-01, R-P9-02, R-P9-04, R-P9-05. THE INVARIANT.
  --
  -- At most one row may occupy a given resource at a given instant. Keyed on
  -- (business, resource) by equality and on the BLOCKING window by overlap,
  -- restricted to the states that actually occupy the resource.
  --
  -- Why the state predicate is this exact set: 'booked' is standing,
  -- 'completed' and 'no_show' consumed the slot and are history that a
  -- second booking must not be written over. 'cancelled' and 'rescheduled'
  -- released it, so the index must forget them — otherwise a cancelled
  -- appointment would hold its hour for ever.
  --
  -- business_id is in the key beside resource_id even though the composite
  -- FK already ties a resource to one business. It costs one equality
  -- column and it means the index itself, read alone, states the tenancy
  -- boundary rather than inheriting it.
  -- ═══════════════════════════════════════════════════════════════════════
  CONSTRAINT bookings_no_overlap
    EXCLUDE USING gist (business_id WITH =, resource_id WITH =, blocking_window WITH &&)
    WHERE (state IN ('booked', 'completed', 'no_show'))
);
REVOKE ALL ON bookings FROM PUBLIC;

COMMENT ON TABLE bookings IS
  'P9-S1. Appointments and resource blocks, in one relation under one physical invariant (bookings_no_overlap). Rows are never deleted; the window, resource, service, customer and buffers are immutable after INSERT and only `state` and its settlement metadata ever change. A reschedule is a new row plus a transition on the old one, in one transaction (R-P9-08).';
COMMENT ON COLUMN bookings.blocking_window IS
  'The span that OCCUPIES the resource: [starts_at - lead_buffer, ends_at + trail_buffer). Half-open, so back-to-back bookings are adjacent rather than conflicting (R-P9-04). Pinned to its inputs by bookings_blocking_window_ck — a caller cannot narrow it to slip past the exclusion constraint (R-P9-03). The customer-facing span is starts_at..ends_at and is deliberately NOT what the index holds (R-P9-02).';
COMMENT ON COLUMN bookings.kind IS
  '''appointment'' (a customer, a service) or ''resource_block'' (neither: a holiday, maintenance, a lunch break). One table, because both occupy a resource and the invariant must see both (R-P9-05).';
COMMENT ON COLUMN bookings.state IS
  'booked → completed | no_show | cancelled | rescheduled, and those four are terminal. The first three occupy the resource for ever; the last two release it, which is exactly the predicate on bookings_no_overlap.';
COMMENT ON COLUMN bookings.customer_id IS
  'The customer this appointment is for. It carries NO foreign key in this slice: `customers` is a Phase 4 relation and Phase 4 is not sealed, so a FK here would bind an unpromoted Phase 9 to an unsealed Phase 4 schema. The Migration Owner adds it at promotion — §2 of P9-MIGRATION-PATCH-REQUEST.md names the exact statement.';
COMMENT ON COLUMN bookings.intent_sha256 IS
  'The digest of the command that created this row, the project''s established idempotency/trace shape (0067:293-296). The command layer writes it; this slice only requires that it is present and well-formed.';

-- The lookups this slice performs. The exclusion constraint's GiST index
-- answers "what occupies this resource around this instant", which is both
-- the availability read and the conflict check, so neither needs an index of
-- its own. These two serve the reads the GiST index does not: one resource's
-- day in state order, and one customer's upcoming appointments.
CREATE INDEX bookings_resource_start_idx ON bookings (business_id, resource_id, starts_at);
CREATE INDEX bookings_customer_start_idx ON bookings (business_id, customer_id, starts_at) WHERE customer_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- 5a. The per-resource serialization key (R-P9-11).
--
-- ONE key per (business, resource), not one global booking lock. Booking
-- chair A never waits on chair B, and a booking in one business never waits
-- on another business at all. It exists so that every transaction that wants
-- to occupy a given resource queues behind the same lock, in one order,
-- BEFORE it reaches the exclusion index — which is what turns a mutual wait
-- into a queue and a 40P01 into a 23P01.
--
-- Taking it is the COMMAND's obligation, and the command slice is not in
-- this file. What this file can do is define the key once, so there is
-- exactly one of it and no caller invents its own hash; the proof suite
-- demonstrates both sides of the discipline.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION booking_resource_lock_key(p_business UUID, p_resource UUID) RETURNS BIGINT
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT hashtextextended('booking:' || lower(p_business::text) || '|resource:' || lower(p_resource::text), 0)
$$;
COMMENT ON FUNCTION booking_resource_lock_key(UUID, UUID) IS
  'P9-S1, R-P9-11. The advisory-lock key a booking command takes as its FIRST act, one per (business, resource). Without it two transactions inserting overlapping rows wait on each other inside the exclusion index and one dies with 40P01 after deadlock_timeout — the right outcome under the wrong error. With it they queue, and the loser gets 23P01. STRICT and IMMUTABLE: a NULL business or resource has no key, and the same pair must always hash the same.';
REVOKE ALL ON FUNCTION booking_resource_lock_key(UUID, UUID) FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. Append-only, and the state machine.
--
-- The exclusion constraint makes double booking impossible. These triggers
-- make the OTHER way of producing one impossible: editing a standing row's
-- window, or resurrecting a cancelled one, instead of inserting a new row.
-- Without them a caller with UPDATE could move a booking on top of another
-- in a single statement — the constraint would catch THAT, but it would not
-- catch moving a booking out of the way and silently rewriting what a
-- customer agreed to.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION bookings_no_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'booking.not_deletable: a booking is retained with its history; cancel it instead' USING ERRCODE = 'P0001';
END $$;
COMMENT ON FUNCTION bookings_no_delete() IS
  'P9-S1, R-P9-08. Raise-only BEFORE DELETE guard on `bookings`. Refuses every delete, including the owner''s, with booking.not_deletable. SECURITY INVOKER: it reads nothing and decides nothing from who is writing.';
REVOKE ALL ON FUNCTION bookings_no_delete() FROM PUBLIC;

CREATE TRIGGER bookings_no_deletion
  BEFORE DELETE ON bookings
  FOR EACH ROW EXECUTE FUNCTION bookings_no_delete();

CREATE OR REPLACE FUNCTION bookings_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- (a) Everything that defines WHICH time is held, and for whom, is frozen.
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
     OR NEW.service_id IS DISTINCT FROM OLD.service_id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
     OR NEW.ends_at IS DISTINCT FROM OLD.ends_at
     OR NEW.lead_buffer_minutes IS DISTINCT FROM OLD.lead_buffer_minutes
     OR NEW.trail_buffer_minutes IS DISTINCT FROM OLD.trail_buffer_minutes
     OR NEW.blocking_window IS DISTINCT FROM OLD.blocking_window
     OR NEW.rescheduled_from_id IS DISTINCT FROM OLD.rescheduled_from_id
     OR NEW.intent_sha256 IS DISTINCT FROM OLD.intent_sha256
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'booking.immutable: a booking''s time, resource, service, customer and buffers never change — reschedule inserts a new booking' USING ERRCODE = 'P0001';
  END IF;

  -- (b) The state machine. 'booked' is the only state anything leaves.
  IF OLD.state <> 'booked' AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'booking.state_terminal: % is a terminal state and cannot become %', OLD.state, NEW.state USING ERRCODE = 'P0001';
  END IF;
  IF NEW.state = 'booked' AND OLD.state <> 'booked' THEN
    RAISE EXCEPTION 'booking.state_not_reopenable: a settled booking is never reopened; book a new one' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END $$;
COMMENT ON FUNCTION bookings_transition() IS
  'P9-S1, R-P9-08. BEFORE UPDATE guard on `bookings`: refuses any change to the identity, the held time or the buffers (booking.immutable), refuses to leave a terminal state (booking.state_terminal) and refuses to re-enter ''booked'' (booking.state_not_reopenable). SECURITY INVOKER — it compares OLD to NEW and reads no relation.';
REVOKE ALL ON FUNCTION bookings_transition() FROM PUBLIC;

CREATE TRIGGER bookings_transition_only
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION bookings_transition();

-- R-P9-07. The copied buffers describe the service they name. Checked once,
-- at INSERT, as a CONSTRAINT TRIGGER so it is evaluated against the service
-- row as it stands at COMMIT rather than mid-statement. It is SECURITY
-- DEFINER because it must read `booking_services` whatever the writer can
-- see — a row-security rule that hid the service would otherwise turn this
-- guard into one that passes by seeing nothing, which is the failure
-- P4-S7-1 recorded (a guard that cannot read its subject refuses, or admits,
-- everything).
CREATE OR REPLACE FUNCTION bookings_buffers_match_service() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_lead  INTEGER;
  v_trail INTEGER;
BEGIN
  SELECT s.lead_buffer_minutes, s.trail_buffer_minutes
    INTO v_lead, v_trail
    FROM public.booking_services s
   WHERE s.business_id = NEW.business_id AND s.id = NEW.service_id;

  -- Not "IF FOUND THEN compare": an absent service is a refusal of its own.
  -- The composite FK already makes it unreachable, and this says so rather
  -- than passing silently if it ever becomes reachable.
  IF v_lead IS NULL THEN
    RAISE EXCEPTION 'booking.service_unreadable: the service this booking names could not be read, so its buffers cannot be checked' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.lead_buffer_minutes <> v_lead OR NEW.trail_buffer_minutes <> v_trail THEN
    RAISE EXCEPTION 'booking.buffers_not_the_service_s: the buffers on this booking are not the ones its service declares' USING ERRCODE = 'P0001';
  END IF;

  RETURN NULL;
END $$;
COMMENT ON FUNCTION bookings_buffers_match_service() IS
  'P9-S1, R-P9-07. Deferred constraint trigger on appointment INSERT: the buffers copied onto the booking must equal the ones its service declares (booking.buffers_not_the_service_s), and a service it cannot read is a refusal (booking.service_unreadable), never a pass. SECURITY DEFINER, owned by daftar_booking_internal, so row security cannot make it blind to its own subject.';
REVOKE ALL ON FUNCTION bookings_buffers_match_service() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER bookings_buffers_are_the_service_s
  AFTER INSERT ON bookings DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.kind = 'appointment')
  EXECUTE FUNCTION bookings_buffers_match_service();

-- ─────────────────────────────────────────────────────────────────────────
-- 7. `booking_operations` — durable command identity.
--
-- An Idempotency-Key is not by itself permission to answer "success"
-- (0049:§18). The registry records WHICH command a key performed and what it
-- produced, so a replay is answered from the record rather than from what
-- happens to be true now. Append-only in the grant as well as the trigger.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE booking_operations (
  tenant_id          UUID NOT NULL,
  business_id        UUID NOT NULL,
  operation_id       UUID NOT NULL,
  op_code            TEXT NOT NULL CHECK (op_code ~ '^booking\.[a-z_]+$'),
  intent_sha256      TEXT NOT NULL CHECK (intent_sha256 ~ '^[0-9a-f]{64}$'),
  booking_id         UUID NOT NULL,
  actor_user_id      UUID NOT NULL REFERENCES users (id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, operation_id),

  CONSTRAINT booking_operations_tenant_business_fk
    FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT booking_operations_booking_fk
    FOREIGN KEY (business_id, booking_id) REFERENCES bookings (business_id, id) DEFERRABLE INITIALLY DEFERRED
);
REVOKE ALL ON booking_operations FROM PUBLIC;

COMMENT ON TABLE booking_operations IS
  'P9-S1. Durable command identity for the booking commands: which operation id performed which op code over which intent, and the booking it produced. Append-only; a replay is answered from this record, never from current state (0049 §18).';

CREATE OR REPLACE FUNCTION booking_operations_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'booking.operation_registry_immutable: the booking operation registry is append-only' USING ERRCODE = 'P0001';
END $$;
COMMENT ON FUNCTION booking_operations_immutable() IS
  'P9-S1. Raise-only BEFORE UPDATE OR DELETE guard on `booking_operations`. SECURITY INVOKER: reads nothing.';
REVOKE ALL ON FUNCTION booking_operations_immutable() FROM PUBLIC;

CREATE TRIGGER booking_operations_no_mutation
  BEFORE UPDATE OR DELETE ON booking_operations
  FOR EACH ROW EXECUTE FUNCTION booking_operations_immutable();

-- ─────────────────────────────────────────────────────────────────────────
-- 8. Row security — the established model, in the 0067 per-command shape.
--
-- Permissive `tenant_membership` plus restrictive `business_isolation_*`.
-- Both are needed: with no permissive policy nothing is readable or
-- writable at all, and with no restrictive one a member of the tenant could
-- reach a sibling business's calendar.
--
-- Comparisons are `= nullif(app_*(), '')::uuid`, never `col::text =
-- app_*()`: 0052:214-232 measured why.
--
-- The internal principal is admitted to the restrictive READ policies only.
-- A read admission that also appeared in a WITH CHECK would be an
-- out-of-scope WRITE path, which is the distinction 0059:305-308 records.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE booking_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_services FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_membership ON booking_services
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON booking_services AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user = 'daftar_booking_internal' OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON booking_services AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON booking_services AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON booking_services AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY booking_internal_read ON booking_services
  FOR SELECT TO daftar_booking_internal USING (true);

ALTER TABLE booking_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_resources FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_membership ON booking_resources
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON booking_resources AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user = 'daftar_booking_internal' OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON booking_resources AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON booking_resources AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON booking_resources AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY booking_internal_read ON booking_resources
  FOR SELECT TO daftar_booking_internal USING (true);

ALTER TABLE booking_service_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_service_resources FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_membership ON booking_service_resources
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON booking_service_resources AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user = 'daftar_booking_internal' OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON booking_service_resources AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON booking_service_resources AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON booking_service_resources AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY booking_internal_read ON booking_service_resources
  FOR SELECT TO daftar_booking_internal USING (true);

ALTER TABLE booking_resource_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_resource_schedules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_membership ON booking_resource_schedules
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON booking_resource_schedules AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user = 'daftar_booking_internal' OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON booking_resource_schedules AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON booking_resource_schedules AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON booking_resource_schedules AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY booking_internal_read ON booking_resource_schedules
  FOR SELECT TO daftar_booking_internal USING (true);

ALTER TABLE booking_resource_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_resource_exceptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_membership ON booking_resource_exceptions
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON booking_resource_exceptions AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user = 'daftar_booking_internal' OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON booking_resource_exceptions AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON booking_resource_exceptions AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON booking_resource_exceptions AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY booking_internal_read ON booking_resource_exceptions
  FOR SELECT TO daftar_booking_internal USING (true);

ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_membership ON bookings
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON bookings AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user = 'daftar_booking_internal' OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON bookings AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_update ON bookings AS RESTRICTIVE FOR UPDATE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_delete ON bookings AS RESTRICTIVE FOR DELETE
  USING      (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY booking_internal_read ON bookings
  FOR SELECT TO daftar_booking_internal USING (true);

ALTER TABLE booking_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_membership ON booking_operations
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);
CREATE POLICY business_isolation_read ON booking_operations AS RESTRICTIVE FOR SELECT
  USING      (app_bypass() OR current_user = 'daftar_booking_internal' OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY business_isolation_insert ON booking_operations AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass() OR business_id = nullif(app_business(), '')::uuid);
CREATE POLICY booking_internal_read ON booking_operations
  FOR SELECT TO daftar_booking_internal USING (true);

-- ─────────────────────────────────────────────────────────────────────────
-- 9. Grants — default deny, and no runtime writer.
--
-- End state:
--   daftar_app               SELECT on the six merchant-visible relations,
--                            and NOTHING on booking_operations. The reads
--                            run as the CALLER, so row security decides what
--                            a session may see. No INSERT, UPDATE or DELETE
--                            anywhere: writes arrive only through the
--                            command routines the next slice adds, which
--                            need no grant change because of this shape.
--   every other runtime role nothing at all, on any of the seven.
--   daftar_booking_internal  the DML its definer bodies need. Never DELETE,
--                            on anything; never UPDATE on the registry.
--
-- `REVOKE ALL … FROM PUBLIC` was already issued next to each CREATE TABLE.
-- ─────────────────────────────────────────────────────────────────────────
GRANT SELECT ON booking_services, booking_resources, booking_service_resources,
                booking_resource_schedules, booking_resource_exceptions, bookings TO daftar_app;

GRANT SELECT, INSERT, UPDATE ON booking_services TO daftar_booking_internal;
GRANT SELECT, INSERT, UPDATE ON booking_resources TO daftar_booking_internal;
GRANT SELECT, INSERT ON booking_service_resources TO daftar_booking_internal;
GRANT SELECT, INSERT, UPDATE ON booking_resource_schedules TO daftar_booking_internal;
GRANT SELECT, INSERT, UPDATE ON booking_resource_exceptions TO daftar_booking_internal;
GRANT SELECT, INSERT, UPDATE ON bookings TO daftar_booking_internal;
GRANT SELECT, INSERT ON booking_operations TO daftar_booking_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 10. Ownership, and handing the authority back.
--
-- Only the one SECURITY DEFINER routine moves. The three raise-only
-- triggers stay with the migrator: they read nothing, they are not DEFINER,
-- and elevating them would widen the internal principal's surface for no
-- property gained — the call 0046, 0048 and 0049 all make.
--
-- The triggers above were created while the migrator still owned their
-- functions, which a non-superuser deployment principal requires
-- (0069:218-222).
-- ─────────────────────────────────────────────────────────────────────────
ALTER FUNCTION bookings_buffers_match_service() OWNER TO daftar_booking_internal;
-- The lock key is called BY NAME from the command routines the next slice
-- adds, which run as this principal, so it is OWNED by it rather than granted
-- to it — 0045's, 0048's and 0049's pattern, for the same reason: an EXECUTE
-- grant would be an ACL entry on an internal routine, and the rule is stated
-- as an empty ACL.
ALTER FUNCTION booking_resource_lock_key(UUID, UUID) OWNER TO daftar_booking_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_booking_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 11. Refuse to commit unless the end state is exactly right (P9-E).
--
-- Everything here is also proven from the live catalogue by the
-- tests/phase9-prep suites. Asserting it in the DDL too means a deployment
-- that somehow diverges fails at deploy time rather than at the first
-- double booking. Read from pg_catalog, never information_schema.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_role  TEXT;
  v_priv  TEXT;
  v_tbl   TEXT;
  v_n     INTEGER;
BEGIN
  -- (a) The invariant exists, is an exclusion constraint, is partial, and
  --     looks at the blocking window. A test proves it bites; this proves it
  --     is the thing that was meant to be there at all.
  SELECT count(*) INTO v_n
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'bookings' AND c.conname = 'bookings_no_overlap' AND c.contype = 'x';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'booking.migration_end_state_invalid: bookings_no_overlap is not an exclusion constraint on bookings' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_n
    FROM pg_constraint c JOIN pg_class i ON i.oid = c.conindid JOIN pg_index x ON x.indexrelid = i.oid
   WHERE c.conname = 'bookings_no_overlap' AND x.indpred IS NOT NULL;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'booking.migration_end_state_invalid: bookings_no_overlap is not PARTIAL — a cancelled booking would hold its slot for ever' USING ERRCODE = 'P0001';
  END IF;

  IF pg_get_constraintdef((SELECT c.oid FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
                            WHERE t.relname = 'bookings' AND c.conname = 'bookings_no_overlap')) NOT LIKE '%blocking_window WITH &&%' THEN
    RAISE EXCEPTION 'booking.migration_end_state_invalid: bookings_no_overlap does not exclude on blocking_window, so the buffers are outside the invariant (R-P9-02)' USING ERRCODE = 'P0001';
  END IF;

  -- (b) The blocking window is pinned to its inputs. Without this CHECK the
  --     exclusion constraint guards a value the client chooses.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'bookings' AND c.conname = 'bookings_blocking_window_ck' AND c.contype = 'c') THEN
    RAISE EXCEPTION 'booking.migration_end_state_invalid: bookings_blocking_window_ck is missing — a caller could narrow its own blocking window (R-P9-03)' USING ERRCODE = 'P0001';
  END IF;

  -- (c) Row security is on AND forced on every one of the seven.
  FOR v_tbl IN SELECT unnest(ARRAY['booking_services', 'booking_resources', 'booking_service_resources',
                                   'booking_resource_schedules', 'booking_resource_exceptions', 'bookings', 'booking_operations'])
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = v_tbl AND relrowsecurity AND relforcerowsecurity) THEN
      RAISE EXCEPTION 'booking.migration_end_state_invalid: % does not have row security enabled AND forced', v_tbl USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- (d) No runtime login role may WRITE any of the seven, and PUBLIC may not
  --     touch them at all. The migrator is excluded: it owns them, and
  --     PostgreSQL gives an owner rights that cannot be revoked — which is
  --     exactly why the triggers in §6 refuse it too.
  FOR v_role IN SELECT unnest(ARRAY['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_identity',
                                    'daftar_resolver', 'daftar_provisioner', 'daftar_reconciler', 'public'])
  LOOP
    FOR v_tbl IN SELECT unnest(ARRAY['booking_services', 'booking_resources', 'booking_service_resources',
                                     'booking_resource_schedules', 'booking_resource_exceptions', 'bookings', 'booking_operations'])
    LOOP
      FOR v_priv IN SELECT unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'])
      LOOP
        IF has_table_privilege(v_role, v_tbl, v_priv) THEN
          RAISE EXCEPTION 'booking.registry_exposed: % holds % on %', v_role, v_priv, v_tbl USING ERRCODE = 'P0001';
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  -- (e) Not even the internal principal may DELETE anything, or UPDATE the
  --     registry. Append-only is a property of the GRANT as well as of the
  --     trigger.
  FOR v_tbl IN SELECT unnest(ARRAY['booking_services', 'booking_resources', 'booking_service_resources',
                                   'booking_resource_schedules', 'booking_resource_exceptions', 'bookings', 'booking_operations'])
  LOOP
    IF has_table_privilege('daftar_booking_internal', v_tbl, 'DELETE') THEN
      RAISE EXCEPTION 'booking.registry_invalid: the internal principal holds DELETE on %', v_tbl USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  IF has_table_privilege('daftar_booking_internal', 'booking_operations', 'UPDATE') THEN
    RAISE EXCEPTION 'booking.registry_invalid: the internal principal may UPDATE the operation registry' USING ERRCODE = 'P0001';
  END IF;

  -- (f) The merchant runtime can read the calendar it must show, and no
  --     other runtime role can read anything. The registry is nobody's
  --     merchant surface.
  IF NOT has_table_privilege('daftar_app', 'bookings', 'SELECT') THEN
    RAISE EXCEPTION 'booking.registry_invalid: the merchant runtime cannot read the bookings it is meant to show' USING ERRCODE = 'P0001';
  END IF;
  FOR v_role IN SELECT unnest(ARRAY['daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver', 'daftar_provisioner', 'daftar_reconciler', 'public'])
  LOOP
    IF has_table_privilege(v_role, 'bookings', 'SELECT') THEN
      RAISE EXCEPTION 'booking.registry_exposed: % may read bookings and has no requirement to', v_role USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  FOR v_role IN SELECT unnest(ARRAY['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver', 'daftar_provisioner', 'daftar_reconciler', 'public'])
  LOOP
    IF has_table_privilege(v_role, 'booking_operations', 'SELECT') THEN
      RAISE EXCEPTION 'booking.registry_exposed: % may read booking_operations — internal command identities are not a merchant surface', v_role USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- (g) The one definer routine is a definer, has its path pinned in the
  --     project's exact spelling, is owned by the internal principal, and is
  --     callable by nobody. The three raise-only guards are NOT definers.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.proname = 'bookings_buffers_match_service' AND p.prosecdef
       AND r.rolname = 'daftar_booking_internal'
       AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']) THEN
    RAISE EXCEPTION 'booking.migration_end_state_invalid: bookings_buffers_match_service is not a definer owned by daftar_booking_internal with a pinned search_path' USING ERRCODE = 'P0001';
  END IF;
  FOR v_role IN SELECT unnest(ARRAY['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver', 'daftar_provisioner', 'daftar_reconciler', 'public'])
  LOOP
    IF has_function_privilege(v_role, 'bookings_buffers_match_service()', 'EXECUTE') THEN
      RAISE EXCEPTION 'booking.registry_exposed: % may execute the buffer guard directly', v_role USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  FOR v_tbl IN SELECT unnest(ARRAY['bookings_no_delete', 'bookings_transition', 'booking_operations_immutable'])
  LOOP
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = v_tbl AND prosecdef) THEN
      RAISE EXCEPTION 'booking.migration_end_state_invalid: % is SECURITY DEFINER and has no reason to be', v_tbl USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- (g2) The serialization key exists, is IMMUTABLE and STRICT, is owned by
  --      the internal principal, has its path pinned, and is callable by no
  --      runtime role. A command that cannot call it cannot take the lock,
  --      and a key that is not IMMUTABLE could hash the same pair two ways.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.proname = 'booking_resource_lock_key'
       AND p.provolatile = 'i' AND p.proisstrict
       AND r.rolname = 'daftar_booking_internal'
       AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']) THEN
    RAISE EXCEPTION 'booking.migration_end_state_invalid: booking_resource_lock_key is not an IMMUTABLE STRICT routine owned by daftar_booking_internal with a pinned search_path (R-P9-11)' USING ERRCODE = 'P0001';
  END IF;
  FOR v_role IN SELECT unnest(ARRAY['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver', 'daftar_provisioner', 'daftar_reconciler', 'public'])
  LOOP
    IF has_function_privilege(v_role, 'booking_resource_lock_key(uuid,uuid)', 'EXECUTE') THEN
      RAISE EXCEPTION 'booking.registry_exposed: % may compute booking advisory-lock keys', v_role USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- (h) The deferred buffer guard is actually deferred, and actually a
  --     constraint trigger.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'bookings_buffers_are_the_service_s' AND tgdeferrable AND tginitdeferred) THEN
    RAISE EXCEPTION 'booking.migration_end_state_invalid: bookings_buffers_are_the_service_s is not a DEFERRABLE INITIALLY DEFERRED constraint trigger' USING ERRCODE = 'P0001';
  END IF;

  -- (i) The ownership-transfer authority of §0 did not survive.
  IF has_schema_privilege('daftar_booking_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'booking.authority_leak: daftar_booking_internal still holds CREATE on schema public' USING ERRCODE = 'P0001';
  END IF;

  -- (j) No money reached this schema. Part 11 is not a style preference: a
  --     price column here would be a second financial truth, and the one
  --     place to notice it is before it ships.
  SELECT count(*) INTO v_n
    FROM pg_attribute a JOIN pg_class t ON t.oid = a.attrelid
   WHERE t.relname IN ('booking_services', 'booking_resources', 'booking_service_resources',
                       'booking_resource_schedules', 'booking_resource_exceptions', 'bookings', 'booking_operations')
     AND a.attnum > 0 AND NOT a.attisdropped
     AND (a.attname ~ '(amount|price|total|balance|cost|fee|minor|tax)');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'booking.migration_end_state_invalid: % money-shaped column(s) reached the booking schema; a booking that bills posts through the canonical sales authority', v_n USING ERRCODE = 'P0001';
  END IF;
END $$;
