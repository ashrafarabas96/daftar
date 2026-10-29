#!/usr/bin/env tsx
/**
 * THE PERMANENT REAL-BROWSER GATE (directive §8, TD-06).
 *
 *   npm run gate:browser [-- options]
 *
 * Starts the real stack from nothing (tests/browser/stack.ts: fresh embedded
 * PostgreSQL, migrations from 0000, the built merchant API, and the
 * production web build served by its production entry `node server.mts`,
 * which is what `npm start` runs), seeds every business through the API
 * (seed.ts), then drives the Phase 3 merchant routes and command flows
 * (flows.ts) in headless Chromium in ar, en and tr at 360×640, 768×1024 and
 * 1280×800, checking the functional visual invariants (invariants.ts) at
 * every screenshot and recording every console error, CSP violation, failed
 * request and page error. Exit code 0 only when every step of every run
 * completed with no issue.
 *
 * It does not build: run `npm run build -w @daftar/api` and
 * `npm run build -w @daftar/web` first (CI does, and so does the
 * `--build` flag).
 *
 * Options:
 *   --locales=ar,en,tr          which locales (default: all three)
 *   --viewports=phone,tablet,desktop
 *   --steps=login,header,...    run only these steps (login always runs)
 *   --plant=overflow,raw-key,console-error,missing-string|all
 *                               inject defects the gate must report (red proof);
 *                               with --plant the exit code is 0 only when EVERY
 *                               planted kind was reported in EVERY run
 *   --workers=N                 locales run in parallel (default 1 - see below)
 *   --out=DIR                   evidence directory (default release/browser)
 *   --build                     build the API and the web app first
 *
 * Ports: BROWSER_PG_PORT, BROWSER_API_PORT, BROWSER_WEB_PORT. The database
 * directory: BROWSER_PG_DIR (default /tmp/daftar-browser-pg-<pg port>).
 */
// FIRST: `embedded-postgres` (imported through ./stack) registers a shutdown
// hook that exits with a hardcoded 0 when the event loop drains, which would
// erase the failing exit code this gate records — the gate printed
// "BROWSER GATE FAIL" and exited 0 before this line. See tests/helpers/exit-code.ts.
import { protectFailingExitCode } from '../helpers/exit-code';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import {
  AUTH_WINDOW_MS,
  LOCALES,
  LOGIN_BUDGET,
  LOGIN_PER_ACCOUNT_BUDGET,
  REFRESH_BUDGET,
  ROUTE_BUDGET,
  ROUTE_WINDOW_MS,
  TOUCH_MIN_PX,
  VIEWPORTS,
  comboTag,
  pacingDisabled,
  portsFromEnv,
  type Locale,
  type Viewport,
} from './config';
import { runFlows } from './flows';
import { catalogFacts, type IssueKind } from './invariants';
import { RouteBudgets, RouteCoverage, SlidingBudget } from './pacer';
import { PLANTS, Run, type Plant, type StepRecord } from './run-context';
import { seedLocale, type LocaleSeed } from './seed';
import { ROOT, startStack } from './stack';

protectFailingExitCode();

