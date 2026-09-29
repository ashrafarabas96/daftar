/**
 * P3-S5 T-03 — THE RETURN POSTING SHAPE
 * (docs/PHASE_3_S5_CONTRACT.md A-10(f)-(g), A-14, A-15, §6 T-03; P:226,
 * L:915-921).
 *
 * A domestic return posts one `supplier_return` entry: `Dr AP C / Cr
 * Inventory I / ±PPV`, the PPV identity `ppv = ap_base + credit_base − I`
 * holding on the stored header, the entry and the ledger; PPV positive and
 * negative from the package vectors; never 6100, revenue or `tax_payable`;
 * AP (and 1150) on the purchase warehouse's home branch with no warehouse,
 * Inventory and PPV on the return warehouse and its branch; Σ stored
 * movement values = −I; GL Inventory = Σ movement values = the stock cache.
 * The entry is bound to the return (`accounting_source_bindings`) and the
 * accounting guard refuses any other shape (A-15(a)).
 */
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { atCommit, expectAccepted, expectConstraint, must, ownerClient, refusedWith, scratch, seedS3World, type S3World } from '../helpers/inventory-commands';
import { postInTx } from '../helpers/purchase-commands';
import {
  RETURN_ACCOUNTS,
  entryBySource,
  entryShape,
  glOf,
  movementsOfSource,
  prepareReturn,
  returnHeader,
  runReturn,
  supplierReturnVector,
  threeWay,
  tryReturn,
  vectorPurchase,
} from '../helpers/purchase-returns';

let world: S3World;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 's5post');
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

/** The system keys the business's books hold no line on, for a return, beyond the four A-14 names. */
async function forbiddenTouched(c: Client, entryId: string): Promise<string[]> {
  const r = await c.query<{ k: string }>(
    `SELECT coalesce(a.system_key, a.code) AS k FROM journal_lines l JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
      WHERE l.journal_entry_id = $1 AND (a.system_key IS NULL OR a.system_key <> ALL ($2::text[]) OR a.code = '6100' OR a.type = 'revenue')`,
    [entryId, [...RETURN_ACCOUNTS]],
  );
  return r.rows.map((x) => x.k);
}

describe('T-03 PPV positive and negative from the vectors', () => {
  for (const id of ['PPV-POSITIVE', 'PPV-NEGATIVE']) {
    it(`${id}: the entry, the stored header and the ledger all satisfy ppv = ap_base + credit_base − I`, async () => {
      await inTx(async (c) => {
        const A = world.A;
        const v = supplierReturnVector(id);
        const r = must(v.returns[0]);
        const e = must(r.expect);
        const p = await vectorPurchase(c, A, v);
        const before = {
          inventory: await glOf(c, A.businessId, 'inventory'),
          ppv: await glOf(c, A.businessId, 'purchase_price_variance'),
          ap: await glOf(c, A.businessId, 'accounts_payable'),
        };
        const prep = await prepareReturn(c, A, p.purchaseId, { lines: r.lines.map((l) => ({ purchaseLineId: p.lineIdOf(l.lineNo), qty: l.qty })) });
        const run = await runReturn(c, A, prep);
        expectAccepted(await atCommit(c), 'every deferred guard at COMMIT');
        const entry = must(await entryBySource(c, A.businessId, 'supplier_return', prep.cmd.returnId));
        expect(entry.id).toBe(must(run.entry).entryId);
        expect(entryShape(entry.lines, prep.purchaseBranchId, p.warehouseId, prep.returnBranchId), 'the vector entry').toEqual(e.entry);
        expect(await forbiddenTouched(c, entry.id), 'no 6100, no revenue, no tax_payable, nothing beyond the four A-14 accounts').toEqual([]);
        const h = must(await returnHeader(c, A.businessId, prep.cmd.returnId));
        expect(BigInt(must(h.ppv)), 'the header identity').toBe(BigInt(must(h.ap_base)) + BigInt(must(h.credit_base)) - BigInt(must(h.inventory)));
        expect(must(h.ppv)).toBe(e.ppvMinor);
        expect(Math.sign(Number(e.ppvMinor)), `${id} has the sign its name says`).toBe(id === 'PPV-POSITIVE' ? 1 : -1);
        // The ledger moved by exactly the header: AP −ap_base, Inventory −I, PPV credited by ppv (credit − debit).
        expect(before.ap - (await glOf(c, A.businessId, 'accounts_payable')), 'AP debited by ap_base').toBe(-BigInt(must(h.ap_base)));
        expect(before.inventory - (await glOf(c, A.businessId, 'inventory')), 'Inventory credited by I').toBe(BigInt(must(h.inventory)));
        expect(before.ppv - (await glOf(c, A.businessId, 'purchase_price_variance')), 'PPV credited by ppv').toBe(BigInt(must(h.ppv)));
        // Σ stored movement values = −I, and the three agree.
        const moves = await movementsOfSource(c, A.businessId, 'supplier_return', prep.cmd.returnId);
        expect(
          moves.reduce((s, m) => s + BigInt(m.value), 0n),
          'Σ movement values = −I',
        ).toBe(-BigInt(must(h.inventory)));
        const three = await threeWay(c, A.businessId);
        expect([three.movements, three.cache]).toEqual([three.gl, three.gl]);
      });
    });
  }
});

