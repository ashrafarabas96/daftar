/**
 * The settlement-truth gate — section 25's CRITICAL P6 CORRECTION, `TL-P6-R2`,
 * `TL-P6-R3`, `TL-P6-R4` and section 31.
 *
 * The defect being guarded against is the most ordinary click in ecommerce: a
 * shopper presses Place Order, and the system records cash the business never
 * received. So the suite proves BOTH directions of every mapping — that true
 * evidence works, and that no path exists from an unpaid order to a committed
 * `cash` sale.
 *
 * The enumeration is proved exhaustive: every declared evidence kind is
 * exercised, and the mapping table is proved to cover exactly the declared set,
 * so a future author who adds a kind and forgets the mapping reds here.
 */
import { describe, expect, it } from 'vitest';
import {
  ORDER_REACHABLE_EVIDENCE_KINDS,
  ORDER_SETTLEMENT_EVIDENCE_KINDS,
  OrderError,
  SETTLEMENT_MODE_BY_EVIDENCE,
  requireSettlementTruth,
  type OrderSettlementEvidence,
} from '../src';

const STAFF = '77777777-7777-4777-8777-777777777777';
const MANAGER = '88888888-8888-4888-8888-888888888888';
const CUSTOMER = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const CASH_COLLECTED: OrderSettlementEvidence = { kind: 'cash_collected_on_handover', collectedByUserId: STAFF };
const CREDIT_AUTHORIZED: OrderSettlementEvidence = { kind: 'authorized_customer_credit', authorizedByUserId: MANAGER };
const PAYMENT_VERIFIED: OrderSettlementEvidence = { kind: 'payment_verified', providerRef: 'provider-ref-1' };

describe('the evidence enumeration', () => {
  it('has a non-empty, duplicate-free subject set, and the mapping covers exactly it', () => {
    expect(ORDER_SETTLEMENT_EVIDENCE_KINDS).toHaveLength(3);
    expect(new Set(ORDER_SETTLEMENT_EVIDENCE_KINDS).size).toBe(3);
    expect(Object.keys(SETTLEMENT_MODE_BY_EVIDENCE).sort()).toEqual([...ORDER_SETTLEMENT_EVIDENCE_KINDS].sort());
  });

  it('declares no kind that means "pending", "unpaid" or "assume paid" — the absence IS the law', () => {
    for (const kind of ORDER_SETTLEMENT_EVIDENCE_KINDS) {
      expect(kind).not.toMatch(/pend|unpaid|await|assume|later|cod$|on_delivery$|authoriz(ed)?_payment/i);
    }
  });

  it('marks the online-payment kind as unreachable while no merchant provider is integrated', () => {
    expect(ORDER_REACHABLE_EVIDENCE_KINDS).not.toContain('payment_verified');
    expect(ORDER_REACHABLE_EVIDENCE_KINDS).toHaveLength(2);
    for (const kind of ORDER_REACHABLE_EVIDENCE_KINDS) {
      expect(ORDER_SETTLEMENT_EVIDENCE_KINDS).toContain(kind);
    }
  });
});

describe('collected cash', () => {
  it('establishes a cash sale for a walk-in, naming who collected it', () => {
    const established = requireSettlementTruth('cash', CASH_COLLECTED, null);
    expect(established).toEqual({ mode: 'cash', evidenceKind: 'cash_collected_on_handover', establishedByUserId: STAFF, customerId: null });
  });

  it('establishes a cash sale for a named customer too — both are true facts', () => {
    expect(requireSettlementTruth('cash', CASH_COLLECTED, CUSTOMER).customerId).toBe(CUSTOMER);
  });

  it('cannot establish credit', () => {
    expect(() => requireSettlementTruth('credit', CASH_COLLECTED, CUSTOMER)).toThrowError(
      expect.objectContaining({ code: 'order.settlement_mode_unsupported' }),
    );
  });

  it('refuses a collector who is not a canonical user id', () => {
    expect(() => requireSettlementTruth('cash', { kind: 'cash_collected_on_handover', collectedByUserId: 'staff-1' }, null)).toThrowError(
      expect.objectContaining({ code: 'order.id_invalid' }),
    );
  });
});

