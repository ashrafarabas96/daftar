/**
 * P9 PREP — THE MULTI-RESOURCE LOCK ORDER, AND IDEMPOTENT RETRIES
 * (directive #11 PART 50 and PART 53; Part 39 real concurrency;
 * Part 40 / PART 17 proof-of-proof).
 *
 * PART 50 asks for one thing the single-resource proofs cannot give: a
 * reschedule that MOVES a booking from one resource to another touches two
 * resources, and two such reschedules crossing — A→B against B→A — are the
 * textbook deadlock. The law is that every transaction takes EVERY lock it
 * will need, in one global deterministic order, before it mutates anything.
 * PROOF 12 races the crossing both ways under that law; CONTROL 7 removes
 * the law and measures the deadlock it prevents.
 *
 * PART 53 asks that a retry cannot duplicate a booking, on a caller-supplied
 * identity that is not derived from a clock. PROOF 14 races two transactions
 * carrying the SAME operation id.
 *
 * Status: PREPARED / NOT PROMOTED. Not part of required CI.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScratchDb } from '../helpers/scratch-db';
import { createScratchDb } from '../helpers/scratch-db';
import { BASE_HEAD, BOOTSTRAP_PATCH } from './p9-booking-spec';
import { type BookingWorld, INSERT_BOOKING, INTENT, applySpecAsMigrator, bookingParams, seedBookingWorld, sqlState, uuid } from './p9-booking-world';
import { awaitBlocked, closeRacers, openRacers, type Racer } from './p9-race';

const DAY = '2027-07-19';
const at = (hhmm: string): string => `${DAY}T${hhmm}:00Z`;
/** The half hour after `hhmm`, so every booking in this suite is thirty minutes long. */
const half = (hhmm: string): string => `${hhmm.slice(0, 2)}:30`;

/** The operation-registry insert a booking command performs in its own transaction. */
const INSERT_OPERATION = `
  INSERT INTO booking_operations (tenant_id, business_id, operation_id, op_code, intent_sha256, booking_id, actor_user_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7)`;

