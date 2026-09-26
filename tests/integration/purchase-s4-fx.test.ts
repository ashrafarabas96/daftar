/**
 * P3-S4 T-10 — THE FX SNAPSHOT OF A FOREIGN PURCHASE
 * (docs/PHASE_3_S4_CONTRACT.md A-17, R-17, §6 T-10; P:217).
 *
 * Rates are entered through the real control boundary (`enterRate`,
 * committed as `daftar_app`); every receipt is rolled back unless stated.
 *   - the R-17 instant is the last second of the document date in the
 *     business's timezone: a rate effective AT it is taken, one effective a
 *     second later is not, and the header snapshots the registry row (id,
 *     rate, source, effective instant) exactly;
 *   - the USD (2 dp) and JOD (3 dp) vectors of `landed-cost-vectors.json`
 *     give their base totals and shares on the 2 dp ILS base, and the
 *     entry's lines carry the snapshot;
 *   - after a newer rate in force at the instant is entered, a received
 *     purchase and its entry keep the old snapshot, and a receipt prepared
 *     before it is `purchase.fx_rate_changed`;
 *   - with no rate in force the routine refuses `accounting.fx_rate_missing`.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { enterRate, rateIdFor } from '../helpers/accounting-fx';
import { expectAccepted, must, ownerClient, refusedWith, seedS3World, type S3World } from '../helpers/inventory-commands';
import {
  FULL_CONTACTS,
  createSupplier,
  entryOf,
  landedCostVectors,
  prepareReceipt,
  runCommand,
  runReceipt,
  supplierIn,
  tryCommand,
  vectorDraft,
  type PreparedReceipt,
  type PurchaseVector,
} from '../helpers/purchase-commands';

let world: S3World;
let c: Client;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 's4fx');
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

const vector = (id: string): PurchaseVector =>
  must(
    landedCostVectors().purchases.find((p) => p.id === id),
    id,
  );

/** The R-17 instant of a document date in the business's timezone. */
async function instantOf(documentDate: string): Promise<Date> {
  return must(
    (
      await ownerPool().query<{ at: Date }>(
        `SELECT (((($2::date + 1)::timestamp AT TIME ZONE b.timezone) - interval '1 second')) AS at FROM businesses b WHERE b.id = $1`,
        [world.A.businessId, documentDate],
      )
    ).rows[0],
  ).at;
}

async function rate(from: string, value: string, at: Date): Promise<string> {
  const A = world.A;
  const r = await enterRate(
    {
      tenantId: A.tenantId,
      businessId: A.businessId,
      rateId: rateIdFor(A.businessId, randomUUID()),
      fromCurrency: from,
      toCurrency: 'ILS',
      rate: value,
      effectiveAt: at.toISOString(),
    },
    A.userId,
  );
  expect(r.created).toBe(true);
  return r.rateId;
}

async function snapshotOf(
  q: { query: Client['query'] },
  purchaseId: string,
): Promise<{ fx_rate_id: string | null; rate: string; source: string; at: Date; base: string }> {
  return must(
    (
      await q.query<{ fx_rate_id: string | null; rate: string; source: string; at: Date; base: string }>(
        `SELECT fx_rate_id::text, source_to_base_rate::text AS rate, rate_source AS source, rate_timestamp AS at, total_base_minor::text AS base
           FROM purchases WHERE business_id = $1 AND id = $2`,
        [world.A.businessId, purchaseId],
      )
    ).rows[0],
  );
}

/** Receive the vector's purchase on `documentDate` and check it against the vector and the snapshot. */
async function receiveVector(v: PurchaseVector, documentDate: string, rateId: string, at: Date): Promise<PreparedReceipt> {
  const A = world.A;
  const draft = await vectorDraft(c, A, await createSupplier(c, A, FULL_CONTACTS), v.lines, v.landedCosts, { currency: v.txnCurrency, documentDate });
  await runCommand(c, A, draft);
  const p = await prepareReceipt(c, A, draft.purchaseId);
  expect(p.cmd.rate).toEqual({ rateId, rate: v.rate, source: 'manual', at });
  const run = await runReceipt(c, A, p);
  expect(await snapshotOf(c, draft.purchaseId)).toEqual({ fx_rate_id: rateId, rate: v.rate, source: 'manual', at, base: v.expect.totalBaseMinor });
  const shares = await c.query<{ s: string; u: string }>(
    `SELECT base_share_minor::text AS s, unit_cost_base_minor::text AS u FROM purchase_lines WHERE business_id = $1 AND purchase_id = $2 ORDER BY line_no`,
    [A.businessId, draft.purchaseId],
  );
  expect(shares.rows).toEqual(v.expect.lines.map((l) => ({ s: l.baseShareMinor, u: l.unitCostBaseMinor })));
  const e = must(await entryOf(c, A.businessId, 'purchase', draft.purchaseId));
  expect(e.id).toBe(must(run.purchaseEntry).entryId);
  expect(
    e.lines.map((l) => ({
      key: l.system_key,
      debit: l.debit,
      credit: l.credit,
      ccy: l.txn_currency,
      rate: l.fx_rate,
      source: l.fx_rate_source,
      at: l.fx_rate_at,
    })),
  ).toEqual([
    { key: 'inventory', debit: v.expect.totalBaseMinor, credit: '0', ccy: v.txnCurrency, rate: v.rate, source: 'manual', at },
    { key: 'accounts_payable', debit: '0', credit: v.expect.totalBaseMinor, ccy: v.txnCurrency, rate: v.rate, source: 'manual', at },
  ]);
  expect(e.lines.map((l) => l.txn_amount)).toEqual([v.expect.totalTxnMinor, v.expect.totalTxnMinor]);
  return p;
}

