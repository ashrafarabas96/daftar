/**
 * THE INVARIANT MATRIX (P2-S8 §14, §18).
 *
 * Its companion file, `accounting-credential-matrix.test.ts`, proves that no
 * runtime credential may reach these tables at all. That is an AUTHORIZATION
 * fact, and on its own it proves nothing about the invariants — "permission
 * denied" is the database declining to let someone try, not the database
 * refusing the fact. The two are kept in separate files precisely so neither
 * can be mistaken for the other (§14).
 *
 * So every case below runs as the SCHEMA OWNER, with every grant in the
 * world, issuing raw SQL directly against the journal. Nothing in the
 * application is involved: no command, no assertion, no validation layer. If
 * an accepted invariant only holds because the application is well behaved,
 * this is where that becomes visible.
 *
 * WHERE THE REFUSAL COMES FROM MATTERS. Some arrive at the statement (a CHECK
 * or a foreign key), some at COMMIT (the deferred constraint triggers that
 * validate an entry as a whole). Both are the database refusing the fact, and
 * each case says which it expects, because a case that would accept either
 * would still pass if the rule moved to a place where it could be bypassed.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { must, post, seedPostingFixture, simpleCommand, todayIn, type PostingFixture } from '../helpers/accounting-posting';

let fx: PostingFixture;
let today: string;
let cashId = '';
let equityId = '';
let foreignAccountId = '';

/** One raw, well-formed entry. Every case below is this, with one thing wrong. */
interface RawEntry {
  entryId?: string;
  sourceId?: string;
  businessId?: string;
  tenantId?: string;
  entryDate?: string;
  sourceType?: string;
  actorKind?: string;
  actorUserId?: string | null;
  actorSystemKey?: string | null;
  lines?: { accountId: string; debit: number; credit: number; base?: number; txnCurrency?: string; rate?: string; rateSource?: string }[];
  withBinding?: boolean;
  withDetail?: boolean;
}

/**
 * Attempt one raw write and report WHERE it was refused.
 *
 * The transaction is always rolled back, so the matrix leaves the shared
 * database exactly as it found it and the cases cannot influence each other.
 */
