/**
 * P9 PREP — THE NEGATIVE CONTROLS (master directive Part 40).
 *
 * Eleven green concurrency proofs establish that double booking does not
 * happen. They do NOT establish that the exclusion constraint is why. A suite
 * that would pass just as well with the constraint deleted is measuring the
 * test harness, and this project has paid for that lesson more than once: a
 * law whose proof was a bare `.not.toEqual([])`, a comment citing a check
 * that did not exist, a gate arm whose mutation matched no line and went
 * green anyway.
 *
 * So each control below removes EXACTLY ONE invariant, shows the attack then
 * succeeding, and puts the invariant back. Two things make that honest:
 *
 *   1. Every control compares `pg_get_constraintdef` before and after and
 *      fails unless the restored definition is character-identical. A control
 *      that left the schema subtly different would silently decide the next
 *      control's result.
 *   2. Every control ends by re-running the attack against the restored
 *      schema and requiring it to be refused again. So "I removed the right
 *      thing" and "I put the right thing back" are both measured, not
 *      assumed.
 *
 * Status: PREPARED / NOT PROMOTED. Not part of required CI.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScratchDb } from '../helpers/scratch-db';
import { createScratchDb } from '../helpers/scratch-db';
import { BASE_HEAD, BOOTSTRAP_PATCH } from './p9-booking-spec';
import {
  type BookingWorld,
  INSERT_BOOKING,
  INSERT_BOOKING_LOCKED,
  applySpecAsMigrator,
  bookingParams,
  seedBookingWorld,
  sqlState,
  uuid,
} from './p9-booking-world';
import { awaitBlocked, closeRacers, commitAll, issue, openRacers, summarise, trace } from './p9-race';

const DAY = '2027-05-20';
const at = (hhmm: string): string => `${DAY}T${hhmm}:00Z`;

/** The constraint every control is about. */
const INVARIANT = 'bookings_no_overlap';

