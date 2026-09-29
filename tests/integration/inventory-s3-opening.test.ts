/**
 * P3-S3 T-08 — THE INVENTORY OPENING: CASE A, CASE B, THE DOUBLE-COUNT GUARD
 * AND B-1 (docs/PHASE_3_S3_CONTRACT.md A-13, A-14(c)(d), §6 T-08, §9.1 B-1;
 * plan §5 must-prove "Case B off by one minor unit is refused with no entry",
 * "Case B writes no entry (counted)").
 *
 * The opening runs through the REAL `inventory_record_opening` as
 * `daftar_app`; Case A's entry through the real primitive; the opening
 * position through the real P2-S4 draft/post workflow — all in one owner
 * transaction that is always rolled back.
 */
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  allocateOpening,
  atCommit,
  attempt,
  cacheValue,
  counts,
  delta,
  entryOf,
  expectAccepted,
  expectConstraint,
  glInventory,
  movementValue,
  must,
  openingCommand,
  ownerClient,
  refusedWith,
  roundingLines,
  runCommand,
  scratch,
  seedS3World,
  toC10,
  toQ4,
  today,
  tryCommand,
  withoutRefusal,
  type S3World,
} from '../helpers/inventory-commands';
import {
  domainReversalFingerprint,
  openingBalanceReversalFingerprint,
  openingEntry,
  position,
  postEntryInTx,
  postOpeningBalanceInTx,
  reverseInTx,
  runOpening,
  stockUp,
} from '../helpers/inventory-posting';

let world: S3World;
let day: string;
let c: Client;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 'open');
  day = await today();
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

/** Three lines over two warehouses whose weights leave a largest-remainder residue: 1×0.4 + 1×0.4 + 1×0.4 → T = 1. */
function residueLines(): { warehouseId: string; variantId: string; qty: string; unitCost: string }[] {
  const A = world.A;
  return [
    { warehouseId: A.w1, variantId: A.piece.variantId, qty: '1', unitCost: '0.4' },
    { warehouseId: A.w2, variantId: A.piece.variantId, qty: '1', unitCost: '0.4' },
    { warehouseId: A.w1, variantId: A.piece2.variantId, qty: '1', unitCost: '0.4' },
  ];
}

