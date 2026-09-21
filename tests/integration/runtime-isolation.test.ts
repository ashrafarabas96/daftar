import { describe, expect, it, afterEach } from 'vitest';
import supertest from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { MerchantApiModule } from '../../apps/api/src/app/merchant-api.module';
import { PlatformApiModule } from '../../apps/api/src/app/platform-api.module';
import { WorkerModule } from '../../apps/api/src/app/worker.module';
import { loadConfig } from '../../apps/api/src/config';
import { Database } from '../../apps/api/src/infra/database';
import { AdminController } from '../../apps/api/src/modules/admin/admin.controller';
import { AdminService } from '../../apps/api/src/modules/admin/admin.service';
import { CatalogService } from '../../apps/api/src/modules/catalog/catalog.service';
import { TenancyService } from '../../apps/api/src/modules/tenancy/tenancy.service';
import { CredentialDeliveryWorker } from '../../apps/api/src/modules/delivery/delivery-worker.service';
import { CredentialPayloadProtector } from '../../apps/api/src/modules/delivery/credential-protector';
import { OutboxPublisher } from '../../apps/api/src/modules/outbox/publisher';
import { TokenService } from '../../apps/api/src/modules/auth/tokens';
import { appDbUrl, ensurePostgres, identityDbUrl, platformDbUrl, provisionerDbUrl, resolverDbUrl, workerDbUrl } from '../helpers/test-app';

/**
 * Directive §15–20 — REAL RUNTIME PROCESS ISOLATION, proven by booting the
 * ACTUAL per-process modules (not AppModule with flags) and checking what
 * exists and what does not. "Absent" means: the provider cannot be resolved
 * from the container AND the route does not exist on the HTTP surface.
 */
const JWT = 'test-secret-key-with-at-least-32-characters!';
const apps: INestApplication[] = [];
afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});

function absent(get: () => unknown): boolean {
  try {
    get();
    return false;
  } catch {
    return true;
  }
}

