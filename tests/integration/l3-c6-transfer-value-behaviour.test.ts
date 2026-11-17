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
import { seedOwnerTransfer } from '../helpers/stock-ledger';

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
            // in both cases also keeps `value` the ONLY field that differs between
            // §1 and §2, which is what makes §2 a control rather than a second
            // experiment. Measured: no constraint ties value to qty x cost, so 21
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
});
