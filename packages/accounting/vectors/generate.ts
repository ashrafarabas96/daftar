/**
 * Regenerates `acctfp-vectors.json`.
 *
 * Run with `npx tsx packages/accounting/vectors/generate.ts`. The inputs below
 * are the specification's interesting cases; the expected bytes and digest are
 * computed by the TypeScript canonicalizer and then independently reproduced
 * by the PostgreSQL one in the parity test. Regenerating is therefore only
 * legitimate when the SPEC changed — if a regeneration silently changes an
 * existing digest, the parity test against the database will fail, which is
 * exactly the alarm it exists to raise.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalStream, computeFingerprint, type CanonicalHeaderInput, type CanonicalLineInput } from '../src/fingerprint';

interface RawLine {
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

interface RawCase {
  name: string;
  why: string;
  header: CanonicalHeaderInput;
  lines: RawLine[];
}

const T = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const B = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const S1 = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const BR1 = '1b4e28ba-2fa1-11d2-9a0c-0305e82c3301';
const BR2 = '2c5f39cb-3fb2-11d2-9a0c-0305e82c3302';
const WH1 = '3d6a4adc-4fc3-11d2-9a0c-0305e82c3303';

const header = (sourceType: string, entryDate = '2026-03-14'): CanonicalHeaderInput => ({
  tenantId: T,
  businessId: B,
  sourceType,
  sourceId: S1,
  entryDate,
});

const cases: RawCase[] = [
  {
    name: 'domestic-two-lines',
    why: 'The simplest balanced entry: one currency, rate 1, both dimensions NULL. Proves the 0x00 NULL sentinel and the base rate source.',
    header: header('manual_adjustment'),
    lines: [
      {
        accountIdentity: 'cash',
        side: 'D',
        baseAmountMinor: '150000',
        baseCurrency: 'ILS',
        txnAmountMinor: '150000',
        txnCurrency: 'ILS',
        fxRate: '1',
        fxRateSource: 'base',
        fxRateAt: '2026-03-14T09:15:00Z',
        branchId: null,
        warehouseId: null,
      },
      {
        accountIdentity: 'sales_revenue',
        side: 'C',
        baseAmountMinor: '150000',
        baseCurrency: 'ILS',
        txnAmountMinor: '150000',
        txnCurrency: 'ILS',
        fxRate: '1.0000000000',
        fxRateSource: 'base',
        fxRateAt: '2026-03-14T09:15:00Z',
        branchId: null,
        warehouseId: null,
      },
    ],
  },
  {
    name: 'foreign-currency-with-dimensions',
    why: 'USD transaction against an ILS base, with a branch and a warehouse set. Proves rate normalization to ten fraction digits and UUID lowercasing.',
    header: header('manual_adjustment'),
    lines: [
      {
        accountIdentity: 'cash',
        side: 'D',
        baseAmountMinor: '37200',
        baseCurrency: 'ILS',
        txnAmountMinor: '10000',
        txnCurrency: 'USD',
        fxRate: '3.72',
        fxRateSource: 'provider',
        fxRateAt: '2026-03-14T09:15:07Z',
        branchId: BR1.toUpperCase(),
        warehouseId: WH1,
      },
      {
        accountIdentity: 'code:4100',
        side: 'C',
        baseAmountMinor: '37200',
        baseCurrency: 'ILS',
        txnAmountMinor: '10000',
        txnCurrency: 'USD',
        fxRate: '3.7200000000',
        fxRateSource: 'provider',
        fxRateAt: '2026-03-14T09:15:07Z',
        branchId: BR1,
        warehouseId: null,
      },
    ],
  },
  {
    name: 'line-order-is-byte-order',
    why: 'The same three lines submitted in a deliberately wrong order must canonicalize identically to the sorted form — ordering is by line bytes, never by submission order or line_no.',
    header: header('manual_adjustment'),
    lines: [
      {
        accountIdentity: 'vat_output',
        side: 'C',
        baseAmountMinor: '2550',
        baseCurrency: 'ILS',
        txnAmountMinor: '2550',
        txnCurrency: 'ILS',
        fxRate: '1',
        fxRateSource: 'base',
        fxRateAt: '2026-03-14T00:00:00Z',
        branchId: BR2,
        warehouseId: null,
      },
      {
        accountIdentity: 'accounts_receivable',
        side: 'D',
        baseAmountMinor: '17550',
        baseCurrency: 'ILS',
        txnAmountMinor: '17550',
        txnCurrency: 'ILS',
        fxRate: '1',
        fxRateSource: 'base',
        fxRateAt: '2026-03-14T00:00:00Z',
        branchId: BR2,
        warehouseId: null,
      },
      {
        accountIdentity: 'sales_revenue',
        side: 'C',
        baseAmountMinor: '15000',
        baseCurrency: 'ILS',
        txnAmountMinor: '15000',
        txnCurrency: 'ILS',
        fxRate: '1',
        fxRateSource: 'base',
        fxRateAt: '2026-03-14T00:00:00Z',
        branchId: BR2,
        warehouseId: null,
      },
    ],
  },
  {
    name: 'identical-lines-keep-multiplicity',
    why: 'Two byte-identical lines are financial truth, not a duplicate to collapse. Both must remain in the stream.',
    header: header('manual_adjustment'),
    lines: [
      {
        accountIdentity: 'cash',
        side: 'D',
        baseAmountMinor: '5000',
        baseCurrency: 'ILS',
        txnAmountMinor: '5000',
        txnCurrency: 'ILS',
        fxRate: '1',
        fxRateSource: 'base',
        fxRateAt: '2026-03-14T12:00:00Z',
        branchId: null,
        warehouseId: null,
      },
      {
        accountIdentity: 'cash',
        side: 'D',
        baseAmountMinor: '5000',
        baseCurrency: 'ILS',
        txnAmountMinor: '5000',
        txnCurrency: 'ILS',
        fxRate: '1',
        fxRateSource: 'base',
        fxRateAt: '2026-03-14T12:00:00Z',
        branchId: null,
        warehouseId: null,
      },
      {
        accountIdentity: 'owner_equity',
        side: 'C',
        baseAmountMinor: '10000',
        baseCurrency: 'ILS',
        txnAmountMinor: '10000',
        txnCurrency: 'ILS',
        fxRate: '1',
        fxRateSource: 'base',
        fxRateAt: '2026-03-14T12:00:00Z',
        branchId: null,
        warehouseId: null,
      },
    ],
  },
  {
    name: 'three-decimal-base-currency',
    why: 'A JOD base (three minor units) against a USD transaction (two). Proves the canonical form is independent of the exponent arithmetic that produced the amounts.',
    header: header('opening_balance', '2025-01-01'),
    lines: [
      {
        accountIdentity: 'cash',
        side: 'D',
        baseAmountMinor: '70900',
        baseCurrency: 'JOD',
        txnAmountMinor: '10000',
        txnCurrency: 'USD',
        fxRate: '0.709',
        fxRateSource: 'manual',
        fxRateAt: '2025-01-01T00:00:00Z',
        branchId: null,
        warehouseId: null,
      },
      {
        accountIdentity: 'opening_balance_equity',
        side: 'C',
        baseAmountMinor: '70900',
        baseCurrency: 'JOD',
        txnAmountMinor: '10000',
        txnCurrency: 'USD',
        fxRate: '0.7090000000',
        fxRateSource: 'manual',
        fxRateAt: '2025-01-01T00:00:00Z',
        branchId: null,
        warehouseId: null,
      },
    ],
  },
  {
    name: 'null-dimension-sorts-before-uuid',
    why: 'The NULL sentinel is byte 0x00, which sorts before any hex UUID text. Two otherwise identical lines differing only in branch must order NULL first.',
    header: header('manual_adjustment'),
    lines: [
      {
        accountIdentity: 'cash',
        side: 'D',
        baseAmountMinor: '1000',
        baseCurrency: 'ILS',
        txnAmountMinor: '1000',
        txnCurrency: 'ILS',
        fxRate: '1',
        fxRateSource: 'base',
        fxRateAt: '2026-03-14T08:00:00Z',
        branchId: BR1,
        warehouseId: null,
      },
      {
        accountIdentity: 'cash',
        side: 'D',
        baseAmountMinor: '1000',
        baseCurrency: 'ILS',
        txnAmountMinor: '1000',
        txnCurrency: 'ILS',
        fxRate: '1',
        fxRateSource: 'base',
        fxRateAt: '2026-03-14T08:00:00Z',
        branchId: null,
        warehouseId: null,
      },
      {
        accountIdentity: 'owner_equity',
        side: 'C',
        baseAmountMinor: '2000',
        baseCurrency: 'ILS',
        txnAmountMinor: '2000',
        txnCurrency: 'ILS',
        fxRate: '1',
        fxRateSource: 'base',
        fxRateAt: '2026-03-14T08:00:00Z',
        branchId: null,
        warehouseId: null,
      },
    ],
  },
];

const toInput = (l: RawLine): CanonicalLineInput => ({
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

const out = {
  spec: 'acctfp/1',
  note: 'Generated by packages/accounting/vectors/generate.ts. One source for BOTH the TypeScript and PostgreSQL canonicalizers (directive §21).',
  cases: cases.map((c) => {
    const lines = c.lines.map(toInput);
    return {
      name: c.name,
      why: c.why,
      header: c.header,
      lines: c.lines,
      canonicalHex: canonicalStream(c.header, lines).toString('hex'),
      fingerprint: computeFingerprint(c.header, lines),
    };
  }),
};

writeFileSync(join(__dirname, 'acctfp-vectors.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8');
process.stdout.write(`wrote ${out.cases.length} vectors\n`);
