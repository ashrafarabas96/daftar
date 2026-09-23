/**
 * RECONCILIATION — the part of Phase 2 that is allowed to find a problem and
 * is not allowed to solve it (P2-S8 §20-§22).
 *
 * The whole point of this module is the asymmetry. It reads the journal, it
 * compares the journal against the invariants the accepted slices claim to
 * enforce, and when the two disagree it produces evidence. It never writes,
 * never reverses, never adjusts and never "repairs". A reconciliation pass
 * that silently corrected a discrepancy would destroy the only signal that
 * something in the trusted path is wrong — the discrepancy itself — and
 * would leave a financial change nobody authorized.
 *
 *   DISCREPANCY -> ALERT / EVIDENCE      (always)
 *   DISCREPANCY -> SILENT FIX            (never)
 *
 * Two further rules shape every type below.
 *
 * IT IS READ-ONLY BY CONSTRUCTION, not by convention. There is no correction
 * command in this file, no `repair` flag, and no port through which one could
 * be added without changing the contract. The reader port exposes exactly two
 * verbs, both of which return rows.
 *
 * IT CARRIES NO MONEY. A reconciliation result may say WHICH business, WHICH
 * check, HOW MANY objects offended and WHICH ids they are. It may never say
 * by how much. `assertSafeCheckResult` enforces that mechanically rather than
 * asking a reviewer to notice, because a log line is exactly where a balance
 * must not end up (§22, §26).
 */
import { AccountingError } from './errors';

/** The Phase 2 checks — the ones this phase can truthfully evaluate today. */
export const RECONCILIATION_CHECK_IDS = ['R-ACC-01', 'R-ACC-02', 'R-ACC-03', 'R-ACC-04', 'R-ACC-05', 'R-ACC-06', 'R-ACC-07', 'R-ACC-08', 'R-ACC-09'] as const;

export type ReconciliationCheckId = (typeof RECONCILIATION_CHECK_IDS)[number];

export interface ReconciliationCheckDefinition {
  readonly id: ReconciliationCheckId;
  /** A stable, non-financial description. Safe to log, safe to alert on. */
  readonly title: string;
  /** The accepted invariant this check re-derives from the journal. */
  readonly invariant: string;
  /**
   * The tables the check must READ. Declared rather than discovered so a
   * check that cannot run says so before it runs, instead of failing with a
   * driver error that a caller might mistake for a clean result.
   */
  readonly requires: readonly string[];
}

/**
 * Every check, in the order a run executes them.
 *
 * The order is not arbitrary: the structural checks (01, 02, 04) come first
 * because a database that fails them makes the derived ones meaningless, and
 * R-ACC-03 — the accounting identity — comes after the arithmetic ones it
 * depends on.
 */
export const RECONCILIATION_CHECKS: readonly ReconciliationCheckDefinition[] = [
  {
    id: 'R-ACC-01',
    title: 'entry balance',
    invariant: 'no posted entry whose base debit total differs from its base credit total',
    requires: ['journal_entries', 'journal_lines'],
  },
  {
    id: 'R-ACC-02',
    title: 'global balance',
    invariant: 'per business, total base debit equals total base credit across the whole journal',
    requires: ['journal_lines'],
  },
  {
    id: 'R-ACC-03',
    title: 'trial-balance identity',
    invariant: 'assets + expenses equals liabilities + equity + revenue, in base currency',
    requires: ['journal_lines', 'accounts'],
  },
  {
    id: 'R-ACC-04',
    title: 'orphan integrity',
    invariant: 'every line belongs to an entry of its own business and names an account of that business',
    requires: ['journal_entries', 'journal_lines', 'accounts'],
  },
  {
    id: 'R-ACC-05',
    title: 'period integrity',
    invariant: 'no posted entry is dated inside a period that is CLOSED right now',
    requires: ['journal_entries', 'accounting_periods'],
  },
  {
    id: 'R-ACC-06',
    title: 'source registry',
    invariant: 'every posted source_type is a registered source type',
    requires: ['journal_entries'],
  },
  {
    id: 'R-ACC-07',
    title: 'FX snapshot completeness',
    invariant: 'every foreign-currency line carries the complete persisted FX snapshot it was posted with',
    requires: ['journal_lines', 'businesses'],
  },
  {
    id: 'R-ACC-08',
    title: 'journal/source binding',
    invariant: 'every posted entry has exactly one source binding, and every binding names an entry of the same business',
    requires: ['journal_entries', 'accounting_source_bindings'],
  },
  {
    id: 'R-ACC-09',
    title: 'financial_started_at consistency',
    invariant: 'a business has journal history if and only if financial_started_at is set',
    requires: ['journal_entries', 'businesses'],
  },
];

