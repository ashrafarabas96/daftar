/**
 * THE ENGINE-SHAPE VOCABULARY, SHARED BY THE TWO SUITES THAT POST THESE SHAPES.
 *
 * Every declaration below was MOVED here verbatim from
 * `01-engine-shapes.golden.test.ts`, where it stood alone while that suite was
 * the only one posting an engine shape. `DR-115`/1 made a second suite post
 * some of them through a real sales document, and the owner's condition is
 * that what each golden asserts stays identical byte for byte.
 *
 * One copy is how that is PROVED rather than asserted: `expected()` is a pure
 * function of a `Shape` literal over eleven columns, so two suites importing
 * the same `expected()` and the same unmoved `Shape` text cannot disagree
 * about the expected output. A second, hand-copied `CODE` table in the second
 * suite would be the defect this suite's own comment names — "a golden that
 * asks the database what it seeded and then asserts the answer proves
 * nothing", and a second copy of the chart is the same defect one step on.
 *
 * Nothing here is new and nothing here changed. The move is visible in the
 * diff as a move.
 */
import { rate10 } from '../../helpers/accounting-posting';

/** The instant every FX snapshot in this suite is taken at. */
export const AT = new Date('2026-03-14T09:15:00Z');

/** A system account identity, as the closed registry in `0040` names it. */
export type Key =
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
export const CODE: Readonly<Record<Key, string>> = {
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
export interface Foreign {
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
export interface Line {
  readonly account: Key;
  readonly side: 'D' | 'C';
  readonly base: number;
  readonly foreign?: Foreign;
}

export interface Shape {
  /** The golden identity from the Phase 0 suite, where the rules give one. */
  readonly id: string;
  readonly title: string;
  readonly lines: readonly Line[];
}

export const minor = (whole: number): bigint => BigInt(Math.round(whole * 100));

export interface PersistedLine {
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

export const expected = (shape: Shape): PersistedLine[] =>
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
