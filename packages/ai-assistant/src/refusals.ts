/**
 * DAFTAR Phase 12 — the closed set of assistant refusal codes.
 *
 * P12-S0-ARCHITECTURE-CONTRACT §8: the CODE is the stable identity; the message is presentation.
 * A test may not assert a message string as a proxy for a behaviour — assert the code.
 *
 * STATUS: PREPARED / NOT PROMOTED. Nothing here is wired into a running surface.
 */

export const REFUSAL_CODES = [
  'ai.disabled',
  'ai.not_permitted',
  'ai_stt.unavailable',
  'ai_stt.unintelligible',
  'ai_stt.language_unsupported',
  'ai_intent.schema_invalid',
  'ai_intent.unknown_intent',
  'ai_intent.low_confidence',
  'ai_intent.ambiguous_entity',
  'ai_intent.entity_not_found',
  'ai_intent.unresolved_entity_reference',
  'ai_tool.not_permitted',
  // The tool's authority binding is unresolved (the security authority has not decided it), so the
  // tool is unreachable. Fail-closed, and distinct from 'not_permitted' so the two are never
  // confused in an audit: one means "you lack it", the other means "nobody has decided it".
  'ai_tool.authority_unbound',
  'ai_tool.not_registered',
  'ai_tool.surface_unavailable',
  'ai_tool.args_invalid',
  'ai_draft.not_visible',
  'ai_draft.wrong_state',
  'ai_draft.expired',
  'ai_draft.preview_digest_mismatch',
  'ai_draft.recomputation_diverged',
  'ai_draft.authority_revoked',
  'ai_draft.already_executed',
  'ai_draft.tax_non_zero_refused',
  'ai.injection_suspected',
  'ai.provider_timeout',
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

export function isRefusalCode(value: string): value is RefusalCode {
  return (REFUSAL_CODES as readonly string[]).includes(value);
}

/**
 * A refusal names its code and, where the contract requires it, the exact subject that failed.
 *
 * `field` is NOT decoration: §5.3 requires `ai_draft.recomputation_diverged` to name the diverging
 * field, and §3.4 of the proof plan forbids a test that asserts merely "something refused".
 */
export interface Refusal {
  readonly code: RefusalCode;
  readonly field?: string;
  readonly detail?: string;
}

export function refuse(code: RefusalCode, subject?: { field?: string; detail?: string }): Refusal {
  const r: { code: RefusalCode; field?: string; detail?: string } = { code };
  if (subject?.field !== undefined) r.field = subject.field;
  if (subject?.detail !== undefined) r.detail = subject.detail;
  return r;
}

/** Discriminated result: either a value, or a named refusal. There is no third outcome. */
export type Decision<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: Refusal };

export function allow<T>(value: T): Decision<T> {
  return { ok: true, value };
}

export function deny<T>(refusal: Refusal): Decision<T> {
  return { ok: false, refusal };
}
