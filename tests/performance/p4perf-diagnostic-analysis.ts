/**
 * TL-P4-PERF-A-02 — DIAGNOSTIC ANALYSIS. PURE ARITHMETIC, NO VERDICT.
 *
 * Everything here is a function of a sample series. No clock, no database, no
 * I/O, no global state — so it can be reasoned about and, if anyone wants,
 * tested without a cluster. It computes NO pass/fail: `classify` returns the
 * EVIDENCE FOR each class and the reasons against, and deliberately refuses to
 * pick one, because the ruling reserves that judgement for a human reading the
 * correlations.
 *
 * ── THE TWO PERCENTILE DEFINITIONS IN THIS ESTATE ──────────────────────
 *
 * The two suites under investigation do NOT use the same percentile, and the
 * campaign must reproduce each one exactly or its numbers are about a
 * different statistic than the gate's:
 *
 *   `tests/performance/pos-s3-budgets.test.ts:427`
 *       index = min(n - 1, ceil(q · n) - 1)
 *   `tests/performance/percentile.ts` (accounting)
 *       index = min(n - 1, floor(q · n))
 *
 * At n = 20, q = 0.95 the POS form reads index 18 of 0..19 — THE SECOND-WORST
 * OF TWENTY SAMPLES. At n = 200, q = 0.95 the accounting form reads index 190
 * of 0..199, with nine samples above it. Both are reproduced here, each named
 * for the suite it belongs to, and neither is changed: the ruling freezes the
 * percentile and this module only mirrors it.
 */

/* ══════════════════════════════════════════════════════════════════════
 * 1 — THE PERCENTILES, EACH EXACTLY AS ITS OWN SUITE COMPUTES IT
 * ════════════════════════════════════════════════════════════════════ */

function at(sorted: readonly number[], index: number): number {
  const v = sorted[index];
  if (v === undefined) throw new Error(`p4perf-analysis: no sample at index ${index} of ${sorted.length}`);
  return v;
}

/** `pos-s3-budgets.test.ts:427`'s rank, reproduced: `min(n - 1, ceil(q·n) - 1)`. */
export function posQuantileIndex(count: number, q: number): number {
  return Math.min(count - 1, Math.ceil(q * count) - 1);
}

/** `tests/performance/percentile.ts`'s rank, reproduced: `min(n - 1, floor(q·n))`. */
export function acctQuantileIndex(count: number, q: number): number {
  return Math.min(count - 1, Math.floor(q * count));
}

export type RankFn = (count: number, q: number) => number;

export function quantileBy(samples: readonly number[], q: number, rank: RankFn): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return at(sorted, rank(sorted.length, q));
}

/* ══════════════════════════════════════════════════════════════════════
 * 2 — THE RATIO GATE'S DISCRIMINATING POWER
 * ════════════════════════════════════════════════════════════════════ */

export interface ArmSummary {
  readonly label: string;
  readonly n: number;
  readonly p50: number;
  readonly p95: number;
  readonly p95Index: number;
  readonly min: number;
  readonly max: number;
  /** How far the worst sample sits above the one the verdict reads. */
  readonly maxOverP95: number;
  readonly samplesAboveP95: number;
  readonly orderedSamples: readonly number[];
}

export function summariseArm(label: string, samples: readonly number[], rank: RankFn): ArmSummary {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = rank(sorted.length, 0.95);
  const p95 = at(sorted, idx);
  const max = at(sorted, sorted.length - 1);
  return {
    label,
    n: sorted.length,
    p50: at(sorted, rank(sorted.length, 0.5)),
    p95,
    p95Index: idx,
    min: at(sorted, 0),
    max,
    maxOverP95: p95 === 0 ? Number.NaN : max / p95,
    samplesAboveP95: sorted.length - 1 - idx,
    orderedSamples: [...samples],
  };
}

