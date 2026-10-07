/**
 * The dispatcher: intent → hydrate → consent → render → provider, with every
 * outside dependency injected as a port. This is the whole Phase 8 pipeline,
 * runnable and assertable with no database, no network and no clock.
 *
 * It returns an OUTCOME for every intent — delivered, deferred, suppressed or
 * failed with a retry decision. Nothing is ever dropped without a named reason:
 * a notification that vanishes silently is indistinguishable from one that was
 * never owed.
 */
import { NotificationRefusal, type NotificationRefusalCode } from './errors';
import { catalogEntry } from './catalog';
import type { DispatchIntent } from './consumer';
import { evaluateConsent, type RecipientPreferences } from './preferences';
import { renderNotification } from './render';
import { sendThroughProvider, type NotificationProvider } from './provider';
import { nextStepAfterFailure, type NextStep } from './retry';
import type { Channel, DateFormatter, Locale, MoneyFormatter, Recipient, TemplateVars } from './types';

/** Resolves an intent's display facts from CANONICAL reads. Adapter-supplied. */
export interface NotificationHydrator {
  hydrate(intent: DispatchIntent): Promise<HydratedIntent | undefined>;
}

export interface HydratedIntent {
  readonly recipient: Recipient;
  readonly preferences: RecipientPreferences;
  readonly vars: TemplateVars;
  /** Channels the merchant enabled for this kind, in preference order. */
  readonly channelOrder: readonly Channel[];
}

export type DispatchOutcome =
  | { readonly result: 'delivered'; readonly kind: string; readonly channel: Channel; readonly providerMessageId: string; readonly idempotencyKey: string }
  | { readonly result: 'deferred'; readonly kind: string; readonly channel: Channel; readonly untilMinuteOfDay: number }
  | { readonly result: 'suppressed'; readonly kind: string; readonly channel: Channel; readonly code: NotificationRefusalCode }
  | { readonly result: 'refused'; readonly kind: string; readonly code: NotificationRefusalCode }
  | { readonly result: 'failed'; readonly kind: string; readonly channel: Channel; readonly next: NextStep };

export interface DispatchPorts {
  readonly hydrator: NotificationHydrator;
  readonly provider: NotificationProvider;
  readonly moneyFormatter: MoneyFormatter;
  readonly dateFormatter: DateFormatter;
  /** Supplied, never read from a machine clock (the P4-S7 asOf law). */
  readonly nowMinuteOfDay: number;
  /** Keys already accepted, so a repeated outbox delivery sends nothing twice. */
  readonly alreadySent?: ReadonlySet<string>;
}

function localeOf(recipient: Recipient): Locale {
  return recipient.locale;
}

export async function dispatchIntent(intent: DispatchIntent, ports: DispatchPorts): Promise<readonly DispatchOutcome[]> {
  const entry = catalogEntry(intent.kind);
  if (!entry) return [{ result: 'refused', kind: intent.kind, code: 'notification.kind_unknown' }];

  if (ports.alreadySent?.has(intent.idempotencyKey) === true) {
    return [{ result: 'suppressed', kind: intent.kind, channel: 'inapp', code: 'notification.consent_missing' }];
  }

  const hydrated = await ports.hydrator.hydrate(intent);
  if (!hydrated) return [{ result: 'refused', kind: intent.kind, code: 'notification.hydration_incomplete' }];

  const outcomes: DispatchOutcome[] = [];
  // Channel order is the merchant's preference, intersected with what the kind
  // is allowed to use. Delivery stops at the first channel that succeeds: a
  // receipt is owed once, not once per channel.
  const channels = hydrated.channelOrder.filter((c) => entry.channels.includes(c));
  if (channels.length === 0) {
    return [{ result: 'refused', kind: intent.kind, code: 'notification.channel_not_supported_for_kind' }];
  }

  for (const channel of channels) {
    const consent = evaluateConsent({ consent: entry.consent, channel, preferences: hydrated.preferences, nowMinuteOfDay: ports.nowMinuteOfDay });
    if (consent.decision === 'refuse') {
      outcomes.push({ result: 'suppressed', kind: intent.kind, channel, code: consent.code });
      continue;
    }
    if (consent.decision === 'defer') {
      outcomes.push({ result: 'deferred', kind: intent.kind, channel, untilMinuteOfDay: consent.deferUntilMinuteOfDay });
      continue;
    }

    try {
      const rendered = renderNotification({
        kind: entry.kind,
        locale: localeOf(hydrated.recipient),
        channel,
        vars: hydrated.vars,
        moneyFormatter: ports.moneyFormatter,
        dateFormatter: ports.dateFormatter,
      });
      const sent = await sendThroughProvider(ports.provider, {
        idempotencyKey: `${intent.idempotencyKey}:${channel}`,
        channel,
        to: {
          ...(hydrated.recipient.phoneE164 === undefined ? {} : { phoneE164: hydrated.recipient.phoneE164 }),
          ...(hydrated.recipient.email === undefined ? {} : { email: hydrated.recipient.email }),
        },
        rendered,
      });
      if (sent.accepted) {
        outcomes.push({
          result: 'delivered',
          kind: intent.kind,
          channel,
          providerMessageId: sent.providerMessageId,
          idempotencyKey: `${intent.idempotencyKey}:${channel}`,
        });
        return outcomes;
      }
      outcomes.push({ result: 'failed', kind: intent.kind, channel, next: nextStepAfterFailure(0, sent.code) });
    } catch (err) {
      if (err instanceof NotificationRefusal) {
        outcomes.push({ result: 'suppressed', kind: intent.kind, channel, code: err.code });
        continue;
      }
      throw err;
    }
  }
  return outcomes;
}
