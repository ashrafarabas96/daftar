/**
 * P3-S4 T-16 — THE REPLACED SOURCE-GUARD DISCOVERY
 * (docs/PHASE_3_S4_CONTRACT.md §2.3, A-15, A-16, §6 T-16).
 *
 * `inventory_stock_source_guard_gaps()` returns no row at rest, and inside a
 * rolled-back savepoint reports exactly the §2.3 row that was sabotaged:
 *   - each of the nine S4 guards disabled, or enabled for replica sessions
 *     only;
 *   - each re-created under its own name, table and events on another
 *     function (the definition is read back from the catalogue, so the test
 *     follows the trigger's current event list);
 *   - each S4 guard function's body replaced by a no-op (the recorded
 *     SHA-256 of its `prosrc`), the two binding guards included;
 *   - the M2 additions: the landed-cost freezes, the allocation consistency
 *     trigger and the deficit coverage guard;
 * and the S3 rows are reported exactly as before.
 */
import type { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres } from '../helpers/test-app';
import { must, ownerClient, scratch } from '../helpers/inventory-commands';

beforeAll(async () => {
  await ensurePostgres();
});

/** Run `sabotage` in a rolled-back savepoint of a superuser transaction and return what the discovery reports. */
async function gapsAfter(sabotage: (c: Client) => Promise<unknown>): Promise<string[]> {
  const c = await ownerClient();
  try {
    await c.query('BEGIN');
    expect((await c.query(`SELECT 1 FROM inventory_stock_source_guard_gaps()`)).rowCount, 'no gap at rest').toBe(0);
    return await scratch(c, async () => {
      await sabotage(c);
      const r = await c.query<{ g: string }>(`SELECT source_type || ':' || missing AS g FROM inventory_stock_source_guard_gaps() ORDER BY 1`);
      return r.rows.map((x) => x.g);
    });
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
}

/** The §2.3 table: type, missing, table, trigger, function. */
const S4_ROWS: readonly (readonly [type: string, missing: string, table: string, trigger: string, fn: string])[] = [
  ['purchase', 'source_complete', 'purchase_lines', 'stock_source_complete_purchase', 'stock_source_complete_purchase()'],
  ['purchase', 'header_complete', 'purchases', 'purchases_received_complete', 'stock_source_complete_purchase_header()'],
  ['purchase', 'source_freeze', 'purchase_lines', 'stock_source_freeze_purchase', 'stock_source_freeze_purchase()'],
  ['purchase', 'header_immutable', 'purchases', 'purchases_immutable', 'purchase_header_guard()'],
  ['purchase', 'value_complete', 'purchases', 'purchases_value_complete', 'purchase_source_value_complete()'],
  [
    'negative_inventory_cost_adjustment',
    'source_complete',
    'negative_deficit_coverages',
    'stock_source_complete_negative_inventory_cost_adjustment',
    'stock_source_complete_negative_inventory_cost_adjustment()',
  ],
  ['negative_inventory_cost_adjustment', 'source_freeze', 'negative_deficit_coverages', 'negative_deficit_coverages_append_only', 'stock_ledger_append_only()'],
  [
    'negative_inventory_cost_adjustment',
    'header_immutable',
    'negative_inventory_cost_adjustments',
    'negative_inventory_cost_adjustments_immutable',
    'stock_ledger_append_only()',
  ],
  [
    'negative_inventory_cost_adjustment',
    'value_complete',
    'negative_inventory_cost_adjustments',
    'negative_inventory_cost_adjustments_value_complete',
    'purchase_source_value_complete()',
  ],
];

/** Drop `trigger` and re-create it from its own catalogue definition, on `fn` instead. */
async function recreateOn(c: Client, table: string, trigger: string, fn: string): Promise<void> {
  const def = must(
    (await c.query<{ d: string }>(`SELECT pg_get_triggerdef(t.oid) AS d FROM pg_trigger t WHERE t.tgrelid = $1::regclass AND t.tgname = $2`, [table, trigger]))
      .rows[0],
    `${table}.${trigger}`,
  ).d;
  const replaced = def.replace(/EXECUTE FUNCTION \S+\(\)$/, `EXECUTE FUNCTION ${fn}`);
  expect(replaced, 'the definition names another function').not.toBe(def);
  await c.query(`DROP TRIGGER ${trigger} ON ${table}`);
  await c.query(replaced);
}

/** Replace a trigger function's body with a no-op, keeping its signature, security and path. */
async function neuter(c: Client, fn: string): Promise<void> {
  await c.query(`CREATE OR REPLACE FUNCTION ${fn} RETURNS trigger
                 LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN RETURN NULL; END; $$`);
}

describe('T-16 at rest the discovery reports no gap', () => {
  it('no row', async () => {
    expect(await gapsAfter(async () => undefined)).toEqual([]);
  });
});

describe('T-16 each §2.3 row, disabled or replica-only, is reported', () => {
  for (const [type, missing, table, trigger] of S4_ROWS) {
    it(`${type}:${missing}`, async () => {
      expect(await gapsAfter((c) => c.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`))).toEqual([`${type}:${missing}`]);
      expect(await gapsAfter((c) => c.query(`ALTER TABLE ${table} ENABLE REPLICA TRIGGER ${trigger}`))).toEqual([`${type}:${missing}`]);
    });
  }
});

describe('T-16 each §2.3 row re-created on another function is reported', () => {
  for (const [type, missing, table, trigger, fn] of S4_ROWS) {
    it(`${type}:${missing}`, async () => {
      const other = fn === 'stock_ledger_append_only()' ? 'purchase_header_guard()' : 'stock_ledger_append_only()';
      expect(await gapsAfter((c) => recreateOn(c, table, trigger, other))).toEqual([`${type}:${missing}`]);
    });
  }
});

describe('T-16 a guard function whose body changed is reported', () => {
  const S4_FUNCTIONS = [...new Set(S4_ROWS.map((r) => r.at(4) ?? '').filter((f) => f !== 'stock_ledger_append_only()'))];
  for (const fn of S4_FUNCTIONS) {
    it(fn, async () => {
      const expected = S4_ROWS.filter((r) => r[4] === fn).map((r) => `${r[0]}:${r[1]}`);
      expect(await gapsAfter((c) => neuter(c, fn))).toEqual(expected.sort());
    });
  }

  for (const [type, fn] of [
    ['purchase', 'stock_binding_requires_purchase()'],
    ['negative_inventory_cost_adjustment', 'stock_binding_requires_negative_inventory_cost_adjustment()'],
  ] as const) {
    it(`${fn} (the binding guard)`, async () => {
      expect(await gapsAfter((c) => neuter(c, fn))).toEqual([`${type}:binding_trigger`]);
    });
  }
});

describe('T-16 the M2 additions: the landed-cost freezes, the allocation consistency and the coverage guard', () => {
  for (const [type, table, trigger] of [
    ['purchase', 'purchase_landed_costs', 'purchase_landed_costs_freeze'],
    ['purchase', 'purchase_landed_cost_allocations', 'purchase_landed_cost_allocations_freeze'],
    ['purchase', 'purchase_landed_cost_allocations', 'purchase_allocations_consistent'],
    ['negative_inventory_cost_adjustment', 'negative_inventory_deficits', 'negative_inventory_deficits_coverage_guard'],
  ] as const) {
    it(`${table}.${trigger} disabled → one ${type} gap`, async () => {
      const gaps = await gapsAfter((c) => c.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`));
      expect(gaps, `${trigger} is watched`).toHaveLength(1);
      expect(must(gaps[0]).startsWith(`${type}:`), must(gaps[0])).toBe(true);
    });
  }
});

describe('T-16 the S3 rows are reported exactly as before', () => {
  for (const [type, missing, table, trigger] of [
    ['inventory_transfer', 'source_complete', 'inventory_transfer_lines', 'stock_source_complete_inventory_transfer'],
    ['inventory_adjustment', 'value_complete', 'inventory_adjustments', 'inventory_adjustments_value_complete'],
    ['stocktake', 'header_complete', 'stocktakes', 'stocktakes_finalized_complete'],
    ['inventory_opening', 'header_immutable', 'inventory_openings', 'inventory_openings_immutable'],
  ] as const) {
    it(`${type}:${missing}`, async () => {
      expect(await gapsAfter((c) => c.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`))).toEqual([`${type}:${missing}`]);
    });
  }

  it('an S3 bridge guard disabled, and the S4 purchase bridge guard disabled, are each reported as their own type', async () => {
    expect(
      await gapsAfter((c) => c.query(`ALTER TABLE stock_source_bridge_inventory_transfer DISABLE TRIGGER stock_bridge_immutable_inventory_transfer`)),
    ).toEqual(['inventory_transfer:bridge_immutable']);
    expect(await gapsAfter((c) => c.query(`ALTER TABLE stock_source_bridge_purchase DISABLE TRIGGER stock_bridge_immutable_purchase`))).toEqual([
      'purchase:bridge_immutable',
    ]);
  });
});
