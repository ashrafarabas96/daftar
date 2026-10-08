/**
 * P9 PREP — ONE SCRATCH DATABASE CARRYING THE BOOKING SCHEMA, AND A WORLD.
 *
 * `withBookingDb` builds the real thing every time: `bootstrap.sql`, the
 * migrations 0000-0073 through the project's own runner, the
 * deployment-administrator patch of §1 of the migration patch request, and
 * then `docs/phase9/P9-BOOKING-DDL-SPEC.sql` applied AS `daftar_migrator`
 * inside one transaction.
 *
 * Applying as the deployment principal rather than the superuser is not
 * fussiness. P4-S7's H3 finding was that three defects in a DDL spec were
 * invisible to a superuser and only appeared under the principal that
 * actually applies migrations — a missing CREATE bracket, an owner transfer
 * placed before a routine's own REVOKE, and a guard that was not a guard.
 * A spec proven only as `postgres` is proven against a principal no
 * deployment uses.
 */
import { Pool } from 'pg';
import { type ScratchDb, createScratchDb, scratchPool } from '../helpers/scratch-db';
import { BASE_HEAD, BOOTSTRAP_PATCH, loadSpec } from './p9-booking-spec';

export interface BookingWorld {
  readonly tenantId: string;
  readonly businessId: string;
  readonly branchId: string;
  readonly userId: string;
  /** A second business of the SAME tenant, for the isolation proofs. */
  readonly otherBusinessId: string;
  readonly otherBranchId: string;
  /** A service with no buffers, and one with 15 trailing minutes. */
  readonly plainServiceId: string;
  readonly bufferedServiceId: string;
  /** Two eligible resources, and one belonging to the other business. */
  readonly resourceAId: string;
  readonly resourceBId: string;
  readonly otherResourceId: string;
}

/** `true` when the spec applied; the handle is always dropped. */
export async function withBookingDb(
  name: string,
  fn: (db: ScratchDb, world: BookingWorld) => Promise<void>,
  options: { readonly applySpec?: boolean; readonly patchBootstrap?: boolean } = {},
): Promise<void> {
  const db = await createScratchDb(name, { upTo: BASE_HEAD, keys: false, migratorOwned: true });
  try {
    if (options.patchBootstrap !== false) await db.pool.query(BOOTSTRAP_PATCH);
    if (options.applySpec !== false) await applySpecAsMigrator(db);
    const world = options.applySpec === false ? await seedTenancy(db) : await seedBookingWorld(db);
    await fn(db, world);
  } finally {
    await db.drop();
  }
}

/**
 * Apply the spec in ONE transaction as `daftar_migrator`, exactly as the
 * runner applies a migration file. Rethrows whatever PostgreSQL said, so a
 * suite can assert the refusal rather than "it threw".
 */
export async function applySpecAsMigrator(db: ScratchDb): Promise<void> {
  const spec = loadSpec();
  const pool: Pool = scratchPool(db.url('daftar_migrator'), 1);
  try {
    await pool.query('BEGIN');
    try {
      await pool.query(spec);
      await pool.query('COMMIT');
    } catch (e) {
      await pool.query('ROLLBACK').catch(() => undefined);
      throw e;
    }
  } finally {
    await pool.end();
  }
}

/** The tenancy rows every proof needs, with no booking schema assumed. */
async function seedTenancy(db: ScratchDb): Promise<BookingWorld> {
  const r = await db.pool.query<{
    tenant_id: string;
    business_id: string;
    branch_id: string;
    user_id: string;
    other_business_id: string;
    other_branch_id: string;
  }>(`
    WITH t AS (INSERT INTO tenants DEFAULT VALUES RETURNING id),
    u AS (INSERT INTO users (email, password_hash, display_name)
          VALUES ('p9-' || gen_random_uuid() || '@example.test', 'x', 'P9 Owner') RETURNING id),
    b AS (INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
          SELECT t.id, 'P9 Salon', 'p9-' || replace(gen_random_uuid()::text, '-', ''), 'PS', 'ILS', 'Asia/Hebron' FROM t RETURNING id, tenant_id),
    b2 AS (INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
           SELECT t.id, 'P9 Clinic', 'p9x-' || replace(gen_random_uuid()::text, '-', ''), 'PS', 'ILS', 'Asia/Hebron' FROM t RETURNING id),
    br AS (INSERT INTO branches (business_id, name, is_default) SELECT b.id, 'Main', true FROM b RETURNING id, business_id),
    br2 AS (INSERT INTO branches (business_id, name, is_default) SELECT b2.id, 'Main', true FROM b2 RETURNING id)
    SELECT b.tenant_id AS tenant_id, b.id AS business_id, br.id AS branch_id, u.id AS user_id,
           b2.id AS other_business_id, br2.id AS other_branch_id
      FROM b, br, u, b2, br2`);
  const row = r.rows[0];
  if (row === undefined) throw new Error('the P9 world seed returned no row');
  return {
    tenantId: row.tenant_id,
    businessId: row.business_id,
    branchId: row.branch_id,
    userId: row.user_id,
    otherBusinessId: row.other_business_id,
    otherBranchId: row.other_branch_id,
    plainServiceId: '',
    bufferedServiceId: '',
    resourceAId: '',
    resourceBId: '',
    otherResourceId: '',
  };
}

