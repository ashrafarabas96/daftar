/**
 * The collection-attempt identity law (Master Continuous Mission V3 §12).
 *
 * The rule is: a charge attempt is bound to a stable logical identity at the
 * provider, and after an accepted-but-lost response no attempt is created
 * under a NEW key until the first one is reconciled — because our own
 * database's uniqueness cannot undo a second debit somewhere else.
 *
 * Three of these cases are the law; the rest guard its edges. The one that
 * matters most is «a fresh key after a lost response charges twice», because
 * it is the only one that shows the cost. It is driven against
 * `FakePaymentProvider`'s `accept_then_lose`, which records the charge and
 * then throws — exactly what a provider that accepted the request and lost
 * the connection looks like from here.
 */
import { describe, expect, it } from 'vitest';
import {
  collectionAttemptKey,
  collectionRequestFor,
  COLLECTION_KEY_NAMESPACE,
  MAX_COLLECTION_ATTEMPT_NO,
  type CollectionAttemptIdentity,
  type CollectionRequestInput,
} from '../src/collection';
import { decideDunning, type DunningAttempt, type DunningDecision, type DunningPolicy } from '../src/dunning';
import { BillingError } from '../src/errors';
import { FakePaymentProvider } from '../src/fake-provider';

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

const INVOICE = 'inv-2026-04-b1';
const POLICY: DunningPolicy = { retryOffsetHours: [0, 24, 72], graceHours: 120 };
const PERIOD_END = '2026-04-01T00:00:00.000Z';

const attempt = (iso: string, outcome: DunningAttempt['outcome']): DunningAttempt => ({ attemptedAt: iso, outcome });

const decide = (attempts: readonly DunningAttempt[], asOf: string): DunningDecision =>
  decideDunning({ policy: POLICY, periodEndsAt: PERIOD_END, attempts, asOf, storedState: 'active' });

const requestInput = (overrides: Partial<CollectionRequestInput> = {}): CollectionRequestInput => ({
  businessId: 'b-1',
  invoiceId: INVOICE,
  decision: decide([], PERIOD_END),
  amount: { amountMinor: 30_000n, currency: 'ILS' },
  instrumentRef: 'card_ok',
  ...overrides,
});

describe('the key is derived, never generated', () => {
  it('names the namespace, the invoice and the ordinal, and nothing else', () => {
    expect(collectionAttemptKey({ invoiceId: INVOICE, attemptNo: 2 })).toBe(`${COLLECTION_KEY_NAMESPACE}:${INVOICE}:2`);
  });

  it('is the same string every time it is asked, in any order', () => {
    const identity: CollectionAttemptIdentity = { invoiceId: INVOICE, attemptNo: 3 };
    const keys = new Set([collectionAttemptKey(identity), collectionAttemptKey({ attemptNo: 3, invoiceId: INVOICE }), collectionAttemptKey(identity)]);
    expect(keys.size, 'the same attempt produced more than one key').toBe(1);
    // Repeated calls alone cannot see a clock: a mutation that appended
    // `Date.now()` left this case green, because three calls in one
    // millisecond agree. So the SHAPE is asserted too — three segments,
    // nothing appended — which is what a per-call component breaks.
    const segments = collectionAttemptKey(identity).split(':');
    expect(segments.length, 'the key carries something beyond the namespace, the invoice and the ordinal').toBe(3);
  });

  it('gives different attempts different keys', () => {
    expect(collectionAttemptKey({ invoiceId: INVOICE, attemptNo: 1 })).not.toBe(collectionAttemptKey({ invoiceId: INVOICE, attemptNo: 2 }));
  });

  it('gives different invoices different keys', () => {
    expect(collectionAttemptKey({ invoiceId: INVOICE, attemptNo: 1 })).not.toBe(collectionAttemptKey({ invoiceId: 'inv-2026-05-b1', attemptNo: 1 }));
  });

  it('clears the port’s own key floor', () => {
    // Not a security property: the port refuses a key under eight characters
    // because such a key is plainly not one per attempt, and a derived key
    // must not fail that check by accident.
    expect(collectionAttemptKey({ invoiceId: INVOICE, attemptNo: 1 }).length).toBeGreaterThanOrEqual(8);
  });

  it('refuses an invoice identifier that is not one token', () => {
    expectRefusal(() => collectionAttemptKey({ invoiceId: 'inv 2026 04', attemptNo: 1 }), 'billing.collection_identity_invalid');
    expectRefusal(() => collectionAttemptKey({ invoiceId: ' inv-2026-04-b1', attemptNo: 1 }), 'billing.collection_identity_invalid');
    expectRefusal(() => collectionAttemptKey({ invoiceId: 'short', attemptNo: 1 }), 'billing.collection_identity_invalid');
  });

  it('refuses an ordinal that is not a whole number within the cap', () => {
    for (const attemptNo of [0, -1, 1.5, MAX_COLLECTION_ATTEMPT_NO + 1, Number.NaN]) {
      expectRefusal(() => collectionAttemptKey({ invoiceId: INVOICE, attemptNo }), 'billing.collection_identity_invalid');
    }
  });
});