describe('T-10 the snapshot is the registry row in force at the R-17 instant', () => {
  it('PA-USD-ILS-01 (2 dp → 2 dp): a rate AT the instant is taken, one a second later is not; totals, shares and entry per the vector', async () => {
    const v = vector('PA-USD-ILS-01');
    const day = '2026-01-10';
    const instant = await instantOf(day);
    await rate('USD', '3.5000000000', new Date(`${day}T00:00:00Z`));
    await rate('USD', '9.9900000000', new Date(instant.getTime() + 1000));
    const atInstant = await rate('USD', v.rate, instant);
    await inTx(async () => {
      await receiveVector(v, day, atInstant, instant);
    });
  });

  it('PA-JOD-ILS-01 (3 dp → 2 dp): the base total and shares are the vector’s', async () => {
    const v = vector('PA-JOD-ILS-01');
    const day = '2026-01-12';
    const at = new Date(`${day}T08:30:00Z`);
    const id = await rate('JOD', v.rate, at);
    await inTx(async () => {
      await receiveVector(v, day, id, at);
    });
  });
});

describe('T-10 a received purchase keeps its snapshot', () => {
  it('a newer rate in force at the instant changes neither the received purchase nor its entry; a receipt prepared before it → fx_rate_changed', async () => {
    const A = world.A;
    const v = vector('PA-USD-ILS-01');
    const day = '2026-02-10';
    const oldAt = new Date(`${day}T06:00:00Z`);
    const oldId = await rate('USD', v.rate, oldAt);
    const supplierId = await supplierIn(ownerPool(), A, FULL_CONTACTS);
    const c1 = await ownerClient();
    let received: string;
    let stale: PreparedReceipt;
    try {
      await c1.query('BEGIN');
      const d1 = await vectorDraft(c1, A, supplierId, v.lines, v.landedCosts, { currency: 'USD', documentDate: day });
      await runCommand(c1, A, d1);
      await runReceipt(c1, A, await prepareReceipt(c1, A, d1.purchaseId));
      const d2 = await vectorDraft(c1, A, supplierId, v.lines, v.landedCosts, { currency: 'USD', documentDate: day });
      await runCommand(c1, A, d2);
      stale = await prepareReceipt(c1, A, d2.purchaseId);
      await c1.query('COMMIT');
      received = d1.purchaseId;
    } finally {
      await c1.end();
    }
    const before = await snapshotOf(ownerPool(), received);
    const entryBefore = await entryOf(ownerPool(), A.businessId, 'purchase', received);
    expect(before).toMatchObject({ fx_rate_id: oldId, rate: v.rate });

    const newAt = new Date(`${day}T12:00:00Z`);
    const newId = await rate('USD', '3.8000000000', newAt);

    expect(await snapshotOf(ownerPool(), received), 'the received header keeps the old snapshot').toEqual(before);
    expect(await entryOf(ownerPool(), A.businessId, 'purchase', received), 'and so does its entry').toEqual(entryBefore);
    await inTx(async () => {
      refusedWith(await tryCommand(c, A, stale.cmd), 'P0001', 'purchase.fx_rate_changed');
      const fresh = await prepareReceipt(c, A, stale.cmd.purchaseId);
      expect(fresh.cmd.rate).toEqual({ rateId: newId, rate: '3.8000000000', source: 'manual', at: newAt });
      expect(fresh.cmd.totalBaseMinor, 'the new rate gives another base total').not.toBe(stale.cmd.totalBaseMinor);
      expectAccepted(await tryCommand(c, A, fresh.cmd));
    });
  });
});

describe('T-10 no rate in force', () => {
  it('a foreign purchase dated before any rate of its currency → accounting.fx_rate_missing from the routine', async () => {
    const A = world.A;
    const v = vector('PA-USD-ILS-01');
    const day = '2026-03-10';
    const at = new Date(`${day}T06:00:00Z`);
    await inTx(async () => {
      const draft = await vectorDraft(c, A, await createSupplier(c, A, FULL_CONTACTS), v.lines, v.landedCosts, { currency: 'EUR', documentDate: day });
      await runCommand(c, A, draft);
      // The command a service holding a (fabricated) EUR snapshot would send: the routine reads the registry itself.
      const usd = await vectorDraft(c, A, await createSupplier(c, A, FULL_CONTACTS), v.lines, v.landedCosts, { currency: 'USD', documentDate: '2026-01-10' });
      await runCommand(c, A, usd);
      const shape = await prepareReceipt(c, A, usd.purchaseId);
      const cmd = {
        ...shape.cmd,
        purchaseId: draft.purchaseId,
        supplierId: draft.supplierId,
        documentDate: day,
        currency: 'EUR',
        rate: { rateId: randomUUID(), rate: '4.0000000000', source: 'manual' as const, at },
        lines: shape.cmd.lines.map((l, i) => ({ ...l, lineId: must(draft.lines[i]).lineId, variantId: must(draft.lines[i]).variantId })),
      };
      refusedWith(await tryCommand(c, A, cmd, { raw: true }), 'P0001', 'accounting.fx_rate_missing');
    });
  });
});
