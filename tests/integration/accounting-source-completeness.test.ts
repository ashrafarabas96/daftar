import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  appClient,
  dbPayload,
  fingerprintOf,
  must,
  postAdjustmentAs,
  seedPostingFixture,
  simpleCommand,
  sourceAssertion,
  todayIn,
  type PostCommand,
  type PostingFixture,
} from '../helpers/accounting-posting';

/**
 * MATRIX — SOURCE COMPLETENESS, IN BOTH DIRECTIONS (round three, §2-§7).
 *
 * `accounting_post_entry` is generic on purpose: it posts whatever source
 * type the verified assertion names. That genericity is what makes a later
 * phase's sale or invoice a thin derivation in front of one hardened
 * primitive instead of a second ledger writer. It is also, until this matrix
 * exists, a way past the three commands Phase 2 owns.
 *
 * An assertion for `post` / `manual_adjustment` is not a forgery. It is
 * exactly the assertion `accounting_post_manual_adjustment` carries, so
 * anyone able to mint one can drive the primitive DIRECTLY and get an entry,
 * its lines, its binding, its audit row and its outbox row while the detail
 * table stays empty. The adjustment then exists in the ledger with no reason
 * and no actor: the one source whose entire justification is "a person
 * decided this" would be the one that records neither who nor why.
 *
 * Nobody has to be hostile to arrive there, which is the real argument. The
 * engine exposes `post()` next to `adjust()` and takes the source type as a
 * string; a domain written next year will reach for the general one.
 *
 * So each case here mints a REAL assertion and calls the REAL primitive as
 * the REAL runtime role, and then asserts on the COMMIT. A case that stopped
 * at `permission denied` would prove something about a grant and nothing
 * about the invariant it claims to be testing.
 *
 * The other direction is asserted too: a detail row whose source binding does
 * not exist must not commit either. Neither end may be an orphan.
 */

let today: string;

const DETAIL_MISSING: Record<string, RegExp> = {
  manual_adjustment: /accounting\.adjustment_detail_missing/,
  reversal: /accounting\.reversal_detail_missing/,
  opening_balance: /accounting\.opening_balance_detail_missing/,
};

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  today = await todayIn(ownerPool(), 'Asia/Hebron');
}, 180_000);

/** A fresh business, so every count below is absolute rather than a delta. */
async function fresh(tag: string): Promise<PostingFixture> {
  return seedPostingFixture(ownerPool(), `compl-${tag}-${Math.floor(Math.random() * 1e6)}`);
}

interface Counts {
  entries: number;
  lines: number;
  bindings: number;
  adjustments: number;
  reversals: number;
  openings: number;
  audits: number;
  outbox: number;
}

async function countsFor(businessId: string): Promise<Counts> {
  const r = await ownerPool().query<Counts>(
    `SELECT (SELECT count(*) FROM journal_entries             WHERE business_id = $1)::int AS entries,
            (SELECT count(*) FROM journal_lines               WHERE business_id = $1)::int AS lines,
            (SELECT count(*) FROM accounting_source_bindings  WHERE business_id = $1)::int AS bindings,
            (SELECT count(*) FROM accounting_manual_adjustments WHERE business_id = $1)::int AS adjustments,
            (SELECT count(*) FROM accounting_reversals        WHERE business_id = $1)::int AS reversals,
            (SELECT count(*) FROM accounting_opening_balances WHERE business_id = $1)::int AS openings,
            (SELECT count(*) FROM audit_events                WHERE business_id = $1 AND action LIKE 'accounting.%')::int AS audits,
            (SELECT count(*) FROM outbox_events               WHERE business_id = $1 AND type   LIKE 'accounting.%')::int AS outbox`,
    [businessId],
  );
  return must(r.rows[0]);
}

/**
 * Drive the primitive directly under a real authority and return whatever the
 * COMMIT does. The statement itself is expected to SUCCEED — the completeness
 * triggers are DEFERRABLE INITIALLY DEFERRED, so the row is written and the
 * question is only asked when the transaction tries to become true.
 */
