import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../../helpers/test-app';
import { must, post, rate10, seedPostingFixture, todayIn, type PostCommand, type PostLine, type PostingFixture } from '../../helpers/accounting-posting';

/**
 * GOLDEN REGRESSION — ENGINE SHAPES (directive §70, execution plan §30/§33).
 *
 * Every worked journal in `docs/DAFTAR_ACCOUNTING_RULES.md` that does not need
 * an operational-domain table is posted THROUGH the real primitive and then
 * asserted LINE BY LINE: account code, account identity, side, debit, credit,
 * base amount, base currency, transaction amount, transaction currency, rate
 * and rate source. "The entry balances" is never the assertion — a balanced
 * entry made of the wrong accounts is exactly the defect GOLD-28 exists to
 * catch, and it balances perfectly.
 *
 * What this proves, and why it is worth a suite of its own: the posting engine
 * was built BEFORE sales, payments, refunds, suppliers and inventory exist. The
 * only way to know today that it can express their accounting tomorrow is to
 * express it today. Each shape below is therefore the future domain's journal,
 * posted with a `manual_adjustment` source identity standing in for the source
 * record that phase will create.
 *
 * What this does NOT do, and must never start doing (directive §71, §85): it
 * creates no invoice, payment, refund, credit-note, supplier or inventory
 * table, and the use of `manual_adjustment` here is an internal test identity,
 * not a merchant-facing manual-adjustment workflow. P2-S4 owns that.
 *
 * Base currency throughout is ILS, as the rules document's own cross-currency
 * examples assume.
 */

/** The instant every FX snapshot in this suite is taken at. */
const AT = new Date('2026-03-14T09:15:00Z');

/** A system account identity, as the closed registry in `0040` names it. */
type Key =
  | 'cash'
  | 'bank'
  | 'card_clearing'
  | 'accounts_receivable'
  | 'supplier_receivable'
  | 'inventory'
  | 'accounts_payable'
  | 'tax_payable'
  | 'customer_refund_liability'
  | 'customer_credit_liability'
  | 'sales_revenue'
  | 'sales_returns'
  | 'discounts'
  | 'fx_gain'
  | 'cogs'
  | 'purchase_price_variance'
  | 'fx_loss';

/**
 * The account code each identity must carry. Written out rather than read from
 * the registry on purpose: a golden that asks the database what it seeded and
 * then asserts the answer proves nothing. GOLD-28 wants the CODES.
 */
const CODE: Readonly<Record<Key, string>> = {
  cash: '1000',
  bank: '1010',
  card_clearing: '1020',
  accounts_receivable: '1100',
  supplier_receivable: '1150',
  inventory: '1200',
  accounts_payable: '2000',
  tax_payable: '2100',
  customer_refund_liability: '2200',
  customer_credit_liability: '2210',
  sales_revenue: '4000',
  sales_returns: '4100',
  discounts: '4200',
  fx_gain: '4900',
  cogs: '5000',
  purchase_price_variance: '6200',
  fx_loss: '6900',
};

/** A foreign leg: the amount actually transacted and the rate to the base. */
interface Foreign {
  readonly amount: number;
  readonly currency: 'USD' | 'EUR';
  readonly rate: string;
}

/**
 * One expected journal line, written in the rules document's own units: whole
 * ILS for the base amount, whole units of the foreign currency for the leg.
 * Every currency here has two minor units, so the conversion is a single ×100
 * in one place rather than a hundred hand-written zeroes no reviewer can check.
 */
interface Line {
  readonly account: Key;
  readonly side: 'D' | 'C';
  readonly base: number;
  readonly foreign?: Foreign;
}

interface Shape {
  /** The golden identity from the Phase 0 suite, where the rules give one. */
  readonly id: string;
  readonly title: string;
  readonly lines: readonly Line[];
}

const minor = (whole: number): bigint => BigInt(Math.round(whole * 100));

