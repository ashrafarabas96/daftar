/**
 * ACCOUNTING PERIODS — the matrices (P2-S6 §36-§40).
 *
 * Four questions, all answered against a real cluster through the real
 * boundary: the merchant runtime role, a real `acctctl/1` assertion, the real
 * commands.
 *
 *   §36 what may be changed about a period, and by whom — asked through a
 *        SCHEMA AUTHORITY, not through the runtime role, because "permission
 *        denied" is evidence about an ACL and not about an invariant.
 *   §37 which ranges may exist beside which.
 *   §38 which dates may be posted into, in which state.
 *   §40 which state transitions exist, including the replay hazard §18 names.
 *
 * §39 is here too, and it is the one most worth reading twice: an OPEN period
 * covering a future date does NOT make that date postable. Periods and the
 * no-future rule are independent, and both must pass.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { must, post, refusal, seedPostingFixture, simpleCommand, todayIn, type PostingFixture } from '../helpers/accounting-posting';
import {
  closePeriod,
  closePeriodAs,
  controlAssertion,
  createPeriod,
  createPeriodAs,
  operationIdFor,
  periodAssertion,
  periodIdFor,
  periodRefusal,
  readPeriod,
  reopenPeriod,
  type PeriodScope,
} from '../helpers/accounting-periods';

let pool: Pool;
let fx: PostingFixture;
let today: string;

/** A business with periods, kept apart from the one that has none. */
let managed: { tenantId: string; businessId: string; userId: string };

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  pool = ownerPool();
  fx = await seedPostingFixture(pool, `periods-${Math.floor(Math.random() * 1e6)}`);
  today = await todayIn(pool, 'Asia/Hebron');

  const tenantId = must((await pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0]).id;
  const businessId = must(
    (
      await pool.query<{ id: string }>(
        `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
         VALUES ($1, 'Managed Books', $2, 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
        [tenantId, `periods-managed-${Math.floor(Math.random() * 1e6)}`],
      )
    ).rows[0],
  ).id;
  const userId = must(
    (
      await pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'Keeper') RETURNING id`, [
        `periods-keeper-${Date.now()}@test.daftar.local`,
      ])
    ).rows[0],
  ).id;
  managed = { tenantId, businessId, userId };
}, 180_000);

/** A tenant, a business and a user of its own, so one suite cannot perturb another. */
async function newBusiness(label: string, timezone = 'Asia/Hebron'): Promise<PeriodScope> {
  const tenantId = must((await pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0]).id;
  const businessId = must(
    (
      await pool.query<{ id: string }>(
        `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
         VALUES ($1, $2, $3, 'PS', 'ILS', $4) RETURNING id`,
        [tenantId, label, `periods-${label.toLowerCase()}-${Math.floor(Math.random() * 1e9)}`, timezone],
      )
    ).rows[0],
  ).id;
  const userId = must(
    (
      await pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', $2) RETURNING id`, [
        `periods-${label}-${Date.now()}-${Math.floor(Math.random() * 1e9)}@test.daftar.local`,
        label,
      ])
    ).rows[0],
  ).id;
  return { tenantId, businessId, userId };
}

/** A civil date N days before today in the business timezone. */
const daysAgo = async (n: number): Promise<string> => {
  const r = await pool.query<{ d: string }>(`SELECT to_char(($1::date - $2::int), 'YYYY-MM-DD') AS d`, [today, n]);
  return must(r.rows[0]).d;
};

const daysAhead = async (n: number): Promise<string> => {
  const r = await pool.query<{ d: string }>(`SELECT to_char(($1::date + $2::int), 'YYYY-MM-DD') AS d`, [today, n]);
  return must(r.rows[0]).d;
};

// ── §9: activation, and the state that precedes it ────────────────────────

