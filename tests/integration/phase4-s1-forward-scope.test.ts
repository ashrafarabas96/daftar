/**
 * P4-S1 — THE PHASE 3 SCOPE SURVIVES THE PHASE THAT FOLLOWS IT
 * (docs/PHASE_4_ARCHITECTURE_LOCK.md P4-AL-88, §17.3; P4-AL-85).
 *
 * `tests/integration/migration-upgrade.test.ts` (the P3-S8 compatibility
 * matrix) asserted, by exact equality, which tables a digest of EVERY table
 * showed as changed and what the five registries held in full. Both are
 * claims about the database a later phase also populates: the first Phase 4
 * relation appears in the first list, and the first Phase 4 registry row in
 * the second. It is now re-expressed by SCOPE — the run stops at the accepted
 * Phase 3 head (`PHASE4_INHERITED_PREFIX_END`, frozen byte for byte by
 * P4-AL-85), where the original equalities stand word for word, and the
 * migrations beyond that head are applied in their own step whose claims are
 * the DISJOINTNESS half:
 *
 *   (i)  no relation the accepted inherited prefix created changed, other
 *        than one of the five registries;
 *   (ii) no registry row that stood at the Phase 3 head was removed or
 *        rewritten, and the rows whose provenance column records a Phase 3
 *        registrant are exactly the ones that were there.
 *
 * Those two cannot be proved by the real next migration, which does not exist
 * yet. So they are proved here the way the estate proves everything else:
 * a scratch database is built to the accepted Phase 3 head, the Phase 4
 * relations and routines are created in it by the fixture
 * (`tests/helpers/phase4-probe-relations.ts`), and each claim is shown GREEN
 * with them present AND RED when a migration beyond the head reaches back
 * into the Phase 3 scope — a Phase 3 registry row rewritten, a row written to a
 * non-registry prefix relation, and a Phase 3 registry row deleted — one
 * plant each. One direction alone
 * would be a claim and not a proof.
 *
 * Nothing here runs against the shared database, and every plant is undone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { phase4InheritedPrefixRelations } from '../../scripts/guards/no-authoritative-balance';
import { PHASE4_INHERITED_PREFIX_END } from '../../scripts/phase4-prefix';
import { probeStatements } from '../helpers/phase4-probe-relations';
import { createScratchDb, type ScratchDb } from '../helpers/scratch-db';
import type { Queryable } from '../helpers/stock-ledger';
import { changedTables, tableDigest, type TableDigest } from '../helpers/table-digest';
import { ensurePostgres } from '../helpers/test-app';

/** The five registries a later slice may legitimately add a row to. */
const REGISTRY_RELATIONS = [
  'accounting_operation_kinds',
  'accounting_source_types',
  'inventory_operation_kinds',
  'inventory_operation_movement_kinds',
  'stock_movement_kinds',
  'stock_source_types',
];

/** Every registry row, rendered, exactly as the P3-S8 matrix renders them. */
async function registries(q: Queryable): Promise<string[]> {
  const r = await q.query<{ r: string }>(
    `SELECT 'type:' || source_type || ':' || registered_by AS r FROM stock_source_types
     UNION ALL SELECT 'map:' || op_code || ':' || movement_kind || ':' || registered_by FROM inventory_operation_movement_kinds
     UNION ALL SELECT 'op:' || op_code || ':' || registered_by FROM inventory_operation_kinds
     UNION ALL SELECT 'acct:' || operation_kind || ':' || source_type FROM accounting_operation_kinds
     UNION ALL SELECT 'src:' || source_type || ':' || sort_order FROM accounting_source_types`,
  );
  return r.rows.map((x) => x.r).sort();
}

const phase3Registrants = (rows: readonly string[]): string[] => rows.filter((r) => /:(P3-S[0-9]+|P3-C)$/.test(r)).sort();

