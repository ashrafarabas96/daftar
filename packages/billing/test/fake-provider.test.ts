import { describe, expect, it } from 'vitest';
import { BillingError } from '../src/errors';
import { FakePaymentProvider } from '../src/fake-provider';
import type { ChargeRequest } from '../src/ports';

async function expectRefusal(fn: () => Promise<unknown> | unknown, code: string): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, 'the call was expected to refuse and did not').toBeInstanceOf(BillingError);
  expect((caught as BillingError).code).toBe(code);
}

const request = (overrides: Partial<ChargeRequest> = {}): ChargeRequest => ({
  businessId: 'b-1',
  amount: { amountMinor: 30_000n, currency: 'ILS' },
  idempotencyKey: 'charge-2026-04-b1-attempt-1',
  instrumentRef: 'card_ok',
  ...overrides,
});

describe('FakePaymentProvider — outcomes', () => {
  it('succeeds by default and issues a reference that names itself a fake', () => {
    const provider = new FakePaymentProvider();
    return provider.charge(request()).then((result) => {
      expect(result.outcome).toBe('succeeded');
      expect(result.replayed).toBe(false);
      expect(result.providerRef).toMatch(/^fake_\d{6}$/);
      expect(result.providerCode).toBeUndefined();
    });
  });

  it('declines and fails as RESULTS, not exceptions, and carries the provider code', async () => {
    // A decline is an ordinary business outcome the dunning schedule handles.
    // Throwing would push every caller into a catch block that re-classifies.
    const provider = new FakePaymentProvider({ byInstrument: { card_bad: 'decline', card_err: 'fail' } });
    const declined = await provider.charge(request({ instrumentRef: 'card_bad', idempotencyKey: 'k-declined-001' }));
    expect(declined.outcome).toBe('declined');
    expect(declined.providerCode).toBe('fake_card_declined');
    const failed = await provider.charge(request({ instrumentRef: 'card_err', idempotencyKey: 'k-failed-0001' }));
    expect(failed.outcome).toBe('failed');
    expect(failed.providerCode).toBe('fake_processing_error');
  });

  it('THROWS when it reached no verdict, because "unknown" must never read as a decline', async () => {
    const provider = new FakePaymentProvider({ defaultBehaviour: 'unavailable' });
    await expectRefusal(() => provider.charge(request()), 'billing.provider_unavailable');
  });

  it('records nothing for a verdict it never reached, so the same key is a real retry afterwards', async () => {
    const provider = new FakePaymentProvider({ byInstrument: { card_ok: 'unavailable' } });
    await expectRefusal(() => provider.charge(request()), 'billing.provider_unavailable');
    expect(provider.distinctChargeCount).toBe(0);
    // Same key, provider now reachable: this must CHARGE, not replay a
    // decline that never happened.
    const recovered = new FakePaymentProvider();
    const result = await recovered.charge(request());
    expect(result.outcome).toBe('succeeded');
    expect(result.replayed).toBe(false);
  });
});

describe('FakePaymentProvider — idempotency', () => {
  it('replays the original result for a repeat of the same key, and charges only once', async () => {
    const provider = new FakePaymentProvider();
    const first = await provider.charge(request());
    const second = await provider.charge(request());
    expect(second.providerRef).toBe(first.providerRef);
    expect(second.outcome).toBe(first.outcome);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    // The defect this whole port exists to prevent: a retry that charges twice.
    expect(provider.distinctChargeCount).toBe(1);
  });

  it('replays a DECLINE too, rather than re-attempting it under the same key', async () => {
    const provider = new FakePaymentProvider({ defaultBehaviour: 'decline' });
    const first = await provider.charge(request());
    const second = await provider.charge(request());
    expect(second).toEqual({ ...first, replayed: true });
    expect(provider.distinctChargeCount).toBe(1);
  });

  it('refuses the same key with a different amount, currency, business or instrument', async () => {
    const provider = new FakePaymentProvider();
    await provider.charge(request());
    await expectRefusal(() => provider.charge(request({ amount: { amountMinor: 30_001n, currency: 'ILS' } })), 'billing.provider_idempotency_conflict');
    await expectRefusal(() => provider.charge(request({ amount: { amountMinor: 30_000n, currency: 'USD' } })), 'billing.provider_idempotency_conflict');
    await expectRefusal(() => provider.charge(request({ businessId: 'b-2' })), 'billing.provider_idempotency_conflict');
    await expectRefusal(() => provider.charge(request({ instrumentRef: 'card_other' })), 'billing.provider_idempotency_conflict');
    // None of the refused calls became a charge.
    expect(provider.distinctChargeCount).toBe(1);
  });

  it('keeps two different keys apart', async () => {
    const provider = new FakePaymentProvider();
    const a = await provider.charge(request({ idempotencyKey: 'attempt-1-aaaa' }));
    const b = await provider.charge(request({ idempotencyKey: 'attempt-2-bbbb' }));
    expect(a.providerRef).not.toBe(b.providerRef);
    expect(provider.distinctChargeCount).toBe(2);
  });
});

describe('FakePaymentProvider — refusals on a malformed charge', () => {
  it('requires an idempotency key that a caller plainly generated', async () => {
    const provider = new FakePaymentProvider();
    await expectRefusal(() => provider.charge(request({ idempotencyKey: '' })), 'billing.provider_idempotency_key_invalid');
    await expectRefusal(() => provider.charge(request({ idempotencyKey: 'short' })), 'billing.provider_idempotency_key_invalid');
  });

  it('refuses a zero, negative, over-cap or non-integer amount', async () => {
    const provider = new FakePaymentProvider();
    await expectRefusal(() => provider.charge(request({ amount: { amountMinor: 0n, currency: 'ILS' } })), 'billing.provider_amount_invalid');
    await expectRefusal(() => provider.charge(request({ amount: { amountMinor: -1n, currency: 'ILS' } })), 'billing.provider_amount_invalid');
    await expectRefusal(() => provider.charge(request({ amount: { amountMinor: 10n ** 18n + 1n, currency: 'ILS' } })), 'billing.provider_amount_invalid');
    await expectRefusal(
      () => provider.charge(request({ amount: { amountMinor: 100 as unknown as bigint, currency: 'ILS' } })),
      'billing.provider_amount_invalid',
    );
    await expectRefusal(() => provider.charge(request({ amount: { amountMinor: 100n, currency: 'shekel' } })), 'billing.provider_amount_invalid');
  });

  it('refuses a charge with no business or no instrument', async () => {
    const provider = new FakePaymentProvider();
    await expectRefusal(() => provider.charge(request({ businessId: '  ' })), 'billing.payload_invalid');
    await expectRefusal(() => provider.charge(request({ instrumentRef: '' })), 'billing.payload_invalid');
  });

  it('refuses a scenario asking for a behaviour it does not implement', () => {
    expect(() => new FakePaymentProvider({ defaultBehaviour: 'explode' as unknown as 'succeed' })).toThrow(BillingError);
    expect(() => new FakePaymentProvider({ byInstrument: { x: 'explode' as unknown as 'succeed' } })).toThrow(BillingError);
  });
});
