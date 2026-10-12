import { describe, expect, it } from 'vitest';
import {
  CONSUMPTION_OCCASIONS,
  ConsumptionLedger,
  ConsumptionRefusal,
  FORBIDDEN_VALUATION_KEYS,
  INVENTORY_AUTHORITY,
  assertNoLocalValuation,
  assertRefundRestocksNothing,
  occasionOwedBy,
  type ConsumptionRecord,
  type LineOutcome,
  type OrderLineFate,
} from '../src/consumption-occasion';
import { PREPARATION_STATES, type PreparationState } from '../src/preparation-state';
import { STOCK_EFFECT_MODES, type StockEffectMode } from '../src/stock-effect';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConsumptionRefusal) return error.code;
    throw error;
  }
  throw new Error('expected a ConsumptionRefusal, none was thrown');
}

function detailsOf(fn: () => unknown): Record<string, unknown> {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConsumptionRefusal) return error.details ?? {};
    throw error;
  }
  throw new Error('expected a ConsumptionRefusal, none was thrown');
}

const COMPOSED_SOLD: OrderLineFate = { orderLineId: 'ol-1', mode: 'composed', outcome: 'sold', stateAtCancellation: null };
const COMPOSED_WASTED: OrderLineFate = { orderLineId: 'ol-2', mode: 'composed', outcome: 'cancelled', stateAtCancellation: 'preparing' };
const COMPOSED_QUEUED_CANCEL: OrderLineFate = { orderLineId: 'ol-3', mode: 'composed', outcome: 'cancelled', stateAtCancellation: 'queued' };
const SERVICE_SOLD: OrderLineFate = { orderLineId: 'ol-4', mode: 'service', outcome: 'sold', stateAtCancellation: null };
const DIRECT_SOLD: OrderLineFate = { orderLineId: 'ol-5', mode: 'direct', outcome: 'sold', stateAtCancellation: null };

function sale(orderLineId: string, commandId: string): ConsumptionRecord {
  return { orderLineId, occasion: 'sale_commit', commandId, authority: INVENTORY_AUTHORITY, movementCount: 3 };
}

function waste(orderLineId: string, commandId: string): ConsumptionRecord {
  return { orderLineId, occasion: 'cancellation_waste', commandId, authority: INVENTORY_AUTHORITY, movementCount: 3 };
}

describe('PART 7.7 — which occasion owes a line its movements', () => {
  it('names sale commit for a sold line and waste for one cancelled after the cook started', () => {
    expect(occasionOwedBy(COMPOSED_SOLD)).toBe('sale_commit');
    expect(occasionOwedBy(COMPOSED_WASTED)).toBe('cancellation_waste');
  });

  it('owes nothing for a service, a queued cancellation, or a line voided before placement', () => {
    expect(occasionOwedBy(SERVICE_SOLD)).toBeNull();
    expect(occasionOwedBy(COMPOSED_QUEUED_CANCEL)).toBeNull();
    expect(occasionOwedBy({ orderLineId: 'ol-6', mode: 'composed', outcome: 'voided_before_placement', stateAtCancellation: null })).toBeNull();
  });

  it("agrees with the kitchen's own waste boundary on every preparation state", () => {
    // The two rules must not drift: this restates `cancellationWastesStock`'s
    // answer, through the occasion, for the whole state set rather than the two
    // states a hand-written pair of cases would have covered.
    const owed = new Map<PreparationState, string>();
    for (const state of PREPARATION_STATES) {
      owed.set(state, String(occasionOwedBy({ orderLineId: 'ol-x', mode: 'composed', outcome: 'cancelled', stateAtCancellation: state })));
    }
    expect(Object.fromEntries(owed)).toEqual({
      queued: 'null',
      preparing: 'cancellation_waste',
      ready: 'cancellation_waste',
      served: 'null',
      cancelled: 'null',
    });
  });

  it('refuses a cancellation that does not say which state it was cancelled in', () => {
    expect(codeOf(() => occasionOwedBy({ orderLineId: 'ol-7', mode: 'composed', outcome: 'cancelled', stateAtCancellation: null }))).toBe(
      'restaurant.consumption.cancellation_state_absent',
    );
  });

  it('owes nothing for a service whatever became of it', () => {
    const outcomes: readonly LineOutcome[] = ['sold', 'cancelled', 'voided_before_placement'];
    for (const outcome of outcomes) {
      expect(occasionOwedBy({ orderLineId: 'ol-s', mode: 'service', outcome, stateAtCancellation: 'preparing' })).toBeNull();
    }
  });

  it('registers exactly the two occasions', () => {
    expect([...CONSUMPTION_OCCASIONS]).toEqual(['sale_commit', 'cancellation_waste']);
  });
});

