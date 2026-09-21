'use client';
/**
 * Central typed Merchant API client (Stabilization §25–26, Part S §95).
 * ONE path convention: the browser calls /api/proxy/<resource> (NO /v1 —
 * the BFF proxy prepends /v1 exactly once). Pages must NEVER build URLs
 * by hand; they call these typed functions. Response types come from
 * @daftar/shared-contracts — no page-level response interfaces.
 */
import type {
  BranchDto,
  BusinessSettingsDto,
  BusinessSummaryDto,
  CategoryDto,
  CountryDto,
  CurrencyDto,
  EntitlementSummaryDto,
  InvitationDto,
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
export const getCountries = () => apiFetch<{ items: CountryDto[] }>(`${BFF}/platform/countries`);
export const getCurrencies = () => apiFetch<{ items: CurrencyDto[] }>(`${BFF}/platform/currencies`);

// ── Onboarding ───────────────────────────────────────────────────────────
export const checkSlugAvailability = (slug: string) => apiFetch<SlugAvailabilityDto>(`${BFF}/onboarding/slug-availability?slug=${encodeURIComponent(slug)}`);

export interface OnboardingInput {
  businessName: string;
  countryCode: string;
  baseCurrency: string;
  storeSlug: string;
  preferredLocale?: string;
  timezone?: string;
}
export const completeOnboarding = (input: OnboardingInput) =>
  apiFetch<OnboardingResultDto>(`${BFF}/onboarding/complete`, { method: 'POST', body: JSON.stringify(input) });

export const createBusinessInTenant = (tenantId: string, input: OnboardingInput) =>
  apiFetch<OnboardingResultDto>(`${BFF}/tenants/${tenantId}/businesses`, { method: 'POST', body: JSON.stringify(input) });

// ── Business context ─────────────────────────────────────────────────────
export const getMyBusinesses = () => apiFetch<BusinessSummaryDto[]>(`${BFF}/me/businesses`);
export const getCurrentBusiness = () => apiFetch<BusinessSettingsDto>(`${BFF}/businesses/current`);
export const updateCurrentBusiness = (patch: Partial<Pick<BusinessSettingsDto, 'name' | 'defaultLocale' | 'storefrontLocale' | 'timezone'>>) =>
  apiFetch<BusinessSettingsDto>(`${BFF}/businesses/current`, { method: 'PATCH', body: JSON.stringify(patch) });

// ── Structure ────────────────────────────────────────────────────────────
export const listBranches = () => apiFetch<BranchDto[]>(`${BFF}/businesses/current/branches`);
export const createBranch = (name: string) => apiFetch<BranchDto>(`${BFF}/businesses/current/branches`, { method: 'POST', body: JSON.stringify({ name }) });
export const listWarehouses = () => apiFetch<WarehouseDto[]>(`${BFF}/businesses/current/warehouses`);
export const createWarehouse = (branchId: string, name: string) =>
  apiFetch<WarehouseDto>(`${BFF}/businesses/current/warehouses`, { method: 'POST', body: JSON.stringify({ branchId, name }) });

// ── Team ─────────────────────────────────────────────────────────────────
export const listMembers = () => apiFetch<{ items: MemberDto[] }>(`${BFF}/businesses/current/members`);
export const addMember = (email: string, roleKey: string) =>
  apiFetch<MemberDto>(`${BFF}/businesses/current/members`, { method: 'POST', body: JSON.stringify({ email, roleKey }) });
export const removeMember = (userId: string) => apiFetch<void>(`${BFF}/businesses/current/members/${userId}`, { method: 'DELETE' });
export const suspendMember = (userId: string) => apiFetch<void>(`${BFF}/businesses/current/members/${userId}/suspend`, { method: 'POST', body: '{}' });
export const reactivateMember = (userId: string) => apiFetch<void>(`${BFF}/businesses/current/members/${userId}/reactivate`, { method: 'POST', body: '{}' });
export const setMemberRoles = (userId: string, roleKeys: string[]) =>
  apiFetch<void>(`${BFF}/businesses/current/members/${userId}/roles`, { method: 'PATCH', body: JSON.stringify({ roleKeys }) });
export const setMemberBranchScope = (userId: string, branchScopeMode: 'all' | 'assigned', allowedBranchIds: string[]) =>
  apiFetch<void>(`${BFF}/businesses/current/members/${userId}/branch-scope`, {
    method: 'PATCH',
    body: JSON.stringify({ branchScopeMode, allowedBranchIds }),
  });

export const listInvitations = () => apiFetch<{ items: InvitationDto[] }>(`${BFF}/businesses/current/invitations`);
export const inviteMember = (email: string, roleKey: string) =>
  apiFetch<InvitationDto>(`${BFF}/businesses/current/invitations`, { method: 'POST', body: JSON.stringify({ email, roleKey }) });
export const resendInvitation = (id: string) => apiFetch<void>(`${BFF}/businesses/current/invitations/${id}/resend`, { method: 'POST', body: '{}' });
export const cancelInvitation = (id: string) => apiFetch<void>(`${BFF}/businesses/current/invitations/${id}`, { method: 'DELETE' });

// ── Roles ────────────────────────────────────────────────────────────────
export const listRoles = () => apiFetch<{ items: RoleDto[] }>(`${BFF}/businesses/current/roles`);
export const createRole = (key: string, name: string, permissions: string[]) =>
  apiFetch<RoleDto>(`${BFF}/businesses/current/roles`, { method: 'POST', body: JSON.stringify({ key, name, permissions }) });
export const updateRole = (roleId: string, patch: { name?: string; permissions?: string[] }) =>
  apiFetch<RoleDto>(`${BFF}/businesses/current/roles/${roleId}`, { method: 'PATCH', body: JSON.stringify(patch) });
export const deleteRole = (roleId: string) => apiFetch<void>(`${BFF}/businesses/current/roles/${roleId}`, { method: 'DELETE' });

// ── Catalog ──────────────────────────────────────────────────────────────
export const listCategories = () => apiFetch<CategoryDto[]>(`${BFF}/catalog/categories`);
export const createCategory = (translations: Record<string, string>, parentId?: string) =>
  apiFetch<CategoryDto>(`${BFF}/catalog/categories`, { method: 'POST', body: JSON.stringify({ translations, parentId }) });

export const listProducts = (search?: string) =>
  apiFetch<Page<ProductListItemDto>>(`${BFF}/catalog/products${search ? `?search=${encodeURIComponent(search)}` : ''}`);
export const getProduct = (id: string) => apiFetch<ProductDto>(`${BFF}/catalog/products/${id}`);
/** §36: the client sends minor units ONLY — the server derives priceCurrency from the business base currency. */
export const createProduct = (input: { name: string; basePriceMinor: string; sku?: string; locale: string }) =>
  apiFetch<ProductDto>(`${BFF}/catalog/products`, {
    method: 'POST',
    body: JSON.stringify({ translations: { [input.locale]: input.name }, basePriceMinor: input.basePriceMinor, sku: input.sku }),
  });
export const updateProduct = (id: string, patch: Record<string, unknown>) =>
  apiFetch<ProductDto>(`${BFF}/catalog/products/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
export const archiveProduct = (id: string) => apiFetch<void>(`${BFF}/catalog/products/${id}`, { method: 'DELETE' });

// ── Entitlement (Part E §29: the endpoint is /entitlement — plan-usage does not exist) ──
export const getEntitlement = () => apiFetch<EntitlementSummaryDto>(`${BFF}/businesses/current/entitlement`);

// ── Security ─────────────────────────────────────────────────────────────
export const logoutAllSessions = () => apiFetch<void>(`${BFF}/auth/logout-all`, { method: 'POST', body: '{}' });
export const requestPasswordReset = (email: string) =>
  apiFetch<void>(`${BFF}/auth/password-reset/request`, { method: 'POST', body: JSON.stringify({ email }) });
export const completePasswordReset = (token: string, password: string) =>
  apiFetch<void>(`${BFF}/auth/password-reset/complete`, { method: 'POST', body: JSON.stringify({ token, password }) });