/** The tenancy rows plus two services, three resources and their eligibility. */
export async function seedBookingWorld(db: ScratchDb): Promise<BookingWorld> {
  const base = await seedTenancy(db);
  const ids = await db.pool.query<{ k: string; v: string }>(
    `
    WITH s1 AS (
      INSERT INTO booking_services (tenant_id, business_id, id, code, display_name, default_duration_minutes, lead_buffer_minutes, trail_buffer_minutes, created_by_user_id)
      VALUES ($1, $2, gen_random_uuid(), 'haircut', 'Haircut', 60, 0, 0, $4) RETURNING id),
    s2 AS (
      INSERT INTO booking_services (tenant_id, business_id, id, code, display_name, default_duration_minutes, lead_buffer_minutes, trail_buffer_minutes, created_by_user_id)
      VALUES ($1, $2, gen_random_uuid(), 'colour', 'Colour', 90, 0, 15, $4) RETURNING id),
    ra AS (
      INSERT INTO booking_resources (tenant_id, business_id, branch_id, id, kind, display_name, created_by_user_id)
      VALUES ($1, $2, $3, gen_random_uuid(), 'staff', 'Chair A', $4) RETURNING id),
    rb AS (
      INSERT INTO booking_resources (tenant_id, business_id, branch_id, id, kind, display_name, created_by_user_id)
      VALUES ($1, $2, $3, gen_random_uuid(), 'staff', 'Chair B', $4) RETURNING id),
    ro AS (
      INSERT INTO booking_resources (tenant_id, business_id, branch_id, id, kind, display_name, created_by_user_id)
      VALUES ($1, $5, $6, gen_random_uuid(), 'room', 'Other room', $4) RETURNING id),
    e AS (
      INSERT INTO booking_service_resources (tenant_id, business_id, service_id, resource_id)
      SELECT $1, $2, s.id, r.id FROM (SELECT id FROM s1 UNION ALL SELECT id FROM s2) s
        CROSS JOIN (SELECT id FROM ra UNION ALL SELECT id FROM rb) r
      RETURNING 1)
    SELECT 'plain' AS k, id::text AS v FROM s1
    UNION ALL SELECT 'buffered', id::text FROM s2
    UNION ALL SELECT 'ra', id::text FROM ra
    UNION ALL SELECT 'rb', id::text FROM rb
    UNION ALL SELECT 'ro', id::text FROM ro
    UNION ALL SELECT 'eligibility', count(*)::text FROM e`,
    [base.tenantId, base.businessId, base.branchId, base.userId, base.otherBusinessId, base.otherBranchId],
  );
  const by = new Map(ids.rows.map((row) => [row.k, row.v]));
  const need = (k: string): string => {
    const v = by.get(k);
    if (v === undefined || v === '') throw new Error(`the P9 world seed produced no ${k}`);
    return v;
  };
  if (need('eligibility') !== '4') throw new Error(`the P9 world seed wrote ${need('eligibility')} eligibility rows, expected 4`);
  return {
    ...base,
    plainServiceId: need('plain'),
    bufferedServiceId: need('buffered'),
    resourceAId: need('ra'),
    resourceBId: need('rb'),
    otherResourceId: need('ro'),
  };
}

/** A digest-shaped placeholder: the command layer writes the real intent. */
export const INTENT = 'a'.repeat(64);

/**
 * The INSERT every proof uses, with `blocking_window` derived IN SQL from the
 * row's own times and buffers — the way the command routine will derive it.
 * A test that computed the window in TypeScript would be asserting against
 * its own arithmetic instead of the database's.
 */
