import { describe, expect, it } from 'vitest';
import { at } from './at';
import { AggregateConsumptionRefusal, assertContributionsConserve, expandAggregatedSaleLine } from '../src/aggregate-consumption';
import { aggregateToSaleLines, boundRecipesOf, type RestaurantOrderLine, type SaleLineDraft } from '../src/order-to-sale';
import { isRepresentableAtPrecision, type RecipeVersion } from '../src/recipe-version';
import { assertMovementSetComplete, type ActualMovement } from '../src/stock-effect';
import type { RecipeBinding } from '../src/recipe-binding';

const Q = (units: number): bigint => BigInt(Math.round(units * 10_000));

const V3: RecipeBinding = { recipeId: 'r-latte', version: 3 };
const V4: RecipeBinding = { recipeId: 'r-latte', version: 4 };

/** v3: 0.150 litre of milk per cup. v4: the chef raised it to 0.170. */
const LATTE_V3: RecipeVersion = {
  recipeId: 'r-latte',
  version: 3,
  productId: 'latte',
  variantId: null,
  yieldQuantityQ4: Q(1),
  components: [
    { componentProductId: 'beans', componentVariantId: 'beans-kg', quantityQ4: Q(0.018), recipeUnit: 'kg', stockUnit: 'kg', unitDecimals: 3 },
    { componentProductId: 'milk', componentVariantId: 'milk-l', quantityQ4: Q(0.15), recipeUnit: 'l', stockUnit: 'l', unitDecimals: 3 },
  ],
};

const LATTE_V4: RecipeVersion = {
  ...LATTE_V3,
  version: 4,
  components: [
    { componentProductId: 'beans', componentVariantId: 'beans-kg', quantityQ4: Q(0.018), recipeUnit: 'kg', stockUnit: 'kg', unitDecimals: 3 },
    { componentProductId: 'milk', componentVariantId: 'milk-l', quantityQ4: Q(0.17), recipeUnit: 'l', stockUnit: 'l', unitDecimals: 3 },
  ],
};

const lookup = (binding: RecipeBinding): RecipeVersion | null => {
  if (binding.recipeId !== 'r-latte') return null;
  if (binding.version === 3) return LATTE_V3;
  if (binding.version === 4) return LATTE_V4;
  return null;
};

const line = (over: Partial<RestaurantOrderLine> & { orderLineId: string }): RestaurantOrderLine => ({
  productId: 'latte',
  variantId: null,
  quantityQ4: Q(1),
  seatNo: null,
  courseNo: 1,
  modifiers: [],
  voided: false,
  recipeBinding: null,
  ...over,
});

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof AggregateConsumptionRefusal) return error.code;
    throw error;
  }
  throw new Error('expected an AggregateConsumptionRefusal, none was thrown');
};

/** The two lattes of the mission's §17: same variant, different bound versions. */
function twoLattesUnderTwoVersions(): SaleLineDraft {
  const drafts = aggregateToSaleLines([line({ orderLineId: 'o1', seatNo: 1, recipeBinding: V3 }), line({ orderLineId: 'o2', seatNo: 2, recipeBinding: V4 })]);
  expect(drafts).toHaveLength(1);
  return at(drafts, 0);
}

