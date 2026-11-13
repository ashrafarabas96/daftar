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

/**
 * Every place in `sources` where money is scaled by a power of ten, as
 * `file: scales by <literal>`. The live scan and its witness both read
 * THIS function, so a change to either pattern cannot leave the witness
 * passing on a copy of the old one — which is what it did until this
 * round: the witness spelled both regexes again inside itself.
 */
function scaleOffencesIn(sources: ReadonlyArray<readonly [string, string]>): string[] {
  const offences: string[] = [];
  for (const [file, source] of sources) {
    const code = blankOut(source);
    // A power-of-ten literal next to a `/` or `*` is what a hidden
    // precision looks like in this package: there is no other reason to
    // scale an integer in minor units.
    // `**` is excluded deliberately: `10n ** 18n` in `types.ts` is the
    // MONEY CAP, an upper bound on an amount, not a scale between a
    // major and a minor unit. Excluding the exponent operator is the
    // narrowest exclusion that admits it, and the witness below proves
    // the scan still sees a real `*` and `/`.
    for (const m of code.matchAll(/(?<![*/])[*/](?!\*)\s*(10{1,}0*n?)\b/g)) offences.push(`${file}: scales by ${m[1]}`);
    for (const m of code.matchAll(/\b(10{1,}0*n?)\s*[*/](?!\*)/g)) offences.push(`${file}: scales by ${m[1]}`);
  }
  return offences;
}

describe('this package assumes no currency precision', () => {
  it('divides by no power of ten and multiplies by none', () => {
    // The corpus is this package's own `src/`, read through the checker above.
    const sources = readdirSync(SRC)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => [f, readFileSync(join(SRC, f), 'utf8')] as const);
    expect(sources.length, 'no source file was read, so this prohibition would pass on nothing').toBeGreaterThan(3);
    expect(scaleOffencesIn(sources), 'a file in src/ scales money by a power of ten, which is a currency precision in disguise').toStrictEqual([]);
  });

  it('proves that scan can see a power of ten at all', () => {
    // The scan above is a prohibition, so it passes loudest when it is
    // broken. This is its non-vacuity witness, and it now goes through the
    // SAME checker rather than through a second copy of the two patterns.
    const divides = scaleOffencesIn([['planted.ts', 'const major = amountMinor / 100n;' + '\n']]);
    expect(divides, 'the checker missed a division by a power of ten').toStrictEqual(['planted.ts: scales by 100n']);

    // The other order, which had no witness of its own: the literal FIRST.
    const multiplies = scaleOffencesIn([['planted.ts', 'const back = 1000 * majorUnits;' + '\n']]);
    expect(multiplies, 'the checker missed a literal-first scale').toStrictEqual(['planted.ts: scales by 1000']);

    // AND THE OTHER DIRECTION: the exclusion is narrow. The money cap is an
    // exponent, not a scale, and a comment or a string that spells a scale is
    // not program.
    expect(scaleOffencesIn([['cap.ts', 'const cap = 10n ** 18n;' + '\n']]), 'the money cap was read as a scale').toStrictEqual([]);
    expect(
      scaleOffencesIn([
        ['prose.ts', '// never write amountMinor / 100n here' + '\n'],
        ['literal.ts', 'const s = "x / 100n";' + '\n'],
      ]),
      'a comment or a string literal was read as code',
    ).toStrictEqual([]);

    // And the literals are literals, not something the lexer blanked away.
    expect(numericLiteralsOf('const major = amountMinor / 100n;' + '\n')).toStrictEqual(['100n']);
  });
});
