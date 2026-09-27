import { beforeAll, describe, expect, it } from 'vitest';
import type { ViewEntry } from '@/lib/phase3-format';
import { phoneWidthViolations } from './helpers/layout-rules';
import { LOCALES, renderFixture } from './helpers/render';
import { registeredFixtures, unregisteredPageAreas, type RegisteredFixture } from './helpers/registries';
import { BAD_PROBES, GOOD_PROBES } from './fixtures/views/probe-views';

/**
 * T-15 (P3-S7 contract §6, A-16; MP-3): every registered view, in ar, en and
 * tr, with every fixture, renders at 360px with the locale's direction, no
 * width above 20rem, no 100vw, no table, a 2.75rem touch target on every
 * control, every number in <bdi>, and no missing key.
 */
const violations = (entry: ViewEntry, locale: (typeof LOCALES)[number]): string[] =>
  entry.fixtures.flatMap((f) => phoneWidthViolations(renderFixture(f, locale), locale));

describe('T-15 — the rules fire (planted views)', () => {
  it('a view that obeys every rule passes in all three locales', () => {
    for (const locale of LOCALES) for (const entry of GOOD_PROBES) expect(violations(entry, locale), `${entry.name} ${locale}`).toEqual([]);
  });

  it.each([
    ['wide', /width: 25rem is wider than 20rem/],
    ['viewport', /uses 100vw/],
    ['table', /table markup scrolls sideways/],
    ['smallButton', /min-height calc\(2\.75rem - 0\.5rem\) is under the 2\.75rem touch target/],
    ['rawButton', /<button> min-height absent is under the 2\.75rem touch target/],
    ['digits', /a number outside <bdi>/],
    ['missingKey', /missing catalog keys: stock\.no_such_key_in_any_catalog/],
  ] as const)('the %s probe is refused', (probe, message) => {
    for (const locale of LOCALES) {
      const found = violations(BAD_PROBES[probe], locale);
      expect(
        found.some((v) => message.test(v)),
        `${locale}: ${found.join(' | ')}`,
      ).toBe(true);
    }
  });

  it('a frame in the wrong direction is refused', () => {
    const [entry] = GOOD_PROBES;
    const fixture = entry?.fixtures[0];
    if (!fixture) throw new Error('no probe fixture');
    expect(phoneWidthViolations(renderFixture(fixture, 'en'), 'ar')).toContain('frame dir is ltr, expected rtl');
  });
});

describe('T-15 — every registered view at phone width', () => {
  let fixtures: RegisteredFixture[] = [];
  let unregistered: string[] = [];
  beforeAll(async () => {
    const loaded = await registeredFixtures();
    fixtures = loaded.fixtures;
    unregistered = unregisteredPageAreas(loaded.registries);
  });

  it('every S7 page area that exists registers its views (VIEW_REGISTRY)', () => {
    expect(unregistered).toEqual([]);
  });

  it('each registered view renders cleanly in ar (rtl), en and tr', () => {
    const found: string[] = [];
    for (const { fixture, label } of fixtures) {
      for (const locale of LOCALES) {
        for (const v of phoneWidthViolations(renderFixture(fixture, locale), locale)) found.push(`${label} [${locale}] ${v}`);
      }
    }
    expect(found).toEqual([]);
  });
});
