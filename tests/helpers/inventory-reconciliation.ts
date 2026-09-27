/**
 * P3-S8 — R-INV-01 … R-INV-05 THROUGH THE PRODUCTION READER
 * (docs/PHASE_3_S8_CONTRACT.md A-10, A-11, §4.1, §4.3).
 *
 * The suites never re-implement a reconciliation check: they run the reader's
 * own SQL (`DatabaseAccountingReconciliationReader`) through the framework's
 * own `reconcile()` — statuses, the offending-id cap, `assertSafeCheckResult`
 * — over a pool of the caller's choosing:
 *   - the `daftar_reconciler` credential (the authority production uses, so a
 *     missing grant answers `unavailable`, never `ok`);
 *   - a scratch database's reconciler, for the planted defects.
 *
 * `reconcile()` visits every business its reader enumerates. A suite that
 * asks about ONE business wraps the reader so its enumeration is exactly that
 * business; the check itself is the production reader's, unchanged.
 */
import type { Pool } from 'pg';
import {
  INVENTORY_RECONCILIATION_CHECK_IDS,
  reconcile,
  type AccountingReconciliationReader,
  type ReconciliationCheckResult,
  type ReconciliationRunResult,
  type ReconciliationTarget,
} from '@daftar/accounting';
import { DatabaseAccountingReconciliationReader } from '../../apps/api/src/modules/accounting/accounting-reconciliation.reader';
import { PoolReconciliationConnection } from './accounting-reconciliation';

/** Whatever list `reconcile()` accepts in `options.checks`. */
export type CheckList = NonNullable<NonNullable<Parameters<typeof reconcile>[2]>['checks']>;
export type CheckId = CheckList[number];

/** The five inventory checks, as the list `reconcile()` accepts. */
export const R_INV: CheckList = INVENTORY_RECONCILIATION_CHECK_IDS;

const clock = { now: (): Date => new Date() };

/** The production reader over `pool`, enumerating exactly `target`. */
export function readerFor(pool: Pool, target: ReconciliationTarget): AccountingReconciliationReader {
  const inner = new DatabaseAccountingReconciliationReader(new PoolReconciliationConnection(pool));
  return {
    targets: async () => [target],
    check: (t, id) => inner.check(t, id),
  };
}

/** Run `checks` (default R-INV-01 … R-INV-05) for one business over `pool`. */
export async function runChecks(pool: Pool, target: ReconciliationTarget, checks: CheckList = R_INV): Promise<ReconciliationRunResult> {
  return reconcile(readerFor(pool, target), clock, { checks });
}

/** The one result of `checkId` in `run`. */
export function resultOf(run: ReconciliationRunResult, checkId: CheckId): ReconciliationCheckResult {
  const r = run.results.filter((x) => x.checkId === checkId);
  if (r.length !== 1) throw new Error(`expected exactly one ${checkId} result, found ${r.length}`);
  const only = r[0];
  if (only === undefined) throw new Error(`no ${checkId} result`);
  return only;
}

/** `checkId → status` for every result in `run`. */
export function statuses(run: ReconciliationRunResult): Record<string, string> {
  return Object.fromEntries(run.results.map((r) => [r.checkId, r.status]));
}
