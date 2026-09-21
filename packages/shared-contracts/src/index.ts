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
  | 'trial' | 'active' | 'grace_period' | 'past_due' | 'paused'
  | 'cancel_at_period_end' | 'cancelled' | 'expired' | 'complimentary';

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

export interface MediaDto {
  id: string;
  url: string;
  variants: { size: number; url: string; width: number; height: number }[];
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
