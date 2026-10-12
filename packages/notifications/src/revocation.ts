/**
 * What a consent withdrawal does to work already in flight — High-Velocity V1
 * PART 7.5's "revocation behavior".
 *
 * The two gates in `dispatch.ts` answer the question for a send that has not
 * happened yet. They do not answer it for a delivery row a worker already holds:
 * queued, in flight, scheduled for retry, or ambiguous. That worker needs a rule,
 * and the rule is not "stop everything".
 *
 * **Revocation cancels future sends. It does not rewrite the past.**
 *
 * A withdrawal means "send me nothing more". It cannot mean "un-send what was
 * sent", and — the part that is easy to get wrong — it cannot mean "stop caring
 * what happened". An `unknown` delivery may already have reached the customer;
 * abandoning it on revocation would leave a possibly-delivered message
 * permanently unsettled, so the ledger would stop being able to answer whether
 * the person was contacted. That is a worse outcome for the person withdrawing
 * than for anyone else: their record of what was sent to them goes missing.
 *
 * So reconciliation continues after revocation. It is a status LOOKUP, never a
 * send, which is exactly why it stays lawful when sending has become unlawful.
 */
import type { DeliveryState } from './delivery';
import type { NotificationRefusalCode } from './errors';

export type RevocationVerdict =
  /** Nothing was sent and nothing will be: stop, with a named reason. */
  | { readonly verdict: 'abandon'; readonly code: NotificationRefusalCode }
  /**
   * Something may already have reached the recipient. No send, ever — but the
   * delivery must still be settled by lookup or by a verified callback.
   */
  | { readonly verdict: 'reconcile_only'; readonly reason: string }
  /** Terminal already: there is nothing for revocation to change. */
  | { readonly verdict: 'nothing_to_do' };

/**
 * `code` distinguishes the two withdrawals an operator may need to tell apart,
 * the same pair `dispatch.ts` records at its second gate.
 */
export type RevocationCause = 'consent' | 'eligibility';

export function onRevocation(state: DeliveryState, cause: RevocationCause = 'consent'): RevocationVerdict {
  const code: NotificationRefusalCode = cause === 'consent' ? 'notification.consent_withdrawn' : 'notification.eligibility_withdrawn';
  switch (state) {
    // Nothing has been handed to a provider, or the last attempt was PROVEN not
    // sent. Both stop cleanly, and the ledger says who withdrew what.
    case 'queued':
    case 'retry_scheduled':
      return { verdict: 'abandon', code };
    // An attempt is in flight. We cannot know yet whether the provider has it,
    // so this is the ambiguous case before it is even ambiguous.
    case 'sending':
      return { verdict: 'reconcile_only', reason: 'an attempt was in flight when consent was withdrawn' };
    case 'unknown':
      return { verdict: 'reconcile_only', reason: 'the delivery may already have reached the recipient' };
    // Terminal, in both directions: sent, or finished without sending.
    case 'accepted':
    case 'closed':
    case 'dead':
    case 'withheld':
    case 'suppressed':
      return { verdict: 'nothing_to_do' };
  }
}

/**
 * The property that makes the rule safe to apply from a worker loop: a
 * revocation NEVER authorises a send.
 *
 * Written as an ALLOW-LIST that happens to be empty, rather than as a chain of
 * `!==` comparisons. The difference matters: a chain of inequalities over
 * today's verdicts is a tautology — it can only return false, so a test of it
 * proves nothing — while an empty allow-list is a ratchet. A verdict added later
 * is refused until someone puts it in this list, that addition is visible in a
 * diff, and the test asserting the list is empty goes red when it happens.
 */
const VERDICTS_THAT_PERMIT_A_SEND: readonly RevocationVerdict['verdict'][] = [];

export function revocationAuthorisesASend(verdict: RevocationVerdict): boolean {
  return VERDICTS_THAT_PERMIT_A_SEND.includes(verdict.verdict);
}

/** For the test that asserts the allow-list is still empty. */
export function verdictsThatPermitASend(): readonly string[] {
  return VERDICTS_THAT_PERMIT_A_SEND;
}
