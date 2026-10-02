/**
 * P4-S3 — EVERY REGISTERED POS REFUSAL HAS MERCHANT TEXT IN ALL THREE LOCALES.
 *
 * A POS screen never renders a code or an `ApiError.message`: it renders
 * `t(refusalKey(error))`, and `refusalKey` falls back to the glossary's "data
 * safe" text for a code the catalogue does not know. That fallback is a safe
 * failure, not a correct one — the cashier is told nothing about WHY the till
 * refused, which at a counter with a customer waiting is the difference
 * between a fixable mistake and a dead till.
 *
 * `scripts/check-localization.ts` cannot catch this: it checks that every KEY
 * present in one locale is present in the other two, and a code with no key
 * anywhere is present nowhere. So the registry itself is the enumeration, and
 * this guard reads it out of the API's canonical table — `SELLING_STATUS` in
 * `apps/api/src/modules/selling/selling-errors.ts` — rather than out of a list
 * kept by hand beside it.
 *
 * The rules:
 *
 *   1. every `pos.*` code the registry declares has `error.pos.<rest>` in
 *      ar, en AND tr;
 *   2. no `error.pos.*` key names a code the registry does not declare (a
 *      dead key is a string a merchant can never be shown, and it hides a
 *      renamed code);
 *   3. the three catalogues agree on the `error.pos.*` key set.
 *
 * Rule 2 is deliberately VACUOUS while the registry declares no `pos.*` code
 * at all: on this commit Agent A's POS block has not merged, so the keys are
 * ahead of the registry rather than behind it. The moment the registry names
 * its first POS code both directions bite, and neither can be satisfied by
 * leaving something out.
 *
 * Each rule is a pure function over (registry source, catalogues), so each is
 * shown RED on a planted copy rather than asserted to be green.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '../..');
const REGISTRY = 'apps/api/src/modules/selling/selling-errors.ts';
const LOCALES = ['ar', 'en', 'tr'] as const;
type Locale = (typeof LOCALES)[number];

// ── Reading the two sides ────────────────────────────────────────────────

/**
 * The codes `SELLING_STATUS` declares, read out of the source text.
 *
 * The table is read as TEXT on purpose: importing the API module into a web
 * guard would drag the Nest graph in, and the point is to notice a code the
 * moment it is written down, including one written by another agent on another
 * branch that merged while nobody re-read it.
 */
export function registeredCodes(source: string): readonly string[] {
  const start = source.indexOf('const SELLING_STATUS = {');
  if (start < 0) throw new Error(`${REGISTRY} no longer declares 'const SELLING_STATUS = {'`);
  const body = source.slice(start);
  const end = body.indexOf('\n} as const;');
  const table = end < 0 ? body : body.slice(0, end);
  const codes = new Set<string>();
  for (const line of table.split('\n')) {
    const match = /^ {2}'?([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)'?:/.exec(line);
    if (match !== null) codes.add(match[1] ?? '');
  }
  if (codes.size === 0) throw new Error(`no codes parsed out of ${REGISTRY}: the table's shape changed`);
  return [...codes].sort();
}

/** The `pos.*` members of a code list. */
export function posCodes(codes: readonly string[]): readonly string[] {
  return codes.filter((code) => code.startsWith('pos.'));
}

/** The `error.pos.*` keys a catalogue carries. */
export function posErrorKeys(catalogue: Readonly<Record<string, string>>): readonly string[] {
  return Object.keys(catalogue)
    .filter((key) => key.startsWith('error.pos.'))
    .sort();
}

// ── The rules ────────────────────────────────────────────────────────────

/** Rule 1: a line per registered `pos.*` code with no text in some locale. */
export function missingText(codes: readonly string[], catalogues: Readonly<Record<Locale, Readonly<Record<string, string>>>>): readonly string[] {
  const problems: string[] = [];
  for (const code of posCodes(codes)) {
    const key = `error.${code}`;
    const absent = LOCALES.filter((locale) => {
      const value = catalogues[locale][key];
      return typeof value !== 'string' || value.trim() === '';
    });
    if (absent.length > 0) problems.push(`${code} has no merchant text in ${absent.join(', ')} (key ${key})`);
  }
  return problems;
}

/** Rule 2: a line per `error.pos.*` key naming a code the registry does not declare. Vacuous while the registry declares none. */
export function deadKeys(codes: readonly string[], catalogues: Readonly<Record<Locale, Readonly<Record<string, string>>>>): readonly string[] {
  const registered = new Set(posCodes(codes));
  if (registered.size === 0) return [];
  const problems: string[] = [];
  for (const locale of LOCALES) {
    for (const key of posErrorKeys(catalogues[locale])) {
      const code = key.slice('error.'.length);
      if (!registered.has(code)) problems.push(`${locale}.json names ${key}, which ${REGISTRY} does not declare`);
    }
  }
  return problems;
}

