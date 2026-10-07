import { describe, expect, it } from 'vitest';
import {
  TABLE_SESSION_STATES,
  TableSessionRefusal,
  isTerminalTableSessionState,
  nextTableSessionState,
  type TableSessionEvent,
  type TableSessionState,
} from '../src/table-session-state';
import {
  PREPARATION_STATES,
  cancellationWastesStock,
  isTerminalPreparationState,
  nextPreparationState,
  type PreparationEvent,
  type PreparationState,
} from '../src/preparation-state';

const CLEAN = { placedLineCount: 0, unsettledBillCount: 0 } as const;

describe('table session lifecycle', () => {
  it('walks the ordinary visit: open -> billing -> closed', () => {
    expect(nextTableSessionState('open', 'request_bill', CLEAN)).toBe('billing');
    expect(nextTableSessionState('billing', 'settle', CLEAN)).toBe('closed');
  });

  it('lets a party order again after asking for the bill', () => {
    expect(nextTableSessionState('billing', 'reopen_for_ordering', CLEAN)).toBe('open');
  });

  it('abandons only an empty session', () => {
    expect(nextTableSessionState('open', 'abandon', CLEAN)).toBe('abandoned');
  });

  it('refuses to abandon a session that placed orders — that bill is settled or voided', () => {
    try {
      nextTableSessionState('open', 'abandon', { placedLineCount: 3, unsettledBillCount: 0 });
      throw new Error('expected a refusal');
    } catch (error) {
      const refusal = error as TableSessionRefusal;
      expect(refusal.code).toBe('restaurant.table_session.abandon_with_orders');
      expect(refusal.details?.placedLineCount).toBe(3);
    }
  });

  it('refuses to close a session whose bill the SALE authority still reports unsettled', () => {
    expect(() => nextTableSessionState('billing', 'settle', { placedLineCount: 2, unsettledBillCount: 1 })).toThrowError(
      expect.objectContaining({ code: 'restaurant.table_session.settle_with_unsettled_bill' }),
    );
  });

  it('names a terminal state as terminal, not as a disallowed transition', () => {
    for (const terminal of ['closed', 'abandoned'] as const) {
      expect(isTerminalTableSessionState(terminal)).toBe(true);
      expect(() => nextTableSessionState(terminal, 'settle', CLEAN)).toThrowError(expect.objectContaining({ code: 'restaurant.table_session.terminal_state' }));
    }
  });

  it('exhausts the whole state x event matrix: every pair either moves or refuses by a named code, and the matrix is not empty', () => {
    const events: readonly TableSessionEvent[] = ['request_bill', 'reopen_for_ordering', 'settle', 'abandon'];
    let allowed = 0;
    let refused = 0;
    for (const state of TABLE_SESSION_STATES as readonly TableSessionState[]) {
      for (const event of events) {
        try {
          const target = nextTableSessionState(state, event, CLEAN);
          expect(TABLE_SESSION_STATES).toContain(target);
          allowed += 1;
        } catch (error) {
          expect(error).toBeInstanceOf(TableSessionRefusal);
          expect((error as TableSessionRefusal).code).toMatch(/^restaurant\.table_session\./);
          refused += 1;
        }
      }
    }
    expect(allowed + refused).toBe(TABLE_SESSION_STATES.length * events.length);
    // Exactly the four edges the transition table declares.
    expect(allowed).toBe(4);
    expect(refused).toBe(12);
  });
});

describe('preparation state', () => {
  it('walks the kitchen: queued -> preparing -> ready -> served', () => {
    expect(nextPreparationState('queued', 'start')).toBe('preparing');
    expect(nextPreparationState('preparing', 'finish')).toBe('ready');
    expect(nextPreparationState('ready', 'serve')).toBe('served');
  });

  it('cancels from any pre-service state', () => {
    for (const state of ['queued', 'preparing', 'ready'] as const) {
      expect(nextPreparationState(state, 'cancel')).toBe('cancelled');
    }
  });

  it('sends a served item to the returns authority rather than cancelling it, with its own code', () => {
    try {
      nextPreparationState('served', 'cancel');
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('restaurant.preparation.cancel_after_served');
    }
  });

  it('refuses any other event on a terminal item', () => {
    expect(() => nextPreparationState('served', 'serve')).toThrowError(expect.objectContaining({ code: 'restaurant.preparation.terminal_state' }));
    expect(() => nextPreparationState('cancelled', 'start')).toThrowError(expect.objectContaining({ code: 'restaurant.preparation.terminal_state' }));
  });

  it('refuses skipping a step — a queued item is not finished', () => {
    expect(() => nextPreparationState('queued', 'finish')).toThrowError(expect.objectContaining({ code: 'restaurant.preparation.transition_not_allowed' }));
    expect(() => nextPreparationState('queued', 'serve')).toThrowError(expect.objectContaining({ code: 'restaurant.preparation.transition_not_allowed' }));
  });

  it('exhausts the whole state x event matrix with a named outcome for every pair', () => {
    const events: readonly PreparationEvent[] = ['start', 'finish', 'serve', 'cancel'];
    let allowed = 0;
    let refused = 0;
    for (const state of PREPARATION_STATES as readonly PreparationState[]) {
      for (const event of events) {
        try {
          expect(PREPARATION_STATES).toContain(nextPreparationState(state, event));
          allowed += 1;
        } catch (error) {
          expect((error as { code?: string }).code).toMatch(/^restaurant\.preparation\./);
          refused += 1;
        }
      }
    }
    expect(allowed + refused).toBe(PREPARATION_STATES.length * events.length);
    // queued:start, queued:cancel, preparing:finish, preparing:cancel, ready:serve, ready:cancel
    expect(allowed).toBe(6);
    expect(refused).toBe(14);
    expect(isTerminalPreparationState('served')).toBe(true);
    expect(isTerminalPreparationState('queued')).toBe(false);
  });
});

describe('LAW 3 — the waste boundary is the moment a cook takes the ingredients', () => {
  it('owes nothing for a queued item: nothing was taken', () => {
    expect(cancellationWastesStock('queued')).toBe(false);
  });

  it('owes a waste movement once preparation began, and still owes it when the dish is ready', () => {
    expect(cancellationWastesStock('preparing')).toBe(true);
    expect(cancellationWastesStock('ready')).toBe(true);
  });

  it('owes nothing for served or already-cancelled: those are not this question', () => {
    expect(cancellationWastesStock('served')).toBe(false);
    expect(cancellationWastesStock('cancelled')).toBe(false);
  });

  it('decides every declared state — a new state cannot slip through undecided', () => {
    let decided = 0;
    for (const state of PREPARATION_STATES as readonly PreparationState[]) {
      expect(typeof cancellationWastesStock(state)).toBe('boolean');
      decided += 1;
    }
    expect(decided).toBe(PREPARATION_STATES.length);
    expect(decided).toBe(5);
  });
});
