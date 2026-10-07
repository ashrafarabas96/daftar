/**
 * P4-S3 — EVERY POS-REACHABLE REFUSAL HAS MERCHANT TEXT IN ALL THREE LOCALES.
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
 * Two namespaces are covered: `pos.*` (the till) and `sale.*` (the basket, the
 * discount request and finish-sale). Not every `sale.*` code is reachable from
 * a POS screen, and the ones that are not are recorded as NAMED exclusions
 * below, each with its reason. That is the whole point of the exclusion list:
 * the four rules together are EXHAUSTIVE over both namespaces, so a code that
 * is neither texted nor named is red, and the next merge can always tell a
 * deliberate exclusion from an oversight.
 *
 * The rules:
 *
 *   1. every registered code in a covered namespace that is NOT excluded has
 *      non-blank merchant text in ar, en AND tr;
 *   2. no `error.<ns>.*` key names a code the registry does not declare (a
 *      dead key is a string a merchant can never be shown, and it hides a
 *      renamed code);
 *   3. the three catalogues agree on the key set of a covered namespace;
 *   4. the exclusion list is honest in both directions: every excluded code
 *      is really registered and really has no text in any locale, and every
 *      registered code is either texted or excluded — never silent.
 *
 * Rules 1, 2 and 4 are per namespace and go vacuous only for a namespace the
 * registry declares nothing in at all: on a tree where Agent A's POS block has
 * not merged, the `pos.*` keys are ahead of the registry rather than behind it,
 * and the `sale.*` half still bites in full. The moment the registry names its
 * first code in a namespace, every direction bites there too.
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
type Catalogues = Readonly<Record<Locale, Readonly<Record<string, string>>>>;

/** The refusal namespaces a P4-S3 POS screen renders text for. */
export const COVERED_NAMESPACES = ['pos', 'sale'] as const;

/**
 * Registered codes a POS screen deliberately gives NO text to, each with the
 * reason it is unreachable from this surface. They fall back to the glossary's
 * data-safe text, which is correct for a refusal the cashier cannot act on.
 *
 * An entry here is a CLAIM, checked by rule 4: a code named here must really
 * be registered (so a renamed code cannot hide behind a stale exclusion) and
 * must really have no text in any locale (so an exclusion cannot quietly
 * become a covered code). Adding a code to this list is therefore as visible
 * an act as writing text for it.
 */
export const EXCLUDED_CODES: Readonly<Record<string, string>> = {
  // OD-03 is OPEN and no agent may settle a tax rule. Writing merchant text
  // for this refusal would be inventing one, so it stays unkeyed on purpose.
  'sale.tax_policy_absent': 'OD-03 is open; a tax rule may not be invented here, so this code stays unkeyed',
  // Fields no POS screen sends, so no POS command can raise these.
  'sale.notes_invalid': 'the POS screens send no notes',
  //
  // `sale.document_date_in_future` WAS excluded here, on the reason "the POS
  // screens send no document date; the server dates the sale". That reason was
  // false, and it was false for a structural rather than an accidental
  // reason: `SaleCommitSchema.documentDate` is REQUIRED and has no default,
  // because `[[daftar-a-command-must-not-read-the-clock]]` — a financial
  // command whose fingerprint covers a server-resolved date is not idempotent.
  // So the CLIENT states the day, the register states it as
  // `localDateIso()`, and a device whose clock is ahead of the server's
  // reaches this refusal at the one moment a cashier can least afford a
  // generic sentence. It now has merchant text in ar, en and tr, and rule 4
  // is what forced the choice to be made rather than inherited.
  // The customers / receivables surface. A POS sale in P4-S3 is a walk-in cash
  // sale: the client names no customer, no terms, no currency and no rate.
  'sale.customer_not_found': 'the customers slice ships the screen that names a customer',
  'sale.customer_inactive': 'the customers slice ships the screen that names a customer',
  'sale.credit_requires_customer': 'the receivables slice ships selling on account',
  'sale.credit_not_permitted': 'the receivables slice ships selling on account',
  'sale.walkin_terms_forbidden': 'the POS screens send no terms at all, so this cannot be raised from here',
  'sale.due_date_invalid': 'the receivables slice ships the screen that sets a due date',
  'sale.currency_unknown': 'the POS screens send no currency; the business currency is the server’s answer',
  'sale.fx_rate_missing': 'the POS screens send no exchange rate and no foreign currency',
};

// ── Reading the two sides ────────────────────────────────────────────────

/**
 * The codes `SELLING_STATUS` declares, read out of the source text.
 *
 * The table is read as TEXT on purpose: importing the API module into a web
 * guard would drag the Nest graph in, and the point is to notice a code the
 * moment it is written down, including one written by another agent on another
 * branch that merged while nobody re-read it. The terminator is matched as
 * `\n} as const` without the semicolon, because the shipped table ends
 * `} as const satisfies Readonly<...>;` — and a terminator that is not found
 * is REFUSED rather than silently widened to the rest of the file, which
 * would read the doc-comment tables further down as registered codes.
 */
