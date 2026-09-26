/**
 * P3-S3 T-02 — TENANT AND BUSINESS ISOLATION OF EVERY ROUTINE
 * (docs/PHASE_3_S3_CONTRACT.md §2.6, §6 T-02; P:195, PM-18).
 *
 * For each of the seven routines: ALLOW, the owner in A; DENY, the same
 * command reaching into A2 — the SAME tenant and the SAME owner, where only
 * `business_isolation`, the composite FKs and the routine's binding to the
 * VERIFIED business keep them apart (the P3-S2 same-owner precedent) — and
 * into B, another tenant. Each DENY leaves the other business's counts
 * unchanged. Every case is rolled back.
 */
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  S3_KINDS,
  S3_TABLES,
  counts,
  delta,
  expectAccepted,
  ownerClient,
  refusedWith,
  runCommand,
  seedS3World,
  tryCommand,
  type S3Business,
  type S3Command,
  type S3Kind,
  type S3World,
} from '../helpers/inventory-commands';
import { honestCommand } from '../helpers/inventory-posting';

let world: S3World;
let c: Client;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 'iso');
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

/** The command with every id of `from` of the given class replaced by the matching id of `to`. */
function reach(cmd: S3Command, from: S3Business, to: S3Business, what: 'warehouses' | 'variants'): S3Command {
  const map = new Map<string, string>(
    what === 'warehouses'
      ? [
          [from.w1, to.w1],
          [from.w2, to.w2],
        ]
      : [
          [from.piece.variantId, to.piece.variantId],
          [from.piece2.variantId, to.piece2.variantId],
          [from.dec2.variantId, to.dec2.variantId],
        ],
  );
  const m = (id: string): string => map.get(id) ?? id;
  switch (cmd.kind) {
    case 'transfer':
      return { ...cmd, source: m(cmd.source), destination: m(cmd.destination), lines: cmd.lines.map((l) => ({ ...l, variantId: m(l.variantId) })) };
    case 'adjust':
      return { ...cmd, warehouseId: m(cmd.warehouseId), lines: cmd.lines.map((l) => ({ ...l, variantId: m(l.variantId) })) };
    case 'damage':
      return { ...cmd, warehouseId: m(cmd.warehouseId), lines: cmd.lines.map((l) => ({ ...l, variantId: m(l.variantId) })) };
    case 'stocktake_open':
      return { ...cmd, warehouseId: m(cmd.warehouseId) };
    case 'stocktake_count':
      return { ...cmd, warehouseId: m(cmd.warehouseId), lines: cmd.lines.map((l) => ({ ...l, variantId: m(l.variantId) })) };
    case 'stocktake_finalize':
      return { ...cmd, warehouseId: m(cmd.warehouseId), lines: cmd.lines.map((l) => ({ ...l, variantId: m(l.variantId) })) };
    case 'opening':
      return { ...cmd, lines: cmd.lines.map((l) => ({ ...l, warehouseId: m(l.warehouseId), variantId: m(l.variantId) })) };
  }
}

/** What each routine answers when the command names another business's warehouse or variant. */
const FOREIGN: Readonly<Record<S3Kind, { warehouses: string; variants: string }>> = {
  transfer: { warehouses: 'inventory.warehouse_not_found', variants: 'inventory.variant_not_found' },
  adjust: { warehouses: 'inventory.warehouse_not_found', variants: 'inventory.variant_not_found' },
  damage: { warehouses: 'inventory.warehouse_not_found', variants: 'inventory.variant_not_found' },
  stocktake_open: { warehouses: 'inventory.warehouse_not_found', variants: 'inventory.warehouse_not_found' },
  stocktake_count: { warehouses: 'inventory.stocktake_not_found', variants: 'inventory.variant_not_found' },
  stocktake_finalize: { warehouses: 'inventory.stocktake_not_found', variants: 'inventory.stocktake_changed' },
  opening: { warehouses: 'inventory.warehouse_not_found', variants: 'inventory.variant_not_found' },
};

describe('T-02 each routine is bound to the VERIFIED business', () => {
  for (const kind of S3_KINDS) {
    for (const target of ['A2', 'B'] as const) {
      it(`${kind}: ${target === 'A2' ? 'same tenant, same owner' : 'another tenant'} — scope GUCs of ${target} → assertion_scope_mismatch; ${target}'s ids → not found; ALLOW in A`, async () => {
        await inTx(async () => {
          const A = world.A;
          const X = world[target];
          const cmd = await honestCommand(c, A, kind);
          const theirs = await counts(c, X.businessId);
          const ours = await counts(c, A.businessId);

          // The assertion names A; the transaction claims X.
          refusedWith(await tryCommand(c, A, cmd, { scope: X }), 'P0001', 'inventory.assertion_scope_mismatch', 'scope of X');
          // The assertion names X (the same owner holds authority there for A2); the transaction claims A.
          refusedWith(await tryCommand(c, A, cmd, { mintBusiness: X }), 'P0001', 'inventory.assertion_scope_mismatch', 'assertion for X');

          // An honest A assertion over a command naming X's warehouses, then X's variants.
          refusedWith(await tryCommand(c, A, reach(cmd, A, X, 'warehouses'), { raw: true }), 'P0001', FOREIGN[kind].warehouses, 'X warehouses');
          if (kind !== 'stocktake_open') {
            refusedWith(await tryCommand(c, A, reach(cmd, A, X, 'variants'), { raw: true }), 'P0001', FOREIGN[kind].variants, 'X variants');
          }
          // The same command signed for X by X's owner and run in X's scope names A's ids there: refused in X too.
          const inX = kind === 'stocktake_count' || kind === 'stocktake_finalize' ? 'inventory.stocktake_not_found' : 'inventory.warehouse_not_found';
          refusedWith(await tryCommand(c, X, cmd), 'P0001', inX, 'A ids run as X');

          expect(delta(theirs, await counts(c, X.businessId)), `${target} untouched`).toEqual({});
          expect(delta(ours, await counts(c, A.businessId)), 'A untouched by the refusals').toEqual({});
          expectAccepted(await tryCommand(c, A, cmd), 'ALLOW: the owner in A');
        });
      });
    }
  }
});

describe('T-02 row security on the eight document tables', () => {
  it('as daftar_app scoped to A, only A’s documents are visible — never A2’s (same owner) nor B’s', async () => {
    await inTx(async () => {
      for (const b of [world.A, world.A2, world.B]) {
        for (const kind of ['transfer', 'adjust', 'stocktake_finalize', 'opening'] as const) {
          await runCommand(c, b, await honestCommand(c, b, kind));
        }
      }
      for (const b of [world.A, world.A2, world.B]) {
        await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [b.tenantId, b.businessId]);
        await c.query('SET LOCAL ROLE daftar_app');
        for (const t of S3_TABLES) {
          const r = await c.query<{ business_id: string; n: number }>(`SELECT business_id::text, count(*)::int AS n FROM ${t} GROUP BY business_id`);
          expect(
            r.rows.map((x) => x.business_id),
            `${t} as ${b.businessId}`,
          ).toEqual([b.businessId]);
        }
        await c.query('RESET ROLE');
      }
    });
  });
});