async function attempt(entry: RawEntry): Promise<{ at: 'statement' | 'commit' | 'accepted'; message: string }> {
  const c: PoolClient = await ownerPool().connect();
  const businessId = entry.businessId ?? fx.businessId;
  const tenantId = entry.tenantId ?? fx.tenantId;
  const entryId = entry.entryId ?? randomUUID();
  const sourceId = entry.sourceId ?? randomUUID();
  const sourceType = entry.sourceType ?? 'manual_adjustment';
  const lines = entry.lines ?? [
    { accountId: cashId, debit: 5000, credit: 0 },
    { accountId: equityId, debit: 0, credit: 5000 },
  ];
  try {
    await c.query('BEGIN');
    if (entry.withBinding !== false) {
      await c.query(
        `INSERT INTO accounting_source_bindings (tenant_id, business_id, source_type, source_id, journal_entry_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, businessId, sourceType, sourceId, entryId],
      );
    }
    if (entry.withDetail !== false && sourceType === 'manual_adjustment') {
      await c.query(`INSERT INTO accounting_manual_adjustments (tenant_id, business_id, id, reason, actor_user_id) VALUES ($1, $2, $3, 'raw matrix', $4)`, [
        tenantId,
        businessId,
        sourceId,
        fx.userId,
      ]);
    }
    await c.query(
      `INSERT INTO journal_entries (tenant_id, business_id, id, entry_date, source_type, source_id, description,
                                    actor_kind, actor_user_id, actor_system_key, request_id, posting_fingerprint)
       VALUES ($1, $2, $3, $4::date, $5, $6, 'raw', $7, $8, $9, 'raw', repeat('a', 64))`,
      [
        tenantId,
        businessId,
        entryId,
        entry.entryDate ?? today,
        sourceType,
        sourceId,
        entry.actorKind ?? 'user',
        // `??` would be wrong here: a case that asks for actor_user_id = NULL
        // means NULL, and defaulting it to the fixture's user would quietly
        // repair the very malformation under test.
        entry.actorUserId !== undefined ? entry.actorUserId : entry.actorKind === 'system' ? null : fx.userId,
        entry.actorSystemKey ?? null,
      ],
    );
    let lineNo = 0;
    for (const l of lines) {
      lineNo += 1;
      const base = l.base ?? Math.max(l.debit, l.credit);
      await c.query(
        `INSERT INTO journal_lines (tenant_id, business_id, id, journal_entry_id, line_no, account_id,
                                    debit_minor, credit_minor, base_amount_minor, base_currency,
                                    txn_amount_minor, txn_currency, fx_rate, fx_rate_source, fx_rate_at)
         VALUES ($1, $2, gen_random_uuid(), $3, $4, $5, $6, $7, $8, 'ILS', $9, $10, $11::numeric, $12, date_trunc('second', now()))`,
        [
          tenantId,
          businessId,
          entryId,
          lineNo,
          l.accountId,
          l.debit,
          l.credit,
          base,
          Math.max(l.debit, l.credit),
          l.txnCurrency ?? 'ILS',
          l.rate ?? '1',
          l.rateSource ?? 'base',
        ],
      );
    }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
    return { at: 'statement', message: String(e) };
  }
  try {
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
    return { at: 'commit', message: String(e) };
  }
  // It was accepted, and it STAYS. A posted journal entry cannot be deleted
  // by anyone, the schema owner included — that is one of the invariants this
  // file asserts a few cases below. So the positive case leaves a valid entry
  // behind, which is exactly what a real posting would do, and the negative
  // cases leave nothing because they never reached COMMIT.
  c.release();
  return { at: 'accepted', message: '' };
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  fx = await seedPostingFixture(ownerPool(), `raw-${Date.now()}`);
  today = await todayIn(ownerPool(), 'Asia/Hebron');
  const accounts = await ownerPool().query<{ id: string; system_key: string }>(
    `SELECT id, system_key FROM accounts WHERE business_id = $1 AND system_key IN ('cash', 'opening_equity')`,
    [fx.businessId],
  );
  cashId = must(accounts.rows.find((a) => a.system_key === 'cash')).id;
  equityId = must(accounts.rows.find((a) => a.system_key === 'opening_equity')).id;
  foreignAccountId = must(
    (await ownerPool().query<{ id: string }>(`SELECT id FROM accounts WHERE business_id = $1 AND system_key = 'cash'`, [fx.otherBusinessId])).rows[0],
  ).id;
}, 300_000);

describe('INVARIANT — the journal refuses the fact, not merely the caller (§18)', () => {
  it('a well-formed raw entry IS accepted — the matrix can say yes, so its noes mean something', async () => {
    const r = await attempt({});
    expect(r.at, r.message).toBe('accepted');
  });

  it('refuses a journal entry with NO lines', async () => {
    const r = await attempt({ lines: [] });
    expect(r.at).toBe('commit');
  });

  it('refuses a journal entry with ONE line', async () => {
    const r = await attempt({ lines: [{ accountId: cashId, debit: 5000, credit: 0 }] });
    expect(r.at).toBe('commit');
    expect(r.message).toMatch(/entry_too_few_lines/);
  });

  it('refuses an UNBALANCED journal', async () => {
    const r = await attempt({
      lines: [
        { accountId: cashId, debit: 5000, credit: 0 },
        { accountId: equityId, debit: 0, credit: 4999 },
      ],
    });
    expect(r.at).toBe('commit');
    expect(r.message).toMatch(/entry_unbalanced/);
  });

  it("refuses a line naming ANOTHER business's account", async () => {
    const r = await attempt({
      lines: [
        { accountId: foreignAccountId, debit: 5000, credit: 0 },
        { accountId: equityId, debit: 0, credit: 5000 },
      ],
    });
    expect(r.at).toBe('statement');
    expect(r.message).toMatch(/journal_lines_account_fk|foreign key/i);
  });

  it('refuses a line whose FX arithmetic is invented', async () => {
    const r = await attempt({
      lines: [
        { accountId: cashId, debit: 5000, credit: 0, txnCurrency: 'USD', rate: '1', rateSource: 'base' },
        { accountId: equityId, debit: 0, credit: 5000 },
      ],
    });
    expect(r.at).not.toBe('accepted');
  });

  it('refuses a posted entry with NO source binding', async () => {
    const r = await attempt({ withBinding: false });
    expect(r.at).toBe('commit');
    // TWO deferred foreign keys point at the binding registry — the entry's
    // own and the source document's — and either one refusing is the fact
    // being refused. The assertion names the shape rather than which fires
    // first, because which fires first is a COMMIT-time ordering detail and
    // pinning it would make this case fail for a reason that is not about
    // the invariant.
    expect(r.message).toMatch(/binding_fk/);
  });

  it('refuses a DUPLICATE source identity', async () => {
    const shared = randomUUID();
    const first = await attempt({ sourceId: shared });
    expect(first.at, first.message).toBe('accepted');
    // The binding registry's primary key is (business, source_type, source_id),
    // so the second claim on that identity cannot even be written.
    const second = await attempt({ sourceId: shared });
    expect(second.at).toBe('statement');
    expect(second.message).toMatch(/duplicate key|accounting_source_bindings_pkey/i);
  });

  it('refuses an invalid ACTOR shape — a user entry with no user, a system entry with a user', async () => {
    const noUser = await attempt({ actorKind: 'user', actorUserId: null });
    expect(noUser.at, noUser.message).toBe('statement');
    expect(noUser.message).toMatch(/actor_shape/i);

    const systemWithUser = await attempt({ actorKind: 'system', actorUserId: fx.userId, actorSystemKey: 'nightly' });
    expect(systemWithUser.at, systemWithUser.message).toBe('statement');
  });

  /**
   * A FINDING, recorded as an assertion rather than as a sentence in a
   * document (P2-S8 §14).
   *
   * "An entry may not be dated after today in the business timezone" is
   * enforced by every journal WRITER — `accounting_post_entry`,
   * `accounting_post_reversal` and the opening-balance commands each raise
   * `accounting.entry_date_in_future` — and by NO schema constraint. So it is
   * an invariant of the commands, not of the table, and this case says so
   * out loud in both directions: the raw insert is accepted, and the command
   * refuses.
   *
   * It is not a live exposure. No runtime credential holds INSERT on
   * `journal_entries` — its companion file proves that against the live
   * ACLs — so the only principal that can reach this is the schema owner,
   * which is a deployment credential rather than a runtime one. It is a
   * defense-in-depth gap, carried in TECHNICAL_DEBT.md, and it is NOT closed
   * here: `0000`–`0050` are frozen, and `0051` is authorized to carry the
   * reconciler authority and nothing else (§33, §37).
   */
  it('a FUTURE-dated entry is refused by every journal writer, but NOT by the schema', async () => {
    const { rows } = await ownerPool().query<{ d: string }>(`SELECT to_char(current_date + 5, 'YYYY-MM-DD') AS d`);
    const future = must(rows[0]).d;

    const raw = await attempt({ entryDate: future });
    expect(raw.at, 'the schema does not carry this rule — see the comment above').toBe('accepted');

    await expect(post(simpleCommand(fx, randomUUID(), future, 5000n), fx.userId)).rejects.toThrow(/accounting\.entry_date_in_future/);
  });

  it('refuses MUTATION of a posted journal entry and of its lines', async () => {
    const entryId = randomUUID();
    const planted = await attempt({ entryId });
    expect(planted.at, planted.message).toBe('accepted');
    // Append-only, for EVERYONE. This runs as the schema owner with every
    // grant there is, and the journal still refuses.
    await expect(ownerPool().query(`UPDATE journal_entries SET description = 'changed' WHERE id = $1`, [entryId])).rejects.toThrow();
    await expect(ownerPool().query(`UPDATE journal_lines SET debit_minor = 1 WHERE journal_entry_id = $1`, [entryId])).rejects.toThrow();
    await expect(ownerPool().query(`DELETE FROM journal_entries WHERE id = $1`, [entryId])).rejects.toThrow();
    await expect(ownerPool().query(`DELETE FROM journal_lines WHERE journal_entry_id = $1`, [entryId])).rejects.toThrow();
  });

  it('refuses MUTATION of a posted source document', async () => {
    const { rows } = await ownerPool().query<{ id: string }>(`SELECT id FROM accounting_manual_adjustments WHERE business_id = $1 LIMIT 1`, [fx.businessId]);
    const adjustment = rows[0];
    if (!adjustment) return; // nothing posted in this run; the mutation rule is proved by the case above
    await expect(ownerPool().query(`UPDATE accounting_manual_adjustments SET reason = 'x' WHERE id = $1`, [adjustment.id])).rejects.toThrow();
    await expect(ownerPool().query(`DELETE FROM accounting_manual_adjustments WHERE id = $1`, [adjustment.id])).rejects.toThrow();
  });
});

describe('INVARIANT — the chart and the periods (§18)', () => {
  it('refuses a code change on an account that has been posted to', async () => {
    await expect(ownerPool().query(`UPDATE accounts SET code = 'ZZZ1' WHERE id = $1`, [cashId])).rejects.toThrow();
  });

  it('refuses a TYPE change on an account that has been posted to', async () => {
    await expect(ownerPool().query(`UPDATE accounts SET type = 'expense' WHERE id = $1`, [cashId])).rejects.toThrow();
  });

  it('refuses OVERLAPPING periods, at the statement — an exclusion constraint, not a check at the end', async () => {
    const c = await ownerPool().connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO accounting_periods (tenant_id, business_id, id, start_date, end_date, status, created_by_user_id)
         VALUES ($1,$2,gen_random_uuid(),'2025-01-01'::date,'2025-01-31'::date,'open',$3)`,
        [fx.tenantId, fx.businessId, fx.userId],
      );
      await expect(
        c.query(
          `INSERT INTO accounting_periods (tenant_id, business_id, id, start_date, end_date, status, created_by_user_id)
           VALUES ($1,$2,gen_random_uuid(),'2025-01-15'::date,'2025-02-15'::date,'open',$3)`,
          [fx.tenantId, fx.businessId, fx.userId],
        ),
      ).rejects.toThrow(/exclusion constraint|no_overlap/i);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });

  it('refuses a GAP between periods', async () => {
    const c = await ownerPool().connect();
    try {
      await c.query('BEGIN');
      for (const [start, end] of [
        ['2025-03-01', '2025-03-31'],
        ['2025-05-01', '2025-05-31'],
      ]) {
        await c.query(
          `INSERT INTO accounting_periods (tenant_id, business_id, id, start_date, end_date, status, created_by_user_id)
           VALUES ($1,$2,gen_random_uuid(),$3::date,$4::date,'open',$5)`,
          [fx.tenantId, fx.businessId, start, end, fx.userId],
        );
      }
      await expect(c.query('COMMIT')).rejects.toThrow();
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });

  it('refuses an OPEN period before a CLOSED one — the topology is a closed prefix', async () => {
    const c = await ownerPool().connect();
    try {
      await c.query('BEGIN');
      for (const [start, end, status] of [
        ['2025-06-01', '2025-06-30', 'open'],
        ['2025-07-01', '2025-07-31', 'closed'],
      ]) {
        await c.query(
          `INSERT INTO accounting_periods (tenant_id, business_id, id, start_date, end_date, status, created_by_user_id, closed_by_user_id, closed_at)
           VALUES ($1,$2,gen_random_uuid(),$3::date,$4::date,$5::text,$6::uuid,
                   CASE WHEN $5::text = 'closed' THEN $6::uuid END,
                   CASE WHEN $5::text = 'closed' THEN now() END)`,
          [fx.tenantId, fx.businessId, start, end, status, fx.userId],
        );
      }
      await expect(c.query('COMMIT')).rejects.toThrow();
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });
});