/** Rule 3: a line per `error.pos.*` key that is not in all three catalogues. */
export function catalogueDisagreements(catalogues: Readonly<Record<Locale, Readonly<Record<string, string>>>>): readonly string[] {
  const every = new Set(LOCALES.flatMap((locale) => posErrorKeys(catalogues[locale])));
  const problems: string[] = [];
  for (const key of [...every].sort()) {
    const absent = LOCALES.filter((locale) => !Object.hasOwn(catalogues[locale], key));
    if (absent.length > 0) problems.push(`${key} is missing from ${absent.join(', ')}`);
  }
  return problems;
}

// ── The tree as it stands ────────────────────────────────────────────────

const registrySource = readFileSync(join(REPO, REGISTRY), 'utf8');
const CODES = registeredCodes(registrySource);
const CATALOGUES = Object.fromEntries(
  LOCALES.map((locale) => [locale, JSON.parse(readFileSync(join(REPO, `apps/web/src/messages/${locale}.json`), 'utf8')) as Record<string, string>]),
) as Record<Locale, Record<string, string>>;

describe('the POS refusal catalogue is enumerated from the API registry', () => {
  it('the registry is readable and declares the selling vocabulary', () => {
    expect(CODES.length).toBeGreaterThan(40);
    expect(CODES).toContain('sale.discount_invalid');
  });

  it('every registered pos.* code has merchant text in ar, en and tr', () => {
    expect(missingText(CODES, CATALOGUES)).toEqual([]);
  });

  it('no error.pos.* key names a code the registry does not declare', () => {
    expect(deadKeys(CODES, CATALOGUES)).toEqual([]);
  });

  it('the three catalogues carry the same error.pos.* keys', () => {
    expect(catalogueDisagreements(CATALOGUES)).toEqual([]);
  });
});

describe('the rules are red when they should be (planted)', () => {
  const plantedRegistry = `const SELLING_STATUS = {
  'pos.session_not_open': { status: 409 },
  'pos.drawer_jammed': { status: 409 },
  'sale.discount_invalid': { status: 422 },
} as const;
`;

  it('rule 1 names a registered code with no text anywhere', () => {
    const problems = missingText(registeredCodes(plantedRegistry), CATALOGUES);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('pos.drawer_jammed');
    expect(problems[0]).toContain('ar, en, tr');
  });

  it('rule 1 names a registered code whose text is missing from one locale only', () => {
    const thin = { ...CATALOGUES, tr: Object.fromEntries(Object.entries(CATALOGUES.tr).filter(([key]) => key !== 'error.pos.session_not_open')) };
    const problems = missingText(CODES.concat('pos.session_not_open').sort(), thin);
    expect(problems).toEqual(['pos.session_not_open has no merchant text in tr (key error.pos.session_not_open)']);
  });

  it('rule 1 names a registered code whose text is blank rather than absent', () => {
    const blank = { ...CATALOGUES, ar: { ...CATALOGUES.ar, 'error.pos.session_not_open': '   ' } };
    const problems = missingText(['pos.session_not_open'], blank);
    expect(problems).toEqual(['pos.session_not_open has no merchant text in ar (key error.pos.session_not_open)']);
  });

  it('rule 2 names the dead keys once the registry declares any pos code', () => {
    const problems = deadKeys(registeredCodes(plantedRegistry), CATALOGUES);
    // The planted registry knows two POS codes; the ten real keys it does not
    // know are dead, in each of the three catalogues.
    expect(problems.length).toBe(30);
    expect(problems.some((line) => line.includes('error.pos.branch_not_found'))).toBe(true);
    expect(problems.some((line) => line.includes('error.pos.session_not_open'))).toBe(false);
  });

  it('rule 2 stays silent while the registry declares no pos code at all', () => {
    expect(deadKeys(['sale.discount_invalid'], CATALOGUES)).toEqual([]);
  });

  it('rule 3 names a key one catalogue is missing', () => {
    const thin = { ...CATALOGUES, ar: Object.fromEntries(Object.entries(CATALOGUES.ar).filter(([key]) => key !== 'error.pos.branch_not_found')) };
    expect(catalogueDisagreements(thin)).toEqual(['error.pos.branch_not_found is missing from ar']);
  });

  it('the registry parser refuses a table it cannot read rather than passing on zero codes', () => {
    expect(() => registeredCodes('export const nothing = 1;\n')).toThrow(/SELLING_STATUS/);
    expect(() => registeredCodes('const SELLING_STATUS = {\n} as const;\n')).toThrow(/no codes parsed/);
  });
});
