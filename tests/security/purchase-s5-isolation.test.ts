/**
 * P3-S5 — TENANT AND BUSINESS ISOLATION OF THE TWO S5 ROUTINES AND TABLES
 * (docs/PHASE_3_S5_CONTRACT.md A-03, A-17, A-18, §2.5, §2.7; the P3-S4
 * same-owner precedent).
 *
 * For `purchase_return` and `purchase_reverse`: ALLOW, the owner in A; DENY,
 * the same command reaching into A2 — the SAME tenant and the SAME owner,
 * where only the routine's binding to the VERIFIED business, the composite
 * keys and row security keep them apart — and into B, another tenant:
 *   - scope GUCs of X with an assertion for A, and an assertion for X under
 *     A's GUCs → `inventory.assertion_scope_mismatch`;
 *   - an honest A assertion over a command naming X's purchase, purchase
 *     line, warehouse or entry → the refusal of that object;
 *   - A's command signed and run in X → `purchase.not_found` there.
 * Each DENY leaves both businesses' S5 state unchanged. Row security then
 * shows `daftar_app` only its own business's S5 rows (and none without a
 * business GUC); RLS is enabled and forced on the five tables and the two
 * bridges, and the restrictive isolation is one policy per command, only
 * the read policy admitting the internal principal. Every case is rolled
 * back.
 */
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { expectAccepted, must, ownerClient, refusedWith, seedS3World, type S3Business, type S3World } from '../helpers/inventory-commands';
import { s4Delta } from '../helpers/purchase-commands';
import {
  S5_BRIDGES,
  S5_KINDS,
  S5_TABLES,
  prepareReturn,
  prepareReversal,
  receivedPurchase,
  runReturn,
  runReversal,
  s5Counts,
  tryS5,
  type ReceivedPurchase,
  type S5Command,
  type S5Kind,
} from '../helpers/purchase-returns';

let world: S3World;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 's5iso');
});

afterAll(async () => {
  await resetData();
});

