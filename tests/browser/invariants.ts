/**
 * THE FUNCTIONAL VISUAL INVARIANTS (directive §8), checked in the page.
 *
 * No pixel comparison: every rule below is a property a real layout engine
 * either has or has not, measured on the laid-out DOM of the page as the
 * merchant sees it. The in-page part is plain JavaScript in a string on
 * purpose: the TypeScript loader decorates compiled functions with helpers
 * that do not exist inside the page, so a function literal would be a
 * different program in the browser than the one written here.
 *
 * What is found is returned as `Issue`s with a `kind`, so the red proofs can
 * say which rule fired, in which locale and at which width.
 */
import type { Page } from 'playwright-core';
import type { Locale } from './config';

export type IssueKind =
  | 'hydration'
  | 'typography'
  | 'dir'
  | 'lang'
  | 'overflow'
  | 'clipped-text'
  | 'control-spill'
  | 'primary-clipped'
  | 'touch-target'
  | 'raw-key'
  | 'replacement-char'
  | 'untranslated'
  | 'jargon'
  | 'tax-control'
  | 'console-error'
  | 'csp'
  | 'network'
  | 'page-error'
  | 'keyboard'
  | 'menu'
  | 'confirmation'
  | 'state'
  | 'flow';

export interface Issue {
  readonly kind: IssueKind;
  readonly detail: string;
}

export interface CatalogFacts {
  /** Every catalog key; any of them in the page text is a raw key. */
  readonly keys: readonly string[];
  /**
   * For ar and tr: the English strings whose key has a different translation
   * in the locale. Seeing one in the page means the locale's string is
   * missing and `translate()` fell back to English.
   */
  readonly foreign: Readonly<Record<Locale, readonly string[]>>;
}

export function catalogFacts(dicts: Readonly<Record<Locale, Readonly<Record<string, string>>>>): CatalogFacts {
  const keys = Object.keys(dicts.en);
  const foreignFor = (locale: Locale): string[] => {
    if (locale === 'en') return [];
    const out = new Set<string>();
    for (const key of keys) {
      const en = dicts.en[key];
      if (en === undefined) continue;
      if (dicts[locale][key] === en) continue; // the same text in both languages (a code, a name)
      if (!/\p{L}{3,}/u.test(en.replace(/\{[^}]+\}/g, ''))) continue; // nothing wordlike to see
      out.add(en);
    }
    return [...out];
  };
  return { keys, foreign: { ar: foreignFor('ar'), en: [], tr: foreignFor('tr') } };
}

