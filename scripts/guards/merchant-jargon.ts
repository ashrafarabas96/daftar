/**
 * P3-S7 merchant-language guard (contract §7.2(a), T-09; MP-2).
 *
 * The merchant never reads an accounting or engine term (SIM-06, L:1302,
 * GL §5.2). Two halves, both pure functions over text so that
 * `scripts/check-localization.ts` (the gate's localization pass) and
 * `apps/web/test/jargon.test.ts` (T-09) run the very same rules:
 *
 *   1. the catalog: every value of a key in the S7 namespaces, in each locale,
 *      against that locale's denylist;
 *   2. the S7 web source: no JSX text literal outside `t(…)` (except `<bdi>`
 *      data), no `.message` / refusal `.code` rendered, no `accounting.*` key.
 *
 * The `accounting.*` namespace is excluded from (1): it is the accountant's
 * chart, pinned by tests/integration/accounting-guards.test.ts. The denylist
 * is scoped to the S7 namespaces and to specific forms, because "borç" and
 * "حساب" have ordinary meanings (TL-12).
 */

export type CatalogLocale = 'ar' | 'en' | 'tr';

/** The per-locale denylist: SIM-06 (docs/DAFTAR_SIMPLICITY_STANDARD.md) plus the lock's L:1302 list, translated. */
export const MERCHANT_JARGON: Readonly<Record<CatalogLocale, readonly string[]>> = {
  en: [
    'journal',
    'debit',
    'credit',
    'ledger',
    'payable',
    'receivable',
    'accrual',
    'account',
    'COGS',
    'PPV',
    'weighted average',
    'carrying',
    'valuation',
    'binding',
    'base variant',
    'stock sequence',
    'deficit',
    'tenant',
    'idempotency',
    'UUID',
  ],
  ar: ['قيد', 'مدين', 'دائن', 'دفتر اليومية', 'دفتر الأستاذ', 'ذمم', 'حساب', 'تكلفة البضاعة', 'المتوسط المرجح', 'متغير أساسي', 'تسلسل'],
  tr: [
    'yevmiye',
    'borç kaydı',
    'alacak kaydı',
    'alacaklı',
    'borçlu',
    'muhasebe kaydı',
    'hesap planı',
    'mahsup',
    'defter-i kebir',
    'ağırlıklı ortalama',
    'temel varyant',
  ],
};

/**
 * ── P4-S1: the merchant namespaces, Phase 3's and Phase 4's (P4-AL-52) ────
 *
 * The scope was `(stock|purchases|suppliers)` and the prefixes below without
 * the Phase 4 half, so a `pos.`, `sales.`, `customers.`, `invoices.`,
 * `refunds.`, `installments.` or `debts.` key was never examined and a `pos/`
 * or `customers/` file was never read. Both guards stayed green while saying
 * nothing — which is the shape P4-AL-52 calls "a protection Phase 4 must build
 * rather than inherit".
 *
 * Widening moves no Phase 3 verdict, and that is checkable rather than
 * asserted: `apps/web/src/messages/{ar,en,tr}.json` holds no key under any of
 * the added prefixes and no `nav.` key among the added ones, and
 * `apps/web/src/app/[locale]` holds no directory with any of the added names.
 * So every added prefix and path matches the empty set today, and the first
 * thing it will ever match is a Phase 4 key or file.
 *
 * `P4-AL-50` is why this matters: `حساب` is on the Arabic denylist and
 * `common.` is in scope, so the glossary's "كشف حساب" for a customer statement
 * would fail `check:localization` — and now, with `customers.` in scope, so
 * would putting it under the customer namespace instead.
 */
/** The merchant nav items (§4.3): Phase 3's three and the Phase 4 screens of P4-AL-52. */
export const S7_NAV_KEYS: readonly string[] = [
  'nav.stock',
  'nav.purchases',
  'nav.suppliers',
  'nav.pos',
  'nav.sales',
  'nav.customers',
  'nav.invoices',
  'nav.payments',
  'nav.refunds',
  'nav.installments',
  'nav.debts',
];

/** Every key under a merchant namespace. `accounting.` is deliberately absent: it is the accountant's chart. */
export const S7_NAMESPACE_PREFIXES: readonly string[] = [
  'stock.',
  'purchasing.',
  'suppliers.',
  'payments.',
  'error.',
  'common.',
  // P4-S1 (P4-AL-52): the Phase 4 namespaces, before the first POS screen exists.
  'pos.',
  'sales.',
  'customers.',
  'invoices.',
  'refunds.',
  'installments.',
  'debts.',
];

export function isS7Key(key: string): boolean {
  return S7_NAV_KEYS.includes(key) || S7_NAMESPACE_PREFIXES.some((p) => key.startsWith(p));
}