describe('T-08.1 Case A: Dr Inventory per warehouse / Cr Opening equity, shares Σ = T', () => {
  it('posts one Inventory debit per warehouse (with its home branch) and one equity credit; the movements carry the largest-remainder shares', async () => {
    await inTx(async () => {
      const A = world.A;
      const cmd = openingCommand(day, [
        { warehouseId: A.w1, variantId: A.piece.variantId, qty: '3', unitCost: '3.3333333333' },
        { warehouseId: A.w2, variantId: A.dec2.variantId, qty: '2.5', unitCost: '101.01' },
        { warehouseId: A.w1, variantId: A.piece2.variantId, qty: '7', unitCost: '12' },
      ]);
      const before = await counts(c, A.businessId);
      const r = await runOpening(c, A, cmd);
      // weights 9.9999999999 + 252.525 + 84 = 346.5249999999 → T = 347 (HALF_EVEN); the SQL allocation equals the package's.
      const { total, shares } = allocateOpening(cmd.lines.map((l) => ({ qtyQ4: toQ4(l.qty), costC10: toC10(l.unitCost) })));
      expect(total).toBe(347n);
      expect(r.rows.map((x) => [x.case_kind, x.total, x.value])).toEqual(shares.map((s) => ['ledger_posting', '347', s.toString()]));
      expect(shares.reduce((a, b) => a + b, 0n)).toBe(347n);
      const e = must(await entryOf(c, A.businessId, 'inventory_opening', cmd.openingId));
      const w1 = (shares[0] ?? 0n) + (shares[2] ?? 0n);
      expect(e.lines).toEqual([
        { system_key: 'inventory', code: '1200', debit: w1.toString(), credit: '0', warehouse_id: A.w1, branch_id: A.branchX },
        { system_key: 'inventory', code: '1200', debit: (shares[1] ?? 0n).toString(), credit: '0', warehouse_id: A.w2, branch_id: A.branchY },
        { system_key: 'opening_equity', code: '3000', debit: '0', credit: '347', warehouse_id: null, branch_id: null },
      ]);
      expect(delta(before, await counts(c, A.businessId))).toEqual({
        stock_movements: 3,
        stock_source_bindings: 3,
        stock_levels: 3,
        stock_source_bridge_inventory_opening: 3,
        inventory_openings: 1,
        inventory_opening_lines: 3,
        journal_entries: 1,
        journal_lines: 3,
        accounting_source_bindings: 1,
        // One audit and outbox row from the opening, one each from the posting primitive.
        audit_events: 2,
        outbox_events: 2,
        inventory_assertion_uses: 1,
      });
      expectAccepted(await atCommit(c));
      expect(await glInventory(c, A.businessId)).toBe(347n);
      expect(await movementValue(c, A.businessId)).toBe(347n);
      expect(await cacheValue(c, A.businessId)).toBe(347n);
      expect(await roundingLines(c, A.businessId)).toBe(0);
    });
  });

  it('the residue goes to the lowest line number on a tie (SQL = package allocator)', async () => {
    await inTx(async () => {
      const A = world.A;
      const lines = residueLines();
      const r = await runOpening(c, A, openingCommand(day, lines));
      expect(r.rows.map((x) => x.value)).toEqual(allocateOpening(lines.map((l) => ({ qtyQ4: toQ4(l.qty), costC10: toC10(l.unitCost) }))).shares.map(String));
      expect(r.rows.map((x) => x.value)).toEqual(['1', '0', '0']);
      expectAccepted(await atCommit(c));
    });
  });

  it('T-08.8 Case A with T = 0 posts no entry and commits (seam 1)', async () => {
    await inTx(async () => {
      const A = world.A;
      const before = await counts(c, A.businessId);
      const r = await runOpening(c, A, openingCommand(day, [{ warehouseId: A.w1, variantId: A.piece.variantId, qty: '1', unitCost: '0.4' }]));
      expect(r.command).toBeNull();
      expect(must(r.rows[0]).total).toBe('0');
      const d = delta(before, await counts(c, A.businessId));
      expect(d.journal_entries ?? 0).toBe(0);
      expect(d.accounting_source_bindings ?? 0).toBe(0);
      expectAccepted(await atCommit(c));
    });
  });

  it('A-14(a): an opening entry that disagrees with its document is refused at COMMIT; one with no document too', async () => {
    await inTx(async () => {
      const A = world.A;
      const cmd = openingCommand(day, [{ warehouseId: A.w1, variantId: A.piece.variantId, qty: '5', unitCost: '100' }]);
      expectAccepted(await tryCommand(c, A, cmd));
      await scratch(c, async () => {
        await postEntryInTx(
          c,
          must(openingEntry(A, { sourceId: cmd.openingId, occurredOn: day, perWarehouse: [{ warehouseId: A.w1, branchId: A.branchX, valueMinor: 501n }] })),
          A.userId,
        );
        refusedWith(await atCommit(c), 'P0001', 'accounting.inventory_entry_mismatch', 'amount');
      });
      await scratch(c, async () => {
        await postEntryInTx(
          c,
          must(openingEntry(A, { sourceId: cmd.openingId, occurredOn: day, perWarehouse: [{ warehouseId: A.w1, branchId: A.branchY, valueMinor: 500n }] })),
          A.userId,
        );
        refusedWith(await atCommit(c), 'P0001', 'accounting.inventory_entry_mismatch', 'the branch of another warehouse');
      });
      await postEntryInTx(
        c,
        must(openingEntry(A, { sourceId: cmd.openingId, occurredOn: day, perWarehouse: [{ warehouseId: A.w1, branchId: A.branchX, valueMinor: 500n }] })),
        A.userId,
      );
      expectAccepted(await atCommit(c), 'the honest entry');
      const orphan = must(
        openingEntry(A, { sourceId: world.A.w2, occurredOn: day, perWarehouse: [{ warehouseId: A.w1, branchId: A.branchX, valueMinor: 5n }] }),
      );
      await postEntryInTx(c, orphan, A.userId);
      refusedWith(await atCommit(c), 'P0001', 'accounting.inventory_detail_missing');
    });
  });
});