describe('activation — DAFTAR creates no period and infers no calendar (§9)', () => {
  it('a fresh business has ZERO periods and this migration created none', async () => {
    const r = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM accounting_periods`);
    // The whole database, not just this business: §9 forbids back-filling a
    // fiscal calendar for anybody.
    expect(must(r.rows[0]).n).toBe(0);
  });

  it('a business with zero periods posts exactly as it did before P2-S6', async () => {
    const past = await daysAgo(400);
    const outcome = await post(simpleCommand(fx, randomUUID(), past), fx.userId);
    expect(outcome.created).toBe(true);
  });

  it('the FIRST period a business creates activates period-managed posting', async () => {
    const start = await daysAgo(30);
    const end = await daysAhead(30);
    const created = await createPeriod(managed, 'activate-first-01', start, end);
    expect(created.changed).toBe(true);

    // A date OUTSIDE it is now refused for this business, and only this one.
    const outside = await daysAgo(400);
    const message = await refusal(() =>
      post({ ...simpleCommand(fx, randomUUID(), outside), tenantId: managed.tenantId, businessId: managed.businessId }, managed.userId),
    );
    expect(message).toMatch(/accounting\.period_missing_for_date/);

    // The business with no periods is untouched by the other's activation.
    expect((await post(simpleCommand(fx, randomUUID(), outside), fx.userId)).created).toBe(true);
  });

  it('activation rewrites no history: the entry posted before it still stands', async () => {
    const r = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM journal_entries WHERE business_id = $1`, [fx.businessId]);
    expect(must(r.rows[0]).n).toBeGreaterThan(0);
  });
});

// ── §37: the non-overlap and contiguity matrix ────────────────────────────

describe('non-overlap and contiguity (§13, §37)', () => {
  /** A business of its own, so the matrix is not perturbed by other cases. */
  let m: PeriodScope;

  beforeAll(async () => {
    const tenantId = must((await pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0]).id;
    const businessId = must(
      (
        await pool.query<{ id: string }>(
          `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
           VALUES ($1, 'Matrix Books', $2, 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
          [tenantId, `periods-matrix-${Math.floor(Math.random() * 1e6)}`],
        )
      ).rows[0],
    ).id;
    const userId = must(
      (
        await pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'Matrix') RETURNING id`, [
          `periods-matrix-${Date.now()}@test.daftar.local`,
        ])
      ).rows[0],
    ).id;
    m = { tenantId, businessId, userId };
    // The anchor: 1-31 January 2026.
    expect((await createPeriod(m, 'matrix-january-1', '2026-01-01', '2026-01-31')).changed).toBe(true);
  }, 120_000);

  const cases: ReadonlyArray<{ name: string; start: string; end: string; refusal: RegExp | null; why: string }> = [
    { name: 'the identical range', start: '2026-01-01', end: '2026-01-31', refusal: /period_overlap/, why: 'a duplicate is an overlap, not a no-op' },
    { name: 'overlapping the start', start: '2025-12-20', end: '2026-01-10', refusal: /period_overlap/, why: 'a partial overlap at the left edge' },
    { name: 'overlapping the end', start: '2026-01-20', end: '2026-02-10', refusal: /period_overlap/, why: 'a partial overlap at the right edge' },
    {
      name: 'contained inside it',
      start: '2026-01-10',
      end: '2026-01-20',
      refusal: /period_overlap/,
      why: 'a period inside a period is two answers for one date',
    },
    { name: 'containing it', start: '2025-12-01', end: '2026-02-28', refusal: /period_overlap/, why: 'swallowing an existing period is still an overlap' },
    { name: 'one day before, with a gap', start: '2025-12-01', end: '2025-12-30', refusal: /period_not_contiguous/, why: 'a ONE-day gap is still a gap' },
    { name: 'one day after, with a gap', start: '2026-02-02', end: '2026-02-28', refusal: /period_not_contiguous/, why: 'the same gap on the other side' },
    { name: 'a large gap', start: '2027-01-01', end: '2027-01-31', refusal: /period_not_contiguous/, why: 'a year later is not adjacent' },
    { name: 'exactly the previous month', start: '2025-12-01', end: '2025-12-31', refusal: null, why: 'ending the day before the earliest start' },
    { name: 'exactly the next month', start: '2026-02-01', end: '2026-02-28', refusal: null, why: 'starting the day after the latest end' },
  ];

  for (const c of cases) {
    it(`${c.name}: ${c.refusal === null ? 'permitted' : 'REFUSED'} — ${c.why}`, async () => {
      const run = (): Promise<unknown> => createPeriod(m, `matrix-${c.start}-${c.end}`.slice(0, 40).padEnd(10, 'x'), c.start, c.end);
      if (c.refusal === null) {
        expect((await run()) as { changed: boolean }).toMatchObject({ changed: true });
      } else {
        const message = await periodRefusal(run);
        expect(message).toMatch(c.refusal);
        // §37: the exclusion constraint's NAME never reaches a caller.
        expect(message).not.toMatch(/accounting_periods_no_overlap|23P01|conflicting key/i);
      }
    });
  }

  it('the same dates in a DIFFERENT business are permitted (§37)', async () => {
    const tenantId = must((await pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0]).id;
    const businessId = must(
      (
        await pool.query<{ id: string }>(
          `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
           VALUES ($1, 'Neighbour', $2, 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
          [tenantId, `periods-neighbour-${Math.floor(Math.random() * 1e6)}`],
        )
      ).rows[0],
    ).id;
    const userId = must(
      (
        await pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'Neighbour') RETURNING id`, [
          `periods-neighbour-${Date.now()}@test.daftar.local`,
        ])
      ).rows[0],
    ).id;
    const outcome = await createPeriod({ tenantId, businessId, userId }, 'neighbour-january', '2026-01-01', '2026-01-31');
    expect(outcome.changed).toBe(true);
  });

  it('a period ending before it starts is refused by the ENGINE before it is signed (§11)', async () => {
    // The canonicalizer refuses to build a stream for it at all, so the
    // command can never be minted.
    await expect(createPeriod(m, 'backwards-range-1', '2026-03-31', '2026-03-01')).rejects.toThrow(/ends on or after it starts/);
  });

  it('and the DATABASE refuses it too, for a caller that never went through the engine (§11)', async () => {
    // Minted with a well-formed but arbitrary fingerprint: the range is
    // checked BEFORE the fingerprint is recomputed, which is the point — a
    // caller cannot reach the signature check with an impossible range.
    const operationId = operationIdFor(m.businessId, 'backwards-direct1');
    const assertion = controlAssertion({
      actorUserId: m.userId,
      tenantId: m.tenantId,
      businessId: m.businessId,
      commandKind: 'period_create',
      resourceId: periodIdFor(m.businessId, 'backwards-direct1'),
      payloadFingerprint: 'f'.repeat(64),
    });
    expect(await periodRefusal(() => createPeriodAs(assertion, { operationId, startDate: '2026-03-31', endDate: '2026-03-01' }))).toMatch(
      /accounting\.period_range_invalid/,
    );
  });

  it('a one-day period is a period', async () => {
    // 2026-02-28 was the latest end after the matrix above; 2026-03-01 is
    // exactly adjacent.
    expect((await createPeriod(m, 'single-day-0001', '2026-03-01', '2026-03-01')).changed).toBe(true);
  });
});

