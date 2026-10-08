/**
 * P9 PREP — NO DOUBLE BOOKING UNDER RACE (master directive Part 29, Part 39).
 *
 * The requirement is one sentence: "No double booking under race. DB-level
 * invariant where appropriate." Everything below is the measurement of that
 * sentence against a real PostgreSQL cluster carrying the real schema, with
 * real concurrent connections and no sleep anywhere.
 *
 * Each proof states what it would catch. A race that did not actually contend
 * fails in `awaitBlocked` rather than passing quietly, because "both
 * transactions ran one after the other and the second was refused" proves
 * only serial behaviour, which was never in doubt.
 *
 * Status: PREPARED / NOT PROMOTED. Not part of required CI.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ScratchDb } from '../helpers/scratch-db';
import { createScratchDb } from '../helpers/scratch-db';
import { BASE_HEAD, BOOTSTRAP_PATCH } from './p9-booking-spec';
import {
  type BookingWorld,
  INSERT_BOOKING,
  INSERT_BOOKING_LOCKED,
  INSERT_BOOKING_WITH_BACKLINK,
  INTENT,
  applySpecAsMigrator,
  bookingParams,
  seedBookingWorld,
  sqlState,
  uuid,
} from './p9-booking-world';
import { awaitBlocked, closeRacers, commitAll, issue, openRacers, summarise } from './p9-race';

/** One day, far from any real data, so every proof picks its own hour. */
const DAY = '2027-03-15';
const at = (hhmm: string): string => `${DAY}T${hhmm}:00Z`;

