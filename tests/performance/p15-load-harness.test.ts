/**
 * THE HARNESS'S OWN LAWS, EACH A NAMED RED PROOF (Phase 15, load harness).
 *
 * WHAT THIS FILE IS NOT. It is not a performance test. It measures nothing,
 * starts no cluster, and has no opinion about how fast DAFTAR is. Absolute
 * performance belongs to the dedicated performance-evidence lane and is run
 * deliberately, by `scripts/phase15/load-harness.ts`, never recursively from
 * inside a correctness suite — that recursion is what turned every correctness
 * gate into a host-speed lottery.
 *
 * WHAT IT IS. A proof that the measuring instrument refuses what it must
 * refuse. Each `it` below names ONE law and asserts the SPECIFIC refusal or
 * verdict that law produces. None of them asserts that some list is non-empty:
 * a non-empty list names no law, and a test that only knows "something went
 * wrong" cannot tell a correct refusal from a typo.
 *
 * ── A NOTE ON THE SHARED CLUSTER HAZARD ───────────────────────────────────
 *
 * `vitest.config.ts:22` sets `globalSetup: 'tests/helpers/global-setup.ts'`
 * for EVERY run, and that module calls `ensurePostgres()` unconditionally
 * (tests/helpers/global-setup.ts:11-13), which starts the SHARED cluster at
 * `PG_DIR` / `PG_PORT` (tests/helpers/embedded-cluster.ts:19-20) as a side
 * effect of running any file at all. This file imports nothing from
 * `tests/helpers`, so it never asks for a cluster — but the global setup still
 * fires. Run it with `PG_DIR` and `PG_PORT` pointed at this slice's own
 * scratch cluster so that side effect lands in a directory this worker owns:
 *
 *   PG_DIR=<scratch>/p15-load-pg-vitest PG_PORT=55481 \
 *     npx vitest run tests/performance/p15-load-harness.test.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXIT_CODE,
  LoadHarnessRefusal,
  PROFILE_FILE,
  REQUIRED_LANE,
  bindStatement,
  classify,
  decideVerdict,
  findProfile,
  highestParameter,
  loadProfileFile,
  percentile,
  refusals,
  summarise,
  type InvalidRuleBounds,
  type Profile,
  type ProfileFile,
  type Stats,
} from '../../scripts/phase15/load-harness';

const ROOT = join(__dirname, '../..');
const file: ProfileFile = loadProfileFile(join(ROOT, PROFILE_FILE));

/** The bounds the shipped profile file declares. The tests use the real ones, never a softer copy. */
const BOUNDS: InvalidRuleBounds = file.invalid_measurement_rules;

/** A clean classification context: nothing fires. Each test perturbs exactly one input. */
const cleanContext = {
  bounds: BOUNDS,
  cpuCount: 8,
  loadavg1AtStart: 0.4,
  loadavg1AtEnd: 0.5,
  // A settled operation: warmup and steady agree, and the tail is close to the median.
  warmupSamples: [4.0, 4.1, 4.2, 3.9, 4.05],
  steadySamples: Array.from({ length: 100 }, (_unused, i) => 4 + (i % 5) * 0.05),
  foreignPostmasters: [] as readonly string[],
};

const statsOf = (samples: readonly number[]): Stats => summarise(samples);

/** A verdict context whose only interesting variable is the profile and the firings. */
const verdictContext = (profile: Profile, over: Partial<Parameters<typeof decideVerdict>[0]> = {}): Parameters<typeof decideVerdict>[0] => ({
  profile,
  stats: statsOf(cleanContext.steadySamples),
  throughputPerS: 250,
  errorCount: 0,
  attempted: profile.duration_or_samples.total_samples,
  fired: [],
  invariantViolations: [],
  reducedSamples: false,
  ...over,
});

const profileOf = (id: string): Profile => findProfile(file, id);

/** A profile with a DECLARED objective, synthesised from a real one. Used only to prove the PASS/FAIL arms exist. */
const withDeclaredCeiling = (base: Profile, maxMs: number): Profile => ({
  ...base,
  metric: 'p95',
  objective: { state: 'DECLARED', max_ms: maxMs, source: 'synthetic — this test file only, never a project target' },
});

