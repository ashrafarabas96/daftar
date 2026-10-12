/**
 * Provider payload limits — Mission §15's "body limits", made a refusal rather
 * than a truncation.
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
 */
import { refuse } from './errors';
import type { Channel, RenderedMessage } from './types';

export interface ChannelLimit {
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
 * The shipped default. Deliberately the provider's documented ceiling and not
 * a lower "safe" number of our own: a limit we invented would refuse messages
 * the provider would have accepted, which is its own kind of silent loss.
 */
const DEFAULT: Readonly<Record<Channel, ChannelLimit>> = {
  // WhatsApp Cloud: a template body parameter is bounded well below the
  // message body, and Meta rejects a parameter containing a newline or tab
  // outright — so that is a shape rule, not a length rule, and lives below.
  whatsapp: { maxBodyChars: 4096, maxSubjectChars: 1024, maxTemplateParameterChars: 1024 },
  // SMS: a concatenated message is bounded by the operator, not by us.
  sms: { maxBodyChars: 1600, maxSubjectChars: 1024 },
  // Email: the subject bound is the RFC 5322 line-length limit, not a product choice.
  email: { maxBodyChars: 100_000, maxSubjectChars: 998 },
  // In-app: a local surface. It still has a bound, because an unbounded body
  // is a rendering defect somewhere upstream rather than a long message.
  inapp: { maxBodyChars: 8192, maxSubjectChars: 200 },
};

export class DefaultChannelLimits implements ChannelLimits {
  for(channel: Channel): ChannelLimit {
    return DEFAULT[channel];
  }
}

/** A template parameter may not carry a newline or a tab: Meta refuses it. */
const FORBIDDEN_IN_PARAMETER = /[\n\r\t]/;

/**
 * Enforce the limits on an already-rendered message. Runs after rendering and
 * before anything is handed to a provider, so a refusal here is a refusal to
 * send rather than a provider rejection we could have predicted.
 */
export function assertWithinLimits(rendered: RenderedMessage, limits: ChannelLimits): void {
  const limit = limits.for(rendered.channel);
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
    if (FORBIDDEN_IN_PARAMETER.test(parameter)) {
      refuse('notification.parameter_invalid', `${rendered.channel}/param${index}/control_character`);
    }
    // An empty parameter would render an approved template with a hole in it.
    if (parameter === '') refuse('notification.parameter_invalid', `${rendered.channel}/param${index}/empty`);
  }
}
