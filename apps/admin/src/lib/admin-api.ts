'use client';
/**
 * Central typed Platform (admin) API client (Completion Directive §28).
 * ONE path convention: the browser calls /api/proxy/admin/<resource>; the
 * BFF proxy prepends /v1 exactly once. Pages never build URLs or declare
 * their own response interfaces — every type is a @daftar/shared-contracts
 * DTO, and the API never returns raw SQL row shapes.
 */
import type {
  AdminBusinessSummaryDto,
  AdminUserDto,
  AuditEventDto,
  BusinessSubscriptionDetailDto,
  FeatureFlagDto,
  ListDto,
  OverrideDto,
  PlanDto,
  PlanListResponseDto,
  PlanVersionDiffDto,
  PlanVersionDto,
  PlatformCapabilitiesDto,
  SupportSessionDto,
  TenantDetailDto,
  TenantSummaryDto,
} from '@daftar/shared-contracts';
import { apiFetch } from './client';

const ADMIN = '/api/proxy/admin';

// ── Tenants / businesses / users ─────────────────────────────────────────
export const listTenants = () => apiFetch<ListDto<TenantSummaryDto>>(`${ADMIN}/tenants`);
/** Requires an ACTIVE support session for the tenant (403 otherwise). */
export const getTenantDetail = (tenantId: string) => apiFetch<TenantDetailDto>(`${ADMIN}/tenants/${tenantId}`);
export const listBusinesses = () => apiFetch<ListDto<AdminBusinessSummaryDto>>(`${ADMIN}/businesses`);
export const getBusinessDetail = (businessId: string) => apiFetch<BusinessSubscriptionDetailDto>(`${ADMIN}/businesses/${businessId}`);
export const listUsers = () => apiFetch<ListDto<AdminUserDto>>(`${ADMIN}/users`);
export const getCapabilities = (userId: string) => apiFetch<PlatformCapabilitiesDto>(`${ADMIN}/capabilities/${userId}`);
export const grantPlatformRole = (userId: string, roleKey: string) =>
  apiFetch<PlatformCapabilitiesDto>(`${ADMIN}/platform-roles`, { method: 'POST', body: JSON.stringify({ userId, roleKey }) });

// ── Plan builder (§29): create → draft → clone → edit → diff → publish → sunset ──
export const listPlans = () => apiFetch<PlanListResponseDto>(`${ADMIN}/plans`);
export const createPlan = (key: string, name: string) => apiFetch<PlanDto>(`${ADMIN}/plans`, { method: 'POST', body: JSON.stringify({ key, name }) });
export interface PlanVersionChanges {
  features?: Record<string, boolean>;
  limits?: Record<string, number>;
  trialDays?: number;
}
/** Clones the latest version of the plan into a new DRAFT and applies the changes. */
export const createPlanVersion = (planKey: string, changes: PlanVersionChanges) =>
  apiFetch<PlanVersionDto>(`${ADMIN}/plan-versions`, { method: 'POST', body: JSON.stringify({ planKey, ...changes }) });
/** Edits a DRAFT version in place (PUBLISHED versions are immutable — the API rejects). */
export const updateDraftPlanVersion = (planVersionId: string, changes: PlanVersionChanges) =>
  apiFetch<PlanVersionDto>(`${ADMIN}/plan-versions/${planVersionId}`, { method: 'PATCH', body: JSON.stringify(changes) });
export const publishPlanVersion = (planVersionId: string) =>
  apiFetch<PlanVersionDto>(`${ADMIN}/plan-versions/${planVersionId}/publish`, { method: 'POST', body: '{}' });
export const sunsetPlanVersion = (planVersionId: string) =>
  apiFetch<PlanVersionDto>(`${ADMIN}/plan-versions/${planVersionId}/sunset`, { method: 'POST', body: '{}' });
export const diffPlanVersions = (planKey: string, from: number, to: number) =>
  apiFetch<PlanVersionDiffDto>(`${ADMIN}/plans/${planKey}/versions/diff?from=${from}&to=${to}`);

// ── Entitlement overrides ────────────────────────────────────────────────
export const listOverrides = () => apiFetch<ListDto<OverrideDto>>(`${ADMIN}/entitlement-overrides`);
export interface OverrideInput {
  businessId: string;
  featureKey?: string;
  enabledValue?: boolean;
  limitKey?: string;
  limitValue?: number;
  reason: string;
  startsAt?: string;
  endsAt?: string;
}
export const createOverride = (input: OverrideInput) =>
  apiFetch<OverrideDto>(`${ADMIN}/entitlement-overrides`, { method: 'POST', body: JSON.stringify(input) });
export const revokeOverride = (id: string, reason: string) =>
  apiFetch<OverrideDto>(`${ADMIN}/entitlement-overrides/${id}/revoke`, { method: 'POST', body: JSON.stringify({ reason }) });

// ── Feature flags (technical enablement, separate from entitlements) ─────
export const listFeatureFlags = () => apiFetch<ListDto<FeatureFlagDto>>(`${ADMIN}/feature-flags`);
export const setFeatureFlag = (key: string, enabled: boolean, description?: string) =>
  apiFetch<FeatureFlagDto>(`${ADMIN}/feature-flags`, {
    method: 'POST',
    body: JSON.stringify({ key, enabled, ...(description !== undefined ? { description } : {}) }),
  });

// ── Support sessions ─────────────────────────────────────────────────────
export const listSupportSessions = () => apiFetch<ListDto<SupportSessionDto>>(`${ADMIN}/support-sessions`);
export const createSupportSession = (input: { tenantId: string; businessId?: string; reason: string; expiresAt: string }) =>
  apiFetch<SupportSessionDto>(`${ADMIN}/support-sessions`, { method: 'POST', body: JSON.stringify(input) });
export const revokeSupportSession = (id: string, reason: string) =>
  apiFetch<SupportSessionDto>(`${ADMIN}/support-sessions/${id}/revoke`, { method: 'POST', body: JSON.stringify({ reason }) });

// ── Audit ────────────────────────────────────────────────────────────────
export const listAuditEvents = () => apiFetch<ListDto<AuditEventDto>>(`${ADMIN}/audit-events`);