const escape = (term: string): string => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');

/**
 * The matcher for one term in one locale. Case-insensitive and word-bounded,
 * with each language's inflection:
 * - en: the word with an optional -s/-es/-ed/-ing ("accounts", "credited");
 * - tr: the word start, any suffix (Turkish is agglutinative: "yevmiyede");
 * - ar: the word with the proclitics و/ف, ب/ل/ك and ال, and the common
 *   plural and pronoun suffixes ("والحساب", "حسابك") — but not another word
 *   that merely begins with the same letters ("مدينة" is not "مدين").
 */
export function jargonMatcher(locale: CatalogLocale, term: string): RegExp {
  const t = escape(term);
  switch (locale) {
    case 'en':
      return new RegExp(`(?<![\\p{L}\\p{N}])${t}(?:s|es|ed|ing)?(?![\\p{L}\\p{N}])`, 'iu');
    case 'tr':
      return new RegExp(`(?<![\\p{L}\\p{N}])${t}`, 'iu');
    case 'ar':
      return new RegExp(`(?<![\\p{L}\\p{M}])(?:[وف])?(?:[بلك])?(?:ال)?${t}(?:ات|ين|ون|ي|ك|ه|ها|هم|كم|نا)?(?![\\p{L}\\p{M}])`, 'u');
  }
}

export interface JargonHit {
  readonly locale: CatalogLocale;
  readonly key: string;
  readonly term: string;
  readonly value: string;
}

/** Every S7-namespace value that uses a denied term, per locale. `accounting.*` is never an S7 key. */
export function findMerchantJargon(catalogs: Readonly<Partial<Record<CatalogLocale, Readonly<Record<string, string>>>>>): JargonHit[] {
  const hits: JargonHit[] = [];
  for (const locale of ['ar', 'en', 'tr'] as const) {
    const catalog = catalogs[locale] ?? {};
    const matchers = MERCHANT_JARGON[locale].map((term) => [term, jargonMatcher(locale, term)] as const);
    for (const [key, value] of Object.entries(catalog)) {
      if (!isS7Key(key)) continue;
      for (const [term, re] of matchers) if (re.test(value)) hits.push({ locale, key, term, value });
    }
  }
  return hits;
}

// ── The S7 web source ────────────────────────────────────────────────────

/**
 * "S7 web files" (§0): the stock, purchases and suppliers pages, every view,
 * and the Phase 3 client libraries. Paths are repository-relative, `/`-separated.
 */
/**
 * The merchant route groups under `apps/web/src/app/[locale]`: Phase 3's
 * three, and the Phase 4 screen groups the execution plan's §4 ownership
 * matrix names. A Next.js route group folder — `(pos)` — is one optional
 * segment in front, so a screen moved into a group stays examined.
 */
export const MERCHANT_ROUTE_SEGMENTS: readonly string[] = [
  'stock',
  'purchases',
  'suppliers',
  'pos',
  'sales',
  'customers',
  'invoices',
  'payments',
  'refunds',
  'installments',
  'debts',
];

const MERCHANT_ROUTE_FILE = new RegExp(String.raw`^apps/web/src/app/\[locale\]/(?:\([^/]+\)/)?(?:${MERCHANT_ROUTE_SEGMENTS.join('|')})/.+\.tsx?$`);

export function isS7WebFile(path: string): boolean {
  const p = path.replace(/\\/g, '/');
  return (
    MERCHANT_ROUTE_FILE.test(p) ||
    /^apps\/web\/src\/views\/.+\.tsx?$/.test(p) ||
    // P4-S1: `phase4-*` alongside `phase3-*`, so a Phase 4 client library is read too.
    /^apps\/web\/src\/lib\/phase[0-9]+-[\w-]+\.tsx?$/.test(p)
  );
}

/** Strip block and line comments, keeping line numbers (strings are left intact). */
export function stripTsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

