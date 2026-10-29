/**
 * One locale × viewport run: a real Chromium context signed in as the
 * locale's owner, with every console message, CSP report, failed request
 * and page error recorded against the step that was running when it
 * happened. Steps call `shot()` to keep a screenshot and check the page's
 * invariants at that moment.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext, Locator, Page } from 'playwright-core';
import { TOUCH_MIN_PX, comboTag, type Locale, type Viewport } from './config';
import { inspect, type CatalogFacts, type Issue, type IssueKind } from './invariants';
import { BlockedClock } from './pacer';
import type { RouteBudgets, RouteCoverage, SlidingBudget } from './pacer';
import { NAMES, type LocaleNames, type LocaleSeed } from './seed';

export type Plant = 'overflow' | 'raw-key' | 'console-error' | 'missing-string';
export const PLANTS: readonly Plant[] = ['overflow', 'raw-key', 'console-error', 'missing-string'];

export interface ShotRecord {
  readonly file: string;
  readonly issues: Issue[];
}

export interface StepRecord {
  readonly step: string;
  readonly locale: Locale;
  readonly viewport: string;
  readonly width: number;
  readonly shots: ShotRecord[];
  readonly issues: Issue[];
  readonly ms: number;
  /**
   * Of `ms`, the wall-clock time this step spent with at least one of its
   * proxied requests held by the pacer rather than in flight. It is a union of
   * intervals, never a sum of concurrent waits, so it can never exceed `ms`.
   */
  readonly pacedWaitMs: number;
}

export interface Budgets {
  readonly refresh: SlidingBudget;
  readonly login: SlidingBudget;
  readonly loginPerAccount: SlidingBudget;
  /** Every request a page sends through the BFF proxy, per API route. */
  readonly route: RouteBudgets;
  /** The three counts that prove `route` is in front of every one of them. */
  readonly coverage: RouteCoverage;
}

export interface RunOptions {
  readonly browser: Browser;
  readonly webUrl: string;
  readonly locale: Locale;
  readonly viewport: Viewport;
  readonly seed: LocaleSeed;
  readonly dicts: Readonly<Record<Locale, Readonly<Record<string, string>>>>;
  readonly facts: CatalogFacts;
  readonly budgets: Budgets;
  readonly outDir: string;
  readonly plants: readonly Plant[];
  /** Run only these steps (`login` always runs); later steps may depend on earlier ones, so this is for proofs and diagnosis. */
  readonly only: readonly string[] | null;
}

/** The source injected by `--plant`: a defect the gate must report, added after hydration so React never sees it. */
function plantSource(plants: readonly Plant[], locale: Locale, dicts: RunOptions['dicts']): string {
  const parts: string[] = [];
  if (plants.includes('overflow'))
    parts.push(`const o = document.createElement('div'); o.style.width = '2000px'; o.style.height = '4px'; o.textContent = ' '; document.body.appendChild(o);`);
  if (plants.includes('raw-key')) parts.push(`const k = document.createElement('p'); k.textContent = 'stock.levels.title'; document.body.appendChild(k);`);
  if (plants.includes('console-error')) parts.push(`console.error('planted console error');`);
  if (plants.includes('missing-string')) {
    // What translate() renders when the locale lacks a key: the English text
    // in ar/tr, the replacement character in en (en is the last fallback).
    const shown = locale === 'en' ? '�' : (dicts.en['stock.adjust.title'] ?? '');
    parts.push(`const m = document.createElement('p'); m.textContent = ${JSON.stringify(shown)}; document.body.appendChild(m);`);
  }
  if (parts.length === 0) return '';
  return `window.addEventListener('load', () => setTimeout(() => { ${parts.join(' ')} }, 0));`;
}

export class Run {
  readonly locale: Locale;
  readonly viewport: Viewport;
  readonly tag: string;
  readonly names: LocaleNames;
  readonly seed: LocaleSeed;
  readonly steps: StepRecord[] = [];
  page!: Page;
  private context!: BrowserContext;
  private current: { step: string; issues: Issue[]; shots: ShotRecord[]; started: number; pacedAt: number } | null = null;
  /**
   * The gate throttles itself below the API's per-route allowance, so a page's
   * request can sit in `RouteBudgets` for as long as it takes the route's
   * window to free a slot - up to the whole window. That is the harness
   * holding the page back, not the application being slow, and a deadline that
   * counts it is measuring the wrong thing.
   *
   * Measured as a UNION of blocked intervals: `blockedSince` is set when the
   * first request starts waiting and cleared when the last one stops, so two
   * requests waiting at once count once. Summing each `take()`'s own wait
   * would exceed wall time whenever waits overlap, and would excuse time the
   * page never actually lost.
   */
  private readonly pacerClock = new BlockedClock();
  private readonly expected: RegExp[] = [];
  private readonly outDir: string;

