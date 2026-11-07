/**
 * INTEGRATIONS CORE — the slices that touch neither the worker's grants nor
 * its secrets.
 *
 * This module is NOT wired into any Nest module, and that is intentional.
 * Composing it into the worker is what `SEC-01` gates, and the owner's
 * instruction for this branch is explicit: implement the slices that touch
 * neither the worker's permissions nor its keys, on a separate branch, with no
 * merge before `SEC-01`. The design's gate order (`S-00` before every
 * implementation slice, `S-0` before `S-1`) is therefore RELEASED for writing
 * and still binding for merging.
 *
 * That release is a message, not a repository fact, and the review was right
 * to say so: it is not recorded in `OWNER_DECISIONS_AR.md`, and that file is a
 * local one this branch cannot reach. Until the coordinator writes the line,
 * the next reader has only this paragraph — so take it as a claim awaiting its
 * record, not as a gate that was found open.
 *
 * What is deliberately ABSENT, and named so it is not mistaken for done:
 *   - the secret store: the webhook gate is HANDED an unsealed key.
 *   - the replay TABLE: only the port and an in-memory double live here.
 *   - the queue insert and worker processing, and the rate limit on the
 *     endpoint (`W-6`).
 *   - the stored health check, and with it the resolver's fifth step.
 *   - `PROVIDER_CONFIG_INVALID`, the second closed code of `IC-01`, and the
 *     descriptor's `configSchema`: both belong to the slice that validates
 *     two-level configuration, and nothing here validates configuration.
 *   - the ledger's own `sourceId` derivation, which is the money lane's.
 *   - the mapping from a provider account reference to a business id, which is
 *     a row this layer never reads: the gate is told which account to expect
 *     and proves the signed bytes name it.
 */
export { SERVICE_KINDS, isServiceKind, type ServiceKind } from './service-kinds';
export { WEBHOOK_SIGNATURE_SCHEMES, isWebhookSignatureScheme, type CapabilityFlags, type WebhookSignatureScheme } from './capabilities';
export { ADAPTER_KEY_PATTERN, ADAPTER_MODES, isAdapterMode, type AdapterDescriptor, type AdapterMode } from './adapter';
export { AdapterRegistry } from './adapter-registry';
export { ProviderResolver, UNAVAILABLE_REASONS, type ProviderFacts, type Resolution, type UnavailableReason } from './provider-resolver';
export {
  IDENTITY_FIELD_PATTERN,
  MAX_IDENTITY_FIELD_LENGTH,
  eventSourceOf,
  isAcceptableIdentityField,
  replayKeyOf,
  type WebhookIdentity,
} from './webhook/identity';
export { InMemoryReplayStore, type RawWebhookRequest, type ReplayStore } from './webhook/replay-store';
export { WebhookGate, WEBHOOK_REJECTIONS, type WebhookGateOptions, type WebhookRejection, type WebhookVerdict } from './webhook/gate';
