#!/usr/bin/env tsx
/**
 * PHASE 4 — P4-S8 FRAMEWORK — THE DEADLOCK MATRIX, IN BOTH DIRECTIONS
 *
 * DEADLOCK LAW (`P4-AL-41`, `P4-AL-42`): every relevant lock pair is run in
 * BOTH directions, N times, expecting ZERO deadlocks and ZERO stale-head
 * commits, with DETERMINISTIC BARRIERS and NO PROBABILISTIC SLEEPS.
 *
 * `[[daftar-a-test-whose-verdict-is-the-machines-speed]]`: FI-11 passed on a
 * slow host and failed on a fast one and proved nothing either way. A pair run
 * by starting two transactions and hoping they interleave measures the host.
 * So the interleaving is FORCED: one transaction is PARKED after its first
 * acquisition and the park is DETECTED through `pg_stat_activity` — the
 * `tests/security/stock-ledger-concurrency.test.ts:6-12` idiom — before the
 * second transaction is allowed to start. `barrierProblems` refuses a plan
 * that contains a sleep.
 *
 * TWO EXPECTATIONS, NOT ONE. Zero deadlocks is the obvious one. ZERO
 * STALE-HEAD COMMITS is the one that is easy to lose: a pair can avoid
 * deadlock and still have the second transaction commit against the state it
 * read BEFORE the first one committed, which is a lost update wearing a green
 * tick. Each pair therefore declares the HEAD it must re-read, and the harness
 * asserts the committed value is the one derived from the post-first-commit
 * head.
 *
 * WHAT THIS MODULE IS: the plan, the barrier contract, and the laws over the
 * plan. It does not execute. Execution needs the six Phase 4 lock-taking
 * commands, four of which do not exist, so `index.ts` reports
 * `WAITING_FOR_INTEGRATED_SURFACE` for the execution check and this module's
 * own laws — which are about the PLAN — run today.
 */
import { LOCK_RANK } from './lock-order';

/** A Phase 4 command that takes domain locks. */
export interface LockTakingCommand {
  readonly id: string;
  /** The database routine, when there is one. */
  readonly routine: string;
  /** The relations it locks, in the order it locks them. */
  readonly acquires: readonly string[];
  /** The slice that ships it. */
  readonly owedBy: string;
  /**
   * The relation whose row is the command's HEAD — the row whose value a
   * second transaction must have re-read before it commits. `null` for a
   * command with no single head.
   */
  readonly head: string | null;
}

/**
 * The six lock-taking Phase 4 commands of `P4-AL-77`'s harness table.
 *
 * `routine` is the live name where the slice has shipped, and the name the
 * slice will ship where it has not. A command whose routine is absent makes
 * every pair containing it WAITING — which is the correct answer and is why
 * the table names the routine rather than describing it.
 */
export const LOCK_TAKING_COMMANDS: readonly LockTakingCommand[] = [
  {
    id: 'sale.commit',
    routine: 'sale_commit',
    acquires: ['businesses', 'customers', 'stock_levels', 'invoice_sequences', 'invoices'],
    owedBy: 'P4-S2',
    head: 'invoice_sequences',
  },
  {
    id: 'customer.collect_payment',
    routine: 'customer_collect_payment',
    acquires: ['businesses', 'invoices', 'customers', 'payments'],
    owedBy: 'P4-S4',
    head: 'invoices',
  },
  {
    id: 'customer.apply_credit',
    routine: 'customer_apply_credit',
    acquires: ['businesses', 'invoices', 'customers', 'customer_credits'],
    owedBy: 'P4-S4',
    head: 'customer_credits',
  },
  {
    id: 'sales.return',
    routine: 'customer_issue_credit_note',
    acquires: ['businesses', 'customers', 'invoices', 'credit_notes', 'stock_levels'],
    owedBy: 'P4-S5',
    head: 'credit_notes',
  },
  {
    id: 'refunds.approve',
    routine: 'customer_refund',
    acquires: ['businesses', 'customers', 'credit_notes', 'refunds'],
    owedBy: 'P4-S5',
    head: 'refunds',
  },
  {
    id: 'payments.reverse',
    routine: 'customer_reverse_payment',
    acquires: ['businesses', 'customers', 'invoices', 'payments'],
    owedBy: 'P4-S6',
    head: 'payments',
  },
  {
    id: 'installments.manage',
    routine: 'customer_create_installment_plan',
    acquires: ['businesses', 'customers', 'invoices', 'installment_plans'],
    owedBy: 'P4-S7',
    head: 'installment_plans',
  },
];

/** How a pair's interleaving is forced. There is no third option, and no sleep. */
export type Barrier =
  /**
   * Transaction A performs its first acquisition and then BLOCKS on an
   * advisory lock the test holds. The test detects the park by polling
   * `pg_stat_activity` for `wait_event_type = 'Lock'` on A's pid, then starts
   * B. Deterministic: B does not start until A is observably parked.
   */
  | 'advisory-park'
  /**
   * Transaction A takes its first row lock; the test observes A's lock in
   * `pg_locks` and only then starts B, which must block on that same row. The
   * verdict is read from whether B blocks and on what, not from timing.
   */
  | 'pg-locks-observed';

export interface DeadlockPair {
  readonly id: string;
  readonly first: string;
  readonly second: string;
  /** `forward` runs first→second; `reverse` runs second→first. Both are required. */
  readonly direction: 'forward' | 'reverse';
  /** The relations the two commands contend on. A pair with none is not a pair. */
  readonly contendedRelations: readonly string[];
  readonly barrier: Barrier;
  /** The head whose re-read is asserted after the first transaction commits. */
  readonly staleHeadRelation: string | null;
  /** The slice that makes BOTH commands real. */
  readonly owedBy: string;
}

