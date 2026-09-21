import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { loadConfig } from './config';
import { createLogger } from './infra/logger';
import { CredentialDeliveryWorker } from './modules/delivery/delivery-worker.service';

/**
 * §XXV–XXXI: one modular-monolith codebase, FOUR deployment modes.
 *  - merchant-api / platform-api / all → HTTP surface
 *  - worker → NO HTTP surface: key-ring coverage assertion (fail fast, §XX),
 *    then the credential-delivery loop. Secrets are separated by config
 *    validation (PROCESS_MODE) before any of this runs.
 */
async function bootstrap(): Promise<void> {
  const config = loadConfig(); // fails fast on missing/forbidden config (§34)
  const logger = createLogger(config.LOG_LEVEL);

  if (config.PROCESS_MODE === 'worker') {
    const app = await NestFactory.createApplicationContext(AppModule.register({ config }), { logger: false });
    const worker = app.get(CredentialDeliveryWorker);
    await worker.assertKeyRingCoverage(); // §XX: refuse to start on missing key versions
    const tick = (): void => {
      void worker.drainSafely(25);
    };
    setInterval(tick, 5_000).unref();
    tick();
    logger.info({ mode: 'worker' }, 'daftar worker running (no HTTP surface)');
    return;
  }

  const app = await NestFactory.create(AppModule.register({ config }), { logger: false });
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
