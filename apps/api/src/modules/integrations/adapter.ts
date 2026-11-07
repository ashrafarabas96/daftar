import type { CapabilityFlags } from './capabilities';
import type { ServiceKind } from './service-kinds';
import type { WebhookIdentity } from './webhook/identity';

/** `^[a-z0-9_]+$` — the ADR draft 3.2 fixes this shape, e.g. `whatsapp_cloud`. */
export const ADAPTER_KEY_PATTERN = /^[a-z0-9_]+$/;

/**
 * The two kinds of adapter, which must not be mixed behind one port: a port
 * returning `Promise<void>` would promise a delivery that never happened.
 *
 *   - `delivers`      — the adapter itself delivers over an outbound call, so
 *                       it needs a secret, a queue, a quota, health, a worker.
 *   - `composes-link` — the adapter produces something the USER delivers (the
 *                       `wa.me` link of phase one). It needs none of those, and
 *                       the registry refuses it if it claims any.
 */
export const ADAPTER_MODES = ['delivers', 'composes-link'] as const;

export type AdapterMode = (typeof ADAPTER_MODES)[number];

export function isAdapterMode(value: unknown): value is AdapterMode {
  return typeof value === 'string' && (ADAPTER_MODES as readonly string[]).includes(value);
}

export interface AdapterDescriptor {
  readonly kind: ServiceKind;
  readonly adapterKey: string;
  readonly mode: AdapterMode;
  readonly capabilities: CapabilityFlags;
  /** Names of required secrets, never values. */
  readonly secretSlots: readonly string[];
  /** The adapter declares its egress hosts IN CODE, never in configuration. */
  readonly allowedHosts: readonly string[];
  readonly isTestDouble: boolean;
  /**
   * Whether this adapter's events produce a financial effect.
   *
   * The owner's decision of 2026-11-08 turns on it: a signature scheme that
   * does not bind a timestamp is permitted ONLY where there is no money
   * effect — inbound messages — and forbidden by law where there is, because
   * then the replay store is the sole defence against an unbounded replay of a
   * genuinely signed body.
   *
   * It is a declaration, so the registry checks what it can: the two payment
   * kinds are money by construction and may not declare `false`.
   */
  readonly producesFinancialEvent: boolean;
  /**
   * How THIS provider's identity is read out of a verified webhook body.
   *
   * It lives on the descriptor and not on the call, because the review showed
   * what a free argument costs: an extractor wired to the wrong field — one
   * constant across a provider's events, or one that truncates — returns a
   * well-formed, in-cap string every time, and silently collapses every event
   * of a business onto one key. The first is accepted and the rest are
   * reported as replays, so money events vanish behind a success, and no
   * refusal channel can see it. Here, `eventSource` and the extraction rule
   * are the same descriptor and cannot disagree.
   *
   * Required exactly when the adapter claims a signature scheme, and refused
   * when it does not; the registry enforces both at build time.
   */
  readonly extractWebhookIdentity?: (verifiedBody: Buffer) => WebhookIdentity | undefined;
}
