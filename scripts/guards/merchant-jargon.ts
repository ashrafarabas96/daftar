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

/** The S7 key namespaces (§4.3): the three nav items and every key under these prefixes. */
export const S7_NAV_KEYS: readonly string[] = ['nav.stock', 'nav.purchases', 'nav.suppliers'];
export const S7_NAMESPACE_PREFIXES: readonly string[] = ['stock.', 'purchasing.', 'suppliers.', 'payments.', 'error.', 'common.'];

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
export function isS7WebFile(path: string): boolean {
  const p = path.replace(/\\/g, '/');
  return (
    /^apps\/web\/src\/app\/\[locale\]\/(stock|purchases|suppliers)\/.+\.tsx?$/.test(p) ||
    /^apps\/web\/src\/views\/.+\.tsx?$/.test(p) ||
    /^apps\/web\/src\/lib\/phase3-[\w-]+\.tsx?$/.test(p)
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
