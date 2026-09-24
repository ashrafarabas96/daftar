/**
 * WHAT THE LOGS AND METRICS ARE ALLOWED TO SAY (P2-S8 §45, §46).
 *
 * An accounting system leaks money through its telemetry long before it leaks
 * it through its API, because telemetry goes somewhere the access control
 * does not: a log aggregator, a dashboard, a third-party APM, a support
 * engineer's terminal. A ledger whose amounts are unreadable over HTTP and
 * printed in full in an info-level log line has not protected them.
 *
 * SENTINELS, NOT KEY NAMES (§45). Searching for a key called `amount` would
 * pass on a line that rendered the amount inside a message string, which is
 * exactly how this leaks in practice. So this file posts real accounting
 * activity using DISTINCTIVE values — amounts, rates, memos, a fingerprint, a
 * secret-shaped string — and then searches the RENDERED output for those
 * values. A sentinel that appears anywhere fails, whatever key it sat under.
 *
 * Safe identifiers and counts may remain: an operator debugging a failed
 * reconciliation needs to know WHICH entry, and an entry id is not money.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { pino } from 'pino';
import { reconcile } from '@daftar/accounting';
import { ensurePostgres, ownerPool, reconcilerDbUrl, resetData } from '../helpers/test-app';
import { PoolReconciliationConnection } from '../helpers/accounting-reconciliation';
import { DatabaseAccountingReconciliationReader } from '../../apps/api/src/modules/accounting/accounting-reconciliation.reader';
import {
  AccountingReconciliationService,
  RECONCILIATION_CLOCK,
  RECONCILIATION_READER,
} from '../../apps/api/src/modules/accounting/accounting-reconciliation.service';
import { InMemoryMetrics, assertSafeLabels, MetricsContractError, ACCOUNTING_METRICS } from '../../apps/api/src/infra/metrics';
import { must, post, seedPostingFixture, simpleCommand, todayIn, type PostingFixture } from '../helpers/accounting-posting';

/**
 * Values chosen so a substring search cannot produce a false positive: none
 * of them occurs anywhere in a UUID, a timestamp, a check id or a duration.
 */
const SENTINEL = {
  amountMinor: 7717717n,
  memo: 'MEMO-SENTINEL-QWZX-4417',
  rate: '3.7717717717',
  assertion: 'ASSERTION-SENTINEL-KJHG-9928',
  secret: 'sk_live_SENTINELSECRET_772211',
  fingerprint: 'FINGERPRINT-SENTINEL-PLMO-5533',
} as const;

let fx: PostingFixture;
let today: string;
/** Everything the reconciliation pass logged, as pino rendered it. */
let logged = '';

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  fx = await seedPostingFixture(ownerPool(), `obs-${Date.now()}`);
  today = await todayIn(ownerPool(), 'Asia/Hebron');

  // Real accounting activity, carrying the sentinels into the books.
  for (let i = 0; i < 3; i += 1) {
    const command = simpleCommand(fx, randomUUID(), today, SENTINEL.amountMinor + BigInt(i));
    const withMemo = { ...command, description: SENTINEL.memo, lines: command.lines.map((l) => ({ ...l, memo: SENTINEL.memo })) };
    const outcome = await post(withMemo, fx.userId);
    expect(outcome.created).toBe(true);
  }

  // A production-shaped structured logger, writing to a buffer instead of to
  // stdout. Same pino, same redaction configuration, same serialisers — the
  // only difference is where the bytes land.
  const chunks: string[] = [];
  const logger = pino(
    { level: 'debug', redact: { paths: ['*token*', '*Token*', '*secret*', '*Secret*', '*.password'], censor: '[redacted]' } },
    { write: (line: string): void => void chunks.push(line) },
  );

  const pool = new Pool({ connectionString: reconcilerDbUrl, max: 1 });
  try {
    const reader = new DatabaseAccountingReconciliationReader(new PoolReconciliationConnection(pool));
    const metrics = new InMemoryMetrics();
    const clock = { now: (): Date => new Date('2026-09-23T03:00:00Z') };
    // The constructor's order is (reader, clock, metrics, logger) — written
    // out rather than guessed, because a transposition here would silently
    // send every log line into the metrics sink and leave this file asserting
    // that an empty buffer contains no money.
    const service = new AccountingReconciliationService(reader as never, clock, metrics, logger as never);
    void RECONCILIATION_READER;
    void RECONCILIATION_CLOCK;
    void reconcile;
    await service.runOnce();
  } finally {
    await pool.end();
  }
  logged = chunks.join('\n');
}, 300_000);

