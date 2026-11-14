import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ar from '@/messages/ar.json';
import en from '@/messages/en.json';
import tr from '@/messages/tr.json';
import { ApiError } from '@/lib/client';
import { refusalKey } from '@/lib/phase3-errors';
import { formatCivilDate, formatMoney, type ViewEntry } from '@/lib/phase3-format';
import { splitMinorSign } from '@/lib/minor-sign';
import { ACCOUNT_AGING_BUCKET_DAYS, AGE_BAND_KEYS, CREDITS_READ_CAP } from '@/lib/phase4-customer-account-api';
import { unreadableAccount } from '@/app/[locale]/customers/[customerId]/account-page-kit';
import type { CustomerAccountViewProps } from '@/views/customers/CustomerAccountView';
import { VIEW_REGISTRY as CUSTOMER_VIEWS } from '@/views/customers/registry';
import { findMerchantJargon, stripTsComments } from '../../../scripts/guards/merchant-jargon';
import { elements, LOCALES, renderFixture, textOf, type Locale, type Rendered } from './helpers/render';

/**
 * MVP-02, the customer account screen (read-only): what ONE customer owes, from
 * four merged reads — `GET /v1/customers/:id` (`customers.view`), and
 * `…/receivable`, `…/receivable/aging` and `…/open-invoices` (`receivables.view`,
 * business-wide scope), all in `apps/api/src/modules/selling/customer-reads.ts`.
 *
 * The money law this suite holds the screen to:
 *  - every amount is a minor-unit STRING, formatted by the BigInt-exact
 *    `formatMoney`, and shown EXACTLY as the server stated it: no sum, no
 *    difference, no percentage, nothing added across currencies. A rendered
 *    figure that is not one of the server's own is an invented figure;
 *  - the balance may be NEGATIVE (L3 contract note §6): it is worded as money
 *    held for the customer, with the magnitude taken by string handling, and
 *    never as "we owe the customer";
 *  - there is no credit limit (OD-P4-03 OPTION A), so no limit message;
 *  - the aging boundaries are the one set this release offers, 0,30,60,90 (DR-14).
 *
 * It claims nothing about whether the server's figures are right: "the figures
 * are the server's, verbatim" is the whole claim.
 */
const WEB_SRC = join(__dirname, '..', 'src');
const read = (...parts: string[]): string => readFileSync(join(WEB_SRC, ...parts), 'utf8');
const VIEW_SOURCE = (): string => stripTsComments(read('views', 'customers', 'CustomerAccountView.tsx'));
const PAGE_DIR = ['app', '[locale]', 'customers', '[customerId]'] as const;
const PAGE_SOURCE = (): string => stripTsComments(read(...PAGE_DIR, 'page.tsx'));
const KIT_SOURCE = (): string => stripTsComments(read(...PAGE_DIR, 'account-page-kit.ts'));
const LIB_SOURCE = (): string => stripTsComments(read('lib', 'phase4-customer-account-api.ts'));

const CATALOGS: Record<Locale, Record<string, string>> = { ar, en, tr };
const VIEW = 'CustomerAccountView';

const F_OWES = 'owes in one currency, with open invoices and a further page';
const F_HELD = 'money held for the customer: the balance is below zero';
const F_MULTI = 'owes in two currencies';
const F_ZERO = 'nothing owed and nothing open';
const F_HUGE = 'an amount beyond 2^53';
const F_REFUSED = 'show more was refused, with the rows still on screen';
const F_CAPPED = 'more held amounts than one read returns';
const F_CAPPED_SPENT = 'the read returned its full 200 held amounts and every one is used up';
const FIXTURES = [F_OWES, F_HELD, F_MULTI, F_ZERO, F_HUGE, F_REFUSED, F_CAPPED, F_CAPPED_SPENT];

const entry = (): ViewEntry => {
  const found = CUSTOMER_VIEWS.find((e) => e.name === VIEW);
  if (!found) throw new Error(`no ${VIEW} in the customers registry`);
  return found;
};
const propsOf = (fixture: string): CustomerAccountViewProps => {
  const found = entry().fixtures.find((f) => f.name === fixture);
  if (!found) throw new Error(`no fixture ${fixture}`);
  return found.props as CustomerAccountViewProps;
};
function render(fixture: string, locale: Locale = 'en'): Rendered {
  const found = entry().fixtures.find((f) => f.name === fixture);
  if (!found) throw new Error(`no fixture ${fixture}`);
  return renderFixture(found, locale);
}
const text = (r: Rendered): string => textOf(r.frame);
/** `formatMoney`, with whitespace collapsed the way `textOf` reads markup (CLDR puts a no-break space before ₪). */
const fm = (amountMinor: string, currency: string, locale: Locale): string => formatMoney(amountMinor, currency, locale).replace(/\s+/g, ' ').trim();
const buttons = (r: Rendered): string[] => [...elements(r.frame)].filter((e) => e.tag === 'button').map((e) => textOf(e));
/** Every left-to-right isolate the view rendered: each figure, date and number lives in one. */
const ltrRuns = (r: Rendered): string[] => [...elements(r.frame)].filter((e) => e.tag === 'bdi' && e.attrs['dir'] === 'ltr').map((e) => textOf(e));

