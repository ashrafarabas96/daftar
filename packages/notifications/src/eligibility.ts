/**
 * §40 — CHANNEL ELIGIBILITY GATE.
 *
 * The internal consent class answers one question: does DAFTAR consider this
 * message owed to this person? It does NOT answer whether the provider or the
 * law permits that message on that channel. Those are different authorities and
 * they say no for different reasons:
 *
 *  - WhatsApp will refuse a non-template message outside the 24-hour service
 *    window, and refuses a template that is not approved for the category.
 *  - SMS and email carry jurisdiction-specific rules about what may be sent
 *    without prior consent, and about which hours.
 *
 * So "transactional" is NEVER on its own a licence to use an external channel.
 * The dispatcher consults this port for every external channel, after the
 * internal consent gate and before anything is handed to a provider. There is
 * no default implementation in this package: a policy DAFTAR has not been given
 * is not a policy this package may invent (§94). An adapter that has no rule
 * yet should say so by refusing, not by allowing.
 *
 * The in-app channel does not pass through here: it is a local read surface, not
 * an external dispatch.
 */
import type { CatalogEntry } from './catalog';
import type { Channel, Recipient } from './types';

export interface EligibilityRequest {
  readonly channel: Channel;
  readonly kind: CatalogEntry['kind'];
  readonly consent: CatalogEntry['consent'];
  readonly recipient: Recipient;
}

export type EligibilityDecision =
  | { readonly eligible: true }
  /** A stable, safe reason for the log and for the operator. Never provider prose. */
  | { readonly eligible: false; readonly reason: string };

export interface ChannelEligibility {
  evaluate(request: EligibilityRequest): EligibilityDecision;
}

/**
 * The only built-in implementation: it refuses every external channel, and says
 * why. It is what an unconfigured deployment gets, so an unconfigured
 * deployment sends nothing externally rather than guessing a legal position.
 */
export class RefuseExternalChannels implements ChannelEligibility {
  evaluate(request: EligibilityRequest): EligibilityDecision {
    if (request.channel === 'inapp') return { eligible: true };
    return { eligible: false, reason: 'no channel eligibility policy is configured' };
  }
}
