import { describe, expect, it } from 'vitest';
import { at } from './at';
import {
  assertRecipeVersionWellFormed,
  expandRecipe,
  halfEvenDiv,
  isRepresentableAtPrecision,
  nearestRepresentableQuantity,
  type RecipeVersion,
} from '../src/recipe-version';
import {
  STOCK_EFFECT_MODES,
  StockEffectRefusal,
  type ActualMovement,
  assertMovementSetComplete,
  expectedMovementsFor,
  stockEffectModeOf,
  type SoldProductFacts,
} from '../src/stock-effect';

const Q = (units: number): bigint => BigInt(Math.round(units * 10_000));

/** Three components on purpose, so "first / middle / last missing" are distinct cases (§48). */
const CAPPUCCINO: RecipeVersion = {
  recipeId: 'r-cap',
  version: 3,
  productId: 'cappuccino',
  variantId: null,
  yieldQuantityQ4: Q(1),
  components: [
    { componentProductId: 'beans', componentVariantId: 'beans-kg', quantityQ4: Q(0.018), recipeUnit: 'kg', stockUnit: 'kg', unitDecimals: 3 },
    { componentProductId: 'milk', componentVariantId: 'milk-l', quantityQ4: Q(0.15), recipeUnit: 'l', stockUnit: 'l', unitDecimals: 3 },
    { componentProductId: 'cup', componentVariantId: 'cup-unit', quantityQ4: Q(1), recipeUnit: 'unit', stockUnit: 'unit', unitDecimals: 0 },
  ],
};

const facts = (over: Partial<SoldProductFacts> = {}): SoldProductFacts => ({
  productId: 'cappuccino',
  stockVariantId: null,
  stockTracked: false,
  stockUnitDecimals: null,
  recipeVersion: CAPPUCCINO,
  declaredService: false,
  ...over,
});

const movementsFrom = (expected: readonly { componentProductId: string; componentVariantId: string; quantityQ4: bigint }[]): ActualMovement[] =>
  expected.map((e) => ({ ...e }));

describe('§46 — exactly three stock-effect modes, and no fourth', () => {
  it('declares three and only three', () => {
    expect([...STOCK_EFFECT_MODES]).toEqual(['direct', 'service', 'composed']);
    expect(STOCK_EFFECT_MODES).toHaveLength(3);
  });

  it('does not register PRECONSUMED for a future phase', () => {
    expect([...STOCK_EFFECT_MODES]).not.toContain('preconsumed');
  });

  it('reads a stock-tracked product as direct, a recipe-backed one as composed, a declared service as service', () => {
    expect(stockEffectModeOf(facts({ stockTracked: true, stockVariantId: 'cap-unit', recipeVersion: null }))).toBe('direct');
    expect(stockEffectModeOf(facts())).toBe('composed');
    expect(stockEffectModeOf(facts({ recipeVersion: null, declaredService: true }))).toBe('service');
  });

  it('refuses a product that claims two modes — I-1, rather than letting a precedence rule decide silently', () => {
    try {
      stockEffectModeOf(facts({ stockTracked: true, stockVariantId: 'cap-unit' }));
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('restaurant_stock_effect.mode_ambiguous');
    }
  });

  it('refuses a product whose consumption nobody declared', () => {
    expect(() => stockEffectModeOf(facts({ recipeVersion: null }))).toThrowError(
      expect.objectContaining({ code: 'restaurant_stock_effect.mode_undetermined' }),
    );
  });

  it('refuses a tracked product with no stock variant rather than moving nothing', () => {
    expect(() => expectedMovementsFor(facts({ stockTracked: true, stockUnitDecimals: 0, recipeVersion: null }), Q(1))).toThrowError(
      expect.objectContaining({ code: 'restaurant_stock_effect.direct_movement_set_invalid' }),
    );
  });
});

