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
  'analytics.predicate_not_servable': 422,
  /** An export was asked for while the configuration that bounds it is absent. */
  'analytics.export_unconfigured': 422,
  /** A surface whose integrated upstream does not exist yet. Shows nothing. */
  'analytics.waiting_for_integrated_surface': 503,

  /* ---------------------------------------------------------------- *
   * Loyalty.
   *
   * These lived in a second catalogue inside the loyalty module for as long as
   * it took to notice. One package with two refusal registries is the same
   * defect as one figure with two definitions: a caller cannot tell which
   * registry a code came from, and the day a code appears in both, nothing
   * decides which status wins. Folded here on 2026-10-12, with the loyalty
   * module's names kept as narrowings of this one set rather than as a parallel
   * catalogue.
   * ---------------------------------------------------------------- */

  /** A conversion or earning rate was required and the configuration was absent or empty. */
  'loyalty.unconfigured': 422,
  /** A supplied rate is not a usable positive rational. */
  'loyalty.rate_not_positive': 422,
  /** The award or conversion result is zero; a zero-delta movement has no row. */
  'loyalty.movement_would_be_zero': 422,
  /** Outside the ledger's range. A wrapped balance is a silent wrong number. */
  'loyalty.points_out_of_range': 422,
  /** The movement's sign contradicts its kind's registered sign. */
  'loyalty.sign_violates_kind': 422,
  /** The (source type, kind) pair is not one the least-authority registry admits. */
  'loyalty.source_kind_pair_unregistered': 422,
  /** An adjustment without a reason, where the kind requires one. */
  'loyalty.reason_required': 422,
  /** A horizon on a non-earn row, or a missing one on an earn row. */
  'loyalty.horizon_shape_invalid': 422,
  /** A horizon on or before the day earned — the shape of a horizon-of-zero bug. */
  'loyalty.horizon_not_after_effective': 422,
  /** A correction naming a row that is not in the ledger. */
  'loyalty.correction_target_unknown': 422,
  /** A date that is not a civil date. Refused, never coerced. */
  'loyalty.date_not_civil': 422,
  /** Fewer eligible points than the consumption asks for. */
  'loyalty.insufficient_eligible_points': 422,
  /**
   * A positive movement that is neither an earn nor a registered un-horizoned
   * grant reached the expiry fold.
   *
   * 500, not 422: the caller did not do anything wrong. Such a row means the
   * ledger holds a restoration whose horizon the fold cannot attribute, and
   * the honest answer to "what expires" is then that the fold cannot say —
   * never that nothing does. See `foldExpiry`.
   */
  'loyalty.unattributable_positive_movement': 500,
  /** A reversal named itself, or a movement this ledger does not hold. */
  'loyalty.corrects_unknown_movement': 422,
  'loyalty.corrects_self': 422,
  /** `F-21`: a correction may not give back more than the row it corrects ever took. */
  'loyalty.corrects_more_than_target': 422,
  /** `F-22`: a correction may not be dated before the row it corrects. */
  'loyalty.corrects_out_of_order': 422,
  /** A redemption value or line figure that is not usable integer minor units. */
  'loyalty.allocation_value_invalid': 422,
  /** A redemption with no lines to split across. */
  'loyalty.allocation_no_lines': 422,
  /** A redemption larger than the sale lines can absorb. NEVER clamped: a clamp
   *  would be a money computation this phase does not own. */
  'loyalty.allocation_exceeds_capacity': 422,
  /** The split did not reconcile. This is 500 on purpose — it means this code is
   *  wrong, not that the caller asked for something impossible. */
  'loyalty.allocation_remainder_unplaceable': 500,
  /** An allocation indexed a line that is not there. 500 for the same reason:
   *  the caller cannot cause it, so it means this code is wrong. It exists
   *  because the repository forbids the non-null assertion that would
   *  otherwise paper over exactly this case. */
  'loyalty.allocation_index_out_of_range': 500,
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
