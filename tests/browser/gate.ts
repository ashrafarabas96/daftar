#!/usr/bin/env tsx
/**
 * THE PERMANENT REAL-BROWSER GATE (directive §8, TD-06).
 *
 *   npm run gate:browser [-- options]
 *
 * Starts the real stack from nothing (tests/browser/stack.ts: fresh embedded
 * PostgreSQL, migrations from 0000, the built merchant API, `next start` of
 * the production web build), seeds every business through the API
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
 *   --workers=N                 locales run in parallel (default 3)
 *   --out=DIR                   evidence directory (default release/browser)
 *   --build                     build the API and the web app first
 *
 * Ports: BROWSER_PG_PORT, BROWSER_API_PORT, BROWSER_WEB_PORT. The database
 * directory: BROWSER_PG_DIR (default /tmp/daftar-browser-pg-<pg port>).
 */
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
  TOUCH_MIN_PX,
  VIEWPORTS,
  comboTag,
  portsFromEnv,
  type Locale,
  type Viewport,
} from './config';
import { runFlows } from './flows';
import { catalogFacts, type IssueKind } from './invariants';
import { SlidingBudget } from './pacer';
import { PLANTS, Run, type Plant, type StepRecord } from './run-context';
import { seedLocale, type LocaleSeed } from './seed';
import { ROOT, startStack } from './stack';

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
  const workers = Number(value('workers') ?? '3');
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
    const shared = {
      refresh: new SlidingBudget('refresh', REFRESH_BUDGET, AUTH_WINDOW_MS),
      login: new SlidingBudget('login', LOGIN_BUDGET, AUTH_WINDOW_MS),
    };
    const browser = await chromium.launch();
    try {
      await pool(o.locales, o.workers, async (locale) => {
        const seed = seeds.get(locale);
        if (seed === undefined) throw new Error(`no seed for ${locale}`);
        const budgets = { ...shared, loginPerAccount: new SlidingBudget(`login:${locale}`, LOGIN_PER_ACCOUNT_BUDGET, AUTH_WINDOW_MS) };
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
    exitCode = verdict(o, records);
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
function verdict(o: Options, records: readonly StepRecord[]): number {
  const byRun = new Map<string, StepRecord[]>();
  for (const r of records) {
    const key = `${r.locale}-${r.width}`;
    byRun.set(key, [...(byRun.get(key) ?? []), r]);
  }
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
    console.log(
      bad.length === 0 ? `BROWSER GATE PASS: ${records.length} steps in ${byRun.size} runs, 0 issues` : `BROWSER GATE FAIL: ${bad.length} step(s) with issues`,
    );
    return bad.length === 0 ? 0 : 1;
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
  return missed === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
