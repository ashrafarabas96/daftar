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
 * and still binding for merging — a written owner release, not a gate this
 * lane decided to step over. The ADR is still uncommitted, which is why every
 * transcription here cites the draft it came from.
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
 */
export { SERVICE_KINDS, isServiceKind, type ServiceKind } from './service-kinds';
export { WEBHOOK_SIGNATURE_SCHEMES, isWebhookSignatureScheme, type CapabilityFlags, type WebhookSignatureScheme } from './capabilities';
export { ADAPTER_KEY_PATTERN, ADAPTER_MODES, isAdapterMode, type AdapterDescriptor, type AdapterMode } from './adapter';
export { AdapterRegistry } from './adapter-registry';
export { ProviderResolver, UNAVAILABLE_REASONS, type ProviderFacts, type Resolution, type UnavailableReason } from './provider-resolver';
export {
  EXTERNAL_EVENT_ID_PATTERN,
  InMemoryReplayStore,
  MAX_EXTERNAL_EVENT_ID_LENGTH,
  isAcceptableExternalEventId,
  replayKeyOf,
  type RawWebhookRequest,
  type ReplayStore,
} from './webhook/replay-store';
export { WebhookGate, WEBHOOK_REJECTIONS, type WebhookGateOptions, type WebhookRejection, type WebhookVerdict } from './webhook/gate';
