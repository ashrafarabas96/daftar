/**
 * §20, as an executed law: this package's source carries no production
 * pricing configuration.
 *
 * The owner's ruling: `OPEN-P5-05` is CONFIGURATION, not source-code policy —
 * "no hard-coded production plan price, add-on price, currency, retry schedule
 * or grace period", while "tests may use fixtures". So the subject of this law
 * is `src/` only, and the fixtures in `test/` are deliberately out of scope.
 *
 * ── Why three arms, and why one would be a false comfort ────────────────
 *
 * Arm A allowlists every numeric and bigint literal in `src/`, each with the
 * reason it is allowed. It catches a money-shaped number under any name:
 * `const X = 30_000n`.
 *
 * Arm A alone is not enough, because a planted constant can REUSE a value the
 * allowlist already permits for an unrelated reason — `const GRACE_HOURS = 12`
 * borrows the 12 that `monthsPerInterval` needs. So arm B scans declarations
 * whose NAME is a pricing or scheduling noun and refuses any that is
 * initialised from a literal at all. Between them, a hard-coded price is
 * caught either by its value or by its name.
 *
 * Arm C is the currency: a three-letter uppercase string literal. There are
 * none, and the point of the arm is that there must go on being none, because
 * a default currency in code is the one piece of pricing configuration that
 * looks harmless.
 *
 * ── Why the literals are read with a lexer and not with a regex ─────────
 *
 * Because `src/` is heavily commented, every module quotes migration numbers
 * (`0022`, `0043`) and ISO-8601 in prose, and a raw-text scan would be reading
 * prose as program. `test/helpers/lexer.ts` blanks comments and string bodies
 * first, offset-preserving, and `test/lexer.test.ts` holds its fixtures. A
 * law over unstripped source is satisfied — and violated — by a comment.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { blankOut, numericLiteralsOf, stringLiteralsOf } from './helpers/lexer';

const SRC = join(__dirname, '..', 'src');

const SOURCES: ReadonlyArray<readonly [string, string]> = readdirSync(SRC)
  .filter((f) => f.endsWith('.ts'))
  .sort()
  .map((f) => [f, readFileSync(join(SRC, f), 'utf8')] as const);

/**
 * Every numeric literal `src/` is permitted to contain, with the reason. A
 * value is listed once; the reason says why it is a calendar, a cap or a unit
 * conversion and not a price.
 *
 * Adding a line here is the deliberate act this law exists to force. A number
 * that is money has no reason that fits this column.
 */
const ALLOWED_NUMERIC: Readonly<Record<string, string>> = {
  '0': 'the origin of a count, an index or an amount',
  '0n': 'zero minor units',
  '1': 'one unit; a 1-based ordinal; the first element',
  '1n': 'one minor unit, in the HALF_EVEN rounding rule',
  '2': 'the two sides of a tie; a bounded two-step correction',
  '2n': 'the doubled remainder of the HALF_EVEN rounding rule',
  '4': 'the four-year step of the Gregorian leap rule',
  '6': 'the six months of a half-year, in a month-table index',
  '8': "the width of the fake provider's reference counter",
  '9': 'a month index in the 30/31-day table',
  '10n': 'the base of the money cap, written as 10n ** 18n',
  '11': 'a month index in the 30/31-day table',
  '12': 'the twelve months of a year',
  '18n': 'the exponent of the money cap, matching MAX_MONEY_MINOR',
  '28': 'February in a common year',
  '29': 'February in a leap year',
  '30': 'a 30-day month',
  '31': 'a 31-day month',
  '100': 'the century step of the Gregorian leap rule',
  '400': 'the quadricentennial step of the Gregorian leap rule',
  '500': "the maximum length of a credit adjustment's reason text",
  '3_600_000': 'milliseconds in an hour, converting a dunning offset stated in hours',
  '100_000': 'MAX_PERIOD_INDEX — the bound on how far a period may be walked',
  '1_000_000': 'MAX_ADDON_QUANTITY — the per-line cap on an add-on quantity',
};