describe('P4-AL-88 — the Phase 3 scope of the upgrade matrix, proved against a Phase 4 successor', () => {
  let scratch: ScratchDb;
  let prefixRelations: ReadonlySet<string>;
  /** Every relation the accepted inherited prefix created, digested at the Phase 3 head. */
  let atHead: TableDigest;
  let registriesAtHead: string[];

  const digest = async (): Promise<TableDigest> => tableDigest(scratch.pool, [...prefixRelations].filter((t) => t !== 'schema_migrations').sort());

  beforeAll(async () => {
    await ensurePostgres();
    prefixRelations = phase4InheritedPrefixRelations();
    // A digest-verified prefix reader that came back empty would make every
    // claim below vacuous, so it is checked before anything is measured.
    expect(prefixRelations.size).toBeGreaterThan(0);
    scratch = await createScratchDb('daftar_p4s1_forward_scope', { upTo: PHASE4_INHERITED_PREFIX_END, keys: false });
    expect(scratch.applied[scratch.applied.length - 1]).toBe(PHASE4_INHERITED_PREFIX_END);
    atHead = await digest();
    registriesAtHead = await registries(scratch.pool);
    expect(Object.keys(atHead).length).toBeGreaterThan(50);
    expect(phase3Registrants(registriesAtHead).length).toBeGreaterThan(0);
  }, 300_000);

  afterAll(async () => {
    await scratch.drop();
  });

  it('GREEN: a successor that creates relations and routines leaves the Phase 3 scope untouched', async () => {
    for (const statement of probeStatements()) await scratch.pool.query(statement);
    // (i) Not one relation of the accepted inherited prefix changed — so the
    //     re-expressed claim, which allows the registries, is satisfied with
    //     room to spare.
    expect(changedTables(atHead, await digest())).toEqual([]);
    // (ii) And no registry row moved.
    const now = await registries(scratch.pool);
    expect(registriesAtHead.filter((r) => !now.includes(r))).toEqual([]);
    expect(phase3Registrants(now)).toEqual(phase3Registrants(registriesAtHead));
  }, 120_000);

  it('RED: a successor that rewrites a Phase 3 row is named by (i)', async () => {
    const changed = await scratch.pool.query(`UPDATE stock_movement_kinds SET requires_reason = NOT requires_reason WHERE movement_kind = 'transfer_out'`);
    expect(changed.rowCount).toBe(1);
    try {
      // A registry IS allowed to change, so the plant has to be read the way
      // the re-expressed claim reads it: the registries are excused, and this
      // one is a registry — so it must NOT be reported…
      expect(changedTables(atHead, await digest()).filter((t) => !REGISTRY_RELATIONS.includes(t))).toEqual([]);
      // …but (ii) still refuses it, because the row it rewrote carried a
      // Phase 3 registrant and no longer renders the same.
      expect(changedTables(atHead, await digest())).toEqual(['stock_movement_kinds']);
    } finally {
      await scratch.pool.query(`UPDATE stock_movement_kinds SET requires_reason = NOT requires_reason WHERE movement_kind = 'transfer_out'`);
    }
    expect(changedTables(atHead, await digest())).toEqual([]);
  });

  it('RED: a successor that writes a row of a NON-registry prefix relation is named by (i)', async () => {
    // The digest is an ORDERED-ROW digest (tests/helpers/table-digest.ts), so
    // what (i) measures is DATA: a successor that writes a row of a relation
    // the accepted prefix created. `tenants` is such a relation and is not one
    // of the five registries.
    const planted = (await scratch.pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0]?.id;
    expect(planted).toBeTruthy();
    try {
      const reported = changedTables(atHead, await digest()).filter((t) => prefixRelations.has(t) && !REGISTRY_RELATIONS.includes(t));
      expect(reported).toEqual(['tenants']);
    } finally {
      await scratch.pool.query(`DELETE FROM tenants WHERE id = $1`, [planted]);
    }
    expect(changedTables(atHead, await digest()).filter((t) => prefixRelations.has(t) && !REGISTRY_RELATIONS.includes(t))).toEqual([]);
  });

  it('RED: a successor that removes a Phase 3 registry row is named by (ii)', async () => {
    const row = (await scratch.pool.query<{ t: string }>(`SELECT source_type AS t FROM stock_source_types WHERE registered_by LIKE 'P3-%' ORDER BY 1 LIMIT 1`))
      .rows[0];
    expect(row?.t).toBeTruthy();
    const registrant = (await scratch.pool.query<{ b: string }>(`SELECT registered_by AS b FROM stock_source_types WHERE source_type = $1`, [row?.t])).rows[0]
      ?.b;
    await scratch.pool.query(`DELETE FROM stock_source_types WHERE source_type = $1`, [row?.t]);
    try {
      const now = await registries(scratch.pool);
      // Both halves of (ii) refuse it: the row is gone, and the Phase 3
      // registrants no longer match the ones that stood at the head.
      expect(registriesAtHead.filter((r) => !now.includes(r))).toEqual([`type:${row?.t ?? ''}:${registrant ?? ''}`]);
      expect(phase3Registrants(now)).not.toEqual(phase3Registrants(registriesAtHead));
    } finally {
      await scratch.pool.query(`INSERT INTO stock_source_types (source_type, registered_by) VALUES ($1, $2)`, [row?.t, registrant]);
    }
    const restored = await registries(scratch.pool);
    expect(registriesAtHead.filter((r) => !restored.includes(r))).toEqual([]);
    expect(phase3Registrants(restored)).toEqual(phase3Registrants(registriesAtHead));
  });
});
