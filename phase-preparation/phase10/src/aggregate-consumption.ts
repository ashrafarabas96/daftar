/**
 * Phase 10 — what an AGGREGATED sale line consumes. §17 of the Master
 * Continuous Mission. PREPARED / NOT PROMOTED.
 *
 * `order-to-sale.ts` aggregates several order lines into one sale line because
 * the sale authority admits one line per variant. `recipe-version.ts` expands
 * one recipe version at one quantity. Between those two sits the question this
 * module answers, and which the pack previously got wrong by not asking it:
 *
 *   when one sale line was prepared under SEVERAL recipe versions, what does it
 *   consume?
 *
 * The wrong answer is to expand the summed quantity under one version. If two
 * lattes were made, one to v3 and one to v4 after the chef changed the milk, then
 * expanding "latte x 2" under either version consumes a quantity no cook ever
 * used. The directive names that outcome directly: no wrong billing and no wrong
 * consumption.
 *
 * The right answer is that consumption is per CONTRIBUTION, under each
 * contribution's OWN bound version, and the sale line's component set is the sum
 * of those expansions folded by component. Billing reads the summed quantity;
 * consumption reads the contributions. One aggregate, two readers, neither
 * lying.
 *
 * Summing is sound because the components are quantities of the same stock
 * variants: 0.150 litre of milk for the v3 cup plus 0.170 for the v4 cup is
 * 0.320 litre of milk, and that is exactly what left the fridge. What may NOT be
 * summed is the versions themselves, which is why they are carried as a set.
 */

import { assertBindingGoverns, type RecipeBinding } from './recipe-binding';
import { QUANTITY_SCALE, type ExpandedComponent, type RecipeVersion, expandRecipe, isRepresentableAtPrecision } from './recipe-version';
import type { SaleLineDraft } from './order-to-sale';

export type AggregateConsumptionRefusalCode =
  /** A contribution's quantities do not add up to the sale line's quantity. */
  | 'restaurant_aggregate.contributions_do_not_conserve'
  /** A sale line carries no contribution at all, so nothing says what it was. */
  | 'restaurant_aggregate.no_contributions'
  /** A composed contribution carries no recipe binding. */
  | 'restaurant_aggregate.contribution_not_bound'
  /** The recipe handed back for a contribution is not the version bound to it. */
  | 'restaurant_aggregate.recipe_not_the_bound_version'
  /** No recipe version was available for a bound contribution. */
  | 'restaurant_aggregate.bound_version_unavailable'
  /** Two bound versions declare different precisions for the same component. */
  | 'restaurant_aggregate.component_precision_disagreement'
  /** A folded component total is off its own stock unit's grain. */
  | 'restaurant_aggregate.folded_quantity_not_representable';

export class AggregateConsumptionRefusal extends Error {
  constructor(
    readonly code: AggregateConsumptionRefusalCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AggregateConsumptionRefusal';
  }
}

/** Hands back the recipe version bound to a contribution, or null if it has none. */
export type RecipeVersionLookup = (binding: RecipeBinding) => RecipeVersion | null;

function componentKey(productId: string, variantId: string): string {
  return `${productId}:${variantId}`;
}

/**
 * Prove the contributions account for the sale line's quantity exactly.
 *
 * Separate from the expansion on purpose. A sale line whose contributions do not
 * add up is a broken aggregate whatever its recipe says, and discovering that
 * while folding components would report it as a component error.
 */
export function assertContributionsConserve(draft: SaleLineDraft): void {
  if (draft.contributions.length === 0) {
    throw new AggregateConsumptionRefusal(
      'restaurant_aggregate.no_contributions',
      `Sale line ${componentKey(draft.productId, draft.variantId ?? '-')} carries no contribution, so nothing records what was prepared`,
      { productId: draft.productId, variantId: draft.variantId },
    );
  }
  let sum = 0n;
  for (const contribution of draft.contributions) sum += contribution.quantityQ4;
  if (sum !== draft.quantityQ4) {
    throw new AggregateConsumptionRefusal(
      'restaurant_aggregate.contributions_do_not_conserve',
      `Sale line ${draft.productId} bills ${draft.quantityQ4} but its contributions account for ${sum}`,
      {
        productId: draft.productId,
        variantId: draft.variantId,
        billedQuantityQ4: draft.quantityQ4.toString(),
        contributedQuantityQ4: sum.toString(),
        differenceQ4: (draft.quantityQ4 - sum).toString(),
      },
    );
  }
}

/**
 * The exact component set an aggregated COMPOSED sale line consumes.
 *
 * Each contribution is expanded under its own bound version, through the same
 * `expandRecipe` a single line uses — so §57's unit and precision laws apply to
 * every contribution rather than to the aggregate, which is the only place they
 * can be applied honestly. The per-contribution results are then folded by
 * component and the fold is re-checked against the stock grain, because two
 * quantities each on the grain sum to a quantity on the grain but a fold is
 * worth re-proving rather than assuming.
 *
 * `assertBindingGoverns` gates each lookup, so a recipe handed back under the
 * wrong version is refused by the same law that governs a single line.
 */
