/**
 * Phase 10 — preparation (kitchen) state. PREPARED / NOT PROMOTED.
 *
 * LAW 3: a preparation transition changes nothing in the ledger and nothing in
 * stock. The single physical consequence is waste: ingredients that left stock
 * for a dish the guest never received.
 */

export const PREPARATION_STATES = ['queued', 'preparing', 'ready', 'served', 'cancelled'] as const;
export type PreparationState = (typeof PREPARATION_STATES)[number];

export type PreparationEvent = 'start' | 'finish' | 'serve' | 'cancel';

export type PreparationRefusalCode =
  | 'restaurant.preparation.transition_not_allowed'
  | 'restaurant.preparation.terminal_state'
  | 'restaurant.preparation.cancel_after_served';

export class PreparationRefusal extends Error {
  constructor(
    readonly code: PreparationRefusalCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PreparationRefusal';
  }
}

const TRANSITIONS: Readonly<Record<PreparationState, Readonly<Partial<Record<PreparationEvent, PreparationState>>>>> = Object.freeze({
  queued: Object.freeze({ start: 'preparing', cancel: 'cancelled' }),
  preparing: Object.freeze({ finish: 'ready', cancel: 'cancelled' }),
  ready: Object.freeze({ serve: 'served', cancel: 'cancelled' }),
  served: Object.freeze({}),
  cancelled: Object.freeze({}),
});

export const TERMINAL_PREPARATION_STATES: readonly PreparationState[] = Object.freeze(['served', 'cancelled']);

export function isTerminalPreparationState(state: PreparationState): boolean {
  return TERMINAL_PREPARATION_STATES.includes(state);
}

export function nextPreparationState(current: PreparationState, event: PreparationEvent): PreparationState {
  if (current === 'served' && event === 'cancel') {
    // Named separately from the generic refusal: a served dish is returned
    // through the Phase 4 returns/credit-note authority, not un-cooked here.
    throw new PreparationRefusal(
      'restaurant.preparation.cancel_after_served',
      'A served item is reversed through the returns authority, not cancelled in the kitchen',
      { current },
    );
  }
  if (isTerminalPreparationState(current)) {
    throw new PreparationRefusal('restaurant.preparation.terminal_state', `A ${current} item accepts no event, including ${event}`, { current, event });
  }
  const target = TRANSITIONS[current][event];
  if (target === undefined) {
    throw new PreparationRefusal('restaurant.preparation.transition_not_allowed', `A ${current} item cannot ${event}`, { current, event });
  }
  return target;
}

/**
 * Did ingredients physically leave stock for this item before it was cancelled?
 *
 * TRUE means the cancellation owes a WASTE movement through the inventory
 * authority (LAW 3). FALSE means it owes nothing: nothing was ever taken.
 *
 * The boundary is `preparing`: the moment a cook takes the ingredients. A dish
 * cancelled while still `queued` was never started.
 */
export function cancellationWastesStock(stateAtCancellation: PreparationState): boolean {
  switch (stateAtCancellation) {
    case 'queued':
      return false;
    case 'preparing':
    case 'ready':
      return true;
    case 'served':
    case 'cancelled':
      // Neither is a cancellation this function is asked about; a served item
      // goes through returns and an already-cancelled item wastes nothing twice.
      return false;
    default: {
      // Exhaustiveness: a new state must decide its own waste answer, loudly.
      const unreachable: never = stateAtCancellation;
      throw new PreparationRefusal('restaurant.preparation.transition_not_allowed', `No waste rule is defined for preparation state ${String(unreachable)}`, {
        state: String(unreachable),
      });
    }
  }
}
