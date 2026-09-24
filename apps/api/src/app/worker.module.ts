import { Module, type DynamicModule } from '@nestjs/common';
import type { AppConfig } from '../config';
import { coreProviders, workerProviders, type RuntimeSeams } from './runtime';
import { CredentialDeliveryWorker } from '../modules/delivery/delivery-worker.service';
import { OutboxPublisher } from '../modules/outbox/publisher';

/**
 * WORKER PROCESS (Directive §18). NO HTTP surface — no controllers, no
 * guards, no throttler; main.ts boots it as an ApplicationContext. Owns
 * exactly: the worker DB pool, the credential DECRYPT key ring, the SMTP
 * delivery transport, the credential-delivery loop and the outbox relay.
 * Merchant/admin services, identity, storage and JWT material do not exist
 * in this process.
 */
@Module({})
export class WorkerModule {
  static register(options: { config: AppConfig } & RuntimeSeams): DynamicModule {
    const { config } = options;
    return {
      module: WorkerModule,
      providers: [...coreProviders(config, options), ...workerProviders(config, options), CredentialDeliveryWorker, OutboxPublisher],
    };
  }
}
