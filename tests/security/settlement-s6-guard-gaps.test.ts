/**
 * P3-S6 T-21 — THE S6 GUARD DISCOVERY AND THE REPLACED SOURCE-GUARD DISCOVERY
 * (docs/PHASE_3_S6_CONTRACT.md §2.3, §7.1, §6 T-21; 0067 R-38, R-70, R-79;
 * 0068 R-73, R-79).
 *
 * `supplier_settlement_guard_gaps()` returns no row at rest and, inside a
 * rolled-back savepoint of a superuser transaction, reports exactly what was
 * sabotaged:
 *   - each of the fourteen triggers (the thirteen §2.3 ones and R-80) dropped (`trigger_missing`),
 *     disabled or enabled for replica sessions only (`trigger_disabled`),
 *     re-created on another function or with a WHEN clause (`trigger_shape`);
 *   - each of the twenty-two digested functions (the fourteen trigger
 *     functions, the two verify helpers, the three arithmetic functions, the
 *     two replaced S5 extension points `purchase_ap_outstanding` and
 *     `purchase_settlement_state` (R-79), and the R-73 credit-note writer
 *     `supplier_credit_note_consume`) with a replaced body (`function_body`),
 *     another owner (`function_owner`), another `search_path`
 *     (`function_search_path`), and a flipped security
 *     (`function_not_definer` for the DEFINER ones, `function_not_invoker`
 *     for the two migrator-owned INVOKER extension points);
 * and the recorded digests are the installed bodies. The replaced
 * `inventory_stock_source_guard_gaps()` reports the credit-note guard at its
 * S6 body (R-70(b)) — sabotaged, both discoveries report it — and every
 * S3/S4/S5 row as before.
 */
import type { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres } from '../helpers/test-app';
import { must, ownerClient, scratch } from '../helpers/inventory-commands';
import { S6_ARITHMETIC, S6_TRIGGERS, S6_VERIFY, S6_WRITER } from '../helpers/supplier-settlement';

beforeAll(async () => {
  await ensurePostgres();
});

interface Gaps {
  readonly s6: string[];
  readonly source: string[];
}

