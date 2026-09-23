/**
 * GOLDEN REGRESSION — REPORT SHAPES (P2-S7 §46, §47, §48).
 *
 * One business, eleven hand-written journal entries, and then the two
 * reports asserted AS LITERAL TABLES: every account code, type, debit,
 * credit and signed net in the trial balance, and every ledger row with the
 * running balance it must carry after it.
 *
 * The numbers below were computed by hand from the entries above them, not
 * read back from a run. That is the whole value of a golden file: a
 * refactor that changes what the reports say has to change these literals
 * too, and changing them is a decision somebody makes on purpose rather
 * than a diff nobody looks at.
 *
 * The eleven entries are chosen to cover every shape §46 lists, and each
 * one is a shape that has previously been got wrong somewhere:
 *
 *   an opening balance                 — the business-level position
 *   its reversal                       — history, not erasure
 *   its replacement                    — AL-13's one CURRENT posted set
 *   a domestic sale                    — the ordinary case
 *   a foreign purchase                 — the FX snapshot, frozen on the line
 *   a settlement at a worse rate       — realized FX loss
 *   a second foreign purchase          — so the gain below has a payable
 *   a settlement at a better rate      — realized FX gain
 *   a sale with a rounding remainder   — the one-minor-unit account
 *   a posting to an account later deactivated — history outlives `is_active`
 *   a manual adjustment                — cost of goods, moved by hand
 *
 * Every date is distinct, so the ordering tuple `(entry_date, entry_id,
 * line_no)` is fully determined by the dates and the golden ledger below is
 * a stable sequence rather than a sequence that happens to have sorted that
 * way for this run's UUIDs.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ownerPool, resetData, uniqueEmail, type TestApp } from '../../helpers/test-app';
import {
  fingerprintOf,
  must,
  openingBalanceFingerprintOf,
  openingBalanceSnapshot,
  postAdjustmentAs,
  postOpeningBalanceAs,
  postReversalAs,
  rate10,
  reversalFingerprintOfSnapshot,
  sourceAssertion,
  todayIn,
  type PostCommand,
  type PostLine,
} from '../../helpers/accounting-posting';

let t: TestApp;
const AT = new Date('2026-03-14T09:15:00Z');
const unique = (): string => `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

interface Owner {
  token: string;
  userId: string;
  businessId: string;
  tenantId: string;
}

let o: Owner;
let today: string;
let cashId: string;

const auth = () => ({ Authorization: `Bearer ${o.token}`, 'X-Business-Id': o.businessId });

function daysBefore(base: string, n: number): string {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function line(
  account: { kind: 'system'; systemKey: string } | { kind: 'code'; code: string },
  side: 'D' | 'C',
  amount: bigint,
  fx: Partial<PostLine> = {},
): PostLine {
  return {
    account,
    side,
    baseAmountMinor: amount,
    baseCurrency: 'ILS',
    txnAmountMinor: amount,
    txnCurrency: 'ILS',
    fxRate: '1',
    fxRateSource: 'base',
    fxRateAt: AT,
    branchId: null,
    warehouseId: null,
    ...fx,
  };
}

const sys = (systemKey: string): { kind: 'system'; systemKey: string } => ({ kind: 'system', systemKey });
const code = (value: string): { kind: 'code'; code: string } => ({ kind: 'code', code: value });

function command(sourceId: string, entryDate: string, lines: readonly PostLine[], description: string): PostCommand {
  return {
    tenantId: o.tenantId,
    businessId: o.businessId,
    sourceType: 'manual_adjustment',
    sourceId,
    entryDate,
    description,
    requestId: 'req-golden',
    lines: [...lines],
  };
}

async function adjust(entryDate: string, lines: readonly PostLine[], description: string): Promise<string> {
  const c = command(randomUUID(), entryDate, lines, description);
  const assertion = sourceAssertion({
    actorUserId: o.userId,
    tenantId: o.tenantId,
    businessId: o.businessId,
    operationKind: 'post',
    sourceType: 'manual_adjustment',
    sourceId: c.sourceId,
    postingFingerprint: fingerprintOf(c),
  });
  return (await postAdjustmentAs(assertion, c, 'because the merchant said so')).entryId;
}

async function openingBalance(
  asOfDate: string,
  positions: readonly PostLine[],
): Promise<{ entryId: string; positions: readonly PostLine[]; asOfDate: string }> {
  const openingBalanceId = randomUUID();
  const assertion = sourceAssertion({
    actorUserId: o.userId,
    tenantId: o.tenantId,
    businessId: o.businessId,
    operationKind: 'post',
    sourceType: 'opening_balance',
    sourceId: openingBalanceId,
    postingFingerprint: openingBalanceFingerprintOf({
      tenantId: o.tenantId,
      businessId: o.businessId,
      openingBalanceId,
      asOfDate,
      baseCurrency: 'ILS',
      positions,
    }),
  });
  const out = await postOpeningBalanceAs(assertion, { asOfDate, positions, openingBalanceId });
  return { entryId: out.entryId, positions, asOfDate };
}

async function reverseOpeningBalance(ob: { entryId: string; positions: readonly PostLine[]; asOfDate: string }, entryDate: string): Promise<void> {
  const snapshot = openingBalanceSnapshot({
    entryId: ob.entryId,
    tenantId: o.tenantId,
    businessId: o.businessId,
    asOfDate: ob.asOfDate,
    baseCurrency: 'ILS',
    positions: ob.positions,
  });
  const assertion = sourceAssertion({
    actorUserId: o.userId,
    tenantId: o.tenantId,
    businessId: o.businessId,
    operationKind: 'reverse',
    sourceType: 'reversal',
    sourceId: ob.entryId,
    postingFingerprint: reversalFingerprintOfSnapshot(snapshot, entryDate),
  });
  await postReversalAs(assertion, ob.entryId, entryDate, 'the opening position was restated', randomUUID());
}

async function get(path: string, query: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await t.request.get(`/v1/businesses/${o.businessId}/accounting/${path}`).query(query).set(auth());
  return { status: res.status, body: res.body as Record<string, unknown> };
}

/** The account later deactivated; outside the seeded system chart on purpose. */
const STALL = '7500';

