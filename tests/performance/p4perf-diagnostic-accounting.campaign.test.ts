/**
 * TL-P4-PERF-A-02 — CAMPAIGN 2 (SECONDARY SUBJECT): ACCOUNTING BUDGET A.
 *
 * `tests/performance/accounting-budgets.test.ts:55` — `A_POST_P95: 15`.
 * `post()` of a 2-6 line entry inside an existing transaction, p95 over 200
 * measured samples, WITH COMMIT INSIDE THE TIMED REGION.
 *
 * This is the contract the owner's ruling actually freezes, so it is measured
 * here in its own labelled campaign even though the red assertion is the POS
 * ratio gate. The reason it matters now: the same contract was recorded at
 * 24.477 ms against its 15 ms ceiling on a CONTENDED box (loadAverage
 * [9.08, 6.54, 5.27] on four CPUs). A number taken under that load says
 * nothing about the product — which is exactly why this campaign runs on an
 * exclusive one.
 *
 * ── WHAT IS MIRRORED, AND WHY EACH MIRROR MATTERS ──────────────────────
 *
 * The timed region is reproduced statement for statement from
 * `accounting-budgets.test.ts:435-452`:
 *
 *     const command = simpleCommand({tenantId, businessId, userId}, randomUUID(), today, 12_345n);
 *     await c.query('BEGIN');
 *     await postAs(assertionFor(command, userId), command, {}, c);
 *     await c.query('COMMIT');
 *
 * Three details of that are load-bearing and are kept exactly:
 *
 *   COMMIT IS INSIDE. The deferred entry validators run at COMMIT, and with
 *   `synchronous_commit = on` (the embedded cluster's default) a COMMIT
 *   contains an fsync of the WAL. So this timed region is the one operation in
 *   either subject that can be stalled by storage directly — which makes
 *   classes C and H live hypotheses here in a way they are not for a read.
 *
 *   `randomUUID()` AND `simpleCommand()` ARE INSIDE. They are inside the
 *   accepted suite's `once`, so they are inside this one's. That is allocation
 *   and crypto in the timed region, which is a Class F exposure; it is
 *   MEASURED (`heapUsedDelta`, `gcTotalMs`) and NOT removed, because removing
 *   it would change the timing boundary the ruling freezes.
 *
 *   WARMUP = 5, THEN 200. `accounting-budgets.test.ts:93` and `:206`. The
 *   warm-up samples are discarded and never averaged in.
 *
 * ── THE ONE HYPOTHESIS THE ORDERING CAN TEST ───────────────────────────
 *
 * `postAs` reaches the database through `accounting_post_manual_adjustment`, a
 * PL/pgSQL routine. PL/pgSQL caches a plan per statement and switches from a
 * custom plan to a generic one after the FIFTH execution. The warm-up is
 * exactly five iterations, so measured sample 1 is roughly execution six —
 * the execution at which the plan can change. If that switch is costly or
 * produces a worse plan, it shows as a stall in the FIRST few samples of the
 * ordered series and nowhere else.
 *
 * That is a Class E/P hypothesis, it is falsifiable, and it is invisible to a
 * percentile — `tailShape.firstQuartileShare` is what answers it. Recording it
 * as a named hypothesis is not the same as asserting it is the cause.
 *
 * ── NO VERDICT ─────────────────────────────────────────────────────────
 *
 * This file asserts no budget. `A_POST_P95` is not imported. The 15 ms figure
 * appears only as the subject of the sensitivity analysis and is never
 * compared to produce a pass or a fail.
 *
 *   P4PERF_DIAG=1 PG_DIR=/tmp/daftar-pg-perfdiag PG_PORT=56581 \
 *     node /home/user/daftar/node_modules/vitest/vitest.mjs run \
 *     tests/performance/p4perf-diagnostic-accounting.campaign.test.ts
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { appClient, assertionFor, must, postAs, simpleCommand, todayIn } from '../helpers/accounting-posting';
import { generateDataset, TIER1_SPEC } from './accounting-dataset';
import {
  OUT_DIR,
  PASSES,
  backendPidOf,
  buildInstruments,
  captureEnvironment,
  hostBaseline,
  planningStatistics,
  reportSeries,
  runPass,
  writeReport,
  writeSeries,
  type SeriesResult,
} from './p4perf-diagnostic-campaign';
import { acctQuantileIndex, quantileBy, summariseArm, tailShape } from './p4perf-diagnostic-analysis';

/* ── MIRRORS. Copied from the accepted suite, NEVER altered. ────────── */

