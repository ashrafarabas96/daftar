/**
 * C6 — THE LAW SEEN REFUSING, which until now it never was.
 *
 * `0093` registers the `value_complete` arm the transfer source was missing
 * and asserts the registry reports no gap. That proves REGISTRATION. It does
 * not prove the law refuses anything, and after CI 43843250451 the gap became
 * worse rather than better: the guard now stays silent unless the document has
 * as many movements as two per line, so nothing in the suite was known to see
 * it speak. A guard nobody has seen work is the "green law that guards
 * nothing" this lane keeps writing rules against — including against itself.
 *
 * So this file writes what no routine can produce: a COMPLETE transfer, both
 * legs present, whose value deltas do NOT cancel. The primitive computes the
 * value from the cost and could never emit that pair, which is exactly why the
 * seeder is owner-level (`seedOwnerTransfer`, `tests/helpers/stock-ledger.ts`).
 *
 * Both directions are here, and the pair is the point:
 *   §1 a pair that does NOT cancel is refused at COMMIT, by name;
 *   §2 the SAME shape with values that cancel commits — so §1's refusal is the
 *      imbalance and not the fixture, the legs, or the owner-level write.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { seedS3World, type S3World } from '../helpers/inventory-commands';
import { seedOwnerTransfer, seedOwnerTransferLines } from '../helpers/stock-ledger';

let world: S3World;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 'l3-c6-value');
}, 900_000);

/** Run `body` in its own transaction and return the COMMIT's outcome, since the guard is deferred. */
async function atCommit(body: (conn: PoolClient) => Promise<void>): Promise<{ ok: true } | { ok: false; message: string }> {
  const conn = await ownerPool().connect();
  try {
    await conn.query('BEGIN');
    await body(conn);
    await conn.query('COMMIT');
    return { ok: true };
  } catch (e) {
    await conn.query('ROLLBACK').catch(() => undefined);
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  } finally {
    conn.release();
  }
}

