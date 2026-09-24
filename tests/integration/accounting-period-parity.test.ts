/**
 * `acctperiod/1` — ONE SPECIFICATION, TWO IMPLEMENTATIONS (P2-S6 §20).
 *
 * The vectors are the file `packages/accounting/test/period.test.ts` reads,
 * so neither implementation can be edited alone. The comparison is on the
 * canonical BYTES as well as on the digest: a digest tells you two
 * implementations disagree, the bytes tell you which field.
 *
 * The cases that matter most are the ones nobody would think to write by
 * hand — a padded reason, Arabic text, and the two spellings of one accented
 * word. The last pair pins a DELIBERATE decision: the contract takes bytes
 * verbatim, because PostgreSQL cannot Unicode-normalize on a server whose
 * encoding is not UTF8 and DAFTAR does not require one. Both halves must
 * agree that those are two different reasons, rather than one of them quietly
 * folding them together.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { computePeriodFingerprint, periodCanonicalStream, periodReasonDigest, type PeriodCommandFacts } from '../../packages/accounting/src/period';
import { ensurePostgres, ownerPool } from '../helpers/test-app';
import { must } from '../helpers/accounting-posting';

interface Vector {
  name: string;
  why: string;
  facts: PeriodCommandFacts;
  canonicalHex: string;
  fingerprint: string;
}

const vectors = JSON.parse(readFileSync(join(__dirname, '../../packages/accounting/vectors/acctperiod-vectors.json'), 'utf8')) as {
  spec: string;
  cases: Vector[];
};

let pool: Pool;

beforeAll(async () => {
  await ensurePostgres();
  pool = ownerPool();
}, 180_000);

/** The reason digest the DATABASE computes, or null when the case has no reason. */
const sqlReasonDigest = async (reason: string): Promise<string> => {
  const r = await pool.query<{ d: string }>(`SELECT accounting_period_reason_digest($1) AS d`, [reason]);
  return must(r.rows[0]).d;
};

const sqlCanonicalHex = async (f: PeriodCommandFacts): Promise<string> => {
  const digest = f.reason === undefined ? null : await sqlReasonDigest(f.reason);
  const r = await pool.query<{ hex: string }>(
    `SELECT encode(accounting_period_canonical($1, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::date, $7::date, $8), 'hex') AS hex`,
    [f.kind, f.tenantId, f.businessId, f.operationId, f.periodId, f.startDate ?? null, f.endDate ?? null, digest],
  );
  return must(r.rows[0]).hex;
};

const sqlFingerprint = async (f: PeriodCommandFacts): Promise<string> => {
  const digest = f.reason === undefined ? null : await sqlReasonDigest(f.reason);
  const r = await pool.query<{ fp: string }>(`SELECT accounting_period_fingerprint($1, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::date, $7::date, $8) AS fp`, [
    f.kind,
    f.tenantId,
    f.businessId,
    f.operationId,
    f.periodId,
    f.startDate ?? null,
    f.endDate ?? null,
    digest,
  ]);
  return must(r.rows[0]).fp;
};

describe('acctperiod/1 — TypeScript and PostgreSQL agree (§20)', () => {
  it('reads the vector file the package tests read', () => {
    expect(vectors.spec).toBe('acctperiod/1');
    expect(vectors.cases.length).toBeGreaterThanOrEqual(11);
  });

  for (const v of vectors.cases) {
    it(`${v.name}: the canonical stream is byte-identical in both implementations`, async () => {
      const fromSql = await sqlCanonicalHex(v.facts);
      const fromTs = periodCanonicalStream(v.facts).toString('hex');
      expect(fromSql, `${v.name} diverged — ${v.why}`).toBe(fromTs);
      expect(fromSql).toBe(v.canonicalHex);
    });

    it(`${v.name}: the fingerprint is identical in both implementations`, async () => {
      const fromSql = await sqlFingerprint(v.facts);
      expect(fromSql).toBe(computePeriodFingerprint(v.facts));
      expect(fromSql).toBe(v.fingerprint);
    });
  }
});

describe('acctperiod/1 — the details most likely to diverge (§20)', () => {
  const base: PeriodCommandFacts = {
    kind: 'period_create',
    tenantId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    businessId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
    operationId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    periodId: 'c9bf9e57-1685-4c89-bafb-ff5af830be8a',
    startDate: '2026-01-01',
    endDate: '2026-01-31',
  };

  it('separates the three kinds: no create stream can equal a close stream', async () => {
    const create = await sqlCanonicalHex(base);
    const close = await sqlCanonicalHex({ ...base, kind: 'period_close', startDate: undefined, endDate: undefined });
    const reopen = await sqlCanonicalHex({ ...base, kind: 'period_reopen', startDate: undefined, endDate: undefined, reason: 'because' });
    expect(new Set([create, close, reopen]).size).toBe(3);
  });

  it('binds the operation id: the same period under a different key is a different command', async () => {
    const other = await sqlCanonicalHex({ ...base, operationId: '1b4e28ba-2fa1-11d2-9a0c-0305e82c3301' });
    expect(other).not.toBe(await sqlCanonicalHex(base));
    expect(periodCanonicalStream({ ...base, operationId: '1b4e28ba-2fa1-11d2-9a0c-0305e82c3301' }).toString('hex')).toBe(other);
  });

  it('writes the dates as YYYY-MM-DD with no time and no zone, in both implementations', async () => {
    const sql = Buffer.from(await sqlCanonicalHex(base), 'hex').toString('utf8');
    expect(sql).toContain('\n2026-01-01\n2026-01-31\n');
    expect(periodCanonicalStream(base).toString('utf8')).toContain('\n2026-01-01\n2026-01-31\n');
  });

  it('strips exactly SPACE, TAB, LF and CR from a reason, in both implementations', async () => {
    const padded = ' \t\r\nMonth reopened for a late invoice\n\t ';
    expect(await sqlReasonDigest(padded)).toBe(await sqlReasonDigest('Month reopened for a late invoice'));
    expect(periodReasonDigest(padded)).toBe(await sqlReasonDigest(padded));
  });

  it('does NOT strip other Unicode whitespace — the four code points are the contract', async () => {
    // U+00A0 NO-BREAK SPACE. `String.trim()` removes it and `btrim(x)` does
    // not; the contract names neither behaviour, so it must survive on both
    // sides and the two must agree that it did.
    const nbsp = ' Reopened ';
    expect(periodReasonDigest(nbsp)).toBe(await sqlReasonDigest(nbsp));
    expect(periodReasonDigest(nbsp)).not.toBe(periodReasonDigest('Reopened'));
  });

  it('hashes a reason as UTF-8 bytes, so Arabic agrees in both implementations', async () => {
    const arabic = 'أُعيد فتح الفترة بسبب فاتورة متأخرة';
    expect(periodReasonDigest(arabic)).toBe(await sqlReasonDigest(arabic));
  });

  it('treats the two spellings of one accented word as two reasons, in both implementations', async () => {
    const decomposed = 'Cléture';
    const composed = 'Cléture';
    expect(periodReasonDigest(decomposed)).not.toBe(periodReasonDigest(composed));
    expect(await sqlReasonDigest(decomposed)).toBe(periodReasonDigest(decomposed));
    expect(await sqlReasonDigest(composed)).toBe(periodReasonDigest(composed));
  });
});
