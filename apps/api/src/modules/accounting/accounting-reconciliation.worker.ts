import { Inject, Injectable } from '@nestjs/common';
import type { ReconciliationClock } from '@daftar/accounting';
import type { Logger } from '../../infra/logger';
import { AccountingReconciliationService, RECONCILIATION_CLOCK } from './accounting-reconciliation.service';

/** Runs at most once per UTC day. */
export const RECONCILIATION_PERIOD_MS = 24 * 60 * 60 * 1000;

/**
 * DAILY SCHEDULING, WITHOUT A SECOND INFRASTRUCTURE STACK (P2-S8 §25).
 *
 * A daily reconciliation does not need a scheduler, a queue, a cron container
 * or an `AccountingWorkerV2` — it needs to know whether a day has passed. So
 * this class owns exactly that decision and nothing else: the reconciler
 * process ticks it on a plain interval, and on all but one tick a day the
 * answer is "not yet".
 *
 * IT SURVIVES A RESTART BECAUSE IT KEEPS NO TIMER (§22). Due-ness is
 * recomputed from the clock on every tick, so a process that dies mid-pass
 * loses no schedule; the first tick after a restart is due, deliberately,
 * because a process that restarts every few hours and only reconciled "a day
 * after boot" would never reconcile at all. The pass writes nothing, so an
 * interrupted one leaves nothing half-done — it simply never records a
 * successful cycle.
 *
 * THE CLOCK IS INJECTED, so the schedule is testable in milliseconds rather
 * than in days. There is no test here that waits for tomorrow.
 *
 * IT NEVER THROWS. A reconciliation failure must not take the process down;
 * it is logged, counted, and the next tick tries again. `lastAttemptStartedAt`
 * moves even on failure, so a persistently failing pass retries daily rather
 * than on every tick.
 */
@Injectable()
export class AccountingReconciliationWorker {
  private lastAttemptStartedAt: number | null = null;
  private running = false;
  /** The pass in flight, so shutdown can wait for it rather than cut it off. */
  private inFlight: Promise<boolean> | null = null;
  /** Runs that ended in a thrown error. Operational signal, not financial. */
  static failures = 0;

  constructor(
    @Inject(AccountingReconciliationService) private readonly service: AccountingReconciliationService,
    @Inject(RECONCILIATION_CLOCK) private readonly clock: ReconciliationClock,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  /**
   * Whether a pass is due.
   *
   * The FIRST tick after the process starts is due, deliberately: a worker
   * that restarts every few hours and only reconciles "a day after boot"
   * would never reconcile at all.
   */
  isDue(now: Date = this.clock.now()): boolean {
    if (this.running) return false;
    if (this.lastAttemptStartedAt === null) return true;
    return now.getTime() - this.lastAttemptStartedAt >= RECONCILIATION_PERIOD_MS;
  }

  /** Run a pass if one is due. Never throws; never overlaps with itself. */
  async tickSafely(): Promise<boolean> {
    const now = this.clock.now();
    if (!this.isDue(now)) return false;
    this.lastAttemptStartedAt = now.getTime();
    this.running = true;
    const run = this.run();
    this.inFlight = run;
    try {
      return await run;
    } finally {
      this.inFlight = null;
      this.running = false;
    }
  }

  /**
   * Wait for the pass in flight, if any (§32).
   *
   * Shutdown calls this after it has stopped the schedule. A reconciliation
   * pass only reads, so cutting one off would corrupt nothing — but it would
   * end a run that reported nothing, and a run that reported nothing must not
   * be mistaken later for a run that found nothing. Letting the pass reach its
   * own conclusion is what keeps that distinction honest.
   */
  async drain(): Promise<void> {
    await this.inFlight?.catch(() => undefined);
  }

  private async run(): Promise<boolean> {
    try {
      await this.service.runOnce();
      return true;
    } catch (e) {
      AccountingReconciliationWorker.failures += 1;
      this.logger.error(
        {
          command: 'accounting.reconciliation',
          event: 'run_failed',
          reason: e instanceof Error ? e.name : 'unknown',
          failuresTotal: AccountingReconciliationWorker.failures,
        },
        'reconciliation run failed',
      );
      return false;
    }
  }
}
