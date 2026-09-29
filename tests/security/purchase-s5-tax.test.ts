/**
 * P3-S5 — THE OD-03 TAX BOUNDARY (docs/PHASE_3_S5_CONTRACT.md A-14; SM:70).
 *
 * S5 is designed only for the zero case: every S5 document descends from a
 * purchase with `tax_minor = 0`, so
 *   - no S5 table (nor bridge) has a tax column;
 *   - no return entry and no reversal entry has a `tax_payable` line, or any
 *     line on an account whose system key names tax — while the business's
 *     books hold such an account, so the absence is not vacuous;
 *   - every purchase a return or reversal descends from has `tax_minor = 0`.
 * The DTO side (a return or reversal body carrying tax is 400) is T-18's
 * (`purchase-s5-http.test.ts`).
 */
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { atCommit, expectAccepted, must, ownerClient, seedS3World, type S3World } from '../helpers/inventory-commands';
import { S5_BRIDGES, S5_TABLES, prepareReturn, prepareReversal, receivedPurchase, runReturn, runReversal } from '../helpers/purchase-returns';

let world: S3World;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 's5tax');
});

afterAll(async () => {
  await resetData();
});

async function inTx(fn: (c: Client) => Promise<void>): Promise<void> {
  const c = await ownerClient();
  try {
    await c.query('BEGIN');
    await fn(c);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
}

describe('A-14 the OD-03 boundary: the zero case only', () => {
  it('no S5 table or bridge has a tax column', async () => {
    const r = await ownerPool().query<{ t: string; col: string }>(
      `SELECT table_name::text AS t, column_name::text AS col FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1::text[]) AND column_name ~ 'tax|vat'`,
      [[...S5_TABLES, ...S5_BRIDGES]],
    );
    expect(r.rows).toEqual([]);
  });

  it('a return entry and a reversal entry carry no tax line; their purchases carry no tax', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const taxAccounts = await c.query<{ k: string }>(`SELECT system_key AS k FROM accounts WHERE business_id = $1 AND system_key ~ 'tax'`, [A.businessId]);
      expect(
        taxAccounts.rows.map((x) => x.k),
        'the books hold a tax_payable account the entries could have used',
      ).toContain('tax_payable');
      const returned = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '4', unitPriceMinor: '100' }]);
      const ret = await prepareReturn(c, A, returned.purchaseId, { lines: [{ purchaseLineId: must(returned.lines[0]).lineId, qty: '2' }] });
      const retEntry = must((await runReturn(c, A, ret)).entry).entryId;
      const reversed = await receivedPurchase(c, A, [{ variantId: A.piece2.variantId, qty: '2', unitPriceMinor: '70' }]);
      const revEntry = must((await runReversal(c, A, await prepareReversal(c, A, reversed.purchaseId))).entry).entryId;
      expectAccepted(await atCommit(c));
      for (const [what, entryId] of [
        ['the return entry', retEntry],
        ['the reversal entry', revEntry],
      ] as const) {
        const lines = await c.query<{ k: string | null }>(
          `SELECT a.system_key AS k FROM journal_lines l JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
            WHERE l.business_id = $1 AND l.journal_entry_id = $2`,
          [A.businessId, entryId],
        );
        expect(lines.rowCount, `${what} has lines`).toBeGreaterThan(0);
        expect(
          lines.rows.filter((x) => x.k !== null && /tax/.test(x.k)),
          `${what}: no tax line`,
        ).toEqual([]);
      }
      const tax = await c.query<{ t: string }>(`SELECT tax_minor::text AS t FROM purchases WHERE business_id = $1 AND id = ANY($2::uuid[])`, [
        A.businessId,
        [returned.purchaseId, reversed.purchaseId],
      ]);
      expect(tax.rows.map((x) => x.t)).toEqual(['0', '0']);
    });
  });
});
