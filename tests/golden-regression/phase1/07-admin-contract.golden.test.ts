import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestApp, ownerPool, uniqueEmail, type TestApp } from '../../helpers/test-app';

/**
 * Completion Directive §28–29 + §65 "Admin plan contracts": the Admin Web ↔
 * Platform API FULL CONTRACT AUDIT. Every exported call of
 * apps/admin/src/lib/admin-api.ts is exercised against the real API and its
 * response validated against the shared-contracts DTO — the admin never
 * consumes raw SQL row shapes. The plan builder is proven end-to-end:
 * create plan → draft → edit features/limits/trial → publish → clone →
 * diff → sunset → next version.
 */
const ADMIN_SRC = join(process.cwd(), 'apps/admin/src');
const CLIENT = readFileSync(join(ADMIN_SRC, 'lib/admin-api.ts'), 'utf8');

const isoDate = z.string().datetime({ offset: true });
const uuid = z.string().uuid();
const list = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item) }).strict();

const PlanVersion = z
  .object({
    id: uuid,
    planKey: z.string(),
    version: z.number().int().positive(),
    state: z.enum(['DRAFT', 'PUBLISHED', 'SUNSET']),
    trialDays: z.number().int(),
    effectiveFrom: isoDate,
    createdAt: isoDate,
    features: z.record(z.string(), z.boolean()),
    limits: z.record(z.string(), z.number().int()),
  })
  .strict();
const Plan = z.object({ key: z.string(), name: z.string(), versions: z.array(PlanVersion) }).strict();
const Diff = z
  .object({
    planKey: z.string(),
    fromVersion: z.number().int(),
    toVersion: z.number().int(),
    trialDays: z.object({ from: z.number().nullable(), to: z.number().nullable(), changed: z.boolean() }).strict(),
    features: z.array(z.object({ key: z.string(), from: z.boolean().nullable(), to: z.boolean().nullable() }).strict()),
    limits: z.array(z.object({ key: z.string(), from: z.number().nullable(), to: z.number().nullable() }).strict()),
  })
  .strict();
const Override = z
  .object({
    id: uuid,
    businessId: uuid,
    featureKey: z.string().nullable(),
    enabledValue: z.boolean().nullable(),
    limitKey: z.string().nullable(),
    limitValue: z.number().int().nullable(),
    reason: z.string(),
    actorUserId: uuid.nullable(),
    startsAt: isoDate,
    endsAt: isoDate.nullable(),
    revokedAt: isoDate.nullable(),
    revokedBy: uuid.nullable(),
    createdAt: isoDate,
  })
  .strict();
const Flag = z.object({ key: z.string(), enabled: z.boolean(), description: z.string(), updatedAt: isoDate }).strict();
const SupportSession = z
  .object({
    id: uuid,
    reason: z.string(),
    actorUserId: uuid,
    tenantId: uuid,
    businessId: uuid.nullable(),
    mode: z.literal('READ_ONLY'),
    startsAt: isoDate,
    expiresAt: isoDate,
    revokedAt: isoDate.nullable(),
    revokedReason: z.string().nullable(),
    createdAt: isoDate,
  })
  .strict();
const Tenant = z.object({ id: uuid, createdAt: isoDate, businessCount: z.number().int() }).strict();
const TenantDetail = z
  .object({
    tenant: z
      .object({
        id: uuid,
        createdAt: isoDate,
        businesses: z.array(z.object({ id: uuid, name: z.string(), storeSlug: z.string(), status: z.string() }).strict()),
      })
      .strict(),
    supportBanner: z.object({ sessionId: uuid, mode: z.literal('READ_ONLY'), expiresAt: isoDate, businessId: uuid.nullable(), message: z.string() }).strict(),
  })
  .strict();
const subscriptionState = z.enum(['trial', 'active', 'grace_period', 'past_due', 'paused', 'cancel_at_period_end', 'cancelled', 'expired', 'complimentary']);
const AdminBusiness = z
  .object({
    id: uuid,
    tenantId: uuid,
    name: z.string(),
    storeSlug: z.string(),
    baseCurrency: z.string().length(3),
    countryCode: z.string().length(2),
    status: z.string(),
    createdAt: isoDate,
    subscriptionState: subscriptionState.nullable(),
    planKey: z.string().nullable(),
    planVersion: z.number().int().nullable(),
  })
  .strict();
