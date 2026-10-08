/**
 * The dispatcher: intent → hydrate recipients → consent → channel eligibility →
 * render → provider, with every outside dependency injected as a port. This is
 * the whole Phase 8 pipeline, runnable and assertable with no database, no
 * network and no clock.
 *
 * TL-P8-R1 shapes its spine. One intent can owe MANY recipients, and each one
 * is an independently identifiable obligation: ten recipients are ten
 * obligation keys, ten ledger rows, ten outcomes. No recipient disappears
 * behind the event that triggered them.
 *
 * Every path ends in a NAMED outcome. A notification that vanished without a
 * reason is indistinguishable from one that was never owed.
 */
import { NotificationRefusal, refuse, type NotificationRefusalCode } from './errors';
import { catalogEntry } from './catalog';
import type { DispatchIntent } from './consumer';
import { attemptIdentity, obligationKey } from './identity';
import { evaluateConsent, type RecipientPreferences } from './preferences';
import type { ChannelEligibility } from './eligibility';
import { renderNotification } from './render';
import { sendThroughProvider, type NotificationProvider } from './provider';
import { nextStepAfterFailure, type NextStep } from './retry';
import { recipientId, type Channel, type DateFormatter, type MoneyFormatter, type Recipient, type TemplateVars } from './types';

/**
 * Resolves an intent into ONE ENTRY PER RECIPIENT, from canonical reads.
 * Returning an empty list means "nobody is owed this" — a legitimate answer,
 * distinct from `undefined`, which means "I could not read what I needed".
 */
export interface NotificationHydrator {
  hydrate(intent: DispatchIntent): Promise<readonly HydratedObligation[] | undefined>;
}

export interface HydratedObligation {
  readonly recipient: Recipient;
  readonly preferences: RecipientPreferences;
  readonly vars: TemplateVars;
  /** Channels the merchant enabled for this kind, in preference order. */
  readonly channelOrder: readonly Channel[];
}

export type DispatchOutcome =
  | {
      readonly result: 'delivered';
      readonly kind: string;
      readonly obligation: string;
      readonly channel: Channel;
      readonly attempt: string;
      readonly providerMessageId: string;
    }
  | { readonly result: 'deferred'; readonly kind: string; readonly obligation: string; readonly channel: Channel; readonly untilMinuteOfDay: number }
  | {
      readonly result: 'suppressed';
      readonly kind: string;
      readonly obligation: string;
      readonly channel: Channel;
      readonly code: NotificationRefusalCode;
      readonly detail?: string;
    }
  | { readonly result: 'refused'; readonly kind: string; readonly obligation?: string; readonly code: NotificationRefusalCode }
  | { readonly result: 'already_owed'; readonly kind: string; readonly obligation: string }
  | {
      readonly result: 'failed';
      readonly kind: string;
      readonly obligation: string;
      readonly channel: Channel;
      readonly attempt: string;
      readonly next: NextStep;
    };

export interface DispatchPorts {
  readonly hydrator: NotificationHydrator;
  readonly provider: NotificationProvider;
  /** §40: required. An unconfigured deployment refuses external channels. */
  readonly eligibility: ChannelEligibility;
  readonly moneyFormatter: MoneyFormatter;
  readonly dateFormatter: DateFormatter;
  /** Supplied, never read from a machine clock (the P4-S7 asOf law). */
  readonly nowMinuteOfDay: number;
  /**
   * Obligation keys the ledger already holds. This is what makes a repeated
   * outbox delivery — and a whole-event retry caused by a DIFFERENT sink's
   * failure (§38) — produce no second external message.
   */
  readonly obligationsAlreadyRecorded?: ReadonlySet<string>;
  /** Attempts already made per obligation+channel, so attempt ids stay dense. */
  readonly attemptsSoFar?: ReadonlyMap<string, number>;
}

/** §39: the recipient must belong to the business the obligation names. */
function assertRecipientBelongs(intent: DispatchIntent, recipient: Recipient): void {
  if (recipient.businessId !== intent.businessId) {
    refuse('notification.recipient_business_mismatch', `${intent.kind}/${recipient.ref.kind}`);
  }
}