/** The keys this screen adds. */
const NEW_KEY_PREFIX = 'customers.account.';
const onlyNewKeys = (dict: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(dict).filter(([k]) => k.startsWith(NEW_KEY_PREFIX)));

/** A currency line that only repeats the figure beside it (same currency, same text) — the one line the view may leave out. */
const repeats = (lines: readonly { currency: string; txnMinor: string }[], baseMinor: string, baseCurrency: string): boolean =>
  lines.length === 1 && lines[0]?.currency === baseCurrency && lines[0]?.txnMinor === baseMinor;

/**
 * Every figure the server stated in this fixture that the screen must show, as
 * `formatMoney` spells its MAGNITUDE. Built from the props by hand, one place,
 * so the "shown" and "nothing else" checks read the fixture the same way.
 */
function statedFigures(p: CustomerAccountViewProps, locale: Locale): string[] {
  const mag = (s: string): string => (s.startsWith('-') ? s.slice(1) : s);
  const out: string[] = [];
  out.push(fm(mag(p.receivable.baseMinor), p.receivable.baseCurrency, locale));
  if (!repeats(p.receivable.byCurrency, p.receivable.baseMinor, p.receivable.baseCurrency)) {
    for (const line of p.receivable.byCurrency) out.push(fm(mag(line.txnMinor), line.currency, locale));
  }
  for (const bucket of p.aging.buckets) {
    out.push(fm(mag(bucket.baseMinor), p.aging.baseCurrency, locale));
    if (!repeats(bucket.byCurrency, bucket.baseMinor, p.aging.baseCurrency)) {
      for (const line of bucket.byCurrency) out.push(fm(mag(line.txnMinor), line.currency, locale));
    }
  }
  for (const invoice of p.openInvoices) {
    out.push(fm(mag(invoice.outstandingTxnMinor), invoice.currency, locale));
    out.push(fm(mag(invoice.totalTxnMinor), invoice.currency, locale));
  }
  for (const credit of heldCredits(p)) out.push(fm(credit.remainingAmountMinor, credit.currencyCode, locale));
  return out;
}

/** The held amounts the screen shows: every credit with something left. An exhausted one ("0") holds nothing. */
function heldCredits(p: CustomerAccountViewProps): CustomerAccountViewProps['credits'] {
  return p.credits.filter((c) => !/^0+$/.test(c.remainingAmountMinor));
}

/** Everything else a left-to-right isolate may legitimately hold: dates, day counts, document numbers. */
function statedNonMoney(p: CustomerAccountViewProps, locale: Locale): string[] {
  const out = [formatCivilDate(p.aging.asOf, locale)];
  for (const invoice of p.openInvoices) {
    out.push(invoice.documentNumber, formatCivilDate(invoice.issueDate, locale), String(invoice.daysPastDue), String(invoice.ageDays));
    if (invoice.dueDate !== null) out.push(formatCivilDate(invoice.dueDate, locale));
  }
  for (const credit of heldCredits(p)) out.push(formatCivilDate(credit.creditDate, locale));
  for (const bucket of p.aging.buckets) out.push(String(bucket.fromDays), String(bucket.toDays));
  if (p.creditsCapped) out.push(String(CREDITS_READ_CAP));
  return out;
}

/** The figures rendered that the server did not state: a sum, a difference, a re-spelled number. */
function inventedRuns(r: Rendered, p: CustomerAccountViewProps, locale: Locale): string[] {
  const allowed = new Set([...statedFigures(p, locale), ...statedNonMoney(p, locale)]);
  return ltrRuns(r).filter((run) => !allowed.has(run));
}

