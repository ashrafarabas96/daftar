import type { AdapterDescriptor } from './adapter';
import type { AdapterRegistry } from './adapter-registry';
import type { ServiceKind } from './service-kinds';

/**
 * The closed set of reasons a provider is unavailable.
 *
 * TRANSCRIBED VERBATIM from the ADR draft 3.3 and deliberately not extended.
 * The design file records this as `U-10`: the reasons are not named in the
 * design, they are named in the draft, and they are to be carried across
 * literally when the ADR is committed — not coined in an implementation.
 *
 * A measured discrepancy, stated rather than smoothed over: the design calls
 * these "the seven reasons" while the draft lists SIX, for FIVE steps. The
 * step without a reason is the draft's step 5, "is the last health check not
 * `unconfigured`". So the gap is not a miscount in prose — it is a step with
 * no code. That step is therefore ABSENT from `resolve` below rather than
 * given a name, because naming it is the ADR's decision and not this lane's;
 * it is also the one step that needs a stored health row, which belongs to a
 * later slice and a database this layer does not touch.
 */
export const UNAVAILABLE_REASONS = [
  'not_enabled_platform',
  'not_configured_business',
  'secret_missing',
  'entitlement_denied',
  'test_double_in_production',
  'adapter_unknown',
] as const;

export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

/**
 * Every fact the resolver cannot know by itself. They are a port on purpose:
 * each one is a row read in the real system, and keeping them behind this
 * interface is what lets the ORDER of the checks be tested with no database.
 */
export interface ProviderFacts {
  platformEnabled(kind: ServiceKind): boolean;
  selectedAdapterKey(kind: ServiceKind, businessId?: string): string | undefined;
  businessConfigComplete(kind: ServiceKind, businessId: string): boolean;
  secretsPresent(kind: ServiceKind, adapterKey: string, businessId: string): boolean;
  entitlementAllows(kind: ServiceKind, businessId: string): boolean;
}

export type Resolution =
  | { readonly ok: true; readonly descriptor: AdapterDescriptor }
  | { readonly ok: false; readonly code: 'PROVIDER_UNAVAILABLE'; readonly reason: UnavailableReason };

export class ProviderResolver {
  constructor(
    private readonly registry: AdapterRegistry,
    private readonly facts: ProviderFacts,
    private readonly opts: { readonly production: boolean },
  ) {}

  /**
   * The steps run in the draft's order, and the FIRST failure is the answer.
   * Order matters for more than tidiness: a caller that saw `secret_missing`
   * for a kind the platform has switched off would be told to go and configure
   * a secret for a provider it is not allowed to use at all.
   *
   * There is no fallback branch in this method, by construction: the only
   * descriptor it can ever return is the one `selectedAdapterKey` named.
   */
  resolve(kind: ServiceKind, businessId: string): Resolution {
    if (!this.facts.platformEnabled(kind)) return ProviderResolver.no('not_enabled_platform');

    const adapterKey = this.facts.selectedAdapterKey(kind, businessId);
    if (adapterKey === undefined || adapterKey === '') return ProviderResolver.no('not_configured_business');

    const descriptor = this.registry.get(kind, adapterKey);
    if (descriptor === undefined) return ProviderResolver.no('adapter_unknown');

    if (descriptor.isTestDouble && this.opts.production) return ProviderResolver.no('test_double_in_production');

    if (!this.facts.businessConfigComplete(kind, businessId)) return ProviderResolver.no('not_configured_business');

    if (descriptor.secretSlots.length > 0 && !this.facts.secretsPresent(kind, adapterKey, businessId)) {
      return ProviderResolver.no('secret_missing');
    }

    if (!this.facts.entitlementAllows(kind, businessId)) return ProviderResolver.no('entitlement_denied');

    return { ok: true, descriptor };
  }

  private static no(reason: UnavailableReason): Resolution {
    return { ok: false, code: 'PROVIDER_UNAVAILABLE', reason };
  }
}
