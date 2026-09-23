import { Module, type DynamicModule, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import type { AppConfig } from '../config';
import { RequestContextMiddleware } from './request-context.middleware';
import { coreProviders, httpImports, httpProviders, identityProviders, NO_MERCHANT_CONTEXT, type RuntimeSeams } from './runtime';
import { AuthController } from '../modules/auth/auth.controller';
import { AdminService } from '../modules/admin/admin.service';
import { AdminController } from '../modules/admin/admin.controller';
import { HealthController } from '../modules/platform/platform.controller';

/**
 * PLATFORM PROCESS (Directive §17). The super-admin surface plus the shared
 * identity routes it needs (login / refresh / logout / password reset).
 * Structurally absent: worker secrets, migration credentials, every merchant
 * mutation surface (tenancy, catalog, media, entitlements), the merchant
 * membership resolver (X-Business-Id is refused), the delivery worker and
 * the decrypt key ring. Password reset enqueues through the ENCRYPT-only
 * provider; the worker process delivers.
 */
@Module({})
export class PlatformApiModule implements NestModule {
  static register(options: { config: AppConfig } & RuntimeSeams): DynamicModule {
    const { config } = options;
    return {
      module: PlatformApiModule,
      imports: httpImports(),
      controllers: [AuthController, AdminController, HealthController],
      providers: [
        ...coreProviders(config, options),
        ...httpProviders(config, { useValue: NO_MERCHANT_CONTEXT }),
        ...identityProviders(config, options),
        AdminService,
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
