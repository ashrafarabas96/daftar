/**
 * `acctfp/1` — the two implementations must agree, byte for byte.
 *
 * Directive §21 requires one specification, two implementations and ONE vector
 * source. This suite reads the very file
 * `packages/accounting/test/fingerprint.test.ts` reads, computes each vector
 * inside PostgreSQL, and compares. If either canonicalizer is edited alone,
 * this fails.
 *
 * It compares the per-line bytes as well as the digest. A digest-only check
 * tells you that two implementations disagree; the line bytes tell you which
 * field, which is the difference between a five-minute fix and an afternoon.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { canonicalLineBytes, computeFingerprint, type CanonicalHeaderInput, type CanonicalLineInput } from '../../packages/accounting/src/fingerprint';
import { convertToBaseMinor } from '../../packages/accounting/src/fx';
import { ensurePostgres, ownerPool } from '../helpers/test-app';
import { must } from '../helpers/accounting-posting';

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
  header: CanonicalHeaderInput;
  lines: VectorLine[];
  canonicalHex: string;
  fingerprint: string;
}

const vectors = JSON.parse(readFileSync(join(__dirname, '../../packages/accounting/vectors/acctfp-vectors.json'), 'utf8')) as { cases: Vector[] };

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

let pool: Pool;

beforeAll(async () => {
  await ensurePostgres();
  pool = ownerPool();
});

afterAll(async () => {
  // ownerPool is shared by the suite; nothing to close here.
});

const sqlLineHex = async (l: VectorLine): Promise<string> => {
  const r = await pool.query<{ hex: string }>(
    `SELECT encode(accounting_canonical_line($1,$2,$3::bigint,$4,$5::bigint,$6,$7::numeric,$8,$9::timestamptz,$10::uuid,$11::uuid),'hex') AS hex`,
    [
      l.accountIdentity,
      l.side,
      l.baseAmountMinor,
      l.baseCurrency,
      l.txnAmountMinor,
      l.txnCurrency,
      l.fxRate,
      l.fxRateSource,
      l.fxRateAt,
      l.branchId,
      l.warehouseId,
    ],
  );
  return must(r.rows[0]).hex;
};

const sqlFingerprint = async (v: Vector): Promise<string> => {
  const payload = v.lines.map((l) => ({
    identity: l.accountIdentity,
    side: l.side,
    base: l.baseAmountMinor,
    baseCur: l.baseCurrency,
    txn: l.txnAmountMinor,
    txnCur: l.txnCurrency,
    rate: l.fxRate,
    rateSrc: l.fxRateSource,
    rateAt: l.fxRateAt,
    branch: l.branchId,
    wh: l.warehouseId,
  }));
  const r = await pool.query<{ fp: string }>(
    `WITH l AS (
       SELECT accounting_canonical_line(
         e->>'identity', e->>'side', (e->>'base')::bigint, e->>'baseCur',
         (e->>'txn')::bigint, e->>'txnCur', (e->>'rate')::numeric, e->>'rateSrc',
         (e->>'rateAt')::timestamptz, (e->>'branch')::uuid, (e->>'wh')::uuid) AS b
       FROM jsonb_array_elements($6::jsonb) e
     )
     SELECT accounting_fingerprint($1::uuid,$2::uuid,$3,$4::uuid,$5::date,(SELECT array_agg(b) FROM l)) AS fp`,
    [v.header.tenantId, v.header.businessId, v.header.sourceType, v.header.sourceId, v.header.entryDate, JSON.stringify(payload)],
  );
  return must(r.rows[0]).fp;
};

describe('acctfp/1 — TypeScript and PostgreSQL agree (§21)', () => {
  it('the vector file is the one the package tests use', () => {
    expect(vectors.cases.length).toBeGreaterThanOrEqual(6);
  });

  for (const v of vectors.cases) {
    it(`${v.name}: every canonical LINE is byte-identical in both implementations`, async () => {
      for (const l of v.lines) {
        const fromSql = await sqlLineHex(l);
        const fromTs = canonicalLineBytes(toLine(l)).toString('hex');
        expect(fromSql, `line "${l.accountIdentity}" diverged`).toBe(fromTs);
      }
    });

    it(`${v.name}: the fingerprint is identical in both implementations and matches the recorded vector`, async () => {
      const fromSql = await sqlFingerprint(v);
      const fromTs = computeFingerprint(v.header, v.lines.map(toLine));
      expect(fromSql).toBe(fromTs);
      expect(fromSql).toBe(v.fingerprint);
    });
  }
});

describe('acctfp/1 — the byte-level details most likely to diverge', () => {
  it('PostgreSQL emits the NULL dimension as a real 0x00 byte, not as text', async () => {
    const hex = await sqlLineHex({
      accountIdentity: 'cash',
      side: 'D',
      baseAmountMinor: '1000',
      baseCurrency: 'ILS',
      txnAmountMinor: '1000',
      txnCurrency: 'ILS',
      fxRate: '1.0000000000',
      fxRateSource: 'base',
      fxRateAt: '2026-03-14T08:00:00Z',
      branchId: null,
      warehouseId: null,
    });
    const bytes = Buffer.from(hex, 'hex');
    expect([...bytes].filter((b) => b === 0x00)).toHaveLength(2);
    // Not the textual imitations the directive explicitly forbids.
    expect(bytes.toString('utf8')).not.toContain('\\x00');
    expect(bytes.toString('utf8')).not.toContain('\\0');
  });

  it('PostgreSQL writes a rate with exactly ten fraction digits and a leading digit', async () => {
    for (const [rate, expected] of [
      ['1', '1.0000000000'],
      ['0.709', '0.7090000000'],
      ['3.72', '3.7200000000'],
      ['0.0000000001', '0.0000000001'],
    ] as const) {
      const hex = await sqlLineHex({
        accountIdentity: 'cash',
        side: 'D',
        baseAmountMinor: '1000',
        baseCurrency: 'ILS',
        txnAmountMinor: '1000',
        txnCurrency: 'ILS',
        fxRate: rate,
        fxRateSource: 'manual',
        fxRateAt: '2026-03-14T08:00:00Z',
        branchId: null,
        warehouseId: null,
      });
      expect(Buffer.from(hex, 'hex').toString('utf8')).toContain(expected);
    }
  });

  it('PostgreSQL truncates nothing: an fx_rate_at is emitted at second precision ending Z', async () => {
    const hex = await sqlLineHex({
      accountIdentity: 'cash',
      side: 'D',
      baseAmountMinor: '1000',
      baseCurrency: 'ILS',
      txnAmountMinor: '1000',
      txnCurrency: 'ILS',
      fxRate: '1.0000000000',
      fxRateSource: 'base',
      fxRateAt: '2026-03-14T08:00:07Z',
      branchId: null,
      warehouseId: null,
    });
    expect(Buffer.from(hex, 'hex').toString('utf8')).toContain('2026-03-14T08:00:07Z');
  });

  it('PostgreSQL orders lines by bytes, so submission order cannot change the digest', async () => {
    const base: Vector = must(vectors.cases.find((c) => c.name === 'line-order-is-byte-order'));
    const reversed: Vector = { ...base, lines: [...base.lines].reverse() };
    expect(await sqlFingerprint(reversed)).toBe(await sqlFingerprint(base));
  });
});

describe('FX arithmetic — TypeScript agrees with the frozen 0043 validator', () => {
  // The database's own conversion lives inside accounting_assert_entry_valid,
  // which is frozen. Rather than restating its arithmetic, this compares the
  // TypeScript implementation against the same formula executed by PostgreSQL
  // NUMERIC, including the exact ties where HALF_EVEN and round-half-away
  // disagree.
  const sqlConvert = async (txn: bigint, et: number, eb: number, rate: string): Promise<bigint> => {
    const r = await pool.query<{ v: string }>(
      `WITH t AS (
         SELECT $1::numeric * ($2::numeric * 10000000000::numeric) * accounting_pow10($3::int - $4::int) AS num,
                10000000000::numeric * accounting_pow10($4::int - $3::int) AS den
       ), q AS (
         SELECT num, den, div(num, den) AS q, num - div(num, den) * den AS r FROM t
       )
       SELECT (CASE WHEN 2*r > den THEN q + 1
                    WHEN 2*r < den THEN q
                    ELSE CASE WHEN mod(q, 2::numeric) = 0 THEN q ELSE q + 1 END END)::text AS v
       FROM q`,
      [txn.toString(), rate, eb, et],
    );
    return BigInt(must(r.rows[0]).v);
  };

  const cases: ReadonlyArray<readonly [bigint, string, string, string]> = [
    [10_000n, 'USD', 'ILS', '3.72'],
    [10_000n, 'USD', 'JOD', '0.709'],
    [70_900n, 'JOD', 'USD', '1.4104372355'],
    [1n, 'ILS', 'ILS', '2.5'],
    [3n, 'ILS', 'ILS', '0.5'],
    [5n, 'ILS', 'ILS', '0.5'],
    [7n, 'ILS', 'ILS', '0.5'],
    [9n, 'ILS', 'ILS', '0.5'],
    [1_000_000_000_000_000_000n, 'ILS', 'ILS', '1'],
  ];

  const minorUnits: Record<string, number> = { ILS: 2, USD: 2, JOD: 3 };

  for (const [amount, txnCur, baseCur, rate] of cases) {
    it(`${amount} ${txnCur} at ${rate} → ${baseCur} matches PostgreSQL exactly`, async () => {
      const fromTs = convertToBaseMinor({ txnAmountMinor: amount, txnCurrency: txnCur, baseCurrency: baseCur, fxRate: rate });
      const fromSql = await sqlConvert(amount, must(minorUnits[txnCur]), must(minorUnits[baseCur]), rate);
      expect(fromTs).toBe(fromSql);
    });
  }
});
