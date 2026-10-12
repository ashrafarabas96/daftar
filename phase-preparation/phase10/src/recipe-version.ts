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
 *
 * ── §57, units ──
 * A component quantity is stated on the CANONICAL inventory unit and the
 * canonical Q4 grain, never on a restaurant unit of its own. This module owns no
 * conversion factor and will not invent one: a component whose recipe unit is
 * not the unit the warehouse holds is REFUSED at validation, before service, so
 * the configuration is corrected rather than silently converted. Conversion,
 * when it is genuinely needed, is the canonical inventory unit-conversion
 * authority's answer and arrives here already on the stock unit. Scaling is the
 * single HALF_EVEN rule above on the Q4 grain; STORING is checked against the
 * component's own `unit_decimals`, because `inventory_quantity_is_representable`
 * (`0060:258`) is what the canonical writer actually enforces, and a quantity
 * off that grain is refused rather than rounded onto it. So no quantity is
 * changed quietly in either direction.
 */

export type RecipeRefusalCode =
  | 'restaurant_recipe.yield_not_positive'
  | 'restaurant_recipe.no_components'
  | 'restaurant_recipe.component_duplicate'
  | 'restaurant_recipe.component_quantity_not_positive'
  | 'restaurant_recipe.component_quantity_rounds_to_zero'
  | 'restaurant_recipe.version_not_positive'
  | 'restaurant_recipe.sold_quantity_not_positive'
  /** A component states a recipe unit that is not the stock unit; this pack owns no conversion. */
  | 'restaurant_recipe.component_unit_not_canonical'
  /** A component's declared precision is outside the inventory authority's 0..4. */
  | 'restaurant_recipe.component_unit_decimals_invalid'
  /** A component quantity carries a digit finer than the component's own unit precision. */
  | 'restaurant_recipe.component_quantity_not_representable'
  /** A component declares no unit at all, so nothing proves it is on the canonical grain. */
  | 'restaurant_recipe.component_unit_absent';

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
  /**
   * The unit the recipe states this quantity in, and the unit the warehouse
   * holds the component in. Both are recorded because §57 forbids this module
   * from assuming they agree — see `assertRecipeVersionWellFormed`.
   */
  readonly recipeUnit: string;
  readonly stockUnit: string;
  /**
   * The component product's own `products.unit_decimals` (0..4). This is NOT
   * decoration: `inventory_quantity_is_representable` (`0060:258`) makes the
   * canonical stock writer REFUSE a movement whose quantity carries a digit
   * finer than this, so it is the grain every consumption of this component
   * must land on.
   */
  readonly unitDecimals: number;
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

/** 10^(4 - unitDecimals): the Q4 step one unit of the component's own precision spans. */
function precisionStepQ4(unitDecimals: number): bigint {
  let step = 1n;
  for (let i = unitDecimals; i < 4; i += 1) step *= 10n;
  return step;
}

/** Is this Q4 quantity expressible at `unitDecimals` places, as the authority requires? */
export function isRepresentableAtPrecision(quantityQ4: bigint, unitDecimals: number): boolean {
  return quantityQ4 % precisionStepQ4(unitDecimals) === 0n;
}

/**
 * The nearest quantity on the component's own grain, HALF_EVEN — offered for
 * DIAGNOSIS, never used to produce a movement.
 *
 * §57 has two clauses and they do different work. "Rounding must match the
 * canonical inventory Q4 precision/rounding contract" governs the SCALING step:
 * dividing a recipe by its yield is HALF_EVEN on the Q4 grain, which is what
 * `halfEvenDiv` does. "If it cannot represent the exact allowed precision,
 * REFUSE before service. No silent quantity loss" governs the STORING step, and
 * it is not a rounding instruction — it is a refusal instruction.
 *
 * The distinction matters because the two steps lose different things. Scaling
 * HALF_EVEN to Q4 lands on the grain the recipe is authored on, so nothing is
 * lost that was ever stated. Rounding again onto a coarser `unit_decimals` would
 * change what the dish consumes by up to half of the warehouse's grain —
 * 2.25 cups silently becoming 2 — and that is the silent quantity change §57
 * forbids. So `expandRecipe` refuses instead, and this function exists only so a
 * refusal can tell the configurator which quantity would have been representable.
 */
