/**
 * Tests for the scoped export field sets.
 *
 * The named RED PROOFS are the point: an export with absent configuration must
 * refuse, and an export attempting a raw cross-tenant identifier must refuse.
 * Each asserts the specific refusal code or reason, and names the missing fact
 * or the offending field.
 */

import { describe, expect, it } from 'vitest';

import { AnalyticsRefusal } from '../src/errors';
import {
  EXPORT_FIELD_CATALOGUE,
  EXPORT_FIELD_KEYS,
  ExportBoundExceeded,
  ExportFieldRefusal,
  isKnownExportField,
  requireExportConfiguration,
  requireRowCountWithinBound,
  resolveExportFieldSet,
  type ExportBoundingConfiguration,
  type ExportFieldKey,
  type ExportMaxScopeConfiguration,
} from '../src/export/fields';

/**
 * Every configuration figure below is a TEST FIXTURE, supplied here because the
 * module requires it and holds no default of its own. None of these numbers is
 * a proposed production bound: the production figures belong to the Performance
 * and Security owners, and the module reads them as required arguments.
 */
const FIXTURE_MAX_SCOPE: ExportMaxScopeConfiguration = {
  perExportRowBound: 7,
  cumulativeRowBound: 11,
  cumulativeWindowLabel: 'owner-calibrated-window',
};

const PERMITTED: readonly ExportFieldKey[] = [
  'customer_display_name',
  'customer_phone',
  'last_purchase_document_date',
  'purchase_frequency_sale_count',
  'aggregate_sale_document_count',
  'per_export_opaque_row_token',
];

function configured(overrides: Partial<ExportBoundingConfiguration> = {}): ExportBoundingConfiguration {
  return {
    permittedFields: PERMITTED,
    audiencePermissionKey: 'reports.export',
    maxScope: FIXTURE_MAX_SCOPE,
    retentionPolicyId: 'owner-ratified-retention-policy',
    destinationAccessModel: 'managed_expiring_single_identity_artifact',
    policyState: 'configured',
    ...overrides,
  };
}

/* ========================================================================= *
 * The catalogue is explicit and closed, and carries its own classification
 * ========================================================================= */

describe('the export field catalogue', () => {
  it('is non-empty, and every entry declares its own PII class and cross-tenant status', () => {
    expect(EXPORT_FIELD_KEYS.length).toBe(14);
    for (const key of EXPORT_FIELD_KEYS) {
      const field = EXPORT_FIELD_CATALOGUE[key];
      expect(field.key).toBe(key);
      expect(typeof field.piiClass).toBe('string');
      expect(typeof field.rawCrossTenantIdentifier).toBe('boolean');
      // No field is ever included by an all-columns default, so every field
      // must say it is individually opt-in.
      expect(field.individuallyOptIn).toBe(true);
    }
  });

  it('classifies this phase own derived figures as personal data, not as a lesser class', () => {
    expect(EXPORT_FIELD_CATALOGUE.purchase_frequency_sale_count.piiClass).toBe('derived_behavioural');
    expect(EXPORT_FIELD_CATALOGUE.purchase_frequency_return_count.piiClass).toBe('derived_behavioural');
  });

  it('classifies an aggregate with no customer dimension as non-personal', () => {
    expect(EXPORT_FIELD_CATALOGUE.aggregate_sale_document_count.piiClass).toBe('business_internal_non_personal');
  });

  it('declares the forbidden entries rather than omitting them, so the prohibition can turn red', () => {
    expect(EXPORT_FIELD_CATALOGUE.tenant_id.rawCrossTenantIdentifier).toBe(true);
    expect(EXPORT_FIELD_CATALOGUE.customer_id.rawCrossTenantIdentifier).toBe(true);
    expect(EXPORT_FIELD_CATALOGUE.session_token.piiClass).toBe('never_exportable');
  });

  it('is closed: an unknown key is not a field', () => {
    expect(isKnownExportField('customer_display_name')).toBe(true);
    expect(isKnownExportField('everything')).toBe(false);
    expect(isKnownExportField('toString')).toBe(false);
  });
});

/* ========================================================================= *
 * RED PROOF — absent configuration refuses, naming the missing fact
 * ========================================================================= */

