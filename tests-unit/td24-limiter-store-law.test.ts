/**
 * TD-24's LAW: THE STORE BEHIND THE GENERAL ALLOWANCE IS PINNED, AND A
 * PRODUCTION HTTP SURFACE THAT FALLS BACK TO THE PROCESS HEAP FAILS LOUDLY.
 *
 * `TECHNICAL_DEBT.md` asks for two things and this file is the second: "add a
 * law that pins the store or makes the reset fail loudly when it changes".
 * Without it, the store is pinned by a comment, and a wiring edit that drops
 * the shared store back to the in-process one turns a stated ceiling of 300
 * per minute into 300 per minute PER REPLICA with nothing going red — and the
 * returned rate-limit answers would read as a performance regression rather
 * than as a changed store, which is TD-24's own sentence.
 *
 * ── WHY THIS IS NOT A TEST ABOUT A STRING ────────────────────────────────
 *
 * The law does not grep `runtime.ts` for the word `storage`. It computes what
 * Nest itself would compute: `httpImports(config)` returns the dynamic module
 * `ThrottlerModule.forRoot` built, that module carries the options under the
 * library's own `THROTTLER:MODULE_OPTIONS` token, and the library's own
 * `ThrottlerStorageProvider.useFactory` turns those options into the instance
 * the guard will hold (`@nestjs/throttler@6.4.0`,
 * `dist/throttler.providers.js:17-23`: the configured store is used only when
 * `options.storage` is present, otherwise a fresh `ThrottlerStorageService`).
 * So this file resolves the store through the library, not beside it.
 *
 * That also makes the law fail loudly on a LIBRARY change rather than
 * silently passing: if the option token or the provider shape moves, the
 * lookups below throw with a named reason instead of concluding "no
 * in-process store found".
 *
 * ── THE TWO HALVES, AND WHY NEITHER ALONE IS A LAW ───────────────────────
 *
 *   TD24-LAW-A  a PRODUCTION HTTP config must not resolve to the in-process
 *               store, for either limiter layer.
 *   TD24-LAW-B  POSITIVE CONTROL: a development config must resolve to
 *               exactly that in-process store.
 *
 * And a third half, added after a measurement cost a CI run: WHICH INJECTOR
 * ANSWERS. TD24-LAW-D/E pin the fact the two cases above depend on — the
 * module-local provider is what a consumer in that module receives, while the
 * application ROOT answers with the `@Global()` module's own instance — so
 * any probe that reads the store off a running app reads the right one.
 * `tests/security/td24-distributed-rate-limiter.test.ts` read the ROOT, drew
 * the opposite conclusion from a real Redis, and asserted both of its
 * decisive cases against the wrong branch (run 42059258777).
 *
 * B is what makes A a measurement. A rule that holds for every input is a
 * rule about nothing, and it would also be satisfied by a broken import or a
 * config loader that throws — both of which B catches in the same run. B is
 * additionally the thing that keeps the performance harness honest:
 * `tests/performance/pos-s3-budgets.test.ts:548-553` reads
 * `ThrottlerStorageService.storage` as a `Map` and throws if it is not one,
 * which is only a sound reset while the TEST environment keeps that store —
 * so B pins the premise that harness depends on, in a file that harness's
 * lane does not own.
 *
 * ── WHAT IS MEASURED, NOT ASSUMED ────────────────────────────────────────
 *
 * `config.ts:281-282` makes `REDIS_URL` a startup requirement of every
 * production HTTP surface ("production requires REDIS_URL (memory rate
 * limiter is dev-only)"), so a production config that reaches this file
 * always carries one. The identity layer's half of A is therefore a statement
 * about `kind`, taken from the provider factory in `runtime.ts` rather than
 * from the class name: `MemoryRateLimiter.kind` is
 * `memory-development-only` (`infra/redis.ts:105`) and that value is what a
 * production surface may never answer with — the same value
 * `platform.controller.ts:94` already refuses on the readiness path.
 *
 * No database and no network: every assertion here is a pure function of a
 * config object, so this suite runs on the Windows development host as well
 * as on CI.
 */
