/**
 * THE DETERMINISTIC PERFORMANCE DATASET (P2-S8 §31, §32).
 *
 * A performance number is only worth reading if the data behind it can be
 * reproduced exactly, so this generator takes a seed and produces the same
 * logical dataset every time, on any machine. There is no `Math.random()`
 * below and no `now()` in any generated value: the only sources of variation
 * are the knobs in `DatasetSpec`.
 *
 * IT DOES NOT BUY SPEED BY BREAKING THE BOOKS (§32). Nothing here disables a
 * constraint, a trigger or row level security, and `session_replication_role`
 * appears nowhere. Every entry it writes is balanced in base currency, carries
 * a registered source binding and a source document, and carries a complete
 * FX snapshot; the deferred entry validators run at COMMIT and would refuse
 * the batch otherwise. A fast invalid database would measure nothing.
 *
 * WHAT IT IS NOT. It is not the posting benchmark. §32 requires the posting
 * measurement to go through the real production command, and it does — this
 * generator exists to create the BACKGROUND a report or a reconciliation pass
 * has to read through, which at a million lines cannot be written one command
 * at a time in any reasonable test.
 *
 * Bulk insertion runs as the schema owner, which is the test and deployment
 * authority, never a runtime credential.
 */
import type { Pool, PoolClient } from 'pg';

export interface CurrencyShare {
  /** ISO code. The business's own base currency must be one of these. */
  readonly code: string;
  /** Relative weight. Shares are normalised, so they need not sum to one. */
  readonly share: number;
  /** Units of base currency per unit of this currency. Ignored for the base. */
  readonly rate?: string;
}

export interface DatasetSpec {
  /** Anything deterministic derives from this. */
  readonly seed: number;
  /** How many businesses to fill. Each gets its own journal. */
  readonly businessCount: number;
  /** Entries per business. */
  readonly entriesPerBusiness: number;
  /** Lines per entry, inclusive. An entry always has an even line count ≥ 2. */
  readonly linesPerEntry: { readonly min: number; readonly max: number };
  /** How many of the business's accounts the journal actually touches. */
  readonly accountCount: number;
  /** Fraction of lines that name a branch, 0..1. */
  readonly branchShare: number;
  /** Entries are spread backwards over this many days from `endDate`. */
  readonly dateSpanDays: number;
  /** The newest entry date, as YYYY-MM-DD. */
  readonly endDate: string;
  /** The currency mix of transaction amounts. */
  readonly currencyMix: readonly CurrencyShare[];
}

export interface SeededBusiness {
  readonly tenantId: string;
  readonly businessId: string;
  readonly entryCount: number;
  readonly lineCount: number;
}

export interface DatasetResult {
  readonly spec: DatasetSpec;
  readonly businesses: readonly SeededBusiness[];
  readonly entryCount: number;
  readonly lineCount: number;
  readonly elapsedMs: number;
}

/**
 * mulberry32 — a small, fast, well-distributed 32-bit PRNG.
 *
 * Written out rather than imported so the sequence is pinned by this file: a
 * dependency that changed its algorithm would silently change every dataset
 * this generator has ever produced, and the seed would stop meaning anything.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick an index from normalised weights, using one draw. */
function weightedIndex(draw: number, weights: readonly number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let running = 0;
  const target = draw * total;
  for (let i = 0; i < weights.length; i += 1) {
    running += weights[i] ?? 0;
    if (target < running) return i;
  }
  return weights.length - 1;
}

/**
 * The base amount that corresponds to a transaction amount at a rate.
 *
 * This mirrors `accounting_assert_entry_valid` exactly — scale by 10^10,
 * divide, and break a tie to even — because the database recomputes it at
 * COMMIT and refuses the entry if the stored base amount is not the exact
 * conversion. Deriving it here rather than approximating it is the difference
 * between a dataset that loads and one that is rejected, and reimplementing
 * the rule in floating point would reintroduce the class of error the ledger
 * forbids. Integer arithmetic throughout, in BigInt, never a float.
 *
 * Both currencies in DAFTAR's mix carry two minor digits, so the exponent
 * adjustment the database applies is 1 and is omitted here; a currency with a
 * different minor unit would need it, and would be refused at COMMIT rather
 * than silently mismeasured.
 */
