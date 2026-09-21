import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestApp, grantFeature, raiseLimit, uniqueEmail, type TestApp } from '../../helpers/test-app';

/**
 * Stabilization Part D/E/N §24–27, §69 + Completion Directive §25–27:
 * Merchant Web ↔ API FULL CONTRACT AUDIT.
 * (1) ONE path convention — the BFF proxy prepends /v1 exactly once; no
 *     page may hand-build a /v1 URL (the double-/v1 bug class).
 * (2) EVERY typed client call is audited: method, path, query, request
 *     body, headers (Idempotency-Key on mutations), response wrapper,
 *     response DTO and error contract — against the REAL API.
 * (3) The audit table and apps/web/src/lib/merchant-api.ts are kept in sync
 *     mechanically: every path template in the client must be audited.
 */

const WEB_SRC = join(process.cwd(), 'apps/web/src');
const CLIENT = readFileSync(join(WEB_SRC, 'lib/merchant-api.ts'), 'utf8');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

// ── DTO validators (mirror @daftar/shared-contracts exactly) ────────────────
const locale = z.enum(['ar', 'en', 'tr']);
const isoDate = z.string().datetime({ offset: true });
const minor = z.string().regex(/^-?\d+$/); // money = minor-units string
const ack = z.object({ ok: z.literal(true) }).strict();
const list = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item) }).strict();
const page = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item), nextCursor: z.string().nullable() }).strict();
const apiError = z
  .object({ error: z.object({ code: z.string(), message: z.string(), requestId: z.string(), details: z.record(z.string(), z.unknown()).optional() }).strict() })
  .strict();

const BusinessSummary = z
  .object({
    businessId: z.string().uuid(),
    tenantId: z.string().uuid(),
    name: z.string(),
    storeSlug: z.string(),
    countryCode: z.string().length(2),
    baseCurrency: z.string().length(3),
    industryProfileKey: z.string(),
    defaultLocale: locale,
    enabledLocales: z.array(locale),
    timezone: z.string(),
    storefrontLocale: locale,
    roleKey: z.string(),
  })
  .strict();
const BusinessSettings = BusinessSummary.extend({ baseCurrencyLocked: z.boolean(), createdAt: isoDate }).strict();
const Branch = z.object({ id: z.string().uuid(), name: z.string(), isDefault: z.boolean() }).strict();
const Warehouse = z.object({ id: z.string().uuid(), branchId: z.string().uuid(), name: z.string(), isDefault: z.boolean() }).strict();
const Member = z
  .object({
    userId: z.string().uuid(),
    email: z.string().nullable(),
    displayName: z.string(),
    roleKeys: z.array(z.string()),
    status: z.enum(['invited', 'active', 'suspended', 'removed']),
    joinedAt: isoDate.nullable(),
    branchScopeMode: z.enum(['all', 'assigned']),
    allowedBranchIds: z.array(z.string().uuid()),
  })
  .strict();
const Invitation = z
  .object({
    id: z.string().uuid(),
    email: z.string(),
    roleKey: z.string(),
    status: z.enum(['pending', 'accepted', 'cancelled', 'expired']),
    expiresAt: isoDate,
    createdAt: isoDate,
    deliveryStatus: z.enum(['pending', 'processing', 'sent', 'failed', 'dead']),
    deliveryAttempts: z.number().int(),
  })
  .strict();
const Role = z.object({ id: z.string().uuid(), key: z.string(), name: z.string(), isSystem: z.boolean(), permissions: z.array(z.string()) }).strict();
const Category = z.object({ id: z.string().uuid(), parentId: z.string().uuid().nullable(), translations: z.partialRecord(locale, z.string()) }).strict();
const ProductListItem = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    sku: z.string().nullable(),
    basePriceMinor: minor,
    priceCurrency: z.string().length(3),
    status: z.enum(['active', 'archived']),
  })
  .strict();
const Media = z
  .object({
    id: z.string().uuid(),
    url: z.string().regex(/^\/v1\/catalog\/media\/[0-9a-f-]{36}\/access-url$/),
    variants: z.array(
      z
        .object({
          size: z.number().int(),
          url: z.string().regex(/^\/v1\/catalog\/media\/[0-9a-f-]{36}\/access-url\?variant=w\d+$/),
          width: z.number().int(),
          height: z.number().int(),
        })
        .strict(),
    ),
  })
  .strict();
