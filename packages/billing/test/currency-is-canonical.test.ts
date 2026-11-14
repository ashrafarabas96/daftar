/**
 * ROUND 11 — the currency set is a TABLE, and precision is a column of it.
 *
 * The independent challenger's §5 cross-check against the frozen schema
 * raised this as a P3: `currencies` is defined in `0001_platform.sql` with
 * `minor_units CHECK (minor_units BETWEEN 0 AND 3)` and seven seeded rows,
 * and `businesses.base_currency` references it — while this package only
 * checked that a code is three upper-case letters. Two consequences, both
 * real: `ZZZ` passed every check in the package and names no currency, and
 * nothing here knew that **JOD has three minor units** while the other six
 * seeded currencies have two.
 *
 * What was done about it, and what was deliberately NOT done:
 *
 *   * The scratch DDL now carries `p5scratch.currencies` copied from the
 *     frozen seed, and the invoice and ledger relations key their `currency`
 *     to it (`si_currency_fk`, `pca_currency_fk`), so membership of the
 *     canonical set is a KEY and the regular expression is only the cheap
 *     first answer. `test/db/credit-ledger-checks.test.ts` proves both.
 *   * This file pins that fixture seed to the frozen one, in both
 *     directions, so the copy cannot drift — the same discipline
 *     `test/subscription-states.test.ts` applies to the state set.
 *   * The package's own arithmetic is NOT given a precision. Every amount
 *     it handles is an integer in minor units from end to end: it never
 *     divides by a power of ten, never formats, and never parses a decimal
 *     string, so there is no computation here that a wrong precision could
 *     spoil. The law below asserts that absence rather than claiming it, by
 *     scanning `src/` for a power-of-ten divisor or multiplier.
 *   * Precision therefore belongs to whoever renders or parses money —
 *     the merchant portal and the API — and it must come from this table.
 *     That surface is `WAITING_FOR_INTEGRATED_SURFACE` and is not in this
 *     package, so the honest closure is this pin plus the stated boundary,
 *     not a formatter invented here for a caller that does not exist yet.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { blankOut, numericLiteralsOf } from './helpers/lexer';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'infrastructure', 'database', 'migrations');
const SRC = join(__dirname, '..', 'src');
// ROUND 12: the borrowed relations, the currency seed among them, moved out
// of the requested DDL into a fixture file of their own, so that the SAME
// requested DDL applies in the fixture lane and on the real migrated schema.
// This pin follows them, and it stays a pin on a FIXTURE: in the real lane
// the rows are the frozen ones themselves, which is a stronger claim and a
// different one.
const FIXTURE_DDL = join(__dirname, 'db', 'sql', 'credit-ledger-fixture.sql');

interface CurrencyRow {
  readonly code: string;
  readonly numericCode: string;
  readonly minorUnits: number;
}

/** Every `INSERT INTO currencies … VALUES` row in the frozen migrations. */
function frozenCurrencies(): { rows: CurrencyRow[]; file: string } {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  let found: { rows: CurrencyRow[]; file: string } | null = null;
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const insert = /INSERT\s+INTO\s+currencies\s*\([^)]*\)\s*VALUES([\s\S]*?);/i.exec(sql);
    if (!insert?.[1]) continue;
    const rows = [...insert[1].matchAll(/\(\s*'([A-Z]{3})'\s*,\s*'(\d{3})'\s*,\s*(\d)\s*\)/g)].map((m) => ({
      code: m[1] ?? '',
      numericCode: m[2] ?? '',
      minorUnits: Number(m[3]),
    }));
    if (rows.length > 0) found = { rows, file };
  }
  if (!found) throw new Error('no currency seed was found in the migrations — the extractor has nothing to compare');
  return found;
}

/** The same rows, as the scratch fixture seeds them. */
function fixtureCurrencies(): CurrencyRow[] {
  const sql = readFileSync(FIXTURE_DDL, 'utf8');
  const insert = /INSERT\s+INTO\s+p5scratch\.currencies\s*\([^)]*\)\s*VALUES([\s\S]*?);/i.exec(sql);
  expect(insert?.[1], 'the scratch fixture seeds no currencies — the pin below would be vacuous').toBeTruthy();
  return [...(insert?.[1] ?? '').matchAll(/\(\s*'([A-Z]{3})'\s*,\s*'(\d{3})'\s*,\s*(\d)\s*\)/g)].map((m) => ({
    code: m[1] ?? '',
    numericCode: m[2] ?? '',
    minorUnits: Number(m[3]),
  }));
}

const byCode = (rows: readonly CurrencyRow[]): CurrencyRow[] => [...rows].sort((a, b) => a.code.localeCompare(b.code));

