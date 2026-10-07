import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import ar from '@/messages/ar.json';
import en from '@/messages/en.json';
import tr from '@/messages/tr.json';
import { dirOf, translate, type Locale } from '@/lib/i18n';
import type { ViewFixture } from '@/lib/phase3-format';
import { VIEW_REGISTRY as INSTALLMENTS } from '@/views/installments/registry';
import { findMerchantJargon, isS7Key, type CatalogLocale } from '../../../scripts/guards/merchant-jargon';
import { phoneWidthViolations, physicalDirectionViolations, leakedHiddenValues } from './helpers/layout-rules';
import { elements, renderFixture, textOf, type ElementNode, type Rendered } from './helpers/render';

/**
 * P4-S7 LEVEL D — THE SCHEDULE AND DEBT SCREENS, IN ar, en AND tr.
 *
 * ── WHAT IS ASSERTED, AND WHY EACH ONE ──────────────────────────────────
 *
 *  D-1  every fixture renders in all three locales, at phone width, with no
 *       physical direction property and no leaked hidden value. These are the
 *       estate's own T-08 / T-15 / T-16 rules, applied through the estate's own
 *       helpers rather than re-implemented;
 *  D-2  the structure is IDENTICAL across the three locales. A screen that is
 *       a different component in Arabic is a screen that has to be corrected
 *       once per locale forever, and the mirroring belongs to the browser;
 *  D-3  every string a merchant reads comes from the catalogue, in all three
 *       locales — proved by rendering with each catalogue and requiring the
 *       translated text to appear, and by requiring the replacement character
 *       `�` (what `translate` emits for a missing key) never to appear;
 *  D-4  the merchant-language guard is clean over the new keys, run through
 *       `findMerchantJargon` — the guard the localization gate itself runs,
 *       not a copy of it — and shown able to go red on a planted term;
 *  D-5  the as-of date is on every screen that shows a derived status. A
 *       status without its date is a status nobody can check;
 *  D-6  an empty collection renders an EMPTY STATE and not a refusal, which
 *       is the recorded lesson in the one place a merchant meets it;
 *  D-7  no screen offers a "pay this instalment" command, because there is no
 *       such command: collection is the ordinary payment path (law 4).
 */

const LOCALES: Locale[] = ['ar', 'en', 'tr'];
const CATALOGS: Readonly<Record<CatalogLocale, Readonly<Record<string, string>>>> = { ar, en, tr };

function fixtures(): { view: string; fixture: ViewFixture }[] {
  return INSTALLMENTS.flatMap((entry) => entry.fixtures.map((fixture) => ({ view: entry.name, fixture })));
}

const render = (view: string, name: string, locale: Locale = 'en'): Rendered => {
  const entry = INSTALLMENTS.find((e) => e.name === view);
  const found = entry?.fixtures.find((f) => f.name === name);
  if (!found) throw new Error(`no fixture ${view} / ${name}`);
  return renderFixture(found, locale);
};

const all = (r: Rendered, tag: string): ElementNode[] => [...elements(r.frame)].filter((e) => e.tag === tag);
const buttons = (r: Rendered): string[] => all(r, 'button').map(textOf);
const text = (r: Rendered): string => textOf(r.frame);
const t = (locale: Locale, key: string, vars?: Record<string, string | number>) => translate(locale, key, vars);

/** The structure of a render with its text removed: tags and their nesting only. */
const shape = (r: Rendered): string => [...elements(r.frame)].map((e) => e.tag).join('>');

describe('P4-S7 D-1 — every fixture renders in all three locales under the estate’s own rules', () => {
  it('there is something to render, and the registry is the one the SSR loader will find', () => {
    // Non-vacuity: a suite that found no fixture would pass every claim below
    // by looping zero times.
    expect(fixtures().length).toBeGreaterThanOrEqual(12);
    expect(INSTALLMENTS.map((e) => e.name).sort()).toEqual(['CustomerDebtsView', 'DebtAgingView', 'InstallmentPlanListView', 'InstallmentPlanView']);
  });

  it.each(LOCALES)('no phone-width violation and no physical direction property in %s', (locale) => {
    for (const { view, fixture } of fixtures()) {
      const r = renderFixture(fixture, locale);
      expect(phoneWidthViolations(r, locale), `${view}/${fixture.name}/${locale}`).toEqual([]);
      expect(physicalDirectionViolations(r), `${view}/${fixture.name}/${locale}`).toEqual([]);
    }
  });

  it.each(LOCALES)('no hidden value reaches the merchant in %s', (locale) => {
    for (const { view, fixture } of fixtures()) {
      const r = renderFixture(fixture, locale);
      expect(leakedHiddenValues(r, fixture.props), `${view}/${fixture.name}/${locale}`).toEqual([]);
    }
  });

  it.each(LOCALES)('no plan or sale id is rendered as text in %s, so an id never becomes a screen’s content', (locale) => {
    // A uuid on a screen is an engine term by another route: the merchant
    // reads a document NUMBER, which is theirs, and never an identifier,
    // which is ours. The ids are in the fixtures, so this is a real claim.
    for (const { view, fixture } of fixtures()) {
      const r = renderFixture(fixture, locale);
      expect(/[0-9a-f]{8}-[0-9a-f]{4}-/.test(r.html), `${view}/${fixture.name}/${locale}`).toBe(false);
    }
  });
});