describe('RED PROOF: an export with absent configuration refuses', () => {
  function expectUnconfigured(run: () => unknown, missingFact: string): void {
    try {
      run();
      expect.unreachable('an unbounded export must be a refused export, not an unbounded one');
    } catch (error) {
      expect(error).toBeInstanceOf(AnalyticsRefusal);
      const refusal = error as AnalyticsRefusal;
      expect(refusal.code).toBe('analytics.export_unconfigured');
      expect(refusal.httpStatus).toBe(422);
      expect(refusal.context.missingFact).toBe(missingFact);
    }
  }

  it('refuses when there is no configuration at all', () => {
    expectUnconfigured(() => resolveExportFieldSet(['customer_display_name'], null), 'policy_state');
    expectUnconfigured(() => resolveExportFieldSet(['customer_display_name'], undefined), 'policy_state');
  });

  it('refuses when the policy state is not positively configured', () => {
    expectUnconfigured(() => resolveExportFieldSet(['customer_display_name'], configured({ policyState: 'unconfigured' })), 'policy_state');
  });

  it('refuses each of the five facts in turn, naming it', () => {
    const cases: readonly { readonly fact: string; readonly config: ExportBoundingConfiguration }[] = [
      { fact: 'permitted_fields', config: configured({ permittedFields: [] }) },
      { fact: 'audience_permission', config: configured({ audiencePermissionKey: '   ' }) },
      { fact: 'retention', config: configured({ retentionPolicyId: '' }) },
      {
        fact: 'destination_access_model',
        config: configured({
          destinationAccessModel: 'shared_drive' as ExportBoundingConfiguration['destinationAccessModel'],
        }),
      },
      {
        fact: 'max_scope',
        config: configured({
          maxScope: null as unknown as ExportMaxScopeConfiguration,
        }),
      },
      {
        fact: 'max_scope',
        config: configured({ maxScope: { ...FIXTURE_MAX_SCOPE, perExportRowBound: 0 } }),
      },
      {
        fact: 'max_scope',
        config: configured({ maxScope: { ...FIXTURE_MAX_SCOPE, cumulativeRowBound: -1 } }),
      },
      {
        fact: 'max_scope',
        config: configured({ maxScope: { ...FIXTURE_MAX_SCOPE, cumulativeWindowLabel: '' } }),
      },
    ];
    // The set is measured, so a case list that silently shrank is visible.
    expect(cases.length).toBe(8);
    for (const testCase of cases) {
      expectUnconfigured(() => resolveExportFieldSet(['customer_display_name'], testCase.config), testCase.fact);
    }
  });

  it('refuses a request that names no field: there is no all-columns default', () => {
    expectUnconfigured(() => resolveExportFieldSet([], configured()), 'permitted_fields');
  });

  it('refuses a permitted set that itself names a forbidden field, because configuration is input and not authority', () => {
    expectUnconfigured(() => requireExportConfiguration(configured({ permittedFields: [...PERMITTED, 'tenant_id'] })), 'permitted_fields');
    expectUnconfigured(() => requireExportConfiguration(configured({ permittedFields: [...PERMITTED, 'session_token'] })), 'permitted_fields');
  });

  it('the baseline is restored and green: a fully configured policy resolves', () => {
    const resolved = resolveExportFieldSet(['customer_display_name', 'purchase_frequency_sale_count'], configured());
    expect(resolved.fields.map((f) => f.key)).toEqual(['customer_display_name', 'purchase_frequency_sale_count']);
  });
});

/* ========================================================================= *
 * RED PROOF — a raw cross-tenant identifier is refused
 * ========================================================================= */

describe('RED PROOF: an export attempting a raw cross-tenant identifier is refused', () => {
  it('refuses the tenant id by name, with the cross-tenant reason', () => {
    try {
      resolveExportFieldSet(['customer_display_name', 'tenant_id'], configured());
      expect.unreachable('a raw cross-tenant identifier must never be emitted');
    } catch (error) {
      expect(error).toBeInstanceOf(ExportFieldRefusal);
      const refusal = error as ExportFieldRefusal;
      expect(refusal.reason).toBe('field_is_raw_cross_tenant_identifier');
      expect(refusal.field).toBe('tenant_id');
      expect(refusal.httpStatus).toBe(422);
      expect(refusal.message).toContain('meaningful outside the exporting business');
    }
  });

  it('refuses a cross-business surrogate key even when a caller puts it in the permitted set', () => {
    // The planted defect: the configuration itself permits the raw key. The
    // field-level rule must still refuse it, because the two prohibitions are
    // rulings and not configuration.
    try {
      resolveExportFieldSet(['customer_id'], {
        ...configured(),
        permittedFields: [...PERMITTED, 'customer_id'],
      });
      expect.unreachable('a raw cross-business key must be refused whatever the configuration says');
    } catch (error) {
      // The configuration gate sees it first, which is the stricter outcome and
      // the one that matters: the whole export is refused, not just the column.
      if (error instanceof AnalyticsRefusal) {
        expect(error.code).toBe('analytics.export_unconfigured');
        expect(error.context.missingFact).toBe('permitted_fields');
      } else {
        expect(error).toBeInstanceOf(ExportFieldRefusal);
        expect((error as ExportFieldRefusal).reason).toBe('field_is_raw_cross_tenant_identifier');
      }
    }
  });

  it('refuses secret material with its own reason', () => {
    try {
      resolveExportFieldSet(['session_token'], configured());
      expect.unreachable('secret material is never exportable');
    } catch (error) {
      expect(error).toBeInstanceOf(ExportFieldRefusal);
      expect((error as ExportFieldRefusal).reason).toBe('field_never_exportable');
    }
  });

  it('refuses an unknown key, a duplicate, and a field outside the permitted set, each by name', () => {
    const cases: readonly { readonly request: readonly string[]; readonly reason: string; readonly field: string }[] = [
      { request: ['not_a_field'], reason: 'field_unknown', field: 'not_a_field' },
      {
        request: ['customer_display_name', 'customer_display_name'],
        reason: 'field_requested_twice',
        field: 'customer_display_name',
      },
      {
        request: ['customer_national_id'],
        reason: 'field_not_in_permitted_set',
        field: 'customer_national_id',
      },
    ];
    expect(cases.length).toBe(3);
    for (const testCase of cases) {
      try {
        resolveExportFieldSet(testCase.request, configured());
        expect.unreachable(`expected ${testCase.reason}`);
      } catch (error) {
        expect(error).toBeInstanceOf(ExportFieldRefusal);
        const refusal = error as ExportFieldRefusal;
        expect(refusal.reason).toBe(testCase.reason);
        expect(refusal.field).toBe(testCase.field);
      }
    }
  });
});

