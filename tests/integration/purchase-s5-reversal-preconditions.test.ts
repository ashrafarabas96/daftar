/**
 * P3-S5 T-08 — THE REVERSAL PRECONDITIONS, EACH INDEPENDENTLY
 * (docs/PHASE_3_S5_CONTRACT.md A-09, TL-7, TL-8, TL-9, §6 T-08; MP-5,
 * L:751-760).
 *
 * For each precondition only that one fails, on an otherwise reversible
 * received purchase, and the routine refuses with ITS code:
 *   (a) a payment allocated (settlement fixture)  → purchase_reversal.payment_allocated
 *   (b) a credit allocated (settlement fixture)   → purchase_reversal.credit_allocated
 *   (c) one supplier return exists                → purchase_reversal.returned
 *   (d) stock moved out by an S3 transfer         → purchase_reversal.insufficient_stock
 *   (e) the receipt covered a deficit (S4 helper) → purchase_reversal.deficit_coverage_present
 *   (f) a mixed-cost key drained to exactly qty   → purchase_reversal.valuation_residue
 * plus the shape refusals (state, reason, dates, the bound purchase). Every
 * refusal leaves no reversal row, movement, entry, audit or outbox row, and
 * each DENY is paired with the ALLOW once the one failing condition is gone.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  damageCommand,
  expectAccepted,
  must,
  openingCommand,
  ownerClient,
  refusedWith,
  runCommand as runS3,
  seedS3World,
  today,
  transferCommand,
  type S3Business,
  type S3World,
} from '../helpers/inventory-commands';
import { runFinancial, runOpening, stockUp } from '../helpers/inventory-posting';
import { installStockFixture } from '../helpers/stock-ledger';
import { FULL_CONTACTS, createSupplier, draftCommand, runCommand as runS4, s4Delta } from '../helpers/purchase-commands';
import { coverageVector, seedDeficitKey } from '../helpers/purchase-deficits';
import {
  prepareReversal,
  receivedPurchase,
  returnGoods,
  s5Counts,
  tryReversal,
  tryS5,
  type PreparedReversal,
  type ReceivedPurchase,
  type ReverseCommand,
} from '../helpers/purchase-returns';
import { installSettlementFixture } from '../helpers/purchase-settlement-fixture';

let world: S3World;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 's5pre');
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

/** A received five-piece purchase on W1 at 100 each (the honest reversible case). */
async function fivePieces(c: Client, A: S3Business, o: { documentDate?: string } = {}): Promise<ReceivedPurchase> {
  return receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '5', unitPriceMinor: '100' }], o);
}

/** The reversal is refused with exactly `code` and nothing at all is written. */
async function refusedAlone(c: Client, A: S3Business, p: PreparedReversal, code: string, why: string): Promise<void> {
  const before = await s5Counts(c, A.businessId);
  refusedWith(await tryReversal(c, A, p), 'P0001', code, why);
  expect(await s5Counts(c, A.businessId), `${why}: no reversal row, movement, entry, audit or outbox row`).toEqual(before);
}

async function accepted(c: Client, A: S3Business, p: PreparedReversal, why: string): Promise<void> {
  const run = expectAccepted(await tryReversal(c, A, p), why);
  expect(must(run.entry, `${why}: the Phase 2 reversal`).created).toBe(true);
}

describe('T-08 A-09 (a)/(b): the settlement fixture (TL-9)', () => {
  it('(a) a payment allocated → purchase_reversal.payment_allocated; cleared → reversed', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const fixture = await installSettlementFixture(c);
      const p = await fivePieces(c, A);
      await fixture.set(A.businessId, p.purchaseId, { paymentAllocated: true });
      await refusedAlone(c, A, await prepareReversal(c, A, p.purchaseId), 'purchase_reversal.payment_allocated', '(a)');
      await fixture.clear(A.businessId, p.purchaseId);
      await accepted(c, A, await prepareReversal(c, A, p.purchaseId), '(a) cleared');
      await fixture.restore();
    });
  });

  it('(b) a credit allocated → purchase_reversal.credit_allocated; cleared → reversed', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const fixture = await installSettlementFixture(c);
      const p = await fivePieces(c, A);
      await fixture.set(A.businessId, p.purchaseId, { creditAllocated: true });
      await refusedAlone(c, A, await prepareReversal(c, A, p.purchaseId), 'purchase_reversal.credit_allocated', '(b)');
      await fixture.clear(A.businessId, p.purchaseId);
      await accepted(c, A, await prepareReversal(c, A, p.purchaseId), '(b) cleared');
      await fixture.restore();
    });
  });

  it('(a) is decided before (b): both allocated → payment_allocated', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const fixture = await installSettlementFixture(c);
      const p = await fivePieces(c, A);
      await fixture.set(A.businessId, p.purchaseId, { paymentAllocated: true, creditAllocated: true });
      await refusedAlone(c, A, await prepareReversal(c, A, p.purchaseId), 'purchase_reversal.payment_allocated', '(a)+(b)');
      await fixture.restore();
    });
  });
});