describe('§17 — aggregation keeps every line its own links and economics', () => {
  it('bills one sale line of quantity two, as the sale authority requires', () => {
    const draft = twoLattesUnderTwoVersions();
    expect(draft.productId).toBe('latte');
    expect(draft.quantityQ4).toBe(Q(2));
  });

  it('keeps both bindings on that one sale line, so the provenance survives the merge', () => {
    const draft = twoLattesUnderTwoVersions();
    expect(draft.contributions).toHaveLength(2);
    expect(at(draft.contributions, 0)).toEqual({ orderLineId: 'o1', modifierId: null, quantityQ4: Q(1), recipeBinding: { recipeId: 'r-latte', version: 3 } });
    expect(at(draft.contributions, 1)).toEqual({ orderLineId: 'o2', modifierId: null, quantityQ4: Q(1), recipeBinding: { recipeId: 'r-latte', version: 4 } });
    // The cardinality the Contract Diff has to resolve: 1 sale line, N
    // contributions, M distinct versions, M <= N.
    expect([...boundRecipesOf(draft)]).toEqual([
      { recipeId: 'r-latte', version: 3 },
      { recipeId: 'r-latte', version: 4 },
    ]);
    expect(boundRecipesOf(draft).length).toBeLessThanOrEqual(draft.contributions.length);
  });

  it('records a priced modifier as its own contribution, with its own binding', () => {
    const drafts = aggregateToSaleLines([
      line({
        orderLineId: 'o1',
        recipeBinding: V3,
        modifiers: [{ modifierId: 'm1', label: 'extra shot', productId: 'shot', variantId: null, quantityQ4: Q(2), priced: true, recipeBinding: V4 }],
      }),
    ]);
    const shot = drafts.find((d) => d.productId === 'shot');
    if (shot === undefined) throw new Error('the priced modifier did not become a sale line');
    expect(at(shot.contributions, 0).modifierId).toBe('m1');
    expect(at(shot.contributions, 0).recipeBinding).toEqual({ recipeId: 'r-latte', version: 4 });
  });

  it('keeps contributions separate even when two lines share a variant AND a version', () => {
    // Waste on a cancellation is per order line, so collapsing two identical
    // contributions would lose which line owes which share.
    const drafts = aggregateToSaleLines([line({ orderLineId: 'o1', recipeBinding: V3 }), line({ orderLineId: 'o2', recipeBinding: V3 })]);
    const draft = at(drafts, 0);
    expect(draft.contributions).toHaveLength(2);
    expect([...boundRecipesOf(draft)]).toEqual([{ recipeId: 'r-latte', version: 3 }]);
  });

  it('conserves: the contributions account for the billed quantity exactly', () => {
    const draft = twoLattesUnderTwoVersions();
    expect(() => assertContributionsConserve(draft)).not.toThrow();
    const sum = draft.contributions.reduce((acc, c) => acc + c.quantityQ4, 0n);
    expect(sum).toBe(draft.quantityQ4);
  });
});

