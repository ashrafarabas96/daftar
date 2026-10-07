/**
 * The payment-provider port.
 *
 * Part 25: external payment providers sit behind an adapter, and a fake
 * provider carries internal engineering until credentials exist. This file is
 * the contract; `fake-provider.ts` is the only implementation this slice
 * ships. A real adapter is a promotion-time artifact and is not written here,
 * because an adapter written against a provider nobody has signed with is a
 * guess at an API.
 *
 * ── What is deliberately absent ─────────────────────────────────────────
 *
 * There is no `apiKey`, no `secret`, no `endpoint` and no `testMode` here.
 * Credentials belong to the process that constructs the adapter, and a port
 * that named them would make every caller a place a secret can leak from.
 * There is also no `skipIdempotency` and no `force`: a seam that could be
 * handed `true` becomes a permanent bypass the first time somebody finds it
 * convenient (the same reason `@daftar/accounting`'s ports carry no
 * `skipAuthorization`).
 *
 * ── Idempotency is the caller's, and it is mandatory ───────────────────
 *
 * A charge is the one operation in this slice that moves real money, and a
 * retried HTTP request is indistinguishable from a second charge unless the
 * caller names the attempt. So `idempotencyKey` is required, and an
 * implementation MUST return the original result for a repeat of the same key
 * rather than charging again. A key reused with DIFFERENT parameters is a bug
 * in the caller, not a retry, and is refused with
 * `billing.provider_idempotency_conflict` — the same discipline
 * `IDEMPOTENCY_KEY_REUSED` applies to the HTTP surface.
 *
 * ── Why the result carries no balance and no card ──────────────────────
 *
 * The result says what happened to one charge and nothing about the payer.
 * A port that returned a card's last four digits or a stored balance would
 * make every caller a holder of payment-instrument data.
 */
import type { Price } from './types';

/** What a charge attempt did. A closed set; an adapter invents no sixth value. */
export const CHARGE_OUTCOMES = ['succeeded', 'declined', 'failed'] as const;
export type ChargeOutcome = (typeof CHARGE_OUTCOMES)[number];

export interface ChargeRequest {
  /** The merchant being charged. An identifier; the port stores nothing. */
  readonly businessId: string;
  readonly amount: Price;
  /**
   * The caller's unique name for THIS attempt. Required. Stable across
   * retries of the same attempt, and never reused for a different one.
   */
  readonly idempotencyKey: string;
  /**
   * The provider-side identifier of the payment instrument to charge, as the
   * merchant's own billing setup recorded it. An opaque token: this slice
   * never parses it and never stores instrument data of its own.
   */
  readonly instrumentRef: string;
}

export interface ChargeResult {
  readonly outcome: ChargeOutcome;
  /** The provider's reference for the charge. An identifier, never a payload. */
  readonly providerRef: string;
  /**
   * Set only when `outcome` is `declined` or `failed`. A provider's own code,
   * carried verbatim so support can quote it, and never interpreted as a
   * reason to retry: whether to retry is the dunning policy's decision.
   */
  readonly providerCode?: string;
  /** True when this result is a replay of an earlier call with the same key. */
  readonly replayed: boolean;
}

/**
 * One charge, one adapter.
 *
 * `declined` and `failed` are RESULTS, not exceptions: a decline is an
 * ordinary business outcome the dunning schedule is built to handle, and
 * throwing would push every caller into a catch block that has to
 * re-classify it. An adapter throws only when it could not reach a verdict
 * at all — `billing.provider_unavailable` — because "we do not know whether
 * the money moved" is the one answer a caller must never treat as a decline.
 */
export interface PaymentProviderPort {
  charge(request: ChargeRequest): Promise<ChargeResult>;
}
