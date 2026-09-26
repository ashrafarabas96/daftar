/**
 * P3-S2 — EXACT REBUILD OVER HUNDREDS OF MOVEMENTS (docs/PHASE_3_S2_CONTRACT.md
 * §6: T-06.1 – T-06.5, T-06.N; P:158).
 *
 * A deterministic, seeded generator drives the REAL primitive through the
 * fixture producer. Every stored answer is predicted by the TypeScript twin
 * before it is compared; afterwards R6 (`inventory_stock_verify`) must find
 * the cache equal to R5's fold of the stored movements, and the package's
 * `foldMovements` over the same stored rows must agree with both.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  EMPTY_STOCK_STATE,
  foldMovements,
  formatMinor,
  formatQuantity,
  formatUnitCost,
  parseMinor,
  parseQuantity,
  parseUnitCost,
  simulateMovement,
  type MovementKind,
  type StockState,
} from '../../packages/inventory/src';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  INTERNAL,
  applyAsApp,
  applyOne,
  fold,
  levelOf,
  movementsOf,
  must,
  ownerClient,
  req,
  seedOwnerMovement,
  seedStockBusiness,
  setScope,
  verify,
  withRolledBackFixture,
  type Key,
  type MovementRequest,
  type MovementRow,
  type Queryable,
  type StockBusiness,
} from '../helpers/stock-ledger';

let biz: StockBusiness;
let K1: Key;
let K2: Key;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  biz = await seedStockBusiness(ownerPool(), 'rebuild');
  // One variant (metre, 2 dp) in two warehouses.
  K1 = { warehouseId: biz.warehouse1, variantId: biz.dec2.variantId };
  K2 = { warehouseId: biz.warehouse2, variantId: biz.dec2.variantId };
});

/** mulberry32: a tiny, fully deterministic PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integers drawn by the PRNG, carried as bigint from the start (no float ever holds a quantity or value). */
function draw(rand: () => number, lo: bigint, hi: bigint): bigint {
  const span = hi - lo + 1n;
  // Two 26-bit draws are ample for the spans used here.
  const r = BigInt(Math.floor(rand() * 2 ** 26)) * 2n ** 26n + BigInt(Math.floor(rand() * 2 ** 26));
  return lo + (r % span);
}

const Q2 = 100n; // one hundredth in Q4

interface Planned {
  request: MovementRequest;
  kind: MovementKind;
  qtyQ4: bigint;
  costC10: bigint | null;
  value: bigint | null;
}

/**
 * The next batch for the generator: one or two requests that keep every key
 * at a non-negative quantity and valuation. `states` is the TS prediction.
 */
function nextBatch(rand: () => number, states: Map<string, StockState>): Planned[] {
  const keyNames = ['K1', 'K2'] as const;
  const keyName = keyNames[Math.floor(rand() * 2)] ?? 'K1';
  const key = keyName === 'K1' ? K1 : K2;
  const s = states.get(keyName) ?? EMPTY_STOCK_STATE;
  const qtyText = (q4: bigint) => formatQuantity(q4);
  const costText = (c10: bigint) => formatUnitCost(c10);
  const roll = rand();
  const plan = (
    kind: MovementKind,
    qtyQ4: bigint,
    costC10: bigint | null,
    value: bigint | null,
    reason: string | null,
    k: Key = key,
    ids?: { sourceId: string; sourceLineId: string },
  ): Planned => ({
    request: req(k, kind, qtyText(qtyQ4), {
      unitCost: costC10 === null ? null : costText(costC10),
      value: value === null ? null : formatMinor(value),
      reason,
      ...(ids ?? {}),
    }),
    kind,
    qtyQ4,
    costC10,
    value,
  });
  if (s.onHand <= 0n || roll < 0.3) {
    // A purchase: 2-dp quantity, 10-dp cost; one in five carries a supplied document share.
    const q = draw(rand, 1n, 5000n) * Q2;
    const cost = draw(rand, 0n, 999_999_999_999n);
    const supplied = rand() < 0.2 ? draw(rand, 0n, 50_000n) : null;
    return [plan(rand() < 0.1 ? 'inventory_opening' : 'purchase', q, cost, supplied, null)];
  }
  const partial = s.onHand > Q2 ? draw(rand, 1n, s.onHand / Q2 - 1n) * Q2 : s.onHand;
  if (roll < 0.42) return [plan('damage', -partial, null, null, 'generated damage')];
  if (roll < 0.47) return [plan('damage', -s.onHand, null, null, 'generated full depletion')];
  if (roll < 0.55) return [plan('adjustment', draw(rand, 1n, 300n) * Q2, draw(rand, 0n, 99_999_999_999n), null, 'generated adjustment up')];
  if (roll < 0.63) return [plan('adjustment', -partial, null, null, 'generated adjustment down')];
  if (roll < 0.7) return [plan('stocktake', -partial, null, null, null)];
  if (roll < 0.74) return [plan('supplier_return', -partial, null, null, null)];
  if (roll < 0.88) {
    // A transfer to the other warehouse: both legs, one line, one batch.
    const other = keyName === 'K1' ? K2 : K1;
    const ids = { sourceId: randomUUID(), sourceLineId: randomUUID() };
    const q = rand() < 0.2 ? s.onHand : partial;
    return [plan('transfer_out', -q, null, null, null, key, ids), plan('transfer_in', q, null, null, null, other, ids)];
  }
  // Value-only while on_hand > 0, never taking the valuation below zero.
  const down = s.valuation > 0n && rand() < 0.6;
  const v = down ? -draw(rand, 1n, s.valuation) : draw(rand, 1n, 2_000n);
  return [plan('negative_inventory_cost_adjustment', 0n, null, v, null)];
}