describe('§17 — consumption is per contribution, never per aggregate', () => {
  it('consumes each version its own components and folds the totals', () => {
    const draft = twoLattesUnderTwoVersions();
    const components = expandAggregatedSaleLine(draft, lookup);
    expect(components).toHaveLength(2);
    // Beans: 0.018 + 0.018 = 0.036 kg. Milk: 0.150 (v3) + 0.170 (v4) = 0.320 l.
    expect(at(components, 0)).toEqual({ componentProductId: 'beans', componentVariantId: 'beans-kg', quantityQ4: Q(0.036) });
    expect(at(components, 1)).toEqual({ componentProductId: 'milk', componentVariantId: 'milk-l', quantityQ4: Q(0.32) });
  });

  it('differs from expanding the aggregate under either single version, which is the defect', () => {
    // THE measurement §17 exists for. Expanding "latte x 2" under one version
    // gives a milk quantity no cook ever used, and the error is not small: it is
    // the whole difference between the two recipes, every time the versions mix.
    const draft = twoLattesUnderTwoVersions();
    const correct = expandAggregatedSaleLine(draft, lookup);
    const milk = (set: readonly { componentProductId: string; quantityQ4: bigint }[]): bigint => {
      const found = set.find((c) => c.componentProductId === 'milk');
      if (found === undefined) throw new Error('no milk in the set');
      return found.quantityQ4;
    };
    expect(milk(correct)).toBe(Q(0.32));

    // What the pack would have produced before §17: one version, summed quantity.
    const asIfV3 = Q(0.15) * 2n;
    const asIfV4 = Q(0.17) * 2n;
    expect(asIfV3).toBe(Q(0.3));
    expect(asIfV4).toBe(Q(0.34));
    expect(milk(correct)).not.toBe(asIfV3);
    expect(milk(correct)).not.toBe(asIfV4);
    // 0.020 litre of milk either unaccounted for or consumed twice over, per bill.
    expect(milk(correct) - asIfV3).toBe(Q(0.02));
    expect(asIfV4 - milk(correct)).toBe(Q(0.02));
  });

  it('is unchanged for the ordinary single-version aggregate', () => {
    const drafts = aggregateToSaleLines([line({ orderLineId: 'o1', recipeBinding: V3 }), line({ orderLineId: 'o2', recipeBinding: V3 })]);
    const components = expandAggregatedSaleLine(at(drafts, 0), lookup);
    expect(at(components, 1)).toEqual({ componentProductId: 'milk', componentVariantId: 'milk-l', quantityQ4: Q(0.3) });
  });

  it('refuses a composed contribution that carries no binding', () => {
    const drafts = aggregateToSaleLines([line({ orderLineId: 'o1', recipeBinding: V3 }), line({ orderLineId: 'o2', recipeBinding: null })]);
    expect(codeOf(() => expandAggregatedSaleLine(at(drafts, 0), lookup))).toBe('restaurant_aggregate.contribution_not_bound');
  });

  it('refuses rather than substitutes when a bound version cannot be read', () => {
    const drafts = aggregateToSaleLines([line({ orderLineId: 'o1', recipeBinding: { recipeId: 'r-latte', version: 9 } })]);
    expect(codeOf(() => expandAggregatedSaleLine(at(drafts, 0), lookup))).toBe('restaurant_aggregate.bound_version_unavailable');
  });

  it('refuses a recipe read back under a version other than the bound one', () => {
    const drafts = aggregateToSaleLines([line({ orderLineId: 'o1', recipeBinding: V3 })]);
    // A lookup that quietly hands back the latest version instead of the bound one.
    expect(codeOf(() => expandAggregatedSaleLine(at(drafts, 0), () => LATTE_V4))).toBe('restaurant_aggregate.recipe_not_the_bound_version');
  });

  it('refuses a sale line with no contribution at all', () => {
    const empty: SaleLineDraft = { productId: 'latte', variantId: null, quantityQ4: Q(1), contributingOrderLineIds: [], contributions: [] };
    expect(codeOf(() => assertContributionsConserve(empty))).toBe('restaurant_aggregate.no_contributions');
  });

  it('refuses contributions that do not account for the billed quantity', () => {
    const short: SaleLineDraft = {
      productId: 'latte',
      variantId: null,
      quantityQ4: Q(2),
      contributingOrderLineIds: ['o1'],
      contributions: [{ orderLineId: 'o1', modifierId: null, quantityQ4: Q(1), recipeBinding: V3 }],
    };
    expect(codeOf(() => assertContributionsConserve(short))).toBe('restaurant_aggregate.contributions_do_not_conserve');
  });
});

