'use client';
/**
 * Central typed Merchant API client (Stabilization §25–26, Part S §95;
 * Completion Directive §25–27).
 * ONE path convention: the browser calls /api/proxy/<resource> (NO /v1 —
 * the BFF proxy prepends /v1 exactly once). Pages must NEVER build URLs
 * by hand; they call these typed functions. Every request/response type
 * comes from @daftar/shared-contracts — no page-level response interfaces.
 *
 * CONTRACT LAW (audited by tests/golden-regression/phase1/06-web-contract):
 *   - every list endpoint returns `{ items }` (ListDto / Page), never a bare array,
 *   - every entity mutation returns the full DTO, never `{ ok: true }`,
 *   - pure state transitions return AckDto,
 *   - money is a minor-units STRING; the server derives priceCurrency.
 */
import type {
  AckDto,
  BranchDto,
  BranchScopeUpdateDto,
  BusinessSettingsDto,
  BusinessSummaryDto,
  CategoryDto,
  CountryDto,
  CurrencyDto,
  EntitlementSummaryDto,
  InvitationDto,
  ListDto,
  LocaleCode,
  MediaAccessUrlDto,
  MediaUploadResultDto,
  MemberDto,
  OnboardingResultDto,
  Page,
  ProductDto,
  ProductListItemDto,
  RoleDto,
  SlugAvailabilityDto,
  WarehouseDto,
} from '@daftar/shared-contracts';
import { apiFetch } from './client';

const BFF = '/api/proxy';

// ── Platform reference (public) ──────────────────────────────────────────
export const getCountries = () => apiFetch<ListDto<CountryDto>>(`${BFF}/platform/countries`);
export const getCurrencies = () => apiFetch<ListDto<CurrencyDto>>(`${BFF}/platform/currencies`);

// ── Onboarding / business creation ───────────────────────────────────────
export const checkSlugAvailability = (slug: string) => apiFetch<SlugAvailabilityDto>(`${BFF}/onboarding/slug-availability?slug=${encodeURIComponent(slug)}`);

export interface OnboardingInput {
  businessName: string;
  countryCode: string;
  baseCurrency: string;
  storeSlug: string;
  preferredLocale?: LocaleCode;
  industryProfileKey?: string;
  timezone?: string;
}
export const completeOnboarding = (input: OnboardingInput) =>
  apiFetch<OnboardingResultDto>(`${BFF}/onboarding/complete`, { method: 'POST', body: JSON.stringify(input) });

export const createBusinessInTenant = (tenantId: string, input: OnboardingInput) =>
  apiFetch<OnboardingResultDto>(`${BFF}/tenants/${tenantId}/businesses`, { method: 'POST', body: JSON.stringify(input) });

// ── Business context ─────────────────────────────────────────────────────
export const getMyBusinesses = () => apiFetch<ListDto<BusinessSummaryDto>>(`${BFF}/me/businesses`);
export const getCurrentBusiness = () => apiFetch<BusinessSettingsDto>(`${BFF}/businesses/current`);
export type BusinessSettingsPatch = Partial<Pick<BusinessSettingsDto, 'name' | 'defaultLocale' | 'enabledLocales' | 'storefrontLocale' | 'timezone'>>;
export const updateCurrentBusiness = (patch: BusinessSettingsPatch) =>
  apiFetch<BusinessSettingsDto>(`${BFF}/businesses/current`, { method: 'PATCH', body: JSON.stringify(patch) });
export const changeBaseCurrency = (currency: string) =>
  apiFetch<AckDto>(`${BFF}/businesses/current/base-currency`, { method: 'POST', body: JSON.stringify({ currency }) });

// ── Structure ────────────────────────────────────────────────────────────
export const listBranches = () => apiFetch<ListDto<BranchDto>>(`${BFF}/businesses/current/branches`);
export const createBranch = (name: string) => apiFetch<BranchDto>(`${BFF}/businesses/current/branches`, { method: 'POST', body: JSON.stringify({ name }) });
export const listWarehouses = () => apiFetch<ListDto<WarehouseDto>>(`${BFF}/businesses/current/warehouses`);
export const createWarehouse = (branchId: string, name: string) =>
  apiFetch<WarehouseDto>(`${BFF}/businesses/current/warehouses`, { method: 'POST', body: JSON.stringify({ branchId, name }) });

// ── Team ─────────────────────────────────────────────────────────────────
export const listMembers = () => apiFetch<ListDto<MemberDto>>(`${BFF}/businesses/current/members`);
export const addMember = (email: string, roleKey: string) =>
  apiFetch<MemberDto>(`${BFF}/businesses/current/members`, { method: 'POST', body: JSON.stringify({ email, roleKey }) });
export const removeMember = (userId: string) => apiFetch<AckDto>(`${BFF}/businesses/current/members/${userId}`, { method: 'DELETE' });
export const suspendMember = (userId: string) => apiFetch<AckDto>(`${BFF}/businesses/current/members/${userId}/suspend`, { method: 'POST', body: '{}' });
export const reactivateMember = (userId: string) => apiFetch<AckDto>(`${BFF}/businesses/current/members/${userId}/reactivate`, { method: 'POST', body: '{}' });
export const setMemberRoles = (userId: string, roleKeys: string[]) =>
  apiFetch<AckDto>(`${BFF}/businesses/current/members/${userId}/roles`, { method: 'PATCH', body: JSON.stringify({ roleKeys }) });