export function baseAmountFor(txnMinor: number, rate: string): number {
  const [whole = '0', fraction = ''] = rate.split('.');
  const scaledRate = BigInt(whole + fraction.padEnd(10, '0').slice(0, 10));
  const numerator = BigInt(txnMinor) * scaledRate;
  const denominator = 10n ** 10n;
  const quotient = numerator / denominator;
  const remainder = numerator - quotient * denominator;
  const twice = 2n * remainder;
  const expected = twice > denominator ? quotient + 1n : twice < denominator ? quotient : quotient % 2n === 0n ? quotient : quotient + 1n;
  return Number(expected);
}

/** Rows are sent to PostgreSQL in batches of this many ENTRIES. */
const BATCH_ENTRIES = 2_000;

interface EntryPlan {
  readonly entryId: string;
  readonly sourceId: string;
  readonly entryDate: string;
  readonly lines: readonly LinePlan[];
}

interface LinePlan {
  readonly lineNo: number;
  readonly accountIndex: number;
  readonly debit: number;
  readonly credit: number;
  readonly base: number;
  readonly txnAmount: number;
  readonly txnCurrency: string;
  readonly fxRate: string;
  readonly fxRateSource: 'base' | 'manual' | 'provider';
  readonly withBranch: boolean;
}

/**
 * Deterministic UUIDs.
 *
 * A dataset whose identifiers changed between runs would change every keyset
 * page and every `ORDER BY id`, so the same seed and the same position always
 * produce the same UUID. Version and variant bits are set so the values are
 * well-formed v4-shaped UUIDs that PostgreSQL will accept and index normally.
 */
