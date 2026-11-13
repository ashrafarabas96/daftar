import { describe, expect, it } from 'vitest';
import type { SaleDto } from '@daftar/shared-contracts';
import { ApiError } from '@/lib/client';
import { FALLBACK_ERROR_KEY } from '@/lib/phase3-errors';
import type { CreditSaleRequestDto } from '@/lib/phase4-credit-sale-api';
import { draftLineOf, type DraftLine } from '@/views/stock/model';
import { MAX_SALE_LINES, createSubmitGuard, mintCreditSaleIds, planCreditSale, type CreditSaleFormModel, type CreditSaleIds } from '@/views/sales/credit-sale';
import {
  ALREADY_STORED_CODE,
  CREDIT_SALE_REFUSAL_KEYS,
  STORED_UNREADABLE_KEY,
  afterOutcome,
  beforeSend,
  createCreditSaleFlow,
  creditSaleRefusalKey,
  type CreditSaleScreenState,
} from '@/views/sales/credit-sale-flow';

/**
 * The credit sale's plan and send logic, outside React.
 *
 * What it must guarantee, each shown here:
 * - the body is a CREDIT sale for the customer the route named, never a walk-in;
 * - the ids are minted ONCE per flow, and every send — after no answer, after an
 *   edit, after a refusal — carries the same sale id and the same line ids;
 * - a double click sends once;
 * - `sale.idempotency_conflict` is raised only when a sale with this id is
 *   ALREADY STORED with a different command (`sale-commit.service.ts`: the
 *   refusal sits under `stored !== null`), so the stored sale is read and shown,
 *   never "start over";
 * - a refusal leaves the typed form exactly as it was;
 * - the dates are judged as civil dates by text, with the pay-by date allowed ON
 *   the sale date and refused one day before it.
 */

const CUSTOMER = '7c1f0a52-3b7e-4d0a-9a53-0f2b6f1c7a01';
const WAREHOUSE = 'a1b2c3d4-0001-4a7b-8c9d-0000000000w1';

function counter() {
  let n = 0;
  const mint = (): string => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  };
  return { mint, count: () => n };
}

const line = (key: string, quantity: string, decimals = 0): DraftLine => ({
  ...draftLineOf(
    {
      key: `p-${key}:`,
      productId: `11111111-1111-4111-8111-${key.padStart(12, '0')}`,
      variantId: null,
      name: `Item ${key}`,
      variantName: null,
      unitCode: 'piece',
      unitDecimals: decimals,
      onHand: null,
    },
    `line-${key}`,
  ),
  quantity,
});

const form = (over: Partial<CreditSaleFormModel> = {}): CreditSaleFormModel => ({
  warehouseId: WAREHOUSE,
  documentDate: '2026-11-14',
  dueDate: '',
  errors: {},
  ...over,
});

const planner = (f: CreditSaleFormModel, lines: readonly DraftLine[]) => (ids: CreditSaleIds) => planCreditSale({ customerId: CUSTOMER, form: f, lines, ids });

function planOk(plan: (ids: CreditSaleIds) => ReturnType<typeof planCreditSale>): CreditSaleRequestDto {
  const planned = plan(mintCreditSaleIds(counter().mint));
  if (!planned.ok) throw new Error(`plan refused: ${JSON.stringify(planned)}`);
  return planned.body;
}

const saleFor = (body: CreditSaleRequestDto, replayed: boolean): SaleDto => ({
  saleId: body.saleId,
  status: 'confirmed',
  settlementMode: 'credit',
  customerId: body.customerId,
  branchId: 'b0b0b0b0-0001-4a7b-8c9d-000000000001',
  warehouseId: body.warehouseId,
  documentDate: body.documentDate,
  currencyCode: 'ILS',
  subtotalTxnMinor: '4500',
  discountTxnMinor: '0',
  taxMinor: '0',
  totalTxnMinor: '4500',
  totalBaseMinor: '4500',
  sourceToBaseRate: '1',
  rateSource: 'base',
  rateTimestamp: '2026-11-14T08:00:00Z',
  lines: [],
  invoice: {
    invoiceId: 'f0f0f0f0-0001-4a7b-8c9d-000000000001',
    number: { documentKind: 'invoice', period: '2026', numberSeq: '42', documentNumber: 'INV-0042' },
    issueDate: body.documentDate,
    dueDate: body.dueDate,
    status: 'open',
    totalTxnMinor: '4500',
    totalBaseMinor: '4500',
  },
  cogsBaseMinor: '3000',
  replayed,
});