describe('T-06 — rebuild (P:158)', () => {
  it('T-06.1: ≥ 300 generated movements over two keys — every stored value predicted by the TS twin, R6 matches, R5 and foldMovements equal the cache', async () => {
    await withRolledBackFixture(async (c) => {
      const rand = prng(0x5eed_0306);
      const states = new Map<string, StockState>();
      const nameOf = (k: Key): string => (k.warehouseId === K1.warehouseId ? 'K1' : 'K2');
      let count = 0;
      const kinds = new Set<string>();
      let flushes = 0;
      while (count < 320) {
        const batch = nextBatch(rand, states);
        const rows: MovementRow[] = await applyAsApp(
          c,
          biz,
          batch.map((b) => b.request),
        );
        expect(rows).toHaveLength(batch.length);
        for (const [i, b] of batch.entries()) {
          const row = must(rows[i]);
          const name = nameOf({ warehouseId: row.warehouse_id, variantId: row.variant_id });
          const before = states.get(name) ?? EMPTY_STOCK_STATE;
          const out = i > 0 ? must(rows[i - 1]) : undefined;
          const sim = simulateMovement(before, {
            kind: b.kind,
            qtyQ4: b.qtyQ4,
            costC10: b.costC10,
            value: b.value,
            ...(b.kind === 'transfer_in' && out !== undefined
              ? {
                  pairedOut: {
                    value: parseMinor(out.value_delta_base_minor),
                    costC10: parseUnitCost(must(out.unit_cost_base_minor)),
                    qtyQ4: parseQuantity(out.qty_delta),
                  },
                }
              : {}),
          });
          const predicted = {
            value: formatMinor(sim.value),
            snapshot: sim.unitCostSnapshot === null ? null : formatUnitCost(sim.unitCostSnapshot),
            onHand: formatQuantity(sim.next.onHand),
            valuation: formatMinor(sim.next.valuation),
            avg: sim.next.avg === null ? null : formatUnitCost(sim.next.avg),
            seq: sim.next.lastStockSeq.toString(),
          };
          expect(
            {
              value: row.value_delta_base_minor,
              snapshot: row.unit_cost_base_minor,
              onHand: row.on_hand,
              valuation: row.valuation_base_minor,
              avg: row.avg_unit_cost_base_minor,
              seq: row.stock_seq,
            },
            `movement ${count + 1} (${b.kind})`,
          ).toEqual(predicted);
          if (b.qtyQ4 < 0n && sim.next.onHand === 0n) flushes += 1;
          states.set(name, sim.next);
          kinds.add(b.kind);
          count += 1;
        }
      }
      // The generator really exercised the whole surface.
      expect([...kinds].sort()).toEqual(
        [
          'adjustment',
          'damage',
          'inventory_opening',
          'negative_inventory_cost_adjustment',
          'purchase',
          'stocktake',
          'supplier_return',
          'transfer_in',
          'transfer_out',
        ].sort(),
      );
      expect(flushes).toBeGreaterThan(0);

      for (const [name, key] of [
        ['K1', K1],
        ['K2', K2],
      ] as const) {
        const v = await verify(c, biz, key);
        expect(v.matches, `${name} verify`).toBe(true);
        const level = must(await levelOf(c, biz.businessId, key));
        const f = await fold(c, biz, key);
        expect({
          onHand: f.on_hand,
          valuation: f.valuation_base_minor,
          avg: f.avg_unit_cost_base_minor,
          seq: f.last_stock_seq,
          gapless: f.sequence_gapless,
        }).toEqual({
          onHand: level.on_hand,
          valuation: level.valuation_base_minor,
          avg: level.avg_unit_cost_base_minor,
          seq: level.last_stock_seq,
          gapless: true,
        });
        const stored = await movementsOf(c, biz.businessId, key);
        const folded = foldMovements(
          stored.map((m) => ({ stockSeq: BigInt(m.stock_seq), qtyQ4: parseQuantity(m.qty_delta), value: parseMinor(m.value_delta_base_minor) })),
        );
        expect({
          onHand: formatQuantity(folded.onHand),
          valuation: formatMinor(folded.valuation),
          avg: folded.avg === null ? null : formatUnitCost(folded.avg),
          seq: folded.lastStockSeq.toString(),
        }).toEqual({ onHand: level.on_hand, valuation: level.valuation_base_minor, avg: level.avg_unit_cost_base_minor, seq: level.last_stock_seq });
        const predicted = must(states.get(name));
        expect(formatMinor(predicted.valuation)).toBe(level.valuation_base_minor);
      }
      expect(count).toBeGreaterThanOrEqual(300);
    });
  });

  it('T-06.2: a key that empties and refills carries its average through zero, and the rebuild carries it the same way', async () => {
    await withRolledBackFixture(async (c) => {
      await applyOne(c, biz, req(K1, 'purchase', '3', { unitCost: '3.3333333333', value: '10' }));
      await applyOne(c, biz, req(K1, 'damage', '-3', { reason: 'empty' }));
      const empty = await verify(c, biz, K1);
      expect({ cache: empty.cache_avg, rebuilt: empty.rebuilt_avg, onHand: empty.cache_on_hand, matches: empty.matches }).toEqual({
        cache: '3.3333333333',
        rebuilt: '3.3333333333',
        onHand: '0.0000',
        matches: true,
      });
      await applyOne(c, biz, req(K1, 'purchase', '2', { unitCost: '5' }));
      const refilled = await verify(c, biz, K1);
      expect({ cache: refilled.cache_avg, rebuilt: refilled.rebuilt_avg, matches: refilled.matches }).toEqual({
        cache: '5.0000000000',
        rebuilt: '5.0000000000',
        matches: true,
      });
    });
  });

  it('T-06.3: a cache row with last_stock_seq = 0 and no movement matches its (empty) rebuild; a key with no cache row does not', async () => {
    await withRolledBackFixture(async (c) => {
      await c.query(`INSERT INTO stock_levels (tenant_id, business_id, warehouse_id, variant_id) VALUES ($1, $2, $3, $4)`, [
        biz.tenantId,
        biz.businessId,
        K1.warehouseId,
        K1.variantId,
      ]);
      expect(await verify(c, biz, K1)).toEqual({
        cache_on_hand: '0.0000',
        rebuilt_on_hand: '0',
        cache_valuation: '0',
        rebuilt_valuation: '0',
        cache_avg: null,
        rebuilt_avg: null,
        cache_last_seq: '0',
        rebuilt_last_seq: '0',
        matches: true,
      });
      expect((await verify(c, biz, K2)).matches).toBe(false);
    });
  });

  it('T-06.4: an owner-planted drift of any cache column gives matches = false, and verify leaves the drifted cache exactly as it found it', async () => {
    await withRolledBackFixture(async (c) => {
      await applyOne(c, biz, req(K1, 'purchase', '4', { unitCost: '2.5' }));
      await applyOne(c, biz, req(K1, 'damage', '-1', { reason: 'x' }));
      expect((await verify(c, biz, K1)).matches).toBe(true);
      for (const set of [
        'valuation_base_minor = valuation_base_minor + 1',
        'on_hand = on_hand + 0.01',
        'avg_unit_cost_base_minor = avg_unit_cost_base_minor + 0.0000000001',
        'last_stock_seq = last_stock_seq + 1',
      ]) {
        await c.query('SAVEPOINT drift');
        await c.query(`UPDATE stock_levels SET ${set} WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3`, [
          biz.businessId,
          K1.warehouseId,
          K1.variantId,
        ]);
        const before = await levelOf(c, biz.businessId, K1);
        expect((await verify(c, biz, K1)).matches, set).toBe(false);
        expect(await levelOf(c, biz.businessId, K1), `${set}: verify wrote nothing`).toEqual(before);
        await c.query('ROLLBACK TO SAVEPOINT drift');
      }
      expect((await verify(c, biz, K1)).matches).toBe(true);
    });
  });

  it('T-06.4 (gap control): a planted movement that leaves a gap in stock_seq is reported (sequence_gapless = false) and does not match, even with every cache column adjusted to it', async () => {
    await withRolledBackFixture(async (c) => {
      await applyOne(c, biz, req(K1, 'purchase', '4', { unitCost: '2.5' }));
      const src = randomUUID();
      const line = randomUUID();
      await c.query(
        `INSERT INTO stock_fixture_lines (business_id, source_id, id, warehouse_id, variant_id, qty, unit_cost_base_minor) VALUES ($1, $2, $3, $4, $5, 1, 1)`,
        [biz.businessId, src, line, K1.warehouseId, K1.variantId],
      );
      await c.query(
        `INSERT INTO stock_source_bindings (tenant_id, business_id, source_type, source_id, source_line_id, movement_kind) VALUES ($1, $2, 'fixture_line', $3, $4, 'purchase')`,
        [biz.tenantId, biz.businessId, src, line],
      );
      await c.query(
        `INSERT INTO stock_movements (tenant_id, business_id, id, warehouse_id, variant_id, stock_seq, movement_kind, source_type, source_id, source_line_id,
                                      qty_delta, unit_cost_base_minor, value_delta_base_minor, actor_user_id)
         VALUES ($1, $2, gen_random_uuid(), $3, $4, 3, 'purchase', 'fixture_line', $5, $6, 1, 1, 1, $7)`,
        [biz.tenantId, biz.businessId, K1.warehouseId, K1.variantId, src, line, biz.userId],
      );
      await c.query(
        `UPDATE stock_levels SET on_hand = 5, valuation_base_minor = 11, avg_unit_cost_base_minor = 2.2, last_stock_seq = 3
          WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3`,
        [biz.businessId, K1.warehouseId, K1.variantId],
      );
      const f = await fold(c, biz, K1);
      expect({ gapless: f.sequence_gapless, count: f.movement_count, seq: f.last_stock_seq }).toEqual({ gapless: false, count: '2', seq: '3' });
      const v = await verify(c, biz, K1);
      // Every cached value equals its rebuild; the gap ALONE refuses the match.
      expect({
        onHand: v.cache_on_hand === v.rebuilt_on_hand,
        valuation: v.cache_valuation === v.rebuilt_valuation,
        avg: v.cache_avg === v.rebuilt_avg,
        seq: v.cache_last_seq === v.rebuilt_last_seq,
        matches: v.matches,
      }).toEqual({ onHand: true, valuation: true, avg: true, seq: true, matches: false });
    });
  });

  it('T-06.5: the only internal-owned routine whose source UPDATEs stock_levels is R3; control: an in-transaction internal-owned updater is flagged', async () => {
    const updaters = async (q: Queryable): Promise<string[]> =>
      (
        await q.query<{ fn: string }>(
          `SELECT p.oid::regprocedure::text AS fn FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
            WHERE r.rolname = $1 AND p.prosrc ~* 'UPDATE\\s+stock_levels' ORDER BY 1`,
          [INTERNAL],
        )
      ).rows.map((x) => x.fn);
    expect(await updaters(ownerPool())).toEqual(['inventory_apply_stock_movements(inventory_movement_request[])']);
    const c = await ownerClient();
    try {
      await c.query('BEGIN');
      await c.query(`CREATE FUNCTION t065_cache_writer() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
                     AS $f$ UPDATE stock_levels SET on_hand = on_hand WHERE false $f$`);
      await c.query(`ALTER FUNCTION t065_cache_writer() OWNER TO ${INTERNAL}`);
      expect(await updaters(c)).toEqual(['inventory_apply_stock_movements(inventory_movement_request[])', 't065_cache_writer()']);
    } finally {
      await c.query('ROLLBACK');
      await c.end();
    }
  });

  it('T-06.N: on CTRL-FLUSH the rebuild is Σ stored values (1), while on_hand × avg — the forbidden path — gives 0', async () => {
    await withRolledBackFixture(async (c) => {
      const key = { warehouseId: biz.warehouse1, variantId: biz.piece.variantId };
      // 3·10^10 is outside R3's quantity bound (M-3), so the CTRL-FLUSH purchase is seeded raw (H-1)
      // with the stored values R3 produced before the bound: value 1, snapshot 0, avg HALF_EVEN(1 / 3·10^10) = 0.
      await seedOwnerMovement(c, {
        scope: biz,
        key,
        kind: 'purchase',
        qty: '30000000000',
        unitCost: '0',
        value: '1',
        stockSeq: 1,
        cache: { onHand: '30000000000', valuation: '1', avg: '0' },
      });
      const f = await fold(c, biz, key);
      await setScope(c, biz);
      const forbidden = must(
        (
          await c.query<{ v: string }>(
            `SELECT inventory_half_even(on_hand * avg_unit_cost_base_minor, 1, 0)::text AS v FROM stock_levels WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3`,
            [biz.businessId, key.warehouseId, key.variantId],
          )
        ).rows[0],
      ).v;
      expect({ fold: f.valuation_base_minor, forbidden }).toEqual({ fold: '1', forbidden: '0' });
      expect((await verify(c, biz, key)).matches).toBe(true);
      // Planting the forbidden result into the cache is caught by verify.
      await c.query(`UPDATE stock_levels SET valuation_base_minor = $4::bigint WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3`, [
        biz.businessId,
        key.warehouseId,
        key.variantId,
        forbidden,
      ]);
      expect((await verify(c, biz, key)).matches).toBe(false);
    });
  });
});
