import { Controller, Get, HttpException, HttpStatus, Inject, Req } from '@nestjs/common';
import type { Request } from 'express';
import { getCountryDisplayName, getCurrencyDisplayName, supportedCurrencies, supportedCountries } from '@daftar/domain-core';
import type { CountryDto, CurrencyDto, LocaleCode } from '@daftar/shared-contracts';
import { Public } from '../../common/guards';
import type { AppConfig } from '../../config';
import type { ObjectStorage } from '../../infra/storage';
import type { RateLimiter } from '../../infra/redis';
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
    @Inject('OBJECT_STORAGE') private readonly storage: ObjectStorage,
    @Inject('CREDENTIAL_DELIVERY') private readonly delivery: CredentialDelivery,
    @Inject('RATE_LIMITER') private readonly limiter: RateLimiter,
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
  async ready(): Promise<{ status: string; components: Record<string, { kind: string; ok: boolean }> }> {
    const mode = this.config.PROCESS_MODE;
    const db = await this.check();
    const components: Record<string, { kind: string; ok: boolean }> = {
      database: { kind: 'postgresql', ok: db },
    };
    let ok = db;
    let prodKindsOk = true;
    if (mode === 'merchant-api' || mode === 'all') {
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
    }
    if (mode === 'all') {
      const deliveryOk = this.delivery.kind === 'smtp'
        ? await (this.delivery as { healthCheck?: () => Promise<boolean> }).healthCheck?.().catch(() => false) ?? false
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