export function nearestRepresentableQuantity(quantityQ4: bigint, unitDecimals: number): bigint {
  const step = precisionStepQ4(unitDecimals);
  if (step === 1n) return quantityQ4;
  return halfEvenDiv(quantityQ4, step) * step;
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
    // §57, before anything is computed: the quantity is only meaningful once the
    // unit it is stated in is the unit the warehouse holds.
    if (component.recipeUnit.length === 0 || component.stockUnit.length === 0) {
      throw new RecipeRefusal(
        'restaurant_recipe.component_unit_absent',
        `Component ${component.componentProductId} does not state both its recipe unit and its stock unit`,
        { componentProductId: component.componentProductId, recipeUnit: component.recipeUnit, stockUnit: component.stockUnit },
      );
    }
    if (component.recipeUnit !== component.stockUnit) {
      throw new RecipeRefusal(
        'restaurant_recipe.component_unit_not_canonical',
        `Component ${component.componentProductId} is stated in ${component.recipeUnit} but held in ${component.stockUnit}; the restaurant pack owns no conversion factor, so this configuration is refused before service`,
        {
          componentProductId: component.componentProductId,
          recipeUnit: component.recipeUnit,
          stockUnit: component.stockUnit,
          resolution: 'convert through the canonical inventory unit-conversion authority and state the component on the stock unit, or correct the recipe',
        },
      );
    }
    if (!Number.isSafeInteger(component.unitDecimals) || component.unitDecimals < 0 || component.unitDecimals > 4) {
      throw new RecipeRefusal(
        'restaurant_recipe.component_unit_decimals_invalid',
        `Component ${component.componentProductId} declares a precision of ${component.unitDecimals}; the inventory authority allows 0 to 4`,
        { componentProductId: component.componentProductId, unitDecimals: component.unitDecimals },
      );
    }
    if (component.quantityQ4 > 0n && !isRepresentableAtPrecision(component.quantityQ4, component.unitDecimals)) {
      throw new RecipeRefusal(
        'restaurant_recipe.component_quantity_not_representable',
        `Component ${component.componentProductId} is authored at a grain finer than its own ${component.unitDecimals}-place unit precision; the canonical stock writer would refuse the movement, so the recipe is refused before service`,
        {
          componentProductId: component.componentProductId,
          quantityQ4: component.quantityQ4.toString(),
          unitDecimals: component.unitDecimals,
          stockUnit: component.stockUnit,
        },
      );
    }
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
 *
 * Every expanded quantity must be expressible on the COMPONENT'S OWN precision
 * grain, not merely on Q4 — see `nearestRepresentableQuantity` for why the two
 * differ. One that is not is refused HERE, which is the whole point: the
 * alternative is `inventory_quantity_is_representable` (`0060:258`) refusing the
 * movement inside the canonical stock writer at sale commit, which is after the
 * dish was cooked and served. The same recipe at a portion size that does divide
 * cleanly is accepted, so the refusal is about this portioning and not about
 * fractional sales as such.
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
    if (quantityQ4 > 0n && !isRepresentableAtPrecision(quantityQ4, component.unitDecimals)) {
      throw new RecipeRefusal(
        'restaurant_recipe.component_quantity_not_representable',
        `Component ${component.componentProductId} scales to a quantity finer than its own ${component.unitDecimals}-place unit precision at this portion size; rounding it would silently change what the dish consumes, so the sale is refused instead`,
        {
          componentProductId: component.componentProductId,
          componentVariantId: component.componentVariantId,
          scaledQuantityQ4: quantityQ4.toString(),
          unitDecimals: component.unitDecimals,
          stockUnit: component.stockUnit,
          nearestRepresentableQ4: nearestRepresentableQuantity(quantityQ4, component.unitDecimals).toString(),
          soldQuantityQ4: soldQuantityQ4.toString(),
        },
      );
    }
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
          unitDecimals: component.unitDecimals,
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
