import type { CapabilityFlags } from './capabilities';
import type { ServiceKind } from './service-kinds';

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
 *                       the registry below refuses it if it claims any.
 */
export type AdapterMode = 'delivers' | 'composes-link';

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
}
