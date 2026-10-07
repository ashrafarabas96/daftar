/**
 * The fake payment provider — the only implementation of
 * `PaymentProviderPort` this slice ships.
 *
 * Part 25 and Part 66: internal engineering does not wait on a credential.
 * So this adapter is a complete, deterministic provider that the dunning
 * schedule, the invoice composition and (at promotion) the API surface can be
 * driven against end to end, with no network and no secret.
 *
 * ── Deterministic, and that is the point ───────────────────────────────
 *
 * It holds no randomness and no clock. What it does with a charge is decided
 * entirely by the scenario the test or the development environment gave it,
 * keyed by `instrumentRef`. A fake that declined "sometimes" would make every
 * suite that used it flaky, and a flaky billing suite is one nobody reads.
 *
 * ── It enforces the port's idempotency law rather than describing it ───
 *
 * A repeat of a key returns the original result with `replayed: true`; a key
 * reused with different parameters is refused. A fake that accepted both
 * would let a caller ship an idempotency bug that only a real provider — and
 * only in production — would catch.
 *
 * ── It is not a production adapter and cannot become one by accident ──
 *
 * `FakePaymentProvider` names itself in every reference it issues
 * (`fake_…`), so a provider reference that reached a real record would be
 * visible on inspection rather than looking like a charge that happened.
 */
import { refuse } from './errors';
import type { ChargeOutcome, ChargeRequest, ChargeResult, PaymentProviderPort } from './ports';
import { MAX_BILLING_MINOR } from './types';

/**
 * What the fake should do with an instrument.
 *
 * `unavailable` models the one case that is not a result: the adapter could
 * not reach a verdict, so it throws. Being able to exercise that is the whole
 * reason the outcome set and the throw are different mechanisms.
 */
export const FAKE_BEHAVIOURS = ['succeed', 'decline', 'fail', 'unavailable'] as const;
export type FakeBehaviour = (typeof FAKE_BEHAVIOURS)[number];

export interface FakeProviderScenario {
  /**
   * Per-instrument behaviour. An instrument not named here uses
   * `defaultBehaviour`.
   */
  readonly byInstrument?: Readonly<Record<string, FakeBehaviour>>;
  /** What an unnamed instrument does. Defaults to `succeed`. */
  readonly defaultBehaviour?: FakeBehaviour;
}

interface RecordedCall {
  readonly fingerprint: string;
  readonly result: ChargeResult;
}

const OUTCOME_OF: Readonly<Record<Exclude<FakeBehaviour, 'unavailable'>, ChargeOutcome>> = {
  succeed: 'succeeded',
  decline: 'declined',
  fail: 'failed',
};

export class FakePaymentProvider implements PaymentProviderPort {
  private readonly scenario: FakeProviderScenario;
  private readonly calls = new Map<string, RecordedCall>();
  private sequence = 0;

  constructor(scenario: FakeProviderScenario = {}) {
    const names: FakeBehaviour[] = [];
    if (scenario.defaultBehaviour !== undefined) names.push(scenario.defaultBehaviour);
    for (const value of Object.values(scenario.byInstrument ?? {})) names.push(value);
    for (const name of names) {
      if (!(FAKE_BEHAVIOURS as readonly string[]).includes(name)) {
        refuse('billing.payload_invalid', 'the fake provider was given a behaviour it does not implement');
      }
    }
    this.scenario = scenario;
  }

  /**
   * How many DISTINCT charges were made (replays excluded).
   *
   * Exposed because "the retry charged twice" is the defect this whole port
   * exists to prevent, and a test that cannot count charges can only check
   * that the last one looked right.
   */
  get distinctChargeCount(): number {
    return this.calls.size;
  }

  private behaviourFor(instrumentRef: string): FakeBehaviour {
    return this.scenario.byInstrument?.[instrumentRef] ?? this.scenario.defaultBehaviour ?? 'succeed';
  }

  /**
   * The parameters a key is bound to. Everything that decides what is charged
   * is in here, so a caller that changed any of it under the same key is
   * caught rather than served a replay of a different charge.
   */
  private static fingerprint(request: ChargeRequest): string {
    return [request.businessId, request.instrumentRef, request.amount.currency, request.amount.amountMinor.toString()].join('|');
  }

  charge(request: ChargeRequest): Promise<ChargeResult> {
    if (!request || typeof request.businessId !== 'string' || request.businessId.trim().length === 0) {
      refuse('billing.payload_invalid', 'a charge must name the business it is for');
    }
    if (typeof request.instrumentRef !== 'string' || request.instrumentRef.trim().length === 0) {
      refuse('billing.payload_invalid', 'a charge must name the payment instrument to use', { businessId: request.businessId });
    }
    if (typeof request.idempotencyKey !== 'string' || request.idempotencyKey.trim().length < 8) {
      // A short key is not a key. Eight characters is not security — it is the
      // floor below which a caller is plainly not generating one per attempt.
      refuse('billing.provider_idempotency_key_invalid', 'a charge must carry a caller-generated idempotency key', {
        businessId: request.businessId,
      });
    }
    const amount = request.amount;
    if (!amount || typeof amount.amountMinor !== 'bigint' || amount.amountMinor <= 0n || amount.amountMinor > MAX_BILLING_MINOR) {
      refuse('billing.provider_amount_invalid', 'a charge amount must be a positive exact integer within the money cap', {
        businessId: request.businessId,
      });
    }
    if (typeof amount.currency !== 'string' || !/^[A-Z]{3}$/.test(amount.currency)) {
      refuse('billing.provider_amount_invalid', 'a charge amount must carry a three-letter currency code', { businessId: request.businessId });
    }

    const key = request.idempotencyKey;
    const fingerprint = FakePaymentProvider.fingerprint(request);
    const recorded = this.calls.get(key);
    if (recorded) {
      if (recorded.fingerprint !== fingerprint) {
        refuse('billing.provider_idempotency_conflict', 'this idempotency key was already used for a different charge', {
          businessId: request.businessId,
          providerRef: recorded.result.providerRef,
        });
      }
      return Promise.resolve({ ...recorded.result, replayed: true });
    }

    const behaviour = this.behaviourFor(request.instrumentRef);
    if (behaviour === 'unavailable') {
      // Nothing is recorded: the adapter reached no verdict, so a later retry
      // of the same key is a genuine retry and not a replay of a decline.
      refuse('billing.provider_unavailable', 'the provider could not be reached and no verdict exists for this charge', {
        businessId: request.businessId,
      });
    }

    this.sequence += 1;
    const providerRef = `fake_${String(this.sequence).padStart(6, '0')}`;
    const outcome = OUTCOME_OF[behaviour];
    const result: ChargeResult =
      outcome === 'succeeded'
        ? { outcome, providerRef, replayed: false }
        : { outcome, providerRef, providerCode: outcome === 'declined' ? 'fake_card_declined' : 'fake_processing_error', replayed: false };
    this.calls.set(key, { fingerprint, result });
    return Promise.resolve(result);
  }
}
