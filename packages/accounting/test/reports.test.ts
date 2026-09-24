import { describe, expect, it } from 'vitest';
import { AccountingError } from '../src/errors';
import {
  ACCOUNT_TYPES,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  boundPage,
  decodeEntryCursor,
  decodeLedgerCursor,
  encodeEntryCursor,
  encodeLedgerCursor,
  exactMinor,
  isWholeBusinessScope,
  normalBalanceOf,
  presentationNet,
  type AccountType,
} from '../src/reports';

/**
 * THE PURE RULES OF THE READ SIDE (P2-S7 §28, §29, §41, §42, §53).
 *
 * The integration suites prove the reports are right about a real ledger.
 * This file proves the four rules underneath them are right about every
 * input, including the ones a fixture will never produce: all five account
 * types, negative results, amounts past 2^63, and cursors a client made up.
 */
describe('the normal-balance rule is stated once and covers all five types (§42)', () => {
  it('names a direction for every type the chart can hold, and no other', () => {
    expect([...ACCOUNT_TYPES]).toEqual(['asset', 'liability', 'equity', 'revenue', 'expense']);
    expect(ACCOUNT_TYPES.map(normalBalanceOf)).toEqual(['debit', 'credit', 'credit', 'credit', 'debit']);
  });

  it('nets a debit-normal account as debit minus credit', () => {
    for (const type of ['asset', 'expense'] as const) {
      expect(presentationNet(type, 900n, 250n)).toBe(650n);
      expect(presentationNet(type, 250n, 900n)).toBe(-650n);
    }
  });

  it('nets a credit-normal account as credit minus debit', () => {
    for (const type of ['liability', 'equity', 'revenue'] as const) {
      expect(presentationNet(type, 250n, 900n)).toBe(650n);
      expect(presentationNet(type, 900n, 250n)).toBe(-650n);
    }
  });

  /**
   * §22. A contra asset, an overdrawn bank and a revenue account swamped by
   * refunds all present negative, and the report says so. Clamping at zero
   * would be a report overruling the books.
   */
  it('returns a negative net rather than clamping it', () => {
    expect(presentationNet('asset', 0n, 1n)).toBe(-1n);
    expect(presentationNet('revenue', 1n, 0n)).toBe(-1n);
  });

  it('is exact past the range of a double and past the range of a signed 64-bit integer', () => {
    // 2^53 + 1 survives; as a `number` it would collapse onto 2^53.
    expect(presentationNet('asset', 9_007_199_254_740_993n, 1n)).toBe(9_007_199_254_740_992n);
    // A cumulative history larger than BIGINT: no line exceeds 10^18, a sum
    // of them is not capped, and the rule does not overflow (§41).
    const huge = 20_000_000_000_000_000_000n;
    expect(presentationNet('asset', huge, 1n)).toBe(huge - 1n);
    expect(presentationNet('liability', 1n, huge)).toBe(huge - 1n);
  });
});

describe('a NUMERIC sum becomes an exact bigint, or nothing (§41)', () => {
  it('parses what PostgreSQL actually returns for SUM(bigint)', () => {
    expect(exactMinor('0')).toBe(0n);
    expect(exactMinor('-42')).toBe(-42n);
    expect(exactMinor('20000000000000000000')).toBe(20_000_000_000_000_000_000n);
  });

  /**
   * A fraction here would mean the query summed something that is not minor
   * units. Rounding it would hide that; raising says which layer is wrong.
   */
  it('refuses anything that is not an exact integer', () => {
    for (const bad of ['1.5', '1e3', '', ' 1', '1 ', '0x10', 'NaN', 'Infinity', '--1', '+1']) {
      expect(() => exactMinor(bad)).toThrow(AccountingError);
    }
    try {
      exactMinor('1.5');
    } catch (e) {
      expect((e as AccountingError).code).toBe('accounting.report_amount_invalid');
    }
  });
});

describe('whole-business scope is a question about authority, not about filters', () => {
  it('is true only for business-wide authority with no dimensional filter', () => {
    expect(isWholeBusinessScope({ mode: 'all' })).toBe(true);
    expect(isWholeBusinessScope({ mode: 'all', branchId: null })).toBe(true);
    expect(isWholeBusinessScope({ mode: 'all', branchId: '1b4e28ba-2fa1-11d2-9a0c-0305e82c3301' })).toBe(false);
    expect(isWholeBusinessScope({ mode: 'assigned', branchIds: [] })).toBe(false);
    expect(isWholeBusinessScope({ mode: 'assigned', branchIds: ['1b4e28ba-2fa1-11d2-9a0c-0305e82c3301'] })).toBe(false);
  });
});

