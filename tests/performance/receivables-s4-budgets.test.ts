/**
 * P4-S4 — THE CUSTOMER SETTLEMENT BUDGETS, MEASURED (P4-AL-71 P4-D and P4-F,
 * P4-AL-72, P4-AL-73, P4-AL-74, P4-AL-75, P4-AL-76, OD-P4-14).
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 *
 * The reviewed tree's green CI carries `P4-A` and `P4-B` — the POS read
 * budgets. Those are not `P4-D` and `P4-F`, and the Architecture Lock requires
 * S4 performance evidence, so S4 cannot freeze until these two exist and are
 * measured. Nothing here replaces or re-measures the POS budgets.
 *
 * ── WHAT THIS FILE CLAIMS, AND WHAT IT DOES NOT ────────────────────────────
 *
 * It claims two different kinds of thing and says which is which, because a
 * test whose verdict is the machine's speed proves nothing either way:
 *
 *   GATES — deterministic properties of the COMMAND and the QUERY. The
 *   statement count's independence from the customer's invoice count, the
 *   absence of `OFFSET`, the absence of a sequential scan on the relations
 *   whose selectivity is production-shaped, exactly ONE transaction per
 *   allocation command, exactly one journal entry per allocation and no
 *   per-line entry, and the host-independent RATIOS `P4-AL-72` states. These
 *   fail on a bad query or a bad command on any host, fast or slow, and they
 *   are what makes this file RED-capable from its first commit.
 *
 *   MEASUREMENTS — the millisecond figures. `P4-D`'s `p95 ≤ 100 ms` and
 *   `P4-F`'s `≤ 40 ms` in-transaction / `≤ 100 ms` over HTTP are asserted, and
 *   the ceilings are NOT written here: they are imported from
 *   `scripts/phase4-budget-ratchet.ts`, which checks its own copy against the
 *   `P4-AL-71` table in `docs/PHASE_4_ARCHITECTURE_LOCK.md`. A number cannot
 *   be made to pass by editing a literal beside the assertion that reads it.
 *
 * ── TWO HUNDRED MEASURED ITERATIONS, WHICH IS THE ACCEPTED PRACTICE ────────
 *
 * `docs/PHASE_4_S3_PERFORMANCE_EVIDENCE.md` records the Tech Lead ruling of
 * 2026-10-04 and `tests/performance/accounting-budgets.test.ts:93` carries it:
 * a budget whose single operation takes a few milliseconds takes
 * `SHORT_PERCENTILE_ITERATIONS = 200`. At n = 30, `p95` is index 28 — the
 * SECOND-WORST sample of thirty — so one stalled iteration is the verdict in
 * either direction. At n = 200 it is index 190, with ten samples above it.
 * P4-D and P4-F are short budgets (100 ms, 40 ms, 100 ms), so they take 200.
 *
 * Nothing else moves, and the directive's prohibitions are honoured in full:
 * no `p95` → `p90`, no removed sample, no ignored outlier, no trimmed tail, no
 * winsorisation, no host multiplier, no retry-until-green, no `.skip`,
 * `.todo` or `.only`. Every sample is kept IN ORDER and printed. The whole
 * distribution is computed by `tests/performance/percentile.ts` — the
 * arithmetic `tests/guards/accounting-budget-percentile-semantics.test.ts`
 * has a test of — and `orderedMs` is the COMPLETE series.
 *
 * DIAGNOSTIC DATA NEVER CHANGES THE VERDICT. Nothing below excludes a sample
 * because a host metric looked bad.
 *
 * ── MEASURED AS `daftar_app`, WITH THE RLS COST RECORDED (P4-AL-75) ────────
 *
 * The budget is the figure through the HTTP application, which reads as
 * `daftar_app` with the scope GUCs a request sets and row security applied.
 *
 * The RLS COST is a separate instrument and is measured BETWEEN LIKE AND LIKE:
 * the same captured statements, on the same rows, as `daftar_app` through
 * `Database.scoped` (row security applied) against the schema owner (row
 * security bypassed), with no HTTP envelope on either side. `statementCostMs`
 * records why — the first version of this file divided the whole HTTP figure
 * by the owner-side statement figure, measured 10.49×, and would have reported
 * Nest, the auth guard and JSON as the cost of a policy. The owner figure is
 * never the budget, and the ratio is judged against `RATIOS.RLS_COST`,
 * provisional at 3× per `OD-P4-14` and tighten-only.
 *
 * ── EACH SERIES IS MEASURED ONCE, IN THE FIXTURE ───────────────────────────
 *
 * The ceiling case, the fat-tail-over-median ratio and the RLS cost are three
 * questions about ONE read. The series are taken once in `beforeAll` and every
 * case reads the stored series, so a run cannot pass its ceiling on one sample
 * of 200 and compute its ratio from another.
 *
 * ── THE PRODUCT'S OWN RATE LIMIT ───────────────────────────────────────────
 *
 * `apps/api/src/app/runtime.ts:116` throttles every route handler to 300
 * requests per minute per client, and a test's client is always `127.0.0.1`.
 * A seed of 4 000-odd real sales and a 200-iteration HTTP budget both exceed
 * that, and the first run of this fixture duly failed on HTTP 429. The fixture
 * therefore PACES itself against the product's own limit
 * (`receivables-s4-dataset.ts`, `THROTTLE`): the limit is not raised, the guard
 * is not disabled, no 429 is retried into a sample, every wait happens OUTSIDE
 * the measured span, and the total waited is reported per handler.
 *
 * ── THE DATASET (P4-AL-73) ────────────────────────────────────────────────
 *
 * `tests/performance/receivables-s4-dataset.ts` builds the `D-SALES` FAT-TAIL
 * ARM through the real commands: the lock's fat-tail customer with 2 000 open
 * invoices and 4 000 allocations, a median population for the ratio's
 * denominator, customer credits and credit applications so both arms of
 * `invoice_outstanding`'s `UNION ALL` carry rows, and a foreign-currency
 * payment share so the FX snapshots are measured rather than bypassed. What it
 * does NOT build is the rest of `D-SALES` — 20 000 customers, 200 000 invoices,
 * 20 000 installment plans — which `P4-AL-76` puts inside `gate:phase4:s8` and
 * which P4-S8 owns. The consequence for the plan claims is stated at
 * `describe('P4-D …')` rather than papered over.
 *
 * ── ANALYZE FIRST, ALWAYS (P4-AL-74) ──────────────────────────────────────
 *
 * Every measured relation is `ANALYZE`d after the seed, its statistics are
 * read back, and a missing or null `last_analyze` FAILS the suite rather than
 * being measured around. The same read is also measured BEFORE the `ANALYZE`
 * and printed, so the budget's number can never be mistaken for a number
 * about missing statistics.
 *
 * ── RUNNING IT ────────────────────────────────────────────────────────────
 *
 * ALONE (`P4-AL-76`), on its OWN cluster — both `PG_DIR` and `PG_PORT`, since
 * `PG_PORT` alone collides on the shared data directory:
 *
 *     PG_DIR=/tmp/daftar-pg-agent-b PG_PORT=55940 npm run perf:phase4:s4
 *
 * `npm run perf:phase4:s4` carries `--reporter=verbose`, and that is not a
 * cosmetic preference. MEASURED on Vitest 4.1.11, read through a pipe: the
 * DEFAULT reporter surfaces the `console.log` of FAILING cases and of hooks,
 * and on a run with no failure at all it surfaces NOTHING — not one line. So
 * the authoritative run, if it were green, printed its
 * `P4-S4 PERFORMANCE RECORD`, its sample census, its RLS cost and its
 * allocation scaling to nowhere, and the evidence `TL-P4-S3-R4` requires
 * existed only inside a process that had exited. The flag fixes the green
 * case; printing the record from the `afterAll` audit as well fixes the red
 * one, so a bare `vitest run` that FAILS still carries its own evidence.
 *
 * never beside another `PG_DIR` user and never beside another timing suite:
 * `accounting-budgets.test.ts` once failed a `p95` purely from contention and
 * turned eight composed gates red, and two agents sharing one database on this
 * box produced 3 versus 35 failures on identical trees. A figure taken while
 * something else was running is a figure about the box, and this file records
 * the load average beside every one of them so a reader can tell.
 */
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Response } from 'supertest';
import { Client } from 'pg';
import { appDbUrl, ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { InDatabaseClock, type InDatabaseReading } from '../helpers/in-database-time';
import { must } from '../helpers/inventory-commands';
import { readAs } from '../helpers/merchant-reads';
import { classifyPlanEvidence, planEvidenceBanner, readPlanEvidenceEnvironment, type PlanEvidenceEnvironment } from '../helpers/plan-evidence-env';
import {
  newCustomer,
  settlementMissing,
  settlementWorld,
  stateFxRate,
  type OpenInvoice,
  type SettlementWorld,
} from '../golden-regression/phase4-s4/settlement-world';
import { R10, allocationFigures, collectPayment, rateToR10, type AllocationInput, type PaymentInput } from '../golden-regression/phase4-s4/settlement-path';
import { Database, type Scope } from '../../apps/api/src/infra/database';
import { distribution, quantile, type Distribution } from './percentile';
import { ACCEPTED, RATIOS, effectiveCeilingMs } from '../../scripts/phase4-budget-ratchet';
import { phase4RoutineBodies, phase4Sql } from '../../scripts/phase4-s1-gate';
import {
  FAT_TAIL,
  FOREIGN_CURRENCY,
  FOREIGN_RATE,
  MEDIAN,
  ROUTE,
  CI_SERVICE_COLLATION,
  SCALE,
  THROTTLE,
  authReport,
  datasetSizeBytes,
  freeDisk,
  installAuthKeeper,
  pace,
  pacedSellOnCredit,
  pacedStockUp,
  pacingReport,
  planningStatistics,
  quarterOf,
  realizedVolume,
  relationSizes,
  seedFatTailArm,
  serverProvenance,
  type FatTailDataset,
  type FreeDisk,
  type RealizedVolume,
  type ServerProvenance,
} from './receivables-s4-dataset';

/**
 * THE CEILINGS, IMPORTED AND NEVER TYPED.
 *
 * `effectiveCeilingMs` is `min(hard product cap, accepted calibrated ceiling)`
 * — the Tech Lead's 2026-09-30 A + C ruling — and the ratchet refuses a tree
 * in which either copy of a number has risen. So the only way to raise one of
 * these is to raise it in `scripts/phase4-budget-ratchet.ts` AND in the
 * `P4-AL-71` table of `docs/PHASE_4_ARCHITECTURE_LOCK.md`, in the same diff.
 */
const BUDGET = {
  /** P4-D — customer balance as of a date, the fat-tail customer. */
  D_BALANCE_P95: effectiveCeilingMs(must(ACCEPTED['P4-D'])),
  /** P4-F — payment allocation over 5 invoices, inside the command's own transaction. */
  F_ALLOCATION_TXN_P95: effectiveCeilingMs(must(ACCEPTED['P4-F-TXN'])),
  /** P4-F — the same allocation, end to end over HTTP. */
  F_ALLOCATION_HTTP_P95: effectiveCeilingMs(must(ACCEPTED['P4-F-HTTP'])),
} as const;

/**
 * `tests/performance/accounting-budgets.test.ts:93`, the accepted practice for
 * a short percentile budget: TWO HUNDRED measured iterations.
 *
 * It is a constant and not an environment variable on purpose. A sample count
 * a run can choose is a sample count a run can lower, and `P4-AL-76` makes the
 * gate fail when a measurement's sample count is below the declared
 * iterations — so the declaration and the measurement are the same literal,
 * asserted against the realized series length by the `REPORT` case below.
 */
const SHORT_PERCENTILE_ITERATIONS = 200;
const WARMUP = 5;

/**
 * ── DR-98 EXTENDED TO P4-D AND P4-F-TXN: WHAT THESE TWO BUDGETS NOW JUDGE ──
 *
 * `P4-D` and `P4-F` in-transaction are asserted on the time PostgreSQL spent
 * EXECUTING, read from `pg_stat_statements` (`tests/helpers/in-database-time.ts`),
 * and no longer on the client's wall clock. The wall clock keeps being measured
 * and keeps being printed beside it; it stopped being the verdict.
 *
 * WHY. The same tail that DR-98 measured on PERF01's budgets A and B is in this
 * file's numbers: `P4-F in-transaction, 5 invoices, foreign currency` was
 * p50 24.737 and p95 45.045 against a 40 ms ceiling, with ten of two hundred
 * samples above it and a max of 183.002 — a median well inside the ceiling and
 * isolated excursions to seven times it. A verdict decided by that shape is a
 * verdict about the runner's scheduling, not about the allocation.
 *
 * THE CEILINGS, THE SAMPLE COUNT AND THE PERCENTILE ARE UNTOUCHED. 40 ms and
 * 100 ms still come from `ACCEPTED` through `effectiveCeilingMs`, the count is
 * still `SHORT_PERCENTILE_ITERATIONS`, and the estimator is still the one in
 * `./percentile`. Nothing here is a `retry`, a `skip`, a widened ceiling or a
 * dropped outlier.
 *
 * ── WHAT THIS CONVERSION GIVES UP, STATED BECAUSE IT IS NOT A FREE WIN ─────
 *
 * On PERF01's A and E the measured span was essentially one statement, so the
 * database's clock covered all of it. HERE IT DOES NOT. `P4-F-TXN`'s span is
 * `Database.withBusinessInventoryAccountingTransaction`, and part of what that
 * span used to contain is GENUINE APPLICATION WORK IN NODE: the allocation
 * arithmetic, the settlement figures and the FX conversion that run BETWEEN the
 * statements. The in-database clock does not see one microsecond of it. So this
 * budget stops holding a ceiling over the application's own CPU inside the
 * transaction, and a regression that doubled the allocation arithmetic — while
 * the SQL stayed the same — would no longer fail it. That is a real loss of
 * coverage, it is accepted deliberately, and it is kept VISIBLE rather than
 * described: the residual (wall − in-database) is computed per iteration and
 * printed with every verdict, so the part that is no longer judged is the part
 * a reader can see moving.
 *
 * `P4-F-HTTP` IS DELIBERATELY NOT CONVERTED. Its whole subject is the endpoint
 * over HTTP — Nest, the guard, the membership resolution, serialisation. An
 * in-database clock there would judge the SQL and silently drop the endpoint
 * out of a budget whose name says the endpoint is what it measures. It keeps
 * the wall clock, and both of its figures stay printed.
 */

/**
 * CONTROL KNOB 1 — a real `pg_sleep` INSIDE the database, on a `daftar_app`
 * connection, inside the measured window of every converted budget. The server
 * accounts it, so `P4-D` and `P4-F-TXN` MUST go red on their own assertions.
 * Inert and unset in every normal run. It is the control that proves the
 * in-database series can still fail.
 *
 * It must exceed the ceiling of the budget it is meant to break: `P4-F-TXN`'s
 * ceiling is 40 ms, so CI sets 200.
 */
const IN_DB_DELAY_MS = Number(process.env['P4_S4_IN_DB_DELAY_MS'] ?? '0') || 0;

/**
 * CONTROL KNOB 2 — a `setTimeout` OUTSIDE every query, at the head of the same
 * measured windows. It inflates the wall clock and nothing the database does,
 * so `P4-D` and `P4-F-TXN` MUST STAY GREEN while their printed wall figures go
 * up by at least this much. Inert and unset in every normal run.
 *
 * AND IT IS EXPECTED TO TURN ONE CASE RED: `P4-F over HTTP`. The HTTP window
 * CONTAINS the transaction window, so a delay planted inside the transaction
 * necessarily inflates the request around it, and that budget is still judged
 * on the wall clock by decision. Its red under this knob is not a defect of the
 * control — it is the second half of what the control proves: the converted
 * budgets no longer listen to anything outside PostgreSQL, and the one budget
 * this card deliberately left on the wall clock still does. `ci.yml` requires
 * exactly that shape: the HTTP tag present, the two converted tags absent.
 */
const CLIENT_DELAY_MS = Number(process.env['P4_S4_CLIENT_DELAY_MS'] ?? '0') || 0;

/**
 * CONTROL KNOB 3 — the same real `pg_sleep` INSIDE the database, planted in
 * the FIVE-INVOICE ARM ALONE: the NUMERATOR of `P4-AL-72`'s allocation
 * scaling ratio, and nothing else.
 *
 * WHY A THIRD KNOB AND NOT KNOB 1, MEASURED AS AN ARGUMENT ABOUT ARITHMETIC
 * AND NOT AS A PREFERENCE. Knob 1 plants its delay at the head of EVERY
 * measured window, so it adds the same `d` to the one-invoice arm and to the
 * five-invoice arm. The ratio is a QUOTIENT: `(a + d) / (b + d)` moves
 * TOWARDS 1 as `d` grows and can never exceed `a / b` when `a > b`. So knob 1
 * can never make this verdict miss, and a green ratio under knob 1 would be
 * read as a control that held when no control ran at all — the exact false
 * negative RULE-27 and DR-55 are about. This knob adds `d` to the numerator
 * only, which is the one shape that raises the quotient.
 *
 * It must be large enough that `p95(5) / p95(1)` exceeds the constant
 * whatever the host measured for the denominator. CI sets 200 ms, and the
 * denominator it has to beat is single-digit to low-double-digit
 * milliseconds: on `4cac6738` (run 42348282323, job 128330740569) the
 * one-invoice arm's WALL p95 was 10.574 ms and its in-database p95 is
 * necessarily lower still, since the wall figure contains it.
 *
 * Inert and unset in every normal run.
 */
const IN_DB_DELAY_MS_FIVE = Number(process.env['P4_S4_IN_DB_DELAY_MS_FIVE'] ?? '0') || 0;

/** The in-database instrument the converted budgets are judged on (DR-98). */
let inDatabase: InDatabaseClock | null = null;
/** The `daftar_app` connection control knob 1 plants its delay on. Null unless the knob is set. */
let delayer: Client | null = null;

const sleep = async (ms: number): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms));
};

