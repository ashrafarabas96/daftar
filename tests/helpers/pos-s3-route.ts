/**
 * THE TEST-ONLY TRANSPORT FOR THE P4-S3 POS READS.
 *
 * ## Why a route lives in a test helper
 *
 * P4-S3 may not contain a `*.controller.ts` of its own. `discoverPhase4Routes`
 * (`scripts/phase4-s1-gate.ts`) walks all of `apps/api/src/modules` for
 * `*.controller.ts`, reads route paths out of the SOURCE TEXT and keeps
 * everything under `PHASE4_ROUTE_PREFIXES`, which includes `/v1/pos`; the
 * sealed G-02 golden asserts its own route list EQUAL to that discovery, and
 * `tests/security/phase4-route-surface.test.ts` requires every `/v1/pos` verb
 * to answer 404 in the real application. So the file's MERE EXISTENCE —
 * mounted or not — turns a sealed P4-S1 golden red. The real mount lands once,
 * from the slice coordinator, with both golden updates.
 *
 * ## Why the read is still proved over real HTTP rather than service-to-service
 *
 * Three of this slice's laws are properties of the TRANSPORT and are not
 * observable from a direct service call:
 *
 *   - **the limiter.** `P4-AL-69` says the POS type-ahead is solved by pacing
 *     and never by raising the API's allowance. The allowance is the
 *     `ThrottlerModule` of `httpImports` — 300 per minute per route handler and
 *     client — and a test that never issues an HTTP request can neither meet it
 *     nor prove it was met by waiting;
 *   - **the refusal envelope.** A refusal's status and its
 *     `details.sellingCode` are produced by `GlobalExceptionFilter`, not by the
 *     service, and a POS screen renders the code and not the exception;
 *   - **the strict query contract.** An unknown query parameter must be
 *     refused. There is no query string in a direct call.
 *
 * So this helper mounts the service's declared route — the one path, verb,
 * permission and schema `POS_READ_ROUTE_AUTHORITY` and
 * `PosProductSearchQuerySchema` state — on a REAL Nest application composed
 * from the production `AppModule`, so the request passes through the real
 * `AuthGuard`, the real `ThrottlerGuard`, the real membership resolution and
 * the real exception filter. Nothing about the read is re-implemented: the
 * handler's whole body is `PosReadService.searchProducts`, reached through the
 * application's own `Database`.
 *
 * ## What this is NOT
 *
 * It is not a second copy of the transport, and it must not become one. It
 * names the route exactly once, from the module's own authority table, so it
 * cannot drift from what the coordinator mounts: if the mounted path or
 * permission differs from `POS_READ_ROUTE_AUTHORITY`, this helper is wrong in
 * the same direction and `pos-s3-search.test.ts`'s own assertion on that table
 * is what notices. **When the real controller lands, this file is deleted and
 * the suite's `createTestApp` call goes back to the shared helper** — the
 * assertions do not change, because they are written against the HTTP surface
 * and not against this harness.
 *
 * The controller is declared in the ROOT testing module, which cannot inject
 * `Database` (AppModule exports nothing), so the handler resolves it through
 * `ModuleRef` with `strict: false` — the documented Nest way to reach a
 * provider in another module. `APP_GUARD` providers are application-scoped
 * whichever module declares them, so the guards apply here exactly as they do
 * to every merchant controller.
 */
import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import supertest from 'supertest';
import type { Request } from 'express';
import type { PosProductSearchDto } from '@daftar/shared-contracts';
import { AppModule } from '../../apps/api/src/app/app.module';
import { loadConfig, type AppConfig } from '../../apps/api/src/config';
import { CredentialDeliveryWorker } from '../../apps/api/src/modules/delivery/delivery-worker.service';
import { Database } from '../../apps/api/src/infra/database';
import { Membership, RequiresPermission } from '../../apps/api/src/common/guards';
import { localeOf } from '../../apps/api/src/common/locale';
import type { MembershipContext } from '../../apps/api/src/modules/tenancy/tenancy.service';
import { POS_READ_ROUTE_AUTHORITY, PosReadService } from '../../apps/api/src/modules/pos/pos-reads';
import { PosProductSearchQuerySchema } from '../../apps/api/src/modules/pos/pos-read.schemas';
import {
  ACCOUNTING_ASSERTION_KEY_B64,
  ACCOUNTING_ASSERTION_KID,
  INVENTORY_ASSERTION_KEY_B64,
  INVENTORY_ASSERTION_KID,
  PROVISIONING_ASSERTION_KEY_B64,
  PROVISIONING_ASSERTION_KID,
  appDbUrl,
  ensurePostgres,
  identityDbUrl,
  platformDbUrl,
  provisionerDbUrl,
  reconcilerDbUrl,
  resolverDbUrl,
  workerDbUrl,
  type TestApp,
} from './test-app';