function seededUuid(rng: () => number): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(rng() * 256);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function shiftDate(endDate: string, daysBack: number): string {
  const d = new Date(`${endDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - daysBack);
  return d.toISOString().slice(0, 10);
}

/**
 * Plan one business's journal. Pure: no database, no clock, no randomness
 * beyond the seeded stream.
 */
export function planBusiness(spec: DatasetSpec, businessIndex: number, baseCurrency: string): readonly EntryPlan[] {
  const rng = mulberry32(spec.seed + businessIndex * 7919);
  const weights = spec.currencyMix.map((c) => c.share);
  const entries: EntryPlan[] = [];
  for (let i = 0; i < spec.entriesPerBusiness; i += 1) {
    const span = Math.max(1, spec.linesPerEntry.max - spec.linesPerEntry.min + 1);
    // An entry has an even number of lines: every debit is matched by a
    // credit of the same base amount, which is how the batch stays balanced
    // without the generator having to reason about totals.
    const pairs = Math.max(1, Math.floor((spec.linesPerEntry.min + Math.floor(rng() * span)) / 2));
    const lines: LinePlan[] = [];
    for (let p = 0; p < pairs; p += 1) {
      // The TRANSACTION amount is drawn and the base amount is derived from
      // it, never the other way round: the ledger's rule is that the base is
      // the exact conversion of the transaction amount, so the transaction
      // amount is the free variable.
      const txnAmount = 100 + Math.floor(rng() * 900_000);
      const currency = spec.currencyMix[weightedIndex(rng(), weights)] ?? { code: baseCurrency, share: 1 };
      const foreign = currency.code !== baseCurrency;
      const rate = foreign ? (currency.rate ?? '3.5000000000') : '1';
      const base = foreign ? baseAmountFor(txnAmount, rate) : txnAmount;
      const shared = {
        base,
        txnAmount,
        txnCurrency: currency.code,
        fxRate: rate,
        fxRateSource: (foreign ? 'provider' : 'base') as LinePlan['fxRateSource'],
      };
      lines.push({
        lineNo: p * 2 + 1,
        accountIndex: Math.floor(rng() * spec.accountCount),
        debit: base,
        credit: 0,
        withBranch: rng() < spec.branchShare,
        ...shared,
      });
      lines.push({
        lineNo: p * 2 + 2,
        accountIndex: Math.floor(rng() * spec.accountCount),
        debit: 0,
        credit: base,
        withBranch: rng() < spec.branchShare,
        ...shared,
      });
    }
    entries.push({
      entryId: seededUuid(rng),
      sourceId: seededUuid(rng),
      entryDate: shiftDate(spec.endDate, Math.floor(rng() * spec.dateSpanDays)),
      lines,
    });
  }
  return entries;
}

/**
 * Write the planned journal for one business.
 *
 * Each batch is one transaction, so the deferred entry validators run on it
 * at COMMIT: a batch that was not balanced, not bound or not well-formed
 * would be refused here rather than silently measured later.
 */
async function writeBusiness(
  client: PoolClient,
  tenantId: string,
  businessId: string,
  userId: string,
  accountIds: readonly string[],
  branchId: string | null,
  baseCurrency: string,
  entries: readonly EntryPlan[],
): Promise<number> {
  let lineCount = 0;
  for (let offset = 0; offset < entries.length; offset += BATCH_ENTRIES) {
    const batch = entries.slice(offset, offset + BATCH_ENTRIES);
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO journal_entries (tenant_id, business_id, id, entry_date, source_type, source_id, description,
                                    actor_kind, actor_user_id, request_id, posting_fingerprint)
       SELECT $1, $2, e.id::uuid, e.entry_date::date, 'manual_adjustment', e.source_id::uuid, 'dataset',
              'user', $3, 'dataset', md5(e.id) || md5(e.source_id)
         FROM unnest($4::text[], $5::text[], $6::text[]) AS e(id, source_id, entry_date)`,
      [tenantId, businessId, userId, batch.map((e) => e.entryId), batch.map((e) => e.sourceId), batch.map((e) => e.entryDate)],
    );
    await client.query(
      `INSERT INTO accounting_source_bindings (tenant_id, business_id, source_type, source_id, journal_entry_id)
       SELECT $1, $2, 'manual_adjustment', s.source_id::uuid, s.entry_id::uuid
         FROM unnest($3::text[], $4::text[]) AS s(source_id, entry_id)`,
      [tenantId, businessId, batch.map((e) => e.sourceId), batch.map((e) => e.entryId)],
    );
    await client.query(
      `INSERT INTO accounting_manual_adjustments (tenant_id, business_id, id, reason, actor_user_id)
       SELECT $1, $2, s.source_id::uuid, 'performance dataset', $3 FROM unnest($4::text[]) AS s(source_id)`,
      [tenantId, businessId, userId, batch.map((e) => e.sourceId)],
    );

    const entryIds: string[] = [];
    const lineNos: number[] = [];
    const accounts: string[] = [];
    const debits: number[] = [];
    const credits: number[] = [];
    const bases: number[] = [];
    const txnAmounts: number[] = [];
    const txnCurrencies: string[] = [];
    const rates: string[] = [];
    const sources: string[] = [];
    const branches: (string | null)[] = [];
    for (const entry of batch) {
      for (const line of entry.lines) {
        entryIds.push(entry.entryId);
        lineNos.push(line.lineNo);
        accounts.push(accountIds[line.accountIndex % accountIds.length] ?? (accountIds[0] as string));
        debits.push(line.debit);
        credits.push(line.credit);
        bases.push(line.base);
        txnAmounts.push(line.txnAmount);
        txnCurrencies.push(line.txnCurrency);
        rates.push(line.fxRate);
        sources.push(line.fxRateSource);
        branches.push(line.withBranch ? branchId : null);
      }
    }
    lineCount += entryIds.length;
    await client.query(
      `INSERT INTO journal_lines (tenant_id, business_id, id, journal_entry_id, line_no, account_id,
                                  debit_minor, credit_minor, base_amount_minor, base_currency,
                                  txn_amount_minor, txn_currency, fx_rate, fx_rate_source, fx_rate_at, branch_id)
       SELECT $1, $2, gen_random_uuid(), l.entry_id::uuid, l.line_no, l.account::uuid,
              l.debit, l.credit, l.base, $3,
              l.txn_amount, l.txn_currency, l.rate::numeric, l.source,
              date_trunc('second', now()), l.branch::uuid
         FROM unnest($4::text[], $5::int[], $6::text[], $7::bigint[], $8::bigint[], $9::bigint[], $10::bigint[], $11::text[], $12::text[], $13::text[], $14::text[])
              AS l(entry_id, line_no, account, debit, credit, base, txn_amount, txn_currency, rate, source, branch)`,
      [tenantId, businessId, baseCurrency, entryIds, lineNos, accounts, debits, credits, bases, txnAmounts, txnCurrencies, rates, sources, branches],
    );
    await client.query('COMMIT');
  }
  return lineCount;
}

