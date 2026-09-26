/**
 * P3-S4 R-B1 — SEAM 2 WITH SEVERAL ACCOUNTING ASSERTIONS
 * (docs/PHASE_3_S4_CONTRACT.md A-06, A-08, §9.1 B-1; `apps/api/src/infra/database.ts`
 * `AccountingAssertionSequence`, `presentAccountingAssertion`).
 *
 * A receipt that covers a deficit posts twice in one transaction, each
 * posting under its own accounting assertion. Through the REAL `Database`
 * of the application:
 *
 * - two assertions are presented in order, each set as
 *   `app.accounting_assertion` for exactly its posting (the GUC starts empty),
 *   and a whole receipt commits both entries, consuming both jtis in one
 *   transaction;
 * - a posting whose source is not the next assertion's claim is refused
 *   `seam.accounting_assertion_source_mismatch`;
 * - a posting beyond the last is refused `seam.accounting_assertion_exhausted`;
 * - a commit that presented some but not all is refused
 *   `seam.accounting_assertion_unused` and rolls back everything;
 * - presenting none commits (a replay inside the routine: the assertions
 *   expire unused, A-08); a single assertion is today's seam;
 * - a multi-assertion capability refuses the single-authority path
 *   (`seam.accounting_assertion_sequence_required`), and one assertion given
 *   twice is `seam.accounting_assertion_malformed`.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PostingCommand } from '@daftar/accounting';
import { Database, TransactionSeamError, type BusinessScope, type TransactionSql } from '../../apps/api/src/infra/database';
import { DatabaseAccountingPostingAdapter } from '../../apps/api/src/modules/accounting/accounting-posting.adapter';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { must, seedS3World, type S3Business } from '../helpers/inventory-commands';
import {
  assertionFor,
  callOf,
  draftCommand,
  mintPosting,
  prepareReceipt,
  receiptPostings,
  runCommand,
  s4Counts,
  s4Delta,
  supplierCreate,
  supplierIn,
  type S4Command,
} from '../helpers/purchase-commands';
import { coverageVector, installCommittedDeficitFixture, removeCommittedDeficitFixture, seedCommittedDeficitKey } from '../helpers/purchase-deficits';

let t: TestApp;
let db: Database;
let posting: DatabaseAccountingPostingAdapter;
let A: S3Business;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  await installCommittedDeficitFixture();
  ({ A } = await seedS3World(ownerPool(), 's4seam'));
  t = await createTestApp();
  db = t.app.get(Database);
  posting = t.app.get(DatabaseAccountingPostingAdapter, { strict: false });
});

afterAll(async () => {
  await t.close();
  await removeCommittedDeficitFixture();
  await resetData();
});

const scope = (): BusinessScope => ({ tenantId: A.tenantId, businessId: A.businessId, actorUserId: A.userId, businessTransactionId: randomUUID() });

/** A domestic posting of `sourceType`/`sourceId` (never written in these cases: only its claims matter). */
function claimOf(sourceType: string, sourceId: string): PostingCommand {
  const at = new Date('2026-01-01T00:00:00Z');
  const line = (side: 'D' | 'C') => ({
    account: { kind: 'system' as const, systemKey: side === 'D' ? 'inventory' : 'accounts_payable' },
    side,
    baseAmountMinor: 100n,
    baseCurrency: 'ILS',
    txnAmountMinor: 100n,
    txnCurrency: 'ILS',
    fxRate: '1.0000000000',
    fxRateSource: 'base' as const,
    fxRateAt: at,
    branchId: A.branchX,
    warehouseId: side === 'D' ? A.w1 : null,
    memo: null,
  });
  return {
    tenantId: A.tenantId,
    businessId: A.businessId,
    sourceType,
    sourceId,
    entryDate: '2026-01-01',
    lines: [line('D'), line('C')],
    description: null,
    requestId: null,
  };
}

/** The seam-2 work of a supplier create: the inventory assertion is consumed by a real routine in the transaction. */
async function supplierWork(sql: TransactionSql, cmd: S4Command): Promise<void> {
  const { sql: text, params } = callOf(cmd);
  await sql.query(text, params);
}

async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'accepted';
  } catch (e) {
    if (e instanceof TransactionSeamError) return e.code;
    return e instanceof Error ? e.message : String(e);
  }
}

const guc = async (sql: TransactionSql): Promise<string> =>
  must((await sql.query<{ a: string }>(`SELECT current_setting('app.accounting_assertion', true) AS a`)).rows[0]).a;