describe('A-14(a)/R-4: a Case A entry debits only the warehouses of its opening', () => {
  /**
   * REAL-BUG PIN. A-14(a): "warehouse_id = the header's warehouse(s)"; R-4
   * (0061 header): the accounting-side check proves the per-warehouse split
   * "for membership, home branch, distinctness and totals". The trigger
   * `accounting_inventory_opening_entry_complete()` (0061:1252-1303) checks
   * one debit per DISTINCT warehouse, its home branch and Σ debits = T — but
   * never that a debited warehouse belongs to the opening. An entry that puts
   * part of the opening's value on a warehouse holding none of it commits, and
   * GL Inventory by warehouse no longer equals the stock valuation.
   * (Per-warehouse AMOUNTS over the right warehouses are, per R-4, proven on
   * the inventory side only; that residual is not pinned here.)
   */
  it('a split onto a warehouse the opening never touched is refused inventory_entry_mismatch', async () => {
    await inTx(async () => {
      const A = world.A;
      const cmd = openingCommand(day, [{ warehouseId: A.w1, variantId: A.piece.variantId, qty: '5', unitCost: '100' }]);
      expectAccepted(await tryCommand(c, A, cmd));
      const perWarehouse = [
        { warehouseId: A.w1, branchId: A.branchX, valueMinor: 300n },
        { warehouseId: A.w2, branchId: A.branchY, valueMinor: 200n },
      ];
      await postEntryInTx(c, must(openingEntry(A, { sourceId: cmd.openingId, occurredOn: day, perWarehouse })), A.userId);
      refusedWith(await atCommit(c), 'P0001', 'accounting.inventory_entry_mismatch', 'Inventory debited to W2, which holds none of this opening');
    });
  });

  it('ALLOW: the same opening split over the warehouses it holds commits', async () => {
    await inTx(async () => {
      const A = world.A;
      const cmd = openingCommand(day, [
        { warehouseId: A.w1, variantId: A.piece.variantId, qty: '3', unitCost: '100' },
        { warehouseId: A.w2, variantId: A.piece.variantId, qty: '2', unitCost: '100' },
      ]);
      expectAccepted(await tryCommand(c, A, cmd));
      const perWarehouse = [
        { warehouseId: A.w1, branchId: A.branchX, valueMinor: 300n },
        { warehouseId: A.w2, branchId: A.branchY, valueMinor: 200n },
      ];
      await postEntryInTx(c, must(openingEntry(A, { sourceId: cmd.openingId, occurredOn: day, perWarehouse })), A.userId);
      expectAccepted(await atCommit(c), 'W1 300 / W2 200 for shares 300 / 200');
    });
  });

  /** R-15: the right total over the right warehouses, split wrongly, no longer commits. */
  it('the right warehouses and total with a wrong per-warehouse split is refused inventory_entry_mismatch', async () => {
    await inTx(async () => {
      const A = world.A;
      const cmd = openingCommand(day, [
        { warehouseId: A.w1, variantId: A.piece.variantId, qty: '3', unitCost: '100' },
        { warehouseId: A.w2, variantId: A.piece.variantId, qty: '2', unitCost: '100' },
      ]);
      expectAccepted(await tryCommand(c, A, cmd));
      const perWarehouse = [
        { warehouseId: A.w1, branchId: A.branchX, valueMinor: 400n },
        { warehouseId: A.w2, branchId: A.branchY, valueMinor: 100n },
      ];
      await postEntryInTx(c, must(openingEntry(A, { sourceId: cmd.openingId, occurredOn: day, perWarehouse })), A.userId);
      refusedWith(await atCommit(c), 'P0001', 'accounting.inventory_entry_mismatch', 'W1 400 / W2 100 for shares 300 / 200');
    });
  });

  it('a split that omits a warehouse of the opening is refused inventory_entry_mismatch', async () => {
    await inTx(async () => {
      const A = world.A;
      const cmd = openingCommand(day, [
        { warehouseId: A.w1, variantId: A.piece.variantId, qty: '3', unitCost: '100' },
        { warehouseId: A.w2, variantId: A.piece.variantId, qty: '2', unitCost: '100' },
      ]);
      expectAccepted(await tryCommand(c, A, cmd));
      const perWarehouse = [{ warehouseId: A.w1, branchId: A.branchX, valueMinor: 500n }];
      await postEntryInTx(c, must(openingEntry(A, { sourceId: cmd.openingId, occurredOn: day, perWarehouse })), A.userId);
      refusedWith(await atCommit(c), 'P0001', 'accounting.inventory_entry_mismatch', 'all of T on W1 when W2 holds 200');
    });
  });

  it('the header records the per-warehouse split the movements carry (only warehouses whose sum is > 0)', async () => {
    await inTx(async () => {
      const A = world.A;
      const cmd = openingCommand(day, [
        { warehouseId: A.w1, variantId: A.piece.variantId, qty: '3', unitCost: '100' },
        { warehouseId: A.w1, variantId: A.piece2.variantId, qty: '2', unitCost: '100' },
        { warehouseId: A.w2, variantId: A.piece2.variantId, qty: '1', unitCost: '0' },
      ]);
      expectAccepted(await tryCommand(c, A, cmd));
      const h = must(
        (
          await c.query<{ ids: string[]; vals: string[] }>(
            `SELECT split_warehouse_ids::text[] AS ids, split_values_base_minor::text[] AS vals FROM inventory_openings WHERE id = $1`,
            [cmd.openingId],
          )
        ).rows[0],
      );
      expect(h, 'W2 holds a zero-valued line only, so it is not in the split').toEqual({ ids: [A.w1], vals: ['500'] });
      const byWarehouse = (
        await c.query<{ w: string; v: string }>(
          `SELECT l.warehouse_id::text AS w, sum(m.value_delta_base_minor)::text AS v
             FROM inventory_opening_lines l
             JOIN stock_movements m ON m.business_id = l.business_id AND m.source_type = 'inventory_opening'
                                   AND m.source_id = l.opening_id AND m.source_line_id = l.id
            WHERE l.opening_id = $1 GROUP BY 1 ORDER BY 1`,
          [cmd.openingId],
        )
      ).rows;
      expect(Object.fromEntries(byWarehouse.map((r) => [r.w, r.v]))).toEqual({ [A.w1]: '500', [A.w2]: '0' });
      const perWarehouse = [{ warehouseId: A.w1, branchId: A.branchX, valueMinor: 500n }];
      await postEntryInTx(c, must(openingEntry(A, { sourceId: cmd.openingId, occurredOn: day, perWarehouse })), A.userId);
      expectAccepted(await atCommit(c), 'W1 500 for the one warehouse of the split');
    });
  });
});