export function expandAggregatedSaleLine(draft: SaleLineDraft, lookup: RecipeVersionLookup): readonly ExpandedComponent[] {
  assertContributionsConserve(draft);

  const folded = new Map<string, { componentProductId: string; componentVariantId: string; quantityQ4: bigint; unitDecimals: number }>();

  for (const contribution of draft.contributions) {
    if (contribution.recipeBinding === null) {
      throw new AggregateConsumptionRefusal(
        'restaurant_aggregate.contribution_not_bound',
        `Contribution from order line ${contribution.orderLineId} carries no recipe binding, so there is no version to expand it under`,
        { orderLineId: contribution.orderLineId, modifierId: contribution.modifierId },
      );
    }
    const binding = contribution.recipeBinding;
    const recipe = lookup(binding);
    if (recipe === null) {
      throw new AggregateConsumptionRefusal(
        'restaurant_aggregate.bound_version_unavailable',
        `Recipe ${binding.recipeId} v${binding.version} is bound to order line ${contribution.orderLineId} but could not be read; a bound version is never substituted`,
        { orderLineId: contribution.orderLineId, recipeId: binding.recipeId, version: binding.version },
      );
    }
    // The same gate a single line passes: the version expanded is the version bound.
    try {
      assertBindingGoverns('sale_component_mapping', binding, recipe.recipeId, recipe.version);
    } catch {
      throw new AggregateConsumptionRefusal(
        'restaurant_aggregate.recipe_not_the_bound_version',
        `Order line ${contribution.orderLineId} is bound to ${binding.recipeId} v${binding.version} but the recipe read back was ${recipe.recipeId} v${recipe.version}`,
        { orderLineId: contribution.orderLineId, bound: { ...binding }, readBack: { recipeId: recipe.recipeId, version: recipe.version } },
      );
    }

    for (const component of expandRecipe(recipe, contribution.quantityQ4)) {
      const k = componentKey(component.componentProductId, component.componentVariantId);
      const declared = recipe.components.find(
        (c) => c.componentProductId === component.componentProductId && c.componentVariantId === component.componentVariantId,
      );
      if (declared === undefined) {
        // Unreachable through `expandRecipe`, which only emits declared
        // components; stated rather than assumed so a future change says so.
        throw new AggregateConsumptionRefusal(
          'restaurant_aggregate.recipe_not_the_bound_version',
          `Recipe ${recipe.recipeId} v${recipe.version} expanded a component ${k} it does not declare`,
          { orderLineId: contribution.orderLineId, componentKey: k },
        );
      }
      const existing = folded.get(k);
      if (existing === undefined) {
        folded.set(k, {
          componentProductId: component.componentProductId,
          componentVariantId: component.componentVariantId,
          quantityQ4: component.quantityQ4,
          unitDecimals: declared.unitDecimals,
        });
      } else {
        // A component's precision belongs to the PRODUCT, so two bound versions
        // declaring different precisions for it is a configuration defect, not
        // something to resolve by picking one. Refusing here is also what keeps
        // the fold on a single grain: see the guard below.
        if (existing.unitDecimals !== declared.unitDecimals) {
          throw new AggregateConsumptionRefusal(
            'restaurant_aggregate.component_precision_disagreement',
            `Component ${k} is declared at ${existing.unitDecimals} places by one bound version and ${declared.unitDecimals} by another; a component's precision is the product's, so the disagreement is refused rather than resolved`,
            {
              componentProductId: component.componentProductId,
              componentVariantId: component.componentVariantId,
              declaredPrecisions: [existing.unitDecimals, declared.unitDecimals],
              orderLineId: contribution.orderLineId,
            },
          );
        }
        existing.quantityQ4 += component.quantityQ4;
      }
    }
  }

  // A belt-and-braces guard, and its reachability is stated rather than assumed.
  // Every contribution's quantity is already on the component's grain (§57) and
  // the precisions are proven equal above, so a sum of multiples of one step is
  // a multiple of that step and this cannot fire. It is kept because it is the
  // invariant the canonical writer will actually test, and its unreachability is
  // MEASURED in `test/aggregate-consumption.test.ts` rather than claimed as a
  // red proof — a mutation here stays green, and a green mutation is not a proof.
  for (const entry of folded.values()) {
    if (!isRepresentableAtPrecision(entry.quantityQ4, entry.unitDecimals)) {
      throw new AggregateConsumptionRefusal(
        'restaurant_aggregate.folded_quantity_not_representable',
        `Component ${componentKey(entry.componentProductId, entry.componentVariantId)} folds to a total finer than its own ${entry.unitDecimals}-place unit precision`,
        {
          componentProductId: entry.componentProductId,
          componentVariantId: entry.componentVariantId,
          foldedQuantityQ4: entry.quantityQ4.toString(),
          unitDecimals: entry.unitDecimals,
        },
      );
    }
  }

  return Object.freeze(
    [...folded.values()]
      .map((entry) =>
        Object.freeze({
          componentProductId: entry.componentProductId,
          componentVariantId: entry.componentVariantId,
          quantityQ4: entry.quantityQ4,
        }),
      )
      .sort((a, b) => {
        if (a.componentProductId !== b.componentProductId) return a.componentProductId < b.componentProductId ? -1 : 1;
        return a.componentVariantId < b.componentVariantId ? -1 : a.componentVariantId > b.componentVariantId ? 1 : 0;
      }),
  );
}

/** Re-exported so a caller folding quantities need not reach for the scale itself. */
export { QUANTITY_SCALE };
