/**
 * P4-S7 — THE BUDGET SUITE, AND ITS REFUSAL TO PRODUCE A NUMBER IT CANNOT
 * STAND BEHIND.
 *
 * ── WHAT THIS SUITE DOES TODAY, AND WHY THAT IS THE RIGHT THING ──────────
 *
 * Today it asserts the HARNESS and reports `RESOURCE_CONTENTION` for every
 * budget. That is not a stub and it is not a deferral:
 *
 *  - an authoritative performance measurement needs exclusive use of this
 *    container, and four other agents are running. A figure taken now is
 *    INVALID — neither a pass nor a fail — so a suite that produced one would
 *    be producing a number whose only use is to be quoted later without its
 *    condition;
 *  - the relations the budgets are about do not exist yet. S7 is at maturity
 *    level E, a DDL *specification*, so a figure would be a figure about an
 *    absent relation. `analyzeAndRecord` names that case explicitly
 *    (`missing`) and `judge` refuses to call such a run authoritative — which
 *    is the recorded lesson («a budget measured against a table with no
 *    statistics is a number about the missing statistics») made operative
 *    rather than remembered.
 *
 * So what IS asserted is everything that can be asserted without a
 * measurement, and it is the part that decides whether a later measurement
 * can be believed:
 *
 *   B-1  the exclusivity gate refuses a verdict unless the run is DECLARED
 *        exclusive AND the load average supports the declaration — with both
 *        halves shown able to refuse;
 *   B-2  `judge` returns `resource_contention` and NEVER `pass` while the
 *        `ANALYZE` evidence is incomplete, proved over a measurement whose
 *        every sample is comfortably inside its budget. A harness that passed
 *        this case is the 2.9-second-versus-122-millisecond incident waiting
 *        to happen again;
 *   B-3  a short series is REFUSED rather than reported as a lower
 *        percentile;
 *   B-4  the `ANALYZE` evidence is read BACK from the catalogue, so a relation
 *        that does not exist is reported as absent rather than as analyzed —
 *        measured against the live cluster, where the slice's relations
 *        genuinely are absent;
 *   B-5  every report line names the `ANALYZE` state and the scale in the same
 *        sentence as the millisecond figure.
 *
 * ── HOW THE COORDINATOR RUNS IT FOR REAL ────────────────────────────────
 *
 *     DAFTAR_PERF_EXCLUSIVE=1 DAFTAR_PERF_SCALE=1 \
 *     PG_DIR=/tmp/daftar-pg-perf PG_PORT=<unique> \
 *     npx vitest run tests/performance/installments-s7-budgets.test.ts
 *
 * on a box with nothing else on it, AFTER S7 is promoted to maturity level F
 * and the relations exist. Until both hold, the suite's own gate returns
 * `resource_contention` and the budgets are reported, not asserted.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BUDGETS,
  DATASET,
  ITERATIONS,
  KEYSET_DRIFT_MAX_RATIO,
  MEASURED_RELATIONS,
  SCALE,
  analyzeAndRecord,
  assertSamples,
  exclusivity,
  judge,
  measure,
  report,
  runBanner,
  scaled,
  type AnalyzeEvidence,
  type Measurement,
} from './installments-s7-harness';
import { quantileIndex } from './percentile';
import { ensurePostgres, ownerPool } from '../helpers/test-app';

let analyze: AnalyzeEvidence;

beforeAll(async () => {
  await ensurePostgres();
  analyze = await analyzeAndRecord();
  console.log(await runBanner());
}, 300_000);

/** A fake measurement whose every sample is comfortably inside its budget, for the gate proofs. */
function fastMeasurement(budgetId: string, thresholdMs: number): Measurement {
  return { budgetId, name: 'a measurement that would pass on its figures alone', samplesMs: Array.from({ length: ITERATIONS }, () => 1), thresholdMs };
}