interface Options {
  locales: Locale[];
  viewports: Viewport[];
  steps: string[] | null;
  plants: Plant[];
  workers: number;
  out: string;
  build: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const value = (name: string): string | undefined => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const listOf = <T extends string>(name: string, all: readonly T[]): T[] => {
    const raw = value(name);
    if (raw === undefined || raw === 'all') return [...all];
    const picked = raw.split(',').map((s) => s.trim());
    for (const p of picked) if (!(all as readonly string[]).includes(p)) throw new Error(`--${name}: unknown "${p}" (one of ${all.join(', ')})`);
    return all.filter((a) => picked.includes(a));
  };
  const viewportNames = VIEWPORTS.map((v) => v.name);
  const pickedViewports = listOf('viewports', viewportNames);
  const plantRaw = value('plant');
  // ONE locale at a time, by measurement.
  //
  // The gate paces itself to ROUTE_BUDGET requests per route per minute so it
  // never meets a limit a real merchant would not meet. Three locales at once
  // ask for far more than that on the busiest routes, so `SlidingBudget` holds
  // the overflow - and the gate then spends its own deadlines waiting for
  // itself. Measured on run 40864085275: the pacer held pages' requests for
  // 122,279ms across 43 of 135 steps, up to 20,822ms in a single step
  // (`en 768px receive`, 22,578ms long), and two steps failed on 20s locator
  // timeouts with 429s, CSP violations and app errors all at zero.
  //
  // Serially the same nine runs issue the same requests over roughly three
  // times the wall-clock, which puts every route comfortably under its budget
  // and leaves the waiting with nothing to do. Nothing is weakened: the same
  // three locales, the same three viewports, the same steps and the same
  // assertions, and the budgets are still shared across all nine runs. What
  // changes is only how many browsers are open at once.
  //
  // `--workers=3` is still available for anyone who wants the old shape; it is
  // not the default because it makes the gate measure itself.
  const workers = Number(value('workers') ?? '1');
  if (!Number.isInteger(workers) || workers < 1) throw new Error('--workers must be a positive integer');
  return {
    locales: listOf('locales', LOCALES),
    viewports: VIEWPORTS.filter((v) => pickedViewports.includes(v.name)),
    steps: value('steps')?.split(',') ?? null,
    plants: plantRaw === undefined ? [] : listOf('plant', PLANTS),
    workers,
    out: value('out') ?? join(ROOT, 'release', 'browser'),
    build: argv.includes('--build'),
  };
}

