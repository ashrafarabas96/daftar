import { refuse } from './errors';

/**
 * The ANSWER CONTRACT.
 *
 * Named after the answer and not after a refresh, because this package's
 * financial answers are computed at the moment they are asked and no refresh
 * ever happens for them. An earlier draft of this contract put a `watermark`
 * on every derived answer; that field was a transaction-visibility fact dressed
 * up as a refresh position, and it made a staleness question expressible on a
 * surface that cannot be stale. There are therefore TWO shapes, and the shape
 * is what tells a reader which kind of thing it is holding.
 */

/** A named window. `kind` is required: an unlabelled pair of dates is not a period. */
export interface AnalyticsInterval {
  readonly kind: 'calendar_range' | 'accounting_period' | 'rolling_window';
  readonly from: string;
  readonly to: string;
}

/** Which definition produced the figure, and optionally which version of it. */
export interface SourceDefinitionRef {
  readonly definition: string;
  readonly version?: string;
}

/**
 * How much of the business the answer covers. This replaces the completeness
 * grade an earlier draft carried: three of that grade's four values were
 * unreachable on an on-demand read, and the fourth was really a scope fact.
 * Required, so a client cannot render the answer under a broader name without
 * first discarding a field it was handed.
 */
export type AnalyticsScope =
  | { readonly kind: 'business_wide' }
  | { readonly kind: 'branch_subset'; readonly branchIds: readonly string[]; readonly excludesBusinessLevelRows: true }
  | { readonly kind: 'bounded_set'; readonly size: number };

/** SHAPE A — computed when asked. No watermark, no refreshedAt, no completeness. */
export interface OnDemandProvenance {
  readonly mode: 'on_demand';
  readonly asOf: string;
  readonly interval: AnalyticsInterval;
  readonly sourceDefinition: SourceDefinitionRef;
  readonly scope: AnalyticsScope;
}

/**
 * SHAPE B — a persisted Phase-13-native surface where a refresh really occurred.
 * Only these carry a watermark, because only here is there a refresh position to
 * report. No financial truth is ever persisted into this shape.
 */
export interface RefreshedSurfaceProvenance {
  readonly mode: 'refreshed_surface';
  readonly asOf: string;
  readonly interval: AnalyticsInterval;
  readonly sourceDefinition: SourceDefinitionRef;
  readonly scope: AnalyticsScope;
  readonly watermark: string;
  readonly refreshedAt: string;
  readonly refreshCompleteness: 'COMPLETE' | 'PARTIAL' | 'STALE' | 'UNAVAILABLE';
}

export type AnalyticsProvenance = OnDemandProvenance | RefreshedSurfaceProvenance;

export interface Derived<T> {
  readonly value: T;
  readonly provenance: AnalyticsProvenance;
}

/**
 * A financial answer may only ever travel in SHAPE A. The check exists because
 * the defect this contract was corrected for would otherwise be reintroduced by
 * anyone who found shape B convenient and had a financial figure in hand.
 */
export function assertFinancialAnswerShape(p: AnalyticsProvenance): asserts p is OnDemandProvenance {
  if (p.mode !== 'on_demand') {
    refuse(
      'analytics.scope_narrower_than_requested',
      'a financial answer must carry on-demand provenance; a persisted surface may not stand in for it',
      { mode: p.mode },
    );
  }
}

/** True when the scope is narrower than the name a caller asked under. */
export function scopeIsNarrowerThanBusinessWide(scope: AnalyticsScope): boolean {
  return scope.kind !== 'business_wide';
}

export function requireBusinessWide(scope: AnalyticsScope, requestedName: string): void {
  if (scopeIsNarrowerThanBusinessWide(scope)) {
    refuse('analytics.scope_narrower_than_requested', `${requestedName} was asked for business-wide but the answer covers less`, {
      scope: scope.kind,
    });
  }
}
