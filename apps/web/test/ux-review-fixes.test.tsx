import { describe, expect, it } from 'vitest';
import { formatDecimalText } from '@/lib/phase3-format';
import { translate, type Locale } from '@/lib/i18n';
import ar from '@/messages/ar.json';
import en from '@/messages/en.json';
import trCatalog from '@/messages/tr.json';
import type { ViewEntry, ViewFixture } from '@/lib/phase3-format';
import { VIEW_REGISTRY as COMMON } from '@/views/common/registry';
import { VIEW_REGISTRY as PURCHASES } from '@/views/purchases/registry';
import { VIEW_REGISTRY as STOCK } from '@/views/stock/registry';
import { VIEW_REGISTRY as SUPPLIERS } from '@/views/suppliers/registry';
import { elements, LOCALES, renderFixture, styleOf, textOf, type ElementNode, type Rendered } from './helpers/render';

/**
 * The fixes of the P3-S7 UX, localization and simplicity review (and the web
 * items of the security review), each on the registry fixtures the SSR suites
 * already render: one describe per finding id.
 */
const catalogs: Readonly<Record<Locale, Readonly<Record<string, string>>>> = { ar, en, tr: trCatalog };
const AREAS: readonly ViewEntry[] = [...PURCHASES, ...SUPPLIERS, ...STOCK, ...COMMON];

function fixture(view: string, name: string): ViewFixture {
  const found = AREAS.find((e) => e.name === view)?.fixtures.find((f) => f.name === name);
  if (!found) throw new Error(`no fixture ${view} / ${name}`);
  return found;
}
const render = (view: string, name: string, locale: Locale = 'en'): Rendered => renderFixture(fixture(view, name), locale);
const all = (r: Rendered, tag: string): ElementNode[] => [...elements(r.frame)].filter((e) => e.tag === tag);
const text = (r: Rendered): string => textOf(r.frame);
const tr = (locale: Locale, key: string, vars?: Record<string, string>) => translate(locale, key, vars);

describe('M-1 — the purchase list filter never scrolls sideways', () => {
  it('is a select with the four filters, not a tab strip, in every locale', () => {
    for (const locale of LOCALES) {
      const r = render('PurchaseListView', 'mixed statuses, more to load', locale);
      expect([...elements(r.frame)].some((e) => e.attrs['role'] === 'tablist')).toBe(false);
      const options = all(r, 'option').map(textOf);
      for (const f of ['all', 'draft', 'received', 'cancelled']) expect(options).toContain(tr(locale, `purchasing.list.filter.${f}`));
    }
  });
});

describe('M-3 — a badge is one flex item, so the space beside its number survives', () => {
  it('every badge of every stock fixture has a single child', () => {
    const crowded: string[] = [];
    for (const entry of STOCK) {
      for (const f of entry.fixtures) {
        for (const locale of LOCALES) {
          for (const el of elements(renderFixture(f, locale).frame)) {
            const style = styleOf(el);
            if (el.tag === 'span' && style['display'] === 'inline-flex' && style['border-radius'] === '9999px' && el.children.length > 1) {
              crowded.push(`${entry.name}/${f.name} [${locale}] ${textOf(el)}`);
            }
          }
        }
      }
    }
    expect(crowded).toEqual([]);
  });

  it('"Short by" and "more / fewer than expected" keep their space', () => {
    expect(text(render('StockLevelsView', 'rows in stock, out of stock, short, with options and stock from before options'))).toMatch(/Short by \d/);
    expect(text(render('CountSheetView', 'finished: how each line compared'))).toMatch(/\d (more|fewer) than expected/);
  });
});