describe('P9 bookings — multi-resource lock order and idempotent retries', () => {
  let db: ScratchDb;
  let world: BookingWorld;
  let observer: Client;

  beforeAll(async () => {
    db = await createScratchDb('daftar_p9_multi', { upTo: BASE_HEAD, keys: false, migratorOwned: true });
    await db.pool.query(BOOTSTRAP_PATCH);
    await applySpecAsMigrator(db);
    world = await seedBookingWorld(db);
    observer = new Client({ connectionString: db.url('postgres') });
    await observer.connect();
    // Both chairs must be eligible for the service, or a cross-resource
    // reschedule would be refused by the eligibility FK rather than reaching
    // the lock order this suite is about. Proving the subject exists first.
    const eligible = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM booking_service_resources
        WHERE business_id = $1 AND service_id = $2 AND resource_id = ANY($3::uuid[])`,
      [world.businessId, world.plainServiceId, [world.resourceAId, world.resourceBId]],
    );
    expect(eligible.rows[0]?.n).toBe(2);
  }, 600_000);

  afterAll(async () => {
    await observer?.end().catch(() => undefined);
    await db?.drop();
  });

  /** The lock keys of the two chairs, in the order the law requires them taken. */
  const expectedOrder = async (): Promise<string[]> => {
    // `ORDER BY d.k`, and the alias on the projection, are both deliberate.
    // Written as `SELECT k::text … ORDER BY k` this sorted the keys as TEXT,
    // because PostgreSQL binds a bare ORDER BY name to the OUTPUT column —
    // so the fixture disagreed with the routine whenever two keys' text order
    // differed from their numeric order, which depends on the run's random
    // uuids. It failed on one run in three, and the routine was right both
    // times: lock order must be numeric, because that is what the lock
    // manager orders on.
    const r = await db.pool.query<{ key: string }>(
      `SELECT d.k::text AS key FROM (SELECT DISTINCT booking_resource_lock_key($1, r) AS k
         FROM unnest($2::uuid[]) AS r) d ORDER BY d.k`,
      [world.businessId, [world.resourceAId, world.resourceBId]],
    );
    return r.rows.map((x) => x.key);
  };

  /**
   * One side of the crossing: move `bookingId` off `from` and onto `to`,
   * under whichever locking discipline `lock` applies. The two statements are
   * the model's own order (transition the predecessor, then insert the
   * successor with its backlink), in ONE transaction.
   */
  const move = async (
    racer: Racer,
    lock: 'sorted-set' | 'per-resource',
    bookingId: string,
    replacementId: string,
    from: string,
    to: string,
    hhmm: string,
  ): Promise<void> => {
    if (lock === 'sorted-set') {
      // The law: the whole set, sorted, deduplicated, before any mutation.
      await racer.client.query(`SELECT booking_lock_resources($1, $2::uuid[])`, [world.businessId, [from, to]]);
    } else {
      // The defect: each transaction locks what it is holding, then what it
      // wants. Two of them crossing hold what the other needs next.
      await racer.client.query(`SELECT pg_advisory_xact_lock(booking_resource_lock_key($1, $2))`, [world.businessId, from]);
      await racer.client.query(`SELECT pg_advisory_xact_lock(booking_resource_lock_key($1, $2))`, [world.businessId, to]);
    }
    await racer.client.query(
      `UPDATE bookings SET state = 'rescheduled', rescheduled_to_id = $2, settled_at = now(), settled_by_user_id = $3
        WHERE business_id = $4 AND id = $1`,
      [bookingId, replacementId, world.userId, world.businessId],
    );
    await racer.client.query(
      `INSERT INTO bookings (tenant_id, business_id, branch_id, id, kind, resource_id, service_id, customer_id,
                             starts_at, ends_at, lead_buffer_minutes, trail_buffer_minutes, blocking_window,
                             state, intent_sha256, created_by_user_id, rescheduled_from_id)
       VALUES ($1, $2, $3, $4, 'appointment', $5, $6, $7, $8::timestamptz, $9::timestamptz, 0, 0,
               tstzrange($8::timestamptz, $9::timestamptz, '[)'), 'booked', $10, $11, $12)`,
      [
        world.tenantId,
        world.businessId,
        world.branchId,
        replacementId,
        to,
        world.plainServiceId,
        '00000000-0000-4000-8000-000000000001',
        at(hhmm),
        at(half(hhmm)),
        INTENT,
        world.userId,
        bookingId,
      ],
    );
  };

  /**
   * Seat one booking on each chair at `hhmm`, then cross them: the one on A
   * moves to B while the one on B moves to A, each aiming at `targetA` /
   * `targetB`.
   *
   * MEASUREMENT CORRECTED THE FIRST VERSION OF THIS. It expected both sides
   * of a true swap to commit, and both were refused with 23P01 — rightly:
   * each side wants a slot the OTHER side has not released yet, so a genuine
   * swap of two occupied slots is a real conflict, not a deadlock. PART 50
   * asks for "no deadlock, one valid final state", and that is exactly what
   * the sorted lock set delivers: a readable 23P01 for the side that loses,
   * where per-resource locking delivers 40P01 for a side chosen by the
   * deadlock detector. So the swap case asserts one survivor, and
   * `targetHour` lets a second case give the two sides room to BOTH commit,
   * which is what proves the lock set serializes without refusing legal work.
   *
   * The barrier is explicit, per PART 18: under per-resource locking each
   * side takes its SOURCE lock and both are awaited before either reaches for
   * its target, so the cycle is constructed rather than hoped for.
   */
  const crossing = async (
    lock: 'sorted-set' | 'per-resource',
    seed: number,
    hhmm: string,
    targetA = hhmm,
    targetB = hhmm,
  ): Promise<{ codes: string[]; committed: number; blocked: number }> => {
    const onA = uuid(seed);
    const onB = uuid(seed + 1);
    const newOnB = uuid(seed + 2);
    const newOnA = uuid(seed + 3);
    await db.pool.query(INSERT_BOOKING, bookingParams({ world, id: onA, startsAt: at(hhmm), endsAt: at(half(hhmm)) }));
    await db.pool.query(INSERT_BOOKING, bookingParams({ world, id: onB, resourceId: world.resourceBId, startsAt: at(hhmm), endsAt: at(half(hhmm)) }));

    const racers = await openRacers(db.url('postgres'), 2);
    const [first, second] = racers;
    if (first === undefined || second === undefined) throw new Error('two racers were asked for');
    const codes: string[] = [];
    let committed = 0;
    let blocked = 0;
    try {
      if (lock === 'per-resource') {
        // The cycle, constructed. Each side holds its source lock before
        // either asks for its target, so both must then wait on the other.
        await first.client.query(`SELECT pg_advisory_xact_lock(booking_resource_lock_key($1, $2))`, [world.businessId, world.resourceAId]);
        await second.client.query(`SELECT pg_advisory_xact_lock(booking_resource_lock_key($1, $2))`, [world.businessId, world.resourceBId]);
      } else {
        // The barrier for the sorted set. One side takes the whole set FIRST,
        // so the other is certain to be found waiting at acquisition.
        //
        // Without it the proof flaked: in the swap case the winner reaches
        // 23P01 within microseconds and releases, so the waiter's wait was
        // real but had already ended by the time pg_blocking_pids was asked —
        // 0 observed over 28738 polls on one run and 1 on the next. The
        // contention is the product's; the observability is the harness's
        // job, and re-acquiring the same set is re-entrant, so this changes
        // nothing about what the two transactions then do.
        await first.client.query(`SELECT booking_lock_resources($1, $2::uuid[])`, [world.businessId, [world.resourceAId, world.resourceBId]]);
      }
      let a: Promise<string>;
      let b: Promise<string>;
      const sideA = (): Promise<string> =>
        move(first, lock, onA, newOnB, world.resourceAId, world.resourceBId, targetB).then(
          () => '',
          (e: unknown) => sqlState(e),
        );
      const sideB = (): Promise<string> =>
        move(second, lock, onB, newOnA, world.resourceBId, world.resourceAId, targetA).then(
          () => '',
          (e: unknown) => sqlState(e),
        );
      if (lock === 'sorted-set') {
        // `first` already holds the whole set, so `second` is started ALONE
        // and is certain to be found waiting at acquisition: nothing can
        // release it until `first` is told to proceed, below.
        //
        // Starting both and then looking flaked once in four runs — the
        // winner reached 23P01 and the test asked pg_blocking_pids a moment
        // later, by which time the wait was over (0 observed over 29204
        // polls). The contention was always the product's; the ORDER OF
        // OBSERVATION is the harness's to make deterministic, and PART 18
        // asks for a barrier rather than a hope.
        b = sideB();
        blocked = (await awaitBlocked(observer, [second.pid], 1)).length;
        a = sideA();
      } else {
        a = sideA();
        b = sideB();
        // Under per-resource locking both sides wait, on each other: the
        // cycle was constructed above, so this cannot pass by luck.
        blocked = (
          await awaitBlocked(
            observer,
            racers.map((r) => r.pid),
            1,
          )
        ).length;
      }
      // Each side is COMMITTED AS SOON AS IT RESOLVES, not after both have.
      // Awaiting both first hung this suite for 120s: the waiter cannot
      // finish while the winner still holds the lock set, and the winner does
      // not release it until COMMIT. This is the same harness self-deadlock
      // the negative-controls suite paid for once already.
      const settle = async (racer: Racer, side: Promise<string>): Promise<string> => {
        const code = await side;
        if (code === '') {
          try {
            await racer.client.query('COMMIT');
            return '';
          } catch (e) {
            return sqlState(e);
          }
        }
        await racer.client.query('ROLLBACK').catch(() => undefined);
        return code;
      };
      for (const code of await Promise.all([settle(first, a), settle(second, b)])) {
        if (code === '') committed += 1;
        else codes.push(code);
      }
    } finally {
      await closeRacers(racers);
    }
    return { codes: codes.filter((c) => c !== '').sort(), committed, blocked };
  };

  /** How many rows OCCUPY `resource` at `hhmm`. */
  const held = async (resource: string, hhmm: string): Promise<number> => {
    const r = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM bookings
        WHERE business_id = $1 AND resource_id = $2 AND starts_at = $3::timestamptz
          AND state IN ('booked', 'completed', 'no_show')`,
      [world.businessId, resource, at(hhmm)],
    );
    return r.rows[0]?.n ?? -1;
  };

  /** No resource holds two overlapping rows anywhere — the whole point, re-read from the data. */
  const overlaps = async (): Promise<number> => {
    const r = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM bookings x JOIN bookings y
         ON y.business_id = x.business_id AND y.resource_id = x.resource_id AND y.id <> x.id
        WHERE x.business_id = $1
          AND x.state IN ('booked', 'completed', 'no_show')
          AND y.state IN ('booked', 'completed', 'no_show')
          AND x.blocking_window && y.blocking_window`,
      [world.businessId],
    );
    return r.rows[0]?.n ?? -1;
  };

  it('the lock set is sorted ascending and deduplicated, and the routine reports the order it took', async () => {
    // The subject of PROOF 12, asserted before it is relied on: the routine
    // returns the keys it locked, in acquisition order, so the proof is about
    // a measured order and not about a comment claiming one.
    const want = await expectedOrder();
    expect(want).toHaveLength(2);
    const got = await db.pool.query<{ keys: string[] }>(`SELECT booking_lock_resources($1, $2::uuid[])::text[] AS keys`, [
      world.businessId,
      [world.resourceBId, world.resourceAId],
    ]);
    // Asked for B then A, it still reports A's and B's keys in ASCENDING key
    // order: the order is the routine's, not the caller's.
    expect(got.rows[0]?.keys).toEqual(want);
    const reversed = await db.pool.query<{ keys: string[] }>(`SELECT booking_lock_resources($1, $2::uuid[])::text[] AS keys`, [
      world.businessId,
      [world.resourceAId, world.resourceBId],
    ]);
    expect(reversed.rows[0]?.keys).toEqual(want);
    // Deduplicated: the same resource twice is one lock, not two.
    const deduped = await db.pool.query<{ keys: string[] }>(`SELECT booking_lock_resources($1, $2::uuid[])::text[] AS keys`, [
      world.businessId,
      [world.resourceAId, world.resourceAId, world.resourceAId],
    ]);
    expect(deduped.rows[0]?.keys).toHaveLength(1);
  });

  it('an empty, NULL-holed or businessless lock set is refused rather than locking nothing', async () => {
    // A caller that computed no resources has a bug; returning quietly would
    // let it mutate unserialized, which is the whole failure this suite is
    // about. Each refusal is asserted by NAME, not by "it threw".
    const cases: { params: unknown[]; name: string }[] = [
      { params: [world.businessId, []], name: 'booking.lock_set_invalid' },
      { params: [world.businessId, [world.resourceAId, null]], name: 'booking.lock_set_invalid' },
      { params: [null, [world.resourceAId]], name: 'booking.lock_set_invalid' },
    ];
    for (const { params, name } of cases) {
      let message = '';
      try {
        await db.pool.query(`SELECT booking_lock_resources($1, $2::uuid[])`, params);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain(name);
    }
  });

  it('PROOF 12 — A→B raced against B→A over the SAME hour: no deadlock, and the original state stands (PART 50)', async () => {
    // A true swap, and MEASUREMENT CORRECTED THIS TWICE. The first version
    // expected both sides to commit; the second expected one survivor. Both
    // were wrong, and the server's answer is the interesting one: NEITHER
    // side can commit, because each wants an hour the other has not released
    // and neither can see the other's uncommitted release. Two independent
    // reschedules cannot express a swap at all.
    //
    // That is a correct refusal, not a defect — and it is exactly what PART
    // 50 asks for. No deadlock; one valid final state, which here is the
    // state that was already true. The next proof shows the shape that DOES
    // express a swap.
    const outcome = await crossing('sorted-set', 1200, '09:00');
    expect(outcome.codes).not.toContain('40P01');
    expect(outcome.blocked).toBe(1);
    expect(outcome.committed).toBe(0);
    expect(outcome.codes).toEqual(['23P01', '23P01']);
    // One valid final state: the one that was there before. Each chair still
    // holds its own booking, and neither predecessor was left released with
    // no successor — the refused transitions rolled back with their inserts.
    expect(await held(world.resourceAId, '09:00')).toBe(1);
    expect(await held(world.resourceBId, '09:00')).toBe(1);
    expect(await overlaps()).toBe(0);
    const orphaned = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM bookings a
        WHERE a.business_id = $1 AND a.state = 'rescheduled'
          AND NOT EXISTS (SELECT 1 FROM bookings b
                           WHERE b.business_id = a.business_id AND b.id = a.rescheduled_to_id)`,
      [world.businessId],
    );
    expect(orphaned.rows[0]?.n).toBe(0);
  });

  it('PROOF 12b — a swap IS expressible: one transaction that releases both hours before taking either (PART 50)', async () => {
    // What PROOF 12 found refused is two transactions. One transaction, under
    // the same lock set, performs both transitions and then both inserts, and
    // the exclusion constraint never sees an overlap because by the time the
    // inserts run both predecessors are 'rescheduled' and outside the
    // predicate. This is the shape the command layer must use for a swap, and
    // it is proven here rather than asserted in a comment.
    const onA = uuid(1250);
    const onB = uuid(1251);
    const newOnB = uuid(1252);
    const newOnA = uuid(1253);
    await db.pool.query(INSERT_BOOKING, bookingParams({ world, id: onA, startsAt: at('19:00'), endsAt: at('19:30') }));
    await db.pool.query(INSERT_BOOKING, bookingParams({ world, id: onB, resourceId: world.resourceBId, startsAt: at('19:00'), endsAt: at('19:30') }));
    const client = new Client({ connectionString: db.url('postgres') });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT booking_lock_resources($1, $2::uuid[])`, [world.businessId, [world.resourceAId, world.resourceBId]]);
      for (const [from, to] of [
        [onA, newOnB],
        [onB, newOnA],
      ]) {
        await client.query(
          `UPDATE bookings SET state = 'rescheduled', rescheduled_to_id = $2, settled_at = now(), settled_by_user_id = $3
            WHERE business_id = $4 AND id = $1`,
          [from, to, world.userId, world.businessId],
        );
      }
      for (const [id, resource] of [
        [newOnB, world.resourceBId],
        [newOnA, world.resourceAId],
      ]) {
        await client.query(
          `INSERT INTO bookings (tenant_id, business_id, branch_id, id, kind, resource_id, service_id, customer_id,
                                 starts_at, ends_at, lead_buffer_minutes, trail_buffer_minutes, blocking_window,
                                 state, intent_sha256, created_by_user_id, rescheduled_from_id)
           VALUES ($1, $2, $3, $4, 'appointment', $5, $6, $7, $8::timestamptz, $9::timestamptz, 0, 0,
                   tstzrange($8::timestamptz, $9::timestamptz, '[)'), 'booked', $10, $11, $12)`,
          [
            world.tenantId,
            world.businessId,
            world.branchId,
            id,
            resource,
            world.plainServiceId,
            '00000000-0000-4000-8000-000000000001',
            at('19:00'),
            at('19:30'),
            INTENT,
            world.userId,
            resource === world.resourceBId ? onA : onB,
          ],
        );
      }
      await client.query('COMMIT');
    } finally {
      await client.end().catch(() => undefined);
    }
    // The two customers swapped chairs, each hour is held once, and the
    // predecessors are retained pointing at their successors.
    expect(await held(world.resourceAId, '19:00')).toBe(1);
    expect(await held(world.resourceBId, '19:00')).toBe(1);
    expect(await overlaps()).toBe(0);
    const swapped = await db.pool.query<{ id: string; resource_id: string }>(
      `SELECT id::text, resource_id::text FROM bookings
        WHERE business_id = $1 AND starts_at = $2::timestamptz AND state = 'booked' ORDER BY id`,
      [world.businessId, at('19:00')],
    );
    expect(swapped.rows).toEqual(
      [
        { id: newOnB, resource_id: world.resourceBId },
        { id: newOnA, resource_id: world.resourceAId },
      ].sort((x, y) => (x.id < y.id ? -1 : 1)),
    );
  });

  it('PROOF 13 — two cross-resource reschedules that do NOT contend both commit under the same lock set (PART 50)', async () => {
    // The other half of the law, and the half that makes PROOF 12 mean
    // something: the lock set must serialize without refusing work that was
    // always legal. Same crossing, same two resources, same single lock set —
    // only the target hours differ, so neither side wants what the other
    // holds. Both commit, and one still genuinely waited.
    const outcome = await crossing('sorted-set', 1300, '11:00', '12:00', '12:00');
    expect(outcome.codes).toEqual([]);
    expect(outcome.committed).toBe(2);
    expect(outcome.blocked).toBe(1);
    // The two moved bookings landed on the opposite chairs, an hour later.
    expect(await held(world.resourceAId, '12:00')).toBe(1);
    expect(await held(world.resourceBId, '12:00')).toBe(1);
    // And the two original hours are released, not merely overwritten.
    expect(await held(world.resourceAId, '11:00')).toBe(0);
    expect(await held(world.resourceBId, '11:00')).toBe(0);
    expect(await overlaps()).toBe(0);
  });

  it('CONTROL 7 — under PER-RESOURCE locking the same crossing deadlocks: 40P01 (PART 50)', async () => {
    // The negative control for R-P9-12, with the cycle constructed rather
    // than hoped for: each side holds its source lock before either asks for
    // its target. Nothing else differs from PROOF 13 — the targets do not
    // contend, so there is no legitimate refusal available here and 40P01 is
    // produced purely by the locking discipline. Without this measurement
    // `booking_lock_resources` would be a routine nobody could show was
    // load-bearing.
    const outcome = await crossing('per-resource', 1400, '14:00', '15:00', '15:00');
    expect(outcome.codes).toContain('40P01');
    // PostgreSQL resolves the cycle, so the data is not corrupt: the defect
    // is the error the loser gets, exactly as with R-P9-11. One side survives
    // and the other is killed by the detector.
    expect(outcome.committed).toBe(1);
    expect(await overlaps()).toBe(0);
  });

  it('PROOF 14 — two concurrent retries of ONE caller-supplied operation id produce ONE booking (PART 53)', async () => {
    // The identity is the caller's `operation_id`, not a clock and not a
    // sequence: PART 53 forbids a clock-derived identity precisely because a
    // retry would then be a different operation. Both sides insert the
    // booking AND its registry row in one transaction, which is what makes
    // the registry's primary key the thing that refuses the duplicate.
    const operationId = uuid(1500);
    const racers = await openRacers(db.url('postgres'), 2);
    const codes: string[] = [];
    let committed = 0;
    try {
      const attempt = async (racer: Racer, bookingId: string): Promise<string> => {
        try {
          await racer.client.query(`SELECT booking_lock_resources($1, $2::uuid[])`, [world.businessId, [world.resourceAId]]);
          await racer.client.query(INSERT_BOOKING, bookingParams({ world, id: bookingId, startsAt: at('17:00'), endsAt: at('17:30') }));
          await racer.client.query(INSERT_OPERATION, [world.tenantId, world.businessId, operationId, 'booking.create', INTENT, bookingId, world.userId]);
          return '';
        } catch (e) {
          return sqlState(e);
        }
      };
      const [a, b] = racers;
      if (a === undefined || b === undefined) throw new Error('two racers were asked for');
      const first = attempt(a, uuid(1501));
      const second = attempt(b, uuid(1502));
      const blocked = await awaitBlocked(
        observer,
        racers.map((r) => r.pid),
        1,
      );
      // The retry genuinely contended: it waited on the resource lock. At
      // least one waiter is the law; asserting exactly one would be asserting
      // which side the scheduler happened to start first.
      expect(blocked.length).toBeGreaterThanOrEqual(1);
      // Committed as each side resolves, for the reason `crossing` records:
      // the waiter cannot finish while the winner holds the resource lock.
      const settle = async (racer: Racer, side: Promise<string>): Promise<string> => {
        const code = await side;
        if (code === '') {
          try {
            await racer.client.query('COMMIT');
            return '';
          } catch (e) {
            return sqlState(e);
          }
        }
        await racer.client.query('ROLLBACK').catch(() => undefined);
        return code;
      };
      for (const code of await Promise.all([settle(a, first), settle(b, second)])) {
        if (code === '') committed += 1;
        else codes.push(code);
      }
    } finally {
      await closeRacers(racers);
    }
    // One survived. The other was refused by the registry's own primary key
    // (23505) or by the invariant (23P01) — both are the same answer to the
    // customer, and neither is a second booking.
    expect(committed).toBe(1);
    expect(codes).toHaveLength(1);
    expect(['23505', '23P01']).toContain(codes[0]);
    expect(await held(world.resourceAId, '17:00')).toBe(1);
    expect(await overlaps()).toBe(0);
    const operations = await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM booking_operations WHERE business_id = $1 AND operation_id = $2`, [
      world.businessId,
      operationId,
    ]);
    expect(operations.rows[0]?.n).toBe(1);
  });

  /**
   * PART 53, as the Mission corrected it: «قيد التفرّد المانع للتكرار وحده
   * ليس برهان نجاح replay» — the uniqueness constraint alone is not proof
   * that a replay succeeds; the recorded result must be RETURNED. PROOF 14
   * above proves only the first half, that a second attempt cannot produce
   * a second booking. The caller holding that refusal still has no booking
   * id, and which SQLSTATE it received is an accident of which constraint
   * its statements reached first — 23P01 when it re-sent the whole booking,
   * 23505 when only the registry row was left to refuse it. Both are
   * measured below, and both are answered from the same recorded row.
   */
  it('PROOF 15 — a refused retry is ANSWERED FROM THE RECORD: the replay returns the first attempt’s booking (PART 53, R-P9-14)', async () => {
    const operationId = uuid(1600);
    const winner = uuid(1601);
    const resent = uuid(1602);
    const c = new Client({ connectionString: db.url('postgres') });
    await c.connect();
    // The replay lookup enforces the caller's business scope itself, so the
    // scope is set here as a command would set it.
    await c.query(`SELECT set_config('app.tenant_id', $1, false), set_config('app.business_id', $2, false)`, [world.tenantId, world.businessId]);
    const replay = async (
      opCode = 'booking.create',
      intent = INTENT,
    ): Promise<{ o_replay: boolean; o_booking_id: string | null; o_recorded_at: Date | null }> => {
      const r = await c.query<{ o_replay: boolean; o_booking_id: string | null; o_recorded_at: Date | null }>(
        `SELECT o_replay, o_booking_id, o_recorded_at FROM booking_replay_result($1, $2, $3, $4)`,
        [world.businessId, operationId, opCode, intent],
      );
      const row = r.rows[0];
      if (row === undefined) throw new Error('booking_replay_result returned no row');
      return row;
    };
    try {
      // The key is UNUSED first, and the routine says so without inventing
      // anything. Asserted before the write, or "the record was returned"
      // could be read off a row some earlier case in this file left behind.
      const before = await replay();
      expect(before.o_replay).toBe(false);
      expect(before.o_booking_id).toBeNull();
      expect(before.o_recorded_at).toBeNull();

      // The first attempt: the booking and its registry row, one transaction.
      await c.query('BEGIN');
      await c.query(INSERT_BOOKING, bookingParams({ world, id: winner, startsAt: at('18:00'), endsAt: at('18:30') }));
      await c.query(INSERT_OPERATION, [world.tenantId, world.businessId, operationId, 'booking.create', INTENT, winner, world.userId]);
      await c.query('COMMIT');

      // Retry (a): the client re-sends its whole request, as a client whose
      // connection dropped before the response does. The invariant refuses
      // it, because the slot the first attempt took is the slot it asks for.
      let resentCode = '';
      await c.query('BEGIN');
      try {
        await c.query(INSERT_BOOKING, bookingParams({ world, id: resent, startsAt: at('18:00'), endsAt: at('18:30') }));
        await c.query(INSERT_OPERATION, [world.tenantId, world.businessId, operationId, 'booking.create', INTENT, resent, world.userId]);
        await c.query('COMMIT');
      } catch (e) {
        resentCode = sqlState(e);
        await c.query('ROLLBACK').catch(() => undefined);
      }
      expect(resentCode).toBe('23P01');
      // Nothing of the retry survived: the id it minted is not a booking.
      const ghost = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM bookings WHERE business_id = $1 AND id = $2`, [world.businessId, resent]);
      expect(ghost.rows[0]?.n).toBe(0);

      // Retry (b): the same key where ONLY the registry can refuse it —
      // the registry row alone, naming the booking that already stands.
      let keyCode = '';
      try {
        await c.query(INSERT_OPERATION, [world.tenantId, world.businessId, operationId, 'booking.create', INTENT, winner, world.userId]);
      } catch (e) {
        keyCode = sqlState(e);
      }
      expect(keyCode).toBe('23505');

      // THE POINT. Neither refusal is an answer; this is the answer, and it
      // is the booking the FIRST attempt produced, not the id either retry
      // minted and not "whatever is true now".
      const answer = await replay();
      expect(answer.o_replay).toBe(true);
      expect(answer.o_booking_id).toBe(winner);
      expect(answer.o_booking_id).not.toBe(resent);
      expect(answer.o_recorded_at).toBeInstanceOf(Date);

      // And the booking it names really stands, on the resource and at the
      // instant that were asked for. A replay that returned a dangling id
      // would be a worse failure than the refusal it replaces.
      const standing = await c.query<{ state: string; resource_id: string; starts_at: Date }>(
        `SELECT state, resource_id, starts_at FROM bookings WHERE business_id = $1 AND id = $2`,
        [world.businessId, answer.o_booking_id],
      );
      expect(standing.rows[0]?.state).toBe('booked');
      expect(standing.rows[0]?.resource_id).toBe(world.resourceAId);
      expect(standing.rows[0]?.starts_at.toISOString()).toBe(new Date(at('18:00')).toISOString());

      // The replay is itself idempotent: asked twice, byte-for-byte the same
      // answer, including the instant the record was written.
      const again = await replay();
      expect(again.o_booking_id).toBe(winner);
      expect(again.o_recorded_at?.getTime()).toBe(answer.o_recorded_at?.getTime());

      // Exactly one row carries the key, and exactly one booking stands.
      const rows = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM booking_operations WHERE business_id = $1 AND operation_id = $2`, [
        world.businessId,
        operationId,
      ]);
      expect(rows.rows[0]?.n).toBe(1);
      expect(await held(world.resourceAId, '18:00')).toBe(1);
      expect(await overlaps()).toBe(0);
    } finally {
      await c.end().catch(() => undefined);
    }
  });

  it('PROOF 16 — a key replayed over a DIFFERENT request is refused, never answered with the stored row (R-P9-14)', async () => {
    const operationId = uuid(1700);
    const booking = uuid(1701);
    const otherIntent = `${'f'.repeat(63)}0`;
    const c = new Client({ connectionString: db.url('postgres') });
    await c.connect();
    // The replay lookup enforces the caller's business scope itself, so the
    // scope is set here as a command would set it.
    await c.query(`SELECT set_config('app.tenant_id', $1, false), set_config('app.business_id', $2, false)`, [world.tenantId, world.businessId]);
    try {
      await c.query('BEGIN');
      // 20:00: an hour no other case in this file touches. 19:00 was taken
      // by PROOF 13, and the exclusion constraint said so.
      await c.query(INSERT_BOOKING, bookingParams({ world, id: booking, startsAt: at('20:00'), endsAt: at('20:30') }));
      await c.query(INSERT_OPERATION, [world.tenantId, world.businessId, operationId, 'booking.create', INTENT, booking, world.userId]);
      await c.query('COMMIT');
      // The subject exists and the HONEST replay works, or the three
      // refusals below would prove nothing about this key.
      const ok = await c.query<{ o_booking_id: string }>(`SELECT o_booking_id FROM booking_replay_result($1, $2, 'booking.create', $3)`, [
        world.businessId,
        operationId,
        INTENT,
      ]);
      expect(ok.rows[0]?.o_booking_id).toBe(booking);
      // The two digests really differ, or the intent case would be vacuous.
      expect(otherIntent).not.toBe(INTENT);

      const refusals: { params: unknown[]; name: string }[] = [
        { params: [world.businessId, operationId, 'booking.cancel', INTENT], name: 'booking.operation_conflict' },
        { params: [world.businessId, operationId, 'booking.create', otherIntent], name: 'booking.operation_intent_conflict' },
        { params: [null, operationId, 'booking.create', INTENT], name: 'booking.replay_lookup_invalid' },
        { params: [world.businessId, null, 'booking.create', INTENT], name: 'booking.replay_lookup_invalid' },
        { params: [world.businessId, operationId, 'booking.create', null], name: 'booking.replay_lookup_invalid' },
      ];
      for (const refusal of refusals) {
        let message = '';
        try {
          await c.query(`SELECT * FROM booking_replay_result($1, $2, $3, $4)`, refusal.params);
        } catch (e) {
          message = e instanceof Error ? e.message : String(e);
        }
        expect(message, `${refusal.name} was not raised`).toContain(refusal.name);
      }
      // An unknown key is NOT one of those refusals: it is a first attempt.
      const fresh = await c.query<{ o_replay: boolean }>(`SELECT o_replay FROM booking_replay_result($1, $2, 'booking.create', $3)`, [
        world.businessId,
        uuid(1702),
        INTENT,
      ]);
      expect(fresh.rows[0]?.o_replay).toBe(false);
    } finally {
      await c.end().catch(() => undefined);
    }
  });

  it('the operation registry is append-only: a recorded operation cannot be rewritten or removed (PART 53)', async () => {
    const row = await db.pool.query<{ operation_id: string }>(`SELECT operation_id FROM booking_operations WHERE business_id = $1 LIMIT 1`, [world.businessId]);
    const operationId = row.rows[0]?.operation_id;
    // The subject must exist, or both refusals below would be vacuous.
    expect(operationId).toBeTruthy();
    for (const sql of [
      `UPDATE booking_operations SET op_code = 'booking.tamper' WHERE business_id = $1 AND operation_id = $2`,
      `DELETE FROM booking_operations WHERE business_id = $1 AND operation_id = $2`,
    ]) {
      let message = '';
      try {
        await db.pool.query(sql, [world.businessId, operationId]);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain('booking.operation_registry_immutable');
    }
  });
});
