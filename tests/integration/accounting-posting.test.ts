import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  appClient,
  assertionFor,
  dbPayload,
  fingerprintOf,
  post,
  postAs,
  refusal,
  seedPostingFixture,
  simpleCommand,
  todayIn,
  type PostCommand,
  type PostLine,
  type PostingFixture,
  must,
} from '../helpers/accounting-posting';

/**
 * MATRIX 4 — POSTING BEHAVIOUR (directive §26, §29, §30, §31, §37, §38, §41,
 * §43, §44, §47, §48, §49, §80).
 *
 * Authority is proved in `tests/security/accounting-posting-authority.test.ts`;
 * nothing here re-proves it. These cases assume a caller who is entitled to
 * post and ask the other question: does the engine write the right thing, and
 * does it refuse the wrong thing for the right reason?
 *
 * Every case still goes through the real primitive as `daftar_app` with a real
 * assertion, because the rules being tested — idempotency, the account rules,
 * the date policy, the first-activity stamp — live inside it and nowhere else.
 */

let fx: PostingFixture;
let today: string;

const cmd = (sourceId: string = randomUUID(), sourceType = 'manual_adjustment'): PostCommand => simpleCommand(fx, sourceId, today, 150000n, sourceType);

/** The raw payload for a command, so a case can post a shape the typed helper would refuse. */
async function postRaw(assertion: string, c: PostCommand, lines: unknown): Promise<unknown> {
  const client = await appClient();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.accounting_assertion', $1, true)`, [assertion]);
    const r = await client.query(`SELECT entry_id, created FROM accounting_post_entry($1::date, $2, $3, $4::jsonb)`, [
      c.entryDate,
      c.description ?? null,
      c.requestId ?? null,
      JSON.stringify(lines),
    ]);
    await client.query('COMMIT');
    return r.rows[0];
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await client.end().catch(() => undefined);
  }
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  fx = await seedPostingFixture(ownerPool(), 'posting');
  today = await todayIn(ownerPool(), 'Asia/Hebron');
});

describe('a successful posting writes exactly the truth it was given', () => {
  it('writes the entry, both lines, the source binding and the fingerprint it recomputed', async () => {
    const c = cmd();
    const r = await post(c, fx.userId);
    expect(r.created).toBe(true);

    const entry = await ownerPool().query<{
      tenant_id: string;
      business_id: string;
      entry_date: Date;
      source_type: string;
      source_id: string;
      status: string;
      actor_kind: string;
      actor_user_id: string;
      request_id: string;
      posting_fingerprint: string;
    }>(`SELECT * FROM journal_entries WHERE business_id = $1 AND id = $2`, [fx.businessId, r.entryId]);
    const e = must(entry.rows[0]);
    expect(e.tenant_id).toBe(fx.tenantId);
    expect(e.status).toBe('posted');
    expect(e.actor_kind).toBe('user');
    expect(e.actor_user_id).toBe(fx.userId);
    expect(e.source_type).toBe('manual_adjustment');
    expect(e.source_id).toBe(c.sourceId);
    expect(e.posting_fingerprint).toBe(fingerprintOf(c));

    const lines = await ownerPool().query<{ line_no: number; debit_minor: string; credit_minor: string; code: string }>(
      `SELECT l.line_no, l.debit_minor, l.credit_minor, a.system_key AS code
       FROM journal_lines l JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
       WHERE l.journal_entry_id = $1 ORDER BY l.line_no`,
      [r.entryId],
    );
    expect(lines.rows).toEqual([
      { line_no: 1, debit_minor: '150000', credit_minor: '0', code: 'cash' },
      { line_no: 2, debit_minor: '0', credit_minor: '150000', code: 'opening_equity' },
    ]);

    const binding = await ownerPool().query(`SELECT 1 FROM accounting_source_bindings WHERE business_id = $1 AND source_id = $2`, [fx.businessId, c.sourceId]);
    expect(binding.rowCount).toBe(1);
  });

  it('persists a foreign-currency line exactly as the fingerprint describes it', async () => {
    const at = new Date('2026-03-14T09:15:00Z');
    const foreign: PostLine[] = [
      {
        account: { kind: 'system', systemKey: 'cash' },
        side: 'D',
        baseAmountMinor: 37200n,
        baseCurrency: 'ILS',
        txnAmountMinor: 10000n,
        txnCurrency: 'USD',
        fxRate: '3.72',
        fxRateSource: 'manual',
        fxRateAt: at,
        branchId: fx.branchId,
        warehouseId: fx.warehouseId,
      },
      {
        account: { kind: 'system', systemKey: 'opening_equity' },
        side: 'C',
        baseAmountMinor: 37200n,
        baseCurrency: 'ILS',
        txnAmountMinor: 37200n,
        txnCurrency: 'ILS',
        fxRate: '1',
        fxRateSource: 'base',
        fxRateAt: at,
        branchId: fx.branchId,
        warehouseId: null,
      },
    ];
    const c: PostCommand = { ...cmd(), lines: foreign };
    const r = await post(c, fx.userId);
    const row = await ownerPool().query<{ fx_rate: string; fx_rate_at: Date; txn_currency: string; branch_id: string; warehouse_id: string }>(
      `SELECT fx_rate, fx_rate_at, txn_currency, branch_id, warehouse_id FROM journal_lines WHERE journal_entry_id = $1 AND line_no = 1`,
      [r.entryId],
    );
    expect(must(row.rows[0]).fx_rate).toBe('3.7200000000');
    expect(must(row.rows[0]).fx_rate_at.toISOString()).toBe('2026-03-14T09:15:00.000Z');
    expect(must(row.rows[0]).txn_currency).toBe('USD');
    expect(must(row.rows[0]).branch_id).toBe(fx.branchId);
    expect(must(row.rows[0]).warehouse_id).toBe(fx.warehouseId);
  });

  it('refuses an fx_rate_at carrying sub-second precision (§24)', async () => {
    const c = cmd();
    const lines = dbPayload(c.lines) as Record<string, unknown>[];
    must(lines[0])['fx_rate_at'] = '2026-03-14T09:15:00.250Z';
    expect(await refusal(() => postRaw(assertionFor(c, fx.userId), c, lines))).toMatch(/payload_invalid/);
  });
});