import { describe, expect, it } from 'vitest';
import { ThrottlerModule, ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Inject, Injectable, Module, type DynamicModule, type FactoryProvider } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadConfig, type AppConfig } from '../apps/api/src/config';
import { httpProviders, NO_MERCHANT_CONTEXT } from '../apps/api/src/app/runtime';
import type { RateLimiter } from '../apps/api/src/infra/redis';
import { InMemoryMetrics } from '../apps/api/src/infra/metrics';
import { RedisThrottlerStorage } from '../apps/api/src/infra/rate-limit-store';

/** The production KMS bridge a production HTTP surface must carry (Blocker 4). */
const KMS_BRIDGE = {
  CREDENTIAL_KMS_ENDPOINT: 'https://kms.example.com/encrypt',
  CREDENTIAL_KMS_TOKEN: 'kms-bridge-token-with-at-least-32-characters!!',
} as const;

/**
 * A production `platform-api` surface: the narrowest HTTP mode, so the law
 * says nothing that depends on the merchant surface's extra secrets. The
 * shape follows `tests/integration/production-providers.test.ts`, which this
 * file does not edit (that file belongs to another open branch).
 */
function productionHttpConfig(): AppConfig {
  return loadConfig({
    NODE_ENV: 'production',
    PROCESS_MODE: 'platform-api',
    PLATFORM_DATABASE_URL: 'postgresql://daftar_platform:x@db/daftar',
    IDENTITY_DATABASE_URL: 'postgresql://daftar_identity:x@db/daftar',
    JWT_SECRET: 'production-secret-with-at-least-32-characters',
    REDIS_URL: 'redis://redis:6379',
    // REL-10 (main, PR #88) made this a production REQUIREMENT that fails fast
    // in `loadConfig`: a production process whose allowlist is absent or still
    // the development default does not start. Without it this law dies in
    // configuration validation before it can measure a store, which is a
    // failure of the test's environment and not of either rule. The value is
    // the shape `tests-unit/rel09-api-security-headers.test.ts` uses.
    CORS_ORIGINS: 'https://app.example.com',
    ...KMS_BRIDGE,
  });
}

/** The single-process development configuration, which production rejects outright. */
function developmentConfig(): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    APP_DATABASE_URL: 'postgresql://postgres:postgres@localhost:55432/daftar',
    JWT_SECRET: 'test-secret-key-with-at-least-32-characters!',
  });
}

/**
 * The store the guard would hold, resolved the way the guard resolves it.
 *
 * It is a PROVIDER of the module that registers `ThrottlerGuard`, not an
 * option of the imported `ThrottlerModule` — measured: a consumer in that
 * module receives the module-local provider even though `ThrottlerModule` is
 * `@Global()`. (An earlier version of this law read `app.get()` on the ROOT
 * injector, which answers with the global module's instance instead, and drew
 * the opposite conclusion from it. The injector you ask decides the answer.)
 *
 * `null` means the token is deliberately UNPROVIDED, which is how a process
 * with no shared store keeps the library's own instance — the one
 * `tests/performance/pos-s3-budgets.test.ts:549` reads from the app root and
 * clears between measurements.
 */
function configuredThrottlerStore(config: AppConfig): object | null {
  const providers = httpProviders(config, { useValue: NO_MERCHANT_CONTEXT });
  const provider = providers.find((p): p is FactoryProvider => typeof p === 'object' && 'provide' in p && p.provide === ThrottlerStorage && 'useFactory' in p);
  if (provider === undefined) return null;
  const logger = { warn: () => undefined } as unknown as Parameters<typeof provider.useFactory>[0];
  const store: unknown = provider.useFactory(logger, new InMemoryMetrics());
  if (typeof store !== 'object' || store === null) throw new Error('the ThrottlerStorage factory did not return an object');
  return store;
}

/** The `RATE_LIMITER` the HTTP composition would bind, by its own `kind`. */
function configuredLimiterKind(config: AppConfig): string {
  const providers = httpProviders(config, { useValue: NO_MERCHANT_CONTEXT });
  const provider = providers.find((p): p is FactoryProvider => typeof p === 'object' && 'provide' in p && p.provide === 'RATE_LIMITER' && 'useFactory' in p);
  if (provider === undefined)
    throw new Error('httpProviders no longer provides RATE_LIMITER through a factory, so this law cannot resolve the limiter it binds');
  const limiter = provider.useFactory() as RateLimiter;
  const kind = limiter.kind;
  void Promise.resolve(limiter.close()).catch(() => undefined);
  if (typeof kind !== 'string' || kind.length === 0) throw new Error('the RATE_LIMITER factory produced a limiter with no kind');
  return kind;
}