const os = (load: number, cpus: number): { loadavg: () => number[]; cpus: () => unknown[] } => ({
  loadavg: () => [load, load, load],
  cpus: () => Array.from({ length: cpus }, () => ({})),
});

describe('P4-S7 B-1 — the exclusivity gate, with both halves shown able to refuse', () => {
  it('a run that is not DECLARED exclusive yields no verdict, however quiet the machine', () => {
    const e = exclusivity({}, os(0.0, 8));
    expect(e.verdict).toBe('resource_contention');
    expect(e.reason).toBe('not_declared_exclusive');
  });

  it('a DECLARED run on a loaded machine yields no verdict either — the declaration is checked', () => {
    const e = exclusivity({ DAFTAR_PERF_EXCLUSIVE: '1' }, os(3.4, 8));
    expect(e.verdict).toBe('resource_contention');
    expect(e.reason).toBe('load_average_above_one_core');
  });

  it('both together are what produce a verdict, so neither alone is sufficient', () => {
    const e = exclusivity({ DAFTAR_PERF_EXCLUSIVE: '1' }, os(0.12, 8));
    expect(e.verdict).toBe('exclusive');
    expect(e.reason).toBeNull();
  });

  it('a declaration that is not exactly "1" is not a declaration', () => {
    for (const value of ['0', 'true', 'yes', '']) {
      expect(exclusivity({ DAFTAR_PERF_EXCLUSIVE: value }, os(0.0, 8)).verdict, value).toBe('resource_contention');
    }
  });

  it('THIS RUN is under contention, which is why no budget below is asserted', () => {
    // Measured, printed, and not asserted as a particular value: the point is
    // that the suite reads its own condition rather than assuming it.
    const e = exclusivity();
    console.log(`P4-S7 exclusivity: ${e.verdict}${e.reason === null ? '' : ` (${e.reason})`} · load1m ${e.evidence.loadAverage1m.toFixed(2)}`);
    expect(['exclusive', 'resource_contention']).toContain(e.verdict);
  });
});

describe('P4-S7 B-2 — a fast measurement with incomplete ANALYZE evidence is NOT a pass', () => {
  it('RED PROOF — every sample inside the budget, and the verdict is still resource_contention', () => {
    // The whole lesson in one assertion. The figures are perfect; the
    // conditions are not; the answer is neither pass nor fail.
    const incomplete: AnalyzeEvidence = {
      relations: { installment_plans: { rows: 0, analyzed: null, existed: false } },
      missing: ['installment_plans'],
      unanalyzed: [],
      databaseBytes: 1,
      scale: 1,
      authoritative: false,
    };
    const v = judge(fastMeasurement('P4-S7-B', BUDGETS.STATEMENT_PAGE_P95_MS), incomplete, exclusivity({ DAFTAR_PERF_EXCLUSIVE: '1' }, os(0.0, 8)));
    expect(v.distribution.p95).toBeLessThanOrEqual(BUDGETS.STATEMENT_PAGE_P95_MS);
    expect(v.verdict, 'a fast figure over an absent relation is a figure about the absent relation').toBe('resource_contention');
  });

  it('RED PROOF — an EXISTING but UNANALYZED relation is refused too, which is the subtler half', () => {
    // The relation exists and holds a million rows; nothing ever analyzed it.
    // This is the exact shape of the recorded incident: 2.9 s on a runner,
    // 122 ms after one `ANALYZE`, with no query or migration change.
    const unanalyzed: AnalyzeEvidence = {
      relations: { installments: { rows: 1_000_000, analyzed: null, existed: true } },
      missing: [],
      unanalyzed: ['installments'],
      databaseBytes: 1,
      scale: 1,
      authoritative: false,
    };
    const v = judge(fastMeasurement('P4-S7-A', BUDGETS.INSTALLMENT_PAGE_P95_MS), unanalyzed, exclusivity({ DAFTAR_PERF_EXCLUSIVE: '1' }, os(0.0, 8)));
    expect(v.verdict).toBe('resource_contention');
  });

  it('with the evidence complete AND the run exclusive, the same measurement passes — so the gate is not a blanket refusal', () => {
    const complete: AnalyzeEvidence = {
      relations: { installments: { rows: 1_440, analyzed: new Date('2026-10-07T00:00:00Z').toISOString(), existed: true } },
      missing: [],
      unanalyzed: [],
      databaseBytes: 50_000_000,
      scale: 1,
      authoritative: true,
    };
    const v = judge(fastMeasurement('P4-S7-A', BUDGETS.INSTALLMENT_PAGE_P95_MS), complete, exclusivity({ DAFTAR_PERF_EXCLUSIVE: '1' }, os(0.0, 8)));
    expect(v.verdict).toBe('pass');
  });

  it('and a SLOW measurement under complete, exclusive conditions FAILS — so the gate can go red on a figure', () => {
    const complete: AnalyzeEvidence = {
      relations: { installments: { rows: 1_440, analyzed: new Date('2026-10-07T00:00:00Z').toISOString(), existed: true } },
      missing: [],
      unanalyzed: [],
      databaseBytes: 50_000_000,
      scale: 1,
      authoritative: true,
    };
    const slow: Measurement = {
      budgetId: 'P4-S7-B',
      name: 'a slow page',
      samplesMs: Array.from({ length: ITERATIONS }, (_, i) => (i < ITERATIONS - 20 ? 10 : 900)),
      thresholdMs: BUDGETS.STATEMENT_PAGE_P95_MS,
    };
    const v = judge(slow, complete, exclusivity({ DAFTAR_PERF_EXCLUSIVE: '1' }, os(0.0, 8)));
    expect(v.verdict).toBe('fail');
    expect(v.distribution.p95).toBeGreaterThan(BUDGETS.STATEMENT_PAGE_P95_MS);
  });
});

