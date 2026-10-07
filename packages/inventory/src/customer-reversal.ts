/**
 * P4-S6 — THE REVERSAL PLANNER. Levels A and B only.
 *
 * This module is the pure domain of `payment_reversals`, `allocation_reversals`
 * and the `void_invoice` surface: the tail check, the whole-payment rule, the
 * two-chain rule, and the selection of the journal entries whose EXACT INVERSE
 * a reversal posts. It reads no clock, no database, no rate registry and no
 * configuration; every export is a function of its arguments.
 *
 * ## The four laws it implements, and the one it refuses to model
 *
 * `TL-P4-S6-R1` (`docs/PHASE_4_DECISION_REGISTER.md` §13) rules the LIFO-only
 * fallback ACTIVE and closes Option B. So there is no signed-negative ordinary
 * reducer anywhere below, no alternative mechanism, and no comparison of the
 * two: `OD-P4-04` is RULED, not pending, and a module that modelled the closed
 * option would be re-opening it.
 *
 * 1. **The LIFO law.** A reversal is allowed only when the original reducer is
 *    the LAST ACTIVE SETTLEMENT REDUCER on EVERY chain it affects. The original
 *    row is immutable; the reversal is a separate append-only row. There is no
 *    `reversed` boolean on the original, no mutation, no delete.
 * 2. **The whole-payment law.** A payment reversal covers EVERY active
 *    allocation of that payment. Each one must be a valid tail under the lock,
 *    or the WHOLE command is REFUSED. There is no partial reversal, and
 *    `planPaymentReversal` has no parameter through which one could be asked
 *    for — which is stronger than validating one away
 *    (`accounting_post_reversal`'s own argument, `0046:432-440`).
 * 3. **The two-chain law.** A `customer_credit_applications` row sits on TWO
 *    chains: the invoice's AR chain, keyed by `ar_released_before_txn_minor`
 *    ASCENDING from 0, and the credit's consumption chain, keyed by
 *    `credit_remaining_before_minor` DESCENDING from `original_amount_minor`.
 *    It is reversible only when it is the tail on BOTH, in ONE transaction.
 * 4. **The exact-inverse law.** The journal reversal is the exact inverse of
 *    the ORIGINAL STORED financial effect. Historical carrying release is never
 *    recomputed. This module therefore computes NO money at all: it names which
 *    persisted entry to mirror, and the mirror itself is
 *    `mirrorReversalLines` (`packages/accounting/src/sources.ts:143`), the
 *    accepted single body of that truth, reached through
 *    `accounting_post_reversal` (`0046:449`). There is no `HALF_EVEN`, no
 *    release formula and no rate in this file, and that absence is the law.
 *
 * ## "LIFO" here is the SETTLEMENT chain and never inventory costing
 *
 * The word names the LAST ACTIVE SETTLEMENT REDUCER on a receivable or a
 * customer credit. It is not a valuation method. Inventory stays written by the
 * accepted stock-movement authority; nothing here reads, writes or reinterprets
 * a cost, and no export of this module is reachable from a valuation path.
 *
 * ## Chain levels are the SAME predicate the database already states
 *
 * `invoice_settlement_verify` (`0081:691`) orders an invoice's reducers by `x`
 * and requires `x = before`, where `before` is the running sum of the amounts
 * ahead of the row. `isContiguousFromZero` below is that predicate, restated
 * over the ACTIVE subset, and `tailOf` is the single row whose `x + amount`
 * reaches the chain's active total. Stating it twice — here and in SQL — is the
 * accepted two-derivations device (`0046:440-446`): a disagreement is a
 * refusal, never a wrong row.
 *
 * ## What this module does NOT do, by construction
 *
 * It allocates no migration number and names none: the real prefix of S6's DDL
 * is unknown while its predecessors are in acceptance, and
 * `docs/PHASE_4_S6_DDL_SPECIFICATION.md` is a specification, not a file. It
 * registers no operation code in `INVENTORY_OPERATION_CODES` and no source type
 * in `DOMAIN_SOURCE_TYPES`; both registrations are owed by patch request
 * (`docs/patch-requests/PATCH-REQ-S6-001.md`, `-003`), because a declared
 * operation with no command path behind it is a false entry in two registries
 * that are read as inventories of what exists.
 */
import { VALUE_LIMIT_MINOR } from './fixed-point';

// ──────────────────────────────────────────────────────────────────────────
// 0. The refusal vocabulary.
// ──────────────────────────────────────────────────────────────────────────

/**
 * EVERY CODE THIS MODULE CAN RAISE, as a closed literal union, written out per
 * domain rather than templated — the `ReceivableArithmeticCode` convention
 * (`customer-settlement.ts:138`) and for the reason recorded there: a templated
 * union is symmetric by construction and hides a live raise site that no status
 * table classifies.
 *
 * None of these is an `InventoryErrorCode` yet. That widening is
 * `PATCH-REQ-S6-002`, and until it lands the compile-time binding
 * `Record<Exclude<ReversalCode, InventoryErrorCode>, never>` that
 * `customer-settlement.ts:202` carries CANNOT be written here without a type
 * error — so it is owed rather than faked, and `REVERSAL_CODES` below is the
 * list the patch request is checked against from this side.
 *
 * The three namespaces are the three documents: a payment reversal, an
 * allocation reversal, and the void of an invoice. `invoice_void.*` is the only
 * one of the three whose first segment is not also an operation-code namespace,
 * because `sale.void_invoice` is the operation and `invoice_void` is the
 * refusal domain — the same split `invoice_settlement.*` already makes against
 * `customer.collect_payment` (`0081:691`).
 */
export type ReversalCode =
  // ── The payment reversal ──────────────────────────────────────────────
  | 'payment_reversal.not_found'
  | 'payment_reversal.already_reversed'
  | 'payment_reversal.idempotency_conflict'
  | 'payment_reversal.not_last_reducer'
  | 'payment_reversal.chain_inconsistent'
  | 'payment_reversal.credit_consumed'
  | 'payment_reversal.date_before_original'
  | 'payment_reversal.date_invalid'
  | 'payment_reversal.reason_required'
  // ── The allocation reversal ───────────────────────────────────────────
  | 'allocation_reversal.not_found'
  | 'allocation_reversal.already_reversed'
  | 'allocation_reversal.idempotency_conflict'
  | 'allocation_reversal.not_last_reducer'
  | 'allocation_reversal.chain_inconsistent'
  | 'allocation_reversal.date_before_original'
  | 'allocation_reversal.date_invalid'
  | 'allocation_reversal.reason_required'
  // ── The void surface ──────────────────────────────────────────────────
  | 'invoice_void.direct_update_refused'
  | 'invoice_void.not_found'
  | 'invoice_void.idempotency_conflict'
  | 'invoice_void.date_invalid'
  | 'invoice_void.state_invalid'
  | 'invoice_void.reducers_not_reversed';

/**
 * The union as data, for the registration patch requests and for the locale
 * catalogues. Sorted, so a diff against the union is a diff and not a
 * reordering.
 */