describe('idempotency is identity, not a retry counter (§47, §49)', () => {
  it('returns the ORIGINAL entry on an identical retry, and writes nothing a second time', async () => {
    const c = cmd();
    const first = await post(c, fx.userId);
    const second = await post(c, fx.userId);
    expect(second.created).toBe(false);
    expect(second.entryId).toBe(first.entryId);

    const counts = await ownerPool().query<{ entries: number; lines: number; audits: number; outbox: number }>(
      `SELECT (SELECT count(*) FROM journal_entries WHERE business_id = $1 AND source_id = $2)::int AS entries,
              (SELECT count(*) FROM journal_lines WHERE journal_entry_id = $3)::int AS lines,
              (SELECT count(*) FROM audit_events WHERE entity_id = $3::text)::int AS audits,
              (SELECT count(*) FROM outbox_events WHERE payload->>'entryId' = $3::text)::int AS outbox`,
      [fx.businessId, c.sourceId, first.entryId],
    );
    expect(counts.rows[0]).toEqual({ entries: 1, lines: 2, audits: 1, outbox: 1 });
  });

  it('treats a reworded retry as the same fact and does NOT rewrite the posted narrative (§28)', async () => {
    const c = cmd();
    const first = await post(c, fx.userId);
    const retry = await post({ ...c, description: 'reworded after the fact', requestId: 'req-2' }, fx.userId);
    expect(retry.created).toBe(false);
    expect(retry.entryId).toBe(first.entryId);
    const row = await ownerPool().query<{ description: string; request_id: string }>(`SELECT description, request_id FROM journal_entries WHERE id = $1`, [
      first.entryId,
    ]);
    expect(must(row.rows[0]).description).toBe('a balanced posting');
    expect(must(row.rows[0]).request_id).toBe('req-test');
  });

  it('refuses a second posting on the same source describing DIFFERENT financial truth', async () => {
    const c = cmd();
    await post(c, fx.userId);
    const different: PostCommand = { ...c, lines: c.lines.map((l) => ({ ...l, baseAmountMinor: 200000n, txnAmountMinor: 200000n })) };
    expect(await refusal(() => post(different, fx.userId))).toMatch(/idempotency_conflict/);
  });

  it('still recognises a retry after the account it used was deactivated (§30)', async () => {
    const custom = await ownerPool().query<{ id: string }>(
      `INSERT INTO accounts (tenant_id, business_id, code, name, type) VALUES ($1,$2,'C-7001','Retry Asset','asset') RETURNING id`,
      [fx.tenantId, fx.businessId],
    );
    const c: PostCommand = { ...cmd(), lines: [{ ...must(cmd().lines[0]), account: { kind: 'code', code: 'C-7001' } }, must(cmd().lines[1])] };
    const first = await post(c, fx.userId);
    await ownerPool().query(`UPDATE accounts SET is_active = false WHERE id = $1`, [must(custom.rows[0]).id]);
    const retry = await post(c, fx.userId);
    expect(retry.created).toBe(false);
    expect(retry.entryId).toBe(first.entryId);
  });

  it('still recognises a retry after the business timezone changed (§48)', async () => {
    const c = cmd();
    const first = await post(c, fx.userId);
    await ownerPool().query(`UPDATE businesses SET timezone = 'Pacific/Kiritimati' WHERE id = $1`, [fx.businessId]);
    try {
      const retry = await post(c, fx.userId);
      expect(retry.created).toBe(false);
      expect(retry.entryId).toBe(first.entryId);
    } finally {
      await ownerPool().query(`UPDATE businesses SET timezone = 'Asia/Hebron' WHERE id = $1`, [fx.businessId]);
    }
  });

  it('lets exactly one of two CONCURRENT identical postings create the entry (§41)', async () => {
    // The second caller is genuinely concurrent: it issues its posting while
    // the first transaction is still open and holding the advisory lock on
    // that source identity, and it only returns once the first commits.
    const c = cmd();
    const a = await appClient();
    const b = await appClient();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      const ra = await postAs(assertionFor(c, fx.userId), c, {}, a);
      const pending = postAs(assertionFor(c, fx.userId), c, {}, b).catch((e) => e as Error);
      await a.query('COMMIT');
      const rb = await pending;
      await b.query('COMMIT').catch(() => undefined);
      // One of them created it; the other saw the committed entry and
      // returned the same id. Neither may duplicate it.
      expect(ra.created).toBe(true);
      expect(rb instanceof Error ? rb.message : (rb as { created: boolean }).created).toBe(false);
      if (!(rb instanceof Error)) expect(rb.entryId).toBe(ra.entryId);
      const n = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM journal_entries WHERE business_id = $1 AND source_id = $2`, [
        fx.businessId,
        c.sourceId,
      ]);
      expect(must(n.rows[0]).n).toBe(1);
    } finally {
      await a.end().catch(() => undefined);
      await b.end().catch(() => undefined);
    }
  });

  it('never merges two CONCURRENT postings that describe different truth on one source', async () => {
    const c = cmd();
    const other: PostCommand = { ...c, lines: c.lines.map((l) => ({ ...l, baseAmountMinor: 999n, txnAmountMinor: 999n })) };
    const a = await appClient();
    const b = await appClient();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      const ra = await postAs(assertionFor(c, fx.userId), c, {}, a).catch((e) => e as Error);
      const pending = postAs(assertionFor(other, fx.userId), other, {}, b).catch((e) => e as Error);
      await a.query('COMMIT').catch(() => undefined);
      const rb = await pending;
      await b.query('COMMIT').catch(() => undefined);
      expect([ra, rb].filter((r) => !(r instanceof Error))).toHaveLength(1);
      expect(rb instanceof Error ? rb.message : '').toMatch(/idempotency_conflict/);
      const n = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM journal_entries WHERE business_id = $1 AND source_id = $2`, [
        fx.businessId,
        c.sourceId,
      ]);
      expect(must(n.rows[0]).n).toBe(1);
    } finally {
      await a.end().catch(() => undefined);
      await b.end().catch(() => undefined);
    }
  });
});