/**
 * What a reconciliation domain is NOT reconciled here, and why.
 *
 * Recorded as data rather than prose so the acceptance evidence can print it
 * and the gate can assert it: claiming to reconcile a store that does not
 * exist is the most expensive kind of false green (§21).
 */
export interface DeferredReconciliationDomain {
  readonly id: string;
  readonly reason: string;
  readonly owningPhase: string;
}

export const DEFERRED_RECONCILIATION_DOMAINS: readonly DeferredReconciliationDomain[] = [
  { id: 'inventory-valuation', reason: 'the inventory domain does not exist yet', owningPhase: 'Phase 3' },
  { id: 'ar-ap-operational', reason: 'customers and suppliers do not exist yet', owningPhase: 'Phase 3' },
  { id: 'sales-payment', reason: 'sales and payments do not exist yet', owningPhase: 'Phase 4' },
  {
    id: 'read-model-drift',
    reason: 'NOT APPLICABLE — P2-S7 reads are aggregated live from the journal; there is no second store to drift',
    owningPhase: 'not applicable',
  },
];

/**
 * The four honest outcomes of a check.
 *
 * `unavailable` is the one that earns its place by being uncomfortable. A
 * check the running credential cannot evaluate — because the database refuses
 * it the tables the check reads — is NOT ok, and calling it ok would be the
 * exact false green §4 forbids. It is not an `error` either: nothing failed,
 * the check simply never ran. Naming it separately is what lets the gate and
 * the evidence artifact count it and refuse to call the run complete.
 */
export type ReconciliationStatus = 'ok' | 'discrepancy' | 'error' | 'unavailable';

/**
 * Raised by a reader when the credential it runs under cannot read a table
 * the check needs. It is deliberately NOT an AccountingError: an authority
 * boundary is not an accounting refusal, and conflating the two is how a
 * missing grant ends up reported as a clean book.
 */
export class ReconciliationUnavailableError extends Error {
  readonly checkId: ReconciliationCheckId;
  readonly missingTables: readonly string[];
  constructor(checkId: ReconciliationCheckId, missingTables: readonly string[]) {
    super(`reconciliation check ${checkId} cannot run: the reconciliation credential cannot read ${missingTables.join(', ')}`);
    this.name = 'ReconciliationUnavailableError';
    this.checkId = checkId;
    this.missingTables = [...missingTables];
  }
}

/** The one sentence a discrepancy signal must always carry (§26). */
export const NO_CORRECTION_NOTICE = 'NO AUTOMATIC CORRECTION PERFORMED';

/** At most this many offending ids travel with a result. Evidence, not a dump. */
export const MAX_OFFENDING_IDS = 20;

/** What the reader returns for one check. Ids and a count — nothing else. */
export interface ReconciliationFinding {
  /** How many objects offended in total, even when only some ids are carried. */
  readonly offendingCount: number;
  /** Safe identifiers (UUIDs) of offending objects, capped at MAX_OFFENDING_IDS. */
  readonly offendingIds: readonly string[];
}

export interface ReconciliationTarget {
  readonly tenantId: string;
  readonly businessId: string;
}

/**
 * One check, one business, one run.
 *
 * Every field here is either an identifier, a status, a count or a timing.
 * That list is the §22 contract, and `assertSafeCheckResult` refuses anything
 * outside it.
 */
export interface ReconciliationCheckResult {
  readonly businessId: string;
  readonly checkId: ReconciliationCheckId;
  readonly status: ReconciliationStatus;
  readonly offendingCount: number;
  readonly offendingIds: readonly string[];
  readonly durationMs: number;
  readonly startedAt: string;
  readonly completedAt: string;
  /** Present on 'error' only: a stable machine code, never a driver message. */
  readonly errorCode?: string;
  /** Always the same sentence. A result can never imply something was fixed. */
  readonly correction: typeof NO_CORRECTION_NOTICE;
}