describe('C6 — a complete transfer whose value does not cancel', () => {
  it('§1 is refused at COMMIT, by this law and by name', async () => {
    const a = world.A;
    const outcome = await atCommit(async (conn) => {
      await seedOwnerTransfer(
        conn,
        { tenantId: a.tenantId, businessId: a.businessId, userId: a.userId },
        {
          variantId: a.piece.variantId,
          sourceWarehouseId: a.w1,
          destinationWarehouseId: a.w2,
          qty: '2',
          legs: [
            {
              kind: 'transfer_out',
              warehouseId: a.w1,
              qty: '-2',
              value: '-20',
              unitCost: '10',
              stockSeq: 1,
              cache: { onHand: '0', valuation: '0', avg: null },
            },
            // `unitCost` is 10 on ALL FOUR legs of both cases, and it is not
            // decoration: `stock_movements_cost_snapshot_ck` (0059:151) is
            // `(qty_delta = 0) = (unit_cost_base_minor IS NULL)`, so a leg that
            // moves quantity MUST carry a cost. Leaving it out is what made both
            // cases fail on that constraint instead of on this card's law -- §1
            // was then refused by the WRONG rule, which is the same false
            // attribution this arm's own message guards against. Pinning it at 10
            // in both cases keeps the COST identical between §1 and §2, so the
            // difference between them is a value difference and not a cost one.
            // CORRECTION, measured by the money review of 798d6cdb: an earlier
            // form of this note said `value` was the ONLY field that differs, and
            // that was false -- `cache.valuation` (21 against 20) and `cache.avg`
            // (10.5 against 10) differ too. The attribution still holds, because
            // the trigger reads `stock_movements.value_delta_base_minor` alone and
            // the refusal is asserted BY NAME, but the sentence claimed two fields
            // more than it had. A false statement in a test comment is read as
            // evidence here, so it is corrected rather than quietly dropped. Measured: no constraint ties value to qty x cost, so 21
            // against a cost of 10 is a legal row and a planted imbalance.
            // THE IMBALANCE, and it is one minor unit: value is not conserved,
            // the quantities still are. A guard that only compared quantities
            // would pass this, which is the whole reason the arm exists.
            {
              kind: 'transfer_in',
              warehouseId: a.w2,
              qty: '2',
              value: '21',
              unitCost: '10',
              stockSeq: 1,
              cache: { onHand: '2', valuation: '21', avg: '10.5' },
            },
          ],
        },
      );
    });
    expect(outcome.ok, 'a transfer that creates a minor unit of value out of nothing must not commit').toBe(false);
    expect(
      outcome.ok === false ? outcome.message : '',
      `the refusal must be THIS law and not a balance, kind or completeness rule: ${outcome.ok === false ? outcome.message : ''}`,
    ).toContain('inventory.transfer_value_not_conserved');
  }, 300_000);

  it('§2 while the same shape with values that cancel commits, so §1 is the imbalance and not the fixture', async () => {
    const a = world.A;
    const outcome = await atCommit(async (conn) => {
      await seedOwnerTransfer(
        conn,
        { tenantId: a.tenantId, businessId: a.businessId, userId: a.userId },
        {
          variantId: a.piece.variantId,
          sourceWarehouseId: a.w1,
          destinationWarehouseId: a.w2,
          qty: '2',
          legs: [
            {
              kind: 'transfer_out',
              warehouseId: a.w1,
              qty: '-2',
              value: '-20',
              unitCost: '10',
              stockSeq: 2,
              cache: { onHand: '0', valuation: '0', avg: null },
            },
            { kind: 'transfer_in', warehouseId: a.w2, qty: '2', value: '20', unitCost: '10', stockSeq: 2, cache: { onHand: '2', valuation: '20', avg: '10' } },
          ],
        },
      );
    });
    expect(outcome.ok, `the balanced pair must commit, or §1 proves nothing about value: ${outcome.ok === false ? outcome.message : ''}`).toBe(true);
  }, 300_000);

  // ───────────────────────────────────────────────────────────────────────────
  // §3 and §4 — THE LINE IS THE SUBJECT, NOT THE DOCUMENT.
  //
  // The independent review of `798d6cdb` found `0093` summing over the whole
  // transfer document while its trigger is named `..._per_line`, fires FOR EACH
  // ROW on a line, and the card asks for the line. §1 and §2 above cannot tell
  // the two designs apart, and that is not an oversight of theirs: they use
  // `seedOwnerTransfer`, which pins `line_no` to 1, and ON A SINGLE LINE THE
  // DOCUMENT IS THE LINE. So the green of this file proved the law existed and
  // said nothing about its subject.
  //
  // §3 is the case that separates them, and its numbers do the separating:
  //
  //   line A   out -100   in +150   ->  line sum  +50
  //   line B   out -100   in  +50   ->  line sum  -50
  //                                     DOCUMENT   0
  //
  // A document-wide sum sees zero and stays silent; a per-line sum sees +50 and
  // refuses. The harm the card names is exactly this shape: variant A's
  // valuation is inflated by 50 and variant B's is drained by 50, quantities
  // match line by line so the completeness guard is satisfied, and not one unit
  // has moved off a shelf. Cost of sales is then measured on a manufactured
  // average.
  // ───────────────────────────────────────────────────────────────────────────

  it('§3 a two-line transfer whose DOCUMENT sums to zero while each LINE does not is refused by name', async () => {
    const a = world.A;
    const v1 = a.variantProduct.variantIds[0];
    const v2 = a.variantProduct.variantIds[1];

    // THE FIXTURE DISCRIMINATES, asserted from its own numbers before the
    // database is asked anything. Without this, a red here could come from a
    // fixture that is simply unbalanced document-wide, which §1 already covers
    // and which would prove nothing new.
    const lineA = [-100, 150];
    const lineB = [-100, 50];
    const sum = (xs: readonly number[]): number => xs.reduce((t, x) => t + x, 0);
    expect(sum([...lineA, ...lineB]), 'the DOCUMENT must sum to zero, or this case does not separate the two designs').toBe(0);
    expect(sum(lineA), 'line A must NOT sum to zero').not.toBe(0);
    expect(sum(lineB), 'line B must NOT sum to zero').not.toBe(0);
    expect(sum(lineA) + sum(lineB), 'the two line errors must cancel exactly, which is what hides them from a document-wide sum').toBe(0);

    const outcome = await atCommit(async (conn) => {
      await seedOwnerTransferLines(
        conn,
        { tenantId: a.tenantId, businessId: a.businessId, userId: a.userId },
        {
          sourceWarehouseId: a.w1,
          destinationWarehouseId: a.w2,
          lines: [
            {
              variantId: v1,
              qty: '2',
              legs: [
                {
                  kind: 'transfer_out',
                  warehouseId: a.w1,
                  qty: '-2',
                  value: '-100',
                  unitCost: '50',
                  stockSeq: 3,
                  cache: { onHand: '0', valuation: '0', avg: null },
                },
                {
                  kind: 'transfer_in',
                  warehouseId: a.w2,
                  qty: '2',
                  value: '150',
                  unitCost: '50',
                  stockSeq: 3,
                  cache: { onHand: '2', valuation: '150', avg: '75' },
                },
              ],
            },
            {
              variantId: v2,
              qty: '2',
              legs: [
                {
                  kind: 'transfer_out',
                  warehouseId: a.w1,
                  qty: '-2',
                  value: '-100',
                  unitCost: '50',
                  stockSeq: 3,
                  cache: { onHand: '0', valuation: '0', avg: null },
                },
                {
                  kind: 'transfer_in',
                  warehouseId: a.w2,
                  qty: '2',
                  value: '50',
                  unitCost: '50',
                  stockSeq: 3,
                  cache: { onHand: '2', valuation: '50', avg: '25' },
                },
              ],
            },
          ],
        },
      );
    });

    expect(outcome.ok, 'a per-line imbalance that cancels across the document must still not commit').toBe(false);
    expect(
      outcome.ok === false ? outcome.message : '',
      `the refusal must be THIS law and not a balance, kind or completeness rule: ${outcome.ok === false ? outcome.message : ''}`,
    ).toContain('inventory.transfer_value_not_conserved');
  }, 300_000);

  it('§4 while the same two-line shape with each line balanced commits, so §3 is the per-line imbalance and not the second line', async () => {
    const a = world.A;
    const v1 = a.variantProduct.variantIds[0];
    const v2 = a.variantProduct.variantIds[1];
    const outcome = await atCommit(async (conn) => {
      await seedOwnerTransferLines(
        conn,
        { tenantId: a.tenantId, businessId: a.businessId, userId: a.userId },
        {
          sourceWarehouseId: a.w1,
          destinationWarehouseId: a.w2,
          lines: [
            {
              variantId: v1,
              qty: '2',
              legs: [
                {
                  kind: 'transfer_out',
                  warehouseId: a.w1,
                  qty: '-2',
                  value: '-100',
                  unitCost: '50',
                  stockSeq: 4,
                  cache: { onHand: '0', valuation: '0', avg: null },
                },
                {
                  kind: 'transfer_in',
                  warehouseId: a.w2,
                  qty: '2',
                  value: '100',
                  unitCost: '50',
                  stockSeq: 4,
                  cache: { onHand: '2', valuation: '100', avg: '50' },
                },
              ],
            },
            {
              variantId: v2,
              qty: '2',
              legs: [
                {
                  kind: 'transfer_out',
                  warehouseId: a.w1,
                  qty: '-2',
                  value: '-100',
                  unitCost: '50',
                  stockSeq: 4,
                  cache: { onHand: '0', valuation: '0', avg: null },
                },
                {
                  kind: 'transfer_in',
                  warehouseId: a.w2,
                  qty: '2',
                  value: '100',
                  unitCost: '50',
                  stockSeq: 4,
                  cache: { onHand: '2', valuation: '100', avg: '50' },
                },
              ],
            },
          ],
        },
      );
    });
    expect(
      outcome.ok,
      `a two-line transfer with every line balanced must commit, or §3 proves nothing about the LINE: ${outcome.ok === false ? outcome.message : ''}`,
    ).toBe(true);
  }, 300_000);
});