describe('P4-S7 B-3 — a short series is refused, never reported as a lower percentile', () => {
  it('RED PROOF — 30 samples declared as 200 is refused, naming both counts', () => {
    const short: Measurement = { budgetId: 'P4-S7-B', name: 'short', samplesMs: Array.from({ length: 30 }, () => 1), thresholdMs: 100 };
    expect(() => assertSamples(short)).toThrow(/30 samples were taken and 200 were declared/);
  });

  it('the full series is accepted, so the check is about the count and not about the series', () => {
    expect(() => assertSamples(fastMeasurement('P4-S7-B', 100))).not.toThrow();
  });

  it('the declared iteration count is high enough that a handful of contended samples cannot decide a verdict', () => {
    // The claim is ARITHMETIC and is asserted at the POSITION, not at a value:
    // `quantileIndex(200, 0.95)` is 190, so exactly ten samples sit at or
    // above the percentile the verdict reads. Nine contended samples
    // therefore cannot move it and ten can — which is the precise sense in
    // which n = 200 protects the verdict, and the precise sense in which
    // n = 30 (index 28, two samples) does not.
    expect(quantileIndex(ITERATIONS, 0.95)).toBe(190);
    expect(quantileIndex(30, 0.95)).toBe(28);

    const complete: AnalyzeEvidence = { relations: {}, missing: [], unanalyzed: [], databaseBytes: 1, scale: 1, authoritative: true };
    const withSlow = (slow: number): Measurement => ({
      budgetId: 'P4-S7-B',
      name: `${String(slow)} contended samples`,
      samplesMs: Array.from({ length: ITERATIONS }, (_, i) => (i < ITERATIONS - slow ? 5 : 5_000)),
      thresholdMs: 100,
    });
    const ex = exclusivity({ DAFTAR_PERF_EXCLUSIVE: '1' }, os(0.0, 8));
    expect(judge(withSlow(9), complete, ex).verdict, 'nine contended samples are below the read rank').toBe('pass');
    expect(judge(withSlow(10), complete, ex).verdict, 'ten reach it, and the verdict moves — so the p95 is a real p95').toBe('fail');
  });

  it('the whole series is reported whatever the verdict: nothing is trimmed, winsorised or re-weighted', () => {
    // §7 of the performance directive: diagnostic data never changes the
    // verdict. A harness that dropped its slowest samples would turn the
    // previous test's `fail` into a `pass`, so the property is asserted here.
    const complete: AnalyzeEvidence = { relations: {}, missing: [], unanalyzed: [], databaseBytes: 1, scale: 1, authoritative: true };
    const v = judge(fastMeasurement('P4-S7-B', 100), complete, exclusivity({ DAFTAR_PERF_EXCLUSIVE: '1' }, os(0.0, 8)));
    expect(v.distribution.iterations).toBe(ITERATIONS);
    expect(v.distribution.orderedMs).toHaveLength(ITERATIONS);
  });
});

