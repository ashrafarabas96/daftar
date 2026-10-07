/**
 * The order state machine, proved as a MATRIX.
 *
 * The expected answer for all 49 (state, transition) cells is written out
 * LITERALLY below. It is not computed from `ORDER_EDGES`, because a table
 * derived from the implementation's own table compares the algorithm to itself
 * and passes however wrong both are. Writing the cells by hand is the whole
 * point: a future edit to the machine must be matched by an edit here, and a
 * reviewer reading this file can see the machine without reading the machine.
 */
import { describe, expect, it } from 'vitest';
import {
  ORDER_EDGES,
  OrderError,
  applyOrderTransition,
  foldOrderHistory,
  isTerminalOrderState,
  placeOrder,
  type OrderState,
  type OrderTransition,
  type OrderTransitionKind,
} from '../src';

const ID = {
  place: '11111111-1111-4111-8111-111111111111',
  accept: '22222222-2222-4222-8222-222222222222',
  start: '33333333-3333-4333-8333-333333333333',
  sale: '44444444-4444-4444-8444-444444444444',
  complete: '55555555-5555-4555-8555-555555555555',
  probe: '99999999-9999-4999-8999-999999999999',
  saleDoc: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  otherSaleDoc: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  reject: '66666666-6666-4666-8666-666666666666',
  cancel: '77777777-7777-4777-8777-777777777777',
} as const;

function t(transitionId: string, kind: OrderTransitionKind, occurredAt: string, saleId: string | null = null): OrderTransition {
  return { transitionId, kind, occurredAt, saleId };
}

const HISTORIES: Readonly<Record<OrderState, readonly OrderTransition[]>> = {
  placed: [t(ID.place, 'place', '2026-10-01T09:00:00Z')],
  accepted: [t(ID.place, 'place', '2026-10-01T09:00:00Z'), t(ID.accept, 'accept', '2026-10-01T09:05:00Z')],
  rejected: [t(ID.place, 'place', '2026-10-01T09:00:00Z'), t(ID.reject, 'reject', '2026-10-01T09:05:00Z')],
  cancelled: [t(ID.place, 'place', '2026-10-01T09:00:00Z'), t(ID.cancel, 'cancel', '2026-10-01T09:05:00Z')],
  fulfilling: [
    t(ID.place, 'place', '2026-10-01T09:00:00Z'),
    t(ID.accept, 'accept', '2026-10-01T09:05:00Z'),
    t(ID.start, 'start_fulfilment', '2026-10-01T09:10:00Z'),
  ],
  fulfilled: [
    t(ID.place, 'place', '2026-10-01T09:00:00Z'),
    t(ID.accept, 'accept', '2026-10-01T09:05:00Z'),
    t(ID.start, 'start_fulfilment', '2026-10-01T09:10:00Z'),
    t(ID.sale, 'record_sale', '2026-10-01T09:15:00Z', ID.saleDoc),
  ],
  completed: [
    t(ID.place, 'place', '2026-10-01T09:00:00Z'),
    t(ID.accept, 'accept', '2026-10-01T09:05:00Z'),
    t(ID.start, 'start_fulfilment', '2026-10-01T09:10:00Z'),
    t(ID.sale, 'record_sale', '2026-10-01T09:15:00Z', ID.saleDoc),
    t(ID.complete, 'complete', '2026-10-01T09:20:00Z'),
  ],
};

/** `ok:<state>` for an admitted edge; otherwise the exact refusal code. */
type Cell = string;

const NA = 'order.transition_not_allowed';
const TERM = 'order.terminal_state';
const AFTER_SALE = 'order.cancel_after_sale';
/**
 * `place` is refused from EVERY state, terminal ones included, and the code is
 * `order.history_invalid` rather than `order.transition_not_allowed`: a second
 * `place` is not a bad edge, it is a history that cannot exist, and the fold
 * says so before the walk is attempted. The matrix was written expecting the
 * generic code and the implementation disagreed on all seven cells; the
 * implementation is right, so the table records the real reason.
 */
const NO_SECOND_PLACE = 'order.history_invalid';