export const INSERT_BOOKING = `
  INSERT INTO bookings (tenant_id, business_id, branch_id, id, kind, resource_id, service_id, customer_id,
                        starts_at, ends_at, lead_buffer_minutes, trail_buffer_minutes, blocking_window,
                        state, intent_sha256, created_by_user_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11::int, $12::int,
          tstzrange($9::timestamptz - make_interval(mins => $11::int), $10::timestamptz + make_interval(mins => $12::int), '[)'),
          $13, $14, $15)`;

/**
 * The same INSERT, carrying the reschedule BACKLINK.
 *
 * `rescheduled_from_id` is part of the new row's identity, so it is written at
 * INSERT and never afterwards: `bookings_transition` refuses to add it later
 * with booking.immutable (measured — the reschedule proof tried the other
 * order first and was refused). The FORWARD link on the predecessor is the
 * one that must be deferred, because it names a row that does not exist yet.
 */
export const INSERT_BOOKING_WITH_BACKLINK = `
  INSERT INTO bookings (tenant_id, business_id, branch_id, id, kind, resource_id, service_id, customer_id,
                        starts_at, ends_at, lead_buffer_minutes, trail_buffer_minutes, blocking_window,
                        state, intent_sha256, created_by_user_id, rescheduled_from_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11::int, $12::int,
          tstzrange($9::timestamptz - make_interval(mins => $11::int), $10::timestamptz + make_interval(mins => $12::int), '[)'),
          $13, $14, $15, $16)`;

/**
 * The INSERT a booking COMMAND issues: the resource's advisory lock first,
 * then the row — one statement, so the lock is taken in the same round trip
 * and the race is a race for the LOCK (R-P9-11).
 *
 * Taking the lock in a CTE the INSERT selects from is what makes the order
 * guaranteed rather than hoped for: the lock row must be produced before the
 * insert has anything to insert. Without this, two overlapping inserts wait
 * on each other inside the exclusion index and one dies with 40P01 — measured
 * in `p9-booking-negative-controls.test.ts`, which is the only reason to
 * believe this form earns its complexity.
 */
export const INSERT_BOOKING_LOCKED = `
  WITH lock_taken AS (SELECT pg_advisory_xact_lock(booking_resource_lock_key($2::uuid, $6::uuid)) AS held)
  INSERT INTO bookings (tenant_id, business_id, branch_id, id, kind, resource_id, service_id, customer_id,
                        starts_at, ends_at, lead_buffer_minutes, trail_buffer_minutes, blocking_window,
                        state, intent_sha256, created_by_user_id)
  SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11::int, $12::int,
         tstzrange($9::timestamptz - make_interval(mins => $11::int), $10::timestamptz + make_interval(mins => $12::int), '[)'),
         $13, $14, $15
    FROM lock_taken`;

export interface BookingRow {
  readonly world: BookingWorld;
  readonly id: string;
  readonly resourceId?: string;
  readonly serviceId?: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly lead?: number;
  readonly trail?: number;
  readonly state?: string;
  readonly kind?: 'appointment' | 'resource_block';
}

/** The parameter list for {@link INSERT_BOOKING}. */
export function bookingParams(b: BookingRow): unknown[] {
  const kind = b.kind ?? 'appointment';
  const appointment = kind === 'appointment';
  return [
    b.world.tenantId,
    b.world.businessId,
    b.world.branchId,
    b.id,
    kind,
    b.resourceId ?? b.world.resourceAId,
    appointment ? (b.serviceId ?? b.world.plainServiceId) : null,
    appointment ? CUSTOMER : null,
    b.startsAt,
    b.endsAt,
    b.lead ?? 0,
    b.trail ?? 0,
    b.state ?? 'booked',
    INTENT,
    b.world.userId,
  ];
}

/**
 * A customer id with no row behind it, deliberately.
 *
 * `bookings.customer_id` carries no foreign key in this slice: `customers` is
 * a Phase 4 relation and Phase 4 is not sealed, so binding to it
 * would tie unpromoted Phase 9 work to an unsealed schema. §2 of the
 * migration patch request names the statement that adds the FK at promotion.
 */
export const CUSTOMER = '00000000-0000-4000-8000-000000000001';

/** `uuid(1)` … `uuid(n)`: stable, readable booking ids for the proofs. */
export function uuid(n: number): string {
  return `00000000-0000-4000-8000-9000${n.toString(16).padStart(8, '0')}`;
}

/** The SQLSTATE of a PostgreSQL error, or `''`. */
export function sqlState(e: unknown): string {
  return typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : '';
}