describe('the canonical currency set', () => {
  it('is found in a migration this slice did not write', () => {
    const frozen = frozenCurrencies();
    expect(frozen.file).toMatch(/^\d{4}_/);
    expect(frozen.rows.length, 'the currency extractor came back short').toBeGreaterThanOrEqual(7);
  });

  it('carries a currency whose precision is NOT two, which is why no precision is assumed here', () => {
    const frozen = frozenCurrencies();
    const odd = frozen.rows.filter((r) => r.minorUnits !== 2);
    // JOD, three minor units. One row is enough to make "divide by 100"
    // wrong, and that is the whole argument for integer minor units.
    expect(odd.map((r) => `${r.code}=${r.minorUnits}`)).toStrictEqual(['JOD=3']);
  });

  it('is copied into the scratch fixture without drift, in both directions', () => {
    const frozen = byCode(frozenCurrencies().rows);
    const fixture = byCode(fixtureCurrencies());
    expect(fixture, 'the scratch currency fixture has drifted from the frozen seed').toStrictEqual(frozen);
  });
});

describe('this package assumes no currency precision', () => {
  // THE SCAN, factored out so that the prohibition and its witness call THE
  // SAME CODE. Before this, the witness below carried its own COPY of the
  // first pattern and the second pattern had no witness at all -- and a
  // control that exercises a copy certifies the copy, not the law. Both
  // patterns now live here once, and every caller gets them by calling.
  //
  // A power-of-ten literal next to a `/` or `*` is what a hidden precision
  // looks like in this package: there is no other reason to scale an integer
  // in minor units.
  //
  // `**` is excluded deliberately: `10n ** 18n` in `types.ts` is the MONEY
  // CAP, an upper bound on an amount, not a scale between a major and a minor
  // unit. Excluding the exponent operator is the narrowest exclusion that
  // admits it, and the witnesses below prove the scan still sees a real `*`
  // and a real `/`, on BOTH sides of the literal.
  const scalesByPowerOfTen = (source: string): string[] => {
    const code = blankOut(source);
    const found: string[] = [];
    // The capture group is mandatory in both patterns, so a match always
    // carries it; this explicit narrowing is what `noUncheckedIndexedAccess`
    // asks for. It is a NARROWING and not a default: `?? ''` would push an
    // empty name into `found`, and the law would then report an offence
    // whose literal it could not name.
    for (const m of code.matchAll(/(?<![*/])[*/](?!\*)\s*(10{1,}0*n?)\b/g)) {
      const literal = m[1];
      if (literal !== undefined) found.push(literal);
    }
    for (const m of code.matchAll(/\b(10{1,}0*n?)\s*[*/](?!\*)/g)) {
      const literal = m[1];
      if (literal !== undefined) found.push(literal);
    }
    return found;
  };

  // And the input set, read once and asserted non-empty BEFORE any zero from
  // it is believed. A scan over no files reports no offences, and that empty
  // green is indistinguishable from a clean tree unless this says otherwise
  // (RULE-18: an empty probe is not a zero).
  const srcFiles = (): string[] => readdirSync(SRC).filter((f) => f.endsWith('.ts'));

  it('scans a non-empty set of source files, so its zero means something', () => {
    const files = srcFiles();
    expect(files.length, 'the src/ scan came back with no files to read, so its zero is blind').toBeGreaterThan(10);
    expect(files, 'the money types are where the cap lives; a scan that cannot see them is not this scan').toContain('types.ts');
  });

  it('divides by no power of ten and multiplies by none', () => {
    const offences: string[] = [];
    for (const file of srcFiles()) {
      for (const lit of scalesByPowerOfTen(readFileSync(join(SRC, file), 'utf8'))) {
        offences.push(`${file}: scales by ${lit}`);
      }
    }
    expect(offences, 'a file in src/ scales money by a power of ten, which is a currency precision in disguise').toStrictEqual([]);
  });

  it('proves that scan can see a power of ten at all, on either side of the operator', () => {
    // The scan above is a prohibition, so it passes loudest when it is
    // broken. These are its non-vacuity witnesses, and they call
    // `scalesByPowerOfTen` itself rather than restating its patterns.
    //
    // The literal AFTER the operator -- the shape the old witness covered.
    expect(scalesByPowerOfTen('const major = amountMinor / 100n;\nconst back = major * 1000;\n')).toStrictEqual(['100n', '1000']);
    // The literal BEFORE the operator -- the second pattern, which had no
    // witness at all until now, so nothing proved it was not dead text.
    expect(scalesByPowerOfTen('const scaled = 100n * amountMinor;\n')).toStrictEqual(['100n']);
    expect(scalesByPowerOfTen('const scaled = 1000 / amountMinor;\n')).toStrictEqual(['1000']);
    // And the exclusion is narrow: an exponent is not a scale.
    expect(scalesByPowerOfTen('const cap = 10n ** 18n;\n')).toStrictEqual([]);
    // Nor does a number that is not a power of ten count.
    expect(scalesByPowerOfTen('const third = amountMinor / 3n;\n')).toStrictEqual([]);
    // And the literals are literals, not something the lexer blanked away.
    expect(numericLiteralsOf('const major = amountMinor / 100n;\nconst back = major * 1000;\n')).toStrictEqual(['100n', '1000']);
    // While a power of ten inside a STRING or a COMMENT is not code, and the
    // blanking is what makes the scan read code only.
    expect(scalesByPowerOfTen("const s = 'divide / 100n';\n")).toStrictEqual([]);
    expect(scalesByPowerOfTen('// divide / 100n\n')).toStrictEqual([]);
  });
});
