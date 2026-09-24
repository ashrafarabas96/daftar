import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { MerchantApiModule } from './app/merchant-api.module';
import { PlatformApiModule } from './app/platform-api.module';
import { WorkerModule } from './app/worker.module';
import { ReconcilerModule } from './app/reconciler.module';
import { loadConfig } from './config';
import { createLogger } from './infra/logger';
import { CredentialDeliveryWorker } from './modules/delivery/delivery-worker.service';
import { AccountingReconciliationWorker } from './modules/accounting/accounting-reconciliation.worker';
import { OutboxPublisher } from './modules/outbox/publisher';

/**
 * §XXV–XXXI + Directive §15–20, extended by P2-S8 §32: one modular-monolith
 * codebase, FIVE runtime compositions selected by PROCESS_MODE — each a
 * DIFFERENT Nest module, not one module with flags:
 *  - merchant-api → MerchantApiModule   (merchant HTTP surface)
 *  - platform-api → PlatformApiModule   (admin HTTP surface + shared identity)
 *  - worker       → WorkerModule        (NO HTTP: ApplicationContext only)
 *  - reconciler   → ReconcilerModule    (NO HTTP: accounting reconciliation only)
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

  if (config.PROCESS_MODE === 'reconciler') {
    // P2-S8 §32. A process of its own, with its own database credential and
    // no HTTP surface, because the credential that may read every business's
    // ledger must not sit in the process that holds the delivery key ring.
    const app = await NestFactory.createApplicationContext(ReconcilerModule.register({ config }), { logger: false });
    const reconciliation = app.get(AccountingReconciliationWorker);
    // The pass answers "not yet" on all but one tick a day (§21). Ticking
    // often rather than sleeping until the due moment is what makes a restart
    // cheap: there is no timer to lose, and the due decision is recomputed
    // from the clock every time.
    const timer = setInterval(() => void reconciliation.tickSafely(), 60_000);
    timer.unref();
    void reconciliation.tickSafely();
    // §32: a cycle that is interrupted must never be reported as a completed
    // one. Shutdown stops the schedule and then waits for the pass in flight
    // to finish or fail on its own terms, so the only run that records a
    // successful cycle is a run that actually finished.
    let closing = false;
    const shutdown = (signal: string): void => {
      if (closing) return;
      closing = true;
      clearInterval(timer);
      logger.info({ mode: 'reconciler', signal }, 'daftar reconciler stopping');
      void reconciliation
        .drain()
        .then(() => app.close())
        .catch(() => app.close())
        .finally(() => process.exit(0));
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    logger.info({ mode: 'reconciler' }, 'daftar reconciler running (no HTTP surface)');
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
