/**
 * The order → sale hand-off.
 *
 * The forbidden-field law is proved by MUTATION, once per entry in the list:
 * the field is injected into a built intent, the injection is asserted to have
 * landed (the key is really there before the check runs), and the refusal is
 * required to NAME that exact field. A `toThrow()` with no named subject would
 * pass just as well if the guard refused everything for an unrelated reason,
 * and a mutation that silently failed to apply would leave a green test over a
 * law that was never exercised.
 */
import { describe, expect, it } from 'vitest';
import {
  OrderError,
  SALE_FORBIDDEN_INTENT_FIELDS,
  assertNoForbiddenIntentFields,
  buildSaleCommitIntent,
  stockKeyOf,
  summariseBasket,
  type OrderCheckoutFacts,
  type OrderSnapshot,
  type OrderState,
} from '../src';

const PRODUCT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VARIANT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LINE1 = '11111111-1111-4111-8111-111111111111';
const LINE2 = '22222222-2222-4222-8222-222222222222';
const SALE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const WAREHOUSE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CUSTOMER = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const STAFF = '77777777-7777-4777-8777-777777777777';
const MANAGER = '88888888-8888-4888-8888-888888888888';

/** The honest cash path: the money changed hands, and a named person collected it. */
const CASH_COLLECTED = { kind: 'cash_collected_on_handover', collectedByUserId: STAFF } as const;
/** The only thing that turns canonical credit on, per order, with an authorizing human. */
const CREDIT_AUTHORIZED = { kind: 'authorized_customer_credit', authorizedByUserId: MANAGER } as const;

const KEY = stockKeyOf({ productId: PRODUCT, variantId: VARIANT });
const PRECISION = new Map([[KEY, 0]]);
const POSITIONS = summariseBasket(
  [
    { lineId: LINE1, productId: PRODUCT, variantId: VARIANT, quantity: '2' },
    { lineId: LINE2, productId: PRODUCT, variantId: VARIANT, quantity: '3' },
  ],
  PRECISION,
);

function snapshot(state: OrderState, saleId: string | null = null): OrderSnapshot {
  return { state, saleId, lastOccurredAt: '2026-10-01T09:00:00Z', transitionCount: 2, isTerminal: false };
}

const CASH: OrderCheckoutFacts = {
  saleId: SALE,
  settlementMode: 'cash',
  settlementEvidence: CASH_COLLECTED,
  customerId: null,
  warehouseId: WAREHOUSE,
  documentDate: '2026-10-01',
  dueDate: null,
  taxMinor: '0',
  notes: null,
};

describe('buildSaleCommitIntent', () => {
  it('merges the basket into one line per stock key, carrying the first row id', () => {
    const intent = buildSaleCommitIntent(snapshot('accepted'), POSITIONS, CASH);
    expect(intent.lines).toHaveLength(1);
    expect(intent.lines[0]?.lineId).toBe(LINE1);
    expect(intent.lines[0]?.quantity).toBe('5.0000');
    expect(intent.lines[0]?.variantId).toBe(VARIANT);
    expect(intent.lines[0]?.discountMinor).toBe('0');
  });

  it('builds from accepted and from fulfilling, and from nothing else', () => {
    for (const state of ['accepted', 'fulfilling'] as OrderState[]) {
      expect(buildSaleCommitIntent(snapshot(state), POSITIONS, CASH).saleId).toBe(SALE);
    }
    for (const state of ['placed', 'rejected', 'cancelled'] as OrderState[]) {
      expect(() => buildSaleCommitIntent(snapshot(state), POSITIONS, CASH)).toThrowError(expect.objectContaining({ code: 'order.checkout_state_invalid' }));
    }
  });

  it('refuses an order already bound to a sale — by state and by binding, independently', () => {
    for (const state of ['fulfilled', 'completed'] as OrderState[]) {
      expect(() => buildSaleCommitIntent(snapshot(state, SALE), POSITIONS, CASH)).toThrowError(
        expect.objectContaining({ code: 'order.checkout_state_invalid' }),
      );
    }
    // A snapshot whose STATE looks buildable but which already carries a sale is
    // refused too: the binding, not only the label, closes the checkout.
    expect(() => buildSaleCommitIntent(snapshot('accepted', SALE), POSITIONS, CASH)).toThrowError(
      expect.objectContaining({ code: 'order.checkout_state_invalid' }),
    );
  });

  it('refuses an empty position list', () => {
    expect(() => buildSaleCommitIntent(snapshot('accepted'), [], CASH)).toThrowError(expect.objectContaining({ code: 'order.cart_empty' }));
  });

  it('states the tax as zero and refuses any non-zero value rather than normalizing it', () => {
    expect(buildSaleCommitIntent(snapshot('accepted'), POSITIONS, CASH).taxMinor).toBe('0');
    for (const taxMinor of ['1', '-1', '0.00', '00', '']) {
      expect(() => buildSaleCommitIntent(snapshot('accepted'), POSITIONS, { ...CASH, taxMinor })).toThrowError(
        expect.objectContaining({ code: 'order.checkout_tax_policy_absent' }),
      );
    }
  });
});