describe('T-08.2/3 Case B: decomposing the Inventory opening position', () => {
  it('exact: no entry (counted), the header and audit record the opening balance and the matched amount', async () => {
    // P3-S8 R-B1a (docs/PHASE_3_S8_CONTRACT.md Annex R §2.7, coordinator
    // ruling): since 0069 an `opening_balance` entry with an Inventory line is
    // refused at COMMIT once its business has a stock movement — including a
    // movement written earlier in the SAME transaction. Production never posts
    // the opening balance and decomposes it in one transaction: they are two
    // requests, the opening balance committed before the first movement (Case
    // B's order). So the opening balance is committed first, in its own
    // transaction, on a business of this case's own (the commit is never
    // rolled back, and no other case may see it); then the decomposition runs
    // in the rolled-back transaction with every original assertion.
    const own = await seedS3World(ownerPool(), 'open-caseb');
    const A = own.A;
    const committer = await ownerClient();
    let ob: { openingBalanceId: string; entryId: string };
    try {
      await committer.query('BEGIN');
      ob = await postOpeningBalanceInTx(committer, A, day, [position('inventory', 'D', 5000n), position('cash', 'D', 1000n)]);
      await committer.query('COMMIT');
    } catch (e) {
      await committer.query('ROLLBACK');
      throw e;
    } finally {
      await committer.end();
    }
    await inTx(async () => {
      const glAfterOb = await glInventory(c, A.businessId);
      expect(glAfterOb).toBe(5000n);
      const before = await counts(c, A.businessId);
      const cmd = openingCommand(day, [{ warehouseId: A.w1, variantId: A.piece.variantId, qty: '50', unitCost: '100' }], {
        openingBalanceId: ob.openingBalanceId,
        positionMinor: 5000n,
      });
      const r = await runOpening(c, A, cmd);
      expect(r.command).toBeNull();
      expect(r.rows.map((x) => [x.case_kind, x.total, x.value])).toEqual([['opening_balance_bound', '5000', '5000']]);
      const d = delta(before, await counts(c, A.businessId));
      expect([d.journal_entries ?? 0, d.journal_lines ?? 0, d.accounting_source_bindings ?? 0]).toEqual([0, 0, 0]);
      const h = must(
        (
          await c.query<{ ob: string; matched: string; binding: string | null }>(
            `SELECT opening_balance_id::text AS ob, matched_amount_base_minor::text AS matched, binding_source_id::text AS binding FROM inventory_openings WHERE id = $1`,
            [cmd.openingId],
          )
        ).rows[0],
      );
      expect(h).toEqual({ ob: ob.openingBalanceId, matched: '5000', binding: null });
      const audit = must(
        (
          await c.query<{ m: { case: string; openingBalanceId: string; matchedAmountMinor: string } }>(
            `SELECT metadata AS m FROM audit_events WHERE entity_id = $1`,
            [cmd.openingId],
          )
        ).rows[0],
      );
      expect(audit.m).toMatchObject({ case: 'opening_balance_bound', openingBalanceId: ob.openingBalanceId, matchedAmountMinor: '5000' });
      expectAccepted(await atCommit(c));
      // GL Inventory stays the opening position: the stock decomposes it, it does not add to it.
      expect(await glInventory(c, A.businessId)).toBe(5000n);
      expect(await cacheValue(c, A.businessId)).toBe(5000n);
    });
  });

  it('off by one minor unit either way: opening_valuation_mismatch, and no movement, header or entry', async () => {
    await inTx(async () => {
      const A = world.A;
      const ob = await postOpeningBalanceInTx(c, A, day, [position('inventory', 'D', 5000n)]);
      const before = await counts(c, A.businessId);
      for (const cost of ['100.02', '99.98']) {
        const cmd = openingCommand(day, [{ warehouseId: A.w1, variantId: A.piece.variantId, qty: '50', unitCost: cost }], {
          openingBalanceId: ob.openingBalanceId,
          positionMinor: 5000n,
        });
        refusedWith(await tryCommand(c, A, cmd), 'P0001', 'inventory.opening_valuation_mismatch', cost);
      }
      expect(delta(before, await counts(c, A.businessId))).toEqual({});
    });
  });

  it('the position read from the ledger must be the one the command names: opening_case_changed', async () => {
    await inTx(async () => {
      const A = world.A;
      const lines = [{ warehouseId: A.w1, variantId: A.piece.variantId, qty: '50', unitCost: '100' }];
      // Prepared as Case A; an opening balance with an Inventory line is posted before the routine runs.
      const prepared = openingCommand(day, lines);
      const ob = await postOpeningBalanceInTx(c, A, day, [position('inventory', 'D', 5000n)]);
      refusedWith(await tryCommand(c, A, prepared), 'P0001', 'inventory.opening_case_changed', 'Case A prepared, Case B now');
      refusedWith(
        await tryCommand(c, A, openingCommand(day, lines, { openingBalanceId: ob.openingBalanceId, positionMinor: 4999n })),
        'P0001',
        'inventory.opening_case_changed',
        'a stale position',
      );
      expectAccepted(await tryCommand(c, A, openingCommand(day, lines, { openingBalanceId: ob.openingBalanceId, positionMinor: 5000n })));
    });
  });

  it('an opening balance WITHOUT an Inventory line leaves the opening in Case A', async () => {
    await inTx(async () => {
      const A = world.A;
      await postOpeningBalanceInTx(c, A, day, [position('cash', 'D', 1000n)]);
      const r = await runOpening(c, A, openingCommand(day, [{ warehouseId: A.w1, variantId: A.piece.variantId, qty: '5', unitCost: '100' }]));
      expect(must(r.rows[0]).case_kind).toBe('ledger_posting');
      expectAccepted(await atCommit(c));
      expect(await glInventory(c, A.businessId)).toBe(500n);
    });
  });
});