describe('§17 + §58 — the completeness verifier reads the bound SET', () => {
  it("accepts movements recorded under either of the line's two versions", () => {
    const draft = twoLattesUnderTwoVersions();
    const expected = expandAggregatedSaleLine(draft, lookup);
    const actual: ActualMovement[] = [
      { componentProductId: 'beans', componentVariantId: 'beans-kg', quantityQ4: Q(0.036), recipeId: 'r-latte', recipeVersion: 3 },
      { componentProductId: 'milk', componentVariantId: 'milk-l', quantityQ4: Q(0.32), recipeId: 'r-latte', recipeVersion: 4 },
    ];
    expect(() => assertMovementSetComplete(expected, actual, { boundRecipes: [...boundRecipesOf(draft)] })).not.toThrow();
  });

  it('still refuses a version the line was never bound to', () => {
    const draft = twoLattesUnderTwoVersions();
    const expected = expandAggregatedSaleLine(draft, lookup);
    const actual: ActualMovement[] = [
      { componentProductId: 'beans', componentVariantId: 'beans-kg', quantityQ4: Q(0.036), recipeId: 'r-latte', recipeVersion: 3 },
      { componentProductId: 'milk', componentVariantId: 'milk-l', quantityQ4: Q(0.32), recipeId: 'r-latte', recipeVersion: 5 },
    ];
    try {
      assertMovementSetComplete(expected, actual, { boundRecipes: [...boundRecipesOf(draft)] });
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('restaurant_stock_effect.recipe_version_mismatch');
      expect((error as { details?: Record<string, unknown> }).details?.boundRecipes).toEqual([
        { recipeId: 'r-latte', version: 3 },
        { recipeId: 'r-latte', version: 4 },
      ]);
    }
  });

  it("would have refused this line's own movements under a single-version check", () => {
    // Why the option had to become a set: handing it one of the two bound
    // versions rejects the movements the other version legitimately produced.
    const draft = twoLattesUnderTwoVersions();
    const expected = expandAggregatedSaleLine(draft, lookup);
    const actual: ActualMovement[] = [
      { componentProductId: 'beans', componentVariantId: 'beans-kg', quantityQ4: Q(0.036), recipeId: 'r-latte', recipeVersion: 3 },
      { componentProductId: 'milk', componentVariantId: 'milk-l', quantityQ4: Q(0.32), recipeId: 'r-latte', recipeVersion: 4 },
    ];
    expect(() => assertMovementSetComplete(expected, actual, { boundRecipes: [{ recipeId: 'r-latte', version: 3 }] })).toThrowError(
      expect.objectContaining({ code: 'restaurant_stock_effect.recipe_version_mismatch' }),
    );
  });
});

describe("§17 — a component's precision belongs to the product, not to a recipe version", () => {
  /** v4, but declaring milk at FOUR places where v3 declares three. */
  const LATTE_V4_FINER: RecipeVersion = {
    ...LATTE_V4,
    components: [
      { componentProductId: 'beans', componentVariantId: 'beans-kg', quantityQ4: Q(0.018), recipeUnit: 'kg', stockUnit: 'kg', unitDecimals: 3 },
      { componentProductId: 'milk', componentVariantId: 'milk-l', quantityQ4: 1705n, recipeUnit: 'l', stockUnit: 'l', unitDecimals: 4 },
    ],
  };

  const disagreeingLookup = (binding: RecipeBinding): RecipeVersion | null => {
    if (binding.version === 3) return LATTE_V3;
    if (binding.version === 4) return LATTE_V4_FINER;
    return null;
  };

  it('refuses two bound versions that declare different precisions for one component', () => {
    const draft = twoLattesUnderTwoVersions();
    expect(codeOf(() => expandAggregatedSaleLine(draft, disagreeingLookup))).toBe('restaurant_aggregate.component_precision_disagreement');
  });

  it('reports both declared precisions, so the configuration defect is visible', () => {
    const draft = twoLattesUnderTwoVersions();
    try {
      expandAggregatedSaleLine(draft, disagreeingLookup);
      throw new Error('expected a refusal');
    } catch (error) {
      const details = (error as { details?: Record<string, unknown> }).details ?? {};
      expect(details.componentProductId).toBe('milk');
      expect(details.declaredPrecisions).toEqual([3, 4]);
    }
  });

  it('finds no counterexample to the folded-grain guard within a bounded grid', () => {
    // Deliberately NOT called a proof of unreachability, and not counted among
    // the harness's laws. A mutation removing the guard stays GREEN, so claiming
    // a red proof for it would be false; what this does instead is enumerate a
    // finite grid and report that no counterexample appears inside it. The
    // reasoning it supports — with the precisions proven equal and every
    // contribution already on that grain (§57), a fold is a sum of multiples of
    // one step — is an argument, and this is a bounded check of that argument,
    // which is a limited examination either way.
    const steps = [
      { unitDecimals: 0, step: 10_000n },
      { unitDecimals: 1, step: 1_000n },
      { unitDecimals: 2, step: 100n },
      { unitDecimals: 3, step: 10n },
      { unitDecimals: 4, step: 1n },
    ];
    let everOffGrain = 0;
    let checked = 0;
    for (const { unitDecimals, step } of steps) {
      for (let a = 1n; a <= 40n; a += 1n) {
        for (let b = 1n; b <= 40n; b += 1n) {
          const first = a * step;
          const second = b * step;
          // Each part is on the grain, which is what §57 guarantees.
          expect(isRepresentableAtPrecision(first, unitDecimals)).toBe(true);
          expect(isRepresentableAtPrecision(second, unitDecimals)).toBe(true);
          checked += 1;
          if (!isRepresentableAtPrecision(first + second, unitDecimals)) everOffGrain += 1;
        }
      }
    }
    expect(checked).toBe(8000);
    expect(everOffGrain).toBe(0);
    // The bound itself, stated so the claim cannot be read as wider than it is:
    // five precisions x 40 x 40 multiples. Nothing here speaks for a 41st.
  });

  it('folds a three-contribution bill on one grain without drift', () => {
    const drafts = aggregateToSaleLines([
      line({ orderLineId: 'o1', recipeBinding: V3 }),
      line({ orderLineId: 'o2', recipeBinding: V4 }),
      line({ orderLineId: 'o3', recipeBinding: V3 }),
    ]);
    const draft = at(drafts, 0);
    expect(draft.quantityQ4).toBe(Q(3));
    const components = expandAggregatedSaleLine(draft, lookup);
    // Milk: 0.150 + 0.170 + 0.150 = 0.470 l. Beans: 3 x 0.018 = 0.054 kg.
    expect(at(components, 0).quantityQ4).toBe(Q(0.054));
    expect(at(components, 1).quantityQ4).toBe(Q(0.47));
  });
});