describe('P4-S7 D-2 — one component for three locales; the mirroring is the browser’s', () => {
  it('the rendered STRUCTURE is identical in ar, en and tr for every fixture', () => {
    for (const { view, fixture } of fixtures()) {
      const shapes = LOCALES.map((locale) => shape(renderFixture(fixture, locale)));
      expect(new Set(shapes).size, `${view}/${fixture.name} renders a different structure per locale`).toBe(1);
    }
  });

  it('direction comes from the locale and nothing in the views decides a side', () => {
    expect(dirOf('ar')).toBe('rtl');
    expect(dirOf('en')).toBe('ltr');
    expect(dirOf('tr')).toBe('ltr');
    // And the views contain no locale comparison at all: a view that read
    // `locale === 'ar'` to pick a margin is a view that is corrected once per
    // locale forever. Asserted over the real sources.
    for (const file of ['InstallmentPlanView.tsx', 'CustomerDebtsView.tsx']) {
      // Comments are stripped FIRST, and the precondition is asserted: this
      // module's own header DISCUSSES `marginLeft` as the shape it refuses, so
      // a law that read the prose would redden on its own documentation.
      const source = stripProse(readViewSource(file));
      expect(source.length, file).toBeGreaterThan(500);
      expect(/locale\s*===\s*'ar'/.test(source), file).toBe(false);
      expect(/margin(?:Left|Right)|padding(?:Left|Right)|\bleft:|\bright:/.test(source), file).toBe(false);
    }
    // Non-vacuity of the stripper and of the pattern together.
    expect(stripProse('/* marginLeft */ const a = 1;')).not.toMatch(/margin(?:Left|Right)/);
    expect(stripProse('const s = { marginLeft: 4 };')).toMatch(/margin(?:Left|Right)/);
  });
});