const Variant = z
  .object({
    id: z.string().uuid(),
    attributes: z.record(z.string(), z.string()),
    sku: z.string().nullable(),
    barcode: z.string().nullable(),
    priceMinor: minor.nullable(),
  })
  .strict();
const Product = ProductListItem.extend({
  translations: z.partialRecord(locale, z.string()),
  categoryId: z.string().uuid().nullable(),
  barcode: z.string().nullable(),
  unit: z.string().nullable(),
  version: z.number().int().positive(),
  variants: z.array(Variant),
  media: z.array(Media),
}).strict();
const Entitlement = z
  .object({
    planKey: z.string(),
    planVersion: z.number().int(),
    state: z.string(),
    effectiveState: z.string(),
    trialEndsAt: isoDate.nullable(),
    periodEndsAt: isoDate.nullable(),
    features: z.array(z.object({ key: z.string(), enabled: z.boolean() }).strict()),
    limits: z.array(z.object({ key: z.string(), limit: z.number().int(), usage: z.number().int() }).strict()),
  })
  .strict();
const Country = z.object({ code: z.string().length(2), name: z.string(), recommendedCurrencies: z.array(z.string()), phoneCountryCode: z.string() }).strict();
const Currency = z.object({ code: z.string().length(3), name: z.string(), minorUnits: z.number().int() }).strict();
const SlugAvailability = z.object({ slug: z.string(), available: z.boolean(), suggestions: z.array(z.string()) }).strict();
const OnboardingResult = z.object({ businessId: z.string().uuid(), tenantId: z.string().uuid(), storeSlug: z.string(), replayed: z.boolean() }).strict();
const MediaUpload = z.object({ id: z.string().uuid(), url: z.string().regex(/^\/v1\/catalog\/media\/[0-9a-f-]{36}\/access-url$/) }).strict();
const MediaAccess = z.object({ url: z.string().min(1), expiresInSeconds: z.number().int().positive() }).strict();

interface Audit {
  client: string; // exported function name in merchant-api.ts
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string; // API path under /v1 — `:x` marks a path param the client interpolates
  body?: unknown;
  multipart?: boolean;
  status: number;
  response: z.ZodTypeAny;
}