/**
 * A declaration named like one of the five things §20 names. The pattern is
 * split because the five things have two different SHAPES: a plan price, an
 * add-on price, a retry schedule and a grace period are NUMBERS, and a
 * currency is a STRING. Checking both nouns against both shapes is what
 * produced this law's first two false positives — `DUNNING_GRACE_STATE =
 * 'grace_period'` is the NAME OF A SUBSCRIPTION STATE, owned by
 * `business_entitlements.state` and pinned to it by a test, and not a grace
 * period at all.
 */
const NUMERIC_NOUN = /(PRICE|PRICES|AMOUNT|FEE|FEES|COST|TARIFF|RETRY|RETRIES|GRACE|TRIAL|DISCOUNT|COUPON|SCHEDULE)/i;
const CURRENCY_NOUN = /(CURRENCY|CURRENCIES)/i;

/** `const NAME = <something>` / `let` / `var`, over blanked source. */
function initialisedDeclarations(source: string): Array<{ name: string; init: string }> {
  const blanked = blankOut(source);
  const out: Array<{ name: string; init: string }> = [];
  for (const m of blanked.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*([^;\n]*)/g)) {
    out.push({ name: m[1] as string, init: m[2] as string });
  }
  return out;
}

/**
 * Is the initialiser a BARE literal — a number, a bigint, a quoted string, or
 * a list of them, with nothing computed?
 *
 * Bareness is the test rather than "contains a literal", because a value
 * derived from an argument, a field or an index is the CALLER's, which is the
 * whole point of §20: configuration arrives, it is not written down. An
 * `init` arriving here is already blanked, so a string literal is a pair of
 * delimiters around spaces.
 */
