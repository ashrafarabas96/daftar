/**
 * THE CLOSURE RECORD IS WRITE-ONCE (R-P9-15).
 *
 * Every case in this file exists because an independent challenger found, by
 * execution against `51626e1`, that two laws this spec states in its own prose
 * were not enforced anywhere:
 *
 *   C-P9-02  the settlement record — who closed a booking, when, and why —
 *            could be rewritten and `settled_at` backdated afterwards.
 *   C-P9-03  `rescheduled_to_id` could be repointed at a different booking
 *            after the fact, leaving the forward link contradicting the
 *            backlink `rescheduled_from_id` that R-P9-08 does freeze.
 *
 * Both were reachable because the guard looked at the wrong thing: block (a)
 * of `bookings_transition` froze the columns that define WHICH time is held,
 * and the state machine in block (b) only fires on a CHANGE of `state`. An
 * UPDATE that left `state` alone and rewrote only the settlement matched
 * neither. The challenger's own two probes are reproduced here as the first
 * two cases, unchanged in substance, and each carries the output it produced
 * before the fix — a refusal that did not come.
 *
 * The three shape CHECKs on `bookings` are NOT what these cases prove.
 * `bookings_settle_shape_ck` and `bookings_reschedule_shape_ck` would refuse
 * some of these UPDATEs for a different reason (the shape would stop agreeing
 * with `state`), which is exactly why a test must name the refusal it expects:
 * a case asserting only "it failed" would have passed on the wrong constraint
 * and the hole would still be open. Each case below asserts the refusal BY
 * NAME, and the last two prove that what the law permits still works, so the
 * guard is not merely refusing everything.
 */
import { describe, expect, it } from 'vitest';
import type { ScratchDb } from '../helpers/scratch-db';
import {
  INSERT_BOOKING,
  INSERT_BOOKING_WITH_BACKLINK,
  type BookingWorld,
  bookingParams,
  uuid,
  withBookingDb,
} from './p9-booking-world';

/** A quiet June day, far from any transition: this file is not about clocks. */
const AT = (h: string): string => `2026-06-10T${h}:00:00+00`;

/** The message of a PostgreSQL error, or `''`. An empty string means NO REFUSAL CAME. */
function refusal(e: unknown): string {
  return e instanceof Error ? e.message : '';
}

/** Run `q` and return the refusal it produced, or `''` if it succeeded. */
async function refused(db: ScratchDb, q: string, params: readonly unknown[]): Promise<string> {
  try {
    await db.pool.query(q, params as unknown[]);
    return '';
  } catch (e) {
    return refusal(e);
  }
}

/** Close `id` as cancelled, the lawful way: state and settlement in ONE statement. */
async function cancel(db: ScratchDb, world: BookingWorld, id: string, why: string): Promise<void> {
  await db.pool.query(
    `UPDATE bookings SET state = 'cancelled', settled_at = now(), settled_by_user_id = $2, settle_reason = $4
      WHERE business_id = $1 AND id = $3`,
    [world.businessId, world.userId, id, why],
  );
}

async function book(db: ScratchDb, world: BookingWorld, n: number, from: string, to: string): Promise<void> {
  await db.pool.query(INSERT_BOOKING, bookingParams({ world, id: uuid(n), startsAt: AT(from), endsAt: AT(to) }));
}