export interface SourceHit {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly evidence: string;
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/**
 * The tax vocabulary of `OD-03`, in the three platform languages.
 *
 * The words are the ones `tests/browser/invariants.ts` matches (`acctRe` /
 * `taxRe`), but the boundary is the one SOURCE CODE needs, which is neither of
 * that file's. The in-page `acctRe` is word-bounded, so it would miss
 * `taxMinor` and `invoices.taxLabel`; the in-page `taxRe` is a bare substring
 * match, so it hits the `vat` inside "Reactivate" — and six accepted Phase 3
 * strings say "Reactivate the supplier…".
 *
 * So this pattern anchors at a token START and not at its end: `tax`, `vat`,
 * `kdv` and `vergi` after a non-alphanumeric, plus the camelCase forms after a
 * lowercase letter or a digit. `taxMinor`, `tax_minor`, `vatColumn`,
 * `kdvOrani`, `salesTax` and `<th>Tax</th>` all match; `Reactivate`,
 * `activate`, `private` and `innovation` do not. The `i` flag is deliberately
 * absent, because it would make the camelCase branch match "reactiVATe"'s
 * lowercase `vat` as well.
 */
export const TAX_WORD =
  /(?<![\p{L}\p{N}])(?:[Tt][Aa][Xx]|[Vv][Aa][Tt]|[Kk][Dd][Vv]|[Vv][Ee][Rr][Gg][Ii])|(?<=[\p{Ll}\p{N}])(?:Tax|TAX|VAT|Vat|KDV|Kdv|Vergi|VERGI)|ضريب|ضرائب|القيمة المضافة/gu;

/** The S7 source rules of T-09, each with the reason it cites. */
export const S7_SOURCE_RULES: readonly {
  readonly name: string;
  readonly why: string;
  /** Rendering happens in `.tsx`; the `.ts` libraries map and compare codes, which is their job. */
  readonly tsxOnly: boolean;
  readonly find: (code: string) => { index: number; evidence: string }[];
}[] = [
  {
    name: 'JSX text literal outside t()',
    tsxOnly: true,
    why: 'every merchant-visible word comes from the catalog in ar, en and tr (A-15, MP-2); only <bdi> data may be literal',
    find: (code) => {
      const out: { index: number; evidence: string }[] = [];
      for (const m of code.matchAll(/<(\w+)(?:\s[^<>]*)?>([^<>{}\n`]*\p{L}[^<>{}\n`]*)<\//gu)) {
        if ((m[1] ?? '').toLowerCase() === 'bdi') continue;
        out.push({ index: m.index, evidence: (m[2] ?? '').trim() });
      }
      return out;
    },
  },
  {
    name: 'server message or refusal code rendered',
    why: 'a server message is written for an operator and a code is not a sentence; the screen renders t(refusalKey(error)) (A-15(e))',
    tsxOnly: true,
    find: (code) =>
      [...code.matchAll(/\.message\b|\b(?:err|error|e|ex|refusal|failure)\.(?:code|domainCode)\b(?!\s*[!=]==)/g)].map((m) => ({
        index: m.index,
        evidence: m[0],
      })),
  },
  {
    name: 'accounting.* key used on a merchant screen',
    why: 'the accounting namespace is the accountant chart; no S7 view renders it (§4.3, T-09)',
    tsxOnly: false,
    find: (code) => [...code.matchAll(/\bt\(\s*['"`]accounting\./g)].map((m) => ({ index: m.index, evidence: m[0] })),
  },
  {
    // P4-S1 (P4-AL-52, P4-AL-44): the static half of the browser gate's tax
    // rule. `OD-03` is open and sales tax is STRUCTURALLY ZERO, and because
    // `tests/browser/invariants.ts`'s `acctRe` forbids the bare word `tax`
    // over the whole rendered text, a screen that renders a tax field cannot
    // pass the gate at all. That is a decision, not an accident: no Phase 4
    // screen renders a tax field while tax is structurally zero, and the
    // invoice template's tax row arrives with the Country Pack that enables
    // non-zero tax. This rule says so at PR time instead of at gate time.
    //
    // Scoped to `.tsx` on purpose: the column, the DTO field and the refusal
    // code are real (`invoices.tax_minor`, `sale.tax_policy_absent`) and they
    // live in `.ts` libraries, which is their place. Rendering happens in
    // `.tsx`, and a merchant screen has no legitimate use for the word while
    // the `CHECK (tax_minor = 0)` stands. Phase 3's only mentions of it are in
    // comments, which `stripTsComments` has already removed.
    name: 'tax word on a merchant screen while OD-03 is open',
    tsxOnly: true,
    why: 'sales tax is structurally zero (P4-AL-44) and the browser gate jargon rule forbids the word outright, so no merchant screen renders a tax field (P4-AL-52)',
    find: (code) => [...code.matchAll(TAX_WORD)].map((m) => ({ index: m.index, evidence: m[0] })),
  },
];

/** T-09's source half over S7 web files (path → contents). Files that are not S7 web files are ignored. */
export function findS7SourceViolations(files: Readonly<Record<string, string>>): SourceHit[] {
  const hits: SourceHit[] = [];
  for (const [file, source] of Object.entries(files)) {
    if (!isS7WebFile(file)) continue;
    const code = stripTsComments(source);
    for (const rule of S7_SOURCE_RULES) {
      if (rule.tsxOnly && !file.endsWith('.tsx')) continue;
      for (const hit of rule.find(code)) hits.push({ file, line: lineOf(code, hit.index), rule: rule.name, evidence: hit.evidence });
    }
  }
  return hits;
}
