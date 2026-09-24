/**
 * `fxrate/1` AND AL-09 — ONE SPECIFICATION, TWO IMPLEMENTATIONS (§32, §57, §58, §59).
 *
 * Two questions, both answered against a real cluster.
 *
 *   §32/§59 — does the FX-rate canonicalizer produce the SAME bytes in
 *   TypeScript and in PostgreSQL? The vectors are the file
 *   `packages/accounting/test/fx-rate.test.ts` reads, so neither
 *   implementation can be edited alone. The comparison is on the canonical
 *   BYTES as well as the digest: a digest tells you two implementations
 *   disagree, the bytes tell you which field.
 *
 *   §57 — does the conversion arithmetic still land on the values AL-09
 *   pinned? Each vector is a literal in this file, computed by the TypeScript
 *   primitive, and then demanded of the database through the real posting
 *   authority: the exact value commits, one minor unit either way is refused
 *   at COMMIT.
 *
 * §58 is why the database half is a POSTING rather than a call to some
 * conversion helper written for this test. There are two implementations of
 * AL-09 and there will not be a third: the database's copy is the one inside
 * `accounting_assert_entry_valid`, so that is the one this file interrogates.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { computeFxRateFingerprint, fxRateCanonicalStream, canonicalEnteredRate } from '../../packages/accounting/src/fx-rate';
import { convertToBaseMinor } from '../../packages/accounting/src/fx';
import { MAX_MONEY_MINOR } from '../../packages/accounting/src/types';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  fingerprintOf,
  must,
  postAdjustmentAs,
  refusal,
  seedPostingFixture,
  sourceAssertion,
  todayIn,
  type PostCommand,
  type PostingFixture,
} from '../helpers/accounting-posting';

interface VectorFacts {
  tenantId: string;
  businessId: string;
  rateId: string;
  fromCurrency: string;
  toCurrency: string;
  rate: string;
  effectiveAt: string;
  source: string;
}
interface Vector {
  name: string;
  why: string;
  facts: VectorFacts;
  canonicalHex: string;
  fingerprint: string;
}

const vectors = JSON.parse(readFileSync(join(__dirname, '../../packages/accounting/vectors/fxrate-vectors.json'), 'utf8')) as { spec: string; cases: Vector[] };

let pool: Pool;
let fx: PostingFixture;
/** A business whose base currency has THREE minor units, for the reverse direction. */
let jod: { tenantId: string; businessId: string; userId: string };
let today: string;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  pool = ownerPool();
  fx = await seedPostingFixture(pool, `fxparity-${Math.floor(Math.random() * 1e6)}`);

  const tenantId = must((await pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0]).id;
  const businessId = must(
    (
      await pool.query<{ id: string }>(
        `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
         VALUES ($1, 'Parity JOD', $2, 'JO', 'JOD', 'Asia/Hebron') RETURNING id`,
        [tenantId, `fxparity-jod-${Math.floor(Math.random() * 1e6)}`],
      )
    ).rows[0],
  ).id;
  const userId = must(
    (
      await pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'Parity') RETURNING id`, [
        `fxparity-${Date.now()}@test.daftar.local`,
      ])
    ).rows[0],
  ).id;
  jod = { tenantId, businessId, userId };
  today = await todayIn(pool, 'Asia/Hebron');
}, 180_000);

// ── §32, §59 the FX canonicalizer ─────────────────────────────────────────

const sqlCanonicalHex = async (f: VectorFacts): Promise<string> => {
  const r = await pool.query<{ hex: string }>(
    `SELECT encode(accounting_fx_rate_canonical($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::numeric,$7::timestamptz,$8),'hex') AS hex`,
    [f.tenantId, f.businessId, f.rateId, f.fromCurrency, f.toCurrency, canonicalEnteredRate(f.rate), f.effectiveAt, f.source],
  );
  return must(r.rows[0]).hex;
};

const sqlFingerprint = async (f: VectorFacts): Promise<string> => {
  const r = await pool.query<{ fp: string }>(`SELECT accounting_fx_rate_fingerprint($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::numeric,$7::timestamptz,$8) AS fp`, [
    f.tenantId,
    f.businessId,
    f.rateId,
    f.fromCurrency,
    f.toCurrency,
    canonicalEnteredRate(f.rate),
    f.effectiveAt,
    f.source,
  ]);
  return must(r.rows[0]).fp;
};

const tsFacts = (f: VectorFacts): Parameters<typeof computeFxRateFingerprint>[0] => ({
  tenantId: f.tenantId,
  businessId: f.businessId,
  rateId: f.rateId,
  fromCurrency: f.fromCurrency,
  toCurrency: f.toCurrency,
  rate: f.rate,
  effectiveAt: new Date(f.effectiveAt),
  source: f.source,
});

describe('fxrate/1 — TypeScript and PostgreSQL agree (§32)', () => {
  it('reads the vector file the package tests read', () => {
    expect(vectors.spec).toBe('fxrate/1');
    expect(vectors.cases.length).toBeGreaterThanOrEqual(9);
  });

  for (const v of vectors.cases) {
    it(`${v.name}: the canonical stream is byte-identical in both implementations`, async () => {
      const fromSql = await sqlCanonicalHex(v.facts);
      const fromTs = fxRateCanonicalStream(tsFacts(v.facts)).toString('hex');
      expect(fromSql, `${v.name} diverged — ${v.why}`).toBe(fromTs);
      expect(fromSql).toBe(v.canonicalHex);
    });

    it(`${v.name}: the fingerprint is identical in both implementations`, async () => {
      const fromSql = await sqlFingerprint(v.facts);
      expect(fromSql).toBe(computeFxRateFingerprint(tsFacts(v.facts)));
      expect(fromSql).toBe(v.fingerprint);
    });
  }
});

describe('fxrate/1 — the details most likely to diverge (§59)', () => {
  const base: VectorFacts = {
    tenantId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    businessId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
    rateId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    fromCurrency: 'USD',
    toCurrency: 'ILS',
    rate: '1',
    effectiveAt: '2026-09-22T10:00:00Z',
    source: 'manual',
  };

  it('writes one rate three ways to one stream, in both implementations', async () => {
    const written = ['1', '1.0', '1.0000000000'];
    const sql = await Promise.all(written.map((rate) => sqlCanonicalHex({ ...base, rate })));
    const ts = written.map((rate) => fxRateCanonicalStream(tsFacts({ ...base, rate })).toString('hex'));
    expect(new Set([...sql, ...ts]).size).toBe(1);
  });

  it('keeps a leading digit on a sub-one rate, in both implementations', async () => {
    // `FM` without a leading `0` in the mask would write `.7090000000`, which
    // is a different byte stream and therefore a different rate identity.
    const sql = Buffer.from(await sqlCanonicalHex({ ...base, rate: '0.709' }), 'hex').toString('utf8');
    expect(sql).toContain('\n0.7090000000\n');
    expect(fxRateCanonicalStream(tsFacts({ ...base, rate: '0.709' })).toString('utf8')).toContain('\n0.7090000000\n');
  });

  it('writes the instant at second precision ending Z, in both implementations', async () => {
    const at = '2026-09-22T10:00:07Z';
    const sql = Buffer.from(await sqlCanonicalHex({ ...base, effectiveAt: at }), 'hex').toString('utf8');
    expect(sql).toContain(`\n${at}\n`);
    expect(fxRateCanonicalStream(tsFacts({ ...base, effectiveAt: at })).toString('utf8')).toContain(`\n${at}\n`);
  });

  it('writes the same bytes for an instant stated in another offset', async () => {
    // The same moment, written as +02:00. `AT TIME ZONE 'UTC'` and
    // `Date.toISOString()` must both resolve it to the same UTC second.
    const sql = await sqlCanonicalHex({ ...base, effectiveAt: '2026-09-22T12:00:00+02:00' });
    expect(sql).toBe(await sqlCanonicalHex({ ...base, effectiveAt: '2026-09-22T10:00:00Z' }));
    expect(fxRateCanonicalStream(tsFacts({ ...base, effectiveAt: '2026-09-22T12:00:00+02:00' })).toString('hex')).toBe(sql);
  });

  it('separates the two directions of one pair, in both implementations', async () => {
    const forward = await sqlCanonicalHex(base);
    const backward = await sqlCanonicalHex({ ...base, fromCurrency: 'ILS', toCurrency: 'USD' });
    expect(backward).not.toBe(forward);
    expect(fxRateCanonicalStream(tsFacts({ ...base, fromCurrency: 'ILS', toCurrency: 'USD' })).toString('hex')).toBe(backward);
  });
});

// ── §57 AL-09's conversion vectors, in both implementations ───────────────

interface ConversionVector {
  readonly name: string;
  readonly txnAmountMinor: bigint;
  readonly txnCurrency: string;
  readonly baseCurrency: string;
  readonly fxRate: string;
  /** The pinned answer. A change here is a change to money already recorded. */
  readonly baseAmountMinor: bigint;
}

/**
 * The seven vectors, as literals.
 *
 * They are written out rather than computed so that a change in either
 * implementation shows up as a failing assertion instead of as two agreeing
 * wrong answers. The two tie cases are the ones that separate HALF_EVEN from
 * HALF_UP: `Math.round`, `toFixed`, IEEE-754 and PostgreSQL's `ROUND()` all
 * round halves away from zero and would give 3 and 2 instead of 2 and 2.
 */
const CONVERSIONS: readonly ConversionVector[] = [
  { name: 'USD(2) → ILS(2)', txnAmountMinor: 10_000n, txnCurrency: 'USD', baseCurrency: 'ILS', fxRate: '3.7200000000', baseAmountMinor: 37_200n },
  { name: 'JOD(3) → ILS(2), rounds up', txnAmountMinor: 70_900n, txnCurrency: 'JOD', baseCurrency: 'ILS', fxRate: '5.2400000000', baseAmountMinor: 37_152n },
  {
    name: 'ILS(2) → JOD(3), the reverse exponent',
    txnAmountMinor: 37_152n,
    txnCurrency: 'ILS',
    baseCurrency: 'JOD',
    fxRate: '0.1908000000',
    baseAmountMinor: 70_886n,
  },
  {
    name: 'LBP(2) → ILS(2), a large amount at a tiny rate',
    txnAmountMinor: 5_000_000_000_000n,
    txnCurrency: 'LBP',
    baseCurrency: 'ILS',
    fxRate: '0.0000111111',
    baseAmountMinor: 55_555_500n,
  },
  {
    name: 'an exact tie whose quotient is even stays even',
    txnAmountMinor: 5n,
    txnCurrency: 'USD',
    baseCurrency: 'ILS',
    fxRate: '0.5000000000',
    baseAmountMinor: 2n,
  },
  {
    name: 'an exact tie whose quotient is odd rounds up',
    txnAmountMinor: 3n,
    txnCurrency: 'USD',
    baseCurrency: 'ILS',
    fxRate: '0.5000000000',
    baseAmountMinor: 2n,
  },
  {
    name: 'at MAX_MONEY_MINOR',
    txnAmountMinor: MAX_MONEY_MINOR,
    txnCurrency: 'USD',
    baseCurrency: 'ILS',
    fxRate: '1.0000000000',
    baseAmountMinor: MAX_MONEY_MINOR,
  },
];

/** A balanced adjustment carrying the same conversion on both sides. */
function conversionCommand(v: ConversionVector, baseAmountMinor: bigint, sourceId: string): PostCommand {
  const scope = v.baseCurrency === 'JOD' ? jod : { tenantId: fx.tenantId, businessId: fx.businessId };
  const at = new Date('2026-03-14T09:15:00Z');
  const line = (systemKey: string, side: 'D' | 'C') => ({
    account: { kind: 'system' as const, systemKey },
    side,
    baseAmountMinor,
    baseCurrency: v.baseCurrency,
    txnAmountMinor: v.txnAmountMinor,
    txnCurrency: v.txnCurrency,
    fxRate: v.fxRate,
    fxRateSource: 'manual' as const,
    fxRateAt: at,
    branchId: null,
    warehouseId: null,
  });
  return {
    tenantId: scope.tenantId,
    businessId: scope.businessId,
    sourceType: 'manual_adjustment',
    sourceId,
    entryDate: today,
    description: 'AL-09 conversion vector',
    requestId: 'req-fx-parity',
    lines: [line('cash', 'D'), line('sales_revenue', 'C')],
  };
}

async function postConversion(v: ConversionVector, baseAmountMinor: bigint): Promise<string> {
  const sourceId = randomUUID();
  const c = conversionCommand(v, baseAmountMinor, sourceId);
  const actorUserId = v.baseCurrency === 'JOD' ? jod.userId : fx.userId;
  const assertion = sourceAssertion({
    actorUserId,
    tenantId: c.tenantId,
    businessId: c.businessId,
    operationKind: 'post',
    sourceType: 'manual_adjustment',
    sourceId,
    postingFingerprint: fingerprintOf(c),
  });
  const r = await postAdjustmentAs(assertion, c, 'an AL-09 conversion vector');
  return r.entryId;
}

describe('AL-09 — the conversion vectors are pinned in both implementations (§57, §58)', () => {
  for (const v of CONVERSIONS) {
    it(`${v.name}: TypeScript computes the pinned value`, () => {
      expect(
        convertToBaseMinor({
          txnAmountMinor: v.txnAmountMinor,
          txnCurrency: v.txnCurrency,
          baseCurrency: v.baseCurrency,
          fxRate: v.fxRate,
        }),
      ).toBe(v.baseAmountMinor);
    });

    it(`${v.name}: PostgreSQL accepts the pinned value at COMMIT`, async () => {
      const entryId = await postConversion(v, v.baseAmountMinor);
      const stored = await pool.query<{ base_amount_minor: string }>(
        `SELECT base_amount_minor FROM journal_lines WHERE journal_entry_id = $1 ORDER BY line_no LIMIT 1`,
        [entryId],
      );
      expect(must(stored.rows[0]).base_amount_minor).toBe(v.baseAmountMinor.toString());
    });

    it(`${v.name}: PostgreSQL refuses one minor unit either way`, async () => {
      for (const wrong of [v.baseAmountMinor - 1n, v.baseAmountMinor + 1n]) {
        const message = await refusal(() => postConversion(v, wrong));
        // At the cap, one unit MORE is refused by the money cap before the
        // arithmetic is reached. Either refusal is the ledger saying no.
        expect(message).toMatch(/accounting\.entry_fx_arithmetic|accounting\.payload_invalid|money_cap/);
      }
    });
  }
});
