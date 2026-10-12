/**
 * The dispatcher: intent → hydrate recipients → ENQUEUE gate → render →
 * SEND gate → provider, with every outside dependency injected as a port. This
 * is the whole Phase 8 pipeline, runnable and assertable with no database, no
 * network and no clock.
 *
 * TL-P8-R2 shapes its spine, in three layers that never collapse into one
 * string:
 *
 *   obligation  = origin + kind + recipient    one per person owed
 *   delivery    = obligation + channel [+ template]   stable across retries
 *   attempt     = delivery + attempt number    audit only
 *
 * One intent can owe MANY recipients, and each is independently identifiable:
 * ten recipients are ten obligation keys, ten ledger rows, ten outcomes. No
 * recipient disappears behind the event that triggered them (TL-P8-R1).
 *
 * TWO GATES, not one (Mission §15). Consent and channel eligibility are read
 * LIVE at enqueue, and read LIVE AGAIN immediately before every send and every
 * retry. A consent snapshot taken when the obligation was created is an audit
 * record; it is not a lasting right to send to someone who has since withdrawn.
 * That is why `ConsentReader` is a port and why no preference travels on the
 * hydrated obligation.
 *
 * PART 44/46 and Mission §15 shape its endings. A send has three outcomes, not
 * two, and neither of the two that may already have reached the provider
 * permits anything further for this obligation:
 *
 *   - `unknown`  — it may have arrived. No resend, and NO next channel.
 *   - `rejected` whose next action is `retry` — the SAME delivery will be tried
 *     again, so a different channel now would be the second message Mission §15
 *     forbids ("no channel fallback that yields two messages").
 *   - `rejected` whose next action is `stop` (dead, proven not sent, nothing
 *     further will be attempted) — the next channel may be tried, because
 *     exactly one message can result.
 *
 * A channel refused BEFORE any provider call (consent, eligibility, address,
 * render, limits) may always fall through: nothing was sent.
 *
 * Every path ends in a NAMED outcome. A notification that vanished without a
 * reason is indistinguishable from one that was never owed — and Mission §15
 * requires that a notification failure never cancel a successful sale or
 * payment, yet never be silent either. This package cannot cancel anything: it
 * holds no transaction and no rollback. Being heard is the part it owes.
 */
import { NotificationRefusal, refuse, type NotificationRefusalCode } from './errors';
import { catalogEntry } from './catalog';
import type { DispatchIntent } from './consumer';
import { attemptIdentity, deliveryKey, obligationKey } from './identity';
import { evaluateConsent, type ConsentReader, type ConsentStage } from './preferences';
import type { ChannelEligibility } from './eligibility';
import { assertWithinLimits, DefaultChannelLimits, type ChannelLimits } from './limits';
import { renderNotification } from './render';
import { sendThroughProvider, type NotificationProvider } from './provider';
import { blocksAnotherChannel, classifySend, type DeliveryAction, type DeliveryState } from './delivery';
import { backoffSeconds, MAX_ATTEMPTS } from './retry';
import { recipientId, type Channel, type DateFormatter, type MoneyFormatter, type Recipient, type TemplateVars } from './types';

/**
 * Resolves an intent into ONE ENTRY PER RECIPIENT, from canonical reads.
 * Returning an empty list means "nobody is owed this" — a legitimate answer,
 * distinct from `undefined`, which means "I could not read what I needed".
 *
 * Note what is NOT here: consent. A hydrated obligation carries the facts to
 * render and the channels the merchant enabled, never a permission to send.
 */
export interface NotificationHydrator {
  hydrate(intent: DispatchIntent): Promise<readonly HydratedObligation[] | undefined>;
}

export interface HydratedObligation {
  readonly recipient: Recipient;
  readonly vars: TemplateVars;
  /** Channels the merchant enabled for this kind, in preference order. */
  readonly channelOrder: readonly Channel[];
}

