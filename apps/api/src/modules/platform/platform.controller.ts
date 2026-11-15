import { Controller, Get, HttpException, HttpStatus, Inject, Optional, Req } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { Request } from 'express';
import { getCountryDisplayName, getCurrencyDisplayName, supportedCurrencies, supportedCountries } from '@daftar/domain-core';
import type { CountryDto, CurrencyDto, LocaleCode } from '@daftar/shared-contracts';
import { Public } from '../../common/guards';
import type { AppConfig } from '../../config';
import type { ObjectStorage } from '../../infra/storage';
import type { RateLimiter } from '../../infra/redis';
import { RedisThrottlerStorage } from '../../infra/rate-limit-store';
import type { CredentialDelivery } from '../auth/tokens';

/** Platform reference data — public, localized at the edge via Intl.DisplayNames (§20). */
@Controller('/v1/platform')
export class PlatformController {
  private locale(req: Request): LocaleCode {
    const base = ((req.headers['accept-language'] ?? 'ar').split(',')[0] ?? 'ar').split('-')[0]?.toLowerCase() ?? 'ar';
    return base === 'en' || base === 'tr' ? (base as LocaleCode) : 'ar';
  }

  @Public()
  @Get('countries')
  countries(@Req() req: Request): { items: CountryDto[] } {
    const locale = this.locale(req);
    return {
      items: supportedCountries().map((pack) => ({
        code: pack.code,
        name: getCountryDisplayName(pack.code, locale),
        recommendedCurrencies: [...pack.recommendedCurrencies],
        phoneCountryCode: pack.phone.countryCode,
      })),
    };
  }

  @Public()
  @Get('currencies')
  currencies(@Req() req: Request): { items: CurrencyDto[] } {
    const locale = this.locale(req);
    return {
      items: supportedCurrencies().map((meta) => ({
        code: meta.code,
        name: getCurrencyDisplayName(meta.code, locale),
        minorUnits: meta.minorUnits,
      })),
    };
  }
}

@Controller('/v1/health')
export class HealthController {
  constructor(
    @Inject('HEALTH_CHECK') private readonly check: () => Promise<boolean>,
    @Inject('APP_CONFIG') private readonly config: AppConfig,
    // Per-process adapters (§17–18): the platform process has no object
    // storage; only the single-process mode carries the delivery adapter.
    @Optional() @Inject('OBJECT_STORAGE') private readonly storage: ObjectStorage | null,
    @Optional() @Inject('CREDENTIAL_DELIVERY') private readonly delivery: CredentialDelivery | null,
    @Inject('RATE_LIMITER') private readonly limiter: RateLimiter,
    // TD-24 / DR-90: the store behind the GENERAL allowance, which is a
    // different thing from `RATE_LIMITER` above — see the readiness body.
    // `@Optional` because a process configured with no shared store binds the
    // library's in-process one, which is not this class.
    @Optional() @Inject(ThrottlerStorage) private readonly throttlerStore: unknown,
  ) {}

  @Public()
  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }

  /**
   * Readiness (Gate A §29, §XXXI): per deployment mode, the dependencies THIS
   * process actually serves. Merely "PostgreSQL is up" is NOT ready — in
   * production every real adapter of the mode must report healthy.
   *  - merchant-api: db pools + storage + limiter (delivery is the worker's)
   *  - platform-api: db pools + limiter
   *  - all:          db + storage + limiter + delivery
   *  - worker:       no HTTP surface; readiness = startup assertions
   */
  @Public()
  @Get('ready')
  async ready(): Promise<{ status: string; components: Record<string, { kind: string; ok: boolean; degradedRequests?: number }> }> {
    const mode = this.config.PROCESS_MODE;
    const db = await this.check();
    const components: Record<string, { kind: string; ok: boolean; degradedRequests?: number }> = {
      database: { kind: 'postgresql', ok: db },
    };
    let ok = db;
    let prodKindsOk = true;
    if ((mode === 'merchant-api' || mode === 'all') && this.storage) {
      const storageOk = await this.storage.healthCheck().catch(() => false);
      components['objectStorage'] = { kind: this.storage.kind, ok: storageOk };
      ok = ok && storageOk;
      prodKindsOk = prodKindsOk && this.storage.kind === 's3';
    }
    if (mode === 'merchant-api' || mode === 'platform-api' || mode === 'all') {
      const limiterOk = await this.limiter.healthCheck().catch(() => false);
      components['rateLimiter'] = { kind: this.limiter.kind, ok: limiterOk };
      ok = ok && limiterOk;
      prodKindsOk = prodKindsOk && this.limiter.kind === 'redis';
      // TD-24 / DR-90 §3. The general allowance degrades to a PER-REPLICA
      // count when the shared store is unreachable — deliberately, because a
      // 503 on every route would be an outage this limiter caused. A
      // degradation that nothing reports would leave the operator reading a
      // stated ceiling of 300 while the real one is 300 times the replica
      // count, so it is reported HERE, where an operator already looks.
      //
      // It does NOT make the process unready: taking replicas out of service
      // over a cache blip is the worse failure, and the count is the signal.
      if (this.throttlerStore instanceof RedisThrottlerStorage) {
        // `ok` ASKS THE BACKEND rather than reporting what the last request
        // happened to do: a replica with no traffic would otherwise read
        // healthy while the shared store was down, and an intermittent
        // backend would read healthy whenever the last request got through.
        // `degradedRequests` sits beside it as the history — how many
        // requests this replica has already counted on its own.
        const storeOk = await this.throttlerStore.healthCheck().catch(() => false);
        components['throttlerStore'] = {
          kind: this.throttlerStore.kind,
          ok: storeOk,
          degradedRequests: this.throttlerStore.degradedRequests,
        };
      }
    }
    if (mode === 'all' && this.delivery) {
      const deliveryOk =
        this.delivery.kind === 'smtp'
          ? ((await (this.delivery as { healthCheck?: () => Promise<boolean> }).healthCheck?.().catch(() => false)) ?? false)
          : true;
      components['credentialDelivery'] = { kind: this.delivery.kind, ok: deliveryOk };
      ok = ok && deliveryOk;
      prodKindsOk = prodKindsOk && this.delivery.kind === 'smtp';
    }
    const ready = ok && (!this.config.isProd || prodKindsOk);
    if (!ready) {
      throw new HttpException({ status: 'not_ready', components }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return { status: 'ok', components };
  }
}
