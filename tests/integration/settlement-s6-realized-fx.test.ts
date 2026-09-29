/**
 * P3-S6 T-06 — MP-4: REALIZED FX POSTS ONLY TO 4900 / 6900
 * (docs/PHASE_3_S6_CONTRACT.md A-05 (a), A-09, TL-8, §6 T-06; GOLD-38/39).
 *
 * Through the real API on an ILS business with stated USD and EUR rates:
 *   - a USD purchase received @ 3.60 and paid in USD @ 3.70: the payment base
 *     exceeds the carrying released — `Dr fx_loss` (6900) 1.00;
 *   - the same purchase shape paid @ 3.50: `Cr fx_gain` (4900) 1.00;
 *   - cross-currency: a USD purchase paid in ILS (loss) and in EUR @ 4.00
 *     (gain) — the two amounts are never compared, only their bases;
 *   - `SAME-RATE-SUBUNIT-FX`: a 1.00 USD purchase @ 3.65 paid 0.33 twice at
 *     the same rate — the second release (121) exceeds its conversion (120)
 *     by 1: AP dust `Dr 1` and a realized gain of 1 on 4900, never 6100;
 *   - across EVERY S6 entry of the business, no line is on `rounding` (6100)
 *     or `purchase_price_variance` (6200), and the realized FX stored on each
 *     allocation is `payment base − carrying released`, the line's own sign.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { must, onboardS3Business, registerActor, today, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import {
  httpMethod,
  httpPay,
  httpReceived,
  payBody,
  s6SystemKeys,
  seedSettlementAccounts,
  settlementEntry,
  stateRate,
  type HttpPurchase,
  type SettlementAccounts,
} from '../helpers/supplier-settlement';

let t: TestApp;
let owner: HttpActor;
let A: S3Business;
let acc: SettlementAccounts;
let method: string;
let day: string;

/** `YYYY-MM-DD`, `n` days before today. */
function ago(n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
  t = await createTestApp();
  owner = await registerActor(t, 'S6 realized FX owner');
  A = await onboardS3Business(t, owner, 's6fx');
  acc = await seedSettlementAccounts(ownerPool(), A);
  method = await httpMethod(t, owner, A, acc.settlement.bank, { systemType: 'bank_transfer' });
  await stateRate(A, 'USD', 'ILS', '3.6000000000', `${ago(10)}T00:00:00Z`);
  await stateRate(A, 'EUR', 'ILS', '4.0000000000', `${ago(10)}T00:00:00Z`);
  await stateRate(A, 'USD', 'ILS', '3.7000000000', `${ago(8)}T00:00:00Z`);
  await stateRate(A, 'USD', 'ILS', '3.5000000000', `${ago(6)}T00:00:00Z`);
  await stateRate(A, 'USD', 'ILS', '3.6500000000', `${ago(4)}T00:00:00Z`);
});

afterAll(async () => {
  await t.close();
  await resetData();
});

interface Line {
  readonly key: string | null;
  readonly side: 'D' | 'C';
  readonly currency: string;
  readonly txn: string;
  readonly base: string;
  readonly rate: string;
}

/** A USD purchase of 10.00 (4 × 2.50) dated `documentDate`, received through the API. */
function usdPurchase(documentDate: string, unitPrice = '2.50', quantity = '4'): Promise<HttpPurchase> {
  return httpReceived(t, owner, A, { currency: 'USD', documentDate, lines: [{ productId: A.piece.productId, quantity, unitPrice }] });
}

/** Pay one allocation through the API; the stored allocation and its entry's lines. */
async function payOne(
  p: HttpPurchase,
  paymentDate: string,
  currencyCode: string,
  paymentAmountMinor: string,
  appliedMinor: string,
): Promise<{ allocation: Record<string, unknown>; lines: Line[] }> {
  const r = await httpPay(
    t,
    owner,
    A,
    payBody(p.supplierId, method, paymentDate, [{ purchaseId: p.purchaseId, paymentAmountMinor, purchaseAmountAppliedMinor: appliedMinor }], { currencyCode }),
  );
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const allocation = must((r.body as { allocations: Record<string, unknown>[] }).allocations[0]);
  const entry = must(await settlementEntry(ownerPool(), A.businessId, 'supplier_payment', String(allocation.allocationId)), 'the allocation entry');
  expect(entry.entryDate, 'entry_date = payment_date').toBe(paymentDate);
  for (const l of entry.lines) {
    expect(l.warehouseId, 'no settlement line carries a warehouse').toBeNull();
    expect(l.branchId, 'every line is on the purchase’s branch').toBe(A.branchX);
  }
  return {
    allocation,
    lines: entry.lines.map((l) => ({ key: l.systemKey, side: l.side, currency: l.currency, txn: l.txnAmountMinor, base: l.baseAmountMinor, rate: l.rate })),
  };
}

