/**
 * Phase 10 — the three stock-effect modes and the completeness verifier.
 * PREPARED / NOT PROMOTED. Rulings TL-P10-R1, §46, §48.
 *
 * §46 fixes the mode set at exactly three, and forbids registering a fourth for
 * a future phase's benefit:
 *
 *   DIRECT   — a stock-tracked sold line consumes itself: exactly one movement.
 *   SERVICE  — a non-stock service consumes nothing: exactly zero movements.
 *   COMPOSED — a recipe-backed line consumes its recipe version's COMPLETE
 *              component set: exactly the expected set, nothing more, nothing
 *              less, nothing twice.
 *
 * `PRECONSUMED` is deliberately absent. Phase 11 may add it when it has a real
 * repair writer and its own proofs; registering it here would be dead authority.
 *
 * §48's law, and the reason this module exists: **"at least one movement" is NOT
 * a completeness proof.** Completeness is exact-set equality — every component
 * present, none missing, none extra, none duplicated, the right variant and the
 * right quantity. A verifier that only counts cannot tell a complete set from a
 * plausible one, and the quiet failure it allows is stock that never left.
 */

import { expandRecipe, type ExpandedComponent, type RecipeVersion } from './recipe-version';

export const STOCK_EFFECT_MODES = ['direct', 'service', 'composed'] as const;
export type StockEffectMode = (typeof STOCK_EFFECT_MODES)[number];

export type StockEffectRefusalCode =
  /** I-1: a product is stock-tracked OR recipe-expanded, never both. */
  | 'restaurant_stock_effect.mode_ambiguous'
  /** Neither tracked nor recipe-backed and not declared a service. */
  | 'restaurant_stock_effect.mode_undetermined'
  | 'restaurant_stock_effect.component_missing'
  | 'restaurant_stock_effect.component_extra'
  | 'restaurant_stock_effect.component_duplicate'
  | 'restaurant_stock_effect.component_variant_mismatch'
  | 'restaurant_stock_effect.component_quantity_mismatch'
  | 'restaurant_stock_effect.direct_movement_set_invalid'
  | 'restaurant_stock_effect.service_consumed_stock'
  | 'restaurant_stock_effect.recipe_version_mismatch';

export class StockEffectRefusal extends Error {
  constructor(
    readonly code: StockEffectRefusalCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'StockEffectRefusal';
  }
}

/** What the catalogue and the recipe registry say about one sold product. */
export interface SoldProductFacts {
  readonly productId: string;
  /** The STOCK variant, when the product is stock-tracked. */
  readonly stockVariantId: string | null;
  readonly stockTracked: boolean;
  /** The recipe version bound to this sale line, or null. */
  readonly recipeVersion: RecipeVersion | null;
  /** The merchant declared this a service that consumes no inventory. */
  readonly declaredService: boolean;
}

/**
 * Decide the mode, or refuse.
 *
 * Ambiguity is a refusal rather than a precedence rule: if a product were both
 * tracked and recipe-backed, picking either silently would decrement the dish
 * *and* its ingredients, or neither, depending on which rule won — and no later
 * reconciliation could unpick it. I-1 says that state must not exist, so the
 * code says so too rather than coping with it.
 */
export function stockEffectModeOf(facts: SoldProductFacts): StockEffectMode {
  const claims = [facts.stockTracked, facts.recipeVersion !== null, facts.declaredService].filter(Boolean).length;
  if (claims > 1) {
    throw new StockEffectRefusal(
      'restaurant_stock_effect.mode_ambiguous',
      `Product ${facts.productId} claims more than one stock-effect mode; a product is tracked, recipe-backed or a service, never two`,
      {
        productId: facts.productId,
        stockTracked: facts.stockTracked,
        recipeBacked: facts.recipeVersion !== null,
        declaredService: facts.declaredService,
      },
    );
  }
  if (facts.stockTracked) return 'direct';
  if (facts.recipeVersion !== null) return 'composed';
  if (facts.declaredService) return 'service';
  throw new StockEffectRefusal(
    'restaurant_stock_effect.mode_undetermined',
    `Product ${facts.productId} is neither stock-tracked nor recipe-backed nor a declared service, so what it consumes is unknown`,
    { productId: facts.productId },
  );
}

export interface ExpectedMovement {
  readonly componentProductId: string;
  readonly componentVariantId: string;
  readonly quantityQ4: bigint;
}

/**
 * The exact movement set a sale line owes, per mode. This is the subject the
 * verifier compares against — derived from the authorities, never from the
 * movements themselves, so the comparison can never be an algorithm checked
 * against itself.
 */
export function expectedMovementsFor(facts: SoldProductFacts, soldQuantityQ4: bigint): readonly ExpectedMovement[] {
  const mode = stockEffectModeOf(facts);
  if (mode === 'service') return Object.freeze([]);
  if (mode === 'direct') {
    if (facts.stockVariantId === null) {
      throw new StockEffectRefusal(
        'restaurant_stock_effect.direct_movement_set_invalid',
        `Product ${facts.productId} is stock-tracked but names no stock variant`,
        { productId: facts.productId },
      );
    }
    return Object.freeze([Object.freeze({ componentProductId: facts.productId, componentVariantId: facts.stockVariantId, quantityQ4: soldQuantityQ4 })]);
  }
  const recipe = facts.recipeVersion;
  if (recipe === null) {
    throw new StockEffectRefusal('restaurant_stock_effect.mode_undetermined', `Composed mode without a recipe version for ${facts.productId}`, {
      productId: facts.productId,
    });
  }
  return expandRecipe(recipe, soldQuantityQ4) as readonly ExpandedComponent[];
}

