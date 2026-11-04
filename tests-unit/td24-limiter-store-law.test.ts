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
import { ThrottlerStorageService } from '@nestjs/throttler';
import { ThrottlerStorageProvider, getOptionsToken } from '@nestjs/throttler/dist/throttler.providers';
import type { DynamicModule, FactoryProvider, Provider, ValueProvider } from '@nestjs/common';
import { loadConfig, type AppConfig } from '../apps/api/src/config';
import { httpImports, httpProviders, NO_MERCHANT_CONTEXT } from '../apps/api/src/app/runtime';
import type { RateLimiter } from '../apps/api/src/infra/redis';
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

/** The dynamic module `httpImports` built, or a named failure. */
function throttlerModule(config: AppConfig): DynamicModule {
  const imports = httpImports(config);
  const first = imports[0];
  if (first === undefined || typeof first !== 'object' || !('providers' in first))
    throw new Error('httpImports no longer returns ThrottlerModule.forRoot as a dynamic module, so this law cannot resolve the store it configures');
  return first as DynamicModule;
}

const isValueProvider = (p: Provider): p is ValueProvider => typeof p === 'object' && 'provide' in p && 'useValue' in p;

/**
 * The store the guard would hold, computed by the LIBRARY's own factory from
 * the options the module was built with.
 */
function configuredThrottlerStore(config: AppConfig): object {
  const providers = throttlerModule(config).providers ?? [];
  const optionsProvider = providers.filter(isValueProvider).find((p) => p.provide === getOptionsToken());
  if (optionsProvider === undefined)
    throw new Error(`@nestjs/throttler no longer carries its options under ${String(getOptionsToken())}, so this law cannot read the configured store`);
  const factory = (ThrottlerStorageProvider as FactoryProvider).useFactory;
  if (typeof factory !== 'function')
    throw new Error('@nestjs/throttler ThrottlerStorageProvider is no longer a factory provider, so this law cannot resolve the store');
  const store: unknown = factory(optionsProvider.useValue);
  if (typeof store !== 'object' || store === null) throw new Error('the throttler storage factory did not return an object');
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

    // The general allowance (ThrottlerModule / ThrottlerGuard).
    expect(configuredThrottlerStore(config)).not.toBeInstanceOf(ThrottlerStorageService);

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
    expect(configuredThrottlerStore(productionHttpConfig())).toBeInstanceOf(RedisThrottlerStorage);
  });

  it('TD24-LAW-B (positive control): a development config resolves to exactly the in-process store', () => {
    const config = developmentConfig();

    // Not "something else": the very class the performance harness's window
    // reset reads as a Map.
    expect(configuredThrottlerStore(config)).toBeInstanceOf(ThrottlerStorageService);
    expect(configuredLimiterKind(config)).toBe('memory-development-only');
  });
});
