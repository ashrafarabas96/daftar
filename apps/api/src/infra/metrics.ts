/**
 * THE METRICS PORT (P2-S8 §28).
 *
 * DAFTAR had no metrics backend before this slice, and the temptation at that
 * point is to reach for a vendor SDK. That would be the wrong trade: it makes
 * one slice slightly easier and every future deployment harder, and it would
 * be the first dependency in this repository chosen for convenience rather
 * than for a property nothing else provides.
 *
 * So this is a port, in the same shape as every other seam here: an interface
 * the runtime depends on, one honest in-process implementation, and a
 * documented deployment decision about where the numbers eventually go. A
 * Prometheus endpoint, an OTLP exporter or a StatsD client all become one
 * adapter in this file's shape, and nothing else in the codebase changes.
 *
 * ONE RULE GOVERNS EVERY CALL. A metric may carry counts, durations and
 * identifiers of KIND — a source type, a check id, an outcome. It may never
 * carry money, a rate, a balance or a business identifier. The first three
 * because §22 and §27 forbid financial truth outside the journal; the last
 * because a label whose value is unbounded turns a metric into an unbounded
 * set of time series, which is how metric backends fall over. `recordSafe`
 * enforces both mechanically rather than by review.
 */

/** A label set. Values are bounded, low-cardinality KINDS — never identifiers. */
export type MetricLabels = Readonly<Record<string, string>>;

export interface MetricSample {
  readonly name: string;
  readonly labels: MetricLabels;
  /** Monotonic total for a counter; the latest observation count for a histogram. */
  readonly count: number;
  /** Sum of observed values. Meaningless for a pure counter, which observes 1. */
  readonly sum: number;
  readonly min: number;
  readonly max: number;
}

export interface Metrics {
  /** Add to a counter. */
  increment(name: string, labels?: MetricLabels, by?: number): void;
  /** Record one observation of a duration or size. */
  observe(name: string, value: number, labels?: MetricLabels): void;
  /** Everything recorded so far. The test surface, and an adapter's read model. */
  snapshot(): readonly MetricSample[];
}

/** Metric names this slice emits. Naming them makes a typo a compile error. */
export const ACCOUNTING_METRICS = {
  postingTotal: 'accounting_posting_total',
  postingDurationMs: 'accounting_posting_duration_ms',
  postingReplayTotal: 'accounting_posting_replay_total',
  unbalancedRejectionTotal: 'accounting_unbalanced_rejection_total',
  reversalTotal: 'accounting_reversal_total',
  periodCloseTotal: 'accounting_period_close_total',
  periodReopenTotal: 'accounting_period_reopen_total',
  reconciliationRunTotal: 'accounting_reconciliation_run_total',
  reconciliationDurationMs: 'accounting_reconciliation_duration_ms',
  reconciliationDiscrepancyTotal: 'accounting_reconciliation_discrepancy_total',
  reconciliationUnavailableTotal: 'accounting_reconciliation_unavailable_total',
  outboxLagSeconds: 'accounting_outbox_lag_seconds',
} as const;

/**
 * A label VALUE must look like a kind, not like data.
 *
 * Lowercase words, digits, dots, colons, dashes and underscores, up to 64
 * characters. `manual_adjustment`, `R-ACC-03`, `discrepancy` and
 * `accounting.reconciliation_unavailable:accounts` all pass. A UUID fails on
 * length grounds only by accident, so identifiers are refused by name below
 * instead of hoping a pattern catches them.
 */
const SAFE_LABEL_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$/;

/**
 * Label names that must never appear, whatever their value.
 *
 * This is the list a reviewer would otherwise have to remember. A metric
 * labelled by business is an unbounded set of time series AND a way to learn
 * which businesses exist from a metrics endpoint; a metric labelled by amount
 * is financial truth outside the journal.
 */
const FORBIDDEN_LABELS = new Set([
  'business',
  'business_id',
  'businessid',
  'tenant',
  'tenant_id',
  'tenantid',
  'entry',
  'entry_id',
  'entryid',
  'account',
  'account_id',
  'accountid',
  'user',
  'user_id',
  'userid',
  'amount',
  'balance',
  'rate',
  'fx_rate',
  'debit',
  'credit',
  'total',
  'assertion',
  'fingerprint',
  'token',
  'secret',
]);

export class MetricsContractError extends Error {}

export function assertSafeLabels(name: string, labels: MetricLabels): void {
  for (const [key, value] of Object.entries(labels)) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_LABELS.has(lower)) {
      throw new MetricsContractError(`metric ${name} may not be labelled by ${key}: it is an identifier or a financial value`);
    }
    if (!SAFE_LABEL_VALUE.test(value)) {
      throw new MetricsContractError(`metric ${name} label ${key} carries a value that is not a bounded kind`);
    }
  }
}

function key(name: string, labels: MetricLabels): string {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k] ?? ''}`);
  return parts.length === 0 ? name : `${name}{${parts.join(',')}}`;
}

/**
 * The in-process recorder.
 *
 * It keeps totals in memory and nothing else: no timer, no background flush,
 * no network. That is deliberate for a first implementation — a metrics port
 * that can lose a process's counters on restart is a normal metrics port, and
 * one that could block a financial command on a network write would not be.
 *
 * WHERE THE NUMBERS GO IN PRODUCTION is a deployment decision this slice
 * reviews rather than makes (see docs/DAFTAR_OBSERVABILITY.md). Until it is
 * made, `snapshot()` is the whole read surface, and it is what the tests
 * assert against.
 */
export class InMemoryMetrics implements Metrics {
  private readonly samples = new Map<string, { name: string; labels: MetricLabels; count: number; sum: number; min: number; max: number }>();

  increment(name: string, labels: MetricLabels = {}, by = 1): void {
    this.record(name, labels, by, true);
  }

  observe(name: string, value: number, labels: MetricLabels = {}): void {
    this.record(name, labels, value, false);
  }

  private record(name: string, labels: MetricLabels, value: number, isCounter: boolean): void {
    assertSafeLabels(name, labels);
    if (!Number.isFinite(value)) throw new MetricsContractError(`metric ${name} observed a value that is not a finite number`);
    const k = key(name, labels);
    const existing = this.samples.get(k);
    if (!existing) {
      this.samples.set(k, { name, labels, count: 1, sum: value, min: value, max: value });
      return;
    }
    existing.count += isCounter ? value : 1;
    existing.sum += value;
    existing.min = Math.min(existing.min, value);
    existing.max = Math.max(existing.max, value);
  }

  snapshot(): readonly MetricSample[] {
    return [...this.samples.values()].map((s) => ({ ...s })).sort((a, b) => key(a.name, a.labels).localeCompare(key(b.name, b.labels)));
  }
}

/** The injection token. */
export const METRICS = 'METRICS';