export interface ReconciliationRunResult {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly businessCount: number;
  readonly checkCount: number;
  readonly discrepancyCount: number;
  readonly errorCount: number;
  /** Checks the running credential could not evaluate at all (§50 counts these). */
  readonly unavailableCount: number;
  /**
   * Whether the pass could even determine WHICH businesses to check.
   *
   * `unavailable` means the numbers below describe nothing: a run that
   * listed no businesses has not found a clean system, it has not looked.
   */
  readonly enumeration: 'complete' | 'unavailable';
  /** Present when enumeration is unavailable: the authority that was missing. */
  readonly enumerationReason?: string;
  readonly results: readonly ReconciliationCheckResult[];
  readonly correction: typeof NO_CORRECTION_NOTICE;
}

/**
 * Raised when the credential cannot LIST the businesses to reconcile.
 *
 * It is separate from the per-check error because its consequence is
 * different and worse: a pass that cannot enumerate returns zero results,
 * and zero results is indistinguishable from a clean system. Making it a
 * distinct, named outcome is what stops "we reconciled nothing" from being
 * reported as "we found nothing wrong".
 */
export class ReconciliationEnumerationError extends Error {
  readonly missingAuthority: string;
  constructor(missingAuthority: string) {
    super(`reconciliation cannot enumerate the businesses to check: ${missingAuthority}`);
    this.name = 'ReconciliationEnumerationError';
    this.missingAuthority = missingAuthority;
  }
}

/**
 * The reader port.
 *
 * Two verbs, both SELECT. There is deliberately no third verb: a port with a
 * write on it is a port through which a "repair" eventually arrives.
 */
export interface AccountingReconciliationReader {
  /** Every business the run should visit, in a stable order. */
  targets(): Promise<readonly ReconciliationTarget[]>;
  /** Run one check against one business and return what offended. */
  check(target: ReconciliationTarget, checkId: ReconciliationCheckId): Promise<ReconciliationFinding>;
}

