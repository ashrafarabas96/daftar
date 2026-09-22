/**
 * DAFTAR shared contracts (Directive §30) — the ONLY thing clients may import.
 * DTOs, error codes, pagination, contract primitives. No DB entities, no
 * repository types, no domain internals. Money travels as a STRING of minor
 * units (bigint-safe over JSON). Versioned: every route lives under /v1.
 */

export const API_VERSION = 'v1' as const;

export type LocaleCode = 'ar' | 'en' | 'tr';
export const LOCALES: readonly LocaleCode[] = ['ar', 'en', 'tr'];

export interface ApiErrorContract {
  error: {
    code: string; // stable machine code — the client translates this, never the message
    message: string; // generic safe fallback only
    requestId: string;
    details?: Record<string, unknown>;
  };
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Unpaged list wrapper — EVERY list endpoint returns `{ items }`, never a bare array (Directive §26). */
export interface ListDto<T> {
  items: T[];
}

/** Acknowledgement for state-transition commands that have no entity to return (suspend, cancel, logout…). */
export interface AckDto {
  ok: true;
}

// ── Auth ──────────────────────────────────────────────────────────────────
export interface AuthTokensDto {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

export interface MeDto {
  userId: string;
  email: string | null;
  displayName: string;
  preferredLocale: LocaleCode;
}

// ── Tenancy ───────────────────────────────────────────────────────────────
export interface BusinessSummaryDto {
  businessId: string;
  tenantId: string;
  name: string;
  storeSlug: string;
  countryCode: string;
  baseCurrency: string;
  industryProfileKey: string;
  defaultLocale: LocaleCode;
  enabledLocales: LocaleCode[];
  /** IANA timezone (§63) — suggested by country pack, user-editable. */
  timezone: string;
  /** Storefront primary locale (§64) — separate from business operational locale. */
  storefrontLocale: LocaleCode;
  roleKey: string;
}

export interface BusinessSettingsDto extends BusinessSummaryDto {
  baseCurrencyLocked: boolean;
  createdAt: string;
}

export interface BranchDto {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface WarehouseDto {
  id: string;
  branchId: string;
  name: string;
  isDefault: boolean;
}

export interface MemberDto {
  userId: string;
  email: string | null;
  displayName: string;
  /** Effective roles; permissions = union of their grants. */
  roleKeys: string[];
  status: 'invited' | 'active' | 'suspended' | 'removed';
  joinedAt: string | null;
  /** Branch scope (§32–37): 'all' sees every branch; 'assigned' sees allowedBranchIds only. */
  branchScopeMode: 'all' | 'assigned';
  allowedBranchIds: string[];
}

export interface InvitationDto {
  id: string;
  email: string;
  roleKey: string;
  status: 'pending' | 'accepted' | 'cancelled' | 'expired';
  expiresAt: string;
  createdAt: string;
  /** Delivery tracking (WAVE 4): post-commit credential delivery outcome. */
  deliveryStatus: 'pending' | 'processing' | 'sent' | 'failed' | 'dead';
  deliveryAttempts: number;
}

export type SubscriptionStateDto =
  | 'trial'
  | 'active'
  | 'grace_period'
  | 'past_due'
  | 'paused'
  | 'cancel_at_period_end'
  | 'cancelled'
  | 'expired'
  | 'complimentary';

export interface EntitlementSummaryDto {
  planKey: string;
  planVersion: number;
  state: SubscriptionStateDto;
  /** Effective (time-computed) state — correct without a scheduler (§30). */
  effectiveState: SubscriptionStateDto;
  trialEndsAt: string | null;
  periodEndsAt: string | null;
  features: { key: string; enabled: boolean }[];
  limits: { key: string; limit: number; usage: number }[];
}

export interface RoleDto {
  id: string;
  key: string;
  name: string;
  isSystem: boolean;
  permissions: string[];
}

export interface SlugAvailabilityDto {
  slug: string;
  available: boolean;
  suggestions: string[];
}

/** Request body of PATCH /businesses/current/members/:userId/branch-scope (Directive §26: `mode` + `branchIds`). */
export interface BranchScopeUpdateDto {
  mode: 'all' | 'assigned';
  /** Exact allowed set when mode = 'assigned'; ignored for 'all'. */
  branchIds?: string[];
}

export interface OnboardingResultDto {
  businessId: string;
  tenantId: string;
  storeSlug: string;
  replayed: boolean; // true when an idempotent retry returned the existing business
}

// ── Catalog ───────────────────────────────────────────────────────────────
export interface CategoryDto {
  id: string;
  parentId: string | null;
  translations: Partial<Record<LocaleCode, string>>;
}

export interface ProductListItemDto {
  id: string;
  name: string; // resolved for request locale
  sku: string | null;
  basePriceMinor: string; // money as string minor — never number
  priceCurrency: string;
  status: 'active' | 'archived';
}

export interface VariantDto {
  id: string;
  attributes: Record<string, string>;
  sku: string | null;
  barcode: string | null;
  priceMinor: string | null;
}

export interface ProductDto extends ProductListItemDto {
  translations: Partial<Record<LocaleCode, string>>;
  categoryId: string | null;
  barcode: string | null;
  unit: string | null;
  version: number;
  variants: VariantDto[];
  media: MediaDto[];
}

/**
 * Media reference. `url` is ALWAYS the authorized access-URL endpoint
 * (`/v1/catalog/media/{id}/access-url[?variant=w{size}]`) — never a storage
 * key and never an unsigned private-bucket URL (Directive §48). Clients call
 * it (through their BFF) to obtain a short-lived signed URL.
 */
export interface MediaDto {
  id: string;
  url: string;
  variants: { size: number; url: string; width: number; height: number }[];
}

/** POST /catalog/media response. */
export interface MediaUploadResultDto {
  id: string;
  url: string;
}

/** GET /catalog/media/:id/access-url response — short-TTL signed URL. */
export interface MediaAccessUrlDto {
  url: string;
  expiresInSeconds: number;
}

// ── Admin / platform console (Completion Directive §28) ──────────────────
// Stable contracts for the super-admin surface. The admin web NEVER consumes
// raw SQL row shapes: every admin route returns one of these DTOs.

export type PlanVersionStateDto = 'DRAFT' | 'PUBLISHED' | 'SUNSET';

export interface PlanVersionDto {
  id: string;
  planKey: string;
  version: number;
  state: PlanVersionStateDto;
  trialDays: number;
  effectiveFrom: string;
  createdAt: string;
  /** feature key → enabled */
  features: Record<string, boolean>;
  /** limit key → value (-1 = unlimited) */
  limits: Record<string, number>;
}

export interface PlanDto {
  key: string;
  name: string;
  /** Newest first. */
  versions: PlanVersionDto[];
}

export type PlanListResponseDto = ListDto<PlanDto>;

export interface PlanVersionDiffDto {
  planKey: string;
  fromVersion: number;
  toVersion: number;
  trialDays: { from: number | null; to: number | null; changed: boolean };
  features: { key: string; from: boolean | null; to: boolean | null }[];
  limits: { key: string; from: number | null; to: number | null }[];
}

export interface OverrideDto {
  id: string;
  businessId: string;
  featureKey: string | null;
  enabledValue: boolean | null;
  limitKey: string | null;
  limitValue: number | null;
  reason: string;
  actorUserId: string | null;
  startsAt: string;
  endsAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  createdAt: string;
}

export interface FeatureFlagDto {
  key: string;
  enabled: boolean;
  description: string;
  updatedAt: string;
}

export interface SupportSessionDto {
  id: string;
  reason: string;
  actorUserId: string;
  tenantId: string;
  businessId: string | null;
  mode: 'READ_ONLY';
  startsAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
  createdAt: string;
}

export interface SupportBannerDto {
  sessionId: string;
  mode: 'READ_ONLY';
  expiresAt: string;
  businessId: string | null;
  message: string;
}

export interface TenantSummaryDto {
  id: string;
  createdAt: string;
  businessCount: number;
}

export interface TenantDetailDto {
  tenant: {
    id: string;
    createdAt: string;
    businesses: { id: string; name: string; storeSlug: string; status: string }[];
  };
  supportBanner: SupportBannerDto;
}

export interface AdminBusinessSummaryDto {
  id: string;
  tenantId: string;
  name: string;
  storeSlug: string;
  baseCurrency: string;
  countryCode: string;
  status: string;
  createdAt: string;
  subscriptionState: SubscriptionStateDto | null;
  planKey: string | null;
  planVersion: number | null;
}

export interface BusinessSubscriptionDetailDto extends AdminBusinessSummaryDto {
  subscription: {
    planVersionId: string;
    planKey: string;
    planVersion: number;
    state: SubscriptionStateDto;
    effectiveState: SubscriptionStateDto;
    trialEndsAt: string | null;
    periodEndsAt: string | null;
  } | null;
  /** Every override ever granted to this business (active + revoked), newest first. */
  overrides: OverrideDto[];
}

export interface AdminUserDto {
  id: string;
  email: string;
  displayName: string;
  platformRole: string | null;
  createdAt: string;
}

export interface AuditEventDto {
  id: string;
  tenantId: string | null;
  businessId: string | null;
  actorUserId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  requestId: string | null;
  createdAt: string;
}

export interface PlatformCapabilitiesDto {
  userId: string;
  platformRole: string | null;
}

// ── Platform reference ────────────────────────────────────────────────────
export interface CountryDto {
  code: string;
  name: string; // localized via Intl.DisplayNames at the API edge
  recommendedCurrencies: string[];
  phoneCountryCode: string;
}

export interface CurrencyDto {
  code: string;
  name: string; // localized via Intl.DisplayNames
  minorUnits: number;
}

export { formatMinor, minorUnitsOf, parseMajorToMinor } from './money';
/** RBAC permission registry (contract primitive): the exact keys the API accepts in role definitions. */
export { PERMISSIONS } from '@daftar/domain-core';
export type { Permission } from '@daftar/domain-core';

// ── Accounting sources (P2-S4) ────────────────────────────────────────────
//
// Every amount here is a STRING of minor units and every rate is a decimal
// STRING. Nothing financial ever crosses this boundary as a JSON number: a
// double cannot hold an LBP balance or a ten-digit rate exactly, and a single
// implicit coercion would be unrecoverable once it reached the ledger.

/** How a line names its account: a stable system key, or the business's own chart code. */
export type AccountingAccountRefDto = { kind: 'system'; systemKey: string } | { kind: 'code'; code: string };

/** One line of a merchant-stated journal command. */
export interface AccountingLineDto {
  account: AccountingAccountRefDto;
  side: 'D' | 'C';
  /** Minor units of the business's base currency, as a decimal string. */
  baseAmountMinor: string;
  baseCurrency: string;
  txnAmountMinor: string;
  txnCurrency: string;
  /** Decimal string, at most ten fraction digits. */
  fxRate: string;
  fxRateSource: 'base' | 'manual' | 'provider';
  /** RFC3339 UTC at second precision, e.g. `2026-09-22T10:00:00Z`. */
  fxRateAt: string;
  branchId?: string | null;
  warehouseId?: string | null;
  memo?: string | null;
}

/** `POST /v1/businesses/:businessId/accounting/adjustments` */
export interface AccountingAdjustmentCreateDto {
  /** Civil date in the business's timezone, `YYYY-MM-DD`. Never in the future. */
  entryDate: string;
  description?: string | null;
  /** Mandatory: a correction nobody explained is a correction nobody can review. */
  reason: string;
  lines: AccountingLineDto[];
}

/** `POST /v1/businesses/:businessId/accounting/entries/:entryId/reversals` */
export interface AccountingReversalCreateDto {
  /**
   * `YYYY-MM-DD`, on or after the original entry's date and never in the
   * future. Omitted means today in the business's timezone.
   */
  entryDate?: string | null;
  reason: string;
}

/** One position of an opening balance. No branch, no warehouse: it is stated at business level. */
export interface AccountingOpeningPositionDto {
  account: AccountingAccountRefDto;
  side: 'D' | 'C';
  baseAmountMinor: string;
  baseCurrency: string;
  txnAmountMinor: string;
  txnCurrency: string;
  fxRate: string;
  /** `base` for a domestic position, `manual` for a foreign one. */
  fxRateSource: 'base' | 'manual';
  fxRateAt: string;
  memo?: string | null;
}

/** `POST /v1/businesses/:businessId/accounting/opening-balance` */
export interface AccountingOpeningBalanceCreateDto {
  /** `YYYY-MM-DD`. May predate DAFTAR by any amount; never in the future. */
  asOfDate: string;
  description?: string | null;
  /** The equity plug is computed by the engine and may not appear here. */
  positions: AccountingOpeningPositionDto[];
}

/**
 * What every accounting command returns.
 *
 * `created` distinguishes new truth from an idempotent replay: `false` means
 * the identical command had already been recorded and this call changed
 * nothing.
 */
export interface AccountingEntryRefDto {
  entryId: string;
  created: boolean;
}