export interface RatioSensitivity {
  readonly ceiling: number;
  readonly ratio: number;
  readonly breaches: boolean;
  readonly overshootPct: number;
  /** The growth the gate claims to measure, read at the median instead of the tail. */
  readonly p50Ratio: number;
  /** The ratio recomputed at a grid of quantiles: a real growth effect shows at all of them. */
  readonly ratioByQuantile: readonly { readonly q: number; readonly tenIndex: number; readonly fiftyIndex: number; readonly ratio: number }[];
  /**
   * THE SINGLE-SAMPLE LEVERAGE, which is the whole question.
   *
   * At n = 20 the verdict reads the SECOND-WORST sample. So if any one sample
   * that is currently not in the top two becomes slower than the current
   * worst, the arm's p95 jumps from the old second-worst to the OLD WORST —
   * and the ratio moves by exactly that much, with no change in the product's
   * behaviour at all. These two fields are that move, in each direction.
   */
  readonly ratioIfOneMoreStallInFifty: number;
  readonly ratioIfOneMoreStallInTen: number;
  /** Smallest change to each arm's p95 that would put the ratio at the ceiling. */
  readonly fiftyMustFallPct: number;
  readonly tenMustRisePct: number;
  /** Absolute milliseconds behind those percentages — a sub-millisecond answer is the finding. */
  readonly fiftyMustFallMs: number;
  readonly tenMustRiseMs: number;
  /**
   * How many samples in each arm must be inflated to that arm's own observed
   * maximum before the ratio crosses the ceiling. `0` means it already does;
   * `1` means one stray sample is sufficient.
   */
  readonly stallsNeededInFifty: number;
  /** Jackknife: the ratio with each single sample of each arm dropped. */
  readonly jackknife: { readonly minRatio: number; readonly maxRatio: number; readonly spanPct: number };
  /**
   * BOOTSTRAP. Resample both arms with replacement and recompute the ratio, so
   * the gate's own false-positive rate under the observed noise is a number
   * rather than an opinion. Deterministic: a fixed seed, so the figure is
   * reproducible from the recorded series.
   */
  readonly bootstrap: {
    readonly resamples: number;
    readonly p05: number;
    readonly p50: number;
    readonly p95: number;
    readonly fractionBreaching: number;
  };
}

/** A small deterministic PRNG, so the bootstrap is reproducible from the series alone. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function ratioSensitivity(
  ten: readonly number[],
  fifty: readonly number[],
  ceiling: number,
  rank: RankFn,
  resamples = 20_000,
): RatioSensitivity {
  const a = summariseArm('ten', ten, rank);
  const b = summariseArm('fifty', fifty, rank);
  const ratio = b.p95 / a.p95;

  const grid = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99, 1.0];
  const ratioByQuantile = grid.map((q) => {
    const ti = rank(a.n, q);
    const fi = rank(b.n, q);
    return { q, tenIndex: ti, fiftyIndex: fi, ratio: quantileBy(fifty, q, rank) / quantileBy(ten, q, rank) };
  });

  // Jackknife over both arms.
  let minR = Number.POSITIVE_INFINITY;
  let maxR = Number.NEGATIVE_INFINITY;
  const drop = (xs: readonly number[], i: number): number[] => xs.filter((_v, j) => j !== i);
  for (let i = 0; i < ten.length; i += 1) {
    const r = b.p95 / quantileBy(drop(ten, i), 0.95, rank);
    minR = Math.min(minR, r);
    maxR = Math.max(maxR, r);
  }
  for (let i = 0; i < fifty.length; i += 1) {
    const r = quantileBy(drop(fifty, i), 0.95, rank) / a.p95;
    minR = Math.min(minR, r);
    maxR = Math.max(maxR, r);
  }

  // How many samples must be inflated to the arm's own max before the ratio
  // crosses. Inflating k samples pushes the p95 rank up through the sorted
  // series, so it is computed by replacing the k lowest samples with the max.
  let stallsNeededInFifty = -1;
  if (ratio > ceiling) stallsNeededInFifty = 0;
  else {
    const sorted = [...fifty].sort((x, y) => x - y);
    for (let k = 1; k <= sorted.length; k += 1) {
      const perturbed = sorted.map((v, i) => (i < k ? b.max : v));
      if (quantileBy(perturbed, 0.95, rank) / a.p95 > ceiling) {
        stallsNeededInFifty = k;
        break;
      }
    }
  }

  const rnd = mulberry32(0x5eed_1234);
  const pick = (xs: readonly number[]): number[] => {
    const out: number[] = [];
    for (let i = 0; i < xs.length; i += 1) out.push(at(xs, Math.floor(rnd() * xs.length)));
    return out;
  };
  const boots: number[] = [];
  for (let i = 0; i < resamples; i += 1) {
    boots.push(quantileBy(pick(fifty), 0.95, rank) / quantileBy(pick(ten), 0.95, rank));
  }
  boots.sort((x, y) => x - y);
  const bootAt = (q: number): number => at(boots, Math.min(boots.length - 1, Math.floor(q * boots.length)));

  return {
    ceiling,
    ratio,
    breaches: ratio > ceiling,
    overshootPct: (ratio / ceiling - 1) * 100,
    p50Ratio: b.p50 / a.p50,
    ratioByQuantile,
    // One sample slower than the current worst promotes the old worst into the
    // verdict's rank. That is the entire move, and it needs no product change.
    ratioIfOneMoreStallInFifty: b.max / a.p95,
    ratioIfOneMoreStallInTen: b.p95 / a.max,
    fiftyMustFallPct: (1 - ceiling / ratio) * 100,
    tenMustRisePct: (ratio / ceiling - 1) * 100,
    fiftyMustFallMs: b.p95 - ceiling * a.p95,
    tenMustRiseMs: b.p95 / ceiling - a.p95,
    stallsNeededInFifty,
    jackknife: { minRatio: minR, maxRatio: maxR, spanPct: ((maxR - minR) / ratio) * 100 },
    bootstrap: {
      resamples,
      p05: bootAt(0.05),
      p50: bootAt(0.5),
      p95: bootAt(0.95),
      fractionBreaching: boots.filter((r) => r > ceiling).length / boots.length,
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * 3 — WHERE IN THE SERIES THE TAIL SITS
 * ════════════════════════════════════════════════════════════════════ */