describe('PART 7.7 — exactly once', () => {
  it('records the first consumption and refuses a second command for the same line', () => {
    const ledger = new ConsumptionLedger();
    expect(ledger.record(COMPOSED_SOLD, sale('ol-1', 'cmd-a'))).toBe('recorded');
    expect(codeOf(() => ledger.record(COMPOSED_SOLD, sale('ol-1', 'cmd-b')))).toBe('restaurant.consumption.occasion_repeated');
    expect(ledger.size).toBe(1);
  });

  it('refuses the waste-then-sell pair that would take one dish out of stock twice', () => {
    // The defect this module exists for. Both records are individually
    // well-formed; only their relation is wrong.
    const ledger = new ConsumptionLedger();
    const line = 'ol-2';
    expect(ledger.record(COMPOSED_WASTED, waste(line, 'cmd-cancel'))).toBe('recorded');
    const soldLater: OrderLineFate = { orderLineId: line, mode: 'composed', outcome: 'sold', stateAtCancellation: null };
    const details = detailsOf(() => ledger.record(soldLater, sale(line, 'cmd-sale')));
    expect(details.recordedOccasion).toBe('cancellation_waste');
    expect(details.attemptedOccasion).toBe('sale_commit');
  });

  it('accepts the same command arriving twice as one consumption', () => {
    const ledger = new ConsumptionLedger();
    expect(ledger.record(COMPOSED_SOLD, sale('ol-1', 'cmd-a'))).toBe('recorded');
    expect(ledger.record(COMPOSED_SOLD, sale('ol-1', 'cmd-a'))).toBe('replay');
    expect(ledger.record(COMPOSED_SOLD, sale('ol-1', 'cmd-a'))).toBe('replay');
    expect(ledger.size).toBe(1);
  });

  it('keeps lines independent: one line consuming says nothing about another', () => {
    const ledger = new ConsumptionLedger();
    ledger.record(COMPOSED_SOLD, sale('ol-1', 'cmd-a'));
    expect(ledger.hasConsumed('ol-1')).toBe(true);
    expect(ledger.hasConsumed('ol-2')).toBe(false);
    expect(ledger.occasionOf('ol-2')).toBeNull();
    ledger.record(COMPOSED_WASTED, waste('ol-2', 'cmd-c'));
    expect(ledger.occasionOf('ol-1')).toBe('sale_commit');
    expect(ledger.occasionOf('ol-2')).toBe('cancellation_waste');
  });

  it('refuses a movement on an occasion the line does not owe', () => {
    const ledger = new ConsumptionLedger();
    expect(codeOf(() => ledger.record(SERVICE_SOLD, sale('ol-4', 'cmd-a')))).toBe('restaurant.consumption.occasion_not_owed');
    expect(codeOf(() => ledger.record(COMPOSED_QUEUED_CANCEL, waste('ol-3', 'cmd-a')))).toBe('restaurant.consumption.occasion_not_owed');
    expect(ledger.size).toBe(0);
  });

  it('refuses a sold line that tries to take its stock as waste, and the reverse', () => {
    const ledger = new ConsumptionLedger();
    expect(codeOf(() => ledger.record(COMPOSED_SOLD, waste('ol-1', 'cmd-a')))).toBe('restaurant.consumption.occasion_mismatch');
    expect(codeOf(() => ledger.record(COMPOSED_WASTED, sale('ol-2', 'cmd-a')))).toBe('restaurant.consumption.occasion_mismatch');
    expect(ledger.size).toBe(0);
  });

  it('holds for a direct line too, which has no kitchen but still consumes once', () => {
    const ledger = new ConsumptionLedger();
    expect(ledger.record(DIRECT_SOLD, sale('ol-5', 'cmd-a'))).toBe('recorded');
    expect(codeOf(() => ledger.record(DIRECT_SOLD, sale('ol-5', 'cmd-b')))).toBe('restaurant.consumption.occasion_repeated');
  });

  it('refuses a second command on every mode and outcome that owes an occasion', () => {
    const modes: readonly StockEffectMode[] = STOCK_EFFECT_MODES;
    let owing = 0;
    for (const mode of modes) {
      for (const state of PREPARATION_STATES) {
        for (const outcome of ['sold', 'cancelled', 'voided_before_placement'] as const) {
          const fate: OrderLineFate = { orderLineId: `${mode}-${state}-${outcome}`, mode, outcome, stateAtCancellation: state };
          const owed = occasionOwedBy(fate);
          if (owed === null) continue;
          owing += 1;
          const ledger = new ConsumptionLedger();
          const first: ConsumptionRecord = {
            orderLineId: fate.orderLineId,
            occasion: owed,
            commandId: 'cmd-1',
            authority: INVENTORY_AUTHORITY,
            movementCount: 1,
          };
          expect(ledger.record(fate, first)).toBe('recorded');
          expect(codeOf(() => ledger.record(fate, { ...first, commandId: 'cmd-2' }))).toBe('restaurant.consumption.occasion_repeated');
        }
      }
    }
    // A bounded sweep, not a proof: it states how many of this grid's fates owe
    // an occasion so a rule change that silently widens or narrows it is seen.
    // 14 = two consuming modes x (5 sold states + 2 wasting cancellations);
    // the service mode and every voided line owe nothing.
    expect(owing).toBe(14);
  });
});

