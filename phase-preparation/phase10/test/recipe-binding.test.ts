import { describe, expect, it } from 'vitest';
import {
  BINDING_GOVERNED_READERS,
  RecipeBindingRefusal,
  advisoryVersionForQueuedLine,
  assertBindingGoverns,
  bindAtPreparationStart,
  isBindingTransition,
} from '../src/recipe-binding';
import { PREPARATION_STATES } from '../src/preparation-state';
import type { PreparationEvent, PreparationState } from '../src/preparation-state';

const V1 = { recipeId: 'r-latte', version: 1 } as const;
const V2 = { recipeId: 'r-latte', version: 2 } as const;
const EVENTS: readonly PreparationEvent[] = ['start', 'finish', 'serve', 'cancel'];

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof RecipeBindingRefusal) return error.code;
    throw error;
  }
  throw new Error('expected a RecipeBindingRefusal, none was thrown');
}

describe('§56 — exactly one transition binds', () => {
  it('binds on queued/start and on nothing else', () => {
    const binding: [PreparationState, PreparationEvent][] = [];
    for (const state of PREPARATION_STATES) {
      for (const event of EVENTS) {
        if (isBindingTransition(state, event)) binding.push([state, event]);
      }
    }
    expect(binding).toEqual([['queued', 'start']]);
  });

  it('refuses a bind at checkout — the reading §56 replaced', () => {
    // "the current recipe at checkout" is, in state terms, a bind on an already
    // prepared line. Every non-queued/start moment is refused by name.
    expect(codeOf(() => bindAtPreparationStart('ready', 'serve', V1, null))).toBe('restaurant_recipe_binding.not_at_preparation_start');
    expect(codeOf(() => bindAtPreparationStart('preparing', 'finish', V1, null))).toBe('restaurant_recipe_binding.not_at_preparation_start');
    expect(codeOf(() => bindAtPreparationStart('served', 'cancel', V1, null))).toBe('restaurant_recipe_binding.not_at_preparation_start');
  });

  it('mints a frozen binding at preparation start', () => {
    const bound = bindAtPreparationStart('queued', 'start', V1, null);
    expect(bound).toEqual({ recipeId: 'r-latte', version: 1 });
    expect(Object.isFrozen(bound)).toBe(true);
  });

  it('refuses to replace a binding a line already carries', () => {
    expect(codeOf(() => bindAtPreparationStart('queued', 'start', V2, V1))).toBe('restaurant_recipe_binding.already_bound');
  });

  it('refuses a version below 1', () => {
    expect(codeOf(() => bindAtPreparationStart('queued', 'start', { recipeId: 'r-latte', version: 0 }, null))).toBe(
      'restaurant_recipe_binding.version_mismatch',
    );
  });
});

describe('§56 — the bound version governs all four readers', () => {
  it('admits the bound version for every reader', () => {
    for (const reader of BINDING_GOVERNED_READERS) {
      expect(() => assertBindingGoverns(reader, V1, 'r-latte', 1)).not.toThrow();
    }
  });

  it('refuses a later version for every reader, which is the recipe-edited-mid-preparation case', () => {
    for (const reader of BINDING_GOVERNED_READERS) {
      expect(codeOf(() => assertBindingGoverns(reader, V1, 'r-latte', 2))).toBe('restaurant_recipe_binding.version_mismatch');
    }
  });

  it('names the four readers §56 lists, and no others', () => {
    expect([...BINDING_GOVERNED_READERS]).toEqual(['preparation', 'cancellation_waste', 'sale_component_mapping', 'audit']);
  });

  it('refuses an absent binding and a wrong recipe with distinct codes', () => {
    expect(codeOf(() => assertBindingGoverns('sale_component_mapping', null, 'r-latte', 1))).toBe('restaurant_recipe_binding.absent');
    expect(codeOf(() => assertBindingGoverns('audit', V1, 'r-mocha', 1))).toBe('restaurant_recipe_binding.recipe_mismatch');
  });
});

describe('§56 — the queued candidate is advisory', () => {
  it('offers the latest version only while queued', () => {
    expect(advisoryVersionForQueuedLine('queued', V2)).toEqual({ recipeId: 'r-latte', version: 2 });
    for (const state of PREPARATION_STATES.filter((s) => s !== 'queued')) {
      expect(advisoryVersionForQueuedLine(state, V2)).toBeNull();
    }
  });

  it('is not itself authority: it still has to pass through the binding step', () => {
    const candidate = advisoryVersionForQueuedLine('queued', V2);
    if (candidate === null) throw new Error('a queued line must have an advisory candidate');
    // A reader handed the candidate directly, with no binding on the line, is refused.
    expect(codeOf(() => assertBindingGoverns('preparation', null, candidate.recipeId, candidate.version))).toBe('restaurant_recipe_binding.absent');
  });
});
