/**
 * Phase 10 — table session lifecycle. PREPARED / NOT PROMOTED.
 *
 * A table session is the operational container for one party's visit: which
 * table, which waiter, how many guests, which order rounds. It holds NO money
 * (LAW 1). The bill it produces is a sale, owned by the Phase 4 sale authority.
 *
 * Deliberately NOT modelled here: a `closed boolean`. The repository's house
 * rule is an append-only transition record, never a mutable flag — the same rule
 * the Phase 4 reversal work enforces.
 */

export const TABLE_SESSION_STATES = ['open', 'billing', 'closed', 'abandoned'] as const;
export type TableSessionState = (typeof TABLE_SESSION_STATES)[number];

export type TableSessionEvent =
  /** The bill was requested; no new round may be ordered. */
  | 'request_bill'
  /** Guests ordered again after asking for the bill — legitimate and common. */
  | 'reopen_for_ordering'
  /** Every bill of this session is settled. */
  | 'settle'
  /** The party left without ordering anything. */
  | 'abandon';

export type TableSessionRefusalCode =
  | 'restaurant.table_session.transition_not_allowed'
  | 'restaurant.table_session.terminal_state'
  | 'restaurant.table_session.abandon_with_orders'
  | 'restaurant.table_session.settle_with_unsettled_bill';

export class TableSessionRefusal extends Error {
  constructor(
    readonly code: TableSessionRefusalCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'TableSessionRefusal';
  }
}

const TRANSITIONS: Readonly<Record<TableSessionState, Readonly<Partial<Record<TableSessionEvent, TableSessionState>>>>> = Object.freeze({
  open: Object.freeze({ request_bill: 'billing', abandon: 'abandoned' }),
  billing: Object.freeze({ reopen_for_ordering: 'open', settle: 'closed' }),
  closed: Object.freeze({}),
  abandoned: Object.freeze({}),
});

export const TERMINAL_TABLE_SESSION_STATES: readonly TableSessionState[] = Object.freeze(['closed', 'abandoned']);

export function isTerminalTableSessionState(state: TableSessionState): boolean {
  return TERMINAL_TABLE_SESSION_STATES.includes(state);
}

export interface TableSessionFacts {
  /** How many order lines this session has ever placed, voided ones included. */
  readonly placedLineCount: number;
  /** How many bills of this session are not yet fully settled, per the SALE authority. */
  readonly unsettledBillCount: number;
}

/**
 * Compute the next state, or refuse.
 *
 * `facts` are supplied by the caller and come from the authorities that own
 * them — the session's own rounds, and the Phase 4 settlement truth for
 * `unsettledBillCount`. This function never reads settlement itself, so it can
 * never become a second opinion about whether a bill is paid.
 */
export function nextTableSessionState(current: TableSessionState, event: TableSessionEvent, facts: TableSessionFacts): TableSessionState {
  if (isTerminalTableSessionState(current)) {
    throw new TableSessionRefusal('restaurant.table_session.terminal_state', `A ${current} table session accepts no event, including ${event}`, {
      current,
      event,
    });
  }
  const target = TRANSITIONS[current][event];
  if (target === undefined) {
    throw new TableSessionRefusal('restaurant.table_session.transition_not_allowed', `A ${current} table session cannot ${event}`, { current, event });
  }
  if (event === 'abandon' && facts.placedLineCount > 0) {
    throw new TableSessionRefusal(
      'restaurant.table_session.abandon_with_orders',
      `A session with ${facts.placedLineCount} placed line(s) is settled or voided, never abandoned`,
      { placedLineCount: facts.placedLineCount },
    );
  }
  if (event === 'settle' && facts.unsettledBillCount > 0) {
    throw new TableSessionRefusal(
      'restaurant.table_session.settle_with_unsettled_bill',
      `${facts.unsettledBillCount} bill(s) of this session are not settled`,
      { unsettledBillCount: facts.unsettledBillCount },
    );
  }
  return target;
}
