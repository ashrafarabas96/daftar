/**
 * P3-S3 T-11 — IDEMPOTENCY IN THE ROUTINES (docs/PHASE_3_S3_CONTRACT.md A-10,
 * §6 T-11).
 *
 * The client-chosen document id is the idempotency key; the stored
 * `intent_sha256` (the client-intent fields only, never an expected value) is
 * what a repeat must match. A replay answers from stored rows — it never
 * recomputes — so it is byte-identical after the average has moved and
 * succeeds even when the same command would now be refused on its merits. A
 * different intent under the same id is `inventory.idempotency_conflict`; an
 * adjustment id that already names a stocktake, or the reverse, is
 * `inventory.document_id_conflict` (A-10(e)).
 *
 * Every case runs in one owner transaction that is always rolled back; the
 * routines run as `daftar_app` under real assertions. The service-level half
 * (the proof before the stock read, with zero stock reads and zero mints) is
 * in `tests/security/inventory-s3-http.test.ts`.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  adjustCommand,
  atCommit,
  attempt,
  counts,
  damageCommand,
  delta,
  expectAccepted,
  must,
  onHand,
  ownerClient,
  refusedWith,
  runCommand,
  seedS3World,
  stocktakeOpenCommand,
  transferCommand,
  tryCommand,
  withoutRefusal,
  type CommandRow,
  type S3Business,
  type S3Command,
  type S3World,
} from '../helpers/inventory-commands';
import { adjustmentEntry, homeBranch, honestCommand, mintEntry, postEntryInTx, runFinancial, runOpening, stockUp, totalOf } from '../helpers/inventory-posting';

let world: S3World;
let c: Client;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 'idem');
});

afterAll(async () => {
  await resetData();
});

async function inTx(fn: () => Promise<void>): Promise<void> {
  c = await ownerClient();
  try {
    await c.query('BEGIN');
    await fn();
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
}

/** Run a command the way the service would: financial ones with their entry, the opening with its Case A entry. */
async function runAsService(b: S3Business, cmd: S3Command): Promise<CommandRow[]> {
  switch (cmd.kind) {
    case 'adjust':
    case 'damage':
    case 'stocktake_finalize':
      return (await runFinancial(c, b, cmd)).rows;
    case 'opening':
      return (await runOpening(c, b, cmd)).rows;
    default:
      return runCommand(c, b, cmd);
  }
}

const REPLAYABLE = ['transfer', 'adjust', 'damage', 'stocktake_open', 'stocktake_finalize', 'opening'] as const;

describe('T-11.1 a replay returns the stored answer byte for byte, even after the average has moved', () => {
  for (const kind of REPLAYABLE) {
    it(`${kind}: the same command again answers the stored rows with replayed = true and writes only its assertion use`, async () => {
      await inTx(async () => {
        const A = world.A;
        const cmd = await honestCommand(c, A, kind);
        const first = await runAsService(A, cmd);
        expect(first.length).toBeGreaterThan(0);
        expect(first.every((r) => r.replayed === false)).toBe(true);
        expectAccepted(await atCommit(c), 'the first run is complete');

        // Move the average of every key the command touched: a recomputation would now differ.
        await stockUp(c, A, A.w1, [
          { variantId: A.piece.variantId, qty: '3', unitCost: '997' },
          { variantId: A.piece2.variantId, qty: '1', unitCost: '313' },
        ]);
        await stockUp(c, A, A.w2, [{ variantId: A.dec2.variantId, qty: '2', unitCost: '71' }]);

        const before = await counts(c, A.businessId);
        const again = await runCommand(c, A, cmd);
        expect(again).toEqual(first.map((r) => ({ ...r, replayed: true })));
        expect(delta(before, await counts(c, A.businessId)), 'no movement, entry, binding, audit or outbox — only the consumed jti').toEqual({
          inventory_assertion_uses: 1,
        });
        expectAccepted(await atCommit(c));
      });
    });
  }
});

describe('T-11.2 the proof comes before the state: a replay succeeds when the same command would now be refused', () => {
  it('drain the stock after a loss, then replay the loss: the stored answer; the same body under a fresh id → insufficient_stock', async () => {
    await inTx(async () => {
      const A = world.A;
      const key = { warehouseId: A.w1, variantId: A.piece.variantId };
      await stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '5', unitCost: '10' }]);
      const loss = await adjustCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '-3' }]);
      const first = (await runFinancial(c, A, loss)).rows;
      await runFinancial(c, A, await damageCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '2' }]));
      expect(await onHand(c, A.businessId, key)).toBe('0.0000');

      const replay = await runCommand(c, A, loss);
      expect(replay).toEqual(first.map((r) => ({ ...r, replayed: true })));

      // The DENY the replay escaped: the same body, a new id, is judged on the drained stock.
      refusedWith(await tryCommand(c, A, { ...loss, adjustmentId: randomUUID() }), 'P0001', 'inventory.insufficient_stock', 'fresh id on drained stock');
      expectAccepted(await atCommit(c));
    });
  });

  it('the expected value is not part of the intent: a replay presenting a stale or different expected value still answers the stored value', async () => {
    await inTx(async () => {
      const A = world.A;
      await stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '4', unitCost: '25' }]);
      const loss = await adjustCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '-1' }]);
      const first = (await runFinancial(c, A, loss)).rows;
      const l = must(loss.lines[0]);
      const replay = await runCommand(c, A, { ...loss, lines: [{ ...l, expected: l.expected - 7n }] });
      expect(replay).toEqual(first.map((r) => ({ ...r, replayed: true })));
      expect(must(replay[0]).value).toBe(l.expected.toString());
    });
  });
});

