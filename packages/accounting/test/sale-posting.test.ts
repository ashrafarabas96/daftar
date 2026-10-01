/**
 * P4-S2: the accounting truth of a sale, asserted by exact amount.
 *
 * Every expected figure in this file is written out as an integer literal.
 * "The revenue equals the total" is not an assertion — it is the same
 * arithmetic the code under test performs, restated, and it passes when both
 * are wrong. So the two worked sales below carry their journals line for
 * line, in minor units, computed by hand from `0040`'s chart and
 * `0043:208-245`'s conversion law.
 *
 * Each describe block that could lose its subject carries a NON-VACUITY
 * CANARY: an assertion that fails if the block is asserting over nothing.
 * A deferred validator that reads zero rows and passes is the worst failure
 * mode available in this slice (`TL-P4-S1-C2`), and a unit test that iterates
 * an empty array is the same mistake in TypeScript.
 */
import { describe, expect, it } from 'vitest';
import { AccountingError } from '../src/errors';
import { DOMAIN_REVERSIBLE_SOURCE_TYPES, DOMAIN_SOURCE_TYPES } from '../src/post';
import {
  assertSalesTaxStructurallyZero,
  computeSaleCogsFingerprint,
  computeSaleInvoiceFingerprint,
  deriveSaleCogsEntryLines,
  deriveSaleCommitPostings,
  deriveSaleInvoiceBaseShares,
  deriveSaleInvoiceEntryLines,
  INVOICE_SOURCE_TYPE,
  mintSaleCommitAssertions,
  SALE_BASE_SPLIT_AGREEMENT_VECTORS,
  SALE_BASE_SPLIT_DRIFT_VECTOR,
  SALE_SETTLEMENT_SYSTEM_KEYS,
  SALE_SOURCE_TYPE,
  saleInvoiceDebitAccount,
  splitBaseByLargestRemainder,
  type SaleCogsFacts,
  type SaleInvoiceFacts,
} from '../src/sale-posting';
import type { AccountingAssertionClaims } from '../src/assertion';
import type { AccountingAssertionMinter } from '../src/ports';
import type { PostingLineCommand } from '../src/types';

const TENANT = '11111111-1111-4111-8111-111111111111';
const BUSINESS = '22222222-2222-4222-8222-222222222222';
const BRANCH = '33333333-3333-4333-8333-333333333333';
const WAREHOUSE = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '55555555-5555-4555-8555-555555555555';
const INVOICE_ID = '66666666-6666-4666-8666-666666666666';
const SALE_ID = '77777777-7777-4777-8777-777777777777';
const ACTOR = '88888888-8888-4888-8888-888888888888';

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
    return 'accepted';
  } catch (e) {
    return e instanceof AccountingError ? e.code : `unexpected:${String(e)}`;
  }
};

const minterSpy = (): { minter: AccountingAssertionMinter; claims: AccountingAssertionClaims[] } => {
  const claims: AccountingAssertionClaims[] = [];
  return {
    claims,
    minter: {
      mint(c) {
        claims.push(c);
        return `v1.k.${c.actorUserId}.${c.tenantId}.${c.businessId}.${c.operationKind}.${c.sourceType}.${c.sourceId}.${c.postingFingerprint}`;
      },
    },
  };
};

/**
 * ── The worked cash sale ─────────────────────────────────────────────────
 *
 * Base currency USD (2 minor units), transaction currency USD, so the rate is
 * the base sentinel and `total_base_minor = total_txn_minor`. This is the POS
 * case and the one P4-C budgets.
 *
 *   line 1  3 × 12.50  gross 3750  line discount 250  net 3500
 *   line 2  1 ×  9.99  gross  999  line discount   0  net  999
 *
 *   subtotal_txn_minor  = 3750 + 999 = 4749
 *   discount_txn_minor  =  250
 *   tax_minor           =    0   (structurally; OD-03 is OPEN)
 *   total_txn_minor     = 4749 − 250 + 0 = 4499 = 3500 + 999
 *   total_base_minor    = 4499
 */
