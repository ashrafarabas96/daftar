import { describe, expect, it } from 'vitest';
import { InventoryError } from '../src/errors';
import {
  COST_LIMIT_C10,
  COST_SCALE,
  formatMinor,
  formatQuantity,
  formatUnitCost,
  parseDecimal,
  parseMinor,
  parseQuantity,
  parseUnitCost,
  QTY_LIMIT_Q4,
  QTY_SCALE,
  VALUE_LIMIT_MINOR,
} from '../src/fixed-point';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof InventoryError) return e.code;
    throw e;
  }
  return undefined;
}

/** Text that is never a decimal literal: signs, exponents, spaces, separators, leading zeros, bare dots. */
const NOT_DECIMAL = [
  '',
  ' ',
  '1 ',
  ' 1',
  '+1',
  '01',
  '-01',
  '00',
  '1.',
  '.5',
  '-.5',
  '1e3',
  '1E3',
  '0x10',
  '1,5',
  '1_000',
  'NaN',
  'Infinity',
  '--1',
  '1.2.3',
  '١',
];

describe('constants (A-26)', () => {
  it('fix the scales and the bounds', () => {
    expect(QTY_SCALE).toBe(4);
    expect(COST_SCALE).toBe(10);
    expect(QTY_LIMIT_Q4).toBe(10n ** 18n);
    expect(VALUE_LIMIT_MINOR).toBe(10n ** 18n);
    expect(COST_LIMIT_C10).toBe(10n ** 28n);
  });
});

describe('parseDecimal', () => {
  it('parses exact units and the written scale, trailing zeros included', () => {
    expect(parseDecimal('0')).toEqual({ units: 0n, scale: 0 });
    expect(parseDecimal('-520')).toEqual({ units: -520n, scale: 0 });
    expect(parseDecimal('1.2')).toEqual({ units: 12n, scale: 1 });
    expect(parseDecimal('1.2000')).toEqual({ units: 12000n, scale: 4 });
    expect(parseDecimal('-0.0001')).toEqual({ units: -1n, scale: 4 });
    expect(parseDecimal('123456789012345678901234567890.123456789012345')).toEqual({
      units: 123456789012345678901234567890123456789012345n,
      scale: 15,
    });
  });

  it('refuses anything that is not ^-?(0|[1-9][0-9]*)(\\.[0-9]+)?$ with inventory.arithmetic_invalid', () => {
    for (const t of NOT_DECIMAL)
      expect(
        codeOf(() => parseDecimal(t)),
        JSON.stringify(t),
      ).toBe('inventory.arithmetic_invalid');
  });
});

describe('parseQuantity / formatQuantity (Q4)', () => {
  it('scales to Q4 exactly and formats with four fraction digits', () => {
    const cases: [string, bigint, string][] = [
      ['1', 10000n, '1.0000'],
      ['1.0000', 10000n, '1.0000'],
      ['-3.0000', -30000n, '-3.0000'],
      ['0.5', 5000n, '0.5000'],
      ['-0.5', -5000n, '-0.5000'],
      ['1.0001', 10001n, '1.0001'],
      ['0', 0n, '0.0000'],
      ['-0', 0n, '0.0000'],
      ['0.0001', 1n, '0.0001'],
      ['99999999999999.9999', QTY_LIMIT_Q4 - 1n, '99999999999999.9999'],
      ['-99999999999999.9999', -(QTY_LIMIT_Q4 - 1n), '-99999999999999.9999'],
      ['30000000000.0000', 300000000000000n, '30000000000.0000'],
    ];
    for (const [text, q4, formatted] of cases) {
      expect(parseQuantity(text), text).toBe(q4);
      expect(formatQuantity(q4), text).toBe(formatted);
      expect(parseQuantity(formatQuantity(q4))).toBe(q4);
    }
  });

  it('refuses more than four fraction digits, |q| >= 10^14 and non-decimal text with inventory.quantity_invalid', () => {
    for (const t of ['1.00000', '0.00001', '100000000000000', '-100000000000000.0000', '100000000000000.0001', ...NOT_DECIMAL]) {
      expect(
        codeOf(() => parseQuantity(t)),
        JSON.stringify(t),
      ).toBe('inventory.quantity_invalid');
    }
  });
});

describe('parseUnitCost / formatUnitCost (C10)', () => {
  it('scales to C10 exactly and formats with ten fraction digits', () => {
    const cases: [string, bigint, string][] = [
      ['0', 0n, '0.0000000000'],
      ['0.6', 6000000000n, '0.6000000000'],
      ['3.3333333333', 33333333333n, '3.3333333333'],
      ['110.5000000000', 1105000000000n, '110.5000000000'],
      ['0.0000000001', 1n, '0.0000000001'],
      ['999999999999999999.9999999999', COST_LIMIT_C10 - 1n, '999999999999999999.9999999999'],
    ];
    for (const [text, c10, formatted] of cases) {
      expect(parseUnitCost(text), text).toBe(c10);
      expect(formatUnitCost(c10), text).toBe(formatted);
    }
  });

  it('formats a signed average too (an average is C10 and may be negative)', () => {
    expect(formatUnitCost(-1n)).toBe('-0.0000000001');
    expect(formatUnitCost(-866666666667n)).toBe('-86.6666666667');
  });

  it('refuses a negative cost, more than ten fraction digits, cost >= 10^18 and non-decimal text with inventory.cost_invalid', () => {
    for (const t of ['-0.0000000001', '-1', '0.00000000001', '1.00000000000', '1000000000000000000', ...NOT_DECIMAL]) {
      expect(
        codeOf(() => parseUnitCost(t)),
        JSON.stringify(t),
      ).toBe('inventory.cost_invalid');
    }
  });
});

describe('parseMinor / formatMinor', () => {
  it('parses integer text within ±10^18 inclusive', () => {
    expect(parseMinor('0')).toBe(0n);
    expect(parseMinor('-500')).toBe(-500n);
    expect(parseMinor('1000000000000000000')).toBe(VALUE_LIMIT_MINOR);
    expect(parseMinor('-1000000000000000000')).toBe(-VALUE_LIMIT_MINOR);
    expect(formatMinor(-VALUE_LIMIT_MINOR)).toBe('-1000000000000000000');
    expect(formatMinor(0n)).toBe('0');
  });

  it('refuses fractions, out-of-range and non-integer text with inventory.value_out_of_range', () => {
    for (const t of ['1.0', '0.5', '1000000000000000001', '-1000000000000000001', ...NOT_DECIMAL]) {
      expect(
        codeOf(() => parseMinor(t)),
        JSON.stringify(t),
      ).toBe('inventory.value_out_of_range');
    }
  });

  it('never puts the refused number in the refusal message', () => {
    const cases: [string, (t: string) => unknown][] = [
      ['1000000000000000001', parseMinor],
      ['123456789012345', parseQuantity],
      ['-987654321', parseUnitCost],
      ['1.23456789', parseDecimal],
    ];
    for (const [text, parse] of cases) {
      let refused: unknown;
      try {
        parse(text === '1.23456789' ? '01.23456789' : text);
      } catch (e) {
        refused = e;
      }
      expect(refused).toBeInstanceOf(InventoryError);
      if (refused instanceof InventoryError) {
        expect(refused.message).not.toContain(text);
        expect(refused.message).not.toMatch(/[0-9]{2,}/);
      }
    }
  });
});
