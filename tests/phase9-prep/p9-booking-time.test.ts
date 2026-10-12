/**
 * P9 PREP — THE TIMEZONE / DST LAW (directive #11 PART 51).
 *
 * Storage is canonical instants and the invariant compares instants, which is
 * why the concurrency suite's timezone proof holds across five zones. The
 * question PART 51 asks is different and comes one step earlier: a merchant
 * says "Tuesday at 9" in the resource's own timezone, and twice a year that
 * sentence is either meaningless or ambiguous.
 *
 * PostgreSQL's own `AT TIME ZONE` answers both silently. CONTROL T1 and T2
 * below MEASURE that it does — they are the negative controls for the whole
 * law, and without them `booking_resolve_local` would be a routine nobody
 * could show was necessary.
 *
 * The zones are chosen to cover the two shift sizes that exist:
 * America/New_York moves by one hour, Australia/Lord_Howe by thirty minutes.
 * A law proven only on hour-shifting zones would be a law with a hole in it.
 *
 * Status: PREPARED / NOT PROMOTED. Not part of required CI.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { ScratchDb } from '../helpers/scratch-db';
import { createScratchDb } from '../helpers/scratch-db';
import { BASE_HEAD, BOOTSTRAP_PATCH } from './p9-booking-spec';
import { applySpecAsMigrator } from './p9-booking-world';

/**
 * The four moments the law is about, with the transition each one sits in.
 * Verified against the server's own tz database in the first case below, so a
 * tz update that moved a rule would red this suite rather than silently
 * turning its proofs vacuous.
 */
const SPRING_FORWARD_NY = { zone: 'America/New_York', local: '2026-03-08 02:30' };
const FALL_BACK_NY = { zone: 'America/New_York', local: '2026-11-01 01:30' };
const SPRING_FORWARD_LHI = { zone: 'Australia/Lord_Howe', local: '2026-10-04 02:15' };
const FALL_BACK_LHI = { zone: 'Australia/Lord_Howe', local: '2026-04-05 01:45' };
const ORDINARY_NY = { zone: 'America/New_York', local: '2026-06-15 10:00' };

