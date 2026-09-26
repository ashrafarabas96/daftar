/**
 * P3-S4 — TENANT AND BUSINESS ISOLATION OF EVERY S4 ROUTINE
 * (docs/PHASE_3_S4_CONTRACT.md A-03, A-09, A-18, §2.4; the P3-S2/S3
 * same-owner precedent).
 *
 * For each of the seven routines: ALLOW, the owner in A; DENY, the same
 * command reaching into A2 — the SAME tenant and the SAME owner, where only
 * the routine's binding to the VERIFIED business, the composite keys and row
 * security keep them apart — and into B, another tenant:
 *   - scope GUCs of X with an assertion for A, and an assertion for X under
 *     A's GUCs → `inventory.assertion_scope_mismatch`;
 *   - an honest A assertion over a command naming X's supplier, purchase,
 *     warehouse or variant → the not-found code of that object;
 *   - A's command signed and run in X → not found there (a supplier id is a
 *     per-business key: creating it in X makes X's own supplier and leaves
 *     A's untouched).
 * Each DENY leaves both businesses' S4 state unchanged. Row security then
 * shows `daftar_app` only its own business's S4 rows. Every case is rolled
 * back.
 */
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { expectAccepted, must, ownerClient, refusedWith, seedS3World, type S3Business, type S3World } from '../helpers/inventory-commands';
import {
  FULL_CONTACTS,
  S4_KINDS,
  S4_TABLES,
  createSupplier,
  draftAndReceive,
  honestDraft,
  honestS4,
  runCommand,
  s4Counts,
  s4Delta,
  tryCommand,
  type S4Command,
  type S4Kind,
} from '../helpers/purchase-commands';

let world: S3World;
let c: Client;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 's4iso');
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

interface Reach {
  readonly what: string;
  readonly cmd: S4Command;
  readonly code: string;
}

/** Every departure of `cmd` that names one of X's objects instead of A's, with the code the routine answers. */
async function reaches(kind: S4Kind, cmd: S4Command, A: S3Business, X: S3Business): Promise<Reach[]> {
  const theirSupplier = await createSupplier(c, X, FULL_CONTACTS);
  const theirDraft = await honestDraft(c, X, theirSupplier);
  await runCommand(c, X, theirDraft);
  const variants = new Map([
    [A.piece.variantId, X.piece.variantId],
    [A.piece2.variantId, X.piece2.variantId],
  ]);
  const v = (id: string): string => variants.get(id) ?? id;
  switch (cmd.kind) {
    case 'supplier_create':
      return [];
    case 'supplier_update':
    case 'supplier_archive':
    case 'supplier_reactivate':
      return [{ what: `${kind} of X's supplier`, cmd: { ...cmd, supplierId: theirSupplier }, code: 'supplier.not_found' }];
    case 'purchase_draft':
      return [
        { what: "X's supplier", cmd: { ...cmd, supplierId: theirSupplier }, code: 'supplier.not_found' },
        { what: "X's warehouse", cmd: { ...cmd, warehouseId: X.w1 }, code: 'inventory.warehouse_not_found' },
        { what: "X's variants", cmd: { ...cmd, lines: cmd.lines.map((l) => ({ ...l, variantId: v(l.variantId) })) }, code: 'inventory.variant_not_found' },
        { what: "replacing X's draft", cmd: { ...cmd, purchaseId: theirDraft.purchaseId, expectedRevision: 1 }, code: 'purchase.not_found' },
      ];
    case 'purchase_cancel':
      return [{ what: "X's draft", cmd: { ...cmd, purchaseId: theirDraft.purchaseId, warehouseId: X.w1 }, code: 'purchase.not_found' }];
    case 'purchase_receive':
      return [{ what: "X's draft", cmd: { ...cmd, purchaseId: theirDraft.purchaseId }, code: 'purchase.not_found' }];
  }
}

/** What running A's honest command signed for X in X answers. */
const AS_X: Readonly<Record<S4Kind, string | null>> = {
  supplier_create: null,
  supplier_update: 'supplier.not_found',
  supplier_archive: 'supplier.not_found',
  supplier_reactivate: 'supplier.not_found',
  purchase_draft: 'supplier.not_found',
  purchase_cancel: 'purchase.not_found',
  purchase_receive: 'purchase.not_found',
};