/** Arithmetic a view of server money must not do: a numeric parse, a BigInt, a reduction, a fixed-point spelling. */
const MONEY_ARITHMETIC = /\bNumber\(|\bparseInt\(|\bparseFloat\(|\bBigInt\(|\.reduce\(|\btoFixed\(|\bMath\.|\+\s*BigInt|\bunary\+/;
function arithmeticFindings(source: string): string[] {
  const out: string[] = [];
  const m = MONEY_ARITHMETIC.exec(source);
  if (m) out.push(`arithmetic: ${m[0]}`);
  if (/[A-Za-z]Minor\s*[-+*/]\s*[\w(]|[\w)]\s*[-+*/]\s*[\w.]*Minor\b/.test(source)) out.push('an operator applied to a minor-unit field');
  return out;
}

describe('the sign helper (string handling only, no arithmetic)', () => {
  it('splits a minor-unit integer string into its sign and its magnitude, exactly', () => {
    expect(splitMinorSign('0')).toEqual({ sign: 'zero', magnitude: '0' });
    expect(splitMinorSign('-0')).toEqual({ sign: 'zero', magnitude: '0' });
    expect(splitMinorSign('000')).toEqual({ sign: 'zero', magnitude: '000' });
    expect(splitMinorSign('1')).toEqual({ sign: 'positive', magnitude: '1' });
    expect(splitMinorSign('-1')).toEqual({ sign: 'negative', magnitude: '1' });
    expect(splitMinorSign('250000')).toEqual({ sign: 'positive', magnitude: '250000' });
    expect(splitMinorSign('-250000')).toEqual({ sign: 'negative', magnitude: '250000' });
  });

  it('keeps every digit beyond 2^53, where a JS number would round', () => {
    // 2^53 = 9007199254740992; 2^53 + 1 is the first integer a double cannot hold.
    expect(Number('9007199254740993')).toBe(9007199254740992);
    expect(splitMinorSign('9007199254740993')).toEqual({ sign: 'positive', magnitude: '9007199254740993' });
    expect(splitMinorSign('-9007199254740993')).toEqual({ sign: 'negative', magnitude: '9007199254740993' });
    expect(splitMinorSign('-9007199254740992')).toEqual({ sign: 'negative', magnitude: '9007199254740992' });
    expect(splitMinorSign('-123456789012345678901234567890')).toEqual({ sign: 'negative', magnitude: '123456789012345678901234567890' });
  });

  it('refuses anything that is not a minor-unit integer string, rather than guessing a sign', () => {
    for (const bad of ['', '-', '1.5', '-1.5', '+5', ' 5', '5 ', '--5', '5-', 'abc', '1e3', '١٢', '0x10']) {
      expect(splitMinorSign(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('the customer account view registry', () => {
  it('registers the account view with exactly the states the page can reach', () => {
    expect(entry().fixtures.map((f) => f.name)).toEqual(FIXTURES);
  });

  it('the fixtures carry the cases a money screen must survive', () => {
    expect(propsOf(F_HELD).receivable.baseMinor.startsWith('-'), 'a negative balance').toBe(true);
    expect(
      propsOf(F_HELD).openInvoices.some((i) => i.isCredit && i.outstandingTxnMinor.startsWith('-')),
      'a credit-bearing row',
    ).toBe(true);
    const multi = propsOf(F_MULTI).receivable;
    expect(new Set(multi.byCurrency.map((l) => l.currency)).size, 'two currencies').toBeGreaterThanOrEqual(2);
    expect(
      multi.byCurrency.some((l) => l.currency !== multi.baseCurrency),
      'one of them foreign',
    ).toBe(true);
    expect(propsOf(F_ZERO).receivable.baseMinor).toBe('0');
    expect(propsOf(F_ZERO).openInvoices).toEqual([]);
    const huge = propsOf(F_HUGE);
    const beyond = (s: string): boolean => BigInt(s.replace(/^-/, '')) > 2n ** 53n;
    expect(beyond(huge.receivable.baseMinor), 'a balance beyond 2^53').toBe(true);
    expect(
      huge.openInvoices.some((i) => beyond(i.outstandingTxnMinor)),
      'an invoice beyond 2^53',
    ).toBe(true);
    // The aging answers are the 0,30,60,90 set: five bands, in the server's tokens.
    for (const name of FIXTURES)
      expect(
        propsOf(name).aging.buckets.map((b) => b.label),
        name,
      ).toEqual(['not-due', '1-30', '31-60', '61-90', 'over-90']);
  });

  it('every fixture renders in ar, en and tr with no missing key', () => {
    for (const fixture of entry().fixtures) {
      for (const locale of LOCALES) expect(renderFixture(fixture, locale).missingKeys, `${fixture.name} ${locale}`).toEqual([]);
    }
  });

  it('adds keys the merchant-language guard accepts, the same in all three catalogues', () => {
    expect(findMerchantJargon({ ar: onlyNewKeys(ar), en: onlyNewKeys(en), tr: onlyNewKeys(tr) })).toEqual([]);
    const keysOf = (d: Record<string, string>) => Object.keys(onlyNewKeys(d)).sort();
    expect(keysOf(en).length).toBeGreaterThan(10);
    expect(keysOf(ar)).toEqual(keysOf(en));
    expect(keysOf(tr)).toEqual(keysOf(en));
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(tr).sort()).toEqual(Object.keys(en).sort());
  });

  it('adds no key a write, a collection or a credit limit would need', () => {
    for (const locale of LOCALES) {
      const entries = Object.entries(onlyNewKeys(CATALOGS[locale]));
      expect(
        entries.filter(([k]) => /\.(create|new|edit|save|add|collect|pay|limit)\b/i.test(k)).map(([k]) => k),
        locale,
      ).toEqual([]);
      expect(
        entries.filter(([, v]) => /limit|ceiling|سقف|حد ائتمان|limit/i.test(v)).map(([k]) => k),
        locale,
      ).toEqual([]);
    }
  });
});

describe('the figures are the server’s, verbatim', () => {
  it('every stated figure is shown, in every fixture and locale', () => {
    for (const name of FIXTURES) {
      for (const locale of LOCALES) {
        const runs = ltrRuns(render(name, locale));
        for (const figure of statedFigures(propsOf(name), locale)) expect(runs, `${name} [${locale}] shows ${figure}`).toContain(figure);
      }
    }
  });

  it('no figure is shown that the server did not state: no sum, no difference, no total across currencies', () => {
    for (const name of FIXTURES) {
      for (const locale of LOCALES) expect(inventedRuns(render(name, locale), propsOf(name), locale), `${name} [${locale}]`).toEqual([]);
    }
  });

  it('the invented-figure probe can fail: a planted cross-currency sum is caught', () => {
    const p = propsOf(F_MULTI);
    const r = render(F_MULTI);
    const [first, second] = p.receivable.byCurrency;
    if (!first || !second) throw new Error('the multi-currency fixture has fewer than two lines');
    // What a view that "helpfully" added the two lines would print.
    const planted = fm((BigInt(first.txnMinor) + BigInt(second.txnMinor)).toString(), p.receivable.baseCurrency, 'en');
    const withSum: Rendered = { ...r, frame: { ...r.frame, children: [...r.frame.children, plantedLtr(planted, r.frame)] } };
    expect(inventedRuns(withSum, p, 'en')).toEqual([planted]);
  });

  it('shows the base total as the server’s baseMinor in baseCurrency, and each currency on its own line', () => {
    const p = propsOf(F_MULTI);
    const runs = ltrRuns(render(F_MULTI));
    expect(runs).toContain(fm(p.receivable.baseMinor, p.receivable.baseCurrency, 'en'));
    for (const line of p.receivable.byCurrency) expect(runs).toContain(fm(line.txnMinor, line.currency, 'en'));
    expect(text(render(F_MULTI))).toContain(en['customers.account.owes.byCurrency']);
  });

  it('keeps every digit of an amount beyond 2^53', () => {
    const p = propsOf(F_HUGE);
    for (const locale of LOCALES) {
      const shown = fm(p.receivable.baseMinor, p.receivable.baseCurrency, locale);
      expect(shown.replace(/\D/g, ''), `${locale}: the formatter is exact`).toBe(p.receivable.baseMinor);
      expect(ltrRuns(render(F_HUGE, locale))).toContain(shown);
    }
  });

  it('the view does no arithmetic on money, and the probe can fail', () => {
    expect(arithmeticFindings(VIEW_SOURCE())).toEqual([]);
    expect(arithmeticFindings(PAGE_SOURCE())).toEqual([]);
    // Planted: the two defects the probe exists for.
    expect(arithmeticFindings('const n = Number(line.txnMinor);')).toEqual(['arithmetic: Number(']);
    expect(arithmeticFindings('const s = lines.reduce((a, l) => a + BigInt(l.txnMinor), 0n);').length).toBeGreaterThan(0);
    expect(arithmeticFindings('const d = invoice.totalTxnMinor - invoice.outstandingTxnMinor;')).toEqual(['an operator applied to a minor-unit field']);
    // And it is quiet on the real spelling of a figure.
    expect(arithmeticFindings('<Money amountMinor={line.txnMinor} currency={line.currency} locale={locale} />')).toEqual([]);
  });
});

describe('a negative balance is money held for the customer', () => {
  it('is worded as held money, with the magnitude, and never with a minus sign', () => {
    const p = propsOf(F_HELD);
    for (const locale of LOCALES) {
      const r = render(F_HELD, locale);
      const held = CATALOGS[locale]['customers.account.held'] as string;
      const [before] = held.split('{amount}');
      expect(text(r), locale).toContain((before ?? '').trim() || (held.split('{amount}')[1] ?? '').trim());
      expect(ltrRuns(r), locale).toContain(fm(p.receivable.baseMinor.slice(1), p.receivable.baseCurrency, locale));
      // Document numbers carry a hyphen by design ("INV-0021"); every other run is a figure, a date or a day count.
      const figures = ltrRuns(r).filter((run) => !p.openInvoices.some((i) => i.documentNumber === run));
      expect(figures.length, locale).toBeGreaterThan(3);
      expect(
        figures.some((run) => /^[-−‐]|[-−‐]\s?\d/.test(run)),
        `${locale}: no minus sign on a figure`,
      ).toBe(false);
      expect(text(r), locale).not.toContain(fm(p.receivable.baseMinor, p.receivable.baseCurrency, locale));
    }
  });

  it('never says the business owes the customer', () => {
    const OWE_THEM = /we owe|owed to the customer|نحن مدينون|ندين للعميل|مستحق للعميل|müşteriye borçluyuz|borçluyuz/i;
    for (const locale of LOCALES) {
      expect(text(render(F_HELD, locale)), locale).not.toMatch(OWE_THEM);
      for (const value of Object.values(onlyNewKeys(CATALOGS[locale]))) expect(value, locale).not.toMatch(OWE_THEM);
    }
  });

  it('a credit-bearing invoice reads as held money on an invoice of that age, never as late', () => {
    const p = propsOf(F_HELD);
    const credit = p.openInvoices.find((i) => i.isCredit);
    if (!credit) throw new Error('no credit row');
    const r = render(F_HELD);
    expect(text(r)).toContain(en['customers.account.invoices.heldOnInvoice'].split('{days}')[0]?.trim() ?? '');
    expect(ltrRuns(r)).toContain(String(credit.ageDays));
    expect(ltrRuns(r)).toContain(fm(credit.outstandingTxnMinor.slice(1), credit.currency, 'en'));
  });

  it('a positive balance and a zero balance are not worded as held money', () => {
    for (const name of [F_OWES, F_ZERO, F_HUGE]) {
      const held = en['customers.account.held'].replace('{amount}', '').trim();
      expect(text(render(name)), name).not.toContain(held);
    }
    expect(text(render(F_ZERO))).toContain(en['customers.account.owes.nothing']);
    expect(text(render(F_OWES))).not.toContain(en['customers.account.owes.nothing']);
  });
});

describe('two sources, two sentences (DR-114(b))', () => {
  it('a figure below zero (the receivable read) and the held-amounts section (the credits read) never share a sentence', () => {
    for (const locale of LOCALES) {
      const c = CATALOGS[locale];
      const below = (c['customers.account.held'] as string).replace('{amount}', '').trim();
      const section = c['customers.account.heldMoney.title'] as string;
      expect(below, locale).not.toEqual(section);
      expect(section.includes(below) || below.includes(section), `${locale}: one is not a part of the other`).toBe(false);
    }
    // F_HELD: below zero, nothing held. The figure is worded; the section is absent.
    expect(text(render(F_HELD))).toContain(en['customers.account.held'].replace('{amount}', '').trim());
    expect(text(render(F_HELD))).not.toContain(en['customers.account.heldMoney.title']);
  });

  it('the credit-bearing invoice row keeps DR-35’s shape: a balance, on an invoice N days old', () => {
    expect(ar['customers.account.invoices.heldOnInvoice']).toBe('رصيد للعميل على فاتورة عمرها {days} يومًا');
    expect(en['customers.account.invoices.heldOnInvoice']).toMatch(/^Balance .* on an invoice \{days\} days old$/);
    expect(tr['customers.account.invoices.heldOnInvoice']).toMatch(/bakiye/i);
  });
});

describe('money held for the customer comes from the held amounts, not from the sign of the balance', () => {
  const heading = (name: string, locale: Locale = 'en'): boolean =>
    text(render(name, locale)).includes(CATALOGS[locale]['customers.account.heldMoney.title'] as string);

  it('shows the held-money section exactly when a held amount has something left, or older ones may be missing', () => {
    for (const name of FIXTURES) expect(heading(name), name).toBe(heldCredits(propsOf(name)).length > 0 || propsOf(name).creditsCapped);
  });

  it('is not derived from the balance: a negative balance with nothing held has no section, a positive one with held money has it', () => {
    expect(propsOf(F_HELD).receivable.baseMinor.startsWith('-')).toBe(true);
    expect(heldCredits(propsOf(F_HELD))).toEqual([]);
    expect(heading(F_HELD)).toBe(false);
    expect(propsOf(F_MULTI).receivable.baseMinor.startsWith('-')).toBe(false);
    expect(heading(F_MULTI)).toBe(true);
    expect(PAGE_SOURCE() + VIEW_SOURCE()).not.toMatch(/heldMoney[\s\S]{0,120}baseMinor|baseMinor[\s\S]{0,120}heldMoney/);
  });

  it('shows each held amount on its own line, per currency, verbatim, never totalled', () => {
    const p = propsOf(F_MULTI);
    const currencies = new Set(heldCredits(p).map((c) => c.currencyCode));
    expect(currencies.size, 'held amounts in two currencies').toBeGreaterThanOrEqual(2);
    const runs = ltrRuns(render(F_MULTI));
    for (const c of heldCredits(p)) expect(runs).toContain(fm(c.remainingAmountMinor, c.currencyCode, 'en'));
  });

  it('an exhausted held amount ("0") is not listed, and is the only one left out', () => {
    const p = propsOf(F_OWES);
    expect(p.credits.some((c) => c.remainingAmountMinor === '0')).toBe(true);
    expect(heading(F_OWES)).toBe(false);
  });

  it('says so when the read returned as many held amounts as it ever returns, since older ones may be missing', () => {
    expect(propsOf(F_CAPPED).credits.length).toBe(200);
    expect(propsOf(F_CAPPED).creditsCapped).toBe(true);
    const capped = en['customers.account.heldMoney.capped'].replace('{count}', String(CREDITS_READ_CAP));
    expect(CREDITS_READ_CAP).toBe(200);
    expect(text(render(F_CAPPED))).toContain(capped);
    for (const name of FIXTURES.filter((n) => n !== F_CAPPED && n !== F_CAPPED_SPENT)) expect(text(render(name)), name).not.toContain(capped);
  });

  it('keeps that notice when the newest 200 are all used up: older ones with money left may exist (DR-114(b), no silent omission)', () => {
    const p = propsOf(F_CAPPED_SPENT);
    expect(p.credits.length).toBe(CREDITS_READ_CAP);
    expect(heldCredits(p), 'every returned held amount is used up').toEqual([]);
    expect(p.creditsCapped).toBe(true);
    for (const locale of LOCALES) {
      const capped = (CATALOGS[locale]['customers.account.heldMoney.capped'] as string).replace('{count}', String(CREDITS_READ_CAP));
      expect(text(render(F_CAPPED_SPENT, locale)), locale).toContain(capped);
    }
  });

  it('never renders a held amount’s id', () => {
    for (const name of FIXTURES) {
      const html = render(name).html;
      for (const c of propsOf(name).credits) expect(html, name).not.toContain(c.creditId);
    }
  });
});

describe('the open invoices and the age bands', () => {
  it('words the day count by its sign: late above zero, due today ON zero, not yet due below', () => {
    const p = propsOf(F_OWES);
    const shown = text(render(F_OWES));
    const days = p.openInvoices.filter((i) => !i.isCredit).map((i) => i.daysPastDue);
    // The fixture holds each side of the boundary and the boundary itself.
    expect(days).toEqual(expect.arrayContaining([45, 1, 0, -1]));
    expect(shown).toContain(en['customers.account.invoices.dueToday']);
    expect(shown).toContain(en['customers.account.invoices.notDueYet']);
    expect(ltrRuns(render(F_OWES))).toEqual(expect.arrayContaining(['45', '1']));
    // A day count of 0 or below is never printed as "N days late".
    expect(ltrRuns(render(F_OWES))).not.toContain('-1');
  });

  it('says "no due date" when the invoice states none, and shows the due date when it does', () => {
    const p = propsOf(F_OWES);
    expect(p.openInvoices.some((i) => i.dueDate === null && !i.hasExplicitDueDate)).toBe(true);
    expect(text(render(F_OWES))).toContain(en['customers.account.invoices.noDueDate']);
  });

  it('the first band holds rows due today, so it never says "not due" (it says "not late")', () => {
    const key = AGE_BAND_KEYS['not-due'] as string;
    expect(en[key as keyof typeof en]).not.toMatch(/not due/i);
    expect(ar[key as keyof typeof ar]).not.toMatch(/لم يحن/);
    expect(tr[key as keyof typeof tr]).not.toMatch(/vadesi/i);
    // And it is not the row sentence for a day count below zero either.
    for (const locale of LOCALES) expect(CATALOGS[locale][key], locale).not.toEqual(CATALOGS[locale]['customers.account.invoices.notDueYet']);
  });

  it('shows the five bands of the 0,30,60,90 set, including the empty ones, with the server’s own day bounds', () => {
    expect(Object.keys(AGE_BAND_KEYS)).toEqual(['not-due', '1-30', '31-60', '61-90', 'over-90']);
    for (const locale of LOCALES) {
      const r = render(F_ZERO, locale);
      const shown = text(r);
      expect(shown, locale).toContain(CATALOGS[locale][AGE_BAND_KEYS['not-due'] as string]);
      for (const bucket of propsOf(F_ZERO).aging.buckets.slice(1)) {
        const key = AGE_BAND_KEYS[bucket.label] as string;
        const sentence = (CATALOGS[locale][key] as string).replace('{from}', String(bucket.fromDays)).replace('{to}', String(bucket.toDays));
        expect(shown, `${locale} ${bucket.label}`).toContain(sentence);
      }
      // The bounds are the server's numbers, each isolated left-to-right: 1, 30, 31, 60, 61, 90, 91.
      expect(ltrRuns(r), locale).toEqual(expect.arrayContaining(['1', '30', '31', '60', '61', '90', '91']));
    }
  });

  it('shows the rows in the order the server gave them, never re-sorting', () => {
    const p = propsOf(F_OWES);
    const shown = text(render(F_OWES));
    const positions = p.openInvoices.map((i) => shown.indexOf(i.documentNumber));
    expect(positions.every((n) => n >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(VIEW_SOURCE()).not.toMatch(/\.sort\(|\.reverse\(|localeCompare/);
  });

  it('never renders an identifier', () => {
    for (const name of FIXTURES) {
      const html = render(name).html;
      for (const invoice of propsOf(name).openInvoices) expect(html, name).not.toContain(invoice.invoiceId);
    }
  });

  it('offers more only when the server gave a cursor, and shows the empty state when nothing is open', () => {
    expect(buttons(render(F_OWES))).toContain(en['common.loadMore']);
    expect(buttons(render(F_HELD))).not.toContain(en['common.loadMore']);
    expect(text(render(F_ZERO))).toContain(en['customers.account.invoices.empty']);
    expect(buttons(render(F_ZERO))).toEqual([]);
  });

  it('renders a refused "show more" from the catalogue, keeping the rows and the button', () => {
    expect(refusalKey(new ApiError(403, 'FORBIDDEN')), 'the key the page sets for a refused read').toBe(propsOf(F_REFUSED).errorKey);
    const r = render(F_REFUSED);
    expect(text(r)).toContain(en['error.FORBIDDEN']);
    expect(text(r)).not.toContain('FORBIDDEN');
    expect(buttons(r)).toContain(en['common.loadMore']);
    expect(propsOf(F_REFUSED).openInvoices.length).toBeGreaterThan(0);
  });

  it('has no write, collect or credit-limit affordance, and no table', () => {
    const source = VIEW_SOURCE();
    expect(source).not.toMatch(/TextField|<form|onSubmit|onCreate|onEdit|onCollect|onPay|<Table|<table/);
    expect(source).not.toMatch(/limit/i);
    expect(source, 'positive control: the one action the view has').toContain('onClick={props.onLoadMore}');
    for (const name of FIXTURES) expect(render(name).html, name).not.toContain('<table');
  });
});

describe('the page, its kit and its client', () => {
  it('checks the route id before any read, and renders not-found otherwise', () => {
    const page = PAGE_SOURCE();
    expect(page).toMatch(/if \(!isUuid\(customerId\)\) notFound\(\);/);
    expect(page.indexOf('isUuid(customerId)')).toBeLessThan(page.indexOf('getCustomerReceivable('));
    expect(read(...PAGE_DIR, 'page.tsx').startsWith("'use client'")).toBe(true);
  });

  it('reads the five answers, the dated ones at ONE as-of date, and the aging at the fixed 0,30,60,90 set', () => {
    const page = PAGE_SOURCE();
    for (const call of [
      'getCustomer(customerId)',
      'getCustomerReceivable(customerId)',
      'getCustomerAging(customerId, asOf)',
      'listCustomerOpenInvoices(customerId, { asOf',
      'listCustomerCredits(customerId)',
    ])
      expect(page, call).toContain(call);
    expect(ACCOUNT_AGING_BUCKET_DAYS).toBe('0,30,60,90');
    expect(LIB_SOURCE()).toContain('bucketDays: ACCOUNT_AGING_BUCKET_DAYS');
    expect(LIB_SOURCE()).not.toMatch(/bucketDays: (?!ACCOUNT_AGING_BUCKET_DAYS)/);
  });

  it('renders ScreenState for every phase but ready, and treats an unreadable answer as a failed load', () => {
    const page = PAGE_SOURCE();
    expect(page).toMatch(/phase !== 'ready' \|\| account === null \?\s*\(\s*<ScreenState/);
    expect(page).toContain('unreadableAccount(');
    expect(page).toMatch(/if \(phase === 'missing'\) notFound\(\);/);
  });

  it('the fixtures are the props the page passes: same names, nothing the page does not set', () => {
    const page = PAGE_SOURCE();
    const tag = /<CustomerAccountView\s([\s\S]*?)\/>/.exec(page)?.[1] ?? '';
    const passed = [...tag.matchAll(/(\w+)=\{/g)].map((m) => m[1]).sort();
    const fixtureKeys = [...new Set(entry().fixtures.flatMap((f) => Object.keys(f.props as object)))].concat(['t', 'locale']).sort();
    expect(passed.length).toBeGreaterThan(5);
    expect(passed).toEqual(fixtureKeys);
  });

  it('the refused "show more" fixture is what the page does: its catch keeps the cursor', () => {
    const findings = (page: string): string[] => {
      const body = /async function loadMore\(\)[\s\S]*?try \{([\s\S]*?)\} catch \(error\) \{([\s\S]*?)\} finally/.exec(page);
      if (!body) return ['loadMore with try/catch/finally not found'];
      const out: string[] = [];
      if (!(body[1] ?? '').includes('setCursor(')) out.push('the try block does not advance the cursor');
      if (!(body[2] ?? '').includes('setErrorKey(refusalKey(error))')) out.push('the catch does not set the refusal');
      if ((body[2] ?? '').includes('setCursor(')) out.push('the catch touches the cursor');
      return out;
    };
    expect(findings(PAGE_SOURCE())).toEqual([]);
    const planted = PAGE_SOURCE().replace('setErrorKey(refusalKey(error));', 'setErrorKey(refusalKey(error)); setCursor(null);');
    expect(planted).not.toEqual(PAGE_SOURCE());
    expect(findings(planted)).toEqual(['the catch touches the cursor']);
  });

  it('refuses an answer it cannot place, naming what is wrong, and passes a readable one', () => {
    for (const name of FIXTURES) {
      const p = propsOf(name);
      expect(
        unreadableAccount(
          { receivable: p.receivable, aging: p.aging, openInvoices: p.openInvoices, openInvoicesAsOf: p.aging.asOf, credits: p.credits },
          p.aging.asOf,
        ),
        name,
      ).toEqual([]);
    }
    const p = propsOf(F_MULTI);
    const good = { receivable: p.receivable, aging: p.aging, openInvoices: p.openInvoices, openInvoicesAsOf: p.aging.asOf, credits: p.credits };
    expect(unreadableAccount({ ...good, credits: p.credits.map((c, n) => (n === 1 ? { ...c, remainingAmountMinor: '-5' } : c)) }, p.aging.asOf)).toEqual([
      'credits[1].remainingAmountMinor',
    ]);
    expect(unreadableAccount({ ...good, receivable: { ...p.receivable, baseMinor: '12.50' } }, p.aging.asOf)).toEqual(['receivable.baseMinor']);
    expect(unreadableAccount({ ...good, receivable: { ...p.receivable, byCurrency: [{ currency: 'USD', txnMinor: '1e9' }] } }, p.aging.asOf)).toEqual([
      'receivable.byCurrency[0].txnMinor',
    ]);
    const relabelled = { ...p.aging, buckets: p.aging.buckets.map((b, i) => (i === 4 ? { ...b, label: 'over-120' } : b)) };
    expect(unreadableAccount({ ...good, aging: relabelled }, p.aging.asOf)).toEqual(['aging.buckets[4].label']);
    expect(unreadableAccount({ ...good, aging: { ...p.aging, buckets: p.aging.buckets.slice(0, 4) } }, p.aging.asOf)).toEqual(['aging.buckets']);
    const unbounded = { ...p.aging, buckets: p.aging.buckets.map((b, i) => (i === 2 ? { ...b, toDays: null } : i === 4 ? { ...b, fromDays: null } : b)) };
    expect(unreadableAccount({ ...good, aging: unbounded }, p.aging.asOf)).toEqual(['aging.buckets[2].days', 'aging.buckets[4].days']);
    expect(unreadableAccount(good, '2026-11-12')).toEqual(['aging.asOf', 'openInvoices.asOf']);
    expect(unreadableAccount({ ...good, openInvoicesAsOf: '2026-11-12' }, p.aging.asOf)).toEqual(['openInvoices.asOf']);
    const badRow = p.openInvoices.map((i, n) => (n === 0 ? { ...i, outstandingTxnMinor: String(Number.MAX_SAFE_INTEGER + 2) + '.0' } : i));
    expect(unreadableAccount({ ...good, openInvoices: badRow }, p.aging.asOf)).toEqual(['openInvoices[0].outstandingTxnMinor']);
  });

  it('the client reads five routes through the BFF, with no /v1, no write and no other route', () => {
    const lib = LIB_SOURCE();
    expect(lib).toContain("cache: 'no-store'");
    expect(lib).not.toMatch(/\/v1\b/);
    expect(lib).not.toMatch(/method\s*:|POST|PUT|DELETE|PATCH/);
    expect([...lib.matchAll(/\$\{BFF\}(\/customers[^`]*)/g)].map((m) => m[1])).toEqual([
      '/customers/${encodeURIComponent(id)}',
      '/customers/${encodeURIComponent(id)}/receivable',
      '/customers/${encodeURIComponent(id)}/receivable/aging${qs({ asOf, bucketDays: ACCOUNT_AGING_BUCKET_DAYS })}',
      '/customers/${encodeURIComponent(id)}/open-invoices${qs({ ...q })}',
      '/customers/${encodeURIComponent(id)}/credits',
    ]);
  });

  it('the kit reads the as-of date once, as the merchant’s calendar day, and names no clock elsewhere', () => {
    expect(KIT_SOURCE()).toContain('localDateIso()');
    expect(PAGE_SOURCE()).not.toMatch(/new Date\(|Date\.now\(/);
    expect(VIEW_SOURCE()).not.toMatch(/new Date\(|Date\.now\(|localDateIso/);
  });
});

/** A synthetic `<bdi dir="ltr">` run, for the planted-sum proof. */
function plantedLtr(content: string, parent: Rendered['frame']): Rendered['frame'] {
  const node = { kind: 'element' as const, tag: 'bdi', attrs: { dir: 'ltr' }, children: [] as Rendered['frame']['children'], parent };
  node.children.push({ kind: 'text', text: content, parent: node });
  return node;
}