describe('authorized customer credit (TL-P6-R3, TL-P6-R4)', () => {
  it('establishes credit for a named customer, naming who authorized it', () => {
    expect(requireSettlementTruth('credit', CREDIT_AUTHORIZED, CUSTOMER)).toEqual({
      mode: 'credit',
      evidenceKind: 'authorized_customer_credit',
      establishedByUserId: MANAGER,
      customerId: CUSTOMER,
    });
  });

  it('refuses an anonymous receivable, and does NOT suggest inventing a customer', () => {
    try {
      requireSettlementTruth('credit', CREDIT_AUTHORIZED, null);
      throw new Error('an anonymous receivable was established');
    } catch (error) {
      expect(error).toBeInstanceOf(OrderError);
      expect((error as OrderError).code).toBe('order.checkout_customer_required');
    }
  });

  it('cannot establish cash', () => {
    expect(() => requireSettlementTruth('cash', CREDIT_AUTHORIZED, CUSTOMER)).toThrowError(
      expect.objectContaining({ code: 'order.settlement_mode_unsupported' }),
    );
  });

  it('refuses an authorizer who is not a canonical user id', () => {
    expect(() => requireSettlementTruth('credit', { kind: 'authorized_customer_credit', authorizedByUserId: 'manager' }, CUSTOMER)).toThrowError(
      expect.objectContaining({ code: 'order.id_invalid' }),
    );
  });
});

describe('the unintegrated payment surface (section 31)', () => {
  it('refuses a verified online payment under EITHER claimed mode, and never substitutes cash', () => {
    for (const claimed of ['cash', 'credit'] as const) {
      try {
        requireSettlementTruth(claimed, PAYMENT_VERIFIED, CUSTOMER);
        throw new Error(`a ${claimed} sale was established from an unintegrated payment surface`);
      } catch (error) {
        expect(error).toBeInstanceOf(OrderError);
        expect((error as OrderError).code).toBe('order.payment_surface_not_integrated');
      }
    }
  });

  it('is refused even though the mapping table says it would support cash — the surface check wins', () => {
    // The table entry is real: when the adapter arrives, this kind supports a
    // cash settlement. The refusal is about the adapter not existing yet, which
    // is why the check sits ahead of the mode comparison rather than inside it.
    expect(SETTLEMENT_MODE_BY_EVIDENCE['payment_verified']).toBe('cash');
    expect(() => requireSettlementTruth('cash', PAYMENT_VERIFIED, null)).toThrowError(
      expect.objectContaining({ code: 'order.payment_surface_not_integrated' }),
    );
  });
});

describe('an unrecognised evidence kind', () => {
  it('is refused rather than treated as the nearest known one', () => {
    const forged = { kind: 'cash_on_delivery_pending', collectedByUserId: STAFF } as unknown as OrderSettlementEvidence;
    expect(() => requireSettlementTruth('cash', forged, null)).toThrowError(expect.objectContaining({ code: 'order.settlement_not_established' }));
  });
});

describe('the whole mapping, enumerated — no unpaid path reaches a committed sale', () => {
  const EXPECTED: Readonly<Record<string, 'cash' | 'credit'>> = {
    cash_collected_on_handover: 'cash',
    payment_verified: 'cash',
    authorized_customer_credit: 'credit',
  };

  it('is written out by hand and agrees with the implementation table', () => {
    expect(SETTLEMENT_MODE_BY_EVIDENCE).toEqual(EXPECTED);
  });

  it('leaves no evidence kind that establishes a mode without a bearer recorded', () => {
    expect(requireSettlementTruth('cash', CASH_COLLECTED, null).establishedByUserId).toBe(STAFF);
    expect(requireSettlementTruth('credit', CREDIT_AUTHORIZED, CUSTOMER).establishedByUserId).toBe(MANAGER);
  });
});