describe('T-11.3 a different intent under the same id is idempotency_conflict (409), each paired with the identical replay', () => {
  it('adjustment: another quantity, another reason, another warehouse, or the id reused by a damage', async () => {
    await inTx(async () => {
      const A = world.A;
      await stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '5', unitCost: '10' }]);
      await stockUp(c, A, A.w2, [{ variantId: A.piece.variantId, qty: '5', unitCost: '10' }]);
      const loss = await adjustCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '-1' }]);
      await runFinancial(c, A, loss);
      const l = must(loss.lines[0]);
      const conflicts: [string, S3Command][] = [
        ['quantity', { ...loss, lines: [{ ...l, qty: '-2' }] }],
        ['reason', { ...loss, reason: 'another reason' }],
        ['warehouse', { ...loss, warehouseId: A.w2 }],
        ['date', { ...loss, occurredOn: '2026-01-02' }],
        [
          'a damage under the adjustment id',
          { ...(await damageCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '1' }])), adjustmentId: loss.adjustmentId },
        ],
      ];
      for (const [what, cmd] of conflicts) {
        refusedWith(await tryCommand(c, A, cmd), 'P0001', 'inventory.idempotency_conflict', what);
      }
      expect(must((await runCommand(c, A, loss))[0]).replayed, 'ALLOW: the identical body replays').toBe(true);
    });
  });

  it('transfer, stocktake open and opening: another body under the same id; the identical body replays', async () => {
    await inTx(async () => {
      const A = world.A;
      await stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '5', unitCost: '10' }]);
      const t = transferCommand(A.w1, A.w2, [{ variantId: A.piece.variantId, qty: '2' }]);
      await runCommand(c, A, t);
      refusedWith(
        await tryCommand(c, A, { ...t, lines: [{ variantId: A.piece.variantId, qty: '1' }] }),
        'P0001',
        'inventory.idempotency_conflict',
        'transfer qty',
      );
      refusedWith(await tryCommand(c, A, { ...t, source: A.w2, destination: A.w1 }), 'P0001', 'inventory.idempotency_conflict', 'transfer direction');
      expect(must((await runCommand(c, A, t))[0]).replayed).toBe(true);

      const open = stocktakeOpenCommand(A.w2);
      await runCommand(c, A, open);
      refusedWith(await tryCommand(c, A, { ...open, warehouseId: A.w1 }), 'P0001', 'inventory.idempotency_conflict', 'stocktake warehouse');
      expect(await runCommand(c, A, open)).toEqual([{ stocktake_id: open.stocktakeId, replayed: true }]);

      const opening = await honestCommand(c, A, 'opening');
      if (opening.kind !== 'opening') throw new Error('an opening command');
      await runOpening(c, A, opening);
      const ol = must(opening.lines[0]);
      refusedWith(
        await tryCommand(c, A, { ...opening, lines: [{ ...ol, qty: '5' }, ...opening.lines.slice(1)] }),
        'P0001',
        'inventory.idempotency_conflict',
        'opening qty',
      );
      expect(must((await runCommand(c, A, opening))[0]).replayed).toBe(true);
    });
  });

  it('finalize: a second finalize with another intent is stocktake_state_invalid; the identical one replays', async () => {
    await inTx(async () => {
      const A = world.A;
      const fin = await honestCommand(c, A, 'stocktake_finalize');
      if (fin.kind !== 'stocktake_finalize') throw new Error('a finalize command');
      await runFinancial(c, A, fin);
      refusedWith(await tryCommand(c, A, { ...fin, occurredOn: '2026-01-02' }), 'P0001', 'inventory.stocktake_state_invalid', 'another date');
      expect(must((await runCommand(c, A, fin))[0]).replayed).toBe(true);
    });
  });
});