/** A movement as the bridge actually recorded it, read back for verification. */
export interface ActualMovement {
  readonly componentProductId: string;
  readonly componentVariantId: string;
  readonly quantityQ4: bigint;
  /** The recipe version the committing command said it used, for a composed line. */
  readonly recipeVersion?: number;
}

function key(productId: string, variantId: string): string {
  return `${productId}:${variantId}`;
}

/**
 * Prove the recorded movement set is EXACTLY the expected one, or refuse naming
 * the first thing that is wrong.
 *
 * The checks run in this order so each defect gets its own name rather than
 * collapsing into a generic mismatch: duplicates first (a duplicate would
 * otherwise read as a quantity mismatch), then extras and variant confusion,
 * then missing components, then quantities. A wrong variant is detected as its
 * own case — it would otherwise be reported as one missing plus one extra, which
 * tells a reader two wrong things instead of one right one.
 *
 * `boundRecipeVersion` is checked for a composed line because §49's whole point
 * is that the committed sale names the version it used: movements recorded
 * against a different version are not this sale's movements.
 */
export function assertMovementSetComplete(
  expected: readonly ExpectedMovement[],
  actual: readonly ActualMovement[],
  options: { readonly boundRecipeVersion?: number } = {},
): void {
  const actualByKey = new Map<string, ActualMovement>();
  for (const movement of actual) {
    const k = key(movement.componentProductId, movement.componentVariantId);
    if (actualByKey.has(k)) {
      throw new StockEffectRefusal('restaurant_stock_effect.component_duplicate', `Component ${k} was moved twice for one sale line`, {
        componentProductId: movement.componentProductId,
        componentVariantId: movement.componentVariantId,
      });
    }
    actualByKey.set(k, movement);
    if (options.boundRecipeVersion !== undefined && movement.recipeVersion !== undefined && movement.recipeVersion !== options.boundRecipeVersion) {
      throw new StockEffectRefusal(
        'restaurant_stock_effect.recipe_version_mismatch',
        `Component ${k} was moved against recipe version ${movement.recipeVersion}, but this sale line is bound to version ${options.boundRecipeVersion}`,
        { componentProductId: movement.componentProductId, movedVersion: movement.recipeVersion, boundVersion: options.boundRecipeVersion },
      );
    }
  }

  if (expected.length === 0) {
    if (actual.length > 0) {
      const first = actual[0];
      throw new StockEffectRefusal(
        'restaurant_stock_effect.service_consumed_stock',
        `A service line moved ${actual.length} stock movement(s); a service consumes no inventory`,
        { movementCount: actual.length, componentProductId: first === undefined ? null : first.componentProductId },
      );
    }
    return;
  }

  const expectedByKey = new Map<string, ExpectedMovement>();
  const expectedProducts = new Set<string>();
  for (const want of expected) {
    expectedByKey.set(key(want.componentProductId, want.componentVariantId), want);
    expectedProducts.add(want.componentProductId);
  }

  for (const movement of actual) {
    const k = key(movement.componentProductId, movement.componentVariantId);
    if (expectedByKey.has(k)) continue;
    if (expectedProducts.has(movement.componentProductId)) {
      throw new StockEffectRefusal(
        'restaurant_stock_effect.component_variant_mismatch',
        `Component ${movement.componentProductId} was moved on variant ${movement.componentVariantId}, which this recipe does not name`,
        { componentProductId: movement.componentProductId, movedVariantId: movement.componentVariantId },
      );
    }
    throw new StockEffectRefusal('restaurant_stock_effect.component_extra', `Component ${k} was moved but no authority asked for it`, {
      componentProductId: movement.componentProductId,
      componentVariantId: movement.componentVariantId,
    });
  }

  for (const [k, want] of expectedByKey) {
    const got = actualByKey.get(k);
    if (got === undefined) {
      throw new StockEffectRefusal('restaurant_stock_effect.component_missing', `Component ${k} was expected but never moved`, {
        componentProductId: want.componentProductId,
        componentVariantId: want.componentVariantId,
        expectedQuantityQ4: want.quantityQ4.toString(),
      });
    }
    if (got.quantityQ4 !== want.quantityQ4) {
      throw new StockEffectRefusal(
        'restaurant_stock_effect.component_quantity_mismatch',
        `Component ${k} moved ${got.quantityQ4} where ${want.quantityQ4} was expected`,
        {
          componentProductId: want.componentProductId,
          componentVariantId: want.componentVariantId,
          expectedQuantityQ4: want.quantityQ4.toString(),
          movedQuantityQ4: got.quantityQ4.toString(),
        },
      );
    }
  }
}