const CONFLICT = new ApiError(409, 'CONFLICT', { sellingCode: 'sale.idempotency_conflict' });
const CHANGED = new ApiError(409, 'CONFLICT', { sellingCode: 'sale.state_changed' });
const NOT_PERMITTED = new ApiError(403, 'FORBIDDEN', { sellingCode: 'sale.credit_not_permitted' });

const screen = (f: CreditSaleFormModel, lines: DraftLine[]): CreditSaleScreenState => ({
  form: f,
  lines,
  lineErrors: {},
  busy: true,
  errorKey: null,
  result: null,
  stored: null,
  storedUnread: false,
});

describe('planCreditSale — the body is a credit sale for the named customer', () => {
  it('states credit, the route customer, the warehouse, both dates and one line per item, and nothing the server computes', () => {
    const body = planOk(planner(form({ dueDate: '2026-12-14' }), [line('1', '3'), line('2', '1.5', 2)]));
    expect(body.settlementMode).toBe('credit');
    expect(body.customerId).toBe(CUSTOMER);
    expect(body.warehouseId).toBe(WAREHOUSE);
    expect(body.documentDate).toBe('2026-11-14');
    expect(body.dueDate).toBe('2026-12-14');
    // The structural zero, the only value `SaleCommitSchema` admits (P4-AL-44, OD-03 open).
    expect(body.taxMinor).toBe('0');
    expect(body.notes).toBeNull();
    expect(body.lines.map((l) => [l.quantity, l.discountMinor, l.variantId])).toEqual([
      ['3', '0', null],
      ['1.5', '0', null],
    ]);
    // `.strict()` on the server: exactly these keys, and no price, total, currency or cost.
    expect(Object.keys(body).sort()).toEqual([
      'customerId',
      'documentDate',
      'dueDate',
      'lines',
      'notes',
      'saleId',
      'settlementMode',
      'taxMinor',
      'warehouseId',
    ]);
    for (const l of body.lines) expect(Object.keys(l).sort()).toEqual(['discountMinor', 'lineId', 'productId', 'quantity', 'variantId']);
  });

  it('no pay-by date is stated as null, not omitted', () => {
    const body = planOk(planner(form({ dueDate: '' }), [line('1', '1')]));
    expect(body).toHaveProperty('dueDate', null);
    expect(planOk(planner(form({ dueDate: '   ' }), [line('1', '1')])).dueDate).toBeNull();
  });

  it('a credit sale with no customer is a defect, refused before anything is sent', () => {
    for (const bad of ['', 'walk-in', `${CUSTOMER} `]) {
      expect(() => planCreditSale({ customerId: bad, form: form(), lines: [line('1', '1')], ids: mintCreditSaleIds(counter().mint) })).toThrow(/customer/);
    }
  });

  it('the pay-by date: ON the sale date is allowed, one day before is refused, across a month, a year end and a leap day', () => {
    const lines = [line('1', '1')];
    const ok = (documentDate: string, dueDate: string): boolean => planner(form({ documentDate, dueDate }), lines)(mintCreditSaleIds(counter().mint)).ok;
    // Day zero: the same day is a term of zero days, and the schema admits it (`dueDate >= documentDate`).
    expect(ok('2026-11-14', '2026-11-14')).toBe(true);
    expect(ok('2026-11-14', '2026-11-13')).toBe(false);
    expect(ok('2026-11-14', '2026-11-15')).toBe(true);
    // 30/31-day months and the first and last day of a month.
    expect(ok('2026-10-31', '2026-11-01')).toBe(true);
    expect(ok('2026-11-01', '2026-10-31')).toBe(false);
    expect(ok('2026-11-30', '2026-11-30')).toBe(true);
    // Year end.
    expect(ok('2026-12-31', '2027-01-01')).toBe(true);
    expect(ok('2027-01-01', '2026-12-31')).toBe(false);
    // Leap day: real in 2028, not a date in 2027.
    expect(ok('2028-02-28', '2028-02-29')).toBe(true);
    expect(ok('2028-02-29', '2028-02-28')).toBe(false);
    expect(ok('2027-02-28', '2027-02-29')).toBe(false);
    // Not a calendar day at all.
    expect(ok('2026-11-14', '2026-11-31')).toBe(false);
    expect(ok('2026-13-01', '2026-13-02')).toBe(false);
    const refused = planner(form({ dueDate: '2026-11-13' }), lines)(mintCreditSaleIds(counter().mint));
    expect(refused).toMatchObject({ ok: false, errors: { dueDate: true } });
  });

  it('refuses, without sending, no warehouse, no sale date, no line, too many lines, and a quantity the unit does not allow', () => {
    const ids = () => mintCreditSaleIds(counter().mint);
    expect(planner(form({ warehouseId: '' }), [line('1', '1')])(ids())).toMatchObject({ ok: false, errors: { warehouse: true } });
    expect(planner(form({ documentDate: '' }), [line('1', '1')])(ids())).toMatchObject({ ok: false, errors: { date: true } });
    expect(planner(form(), [])(ids())).toMatchObject({ ok: false, errors: { lines: true } });
    const many = Array.from({ length: MAX_SALE_LINES + 1 }, (_, i) => line(String(i + 1), '1'));
    expect(planner(form(), many)(ids())).toMatchObject({ ok: false, errors: { tooMany: true } });
    expect(planner(form(), many.slice(0, MAX_SALE_LINES))(ids()).ok).toBe(true);
    const zero = planner(form(), [line('1', '0'), line('2', '1.25', 1), line('3', '2')])(ids());
    expect(zero).toMatchObject({ ok: false, lineErrors: { 'line-1': 'stock.line.quantityZero', 'line-2': 'stock.line.quantityInvalid' } });
    if (zero.ok) throw new Error('unreachable');
    expect(zero.lineErrors['line-3']).toBeUndefined();
  });

  it('a typed quantity is sent as Western-digit text, exactly as typed', () => {
    const body = planOk(planner(form(), [line('1', '١٢'), line('2', '0.75', 2)]));
    expect(body.lines.map((l) => l.quantity)).toEqual(['12', '0.75']);
  });
});

