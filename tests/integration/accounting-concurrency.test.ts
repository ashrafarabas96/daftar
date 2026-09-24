import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  appClient,
  assertionFor,
  must,
  post,
  postAs,
  seedPostingFixture,
  simpleCommand,
  todayIn,
  type PostCommand,
  type PostingFixture,
} from '../helpers/accounting-posting';

/**
 * MATRIX 5 — CONCURRENCY (directive §41, §42, §43, §50, §51).
 *
 * Every case here uses TWO REAL DATABASE CONNECTIONS. A concurrency test with
 * one connection tests nothing: PostgreSQL's row locks, its advisory locks and
 * its deferred validators only exist between sessions, and a single session
 * never blocks on itself.
 *
 * Interleaving is forced explicitly rather than hoped for. A test that fires
 * two promises with `Promise.all` and trusts the scheduler proves whichever
 * order it happened to get; each case below instead opens both transactions,
 * lets the one that must win take its lock, issues the second command while
 * the first still holds it, and only then commits — so the order under test is
 * the order that actually ran, every time, on every machine.
 *
 * `financial_started_at`, the base currency and the timezone are all read
 * under the SAME business row lock the posting takes, which is the whole
 * reason these races have answers at all.
 */

let fx: PostingFixture;

interface Fresh {
  tenantId: string;
  businessId: string;
}

/** A business nobody has posted to yet, so its first posting takes FOR UPDATE. */
async function freshBusiness(name: string, timezone = 'Asia/Hebron', baseCurrency = 'ILS'): Promise<Fresh> {
  const tenant = must((await ownerPool().query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0]).id;
  const business = must(
    (
      await ownerPool().query<{ id: string }>(
        `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
         VALUES ($1, $2, $3, 'PS', $4, $5) RETURNING id`,
        [tenant, name, `conc-${name}-${randomUUID().slice(0, 8)}`, baseCurrency, timezone],
      )
    ).rows[0],
  ).id;
  return { tenantId: tenant, businessId: business };
}

const on = (b: Fresh, entryDate: string, amount = 150000n): PostCommand => simpleCommand({ ...fx, ...b }, randomUUID(), entryDate, amount);

/** `financial_started_at` as the committed database holds it. */
async function startedAt(businessId: string): Promise<Date | null> {
  return must((await ownerPool().query<{ v: Date | null }>(`SELECT financial_started_at AS v FROM businesses WHERE id = $1`, [businessId])).rows[0]).v;
}

async function closeAll(...clients: Client[]): Promise<void> {
  for (const c of clients) await c.end().catch(() => undefined);
}

/** The civil date today in a given IANA zone, as the database computes it. */
async function dateIn(zone: string): Promise<string> {
  return todayIn(ownerPool(), zone);
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  fx = await seedPostingFixture(ownerPool(), 'concurrency');
});