function loadCatalog(locale: Locale): Record<string, string> {
  const parsed: unknown = JSON.parse(readFileSync(join(ROOT, 'apps/web/src/messages', `${locale}.json`), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`${locale}.json is not an object`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
  return out;
}

/** Map over `items` with at most `n` in flight. */
async function pool<T, R>(items: readonly T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      const item = items[i];
      if (item !== undefined) results[i] = await fn(item);
    }
  });
  await Promise.all(lanes);
  return results;
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const ports = portsFromEnv();
  if (o.build) {
    execFileSync('npm', ['run', 'build', '-w', '@daftar/api'], { cwd: ROOT, stdio: 'inherit' });
    execFileSync('npm', ['run', 'build', '-w', '@daftar/web'], { cwd: ROOT, stdio: 'inherit' });
  }
  rmSync(o.out, { recursive: true, force: true });
  mkdirSync(o.out, { recursive: true });
  const shotsDir = join(o.out, 'screenshots');
  const pgDir = process.env['BROWSER_PG_DIR'] ?? `/tmp/daftar-browser-pg-${ports.pg}`;

  console.log(
    `browser gate: locales ${o.locales.join(',')} · viewports ${o.viewports.map((v) => `${v.width}x${v.height}`).join(',')} · touch target ${TOUCH_MIN_PX}px${o.plants.length ? ` · PLANTED ${o.plants.join(',')}` : ''}`,
  );
  const stack = await startStack(ports, pgDir, join(o.out, 'logs'));
  const records: StepRecord[] = [];
  const coverage = new RouteCoverage();
  let seedMs = 0;
  let exitCode = 1;
  try {
    console.log(`stack up: ${stack.migrations} migrations from zero, API ${stack.apiUrl}, web ${stack.webUrl} (${Math.round((Date.now() - started) / 1000)}s)`);
    const seedStart = Date.now();
    const runId = Date.now().toString(36);
    const seeds = new Map<Locale, LocaleSeed>();
    for (const locale of o.locales) seeds.set(locale, await seedLocale(stack.apiUrl, locale, o.viewports, runId));
    seedMs = Date.now() - seedStart;
    console.log(
      `seeded through the API: ${o.locales.length} owners, ${o.locales.length * (1 + o.viewports.length)} businesses (${Math.round(seedMs / 1000)}s)`,
    );

    const dicts = { ar: loadCatalog('ar'), en: loadCatalog('en'), tr: loadCatalog('tr') };
    const facts = catalogFacts(dicts);
    // The negative control removes the WAITING, never the interception: the
    // coverage counts below stay exact, so a control run still proves the
    // pacer sits in the path while proving the API refuses without it.
    const off = pacingDisabled();
    if (off) console.log('BROWSER_GATE_NO_PACING=1: pacing is OFF — this run is the negative control and is expected to meet the API limiter');
    const unpaced = Number.MAX_SAFE_INTEGER;
    const shared = {
      refresh: new SlidingBudget('refresh', off ? unpaced : REFRESH_BUDGET, AUTH_WINDOW_MS),
      login: new SlidingBudget('login', off ? unpaced : LOGIN_BUDGET, AUTH_WINDOW_MS),
      route: new RouteBudgets(off ? unpaced : ROUTE_BUDGET, ROUTE_WINDOW_MS),
      coverage,
    };
    const browser = await chromium.launch();
    try {
      await pool(o.locales, o.workers, async (locale) => {
        const seed = seeds.get(locale);
        if (seed === undefined) throw new Error(`no seed for ${locale}`);
        const budgets = { ...shared, loginPerAccount: new SlidingBudget(`login:${locale}`, off ? unpaced : LOGIN_PER_ACCOUNT_BUDGET, AUTH_WINDOW_MS) };
        for (const viewport of o.viewports) {
          const run = new Run({
            browser,
            webUrl: stack.webUrl,
            locale,
            viewport,
            seed,
            dicts,
            facts,
            budgets,
            outDir: shotsDir,
            plants: o.plants,
            only: o.steps,
          });
          const t0 = Date.now();
          await run.open();
          try {
            await runFlows(run);
          } finally {
            await run.close();
          }
          records.push(...run.steps);
          const issues = run.steps.reduce((n, s) => n + s.issues.length, 0);
          console.log(
            `  ${comboTag(locale, viewport)}: ${run.steps.length} steps, ${run.steps.reduce((n, s) => n + s.shots.length, 0)} screenshots, ${issues} issue(s) (${Math.round((Date.now() - t0) / 1000)}s)`,
          );
        }
      });
    } finally {
      await browser.close();
    }
    const table = coverage.table();
    console.log('proxied requests per route — seen = paced + answered locally:');
    for (const r of table.slice(0, 12))
      console.log(
        `  ${r.route}: seen ${r.seen}, paced ${r.paced}, local ${r.fulfilled}${r.cancelled === 0 ? '' : `, cancelled ${r.cancelled}`}${r.unpaced === 0 ? '' : `, UNPACED ${r.unpaced}`}`,
      );
    exitCode = verdict(o, records, coverage);
  } finally {
    await stack.stop();
    const wallMs = Date.now() - started;
    writeFileSync(
      join(o.out, 'results.json'),
      JSON.stringify(
        {
          locales: o.locales,
          viewports: o.viewports,
          plants: o.plants,
          touchTargetPx: TOUCH_MIN_PX,
          wallMs,
          seedMs,
          runs: o.locales.length * o.viewports.length,
          steps: records.length,
          screenshots: records.reduce((n, s) => n + s.shots.length, 0),
          issues: records.reduce((n, s) => n + s.issues.length, 0),
          routeCoverage: coverage.table(),
          records,
        },
        null,
        2,
      ),
    );
    console.log(`wall time ${Math.round(wallMs / 1000)}s; evidence in ${o.out}`);
  }
  process.exitCode = exitCode;
}

