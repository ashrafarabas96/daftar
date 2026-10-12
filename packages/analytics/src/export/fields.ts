/**
 * SCOPED EXPORT FIELD SETS, AND THE CONFIGURATION THAT BOUNDS AN EXPORT.
 *
 * An export is DATA EGRESS, not a read in the ordinary sense. A screen read is
 * bounded by row-level security on every subsequent request; a file is bounded
 * by nothing — the central security mechanism of the estate ends at the
 * download. It also changes the unit: one customer's record on screen is one
 * customer's record, and fourteen thousand of them in a file is a customer
 * list, a different object with a market value. And there is no un-download.
 *
 * Three consequences, which are the whole of this module:
 *
 *   1. IT FAILS CLOSED. An export surface for which ANY ONE of the five
 *      configuration facts is undefined REFUSES, and the refusal names which
 *      fact is missing. The state is read POSITIVELY — `'configured'` or
 *      `'unconfigured'`, with unreadable meaning `'unconfigured'` — because a
 *      fact read by absence is a fact that defaults to permission.
 *
 *   2. THIS MODULE INVENTS NO NUMBER. No row ceiling, no cumulative ceiling, no
 *      retention duration, not even as an illustration beside a mechanism,
 *      because an illustration beside a mechanism is what a later implementer
 *      lifts as a default. The bounds belong to the Performance and Security
 *      owners; the retention period belongs to the owner and to legal. They are
 *      REQUIRED ARGUMENTS here with NO DEFAULTS, and there is no `??` beside a
 *      configuration read anywhere in this file.
 *
 *   3. THE FIELD SET IS EXPLICIT AND CLOSED, and each field CARRIES its own PII
 *      classification as a declared property. A classification a caller has to
 *      remember is a classification the next caller forgets; here it travels on
 *      the field, so the resolved set, the export record and the audit entry
 *      can all refer to one list instead of each guessing.
 *
 * A note on what the ratified-ness of the classification means here: the PII
 * class table is a PROPOSAL to its ratifier, and this module does not promote
 * it. What it does enforce are the two prohibitions that are already rulings
 * rather than proposals: NO SECRET FIELDS, and NO RAW CROSS-TENANT
 * IDENTIFIERS.
 */

import { refuse } from '../errors';

/* ------------------------------------------------------------------------- *
 * The PII classification, as a declared property of a field
 * ------------------------------------------------------------------------- */

export type PiiClass =
  /** Customer name, phone, email, address, national or tax id. Individually opt-in. */
  | 'direct_identifier'
  /**
   * Re-identifies an individual in combination even when no direct identifier
   * is present: an exact document date, a branch, an exact amount. Carried, but
   * COUNTED in the audit entry, because an export of "anonymous" per-row
   * records is not anonymous.
   */
  | 'quasi_identifier'
  /**
   * This phase's own derived figures — recency, frequency, an aged profile, a
   * loyalty balance, a segment membership. Personal data about an identified
   * person, and NOT a lesser class because this phase computed it.
   */
  | 'derived_behavioural'
  /**
   * An aggregate with NO customer-level dimension. The one export class that is
   * an ordinary read, and separating it is what keeps the sensitive
   * classification credible rather than a blanket.
   */
  | 'business_internal_non_personal'
  /**
   * Credential material, tokens, session ids, internal account codes, journal
   * line ids, constraint or routine names. Not a classification question: the
   * ruling forbids secret fields outright. A field in this class can never
   * enter a permitted set, and configuration naming one is itself refused.
   */
  | 'never_exportable';

/** The closed set of fields this phase's export surfaces know how to emit. */
export type ExportFieldKey =
  | 'customer_display_name'
  | 'customer_phone'
  | 'customer_email'
  | 'customer_national_id'
  | 'last_purchase_document_date'
  | 'last_purchase_sale_reference'
  | 'purchase_frequency_sale_count'
  | 'purchase_frequency_return_count'
  | 'branch_display_name'
  | 'aggregate_sale_document_count'
  | 'per_export_opaque_row_token'
  | 'tenant_id'
  | 'customer_id'
  | 'session_token';

