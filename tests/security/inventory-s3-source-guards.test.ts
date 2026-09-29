/**
 * P3-S3 T-13 — THE STRENGTHENED `inventory_stock_source_guard_gaps()`
 * (docs/PHASE_3_S3_CONTRACT.md A-16, §6 T-13).
 *
 * Under H-6 — as the schema owner, in a transaction that is always rolled
 * back — each guard of each of the four S3 source types is removed, disabled
 * or replaced in turn, and the catalogue report must name EXACTLY that gap
 * (`source_type`, `missing`) and nothing else. The unmutated catalogue
 * reports nothing (the ALLOW). A newly registered source type with no guard
 * at all is reported as both `bridge` and `binding_trigger`.
 */
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres } from '../helpers/test-app';
import { ownerClient } from '../helpers/inventory-commands';

let c: Client;

beforeAll(async () => {
  await ensurePostgres();
  c = await ownerClient();
});

afterAll(async () => {
  await c.end();
});

const TYPES = ['inventory_adjustment', 'inventory_opening', 'inventory_transfer', 'stocktake'] as const;
type SourceType = (typeof TYPES)[number];

async function gaps(): Promise<{ source_type: string; missing: string }[]> {
  return (await c.query<{ source_type: string; missing: string }>(`SELECT source_type, missing FROM inventory_stock_source_guard_gaps() ORDER BY 1, 2`)).rows;
}

/** Run `sql` in a transaction that is rolled back, and return the report as it stood inside it. */
async function reportAfter(sql: readonly string[]): Promise<{ source_type: string; missing: string }[]> {
  await c.query('BEGIN');
  try {
    for (const s of sql) await c.query(s);
    return await gaps();
  } finally {
    await c.query('ROLLBACK');
  }
}