describe('TD-24 law — the general allowance may not be counted in the process heap in production', () => {
  it('TD24-LAW-A: a production HTTP surface resolves neither layer to an in-process store', () => {
    const config = productionHttpConfig();

    // The general allowance: a shared store is PROVIDED, and it is the Redis
    // one whose refusal is measured in the store suite.
    expect(configuredThrottlerStore(config)).toBeInstanceOf(RedisThrottlerStorage);

    // The identity limits (RATE_LIMITER). `memory-development-only` is the
    // value `platform.controller.ts:94` already refuses on readiness.
    expect(configuredLimiterKind(config)).not.toBe('memory-development-only');
  });

  /**
   * DR-90 §4 named the gap in "not the in-process one" and it is a real one:
   * a SHARED store that computed `isBlocked` wrongly would satisfy TD24-LAW-A
   * and refuse nothing, while readiness reported a shared store. The refusal
   * itself is therefore measured — in
   * `tests-unit/td24-redis-throttler-store.test.ts` (TD24-POS: the 301st call
   * is blocked; TD24-NEG: a backend each admits 600) — and this case is the
   * join between the two files. Without it, that refusal would be a fact
   * about a class nobody proved production binds.
   *
   * It does not drive the production-resolved store past the limit here on
   * purpose: that store's backend is a `redis://` URL no test may reach, so
   * the call would be answered by the degraded fallback and would pass for
   * the wrong reason — which is the shape of defect this card is about.
   */
  it('TD24-LAW-C: the store production binds is the one whose refusal is measured', () => {
    const store = configuredThrottlerStore(productionHttpConfig());
    expect(store).toBeInstanceOf(RedisThrottlerStorage);
    // And it was built WITH the process's own logger and metrics, which is
    // the half of DR-90 §3 a store built in module metadata cannot have.
    expect((store as RedisThrottlerStorage).degradedRequests).toBe(0);
  });

  it('TD24-LAW-B (positive control): a development config resolves to exactly the in-process store', () => {
    const config = developmentConfig();

    // The token is left UNPROVIDED on purpose, so the guard keeps the global
    // module's own in-process instance — the very object the performance
    // harness clears from the app root between two measurements. A provider
    // here would hand the guard a different Map and make that reset a silent
    // no-op.
    expect(configuredThrottlerStore(config)).toBe(null);
    expect(configuredLimiterKind(config)).toBe('memory-development-only');
  });
});

/**
 * ── THE INJECTOR LAW (TD24-LAW-D/E) ──────────────────────────────────────
 *
 * The shape below is `createTestApp()`'s shape, reduced to what the question
 * needs: a ROOT module that provides no `ThrottlerStorage` and imports a
 * feature module that does, with `ThrottlerModule` — which is `@Global()` —
 * imported inside the feature module exactly as `httpImports` imports it.
 *
 * No database, no network, no HTTP: `NestFactory.createApplicationContext`
 * builds the injector and nothing else, so this runs on the Windows
 * development host.
 */
const LOCAL_STORE: ThrottlerStorage = {
  increment: () => Promise.resolve({ totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 }),
};

/** A consumer in the SAME module as the store provider — the guard's position. */
@Injectable()
class StoreConsumer {
  constructor(@Inject(ThrottlerStorage) readonly store: ThrottlerStorage) {}
}

const THROTTLERS = { throttlers: [{ ttl: 60_000, limit: 300 }] };

/** The feature module WITH a module-local store: the shared-store composition. */
@Module({ imports: [ThrottlerModule.forRoot(THROTTLERS)], providers: [{ provide: ThrottlerStorage, useValue: LOCAL_STORE }, StoreConsumer] })
class WithLocalStore {}