export type DispatchOutcome =
  | {
      readonly result: 'delivered';
      readonly kind: string;
      readonly obligation: string;
      readonly delivery: string;
      readonly channel: Channel;
      readonly attempt: string;
      readonly providerMessageId: string;
      readonly state: DeliveryState;
    }
  | {
      readonly result: 'deferred';
      readonly kind: string;
      readonly obligation: string;
      readonly channel: Channel;
      readonly untilMinuteOfDay: number;
      /** True when that minute is tomorrow's — see `deferToNextDay`. */
      readonly untilNextDay: boolean;
      readonly stage: ConsentStage;
    }
  | {
      readonly result: 'suppressed';
      readonly kind: string;
      readonly obligation: string;
      readonly channel: Channel;
      readonly code: NotificationRefusalCode;
      readonly detail?: string;
      /** Which gate refused it: the enqueue read or the read before the send. */
      readonly stage?: ConsentStage;
    }
  | { readonly result: 'refused'; readonly kind: string; readonly obligation?: string; readonly code: NotificationRefusalCode }
  | { readonly result: 'already_owed'; readonly kind: string; readonly obligation: string }
  | {
      readonly result: 'failed';
      readonly kind: string;
      readonly obligation: string;
      readonly delivery: string;
      readonly channel: Channel;
      readonly attempt: string;
      readonly state: DeliveryState;
      readonly next: DeliveryAction;
    }
  /**
   * PART 44. The provider may or may not have sent it. Not a failure, not a
   * delivery, and NOT finished: `state` is `unknown` (open work) and `next` is
   * `reconcile`. Nothing downstream may read this as a reason to send anything.
   */
  | {
      readonly result: 'unknown';
      readonly kind: string;
      readonly obligation: string;
      readonly delivery: string;
      readonly channel: Channel;
      readonly attempt: string;
      readonly reason: string;
      readonly state: DeliveryState;
      readonly next: DeliveryAction;
    }
  /**
   * Mission §15. A channel the dispatcher deliberately did NOT try, because an
   * earlier channel of this obligation has an attempt that may still land.
   * Named rather than omitted: a channel that silently vanished looks like a
   * channel that was never configured.
   */
  | {
      readonly result: 'withheld';
      readonly kind: string;
      readonly obligation: string;
      readonly channel: Channel;
      readonly code: NotificationRefusalCode;
      readonly detail: string;
    };

export interface DispatchPorts {
  readonly hydrator: NotificationHydrator;
  readonly provider: NotificationProvider;
  /**
   * Mission §15: the LIVE consent read. Required — there is no snapshot to fall
   * back on, by design.
   */
  readonly consent: ConsentReader;
  /** §40/PART 48: required. An unconfigured deployment refuses external channels. */
  readonly eligibility: ChannelEligibility;
  readonly moneyFormatter: MoneyFormatter;
  readonly dateFormatter: DateFormatter;
  /** Provider payload limits. Defaults to the shipped table. */
  readonly limits?: ChannelLimits;
  /** Supplied, never read from a machine clock (the P4-S7 asOf law). */
  readonly nowMinuteOfDay: number;
  /**
   * Obligation keys the ledger already holds. This is what makes a repeated
   * outbox delivery — and a whole-event retry caused by a DIFFERENT sink's
   * failure (§38/PART 47) — produce no second external message.
   */
  readonly obligationsAlreadyRecorded?: ReadonlySet<string>;
  /**
   * Attempts already made per LOGICAL DELIVERY key, so attempt numbers stay
   * dense across retries of the same intended send.
   */
  readonly attemptsSoFar?: ReadonlyMap<string, number>;
  readonly maxAttempts?: number;
}

/** §39/PART 48: the recipient must belong to the business the obligation names. */
function assertRecipientBelongs(intent: DispatchIntent, recipient: Recipient): void {
  if (recipient.businessId !== intent.businessId) {
    refuse('notification.recipient_business_mismatch', `${intent.kind}/${recipient.ref.kind}`);
  }
}

type GateVerdict =
  | { readonly verdict: 'allow' }
  | { readonly verdict: 'defer'; readonly untilMinuteOfDay: number; readonly untilNextDay: boolean }
  | { readonly verdict: 'refuse'; readonly code: NotificationRefusalCode; readonly detail?: string };

/**
 * The gate, run at BOTH stages against a fresh read. The verdict is identical
 * either way; only the refusal code differs, so that an operator can tell "was
 * never permitted" from "was withdrawn between enqueue and send" — which are
 * different facts about the recipient and want different follow-up.
 */