/** Every single-guard mutation of source type `st`, with the one `missing` value it must produce. */
function mutations(st: SourceType): readonly { what: string; sql: readonly string[]; missing: readonly string[] }[] {
  const bridge = `stock_source_bridge_${st}`;
  const imm = `stock_bridge_immutable_${st}`;
  const bind = `stock_binding_requires_${st}`;
  const fn = `stock_binding_requires_${st}()`;
  const recreateBinding = (def: string): string[] => [`DROP TRIGGER ${bind} ON stock_source_bindings`, def];
  const recreateImmutable = (def: string): string[] => [`DROP TRIGGER ${imm} ON ${bridge}`, def];
  return [
    { what: 'bridge renamed away', sql: [`ALTER TABLE ${bridge} RENAME TO ${bridge}_old`], missing: ['bridge'] },
    { what: 'RLS not forced', sql: [`ALTER TABLE ${bridge} NO FORCE ROW LEVEL SECURITY`], missing: ['bridge_rls'] },
    { what: 'RLS disabled', sql: [`ALTER TABLE ${bridge} DISABLE ROW LEVEL SECURITY`], missing: ['bridge_rls'] },
    {
      what: 'primary key changed',
      sql: [
        `ALTER TABLE ${bridge} DROP CONSTRAINT ${bridge}_pkey`,
        `ALTER TABLE ${bridge} ADD PRIMARY KEY (business_id, source_line_id, source_id, movement_kind)`,
      ],
      missing: ['bridge_pk'],
    },
    { what: 'primary key dropped', sql: [`ALTER TABLE ${bridge} DROP CONSTRAINT ${bridge}_pkey`], missing: ['bridge_pk'] },
    { what: 'source_type no longer generated', sql: [`ALTER TABLE ${bridge} ALTER COLUMN source_type DROP EXPRESSION`], missing: ['bridge_source_type'] },
    {
      what: 'generated source_type column dropped',
      sql: [`ALTER TABLE ${bridge} DROP COLUMN source_type CASCADE`],
      missing: ['bridge_binding_fk', 'bridge_source_type'],
    },
    { what: 'binding FK dropped', sql: [`ALTER TABLE ${bridge} DROP CONSTRAINT ${bridge}_binding_fk`], missing: ['bridge_binding_fk'] },
    {
      what: 'binding FK made CASCADE',
      sql: [
        `ALTER TABLE ${bridge} DROP CONSTRAINT ${bridge}_binding_fk`,
        `ALTER TABLE ${bridge} ADD CONSTRAINT ${bridge}_binding_fk FOREIGN KEY (business_id, source_type, source_id, source_line_id, movement_kind)
           REFERENCES stock_source_bindings (business_id, source_type, source_id, source_line_id, movement_kind) ON DELETE CASCADE`,
      ],
      missing: ['bridge_binding_fk'],
    },
    { what: 'line FK dropped', sql: [`ALTER TABLE ${bridge} DROP CONSTRAINT ${bridge}_line_fk`], missing: ['bridge_line_fk'] },
    { what: 'immutability trigger disabled', sql: [`ALTER TABLE ${bridge} DISABLE TRIGGER ${imm}`], missing: ['bridge_immutable'] },
    { what: 'immutability trigger ENABLE REPLICA', sql: [`ALTER TABLE ${bridge} ENABLE REPLICA TRIGGER ${imm}`], missing: ['bridge_immutable'] },
    {
      what: 'immutability trigger on another function',
      sql: recreateImmutable(`CREATE TRIGGER ${imm} BEFORE UPDATE OR DELETE ON ${bridge} FOR EACH ROW EXECUTE FUNCTION stock_levels_retain()`),
      missing: ['bridge_immutable'],
    },
    {
      what: 'immutability trigger moved AFTER',
      sql: recreateImmutable(`CREATE TRIGGER ${imm} AFTER UPDATE OR DELETE ON ${bridge} FOR EACH ROW EXECUTE FUNCTION stock_ledger_append_only()`),
      missing: ['bridge_immutable'],
    },
    {
      what: 'immutability trigger without DELETE',
      sql: recreateImmutable(`CREATE TRIGGER ${imm} BEFORE UPDATE ON ${bridge} FOR EACH ROW EXECUTE FUNCTION stock_ledger_append_only()`),
      missing: ['bridge_immutable'],
    },
    { what: 'binding trigger disabled', sql: [`ALTER TABLE stock_source_bindings DISABLE TRIGGER ${bind}`], missing: ['binding_trigger'] },
    { what: 'binding trigger ENABLE REPLICA', sql: [`ALTER TABLE stock_source_bindings ENABLE REPLICA TRIGGER ${bind}`], missing: ['binding_trigger'] },
    {
      what: 'binding trigger not deferred',
      sql: recreateBinding(
        `CREATE CONSTRAINT TRIGGER ${bind} AFTER INSERT ON stock_source_bindings NOT DEFERRABLE FOR EACH ROW WHEN (NEW.source_type = '${st}') EXECUTE FUNCTION ${fn}`,
      ),
      missing: ['binding_trigger'],
    },
    {
      what: 'binding trigger a plain (non-constraint) trigger',
      sql: recreateBinding(`CREATE TRIGGER ${bind} AFTER INSERT ON stock_source_bindings FOR EACH ROW WHEN (NEW.source_type = '${st}') EXECUTE FUNCTION ${fn}`),
      missing: ['binding_trigger'],
    },
    {
      what: 'binding trigger without its WHEN',
      sql: recreateBinding(
        `CREATE CONSTRAINT TRIGGER ${bind} AFTER INSERT ON stock_source_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${fn}`,
      ),
      missing: ['binding_trigger'],
    },
    {
      what: 'binding trigger WHEN on another type',
      sql: recreateBinding(
        `CREATE CONSTRAINT TRIGGER ${bind} AFTER INSERT ON stock_source_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.source_type = 'fixture_line') EXECUTE FUNCTION ${fn}`,
      ),
      missing: ['binding_trigger'],
    },
    {
      what: 'binding trigger also on UPDATE',
      sql: recreateBinding(
        `CREATE CONSTRAINT TRIGGER ${bind} AFTER INSERT OR UPDATE ON stock_source_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.source_type = '${st}') EXECUTE FUNCTION ${fn}`,
      ),
      missing: ['binding_trigger'],
    },
    {
      what: 'binding trigger on another function',
      sql: recreateBinding(
        `CREATE CONSTRAINT TRIGGER ${bind} AFTER INSERT ON stock_source_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.source_type = '${st}') EXECUTE FUNCTION stock_binding_requires_${st === 'stocktake' ? 'inventory_transfer' : 'stocktake'}()`,
      ),
      missing: ['binding_trigger'],
    },
    { what: 'binding function made INVOKER', sql: [`ALTER FUNCTION ${fn} SECURITY INVOKER`], missing: ['binding_trigger'] },
    { what: 'binding function path unpinned', sql: [`ALTER FUNCTION ${fn} RESET search_path`], missing: ['binding_trigger'] },
    { what: 'binding function path changed', sql: [`ALTER FUNCTION ${fn} SET search_path = public, pg_catalog, pg_temp`], missing: ['binding_trigger'] },
    { what: 'binding function owned by the migrator', sql: [`ALTER FUNCTION ${fn} OWNER TO daftar_migrator`], missing: ['binding_trigger'] },
    { what: 'binding function dropped', sql: [`DROP FUNCTION ${fn} CASCADE`], missing: ['binding_trigger'] },
  ];
}

describe('T-13 inventory_stock_source_guard_gaps() names exactly the removed guard', () => {
  it('ALLOW: the installed catalogue reports no gap', async () => {
    expect(await gaps()).toEqual([]);
  });

  for (const st of TYPES) {
    it(`${st}: each of its guards removed, disabled or replaced is reported, and only it`, async () => {
      for (const m of mutations(st)) {
        const report = await reportAfter(m.sql);
        expect(report, `${st}: ${m.what}`).toEqual(m.missing.map((missing) => ({ source_type: st, missing })));
      }
      expect(await gaps(), 'every mutation was rolled back').toEqual([]);
    });
  }

  it('a newly registered source type with no guard at all is reported as bridge and binding_trigger', async () => {
    const report = await reportAfter([`INSERT INTO stock_source_types (source_type, registered_by) VALUES ('zz_unguarded', 'P3-S9')`]);
    expect(report).toEqual([
      { source_type: 'zz_unguarded', missing: 'binding_trigger' },
      { source_type: 'zz_unguarded', missing: 'bridge' },
    ]);
  });
});