/** The same module WITHOUT one: the composition that keeps the library's instance. */
@Module({ imports: [ThrottlerModule.forRoot(THROTTLERS)], providers: [StoreConsumer] })
class WithoutLocalStore {}

@Module({ imports: [WithLocalStore] })
class RootOverLocal {}

/**
 * The same composition through a DYNAMIC module, because that is the shape
 * `createTestApp()` actually builds: `AppModule.register({ config })`
 * imported into a `Test.createTestingModule` root.
 *
 * MEASURED HERE, and it decided how the integration suite reads the store:
 * `select` CANNOT reach a module registered dynamically — it refuses with
 * "does not exist in current context". So there is no injector probe
 * available to that suite at all, and it reads the store the product itself
 * reports on `/v1/health/ready` instead. Asserted rather than assumed,
 * because a probe that threw here would fail that suite's `beforeAll` and
 * take all six cases with it.
 */
@Module({})
class DynamicFeature {
  static register(): DynamicModule {
    return {
      module: DynamicFeature,
      imports: [ThrottlerModule.forRoot(THROTTLERS)],
      providers: [{ provide: ThrottlerStorage, useValue: LOCAL_STORE }, StoreConsumer],
    };
  }
}

@Module({ imports: [DynamicFeature.register()] })
class RootOverDynamic {}

@Module({ imports: [WithoutLocalStore] })
class RootOverNone {}

describe('TD-24 law — which injector answers for the store the guard holds', () => {
  it('TD24-LAW-D: the module-local provider is what the guard receives, and the ROOT answers with a different object', async () => {
    const context = await NestFactory.createApplicationContext(RootOverLocal, { logger: false });
    try {
      // THE SUBJECT: a consumer in the module receives the module's provider,
      // even though `ThrottlerModule` is `@Global()`.
      expect(context.select(WithLocalStore).get(StoreConsumer).store).toBe(LOCAL_STORE);

      // THE TRAP, asserted so it cannot be forgotten again: the ROOT answers
      // with the global module's own in-process instance — a DIFFERENT
      // object from the one the consumer holds.
      const root: unknown = context.get<unknown>(ThrottlerStorage);
      expect(root).toBeInstanceOf(ThrottlerStorageService);
      expect(root).not.toBe(LOCAL_STORE);

      // THE PROBE the integration suite uses: it agrees with the consumer.
      expect(context.select(WithLocalStore).get<ThrottlerStorage>(ThrottlerStorage, { strict: true })).toBe(LOCAL_STORE);
    } finally {
      await context.close();
    }
  });

  it('TD24-LAW-D2: a DYNAMIC module cannot be selected, so no injector probe is available to the integration suite', async () => {
    const context = await NestFactory.createApplicationContext(RootOverDynamic, { logger: false });
    try {
      // The composition is sound — the consumer in the dynamic module does
      // hold the module-local store, exactly as in TD24-LAW-D. POSITIVE
      // CONTROL, so the refusal below cannot be read as a broken fixture.
      expect(context.get(StoreConsumer).store).toBe(LOCAL_STORE);

      // And it is UNREACHABLE by `select`, which is the whole reason
      // `tests/security/td24-distributed-rate-limiter.test.ts` reads the
      // store off `/v1/health/ready` instead of out of an injector.
      expect(() => context.select(DynamicFeature)).toThrow(/does not exist in current context/);
    } finally {
      await context.close();
    }
  });

  it('TD24-LAW-E (negative control): with no module-local provider the probe reads unprovided, and the consumer holds the library instance', async () => {
    const context = await NestFactory.createApplicationContext(RootOverNone, { logger: false });
    try {
      // Without this control, TD24-LAW-D would also pass against a `select`
      // that answered with the global store for everything asked of it — and
      // the integration suite's two readings could not be told apart.
      expect(() => context.select(WithoutLocalStore).get<ThrottlerStorage>(ThrottlerStorage, { strict: true })).toThrow();

      const held: unknown = context.select(WithoutLocalStore).get(StoreConsumer).store;
      expect(held).toBeInstanceOf(ThrottlerStorageService);
      expect(held).toBe(context.get<unknown>(ThrottlerStorage)); // the same instance the root answers with
    } finally {
      await context.close();
    }
  });
});
