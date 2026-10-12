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
 * `bookings_settled_shape_ck` and `bookings_reschedule_shape_ck` would refuse
 * some of these UPDATEs for a different reason (the shape would stop agreeing
 * with `state`), which is exactly why a test must name the refusal it expects:
 * a case asserting only "it failed" would have passed on the wrong constraint
 * and the hole would still be open. Each case below asserts the refusal BY
 * NAME, and the last two prove that what the law permits still works, so the
 * guard is not merely refusing everything.
 */
import { describe, expect, it } from 'vitest';
import { Client } from 'pg';
import type { ScratchDb } from '../helpers/scratch-db';
import {
  CUSTOMER,
  INSERT_BOOKING,
  INSERT_BOOKING_WITH_BACKLINK,
  INTENT,
  type BookingWorld,
  bookingParams,
  reschedule,
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
      // The real chain: successor with its backlink, predecessor closed on it,
      // both in ONE transaction, which is what R-P9-17 requires of a lawful
      // reschedule and what `reschedule` is for.
      await reschedule(db, world, { from: uuid(1), to: uuid(2), startsAt: AT('11'), endsAt: AT('12') });
      await book(db, world, 3, '13', '14');

      // AT 51626e1 THIS SUCCEEDED. The challenger's measured output was
      //   [C2] refusal=(none)  successor now = …900000000003  (was …900000000002)
      // The forward link then named uuid(3), while uuid(2) still carried
      // `rescheduled_from_id = uuid(1)`: two rows disagreeing about which
      // booking replaced which, with the backlink frozen and the forward link
      // free. The shape CHECK cannot see this — both states are 'rescheduled'
      // with a non-NULL link, so the shape still agrees with itself.
      const said = await refused(db, `UPDATE bookings SET rescheduled_to_id = $2 WHERE business_id = $1 AND id = $3`, [world.businessId, uuid(3), uuid(1)]);
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
      for (const set of [`settle_reason = NULL`, `settled_at = NULL, state = 'booked'`, `settled_by_user_id = NULL, state = 'booked'`]) {
        const said = await refused(db, `UPDATE bookings SET ${set} WHERE business_id = $1 AND id = $2`, [world.businessId, uuid(1)]);
        // `booking.immutable_settlement` and nothing else. The first version of
        // this line accepted `state_not_reopenable` as an alternative, which
        // CANNOT be produced by this schema: (a2) is above the state machine,
        // so it refuses first, and the reopen refusal is itself unreachable
        // (limitation 18). An alternation whose second arm cannot fire is a
        // loosened assertion with no case behind it (C4-P9-04).
        expect(said).toMatch(/booking\.immutable_settlement/);
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

      // This is the gap the shape CHECKs leave. `bookings_settled_shape_ck`
      // ties settled_at and settled_by_user_id to `state <> 'booked'`, and
      // `bookings_reschedule_shape_ck` ties rescheduled_to_id to
      // 'rescheduled' — but NOTHING ties `settle_reason` to a closed booking,
      // so a standing booking could carry the reason it was cancelled for
      // while still holding its hour. (a3) refuses it by name.
      const said = await refused(db, `UPDATE bookings SET settle_reason = 'cancelled, allegedly' WHERE business_id = $1 AND id = $2`, [
        world.businessId,
        uuid(1),
      ]);
      expect(said).toMatch(/booking\.settlement_without_close/);

      const row = await db.pool.query<{ state: string; reason: string | null }>(
        `SELECT state, settle_reason AS reason FROM bookings WHERE business_id = $1 AND id = $2`,
        [world.businessId, uuid(1)],
      );
      expect(row.rows[0]?.state).toBe('booked');
      expect(row.rows[0]?.reason).toBeNull();

      // The other two fields (a3) covers, each written ALONE onto a row that
      // is still 'booked'.
      //
      // CORRECTION, measured. This comment used to say that
      // `bookings_settled_shape_ck` "would also refuse both", and that the
      // cases therefore had to assert the name to avoid passing on the CHECK.
      // That was FALSE, and an independent challenger measured it (C4-P9-02):
      // the CHECK compares `state <> 'booked'` against the CONJUNCTION of
      // settled_at and settled_by_user_id, so on a standing booking with only
      // ONE of them set both sides are false and the CHECK passes. With (a3)
      // removed, a lone settled_at and a lone settled_by_user_id each succeed
      // with no refusal at all; only setting BOTH reaches 23514.
      //
      // So the hazard is the opposite of the one I described: (a3) is the ONLY
      // thing refusing these two writes, and the CHECK that looked like a
      // backstop is not one. Asserting the name is still right — it is what
      // names which guard answered — but the reason is that there is no second
      // guard, not that there is one firing first.
      for (const set of [`settled_at = now()`, `settled_by_user_id = $3`]) {
        const alone = await refused(
          db,
          `UPDATE bookings SET ${set} WHERE business_id = $1 AND id = $2`,
          set.includes('$3') ? [world.businessId, uuid(1), world.userId] : [world.businessId, uuid(1)],
        );
        expect(alone).toMatch(/booking\.settlement_without_close/);
      }

      const still = await db.pool.query<{ state: string; at: string | null; by: string | null }>(
        `SELECT state, settled_at::text AS at, settled_by_user_id::text AS by
           FROM bookings WHERE business_id = $1 AND id = $2`,
        [world.businessId, uuid(1)],
      );
      expect(still.rows[0]).toEqual({ state: 'booked', at: null, by: null });
    });
  });

  it('(a4) is a real guard and not a shadow of the shape CHECKs: with each CHECK DROPPED, the late write is still refused', async () => {
    await withBookingDb('daftar_p9_integrity_7', async (db, world) => {
      // THE CHALLENGER'S OWN THREE PROBES, promoted into the suite at the
      // coordinator's request so the clauses are covered by committed tests.
      //
      // Why they exist at all: every other case here reaches (a4) through a
      // field the shape CHECKs do not constrain (`settle_reason` on
      // 'completed' and 'no_show'). For the other three fields a CHECK might
      // be refusing the late write instead, so those cases could not tell
      // whether (a4) does anything — and the author of this file wrote the
      // guard and the CHECKs both, which is precisely the position from which
      // that question cannot be answered. The challenger answered it from
      // outside, by removing the mechanism it was not testing and making the
      // other one speak its own name. (Its fourth pass went further and
      // removed each (a4) clause alone: every probe below then produced NO
      // refusal at all, not a CHECK's.)
      //
      // The CHECK is dropped on a SCRATCH database built from the migration
      // history, captured with `pg_get_constraintdef` first, always restored,
      // and the restoration asserted. No frozen migration is touched and the
      // document is not edited.
      const defOf = async (name: string): Promise<string> => {
        const r = await db.pool.query<{ def: string }>(
          `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
             JOIN pg_class t ON t.oid = c.conrelid
            WHERE t.relname = 'bookings' AND c.conname = $1`,
          [name],
        );
        const def = r.rows[0]?.def;
        if (def === undefined) throw new Error(`${name} is not on bookings — the probe cannot run or be restored without it`);
        return def;
      };

      /** Delete the probe's rows, around the no-delete trigger. */
      const discard = async (ids: readonly string[]): Promise<void> => {
        await db.pool.query(`ALTER TABLE bookings DISABLE TRIGGER bookings_no_deletion`);
        try {
          await db.pool.query(`DELETE FROM bookings WHERE business_id = $1 AND id = ANY($2::uuid[])`, [world.businessId, ids]);
        } finally {
          await db.pool.query(`ALTER TABLE bookings ENABLE TRIGGER bookings_no_deletion`);
        }
      };

      /**
       * Put `name` back, whatever happened to the probe.
       *
       * The discard comes first, because the rows the probe created are the
       * ones the CHECK forbids and `ADD CONSTRAINT` validates the whole table
       * — the first version of this case skipped that and failed its own
       * restore with 23514, leaving the schema weakened, which is a worse
       * outcome than the hole it tests for. Both steps are attempted whichever
       * one fails, and failures are RETURNED rather than thrown: a throw from
       * a cleanup path replaces the assertion error that explains the failure,
       * which is the masking C4-P9-04 was about, one level up.
       */
      const restore = async (name: string, def: string, ids: readonly string[]): Promise<readonly unknown[]> => {
        const failures: unknown[] = [];
        try {
          await discard(ids);
        } catch (e) {
          failures.push(e);
        }
        try {
          await db.pool.query(`ALTER TABLE bookings ADD CONSTRAINT ${name} ${def}`);
        } catch (e) {
          failures.push(e);
        }
        return failures;
      };

      /** Re-raise the probe's own error first: it is the one worth reading. */
      const settle = (probe: unknown, failures: readonly unknown[]): void => {
        if (probe !== null) throw probe;
        if (failures.length > 0) throw failures[0];
      };

      // PROBES 1 and 2 — settled_at and settled_by_user_id, behind
      // `bookings_settled_shape_ck`.
      const settled = await defOf('bookings_settled_shape_ck');
      let probe12: unknown = null;
      try {
        await db.pool.query(`ALTER TABLE bookings DROP CONSTRAINT bookings_settled_shape_ck`);
        await book(db, world, 20, '08', '09');
        // With the CHECK gone a booking can close with an EMPTY settlement
        // record, which is the state the CHECK exists to make unreachable and
        // the state (a4) has to be tested from.
        await db.pool.query(`UPDATE bookings SET state = 'completed' WHERE business_id = $1 AND id = $2`, [world.businessId, uuid(20)]);
        const empty = await db.pool.query<{ state: string; at: string | null; by: string | null }>(
          `SELECT state, settled_at::text AS at, settled_by_user_id::text AS by
             FROM bookings WHERE business_id = $1 AND id = $2`,
          [world.businessId, uuid(20)],
        );
        expect(empty.rows[0]).toEqual({ state: 'completed', at: null, by: null });

        for (const [set, params] of [
          [`settled_at = now()`, [world.businessId, uuid(20)]],
          [`settled_by_user_id = $3`, [world.businessId, uuid(20), world.userId]],
        ] as const) {
          const late = await refused(db, `UPDATE bookings SET ${set} WHERE business_id = $1 AND id = $2`, params);
          expect(late).toMatch(/booking\.settlement_after_close/);
        }
      } catch (e) {
        probe12 = e;
      }
      settle(probe12, await restore('bookings_settled_shape_ck', settled, [uuid(20)]));
      expect(await defOf('bookings_settled_shape_ck')).toBe(settled);

      // PROBE 3 — the forward link, behind `bookings_reschedule_shape_ck`.
      const rescheduleDef = await defOf('bookings_reschedule_shape_ck');
      let probe3: unknown = null;
      try {
        await db.pool.query(`ALTER TABLE bookings DROP CONSTRAINT bookings_reschedule_shape_ck`);
        await book(db, world, 21, '10', '11');
        await db.pool.query(
          `UPDATE bookings SET state = 'rescheduled', settled_at = now(), settled_by_user_id = $2
            WHERE business_id = $1 AND id = $3`,
          [world.businessId, world.userId, uuid(21)],
        );
        const nulled = await db.pool.query<{ state: string; fwd: string | null }>(
          `SELECT state, rescheduled_to_id::text AS fwd FROM bookings WHERE business_id = $1 AND id = $2`,
          [world.businessId, uuid(21)],
        );
        expect(nulled.rows[0]).toEqual({ state: 'rescheduled', fwd: null });

        await book(db, world, 22, '12', '13');
        const late = await refused(db, `UPDATE bookings SET rescheduled_to_id = $3 WHERE business_id = $1 AND id = $2`, [world.businessId, uuid(21), uuid(22)]);
        expect(late).toMatch(/booking\.settlement_after_close/);
      } catch (e) {
        probe3 = e;
      }
      settle(probe3, await restore('bookings_reschedule_shape_ck', rescheduleDef, [uuid(21), uuid(22)]));
      expect(await defOf('bookings_reschedule_shape_ck')).toBe(rescheduleDef);
    });
  });

  it('a reason cannot be ADDED to an already-closed booking: `completed` and `no_show` leave settle_reason NULL at close', async () => {
    await withBookingDb('daftar_p9_integrity_6', async (db, world) => {
      // The hole the challenger's SECOND pass found at `76ab277`, after the
      // first four cases were green. (a2) refused a rewrite and (a3) refused a
      // write to a standing booking; neither saw a field that was still NULL
      // on a booking that was already closed. The two shape CHECKs hide most
      // of it — settled_at and settled_by_user_id must be non-NULL at close,
      // and the forward link is forced by `bookings_reschedule_shape_ck` — but
      // `bookings_cancel_reason_ck` requires `settle_reason` only for
      // 'cancelled'. So these two states, and only these two, could be given
      // their account of what happened afterwards.
      const states = ['completed', 'no_show'] as const;
      for (const [n, state] of states.entries()) {
        await book(db, world, 10 + n, `0${8 + n}`, `0${9 + n}`);
        await db.pool.query(
          `UPDATE bookings SET state = $4, settled_at = now(), settled_by_user_id = $2
            WHERE business_id = $1 AND id = $3`,
          [world.businessId, world.userId, uuid(10 + n), state],
        );
        const closed = await db.pool.query<{ at: string; reason: string | null }>(
          `SELECT settled_at::text AS at, settle_reason AS reason FROM bookings WHERE business_id = $1 AND id = $2`,
          [world.businessId, uuid(10 + n)],
        );
        // The premise of the whole case: the reason IS legitimately NULL here.
        expect(closed.rows[0]?.reason).toBeNull();

        // AT 76ab277 THIS SUCCEEDED, on both states. The challenger's output:
        //   [D1/completed] refusal=(NONE) | reason now = 'customer confirmed
        //                  they never arrived' | settled_at unchanged
        // The late reason inherited the `settled_at` written at closure, so
        // nothing in the row distinguished it from one recorded there — on a
        // no-show, the state most likely to be disputed.
        const said = await refused(
          db,
          `UPDATE bookings SET settle_reason = 'customer confirmed they never arrived'
            WHERE business_id = $1 AND id = $2`,
          [world.businessId, uuid(10 + n)],
        );
        expect(said).toMatch(/booking\.settlement_after_close/);

        const after = await db.pool.query<{ at: string; reason: string | null }>(
          `SELECT settled_at::text AS at, settle_reason AS reason FROM bookings WHERE business_id = $1 AND id = $2`,
          [world.businessId, uuid(10 + n)],
        );
        expect(after.rows[0]?.reason).toBeNull();
        expect(after.rows[0]?.at).toBe(closed.rows[0]?.at);
      }
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

      // A `no_show` closed WITH its reason in the same statement: (a4) refuses
      // a reason ADDED after close, and would be indistinguishable from a
      // refusal of this if this case did not exist.
      await book(db, world, 5, '17', '18');
      await db.pool.query(
        `UPDATE bookings SET state = 'no_show', settled_at = now(), settled_by_user_id = $2,
           settle_reason = 'did not arrive, front desk waited 20 minutes' WHERE business_id = $1 AND id = $3`,
        [world.businessId, world.userId, uuid(5)],
      );

      await book(db, world, 3, '13', '14');
      await reschedule(db, world, { from: uuid(3), to: uuid(4), startsAt: AT('15'), endsAt: AT('16') });

      const states = await db.pool.query<{ state: string }>(`SELECT state FROM bookings WHERE business_id = $1 AND id = ANY($2::uuid[]) ORDER BY id`, [
        world.businessId,
        [uuid(1), uuid(2), uuid(3)],
      ]);
      expect(states.rows.map((r) => r.state)).toEqual(['cancelled', 'completed', 'rescheduled']);
    });
  });
});