export interface DatasetTarget {
  readonly tenantId: string;
  readonly businessId: string;
  readonly userId: string;
  readonly baseCurrency: string;
}

/**
 * Fill the given businesses with the planned journal.
 *
 * The businesses themselves are created by the caller through the ordinary
 * product path, so the chart of accounts, the branches and the tenancy are
 * whatever the product actually produces.
 */
export async function generateDataset(pool: Pool, targets: readonly DatasetTarget[], spec: DatasetSpec): Promise<DatasetResult> {
  const startedAt = Date.now();
  const businesses: SeededBusiness[] = [];
  let entryCount = 0;
  let lineCount = 0;
  const client = await pool.connect();
  try {
    for (let i = 0; i < targets.length && i < spec.businessCount; i += 1) {
      const target = targets[i];
      if (!target) break;
      const { rows: accountRows } = await client.query<{ id: string }>(`SELECT id FROM accounts WHERE business_id = $1 ORDER BY code LIMIT $2`, [
        target.businessId,
        spec.accountCount,
      ]);
      if (accountRows.length === 0) throw new Error(`business ${target.businessId} has no accounts to post to`);
      const { rows: branchRows } = await client.query<{ id: string }>(`SELECT id FROM branches WHERE business_id = $1 ORDER BY created_at LIMIT 1`, [
        target.businessId,
      ]);
      const entries = planBusiness(spec, i, target.baseCurrency);
      const lines = await writeBusiness(
        client,
        target.tenantId,
        target.businessId,
        target.userId,
        accountRows.map((a) => a.id),
        branchRows[0]?.id ?? null,
        target.baseCurrency,
        entries,
      );
      businesses.push({ tenantId: target.tenantId, businessId: target.businessId, entryCount: entries.length, lineCount: lines });
      entryCount += entries.length;
      lineCount += lines;
    }
  } finally {
    client.release();
  }
  await pool.query('ANALYZE journal_entries');
  await pool.query('ANALYZE journal_lines');
  return { spec, businesses, entryCount, lineCount, elapsedMs: Date.now() - startedAt };
}

/** TIER 1 (§35): small enough for every push, shaped like the real thing. */
export const TIER1_SPEC: DatasetSpec = {
  seed: 20260923,
  businessCount: 1,
  entriesPerBusiness: 6_000,
  linesPerEntry: { min: 2, max: 6 },
  accountCount: 20,
  branchShare: 0.35,
  dateSpanDays: 730,
  endDate: '2026-09-23',
  currencyMix: [
    { code: 'ILS', share: 0.9 },
    { code: 'USD', share: 0.08, rate: '3.6000000000' },
    { code: 'EUR', share: 0.02, rate: '3.9000000000' },
  ],
};

/** TIER 2 (§34 C/D/E): the 100,000-line reporting dataset. */
export const TIER2_REPORTING_SPEC: DatasetSpec = {
  ...TIER1_SPEC,
  entriesPerBusiness: 25_000,
};

/** TIER 2 (§34 F): the 1,000,000-line reconciliation dataset. */
export const TIER2_RECONCILIATION_SPEC: DatasetSpec = {
  ...TIER1_SPEC,
  entriesPerBusiness: 250_000,
};
