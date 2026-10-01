/**
 * P3-S4 — DEFICIT SEEDING (docs/PHASE_3_S4_CONTRACT.md §5 "Deficit seeding",
 * A-16(j); L:470, the S2 vector precedent `"seededByOwner": true`).
 *
 * No Phase 3 merchant command creates a deficit, so the coverage path is
 * reached by seeding, as the schema owner, in the test database only:
 *
 * 1. the S2 fixture source (`installStockFixture`, `FIXTURE_SOURCE_TYPE`) —
 *    in the caller's rolled-back transaction, or committed for the suites
 *    that drive the real HTTP service;
 * 2. one negative fixture movement per key and a consistent `stock_levels`
 *    row (`seedOwnerMovement`), with the vector's stored state;
 * 3. the `negative_inventory_deficits` layers, `deficit_seq` through
 *    `inventory_next_deficit_seq` (0060), so that Σ uncovered = −on_hand;
 * 4. afterwards, for the committed form, everything removed again.
 *
 * DEVIATION (recorded in the report): §5 names `installCommittedFixture` /
 * `removeCommittedFixture` of `stock-ledger.ts`, "evolved" by §7.3 to
 * truncate the S4 tables. That evolution belongs to the predecessor-pin
 * owner, and at this base the S2 pair still asserts the S3-only migration
 * state and truncates without the S4 bridges (0A000 since 0063). The
 * committed form here therefore installs the same `installStockFixture` SQL
 * and removes it with the S4-aware TRUNCATE list and the S4 migration-state
 * assertion, byte-for-byte the S2 drop list otherwise.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import {
  FIXTURE_SOURCE_TYPE,
  S1_OPERATION_KINDS,
  S3_OPERATION_KINDS,
  S3_OPERATION_MOVEMENT_KINDS,
  S3_SOURCE_TYPES,
  // P3-S5 (0065/0066)
  S5_OPERATION_KINDS,
  S5_OPERATION_MOVEMENT_KINDS,
  S5_SOURCE_TYPES,
  // P3-S6 (0067/0068)
  S6_OPERATION_KINDS,
  installStockFixture,
  must,
  ownerClient,
  seedOwnerMovement,
  setScope,
  type Queryable,
} from './stock-ledger';
import { P3C_OPERATION_KINDS } from './p3c-migrations';
import { ownerPool } from './test-app';
import type { S3Business } from './inventory-commands';

// ── the coverage vectors (packages/inventory/vectors/coverage-vectors.json) ─

export interface VectorState {
  readonly onHand: string;
  readonly valuation: string;
  readonly avg: string | null;
}

export interface VectorLayer {
  readonly deficitId: string;
  readonly deficitSeq: string;
  readonly uncovered: string;
  readonly provisional: string;
}

export interface VectorSeed {
  readonly variantId: string;
  readonly state: VectorState;
  readonly layers: readonly VectorLayer[];
}

export interface VectorCoverage {
  readonly deficitId: string;
  readonly qtyCovered: string;
  readonly provisional: string;
  readonly actual: string;
  readonly formulaMinor: string;
  readonly valueMinor: string;
  readonly flush: boolean;
  readonly movement: boolean;
  readonly uncoveredAfter: string;
  readonly statusAfter: string;
}

export interface VectorReceiptLine {
  readonly lineId: string;
  readonly variantId: string;
  readonly qty: string;
  readonly baseShareMinor: string;
}

export interface VectorReceipt {
  readonly adjustmentId: string;
  readonly lines: readonly VectorReceiptLine[];
  readonly expect: {
    readonly lines: readonly {
      readonly lineId: string;
      readonly actual: string;
      readonly covered: string;
      readonly catchUpMinor: string;
      readonly coverages: readonly VectorCoverage[];
      readonly stateAfter: VectorState;
    }[];
    readonly covered: string;
    readonly totalValueBaseMinor: string;
    readonly header: boolean;
    readonly catchUpEntry: boolean;
  };
}

export interface CoverageVector {
  readonly id: string;
  readonly why: string;
  readonly seed: readonly VectorSeed[];
  readonly receipts: readonly VectorReceipt[];
}

/** The coverage vectors, read from the package (never restated here). */
export function coverageVectors(): readonly CoverageVector[] {
  return (JSON.parse(readFileSync(join(__dirname, '../../packages/inventory/vectors/coverage-vectors.json'), 'utf8')) as { cases: CoverageVector[] }).cases;
}