export interface TailShape {
  readonly threshold: number;
  readonly slowIndices: readonly number[];
  /** Maximal runs of CONSECUTIVE slow samples. */
  readonly clusters: readonly { readonly from: number; readonly to: number; readonly length: number }[];
  readonly longestCluster: number;
  /**
   * Is the slow set clustered more than chance allows?
   *
   * Under independence, k slow samples among n fall into roughly
   * `k·(n-k)/(n-1) + 1` runs. Many fewer runs than that means the slow samples
   * arrived together — one event stalling several consecutive operations,
   * which is a checkpoint or a vacuum or a host stall, NOT independent noise.
   * Many runs means scattered noise. This is the ordering information a
   * percentile throws away and the reason the raw series is preserved.
   */
  readonly expectedRunsIfIndependent: number;
  readonly observedRuns: number;
  /** Is the tail concentrated in the first few samples (a cold-start signature)? */
  readonly firstQuartileShare: number;
}

export function tailShape(samples: readonly number[], threshold: number): TailShape {
  const slow = samples.map((v, i) => ({ v, i })).filter((x) => x.v >= threshold);
  const idx = slow.map((x) => x.i);
  const clusters: { from: number; to: number; length: number }[] = [];
  for (const i of idx) {
    const last = clusters[clusters.length - 1];
    if (last !== undefined && i === last.to + 1) {
      last.to = i;
      last.length += 1;
    } else clusters.push({ from: i, to: i, length: 1 });
  }
  const n = samples.length;
  const k = idx.length;
  const q1 = Math.max(1, Math.floor(n / 4));
  return {
    threshold,
    slowIndices: idx,
    clusters,
    longestCluster: clusters.reduce((m, c) => Math.max(m, c.length), 0),
    expectedRunsIfIndependent: n <= 1 || k === 0 ? 0 : (k * (n - k)) / (n - 1) + 1,
    observedRuns: clusters.length,
    firstQuartileShare: k === 0 ? 0 : idx.filter((i) => i < q1).length / k,
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * 4 — CORRELATION BETWEEN DURATION AND EVERY COUNTER
 * ════════════════════════════════════════════════════════════════════ */

/** Spearman rank correlation. Rank-based, so a single huge outlier cannot manufacture it. */
export function spearman(x: readonly number[], y: readonly number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return Number.NaN;
  const rank = (v: readonly number[]): number[] => {
    const order = v.map((val, i) => ({ val, i })).sort((a, b) => a.val - b.val);
    const r = new Array<number>(v.length).fill(0);
    let i = 0;
    while (i < order.length) {
      let j = i;
      while (j + 1 < order.length && at(order.map((o) => o.val), j + 1) === at(order.map((o) => o.val), i)) j += 1;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k += 1) {
        const e = order[k];
        if (e !== undefined) r[e.i] = avg;
      }
      i = j + 1;
    }
    return r;
  };
  const rx = rank(x.slice(0, n));
  const ry = rank(y.slice(0, n));
  const mean = (v: readonly number[]): number => v.reduce((s, a) => s + a, 0) / v.length;
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    const a = at(rx, i) - mx;
    const b = at(ry, i) - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx === 0 || dy === 0 ? Number.NaN : num / Math.sqrt(dx * dy);
}

/** Flatten a counter tree to `a.b.c -> number`, so every leaf can be correlated. */
export function flattenNumeric(obj: unknown, prefix = '', out: Record<string, number> = {}): Record<string, number> {
  if (typeof obj === 'number') {
    out[prefix] = obj;
    return out;
  }
  if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) flattenNumeric(v, prefix === '' ? k : `${prefix}.${k}`, out);
  }
  return out;
}