describe('M-4 — a unit price and a rate in the locale’s separators', () => {
  it('re-spells decimal text without arithmetic', () => {
    expect(formatDecimalText('3.200', 'tr', 2)).toBe('3,20');
    expect(formatDecimalText('3200', 'tr', 2)).toBe('3.200,00');
    expect(formatDecimalText('0.709', 'tr')).toBe('0,709');
    expect(formatDecimalText('1.2500000000', 'en')).toBe('1.25');
    expect(formatDecimalText('12.345', 'en', 2)).toBe('12.345');
    expect(formatDecimalText('abc', 'en')).toBe('abc');
  });

  it('Turkish never shows the raw "3.200 USD" price or the raw rate', () => {
    const review = render('ReceivePurchaseView', 'review, paid now in the purchase currency', 'tr');
    expect(text(review)).toContain('3,20 USD');
    expect(text(review)).not.toContain('3.200 USD');
    const done = render('ReceivePurchaseView', 'received and paid, foreign, covered short stock', 'tr');
    expect(text(done)).toContain('0,709 JOD');
    const detail = render('PurchaseDetailView', 'received, part paid, returns and settlements', 'tr');
    expect(text(detail)).not.toContain('3.200 USD');
    expect(text(detail)).toMatch(/0,709/);
  });
});

describe('N-6 — merchant-typed supplier names are isolated', () => {
  it.each([
    ['PurchaseListView', 'mixed statuses, more to load'],
    ['PurchaseDetailView', 'received, part paid, returns and settlements'],
    ['ReturnToSupplierView', 'quantities, one invalid'],
    ['SupplierListView', 'business-wide, with balances'],
    ['SupplierDetailView', 'business-wide, owes and in your favour'],
    ['PaySupplierView', 'proposal, other-currency purchase not paid'],
  ])('%s wraps the supplier name in <bdi>', (view, name) => {
    const r = render(view, name);
    expect(all(r, 'bdi').some((b) => b.attrs['dir'] === undefined && textOf(b) === 'Al-Noor Trading')).toBe(true);
  });
});

describe('catalog wording (M-6, M-7, m-11, m-13, m-14, m-15)', () => {
  const values = (locale: Locale): string[] => Object.values(catalogs[locale]);

  it('M-6: Arabic uses one word for "item" — the glossary’s «منتج», never «صنف»', () => {
    expect(values('ar').filter((v) => /صنف|أصناف/.test(v))).toEqual([]);
    expect(tr('ar', 'purchasing.receive.addLine')).toBe('إضافة منتج آخر');
  });

  it('M-7: the Arabic and Turkish return result say the balance is in your favour', () => {
    expect(tr('ar', 'purchasing.return.supplierOwesYou')).toBe('أصبح لك عند المورّد {amount}.');
    expect(tr('tr', 'purchasing.return.supplierOwesYou')).toBe('Lehinize {amount} bakiye oluştu.');
  });

  it('m-11: Turkish spells stok with ğ before a vowel suffix', () => {
    expect(values('tr').filter((v) => /(^|[^a-zçğıöşü])[Ss]tok(u|unu|unuz)(?![a-zçğıöşü])/.test(v))).toEqual([]);
  });

  it('m-14: the supplier and purchase balances use the glossary’s "outstanding balance"', () => {
    for (const locale of LOCALES) expect(tr(locale, 'suppliers.balance.youOwe')).toBe(tr(locale, 'purchasing.detail.stillToPay'));
    expect(tr('ar', 'suppliers.balance.youOwe')).toBe('الرصيد المستحق');
    expect(tr('tr', 'suppliers.balance.youOwe')).toBe('Kalan bakiye');
  });

  it('m-15: Arabic purchase statuses agree with the masculine «مشترى»', () => {
    expect(tr('ar', 'purchasing.status.received')).toBe('مُستلَم');
    expect(tr('ar', 'purchasing.status.cancelled')).toBe('ملغى');
    expect(tr('ar', 'purchasing.list.filter.draft')).toBe('لم يُستلَم بعد');
  });

  it('m-13: the covered-stock line trims the fraction and names the purchase', () => {
    const r = render('ReceivePurchaseView', 'received and paid, foreign, covered short stock', 'ar');
    expect(text(r)).toContain('غطّى هذا المشترى');
    expect(formatDecimalText('2.5000', 'tr')).toBe('2,5');
  });
});