/** The one route P4-S3's read surface declares. Read from the module, never retyped. */
const ROUTE = POS_READ_ROUTE_AUTHORITY[0];
if (ROUTE === undefined) throw new Error('POS_READ_ROUTE_AUTHORITY declares no route');
/** `/v1/pos/products` → controller prefix `/v1/pos`, handler path `products`. */
const CONTROLLER_PREFIX = ROUTE.path.slice(0, ROUTE.path.lastIndexOf('/'));
const HANDLER_PATH = ROUTE.path.slice(ROUTE.path.lastIndexOf('/') + 1);

@Controller(CONTROLLER_PREFIX)
class PosReadsTestTransport {
  // Explicit `@Inject`, as every controller in this repository is written:
  // esbuild does not implement `emitDecoratorMetadata`, so a parameter typed
  // only by its TypeScript type injects `undefined` under vitest.
  constructor(@Inject(ModuleRef) private readonly ref: ModuleRef) {}

  @Get(HANDLER_PATH)
  @RequiresPermission('sales.view')
  async products(@Membership() m: MembershipContext, @Query() query: unknown, @Req() req: Request): Promise<PosProductSearchDto> {
    const reads = new PosReadService(this.ref.get(Database, { strict: false }));
    return reads.searchProducts(m, PosProductSearchQuerySchema.parse(query), localeOf(req));
  }
}

/** The declared route this harness serves, so a suite can assert the two agree. */
export const POS_READ_TEST_ROUTE = ROUTE;

/**
 * The production application plus the POS read route, otherwise identical to
 * `createTestApp()` — same config, same guards, same throttler, same filter.
 */
export async function createPosReadTestApp(): Promise<TestApp> {
  await ensurePostgres();
  const config: AppConfig = loadConfig({
    NODE_ENV: 'test',
    APP_DATABASE_URL: appDbUrl,
    PLATFORM_DATABASE_URL: platformDbUrl,
    IDENTITY_DATABASE_URL: identityDbUrl,
    RESOLVER_DATABASE_URL: resolverDbUrl,
    WORKER_DATABASE_URL: workerDbUrl,
    PROVISIONER_DATABASE_URL: provisionerDbUrl,
    RECONCILER_DATABASE_URL: reconcilerDbUrl,
    PROVISIONING_ASSERTION_KEY: PROVISIONING_ASSERTION_KEY_B64,
    PROVISIONING_ASSERTION_KID,
    ACCOUNTING_ASSERTION_KEY: ACCOUNTING_ASSERTION_KEY_B64,
    ACCOUNTING_ASSERTION_KID,
    INVENTORY_ASSERTION_KEY: INVENTORY_ASSERTION_KEY_B64,
    INVENTORY_ASSERTION_KID,
    JWT_SECRET: 'test-secret-key-with-at-least-32-characters!',
    MEDIA_ROOT: '/tmp/daftar-test-media',
    LOG_LEVEL: process.env['TEST_LOG_LEVEL'] ?? 'warn',
    PORT: '0',
  });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register({ config })],
    controllers: [PosReadsTestTransport],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  let closed = false;
  const testApp: TestApp = {
    app,
    request: supertest(app.getHttpServer()),
    worker: moduleRef.get(CredentialDeliveryWorker),
    close: async () => {
      if (closed) return;
      closed = true;
      await app.close();
    },
  };
  return testApp;
}