/** Iterations per pair per direction. A single run is an anecdote. */
export const ITERATIONS_PER_DIRECTION = 20;

/**
 * THE MATRIX: every ordered pair of distinct commands that contend on at least
 * one relation, in BOTH directions.
 *
 * Generated, not listed. A new command added to `LOCK_TAKING_COMMANDS` enters
 * the matrix without anybody remembering to add its pairs — which is the
 * failure mode a hand-written pair list has, and the one that matters most
 * here because the pair nobody wrote is the pair that deadlocks.
 */
export function buildMatrix(commands: readonly LockTakingCommand[] = LOCK_TAKING_COMMANDS): DeadlockPair[] {
  const pairs: DeadlockPair[] = [];
  for (const a of commands)
    for (const b of commands) {
      if (a.id === b.id) continue;
      const contended = a.acquires.filter((r) => b.acquires.includes(r));
      // `businesses` alone is the shared scope row every command takes; two
      // commands that contend ONLY there cannot deadlock on it, because
      // neither takes anything before it. Requiring a second contended
      // relation keeps the matrix about real pairs rather than inflating the
      // count — and the exclusion is stated, so a reader can refute it.
      const beyondScope = contended.filter((r) => r !== 'businesses');
      if (beyondScope.length === 0) continue;
      const direction: 'forward' | 'reverse' = a.id < b.id ? 'forward' : 'reverse';
      pairs.push({
        id: `${a.id}::${b.id}`,
        first: a.id,
        second: b.id,
        direction,
        contendedRelations: contended,
        barrier: beyondScope.includes('stock_levels') ? 'pg-locks-observed' : 'advisory-park',
        staleHeadRelation: a.head,
        owedBy: rankSlice(a.owedBy, b.owedBy),
      });
    }
  return pairs;
}

function rankSlice(a: string, b: string): string {
  return a > b ? a : b;
}

/**
 * THE PLAN'S OWN LAWS. These run today, with no database and no product.
 *
 * `[[daftar-an-empty-collection-is-never-a-refusal]]`: an empty matrix is a
 * FAIL of this module, not a clean bill of health for the product.
 */
export function matrixProblems(pairs: readonly DeadlockPair[]): string[] {
  const problems: string[] = [];
  if (pairs.length === 0) problems.push('the deadlock matrix is EMPTY — zero pairs run in zero directions is not zero deadlocks');
  const seen = new Map<string, Set<'forward' | 'reverse'>>();
  for (const pair of pairs) {
    const key = [pair.first, pair.second].sort().join('|');
    const directions = seen.get(key) ?? new Set<'forward' | 'reverse'>();
    directions.add(pair.direction);
    seen.set(key, directions);
    if (pair.contendedRelations.length === 0) problems.push(`${pair.id}: the two commands contend on nothing, so it is not a lock pair`);
    for (const relation of pair.contendedRelations)
      if (!LOCK_RANK.has(relation)) problems.push(`${pair.id}: contends on ${relation}, which has no rank in P4-AL-41 — an unranked lock cannot be ordered`);
  }
  // BOTH DIRECTIONS. A pair run one way proves the order is consistent with
  // itself and nothing more.
  for (const [key, directions] of seen)
    if (directions.size < 2)
      problems.push(
        `pair ${key} is run in only ${[...directions].join('/')} — the deadlock law requires BOTH directions, because one direction cannot deadlock alone`,
      );
  if (ITERATIONS_PER_DIRECTION < 2)
    problems.push(`ITERATIONS_PER_DIRECTION is ${ITERATIONS_PER_DIRECTION.toString()} — a single run per direction is an anecdote`);
  return problems;
}

/** Every pair must declare the head whose re-read proves no stale-head commit. */
export function staleHeadProblems(pairs: readonly DeadlockPair[]): string[] {
  const problems: string[] = [];
  for (const pair of pairs)
    if (pair.staleHeadRelation === null)
      problems.push(
        `${pair.id}: declares no stale-head relation, so the pair could pass with the second transaction committing against the pre-commit head — a lost update wearing a green tick`,
      );
  return problems;
}

/**
 * `[[daftar-a-test-whose-verdict-is-the-machines-speed]]`, as a check on the
 * harness text.
 *
 * Any sleep, timer or arbitrary wait in a Phase 4 concurrency suite is
 * refused. `setTimeout` is named explicitly because it is the shape a sleep
 * takes in this codebase, and `pg_sleep` because it is the shape it takes in
 * SQL.
 */
export function barrierProblems(where: string, text: string): string[] {
  const problems: string[] = [];
  if (/\bpg_sleep\s*\(/i.test(text))
    problems.push(`${where}: calls pg_sleep — an interleaving produced by waiting is a measurement of the host, not of the lock order`);
  if (/\bsetTimeout\s*\(/.test(text) && !/clearTimeout/.test(text))
    problems.push(`${where}: waits on setTimeout — the interleaving must be forced by a detected park (pg_stat_activity / pg_locks), never by a delay`);
  if (/\bawait\s+delay\s*\(|\bawait\s+sleep\s*\(/.test(text)) problems.push(`${where}: awaits a sleep helper — a probabilistic barrier is not a barrier`);
  if (!/pg_stat_activity|pg_locks/.test(text))
    problems.push(`${where}: never consults pg_stat_activity or pg_locks, so it has no way to KNOW the first transaction parked — the barrier is hope`);
  return problems;
}