/** Run `sabotage` in a rolled-back savepoint of a superuser transaction and return what both discoveries report. */
async function gapsAfter(sabotage: (c: Client) => Promise<unknown>): Promise<Gaps> {
  const c = await ownerClient();
  try {
    await c.query('BEGIN');
    expect((await c.query(`SELECT 1 FROM supplier_settlement_guard_gaps()`)).rowCount, 'no S6 gap at rest').toBe(0);
    expect((await c.query(`SELECT 1 FROM inventory_stock_source_guard_gaps()`)).rowCount, 'no source gap at rest').toBe(0);
    return await scratch(c, async () => {
      await sabotage(c);
      const s6 = await c.query<{ g: string }>(
        `SELECT table_name || ':' || trigger_name || ':' || missing AS g FROM supplier_settlement_guard_gaps() ORDER BY 1`,
      );
      const source = await c.query<{ g: string }>(`SELECT source_type || ':' || missing AS g FROM inventory_stock_source_guard_gaps() ORDER BY 1`);
      return { s6: s6.rows.map((x) => x.g), source: source.rows.map((x) => x.g) };
    });
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
}

/** The two replaced S5 extension points: migrator-owned INVOKER (R-79). */
const EXTENSION_POINTS = ['purchase_ap_outstanding(uuid,uuid)', 'purchase_settlement_state(uuid,uuid)'] as const;

/** Every DEFINER function the discovery digests, by the row it reports under. */
const DEFINER_ROWS: readonly (readonly [row: string, fn: string])[] = [
  ...S6_TRIGGERS.map(([table, trigger, , , fn]) => [`${table}:${trigger}`, fn] as const),
  ...[...S6_VERIFY, ...S6_ARITHMETIC, S6_WRITER].map((fn) => [`-:${fn}`, fn] as const),
];

const INVOKER_ROWS: readonly (readonly [row: string, fn: string])[] = EXTENSION_POINTS.map((fn) => [`-:${fn}`, fn] as const);

/** The S5 source rows the credit-note guard is reported under by `inventory_stock_source_guard_gaps()`. */
const CREDIT_NOTE_SOURCE_ROW = 'supplier_return:credit_note_immutable';

/** A trigger row's own S5 source row, when the replaced source discovery also watches that trigger. */
const sourceRowsOf = (table: string, trigger: string): string[] =>
  table === 'supplier_credit_notes' && trigger === 'supplier_credit_notes_immutable' ? [CREDIT_NOTE_SOURCE_ROW] : [];

/** Replace a function's body by its own definition plus a comment: same signature, owner, security and path; another digest. */
async function replaceBody(c: Client, fn: string): Promise<void> {
  const def = must((await c.query<{ d: string }>(`SELECT pg_get_functiondef($1::regprocedure) AS d`, [fn])).rows[0], fn).d;
  const replaced = def.replace(/\$function\$\s*$/, '\n-- replaced by T-21\n$function$\n');
  expect(replaced, `${fn} is re-created with another body`).not.toBe(def);
  await c.query(replaced);
}

/** Drop `trigger` and re-create it from its own catalogue definition, rewritten by `edit`. */
async function recreate(c: Client, table: string, trigger: string, edit: (def: string) => string): Promise<void> {
  const def = must(
    (await c.query<{ d: string }>(`SELECT pg_get_triggerdef(t.oid) AS d FROM pg_trigger t WHERE t.tgrelid = $1::regclass AND t.tgname = $2`, [table, trigger]))
      .rows[0],
    `${table}.${trigger}`,
  ).d;
  const replaced = edit(def);
  expect(replaced, 'the definition changed').not.toBe(def);
  await c.query(`DROP TRIGGER ${trigger} ON ${table}`);
  await c.query(replaced);
}

describe('T-21 at rest', () => {
  it('both discoveries report nothing; the S6 discovery watches 14 triggers and 22 functions', async () => {
    expect(await gapsAfter(async () => undefined)).toEqual({ s6: [], source: [] });
    expect(S6_TRIGGERS.length).toBe(14);
    expect(
      DEFINER_ROWS.length + INVOKER_ROWS.length,
      'fourteen trigger functions (R-80 included), two helpers, three arithmetic, two extension points, the writer',
    ).toBe(22);
  });

  it('the recorded digests are exactly the bodies installed now, one per watched function', async () => {
    const c = await ownerClient();
    try {
      const fns = [...DEFINER_ROWS, ...INVOKER_ROWS].map(([, fn]) => fn);
      const r = await c.query<{ f: string; sha: string }>(
        `SELECT p.oid::regprocedure::text AS f, encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') AS sha
           FROM pg_proc p WHERE p.oid = ANY ($1::regprocedure[]) ORDER BY 1`,
        [fns],
      );
      expect(r.rows.map((x) => x.f).sort(), 'every watched function exists').toEqual([...fns].sort());
      const src = must(
        (await c.query<{ s: string }>(`SELECT prosrc AS s FROM pg_proc WHERE oid = 'supplier_settlement_guard_gaps()'::regprocedure`)).rows[0],
      ).s;
      for (const row of r.rows) expect(src, `${row.f} is recorded at its installed body`).toContain(`"${row.f}": "${row.sha}"`);
      expect(src.match(/"[a-z_]+\([a-z,]*\)": "[0-9a-f]{64}"/g)?.length, 'exactly 22 recorded digests').toBe(22);
      const source = must(
        (await c.query<{ s: string }>(`SELECT prosrc AS s FROM pg_proc WHERE oid = 'inventory_stock_source_guard_gaps()'::regprocedure`)).rows[0],
      ).s;
      const note = must(r.rows.find((x) => x.f === 'supplier_credit_note_guard()'));
      expect(source, 'the replaced source discovery records the credit-note guard at its S6 body (R-70(b))').toContain(
        `"supplier_credit_note_guard()": "${note.sha}"`,
      );
    } finally {
      await c.end();
    }
  });
});

describe('T-21 each trigger dropped, disabled, replica-only, re-created on another function or with a WHEN', () => {
  for (const [table, trigger, , , fn] of S6_TRIGGERS) {
    it(`${table}.${trigger}`, async () => {
      const row = `${table}:${trigger}`;
      const source = sourceRowsOf(table, trigger);
      expect(await gapsAfter((c) => c.query(`DROP TRIGGER ${trigger} ON ${table}`)), 'dropped').toEqual({ s6: [`${row}:trigger_missing`], source });
      expect(await gapsAfter((c) => c.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`)), 'disabled').toEqual({
        s6: [`${row}:trigger_disabled`],
        source,
      });
      expect(await gapsAfter((c) => c.query(`ALTER TABLE ${table} ENABLE REPLICA TRIGGER ${trigger}`)), 'replica only').toEqual({
        s6: [`${row}:trigger_disabled`],
        source,
      });
      // S6 demands exactly 'O'; the predecessor discovery accepts an ALWAYS trigger (it still fires).
      expect(await gapsAfter((c) => c.query(`ALTER TABLE ${table} ENABLE ALWAYS TRIGGER ${trigger}`)), 'enabled ALWAYS (not O)').toEqual({
        s6: [`${row}:trigger_disabled`],
        source: [],
      });
      const other = fn === 'payment_method_guard()' ? 'supplier_refund_guard()' : 'payment_method_guard()';
      expect(
        await gapsAfter((c) => recreate(c, table, trigger, (d) => d.replace(/EXECUTE FUNCTION \S+\(\)$/, `EXECUTE FUNCTION ${other}`))),
        'on another function',
      ).toEqual({ s6: [`${row}:trigger_shape`], source });
      expect(
        await gapsAfter((c) => recreate(c, table, trigger, (d) => d.replace(/ FOR EACH ROW /, ' FOR EACH ROW WHEN (true) '))),
        'with a WHEN clause',
      ).toEqual({ s6: [`${row}:trigger_shape`], source });
    });
  }
});

describe('T-21 each DEFINER function: body, owner, search_path, security', () => {
  for (const [row, fn] of DEFINER_ROWS) {
    it(fn, async () => {
      const source = row === 'supplier_credit_notes:supplier_credit_notes_immutable' ? [CREDIT_NOTE_SOURCE_ROW] : [];
      expect(await gapsAfter((c) => replaceBody(c, fn)), 'a replaced body').toEqual({ s6: [`${row}:function_body`], source });
      expect(await gapsAfter((c) => c.query(`ALTER FUNCTION ${fn} OWNER TO daftar_accounting_internal`)), 'another owner').toEqual({
        s6: [`${row}:function_owner`],
        source: row === 'supplier_credit_notes:supplier_credit_notes_immutable' ? [CREDIT_NOTE_SOURCE_ROW] : [],
      });
      expect((await gapsAfter((c) => c.query(`ALTER FUNCTION ${fn} SET search_path = public, pg_temp`))).s6, 'another search_path').toEqual([
        `${row}:function_search_path`,
      ]);
      expect((await gapsAfter((c) => c.query(`ALTER FUNCTION ${fn} SECURITY INVOKER`))).s6, 'INVOKER').toEqual([`${row}:function_not_definer`]);
    });
  }
});

describe('T-21 the two replaced S5 extension points (R-79)', () => {
  for (const [row, fn] of INVOKER_ROWS) {
    it(fn, async () => {
      expect(await gapsAfter((c) => replaceBody(c, fn)), 'a replaced body').toEqual({ s6: [`${row}:function_body`], source: [] });
      expect((await gapsAfter((c) => c.query(`ALTER FUNCTION ${fn} SECURITY DEFINER`))).s6, 'DEFINER').toEqual([`${row}:function_not_invoker`]);
      expect((await gapsAfter((c) => c.query(`ALTER FUNCTION ${fn} OWNER TO daftar_inventory_internal`))).s6, 'owned by the internal principal').toEqual([
        `${row}:function_owner`,
      ]);
      expect((await gapsAfter((c) => c.query(`ALTER FUNCTION ${fn} RESET search_path`))).s6, 'no pinned path').toEqual([`${row}:function_search_path`]);
    });
  }

  it('the 0067-E probes verbatim: purchase_ap_outstanding returning 0, purchase_settlement_state answering false/false', async () => {
    expect(
      (
        await gapsAfter((c) =>
          c.query(`CREATE OR REPLACE FUNCTION purchase_ap_outstanding(p_business_id UUID, p_purchase_id UUID) RETURNS BIGINT
                   LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $probe$ BEGIN RETURN 0; END; $probe$`),
        )
      ).s6,
    ).toEqual(['-:purchase_ap_outstanding(uuid,uuid):function_body']);
    expect(
      (
        await gapsAfter((c) =>
          c.query(`CREATE OR REPLACE FUNCTION purchase_settlement_state(p_business_id UUID, p_purchase_id UUID,
                     OUT payment_allocated BOOLEAN, OUT credit_allocated BOOLEAN)
                   LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $probe$
                   BEGIN payment_allocated := false; credit_allocated := false; END; $probe$`),
        )
      ).s6,
    ).toEqual(['-:purchase_settlement_state(uuid,uuid):function_body']);
  });
});

describe('T-21 the replaced inventory_stock_source_guard_gaps() (R-70(b))', () => {
  it('the S5 credit-note row is reported by both discoveries when its S6 body is neutered', async () => {
    const neutered = await gapsAfter((c) =>
      c.query(`CREATE OR REPLACE FUNCTION supplier_credit_note_guard() RETURNS trigger
               LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN RETURN NEW; END; $$`),
    );
    expect(neutered).toEqual({
      s6: ['supplier_credit_notes:supplier_credit_notes_immutable:function_body'],
      source: [CREDIT_NOTE_SOURCE_ROW],
    });
  });

  for (const [type, missing, table, trigger] of [
    ['supplier_return', 'value_complete', 'supplier_returns', 'supplier_returns_value_complete'],
    ['supplier_return', 'credit_note_same_transaction', 'supplier_credit_notes', 'supplier_credit_notes_same_transaction'],
    ['purchase_reversal', 'source_complete', 'purchase_reversal_lines', 'stock_source_complete_purchase_reversal'],
    ['purchase', 'value_complete', 'purchases', 'purchases_value_complete'],
    ['inventory_transfer', 'source_complete', 'inventory_transfer_lines', 'stock_source_complete_inventory_transfer'],
    ['inventory_adjustment', 'value_complete', 'inventory_adjustments', 'inventory_adjustments_value_complete'],
  ] as const) {
    it(`the predecessor row ${type}:${missing} is reported as before, and the S6 discovery is silent`, async () => {
      expect(await gapsAfter((c) => c.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`))).toEqual({ s6: [], source: [`${type}:${missing}`] });
    });
  }
});