export function registeredCodes(source: string): readonly string[] {
  const start = source.indexOf('const SELLING_STATUS = {');
  if (start < 0) throw new Error(`${REGISTRY} no longer declares 'const SELLING_STATUS = {'`);
  const body = source.slice(start);
  const end = body.indexOf('\n} as const');
  if (end < 0) throw new Error(`${REGISTRY}: the SELLING_STATUS table does not end in '} as const'`);
  const codes = new Set<string>();
  for (const line of body.slice(0, end).split('\n')) {
    const match = /^ {2}'?([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)'?:/.exec(line);
    if (match !== null) codes.add(match[1] ?? '');
  }
  if (codes.size === 0) throw new Error(`no codes parsed out of ${REGISTRY}: the table's shape changed`);
  return [...codes].sort();
}

/** The members of a code list in one namespace. */
export function codesIn(codes: readonly string[], namespace: string): readonly string[] {
  return codes.filter((code) => code.startsWith(`${namespace}.`));
}

/** The `error.<namespace>.*` keys a catalogue carries. */
export function errorKeysIn(catalogue: Readonly<Record<string, string>>, namespace: string): readonly string[] {
  return Object.keys(catalogue)
    .filter((key) => key.startsWith(`error.${namespace}.`))
    .sort();
}

/** True when a catalogue carries real, non-blank text for a key. */
function hasText(catalogue: Readonly<Record<string, string>>, key: string): boolean {
  const value = catalogue[key];
  return typeof value === 'string' && value.trim() !== '';
}

// ── The rules ────────────────────────────────────────────────────────────

/** Rule 1: a line per registered, non-excluded code with no text in some locale. */
export function missingText(codes: readonly string[], catalogues: Catalogues, excluded: Readonly<Record<string, string>> = EXCLUDED_CODES): readonly string[] {
  const problems: string[] = [];
  for (const namespace of COVERED_NAMESPACES) {
    for (const code of codesIn(codes, namespace)) {
      if (Object.hasOwn(excluded, code)) continue;
      const key = `error.${code}`;
      const absent = LOCALES.filter((locale) => !hasText(catalogues[locale], key));
      if (absent.length > 0) problems.push(`${code} has no merchant text in ${absent.join(', ')} (key ${key})`);
    }
  }
  return problems;
}

/** Rule 2: a line per `error.<ns>.*` key naming a code the registry does not declare. Vacuous per namespace while the registry declares none there. */
export function deadKeys(codes: readonly string[], catalogues: Catalogues): readonly string[] {
  const problems: string[] = [];
  for (const namespace of COVERED_NAMESPACES) {
    const registered = new Set(codesIn(codes, namespace));
    if (registered.size === 0) continue;
    for (const locale of LOCALES) {
      for (const key of errorKeysIn(catalogues[locale], namespace)) {
        const code = key.slice('error.'.length);
        if (!registered.has(code)) problems.push(`${locale}.json names ${key}, which ${REGISTRY} does not declare`);
      }
    }
  }
  return problems;
}

/** Rule 3: a line per covered-namespace key that is not in all three catalogues. */
export function catalogueDisagreements(catalogues: Catalogues): readonly string[] {
  const problems: string[] = [];
  for (const namespace of COVERED_NAMESPACES) {
    const every = new Set(LOCALES.flatMap((locale) => errorKeysIn(catalogues[locale], namespace)));
    for (const key of [...every].sort()) {
      const absent = LOCALES.filter((locale) => !Object.hasOwn(catalogues[locale], key));
      if (absent.length > 0) problems.push(`${key} is missing from ${absent.join(', ')}`);
    }
  }
  return problems;
}

/**
 * Rule 4: the exclusion list is honest, and the two namespaces are covered
 * EXHAUSTIVELY — a registered code is either texted or named, never silent.
 */