describe('createCreditSaleFlow — one set of ids per form', () => {
  it('mints the sale id and each line id once; a retry and an edited resend carry the same ones', async () => {
    const ids = counter();
    const sent: CreditSaleRequestDto[] = [];
    let call = 0;
    const flow = createCreditSaleFlow({
      mint: ids.mint,
      send: (body) => {
        sent.push(body);
        call += 1;
        return call === 1 ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(saleFor(body, true));
      },
      readStored: () => Promise.reject(new Error('not read')),
    });
    const atCreation = ids.count();
    expect(atCreation).toBe(1);

    const first = await flow.submit(planner(form(), [line('1', '2')]));
    expect(first).toEqual({ kind: 'refused', errorKey: FALLBACK_ERROR_KEY });
    const second = await flow.submit(planner(form(), [line('1', '3')]));
    expect(sent).toHaveLength(2);
    expect(sent[1]?.saleId).toBe(sent[0]?.saleId);
    expect(sent[1]?.saleId).toBe(flow.ids.saleId);
    expect(sent[1]?.lines[0]?.lineId).toBe(sent[0]?.lines[0]?.lineId);
    // One id at creation and one for the one line, then nothing more however often it is sent.
    expect(ids.count()).toBe(atCreation + 1);
    expect(second).toMatchObject({ kind: 'saved' });
  });

  it('a double click sends once', async () => {
    const sent: CreditSaleRequestDto[] = [];
    let release: (sale: SaleDto) => void = () => undefined;
    const flow = createCreditSaleFlow({
      mint: counter().mint,
      send: (body) => {
        sent.push(body);
        return new Promise<SaleDto>((resolve) => {
          release = resolve;
        });
      },
      readStored: () => Promise.reject(new Error('not read')),
    });
    const first = flow.submit(planner(form(), [line('1', '1')]));
    const second = flow.submit(planner(form(), [line('1', '1')]));
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    release(saleFor(sent[0] as CreditSaleRequestDto, false));
    expect(await first).toMatchObject({ kind: 'saved' });
    expect(sent).toHaveLength(1);
  });

  it('an invalid form sends nothing', async () => {
    const sent: CreditSaleRequestDto[] = [];
    const flow = createCreditSaleFlow({
      mint: counter().mint,
      send: (b) => (sent.push(b), Promise.resolve(saleFor(b, false))),
      readStored: () => Promise.reject(new Error('x')),
    });
    expect(await flow.submit(planner(form(), []))).toMatchObject({ kind: 'invalid', errors: { lines: true } });
    expect(sent).toEqual([]);
  });

  it('already stored under this id: the stored sale is read by the SAME id and shown, never a new form', async () => {
    const reads: string[] = [];
    let stored: SaleDto | null = null;
    const flow = createCreditSaleFlow({
      mint: counter().mint,
      send: (body) => {
        stored = saleFor(body, false);
        return Promise.reject(CONFLICT);
      },
      readStored: (saleId) => {
        reads.push(saleId);
        if (stored === null) throw new Error('nothing stored');
        return Promise.resolve(stored);
      },
    });
    const outcome = await flow.submit(planner(form(), [line('1', '4')]));
    expect(reads).toEqual([flow.ids.saleId]);
    expect(outcome).toEqual({ kind: 'alreadySaved', sale: stored });
    if (outcome === null) throw new Error('not sent');
    const after = afterOutcome(screen(form(), [line('1', '4')]), outcome);
    expect(after.stored).toEqual(stored);
    expect(after.errorKey).toBeNull();
    expect(after.result).toBeNull();
    expect(ALREADY_STORED_CODE).toBe('sale.idempotency_conflict');
  });

  it('when the stored sale cannot be read, it says so and offers only reading it again', async () => {
    const reads: string[] = [];
    const flow = createCreditSaleFlow({
      mint: counter().mint,
      send: () => Promise.reject(CONFLICT),
      readStored: (id) => (reads.push(id), Promise.reject(new TypeError('Failed to fetch'))),
    });
    const outcome = await flow.submit(planner(form(), [line('1', '1')]));
    expect(outcome).toEqual({ kind: 'storedUnread' });
    if (outcome === null) throw new Error('not sent');
    const after = afterOutcome(screen(form(), [line('1', '1')]), outcome);
    expect(after.storedUnread).toBe(true);
    expect(after.errorKey).toBe(STORED_UNREADABLE_KEY);
    const again = await flow.rereadStored();
    expect(again).toEqual({ kind: 'storedUnread' });
    expect(reads).toEqual([flow.ids.saleId, flow.ids.saleId]);
  });

  it('a refusal changes the refusal text and nothing typed', async () => {
    const flow = createCreditSaleFlow({ mint: counter().mint, send: () => Promise.reject(NOT_PERMITTED), readStored: () => Promise.reject(new Error('x')) });
    const typed = [line('1', '7')];
    const before = beforeSend({ ...screen(form({ dueDate: '2026-12-01' }), typed), busy: false });
    expect(before.busy).toBe(true);
    const outcome = await flow.submit(planner(before.form, before.lines));
    if (outcome === null) throw new Error('not sent');
    const after = afterOutcome(before, outcome);
    expect(after.errorKey).toBe('sales.credit.refusedNotPermitted');
    expect(after.busy).toBe(false);
    expect(after.form).toEqual(before.form);
    expect(after.lines).toEqual(typed);
    expect(after.result).toBeNull();
  });
});