const BusinessDetail = AdminBusiness.extend({
  subscription: z
    .object({
      planVersionId: uuid,
      planKey: z.string(),
      planVersion: z.number().int(),
      state: subscriptionState,
      effectiveState: subscriptionState,
      trialEndsAt: isoDate.nullable(),
      periodEndsAt: isoDate.nullable(),
    })
    .strict()
    .nullable(),
  overrides: z.array(Override),
}).strict();
const AdminUser = z.object({ id: uuid, email: z.string(), displayName: z.string(), platformRole: z.string().nullable(), createdAt: isoDate }).strict();
const AuditEvent = z
  .object({
    id: uuid,
    tenantId: uuid.nullable(),
    businessId: uuid.nullable(),
    actorUserId: uuid.nullable(),
    action: z.string(),
    entity: z.string(),
    entityId: z.string().nullable(),
    requestId: z.string().nullable(),
    createdAt: isoDate,
  })
  .strict();
const Capabilities = z.object({ userId: uuid, platformRole: z.string().nullable() }).strict();

interface Audit {
  client: string;
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  body?: object;
  status: number;
  response: z.ZodTypeAny;
  check?: (body: Record<string, unknown>) => void;
}

describe('golden: admin contract', () => {
  let t: TestApp;
  let auth: Record<string, string>;
  let ownerId = '';
  let tenantId = '';
  let businessId = '';
  let planKey = '';
  let draftId = '';
  let cloneId = '';
  let overrideId = '';
  let sessionId = '';

  beforeAll(async () => {
    t = await createTestApp();
    const reg = await t.request
      .post('/v1/auth/register')
      .send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'Ops', preferredLocale: 'en' });
    auth = { Authorization: `Bearer ${(reg.body as { accessToken: string }).accessToken}` };
    ownerId = (await t.request.get('/v1/auth/me').set(auth)).body.userId as string;
    await ownerPool().query(`INSERT INTO platform_role_memberships (user_id, role_key) VALUES ($1, 'platform_owner')`, [ownerId]);
    // A merchant business the console can inspect.
    const merchant = await t.request
      .post('/v1/auth/register')
      .send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'M', preferredLocale: 'ar' });
    const onb = await t.request
      .post('/v1/onboarding/complete')
      .set('Authorization', `Bearer ${(merchant.body as { accessToken: string }).accessToken}`)
      .set('Idempotency-Key', `adm-${Date.now()}`)
      .send({ businessName: 'Console Co', countryCode: 'JO', baseCurrency: 'JOD', storeSlug: `console-${Date.now()}` });
    expect(onb.status).toBe(201);
    tenantId = (onb.body as { tenantId: string }).tenantId;
    businessId = (onb.body as { businessId: string }).businessId;
    planKey = `audit-${Date.now().toString(36)}`;
  });
  afterAll(async () => {
    await t.close();
  });

  it('P1-GOLD-39 admin pages declare no response interfaces; every call goes through the typed client', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((e) => {
        const f = join(dir, e);
        return statSync(f).isDirectory() ? walk(f) : /\.tsx?$/.test(e) ? [f] : [];
      });
    for (const file of walk(join(ADMIN_SRC, 'app'))) {
      const src = readFileSync(file, 'utf8');
      expect(src, `${file} hand-builds an admin API URL — use lib/admin-api.ts`).not.toMatch(/api\/proxy\/admin/);
      // Local UI-state interfaces are fine; API response shapes must come from shared-contracts.
      expect(src, `${file} declares a page-level response DTO`).not.toMatch(/^interface \w+(Dto|Response|Row)\b/m);
      expect(src, `${file} reads snake_case SQL row fields`).not.toMatch(/\.(created_at|business_id|tenant_id|plan_key|trial_days|store_slug|actor_user_id)\b/);
    }
    expect(CLIENT).toContain("const ADMIN = '/api/proxy/admin'");
    expect(CLIENT).not.toMatch(/api\/proxy\/v1/);
  });

  it('P1-GOLD-40 FULL ADMIN CONTRACT AUDIT + plan builder end-to-end (§29)', async () => {
    const audits: (() => Audit)[] = [
      () => ({ client: 'listTenants', method: 'GET', path: 'tenants', status: 200, response: list(Tenant) }),
      () => ({ client: 'listBusinesses', method: 'GET', path: 'businesses', status: 200, response: list(AdminBusiness) }),
      () => ({
        client: 'getBusinessDetail',
        method: 'GET',
        path: `businesses/${businessId}`,
        status: 200,
        response: BusinessDetail,
        check: (b) => expect((b.subscription as { planKey: string }).planKey).toBe('free'),
      }),
      () => ({ client: 'listUsers', method: 'GET', path: 'users', status: 200, response: list(AdminUser) }),
      () => ({
        client: 'getCapabilities',
        method: 'GET',
        path: `capabilities/${ownerId}`,
        status: 200,
        response: Capabilities,
        check: (b) => expect(b.platformRole).toBe('platform_owner'),
      }),
      () => ({
        client: 'grantPlatformRole',
        method: 'POST',
        path: 'platform-roles',
        body: { userId: ownerId, roleKey: 'platform_owner' },
        status: 200,
        response: Capabilities,
      }),
      // ── Plan builder ──
      () => ({
        client: 'createPlan',
        method: 'POST',
        path: 'plans',
        body: { key: planKey, name: 'Audit Plan' },
        status: 201,
        response: Plan,
        check: (b) => {
          const v = (b.versions as { id: string; state: string; version: number }[])[0];
          expect(v?.state).toBe('DRAFT');
          expect(v?.version).toBe(1);
          draftId = v?.id ?? '';
        },
      }),
      () => ({
        client: 'updateDraftPlanVersion',
        method: 'PATCH',
        path: `plan-versions/${draftId}`,
        body: { features: { MULTI_BRANCH: true, CUSTOM_ROLES: false }, limits: { MAX_USERS: 3, MAX_BRANCHES: 2 }, trialDays: 21 },
        status: 200,
        response: PlanVersion,
        check: (b) => {
          expect(b.trialDays).toBe(21);
          expect(b.features).toEqual({ MULTI_BRANCH: true, CUSTOM_ROLES: false });
          expect(b.limits).toEqual({ MAX_USERS: 3, MAX_BRANCHES: 2 });
        },
      }),
      () => ({
        client: 'publishPlanVersion',
        method: 'POST',
        path: `plan-versions/${draftId}/publish`,
        body: {},
        status: 200,
        response: PlanVersion,
        check: (b) => expect(b.state).toBe('PUBLISHED'),
      }),
      () => ({
        client: 'createPlanVersion',
        method: 'POST',
        path: 'plan-versions',
        body: { planKey, features: { CUSTOM_ROLES: true }, limits: { MAX_USERS: 5 }, trialDays: 30 },
        status: 201,
        response: PlanVersion,
        check: (b) => {
          expect(b.version).toBe(2);
          expect(b.state).toBe('DRAFT');
          expect((b.features as Record<string, boolean>)['MULTI_BRANCH']).toBe(true);
          expect((b.limits as Record<string, number>)['MAX_BRANCHES']).toBe(2);
          cloneId = b.id as string;
        },
      }),
      () => ({
        client: 'diffPlanVersions',
        method: 'GET',
        path: `plans/${planKey}/versions/diff?from=1&to=2`,
        status: 200,
        response: Diff,
        check: (b) => {
          expect((b.trialDays as { changed: boolean }).changed).toBe(true);
          expect(b.features).toEqual([{ key: 'CUSTOM_ROLES', from: false, to: true }]);
          expect(b.limits).toEqual([{ key: 'MAX_USERS', from: 3, to: 5 }]);
        },
      }),
      () => ({
        client: 'listPlans',
        method: 'GET',
        path: 'plans',
        status: 200,
        response: list(Plan),
        check: (b) => {
          const p = (b.items as { key: string; versions: unknown[] }[]).find((x) => x.key === planKey);
          expect(p?.versions).toHaveLength(2);
        },
      }),
      () => ({
        client: 'sunsetPlanVersion',
        method: 'POST',
        path: `plan-versions/${draftId}/sunset`,
        body: {},
        status: 200,
        response: PlanVersion,
        check: (b) => expect(b.state).toBe('SUNSET'),
      }),
      // ── Overrides / flags ──
      () => ({
        client: 'createOverride',
        method: 'POST',
        path: 'entitlement-overrides',
        body: { businessId, limitKey: 'MAX_PRODUCTS', limitValue: 500, reason: 'audit fixture' },
        status: 201,
        response: Override,
        check: (b) => {
          overrideId = b.id as string;
        },
      }),
      () => ({ client: 'listOverrides', method: 'GET', path: 'entitlement-overrides', status: 200, response: list(Override) }),
      () => ({
        client: 'revokeOverride',
        method: 'POST',
        path: `entitlement-overrides/${overrideId}/revoke`,
        body: { reason: 'audit done' },
        status: 200,
        response: Override,
        check: (b) => expect(b.revokedAt).not.toBeNull(),
      }),
      () => ({
        client: 'setFeatureFlag',
        method: 'POST',
        path: 'feature-flags',
        body: { key: 'AUDIT_FLAG', enabled: true, description: 'audit' },
        status: 200,
        response: Flag,
      }),
      () => ({ client: 'listFeatureFlags', method: 'GET', path: 'feature-flags', status: 200, response: list(Flag) }),
      // ── Support sessions ──
      () => ({
        client: 'getTenantDetail',
        method: 'GET',
        path: `tenants/${tenantId}`,
        status: 403,
        response: z.object({ error: z.object({ code: z.literal('FORBIDDEN') }) }),
      }),
      () => ({
        client: 'createSupportSession',
        method: 'POST',
        path: 'support-sessions',
        body: { tenantId, businessId, reason: 'contract audit session', expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() },
        status: 201,
        response: SupportSession,
        check: (b) => {
          sessionId = b.id as string;
        },
      }),
      () => ({
        client: 'getTenantDetail',
        method: 'GET',
        path: `tenants/${tenantId}`,
        status: 200,
        response: TenantDetail,
        check: (b) => expect((b.supportBanner as { businessId: string }).businessId).toBe(businessId),
      }),
      () => ({ client: 'listSupportSessions', method: 'GET', path: 'support-sessions', status: 200, response: list(SupportSession) }),
      () => ({
        client: 'revokeSupportSession',
        method: 'POST',
        path: `support-sessions/${sessionId}/revoke`,
        body: { reason: 'audit done' },
        status: 200,
        response: SupportSession,
        check: (b) => expect(b.revokedAt).not.toBeNull(),
      }),
      () => ({ client: 'listAuditEvents', method: 'GET', path: 'audit-events', status: 200, response: list(AuditEvent) }),
    ];

    const audited = new Set<string>();
    for (const make of audits) {
      const a = make();
      audited.add(a.client);
      expect(CLIENT, `client function ${a.client} must exist`).toMatch(new RegExp(`export const ${a.client} = `));
      let req = t.request[a.method.toLowerCase() as 'get' | 'post' | 'patch'](`/v1/admin/${a.path}`).set(auth);
      if (a.method !== 'GET') req = req.set('Idempotency-Key', `adm-${a.client}-${Date.now()}`);
      const res = a.body !== undefined ? await req.send(a.body) : await req;
      expect(res.status, `${a.client}: ${a.method} /v1/admin/${a.path} → ${JSON.stringify(res.body)}`).toBe(a.status);
      const parsed = a.response.safeParse(res.body);
      expect(
        parsed.success,
        `${a.client}: response DTO mismatch ${JSON.stringify(parsed.success ? null : parsed.error.issues)} for ${JSON.stringify(res.body)}`,
      ).toBe(true);
      a.check?.(res.body as Record<string, unknown>);
    }

    const exported = [...CLIENT.matchAll(/^export const (\w+) = /gm)].map((m) => m[1] as string);
    expect(
      exported.filter((n) => !audited.has(n)),
      'admin client functions without an audit row',
    ).toEqual([]);
    const auditedPaths = new Set(
      audits.map((m) =>
        m()
          .path.replace(/\?.*$/, '')
          .replace(/[0-9a-f-]{36}/g, ':id')
          .replace(planKey, ':id'),
      ),
    );
    const templates = [...CLIENT.matchAll(/\$\{ADMIN\}\/((?:[a-zA-Z0-9/-]|\$\{[a-zA-Z0-9_.]+\})+)/g)].map((m) =>
      (m[1] as string).replace(/\$\{[^}]+\}/g, ':id'),
    );
    for (const tpl of templates) expect(auditedPaths.has(tpl), `admin client path ${tpl} is not audited`).toBe(true);

    // Published versions are immutable through the edit endpoint too (DB + service).
    const edit = await t.request.patch(`/v1/admin/plan-versions/${cloneId}`).set(auth).send({ trialDays: 7 });
    expect(edit.status).toBe(200);
    const publish = await t.request.post(`/v1/admin/plan-versions/${cloneId}/publish`).set(auth).send({});
    expect(publish.status).toBe(200);
    const frozen = await t.request.patch(`/v1/admin/plan-versions/${cloneId}`).set(auth).send({ trialDays: 9 });
    expect(frozen.status).toBe(409);
  });
});