describe('P9 — a booking is born standing (R-P9-16, C4-P9-01)', () => {
  // The fourth independent pass measured what the write-once laws leave open
  // at the one verb they never guard. R-P9-08 and R-P9-15 are UPDATE laws:
  // every case above reaches them with an UPDATE, because that is how a
  // booking is closed. INSERT was checked by the shape CHECKs alone — and a
  // CHECK makes a row internally CONSISTENT, which is a different claim from
  // possible. So a row could arrive already closed, and two of the shapes it
  // could arrive in contradict laws this file states elsewhere.
  //
  // Each case below asserts the refusal by name and, before it, that the row
  // it is trying to create is one the shape CHECKs would accept — otherwise
  // the case would pass on a CHECK and prove nothing about the new guard. The
  // last two cases are the non-vacuity: a normal INSERT still works, and a
  // successor is still born carrying its backlink, which is the one piece of
  // closure metadata an INSERT must be allowed to write.

  const INSERT_WITH_STATE = `
    INSERT INTO bookings (tenant_id, business_id, branch_id, id, kind, resource_id, service_id, customer_id,
                          starts_at, ends_at, lead_buffer_minutes, trail_buffer_minutes, blocking_window,
                          state, intent_sha256, created_by_user_id, rescheduled_to_id, settled_at, settled_by_user_id, settle_reason)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11::int, $12::int,
            tstzrange($9::timestamptz - make_interval(mins => $11::int), $10::timestamptz + make_interval(mins => $12::int), '[)'),
            $13, $14, $15, $16, $17::timestamptz, $18, $19)`;

  it('a booking cannot be INSERTed already rescheduled, pointing at a booking that is still standing', async () => {
    await withBookingDb('daftar_p9_born_1', async (db, world) => {
      // The successor exists and is 'booked', carrying no backlink — so the
      // row below would create exactly the asymmetric chain R-P9-08 forbids
      // and that round 1's C-P9-03 was about. The only difference is the verb.
      await book(db, world, 1, '09', '10');

      const said = await refused(db, INSERT_WITH_STATE, [
        world.tenantId,
        world.businessId,
        world.branchId,
        uuid(2),
        'appointment',
        world.resourceAId,
        world.plainServiceId,
        CUSTOMER,
        AT('11'),
        AT('12'),
        0,
        0,
        'rescheduled',
        INTENT,
        world.userId,
        uuid(1),
        '2026-06-10T11:30:00+00',
        world.userId,
        'moved, allegedly',
      ]);
      expect(said).toMatch(/booking\.not_born_closed/);

      // And the chain is still symmetric: nothing was created, so the standing
      // booking is not pointed at by anything.
      const chain = await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM bookings WHERE business_id = $1 AND rescheduled_to_id IS NOT NULL`, [
        world.businessId,
      ]);
      expect(chain.rows[0]?.n).toBe(0);
    });
  });

  it('a booking cannot be INSERTed already completed, with a settlement recorded before the booking existed', async () => {
    await withBookingDb('daftar_p9_born_2', async (db, world) => {
      // `settled_at` 27 years before the booking satisfies every CHECK on the
      // table: nothing orders the settlement against the window. That is the
      // shape the challenger measured, reproduced here.
      const said = await refused(db, INSERT_WITH_STATE, [
        world.tenantId,
        world.businessId,
        world.branchId,
        uuid(3),
        'appointment',
        world.resourceAId,
        world.plainServiceId,
        CUSTOMER,
        AT('13'),
        AT('14'),
        0,
        0,
        'completed',
        INTENT,
        world.userId,
        null,
        '1999-01-01T00:00:00+00',
        world.userId,
        null,
      ]);
      expect(said).toMatch(/booking\.not_born_closed/);

      const none = await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM bookings WHERE business_id = $1`, [world.businessId]);
      expect(none.rows[0]?.n).toBe(0);
    });
  });

  it('a STANDING booking cannot be INSERTed carrying a settlement record either, which no CHECK refuses', async () => {
    await withBookingDb('daftar_p9_born_3', async (db, world) => {
      // The reason the guard checks the settlement fields INDIVIDUALLY.
      // `bookings_settled_shape_ck` compares `state <> 'booked'` against the
      // CONJUNCTION of settled_at and settled_by_user_id, so on a row born
      // 'booked' with only ONE of them set both sides are false and the CHECK
      // passes — the same measurement that corrected the comment in the (a3)
      // case above (C4-P9-02). Nothing but R-P9-16 refuses this.
      //
      // All THREE fields alone, not two: `settled_by_user_id` alone is the
      // exact shape C4-P9-02's measurement was about, and the fifth pass
      // noticed it was the one the case set left out (C5-P9-03).
      for (const [at, by, reason] of [
        ['2026-06-10T09:30:00+00', null, null],
        [null, world.userId, null],
        [null, null, 'born with a reason'],
      ] as const) {
        const said = await refused(db, INSERT_WITH_STATE, [
          world.tenantId,
          world.businessId,
          world.branchId,
          uuid(4),
          'appointment',
          world.resourceAId,
          world.plainServiceId,
          CUSTOMER,
          AT('09'),
          AT('10'),
          0,
          0,
          'booked',
          INTENT,
          world.userId,
          null,
          at,
          by,
          reason,
        ]);
        expect(said).toMatch(/booking\.not_born_closed/);
      }
    });
  });

  it('the STATE clause is load-bearing on its own: a born-terminal row with an EMPTY settlement record (C5-P9-02)', async () => {
    await withBookingDb('daftar_p9_born_5', async (db, world) => {
      // The fifth pass measured that deleting the guard's state clause reds
      // NOTHING in the four cases above: every attack they assert carries a
      // settlement field or a forward link, so the fields clause refuses them
      // anyway. The clause is not dead — it is simply unheld, which is the
      // same thing to a mutation sweep, and the lesson this project has twice
      // paid for (P5's masking pair, P15's pair-drop).
      //
      // The shape it alone refuses is a row born 'completed' carrying no
      // settlement record at all. `bookings_settled_shape_ck` also refuses it
      // — for the unrelated reason that the shape disagrees with the state —
      // so the CHECK is dropped for the duration, exactly as the promoted
      // probes above do it. That is the only way to see one defence past the
      // other; a one-at-a-time sweep cannot.
      const defOf = async (): Promise<string> => {
        const r = await db.pool.query<{ def: string }>(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'bookings_settled_shape_ck'`,
        );
        const def = r.rows[0]?.def;
        if (def === undefined) throw new Error('bookings_settled_shape_ck is not on the table');
        return def;
      };
      const def = await defOf();

      let probe: unknown = null;
      let said = '';
      try {
        await db.pool.query(`ALTER TABLE bookings DROP CONSTRAINT bookings_settled_shape_ck`);
        said = await refused(db, INSERT_WITH_STATE, [
          world.tenantId,
          world.businessId,
          world.branchId,
          uuid(7),
          'appointment',
          world.resourceAId,
          world.plainServiceId,
          CUSTOMER,
          AT('09'),
          AT('10'),
          0,
          0,
          'completed',
          INTENT,
          world.userId,
          null,
          null,
          null,
          null,
        ]);
      } catch (e) {
        probe = e;
      }
      let restoreFailure: unknown = null;
      try {
        await db.pool.query(`ALTER TABLE bookings ADD CONSTRAINT bookings_settled_shape_ck ${def}`);
      } catch (e) {
        restoreFailure = e;
      }
      if (probe !== null) throw probe;
      if (restoreFailure !== null) throw restoreFailure;

      expect(said).toMatch(/booking\.not_born_closed/);
      // Nothing was created, and the CHECK is back exactly as it was.
      const none = await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM bookings WHERE business_id = $1`, [world.businessId]);
      expect(none.rows[0]?.n).toBe(0);
      expect(await defOf()).toBe(def);
    });
  });

  it('and a successor is still born carrying its BACKLINK: the guard does not break how a reschedule is recorded', async () => {
    await withBookingDb('daftar_p9_born_4', async (db, world) => {
      // NON-VACUITY, and the one exception R-P9-16 names: `rescheduled_from_id`
      // is written at INSERT, because the successor's own identity includes
      // which booking it replaces — block (a) refuses adding it later, so if
      // the INSERT guard refused it too, a reschedule could not be recorded at
      // all. This is the full lawful sequence, end to end.
      await book(db, world, 5, '09', '10');
      await reschedule(db, world, { from: uuid(5), to: uuid(6), startsAt: AT('11'), endsAt: AT('12') });

      const chain = await db.pool.query<{ fwd: string; back: string; state: string }>(
        `SELECT a.rescheduled_to_id::text AS fwd, b.rescheduled_from_id::text AS back, a.state
           FROM bookings a JOIN bookings b ON b.business_id = a.business_id AND b.id = a.rescheduled_to_id
          WHERE a.business_id = $1 AND a.id = $2`,
        [world.businessId, uuid(5)],
      );
      expect(chain.rows[0]).toEqual({ fwd: uuid(6), back: uuid(5), state: 'rescheduled' });
    });
  });
});

