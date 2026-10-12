/**
 * Phase 10 — WHAT a cancellation wastes, not merely WHETHER it wastes.
 * PREPARED / NOT PROMOTED. Independent challenge at `b40f05c`, finding P2-05.
 *
 * `cancellationWastesStock(state)` answers a boolean, and until this module
 * existed that boolean was the pack's entire account of the waste path: there
 * was no component set, no quantity, and no exact-set verification anywhere on
 * the one route where stock leaves the shelf and no invoice is ever raised
 * against it.
 *
 * That asymmetry matters more than it looks. §48's law — exact-set equality,
 * because "at least one movement" cannot tell a complete set from a plausible
 * one — was enforced on the SALE path only. On the sale path a wrong set is at
 * least reconcilable afterwards: there is an invoice, a quantity and a price to
 * compare it against. On the waste path there is nothing to reconcile against.
 * A component missed is stock that silently never came off; a component
 * doubled is stock that silently came off twice; and no document anywhere
 * disagrees with either.
 *
 * So waste is expanded exactly as a sale is: per line, under the line's OWN
 * bound recipe version, through the same `expandRecipe`, gated by the same
 * `assertBindingGoverns` — with `cancellation_waste` as the reader, which is
 * one of the four readers §56 already names — and verified by the same
 * `assertMovementSetComplete`. One expansion rule, two occasions.
 *
 * What this module does NOT do is decide whether waste is owed. That is
 * `occasionOwedBy`'s answer, and asking for a waste set on a line that owes
 * none is refused rather than answered with an empty one: an empty set and
 * "this line wastes nothing" are different facts, and a caller that confuses
 * them records neither.
 */

import { cancellationWastesStock, type PreparationState } from './preparation-state';
import { assertBindingGoverns, type RecipeBinding } from './recipe-binding';
import { expandRecipe, type RecipeVersion } from './recipe-version';
import { expectedMovementsFor, type ExpectedMovement, type StockEffectMode } from './stock-effect';

export type WasteRefusalCode =
  /** A waste set was asked for on a line whose cancellation wastes nothing. */
  | 'restaurant_waste.not_owed'
  /** A composed line was cancelled mid-preparation with no recipe bound to it. */
  | 'restaurant_waste.binding_absent'
  /** The recipe read back is not the version bound to the line. */
  | 'restaurant_waste.recipe_not_the_bound_version'
  /** The bound version could not be read; a bound version is never substituted. */
  | 'restaurant_waste.bound_version_unavailable'
  /** A service line cannot waste: it never consumed anything to waste. */
  | 'restaurant_waste.service_cannot_waste';

export class WasteRefusal extends Error {
  constructor(
    readonly code: WasteRefusalCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'WasteRefusal';
  }
}

/** One cancelled line, with everything needed to say what it took with it. */
export interface CancelledLine {
  readonly orderLineId: string;
  readonly mode: StockEffectMode;
  readonly stateAtCancellation: PreparationState;
  readonly quantityQ4: bigint;
  /** Required for a composed line: the version the cook actually worked to. */
  readonly recipeBinding: RecipeBinding | null;
  /** Direct mode only: the stock variant and its own grain. */
  readonly stockProductId: string | null;
  readonly stockVariantId: string | null;
  readonly stockUnitDecimals: number | null;
}

export type RecipeVersionLookup = (binding: RecipeBinding) => RecipeVersion | null;

/**
 * The exact movement set a cancellation owes, or a refusal.
 *
 * The set is produced from the AUTHORITIES — the bound recipe version and the
 * line's quantity — never from whatever movements a writer happened to make,
 * so `assertMovementSetComplete` can compare the two without checking an
 * algorithm against itself.
 */
export function expectedWasteMovements(line: CancelledLine, lookup: RecipeVersionLookup): readonly ExpectedMovement[] {
  if (line.mode === 'service') {
    throw new WasteRefusal(
      'restaurant_waste.service_cannot_waste',
      `Line ${line.orderLineId} is a service; a service consumes no inventory, so cancelling it wastes none`,
      { orderLineId: line.orderLineId },
    );
  }
  if (!cancellationWastesStock(line.stateAtCancellation)) {
    throw new WasteRefusal(
      'restaurant_waste.not_owed',
      `Line ${line.orderLineId} was cancelled in state ${line.stateAtCancellation}, which owes no waste; an empty set and "nothing is owed" are different answers`,
      { orderLineId: line.orderLineId, stateAtCancellation: line.stateAtCancellation },
    );
  }

  if (line.mode === 'direct') {
    // Delegated rather than re-derived, so the direct path's grain check (§57)
    // applies to a wasted bottle exactly as it does to a sold one.
    return expectedMovementsFor(
      {
        productId: line.stockProductId ?? line.orderLineId,
        stockVariantId: line.stockVariantId,
        stockTracked: true,
        stockUnitDecimals: line.stockUnitDecimals,
        recipeVersion: null,
        declaredService: false,
      },
      line.quantityQ4,
    );
  }

  const binding = line.recipeBinding;
  if (binding === null) {
    // §56 binds at `queued -> start`, and waste is owed from `preparing`
    // onward — so a line that owes waste has passed the binding transition and
    // a missing binding is a real inconsistency, not a tolerable gap. Guessing
    // the current version here would consume today's recipe for a dish cooked
    // to yesterday's.
    throw new WasteRefusal(
      'restaurant_waste.binding_absent',
      `Line ${line.orderLineId} was cancelled in state ${line.stateAtCancellation} with no recipe bound, so what the cook actually took cannot be known`,
      { orderLineId: line.orderLineId, stateAtCancellation: line.stateAtCancellation },
    );
  }
  const recipe = lookup(binding);
  if (recipe === null) {
    throw new WasteRefusal(
      'restaurant_waste.bound_version_unavailable',
      `Recipe ${binding.recipeId} v${binding.version} is bound to line ${line.orderLineId} but could not be read; a bound version is never substituted`,
      { orderLineId: line.orderLineId, recipeId: binding.recipeId, version: binding.version },
    );
  }
  try {
    assertBindingGoverns('cancellation_waste', binding, recipe.recipeId, recipe.version);
  } catch {
    throw new WasteRefusal(
      'restaurant_waste.recipe_not_the_bound_version',
      `Line ${line.orderLineId} is bound to ${binding.recipeId} v${binding.version} but the recipe read back was ${recipe.recipeId} v${recipe.version}`,
      { orderLineId: line.orderLineId, bound: { ...binding }, readBack: { recipeId: recipe.recipeId, version: recipe.version } },
    );
  }
  return expandRecipe(recipe, line.quantityQ4);
}

/**
 * Which of a set of cancelled lines owe a waste movement at all.
 *
 * Exists because the aggregator drops voided lines unconditionally — correctly,
 * for BILLING — and a reader of its output therefore cannot tell a line voided
 * while `queued`, which wastes nothing, from one voided after `preparing`,
 * which owes a full component set. The two facts leave the aggregator together
 * and have to be recovered from the order lines themselves.
 */
export function linesOwingWaste(lines: readonly CancelledLine[]): readonly CancelledLine[] {
  return Object.freeze(lines.filter((line) => line.mode !== 'service' && cancellationWastesStock(line.stateAtCancellation)));
}
