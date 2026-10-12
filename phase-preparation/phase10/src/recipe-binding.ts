/**
 * Phase 10 — WHEN a recipe version binds to an order line. §56.
 * PREPARED / NOT PROMOTED.
 *
 * `recipe-version.ts` answers what a bound version expands to. This module
 * answers the question §56 corrected: at which moment does a line stop being
 * governed by "whatever the recipe says now" and start being governed by one
 * fixed version?
 *
 * ── The timing law ──
 * The version binds when the line FIRST ENTERS PHYSICAL PREPARATION — the
 * `queued -> preparing` transition — and never afterwards. It is explicitly NOT
 * "the current recipe at checkout", which was the reading this module replaces.
 *
 * The reason is physical, not clerical. The moment a cook takes ingredients off
 * the shelf, the dish being made is the dish described by the recipe as it stood
 * then. If the chef edits the recipe ten minutes later, the plate already on the
 * grill did not change, so neither may the version that governs it. Binding at
 * checkout would let an edit made DURING preparation decide what was consumed,
 * cancelled or costed — a fact about the kitchen rewritten by a fact about the
 * catalogue.
 *
 * One bound version therefore governs all four of §56's consequences: the
 * preparation itself, the waste a cancellation owes, the component set a
 * successful sale maps to, and the audit trail. Four readers, one version. Any
 * reader that re-derives "the latest version" instead of reading the binding is
 * a second authority over the same truth and is refused here.
 *
 * While a line is still `queued`, nothing physical has happened, so nothing is
 * bound. §56 permits selecting the latest valid version for such a line, and
 * this module models that as ADVISORY: a candidate the kitchen display may show
 * and the binding step may or may not use. A queued line that is cancelled
 * wastes nothing (`cancellationWastesStock`), which is exactly why it needs no
 * binding — there is no consumption for a version to govern.
 */

import type { PreparationEvent, PreparationState } from './preparation-state';

export type RecipeBindingRefusalCode =
  /** Something tried to bind a version at a moment that is not the start of preparation. */
  | 'restaurant_recipe_binding.not_at_preparation_start'
  /** A line already carries a binding and something tried to replace it. */
  | 'restaurant_recipe_binding.already_bound'
  /** A consequence of preparation was asked for on a line that carries no binding. */
  | 'restaurant_recipe_binding.absent'
  /** A reader used a version other than the one bound to the line. */
  | 'restaurant_recipe_binding.version_mismatch'
  /** A binding names a different recipe than the one asked about. */
  | 'restaurant_recipe_binding.recipe_mismatch';

export class RecipeBindingRefusal extends Error {
  constructor(
    readonly code: RecipeBindingRefusalCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RecipeBindingRefusal';
  }
}

/**
 * The authoritative binding on an order line. Immutable by construction: there
 * is no function here that changes one, only one that mints it.
 */
export interface RecipeBinding {
  readonly recipeId: string;
  readonly version: number;
}

/**
 * The four readers §56 names. Each one must read the binding rather than ask
 * the catalogue, and this type exists so a refusal can say which reader broke
 * the rule instead of reporting an anonymous mismatch.
 */
export const BINDING_GOVERNED_READERS = ['preparation', 'cancellation_waste', 'sale_component_mapping', 'audit'] as const;
export type BindingGovernedReader = (typeof BINDING_GOVERNED_READERS)[number];

/**
 * Is this the transition that binds? Exactly one transition does: the first
 * entry into physical preparation.
 *
 * `ready -> ...` and every later transition are already inside preparation, so
 * they bind nothing new; they are governed by the binding minted at `start`.
 */
export function isBindingTransition(current: PreparationState, event: PreparationEvent): boolean {
  return current === 'queued' && event === 'start';
}

/**
 * Mint the authoritative binding for a line entering preparation.
 *
 * `existing` is the line's current binding, if the caller believes it has one.
 * Passing a non-null `existing` here is a defect, not a convenience: a line that
 * already carries a binding has already entered preparation, so it cannot be
 * entering it again. That is refused rather than overwritten, because
 * overwriting is precisely the "recipe edited mid-preparation" outcome §56
 * forbids.
 */
export function bindAtPreparationStart(
  current: PreparationState,
  event: PreparationEvent,
  selectedVersion: RecipeBinding,
  existing: RecipeBinding | null,
): RecipeBinding {
  if (!isBindingTransition(current, event)) {
    throw new RecipeBindingRefusal(
      'restaurant_recipe_binding.not_at_preparation_start',
      `A recipe version binds when a line first enters preparation, not on ${current}/${event}`,
      { current, event },
    );
  }
  if (existing !== null) {
    throw new RecipeBindingRefusal(
      'restaurant_recipe_binding.already_bound',
      `The line is already bound to recipe ${existing.recipeId} v${existing.version}; a bound version is never replaced`,
      { existing: { ...existing }, attempted: { ...selectedVersion } },
    );
  }
  if (!Number.isSafeInteger(selectedVersion.version) || selectedVersion.version < 1) {
    throw new RecipeBindingRefusal('restaurant_recipe_binding.version_mismatch', `A bound recipe version starts at 1, not ${selectedVersion.version}`, {
      attempted: { ...selectedVersion },
    });
  }
  return Object.freeze({ recipeId: selectedVersion.recipeId, version: selectedVersion.version });
}

/**
 * The advisory candidate for a line that has NOT started preparation.
 *
 * §56's allowance, and its limit: this is what a display may show and what
 * `bindAtPreparationStart` may be handed. It is not authority. A line that never
 * leaves `queued` is cancelled without waste, so this candidate never governs a
 * consumption; if preparation does start, the value becomes authoritative only
 * by passing through the binding step above.
 */
export function advisoryVersionForQueuedLine(state: PreparationState, latestValidVersion: RecipeBinding): RecipeBinding | null {
  if (state !== 'queued') return null;
  return Object.freeze({ recipeId: latestValidVersion.recipeId, version: latestValidVersion.version });
}

/**
 * The gate every one of §56's four readers passes through.
 *
 * It answers one question — may this reader use this version for this line? —
 * and refuses three distinct ways, each named, because the three mean different
 * defects: a missing binding is a line whose preparation was never recorded, a
 * version mismatch is a reader that consulted the catalogue instead of the line,
 * and a recipe mismatch is a reader looking at the wrong dish entirely.
 */
export function assertBindingGoverns(reader: BindingGovernedReader, binding: RecipeBinding | null, usedRecipeId: string, usedVersion: number): void {
  if (binding === null) {
    throw new RecipeBindingRefusal(
      'restaurant_recipe_binding.absent',
      `${reader} needs the recipe version bound at preparation start, and this line carries none`,
      { reader, usedRecipeId, usedVersion },
    );
  }
  if (binding.recipeId !== usedRecipeId) {
    throw new RecipeBindingRefusal(
      'restaurant_recipe_binding.recipe_mismatch',
      `${reader} used recipe ${usedRecipeId} but the line is bound to ${binding.recipeId}`,
      { reader, bound: { ...binding }, usedRecipeId, usedVersion },
    );
  }
  if (binding.version !== usedVersion) {
    throw new RecipeBindingRefusal(
      'restaurant_recipe_binding.version_mismatch',
      `${reader} used recipe ${usedRecipeId} v${usedVersion} but the line is bound to v${binding.version}; a later edit cannot govern a line already prepared`,
      { reader, bound: { ...binding }, usedRecipeId, usedVersion },
    );
  }
}