describe('PART 8 — one writer, and no second valuation', () => {
  it('refuses a movement made by anyone but the inventory authority', () => {
    const ledger = new ConsumptionLedger();
    const foreign: ConsumptionRecord = { ...sale('ol-1', 'cmd-a'), authority: 'restaurant.kitchen_writer' };
    expect(codeOf(() => ledger.record(COMPOSED_SOLD, foreign))).toBe('restaurant.consumption.authority_not_canonical');
  });

  it("does not let a foreign writer's record occupy the line's one slot", () => {
    // Were the rejected record entered, the authority's own correct movement
    // would afterwards look like the duplicate.
    const ledger = new ConsumptionLedger();
    expect(codeOf(() => ledger.record(COMPOSED_SOLD, { ...sale('ol-1', 'cmd-a'), authority: 'restaurant.kitchen_writer' }))).toBe(
      'restaurant.consumption.authority_not_canonical',
    );
    expect(ledger.hasConsumed('ol-1')).toBe(false);
    expect(ledger.record(COMPOSED_SOLD, sale('ol-1', 'cmd-b'))).toBe('recorded');
  });

  it('refuses every valuation field the pack must not carry', () => {
    for (const forbidden of FORBIDDEN_VALUATION_KEYS) {
      const record = { ...sale('ol-1', 'cmd-a'), [forbidden]: 1234n } as unknown as ConsumptionRecord;
      expect(codeOf(() => assertNoLocalValuation(record))).toBe('restaurant.consumption.valuation_present');
      expect(detailsOf(() => assertNoLocalValuation(record)).carriedKeys).toEqual([forbidden]);
    }
  });

  it('refuses a valued record before it is entered, not after', () => {
    const ledger = new ConsumptionLedger();
    const valued = { ...sale('ol-1', 'cmd-a'), cogsMinor: 900n } as unknown as ConsumptionRecord;
    expect(codeOf(() => ledger.record(COMPOSED_SOLD, valued))).toBe('restaurant.consumption.valuation_present');
    expect(ledger.hasConsumed('ol-1')).toBe(false);
  });

  it('passes a record that states a quantity count and no value', () => {
    expect(() => assertNoLocalValuation(sale('ol-1', 'cmd-a'))).not.toThrow();
  });
});

describe('PART 7.7 — a refund puts no cooked food back', () => {
  it('refuses a return movement for a composed line', () => {
    expect(codeOf(() => assertRefundRestocksNothing(COMPOSED_SOLD, 1))).toBe('restaurant.consumption.refund_restocks_composed');
    expect(codeOf(() => assertRefundRestocksNothing(COMPOSED_SOLD, 7))).toBe('restaurant.consumption.refund_restocks_composed');
  });

  it('allows a composed refund that asks for none, which is the money-only case', () => {
    expect(() => assertRefundRestocksNothing(COMPOSED_SOLD, 0)).not.toThrow();
  });

  it('says nothing about a direct line, whose return is the returns authority’s rule', () => {
    expect(() => assertRefundRestocksNothing(DIRECT_SOLD, 1)).not.toThrow();
    expect(() => assertRefundRestocksNothing(SERVICE_SOLD, 1)).not.toThrow();
  });
});
