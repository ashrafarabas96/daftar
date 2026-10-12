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
  ORDER_EVIDENCE_KINDS_AWAITING_SEAM,
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

  it('PART 31 — the table states NO mode for it: a card payment must not masquerade as cash', () => {
    // An earlier revision mapped `payment_verified` to `cash`. PART 31 forbids
    // exactly that masquerade where Phase 4 `cash` means literal cash in a till,
    // and the mode a verified card payment settles into is the Sales +
    // Accounting authorities' answer when they define the merchant payment and
    // tender seam — not Phase 6's. So the kind is enumerated and its mode is
    // unanswered.
    expect(SETTLEMENT_MODE_BY_EVIDENCE['payment_verified']).toBeNull();
    expect(() => requireSettlementTruth('cash', PAYMENT_VERIFIED, null)).toThrowError(
      expect.objectContaining({ code: 'order.payment_surface_not_integrated' }),
    );
  });

  it('the awaiting-seam list is exactly the kinds with no mode', () => {
    // This ties the published list to the table, so neither can drift from the
    // other: a kind whose mode is unanswered must be declared as awaiting the
    // seam, and a kind declared as awaiting the seam must have no mode.
    const withoutMode = Object.keys(SETTLEMENT_MODE_BY_EVIDENCE)
      .filter((kind) => SETTLEMENT_MODE_BY_EVIDENCE[kind] === null)
      .sort();
    expect([...ORDER_EVIDENCE_KINDS_AWAITING_SEAM].sort()).toEqual(withoutMode);
    expect(withoutMode).toEqual(['payment_verified']);
  });

  it('no evidence kind other than literally collected cash establishes the cash mode', () => {
    const cashKinds = Object.keys(SETTLEMENT_MODE_BY_EVIDENCE).filter((kind) => SETTLEMENT_MODE_BY_EVIDENCE[kind] === 'cash');
    expect(cashKinds).toEqual(['cash_collected_on_handover']);
  });
});

describe('an unrecognised evidence kind', () => {
  it('is refused rather than treated as the nearest known one', () => {
    const forged = { kind: 'cash_on_delivery_pending', collectedByUserId: STAFF } as unknown as OrderSettlementEvidence;
    expect(() => requireSettlementTruth('cash', forged, null)).toThrowError(expect.objectContaining({ code: 'order.settlement_not_established' }));
  });
});

describe('the whole mapping, enumerated — no unpaid path reaches a committed sale', () => {
  const EXPECTED: Readonly<Record<string, 'cash' | 'credit' | null>> = {
    cash_collected_on_handover: 'cash',
    // PART 31 — unanswered on purpose; see the awaiting-seam block above.
    payment_verified: null,
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

describe('the guest ruling — cash on delivery, until the payment seam is defined', () => {
  // Ashraf's ruling of 2026-10-12, on the decision card that followed the
  // measurement in the contract pack §9: until the Sales + Accounting
  // authorities define the merchant payment and tender seam, a guest pays on
  // delivery. No storefront card payment for a guest, and no account forced on
  // a one-visit shopper either.
  //
  // The gate already produced this outcome before the ruling — credit refuses a
  // null customer and `payment_verified` is refused outright — so this block
  // adds no behaviour. It states the ruling as an EXECUTED law rather than an
  // emergent one, enumerating EVERY evidence kind against a guest so that a
  // fourth kind cannot quietly open a second guest path: a new kind must either
  // refuse a null customer or be added to this table deliberately.
  const GUEST = null;

  const EXPECTED_FOR_A_GUEST: Readonly<Record<string, 'cash' | 'refused'>> = {
    cash_collected_on_handover: 'cash',
    payment_verified: 'refused',
    authorized_customer_credit: 'refused',
  };

  it('covers every declared evidence kind, so a new one cannot slip past this ruling', () => {
    expect(Object.keys(EXPECTED_FOR_A_GUEST).sort()).toEqual([...ORDER_SETTLEMENT_EVIDENCE_KINDS].sort());
  });

  it('establishes a cash sale for a guest ONLY from cash actually collected at handover', () => {
    const established = requireSettlementTruth('cash', CASH_COLLECTED, GUEST);
    expect(established).toEqual({
      mode: 'cash',
      evidenceKind: 'cash_collected_on_handover',
      establishedByUserId: STAFF,
      customerId: null,
    });
  });

  it('refuses every other path for a guest, each with its own reason', () => {
    // A guest card payment: no seam exists, so the surface refusal wins. This is
    // the case the ruling is ABOUT, and it must stay refused rather than become
    // a cash sale by another name.
    expect(() => requireSettlementTruth('cash', PAYMENT_VERIFIED, GUEST)).toThrowError(
      expect.objectContaining({ code: 'order.payment_surface_not_integrated' }),
    );
    // A guest on credit: an anonymous receivable, forbidden by TL-P6-R3/R4. The
    // refusal is the answer; no customer row is invented to make it work.
    expect(() => requireSettlementTruth('credit', CREDIT_AUTHORIZED, GUEST)).toThrowError(
      expect.objectContaining({ code: 'order.checkout_customer_required' }),
    );
  });
});
