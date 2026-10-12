/**
 * Phase 13's refusal catalogue.
 *
 * Every code here is a REFUSAL, never a degraded answer. The phase reads
 * financial truth from authorities it does not own, so the only two honest
 * outcomes are the authority's figure or a named refusal; a figure with a
 * caveat attached is how a caveat gets dropped on the way to a screen.
 *
 * The status codes follow the repository's existing registries: a refusal the
 * caller could have avoided by asking differently is 422, one about a thing
 * that is not there is 404, one about an upstream that cannot answer right now
 * is 503, and one about authority is left to the authority layer rather than
 * restated here.
 */
export const ANALYTICS_REFUSALS = {
  /** An interval was required and none was supplied. There is no default window. */
  'analytics.interval_required': 422,
  /**
   * A caller named a date range where an accounting period was required. Phase 13
   * never infers a period from two dates: a period is an object the accounting
   * authority owns, with its own status.
   */
  'analytics.period_not_found': 404,
  /**
   * The upstream authority cannot answer as of the requested instant. This is a
   * refusal and not a stale figure, because a stale financial figure rendered
   * without its staleness is indistinguishable from a current one.
   */
  'analytics.upstream_unavailable_at_as_of': 503,
  /**
   * The answer would be computed over a narrower set than the name the caller
   * asked under. `TL-P4-COORD-R22`: a narrow result carried under a broad name
   * is the defect, so the scope travels with the answer or the answer is refused.
   */
  'analytics.scope_narrower_than_requested': 422,
  /** A segment predicate the reader cannot serve inside its cost bound. */
  'analytics.predicate_not_serveable': 422,
  /** An export was asked for while the configuration that bounds it is absent. */
  'analytics.export_unconfigured': 422,
  /** A surface whose integrated upstream does not exist yet. Shows nothing. */
  'analytics.waiting_for_integrated_surface': 503,
} as const;

export type AnalyticsRefusalCode = keyof typeof ANALYTICS_REFUSALS;

/** A refusal carrying its code. Never carries a partial figure alongside it. */
export class AnalyticsRefusal extends Error {
  readonly code: AnalyticsRefusalCode;
  readonly httpStatus: number;
  readonly context: Readonly<Record<string, string>>;

  constructor(code: AnalyticsRefusalCode, message: string, context: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = 'AnalyticsRefusal';
    this.code = code;
    this.httpStatus = ANALYTICS_REFUSALS[code];
    this.context = context;
  }
}

export function refuse(code: AnalyticsRefusalCode, message: string, context?: Readonly<Record<string, string>>): never {
  throw new AnalyticsRefusal(code, message, context);
}
