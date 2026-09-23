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
   * REQUIRED. `YYYY-MM-DD`, on or after the original entry's date and never
   * in the future.
   *
   * A reversal carries no `Idempotency-Key`: the original entry's id IS its
   * source identity, so an identical request is meant to replay. That only
   * holds if the command is a pure function of the request, and the
   * fingerprint covers the entry date. A date the SERVER resolved from its
   * own clock would make the signed fact depend on WHEN the request arrived:
   * the same retry, sent either side of local midnight, would sign two
   * different facts and the second would be refused as a conflict. The
   * client states the date, so the retry is the same command forever.
   */
  entryDate: string;
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

// ── Accounting FX rates (P2-S5) ───────────────────────────────────────────

/**
 * `POST /v1/businesses/:businessId/accounting/fx-rates`
 *
 * Requires `accounting.fx.manage` AND business-wide branch authority: a rate
 * is configuration for every branch, so a member restricted to one of them
 * may not set it. An `Idempotency-Key` header is required, and the rate's
 * identity is derived from it.
 *
 * The body states the pair, the rate and when it takes effect, and NOTHING
 * else. There is no actor, no tenant, no business and no `source` field: the
 * source is fixed as `manual` inside the trusted command, so a caller cannot
 * claim a provenance that never existed.
 */
export interface AccountingFxRateCreateDto {
  fromCurrency: string;
  toCurrency: string;
  /**
   * A decimal STRING with at most ten fraction digits, e.g. `"3.71"`. Never a
   * JSON number: a double cannot hold a ten-digit rate exactly, and a rate
   * whose precision exceeds the contract is REFUSED, never rounded.
   */
  rate: string;
  /** RFC3339 UTC at second precision, e.g. `2026-09-22T10:00:00Z`. */
  effectiveAt: string;
}