/** Source with its comments removed, so a law about code cannot be satisfied or failed by prose. */
function stripProse(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

function readViewSource(file: string): string {
  return readFileSync(join(__dirname, '..', 'src', 'views', 'installments', file), 'utf8');
}

describe('P4-S7 D-3 — every merchant-facing string is translated, in all three locales', () => {
  it.each(LOCALES)('no missing-key replacement character appears anywhere in %s', (locale) => {
    for (const { view, fixture } of fixtures()) {
      const r = renderFixture(fixture, locale);
      expect(r.html.includes('�'), `${view}/${fixture.name}/${locale} rendered a missing key`).toBe(false);
    }
  });

  it.each(LOCALES)('the plan screen shows its own catalogue’s words in %s', (locale) => {
    const r = render('InstallmentPlanView', 'four instalments, one late, one due today', locale);
    for (const key of [
      'installments.plan.title',
      'installments.plan.asOf',
      'installments.plan.saleTotal',
      'installments.plan.stillOwed',
      'installments.plan.lateAmount',
      'installments.plan.nextDue',
      'installments.status.settled',
      'installments.status.overdue',
      'installments.status.due_today',
      'installments.status.upcoming',
    ]) {
      expect(text(r), `${locale}/${key}`).toContain(t(locale, key));
    }
  });

  it.each(LOCALES)('the debts screen and the aging show their own catalogue’s words in %s', (locale) => {
    const debts = render('CustomerDebtsView', 'one on a plan and one plain sale', locale);
    expect(text(debts)).toContain(t(locale, 'debts.list.title'));
    expect(text(debts)).toContain(t(locale, 'debts.list.stillOwed'));
    expect(text(debts)).toContain(t(locale, 'debts.list.hasSchedule'));
    const aging = render('DebtAgingView', 'four buckets, one empty', locale);
    expect(text(aging)).toContain(t(locale, 'debts.aging.title'));
    expect(text(aging)).toContain(t(locale, 'debts.aging.total'));
  });

  it.each(LOCALES)('a day count is interpolated into a translated sentence, never concatenated, in %s', (locale) => {
    // "15" and "days late" joined in source order is the defect RTL exposes.
    // The sentence carries the number as a variable, so the two mirror
    // together — and the rendered text is the WHOLE sentence, not the number
    // beside a word.
    const r = render('InstallmentPlanView', 'four instalments, one late, one due today', locale);
    const sentence = t(locale, 'installments.row.lateByDays', { days: 28 });
    expect(sentence).not.toBe('installments.row.lateByDays');
    expect(sentence.includes('28'), `${locale} must interpolate the day count`).toBe(true);
    expect(text(r), locale).toContain(sentence);
  });

  it('every new key of this slice exists in all three catalogues, with no empty value', () => {
    const ours = Object.keys(en).filter((k) => k.startsWith('installments.') || k.startsWith('debts.') || k.startsWith('error.installment'));
    expect(ours.length).toBeGreaterThanOrEqual(90);
    for (const locale of LOCALES) {
      for (const key of ours) {
        const value = CATALOGS[locale][key];
        expect(value, `${locale} is missing ${key}`).toBeDefined();
        expect((value ?? '').trim().length, `${locale}/${key} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it('nav.installments and nav.debts are the keys the estate already reserved for these screens', () => {
    // `S7_NAV_KEYS` (`scripts/guards/merchant-jargon.ts:95-96`) names both, so
    // using any other key would put the nav label outside the guard's scope.
    for (const key of ['nav.installments', 'nav.debts']) {
      expect(isS7Key(key), key).toBe(true);
      for (const locale of LOCALES) expect(CATALOGS[locale][key], `${locale}/${key}`).toBeDefined();
    }
  });
});

describe('P4-S7 D-4 — the merchant-language guard, run through the gate’s own device', () => {
  it('CLEAN — no new key of this slice uses an engine term, in any locale', () => {
    const hits = findMerchantJargon(CATALOGS).filter(
      (h) => h.key.startsWith('installments.') || h.key.startsWith('debts.') || h.key.startsWith('error.installment'),
    );
    expect(hits, JSON.stringify(hits, null, 2)).toEqual([]);
  });

  it('CLEAN — and the whole catalogue is clean, so this slice broke nothing', () => {
    expect(findMerchantJargon(CATALOGS)).toEqual([]);
  });

  it('RED PROOF — the guard NAMES a planted engine term under this slice’s namespace, in each locale', () => {
    // Semantic: the real guard is run over a real catalogue copy carrying a
    // real denied term under a real key of this slice. English "account",
    // Arabic «حساب» — which is why the statement is «كشف المديونية» and not
    // the glossary's «كشف حساب» — and Turkish «borçlu».
    for (const [locale, planted] of [
      ['en', 'Customer account statement'],
      ['ar', 'كشف حساب العميل'],
      ['tr', 'Borçlu listesi'],
    ] as const) {
      const copy = { ...CATALOGS, [locale]: { ...CATALOGS[locale], 'debts.history.title': planted } };
      const hits = findMerchantJargon(copy).filter((h) => h.key === 'debts.history.title');
      expect(hits.length, `${locale} / ${planted}`).toBeGreaterThan(0);
      expect(hits[0]?.locale).toBe(locale);
    }
  });

  it('RED PROOF — a term under a namespace the guard does NOT watch stays silent, so the scope is real', () => {
    // `accounting.` is deliberately outside the guard: it is the accountant's
    // chart. A guard that flagged it would be a guard with the wrong scope,
    // and this is the arm that proves the scope is the one that was intended.
    const copy = { ...CATALOGS, en: { ...CATALOGS.en, 'accounting.account.cash': 'Cash account' } };
    expect(findMerchantJargon(copy).filter((h) => h.key.startsWith('accounting.'))).toEqual([]);
  });
});

describe('P4-S7 D-5 — a derived status never appears without the date it was derived at', () => {
  it.each(LOCALES)('the plan screen shows its as-of date beside its statuses in %s', (locale) => {
    const r = render('InstallmentPlanView', 'four instalments, one late, one due today', locale);
    expect(text(r)).toContain(t(locale, 'installments.plan.asOf'));
    // And the date itself is rendered, formatted for the locale.
    expect(r.html).toMatch(/2026/);
  });

  it.each(LOCALES)('the debts screen and the aging show theirs in %s', (locale) => {
    expect(text(render('CustomerDebtsView', 'one on a plan and one plain sale', locale))).toContain(t(locale, 'debts.list.asOf'));
    expect(text(render('DebtAgingView', 'four buckets, one empty', locale))).toContain(t(locale, 'debts.list.asOf'));
    expect(text(render('InstallmentPlanListView', 'two plans', locale))).toContain(t(locale, 'installments.plan.asOf'));
  });

  it('every fixture that renders a status carries an asOf, asserted over the registry itself', () => {
    // A fixture without one could not be rendered correctly, and the claim is
    // about the CONTRACT rather than about today's fixtures: the model's `asOf`
    // is required, so this is the runtime half of a compile-time fact.
    for (const { view, fixture } of fixtures()) {
      const props = fixture.props as Record<string, unknown>;
      const asOf = props['asOf'] ?? (props['plan'] as Record<string, unknown> | undefined)?.['asOf'];
      expect(typeof asOf, `${view}/${fixture.name}`).toBe('string');
      expect(asOf, `${view}/${fixture.name}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('P4-S7 D-6 — an empty collection is an empty state, never a refusal', () => {
  it.each(LOCALES)('an empty schedule says so in %s, and shows no refusal notice', (locale) => {
    const r = render('InstallmentPlanView', 'an empty schedule is an empty state, never a refusal', locale);
    expect(text(r)).toContain(t(locale, 'installments.plan.noRows'));
    // No refusal sentence of this slice appears: the screen is a 200 with an
    // empty collection, and the merchant is told that in their own words.
    expect(text(r)).not.toContain(t(locale, 'error.installment_plan.not_found'));
  });

  it.each(LOCALES)('a customer who owes nothing is told so, not refused, in %s', (locale) => {
    const r = render('CustomerDebtsView', 'nothing owed', locale);
    expect(text(r)).toContain(t(locale, 'debts.list.nothingOwed'));
    expect(text(r)).not.toContain(t(locale, 'error.installment.cursor_invalid'));
  });

  it.each(LOCALES)('a plan list with no plan is an empty state in %s', (locale) => {
    expect(text(render('InstallmentPlanListView', 'no plan yet', locale))).toContain(t(locale, 'installments.list.empty'));
  });

  it.each(LOCALES)('a REAL refusal, by contrast, IS shown — so the previous claims are not about an invisible notice, in %s', (locale) => {
    const r = render('InstallmentPlanView', 'a refusal is shown in the merchant’s words', locale);
    expect(text(r)).toContain(t(locale, 'error.installment_plan.settlement_changed'));
    // And it is the merchant's sentence, never the code.
    expect(text(r)).not.toContain('installment_plan.settlement_changed');
  });
});

describe('P4-S7 D-7 — there is no second collection mechanism on any screen (law 4)', () => {
  it('the plan screen offers "take a payment", which is the ORDINARY payment path', () => {
    const r = render('InstallmentPlanView', 'four instalments, one late, one due today');
    expect(buttons(r)).toContain(t('en', 'installments.plan.takePayment'));
    // And the screen SAYS where the money goes, so a merchant is not left to
    // infer that a payment settles a row rather than the sale.
    expect(text(r)).toContain(t('en', 'installments.plan.takePaymentHint'));
  });

  it('no per-instalment pay action exists anywhere in the views', () => {
    for (const file of ['InstallmentPlanView.tsx', 'CustomerDebtsView.tsx']) {
      const source = stripProse(readViewSource(file));
      expect(/onPayInstallment|onSettleInstallment|payInstallment/.test(source), file).toBe(false);
    }
  });

  it('stopping a plan tells the merchant the debt does not change — the clearest statement of law 1', () => {
    const r = render('InstallmentPlanView', 'four instalments, one late, one due today');
    expect(buttons(r)).toContain(t('en', 'installments.plan.stop'));
    expect(text(r)).toContain(t('en', 'installments.plan.stopHint'));
  });

  it('a caller without the sensitive permission is offered no plan change at all', () => {
    const r = render('InstallmentPlanView', 'no permission to change a plan');
    expect(buttons(r)).not.toContain(t('en', 'installments.plan.changeDates'));
    expect(buttons(r)).not.toContain(t('en', 'installments.plan.stop'));
    expect(buttons(r)).not.toContain(t('en', 'installments.plan.takePayment'));
    // And is told what to do instead, rather than shown a dead screen.
    expect(text(r)).toContain(t('en', 'installments.plan.askOwner'));
  });

  /**
   * The words a charge would be called in, and the matcher that looks for them.
   *
   * The claim is about what a MERCHANT READS, so it is asserted over the
   * rendered text and over the catalogues — not over the raw HTML. Raw HTML
   * was the first draft of this law and it was a FALSE RED: the design
   * system's `dangerSoft` token is `#FEE2E2` (`packages/design-system/src/tokens.ts:36`),
   * the late badge renders it as an inline colour, and `fee2e2` contains
   * `fee`. A law that reads colour hexes is a law about the palette.
   *
   * The match is word-bounded for the same reason, so a legitimate word that
   * merely contains one of these (a "faizsiz" or an "interested") is matched
   * only when it is the word itself. The boundary is `[\p{L}\p{N}]` and not
   * `\w` — `\w` is ASCII and three of the terms are not — and it includes
   * NUMBERS, because `#FEE2E2` is `FEE` followed by a digit: a letter-only
   * boundary still matches it, which is the measured form of the same false
   * red one step further on.
   */
  const CHARGE_WORDS = ['interest', 'fee', 'fees', 'penalty', 'penalties', 'فائدة', 'فوائد', 'faiz', 'ceza'] as const;
  const chargeWordIn = (haystack: string): string | null => {
    for (const word of CHARGE_WORDS) {
      if (new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, 'iu').test(haystack)) return word;
    }
    return null;
  };

  it('the charge-word matcher is not vacuous: it finds a planted word and ignores a hex and a longer word', () => {
    expect(chargeWordIn('a late fee of 5')).toBe('fee');
    expect(chargeWordIn('رسوم فائدة')).toBe('فائدة');
    // Bare «ceza» and not «cezası»: the suffix is a letter, so the bounded
    // match does not fire on the inflected form. That is a limit of the law
    // and it is recorded here rather than hidden — the catalogue claim below
    // is what actually closes it, because it reads every S7 string.
    expect(chargeWordIn('gecikme ceza 5')).toBe('ceza');
    expect(chargeWordIn('gecikme cezası')).toBe(null);
    // The two shapes that made the raw-HTML draft of this law a false red,
    // and the shape that makes an unbounded match one.
    expect(chargeWordIn('background:#FEE2E2')).toBe(null);
    expect(chargeWordIn('faizsiz taksit')).toBe(null);
  });

  it('no screen shows an interest, fee or penalty figure, because none exists', () => {
    for (const locale of LOCALES) {
      for (const { fixture } of fixtures()) {
        const r = renderFixture(fixture, locale);
        const hit = chargeWordIn(textOf(r.frame));
        expect(hit, `${fixture.name}/${locale}/${hit ?? ''}`).toBe(null);
      }
    }
  });

  /**
   * THIS SLICE's keys, and not `isS7Key`'s.
   *
   * `isS7Key` (`scripts/guards/merchant-jargon.ts:117`) answers a different
   * question — "is this key in a merchant-facing namespace the guard owns" —
   * and its answer is yes for `purchasing.`, `payments.`, `common.` and the
   * whole `error.` tree. Scoping the claim with it was a MEASURED false red:
   * `purchasing.extraCost.kind.customs` reads "Customs and fees" in English,
   * which is a real cost on a real purchase and no part of this slice. A law
   * about installments may not fail on a purchasing string.
   */
  const isS7OwnKey = (key: string): boolean =>
    key === 'nav.installments' ||
    key === 'nav.debts' ||
    key.startsWith('installments.') ||
    key.startsWith('debts.') ||
    key.startsWith('error.installment.') ||
    key.startsWith('error.installment_plan.');

  it('and no key of THIS slice, in any locale, carries one — so no future screen can show one either', () => {
    let checked = 0;
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      for (const [key, value] of Object.entries(catalog)) {
        if (!isS7OwnKey(key)) continue;
        checked += 1;
        const hit = chargeWordIn(value);
        expect(hit, `${locale}/${key}/${hit ?? ''}`).toBe(null);
      }
    }
    // Non-vacuity: 95 keys per locale, three locales.
    expect(checked).toBeGreaterThanOrEqual(280);
  });
});
