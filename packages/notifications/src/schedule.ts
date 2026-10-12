/**
 * The SCHEDULED trigger path — the half of the catalog that had no entry point.
 *
 * Five catalog kinds declare `trigger.source === 'schedule'` (statements,
 * instalment reminders, daily reports, low-stock alerts), and until now the only
 * way to produce an obligation was `planFromOutboxRow`. So those five kinds were
 * declared, tested as registry entries, and **unreachable**: nothing could fire
 * them. High-Velocity V1 PART 7.5 names "scheduled messaging policies" as Phase
 * 8 scope, and this is the missing surface.
 *
 * Three laws shape it.
 *
 * 1. **§41: no cadence, no lead time and no clock in source.** A schedule's
 *    existence, its cadence and its lead are BUSINESS CONFIGURATION. This module
 *    reads them through a port and invents nothing; an unconfigured or disabled
 *    schedule fires nothing, which is the answer §41 already gave ("unset means
 *    no reminder"). It fails CLOSED: no configuration is a refusal, never a
 *    default.
 * 2. **The occurrence is supplied, never derived.** `occurrenceKey` comes from
 *    the automation layer — the period the run covers — so re-running the same
 *    occurrence yields the same obligation key and the second firing is
 *    `already_owed` rather than a second message. Deriving it from a clock here
 *    would make every re-run a new obligation, which is the duplicate this
 *    package exists to prevent, arriving by a different door.
 * 3. **The two trigger paths do not cross.** A scheduled kind cannot be fired by
 *    an outbox row and an outbox kind cannot be fired by a schedule: each would
 *    be an obligation whose origin lies about where it came from.
 */
import { refuse, type NotificationRefusalCode } from './errors';
import { catalogEntry, scheduledKindsFor, type NotificationKind } from './catalog';
import { originKeyFieldsAreValid } from './identity';
import type { DispatchIntent } from './consumer';

/**
 * What a business configured. Deliberately opaque about cadence: this package
 * never needs to know WHEN the next occurrence is, only that the automation
 * layer was entitled to fire this one.
 */
export interface ScheduleConfiguration {
  readonly scheduleId: string;
  readonly enabled: boolean;
}

/** The port. An adapter reads the business's own schedule configuration. */
export interface ScheduleReader {
  /** `undefined` means "this business configured no such schedule". */
  read(businessId: string, scheduleId: string): ScheduleConfiguration | undefined;
}

export interface ScheduleFiring {
  readonly businessId: string;
  readonly scheduleId: string;
  /** The occurrence this run covers, supplied by the automation layer. */
  readonly occurrenceKey: string;
  /**
   * The ids the hydrator resolves, exactly as an outbox intent carries them.
   * A schedule that covers every customer supplies none, and the hydrator
   * answers with one obligation per recipient — the TL-P8-R1 law.
   */
  readonly subjectRefs?: Readonly<Record<string, string>>;
}

export type SchedulePlan =
  | { readonly plan: 'dispatch'; readonly intents: readonly DispatchIntent[] }
  | { readonly plan: 'refuse'; readonly code: NotificationRefusalCode; readonly detail: string };

/**
 * Plan one firing of one configured schedule.
 *
 * Returns a REFUSAL rather than throwing for the "not configured" case, because
 * it is the normal, expected answer for most businesses and most schedules —
 * recording it is the point, and an exception would make the common path the
 * error path. A malformed firing still throws: that is a caller defect.
 */
export function planFromScheduleFiring(firing: ScheduleFiring, schedules: ScheduleReader): SchedulePlan {
  if (firing.businessId === '') refuse('notification.event_payload_invalid', 'schedule/businessId');
  if (firing.scheduleId === '') refuse('notification.event_payload_invalid', 'schedule/scheduleId');
  // An empty occurrence would collapse every run of this schedule into one
  // obligation key, so the second month's statement would be `already_owed`.
  if (firing.occurrenceKey.trim() === '') refuse('notification.event_payload_invalid', 'schedule/occurrenceKey');

  const kinds = scheduledKindsFor(firing.scheduleId);
  if (kinds.length === 0) {
    return { plan: 'refuse', code: 'notification.kind_unknown', detail: `no kind is bound to ${firing.scheduleId}` };
  }

  // §41, fail closed: the schedule must be configured AND enabled for THIS
  // business. Neither is defaulted, and "nothing recorded" is not "yes".
  const configured = schedules.read(firing.businessId, firing.scheduleId);
  if (configured === undefined) {
    return { plan: 'refuse', code: 'notification.schedule_not_configured', detail: `${firing.scheduleId}/not_configured` };
  }
  if (!configured.enabled) {
    return { plan: 'refuse', code: 'notification.schedule_not_configured', detail: `${firing.scheduleId}/disabled` };
  }
  if (configured.scheduleId !== firing.scheduleId) {
    // A reader that answered about a different schedule is a wiring defect, and
    // acting on it would send one schedule's message under another's policy.
    refuse('notification.schedule_not_configured', `${firing.scheduleId}/configuration_mismatch`);
  }

  const origin = { source: 'schedule', scheduleId: firing.scheduleId, occurrenceKey: firing.occurrenceKey } as const;

  // The occurrence must be able to BE part of an obligation key, and the caller
  // learns that here rather than by having an exception thrown at it from three
  // frames deeper. The second challenge's P1: an ISO occurrence was planned
  // happily and then refused inside `dispatchOne`, outside the try that names
  // outcomes, so one bad occurrence took down a whole monthly batch and nothing
  // was recorded for any recipient. `:` is legal in an occurrence now, but a
  // `|`, `::`, `#` or `@` is not, and a refusal here is a recordable answer.
  const keyFields = originKeyFieldsAreValid(origin);
  if (!keyFields.valid) {
    return { plan: 'refuse', code: 'notification.obligation_key_field_invalid', detail: keyFields.detail };
  }

  const intents: DispatchIntent[] = [];
  for (const kind of kinds) {
    const entry = catalogEntry(kind);
    if (!entry || entry.trigger.source !== 'schedule') refuse('notification.kind_unknown', kind);
    intents.push({
      kind: kind as NotificationKind,
      businessId: firing.businessId,
      subjectRefs: firing.subjectRefs ?? {},
      origin,
    });
  }
  return { plan: 'dispatch', intents };
}