/** What a rate entry returns. `created: false` is an idempotent replay. */
export interface AccountingFxRateRefDto {
  rateId: string;
  created: boolean;
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

// ── Accounting periods (P2-S6) ────────────────────────────────────────────
//
// DAFTAR creates no period by itself and infers no fiscal calendar. A
// business with ZERO periods posts under the ordinary date rules; the FIRST
// period it creates activates period-managed posting, after which every NEW
// entry's date must fall inside exactly one OPEN period.

/** `open` or `closed`. There is no third state. */
export type AccountingPeriodStatusDto = 'open' | 'closed';

/**
 * `POST /v1/businesses/:businessId/accounting/periods`
 *
 * Requires `accounting.period.manage` AND business-wide branch authority: a
 * period governs every branch of the business, so a member restricted to one
 * of them may not create it. An `Idempotency-Key` header is required, and the
 * period's identity is derived from it.
 *
 * Both dates are EXPLICIT and inclusive. There is no server default, no
 * "current month" and no calendar the server fills in: a period the merchant
 * did not state is a policy DAFTAR invented on their behalf.
 */
export interface AccountingPeriodCreateDto {
  /** `YYYY-MM-DD`, inclusive first civil date in the business timezone. */
  startDate: string;
  /** `YYYY-MM-DD`, inclusive last civil date. On or after `startDate`. */
  endDate: string;
}

/**
 * `POST /v1/businesses/:businessId/accounting/periods/:periodId/reopen`
 *
 * Requires `accounting.period.reopen`, which `accounting.period.manage` does
 * NOT imply. The reason is mandatory and is written to the audit trail; it is
 * deliberately absent from the published event.
 */
export interface AccountingPeriodReopenDto {
  /** 1 to 500 characters after trimming. A reopen nobody explained cannot be reviewed. */
  reason: string;
}

/** What a period command returns. `changed: false` is an idempotent replay. */
export interface AccountingPeriodRefDto {
  periodId: string;
  changed: boolean;
}

/** One period, as `GET .../accounting/periods` returns it. */
export interface AccountingPeriodDto {
  periodId: string;
  startDate: string;
  endDate: string;
  status: AccountingPeriodStatusDto;
  /** RFC3339 UTC, or null while the period is open. */
  closedAt: string | null;
  /** RFC3339 UTC of the most recent reopen, or null if it was never reopened. */
  lastReopenedAt: string | null;
}

/**
 * `GET /v1/businesses/:businessId/accounting/periods`
 *
 * An OBJECT with an `items` array, never a bare array: a top-level array is a
 * response shape that can never gain a field without breaking every client.
 * It carries no assertion, no internal operation id, no database role detail
 * and no audit internals.
 */
export interface AccountingPeriodListDto {
  items: AccountingPeriodDto[];
}

// ── Accounting financial reads (P2-S7) ────────────────────────────────────
//
// The read side of the ledger. Every amount below is a STRING of minor units
// in the business's base currency, for the same reason every amount above is:
// a JSON number is an IEEE double, and a double cannot hold an LBP balance or
// a cumulative total exactly. A client that parses one of these with
// `Number()` has thrown away the guarantee the server went to some trouble to
// keep.
//
// Nothing in this section mutates anything. There is no `POST balance`, no
// `PATCH ledger` and no field a client can send that would change a number.

/** The five account types the chart allows. */
export type AccountingAccountTypeDto = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

/** One account of the chart. Deliberately carries no balance: a balance needs an as-of date. */
export interface AccountingAccountDto {
  accountId: string;
  code: string;
  /** Display label. System accounts are rendered from `accounting.account.<systemKey>` (AL-06). */
  name: string;
  type: AccountingAccountTypeDto;
  /** Engine identity for a system account; `null` for a merchant's own account. */
  systemKey: string | null;
  /**
   * FUTURE POSTING ELIGIBILITY, never history visibility. An inactive account
   * still appears in every historical report it has movement in.
   */
  isActive: boolean;
}

/** `GET /v1/businesses/:businessId/accounting/accounts` */
export interface AccountingAccountListDto {
  items: AccountingAccountDto[];
}

/** One entry as the list returns it. No total: the amounts are on the lines. */
export interface AccountingEntrySummaryDto {
  entryId: string;
  /** `YYYY-MM-DD`, the accounting date as posted. */
  entryDate: string;
  sourceType: string;
  sourceId: string;
  description: string | null;
  /** RFC3339 UTC at second precision. */
  createdAt: string;
  lineCount: number;
}

/** `GET /v1/businesses/:businessId/accounting/entries` */
export interface AccountingEntryListDto {
  items: AccountingEntrySummaryDto[];
  /** Opaque keyset cursor, or `null` on the last page. Never an offset. */
  nextCursor: string | null;
}

/** One line of an entry detail, exactly as the journal froze it. */
export interface AccountingEntryLineDto {
  lineNo: number;
  accountId: string;
  code: string;
  name: string;
  type: AccountingAccountTypeDto;
  side: 'D' | 'C';
  debitMinor: string;
  creditMinor: string;
  baseAmountMinor: string;
  baseCurrency: string;
  txnAmountMinor: string;
  txnCurrency: string;
  /**
   * The rate AS POSTED, with the snapshot that came with it. A rate entered
   * tomorrow never changes this row: the report reads the line, it does not
   * look a rate up again.
   */
  fxRate: string;
  fxRateSource: 'base' | 'manual' | 'provider';
  fxRateAt: string;
  branchId: string | null;
  warehouseId: string | null;
  memo: string | null;
}

/** `GET /v1/businesses/:businessId/accounting/entries/:entryId` */
export interface AccountingEntryDetailDto {
  entryId: string;
  entryDate: string;
  sourceType: string;
  sourceId: string;
  description: string | null;
  actorKind: 'user' | 'system';
  actorUserId: string | null;
  actorSystemKey: string | null;
  createdAt: string;
  lines: AccountingEntryLineDto[];
}

/** One account's row of a trial balance. */
export interface AccountingTrialBalanceRowDto {
  accountId: string;
  code: string;
  name: string;
  type: AccountingAccountTypeDto;
  isActive: boolean;
  totalDebitMinor: string;
  totalCreditMinor: string;
  /**
   * Signed, in the account's normal direction: `debit - credit` for assets and
   * expenses, `credit - debit` for liabilities, equity and revenue. A contra
   * or abnormal balance is NEGATIVE here and is never clamped to zero.
   */
  netMinor: string;
  baseCurrency: string;
}

/**
 * `GET /v1/businesses/:businessId/accounting/trial-balance`
 *
 * `asOf` and `from`/`to` are MUTUALLY EXCLUSIVE, and one of them is required:
 * a request that named both would have to be resolved by a convention, and
 * the convention would be the server deciding which question was asked.
 *
 * `kind` distinguishes a legal trial balance from a dimensional view. A
 * `whole_business` report always balances — an unbalanced one is refused with
 * `accounting.report_unbalanced` rather than rendered. A `branch_dimension`
 * report may legitimately NOT balance, because one entry may carry different
 * branches on different lines, and `isBalanced` says so honestly instead of
 * the server discarding mixed entries to manufacture a tidy total.
 */
export interface AccountingTrialBalanceDto {
  kind: 'whole_business' | 'branch_dimension';
  isBalanced: boolean;
  totalDebitMinor: string;
  totalCreditMinor: string;
  baseCurrency: string;
  items: AccountingTrialBalanceRowDto[];
}

/** One ledger row: a posted line and the balance after it. */
export interface AccountingLedgerRowDto {
  entryId: string;
  entryDate: string;
  lineNo: number;
  sourceType: string;
  sourceId: string;
  description: string | null;
  debitMinor: string;
  creditMinor: string;
  baseAmountMinor: string;
  baseCurrency: string;
  txnAmountMinor: string;
  txnCurrency: string;
  fxRate: string;
  fxRateSource: 'base' | 'manual' | 'provider';
  fxRateAt: string;
  branchId: string | null;
  warehouseId: string | null;
  memo: string | null;
  /** Signed, in the account's normal direction, after this row. */
  runningMinor: string;
}

/**
 * `GET /v1/businesses/:businessId/accounting/ledger`
 *
 * One business, one account, one inclusive date range. `openingMinor` is
 * everything posted STRICTLY BEFORE `from`; the rows are
 * `from <= entryDate <= to`, ordered `(entryDate, entryId, lineNo)`.
 *
 * The consistency model across pages is APPEND-STABLE TRAVERSAL, not a
 * database snapshot: a row that existed when page 1 was served is never
 * repeated and never skipped, and a posting made after page 1 may appear on a
 * later page if it sorts after the cursor. Nothing here promises a frozen
 * view of the ledger across separate HTTP requests, and a client that needs
 * one should say what instant it wants with `to`.
 */
export interface AccountingLedgerDto {
  account: AccountingAccountDto;
  from: string;
  to: string;
  baseCurrency: string;
  openingMinor: string;
  /** The running balance after the last row of THIS page. */
  closingMinor: string;
  items: AccountingLedgerRowDto[];
  nextCursor: string | null;
}

/** One account's derived balance at an instant. */
export interface AccountingAccountBalanceDto {
  accountId: string;
  code: string;
  name: string;
  type: AccountingAccountTypeDto;
  isActive: boolean;
  /** Signed, in the account's normal direction. */
  balanceMinor: string;
  currency: string;
  /** Inclusive: every line with `entryDate <= asOf` is in this figure. */
  asOf: string;
}

/** `GET /v1/businesses/:businessId/accounting/balances` */
export interface AccountingBalanceListDto {
  asOf: string;
  baseCurrency: string;
  items: AccountingAccountBalanceDto[];
}
