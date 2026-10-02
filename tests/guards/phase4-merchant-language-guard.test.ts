/**
 * P4-S1 red proofs — Class III, merchant language and the OD-03 tax boundary
 * (lock P4-AL-52, P4-AL-50, P4-AL-44; plan P4-S1 action 3).
 *
 * Two guards, one rule: the merchant never reads an accounting or engine term,
 * and while `OD-03` is open sales tax is structurally zero, so no merchant
 * screen renders a tax field at all.
 *
 *   · `scripts/guards/merchant-jargon.ts` is the static half, run by
 *     `npm run check:localization` and `apps/web/test/jargon.test.ts`. Its scope
 *     was `(stock|purchases|suppliers)`, so a `pos/` or `customers/` file was
 *     never examined.
 *   · `tests/browser/invariants.ts` is the in-page half, run by
 *     `npm run gate:browser`. Its `jargon` and `tax-control` rules are now ONE
 *     program (`LANGUAGE_RULES`), which this file drives directly with planted
 *     text and planted field descriptors — the identical program the browser
 *     runs, with no browser and no stack, so the proof is cheap enough to keep.
 *
 * The green half of every proof is that no Phase 3 verdict moves, asserted here
 * against the real catalogs and the real web tree rather than asserted in prose.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MERCHANT_ROUTE_SEGMENTS,
  S7_NAMESPACE_PREFIXES,
  S7_NAV_KEYS,
  TAX_WORD,
  findMerchantJargon,
  findS7SourceViolations,
  isS7Key,
  isS7WebFile,
  type CatalogLocale,
} from '../../scripts/guards/merchant-jargon';
import {
  ACCT_JARGON_RE,
  TAX_WORD_RE,
  collectLanguageInput,
  languageIssues,
  languageIssuesForDocument,
  type ElementView,
  type FieldDescriptor,
} from '../../tests/browser/invariants';
import { deliveredFiles } from '../helpers/delivered-files';

const ROOT = join(__dirname, '../..');
const catalog = (locale: CatalogLocale): Record<string, string> =>
  JSON.parse(readFileSync(join(ROOT, 'apps/web/src/messages', `${locale}.json`), 'utf8')) as Record<string, string>;
const catalogs = (): Record<CatalogLocale, Record<string, string>> => ({ ar: catalog('ar'), en: catalog('en'), tr: catalog('tr') });

const webFiles = (): Record<string, string> => {
  const out: Record<string, string> = {};
  // The tree's own inventory, never a bare `git` call: the release gate runs
  // from an extracted archive with no `.git` (A-11, archive-portability).
  for (const f of deliveredFiles(ROOT)) {
    if (f.startsWith('apps/web/src/') && /\.tsx?$/.test(f)) out[f] = readFileSync(join(ROOT, f), 'utf8');
  }
  return out;
};

const PHASE4_KEY_PREFIXES = ['pos.', 'sales.', 'customers.', 'invoices.', 'refunds.', 'installments.', 'debts.'];
const PHASE4_SEGMENTS = ['pos', 'sales', 'customers', 'invoices', 'payments', 'refunds', 'installments', 'debts'];

// ───────────────────────────────────────────────────────────────────────────
describe('P4-S1 action 3a — the jargon guard examines the Phase 4 namespaces (P4-AL-52)', () => {
  it('a Phase 4 web file is examined at all: the scope was the whole defect', () => {
    for (const segment of PHASE4_SEGMENTS) {
      expect(isS7WebFile(`apps/web/src/app/[locale]/${segment}/page.tsx`), segment).toBe(true);
      // A Next.js route group in front changes nothing.
      expect(isS7WebFile(`apps/web/src/app/[locale]/(sell)/${segment}/new/page.tsx`), `(sell)/${segment}`).toBe(true);
    }
    expect(isS7WebFile('apps/web/src/lib/phase4-api.ts')).toBe(true);
    // Phase 3's own scope is untouched.
    for (const segment of ['stock', 'purchases', 'suppliers']) expect(isS7WebFile(`apps/web/src/app/[locale]/${segment}/page.tsx`), segment).toBe(true);
    expect(isS7WebFile('apps/web/src/lib/phase3-api.ts')).toBe(true);
    // Still not a merchant screen.
    expect(isS7WebFile('apps/web/src/app/[locale]/login/page.tsx')).toBe(false);
    expect(isS7WebFile('scripts/guards/merchant-jargon.ts')).toBe(false);
    for (const segment of PHASE4_SEGMENTS) expect(MERCHANT_ROUTE_SEGMENTS, segment).toContain(segment);
  });

  it('PLANTED: a denied term in a Phase 4 catalog value is refused, in each locale, naming the term', () => {
    const planted = {
      en: { 'invoices.title': 'Customer ledger', 'pos.total': 'Total' },
      ar: { 'customers.statement': 'كشف حساب العميل' },
      tr: { 'debts.header': 'Yevmiye defteri' },
    };
    const hits = findMerchantJargon(planted);
    expect(hits.map((h) => `${h.locale}:${h.key}:${h.term}`).sort()).toEqual([
      'ar:customers.statement:حساب',
      'en:invoices.title:ledger',
      'tr:debts.header:yevmiye',
    ]);
    // P4-AL-50's own example: the glossary's "كشف حساب" for a customer statement.
    expect(hits.some((h) => h.key === 'customers.statement' && h.term === 'حساب')).toBe(true);
  });

  it('PLANTED: a Phase 4 screen that renders a literal, a server message or an accounting key is refused', () => {
    const file = 'apps/web/src/app/[locale]/pos/page.tsx';
    const hits = findS7SourceViolations({
      [file]: [
        'export default function Pos() {',
        '  return <div><span>Outstanding balance</span><p>{error.message}</p>{t("accounting.account.accounts_receivable")}</div>;',
        '}',
      ].join('\n'),
    });
    expect(hits.map((h) => h.rule).sort()).toEqual([
      'JSX text literal outside t()',
      'accounting.* key used on a merchant screen',
      'server message or refusal code rendered',
    ]);
    expect(hits.find((h) => h.rule === 'JSX text literal outside t()')?.evidence).toBe('Outstanding balance');
  });

  it('PLANTED: a tax field on a merchant screen is refused while OD-03 is open (P4-AL-44)', () => {
    const file = 'apps/web/src/app/[locale]/invoices/new/page.tsx';
    for (const [line, word] of [
      ['  return <input name="taxMinor" aria-label={t("invoices.taxLabel")} />;', 'tax'],
      ['  return <th>{t("invoices.vatColumn")}</th>;', 'vat'],
      ['  return <label>{t("invoices.kdvOrani")}</label>;', 'kdv'],
      ['  return <output aria-label="الضريبة" />;', 'ضريب'],
    ] as const) {
      const hits = findS7SourceViolations({ [file]: `export default function New() {\n${line}\n}` }).filter(
        (h) => h.rule === 'tax word on a merchant screen while OD-03 is open',
      );
      expect(hits.length, line).toBeGreaterThan(0);
      expect(hits[0]?.evidence.toLowerCase(), line).toContain(word.toLowerCase());
      expect(hits[0]?.file).toBe(file);
    }
    // The word in a comment is not a rendered field: `stripTsComments` removed it.
    expect(findS7SourceViolations({ [file]: '// BLOCKED BY OD-03: no tax field exists here.\nexport const x = 1;\n' })).toEqual([]);
    // The boundary is a token START, not a word: `taxMinor` and `salesTax` are
    // matched, and the `vat` inside "Reactivate" is not.
    for (const named of ['taxMinor', 'tax_minor', 'invoices.taxLabel', 'vatColumn', 'kdvOrani', 'salesTax', 'Vergiler', 'الضريبة'])
      expect(new RegExp(TAX_WORD.source, 'u').test(named), named).toBe(true);
    for (const innocent of ['Reactivate', 'Reactivate the supplier or choose another', 'activate', 'private', 'innovation'])
      expect(new RegExp(TAX_WORD.source, 'u').test(innocent), innocent).toBe(false);
  });

  it('GREEN HALF — no Phase 3 verdict moved, and every Phase 4 file the widened scope now reaches is clean', () => {
    const files = webFiles();
    const examined = Object.keys(files).filter(isS7WebFile);
    expect(examined.length).toBeGreaterThan(40);
    // P4-S1 wrote this assertion as "the widened scope matches the empty set
    // today", which was true while no Phase 4 screen existed. P4-S3 ships the
    // POS screens, so the emptiness claim is RE-EXPRESSED, not relaxed: the
    // widened scope must now actually REACH them — a Phase 4 screen that the
    // jargon guard never examined was the whole defect P4-AL-52 corrected —
    // and they must be clean under the widened rule set.
    const phase4 = examined.filter((f) => PHASE4_SEGMENTS.some((s) => f.includes(`/${s}/`)) || /phase4-/.test(f));
    expect(phase4.length).toBeGreaterThan(0);
    for (const f of phase4) expect(isS7WebFile(f), f).toBe(true);
    // The real tree, Phase 3 and Phase 4 alike, is clean under the widened
    // rule set, the new tax rule included.
    expect(findS7SourceViolations(files)).toEqual([]);
    // Every catalog key under a Phase 4 prefix is examined by the key scope
    // (the same correction: a Phase 4 namespace the jargon rules skipped).
    const phase4Keys = Object.keys(catalogs().en).filter((key) => PHASE4_KEY_PREFIXES.some((p) => key.startsWith(p)));
    expect(phase4Keys.length).toBeGreaterThan(0);
    for (const key of phase4Keys) expect(isS7Key(key), key).toBe(true);
    // …and the three catalogs carry no merchant jargon, Phase 4 keys included.
    expect(findMerchantJargon(catalogs())).toEqual([]);
    // The Phase 3 scope is a subset of the new one: nothing was dropped.
    for (const p of ['stock.', 'purchasing.', 'suppliers.', 'payments.', 'error.', 'common.']) expect(S7_NAMESPACE_PREFIXES).toContain(p);
    for (const k of ['nav.stock', 'nav.purchases', 'nav.suppliers']) expect(S7_NAV_KEYS).toContain(k);
    expect(isS7Key('nav.customers')).toBe(true);
    expect(isS7Key('accounting.account.accounts_receivable')).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("P4-S1 action 3b — the browser gate's jargon and tax rules reach a Phase 4 screen (P4-AL-52)", () => {
  const desc = (tag: string, s: string): FieldDescriptor => ({ tag, desc: s });

  /** One planted element, with the attribute surface `COLLECT_LANGUAGE_INPUT` reads. */
  const element = (tag: string, attrs: Record<string, string>): ElementView & { attrs: Record<string, string> } => ({
    tagName: tag.toUpperCase(),
    id: attrs['id'] ?? '',
    textContent: attrs['textContent'] ?? null,
    getAttribute: (name) => attrs[name] ?? null,
    attrs,
  });

  /**
   * A document view over planted elements, matching the simple selectors the
   * collection program uses: a bare tag, `[attr]` and `[role=value]`.
   */
  const view = (bodyText: string, elements: readonly (ElementView & { attrs: Record<string, string> })[]) => ({
    bodyText,
    querySelectorAll: (selector: string) =>
      elements.filter((el) =>
        selector.split(',').some((raw) => {
          const part = raw.trim();
          if (part.startsWith('[role=')) return el.attrs['role'] === part.slice('[role='.length, -1);
          if (part.startsWith('[')) return el.getAttribute(part.slice(1, -1)) !== null;
          return part.toUpperCase() === el.tagName;
        }),
      ),
  });

  it('PLANTED: a tax field on a Phase 4 screen is reported as `tax-control`, whatever element carries it', () => {
    for (const d of [
      desc('input', 'taxMinor  Tax  '),
      desc('output', '  invoice-tax   Tax due '),
      desc('th', '   VAT '),
      desc('label', '   KDV oranı'),
      desc('dt', '    الضريبة'),
      desc('select', 'vergiOrani   '),
    ]) {
      const issues = languageIssues('', [d]);
      expect(
        issues.map((i) => i.kind),
        d.desc,
      ).toContain('tax-control');
      expect(issues.find((i) => i.kind === 'tax-control')?.detail, d.desc).toContain(d.tag);
    }
  });

  it('PLANTED: an accounting or tax WORD anywhere in a Phase 4 screen is reported as `jargon`', () => {
    for (const [text, word] of [
      ['Invoice #1044\nOutstanding: 120.00\nTax: 0.00', 'Tax: 0.00'],
      ['Customer ledger', 'Customer ledger'],
      ['الذمم المدينة', 'الذمم المدينة'],
      ['Yevmiye defteri', 'Yevmiye defteri'],
      ['Accounts Receivable', 'Accounts Receivable'],
    ] as const) {
      const issues = languageIssues(text, []);
      expect(
        issues.map((i) => i.kind),
        text,
      ).toContain('jargon');
      expect(issues.find((i) => i.kind === 'jargon')?.detail, text).toContain(word);
    }
  });

  it('PLANTED: a tax field named ONLY in an aria-label or a placeholder is caught — the widening of WHERE the rules look', () => {
    // `innerText` never shows an attribute, so an attribute-only tax field was
    // invisible to `jargon`; and outside the seven Phase 3 selectors it was
    // invisible to `tax-control` too. Both halves are driven here through the
    // page's own collection program over planted elements.
    for (const el of [
      element('output', { 'aria-label': 'Tax total' }),
      element('th', { textContent: 'VAT' }),
      element('dt', { textContent: 'الضريبة' }),
      element('legend', { textContent: 'KDV' }),
      element('input', { placeholder: 'Tax rate' }),
      element('input', { title: 'vergi' }),
      element('div', { role: 'spinbutton', 'aria-label': 'Tax' }),
      element('div', { role: 'columnheader', textContent: 'Tax' }),
      element('optgroup', { label: 'Tax' }),
    ]) {
      const kinds = languageIssuesForDocument(view('Invoice #1044', [el])).map((i) => i.kind);
      expect(kinds, `${el.tagName} ${JSON.stringify(el.attrs)}`).toContain('tax-control');
    }
    // An attribute-only tax word also reaches the word-bounded `jargon` rule,
    // because the collection now feeds it the accessible text.
    expect(collectLanguageInput(view('Invoice #1044', [element('input', { placeholder: 'Tax rate' })])).text).toContain('Tax rate');
    expect(languageIssuesForDocument(view('Invoice #1044', [element('input', { placeholder: 'Tax rate' })])).map((i) => i.kind)).toContain('jargon');

    // The prose-bearing elements stay OUT of `tax-control`: `taxRe` is a
    // substring match and "Reactivate the supplier…" contains `vat`, and six
    // accepted Phase 3 strings say exactly that.
    expect(TAX_WORD_RE.test('Reactivate the supplier or choose another')).toBe(true);
    for (const tag of ['td', 'dd', 'li', 'summary', 'button', 'p']) {
      const kinds = languageIssuesForDocument(view('', [element(tag, { textContent: 'Reactivate the supplier or choose another' })])).map((i) => i.kind);
      expect(kinds, tag).not.toContain('tax-control');
    }
  });

  it('GREEN HALF — every merchant-visible Phase 3 string still passes both rules', () => {
    const dicts = catalogs();
    for (const [locale, dict] of Object.entries(dicts)) {
      for (const [key, value] of Object.entries(dict)) {
        if (key.startsWith('accounting.')) continue; // the accountant's chart; no merchant screen renders it
        expect(ACCT_JARGON_RE.test(value), `${locale}:${key} = ${value}`).toBe(false);
      }
    }
    // The six accepted strings that contain `vat` as a substring: the `jargon`
    // rule is word-bounded, so they pass it, and they render in prose elements
    // the `tax-control` rule does not inspect.
    const reactivate = dicts.en['team.reactivate'];
    expect(reactivate).toBe('Reactivate');
    expect(languageIssues(reactivate ?? '', [])).toEqual([]);
    // And no Phase 3 attribute string reaches either rule: nothing in the tree
    // puts one of these words in an attribute at all.
    const attrKeys = [
      ...new Set(
        Object.values(webFiles())
          .flatMap((s) => [...s.matchAll(/(?:placeholder|title|aria-label)=\{?t\(['"]([\w.]+)/g)])
          .map((m) => m[1] ?? ''),
      ),
    ].filter(Boolean);
    expect(attrKeys.length).toBeGreaterThan(20);
    for (const locale of ['ar', 'en', 'tr'] as const) {
      for (const k of attrKeys) {
        const v = dicts[locale][k];
        if (v === undefined) continue;
        expect(TAX_WORD_RE.test(v), `${locale}:${k} = ${v}`).toBe(false);
        expect(ACCT_JARGON_RE.test(v), `${locale}:${k} = ${v}`).toBe(false);
      }
    }
  });
});