describe('cursors round-trip and are strictly parsed (§28, §29, §53)', () => {
  const ENTRY_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

  it('carries the complete ordering tuple back, unchanged', () => {
    const ledger = { entryDate: '2026-03-14', entryId: ENTRY_ID, lineNo: 7 };
    expect(decodeLedgerCursor(encodeLedgerCursor(ledger))).toEqual(ledger);
    const entry = { entryDate: '2026-03-14', entryId: ENTRY_ID };
    expect(decodeEntryCursor(encodeEntryCursor(entry))).toEqual(entry);
  });

  it('is versioned, and a cursor of the other shape is not accepted', () => {
    expect(encodeLedgerCursor({ entryDate: '2026-03-14', entryId: ENTRY_ID, lineNo: 1 }).startsWith('glc/1.')).toBe(true);
    expect(encodeEntryCursor({ entryDate: '2026-03-14', entryId: ENTRY_ID }).startsWith('gec/1.')).toBe(true);
    expect(() => decodeLedgerCursor(encodeEntryCursor({ entryDate: '2026-03-14', entryId: ENTRY_ID }))).toThrow(AccountingError);
    expect(() => decodeEntryCursor(encodeLedgerCursor({ entryDate: '2026-03-14', entryId: ENTRY_ID, lineNo: 1 }))).toThrow(AccountingError);
  });

  /**
   * Everything below decodes to something, and every one of them is refused
   * before it can reach a predicate. A cursor is server-issued state, so a
   * malformed one is a stable refusal rather than a guess (§29).
   */
  it('refuses a cursor this server did not issue, in every way one can be wrong', () => {
    const payload = (text: string): string => `glc/1.${Buffer.from(text, 'utf8').toString('base64url')}`;
    const bad = [
      '',
      'glc/1.',
      'glc/2.abcd',
      'abcd',
      `glc/1.${'A'.repeat(600)}`, // past the length bound, before any decoding
      payload('|'.repeat(400)), // decodes long
      payload('2026-03-14'), // too few components
      payload(`2026-03-14|${ENTRY_ID}|1|extra`), // too many
      payload(`14-03-2026|${ENTRY_ID}|1`), // not a civil date
      payload(`2026-03-14|not-a-uuid|1`),
      payload(`2026-03-14|${ENTRY_ID}|0`), // line numbers start at one
      payload(`2026-03-14|${ENTRY_ID}|-1`),
      payload(`2026-03-14|${ENTRY_ID}|1.5`),
      payload(`2026-03-14|${ENTRY_ID}|9999999999`), // past the bound on line numbers
      `glc/1.${Buffer.from('2026-03-14|x|1', 'utf8').toString('base64')}==`, // padded base64, not base64url
      `glc/1.a b`,
      `glc/1.${'2026-03-14'}`,
    ];
    for (const raw of bad) {
      expect(() => decodeLedgerCursor(raw), `accepted ${JSON.stringify(raw.slice(0, 40))}`).toThrow(AccountingError);
    }
    try {
      decodeLedgerCursor('nonsense');
    } catch (e) {
      expect((e as AccountingError).code).toBe('accounting.report_cursor_invalid');
    }
  });

  it("refuses a cursor that is not a string at all, whatever a caller's JSON said", () => {
    for (const raw of [null, undefined, 42, {}, []] as unknown[]) {
      expect(() => decodeLedgerCursor(raw as string)).toThrow(AccountingError);
      expect(() => decodeEntryCursor(raw as string)).toThrow(AccountingError);
    }
  });
});

describe('the page size is the server’s decision (§53)', () => {
  it('bounds what a caller asks for and falls back to a default for nonsense', () => {
    expect(boundPage(1)).toBe(1);
    expect(boundPage(MAX_PAGE_SIZE)).toBe(MAX_PAGE_SIZE);
    expect(boundPage(MAX_PAGE_SIZE + 1)).toBe(MAX_PAGE_SIZE);
    expect(boundPage(1_000_000)).toBe(MAX_PAGE_SIZE);
    for (const nonsense of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(boundPage(nonsense)).toBe(DEFAULT_PAGE_SIZE);
    }
  });
});

describe('the rule is total: every type the database can store has an answer', () => {
  it('has no fall-through for an unexpected type', () => {
    // If the chart ever gains a sixth type, this assertion is what fails —
    // rather than the sixth type quietly presenting credit-normal.
    const known = new Set<string>(ACCOUNT_TYPES);
    expect(known.size).toBe(5);
    for (const type of ACCOUNT_TYPES) {
      const direction = normalBalanceOf(type as AccountType);
      expect(direction === 'debit' || direction === 'credit').toBe(true);
    }
  });
});