describe('T-11.5 adjustments and stocktakes share one accounting id space: document_id_conflict (A-10(e))', () => {
  it('an adjustment or damage under a stocktake id, and a stocktake under an adjustment id, are refused; fresh ids are accepted', async () => {
    await inTx(async () => {
      const A = world.A;
      await stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '5', unitCost: '10' }]);
      const open = stocktakeOpenCommand(A.w2);
      await runCommand(c, A, open);
      const adj = await adjustCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '-1' }], { adjustmentId: open.stocktakeId });
      const dmg = await damageCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '1' }], { adjustmentId: open.stocktakeId });
      const before = await counts(c, A.businessId);
      refusedWith(await tryCommand(c, A, adj), 'P0001', 'inventory.document_id_conflict', 'adjustment under a stocktake id');
      refusedWith(await tryCommand(c, A, dmg), 'P0001', 'inventory.document_id_conflict', 'damage under a stocktake id');
      expect(delta(before, await counts(c, A.businessId)), 'the refusals wrote nothing').toEqual({});

      const done = await adjustCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '-1' }]);
      await runFinancial(c, A, done);
      const before2 = await counts(c, A.businessId);
      refusedWith(
        await tryCommand(c, A, stocktakeOpenCommand(A.w1, done.adjustmentId)),
        'P0001',
        'inventory.document_id_conflict',
        'stocktake under an adjustment id',
      );
      expect(delta(before2, await counts(c, A.businessId)), 'the refusal wrote nothing').toEqual({});

      expectAccepted(await tryCommand(c, A, { ...adj, adjustmentId: randomUUID() }), 'ALLOW: the adjustment under a fresh id');
      expectAccepted(await tryCommand(c, A, stocktakeOpenCommand(A.w1)), 'ALLOW: a stocktake under a fresh id');
    });
  });

  /**
   * Negative control: remove the routine's A-10(e) refusal and reuse a
   * finalized stocktake's id for an adjustment. The accounting side still
   * holds: a posting of another value is the ledger's own
   * `accounting.idempotency_conflict`; a posting of the SAME value would
   * silently resolve to the stocktake's entry, and the A-14(a) completeness
   * trigger ("exactly one matching header across the two tables") refuses it
   * at COMMIT.
   */
  for (const variant of ['another value', 'the same value'] as const) {
    it(`negative control (${variant}): with the routine check removed, the accounting side refuses the shared id`, async () => {
      await inTx(async () => {
        const A = world.A;
        const fin = await honestCommand(c, A, 'stocktake_finalize');
        if (fin.kind !== 'stocktake_finalize') throw new Error('a finalize command');
        const posted = await runFinancial(c, A, fin);
        expect(posted.entry, 'the stocktake posted under inventory_adjustment').not.toBeNull();
        expect(totalOf(posted.rows)).toBe(-20n);

        await withoutRefusal(c, 'inventory_adjust_stock(uuid,uuid,date,text,uuid[],numeric[],numeric[],bigint[])', 'inventory.document_id_conflict');
        const qty = variant === 'another value' ? '-1' : '-2';
        const adj = await adjustCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty }], { adjustmentId: fin.stocktakeId });
        const rows = expectAccepted(await tryCommand(c, A, adj), 'the routine no longer refuses');
        const command = must(
          adjustmentEntry(A, {
            sourceId: adj.adjustmentId,
            occurredOn: adj.occurredOn,
            warehouseId: A.w1,
            branchId: await homeBranch(c, A.businessId, A.w1),
            netValueMinor: totalOf(rows),
          }),
        );
        const outcome = await attempt(c, () => postEntryInTx(c, command, A.userId));
        if (variant === 'another value') {
          refusedWith(outcome, 'P0001', 'accounting.idempotency_conflict', 'a second entry of another value under the stocktake id');
        } else {
          const entry = expectAccepted(outcome, 'the same fingerprint resolves to the stocktake entry');
          expect(entry).toEqual({ entryId: must(posted.entry).entryId, created: false });
          refusedWith(await atCommit(c), 'P0001', 'accounting.inventory_entry_mismatch', 'two headers claim one entry');
        }
      });
    });
  }
});

describe('T-11.4 a replay caught inside the routine under seam 2 commits no entry; its accounting assertion is never consumed (A-08)', () => {
  it('the routine answers replayed; the service skips the posting; the minted accounting jti is absent from the registry', async () => {
    await inTx(async () => {
      const A = world.A;
      await stockUp(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '5', unitCost: '10' }]);
      const loss = await adjustCommand(c, A, A.w1, [{ variantId: A.piece.variantId, qty: '-2' }]);
      const first = await runFinancial(c, A, loss);
      const entry = must(first.command);
      // Seam 2 for the replay: the accounting assertion is set beside the inventory one, as the service does.
      const accounting = mintEntry(entry, A.userId);
      const jti = must(accounting.split('.')[10], 'jti');
      await c.query(`SELECT set_config('app.accounting_assertion', $1, true)`, [accounting]);
      const before = await counts(c, A.businessId);
      const replay = await runFinancial(c, A, loss);
      expect(must(replay.rows[0]).replayed).toBe(true);
      expect(replay.entry, 'no posting after a replay').toBeNull();
      expect(delta(before, await counts(c, A.businessId))).toEqual({ inventory_assertion_uses: 1 });
      expect((await c.query(`SELECT 1 FROM accounting_assertion_uses WHERE jti = $1`, [jti])).rowCount).toBe(0);
      expectAccepted(await atCommit(c));
    });
  });
});
