import { describe, expect, it } from 'vitest';
import { at } from './at';
import { assertRecipeVersionWellFormed, expandRecipe, halfEvenDiv, type RecipeVersion } from '../src/recipe-version';
import {
  STOCK_EFFECT_MODES,
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
    { componentProductId: 'beans', componentVariantId: 'beans-kg', quantityQ4: Q(0.018) },
    { componentProductId: 'milk', componentVariantId: 'milk-l', quantityQ4: Q(0.15) },
    { componentProductId: 'cup', componentVariantId: 'cup-unit', quantityQ4: Q(1) },
  ],
};

const facts = (over: Partial<SoldProductFacts> = {}): SoldProductFacts => ({
  productId: 'cappuccino',
  stockVariantId: null,
  stockTracked: false,
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
    expect(() => expectedMovementsFor(facts({ stockTracked: true, recipeVersion: null }), Q(1))).toThrowError(
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
    const batch: RecipeVersion = { ...CAPPUCCINO, recipeId: 'r-batch', yieldQuantityQ4: Q(10) };
    const perOne = expandRecipe(batch, Q(1));
    expect(at(perOne, 2).componentProductId).toBe('milk');
    expect(at(perOne, 2).quantityQ4).toBe(Q(0.015));
  });

  it('refuses a component that scales to zero instead of consuming none of it', () => {
    const saffron: RecipeVersion = {
      ...CAPPUCCINO,
      recipeId: 'r-saffron',
      yieldQuantityQ4: Q(1000),
      components: [{ componentProductId: 'saffron', componentVariantId: 'saffron-g', quantityQ4: 1n }],
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
          { componentProductId: 'milk', componentVariantId: 'milk-l', quantityQ4: Q(1) },
          { componentProductId: 'milk', componentVariantId: 'milk-l', quantityQ4: Q(2) },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'restaurant_recipe.component_duplicate' }));
    expect(() =>
      assertRecipeVersionWellFormed({ ...CAPPUCCINO, components: [{ componentProductId: 'milk', componentVariantId: 'milk-l', quantityQ4: 0n }] }),
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
    const actual = movementsFrom(expected).map((m) => ({ ...m, recipeVersion: 2 }));
    try {
      assertMovementSetComplete(expected, actual, { boundRecipeVersion: 3 });
      throw new Error('expected a refusal');
    } catch (error) {
      const refusal = error as { code?: string; details?: Record<string, unknown> };
      expect(refusal.code).toBe('restaurant_stock_effect.recipe_version_mismatch');
      expect(refusal.details?.boundVersion).toBe(3);
    }
  });

  it('accepts movements carrying the bound version', () => {
    const actual = movementsFrom(expected).map((m) => ({ ...m, recipeVersion: 3 }));
    expect(() => assertMovementSetComplete(expected, actual, { boundRecipeVersion: 3 })).not.toThrow();
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
  const directFacts = facts({ productId: 'bottled-water', stockTracked: true, stockVariantId: 'water-500', recipeVersion: null });

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
