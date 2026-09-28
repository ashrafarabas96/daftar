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
import type { SlidingBudget } from './pacer';
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
}

export interface Budgets {
  readonly refresh: SlidingBudget;
  readonly login: SlidingBudget;
  readonly loginPerAccount: SlidingBudget;
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
  private current: { step: string; issues: Issue[]; shots: ShotRecord[]; started: number } | null = null;
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
    const page = await this.context.newPage();
    page.setDefaultTimeout(20_000);
    const base = this.o.webUrl;
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
    this.current = { step: name, issues: [], shots: [], started: Date.now() };
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
    });
  }

  /** Keep a full-page screenshot and check every layout/text invariant on the page as it is now. */
  async shot(name: string): Promise<void> {
    await this.page.waitForTimeout(250);
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