export function coverageVector(id: string): CoverageVector {
  return must(
    coverageVectors().find((v) => v.id === id),
    `coverage vector ${id}`,
  );
}

// ── seeding ────────────────────────────────────────────────────────────────

/**
 * Seed one key of `biz` at `warehouseId` with a vector seed: the fixture
 * movement standing in for a Phase 4 oversell (stock_seq 1, the vector's
 * state as the cache) and the open layers, each `deficit_seq` taken from
 * `inventory_next_deficit_seq` and checked against the vector. Requires the
 * fixture in the transaction (or committed) and a key with no stock yet.
 */
export async function seedDeficitKey(
  c: Queryable,
  biz: S3Business,
  warehouseId: string,
  variantId: string,
  seed: Omit<VectorSeed, 'variantId'>,
): Promise<string> {
  const scope = { tenantId: biz.tenantId, businessId: biz.businessId, userId: biz.userId };
  const { movementId } = await seedOwnerMovement(c, {
    scope,
    key: { warehouseId, variantId },
    kind: 'adjustment',
    qty: seed.state.onHand,
    unitCost: seed.state.avg,
    value: seed.state.valuation,
    reason: 'a Phase 4 oversell stand-in',
    stockSeq: 1,
    cache: seed.state,
  });
  await setScope(c, biz);
  for (const layer of seed.layers) {
    const next = must(
      (await c.query<{ n: string }>(`SELECT inventory_next_deficit_seq($1::uuid, $2::uuid, $3::uuid)::text AS n`, [biz.businessId, warehouseId, variantId]))
        .rows[0],
    ).n;
    expect(next, `the next deficit_seq of layer ${layer.deficitId}`).toBe(layer.deficitSeq);
    await c.query(
      `INSERT INTO negative_inventory_deficits (tenant_id, business_id, id, warehouse_id, variant_id, source_stock_movement_id, deficit_seq,
                                                original_deficit_qty, uncovered_qty, provisional_unit_cost_base_minor, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8::numeric, $8::numeric, $9::numeric, 'open')`,
      [biz.tenantId, biz.businessId, layer.deficitId, warehouseId, variantId, movementId, next, layer.uncovered, layer.provisional],
    );
  }
  return movementId;
}

/** Seed every key of a vector, mapping the vector's variant ids to real variants of `biz`. */
export async function seedVector(
  c: Queryable,
  biz: S3Business,
  warehouseId: string,
  v: CoverageVector,
  variantOf: (vectorVariant: string) => string,
): Promise<void> {
  for (const s of v.seed) await seedDeficitKey(c, biz, warehouseId, variantOf(s.variantId), s);
}

export interface LayerText {
  readonly id: string;
  readonly uncovered: string;
  readonly status: string;
  readonly original: string;
}

/** The layers of a key as the owner reads them, in FIFO order. */
export async function layersOf(q: Queryable, businessId: string, warehouseId: string, variantId: string): Promise<LayerText[]> {
  return (
    await q.query<LayerText>(
      `SELECT id::text, uncovered_qty::text AS uncovered, status, original_deficit_qty::text AS original
         FROM negative_inventory_deficits WHERE business_id = $1 AND warehouse_id = $2 AND variant_id = $3 ORDER BY deficit_seq, id`,
      [businessId, warehouseId, variantId],
    )
  ).rows;
}

// ── the committed form (the HTTP suites) ──────────────────────────────────

/** The S4 source types and operation kinds 0063/0064 register. */
export const S4_SOURCE_TYPES = ['negative_inventory_cost_adjustment', 'purchase'] as const;
export const S4_OPERATION_KINDS = [
  'purchase.cancel',
  'purchase.draft',
  'purchase.receive',
  'supplier.archive',
  'supplier.create',
  'supplier.reactivate',
  'supplier.update',
] as const;
export const S4_OPERATION_MOVEMENT_KINDS: readonly (readonly [op: string, kind: string])[] = [
  ['purchase.receive', 'negative_inventory_cost_adjustment'],
  ['purchase.receive', 'purchase'],
];