describe('creditSaleRefusalKey — the text a refusal on THIS screen shows', () => {
  it('names the credit-sale refusals the shared catalogue leaves to the fallback, and the basket-worded one in this screen’s words', () => {
    expect(creditSaleRefusalKey(NOT_PERMITTED)).toBe('sales.credit.refusedNotPermitted');
    expect(creditSaleRefusalKey(new ApiError(409, 'CONFLICT', { sellingCode: 'sale.customer_inactive' }))).toBe('sales.credit.refusedInactive');
    expect(creditSaleRefusalKey(new ApiError(404, 'NOT_FOUND', { sellingCode: 'sale.customer_not_found' }))).toBe('sales.credit.refusedNotFound');
    expect(creditSaleRefusalKey(CHANGED)).toBe('sales.credit.refusedChanged');
    expect(creditSaleRefusalKey(new ApiError(422, 'VALIDATION_FAILED', { sellingCode: 'sale.currency_unknown' }))).toBe('sales.credit.refusedCurrency');
    expect(creditSaleRefusalKey(new ApiError(422, 'VALIDATION_FAILED', { sellingCode: 'sale.fx_rate_missing' }))).toBe('sales.credit.refusedRate');
  });

  it('every other answer is the shared mapping: the domain key when keyed, then the envelope, then the fallback', () => {
    expect(creditSaleRefusalKey(new ApiError(422, 'VALIDATION_FAILED', { sellingCode: 'sale.product_not_priced' }))).toBe('error.sale.product_not_priced');
    expect(creditSaleRefusalKey(new ApiError(403, 'FORBIDDEN'))).toBe('error.FORBIDDEN');
    expect(creditSaleRefusalKey(new ApiError(500, 'INTERNAL_ERROR'))).toBe('error.INTERNAL_ERROR');
    expect(creditSaleRefusalKey(new TypeError('Failed to fetch'))).toBe(FALLBACK_ERROR_KEY);
    // The idempotency conflict is never shown as text: the flow reads the stored sale instead.
    expect(Object.keys(CREDIT_SALE_REFUSAL_KEYS)).not.toContain(ALREADY_STORED_CODE);
  });
});

describe('createSubmitGuard', () => {
  it('runs one send at a time and frees itself when the send settles, even on a refusal', async () => {
    const guard = createSubmitGuard();
    const first = guard.run(() => Promise.reject(new Error('refused')));
    expect(guard.busy).toBe(true);
    expect(guard.run(() => Promise.resolve(1))).toBeNull();
    await expect(first).rejects.toThrow('refused');
    expect(guard.busy).toBe(false);
    expect(await guard.run(() => Promise.resolve(2))).toBe(2);
  });
});