describe('R-B1 ordered accounting assertions on seam 2', () => {
  const purchaseId = randomUUID();
  const adjustmentId = randomUUID();
  const first = (): PostingCommand => claimOf('purchase', purchaseId);
  const second = (): PostingCommand => claimOf('negative_inventory_cost_adjustment', adjustmentId);

  it('two assertions are presented in order: the GUC starts empty and carries each assertion for exactly its posting', async () => {
    const cmd = supplierCreate({ name: 'Seam in order' });
    const a1 = mintPosting(first(), A.userId);
    const a2 = mintPosting(second(), A.userId);
    const seen: string[] = [];
    await db.withBusinessInventoryAccountingTransaction(scope(), assertionFor(A, cmd), [a1, a2], async (tx) => {
      await supplierWork(tx, cmd);
      seen.push(await guc(tx));
      await db.presentAccountingAssertion(tx.accounting, { sourceType: 'purchase', sourceId: purchaseId });
      seen.push(await guc(tx));
      await db.presentAccountingAssertion(tx.accounting, { sourceType: 'negative_inventory_cost_adjustment', sourceId: adjustmentId });
      seen.push(await guc(tx));
    });
    expect(seen).toEqual(['', a1, a2]);
    expect((await ownerPool().query(`SELECT 1 FROM suppliers WHERE business_id = $1 AND id = $2`, [A.businessId, cmd.supplierId])).rowCount, 'committed').toBe(
      1,
    );
  });

  it('a posting whose source is not the next claim → source_mismatch, and the whole transaction rolls back', async () => {
    const cmd = supplierCreate({ name: 'Seam mismatch' });
    const why = await refusal(() =>
      db.withBusinessInventoryAccountingTransaction(
        scope(),
        assertionFor(A, cmd),
        [mintPosting(first(), A.userId), mintPosting(second(), A.userId)],
        async (tx) => {
          await supplierWork(tx, cmd);
          await db.presentAccountingAssertion(tx.accounting, { sourceType: 'negative_inventory_cost_adjustment', sourceId: adjustmentId });
        },
      ),
    );
    expect(why).toBe('seam.accounting_assertion_source_mismatch');
    const other = await refusal(() =>
      db.withBusinessInventoryAccountingTransaction(
        scope(),
        assertionFor(A, supplierCreate()),
        [mintPosting(first(), A.userId), mintPosting(second(), A.userId)],
        (tx) => db.presentAccountingAssertion(tx.accounting, { sourceType: 'purchase', sourceId: randomUUID() }),
      ),
    );
    expect(other, 'the right type, another id').toBe('seam.accounting_assertion_source_mismatch');
    expect((await ownerPool().query(`SELECT 1 FROM suppliers WHERE business_id = $1 AND id = $2`, [A.businessId, cmd.supplierId])).rowCount).toBe(0);
  });

  it('a posting beyond the last → exhausted', async () => {
    const cmd = supplierCreate({ name: 'Seam exhausted' });
    const why = await refusal(() =>
      db.withBusinessInventoryAccountingTransaction(
        scope(),
        assertionFor(A, cmd),
        [mintPosting(first(), A.userId), mintPosting(second(), A.userId)],
        async (tx) => {
          await supplierWork(tx, cmd);
          await db.presentAccountingAssertion(tx.accounting, { sourceType: 'purchase', sourceId: purchaseId });
          await db.presentAccountingAssertion(tx.accounting, { sourceType: 'negative_inventory_cost_adjustment', sourceId: adjustmentId });
          await db.presentAccountingAssertion(tx.accounting, { sourceType: 'negative_inventory_cost_adjustment', sourceId: adjustmentId });
        },
      ),
    );
    expect(why).toBe('seam.accounting_assertion_exhausted');
    expect((await ownerPool().query(`SELECT 1 FROM suppliers WHERE business_id = $1 AND id = $2`, [A.businessId, cmd.supplierId])).rowCount).toBe(0);
  });

  it('presenting some but not all → unused at commit, and nothing the callback wrote survives', async () => {
    const cmd = supplierCreate({ name: 'Seam unused' });
    const before = await s4Counts(ownerPool(), A.businessId);
    const why = await refusal(() =>
      db.withBusinessInventoryAccountingTransaction(
        scope(),
        assertionFor(A, cmd),
        [mintPosting(first(), A.userId), mintPosting(second(), A.userId)],
        async (tx) => {
          await supplierWork(tx, cmd);
          await db.presentAccountingAssertion(tx.accounting, { sourceType: 'purchase', sourceId: purchaseId });
        },
      ),
    );
    expect(why).toBe('seam.accounting_assertion_unused');
    expect(s4Delta(before, await s4Counts(ownerPool(), A.businessId)), 'rolled back').toEqual({});
  });

  it('presenting none commits (the replay case, A-08); the single-assertion seam sets the GUC at BEGIN', async () => {
    const cmd = supplierCreate({ name: 'Seam none presented' });
    await db.withBusinessInventoryAccountingTransaction(
      scope(),
      assertionFor(A, cmd),
      [mintPosting(first(), A.userId), mintPosting(second(), A.userId)],
      (tx) => supplierWork(tx, cmd),
    );
    expect((await ownerPool().query(`SELECT 1 FROM suppliers WHERE business_id = $1 AND id = $2`, [A.businessId, cmd.supplierId])).rowCount).toBe(1);
    const single = mintPosting(first(), A.userId);
    const cmd2 = supplierCreate({ name: 'Seam single' });
    const seen = await db.withBusinessInventoryAccountingTransaction(scope(), assertionFor(A, cmd2), [single], async (tx) => {
      await supplierWork(tx, cmd2);
      const at = await guc(tx);
      expect(db.postingTransactionSql(tx.accounting), 'the single-authority path stays open').toBeDefined();
      return at;
    });
    expect(seen).toBe(single);
  });

  it('several assertions close the single-authority path (sequence_required); one assertion twice is malformed', async () => {
    const a1 = mintPosting(first(), A.userId);
    const why = await refusal(() =>
      db.withBusinessInventoryAccountingTransaction(scope(), assertionFor(A, supplierCreate()), [a1, mintPosting(second(), A.userId)], async (tx) => {
        db.postingTransactionSql(tx.accounting);
      }),
    );
    expect(why).toBe('seam.accounting_assertion_sequence_required');
    expect(
      await refusal(() => db.withBusinessInventoryAccountingTransaction(scope(), assertionFor(A, supplierCreate()), [a1, a1], async () => undefined)),
    ).toBe('seam.accounting_assertion_malformed');
  });

  it('a whole receipt with a coverage: the routine, then both entries through the posting adapter, in order, one transaction (GOLD-54)', async () => {
    const v = coverageVector('GOLD54');
    await seedCommittedDeficitKey(A, A.w1, A.piece.variantId, must(v.seed[0]));
    const supplierId = await supplierIn(ownerPool(), A);
    const r = must(v.receipts[0]);
    const line = must(r.lines[0]);
    const c = await ownerPool().connect();
    let draft;
    try {
      await c.query('BEGIN');
      draft = await draftCommand(c, supplierId, A.w1, [{ variantId: A.piece.variantId, qty: line.qty, unitPriceMinor: '120' }]);
      await runCommand(c, A, draft);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const prepared = await prepareReceipt(ownerPool(), A, draft.purchaseId);
    const s = scope();
    const postings = receiptPostings(A, prepared, s.businessTransactionId);
    const catchUp = must(postings.catchUp, 'N ≠ 0: a catch-up');
    const usesBefore = must((await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM accounting_assertion_uses`)).rows[0]).n;
    const entries = await db.withBusinessInventoryAccountingTransaction(
      s,
      assertionFor(A, prepared.cmd),
      [mintPosting(postings.purchase, A.userId), mintPosting(catchUp, A.userId)],
      async (tx) => {
        const { sql, params } = callOf(prepared.cmd);
        await tx.query(sql, params);
        const p = await posting.postEntryInTransaction(tx.accounting, { command: postings.purchase });
        const q = await posting.postEntryInTransaction(tx.accounting, { command: catchUp });
        const xact = must((await tx.query<{ x: string }>(`SELECT pg_current_xact_id()::text AS x`)).rows[0]).x;
        return [p.entryId, q.entryId, xact];
      },
    );
    const bound = await ownerPool().query<{ source_type: string; journal_entry_id: string }>(
      `SELECT source_type, journal_entry_id::text FROM accounting_source_bindings WHERE business_id = $1 AND source_id = ANY($2::uuid[]) ORDER BY source_type`,
      [A.businessId, [prepared.cmd.purchaseId, must(prepared.cmd.coverageAdjustmentId)]],
    );
    expect(bound.rows).toEqual([
      { source_type: 'negative_inventory_cost_adjustment', journal_entry_id: entries[1] },
      { source_type: 'purchase', journal_entry_id: entries[0] },
    ]);
    const usesAfter = must((await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM accounting_assertion_uses`)).rows[0]).n;
    expect(usesAfter - usesBefore, 'both jtis consumed').toBe(2);
    const inXact = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM accounting_assertion_uses WHERE xact = $1::xid8`, [entries[2]]);
    expect(must(inXact.rows[0]).n, 'both jtis consumed by the one transaction').toBe(2);
  });
});