describe('T-03 the entry is exactly the A-10(g) lines of its return (A-15(a))', () => {
  it('an entry with any other amount, a merged line or an extra pair fails at COMMIT; the honest entry commits', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const v = supplierReturnVector('PPV-POSITIVE');
      const r = must(v.returns[0]);
      const p = await vectorPurchase(c, A, v);
      const prep = await prepareReturn(c, A, p.purchaseId, { lines: r.lines.map((l) => ({ purchaseLineId: p.lineIdOf(l.lineNo), qty: l.qty })) });
      const [ap, inventory, ppv] = [must(prep.posting.lines[0]), must(prep.posting.lines[1]), must(prep.posting.lines[2])];
      const wrong = [
        {
          what: 'AP one unit more, PPV one more',
          lines: [
            { ...ap, baseAmountMinor: ap.baseAmountMinor + 1n, txnAmountMinor: ap.txnAmountMinor + 1n },
            inventory,
            { ...ppv, baseAmountMinor: ppv.baseAmountMinor + 1n, txnAmountMinor: ppv.txnAmountMinor + 1n },
          ],
        },
        {
          what: 'PPV folded into Inventory',
          lines: [
            ap,
            { ...inventory, baseAmountMinor: inventory.baseAmountMinor + ppv.baseAmountMinor, txnAmountMinor: inventory.txnAmountMinor + ppv.txnAmountMinor },
          ],
        },
        { what: 'an extra balanced pair', lines: [...prep.posting.lines, { ...ppv, side: 'D' as const }, ppv] },
      ];
      for (const w of wrong) {
        await scratch(c, async () => {
          // The entry guard is deferred: the post is taken, the COMMIT is not.
          expectAccepted(await tryReturn(c, A, { ...prep, posting: { ...prep.posting, lines: w.lines } }), `${w.what}: posted`);
          refusedWith(await atCommit(c), 'P0001', 'accounting.inventory_entry_mismatch', w.what);
        });
      }
      expectAccepted(await tryReturn(c, A, prep), 'the honest entry');
      expectAccepted(await atCommit(c));
    });
  });

  it('a return whose entry is never posted fails at COMMIT: the return needs its entry', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const v = supplierReturnVector('PPV-NEGATIVE');
      const r = must(v.returns[0]);
      const p = await vectorPurchase(c, A, v);
      const prep = await prepareReturn(c, A, p.purchaseId, { lines: r.lines.map((l) => ({ purchaseLineId: p.lineIdOf(l.lineNo), qty: l.qty })) });
      await runReturn(c, A, prep, { posting: false });
      // Its deferred binding to the entry's accounting binding (A-15, §2.2) is checked at COMMIT: 23503 on every server version.
      expectConstraint(await atCommit(c), '23503', 'supplier_returns_binding_fk', 'a return with no entry cannot commit');
      // The honest entry, posted after the routine in the same transaction, completes it.
      await postInTx(c, prep.posting, A.userId);
      expectAccepted(await atCommit(c), 'with its entry');
    });
  });
});
