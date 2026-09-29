/**
 * P3-S5 T-16 — THE REPLACED SOURCE-GUARD DISCOVERY
 * (docs/PHASE_3_S5_CONTRACT.md §2.3, 0065-E, §6 T-16; 0065 R-38, R-53).
 *
 * `inventory_stock_source_guard_gaps()` returns no row at rest, and inside a
 * rolled-back savepoint reports exactly the S5 row that was sabotaged:
 *   - each of the fifteen S5 guard rows (the eleven of §2.3, the three
 *     same-transaction triggers of R-38 and the credit-note immutability
 *     trigger of R-53) disabled, or enabled for replica sessions only;
 *   - each re-created under its own name, table and events on another
 *     function (the definition is read back from the catalogue);
 *   - each of the twelve recorded S5 guard function bodies replaced by a
 *     no-op (its SHA-256 digest), the two binding guards and
 *     `supplier_credit_note_guard()` included;
 *   - the four 0065-E mutation probes verbatim;
 * and the S3 and S4 rows are reported exactly as before.
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

/** The §2.3 S5 rows with the R-38 and R-53 additions: type, missing, table, trigger, function. */
const S5_ROWS: readonly (readonly [type: string, missing: string, table: string, trigger: string, fn: string])[] = [
  ['supplier_return', 'source_complete', 'supplier_return_lines', 'stock_source_complete_supplier_return', 'stock_source_complete_supplier_return()'],
  ['supplier_return', 'header_complete', 'supplier_returns', 'supplier_returns_complete', 'stock_source_complete_supplier_return_header()'],
  ['supplier_return', 'source_freeze', 'supplier_return_lines', 'stock_source_freeze_supplier_return', 'stock_ledger_append_only()'],
  ['supplier_return', 'header_immutable', 'supplier_returns', 'supplier_returns_immutable', 'stock_ledger_append_only()'],
  ['supplier_return', 'value_complete', 'supplier_returns', 'supplier_returns_value_complete', 'supplier_return_value_complete()'],
  ['supplier_return', 'quantity_bound', 'supplier_return_lines', 'supplier_return_lines_quantity_bound', 'supplier_return_quantity_bound()'],
  ['supplier_return', 'line_same_transaction', 'supplier_return_lines', 'supplier_return_lines_same_transaction', 'supplier_return_detail_same_transaction()'],
  [
    'supplier_return',
    'credit_note_same_transaction',
    'supplier_credit_notes',
    'supplier_credit_notes_same_transaction',
    'supplier_return_detail_same_transaction()',
  ],
  // R-53: the A-11(e) credit-note immutability guard.
  ['supplier_return', 'credit_note_immutable', 'supplier_credit_notes', 'supplier_credit_notes_immutable', 'supplier_credit_note_guard()'],
  ['purchase_reversal', 'source_complete', 'purchase_reversal_lines', 'stock_source_complete_purchase_reversal', 'stock_source_complete_purchase_reversal()'],
  ['purchase_reversal', 'header_complete', 'purchase_reversals', 'purchase_reversals_complete', 'stock_source_complete_purchase_reversal_header()'],
  ['purchase_reversal', 'source_freeze', 'purchase_reversal_lines', 'stock_source_freeze_purchase_reversal', 'stock_ledger_append_only()'],
  ['purchase_reversal', 'header_immutable', 'purchase_reversals', 'purchase_reversals_immutable', 'stock_ledger_append_only()'],
  ['purchase_reversal', 'value_complete', 'purchase_reversals', 'purchase_reversals_value_complete', 'purchase_reversal_value_complete()'],
  [
    'purchase_reversal',
    'line_same_transaction',
    'purchase_reversal_lines',
    'purchase_reversal_lines_same_transaction',
    'purchase_reversal_detail_same_transaction()',
  ],
];

/** The twelve S5 guard functions whose bodies 0065 records: the ten of the rows above and the two binding guards. */
const S5_DIGESTED = [
  'stock_binding_requires_supplier_return()',
  'stock_binding_requires_purchase_reversal()',
  ...new Set(S5_ROWS.map((r) => r[4]).filter((f) => f !== 'stock_ledger_append_only()')),
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
  it('no row, and the S5 types are registered with their rows', async () => {
    expect(await gapsAfter(async () => undefined)).toEqual([]);
    expect(S5_ROWS.length, 'eleven §2.3 rows, three same-transaction rows, the R-53 credit-note row').toBe(15);
    expect(S5_DIGESTED.length, 'twelve S5 digests (R-53)').toBe(12);
  });
});