async function directPost(fx: PostingFixture, sourceType: string, sourceId: string): Promise<{ statement: Error | null; commit: Error | null }> {
  const c: PostCommand = { ...simpleCommand(fx, sourceId, today, 150000n, sourceType), requestId: 'req-direct' };
  const assertion = sourceAssertion({
    actorUserId: fx.userId,
    tenantId: fx.tenantId,
    businessId: fx.businessId,
    operationKind: 'post',
    sourceType,
    sourceId,
    postingFingerprint: fingerprintOf(c),
  });
  const conn = await appClient();
  let statement: Error | null = null;
  let commit: Error | null = null;
  try {
    await conn.query('BEGIN');
    await conn.query(`SELECT set_config('app.accounting_assertion', $1, true)`, [assertion]);
    try {
      await conn.query(`SELECT entry_id, created FROM accounting_post_entry($1::date, $2, $3, $4::jsonb)`, [
        c.entryDate,
        c.description ?? 'a direct posting',
        c.requestId,
        JSON.stringify(dbPayload(c.lines)),
      ]);
    } catch (e) {
      statement = e as Error;
    }
    try {
      await conn.query('COMMIT');
    } catch (e) {
      commit = e as Error;
      await conn.query('ROLLBACK').catch(() => undefined);
    }
  } finally {
    await conn.end().catch(() => undefined);
  }
  return { statement, commit };
}

// ── §2-§5: the journal entry may not exist without its source detail ──────

describe('a native source entry written straight through the primitive cannot commit (§2-§5)', () => {
  for (const sourceType of ['manual_adjustment', 'reversal', 'opening_balance']) {
    it(`${sourceType}: the statement passes, the COMMIT does not, and nothing survives`, async () => {
      const fx = await fresh(sourceType.slice(0, 6));
      const { statement, commit } = await directPost(fx, sourceType, randomUUID());

      // The statement is allowed to proceed: that is what DEFERRED means, and
      // asserting it here is what distinguishes a completeness rule from a
      // plain NOT NULL that would have stopped the INSERT.
      expect(statement, `the ${sourceType} statement was refused before COMMIT`).toBeNull();

      const message = must(commit, `a COMMIT failure for ${sourceType}`).message;
      expect(message).toMatch(must(DETAIL_MISSING[sourceType], 'an expected code'));
      // A stable domain code, and no index name, constraint name or amount.
      expect(message).not.toMatch(/duplicate key|unique constraint|23505|permission denied/);
      expect(message).not.toContain('150000');

      expect(await countsFor(fx.businessId)).toEqual({
        entries: 0,
        lines: 0,
        bindings: 0,
        adjustments: 0,
        reversals: 0,
        openings: 0,
        audits: 0,
        outbox: 0,
      });
    });
  }

  it('the refusal is the INVARIANT, not a missing grant (§5)', async () => {
    // If `daftar_app` simply could not execute the primitive, every case
    // above would pass for the wrong reason forever. It can, and the proof is
    // that the same role posts a complete adjustment through the owning
    // command in the very next suite.
    const fx = await fresh('grant');
    const { statement } = await directPost(fx, 'manual_adjustment', randomUUID());
    expect(statement).toBeNull();
  });
});

// ── §7: and the source detail may not exist without its binding ───────────

