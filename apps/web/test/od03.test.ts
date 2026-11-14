import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ar from '@/messages/ar.json';
import en from '@/messages/en.json';
import tr from '@/messages/tr.json';
import { isS7Key, isS7WebFile, stripTsComments } from '../../../scripts/guards/merchant-jargon';
import { REPO_ROOT } from './helpers/refusal-codes';
import { customersOnly, entryPoints, importsOf, reachedFrom, referencedKeys } from './helpers/reach';

/**
 * T-12 (P3-S7 contract A-19; MP-2): the tax boundary. BLOCKED BY OD-03 — no
 * S7 screen, view or message key carries a tax element, no screen names a
 * customer, and nothing anywhere computes either.
 *
 * ── WHERE THE BOUNDARY RUNS, AND WHY IT MOVED ────────────────────────────
 * This suite used to read `.ts` CLIENT LIBRARIES under the same rule as
 * `.tsx` screens: no identifier whose token starts with tax/VAT/duty, and no
 * `customer` token, anywhere in `apps/web/src/lib/phase*-*.ts` either.
 *
 * That was true of the tree only for as long as no web client sent a SALE
 * COMMIT, and P4-S3 is the slice that sends one. `SaleCommitSchema`
 * (`apps/api/src/modules/selling/selling.schemas.ts`) is `.strict()` and
 * REQUIRES two fields this rule forbade by name:
 *
 *   - `taxMinor: z.literal(SALE_STRUCTURAL_ZERO_TAX_MINOR)` — the literal
 *     `'0'` and nothing else is accepted. It is a signed input rather than a
 *     server default precisely so that the day a Country Pack enables tax the
 *     fingerprint position already exists (`P4-AL-44`). There is no value a
 *     client could put there that the server would adopt;
 *   - `customerId: uuid.nullable()` — `null` is a WALK-IN, which is what a
 *     till sale is, and the field is `nullable` rather than `optional` so the
 *     walk-in is STATED rather than inferred from an absent key.
 *
 * So a POS that could not name them could not sell at all, and the choice was
 * never "name them or keep the rule" — it was "ship a working till or not".
 *
 * The boundary this suite now draws is the one the SHARED guard already drew
 * and wrote down: `S7_SOURCE_RULES`' tax rule in
 * `scripts/guards/merchant-jargon.ts` is `tsxOnly: true`, on the stated
 * reason that "the column, the DTO field and the refusal code are real
 * (`invoices.tax_minor`, `sale.tax_policy_absent`) and they live in `.ts`
 * libraries, which is their place. Rendering happens in `.tsx`." This file was
 * stricter than the accepted P4-S1 ruling beside it, and it is the one that
 * moved.
 *
 * WHAT IS NOT WEAKENED, and is now asserted where it was previously implied:
 *
 *   - no `.tsx` — no screen, no view — names a tax element or a customer, by
 *     exactly the rule that was there before;
 *   - no `.ts` client library names a tax RATE, EXEMPTION, THRESHOLD,
 *     JURISDICTION, REGISTRATION or INCLUSIVE/EXCLUSIVE spelling: the
 *     structural zero is a position, and a policy is what `OD-03` forbids;
 *   - the only tax identifier a `.ts` library may name at all is `taxMinor`,
 *     and the only value it may be set from is the named structural-zero
 *     constant;
 *   - the only value `customerId` may be set from is `null`.
 *
 * Each of those four is a claim about the shipped sources, shown firing on a
 * planted copy.
 */
/** An identifier that is, or has a camelCase segment that is, tax / VAT / duty — "syntax" is not one. */
const TAX_IDENTIFIER = /\b(?:[Tt]ax\w*|TAX\w*|\w*[a-z0-9]Tax\w*|[Vv][Aa][Tt]|[Dd]ut(?:y|ies))\b/g;
/**
 * The contract's key pattern (A-19, T-12: /tax|vat|duty|ضريب|vergi|kdv/i),
 * applied per key segment — split on `.`, `_` and camelCase — so that
 * `suppliers.reactivate` is not read as "VAT" while `purchasing.taxLine` is caught.
 */
const TAX_KEY = {
  test: (key: string): boolean =>
    key
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[.\s_-]+/)
      .some((segment) => /^(?:tax|vat|dut(?:y|ies)|vergi|kdv)/i.test(segment) || /ضريب/.test(segment)),
};
/** The same words in merchant text, word-bounded ("Reactivate" is not VAT). */
const TAX_TEXT = /\btax|\bvat\b|\bdut(?:y|ies)\b|ضريب|\bvergi|\bkdv\b/iu;

function s7Sources(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) out[relative(REPO_ROOT, full).split('\\').join('/')] = readFileSync(full, 'utf8');
    }
  };
  walk(join(REPO_ROOT, 'apps', 'web', 'src'));
  return Object.fromEntries(Object.entries(out).filter(([path]) => isS7WebFile(path)));
}

/** The rule itself, so it can be shown to fire. Comments are stripped: `BLOCKED BY OD-03` is the one tax text allowed. */
function taxIdentifiers(source: string): string[] {
  return [...stripTsComments(source).matchAll(TAX_IDENTIFIER)].map((m) => m[0]);
}

/**
 * The same source with any DENYLIST of request field names excised.
 *
 * `apps/web/src/lib/phase4-pos-api.ts` declares
 * `FORBIDDEN_REQUEST_FIELDS = ['…', 'tax', 'taxRate', 'taxExempt', …]`: the
 * names the POS client may NOT put in a request, mirroring the server's own
 * `POS_CART_FORGED_FIELDS`. A list of words that may not be sent is the
 * opposite of naming a tax policy, and a rule that read it would force the
 * denylist to be shorter than the server's — which is how a forgeable field
 * stops being named on the client side.
 */