describe('T-08.4 one posted opening per business', () => {
  it('a second opening is refused opening_already_posted; the first replays', async () => {
    await inTx(async () => {
      const A = world.A;
      const first = openingCommand(day, [{ warehouseId: A.w1, variantId: A.piece.variantId, qty: '5', unitCost: '100' }]);
      await runOpening(c, A, first);
      refusedWith(
        await tryCommand(c, A, openingCommand(day, [{ warehouseId: A.w2, variantId: A.piece2.variantId, qty: '1', unitCost: '1' }])),
        'P0001',
        'inventory.opening_already_posted',
      );
      expect((await runCommand(c, A, first)).map((r) => r.replayed)).toEqual([true]);
      expectAccepted(await atCommit(c));
    });
  });

  it('negative control: with the routine check removed, inventory_openings_posted_uq is the physical backstop (23505)', async () => {
    await inTx(async () => {
      const A = world.A;
      await runOpening(c, A, openingCommand(day, [{ warehouseId: A.w1, variantId: A.piece.variantId, qty: '5', unitCost: '100' }]));
      await withoutRefusal(c, 'inventory_record_opening(uuid,date,uuid,bigint,uuid[],uuid[],numeric[],numeric[])', 'inventory.opening_already_posted');
      expectConstraint(
        await tryCommand(c, A, openingCommand(day, [{ warehouseId: A.w2, variantId: A.piece2.variantId, qty: '1', unitCost: '1' }])),
        '23505',
        'inventory_openings_posted_uq',
      );
    });
  });
});