  constructor(private readonly o: RunOptions) {
    this.locale = o.locale;
    this.viewport = o.viewport;
    this.tag = comboTag(o.locale, o.viewport);
    this.names = NAMES[o.locale];
    this.seed = o.seed;
    this.outDir = join(o.outDir, this.tag);
    mkdirSync(this.outDir, { recursive: true });
  }

  /**
   * Wall-clock milliseconds this run has spent with a proxied request held by
   * the pacer. Monotonic, and already closed for waits that have ended; a wait
   * still in flight is added so a deadline computed mid-wait is not short by
   * exactly the stall it is meant to discount.
   */
  pacedWaitMs(): number {
    return this.pacerClock.elapsed();
  }

  /** The catalog text for `key` in this run's locale, as translate() renders it. */
  T(key: string, vars?: Record<string, string | number>): string {
    let value = this.o.dicts[this.locale][key] ?? this.o.dicts.en[key];
    if (value === undefined) throw new Error(`the catalog has no key ${key}`);
    for (const [k, v] of Object.entries(vars ?? {})) value = value.replaceAll(`{${k}}`, String(v));
    return value;
  }

  private record(kind: IssueKind, detail: string): void {
    const target = this.current;
    if (target === null) return;
    target.issues.push({ kind, detail: detail.slice(0, 300) });
  }

  /** While `fn` runs, a failed request (and its console line) matching `pattern` is the step's own doing, not an error. */
  async expecting<R>(pattern: RegExp, fn: () => Promise<R>): Promise<R> {
    this.expected.push(pattern);
    try {
      return await fn();
    } finally {
      this.expected.splice(this.expected.indexOf(pattern), 1);
    }
  }

  private isExpected(url: string): boolean {
    return this.expected.some((re) => re.test(url));
  }

  async open(): Promise<void> {
    const { width, height } = this.viewport;
    this.context = await this.o.browser.newContext({
      viewport: { width, height },
      locale: this.locale === 'ar' ? 'ar' : this.locale === 'tr' ? 'tr-TR' : 'en-US',
      hasTouch: width < 1024,
    });
    await this.context.addInitScript(
      `document.addEventListener('securitypolicyviolation', (e) => console.error('CSP-VIOLATION ' + e.violatedDirective + ' ' + e.blockedURI));` +
        plantSource(this.o.plants, this.locale, this.o.dicts),
    );
    const base = this.o.webUrl;
    // Every API read and command a page makes goes through the BFF proxy; each
    // waits for its route's budget first. A step's own `page.route` handler
    // hands a request on with `route.fallback()`, so it is paced here too.
    await this.context.route(
      (url) => url.href.startsWith(`${base}/api/proxy/`),
      async (route) => {
        const request = route.request();
        const { pathname } = new URL(request.url());
        this.o.budgets.coverage.paced(request.method(), pathname, request);
        this.pacerClock.enter();
        try {
          await this.o.budgets.route.take(request.method(), pathname);
        } finally {
          this.pacerClock.leave();
        }
        await route.fallback();
      },
    );
    const page = await this.context.newPage();
    page.setDefaultTimeout(20_000);
    // Counted BEFORE anything can intercept: `request` fires for every request
    // the page makes, so a proxied request missing from the paced count below
    // reached the API without a budget.
    page.on('request', (r) => {
      const url = r.url();
      if (!url.startsWith(`${base}/api/proxy/`)) return;
      // The step is carried with it: a request that turns out to be unpaced is
      // then named by where it came from, and "(between steps)" is itself an
      // answer — it points at teardown rather than at a hole in the flows.
      this.o.budgets.coverage.seen(r.method(), new URL(url).pathname, r, {
        locale: this.locale,
        viewport: String(this.viewport.width),
        step: this.current?.step ?? '(between steps)',
        url: url.replace(base, ''),
        atMs: Date.now(),
      });
    });
    page.on('console', (m) => {
      const text = m.text();
      if (/CSP-VIOLATION|Content Security Policy/i.test(text)) this.record('csp', text);
      else if (m.type() === 'error' && !this.isExpected(m.location().url)) this.record('console-error', text);
    });
    page.on('pageerror', (e) => this.record('page-error', e.message));
    page.on('requestfailed', (r) => {
      const failure = r.failure()?.errorText ?? '';
      // A fetch the browser abandons because the document navigated is not a failure of the app.
      if (failure.includes('ERR_ABORTED') || this.isExpected(r.url())) return;
      this.record('network', `${r.method()} ${r.url().replace(base, '')} ${failure}`);
    });
    page.on('response', (r) => {
      const url = r.url();
      if (!url.startsWith(base) || r.status() < 400 || this.isExpected(url)) return;
      this.record('network', `${r.status()} ${r.request().method()} ${url.replace(base, '')}`);
    });
    page.on('response', (r) => {
      if (r.request().resourceType() !== 'document' || !r.url().startsWith(base)) return;
      void r
        .allHeaders()
        .then((h) => {
          const csp = h['content-security-policy'] ?? '';
          if (!csp.includes("'nonce-")) this.record('csp', `document ${r.url().replace(base, '')} has no nonce policy: ${csp.slice(0, 80)}`);
        })
        .catch((e: unknown) => this.record('network', `document headers unreadable: ${String(e)}`));
    });
    this.page = page;
  }