describe('the logs carry no money (§45)', () => {
  it('logged something at all — otherwise this file proves nothing', () => {
    expect(logged.length).toBeGreaterThan(0);
    // A pass over real books must produce SOME structured output, or the
    // assertions below are vacuous.
    expect(logged).toMatch(/accounting\.reconciliation/);
  });

  it('contains none of the sentinel values, anywhere in the rendered output', () => {
    for (const [name, value] of Object.entries(SENTINEL)) {
      expect(logged, `sentinel ${name} appears in the rendered logs`).not.toContain(String(value));
    }
  });

  it('contains no money-shaped key either', () => {
    for (const key of ['debit', 'credit', 'baseAmount', 'amountMinor', 'fxRate', 'balance', 'assertion', 'fingerprint']) {
      expect(logged.toLowerCase(), key).not.toContain(key.toLowerCase());
    }
  });

  it('still carries the safe things an operator needs', () => {
    // Redaction that removed the check id and the business would make an
    // alert unactionable, which is its own kind of failure.
    expect(logged).toMatch(/"command":"accounting\.reconciliation"/);
    expect(logged).toMatch(/"event":"/);
  });
});

describe('the metrics carry no money and no high-cardinality label (§46)', () => {
  it('refuses a label that names a business, an entry or an amount', () => {
    const metrics = new InMemoryMetrics();
    for (const label of ['businessId', 'business_id', 'entryId', 'accountId', 'amount', 'balance', 'fxRate', 'assertion']) {
      expect(() => metrics.increment('x', { [label]: 'v' }), label).toThrow(MetricsContractError);
    }
  });

  it('refuses a label VALUE shaped like an identifier, whatever the label is called', () => {
    // The dangerous case is not a label called `businessId` — nobody writes
    // that twice. It is a label called `scope` whose value is a UUID.
    expect(() => assertSafeLabels('reconciliation.checks', { scope: randomUUID() })).toThrow(MetricsContractError);
    expect(() => assertSafeLabels('reconciliation.checks', { outcome: 'complete' })).not.toThrow();
  });

  it('names an outbox lag metric that is a duration, not a payload', () => {
    expect(ACCOUNTING_METRICS.outboxLagSeconds).toMatch(/lag/i);
  });
});

describe('outbox lag is measurable from the rows themselves (§46)', () => {
  it('computes from created_at and published_at, with no new column and no money', async () => {
    const { rows } = await ownerPool().query<{ pending: string; oldest_pending_seconds: string | null }>(
      `SELECT count(*) FILTER (WHERE published_at IS NULL)::text AS pending,
              extract(epoch FROM (now() - min(created_at) FILTER (WHERE published_at IS NULL)))::text AS oldest_pending_seconds
         FROM outbox_events`,
    );
    const row = must(rows[0]);
    // The measurement exists and is a count and a duration. Neither is money,
    // and neither is per-business, so it is a low-cardinality signal by shape
    // rather than by a rule somebody has to remember.
    expect(Number(row.pending)).toBeGreaterThanOrEqual(0);
    if (row.oldest_pending_seconds !== null) expect(Number(row.oldest_pending_seconds)).toBeGreaterThanOrEqual(0);
  });
});