export interface ExportField {
  readonly key: ExportFieldKey;
  /** DECLARED, not remembered. Every consumer reads the class off the field. */
  readonly piiClass: PiiClass;
  /**
   * True when the value is a raw identifier that is MEANINGFUL OUTSIDE the
   * exporting business — a tenant id or a cross-business surrogate key. Such a
   * field is never emitted. Where a row must be re-importable it carries a
   * per-export opaque token instead of the platform's own key.
   */
  readonly rawCrossTenantIdentifier: boolean;
  /**
   * True when the field must be named individually in the request. No field is
   * ever included by an "all columns" default, and this module offers no such
   * default to be included by.
   */
  readonly individuallyOptIn: boolean;
}

/**
 * THE CATALOGUE. Explicit and closed: a key that is not here cannot be
 * exported, and a field's treatment is read from here rather than inferred from
 * its name. The forbidden entries are present ON PURPOSE — a prohibition that
 * exists only as the absence of an entry is a prohibition no test can see turn
 * red.
 */
export const EXPORT_FIELD_CATALOGUE: Readonly<Record<ExportFieldKey, ExportField>> = {
  customer_display_name: {
    key: 'customer_display_name',
    piiClass: 'direct_identifier',
    rawCrossTenantIdentifier: false,
    individuallyOptIn: true,
  },
  customer_phone: {
    key: 'customer_phone',
    piiClass: 'direct_identifier',
    rawCrossTenantIdentifier: false,
    individuallyOptIn: true,
  },
  customer_email: {
    key: 'customer_email',
    piiClass: 'direct_identifier',
    rawCrossTenantIdentifier: false,
    individuallyOptIn: true,
  },
  customer_national_id: {
    key: 'customer_national_id',
    piiClass: 'direct_identifier',
    rawCrossTenantIdentifier: false,
    individuallyOptIn: true,
  },
  last_purchase_document_date: {
    key: 'last_purchase_document_date',
    piiClass: 'quasi_identifier',
    rawCrossTenantIdentifier: false,
    individuallyOptIn: true,
  },
  last_purchase_sale_reference: {
    key: 'last_purchase_sale_reference',
    piiClass: 'quasi_identifier',
    rawCrossTenantIdentifier: false,
    individuallyOptIn: true,
  },
  purchase_frequency_sale_count: {
    key: 'purchase_frequency_sale_count',
    piiClass: 'derived_behavioural',
    rawCrossTenantIdentifier: false,
    individuallyOptIn: true,
  },
  purchase_frequency_return_count: {
    key: 'purchase_frequency_return_count',
    piiClass: 'derived_behavioural',
    rawCrossTenantIdentifier: false,
    individuallyOptIn: true,
  },
  branch_display_name: {
    key: 'branch_display_name',
    piiClass: 'quasi_identifier',
    rawCrossTenantIdentifier: false,
    individuallyOptIn: true,
  },
  aggregate_sale_document_count: {
    key: 'aggregate_sale_document_count',
    piiClass: 'business_internal_non_personal',
    rawCrossTenantIdentifier: false,
    individuallyOptIn: true,
  },
  per_export_opaque_row_token: {
    key: 'per_export_opaque_row_token',
    piiClass: 'quasi_identifier',
    rawCrossTenantIdentifier: false,
    individuallyOptIn: true,
  },
  tenant_id: {
    key: 'tenant_id',
    piiClass: 'never_exportable',
    rawCrossTenantIdentifier: true,
    individuallyOptIn: true,
  },
  customer_id: {
    key: 'customer_id',
    piiClass: 'never_exportable',
    rawCrossTenantIdentifier: true,
    individuallyOptIn: true,
  },
  session_token: {
    key: 'session_token',
    piiClass: 'never_exportable',
    rawCrossTenantIdentifier: false,
    individuallyOptIn: true,
  },
};

export const EXPORT_FIELD_KEYS: readonly ExportFieldKey[] = Object.keys(EXPORT_FIELD_CATALOGUE) as ExportFieldKey[];

export function isKnownExportField(key: string): key is ExportFieldKey {
  return Object.prototype.hasOwnProperty.call(EXPORT_FIELD_CATALOGUE, key);
}

/* ------------------------------------------------------------------------- *
 * The refusal of a field that may not leave
 * ------------------------------------------------------------------------- */

export type ExportFieldRefusalReason =
  | 'field_unknown'
  | 'field_not_in_permitted_set'
  | 'field_never_exportable'
  | 'field_is_raw_cross_tenant_identifier'
  | 'field_requested_twice';