export function exclusionProblems(
  codes: readonly string[],
  catalogues: Catalogues,
  excluded: Readonly<Record<string, string>> = EXCLUDED_CODES,
): readonly string[] {
  const problems: string[] = [];
  const registered = new Set(codes);
  for (const [code, reason] of Object.entries(excluded)) {
    if (!COVERED_NAMESPACES.some((namespace) => code.startsWith(`${namespace}.`)))
      problems.push(`${code} is excluded but is not in a covered namespace — the exclusion list only governs ${COVERED_NAMESPACES.join(', ')}`);
    else if (!registered.has(code)) problems.push(`${code} is excluded but ${REGISTRY} does not declare it — a stale exclusion hides a renamed code`);
    if (reason.trim() === '') problems.push(`${code} is excluded with no reason given`);
    const texted = LOCALES.filter((locale) => hasText(catalogues[locale], `error.${code}`));
    if (texted.length > 0) problems.push(`${code} is excluded but ${texted.join(', ')} carries text for it — it is covered, so take it off the exclusion list`);
  }
  // Exhaustiveness: nothing registered in a covered namespace is silent.
  for (const namespace of COVERED_NAMESPACES) {
    const inNamespace = codesIn(codes, namespace);
    if (inNamespace.length === 0) continue;
    for (const code of inNamespace) {
      if (Object.hasOwn(excluded, code)) continue;
      if (!LOCALES.some((locale) => hasText(catalogues[locale], `error.${code}`)))
        problems.push(`${code} is registered but is neither texted nor named in the exclusion list — an oversight is indistinguishable from a decision`);
    }
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
    // The `sale.*` half is live on every tree this guard runs on, whether or
    // not Agent A's `pos.*` block has merged yet.
    expect(codesIn(CODES, 'sale').length).toBeGreaterThan(20);
  });

  it('every registered, non-excluded code has merchant text in ar, en and tr', () => {
    expect(missingText(CODES, CATALOGUES)).toEqual([]);
  });

  it('no error.pos.* or error.sale.* key names a code the registry does not declare', () => {
    expect(deadKeys(CODES, CATALOGUES)).toEqual([]);
  });

  it('the three catalogues carry the same keys in both covered namespaces', () => {
    expect(catalogueDisagreements(CATALOGUES)).toEqual([]);
  });

  it('the exclusion list is honest and the covered namespaces are exhaustive', () => {
    expect(exclusionProblems(CODES, CATALOGUES)).toEqual([]);
  });

  it('the OD-03 tax code is excluded, named, and carries no text in any locale', () => {
    expect(Object.keys(EXCLUDED_CODES)).toContain('sale.tax_policy_absent');
    expect(EXCLUDED_CODES['sale.tax_policy_absent']).toMatch(/OD-03/);
    for (const locale of LOCALES) expect(CATALOGUES[locale]['error.sale.tax_policy_absent'], locale).toBeUndefined();
  });
});

