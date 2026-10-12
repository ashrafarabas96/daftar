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
// One tenant per inference call — Mission §19
// ---------------------------------------------------------------------------

/**
 * A piece of context about to be sent for inference, tagged with whose data it is.
 *
 * Mission §19 forbids *"سياق مختلط بين المستأجرين"* — mixed tenant context. The tag is on every
 * fragment rather than on the request as a whole, because the request's own label is exactly what a
 * mixing bug would leave correct: a batching layer, a shared cache, or a "recent items" helper
 * contributes one foreign fragment while the request still says it belongs to one tenant.
 */
export interface ContextFragment {
  readonly tenantId: string;
  readonly businessId: string;
  readonly label: string;
}

/**
 * Assert that everything being sent belongs to exactly the acting tenant and business.
 *
 * Refuses on a foreign fragment, **naming the fragment's label** rather than reporting that something
 * was mixed — the latter is unactionable, and an auditor needs to know which path contributed it. Also
 * refuses an empty context: there is nothing to send, and a call with nothing to reason about is a
 * defect upstream rather than a cheap success here (PART 17).
 */
export function assertSingleTenantContext(
  actor: { readonly tenantId: string; readonly businessId: string },
  fragments: readonly ContextFragment[],
): Decision<true> {
  if (fragments.length === 0) {
    return deny(refuse('ai_provider.tenant_context_mixed', { detail: 'empty context — nothing to send, which is an upstream defect' }));
  }
  // The ACTOR is checked first, and this is not defensive noise. Mission V2 §19 asks to prove that
  // every fragment *carries* a tenant and a business, and an equality test alone does not: if the
  // acting identity were itself blank, blank fragments would compare equal and the whole check would
  // pass while nothing was scoped to anyone. A comparison is only as strong as both of its sides.
  if (actor.tenantId.trim().length === 0 || actor.businessId.trim().length === 0) {
    return deny(refuse('ai_provider.tenant_context_mixed', { field: 'actor', detail: 'acting identity carries no tenant or business' }));
  }
  for (const fragment of fragments) {
    if (fragment.tenantId.trim().length === 0 || fragment.businessId.trim().length === 0) {
      return deny(refuse('ai_provider.tenant_context_mixed', { field: fragment.label, detail: 'fragment carries no tenant or business' }));
    }
    if (fragment.tenantId !== actor.tenantId || fragment.businessId !== actor.businessId) {
      return deny(
        refuse('ai_provider.tenant_context_mixed', {
          field: fragment.label,
          detail: `${fragment.tenantId}/${fragment.businessId} is not the acting ${actor.tenantId}/${actor.businessId}`,
        }),
      );
    }
  }
  return allow(true);
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

// ---------------------------------------------------------------------------
// Redirects — PART 75 of the 2026-10-12 directive
// ---------------------------------------------------------------------------

/**
 * A redirect response from an approved provider host.
 *
 * PART 75: **PROVIDER HTTP REDIRECTS ARE REFUSED.** A redirect is not followed automatically from an
 * approved host to another destination, and the preferred posture is no redirects at all.
 *
 * Why this is a boundary rule and not a transport detail: a redirect is the one mechanism by which an
 * *approved* host can hand the request to an unapproved one — the allowlist was satisfied on the first
 * hop, and every check already passed. An HTTP client that follows redirects by default (most do)
 * turns an exact-host allowlist into an allowlist on the first hop only.
 */
export interface RedirectResponse {
  readonly fromHost: string;
  readonly status: 301 | 302 | 303 | 307 | 308;
  readonly locationHost: string;
}

/**
 * The default and preferred behaviour: refuse, naming both hosts.
 *
 * The refusal names where it was going as well as where it came from, because "a redirect was
 * refused" does not tell an auditor whether infrastructure moved or something tried to redirect the
 * request at a destination of its choosing.
 */
export function refuseRedirect(redirect: RedirectResponse): Decision<never> {
  return deny(
    refuse('ai_provider.redirect_refused', {
      field: redirect.fromHost,
      detail: `${String(redirect.status)} -> ${redirect.locationHost}`,
    }),
  );
}

/** What may be carried to a redirect destination, if a redirect is ever permitted at all. */
export interface RedirectForwarding {
  readonly body: boolean;
  readonly authorization: boolean;
}

export const FORWARD_NOTHING: RedirectForwarding = { body: false, authorization: false };

/**
 * The conditional path PART 75 allows only "if infrastructure ever requires redirect": the destination
 * is revalidated against the exact allowlist BEFORE any body or credential is forwarded, and an
 * authorization header is never forwarded to an unapproved redirected origin.
 *
 * `allowRedirects` defaults to false, so the ordinary call refuses — the permissive path must be asked
 * for explicitly at a call site a reviewer can find, rather than being the behaviour you get by not
 * thinking about it.
 *
 * Note what this returns when it does permit: a forwarding decision, not a destination to call. Even a
 * revalidated redirect to an approved host forwards nothing by default, and the caller must still have
 * a reason for each thing it carries.
 */
export function evaluateRedirect(
  redirect: RedirectResponse,
  options: { readonly allowRedirects?: boolean; readonly allowlist?: readonly ProviderSpec[] } = {},
): Decision<RedirectForwarding> {
  const allowRedirects = options.allowRedirects ?? false;
  if (!allowRedirects) return refuseRedirect(redirect);
  const allowlist = options.allowlist ?? APPROVED_PROVIDERS;
  // Revalidation happens here, before anything is forwarded. An unapproved origin gets neither the
  // body nor the credential, and the request does not proceed at all.
  if (!isApprovedHost(redirect.locationHost, allowlist)) return refuseRedirect(redirect);
  return allow(FORWARD_NOTHING);
}