/**
 * THE RESCHEDULE CHAIN AGREES WITH ITSELF (R-P9-17).
 *
 * The fifth independent pass committed four disagreeing chains at `6e339bf`
 * (C5-P9-01) and the route was the one nothing had looked at. R-P9-15 shut the
 * REWRITE of the forward link and R-P9-16 shut a row BORN with one; the FIRST
 * write of that link is the close, and it was never checked for agreement with
 * the backlink it is supposed to mirror. The challenger's measured output,
 * before this guard:
 *
 *   [H4b] close pointing at a booking with NO backlink: ** NO REFUSAL **
 *   [H4c] close pointing at a successor whose backlink names a THIRD booking: ** NO REFUSAL **
 *   [H4]  committed rows — backlink with no forward link: 2 | forward link not matched by a backlink: 2
 *
 * These cases are those shapes. They assert the refusal BY NAME — the shape
 * CHECKs would refuse some neighbouring shapes for an unrelated reason, and a
 * case asserting only "it failed" would have passed on the wrong mechanism.
 * The last two prove the law is not simply refusing reschedules: the lawful
 * pair commits in either internal order, which is also what makes this check
 * necessarily DEFERRED.
 */
describe('P9 — the reschedule chain agrees with itself (R-P9-17, C5-P9-01)', () => {
  it('a close naming a successor that does not name it back is REFUSED, and nothing commits', async () => {
    await withBookingDb('daftar_p9_chain_1', async (db, world) => {
      await book(db, world, 11, '09', '10');
      await book(db, world, 12, '11', '12');

      // H4b. uuid(12) exists, is standing, and knows nothing about uuid(11):
      // every shape CHECK is satisfied — state 'rescheduled' with a non-NULL
      // forward link, a full settlement record, a real booking at the other
      // end of a real composite FK. Only agreement is missing.
      const said = await refused(
        db,
        `UPDATE bookings SET state = 'rescheduled', rescheduled_to_id = $3, settled_at = now(),
           settled_by_user_id = $2, settle_reason = 'moved' WHERE business_id = $1 AND id = $4`,
        [world.businessId, world.userId, uuid(12), uuid(11)],
      );
      expect(said).toMatch(/booking\.chain_asymmetric/);

      // The customer's hour was not given away: uuid(11) is still standing and
      // uuid(12) is still nobody's successor.
      const rows = await db.pool.query<{ id: string; state: string; fwd: string | null; back: string | null }>(
        `SELECT id::text AS id, state, rescheduled_to_id::text AS fwd, rescheduled_from_id::text AS back
           FROM bookings WHERE business_id = $1 ORDER BY id`,
        [world.businessId],
      );
      expect(rows.rows).toEqual([
        { id: uuid(11), state: 'booked', fwd: null, back: null },
        { id: uuid(12), state: 'booked', fwd: null, back: null },
      ]);
    });
  });

  it('a second booking cannot claim a successor that already names its own predecessor', async () => {
    await withBookingDb('daftar_p9_chain_2', async (db, world) => {
      // A real chain first: uuid(21) was rescheduled to uuid(22), lawfully.
      await book(db, world, 21, '09', '10');
      await reschedule(db, world, { from: uuid(21), to: uuid(22), startsAt: AT('11'), endsAt: AT('12') });
      await book(db, world, 20, '13', '14');

      // H4c, in the form this schema can actually reach: uuid(20) closes
      // itself claiming uuid(22) replaced it, while uuid(22) says it replaced
      // uuid(21). Three rows, two stories. The challenger committed this.
      const said = await refused(
        db,
        `UPDATE bookings SET state = 'rescheduled', rescheduled_to_id = $3, settled_at = now(),
           settled_by_user_id = $2, settle_reason = 'moved' WHERE business_id = $1 AND id = $4`,
        [world.businessId, world.userId, uuid(22), uuid(20)],
      );
      expect(said).toMatch(/booking\.chain_asymmetric/);

      // The true chain is untouched and uuid(20) still holds its hour.
      const chain = await db.pool.query<{ fwd: string | null; back: string | null; state: string }>(
        `SELECT a.rescheduled_to_id::text AS fwd, a.state, b.rescheduled_from_id::text AS back
           FROM bookings a LEFT JOIN bookings b ON b.business_id = a.business_id AND b.id = $3
          WHERE a.business_id = $1 AND a.id = $2`,
        [world.businessId, uuid(20), uuid(22)],
      );
      expect(chain.rows[0]).toEqual({ fwd: null, state: 'booked', back: uuid(21) });
    });
  });

  it('a successor committed ALONE, carrying a backlink nobody claims, is REFUSED', async () => {
    await withBookingDb('daftar_p9_chain_3', async (db, world) => {
      await book(db, world, 31, '09', '10');

      // The other direction, and the one that makes the pair atomic. Before
      // R-P9-17 this committed: a row asserting it replaced a booking that is
      // still standing and will itself be kept — the challenger's [H4a].
      // R-P9-16 deliberately permits `rescheduled_from_id` at INSERT, because
      // a successor's identity includes which booking it replaces; what it
      // cannot do is check the claim, because at the moment of the INSERT the
      // predecessor has not been closed yet. Only a deferred check can.
      const said = await refused(db, INSERT_BOOKING_WITH_BACKLINK, [...bookingParams({ world, id: uuid(32), startsAt: AT('11'), endsAt: AT('12') }), uuid(31)]);
      expect(said).toMatch(/booking\.chain_asymmetric/);

      const n = await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM bookings WHERE business_id = $1`, [world.businessId]);
      expect(n.rows[0]?.n).toBe(1);
    });
  });

  it('NON-VACUITY: the lawful pair commits in EITHER internal order, which is why the check is deferred', async () => {
    await withBookingDb('daftar_p9_chain_4', async (db, world) => {
      // Order one: successor first, then the close. (`reschedule`.)
      await book(db, world, 41, '09', '10');
      await reschedule(db, world, { from: uuid(41), to: uuid(42), startsAt: AT('11'), endsAt: AT('12') });

      // Order two: the CLOSE first, naming a successor that does not exist
      // yet, then the INSERT. This is the order the concurrency and
      // multi-resource proofs use, because the lock discipline makes them
      // release the hour before taking it. It reaches the second statement at
      // all only because both the composite FK and this check are deferred —
      // mid-statement, either one would refuse the lawful act.
      const client = new Client({ connectionString: db.url('postgres') });
      await client.connect();
      try {
        await book(db, world, 43, '13', '14');
        await client.query('BEGIN');
        await client.query(
          `UPDATE bookings SET state = 'rescheduled', rescheduled_to_id = $3, settled_at = now(),
             settled_by_user_id = $2, settle_reason = 'moved' WHERE business_id = $1 AND id = $4`,
          [world.businessId, world.userId, uuid(44), uuid(43)],
        );
        await client.query(INSERT_BOOKING_WITH_BACKLINK, [...bookingParams({ world, id: uuid(44), startsAt: AT('15'), endsAt: AT('16') }), uuid(43)]);
        await client.query('COMMIT');
      } finally {
        await client.end();
      }

      // Both chains closed on themselves, in both directions, and not one row
      // in this database disagrees with its own chain.
      const chains = await db.pool.query<{ a: string; b: string }>(
        `SELECT a.id::text AS a, b.id::text AS b
           FROM bookings a JOIN bookings b ON b.business_id = a.business_id AND b.id = a.rescheduled_to_id
          WHERE a.business_id = $1 AND b.rescheduled_from_id = a.id ORDER BY a.id`,
        [world.businessId],
      );
      expect(chains.rows).toEqual([
        { a: uuid(41), b: uuid(42) },
        { a: uuid(43), b: uuid(44) },
      ]);
      const broken = await db.pool.query<{ fwd: number; back: number }>(
        `SELECT count(*) FILTER (WHERE a.rescheduled_to_id IS NOT NULL
                                   AND NOT EXISTS (SELECT 1 FROM bookings c
                                                    WHERE c.business_id = a.business_id AND c.id = a.rescheduled_to_id
                                                      AND c.rescheduled_from_id = a.id))::int AS fwd,
                count(*) FILTER (WHERE a.rescheduled_from_id IS NOT NULL
                                   AND NOT EXISTS (SELECT 1 FROM bookings c
                                                    WHERE c.business_id = a.business_id AND c.id = a.rescheduled_from_id
                                                      AND c.rescheduled_to_id = a.id))::int AS back
           FROM bookings a WHERE a.business_id = $1`,
        [world.businessId],
      );
      expect(broken.rows[0]).toEqual({ fwd: 0, back: 0 });
    });
  });
});

/**
 * A RESCHEDULE CHAIN ENDS IN A BOOKING THAT IS KEPT (R-P9-18).
 *
 * R-P9-17 made each pair of links agree, and the sixth independent pass then
 * committed rows where every pair agrees and the whole says nothing: a 2-ring
 * and a 3-ring, five rows in all, not one of whose chains reaches a booking
 * anybody keeps (C6-P9-01). Its measured output at `0f4f0e4`:
 *
 *   [J1] a 2-ring (A says B replaced it, B says A replaced it): ** NO REFUSAL **
 *   [J1] a 3-ring:                                              ** NO REFUSAL **
 *   [J1] committed 'rescheduled' bookings whose chain reaches NO standing booking: 5
 *
 * The same pass measured the fix NOT to take, which is why these cases also
 * assert the lawful two-hop chain in both shapes: requiring the successor
 * named at a close to be `'booked'` would kill every ring and also refuse
 * `A -> B` then `B -> C`, whose middle row is legitimately `'rescheduled'`.
 *
 * `CHAIN_ENDS_NOWHERE` below is the challenger's own J1 assertion, kept as the
 * law's independent statement: it is not the trigger's code read back, so it
 * can disagree with the trigger, which is the only way a case about a global
 * property is worth anything.
 */
const CHAIN_ENDS_NOWHERE = `
  WITH RECURSIVE walk(root, id, state, next_id, seen) AS (
    SELECT b.id, b.id, b.state, b.rescheduled_to_id, ARRAY[b.id]
      FROM bookings b WHERE b.business_id = $1 AND b.state = 'rescheduled'
    UNION ALL
    SELECT w.root, b.id, b.state, b.rescheduled_to_id, w.seen || b.id
      FROM walk w JOIN bookings b ON b.business_id = $1 AND b.id = w.next_id
     WHERE w.state = 'rescheduled' AND NOT (b.id = ANY(w.seen))
  )
  SELECT count(*)::int AS n FROM (
    SELECT root FROM walk GROUP BY root HAVING bool_or(state <> 'rescheduled') IS NOT TRUE
  ) ends_nowhere`;

describe('P9 — a reschedule chain ends in a booking that is kept (R-P9-18, C6-P9-01)', () => {
  /** A row born standing and carrying a backlink, which R-P9-16 permits. */
  const bornWithBacklink = async (db: ScratchDb, world: BookingWorld, client: Client, id: string, back: string, from: string, to: string): Promise<void> => {
    await client.query(INSERT_BOOKING_WITH_BACKLINK, [...bookingParams({ world, id, startsAt: AT(from), endsAt: AT(to) }), back]);
  };
  const close = async (client: Client, world: BookingWorld, id: string, onto: string): Promise<void> => {
    await client.query(
      `UPDATE bookings SET state = 'rescheduled', rescheduled_to_id = $3, settled_at = now(),
         settled_by_user_id = $2, settle_reason = 'moved' WHERE business_id = $1 AND id = $4`,
      [world.businessId, world.userId, onto, id],
    );
  };

  /**
   * Build a ring of `ids` in ONE transaction and return the refusal, or `''`.
   *
   * It has to be one transaction and it has to be built this way: R-P9-16
   * refuses a row born `'rescheduled'` or born with a forward link, so each
   * row is born standing with its BACKLINK (which R-P9-16 permits and the
   * deferred composite FK allows to name a row inserted later), and every row
   * is then closed onto the next. At commit each pair agrees — which is the
   * whole point of the case.
   */
  const ring = async (db: ScratchDb, world: BookingWorld, ids: readonly string[], hour: number): Promise<string> => {
    const client = new Client({ connectionString: db.url('postgres') });
    await client.connect();
    try {
      await client.query('BEGIN');
      for (const [i, id] of ids.entries()) {
        const back = ids[(i + ids.length - 1) % ids.length] as string;
        const h = hour + i;
        await bornWithBacklink(db, world, client, id, back, String(h).padStart(2, '0'), String(h + 1).padStart(2, '0'));
      }
      for (const [i, id] of ids.entries()) await close(client, world, id, ids[(i + 1) % ids.length] as string);
      await client.query('COMMIT');
      return '';
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      return refusal(e);
    } finally {
      await client.end().catch(() => undefined);
    }
  };

  const endsNowhere = async (db: ScratchDb, world: BookingWorld): Promise<number> => {
    const r = await db.pool.query<{ n: number }>(CHAIN_ENDS_NOWHERE, [world.businessId]);
    return r.rows[0]?.n ?? -1;
  };

  it('a 2-ring is REFUSED, and nothing commits', async () => {
    await withBookingDb('daftar_p9_ring_2', async (db, world) => {
      const said = await ring(db, world, [uuid(51), uuid(52)], 9);
      expect(said).toMatch(/booking\.chain_is_a_ring/);
      const n = await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM bookings WHERE business_id = $1`, [world.businessId]);
      expect(n.rows[0]?.n).toBe(0);
      expect(await endsNowhere(db, world)).toBe(0);
    });
  });

  it('a 3-ring is REFUSED too: the pairwise checks all hold and the whole still says nothing', async () => {
    await withBookingDb('daftar_p9_ring_3', async (db, world) => {
      const said = await ring(db, world, [uuid(61), uuid(62), uuid(63)], 9);
      expect(said).toMatch(/booking\.chain_is_a_ring/);
      // Not chain_asymmetric: every pair in a ring agrees. If this case ever
      // passed on that refusal it would be proving R-P9-17 again and saying
      // nothing about R-P9-18.
      expect(said).not.toMatch(/booking\.chain_asymmetric/);
      const n = await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM bookings WHERE business_id = $1`, [world.businessId]);
      expect(n.rows[0]?.n).toBe(0);
      expect(await endsNowhere(db, world)).toBe(0);
    });
  });

  it('NON-VACUITY: a two-hop chain commits, in separate transactions AND in one, with a middle row that is rescheduled', async () => {
    await withBookingDb('daftar_p9_ring_4', async (db, world) => {
      // The shape the cheap fix would have broken. A -> B, then B -> C, so at
      // the second commit B is itself 'rescheduled' and is the successor named
      // by A. Sequentially first.
      await book(db, world, 71, '09', '10');
      await reschedule(db, world, { from: uuid(71), to: uuid(72), startsAt: AT('11'), endsAt: AT('12') });
      await reschedule(db, world, { from: uuid(72), to: uuid(73), startsAt: AT('13'), endsAt: AT('14') });

      // And both hops inside ONE transaction, which is the harder case for a
      // deferred walk: at commit the middle row is 'rescheduled' and the walk
      // has to pass through it to reach the end.
      const client = new Client({ connectionString: db.url('postgres') });
      await client.connect();
      try {
        await book(db, world, 81, '15', '16');
        await client.query('BEGIN');
        await bornWithBacklink(db, world, client, uuid(82), uuid(81), '17', '18');
        await bornWithBacklink(db, world, client, uuid(83), uuid(82), '19', '20');
        await close(client, world, uuid(81), uuid(82));
        await close(client, world, uuid(82), uuid(83));
        await client.query('COMMIT');
      } finally {
        await client.end().catch(() => undefined);
      }

      const states = await db.pool.query<{ id: string; state: string }>(`SELECT id::text AS id, state FROM bookings WHERE business_id = $1 ORDER BY id`, [
        world.businessId,
      ]);
      expect(states.rows).toEqual([
        { id: uuid(71), state: 'rescheduled' },
        { id: uuid(72), state: 'rescheduled' },
        { id: uuid(73), state: 'booked' },
        { id: uuid(81), state: 'rescheduled' },
        { id: uuid(82), state: 'rescheduled' },
        { id: uuid(83), state: 'booked' },
      ]);
      // Every chain reaches a booking that is kept — asserted by the
      // challenger's own recursive query, not by the trigger's code read back.
      expect(await endsNowhere(db, world)).toBe(0);
    });
  });

  it('the ring walk is LOAD-BEARING: with block (c) removed, the 2-ring commits and five rows lead nowhere', async () => {
    await withBookingDb('daftar_p9_ring_5', async (db, world) => {
      // The red proof for the new law, planted the way the challenger plants
      // them: the whole `(c)` block is cut out of the shipped function body
      // and the mutation is asserted to have APPLIED before any scenario runs
      // — a mutation that silently fails to apply reports a guard as proved
      // when it was never tested.
      const src = await db.pool.query<{ body: string }>(`SELECT prosrc AS body FROM pg_proc WHERE proname = 'bookings_chain_symmetric'`);
      const body = src.rows[0]?.body;
      if (body === undefined) throw new Error('bookings_chain_symmetric is not on the server');
      const start = body.indexOf('  -- (c) R-P9-18.');
      const end = body.indexOf('  RETURN NULL;');
      if (start < 0 || end < 0 || end < start) throw new Error('could not locate block (c) in the live function body');
      const cut = body.slice(0, start) + body.slice(end);
      if (cut.includes('chain_is_a_ring')) throw new Error('the mutation did not remove block (c)');

      let probe: unknown = null;
      let said = 'the mutation never ran';
      let nowhere = -1;
      let rows = -1;
      try {
        await db.pool.query(
          `CREATE OR REPLACE FUNCTION bookings_chain_symmetric() RETURNS trigger
           LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $mutant$${cut}$mutant$`,
        );
        const live = await db.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'bookings_chain_symmetric' AND prosrc LIKE '%chain_is_a_ring%'`,
        );
        expect(live.rows[0]?.n).toBe(0);

        said = await ring(db, world, [uuid(91), uuid(92)], 9);
        rows = (await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM bookings WHERE business_id = $1`, [world.businessId])).rows[0]?.n ?? -1;
        nowhere = await endsNowhere(db, world);
      } catch (e) {
        probe = e;
      }
      let restoreFailure: unknown = null;
      try {
        await db.pool.query(
          `CREATE OR REPLACE FUNCTION bookings_chain_symmetric() RETURNS trigger
           LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $orig$${body}$orig$`,
        );
      } catch (e) {
        restoreFailure = e;
      }
      if (probe !== null) throw probe;
      if (restoreFailure !== null) throw restoreFailure;

      // With (c) gone the ring COMMITS — no refusal at all, not a refusal from
      // some other constraint — and the pairwise laws are satisfied by it.
      expect(said).toBe('');
      expect(rows).toBe(2);
      expect(nowhere).toBe(2);

      // The function is back, byte for byte, and refuses the same ring again.
      const back = await db.pool.query<{ body: string }>(`SELECT prosrc AS body FROM pg_proc WHERE proname = 'bookings_chain_symmetric'`);
      expect(back.rows[0]?.body).toBe(body);
      expect(await ring(db, world, [uuid(93), uuid(94)], 13)).toMatch(/booking\.chain_is_a_ring/);
    });
  });
  /**
   * Re-point the live function's ceiling and run `fn`, then restore the body
   * byte for byte. The mutation is asserted to have APPLIED before anything
   * runs, because a mutation that silently fails to apply reports a guard as
   * proved when it was never tested (the lesson this project paid for twice).
   */
  const withGuard = async (db: ScratchDb, n: number, fn: () => Promise<void>): Promise<void> => {
    const src = await db.pool.query<{ body: string }>(`SELECT prosrc AS body FROM pg_proc WHERE proname = 'bookings_chain_symmetric'`);
    const body = src.rows[0]?.body;
    if (body === undefined) throw new Error('bookings_chain_symmetric is not on the server');
    // The DECLARE's assignment, not the token: the function's own comments
    // name 4096 in prose too (they say what round 7 measured about it), so a
    // bare token replacement would rewrite a comment and leave the ceiling.
    // The first run of this case caught exactly that, on my own edit.
    if (body.split(':= 4096;').length !== 2) throw new Error(':= 4096; is not the one ceiling assignment in the live body');
    const mutant = body.replace(':= 4096;', `:= ${n};`);
    let probe: unknown = null;
    try {
      await db.pool.query(
        `CREATE OR REPLACE FUNCTION bookings_chain_symmetric() RETURNS trigger
         LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $mutant$${mutant}$mutant$`,
      );
      const live = await db.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'bookings_chain_symmetric' AND prosrc LIKE '%:= ${n};%'`,
      );
      expect(live.rows[0]?.n).toBe(1);
      await fn();
    } catch (e) {
      probe = e;
    }
    let restoreFailure: unknown = null;
    try {
      await db.pool.query(
        `CREATE OR REPLACE FUNCTION bookings_chain_symmetric() RETURNS trigger
         LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $orig$${body}$orig$`,
      );
    } catch (e) {
      restoreFailure = e;
    }
    if (probe !== null) throw probe;
    if (restoreFailure !== null) throw restoreFailure;
    const back = await db.pool.query<{ body: string }>(`SELECT prosrc AS body FROM pg_proc WHERE proname = 'bookings_chain_symmetric'`);
    expect(back.rows[0]?.body).toBe(body);
  };

  /** A write that changes NOTHING, on one row: the walk's own entry point. */
  const touch = async (db: ScratchDb, world: BookingWorld, id: string): Promise<string> =>
    refused(db, `UPDATE bookings SET rescheduled_to_id = rescheduled_to_id WHERE business_id = $1 AND id = $2`, [world.businessId, id]);

  /** A lawful chain of `n` hops built by `n` separate lawful reschedules. */
  const chain = async (db: ScratchDb, world: BookingWorld, ids: readonly number[], hour: number): Promise<void> => {
    const h = (i: number): string => String(hour + i).padStart(2, '0');
    await book(db, world, ids[0] as number, h(0), h(1));
    for (let i = 1; i < ids.length; i += 1) {
      await reschedule(db, world, { from: uuid(ids[i - 1] as number), to: uuid(ids[i] as number), startsAt: AT(h(2 * i)), endsAt: AT(h(2 * i + 1)) });
    }
  };

  it('the walk is INDEPENDENTLY REACHABLE: a write that changes nothing enters it at the chain HEAD (C7-P9-02)', async () => {
    await withBookingDb('daftar_p9_ring_6', async (db, world) => {
      // Round 7 closed limitation 22 against me. I had said the walk's own
      // reads are never the only reads — that every row it sees is also the
      // immediate counterpart block (a) reads — because a chain can only be
      // extended at its tail. The challenger built the isolation I could not:
      // an UPDATE that assigns a column to itself. It changes no field block
      // (a) compares, no state block (b) needs, and it writes ONE row, so on
      // a closed chain head (a) reads exactly one successor and the rest of
      // the chain belongs to the walk alone.
      await chain(db, world, [101, 102, 103, 104], 9);

      // First, the challenger's own measurement: the no-op touch is lawful.
      expect(await touch(db, world, uuid(101))).toBe('');
      expect(await endsNowhere(db, world)).toBe(0);

      // Then the isolation by DISTANCE, which needs no row security and names
      // the walk's own refusal. With the ceiling at 2, the same no-op touch of
      // the HEAD walks past it and is refused; the same touch of the last
      // CLOSED row, whose walk is two rows, still commits. Only the walk can
      // tell these two apart: block (a) reads one successor in both.
      await withGuard(db, 2, async () => {
        expect(await touch(db, world, uuid(101))).toMatch(/booking\.chain_too_long/);
        expect(await touch(db, world, uuid(103))).toBe('');
      });

      // Nothing was changed by any of it, and with the ceiling back the head
      // is touchable again.
      expect(await touch(db, world, uuid(101))).toBe('');
      const states = await db.pool.query<{ id: string; state: string }>(`SELECT id::text AS id, state FROM bookings WHERE business_id = $1 ORDER BY id`, [
        world.businessId,
      ]);
      expect(states.rows).toEqual([
        { id: uuid(101), state: 'rescheduled' },
        { id: uuid(102), state: 'rescheduled' },
        { id: uuid(103), state: 'rescheduled' },
        { id: uuid(104), state: 'booked' },
      ]);
      expect(await endsNowhere(db, world)).toBe(0);
    });
  });

  it('the ceiling is ENFORCED, not advisory: with it lowered, a LAWFUL chain is refused (C7-P9-03)', async () => {
    await withBookingDb('daftar_p9_ring_7', async (db, world) => {
      // My own documents said "nothing here decides how many times a booking
      // may be moved". Round 7 measured that false: the ceiling refuses rather
      // than passes, so at 4096 the schema does refuse the 4096th move. The
      // number is defensible — it sits far above any chain a business produces
      // — but the sentence was not, and a sentence this file can red is better
      // than a sentence this file believes.
      await chain(db, world, [111, 112, 113, 114, 115, 116, 117], 9);
      expect(await endsNowhere(db, world)).toBe(0);

      await withGuard(db, 3, async () => {
        // Six hops, every one of them written by the lawful path above.
        expect(await touch(db, world, uuid(111))).toMatch(/booking\.chain_too_long/);
        // And it is a CEILING and not a blanket refusal: with the same mutant
        // installed, a row whose remaining walk is short is still touchable.
        // (A STANDING booking would prove nothing here — both link fields are
        // NULL, so the trigger's WHEN clause never fires on it at all.)
        expect(await touch(db, world, uuid(116))).toBe('');
      });

      expect(await touch(db, world, uuid(111))).toBe('');
      expect(await endsNowhere(db, world)).toBe(0);
    });
  });

  it('`chain_unterminated` has its own case, with the shape CHECK that masks it DROPPED (C7-P9-03 control)', async () => {
    await withBookingDb('daftar_p9_ring_8', async (db, world) => {
      // I named this refusal in the spec and in the report without a case that
      // reaches it, because `bookings_reschedule_shape_ck` refuses the shape
      // first. A refusal nothing can reach is a refusal nobody has read. The
      // CHECK comes off for the duration, the way the promoted probes do it.
      await chain(db, world, [121, 122], 9);
      const dropped = `UPDATE bookings SET state = 'rescheduled', settled_at = now(), settled_by_user_id = $2, settle_reason = 'moved'
                        WHERE business_id = $1 AND id = $3`;
      const defOf = async (): Promise<string> => {
        const r = await db.pool.query<{ def: string }>(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'bookings_reschedule_shape_ck'`,
        );
        const def = r.rows[0]?.def;
        if (def === undefined) throw new Error('bookings_reschedule_shape_ck is not on the table');
        return def;
      };
      const def = await defOf();

      // With the CHECK in place the refusal is the CHECK's, by name — which is
      // the whole reason the control is needed.
      expect(await refused(db, dropped, [world.businessId, world.userId, uuid(122)])).toMatch(/bookings_reschedule_shape_ck/);

      let probe: unknown = null;
      let said = '';
      try {
        await db.pool.query(`ALTER TABLE bookings DROP CONSTRAINT bookings_reschedule_shape_ck`);
        said = await refused(db, dropped, [world.businessId, world.userId, uuid(122)]);
      } catch (e) {
        probe = e;
      }
      let restoreFailure: unknown = null;
      try {
        await db.pool.query(`ALTER TABLE bookings ADD CONSTRAINT bookings_reschedule_shape_ck ${def}`);
      } catch (e) {
        restoreFailure = e;
      }
      if (probe !== null) throw probe;
      if (restoreFailure !== null) throw restoreFailure;

      expect(said).toMatch(/booking\.chain_unterminated/);
      expect(await defOf()).toBe(def);
      // Nothing moved: the chain still ends where it did.
      expect(await endsNowhere(db, world)).toBe(0);
      const states = await db.pool.query<{ id: string; state: string }>(`SELECT id::text AS id, state FROM bookings WHERE business_id = $1 ORDER BY id`, [
        world.businessId,
      ]);
      expect(states.rows).toEqual([
        { id: uuid(121), state: 'rescheduled' },
        { id: uuid(122), state: 'booked' },
      ]);
    });
  });

  it('the visited set is the MECHANISM and the ceiling is depth: with only the ring raise cut, a ring is still refused', async () => {
    await withBookingDb('daftar_p9_ring_9', async (db, world) => {
      // A finer mutation than the one above, and the challenger's, which cut
      // the whole of block (c). This cuts ONLY the visited-set raise and
      // leaves the ceiling, which is the mutation class that tells the two
      // apart: if the ceiling were dead code the ring would commit.
      const src = await db.pool.query<{ body: string }>(`SELECT prosrc AS body FROM pg_proc WHERE proname = 'bookings_chain_symmetric'`);
      const body = src.rows[0]?.body;
      if (body === undefined) throw new Error('bookings_chain_symmetric is not on the server');
      const start = body.indexOf('IF v_walk = ANY(v_seen) THEN');
      const end = body.indexOf('v_seen := v_seen || v_walk;');
      if (start < 0 || end < 0 || end < start) throw new Error('could not locate the visited-set raise in the live function body');
      const cut = body.slice(0, start) + body.slice(end);
      if (cut.includes('chain_is_a_ring')) throw new Error('the mutation did not remove the ring raise');
      if (!cut.includes('chain_too_long')) throw new Error('the mutation removed the ceiling as well, which is not this case');

      let probe: unknown = null;
      let said = 'the mutation never ran';
      let rows = -1;
      try {
        await db.pool.query(
          `CREATE OR REPLACE FUNCTION bookings_chain_symmetric() RETURNS trigger
           LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $mutant$${cut}$mutant$`,
        );
        const live = await db.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'bookings_chain_symmetric' AND prosrc LIKE '%chain_is_a_ring%'`,
        );
        expect(live.rows[0]?.n).toBe(0);
        said = await ring(db, world, [uuid(131), uuid(132)], 9);
        rows = (await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM bookings WHERE business_id = $1`, [world.businessId])).rows[0]?.n ?? -1;
      } catch (e) {
        probe = e;
      }
      let restoreFailure: unknown = null;
      try {
        await db.pool.query(
          `CREATE OR REPLACE FUNCTION bookings_chain_symmetric() RETURNS trigger
           LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $orig$${body}$orig$`,
        );
      } catch (e) {
        restoreFailure = e;
      }
      if (probe !== null) throw probe;
      if (restoreFailure !== null) throw restoreFailure;

      // The refusal is the CEILING's, by name, and not the ring raise's.
      expect(said).toMatch(/booking\.chain_too_long/);
      expect(said).not.toMatch(/booking\.chain_is_a_ring/);
      expect(rows).toBe(0);

      // Restored byte for byte, and the shipped code names the ring again.
      const back = await db.pool.query<{ body: string }>(`SELECT prosrc AS body FROM pg_proc WHERE proname = 'bookings_chain_symmetric'`);
      expect(back.rows[0]?.body).toBe(body);
      expect(await ring(db, world, [uuid(133), uuid(134)], 13)).toMatch(/booking\.chain_is_a_ring/);
    });
  });
});