describe('P9 bookings — a local time is resolved or refused, never guessed', () => {
  let db: ScratchDb;

  beforeAll(async () => {
    db = await createScratchDb('daftar_p9_time', { upTo: BASE_HEAD, keys: false, migratorOwned: true });
    await db.pool.query(BOOTSTRAP_PATCH);
    await applySpecAsMigrator(db);
  }, 600_000);

  afterAll(async () => {
    await db?.drop();
  });

  /** How many instants map back to this wall clock in this zone: 0, 1 or more. */
  const occurrences = async (zone: string, local: string): Promise<number> => {
    const r = await db.pool.query<{ n: number }>(
      `WITH base AS (SELECT ($2::timestamp AT TIME ZONE $1) AS i)
       SELECT count(*)::int AS n FROM base, generate_series(-180, 180, 1) AS k
        WHERE ((i + make_interval(mins => k)) AT TIME ZONE $1) = $2::timestamp`,
      [zone, local],
    );
    return r.rows[0]?.n ?? -1;
  };

  const resolve = async (zone: string, local: string, offset: string | null = null): Promise<{ instant: string; error: string }> => {
    try {
      const r = await db.pool.query<{ i: string }>(`SELECT booking_resolve_local($1, $2::timestamp, $3::interval) AS i`, [zone, local, offset]);
      return { instant: r.rows[0]?.i ?? '', error: '' };
    } catch (e) {
      return { instant: '', error: (e as Error).message };
    }
  };

  it('the subjects exist: the server tz database still says these four moments are what the law is about', async () => {
    // PROOF-OF-PROOF (PART 17). Every case below depends on these counts; a
    // tz update that moved a transition would make them vacuous, so they are
    // asserted from the server rather than trusted from the constant names.
    expect(await occurrences(SPRING_FORWARD_NY.zone, SPRING_FORWARD_NY.local)).toBe(0);
    expect(await occurrences(SPRING_FORWARD_LHI.zone, SPRING_FORWARD_LHI.local)).toBe(0);
    expect(await occurrences(FALL_BACK_NY.zone, FALL_BACK_NY.local)).toBe(2);
    expect(await occurrences(FALL_BACK_LHI.zone, FALL_BACK_LHI.local)).toBe(2);
    expect(await occurrences(ORDINARY_NY.zone, ORDINARY_NY.local)).toBe(1);
  });

  it('CONTROL T1 — PostgreSQL silently answers a local time that does not exist (PART 51)', async () => {
    // The defect the law prevents, measured. 02:30 on the morning the clock
    // jumped from 02:00 to 03:00 never happened, and `AT TIME ZONE` returns
    // an instant anyway — one whose local time is 03:30, an hour the caller
    // never asked for. A booking accepted here has silently moved.
    const r = await db.pool.query<{ i: string; back: string }>(
      `SELECT ($2::timestamp AT TIME ZONE $1) AS i,
              (($2::timestamp AT TIME ZONE $1) AT TIME ZONE $1)::text AS back`,
      [SPRING_FORWARD_NY.zone, SPRING_FORWARD_NY.local],
    );
    expect(r.rows[0]?.i).toBeTruthy();
    expect(r.rows[0]?.back).toBe('2026-03-08 03:30:00');
    expect(r.rows[0]?.back).not.toBe('2026-03-08 02:30:00');
  });

  it('CONTROL T2 — PostgreSQL silently picks ONE of two occurrences of an ambiguous local time (PART 51)', async () => {
    // 01:30 on the morning the clock fell back from 02:00 to 01:00 happens
    // twice, an hour apart. `AT TIME ZONE` returns one of them with nothing
    // to say that it chose, which is the "never silently choose" PART 51
    // forbids. Both candidates are shown, so the choice is visible.
    const r = await db.pool.query<{ naive: string; candidates: string[] }>(
      `WITH base AS (SELECT ($2::timestamp AT TIME ZONE $1) AS i),
       cands AS (SELECT (i + make_interval(mins => k)) AS c FROM base, generate_series(-180, 180, 1) AS k
                  WHERE ((i + make_interval(mins => k)) AT TIME ZONE $1) = $2::timestamp)
       SELECT (SELECT to_char(i AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') FROM base) AS naive,
              array_agg(to_char(c AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') ORDER BY c) AS candidates
         FROM cands`,
      [FALL_BACK_NY.zone, FALL_BACK_NY.local],
    );
    expect(r.rows[0]?.candidates).toEqual(['2026-11-01 05:30', '2026-11-01 06:30']);
    // And the naive answer is one of them, chosen for the caller.
    expect(r.rows[0]?.candidates).toContain(r.rows[0]?.naive);
  });

  it('a local time that does not exist is REFUSED, in both shift sizes (PART 51)', async () => {
    for (const c of [SPRING_FORWARD_NY, SPRING_FORWARD_LHI]) {
      const r = await resolve(c.zone, c.local);
      expect(r.error).toContain('booking.local_time_nonexistent');
      expect(r.error).toContain(c.zone);
      expect(r.instant).toBe('');
    }
  });

  it('an ambiguous local time is REFUSED unless the caller states the offset, in both shift sizes (PART 51)', async () => {
    for (const c of [FALL_BACK_NY, FALL_BACK_LHI]) {
      const r = await resolve(c.zone, c.local);
      expect(r.error).toContain('booking.local_time_ambiguous');
      // The refusal names the offsets to choose between, or the caller cannot
      // act on it.
      expect(r.error).toMatch(/offsets .*:/);
      expect(r.instant).toBe('');
    }
  });

  it('an ambiguous local time resolves to EITHER occurrence, as the stated offset decides (PART 51)', async () => {
    // Not "the first" and not "the second": the one the caller said. Both are
    // reachable, and they are an hour apart in New York and thirty minutes
    // apart on Lord Howe.
    const early = await resolve(FALL_BACK_NY.zone, FALL_BACK_NY.local, '-04:00');
    const late = await resolve(FALL_BACK_NY.zone, FALL_BACK_NY.local, '-05:00');
    expect(early.error).toBe('');
    expect(late.error).toBe('');
    expect(new Date(late.instant).getTime() - new Date(early.instant).getTime()).toBe(3_600_000);

    const lhiEarly = await resolve(FALL_BACK_LHI.zone, FALL_BACK_LHI.local, '11:00');
    const lhiLate = await resolve(FALL_BACK_LHI.zone, FALL_BACK_LHI.local, '10:30');
    expect(lhiEarly.error).toBe('');
    expect(lhiLate.error).toBe('');
    expect(new Date(lhiLate.instant).getTime() - new Date(lhiEarly.instant).getTime()).toBe(1_800_000);
  });

  it('an offset that is not one of the occurrences is REFUSED, not rounded to the nearest (PART 51)', async () => {
    const r = await resolve(FALL_BACK_NY.zone, FALL_BACK_NY.local, '-06:00');
    expect(r.error).toContain('booking.local_time_offset_mismatch');
    expect(r.instant).toBe('');
  });

  it('a stated offset is CHECKED even when there is nothing to disambiguate (PART 51)', async () => {
    // An unambiguous local time with the wrong offset is a caller who has a
    // different booking in mind, and accepting it would store an hour nobody
    // asked for. The right offset is accepted.
    const wrong = await resolve(ORDINARY_NY.zone, ORDINARY_NY.local, '-05:00');
    expect(wrong.error).toContain('booking.local_time_offset_mismatch');
    const right = await resolve(ORDINARY_NY.zone, ORDINARY_NY.local, '-04:00');
    expect(right.error).toBe('');
    expect(new Date(right.instant).toISOString()).toBe('2026-06-15T14:00:00.000Z');
  });

  it('an ordinary local time resolves to the instant the booking is stored at (PART 51)', async () => {
    const r = await resolve(ORDINARY_NY.zone, ORDINARY_NY.local);
    expect(r.error).toBe('');
    expect(new Date(r.instant).toISOString()).toBe('2026-06-15T14:00:00.000Z');
  });

  it('a cross-midnight local time is resolved explicitly, on the civil day the caller named (PART 51)', async () => {
    // PART 51 asks that cross-midnight schedules be explicit. The resolver
    // takes a full wall-clock timestamp, never a date plus a time that could
    // be read as either day, so 23:30 on one day and 00:30 on the next are
    // different inputs and the hour between them is one hour.
    const before = await resolve('Asia/Hebron', '2026-06-15 23:30');
    const after = await resolve('Asia/Hebron', '2026-06-16 00:30');
    expect(before.error).toBe('');
    expect(after.error).toBe('');
    expect(new Date(after.instant).getTime() - new Date(before.instant).getTime()).toBe(3_600_000);
  });

  it('an unknown zone is refused BY NAME, not by whatever PostgreSQL happens to say (PART 51)', async () => {
    const r = await resolve('Mars/Olympus_Mons', ORDINARY_NY.local);
    expect(r.error).toContain('booking.timezone_unknown');
    expect(r.error).toContain('Mars/Olympus_Mons');
  });

  it('a missing zone or wall clock is refused rather than defaulted', async () => {
    for (const [zone, local] of [
      [null, ORDINARY_NY.local],
      [ORDINARY_NY.zone, null],
    ] as const) {
      let error = '';
      try {
        await db.pool.query(`SELECT booking_resolve_local($1, $2::timestamp, NULL) AS i`, [zone, local]);
      } catch (e) {
        error = (e as Error).message;
      }
      expect(error).toContain('booking.local_time_unresolvable');
    }
  });

  it('the resolver is STABLE, so it can never be folded into an index or a generated column', async () => {
    // R-P9-13's own guard. The tz database is DATA: an IMMUTABLE resolver
    // could be built into an index that then outlived the next tz update,
    // which is R-P9-03's lesson in a second place.
    const r = await db.pool.query<{ v: string }>(`SELECT provolatile::text AS v FROM pg_proc WHERE proname = 'booking_resolve_local'`);
    expect(r.rows[0]?.v).toBe('s');
    let error = '';
    try {
      await db.pool.query(`CREATE INDEX p9_tz_folly ON bookings ((booking_resolve_local('UTC', starts_at::timestamp, NULL)))`);
    } catch (e) {
      error = (e as Error).message;
    }
    // PostgreSQL refuses it itself, which is the point of the volatility.
    expect(error).toContain('functions in index expression must be marked IMMUTABLE');
  });
});
