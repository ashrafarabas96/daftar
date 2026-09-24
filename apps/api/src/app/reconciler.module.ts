import { Module, type DynamicModule } from '@nestjs/common';
import type { AppConfig } from '../config';
import { coreProviders, reconcilerProviders, type RuntimeSeams } from './runtime';

/**
 * RECONCILER PROCESS (P2-S8 §6, §31). NO HTTP surface — no controllers, no
 * guards, no throttler; main.ts boots it as an ApplicationContext.
 *
 * It owns exactly one database credential, `daftar_reconciler`, which `0051`
 * grants column-level SELECT on the six tables the nine reconciliation checks
 * read and EXECUTE on one narrow enumerator. It holds no INSERT, UPDATE,
 * DELETE or TRUNCATE anywhere in the database, so this process cannot repair
 * what it finds even if a future version of the code tried to (§18).
 *
 * What is NOT here is the point. There is no credential decryption key ring,
 * no SMTP transport, no outbox sink, no assertion minter, no object storage,
 * no identity runtime and no other database pool — not because this module
 * chooses not to ask for them, but because they are not in it. A provider
 * that is absent from a module cannot be injected and cannot hold a secret,
 * and the configuration for this mode refuses to carry those secrets at all.
 */
@Module({})
export class ReconcilerModule {
  static register(options: { config: AppConfig } & RuntimeSeams): DynamicModule {
    const { config } = options;
    return {
      module: ReconcilerModule,
      providers: [...coreProviders(config, options), ...reconcilerProviders(config, options)],
    };
  }
}