/**
 * A field-level export refusal.
 *
 * RECORDED GAP, and a patch request rather than an invention: the refusal
 * catalogue in `src/errors.ts` carries `analytics.export_unconfigured` for the
 * five configuration facts and has NO code for "a field the permitted set does
 * not permit". That file is not this task's to edit, and reusing the
 * configuration code for a field-level refusal would make a declared code mean
 * two different things — which is how a code stops naming anything. So the
 * field-level refusal is its own named, typed, testable failure here, and the
 * request for a catalogue code belongs to the owner of that file.
 */
export class ExportFieldRefusal extends Error {
  readonly reason: ExportFieldRefusalReason;
  readonly field: string;
  readonly httpStatus = 422;

  constructor(reason: ExportFieldRefusalReason, field: string, message: string) {
    super(`${reason}: ${message}`);
    this.name = 'ExportFieldRefusal';
    this.reason = reason;
    this.field = field;
  }
}

/* ------------------------------------------------------------------------- *
 * The five configuration facts
 * ------------------------------------------------------------------------- */

/** Read POSITIVELY. Unreadable is `'unconfigured'`, and `'unconfigured'` refuses. */
export type ExportPolicyState = 'configured' | 'unconfigured';

/**
 * The max-scope bounds. Both values are supplied by the Performance and
 * Security owners. This module names no figure for either, and holds no
 * fallback for either: an absent bound is not an unbounded export, it is a
 * refused one.
 *
 * The count a bound is checked against is the count of the MATERIALISED result,
 * and the materialisation is bounded BEFORE it is produced, so an over-bound
 * export never builds the full result set. An export that must be fully
 * computed to discover it is too large has already paid the cost it was meant
 * to avoid.
 */
export interface ExportMaxScopeConfiguration {
  /** A hard per-export row bound. REFUSED above it, never truncated: a truncated
   *  export is a narrow result carried under a broad name, in file form. */
  readonly perExportRowBound: number;
  /** A per-business, per-window cumulative bound. The thing that distinguishes a
   *  merchant doing their accounts from an extraction. */
  readonly cumulativeRowBound: number;
  /** The window the cumulative bound is measured over. The owners' to calibrate;
   *  carried as the owners' own opaque label so this module states no duration. */
  readonly cumulativeWindowLabel: string;
}

export interface ExportBoundingConfiguration {
  /** FACT 1 — permitted fields, from the classification's ratifier. */
  readonly permittedFields: readonly ExportFieldKey[];
  /** FACT 2 — audience and permission, from the Authority Owner. */
  readonly audiencePermissionKey: string;
  /** FACT 3 — max scope, from the Performance and Security owners. */
  readonly maxScope: ExportMaxScopeConfiguration;
  /** FACT 4 — retention. The owners' own policy identity; no duration is named
   *  here, and `expiresAt` is a SUPPLIED instant, never a clock read. */
  readonly retentionPolicyId: string;
  /** FACT 5 — destination and access model, from the Security owner. A
   *  destination outside the managed, expiring, single-identity lifecycle is not
   *  a configurable option but a refused one, so this is a closed set. */
  readonly destinationAccessModel: 'managed_expiring_single_identity_artifact';
  /** The positive state. `'unconfigured'` refuses even if the fields above look
   *  populated: a surface must not assemble permission out of fragments. */
  readonly policyState: ExportPolicyState;
}

export type ExportConfigurationFact = 'permitted_fields' | 'audience_permission' | 'max_scope' | 'retention' | 'destination_access_model' | 'policy_state';

/**
 * The fail-closed gate. Absent, unreadable or incomplete configuration refuses
 * `analytics.export_unconfigured`, and the refusal NAMES WHICH FACT is missing,
 * because a refusal that does not say what is missing cannot be acted on.
 *
 * `configuration` is typed nullable so that "there is no configuration at all"
 * is a reachable, testable state rather than an unreachable one.
 */