describe('T-08.6 the A-14(c) double-count guard on the opening-balance workflow', () => {
  it('an opening balance stating Inventory after a Case A opening: opening_balance_inventory_conflict; without Inventory it posts', async () => {
    await inTx(async () => {
      const A = world.A;
      await runOpening(c, A, openingCommand(day, [{ warehouseId: A.w1, variantId: A.piece.variantId, qty: '5', unitCost: '100' }]));
      refusedWith(
        await attempt(c, () => postOpeningBalanceInTx(c, A, day, [position('inventory', 'D', 500n), position('cash', 'D', 100n)])),
        'P0001',
        'accounting.opening_balance_inventory_conflict',
      );
      expectAccepted(await attempt(c, () => postOpeningBalanceInTx(c, A, day, [position('cash', 'D', 100n)])), 'no Inventory line');
      expectAccepted(await atCommit(c));
      expect(await glInventory(c, A.businessId)).toBe(500n);
    });
  });

  it('negative control: with the guard dropped, the same opening balance would double-count Inventory', async () => {
    await inTx(async () => {
      const A = world.A;
      await runOpening(c, A, openingCommand(day, [{ warehouseId: A.w1, variantId: A.piece.variantId, qty: '5', unitCost: '100' }]));
      await c.query('DROP TRIGGER accounting_opening_balances_30_inventory_opening_guard ON accounting_opening_balances');
      expectAccepted(await attempt(c, () => postOpeningBalanceInTx(c, A, day, [position('inventory', 'D', 500n)])), 'the attack succeeds without the guard');
      expect(await glInventory(c, A.businessId)).toBe(1000n);
      expect(await cacheValue(c, A.businessId)).toBe(500n);
    });
  });

  it('a bound opening balance: its reversal is refused (R-13), and even past that the supersede is refused (A-14(c)); an unbound one reverses and supersedes', async () => {
    const A = world.A;
    const positions = [position('inventory', 'D', 5000n)];
    const post = async (bind: boolean): Promise<{ openingBalanceId: string; entryId: string }> => {
      const ob = await postOpeningBalanceInTx(c, A, day, positions);
      if (bind) {
        await runOpening(
          c,
          A,
          openingCommand(day, [{ warehouseId: A.w1, variantId: A.piece.variantId, qty: '50', unitCost: '100' }], {
            openingBalanceId: ob.openingBalanceId,
            positionMinor: 5000n,
          }),
        );
      }
      return ob;
    };
    // Supersession's own precondition (0047): the opening balance's entry is reversed first.
    const reverse = (entryId: string) => attempt(c, () => reverseInTx(c, A, entryId, day, openingBalanceReversalFingerprint(A, entryId, day, positions, day)));
    const supersede = (id: string) =>
      attempt(c, () => c.query(`UPDATE accounting_opening_balances SET status = 'superseded', superseded_at = now() WHERE id = $1`, [id]));

    // First line: the reversal of a bound balance's entry is refused, so the ledger never stops holding the amount.
    await inTx(async () => {
      const ob = await post(true);
      refusedWith(await reverse(ob.entryId), 'P0001', 'accounting.opening_balance_inventory_bound');
    });
    // Second line: with the reversal guard removed in-transaction, the supersede of the bound balance is still refused.
    await inTx(async () => {
      const ob = await post(true);
      await c.query('DROP TRIGGER accounting_reversals_20_domain_source_guard ON accounting_reversals');
      expectAccepted(await reverse(ob.entryId), 'negative control: without the reversal guard the bound entry is reversed');
      refusedWith(await supersede(ob.openingBalanceId), 'P0001', 'accounting.opening_balance_inventory_bound');
    });
    // ALLOW: an opening balance no inventory opening is bound to reverses and supersedes.
    await inTx(async () => {
      const ob = await post(false);
      expectAccepted(await reverse(ob.entryId), 'an unbound opening balance reverses');
      expectAccepted(await supersede(ob.openingBalanceId), 'an opening balance no inventory opening is bound to');
    });
    // Negative control: with both guards removed, the bound position is reversed and superseded.
    await inTx(async () => {
      const ob = await post(true);
      await c.query('DROP TRIGGER accounting_reversals_20_domain_source_guard ON accounting_reversals');
      await c.query('DROP TRIGGER accounting_opening_balances_30_inventory_opening_guard ON accounting_opening_balances');
      expectAccepted(await reverse(ob.entryId), 'negative control: reversal');
      expectAccepted(await supersede(ob.openingBalanceId), 'negative control: without the guards the bound position is superseded');
    });
  });
});

