import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ar from '@/messages/ar.json';
import en from '@/messages/en.json';
import tr from '@/messages/tr.json';
import { isS7Key, isS7WebFile, stripTsComments } from '../../../scripts/guards/merchant-jargon';
import { REPO_ROOT } from './helpers/refusal-codes';
import { referencedKeys, saleFlow, type SaleFlow } from './helpers/reach';

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
   * ── THE CUSTOMER RULES COVER THE SALE FLOW, NOT ALL OF S7 ───────────────
   *
   * OWNER RULING (DR-154/4, applied by the coordinator, provisional until the
   * owner's weekly review): no exemption, allowlist or skip for any check, and
   * the customers slice must be able to name a customer. The old rules said
   * "no S7 `.tsx`, no S7 key, `customerId` null only" over every S7 file and
   * namespace — a rule about WHERE WORDS LIVE. Two cheaper restatements were
   * tried and rejected on measurement:
   *
   *   - "everything the non-customers surfaces reach" fails, because the shared
   *     header reads `nav.customers` and every page renders the header;
   *   - "everything S7 except customers-only files" fails for the same reason.
   *
   * So the SUBJECT of these three rules (screen vocabulary, key vocabulary,
   * the library `customerId`-is-null rule) is redefined as what they were
   * always protecting: the SALE FLOW's own texts and key space — the till and
   * cash sale must not offer or name a customer; credit sale lives in the
   * customers slice. The tax rules and every other T-12 assertion above are
   * unchanged and still read all of S7.
   *
   * The subject is derived from the import graph; nothing is named:
   *
   *   - SALE-FLOW ENTRIES: page/layout/route files of the `pos` and `sales`
   *     route segments;
   *   - COMMON CHROME: the files every page that renders the shared shell
   *     reaches (an intersection — see `saleFlow` in `helpers/reach.ts`). The
   *     header and the shell fall out of that computation; a pre-auth page
   *     (login) renders no shell and is not one of the pages;
   *   - SUBJECT FILES: reach(sale-flow entries) minus the chrome, restricted
   *     to what `isS7WebFile` accepts (the existing definition, unchanged). A
   *     customers view the till imports is reached, is not chrome, and is
   *     flagged; customers code the sale flow does not import is not subject;
   *   - SUBJECT KEYS: every `isS7Key` key referenced from a subject file as a
   *     literal, or through `prefix.${…}` / `'prefix.' + …` (which references
   *     every key under the prefix), PLUS the namespaces the sale flow owns:
   *     `pos.`, `sales.` and `error.` (the refusal texts a till sale can meet).
   *     A key referenced only by chrome (`nav.customers` through the header's
   *     `nav.${item.key}`) is not the sale flow's.
   *
   * What this gives up, stated: a customer word in the chrome, or in a file
   * only another surface reaches, is no longer this law's business. The
   * controls below show it is the sale flow, including the shared components
   * the till renders, that is covered.
   */
  const CUSTOMER_WORD = /customer|عميل|عملاء|müşteri/i;
  const SALE_FLOW_NAMESPACES = ['pos.', 'sales.', 'error.'];
  const codeToken = new RegExp(`^(?:${RECEIVABLES_CODES.map((c) => c.replace(/[.]/g, '\\.')).join('|')})$`);

  interface CustomerLaw {
    readonly flow: SaleFlow;
    readonly subject: string[];
    readonly screens: string[];
    readonly libraries: string[];
    readonly s7Keys: string[];
    readonly keys: string[];
    readonly hits: string[];
  }

  function customerLaw(files: Record<string, string>, catalogs: Record<string, Record<string, string>>): CustomerLaw {
    const flow = saleFlow(files);
    const subject = [...flow.subject].filter((path) => isS7WebFile(path)).sort();
    const screens = subject.filter((path) => path.endsWith('.tsx'));
    const libraries = subject.filter((path) => !path.endsWith('.tsx'));
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
    const referenced = referencedKeys(
      subject.map((path) => files[path] ?? ''),
      s7Keys,
    );
    const keys = s7Keys.filter((key) => referenced.has(key) || SALE_FLOW_NAMESPACES.some((prefix) => key.startsWith(prefix)));
    for (const key of keys) {
      if (receivablesKey(key)) continue;
      for (const [locale, catalog] of Object.entries(catalogs)) {
        if (key in catalog && CUSTOMER_WORD.test(`${key} ${catalog[key]}`)) hits.push(`key ${locale}: ${key}`);
      }
    }
    return { flow, subject, screens, libraries, s7Keys, keys, hits };
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

  const SYNTHETIC_CATALOG = { en: { 'pos.title': 'Till', 'customers.title': 'Customers', 'stock.title': 'Stock', 'nav.stock': 'Stock' } };
  const A = 'apps/web/src/app/[locale]';
  const TILL = 'apps/web/src/views/pos/TillView.tsx';
  const HEADER = `${A}/AppHeader.tsx`;
  const PANEL = 'apps/web/src/views/common/Panel.tsx';
  const CV = 'apps/web/src/views/customers';
  /**
   * A web tree that contains a customers route, which main does not yet. Every
   * merchant page renders the header; login does not. `Panel` is a shared
   * component the till and a stock page both render, and is NOT chrome,
   * because the customers page does not.
   */
  function syntheticTree(extra: Record<string, string> = {}): Record<string, string> {
    return {
      [`${A}/pos/till/page.tsx`]:
        "import { TillView } from '@/views/pos/TillView';\nimport { PageShell } from '../../AppHeader';\nexport default () => PageShell + TillView;",
      [`${A}/stock/page.tsx`]:
        "import { StockView } from '../../../views/stock/StockView';\nimport { PageShell } from '../AppHeader';\nexport default () => PageShell + StockView;",
      [`${A}/customers/page.tsx`]:
        "import { CustomerListView } from '@/views/customers/CustomerListView';\nimport { PageShell } from '../AppHeader';\nexport default () => PageShell + CustomerListView;",
      [`${A}/login/page.tsx`]: "import { tiny } from '@/lib/tiny';\nexport default () => tiny;",
      'apps/web/src/lib/tiny.ts': 'export const tiny = 1;',
      [HEADER]: "import { pickLabel } from '@/lib/shared-label';\nexport const PageShell = () => pickLabel;",
      'apps/web/src/lib/shared-label.ts': 'export const pickLabel = 1;',
      [PANEL]: 'export const Panel = () => 1;',
      [TILL]:
        "import { sell } from '@/lib/phase4-pos-api';\nimport { Panel } from '@/views/common/Panel';\nexport const TillView = () => t('pos.title') + sell + Panel;",
      'apps/web/src/views/stock/StockView.tsx': "import { Panel } from '@/views/common/Panel';\nexport const StockView = () => t('stock.title') + Panel;",
      'apps/web/src/lib/phase4-pos-api.ts': 'export const sell = { customerId: null };',
      [`${CV}/CustomerListView.tsx`]:
        "import { CustomerAccountView } from './CustomerAccountView';\nexport const CustomerListView = () => t('customers.title') + CustomerAccountView;",
      [`${CV}/CustomerAccountView.tsx`]: 'export const CustomerAccountView = () => customer.name;',
      ...extra,
    };
  }

  it('SALE FLOW, unit level: the chrome and the subject are computed, and a customer word in the subject is flagged', () => {
    const clean = customerLaw(syntheticTree(), SYNTHETIC_CATALOG);
    // POSITIVE controls on the synthetic tree.
    expect(clean.hits).toEqual([]);
    expect(clean.flow.entries).toEqual([`${A}/pos/till/page.tsx`]);
    expect([...clean.flow.chrome].sort()).toEqual([HEADER, 'apps/web/src/lib/shared-label.ts']);
    expect(clean.flow.chromePages).not.toContain(`${A}/login/page.tsx`);
    expect(clean.flow.chromePages).toContain(`${A}/customers/page.tsx`);
    expect(clean.subject).toEqual([`${A}/pos/till/page.tsx`, 'apps/web/src/lib/phase4-pos-api.ts', PANEL, TILL].sort());
    expect(clean.keys).toEqual(['pos.title']);
    // The header is derived chrome: a word in it is not the sale flow's; the same word in the till, or in the shared Panel, is.
    expect(customerLaw(syntheticTree({ [HEADER]: 'export const PageShell = () => customer.nav;' }), SYNTHETIC_CATALOG).hits).toEqual([]);
    // NEGATIVE 1: a customer word in the till.
    expect(customerLaw(syntheticTree({ [TILL]: 'export const TillView = () => customer.name;' }), SYNTHETIC_CATALOG).hits).toEqual([`screen ${TILL}`]);
    // NEGATIVE 2: a customer word in a shared component the till renders that is NOT the chrome.
    expect(customerLaw(syntheticTree({ [PANEL]: 'export const Panel = () => customer.name;' }), SYNTHETIC_CATALOG).hits).toEqual([`screen ${PANEL}`]);
    // A surface the sale flow does not reach is not its subject.
    expect(
      customerLaw(syntheticTree({ 'apps/web/src/views/stock/StockView.tsx': 'export const StockView = () => customer.name;' }), SYNTHETIC_CATALOG).hits,
    ).toEqual([]);
    // Comments are stripped, as before.
    expect(customerLaw(syntheticTree({ [TILL]: '// walk-in, not a customer\nexport const TillView = 1;' }), SYNTHETIC_CATALOG).hits).toEqual([]);
    // Libraries: a buyer under customerId, and a customer balance.
    expect(
      customerLaw(syntheticTree({ 'apps/web/src/lib/phase4-pos-api.ts': 'export const sell = { customerId: chosen.id };' }), SYNTHETIC_CATALOG).hits,
    ).toEqual(['library customerId apps/web/src/lib/phase4-pos-api.ts: chosen.id']);
    expect(customerLaw(syntheticTree({ 'apps/web/src/lib/phase4-pos-api.ts': 'export const customerBalance = 1;' }), SYNTHETIC_CATALOG).hits).toEqual([
      'library vocabulary apps/web/src/lib/phase4-pos-api.ts: customerBalance',
    ]);
    // Customers code the sale flow does not import is not its subject, dead or not.
    expect(
      customerLaw(syntheticTree({ [`${CV}/CustomerOrphan.tsx`]: 'export const CustomerOrphan = () => customer.balance;' }), SYNTHETIC_CATALOG).hits,
    ).toEqual([]);
  });

  it('SALE FLOW, unit level: a customers view a sale-flow page imports becomes subject and is flagged', () => {
    const direct = customerLaw(
      syntheticTree({
        [`${A}/pos/till/page.tsx`]:
          "import { CustomerListView } from '@/views/customers/CustomerListView';\nimport { PageShell } from '../../AppHeader';\nexport default () => PageShell + CustomerListView;",
      }),
      SYNTHETIC_CATALOG,
    );
    expect(direct.subject).toEqual(expect.arrayContaining([`${CV}/CustomerListView.tsx`, `${CV}/CustomerAccountView.tsx`]));
    expect(direct.hits).toEqual(
      expect.arrayContaining([`screen ${CV}/CustomerAccountView.tsx`, `screen ${CV}/CustomerListView.tsx`, 'key en: customers.title']),
    );
    // Through the shared Panel, which is not chrome. (A customers view that EVERY merchant page reached would itself be chrome:
    // the badge here is imported by the Panel alone.)
    const viaPanel = customerLaw(
      syntheticTree({
        [PANEL]: "import { Badge } from '@/views/customers/CustomerBadge';\nexport const Panel = Badge;",
        [`${CV}/CustomerBadge.tsx`]: 'export const Badge = () => customer.name;',
      }),
      SYNTHETIC_CATALOG,
    );
    expect(viaPanel.hits).toEqual(expect.arrayContaining([`screen ${CV}/CustomerBadge.tsx`]));
    // Through a directory index.
    const viaIndex = customerLaw(
      syntheticTree({
        [TILL]: "import { X } from '../customers';\nexport const TillView = () => X;",
        [`${CV}/index.ts`]: "export { CustomerAccountView as X } from './CustomerAccountView';",
      }),
      SYNTHETIC_CATALOG,
    );
    expect(viaIndex.hits).toEqual(expect.arrayContaining([`screen ${CV}/CustomerAccountView.tsx`]));
    // The customers page, reaching its own views only, is not flagged.
    expect(customerLaw(syntheticTree(), SYNTHETIC_CATALOG).hits).toEqual([]);
  });

  it('SALE FLOW, unit level: keys — owned namespaces, run-time prefixes, and chrome-only keys', () => {
    const catalog = {
      en: { ...SYNTHETIC_CATALOG.en, 'error.sale.customer_required': 'Choose a customer', 'error.sale.ok': 'Fine', 'pos.buyer': 'Choose a customer' },
    };
    // An owned-namespace key is the sale flow's though no file names it.
    expect(customerLaw(syntheticTree(), catalog).hits).toEqual(['key en: error.sale.customer_required', 'key en: pos.buyer']);
    // A key built at run time references every key under its prefix, in a namespace the flow does not own.
    const dynamicCatalog = { en: { ...SYNTHETIC_CATALOG.en, 'invoices.status.customerOwes': 'Customer owes' } };
    expect(customerLaw(syntheticTree(), dynamicCatalog).hits).toEqual([]);
    expect(customerLaw(syntheticTree({ [PANEL]: 'export const Panel = (s) => t(`invoices.status.${s}`);' }), dynamicCatalog).hits).toEqual([
      'key en: invoices.status.customerOwes',
    ]);
    expect(customerLaw(syntheticTree({ [PANEL]: "export const Panel = (s) => t('invoices.status.' + s);" }), dynamicCatalog).hits).toEqual([
      'key en: invoices.status.customerOwes',
    ]);
    // The header builds `nav.${key}`: `nav.customers` is chrome-only, so it is not the sale flow's — and the day the till builds it too, it is.
    const navCatalog = { en: { ...SYNTHETIC_CATALOG.en, 'nav.customers': 'Customers' } };
    const nav = { [HEADER]: 'export const PageShell = (item) => t(`nav.${item.key}`);' };
    expect(customerLaw(syntheticTree(nav), navCatalog).hits).toEqual([]);
    expect(customerLaw(syntheticTree({ ...nav, [PANEL]: 'export const Panel = (item) => t(`nav.${item.key}`);' }), navCatalog).hits).toEqual([
      'key en: nav.customers',
    ]);
    // Customers-only key references do not make a key the sale flow's.
    expect(customerLaw(syntheticTree(), SYNTHETIC_CATALOG).keys).not.toContain('customers.title');
  });

  it('SALE FLOW, repository: no subject screen, library or key names a customer', () => {
    const files = repositorySources();
    const law = customerLaw(files, { ar, en, tr });
    const { flow } = law;
    // POSITIVE controls — a law that passes on an empty set is dead.
    expect(flow.entries.length, 'no sale-flow entry was found').toBeGreaterThan(1);
    expect(flow.chrome.size, 'no chrome was computed').toBeGreaterThan(3);
    // The exclusion is DERIVED, not named: the header and shell fall out of the intersection.
    expect(flow.chrome).toContain(HEADER);
    expect(files[HEADER]).toMatch(/export (?:function|const) PageShell\b/);
    // A pre-auth page renders no shell and is not one of the pages; a merchant page outside the S7 segments is.
    expect(flow.chromePages).not.toContain(`${A}/login/page.tsx`);
    expect(flow.chromePages).toContain(`${A}/structure/page.tsx`);
    expect(flow.merchantPages.length).toBeGreaterThan(10);
    for (const path of [
      'apps/web/src/views/pos/TillView.tsx',
      'apps/web/src/views/pos/RegisterView.tsx',
      'apps/web/src/lib/phase4-pos-api.ts',
      'apps/web/src/views/stock/parts.tsx',
    ]) {
      expect(law.subject, path).toContain(path);
      expect(flow.chrome.has(path), path).toBe(false);
    }
    expect(law.screens.length, 'the scan ran over too few screens').toBeGreaterThan(5);
    expect(law.libraries.length).toBeGreaterThan(1);
    expect(law.keys.length, "no key is the sale flow's").toBeGreaterThan(50);
    expect(law.keys).toContain('pos.title');
    expect(
      Object.keys(en)
        .filter((key) => key.startsWith('pos.'))
        .every((key) => law.keys.includes(key)),
    ).toBe(true);
    // The law itself.
    expect(law.hits).toEqual([]);
    // The receivables exemption is not vacuous and not a prefix: it covers a
    // real, non-empty, registered set, and every key it covers is in that set.
    const exempted = Object.keys(en).filter((key) => isS7Key(key) && receivablesKey(key));
    expect(exempted.length, 'the exemption covers no key, so it is hiding nothing and should be deleted').toBe(RECEIVABLES_CODES.length);
    expect(RECEIVABLES_CODES.length).toBeGreaterThan(0);
  });

  it('SALE FLOW, repository: a subject library sets customerId from null only, and names no other customer vocabulary', () => {
    const law = customerLaw(repositorySources(), { ar, en, tr });
    expect(law.libraries.length).toBeGreaterThan(1);
    expect(law.libraries).toContain('apps/web/src/lib/phase4-pos-api.ts');
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