describe('two simultaneous FIRST postings in one business (§41)', () => {
  it('both commit, exactly one establishes financial_started_at, and the second does not rewrite it', async () => {
    const b = await freshBusiness('first-race');
    const today = await dateIn('Asia/Hebron');
    const a = await appClient();
    const c = await appClient();
    try {
      const ca = on(b, today, 100000n);
      const cc = on(b, today, 200000n);
      await a.query('BEGIN');

      // A takes the exclusive business row lock, because it believes it is the
      // first posting, and stamps the row inside its own transaction.
      const ra = await postAs(assertionFor(ca, fx.userId), ca, {}, a);

      // C opens its transaction while A holds that lock, and issues its posting
      // on a DIFFERENT source. It must block rather than deadlock or fail.
      // Opening C after A's statements, rather than alongside them, also gives
      // the two transactions distinct `now()` timestamps, which is what makes
      // the ownership of the stamp observable below.
      await c.query('BEGIN');
      const pending = postAs(assertionFor(cc, fx.userId), cc, {}, c).catch((e) => e as Error);
      await a.query('COMMIT');
      const rc = await pending;
      expect(rc).not.toBeInstanceOf(Error);
      await c.query('COMMIT');

      expect(ra.created).toBe(true);
      expect((rc as { created: boolean }).created).toBe(true);
      const rcId = (rc as { entryId: string }).entryId;
      expect(rcId).not.toBe(ra.entryId);

      // Both journals exist. Which transaction stamped the row is decided by
      // comparing the stamp against each entry's own `created_at`: both are
      // `now()`, the transaction start timestamp, so the stamp can only equal
      // the timestamp of the transaction that wrote it. If C had rewritten the
      // value, it would carry C's timestamp instead of A's.
      const stamps = must(
        (
          await ownerPool().query<{ started: Date; a_at: Date; c_at: Date; n: number }>(
            `SELECT b.financial_started_at AS started,
                    (SELECT created_at FROM journal_entries WHERE business_id = b.id AND id = $2) AS a_at,
                    (SELECT created_at FROM journal_entries WHERE business_id = b.id AND id = $3) AS c_at,
                    (SELECT count(*)::int FROM journal_entries WHERE business_id = b.id) AS n
               FROM businesses b WHERE b.id = $1`,
            [b.businessId, ra.entryId, rcId],
          )
        ).rows[0],
      );
      expect(stamps.n).toBe(2);
      expect(stamps.a_at.toISOString()).not.toBe(stamps.c_at.toISOString());
      expect(must(stamps.started).toISOString()).toBe(stamps.a_at.toISOString());
    } finally {
      await closeAll(a, c);
    }
  });

  it('both entries were written under the SAME base currency, read under that same lock', async () => {
    const rows = (
      await ownerPool().query<{ base_currency: string }>(
        `SELECT DISTINCT l.base_currency FROM journal_lines l
           JOIN businesses b ON b.id = l.business_id
          WHERE b.store_slug LIKE 'conc-first-race-%'`,
      )
    ).rows.map((r) => r.base_currency);
    expect(rows).toEqual(['ILS']);
  });

  it('does NOT serialize later postings: once financial_started_at exists, two postings run concurrently', async () => {
    const b = await freshBusiness('shared-lock');
    const today = await dateIn('Asia/Hebron');
    await post(on(b, today), fx.userId); // establishes financial_started_at
    const a = await appClient();
    try {
      const held = on(b, today, 300000n);
      await a.query('BEGIN');
      const ra = await postAs(assertionFor(held, fx.userId), held, {}, a);
      expect(ra.created).toBe(true);

      // A holds a SHARE lock on the business row and has NOT committed. A
      // second posting, in its own transaction on its own connection, must
      // complete anyway — if it blocked on A's lock, this await would not
      // return until A committed, and A does not commit until afterwards.
      const rc = await post(on(b, today, 400000n), fx.userId);
      expect(rc.created).toBe(true);
      await a.query('COMMIT');
    } finally {
      await closeAll(a);
    }
  });
});

