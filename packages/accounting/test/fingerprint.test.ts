import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountingError } from '../src/errors';
import {
  ACCTFP_VERSION,
  canonicalDate,
  canonicalInstantSecond,
  canonicalLineBytes,
  canonicalRate,
  canonicalStream,
  canonicalUuid,
  computeFingerprint,
  type CanonicalHeaderInput,
  type CanonicalLineInput,
} from '../src/fingerprint';
import { computeCommandFingerprint } from '../src/post';
import type { PostingCommand, PostingLineCommand } from '../src/types';

/** Narrow an optional to its value; `noUncheckedIndexedAccess` plus the lint rules forbid `!`. */
function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected a value, found none');
  return value;
}

interface VectorLine {
  accountIdentity: string;
  side: 'D' | 'C';
  baseAmountMinor: string;
  baseCurrency: string;
  txnAmountMinor: string;
  txnCurrency: string;
  fxRate: string;
  fxRateSource: string;
  fxRateAt: string;
  branchId: string | null;
  warehouseId: string | null;
}

interface Vector {
  name: string;
  why: string;
  header: CanonicalHeaderInput;
  lines: VectorLine[];
  canonicalHex: string;
  fingerprint: string;
}

const vectors = JSON.parse(readFileSync(join(__dirname, '../vectors/acctfp-vectors.json'), 'utf8')) as { cases: Vector[] };

const toLine = (l: VectorLine): CanonicalLineInput => ({
  accountIdentity: l.accountIdentity,
  side: l.side,
  baseAmountMinor: BigInt(l.baseAmountMinor),
  baseCurrency: l.baseCurrency,
  txnAmountMinor: BigInt(l.txnAmountMinor),
  txnCurrency: l.txnCurrency,
  fxRate: l.fxRate,
  fxRateSource: l.fxRateSource,
  fxRateAt: new Date(l.fxRateAt),
  branchId: l.branchId,
  warehouseId: l.warehouseId,
});

describe('acctfp/1 — the shared vectors', () => {
  it('ships vectors covering the cases the spec turns on', () => {
    expect(vectors.cases.length).toBeGreaterThanOrEqual(6);
  });

  for (const v of vectors.cases) {
    it(`${v.name}: canonical bytes and digest match the recorded vector`, () => {
      const lines = v.lines.map(toLine);
      expect(canonicalStream(v.header, lines).toString('hex')).toBe(v.canonicalHex);
      expect(computeFingerprint(v.header, lines)).toBe(v.fingerprint);
    });
  }

  it('every vector has a distinct fingerprint — no two cases collapse', () => {
    const digests = new Set(vectors.cases.map((v) => v.fingerprint));
    expect(digests.size).toBe(vectors.cases.length);
  });
});

