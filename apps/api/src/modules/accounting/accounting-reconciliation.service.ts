import { Inject, Injectable } from '@nestjs/common';
import {
  NO_CORRECTION_NOTICE,
  RECONCILIATION_CHECKS,
  reconcile,
  type AccountingReconciliationReader,
  type ReconciliationClock,
  type ReconciliationRunResult,
} from '@daftar/accounting';
import type { Logger } from '../../infra/logger';
import { ACCOUNTING_METRICS, METRICS, type Metrics } from '../../infra/metrics';

export const RECONCILIATION_READER = 'RECONCILIATION_READER';
export const RECONCILIATION_CLOCK = 'RECONCILIATION_CLOCK';

/** The wall clock, as a seam, so a daily schedule is testable in milliseconds. */
export class SystemReconciliationClock implements ReconciliationClock {
  now(): Date {
    return new Date();
  }
}

/**
 * THE RECONCILIATION PASS (P2-S8 §20, §22, §26).
 *
 * This class runs the checks and tells the world what it found. It has no
 * method that writes anything, and the credential underneath it holds no DML
 * on any financial table, so "reconciliation never corrects" is enforced in
 * two independent places rather than asserted in one comment.
 *
 * WHAT IT EMITS, AND WHAT IT CANNOT. Every signal below is built from the
 * §22 result contract, which the domain module already refused to construct
 * out of anything but identifiers, counts and timings. There is no path from
 * a balance to a log line here, because no balance ever reaches this class.
 *
 * A DISCREPANCY IS NEVER QUIET, AND NEVER ACTED ON. Each one is logged at
 * `error` with the check, the business and the safe offending ids, and it
 * always carries the same sentence: NO AUTOMATIC CORRECTION PERFORMED. That
 * sentence is in the payload rather than in a comment because the person
 * reading the alert at 3am is the one who needs to know that nothing has been
 * changed on their behalf.
 */
@Injectable()
export class AccountingReconciliationService {
  private lastSuccessfulRunAt: string | null = null;
  private lastRunAt: string | null = null;

  constructor(
    @Inject(RECONCILIATION_READER) private readonly reader: AccountingReconciliationReader,
    @Inject(RECONCILIATION_CLOCK) private readonly clock: ReconciliationClock,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  /** The timestamp of the last run that completed with no failed check. */
  lastSuccess(): string | null {
    return this.lastSuccessfulRunAt;
  }

  /** The timestamp of the last run of any outcome. */
  lastRun(): string | null {
    return this.lastRunAt;
  }

  /**
   * One full pass.
   *
   * It is safe to call at any time, from any number of processes, any number
   * of times: it takes no lock, holds no cursor and leaves no state behind,
   * because a read that changes nothing cannot race with another read that
   * changes nothing. That is also the whole of the §24 restart story — a
   * worker that dies halfway through simply starts again.
   */
  async runOnce(): Promise<ReconciliationRunResult> {
    this.logger.info({ command: 'accounting.reconciliation', event: 'started', checkCount: RECONCILIATION_CHECKS.length }, 'reconciliation started');

    const result = await reconcile(this.reader, this.clock);
    this.lastRunAt = result.completedAt;

    // The loudest case first. A pass that could not list the businesses has
    // produced no results at all, and no results reads exactly like a clean
    // system. It is reported as an error, it never marks a successful run,
    // and it names the authority that was missing so the gap is actionable.
    if (result.enumeration === 'unavailable') {
      this.logger.error(
        {
          command: 'accounting.reconciliation',
          event: 'enumeration_unavailable',
          reason: result.enumerationReason,
          businessCount: 0,
          correction: NO_CORRECTION_NOTICE,
        },
        'reconciliation could not determine which businesses to check — this run checked nothing',
      );
    }

    for (const check of result.results) {
      if (check.status === 'discrepancy') {
        this.metrics.increment(ACCOUNTING_METRICS.reconciliationDiscrepancyTotal, { check: check.checkId });
        this.logger.error(
          {
            command: 'accounting.reconciliation',
            event: 'discrepancy',
            check: check.checkId,
            businessId: check.businessId,
            offendingCount: check.offendingCount,
            offendingIds: check.offendingIds,
            correction: NO_CORRECTION_NOTICE,
          },
          'reconciliation found a discrepancy',
        );
      } else if (check.status === 'unavailable') {
        this.metrics.increment(ACCOUNTING_METRICS.reconciliationUnavailableTotal, { check: check.checkId });
        this.logger.warn(
          { command: 'accounting.reconciliation', event: 'unavailable', check: check.checkId, businessId: check.businessId, reason: check.errorCode },
          'reconciliation check could not run under this credential',
        );
      } else if (check.status === 'error') {
        this.logger.error(
          { command: 'accounting.reconciliation', event: 'check_failed', check: check.checkId, businessId: check.businessId, reason: check.errorCode },
          'reconciliation check failed',
        );
      }
    }

    // A run is SUCCESSFUL when every check reached a verdict. Discrepancies
    // do not make a run unsuccessful — finding one is the job. A check that
    // errored or could not run does, because the pass did not actually
    // answer the question it claims to answer (§4).
    const healthy = result.enumeration === 'complete' && result.errorCount === 0 && result.unavailableCount === 0;
    if (healthy) this.lastSuccessfulRunAt = result.completedAt;

    this.metrics.increment(ACCOUNTING_METRICS.reconciliationRunTotal, { outcome: healthy ? 'complete' : 'incomplete' });
    this.metrics.observe(ACCOUNTING_METRICS.reconciliationDurationMs, result.durationMs);

    this.logger.info(
      {
        command: 'accounting.reconciliation',
        event: 'completed',
        durationMs: result.durationMs,
        businessCount: result.businessCount,
        checkCount: result.checkCount,
        discrepancyCount: result.discrepancyCount,
        errorCount: result.errorCount,
        unavailableCount: result.unavailableCount,
        enumeration: result.enumeration,
        lastSuccessfulRunAt: this.lastSuccessfulRunAt,
        correction: NO_CORRECTION_NOTICE,
      },
      'reconciliation completed',
    );

    return result;
  }
}