describe('the base-currency race (§42)', () => {
  it('Case A — the currency change wins the lock; the waiting posting sees the NEW currency and is refused by name', async () => {
    const b = await freshBusiness('base-a');
    const today = await dateIn('Asia/Hebron');
    const poster = await appClient();
    try {
      // The change takes the business row lock first, the way the Phase 1
      // settings service does: lock the row, then write it.
      const owner = await ownerPool().connect();
      try {
        await owner.query('BEGIN');
        await owner.query(`SELECT 1 FROM businesses WHERE id = $1 FOR UPDATE`, [b.businessId]);
        await owner.query(`UPDATE businesses SET base_currency = 'USD' WHERE id = $1`, [b.businessId]);

        const c = on(b, today);
        await poster.query('BEGIN');
        const pending = postAs(assertionFor(c, fx.userId), c, {}, poster).catch((e) => e as Error);
        await owner.query('COMMIT');
        const result = await pending;
        await poster.query('ROLLBACK').catch(() => undefined);

        expect(result).toBeInstanceOf(Error);
        expect((result as Error).message).toMatch(/entry_base_currency_mismatch/);
      } finally {
        await owner.query('ROLLBACK').catch(() => undefined);
        owner.release();
      }

      // Nothing was written under the currency that changed behind it.
      const n = must(
        (await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM journal_entries WHERE business_id = $1`, [b.businessId])).rows[0],
      ).n;
      expect(n).toBe(0);
      expect(await startedAt(b.businessId)).toBeNull();
    } finally {
      await closeAll(poster);
    }
  });

  it('Case A continued — a payload denominated in the NEW currency commits', async () => {
    const b = await freshBusiness('base-a2', 'Asia/Hebron', 'USD');
    const today = await dateIn('Asia/Hebron');
    const c = on(b, today);
    const usd: PostCommand = { ...c, lines: c.lines.map((l) => ({ ...l, baseCurrency: 'USD', txnCurrency: 'USD' })) };
    const r = await post(usd, fx.userId);
    expect(r.created).toBe(true);
    const cur = (
      await ownerPool().query<{ base_currency: string }>(`SELECT DISTINCT base_currency FROM journal_lines WHERE business_id = $1`, [b.businessId])
    ).rows.map((x) => x.base_currency);
    expect(cur).toEqual(['USD']);
  });

  it('Case B — the posting wins the lock; the waiting currency change is then refused because history now exists', async () => {
    const b = await freshBusiness('base-b');
    const today = await dateIn('Asia/Hebron');
    const poster = await appClient();
    const owner = await ownerPool().connect();
    try {
      const c = on(b, today);
      await poster.query('BEGIN');
      const r = await postAs(assertionFor(c, fx.userId), c, {}, poster);
      expect(r.created).toBe(true);

      // The change now waits on the posting's exclusive row lock.
      await owner.query('BEGIN');
      const waiting = owner.query(`UPDATE businesses SET base_currency = 'USD' WHERE id = $1`, [b.businessId]).then(
        () => null,
        (e: unknown) => e as Error,
      );
      await poster.query('COMMIT');
      const outcome = await waiting;
      await owner.query('ROLLBACK').catch(() => undefined);

      expect(outcome).toBeInstanceOf(Error);
      expect(must(outcome).message).toMatch(/base_currency_locked/);
      expect(await startedAt(b.businessId)).not.toBeNull();
      const cur = must((await ownerPool().query<{ c: string }>(`SELECT base_currency AS c FROM businesses WHERE id = $1`, [b.businessId])).rows[0]).c;
      expect(cur).toBe('ILS');
    } finally {
      owner.release();
      await closeAll(poster);
    }
  });
});

describe('the timezone race (§43)', () => {
  /**
   * Pacific/Kiritimati is UTC+14 and Pacific/Honolulu is UTC−10: a full 24
   * hours apart, so their civil dates differ by exactly one day at every
   * instant. That makes "today in Kiritimati" always tomorrow in Honolulu, and
   * therefore always a future date a Honolulu business must refuse — which is
   * how each case below observes WHICH timezone the posting actually used.
   */
  it('the two zones really are a full day apart, which is what makes the rest of this matrix decisive', async () => {
    const k = new Date(`${await dateIn('Pacific/Kiritimati')}T00:00:00Z`).getTime();
    const h = new Date(`${await dateIn('Pacific/Honolulu')}T00:00:00Z`).getTime();
    expect(k - h).toBe(86_400_000);
  });

  it('the timezone mutation wins the lock — the waiting posting evaluates "today" in the NEW zone', async () => {
    const b = await freshBusiness('tz-new', 'Pacific/Honolulu');
    const kiritimatiToday = await dateIn('Pacific/Kiritimati');
    const poster = await appClient();
    const owner = await ownerPool().connect();
    try {
      await owner.query('BEGIN');
      await owner.query(`SELECT 1 FROM businesses WHERE id = $1 FOR UPDATE`, [b.businessId]);
      await owner.query(`UPDATE businesses SET timezone = 'Pacific/Kiritimati' WHERE id = $1`, [b.businessId]);

      // Dated today-in-Kiritimati: a future date under Honolulu, a valid one
      // under Kiritimati. The posting blocks, then reads the NEW zone.
      const c = on(b, kiritimatiToday);
      await poster.query('BEGIN');
      const pending = postAs(assertionFor(c, fx.userId), c, {}, poster).catch((e) => e as Error);
      await owner.query('COMMIT');
      const result = await pending;
      expect(result).not.toBeInstanceOf(Error);
      await poster.query('COMMIT');

      const stored = must(
        (await ownerPool().query<{ d: Date }>(`SELECT entry_date AS d FROM journal_entries WHERE business_id = $1`, [b.businessId])).rows[0],
      ).d;
      expect(stored.toISOString().slice(0, 10)).toBe(kiritimatiToday);
    } finally {
      owner.release();
      await closeAll(poster);
    }
  });

  it('the posting wins the lock — it evaluates "today" in the LOCKED OLD zone, and the timezone change lands afterwards', async () => {
    const b = await freshBusiness('tz-old', 'Pacific/Kiritimati');
    const kiritimatiToday = await dateIn('Pacific/Kiritimati');
    const poster = await appClient();
    const owner = await ownerPool().connect();
    try {
      const c = on(b, kiritimatiToday);
      await poster.query('BEGIN');
      // Accepted under Kiritimati; it would be a future date under Honolulu.
      const r = await postAs(assertionFor(c, fx.userId), c, {}, poster);
      expect(r.created).toBe(true);

      await owner.query('BEGIN');
      const waiting = owner.query(`UPDATE businesses SET timezone = 'Pacific/Honolulu' WHERE id = $1`, [b.businessId]).then(
        () => null,
        (e: unknown) => e as Error,
      );
      await poster.query('COMMIT');
      const outcome = await waiting;
      await owner.query('COMMIT');

      // The entry kept the date the locked zone gave it, and the timezone
      // remains editable after posting — there is no permanent timezone lock,
      // and inventing one is explicitly out of scope.
      expect(outcome).toBeNull();
      const stored = must(
        (await ownerPool().query<{ d: Date }>(`SELECT entry_date AS d FROM journal_entries WHERE business_id = $1`, [b.businessId])).rows[0],
      ).d;
      expect(stored.toISOString().slice(0, 10)).toBe(kiritimatiToday);
      const tz = must((await ownerPool().query<{ t: string }>(`SELECT timezone AS t FROM businesses WHERE id = $1`, [b.businessId])).rows[0]).t;
      expect(tz).toBe('Pacific/Honolulu');
    } finally {
      owner.release();
      await closeAll(poster);
    }
  });

  it('refuses the same date once the business is genuinely in the western zone — the guard is real, not incidental', async () => {
    const b = await freshBusiness('tz-guard', 'Pacific/Honolulu');
    const kiritimatiToday = await dateIn('Pacific/Kiritimati');
    const c = on(b, kiritimatiToday);
    await expect(post(c, fx.userId)).rejects.toThrow(/entry_date_in_future/);
  });
});

describe('concurrent duplicate posting on one source (§50)', () => {
  it('two connections, the same fact, different assertion JTIs: one entry, one binding, one audit, one outbox, one id', async () => {
    const b = await freshBusiness('dup');
    const today = await dateIn('Asia/Hebron');
    const c = on(b, today);
    const first = assertionFor(c, fx.userId);
    const second = assertionFor(c, fx.userId);
    // Two independently minted assertions over one identical fact: same
    // fingerprint, different replay ids. Replay protection must not turn a
    // legitimate concurrent retry into a failure.
    expect(first).not.toBe(second);
    expect(first.split('.').slice(0, 11).join('.')).not.toBe(second.split('.').slice(0, 11).join('.'));

    const a = await appClient();
    const d = await appClient();
    try {
      await a.query('BEGIN');
      await d.query('BEGIN');
      const ra = await postAs(first, c, {}, a);
      const pending = postAs(second, c, {}, d).catch((e) => e as Error);
      await a.query('COMMIT');
      const rd = await pending;
      await d.query('COMMIT');

      expect(rd).not.toBeInstanceOf(Error);
      const other = rd as { entryId: string; created: boolean };
      expect(ra.created).toBe(true);
      expect(other.created).toBe(false);
      expect(other.entryId).toBe(ra.entryId);

      const counts = must(
        (
          await ownerPool().query<{ entries: number; bindings: number; lines: number; audits: number; outbox: number }>(
            `SELECT (SELECT count(*) FROM journal_entries WHERE business_id = $1)::int AS entries,
                    (SELECT count(*) FROM accounting_source_bindings WHERE business_id = $1)::int AS bindings,
                    (SELECT count(*) FROM journal_lines WHERE journal_entry_id = $2)::int AS lines,
                    (SELECT count(*) FROM audit_events WHERE entity_id = $2::text)::int AS audits,
                    (SELECT count(*) FROM outbox_events WHERE payload->>'entryId' = $2::text)::int AS outbox`,
            [b.businessId, ra.entryId],
          )
        ).rows[0],
      );
      expect(counts).toEqual({ entries: 1, bindings: 1, lines: 2, audits: 1, outbox: 1 });
    } finally {
      await closeAll(a, d);
    }
  });

  it('the loser is never told about a unique violation — idempotency is the engine’s answer, not the index’s', async () => {
    const b = await freshBusiness('dup-msg');
    const today = await dateIn('Asia/Hebron');
    const c = on(b, today);
    const a = await appClient();
    const d = await appClient();
    try {
      await a.query('BEGIN');
      await d.query('BEGIN');
      await postAs(assertionFor(c, fx.userId), c, {}, a);
      const pending = postAs(assertionFor(c, fx.userId), c, {}, d).catch((e) => e as Error);
      await a.query('COMMIT');
      const rd = await pending;
      await d.query('COMMIT').catch(() => undefined);
      const text = rd instanceof Error ? rd.message : '';
      expect(text).not.toMatch(/duplicate key|unique constraint|23505/i);
    } finally {
      await closeAll(a, d);
    }
  });
});

describe('rollback then retry (§51)', () => {
  it('a rolled-back first posting leaves no lock, no ledger, no audit, no outbox and no financial_started_at; the retry is an ordinary first post', async () => {
    const b = await freshBusiness('retry');
    const today = await dateIn('Asia/Hebron');
    const c = on(b, today);

    const a = await appClient();
    try {
      await a.query('BEGIN');
      const r = await postAs(assertionFor(c, fx.userId), c, {}, a);
      expect(r.created).toBe(true);
      await a.query('ROLLBACK');
    } finally {
      await closeAll(a);
    }

    // Nothing survived the rollback — in particular the advisory lock on the
    // source identity, which is transaction-scoped and therefore gone.
    const after = must(
      (
        await ownerPool().query<{ entries: number; bindings: number; audits: number; outbox: number; locks: number }>(
          `SELECT (SELECT count(*) FROM journal_entries WHERE business_id = $1)::int AS entries,
                  (SELECT count(*) FROM accounting_source_bindings WHERE business_id = $1)::int AS bindings,
                  (SELECT count(*) FROM audit_events WHERE business_id = $1 AND entity = 'journal_entry')::int AS audits,
                  (SELECT count(*) FROM outbox_events WHERE business_id = $1)::int AS outbox,
                  (SELECT count(*) FROM pg_locks WHERE locktype = 'advisory')::int AS locks`,
          [b.businessId],
        )
      ).rows[0],
    );
    expect(after).toEqual({ entries: 0, bindings: 0, audits: 0, outbox: 0, locks: 0 });
    expect(await startedAt(b.businessId)).toBeNull();

    // The retry carries a NEW assertion (a fresh JTI) over the same fact and
    // behaves as if the first attempt had never happened.
    const retry = await post(c, fx.userId);
    expect(retry.created).toBe(true);
    expect(await startedAt(b.businessId)).not.toBeNull();

    const final = must(
      (
        await ownerPool().query<{ entries: number; bindings: number; audits: number; outbox: number }>(
          `SELECT (SELECT count(*) FROM journal_entries WHERE business_id = $1)::int AS entries,
                  (SELECT count(*) FROM accounting_source_bindings WHERE business_id = $1)::int AS bindings,
                  (SELECT count(*) FROM audit_events WHERE business_id = $1 AND entity = 'journal_entry')::int AS audits,
                  (SELECT count(*) FROM outbox_events WHERE business_id = $1)::int AS outbox`,
          [b.businessId],
        )
      ).rows[0],
    );
    expect(final).toEqual({ entries: 1, bindings: 1, audits: 1, outbox: 1 });
  });

  it('the replay registry does not outlive the rolled-back transaction either — the same assertion is usable again', async () => {
    const b = await freshBusiness('retry-jti');
    const today = await dateIn('Asia/Hebron');
    const c = on(b, today);
    const assertion = assertionFor(c, fx.userId);

    const a = await appClient();
    try {
      await a.query('BEGIN');
      await postAs(assertion, c, {}, a);
      await a.query('ROLLBACK');
    } finally {
      await closeAll(a);
    }

    // The registry row was written inside the transaction that rolled back, so
    // it is gone with it. Replay protection must not strand a caller whose
    // transaction never committed anything.
    const r = await postAs(assertion, c);
    expect(r.created).toBe(true);
  });
});