describe('T-16 each S5 row, disabled or replica-only, is reported', () => {
  for (const [type, missing, table, trigger] of S5_ROWS) {
    it(`${type}:${missing}`, async () => {
      expect(await gapsAfter((c) => c.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`))).toEqual([`${type}:${missing}`]);
      expect(await gapsAfter((c) => c.query(`ALTER TABLE ${table} ENABLE REPLICA TRIGGER ${trigger}`))).toEqual([`${type}:${missing}`]);
    });
  }
});

describe('T-16 each S5 row re-created on another function is reported', () => {
  for (const [type, missing, table, trigger, fn] of S5_ROWS) {
    it(`${type}:${missing}`, async () => {
      const other = fn === 'stock_ledger_append_only()' ? 'supplier_credit_note_guard()' : 'stock_ledger_append_only()';
      expect(await gapsAfter((c) => recreateOn(c, table, trigger, other))).toEqual([`${type}:${missing}`]);
    });
  }
});

describe('T-16 an S5 guard function whose body changed is reported', () => {
  for (const fn of S5_DIGESTED.filter((f) => !f.startsWith('stock_binding_requires_'))) {
    it(fn, async () => {
      const expected = S5_ROWS.filter((r) => r[4] === fn).map((r) => `${r[0]}:${r[1]}`);
      expect(expected.length, 'the function guards at least one row').toBeGreaterThan(0);
      expect(await gapsAfter((c) => neuter(c, fn))).toEqual(expected.sort());
    });
  }

  for (const [type, fn] of [
    ['supplier_return', 'stock_binding_requires_supplier_return()'],
    ['purchase_reversal', 'stock_binding_requires_purchase_reversal()'],
  ] as const) {
    it(`${fn} (the binding guard)`, async () => {
      expect(await gapsAfter((c) => neuter(c, fn))).toEqual([`${type}:binding_trigger`]);
    });
  }

  it('the recorded digests are the bodies installed now (R-53, R-54 re-recorded)', async () => {
    const c = await ownerClient();
    try {
      const r = await c.query<{ f: string; sha: string }>(
        `SELECT p.oid::regprocedure::text AS f, encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') AS sha
           FROM pg_proc p WHERE p.oid = ANY ($1::regprocedure[]) ORDER BY 1`,
        [S5_DIGESTED],
      );
      expect(r.rows.map((x) => x.f).sort(), 'every digested function exists').toEqual([...S5_DIGESTED].sort());
      const src = must(
        (await c.query<{ s: string }>(`SELECT prosrc AS s FROM pg_proc WHERE oid = 'inventory_stock_source_guard_gaps()'::regprocedure`)).rows[0],
      ).s;
      for (const row of r.rows) expect(src, `${row.f} is recorded at its installed body`).toContain(`"${row.f}": "${row.sha}"`);
    } finally {
      await c.end();
    }
  });
});

describe('T-16 the 0065-E mutation probes', () => {
  it('the supplier-return bridge guard disabled → supplier_return:bridge_immutable', async () => {
    expect(await gapsAfter((c) => c.query(`ALTER TABLE stock_source_bridge_supplier_return DISABLE TRIGGER stock_bridge_immutable_supplier_return`))).toEqual([
      'supplier_return:bridge_immutable',
    ]);
    expect(
      await gapsAfter((c) => c.query(`ALTER TABLE stock_source_bridge_purchase_reversal DISABLE TRIGGER stock_bridge_immutable_purchase_reversal`)),
    ).toEqual(['purchase_reversal:bridge_immutable']);
  });

  it('stock_source_complete_purchase_reversal() with a no-op body → purchase_reversal:source_complete', async () => {
    expect(await gapsAfter((c) => neuter(c, 'stock_source_complete_purchase_reversal()'))).toEqual(['purchase_reversal:source_complete']);
  });

  it('supplier_return_lines_quantity_bound re-created on supplier_return_value_complete() → supplier_return:quantity_bound', async () => {
    expect(await gapsAfter((c) => recreateOn(c, 'supplier_return_lines', 'supplier_return_lines_quantity_bound', 'supplier_return_value_complete()'))).toEqual([
      'supplier_return:quantity_bound',
    ]);
  });

  it('supplier_returns_value_complete enabled for replica only → supplier_return:value_complete', async () => {
    expect(await gapsAfter((c) => c.query(`ALTER TABLE supplier_returns ENABLE REPLICA TRIGGER supplier_returns_value_complete`))).toEqual([
      'supplier_return:value_complete',
    ]);
  });
});

describe('T-16 the S3 and S4 rows are reported exactly as before', () => {
  for (const [type, missing, table, trigger] of [
    ['inventory_transfer', 'source_complete', 'inventory_transfer_lines', 'stock_source_complete_inventory_transfer'],
    ['inventory_adjustment', 'value_complete', 'inventory_adjustments', 'inventory_adjustments_value_complete'],
    ['stocktake', 'header_complete', 'stocktakes', 'stocktakes_finalized_complete'],
    ['inventory_opening', 'header_immutable', 'inventory_openings', 'inventory_openings_immutable'],
    ['purchase', 'source_complete', 'purchase_lines', 'stock_source_complete_purchase'],
    ['purchase', 'value_complete', 'purchases', 'purchases_value_complete'],
    ['negative_inventory_cost_adjustment', 'deficit_guard', 'negative_inventory_deficits', 'negative_inventory_deficits_coverage_guard'],
  ] as const) {
    it(`${type}:${missing}`, async () => {
      expect(await gapsAfter((c) => c.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`))).toEqual([`${type}:${missing}`]);
    });
  }

  it('the S3 and S4 bridge guards disabled are each reported as their own type', async () => {
    expect(
      await gapsAfter((c) => c.query(`ALTER TABLE stock_source_bridge_inventory_transfer DISABLE TRIGGER stock_bridge_immutable_inventory_transfer`)),
    ).toEqual(['inventory_transfer:bridge_immutable']);
    expect(await gapsAfter((c) => c.query(`ALTER TABLE stock_source_bridge_purchase DISABLE TRIGGER stock_bridge_immutable_purchase`))).toEqual([
      'purchase:bridge_immutable',
    ]);
  });
});
