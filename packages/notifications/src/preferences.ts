/**
 * Consent and quiet hours — the gate every dispatch passes through.
 *
 * Two laws shape it:
 *  1. A TRANSACTIONAL notification is never silently dropped for convenience.
 *     It is refused only by an EXPLICIT opt-out of that channel, and the
 *     in-app channel cannot be opted out at all: it is the recipient's record
 *     that the message existed.
 *  2. MARKETING requires an explicit opt-in. `unset` is a refusal, not a yes.
 *
 * Quiet hours DEFER, never drop. A payment reminder withheld at 03:00 is still
 * owed at 09:00, so the decision carries the minute it becomes deliverable.
 * `nowMinuteOfDay` is SUPPLIED by the caller — this package never reads a clock
 * (the same law P4-S7 applies to `asOf`).
 */
import type { Channel, ConsentClass, Recipient } from './types';
import type { NotificationRefusalCode } from './errors';

export type PreferenceState = 'opted_in' | 'opted_out' | 'unset';

export interface ChannelPreference {
  readonly channel: Channel;
  readonly state: PreferenceState;
}

/** Minutes of day in [0,1440). A window may wrap midnight (e.g. 1320 → 420). */
export interface QuietHours {
  readonly startMinuteOfDay: number;
  readonly endMinuteOfDay: number;
}

export interface RecipientPreferences {
  readonly channels: readonly ChannelPreference[];
  readonly quietHours?: QuietHours;
}

export type ConsentDecision =
  | { readonly decision: 'allow' }
  | {
      readonly decision: 'defer';
      readonly deferUntilMinuteOfDay: number;
      /**
       * Whether that minute is on the NEXT day. A quiet window that wraps
       * midnight (22:00 → 07:00) ends at a minute EARLIER than now, so a
       * scheduler reading a bare minute as "today at 420" fires immediately —
       * inside quiet hours, which is the one thing the deferral exists to
       * prevent. The package stays clock-free: it does not say when 07:00 is,
       * only that this one is tomorrow's.
       */
      readonly deferToNextDay: boolean;
    }
  | { readonly decision: 'refuse'; readonly code: NotificationRefusalCode };

function stateOf(prefs: RecipientPreferences, channel: Channel): PreferenceState {
  // Defensive against a JS adapter that omits the list: an absent list means
  // "nothing recorded", which is `unset` — never a crash in the gate that
  // decides whether a customer hears about their money.
  const channels = prefs.channels ?? [];
  return channels.find((c) => c.channel === channel)?.state ?? 'unset';
}

function inQuietWindow(minute: number, q: QuietHours): boolean {
  const { startMinuteOfDay: s, endMinuteOfDay: e } = q;
  if (s === e) return false; // a zero-width window silences nothing
  return s < e ? minute >= s && minute < e : minute >= s || minute < e;
}

export interface ConsentRequest {
  readonly consent: ConsentClass;
  readonly channel: Channel;
  readonly preferences: RecipientPreferences;
  readonly nowMinuteOfDay: number;
}

export function evaluateConsent(req: ConsentRequest): ConsentDecision {
  const { consent, channel, preferences, nowMinuteOfDay } = req;
  if (!Number.isInteger(nowMinuteOfDay) || nowMinuteOfDay < 0 || nowMinuteOfDay >= 1440) {
    return { decision: 'refuse', code: 'notification.consent_missing' };
  }
  const state = stateOf(preferences, channel);

  // The in-app record is not optional and is never quiet-houred: it is read
  // when the recipient opens the app, not pushed at them.
  if (channel === 'inapp') return { decision: 'allow' };

  if (consent === 'marketing') {
    if (state !== 'opted_in') return { decision: 'refuse', code: 'notification.consent_missing' };
  } else if (state === 'opted_out') {
    return { decision: 'refuse', code: 'notification.channel_blocked' };
  }

  const q = preferences.quietHours;
  if (q && inQuietWindow(nowMinuteOfDay, q)) {
    const until = q.endMinuteOfDay % 1440;
    // `until <= now` can only happen for a window that wrapped midnight, and
    // then the end is tomorrow's. Derived from the two numbers rather than from
    // a clock, so the package still reads no time.
    return { decision: 'defer', deferUntilMinuteOfDay: until, deferToNextDay: until <= nowMinuteOfDay };
  }
  return { decision: 'allow' };
}

/**
 * Mission §15 — LIVE consent, not a snapshot.
 *
 * "An audit consent snapshot is not a lasting send right after withdrawal."
 * So consent is never carried on the obligation and handed to the sender; it is
 * READ through this port, once when the obligation is enqueued and **again
 * immediately before every send and every retry**. A recipient who opts out
 * between the two reads is not sent to, and the ledger says why.
 *
 * The port is synchronous on purpose: an adapter may hold a short-lived cache
 * behind it, but the decision to send is taken from whatever this returns at
 * that moment, so the staleness window is the adapter's stated contract rather
 * than an accident of when the obligation happened to be created.
 */
export interface ConsentReader {
  read(recipient: Recipient): RecipientPreferences;
}

/** Which read this is. It changes the refusal code, never the verdict. */
export type ConsentStage = 'enqueue' | 'send';
