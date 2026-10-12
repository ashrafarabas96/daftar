import { refuse } from './errors';
import type { AnalyticsInterval, Derived } from './provenance';

/**
 * The ports Phase 13 reads through.
 *
 * MEASURED FACT, 2026-10-12, and the reason these are interfaces and not calls:
 * the modules that own the canonical sales, POS and receivables reads exist on
 * the Phase 4 integration branch and DO NOT EXIST on `main`. There is nothing
 * to call from here yet. So the shape of the dependency is declared now, the
 * adapter is written on the day Phase 4 seals, and until then every port has a
 * fail-closed implementation that refuses rather than a stub that answers.
 *
 * A stub that returns zero is the dangerous option: zero is a number, and a
 * number reaches a screen.
 */

export interface SaleSummaryRow {
  readonly saleId: string;
  readonly customerId: string | null;
  readonly documentDate: string;
  readonly netTxnMinor: bigint;
  readonly isReturn: boolean;
}

export interface SalesReadPort {
  /** Committed, non-void sales for a customer in an interval, from the sales authority. */
  committedSales(customerId: string, interval: AnalyticsInterval): Promise<readonly SaleSummaryRow[]>;
}

export interface ReceivablesReadPort {
  /** Outstanding, from the one definition that owns it. Never recomputed here. */
  customerOutstandingMinor(customerId: string): Promise<Derived<bigint>>;
}

/**
 * The fail-closed implementations. They are the live behaviour until the
 * integrated surface exists, and they are also what a test uses to prove that a
 * caller handles a refusal rather than rendering a blank.
 */
export const UNAVAILABLE_SALES_PORT: SalesReadPort = {
  committedSales: () =>
    Promise.reject(
      refusalFor('the sales read authority is not present on this branch; it lands when Phase 4 seals'),
    ),
};

export const UNAVAILABLE_RECEIVABLES_PORT: ReceivablesReadPort = {
  customerOutstandingMinor: () =>
    Promise.reject(
      refusalFor('the receivables read authority is not present on this branch; it lands when Phase 4 seals'),
    ),
};

function refusalFor(message: string): Error {
  try {
    refuse('analytics.waiting_for_integrated_surface', message);
  } catch (e) {
    return e as Error;
  }
  /* istanbul ignore next -- refuse() never returns */
  throw new Error('unreachable');
}