describe('the account rules (§29, §30, §31)', () => {
  it('refuses a NEW posting naming an inactive account', async () => {
    const acc = await ownerPool().query<{ id: string }>(
      `INSERT INTO accounts (tenant_id, business_id, code, name, type, is_active) VALUES ($1,$2,'C-7100','Closed','asset',false) RETURNING id`,
      [fx.tenantId, fx.businessId],
    );
    expect(acc.rowCount).toBe(1);
    const c: PostCommand = { ...cmd(), lines: [{ ...must(cmd().lines[0]), account: { kind: 'code', code: 'C-7100' } }, must(cmd().lines[1])] };
    expect(await refusal(() => post(c, fx.userId))).toMatch(/account_inactive/);
  });

  it('refuses a system key the business chart does not carry, by that name', async () => {
    const c: PostCommand = { ...cmd(), lines: [{ ...must(cmd().lines[0]), account: { kind: 'system', systemKey: 'no_such_key' } }, must(cmd().lines[1])] };
    expect(await refusal(() => post(c, fx.userId))).toMatch(/system_account_missing/);
  });

  it('refuses a custom code the business does not have', async () => {
    const c: PostCommand = { ...cmd(), lines: [{ ...must(cmd().lines[0]), account: { kind: 'code', code: 'NOPE-1' } }, must(cmd().lines[1])] };
    expect(await refusal(() => post(c, fx.userId))).toMatch(/account_not_found/);
  });

  it('locks the code and type of a custom account once it has posted history (§31)', async () => {
    const acc = await ownerPool().query<{ id: string }>(
      `INSERT INTO accounts (tenant_id, business_id, code, name, type) VALUES ($1,$2,'C-7200','Used Asset','asset') RETURNING id`,
      [fx.tenantId, fx.businessId],
    );
    const id = must(acc.rows[0]).id;
    // Before any history, the code is ordinary editable data.
    await ownerPool().query(`UPDATE accounts SET code = 'C-7201' WHERE id = $1`, [id]);

    const c: PostCommand = { ...cmd(), lines: [{ ...must(cmd().lines[0]), account: { kind: 'code', code: 'C-7201' } }, must(cmd().lines[1])] };
    await post(c, fx.userId);

    await expect(ownerPool().query(`UPDATE accounts SET code = 'C-7202' WHERE id = $1`, [id])).rejects.toThrow(/account_identity_locked/);
    await expect(ownerPool().query(`UPDATE accounts SET type = 'expense' WHERE id = $1`, [id])).rejects.toThrow(/account_identity_locked/);
    // Presentation and lifecycle are not identity.
    await ownerPool().query(`UPDATE accounts SET name = 'Renamed' WHERE id = $1`, [id]);
    await ownerPool().query(`UPDATE accounts SET is_active = false WHERE id = $1`, [id]);
    await ownerPool().query(`UPDATE accounts SET is_active = true WHERE id = $1`, [id]);
  });

  it('scopes that lock by (business_id, id), so another business’s identical id is unaffected', async () => {
    // The trigger reads journal_lines by the composite key. A lock keyed on
    // the account UUID alone would be a different, weaker rule; this asserts
    // the one that was written.
    const r = await ownerPool().query<{ src: string }>(`SELECT pg_get_functiondef('accounts_used_identity_immutable()'::regprocedure) AS src`);
    expect(must(r.rows[0]).src).toContain('jl.business_id = OLD.business_id');
    expect(must(r.rows[0]).src).toContain('jl.account_id = OLD.id');
  });

  it('refuses a line naming a branch of another business, by composite foreign key', async () => {
    const foreignBranch = await ownerPool().query<{ id: string }>(`INSERT INTO branches (business_id, name) VALUES ($1, 'Theirs') RETURNING id`, [
      fx.otherBusinessId,
    ]);
    const c: PostCommand = { ...cmd(), lines: cmd().lines.map((l) => ({ ...l, branchId: must(foreignBranch.rows[0]).id })) };
    expect(await refusal(() => post(c, fx.userId))).toMatch(/journal_lines_branch_fk|violates foreign key/);
  });
});