const command = (fx: PostingFixture, entryDate: string, shape: Shape): PostCommand => ({
  tenantId: fx.tenantId,
  businessId: fx.businessId,
  sourceType: 'manual_adjustment',
  sourceId: randomUUID(),
  entryDate,
  description: `${shape.id} ${shape.title}`,
  requestId: `golden-${shape.id.toLowerCase()}`,
  lines: shape.lines.map(
    (l): PostLine => ({
      account: { kind: 'system', systemKey: l.account },
      side: l.side,
      baseAmountMinor: minor(l.base),
      baseCurrency: 'ILS',
      txnAmountMinor: l.foreign === undefined ? minor(l.base) : minor(l.foreign.amount),
      txnCurrency: l.foreign === undefined ? 'ILS' : l.foreign.currency,
      fxRate: l.foreign === undefined ? '1' : l.foreign.rate,
      fxRateSource: l.foreign === undefined ? 'base' : 'manual',
      fxRateAt: AT,
      branchId: null,
      warehouseId: null,
    }),
  ),
});

interface PersistedLine {
  line_no: number;
  code: string;
  system_key: string;
  debit_minor: string;
  credit_minor: string;
  base_amount_minor: string;
  base_currency: string;
  txn_amount_minor: string;
  txn_currency: string;
  fx_rate: string;
  fx_rate_source: string;
}

const expected = (shape: Shape): PersistedLine[] =>
  shape.lines.map((l, i) => ({
    line_no: i + 1,
    code: CODE[l.account],
    system_key: l.account,
    debit_minor: l.side === 'D' ? minor(l.base).toString() : '0',
    credit_minor: l.side === 'C' ? minor(l.base).toString() : '0',
    base_amount_minor: minor(l.base).toString(),
    base_currency: 'ILS',
    txn_amount_minor: (l.foreign === undefined ? minor(l.base) : minor(l.foreign.amount)).toString(),
    txn_currency: l.foreign === undefined ? 'ILS' : l.foreign.currency,
    fx_rate: rate10(l.foreign === undefined ? '1' : l.foreign.rate),
    fx_rate_source: l.foreign === undefined ? 'base' : 'manual',
  }));

let fx: PostingFixture;
let today: string;

/**
 * Post the shape and return what the ledger actually holds, read back as the
 * schema owner so the assertion sees the stored row rather than the argument
 * the test passed in.
 */
async function postShape(shape: Shape): Promise<PersistedLine[]> {
  const c = command(fx, today, shape);
  const r = await post(c, fx.userId);
  expect(r.created, `${shape.id} was expected to create a new entry`).toBe(true);
  const rows = await ownerPool().query<PersistedLine>(
    `SELECT l.line_no, a.code, a.system_key,
            l.debit_minor::text, l.credit_minor::text, l.base_amount_minor::text, l.base_currency,
            l.txn_amount_minor::text, l.txn_currency, l.fx_rate::text, l.fx_rate_source
       FROM journal_lines l
       JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
      WHERE l.journal_entry_id = $1
      ORDER BY l.line_no`,
    [r.entryId],
  );
  return rows.rows;
}

/** Assert a shape literally, and — separately — that it balances. */
async function golden(shape: Shape): Promise<void> {
  expect(await postShape(shape)).toEqual(expected(shape));
  const debits = shape.lines.filter((l) => l.side === 'D').reduce((a, l) => a + minor(l.base), 0n);
  const credits = shape.lines.filter((l) => l.side === 'C').reduce((a, l) => a + minor(l.base), 0n);
  expect(debits, `${shape.id} does not balance`).toBe(credits);
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  fx = await seedPostingFixture(ownerPool(), 'golden-shapes');
  today = await todayIn(ownerPool(), 'Asia/Hebron');
});