export interface CounterCorrelation {
  readonly counter: string;
  readonly rho: number;
  /** The counter's total over the whole series: a counter that never moved explains nothing. */
  readonly total: number;
  /** Its total over just the slow samples, so a concentrated counter stands out. */
  readonly totalOnSlow: number;
  readonly nonZeroSamples: number;
}

/**
 * Rank-correlate every numeric counter against the duration series.
 *
 * Counters that never move are dropped rather than reported with a `NaN`:
 * "this counter was always zero" is a statement that the mechanism did not
 * occur, and it belongs in the availability report, not in a correlation
 * table where it would look like a measurement.
 */
export function correlateCounters(
  durations: readonly number[],
  counterTrees: readonly (Readonly<Record<string, unknown>> | null)[],
  slowThreshold: number,
): CounterCorrelation[] {
  const flat = counterTrees.map((t) => (t === null ? {} : flattenNumeric(t)));
  const keys = new Set<string>();
  for (const f of flat) for (const k of Object.keys(f)) keys.add(k);

  const out: CounterCorrelation[] = [];
  for (const key of keys) {
    const series = flat.map((f) => f[key] ?? 0);
    const total = series.reduce((s, v) => s + v, 0);
    const nonZero = series.filter((v) => v !== 0).length;
    if (nonZero === 0) continue;
    out.push({
      counter: key,
      rho: spearman(durations, series),
      total,
      totalOnSlow: series.reduce((s, v, i) => s + ((durations[i] ?? 0) >= slowThreshold ? v : 0), 0),
      nonZeroSamples: nonZero,
    });
  }
  return out.sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho));
}

/* ══════════════════════════════════════════════════════════════════════
 * 5 — THE NINE CLASSES, AS EVIDENCE RATHER THAN A VERDICT
 * ════════════════════════════════════════════════════════════════════ */

export type CauseClass = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I';

export interface CauseEvidence {
  readonly cause: CauseClass;
  readonly name: string;
  /** The counters whose movement would implicate this cause, and what they did. */
  readonly instruments: readonly CounterCorrelation[];
  /** Instruments that were asked for and were not available on this server/kernel. */
  readonly unavailable: readonly string[];
  readonly note: string;
}