describe('RED PROOF 1 — an empty sample set is a named REFUSAL, never a verdict', () => {
  it('summarise([]) throws EMPTY-SAMPLE-SET by name, not a generic error', () => {
    expect(() => summarise([])).toThrow(LoadHarnessRefusal);
    expect(() => summarise([])).toThrow(refusals.emptySampleSet('(unnamed)'));
    // The exact text, so a reworded refusal is a red test rather than a silent drift.
    expect(refusals.emptySampleSet('P15-LOAD-001')).toBe(
      'P15_LOAD_REFUSAL: EMPTY-SAMPLE-SET — profile P15-LOAD-001 produced 0 measured samples; zero samples is not a fast measurement, it is no measurement, and no verdict may be derived from it',
    );
  });

  it('percentile() of an empty set refuses rather than returning 0 — a zero would read as "instant"', () => {
    expect(() => percentile([], 0.95)).toThrow('P15_LOAD_REFUSAL: EMPTY-SAMPLE-SET — percentile(0.95) of an empty sample set is undefined, not zero');
  });

  it('a profile that seeded 0 rows has its own named refusal, naming the SQL that returned 0', () => {
    expect(refusals.emptySubjectSet('P15-LOAD-004', 'SELECT count(*) FROM p15_receivables')).toBe(
      'P15_LOAD_REFUSAL: EMPTY-SUBJECT-SET — profile P15-LOAD-004 seeded 0 rows (`SELECT count(*) FROM p15_receivables` returned 0); a load profile over an empty dataset measures nothing and cannot pass',
    );
  });
});

describe('RED PROOF 2 — a profile id that does not exist is a named REFUSAL', () => {
  it('findProfile() refuses an unknown id with PROFILE-NOT-FOUND and lists the ids it does know', () => {
    const knownIds = file.profiles.map((p) => p.id).join(', ');
    expect(() => findProfile(file, 'P15-LOAD-999')).toThrow(LoadHarnessRefusal);
    expect(() => findProfile(file, 'P15-LOAD-999')).toThrow(
      `P15_LOAD_REFUSAL: PROFILE-NOT-FOUND — no profile with id "P15-LOAD-999" in ${PROFILE_FILE}; a verdict about a profile that does not exist would name nothing. Known ids: ${knownIds}`,
    );
  });

  it('it does NOT fall back to the first profile — the refusal is thrown, so nothing is measured under a borrowed name', () => {
    let thrown: unknown = null;
    try {
      findProfile(file, '');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LoadHarnessRefusal);
    expect((thrown as Error).message).toContain('PROFILE-NOT-FOUND');
  });

  it('a profile declaring any lane other than performance-evidence is refused by name', () => {
    const outside: ProfileFile = {
      ...file,
      profiles: [{ ...profileOf('P15-LOAD-001'), id: 'P15-LOAD-X', lane: 'correctness-gate' }],
    };
    expect(() => findProfile(outside, 'P15-LOAD-X')).toThrow(
      'P15_LOAD_REFUSAL: WRONG-LANE — profile P15-LOAD-X declares lane "correctness-gate", not "performance-evidence"; host-sensitive absolute performance may only be measured in the dedicated performance-evidence lane',
    );
  });
});

