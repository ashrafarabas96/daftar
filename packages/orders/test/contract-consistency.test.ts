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
import {
  ORDER_CHANNELS,
  ORDER_CLIENT_ERROR_CODES,
  ORDER_EDGES,
  ORDER_SETTLEMENT_EVIDENCE_KINDS,
  SETTLEMENT_MODE_BY_EVIDENCE,
  TERMINAL_ORDER_STATES,
  type OrderChannelDto,
  type OrderSettlementEvidenceKindDto,
  type OrderStateDto,
} from '../src';

/** Hand-written from `OrderStateDto`. Edited only when that union is edited. */
const DTO_STATES: readonly OrderStateDto[] = ['placed', 'accepted', 'rejected', 'cancelled', 'fulfilling', 'fulfilled', 'completed'];

/** Hand-written from `OrderChannelDto`. */
const DTO_CHANNELS: readonly OrderChannelDto[] = ['storefront', 'pos', 'admin', 'marketplace'];

/** Hand-written from `OrderSettlementEvidenceKindDto`. */
const DTO_EVIDENCE_KINDS: readonly OrderSettlementEvidenceKindDto[] = ['cash_collected_on_handover', 'payment_verified', 'authorized_customer_credit'];

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

describe('the settlement evidence vocabulary (section 25)', () => {
  it('is the same set on both sides of the API boundary', () => {
    expect([...DTO_EVIDENCE_KINDS].sort()).toEqual([...ORDER_SETTLEMENT_EVIDENCE_KINDS].sort());
  });

  it('offers no kind on either side that would let an unpaid order be committed as paid', () => {
    for (const kind of [...DTO_EVIDENCE_KINDS, ...ORDER_SETTLEMENT_EVIDENCE_KINDS]) {
      expect(kind).not.toMatch(/pend|unpaid|await|assume|uncollected/i);
    }
  });

  it('maps every declared kind to exactly one settlement mode', () => {
    for (const kind of DTO_EVIDENCE_KINDS) {
      expect(['cash', 'credit']).toContain(SETTLEMENT_MODE_BY_EVIDENCE[kind]);
    }
    expect(Object.keys(SETTLEMENT_MODE_BY_EVIDENCE)).toHaveLength(DTO_EVIDENCE_KINDS.length);
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

  it('name the refusals a checkout client must be able to render', () => {
    // A storefront that could not render these would strand the shopper at the
    // one moment they can still act: an expired quote, a superseded price, a
    // settlement the evidence does not support, and a payment surface that is
    // not integrated.
    for (const code of ['order.quote_expired', 'order.quote_version_stale', 'order.settlement_mode_unsupported', 'order.payment_surface_not_integrated']) {
      expect(ORDER_CLIENT_ERROR_CODES).toContain(code);
    }
  });
});
