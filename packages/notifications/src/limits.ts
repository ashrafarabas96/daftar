/**
 * Provider payload limits and the post-render content gate — Mission §15's
 * "body limits", made a refusal rather than a truncation.
 *
 * Why this is a refusal and never a trim: a notification that carries money is
 * either exactly right or it is refused (`render.ts`). A silently truncated
 * body is a message whose number may have been cut in half, and the recipient
 * cannot tell. A refused one is visible in the ledger with a named code, which
 * an operator can act on.
 *
 * **Provenance, stated narrowly.** The numbers below are the providers' own
 * documented limits as understood when this package was written. They are not
 * DAFTAR business policy (§41 forbids inventing that in source) and they are
 * not measured against a live provider from this container. They are therefore
 * a `ChannelLimits` PORT with a shipped default: the owner confirms the exact
 * figures against the provider's current documentation at promotion, and the
 * refusal path is proven by test regardless of which figure is in force.
 *
 * Mission V2 §15 turns that paragraph into a field. "ChannelLimits must come
 * from approved provider policy", so every `ChannelLimit` must NAME where its
 * figure came from, and a limit with no stated origin is refused rather than
 * applied. The shipped default names itself UNAPPROVED: the day the owner
 * confirms the figures, that approval is an explicit edit here, visible in a
 * diff, instead of a silent drift from "our dev numbers" to "policy".
 */
import { refuse } from './errors';
import type { Channel, RenderedMessage } from './types';

export interface ChannelLimit {
  /**
   * Mission V2 §15. Where this figure comes from — a provider documentation
   * reference, or the owner's approved policy record. Never empty: an
   * unattributed limit silently refuses or admits customer messages on the
   * authority of nobody.
   */
  readonly policySource: string;
  /** Maximum rendered body length, in UTF-16 code units. */
  readonly maxBodyChars: number;
  /**
   * Maximum rendered subject length. Only email transmits a subject; on the
   * other channels the rendered subject is retained for the operator and the
   * in-app list, so it is still bounded — an unbounded one is a rendering
   * defect upstream, not a long message — but the bound is ours, not a
   * provider's, and is deliberately generous rather than zero.
   */
  readonly maxSubjectChars: number;
  /** Maximum length of one approved-template parameter, where the channel uses them. */
  readonly maxTemplateParameterChars?: number;
}

export interface ChannelLimits {
  for(channel: Channel): ChannelLimit;
}

/**
 * The shipped default, for development and for these tests. Deliberately the
 * provider's documented ceiling and not a lower "safe" number of our own: a
 * limit we invented would refuse messages the provider would have accepted,
 * which is its own kind of silent loss. Every entry declares itself UNAPPROVED
 * (Mission V2 §15) and a source law holds it that way until the owner rules.
 */
const UNAPPROVED = 'provider-documentation-2026-10:UNAPPROVED-pending-owner-confirmation';

const DEFAULT: Readonly<Record<Channel, ChannelLimit>> = {
  // WhatsApp Cloud: a template body parameter is bounded well below the
  // message body, and Meta rejects a parameter containing a newline or tab
  // outright — so that is a shape rule, not a length rule, and lives below.
  whatsapp: { policySource: UNAPPROVED, maxBodyChars: 4096, maxSubjectChars: 1024, maxTemplateParameterChars: 1024 },
  // SMS: a concatenated message is bounded by the operator, not by us.
  sms: { policySource: UNAPPROVED, maxBodyChars: 1600, maxSubjectChars: 1024 },
  // Email: the subject bound is the RFC 5322 line-length limit, not a product choice.
  email: { policySource: UNAPPROVED, maxBodyChars: 100_000, maxSubjectChars: 998 },
  // In-app: a local surface. It still has a bound, because an unbounded body
  // is a rendering defect somewhere upstream rather than a long message.
  inapp: { policySource: UNAPPROVED, maxBodyChars: 8192, maxSubjectChars: 200 },
};

export class DefaultChannelLimits implements ChannelLimits {
  for(channel: Channel): ChannelLimit {
    return DEFAULT[channel];
  }
}

/**
 * A parameter allows NO control character at all — not even the three a body
 * may carry. Kept as a named empty set rather than an inline `new Set()` so the
 * intent is legible at the call site and a future edit has to change something
 * named.
 */
const EMPTY_ALLOWED_CONTROLS: ReadonlySet<number> = new Set<number>();

/**
 * Control characters, tested by CODE POINT rather than by a regular
 * expression: a literal control character inside a pattern is itself a lint
 * error (`no-control-regex`), and a law written with an eslint-disable above it
 * is one edit away from being disabled for a different reason.
 *
 * C0 (0x00-0x1F), DEL (0x7F) and C1 (0x80-0x9F) are controls. A BODY may
 * legitimately carry newline, carriage return and tab; a SUBJECT is one line by
 * construction, so none of the three belongs in it either — a newline there is
 * a header-injection vector, not formatting.
 */
