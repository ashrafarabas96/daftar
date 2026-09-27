import { beforeAll, describe, expect, it } from 'vitest';
import { physicalDirectionViolations, structureSignature } from './helpers/layout-rules';
import { LOCALES, renderFixture } from './helpers/render';
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