/**
 * The registries after 0064 with no fixture trace: the S3 source types plus
 * the two S4 ones (`P3-S4`), the S3 op→kind rows plus the two S4 ones, the
 * S1 + S3 + S4 kinds, and no fixture use, relation or function.
 *
 * P3-S5 (0065/0066): plus exactly the P3-S5 rows (docs/PHASE_3_S5_CONTRACT.md
 * §7.3 row 16) — the two source types, the two op→kind rows and the two kinds
 * — so the state is exactly S1 + S3 + S4 + S5.
 *
 * P3-S6 (0067/0068): plus exactly the seven P3-S6 kinds (§7.3 row 17; S6
 * registers no stock source type and no op→kind row) — so the state is
 * exactly S1 + S3 + S4 + S5 + S6.
 *
 * Phase 3 corrective (0072): plus exactly the corrective kind
 * (`P3C_OPERATION_KINDS`; no stock source type, no op→kind row).
 */
/**
 * ── P4-S1 re-expression (plan action 7; same defect class as actions 5 and 6) ─
 *
 * Until Phase 4 the three registry reads below were ABSOLUTE: `array_agg` over
 * the whole of `stock_source_types`, `inventory_operation_movement_kinds` and
 * `inventory_operation_kinds`, compared by one `toEqual` against the
 * `S1_/S3_/S4_/S5_/S6_/P3C_` literals. That is a closure rule ("these registries
 * contain nothing else, ever"), not an invariant, and registering a SINGLE
 * Phase 4 operation kind or stock source type turns it red — and with it every
 * permanent Phase 3 suite that calls this helper.
 *
 * Re-expressed PER PHASE, and NOT loosened. Each read is now scoped by the
 * registry's own provenance column, `registered_by ~ '^P3-'`, which is exactly
 * the Phase 3 family: `P3-S1 … P3-S6` plus `P3-C`, the corrective pass
 * (`inventory_operation_kinds`'s own CHECK is
 * `registered_by ~ '^P3-S[0-9]+$' OR registered_by = 'P3-C'`; the other two are
 * `^P3-S[0-9]+$`). So what is asserted is still EXACT EQUALITY over a closed
 * set — every Phase 3 row must be present, and no unowned row may appear inside
 * that set:
 *
 *   - a MISSING Phase 3 registration is still red;
 *   - an EXTRA row claiming Phase 3 provenance is still red, so the scoping
 *     cannot be dodged by mislabelling a Phase 4 row as `P3-S7`;
 *   - a row a later phase legitimately registers as `P4-S2` is out of scope,
 *     which is the whole point: that row is the later phase's gate's business.
 *
 * `uses`, `rels` and `fns` stay ABSOLUTE and unscoped: they assert the fixture
 * left no trace anywhere, which is a statement about this helper's own fixture
 * and has nothing to do with phases.
 *
 * `[[daftar-a-closure-rule-is-not-an-invariant]]`.
 */
