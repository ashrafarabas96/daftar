import { beforeAll, describe, expect, it } from 'vitest';
import { HIDDEN_FIELD, MIN_HIDDEN_VALUE_LENGTH, hiddenValues, leakedHiddenValues } from './helpers/layout-rules';
import { LOCALES, renderFixture } from './helpers/render';
import { registeredFixtures, type RegisteredFixture } from './helpers/registries';
import { BAD_PROBES, GOOD_PROBES, PROBE_ROW } from './fixtures/views/probe-views';

/**
 * T-08 (P3-S7 contract §6, A-13; MP-2): the invisible stays invisible. The
 * fixtures carry, deliberately, the values a real DTO or command result
 * holds — the base variant, the stock sequence, trace, entry and movement
 * ids, the posting account — and no render in any locale emits one.
 */
describe('T-08 — the rule fires (planted views)', () => {
  it('finds every hidden field of a fixture, however deep', () => {
    const found = hiddenValues({ row: PROBE_ROW, lines: [{ movementId: 'mmmmmmmm-1', capturedAtStockSeq: 12345678 }] }).map((h) => h.field);
    expect(found.sort()).toEqual(
      ['baseVariantId', 'businessTransactionId', 'capturedAtStockSeq', 'journalEntryId', 'lastStockSeq', 'movementId', 'postingAccountId'].sort(),
    );
    for (const name of ['catchUpEntryId', 'reversalEntryId', 'stockMovementId']) expect(HIDDEN_FIELD.test(name), name).toBe(true);
    for (const name of ['productId', 'variantId', 'lineId', 'supplierId']) expect(HIDDEN_FIELD.test(name), name).toBe(false);
  });

  it('a view that renders a trace id is caught, and a view that does not is clean', () => {
    for (const locale of LOCALES) {
      const leak = BAD_PROBES.leak.fixtures[0];
      const good = GOOD_PROBES[0]?.fixtures[0];
      if (!leak || !good) throw new Error('no probe fixture');
      expect(leakedHiddenValues(renderFixture(leak, locale), leak.props)).toEqual([`businessTransactionId = ${PROBE_ROW.businessTransactionId}`]);
      expect(leakedHiddenValues(renderFixture(good, locale), good.props)).toEqual([]);
    }
  });
});

describe('T-08 — every registered view', () => {
  let fixtures: RegisteredFixture[] = [];
  beforeAll(async () => {
    fixtures = (await registeredFixtures()).fixtures;
  });

  it('plants distinctive hidden values (long enough that a match is never chance)', () => {
    const short = fixtures.flatMap(({ fixture, label }) =>
      hiddenValues(fixture.props)
        .filter((h) => h.value.length < MIN_HIDDEN_VALUE_LENGTH)
        .map((h) => `${label}: ${h.field} = ${h.value}`),
    );
    expect(short).toEqual([]);
  });

  it('covers every hidden kind somewhere in the registries, once there are registries', () => {
    if (fixtures.length === 0) return;
    const fields = new Set(fixtures.flatMap(({ fixture }) => hiddenValues(fixture.props).map((h) => h.field)));
    const kinds: Record<string, RegExp> = {
      'base variant': /^baseVariantId$/,
      'stock sequence': /StockSeq$|^lastStockSeq$|^stockSeq$/,
      trace: /^businessTransactionId$/,
      entry: /EntryId$|^entryId$/,
      movement: /[mM]ovementIds?$/,
      'posting account': /^postingAccountId$/,
    };
    const missing = Object.entries(kinds)
      .filter(([, re]) => ![...fields].some((f) => re.test(f)))
      .map(([kind]) => kind);
    expect(missing).toEqual([]);
  });

  it('never emits a hidden value, in any locale', () => {
    const found = fixtures.flatMap(({ fixture, label }) =>
      LOCALES.flatMap((locale) => leakedHiddenValues(renderFixture(fixture, locale), fixture.props).map((v) => `${label} [${locale}] ${v}`)),
    );
    expect(found).toEqual([]);
  });
});