  async close(): Promise<void> {
    await this.context.close();
  }

  /** Run one named step; anything it throws is a `flow` issue of that step. */
  async step(name: string, fn: () => Promise<void>): Promise<void> {
    if (this.o.only !== null && name !== 'login' && !this.o.only.includes(name)) return;
    this.current = { step: name, issues: [], shots: [], started: Date.now(), pacedAt: this.pacedWaitMs() };
    try {
      await fn();
      await this.page.waitForTimeout(300); // let the step's last responses and console lines arrive
    } catch (error) {
      this.record('flow', error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error));
      await this.shot(`${name}-error`).catch((e: unknown) => this.record('flow', `error screenshot failed: ${String(e)}`));
    }
    const done = this.current;
    this.current = null;
    this.steps.push({
      step: name,
      locale: this.locale,
      viewport: this.viewport.name,
      width: this.viewport.width,
      shots: done.shots,
      issues: done.issues,
      ms: Date.now() - done.started,
      pacedWaitMs: this.pacedWaitMs() - done.pacedAt,
    });
  }

  /** Keep a full-page screenshot and check every layout/text invariant on the page as it is now. */
  async shot(name: string): Promise<void> {
    await this.page.waitForTimeout(250);
    await this.page.evaluate('document.fonts.ready.then(() => true)');
    const file = `${this.tag}/${name}.png`;
    await this.page.screenshot({ path: join(this.outDir, `${name}.png`), fullPage: true });
    const result = await inspect(this.page, this.locale, this.o.facts, TOUCH_MIN_PX);
    const target = this.current;
    if (target === null) return;
    target.shots.push({ file, issues: result.issues });
    for (const i of result.issues) target.issues.push({ kind: i.kind, detail: `[${name}] ${i.detail}` });
  }

  fail(kind: IssueKind, detail: string): void {
    this.record(kind, detail);
  }

  /**
   * A step answered this request itself, so it never reached the API and owes
   * it nothing. Declared here rather than inferred, because the alternative —
   * letting the coverage check tolerate a shortfall — is exactly the leniency
   * that would let a genuinely unpaced request pass as a deliberate one.
   */
  answeredLocally(method: string, url: string, token?: object): void {
    this.o.budgets.coverage.fulfilled(method, new URL(url).pathname, token);
  }

  /** A full document load spends one refresh; wait for the budget first. */
  async load(path: string): Promise<void> {
    await this.o.budgets.refresh.take();
    await this.page.goto(`${this.o.webUrl}/${this.locale}${path}`);
  }

  async reload(): Promise<void> {
    await this.o.budgets.refresh.take();
    await this.page.reload();
  }

  async login(): Promise<void> {
    await this.o.budgets.login.take();
    await this.o.budgets.loginPerAccount.take();
    await this.page.goto(`${this.o.webUrl}/${this.locale}/login`);
    await this.page.evaluate(`localStorage.setItem('daftar_business_id', ${JSON.stringify(this.seed.businessId)})`);
    await this.page.locator('input[type=email]').fill(this.seed.email);
    await this.page.locator('input[type=password]').fill(this.seed.password);
    await this.page.locator('button[type=submit]').click();
    await this.page.waitForURL(/\/dashboard$/);
  }

  field(label: string): Locator {
    return this.page.getByLabel(label, { exact: true });
  }

  button(name: string): Locator {
    return this.page.getByRole('button', { name, exact: true });
  }

  row(text: string): Locator {
    return this.page.locator('li', { hasText: text }).first();
  }

  async text(key: string, vars?: Record<string, string | number>): Promise<void> {
    await this.page.getByText(this.T(key, vars)).first().waitFor();
  }
}