describe('the posting date policy is data, not a hardcoded branch (§43, §44)', () => {
  it('refuses an entry dated after today in the BUSINESS timezone', async () => {
    const tomorrow = await ownerPool().query<{ d: string }>(`SELECT to_char(((now() AT TIME ZONE 'Asia/Hebron')::date + 1), 'YYYY-MM-DD') AS d`);
    const c = { ...cmd(), entryDate: must(tomorrow.rows[0]).d };
    expect(await refusal(() => post(c, fx.userId))).toMatch(/entry_date_in_future/);
  });

  it('permits a back-dated manual adjustment — `none` is the lower bound policy it carries', async () => {
    const r = await post({ ...cmd(), entryDate: '2025-01-15' }, fx.userId);
    expect(r.created).toBe(true);
  });

  it('reads "today" in the business timezone, not the server’s', async () => {
    // Kiritimati is UTC+14: its civil date is ahead of UTC for ten hours of
    // every day. A server-date comparison would refuse a legitimate entry.
    const tenant = await ownerPool().query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`);
    const biz = await ownerPool().query<{ id: string }>(
      `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
       VALUES ($1,'Far East',$2,'PS','ILS','Pacific/Kiritimati') RETURNING id`,
      [must(tenant.rows[0]).id, `posting-far-${Date.now()}`],
    );
    const far: PostingFixture = { ...fx, tenantId: must(tenant.rows[0]).id, businessId: must(biz.rows[0]).id };
    const localToday = await todayIn(ownerPool(), 'Pacific/Kiritimati');
    const ok = await post(simpleCommand(far, randomUUID(), localToday), fx.userId);
    expect(ok.created).toBe(true);

    const beyond = await ownerPool().query<{ d: string }>(`SELECT to_char(((now() AT TIME ZONE 'Pacific/Kiritimati')::date + 1), 'YYYY-MM-DD') AS d`);
    expect(await refusal(() => post(simpleCommand(far, randomUUID(), must(beyond.rows[0]).d), fx.userId))).toMatch(/entry_date_in_future/);
  });

  it('refuses a reversal dated before the entry it reverses, and permits one dated on or after it', async () => {
    const origin = await post({ ...cmd(), entryDate: '2025-06-10' }, fx.userId);
    const before: PostCommand = { ...cmd(origin.entryId, 'reversal'), entryDate: '2025-06-09' };
    expect(await refusal(() => post(before, fx.userId))).toMatch(/entry_date_before_original/);

    const sameDay: PostCommand = { ...cmd(origin.entryId, 'reversal'), entryDate: '2025-06-10' };
    expect((await post(sameDay, fx.userId)).created).toBe(true);

    const origin2 = await post({ ...cmd(), entryDate: '2025-06-10' }, fx.userId);
    const after: PostCommand = { ...cmd(origin2.entryId, 'reversal'), entryDate: '2025-06-11' };
    expect((await post(after, fx.userId)).created).toBe(true);
  });

  it('refuses a source type the registry does not carry', async () => {
    const c = cmd(randomUUID(), 'not_registered');
    expect(await refusal(() => post(c, fx.userId))).toMatch(/unregistered source type|payload_invalid/);
  });
});

describe('the exact payload schema (§26)', () => {
  const bad = (mutate: (lines: Record<string, unknown>[]) => void): unknown => {
    const c = cmd();
    const lines = dbPayload(c.lines) as Record<string, unknown>[];
    mutate(lines);
    return { c, lines };
  };

  const cases: ReadonlyArray<readonly [string, (l: Record<string, unknown>[]) => void, RegExp]> = [
    ['an unknown field', (l) => (must(l[0])['extra'] = 'x'), /payload_unknown_field/],
    ['a missing field', (l) => delete must(l[0])['memo'], /payload_missing_field/],
    ['a JSON number for money', (l) => (must(l[0])['base_amount_minor'] = 150000), /payload_invalid/],
    ['a JSON number for a rate', (l) => (must(l[0])['fx_rate'] = 1), /payload_invalid/],
    ['a rate with the wrong precision', (l) => (must(l[0])['fx_rate'] = '1.00'), /payload_invalid/],
    ['a zero amount', (l) => (must(l[0])['base_amount_minor'] = '0'), /payload_invalid/],
    ['a negative amount', (l) => (must(l[0])['base_amount_minor'] = '-1'), /payload_invalid/],
    ['an amount with a leading zero', (l) => (must(l[0])['base_amount_minor'] = '0150000'), /payload_invalid/],
    ['a side that is neither D nor C', (l) => (must(l[0])['side'] = 'X'), /payload_invalid/],
    ['an unknown rate source', (l) => (must(l[0])['fx_rate_source'] = 'guess'), /payload_invalid/],
    ['an account reference of an unknown kind', (l) => (must(l[0])['account'] = { kind: 'uuid', id: randomUUID() }), /payload_invalid/],
    ['an empty account code', (l) => (must(l[0])['account'] = { kind: 'code', code: '' }), /payload_invalid/],
  ];

  for (const [what, mutate, expected] of cases) {
    it(`refuses ${what}`, async () => {
      const { c, lines } = bad(mutate) as { c: PostCommand; lines: unknown[] };
      expect(await refusal(() => postRaw(assertionFor(c, fx.userId), c, lines))).toMatch(expected);
    });
  }

  it('refuses a single-line posting before it looks at anything else', async () => {
    const c = cmd();
    const lines = (dbPayload(c.lines) as unknown[]).slice(0, 1);
    expect(await refusal(() => postRaw(assertionFor(c, fx.userId), c, lines))).toMatch(/payload_invalid/);
  });

  it('refuses an unbalanced entry — the frozen 0043 validator, reached through the writer', async () => {
    const c = cmd();
    const unbalanced: PostCommand = { ...c, lines: [{ ...must(c.lines[0]), baseAmountMinor: 100n, txnAmountMinor: 100n }, must(c.lines[1])] };
    expect(await refusal(() => post(unbalanced, fx.userId))).toMatch(/accounting\./);
  });

  it('refuses an amount above the money cap', async () => {
    const c = cmd();
    const over = 1_000_000_000_000_000_001n;
    const huge: PostCommand = { ...c, lines: c.lines.map((l) => ({ ...l, baseAmountMinor: over, txnAmountMinor: over })) };
    expect(await refusal(() => post(huge, fx.userId))).toMatch(/money|check constraint|violates/i);
  });
});

describe('first financial activity (§38)', () => {
  it('stamps financial_started_at on the first successful posting and never again', async () => {
    const tenant = await ownerPool().query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`);
    const biz = await ownerPool().query<{ id: string }>(
      `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
       VALUES ($1,'Fresh',$2,'PS','ILS','Asia/Hebron') RETURNING id`,
      [must(tenant.rows[0]).id, `posting-fresh-${Date.now()}`],
    );
    const fresh: PostingFixture = { ...fx, tenantId: must(tenant.rows[0]).id, businessId: must(biz.rows[0]).id };

    const before = await ownerPool().query<{ v: Date | null }>(`SELECT financial_started_at AS v FROM businesses WHERE id = $1`, [fresh.businessId]);
    expect(must(before.rows[0]).v).toBeNull();

    await post(simpleCommand(fresh, randomUUID(), today), fx.userId);
    const after = await ownerPool().query<{ v: Date | null }>(`SELECT financial_started_at AS v FROM businesses WHERE id = $1`, [fresh.businessId]);
    expect(must(after.rows[0]).v).not.toBeNull();

    await post(simpleCommand(fresh, randomUUID(), today), fx.userId);
    const later = await ownerPool().query<{ v: Date }>(`SELECT financial_started_at AS v FROM businesses WHERE id = $1`, [fresh.businessId]);
    expect(must(later.rows[0]).v.toISOString()).toBe(must(must(after.rows[0]).v).toISOString());
  });

  it('leaves it NULL when the first posting rolls back — it can never exist without an entry', async () => {
    const tenant = await ownerPool().query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`);
    const biz = await ownerPool().query<{ id: string }>(
      `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
       VALUES ($1,'Rolled',$2,'PS','ILS','Asia/Hebron') RETURNING id`,
      [must(tenant.rows[0]).id, `posting-rolled-${Date.now()}`],
    );
    const rolled: PostingFixture = { ...fx, tenantId: must(tenant.rows[0]).id, businessId: must(biz.rows[0]).id };
    const c = simpleCommand(rolled, randomUUID(), today);
    const client = await appClient();
    try {
      await client.query('BEGIN');
      await postAs(assertionFor(c, fx.userId), c, {}, client);
      await client.query('ROLLBACK');
    } finally {
      await client.end().catch(() => undefined);
    }
    const r = await ownerPool().query<{ v: Date | null; n: number }>(
      `SELECT b.financial_started_at AS v, (SELECT count(*)::int FROM journal_entries WHERE business_id = b.id) AS n
       FROM businesses b WHERE b.id = $1`,
      [rolled.businessId],
    );
    expect(must(r.rows[0]).v).toBeNull();
    expect(must(r.rows[0]).n).toBe(0);
  });

  it('refuses every hand other than the posting authority — set, changed or cleared', async () => {
    // A business the app credential can genuinely see and that has NO stamp
    // yet, so the refusal comes from the authority rule and not from RLS
    // silently matching zero rows or from the immutability branch.
    const tenant = await ownerPool().query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`);
    const biz = await ownerPool().query<{ id: string }>(
      `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
       VALUES ($1,'Unstamped',$2,'PS','ILS','Asia/Hebron') RETURNING id`,
      [must(tenant.rows[0]).id, `posting-unstamped-${Date.now()}`],
    );
    const client = await appClient();
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [must(tenant.rows[0]).id]);
      await client.query(`SELECT set_config('app.business_id', $1, false)`, [must(biz.rows[0]).id]);
      const visible = await client.query(`SELECT 1 FROM businesses WHERE id = $1`, [must(biz.rows[0]).id]);
      expect(visible.rowCount).toBe(1); // the credential really can reach this row
      await expect(client.query(`UPDATE businesses SET financial_started_at = now() WHERE id = $1`, [must(biz.rows[0]).id])).rejects.toThrow(
        /financial_start_forbidden|permission denied/,
      );
    } finally {
      await client.end().catch(() => undefined);
    }
    // Not even the schema owner may change or clear an established stamp.
    await expect(ownerPool().query(`UPDATE businesses SET financial_started_at = now() WHERE id = $1`, [fx.businessId])).rejects.toThrow(
      /financial_start_immutable/,
    );
    await expect(ownerPool().query(`UPDATE businesses SET financial_started_at = NULL WHERE id = $1`, [fx.businessId])).rejects.toThrow(
      /financial_start_immutable/,
    );
  });
});

