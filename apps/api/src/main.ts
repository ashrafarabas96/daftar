import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { MerchantApiModule } from './app/merchant-api.module';
import { PlatformApiModule } from './app/platform-api.module';
import { WorkerModule } from './app/worker.module';
import { loadConfig } from './config';
import { createLogger } from './infra/logger';
import { CredentialDeliveryWorker } from './modules/delivery/delivery-worker.service';
import { OutboxPublisher } from './modules/outbox/publisher';

/**
 * §XXV–XXXI + Directive §15–20: one modular-monolith codebase, FOUR runtime
 * compositions selected by PROCESS_MODE — each a DIFFERENT Nest module, not
 * one module with flags:
 *  - merchant-api → MerchantApiModule   (merchant HTTP surface)
 *  - platform-api → PlatformApiModule   (admin HTTP surface + shared identity)
 *  - worker       → WorkerModule        (NO HTTP: ApplicationContext only)
 *  - all          → AppModule           (dev/test single process; production rejects)
 * Secrets are separated by config validation (PROCESS_MODE) before any of
 * this runs; the migrator is its own entrypoint (infra/migrate.ts).
 */
async function bootstrap(): Promise<void> {
  const config = loadConfig(); // fails fast on missing/forbidden config (§34)
  const logger = createLogger(config.LOG_LEVEL);

  if (config.PROCESS_MODE === 'worker') {
    const app = await NestFactory.createApplicationContext(WorkerModule.register({ config }), { logger: false });
    const worker = app.get(CredentialDeliveryWorker);
    const outbox = app.get(OutboxPublisher);
    await worker.assertKeyRingCoverage(); // §XX: refuse to start on missing key versions
    const tick = (): void => {
      void worker.drainSafely(25);
      void outbox.publishOnce().catch((e: unknown) => {
        logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'outbox relay tick failed');
      });
    };
    setInterval(tick, 5_000).unref();
    tick();
    logger.info({ mode: 'worker' }, 'daftar worker running (no HTTP surface)');
    return;
  }

  const module =
    config.PROCESS_MODE === 'merchant-api'
      ? MerchantApiModule.register({ config })
      : config.PROCESS_MODE === 'platform-api'
        ? PlatformApiModule.register({ config })
        : AppModule.register({ config });
  const app = await NestFactory.create(module, { logger: false });
  app.enableCors({
    origin: config.CORS_ORIGINS.split(',').map((o) => o.trim()),
    credentials: false,
  });
  await app.listen(config.PORT);
  logger.info({ port: config.PORT, mode: config.PROCESS_MODE }, 'daftar api listening');
}

bootstrap().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