const EXPECTED: Readonly<Record<OrderState, Readonly<Record<OrderTransitionKind, Cell>>>> = {
  placed: { place: NO_SECOND_PLACE, accept: 'ok:accepted', reject: 'ok:rejected', cancel: 'ok:cancelled', start_fulfilment: NA, record_sale: NA, complete: NA },
  accepted: { place: NO_SECOND_PLACE, accept: NA, reject: NA, cancel: 'ok:cancelled', start_fulfilment: 'ok:fulfilling', record_sale: NA, complete: NA },
  fulfilling: { place: NO_SECOND_PLACE, accept: NA, reject: NA, cancel: 'ok:cancelled', start_fulfilment: NA, record_sale: 'ok:fulfilled', complete: NA },
  fulfilled: { place: NO_SECOND_PLACE, accept: NA, reject: NA, cancel: AFTER_SALE, start_fulfilment: NA, record_sale: NA, complete: 'ok:completed' },
  rejected: { place: NO_SECOND_PLACE, accept: TERM, reject: TERM, cancel: TERM, start_fulfilment: TERM, record_sale: TERM, complete: TERM },
  cancelled: { place: NO_SECOND_PLACE, accept: TERM, reject: TERM, cancel: TERM, start_fulfilment: TERM, record_sale: TERM, complete: TERM },
  completed: { place: NO_SECOND_PLACE, accept: TERM, reject: TERM, cancel: AFTER_SALE, start_fulfilment: TERM, record_sale: TERM, complete: TERM },
};

const STATES = Object.keys(EXPECTED) as OrderState[];
const KINDS = Object.keys(ORDER_EDGES) as OrderTransitionKind[];

describe('the order transition matrix', () => {
  it('has a subject: 7 states, 7 kinds, 49 cells, and every history reaches the state it is filed under', () => {
    expect(STATES).toHaveLength(7);
    expect(KINDS).toHaveLength(7);
    expect(STATES.flatMap((s) => KINDS.map((k) => `${s}/${k}`))).toHaveLength(49);
    for (const state of STATES) {
      expect(foldOrderHistory(HISTORIES[state]).state).toBe(state);
    }
  });

  for (const state of STATES) {
    for (const kind of KINDS) {
      const expected = EXPECTED[state][kind];
      it(`${state} + ${kind} → ${expected}`, () => {
        const history = HISTORIES[state];
        const saleId = kind === 'record_sale' ? ID.otherSaleDoc : null;
        const probe = t(ID.probe, kind, '2026-10-02T09:00:00Z', saleId);
        if (expected.startsWith('ok:')) {
          const result = applyOrderTransition(history, probe);
          expect(result.snapshot.state).toBe(expected.slice(3));
          expect(result.replayed).toBe(false);
          expect(result.history).toHaveLength(history.length + 1);
        } else {
          try {
            applyOrderTransition(history, probe);
            throw new Error(`expected ${expected}, but the transition was accepted`);
          } catch (error) {
            expect(error).toBeInstanceOf(OrderError);
            expect((error as OrderError).code).toBe(expected);
          }
        }
      });
    }
  }
});

describe('the terminal set', () => {
  it('is exactly rejected, cancelled and completed', () => {
    const terminal = STATES.filter((s) => isTerminalOrderState(s)).sort();
    expect(terminal).toEqual(['cancelled', 'completed', 'rejected']);
  });
});

describe('the sale binding (law 2)', () => {
  it('refuses record_sale with no saleId', () => {
    expect(() => applyOrderTransition(HISTORIES.fulfilling, t(ID.probe, 'record_sale', '2026-10-02T09:00:00Z', null))).toThrowError(
      expect.objectContaining({ code: 'order.sale_binding_invalid' }),
    );
  });

  it('refuses a saleId on any other transition', () => {
    for (const kind of KINDS.filter((k) => k !== 'record_sale')) {
      expect(() => applyOrderTransition(HISTORIES.placed, t(ID.probe, kind, '2026-10-02T09:00:00Z', ID.saleDoc))).toThrowError(
        expect.objectContaining({ code: 'order.sale_binding_invalid' }),
      );
    }
  });

  it('carries the bound sale into every later state', () => {
    expect(foldOrderHistory(HISTORIES.fulfilled).saleId).toBe(ID.saleDoc);
    expect(foldOrderHistory(HISTORIES.completed).saleId).toBe(ID.saleDoc);
  });

  it('is absent before the sale', () => {
    for (const state of ['placed', 'accepted', 'rejected', 'cancelled', 'fulfilling'] as OrderState[]) {
      expect(foldOrderHistory(HISTORIES[state]).saleId).toBeNull();
    }
  });
});