/** The in-page inspector. `args`: { locale, keys, foreign, touchMin }. */
const INSPECT = String.raw`(args) => {
  const { locale, keys, foreign, touchMin } = args;
  const issues = [];
  const add = (kind, detail) => issues.push({ kind, detail: String(detail).slice(0, 240) });
  const de = document.documentElement;
  const vw = de.clientWidth;
  const text = document.body.innerText;
  const label = (el) => ((el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 40));
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
  };

  // Hydration: React attached its fibers to the server markup.
  const roots = [...document.querySelectorAll('header, main, form, [data-daftar-root]')];
  const hydrated = roots.some((el) => Object.keys(el).some((k) => k.startsWith('__reactFiber$')));
  if (!hydrated) add('hydration', 'no React fiber on the page roots: the server markup was never hydrated');

  // The approved typography (DAFTAR_DESIGN_SYSTEM §3): the Tajawal face is
  // really loaded, not merely named first in a font stack the browser falls
  // through.
  const tajawal = [...document.fonts].filter((f) => f.family.replace(/["']/g, '') === 'Tajawal');
  if (!tajawal.some((f) => f.status === 'loaded')) add('typography', 'no Tajawal face is loaded: the text renders in a fallback font');
  const offFont = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('script, style, svg') || !visible(el)) continue;
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
    const type = (el.getAttribute('type') || '').toLowerCase();
    const control = /^(SELECT|TEXTAREA)$/.test(el.tagName) || (el.tagName === 'INPUT' && !/^(checkbox|radio|hidden|range|color)$/.test(type));
    if (!ownText && !control) continue;
    const family = getComputedStyle(el).fontFamily;
    if (!/^\s*["']?Tajawal/.test(family)) offFont.push(el.tagName.toLowerCase() + ' "' + label(el) + '" in ' + family.split(',')[0]);
  }
  if (offFont.length) add('typography', 'text not set in Tajawal: ' + [...new Set(offFont)].slice(0, 5).join(' | '));

  // Direction and language of the document.
  const wantDir = locale === 'ar' ? 'rtl' : 'ltr';
  if (de.dir !== wantDir) add('dir', 'dir="' + de.dir + '", expected "' + wantDir + '"');
  if (de.lang !== locale) add('lang', 'lang="' + de.lang + '", expected "' + locale + '"');

  // Horizontal overflow, and what causes it.
  if (de.scrollWidth > vw + 1) add('overflow', 'page is ' + de.scrollWidth + 'px wide in a ' + vw + 'px viewport');
  const wide = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || (r.right <= vw + 1 && r.left >= -1)) continue;
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed' || cs.visibility === 'hidden') continue;
    if (el.closest('[data-daftar-offscreen]')) continue;
    wide.push(el.tagName.toLowerCase() + ' [' + Math.round(r.left) + ',' + Math.round(r.right) + '] "' + label(el) + '"');
  }
  if (wide.length) add('overflow', 'outside the viewport: ' + wide.slice(0, 5).join(' | '));

  // Text cut by its own box.
  const clipped = [];
  for (const el of document.querySelectorAll('button, label, h1, h2, h3, span, p, li, strong, option, a, bdi')) {
    if (el.children.length !== 0 || !visible(el)) continue;
    if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible') clipped.push(el.tagName.toLowerCase() + ' "' + label(el) + '"');
  }
  if (clipped.length) add('clipped-text', clipped.slice(0, 5).join(' | '));

  // A control that spills out of its own parent box (the S7 M-2 kind).
  const spill = [];
  for (const el of document.querySelectorAll('input, select, textarea, button, [role=button]')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const p = el.parentElement && el.parentElement.getBoundingClientRect();
    if (!p || p.width === 0) continue;
    if (r.right > p.right + 1 || r.left < p.left - 1) spill.push(el.tagName.toLowerCase() + ' +' + Math.round(Math.max(r.right - p.right, p.left - r.left)) + 'px "' + label(el) + '"');
  }
  if (spill.length) add('control-spill', spill.slice(0, 5).join(' | '));

  // The primary action: the brand-blue buttons. Fully inside the viewport's
  // width, its words not cut, and at least a touch target tall.
  const PRIMARY = 'rgb(37, 99, 235)';
  for (const el of document.querySelectorAll('button')) {
    if (!visible(el) || getComputedStyle(el).backgroundColor !== PRIMARY) continue;
    const r = el.getBoundingClientRect();
    if (r.left < -1 || r.right > vw + 1) add('primary-clipped', '"' + label(el) + '" spans [' + Math.round(r.left) + ',' + Math.round(r.right) + '] of ' + vw + 'px');
    if (el.scrollWidth > el.clientWidth + 1) add('primary-clipped', '"' + label(el) + '" text is cut (' + el.scrollWidth + ' > ' + el.clientWidth + ')');
  }

  // Touch targets: every visible control the merchant presses. A checkbox or
  // radio is pressed through its label, so the label is what is measured.
  const small = [];
  const controls = document.querySelectorAll('button, a[href], select, textarea, input, [role=button], [role=switch], [role=menuitem], [role=option]');
  for (const el of controls) {
    let target = el;
    if (el.tagName === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'hidden') continue;
      if (type === 'checkbox' || type === 'radio') target = el.closest('label') || el;
    }
    if (!visible(target)) continue;
    const r = target.getBoundingClientRect();
    if (r.height + 0.5 < touchMin) small.push(target.tagName.toLowerCase() + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' "' + label(target) + '"');
  }
  if (small.length) add('touch-target', 'below ' + touchMin + 'px: ' + [...new Set(small)].slice(0, 6).join(' | '));

  // Raw catalog keys, the replacement character, untranslated English.
  const rawKeys = new Set((text.match(/\b[a-z]+(?:\.[a-zA-Z_]+){2,}\b/g) || []).filter((k) => !/@|\.(com|local|net|org)$/.test(k)));
  for (const k of keys) if (text.includes(k)) rawKeys.add(k);
  if (rawKeys.size) add('raw-key', [...rawKeys].slice(0, 6).join(', '));
  if (text.includes('�')) add('replacement-char', 'U+FFFD in the page text (a key missing from every catalog)');
  if (foreign.length) {
    const nodes = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const p = n.parentElement;
      if (!p || !visible(p) || p.closest('script, style')) continue;
      const s = (p.innerText || '').trim();
      if (s) nodes.add(s);
    }
    for (const el of document.querySelectorAll('[aria-label], [placeholder]')) {
      for (const a of ['aria-label', 'placeholder']) { const v = el.getAttribute(a); if (v) nodes.add(v.trim()); }
    }
    const hits = [];
    for (const en of foreign) {
      if (en.includes('{')) {
        const parts = en.split(/\{[^}]+\}/).map((s) => s.replace(/[.*+?^$()|[\]\\]/g, '\\$&'));
        if (parts.join('').replace(/[^\p{L}]/gu, '').length < 8) continue;
        const re = new RegExp('^' + parts.join('[\\s\\S]+?') + '$', 'u');
        for (const s of nodes) if (re.test(s)) { hits.push(en); break; }
      } else if (nodes.has(en)) hits.push(en);
    }
    if (hits.length) add('untranslated', 'English text in a ' + locale + ' page: ' + hits.slice(0, 5).map((h) => '"' + h.slice(0, 50) + '"').join(', '));
  }

  // No accounting words, no tax control (the Phase 3 screens' language rule, T-17).
  const acctRe = /\b(debit|credit|ledger|journal|cogs|ppv|valuation|carrying|posting|accrual|payable|receivable|chart of accounts|accounting|tax|taxes|vat|borç kaydı|alacak kaydı|yevmiye|muhasebe|defteri kebir|vergi|kdv)\b|مدين|دائن|قيد يومية|القيود|دفتر الأستاذ|الذمم|ذمم دائنة|محاسب|ضريب|ضرائب|القيمة المضافة/i;
  const jargon = [...new Set(text.split(/\n+/).filter((l) => acctRe.test(l)).map((l) => l.trim().slice(0, 60)))];
  if (jargon.length) add('jargon', jargon.slice(0, 4).join(' | '));
  const taxRe = /tax|vat|vergi|kdv|ضريب|ضرائب|القيمة المضافة/i;
  const taxControls = [];
  for (const el of document.querySelectorAll('input, select, option, textarea, label, [role=switch], [role=radio]')) {
    const s = (el.getAttribute('name') || '') + ' ' + el.id + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? '' : el.textContent || '');
    if (taxRe.test(s)) taxControls.push(el.tagName.toLowerCase() + ' "' + s.trim().slice(0, 40) + '"');
  }
  if (taxControls.length) add('tax-control', taxControls.slice(0, 4).join(' | '));

  return { issues, scrollWidth: de.scrollWidth, dir: de.dir, lang: de.lang };
}`;