describe('P9 bookings — negative controls: the invariant is what is doing the work', () => {
  let db: ScratchDb;
  let world: BookingWorld;
  let observer: Client;
  let original = '';
  let originalCheck = '';
  let slot = 0;

  beforeAll(async () => {
    db = await createScratchDb('daftar_p9_nc', { upTo: BASE_HEAD, keys: false, migratorOwned: true });
    await db.pool.query(BOOTSTRAP_PATCH);
    await applySpecAsMigrator(db);
    world = await seedBookingWorld(db);
    trace('beforeAll: connecting observer');
    observer = new Client({ connectionString: db.url('postgres') });
    await observer.connect();
    trace('beforeAll: observer connected');
    trace('beforeAll: db built, reading constraint defs');
    original = await constraintDef(db, INVARIANT);
    originalCheck = await constraintDef(db, 'bookings_blocking_window_ck');
    // A control over a constraint that is not there proves nothing, so prove
    // the subjects exist before removing them.
    expect(original).toContain('EXCLUDE USING gist');
    expect(originalCheck).toContain('blocking_window =');
  }, 600_000);

  afterAll(async () => {
    await observer?.end().catch(() => undefined);
    await db?.drop();
  });

  /** Each control gets its own hour. */
  const hour = (): string => `${String(8 + slot).padStart(2, '0')}`;

  it('CONTROL 1 — with bookings_no_overlap dropped, the race of PROOF 1 commits BOTH overlapping bookings', async () => {
    slot += 1;
    const h = hour();
    trace('CONTROL 1: dropping the invariant');
    await db.pool.query(`ALTER TABLE bookings DROP CONSTRAINT ${INVARIANT}`);
    trace('CONTROL 1: dropped');
    let doubleBooked = -1;
    try {
      trace('CONTROL 1: opening racers');
      const racers = await openRacers(db.url('postgres'), 2);
      trace(`CONTROL 1: racers open pids=${JSON.stringify(racers.map((r) => r.pid))}`);
      try {
        const attempts = issue(racers, INSERT_BOOKING_LOCKED, (i) =>
          bookingParams({ world, id: uuid(2000 + i), startsAt: at(`${h}:00`), endsAt: at(`${h}:30`) }),
        );
        // The second racer still queues on the resource lock — R-P9-11 is
        // untouched by this control — so the wait is observed and the winner
        // commits before the loser is resolved, exactly as in PROOF 1. The ONE
        // difference from PROOF 1 is the dropped constraint, and that
        // difference is the whole result.
        //
        // The order matters for the harness too: awaiting both inserts before
        // COMMIT would deadlock the TEST, because the loser cannot finish while
        // the winner holds the lock. (It did, for several runs.)
        const blocked = await awaitBlocked(
          observer,
          racers.map((r) => r.pid),
          1,
        );
        await commitAll(racers);
        // THE DEFECT, committed: two bookings, same chair, same half hour —
        // and the loser was never refused, though it genuinely waited.
        expect(summarise(await Promise.all(attempts), blocked.length)).toEqual({ committed: 2, refused: 0, codes: [], blocked: 1 });
      } finally {
        await closeRacers(racers);
      }
      doubleBooked = await occupying(db, world.resourceAId, at(`${h}:00`), at(`${h}:30`));
      expect(doubleBooked).toBe(2);
    } finally {
      await db.pool.query(`DELETE FROM booking_operations WHERE business_id = $1`, [world.businessId]);
      await db.pool.query(`ALTER TABLE bookings DISABLE TRIGGER bookings_no_deletion`);
      await db.pool.query(`DELETE FROM bookings WHERE business_id = $1 AND starts_at = $2::timestamptz`, [world.businessId, at(`${h}:00`)]);
      await db.pool.query(`ALTER TABLE bookings ENABLE TRIGGER bookings_no_deletion`);
      await db.pool.query(`ALTER TABLE bookings ADD CONSTRAINT ${INVARIANT} ${original}`);
    }
    expect(await constraintDef(db, INVARIANT)).toBe(original);
    await expectRefused(db, world, h, '23P01');
  });

  it('CONTROL 2 — a trigger that LOOKS for a conflict double-books as soon as a writer forgets the lock; the constraint never depends on remembering (R-P9-01)', async () => {
    slot += 1;
    const h = hour();
    // This control was written to show that a check-then-insert trigger is
    // simply unsound, and MEASUREMENT CORRECTED IT. With the per-resource
    // advisory lock held for the whole transaction the trigger is sound: the
    // loser waits for the lock, the winner commits, and under READ COMMITTED
    // the loser's next statement takes a fresh snapshot that can see the
    // winner's row — so the trigger refuses correctly. The first version of
    // this control asserted two commits and got one commit and one refusal.
    //
    // So the real difference between the two mechanisms is not "one works and
    // one does not". It is WHAT THEY DEPEND ON. The exclusion constraint is
    // correct on its own. The trigger is correct only while every writer, in
    // every future slice, for ever, remembers to take the right lock first —
    // and the moment one does not, it commits a double booking in silence.
    // Both halves are measured below, in that order.
    await db.pool.query(`ALTER TABLE bookings DROP CONSTRAINT ${INVARIANT}`);
    await db.pool.query(`
      CREATE OR REPLACE FUNCTION p9_nc_overlap_check() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM public.bookings b
           WHERE b.business_id = NEW.business_id
             AND b.resource_id = NEW.resource_id
             AND b.id <> NEW.id
             AND b.state IN ('booked', 'completed', 'no_show')
             AND b.blocking_window && NEW.blocking_window
        ) THEN
          RAISE EXCEPTION 'booking.slot_taken: that time is already taken on this resource' USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END $fn$`);
    await db.pool.query(`CREATE TRIGGER p9_nc_overlap BEFORE INSERT ON bookings FOR EACH ROW EXECUTE FUNCTION p9_nc_overlap_check()`);
    try {
      // (a) Serially, the trigger refuses correctly. It is not a broken
      //     trigger: it reads the table, finds the overlap, and raises a
      //     well-worded refusal. Proving that first is what makes (c) a
      //     statement about concurrency rather than about a bug.
      await db.pool.query(INSERT_BOOKING, bookingParams({ world, id: uuid(2100), startsAt: at(`${h}:00`), endsAt: at(`${h}:30`) }));
      let serial = '';
      try {
        await db.pool.query(INSERT_BOOKING, bookingParams({ world, id: uuid(2101), startsAt: at(`${h}:10`), endsAt: at(`${h}:40`) }));
      } catch (e) {
        serial = (e as Error).message;
      }
      expect(serial).toContain('booking.slot_taken');

      // (b) Concurrently, WITH the lock, the trigger also refuses correctly —
      //     the correction this control exists to record.
      const disciplined = await openRacers(db.url('postgres'), 2);
      try {
        const attempts = issue(disciplined, INSERT_BOOKING_LOCKED, (i) =>
          bookingParams({ world, id: uuid(2110 + i), startsAt: at(`${h}:45`), endsAt: at(`${h}:50`) }),
        );
        const blocked = await awaitBlocked(
          observer,
          disciplined.map((r) => r.pid),
          1,
        );
        await commitAll(disciplined);
        const outcome = summarise(await Promise.all(attempts), blocked.length);
        expect(outcome.committed).toBe(1);
        expect(outcome.refused).toBe(1);
      } finally {
        await closeRacers(disciplined);
      }

      // (c) Concurrently, with ONE writer that forgot the lock, the same
      //     trigger commits a double booking. Nothing else changed.
      const careless = await openRacers(db.url('postgres'), 2);
      try {
        const attempts = issue(careless, INSERT_BOOKING, (i) => bookingParams({ world, id: uuid(2120 + i), startsAt: at(`${h}:52`), endsAt: at(`${h}:57`) }));
        const settled = await Promise.all(attempts);
        await commitAll(careless);
        // Both looked. Both found nothing. Both committed.
        expect(summarise(settled, 0)).toEqual({ committed: 2, refused: 0, codes: [], blocked: 0 });
      } finally {
        await closeRacers(careless);
      }
      expect(await occupying(db, world.resourceAId, at(`${h}:52`), at(`${h}:57`))).toBe(2);
    } finally {
      await db.pool.query('DROP TRIGGER p9_nc_overlap ON bookings');
      await db.pool.query('DROP FUNCTION p9_nc_overlap_check()');
      await purge(db, world);
      await db.pool.query(`ALTER TABLE bookings ADD CONSTRAINT ${INVARIANT} ${original}`);
    }
    expect(await constraintDef(db, INVARIANT)).toBe(original);
    // And with the constraint back, the careless writer cannot do it either:
    // the invariant does not ask whether anyone remembered anything.
    const careless = await openRacers(db.url('postgres'), 2);
    try {
      const attempts = issue(careless, INSERT_BOOKING, (i) => bookingParams({ world, id: uuid(2130 + i), startsAt: at(`${h}:52`), endsAt: at(`${h}:57`) }));
      // With the constraint back, the loser queues on the exclusion INDEX
      // rather than on the advisory lock, so it still cannot finish before the
      // winner commits: the wait is observed first and COMMIT comes before the
      // inserts are awaited. Awaiting them first hung this file for 560s.
      const blocked = await awaitBlocked(
        observer,
        careless.map((r) => r.pid),
        1,
      );
      await commitAll(careless);
      const outcome = summarise(await Promise.all(attempts), blocked.length);
      expect(outcome.committed).toBe(1);
      expect(outcome.refused).toBe(1);
      expect(outcome.blocked).toBe(1);
      // Without the lock the loser's code may be the invariant's own or the
      // deadlock detector's — CONTROL 6 is about exactly that difference — but
      // either way only one booking exists.
      expect(['23P01', '40P01']).toContain(outcome.codes[0]);
    } finally {
      await closeRacers(careless);
    }
    expect(await occupying(db, world.resourceAId, at(`${h}:52`), at(`${h}:57`))).toBe(1);
    await purge(db, world);
  });

  it('CONTROL 3 — with bookings_blocking_window_ck dropped, a caller forges a narrow window and books on top of a standing appointment (R-P9-03)', async () => {
    slot += 1;
    const h = hour();
    await db.pool.query(`ALTER TABLE bookings DROP CONSTRAINT bookings_blocking_window_ck`);
    try {
      await db.pool.query(INSERT_BOOKING, bookingParams({ world, id: uuid(2200), startsAt: at(`${h}:00`), endsAt: at(`${h}:59`) }));
      // The blocking window is what the index holds, so a caller that may
      // choose it may choose to be invisible. One second long, inside an hour
      // that is fully booked — and the exclusion constraint, still present and
      // still correct, has nothing to object to.
      await db.pool.query(
        `INSERT INTO bookings (tenant_id, business_id, branch_id, id, kind, resource_id, service_id, customer_id,
                              starts_at, ends_at, lead_buffer_minutes, trail_buffer_minutes, blocking_window,
                              state, intent_sha256, created_by_user_id)
         VALUES ($1, $2, $3, $4, 'appointment', $5, $6, $7, $8::timestamptz, $9::timestamptz, 0, 0,
                 tstzrange($10::timestamptz, $11::timestamptz, '[)'), 'booked', $12, $13)`,
        [
          world.tenantId,
          world.businessId,
          world.branchId,
          uuid(2201),
          world.resourceAId,
          world.plainServiceId,
          '00000000-0000-4000-8000-000000000001',
          at(`${h}:30`),
          at(`${h}:50`),
          `${DAY}T23:59:58Z`,
          `${DAY}T23:59:59Z`,
          'a'.repeat(64),
          world.userId,
        ],
      );
      // THE DEFECT: two appointments, one chair, overlapping customer-facing
      // times, both committed, with the invariant in place the whole time.
      const r = await db.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM bookings
          WHERE business_id = $1 AND resource_id = $2 AND state = 'booked'
            AND tstzrange(starts_at, ends_at, '[)') && tstzrange($3::timestamptz, $4::timestamptz, '[)')`,
        [world.businessId, world.resourceAId, at(`${h}:30`), at(`${h}:50`)],
      );
      expect(r.rows[0]?.n).toBe(2);
    } finally {
      await purge(db, world);
      await db.pool.query(`ALTER TABLE bookings ADD CONSTRAINT bookings_blocking_window_ck ${originalCheck}`);
    }
    expect(await constraintDef(db, 'bookings_blocking_window_ck')).toBe(originalCheck);
    // Restored: the same forgery is now refused, and with a CHECK violation.
    let code = '';
    try {
      await db.pool.query(
        `INSERT INTO bookings (tenant_id, business_id, branch_id, id, kind, resource_id, service_id, customer_id,
                              starts_at, ends_at, lead_buffer_minutes, trail_buffer_minutes, blocking_window,
                              state, intent_sha256, created_by_user_id)
         VALUES ($1, $2, $3, $4, 'appointment', $5, $6, $7, $8::timestamptz, $9::timestamptz, 0, 0,
                 tstzrange($8::timestamptz, $8::timestamptz + interval '1 second', '[)'), 'booked', $10, $11)`,
        [
          world.tenantId,
          world.businessId,
          world.branchId,
          uuid(2202),
          world.resourceAId,
          world.plainServiceId,
          '00000000-0000-4000-8000-000000000001',
          at(`${h}:30`),
          at(`${h}:50`),
          'a'.repeat(64),
          world.userId,
        ],
      );
    } catch (e) {
      code = sqlState(e);
    }
    expect(code).toBe('23514');
  });

  it('CONTROL 4 — with the predicate removed, a cancelled booking holds its hour for ever', async () => {
    slot += 1;
    const h = hour();
    // The partial predicate is the half of the invariant that makes the system
    // usable rather than merely correct. Without it, cancelling frees nothing.
    await db.pool.query(`ALTER TABLE bookings DROP CONSTRAINT ${INVARIANT}`);
    await db.pool.query(
      `ALTER TABLE bookings ADD CONSTRAINT ${INVARIANT} EXCLUDE USING gist (business_id WITH =, resource_id WITH =, blocking_window WITH &&)`,
    );
    try {
      const standing = uuid(2300);
      await db.pool.query(INSERT_BOOKING, bookingParams({ world, id: standing, startsAt: at(`${h}:00`), endsAt: at(`${h}:30`) }));
      await db.pool.query(
        `UPDATE bookings SET state = 'cancelled', settled_at = now(), settled_by_user_id = $2, settle_reason = 'control 4' WHERE business_id = $3 AND id = $1`,
        [standing, world.userId, world.businessId],
      );
      let code = '';
      try {
        await db.pool.query(INSERT_BOOKING, bookingParams({ world, id: uuid(2301), startsAt: at(`${h}:00`), endsAt: at(`${h}:30`) }));
      } catch (e) {
        code = sqlState(e);
      }
      // THE DEFECT: the slot was released and is still unbookable.
      expect(code).toBe('23P01');
    } finally {
      await purge(db, world);
      await db.pool.query(`ALTER TABLE bookings DROP CONSTRAINT ${INVARIANT}`);
      await db.pool.query(`ALTER TABLE bookings ADD CONSTRAINT ${INVARIANT} ${original}`);
    }
    expect(await constraintDef(db, INVARIANT)).toBe(original);
    // Restored: cancelling frees the hour again.
    const standing = uuid(2310);
    await db.pool.query(INSERT_BOOKING, bookingParams({ world, id: standing, startsAt: at(`${h}:00`), endsAt: at(`${h}:30`) }));
    await db.pool.query(
      `UPDATE bookings SET state = 'cancelled', settled_at = now(), settled_by_user_id = $2, settle_reason = 'control 4 restored' WHERE business_id = $3 AND id = $1`,
      [standing, world.userId, world.businessId],
    );
    await db.pool.query(INSERT_BOOKING, bookingParams({ world, id: uuid(2311), startsAt: at(`${h}:00`), endsAt: at(`${h}:30`) }));
    await purge(db, world);
  });

  it('CONTROL 5 — excluding on the SERVICE window instead of the blocking window puts the buffers outside the invariant (R-P9-02)', async () => {
    slot += 1;
    const h = hour();
    await db.pool.query(`ALTER TABLE bookings DROP CONSTRAINT ${INVARIANT}`);
    await db.pool.query(`
      ALTER TABLE bookings ADD CONSTRAINT ${INVARIANT}
        EXCLUDE USING gist (business_id WITH =, resource_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
        WHERE (state IN ('booked', 'completed', 'no_show'))`);
    try {
      // A colour with fifteen trailing minutes, then a haircut five minutes
      // after it ends. The customer-facing spans do not touch; the resource is
      // still being cleaned.
      await db.pool.query(
        INSERT_BOOKING,
        bookingParams({ world, id: uuid(2400), serviceId: world.bufferedServiceId, trail: 15, startsAt: at(`${h}:00`), endsAt: at(`${h}:30`) }),
      );
      await db.pool.query(INSERT_BOOKING, bookingParams({ world, id: uuid(2401), startsAt: at(`${h}:35`), endsAt: at(`${h}:50`) }));
      // THE DEFECT: the blocking windows overlap and both rows committed.
      const r = await db.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM bookings a JOIN bookings b
           ON a.business_id = b.business_id AND a.resource_id = b.resource_id AND a.id < b.id
          AND a.blocking_window && b.blocking_window
         WHERE a.business_id = $1 AND a.state = 'booked' AND b.state = 'booked'`,
        [world.businessId],
      );
      expect(r.rows[0]?.n).toBe(1);
    } finally {
      await purge(db, world);
      await db.pool.query(`ALTER TABLE bookings DROP CONSTRAINT ${INVARIANT}`);
      await db.pool.query(`ALTER TABLE bookings ADD CONSTRAINT ${INVARIANT} ${original}`);
    }
    expect(await constraintDef(db, INVARIANT)).toBe(original);
    // Restored: the same pair is refused.
    await db.pool.query(
      INSERT_BOOKING,
      bookingParams({ world, id: uuid(2410), serviceId: world.bufferedServiceId, trail: 15, startsAt: at(`${h}:00`), endsAt: at(`${h}:30`) }),
    );
    let code = '';
    try {
      await db.pool.query(INSERT_BOOKING, bookingParams({ world, id: uuid(2411), startsAt: at(`${h}:35`), endsAt: at(`${h}:50`) }));
    } catch (e) {
      code = sqlState(e);
    }
    expect(code).toBe('23P01');
    await purge(db, world);
  });

  it('CONTROL 6 — without the resource lock, two bookers deadlock: 40P01 instead of a refusal anyone can read (R-P9-11)', async () => {
    slot += 1;
    const h = hour();
    // Deterministic, not probabilistic. Each transaction first plants a row
    // the other will conflict with, then inserts into the other's conflict —
    // so the wait is mutual by construction and PostgreSQL's deadlock
    // detector has to break it. This is the same cycle that forms by chance
    // when two bookers race without the lock; it failed three of eight runs
    // of PROOF 1 before R-P9-11 was added, and the detector resolved it after
    // deadlock_timeout every time.
    const racers = await openRacers(db.url('postgres'), 2);
    let codes: string[] = [];
    try {
      const a = racers[0];
      const b = racers[1];
      if (a === undefined || b === undefined) return;

      await a.client.query(INSERT_BOOKING, bookingParams({ world, id: uuid(2500), startsAt: at(`${h}:00`), endsAt: at(`${h}:20`) }));
      await b.client.query(INSERT_BOOKING, bookingParams({ world, id: uuid(2501), startsAt: at(`${h}:40`), endsAt: at(`${h}:59`) }));

      const crossed = [
        a.client.query(INSERT_BOOKING, bookingParams({ world, id: uuid(2502), startsAt: at(`${h}:45`), endsAt: at(`${h}:55`) })).then(
          () => '',
          (e: unknown) => sqlState(e),
        ),
        b.client.query(INSERT_BOOKING, bookingParams({ world, id: uuid(2503), startsAt: at(`${h}:05`), endsAt: at(`${h}:15`) })).then(
          () => '',
          (e: unknown) => sqlState(e),
        ),
      ];
      codes = (await Promise.all(crossed)).filter((c) => c !== '');
    } finally {
      await commitAll(racers);
      await closeRacers(racers);
    }
    // One of the two was killed by the deadlock detector. That is the error a
    // customer would have seen.
    expect(codes).toContain('40P01');

    await purge(db, world);

    // And with the lock taken first — the command's own form — the same two
    // bookers queue instead, and the loser gets the invariant's own code.
    const locked = await openRacers(db.url('postgres'), 2);
    try {
      const attempts = issue(locked, INSERT_BOOKING_LOCKED, (i) =>
        bookingParams({ world, id: uuid(2510 + i), startsAt: at(`${h}:00`), endsAt: at(`${h}:30`) }),
      );
      const blocked = await awaitBlocked(
        observer,
        locked.map((r) => r.pid),
        1,
      );
      await commitAll(locked);
      expect(summarise(await Promise.all(attempts), blocked.length)).toEqual({ committed: 1, refused: 1, codes: ['23P01'], blocked: 1 });
    } finally {
      await closeRacers(locked);
    }
    await purge(db, world);
  });

  it('the invariant survived every control, character for character', async () => {
    // The last word. If any control's restore had drifted, the controls after
    // it were measuring something else, and this says so.
    expect(await constraintDef(db, INVARIANT)).toBe(original);
    expect(await constraintDef(db, 'bookings_blocking_window_ck')).toBe(originalCheck);
  });
});