describe('golden: engine shapes — sale and partial return (RULES §4.7, GOLD-28)', () => {
  it('the original cash sale: 990 cash, 100 discount, 1000 revenue, 90 tax', async () => {
    await golden({
      id: 'GOLD-28/1',
      title: 'original sale',
      lines: [
        { account: 'cash', side: 'D', base: 990 },
        { account: 'discounts', side: 'D', base: 100 },
        { account: 'sales_revenue', side: 'C', base: 1000 },
        { account: 'tax_payable', side: 'C', base: 90 },
      ],
    });
  });

  it('the cost of that sale: 600 out of inventory into COGS', async () => {
    await golden({
      id: 'GOLD-28/2',
      title: 'sale cost',
      lines: [
        { account: 'cogs', side: 'D', base: 600 },
        { account: 'inventory', side: 'C', base: 600 },
      ],
    });
  });

  it('the credit note reverses revenue ONCE: 500 returns, 45 tax, 50 discount back, 495 owed', async () => {
    await golden({
      id: 'GOLD-28/3',
      title: 'credit note',
      lines: [
        { account: 'sales_returns', side: 'D', base: 500 },
        { account: 'tax_payable', side: 'D', base: 45 },
        { account: 'discounts', side: 'C', base: 50 },
        { account: 'customer_refund_liability', side: 'C', base: 495 },
      ],
    });
  });

  it('the returned cost comes back at its snapshot, not at today’s average: 300', async () => {
    await golden({
      id: 'GOLD-28/4',
      title: 'returned cost',
      lines: [
        { account: 'inventory', side: 'D', base: 300 },
        { account: 'cogs', side: 'C', base: 300 },
      ],
    });
  });

  it('the refund is a cash settlement only — it does NOT touch revenue a second time', async () => {
    await golden({
      id: 'GOLD-28/5',
      title: 'refund settlement',
      lines: [
        { account: 'customer_refund_liability', side: 'D', base: 495 },
        { account: 'cash', side: 'C', base: 495 },
      ],
    });
  });
});

describe('golden: engine shapes — cross-currency refund (RULES §5.1, GOLD-50)', () => {
  it('releases the liability at its CARRYING value (100 USD @3.60 = 360) and books the 9 difference as realized loss', async () => {
    await golden({
      id: 'GOLD-50',
      title: 'cross-currency refund, loss direction',
      lines: [
        { account: 'customer_refund_liability', side: 'D', base: 360, foreign: { amount: 100, currency: 'USD', rate: '3.6' } },
        { account: 'fx_loss', side: 'D', base: 9 },
        { account: 'cash', side: 'C', base: 369, foreign: { amount: 90, currency: 'EUR', rate: '4.1' } },
      ],
    });
  });

  it('the opposite direction books a realized GAIN, on 4900, never on rounding', async () => {
    await golden({
      id: 'GOLD-50/reverse',
      title: 'cross-currency refund, gain direction',
      lines: [
        { account: 'customer_refund_liability', side: 'D', base: 360, foreign: { amount: 100, currency: 'USD', rate: '3.6' } },
        { account: 'cash', side: 'C', base: 350 },
        { account: 'fx_gain', side: 'C', base: 10 },
      ],
    });
  });
});

describe('golden: engine shapes — payment allocation reversal (RULES §5.2, GOLD-65/66/67)', () => {
  it('Example A reopens AR and owes the customer a credit — revenue is not touched', async () => {
    await golden({
      id: 'GOLD-65',
      title: 'reverse a wrongly allocated payment',
      lines: [
        { account: 'accounts_receivable', side: 'D', base: 300 },
        { account: 'customer_credit_liability', side: 'C', base: 300 },
      ],
    });
  });

  it('Example B reverses ONE allocation of a split payment: 200, not the payment’s 500', async () => {
    await golden({
      id: 'GOLD-66',
      title: 'partial reversal of a split payment',
      lines: [
        { account: 'accounts_receivable', side: 'D', base: 200 },
        { account: 'customer_credit_liability', side: 'C', base: 200 },
      ],
    });
  });

  it('Example C reverses at the ORIGINAL snapshots — AR 1440 @3.60, the original 40 gain undone, credit 1480 @4.00', async () => {
    await golden({
      id: 'GOLD-67',
      title: 'multi-currency allocation reversal',
      lines: [
        { account: 'accounts_receivable', side: 'D', base: 1440, foreign: { amount: 400, currency: 'USD', rate: '3.6' } },
        { account: 'fx_gain', side: 'D', base: 40 },
        { account: 'customer_credit_liability', side: 'C', base: 1480, foreign: { amount: 370, currency: 'EUR', rate: '4' } },
      ],
    });
  });
});

