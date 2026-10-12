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
import { Client } from 'pg';
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

interface Sweep {
  zones: number;
  steps: number;
  widest_gap: number;
  widest_repeat: number;
  repeat_zone: string;
}

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

  it('SOUNDNESS, swept: every instant the resolver returns maps back to the wall clock asked for', async () => {
    // "13 حالة لا تثبت كل تاريخ وكل منطقة" — thirteen cases do not prove every
    // date in every zone. This case does not claim to either, but it widens
    // the ground enormously and it checks the one property that matters most:
    // the resolver is never SILENTLY WRONG.
    //
    // Over five zones and every minute of each zone's 2026 transition days,
    // plus a fortnight of ordinary days, each local time is either refused or
    // resolved — and every resolution is checked by mapping the returned
    // instant BACK into the zone and comparing it to the request. That oracle
    // is the round trip, which is independent of the candidate counting the
    // resolver decides by, so this is not the algorithm compared to itself
    // (PART 17).
    //
    // PostgreSQL's own `AT TIME ZONE` FAILS this property, on exactly the
    // inputs CONTROL T1 is about, which is what makes passing it meaningful.
    // One dedicated connection: the loop writes its counts into a TEMP table,
    // which only exists on the session that made it, so a pooled connection
    // could issue the SELECT on a different backend and find nothing.
    const client = new Client({ connectionString: db.url('postgres') });
    await client.connect();
    let row: { swept: number; resolved: number; refused: number; wrong: number } | undefined;
    try {
      await client.query(`
        DO $$
        DECLARE
          v_rec RECORD; v_i TIMESTAMPTZ;
          v_swept INT := 0; v_res INT := 0; v_ref INT := 0; v_wrong INT := 0;
        BEGIN
          FOR v_rec IN
            WITH days AS (
              SELECT * FROM (VALUES
                ('America/New_York', DATE '2026-03-08'), ('America/New_York', DATE '2026-11-01'),
                ('Australia/Lord_Howe', DATE '2026-10-04'), ('Australia/Lord_Howe', DATE '2026-04-05'),
                ('Pacific/Chatham', DATE '2026-09-27'), ('Pacific/Chatham', DATE '2026-04-05'),
                ('Asia/Hebron', DATE '2026-03-21'), ('Asia/Hebron', DATE '2026-10-24'),
                ('Europe/Istanbul', DATE '2026-03-29'), ('Europe/Istanbul', DATE '2026-10-25')
              ) AS t(zone, on_date)
            )
            SELECT d.zone AS zone, (d.on_date + make_interval(mins => m))::timestamp AS local
              FROM days d, generate_series(0, 1439, 1) AS m
             UNION ALL
            SELECT 'America/New_York', (DATE '2026-06-01' + make_interval(mins => m * 7))::timestamp
              FROM generate_series(0, 2879, 1) AS m
          LOOP
            v_swept := v_swept + 1;
            BEGIN
              v_i := booking_resolve_local(v_rec.zone, v_rec.local, NULL);
              v_res := v_res + 1;
              -- THE INDEPENDENT ORACLE: the returned instant must map back to
              -- the wall clock that was asked for. Nothing else is acceptable.
              IF (v_i AT TIME ZONE v_rec.zone) <> v_rec.local THEN
                v_wrong := v_wrong + 1;
              END IF;
            EXCEPTION WHEN SQLSTATE 'P0001' THEN
              v_ref := v_ref + 1;
            END;
          END LOOP;
          CREATE TEMP TABLE p9_sweep AS SELECT v_swept AS swept, v_res AS resolved, v_ref AS refused, v_wrong AS wrong;
        END $$`);
      const verdict = await client.query<{ swept: number; resolved: number; refused: number; wrong: number }>(
        `SELECT swept, resolved, refused, wrong FROM p9_sweep`,
      );
      row = verdict.rows[0];
    } finally {
      await client.end().catch(() => undefined);
    }
    expect(row).toBeDefined();
    // Not vacuous: thousands of inputs, and BOTH outcomes actually occurred.
    expect(row?.swept).toBeGreaterThan(14000);
    expect(row?.resolved).toBeGreaterThan(14000 - 400);
    expect(row?.refused).toBeGreaterThan(0);
    // And not one silently wrong answer anywhere in the sweep.
    expect(row?.wrong).toBe(0);
  });

  it('and PostgreSQL’s own AT TIME ZONE FAILS that same soundness sweep, which is why the resolver exists', async () => {
    // The control for the case above. Same inputs, same oracle, the naive
    // expression instead of the resolver: it returns an instant for every
    // input and some of those instants map back to a different wall clock.
    const r = await db.pool.query<{ swept: number; wrong: number }>(`
      WITH days AS (
        SELECT * FROM (VALUES
          ('America/New_York', DATE '2026-03-08'), ('Australia/Lord_Howe', DATE '2026-10-04'),
          ('Pacific/Chatham', DATE '2026-09-27'), ('Asia/Hebron', DATE '2026-03-21'),
          ('Europe/Istanbul', DATE '2026-03-29')
        ) AS t(zone, on_date)
      ),
      locals AS (
        SELECT d.zone AS zone, (d.on_date + make_interval(mins => m))::timestamp AS local
          FROM days d, generate_series(0, 1439, 1) AS m
      )
      SELECT count(*)::int AS swept,
             count(*) FILTER (WHERE ((local AT TIME ZONE zone) AT TIME ZONE zone) <> local)::int AS wrong
        FROM locals`);
    expect(r.rows[0]?.swept).toBe(7200);
    // Every zone's spring-forward gap is an hour or less, so the count is
    // bounded — but it is not zero, and each one is a booking silently moved.
    expect(r.rows[0]?.wrong).toBeGreaterThan(0);
  });

  it('OUTSIDE THE SCOPE: a non-finite wall clock is refused by its own name, not reported as ambiguous', async () => {
    // Found while writing the scope the Mission asked for. Infinity survives
    // every step of the resolver — adding an interval leaves it infinite and
    // mapping it through a zone returns it unchanged — so the candidate scan
    // found all 361 offsets matching and the routine reported an AMBIGUOUS
    // local time. Nothing unsafe happened, but the refusal said something
    // false about why, and a caller cannot act on that.
    for (const local of ['infinity', '-infinity']) {
      const r = await resolve(ORDINARY_NY.zone, local);
      expect(r.error).toContain('booking.local_time_not_finite');
      expect(r.error).not.toContain('ambiguous');
      expect(r.instant).toBe('');
    }
  });

  /**
   * V2 of the Mission asks for the resolver's bound to be checked against the
   * LAWFUL IANA transition, not only against the four moments this suite
   * names: «تحقق من حدود resolver الفعلية ومن انتقال IANA القانوني المسموح»,
   * and «لا تبق عبارة شمول قديمة أوسع من الدليل» — leave no claim wider than
   * its evidence.
   *
   * So the bound is measured against the tz database this server carries, over
   * every zone it knows. The oracle is the offset itself — `ts AT TIME ZONE z`
   * minus `ts AT TIME ZONE 'UTC'` — and the quantity is the change between
   * consecutive samples, which IS a transition's magnitude. The two directions
   * are reported separately because they fail differently:
   *
   *   offset INCREASES → the clock skips → a gap. The resolver finds no
   *                      candidate and refuses. Outside the bound it still
   *                      refuses, so the failure is safe.
   *   offset DECREASES → the clock repeats → an ambiguity. This is the one
   *                      that matters: a repeat WIDER than the ±180 scan would
   *                      be seen as unambiguous and resolved silently, which
   *                      is exactly what R-P9-13 forbids.
   *
   * A sample window wide enough to hold two transitions reports their sum,
   * which can only overstate a single transition — the conservative direction.
   */
  it('the ±1440-minute scan covers every transition in the supported range, measured in both directions', async () => {
    const c = new Client({ connectionString: db.url('postgres') });
    await c.connect();
    try {
      const sweep = async (from: string, to: string, step: string): Promise<Sweep> => {
        const r = await c.query<Sweep>(
          `WITH z AS (
             SELECT name FROM pg_timezone_names
              WHERE name NOT LIKE 'posix/%' AND name NOT LIKE 'right/%'
           ), t AS (
             SELECT generate_series($1::timestamptz, $2::timestamptz, $3::interval) AS ts
           ), o AS (
             SELECT z.name, t.ts, (t.ts AT TIME ZONE z.name) - (t.ts AT TIME ZONE 'UTC') AS off
               FROM z CROSS JOIN t
           ), d AS (
             SELECT name,
                    extract(epoch FROM (off - lag(off) OVER (PARTITION BY name ORDER BY ts))) / 60 AS jump
               FROM o
           )
           SELECT (SELECT count(DISTINCT name)::int FROM z) AS zones,
                  (SELECT count(*)::int FROM t)             AS steps,
                  coalesce(max(jump) FILTER (WHERE jump > 0), 0)::int        AS widest_gap,
                  coalesce(-min(jump) FILTER (WHERE jump < 0), 0)::int       AS widest_repeat,
                  coalesce((SELECT name FROM d WHERE jump = (SELECT min(jump) FROM d) LIMIT 1), '') AS repeat_zone
             FROM d`,
          [from, to, step],
        );
        const row = r.rows[0];
        if (row === undefined) throw new Error('the tz sweep returned no row');
        return row;
      };

      // Near term, finely: every zone, six years, twelve-hour samples. This is
      // the window bookings are actually placed in.
      const near = await sweep('2024-01-01T00:00:00Z', '2030-01-01T00:00:00Z', '12 hours');
      expect(near.zones).toBeGreaterThan(400);
      expect(near.steps).toBeGreaterThan(4000);
      // Non-vacuous: transitions were seen. A zero maximum would mean the
      // sweep measured nothing, and the bound would be unproven, not proven.
      expect(near.widest_gap).toBeGreaterThan(0);
      expect(near.widest_repeat).toBeGreaterThan(0);
      // THE LAW: no repeat in this window is wider than the scan, so no
      // ambiguous wall clock in it can be resolved silently.
      expect(near.widest_repeat).toBeLessThanOrEqual(180);
      expect(near.widest_gap).toBeLessThanOrEqual(180);

      // Long range, coarsely: 1970 to 2040 in seven-day samples.
      const far = await sweep('1970-01-01T00:00:00Z', '2100-01-01T00:00:00Z', '7 days');
      expect(far.zones).toBeGreaterThan(400);
      expect(far.steps).toBeGreaterThan(3000);
      // THE BOUND THE SCAN ACTUALLY USES, over the whole supported range:
      // ±1440 minutes. This is the assertion that would red if a tz update
      // ever moved a clock further than the scan can see — which is the only
      // honest way to hold a claim about data that updates.
      expect(far.widest_gap).toBeLessThanOrEqual(1440);
      expect(far.widest_repeat).toBeLessThanOrEqual(1440);
      // And it is NOT inside the old ±180: that is why the scan was widened,
      // and this is the measurement that forced it.
      expect(far.widest_gap).toBeGreaterThan(180);
      expect(far.widest_repeat).toBeGreaterThan(180);
      console.log(
        `[P9 tz bound] 2024-2030: gap ${near.widest_gap} min, repeat ${near.widest_repeat} min (${near.repeat_zone}), ${near.zones} zones × ${near.steps} samples. ` +
          `1970-2100: gap ${far.widest_gap} min, repeat ${far.widest_repeat} min (${far.repeat_zone}).`,
      );
    } finally {
      await c.end().catch(() => undefined);
    }
  }, 600_000);

  it('OUTSIDE THE BOUND, the unsafe direction is stated rather than hidden: a wide gap still REFUSES', async () => {
    // Kwajalein crossed the date line on 1993-08-21 and skipped the day
    // entirely — a 1440-minute transition, far outside the ±180 scan. The
    // scan's failure mode in the skipping direction is to find no candidate,
    // which is a refusal: the safe side of the bound, and the same answer a
    // scan wide enough to see the whole move would give.
    const r = await resolve('Pacific/Kwajalein', '1993-08-21 10:00');
    expect(r.error).toContain('booking.local_time_nonexistent');
    expect(r.instant).toBe('');
    // And a wall clock on either side of that move resolves normally, because
    // PostgreSQL's own conversion is the centre of the scan and is correct
    // there — the bound is a radius around a right answer, not a window on
    // absolute time.
    for (const local of ['1993-08-20 10:00', '1993-08-22 10:00']) {
      const ok = await resolve('Pacific/Kwajalein', local);
      expect(ok.error).toBe('');
      expect(ok.instant).not.toBe('');
    }
  });

  /**
   * V3 of the Mission: «قد ينتقي occurrence في تكرار تاريخي أطول (مثل 420
   * دقيقة). حدد نطاق التاريخ الذي تدعمه فعليًا بحارس منفذ واختبارات ضمنه» —
   * the ±180 window may pick an occurrence inside a longer historical repeat;
   * declare the supported date range with an ENFORCED guard and tests inside
   * it, and fix the claim or the algorithm to match the usage scope.
   *
   * Both were wrong, and both are fixed rather than declared away. These cases
   * prove the fix against a COPY of each old scan, created in this scratch
   * database — never against the document, which no proof here mutates.
   */
  describe('the two defects V3 named, each proved against a copy of the old scan', () => {
    /** The old ±180 minute-stepped scan, as a scratch routine beside the real one. */
    const OLD_SCAN = `
      CREATE OR REPLACE FUNCTION p9_resolve_old(p_zone TEXT, p_local TIMESTAMP) RETURNS TIMESTAMPTZ
      LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $fn$
      DECLARE v_naive TIMESTAMPTZ; v_cands TIMESTAMPTZ[]; v_n INTEGER;
      BEGIN
        v_naive := p_local AT TIME ZONE p_zone;
        SELECT array_agg(c ORDER BY c) INTO v_cands
          FROM (SELECT (v_naive + make_interval(mins => k)) AS c
                  FROM generate_series(-180, 180, 1) AS k
                 WHERE ((v_naive + make_interval(mins => k)) AT TIME ZONE p_zone) = p_local) AS s;
        v_n := coalesce(cardinality(v_cands), 0);
        IF v_n = 0 THEN RAISE EXCEPTION 'old.nonexistent' USING ERRCODE = 'P0001'; END IF;
        IF v_n = 1 THEN RETURN v_cands[1]; END IF;
        RAISE EXCEPTION 'old.ambiguous' USING ERRCODE = 'P0001';
      END $fn$;`;

    beforeAll(async () => {
      await db.pool.query(OLD_SCAN);
    });

    const old = async (zone: string, local: string): Promise<{ instant: string; error: string }> => {
      try {
        const r = await db.pool.query<{ i: string }>(`SELECT p9_resolve_old($1, $2::timestamp)::text AS i`, [zone, local]);
        return { instant: r.rows[0]?.i ?? '', error: '' };
      } catch (e) {
        return { instant: '', error: (e as Error).message };
      }
    };

    it('DEFECT 1 — a 420-minute repeat: the old ±180 scan RESOLVES IT SILENTLY, the current one refuses it', async () => {
      // Antarctica/Vostok went from +07:00 to +00:00 at 1994-01-31 17:00Z —
      // measured from this server, not recalled — so the seven wall-clock
      // hours before midnight occur twice. The subject is asserted first.
      const shift = await db.pool.query<{ before: string; after: string }>(
        `SELECT (('1994-01-31 16:00:00Z'::timestamptz AT TIME ZONE 'Antarctica/Vostok') - ('1994-01-31 16:00:00Z'::timestamptz AT TIME ZONE 'UTC'))::text AS before,
                (('1994-01-31 18:00:00Z'::timestamptz AT TIME ZONE 'Antarctica/Vostok') - ('1994-01-31 18:00:00Z'::timestamptz AT TIME ZONE 'UTC'))::text AS after`,
      );
      expect(shift.rows[0]?.before).toBe('07:00:00');
      expect(shift.rows[0]?.after).toBe('00:00:00');

      const repeated = '1994-01-31 20:00:00';
      // There really are two instants for that wall clock.
      const n = await db.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM generate_series('1994-01-31Z'::timestamptz, '1994-02-02Z'::timestamptz, '1 minute'::interval) AS ts
          WHERE (ts AT TIME ZONE 'Antarctica/Vostok') = $1::timestamp`,
        [repeated],
      );
      expect(n.rows[0]?.n).toBe(2);

      // THE OLD SCAN: one candidate inside ±180, so it answers. Silently.
      const before = await old('Antarctica/Vostok', repeated);
      expect(before.error).toBe('');
      expect(before.instant).not.toBe('');

      // THE CURRENT ONE: refused as ambiguous, by name, and resolvable only
      // when the caller says which offset it means — which is the law.
      const now = await resolve('Antarctica/Vostok', repeated);
      expect(now.error).toContain('booking.local_time_ambiguous');
      expect(now.instant).toBe('');
      const picked = await resolve('Antarctica/Vostok', repeated, '07:00:00');
      expect(picked.error).toBe('');
      expect(picked.instant).not.toBe('');
      const other = await resolve('Antarctica/Vostok', repeated, '00:00:00');
      expect(other.error).toBe('');
      expect(other.instant).not.toBe(picked.instant);
    });

    it('PREMISE 2 — offsets in the supported range are NOT all whole minutes, so candidates are read out of the zone', async () => {
      // The old scan did not only use ±180: it generated its candidates as
      // whole-MINUTE shifts of PostgreSQL's answer, which assumes every offset
      // is a whole number of minutes. That premise is measured FALSE inside
      // the supported range.
      const off = await db.pool.query<{ off: string; nonminute: number }>(
        `SELECT (('1971-06-15T10:00:00Z'::timestamptz AT TIME ZONE 'Africa/Monrovia') - ('1971-06-15T10:00:00Z'::timestamptz AT TIME ZONE 'UTC'))::text AS off,
                (SELECT count(*)::int FROM generate_series('1970-01-01Z'::timestamptz, '1973-01-01Z'::timestamptz, '7 days'::interval) AS ts
                  WHERE extract(epoch FROM ((ts AT TIME ZONE 'Africa/Monrovia') - (ts AT TIME ZONE 'UTC')))::bigint % 60 <> 0) AS nonminute`,
      );
      expect(off.rows[0]?.off).toBe('-00:44:30');
      expect(off.rows[0]?.nonminute).toBeGreaterThan(0);

      // HONEST ABOUT WHAT THIS IS. A wrong answer was NOT found: the old scan
      // resolves this time too, because PostgreSQL's own conversion is the
      // k = 0 candidate and is exact whatever the offset's seconds are, and
      // Monrovia's 1972 change is a GAP, which both versions refuse. So this
      // case proves a PREMISE REMOVED, not a defect repaired — the candidates
      // are now the zone's own offsets, seconds included, so the question of
      // whether every offset is a whole minute stops being load-bearing.
      const alsoOld = await old('Africa/Monrovia', '1971-06-15 09:15:30');
      expect(alsoOld.error).toBe('');

      const now = await resolve('Africa/Monrovia', '1971-06-15 09:15:30');
      expect(now.error).toBe('');
      const back = await db.pool.query<{ local: string }>(`SELECT ($1::timestamptz AT TIME ZONE 'Africa/Monrovia')::text AS local`, [now.instant]);
      expect(back.rows[0]?.local).toBe('1971-06-15 09:15:30');
      // And the skipped side of that sub-minute change is still refused, by
      // name, which is the behaviour a gap must have at any granularity.
      const skipped = await resolve('Africa/Monrovia', '1972-01-07 00:20:00');
      expect(skipped.error).toContain('booking.local_time_nonexistent');
    });

    it('the supported range is ENFORCED, not implied, and refused by its own name', async () => {
      for (const local of ['1969-12-31 23:59:00', '2100-01-01 00:00:00', '2199-06-01 12:00:00']) {
        const r = await resolve(ORDINARY_NY.zone, local);
        expect(r.error).toContain('booking.local_time_out_of_supported_range');
        expect(r.instant).toBe('');
      }
      // And the edges INSIDE the range answer, so the guard is a boundary and
      // not a blanket refusal of old or distant dates.
      for (const local of ['1970-01-01 00:00:00', '2099-12-31 23:00:00']) {
        const r = await resolve('UTC', local);
        expect(r.error).toBe('');
        expect(r.instant).not.toBe('');
      }
    });
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