function evaluateGate(stage: ConsentStage, intent: DispatchIntent, owed: HydratedObligation, channel: Channel, ports: DispatchPorts): GateVerdict {
  const entry = catalogEntry(intent.kind);
  if (!entry) return { verdict: 'refuse', code: 'notification.kind_unknown' };

  // LIVE read, at this moment, for this stage. Never a value carried in.
  const preferences = ports.consent.read(owed.recipient);
  const consent = evaluateConsent({ consent: entry.consent, channel, preferences, nowMinuteOfDay: ports.nowMinuteOfDay });
  if (consent.decision === 'refuse') {
    return { verdict: 'refuse', code: stage === 'send' ? 'notification.consent_withdrawn' : consent.code, detail: consent.code };
  }
  if (consent.decision === 'defer') {
    return { verdict: 'defer', untilMinuteOfDay: consent.deferUntilMinuteOfDay, untilNextDay: consent.deferToNextDay };
  }

  // §40/PART 48: internal consent is not provider or legal permission. Asked
  // for every channel, and `inapp` is answered `eligible` by the port itself —
  // the dispatcher does not carve out an exception it cannot see.
  const eligible = ports.eligibility.evaluate({ channel, kind: entry.kind, consent: entry.consent, recipient: owed.recipient });
  if (!eligible.eligible) {
    return {
      verdict: 'refuse',
      code: stage === 'send' ? 'notification.eligibility_withdrawn' : 'notification.channel_not_eligible',
      detail: eligible.reason,
    };
  }
  return { verdict: 'allow' };
}