describe('a source detail row written without its binding cannot commit either (§7)', () => {
  /**
   * One transaction as the schema owner, deliberately: the DEFERRED foreign
   * key is what must answer, and a runtime role would stop on a missing
   * INSERT grant long before reaching it.
   */
  async function ownerTxn(run: (c: PoolClient) => Promise<void>): Promise<Error | null> {
    const conn = await ownerPool().connect();
    try {
      await conn.query('BEGIN');
      await run(conn);
      await conn.query('COMMIT');
      return null;
    } catch (e) {
      await conn.query('ROLLBACK').catch(() => undefined);
      return e as Error;
    } finally {
      conn.release();
    }
  }

  it('a manual adjustment detail with no source binding', async () => {
    const fx = await fresh('mad');
    const err = await ownerTxn(async (c) => {
      await c.query(`INSERT INTO accounting_manual_adjustments (tenant_id, business_id, id, reason, actor_user_id) VALUES ($1, $2, $3, 'orphan', $4)`, [
        fx.tenantId,
        fx.businessId,
        randomUUID(),
        fx.userId,
      ]);
    });
    expect(must(err, 'a COMMIT failure').message).toMatch(/accounting_manual_adjustments_binding_fk|foreign key/i);
    expect((await countsFor(fx.businessId)).adjustments).toBe(0);
  });

  it('a reversal registration with no source binding', async () => {
    const fx = await fresh('rev');
    // Two real entries, so the composite FKs to `journal_entries` are
    // satisfied and the DEFERRED binding FK is what actually answers.
    const a = adjustment(fx, 150000n);
    const b = adjustment(fx, 250000n);
    const first = await postAdjustmentAs(a.assertion, a.command, 'the first fact');
    const second = await postAdjustmentAs(b.assertion, b.command, 'the second fact');
    const err = await ownerTxn(async (c) => {
      await c.query(
        `INSERT INTO accounting_reversals (tenant_id, business_id, id, original_entry_id, journal_entry_id, reason, actor_kind, actor_user_id)
         VALUES ($1, $2, $3, $3, $4, 'orphan', 'user', $5)`,
        [fx.tenantId, fx.businessId, first.entryId, second.entryId, fx.userId],
      );
    });
    expect(must(err, 'a COMMIT failure').message).toMatch(/accounting_reversals_binding_fk|foreign key/i);
    expect((await countsFor(fx.businessId)).reversals).toBe(0);
  });

  it('a posted opening balance with no journal entry and no binding', async () => {
    const fx = await fresh('ob');
    const id = randomUUID();
    const err = await ownerTxn(async (c) => {
      await c.query(
        `INSERT INTO accounting_opening_balances (tenant_id, business_id, id, status, as_of_date, journal_entry_id, binding_source_id, actor_user_id, posted_at)
         VALUES ($1, $2, $3, 'posted', $4, $5, $3, $6, now())`,
        [fx.tenantId, fx.businessId, id, today, randomUUID(), fx.userId],
      );
    });
    expect(must(err, 'a COMMIT failure').message).toMatch(/accounting_opening_balances_(entry|binding)_fk|foreign key/i);
    expect((await countsFor(fx.businessId)).openings).toBe(0);
  });
});

// ── §6: and the owning command is untouched ───────────────────────────────

/** The command and the authority that signs exactly it, as one value. */
function adjustment(fx: PostingFixture, amount = 150000n): { command: PostCommand; assertion: string } {
  const sourceId = randomUUID();
  const command = simpleCommand(fx, sourceId, today, amount);
  return { command, assertion: adjustmentAssertion(fx, sourceId, amount) };
}

function adjustmentAssertion(fx: PostingFixture, sourceId: string, amount = 150000n): string {
  const c = simpleCommand(fx, sourceId, today, amount);
  return sourceAssertion({
    actorUserId: fx.userId,
    tenantId: fx.tenantId,
    businessId: fx.businessId,
    operationKind: 'post',
    sourceType: 'manual_adjustment',
    sourceId,
    postingFingerprint: fingerprintOf(c),
  });
}