const CASH_SALE: SaleInvoiceFacts = {
  tenantId: TENANT,
  businessId: BUSINESS,
  invoiceId: INVOICE_ID,
  issueDate: '2026-10-01',
  branchId: BRANCH,
  customerId: null,
  settlementKind: 'cash',
  settlementAccount: { kind: 'system', systemKey: 'cash' },
  currencyCode: 'USD',
  baseCurrency: 'USD',
  subtotalTxnMinor: 4749n,
  discountTxnMinor: 250n,
  taxMinor: 0n,
  totalTxnMinor: 4499n,
  totalBaseMinor: 4499n,
  fx: { sourceToBaseRate: '1.0000000000', rateSource: 'base', rateTimestamp: new Date('2026-10-01T00:00:00Z') },
  lines: [
    { lineNo: 1, netTxnMinor: 3500n, taxMinor: 0n },
    { lineNo: 2, netTxnMinor: 999n, taxMinor: 0n },
  ],
};

/**
 * ── The worked credit sale ───────────────────────────────────────────────
 *
 * The same basket sold on account to a named customer, invoiced in EUR while
 * the business keeps books in USD at `1.0850000000`. The rate exists to make
 * the one rounding visible:
 *
 *   total_base_minor = HALF_EVEN(4499 × 1.085) = HALF_EVEN(4881.415) = 4881
 */
const CREDIT_SALE: SaleInvoiceFacts = {
  ...CASH_SALE,
  customerId: CUSTOMER,
  settlementKind: 'credit',
  settlementAccount: null,
  currencyCode: 'EUR',
  totalBaseMinor: 4881n,
  fx: { sourceToBaseRate: '1.0850000000', rateSource: 'manual', rateTimestamp: new Date('2026-10-01T08:30:00Z') },
};

/**
 * ── The COGS facts ──────────────────────────────────────────────────────
 *
 * The two movements the stock writer wrote, as IT returned them. Line 1's
 * three units came off a key averaging 4.00 → −1200. Line 2's single unit
 * emptied its key, so the routine took the key's stored valuation exactly
 * (`0060:389`) → −333, a number no `qty × avg` recomputation reproduces.
 *
 *   Σ value_delta_base_minor = −1533, so COGS = 1533
 */