async function dispatchOne(intent: DispatchIntent, owed: HydratedObligation, ports: DispatchPorts): Promise<readonly DispatchOutcome[]> {
  const entry = catalogEntry(intent.kind);
  if (!entry) return [{ result: 'refused', kind: intent.kind, code: 'notification.kind_unknown' }];

  // The tenant in the key comes from the INTENT, not from the hydrated
  // recipient. The recipient's `businessId` is a claim made by the hydrator,
  // and `assertRecipientBelongs` below is what proves it matches; keying on it
  // would let a hydrator file an obligation under any tenant it named, which is
  // the cross-tenant mixing this key was given a tenant to prevent.
  const obligation = obligationKey(intent.businessId, intent.origin, intent.kind, owed.recipient.ref);

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

  const limits = ports.limits ?? new DefaultChannelLimits();
  const maxAttempts = ports.maxAttempts ?? MAX_ATTEMPTS;
  const outcomes: DispatchOutcome[] = [];

  /**
   * Set once an attempt has been made that may still result in a message —
   * an ambiguous send, or a rejection whose same-delivery retry is scheduled.
   * From then on no further channel is tried for this obligation.
   */
  let pendingDelivery: { readonly channel: Channel; readonly why: string } | undefined;

  for (const channel of channels) {
    if (pendingDelivery !== undefined) {
      outcomes.push({
        result: 'withheld',
        kind: intent.kind,
        obligation,
        channel,
        code: 'notification.channel_withheld_pending_delivery',
        detail: `${pendingDelivery.channel} ${pendingDelivery.why}`,
      });
      continue;
    }

    // GATE 1 — enqueue. A live read, before anything is rendered or sent.
    const atEnqueue = evaluateGate('enqueue', intent, owed, channel, ports);
    if (atEnqueue.verdict === 'refuse') {
      outcomes.push({
        result: 'suppressed',
        kind: intent.kind,
        obligation,
        channel,
        code: atEnqueue.code,
        stage: 'enqueue',
        ...(atEnqueue.detail === undefined ? {} : { detail: atEnqueue.detail }),
      });
      continue;
    }
    if (atEnqueue.verdict === 'defer') {
      outcomes.push({
        result: 'deferred',
        kind: intent.kind,
        obligation,
        channel,
        untilMinuteOfDay: atEnqueue.untilMinuteOfDay,
        untilNextDay: atEnqueue.untilNextDay,
        stage: 'enqueue',
      });
      continue;
    }

    try {
      const rendered = renderNotification({
        kind: entry.kind,
        locale: owed.recipient.locale,
        channel,
        vars: owed.vars,
        moneyFormatter: ports.moneyFormatter,
        dateFormatter: ports.dateFormatter,
      });
      // Mission §15: body limits are a refusal, before the provider sees it.
      assertWithinLimits(rendered, limits);

      // GATE 2 — immediately before the send. (NOT "before every retry": there
      // is no retry driver here, and the resume worker owes that call. See
      // `preferences.ts`.) Rendering
      // and the provider handshake both take time; a withdrawal inside that
      // window is a withdrawal, not a race we are entitled to ignore.
      const atSend = evaluateGate('send', intent, owed, channel, ports);
      if (atSend.verdict === 'refuse') {
        outcomes.push({
          result: 'suppressed',
          kind: intent.kind,
          obligation,
          channel,
          code: atSend.code,
          stage: 'send',
          ...(atSend.detail === undefined ? {} : { detail: atSend.detail }),
        });
        continue;
      }
      if (atSend.verdict === 'defer') {
        outcomes.push({
          result: 'deferred',
          kind: intent.kind,
          obligation,
          channel,
          untilMinuteOfDay: atSend.untilMinuteOfDay,
          untilNextDay: atSend.untilNextDay,
          stage: 'send',
        });
        continue;
      }

      // TL-P8-R2 (2). The approved template name is the stable provider context
      // where the provider has one; it is a property of (kind, locale), so it
      // does not move between retries of the same intended send.
      const delivery = deliveryKey(obligation, channel, rendered.providerTemplate?.name);
      const attemptsMade = ports.attemptsSoFar?.get(delivery) ?? 0;
      const attempt = attemptIdentity(delivery, attemptsMade + 1);

      const sent = await sendThroughProvider(ports.provider, {
        // The STABLE key goes to the provider; the attempt key is audit only.
        deliveryKey: delivery,
        attemptKey: attempt,
        channel,
        to: {
          ...(owed.recipient.phoneE164 === undefined ? {} : { phoneE164: owed.recipient.phoneE164 }),
          ...(owed.recipient.email === undefined ? {} : { email: owed.recipient.email }),
        },
        rendered,
      });

      const classified = classifySend({
        result: sent,
        providerServerSideIdempotency: ports.provider.serverSideIdempotency,
        attemptsMade: attemptsMade + 1,
        maxAttempts,
        backoffSeconds,
      });

      if (sent.outcome === 'accepted') {
        outcomes.push({
          result: 'delivered',
          kind: intent.kind,
          obligation,
          delivery,
          channel,
          attempt,
          providerMessageId: sent.providerMessageId,
          state: classified.state,
        });
        return outcomes; // one obligation is owed once, not once per channel
      }

      if (sent.outcome === 'unknown') {
        outcomes.push({
          result: 'unknown',
          kind: intent.kind,
          obligation,
          delivery,
          channel,
          attempt,
          reason: sent.reason,
          state: classified.state,
          next: classified.next,
        });
        // FULL STOP for this obligation. Trying the next channel here would be
        // a second notification for a message that may already have arrived.
        return outcomes;
      }

      outcomes.push({
        result: 'failed',
        kind: intent.kind,
        obligation,
        delivery,
        channel,
        attempt,
        state: classified.state,
        next: classified.next,
      });
      // Mission §15: "no channel fallback that yields two messages". A retry of
      // THIS delivery is scheduled, so a message may still arrive on this
      // channel; another channel now would make two. A `dead` delivery is
      // different — proven not sent, and nothing further will be attempted —
      // so the next channel may be tried and exactly one message can result.
      //
      // The decision is `blocksAnotherChannel`'s, not this loop's. It used to
      // be `classified.next.action === 'retry'` here, a second copy of the
      // rule: the challenger found that `blocksAnotherChannel` — the rule
      // Mission V3 corrected, and the application-side twin of the partial
      // unique index — had NO caller in `src/` at all, so the rule that was
      // fixed was not the rule that ran. They agreed by coincidence. Now the
      // index, the spec and this loop are one rule, and correcting it once
      // corrects it everywhere.
      if (blocksAnotherChannel({ state: classified.state })) {
        pendingDelivery = { channel, why: `is in state ${classified.state}, which still holds the obligation` };
      }
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
    //
    // Mission V2 §15 — and the header of this file — say every obligation ends
    // in a NAMED outcome. This path used to `continue` silently, so a hydrator
    // that duplicated a recipient produced one fewer outcome than obligations
    // with nothing saying why: exactly the "vanished without a reason" case the
    // law forbids, in the one place the law itself did not read.
    if (seen.has(key)) {
      outcomes.push({ result: 'already_owed', kind: intent.kind, obligation: obligationKey(intent.businessId, intent.origin, intent.kind, one.recipient.ref) });
      continue;
    }
    seen.add(key);
    outcomes.push(...(await dispatchOne(intent, one, ports)));
  }
  return outcomes;
}