describe('runtime process isolation (§15–20)', () => {
  it('MERCHANT process: admin routes absent, platform pool absent, worker + decrypt ring absent', async () => {
    await ensurePostgres();
    const config = loadConfig({
      NODE_ENV: 'test',
      PROCESS_MODE: 'merchant-api',
      APP_DATABASE_URL: appDbUrl,
      IDENTITY_DATABASE_URL: identityDbUrl,
      RESOLVER_DATABASE_URL: resolverDbUrl,
      PROVISIONER_DATABASE_URL: provisionerDbUrl,
      // Present in the environment but OUTSIDE merchant authority: a merchant
      // process must not open these pools even when handed the URLs.
      PLATFORM_DATABASE_URL: platformDbUrl,
      WORKER_DATABASE_URL: workerDbUrl,
      JWT_SECRET: JWT,
      MEDIA_ROOT: '/tmp/daftar-test-media',
      PORT: '0',
    });
    const ref = await Test.createTestingModule({ imports: [MerchantApiModule.register({ config })] }).compile();
    const app = ref.createNestApplication();
    apps.push(app);
    await app.init();
    const req = supertest(app.getHttpServer());

    // Surfaces that MUST exist.
    expect((await req.get('/v1/health/live')).status).toBe(200);
    expect((await req.get('/v1/platform/countries')).status).toBe(200);
    expect((await req.get('/v1/me/businesses')).status).toBe(401); // exists, needs auth
    expect((await req.post('/v1/catalog/products').send({})).status).toBe(401);

    // Surfaces that MUST NOT exist: admin routes are 404, not 401/403.
    for (const path of ['/v1/admin/tenants', '/v1/admin/plans', '/v1/admin/support-sessions', '/v1/admin/audit-events']) {
      expect((await req.get(path)).status, `${path} must be absent`).toBe(404);
    }
    expect((await req.post('/v1/admin/plan-versions').send({})).status).toBe(404);

    // Container: admin/worker/decrypt providers are not composed at all.
    expect(absent(() => ref.get(AdminController))).toBe(true);
    expect(absent(() => ref.get(AdminService))).toBe(true);
    expect(absent(() => ref.get(CredentialDeliveryWorker))).toBe(true);
    expect(absent(() => ref.get(CredentialPayloadProtector))).toBe(true);
    expect(absent(() => ref.get(OutboxPublisher))).toBe(true);
    expect(absent(() => ref.get('CREDENTIAL_DELIVERY'))).toBe(true);

    // Pools: platform + worker are NOT opened even though their URLs were supplied.
    const db = ref.get(Database);
    expect(db.ownedPools().sort()).toEqual(['app', 'identity', 'provisioner', 'resolver']);
    await expect(db.withPlatformTransaction(async () => 1)).rejects.toThrow(/not configured/);
    await expect(db.withWorkerTransaction(async () => 1)).rejects.toThrow(/not configured/);
  });

  it('PLATFORM process: admin works, merchant mutation surface absent, worker absent, business context refused', async () => {
    await ensurePostgres();
    const config = loadConfig({
      NODE_ENV: 'test',
      PROCESS_MODE: 'platform-api',
      PLATFORM_DATABASE_URL: platformDbUrl,
      IDENTITY_DATABASE_URL: identityDbUrl,
      // Outside platform authority — must not be opened.
      APP_DATABASE_URL: appDbUrl,
      RESOLVER_DATABASE_URL: resolverDbUrl,
      PROVISIONER_DATABASE_URL: provisionerDbUrl,
      WORKER_DATABASE_URL: workerDbUrl,
      JWT_SECRET: JWT,
      PORT: '0',
    });
    const ref = await Test.createTestingModule({ imports: [PlatformApiModule.register({ config })] }).compile();
    const app = ref.createNestApplication();
    apps.push(app);
    await app.init();
    const req = supertest(app.getHttpServer());

    // Admin surface exists (guarded), shared identity exists.
    expect((await req.get('/v1/health/live')).status).toBe(200);
    expect((await req.get('/v1/health/ready')).status).toBe(200);
    expect((await req.get('/v1/admin/tenants')).status).toBe(401);
    expect((await req.post('/v1/auth/login').send({ email: 'nobody@test.daftar.local', password: 'not-the-password-123' })).status).toBe(401);

    // Merchant mutation + read surfaces are ABSENT (404), not merely forbidden.
    for (const [method, path] of [
      ['post', '/v1/onboarding/complete'],
      ['post', '/v1/catalog/products'],
      ['post', '/v1/catalog/media'],
      ['post', '/v1/businesses/current/members'],
      ['patch', '/v1/businesses/current'],
      ['get', '/v1/catalog/products'],
      ['get', '/v1/me/businesses'],
      ['get', '/v1/businesses/current/entitlement'],
      ['get', '/v1/platform/countries'],
    ] as const) {
      expect((await req[method](path).send({})).status, `${method.toUpperCase()} ${path} must be absent`).toBe(404);
    }

    expect(absent(() => ref.get(CatalogService))).toBe(true);
    expect(absent(() => ref.get(TenancyService))).toBe(true);
    expect(absent(() => ref.get(CredentialDeliveryWorker))).toBe(true);
    expect(absent(() => ref.get(CredentialPayloadProtector))).toBe(true);
    expect(absent(() => ref.get('OBJECT_STORAGE'))).toBe(true);
    expect(absent(() => ref.get('CREDENTIAL_DELIVERY'))).toBe(true);

    const db = ref.get(Database);
    expect(db.ownedPools().sort()).toEqual(['identity', 'platform']);
    await expect(db.withTransaction({}, async () => 1)).rejects.toThrow(/not configured/);
    await expect(db.withProvisionerTransaction(null, async () => 1)).rejects.toThrow(/not configured/);
    await expect(db.withWorkerTransaction(async () => 1)).rejects.toThrow(/not configured/);
  });

  it('WORKER process: no HTTP routes at all; owns worker pool + decrypt ring + delivery only', async () => {
    await ensurePostgres();
    const config = loadConfig({
      NODE_ENV: 'test',
      PROCESS_MODE: 'worker',
      WORKER_DATABASE_URL: workerDbUrl,
      // Outside worker authority — must not be opened even when supplied.
      APP_DATABASE_URL: appDbUrl,
      PLATFORM_DATABASE_URL: platformDbUrl,
      IDENTITY_DATABASE_URL: identityDbUrl,
      PORT: '0',
    });
    const ref = await Test.createTestingModule({ imports: [WorkerModule.register({ config })] }).compile();
    const app = ref.createNestApplication();
    apps.push(app);
    await app.init();
    const req = supertest(app.getHttpServer());

    // NO HTTP surface: not even health or auth.
    for (const path of ['/v1/health/live', '/v1/health/ready', '/v1/auth/login', '/v1/admin/tenants', '/v1/catalog/products']) {
      expect((await req.get(path)).status, `${path} must be absent`).toBe(404);
    }

    expect(ref.get(CredentialDeliveryWorker)).toBeInstanceOf(CredentialDeliveryWorker);
    expect(ref.get(CredentialPayloadProtector)).toBeInstanceOf(CredentialPayloadProtector);
    expect(ref.get(OutboxPublisher)).toBeInstanceOf(OutboxPublisher);
    expect(absent(() => ref.get(AdminService))).toBe(true);
    expect(absent(() => ref.get(CatalogService))).toBe(true);
    expect(absent(() => ref.get(TenancyService))).toBe(true);
    expect(absent(() => ref.get(TokenService))).toBe(true); // no JWT material
    expect(absent(() => ref.get('OBJECT_STORAGE'))).toBe(true);

    const db = ref.get(Database);
    expect(db.ownedPools()).toEqual(['worker']);
    await expect(db.withTransaction({}, async () => 1)).rejects.toThrow(/not configured/);
    await expect(db.withIdentityTransaction(async () => 1)).rejects.toThrow(/not configured/);
    await expect(db.withPlatformTransaction(async () => 1)).rejects.toThrow(/not configured/);
  });

  it('PROCESS_MODE=all is rejected in production (§19) — separated runtimes only', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        PROCESS_MODE: 'all',
        APP_DATABASE_URL: 'postgresql://daftar_app:x@db/daftar',
        JWT_SECRET: 'production-secret-with-at-least-32-characters',
      }),
    ).toThrow(/PROCESS_MODE=all is forbidden in production/);
  });

  it('production key safety (§24): the DEV_TEST_KEY fallback is impossible in production', async () => {
    const { credentialKeyRingFromConfig } = await import('../../apps/api/src/modules/delivery/credential-protector');
    expect(() => credentialKeyRingFromConfig({ NODE_ENV: 'production' })).toThrow(/DEV_TEST_KEY fallback is forbidden/);
    expect(credentialKeyRingFromConfig({ NODE_ENV: 'test' })).toHaveLength(1);
    // platform-api in production also needs the KMS-style encrypt provider (password reset enqueue).
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        PROCESS_MODE: 'platform-api',
        PLATFORM_DATABASE_URL: 'postgresql://daftar_platform:x@db/daftar',
        IDENTITY_DATABASE_URL: 'postgresql://daftar_identity:x@db/daftar',
        JWT_SECRET: 'production-secret-with-at-least-32-characters',
        REDIS_URL: 'redis://redis:6379',
      }),
    ).toThrow(/CREDENTIAL_KMS_ENDPOINT/);
  });
});
