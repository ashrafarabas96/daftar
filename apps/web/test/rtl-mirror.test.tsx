import { beforeAll, describe, expect, it } from 'vitest';
import { physicalDirectionViolations, structureSignature } from './helpers/layout-rules';
import { formatCivilDate, formatMomentDate } from '@/lib/phase3-format';
import { LOCALES, elements, renderFixture, textOf } from './helpers/render';
import { registeredFixtures, type RegisteredFixture } from './helpers/registries';
import { BAD_PROBES, GOOD_PROBES } from './fixtures/views/probe-views';

/**
 * T-16 (P3-S7 contract §6, A-16(3); MP-3): a view mirrors by direction alone.
 * The ar and en renders of every fixture have the same structure — only
 * `dir` and the words differ — and no rendered style names a physical side.
 */
describe('T-16 — the rules fire (planted views)', () => {
  it('a logical-property view has one structure in ar and en, and no physical side', () => {
    for (const entry of GOOD_PROBES) {
      for (const fixture of entry.fixtures) {
        expect(structureSignature(renderFixture(fixture, 'ar'))).toBe(structureSignature(renderFixture(fixture, 'en')));
        for (const locale of LOCALES) expect(physicalDirectionViolations(renderFixture(fixture, locale))).toEqual([]);
      }
    }
  });

  it('a view that branches its structure on the locale is refused', () => {
    const fixture = BAD_PROBES.localeBranch.fixtures[0];
    if (!fixture) throw new Error('no probe fixture');
    expect(structureSignature(renderFixture(fixture, 'ar'))).not.toBe(structureSignature(renderFixture(fixture, 'en')));
  });

  it('a physical margin or text-align is refused', () => {
    const fixture = BAD_PROBES.physical.fixtures[0];
    if (!fixture) throw new Error('no probe fixture');
    expect(physicalDirectionViolations(renderFixture(fixture, 'ar'))).toEqual(['<p> margin-left: 1rem', '<p> text-align: left']);
  });
});

describe('T-16 — every registered view mirrors', () => {
  let fixtures: RegisteredFixture[] = [];
  beforeAll(async () => {
    fixtures = (await registeredFixtures()).fixtures;
  });

  it('ar and en share one structure for every fixture', () => {
    const differ = fixtures.filter(({ fixture }) => structureSignature(renderFixture(fixture, 'ar')) !== structureSignature(renderFixture(fixture, 'en')));
    expect(differ.map((f) => f.label)).toEqual([]);
  });

  it('no rendered style names a physical side, in any locale', () => {
    const found = fixtures.flatMap(({ fixture, label }) =>
      LOCALES.flatMap((locale) => physicalDirectionViolations(renderFixture(fixture, locale)).map((v) => `${label} [${locale}] ${v}`)),
    );
    expect(found).toEqual([]);
  });
});

/**
 * B-1 (S7 UX review): CLDR's Arabic date carries U+200F after each part
 * ("14‏/08‏/2026"), and inside `<bdi dir="ltr">` a mark between the parts
 * reorders the runs ("142026/08/"). No isolated left-to-right run may carry a
 * bidi mark INSIDE a figure — between a digit and a `/`, `.` or `-`. (A mark at
 * the edge of an amount, where CLDR puts the Arabic currency sign, does not
 * split the figure and is kept.)
 */
describe('T-16 — no bidi mark splits a figure inside a left-to-right run', () => {
  const MARKS = /[\u200e\u200f\u061c]/;
  const SPLIT = /\d[\u200e\u200f\u061c]+[/.-]|[/.-][\u200e\u200f\u061c]+\d/;

  it('dates are spelled without marks, in one style, in every locale', () => {
    expect(formatCivilDate('2026-08-14', 'ar')).toBe('14/08/2026');
    expect(formatMomentDate('2026-08-14T12:00:00Z', 'ar')).toBe('14/08/2026');
    for (const locale of LOCALES) {
      expect(formatCivilDate('2026-08-14', locale)).not.toMatch(MARKS);
      expect(formatCivilDate('2026-08-14', locale)).toMatch(/2026/);
    }
    expect(formatCivilDate('not a date', 'ar')).toBe('not a date');
  });

  it('no <bdi dir="ltr"> of any registered fixture has a mark inside a figure', async () => {
    const { fixtures } = await registeredFixtures();
    let arabicDates = 0;
    const found: string[] = [];
    for (const { fixture, label } of fixtures) {
      for (const locale of LOCALES) {
        for (const el of elements(renderFixture(fixture, locale).frame)) {
          if (el.tag !== 'bdi' || el.attrs['dir'] !== 'ltr') continue;
          const text = textOf(el);
          if (locale === 'ar' && /^\d{2}\/\d{2}\/\d{4}$/.test(text)) arabicDates++;
          if (SPLIT.test(text)) found.push(`${label} [${locale}] ${JSON.stringify(text)}`);
        }
      }
    }
    expect(found).toEqual([]);
    // The fixtures do render Arabic dates, so the rule is not vacuous.
    expect(arabicDates).toBeGreaterThan(0);
  });
});