/** Which flattened counter keys speak to which of the ruling's nine causes. */
export const CAUSE_INSTRUMENTS: Readonly<Record<CauseClass, { name: string; patterns: RegExp[]; note: string }>> = {
  A: {
    name: 'product/database work intrinsic to the operation',
    patterns: [/^pg\.backendIo\./, /^pg\.backendWal\./, /^pg\.db\.(tup_|blks_)/, /^pg\.tables\..*\.(seq_scan|seq_tup_read|idx_scan|idx_tup_fetch)$/, /^cpu\.(userUs|systemUs)$/],
    note: 'The operation did the work itself: its own backend read, wrote or scanned more on slow samples, and it was ON a CPU while doing so.',
  },
  B: {
    name: 'PostgreSQL maintenance',
    patterns: [/^pg\.checkpointer\./, /^pg\.bgwriter\./, /^pg\.vacuumsRunning$/, /^pg\.analyzesRunning$/],
    note: 'A checkpoint or background writer ran. `num_done`/`buffers_written` moving on exactly the slow samples is the signature.',
  },
  C: {
    name: 'WAL / fsync / checkpoint behaviour',
    patterns: [/^pg\.wal\./, /^pg\.io\.wal\//, /^pg\.backendIo\.wal\//, /^pg\.checkpointer\.(write_time|sync_time)$/],
    note: 'WAL volume or an fsync. `backendIo.wal/normal.fsyncs` is the decisive one: the MEASURED backend syncing, not the cluster.',
  },
  D: {
    name: 'autovacuum / analyze',
    patterns: [/^pg\.tables\..*\.(autovacuum_count|autoanalyze_count|vacuum_count|analyze_count|n_dead_tup|n_mod_since_analyze)$/, /^pg\.activity\.autovacuumWorkers$/, /^pg\.vacuumsRunning$/, /^pg\.analyzesRunning$/],
    note: 'A worker was running during the slow samples, or a relation crossed its threshold mid-series.',
  },
  E: {
    name: 'cold-plan and cache behaviour',
    patterns: [/^pg\.backendIo\.relation\/.*\.(reads|hits|evictions)$/, /^pg\.io\.relation\//, /^pg\.db\.(blks_read|blks_hit|blk_read_time)$/],
    note: 'Cache misses. A COLD PLAN shows as a FIRST-SAMPLES effect in the ordering, not as a correlation — see `tailShape.firstQuartileShare`.',
  },
  F: {
    name: 'Node / V8 pause (GC, JIT, event-loop delay)',
    patterns: [/^gcTotalMs$/, /^loop\.(max|p99)$/, /^heapUsedDelta$/, /^faults\.minor$/],
    note: 'A GC pause overlapping the sample window, or event-loop delay inside it. Note the process is ON a CPU during GC, so `cpu.offCpuMs` stays low — that is what separates F from G.',
  },
  G: {
    name: 'host CPU scheduling',
    patterns: [/^host\.psiCpu(Some|Full)Us$/, /^host\.cpuStealTicks$/, /^host\.runnable$/, /^ctxSwitches\.involuntary$/, /^host\.(throttledTimeNs|nrThrottled)$/, /^cpu\.offCpuMs$/],
    note: 'The process wanted a CPU and did not have one: PSI cpu pressure, steal, involuntary preemption, and a large `cpu.offCpuMs` with NO io pressure.',
  },
  H: {
    name: 'host I/O contention',
    patterns: [/^host\.psiIo(Some|Full)Us$/, /^host\.cpuIowaitTicks$/, /^host\.majorFaults$/, /^faults\.major$/],
    note: 'The box stalled on storage: PSI io pressure and iowait, with `cpu.offCpuMs` large and PSI cpu flat.',
  },
  I: {
    name: 'unrelated container activity',
    patterns: [/^host\.othersTicks$/, /^host\.cpuBusyTicks$/, /^host\.loadavg1$/, /^pg\.activity\.activeBackends$/],
    note: 'CPU burned by neither this process nor the measured backend. `othersTicks` is the residue after subtracting both, which is what turns "I waited" (G) into "and here is who took it" (I).',
  },
};

/**
 * ASSEMBLE THE EVIDENCE PER CLASS AND STOP THERE.
 *
 * This deliberately returns no winner. The ruling makes the classification a
 * judgement with consequences — Class R in particular "needs the strongest
 * evidence of the three, not the weakest" — and a function that picked a
 * class from correlation coefficients would be exactly the "we don't know but
 * here is a number" the owner forbade. So the harness lays out, for each
 * cause, which instruments moved, how strongly they ranked against duration,
 * and which instruments were not available at all; a human reads it.
 */
export function assembleEvidence(correlations: readonly CounterCorrelation[], unavailable: Readonly<Record<string, string[]>>): CauseEvidence[] {
  return (Object.keys(CAUSE_INSTRUMENTS) as CauseClass[]).map((cause) => {
    const spec = CAUSE_INSTRUMENTS[cause];
    return {
      cause,
      name: spec.name,
      instruments: correlations.filter((c) => spec.patterns.some((p) => p.test(c.counter))),
      unavailable: unavailable[cause] ?? [],
      note: spec.note,
    };
  });
}

/** One flat numeric view of a whole sample record, so `correlateCounters` can see host and Node leaves too. */
export function sampleFeatures(r: {
  readonly cpu: { readonly userUs: number; readonly systemUs: number; readonly offCpuMs: number };
  readonly loop: { readonly max: number; readonly mean: number; readonly p99: number };
  readonly gcTotalMs: number;
  readonly faults: { readonly major: number; readonly minor: number };
  readonly ctxSwitches: { readonly involuntary: number; readonly voluntary: number };
  readonly heapUsedDelta: number;
  readonly gapMs: number;
  readonly host: Readonly<Record<string, number>>;
  readonly pg: Readonly<Record<string, unknown>> | null;
}): Record<string, unknown> {
  return {
    cpu: r.cpu,
    loop: r.loop,
    gcTotalMs: r.gcTotalMs,
    faults: r.faults,
    ctxSwitches: r.ctxSwitches,
    heapUsedDelta: r.heapUsedDelta,
    gapMs: r.gapMs,
    host: r.host,
    pg: r.pg,
  };
}
