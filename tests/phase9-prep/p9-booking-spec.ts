/**
 * P9 PREP — THE SPEC, AND THE GUARDS THAT STOP IT BEING EMPTY.
 *
 * The suites in this directory do not describe the Phase 9 booking schema in
 * their own words: they READ `docs/phase9/P9-BOOKING-DDL-SPEC.sql` and apply
 * it to a real cluster. That is deliberate, and it is the opposite of the
 * defect P4-S7-1 recorded — a specification nothing had ever executed, whose
 * two constraint triggers sat above their own function so that none of the
 * slice applied at all.
 *
 * Reading the subject from a document introduces its own failure, though: if
 * the document moves, is renamed, or is emptied, a suite that silently
 * applies nothing passes. Everything below exists to make that impossible.
 * `loadSpec` refuses an absent, short or structurally unrecognisable file,
 * and it refuses one that has lost any of the objects the suites assert on —
 * so a spec that drifts away from its tests reds here rather than in a
 * vacuous green somewhere else.
 *
 * It is a guard over TEXT. It proves the document still says what the suites
 * expect; it proves nothing about the database. Only the applications and
 * the races in the .test.ts files do that.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The spec's path, as the deliverable names it. One definition. */
export const SPEC_PATH = join(__dirname, '..', '..', 'docs', 'phase9', 'P9-BOOKING-DDL-SPEC.sql');

/** The seven relations the spec must create. */
export const P9_RELATIONS = [
  'booking_services',
  'booking_resources',
  'booking_service_resources',
  'booking_resource_schedules',
  'booking_resource_exceptions',
  'bookings',
  'booking_operations',
] as const;

/** The constraints and routines the suites name by hand, and therefore pin. */
export const P9_NAMED_OBJECTS = [
  'bookings_no_overlap',
  'bookings_blocking_window_ck',
  'bookings_kind_shape_ck',
  'bookings_order_ck',
  'bookings_eligible_resource_fk',
  'bookings_no_delete',
  'bookings_transition',
  'bookings_buffers_match_service',
  'booking_operations_immutable',
  'booking_resource_lock_key',
] as const;

/** The states the invariant must treat as occupying the resource. */
export const OCCUPYING_STATES = ['booked', 'completed', 'no_show'] as const;
/** The states the invariant must forget, so a cancelled booking frees its slot. */
export const RELEASING_STATES = ['cancelled', 'rescheduled'] as const;

const MIN_BYTES = 20_000;

/**
 * The spec's text, or a refusal naming exactly what is wrong with it.
 *
 * Every check below answers a way this harness could otherwise report a
 * green it did not earn.
 */
export function loadSpec(): string {
  if (!existsSync(SPEC_PATH)) {
    throw new Error(`P9 spec is missing at ${SPEC_PATH} — the suites in tests/phase9-prep apply it and have no subject without it`);
  }
  const text = readFileSync(SPEC_PATH, 'utf8');
  if (text.length < MIN_BYTES) {
    throw new Error(
      `P9 spec at ${SPEC_PATH} is ${text.length} bytes, under the ${MIN_BYTES}-byte floor: an emptied or truncated spec would apply cleanly and prove nothing`,
    );
  }
  for (const relation of P9_RELATIONS) {
    if (!new RegExp(`CREATE TABLE ${relation}\\b`).test(text)) {
      throw new Error(`P9 spec no longer creates ${relation}, which the suites assert on`);
    }
  }
  for (const object of P9_NAMED_OBJECTS) {
    if (!text.includes(object)) {
      throw new Error(`P9 spec no longer mentions ${object}, which the suites name by hand`);
    }
  }
  // The invariant's shape, read from the document rather than assumed: the
  // suites' whole subject is that this constraint excludes on the BLOCKING
  // window and is restricted to the occupying states.
  if (!/EXCLUDE USING gist \(business_id WITH =, resource_id WITH =, blocking_window WITH &&\)/.test(text)) {
    throw new Error('P9 spec no longer excludes on (business_id, resource_id, blocking_window) — the buffers would fall outside the invariant (R-P9-02)');
  }
  for (const state of OCCUPYING_STATES) {
    if (!new RegExp(`WHERE \\(state IN \\([^)]*'${state}'`).test(text)) {
      throw new Error(`P9 spec's exclusion predicate no longer holds '${state}', so that state would stop occupying its resource`);
    }
  }
  for (const state of RELEASING_STATES) {
    if (new RegExp(`WHERE \\(state IN \\([^)]*'${state}'`).test(text)) {
      throw new Error(`P9 spec's exclusion predicate now holds '${state}', so a released slot would never be reusable`);
    }
  }
  return text;
}

/**
 * The deployment-administrator statements this schema needs and
 * `bootstrap.sql` does not yet carry.
 *
 * This is NOT a convenience: it is the exact content of §1 of
 * docs/phase9/P9-MIGRATION-PATCH-REQUEST.md, executed here so the request is
 * a measured claim rather than a proposal nobody tried. The spec's own
 * precondition block refuses without it, and
 * `p9-booking-preconditions.test.ts` proves that refusal.
 */
export const BOOTSTRAP_PATCH = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daftar_booking_internal') THEN
    CREATE ROLE daftar_booking_internal NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE daftar_booking_internal NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO daftar_booking_internal;
GRANT daftar_booking_internal TO daftar_migrator WITH INHERIT FALSE, SET TRUE;
`;

/** The migration this prep builds on: Phase 3's sealed head, on `main`. */
export const BASE_HEAD = '0073_default_warehouse_locale_name.sql';