describe('an attempt with no verdict does not advance the ordinal', () => {
  it('the dunning schedule says reconcile, not charge, and names that same ordinal', () => {
    const history = [attempt(PERIOD_END, 'unknown')];
    const decision = decide(history, '2026-04-10T00:00:00.000Z');
    expect(decision.action).toBe('reconcile');
    expect(decision.attemptNo).toBe(1);
    expect(decision.nextAttemptAt).toBeNull();
    expect(decision.exhausted).toBe(false);
  });

  it('an unknown verdict is not a failure, so it moves nobody towards suspension', () => {
    // A lost response is not evidence that the money did not arrive. Treating
    // it as a failure would suspend merchants who had paid.
    const decision = decide([attempt(PERIOD_END, 'unknown')], '2026-04-30T00:00:00.000Z');
    expect(decision.targetState).toBeNull();
  });

  it('reconcile wins even over an exhausted schedule', () => {
    const history = [attempt(PERIOD_END, 'failed'), attempt('2026-04-02T00:00:00.000Z', 'failed'), attempt('2026-04-04T00:00:00.000Z', 'unknown')];
    const decision = decide(history, '2026-05-01T00:00:00.000Z');
    expect(decision.action).toBe('reconcile');
    expect(decision.attemptNo).toBe(3);
  });

  it('refuses a history that stepped past an unresolved attempt', () => {
    const history = [attempt(PERIOD_END, 'unknown'), attempt('2026-04-02T00:00:00.000Z', 'failed')];
    expectRefusal(() => decide(history, '2026-04-10T00:00:00.000Z'), 'billing.collection_awaiting_reconciliation');
  });

  it('refuses it even when the later attempt succeeded', () => {
    // The success does not make the skipped attempt accounted for: whatever
    // the lost one did at the provider is still unread, and this invoice may
    // have been collected twice already.
    const history = [attempt(PERIOD_END, 'unknown'), attempt('2026-04-02T00:00:00.000Z', 'succeeded')];
    expectRefusal(() => decide(history, '2026-04-10T00:00:00.000Z'), 'billing.collection_awaiting_reconciliation');
  });
});

describe('the request a decision authorizes', () => {
  it('carries the derived key for the decision’s ordinal', () => {
    const decision = decide([attempt(PERIOD_END, 'failed')], '2026-04-02T00:00:00.000Z');
    const request = collectionRequestFor(requestInput({ decision }));
    expect(decision.action).toBe('charge');
    expect(request.idempotencyKey).toBe(collectionAttemptKey({ invoiceId: INVOICE, attemptNo: decision.attemptNo }));
  });

  it('on reconcile it is identical to the request the lost attempt sent', () => {
    const first = collectionRequestFor(requestInput({ decision: decide([], PERIOD_END) }));
    const again = collectionRequestFor(requestInput({ decision: decide([attempt(PERIOD_END, 'unknown')], '2026-04-10T00:00:00.000Z') }));
    expect(again).toStrictEqual(first);
  });

  it('refuses to build a request when the schedule does not authorize one', () => {
    for (const asOf of ['2026-04-01T00:00:00.000Z']) {
      const waiting = decide([attempt(PERIOD_END, 'failed')], asOf);
      expect(waiting.action).toBe('wait');
      expectRefusal(() => collectionRequestFor(requestInput({ decision: waiting })), 'billing.collection_not_due');
    }
    const settled = decideDunning({ policy: POLICY, periodEndsAt: PERIOD_END, attempts: [], asOf: PERIOD_END, storedState: 'cancelled' });
    expect(settled.action).toBe('none');
    expectRefusal(() => collectionRequestFor(requestInput({ decision: settled })), 'billing.collection_not_due');
  });

  it('refuses a request with no business, no instrument or no amount', () => {
    expectRefusal(() => collectionRequestFor(requestInput({ businessId: '  ' })), 'billing.collection_identity_invalid');
    expectRefusal(() => collectionRequestFor(requestInput({ instrumentRef: '' })), 'billing.collection_identity_invalid');
    expectRefusal(() => collectionRequestFor(requestInput({ amount: { amountMinor: 0n, currency: 'ILS' } })), 'billing.collection_identity_invalid');
  });
});