describe('T-08 A-09 (c)-(f): real documents', () => {
  it('(c) one supplier return of the purchase → purchase_reversal.returned; a sibling purchase reverses', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const p = await fivePieces(c, A);
      const sibling = await fivePieces(c, A, { documentDate: p.documentDate });
      await returnGoods(c, A, p.purchaseId, { lines: [{ purchaseLineId: must(p.lines[0]).lineId, qty: '1' }] });
      await refusedAlone(c, A, await prepareReversal(c, A, p.purchaseId), 'purchase_reversal.returned', '(c)');
      await accepted(c, A, await prepareReversal(c, A, sibling.purchaseId), '(c) the sibling without a return');
    });
  });

  it('(d) stock moved out by a transfer → purchase_reversal.insufficient_stock; moved back → reversed', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const p = await fivePieces(c, A);
      await runS3(c, A, transferCommand(A.w1, A.w2, [{ variantId: A.piece.variantId, qty: '3' }]));
      await refusedAlone(c, A, await prepareReversal(c, A, p.purchaseId), 'purchase_reversal.insufficient_stock', '(d)');
      await runS3(c, A, transferCommand(A.w2, A.w1, [{ variantId: A.piece.variantId, qty: '3' }]));
      await accepted(c, A, await prepareReversal(c, A, p.purchaseId), '(d) the stock moved back');
    });
  });

  it('(e) a receipt that covered a deficit (TL-7) → purchase_reversal.deficit_coverage_present', async () => {
    await inTx(async (c) => {
      const A = world.A;
      await installStockFixture(c);
      const v = coverageVector('GOLD54');
      await seedDeficitKey(c, A, A.w1, A.piece.variantId, must(v.seed[0]));
      const line = must(must(v.receipts[0]).lines[0]);
      const p = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: line.qty, unitPriceMinor: '120' }]);
      expect(p.run.catchUpEntry, 'the receipt covered the deficit').not.toBeNull();
      await refusedAlone(c, A, await prepareReversal(c, A, p.purchaseId), 'purchase_reversal.deficit_coverage_present', '(e)');
      // A receipt of the same shape on a key with no deficit reverses.
      const clean = await receivedPurchase(c, A, [{ variantId: A.piece2.variantId, qty: line.qty, unitPriceMinor: '120' }]);
      await accepted(c, A, await prepareReversal(c, A, clean.purchaseId), '(e) a receipt that covered nothing');
    });
  });

  it('(f) a mixed-cost key drained to exactly qty (TL-8) → purchase_reversal.valuation_residue; the undrained key reverses', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const day = await today(c);
      // 5 at 200 (an S3 opening), then the purchase's 5 at 100: 10 at an average of 150.
      await runOpening(c, A, openingCommand(day, [{ warehouseId: A.w1, variantId: A.piece.variantId, qty: '5', unitCost: '200' }]));
      const p = await fivePieces(c, A);
      // Damage 5 at the average (750): 5 left worth 750, the receipt's 500 would leave 250 on no stock.
      await runFinancial(c, A, await damageCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '5' }]));
      await refusedAlone(c, A, await prepareReversal(c, A, p.purchaseId), 'purchase_reversal.valuation_residue', '(f)');
      // The same mixed-cost shape not drained (an S3 gain at 200 — the one opening is spent — then damage 4): 6 left worth 900,
      // removing 500 keeps a lawful 400 on 1 piece.
      await stockUp(c, A, A.w1, [{ variantId: A.piece2.variantId, qty: '5', unitCost: '200' }]);
      const q = await receivedPurchase(c, A, [{ variantId: A.piece2.variantId, qty: '5', unitPriceMinor: '100' }]);
      await runFinancial(c, A, await damageCommand(c, A, A.w1, [{ variantId: A.piece2.variantId, qty: '4' }]));
      await accepted(c, A, await prepareReversal(c, A, q.purchaseId), '(f) a key left with stock and value');
    });
  });
});