export function requireExportConfiguration(configuration: ExportBoundingConfiguration | null | undefined): ExportBoundingConfiguration {
  if (configuration === null || configuration === undefined) {
    refuseUnconfigured('policy_state', 'no export configuration is readable at all');
  }
  if (configuration.policyState !== 'configured') {
    refuseUnconfigured('policy_state', 'the export policy state is not positively configured');
  }
  if (configuration.permittedFields.length === 0) {
    refuseUnconfigured('permitted_fields', 'no permitted field set has been ratified');
  }
  if (configuration.audiencePermissionKey.trim() === '') {
    refuseUnconfigured('audience_permission', 'no audience or permission key is configured');
  }
  requireMaxScope(configuration.maxScope);
  if (configuration.retentionPolicyId.trim() === '') {
    refuseUnconfigured('retention', 'no retention policy is configured');
  }
  if (configuration.destinationAccessModel !== 'managed_expiring_single_identity_artifact') {
    refuseUnconfigured('destination_access_model', 'the destination is not a managed expiring artifact');
  }

  // The permitted set is itself checked against the two rulings, so a
  // misconfigured permitted set cannot smuggle a forbidden column through a
  // legitimate request. Configuration is input, not authority.
  for (const key of configuration.permittedFields) {
    const field = EXPORT_FIELD_CATALOGUE[key];
    if (field === undefined) {
      refuseUnconfigured('permitted_fields', `the permitted set names an unknown field: ${String(key)}`);
    }
    if (field.piiClass === 'never_exportable') {
      refuseUnconfigured('permitted_fields', `the permitted set names a never-exportable field: ${key}`);
    }
    if (field.rawCrossTenantIdentifier) {
      refuseUnconfigured('permitted_fields', `the permitted set names a raw cross-tenant identifier: ${key}`);
    }
  }

  return configuration;
}

function requireMaxScope(maxScope: ExportMaxScopeConfiguration | null | undefined): void {
  if (maxScope === null || maxScope === undefined) {
    refuseUnconfigured('max_scope', 'no max-scope bounds are configured');
  }
  // Only the SHAPE is judged here. The magnitudes are the owners' and this
  // module neither proposes one nor compares against one of its own.
  if (!Number.isSafeInteger(maxScope.perExportRowBound) || maxScope.perExportRowBound <= 0) {
    refuseUnconfigured('max_scope', 'the per-export row bound is not a positive whole number of rows');
  }
  if (!Number.isSafeInteger(maxScope.cumulativeRowBound) || maxScope.cumulativeRowBound <= 0) {
    refuseUnconfigured('max_scope', 'the cumulative row bound is not a positive whole number of rows');
  }
  if (maxScope.cumulativeWindowLabel.trim() === '') {
    refuseUnconfigured('max_scope', 'the cumulative bound names no window');
  }
}

function refuseUnconfigured(fact: ExportConfigurationFact, message: string): never {
  refuse('analytics.export_unconfigured', `export refused: ${message}`, { missingFact: fact });
}

/* ------------------------------------------------------------------------- *
 * Resolving a scoped field set
 * ------------------------------------------------------------------------- */

export interface ResolvedExportFieldSet {
  /** The explicit, ordered, closed list of fields that will be emitted. */
  readonly fields: readonly ExportField[];
  /**
   * The PII classes present, counted. This is what the export record and the
   * audit entry carry: it answers "what left" without storing what left.
   */
  readonly piiClassCounts: Readonly<Record<PiiClass, number>>;
  /**
   * True when the set carries personal data, which is what makes the export a
   * sensitive act needing explicit confirmation. False only for a set that is
   * entirely business-internal and non-personal.
   */
  readonly carriesPersonalData: boolean;
  /** The bounds this resolution was made under, carried so they cannot be lost. */
  readonly maxScope: ExportMaxScopeConfiguration;
  readonly retentionPolicyId: string;
  readonly audiencePermissionKey: string;
}

/**
 * Resolve a requested field list against the configuration. Every refusal below
 * is reachable and named:
 *
 *   - no configuration, or any one of the five facts missing -> refuses
 *     `analytics.export_unconfigured`, naming the fact;
 *   - an unknown key, a duplicate, a never-exportable field, a raw cross-tenant
 *     identifier, or a field the permitted set does not permit -> refuses with
 *     its own reason.
 *
 * There is no "all fields" branch, by construction: the only way to get a field
 * is to name it and for the configuration to permit it.
 */
