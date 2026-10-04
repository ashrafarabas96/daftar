import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ar from '@/messages/ar.json';
import en from '@/messages/en.json';
import tr from '@/messages/tr.json';
import { isS7Key, isS7WebFile, stripTsComments } from '../../../scripts/guards/merchant-jargon';
import { REPO_ROOT } from './helpers/refusal-codes';

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

  it('no S7 screen names a customer, and no S7 key does except to answer a receivables refusal', () => {
    const catalogHits = Object.entries({ ar, en, tr }).flatMap(([locale, catalog]) =>
      Object.entries(catalog)
        .filter(([key, value]) => isS7Key(key) && !receivablesKey(key) && /customer|عميل|عملاء|müşteri/i.test(`${key} ${value}`))
        .map(([key]) => `${locale}: ${key}`),
    );
    expect(catalogHits).toEqual([]);
    // The exemption is not vacuous and not a prefix: it covers a real,
    // non-empty, registered set, and every key it covers is in that set.
    const exempted = Object.keys(en).filter((key) => isS7Key(key) && receivablesKey(key));
    expect(exempted.length, 'the exemption covers no key, so it is hiding nothing and should be deleted').toBe(RECEIVABLES_CODES.length);
    expect(RECEIVABLES_CODES.length).toBeGreaterThan(0);
    // No SCREEN names a customer: the screen that names one ships with the
    // customers slice, and until then no merchant surface offers the idea.
    const screens = Object.entries(s7Sources()).filter(([path]) => path.endsWith('.tsx'));
    expect(screens.length).toBeGreaterThan(10);
    expect(screens.filter(([, src]) => /customer/i.test(stripTsComments(src))).map(([path]) => path)).toEqual([]);
  });

  it('a client library may carry the walk-in customerId, and may set it from nothing but null', () => {
    const libraries = Object.entries(s7Sources()).filter(([path]) => !path.endsWith('.tsx'));
    expect(libraries.length).toBeGreaterThan(2);
    // `SaleCommitSchema` requires `customerId`, and `null` IS the walk-in a
    // till sale is. Any other value would be a POS screen naming a buyer,
    // which would also need `receivables.view` and a customer read that P4-S3
    // does not own.
    const assigned = libraries.flatMap(([path, src]) => valuesUnder(src, 'customerId', CUSTOMER_ID_ALLOWED).map((value) => `${path}: ${value}`));
    expect(assigned).toEqual([]);
    // And no other customer vocabulary leaks into a library either: a name, a
    // balance, a credit limit or a list is the customers slice's, not this one's.
    // A library may now also name a receivables refusal CODE, because
    // `phase3-errors.ts` classifies which of them a retry may repeat. That is
    // the only widening: a customer's NAME, BALANCE, CREDIT LIMIT or LIST in a
    // client library still fails, and so does a `customerName` or a
    // `customerBalance` identifier, because the exemption is the exact
    // registered code strings and nothing else.
    const codeToken = new RegExp(`^(?:${RECEIVABLES_CODES.map((c) => c.replace(/[.]/g, '\\.')).join('|')})$`);
    const other = libraries.flatMap(([path, src]) =>
      [...stripTsComments(src).matchAll(/\b[Cc]ustomer\w*(?:\.[a-z_]+)?/g)]
        .map((m) => `${path}: ${m[0]}`)
        .filter((hit) => hit.endsWith(': customerId') === false && codeToken.test(hit.slice(hit.indexOf(': ') + 2)) === false),
    );
    expect(other).toEqual([]);
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