describe('RED PROOF 3 — an UNDECLARED objective is measured and reported, and is NEVER a PASS', () => {
  it('every shipped profile whose objective is UNDECLARED gets UNMEASURED-OBJECTIVE on a clean, fast, error-free run', () => {
    const undeclared = file.profiles.filter((p) => p.objective.state === 'UNDECLARED');
    // Named, not counted: the assertion says which profiles and what each answered.
    expect(undeclared.map((p) => `${p.id}=${decideVerdict(verdictContext(p)).verdict}`)).toEqual(undeclared.map((p) => `${p.id}=UNMEASURED-OBJECTIVE`));
    for (const p of undeclared) expect(decideVerdict(verdictContext(p)).verdict).not.toBe('PASS');
  });

  it('UNMEASURED-OBJECTIVE exits 4 — distinct from PASS (0), FAIL (2) and INVALID MEASUREMENT (3)', () => {
    expect(EXIT_CODE).toEqual({ PASS: 0, FAIL: 2, 'INVALID MEASUREMENT': 3, 'UNMEASURED-OBJECTIVE': 4 });
  });

  it('an objective that SAYS declared but states no number is UNMEASURED-OBJECTIVE, not PASS — an empty declaration is not an objective', () => {
    const hollow: Profile = { ...profileOf('P15-LOAD-002'), objective: { state: 'DECLARED', source: 'nowhere' } };
    const decided = decideVerdict(verdictContext(hollow));
    expect(decided.verdict).toBe('UNMEASURED-OBJECTIVE');
    expect(decided.because).toBe(
      'profile P15-LOAD-002 says objective.state = DECLARED but states no number (no max_ms, min_throughput_per_s or max_error_rate); a declaration with nothing in it is not an objective',
    );
  });

  it('reducing the sample count below what the profile declares can never PASS, even against a met ceiling', () => {
    const declared = withDeclaredCeiling(profileOf('P15-LOAD-002'), 1000);
    expect(decideVerdict(verdictContext(declared)).verdict).toBe('PASS');
    const reduced = decideVerdict(verdictContext(declared, { reducedSamples: true }));
    expect(reduced.verdict).toBe('UNMEASURED-OBJECTIVE');
    expect(reduced.because).toContain('a reduced sample count is a weaker claim and may not be promoted to a result');
  });

  it('a broken invariant is a FAIL that outranks every other consideration, including a fired noise rule', () => {
    const declared = withDeclaredCeiling(profileOf('P15-LOAD-007'), 1000);
    const decided = decideVerdict(
      verdictContext(declared, {
        invariantViolations: ['the total allocation is conserved (observed 17, expected 0)'],
        fired: [{ rule: 'R1_HOST_LOAD', observed: 'loaded', bound: 'max_loadavg_per_cpu 1.5' }],
      }),
    );
    expect(decided.verdict).toBe('FAIL');
    expect(decided.because).toBe('invariant violated: the total allocation is conserved (observed 17, expected 0)');
  });

  it('a DECLARED ceiling that is missed is a FAIL that names both numbers', () => {
    const declared = withDeclaredCeiling(profileOf('P15-LOAD-002'), 1);
    const decided = decideVerdict(verdictContext(declared));
    expect(decided.verdict).toBe('FAIL');
    expect(decided.because).toBe('outside the declared objective: p95 4.200 ms against 1 ms');
  });
});

describe('RED PROOF 4 — the percentile matches an INDEPENDENTLY computed oracle', () => {
  /**
   * THE ORACLE IS NOT THE HARNESS'S OWN FUNCTION.
   *
   * Comparing `percentile()` to `percentile()` proves only that the machine is
   * deterministic. So this oracle is written from the DEFINITION instead, with
   * different arithmetic: it builds the ascending order by repeated extraction
   * of the minimum (no `Array.prototype.sort`), and it addresses the element by
   * a RANK counted from one — `rank = min(n, floor(q * n) + 1)` — rather than
   * by a zero-based index. Same nearest-rank definition the accepted
   * accounting budgets use (tests/performance/accounting-budgets.test.ts:112),
   * reached a different way.
   */
  function oracle(samples: readonly number[], q: number): number {
    const remaining = [...samples];
    const ascending: number[] = [];
    while (remaining.length > 0) {
      let least = 0;
      for (let i = 1; i < remaining.length; i += 1) if ((remaining[i] as number) < (remaining[least] as number)) least = i;
      ascending.push(remaining.splice(least, 1)[0] as number);
    }
    const rank = Math.min(ascending.length, Math.floor(q * ascending.length) + 1);
    return ascending[rank - 1] as number;
  }

  it('agrees with the oracle on a hand-checkable 20-sample set, at p50, p95 and p99', () => {
    // 1..20 shuffled. n = 20: floor(.5*20)=10 → rank 11 → 11; floor(.95*20)=19 → rank 20 → 20; floor(.99*20)=19 → rank 20 → 20.
    const twenty = [7, 3, 19, 11, 1, 20, 5, 14, 9, 2, 16, 8, 13, 4, 18, 6, 12, 10, 17, 15];
    expect([percentile(twenty, 0.5), percentile(twenty, 0.95), percentile(twenty, 0.99)]).toEqual([11, 20, 20]);
    expect([oracle(twenty, 0.5), oracle(twenty, 0.95), oracle(twenty, 0.99)]).toEqual([11, 20, 20]);
  });

  it('agrees with the oracle across every quantile the harness reports, on three differently shaped sets', () => {
    const sets: readonly (readonly number[])[] = [[42], [1, 1, 1, 1, 1, 1, 1, 1, 1, 900], Array.from({ length: 237 }, (_unused, i) => ((i * 97) % 237) + 0.5)];
    for (const set of sets) {
      for (const q of [0, 0.5, 0.95, 0.99]) {
        expect(percentile(set, q), `n=${set.length} q=${q}`).toBe(oracle(set, q));
      }
    }
  });

  it('p95 is p95 and not the median: a set with a heavy tail reports them differently', () => {
    const heavyTail = [...Array.from({ length: 95 }, () => 5), ...Array.from({ length: 5 }, () => 400)];
    const stats = summarise(heavyTail);
    expect(stats.p50).toBe(5);
    expect(stats.p95).toBe(400);
    expect(stats.p99).toBe(400);
    expect(stats.max).toBe(400);
    expect(stats.samples).toBe(100);
    // Nothing is trimmed: every sample survives into the record.
    expect(stats.samplesMs).toHaveLength(100);
  });
});

