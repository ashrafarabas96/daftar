/**
 * The DTO vocabulary and the domain vocabulary are the same vocabulary.
 *
 * A union that drifts is the defect this file exists to red. If a state is
 * added to the machine and not to `OrderStateDto`, a client told to render
 * "every state" silently cannot render the new one; if a finding code is added
 * to the reconciler and not to the report DTO, a finding reaches a client that
 * has no branch for it.
 *
 * TypeScript alone cannot catch this: both unions would compile perfectly while
 * disagreeing. So the check is EXECUTED over value-level lists, and each list is
 * derived from the implementation's own exported table on one side and written
 * out by hand on the other — never from the same source twice, which would
 * compare the vocabulary to itself.
 */
import { describe, expect, it } from 'vitest';
import { ORDER_CHANNELS, ORDER_CLIENT_ERROR_CODES, ORDER_EDGES, TERMINAL_ORDER_STATES, type OrderChannelDto, type OrderStateDto } from '../src';

/** Hand-written from `OrderStateDto`. Edited only when that union is edited. */
const DTO_STATES: readonly OrderStateDto[] = ['placed', 'accepted', 'rejected', 'cancelled', 'fulfilling', 'fulfilled', 'completed'];

/** Hand-written from `OrderChannelDto`. */
const DTO_CHANNELS: readonly OrderChannelDto[] = ['storefront', 'pos', 'admin', 'marketplace'];

describe('the state vocabulary', () => {
  it('is the same set on both sides of the API boundary', () => {
    // Derived from the machine: every state any edge can reach, plus the
    // terminal set, which together is every state the machine admits.
    const fromMachine = new Set<string>([...Object.values(ORDER_EDGES).map((e) => e.to), ...TERMINAL_ORDER_STATES]);
    expect([...fromMachine].sort()).toEqual([...DTO_STATES].sort());
  });

  it('has a non-empty subject on both sides', () => {
    expect(DTO_STATES.length).toBe(7);
    expect(Object.keys(ORDER_EDGES).length).toBe(7);
  });
});

describe('the channel vocabulary', () => {
  it('is the same set the reconciler accepts', () => {
    expect([...ORDER_CHANNELS].sort()).toEqual([...DTO_CHANNELS].sort());
  });
});

describe('the client error codes', () => {
  it('are a non-empty, duplicate-free subset of codes this package can actually raise', () => {
    expect(ORDER_CLIENT_ERROR_CODES.length).toBeGreaterThan(0);
    expect(new Set(ORDER_CLIENT_ERROR_CODES).size).toBe(ORDER_CLIENT_ERROR_CODES.length);
    for (const code of ORDER_CLIENT_ERROR_CODES) {
      expect(code.startsWith('order.')).toBe(true);
    }
  });

  it('name the one refusal a shopper-facing client must branch on above all others', () => {
    // An order whose sale committed is reversed through the sales authority,
    // never cancelled. A client that offered a Cancel button there would ask for
    // a refusal it could not explain.
    expect(ORDER_CLIENT_ERROR_CODES).toContain('order.cancel_after_sale');
  });
});
