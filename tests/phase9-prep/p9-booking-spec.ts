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
  'bookings_born_booked',
  'bookings_buffers_match_service',
  'bookings_chain_symmetric',
  'bookings_chain_agrees',
  'booking_operations_immutable',
  'booking_resource_lock_key',
  'booking_lock_resources',
  'booking_resolve_local',
  'booking_replay_result',
] as const;

/**
 * The occupancy classification, READ FROM THE SPEC rather than restated here.
 *
 * The spec carries one `P9-STATE-CONTRACT:` line and one exclusion predicate,
 * and `loadSpec` refuses unless they agree with each other and between them
 * classify every value `state`'s CHECK allows. So these two arrays are the
 * document's own answer, and a sixth state cannot slip in unclassified: it
 * reds the loader before any suite runs.
 *
 * They are populated on first `loadSpec()` and read through the two accessors,
 * which throw rather than return an empty list — an empty set would make every
 * loop over it pass vacuously, which is the failure PART 17 names.
 */
let stateContract: { occupying: readonly string[]; releasing: readonly string[] } | null = null;

export function parseStateContractForTest(text: string): { occupying: readonly string[]; releasing: readonly string[] } {
  return parseStateContract(text);
}

function parseStateContract(text: string): { occupying: readonly string[]; releasing: readonly string[] } {
  const declared = /P9-STATE-CONTRACT:\s*occupying\s*=\s*([a-z_,\s]+);\s*releasing\s*=\s*([a-z_,\s]+)/.exec(text);
  if (declared === null) throw new Error('the P9 spec carries no P9-STATE-CONTRACT line, so the occupancy states would have to be guessed');
  const split = (s: string): string[] =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
  const occupying = split(declared[1] ?? '');
  const releasing = split(declared[2] ?? '');
  if (occupying.length === 0 || releasing.length === 0) {
    throw new Error('the P9 state contract declares an empty side, which would make every proof over it vacuous');
  }
  for (const s of occupying) {
    if (releasing.includes(s)) throw new Error(`the P9 state contract classifies ${s} as both occupying and releasing`);
  }

  // The predicate on the exclusion constraint must name exactly the occupying
  // side. This is the half that matters: the declaration is prose until the
  // index agrees with it.
  const predicate = /WHERE \(state IN \(([^)]+)\)\)/.exec(text);
  if (predicate === null) throw new Error('the P9 spec no longer states the exclusion predicate, so the contract cannot be checked against it');
  const inPredicate = [...(predicate[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? '');
  if ([...inPredicate].sort().join(',') !== [...occupying].sort().join(',')) {
    throw new Error(`the P9 exclusion predicate holds ${inPredicate.join(', ')} but the state contract declares ${occupying.join(', ')}`);
  }

  // And every state the relation ALLOWS must be classified by one side or the
  // other, or a sixth state could exist that nothing has decided about.
  const allowed = /CHECK \(state IN \(([^)]+)\)\)/.exec(text);
  if (allowed === null) throw new Error('the P9 spec no longer states the CHECK on bookings.state');
  const all = [...(allowed[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? '');
  const classified = [...occupying, ...releasing];
  for (const s of all) {
    if (!classified.includes(s)) throw new Error(`bookings.state allows ${s}, which the P9 state contract does not classify as occupying or releasing`);
  }
  for (const s of classified) {
    if (!all.includes(s)) throw new Error(`the P9 state contract classifies ${s}, which bookings.state does not allow`);
  }
  return { occupying, releasing };
}

/** The states that occupy a resource, as the spec declares them. */
export function occupyingStates(): readonly string[] {
  if (stateContract === null) loadSpec();
  const c = stateContract;
  if (c === null || c.occupying.length === 0) throw new Error('the P9 occupancy states are unavailable');
  return c.occupying;
}

/** The states that release a resource, as the spec declares them. */
export function releasingStates(): readonly string[] {
  if (stateContract === null) loadSpec();
  const c = stateContract;
  if (c === null || c.releasing.length === 0) throw new Error('the P9 releasing states are unavailable');
  return c.releasing;
}

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
  stateContract = parseStateContract(text);
  for (const state of stateContract.occupying) {
    if (!new RegExp(`WHERE \\(state IN \\([^)]*'${state}'`).test(text)) {
      throw new Error(`P9 spec's exclusion predicate no longer holds '${state}', so that state would stop occupying its resource`);
    }
  }
  for (const state of stateContract.releasing) {
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