/** Monotonic-enough clock seam so scheduling and durations are testable (§25). */
export interface ReconciliationClock {
  now(): Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_RESULT_KEYS = new Set([
  'businessId',
  'checkId',
  'status',
  'offendingCount',
  'offendingIds',
  'durationMs',
  'startedAt',
  'completedAt',
  'errorCode',
  'correction',
]);

/**
 * The mechanical half of the §22 contract.
 *
 * It is written as a refusal rather than a review note on purpose. A future
 * slice that adds `totalDebit` to a result to make a dashboard easier will
 * not get a comment on a pull request — it will get a failing test, in every
 * gate that composes this one, before the field ever reaches a log.
 *
 * Note what it checks beyond the key list: ids must be UUIDs. A check that
 * "helpfully" put an account CODE or an amount in `offendingIds` would pass a
 * key-name check and fail this one.
 */
export function assertSafeCheckResult(result: ReconciliationCheckResult): void {
  for (const key of Object.keys(result)) {
    if (!ALLOWED_RESULT_KEYS.has(key)) {
      throw new AccountingError('accounting.payload_unknown_field', `reconciliation result carries a field outside the safe contract: ${key}`);
    }
  }
  if (result.correction !== NO_CORRECTION_NOTICE) {
    throw new AccountingError('accounting.payload_invalid', 'reconciliation result must always carry the no-correction notice');
  }
  if (!UUID.test(result.businessId)) {
    throw new AccountingError('accounting.payload_invalid', 'reconciliation result business id is not an identifier');
  }
  if (!Number.isInteger(result.offendingCount) || result.offendingCount < 0) {
    throw new AccountingError('accounting.payload_invalid', 'reconciliation offending count is not a whole non-negative number');
  }
  if (result.offendingIds.length > MAX_OFFENDING_IDS) {
    throw new AccountingError('accounting.payload_invalid', 'reconciliation result carries more offending ids than the contract allows');
  }
  for (const id of result.offendingIds) {
    if (!UUID.test(id)) {
      throw new AccountingError('accounting.payload_invalid', 'reconciliation offending id is not an identifier');
    }
  }
  if (result.status === 'ok' && result.offendingCount !== 0) {
    throw new AccountingError('accounting.payload_invalid', 'an OK reconciliation result cannot carry offending objects');
  }
  if (result.status === 'discrepancy' && result.offendingCount === 0) {
    throw new AccountingError('accounting.payload_invalid', 'a discrepancy reconciliation result must carry at least one offending object');
  }
  if (result.status === 'unavailable' && result.errorCode === undefined) {
    throw new AccountingError('accounting.payload_invalid', 'an unavailable reconciliation check must say which authority it lacked');
  }
  if (result.status === 'unavailable' && result.offendingCount !== 0) {
    throw new AccountingError('accounting.payload_invalid', 'a check that never ran cannot have found anything');
  }
  if (result.status !== 'error' && result.status !== 'unavailable' && result.errorCode !== undefined) {
    throw new AccountingError('accounting.payload_invalid', 'only a failed or unavailable reconciliation check may carry an error code');
  }
}

/**
 * Run every check against every business.
 *
 * Failure policy is deliberate: a check that THROWS becomes an `error`
 * result and the run continues. The alternative — abort the pass — would let
 * one unreadable business hide a real discrepancy in every business after it.
 * An `error` is never an `ok`: the run's `errorCount` is non-zero and the
 * caller treats it as a failed run (§26).
 *
 * Restart safety (§24) needs no machinery here. The pass holds no cursor, no
 * lease and no partial state, because it writes nothing: a worker that dies
 * after check N simply starts again from the first check on the next run.
 */
export async function reconcile(
  reader: AccountingReconciliationReader,
  clock: ReconciliationClock,
  options: { readonly checks?: readonly ReconciliationCheckId[] } = {},
): Promise<ReconciliationRunResult> {
  const checkIds = options.checks ?? RECONCILIATION_CHECK_IDS;
  const runStarted = clock.now();
  let targets: readonly ReconciliationTarget[] = [];
  let enumerationReason: string | undefined;
  try {
    targets = await reader.targets();
  } catch (e) {
    if (!(e instanceof ReconciliationEnumerationError)) throw e;
    enumerationReason = e.missingAuthority;
  }
  const results: ReconciliationCheckResult[] = [];

  for (const target of targets) {
    for (const checkId of checkIds) {
      const startedAt = clock.now();
      let status: ReconciliationStatus = 'ok';
      let offendingCount = 0;
      let offendingIds: readonly string[] = [];
      let errorCode: string | undefined;
      try {
        const finding = await reader.check(target, checkId);
        offendingCount = finding.offendingCount;
        offendingIds = finding.offendingIds.slice(0, MAX_OFFENDING_IDS);
        status = offendingCount > 0 ? 'discrepancy' : 'ok';
      } catch (e) {
        offendingCount = 0;
        offendingIds = [];
        if (e instanceof ReconciliationUnavailableError) {
          status = 'unavailable';
          errorCode = `accounting.reconciliation_unavailable:${e.missingTables.join('+')}`;
        } else {
          status = 'error';
          errorCode = e instanceof AccountingError ? e.code : 'accounting.reconciliation_check_failed';
        }
      }
      const completedAt = clock.now();
      const result: ReconciliationCheckResult = {
        businessId: target.businessId,
        checkId,
        status,
        offendingCount,
        offendingIds,
        durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        ...(errorCode === undefined ? {} : { errorCode }),
        correction: NO_CORRECTION_NOTICE,
      };
      assertSafeCheckResult(result);
      results.push(result);
    }
  }

  const runCompleted = clock.now();
  return {
    startedAt: runStarted.toISOString(),
    completedAt: runCompleted.toISOString(),
    durationMs: Math.max(0, runCompleted.getTime() - runStarted.getTime()),
    businessCount: targets.length,
    checkCount: checkIds.length,
    discrepancyCount: results.filter((r) => r.status === 'discrepancy').length,
    errorCount: results.filter((r) => r.status === 'error').length,
    unavailableCount: results.filter((r) => r.status === 'unavailable').length,
    results,
    enumeration: enumerationReason === undefined ? 'complete' : 'unavailable',
    ...(enumerationReason === undefined ? {} : { enumerationReason }),
    correction: NO_CORRECTION_NOTICE,
  };
}
