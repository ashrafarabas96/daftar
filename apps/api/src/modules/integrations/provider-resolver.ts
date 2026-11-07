import type { AdapterDescriptor } from './adapter';
import type { AdapterRegistry } from './adapter-registry';
import type { ServiceKind } from './service-kinds';

/**
 * The closed set of reasons a provider is unavailable. SEVEN, and every one of
 * them transcribed, not coined.
 *
 * Six come from the ADR draft 3.3. The seventh is `quota_exceeded`, and it is
 * named in the lane's own card — `.local-context/drafts/INTEGRATIONS_CORE_CARD_AR.md`
 * line 25 ("the closed unavailable reasons (ADR 3.3) + a `quota exceeded`
 * reason"), deliverable 7 at line 57 ("a stable reason, `quota exceeded`"),
 * acceptance A-3 at line 72 ("a test per reason — 7 reasons once `quota
 * exceeded` is counted"), and line 113 ("6 in the ADR + `quota exceeded`").
 *
 * An earlier version of this file guessed that the design's "seven" and the
 * draft's six differed over the stored HEALTH check. That was wrong, and the
 * review caught it: the seventh was named all along in a file this lane had
 * not read, and reasoning from the draft alone produced a confident account of
 * a document's gap that the document next to it fills. The health observation
 * is separately TRUE — the draft's step 5 has no reason code of its own — but
 * it is not the missing seventh, and it is recorded below as what it is.
 */
export const UNAVAILABLE_REASONS = [
  'not_enabled_platform',
  'not_configured_business',
  'secret_missing',
  'entitlement_denied',
  'quota_exceeded',
  'test_double_in_production',
  'adapter_unknown',
] as const;

export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

/**
 * Every fact the resolver cannot know by itself. They are a port on purpose:
 * each one is a row read in the real system, and keeping them behind this
 * interface is what lets the ORDER of the checks be tested with no database.
 *
 * `quotaAllows` is fail-closed by contract, and the contract is the caller's
 * to honour: `IC-04` and `DR-32` rule that a business with NO configured limit
 * is refused rather than waved through, so an implementation that cannot find
 * a limit returns false. The distinct `quota_limits_missing` code that surface
 * owes a 409 belongs to the quota slice, not to this closed set.
 */
export interface ProviderFacts {
  platformEnabled(kind: ServiceKind): boolean;
  selectedAdapterKey(kind: ServiceKind, businessId?: string): string | undefined;
  businessConfigComplete(kind: ServiceKind, businessId: string): boolean;
  secretsPresent(kind: ServiceKind, adapterKey: string, businessId: string): boolean;
  entitlementAllows(kind: ServiceKind, businessId: string): boolean;
  quotaAllows(kind: ServiceKind, businessId: string): boolean;
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
   * The steps run in the draft's order, with the card's quota step last, and
   * the FIRST failure is the answer.
   *
   * Order matters for more than tidiness: a caller told `secret_missing` for a
   * kind the platform has switched off would go and configure a secret for a
   * provider it may not use at all.
   *
   * There is no fallback branch in this method, by construction: the only
   * descriptor it can ever return is the one `selectedAdapterKey` named.
   *
   * NOT HERE, and named rather than silently missing: the draft's step 5, "is
   * the last health check not `unconfigured`". It has no reason code in the
   * draft, and inventing one is the ADR's decision; it also needs a stored
   * health row, which is a later slice and a database this layer never reads.
   * The second closed code of `IC-01`, `PROVIDER_CONFIG_INVALID`, and the
   * descriptor's `configSchema` are likewise absent: both belong to the
   * two-level settings slice that validates configuration, and nothing here
   * validates configuration.
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

    if (!this.facts.quotaAllows(kind, businessId)) return ProviderResolver.no('quota_exceeded');

    return { ok: true, descriptor };
  }

  private static no(reason: UnavailableReason): Resolution {
    return { ok: false, code: 'PROVIDER_UNAVAILABLE', reason };
  }
}