describe('each S4 routine is bound to the VERIFIED business', () => {
  for (const kind of S4_KINDS) {
    for (const target of ['A2', 'B'] as const) {
      it(`${kind}: ${target === 'A2' ? 'same tenant, same owner' : 'another tenant'} — scope of ${target} → scope_mismatch; ${target}'s objects → not found; ALLOW in A`, async () => {
        await inTx(async () => {
          const A = world.A;
          const X = world[target];
          const cmd = await honestS4(c, A, kind);
          const list = await reaches(kind, cmd, A, X);
          const theirs = await s4Counts(c, X.businessId);
          const ours = await s4Counts(c, A.businessId);

          refusedWith(await tryCommand(c, A, cmd, { scope: X }), 'P0001', 'inventory.assertion_scope_mismatch', 'GUCs of X, assertion for A');
          refusedWith(await tryCommand(c, A, cmd, { mintBusiness: X }), 'P0001', 'inventory.assertion_scope_mismatch', 'assertion for X, GUCs of A');
          for (const r of list) {
            refusedWith(await tryCommand(c, A, r.cmd, { raw: true }), 'P0001', r.code, r.what);
          }
          const asX = AS_X[kind];
          if (asX !== null) refusedWith(await tryCommand(c, X, cmd, { raw: true }), 'P0001', asX, "A's command run in X");

          expect(s4Delta(theirs, await s4Counts(c, X.businessId)), `${target} untouched`).toEqual({});
          expect(s4Delta(ours, await s4Counts(c, A.businessId)), 'A untouched by the refusals').toEqual({});
          expectAccepted(await tryCommand(c, A, cmd), 'ALLOW: the owner in A');
        });
      });
    }
  }

  it('a supplier id is a per-business key: the same id created in A2 and B makes their own suppliers and leaves A’s alone', async () => {
    await inTx(async () => {
      const A = world.A;
      const cmd = await honestS4(c, A, 'supplier_create');
      if (cmd.kind !== 'supplier_create') throw new Error('supplier_create');
      expectAccepted(await tryCommand(c, A, cmd));
      const oursBefore = await s4Counts(c, A.businessId);
      for (const X of [world.A2, world.B]) {
        const created = expectAccepted(await tryCommand(c, X, { ...cmd, fields: { ...cmd.fields, name: `Theirs ${X.businessId.slice(0, 4)}` } }), 'X');
        expect(must(created[0]).replayed, 'not a replay of A’s supplier').toBe(false);
      }
      expect(s4Delta(oursBefore, await s4Counts(c, A.businessId))).toEqual({});
      const r = await c.query<{ business_id: string; name: string }>(`SELECT business_id::text, name FROM suppliers WHERE id = $1 ORDER BY name`, [
        cmd.supplierId,
      ]);
      expect(r.rows.map((x) => x.business_id).sort()).toEqual([A.businessId, world.A2.businessId, world.B.businessId].sort());
    });
  });
});

describe('row security on the S4 tables and the two S2 coverage tables', () => {
  it('as daftar_app scoped to A, only A’s rows are visible — never A2’s (same owner) nor B’s', async () => {
    await inTx(async () => {
      for (const b of [world.A, world.A2, world.B]) {
        const supplierId = await createSupplier(c, b, FULL_CONTACTS);
        await draftAndReceive(c, b, await honestDraft(c, b, supplierId));
        await runCommand(c, b, await honestDraft(c, b, supplierId));
      }
      const populated = ['suppliers', 'purchases', 'purchase_lines', 'purchase_landed_costs', 'purchase_landed_cost_allocations'];
      for (const b of [world.A, world.A2, world.B]) {
        await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [b.tenantId, b.businessId]);
        await c.query('SET LOCAL ROLE daftar_app');
        for (const t of [...S4_TABLES, 'negative_inventory_deficits', 'negative_deficit_coverages']) {
          const r = await c.query<{ business_id: string }>(`SELECT DISTINCT business_id::text FROM ${t}`);
          const seen = r.rows.map((x) => x.business_id);
          if (populated.includes(t)) expect(seen, `${t} as ${b.businessId}`).toEqual([b.businessId]);
          else
            expect(
              seen.filter((id) => id !== b.businessId),
              `${t} as ${b.businessId}`,
            ).toEqual([]);
        }
        const other = await c.query(`SELECT 1 FROM purchases WHERE business_id <> $1`, [b.businessId]);
        expect(other.rowCount, 'a WHERE naming another business finds nothing').toBe(0);
        await c.query('RESET ROLE');
      }
    });
  });

  it('RLS is enabled and forced on the six documents and the two bridges', async () => {
    const r = await ownerPool().query<{ t: string; on: boolean; forced: boolean }>(
      `SELECT relname::text AS t, relrowsecurity AS on, relforcerowsecurity AS forced FROM pg_class
        WHERE relname = ANY($1::text[]) ORDER BY relname`,
      [[...S4_TABLES, 'stock_source_bridge_purchase', 'stock_source_bridge_negative_inventory_cost_adjustment']],
    );
    expect(r.rows).toHaveLength(8);
    for (const row of r.rows) expect({ on: row.on, forced: row.forced }, row.t).toEqual({ on: true, forced: true });
  });

  it('with no business GUC, daftar_app sees no S4 row at all', async () => {
    await inTx(async () => {
      const A = world.A;
      const supplierId = await createSupplier(c, A, FULL_CONTACTS);
      await runCommand(c, A, await honestDraft(c, A, supplierId));
      await c.query(`SELECT set_config('app.tenant_id', '', true), set_config('app.business_id', '', true)`);
      await c.query('SET LOCAL ROLE daftar_app');
      for (const t of [...S4_TABLES, 'negative_inventory_deficits', 'negative_deficit_coverages']) {
        const n = must((await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`)).rows[0]).n;
        expect(n, t).toBe(0);
      }
      await c.query('RESET ROLE');
    });
  });
});