describe('P9 — the closure record is written once (R-P9-15, C-P9-02 / C-P9-03)', () => {
  it('a settled booking’s settlement record is FROZEN: the reason cannot be rewritten and settled_at cannot be backdated', async () => {
    await withBookingDb('daftar_p9_integrity_1', async (db, world) => {
      await book(db, world, 1, '09', '10');
      await cancel(db, world, uuid(1), 'customer called');

      const before = await db.pool.query<{ reason: string; at: string }>(
        `SELECT settle_reason AS reason, settled_at::text AS at FROM bookings WHERE business_id = $1 AND id = $2`,
        [world.businessId, uuid(1)],
      );
      expect(before.rows[0]?.reason).toBe('customer called');

      // AT 51626e1 THIS SUCCEEDED. The challenger's measured output was
      //   [C1] refusal=(none)  settle_reason now = no-show dispute
      // — the account of why a customer's hour was given up, rewritten three
      // days into the past by a single UPDATE, with no trace that it changed.
      const said = await refused(
        db,
        `UPDATE bookings SET settle_reason = 'no-show dispute', settled_at = now() - interval '3 days'
          WHERE business_id = $1 AND id = $2`,
        [world.businessId, uuid(1)],
      );
      expect(said).toMatch(/booking\.immutable_settlement/);

      // And the record still says what it said. A refusal that rolled back
      // only part of the statement would be a different defect.
      const after = await db.pool.query<{ reason: string; at: string }>(
        `SELECT settle_reason AS reason, settled_at::text AS at FROM bookings WHERE business_id = $1 AND id = $2`,
        [world.businessId, uuid(1)],
      );
      expect(after.rows[0]?.reason).toBe('customer called');
      expect(after.rows[0]?.at).toBe(before.rows[0]?.at);
    });
  });

  it('a rescheduled booking’s successor cannot be REPOINTED at a different booking', async () => {
    await withBookingDb('daftar_p9_integrity_2', async (db, world) => {
      await book(db, world, 1, '09', '10');
      // The real successor, carrying the backlink that makes the pair a chain.
      await db.pool.query(INSERT_BOOKING_WITH_BACKLINK, [
        ...bookingParams({ world, id: uuid(2), startsAt: AT('11'), endsAt: AT('12') }),
        uuid(1),
      ]);
      await book(db, world, 3, '13', '14');

      await db.pool.query(
        `UPDATE bookings SET state = 'rescheduled', rescheduled_to_id = $3, settled_at = now(),
           settled_by_user_id = $2, settle_reason = 'moved' WHERE business_id = $1 AND id = $4`,
        [world.businessId, world.userId, uuid(2), uuid(1)],
      );

      // AT 51626e1 THIS SUCCEEDED. The challenger's measured output was
      //   [C2] refusal=(none)  successor now = …900000000003  (was …900000000002)
      // The forward link then named uuid(3), while uuid(2) still carried
      // `rescheduled_from_id = uuid(1)`: two rows disagreeing about which
      // booking replaced which, with the backlink frozen and the forward link
      // free. The shape CHECK cannot see this — both states are 'rescheduled'
      // with a non-NULL link, so the shape still agrees with itself.
      const said = await refused(
        db,
        `UPDATE bookings SET rescheduled_to_id = $2 WHERE business_id = $1 AND id = $3`,
        [world.businessId, uuid(3), uuid(1)],
      );
      expect(said).toMatch(/booking\.immutable_settlement/);

      // The chain still closes on itself, in both directions.
      const chain = await db.pool.query<{ fwd: string; back: string }>(
        `SELECT a.rescheduled_to_id::text AS fwd, b.rescheduled_from_id::text AS back
           FROM bookings a JOIN bookings b ON b.business_id = a.business_id AND b.id = a.rescheduled_to_id
          WHERE a.business_id = $1 AND a.id = $2`,
        [world.businessId, uuid(1)],
      );
      expect(chain.rows[0]?.fwd).toBe(uuid(2));
      expect(chain.rows[0]?.back).toBe(uuid(1));
    });
  });

  it('CLEARING a written settlement is a rewrite too, and is refused the same way', async () => {
    await withBookingDb('daftar_p9_integrity_3', async (db, world) => {
      await book(db, world, 1, '09', '10');
      await cancel(db, world, uuid(1), 'customer called');

      // `IS DISTINCT FROM` on both sides of the guard is deliberate: erasing
      // who closed a booking is the same loss as replacing them, and a guard
      // written with `<>` would have let this through on the NULL.
      for (const set of [
        `settle_reason = NULL`,
        `settled_at = NULL, state = 'booked'`,
        `settled_by_user_id = NULL, state = 'booked'`,
      ]) {
        const said = await refused(db, `UPDATE bookings SET ${set} WHERE business_id = $1 AND id = $2`, [
          world.businessId,
          uuid(1),
        ]);
        expect(said).toMatch(/booking\.(immutable_settlement|state_not_reopenable)/);
      }

      const row = await db.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM bookings
          WHERE business_id = $1 AND id = $2 AND state = 'cancelled'
            AND settle_reason = 'customer called' AND settled_at IS NOT NULL AND settled_by_user_id IS NOT NULL`,
        [world.businessId, uuid(1)],
      );
      expect(row.rows[0]?.n).toBe(1);
    });
  });

  it('a STANDING booking cannot be given a settlement record: it is written by the statement that closes it', async () => {
    await withBookingDb('daftar_p9_integrity_4', async (db, world) => {
      await book(db, world, 1, '09', '10');

      // This is the gap the shape CHECKs leave. `bookings_settle_shape_ck`
      // ties settled_at and settled_by_user_id to `state <> 'booked'`, and
      // `bookings_reschedule_shape_ck` ties rescheduled_to_id to
      // 'rescheduled' — but NOTHING ties `settle_reason` to a closed booking,
      // so a standing booking could carry the reason it was cancelled for
      // while still holding its hour. (a3) refuses it by name.
      const said = await refused(
        db,
        `UPDATE bookings SET settle_reason = 'cancelled, allegedly' WHERE business_id = $1 AND id = $2`,
        [world.businessId, uuid(1)],
      );
      expect(said).toMatch(/booking\.settlement_without_close/);

      const row = await db.pool.query<{ state: string; reason: string | null }>(
        `SELECT state, settle_reason AS reason FROM bookings WHERE business_id = $1 AND id = $2`,
        [world.businessId, uuid(1)],
      );
      expect(row.rows[0]?.state).toBe('booked');
      expect(row.rows[0]?.reason).toBeNull();
    });
  });

  it('and the guard is not simply refusing everything: the lawful closures still go through', async () => {
    await withBookingDb('daftar_p9_integrity_5', async (db, world) => {
      // NON-VACUITY. Four red proofs above assert refusals; without this case
      // a guard that refused every UPDATE on `bookings` would satisfy all of
      // them and destroy the phase. Each closure below is written in ONE
      // statement, which is the only way R-P9-15 permits it.
      await book(db, world, 1, '09', '10');
      await cancel(db, world, uuid(1), 'customer called');

      await book(db, world, 2, '11', '12');
      await db.pool.query(
        `UPDATE bookings SET state = 'completed', settled_at = now(), settled_by_user_id = $2
          WHERE business_id = $1 AND id = $3`,
        [world.businessId, world.userId, uuid(2)],
      );

      await book(db, world, 3, '13', '14');
      await db.pool.query(INSERT_BOOKING_WITH_BACKLINK, [
        ...bookingParams({ world, id: uuid(4), startsAt: AT('15'), endsAt: AT('16') }),
        uuid(3),
      ]);
      await db.pool.query(
        `UPDATE bookings SET state = 'rescheduled', rescheduled_to_id = $3, settled_at = now(),
           settled_by_user_id = $2, settle_reason = 'moved' WHERE business_id = $1 AND id = $4`,
        [world.businessId, world.userId, uuid(4), uuid(3)],
      );

      const states = await db.pool.query<{ state: string }>(
        `SELECT state FROM bookings WHERE business_id = $1 AND id = ANY($2::uuid[]) ORDER BY id`,
        [world.businessId, [uuid(1), uuid(2), uuid(3)]],
      );
      expect(states.rows.map((r) => r.state)).toEqual(['cancelled', 'completed', 'rescheduled']);
    });
  });
});