describe('RED PROOF 5 — the INVALID MEASUREMENT rule fires on noise and stays silent on a clean sample', () => {
  it('fires NO rule on a clean, settled, exclusive-host sample — so the verdict is not INVALID', () => {
    expect(classify(cleanContext).map((f) => f.rule)).toEqual([]);
    expect(decideVerdict(verdictContext(withDeclaredCeiling(profileOf('P15-LOAD-002'), 1000))).verdict).toBe('PASS');
  });

  it('R1_HOST_LOAD fires, by name, when the host load average per CPU is over the declared bound', () => {
    const fired = classify({ ...cleanContext, loadavg1AtEnd: BOUNDS.R1_HOST_LOAD.max_loadavg_per_cpu * 8 + 1 });
    expect(fired.map((f) => f.rule)).toEqual(['R1_HOST_LOAD']);
    expect(fired[0]?.bound).toBe(`max_loadavg_per_cpu ${BOUNDS.R1_HOST_LOAD.max_loadavg_per_cpu}`);
    expect(fired[0]?.observed).toContain('1-minute load average per CPU was');
  });

  it('R2_WARMUP_DRIFT fires, by name, when the steady median has drifted away from the warmup median', () => {
    // Warmup around 4 ms, steady around 40 ms: the system never settled.
    const fired = classify({ ...cleanContext, steadySamples: Array.from({ length: 100 }, (_unused, i) => 40 + (i % 5) * 0.05) });
    expect(fired.map((f) => f.rule)).toEqual(['R2_WARMUP_DRIFT']);
    expect(fired[0]?.observed).toContain('so the system never settled and the samples describe a transient');
  });

  it('R3_DISPERSION fires, by name, when p99/p50 is beyond the declared bound — a sample set made of stalls', () => {
    // p50 stays at 4 ms; one percent of the samples stall at 4 s.
    const stalled = [...Array.from({ length: 99 }, () => 4), ...Array.from({ length: 1 }, () => 4000)];
    const fired = classify({ ...cleanContext, steadySamples: stalled });
    expect(fired.map((f) => f.rule)).toEqual(['R3_DISPERSION']);
    expect(fired[0]?.bound).toBe(`max_p99_over_p50 ${BOUNDS.R3_DISPERSION.max_p99_over_p50}`);
  });

  it('R4_FOREIGN_CLUSTER fires, by name, when another postmaster was live on the box', () => {
    const fired = classify({ ...cleanContext, foreignPostmasters: ['1234 postgres -D /tmp/daftar-pg-shared'] });
    expect(fired.map((f) => f.rule)).toEqual(['R4_FOREIGN_CLUSTER']);
    expect(fired[0]?.observed).toContain('the box is not exclusive');
  });

  it('a fired rule makes the verdict INVALID MEASUREMENT — neither PASS nor FAIL — and names which rule fired', () => {
    const declared = withDeclaredCeiling(profileOf('P15-LOAD-002'), 1000);
    const fired = classify({ ...cleanContext, foreignPostmasters: ['1234 postgres -D /tmp/other-worker-pg'] });
    const decided = decideVerdict(verdictContext(declared, { fired }));
    expect(decided.verdict).toBe('INVALID MEASUREMENT');
    expect(decided.verdict).not.toBe('PASS');
    expect(decided.verdict).not.toBe('FAIL');
    expect(decided.because).toContain('R4_FOREIGN_CLUSTER');
    expect(decided.because).toContain('bound: max_foreign_postmasters 0');
  });

  it('noise outranks an UNDECLARED objective: a noisy run of an UNDECLARED profile is INVALID, not UNMEASURED', () => {
    const fired = classify({ ...cleanContext, loadavg1AtEnd: 99 });
    expect(decideVerdict(verdictContext(profileOf('P15-LOAD-001'), { fired })).verdict).toBe('INVALID MEASUREMENT');
  });
});