describe('atomicity (§37, §62)', () => {
  it('leaves no entry, no line, no binding, no audit and no outbox row behind a refused posting', async () => {
    const c = cmd();
    const unbalanced: PostCommand = { ...c, lines: [{ ...must(c.lines[0]), baseAmountMinor: 77n, txnAmountMinor: 77n }, must(c.lines[1])] };
    await refusal(() => post(unbalanced, fx.userId));
    const r = await ownerPool().query<{ entries: number; bindings: number; audits: number; outbox: number }>(
      `SELECT (SELECT count(*) FROM journal_entries WHERE business_id = $1 AND source_id = $2)::int AS entries,
              (SELECT count(*) FROM accounting_source_bindings WHERE business_id = $1 AND source_id = $2)::int AS bindings,
              (SELECT count(*) FROM audit_events WHERE metadata->>'sourceId' = $2::text)::int AS audits,
              (SELECT count(*) FROM outbox_events WHERE payload->>'sourceId' = $2::text)::int AS outbox`,
      [fx.businessId, c.sourceId],
    );
    expect(r.rows[0]).toEqual({ entries: 0, bindings: 0, audits: 0, outbox: 0 });
  });

  it('rolls the audit and outbox rows back with the entry when the caller aborts after a successful post', async () => {
    const c = cmd();
    const client = await appClient();
    try {
      await client.query('BEGIN');
      const r = await postAs(assertionFor(c, fx.userId), c, {}, client);
      expect(r.created).toBe(true);
      await client.query('ROLLBACK');
    } finally {
      await client.end().catch(() => undefined);
    }
    const after = await ownerPool().query<{ entries: number; audits: number; outbox: number }>(
      `SELECT (SELECT count(*) FROM journal_entries WHERE business_id = $1 AND source_id = $2)::int AS entries,
              (SELECT count(*) FROM audit_events WHERE metadata->>'sourceId' = $2::text)::int AS audits,
              (SELECT count(*) FROM outbox_events WHERE payload->>'sourceId' = $2::text)::int AS outbox`,
      [fx.businessId, c.sourceId],
    );
    expect(after.rows[0]).toEqual({ entries: 0, audits: 0, outbox: 0 });
  });
});