describe('golden: engine shapes — refunding a customer credit (RULES §5.2, GOLD-81/82)', () => {
  it('Case A consumes the whole credit: 370 EUR carried at 1480 paid out at 1554, 74 realized loss', async () => {
    await golden({
      id: 'GOLD-81',
      title: 'full same-currency refund of a customer credit',
      lines: [
        { account: 'customer_credit_liability', side: 'D', base: 1480, foreign: { amount: 370, currency: 'EUR', rate: '4' } },
        { account: 'fx_loss', side: 'D', base: 74 },
        { account: 'bank', side: 'C', base: 1554, foreign: { amount: 370, currency: 'EUR', rate: '4.2' } },
      ],
    });
  });

  it('Case B releases the carrying value PROPORTIONALLY: 350 of 370 releases 1400, not 1480', async () => {
    await golden({
      id: 'GOLD-82',
      title: 'partial same-currency refund of a customer credit',
      lines: [
        { account: 'customer_credit_liability', side: 'D', base: 1400, foreign: { amount: 350, currency: 'EUR', rate: '4' } },
        { account: 'fx_loss', side: 'D', base: 70 },
        { account: 'bank', side: 'C', base: 1470, foreign: { amount: 350, currency: 'EUR', rate: '4.2' } },
      ],
    });
  });
});

describe('golden: engine shapes — chargeback (RULES §5.2ب, GOLD-87)', () => {
  it('reverses the CASH ORIGIN, not into a customer credit: the money left the business', async () => {
    await golden({
      id: 'GOLD-87',
      title: 'card chargeback on an allocated payment',
      lines: [
        { account: 'accounts_receivable', side: 'D', base: 300 },
        { account: 'card_clearing', side: 'C', base: 300 },
      ],
    });
  });
});

describe('golden: engine shapes — tri-currency settlement (RULES §6)', () => {
  it('base ILS, invoice USD, payment EUR: 1480 in, 1440 of AR released, 40 realized gain', async () => {
    await golden({
      id: 'RULES-6',
      title: 'tri-currency settlement',
      lines: [
        { account: 'bank', side: 'D', base: 1480, foreign: { amount: 370, currency: 'EUR', rate: '4' } },
        { account: 'accounts_receivable', side: 'C', base: 1440, foreign: { amount: 400, currency: 'USD', rate: '3.6' } },
        { account: 'fx_gain', side: 'C', base: 40 },
      ],
    });
  });
});

describe('golden: engine shapes — void of a paid invoice (RULES §7)', () => {
  it('A/1 reverses the revenue of a fully paid cash invoice into a refund liability', async () => {
    await golden({
      id: 'RULES-7A/1',
      title: 'void, revenue reversal',
      lines: [
        { account: 'sales_returns', side: 'D', base: 1000 },
        { account: 'customer_refund_liability', side: 'C', base: 1000 },
      ],
    });
  });

  it('A/2 returns the cost to inventory', async () => {
    await golden({
      id: 'RULES-7A/2',
      title: 'void, cost reversal',
      lines: [
        { account: 'inventory', side: 'D', base: 600 },
        { account: 'cogs', side: 'C', base: 600 },
      ],
    });
  });

  it('A/3 settles the whole liability in cash, leaving cash, revenue and liability all net zero', async () => {
    await golden({
      id: 'RULES-7A/3',
      title: 'void, refund',
      lines: [
        { account: 'customer_refund_liability', side: 'D', base: 1000 },
        { account: 'cash', side: 'C', base: 1000 },
      ],
    });
  });

  it('B/1 splits the credit note between the unpaid 700 of AR and the paid 300 now owed back', async () => {
    await golden({
      id: 'RULES-7B/1',
      title: 'void of a partly paid credit invoice',
      lines: [
        { account: 'sales_returns', side: 'D', base: 1000 },
        { account: 'accounts_receivable', side: 'C', base: 700 },
        { account: 'customer_refund_liability', side: 'C', base: 300 },
      ],
    });
  });

  it('B/3 refunds only the 300 that was actually paid — the source is exhausted, so no double refund', async () => {
    await golden({
      id: 'RULES-7B/3',
      title: 'void of a partly paid credit invoice, refund',
      lines: [
        { account: 'customer_refund_liability', side: 'D', base: 300 },
        { account: 'cash', side: 'C', base: 300 },
      ],
    });
  });
});