export interface Inspection {
  readonly issues: Issue[];
  readonly scrollWidth: number;
  readonly dir: string;
  readonly lang: string;
}

function isInspection(value: unknown): value is Inspection {
  if (typeof value !== 'object' || value === null) return false;
  return 'issues' in value && Array.isArray(value.issues) && 'scrollWidth' in value && typeof value.scrollWidth === 'number';
}

export async function inspect(page: Page, locale: Locale, facts: CatalogFacts, touchMin: number): Promise<Inspection> {
  const args = { locale, keys: facts.keys, foreign: facts.foreign[locale], touchMin };
  const result: unknown = await page.evaluate(`(${INSPECT})(${JSON.stringify(args)})`);
  if (!isInspection(result)) throw new Error('the in-page inspector returned an unexpected shape');
  return result;
}

/**
 * Keyboard reachability: from a blurred document, press Tab until `isTarget`
 * holds for the focused element. Returns the number of presses, or null.
 */
export async function tabUntil(page: Page, isTarget: string, max = 120): Promise<number | null> {
  await page.evaluate(
    `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); window.getSelection() && window.getSelection().removeAllRanges(); })()`,
  );
  for (let i = 1; i <= max; i += 1) {
    await page.keyboard.press('Tab');
    const hit: unknown = await page.evaluate(`(() => { const a = document.activeElement; return !!a && a !== document.body && (${isTarget})(a); })()`);
    if (hit === true) return i;
  }
  return null;
}