const BODY_ALLOWED_CONTROLS: ReadonlySet<number> = new Set([0x09, 0x0a, 0x0d]);

function isControl(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function hasForbiddenControl(text: string, allowed: ReadonlySet<number>): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (isControl(codePoint) && !allowed.has(codePoint)) return true;
  }
  return false;
}

/** Whitespace-only is empty: it renders as a blank message, not as content. */
function isBlank(text: string): boolean {
  return text.trim() === '';
}

/**
 * Enforce the limits on an already-rendered message. Runs after rendering and
 * before anything is handed to a provider, so a refusal here is a refusal to
 * send rather than a provider rejection we could have predicted.
 */
export function assertWithinLimits(rendered: RenderedMessage, limits: ChannelLimits): void {
  const limit = limits.for(rendered.channel);

  // Mission V2 §15: an unattributed limit is not an approved policy, and a
  // figure nobody owns may not decide whether a customer hears about money.
  if (limit.policySource.trim() === '') refuse('notification.limits_policy_unstated', rendered.channel);

  // Mission V2 §15: post-render EMPTY content is refused, not sent. The
  // renderer already refuses a missing variable, so a blank body here means a
  // template whose text is blank — a configuration defect that must surface as
  // a named refusal rather than as a delivered message with nothing in it.
  if (isBlank(rendered.body)) refuse('notification.content_empty', `${rendered.channel}/body`);
  // Only email transmits a subject; on the other channels an empty one is the
  // documented shape (`types.ts`), so emptiness is refused where it is wrong.
  if (rendered.channel === 'email' && isBlank(rendered.subject)) refuse('notification.content_empty', 'email/subject');

  // Mission V2 §15: control characters are refused, never stripped. Stripping
  // would alter the text of a message about money without telling anyone.
  if (hasForbiddenControl(rendered.body, BODY_ALLOWED_CONTROLS)) {
    refuse('notification.content_invalid', `${rendered.channel}/body/control_character`);
  }
  if (hasForbiddenControl(rendered.subject, new Set())) {
    refuse('notification.content_invalid', `${rendered.channel}/subject/control_character`);
  }

  if (rendered.body.length > limit.maxBodyChars) {
    refuse('notification.body_too_long', `${rendered.channel}/body/${rendered.body.length}>${limit.maxBodyChars}`);
  }
  if (rendered.subject.length > limit.maxSubjectChars) {
    refuse('notification.body_too_long', `${rendered.channel}/subject/${rendered.subject.length}>${limit.maxSubjectChars}`);
  }
  const template = rendered.providerTemplate;
  if (template === undefined) return;
  const max = limit.maxTemplateParameterChars;
  for (const [index, parameter] of template.parameters.entries()) {
    if (max !== undefined && parameter.length > max) {
      refuse('notification.parameter_invalid', `${rendered.channel}/param${index}/${parameter.length}>${max}`);
    }
    // The template parameter is the STRICTER surface, not the looser one.
    //
    // The earlier code checked the body with `hasForbiddenControl` and `isBlank`
    // and checked parameters with a three-character regex and `=== ''`. On the
    // WhatsApp Cloud path the body is never transmitted — the payload is built
    // from the template name, locale and parameters — so the strict law covered
    // text that does not leave and the lax one covered the text that does. NUL,
    // C1 and DEL were refused in a body and accepted in a parameter, and a
    // whitespace-only parameter passed the very check whose comment says an
    // empty one "would render an approved template with a hole in it".
    //
    // The refusal code stays `parameter_invalid` rather than becoming the
    // body's `content_invalid`/`content_empty`: it says WHICH surface refused,
    // and the finding was that the parameter check was lax, not that it was
    // named wrongly. Only the strictness changes.
    //
    // `new Set()` allows NOTHING: a parameter is a single value substituted into
    // one line of an approved template, so newline, carriage return and tab do
    // not belong in it either — which is also what `FORBIDDEN_IN_PARAMETER`
    // said, now as the floor rather than the ceiling.
    if (hasForbiddenControl(parameter, EMPTY_ALLOWED_CONTROLS)) {
      refuse('notification.parameter_invalid', `${rendered.channel}/param${index}/control_character`);
    }
    // An empty parameter would render an approved template with a hole in it,
    // and so would a parameter that is only whitespace.
    if (isBlank(parameter)) refuse('notification.parameter_invalid', `${rendered.channel}/param${index}/blank`);
  }
}