describe('the owning command still passes completeness (§6)', () => {
  it('writes one entry, one detail row, one audit event and one outbox event, and commits', async () => {
    const fx = await fresh('ok');
    const { command, assertion } = adjustment(fx);
    const r = await postAdjustmentAs(assertion, command, 'the reason this exists');
    expect(r.created).toBe(true);

    const counts = await countsFor(fx.businessId);
    expect(counts.entries).toBe(1);
    expect(counts.lines).toBe(2);
    expect(counts.bindings).toBe(1);
    expect(counts.adjustments).toBe(1);

    const detail = await ownerPool().query<{ reason: string; actor_user_id: string }>(
      `SELECT reason, actor_user_id FROM accounting_manual_adjustments WHERE business_id = $1 AND id = $2`,
      [fx.businessId, command.sourceId],
    );
    expect(must(detail.rows[0]).reason).toBe('the reason this exists');
    expect(must(detail.rows[0]).actor_user_id).toBe(fx.userId);
  });

  it('still refuses an empty reason', async () => {
    const fx = await fresh('noreason');
    const { command, assertion } = adjustment(fx);
    await expect(postAdjustmentAs(assertion, command, '   ')).rejects.toThrow(/accounting\.adjustment_reason_required|reason/i);
    expect((await countsFor(fx.businessId)).entries).toBe(0);
  });

  it('is still idempotent, and a retry does not rewrite the narrative already in the ledger', async () => {
    const fx = await fresh('replay');
    const { command, assertion } = adjustment(fx);
    const first = await postAdjustmentAs(assertion, command, 'the original narrative');
    const again = await postAdjustmentAs(adjustmentAssertion(fx, command.sourceId), { ...command, requestId: 'req-retry' }, 'a later retelling');
    expect(again.entryId).toBe(first.entryId);
    expect(again.created).toBe(false);

    const counts = await countsFor(fx.businessId);
    expect(counts.entries).toBe(1);
    expect(counts.adjustments).toBe(1);
    const detail = await ownerPool().query<{ reason: string }>(`SELECT reason FROM accounting_manual_adjustments WHERE business_id = $1 AND id = $2`, [
      fx.businessId,
      command.sourceId,
    ]);
    expect(must(detail.rows[0]).reason).toBe('the original narrative');
  });
});

// ── §7: the audit, asked of the LIVE catalogue rather than of a file ──────