describe('idempotency', () => {
  it('replays an identical transition without changing the history', () => {
    const recorded = HISTORIES.accepted[1] as OrderTransition;
    const result = applyOrderTransition(HISTORIES.accepted, { ...recorded });
    expect(result.replayed).toBe(true);
    expect(result.history).toHaveLength(HISTORIES.accepted.length);
    expect(result.snapshot.state).toBe('accepted');
  });

  it('replays a NON-last transition too — the proof is the log, not the tip', () => {
    const first = HISTORIES.completed[0] as OrderTransition;
    const result = applyOrderTransition(HISTORIES.completed, { ...first });
    expect(result.replayed).toBe(true);
    expect(result.snapshot.state).toBe('completed');
  });

  it('refuses the same transitionId with different content', () => {
    const recorded = HISTORIES.accepted[1] as OrderTransition;
    expect(() => applyOrderTransition(HISTORIES.accepted, { ...recorded, occurredAt: '2026-10-01T09:06:00Z' })).toThrowError(
      expect.objectContaining({ code: 'order.transition_conflict' }),
    );
  });

  it('refuses a history that repeats a transitionId', () => {
    const first = HISTORIES.accepted[0] as OrderTransition;
    const second = HISTORIES.accepted[1] as OrderTransition;
    expect(() => foldOrderHistory([first, { ...second, transitionId: first.transitionId }])).toThrowError(
      expect.objectContaining({ code: 'order.transition_duplicate' }),
    );
  });
});

describe('time (law 4)', () => {
  it('refuses a transition that moves occurredAt backwards', () => {
    expect(() => applyOrderTransition(HISTORIES.accepted, t(ID.probe, 'start_fulfilment', '2026-10-01T09:04:59Z'))).toThrowError(
      expect.objectContaining({ code: 'order.occurred_at_regressed' }),
    );
  });

  it('admits an equal instant — two transitions may share a second', () => {
    expect(applyOrderTransition(HISTORIES.accepted, t(ID.probe, 'start_fulfilment', '2026-10-01T09:05:00Z')).snapshot.state).toBe('fulfilling');
  });

  it.each(['2026-13-01T09:00:00Z', '2026-02-30T09:00:00Z', '2026-10-01T24:00:00Z', '2026-10-01T09:00:60Z', '2026-10-01 09:00:00Z', '2026-10-01T09:00:00'])(
    'refuses the impossible or non-canonical instant %s',
    (bad) => {
      expect(() => placeOrder(t(ID.place, 'place', bad))).toThrowError(expect.objectContaining({ code: 'order.occurred_at_invalid' }));
    },
  );
});

describe('the history itself', () => {
  it('must begin with place', () => {
    expect(() => foldOrderHistory([t(ID.accept, 'accept', '2026-10-01T09:00:00Z')])).toThrowError(expect.objectContaining({ code: 'order.history_invalid' }));
    expect(() => foldOrderHistory([])).toThrowError(expect.objectContaining({ code: 'order.history_invalid' }));
  });

  it('carries exactly one place', () => {
    expect(() => foldOrderHistory([HISTORIES.placed[0] as OrderTransition, t(ID.probe, 'place', '2026-10-02T09:00:00Z')])).toThrowError(
      expect.objectContaining({ code: 'order.history_invalid' }),
    );
  });

  it('refuses an identifier that is not a canonical lowercase UUID', () => {
    expect(() => placeOrder(t('11111111-1111-4111-8111-11111111111', 'place', '2026-10-01T09:00:00Z'))).toThrowError(
      expect.objectContaining({ code: 'order.id_invalid' }),
    );
    expect(() => placeOrder(t(ID.saleDoc.toUpperCase(), 'place', '2026-10-01T09:00:00Z'))).toThrowError(expect.objectContaining({ code: 'order.id_invalid' }));
  });
});