export function resolveExportFieldSet(
  requestedFields: readonly string[],
  configuration: ExportBoundingConfiguration | null | undefined,
): ResolvedExportFieldSet {
  const config = requireExportConfiguration(configuration);

  if (requestedFields.length === 0) {
    refuseUnconfigured('permitted_fields', 'an export must name its fields; there is no all-columns default');
  }

  const permitted = new Set<string>(config.permittedFields);
  const seen = new Set<string>();
  const fields: ExportField[] = [];

  for (const requested of requestedFields) {
    if (seen.has(requested)) {
      throw new ExportFieldRefusal('field_requested_twice', requested, 'a field was named more than once');
    }
    seen.add(requested);

    if (!isKnownExportField(requested)) {
      throw new ExportFieldRefusal('field_unknown', requested, 'the field set is closed and this key is not in the catalogue');
    }
    const field = EXPORT_FIELD_CATALOGUE[requested];

    // The cross-tenant rule is judged FIRST, and the order is deliberate: a
    // raw cross-tenant identifier is also never exportable, and the refusal a
    // caller gets should name the more specific reason, which is the one that
    // tells them what to do instead (carry the opaque token).
    if (field.rawCrossTenantIdentifier) {
      throw new ExportFieldRefusal(
        'field_is_raw_cross_tenant_identifier',
        requested,
        'no export column may carry a raw identifier that is meaningful outside the exporting business; a re-importable row carries a per-export opaque token instead',
      );
    }
    if (field.piiClass === 'never_exportable') {
      throw new ExportFieldRefusal('field_never_exportable', requested, 'secret and internal material is never exportable, whatever the configuration says');
    }
    if (!permitted.has(requested)) {
      throw new ExportFieldRefusal('field_not_in_permitted_set', requested, 'the ratified permitted-field set does not include this field');
    }
    fields.push(field);
  }

  const piiClassCounts: Record<PiiClass, number> = {
    direct_identifier: 0,
    quasi_identifier: 0,
    derived_behavioural: 0,
    business_internal_non_personal: 0,
    never_exportable: 0,
  };
  for (const field of fields) {
    piiClassCounts[field.piiClass] += 1;
  }

  const carriesPersonalData = piiClassCounts.direct_identifier > 0 || piiClassCounts.quasi_identifier > 0 || piiClassCounts.derived_behavioural > 0;

  return {
    fields,
    piiClassCounts,
    carriesPersonalData,
    maxScope: config.maxScope,
    retentionPolicyId: config.retentionPolicyId,
    audiencePermissionKey: config.audiencePermissionKey,
  };
}

/**
 * The per-export row bound, applied. The bound is the CALLER'S configured
 * figure; this function supplies none and compares against none of its own. It
 * refuses above the bound rather than truncating, and the refusal carries the
 * configured bound and the actual count so a merchant can narrow the filter
 * themselves.
 *
 * `actualRowCount` is a count of rows and therefore a `number`. No money figure
 * passes through this module at all: a money figure is a `bigint` of minor
 * units and belongs to the metric that owns it.
 */
export function requireRowCountWithinBound(actualRowCount: number, maxScope: ExportMaxScopeConfiguration): void {
  if (!Number.isSafeInteger(actualRowCount) || actualRowCount < 0) {
    refuseUnconfigured('max_scope', 'the materialised row count is not a whole number of rows');
  }
  if (actualRowCount > maxScope.perExportRowBound) {
    throw new ExportBoundExceeded(maxScope.perExportRowBound, actualRowCount);
  }
}

/**
 * Over the configured bound. Its own named failure for the same reason the
 * field-level refusal is: the catalogue has no code for a bound that was
 * configured and then exceeded, and bending the unconfigured code to cover it
 * would make one declared code mean two different things.
 *
 * It carries BOTH figures as decimal strings, so the merchant can narrow the
 * filter themselves and so an audit trail of refusals is readable.
 */
export class ExportBoundExceeded extends Error {
  readonly configuredBound: string;
  readonly actualRowCount: string;
  readonly httpStatus = 422;

  constructor(configuredBound: number, actualRowCount: number) {
    super(
      `export refused: the result exceeds the configured per-export row bound (bound ${String(
        configuredBound,
      )}, actual ${String(actualRowCount)}); it is refused, not truncated`,
    );
    this.name = 'ExportBoundExceeded';
    this.configuredBound = String(configuredBound);
    this.actualRowCount = String(actualRowCount);
  }
}