/** Directive §26: the request body is `{ mode, branchIds }` (BranchScopeUpdateDto). */
export const setMemberBranchScope = (userId: string, scope: BranchScopeUpdateDto) =>
  apiFetch<AckDto>(`${BFF}/businesses/current/members/${userId}/branch-scope`, { method: 'PATCH', body: JSON.stringify(scope) });

export const listInvitations = () => apiFetch<ListDto<InvitationDto>>(`${BFF}/businesses/current/invitations`);
export const inviteMember = (email: string, roleKey: string) =>
  apiFetch<InvitationDto>(`${BFF}/businesses/current/invitations`, { method: 'POST', body: JSON.stringify({ email, roleKey }) });
export const resendInvitation = (id: string) => apiFetch<AckDto>(`${BFF}/businesses/current/invitations/${id}/resend`, { method: 'POST', body: '{}' });
export const cancelInvitation = (id: string) => apiFetch<AckDto>(`${BFF}/businesses/current/invitations/${id}`, { method: 'DELETE' });
export const acceptInvitation = (token: string) =>
  apiFetch<{ businessId: string }>(`${BFF}/invitations/accept`, { method: 'POST', body: JSON.stringify({ token }) });

// ── Roles ────────────────────────────────────────────────────────────────
export const listRoles = () => apiFetch<ListDto<RoleDto>>(`${BFF}/businesses/current/roles`);
export const createRole = (key: string, name: string, permissions: string[]) =>
  apiFetch<RoleDto>(`${BFF}/businesses/current/roles`, { method: 'POST', body: JSON.stringify({ key, name, permissions }) });
export const updateRole = (roleId: string, patch: { name?: string; permissions?: string[] }) =>
  apiFetch<RoleDto>(`${BFF}/businesses/current/roles/${roleId}`, { method: 'PATCH', body: JSON.stringify(patch) });
export const deleteRole = (roleId: string, replacementRoleKey?: string) =>
  apiFetch<AckDto>(`${BFF}/businesses/current/roles/${roleId}`, {
    method: 'DELETE',
    body: JSON.stringify(replacementRoleKey ? { replacementRoleKey } : {}),
  });

// ── Catalog ──────────────────────────────────────────────────────────────
export const listCategories = () => apiFetch<ListDto<CategoryDto>>(`${BFF}/catalog/categories`);
export const createCategory = (translations: Partial<Record<LocaleCode, string>>, parentId?: string) =>
  apiFetch<CategoryDto>(`${BFF}/catalog/categories`, { method: 'POST', body: JSON.stringify({ translations, ...(parentId ? { parentId } : {}) }) });

export const listProducts = (search?: string) =>
  apiFetch<Page<ProductListItemDto>>(`${BFF}/catalog/products${search ? `?search=${encodeURIComponent(search)}` : ''}`);
export const getProduct = (id: string) => apiFetch<ProductDto>(`${BFF}/catalog/products/${id}`);

export interface ProductCreateInput {
  translations: Partial<Record<LocaleCode, string>>;
  /** Minor units as a decimal string (§36) — the server derives priceCurrency from the business base currency. */
  basePriceMinor: string;
  sku?: string;
  barcode?: string;
  unit?: string;
  categoryId?: string;
  variants?: { attributes: Record<string, string>; sku?: string; barcode?: string; priceMinor?: string }[];
}
export const createProduct = (input: ProductCreateInput) => apiFetch<ProductDto>(`${BFF}/catalog/products`, { method: 'POST', body: JSON.stringify(input) });

export interface ProductUpdateInput {
  translations?: Partial<Record<LocaleCode, string>>;
  basePriceMinor?: string;
  sku?: string | null;
  barcode?: string | null;
  unit?: string | null;
  categoryId?: string | null;
  /** Optimistic concurrency precondition (§98): the version the edit was based on. */
  version?: number;
}
export const updateProduct = (id: string, patch: ProductUpdateInput) =>
  apiFetch<ProductDto>(`${BFF}/catalog/products/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
export const archiveProduct = (id: string) => apiFetch<AckDto>(`${BFF}/catalog/products/${id}`, { method: 'DELETE' });

// ── Media (private storage: upload → attach → short-TTL access URL) ───────
export const uploadMedia = (file: File) => {
  const form = new FormData();
  form.append('file', file);
  return apiFetch<MediaUploadResultDto>(`${BFF}/catalog/media`, { method: 'POST', body: form });
};
export const attachMedia = (productId: string, mediaId: string) =>
  apiFetch<AckDto>(`${BFF}/catalog/products/${productId}/media/${mediaId}`, { method: 'POST', body: '{}' });
export const getMediaAccessUrl = (mediaId: string, variant?: `w${number}`) =>
  apiFetch<MediaAccessUrlDto>(`${BFF}/catalog/media/${mediaId}/access-url${variant ? `?variant=${variant}` : ''}`);

// ── Entitlement (Part E §29: the endpoint is /entitlement — plan-usage does not exist) ──
export const getEntitlement = () => apiFetch<EntitlementSummaryDto>(`${BFF}/businesses/current/entitlement`);

// ── Security ─────────────────────────────────────────────────────────────
export const logoutAllSessions = () => apiFetch<AckDto>(`${BFF}/auth/logout-all`, { method: 'POST', body: '{}' });
export const requestPasswordReset = (email: string) =>
  apiFetch<AckDto>(`${BFF}/auth/password-reset/request`, { method: 'POST', body: JSON.stringify({ email }) });
export const completePasswordReset = (token: string, password: string) =>
  apiFetch<AckDto>(`${BFF}/auth/password-reset/complete`, { method: 'POST', body: JSON.stringify({ token, password }) });