export async function assertS4MigrationState(q: Queryable = ownerPool()): Promise<void> {
  const r = await q.query<{ types: string[]; mapping: string[]; kinds: string[]; uses: number; rels: number; fns: number }>(
    `SELECT (SELECT array_agg(source_type || ':' || registered_by ORDER BY source_type)
               FROM stock_source_types WHERE registered_by ~ '^P3-') AS types,
            (SELECT array_agg(op_code || ':' || movement_kind || ':' || registered_by ORDER BY op_code, movement_kind)
               FROM inventory_operation_movement_kinds WHERE registered_by ~ '^P3-') AS mapping,
            (SELECT array_agg(op_code ORDER BY op_code)
               FROM inventory_operation_kinds WHERE registered_by ~ '^P3-') AS kinds,
            (SELECT count(*)::int FROM inventory_assertion_uses WHERE op_code LIKE 'fixture.%') AS uses,
            (SELECT count(*)::int FROM pg_class WHERE relname IN ('stock_fixture_lines', 'stock_source_bridge_fixture_line')) AS rels,
            (SELECT count(*)::int FROM pg_proc WHERE proname LIKE 'stock\\_fixture\\_%' OR proname = 'stock_binding_requires_fixture_line') AS fns`,
  );
  const types = [
    ...S3_SOURCE_TYPES.map((t) => `${t}:P3-S3`),
    ...S4_SOURCE_TYPES.map((t) => `${t}:P3-S4`),
    // P3-S5 (0065/0066)
    ...S5_SOURCE_TYPES.map((t) => `${t}:P3-S5`),
  ].sort();
  const mapping = [
    ...S3_OPERATION_MOVEMENT_KINDS.map(([op, kind]) => `${op}:${kind}:P3-S3`),
    ...S4_OPERATION_MOVEMENT_KINDS.map(([op, kind]) => `${op}:${kind}:P3-S4`),
    // P3-S5 (0065/0066)
    ...S5_OPERATION_MOVEMENT_KINDS.map(([op, kind]) => `${op}:${kind}:P3-S5`),
  ].sort();
  expect(r.rows[0]).toEqual({
    types,
    mapping,
    kinds: [
      ...S1_OPERATION_KINDS,
      ...S3_OPERATION_KINDS,
      ...S4_OPERATION_KINDS,
      // P3-S5 (0065/0066)
      ...S5_OPERATION_KINDS,
      // P3-S6 (0067/0068)
      ...S6_OPERATION_KINDS,
      // Phase 3 corrective (0072)
      ...P3C_OPERATION_KINDS,
    ].sort(),
    uses: 0,
    rels: 0,
    fns: 0,
  });
}

/**
 * Remove a committed fixture and every stock row: TRUNCATE, because the
 * append-only triggers refuse DELETE (E-24).
 *
 * PostgreSQL refuses a TRUNCATE that does not name EVERY table referencing a
 * table being truncated (`0A000`, "cannot truncate a table referenced in a
 * foreign key constraint"), so the statement has to carry the whole
 * referencing closure. That closure used to be written out by hand, one
 * phase at a time — the S3 and S5 bridges, the S5 documents, the six S6
 * tables, the 0072 write-offs — and it was a closure rule in inventory
 * shape: red the moment a later phase added a reference, with the symptom a
 * `beforeAll` dying in four permanent Phase 3 suites rather than anything
 * about purchases. `0077`'s `stock_source_bridge_sale` references
 * `stock_source_bindings` and did exactly that.
 *
 * So the closure is now DISCOVERED from `pg_constraint` and transitively
 * closed, the same idiom as `dropReferencesTo` in
 * `tests/security/phase4-registry-phase-scoping.test.ts:82`. What IS written
 * here is the SEED: the relations this fixture owns and means to empty. Every
 * later phase's reference to one of them is swept in without an edit, and a
 * reference that leaves the seed set is still refused by the database, which
 * is the property the hand-written list was pretending to have.
 *
 * Order does not matter: a single TRUNCATE naming every table in the closure
 * empties them together, so the children-first sequencing the old list was
 * careful about was never load-bearing. The list is sorted for a stable
 * statement.
 *
 * Idempotent.
 */