let fxPurchaseEntry: string;

beforeAll(async () => {
  await resetData();
  t = await createTestApp();

  const reg = await t.request
    .post('/v1/auth/register')
    .send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'Golden', preferredLocale: 'ar' });
  const token = reg.body.accessToken as string;
  const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
  const on = await t.request
    .post('/v1/onboarding/complete')
    .set('Idempotency-Key', `idem-${unique()}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ businessName: 'Golden Books', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `gold-${unique()}`.slice(0, 60) });
  expect(on.status).toBe(201);
  const businessId = on.body.businessId as string;
  const tenantId = must((await ownerPool().query<{ tenant_id: string }>(`SELECT tenant_id FROM businesses WHERE id = $1`, [businessId])).rows[0]).tenant_id;
  o = { token, userId: me.body.userId as string, businessId, tenantId };
  today = await todayIn(ownerPool(), 'Asia/Hebron');

  await ownerPool().query(`INSERT INTO accounts (tenant_id, business_id, code, name, type) VALUES ($1, $2, $3, 'Seasonal Stall', 'expense')`, [
    tenantId,
    businessId,
    STALL,
  ]);

  // 1. The opening position: 5,000.00 cash and 2,000.00 inventory, with the
  //    7,000.00 of equity the engine derives.
  const first = await openingBalance(daysBefore(today, 400), [line(sys('cash'), 'D', 500_000n), line(sys('inventory'), 'D', 200_000n)]);

  // 2. It was wrong about the cash. Reversed — not edited, not deleted.
  await reverseOpeningBalance(first, daysBefore(today, 395));

  // 3. …and restated: 4,500.00 cash, same inventory, 6,500.00 of equity.
  await openingBalance(daysBefore(today, 390), [line(sys('cash'), 'D', 450_000n), line(sys('inventory'), 'D', 200_000n)]);

  // 4. A domestic sale for 600.00.
  await adjust(daysBefore(today, 300), [line(sys('cash'), 'D', 60_000n), line(sys('sales_revenue'), 'C', 60_000n)], 'a domestic sale');

  // 5. Stock bought for 100.00 USD at 3.6000000000 → 360.00 ILS.
  fxPurchaseEntry = await adjust(
    daysBefore(today, 250),
    [
      line(sys('inventory'), 'D', 36_000n, { txnAmountMinor: 10_000n, txnCurrency: 'USD', fxRate: rate10('3.6'), fxRateSource: 'manual' }),
      line(sys('accounts_payable'), 'C', 36_000n, { txnAmountMinor: 10_000n, txnCurrency: 'USD', fxRate: rate10('3.6'), fxRateSource: 'manual' }),
    ],
    'stock bought in USD',
  );

  // 6. Settled for 380.00 ILS: the payable leaves at the rate it was booked
  //    at, and the extra 20.00 is a realized loss, not a silent restatement
  //    of the purchase.
  await adjust(
    daysBefore(today, 200),
    [line(sys('accounts_payable'), 'D', 36_000n), line(sys('fx_loss'), 'D', 2_000n), line(sys('cash'), 'C', 38_000n)],
    'settled above the booked rate',
  );

  // 7 & 8. The same again the other way: a 100.00 payable settled for 95.00,
  //        and the 5.00 is a realized gain.
  await adjust(daysBefore(today, 160), [line(sys('inventory'), 'D', 10_000n), line(sys('accounts_payable'), 'C', 10_000n)], 'more stock on credit');
  await adjust(
    daysBefore(today, 150),
    [line(sys('accounts_payable'), 'D', 10_000n), line(sys('cash'), 'C', 9_500n), line(sys('fx_gain'), 'C', 500n)],
    'settled below the booked rate',
  );

  // 9. A 100.00 sale taken in cash to the nearest agora: the remainder is a
  //    posting of its own, never a difference absorbed into revenue.
  await adjust(
    daysBefore(today, 100),
    [line(sys('cash'), 'D', 9_999n), line(sys('rounding'), 'D', 1n), line(sys('sales_revenue'), 'C', 10_000n)],
    'a sale with a rounding remainder',
  );

  // 10. 300.00 spent on a seasonal stall, whose account is then closed to new
  //     postings. `is_active` governs the future; the 300.00 stays.
  await adjust(daysBefore(today, 50), [line(code(STALL), 'D', 30_000n), line(sys('cash'), 'C', 30_000n)], 'the seasonal stall');
  await ownerPool().query(`UPDATE accounts SET is_active = false WHERE business_id = $1 AND code = $2`, [businessId, STALL]);

  // 11. Cost of goods moved by hand.
  await adjust(daysBefore(today, 20), [line(sys('cogs'), 'D', 45_000n), line(sys('inventory'), 'C', 45_000n)], 'cost of goods');

  const accounts = (await get('accounts')).body['items'] as { code: string; accountId: string }[];
  cashId = must(accounts.find((a) => a.code === '1000')).accountId;
}, 300_000);

// ── GOLD-R1: the trial balance, account by account ───────────────────────
//
// Hand-computed from the eleven entries above. A balanced trial balance made
// of the wrong accounts balances perfectly, so the totals are asserted LAST
// and are never the only assertion.

const GOLDEN_TRIAL_BALANCE = [
  { code: '1000', type: 'asset', totalDebitMinor: '1019999', totalCreditMinor: '577500', netMinor: '442499', isActive: true },
  { code: '1200', type: 'asset', totalDebitMinor: '446000', totalCreditMinor: '245000', netMinor: '201000', isActive: true },
  { code: '2000', type: 'liability', totalDebitMinor: '46000', totalCreditMinor: '46000', netMinor: '0', isActive: true },
  { code: '3000', type: 'equity', totalDebitMinor: '700000', totalCreditMinor: '1350000', netMinor: '650000', isActive: true },
  { code: '4000', type: 'revenue', totalDebitMinor: '0', totalCreditMinor: '70000', netMinor: '70000', isActive: true },
  { code: '4900', type: 'revenue', totalDebitMinor: '0', totalCreditMinor: '500', netMinor: '500', isActive: true },
  { code: '5000', type: 'expense', totalDebitMinor: '45000', totalCreditMinor: '0', netMinor: '45000', isActive: true },
  { code: '6100', type: 'expense', totalDebitMinor: '1', totalCreditMinor: '0', netMinor: '1', isActive: true },
  { code: '6900', type: 'expense', totalDebitMinor: '2000', totalCreditMinor: '0', netMinor: '2000', isActive: true },
  { code: '7500', type: 'expense', totalDebitMinor: '30000', totalCreditMinor: '0', netMinor: '30000', isActive: false },
] as const;

// ── GOLD-R2: the cash ledger, row by row, with its running balance ───────
//
// Cash is debit-normal, so the running figure is cumulative debits minus
// cumulative credits. Each line below was carried forward by hand.

const GOLDEN_CASH_LEDGER = [
  { day: 400, side: 'D', amount: '500000', runningMinor: '500000' },
  { day: 395, side: 'C', amount: '500000', runningMinor: '0' },
  { day: 390, side: 'D', amount: '450000', runningMinor: '450000' },
  { day: 300, side: 'D', amount: '60000', runningMinor: '510000' },
  { day: 200, side: 'C', amount: '38000', runningMinor: '472000' },
  { day: 150, side: 'C', amount: '9500', runningMinor: '462500' },
  { day: 100, side: 'D', amount: '9999', runningMinor: '472499' },
  { day: 50, side: 'C', amount: '30000', runningMinor: '442499' },
] as const;

describe('GOLD-R1 — the trial balance is exactly this table (§46, §47)', () => {
  it('states every account, with its own debit, credit and signed net', async () => {
    const res = await get('trial-balance', { asOf: today, includeZeroActivity: 'false' });
    expect(res.status).toBe(200);
    const rows = res.body['items'] as { code: string; type: string; totalDebitMinor: string; totalCreditMinor: string; netMinor: string; isActive: boolean }[];

    expect(rows.map((r) => r.code)).toEqual(GOLDEN_TRIAL_BALANCE.map((g) => g.code));
    for (const golden of GOLDEN_TRIAL_BALANCE) {
      const row = must(
        rows.find((r) => r.code === golden.code),
        `account ${golden.code}`,
      );
      expect({
        code: row.code,
        type: row.type,
        totalDebitMinor: row.totalDebitMinor,
        totalCreditMinor: row.totalCreditMinor,
        netMinor: row.netMinor,
        isActive: row.isActive,
      }).toEqual({
        ...golden,
      });
    }
  });

  it('and only then, the whole-business totals agree exactly (§23)', async () => {
    const res = await get('trial-balance', { asOf: today });
    expect(res.body['kind']).toBe('whole_business');
    expect(res.body['isBalanced']).toBe(true);
    expect(res.body['totalDebitMinor']).toBe('2289000');
    expect(res.body['totalCreditMinor']).toBe('2289000');
    expect(res.body['baseCurrency']).toBe('ILS');
  });

  /**
   * The payable was drawn down to nothing, which is not the same fact as an
   * account that was never used. It has 460.00 of movement in each column,
   * so it is in the report with a net of zero (§65).
   */
  it('an account netting to zero after real movement is still reported', async () => {
    const res = await get('trial-balance', { asOf: today, includeZeroActivity: 'false' });
    const payable = must((res.body['items'] as { code: string; netMinor: string }[]).find((r) => r.code === '2000'));
    expect(payable.netMinor).toBe('0');
  });
});

describe('GOLD-R2 — the cash ledger is exactly this walk (§48)', () => {
  it('carries each posting and the balance after it', async () => {
    const res = await get('ledger', { accountId: cashId, from: daysBefore(today, 500), to: today });
    expect(res.status).toBe(200);
    expect(res.body['openingMinor']).toBe('0');
    expect(res.body['closingMinor']).toBe('442499');

    const rows = res.body['items'] as { entryDate: string; debitMinor: string; creditMinor: string; runningMinor: string }[];
    expect(rows.length).toBe(GOLDEN_CASH_LEDGER.length);
    rows.forEach((row, i) => {
      const golden = must(GOLDEN_CASH_LEDGER[i], `ledger row ${i}`);
      expect({
        entryDate: row.entryDate,
        debitMinor: row.debitMinor,
        creditMinor: row.creditMinor,
        runningMinor: row.runningMinor,
      }).toEqual({
        entryDate: daysBefore(today, golden.day),
        debitMinor: golden.side === 'D' ? golden.amount : '0',
        creditMinor: golden.side === 'C' ? golden.amount : '0',
        runningMinor: golden.runningMinor,
      });
    });
  });

  /**
   * The closing figure of the ledger and the net of the same account in the
   * trial balance are two different code paths over the same rows. They are
   * asserted equal because a divergence between them is precisely the class
   * of bug a merchant would find by reconciling two screens.
   */
  it('closes on the same figure the trial balance nets to', async () => {
    const ledger = await get('ledger', { accountId: cashId, from: daysBefore(today, 500), to: today });
    const tb = await get('trial-balance', { asOf: today });
    const cash = must((tb.body['items'] as { code: string; netMinor: string }[]).find((r) => r.code === '1000'));
    expect(ledger.body['closingMinor']).toBe(cash.netMinor);
    expect(cash.netMinor).toBe('442499');
  });
});

describe('GOLD-R3 — the FX snapshot on the line is what the report renders (§30, §52)', () => {
  it('renders the rate the purchase was posted at, to ten decimal places', async () => {
    const detail = await get(`entries/${fxPurchaseEntry}`);
    expect(detail.status).toBe(200);
    const inventory = must((detail.body['lines'] as Record<string, unknown>[]).find((l) => l['code'] === '1200'));
    expect(inventory).toMatchObject({
      txnAmountMinor: '10000',
      txnCurrency: 'USD',
      baseAmountMinor: '36000',
      baseCurrency: 'ILS',
      fxRate: '3.6000000000',
      fxRateSource: 'manual',
    });
  });
});
