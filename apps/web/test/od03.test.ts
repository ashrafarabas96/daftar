import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ar from '@/messages/ar.json';
import en from '@/messages/en.json';
import tr from '@/messages/tr.json';
import { isS7Key, isS7WebFile, stripTsComments } from '../../../scripts/guards/merchant-jargon';
import { REPO_ROOT } from './helpers/refusal-codes';
import { reachedFrom, s7EntryPoints } from './helpers/reach';

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
   * OFFER or NAME a customer. The customers slice (a customers route subtree)
   * is where that idea belongs, so a text rule over every S7 path fails the
   * day the slice ships — and a law that fails for the right code is the law
   * that gets disabled. DR-154/4 forbids the exemption, so the rule is
   * restated as REACH, with no path list and no key list:
   *
   *   - ENTRY POINTS: every page / layout / route file of an S7 merchant route
   *     segment (`MERCHANT_ROUTE_SEGMENTS`) other than `customers`;
   *   - REACHED: the transitive closure of their relative and `@/` imports
   *     (`.ts`/`.tsx`, through non-S7 shared files too, so a customers view
   *     cannot be laundered through a shared component);
   *   - SCANNED: reached files that `isS7WebFile` (the existing definition,
   *     unchanged) — shared generic infrastructure is not this law's subject;
   *   - KEYS: every catalogue key written as a string literal in a scanned
   *     file, that `isS7Key`.
   *
   * A customers view nothing in the till imports is not reached, so it is not
   * scanned BY CONSTRUCTION. The day a till page imports it, it is reached,
   * and it fails. The two controls (a non-empty reached set containing named
   * known files; a planted customer word that fails) are below.
   */
  const CUSTOMER_WORD = /customer|عميل|عملاء|müşteri/i;
  const KEY_LITERAL = /(['"`])([A-Za-z][\w-]*(?:\.[\w-]+)+)\1/g;
  const codeToken = new RegExp(`^(?:${RECEIVABLES_CODES.map((c) => c.replace(/[.]/g, '\\.')).join('|')})$`);

  interface CustomerLaw {
    readonly entries: string[];
    readonly reached: string[];
    readonly scanned: string[];
    readonly screens: string[];
    readonly libraries: string[];
    readonly keys: string[];
    readonly hits: string[];
  }

  function customerLaw(files: Record<string, string>, catalogs: Record<string, Record<string, string>>): CustomerLaw {
    const entries = s7EntryPoints(Object.keys(files));
    const reached = [...reachedFrom(files, entries)].sort();
    const scanned = reached.filter((path) => isS7WebFile(path));
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
    const known = new Set(Object.values(catalogs).flatMap((catalog) => Object.keys(catalog)));
    const keys = [
      ...new Set(
        scanned.flatMap((path) =>
          [...stripTsComments(files[path] ?? '').matchAll(KEY_LITERAL)].map((m) => m[2] ?? '').filter((key) => known.has(key) && isS7Key(key)),
        ),
      ),
    ].sort();
    for (const key of keys) {
      if (receivablesKey(key)) continue;
      for (const [locale, catalog] of Object.entries(catalogs)) {
        if (key in catalog && CUSTOMER_WORD.test(`${key} ${catalog[key]}`)) hits.push(`key ${locale}: ${key}`);
      }
    }
    return { entries, reached, scanned, screens, libraries, keys, hits };
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

  const SYNTHETIC_CATALOG = { en: { 'pos.title': 'Till', 'customers.title': 'Customers', 'pos.pickCustomer': 'Pick a customer', 'stock.title': 'Stock' } };
  const A = 'apps/web/src/app/[locale]';
  /** A web tree that contains a customers route, which main does not yet. */
  function syntheticTree(extra: Record<string, string> = {}): Record<string, string> {
    return {
      [`${A}/pos/till/page.tsx`]:
        "import { TillView } from '@/views/pos/TillView';\nimport { PageShell } from '../../AppHeader';\nexport default () => TillView;",
      [`${A}/stock/page.tsx`]: "import { StockView } from '../../../views/stock/StockView';\nexport default () => StockView;",
      [`${A}/AppHeader.tsx`]: "import { pickLabel } from '@/lib/shared-label';\nexport const PageShell = () => pickLabel;",
      'apps/web/src/lib/shared-label.ts': 'export const pickLabel = 1;',
      'apps/web/src/views/pos/TillView.tsx': "import { sell } from '@/lib/phase4-pos-api';\nexport const TillView = () => t('pos.title') + sell;",
      'apps/web/src/views/stock/StockView.tsx': "export const StockView = () => t('stock.title');",
      'apps/web/src/lib/phase4-pos-api.ts': 'export const sell = { customerId: null };',
      [`${A}/customers/page.tsx`]: "import { CustomerListView } from '@/views/customers/CustomerListView';\nexport default () => CustomerListView;",
      'apps/web/src/views/customers/CustomerListView.tsx':
        "import { CustomerAccountView } from './CustomerAccountView';\nexport const CustomerListView = () => t('customers.title') + CustomerAccountView;",
      'apps/web/src/views/customers/CustomerAccountView.tsx': 'export const CustomerAccountView = () => customer.name;',
      'apps/web/src/views/customers/CustomerOrphan.tsx': 'export const CustomerOrphan = () => customer.balance;',
      ...extra,
    };
  }

  it('REACH, unit level: a customer word in a reached file is flagged, and one nothing imports is not', () => {
    // POSITIVE control on the synthetic tree: the clean tree reaches the till
    // and passes, and it was not scanned over an empty set.
    const clean = customerLaw(syntheticTree(), SYNTHETIC_CATALOG);
    expect(clean.hits).toEqual([]);
    expect(clean.reached).toContain('apps/web/src/views/pos/TillView.tsx');
    expect(clean.reached).toContain('apps/web/src/lib/shared-label.ts');
    expect(clean.screens.length).toBeGreaterThan(0);
    expect(clean.libraries).toContain('apps/web/src/lib/phase4-pos-api.ts');
    expect(clean.keys).toEqual(['pos.title', 'stock.title']);
    // The customers route subtree is not an entry, and nothing in the till
    // imports it: neither it nor its views are reached, and the law is silent
    // about them although they name a customer on every line.
    for (const path of [
      'apps/web/src/views/customers/CustomerListView.tsx',
      'apps/web/src/views/customers/CustomerAccountView.tsx',
      'apps/web/src/views/customers/CustomerOrphan.tsx',
      `${A}/customers/page.tsx`,
    ]) {
      expect(clean.reached, path).not.toContain(path);
    }
    expect(clean.keys).not.toContain('customers.title');
    // NEGATIVE: a customer word planted in an actually-reached screen.
    const planted = customerLaw(syntheticTree({ 'apps/web/src/views/pos/TillView.tsx': 'export const TillView = () => customer.name;' }), SYNTHETIC_CATALOG);
    expect(planted.hits).toEqual(['screen apps/web/src/views/pos/TillView.tsx']);
    // The same word in a comment is not a name (comments are stripped, as before).
    expect(
      customerLaw(syntheticTree({ 'apps/web/src/views/pos/TillView.tsx': '// walk-in, not a customer\nexport const TillView = 1;' }), SYNTHETIC_CATALOG).hits,
    ).toEqual([]);
    // NEGATIVE: a library that sets customerId to a buyer, and one that names a balance.
    expect(
      customerLaw(syntheticTree({ 'apps/web/src/lib/phase4-pos-api.ts': 'export const sell = { customerId: chosen.id };' }), SYNTHETIC_CATALOG).hits,
    ).toEqual(['library customerId apps/web/src/lib/phase4-pos-api.ts: chosen.id']);
    expect(customerLaw(syntheticTree({ 'apps/web/src/lib/phase4-pos-api.ts': 'export const customerBalance = 1;' }), SYNTHETIC_CATALOG).hits).toEqual([
      'library vocabulary apps/web/src/lib/phase4-pos-api.ts: customerBalance',
    ]);
    // The same library planted where nothing reaches it: not flagged.
    expect(customerLaw(syntheticTree({ 'apps/web/src/lib/phase4-unused-api.ts': 'export const customerBalance = 1;' }), SYNTHETIC_CATALOG).hits).toEqual([]);
  });

  it('REACH, unit level: a customers view that a till page imports BECOMES reached and is flagged', () => {
    // Directly: the till page imports a customers view.
    const direct = customerLaw(
      syntheticTree({
        [`${A}/pos/till/page.tsx`]: "import { CustomerListView } from '@/views/customers/CustomerListView';\nexport default () => CustomerListView;",
      }),
      SYNTHETIC_CATALOG,
    );
    expect(direct.reached).toContain('apps/web/src/views/customers/CustomerListView.tsx');
    // Transitively: the view imports a sibling, which is then reached too.
    expect(direct.reached).toContain('apps/web/src/views/customers/CustomerAccountView.tsx');
    expect(direct.hits).toEqual(
      expect.arrayContaining([
        'screen apps/web/src/views/customers/CustomerAccountView.tsx',
        'screen apps/web/src/views/customers/CustomerListView.tsx',
        'key en: customers.title',
      ]),
    );
    // The orphan nothing imports is still not reached, so it is still not flagged.
    expect(direct.reached).not.toContain('apps/web/src/views/customers/CustomerOrphan.tsx');
    expect(direct.hits.some((hit) => hit.includes('CustomerOrphan'))).toBe(false);
    // Through a NON-S7 shared file (the header): reached all the same.
    const viaShared = customerLaw(
      syntheticTree({
        [`${A}/AppHeader.tsx`]: "import { CustomerAccountView } from '@/views/customers/CustomerAccountView';\nexport const PageShell = CustomerAccountView;",
      }),
      SYNTHETIC_CATALOG,
    );
    expect(viaShared.hits).toEqual(['screen apps/web/src/views/customers/CustomerAccountView.tsx']);
    // Through a relative import written with a directory index.
    const viaIndex = customerLaw(
      syntheticTree({
        [`${A}/stock/page.tsx`]: "import { X } from '../../../views/customers';\nexport default () => X;",
        'apps/web/src/views/customers/index.ts': "export { CustomerOrphan as X } from './CustomerOrphan';",
      }),
      SYNTHETIC_CATALOG,
    );
    expect(viaIndex.reached).toContain('apps/web/src/views/customers/CustomerOrphan.tsx');
    // The importing page is flagged too: a till-side path that spells `customers` names one.
    expect(viaIndex.hits).toEqual(expect.arrayContaining(['screen apps/web/src/views/customers/CustomerOrphan.tsx', `screen ${A}/stock/page.tsx`]));
    // A till screen that names a customer KEY it does not import a view for.
    const keyed = customerLaw(
      syntheticTree({ 'apps/web/src/views/pos/TillView.tsx': "export const TillView = () => t('pos.pickCustomer');" }),
      SYNTHETIC_CATALOG,
    );
    expect(keyed.hits).toEqual(['screen apps/web/src/views/pos/TillView.tsx', 'key en: pos.pickCustomer']);
    // A key whose NAME is innocent but whose VALUE offers a customer is caught by the value.
    const byValue = customerLaw(syntheticTree({ 'apps/web/src/views/pos/TillView.tsx': "export const TillView = () => t('pos.buyer');" }), {
      en: { ...SYNTHETIC_CATALOG.en, 'pos.buyer': 'Choose a customer' },
    });
    expect(byValue.hits).toEqual(['key en: pos.buyer']);
    // A customers page is not an entry: it reaches its own views without any hit.
    const own = customerLaw(syntheticTree(), SYNTHETIC_CATALOG);
    expect(own.entries).not.toContain(`${A}/customers/page.tsx`);
    expect(own.entries).toContain(`${A}/pos/till/page.tsx`);
  });

  it('REACH, repository: no screen reached from the till, stock, purchasing, suppliers or sales surfaces names a customer', () => {
    const files = repositorySources();
    const law = customerLaw(files, { ar, en, tr });
    // POSITIVE controls — a law that passes on an empty set is dead.
    expect(law.entries.length, 'no S7 entry point was found').toBeGreaterThan(10);
    expect(law.entries.every((entry) => !entry.includes('/customers/'))).toBe(true);
    expect(law.reached).toContain('apps/web/src/views/pos/TillView.tsx');
    expect(law.reached).toContain('apps/web/src/views/pos/RegisterView.tsx');
    expect(law.reached).toContain('apps/web/src/lib/phase4-pos-api.ts');
    expect(law.reached).toContain('apps/web/src/views/stock/parts.tsx');
    expect(law.screens.length, 'the scan ran over too few screens').toBeGreaterThan(10);
    expect(law.libraries.length).toBeGreaterThan(2);
    expect(law.keys.length, 'no catalogue key was reached').toBeGreaterThan(20);
    expect(law.keys).toContain('pos.title');
    // The law itself.
    expect(law.hits).toEqual([]);
    // The receivables exemption is not vacuous and not a prefix: it covers a
    // real, non-empty, registered set, and every key it covers is in that set.
    const exempted = Object.keys(en).filter((key) => isS7Key(key) && receivablesKey(key));
    expect(exempted.length, 'the exemption covers no key, so it is hiding nothing and should be deleted').toBe(RECEIVABLES_CODES.length);
    expect(RECEIVABLES_CODES.length).toBeGreaterThan(0);
  });

  it('REACH, repository: a reached library sets customerId from null only, and names no other customer vocabulary', () => {
    const law = customerLaw(repositorySources(), { ar, en, tr });
    expect(law.libraries.length).toBeGreaterThan(2);
    expect(law.libraries).toContain('apps/web/src/lib/phase4-pos-api.ts');
    // `SaleCommitSchema` requires `customerId`, and `null` IS the walk-in a
    // till sale is. Any other value would be a POS screen naming a buyer.
    // A library may name a receivables refusal CODE (`phase3-errors.ts`
    // classifies which of them a retry may repeat) and nothing else of a
    // customer: the exemption is the exact registered code strings.
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