describe('what a lost response costs, measured against the provider', () => {
  /**
   * `accept_then_lose` records the charge and then throws. So the provider
   * has taken the money and the caller has no verdict — the exact case the
   * rule is about, and one this fake could not express before round 6.
   */
  const lossy = (): FakePaymentProvider => new FakePaymentProvider({ byInstrument: { card_lost: 'accept_then_lose' } });

  async function chargeAndLose(provider: FakePaymentProvider, decision: DunningDecision): Promise<string> {
    let code = 'none';
    try {
      await provider.charge(collectionRequestFor(requestInput({ decision, instrumentRef: 'card_lost' })));
    } catch (e) {
      code = e instanceof BillingError ? e.code : 'other';
    }
    return code;
  }

  it('the first attempt throws although the provider has charged', async () => {
    const provider = lossy();
    expect(await chargeAndLose(provider, decide([], PERIOD_END))).toBe('billing.provider_unavailable');
    expect(provider.distinctChargeCount).toBe(1);
  });

  it('reusing the attempt’s key collects the verdict without a second charge', async () => {
    const provider = lossy();
    await chargeAndLose(provider, decide([], PERIOD_END));

    // What the law prescribes: the history records `unknown`, the schedule
    // says reconcile, and the request is the same attempt again.
    const reconcile = decide([attempt(PERIOD_END, 'unknown')], '2026-04-10T00:00:00.000Z');
    const result = await provider.charge(collectionRequestFor(requestInput({ decision: reconcile, instrumentRef: 'card_lost' })));

    expect(result.replayed, 'the provider answered with a new charge instead of its record').toBe(true);
    expect(result.outcome).toBe('succeeded');
    expect(provider.distinctChargeCount, 'the merchant was charged more than once').toBe(1);
  });

  it('a FRESH key after the same lost response charges a second time', async () => {
    const provider = lossy();
    await chargeAndLose(provider, decide([], PERIOD_END));

    // What a caller does when it records a lost response as a failure: the
    // ordinal advances, the key changes, and the provider has no way to know
    // this is the same collection. Nothing in our database can refuse it —
    // the debit happens elsewhere, and we only find out afterwards.
    const asFailure = decide([attempt(PERIOD_END, 'failed')], '2026-04-02T00:00:00.000Z');
    expect(asFailure.action).toBe('charge');
    expect(asFailure.attemptNo).toBe(2);
    // try/catch rather than `.catch()`: a refusal from this port can arrive
    // SYNCHRONOUSLY, so a bare promise handler would not see it. See the
    // note at `PaymentProviderPort`.
    try {
      await provider.charge(collectionRequestFor(requestInput({ decision: asFailure, instrumentRef: 'card_lost' })));
    } catch {
      /* the second debit still happened; that is the point of the case */
    }

    expect(provider.distinctChargeCount, 'this is the second external debit the rule exists to prevent').toBe(2);
  });

  it('a key reused for a DIFFERENT amount is refused rather than replayed', async () => {
    const provider = lossy();
    await chargeAndLose(provider, decide([], PERIOD_END));
    const reconcile = decide([attempt(PERIOD_END, 'unknown')], '2026-04-10T00:00:00.000Z');
    let code = 'none';
    try {
      await provider.charge(
        collectionRequestFor(requestInput({ decision: reconcile, instrumentRef: 'card_lost', amount: { amountMinor: 1n, currency: 'ILS' } })),
      );
    } catch (e) {
      code = e instanceof BillingError ? e.code : 'other';
    }
    expect(code).toBe('billing.provider_idempotency_conflict');
    expect(provider.distinctChargeCount).toBe(1);
  });
});