// ── §36: immutability, asked through a SCHEMA AUTHORITY ───────────────────

describe('a period is immutable except for its state (§15, §16, §36)', () => {
  let im: PeriodScope;
  let periodId: string;

  beforeAll(async () => {
    im = await newBusiness('immutable');
    periodId = (await createPeriod(im, 'immutable-target1', '2025-01-01', '2025-01-31')).periodId;
  }, 120_000);

  /**
   * These run as the OWNER pool — the schema authority — deliberately.
   *
   * A refusal from the runtime role would only prove that `daftar_app` holds
   * no UPDATE, which is a fact about an ACL. §36 asks whether the INVARIANT
   * holds against the one principal a privilege check can never stop, and the
   * only way to ask that is to try it as that principal.
   */
  const asSchemaOwner = async (sql: string, params: unknown[]): Promise<string> => {
    try {
      await pool.query(sql, params);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    throw new Error('the schema owner changed a period, which no principal may do');
  };

  it('the schema owner cannot move a boundary', async () => {
    expect(await asSchemaOwner(`UPDATE accounting_periods SET start_date = start_date - 1 WHERE id = $1`, [periodId])).toMatch(/period_immutable/);
    expect(await asSchemaOwner(`UPDATE accounting_periods SET end_date = end_date + 1 WHERE id = $1`, [periodId])).toMatch(/period_immutable/);
  });

  it('the schema owner cannot delete a period', async () => {
    expect(await asSchemaOwner(`DELETE FROM accounting_periods WHERE id = $1`, [periodId])).toMatch(/period_immutable/);
  });

  it('the schema owner cannot flip the status without the transition metadata', async () => {
    expect(await asSchemaOwner(`UPDATE accounting_periods SET status = 'closed' WHERE id = $1`, [periodId])).toMatch(/closed_shape_ck|period_immutable/);
  });

  it('the schema owner cannot rewrite the creation record', async () => {
    expect(await asSchemaOwner(`UPDATE accounting_periods SET created_at = now() WHERE id = $1`, [periodId])).toMatch(/period_immutable/);
  });

  it('an UPDATE that changes nothing is still refused — there is no third transition', async () => {
    expect(await asSchemaOwner(`UPDATE accounting_periods SET status = status WHERE id = $1`, [periodId])).toMatch(/period_immutable/);
  });

  it('the operation registry is append-only, even for the schema owner', async () => {
    const op = must(
      (await pool.query<{ id: string }>(`SELECT id FROM accounting_period_operations WHERE business_id = $1 LIMIT 1`, [im.businessId])).rows[0],
    ).id;
    expect(await asSchemaOwner(`UPDATE accounting_period_operations SET resulting_status = 'closed' WHERE id = $1`, [op])).toMatch(/period_immutable/);
    expect(await asSchemaOwner(`DELETE FROM accounting_period_operations WHERE id = $1`, [op])).toMatch(/period_immutable/);
  });

  it('the merchant runtime holds no DML on either table at all (§35)', async () => {
    const r = await pool.query<{ role: string; table: string; priv: string; held: boolean }>(
      `SELECT role, tbl AS table, priv, has_table_privilege(role, tbl, priv) AS held
         FROM unnest(ARRAY['daftar_app','daftar_platform','daftar_worker','daftar_identity','daftar_resolver','daftar_provisioner']) AS role,
              unnest(ARRAY['accounting_periods','accounting_period_operations']) AS tbl,
              unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) AS priv`,
    );
    expect(r.rows.filter((row) => row.held)).toEqual([]);
  });
});

// ── §38, §39: the posting matrix ──────────────────────────────────────────

describe('what may be posted, and when (§23, §38, §39)', () => {
  let p: PeriodScope;
  let janId: string;
  let febId: string;

  beforeAll(async () => {
    const tenantId = must((await pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0]).id;
    const businessId = must(
      (
        await pool.query<{ id: string }>(
          `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
           VALUES ($1, 'Posting Periods', $2, 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
          [tenantId, `periods-posting-${Math.floor(Math.random() * 1e6)}`],
        )
      ).rows[0],
    ).id;
    const userId = must(
      (
        await pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'Poster') RETURNING id`, [
          `periods-posting-${Date.now()}@test.daftar.local`,
        ])
      ).rows[0],
    ).id;
    p = { tenantId, businessId, userId };

    // Two adjacent periods ending today, so every date used below is in the
    // past or is today — the no-future rule is tested on its own terms later.
    const aStart = await daysAgo(60);
    const aEnd = await daysAgo(31);
    const bStart = await daysAgo(30);
    janId = (await createPeriod(p, 'posting-period-a', aStart, aEnd)).periodId;
    febId = (await createPeriod(p, 'posting-period-b', bStart, today)).periodId;
  }, 120_000);

  const postOn = (entryDate: string, sourceId = randomUUID()): Promise<{ entryId: string; created: boolean }> =>
    post({ ...simpleCommand(fx, sourceId, entryDate), tenantId: p.tenantId, businessId: p.businessId }, p.userId);

  it('a date inside an OPEN period is permitted', async () => {
    expect((await postOn(await daysAgo(45))).created).toBe(true);
  });

  it('the exact start_date and the exact end_date of an open period are inside it', async () => {
    expect((await postOn(await daysAgo(30))).created).toBe(true);
    expect((await postOn(today)).created).toBe(true);
  });

  it('a date outside every period is REFUSED, with the domain sentence', async () => {
    const far = await daysAgo(200);
    const message = await refusal(() => postOn(far));
    expect(message).toMatch(/accounting\.period_missing_for_date/);
    // Word-bounded: the refusal carries ids the caller owns, and an unbounded
    // /23\d\d\d/ matches the decimal digits inside a UUID's hex.
    expect(message).not.toMatch(/journal_entries|trigger|\b23\d{3}\b/i);
  });

  describe('once the earlier period is closed', () => {
    beforeAll(async () => {
      expect((await closePeriod(p, 'close-period-a-01', janId)).changed).toBe(true);
    }, 60_000);

    it('a NEW entry dated inside it is REFUSED', async () => {
      const inside = await daysAgo(45);
      expect(await refusal(() => postOn(inside))).toMatch(/accounting\.period_closed/);
    });

    it('an adjustment and an opening balance INSIDE a closed period are refused alike (§38, §11)', async () => {
      // Inside the chain, the source does not matter. The opening-balance
      // exception is about a date OLDER than the earliest period, so a date
      // that falls inside a closed period gets the ordinary refusal — see
      // accounting-periods-opening-balance.test.ts for the boundary either
      // side of which these two sources finally differ.
      for (const sourceType of ['manual_adjustment', 'opening_balance']) {
        const c = { ...simpleCommand(fx, randomUUID(), await daysAgo(50), 150000n, sourceType), tenantId: p.tenantId, businessId: p.businessId };
        expect(await refusal(() => post(c, p.userId))).toMatch(/accounting\.period_closed/);
      }
    });

    /**
     * The sharpest form of §23: a DIRECT `INSERT`, as the schema OWNER.
     *
     * Every other posting case above goes through the frozen posting
     * primitive, which proves the refusal is not in a service. This one goes
     * through nothing at all — no command, no validation routine, no
     * application — and it is issued by the one principal a privilege check
     * can never stop. If the rule lived anywhere except on `journal_entries`
     * itself, this row would be written.
     */
    it('a DIRECT INSERT by the schema owner is refused too — the rule is on the table (§23)', async () => {
      const inside = await daysAgo(48);
      let message = '';
      try {
        await pool.query(
          `INSERT INTO journal_entries (tenant_id, business_id, entry_date, source_type, source_id, actor_kind, actor_user_id, posting_fingerprint)
           VALUES ($1, $2, $3::date, 'manual_adjustment', $4, 'user', $5, $6)`,
          [p.tenantId, p.businessId, inside, randomUUID(), p.userId, 'a'.repeat(64)],
        );
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).toMatch(/accounting\.period_closed/);
      expect(
        must(
          (
            await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM journal_entries WHERE business_id = $1 AND entry_date = $2::date`, [
              p.businessId,
              inside,
            ])
          ).rows[0],
        ).n,
      ).toBe(0);
    });

    it('the STILL-OPEN neighbouring period keeps accepting entries', async () => {
      expect((await postOn(await daysAgo(20))).created).toBe(true);
    });

    it('an idempotent replay of an entry accepted while it was open still SUCCEEDS (§38)', async () => {
      // Posted into the open period below, then replayed after its close.
      const sourceId = randomUUID();
      const entryDate = await daysAgo(25);
      const first = await postOn(entryDate, sourceId);
      expect(first.created).toBe(true);
      expect((await closePeriod(p, 'close-period-b-01', febId)).changed).toBe(true);

      const replay = await postOn(entryDate, sourceId);
      expect(replay.created).toBe(false);
      expect(replay.entryId).toBe(first.entryId);

      // And NEW truth in that period is now refused, so the replay succeeded
      // because it created nothing rather than because the close did not hold.
      expect(await refusal(() => postOn(entryDate))).toMatch(/accounting\.period_closed/);

      // Leave it open for the cases that follow.
      expect((await reopenPeriod(p, 'reopen-period-b-1', febId, 'the matrix needs it open again')).changed).toBe(true);
    });
  });

  it('§39: an OPEN period covering a FUTURE date does not make that date postable', async () => {
    // A brand-new business, so the future period is the only one it has.
    const tenantId = must((await pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0]).id;
    const businessId = must(
      (
        await pool.query<{ id: string }>(
          `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
           VALUES ($1, 'Future Books', $2, 'PS', 'ILS', 'Pacific/Kiritimati') RETURNING id`,
          [tenantId, `periods-future-${Math.floor(Math.random() * 1e6)}`],
        )
      ).rows[0],
    ).id;
    const userId = must(
      (
        await pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'Future') RETURNING id`, [
          `periods-future-${Date.now()}@test.daftar.local`,
        ])
      ).rows[0],
    ).id;

    // A real IANA zone 14 hours ahead of UTC, so "today" here is genuinely
    // not "today" in Asia/Hebron — a test that used a fixed offset would
    // prove nothing about how the engine resolves a business's own date.
    const localToday = await todayIn(pool, 'Pacific/Kiritimati');
    const r = await pool.query<{ a: string; b: string }>(`SELECT to_char($1::date + 1, 'YYYY-MM-DD') AS a, to_char($1::date + 40, 'YYYY-MM-DD') AS b`, [
      localToday,
    ]);
    const tomorrow = must(r.rows[0]).a;
    const later = must(r.rows[0]).b;

    expect((await createPeriod({ tenantId, businessId, userId }, 'future-window-01', tomorrow, later)).changed).toBe(true);

    const message = await refusal(() => post({ ...simpleCommand(fx, randomUUID(), tomorrow), tenantId, businessId }, userId));
    expect(message).toMatch(/accounting\.entry_date_in_future/);
  });
});

// ── §40: the transition matrix, and the replay hazard ─────────────────────

describe('close and reopen transitions (§16, §17, §40)', () => {
  let t: PeriodScope;
  let periodId: string;

  beforeAll(async () => {
    const tenantId = must((await pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0]).id;
    const businessId = must(
      (
        await pool.query<{ id: string }>(
          `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
           VALUES ($1, 'Transition Books', $2, 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
          [tenantId, `periods-transition-${Math.floor(Math.random() * 1e6)}`],
        )
      ).rows[0],
    ).id;
    const userId = must(
      (
        await pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'Transition') RETURNING id`, [
          `periods-transition-${Date.now()}@test.daftar.local`,
        ])
      ).rows[0],
    ).id;
    t = { tenantId, businessId, userId };
    periodId = (await createPeriod(t, 'transition-target', '2024-01-01', '2024-01-31')).periodId;
  }, 120_000);

  it('reopening an OPEN period is refused, not silently successful', async () => {
    expect(await periodRefusal(() => reopenPeriod(t, 'reopen-while-open', periodId, 'nothing to undo'))).toMatch(/period_not_closed/);
  });

  it('closing records who and when, and nothing else', async () => {
    expect((await closePeriod(t, 'close-transition-1', periodId)).changed).toBe(true);
    const row = await readPeriod(pool, t.businessId, periodId);
    expect(row.status).toBe('closed');
    expect(row.closed_by_user_id).toBe(t.userId);
    expect(row.closed_at).not.toBeNull();
    expect(row.last_reopened_at).toBeNull();
    expect(row.last_reopen_reason).toBeNull();
  });

  it('closing an already-closed period under a NEW key is refused', async () => {
    expect(await periodRefusal(() => closePeriod(t, 'close-transition-2', periodId))).toMatch(/period_not_open/);
  });

  it('replaying the SAME close returns the original result and changes nothing', async () => {
    const before = await readPeriod(pool, t.businessId, periodId);
    const replay = await closePeriod(t, 'close-transition-1', periodId);
    expect(replay).toEqual({ periodId, changed: false });
    const after = await readPeriod(pool, t.businessId, periodId);
    expect(after.closed_at?.getTime()).toBe(before.closed_at?.getTime());
  });

  it('a reopen with no reason is refused', async () => {
    // Refused before the command is even minted: the reason is part of the
    // fingerprint, so a blank one cannot be signed.
    await expect(reopenPeriod(t, 'reopen-blank-0001', periodId, '   \t  ')).rejects.toThrow(/reason/i);
  });

  it('reopening records who, when and WHY, and clears the close it undid', async () => {
    const reason = 'The supplier invoice for January arrived in March';
    expect((await reopenPeriod(t, 'reopen-transition1', periodId, reason)).changed).toBe(true);
    const row = await readPeriod(pool, t.businessId, periodId);
    expect(row.status).toBe('open');
    expect(row.closed_at).toBeNull();
    expect(row.closed_by_user_id).toBeNull();
    expect(row.last_reopened_by_user_id).toBe(t.userId);
    expect(row.last_reopen_reason).toBe(reason);
  });

  it('the reopen reason reaches the AUDIT trail (§17, §33)', async () => {
    const audit = must(
      (
        await pool.query<{ metadata: Record<string, unknown> }>(
          `SELECT metadata FROM audit_events WHERE business_id = $1 AND action = 'accounting.period_reopened' AND entity_id = $2`,
          [t.businessId, periodId],
        )
      ).rows[0],
    );
    expect(audit.metadata['reason']).toBe('The supplier invoice for January arrived in March');
    expect(audit.metadata['previousStatus']).toBe('closed');
  });

  it('the reopen reason does NOT reach the outbox (§34)', async () => {
    const event = must(
      (
        await pool.query<{ payload: Record<string, unknown> }>(
          `SELECT payload FROM outbox_events WHERE business_id = $1 AND type = 'accounting.period.reopened' AND payload->>'periodId' = $2`,
          [t.businessId, periodId],
        )
      ).rows[0],
    );
    expect(Object.keys(event.payload).sort()).toEqual(['businessId', 'endDate', 'periodId', 'startDate', 'status']);
    expect(JSON.stringify(event.payload)).not.toMatch(/supplier invoice/i);
  });

  /**
   * THE HAZARD §18 names, end to end.
   *
   * Reopen, re-close, then retry the ORIGINAL reopen. A system that decided
   * from current state would find a closed period and a well-formed reopen
   * command and reopen a period the merchant deliberately closed.
   */
  it('an old reopen replayed after a LATER close does not reopen the period again (§18, §40)', async () => {
    expect((await closePeriod(t, 'close-transition-3', periodId)).changed).toBe(true);
    expect((await readPeriod(pool, t.businessId, periodId)).status).toBe('closed');

    const replay = await reopenPeriod(t, 'reopen-transition1', periodId, 'The supplier invoice for January arrived in March');
    expect(replay).toEqual({ periodId, changed: false });

    // The period is STILL closed. This is the assertion the whole registry
    // exists for.
    expect((await readPeriod(pool, t.businessId, periodId)).status).toBe('closed');
  });

  it('one idempotency key cannot be two different commands (§18)', async () => {
    // The same key that performed a close, now presented as a reopen: one
    // operation id, two payload fingerprints.
    expect(await periodRefusal(() => reopenPeriod(t, 'close-transition-3', periodId, 'trying to reuse a close key'))).toMatch(/idempotency_conflict/);
  });

  it('a create replayed under its own key returns the original period (§18)', async () => {
    const first = await createPeriod(t, 'transition-target', '2024-01-01', '2024-01-31');
    expect(first).toEqual({ periodId, changed: false });
  });

  it('the same key with DIFFERENT boundaries is an idempotency conflict (§18)', async () => {
    const operationId = operationIdFor(t.businessId, 'transition-target');
    const assertion = periodAssertion(
      {
        kind: 'period_create',
        tenantId: t.tenantId,
        businessId: t.businessId,
        operationId,
        periodId: periodIdFor(t.businessId, 'transition-target'),
        startDate: '2024-02-01',
        endDate: '2024-02-29',
      },
      t.userId,
    );
    expect(await periodRefusal(() => createPeriodAs(assertion, { operationId, startDate: '2024-02-01', endDate: '2024-02-29' }))).toMatch(
      /idempotency_conflict/,
    );
  });

  it('a close naming a period that does not exist is refused by name', async () => {
    const ghost = randomUUID();
    const operationId = operationIdFor(t.businessId, 'ghost-close-0001');
    const assertion = periodAssertion({ kind: 'period_close', tenantId: t.tenantId, businessId: t.businessId, operationId, periodId: ghost }, t.userId);
    expect(await periodRefusal(() => closePeriodAs(assertion, { operationId }))).toMatch(/period_not_found/);
  });
});