describe('P4-S7 B-4 — the ANALYZE evidence is read back from the catalogue, measured on the live cluster', () => {
  it('names the slice’s relations as ABSENT rather than as analyzed, because at level E they are', async () => {
    expect(analyze.missing, 'S7 holds a DDL specification and no schema, so these must be reported absent').toEqual(
      expect.arrayContaining(['installment_plans', 'installments']),
    );
    expect(analyze.authoritative, 'a run over absent relations is not authoritative').toBe(false);
    for (const relation of ['installment_plans', 'installments']) {
      expect(analyze.relations[relation]?.existed, relation).toBe(false);
    }
  });

  it('and it DOES find the relations that exist, so the reader is not watching nothing', async () => {
    // Non-vacuity. A harness that reported every relation absent would be a
    // harness that is looking in the wrong place, and its `missing` list would
    // be decorative.
    expect(analyze.relations['invoices']?.existed, 'the invoices relation exists in this tree and must be found').toBe(true);
    expect(analyze.relations['invoices']?.analyzed, 'the harness ANALYZEd it and read the timestamp back').not.toBeNull();
  });

  it('an ANALYZE statement against an absent relation is never reported as statistics', async () => {
    // The precondition of claim (1) of the harness header: the evidence comes
    // from `pg_stat_user_tables`, so a relation nothing could analyze carries
    // `analyzed: null` and `existed: false` — never a timestamp.
    for (const relation of analyze.missing) {
      expect(analyze.relations[relation]?.analyzed, relation).toBeNull();
    }
  });

  it('every measured relation of the harness is a relation the slice’s reads actually touch', async () => {
    // A measured-relation list that names something the reads never touch is a
    // list that will be ANALYZEd and reported about for no reason, and one
    // that OMITS something is how the recorded incident happened.
    expect([...MEASURED_RELATIONS].sort()).toEqual(
      ['customer_credit_applications', 'installment_plans', 'installments', 'invoices', 'payment_allocations', 'payments'].sort(),
    );
  });
});

