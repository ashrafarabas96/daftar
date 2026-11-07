import { ADAPTER_KEY_PATTERN, isAdapterMode, type AdapterDescriptor } from './adapter';
import { isWebhookSignatureScheme } from './capabilities';
import { isServiceKind } from './service-kinds';
import type { ServiceKind } from './service-kinds';

/**
 * The registry is built FROM CODE at boot and never from rows.
 *
 * The reason is not tidiness. If a row chose the adapter, then editing a row
 * would change where an outbound network call goes, and a host could be
 * injected from the admin panel. Configuration may SELECT a registered
 * adapter; it can never define one.
 *
 * Everything this class refuses, it refuses by THROWING at build time, so a
 * process that would have been wrong does not start. There is no permissive
 * mode and no "skip the bad one" path: a registry that silently dropped a
 * descriptor would resolve to a different adapter than the one configured,
 * which is the fallback this design forbids outright.
 *
 * Every closed set a descriptor claims is checked AT RUNTIME here, not only in
 * the type system. A descriptor reaches this function from compiled code that
 * may have been built against an older shape, and a `mode` the types forbid
 * but the value carries would otherwise walk past both `composes-link` rules
 * and the egress-host rule without a sound.
 */
export class AdapterRegistry {
  private constructor(private readonly byKey: ReadonlyMap<string, AdapterDescriptor>) {}

  static build(descriptors: readonly AdapterDescriptor[], opts: { readonly production: boolean }): AdapterRegistry {
    const byKey = new Map<string, AdapterDescriptor>();
    for (const d of descriptors) {
      if (!isServiceKind(d.kind)) {
        throw new Error(`integrations.registry: unknown service kind ${JSON.stringify(d.kind)}`);
      }
      if (!ADAPTER_KEY_PATTERN.test(d.adapterKey)) {
        throw new Error(`integrations.registry: adapterKey ${JSON.stringify(d.adapterKey)} does not match ${String(ADAPTER_KEY_PATTERN)}`);
      }
      if (!isAdapterMode(d.mode)) {
        throw new Error(`integrations.registry: ${d.kind}/${d.adapterKey} claims an unknown mode ${JSON.stringify(d.mode)}`);
      }
      if (!isWebhookSignatureScheme(d.capabilities.webhookSignatureScheme)) {
        throw new Error(
          `integrations.registry: ${d.kind}/${d.adapterKey} claims an unknown webhook signature scheme ${JSON.stringify(d.capabilities.webhookSignatureScheme)}`,
        );
      }
      if (d.isTestDouble && opts.production) {
        throw new Error(`integrations.registry: ${d.kind}/${d.adapterKey} is a test double and this is production`);
      }
      if (d.mode === 'composes-link' && (d.secretSlots.length > 0 || d.allowedHosts.length > 0)) {
        throw new Error(
          `integrations.registry: ${d.kind}/${d.adapterKey} is composes-link, which needs no secret and makes no outbound call, yet it declares one`,
        );
      }
      if (d.mode === 'delivers' && d.allowedHosts.length === 0) {
        throw new Error(`integrations.registry: ${d.kind}/${d.adapterKey} delivers over the network and must declare its egress hosts in code`);
      }
      const id = AdapterRegistry.id(d.kind, d.adapterKey);
      if (byKey.has(id)) {
        throw new Error(`integrations.registry: ${id} is already registered`);
      }
      byKey.set(id, d);
    }
    return new AdapterRegistry(byKey);
  }

  private static id(kind: ServiceKind, adapterKey: string): string {
    return `${kind}/${adapterKey}`;
  }

  get(kind: ServiceKind, adapterKey: string): AdapterDescriptor | undefined {
    return this.byKey.get(AdapterRegistry.id(kind, adapterKey));
  }

  /** For the status surfaces only; the order is the registration order. */
  list(): readonly AdapterDescriptor[] {
    return [...this.byKey.values()];
  }
}