describe('acctfp/1 — the byte-level spec', () => {
  const header: CanonicalHeaderInput = {
    tenantId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    businessId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
    sourceType: 'manual_adjustment',
    sourceId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    entryDate: '2026-03-14',
  };
  const line = (over: Partial<CanonicalLineInput> = {}): CanonicalLineInput => ({
    accountIdentity: 'cash',
    side: 'D',
    baseAmountMinor: 1000n,
    baseCurrency: 'ILS',
    txnAmountMinor: 1000n,
    txnCurrency: 'ILS',
    fxRate: '1',
    fxRateSource: 'base',
    fxRateAt: new Date('2026-03-14T08:00:00Z'),
    branchId: null,
    warehouseId: null,
    ...over,
  });

  it('starts with the version prefix and a newline', () => {
    const bytes = canonicalStream(header, [line()]);
    expect(bytes.subarray(0, ACCTFP_VERSION.length + 1).toString('utf8')).toBe(`${ACCTFP_VERSION}\n`);
  });

  it('represents a NULL dimension as the single byte 0x00, never as text', () => {
    const bytes = canonicalLineBytes(line({ branchId: null, warehouseId: null }));
    // Two NUL bytes, and no textual imitation of one.
    expect([...bytes].filter((b) => b === 0x00)).toHaveLength(2);
    const text = bytes.toString('utf8');
    expect(text).not.toContain('\\x00');
    expect(text).not.toContain('\\0');
    expect(text).not.toContain('null');
    expect(text).not.toContain('NULL');
  });

  it('separates line fields with 0x1f and terminates each record with 0x1e', () => {
    const bytes = canonicalStream(header, [line(), line({ accountIdentity: 'owner_equity', side: 'C' })]);
    expect([...bytes].filter((b) => b === 0x1e)).toHaveLength(2);
    // Eleven fields per line → ten separators per line.
    expect([...bytes].filter((b) => b === 0x1f)).toHaveLength(20);
  });

  it('orders lines by their bytes, so submission order cannot change the digest', () => {
    const a = line({ accountIdentity: 'aaa' });
    const b = line({ accountIdentity: 'bbb' });
    const c = line({ accountIdentity: 'ccc' });
    const forward = computeFingerprint(header, [a, b, c]);
    const shuffled = computeFingerprint(header, [c, a, b]);
    const reversed = computeFingerprint(header, [c, b, a]);
    expect(shuffled).toBe(forward);
    expect(reversed).toBe(forward);
  });

  it('keeps both copies of a duplicated line — multiplicity is financial truth', () => {
    const one = computeFingerprint(header, [line(), line({ accountIdentity: 'owner_equity', side: 'C' })]);
    const two = computeFingerprint(header, [line(), line(), line({ accountIdentity: 'owner_equity', side: 'C' })]);
    expect(two).not.toBe(one);
  });

  it('normalizes a rate to exactly ten fraction digits', () => {
    expect(canonicalRate('1')).toBe('1.0000000000');
    expect(canonicalRate('3.72')).toBe('3.7200000000');
    expect(canonicalRate('0.7090000000')).toBe('0.7090000000');
    expect(computeFingerprint(header, [line({ fxRate: '1' })])).toBe(computeFingerprint(header, [line({ fxRate: '1.0000000000' })]));
  });

  it('refuses a rate with more precision than NUMERIC(20,10) could store', () => {
    expect(() => canonicalRate('1.00000000001')).toThrow(AccountingError);
  });

  it('lowercases UUIDs so letter case cannot change a fingerprint', () => {
    expect(canonicalUuid('3F2504E0-4F89-41D3-9A0C-0305E82C3301')).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
    const upper = line({ branchId: '1B4E28BA-2FA1-11D2-9A0C-0305E82C3301' });
    const lower = line({ branchId: '1b4e28ba-2fa1-11d2-9a0c-0305e82c3301' });
    expect(computeFingerprint(header, [upper])).toBe(computeFingerprint(header, [lower]));
  });

  it('uppercases currency codes', () => {
    expect(computeFingerprint(header, [line({ baseCurrency: 'ils', txnCurrency: 'ils' })])).toBe(computeFingerprint(header, [line()]));
  });

  it('refuses an fx_rate_at carrying sub-second precision (§24)', () => {
    expect(() => canonicalInstantSecond(new Date('2026-03-14T08:00:00.250Z'))).toThrow(AccountingError);
    expect(() => canonicalLineBytes(line({ fxRateAt: new Date('2026-03-14T08:00:00.001Z') }))).toThrow(AccountingError);
  });

  it('emits fx_rate_at as RFC3339 UTC seconds ending Z', () => {
    expect(canonicalInstantSecond(new Date('2026-03-14T08:00:00Z'))).toBe('2026-03-14T08:00:00Z');
  });

  it('refuses a date that is not a real calendar date', () => {
    expect(() => canonicalDate('2026-02-30')).toThrow(AccountingError);
    expect(() => canonicalDate('14-03-2026')).toThrow(AccountingError);
  });

  it('refuses an entry with no lines', () => {
    expect(() => canonicalStream(header, [])).toThrow(AccountingError);
  });

  it('writes amounts with no leading zeroes, separators or exponent', () => {
    const bytes = canonicalLineBytes(line({ baseAmountMinor: 1000000000000000000n, txnAmountMinor: 1000000000000000000n }));
    const text = bytes.toString('utf8');
    expect(text).toContain('1000000000000000000');
    expect(text).not.toContain('e+');
    expect(text).not.toContain(',');
  });
});