/** 0 when the run is clean; with planted defects, 0 only when every planted kind was reported in every run. */
function verdict(o: Options, records: readonly StepRecord[], coverage: RouteCoverage): number {
  const byRun = new Map<string, StepRecord[]>();
  for (const r of records) {
    const key = `${r.locale}-${r.width}`;
    byRun.set(key, [...(byRun.get(key) ?? []), r]);
  }
  // A route where the counts disagree names a request that reached the API
  // without a budget. It fails the gate on its own: a green run whose pacing
  // was only partly in the path is a run whose green cannot be trusted next
  // time the machine gets faster.
  const gaps = coverage.unpaced();
  if (gaps.length > 0) {
    for (const g of gaps) console.log(`FAIL unpaced: ${g.route} — ${g.unpaced} request(s) reached the API without passing the gate's budget`);
    // Named, not just counted. One unpaced request in a hundred is exactly
    // the case where "a hole in the flows" and "a request issued while the
    // context was being torn down" need telling apart, and the step it came
    // from is what tells them apart.
    const named = coverage.unaccounted();
    if (named.length > 0) {
      console.log('  each one, and where it came from:');
      for (const r of named) console.log(`    ${r.route} · ${r.locale} ${r.viewport}px · step ${r.step} · ${r.url}`);
    }
  }
  // What the gate's own throttling cost, printed whether it passes or fails.
  // Without it the bimodal step times that pacing produces read as an
  // unexplained slow run, and the next person to see a 20s step has to
  // re-derive the cause from scratch, as this gate's author did.
  const held = records.filter((r) => r.pacedWaitMs > 0).sort((a, b) => b.pacedWaitMs - a.pacedWaitMs);
  const heldTotal = records.reduce((sum, r) => sum + r.pacedWaitMs, 0);
  console.log(`pacer: held a page's requests for ${heldTotal}ms across ${held.length} of ${records.length} steps`);
  for (const r of held.slice(0, 5)) console.log(`    ${r.pacedWaitMs}ms of ${r.ms}ms · ${r.locale} ${r.width}px ${r.step}`);
  if (o.plants.length === 0) {
    const bad = records.filter((r) => r.issues.length > 0);
    for (const r of bad) {
      console.log(`FAIL ${r.locale} ${r.width}px ${r.step}:`);
      for (const i of r.issues) console.log(`    [${i.kind}] ${i.detail}`);
    }
    const expectedRuns = o.locales.length * o.viewports.length;
    if (byRun.size !== expectedRuns) {
      console.log(`FAIL only ${byRun.size} of ${expectedRuns} runs reported`);
      return 1;
    }
    const clean = bad.length === 0 && gaps.length === 0;
    console.log(
      clean
        ? `BROWSER GATE PASS: ${records.length} steps in ${byRun.size} runs, 0 issues, every proxied request paced`
        : `BROWSER GATE FAIL: ${bad.length} step(s) with issues, ${gaps.length} route(s) with unpaced requests`,
    );
    return clean ? 0 : 1;
  }
  // Red proof: each planted defect must be caught in each run, by the rule meant for it.
  const want: Readonly<Record<Plant, (locale: Locale) => IssueKind>> = {
    overflow: () => 'overflow',
    'raw-key': () => 'raw-key',
    'console-error': () => 'console-error',
    'missing-string': (locale) => (locale === 'en' ? 'replacement-char' : 'untranslated'),
  };
  let missed = 0;
  console.log('RED PROOF (planted defects), run × planted kind → caught:');
  for (const [run, steps] of byRun) {
    const locale = steps[0]?.locale ?? 'en';
    const seen = new Set(steps.flatMap((s) => s.issues.map((i) => i.kind)));
    const row = o.plants.map((p) => `${p}=${seen.has(want[p](locale)) ? 'CAUGHT' : 'MISSED'}`);
    missed += o.plants.filter((p) => !seen.has(want[p](locale))).length;
    console.log(`  ${run}: ${row.join(' ')}`);
  }
  console.log(missed === 0 ? 'every planted defect was reported in every run: the gate goes red on them' : `${missed} planted defect(s) went UNREPORTED`);
  return missed === 0 && gaps.length === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