async function dispatchOne(intent: DispatchIntent, owed: HydratedObligation, ports: DispatchPorts): Promise<readonly DispatchOutcome[]> {
  const entry = catalogEntry(intent.kind);
  if (!entry) return [{ result: 'refused', kind: intent.kind, code: 'notification.kind_unknown' }];

  const obligation = obligationKey(intent.origin, intent.kind, owed.recipient.ref);

  try {
    assertRecipientBelongs(intent, owed.recipient);
  } catch (err) {
    if (err instanceof NotificationRefusal) return [{ result: 'refused', kind: intent.kind, obligation, code: err.code }];
    throw err;
  }

  if (ports.obligationsAlreadyRecorded?.has(obligation) === true) {
    return [{ result: 'already_owed', kind: intent.kind, obligation }];
  }

  const channels = owed.channelOrder.filter((c) => entry.channels.includes(c));
  if (channels.length === 0) {
    return [{ result: 'refused', kind: intent.kind, obligation, code: 'notification.channel_not_supported_for_kind' }];
  }

  const outcomes: DispatchOutcome[] = [];
  for (const channel of channels) {
    const consent = evaluateConsent({ consent: entry.consent, channel, preferences: owed.preferences, nowMinuteOfDay: ports.nowMinuteOfDay });
    if (consent.decision === 'refuse') {
      outcomes.push({ result: 'suppressed', kind: intent.kind, obligation, channel, code: consent.code });
      continue;
    }
    if (consent.decision === 'defer') {
      outcomes.push({ result: 'deferred', kind: intent.kind, obligation, channel, untilMinuteOfDay: consent.deferUntilMinuteOfDay });
      continue;
    }

    // §40: internal consent is not provider or legal permission. Asked for
    // every channel, and `inapp` is answered `eligible` by the port itself —
    // the dispatcher does not carve out an exception it cannot see.
    const eligible = ports.eligibility.evaluate({ channel, kind: entry.kind, consent: entry.consent, recipient: owed.recipient });
    if (!eligible.eligible) {
      outcomes.push({ result: 'suppressed', kind: intent.kind, obligation, channel, code: 'notification.channel_not_eligible', detail: eligible.reason });
      continue;
    }

    const attemptNo = (ports.attemptsSoFar?.get(`${obligation}#${channel}`) ?? 0) + 1;
    const attempt = attemptIdentity(obligation, channel, attemptNo);

    try {
      const rendered = renderNotification({
        kind: entry.kind,
        locale: owed.recipient.locale,
        channel,
        vars: owed.vars,
        moneyFormatter: ports.moneyFormatter,
        dateFormatter: ports.dateFormatter,
      });
      const sent = await sendThroughProvider(ports.provider, {
        idempotencyKey: attempt,
        channel,
        to: {
          ...(owed.recipient.phoneE164 === undefined ? {} : { phoneE164: owed.recipient.phoneE164 }),
          ...(owed.recipient.email === undefined ? {} : { email: owed.recipient.email }),
        },
        rendered,
      });
      if (sent.accepted) {
        outcomes.push({ result: 'delivered', kind: intent.kind, obligation, channel, attempt, providerMessageId: sent.providerMessageId });
        return outcomes; // one obligation is owed once, not once per channel
      }
      outcomes.push({ result: 'failed', kind: intent.kind, obligation, channel, attempt, next: nextStepAfterFailure(attemptNo - 1, sent.code) });
    } catch (err) {
      if (err instanceof NotificationRefusal) {
        outcomes.push({ result: 'suppressed', kind: intent.kind, obligation, channel, code: err.code });
        continue;
      }
      throw err;
    }
  }
  return outcomes;
}

/** Dispatch every obligation this intent owes. One entry per recipient. */
export async function dispatchIntent(intent: DispatchIntent, ports: DispatchPorts): Promise<readonly DispatchOutcome[]> {
  const entry = catalogEntry(intent.kind);
  if (!entry) return [{ result: 'refused', kind: intent.kind, code: 'notification.kind_unknown' }];

  const owed = await ports.hydrator.hydrate(intent);
  if (owed === undefined) return [{ result: 'refused', kind: intent.kind, code: 'notification.hydration_incomplete' }];

  const outcomes: DispatchOutcome[] = [];
  const seen = new Set<string>();
  for (const one of owed) {
    const key = `${one.recipient.ref.kind}:${recipientId(one.recipient.ref)}`;
    // A hydrator that returns the same recipient twice would otherwise send
    // twice: the obligation key is identical, so the second is already owed.
    if (seen.has(key)) continue;
    seen.add(key);
    outcomes.push(...(await dispatchOne(intent, one, ports)));
  }
  return outcomes;
}
