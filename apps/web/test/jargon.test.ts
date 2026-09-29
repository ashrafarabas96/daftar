import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ar from '@/messages/ar.json';
import en from '@/messages/en.json';
import tr from '@/messages/tr.json';
import { MERCHANT_JARGON, findMerchantJargon, findS7SourceViolations, isS7Key, isS7WebFile } from '../../../scripts/guards/merchant-jargon';
import { REPO_ROOT } from './helpers/refusal-codes';

/**
 * T-09 (P3-S7 contract §6, §7.2(a); MP-2): no accounting or engine term in a
 * merchant-facing string, and no merchant text that bypasses the catalog.
 * The rules are `scripts/guards/merchant-jargon.ts`, the same module the
 * gate's `check:localization` pass runs.
 */
describe('T-09 — the catalog half', () => {
  it('the shipped catalogs have no denied term in any S7 namespace', () => {
    expect(findMerchantJargon({ ar, en, tr })).toEqual([]);
  });

  it('fails on a planted term: "stock.x": "Journal"', () => {
    const hits = findMerchantJargon({ en: { 'stock.x': 'Journal' } });
    expect(hits).toEqual([{ locale: 'en', key: 'stock.x', term: 'journal', value: 'Journal' }]);
  });

  it('catches the inflected forms each language uses, and not ordinary words that merely share letters', () => {
    const one = (locale: 'ar' | 'en' | 'tr', value: string) => findMerchantJargon({ [locale]: { 'suppliers.x': value } }).map((h) => h.term);
    expect(one('en', 'Your accounts are ready')).toEqual(['account']);
    expect(one('en', 'The supplier credited you')).toEqual(['credit']);
    expect(one('en', 'Short by 3')).toEqual([]);
    expect(one('en', 'Stock sequence 12')).toEqual(['stock sequence']);
    expect(one('ar', 'راجع حسابك')).toEqual(['حساب']);
    expect(one('ar', 'والحساب')).toEqual(['حساب']);
    expect(one('ar', 'في المدينة')).toEqual([]);
    expect(one('ar', 'حسب المتوسط المرجح')).toEqual(['المتوسط المرجح']);
    expect(one('tr', 'Yevmiyede görünür')).toEqual(['yevmiye']);
    expect(one('tr', 'Borç kaydı oluşturuldu')).toEqual(['borç kaydı']);
    expect(one('tr', 'Kalan bakiye')).toEqual([]);
  });

  it('judges only the S7 namespaces: accounting.* is the accountant chart and is excluded', () => {
    expect(isS7Key('accounting.account.accounts_payable')).toBe(false);
    expect(findMerchantJargon({ en: { 'accounting.account.accounts_payable': 'Accounts Payable' } })).toEqual([]);
    for (const key of ['nav.stock', 'stock.title', 'purchasing.receive', 'suppliers.list', 'payments.method', 'error.fallback', 'common.done']) {
      expect(isS7Key(key), key).toBe(true);
    }
    expect(isS7Key('nav.dashboard')).toBe(false);
  });

  it('every locale has a denylist, and no S7 value in the shipped catalogs trips the English list through a translation left in English', () => {
    for (const locale of ['ar', 'en', 'tr'] as const) expect(MERCHANT_JARGON[locale].length).toBeGreaterThan(5);
    const leaked = findMerchantJargon({ en: Object.fromEntries(Object.entries({ ...ar, ...tr }).filter(([k]) => isS7Key(k))) });
    expect(leaked).toEqual([]);
  });
});

describe('T-09 — the S7 web source half', () => {
  const S7 = 'apps/web/src/views/stock/Probe.tsx';

  it('flags a JSX text literal, but not t() output, <bdi> data or punctuation', () => {
    const hits = findS7SourceViolations({
      [S7]: `export const A = ({ t }) => (<div><span>Stock level</span><b>{t('stock.title')}</b><bdi dir="ltr">USD</bdi><i> · </i></div>);`,
    });
    expect(hits.map((h) => [h.rule, h.evidence])).toEqual([['JSX text literal outside t()', 'Stock level']]);
  });

  it('flags a rendered server message or refusal code, but not a comparison', () => {
    const hits = findS7SourceViolations({
      [S7]: `export const B = ({ error }) => <p>{error.message}{error.code}{error.code === 'X' ? 1 : 2}</p>;`,
    });
    expect(hits.map((h) => h.evidence)).toEqual(['.message', 'error.code']);
  });

  it('flags an accounting.* key on a merchant screen', () => {
    const hits = findS7SourceViolations({ [S7]: `export const C = ({ t }) => <p>{t('accounting.account.cash')}</p>;` });
    expect(hits.map((h) => h.rule)).toEqual(['accounting.* key used on a merchant screen']);
  });

  it('judges only S7 web files', () => {
    expect(isS7WebFile('apps/web/src/app/[locale]/stock/move/page.tsx')).toBe(true);
    expect(isS7WebFile('apps/web/src/app/[locale]/purchases/[purchaseId]/return/page.tsx')).toBe(true);
    expect(isS7WebFile('apps/web/src/views/common/Money.tsx')).toBe(true);
    expect(isS7WebFile('apps/web/src/lib/phase3-api.ts')).toBe(true);
    expect(isS7WebFile('apps/web/src/app/[locale]/catalog/page.tsx')).toBe(false);
    expect(isS7WebFile('apps/web/src/lib/merchant-api.ts')).toBe(false);
    expect(findS7SourceViolations({ 'apps/web/src/app/[locale]/team/page.tsx': '<span>Team</span>' })).toEqual([]);
  });

  it('the shipped S7 web files are clean', () => {
    const files: Record<string, string> = {};
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry)) files[relative(REPO_ROOT, full).split('\\').join('/')] = readFileSync(full, 'utf8');
      }
    };
    walk(join(REPO_ROOT, 'apps', 'web', 'src'));
    expect(Object.keys(files).filter(isS7WebFile).length).toBeGreaterThanOrEqual(3);
    expect(findS7SourceViolations(files)).toEqual([]);
  });
});