describe('V2 §17 — the bound set is recipe IDENTITIES, not version numbers', () => {
  /**
   * The case a set of numbers cannot express: one sale line whose contributions
   * bind to two DIFFERENT recipes that happen to share a version number. A
   * priced modifier with a recipe of its own is the ordinary way this arises.
   */
  const SYRUP_V3: RecipeVersion = {
    recipeId: 'r-syrup',
    version: 3,
    productId: 'syrup-shot',
    variantId: null,
    yieldQuantityQ4: Q(1),
    components: [{ componentProductId: 'syrup', componentVariantId: 'syrup-l', quantityQ4: Q(0.02), recipeUnit: 'l', stockUnit: 'l', unitDecimals: 3 }],
  };

  const twoRecipesLookup = (binding: RecipeBinding): RecipeVersion | null => {
    if (binding.recipeId === 'r-latte' && binding.version === 3) return LATTE_V3;
    if (binding.recipeId === 'r-syrup' && binding.version === 3) return SYRUP_V3;
    return null;
  };

  it('keeps both identities distinct when two recipes share a version number', () => {
    const drafts = aggregateToSaleLines([
      line({ orderLineId: 'o1', productId: 'latte', recipeBinding: { recipeId: 'r-latte', version: 3 } }),
      line({ orderLineId: 'o2', productId: 'latte', recipeBinding: { recipeId: 'r-syrup', version: 3 } }),
    ]);
    const draft = at(drafts, 0);
    const bound = boundRecipesOf(draft);
    // Two identities, not one number. A `Set<number>` would have collapsed these.
    expect(bound).toHaveLength(2);
    expect([...bound]).toEqual([
      { recipeId: 'r-latte', version: 3 },
      { recipeId: 'r-syrup', version: 3 },
    ]);
    expect(new Set(bound.map((b) => b.version)).size).toBe(1);
  });

  it('collapses an identity only when the recipe AND the version repeat', () => {
    const drafts = aggregateToSaleLines([
      line({ orderLineId: 'o1', recipeBinding: { recipeId: 'r-latte', version: 3 } }),
      line({ orderLineId: 'o2', recipeBinding: { recipeId: 'r-latte', version: 3 } }),
    ]);
    expect(boundRecipesOf(at(drafts, 0))).toHaveLength(1);
  });

  it('refuses a movement from a foreign recipe at the same version number', () => {
    // THE defect V2 §17 names. A line bound to r-latte v3 alone must not accept
    // a movement made under r-syrup v3 just because the number matches.
    const drafts = aggregateToSaleLines([line({ orderLineId: 'o1', recipeBinding: { recipeId: 'r-latte', version: 3 } })]);
    const draft = at(drafts, 0);
    const expected = expandAggregatedSaleLine(draft, twoRecipesLookup);
    const actual: ActualMovement[] = expected.map((e) => ({ ...e, recipeId: 'r-syrup', recipeVersion: 3 }));
    try {
      assertMovementSetComplete(expected, actual, { boundRecipes: [...boundRecipesOf(draft)] });
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('restaurant_stock_effect.recipe_version_mismatch');
      const details = (error as { details?: Record<string, unknown> }).details ?? {};
      expect(details.movedRecipeId).toBe('r-syrup');
      expect(details.boundRecipes).toEqual([{ recipeId: 'r-latte', version: 3 }]);
    }
  });

  it('measures that a version-number check would have ADMITTED that foreign movement', () => {
    // Why the option could not stay a set of numbers. The comparison the pack
    // used to make, reproduced here over the same data, accepts it.
    const drafts = aggregateToSaleLines([line({ orderLineId: 'o1', recipeBinding: { recipeId: 'r-latte', version: 3 } })]);
    const draft = at(drafts, 0);
    const foreign = { recipeId: 'r-syrup', version: 3 };
    const boundNumbers = boundRecipesOf(draft).map((b) => b.version);
    expect(boundNumbers).toEqual([3]);
    expect(boundNumbers.includes(foreign.version)).toBe(true); // the old check: admitted
    const boundKeys = boundRecipesOf(draft).map((b) => `${b.recipeId}@${b.version}`);
    expect(boundKeys.includes(`${foreign.recipeId}@${foreign.version}`)).toBe(false); // identity: refused
  });

  it("accepts the two-recipe line's own movements under either identity", () => {
    const drafts = aggregateToSaleLines([
      line({ orderLineId: 'o1', productId: 'latte', recipeBinding: { recipeId: 'r-latte', version: 3 } }),
      line({ orderLineId: 'o2', productId: 'latte', recipeBinding: { recipeId: 'r-syrup', version: 3 } }),
    ]);
    const draft = at(drafts, 0);
    const expected = expandAggregatedSaleLine(draft, twoRecipesLookup);
    // One cup to the latte recipe, one to the syrup recipe: beans, milk, syrup.
    expect(expected.map((e) => e.componentProductId)).toEqual(['beans', 'milk', 'syrup']);
    const actual: ActualMovement[] = [
      { componentProductId: 'beans', componentVariantId: 'beans-kg', quantityQ4: Q(0.018), recipeId: 'r-latte', recipeVersion: 3 },
      { componentProductId: 'milk', componentVariantId: 'milk-l', quantityQ4: Q(0.15), recipeId: 'r-latte', recipeVersion: 3 },
      { componentProductId: 'syrup', componentVariantId: 'syrup-l', quantityQ4: Q(0.02), recipeId: 'r-syrup', recipeVersion: 3 },
    ];
    expect(() => assertMovementSetComplete(expected, actual, { boundRecipes: [...boundRecipesOf(draft)] })).not.toThrow();
  });

  it('refuses half an identity rather than matching on the number alone', () => {
    const drafts = aggregateToSaleLines([line({ orderLineId: 'o1', recipeBinding: { recipeId: 'r-latte', version: 3 } })]);
    const draft = at(drafts, 0);
    const expected = expandAggregatedSaleLine(draft, twoRecipesLookup);
    for (const half of [{ recipeVersion: 3 }, { recipeId: 'r-latte' }]) {
      const actual: ActualMovement[] = expected.map((e) => ({ ...e, ...half }));
      expect(() => assertMovementSetComplete(expected, actual, { boundRecipes: [...boundRecipesOf(draft)] })).toThrowError(
        expect.objectContaining({ code: 'restaurant_stock_effect.recipe_identity_incomplete' }),
      );
    }
  });
});