describe('the source-completeness audit, read out of the running catalogue (§7)', () => {
  const COMPLETENESS = [
    { trigger: 'journal_entries_manual_adjustment_complete', fn: 'accounting_manual_adjustment_entry_complete' },
    { trigger: 'journal_entries_reversal_complete', fn: 'accounting_reversal_entry_complete' },
    { trigger: 'journal_entries_opening_balance_complete', fn: 'accounting_opening_balance_entry_complete' },
  ];

  it('all three native sources carry the same completeness trigger, equally deferred', async () => {
    // A file can say DEFERRABLE INITIALLY DEFERRED and a cluster can disagree
    // with it, so the question is put to `pg_trigger` and `pg_proc`. Asking
    // for all three together is the point: the defect this matrix exists for
    // was one source protected less strongly than its siblings, and the only
    // way that stays fixed is a check that would notice the asymmetry again.
    const rows = await ownerPool().query<{
      tgname: string;
      relname: string;
      proname: string;
      deferrable: boolean;
      initdeferred: boolean;
      is_constraint: boolean;
      after_insert: boolean;
      row_level: boolean;
      definer: boolean;
      owner: string;
      config: string[] | null;
    }>(
      `SELECT t.tgname,
              c.relname,
              p.proname,
              t.tgdeferrable AS deferrable,
              t.tginitdeferred AS initdeferred,
              t.tgconstraint <> 0 AS is_constraint,
              (t.tgtype & 4) <> 0 AND (t.tgtype & 2) = 0 AS after_insert,
              (t.tgtype & 1) <> 0 AS row_level,
              p.prosecdef AS definer,
              r.rolname AS owner,
              p.proconfig AS config
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_proc p ON p.oid = t.tgfoid
       JOIN pg_roles r ON r.oid = p.proowner
       WHERE t.tgname = ANY($1::text[])`,
      [COMPLETENESS.map((x) => x.trigger)],
    );
    expect(rows.rows).toHaveLength(COMPLETENESS.length);

    for (const { trigger, fn } of COMPLETENESS) {
      const row = must(
        rows.rows.find((r) => r.tgname === trigger),
        `the ${trigger} trigger`,
      );
      expect(row.relname, `${trigger} is not on journal_entries`).toBe('journal_entries');
      expect(row.proname).toBe(fn);
      expect(row.is_constraint, `${trigger} is not a constraint trigger`).toBe(true);
      expect(row.deferrable, `${trigger} is not DEFERRABLE`).toBe(true);
      expect(row.initdeferred, `${trigger} is not INITIALLY DEFERRED`).toBe(true);
      expect(row.after_insert, `${trigger} is not AFTER INSERT`).toBe(true);
      expect(row.row_level, `${trigger} is not FOR EACH ROW`).toBe(true);
      // G-5, restated for each of them: the check must see the same rows
      // whichever principal's INSERT fired it, and the principal it runs as
      // must be the one nobody can log in to.
      expect(row.definer, `${fn} is not SECURITY DEFINER`).toBe(true);
      expect(row.owner).toBe('daftar_accounting_internal');
      const search = must(row.config, `${fn} has no search_path`).find((c) => c.startsWith('search_path='));
      expect(must(search, `${fn} search_path`).endsWith('pg_temp'), `${fn} does not put pg_temp last`).toBe(true);
    }
  });

  it('every native source detail table proves its binding in the other direction', async () => {
    // The completeness triggers above are one half. These deferred foreign
    // keys are the other: a detail row that resolves to no source binding
    // cannot commit either, so neither end can be an orphan.
    const rows = await ownerPool().query<{ conname: string; condeferred: boolean }>(
      `SELECT conname, condeferred FROM pg_constraint
       WHERE conname = ANY($1::text[]) AND contype = 'f'`,
      [['accounting_manual_adjustments_binding_fk', 'accounting_reversals_binding_fk', 'accounting_opening_balances_binding_fk']],
    );
    expect(rows.rows.map((r) => r.conname).sort()).toEqual([
      'accounting_manual_adjustments_binding_fk',
      'accounting_opening_balances_binding_fk',
      'accounting_reversals_binding_fk',
    ]);
    for (const r of rows.rows) expect(r.condeferred, `${r.conname} is not INITIALLY DEFERRED`).toBe(true);
  });

  it('every opening-balance command takes the one per-business lock, and takes it first (§12, §17)', async () => {
    // The lock ORDER read out of the routines the cluster is actually
    // running. A command that acquired the business row before its own lock
    // is the cycle that deadlocked two opening balances against each other,
    // and it would be invisible to a test that only ever ran one of them.
    const routines = [
      'accounting_open_balance_draft',
      'accounting_open_balance_edit',
      'accounting_open_balance_discard',
      'accounting_open_balance_post',
      'accounting_open_balance_supersede',
    ];
    const rows = await ownerPool().query<{ proname: string; prosrc: string }>(`SELECT proname, prosrc FROM pg_proc WHERE proname = ANY($1::text[])`, [
      routines,
    ]);
    expect(rows.rows.map((r) => r.proname).sort()).toEqual([...routines].sort());

    for (const row of rows.rows) {
      const proname = row.proname;
      // The prose in these routines discusses the lock modes it does NOT
      // take, so the question is put to the code alone.
      const prosrc = row.prosrc.replace(/--[^\n]*/g, '');
      const lock = prosrc.indexOf('accounting_opening_balance_lock_key');
      expect(lock, `${proname} never takes the opening-balance lock`).toBeGreaterThanOrEqual(0);
      const firstRowLock = Math.min(
        ...['FOR UPDATE', 'FOR SHARE'].map((m) => {
          const i = prosrc.indexOf(m);
          return i < 0 ? Number.MAX_SAFE_INTEGER : i;
        }),
      );
      expect(lock, `${proname} locks a row before taking the opening-balance lock`).toBeLessThan(firstRowLock);
      // And no FOR SHARE anywhere on this path: the primitive further down
      // takes the business row FOR UPDATE on a first posting, so arriving
      // with the weak mode is the upgrade that used to deadlock.
      expect(prosrc, `${proname} still takes a row FOR SHARE`).not.toContain('FOR SHARE');
    }
  });
});
