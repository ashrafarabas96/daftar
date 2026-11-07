/**
 * INTEG S-1 — THE REGISTRY AND `ProviderResolver`, WITH NO DATABASE.
 *
 * The design slice (`docs/design/INTEGRATIONS_CORE_DESIGN_AR.md` §3, §13/S-1)
 * says this layer is code plus unit tests and nothing else: the registry is
 * built FROM CODE at boot, configuration only SELECTS a registered adapter,
 * and resolution returns either a ready adapter or ONE reason from a closed
 * set — with no implicit fallback anywhere.
 *
 * The six reasons are transcribed verbatim from the ADR draft 3.3 and are NOT
 * invented here (design `U-10`). The draft names SIX for FIVE steps: its step 5
 * (the stored health check) has no reason code, so that step is deliberately
 * absent from this resolver rather than given a name this lane has no
 * authority to coin. The absence is asserted below so it cannot be forgotten.
 */
import { describe, expect, it } from 'vitest';
import {
  AdapterRegistry,
  ADAPTER_KEY_PATTERN,
  UNAVAILABLE_REASONS,
  SERVICE_KINDS,
  ProviderResolver,
  type AdapterDescriptor,
  type ProviderFacts,
} from '../apps/api/src/modules/integrations';

const CAPS = {
  serverSideIdempotency: false,
  requiresApprovedTemplate: false,
  supportsDeliveryReceipts: false,
  supportsRefund: false,
  supportsPartialRefund: false,
  supportsHostedFields: false,
  webhookSignatureScheme: 'none',
  supportedCountries: [],
  supportedCurrencies: [],
  supportedLocales: [],
} as const;

function delivering(adapterKey: string, over: Partial<AdapterDescriptor> = {}): AdapterDescriptor {
  return {
    kind: 'notification.whatsapp',
    adapterKey,
    mode: 'delivers',
    capabilities: CAPS,
    secretSlots: ['access_token'],
    allowedHosts: ['graph.facebook.com'],
    isTestDouble: false,
    ...over,
  };
}

/** Every fact the resolver cannot know by itself, all answering YES. */
function allowingFacts(selected: string | undefined): ProviderFacts {
  return {
    platformEnabled: () => true,
    selectedAdapterKey: () => selected,
    businessConfigComplete: () => true,
    secretsPresent: () => true,
    entitlementAllows: () => true,
  };
}

describe('the adapter registry is built from code, and refuses what configuration must never be able to say', () => {
  it('rejects an adapterKey outside the fixed pattern', () => {
    expect(ADAPTER_KEY_PATTERN.test('whatsapp_cloud')).toBe(true);
    expect(() => AdapterRegistry.build([delivering('WhatsApp-Cloud')], { production: false })).toThrow(/adapterKey/);
  });

  it('rejects two descriptors claiming the same (kind, adapterKey)', () => {
    expect(() => AdapterRegistry.build([delivering('whatsapp_cloud'), delivering('whatsapp_cloud')], { production: false })).toThrow(/already registered/);
  });

  it('refuses to BOOT in production when a test double is registered', () => {
    const doubles = [delivering('fake_whatsapp', { isTestDouble: true })];
    expect(() => AdapterRegistry.build(doubles, { production: true })).toThrow(/test double/);
    // positive control: the same registry builds outside production, so the
    // throw above is the production gate and not a broken descriptor.
    expect(AdapterRegistry.build(doubles, { production: false }).get('notification.whatsapp', 'fake_whatsapp')).toBeDefined();
  });

  it('refuses a composes-link adapter that declares a secret or an egress host (it needs neither)', () => {
    const base = { mode: 'composes-link', secretSlots: [], allowedHosts: [] } as const;
    expect(AdapterRegistry.build([delivering('wa_me_link', base)], { production: true }).get('notification.whatsapp', 'wa_me_link')).toBeDefined();
    expect(() =>
      AdapterRegistry.build([delivering('wa_me_link', { ...base, secretSlots: ['access_token'] })], {
        production: false,
      }),
    ).toThrow(/composes-link/);
    expect(() => AdapterRegistry.build([delivering('wa_me_link', { ...base, allowedHosts: ['wa.me'] })], { production: false })).toThrow(/composes-link/);
  });

  it('rejects a service kind outside the closed set', () => {
    expect(SERVICE_KINDS).toContain('webhook.inbound');
    expect(() => AdapterRegistry.build([delivering('x', { kind: 'notification.telegram' as never })], { production: false })).toThrow(/service kind/);
  });
});

describe('ProviderResolver returns a ready adapter or one reason, and never a second-best adapter', () => {
  const registry = AdapterRegistry.build([delivering('whatsapp_cloud'), delivering('other_cloud')], {
    production: false,
  });

  it('resolves to the SELECTED adapter when every fact allows it', () => {
    const r = new ProviderResolver(registry, allowingFacts('whatsapp_cloud'), { production: false }).resolve('notification.whatsapp', 'b1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.descriptor.adapterKey).toBe('whatsapp_cloud');
  });

  it('has no fallback: an unregistered selection resolves to adapter_unknown, NOT to the other registered adapter', () => {
    const r = new ProviderResolver(registry, allowingFacts('missing_cloud'), { production: false }).resolve('notification.whatsapp', 'b1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('adapter_unknown');
    // positive control: the registry DOES hold another adapter that a fallback
    // path would have reached, so the assertion above is not vacuous.
    expect(registry.get('notification.whatsapp', 'other_cloud')).toBeDefined();
  });

  it('names each reason from the closed six', () => {
    const facts = allowingFacts('whatsapp_cloud');
    const cases: Array<[Partial<ProviderFacts>, string]> = [
      [{ platformEnabled: () => false }, 'not_enabled_platform'],
      [{ selectedAdapterKey: () => undefined }, 'not_configured_business'],
      [{ businessConfigComplete: () => false }, 'not_configured_business'],
      [{ secretsPresent: () => false }, 'secret_missing'],
      [{ entitlementAllows: () => false }, 'entitlement_denied'],
    ];
    for (const [over, reason] of cases) {
      const r = new ProviderResolver(registry, { ...facts, ...over }, { production: false }).resolve('notification.whatsapp', 'b1');
      expect(r.ok, reason).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe(reason);
        expect(r.code).toBe('PROVIDER_UNAVAILABLE');
      }
    }
  });

  it('reports test_double_in_production when a double is reached in production', () => {
    const prod = AdapterRegistry.build([delivering('fake_whatsapp', { isTestDouble: true })], { production: false });
    const r = new ProviderResolver(prod, allowingFacts('fake_whatsapp'), { production: true }).resolve('notification.whatsapp', 'b1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('test_double_in_production');
  });

  it('is deterministic when several facts fail at once: the EARLIEST step wins', () => {
    const r = new ProviderResolver(
      registry,
      {
        platformEnabled: () => false,
        selectedAdapterKey: () => undefined,
        businessConfigComplete: () => false,
        secretsPresent: () => false,
        entitlementAllows: () => false,
      },
      { production: false },
    ).resolve('notification.whatsapp', 'b1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_enabled_platform');
  });

  it('carries exactly the six reasons of the ADR draft, and no coined seventh', () => {
    expect([...UNAVAILABLE_REASONS].sort()).toEqual(
      ['adapter_unknown', 'entitlement_denied', 'not_configured_business', 'not_enabled_platform', 'secret_missing', 'test_double_in_production'].sort(),
    );
    // the stored-health step has no reason in the draft, so it is absent here.
    expect([...UNAVAILABLE_REASONS].some((r) => r.includes('health'))).toBe(false);
  });
});