describe('T-06 MP-4: a USD purchase @ 3.60', () => {
  it('paid in USD @ 3.70: Dr AP 36.00, Cr bank 37.00, Dr fx_loss (6900) 1.00', async () => {
    const p = await usdPurchase(ago(9));
    const { allocation, lines } = await payOne(p, ago(7), 'USD', '1000', '1000');
    expect(allocation).toMatchObject({ paymentBaseMinor: '3700', carryingBaseReleasedMinor: '3600', apDustBaseMinor: '0', realizedFxMinor: '100' });
    expect(lines).toEqual([
      { key: 'accounts_payable', side: 'D', currency: 'USD', txn: '1000', base: '3600', rate: '3.6000000000' },
      { key: 'bank', side: 'C', currency: 'USD', txn: '1000', base: '3700', rate: '3.7000000000' },
      { key: 'fx_loss', side: 'D', currency: 'ILS', txn: '100', base: '100', rate: '1.0000000000' },
    ]);
  });

  it('paid in USD @ 3.50: Dr AP 36.00, Cr bank 35.00, Cr fx_gain (4900) 1.00', async () => {
    const p = await usdPurchase(ago(9));
    const { allocation, lines } = await payOne(p, ago(5), 'USD', '1000', '1000');
    expect(allocation).toMatchObject({ paymentBaseMinor: '3500', carryingBaseReleasedMinor: '3600', realizedFxMinor: '-100' });
    expect(lines).toEqual([
      { key: 'accounts_payable', side: 'D', currency: 'USD', txn: '1000', base: '3600', rate: '3.6000000000' },
      { key: 'bank', side: 'C', currency: 'USD', txn: '1000', base: '3500', rate: '3.5000000000' },
      { key: 'fx_gain', side: 'C', currency: 'ILS', txn: '100', base: '100', rate: '1.0000000000' },
    ]);
  });

  it('cross-currency: paid 37.00 ILS (a loss of 1.00) and 8.50 EUR @ 4.00 (a gain of 2.00); the two amounts are never compared', async () => {
    const inIls = await payOne(await usdPurchase(ago(9)), ago(7), 'ILS', '3700', '1000');
    expect(inIls.allocation).toMatchObject({ paymentCurrency: 'ILS', purchaseCurrency: 'USD', paymentBaseMinor: '3700', realizedFxMinor: '100' });
    expect(inIls.lines).toEqual([
      { key: 'accounts_payable', side: 'D', currency: 'USD', txn: '1000', base: '3600', rate: '3.6000000000' },
      { key: 'bank', side: 'C', currency: 'ILS', txn: '3700', base: '3700', rate: '1.0000000000' },
      { key: 'fx_loss', side: 'D', currency: 'ILS', txn: '100', base: '100', rate: '1.0000000000' },
    ]);
    const inEur = await payOne(await usdPurchase(ago(9)), ago(5), 'EUR', '850', '1000');
    expect(inEur.allocation).toMatchObject({ paymentCurrency: 'EUR', paymentBaseMinor: '3400', realizedFxMinor: '-200' });
    expect(inEur.lines).toEqual([
      { key: 'accounts_payable', side: 'D', currency: 'USD', txn: '1000', base: '3600', rate: '3.6000000000' },
      { key: 'bank', side: 'C', currency: 'EUR', txn: '850', base: '3400', rate: '4.0000000000' },
      { key: 'fx_gain', side: 'C', currency: 'ILS', txn: '200', base: '200', rate: '1.0000000000' },
    ]);
  });
});

describe('T-06 SAME-RATE-SUBUNIT-FX (TL-8)', () => {
  it('1.00 USD @ 3.65 paid 0.33 twice at the same rate: the second carries AP dust Dr 1 and a gain of 1 on 4900, never 6100', async () => {
    const p = await usdPurchase(ago(3), '1.00', '1');
    const first = await payOne(p, ago(3), 'USD', '33', '33');
    expect(first.allocation).toMatchObject({ carryingBaseReleasedMinor: '120', paymentBaseMinor: '120', apDustBaseMinor: '0', realizedFxMinor: '0' });
    expect(first.lines).toEqual([
      { key: 'accounts_payable', side: 'D', currency: 'USD', txn: '33', base: '120', rate: '3.6500000000' },
      { key: 'bank', side: 'C', currency: 'USD', txn: '33', base: '120', rate: '3.6500000000' },
    ]);
    const second = await payOne(p, ago(3), 'USD', '33', '33');
    expect(second.allocation).toMatchObject({
      apReleasedBeforeTxnMinor: '33',
      carryingBaseReleasedMinor: '121',
      paymentBaseMinor: '120',
      apDustBaseMinor: '1',
      realizedFxMinor: '-1',
    });
    expect(second.lines).toEqual([
      { key: 'accounts_payable', side: 'D', currency: 'USD', txn: '33', base: '120', rate: '3.6500000000' },
      { key: 'accounts_payable', side: 'D', currency: 'ILS', txn: '1', base: '1', rate: '1.0000000000' },
      { key: 'bank', side: 'C', currency: 'USD', txn: '33', base: '120', rate: '3.6500000000' },
      { key: 'fx_gain', side: 'C', currency: 'ILS', txn: '1', base: '1', rate: '1.0000000000' },
    ]);
  });
});

describe('T-06 MP-4 across every S6 entry', () => {
  it('no line is on rounding (6100) or purchase_price_variance (6200); realized = payment base − carrying released on every allocation', async () => {
    const keys = await s6SystemKeys(ownerPool(), A.businessId);
    expect(keys).not.toContain('rounding');
    expect(keys).not.toContain('purchase_price_variance');
    expect(
      keys.every((k) => ['accounts_payable', 'bank', 'fx_gain', 'fx_loss'].includes(k)),
      keys.join(','),
    ).toBe(true);
    const bad = await ownerPool().query(
      `SELECT id FROM supplier_payment_allocations
        WHERE business_id = $1 AND realized_fx_gain_loss_minor <> payment_base_amount_minor - purchase_carrying_base_released_minor`,
      [A.businessId],
    );
    expect(bad.rowCount).toBe(0);
    const n = must(
      (await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM supplier_payment_allocations WHERE business_id = $1`, [A.businessId])).rows[0],
    ).n;
    expect(n, 'the allocations this suite made').toBe(6);
  });
});
