/**
 * The settled subscription-invoice lifecycle (round 6 Contract Diff).
 *
 * These cases pin the SETTLED contract: the state set, the one transition
 * that applies credit, the terminal states, and the columns finalization may
 * write. The scratch DDL is pinned to the same constants from
 * `test/db/credit-ledger-contract.test.ts`, by reading the live catalogue —
 * so the two documents cannot drift apart again without something going red.
 */
import { describe, expect, it } from 'vitest';
import { BillingError } from '../src/errors';
import {
  assertInvoiceTransition,
  canTransitionInvoice,
  FINALIZATION_WRITABLE_COLUMNS,
  isSubscriptionInvoiceState,
  SUBSCRIPTION_INVOICE_STATES,
  TERMINAL_INVOICE_STATES,
  type SubscriptionInvoiceState,
} from '../src/invoice-states';

function expectRefusal(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, 'the call was expected to refuse and did not').toBeInstanceOf(BillingError);
  expect((caught as BillingError).code).toBe(code);
}

describe('the state set', () => {
  it('is the five states the settled contract names, in lifecycle order', () => {
    expect([...SUBSCRIPTION_INVOICE_STATES]).toStrictEqual(['draft', 'open', 'paid', 'uncollectible', 'voided']);
  });

  it('does not carry `finalized`', () => {
    // Round 5's DDL called the finalized-and-uncollected state `finalized`;
    // the earlier spec calls it `open`. Two names for one state is how a
    // sign gets lost, so the settled contract keeps one and `finalized`
    // names the TRANSITION instead.
    expect((SUBSCRIPTION_INVOICE_STATES as readonly string[]).includes('finalized')).toBe(false);
  });

  it('narrows, and refuses anything else', () => {
    expect(isSubscriptionInvoiceState('open')).toBe(true);
    for (const value of ['finalized', 'OPEN', '', 'settled', null, undefined, 7]) {
      expect(isSubscriptionInvoiceState(value)).toBe(false);
    }
  });

  it('names every terminal state, and only terminal ones', () => {
    expect([...TERMINAL_INVOICE_STATES]).toStrictEqual(['paid', 'uncollectible', 'voided']);
    for (const state of TERMINAL_INVOICE_STATES) {
      const onwards = SUBSCRIPTION_INVOICE_STATES.filter((to) => canTransitionInvoice(state, to));
      expect(onwards, `${state} is listed as terminal and still moves`).toStrictEqual([]);
    }
  });
});

describe('the transitions', () => {
  const ALL: readonly SubscriptionInvoiceState[] = SUBSCRIPTION_INVOICE_STATES;
  const EXPECTED: ReadonlyArray<readonly [SubscriptionInvoiceState, SubscriptionInvoiceState]> = [
    ['draft', 'open'],
    ['draft', 'voided'],
    ['open', 'paid'],
    ['open', 'uncollectible'],
    ['open', 'voided'],
  ];

  it('are exactly five, and nothing else is reachable', () => {
    // Enumerated over the whole product of states rather than spot-checked:
    // a transition table tested only where it permits proves nothing about
    // where it must refuse.
    const permitted = ALL.flatMap((from) => ALL.filter((to) => canTransitionInvoice(from, to)).map((to) => `${from}->${to}`));
    expect(permitted.sort()).toStrictEqual(EXPECTED.map(([f, t]) => `${f}->${t}`).sort());
  });

  it('never run backwards, and never re-enter the state they are in', () => {
    for (const state of ALL) {
      expect(canTransitionInvoice(state, state), `${state} transitions to itself`).toBe(false);
    }
    expect(canTransitionInvoice('open', 'draft')).toBe(false);
    expect(canTransitionInvoice('paid', 'open')).toBe(false);
  });

  it('refuse at the writing path, with the lifecycle code', () => {
    expect(() => assertInvoiceTransition('draft', 'open')).not.toThrow();
    expectRefusal(() => assertInvoiceTransition('draft', 'paid'), 'billing.invoice_state_transition_invalid');
    expectRefusal(() => assertInvoiceTransition('paid', 'voided'), 'billing.invoice_state_transition_invalid');
    expectRefusal(() => assertInvoiceTransition('finalized' as SubscriptionInvoiceState, 'open'), 'billing.invoice_state_transition_invalid');
  });

  it('skip no step: a draft is never collected without being opened', () => {
    expect(canTransitionInvoice('draft', 'paid')).toBe(false);
    expect(canTransitionInvoice('draft', 'uncollectible')).toBe(false);
  });
});

describe('what finalization may write', () => {
  it('is the state, the credit, the total and the issue instant, and nothing else', () => {
    expect([...FINALIZATION_WRITABLE_COLUMNS]).toStrictEqual(['state', 'credit_minor', 'total_minor', 'issued_at']);
  });

  it('does not include what is fixed at composition', () => {
    for (const column of ['business_id', 'tenant_id', 'period_index', 'period_starts_at', 'period_ends_at', 'currency', 'charge_minor', 'tax_minor']) {
      expect(FINALIZATION_WRITABLE_COLUMNS.includes(column), `${column} must not be writable after composition`).toBe(false);
    }
  });
});