describe('golden: engine shapes — supplier return and purchase price variance (RULES §9, GOLD-58/59/61/73)', () => {
  it('Case A extinguishes the open payable, releases inventory at CARRYING cost and books the 50 difference to PPV — never to rounding', async () => {
    await golden({
      id: 'RULES-9.1',
      title: 'supplier return against an open payable',
      lines: [
        { account: 'accounts_payable', side: 'D', base: 500 },
        { account: 'inventory', side: 'C', base: 450 },
        { account: 'purchase_price_variance', side: 'C', base: 50 },
      ],
    });
  });

  it('Case B with the purchase already paid raises a SUPPLIER RECEIVABLE (1150), never a silent debit on AP', async () => {
    await golden({
      id: 'GOLD-58/1',
      title: 'supplier credit note',
      lines: [
        { account: 'supplier_receivable', side: 'D', base: 500 },
        { account: 'inventory', side: 'C', base: 450 },
        { account: 'purchase_price_variance', side: 'C', base: 50 },
      ],
    });
  });

  it('and the supplier’s cash settles that receivable to exactly zero', async () => {
    await golden({
      id: 'GOLD-58/2',
      title: 'supplier cash refund',
      lines: [
        { account: 'bank', side: 'D', base: 500 },
        { account: 'supplier_receivable', side: 'C', base: 500 },
      ],
    });
  });

  it('the partly paid case splits the debit: 300 against the payable, 200 as the receivable surplus', async () => {
    await golden({
      id: 'GOLD-59',
      title: 'supplier return, partly paid purchase',
      lines: [
        { account: 'accounts_payable', side: 'D', base: 300 },
        { account: 'supplier_receivable', side: 'D', base: 200 },
        { account: 'inventory', side: 'C', base: 450 },
        { account: 'purchase_price_variance', side: 'C', base: 50 },
      ],
    });
  });

  it('allocating the credit to a future purchase moves it from 1150 to 2000 and touches no revenue', async () => {
    await golden({
      id: 'GOLD-61',
      title: 'supplier credit allocated to a later purchase',
      lines: [
        { account: 'accounts_payable', side: 'D', base: 500 },
        { account: 'supplier_receivable', side: 'C', base: 500 },
      ],
    });
  });

  it('the cross-currency supplier refund receives 369 against a 360 carrying value and books the 9 as a realized GAIN', async () => {
    await golden({
      id: 'GOLD-73',
      title: 'cross-currency supplier refund',
      lines: [
        { account: 'bank', side: 'D', base: 369, foreign: { amount: 90, currency: 'EUR', rate: '4.1' } },
        { account: 'supplier_receivable', side: 'C', base: 360, foreign: { amount: 100, currency: 'USD', rate: '3.6' } },
        { account: 'fx_gain', side: 'C', base: 9 },
      ],
    });
  });
});

describe('golden: engine shapes prove representability without creating the domains (directive §71, §85)', () => {
  /**
   * The claim is about the SHAPES posted above: every one of them was
   * expressed with the generic journal, and none of them caused an
   * operational domain to be invented to hold it.
   *
   * `accounting_periods` was on this list while no slice owned periods, and
   * it came off when P2-S6 built them under its own directive. That is the
   * difference the list is for: a table nobody authorized appearing because
   * a golden shape needed somewhere to live is the defect; a table an
   * authorized slice creates on purpose is not, and a permanent regression
   * that forbade its successor would stop the project. Nothing else moved,
   * and no shape above posts into a period.
   */
  it('not one operational table was created to express any of the shapes above', async () => {
    const forbidden = [
      'invoices',
      'payments',
      'payment_allocations',
      'payment_reversals',
      'refunds',
      'credit_notes',
      'customer_credits',
      'suppliers',
      'supplier_credit_notes',
      'supplier_refunds',
      'inventory_movements',
      'fx_rates',
    ];
    const present = (
      await ownerPool().query<{ t: string }>(
        `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[]) ORDER BY 1`,
        [forbidden],
      )
    ).rows.map((r) => r.t);
    expect(present).toEqual([]);
  });

  it('every shape used the generic internal source identity, and the source registry still holds exactly three', async () => {
    const types = (await ownerPool().query<{ t: string }>(`SELECT source_type AS t FROM accounting_source_types ORDER BY sort_order`)).rows.map((r) => r.t);
    expect(types).toEqual(['opening_balance', 'manual_adjustment', 'reversal']);
    const used = (
      await ownerPool().query<{ t: string }>(`SELECT DISTINCT source_type AS t FROM journal_entries WHERE business_id = $1`, [must(fx).businessId])
    ).rows.map((r) => r.t);
    expect(used).toEqual(['manual_adjustment']);
  });
});