/* ========================================================================= *
 * PII minimisation: the resolved set counts what left, without storing it
 * ========================================================================= */

describe('PII minimisation on the resolved set', () => {
  it('counts the PII classes present and carries the bounds it resolved under', () => {
    const resolved = resolveExportFieldSet(
      ['customer_display_name', 'customer_phone', 'last_purchase_document_date', 'purchase_frequency_sale_count'],
      configured(),
    );
    expect(resolved.piiClassCounts.direct_identifier).toBe(2);
    expect(resolved.piiClassCounts.quasi_identifier).toBe(1);
    expect(resolved.piiClassCounts.derived_behavioural).toBe(1);
    expect(resolved.piiClassCounts.never_exportable).toBe(0);
    expect(resolved.carriesPersonalData).toBe(true);
    expect(resolved.maxScope).toEqual(FIXTURE_MAX_SCOPE);
    expect(resolved.retentionPolicyId).toBe('owner-ratified-retention-policy');
    expect(resolved.audiencePermissionKey).toBe('reports.export');
  });

  it('a quasi-identifier-only set still carries personal data: an export of anonymous rows is not anonymous', () => {
    const resolved = resolveExportFieldSet(['last_purchase_document_date'], configured());
    expect(resolved.piiClassCounts.direct_identifier).toBe(0);
    expect(resolved.carriesPersonalData).toBe(true);
  });

  it('an aggregate with no customer dimension is the one set that carries no personal data', () => {
    const resolved = resolveExportFieldSet(['aggregate_sale_document_count'], configured());
    expect(resolved.carriesPersonalData).toBe(false);
  });

  it('preserves the caller explicit field order, so the emitted columns are the named ones', () => {
    const resolved = resolveExportFieldSet(['customer_phone', 'customer_display_name'], configured());
    expect(resolved.fields.map((f) => f.key)).toEqual(['customer_phone', 'customer_display_name']);
  });
});

/* ========================================================================= *
 * The row bound is the caller configured figure, and it refuses rather than truncates
 * ========================================================================= */

describe('the per-export row bound', () => {
  it('passes at and below the configured bound', () => {
    expect(() => requireRowCountWithinBound(0, FIXTURE_MAX_SCOPE)).not.toThrow();
    expect(() => requireRowCountWithinBound(FIXTURE_MAX_SCOPE.perExportRowBound, FIXTURE_MAX_SCOPE)).not.toThrow();
  });

  it('refuses above the bound, carrying both figures, and does not truncate', () => {
    const over = FIXTURE_MAX_SCOPE.perExportRowBound + 1;
    try {
      requireRowCountWithinBound(over, FIXTURE_MAX_SCOPE);
      expect.unreachable('an over-bound export is refused, never truncated');
    } catch (error) {
      expect(error).toBeInstanceOf(ExportBoundExceeded);
      const refusal = error as ExportBoundExceeded;
      expect(refusal.configuredBound).toBe(String(FIXTURE_MAX_SCOPE.perExportRowBound));
      expect(refusal.actualRowCount).toBe(String(over));
      expect(refusal.message).toContain('refused, not truncated');
    }
  });

  it('refuses a row count that is not a whole number of rows', () => {
    try {
      requireRowCountWithinBound(1.5, FIXTURE_MAX_SCOPE);
      expect.unreachable('a fractional row count is not a row count');
    } catch (error) {
      expect(error).toBeInstanceOf(AnalyticsRefusal);
      expect((error as AnalyticsRefusal).context.missingFact).toBe('max_scope');
    }
  });
});