describe('golden: web contract', () => {
  let t: TestApp;
  let auth: Record<string, string>;
  let scoped: Record<string, string>;
  let tenantId = '';
  let branchId = '';
  let memberUserId = '';
  let memberEmail = '';
  let invitationId = '';
  let roleId = '';
  let productId = '';
  let mediaId = '';

  beforeAll(async () => {
    t = await createTestApp();
    const reg = await t.request.post('/v1/auth/register').send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'W', preferredLocale: 'en' });
    auth = { Authorization: `Bearer ${(reg.body as { accessToken: string }).accessToken}` };
    const onb = await t.request
      .post('/v1/onboarding/complete')
      .set(auth)
      .set('Idempotency-Key', `webc-${Date.now()}`)
      .send({ businessName: 'Web Contract Co', countryCode: 'JO', baseCurrency: 'JOD', storeSlug: `wc-${Date.now()}`, timezone: 'Asia/Amman' });
    expect(onb.status).toBe(201);
    tenantId = (onb.body as { tenantId: string }).tenantId;
    const businessId = (onb.body as { businessId: string }).businessId;
    scoped = { ...auth, 'X-Business-Id': businessId };
    // Branch creation is a MULTI_BRANCH feature — granted via a platform override fixture.
    const me = (await t.request.get('/v1/auth/me').set(auth)).body as { userId: string };
    await grantFeature(businessId, me.userId, 'MULTI_BRANCH');
    await grantFeature(businessId, me.userId, 'CUSTOM_ROLES');
    await raiseLimit(businessId, me.userId, 'MAX_BRANCHES', 5);
    // A second registered identity to add as a member.
    const other = await t.request
      .post('/v1/auth/register')
      .send({ email: (memberEmail = uniqueEmail()), password: 'Str0ng!Passw0rd', displayName: 'Member', preferredLocale: 'ar' });
    memberUserId = (await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${(other.body as { accessToken: string }).accessToken}`)).body
      .userId as string;
  });
  afterAll(async () => {
    await t.close();
  });

  it('P1-GOLD-37 the BFF proxy prepends /v1 exactly once; pages never hand-build /v1 URLs', () => {
    const proxy = readFileSync(join(WEB_SRC, 'app/api/proxy/[...path]/route.ts'), 'utf8');
    expect(proxy).toContain('/v1/${path.join');
    for (const file of walk(join(WEB_SRC, 'app/[locale]'))) {
      const src = readFileSync(file, 'utf8');
      expect(src, `${file} must not contain the double-/v1 pattern`).not.toMatch(/api\/proxy\/v1|\$\{API_URL\}\/v1/);
      // §27: pages never declare their own response DTO interfaces.
      expect(src, `${file} declares a page-level response interface — use @daftar/shared-contracts`).not.toMatch(/^interface \w+Dto\b/m);
    }
    expect(CLIENT).not.toMatch(/\$\{BFF\}\/v1|api\/proxy\/v1/);
    expect(CLIENT).toContain("const BFF = '/api/proxy'");
  });

  it('P1-GOLD-38 FULL CONTRACT AUDIT: every merchant client call — method, path, body, headers, wrapper, DTO', async () => {
    const otherEmail = (await t.request.get('/v1/auth/me').set(auth)).body.email as string;
    void otherEmail;
    const png = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .png()
      .toBuffer();

    // Order matters: later rows use ids captured from earlier responses.
    const audits: (() => Audit)[] = [
      () => ({ client: 'getCountries', method: 'GET', path: 'platform/countries', status: 200, response: list(Country) }),
      () => ({ client: 'getCurrencies', method: 'GET', path: 'platform/currencies', status: 200, response: list(Currency) }),
      () => ({
        client: 'checkSlugAvailability',
        method: 'GET',
        path: 'onboarding/slug-availability?slug=golden-contract',
        status: 200,
        response: SlugAvailability,
      }),
      () => ({
        client: 'completeOnboarding',
        method: 'POST',
        path: 'onboarding/complete',
        body: { businessName: 'Second', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `wc2-${Date.now()}`, preferredLocale: 'ar' },
        status: 201,
        response: OnboardingResult,
      }),
      () => ({
        client: 'createBusinessInTenant',
        method: 'POST',
        path: `tenants/${tenantId}/businesses`,
        body: { businessName: 'Third', countryCode: 'TR', baseCurrency: 'TRY', storeSlug: `wc3-${Date.now()}`, preferredLocale: 'tr' },
        status: 201,
        response: OnboardingResult,
      }),
      () => ({ client: 'getMyBusinesses', method: 'GET', path: 'me/businesses', status: 200, response: list(BusinessSummary) }),
      () => ({ client: 'getCurrentBusiness', method: 'GET', path: 'businesses/current', status: 200, response: BusinessSettings }),
      () => ({
        client: 'updateCurrentBusiness',
        method: 'PATCH',
        path: 'businesses/current',
        body: { name: 'Web Contract Co 2', defaultLocale: 'en' },
        status: 200,
        response: BusinessSettings,
      }),
      () => ({ client: 'changeBaseCurrency', method: 'POST', path: 'businesses/current/base-currency', body: { currency: 'JOD' }, status: 201, response: ack }),
      () => ({ client: 'listBranches', method: 'GET', path: 'businesses/current/branches', status: 200, response: list(Branch) }),
      () => ({ client: 'createBranch', method: 'POST', path: 'businesses/current/branches', body: { name: 'Second branch' }, status: 201, response: Branch }),
      () => ({ client: 'listWarehouses', method: 'GET', path: 'businesses/current/warehouses', status: 200, response: list(Warehouse) }),
      () => ({
        client: 'createWarehouse',
        method: 'POST',
        path: 'businesses/current/warehouses',
        body: { branchId, name: 'Back room' },
        status: 201,
        response: Warehouse,
      }),
      () => ({ client: 'listMembers', method: 'GET', path: 'businesses/current/members', status: 200, response: list(Member) }),
      () => ({
        client: 'addMember',
        method: 'POST',
        path: 'businesses/current/members',
        body: { email: memberEmail, roleKey: 'cashier' },
        status: 201,
        response: Member,
      }),
      () => ({
        client: 'setMemberRoles',
        method: 'PATCH',
        path: `businesses/current/members/${memberUserId}/roles`,
        body: { roleKeys: ['manager'] },
        status: 200,
        response: ack,
      }),
      () => ({
        client: 'setMemberBranchScope',
        method: 'PATCH',
        path: `businesses/current/members/${memberUserId}/branch-scope`,
        body: { mode: 'assigned', branchIds: [branchId] },
        status: 200,
        response: ack,
      }),
      () => ({ client: 'suspendMember', method: 'POST', path: `businesses/current/members/${memberUserId}/suspend`, body: {}, status: 200, response: ack }),
      () => ({
        client: 'reactivateMember',
        method: 'POST',
        path: `businesses/current/members/${memberUserId}/reactivate`,
        body: {},
        status: 200,
        response: ack,
      }),
      () => ({ client: 'removeMember', method: 'DELETE', path: `businesses/current/members/${memberUserId}`, status: 200, response: ack }),
      () => ({ client: 'listInvitations', method: 'GET', path: 'businesses/current/invitations', status: 200, response: list(Invitation) }),
      () => ({
        client: 'inviteMember',
        method: 'POST',
        path: 'businesses/current/invitations',
        body: { email: uniqueEmail(), roleKey: 'cashier' },
        status: 201,
        response: Invitation,
      }),
      () => ({
        client: 'resendInvitation',
        method: 'POST',
        path: `businesses/current/invitations/${invitationId}/resend`,
        body: {},
        status: 200,
        response: ack,
      }),
      () => ({ client: 'cancelInvitation', method: 'DELETE', path: `businesses/current/invitations/${invitationId}`, status: 200, response: ack }),
      () => ({ client: 'listRoles', method: 'GET', path: 'businesses/current/roles', status: 200, response: list(Role) }),
      () => ({
        client: 'createRole',
        method: 'POST',
        path: 'businesses/current/roles',
        body: { key: 'auditor', name: 'Auditor', permissions: ['catalog.view'] },
        status: 201,
        response: Role,
      }),
      () => ({ client: 'updateRole', method: 'PATCH', path: `businesses/current/roles/${roleId}`, body: { name: 'Auditor 2' }, status: 200, response: Role }),
      () => ({ client: 'deleteRole', method: 'DELETE', path: `businesses/current/roles/${roleId}`, body: {}, status: 200, response: ack }),
      () => ({ client: 'listCategories', method: 'GET', path: 'catalog/categories', status: 200, response: list(Category) }),
      () => ({
        client: 'createCategory',
        method: 'POST',
        path: 'catalog/categories',
        body: { translations: { en: 'Drinks', ar: 'مشروبات' } },
        status: 201,
        response: Category,
      }),
      () => ({ client: 'listProducts', method: 'GET', path: 'catalog/products?search=Contract', status: 200, response: page(ProductListItem) }),
      () => ({
        client: 'createProduct',
        method: 'POST',
        path: 'catalog/products',
        body: { translations: { en: 'Contract Product' }, basePriceMinor: '1250', sku: 'CP-1' },
        status: 201,
        response: Product,
      }),
      () => ({ client: 'getProduct', method: 'GET', path: `catalog/products/${productId}`, status: 200, response: Product }),
      () => ({
        client: 'updateProduct',
        method: 'PATCH',
        path: `catalog/products/${productId}`,
        body: { basePriceMinor: '1300', version: 1 },
        status: 200,
        response: Product,
      }),
      () => ({ client: 'uploadMedia', method: 'POST', path: 'catalog/media', multipart: true, status: 201, response: MediaUpload }),
      () => ({ client: 'attachMedia', method: 'POST', path: `catalog/products/${productId}/media/${mediaId}`, body: {}, status: 201, response: ack }),
      () => ({ client: 'getMediaAccessUrl', method: 'GET', path: `catalog/media/${mediaId}/access-url`, status: 200, response: MediaAccess }),
      () => ({ client: 'archiveProduct', method: 'DELETE', path: `catalog/products/${productId}`, status: 200, response: ack }),
      () => ({ client: 'getEntitlement', method: 'GET', path: 'businesses/current/entitlement', status: 200, response: Entitlement }),
      () => ({
        client: 'requestPasswordReset',
        method: 'POST',
        path: 'auth/password-reset/request',
        body: { email: uniqueEmail() },
        status: 201,
        response: ack,
      }),
      () => ({
        client: 'completePasswordReset',
        method: 'POST',
        path: 'auth/password-reset/complete',
        body: { token: 'x'.repeat(40), password: 'N3w!Passw0rd-long' },
        status: 400,
        response: apiError,
      }),
      () => ({ client: 'acceptInvitation', method: 'POST', path: 'invitations/accept', body: { token: 'nope-nope-nope' }, status: 404, response: apiError }),
      () => ({ client: 'logoutAllSessions', method: 'POST', path: 'auth/logout-all', body: {}, status: 201, response: ack }),
    ];

    // Error contract: a business-scoped call without permission carries the stable error envelope.
    const forbidden = await t.request
      .post('/v1/catalog/products')
      .set(scoped)
      .send({ translations: { en: 'x' }, basePriceMinor: '1', priceCurrency: 'USD' });
    expect(forbidden.status).toBe(400);
    expect(apiError.safeParse(forbidden.body).success).toBe(true);
    // Idempotency-Key is REQUIRED on creation commands.
    const noKey = await t.request
      .post('/v1/onboarding/complete')
      .set(auth)
      .send({ businessName: 'x', countryCode: 'JO', baseCurrency: 'JOD', storeSlug: 'no-key-x' });
    expect(noKey.status).toBe(400);

    const audited = new Set<string>();
    for (const make of audits) {
      const a = make();
      audited.add(a.client);
      expect(CLIENT, `client function ${a.client} must exist`).toMatch(new RegExp(`export const ${a.client} = `));
      let req = t.request[a.method.toLowerCase() as 'get' | 'post' | 'patch' | 'delete'](`/v1/${a.path}`).set(scoped);
      if (a.method !== 'GET') req = req.set('Idempotency-Key', `audit-${a.client}-${Date.now()}`);
      const res = a.multipart
        ? await req.attach('file', png, { filename: 'p.png', contentType: 'image/png' })
        : a.body !== undefined
          ? await req.send(a.body as object)
          : await req;
      expect(res.status, `${a.client}: ${a.method} /v1/${a.path} → ${JSON.stringify(res.body)}`).toBe(a.status);
      const parsed = a.response.safeParse(res.body);
      expect(
        parsed.success,
        `${a.client}: response DTO mismatch ${JSON.stringify(parsed.success ? null : parsed.error.issues)} for ${JSON.stringify(res.body)}`,
      ).toBe(true);
      const body = res.body as Record<string, unknown>;
      if (a.client === 'createBranch') branchId = body.id as string;
      if (a.client === 'inviteMember') invitationId = body.id as string;
      if (a.client === 'createRole') roleId = body.id as string;
      if (a.client === 'createProduct') productId = body.id as string;
      if (a.client === 'uploadMedia') mediaId = body.id as string;
      if (a.client === 'addMember') memberUserId = body.userId as string;
    }

    // (3) Mechanical sync: every exported client call is audited, and every
    // path template in the client resolves to an audited path.
    const exported = [...CLIENT.matchAll(/^export const (\w+) = /gm)].map((m) => m[1] as string);
    const missing = exported.filter((name) => !audited.has(name));
    expect(missing, 'client functions without an audit row').toEqual([]);
    const auditedPaths = new Set(
      audits.map((m) =>
        m()
          .path.replace(/\?.*$/, '')
          .replace(/[0-9a-f-]{36}/g, ':id'),
      ),
    );
    // Path templates: literal segments + `${param}` interpolations; optional
    // query-string tails (`${search ? ... : ''}`) are not part of the path.
    const templates = [...CLIENT.matchAll(/\$\{BFF\}\/((?:[a-zA-Z0-9/-]|\$\{[a-zA-Z0-9_.]+\})+)/g)].map((m) => (m[1] as string).replace(/\$\{[^}]+\}/g, ':id'));
    for (const tpl of templates) {
      expect(auditedPaths.has(tpl), `client path ${tpl} is not audited`).toBe(true);
    }
  });
});
