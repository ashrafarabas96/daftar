/**
 * INTEGRATIONS CORE — the slices that touch neither the worker's grants nor
 * its secrets.
 *
 * This module is NOT wired into any Nest module, and that is intentional, not
 * an oversight. Composing it into the worker is what `SEC-01` gates, and the
 * owner's instruction for this branch is that nothing here merges before that
 * remedy. So the layer exists, is tested, and is reachable only from tests
 * until the composition slice runs.
 *
 * What is deliberately ABSENT, and named so it is not mistaken for done:
 *   - the secret store (`S-4`): the webhook gate is HANDED an unsealed key.
 *   - the replay TABLE: only the port and an in-memory double live here.
 *   - the queue insert and worker processing (`W-5`).
 *   - the stored health check, and with it the resolver's fifth step.
 */
export { SERVICE_KINDS, isServiceKind, type ServiceKind } from './service-kinds';
export { WEBHOOK_SIGNATURE_SCHEMES, type CapabilityFlags, type WebhookSignatureScheme } from './capabilities';
export { ADAPTER_KEY_PATTERN, type AdapterDescriptor, type AdapterMode } from './adapter';
export { AdapterRegistry } from './adapter-registry';
export { ProviderResolver, UNAVAILABLE_REASONS, type ProviderFacts, type Resolution, type UnavailableReason } from './provider-resolver';
export { InMemoryReplayStore, replayKeyOf, type RawWebhookRequest, type ReplayStore } from './webhook/replay-store';
export { WebhookGate, WEBHOOK_REJECTIONS, type WebhookGateOptions, type WebhookRejection, type WebhookVerdict } from './webhook/gate';