/** `accounting-budgets.test.ts:93` — SHORT_PERCENTILE_ITERATIONS. */
const MIRROR_ITERATIONS = 200;
/** `accounting-budgets.test.ts:94` — WARMUP. */
const MIRROR_WARMUP = 5;
/** The subject of the sensitivity analysis. NEVER asserted, never compared for a verdict. */
const SUBJECT_CEILING_MS = 15;

const RELATIONS = ['journal_entries', 'journal_lines', 'accounts', 'businesses', 'accounting_periods'] as const;

const ENABLED = process.env['P4PERF_DIAG'] === '1';

let t: TestApp;
let tenantId = '';
let businessId = '';
let userId = '';
let today = '';
let seededLines = 0;

const git = (args: readonly string[]): string => {
  try {
    return execFileSync('git', [...args], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};

beforeAll(
  async () => {
    if (!ENABLED) return;
    await ensurePostgres();
    await resetData();
    t = await createTestApp();

    const email = `p4perfdiag-${Date.now()}@test.daftar.local`;
    const reg = await t.request.post('/v1/auth/register').send({ email, password: 'Str0ng!Passw0rd', displayName: 'PerfDiag', preferredLocale: 'ar' });
    const token = reg.body.accessToken as string;
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
    userId = me.body.userId as string;
    const on = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `idem-${Date.now()}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ businessName: 'PerfDiag Books', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `perfdiag-${Date.now()}` });
    expect(on.status).toBe(201);
    businessId = on.body.businessId as string;
    tenantId = must((await ownerPool().query<{ tenant_id: string }>(`SELECT tenant_id FROM businesses WHERE id = $1`, [businessId])).rows[0]).tenant_id;
    today = await todayIn(ownerPool(), 'Asia/Hebron');

    // TIER 1's dataset, exactly as the accepted suite seeds it at the default
    // tier. The ruling freezes the dataset, so this is a mirror and not a
    // choice.
    const result = await generateDataset(ownerPool(), [{ tenantId, businessId, userId, baseCurrency: 'ILS' }], TIER1_SPEC);
    seededLines = result.lineCount;

    // A MEASUREMENT TAKEN ON TOP OF THE SEEDING MEASURES THE SEEDING. The
    // accepted suite forces the flush here, before the clock starts, for
    // exactly this reason; so does this campaign.
    await ownerPool().query('CHECKPOINT');
    // And statistics, because a budget measured against a table with no
    // statistics is a number about the missing statistics.
    await ownerPool().query('ANALYZE');
  },
  4 * 60 * 60 * 1000,
);

afterAll(async () => {
  if (!ENABLED) return;
  await t?.close();
  await resetData();
});

describe.skipIf(!ENABLED)('TL-P4-PERF-A-02 — accounting Budget A, diagnostic campaign (NO VERDICT)', () => {
  it('PRECONDITION: the dataset is seeded and every measured relation has been analyzed', async () => {
    const stats = await planningStatistics(ownerPool(), RELATIONS);
    console.info('[P4PERF-ACCT] seededLines', seededLines);
    console.info('[P4PERF-ACCT] planningStatistics', JSON.stringify(stats, null, 1));
    expect(seededLines).toBeGreaterThan(0);
    for (const row of stats as { relname: string; analyzed_columns: string }[]) {
      expect(Number(row.analyzed_columns), `${row.relname} has no pg_stats rows`).toBeGreaterThan(0);
    }
  });

  it(
    'CAMPAIGN: Budget A’s operation, every pass, 200 ordered samples preserved',
    async () => {
      const observer = ownerPool();
      const baselineBefore = hostBaseline('before-campaign', '/tmp');

      const series: SeriesResult[] = [];
      const envs: unknown[] = [];

      for (const spec of PASSES) {
        // A FRESH MEASURED CONNECTION PER PASS.
        //
        // The accepted suite opens one `appClient()` for the whole budget, so
        // each pass does the same. A fresh connection per pass also means each
        // pass starts with the SAME cold plan-cache state, which keeps the
        // PL/pgSQL generic-plan hypothesis testable in every pass rather than
        // only the first.
        const c: Client = await appClient();
        try {
          const measuredPid = await backendPidOf(c);
          const inst = await buildInstruments(observer, measuredPid, RELATIONS);
          if (envs.length === 0) {
            envs.push(
              await captureEnvironment({
                campaignId: 'acct-a',
                observer,
                measuredPid,
                relations: RELATIONS,
                gitSha: git(['rev-parse', 'HEAD']),
                gitBranch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
                treeClean: git(['status', '--porcelain', '--untracked-files=no']) === '',
                host: inst.host,
                counterStatement: inst.pg.statement,
                observerConsistency: inst.observerConsistency,
              }),
            );
            console.info('[P4PERF-ACCT] environment', JSON.stringify(envs[0], null, 1));
          }

          series.push(
            ...(await runPass({
              spec,
              order: 'forward',
              arms: [
                {
                  label: 'postCommit',
                  // ── THE TIMED REGION, MIRRORED EXACTLY ──────────────
                  once: async (): Promise<void> => {
                    const command = simpleCommand({ tenantId, businessId, userId } as never, randomUUID(), today, 12_345n);
                    await c.query('BEGIN');
                    await postAs(assertionFor(command, userId), command, {}, c);
                    await c.query('COMMIT');
                  },
                  iterations: MIRROR_ITERATIONS,
                  warmup: MIRROR_WARMUP,
                },
              ],
              node: inst.node,
              host: inst.host,
              pg: inst.pg,
              observer,
              measuredPid,
              // The measured connection IS a dedicated client here, so the
              // io-timed pass can set the in-region I/O clocks on it. This is
              // the one subject where fsync LATENCY is obtainable.
              measuredClient: c,
            })),
          );
          inst.node.stop();
          inst.host.close();
        } finally {
          await c.end().catch(() => undefined);
        }
      }

      const baselineAfter = hostBaseline('after-campaign', '/tmp');
      const reports = series.map((s) => reportSeries(s, acctQuantileIndex, writeSeries(OUT_DIR, 'acct-a', s)));

      // THE 15 MS FIGURE AS A SUBJECT, NOT AS A VERDICT.
      //
      // How the distribution sits relative to the ceiling, and in particular
      // whether a miss would be a TAIL (a few samples above a low median) or a
      // SHIFT (the whole distribution moved, minimum already near the
      // ceiling). Those are different diagnoses: the receivables P4-F failure
      // on the loaded box was a shift — 193 of 200 above the ceiling with a
      // minimum of 36 ms against a 40 ms ceiling — and a shift is never a tail
      // question.
      const shape = series.map((s) => {
        const d = s.records.map((r) => r.durationMs);
        const summary = summariseArm(`${s.pass}/${s.arm}`, d, acctQuantileIndex);
        return {
          pass: s.pass,
          subjectCeilingMs: SUBJECT_CEILING_MS,
          summary,
          samplesAboveCeiling: d.filter((v) => v > SUBJECT_CEILING_MS).length,
          of: d.length,
          minOverCeiling: summary.min / SUBJECT_CEILING_MS,
          p50OverCeiling: summary.p50 / SUBJECT_CEILING_MS,
          p95OverCeiling: summary.p95 / SUBJECT_CEILING_MS,
          diagnosis:
            'TAIL if the median is far below the ceiling and only the top few samples exceed it; SHIFT if the minimum is already near the ceiling. Reported, never asserted.',
          tailAtCeiling: tailShape(d, SUBJECT_CEILING_MS),
          tailAtOwnP95: tailShape(d, quantileBy(d, 0.95, acctQuantileIndex)),
        };
      });
      console.info('[P4PERF-ACCT] shape', JSON.stringify(shape, null, 1));

      const path = writeReport(OUT_DIR, 'acct-a', {
        subject: 'tests/performance/accounting-budgets.test.ts:55 — A_POST_P95 = 15 ms, p95 over 200 samples, COMMIT inside the timed region',
        role: 'SECONDARY subject of TL-P4-PERF-A-02. The primary is the POS P4-A ratio gate.',
        verdict: 'NONE. This campaign has no pass/fail verdict and must not be used as acceptance evidence regardless of its number.',
        priorObservationOnLoadedBox: {
          p95Ms: 24.477,
          ceilingMs: 15,
          loadAverage: [9.08, 6.54, 5.27],
          cpuCount: 4,
          note: 'Another agent’s figure, taken under measured contention. Inherited as a FACT ABOUT A LOADED BOX only, never as a conclusion about the product.',
        },
        environment: envs[0] ?? null,
        mirrors: { MIRROR_ITERATIONS, MIRROR_WARMUP, percentile: 'min(n-1, floor(0.95*n)) = index 190 of 0..199 at n=200', dataset: 'TIER1_SPEC', seededLines },
        namedHypothesis:
          'PL/pgSQL switches from a custom to a generic plan after the fifth execution of a statement; WARMUP is 5, so measured sample 1 is about execution six. A cold-plan effect would show as a FIRST-SAMPLES cluster in the ordering (see tailShape.firstQuartileShare) and nowhere else.',
        hostBaseline: { before: baselineBefore, after: baselineAfter },
        shape,
        series: reports,
      });
      console.info(`[P4PERF-ACCT] report written: ${path}`);

      expect(reports.length, 'every pass produced a series').toBe(PASSES.length);
    },
    4 * 60 * 60 * 1000,
  );
});