describe('the rules are red when they should be (planted)', () => {
  const plantedRegistry = `const SELLING_STATUS = {
  'pos.session_not_open': 409,
  'pos.drawer_jammed': 409,
  'sale.discount_invalid': 422,
  'sale.cashier_sneezed': 422,
} as const satisfies Readonly<Record<string, number>>;
`;

  it('rule 1 names a registered code with no text anywhere', () => {
    const problems = missingText(registeredCodes(plantedRegistry), CATALOGUES);
    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toContain('pos.drawer_jammed');
    expect(problems.join('\n')).toContain('sale.cashier_sneezed');
    expect(problems[0]).toContain('ar, en, tr');
  });

  it('rule 1 names a registered code whose text is missing from one locale only', () => {
    const thin = { ...CATALOGUES, tr: Object.fromEntries(Object.entries(CATALOGUES.tr).filter(([key]) => key !== 'error.sale.discount_invalid')) };
    expect(missingText(['sale.discount_invalid'], thin)).toEqual(['sale.discount_invalid has no merchant text in tr (key error.sale.discount_invalid)']);
  });

  it('rule 1 names a registered code whose text is blank rather than absent', () => {
    const blank = { ...CATALOGUES, ar: { ...CATALOGUES.ar, 'error.sale.total_zero': '   ' } };
    expect(missingText(['sale.total_zero'], blank)).toEqual(['sale.total_zero has no merchant text in ar (key error.sale.total_zero)']);
  });

  it('rule 1 does NOT fire for a code that is on the exclusion list', () => {
    expect(missingText(['sale.tax_policy_absent'], CATALOGUES)).toEqual([]);
    // …and the same code fires the moment it is taken off the list.
    expect(missingText(['sale.tax_policy_absent'], CATALOGUES, {})).toEqual([
      'sale.tax_policy_absent has no merchant text in ar, en, tr (key error.sale.tax_policy_absent)',
    ]);
  });

  it('rule 2 names the dead keys in each namespace the registry knows', () => {
    const planted = registeredCodes(plantedRegistry);
    const problems = deadKeys(planted, CATALOGUES);
    // The planted registry knows ONE real code per namespace, so every other
    // key the catalogues carry in those namespaces is dead, in all three
    // locales. The expected count is DERIVED from the real key sets rather
    // than written down: a hand-written total goes stale the moment a code is
    // added, and a stale total is a test that stops meaning what it says.
    const expected =
      LOCALES.length *
      COVERED_NAMESPACES.reduce((total, namespace) => {
        const known = new Set(codesIn(planted, namespace));
        return total + errorKeysIn(CATALOGUES.en, namespace).filter((key) => !known.has(key.slice('error.'.length))).length;
      }, 0);
    expect(expected).toBeGreaterThan(20);
    expect(problems.length).toBe(expected);
    expect(problems.some((line) => line.includes('error.pos.branch_not_found'))).toBe(true);
    expect(problems.some((line) => line.includes('error.sale.product_not_priced'))).toBe(true);
    expect(problems.some((line) => line.includes('error.pos.session_not_open'))).toBe(false);
    expect(problems.some((line) => line.includes('error.sale.discount_invalid'))).toBe(false);
  });

  it('rule 2 stays silent for a namespace the registry declares nothing in, and bites in the other', () => {
    // No `pos.*` registered — the state before Agent A's block merges — so the
    // POS keys are ahead of the registry, not behind it, and are not dead.
    const saleOnly = codesIn(CODES, 'sale');
    const problems = deadKeys(saleOnly, CATALOGUES);
    expect(problems.some((line) => line.includes('error.pos.'))).toBe(false);
    expect(problems).toEqual([]);
  });

  it('rule 3 names a key one catalogue is missing, in either namespace', () => {
    const thinPos = { ...CATALOGUES, ar: Object.fromEntries(Object.entries(CATALOGUES.ar).filter(([key]) => key !== 'error.pos.branch_not_found')) };
    expect(catalogueDisagreements(thinPos)).toEqual(['error.pos.branch_not_found is missing from ar']);
    const thinSale = { ...CATALOGUES, tr: Object.fromEntries(Object.entries(CATALOGUES.tr).filter(([key]) => key !== 'error.sale.lines_required')) };
    expect(catalogueDisagreements(thinSale)).toEqual(['error.sale.lines_required is missing from tr']);
  });

  it('rule 4 names a stale exclusion for a code the registry does not declare', () => {
    const problems = exclusionProblems(CODES, CATALOGUES, { ...EXCLUDED_CODES, 'sale.renamed_away': 'why not' });
    expect(problems).toEqual([
      'sale.renamed_away is excluded but apps/api/src/modules/selling/selling-errors.ts does not declare it — a stale exclusion hides a renamed code',
    ]);
  });

  it('rule 4 names an exclusion that is in no covered namespace', () => {
    expect(exclusionProblems(CODES, CATALOGUES, { ...EXCLUDED_CODES, 'customer.not_found': 'not ours' })).toContainEqual(
      expect.stringContaining('is not in a covered namespace'),
    );
  });

  it('rule 4 names an exclusion given with no reason', () => {
    expect(exclusionProblems(CODES, CATALOGUES, { ...EXCLUDED_CODES, 'sale.tax_policy_absent': '  ' })).toContainEqual(
      expect.stringContaining('is excluded with no reason given'),
    );
  });

  it('rule 4 names a code that is excluded AND texted — the two claims cannot both stand', () => {
    const problems = exclusionProblems(CODES, CATALOGUES, { ...EXCLUDED_CODES, 'sale.discount_invalid': 'claimed unreachable' });
    expect(problems).toContainEqual(expect.stringContaining('is excluded but ar, en, tr carries text for it'));
  });

  it('rule 4 names a registered code that is neither texted nor excluded — silence is the defect', () => {
    const problems = exclusionProblems([...CODES, 'sale.brand_new_refusal'], CATALOGUES);
    expect(problems).toEqual([
      'sale.brand_new_refusal is registered but is neither texted nor named in the exclusion list — an oversight is indistinguishable from a decision',
    ]);
  });

  it('rule 4 cannot be satisfied by emptying the exclusion list', () => {
    const problems = exclusionProblems(CODES, CATALOGUES, {});
    expect(problems.length).toBe(Object.keys(EXCLUDED_CODES).length);
    for (const code of Object.keys(EXCLUDED_CODES)) expect(problems.join('\n')).toContain(code);
  });

  it('the registry parser refuses a table it cannot read rather than passing on zero codes', () => {
    expect(() => registeredCodes('export const nothing = 1;\n')).toThrow(/SELLING_STATUS/);
    expect(() => registeredCodes('const SELLING_STATUS = {\n} as const;\n')).toThrow(/no codes parsed/);
    // The real table ends `} as const satisfies …`, so a parser pinned to
    // `} as const;` would silently read the whole rest of the file.
    expect(() => registeredCodes("const SELLING_STATUS = {\n  'sale.x_y': 400,\n};\n")).toThrow(/does not end in/);
    expect(registeredCodes(plantedRegistry)).toEqual(['pos.drawer_jammed', 'pos.session_not_open', 'sale.cashier_sneezed', 'sale.discount_invalid']);
  });
});
