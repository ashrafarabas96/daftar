/**
 * THE FINANCIAL READS, AGAINST A REAL LEDGER (P2-S7 §45-§48, §52, §33, §34).
 *
 * Every report below is read over HTTP, through the real router, the real
 * permission guard, the real service and the real database, and every number
 * in it is then checked against a SEPARATE recomputation this file performs
 * itself, directly over `journal_entries` and `journal_lines`.
 *
 * That separation is the point of the suite. §45 asks for read-model truth to
 * be rebuildable, and P2-S7 stores no read model at all, so the strongest
 * available form of the same proof is: compute the answer twice, by two
 * independent routes, and compare value by value. `recompute()` below shares
 * NOTHING with the production aggregation — not a helper, not a query, not the
 * normal-balance function. A test that called the code under test to produce
 * its expectation would agree with it by construction and prove nothing.
 *
 * "The report balances" is deliberately never the whole assertion either. A
 * perfectly balanced trial balance made of the wrong accounts balances
 * perfectly, so the golden cases assert account by account: code, type, debit,
 * credit and signed net.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ownerPool, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';
import {
  fingerprintOf,
  must,
  openingBalanceFingerprintOf,
  postAdjustmentAs,
  postOpeningBalanceAs,
  postReversalAs,
  rate10,
  reversalFingerprintOf,
  sourceAssertion,
  todayIn,
  type PostCommand,
  type PostLine,
} from '../helpers/accounting-posting';

let t: TestApp;

const AT = new Date('2026-03-14T09:15:00Z');
const unique = (): string => `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

interface Owner {
  token: string;
  userId: string;
  businessId: string;
  tenantId: string;
}

const auth = (o: Owner) => ({ Authorization: `Bearer ${o.token}`, 'X-Business-Id': o.businessId });

async function restart(): Promise<void> {
  if (t !== undefined) await t.close();
  await resetData();
  t = await createTestApp();
}

async function onboard(name = 'Reports Owner'): Promise<Owner> {
  const reg = await t.request.post('/v1/auth/register').send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: name, preferredLocale: 'ar' });
  expect(reg.status).toBe(201);
  const token = reg.body.accessToken as string;
  const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
  const on = await t.request
    .post('/v1/onboarding/complete')
    .set('Idempotency-Key', `idem-${unique()}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ businessName: 'Reports Biz', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `rpt-${unique()}`.slice(0, 60) });
  expect(on.status).toBe(201);
  const businessId = on.body.businessId as string;
  const r = await ownerPool().query<{ tenant_id: string }>(`SELECT tenant_id FROM businesses WHERE id = $1`, [businessId]);
  return { token, userId: me.body.userId as string, businessId, tenantId: must(r.rows[0]).tenant_id };
}

/** A civil date `n` days before today in the business timezone. */
function daysBefore(today: string, n: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

type Key = 'cash' | 'bank' | 'inventory' | 'accounts_payable' | 'opening_equity' | 'sales_revenue' | 'cogs' | 'fx_loss';

function line(key: Key | { code: string }, side: 'D' | 'C', amount: bigint, extra: Partial<PostLine> = {}): PostLine {
  return {
    account: typeof key === 'string' ? { kind: 'system', systemKey: key } : { kind: 'code', code: key.code },
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
    ...extra,
  };
}

function command(o: Owner, sourceId: string, entryDate: string, lines: readonly PostLine[]): PostCommand {
  return {
    tenantId: o.tenantId,
    businessId: o.businessId,
    sourceType: 'manual_adjustment',
    sourceId,
    entryDate,
    description: 'a reported fact',
    requestId: 'req-report',
    lines: [...lines],
  };
}

/** Post an adjustment through the real command, as the merchant runtime. */
async function adjust(o: Owner, entryDate: string, lines: readonly PostLine[]): Promise<string> {
  const c = command(o, randomUUID(), entryDate, lines);
  const assertion = sourceAssertion({
    actorUserId: o.userId,
    tenantId: o.tenantId,
    businessId: o.businessId,
    operationKind: 'post',
    sourceType: 'manual_adjustment',
    sourceId: c.sourceId,
    postingFingerprint: fingerprintOf(c),
  });
  const out = await postAdjustmentAs(assertion, c, 'because the merchant said so');
  return out.entryId;
}

async function openingBalance(o: Owner, asOfDate: string, positions: readonly PostLine[]): Promise<string> {
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
  return out.entryId;
}

// ── The independent reference calculator (§45) ────────────────────────────
//
// Reads the immutable journal rows and adds them up in TypeScript, with its
// own copy of the normal-direction rule. It shares no code with the report
// implementation on purpose: two routes to the same number, compared.

const NORMAL_DEBIT = new Set(['asset', 'expense']);

interface RefRow {
  code: string;
  type: string;
  debit: bigint;
  credit: bigint;
  net: bigint;
}

async function recompute(businessId: string, where: { asOf?: string; from?: string; to?: string; branchId?: string | null }): Promise<Map<string, RefRow>> {
  const rows = (
    await ownerPool().query<{ code: string; type: string; debit_minor: string; credit_minor: string; entry_date: string; branch_id: string | null }>(
      `SELECT a.code, a.type, l.debit_minor::text AS debit_minor, l.credit_minor::text AS credit_minor,
              to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date, l.branch_id
         FROM journal_lines l
         JOIN journal_entries e ON e.business_id = l.business_id AND e.id = l.journal_entry_id
         JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
        WHERE l.business_id = $1`,
      [businessId],
    )
  ).rows;

  const out = new Map<string, RefRow>();
  for (const r of rows) {
    if (where.asOf !== undefined && r.entry_date > where.asOf) continue;
    if (where.from !== undefined && r.entry_date < where.from) continue;
    if (where.to !== undefined && r.entry_date > where.to) continue;
    if (where.branchId !== undefined && r.branch_id !== where.branchId) continue;
    const current = out.get(r.code) ?? { code: r.code, type: r.type, debit: 0n, credit: 0n, net: 0n };
    current.debit += BigInt(r.debit_minor);
    current.credit += BigInt(r.credit_minor);
    current.net = NORMAL_DEBIT.has(r.type) ? current.debit - current.credit : current.credit - current.debit;
    out.set(r.code, current);
  }
  return out;
}

interface Res {
  status: number;
  body: Record<string, unknown>;
}

async function get(o: Owner, path: string, query: Record<string, string | number | undefined> = {}): Promise<Res> {
  const res = await t.request.get(`/v1/businesses/${o.businessId}/accounting/${path}`).query(query).set(auth(o));
  return { status: res.status, body: res.body as Record<string, unknown> };
}

interface TbRow {
  code: string;
  type: string;
  totalDebitMinor: string;
  totalCreditMinor: string;
  netMinor: string;
  isActive: boolean;
}

const tbRows = (body: Record<string, unknown>): TbRow[] => body['items'] as unknown as TbRow[];

beforeAll(async () => {
  await restart();
}, 180_000);

describe('the trial balance is the ledger, added up (§22, §23, §47)', () => {
  let o: Owner;
  let today: string;

  beforeAll(async () => {
    o = await onboard();
    today = await todayIn(ownerPool(), 'Asia/Hebron');
    // An opening position, then three ordinary facts on three dates. Every
    // amount below is hand-chosen so the expected report can be written out
    // in full rather than derived by the same arithmetic under test.
    await openingBalance(o, daysBefore(today, 400), [line('cash', 'D', 500_000n)]);
    await adjust(o, daysBefore(today, 100), [line('inventory', 'D', 120_000n), line('accounts_payable', 'C', 120_000n)]);
    await adjust(o, daysBefore(today, 60), [line('cash', 'D', 90_000n), line('sales_revenue', 'C', 90_000n)]);
    await adjust(o, daysBefore(today, 10), [line('cogs', 'D', 45_000n), line('inventory', 'C', 45_000n)]);
  }, 180_000);

  it('states every account exactly, and the totals agree to the minor unit', async () => {
    const res = await get(o, 'trial-balance', { asOf: today });
    expect(res.status).toBe(200);
    expect(res.body['kind']).toBe('whole_business');
    expect(res.body['isBalanced']).toBe(true);
    expect(res.body['baseCurrency']).toBe('ILS');

    // Row by row, hand-computed. Not "the sums match" — a balanced report
    // made of the wrong accounts balances perfectly (§46).
    const byCode = new Map(tbRows(res.body).map((r) => [r.code, r]));
    expect([...byCode.keys()].sort()).toEqual(['1000', '1200', '2000', '3000', '4000', '5000']);

    expect(byCode.get('1000')).toMatchObject({ type: 'asset', totalDebitMinor: '590000', totalCreditMinor: '0', netMinor: '590000' });
    expect(byCode.get('1200')).toMatchObject({ type: 'asset', totalDebitMinor: '120000', totalCreditMinor: '45000', netMinor: '75000' });
    expect(byCode.get('2000')).toMatchObject({ type: 'liability', totalDebitMinor: '0', totalCreditMinor: '120000', netMinor: '120000' });
    expect(byCode.get('3000')).toMatchObject({ type: 'equity', totalDebitMinor: '0', totalCreditMinor: '500000', netMinor: '500000' });
    expect(byCode.get('4000')).toMatchObject({ type: 'revenue', totalDebitMinor: '0', totalCreditMinor: '90000', netMinor: '90000' });
    expect(byCode.get('5000')).toMatchObject({ type: 'expense', totalDebitMinor: '45000', totalCreditMinor: '0', netMinor: '45000' });

    // Σ debit = Σ credit, exactly. No tolerance, no float.
    expect(res.body['totalDebitMinor']).toBe('755000');
    expect(res.body['totalCreditMinor']).toBe('755000');
    expect(res.body['totalDebitMinor']).toBe(res.body['totalCreditMinor']);
  });

  it('equals an independent recomputation from the journal rows, value by value (§45)', async () => {
    const res = await get(o, 'trial-balance', { asOf: today });
    const expectedByCode = await recompute(o.businessId, { asOf: today });
    const actual = tbRows(res.body);

    expect(actual.length).toBe([...expectedByCode.values()].filter((r) => r.debit !== 0n || r.credit !== 0n).length);
    for (const row of actual) {
      const ref = must(expectedByCode.get(row.code), `reference row for ${row.code}`);
      expect(row.totalDebitMinor).toBe(ref.debit.toString());
      expect(row.totalCreditMinor).toBe(ref.credit.toString());
      expect(row.netMinor).toBe(ref.net.toString());
    }
  });

  it('a range trial balance reports the movement inside the range and nothing outside it', async () => {
    const from = daysBefore(today, 70);
    const to = daysBefore(today, 5);
    const res = await get(o, 'trial-balance', { from, to });
    expect(res.status).toBe(200);
    const byCode = new Map(tbRows(res.body).map((r) => [r.code, r]));
    // The opening position (day −400) and the payable (day −100) are outside.
    expect([...byCode.keys()].sort()).toEqual(['1000', '1200', '4000', '5000']);
    expect(byCode.get('1000')?.netMinor).toBe('90000');
    expect(byCode.get('1200')?.netMinor).toBe('-45000');

    const ref = await recompute(o.businessId, { from, to });
    for (const row of tbRows(res.body)) expect(row.netMinor).toBe(must(ref.get(row.code)).net.toString());
  });

  it('refuses asOf together with from/to instead of picking one (§22)', async () => {
    const res = await get(o, 'trial-balance', { asOf: today, from: today, to: today });
    expect(res.status).toBe(400);
  });

  it('refuses a request that names no window at all', async () => {
    const res = await get(o, 'trial-balance', {});
    expect(res.status).toBe(400);
  });

  it('refuses a range that ends before it starts', async () => {
    const res = await get(o, 'trial-balance', { from: today, to: daysBefore(today, 5) });
    expect(res.status).toBe(400);
  });

  it('omits zero-activity accounts by default and includes them on request (§65)', async () => {
    const lean = await get(o, 'trial-balance', { asOf: today });
    const full = await get(o, 'trial-balance', { asOf: today, includeZeroActivity: 'true' });
    expect(tbRows(lean.body).length).toBe(6);
    // The seeded chart has 21 system accounts; the rest are zero-activity and
    // present only when asked for. Zero activity is NOT inactivity (§65).
    expect(tbRows(full.body).length).toBeGreaterThan(tbRows(lean.body).length);
    expect(tbRows(full.body).every((r) => r.isActive)).toBe(true);
  });
});

describe('history is history: inactive accounts, reversals and replacements (§33, §34)', () => {
  let o: Owner;
  let today: string;
  let customCode: string;

  beforeAll(async () => {
    o = await onboard('History Owner');
    today = await todayIn(ownerPool(), 'Asia/Hebron');
    customCode = '7500';
    await ownerPool().query(`INSERT INTO accounts (tenant_id, business_id, code, name, type) VALUES ($1, $2, $3, 'Seasonal Stall', 'expense')`, [
      o.tenantId,
      o.businessId,
      customCode,
    ]);
    await openingBalance(o, daysBefore(today, 300), [line('cash', 'D', 1_000_000n)]);
    await adjust(o, daysBefore(today, 40), [line({ code: customCode }, 'D', 30_000n), line('cash', 'C', 30_000n)]);
    // The stall closes. The account may take no NEW posting; what it already
    // holds is the merchant's own history and does not move.
    await ownerPool().query(`UPDATE accounts SET is_active = false WHERE business_id = $1 AND code = $2`, [o.businessId, customCode]);
  }, 180_000);

  it('a deactivated account keeps its history in the trial balance, the ledger and the balances (§33)', async () => {
    const account = (await get(o, 'accounts', {})).body['items'] as { code: string; accountId: string; isActive: boolean }[];
    const stall = must(
      account.find((a) => a.code === customCode),
      'the deactivated account',
    );
    expect(stall.isActive).toBe(false);

    const tb = await get(o, 'trial-balance', { asOf: today });
    expect(must(tbRows(tb.body).find((r) => r.code === customCode))).toMatchObject({ totalDebitMinor: '30000', netMinor: '30000', isActive: false });

    const ledger = await get(o, 'ledger', { accountId: stall.accountId, from: daysBefore(today, 365), to: today });
    expect(ledger.status).toBe(200);
    expect((ledger.body['items'] as unknown[]).length).toBe(1);
    expect(ledger.body['closingMinor']).toBe('30000');

    const balances = await get(o, 'balances', { asOf: today, accountId: stall.accountId });
    expect((balances.body['items'] as { balanceMinor: string }[])[0]?.balanceMinor).toBe('30000');
  });

  it('an original, its reversal and the replacement are ALL visible, and the net is the current position (§34)', async () => {
    const entryId = await adjust(o, daysBefore(today, 20), [line('bank', 'D', 70_000n), line('sales_revenue', 'C', 70_000n)]);

    const before = await get(o, 'balances', { asOf: today });
    const bankBefore = must((before.body['items'] as { code: string; balanceMinor: string }[]).find((r) => r.code === '1010')).balanceMinor;
    expect(bankBefore).toBe('70000');

    // Reverse it, then state the corrected fact. Nothing is deleted: a
    // correction in DAFTAR is another journal entry.
    const original = command(o, randomUUID(), daysBefore(today, 20), [line('bank', 'D', 70_000n), line('sales_revenue', 'C', 70_000n)]);
    const reversalDate = daysBefore(today, 15);
    const assertion = sourceAssertion({
      actorUserId: o.userId,
      tenantId: o.tenantId,
      businessId: o.businessId,
      operationKind: 'reverse',
      sourceType: 'reversal',
      sourceId: entryId,
      postingFingerprint: reversalFingerprintOf({ ...original, sourceId: original.sourceId }, entryId, reversalDate),
    });
    await postReversalAs(assertion, entryId, reversalDate, 'the amount was misstated');
    await adjust(o, daysBefore(today, 15), [line('bank', 'D', 65_000n), line('sales_revenue', 'C', 65_000n)]);

    const entries = (await get(o, 'entries', { from: daysBefore(today, 25), to: today })).body['items'] as { entryId: string; sourceType: string }[];
    const kinds = entries.map((e) => e.sourceType).sort();
    expect(kinds).toContain('reversal');
    expect(kinds.filter((k) => k === 'manual_adjustment').length).toBeGreaterThanOrEqual(2);
    // The original entry is STILL THERE. A report that hid it because a later
    // entry reversed it would be inventing a past that did not happen.
    expect(entries.some((e) => e.entryId === entryId)).toBe(true);

    const after = await get(o, 'balances', { asOf: today });
    const bankAfter = must((after.body['items'] as { code: string; balanceMinor: string }[]).find((r) => r.code === '1010')).balanceMinor;
    expect(bankAfter).toBe('65000');

    // And the whole-business trial balance still balances after all of it.
    const tb = await get(o, 'trial-balance', { asOf: today });
    expect(tb.body['totalDebitMinor']).toBe(tb.body['totalCreditMinor']);
    expect(tb.body['isBalanced']).toBe(true);
  });
});

describe('a rate entered tomorrow never changes yesterday (§30, §52)', () => {
  let o: Owner;
  let today: string;
  let entryId: string;

  beforeAll(async () => {
    o = await onboard('FX Owner');
    today = await todayIn(ownerPool(), 'Asia/Hebron');
    // A foreign payable: 100.00 USD at 3.7500000000 → 375.00 ILS.
    entryId = await adjust(o, daysBefore(today, 30), [
      line('inventory', 'D', 37_500n, { txnAmountMinor: 10_000n, txnCurrency: 'USD', fxRate: rate10('3.75'), fxRateSource: 'manual' }),
      line('accounts_payable', 'C', 37_500n, { txnAmountMinor: 10_000n, txnCurrency: 'USD', fxRate: rate10('3.75'), fxRateSource: 'manual' }),
    ]);
  }, 180_000);

  it('the entry detail renders the posted snapshot, before and after a new rate exists', async () => {
    const first = await get(o, `entries/${entryId}`);
    expect(first.status).toBe(200);
    const lineOf = (body: Record<string, unknown>, code: string): Record<string, unknown> =>
      must((body['lines'] as Record<string, unknown>[]).find((l) => l['code'] === code));
    const before = lineOf(first.body, '1200');
    expect(before).toMatchObject({
      txnAmountMinor: '10000',
      txnCurrency: 'USD',
      baseAmountMinor: '37500',
      baseCurrency: 'ILS',
      fxRate: '3.7500000000',
      fxRateSource: 'manual',
    });

    // A completely different rate is entered for the same pair, today.
    const res = await t.request
      .post(`/v1/businesses/${o.businessId}/accounting/fx-rates`)
      .set(auth(o))
      .set('Idempotency-Key', `fx-${unique()}`)
      .send({ fromCurrency: 'USD', toCurrency: 'ILS', rate: '9.9000000000', effectiveAt: `${today}T00:00:00Z` });
    expect(res.status).toBe(201);

    const second = await get(o, `entries/${entryId}`);
    expect(lineOf(second.body, '1200')).toEqual(before);

    // And the ledger row for that account is byte-identical too.
    const accounts = (await get(o, 'accounts', {})).body['items'] as { code: string; accountId: string }[];
    const inventory = must(accounts.find((a) => a.code === '1200'));
    const ledger = await get(o, 'ledger', { accountId: inventory.accountId, from: daysBefore(today, 60), to: today });
    const row = must((ledger.body['items'] as Record<string, unknown>[])[0]);
    expect(row['fxRate']).toBe('3.7500000000');
    expect(row['baseAmountMinor']).toBe('37500');
  });

  it('entry detail carries no assertion material of any kind (§35)', async () => {
    const res = await get(o, `entries/${entryId}`);
    const serialized = JSON.stringify(res.body);
    for (const forbidden of ['posting_fingerprint', 'postingFingerprint', 'assertion', 'jti', 'kid', 'hmac']) {
      expect(serialized).not.toContain(forbidden);
    }
    // What it DOES carry is origin: a number without a source is not evidence.
    expect(res.body['sourceType']).toBe('manual_adjustment');
    expect(typeof res.body['sourceId']).toBe('string');
  });
});

describe('the ledger boundary, and a business that is not yours (§26, §32)', () => {
  let o: Owner;
  let other: Owner;
  let today: string;
  let cashId: string;

  beforeAll(async () => {
    o = await onboard('Ledger Owner');
    other = await onboard('Another Owner');
    today = await todayIn(ownerPool(), 'Asia/Hebron');
    await adjust(o, daysBefore(today, 50), [line('cash', 'D', 10_000n), line('sales_revenue', 'C', 10_000n)]);
    await adjust(o, daysBefore(today, 30), [line('cash', 'D', 20_000n), line('sales_revenue', 'C', 20_000n)]);
    await adjust(o, daysBefore(today, 10), [line('cash', 'C', 5_000n), line('cogs', 'D', 5_000n)]);
    const accounts = (await get(o, 'accounts', {})).body['items'] as { code: string; accountId: string }[];
    cashId = must(accounts.find((a) => a.code === '1000')).accountId;
  }, 180_000);

  it('the opening figure is everything STRICTLY before `from` — never on or after it', async () => {
    // `from` is the day the second posting was made. Its 20,000 belongs in
    // the rows; only the first posting belongs in the opening figure. Off by
    // one here and the first day of every range is counted twice.
    const from = daysBefore(today, 30);
    const res = await get(o, 'ledger', { accountId: cashId, from, to: today });
    expect(res.status).toBe(200);
    expect(res.body['openingMinor']).toBe('10000');
    const rows = res.body['items'] as { entryDate: string; runningMinor: string; debitMinor: string; creditMinor: string }[];
    expect(rows.map((r) => r.entryDate)).toEqual([daysBefore(today, 30), daysBefore(today, 10)]);
    expect(rows.map((r) => r.runningMinor)).toEqual(['30000', '25000']);
    expect(res.body['closingMinor']).toBe('25000');
  });

  it('a range that starts the day after the last posting has an opening equal to everything', async () => {
    const res = await get(o, 'ledger', { accountId: cashId, from: today, to: today });
    expect(res.body['openingMinor']).toBe('25000');
    expect((res.body['items'] as unknown[]).length).toBe(0);
    expect(res.body['closingMinor']).toBe('25000');
  });

  it("another business's account id is NOT FOUND, exactly as an invented one is (§32)", async () => {
    const theirs = (await get(other, 'accounts', {})).body['items'] as { code: string; accountId: string }[];
    const theirCash = must(theirs.find((a) => a.code === '1000')).accountId;

    const foreign = await get(o, 'ledger', { accountId: theirCash, from: daysBefore(today, 365), to: today });
    const invented = await get(o, 'ledger', { accountId: randomUUID(), from: daysBefore(today, 365), to: today });
    expect(foreign.status).toBe(404);
    expect(invented.status).toBe(404);
    // Indistinguishable: the refusal must not confirm that the id is real.
    expect(foreign.body['error']).toMatchObject({ code: (invented.body['error'] as { code: string }).code });

    // The same for an entry, and for a balances probe.
    const theirEntry = await get(other, 'entries', {});
    const theirEntryId = (theirEntry.body['items'] as { entryId: string }[])[0]?.entryId;
    if (theirEntryId !== undefined) expect((await get(o, `entries/${theirEntryId}`)).status).toBe(404);
    const probe = await get(o, 'balances', { asOf: today, accountId: theirCash });
    expect((probe.body['items'] as unknown[]).length).toBe(0);
  });

  it('a malformed cursor is refused, and never interpreted', async () => {
    for (const cursor of ['nonsense', 'glc/2.AAAA', `glc/1.${Buffer.from('x|y|z').toString('base64url')}`, 'glc/1.!!!!']) {
      const res = await get(o, 'ledger', { accountId: cashId, from: daysBefore(today, 365), to: today, cursor });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
  });
});

describe('a cumulative history larger than a BIGINT still adds up (§41)', () => {
  let o: Owner;
  let today: string;

  beforeAll(async () => {
    o = await onboard('Big Owner');
    today = await todayIn(ownerPool(), 'Asia/Hebron');
    // Each line is capped at 10^18 by the schema. Twenty of them are 2 × 10^19
    // — beyond what a BIGINT holds — which is exactly the case §41 exists
    // for: the cap is per line, never on their sum.
    const cap = 1_000_000_000_000_000_000n;
    for (let i = 0; i < 20; i += 1) {
      await adjust(o, daysBefore(today, 200 - i), [line('cash', 'D', cap), line('sales_revenue', 'C', cap)]);
    }
  }, 300_000);

  it('reports the exact total as a decimal string rather than overflowing', async () => {
    const res = await get(o, 'trial-balance', { asOf: today });
    expect(res.status).toBe(200);
    expect(res.body['totalDebitMinor']).toBe('20000000000000000000');
    expect(res.body['totalCreditMinor']).toBe('20000000000000000000');
    const cash = must(tbRows(res.body).find((r) => r.code === '1000'));
    expect(cash.netMinor).toBe('20000000000000000000');
    // The string survives a round trip through BigInt, which a double would
    // not: Number('20000000000000000000') is 20000000000000000000 only by
    // accident of formatting and is not the same value.
    expect(BigInt(cash.netMinor)).toBe(20_000_000_000_000_000_000n);
  });
});