async function constraintDef(db: ScratchDb, name: string): Promise<string> {
  const r = await db.pool.query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'bookings' AND c.conname = $1`,
    [name],
  );
  const def = r.rows[0]?.def;
  if (def === undefined) throw new Error(`constraint ${name} is not on bookings — a control cannot be run or restored without it`);
  return def;
}

/** Clear this business's bookings, around the no-delete trigger. */
async function purge(db: ScratchDb, world: BookingWorld): Promise<void> {
  await db.pool.query(`DELETE FROM booking_operations WHERE business_id = $1`, [world.businessId]);
  await db.pool.query(`ALTER TABLE bookings DISABLE TRIGGER bookings_no_deletion`);
  await db.pool.query(
    `UPDATE bookings SET rescheduled_to_id = NULL, state = 'booked', settled_at = NULL, settled_by_user_id = NULL, settle_reason = NULL WHERE business_id = $1 AND state = 'rescheduled'`,
    [world.businessId],
  );
  await db.pool.query(`DELETE FROM bookings WHERE business_id = $1`, [world.businessId]);
  await db.pool.query(`ALTER TABLE bookings ENABLE TRIGGER bookings_no_deletion`);
}

/** With the schema restored, an overlapping pair in `hour` must be refused. */
async function expectRefused(db: ScratchDb, world: BookingWorld, hour: string, expected: string): Promise<void> {
  await db.pool.query(INSERT_BOOKING, bookingParams({ world, id: uuid(9000), startsAt: at(`${hour}:00`), endsAt: at(`${hour}:30`) }));
  let code = '';
  try {
    await db.pool.query(INSERT_BOOKING, bookingParams({ world, id: uuid(9001), startsAt: at(`${hour}:10`), endsAt: at(`${hour}:40`) }));
  } catch (e) {
    code = sqlState(e);
  }
  expect(code).toBe(expected);
  await purge(db, world);
}

async function occupying(db: ScratchDb, resource: string, from: string, to: string): Promise<number> {
  const r = await db.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM bookings
      WHERE resource_id = $1 AND state IN ('booked', 'completed', 'no_show')
        AND blocking_window && tstzrange($2::timestamptz, $3::timestamptz, '[)')`,
    [resource, from, to],
  );
  return r.rows[0]?.n ?? 0;
}