async function inTx(fn: (c: Client) => Promise<void>): Promise<void> {
  const c = await ownerClient();
  try {
    await c.query('BEGIN');
    await fn(c);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
}

async function received(c: Client, biz: S3Business): Promise<ReceivedPurchase> {
  return receivedPurchase(c, biz, [{ variantId: biz.piece.variantId, qty: '4', unitPriceMinor: '100' }]);
}

/** A's honest command of `kind`, prepared in the caller's transaction. */
async function honest(c: Client, A: S3Business, kind: S5Kind): Promise<S5Command> {
  const p = await received(c, A);
  if (kind === 'purchase_reverse') return (await prepareReversal(c, A, p.purchaseId)).cmd;
  return (await prepareReturn(c, A, p.purchaseId, { lines: [{ purchaseLineId: must(p.lines[0]).lineId, qty: '1' }] })).cmd;
}

interface Reach {
  readonly what: string;
  readonly cmd: S5Command;
  readonly code: string;
}

/** Every departure of `cmd` that names one of X's objects instead of A's, with the code the routine answers. */
function reaches(cmd: S5Command, X: S3Business, theirs: ReceivedPurchase): Reach[] {
  if (cmd.kind === 'purchase_return') {
    return [
      { what: "X's purchase", cmd: { ...cmd, purchaseId: theirs.purchaseId }, code: 'purchase.not_found' },
      {
        what: "X's purchase line",
        cmd: { ...cmd, lines: cmd.lines.map((l) => ({ ...l, purchaseLineId: must(theirs.lines[0]).lineId })) },
        code: 'supplier_return.lines_invalid',
      },
      { what: "X's warehouse", cmd: { ...cmd, warehouseId: X.w1 }, code: 'inventory.warehouse_not_found' },
    ];
  }
  return [
    { what: "X's purchase", cmd: { ...cmd, purchaseId: theirs.purchaseId }, code: 'purchase.not_found' },
    { what: "X's purchase entry", cmd: { ...cmd, originalEntryId: theirs.entryId }, code: 'purchase_reversal.purchase_changed' },
  ];
}

describe('each S5 routine is bound to the VERIFIED business', () => {
  for (const kind of S5_KINDS) {
    for (const target of ['A2', 'B'] as const) {
      it(`${kind}: ${target === 'A2' ? 'same tenant, same owner' : 'another tenant'} — scope of ${target} → scope_mismatch; ${target}'s objects → refused; ALLOW in A`, async () => {
        await inTx(async (c) => {
          const A = world.A;
          const X = world[target];
          const cmd = await honest(c, A, kind);
          const theirs = await received(c, X);
          const theirCounts = await s5Counts(c, X.businessId);
          const ourCounts = await s5Counts(c, A.businessId);

          refusedWith(await tryS5(c, A, cmd, { scope: X }), 'P0001', 'inventory.assertion_scope_mismatch', 'GUCs of X, assertion for A');
          refusedWith(await tryS5(c, A, cmd, { mintBusiness: X }), 'P0001', 'inventory.assertion_scope_mismatch', 'assertion for X, GUCs of A');
          for (const r of reaches(cmd, X, theirs)) {
            refusedWith(await tryS5(c, A, r.cmd, { raw: true }), 'P0001', r.code, r.what);
          }
          refusedWith(await tryS5(c, X, cmd, { raw: true }), 'P0001', 'purchase.not_found', "A's command signed and run in X");

          expect(s4Delta(theirCounts, await s5Counts(c, X.businessId)), `${target} untouched`).toEqual({});
          expect(s4Delta(ourCounts, await s5Counts(c, A.businessId)), 'A untouched by the refusals').toEqual({});
          expectAccepted(await tryS5(c, A, cmd), 'ALLOW: the owner in A');
        });
      });
    }
  }
});

describe('row security on the S5 tables and bridges', () => {
  it('as daftar_app scoped to a business, only its S5 rows are visible — never A2’s (same owner) nor B’s; with no GUC, none', async () => {
    await inTx(async (c) => {
      const all = [world.A, world.A2, world.B];
      for (const b of all) {
        const p = await received(c, b);
        await runReturn(c, b, await prepareReturn(c, b, p.purchaseId, { lines: [{ purchaseLineId: must(p.lines[0]).lineId, qty: '1' }] }));
        const q = await receivedPurchase(c, b, [{ variantId: b.piece2.variantId, qty: '2', unitPriceMinor: '70' }]);
        await runReversal(c, b, await prepareReversal(c, b, q.purchaseId));
      }
      const populated = ['supplier_returns', 'supplier_return_lines', 'purchase_reversals', 'purchase_reversal_lines'];
      for (const b of all) {
        await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [b.tenantId, b.businessId]);
        await c.query('SET LOCAL ROLE daftar_app');
        for (const t of S5_TABLES) {
          const seen = (await c.query<{ business_id: string }>(`SELECT DISTINCT business_id::text FROM ${t}`)).rows.map((x) => x.business_id);
          if (populated.includes(t)) expect(seen, `${t} as ${b.businessId}`).toEqual([b.businessId]);
          else
            expect(
              seen.filter((id) => id !== b.businessId),
              `${t} as ${b.businessId}`,
            ).toEqual([]);
        }
        expect((await c.query(`SELECT 1 FROM supplier_returns WHERE business_id <> $1`, [b.businessId])).rowCount, 'a WHERE naming another business').toBe(0);
        await c.query('RESET ROLE');
      }
      await c.query(`SELECT set_config('app.tenant_id', '', true), set_config('app.business_id', '', true)`);
      await c.query('SET LOCAL ROLE daftar_app');
      for (const t of S5_TABLES) {
        expect(must((await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`)).rows[0]).n, `${t} with no business GUC`).toBe(0);
      }
      await c.query('RESET ROLE');
    });
  });

  it('RLS is enabled and forced on the five tables and the two bridges', async () => {
    const r = await ownerPool().query<{ t: string; on: boolean; forced: boolean }>(
      `SELECT relname::text AS t, relrowsecurity AS on, relforcerowsecurity AS forced FROM pg_class WHERE relname = ANY($1::text[]) ORDER BY relname`,
      [[...S5_TABLES, ...S5_BRIDGES]],
    );
    expect(r.rows).toHaveLength(7);
    for (const row of r.rows) expect({ on: row.on, forced: row.forced }, row.t).toEqual({ on: true, forced: true });
  });

  it('the restrictive business isolation is one policy per command: only the read policy admits the internal principal', async () => {
    const tables = [...S5_TABLES, ...S5_BRIDGES];
    const r = await ownerPool().query<{ t: string; name: string; cmd: string; restrictive: boolean; text: string }>(
      `SELECT tablename::text AS t, policyname::text AS name, cmd::text AS cmd, permissive = 'RESTRICTIVE' AS restrictive,
              coalesce(qual, '') || ' ' || coalesce(with_check, '') AS text
         FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1::text[]) AND policyname LIKE 'business_isolation%'
        ORDER BY 1, 2`,
      [tables],
    );
    for (const t of tables) {
      const mine = r.rows.filter((x) => x.t === t);
      expect(
        mine.map((x) => [x.name, x.cmd, x.restrictive]),
        t,
      ).toEqual([
        ['business_isolation_delete', 'DELETE', true],
        ['business_isolation_insert', 'INSERT', true],
        ['business_isolation_read', 'SELECT', true],
        ['business_isolation_update', 'UPDATE', true],
      ]);
      for (const p of mine) expect(p.text.includes('daftar_inventory_internal'), `${t}.${p.name} admits the internal principal`).toBe(p.cmd === 'SELECT');
    }
  });
});