const COGS: SaleCogsFacts = {
  tenantId: TENANT,
  businessId: BUSINESS,
  saleId: SALE_ID,
  soldOn: '2026-10-01',
  branchId: BRANCH,
  warehouseId: WAREHOUSE,
  baseCurrency: 'USD',
  movements: [
    { sourceLineId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', valueDeltaBaseMinor: -1200n },
    { sourceLineId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', valueDeltaBaseMinor: -333n },
  ],
};

/** A journal line as a comparable tuple, so an assertion names every field. */
const shape = (l: PostingLineCommand): string =>
  [
    l.account.kind === 'system' ? l.account.systemKey : `code:${l.account.code}`,
    l.side,
    l.baseAmountMinor.toString(),
    l.baseCurrency,
    l.txnAmountMinor.toString(),
    l.txnCurrency,
    l.fxRate,
    l.fxRateSource,
    l.fxRateAt.toISOString(),
    l.warehouseId ?? '-',
    l.branchId ?? '-',
  ].join('|');

describe('P4-S2: the revenue entry of a CASH sale — source type `invoice`', () => {
  it('is exactly Dr cash 4499 / Cr sales_revenue 4499, in USD at the base sentinel, with no tax line and no AR line', () => {
    const lines = deriveSaleInvoiceEntryLines(CASH_SALE);
    expect(lines.map(shape)).toEqual([
      `cash|D|4499|USD|4499|USD|1.0000000000|base|2026-10-01T00:00:00.000Z|-|${BRANCH}`,
      `sales_revenue|C|4499|USD|4499|USD|1.0000000000|base|2026-10-01T00:00:00.000Z|-|${BRANCH}`,
    ]);
    // The revenue account is 4000 (`sales_revenue`), never 4100
    // (`sales_returns`, which is P4-S5's). The engine names the key, so this
    // asserts the key and the chart pins the code.
    expect(lines[1]?.account).toEqual({ kind: 'system', systemKey: 'sales_revenue' });
    // Two lines, and neither is `tax_payable`, `rounding` or `discounts`.
    expect(lines).toHaveLength(2);
    for (const forbidden of ['tax_payable', 'rounding', 'discounts', 'sales_returns', 'accounts_receivable']) {
      expect(lines.map((l) => shape(l)).join(' ')).not.toContain(forbidden);
    }
  });

  it('balances in base with no residue, because both lines carry one transaction amount at one rate (P4-AL-19)', () => {
    const lines = deriveSaleInvoiceEntryLines(CASH_SALE);
    const debit = lines.filter((l) => l.side === 'D').reduce((a, l) => a + l.baseAmountMinor, 0n);
    const credit = lines.filter((l) => l.side === 'C').reduce((a, l) => a + l.baseAmountMinor, 0n);
    expect(debit).toBe(4499n);
    expect(credit).toBe(4499n);
    expect(debit - credit).toBe(0n);
  });

  it('admits exactly the five settlement accounts a till may take money into, and refuses every other system key', () => {
    // NON-VACUITY CANARY: five keys, and the loop below has five subjects.
    expect(SALE_SETTLEMENT_SYSTEM_KEYS).toHaveLength(5);
    for (const systemKey of SALE_SETTLEMENT_SYSTEM_KEYS) {
      expect(saleInvoiceDebitAccount({ settlementKind: 'cash', settlementAccount: { kind: 'system', systemKey }, customerId: null })).toEqual({
        kind: 'system',
        systemKey,
      });
    }
    for (const systemKey of ['sales_revenue', 'accounts_receivable', 'inventory', 'cogs', 'rounding', 'tax_payable', 'opening_equity']) {
      expect(codeOf(() => saleInvoiceDebitAccount({ settlementKind: 'cash', settlementAccount: { kind: 'system', systemKey }, customerId: null }))).toBe(
        'accounting.payload_invalid',
      );
    }
    // A business-defined posting account with no system key is admitted: it is
    // the `payment_methods.posting_account_id` shape `supplier_payments`
    // already uses, and the database checks its eligibility.
    expect(saleInvoiceDebitAccount({ settlementKind: 'cash', settlementAccount: { kind: 'code', code: '1001' }, customerId: null })).toEqual({
      kind: 'code',
      code: '1001',
    });
    expect(codeOf(() => saleInvoiceDebitAccount({ settlementKind: 'cash', settlementAccount: null, customerId: null }))).toBe('accounting.payload_invalid');
  });
});

describe('P4-S2: the revenue entry of a CREDIT sale — source type `invoice`', () => {
  it('is exactly Dr accounts_receivable 4881 base / 4499 EUR and Cr sales_revenue 4881 base / 4499 EUR, at the invoice own snapshot', () => {
    const lines = deriveSaleInvoiceEntryLines(CREDIT_SALE);
    expect(lines.map(shape)).toEqual([
      `accounts_receivable|D|4881|USD|4499|EUR|1.0850000000|manual|2026-10-01T08:30:00.000Z|-|${BRANCH}`,
      `sales_revenue|C|4881|USD|4499|EUR|1.0850000000|manual|2026-10-01T08:30:00.000Z|-|${BRANCH}`,
    ]);
    // The historical snapshot is carried, never recomputed: the rate, its
    // source and its instant are the invoice's own.
    expect(lines.every((l) => l.fxRate === '1.0850000000' && l.fxRateSource === 'manual')).toBe(true);
  });

  it('refuses a credit sale with no customer, because a receivable behind nobody is what `invoices_walkin_no_ar` exists to refuse', () => {
    expect(codeOf(() => deriveSaleInvoiceEntryLines({ ...CREDIT_SALE, customerId: null }))).toBe('accounting.payload_invalid');
  });

  it('refuses a credit sale that also names a settlement account, so one invoice cannot claim both shapes', () => {
    expect(codeOf(() => deriveSaleInvoiceEntryLines({ ...CREDIT_SALE, settlementAccount: { kind: 'system', systemKey: 'cash' } }))).toBe(
      'accounting.payload_invalid',
    );
  });

  it('refuses an invoice whose total is not its subtotal less discount plus tax, or whose lines do not sum to its total', () => {
    expect(codeOf(() => deriveSaleInvoiceEntryLines({ ...CREDIT_SALE, totalTxnMinor: 4500n }))).toBe('accounting.payload_invalid');
    expect(codeOf(() => deriveSaleInvoiceEntryLines({ ...CREDIT_SALE, lines: [{ lineNo: 1, netTxnMinor: 4498n, taxMinor: 0n }] }))).toBe(
      'accounting.payload_invalid',
    );
    expect(codeOf(() => deriveSaleInvoiceEntryLines({ ...CREDIT_SALE, lines: [] }))).toBe('accounting.payload_invalid');
    expect(codeOf(() => deriveSaleInvoiceEntryLines({ ...CREDIT_SALE, discountTxnMinor: 5000n, subtotalTxnMinor: 4749n }))).toBe('accounting.payload_invalid');
  });
});

describe('P4-S2: the COGS entry — source type `sale`', () => {
  it('is exactly Dr cogs 1533 / Cr inventory 1533, base only, carrying the sale warehouse and branch on both lines', () => {
    const lines = deriveSaleCogsEntryLines(COGS);
    expect(lines.map(shape)).toEqual([
      `cogs|D|1533|USD|1533|USD|1.0000000000|base|2026-10-01T00:00:00.000Z|${WAREHOUSE}|${BRANCH}`,
      `inventory|C|1533|USD|1533|USD|1.0000000000|base|2026-10-01T00:00:00.000Z|${WAREHOUSE}|${BRANCH}`,
    ]);
  });

  it('is the SUM OF THE STORED INTEGERS and nothing else: no quantity, no average cost, and no second rounding', () => {
    // NON-VACUITY CANARY: the fixture must actually carry two movements whose
    // values differ, or "the sum of the stored integers" has no subject.
    expect(COGS.movements).toHaveLength(2);
    expect(new Set(COGS.movements.map((m) => m.valueDeltaBaseMinor)).size).toBe(2);
    expect(COGS.movements.reduce((a, m) => a + m.valueDeltaBaseMinor, 0n)).toBe(-1533n);
    expect(deriveSaleCogsEntryLines(COGS)[0]?.baseAmountMinor).toBe(1533n);

    // One movement more, one base minor unit more, with no other input
    // changed: the amount tracks the stored deltas exactly.
    const plusOne = deriveSaleCogsEntryLines({
      ...COGS,
      movements: [...COGS.movements, { sourceLineId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', valueDeltaBaseMinor: -1n }],
    });
    expect(plusOne[0]?.baseAmountMinor).toBe(1534n);
    expect(plusOne[1]?.baseAmountMinor).toBe(1534n);

    // `line 2` emptied its key, so its stored value is the key's exact
    // valuation. 333 base minor units over one unit of stock is an average of
    // 3.33; a recomputation from a ROUNDED average of a three-unit line would
    // not reproduce 1200 either. The module takes neither path: the shape has
    // no quantity field at all, which is the structural half of the claim.
    expect(Object.keys(COGS.movements[0] ?? {}).sort()).toEqual(['sourceLineId', 'valueDeltaBaseMinor']);
  });

  it('refuses a positive movement value, because a sale releases stock and never adds it', () => {
    expect(codeOf(() => deriveSaleCogsEntryLines({ ...COGS, movements: [{ sourceLineId: 'x', valueDeltaBaseMinor: 5n }] }))).toBe('accounting.payload_invalid');
  });

  it('refuses a sale with no movements and a sale whose released value is zero, rather than posting a zero entry', () => {
    expect(codeOf(() => deriveSaleCogsEntryLines({ ...COGS, movements: [] }))).toBe('accounting.payload_invalid');
    expect(codeOf(() => deriveSaleCogsEntryLines({ ...COGS, movements: [{ sourceLineId: 'x', valueDeltaBaseMinor: 0n }] }))).toBe('accounting.payload_invalid');
  });
});

describe('P4-S2: rounding is not additive, so the second rounding is DELETED', () => {
  it('splits the one converted base total over the rows exactly: Σ base_share_minor = total_base_minor', () => {
    const shares = deriveSaleInvoiceBaseShares(CREDIT_SALE);
    expect(shares).toEqual([3797n, 1084n]);
    expect(shares.reduce((a, b) => a + b, 0n)).toBe(4881n);
    expect(shares.reduce((a, b) => a + b, 0n)).toBe(CREDIT_SALE.totalBaseMinor);
    // The domestic case is the degenerate one and must still be exact.
    expect(deriveSaleInvoiceBaseShares(CASH_SALE)).toEqual([3500n, 999n]);
    expect(deriveSaleInvoiceBaseShares(CASH_SALE).reduce((a, b) => a + b, 0n)).toBe(4499n);
  });

  it('a SECOND per-row HALF_EVEN conversion would post one base minor unit of revenue that does not exist', () => {
    const v = SALE_BASE_SPLIT_DRIFT_VECTOR;
    // NON-VACUITY CANARY: this test is about a DISAGREEMENT, so the two
    // vectors must actually disagree. If they ever stop disagreeing, the
    // vector has lost its subject and this test must fail loudly rather than
    // pass because there is nothing left to compare.
    expect(v.split).not.toEqual(v.perRowHalfEven);
    expect(v.split.reduce((a, b) => a + b, 0n)).toBe(v.totalBaseMinor);
    expect(v.perRowHalfEven.reduce((a, b) => a + b, 0n)).toBe(v.totalBaseMinor + v.driftBaseMinor);
    expect(v.driftBaseMinor).toBe(1n);
    // And the code under test is on the exact side.
    expect(splitBaseByLargestRemainder(v.totalBaseMinor, v.lineTxnMinor)).toEqual([...v.split]);
    // `0043:208-245` forces each journal line's base to be the HALF_EVEN
    // conversion of its own transaction amount, so the entry's two lines can
    // only ever carry 4881. A per-row revenue posting summing to 4882 could
    // not balance against them at all: the drift is not a tolerance, it is
    // unpostable.
    expect(deriveSaleInvoiceEntryLines(CREDIT_SALE).map((l) => l.baseAmountMinor)).toEqual([v.totalBaseMinor, v.totalBaseMinor]);
  });

  it('agrees with the purchase receipt split (`packages/inventory/src/allocation.ts`) on every pinned vector', () => {
    // NON-VACUITY CANARY: the vectors are the whole subject.
    expect(SALE_BASE_SPLIT_AGREEMENT_VECTORS.length).toBeGreaterThanOrEqual(6);
    for (const v of SALE_BASE_SPLIT_AGREEMENT_VECTORS) {
      expect(splitBaseByLargestRemainder(v.total, v.weights), JSON.stringify({ total: String(v.total) })).toEqual([...v.shares]);
      expect(splitBaseByLargestRemainder(v.total, v.weights).reduce((a, b) => a + b, 0n)).toBe(v.total);
    }
  });

  it('refuses a split over no lines, and a non-zero total over weights that sum to zero', () => {
    expect(codeOf(() => splitBaseByLargestRemainder(100n, []))).toBe('accounting.payload_invalid');
    expect(codeOf(() => splitBaseByLargestRemainder(100n, [0n, 0n]))).toBe('accounting.payload_invalid');
    expect(splitBaseByLargestRemainder(0n, [0n, 0n])).toEqual([0n, 0n]);
  });
});

describe('P4-S2: tax is structurally zero and a non-zero tax is REFUSED (OD-03 stays open)', () => {
  it('refuses a non-zero header tax and a non-zero line tax, under one stable code, with no rate anywhere', () => {
    expect(codeOf(() => assertSalesTaxStructurallyZero({ taxMinor: 1n, lines: [] }))).toBe('accounting.sales_tax_unsupported');
    expect(codeOf(() => assertSalesTaxStructurallyZero({ taxMinor: 0n, lines: [{ lineNo: 1, netTxnMinor: 1n, taxMinor: 1n }] }))).toBe(
      'accounting.sales_tax_unsupported',
    );
    expect(codeOf(() => assertSalesTaxStructurallyZero({ taxMinor: 0n, lines: CASH_SALE.lines }))).toBe('accepted');
    // The refusal reaches the shape, not only the helper.
    expect(codeOf(() => deriveSaleInvoiceEntryLines({ ...CASH_SALE, taxMinor: 1n, totalTxnMinor: 4500n }))).toBe('accounting.sales_tax_unsupported');
    // R-SAL-05's identity: tax payable = Σ line tax = 0. Zero, so no line.
    expect(CASH_SALE.lines.reduce((a, l) => a + l.taxMinor, 0n)).toBe(0n);
    expect(deriveSaleInvoiceEntryLines(CASH_SALE).map(shape).join(' ')).not.toContain('tax_payable');
  });
});

describe('P4-S2: the two postings of one commit, and the authority they spend', () => {
  it('derives the COGS posting first and the revenue posting second, each at its own source identity', () => {
    const p = deriveSaleCommitPostings(CASH_SALE, COGS);
    expect([p.cogs.sourceType, p.revenue.sourceType]).toEqual([SALE_SOURCE_TYPE, INVOICE_SOURCE_TYPE]);
    expect([p.cogs.sourceId, p.revenue.sourceId]).toEqual([SALE_ID, INVOICE_ID]);
    expect([p.cogs.entryDate, p.revenue.entryDate]).toEqual(['2026-10-01', '2026-10-01']);
    expect(p.cogs.lines.map((l) => l.baseAmountMinor)).toEqual([1533n, 1533n]);
    expect(p.revenue.lines.map((l) => l.baseAmountMinor)).toEqual([4499n, 4499n]);
    expect(p.baseShares).toEqual([3500n, 999n]);
    // Two entries, not one: `accounting_reversals.id = original_entry_id`
    // gives one whole-entry reversal per entry for ever, and a single entry
    // would make "reverse the revenue, leave the inventory" unexpressible.
    expect(p.cogs.sourceId).not.toBe(p.revenue.sourceId);
    expect(p.cogs.fingerprint).not.toBe(p.revenue.fingerprint);
  });

  it('refuses a commit whose two halves disagree about the business, the date or the branch', () => {
    expect(codeOf(() => deriveSaleCommitPostings(CASH_SALE, { ...COGS, businessId: TENANT }))).toBe('accounting.payload_invalid');
    expect(codeOf(() => deriveSaleCommitPostings(CASH_SALE, { ...COGS, soldOn: '2026-09-30' }))).toBe('accounting.payload_invalid');
    expect(codeOf(() => deriveSaleCommitPostings(CASH_SALE, { ...COGS, branchId: WAREHOUSE }))).toBe('accounting.payload_invalid');
  });

  it('mints two `post` assertions in posting order, each over the fingerprint of the lines it authorizes', () => {
    const p = deriveSaleCommitPostings(CREDIT_SALE, COGS);
    const { minter, claims } = minterSpy();
    const assertions = mintSaleCommitAssertions(minter, p, CREDIT_SALE, ACTOR);
    expect(assertions).toHaveLength(2);
    expect(claims.map((c) => [c.sourceType, c.sourceId, c.operationKind])).toEqual([
      [SALE_SOURCE_TYPE, SALE_ID, 'post'],
      [INVOICE_SOURCE_TYPE, INVOICE_ID, 'post'],
    ]);
    expect(claims.map((c) => c.postingFingerprint)).toEqual([p.cogs.fingerprint, p.revenue.fingerprint]);
    expect(claims.every((c) => c.tenantId === TENANT && c.businessId === BUSINESS && c.actorUserId === ACTOR)).toBe(true);
    // The fingerprint is over the LINES. One base minor unit different and the
    // authority is a different authority, which is what makes a stale COGS
    // prediction a refusal rather than a wrong entry.
    const tampered = deriveSaleCogsEntryLines({ ...COGS, movements: [{ sourceLineId: 'z', valueDeltaBaseMinor: -1534n }] });
    expect(computeSaleCogsFingerprint(COGS, tampered)).not.toBe(p.cogs.fingerprint);
    expect(computeSaleInvoiceFingerprint(CREDIT_SALE, deriveSaleInvoiceEntryLines(CASH_SALE))).not.toBe(p.revenue.fingerprint);
  });

  it('registers both source types as domain-owned and NEITHER as generically reversible', () => {
    // §2.2: the generic engine must refuse them, which is what membership of
    // DOMAIN_SOURCE_TYPES buys. A registered type absent from this list is a
    // type `AccountingEngine.post` would happily post.
    expect(DOMAIN_SOURCE_TYPES as readonly string[]).toContain(SALE_SOURCE_TYPE);
    expect(DOMAIN_SOURCE_TYPES as readonly string[]).toContain(INVOICE_SOURCE_TYPE);
    expect(DOMAIN_REVERSIBLE_SOURCE_TYPES as readonly string[]).not.toContain(SALE_SOURCE_TYPE);
    expect(DOMAIN_REVERSIBLE_SOURCE_TYPES as readonly string[]).not.toContain(INVOICE_SOURCE_TYPE);
    // NON-VACUITY CANARY: the names must be the ones the registry uses, or
    // the two assertions above are about strings nothing else knows.
    expect([SALE_SOURCE_TYPE, INVOICE_SOURCE_TYPE]).toEqual(['sale', 'invoice']);
  });
});