/**
 * The control delays, at the HEAD of a measured window — where the operation's
 * own cost sits — so a red is the budget's own assertion missing its own
 * ceiling. All three are inert unless their knob is set.
 *
 * `shape` is the invoice count of the window being measured, or `null` for a
 * window that has no invoice count (the `P4-D` reads, the median read and the
 * two RLS halves). Knob 3 reads it, and only it: knobs 1 and 2 are
 * shape-blind by design and stay so.
 */
async function plantControlDelays(shape: number | null): Promise<void> {
  if (CLIENT_DELAY_MS > 0) await sleep(CLIENT_DELAY_MS);
  if (delayer === null) return;
  if (IN_DB_DELAY_MS > 0) await delayer.query('SELECT pg_sleep($1)', [IN_DB_DELAY_MS / 1000]);
  // Knob 3: the numerator of `P4-AL-72`'s ratio and no other window.
  if (IN_DB_DELAY_MS_FIVE > 0 && shape === 5) await delayer.query('SELECT pg_sleep($1)', [IN_DB_DELAY_MS_FIVE / 1000]);
}

/**
 * `P4-F` is measured over 1 invoice and over 5 (`P4-AL-71`, `P4-AL-72`).
 *
 * The three arms, named once. The FX arm is measured only at the five-invoice
 * CEILING shape: it exists to prove the FX snapshot path is not bypassed, and
 * a one-invoice FX arm would add a quarter of an hour of seeding for a figure
 * no ceiling is stated about.
 */
const ALLOCATION_ARMS: readonly { readonly shape: number; readonly currency: 'base' | 'foreign' }[] = [
  { shape: 1, currency: 'base' },
  { shape: 5, currency: 'base' },
  { shape: 5, currency: 'foreign' },
];

/**
 * The invoice pool P4-F consumes, which is a function of the SAMPLE COUNT and
 * not of the dataset tier.
 *
 * Every measured allocation lands on a FRESH invoice at chain position zero,
 * so each of the 200 iterations does identical work and the series is
 * stationary. Reusing one invoice for many legs would make the later samples
 * cost more than the earlier ones — a drift inside the series that `p95` would
 * silently absorb — so the pool is sized to the iterations instead:
 * `(WARMUP + iterations) × shape` invoices per arm. `P4_PERF_SCALE` does NOT
 * reduce it, because reducing the sample count is the one thing the P4-S3
 * ruling raised it to stop.
 */
const allocationPoolSize = (shape: number): number => (WARMUP + SHORT_PERCENTILE_ITERATIONS) * shape;

let w: SettlementWorld;
let dataset: FatTailDataset;
let volume: RealizedVolume;
let stats: Record<string, { rows: number; analyzed: string | null }>;
let environment: PlanEvidenceEnvironment;
let sizeBytes = 0;
let sizes: Record<string, number> = {};
/** Which server answered, and how much room it had: read BEFORE the figures (TL-P4-S3-R4). */
let provenance: ServerProvenance | null = null;
let disk: FreeDisk | null = null;
/** The fat-tail read, measured BEFORE the seed's ANALYZE. Printed, never asserted (P4-AL-74). */
let beforeAnalyze: Measured | null = null;

/**
 * P4-D's MEASURED SERIES, taken once in the fixture and read by every case.
 *
 * Keyed by the read's own path. One series per read means the ceiling, the
 * ratio and the RLS cost are three questions about one population rather than
 * three populations, and it keeps the request count inside what the product's
 * own limiter will accept without waiting (`THROTTLE`).
 */
const readSeries = new Map<string, Measured>();
/** The ratio's denominator: the same read on an ordinary customer. */
let medianReceivable: Measured | null = null;
/** The RLS cost's owner half: the same statements, row security bypassed. Never the budget. */
let ownerReceivable: Measured | null = null;
/** The RLS cost's `daftar_app` half: the same statements through the product's own query function, row security applied. */
let appStatementReceivable: Measured | null = null;

/** The invoice pools P4-F consumes, per arm, and the cursor into each. */
interface AllocationPool {
  readonly customerId: string;
  readonly invoices: OpenInvoice[];
  next: number;
}
const pools = new Map<string, AllocationPool>();
let foreignRateR10 = R10;

// ───── the instrument ─────────────────────────────────────────────────────

interface Measured {
  readonly name: string;
  readonly budgetMs: number | null;
  readonly samplesMs: readonly number[];
  /**
   * DR-98. Present on the CONVERTED budgets only (`P4-D`, `P4-F-TXN`).
   * `samplesMs` above stays the WALL CLOCK the test process saw — what every
   * earlier evidence file in this slice meant by it — and this is the other
   * series: the milliseconds PostgreSQL accounted to the statements that ran
   * inside the same windows, in the same order, and the one the verdict reads.
   * Two series under two names, never one number that could be either.
   */
  readonly inDatabaseMs?: readonly number[];
}

interface Diagnostic extends Distribution {
  readonly name: string;
  readonly scale: number;
  readonly datasetTier: string;
  /** `push`, `pull_request`, or `local` when no workflow took it. */
  readonly runnerEvent: string;
  readonly workflowRunId: string;
  readonly cpuCount: number;
  readonly loadAverage: readonly number[];
  readonly processUptimeSeconds: number;
  readonly freeMemoryBytes: number;
  readonly totalMemoryBytes: number;
  readonly serverVersionNum: number;
  readonly datcollate: string;
  readonly datctype: string;
  readonly localeProvider: string | null;
  readonly databaseSizeBytes: number;
  readonly analyzeState: Record<string, { rows: number; analyzed: string | null }>;
}

const diagnostics: Diagnostic[] = [];

const datasetTier = (): string => (SCALE === 1 ? 'acceptance (D-SALES fat-tail arm)' : `tier-1 P4_PERF_SCALE=${SCALE} (D-SALES fat-tail arm)`);

/**
 * Everything `P4-AL-74`/`P4-AL-75` and the P4-S3 evidence directive require
 * printed beside a percentile verdict, computed from the samples and the
 * server and from nothing else.
 *
 * It is returned so the ASSERTION MESSAGE can carry it as well: Vitest's
 * reporter did not surface the accounting suite's `console.log` output in the
 * piped CI log, whereas the message of a failed `expect` is always printed,
 * and the distribution has to be readable while a failure is fresh.
 */
function diagnose(m: Measured, thresholdMs: number): Diagnostic {
  const d: Diagnostic = {
    ...distribution(m.samplesMs, thresholdMs),
    name: m.name,
    scale: SCALE,
    datasetTier: datasetTier(),
    runnerEvent: process.env['GITHUB_EVENT_NAME'] ?? 'local',
    workflowRunId: process.env['GITHUB_RUN_ID'] ?? 'none',
    cpuCount: cpus().length,
    loadAverage: loadavg(),
    processUptimeSeconds: Number(process.uptime().toFixed(1)),
    freeMemoryBytes: freemem(),
    totalMemoryBytes: totalmem(),
    serverVersionNum: environment.serverVersionNum,
    datcollate: environment.datcollate,
    datctype: environment.datctype,
    localeProvider: environment.localeProvider,
    databaseSizeBytes: sizeBytes,
    analyzeState: stats,
  };
  diagnostics.push(d);
  console.log(`\nDISTRIBUTION — ${m.name}\n${JSON.stringify(d, null, 1)}\n`);
  return d;
}

/**
 * The verdict and the whole series in one message, so a red is self-explanatory.
 *
 * `tag` opens the message with a PURE-ASCII marker, `P4-S4-BUDGET-FAIL-<tag>`,
 * which appears if and only if this assertion failed. The `ci.yml` controls
 * grep for it rather than for the prose that follows: the prose carries an em
 * dash and the budget's own words, and a control that greps for either is a
 * control that a rewording or a host code page can quietly defeat.
 */
function assertWithin(m: Measured, thresholdMs: number, budgetId: string, tag: string): Diagnostic {
  const d = diagnose(m, thresholdMs);
  expect(
    d.p95,
    `P4-S4-BUDGET-FAIL-${tag} judgedOn=wallClockClientMs ` +
      `${budgetId} — ${m.name}: p95 ${d.p95.toFixed(3)} ms against ${thresholdMs} ms over ${d.iterations} measured iterations ` +
      `(min ${d.min} / p50 ${d.p50} / p99 ${d.p99} / max ${d.max}; ${d.countAboveThreshold} of ${d.iterations} samples above the ceiling). ` +
      `A missed budget is a FAIL until diagnosed and the ceiling is never relaxed to obtain a PASS (P4-AL-76). ` +
      `The complete ordered series, in milliseconds, is:\n${JSON.stringify(d.orderedMs)}`,
  ).toBeLessThanOrEqual(thresholdMs);
  return d;
}

/**
 * THE VERDICT OF A CONVERTED BUDGET (DR-98): the IN-DATABASE p95 against the
 * ceiling, with the wall clock printed beside it and judging nothing.
 *
 * Both series go into `diagnostics` under names that say which is which, so the
 * performance record carries the monitored series as well as the judged one and
 * no reader has to guess which a bare `p95` meant. The residual — wall minus
 * in-database, per iteration — is the part of the old quantity this conversion
 * stopped judging (the Node-side work inside the window), printed so the
 * coverage that was given up stays visible.
 *
 * `tag` is pure ASCII and stable: the CI controls grep for `P4-S4-MONITOR-<tag>`
 * and for `P4-S4-INDB-OK-<tag>`, and the `OK` line is printed only AFTER the
 * assertion held, so a run that executed nothing cannot satisfy a control.
 */
function assertInDatabaseWithin(m: Measured, thresholdMs: number, budgetId: string, tag: string): Distribution {
  const inDb = must(m.inDatabaseMs, `${m.name}: the in-database series is absent, so this budget has no verdict to read (DR-98)`);
  expect(
    inDb.length,
    `${m.name}: ${inDb.length} in-database samples against ${m.samplesMs.length} wall-clock ones — the two series are taken in the same windows and must be the same length`,
  ).toBe(m.samplesMs.length);
  const residualMs = m.samplesMs.map((ms, i) => ms - must(inDb[i], `${m.name}: in-database sample ${i}`));
  // The judged series first, so `diagnostics[]` and the printed DISTRIBUTION
  // block carry it; then the two monitored series under their own names.
  //
  // `dv`/`dw`/`dr` are two characters on purpose, which is the convention
  // `assertWithin` above already follows with its `const d = diagnose(...)`.
  // `scripts/plan-evidence/discover-plan-claims.ts` taints any identifier of
  // three characters or more whose initialiser calls a tainted helper, and the
  // taint set is per FILE and not per scope — so naming these `verdict`,
  // `wall` and `residual` made the generator report a gate of its own kind on
  // an unrelated pre-existing `expect(verdict.authoritative …)` 1 400 lines away.
  // MEASURED: three invented plan-gate hits appeared in the inventory, and
  // renaming removed all three. A false claim in an evidence inventory is the
  // exact defect that inventory exists to prevent.
  const dv = diagnose({ name: `${m.name} — IN-DATABASE EXEC TIME, THE VERDICT`, budgetMs: thresholdMs, samplesMs: inDb }, thresholdMs);
  const dw = diagnose({ name: `${m.name} — wall clock, MONITORING ONLY (judges nothing)`, budgetMs: null, samplesMs: m.samplesMs }, thresholdMs);
  const dr = diagnose(
    { name: `${m.name} — residual wall MINUS in-database, MONITORING ONLY (the coverage this conversion gave up)`, budgetMs: null, samplesMs: residualMs },
    thresholdMs,
  );
  console.log(
    `P4-S4-MONITOR-${tag} judgedOn=inDatabaseExecMs budgetMs=${thresholdMs} iterations=${dv.iterations} ` +
      `inDbP50=${dv.p50.toFixed(3)} inDbP95=${dv.p95.toFixed(3)} inDbP99=${dv.p99.toFixed(3)} inDbMax=${dv.max.toFixed(3)} ` +
      `wallP50=${dw.p50.toFixed(3)} wallP95=${dw.p95.toFixed(3)} wallMax=${dw.max.toFixed(3)} ` +
      `residualP50=${dr.p50.toFixed(3)} residualP95=${dr.p95.toFixed(3)}`,
  );
  expect(
    dv.p95,
    `P4-S4-BUDGET-FAIL-${tag} judgedOn=inDatabaseExecMs ` +
      `${budgetId} — ${m.name}: in-database p95 ${dv.p95.toFixed(3)} ms against ${thresholdMs} ms over ${dv.iterations} measured iterations ` +
      `(in-database min ${dv.min} / p50 ${dv.p50} / p99 ${dv.p99} / max ${dv.max}; ${dv.countAboveThreshold} of ${dv.iterations} above the ceiling). ` +
      `MONITORING ONLY, judging nothing: wall clock p50 ${dw.p50} / p95 ${dw.p95} / max ${dw.max} ms, residual (wall minus in-database) p50 ${dr.p50} / p95 ${dr.p95} ms. ` +
      `A missed budget is a FAIL until diagnosed and the ceiling is never relaxed to obtain a PASS (P4-AL-76). ` +
      `The complete ordered IN-DATABASE series, in milliseconds, is:\n${JSON.stringify(dv.orderedMs)}\n` +
      `and the complete ordered WALL-CLOCK series is:\n${JSON.stringify(dw.orderedMs)}`,
  ).toBeLessThanOrEqual(thresholdMs);
  console.log(`P4-S4-INDB-OK-${tag}`);
  return dv;
}

/**
 * EVERY ARM'S VERDICT, AND THEN THE FAILURE — not the first arm's failure and
 * silence about the rest.
 *
 * WHY THIS EXISTS, MEASURED ON LINUX. Run 42223226679, job 127910205268,
 * commit 71495877: the in-database negative control (ci.yml step 54) requires
 * a `P4-S4-BUDGET-FAIL-<tag>` line for ALL FIVE converted tags, and it exited
 * on `D-AGING` with «the in-database-slowed run failed, but NOT on D-AGING's
 * own in-database assertion». The reason is structural, not a measurement: the
 * three `P4-D` reads are judged in ONE `it` by a `for` loop, as are the two
 * `P4-F-TXN` arms and the two `P4-F-HTTP` arms, and the first arm that misses
 * THROWS — so the arms after it are never evaluated and never print a marker
 * of their own. The log is the fingerprint: exactly one FAIL line per loop,
 * `D-RECEIVABLE`, `FTXN-BASE-5` and `FHTTP-BASE-5`, each the FIRST of its
 * loop. The control's demand was therefore unsatisfiable by construction.
 *
 * WHAT THIS DOES NOT CHANGE. No ceiling, no iteration count, no percentile, no
 * budget, nothing about what is judged or which clock judges it: each arm is
 * still judged by the same assertion against the same threshold, and a run in
 * which ANY arm misses still FAILS. One arm missing rethrows that arm's own
 * error unchanged. The only difference is that the arms after the first miss
 * are still EVALUATED, so each prints its own `P4-S4-MONITOR-<tag>` and either
 * `P4-S4-BUDGET-FAIL-<tag>` or `P4-S4-INDB-OK-<tag>` — which is strictly more
 * evidence, never less, and never a pass where there was a failure.
 */