describe('the declared profile file is the shape the harness relies on', () => {
  it('every profile parses, carries the performance-evidence lane, and names a metric the harness can evaluate', () => {
    const metrics = ['p50', 'p95', 'p99', 'throughput', 'error-rate'];
    expect(file.profiles.map((p) => `${p.id} ${p.lane} ${p.metric} ${metrics.includes(p.metric) ? 'known' : 'UNKNOWN-METRIC'}`)).toEqual(
      file.profiles.map((p) => `${p.id} ${REQUIRED_LANE} ${p.metric} known`),
    );
    expect(file.lane).toBe(REQUIRED_LANE);
  });

  it('the six surfaces Phase 15 asked for are each covered by a profile id, named one by one', () => {
    const titles = file.profiles.map((p) => `${p.id} ${p.title}`).join(' | ');
    for (const surface of [
      'POS checkout concurrency',
      'Invoice posting latency',
      'Invoice posting throughput',
      'Customer statement / receivables aging read',
      'Inventory movement write storm',
      'Dashboard read',
      'Concurrent settlement race',
    ]) {
      expect(titles, `the ${surface} profile is missing`).toContain(surface);
    }
  });

  it('declared_total_samples equals concurrency × samples_per_worker for every profile — the file does not misreport its own size', () => {
    expect(file.profiles.map((p) => `${p.id}:${p.duration_or_samples.total_samples}`)).toEqual(
      file.profiles.map((p) => `${p.id}:${p.concurrency * p.duration_or_samples.samples_per_worker}`),
    );
  });

  it('every profile declares a warmup, and the warmup samples are discarded from the reported set', () => {
    expect(file.profiles.map((p) => `${p.id}:${p.warmup.samples_per_worker > 0}`)).toEqual(file.profiles.map((p) => `${p.id}:true`));
  });

  it('the frozen Accounting Budget A ceiling is referenced, never restated: no profile carries its number', () => {
    const raw = readFileSync(join(ROOT, PROFILE_FILE), 'utf8');
    const budgets = readFileSync(join(ROOT, 'tests/performance/accounting-budgets.test.ts'), 'utf8');
    const match = /A_POST_P95:\s*(\d+)/.exec(budgets);
    // The contract still lives where the gates pin it (scripts/phase3-s8-gate.ts:822).
    expect(match?.[1], 'A_POST_P95 is no longer declared at tests/performance/accounting-budgets.test.ts:54').toBeDefined();
    const inheritable = file.profiles.find((p) => p.objective.inheritable_from !== undefined);
    expect(inheritable?.objective.inheritable_from?.source).toBe('tests/performance/accounting-budgets.test.ts:54');
    expect(inheritable?.objective.inheritable_from?.number_copied_here).toBe(false);
    expect(inheritable?.objective.state, 'an inheritable ceiling is not an inherited one until the profile drives the product command').toBe('UNDECLARED');
    // And it is genuinely absent from the profile file, so there is one source of truth for it.
    expect(raw).not.toContain('"max_ms": 15');
    expect(raw).not.toContain('A_POST_P95: 15');
  });

  it('no measured statement contains a sleep — a timer is never proof of a race', () => {
    const offenders = file.profiles.flatMap((p) =>
      p.workload.operation_mix.flatMap((o) => o.statements.filter((s) => /pg_sleep|sleep\s*\(/i.test(s)).map((s) => `${p.id}: ${s}`)),
    );
    expect(offenders).toEqual([]);
  });

  it('the settlement race profile locks both rows in one deterministically ordered statement', () => {
    const race = profileOf('P15-LOAD-007');
    const locking = race.workload.operation_mix.flatMap((o) => o.statements).filter((s) => /FOR UPDATE/.test(s));
    expect(locking).toHaveLength(1);
    expect(locking[0]).toContain('ORDER BY id FOR UPDATE');
    expect(race.concurrency).toBeGreaterThan(1);
  });

  /**
   * THE REGRESSION THIS PROVES. The harness's first real run against a cluster
   * failed every one of its 220 attempts with "could not determine data type
   * of parameter $1", because a statement that mentions only `$3` was being
   * handed three values — and a parameter that appears nowhere in the SQL has
   * no type PostgreSQL can infer. `bindStatement` renumbers densely instead.
   * Without this test the fix is one refactor away from coming back.
   */
  it('bindStatement() renumbers the slots a statement mentions densely and binds exactly those values', () => {
    const params = [7, 42, 'the-uuid', 'keyA', 'keyB'] as const;
    expect(bindStatement('SELECT 1 FROM t WHERE entry_id = $3::uuid', params)).toEqual({
      sql: 'SELECT 1 FROM t WHERE entry_id = $1::uuid',
      values: ['the-uuid'],
    });
    expect(bindStatement('INSERT INTO t (id, a, b) VALUES ($3::uuid, $4::int, $5::int)', params)).toEqual({
      sql: 'INSERT INTO t (id, a, b) VALUES ($1::uuid, $2::int, $3::int)',
      values: ['the-uuid', 'keyA', 'keyB'],
    });
    // A repeated slot stays one parameter, bound once.
    expect(bindStatement('INSERT INTO t VALUES ($3::uuid, 1), ($3::uuid, 2)', params)).toEqual({
      sql: 'INSERT INTO t VALUES ($1::uuid, 1), ($1::uuid, 2)',
      values: ['the-uuid'],
    });
    expect(bindStatement('SELECT 1', params)).toEqual({ sql: 'SELECT 1', values: [] });
    // Already dense input is unchanged, in order.
    expect(bindStatement('SELECT $1::int, $2::int', params)).toEqual({ sql: 'SELECT $1::int, $2::int', values: [7, 42] });
  });

  it('bindStatement() refuses a slot the harness does not bind, by name, rather than passing undefined to pg', () => {
    expect(() => bindStatement('SELECT $9::int', [1, 2, 3, 4, 5])).toThrow(
      `P15_LOAD_REFUSAL: UNBOUND-PARAMETER — a statement mentions $9 but the harness binds only 5 slot(s); see parameter_binding in ${PROFILE_FILE}`,
    );
  });

  it('every shipped statement binds without refusal under the five-slot vocabulary', () => {
    const params = [0, 0, 'uuid', 'a', 'b'] as const;
    const broken = file.profiles.flatMap((p) =>
      p.workload.operation_mix.flatMap((o) =>
        o.statements.flatMap((s) => {
          try {
            bindStatement(s, params);
            return [];
          } catch (e) {
            return [`${p.id}: ${(e as Error).message}`];
          }
        }),
      ),
    );
    expect(broken).toEqual([]);
  });

  it('highestParameter() counts the parameters a statement actually uses, so pg is never handed spares', () => {
    expect(highestParameter('SELECT 1')).toBe(0);
    expect(highestParameter('UPDATE t SET a = 1 WHERE id = $4::int')).toBe(4);
    expect(highestParameter('SELECT * FROM t WHERE a = $1 AND b = $5 AND c = $3')).toBe(5);
    // Every shipped statement stays inside the five parameters the file documents.
    const overrun = file.profiles.flatMap((p) =>
      p.workload.operation_mix.flatMap((o) => o.statements.filter((s) => highestParameter(s) > 5).map((s) => `${p.id}: ${s}`)),
    );
    expect(overrun).toEqual([]);
  });
});