export async function removeCommittedDeficitFixture(): Promise<void> {
  const c = await ownerClient();
  try {
    await c.query('BEGIN');
    const bridge = must((await c.query<{ r: string | null }>(`SELECT to_regclass('public.stock_source_bridge_fixture_line')::text AS r`)).rows[0]).r;
    const lines = must((await c.query<{ r: string | null }>(`SELECT to_regclass('public.stock_fixture_lines')::text AS r`)).rows[0]).r;
    const extra = [bridge, lines].filter((x): x is string => x !== null);
    /**
     * The seed: what this fixture owns and means to empty. The deficit
     * tables, the stock ledger and its bindings, the purchase documents the
     * fixture commits, and the fixture's own two relations when they exist.
     * Nothing about a later phase is named, and nothing here is a bridge or
     * a document of a slice this helper does not own — those arrive through
     * the closure below.
     */
    const seed = ['stock_source_bindings', 'stock_movements', 'stock_levels', 'negative_inventory_deficits', 'purchase_lines', 'purchases', ...extra];
    /**
     * The transitive referencing closure, read from the catalogue. A table
     * that references anything already in the set joins it, and then its own
     * referents are asked in turn, so a bridge reached through another
     * bridge is reached too. `to_regclass` keeps a seed that a given
     * database does not have from aborting the sweep.
     */
    const closure = new Set<string>();
    let frontier = seed;
    while (frontier.length > 0) {
      const r = await c.query<{ child: string }>(
        `SELECT DISTINCT k.conrelid::regclass::text AS child
           FROM pg_constraint k
          WHERE k.contype = 'f'
            AND k.confrelid = ANY (SELECT to_regclass('public.' || x) FROM unnest($1::text[]) x)`,
        [frontier],
      );
      for (const x of frontier) closure.add(x.replace(/^public\./, ''));
      frontier = r.rows.map((x) => x.child.replace(/^public\./, '')).filter((x) => !closure.has(x));
    }
    const present = await c.query<{ name: string }>(`SELECT x AS name FROM unnest($1::text[]) x WHERE to_regclass('public.' || x) IS NOT NULL ORDER BY x`, [
      [...closure],
    ]);
    const targets = present.rows.map((x) => x.name);
    // A closure that lost its own seed would truncate the wrong thing and
    // read as a passing fixture, so it is checked rather than assumed.
    for (const want of ['stock_movements', 'stock_source_bindings', 'purchases']) {
      if (!targets.includes(want)) throw new Error(`removeCommittedDeficitFixture: the discovered closure lost ${want}`);
    }
    await c.query(`TRUNCATE ${targets.join(', ')}`);
    await c.query(`DROP TRIGGER IF EXISTS stock_binding_requires_${FIXTURE_SOURCE_TYPE} ON stock_source_bindings`);
    await c.query(`DROP TABLE IF EXISTS stock_source_bridge_fixture_line`);
    await c.query(`DROP TABLE IF EXISTS stock_fixture_lines`);
    for (const f of [
      `stock_binding_requires_${FIXTURE_SOURCE_TYPE}()`,
      'stock_fixture_lines_freeze()',
      'stock_fixture_apply(UUID, inventory_movement_request[], BOOLEAN)',
      'stock_fixture_apply_other(UUID, inventory_movement_request[], BOOLEAN)',
      'stock_fixture_lock_in_payload_order(UUID, UUID, UUID[], UUID[], BIGINT)',
      'stock_fixture_unlocked_add(UUID, UUID, UUID, NUMERIC, BIGINT)',
    ]) {
      await c.query(`DROP FUNCTION IF EXISTS ${f}`);
    }
    await c.query(`DELETE FROM inventory_assertion_uses WHERE op_code LIKE 'fixture.%'`);
    await c.query(`DELETE FROM inventory_operation_movement_kinds WHERE op_code LIKE 'fixture.%'`);
    await c.query(`DELETE FROM stock_source_types WHERE source_type = $1`, [FIXTURE_SOURCE_TYPE]);
    await c.query(`DELETE FROM inventory_operation_kinds WHERE op_code LIKE 'fixture.%'`);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
  await assertS4MigrationState();
}

/** Clean, then install and COMMIT the fixture (the committed HTTP suites only). */
export async function installCommittedDeficitFixture(): Promise<void> {
  await removeCommittedDeficitFixture();
  const c = await ownerClient();
  try {
    await c.query('BEGIN');
    await installStockFixture(c);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}

/** Seed and COMMIT one key (the committed fixture must be installed). */
export async function seedCommittedDeficitKey(biz: S3Business, warehouseId: string, variantId: string, seed: Omit<VectorSeed, 'variantId'>): Promise<void> {
  const c = await ownerClient();
  try {
    await c.query('BEGIN');
    await seedDeficitKey(c, biz, warehouseId, variantId, seed);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}