function everyArm(arms: readonly (readonly [string, () => void])[]): void {
  const failures: { readonly tag: string; readonly error: unknown }[] = [];
  for (const [tag, arm] of arms) {
    try {
      arm();
    } catch (error) {
      failures.push({ tag, error });
    }
  }
  if (failures.length === 0) return;
  // NO NAMED LOCAL HERE, and that is not style. `discover-plan-claims.ts`
  // taints any identifier of three characters or more whose initialiser calls
  // a tainted helper, and the taint set is per FILE, not per scope: a
  // `const first = must(...)` here made the generator report two plan gates of
  // its own kind on unrelated PRE-EXISTING `expect(...)` calls 1 900 lines
  // away (:1917 and :1938), which is MEASURED -- the committed inventory held
  // 430 hits and the regeneration held 432, planGates 120 -> 122, with zero
  // hits removed. A false claim in an evidence inventory is the exact defect
  // that inventory exists to prevent, so the call stays anonymous.
  if (failures.length === 1) throw must(failures[0], 'a failure list that is not empty has a first element').error;
  throw new Error(
    `${failures.length} of ${arms.length} measured arms missed their budget in this run, and each one's own verdict is below ` +
      `(a budget that was never reached is not a budget that passed):\n\n` +
      failures.map((f) => `── ${f.tag} ──\n${f.error instanceof Error ? f.error.message : String(f.error)}`).join('\n\n'),
  );
}

/**
 * Warm up, then measure. The warm-up samples are discarded, never averaged in.
 *
 * `before` runs OUTSIDE the clock on every iteration, warm-up and measured
 * alike. It carries one thing only: the pacing wait the product's own rate
 * limiter requires (`receivables-s4-dataset.ts`, `THROTTLE`). A wait inside a
 * measured span would be a sample about the limiter, and a run that ignored
 * the limiter would be a run of 429s — so the wait happens, and it happens
 * where it cannot reach a number.
 */
async function measure(
  name: string,
  budgetMs: number | null,
  once: () => Promise<void>,
  iterations = SHORT_PERCENTILE_ITERATIONS,
  before: () => Promise<unknown> = async () => undefined,
  judged: 'in-database' | 'wall-clock-only' = 'wall-clock-only',
): Promise<Measured> {
  for (let i = 0; i < WARMUP; i += 1) {
    await before();
    await once();
  }
  const samplesMs: number[] = [];
  const inDatabaseMs: number[] = [];
  // DR-98. The cumulative executed milliseconds are read on the instrument's
  // OWN connection immediately before the wall-clock timer starts and
  // immediately after it stops, so both reads sit OUTSIDE the wall-clock window
  // and cost it nothing. The instrument's role is excluded from its own sum.
  const clock = judged === 'in-database' ? must(inDatabase, `${name}: the in-database instrument`) : null;
  for (let i = 0; i < iterations; i += 1) {
    await before();
    const dbBefore = clock === null ? null : await clock.read();
    const started = process.hrtime.bigint();
    // Inert in every normal run. Applied to EVERY window taken through this
    // function, including the median read and the two RLS halves, so that the
    // host-independent ratios see the same delay on both sides and stay green:
    // a control that broke a ratio would be a control about the ratio. The
    // control that is MEANT to break a ratio is knob 3, which plants its delay
    // in one arm of one quotient and never reaches this function at all —
    // `null` here says so rather than leaving it to be inferred.
    await plantControlDelays(null);
    await once();
    samplesMs.push(Number(process.hrtime.bigint() - started) / 1e6);
    if (clock !== null) inDatabaseMs.push(InDatabaseClock.delta(must(dbBefore, `${name}: the opening instrument reading`), await clock.read()));
  }
  // The eviction check is per WINDOW now, inside `delta`, where the claim it
  // makes is the claim each figure needs. See `InDatabaseClock.delta`.
  return clock === null ? { name, budgetMs, samplesMs } : { name, budgetMs, samplesMs, inDatabaseMs };
}

// ───── the read under measurement ─────────────────────────────────────────

/**
 * `P4-D`'s three product reads, each of ONE customer's receivable, every one
 * of them the real route in the real composition.
 *
 * The lock's wording is «customer balance as of a date, the fat-tail
 * customer», and the estate serves that through three routes rather than one:
 * `/receivable` is the live AR, `/receivable/aging` is the same AR split at a
 * SUPPLIED as-of date, and `/open-invoices` is the as-of picker `OD-P4-03`
 * requires, which derives every document's own outstanding. All three go
 * through `customer_ar_outstanding` / `invoice_outstanding`, so all three are
 * held to the 100 ms ceiling and none is exempted as "the expensive one". That
 * is strictly more than the lock asks for and never less.
 */
const READS = {
  receivable: (customerId: string): string => `/v1/customers/${customerId}/receivable`,
  // The standard set, in the contract's order. DR-14 narrowed `bucketDays` to
  // exactly `STANDARD_AGING_BUCKET_DAYS` (`[0, 30, 60, 90]`), so `30,60,90` —
  // what stood here — is refused by the field validator with 400. `read200`
  // holds every one of these to 200, so this suite FAILED CLOSED rather than
  // timing a rejection; had it asserted nothing about the status, the ceiling
  // would have been measured against a validation error that never reached the
  // aging reader at all, and reported a comfortable PASS for a read it never
  // performed.
  aging: (customerId: string, asOf: string): string => `/v1/customers/${customerId}/receivable/aging?asOf=${asOf}&bucketDays=0,30,60,90`,
  openInvoices: (customerId: string, asOf: string): string => `/v1/customers/${customerId}/open-invoices?asOf=${asOf}&limit=50`,
} as const;

/**
 * WHO IS A READER OF RECORD, DISCOVERED BY DEPENDENCY RATHER THAN BY NAME.
 *
 * The three definitions of the AR truth are the base of the set. They are not
 * the whole of it: `0084` moved the open-invoice page behind
 * `customer_open_invoices_page`, which holds no arithmetic of its own and
 * derives every figure it returns by CALLING `invoice_outstanding`'s array
 * form. A gate that matched the three names alone read that composition as a
 * read with no reader at all — the same defect the S1 gate's refund law had,
 * where discovery by name missed every routine reaching the protected data
 * through a call.
 *
 * So the set is the transitive closure over the Phase 4 DDL: a routine whose
 * body calls a reader of record IS one. Nothing is added by hand and nothing
 * has to be appended when the next composition lands (P4-AL-88: a list a later
 * pass must append to is a closure rule, not an invariant). P4-AL-07 is
 * untouched — the `sum(` assertion below still refuses a second copy of the
 * arithmetic in the module's own statement.
 */
const BASE_READERS_OF_RECORD = ['customer_ar_outstanding', 'customer_ar_aging', 'invoice_outstanding'] as const;

function readersOfRecord(root: string): string[] {
  const sql = phase4Sql(root);
  const defined = [
    ...new Set([...sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi)].map((m) => (m[1] ?? '').toLowerCase())),
  ];
  const known = new Set<string>(BASE_READERS_OF_RECORD);
  for (const base of BASE_READERS_OF_RECORD)
    if (!defined.includes(base))
      throw new Error(`${base} is a declared reader of record that the Phase 4 DDL does not define — the gate is reading the wrong tree, not passing.`);
  // Fixpoint, so a wrapper over a wrapper is reached too.
  for (;;) {
    let grew = false;
    for (const name of defined) {
      if (known.has(name)) continue;
      // EVERY DEFINITION of the name, not the last one. `phase4RoutineBody`
      // is signature-blind and returns the last textual match, so a routine
      // that reaches a reader of record through one overload and not another
      // was NOT discovered — and an under-discovered subject set is a route
      // quietly exempted from the ceiling. `invoice_outstanding` itself
      // carries two live signatures (`0084:526`, `0084:593`), which is where
      // this was measured (TL-P4-S5-R1, §H of the refund guard). Widening it
      // is byte-neutral on the tree as it stands — the set is the same four
      // names — and strictly wider the day it is not.
      const definitions = phase4RoutineBodies(root, name);
      if (definitions.length === 0) continue; // unreadable bodies are the S1 gate's subject, not this one's
      if (definitions.some((body) => [...known].some((r) => new RegExp(`\\b${r}\\s*\\(`, 'i').test(body)))) {
        known.add(name);
        grew = true;
      }
    }
    if (!grew) break;
  }
  return [...known].sort();
}

const READERS_OF_RECORD = readersOfRecord(join(__dirname, '..', '..'));
const READER_OF_RECORD_CALL = new RegExp(`\\b(?:public\\.)?(?:${READERS_OF_RECORD.join('|')})\\s*\\(`, 'i');
const READER_OF_RECORD_CALL_G = new RegExp(`\\b(?:public\\.)?(?:${READERS_OF_RECORD.join('|')})\\([^)]*\\)`, 'gi');

/** The three reads of one customer, labelled, so the fat-tail and median arms are built identically. */
const readsOf = (
  customerId: string,
  asOf: string,
  // `tag` is the pure-ASCII, stable marker the DR-98 monitor line and the CI
  // controls grep for (`P4-S4-MONITOR-<tag>`, `P4-S4-INDB-OK-<tag>`). It is a
  // field rather than a derivation of `label` because a control that greps for
  // a string built out of prose is a control that a reworded comment can break.
): readonly { readonly label: string; readonly path: string; readonly route: string; readonly tag: string }[] => [
  { label: 'receivable (live AR)', path: READS.receivable(customerId), route: ROUTE.receivable, tag: 'D-RECEIVABLE' },
  { label: 'receivable/aging (as of a date)', path: READS.aging(customerId, asOf), route: ROUTE.aging, tag: 'D-AGING' },
  { label: 'open-invoices (as of a date)', path: READS.openInvoices(customerId, asOf), route: ROUTE.openInvoices, tag: 'D-OPENINVOICES' },
];

/**
 * Which route HANDLER a read path belongs to, since that is what the product's
 * limiter counts. Derived from the path rather than passed around, so a new
 * read cannot be paced under the wrong allowance by accident.
 */
function routeOf(path: string): string {
  if (path.includes('/receivable/aging')) return ROUTE.aging;
  if (path.includes('/open-invoices')) return ROUTE.openInvoices;
  if (path.includes('/receivable')) return ROUTE.receivable;
  throw new Error(`no route handler is known for ${path} — pace it explicitly rather than under a guess`);
}

async function read200(path: string): Promise<void> {
  const r = await readAs(w.t, w.owner, w.shop.businessId, path, 'en');
  expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBe(200);
}

/** One read, paced first: the pacing is outside the caller's clock by construction. */
async function pacedRead200(path: string): Promise<void> {
  await pace(routeOf(path));
  await read200(path);
}

interface Captured {
  readonly scope: Scope;
  readonly text: string;
  readonly params: unknown[];
}

/** Every statement one read runs through `Database.scoped`, with its own scope and parameters. */
async function capture(path: string): Promise<Captured[]> {
  const db = w.t.app.get(Database);
  const seen: Captured[] = [];
  const original = db.scoped.bind(db);
  const spy = vi.spyOn(db, 'scoped').mockImplementation((scope, text, params = []) => {
    seen.push({ scope: { ...scope }, text, params });
    return original(scope, text, params);
  });
  try {
    // Paced like every other request: a capture is a real request on a real
    // handler, and a capture that did not count against the window would
    // leave the next measured iteration to discover the limiter.
    await pacedRead200(path);
  } finally {
    spy.mockRestore();
  }
  return seen;
}

interface PlanNode {
  readonly 'Node Type': string;
  readonly 'Relation Name'?: string;
  readonly 'Index Name'?: string;
  readonly 'Index Cond'?: string;
  readonly Plans?: readonly PlanNode[];
}

const nodesOf = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(nodesOf)];

/** EXPLAIN every captured statement under its own scope, as `daftar_app`, row security applied (P4-AL-75). */
async function plansOf(path: string): Promise<{ readonly text: string; readonly nodes: PlanNode[]; readonly json: string }[]> {
  const db = w.t.app.get(Database);
  const out: { text: string; nodes: PlanNode[]; json: string }[] = [];
  for (const c of await capture(path)) {
    const r = await db.scoped<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(c.scope, `EXPLAIN (FORMAT JSON) ${c.text}`, c.params);
    const plan = must(must(r.rows[0])['QUERY PLAN'][0]).Plan;
    out.push({ text: c.text, nodes: nodesOf(plan), json: JSON.stringify(plan) });
  }
  return out;
}

/**
 * ── WHAT THE RLS COST IS A RATIO OF, AND WHY IT IS NOT THE HTTP FIGURE ────
 *
 * P4-AL-75: «The `daftar_app` figure **is** the budget; the owner figure **on
 * the same database with the same rows** is recorded only as the RLS cost.»
 *
 * The first version of this file divided the whole HTTP figure by the
 * owner-side statement figure and measured **10.49×** on a dataset where row
 * security costs nothing like that. The number was real and the instrument was
 * wrong: 17.97 ms of HTTP request against 1.71 ms of `pool.query` is mostly
 * Nest, the auth guard, the membership resolution and JSON — the ENVELOPE —
 * and reporting that as "the cost of the policy" would have sent whoever read
 * it to look for a policy defect that is not there. Worse, under P4-AL-75's
 * FAIL-until-diagnosed rule it would have failed the suite for a reason the
 * diagnosis does not support.
 *
 * So the RLS cost is measured BETWEEN LIKE AND LIKE: the same captured
 * statements, the same rows, run
 *
 *   — as `daftar_app` through `Database.scoped` — the product's own query
 *     function, with the scope GUCs a request sets, row security APPLIED; and
 *   — as the schema owner through `ownerPool()`, row security BYPASSED.
 *
 * Neither side carries the HTTP envelope, so the ratio is the policy's cost
 * and nothing else. The HTTP figure remains the BUDGET and is reported
 * alongside, so the envelope is visible rather than hidden inside a ratio.
 */
async function statementCostMs(path: string, principal: 'daftar_app' | 'owner', iterations = SHORT_PERCENTILE_ITERATIONS): Promise<Measured> {
  const statements = await capture(path);
  const db = w.t.app.get(Database);
  const pool = ownerPool();
  return measure(
    `${principal === 'owner' ? 'OWNER (row security BYPASSED)' : 'daftar_app (row security APPLIED, scope GUCs set)'} — the captured statements of ${path}`,
    null,
    async () => {
      for (const c of statements) {
        if (principal === 'owner') await pool.query(c.text, c.params);
        else await db.scoped(c.scope, c.text, c.params);
      }
    },
    iterations,
  );
}

// ───── the command under measurement ─────────────────────────────────────

/**
 * One allocation command over `shape` invoices, taken from that arm's pool.
 *
 * `IN-TRANSACTION` and `HTTP` are measured in the SAME call rather than in two
 * runs of different work: the in-transaction figure is the span of
 * `Database.withBusinessInventoryAccountingTransaction`, which
 * `CustomerPaymentService.run` step 6 describes as «One transaction: the
 * routine, the entries, COMMIT», recorded by a spy that calls the original
 * through and times it. Nothing is mocked — the spy adds a `hrtime` read on
 * either side of the real product transaction — and the HTTP figure is the
 * whole request around it, so the two are the same operation measured at two
 * depths and their difference is the envelope rather than two populations.
 */
interface Allocated {
  readonly httpMs: number;
  readonly txnMs: number;
  /** DR-98: what PostgreSQL accounted to this REQUEST, read outside its wall-clock window. The VERDICT of `P4-F-TXN`. */
  readonly reqInDatabaseMs: number;
  /** The wall cost of the instrument's own two reads, which sit inside the HTTP window. Monitoring only. */
  readonly instrumentMs: number;
  readonly transactions: number;
  readonly status: number;
  readonly paymentId: string;
  readonly invoiceIds: readonly string[];
  readonly body: unknown;
}