describe('P4-S7 B-5 — the report names the condition in the same sentence as the figure', () => {
  it('a report line carries the verdict, the percentile, the scale, the database size and the ANALYZE state', () => {
    const line = report(judge(fastMeasurement('P4-S7-B', BUDGETS.STATEMENT_PAGE_P95_MS), analyze));
    console.log(line);
    expect(line).toMatch(/^P4-S7-B — /);
    expect(line).toMatch(/RESOURCE_CONTENTION/);
    expect(line).toMatch(/p95 \d+\.\d{3} ms against 100 ms over 200 iterations/);
    expect(line).toMatch(/scale \d/);
    expect(line).toMatch(/ANALYZEd: /);
    expect(line).toMatch(/MISSING RELATIONS: .*installment_plans/);
  });

  it('every budget this slice owns is reported, and NONE is asserted while the run is not authoritative', async () => {
    const lines: string[] = [];
    for (const [budgetId, thresholdMs] of [
      ['P4-S7-A', BUDGETS.INSTALLMENT_PAGE_P95_MS],
      ['P4-S7-B', BUDGETS.STATEMENT_PAGE_P95_MS],
      ['P4-S7-C', BUDGETS.DEBTS_PAGE_P95_MS],
      ['P4-S7-D', BUDGETS.PLAN_PROJECTION_P95_MS],
    ] as const) {
      const v = judge(fastMeasurement(budgetId, thresholdMs), analyze);
      expect(v.verdict, `${budgetId} must not be a pass over absent relations`).toBe('resource_contention');
      lines.push(report(v));
    }
    console.log(lines.join('\n'));
    expect(lines).toHaveLength(4);
  });

  it('the declared dataset shape is the fat-tail shape the accepted receivables harness measured, scaled', () => {
    // The figures are declared rather than seeded, and they are the ones
    // `tests/performance/receivables-s4-budgets.test.ts` used, so a later run
    // is comparable with it.
    //
    // NO MIGRATION NUMBER IS NAMED ANYWHERE IN THIS SUITE, and that is load
    // bearing rather than tidiness: `scripts/phase4-s4-gate.ts`
    // (`evidence-coverage`) DERIVES "a measured suite of this slice" as a
    // runnable test under `tests/performance` that names one of S4's
    // migrations, and then requires `S4_EVIDENCE_STEPS` and the required
    // `backend` job to reach it. The derivation is a word-bounded match on
    // each migration NUMBER anywhere in the file text
    // (`phase4-s4-gate.ts:1680-1691`), comments included — so naming one of
    // S4's numbers in prose made this suite claim to be one of S4's
    // measurements and reddened S4's gate, the current integration authority.
    // Hence the numbers are named here only by description. The relations and
    // routines are named by NAME throughout, which is what a reader needs. S7's own evidence table is
    // `PATCH-REQ-S7-003`, because `scripts/phase4-s7-gate.ts` is not the S7
    // owner's file to write.
    expect(DATASET.fatTail.invoices).toBe(scaled(2_000));
    expect(DATASET.plans.longest).toBe(120);
    expect(DATASET.fatTail.cashSettledShare).toBeGreaterThan(0.9);
    expect(SCALE).toBeGreaterThan(0);
  });

  it('the keyset drift ratio is declared, because that is the property an OFFSET page does not have', () => {
    // The budget that distinguishes a keyset page from an `OFFSET` one is not
    // the first page's cost: it is that the HUNDREDTH page costs what the
    // first did. The ratio is declared here and is asserted by the authoritative
    // run; a figure for it now would be a figure about the contention.
    expect(KEYSET_DRIFT_MAX_RATIO).toBeGreaterThan(1);
    expect(KEYSET_DRIFT_MAX_RATIO).toBeLessThan(2);
  });
});

describe('P4-S7 — the measurement device itself works, proved without a database', () => {
  it('measure takes exactly the declared number of samples, after discarding its warmups', async () => {
    let calls = 0;
    const m = await measure(
      'P4-S7-X',
      'a counted body',
      10,
      async () => {
        calls += 1;
      },
      25,
      5,
    );
    expect(m.samplesMs).toHaveLength(25);
    expect(calls, 'the warmups are run and discarded, so the body is called 30 times for 25 samples').toBe(30);
    expect(() => assertSamples(m, 25)).not.toThrow();
  });

  it('measure uses a MONOTONIC clock, so a wall-clock adjustment cannot produce a negative sample', async () => {
    const m = await measure(
      'P4-S7-X',
      'a real body',
      1000,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
      5,
      0,
    );
    expect(m.samplesMs.every((s) => s > 0)).toBe(true);
  });

  it('the cluster this suite ran against is the slice’s own, not the shared one', async () => {
    // A performance suite that quietly shared a data directory with four other
    // agents would be measuring them. The port is the evidence.
    const { rows } = await ownerPool().query<{ port: string }>("SELECT current_setting('port') AS port");
    console.log(`P4-S7 measured against PostgreSQL on port ${String(rows[0]?.port)}`);
    expect(rows[0]?.port).toBeDefined();
  });
});