describe('T-08 the shape refusals, each with its own code', () => {
  it('purchase.not_found for an unknown purchase; purchase.state_invalid for a draft', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const p = await fivePieces(c, A);
      const honest = await prepareReversal(c, A, p.purchaseId);
      const before = await s5Counts(c, A.businessId);
      refusedWith(await tryS5(c, A, { ...honest.cmd, purchaseId: randomUUID() }), 'P0001', 'purchase.not_found');
      const supplierId = await createSupplier(c, A, FULL_CONTACTS);
      const draft = await draftCommand(c, supplierId, A.w1, [{ variantId: A.piece.variantId, qty: '1', unitPriceMinor: '10' }]);
      await runS4(c, A, draft);
      const drafted: ReverseCommand = { ...honest.cmd, purchaseId: draft.purchaseId };
      const afterDraft = await s5Counts(c, A.businessId);
      refusedWith(await tryS5(c, A, drafted), 'P0001', 'purchase.state_invalid', 'a draft');
      expect(await s5Counts(c, A.businessId)).toEqual(afterDraft);
      expect(before.purchase_reversals).toBe(afterDraft.purchase_reversals);
      await accepted(c, A, honest, 'the honest reversal');
    });
  });

  it('purchase_reversal.reason_required: none, empty, untrimmed or longer than 500', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const p = await fivePieces(c, A);
      const honest = await prepareReversal(c, A, p.purchaseId);
      const before = await s5Counts(c, A.businessId);
      for (const reason of [null, '', ' wrong supplier', 'wrong supplier ', 'x'.repeat(501)]) {
        refusedWith(await tryS5(c, A, { ...honest.cmd, reason }, { raw: true }), 'P0001', 'purchase_reversal.reason_required', JSON.stringify(reason));
      }
      expect(await s5Counts(c, A.businessId)).toEqual(before);
      await accepted(c, A, await prepareReversal(c, A, p.purchaseId, { reason: 'x'.repeat(500) }), 'a 500-character reason');
    });
  });

  it('purchase_reversal.date_before_purchase and purchase_reversal.date_in_future', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const p = await fivePieces(c, A, { documentDate: '2026-04-01' });
      const before = await s5Counts(c, A.businessId);
      await refusedAlone(
        c,
        A,
        await prepareReversal(c, A, p.purchaseId, { reversalDate: '2026-03-31' }),
        'purchase_reversal.date_before_purchase',
        'the day before',
      );
      const tomorrow = must((await c.query<{ d: string }>(`SELECT to_char($1::date + 1, 'YYYY-MM-DD') AS d`, [await today(c)])).rows[0]).d;
      refusedWith(
        await tryS5(c, A, (await prepareReversal(c, A, p.purchaseId, { reversalDate: tomorrow })).cmd),
        'P0001',
        'purchase_reversal.date_in_future',
        'tomorrow',
      );
      expect(await s5Counts(c, A.businessId)).toEqual(before);
      await accepted(c, A, await prepareReversal(c, A, p.purchaseId, { reversalDate: '2026-04-01' }), 'dated on the purchase day');
    });
  });

  it('purchase_reversal.purchase_changed: the bound warehouse, entry, lines, values or total differ from the stored ones', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const p = await receivedPurchase(c, A, [
        { variantId: A.piece.variantId, qty: '5', unitPriceMinor: '100' },
        { variantId: A.piece2.variantId, qty: '2', unitPriceMinor: '70' },
      ]);
      const honest = await prepareReversal(c, A, p.purchaseId);
      const other = await fivePieces(c, A);
      const [l1, l2] = [must(honest.cmd.lines[0]), must(honest.cmd.lines[1])];
      const tampered: { field: string; cmd: ReverseCommand }[] = [
        { field: 'warehouse', cmd: { ...honest.cmd, warehouseId: A.w2 } },
        { field: 'original entry', cmd: { ...honest.cmd, originalEntryId: other.entryId } },
        { field: 'total', cmd: { ...honest.cmd, totalValueMinor: honest.cmd.totalValueMinor + 1n } },
        { field: 'a line value', cmd: { ...honest.cmd, lines: [{ ...l1, valueMinor: l1.valueMinor - 1n }, l2] } },
        { field: 'a line qty', cmd: { ...honest.cmd, lines: [{ ...l1, qtyQ4: l1.qtyQ4 - 10_000n }, l2] } },
        { field: 'the line order', cmd: { ...honest.cmd, lines: [l2, l1] } },
        { field: 'a line dropped', cmd: { ...honest.cmd, lines: [l1] } },
        { field: 'a line variant', cmd: { ...honest.cmd, lines: [{ ...l1, variantId: A.piece2.variantId }, l2] } },
      ];
      const before = await s5Counts(c, A.businessId);
      for (const t of tampered) {
        refusedWith(await tryS5(c, A, t.cmd, { raw: true }), 'P0001', 'purchase_reversal.purchase_changed', t.field);
      }
      expect(await s5Counts(c, A.businessId)).toEqual(before);
      await accepted(c, A, honest, 'the honest reversal');
    });
  });

  it('purchase_reversal.already_reversed for another intent; the same intent replays', async () => {
    await inTx(async (c) => {
      const A = world.A;
      const p = await fivePieces(c, A, { documentDate: '2026-04-01' });
      const honest = await prepareReversal(c, A, p.purchaseId);
      await accepted(c, A, honest, 'the first reversal');
      const before = await s5Counts(c, A.businessId);
      refusedWith(await tryS5(c, A, { ...honest.cmd, reason: 'Another reason' }), 'P0001', 'purchase_reversal.already_reversed', 'another reason');
      refusedWith(await tryS5(c, A, { ...honest.cmd, reversalDate: '2026-04-01' }), 'P0001', 'purchase_reversal.already_reversed', 'another date');
      expect(await s5Counts(c, A.businessId), 'the refusals wrote nothing').toEqual(before);
      const replay = expectAccepted(await tryReversal(c, A, honest), 'the same intent');
      expect(replay.rows.every((r) => r.replayed)).toBe(true);
      expect(replay.entry, 'a replay posts nothing').toBeNull();
      expect(s4Delta(before, await s5Counts(c, A.businessId)), 'the replay consumed its own assertion and wrote nothing else').toEqual({
        inventory_assertion_uses: 1,
      });
    });
  });
});
