/**
 * P4-S2 — THE BRIDGE-TENANCY RULING, PROVED AGAINST THE LIVE GUARD
 * (docs/PHASE_4_S2_CONTRACT.md B-01; lock §25 "still unresolved", P4-AL-08,
 * P4-AL-29b).
 *
 * The lock left one question for this slice to settle with evidence:
 * `stock_source_bridge_sale`'s tenant carriage. Three accepted facts pull in
 * different directions —
 *
 *   1. `P4-AL-08` requires every Phase 4 relation to carry `tenant_id` and
 *      `business_id` as REAL columns;
 *   2. the accepted precedent `stock_source_bridge_purchase`
 *      (`0063:400-406`) carries NO `tenant_id` and no `(tenant_id,
 *      business_id)` FK, which is why its `tenant_membership` policy uses the
 *      correlated `businesses` subselect (`0063:556-557`) instead of the
 *      direct `tenant_id` form `0052` adopted after measurement;
 *   3. `inventory_stock_source_guard_gaps()` pins the
 *      bridge primary key "exactly".
 *
 * The question is NOT settled by reading the three; it is settled by asking
 * the guard. This suite builds the bridge apparatus four ways inside ONE
 * ROLLED-BACK TRANSACTION under a throwaway source type (`probe`, never
 * `sale`, so it can never collide with `0077`) and reports what the live
 * `inventory_stock_source_guard_gaps()` says about each:
 *
 *   no_tenant         — the 0063 shape                      → no bridge gap
 *   tenant_col        — plus tenant_id and the businesses FK → no bridge gap
 *   tenant_in_pk      — tenant_id added to the PRIMARY KEY   → `bridge_pk`
 *   tenant_in_line_fk — tenant_id added to the line FK       → `bridge_line_fk`
 *
 * So reading 3 does not forbid reading 1; it forbids only putting `tenant_id`
 * in the two column lists the guard pins. `P4-AL-08` WINS, and precedent 2 is
 * an omission rather than a decision — which the rest of the Phase 3 stock
 * estate confirms, because `stock_movements` (`0059:100`), `stock_levels`
 * (`0059:100`) and `stock_source_bindings` (`0059:181`) all carry `tenant_id`
 * with the `(tenant_id, business_id)` FK. `stock_source_bindings` carrying it
 * is the decisive detail: the bridge writer copies the tenant from the binding
 * it bridges, so carrying the column costs no extra read.
 *
 * DDL is transactional in PostgreSQL and `inventory_stock_source_guard_gaps()`
 * is STABLE, so it sees this transaction's uncommitted catalogue. Nothing here
 * commits: every case ends in ROLLBACK, and the suite asserts the registry is
 * unchanged afterwards. It creates no migration and needs none — it runs on
 * the sealed `0076` head, BEFORE the sale bridge is written, which is exactly
 * when the ruling is needed.
 *
 * The one gap every case reports is `binding_trigger`: the deferred
 * `stock_binding_requires_probe()` constraint trigger is NOT built here,
 * because it must be a `SECURITY DEFINER` function owned by
 * `daftar_inventory_internal` and ownership transfer is outside a probe's
 * authority. It is identical in all four cases and is orthogonal to the
 * tenancy question, so the assertions are over the BRIDGE gaps.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { ensurePostgres, ownerPool } from '../helpers/test-app';

/**
 * The seven checks `inventory_stock_source_guard_gaps()` makes about the
 * bridge itself, in the LIVE body at `0067:1438` (`TL-P4-S2-K3`): `bridge`
 * 1518, `bridge_rls` 1521, `bridge_pk` 1529, `bridge_source_type` 1535,
 * `bridge_binding_fk` 1547, `bridge_line_fk` 1564, `bridge_immutable` 1576,
 * and `binding_trigger` 1595 beside them.
 *
 * `P4-AL-29b` cites `0061:307-481`, which is the FIRST of five versions of
 * this function and a body the database no longer holds. Reasoning from it is
 * how a guard gets designed against a check that was replaced: `bridge_pk` is
 * `IS DISTINCT FROM ARRAY['business_id','source_id','source_line_id','movement_kind']`
 * for EVERY source type, and the line FK's `conkey` is pinned to
 * `ARRAY['business_id','source_id','source_line_id']` for every type too —
 * only the FK's TARGET (`confrelid`/`confkey`) is relaxed for a type outside
 * S3/S4/S5, by `NOT (v_s3 OR v_s4 OR v_s5) OR ...` at 1548-1564.
 */
