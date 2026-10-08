/**
 * Phase 10 — immutable recipe versions and deterministic expansion.
 * PREPARED / NOT PROMOTED. Ruling: TL-P10-R1 (composition accepted), §49.
 *
 * §49's law: a committed sale binds an IMMUTABLE recipe version, so tomorrow's
 * recipe edit cannot alter yesterday's COGS. There is no mutable "current
 * recipe" acting as historical authority. A recipe edit mints a new version; the
 * old version keeps existing because committed sales point at it.
 *
 * Quantities are scaled integers with four decimal places (Q4), matching the
 * live `sale_items.quantity NUMERIC(18,4)` and `restaurant_order_lines.quantity`.
 * Scaling a recipe needs a division, so it needs a stated rounding rule: HALF_EVEN
 * on the Q4 grain, which is the rule the SQL authority already uses
 * (`inventory_half_even`) and the one the sale path's own pricing uses. One rule
 * everywhere, so a dish cannot be expanded two ways.
 */

export type RecipeRefusalCode =
  | 'restaurant_recipe.yield_not_positive'
  | 'restaurant_recipe.no_components'
  | 'restaurant_recipe.component_duplicate'
  | 'restaurant_recipe.component_quantity_not_positive'
  | 'restaurant_recipe.component_quantity_rounds_to_zero'
  | 'restaurant_recipe.version_not_positive'
  | 'restaurant_recipe.sold_quantity_not_positive';

export class RecipeRefusal extends Error {
  constructor(
    readonly code: RecipeRefusalCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RecipeRefusal';
  }
}

/** One quarter of the Q4 grain's name, kept in one place. */
export const QUANTITY_SCALE = 10_000n;

export interface RecipeComponent {
  readonly componentProductId: string;
  /** The STOCK variant the warehouse actually holds. */
  readonly componentVariantId: string;
  /** How much of this component the recipe's whole yield consumes, in Q4. */
  readonly quantityQ4: bigint;
}

/**
 * An immutable recipe version. Nothing here is ever updated in place: a change
 * mints `version + 1` and leaves this row untouched, because committed sales
 * reference it by `(recipeId, version)`.
 */
export interface RecipeVersion {
  readonly recipeId: string;
  readonly version: number;
  readonly productId: string;
  readonly variantId: string | null;
  /** How many units of the dish one run of this recipe produces, in Q4. */
  readonly yieldQuantityQ4: bigint;
  readonly components: readonly RecipeComponent[];
}

export interface ExpandedComponent {
  readonly componentProductId: string;
  readonly componentVariantId: string;
  /** The quantity to CONSUME, positive. The movement's sign is the writer's business. */
  readonly quantityQ4: bigint;
}

function componentKey(productId: string, variantId: string): string {
  return `${productId}:${variantId}`;
}

/** HALF_EVEN division of two non-negative bigints — the SQL authority's rule. */
export function halfEvenDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new RecipeRefusal('restaurant_recipe.yield_not_positive', `A recipe yield is positive, not ${denominator}`, {
      yieldQuantityQ4: denominator.toString(),
    });
  }
  const quotient = numerator / denominator;
  const twiceRemainder = (numerator - quotient * denominator) * 2n;
  if (twiceRemainder > denominator) return quotient + 1n;
  if (twiceRemainder < denominator) return quotient;
  // Exactly half: round to the even quotient.
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

/**
 * Validate a recipe version's own shape, independently of any sale.
 *
 * A recipe that cannot be stated cannot be versioned, so this runs when the
 * version is minted and again before it is expanded — the second time matters
 * because a version read back from storage is still data.
 */
export function assertRecipeVersionWellFormed(recipe: RecipeVersion): void {
  if (!Number.isSafeInteger(recipe.version) || recipe.version < 1) {
    throw new RecipeRefusal('restaurant_recipe.version_not_positive', `A recipe version starts at 1, not ${recipe.version}`, {
      recipeId: recipe.recipeId,
      version: recipe.version,
    });
  }
  if (recipe.yieldQuantityQ4 <= 0n) {
    throw new RecipeRefusal('restaurant_recipe.yield_not_positive', `Recipe ${recipe.recipeId} v${recipe.version} has a non-positive yield`, {
      recipeId: recipe.recipeId,
      yieldQuantityQ4: recipe.yieldQuantityQ4.toString(),
    });
  }
  if (recipe.components.length === 0) {
    throw new RecipeRefusal('restaurant_recipe.no_components', `Recipe ${recipe.recipeId} v${recipe.version} consumes nothing, so it is not a recipe`, {
      recipeId: recipe.recipeId,
    });
  }
  const seen = new Set<string>();
  for (const component of recipe.components) {
    if (component.quantityQ4 <= 0n) {
      throw new RecipeRefusal(
        'restaurant_recipe.component_quantity_not_positive',
        `Component ${component.componentProductId} carries a non-positive quantity`,
        { componentProductId: component.componentProductId, quantityQ4: component.quantityQ4.toString() },
      );
    }
    const key = componentKey(component.componentProductId, component.componentVariantId);
    if (seen.has(key)) {
      throw new RecipeRefusal('restaurant_recipe.component_duplicate', `Component ${key} appears twice in recipe ${recipe.recipeId} v${recipe.version}`, {
        componentProductId: component.componentProductId,
        componentVariantId: component.componentVariantId,
      });
    }
    seen.add(key);
  }
}

/**
 * The EXACT set of component consumptions one sale line of this dish owes.
 *
 * Deterministic in both senses §49 asks for: the same recipe version and the
 * same sold quantity always give the same set, and the set is returned in a
 * canonical order (by product, then variant) so two callers cannot disagree
 * about the order either.
 *
 * A component that scales to zero is REFUSED, not dropped. Consuming none of an
 * ingredient the recipe says is needed is a silent loss of stock truth, and a
 * silent loss is the one outcome this pack may not produce.
 */
export function expandRecipe(recipe: RecipeVersion, soldQuantityQ4: bigint): readonly ExpandedComponent[] {
  assertRecipeVersionWellFormed(recipe);
  if (soldQuantityQ4 <= 0n) {
    throw new RecipeRefusal('restaurant_recipe.sold_quantity_not_positive', `A sold quantity is positive, not ${soldQuantityQ4}`, {
      soldQuantityQ4: soldQuantityQ4.toString(),
    });
  }
  const expanded = recipe.components.map((component) => {
    const quantityQ4 = halfEvenDiv(component.quantityQ4 * soldQuantityQ4, recipe.yieldQuantityQ4);
    if (quantityQ4 <= 0n) {
      throw new RecipeRefusal(
        'restaurant_recipe.component_quantity_rounds_to_zero',
        `Component ${component.componentProductId} scales to zero at the quantity grain; consuming none of a required ingredient is refused`,
        {
          componentProductId: component.componentProductId,
          componentVariantId: component.componentVariantId,
          recipeQuantityQ4: component.quantityQ4.toString(),
          soldQuantityQ4: soldQuantityQ4.toString(),
          yieldQuantityQ4: recipe.yieldQuantityQ4.toString(),
        },
      );
    }
    return Object.freeze({
      componentProductId: component.componentProductId,
      componentVariantId: component.componentVariantId,
      quantityQ4,
    });
  });
  return Object.freeze(
    expanded.sort((a, b) => {
      if (a.componentProductId !== b.componentProductId) return a.componentProductId < b.componentProductId ? -1 : 1;
      return a.componentVariantId < b.componentVariantId ? -1 : a.componentVariantId > b.componentVariantId ? 1 : 0;
    }),
  );
}
