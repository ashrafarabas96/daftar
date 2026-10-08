/**
 * DAFTAR Phase 12 — the model/STT provider boundary.
 *
 * TL rulings §69, §70 (TL-P12-R2), §73. The correction this module exists to enforce in code rather
 * than in prose:
 *
 *   "No outbound tool exists" does NOT mean "no data leaves DAFTAR".
 *
 * The model and STT providers are a real, controlled egress boundary. The honest statement has two
 * halves and they are never collapsed into one:
 *
 *   NO MODEL-CONTROLLED ARBITRARY EGRESS  — nothing the model, the tenant's data, or the client says
 *                                           can create a destination, change a host, or pick a
 *                                           provider.
 *   APPROVED PROCESSOR DATA TRANSFER      — the minimized context required for inference does leave,
 *                                           to a server-configured, approved processor.
 *
 * So the residual exfiltration risk is NOT "none". It is "bounded to an approved processor", and the
 * bound is what this module checks.
 *
 * STATUS: PREPARED / NOT PROMOTED. No production provider is approved here; none can be until the
 * owner supplies credentials and the retention/training settings of §70 are configured and recorded.
 */

import { allow, deny, refuse, type Decision } from './refusals';

/**
 * Who asked for a provider. Only `server_config` may ever decide.
 *
 * This enumeration is the point of the module: it makes "the model cannot choose the provider" a
 * value that must be passed and checked, rather than a property of how carefully a call site was
 * written.
 */
export type SelectionSource = 'server_config' | 'model_output' | 'tenant_data' | 'client_request';

export type ProviderKind = 'model' | 'stt';

export interface ProviderSpec {
  readonly id: string;
  readonly kind: ProviderKind;
  /** Exact host. No wildcard, no path, no template, no model-supplied component. */
  readonly host: string;
  readonly scheme: 'https';
  /** `fake` is the deterministic test double; `approved` requires owner credentials and §70 sign-off. */
  readonly state: 'fake' | 'approved';
}

/**
 * The allowlist.
 *
 * Today it holds the deterministic fake only: no production provider is approved, because approval
 * requires credentials the owner holds and the retention/training configuration of §70. That absence
 * is the correct state and is asserted by a test — an empty production allowlist must not read as an
 * oversight.
 */
export const APPROVED_PROVIDERS: readonly ProviderSpec[] = [
  { id: 'fake.deterministic', kind: 'model', host: 'fake.invalid', scheme: 'https', state: 'fake' },
  { id: 'fake.stt.deterministic', kind: 'stt', host: 'fake.invalid', scheme: 'https', state: 'fake' },
];

/**
 * Select a provider.
 *
 * Refuses, in this order: a selection that did not come from server configuration; an id absent from
 * the allowlist; a kind mismatch; a non-TLS scheme. Each refusal is named separately, because
 * "provider rejected" would not tell an auditor whether something tried to *choose* a provider or
 * merely named an unapproved one — and those are different events.
 */
export function selectProvider(
  requestedId: string,
  source: SelectionSource,
  kind: ProviderKind,
  allowlist: readonly ProviderSpec[] = APPROVED_PROVIDERS,
): Decision<ProviderSpec> {
  if (source !== 'server_config') {
    return deny(refuse('ai_provider.selection_not_server_controlled', { field: source, detail: requestedId }));
  }
  const spec = allowlist.find((p) => p.id === requestedId);
  if (spec === undefined) return deny(refuse('ai_provider.not_approved', { detail: requestedId }));
  if (spec.kind !== kind) return deny(refuse('ai_provider.not_approved', { field: 'kind', detail: requestedId }));
  if (spec.scheme !== 'https') return deny(refuse('ai_provider.insecure_transport', { detail: spec.host }));
  return allow(spec);
}

/**
 * Check that a host about to be contacted is exactly an allowlisted host.
 *
 * Exact equality, never a suffix test: `evil-fake.invalid` and `fake.invalid.evil.test` both end or
 * begin with an approved string and neither is the approved host. A suffix or `includes` check here is
 * the classic allowlist bypass.
 */
export function isApprovedHost(host: string, allowlist: readonly ProviderSpec[] = APPROVED_PROVIDERS): boolean {
  return allowlist.some((p) => p.host === host);
}

export function resolveHost(host: string, allowlist: readonly ProviderSpec[] = APPROVED_PROVIDERS): Decision<string> {
  if (!isApprovedHost(host, allowlist)) return deny(refuse('ai_provider.host_not_approved', { detail: host }));
  return allow(host);
}

// ---------------------------------------------------------------------------
// Audit minimization (§71) and retention (§72)
// ---------------------------------------------------------------------------

export interface MinimizedArguments {
  /** The kept fields, by the caller's allowlist. */
  readonly kept: Readonly<Record<string, unknown>>;
  /** The names of fields dropped, so an auditor can see that something was dropped and what. */
  readonly omittedKeys: readonly string[];
}

/**
 * Minimize tool-call arguments before they are persisted.
 *
 * §71: persist only what audit, replay diagnosis and security evidence require. Prefer stable ids over
 * duplicated sensitive text. This keeps an explicit allowlist and records the NAMES of what it
 * dropped — dropping silently would make an audit record that looks complete and is not.
 *
 * Any key whose name matches a credential-ish shape is dropped even if the caller allowlisted it: a
 * secret in an audit row is a defect regardless of who asked for it.
 */
const CREDENTIAL_SHAPED = /secret|token|password|credential|api[_-]?key|authorization|bearer|cookie|private[_-]?key/i;

export function minimizeForAudit(allowedKeys: readonly string[], args: Readonly<Record<string, unknown>>): MinimizedArguments {
  const allowed = new Set(allowedKeys);
  const kept: Record<string, unknown> = {};
  const omitted: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (!allowed.has(key) || CREDENTIAL_SHAPED.test(key)) {
      omitted.push(key);
      continue;
    }
    kept[key] = value;
  }
  return { kept, omittedKeys: omitted };
}

/**
 * Retention of captured content (§72).
 *
 * Audio: off by default, discarded after transcription unless an explicit retention is configured.
 * Transcripts: indefinite retention must not be an accidental default, so `transcriptDays` is
 * `undefined` until the owner configures a policy — and `undefined` means UNCONFIGURED, which blocks
 * production activation rather than meaning "forever".
 *
 * No jurisdiction-specific legal period is invented here. That is the owner's and their counsel's.
 */
export interface RetentionPolicy {
  readonly keepAudio: boolean;
  readonly audioDays?: number;
  readonly transcriptDays?: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { keepAudio: false };

export type RetentionReadiness = { readonly ready: true } | { readonly ready: false; readonly unconfigured: readonly string[] };

/**
 * Is the retention policy configured enough to activate in production?
 *
 * Returns the unconfigured items by name rather than a bare `false`: "not ready" is not actionable,
 * "transcriptDays is unconfigured" is. Audio retention needs a period only when audio is kept.
 */
export function retentionReadiness(policy: RetentionPolicy): RetentionReadiness {
  const unconfigured: string[] = [];
  if (policy.transcriptDays === undefined) unconfigured.push('transcriptDays');
  if (policy.keepAudio && policy.audioDays === undefined) unconfigured.push('audioDays');
  if (unconfigured.length > 0) return { ready: false, unconfigured };
  return { ready: true };
}