function bareLiteral(init: string): { numeric: boolean; string: boolean } {
  const t = init
    .trim()
    .replace(/\s+as\s+const\s*$/, '')
    .trim();
  const inner = /^\[(.*)\]$/.exec(t)?.[1] ?? t;
  const parts = inner
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  if (parts.length === 0) return { numeric: false, string: false };
  const numeric = parts.every((x) => /^\d[\d_]*(?:\.\d+)?n?$/.test(x) || /^\d[\d_]*n?\s*\*\*\s*\d[\d_]*n?$/.test(x));
  const str = parts.every((x) => /^(['"`])\s*\1$/.test(x));
  return { numeric, string: str };
}

/** The §20 arm-B offences of one source file. */
export function pricingConfigOffences(source: string): string[] {
  const out: string[] = [];
  for (const d of initialisedDeclarations(source)) {
    const bare = bareLiteral(d.init);
    if (NUMERIC_NOUN.test(d.name) && bare.numeric) out.push(`${d.name} = ${d.init.trim()}`);
    if (CURRENCY_NOUN.test(d.name) && bare.string) out.push(`${d.name} = ${d.init.trim()}`);
  }
  return out;
}

describe('§20 arm A — every numeric literal in src is allowlisted with a reason', () => {
  it('finds literals at all (the extraction is not vacuous)', () => {
    const all = SOURCES.flatMap(([, s]) => numericLiteralsOf(s));
    expect(all.length).toBeGreaterThan(40);
    // Two values that must be found if the lexer is working: the money cap's
    // exponent, which lives in code, and a migration number, which lives only
    // in a comment and must therefore NOT be found.
    expect(all).toContain('18n');
    expect(all).not.toContain('0043');
  });

  it('contains no numeric literal outside the allowlist', () => {
    const offences: string[] = [];
    for (const [file, source] of SOURCES) {
      for (const lit of numericLiteralsOf(source)) {
        if (!(lit in ALLOWED_NUMERIC)) offences.push(`${file}: ${lit}`);
      }
    }
    expect(offences, 'a numeric literal in src is not in the §20 allowlist').toEqual([]);
  });

  it('has no allowlist entry that is money-shaped', () => {
    // The allowlist is the law's weak point: a wide entry would permit a
    // price. So the entries are themselves bounded — a calendar value, a
    // small ordinal, a unit conversion or a named cap, and nothing in the
    // range a plan price actually occupies.
    const PRICE_LIKE = Object.keys(ALLOWED_NUMERIC).filter((k) => {
      const n = Number(k.replace(/_/g, '').replace(/n$/, ''));
      return Number.isFinite(n) && n >= 1_000 && n <= 10_000_000 && k !== '3_600_000' && k !== '100_000' && k !== '1_000_000';
    });
    expect(PRICE_LIKE, 'an allowlist entry sits in the range a subscription price occupies').toEqual([]);
  });
});

describe('§20 arm B — no declaration named like pricing config is a bare literal', () => {
  it('finds declarations at all (the extraction is not vacuous)', () => {
    const names = SOURCES.flatMap(([, s]) => initialisedDeclarations(s)).map((d) => d.name);
    expect(names.length).toBeGreaterThan(30);
    expect(names).toContain('MAX_BILLING_MINOR');
  });

  it('catches the shapes it exists for', () => {
    // A detector that caught nothing would make the case below pass for every
    // possible source, so it is exercised against the five things §20 names.
    expect(pricingConfigOffences('const PRO_PLAN_PRICE_MINOR = 30_000n;')).toHaveLength(1);
    expect(pricingConfigOffences('const EXTRA_USER_PRICE = 1500;')).toHaveLength(1);
    expect(pricingConfigOffences('const GRACE_HOURS = 48;')).toHaveLength(1);
    expect(pricingConfigOffences('const RETRY_OFFSETS = [24, 72, 168] as const;')).toHaveLength(1);
    expect(pricingConfigOffences("const DEFAULT_CURRENCY = 'ILS';")).toHaveLength(1);
    expect(pricingConfigOffences('const TRIAL_DAYS = 14;')).toHaveLength(1);
  });

  it('does not catch what §20 does not forbid', () => {
    // The two false positives this law's first draft produced, kept as cases
    // so a later widening of the pattern re-earns them.
    //
    // A STATE NAME is not a grace period: the state vocabulary belongs to
    // `business_entitlements.state`, and `subscription-states.test.ts` pins
    // this package's restatement of it to the live CHECK.
    expect(pricingConfigOffences("const DUNNING_GRACE_STATE = 'grace_period';")).toEqual([]);
    // A value read off the caller's own input is the caller's, not config.
    expect(pricingConfigOffences('const currency = lines[0]?.currency;')).toEqual([]);
    expect(pricingConfigOffences('const graceHours = policy.graceHours;')).toEqual([]);
    // And a cap or a calendar constant is not a price, whatever its value.
    expect(pricingConfigOffences('const MAX_PERIOD_INDEX = 100_000;')).toEqual([]);
  });

  it('finds no such declaration in src', () => {
    const offences: string[] = [];
    for (const [file, source] of SOURCES) {
      for (const o of pricingConfigOffences(source)) offences.push(`${file}: ${o}`);
    }
    expect(offences, 'a pricing-shaped constant in src is a bare literal').toEqual([]);
  });
});

describe('§20 arm C — no currency is written into the source', () => {
  it('finds string literals at all (the extraction is not vacuous)', () => {
    const all = SOURCES.flatMap(([, s]) => stringLiteralsOf(s));
    expect(all.length).toBeGreaterThan(50);
    // A value that is in code, and one that is only in prose.
    expect(all).toContain('billing.invariant_violated');
    expect(all.some((l) => l.includes('MIGRATION PATCH REQUEST'))).toBe(false);
  });

  it('contains no three-letter uppercase currency code', () => {
    const offences: string[] = [];
    for (const [file, source] of SOURCES) {
      for (const lit of stringLiteralsOf(source)) {
        if (/^[A-Z]{3}$/.test(lit)) offences.push(`${file}: '${lit}'`);
      }
    }
    expect(offences, 'a currency code is written into src; a currency is configuration').toEqual([]);
  });
});