describe('§49 — a sale binds an immutable recipe version', () => {
  it('expands deterministically and in a canonical order', () => {
    const a = expandRecipe(CAPPUCCINO, Q(1));
    const b = expandRecipe(CAPPUCCINO, Q(1));
    expect(a).toEqual(b);
    expect(a.map((c) => c.componentProductId)).toEqual(['beans', 'cup', 'milk']);
  });

  it('scales exactly: two cappuccinos consume twice of each component', () => {
    const one = expandRecipe(CAPPUCCINO, Q(1));
    const two = expandRecipe(CAPPUCCINO, Q(2));
    for (const [i, component] of two.entries()) {
      expect(component.quantityQ4).toBe(at(one, i).quantityQ4 * 2n);
    }
  });

  it('divides HALF_EVEN, so a half lands on the even quotient and never on a float', () => {
    expect(halfEvenDiv(5n, 2n)).toBe(2n);
    expect(halfEvenDiv(7n, 2n)).toBe(4n);
    expect(halfEvenDiv(4n, 2n)).toBe(2n);
    expect(halfEvenDiv(1n, 3n)).toBe(0n);
    expect(halfEvenDiv(2n, 3n)).toBe(1n);
  });

  it('a yield above one portion divides the components down', () => {
    // A ten-portion batch, and the cup scaled to 10 so that one portion still
    // takes exactly one cup. The earlier shape of this fixture kept the cup at 1
    // and is now REFUSED, correctly: a cup is counted in whole pieces
    // (`unitDecimals: 0`), so a tenth of a cup is a quantity the canonical stock
    // writer would reject. A batch recipe states its components for the whole
    // batch, which is what makes every portion of it representable.
    const batch: RecipeVersion = {
      ...CAPPUCCINO,
      recipeId: 'r-batch',
      yieldQuantityQ4: Q(10),
      components: [
        { componentProductId: 'beans', componentVariantId: 'beans-kg', quantityQ4: Q(0.18), recipeUnit: 'kg', stockUnit: 'kg', unitDecimals: 3 },
        { componentProductId: 'milk', componentVariantId: 'milk-l', quantityQ4: Q(1.5), recipeUnit: 'l', stockUnit: 'l', unitDecimals: 3 },
        { componentProductId: 'cup', componentVariantId: 'cup-unit', quantityQ4: Q(10), recipeUnit: 'unit', stockUnit: 'unit', unitDecimals: 0 },
      ],
    };
    const perOne = expandRecipe(batch, Q(1));
    expect(at(perOne, 2).componentProductId).toBe('milk');
    expect(at(perOne, 2).quantityQ4).toBe(Q(0.15));
    expect(at(perOne, 1).componentProductId).toBe('cup');
    expect(at(perOne, 1).quantityQ4).toBe(Q(1));
  });

  it('refuses a batch recipe whose per-portion component is finer than that component can be counted', () => {
    // The fixture above, before it was corrected: one cup across ten portions.
    // This is the defect the §57 precision grain exists to catch, and catching
    // it HERE is the point — the alternative is the canonical stock writer
    // refusing the movement at sale commit, after the coffee was served.
    const badBatch: RecipeVersion = {
      ...CAPPUCCINO,
      recipeId: 'r-batch-bad',
      yieldQuantityQ4: Q(10),
      components: [{ componentProductId: 'cup', componentVariantId: 'cup-unit', quantityQ4: Q(1), recipeUnit: 'unit', stockUnit: 'unit', unitDecimals: 0 }],
    };
    try {
      expandRecipe(badBatch, Q(1));
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('restaurant_recipe.component_quantity_not_representable');
      const details = (error as { details?: Record<string, unknown> }).details ?? {};
      // The refusal reports the scaled figure, so the configurator can see that
      // the quantity existed and the grain is what it cannot express.
      expect(details.scaledQuantityQ4).toBe('1000'); // 0.1 of a cup
      expect(details.unitDecimals).toBe(0);
    }
  });

  it('refuses a component that scales to zero instead of consuming none of it', () => {
    const saffron: RecipeVersion = {
      ...CAPPUCCINO,
      recipeId: 'r-saffron',
      yieldQuantityQ4: Q(1000),
      components: [{ componentProductId: 'saffron', componentVariantId: 'saffron-g', quantityQ4: 1n, recipeUnit: 'g', stockUnit: 'g', unitDecimals: 4 }],
    };
    try {
      expandRecipe(saffron, Q(1));
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('restaurant_recipe.component_quantity_rounds_to_zero');
    }
  });

  it('refuses a malformed version by its own code', () => {
    expect(() => assertRecipeVersionWellFormed({ ...CAPPUCCINO, version: 0 })).toThrowError(
      expect.objectContaining({ code: 'restaurant_recipe.version_not_positive' }),
    );
    expect(() => assertRecipeVersionWellFormed({ ...CAPPUCCINO, yieldQuantityQ4: 0n })).toThrowError(
      expect.objectContaining({ code: 'restaurant_recipe.yield_not_positive' }),
    );
    expect(() => assertRecipeVersionWellFormed({ ...CAPPUCCINO, components: [] })).toThrowError(
      expect.objectContaining({ code: 'restaurant_recipe.no_components' }),
    );
    expect(() =>
      assertRecipeVersionWellFormed({
        ...CAPPUCCINO,
        components: [
          { componentProductId: 'milk', componentVariantId: 'milk-l', quantityQ4: Q(1), recipeUnit: 'l', stockUnit: 'l', unitDecimals: 3 },
          { componentProductId: 'milk', componentVariantId: 'milk-l', quantityQ4: Q(2), recipeUnit: 'l', stockUnit: 'l', unitDecimals: 3 },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'restaurant_recipe.component_duplicate' }));
    expect(() =>
      assertRecipeVersionWellFormed({
        ...CAPPUCCINO,
        components: [{ componentProductId: 'milk', componentVariantId: 'milk-l', quantityQ4: 0n, recipeUnit: 'l', stockUnit: 'l', unitDecimals: 3 }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'restaurant_recipe.component_quantity_not_positive' }));
  });

  it('refuses a non-positive sold quantity', () => {
    expect(() => expandRecipe(CAPPUCCINO, 0n)).toThrowError(expect.objectContaining({ code: 'restaurant_recipe.sold_quantity_not_positive' }));
  });
});

describe('§48 — completeness is exact-set equality, not a count', () => {
  const expected = expectedMovementsFor(facts(), Q(2));

  it('accepts exactly the expected set', () => {
    expect(() => assertMovementSetComplete(expected, movementsFrom(expected))).not.toThrow();
    expect(expected).toHaveLength(3);
  });

  it('refuses the FIRST component missing, naming it', () => {
    const actual = movementsFrom(expected).slice(1);
    try {
      assertMovementSetComplete(expected, actual);
      throw new Error('expected a refusal');
    } catch (error) {
      const refusal = error as { code?: string; details?: Record<string, unknown> };
      expect(refusal.code).toBe('restaurant_stock_effect.component_missing');
      expect(refusal.details?.componentProductId).toBe('beans');
    }
  });

  it('refuses the MIDDLE component missing, naming it', () => {
    const actual = movementsFrom(expected).filter((_, i) => i !== 1);
    try {
      assertMovementSetComplete(expected, actual);
      throw new Error('expected a refusal');
    } catch (error) {
      const refusal = error as { code?: string; details?: Record<string, unknown> };
      expect(refusal.code).toBe('restaurant_stock_effect.component_missing');
      expect(refusal.details?.componentProductId).toBe('cup');
    }
  });

  it('refuses the LAST component missing, naming it', () => {
    const actual = movementsFrom(expected).slice(0, -1);
    try {
      assertMovementSetComplete(expected, actual);
      throw new Error('expected a refusal');
    } catch (error) {
      const refusal = error as { code?: string; details?: Record<string, unknown> };
      expect(refusal.code).toBe('restaurant_stock_effect.component_missing');
      expect(refusal.details?.componentProductId).toBe('milk');
    }
  });

  it('refuses an EXTRA component nobody asked for', () => {
    const actual = [...movementsFrom(expected), { componentProductId: 'syrup', componentVariantId: 'syrup-l', quantityQ4: Q(0.02) }];
    try {
      assertMovementSetComplete(expected, actual);
      throw new Error('expected a refusal');
    } catch (error) {
      const refusal = error as { code?: string; details?: Record<string, unknown> };
      expect(refusal.code).toBe('restaurant_stock_effect.component_extra');
      expect(refusal.details?.componentProductId).toBe('syrup');
    }
  });

  it('refuses a DUPLICATE component, and not as a quantity mismatch', () => {
    const actual = [...movementsFrom(expected), { ...at(movementsFrom(expected), 0) }];
    try {
      assertMovementSetComplete(expected, actual);
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('restaurant_stock_effect.component_duplicate');
    }
  });

  it('refuses a WRONG QUANTITY, reporting both figures', () => {
    const actual = movementsFrom(expected);
    const first = at(actual, 0);
    actual[0] = { ...first, quantityQ4: first.quantityQ4 - 1n };
    try {
      assertMovementSetComplete(expected, actual);
      throw new Error('expected a refusal');
    } catch (error) {
      const refusal = error as { code?: string; details?: Record<string, unknown> };
      expect(refusal.code).toBe('restaurant_stock_effect.component_quantity_mismatch');
      expect(refusal.details?.expectedQuantityQ4).toBe(first.quantityQ4.toString());
      expect(refusal.details?.movedQuantityQ4).toBe((first.quantityQ4 - 1n).toString());
    }
  });

  it('refuses a WRONG VARIANT as its own case, not as one missing plus one extra', () => {
    const actual = movementsFrom(expected);
    actual[2] = { ...at(actual, 2), componentVariantId: 'milk-carton' };
    try {
      assertMovementSetComplete(expected, actual);
      throw new Error('expected a refusal');
    } catch (error) {
      const refusal = error as { code?: string; details?: Record<string, unknown> };
      expect(refusal.code).toBe('restaurant_stock_effect.component_variant_mismatch');
      expect(refusal.details?.movedVariantId).toBe('milk-carton');
    }
  });

  it('refuses an EMPTY set where components were expected — the count-only failure mode', () => {
    expect(() => assertMovementSetComplete(expected, [])).toThrowError(expect.objectContaining({ code: 'restaurant_stock_effect.component_missing' }));
  });

  it('refuses movements recorded against a different recipe version (§49)', () => {
    const actual = movementsFrom(expected).map((m) => ({ ...m, recipeId: 'r-cap', recipeVersion: 2 }));
    try {
      assertMovementSetComplete(expected, actual, { boundRecipes: [{ recipeId: 'r-cap', version: 3 }] });
      throw new Error('expected a refusal');
    } catch (error) {
      const refusal = error as { code?: string; details?: Record<string, unknown> };
      expect(refusal.code).toBe('restaurant_stock_effect.recipe_version_mismatch');
      expect(refusal.details?.boundRecipes).toEqual([{ recipeId: 'r-cap', version: 3 }]);
    }
  });

  it('accepts movements carrying the bound version', () => {
    const actual = movementsFrom(expected).map((m) => ({ ...m, recipeId: 'r-cap', recipeVersion: 3 }));
    expect(() => assertMovementSetComplete(expected, actual, { boundRecipes: [{ recipeId: 'r-cap', version: 3 }] })).not.toThrow();
  });

  it('demonstrates that a COUNT would have passed every one of the seven defects it must refuse', () => {
    // The point of §48, measured: each of these has a movement count that a
    // "one or more movements" rule accepts, and each is wrong.
    const base = movementsFrom(expected);
    const defects: readonly ActualMovement[][] = [
      base.slice(1),
      base.filter((_, i) => i !== 1),
      base.slice(0, -1),
      [...base, { componentProductId: 'syrup', componentVariantId: 'syrup-l', quantityQ4: Q(1) }],
      [...base, { ...at(base, 0) }],
      base.map((m, i) => (i === 0 ? { ...m, quantityQ4: m.quantityQ4 + 1n } : m)),
      base.map((m, i) => (i === 2 ? { ...m, componentVariantId: 'milk-carton' } : m)),
    ];
    expect(defects).toHaveLength(7);
    let refusedByExactSet = 0;
    for (const defect of defects) {
      expect(defect.length).toBeGreaterThanOrEqual(1); // a count rule accepts it
      expect(() => assertMovementSetComplete(expected, defect)).toThrow();
      refusedByExactSet += 1;
    }
    expect(refusedByExactSet).toBe(7);
  });
});

describe('SERVICE — a non-stock service consumes nothing (§46)', () => {
  const serviceFacts = facts({ recipeVersion: null, declaredService: true });

  it('expects no movement at all', () => {
    expect(expectedMovementsFor(serviceFacts, Q(1))).toEqual([]);
  });

  it('accepts an empty movement set', () => {
    expect(() => assertMovementSetComplete(expectedMovementsFor(serviceFacts, Q(1)), [])).not.toThrow();
  });

  it('refuses a service line that moved stock, by its own code', () => {
    try {
      assertMovementSetComplete(expectedMovementsFor(serviceFacts, Q(1)), [{ componentProductId: 'milk', componentVariantId: 'milk-l', quantityQ4: Q(1) }]);
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('restaurant_stock_effect.service_consumed_stock');
    }
  });
});

describe('DIRECT — a stock-tracked line consumes itself (§46)', () => {
  // A bottled item is whole-counted: `unit_decimals = 0` is its real grain.
  const directFacts = facts({ productId: 'bottled-water', stockTracked: true, stockVariantId: 'water-500', stockUnitDecimals: 0, recipeVersion: null });

  it('expects exactly one movement of itself, at the sold quantity', () => {
    const expected = expectedMovementsFor(directFacts, Q(3));
    expect(expected).toHaveLength(1);
    expect(at(expected, 0).componentProductId).toBe('bottled-water');
    expect(at(expected, 0).componentVariantId).toBe('water-500');
    expect(at(expected, 0).quantityQ4).toBe(Q(3));
  });

  it('refuses a direct line that moved a different product', () => {
    expect(() =>
      assertMovementSetComplete(expectedMovementsFor(directFacts, Q(1)), [
        { componentProductId: 'sparkling-water', componentVariantId: 'water-500', quantityQ4: Q(1) },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'restaurant_stock_effect.component_extra' }));
  });

  it('refuses a direct line that moved the wrong quantity', () => {
    expect(() =>
      assertMovementSetComplete(expectedMovementsFor(directFacts, Q(3)), [
        { componentProductId: 'bottled-water', componentVariantId: 'water-500', quantityQ4: Q(2) },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'restaurant_stock_effect.component_quantity_mismatch' }));
  });
});

describe('§57 — a component quantity is meaningless without its unit', () => {
  const codeOf = (fn: () => unknown): string => {
    try {
      fn();
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string') return code;
      throw error;
    }
    throw new Error('expected a refusal, none was thrown');
  };

  it('accepts a component stated on the unit the warehouse holds', () => {
    expect(() => assertRecipeVersionWellFormed(CAPPUCCINO)).not.toThrow();
  });

  it('refuses a recipe unit that differs from the stock unit instead of converting it', () => {
    // 150 millilitres of milk held by the litre. The honest factor is 1000, and
    // this module may not know it: §57 forbids inventing a conversion here.
    const mismatched: RecipeVersion = {
      ...CAPPUCCINO,
      components: [{ componentProductId: 'milk', componentVariantId: 'milk-l', quantityQ4: Q(150), recipeUnit: 'ml', stockUnit: 'l', unitDecimals: 3 }],
    };
    expect(codeOf(() => assertRecipeVersionWellFormed(mismatched))).toBe('restaurant_recipe.component_unit_not_canonical');
  });

  it('refuses the mismatch at validation, before any expansion computes a quantity', () => {
    const mismatched: RecipeVersion = {
      ...CAPPUCCINO,
      components: [{ componentProductId: 'milk', componentVariantId: 'milk-l', quantityQ4: Q(150), recipeUnit: 'ml', stockUnit: 'l', unitDecimals: 3 }],
    };
    // expandRecipe validates first, so the refusal arrives before a movement
    // quantity exists at all — "refuse the configuration before service".
    expect(codeOf(() => expandRecipe(mismatched, Q(1)))).toBe('restaurant_recipe.component_unit_not_canonical');
  });

  it('names the conversion authority rather than a factor', () => {
    const mismatched: RecipeVersion = {
      ...CAPPUCCINO,
      components: [{ componentProductId: 'milk', componentVariantId: 'milk-l', quantityQ4: Q(150), recipeUnit: 'ml', stockUnit: 'l', unitDecimals: 3 }],
    };
    try {
      assertRecipeVersionWellFormed(mismatched);
      throw new Error('expected a refusal');
    } catch (error) {
      const details = (error as { details?: Record<string, unknown> }).details ?? {};
      expect(details.recipeUnit).toBe('ml');
      expect(details.stockUnit).toBe('l');
      expect(String(details.resolution)).toContain('unit-conversion authority');
      // No factor anywhere in the refusal: this module states no conversion.
      expect(Object.values(details).some((v) => typeof v === 'number')).toBe(false);
    }
  });

  it('refuses a component that states no unit at all', () => {
    for (const over of [
      { recipeUnit: '', stockUnit: 'l' },
      { recipeUnit: 'l', stockUnit: '' },
      { recipeUnit: '', stockUnit: '' },
    ]) {
      const unstated: RecipeVersion = {
        ...CAPPUCCINO,
        components: [{ componentProductId: 'milk', componentVariantId: 'milk-l', quantityQ4: Q(1), unitDecimals: 3, ...over }],
      };
      expect(codeOf(() => assertRecipeVersionWellFormed(unstated))).toBe('restaurant_recipe.component_unit_absent');
    }
  });

  it('keeps rounding on the canonical Q4 grain, which is the halfEvenDiv rule and nothing else', () => {
    // 1/3 of a unit at Q4: 3333.33… → 3333 (HALF_EVEN, below half).
    expect(halfEvenDiv(Q(1), 3n)).toBe(3333n);
    // Exactly half rounds to the even quotient both ways, so no bias accumulates.
    expect(halfEvenDiv(5n, 2n)).toBe(2n);
    expect(halfEvenDiv(7n, 2n)).toBe(4n);
  });
});

describe("§57 — the grain is the component's own unit_decimals, not Q4", () => {
  const codeOf = (fn: () => unknown): string => {
    try {
      fn();
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string') return code;
      throw error;
    }
    throw new Error('expected a refusal, none was thrown');
  };

  it('reads representability the way inventory_quantity_is_representable does', () => {
    // 0.1500 at 3 places: representable. 0.1505 at 3 places: not.
    expect(isRepresentableAtPrecision(Q(0.15), 3)).toBe(true);
    expect(isRepresentableAtPrecision(1505n, 3)).toBe(false);
    expect(isRepresentableAtPrecision(Q(1), 0)).toBe(true);
    expect(isRepresentableAtPrecision(Q(0.5), 0)).toBe(false);
    // At 4 places every Q4 integer qualifies, which is why Q4 alone cannot be the test.
    expect(isRepresentableAtPrecision(1505n, 4)).toBe(true);
  });

  it('names the nearest representable quantity for a refusal to report, without using it', () => {
    expect(nearestRepresentableQuantity(1505n, 3)).toBe(1500n); // .1505 -> .150 (half, even)
    expect(nearestRepresentableQuantity(1515n, 3)).toBe(1520n); // .1515 -> .152 (half, even)
    expect(nearestRepresentableQuantity(1506n, 3)).toBe(1510n);
    expect(nearestRepresentableQuantity(1505n, 4)).toBe(1505n); // a 4-place component is already on grain
  });

  it('refuses a recipe authored finer than its component can be counted', () => {
    const tooFine: RecipeVersion = {
      ...CAPPUCCINO,
      components: [{ componentProductId: 'cup', componentVariantId: 'cup-unit', quantityQ4: Q(0.5), recipeUnit: 'unit', stockUnit: 'unit', unitDecimals: 0 }],
    };
    expect(codeOf(() => assertRecipeVersionWellFormed(tooFine))).toBe('restaurant_recipe.component_quantity_not_representable');
  });

  it('refuses a declared precision the inventory authority does not allow', () => {
    for (const unitDecimals of [-1, 5, 1.5]) {
      const bad: RecipeVersion = {
        ...CAPPUCCINO,
        components: [{ componentProductId: 'milk', componentVariantId: 'milk-l', quantityQ4: Q(1), recipeUnit: 'l', stockUnit: 'l', unitDecimals }],
      };
      expect(codeOf(() => assertRecipeVersionWellFormed(bad))).toBe('restaurant_recipe.component_unit_decimals_invalid');
    }
  });

  it('never emits an expanded quantity the canonical writer would refuse', () => {
    // The property that matters: whatever the sold quantity, every component of
    // every accepted recipe lands on its own grain. A quantity off the grain is
    // what `0060:258` rejects at commit, i.e. after service.
    for (const soldUnits of [1, 2, 3, 7, 11, 13, 100]) {
      const expanded = expandRecipe(CAPPUCCINO, Q(soldUnits));
      for (const component of expanded) {
        const declared = CAPPUCCINO.components.find((c) => c.componentProductId === component.componentProductId);
        if (declared === undefined) throw new Error(`expanded an undeclared component ${component.componentProductId}`);
        expect(isRepresentableAtPrecision(component.quantityQ4, declared.unitDecimals)).toBe(true);
      }
    }
  });

  it('refuses a fractional portion of a dish whose component is counted in whole units', () => {
    // Half a cappuccino takes half a cup, and a cup is a whole piece. Rounding
    // 2.25 cups down to 2, or 1.5 up to 2, would change what the dish consumed
    // without saying so, which is the silent quantity change §57 forbids. The
    // grain belongs to the warehouse, and this pack does not get to round a cup.
    expect(codeOf(() => expandRecipe(CAPPUCCINO, Q(1.5)))).toBe('restaurant_recipe.component_quantity_not_representable');
    expect(codeOf(() => expandRecipe(CAPPUCCINO, Q(2.25)))).toBe('restaurant_recipe.component_quantity_not_representable');
    // Below half a cup there is not even a nearest nonzero answer, and that case
    // keeps its own older code so the two defects stay distinguishable.
    expect(codeOf(() => expandRecipe(CAPPUCCINO, Q(0.25)))).toBe('restaurant_recipe.component_quantity_not_representable');
  });

  it('reports the nearest representable quantity so the portioning can be corrected', () => {
    try {
      expandRecipe(CAPPUCCINO, Q(2.25));
      throw new Error('expected a refusal');
    } catch (error) {
      const details = (error as { details?: Record<string, unknown> }).details ?? {};
      // Beans are checked first and already fail: 0.018 kg x 2.25 = 0.0405 kg,
      // and a kilogram is held to three places, so the fourth digit has nowhere
      // to go. The cup would fail too; the first component to fail is enough.
      expect(details.componentProductId).toBe('beans');
      expect(details.scaledQuantityQ4).toBe('405'); // 0.0405 kg
      expect(details.nearestRepresentableQ4).toBe('400'); // 0.040 kg — named, not used
      expect(details.unitDecimals).toBe(3);
    }
  });

  it('allows a fractional portion once every component can express it', () => {
    // The same fractional sale against litre/kilogram components alone, both at
    // three places, is fine — so the refusal above is about the grain and not
    // about fractional sales as such.
    const drinkOnly: RecipeVersion = {
      ...CAPPUCCINO,
      recipeId: 'r-cap-no-cup',
      components: [
        { componentProductId: 'beans', componentVariantId: 'beans-kg', quantityQ4: Q(0.018), recipeUnit: 'kg', stockUnit: 'kg', unitDecimals: 3 },
        { componentProductId: 'milk', componentVariantId: 'milk-l', quantityQ4: Q(0.15), recipeUnit: 'l', stockUnit: 'l', unitDecimals: 3 },
      ],
    };
    const half = expandRecipe(drinkOnly, Q(0.5));
    expect(at(half, 1).componentProductId).toBe('milk');
    expect(at(half, 1).quantityQ4).toBe(Q(0.075));
    for (const component of half) {
      expect(isRepresentableAtPrecision(component.quantityQ4, 3)).toBe(true);
    }
  });
});

describe('P2-03 — the identity law applies because the line is composed, not because a movement volunteered one', () => {
  const bound = [{ recipeId: 'r-cappuccino', version: 3 }];
  const expected = [{ componentProductId: 'beans', componentVariantId: 'beans-kg', quantityQ4: Q(0.018) }];

  it('refuses a movement that names NEITHER half of a recipe identity', () => {
    // The fail-open case: a writer that simply forgets to stamp provenance.
    // Previously admitted as a fully attributed movement.
    expect(() => assertMovementSetComplete(expected, [{ ...at(expected, 0) }], { boundRecipes: bound })).toThrowError(
      expect.objectContaining({ code: 'restaurant_stock_effect.recipe_identity_incomplete' }),
    );
  });

  it('still refuses a movement that names half an identity', () => {
    expect(() => assertMovementSetComplete(expected, [{ ...at(expected, 0), recipeVersion: 3 }], { boundRecipes: bound })).toThrowError(
      expect.objectContaining({ code: 'restaurant_stock_effect.recipe_identity_incomplete' }),
    );
  });

  it('accepts the complete, matching identity, so the law did not simply become a refusal', () => {
    expect(() =>
      assertMovementSetComplete(expected, [{ ...at(expected, 0), recipeId: 'r-cappuccino', recipeVersion: 3 }], { boundRecipes: bound }),
    ).not.toThrow();
  });

  it('refuses an EMPTY bound set rather than letting it disable the law', () => {
    // Reachable through the pack's own `boundRecipesOf`, which returns [] for a
    // draft whose contributions are all unbound. "I know of no recipe for this
    // line" is not permission to accept anyone's movement.
    expect(() =>
      assertMovementSetComplete(expected, [{ ...at(expected, 0), recipeId: 'r-SOMEONE-ELSE', recipeVersion: 99 }], { boundRecipes: [] }),
    ).toThrowError(expect.objectContaining({ code: 'restaurant_stock_effect.recipe_binding_absent' }));
  });

  it('leaves a line with no movements at all unaffected by the empty bound set', () => {
    expect(() => assertMovementSetComplete([], [], { boundRecipes: [] })).not.toThrow();
  });

  it('leaves the direct and service paths, which pass no bound set, exactly as they were', () => {
    expect(() => assertMovementSetComplete(expected, [{ ...at(expected, 0) }])).not.toThrow();
  });
});

describe('P2-04 — a DIRECT line is held to the stock product’s grain, before service', () => {
  const whole = facts({ productId: 'bottled-water', stockTracked: true, stockVariantId: 'water-500', stockUnitDecimals: 0, recipeVersion: null });

  it('accepts a quantity the product’s own precision can represent', () => {
    expect(expectedMovementsFor(whole, Q(3))).toEqual([{ componentProductId: 'bottled-water', componentVariantId: 'water-500', quantityQ4: Q(3) }]);
  });

  it('refuses a half bottle on a whole-counted product, naming the nearest representable quantity', () => {
    try {
      expectedMovementsFor(whole, Q(0.5));
      throw new Error('expected a refusal, none was thrown');
    } catch (error: unknown) {
      if (!(error instanceof StockEffectRefusal)) throw error;
      expect(error.code).toBe('restaurant_stock_effect.direct_quantity_not_representable');
      expect(error.details?.soldQuantityQ4).toBe('5000');
      expect(error.details?.nearestRepresentableQ4).toBe('0');
    }
  });

  it('holds at every precision the catalogue allows', () => {
    const finerThanGrain: Record<number, bigint> = { 0: Q(0.5), 1: Q(0.05), 2: Q(0.005), 3: Q(0.0005) };
    for (const [decimals, quantity] of Object.entries(finerThanGrain)) {
      const product = facts({ productId: 'p', stockTracked: true, stockVariantId: 'v', stockUnitDecimals: Number(decimals), recipeVersion: null });
      expect(() => expectedMovementsFor(product, quantity)).toThrowError(
        expect.objectContaining({ code: 'restaurant_stock_effect.direct_quantity_not_representable' }),
      );
    }
    // 4 places is the column's own grain: nothing finer exists to refuse.
    const finest = facts({ productId: 'p', stockTracked: true, stockVariantId: 'v', stockUnitDecimals: 4, recipeVersion: null });
    expect(() => expectedMovementsFor(finest, 1n)).not.toThrow();
  });

  it('refuses a stock-tracked product that declares no usable precision at all', () => {
    const noGrain = facts({ productId: 'p', stockTracked: true, stockVariantId: 'v', stockUnitDecimals: null, recipeVersion: null });
    expect(() => expectedMovementsFor(noGrain, Q(1))).toThrowError(expect.objectContaining({ code: 'restaurant_stock_effect.direct_movement_set_invalid' }));
    const outOfRange = facts({ productId: 'p', stockTracked: true, stockVariantId: 'v', stockUnitDecimals: 5, recipeVersion: null });
    expect(() => expectedMovementsFor(outOfRange, Q(1))).toThrowError(expect.objectContaining({ code: 'restaurant_stock_effect.direct_movement_set_invalid' }));
  });
});