describe('the credit laws (TL-P6-R3, TL-P6-R4) and the settlement-truth gate (section 25)', () => {
  it('refuses a credit checkout with no customer — an anonymous receivable is forbidden', () => {
    expect(() =>
      buildSaleCommitIntent(snapshot('accepted'), POSITIONS, { ...CASH, settlementMode: 'credit', settlementEvidence: CREDIT_AUTHORIZED }),
    ).toThrowError(expect.objectContaining({ code: 'order.checkout_customer_required' }));
  });

  it('admits a credit checkout that names one and was authorized, with a due date on the document date', () => {
    const intent = buildSaleCommitIntent(snapshot('accepted'), POSITIONS, {
      ...CASH,
      settlementMode: 'credit',
      settlementEvidence: CREDIT_AUTHORIZED,
      customerId: CUSTOMER,
      dueDate: '2026-10-01',
    });
    expect(intent.settlementMode).toBe('credit');
    expect(intent.dueDate).toBe('2026-10-01');
  });

  it('refuses a credit CLAIM backed only by collected cash — the claim is never adopted on trust', () => {
    expect(() =>
      buildSaleCommitIntent(snapshot('accepted'), POSITIONS, { ...CASH, settlementMode: 'credit', customerId: CUSTOMER, settlementEvidence: CASH_COLLECTED }),
    ).toThrowError(expect.objectContaining({ code: 'order.settlement_mode_unsupported' }));
  });

  it('refuses a cash CLAIM backed only by a credit authorization — and never silently corrects it', () => {
    // Silently adopting the evidence's mode would commit a receivable the
    // merchant never asked for. The refusal is the whole point.
    expect(() => buildSaleCommitIntent(snapshot('accepted'), POSITIONS, { ...CASH, customerId: CUSTOMER, settlementEvidence: CREDIT_AUTHORIZED })).toThrowError(
      expect.objectContaining({ code: 'order.settlement_mode_unsupported' }),
    );
  });

  it('refuses a verified online payment: no merchant provider is integrated (section 31)', () => {
    expect(() =>
      buildSaleCommitIntent(snapshot('accepted'), POSITIONS, { ...CASH, settlementEvidence: { kind: 'payment_verified', providerRef: 'ref-1' } }),
    ).toThrowError(expect.objectContaining({ code: 'order.payment_surface_not_integrated' }));
  });

  it('refuses a due date without a credit settlement, whichever side is missing', () => {
    expect(() => buildSaleCommitIntent(snapshot('accepted'), POSITIONS, { ...CASH, customerId: CUSTOMER, dueDate: '2026-10-02' })).toThrowError(
      expect.objectContaining({ code: 'order.checkout_customer_required' }),
    );
    expect(() =>
      buildSaleCommitIntent(snapshot('accepted'), POSITIONS, {
        ...CASH,
        settlementMode: 'credit',
        settlementEvidence: CREDIT_AUTHORIZED,
        dueDate: '2026-10-02',
      }),
    ).toThrowError(expect.objectContaining({ code: 'order.checkout_customer_required' }));
  });

  it('admits a cash walk-in, because collected cash from a walk-in is a true fact', () => {
    expect(buildSaleCommitIntent(snapshot('accepted'), POSITIONS, CASH).customerId).toBeNull();
  });

  it('carries the ESTABLISHED mode into the intent, not the claimed one', () => {
    const intent = buildSaleCommitIntent(snapshot('accepted'), POSITIONS, {
      ...CASH,
      settlementMode: 'credit',
      settlementEvidence: CREDIT_AUTHORIZED,
      customerId: CUSTOMER,
    });
    expect(intent.settlementMode).toBe('credit');
  });
});