async function allocate(arm: string, shape: number, currency: 'base' | 'foreign'): Promise<Allocated> {
  const pool = must(pools.get(arm), `the ${arm} invoice pool`);
  const invoices: OpenInvoice[] = [];
  for (let i = 0; i < shape; i += 1) {
    const invoice = pool.invoices[pool.next];
    pool.next += 1;
    if (invoice === undefined)
      throw new Error(`the ${arm} pool is exhausted at ${pool.next} of ${pool.invoices.length} — size it to (WARMUP + iterations) × shape`);
    invoices.push(invoice);
  }
  const legs: AllocationInput[] = invoices.map((invoice) => {
    const a = quarterOf(invoice);
    const leg: AllocationInput = {
      invoiceId: invoice.invoiceId,
      appliedMinor: a.toString(),
      releasedBeforeMinor: '0',
      invoiceTotalTxnMinor: invoice.totalTxnMinor,
      invoiceTotalBaseMinor: invoice.totalBaseMinor,
    };
    if (currency === 'base') return leg;
    const p = (a * R10) / foreignRateR10;
    return { ...leg, paymentAmountMinor: p.toString(), paymentToBaseRateR10: foreignRateR10 };
  });
  const amountMinor = legs.reduce((acc, leg) => acc + BigInt(allocationFigures(leg).paymentAmountMinor), 0n);
  const paymentId = randomUUID();
  const input: PaymentInput = {
    paymentId,
    customerId: pool.customerId,
    paymentMethodId: w.paymentMethodId,
    paymentDate: w.day,
    ...(currency === 'foreign' ? { currencyCode: FOREIGN_CURRENCY } : {}),
    amountMinor: amountMinor.toString(),
    allocations: legs,
  };

  // The pacing wait happens HERE, before the spy is installed and before the
  // clock starts: the product's limiter is 300 requests per minute per handler
  // (`THROTTLE`), and this arm alone issues WARMUP + 200 of them.
  await pace(ROUTE.payment);

  const db = w.t.app.get(Database);
  const original = db.withBusinessInventoryAccountingTransaction.bind(db);
  let txnMs = 0;
  let reqInDatabaseMs = 0;
  let instrumentMs = 0;
  let transactions = 0;
  // ── WHERE THE IN-DATABASE READS SIT, AND WHY THEY MOVED (DR-98, and the
  //    owner's remedy of 2026-11-08) ───────────────────────────────
  //
  // THEY USED TO SIT INSIDE THE JUDGED WINDOW, AND THAT WAS MEASURED TO BE
  // THE WHOLE OF `P4-F over HTTP`'s INFLATION. The two reads bracketed the
  // TRANSACTION span, and that span is nested inside the HTTP window, so the
  // HTTP figure carried two round trips to PostgreSQL. Proved on ONE commit
  // in ONE job — run 42431995284, steps 41 and 42, the same arm measured
  // twice with the same samples and the same ceiling, once with the
  // instrument inside the window and once without:
  //   FHTTP-FOREIGN-5   p50 57.315 → 25.413 ms    p95 65.769 → 28.668 ms
  //   FHTTP-BASE-5      p50 56.309 → 24.920 ms    p95 60.642 → 29.596 ms
  // and the instrument's OWN cost, measured independently in the same run,
  // was 28.730 and 28.619 ms, against median shifts of 31.902 and 31.389 —
  // agreeing to 3.172 and 2.770 ms. The inflation was the instrument.
  //
  // THE REMEDY. The reads now bracket the WHOLE REQUEST from OUTSIDE the
  // wall-clock window: one before the timer starts, one after it stops.
  // Nothing is subtracted from any judged figure, no ceiling is moved and no
  // sample count is changed.
  //
  // WHAT THE FIGURE NOW IS, STATED RATHER THAN HIDDEN. It is no longer the
  // transaction's milliseconds alone: it is every millisecond the server
  // executed for this request — the transaction plus whatever SQL the request
  // runs around it. It is therefore GREATER THAN OR EQUAL TO the figure it
  // replaces, and the two laws that read it move in OPPOSITE directions — said
  // plainly, because a single reassuring sentence here would be false:
  //   • `P4-F-TXN`'s in-database CEILING becomes STRICTER. A larger figure
  //     against an unmoved 40 ms is harder to satisfy, so a widened subject
  //     cannot buy that pass.
  //   • `P4-AL-72`'s in-database RATIO becomes LOOSER, by the same arithmetic
  //     this file already records for knob 1: the per-request SQL outside the
  //     transaction is very nearly the same `d` in both halves, and
  //     `(a + d) / (b + d)` moves TOWARDS 1 when `a > b`. That is a real cost
  //     of the remedy and it is NOT left to be inferred. What answers it is
  //     the control, not a claim: knob 3 plants its delay in the NUMERATOR arm
  //     alone, and that control is executed on every run and measured to make
  //     this verdict miss — 28.107 against the constant 3 on run 42431995284,
  //     step 58. A ratio whose negative control still fires is a ratio that
  //     can still fail.
  // That is why the field is
  // `reqInDatabaseMs` and not `txnInDatabaseMs` any more — the name carries
  // the subject, so no later reader can take it for the transaction's own.
  //
  // WHY PER REQUEST AND NOT PER ARM. The instruction read "before the arm and
  // after it"; one read per ARM would leave ONE in-database sample where
  // `P4-F-TXN` and `P4-AL-72` each need 200, and the same instruction forbids
  // changing the samples. So the reads left the window and stayed per
  // request. `instrumentMs` keeps being measured and printed, and it is now a
  // cost that sits OUTSIDE every judged figure.
  const clock = inDatabase;
  const readClock = async (): Promise<InDatabaseReading | null> => {
    if (clock === null) return null;
    const at = process.hrtime.bigint();
    try {
      return await clock.read();
    } finally {
      instrumentMs += Number(process.hrtime.bigint() - at) / 1e6;
    }
  };
  const spy = vi.spyOn(db, 'withBusinessInventoryAccountingTransaction').mockImplementation(async (...args: Parameters<typeof original>) => {
    transactions += 1;
    const started = process.hrtime.bigint();
    try {
      // The control delays, at the head of the measured transaction window.
      // Inert in every normal run. `shape` is what knob 3 selects on: it fires
      // in the five-invoice arm and nowhere else.
      await plantControlDelays(shape);
      return await original(...args);
    } finally {
      txnMs += Number(process.hrtime.bigint() - started) / 1e6;
    }
  });
  let res: Response;
  // THE OPENING READ, OUTSIDE THE WINDOW: before the wall-clock timer starts.
  const dbBefore = await readClock();
  const started = process.hrtime.bigint();
  try {
    res = await collectPayment(w.t, w.headers, input);
  } finally {
    spy.mockRestore();
  }
  const httpMs = Number(process.hrtime.bigint() - started) / 1e6;
  // AND THE CLOSING READ, OUTSIDE THE WINDOW: after it stops. Neither read
  // can reach `httpMs`, which is what run 42431995284 proved was needed.
  if (clock !== null)
    reqInDatabaseMs = InDatabaseClock.delta(
      must(dbBefore, 'the opening instrument reading, taken before the request and outside its measured window'),
      must(await readClock(), 'the closing instrument reading, taken after the request and outside its measured window'),
    );
  return {
    httpMs,
    txnMs,
    reqInDatabaseMs,
    instrumentMs,
    transactions,
    status: res.status,
    paymentId,
    invoiceIds: invoices.map((i) => i.invoiceId),
    body: res.body,
  };
}

/** One arm's measured series, both depths, taken from one pass over the pool. */
interface AllocationSeries {
  readonly arm: string;
  readonly shape: number;
  readonly currency: 'base' | 'foreign';
  readonly httpMs: readonly number[];
  readonly txnMs: readonly number[];
  /** DR-98: the in-database execution time of each REQUEST, in the same order, both reads outside the window. */
  readonly reqInDatabaseMs: readonly number[];
  /** The instrument's own wall cost inside each HTTP window, in the same order. Monitoring only. */
  readonly instrumentMs: readonly number[];
  readonly transactionsPerCommand: readonly number[];
  /** Every committed payment, so the journal-entry gate can read the rows afterwards. */
  readonly paymentIds: readonly string[];
}

async function measureAllocations(arm: string, shape: number, currency: 'base' | 'foreign'): Promise<AllocationSeries> {
  for (let i = 0; i < WARMUP; i += 1) {
    const warm = await allocate(arm, shape, currency);
    expect(warm.status, `the ${arm} warm-up collection commits: ${JSON.stringify(warm.body)}`).toBeLessThan(300);
  }
  const httpMs: number[] = [];
  const txnMs: number[] = [];
  const reqInDatabaseMs: number[] = [];
  const instrumentMs: number[] = [];
  const transactionsPerCommand: number[] = [];
  const paymentIds: string[] = [];
  for (let i = 0; i < SHORT_PERCENTILE_ITERATIONS; i += 1) {
    const r = await allocate(arm, shape, currency);
    expect(r.status, `the ${arm} collection ${i} commits: ${JSON.stringify(r.body)}`).toBeLessThan(300);
    httpMs.push(r.httpMs);
    txnMs.push(r.txnMs);
    reqInDatabaseMs.push(r.reqInDatabaseMs);
    instrumentMs.push(r.instrumentMs);
    transactionsPerCommand.push(r.transactions);
    paymentIds.push(r.paymentId);
  }
  // DR-98: the eviction check is per WINDOW, inside `InDatabaseClock.delta`,
  // which is where each figure's own trust claim lives. See that method for the
  // measured reason the whole-lifetime check was wrong here.
  return { arm, shape, currency, httpMs, txnMs, reqInDatabaseMs, instrumentMs, transactionsPerCommand, paymentIds };
}

const series = new Map<string, AllocationSeries>();

/** How many journal entries one payment posted, and how many allocation rows it wrote. */
async function postedEntries(paymentId: string): Promise<{ readonly entries: number; readonly allocations: number; readonly lines: number }> {
  // The entry is found through `accounting_source_bindings` — the binding, not
  // a guessed order — exactly as `tests/golden-regression/phase4-s4/harness.ts`
  // `entryOfSource` finds it, so there is one way of answering "which entry is
  // this allocation's" in the estate rather than two.
  const r = await ownerPool().query<{ entries: string; allocations: string; lines: string }>(
    `WITH a AS (SELECT id FROM payment_allocations WHERE business_id = $1 AND payment_id = $2),
          e AS (SELECT b.journal_entry_id AS id FROM accounting_source_bindings b
                 WHERE b.business_id = $1 AND b.source_type = 'customer_payment_allocation' AND b.source_id IN (SELECT id FROM a))
     SELECT (SELECT count(DISTINCT id)::text FROM e) AS entries,
            (SELECT count(*)::text FROM a) AS allocations,
            (SELECT count(*)::text FROM journal_lines l WHERE l.business_id = $1 AND l.journal_entry_id IN (SELECT id FROM e)) AS lines`,
    [w.shop.businessId, paymentId],
  );
  const row = must(r.rows[0], `the posted entries of payment ${paymentId}`);
  return { entries: Number.parseInt(row.entries, 10), allocations: Number.parseInt(row.allocations, 10), lines: Number.parseInt(row.lines, 10) };
}

// ───── THE RUN ACCOUNTS FOR ITSELF ───────────────────────────────────────

/**
 * ── WHY THIS SECTION EXISTS: SEVENTEEN SKIPPED TESTS READ AS GREEN ────────
 *
 * MEASURED, not assumed. The first acceptance-scale run of this file died in
 * its `beforeAll` 902 seconds in (the bearer's 900-second TTL plus the request
 * that met it). Vitest reported `1 failed | 17 skipped`, and the wrapper the
 * run was piped through exited 0 — so the one number a reader is most likely
 * to trust said the opposite of what had happened, on a suite whose own law
 * forbids skipping a case at all.
 *
 * `vitest run` itself does exit 1 on a failed hook — MEASURED on this version,
 * and `tests/helpers/exit-code.ts` already guards the one way the runner used
 * to lose that 1 — so the 0 came from the pipe the run was read through.
 * That is precisely why the remedy is not "remember to read the exit code".
 * This repository's standing rule is that a wrapper's exit code is NOT the
 * run's verdict, and a suite that depends on anybody remembering that rule has
 * delegated its verdict to a convention. So the suite states its own verdict,
 * in three layers that do not share a failure mode:
 *
 *   1. A FIXTURE FAILURE IS NOT A SKIP. `beforeAll` catches, records and does
 *      NOT rethrow, so every case still RUNS and every case fails through
 *      `requireFixture()` naming the fixture's own error. Seventeen skipped
 *      tests become eighteen failed ones: there is no reading of that report
 *      in which the run looks green.
 *   2. A CENSUS CASE counts the series and their samples, and is written so
 *      that nothing having run cannot satisfy it — it asserts the NUMBER of
 *      measured series as well as each series' length, against the declared
 *      constants, so an absent series is as red as a short one.
 *   3. AN `afterAll` AUDIT reads Vitest's own task tree — which runs even when
 *      `beforeAll` threw, measured on this version — and throws unless every
 *      declared case actually ran with a pass-or-fail verdict. A case that was
 *      skipped, was never reached, or was marked `.skip`/`.todo` by a later
 *      hand is a failure of this audit, independent of every assertion above
 *      it and of the exit code. The audit also PRINTS the verdict in words.
 */

/**
 * THE DECLARED CASE COUNT of this file: the `it` cases the audit requires to
 * have run.
 *
 * A literal that must be bumped when a case is added is the point rather than
 * a nuisance: the suite's law is that no case may be skipped, and a census
 * whose expected size is derived from whatever happened to execute is not a
 * census. The audit names every missing case, so a mismatch is never a riddle.
 */
const DECLARED_CASES = 18;

/** The P4-D read series this file declares: three fat-tail HTTP reads + median + the two RLS halves. */
const DECLARED_READ_SERIES = 3;
/** The P4-F arms this file declares, one per `ALLOCATION_ARMS` entry. */
const DECLARED_ALLOCATION_ARMS = ALLOCATION_ARMS.length;

/**
 * The fixture's own error, recorded instead of thrown (layer 1 above).
 *
 * `null` means the fixture completed. Anything else means every figure below
 * is absent and every case must say so rather than be skipped.
 */
let fixtureError: unknown = null;