describe('P9 bookings — the invariant under real concurrency', () => {
  let db: ScratchDb;
  let world: BookingWorld;
  let observer: Client;
  let slot = 0;

  beforeAll(async () => {
    db = await createScratchDb('daftar_p9_race', { upTo: BASE_HEAD, keys: false, migratorOwned: true });
    await db.pool.query(BOOTSTRAP_PATCH);
    await applySpecAsMigrator(db);
    world = await seedBookingWorld(db);
    observer = new Client({ connectionString: db.url('postgres') });
    await observer.connect();
  }, 600_000);

  afterAll(async () => {
    await observer?.end().catch(() => undefined);
    await db?.drop();
  });

  // Every proof gets its own hour, so one proof's committed rows can never be
  // the reason another one's race was refused.
  beforeEach(() => {
    slot += 1;
  });
  const hour = (): string => `${String(6 + slot).padStart(2, '0')}`;

  it('PROOF 1 — two concurrent transactions on one slot: one commits, the other is refused, and the loser really blocked', async () => {
    const racers = await openRacers(db.url('postgres'), 2);
    try {
      // The command's own form: the resource lock, then the row (R-P9-11).
      const attempts = issue(racers, INSERT_BOOKING_LOCKED, (i) =>
        bookingParams({ world, id: uuid(100 + i), startsAt: at(`${hour()}:00`), endsAt: at(`${hour()}:30`) }),
      );
      // The second transaction is waiting on the first's uncommitted index
      // entry. This is the barrier: the server established it, not a timer.
      const blocked = await awaitBlocked(
        observer,
        racers.map((r) => r.pid),
        1,
      );
      await commitAll(racers);
      const outcome = summarise(await Promise.all(attempts), blocked.length);
      expect(outcome).toEqual({ committed: 1, refused: 1, codes: ['23P01'], blocked: 1 });
    } finally {
      await closeRacers(racers);
    }
    // And the database holds exactly one booking in that hour.
    expect(await occupying(db, world.resourceAId, at(`${hour()}:00`), at(`${hour()}:30`))).toBe(1);
  });

  it('PROOF 2 — eight concurrent transactions on one slot: exactly one survives, seven raise 23P01', async () => {
    // Two connections can be a coincidence of ordering. Eight contending on
    // one index entry is the shape a busy salon actually produces.
    const racers = await openRacers(db.url('postgres'), 8);
    try {
      const attempts = issue(racers, INSERT_BOOKING_LOCKED, (i) =>
        bookingParams({ world, id: uuid(200 + i), startsAt: at(`${hour()}:00`), endsAt: at(`${hour()}:45`) }),
      );
      const blocked = await awaitBlocked(
        observer,
        racers.map((r) => r.pid),
        7,
      );
      await commitAll(racers);
      const outcome = summarise(await Promise.all(attempts), blocked.length);
      expect(outcome).toEqual({ committed: 1, refused: 7, codes: ['23P01'], blocked: 7 });
    } finally {
      await closeRacers(racers);
    }
    expect(await occupying(db, world.resourceAId, at(`${hour()}:00`), at(`${hour()}:45`))).toBe(1);
  });

  it('PROOF 3 — the loser is refused only because the winner COMMITTED: a rolled-back winner frees the slot', async () => {
    // This is what distinguishes the exclusion constraint from a unique index
    // over a coarse slot key. The blocked transaction is not pre-judged: it is
    // resolved by what the first transaction actually did.
    const racers = await openRacers(db.url('postgres'), 2);
    try {
      const first = racers[0];
      const second = racers[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (first === undefined || second === undefined) return;

      await first.client.query(INSERT_BOOKING, bookingParams({ world, id: uuid(300), startsAt: at(`${hour()}:00`), endsAt: at(`${hour()}:30`) }));
      const blockedAttempt = issue([second], INSERT_BOOKING, () =>
        bookingParams({ world, id: uuid(301), startsAt: at(`${hour()}:10`), endsAt: at(`${hour()}:40`) }),
      );
      await awaitBlocked(observer, [second.pid], 1);
      await first.client.query('ROLLBACK');
      const [result] = await Promise.all(blockedAttempt);
      expect(result?.ok).toBe(true);
      await second.client.query('COMMIT');
    } finally {
      await closeRacers(racers);
    }
    expect(await occupying(db, world.resourceAId, at(`${hour()}:00`), at(`${hour()}:40`))).toBe(1);
  });

  it('PROOF 4 — adjacency is not overlap: back-to-back bookings commit concurrently (R-P9-04)', async () => {
    // The half-open range is what makes this true. With 0049's inclusive
    // `'[]'` both of these would conflict at the shared instant, and every
    // correctly adjacent appointment in the product would be refused.
    const racers = await openRacers(db.url('postgres'), 2);
    try {
      const attempts = issue(racers, INSERT_BOOKING, (i) =>
        i === 0
          ? bookingParams({ world, id: uuid(400), startsAt: at(`${hour()}:00`), endsAt: at(`${hour()}:30`) })
          : bookingParams({ world, id: uuid(401), startsAt: at(`${hour()}:30`), endsAt: at(`${hour()}:59`) }),
      );
      const settled = await Promise.all(attempts);
      await commitAll(racers);
      expect(summarise(settled, 0)).toEqual({ committed: 2, refused: 0, codes: [], blocked: 0 });
    } finally {
      await closeRacers(racers);
    }
  });

  it('PROOF 5 — a buffer is inside the invariant: a booking in the previous one’s trailing minutes is refused under race (R-P9-02)', async () => {
    // The customer-facing spans here do NOT overlap: :00-:30 and :35-:50.
    // Only the blocking windows do, because the first booking's service
    // declares fifteen trailing minutes. A buffer enforced in application
    // code would let the second one through under concurrency.
    const racers = await openRacers(db.url('postgres'), 2);
    try {
      const attempts = issue(racers, INSERT_BOOKING_LOCKED, (i) =>
        i === 0
          ? bookingParams({ world, id: uuid(500), serviceId: world.bufferedServiceId, trail: 15, startsAt: at(`${hour()}:00`), endsAt: at(`${hour()}:30`) })
          : bookingParams({ world, id: uuid(501), startsAt: at(`${hour()}:35`), endsAt: at(`${hour()}:50`) }),
      );
      const blocked = await awaitBlocked(
        observer,
        racers.map((r) => r.pid),
        1,
      );
      await commitAll(racers);
      const outcome = summarise(await Promise.all(attempts), blocked.length);
      expect(outcome).toEqual({ committed: 1, refused: 1, codes: ['23P01'], blocked: 1 });
    } finally {
      await closeRacers(racers);
    }
  });

  it('PROOF 6 — the invariant is per RESOURCE: the same hour on a second chair commits concurrently', async () => {
    // A constraint that keyed on the business alone would serialise the whole
    // salon onto one chair, which is the opposite failure and just as wrong.
    const racers = await openRacers(db.url('postgres'), 2);
    try {
      const attempts = issue(racers, INSERT_BOOKING, (i) =>
        bookingParams({
          world,
          id: uuid(600 + i),
          resourceId: i === 0 ? world.resourceAId : world.resourceBId,
          startsAt: at(`${hour()}:00`),
          endsAt: at(`${hour()}:30`),
        }),
      );
      const settled = await Promise.all(attempts);
      await commitAll(racers);
      expect(summarise(settled, 0)).toEqual({ committed: 2, refused: 0, codes: [], blocked: 0 });
    } finally {
      await closeRacers(racers);
    }
  });

  it('PROOF 7 — a resource block and an appointment contend under the SAME invariant (R-P9-05)', async () => {
    // This is why closures live in `bookings`. Modelled as their own table
    // they would need a trigger to compare them with appointments, and that
    // trigger would lose this exact race: both transactions look, both find
    // nothing, both commit, and the maintenance window is double-booked.
    const racers = await openRacers(db.url('postgres'), 2);
    try {
      const attempts = issue(racers, INSERT_BOOKING_LOCKED, (i) =>
        i === 0
          ? bookingParams({ world, id: uuid(700), kind: 'resource_block', startsAt: at(`${hour()}:00`), endsAt: at(`${hour()}:59`) })
          : bookingParams({ world, id: uuid(701), startsAt: at(`${hour()}:15`), endsAt: at(`${hour()}:45`) }),
      );
      const blocked = await awaitBlocked(
        observer,
        racers.map((r) => r.pid),
        1,
      );
      await commitAll(racers);
      const outcome = summarise(await Promise.all(attempts), blocked.length);
      expect(outcome).toEqual({ committed: 1, refused: 1, codes: ['23P01'], blocked: 1 });
    } finally {
      await closeRacers(racers);
    }
  });

  it('PROOF 8 — a cancellation releases the slot, and the next booking blocks on the cancellation until it commits', async () => {
    // The partial predicate is what makes this work, and this proof pins both
    // halves: the waiting booking cannot proceed on a cancellation that has
    // not committed, and it succeeds the moment that cancellation does.
    const standing = uuid(800);
    await db.pool.query(INSERT_BOOKING, bookingParams({ world, id: standing, startsAt: at(`${hour()}:00`), endsAt: at(`${hour()}:30`) }));

    const racers = await openRacers(db.url('postgres'), 2);
    try {
      const canceller = racers[0];
      const rebooker = racers[1];
      if (canceller === undefined || rebooker === undefined) return;

      await canceller.client.query(
        `UPDATE bookings SET state = 'cancelled', settled_at = now(), settled_by_user_id = $2, settle_reason = 'customer called' WHERE business_id = $3 AND id = $1`,
        [standing, world.userId, world.businessId],
      );
      const attempt = issue([rebooker], INSERT_BOOKING, () =>
        bookingParams({ world, id: uuid(801), startsAt: at(`${hour()}:00`), endsAt: at(`${hour()}:30`) }),
      );
      await awaitBlocked(observer, [rebooker.pid], 1);
      await canceller.client.query('COMMIT');
      const [result] = await Promise.all(attempt);
      expect(result?.ok).toBe(true);
      await rebooker.client.query('COMMIT');
    } finally {
      await closeRacers(racers);
    }
    const states = await db.pool.query<{ state: string; n: number }>(
      `SELECT state, count(*)::int AS n FROM bookings WHERE resource_id = $1 AND starts_at = $2::timestamptz GROUP BY state ORDER BY 1`,
      [world.resourceAId, at(`${hour()}:00`)],
    );
    expect(states.rows).toEqual([
      { state: 'booked', n: 1 },
      { state: 'cancelled', n: 1 },
    ]);
  });

  it('PROOF 9 — a reschedule onto an overlapping hour succeeds in ONE transaction, in the order the model requires', async () => {
    // The new window overlaps the old one, so the only order that can work is
    // transition-then-insert. That is not a workaround: a booking releases its
    // slot by being rescheduled, and the new row takes it, and both facts are
    // one atomic change. The reverse order is proven to fail below.
    const original = uuid(900);
    const replacement = uuid(901);
    await db.pool.query(INSERT_BOOKING, bookingParams({ world, id: original, startsAt: at(`${hour()}:00`), endsAt: at(`${hour()}:30`) }));

    const client = new Client({ connectionString: db.url('postgres') });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE bookings SET state = 'rescheduled', rescheduled_to_id = $2, settled_at = now(), settled_by_user_id = $3 WHERE business_id = $4 AND id = $1`,
        [original, replacement, world.userId, world.businessId],
      );
      // The backlink is written AT INSERT, never afterwards: `rescheduled_from_id`
      // is part of the new row's identity and `bookings_transition` refuses to
      // add it later (measured — the first version of this proof tried, and was
      // refused with booking.immutable).
      await client.query(INSERT_BOOKING_WITH_BACKLINK, [
        ...bookingParams({ world, id: replacement, startsAt: at(`${hour()}:15`), endsAt: at(`${hour()}:45`) }),
        original,
      ]);
      await client.query('COMMIT');
    } finally {
      await client.end();
    }

    // The reverse order cannot work, and says so with the invariant's code.
    const bad = new Client({ connectionString: db.url('postgres') });
    await bad.connect();
    let code = '';
    try {
      await bad.query('BEGIN');
      await bad.query(INSERT_BOOKING, bookingParams({ world, id: uuid(902), startsAt: at(`${hour()}:20`), endsAt: at(`${hour()}:50`) }));
    } catch (e) {
      code = sqlState(e);
    } finally {
      await bad.query('ROLLBACK').catch(() => undefined);
      await bad.end();
    }
    expect(code).toBe('23P01');
  });

  it('PROOF 10 — two businesses of one tenant book the same clock hour concurrently, each on its own resource', async () => {
    const racers = await openRacers(db.url('postgres'), 2);
    try {
      const attempts = racers.map((r, i) =>
        r.client
          .query(
            INSERT_BOOKING,
            i === 0
              ? bookingParams({ world, id: uuid(1000), startsAt: at(`${hour()}:00`), endsAt: at(`${hour()}:30`) })
              : [
                  world.tenantId,
                  world.otherBusinessId,
                  world.otherBranchId,
                  uuid(1001),
                  'resource_block',
                  world.otherResourceId,
                  null,
                  null,
                  at(`${hour()}:00`),
                  at(`${hour()}:30`),
                  0,
                  0,
                  'booked',
                  INTENT,
                  world.userId,
                ],
          )
          .then(
            () => true,
            () => false,
          ),
      );
      expect(await Promise.all(attempts)).toEqual([true, true]);
      await commitAll(racers);
    } finally {
      await closeRacers(racers);
    }
  });

  it('PROOF 11 — the invariant does not depend on the session timezone', async () => {
    // `blocking_window` is pinned by a CHECK that uses `timestamptz -
    // interval`, which PostgreSQL marks STABLE. The arithmetic is exact only
    // because `make_interval(mins => n)` yields a pure time interval. That is
    // a claim about PostgreSQL, so it is measured rather than asserted —
    // across a zone with southern-hemisphere DST, one with a 45-minute
    // offset, and a booking that straddles a transition.
    for (const tz of ['UTC', 'Asia/Jerusalem', 'America/Santiago', 'Pacific/Chatham', 'Australia/Lord_Howe']) {
      const client = new Client({ connectionString: db.url('postgres') });
      await client.connect();
      try {
        await client.query(`SET TimeZone = '${tz}'`);
        const id = uuid(1100 + tz.length);
        await client.query(
          INSERT_BOOKING,
          bookingParams({
            world,
            id,
            serviceId: world.bufferedServiceId,
            trail: 15,
            startsAt: '2027-10-03T13:30:00Z',
            endsAt: '2027-10-03T14:30:00Z',
            resourceId: world.resourceBId,
          }),
        );
        // Re-evaluate the invariant in this zone against the stored row: if the
        // arithmetic were zone-dependent, a row written under one zone would
        // stop satisfying its own CHECK read under another.
        const r = await client.query<{ ok: boolean }>(
          `SELECT blocking_window = tstzrange(starts_at - make_interval(mins => lead_buffer_minutes), ends_at + make_interval(mins => trail_buffer_minutes), '[)') AS ok
             FROM bookings WHERE business_id = $1 AND id = $2`,
          [world.businessId, id],
        );
        expect({ tz, ok: r.rows[0]?.ok }).toEqual({ tz, ok: true });
        await client.query(
          `UPDATE bookings SET state = 'cancelled', settled_at = now(), settled_by_user_id = $2, settle_reason = 'timezone proof' WHERE business_id = $3 AND id = $1`,
          [id, world.userId, world.businessId],
        );
      } finally {
        await client.end();
      }
    }
  });
});

/** Rows that OCCUPY `resource` anywhere in `[from, to)`. */
async function occupying(db: ScratchDb, resource: string, from: string, to: string): Promise<number> {
  const r = await db.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM bookings
      WHERE resource_id = $1 AND state IN ('booked', 'completed', 'no_show')
        AND blocking_window && tstzrange($2::timestamptz, $3::timestamptz, '[)')`,
    [resource, from, to],
  );
  return r.rows[0]?.n ?? 0;
}