describe('the dates', () => {
  it.each(['2026-13-01', '2026-02-30', '2026-1-1', '20261001', ''])('refuses the impossible or non-canonical document date %s', (documentDate) => {
    expect(() => buildSaleCommitIntent(snapshot('accepted'), POSITIONS, { ...CASH, documentDate })).toThrowError(
      expect.objectContaining({ code: 'order.checkout_date_invalid' }),
    );
  });

  it('refuses a due date that precedes the document date', () => {
    expect(() =>
      buildSaleCommitIntent(snapshot('accepted'), POSITIONS, {
        ...CASH,
        settlementMode: 'credit',
        settlementEvidence: CREDIT_AUTHORIZED,
        customerId: CUSTOMER,
        dueDate: '2026-09-30',
      }),
    ).toThrowError(expect.objectContaining({ code: 'order.checkout_date_invalid' }));
  });
});

describe('the discount request', () => {
  it('carries a stated request through untouched — no arithmetic happens here', () => {
    const intent = buildSaleCommitIntent(snapshot('accepted'), POSITIONS, { ...CASH, discountMinorByStockKey: new Map([[KEY, '250']]) });
    expect(intent.lines[0]?.discountMinor).toBe('250');
  });

  it.each(['-1', '1.5', '01', ' 1', '1e2', ''])('refuses the discount request %s', (value) => {
    expect(() => buildSaleCommitIntent(snapshot('accepted'), POSITIONS, { ...CASH, discountMinorByStockKey: new Map([[KEY, value]]) })).toThrowError(
      expect.objectContaining({ code: 'order.checkout_field_forbidden' }),
    );
  });

  it('refuses a discount for a stock key the checkout does not carry', () => {
    expect(() =>
      buildSaleCommitIntent(snapshot('accepted'), POSITIONS, {
        ...CASH,
        discountMinorByStockKey: new Map([[stockKeyOf({ productId: PRODUCT, variantId: null }), '1']]),
      }),
    ).toThrowError(expect.objectContaining({ code: 'order.availability_subject_unknown' }));
  });
});

describe('the forbidden-field law, proved by mutation', () => {
  it('has a non-empty subject set with no duplicates', () => {
    expect(SALE_FORBIDDEN_INTENT_FIELDS.length).toBeGreaterThan(20);
    expect(new Set(SALE_FORBIDDEN_INTENT_FIELDS).size).toBe(SALE_FORBIDDEN_INTENT_FIELDS.length);
  });

  it('passes the intent the builder actually produces', () => {
    const intent = buildSaleCommitIntent(snapshot('accepted'), POSITIONS, CASH);
    expect(() => assertNoForbiddenIntentFields(intent)).not.toThrow();
  });

  for (const field of SALE_FORBIDDEN_INTENT_FIELDS) {
    it(`names ${field} when it appears on the header`, () => {
      const mutated = { ...buildSaleCommitIntent(snapshot('accepted'), POSITIONS, CASH) } as Record<string, unknown>;
      mutated[field] = '1';
      // Prove the mutation landed before reading the verdict: a mutation that
      // did not apply would leave a green test over an unexercised law.
      expect(Object.keys(mutated)).toContain(field);
      try {
        assertNoForbiddenIntentFields(mutated);
        throw new Error(`the header carried ${field} and was accepted`);
      } catch (error) {
        expect(error).toBeInstanceOf(OrderError);
        expect((error as OrderError).code).toBe('order.checkout_field_forbidden');
        expect((error as OrderError).details?.field).toBe(field);
        expect((error as OrderError).details?.where).toBe('header');
      }
    });

    it(`names ${field} when it appears on a line`, () => {
      const intent = buildSaleCommitIntent(snapshot('accepted'), POSITIONS, CASH);
      const line = { ...intent.lines[0] } as Record<string, unknown>;
      line[field] = '1';
      expect(Object.keys(line)).toContain(field);
      const mutated = { ...intent, lines: [line] };
      try {
        assertNoForbiddenIntentFields(mutated);
        throw new Error(`a line carried ${field} and was accepted`);
      } catch (error) {
        expect((error as OrderError).code).toBe('order.checkout_field_forbidden');
        expect((error as OrderError).details?.field).toBe(field);
        expect((error as OrderError).details?.where).toBe('lines[0]');
      }
    });
  }

  it('does not forbid the fields the sale command genuinely accepts', () => {
    for (const permitted of [
      'saleId',
      'settlementMode',
      'customerId',
      'warehouseId',
      'documentDate',
      'dueDate',
      'taxMinor',
      'notes',
      'lines',
      'discountMinor',
      'quantity',
      'productId',
      'variantId',
      'lineId',
    ]) {
      expect(SALE_FORBIDDEN_INTENT_FIELDS).not.toContain(permitted);
    }
  });
});