describe('acctfp/1 — what the fingerprint deliberately excludes (§28)', () => {
  const baseLine: PostingLineCommand = {
    account: { kind: 'system', systemKey: 'cash' },
    side: 'D',
    baseAmountMinor: 1000n,
    baseCurrency: 'ILS',
    txnAmountMinor: 1000n,
    txnCurrency: 'ILS',
    fxRate: '1',
    fxRateSource: 'base',
    fxRateAt: new Date('2026-03-14T08:00:00Z'),
    branchId: null,
    warehouseId: null,
  };
  const command: PostingCommand = {
    tenantId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    businessId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
    sourceType: 'manual_adjustment',
    sourceId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    entryDate: '2026-03-14',
    lines: [baseLine, { ...baseLine, account: { kind: 'system', systemKey: 'owner_equity' }, side: 'C' }],
  };
  const base = computeCommandFingerprint(command);

  it('a description-only change keeps the same fingerprint', () => {
    expect(computeCommandFingerprint({ ...command, description: 'reworded entirely' })).toBe(base);
  });

  it('a memo-only change keeps the same fingerprint', () => {
    const lines = command.lines.map((l) => ({ ...l, memo: 'a new memo' }));
    expect(computeCommandFingerprint({ ...command, lines })).toBe(base);
  });

  it('a request-id-only change keeps the same fingerprint', () => {
    expect(computeCommandFingerprint({ ...command, requestId: 'req-0002' })).toBe(base);
  });

  const financialTampers: ReadonlyArray<readonly [string, PostingCommand]> = [
    ['amount', { ...command, lines: [{ ...baseLine, baseAmountMinor: 1001n, txnAmountMinor: 1001n }, must(command.lines[1])] }],
    ['side', { ...command, lines: [{ ...baseLine, side: 'C' }, must(command.lines[1])] }],
    ['account identity', { ...command, lines: [{ ...baseLine, account: { kind: 'system', systemKey: 'bank' } }, must(command.lines[1])] }],
    ['account reference kind', { ...command, lines: [{ ...baseLine, account: { kind: 'code', code: 'cash' } }, must(command.lines[1])] }],
    ['transaction currency', { ...command, lines: [{ ...baseLine, txnCurrency: 'USD', fxRateSource: 'provider' }, must(command.lines[1])] }],
    ['fx rate', { ...command, lines: [{ ...baseLine, fxRate: '1.0000000001' }, must(command.lines[1])] }],
    ['fx rate source', { ...command, lines: [{ ...baseLine, fxRateSource: 'manual' }, must(command.lines[1])] }],
    ['fx rate timestamp', { ...command, lines: [{ ...baseLine, fxRateAt: new Date('2026-03-14T08:00:01Z') }, must(command.lines[1])] }],
    ['branch', { ...command, lines: [{ ...baseLine, branchId: '1b4e28ba-2fa1-11d2-9a0c-0305e82c3301' }, must(command.lines[1])] }],
    ['warehouse', { ...command, lines: [{ ...baseLine, warehouseId: '3d6a4adc-4fc3-11d2-9a0c-0305e82c3303' }, must(command.lines[1])] }],
    ['entry date', { ...command, entryDate: '2026-03-15' }],
    ['source type', { ...command, sourceType: 'opening_balance' }],
    ['source id', { ...command, sourceId: '6ba7b811-9dad-11d1-80b4-00c04fd430c8' }],
    ['business', { ...command, businessId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6e' }],
    ['tenant', { ...command, tenantId: '3f2504e0-4f89-41d3-9a0c-0305e82c3302' }],
  ];

  for (const [what, tampered] of financialTampers) {
    it(`changing the ${what} changes the fingerprint`, () => {
      expect(computeCommandFingerprint(tampered)).not.toBe(base);
    });
  }
});