/** The first statement of every case: a fixture that did not finish is this case's failure too. */
function requireFixture(): void {
  if (fixtureError === null) return;
  const e = fixtureError;
  throw new Error(
    `THE FIXTURE DID NOT COMPLETE, so this case measured nothing and its silence is not a pass. ` +
      `A seed failure is a RED on every case of this file, never a skip (and never an exit code nobody read). ` +
      `The fixture's own error was:\n${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
  );
}

// ───── the fixture ───────────────────────────────────────────────────────

/**
 * THE FIXTURE PROPER. Everything the cases read is built here, and the one
 * caller below records its failure instead of letting Vitest turn the whole
 * file into a skip.
 */
async function buildFixture(): Promise<void> {
  await ensurePostgres();
  await resetData();
  w = await settlementWorld('s4perf');
  // THE BEARER, BEFORE ANYTHING LONG HAPPENS. `registerActor`'s token lives
  // 900 seconds and this seed runs for far longer, so the keeper takes over
  // the actor's authentication here and re-mints inside `pace()` — outside
  // every measured span — for the rest of the run.
  await installAuthKeeper(w);
  const missing = await settlementMissing(w);
  expect(missing, `NO SUBJECT — P4-D and P4-F cannot be measured while the slice's own subject is absent: ${missing.join(', ')}`).toEqual([]);

  dataset = await seedFatTailArm(w);
  foreignRateR10 = rateToR10(FOREIGN_RATE);

  // P4-F's own invoice pools, one per arm, each on its own customer so the
  // fat-tail counts the volume case asserts cannot be disturbed by the
  // measurement that follows it.
  //
  // Priced stock for the whole pool FIRST, in one adjustment: the pool is a
  // function of the sample count, not of the dataset tier, so the seed above
  // cannot know how much it needs and a sale that ran out of stock would
  // refuse with `inventory.insufficient_stock` — which is exactly what it did
  // the first time this fixture was run.
  const poolUnits = ALLOCATION_ARMS.reduce((acc, { shape }) => acc + allocationPoolSize(shape), 0);
  await pacedStockUp(w, String(poolUnits + 16), '5');
  for (const { shape, currency } of ALLOCATION_ARMS) {
    const customerId = await newCustomer(w);
    const invoices: OpenInvoice[] = [];
    for (let i = 0; i < allocationPoolSize(shape); i += 1) invoices.push(await pacedSellOnCredit(w, customerId, '1'));
    pools.set(`${currency}-${shape}`, { customerId, invoices, next: 0 });
  }
  // The foreign rate is entered by the seed; re-stated here only if the arm
  // exists without it, which `stateFxRate` makes idempotent on (pair, instant).
  await stateFxRate(w, FOREIGN_CURRENCY, dataset.baseCurrencyCode, FOREIGN_RATE, `${w.day}T00:00:02Z`);

  // ── DR-98. THE INSTRUMENT, OPENED AND PROVED BEFORE ANY BUDGET LEANS ON IT ──
  //
  // `InDatabaseClock.open` reads `shared_preload_libraries`,
  // `pg_stat_statements.track` and `track_utility` FROM THE SERVER and refuses
  // to continue unless they are what the measurement relies on. There is no
  // fallback to the wall clock: a server without the library throws
  // PERF01-INSTRUMENT-UNAVAILABLE and this fixture fails by name, which
  // `requireFixture()` turns into a red on every case of this file.
  //
  // `calibrate` is the instrument's own POSITIVE control, and it is the reason
  // a low in-database figure cannot be read as a database that is simply very
  // fast: 50 ms that a `daftar_app` session — a NON-superuser, the principal
  // the budgets are about — spends inside the database must be accounted as at
  // least 49, or the probe is filtering away the application's statements.
  inDatabase = await InDatabaseClock.open('daftar');
  await inDatabase.calibrate(49, async () => {
    const c = new Client({ connectionString: appDbUrl });
    await c.connect();
    try {
      await c.query('SELECT pg_sleep(0.05)');
    } finally {
      await c.end();
    }
  });
  console.log(`\n[P4-S4 budgets] DR-98 in-database instrument, as the SERVER reports it — ${JSON.stringify(inDatabase.settings, null, 1)}\n`);
  // Control knob 1's connection, as `daftar_app`: the same principal the
  // budgets are about, so the planted delay is accounted exactly as the
  // product's own statements are. Null — and the knob inert — in every normal run.
  if (IN_DB_DELAY_MS > 0 || IN_DB_DELAY_MS_FIVE > 0) {
    delayer = new Client({ connectionString: appDbUrl });
    await delayer.connect();
  }
  if (IN_DB_DELAY_MS > 0)
    console.log(`\n[P4-S4 budgets] CONTROL 1 ARMED — a ${IN_DB_DELAY_MS} ms pg_sleep is planted INSIDE every measured window, on a daftar_app connection\n`);
  if (IN_DB_DELAY_MS_FIVE > 0)
    console.log(
      `\n[P4-S4 budgets] CONTROL 3 ARMED — a ${IN_DB_DELAY_MS_FIVE} ms pg_sleep is planted INSIDE the FIVE-INVOICE allocation window ONLY, on a daftar_app connection: P4-AL-72's numerator and not its denominator\n`,
    );
  if (CLIENT_DELAY_MS > 0)
    console.log(
      `\n[P4-S4 budgets] CONTROL 2 ARMED — a ${CLIENT_DELAY_MS} ms setTimeout is planted OUTSIDE every query, at the head of every measured window\n`,
    );

  environment = await readPlanEvidenceEnvironment(async <R>(sql: string) => ({ rows: (await ownerPool().query(sql)).rows as R[] }));
  // WHICH server, and how much room it had — both before a single figure is
  // taken. The free space is read first because a measurement that ran the
  // filesystem out is a measurement about the filesystem, and a reader has to
  // be able to rule that out afterwards rather than wonder.
  provenance = serverProvenance(environment.serverMajor);
  disk = await freeDisk();
  console.log(`\n[P4-S4 budgets] the server these figures are taken on — ${JSON.stringify({ provenance, freeDisk: disk }, null, 1)}\n`);

  // P4-AL-74 in one measurement: the SAME read, on the SAME rows, with and
  // without planner statistics. Printed, never asserted — it exists so the
  // budget's number can never be mistaken for a number about missing
  // statistics. Thirty iterations, because it is a diagnostic and not a
  // verdict.
  beforeAnalyze = await measure(
    'P4-D receivable, fat-tail, BEFORE ANALYZE (diagnostic, never a verdict)',
    null,
    () => read200(READS.receivable(dataset.fatCustomerId)),
    30,
    () => pace(ROUTE.receivable),
  );
  await ownerPool().query('ANALYZE');

  volume = await realizedVolume(w.shop.businessId, dataset);
  stats = await planningStatistics();
  sizeBytes = await datasetSizeBytes();
  sizes = await relationSizes();

  console.log(
    `\n${planEvidenceBanner(environment)}\n[P4-S4 budgets] ${JSON.stringify(
      {
        scale: SCALE,
        datasetTier: datasetTier(),
        seedSeconds: dataset.seedSeconds,
        volume,
        databaseSizeBytes: sizeBytes,
        relationSizes: sizes,
        analyzeState: stats,
        cpus: cpus().length,
        loadAverage: loadavg(),
        totalmemGiB: Math.round(totalmem() / 2 ** 30),
        beforeAnalyzeP95: beforeAnalyze === null ? null : quantile(beforeAnalyze.samplesMs, 0.95),
      },
      null,
      1,
    )}\n`,
  );

  // ── P4-D's SERIES ARE TAKEN ONCE, HERE, AND REUSED ─────────────────────
  //
  // The ceiling case, the fat-tail-over-median ratio and the RLS cost all
  // ask a question about the SAME read. Measuring it three times would make
  // them three different populations — a run could then pass the ceiling on
  // one sample of 200 and compute its ratio from another — and it would also
  // put 1 000-odd requests on one route handler, which the product's own
  // limiter (300 per minute, `THROTTLE`) would make this suite wait out for
  // no gain. So each series is measured ONCE and every case below reads the
  // stored series.
  const medianCustomerId = must(dataset.medianCustomerIds[0], 'the first median customer');
  for (const { label, path, route } of readsOf(dataset.fatCustomerId, w.day)) {
    readSeries.set(
      path,
      await measure(
        `P4-D ${label}, fat-tail customer (${FAT_TAIL.invoices} invoices, ${FAT_TAIL.allocations} allocations) — as daftar_app, THE BUDGET`,
        BUDGET.D_BALANCE_P95,
        () => read200(path),
        SHORT_PERCENTILE_ITERATIONS,
        () => pace(route),
        // DR-98: this is a BUDGET series, so it carries the in-database verdict
        // series as well as the wall clock. The median and the two RLS halves
        // below are not budgets — they are the denominators of host-independent
        // ratios — and stay on the wall clock on both sides of their ratio.
        'in-database',
      ),
    );
  }
  medianReceivable = await measure(
    `P4-D receivable, MEDIAN customer (${MEDIAN.invoicesEach} invoices) — the ratio's denominator`,
    null,
    () => read200(READS.receivable(medianCustomerId)),
    SHORT_PERCENTILE_ITERATIONS,
    () => pace(ROUTE.receivable),
  );
  // The RLS cost's two halves, like against like: the SAME captured
  // statements on the SAME rows, as `daftar_app` through the product's own
  // query function with row security applied, and as the schema owner with
  // row security bypassed. Neither carries the HTTP envelope; the owner
  // figure is never the budget (P4-AL-75).
  appStatementReceivable = await statementCostMs(READS.receivable(dataset.fatCustomerId), 'daftar_app');
  ownerReceivable = await statementCostMs(READS.receivable(dataset.fatCustomerId), 'owner');

  // The three P4-F arms, measured here so the gates below can read the rows
  // the measurement wrote rather than taking a second, different sample.
  for (const { shape, currency } of ALLOCATION_ARMS) series.set(`${currency}-${shape}`, await measureAllocations(`${currency}-${shape}`, shape, currency));

  console.log(
    `\n[P4-S4 budgets] pacing against the product's own limiter — ${JSON.stringify(pacingReport(), null, 1)}` +
      `\n[P4-S4 budgets] authentication kept fresh across the seed — ${JSON.stringify(authReport(), null, 1)}\n`,
  );
}

beforeAll(
  async () => {
    // A FIXTURE FAILURE IS NOT A SKIP (layer 1 of `THE RUN ACCOUNTS FOR
    // ITSELF`). The error is recorded and NOT rethrown, because a thrown hook
    // leaves Vitest reporting every case of this file as skipped — which is
    // exactly how a dead seed once read as a green run. Recorded, every case
    // runs and every case fails through `requireFixture()` naming this error.
    try {
      await buildFixture();
    } catch (e) {
      fixtureError = e;
      console.error(
        `\n[P4-S4 budgets] THE FIXTURE FAILED — every case of this file will now FAIL naming it, and none will be skipped.\n` +
          `${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n` +
          `[P4-S4 budgets] load context at the failure — ${JSON.stringify({ pacing: pacingReport(), auth: authReport() }, null, 1)}\n`,
      );
    }
  },
  4 * 60 * 60 * 1000,
);

/**
 * CLEAN UP, THEN AUDIT THE RUN ITSELF (layer 3 of `THE RUN ACCOUNTS FOR
 * ITSELF`).
 *
 * The audit reads Vitest's own task tree — the second hook argument — because
 * that is the only account of the run that cannot be satisfied by nothing
 * having happened: it lists the cases that exist and what verdict each one
 * actually reached. `afterAll` runs even when `beforeAll` threw (measured on
 * Vitest 4.1.11), so this is the backstop for any future way of killing the
 * fixture, and it fires whatever the exit code of whatever wrapper the run was
 * piped through.
 *
 * The cleanup runs FIRST and in a `finally`, so an audit failure never leaks a
 * server or a database.
 */
// The empty pattern is Vitest 4's own calling convention and not a style
// choice: the suite task tree is the hook's SECOND argument, and the parser
// refuses a first argument that is a plain identifier ("access it in the 2nd
// argument instead") or a rest pattern ("rest parameters are not supported"),
// while any NAMED property is read as a fixture request the hook has no
// context for. An empty destructure is the only form that reaches the suite.
// eslint-disable-next-line no-empty-pattern
afterAll(async ({}, suite: { readonly tasks?: readonly unknown[] }) => {
  try {
    if (w !== undefined) await w.t.close();
    await resetData();
    // DR-98: the instrument and the control's connection, closed whatever
    // happened, before the audit speaks.
    await delayer?.end().catch(() => undefined);
    await inDatabase?.close().catch(() => undefined);
  } finally {
    auditTheRun(suite);
  }
});

/**
 * EVERYTHING `P4-AL-74`, `P4-AL-75`, `P4-AL-76` AND `TL-P4-S3-R4` REQUIRE
 * PRINTED BESIDE THE FIGURES, in one object, built from the server and the
 * samples and from nothing else.
 *
 * It is a FUNCTION of module state rather than a case-local literal because
 * two different things print it, and they print it for different reasons.
 * MEASURED on Vitest 4.1.11, read through a pipe: the default reporter drops
 * the `console.log` of every PASSING case, surfaces a FAILING case's and a
 * HOOK's, and on a run with no failure surfaces nothing at all — the hazard
 * `diagnose()` above already records, in its full extent. The evidence this
 * record holds comes from a case that passes when the suite is green, so in a
 * piped green run it was being written to nowhere.
 *
 * So it is printed twice, and each printing answers one half of that. The
 * environment case prints it beside the case that asserts on it, which the
 * `--reporter=verbose` of `npm run perf:phase4:s4` surfaces. The `afterAll`
 * audit prints it again, which the DEFAULT reporter surfaces whenever this
 * file fails — so the run that most needs its load context never loses it,
 * even under a bare `vitest run`. A record that exists only when somebody
 * remembers a reporter flag is the same defect as a verdict that exists only
 * in an exit code nobody read.
 */
function performanceRecord(): Record<string, unknown> {
  return {
    serverVersion: environment.serverVersion,
    serverVersionNum: environment.serverVersionNum,
    serverMajor: environment.serverMajor,
    datname: environment.datname,
    datcollate: environment.datcollate,
    datctype: environment.datctype,
    localeProvider: environment.localeProvider,
    icuLocale: environment.icuLocale,
    collationIsByteOrder: environment.collationIsByteOrder,
    encoding: environment.encoding,
    // WHICH server answered, by a stated rule over two measurements rather
    // than by assumption, and how much room it had.
    server: provenance,
    freeDisk: disk,
    // The deployment target's own collation SPELLING beside this run's, with
    // the property that is actually load-bearing, so a reader is never left to
    // compare two strings in two places (`plan-evidence-env.ts`).
    deploymentCollation: {
      ciService: CI_SERVICE_COLLATION,
      thisRun: { spelling: environment.datcollate, byteOrder: environment.collationIsByteOrder },
      spellingsIdentical: environment.datcollate === CI_SERVICE_COLLATION.spelling,
      propertyIdentical: environment.collationIsByteOrder === CI_SERVICE_COLLATION.byteOrder,
      note: 'TARGET_PLAN_EVIDENCE_CONTRACT gates on the property, never the spelling; the spelling is recorded, not matched',
    },
    datasetTier: datasetTier(),
    databaseSizeBytes: sizeBytes,
    relationSizes: sizes,
    analyzeState: stats,
    iterations: SHORT_PERCENTILE_ITERATIONS,
    warmup: WARMUP,
    cpuCount: cpus().length,
    loadAverage: loadavg(),
    freeMemoryBytes: freemem(),
    // The product's own rate limit, and what pacing against it cost: part of
    // the load context, because a reader has to know that a wait happened,
    // where it happened, and that it was never inside a measured span.
    productRateLimit: { ...THROTTLE, reference: 'apps/api/src/app/runtime.ts:116' },
    pacing: pacingReport(),
    // The re-authentications this run needed, and when: the seed outlives the
    // bearer's 900-second TTL, so a reader has to be able to see that the
    // fixture re-minted through the product's own login route and that every
    // re-mint happened outside a measured span (inside `pace()`).
    authentication: authReport(),
    planEvidence: classifyPlanEvidence(environment),
    /**
     * DR-98: HOW the converted budgets were measured, as the SERVER reported
     * it, and what the two control knobs were set to on this run. A reader who
     * has only this record can tell which series was the verdict and whether a
     * control was armed, instead of inferring it from a step name.
     */
    inDatabaseInstrument:
      inDatabase === null ? null : { source: 'pg_stat_statements.total_exec_time (delta, dbid-filtered, probe role excluded)', ...inDatabase.settings },
    judgedOn: {
      'P4-D': 'inDatabaseExecMs',
      'P4-F-TXN': 'inDatabaseExecMs',
      'P4-F-HTTP': 'wallClockClientMs — deliberately not converted: its subject is the endpoint over HTTP',
      'P4-AL-72 allocation 1-to-5 scaling ratio':
        'inDatabaseExecMs on BOTH halves — numerator and denominator from the same instrument (owner decision 2026-11-07)',
    },
    controls: {
      inDatabaseDelayMs: IN_DB_DELAY_MS,
      inDatabaseDelayMsFiveInvoiceArmOnly: IN_DB_DELAY_MS_FIVE,
      clientSideDelayMs: CLIENT_DELAY_MS,
    },
    distributions: diagnostics.map((d) => ({ name: d.name, iterations: d.iterations, p95: d.p95, thresholdMs: d.thresholdMs, orderedMs: d.orderedMs })),
  };
}

interface TaskNode {
  readonly type?: string;
  readonly name?: string;
  readonly mode?: string;
  readonly tasks?: readonly TaskNode[];
  readonly result?: { readonly state?: string };
}

/** Every `it` case of this file, flattened out of Vitest's own task tree. */
function casesOf(node: TaskNode): TaskNode[] {
  const here = node.type === 'test' ? [node] : [];
  return [...here, ...(node.tasks ?? []).flatMap(casesOf)];
}

function auditTheRun(suite: { readonly tasks?: readonly unknown[] }): void {
  const cases = casesOf(suite as TaskNode);
  const verdictOf = (t: TaskNode): string => (t.mode !== 'run' ? `marked ${t.mode}` : (t.result?.state ?? 'never reached'));
  const ran = cases.filter((t) => t.mode === 'run' && (t.result?.state === 'pass' || t.result?.state === 'fail'));
  const failed = ran.filter((t) => t.result?.state === 'fail');
  const unaccounted = cases.filter((t) => !ran.includes(t)).map((t) => `${t.name ?? '(unnamed)'} — ${verdictOf(t)}`);
  const record = {
    declaredCases: DECLARED_CASES,
    casesInTheFile: cases.length,
    ranToAVerdict: ran.length,
    passed: ran.length - failed.length,
    failed: failed.length,
    unaccounted,
    fixtureCompleted: fixtureError === null,
  };
  const green = fixtureError === null && cases.length === DECLARED_CASES && ran.length === DECLARED_CASES && failed.length === 0;
  // THE VERDICT, IN WORDS, IN THE LOG. The exit code of a piped wrapper is not
  // this run's verdict and never was; this line is.
  console.log(`\n[P4-S4 budgets] VERDICT — ${green ? 'GREEN' : 'RED'}: ${JSON.stringify(record, null, 1)}\n`);
  // AND THE RECORD ITSELF, FROM THE HOOK. The environment case prints it too,
  // but a passing case's output does not survive the default reporter through
  // a pipe; a hook's does whenever the file fails. So a RED run always carries
  // the load context its diagnosis needs, whatever it was run with.
  if (fixtureError === null) console.log(`\nP4-S4 PERFORMANCE RECORD — ${JSON.stringify(performanceRecord(), null, 1)}\n`);
  if (cases.length !== DECLARED_CASES)
    throw new Error(
      `THE CENSUS DOES NOT ADD UP: this file declares ${DECLARED_CASES} cases and Vitest found ${cases.length}. ` +
        `A case was added or removed without the declaration (or with a \`.skip\`/\`.todo\`, which this suite forbids outright). ` +
        `Bump DECLARED_CASES in the same diff as the case.`,
    );
  if (unaccounted.length > 0)
    throw new Error(
      `${unaccounted.length} of ${DECLARED_CASES} declared cases did not run to a verdict, so this run proved nothing about them ` +
        `and MUST NOT be read as a pass — whatever the exit code of the wrapper it was piped through. ` +
        `A fixture that dies is a RED on this file, not seventeen quiet skips:\n  ${unaccounted.join('\n  ')}`,
    );
}

// ───── P4-D ──────────────────────────────────────────────────────────────

describe(`P4-D — the customer receivable read (scale ${SCALE}, ${SCALE === 1 ? 'acceptance volume' : 'Tier 1, same ceilings on less data'})`, () => {
  it('the realized volume is P4-AL-73’s fat-tail customer, and every one of its invoices is actually in the AR sum', () => {
    requireFixture();
    expect(volume.fatOpenInvoices, 'the fat-tail customer has P4-AL-73’s invoice count').toBe(FAT_TAIL.invoices);
    expect(volume.fatAllocations, 'and P4-AL-73’s allocation count, two per invoice').toBe(FAT_TAIL.allocations);
    // `customer_ar_outstanding` drops a chain settled to zero through its
    // `HAVING`, so a dataset of closed invoices would be a dataset the budget
    // never reads. Every invoice must still owe something.
    expect(
      volume.fatOutstandingInvoices,
      'every fat-tail invoice still carries a non-zero outstanding, or the read walks fewer rows than the volume claims',
    ).toBe(FAT_TAIL.invoices);
    // Both arms of `invoice_outstanding`'s UNION ALL carry rows (`0081:1334`).
    expect(volume.fatCredits, 'customer credits exist, or the credit half of the reader of record is unmeasured').toBeGreaterThan(0);
    expect(volume.fatCreditApplications, 'credit APPLICATIONS exist, or invoice_outstanding’s second UNION arm is empty').toBeGreaterThan(0);
    // The payment-side currency mix (`P4-AL-73`, realized where this head permits one).
    expect(volume.fatForeignPayments, `a ${FOREIGN_CURRENCY} payment share exists, or the FX snapshot path is bypassed rather than measured`).toBeGreaterThan(
      0,
    );
    // The ratio's denominator is a real customer, not an empty one.
    expect(volume.medianCustomers).toBe(MEDIAN.customers);
    expect(
      volume.medianOpenInvoicesEach.every((n) => n === MEDIAN.invoicesEach),
      `each median customer holds ${MEDIAN.invoicesEach} open invoices`,
    ).toBe(true);
  });

  it('every relation this read touches has planner statistics — a null fails the suite (P4-AL-74)', () => {
    requireFixture();
    const missing = Object.entries(stats)
      .filter(([, s]) => s.analyzed === null)
      .map(([relname]) => relname);
    expect(
      missing,
      `[[daftar-a-benchmark-measures-what-the-planner-saw]] — these relations have no statistics, so any figure below is a figure about the missing statistics: ${missing.join(', ')}`,
    ).toEqual([]);
    expect(Object.keys(stats).length, 'the statistics query found no measured relation at all').toBeGreaterThan(0);
  });

  it('GATE: no statement of this read uses OFFSET', async () => {
    requireFixture();
    for (const { label, path } of readsOf(dataset.fatCustomerId, w.day)) {
      for (const c of await capture(path)) {
        expect(/\bOFFSET\b/i.test(c.text), `${label}: a receivable read paginated by OFFSET re-walks the skipped rows on every page:\n${c.text}`).toBe(false);
      }
    }
  });

  it('GATE: the statement count is the same for a 2 000-invoice customer and for a 3-invoice one', async () => {
    requireFixture();
    const median = must(dataset.medianCustomerIds[0], 'the first median customer');
    for (const [i, { label, path }] of readsOf(dataset.fatCustomerId, w.day).entries()) {
      const fat = await capture(path);
      const thin = await capture(must(readsOf(median, w.day)[i], 'the median arm of the same read').path);
      expect(
        fat.length,
        `${label}: the fat-tail customer's read ran ${fat.length} statements and the median customer's ran ${thin.length}. ` +
          `A statement count that grows with the row count is an N+1, and no millisecond ceiling can describe one.`,
      ).toBe(thin.length);
    }
  });

  /**
   * GATE. The money comes out of the PRODUCT'S OWN reader of record, and the
   * module holds none of the arithmetic (P4-AL-07).
   *
   * This is a property of the statement the module runs — it either calls
   * `customer_ar_outstanding(...)` or it sums invoices itself — so it is
   * host-independent and it is red on any machine the day somebody writes a
   * second copy of the arithmetic into TypeScript or into the read.
   */
  it('GATE: every P4-D read derives its money through the product’s own reader of record, and sums nothing itself', async () => {
    requireFixture();
    const byRead: Record<string, string[]> = {};
    for (const { label, path } of readsOf(dataset.fatCustomerId, w.day)) {
      const statements = await capture(path);
      const money = statements.filter((c) => READER_OF_RECORD_CALL.test(c.text));
      byRead[label] = money.map((c) => c.text.replace(/\s+/g, ' ').slice(0, 160));
      expect(
        money.length,
        `${label}: no statement of this read calls a reader of record. The readers of record, discovered by dependency over the Phase 4 DDL, are: ${READERS_OF_RECORD.join(', ')}. P4-AL-07: "a second copy of the arithmetic in TypeScript is a second truth with a slower failure mode."`,
      ).toBeGreaterThan(0);
      for (const c of statements) {
        // A `sum(` in the read's OWN statement would be the second copy. The
        // readers of record sum inside their own bodies, which is the point.
        expect(/\bsum\s*\(/i.test(c.text.replace(READER_OF_RECORD_CALL_G, '')), `${label}: this read sums money itself:\n${c.text}`).toBe(false);
      }
    }
    console.log(`\nREADERS OF RECORD — P4-D\n${JSON.stringify(byRead, null, 1)}\n`);
  });

  /**
   * FINDING, measured on this cluster and recorded rather than asserted away:
   * **the reader of record is NOT inlinable**, so no outer-plan index claim
   * about `invoices` can be made at all.
   *
   * `customer_ar_outstanding` is `LANGUAGE sql STABLE`, which is the shape
   * PostgreSQL CAN inline — but its body carries `sum(...)`, `GROUP BY` and
   * `HAVING` (`0083:365-378`, the LIVE body — `0075:776-790` is the superseded
   * definition this comment used to cite), and `inline_set_returning_function` refuses a
   * body with aggregates or grouping. Measured: the plan of the statement this
   * module actually runs is `Sort → Function Scan`, with no `invoices` node in
   * it anywhere.
   *
   * Two consequences, both stated:
   *
   *   1. `invoice_outstanding` — a `plpgsql` function, so never inlinable
   *      either — is invoked ONCE PER OPEN INVOICE inside that function scan.
   *      That is the per-row helper-call shape `[[daftar-rls-policy-shape-is-a-cost]]`
   *      is about, and it is what the fat-tail-over-median RATIO measures. The
   *      ratio, not a plan node, is this budget's growth law.
   *   2. The index that serves the body (`invoices_customer_idx` on
   *      `(business_id, customer_id, issue_date, id)`, `0075:332`) is asserted
   *      to EXIST, because that is a schema fact; whether the planner reaches
   *      for it inside the function at 2 000 rows is not a claim P4-AL-72
   *      permits ("never the planner must choose algorithm X forever").
   *
   * RED-CAPABLE IN THE USEFUL DIRECTION: the day a PostgreSQL release inlines
   * this body, or the day the body loses its aggregate, the `Function Scan`
   * disappears, this case fails, and whoever holds the slice is told by name
   * that an index-reach gate on `invoices` has become assertable.
   */
  it('FINDING: the reader of record is not inlinable, so the growth law is the ratio and not a plan node', async () => {
    requireFixture();
    const median = must(dataset.medianCustomerIds[0], 'the first median customer');
    const medianPlans = await plansOf(READS.receivable(median));
    const fatPlans = await plansOf(READS.receivable(dataset.fatCustomerId));
    console.log(`\nPLANS — P4-D median\n${JSON.stringify(medianPlans, null, 1)}\nPLANS — P4-D fat-tail\n${JSON.stringify(fatPlans, null, 1)}\n`);

    for (const [arm, plans] of [
      ['median', medianPlans],
      ['fat-tail', fatPlans],
    ] as const) {
      const outstanding = must(
        plans.find((p) => p.text.includes('customer_ar_outstanding(')),
        `${arm}: the statement that calls the reader of record`,
      );
      expect(
        outstanding.nodes.some((n) => n['Node Type'] === 'Function Scan'),
        `${arm}: the reader of record no longer appears as a Function Scan — it has become inlinable, and an index-reach gate on \`invoices\` is now assertable:\n${outstanding.json}`,
      ).toBe(true);
      expect(
        outstanding.nodes.filter((n) => n['Relation Name'] === 'invoices'),
        `${arm}: \`invoices\` appeared in the OUTER plan, which it cannot while the reader of record is a black box to the planner. Widen this case rather than delete it.`,
      ).toEqual([]);
    }

    // The schema fact the body's access path rests on, asserted where it IS a
    // fact: the index exists, on those columns, in that order.
    const idx = await ownerPool().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'invoices' AND indexname = 'invoices_customer_idx'`,
    );
    expect(
      idx.rows[0]?.indexdef ?? 'MISSING',
      'the index that serves the reader of record’s own predicate (business_id, customer_id, …) is gone — the body has no access path left',
    ).toMatch(/\(business_id, customer_id/);

    // And the reader calls the finding is about, counted rather than asserted
    // — and the COUNT IS DISCOVERED, from the live body of the AR reader,
    // because it is a property of that body and not a number this file may
    // keep a copy of. A body that reaches the reader of record through a
    // per-invoice `LATERAL` makes one call per open invoice; a body that
    // passes the ids as a SET makes one call for all of them (`0083`). Before
    // `0083` this printed the open-invoice count as the call count, which was
    // true then and became a FALSE CLAIM the moment the reader was reshaped.
    const perRow = await ownerPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM invoices WHERE business_id = $1 AND customer_id = $2 AND status = 'open'`,
      [w.shop.businessId, dataset.fatCustomerId],
    );
    const readerBody = await ownerPool().query<{ def: string }>(
      `SELECT coalesce(pg_get_functiondef(to_regprocedure('public.customer_ar_outstanding(UUID, UUID)')), '') AS def`,
    );
    const openInvoices = Number.parseInt(perRow.rows[0]?.n ?? '0', 10);
    const perInvoiceCall = (readerBody.rows[0]?.def ?? '').includes('JOIN LATERAL public.invoice_outstanding(i.business_id, i.id)');
    console.log(
      `\nFINDING — P4-D reader calls per read: ${JSON.stringify({
        openInvoices,
        invoiceOutstandingCallsPerRead: perInvoiceCall ? openInvoices : 1,
        shape: perInvoiceCall ? 'per-invoice LATERAL (0075:783)' : 'set-based: one call over the open invoice ids (0083)',
        note: 'invoice_outstanding is plpgsql and STABLE, so it is never inlined; how often it is called is a property of the AR reader’s own body, read here from the catalogue. The ratio below is the growth law.',
      })}\n`,
    );
  });

  it(`MEASUREMENT: p95 of ${SHORT_PERCENTILE_ITERATIONS} warm runs of each fat-tail read is within P4-D (${BUDGET.D_BALANCE_P95} ms)`, () => {
    requireFixture();
    // EVERY read's verdict is reached, then the run fails on whichever missed:
    // see `everyArm`. The judgement itself is unchanged.
    everyArm(
      readsOf(dataset.fatCustomerId, w.day).map(({ path, tag }) => [
        tag,
        () => {
          const m = must(readSeries.get(path), `the measured series of ${path}`);
          // P4-AL-76: the gate fails when a measurement's sample count is below
          // the declared iterations. Asserted on the series itself, before its
          // percentile is read, so a short series can never be a quiet pass.
          expect(
            m.samplesMs.length,
            `${m.name}: ${m.samplesMs.length} samples were taken and ${SHORT_PERCENTILE_ITERATIONS} were declared — a percentile over fewer samples than claimed is not the claimed percentile (P4-AL-76)`,
          ).toBe(SHORT_PERCENTILE_ITERATIONS);
          // DR-98: the verdict is the IN-DATABASE p95; the wall clock is printed
          // beside it, in the message and on the log, and judges nothing.
          assertInDatabaseWithin(m, BUDGET.D_BALANCE_P95, 'P4-D', tag);
        },
      ]),
    );
  });

  /**
   * STAGE 1 OF THE OWNER'S OPTION A (owner decision 2026-11-11): MEASURE THE
   * IN-DATABASE QUOTIENT OF THIS RATIO'S TWO ARMS, PRINT IT EVERY RUN, AND
   * JUDGE NOTHING WITH IT.
   *
   * WHAT THIS CASE DOES NOT DO. It does not touch the verdict. The case below
   * is unchanged: the WALL-CLOCK quotient against
   * `RATIOS.BALANCE_FATTAIL_OVER_MEDIAN.max`, exactly as `main` judges it. No
   * constant is derived here, none is proposed here, and
   * `inDbRatio` is printed with `judgedOn=none` so no reader can mistake it
   * for a verdict. The owner sets the in-database constant AFTER the
   * distribution of at least ten runs is read, and not before.
   *
   * WHY THE DENOMINATOR HAD TO BE MEASURED AT ALL. DR-98 converted this
   * budget's CEILING to the in-database clock but not this RATIO, and measured
   * on `main` (`4c878e0f`) the string `'in-database'` has exactly ONE call site
   * in this file — the `P4-D` reads loop, i.e. the NUMERATOR. The median read
   * was taken wall-clock-only, so the in-database quotient had never been
   * measured in any run and no constant could be anchored from history. The
   * `'in-database'` argument on that call is the whole of the change this case
   * reads.
   *
   * WHY THE LENGTHS ARE ASSERTED AND THE RATIO IS NOT. A printed number nobody
   * can make move is not a measurement (RULE-27, DR-55), and a percentile over
   * fewer samples than declared is not the claimed percentile (P4-AL-76). So
   * the four series — both arms, both clocks — are asserted to carry
   * `SHORT_PERCENTILE_ITERATIONS` samples each: the printed quotient is either
   * about these two arms at their declared sample count, or this case is RED.
   * That is a guard on the printed figure, not a judgement of it.
   *
   * THE PRINTED MARKER IS PURE ASCII AND UNCONDITIONAL, and it is printed
   * BEFORE any assertion in this case, so a run whose lengths are wrong still
   * carries the numbers that explain why (RULE-29: a step silent on success
   * carries no evidence of itself). `ci.yml`'s controls grep for
   * `P4-S4-RATIO-MONITOR-FATTAIL` rather than for the prose.
   */
  it('MONITOR (DR-98 stage 1, P4-AL-72): the in-database quotient of P4-D’s two arms is measured and printed, and judges nothing', () => {
    requireFixture();
    const fat = must(readSeries.get(READS.receivable(dataset.fatCustomerId)), 'the fat-tail receivable series');
    const med = must(medianReceivable, 'the median receivable series');
    const fatInDb = must(fat.inDatabaseMs, 'the fat-tail arm’s in-database series');
    const medInDb = must(med.inDatabaseMs, 'the median arm’s in-database series — the denominator this stage exists to measure');
    const fatInDbP95 = quantile(fatInDb, 0.95);
    const medInDbP95 = quantile(medInDb, 0.95);
    const fatWallP95 = quantile(fat.samplesMs, 0.95);
    const medWallP95 = quantile(med.samplesMs, 0.95);
    console.log(
      `P4-S4-RATIO-MONITOR-FATTAIL depth=in-database judgedOn=none ` +
        `fatInDbP95=${fatInDbP95.toFixed(3)} medianInDbP95=${medInDbP95.toFixed(3)} ` +
        `inDbRatio=${medInDbP95 === 0 ? 'no-denominator' : (fatInDbP95 / medInDbP95).toFixed(3)} ` +
        `wallFatP95=${fatWallP95.toFixed(3)} wallMedianP95=${medWallP95.toFixed(3)} ` +
        `wallRatio=${medWallP95 === 0 ? 'no-denominator' : (fatWallP95 / medWallP95).toFixed(3)} ` +
        `judgedMax=${RATIOS.BALANCE_FATTAIL_OVER_MEDIAN.max} appliesTo=wallRatio ` +
        `fatWallSamples=${fat.samplesMs.length} fatInDbSamples=${fatInDb.length} ` +
        `medianWallSamples=${med.samplesMs.length} medianInDbSamples=${medInDb.length} ` +
        `fatOpenInvoices=${volume.fatOpenInvoices} medianOpenInvoices=${MEDIAN.invoicesEach}`,
    );
    for (const [label, length] of [
      ['fat-tail wall', fat.samplesMs.length],
      ['fat-tail in-database', fatInDb.length],
      ['median wall', med.samplesMs.length],
      ['median in-database', medInDb.length],
    ] as const)
      expect(
        length,
        `${label}: ${length} samples against ${SHORT_PERCENTILE_ITERATIONS} declared — the printed quotient would not be about these two arms at their declared sample count (P4-AL-76)`,
      ).toBe(SHORT_PERCENTILE_ITERATIONS);
  });

  it(`RATIO (host-independent, P4-AL-72): p95(fat-tail) <= ${RATIOS.BALANCE_FATTAIL_OVER_MEDIAN.max} x p95(median)`, () => {
    requireFixture();
    // The SAME series the ceiling case judged, and the median series taken in
    // the same run on the same host: a ratio computed from a second sample
    // would be a ratio between two populations.
    const fat = must(readSeries.get(READS.receivable(dataset.fatCustomerId)), 'the fat-tail receivable series');
    const med = must(medianReceivable, 'the median receivable series');
    const fatP95 = quantile(fat.samplesMs, 0.95);
    const medP95 = quantile(med.samplesMs, 0.95);
    const ratio = medP95 === 0 ? null : fatP95 / medP95;
    diagnose(fat, BUDGET.D_BALANCE_P95);
    diagnose(med, BUDGET.D_BALANCE_P95);
    console.log(
      `\nRATIO — P4-D fat-tail over median: ${JSON.stringify({
        fatP95,
        medianP95: medP95,
        ratio,
        max: RATIOS.BALANCE_FATTAIL_OVER_MEDIAN.max,
        fatOpenInvoices: volume.fatOpenInvoices,
        medianOpenInvoices: MEDIAN.invoicesEach,
      })}\n`,
    );
    expect(ratio, 'the median read measured zero, so the ratio has no denominator').not.toBeNull();
    expect(
      must(ratio),
      `P4-AL-72's host-independent ratio for this budget is p95(fat-tail) <= ${RATIOS.BALANCE_FATTAIL_OVER_MEDIAN.max} x p95(median). ` +
        `Measured ${fatP95.toFixed(3)} ms over ${medP95.toFixed(3)} ms = ${must(ratio).toFixed(2)}x at ${volume.fatOpenInvoices} invoices against ${MEDIAN.invoicesEach}. ` +
        `A miss here is a statement about the read's GROWTH, not about this host, and it is a FAIL to be diagnosed (P4-AL-76): ` +
        `the ratio may never be raised to obtain a pass (OD-P4-14, tighten-only).\n` +
        `fat-tail series: ${JSON.stringify(distribution(fat.samplesMs, BUDGET.D_BALANCE_P95).orderedMs)}\n` +
        `median series:   ${JSON.stringify(distribution(med.samplesMs, BUDGET.D_BALANCE_P95).orderedMs)}`,
    ).toBeLessThanOrEqual(RATIOS.BALANCE_FATTAIL_OVER_MEDIAN.max);
  });

  it(`RLS COST (P4-AL-75, OD-P4-14 provisional): the daftar_app figure over the schema-owner figure, <= ${RATIOS.RLS_COST.max}x`, () => {
    requireFixture();
    const path = READS.receivable(dataset.fatCustomerId);
    // LIKE AGAINST LIKE (see `statementCostMs`): the same captured statements
    // on the same rows, as `daftar_app` through the product's own query
    // function with row security applied, and as the schema owner with it
    // bypassed. The HTTP series — which IS the budget — is reported beside
    // them so the envelope is visible and is never inside the ratio.
    const app = must(appStatementReceivable, 'the daftar_app statement series');
    const owner = must(ownerReceivable, 'the owner-side series of the same statements');
    const http = must(readSeries.get(path), 'the fat-tail receivable HTTP series — the budget');
    const appP95 = quantile(app.samplesMs, 0.95);
    const ownerP95 = quantile(owner.samplesMs, 0.95);
    const httpP95 = quantile(http.samplesMs, 0.95);
    const ratio = ownerP95 === 0 ? null : appP95 / ownerP95;
    diagnose(app, BUDGET.D_BALANCE_P95);
    diagnose(owner, BUDGET.D_BALANCE_P95);
    console.log(
      `\nRLS COST — P4-D: ${JSON.stringify({
        appStatementsP95Ms: appP95,
        ownerStatementsP95Ms: ownerP95,
        rlsCostRatio: ratio,
        httpP95Ms: httpP95,
        httpEnvelopeMs: httpP95 - appP95,
        max: RATIOS.RLS_COST.max,
        provisional: RATIOS.RLS_COST.provisional,
        anchorOwed: RATIOS.RLS_COST.anchorOwed,
        appSeries: distribution(app.samplesMs, BUDGET.D_BALANCE_P95).orderedMs,
        ownerSeries: distribution(owner.samplesMs, BUDGET.D_BALANCE_P95).orderedMs,
        note: 'the HTTP figure is the BUDGET; the ratio is statements-to-statements, so it is the policy cost and not the envelope',
      })}\n`,
    );
    expect(ratio, 'the owner figure measured zero, so the RLS cost has no denominator').not.toBeNull();
    expect(
      must(ratio),
      `[[daftar-rls-policy-shape-is-a-cost]] — the row-security cost of this read measured ${must(ratio).toFixed(2)}x ` +
        `(${appP95.toFixed(3)} ms for the same statements as daftar_app, row security applied, against ${ownerP95.toFixed(3)} ms as the schema owner, ` +
        `row security bypassed; the HTTP budget figure is ${httpP95.toFixed(3)} ms and is NOT part of this ratio). P4-AL-75 makes a ratio above ` +
        `${RATIOS.RLS_COST.max}x FAIL-UNTIL-DIAGNOSED; the ${RATIOS.RLS_COST.max}x is PROVISIONAL (${RATIOS.RLS_COST.anchorOwed}) and is tighten-only. ` +
        `A policy changed for speed requires the answer-equivalence proof in the accounting-rls-equivalence.test.ts form. ` +
        `The owner figure is NEVER the budget.`,
    ).toBeLessThanOrEqual(RATIOS.RLS_COST.max);
  });
});

// ───── P4-F ──────────────────────────────────────────────────────────────

describe('P4-F — the customer payment allocation', () => {
  const armOf = (key: string): AllocationSeries => must(series.get(key), `the ${key} allocation series`);

  it('GATE: one allocation command opens exactly ONE transaction, whatever the invoice count (P4-AL-72)', () => {
    requireFixture();
    for (const key of ['base-1', 'base-5', 'foreign-5']) {
      const s = armOf(key);
      const counts = [...new Set(s.transactionsPerCommand)];
      expect(
        counts,
        `${key}: the allocation command opened ${counts.join(', ')} transaction(s) per call over ${s.transactionsPerCommand.length} calls. ` +
          `CustomerPaymentService.run step 6 is "One transaction: the routine, the entries, COMMIT" — two would make the command non-atomic.`,
      ).toEqual([1]);
    }
  });

  it('GATE: one journal entry per allocation and no per-line entry (P4-AL-72)', async () => {
    requireFixture();
    for (const key of ['base-1', 'base-5', 'foreign-5']) {
      const s = armOf(key);
      const sampled = [must(s.paymentIds[0]), must(s.paymentIds.at(-1))];
      for (const paymentId of sampled) {
        const posted = await postedEntries(paymentId);
        expect(posted.allocations, `${key}: the committed payment wrote ${posted.allocations} allocation rows for a ${s.shape}-invoice request`).toBe(s.shape);
        expect(
          posted.entries,
          `${key}: a whole allocation posts ONE journal entry (${s.shape} allocations, ${posted.entries} entries, ${posted.lines} lines). ` +
            `An entry per journal LINE would make the ledger's entry count a function of the chart rather than of the document.`,
        ).toBe(s.shape);
        expect(posted.lines, `${key}: an entry with no lines is not a posting`).toBeGreaterThanOrEqual(posted.entries * 2);
      }
    }
  });

  it(`MEASUREMENT: p95 of the 5-invoice allocation is within P4-F in-transaction (${BUDGET.F_ALLOCATION_TXN_P95} ms)`, () => {
    requireFixture();
    everyArm(
      ['base-5', 'foreign-5'].map((key) => {
        const s = armOf(key);
        // `tg` AND NOT `tag`, which is the `dv`/`dw`/`dr` convention this file
        // already follows and for the same measured reason:
        // `discover-plan-claims.ts` never SEEDS a name under three characters, and
        // a 3-character `const tag =` here is the file's first such declaration,
        // so its initialiser window seeded the taint set and put TWO new plan-gate
        // claims in the inventory -- 430 hits -> 432, planGates 120 -> 122, zero
        // hits removed, measured by regenerating against the committed file. A
        // false claim in an evidence inventory is the exact defect that inventory
        // exists to prevent.
        const tg = `FTXN-${s.currency.toUpperCase()}-${s.shape}`;
        return [
          tg,
          () => {
            // DR-98: the verdict is the IN-DATABASE execution time of the
            // transaction window; the wall clock and the residual are printed
            // beside it and judge nothing. The instrument's own wall cost —
            // which sits inside the HTTP window and nowhere else — is printed
            // too, because it is the one figure this conversion ADDS to a
            // budget it does not convert. It is printed BEFORE the verdict so
            // a missed budget cannot take it off the log.
            console.log(
              `P4-S4-INSTRUMENT-COST-${tg} ` +
                `p50=${quantile(s.instrumentMs, 0.5).toFixed(3)} p95=${quantile(s.instrumentMs, 0.95).toFixed(3)} ` +
                `— the two pg_stat_statements reads sit INSIDE the HTTP window, so they can only make the P4-F-HTTP figure larger, never smaller`,
            );
            assertInDatabaseWithin(
              {
                name: `P4-F in-transaction, ${s.shape} invoices, ${s.currency} currency`,
                budgetMs: BUDGET.F_ALLOCATION_TXN_P95,
                samplesMs: s.txnMs,
                inDatabaseMs: s.reqInDatabaseMs,
              },
              BUDGET.F_ALLOCATION_TXN_P95,
              'P4-F (in-transaction)',
              tg,
            );
          },
        ];
      }),
    );
  });

  /**
   * DELIBERATELY NOT CONVERTED (DR-98, and stated here so the decision is in
   * the code and not only in a card).
   *
   * This budget's subject IS the endpoint over HTTP: the guard, the membership
   * resolution, the serialisation, the connection the pool hands out. An
   * in-database clock measures the SQL, so converting this one would judge the
   * SQL and drop the endpoint out of a budget whose own name says the endpoint
   * is what it measures — the opposite of the narrowing DR-98 accepted for the
   * transaction. So the verdict here stays the WALL CLOCK, and the tail that
   * DR-98 moved out of the way for `P4-D` and `P4-F-TXN` is still in front of
   * this one. Both of its figures are printed; neither is quietly swapped.
   */
  it(`MEASUREMENT: p95 of the 5-invoice allocation is within P4-F over HTTP (${BUDGET.F_ALLOCATION_HTTP_P95} ms)`, () => {
    requireFixture();
    everyArm(
      ['base-5', 'foreign-5'].map((key) => {
        const s = armOf(key);
        // `tg`, not `tag`: see the FTXN arm above.
        const tg = `FHTTP-${s.currency.toUpperCase()}-${s.shape}`;
        return [
          tg,
          () => {
            assertWithin(
              { name: `P4-F over HTTP, ${s.shape} invoices, ${s.currency} currency`, budgetMs: BUDGET.F_ALLOCATION_HTTP_P95, samplesMs: s.httpMs },
              BUDGET.F_ALLOCATION_HTTP_P95,
              'P4-F (HTTP)',
              tg,
            );
          },
        ];
      }),
    );
  });

  it('REPORT: the 1-invoice median, the 5-invoice median and the 1→5 scaling ratio, at both depths', () => {
    requireFixture();
    const one = armOf('base-1');
    const five = armOf('base-5');
    const report = {
      inTransaction: {
        oneInvoiceMedianMs: quantile(one.txnMs, 0.5),
        fiveInvoiceMedianMs: quantile(five.txnMs, 0.5),
        medianScaling1to5: quantile(one.txnMs, 0.5) === 0 ? null : quantile(five.txnMs, 0.5) / quantile(one.txnMs, 0.5),
        oneInvoiceP95Ms: quantile(one.txnMs, 0.95),
        fiveInvoiceP95Ms: quantile(five.txnMs, 0.95),
      },
      overHttp: {
        oneInvoiceMedianMs: quantile(one.httpMs, 0.5),
        fiveInvoiceMedianMs: quantile(five.httpMs, 0.5),
        medianScaling1to5: quantile(one.httpMs, 0.5) === 0 ? null : quantile(five.httpMs, 0.5) / quantile(one.httpMs, 0.5),
        oneInvoiceP95Ms: quantile(one.httpMs, 0.95),
        fiveInvoiceP95Ms: quantile(five.httpMs, 0.95),
      },
      // DR-98, owner decision 2026-11-07: the series the RATIO case below now
      // judges, printed here beside the wall-clock ones it used to judge, so
      // the two quotients are readable side by side in every run. This case
      // asserts the sample counts and nothing about either ratio.
      inDatabase: {
        oneInvoiceMedianMs: quantile(one.reqInDatabaseMs, 0.5),
        fiveInvoiceMedianMs: quantile(five.reqInDatabaseMs, 0.5),
        medianScaling1to5: quantile(one.reqInDatabaseMs, 0.5) === 0 ? null : quantile(five.reqInDatabaseMs, 0.5) / quantile(one.reqInDatabaseMs, 0.5),
        oneInvoiceP95Ms: quantile(one.reqInDatabaseMs, 0.95),
        fiveInvoiceP95Ms: quantile(five.reqInDatabaseMs, 0.95),
      },
      iterations: { one: one.txnMs.length, five: five.txnMs.length },
    };
    console.log(`\nP4-F SCALING — ${JSON.stringify(report, null, 1)}\n`);
    // The ONE-invoice arm is also measured against the ceilings, which is
    // strictly more than P4-AL-71 asks for: its ceilings are stated for the
    // five-invoice shape, and a one-invoice command that exceeded them would
    // be a finding nobody had a case for.
    diagnose({ name: 'P4-F in-transaction, 1 invoice', budgetMs: BUDGET.F_ALLOCATION_TXN_P95, samplesMs: one.txnMs }, BUDGET.F_ALLOCATION_TXN_P95);
    diagnose({ name: 'P4-F over HTTP, 1 invoice', budgetMs: BUDGET.F_ALLOCATION_HTTP_P95, samplesMs: one.httpMs }, BUDGET.F_ALLOCATION_HTTP_P95);
    expect(
      report.iterations,
      'both arms must carry the full declared sample count, or a percentile was taken over fewer samples than claimed (P4-AL-76)',
    ).toEqual({
      one: SHORT_PERCENTILE_ITERATIONS,
      five: SHORT_PERCENTILE_ITERATIONS,
    });
  });

  /**
   * DR-98 EXTENDED TO `P4-AL-72`'s ALLOCATION SCALING RATIO — OWNER DECISION,
   * 2026-11-07. BOTH HALVES ARE MEASURED INSIDE POSTGRESQL, THE SAME WAY.
   *
   * The numerator and the denominator are both `reqInDatabaseMs`: the same
   * `pg_stat_statements` delta instrument, read around the same REQUESTS and
   * from OUTSIDE their measured windows (the owner's remedy of 2026-11-08, and
   * the reason that field is no longer called `txnInDatabaseMs`), in the same
   * order, on the same run. So the quotient is no longer a
   * quotient of two quantities that were defined differently, and the owner's
   * first condition — «the numerator and the denominator are both measured
   * inside PostgreSQL in the same way, so the ratio is not compared between two
   * different units» — is what the code does rather than what it claims.
   *
   * WHAT IS UNTOUCHED. The constant is still `RATIOS.ALLOCATION_5_OVER_1.max`,
   * still imported from `scripts/phase4-budget-ratchet.ts`, still 3, and still
   * CALIBRATION-DERIVED and TIGHTEN-ONLY under OD-P4-14 — the ratchet guard
   * `tests/guards/p4s4-budget-ratchet-law.test.ts` is what refuses it upward
   * and this arm does not touch it. The sample count is still
   * `SHORT_PERCENTILE_ITERATIONS` on both arms, the estimator is still
   * `quantile` from `./percentile`, and `P4-AL-76`'s completeness assertion on
   * both arms is the REPORT case above, untouched. Nothing here is a `retry`, a
   * `skip`, a `continue-on-error`, a timeout, a dropped outlier or a widened
   * constant.
   *
   * WHY, MEASURED. On `4cac6738` (run 42348282323, job 128330740569, step 41)
   * this was the suite's ONLY failure out of eighteen cases: in-transaction
   * p95(5) 51.438 ms over p95(1) 10.574 ms = 4.86x against 3. In the SAME run
   * the five-invoice arm's median was 23.352 ms — a median quotient near 2.3 —
   * its in-database p95 was 19.841 ms, and its wall max was 140.020 ms. A
   * verdict that reads 2.3 at the median and 4.86 at p95 because the
   * ninety-fifth wall-clock sample of one arm was scheduled late is a verdict
   * about the runner's scheduling, not about how the allocation scales.
   *
   * ── WHAT THIS CONVERSION GIVES UP, BECAUSE IT IS NOT A FREE WIN ─────────
   *
   * THE WALL-CLOCK RATIO STOPS BEING A VERDICT AT BOTH DEPTHS, and the
   * `over HTTP` depth stops being asserted at all. Two regressions leave this
   * gate's reach with it: Node-side allocation arithmetic that scaled worse
   * than the constant with the invoice count, and an HTTP envelope that did.
   * Neither is left unguarded — `P4-F-TXN` still holds a ceiling over the
   * transaction and `P4-F over HTTP` still holds a WALL-CLOCK ceiling of
   * `BUDGET.F_ALLOCATION_HTTP_P95` ms over the whole endpoint, both on every
   * run — but their GROWTH with the invoice count is no longer asserted
   * anywhere. That is the cost, it is deliberate, and it is kept VISIBLE and
   * not described: both wall-clock quotients are computed and printed on an
   * UNCONDITIONAL monitor line below, in every run, whether the verdict holds
   * or misses, and the printed line says `judgedOn=none` so no reader can take
   * it for a gate.
   *
   * THE DIRECTION OF THE SUBSTITUTION, STATED. The in-database figure is
   * always LESS THAN OR EQUAL TO the wall figure of the same window, because
   * the wall window contains it. It is removed from BOTH halves, so the
   * quotient can move either way: it falls when the numerator carried more
   * non-database time than the denominator did, and it RISES when the shared
   * per-request overhead that used to dilute both halves is taken out. This
   * conversion is therefore NOT a loosening dressed as a measurement, and it
   * is not assumed to be a pass either — which is why the denominator's
   * in-database series is printed by the REPORT case above whether this
   * verdict holds or not.
   */
  it(`RATIO (host-independent, P4-AL-72, OD-P4-14): in-database p95(5 invoices) <= ${RATIOS.ALLOCATION_5_OVER_1.max} x in-database p95(1 invoice)`, () => {
    requireFixture();
    const one = armOf('base-1');
    const five = armOf('base-5');

    // MONITORING, UNCONDITIONAL AND FIRST, so a missed verdict cannot take it
    // off the log: the two wall-clock quotients this arm used to judge.
    for (const [depth, oneMs, fiveMs] of [
      ['in-transaction', one.txnMs, five.txnMs],
      ['over HTTP', one.httpMs, five.httpMs],
    ] as const) {
      const o = quantile(oneMs, 0.95);
      const f = quantile(fiveMs, 0.95);
      console.log(
        `P4-S4-RATIO-MONITOR-AL72 depth=${depth} judgedOn=none oneP95=${o.toFixed(3)} fiveP95=${f.toFixed(3)} ` +
          `ratio=${o === 0 ? 'no-denominator' : (f / o).toFixed(3)} max=${RATIOS.ALLOCATION_5_OVER_1.max}`,
      );
    }

    // THE VERDICT. `d1` and `d5` are two characters on purpose, the `dv`/`dw`/
    // `dr`/`tg` convention this file already follows for the measured reason
    // recorded at `assertInDatabaseWithin`: `discover-plan-claims.ts` taints
    // identifiers of three characters or more per FILE, and a longer name here
    // would seed plan-gate claims nothing in this file asserts.
    const d1 = one.reqInDatabaseMs;
    const d5 = five.reqInDatabaseMs;
    expect(
      [d1.length, d5.length],
      `the in-database series of the two arms are ${d1.length} and ${d5.length} samples against ${one.txnMs.length} and ${five.txnMs.length} ` +
        `wall-clock ones — both halves of this quotient are taken in the same windows as their wall figures and must be the same length (P4-AL-76)`,
    ).toEqual([one.txnMs.length, five.txnMs.length]);
    const oneP95 = quantile(d1, 0.95);
    const fiveP95 = quantile(d5, 0.95);
    const ratio = oneP95 === 0 ? null : fiveP95 / oneP95;
    expect(
      ratio,
      `the 1-invoice arm's IN-DATABASE p95 is zero, so this quotient has no denominator. A zero there is not a fast database: it is an instrument ` +
        `that accounted nothing to ${SHORT_PERCENTILE_ITERATIONS} transactions, and InDatabaseClock.calibrate is what refuses that case at fixture time (DR-98).`,
    ).not.toBeNull();
    console.log(
      `P4-S4-RATIO-MONITOR-AL72 depth=in-database judgedOn=inDatabaseExecMs oneP95=${oneP95.toFixed(3)} fiveP95=${fiveP95.toFixed(3)} ` +
        `ratio=${must(ratio).toFixed(3)} max=${RATIOS.ALLOCATION_5_OVER_1.max}`,
    );
    expect(
      must(ratio),
      `P4-S4-RATIO-FAIL-AL72 judgedOn=inDatabaseExecMs ` +
        `P4-AL-72's allocation scaling constant is p95(5) <= ${RATIOS.ALLOCATION_5_OVER_1.max} x p95(1), and OD-P4-14 (TL 2026-09-30 OPTION A) makes it ` +
        `CALIBRATION-DERIVED and TIGHTEN-ONLY — a measured poor result may never be fixed by raising it. ` +
        `Measured IN-DATABASE, both halves from the same pg_stat_statements instrument: ` +
        `${fiveP95.toFixed(3)} ms over ${oneP95.toFixed(3)} ms = ${must(ratio).toFixed(2)}x. ` +
        `The constant is PROVISIONAL (${RATIOS.ALLOCATION_5_OVER_1.anchorOwed}).\n` +
        `MONITORING ONLY, judging nothing: the wall-clock quotients of the same two arms are ` +
        `in-transaction ${quantile(five.txnMs, 0.95).toFixed(3)} / ${quantile(one.txnMs, 0.95).toFixed(3)} ms and ` +
        `over HTTP ${quantile(five.httpMs, 0.95).toFixed(3)} / ${quantile(one.httpMs, 0.95).toFixed(3)} ms.\n` +
        `1-invoice IN-DATABASE series: ${JSON.stringify(distribution(d1, BUDGET.F_ALLOCATION_TXN_P95).orderedMs)}\n` +
        `5-invoice IN-DATABASE series: ${JSON.stringify(distribution(d5, BUDGET.F_ALLOCATION_TXN_P95).orderedMs)}\n` +
        `1-invoice wall series: ${JSON.stringify(distribution(one.txnMs, BUDGET.F_ALLOCATION_HTTP_P95).orderedMs)}\n` +
        `5-invoice wall series: ${JSON.stringify(distribution(five.txnMs, BUDGET.F_ALLOCATION_HTTP_P95).orderedMs)}`,
    ).toBeLessThanOrEqual(RATIOS.ALLOCATION_5_OVER_1.max);
    // Printed only AFTER the assertion held, so a run that executed nothing
    // cannot satisfy the control that greps for it.
    console.log(`P4-S4-RATIO-OK-AL72`);
  });
});

// ───── the environment the figures were taken in ─────────────────────────

describe('the measurement environment, recorded rather than described (TL-P4-S3-R4, P4-AL-76)', () => {
  it('records the server version, both collation spellings, the dataset tier and the ANALYZE state', () => {
    requireFixture();
    const record = performanceRecord();
    console.log(`\nP4-S4 PERFORMANCE RECORD — ${JSON.stringify(record, null, 1)}\n`);
    expect(environment.serverVersionNum, 'the server did not report a version, so nothing below is attributable to one').toBeGreaterThan(0);
    expect(environment.datcollate.length, 'the server did not report a collation').toBeGreaterThan(0);
    expect(diagnostics.length, 'no distribution was recorded, so this suite measured nothing').toBeGreaterThan(0);
  });

  /**
   * THE PLAN CLAIMS ARE LABELLED, NEVER SKIPPED.
   *
   * `TL-P4-S3-R4`: «Local PG18/`C` runs stay valid for correctness, SQL
   * validity, security, RLS answer equivalence, functional invariants and
   * concurrency, but may **not** be labelled authoritative deployment plan
   * evidence without proven parity.» So this case does not demand the target —
   * it would then be a case nobody could run locally, and the ban on skipping
   * leaves no third option — it demands that the run SAY which it is. Required
   * CI runs against `postgres:16` at `en_US.utf8` and is the authoritative
   * side; `tests/performance/plan-evidence-contract.test.ts` is what asserts
   * that wiring structurally.
   */
  /**
   * THE SAMPLE CENSUS (layer 2 of `THE RUN ACCOUNTS FOR ITSELF`).
   *
   * `P4-AL-76` fails a gate whose measurement carries fewer samples than it
   * declared, and the individual MEASUREMENT cases already assert that on the
   * series they read. What they cannot assert is a series that is not there at
   * all: an absent series is an absent `it` body, and a run in which nothing
   * happened satisfies every assertion nobody made.
   *
   * So this case counts the series as well as their lengths, against the
   * DECLARED constants — three fat-tail read series, a median series, both
   * halves of the RLS instrument, one allocation arm per `ALLOCATION_ARMS`
   * entry, each at `SHORT_PERCENTILE_ITERATIONS` — and it names what is
   * missing. Nothing having run cannot pass it, and a short series cannot
   * either.
   */
  it('CENSUS: every declared series exists and carries its full declared sample count (P4-AL-76)', () => {
    requireFixture();
    const lengths: Record<string, number> = {};
    for (const { path } of readsOf(dataset.fatCustomerId, w.day)) {
      const s = must(readSeries.get(path), `the series of ${path}`);
      lengths[`P4-D HTTP ${path}`] = s.samplesMs.length;
      // DR-98: the JUDGED series is counted here too. A short in-database
      // series would otherwise be a quiet pass on the one number that decides
      // the budget, which is exactly what P4-AL-76 forbids for the wall clock.
      lengths[`P4-D IN-DATABASE (the verdict) ${path}`] = must(s.inDatabaseMs, `the in-database series of ${path}`).length;
    }
    expect(readSeries.size, `${DECLARED_READ_SERIES} fat-tail read series are declared and ${readSeries.size} were measured`).toBe(DECLARED_READ_SERIES);
    lengths['P4-D median (the ratio denominator)'] = must(medianReceivable, 'the median series').samplesMs.length;
    lengths['P4-D daftar_app statements (RLS numerator)'] = must(appStatementReceivable, 'the daftar_app statement series').samplesMs.length;
    lengths['P4-D owner statements (RLS denominator)'] = must(ownerReceivable, 'the owner statement series').samplesMs.length;
    expect(series.size, `${DECLARED_ALLOCATION_ARMS} allocation arms are declared and ${series.size} were measured`).toBe(DECLARED_ALLOCATION_ARMS);
    for (const { shape, currency } of ALLOCATION_ARMS) {
      const arm = must(series.get(`${currency}-${shape}`), `the ${currency}-${shape} allocation arm`);
      lengths[`P4-F ${currency}-${shape} in-transaction`] = arm.txnMs.length;
      lengths[`P4-F ${currency}-${shape} over HTTP`] = arm.httpMs.length;
      lengths[`P4-F ${currency}-${shape} IN-DATABASE (the verdict)`] = arm.reqInDatabaseMs.length;
    }
    // The diagnostic series is thirty iterations by declaration, not 200, and
    // it is a diagnostic rather than a verdict — so it is counted and named
    // here rather than held to the budget's sample count.
    const diagnosticSamples = beforeAnalyze === null ? 0 : beforeAnalyze.samplesMs.length;
    console.log(
      `\nSAMPLE CENSUS — ${JSON.stringify({ declared: SHORT_PERCENTILE_ITERATIONS, warmupDiscarded: WARMUP, lengths, beforeAnalyzeDiagnosticSamples: diagnosticSamples, reauthentications: authReport().reauthentications }, null, 1)}\n`,
    );
    const short = Object.entries(lengths).filter(([, n]) => n !== SHORT_PERCENTILE_ITERATIONS);
    expect(
      short.map(([name, n]) => `${name}: ${n}`),
      `every measured series must carry exactly ${SHORT_PERCENTILE_ITERATIONS} samples — a percentile over fewer samples than claimed is not the claimed percentile (P4-AL-76)`,
    ).toEqual([]);
    // DR-98 raised this total: each fat-tail read now carries a wall-clock AND
    // an in-database series, and each allocation arm carries three. The literal
    // is derived from the declared constants, never from what happened to run.
    expect(Object.keys(lengths).length, 'no series was counted at all, so this census was satisfied by nothing having run').toBe(
      DECLARED_READ_SERIES * 2 + 3 + DECLARED_ALLOCATION_ARMS * 3,
    );
    expect(diagnosticSamples, 'the before-ANALYZE diagnostic was never taken, so the ANALYZE state of these figures is undocumented (P4-AL-74)').toBe(30);
  });

  it('says plainly whether its plan claims are authoritative deployment evidence', () => {
    requireFixture();
    const verdict = classifyPlanEvidence(environment);
    console.log(`\n${planEvidenceBanner(environment)}\n`);
    expect(verdict.authoritative || verdict.reasons.length > 0, 'a non-authoritative run must say WHY, or the label means nothing').toBe(true);
  });
});
