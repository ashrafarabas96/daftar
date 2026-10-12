import { describe, expect, it } from 'vitest';
import { WasteRefusal, expectedWasteMovements, linesOwingWaste, type CancelledLine } from '../src/waste-expansion';
import { assertMovementSetComplete, type ActualMovement } from '../src/stock-effect';
import { PREPARATION_STATES, type PreparationState } from '../src/preparation-state';
import type { RecipeVersion } from '../src/recipe-version';
import { at } from './at';

const Q = (units: number): bigint => BigInt(Math.round(units * 10_000));

const CAPPUCCINO: RecipeVersion = {
  recipeId: 'r-cappuccino',
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

const lookup = (binding: { recipeId: string; version: number }): RecipeVersion | null =>
  binding.recipeId === CAPPUCCINO.recipeId && binding.version === CAPPUCCINO.version ? CAPPUCCINO : null;

function composed(over: Partial<CancelledLine> = {}): CancelledLine {
  return {
    orderLineId: 'ol-1',
    mode: 'composed',
    stateAtCancellation: 'preparing',
    quantityQ4: Q(1),
    recipeBinding: { recipeId: 'r-cappuccino', version: 3 },
    stockProductId: null,
    stockVariantId: null,
    stockUnitDecimals: null,
    ...over,
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof WasteRefusal) return error.code;
    throw error;
  }
  throw new Error('expected a WasteRefusal, none was thrown');
}

describe('P2-05 — a cancellation wastes a SET, not a boolean', () => {
  it('expands the whole bound recipe at the cancelled quantity', () => {
    const movements = expectedWasteMovements(composed({ quantityQ4: Q(2) }), lookup);
    expect(movements.map((m) => [m.componentProductId, m.quantityQ4.toString()])).toEqual([
      // `expandRecipe` orders by component, so this is its order, not the
      // recipe's declaration order.
      ['beans', Q(0.036).toString()],
      ['cup', Q(2).toString()],
      ['milk', Q(0.3).toString()],
    ]);
  });

  it('passes the same exact-set verifier the sale path uses', () => {
    const expected = expectedWasteMovements(composed(), lookup);
    const actual: ActualMovement[] = expected.map((m) => ({ ...m, recipeId: 'r-cappuccino', recipeVersion: 3 }));
    expect(() => assertMovementSetComplete(expected, actual, { boundRecipes: [{ recipeId: 'r-cappuccino', version: 3 }] })).not.toThrow();
  });

  it('catches a waste set that dropped a component, which no invoice would ever contradict', () => {
    const expected = expectedWasteMovements(composed(), lookup);
    const short: ActualMovement[] = expected.slice(0, 2).map((m) => ({ ...m, recipeId: 'r-cappuccino', recipeVersion: 3 }));
    expect(() => assertMovementSetComplete(expected, short, { boundRecipes: [{ recipeId: 'r-cappuccino', version: 3 }] })).toThrowError(
      expect.objectContaining({ code: 'restaurant_stock_effect.component_missing' }),
    );
  });

  it('catches a waste set that moved a component twice', () => {
    const expected = expectedWasteMovements(composed(), lookup);
    const doubled: ActualMovement[] = [...expected, at(expected, 0)].map((m) => ({ ...m, recipeId: 'r-cappuccino', recipeVersion: 3 }));
    expect(() => assertMovementSetComplete(expected, doubled, { boundRecipes: [{ recipeId: 'r-cappuccino', version: 3 }] })).toThrowError(
      expect.objectContaining({ code: 'restaurant_stock_effect.component_duplicate' }),
    );
  });

  it('refuses a waste set on a line whose cancellation owes none', () => {
    expect(codeOf(() => expectedWasteMovements(composed({ stateAtCancellation: 'queued' }), lookup))).toBe('restaurant_waste.not_owed');
    expect(codeOf(() => expectedWasteMovements(composed({ stateAtCancellation: 'served' }), lookup))).toBe('restaurant_waste.not_owed');
  });

  it('owes a set in exactly the states the kitchen says waste from', () => {
    const owing: PreparationState[] = [];
    for (const state of PREPARATION_STATES) {
      try {
        expectedWasteMovements(composed({ stateAtCancellation: state }), lookup);
        owing.push(state);
      } catch (error) {
        if (!(error instanceof WasteRefusal)) throw error;
      }
    }
    expect(owing).toEqual(['preparing', 'ready']);
  });

  it('refuses a composed line cancelled mid-preparation with nothing bound', () => {
    expect(codeOf(() => expectedWasteMovements(composed({ recipeBinding: null }), lookup))).toBe('restaurant_waste.binding_absent');
  });

  it('never substitutes a version it cannot read', () => {
    expect(codeOf(() => expectedWasteMovements(composed({ recipeBinding: { recipeId: 'r-cappuccino', version: 9 } }), lookup))).toBe(
      'restaurant_waste.bound_version_unavailable',
    );
  });

  it('refuses a recipe read back under a different identity than the one bound', () => {
    const wrong = (): RecipeVersion => ({ ...CAPPUCCINO, recipeId: 'r-latte' });
    expect(codeOf(() => expectedWasteMovements(composed(), () => wrong()))).toBe('restaurant_waste.recipe_not_the_bound_version');
  });

  it('wastes a direct line as itself, on its own grain', () => {
    const bottle = composed({
      mode: 'direct',
      recipeBinding: null,
      stockProductId: 'water',
      stockVariantId: 'water-500',
      stockUnitDecimals: 0,
      quantityQ4: Q(2),
    });
    expect(expectedWasteMovements(bottle, lookup)).toEqual([{ componentProductId: 'water', componentVariantId: 'water-500', quantityQ4: Q(2) }]);
  });

  it('refuses a direct waste finer than the stock grain, before it is recorded', () => {
    const bottle = composed({
      mode: 'direct',
      recipeBinding: null,
      stockProductId: 'water',
      stockVariantId: 'water-500',
      stockUnitDecimals: 0,
      quantityQ4: Q(0.5),
    });
    expect(() => expectedWasteMovements(bottle, lookup)).toThrowError(
      expect.objectContaining({ code: 'restaurant_stock_effect.direct_quantity_not_representable' }),
    );
  });

  it('refuses to waste a service line', () => {
    expect(codeOf(() => expectedWasteMovements(composed({ mode: 'service' }), lookup))).toBe('restaurant_waste.service_cannot_waste');
  });
});

describe('P2-05 — recovering the waste obligation the aggregator drops', () => {
  it('separates a line voided while queued from one voided after the cook started', () => {
    const lines = [
      composed({ orderLineId: 'queued-void', stateAtCancellation: 'queued' }),
      composed({ orderLineId: 'started-void', stateAtCancellation: 'preparing' }),
      composed({ orderLineId: 'ready-void', stateAtCancellation: 'ready' }),
      composed({ orderLineId: 'service-void', mode: 'service', stateAtCancellation: 'preparing' }),
    ];
    expect(linesOwingWaste(lines).map((l) => l.orderLineId)).toEqual(['started-void', 'ready-void']);
  });
});
