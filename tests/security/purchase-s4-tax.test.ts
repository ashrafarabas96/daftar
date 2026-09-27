/**
 * P3-S4 T-14 — NO PURCHASE TAX UNTIL ITS POLICY EXISTS
 * (docs/PHASE_3_S4_CONTRACT.md A-12, OD-03, §6 T-14; P:216).
 *
 * Three independent layers refuse a non-zero tax:
 *   - HTTP: a draft (a create or a replace) with a non-zero `taxAmount` is 422
 *     `purchase.tax_policy_absent` BEFORE the service runs — no assertion is
 *     minted, no `inventory_assertion_uses` row and nothing else is written;
 *     a zero `taxAmount`, however spelled, is accepted;
 *   - the routine: an honestly SIGNED `purchase_save_draft` whose `p_tax_minor`
 *     is non-zero is refused by the routine itself;
 *   - the table: the owner's direct `UPDATE purchases SET tax_minor = 1` of a
 *     draft (advancing its revision, as the header guard requires of any
 *     draft edit) hits `purchases_tax_policy_absent_ck` (23514).
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { InventoryAssertionMinterService } from '../../apps/api/src/modules/inventory/inventory-assertion.minter';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import {
  asMember,
  attempt,
  expectAccepted,
  expectConstraint,
  onboardS3Business,
  ownerClient,
  refusedWith,
  registerActor,
  today,
  type HttpActor,
  type S3Business,
} from '../helpers/inventory-commands';
import { FULL_CONTACTS, createSupplier, honestDraft, runCommand, s4Counts, s4Delta, tryCommand } from '../helpers/purchase-commands';

let t: TestApp;
let day: string;
let owner: HttpActor;
let A: S3Business;
let mint: MockInstance<InventoryAssertionMinterService['mint']>;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
  t = await createTestApp();
  owner = await registerActor(t, 'S4 tax owner');
  A = await onboardS3Business(t, owner, 's4tax');
  mint = vi.spyOn(t.app.get(InventoryAssertionMinterService), 'mint');
});

beforeEach(() => {
  mint.mockClear();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await t.close();
  await resetData();
});

const as = (): Record<string, string> => asMember(owner, A.businessId);

async function supplier(): Promise<string> {
  const id = randomUUID();
  const r = await t.request
    .post('/v1/suppliers')
    .set(as())
    .send({ supplierId: id, name: `Supplier ${id.slice(0, 6)}` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return id;
}

function body(supplierId: string, taxAmount: string, expectedRevision = 0): Record<string, unknown> {
  return {
    expectedRevision,
    supplierId,
    warehouseId: A.w1,
    currency: 'ILS',
    documentDate: day,
    lines: [{ lineId: randomUUID(), productId: A.piece.productId, quantity: '2', unitPrice: '12.50' }],
    landedCosts: [],
    taxAmount,
  };
}

describe('T-14 HTTP: a non-zero taxAmount is refused before anything is minted', () => {
  it('a new draft with a non-zero tax → 422 purchase.tax_policy_absent, no mint, no assertion use, nothing written; a zero tax is accepted', async () => {
    const supplierId = await supplier();
    for (const taxAmount of ['0.01', '1', '250.00']) {
      const before = await s4Counts(ownerPool(), A.businessId);
      mint.mockClear();
      const res = await t.request.put(`/v1/purchases/${randomUUID()}`).set(as()).send(body(supplierId, taxAmount));
      expect(res.status, `${taxAmount}: ${JSON.stringify(res.body)}`).toBe(422);
      expect(res.body.error.details?.purchasingCode, taxAmount).toBe('purchase.tax_policy_absent');
      expect(mint, `${taxAmount}: no assertion minted`).not.toHaveBeenCalled();
      expect(s4Delta(before, await s4Counts(ownerPool(), A.businessId)), `${taxAmount}: no inventory_assertion_uses row, nothing written`).toEqual({});
    }
    for (const taxAmount of ['0', '0.00']) {
      const res = await t.request.put(`/v1/purchases/${randomUUID()}`).set(as()).send(body(supplierId, taxAmount));
      expect(res.status, `ALLOW ${taxAmount}: ${JSON.stringify(res.body)}`).toBe(201);
    }
    const omitted = body(supplierId, '0');
    delete omitted.taxAmount;
    expect((await t.request.put(`/v1/purchases/${randomUUID()}`).set(as()).send(omitted)).status, 'ALLOW: taxAmount omitted').toBe(201);
  });

  it('a replace carrying a non-zero tax → 422, the stored draft unchanged', async () => {
    const supplierId = await supplier();
    const id = randomUUID();
    expect((await t.request.put(`/v1/purchases/${id}`).set(as()).send(body(supplierId, '0'))).status).toBe(201);
    const before = await s4Counts(ownerPool(), A.businessId);
    mint.mockClear();
    const res = await t.request
      .put(`/v1/purchases/${id}`)
      .set(as())
      .send(body(supplierId, '0.01', 1));
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error.details?.purchasingCode).toBe('purchase.tax_policy_absent');
    expect(mint).not.toHaveBeenCalled();
    expect(s4Delta(before, await s4Counts(ownerPool(), A.businessId))).toEqual({});
    const stored = await t.request.get(`/v1/purchases/${id}`).set(as());
    expect(stored.status).toBe(200);
    expect(stored.body.revision, 'still the first revision').toBe(1);
  });
});

describe('T-14 the database refuses a non-zero tax on its own', () => {
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

  it('a signed purchase_save_draft with p_tax_minor ≠ 0 → purchase.tax_policy_absent; the same command at zero tax is accepted', async () => {
    await inTx(async (c) => {
      const draft = await honestDraft(c, A, await createSupplier(c, A, FULL_CONTACTS));
      const before = await s4Counts(c, A.businessId);
      for (const taxMinor of [1n, 100n]) {
        // Signed over its own arguments, field by field: the assertion is honest, only the routine can refuse.
        refusedWith(await tryCommand(c, A, { ...draft, taxMinor }, { raw: true }), 'P0001', 'purchase.tax_policy_absent', `tax ${taxMinor}`);
      }
      expect(s4Delta(before, await s4Counts(c, A.businessId)), 'nothing written').toEqual({});
      expectAccepted(await tryCommand(c, A, draft), 'ALLOW: zero tax');
    });
  });

  it('the owner’s direct UPDATE of tax_minor to 1 → 23514 on purchases_tax_policy_absent_ck; to 0 it is accepted', async () => {
    await inTx(async (c) => {
      const draft = await honestDraft(c, A, await createSupplier(c, A, FULL_CONTACTS));
      await runCommand(c, A, draft);
      // A draft header moves one revision at a time (the immediate header guard answers first otherwise), so the
      // owner's edit advances the revision: only the CHECK then stands between tax_minor and the table.
      refusedWith(
        await attempt(c, () => c.query(`UPDATE purchases SET tax_minor = 1 WHERE business_id = $1 AND id = $2`, [A.businessId, draft.purchaseId])),
        'P0001',
        'inventory.source_document_immutable',
        'the revision unchanged',
      );
      const upd = (tax: number): Promise<unknown> =>
        c.query(`UPDATE purchases SET tax_minor = $3, revision = revision + 1 WHERE business_id = $1 AND id = $2`, [A.businessId, draft.purchaseId, tax]);
      expectConstraint(await attempt(c, () => upd(1)), '23514', 'purchases_tax_policy_absent_ck', 'tax_minor = 1');
      expectConstraint(await attempt(c, () => upd(-1)), '23514', 'purchases_tax_policy_absent_ck', 'tax_minor = -1');
      expectAccepted(await attempt(c, () => upd(0)), 'ALLOW: tax_minor = 0');
    });
  });
});