const BRIDGE_GAPS = ['bridge', 'bridge_rls', 'bridge_pk', 'bridge_source_type', 'bridge_binding_fk', 'bridge_line_fk', 'bridge_immutable'] as const;

type Variant = 'no_tenant' | 'tenant_col' | 'tenant_in_pk' | 'tenant_in_line_fk';

/**
 * Build the `probe` apparatus in the named shape, ask the guard, and ROLL
 * BACK. Returns every gap the guard reported for `probe`, in name order.
 */
async function gapsFor(variant: Variant): Promise<readonly string[]> {
  const c: PoolClient = await ownerPool().connect();
  try {
    await c.query('BEGIN');
    // The registry row the guard iterates over. `P4-S2` is admitted only
    // because `0074` widened the pattern — itself worth proving here.
    await c.query(`INSERT INTO stock_source_types (source_type, registered_by) VALUES ('probe', 'P4-S2')`);
    // A stand-in line table carrying the candidate key a bridge line FK needs.
    await c.query(`CREATE TABLE probe_lines (
      tenant_id   UUID NOT NULL,
      business_id UUID NOT NULL,
      probe_id    UUID NOT NULL,
      id          UUID NOT NULL,
      PRIMARY KEY (business_id, id),
      CONSTRAINT probe_lines_bridge_uq UNIQUE (business_id, probe_id, id),
      CONSTRAINT probe_lines_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id))`);
    if (variant === 'tenant_in_line_fk') {
      await c.query(`ALTER TABLE probe_lines ADD CONSTRAINT probe_lines_tenant_bridge_uq UNIQUE (tenant_id, business_id, probe_id, id)`);
    }

    const tenantColumn = variant === 'no_tenant' ? '' : 'tenant_id UUID NOT NULL,';
    const primaryKey =
      variant === 'tenant_in_pk'
        ? 'PRIMARY KEY (tenant_id, business_id, source_id, source_line_id, movement_kind)'
        : 'PRIMARY KEY (business_id, source_id, source_line_id, movement_kind)';
    const lineFk =
      variant === 'tenant_in_line_fk'
        ? `CONSTRAINT stock_source_bridge_probe_line_fk FOREIGN KEY (tenant_id, business_id, source_id, source_line_id)
             REFERENCES probe_lines (tenant_id, business_id, probe_id, id) ON DELETE RESTRICT`
        : `CONSTRAINT stock_source_bridge_probe_line_fk FOREIGN KEY (business_id, source_id, source_line_id)
             REFERENCES probe_lines (business_id, probe_id, id) ON DELETE RESTRICT`;
    const tenantFk =
      variant === 'no_tenant'
        ? ''
        : `, CONSTRAINT stock_source_bridge_probe_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id)`;

    await c.query(`CREATE TABLE stock_source_bridge_probe (
      ${tenantColumn}
      business_id    UUID NOT NULL,
      source_id      UUID NOT NULL,
      source_line_id UUID NOT NULL,
      movement_kind  TEXT NOT NULL,
      source_type    TEXT NOT NULL GENERATED ALWAYS AS ('probe') STORED,
      ${primaryKey},
      ${lineFk},
      CONSTRAINT stock_source_bridge_probe_binding_fk
        FOREIGN KEY (business_id, source_type, source_id, source_line_id, movement_kind)
        REFERENCES stock_source_bindings (business_id, source_type, source_id, source_line_id, movement_kind) ON DELETE RESTRICT
      ${tenantFk})`);
    await c.query(`ALTER TABLE stock_source_bridge_probe ENABLE ROW LEVEL SECURITY`);
    await c.query(`ALTER TABLE stock_source_bridge_probe FORCE ROW LEVEL SECURITY`);
    await c.query(`CREATE TRIGGER stock_bridge_immutable_probe BEFORE UPDATE OR DELETE ON stock_source_bridge_probe
                     FOR EACH ROW EXECUTE FUNCTION stock_ledger_append_only()`);

    const r = await c.query<{ missing: string }>(`SELECT missing FROM inventory_stock_source_guard_gaps() WHERE source_type = 'probe' ORDER BY missing`);
    return r.rows.map((x) => x.missing);
  } finally {
    // Always: the probe commits nothing, whatever happened.
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

/** Only the gaps that are about the bridge table itself. */
const bridgeGaps = (gaps: readonly string[]): readonly string[] => gaps.filter((g) => (BRIDGE_GAPS as readonly string[]).includes(g));

beforeAll(async () => {
  await ensurePostgres();
}, 600_000);

afterAll(async () => {
  // Nothing to clean: every case rolled back. Proved, not assumed, below.
});

describe('P4-S2 B-01 the sale bridge may carry tenant_id, and may not carry it in the pinned key or the line FK', () => {
  it('the 0063 shape (no tenant_id) reports no bridge gap — the baseline the precedent established', async () => {
    expect(bridgeGaps(await gapsFor('no_tenant'))).toEqual([]);
  });

  it('tenant_id as a real NOT NULL column with the (tenant_id, business_id) businesses FK reports no bridge gap', async () => {
    // THE RULING. P4-AL-08 and the guard are not in conflict: the guard pins
    // the PRIMARY KEY and the two foreign-key COLUMN LISTS, and says nothing
    // about the relation's column set.
    expect(bridgeGaps(await gapsFor('tenant_col'))).toEqual([]);
  });

  it('tenant_id inside the PRIMARY KEY is refused by the guard as `bridge_pk`', async () => {
    // The red proof of the ruling's second half: the PK is EXACTLY
    // (business_id, source_id, source_line_id, movement_kind), in that order.
    expect(bridgeGaps(await gapsFor('tenant_in_pk'))).toEqual(['bridge_pk']);
  });

  it('tenant_id inside the line foreign key is refused by the guard as `bridge_line_fk`', async () => {
    // The red proof of the ruling's third half: the line FK is EXACTLY
    // (business_id, source_id, source_line_id).
    expect(bridgeGaps(await gapsFor('tenant_in_line_fk'))).toEqual(['bridge_line_fk']);
  });

  it('the two shapes differ in nothing else: their whole gap sets are identical', async () => {
    const without = await gapsFor('no_tenant');
    const with_ = await gapsFor('tenant_col');
    expect(with_).toEqual(without);
    // The residual gap is the deferred binding trigger, which the probe
    // deliberately does not build (see this file's header) and which is the
    // same in both shapes.
    expect(without).toEqual(['binding_trigger']);
  });

  it('the probe committed nothing: `probe` is not registered and no probe relation exists', async () => {
    const t = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM stock_source_types WHERE source_type = 'probe'`);
    expect(t.rows[0]?.n).toBe(0);
    const c = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('stock_source_bridge_probe', 'probe_lines')`);
    expect(c.rows[0]?.n).toBe(0);
  });

  it('the live guard is clean on the sealed head, so 0077 must leave it clean', async () => {
    const r = await ownerPool().query(`SELECT source_type, missing FROM inventory_stock_source_guard_gaps()`);
    expect(r.rows).toEqual([]);
  });

  it('the rest of the Phase 3 stock estate already carries tenant_id — the precedent is an omission, not a design', async () => {
    const r = await ownerPool().query<{ relname: string; n: number }>(
      `SELECT c.relname, count(*)::int AS n
         FROM pg_class c
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE c.relname IN ('stock_movements', 'stock_levels', 'stock_source_bindings')
          AND a.attname = 'tenant_id' AND a.attnotnull
        GROUP BY c.relname ORDER BY c.relname`,
    );
    expect(r.rows).toEqual([
      { relname: 'stock_levels', n: 1 },
      { relname: 'stock_movements', n: 1 },
      { relname: 'stock_source_bindings', n: 1 },
    ]);
    // And the bridges are the only stock relations that do not.
    const bridges = await ownerPool().query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c
        WHERE c.relkind = 'r' AND c.relname LIKE 'stock_source_bridge_%'
          AND NOT EXISTS (SELECT 1 FROM pg_attribute a
                           WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped)
        ORDER BY c.relname`,
    );
    expect(bridges.rows.length).toBeGreaterThan(0);
  });
});