describe('B-1 and the reversal guard (A-14(b))', () => {
  it('posted → superseded on an inventory opening is refused opening_state_invalid; any other change source_document_immutable', async () => {
    await inTx(async () => {
      const A = world.A;
      const cmd = openingCommand(day, [{ warehouseId: A.w1, variantId: A.piece.variantId, qty: '5', unitCost: '100' }]);
      await runOpening(c, A, cmd);
      refusedWith(
        await attempt(c, () => c.query(`UPDATE inventory_openings SET status = 'superseded' WHERE id = $1`, [cmd.openingId])),
        'P0001',
        'inventory.opening_state_invalid',
      );
      refusedWith(
        await attempt(c, () => c.query(`UPDATE inventory_openings SET occurred_on = occurred_on - 1 WHERE id = $1`, [cmd.openingId])),
        'P0001',
        'inventory.source_document_immutable',
      );
      refusedWith(
        await attempt(c, () => c.query(`DELETE FROM inventory_openings WHERE id = $1`, [cmd.openingId])),
        'P0001',
        'inventory.source_document_immutable',
      );
      refusedWith(
        await attempt(c, () => c.query(`UPDATE inventory_opening_lines SET qty = 1 WHERE opening_id = $1`, [cmd.openingId])),
        'P0001',
        'inventory.source_line_frozen',
      );
    });
  });

  it('the generic reversal of an inventory opening or adjustment entry is refused reversal_source_domain_owned; an ordinary entry reverses', async () => {
    await inTx(async () => {
      const A = world.A;
      const cmd = openingCommand(day, [{ warehouseId: A.w1, variantId: A.piece.variantId, qty: '5', unitCost: '100' }]);
      const o = await runOpening(c, A, cmd);
      const entry = must(o.entry);
      refusedWith(
        await attempt(c, () => reverseInTx(c, A, entry.entryId, day, domainReversalFingerprint(must(o.command), entry.entryId, day))),
        'P0001',
        'accounting.reversal_source_domain_owned',
        'inventory_opening',
      );
      const adj = await stockUp(c, A, A.w2, [{ variantId: A.piece.variantId, qty: '1', unitCost: '7' }]);
      const adjEntry = must(adj.entry);
      refusedWith(
        await attempt(c, () => reverseInTx(c, A, adjEntry.entryId, day, domainReversalFingerprint(must(adj.command), adjEntry.entryId, day))),
        'P0001',
        'accounting.reversal_source_domain_owned',
        'inventory_adjustment',
      );
      const positions = [position('cash', 'D', 100n)];
      const ob = await postOpeningBalanceInTx(c, A, day, positions);
      expectAccepted(
        await attempt(c, () => reverseInTx(c, A, ob.entryId, day, openingBalanceReversalFingerprint(A, ob.entryId, day, positions, day))),
        'an opening balance entry reverses',
      );
    });
  });
});