function withoutDenylists(source: string): string {
  return stripTsComments(source).replace(/FORBIDDEN_REQUEST_FIELDS[^=]*=\s*\[[\s\S]*?\];/g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * The values a source puts under `field:`, normalised and with the spellings
 * that are not a SEND filtered out. One function, so the shipped claim and the
 * planted proof below cannot read the text two different ways.
 */
function valuesUnder(source: string, field: 'taxMinor' | 'customerId', allowed: readonly string[]): string[] {
  return [...stripTsComments(source).matchAll(new RegExp(String.raw`\b${field}\s*:\s*([^,\n]+)`, 'g'))]
    .map((m) => (m[1] ?? '').trim().replace(/[\s;}]+$/, ''))
    .filter((value) => !allowed.includes(value));
}

/** A type in an interface, a kind row in the declared field table, and the structural zero itself. */
const TAX_MINOR_ALLOWED = ['string', "'structural-zero'", 'POS_SALE_TAX_MINOR', "'0'"];
/** The field's type, its kind row, and the walk-in a till sale is. */
const CUSTOMER_ID_ALLOWED = ['null', 'string | null', "'identity'"];

describe('T-12 — OD-03: no tax element anywhere in S7', () => {
  it('fires on a planted tax element, and not on the OD-03 comment', () => {
    expect(taxIdentifiers('const body = { taxAmount: "0" };')).toEqual(['taxAmount']);
    expect(taxIdentifiers('const purchaseTaxMinor = x;')).toEqual(['purchaseTaxMinor']);
    expect(taxIdentifiers('const VAT = 1, duty = 2;')).toEqual(['VAT', 'duty']);
    expect(taxIdentifiers('// BLOCKED BY OD-03: no tax field\nconst a = 1;')).toEqual([]);
    expect(taxIdentifiers('const syntax = 1;')).toEqual([]);
  });

  it('no S7 SCREEN names a tax element', () => {
    const files = s7Sources();
    // Not vacuous: the screens are what this claim is about, and there are many.
    const screens = Object.entries(files).filter(([path]) => path.endsWith('.tsx'));
    expect(screens.length).toBeGreaterThan(10);
    const hits = screens.flatMap(([path, src]) => taxIdentifiers(src).map((t) => `${path}: ${t}`));
    expect(hits).toEqual([]);
  });

  it('no S7 client library names a tax POLICY, and the one tax field it may name is the structural zero', () => {
    const files = s7Sources();
    expect(Object.keys(files)).toContain('apps/web/src/lib/phase3-api.ts');
    expect(files['apps/web/src/lib/phase3-api.ts']).not.toMatch(/taxAmount/);
    const libraries = Object.entries(files).filter(([path]) => !path.endsWith('.tsx'));
    // Every tax identifier a non-rendering source names must be `taxMinor` —
    // the one position `SaleCommitSchema` requires. A rate, an exemption, a
    // threshold or a jurisdiction is a POLICY, and `OD-03` is OPEN.
    const named = libraries.flatMap(([path, src]) => taxIdentifiers(withoutDenylists(src)).map((t) => `${path}: ${t}`));
    expect(named.filter((hit) => !hit.endsWith(': taxMinor'))).toEqual([]);
    // And the only value it is ever set from is the named constant. A
    // `taxMinor` computed, read off an answer or passed through is caught here
    // even though the server's `z.literal` would refuse it too.
    const assigned = libraries.flatMap(([path, src]) => valuesUnder(src, 'taxMinor', TAX_MINOR_ALLOWED).map((value) => `${path}: ${value}`));
    expect(assigned).toEqual([]);
  });

  it('the text rule fires on a planted value, and not on an ordinary word', () => {
    expect(TAX_TEXT.test('Tax included')).toBe(true);
    expect(TAX_TEXT.test('KDV dahil')).toBe(true);
    expect(TAX_TEXT.test('شامل الضريبة')).toBe(true);
    expect(TAX_TEXT.test('Reactivate the supplier')).toBe(false);
    expect(TAX_KEY.test('purchasing.taxLine')).toBe(true);
    expect(TAX_KEY.test('purchasing.line_vat')).toBe(true);
    expect(TAX_KEY.test('suppliers.reactivate')).toBe(false);
  });

  it('no S7 key or value in any locale is about tax', () => {
    const hits: string[] = [];
    for (const [locale, catalog] of Object.entries({ ar, en, tr })) {
      for (const [key, value] of Object.entries(catalog)) {
        if (!isS7Key(key)) continue;
        if (TAX_KEY.test(key)) hits.push(`${locale} key ${key}`);
        if (TAX_TEXT.test(value)) hits.push(`${locale} ${key}: ${value}`);
      }
    }
    expect(hits).toEqual([]);
  });

  /**
   * The receivables refusal namespaces, which P4-S4 SHIPS.
   *
   * This test's name was "no customer payments", and that is no longer the
   * law: the slice that collects a customer payment is built, so its refusal
   * codes are keyed in all three catalogues on purpose. What the test is
   * really about survives unchanged — no S7 SCREEN names a customer, and no
   * S7 catalogue key names one for any reason OTHER than answering a
   * receivables refusal.
   *
   * The exemption is held to the registry rather than to a prefix: every
   * excluded key must be `error.<code>` for a code in `RECEIVABLES_CODES`,
   * and that is asserted below. So the exemption cannot quietly widen into
   * "anything under these namespaces", and a customer token appearing in a
   * POS key still fails.
   */
  /**
   * The registry is read as TEXT, not imported. `apps/web` must not import
   * from `apps/api`: that file transitively reaches the API's Nest infra and
   * compiling it under the web tsconfig fails with `TS1206: Decorators are not
   * valid here`. Reading the one table out of the source keeps the API's
   * registry as the authority — a code added there without its catalogue
   * entries still fails below — without coupling the two builds.
   */
  const RECEIVABLES_CODES: readonly string[] = (() => {
    const source = readFileSync(join(__dirname, '../../api/src/modules/receivables/receivables-errors.ts'), 'utf8');
    const table = /const RECEIVABLES_STATUS = \{([\s\S]*?)\n\} as const satisfies/.exec(source)?.[1] ?? '';
    return [...table.matchAll(/^\s*'([a-z_]+\.[a-z_]+)':\s*\d{3},/gm)].map((m) => m[1] as string);
  })();

  const receivablesKey = (key: string): boolean => RECEIVABLES_CODES.some((code) => key === `error.${code}`);

  /**
   * ── THE CUSTOMER RULES, BY REACH ───────────────────────────────────────
   *
   * This law used to say "no S7 `.tsx` names a customer, no S7 key names one,
   * a library may set `customerId` from null only" over EVERY S7 file and key.
   * That is a rule about WORDS and WHERE THEY LIVE; the behaviour it protects
   * is that the till, stock, purchasing, suppliers and sales surfaces do not
   * OFFER or NAME a customer. The customers slice is where that idea belongs,
   * so a text rule over every S7 path fails the day the slice ships — and a
   * law that fails for the right code is the law that gets disabled. DR-154/4
   * forbids the exemption, so the one carve-out is DERIVED from the import
   * graph, never listed, and nothing else is narrowed:
   *
   *   - CUSTOMERS ENTRIES: page/layout/route/special files under the
   *     `customers` route segment (anchored at `[locale]`);
   *   - EVERY OTHER ENTRY: every other file Next.js enters — pages, layouts,
   *     route handlers and special files anywhere under `app/` (S7 segments
   *     or not), and `src/middleware.ts`;
   *   - CUSTOMERS-ONLY FILES: reach(customers entries) minus reach(every other
   *     entry). A customers view a till page, the shared header or the
   *     middleware imports is NOT customers-only;
   *   - SCANNED FILES: every file `isS7WebFile` accepts (the existing
   *     definition, unchanged) except the customers-only ones. A file nothing
   *     imports is scanned, because dead code is not an exemption;
   *   - SCANNED KEYS: every `isS7Key` catalogue key except those referenced
   *     ONLY by customers-only files. A reference is a string literal, or a
   *     template / concatenation that builds a key under a prefix
   *     (`error.${code}`, `nav.${item.key}`), which references EVERY key under
   *     that prefix; the references of every file that is not customers-only
   *     count, S7 or not.
   *
   * Adding a page that is not under `customers` can only GROW the scanned set
   * (it adds to what "every other entry" reaches). Adding a customers page can
   * remove only files nothing else reaches. Both are asserted below.
   *
   * Nothing is subtracted by path or by key name. The controls are below: a
   * synthetic tree that has a customers route (main has none yet), and plants
   * on the repository itself.
   *
   * KNOWN CONSEQUENCE, stated: the shared header builds `nav.${item.key}` and
   * every merchant page renders it, so a `nav.customers` catalogue key IS
   * scanned and, naming a customer, fails this law. That is the law working,
   * not a bug to exempt by name; it is the coordinator's and the owner's open
   * decision (see the PR notes), shown below on a synthetic catalogue.
   */
  const CUSTOMER_WORD = /customer|عميل|عملاء|müşteri/i;
  const codeToken = new RegExp(`^(?:${RECEIVABLES_CODES.map((c) => c.replace(/[.]/g, '\\.')).join('|')})$`);

  interface CustomerLaw {
    readonly customersOnly: string[];
    readonly scanned: string[];
    readonly screens: string[];
    readonly libraries: string[];
    readonly s7Keys: string[];
    readonly excludedKeys: string[];
    readonly keys: string[];
    readonly hits: string[];
  }

  function customerLaw(files: Record<string, string>, catalogs: Record<string, Record<string, string>>): CustomerLaw {
    const only = customersOnly(files);
    const scanned = Object.keys(files)
      .filter((path) => isS7WebFile(path) && !only.has(path))
      .sort();
    const screens = scanned.filter((path) => path.endsWith('.tsx'));
    const libraries = scanned.filter((path) => !path.endsWith('.tsx'));
    const hits: string[] = [];
    for (const path of screens) if (CUSTOMER_WORD.test(stripTsComments(files[path] ?? ''))) hits.push(`screen ${path}`);
    for (const path of libraries) {
      const src = files[path] ?? '';
      for (const value of valuesUnder(src, 'customerId', CUSTOMER_ID_ALLOWED)) hits.push(`library customerId ${path}: ${value}`);
      for (const m of stripTsComments(src).matchAll(/\b[Cc]ustomer\w*(?:\.[a-z_]+)?/g)) {
        if (m[0] !== 'customerId' && !codeToken.test(m[0])) hits.push(`library vocabulary ${path}: ${m[0]}`);
      }
    }
    const s7Keys = [...new Set(Object.values(catalogs).flatMap((catalog) => Object.keys(catalog)))].filter((key) => isS7Key(key)).sort();
    const fromCustomers = referencedKeys(
      [...only].map((path) => files[path] ?? ''),
      s7Keys,
    );
    const fromRest = referencedKeys(
      Object.keys(files)
        .filter((path) => !only.has(path))
        .map((path) => files[path] ?? ''),
      s7Keys,
    );
    const excludedKeys = [...fromCustomers].filter((key) => !fromRest.has(key)).sort();
    const keys = s7Keys.filter((key) => !excludedKeys.includes(key));
    for (const key of keys) {
      if (receivablesKey(key)) continue;
      for (const [locale, catalog] of Object.entries(catalogs)) {
        if (key in catalog && CUSTOMER_WORD.test(`${key} ${catalog[key]}`)) hits.push(`key ${locale}: ${key}`);
      }
    }
    return { customersOnly: [...only].sort(), scanned, screens, libraries, s7Keys, excludedKeys, keys, hits };
  }

  function repositorySources(): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry)) out[relative(REPO_ROOT, full).split('\\').join('/')] = readFileSync(full, 'utf8');
      }
    };
    walk(join(REPO_ROOT, 'apps', 'web', 'src'));
    return out;
  }

  const SYNTHETIC_CATALOG = { en: { 'pos.title': 'Till', 'customers.title': 'Customers', 'stock.title': 'Stock' } };
  const A = 'apps/web/src/app/[locale]';
  const TILL = 'apps/web/src/views/pos/TillView.tsx';
  const HEADER = `${A}/AppHeader.tsx`;
  const PANEL = 'apps/web/src/views/common/Panel.tsx';
  const CV = 'apps/web/src/views/customers';
  const ACCOUNT = `${CV}/CustomerAccountView.tsx`;
  const importAccount = "import { CustomerAccountView } from '@/views/customers/CustomerAccountView';\n";
  /** A web tree that contains a customers route, which main does not yet. */
  function syntheticTree(extra: Record<string, string> = {}): Record<string, string> {
    return {
      [`${A}/pos/till/page.tsx`]:
        "import { TillView } from '@/views/pos/TillView';\nimport { PageShell } from '../../AppHeader';\nexport default () => PageShell + TillView;",
      [`${A}/stock/page.tsx`]: "import { StockView } from '../../../views/stock/StockView';\nexport default () => StockView;",
      [`${A}/login/page.tsx`]: 'export default () => 1;',
      [HEADER]: "import { pickLabel } from '@/lib/shared-label';\nexport const PageShell = () => pickLabel;",
      'apps/web/src/lib/shared-label.ts': 'export const pickLabel = 1;',
      [PANEL]: 'export const Panel = () => 1;',
      [TILL]:
        "import { sell } from '@/lib/phase4-pos-api';\nimport { Panel } from '@/views/common/Panel';\nexport const TillView = () => t('pos.title') + sell + Panel;",
      'apps/web/src/views/stock/StockView.tsx': "import { Panel } from '@/views/common/Panel';\nexport const StockView = () => t('stock.title') + Panel;",
      'apps/web/src/lib/phase4-pos-api.ts': 'export const sell = { customerId: null };',
      [`${A}/customers/page.tsx`]: "import { CustomerListView } from '@/views/customers/CustomerListView';\nexport default () => CustomerListView;",
      [`${CV}/CustomerListView.tsx`]:
        "import { CustomerAccountView } from './CustomerAccountView';\nexport const CustomerListView = () => t('customers.title') + CustomerAccountView;",
      [ACCOUNT]: 'export const CustomerAccountView = () => customer.name;',
      ...extra,
    };
  }

  it('REACH, unit level: the customers-only set is derived, everything else S7 is scanned, and a customer word in it is flagged', () => {
    const tree = syntheticTree();
    const clean = customerLaw(tree, SYNTHETIC_CATALOG);
    // POSITIVE controls on the synthetic tree.
    expect(clean.hits).toEqual([]);
    expect(clean.customersOnly).toEqual([`${A}/customers/page.tsx`, ACCOUNT, `${CV}/CustomerListView.tsx`].sort());
    expect(clean.scanned).toEqual(
      Object.keys(tree)
        .filter((path) => isS7WebFile(path) && !clean.customersOnly.includes(path))
        .sort(),
    );
    for (const path of [TILL, PANEL, 'apps/web/src/views/stock/StockView.tsx', 'apps/web/src/lib/phase4-pos-api.ts'])
      expect(clean.scanned, path).toContain(path);
    expect(clean.keys).toEqual(['pos.title', 'stock.title']);
    expect(clean.excludedKeys).toEqual(['customers.title']);
    // NEGATIVE: a customer word planted in a till screen, in a shared view every page renders, in a stock screen.
    for (const path of [TILL, PANEL, 'apps/web/src/views/stock/StockView.tsx']) {
      expect(customerLaw(syntheticTree({ [path]: 'export const X = () => customer.name;' }), SYNTHETIC_CATALOG).hits, path).toEqual([`screen ${path}`]);
    }
    // Comments are stripped, as before.
    expect(customerLaw(syntheticTree({ [TILL]: '// walk-in, not a customer\nexport const TillView = 1;' }), SYNTHETIC_CATALOG).hits).toEqual([]);
    // Libraries: a buyer under customerId, a customer balance, in a library every page uses.
    expect(
      customerLaw(syntheticTree({ 'apps/web/src/lib/phase4-pos-api.ts': 'export const sell = { customerId: chosen.id };' }), SYNTHETIC_CATALOG).hits,
    ).toEqual(['library customerId apps/web/src/lib/phase4-pos-api.ts: chosen.id']);
    expect(customerLaw(syntheticTree({ 'apps/web/src/lib/phase3-errors.ts': 'export const customerBalance = 1;' }), SYNTHETIC_CATALOG).hits).toEqual([
      'library vocabulary apps/web/src/lib/phase3-errors.ts: customerBalance',
    ]);
    // Dead code is not an exemption: a customers view nothing imports, and an S7 library nothing imports, are scanned.
    expect(
      customerLaw(syntheticTree({ [`${CV}/CustomerOrphan.tsx`]: 'export const CustomerOrphan = () => customer.balance;' }), SYNTHETIC_CATALOG).hits,
    ).toEqual([`screen ${CV}/CustomerOrphan.tsx`]);
    expect(customerLaw(syntheticTree({ 'apps/web/src/lib/phase4-unused-api.ts': 'export const customerBalance = 1;' }), SYNTHETIC_CATALOG).hits).toEqual([
      'library vocabulary apps/web/src/lib/phase4-unused-api.ts: customerBalance',
    ]);
  });

  it('REACH, unit level: a customers view any other entry reaches is no longer customers-only and is flagged', () => {
    const smuggled = (extra: Record<string, string>): CustomerLaw => customerLaw(syntheticTree(extra), SYNTHETIC_CATALOG);
    // Directly: the till page imports a customers view.
    const direct = smuggled({
      [`${A}/pos/till/page.tsx`]: "import { CustomerListView } from '@/views/customers/CustomerListView';\nexport default () => CustomerListView;",
    });
    expect(direct.customersOnly).toEqual([`${A}/customers/page.tsx`]);
    expect(direct.hits).toEqual(expect.arrayContaining([`screen ${ACCOUNT}`, `screen ${CV}/CustomerListView.tsx`, 'key en: customers.title']));
    // Through a shared S7 view, and through the (non-S7) shared header.
    expect(smuggled({ [PANEL]: `${importAccount}export const Panel = CustomerAccountView;` }).hits).toEqual(expect.arrayContaining([`screen ${ACCOUNT}`]));
    expect(smuggled({ [HEADER]: `${importAccount}export const PageShell = CustomerAccountView;` }).hits).toEqual([`screen ${ACCOUNT}`]);
    // Through a relative import written with a directory index.
    const viaIndex = smuggled({
      [`${A}/stock/page.tsx`]: "import { X } from '../../../views/customers';\nexport default () => X;",
      [`${CV}/index.ts`]: "export { CustomerAccountView as X } from './CustomerAccountView';",
    });
    expect(viaIndex.hits).toEqual(expect.arrayContaining([`screen ${ACCOUNT}`, `screen ${A}/stock/page.tsx`]));
    // The customers page, reaching its own views only, is not flagged.
    expect(customerLaw(syntheticTree(), SYNTHETIC_CATALOG).hits).toEqual([]);
  });

  it('REACH, unit level: keys — every S7 key is scanned, run-time prefixes cover their namespace, and only customers-only references excuse a key', () => {
    const catalog = {
      en: {
        ...SYNTHETIC_CATALOG.en,
        'error.sale.customer_required': 'Choose a customer',
        'common.buyerNote': 'Buyer: a customer',
        'pos.buyer': 'Choose a customer',
      },
    };
    // A key nothing names is still scanned: an unreferenced key is not an exemption.
    expect(customerLaw(syntheticTree(), catalog).hits).toEqual(['key en: common.buyerNote', 'key en: error.sale.customer_required', 'key en: pos.buyer']);
    // A key referenced ONLY by a customers-only file is the customers slice's...
    const onlyCustomers = customerLaw(syntheticTree({ [ACCOUNT]: "export const CustomerAccountView = () => t('common.buyerNote');" }), catalog);
    expect(onlyCustomers.excludedKeys).toEqual(['common.buyerNote', 'customers.title']);
    expect(onlyCustomers.hits).toEqual(['key en: error.sale.customer_required', 'key en: pos.buyer']);
    // ...and the day any other file names it, it is not.
    const both = customerLaw(
      syntheticTree({
        [ACCOUNT]: "export const CustomerAccountView = () => t('common.buyerNote');",
        [PANEL]: "export const Panel = () => t('common.buyerNote');",
      }),
      catalog,
    );
    expect(both.hits).toContain('key en: common.buyerNote');
    // A key built at run time references every key under its prefix. A customers-only file builds `error.${code}`: those keys are excused...
    const dynamicByCustomers = customerLaw(syntheticTree({ [ACCOUNT]: 'export const CustomerAccountView = (code) => t(`error.${code}`);' }), catalog);
    expect(dynamicByCustomers.excludedKeys).toEqual(expect.arrayContaining(['error.sale.customer_required']));
    // ...but the shared library builds it too (as `phase3-errors.ts` does), so they are scanned and the planted one is flagged.
    const dynamicShared = customerLaw(
      syntheticTree({
        [ACCOUNT]: 'export const CustomerAccountView = (code) => t(`error.${code}`);',
        'apps/web/src/lib/phase3-errors.ts': 'export const refusalKey = (code) => `error.${code}`;',
      }),
      catalog,
    );
    expect(dynamicShared.hits).toContain('key en: error.sale.customer_required');
    expect(customerLaw(syntheticTree({ [PANEL]: "export const Panel = (code) => t('error.' + code);" }), catalog).hits).toContain(
      'key en: error.sale.customer_required',
    );
    // The shared header builds `nav.${key}`: `nav.customers` is an S7 nav key naming a customer, so it is scanned and flagged.
    // Deliberate and OPEN (see the PR notes): not worked around by name.
    const nav = customerLaw(syntheticTree({ [HEADER]: 'export const PageShell = (item) => t(`nav.${item.key}`);' }), {
      en: { ...SYNTHETIC_CATALOG.en, 'nav.customers': 'Customers' },
    });
    expect(nav.hits).toEqual(['key en: nav.customers']);
    // Referenced only by the customers page it is excused, which is what a code fix for the nav would have to achieve.
    const navOnlyCustomers = customerLaw(
      syntheticTree({
        [`${A}/customers/page.tsx`]:
          "import { CustomerListView } from '@/views/customers/CustomerListView';\nexport default () => CustomerListView + t('nav.customers');",
      }),
      { en: { ...SYNTHETIC_CATALOG.en, 'nav.customers': 'Customers' } },
    );
    expect(navOnlyCustomers.hits).toEqual([]);
  });

  /**
   * The boundaries of the reach computation, each with a control that turns
   * RED when the boundary moves. (Each was also shown red against a planted
   * mutation of `helpers/reach.ts` or of `customerLaw`; see the PR notes.)
   */
  it('BOUNDARY (a): "every other entry" is ALL entries — non-S7 pages, route handlers, special files and the middleware', () => {
    const view = `${importAccount}export default () => CustomerAccountView;`;
    const reachers: Record<string, Record<string, string>> = {
      'a page outside the S7 segments': { [`${A}/dashboard/page.tsx`]: view },
      'a route handler': { 'apps/web/src/app/api/export/route.ts': view },
      'a root layout': { [`${A}/layout.tsx`]: view },
      'a special file': { [`${A}/global-error.tsx`]: view },
      'the middleware': { 'apps/web/src/middleware.ts': view },
    };
    for (const [what, extra] of Object.entries(reachers)) {
      const law = customerLaw(syntheticTree(extra), SYNTHETIC_CATALOG);
      expect(law.customersOnly, what).not.toContain(ACCOUNT);
      expect(law.hits, what).toEqual(expect.arrayContaining([`screen ${ACCOUNT}`]));
    }
  });

  it('BOUNDARY (b): a key a non-S7 shared file reads is scanned, whoever else reads it', () => {
    const catalog = { en: { ...SYNTHETIC_CATALOG.en, 'invoices.note.customerOwes': 'Customer owes' } };
    const COPY = 'apps/web/src/lib/shared-copy.ts';
    expect(isS7WebFile(COPY)).toBe(false);
    const read = {
      [COPY]: "export const copy = (t) => t('invoices.note.customerOwes');",
      [`${CV}/CustomerListView.tsx`]:
        "import { copy } from '@/lib/shared-copy';\nimport { CustomerAccountView } from './CustomerAccountView';\nexport const CustomerListView = () => copy + CustomerAccountView + t('customers.title') + t('invoices.note.customerOwes');",
    };
    // Read by a customers-only view alone: excused.
    expect(customerLaw(syntheticTree(read), catalog).hits).toEqual([]);
    expect(customerLaw(syntheticTree(read), catalog).excludedKeys).toEqual(expect.arrayContaining(['invoices.note.customerOwes']));
    // Read by a non-S7 file that something other than the customers slice reaches: scanned and flagged.
    const shared = customerLaw(syntheticTree({ ...read, [TILL]: "import { copy } from '@/lib/shared-copy';\nexport const TillView = () => copy;" }), catalog);
    expect(shared.hits).toEqual(['key en: invoices.note.customerOwes']);
  });

  it('BOUNDARY (c): the customers route matcher is anchored at [locale]', () => {
    // `pos/customers/page.tsx` is a till page that has `customers` in its path: it is not a customers entry, so a view it imports is flagged.
    const shell = "import { PageShell } from '../../AppHeader';\n";
    const underPos = customerLaw(
      syntheticTree({ [`${A}/pos/customers/page.tsx`]: `${shell}${importAccount}export default () => PageShell + CustomerAccountView;` }),
      SYNTHETIC_CATALOG,
    );
    expect(underPos.customersOnly).not.toContain(ACCOUNT);
    expect(underPos.hits).toEqual(expect.arrayContaining([`screen ${ACCOUNT}`]));
    // `customers/pos/page.tsx` IS under the customers route: its view is customers-only and nothing else is flagged.
    const overPos = customerLaw(
      syntheticTree({ [`${A}/customers/pos/page.tsx`]: `${importAccount}export default () => CustomerAccountView;` }),
      SYNTHETIC_CATALOG,
    );
    expect(overPos.customersOnly).toContain(`${A}/customers/pos/page.tsx`);
    expect(overPos.hits).toEqual([]);
    // A route group in front is still the customers route; a `customers` directory deeper elsewhere is not.
    expect(
      customerLaw(syntheticTree({ [`${A}/(app)/customers/page.tsx`]: `${importAccount}export default () => CustomerAccountView;` }), SYNTHETIC_CATALOG).hits,
    ).toEqual([]);
    expect(
      customerLaw(syntheticTree({ [`${A}/reports/customers/page.tsx`]: `${importAccount}export default () => CustomerAccountView;` }), SYNTHETIC_CATALOG).hits,
    ).toEqual(expect.arrayContaining([`screen ${ACCOUNT}`]));
  });

  it('BOUNDARY (d): an import the walk cannot follow FAILS the walk instead of being dropped', () => {
    const walk = (till: string): Record<string, string> => syntheticTree({ [TILL]: till });
    const unresolved: Record<string, string> = {
      'a `.js` suffix on a TypeScript source': "import { x } from './model.js';\nexport const TillView = x;",
      'an alias the walk does not know': "import { x } from '~/lib/phase4-pos-api';\nexport const TillView = x;",
      'a path that names no file': "import { x } from '@/lib/not-there';\nexport const TillView = x;",
      'a computed dynamic import': 'export const TillView = (n) => import(`@/views/${n}`);',
      'a relative path that names no file': "import { x } from '../nowhere';\nexport const TillView = x;",
    };
    for (const [what, source] of Object.entries(unresolved)) {
      expect(() => customerLaw(walk(source), SYNTHETIC_CATALOG), what).toThrow(/could not resolve/);
      expect(() => reachedFrom(walk(source), [`${A}/pos/till/page.tsx`]), what).toThrow(/could not resolve/);
    }
    // Data and packages are not holes.
    expect(() =>
      customerLaw(
        walk("import cat from '@/messages/en.json';\nimport { useState } from 'react';\nimport 'server-only';\nexport const TillView = () => cat + useState;"),
        SYNTHETIC_CATALOG,
      ),
    ).not.toThrow();
    expect(importsOf(TILL, "import('@/lib/shared-label');", syntheticTree()).resolved).toEqual(['apps/web/src/lib/shared-label.ts']);
    // A hole in a file nothing reaches is not walked.
    expect(() => customerLaw(syntheticTree({ 'apps/web/src/lib/stray.ts': "import { x } from '~/nope';" }), SYNTHETIC_CATALOG)).not.toThrow();
  });

  it('BOUNDARY (e): the framework special files and the middleware are entries', () => {
    const special = [
      'global-error',
      'forbidden',
      'unauthorized',
      'opengraph-image',
      'twitter-image',
      'icon',
      'apple-icon',
      'sitemap',
      'robots',
      'manifest',
      'error',
      'not-found',
      'loading',
      'template',
      'default',
    ].map((name) => `${A}/pos/${name}.tsx`);
    expect(entryPoints(special)).toEqual([...special].sort());
    expect(entryPoints([`${A}/pos/icon2.tsx`, `${A}/pos/opengraph-image1.ts`])).toHaveLength(2);
    expect(entryPoints([`${A}/pos/helper.tsx`, `${A}/pos/pos-page-kit.ts`])).toEqual([]);
    expect(entryPoints(['apps/web/src/middleware.ts', `${A}/pos/page.tsx`, 'apps/web/src/lib/csp.ts', 'apps/web/src/views/pos/page.tsx'])).toEqual(
      ['apps/web/src/middleware.ts', `${A}/pos/page.tsx`].sort(),
    );
    // A customers entry that is a special file keeps its views customers-only.
    const law = customerLaw(
      syntheticTree({ [`${A}/customers/not-found.tsx`]: `${importAccount}export default () => CustomerAccountView;` }),
      SYNTHETIC_CATALOG,
    );
    expect(law.customersOnly).toContain(`${A}/customers/not-found.tsx`);
  });

  it('BOUNDARY (f): adding an entry that is not under customers can never SHRINK the scanned set; adding a customers entry removes only what nothing else reaches', () => {
    const base = customerLaw(syntheticTree(), SYNTHETIC_CATALOG);
    const importers = (spec: string): string => `${spec}\nexport default () => 1;`;
    const nonCustomers: Record<string, Record<string, string>> = {
      'a page importing nothing': { [`${A}/new/page.tsx`]: 'export default () => 1;' },
      'a page importing a customers view': { [`${A}/new/page.tsx`]: importers(importAccount) },
      'a page importing the header': { [`${A}/new/page.tsx`]: importers("import { PageShell } from '../AppHeader';") },
      'a layout': { [`${A}/layout.tsx`]: importers(importAccount) },
      'a route handler': { 'apps/web/src/app/api/new/route.ts': importers(importAccount) },
      'the middleware': { 'apps/web/src/middleware.ts': importers(importAccount) },
      'a pos page importing a customers view': { [`${A}/pos/customers/page.tsx`]: importers(importAccount) },
    };
    for (const [what, extra] of Object.entries(nonCustomers)) {
      const after = customerLaw(syntheticTree(extra), SYNTHETIC_CATALOG);
      const lost = base.scanned.filter((path) => !after.scanned.includes(path));
      expect(lost, what).toEqual([]);
      const lostKeys = base.keys.filter((key) => !after.keys.includes(key));
      expect(lostKeys, what).toEqual([]);
    }
    // A customers entry: whatever it removes from the scan, no other entry reaches.
    const customersAdded = syntheticTree({
      [`${A}/customers/new/page.tsx`]: importers("import { Dead } from '@/views/customers/Dead';"),
      [`${CV}/Dead.tsx`]: 'export const Dead = 1;',
      [`${CV}/Shared.tsx`]: 'export const Shared = 1;',
    });
    const withShared = syntheticTree({
      ...customersAdded,
      [`${A}/customers/other/page.tsx`]: importers("import { Shared } from '@/views/customers/Shared';"),
      [`${A}/dashboard/page.tsx`]: importers("import { Shared } from '@/views/customers/Shared';"),
    });
    for (const tree of [customersAdded, withShared]) {
      const after = customerLaw(tree, SYNTHETIC_CATALOG);
      const lost = customerLaw(
        syntheticTree({ [`${CV}/Dead.tsx`]: 'export const Dead = 1;', [`${CV}/Shared.tsx`]: 'export const Shared = 1;' }),
        SYNTHETIC_CATALOG,
      ).scanned.filter((path) => !after.scanned.includes(path));
      const reachedByOthers = reachedFrom(
        tree,
        entryPoints(Object.keys(tree)).filter((entry) => !entry.startsWith(`${A}/customers/`)),
      );
      expect(
        lost.every((path) => !reachedByOthers.has(path)),
        'a customers entry removed a file another entry reaches',
      ).toBe(true);
    }
    expect(customerLaw(withShared, SYNTHETIC_CATALOG).scanned).toContain(`${CV}/Shared.tsx`);
    expect(customerLaw(customersAdded, SYNTHETIC_CATALOG).scanned).not.toContain(`${CV}/Dead.tsx`);
  });

  it('REACH, repository: the scope is every S7 file and key except the derived customers-only set, and none names a customer', () => {
    const files = repositorySources();
    const law = customerLaw(files, { ar, en, tr });
    // POSITIVE controls — a law that passes on an empty set is dead.
    // The walk has no hole anywhere in the app: every entry the framework has (middleware included) resolves completely,
    // and the one alias the build knows is the one the walk resolves.
    const everyEntry = entryPoints(Object.keys(files));
    expect(everyEntry).toContain('apps/web/src/middleware.ts');
    expect(everyEntry.length).toBeGreaterThan(20);
    expect(reachedFrom(files, everyEntry).size).toBeGreaterThan(Object.keys(files).length / 2);
    const tsconfig = JSON.parse(readFileSync(join(REPO_ROOT, 'apps', 'web', 'tsconfig.json'), 'utf8')) as {
      compilerOptions: { paths?: Record<string, unknown> };
    };
    expect(Object.keys(tsconfig.compilerOptions.paths ?? {}), 'a new path alias the import walk does not resolve').toEqual(['@/*']);
    // The file scope is EXACTLY isS7WebFile minus the customers-only set.
    const s7Files = Object.keys(files)
      .filter((path) => isS7WebFile(path))
      .sort();
    expect(s7Files.length).toBeGreaterThan(40);
    expect(law.scanned).toEqual(s7Files.filter((path) => !law.customersOnly.includes(path)));
    expect(law.scanned.length).toBe(s7Files.length - law.customersOnly.filter((path) => isS7WebFile(path)).length);
    for (const path of [
      'apps/web/src/views/common/primitives.tsx',
      'apps/web/src/views/common/feedback.tsx',
      'apps/web/src/lib/phase3-errors.ts',
      'apps/web/src/lib/phase3-api.ts',
      'apps/web/src/views/stock/StockLevelsView.tsx',
      'apps/web/src/views/structure/WarehouseBranches.tsx',
      'apps/web/src/views/pos/TillView.tsx',
      'apps/web/src/views/pos/registry.ts',
      'apps/web/src/views/catalog/registry.tsx',
      'apps/web/src/lib/phase4-pos-api.ts',
    ]) {
      expect(law.scanned, path).toContain(path);
    }
    expect(law.screens.length, 'the scan ran over too few screens').toBeGreaterThan(10);
    expect(law.libraries.length).toBeGreaterThan(2);
    // The key scope is main's count of S7 keys, minus only keys referenced exclusively by customers-only files.
    const mainKeys = Object.keys(en).filter((key) => isS7Key(key));
    expect(mainKeys.length).toBeGreaterThan(500);
    expect(law.s7Keys).toEqual(mainKeys.slice().sort());
    expect(law.keys.length).toBe(mainKeys.length - law.excludedKeys.length);
    expect(law.keys).toContain('pos.title');
    expect(law.keys).toContain('common.loading');
    // The law itself.
    expect(law.hits).toEqual([]);
    // The receivables exemption is not vacuous and not a prefix: it covers a
    // real, non-empty, registered set, and every key it covers is in that set.
    const exempted = Object.keys(en).filter((key) => isS7Key(key) && receivablesKey(key));
    expect(exempted.length, 'the exemption covers no key, so it is hiding nothing and should be deleted').toBe(RECEIVABLES_CODES.length);
    expect(RECEIVABLES_CODES.length).toBeGreaterThan(0);
  });

  it('REACH, repository: a scanned library sets customerId from null only, and names no other customer vocabulary', () => {
    const law = customerLaw(repositorySources(), { ar, en, tr });
    expect(law.libraries.length).toBeGreaterThan(2);
    expect(law.libraries).toContain('apps/web/src/lib/phase4-pos-api.ts');
    expect(law.libraries).toContain('apps/web/src/lib/phase3-api.ts');
    // `SaleCommitSchema` requires `customerId`, and `null` IS the walk-in a
    // till sale is. A library may name a receivables refusal CODE
    // (`phase3-errors.ts` classifies which of them a retry may repeat) and
    // nothing else of a customer.
    expect(law.hits.filter((hit) => hit.startsWith('library '))).toEqual([]);
  });

  it('the two library rules fire on a planted policy, a planted figure and a planted buyer', () => {
    // A POLICY, named outside a denylist: caught.
    expect(taxIdentifiers(withoutDenylists('const r = { taxRate: "0.16" };'))).toEqual(['taxRate']);
    expect(taxIdentifiers(withoutDenylists('const r = { taxExemptionId: x };'))).toEqual(['taxExemptionId']);
    // The same words INSIDE the denylist: not a policy, and excised.
    expect(taxIdentifiers(withoutDenylists("export const FORBIDDEN_REQUEST_FIELDS: readonly string[] = ['taxRate', 'taxExempt'];\n"))).toEqual([]);
    // A figure put under `taxMinor`, and a buyer put under `customerId`.
    expect(valuesUnder('const b = { taxMinor: cart.taxMinor };', 'taxMinor', TAX_MINOR_ALLOWED)).toEqual(['cart.taxMinor']);
    expect(valuesUnder('const b = { customerId: chosen.id };', 'customerId', CUSTOMER_ID_ALLOWED)).toEqual(['chosen.id']);
    // And the allowed spellings really are allowed, so the filter is not
    // doing the whole job on its own.
    expect(valuesUnder('const b = { taxMinor: POS_SALE_TAX_MINOR, customerId: null };', 'taxMinor', TAX_MINOR_ALLOWED)).toEqual([]);
    expect(valuesUnder('const b = { taxMinor: POS_SALE_TAX_MINOR, customerId: null };', 'customerId', CUSTOMER_ID_ALLOWED)).toEqual([]);
  });
});