export const REVERSAL_CODES: readonly ReversalCode[] = Object.freeze([
  'allocation_reversal.already_reversed',
  'allocation_reversal.chain_inconsistent',
  'allocation_reversal.date_before_original',
  'allocation_reversal.date_invalid',
  'allocation_reversal.idempotency_conflict',
  'allocation_reversal.not_found',
  'allocation_reversal.not_last_reducer',
  'allocation_reversal.reason_required',
  'invoice_void.date_invalid',
  'invoice_void.direct_update_refused',
  'invoice_void.idempotency_conflict',
  'invoice_void.not_found',
  'invoice_void.reducers_not_reversed',
  'invoice_void.state_invalid',
  'payment_reversal.already_reversed',
  'payment_reversal.chain_inconsistent',
  'payment_reversal.credit_consumed',
  'payment_reversal.date_before_original',
  'payment_reversal.date_invalid',
  'payment_reversal.idempotency_conflict',
  'payment_reversal.not_found',
  'payment_reversal.not_last_reducer',
  'payment_reversal.reason_required',
] as const);

/**
 * The union and the array are held to each other BY THE COMPILER, so a code
 * added to one and forgotten in the other is a type error and not a gap a test
 * has to notice. The `customer-settlement.ts:184` device.
 */
const EXHAUSTIVE: Record<ReversalCode, true> = Object.freeze(Object.fromEntries(REVERSAL_CODES.map((c) => [c, true])) as Record<ReversalCode, true>);

/** `true` iff `code` is one of this module's codes. */
export function isReversalCode(code: string): code is ReversalCode {
  return Object.prototype.hasOwnProperty.call(EXHAUSTIVE, code);
}

/** A refusal of this module. Carries its code and NEVER an amount. */
export class ReversalError extends Error {
  public readonly code: ReversalCode;

  constructor(code: ReversalCode, message: string) {
    super(message);
    this.name = 'ReversalError';
    this.code = code;
  }
}

function refuse(code: ReversalCode, message: string): never {
  throw new ReversalError(code, message);
}

/**
 * A `DATE` as the database stores it, and as the request carries it: exactly
 * `YYYY-MM-DD`, and a real day of a real month.
 *
 * It exists because of a CHALLENGE FINDING. The two date comparisons below are
 * `<` over strings — which is the right comparison for canonical ISO dates and
 * the WRONG one for anything else, since `'2026-3-02' < '2026-03-01'` is true
 * by character order and false by calendar. An unvalidated string therefore
 * passed `date_before_original` while being earlier than the original. The
 * comparison is kept (it is exact on canonical input, and it reads no clock,
 * P4-AL-30); the input is now canonicalised FIRST, which is where the defect
 * actually was. A non-canonical date is a payload fault, so it refuses with its
 * own code rather than borrowing the ordering law's.
 */
const CANONICAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertCanonicalDate(value: string, what: string, code: ReversalCode): void {
  if (!CANONICAL_DATE.test(value)) {
    refuse(code, `${what} must be a canonical YYYY-MM-DD date; ${JSON.stringify(value)} is not`);
  }
  // A shape that matches the regex can still name no day: 2026-02-31 and
  // 2026-13-01 both do. The round trip is the calendar's own answer and reads
  // no clock — `Date.UTC` of the three parts, formatted back.
  const [y, m, d] = value.split('-').map((x) => Number.parseInt(x, 10));
  const t = new Date(Date.UTC(y ?? 0, (m ?? 0) - 1, d ?? 0));
  if (t.toISOString().slice(0, 10) !== value) {
    refuse(code, `${what} names no day of the calendar: ${JSON.stringify(value)}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 1. The operation and authority surface (level B).
// ──────────────────────────────────────────────────────────────────────────

/**
 * The three operation codes S6 needs, each satisfying the FROZEN regex
 * `^[a-z]+(\.[a-z_]+)+$` (`0054:53`, duplicated inside
 * `inventory_payload_digest` at `0054:229`) — so the first segment carries no
 * underscore, and `payment_reversal.create` was never a candidate shape
 * (P4-AL-28).
 *
 * They are declared here as plain literals and are deliberately NOT added to
 * `InventoryOperationCode` / `INVENTORY_OPERATION_CODES`: that registry is read
 * as an inventory of commands that EXIST, and `gate:phase4:s4`'s
 * `command-refusal-audit` check discovers a command path per declared
 * operation. Registering three codes with no routine behind them would make
 * that check report a path it cannot find. `PATCH-REQ-S6-001` is the owed edit.
 */
export type ReversalOperationCode = 'customer.reverse_payment' | 'customer.reverse_allocation' | 'sale.void_invoice';

/** The three codes as data, in the order their documents appear in this file. */
export const REVERSAL_OPERATION_CODES: readonly ReversalOperationCode[] = Object.freeze([
  'customer.reverse_payment',
  'customer.reverse_allocation',
  'sale.void_invoice',
] as const);

/** The frozen operation-code regex, restated so this module's own codes are checked against it. */
export const FROZEN_OPERATION_CODE_PATTERN = /^[a-z]+(\.[a-z_]+)+$/;

/**
 * The permission each operation requires, from the CLOSED SET OF TWELVE
 * (`packages/domain-core/src/permissions.ts:68-89`, P4-AL-36). Nothing is
 * invented: `payments.reverse` (`permissions.ts:85`) and `sales.void`
 * (`permissions.ts:80`) both already exist and are both SENSITIVE
 * (`permissions.ts:137-145`), so under the `OD-P4-01` OPTION A ruling neither
 * is a default of any built-in role — the cashier and the manager included.
 *
 * A thirteenth key is not added, and `reversals.*` must never become one.
 */
export const REVERSAL_OPERATION_AUTHORITY: Readonly<Record<ReversalOperationCode, 'payments.reverse' | 'sales.void'>> = Object.freeze({
  'customer.reverse_payment': 'payments.reverse',
  'customer.reverse_allocation': 'payments.reverse',
  'sale.void_invoice': 'sales.void',
});

// ──────────────────────────────────────────────────────────────────────────
// 2. The chain model (level A).
// ──────────────────────────────────────────────────────────────────────────

/**
 * One ACTIVE settlement reducer on ONE chain, as the chain sees it.
 *
 * `level` is the chain position the row DECLARED when it was written, and
 * `amount` the amount it consumed at that position. Both are in the chain's own
 * unit — the invoice's transaction currency on an AR chain, the credit's
 * currency on a credit chain — and the two are never mixed, because a chain is
 * only ever one of the two.
 *
 * `originalEntryId` is the persisted journal entry this reducer posted. It is
 * what a reversal mirrors, and it is carried here rather than looked up later
 * so that the planner's output names the entry and computes no figure from it.
 *
 * There is no `reversed` field. Activeness is a property of the SET handed to
 * the planner: the repository port's contract is that it returns the active
 * reducers, which it derives by anti-joining the reversal relations. A boolean
 * on the row would be a mutation of an immutable row, which the LIFO law
 * forbids outright.
 */
export interface ActiveReducer {
  /** The reducer row's own id — a `payment_allocations.id` or a `customer_credit_applications.id`. */
  readonly reducerId: string;
  /** Which relation the row is in. The chain is a UNION over both (`0081:739-748`). */
  readonly kind: 'payment_allocation' | 'credit_application';
  /** The declared chain position, `>= 0`. */
  readonly level: bigint;
  /** The amount consumed at that position, `> 0`. */
  readonly amount: bigint;
  /** The journal entry this reducer posted, whose exact inverse its reversal is. */
  readonly originalEntryId: string;
}

/** Which chain a reducer sits on, and how its levels run. */
export type ChainKind = 'invoice_ar' | 'customer_credit';

/**
 * A chain, as the planner is given it.
 *
 * `capacity` is the chain's total: the invoice's `total_txn_minor` on an
 * `invoice_ar` chain, the credit's `original_amount_minor` on a
 * `customer_credit` chain. It bounds the active total and nothing else; this
 * module never divides by it, because no release is recomputed here.
 *
 * On an `invoice_ar` chain `level` ASCENDS from 0 and the tail is the row that
 * reaches the active total. On a `customer_credit` chain the stored column is
 * `credit_remaining_before_minor`, which DESCENDS from `capacity`; the
 * constructor `creditChain` below converts it to the one ascending form this
 * module reasons in, so there is ONE tail predicate and not two.
 */
export interface SettlementChain {
  /** The chain's own id: an `invoices.id` or a `customer_credits.id`. */
  readonly chainId: string;
  readonly kind: ChainKind;
  /** The chain's total, `> 0`. */
  readonly capacity: bigint;
  /** The active reducers, in any order; the planner sorts. */
  readonly active: readonly ActiveReducer[];
}

function assertMinor(v: bigint, what: string, min: bigint): void {
  if (v < min || v > VALUE_LIMIT_MINOR) {
    refuse('allocation_reversal.chain_inconsistent', `${what} is outside the representable range of a minor-unit column`);
  }
}

/**
 * The active reducers in chain order. Ties on `level` are ordered by `amount`
 * and then by `reducerId`, which is the `ORDER BY d.x, d.amount` of
 * `invoice_settlement_verify` (`0081:746`) with `reducerId` appended so the
 * order is TOTAL — a window function over a non-total order is
 * non-deterministic, and two active rows at one level is exactly the state the
 * replacement protection of `docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` must be able
 * to see rather than sort away.
 */
export function orderedActive(chain: SettlementChain): readonly ActiveReducer[] {
  return [...chain.active].sort((a, b) => {
    if (a.level !== b.level) return a.level < b.level ? -1 : 1;
    if (a.amount !== b.amount) return a.amount < b.amount ? -1 : 1;
    return a.reducerId < b.reducerId ? -1 : a.reducerId > b.reducerId ? 1 : 0;
  });
}

/** The chain's active total — `Σ amount` over the active set. */
export function activeTotal(chain: SettlementChain): bigint {
  return chain.active.reduce((acc, r) => acc + r.amount, 0n);
}

/**
 * The chain law, over the ACTIVE subset: every active reducer's declared level
 * equals the sum of the amounts ahead of it, the first starts at 0, and the
 * active total does not exceed the capacity.
 *
 * This is `invoice_settlement_verify`'s `h.x <> h.before OR h.x + h.amount >
 * total` (`0081:751-752`), restated: a level ABOVE the recurrence is a GAP and
 * one BELOW it is an OVERLAP, and both are the same defect from either side.
 * Two active rows at one level are an OVERLAP and are caught here — which is
 * why the deferred verifier is strictly stronger than the per-relation level
 * `UNIQUE` it replaces, and not merely a different way of saying it.
 */
export function chainBreak(chain: SettlementChain): string | null {
  assertMinor(chain.capacity, 'the chain capacity', 1n);
  let before = 0n;
  for (const r of orderedActive(chain)) {
    assertMinor(r.level, 'a declared chain level', 0n);
    assertMinor(r.amount, 'a consumed amount', 1n);
    if (r.level !== before) {
      return r.level > before
        ? `reducer ${r.reducerId} declares a level above the chain recurrence (a gap)`
        : `reducer ${r.reducerId} declares a level below the chain recurrence (an overlap)`;
    }
    before += r.amount;
  }
  if (before > chain.capacity) return `the active reducers of chain ${chain.chainId} consume more than its capacity`;
  return null;
}

/** `true` iff the chain's active subset obeys the recurrence from zero. */
export function isContiguousFromZero(chain: SettlementChain): boolean {
  return chainBreak(chain) === null;
}

/**
 * ── THE REVERSAL GENERATION LAW, as a PURE FUNCTION (CHALLENGE FINDING F-C1) ──
 *
 * The second column of the replacement UNIQUE key (`chain_generation`) holds,
 * for a row at chain level `L`:
 *
 *     the number of reversals on this chain that freed a level AT OR BELOW `L`
 *     **and that already existed when this row was written**.
 *
 * Round 4 specified that law in prose and then wrote an SQL expression that
 * dropped its second clause. The expression counted every reversal at a level
 * `<= L` **as of now**, so a reversed original at level `L` counted THE REVERSAL
 * OF ITSELF — `L <= L` is true — and came out `1` where its write-time value is
 * `0`. That is not merely a wrong stored number: it manufactures the exact
 * duplicate key that the same migration's `CREATE UNIQUE INDEX` then refuses,
 * so the migration could not apply to any tree holding a reversal.
 *
 * The law is restated here as code so that it is a thing that can be WRONG in a
 * test rather than a paragraph that can only be re-read. Two forms are given,
 * because the design needs two and round 4's error was believing it needed one:
 *
 * - `writeTimeGeneration` — what a row STORES, and therefore what a backfill
 *   must reconstruct. It needs the reversal SEQUENCE, because "already existed"
 *   is an ordering question;
 * - `asOfNowGeneration` — what the deferred verifier RECOMPUTES. It needs no
 *   ordering, and it is only ever evaluated over ACTIVE rows.
 *
 * `generationFormsAgreeOnActive` is the bridge, and it is what makes the cheap
 * verifier SOUND rather than lucky: the two forms agree for every ACTIVE row of
 * a lawful chain. That is a theorem about the LIFO law and not a coincidence,
 * and the reason is short — while a row at `L` is active, no reversal at a
 * level BELOW `L` can exist, because freeing one would have required this row
 * to be reversed first; and every reversal at exactly `L` retired an earlier
 * row at `L`, so it predates this one. The reversals an active row did not see
 * are therefore all at levels ABOVE its own, and neither form counts those.
 *
 * The bridge is FALSIFIABLE and a case below falsifies it: hand it a chain with
 * a reversal below an active row — the state a direct-SQL writer can reach and
 * the commands cannot — and it answers `false`.
 */
export interface GenerationRow {
  /** The row's own id. */
  readonly rowId: string;
  /** Its declared chain level, in the one ASCENDING form this module reasons in. */
  readonly level: bigint;
  /**
   * HOW MANY REVERSALS ON THIS CHAIN ALREADY EXISTED WHEN THIS ROW WAS WRITTEN
   * — the row's position in the chain's reversal sequence, not a count of the
   * ones that matter. It is what the backfill reconstructs, in SQL, as the
   * number of the chain's reversal rows created before this row
   * (`r.created_at < a.created_at`).
   *
   * It is carried SEPARATELY from `reversedAt` on purpose. An earlier draft of
   * this law let an active row mean "all of them", which made the bridge
   * predicate below a tautology that no input could falsify — the exact vacuity
   * `[[daftar-a-green-gate-must-prove-it-can-be-red]]` is about, and its own
   * test caught it.
   */
  readonly writtenAfter: number;
  /**
   * The position of THIS row's own reversal in the chain's reversal sequence,
   * or `null` while the row is still active. It is an ORDER, never a timestamp:
   * `P4-AL-42` (interleaving, never timing) applies to the law as much as to
   * the races, and no clock is needed to say which reversal came first.
   */
  readonly reversedAt: number | null;
}

/**
 * The chain's reversals in creation order, each named by the level it freed —
 * the level of the row it retired. Position `i` is the `i`-th reversal on the
 * chain. Derived from the append-only reversal relations and from nothing else.
 */
export type ReversalSequence = readonly bigint[];

function assertSequence(seq: ReversalSequence, row: GenerationRow): void {
  if (!Number.isInteger(row.writtenAfter) || row.writtenAfter < 0 || row.writtenAfter > seq.length) {
    refuse(
      'allocation_reversal.chain_inconsistent',
      `row ${row.rowId} claims ${String(row.writtenAfter)} reversals existed when it was written, which a sequence of ${seq.length} cannot support`,
    );
  }
  if (row.reversedAt === null) return;
  if (row.reversedAt < row.writtenAfter) {
    refuse(
      'allocation_reversal.chain_inconsistent',
      `row ${row.rowId} is reversed at position ${row.reversedAt} and claims ${row.writtenAfter} reversals preceded its own write — a row cannot be reversed before it exists`,
    );
  }
  if (!Number.isInteger(row.reversedAt) || row.reversedAt < 0 || row.reversedAt >= seq.length) {
    refuse(
      'allocation_reversal.chain_inconsistent',
      `row ${row.rowId} names reversal position ${String(row.reversedAt)}, which is not a position of a sequence of ${seq.length}`,
    );
  }
  const freed = seq[row.reversedAt];
  if (freed !== row.level) {
    refuse('allocation_reversal.chain_inconsistent', `row ${row.rowId} sits at level ${row.level} but the reversal it names freed level ${String(freed)}`);
  }
}

/**
 * THE VALUE THE ROW STORES. The count of reversals at a level at or below the
 * row's own among the `writtenAfter` that already existed when the row was
 * written. Nothing later counts, whatever its level — which is the clause round
 * 4's SQL dropped.
 */
export function writeTimeGeneration(row: GenerationRow, reversals: ReversalSequence): bigint {
  assertSequence(reversals, row);
  let n = 0n;
  for (let i = 0; i < row.writtenAfter; i += 1) {
    const freed = reversals[i];
    if (freed !== undefined && freed <= row.level) n += 1n;
  }
  return n;
}

/**
 * WHAT THE DEFERRED VERIFIER RECOMPUTES: the same count with no ordering bound.
 * It is correct ONLY over active rows, and the verifier is scoped to those.
 * Applied to a reversed row it counts that row's own reversal, which is
 * precisely the defect F-C1 names.
 */
export function asOfNowGeneration(level: bigint, reversals: ReversalSequence): bigint {
  let n = 0n;
  for (const freed of reversals) if (freed <= level) n += 1n;
  return n;
}

/**
 * The bridge, as a predicate a test can make FALSE: the two forms agree for
 * every row the verifier evaluates, and for no reason other than the LIFO law.
 * It answers `false` the moment a caller hands it a history in which a reversal
 * at a level below an ACTIVE row exists — which the LIFO law forbids and which
 * is therefore the shape of a corrupted chain, not of a new case.
 */
export function generationFormsAgreeOnActive(rows: readonly GenerationRow[], reversals: ReversalSequence): boolean {
  return rows.filter((r) => r.reversedAt === null).every((r) => writeTimeGeneration(r, reversals) === asOfNowGeneration(r.level, reversals));
}

/**
 * THE LIFO PREDICATE. The chain's last active settlement reducer, or `null`
 * when the chain has none.
 *
 * It is the row that REACHES the active total: `level + amount === Σ amount`.
 * On a well-formed chain that is the maximum-level row and there is exactly
 * one. The chain is checked first and an ill-formed chain raises rather than
 * answering, because "which row is the tail" has no meaning on a chain with a
 * gap, and answering anyway is how a mid-chain row gets reversed.
 */
export function tailOf(chain: SettlementChain, domain: 'payment_reversal' | 'allocation_reversal'): ActiveReducer | null {
  const broken = chainBreak(chain);
  if (broken !== null) refuse(`${domain}.chain_inconsistent`, broken);
  const ordered = orderedActive(chain);
  const last = ordered[ordered.length - 1];
  return last === undefined ? null : last;
}

/**
 * `true` iff `reducerId` is the last active settlement reducer of this chain.
 * The whole LIFO law, as one question, and the only question the planner asks
 * of a chain.
 */
export function isLastActiveReducer(chain: SettlementChain, reducerId: string, domain: 'payment_reversal' | 'allocation_reversal'): boolean {
  const tail = tailOf(chain, domain);
  return tail !== null && tail.reducerId === reducerId;
}

/**
 * An `invoice_ar` chain from the stored columns, unchanged: `level` IS
 * `ar_released_before_txn_minor` and `capacity` IS `invoices.total_txn_minor`.
 */
export function invoiceChain(invoiceId: string, totalTxnMinor: bigint, active: readonly ActiveReducer[]): SettlementChain {
  return Object.freeze({ chainId: invoiceId, kind: 'invoice_ar' as const, capacity: totalTxnMinor, active: Object.freeze([...active]) });
}

/**
 * A `customer_credit` chain from the stored columns, CONVERTED to the ascending
 * form.
 *
 * `customer_credit_applications.credit_remaining_before_minor` descends from
 * `customer_credits.original_amount_minor`, so the consumed-before level is
 * `original − remaining_before`. The conversion is exact integer subtraction —
 * no rounding, no division, no rate — and it exists so that ONE tail predicate
 * serves both chains. The alternative, a second descending predicate, would be
 * a second statement of the LIFO law and the two would drift.
 *
 * The tail of a credit chain is therefore the application with the SMALLEST
 * `credit_remaining_before_minor`: the last consumer, which is what the LIFO
 * law means on this side.
 */
export function creditChain(
  creditId: string,
  originalAmountMinor: bigint,
  active: readonly { readonly reducerId: string; readonly remainingBeforeMinor: bigint; readonly consumedMinor: bigint; readonly originalEntryId: string }[],
): SettlementChain {
  assertMinor(originalAmountMinor, 'the credit original amount', 1n);
  return Object.freeze({
    chainId: creditId,
    kind: 'customer_credit' as const,
    capacity: originalAmountMinor,
    active: Object.freeze(
      active.map((a) => {
        assertMinor(a.remainingBeforeMinor, 'a declared credit remaining level', 1n);
        assertMinor(a.consumedMinor, 'a consumed credit amount', 1n);
        if (a.remainingBeforeMinor > originalAmountMinor) {
          refuse('allocation_reversal.chain_inconsistent', `credit consumer ${a.reducerId} declares more remaining than the credit ever had`);
        }
        return Object.freeze({
          reducerId: a.reducerId,
          kind: 'credit_application' as const,
          level: originalAmountMinor - a.remainingBeforeMinor,
          amount: a.consumedMinor,
          originalEntryId: a.originalEntryId,
        });
      }),
    ),
  });
}

// ──────────────────────────────────────────────────────────────────────────
// 3. The exact-inverse journal selection (level A).
// ──────────────────────────────────────────────────────────────────────────

/**
 * ONE journal entry a reversal must mirror.
 *
 * It carries the original entry's id and nothing else — no account, no amount,
 * no currency, no rate, no dimension. That is the point: `accounting_post_reversal`
 * (`0046:432-440`) takes WHICH entry, WHEN and WHY and reads every figure from
 * the persisted original, so "a caller cannot reverse an entry into something
 * the entry never said. There is no parameter through which it could, which is
 * stronger than validating one away." This type is that argument expressed as a
 * shape: there is no field here that could carry a recomputed carrying release.
 */
export interface ExactInverseStep {
  readonly originalEntryId: string;
  /** Which reducer or document posted it — reported for the audit row, never used as an input to a figure. */
  readonly sourceType: 'customer_payment_allocation' | 'customer_credit_application' | 'customer_credit' | 'invoice' | 'sale';
  readonly sourceId: string;
}

/**
 * The mirror steps of a reversal, in a DETERMINISTIC order.
 *
 * The order is by `originalEntryId`, which is a stable total order over the
 * steps and is independent of the order the repository happened to return rows
 * in. It matters because `accounting_post_reversal` takes shared advisory locks
 * on each line's account (`0046:565-570`); a set of mirrors posted in a
 * repository-dependent order is a lock order chosen by a query plan, and a lock
 * order nobody chose is the lock-ORDER defect a deadlock reports
 * (`[[daftar-lock-order-not-retry]]`, P4-AL-41).
 *
 * Nothing is deduplicated silently: a repeated `originalEntryId` is a defect in
 * the caller's set, because `accounting_reversals.id = original_entry_id`
 * (P4-AL-47) already allows exactly ONE whole-entry reversal per entry for
 * ever, so a repeat would be refused by the database and must be refused here
 * with a name.
 */
export function exactInverseSteps(steps: readonly ExactInverseStep[], domain: 'payment_reversal' | 'allocation_reversal'): readonly ExactInverseStep[] {
  const seen = new Set<string>();
  for (const s of steps) {
    if (seen.has(s.originalEntryId)) {
      refuse(`${domain}.already_reversed`, `journal entry ${s.originalEntryId} appears twice in one reversal, and one entry is reversed at most once`);
    }
    seen.add(s.originalEntryId);
  }
  return Object.freeze([...steps].sort((a, b) => (a.originalEntryId < b.originalEntryId ? -1 : a.originalEntryId > b.originalEntryId ? 1 : 0)));
}

// ──────────────────────────────────────────────────────────────────────────
// 4. The allocation reversal — one reducer, one or two chains.
// ──────────────────────────────────────────────────────────────────────────

/** What the planner is given for a single reducer's reversal. */
export interface AllocationReversalInput {
  /** The reversal document's own client-chosen id — its idempotency key and its accounting source id. */
  readonly reversalId: string;
  /** The reducer being reversed. */
  readonly reducerId: string;
  readonly kind: ActiveReducer['kind'];
  /** The reducer's own journal entry. */
  readonly originalEntryId: string;
  /** Its source type, for the audit row. */
  readonly sourceType: ExactInverseStep['sourceType'];
  /**
   * EVERY chain this reducer affects. A `payment_allocation` affects exactly
   * one (its invoice); a `credit_application` affects exactly TWO (its invoice
   * and its credit), and both are required — the two-chain law.
   */
  readonly chains: readonly SettlementChain[];
  /** The reversal's civil date, stated by the caller and never derived. */
  readonly reversalDate: string;
  /** The original reducer's own date, for the not-before check. */
  readonly originalDate: string;
  readonly reason: string;
}

/** The plan a lawful allocation reversal produces. */
export interface AllocationReversalPlan {
  readonly reversalId: string;
  readonly reducerId: string;
  readonly kind: ActiveReducer['kind'];
  /** The chains this reversal frees, in chain-id order, each with the level it frees. */
  readonly freedLevels: readonly { readonly chainId: string; readonly chainKind: ChainKind; readonly freedLevel: bigint; readonly amount: bigint }[];
  readonly inverse: readonly ExactInverseStep[];
  readonly reversalDate: string;
  readonly reason: string;
}

/**
 * The expected chain arity per reducer kind. A `credit_application` with one
 * chain is not a reversal of a credit application at all — it is a reversal
 * that forgot one of the two chains it affects, which is the whole of the
 * two-chain law, so it is refused by ARITY and not by a later check that might
 * not run.
 */
const REQUIRED_CHAINS: Readonly<Record<ActiveReducer['kind'], readonly ChainKind[]>> = Object.freeze({
  payment_allocation: Object.freeze(['invoice_ar'] as const),
  credit_application: Object.freeze(['invoice_ar', 'customer_credit'] as const),
});

/**
 * Plan the reversal of ONE reducer.
 *
 * Every chain is checked, and the FIRST failure refuses the whole command.
 * There is no partial result and no "reversible on one chain" verdict: a
 * customer-credit application that is the tail on its invoice but not on its
 * credit is NOT reversible, and the reverse is equally true.
 */
export function planAllocationReversal(input: AllocationReversalInput): AllocationReversalPlan {
  if (input.reason.trim().length === 0) {
    refuse('allocation_reversal.reason_required', 'a reversal states a reason');
  }
  assertCanonicalDate(input.reversalDate, 'the reversal date', 'allocation_reversal.date_invalid');
  assertCanonicalDate(input.originalDate, "the original reducer's date", 'allocation_reversal.date_invalid');
  if (input.reversalDate < input.originalDate) {
    refuse('allocation_reversal.date_before_original', 'a reversal may not precede the reducer it reverses');
  }

  const required = REQUIRED_CHAINS[input.kind];
  const seenKinds = input.chains.map((c) => c.kind);
  for (const want of required) {
    if (!seenKinds.includes(want)) {
      refuse(
        'allocation_reversal.chain_inconsistent',
        `a ${input.kind} reversal must be presented with its ${want} chain, and every chain it affects must be checked in one transaction`,
      );
    }
  }
  if (input.chains.length !== required.length) {
    refuse('allocation_reversal.chain_inconsistent', `a ${input.kind} affects exactly ${required.length} chain(s); ${input.chains.length} were presented`);
  }

  const freed: { chainId: string; chainKind: ChainKind; freedLevel: bigint; amount: bigint }[] = [];
  for (const chain of [...input.chains].sort((a, b) => (a.chainId < b.chainId ? -1 : a.chainId > b.chainId ? 1 : 0))) {
    // ALREADY REVERSED, ANSWERED FIRST, and this is a CHALLENGE FINDING fixed
    // rather than argued with. `already_reversed` was unreachable here for the
    // condition it names: an exact replay presents a reducer that is no longer
    // in the active set, the tail check therefore failed, and the answer was
    // `not_last_reducer` — with advice (`reverseInThisOrder`) whose only
    // "later" reducer was the one already reversed, so a client following it
    // went in a circle. The payment command already answered `already_reversed`
    // for the same state (`planPaymentReversal`), so the two commands disagreed
    // about one state; a closed code set that answers one state two ways is not
    // a closed code set. The membership test is the SAME anti-join the chain is
    // built from, so no new fact is needed to make it.
    if (!chain.active.some((r) => r.reducerId === input.reducerId)) {
      refuse(
        'allocation_reversal.already_reversed',
        `reducer ${input.reducerId} is not among the active reducers of chain ${chain.chainId}, so it was already reversed`,
      );
    }
    const tail = tailOf(chain, 'allocation_reversal');
    if (tail === null) {
      refuse('allocation_reversal.not_found', `chain ${chain.chainId} carries no active reducer, so it has nothing to reverse`);
    }
    if (tail.reducerId !== input.reducerId) {
      refuse(
        'allocation_reversal.not_last_reducer',
        `reducer ${input.reducerId} is not the last active settlement reducer of chain ${chain.chainId}; reverse the later one first`,
      );
    }
    freed.push({ chainId: chain.chainId, chainKind: chain.kind, freedLevel: tail.level, amount: tail.amount });
  }

  return Object.freeze({
    reversalId: input.reversalId,
    reducerId: input.reducerId,
    kind: input.kind,
    freedLevels: Object.freeze(freed.map((f) => Object.freeze(f))),
    inverse: exactInverseSteps([{ originalEntryId: input.originalEntryId, sourceType: input.sourceType, sourceId: input.reducerId }], 'allocation_reversal'),
    reversalDate: input.reversalDate,
    reason: input.reason.trim(),
  });
}

// ──────────────────────────────────────────────────────────────────────────
// 5. The payment reversal — the whole-payment law.
// ──────────────────────────────────────────────────────────────────────────

/** The surplus credit a payment created, if it created one (R-93, `0081:371`). */
export interface PaymentSurplusCredit {
  readonly creditId: string;
  readonly originalEntryId: string;
  /** The credit's own original amount. */
  readonly originalAmountMinor: bigint;
  /**
   * The credit's remaining amount NOW. Reversing the payment that created a
   * credit undoes the creation of that credit, so the credit must still be
   * whole: `remaining === original`. A partly consumed credit has downstream
   * reducers on other invoices' chains, and under the LIFO law those are
   * reversed FIRST — one at a time, each as its own tail — before the payment
   * that created the credit can go.
   */
  readonly remainingAmountMinor: bigint;
}

export interface PaymentReversalInput {
  readonly reversalId: string;
  readonly paymentId: string;
  /** The payment's own journal-bearing children: one entry per active allocation. */
  readonly allocations: readonly {
    readonly reducerId: string;
    readonly originalEntryId: string;
    /** The invoice chain this allocation sits on, with its ACTIVE reducers. */
    readonly chain: SettlementChain;
  }[];
  readonly surplusCredit: PaymentSurplusCredit | null;
  readonly reversalDate: string;
  readonly originalDate: string;
  readonly reason: string;
}

export interface PaymentReversalPlan {
  readonly reversalId: string;
  readonly paymentId: string;
  /** One nested allocation-reversal plan per included allocation, in reducer-id order. */
  readonly allocationReversals: readonly AllocationReversalPlan[];
  readonly surplusCreditId: string | null;
  readonly inverse: readonly ExactInverseStep[];
  readonly reversalDate: string;
  readonly reason: string;
}

/**
 * Plan the reversal of a WHOLE payment.
 *
 * The included set is EVERY active allocation handed in. There is no
 * `allocationIds` parameter, no subset and no "reverse what you can": if any
 * included allocation is not a valid tail on its chain, the whole command is
 * refused, which is the whole-payment law. A payment with zero active
 * allocations is in scope — R-87 admits a payment with no allocation at all
 * (`0081:243-262`) — and such a reversal mirrors only its surplus credit's
 * entry.
 *
 * A payment allocates at most once per invoice
 * (`payment_allocations_invoice_uq`, `0081:333`), so the chains of one
 * payment's allocations are DISTINCT invoices. The planner asserts that rather
 * than assuming it: two allocations of one payment presented on one chain would
 * make each one's tail check depend on whether the other was counted active,
 * and the question would have two answers.
 */
export function planPaymentReversal(input: PaymentReversalInput): PaymentReversalPlan {
  if (input.reason.trim().length === 0) {
    refuse('payment_reversal.reason_required', 'a reversal states a reason');
  }
  assertCanonicalDate(input.reversalDate, 'the reversal date', 'payment_reversal.date_invalid');
  assertCanonicalDate(input.originalDate, "the original payment's date", 'payment_reversal.date_invalid');
  if (input.reversalDate < input.originalDate) {
    refuse('payment_reversal.date_before_original', 'a reversal may not precede the payment it reverses');
  }

  const chainIds = new Set<string>();
  const reducerIds = new Set<string>();
  for (const a of input.allocations) {
    if (chainIds.has(a.chain.chainId)) {
      refuse('payment_reversal.chain_inconsistent', `two allocations of payment ${input.paymentId} were presented on one invoice chain`);
    }
    chainIds.add(a.chain.chainId);
    if (reducerIds.has(a.reducerId)) {
      refuse('payment_reversal.chain_inconsistent', `allocation ${a.reducerId} was presented twice in one payment reversal`);
    }
    reducerIds.add(a.reducerId);
    if (a.chain.kind !== 'invoice_ar') {
      refuse('payment_reversal.chain_inconsistent', `a payment allocation sits on an invoice AR chain, not a ${a.chain.kind} chain`);
    }
  }

  // THE TAIL CHECK, over every included allocation. All of them, or none.
  const nested: AllocationReversalPlan[] = [];
  for (const a of [...input.allocations].sort((x, y) => (x.reducerId < y.reducerId ? -1 : x.reducerId > y.reducerId ? 1 : 0))) {
    if (!a.chain.active.some((r) => r.reducerId === a.reducerId)) {
      refuse(
        'payment_reversal.already_reversed',
        `allocation ${a.reducerId} is not among the active reducers of chain ${a.chain.chainId}, so it was already reversed`,
      );
    }
    const tail = tailOf(a.chain, 'payment_reversal');
    if (tail === null || tail.reducerId !== a.reducerId) {
      refuse(
        'payment_reversal.not_last_reducer',
        `allocation ${a.reducerId} is not the last active settlement reducer of invoice ${a.chain.chainId}; the whole payment reversal is refused`,
      );
    }
    nested.push(
      Object.freeze({
        reversalId: input.reversalId,
        reducerId: a.reducerId,
        kind: 'payment_allocation' as const,
        freedLevels: Object.freeze([Object.freeze({ chainId: a.chain.chainId, chainKind: a.chain.kind, freedLevel: tail.level, amount: tail.amount })]),
        inverse: Object.freeze([
          Object.freeze({ originalEntryId: a.originalEntryId, sourceType: 'customer_payment_allocation' as const, sourceId: a.reducerId }),
        ]),
        reversalDate: input.reversalDate,
        reason: input.reason.trim(),
      }),
    );
  }

  // The surplus credit must still be WHOLE.
  const steps: ExactInverseStep[] = nested.flatMap((n) => [...n.inverse]);
  if (input.surplusCredit !== null) {
    const c = input.surplusCredit;
    assertMinor(c.originalAmountMinor, 'the surplus credit original amount', 1n);
    assertMinor(c.remainingAmountMinor, 'the surplus credit remaining amount', 0n);
    if (c.remainingAmountMinor !== c.originalAmountMinor) {
      refuse(
        'payment_reversal.credit_consumed',
        `the surplus credit ${c.creditId} this payment created has been applied; reverse those applications first, each as the last active reducer of its own chains`,
      );
    }
    steps.push({ originalEntryId: c.originalEntryId, sourceType: 'customer_credit', sourceId: c.creditId });
  }

  return Object.freeze({
    reversalId: input.reversalId,
    paymentId: input.paymentId,
    allocationReversals: Object.freeze(nested),
    surplusCreditId: input.surplusCredit === null ? null : input.surplusCredit.creditId,
    inverse: exactInverseSteps(steps, 'payment_reversal'),
    reversalDate: input.reversalDate,
    reason: input.reason.trim(),
  });
}

// ──────────────────────────────────────────────────────────────────────────
// 6. The void surface, and the refusal of the direct path.
// ──────────────────────────────────────────────────────────────────────────

/**
 * `invoices.status` is LIFECYCLE ONLY (P4-AL-24): `draft`, `open`, `void`, and
 * never a settlement state. A direct `UPDATE invoices SET status = 'void'` is
 * refused by a trigger, and the void is a COMPOUND COMMAND.
 *
 * This constant is the refusal's own statement of what it refuses, so a reader
 * of the TypeScript side learns the law without reading the DDL. The trigger is
 * specified in `docs/PHASE_4_S6_DDL_SPECIFICATION.md`; no code here can enforce
 * it, and this module does not pretend to.
 */
export const DIRECT_VOID_IS_REFUSED = Object.freeze({
  refusal: 'invoice_void.direct_update_refused' as const,
  what: "a direct UPDATE of invoices.status to 'void'",
  why: 'voiding a settled invoice reverses the revenue entry once, reverses the inventory entry, returns the stock and issues the refund from the credit-note source only; a status write does none of those and leaves AR standing',
  where: 'P4-AL-24, docs/PHASE_4_ARCHITECTURE_LOCK.md:545-556',
});

export interface InvoiceVoidInput {
  readonly invoiceId: string;
  /** The invoice's lifecycle status NOW. */
  readonly status: 'draft' | 'open' | 'void';
  /** The invoice's AR chain, with its ACTIVE reducers. */
  readonly chain: SettlementChain;
}

/**
 * The precondition of a void, and ONLY the precondition.
 *
 * `STATE_MACHINES.md` §2 permits `open → voided` "with no active payments" and
 * then defines a `void_invoice` command for exactly the case it forbade
 * (P4-AL-24). Under the LIFO law the two are reconciled without widening
 * either: an invoice is voidable once its AR chain has NO ACTIVE REDUCER, and
 * the way to get there is to reverse them, each as the tail of its own chain,
 * which is this slice's other two commands. So the void does not acquire a
 * power to unwind a chain out of order; it acquires a precondition.
 *
 * This function returns the ordered list of reducers that must be reversed
 * first — newest-first, which is the only order the LIFO law admits — so a
 * refusal can tell the merchant WHICH reversal to make next instead of only
 * that the invoice is not voidable.
 */
export function voidPrecondition(
  input: InvoiceVoidInput,
): { readonly voidable: true } | { readonly voidable: false; readonly reverseInThisOrder: readonly string[] } {
  if (input.status !== 'open') {
    refuse('invoice_void.state_invalid', `only an open invoice is voided; this one is ${input.status}`);
  }
  if (input.chain.kind !== 'invoice_ar') {
    refuse('invoice_void.state_invalid', 'an invoice is voided against its own AR chain');
  }
  const broken = chainBreak(input.chain);
  if (broken !== null) refuse('invoice_void.state_invalid', broken);
  const ordered = orderedActive(input.chain);
  if (ordered.length === 0) return Object.freeze({ voidable: true as const });
  return Object.freeze({
    voidable: false as const,
    reverseInThisOrder: Object.freeze([...ordered].reverse().map((r) => r.reducerId)),
  });
}

// ──────────────────────────────────────────────────────────────────────────
// 7. The repository ports (level B).
// ──────────────────────────────────────────────────────────────────────────

/**
 * What a reversal command needs from the database, stated as the narrowest
 * interface that can serve it — and NOT as a relation.
 *
 * `readActiveChain` is the one seam that carries the whole of "active": its
 * implementation anti-joins the reversal relations against the reducer
 * relations, and nothing above it has a reversal-aware query of its own. One
 * body of that definition, so a reader of the chain and a writer of a reversal
 * cannot disagree about which rows are active — the `invoice_outstanding`
 * reader-of-record argument (P4-AL-06, seam S-P4-03) applied to activeness.
 *
 * Every method takes the chain's canonical lock before it reads, in the order
 * `docs/PHASE_4_S6_CONTRACT_PACK.md` §"lock order" declares. The port says so
 * in its contract because a port that reads without the lock returns a figure
 * that was true once, and a tail check over such a figure is the stale-head
 * defect.
 */
export interface ReversalChainPort {
  /**
   * The chain of `chainId`, with its ACTIVE reducers, read UNDER the chain's
   * own canonical lock (`invoices` or `customer_credits` FOR UPDATE).
   * `null` when the chain does not exist in this business.
   */
  readActiveChain(scope: ReversalScope, chainId: string, kind: ChainKind): Promise<SettlementChain | null>;
}

export interface ReversalDocumentPort {
  /** The payment, its active allocations and its surplus credit, read under the locks. */
  readPaymentForReversal(scope: ReversalScope, paymentId: string): Promise<PaymentReversalInput | null>;
  /** One reducer and EVERY chain it affects, read under the locks. */
  readReducerForReversal(scope: ReversalScope, reducerId: string): Promise<AllocationReversalInput | null>;
}

/**
 * The append-only writer. It takes a PLAN and nothing else, so a caller cannot
 * write a reversal the planner did not authorize, and it has no `update` and no
 * `delete` method — the LIFO law's immutability expressed as an interface with
 * no door in it.
 */
export interface ReversalWriterPort {
  appendPaymentReversal(scope: ReversalScope, plan: PaymentReversalPlan, intentSha256: string): Promise<{ readonly replayed: boolean }>;
  appendAllocationReversal(scope: ReversalScope, plan: AllocationReversalPlan, intentSha256: string): Promise<{ readonly replayed: boolean }>;
}

export interface ReversalScope {
  readonly tenantId: string;
  readonly businessId: string;
}

/**
 * EVERYTHING S6 NEEDS THAT IS OUTSIDE THIS SLICE'S OWNERSHIP, with the patch
 * request that asks for it. The `P4_S4_REQUIRED_WIRING` device
 * (`apps/api/src/modules/receivables/receivables.module.ts:63`), used for the
 * same reason: stated here rather than made, because none of these files is
 * this slice's to write while S4 and S5 are in acceptance.
 *
 * Every row is OPEN. None of them has landed, and `READY_TO_PROMOTE = NO` in
 * `docs/PHASE_4_S6_CONTRACT_PACK.md` is the same fact counted once.
 */
export const P4_S6_REQUIRED_WIRING: readonly { readonly patchRequest: string; readonly file: string; readonly edit: string }[] = Object.freeze([
  Object.freeze({
    patchRequest: 'PATCH-REQ-S6-001',
    file: 'packages/inventory/src/payload.ts',
    edit: 'register the three S6 operation codes and one INVENTORY_PAYLOAD_SCHEMAS entry per code',
  }),
  Object.freeze({
    patchRequest: 'PATCH-REQ-S6-002',
    file: 'packages/inventory/src/errors.ts',
    edit: 'widen InventoryErrorCode with every member of REVERSAL_CODES (a count is not written here: the array is the subject, and a number in a comment drifts)',
  }),
  Object.freeze({
    patchRequest: 'PATCH-REQ-S6-003',
    file: 'packages/accounting/src/post.ts',
    edit: "add the three customer source types to DOMAIN_REVERSIBLE_SOURCE_TYPES, which today is ['purchase'] alone",
  }),
  Object.freeze({
    patchRequest: 'PATCH-REQ-S6-004',
    file: 'the S6 migration (number unknown until the predecessors seal)',
    edit: 'create the three WIDER (level, generation) unique keys FIRST, then replace the three narrow customer level UNIQUE constraints per docs/PHASE_4_S6_LEVEL_UNIQUENESS.md, and widen the verifiers and invoice_outstanding(uuid, uuid[]) to the ACTIVE subset',
  }),
  Object.freeze({
    patchRequest: 'PATCH-REQ-S6-005',
    file: 'the S6 migration (number unknown until the predecessors seal)',
    edit: "re-record purchase_settlement_verify's digest FORWARD in supplier_settlement_guard_gaps() in the same migration that widens it: the consumer suite computes both sides from live pg_proc and hard-codes no digest, so this is a task and not a ruling",
  }),
  Object.freeze({
    patchRequest: 'PATCH-REQ-S6-006',
    file: 'apps/api/src/modules/inventory/inventory-authorization.ts',
    edit: 'add three OPERATION_AUTHORITY rows, per REVERSAL_OPERATION_AUTHORITY above',
  }),
  // The four rows below were MISSING, and the test beside this array could not
  // have noticed: it walked these rows and checked their shape, so it held the
  // array to itself. A registry that lists six of ten obligations is a registry
  // that reads as complete. The test now checks BOTH directions — every patch
  // request under docs/patch-requests/ appears here, and every row here names a
  // real one — which is `[[daftar-registry-before-state]]` applied to the
  // registry rather than to the state.
  Object.freeze({
    patchRequest: 'PATCH-REQ-S6-007',
    file: 'docs/PHASE_4_ARCHITECTURE_LOCK.md',
    edit: "update P4-AL-22's accepted level-constraint enumeration IN THE 0081 SEAL COMMIT, which is the moment the accepted set changes, and not before",
  }),
  Object.freeze({
    patchRequest: 'PATCH-REQ-S6-008',
    file: 'docs/PHASE_4_ARCHITECTURE_LOCK.md',
    edit: "correct P4-AL-20's source-type enumeration: the live registry holds no allocation_reversal row and S6 must not register one",
  }),
  Object.freeze({
    patchRequest: 'PATCH-REQ-S6-009',
    file: 'apps/api/src/modules/receivables + the three locale catalogues',
    edit: 'a RECEIVABLES_STATUS-style classification for every REVERSAL_CODES member, and one error.* entry per code per locale',
  }),
  Object.freeze({
    patchRequest: 'PATCH-REQ-S6-011',
    file: 'the S6 migration, against the S4-owned payment_allocations and customer_credit_applications',
    edit: 'three chain_generation columns and three WIDER (level, generation) unique keys, created BEFORE the narrow ones are dropped, with the backfill stated as an EXPRESSION over the reversal rows and never as the DEFAULT 0 that both upgrade paths cannot distinguish from it',
  }),
  Object.freeze({
    patchRequest: 'PATCH-REQ-S6-012',
    file: 'docs/PHASE_4_ARCHITECTURE_LOCK.md + the static acquisition-order check',
    edit: 'P4-AL-41 ranks NO advisory document key although S4 already takes two; S6 takes three in one transaction, so the advisory keys need a ranked block at the head and the checker needs to read advisory acquisitions at all',
  }),
  Object.freeze({
    patchRequest: 'PATCH-REQ-S6-010',
    file: 'the existing S4 suites under tests/ that S6 may not edit',
    edit: 'three test hooks, named in the contract pack §13.3, each inside a suite S4 owns',
  }),
  // `[[daftar-a-refusal-is-a-validators-act-not-a-types-silence]]`, a law this
  // request's reasoning was adopted as. OD-03 is CLOSED: tax is a structural
  // zero and a non-zero tax must REFUSE. This slice's shapes carry no tax
  // field, which settles the COMPILE-time question and settles NOTHING at
  // runtime — a JSON body carrying one meets a non-strict validator and is
  // silently stripped, which is the accept-then-ignore the closure forbids,
  // reached THROUGH the absence rather than through any line of code.
  //
  // RULED PROSPECTIVE, NOT A LIVE DEFECT: there is no customer-reversal route,
  // no `returns` module, and no non-strict request schema in the live tree, so
  // there is no reachable path today and none of this counts against the
  // candidate. The row is owed by the slice that first ships the route, and the
  // law is stated over the LIVE SET rather than per route.
  Object.freeze({
    patchRequest: 'PATCH-REQ-S6-013',
    file: 'the slice that first ships a customer-reversal / credit-note route, in the request schema layer under apps/api/src',
    edit: 'state over the LIVE SET that every Phase 4 request body schema refuses unknown keys, derived from the tree and not from a hand-kept list, with the red proof that removing the refusal from ANY ONE member reddens — plus a NAMED domain refusal for the tax case, which is the message rather than the floor, proved REACHABLE from a request and not merely declared',
  }),
]);
