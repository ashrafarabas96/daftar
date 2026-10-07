/**
 * P4-S6 — THE DETERMINISTIC CONCURRENCY MODELS. Level C.
 *
 * ## Why a model, and what it is a model OF
 *
 * Level F — real DB binding — is not S6's yet: the reversal relations do not
 * exist, so a suite that drove them would create its own subject and prove the
 * fixture. What CAN be settled now is the question these races actually turn
 * on: **the lock order, and what each party sees after it takes its lock.**
 * That is a property of the declared protocol, not of PostgreSQL, so it is
 * modelled here over a scheduler that reproduces the three mechanisms the
 * protocol relies on and nothing else:
 *
 * - **row locks.** `FOR UPDATE` is exclusive and `FOR SHARE` is shared, both
 *   held to the end of the transaction, and a waiter QUEUES rather than failing;
 * - **advisory transaction locks.** `pg_advisory_xact_lock(class, key)`, the
 *   document key `customer_collect_payment` takes at `0081:1893`;
 * - **READ COMMITTED visibility.** A read sees only COMMITTED state. So a
 *   figure read before a lock can be stale by the time the lock is held, which
 *   is the stale-head case, and a figure read after the lock cannot be.
 *
 * ## Nothing here sleeps, and nothing here retries
 *
 * `[[daftar-a-test-whose-verdict-is-the-machines-speed]]`. Every interleaving
 * is WRITTEN DOWN as a list of which transaction takes its next step, and the
 * scheduler refuses to advance a blocked transaction — so the service order is
 * chosen by this file. A transaction that never queued did not contend, and
 * `expectQueued` makes that a FAILURE and never a pass: two connections used in
 * sequence are not contention.
 *
 * A deadlock is a LOCK-ORDER DEFECT and never a business outcome
 * (`[[daftar-lock-order-not-retry]]`, P4-AL-41). The scheduler detects it as a
 * cycle in the wait-for graph and reports it as its own outcome kind; no case
 * below retries, and the deadlock-ordering case requires ZERO of them.
 *
 * ## The declared lock order this file holds the protocol to
 *
 * Extending P4-S4's (`0081:1755-1765`), never reordering it:
 *
 *   1.  advisory `daftar.payment_provider_reference` (payment reversal carrying a
 *       webhook identity). A CHALLENGE FINDING (F-C7) corrected the reason this is
 *       ranked here. The earlier reason — "two deliveries of one webhook carry
 *       DIFFERENT client ids and nothing below serialises them" — is REFUTED by step
 *       1b in this same list: two deliveries of one webhook are two reversals of one
 *       PAYMENT, so `daftar.payment_id` serialises them, the second waits, finds the
 *       committed row by the payment lookup and replays. What this key genuinely buys
 *       is the OTHER case: one provider reference presented against two DIFFERENT
 *       payments, where the payment keys differ, neither party waits, and without it
 *       the partial unique index answers a raw `23505` where law 7 wants a domain
 *       refusal decided before any state is read. It is first because it is the
 *       outermost identity and because the replay lookup consults it first; any TOTAL
 *       order would be deadlock-free, and a total order is the requirement.
 *   1a. advisory `daftar.payment_reversal_id` / `daftar.allocation_reversal_id`
 *   1b. advisory `daftar.payment_id` of the original payment (payment reversal)
 *       (the `payments` FOR UPDATE this file's earlier revision listed here is GONE: it
 *       serialised nothing that step 1b and `payment_reversals_payment_uq` do not already,
 *       and it bought that nothing with a grant on an S4-owned table)
 *   3.  every affected `invoices` FOR UPDATE, IN ID ORDER   ← THE CHAIN LOCK
 *   3'. every affected `customer_credits` FOR UPDATE, IN ID ORDER
 *   4.  the `customers` row FOR SHARE
 *   5.  (inside `accounting_post_reversal`) `businesses` FOR SHARE, then the
 *       shared advisory account locks in account-id order (`0046:565-570`)
 *
 * Steps 3 and 3' are the ONE place the chain is read, and they are the
 * canonical source lock the replacement protection of
 * `docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` rests on.
 */
import { describe, expect, it } from 'vitest';
import {
  ReversalError,
  creditChain,
  invoiceChain,
  orderedActive,
  planAllocationReversal,
  tailOf,
  writeTimeGeneration,
  type ActiveReducer,
  type ReversalSequence,
  type SettlementChain,
} from '../src/customer-reversal';

/**
 * The value, or a failure that names what was missing. A `!` would assert the
 * same thing silently and would turn a model defect into a `TypeError` with no
 * subject, so the lint rule that forbids it is doing this file a favour.
 */
function must<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`the model has no ${what}`);
  return v;
}

// ══════════════════════════════════════════════════════════════════════════
// 1. The scheduler.
// ══════════════════════════════════════════════════════════════════════════

type Step =
  | { readonly kind: 'lock'; readonly resource: string; readonly mode: 'exclusive' | 'share' }
  | { readonly kind: 'act'; readonly what: string; readonly fn: () => void }
  | { readonly kind: 'commit' };

/**
 * `deadlock` carries `40P01` because that is the token a level-F re-expression
 * will compare against, and a model whose vocabulary is not the database's
 * cannot be checked against it. A deadlock is a lock-ORDER finding and has its
 * own kind for that reason: it is never folded into `refused`, which is where a
 * business outcome lives.
 */
type Outcome = { readonly kind: 'committed' } | { readonly kind: 'refused'; readonly code: string } | { readonly kind: 'deadlock'; readonly sqlstate: '40P01' };

interface Txn {
  readonly id: string;
  readonly body: () => Generator<Step, void, void>;
}

interface Held {
  readonly resource: string;
  readonly mode: 'exclusive' | 'share';
}

/** The lock mode a pending step is waiting in; anything but a lock step waits for nothing. */
function pendingMode(step: Step): 'exclusive' | 'share' {
  return step.kind === 'lock' ? step.mode : 'exclusive';
}

/**
 * THE TRANSACTIONAL STORE the scheduler drives. A transaction's writes are
 * staged and become visible to anyone else only at `commit`; a refused or
 * deadlocked transaction's writes are DISCARDED at `rollback`.
 *
 * This interface exists because of CHALLENGE FINDING F1, and it is worth being
 * exact about what was wrong. An earlier revision of this file declared "READ
 * COMMITTED visibility. A read sees only COMMITTED state" in its header while
 * `World.rows` and `World.reversed` were a shared `Map` and `Set` written in an
 * `act` step and visible to every transaction immediately — READ UNCOMMITTED,
 * whatever the comment said — and `finish()` cleared the locks without touching
 * the rows, so a REFUSED transaction's inserted row stayed in the world for
 * ever. Both defects were load-bearing for C-7, the only model of the
 * direct-SQL half, and C-7's verdict was produced by the two of them together.
 * **A model that NAMES an isolation level must implement it.**
 */
interface Store {
  commit(txn: string): void;
  rollback(txn: string): void;
  /**
   * The scheduler hands the store a way to ask whether a transaction HOLDS a
   * resource, so a store that models an index can refuse a case which forgot
   * to take the index-key lock (F-C8). Optional, so a store need not have one.
   */
  attach?(probe: (txn: string, resource: string) => boolean): void;
}

class Scheduler {
  private readonly gens = new Map<string, Generator<Step, void, void>>();
  private readonly held = new Map<string, Held[]>();
  private readonly pending = new Map<string, Step>();
  private readonly waiting = new Map<string, string>();
  private readonly done = new Map<string, Outcome>();
  private readonly store: Store | undefined;
  /** Every resource every transaction has ever waited for, for the queue barrier. */
  public readonly queued: { readonly txn: string; readonly resource: string; readonly behind: readonly string[] }[] = [];

  constructor(txns: readonly Txn[], store?: Store) {
    this.store = store;
    for (const t of txns) {
      this.gens.set(t.id, t.body());
      this.held.set(t.id, []);
    }
    store?.attach?.((txn, resource) => (this.held.get(txn) ?? []).some((h) => h.resource === resource));
  }

  /** Advance `id` by one step. A blocked transaction does not advance, and saying so is the barrier. */
  public step(id: string): void {
    if (this.done.has(id)) return;
    let next = this.pending.get(id);
    if (next === undefined) {
      const r = must(this.gens.get(id), `generator for ${id}`).next();
      if (r.done) {
        this.finish(id, { kind: 'committed' });
        return;
      }
      next = r.value;
    }
    if (next.kind === 'lock') {
      const blocker = this.blockers(id, next.resource, next.mode);
      if (blocker.length > 0) {
        this.pending.set(id, next);
        if (this.waiting.get(id) !== next.resource) {
          this.queued.push({ txn: id, resource: next.resource, behind: blocker });
        }
        this.waiting.set(id, next.resource);
        if (this.cycle(id)) this.finish(id, { kind: 'deadlock', sqlstate: '40P01' });
        return;
      }
      must(this.held.get(id), `lock list for ${id}`).push({ resource: next.resource, mode: next.mode });
      this.pending.delete(id);
      this.waiting.delete(id);
      return;
    }
    this.pending.delete(id);
    if (next.kind === 'commit') {
      this.finish(id, { kind: 'committed' });
      return;
    }
    try {
      next.fn();
    } catch (e) {
      // A `ReversalError` carries its CODE; anything else carries its message.
      // The code is the law's name, and a case that pinned a prose message
      // would be asserting the wording and not the law.
      const code = e instanceof ReversalError ? e.code : e instanceof Error ? e.message : String(e);
      this.finish(id, { kind: 'refused', code });
    }
  }

  private finish(id: string, outcome: Outcome): void {
    this.done.set(id, outcome);
    this.held.set(id, []);
    this.pending.delete(id);
    this.waiting.delete(id);
    // The store transition is part of finishing, so no case can forget it:
    // a commit PUBLISHES the staged writes, and a refusal or a deadlock
    // DISCARDS them. F1: the earlier revision did neither.
    if (this.store === undefined) return;
    if (outcome.kind === 'committed') this.store.commit(id);
    else this.store.rollback(id);
  }

  private blockers(id: string, resource: string, mode: 'exclusive' | 'share'): readonly string[] {
    const out: string[] = [];
    for (const [other, locks] of this.held) {
      if (other === id || this.done.has(other)) continue;
      for (const l of locks) {
        if (l.resource !== resource) continue;
        if (mode === 'exclusive' || l.mode === 'exclusive') out.push(other);
      }
    }
    return [...new Set(out)];
  }

  /** A cycle in the wait-for graph. A deadlock, which is a lock-ORDER finding. */
  private cycle(from: string): boolean {
    const seen = new Set<string>();
    let frontier = [from];
    while (frontier.length > 0) {
      const nextFrontier: string[] = [];
      for (const node of frontier) {
        const res = this.waiting.get(node);
        if (res === undefined) continue;
        for (const b of this.blockers(node, res, pendingMode(must(this.pending.get(node), `pending step for ${node}`)))) {
          if (b === from) return true;
          if (!seen.has(b)) {
            seen.add(b);
            nextFrontier.push(b);
          }
        }
      }
      frontier = nextFrontier;
    }
    return false;
  }

  /**
   * Run a WRITTEN-DOWN interleaving: each element is the transaction to advance
   * next. Then drain, so a transaction the written order left unblocked still
   * finishes.
   *
   * THE BOUND IS ENFORCED AND NOT MERELY DOCUMENTED. An earlier revision of
   * this file carried the sentence "the bound expiring is a failure, never a
   * pass" above a loop that simply fell out of its last iteration — a
   * documented guarantee the code did not implement, which is the same defect
   * class as a green that cannot be red. It now throws, so a model that does
   * not settle is a failure with a name.
   */
  public run(order: readonly string[]): void {
    for (const id of order) this.step(id);
    for (let i = 0; i < 400; i += 1) {
      let moved = false;
      for (const id of this.gens.keys()) {
        if (this.done.has(id)) continue;
        const before = this.outcomeOf(id);
        this.step(id);
        if (this.outcomeOf(id) !== before || !this.waiting.has(id)) moved = true;
      }
      if (!moved) {
        // Nothing can move. Either everything finished, or the model is STUCK —
        // every remaining transaction blocked on a lock nobody will release.
        // A stuck model used to leave its transactions reporting `running`,
        // which a case could read as "no finding"; it is now a failure that
        // names them, so `running` is not a reachable final state.
        const stuck = [...this.gens.keys()].filter((id) => !this.done.has(id));
        if (stuck.length > 0) {
          throw new Error(`the model is stuck: ${stuck.join(', ')} blocked with nothing able to move. A model that cannot settle is a failure, never a pass`);
        }
        return;
      }
    }
    throw new Error('the model did not settle within its iteration bound; an expired bound is a failure, never a pass');
  }

  public outcomeOf(id: string): Outcome | 'running' {
    return this.done.get(id) ?? 'running';
  }

  public outcomes(): Record<string, Outcome | 'running'> {
    return Object.fromEntries([...this.gens.keys()].map((id) => [id, this.outcomeOf(id)]));
  }
}

/**
 * THE BARRIER. `txn` must have QUEUED behind `resource`, or this is a failure:
 * a transaction that never contended produced no race result.
 */
function expectQueued(s: Scheduler, txn: string, resource: string): void {
  const hit = s.queued.find((q) => q.txn === txn && q.resource === resource);
  expect(hit, `${txn} never queued behind ${resource}; two connections used in sequence are not contention`).toBeDefined();
  expect(must(hit, `queue entry for ${txn} behind ${resource}`).behind.length, `${txn} queued behind nobody`).toBeGreaterThan(0);
}

/**
 * A race, as a value: the transactions and the WRITTEN-DOWN service order. A
 * case that needs to assert on committed state carries its `World` here too,
 * so the barrier hands it back from the run the assertions are about.
 */
interface Race {
  readonly txns: readonly Txn[];
  readonly order: readonly string[];
}

interface WorldRace extends Race {
  readonly world: World;
}

function runRace(r: Race | WorldRace): Scheduler {
  // A race that carries a world drives it as the STORE, so commit and rollback
  // happen in the scheduler and not in a case that might forget them.
  const s = new Scheduler(r.txns, 'world' in r ? (r as WorldRace).world : undefined);
  s.run(r.order);
  return s;
}

/**
 * THE BARRIER'S OWN RED PROOF, and the reason every case below goes through it.
 *
 * `expectQueued` fails when nothing queued — but that only makes the assertion
 * sound, not the CASE non-vacuous: a model could be wired so that the waiter
 * queues for a reason that has nothing to do with the contender, and every
 * assertion would still pass. So each race is run TWICE, from a FACTORY so the
 * world is fresh:
 *
 *   1. in full, where `waiter` MUST queue behind `resource`;
 *   2. with `blocker` DELETED — the same waiter, the same steps, the same
 *      resource — where the queue MUST be empty and `expectQueued` MUST FAIL.
 *
 * The second run is what makes the first a claim about CONTENTION rather than
 * about the model's plumbing. It is the `[[daftar-a-green-gate-must-prove-it-can-be-red]]`
 * device applied to the barrier itself, by construction rather than by care.
 *
 * Returns the FULL race's scheduler, so the case's outcome assertions read on
 * from here unchanged.
 */
function raceProvingContention<R extends Race>(build: () => R, waiter: string, resource: string, blocker: string): { readonly s: Scheduler; readonly race: R } {
  const race = build();
  const full = runRace(race);
  expectQueued(full, waiter, resource);

  const base = build();
  // THE HELPER'S OWN VACUOUS CONFIGURATION, refused rather than trusted.
  // Naming the WAITER as the blocker would delete the waiter from the second
  // run, leaving an empty queue and a throwing `expectQueued` — both assertions
  // below would pass while nothing was proved. Naming a transaction that is not
  // in the race at all is caught for the same reason.
  expect(blocker, 'the blocker and the waiter are the same transaction, which proves nothing').not.toBe(waiter);
  expect(
    base.txns.some((t) => t.id === blocker),
    `the named blocker ${blocker} is not in this race, so removing it proves nothing`,
  ).toBe(true);
  expect(
    base.txns.some((t) => t.id === waiter),
    `the named waiter ${waiter} is not in this race`,
  ).toBe(true);
  const alone = runRace({
    txns: base.txns.filter((t) => t.id !== blocker),
    order: base.order.filter((id) => id !== blocker),
  });
  expect(alone.queued, `with ${blocker} removed, ${waiter} still queued: the queue is an artefact of the model's wiring, not of contention`).toEqual([]);
  expect(
    () => expectQueued(alone, waiter, resource),
    `expectQueued still PASSED with ${blocker} removed, so the queue claim in this case is vacuous`,
  ).toThrow();

  // The FULL race's scheduler AND its own race value, so a case reads the state
  // of the world the assertions are about and never re-runs it.
  return { s: full, race };
}

// ══════════════════════════════════════════════════════════════════════════
// 2. The world: committed state, READ COMMITTED, and the deferred verifier.
// ══════════════════════════════════════════════════════════════════════════

interface Row {
  readonly reducerId: string;
  readonly level: bigint;
  readonly amount: bigint;
  readonly entryId: string;
  /**
   * The chain's REVERSAL GENERATION as of the moment this row was written:
   * the number of reversals on this chain that had freed a level at or below
   * this row's own. It exists because of F1 — see `REPAIRED_UNIQUE` below —
   * and it is the second column of the replacement UNIQUE key.
   */
  readonly generation: bigint;
  /**
   * HOW MANY REVERSALS THIS CHAIN ALREADY HELD WHEN THIS ROW WAS WRITTEN.
   *
   * The `World` STAMPS it on insert and a caller cannot choose it, because in
   * PostgreSQL it is `created_at DEFAULT now()` (`0081:321`, `0081:465`) and a
   * row does not get to say when it was written. That asymmetry is the design:
   * a direct-SQL writer can fabricate the GENERATION, which is a column it
   * supplies, and cannot fabricate the WRITE TIME, which is what the backfill
   * and the verifier reconstruct it from.
   *
   * Seeded rows default to `0` — a seed is the state as of before everything.
   */
  readonly writtenAfter?: number;
  /**
   * WHICH RELATION THE ROW IS IN (F-C5). It defaults to `payment_allocations`,
   * which is what every case written before this round used.
   *
   * It exists because a UNIQUE index is per-relation, and an invoice's
   * settlement chain is a UNION over two of them (`0081:739-748`). Round 4's
   * `docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §4 claimed the replacement refuses
   * two rows at one invoice level "at statement time and at COMMIT" even when
   * they are one per relation, and said this model hosted that race. It did
   * not: every row this file built was a `payment_allocation`, so the second
   * writer never existed and the claim rested on nothing.
   */
  readonly relation?: 'payment_allocations' | 'customer_credit_applications';
}

/** The relation a row sits in, defaulted. */
function relationOf(r: Row): 'payment_allocations' | 'customer_credit_applications' {
  return r.relation ?? 'payment_allocations';
}

/**
 * The world, with the two mechanisms PostgreSQL provides and the earlier
 * revision of this file did not (F1):
 *
 * - a transaction's own writes live in ITS OWN buffer until it commits, and a
 *   read sees COMMITTED state plus its own buffer (READ COMMITTED);
 * - a refused or deadlocked transaction's writes are DISCARDED (rollback).
 *
 * A `DEFERRABLE INITIALLY DEFERRED` constraint trigger fires at COMMIT **inside
 * the committing transaction**, so it sees exactly what that transaction can
 * see — which is why `verifyAtCommit` takes the transaction's id and not just
 * the chain's. That single argument is the whole of F1: a verifier that could
 * see other transactions' uncommitted rows is not the verifier the design
 * specifies, and a model that gave it that sight could never find the race.
 */
class World implements Store {
  private readonly committedRows = new Map<string, Row[]>();
  private readonly committedReversed = new Set<string>();
  private readonly rowBuf = new Map<string, { readonly chainId: string; readonly row: Row }[]>();
  private readonly revBuf = new Map<string, string[]>();
  public capacity = new Map<string, bigint>();

  // ── seeding: the state as of BEFORE every modelled transaction ──────────

  public seed(chainId: string, capacity: bigint, rows: readonly Row[]): void {
    this.capacity.set(chainId, capacity);
    this.committedRows.set(
      chainId,
      rows.map((r) => ({ ...r, writtenAfter: r.writtenAfter ?? 0 })),
    );
  }

  /** A reversal that is already COMMITTED before the race starts. */
  public seedReversed(reducerId: string): void {
    this.committedReversed.add(reducerId);
  }

  // ── what a transaction writes, and what it can see ─────────────────────

  public insert(txn: string, chainId: string, row: Row): void {
    // The chain must have been seeded: a model that inserts into a chain it
    // never created is a model defect, not a business outcome.
    must(this.committedRows.get(chainId), `rows for chain ${chainId}`);
    const b = this.rowBuf.get(txn) ?? [];
    // The write time is stamped here and nowhere else: the number of reversals
    // this transaction can see at the moment of the insert.
    b.push({ chainId, row: { ...row, writtenAfter: this.reversalSequence(txn, chainId).length } });
    this.rowBuf.set(txn, b);
  }

  public reverse(txn: string, reducerId: string): void {
    const b = this.revBuf.get(txn) ?? [];
    b.push(reducerId);
    this.revBuf.set(txn, b);
  }

  /** Committed rows of the chain plus `txn`'s own uncommitted ones. */
  private visibleRows(txn: string, chainId: string): readonly Row[] {
    const own = (this.rowBuf.get(txn) ?? []).filter((e) => e.chainId === chainId).map((e) => e.row);
    return [...must(this.committedRows.get(chainId), `rows for chain ${chainId}`), ...own];
  }

  /** Committed reversals plus `txn`'s own uncommitted ones. */
  private visibleReversed(txn: string): ReadonlySet<string> {
    return new Set([...this.committedReversed, ...(this.revBuf.get(txn) ?? [])]);
  }

  private chainOf(chainId: string, rows: readonly Row[], reversed: ReadonlySet<string>) {
    const active: ActiveReducer[] = rows
      .filter((r) => !reversed.has(r.reducerId))
      .map((r) => ({
        reducerId: r.reducerId,
        kind: relationOf(r) === 'customer_credit_applications' ? 'credit_application' : 'payment_allocation',
        level: r.level,
        amount: r.amount,
        originalEntryId: r.entryId,
      }));
    return invoiceChain(chainId, must(this.capacity.get(chainId), `capacity for ${chainId}`), active);
  }

  /** The ACTIVE chain AS `txn` SEES IT: committed state plus its own writes. */
  public activeChain(txn: string, chainId: string) {
    return this.chainOf(chainId, this.visibleRows(txn, chainId), this.visibleReversed(txn));
  }

  /**
   * THIS CHAIN'S REVERSALS IN ORDER, each named by the level it freed — the
   * argument the generation law takes. `visibleReversed` is insertion-ordered,
   * and the order of insertion IS the order of the reversals: an order, never a
   * clock (`P4-AL-42`). Reversals whose original is not a row of this chain are
   * dropped, because they freed no level here.
   */
  private reversalSequence(txn: string, chainId: string): ReversalSequence {
    return this.sequenceOf(this.visibleRows(txn, chainId), this.visibleReversed(txn));
  }

  private sequenceOf(rows: readonly Row[], reversed: ReadonlySet<string>): ReversalSequence {
    const seq: bigint[] = [];
    for (const id of reversed) {
      const original = rows.find((r) => r.reducerId === id);
      if (original !== undefined) seq.push(original.level);
    }
    return seq;
  }

  /** The order of the reversals this chain holds, as reducer ids. */
  private reversalOrderOf(rows: readonly Row[], reversed: ReadonlySet<string>): readonly string[] {
    return [...reversed].filter((id) => rows.some((r) => r.reducerId === id));
  }

  /**
   * THE GENERATION OF ONE ROW, under the level-A law and NOT under a private
   * copy of it (F-C2). The model used to carry its own `generationAt`, which
   * the verifier then checked the rows against — an expression compared with
   * itself, and so an assertion no defect in the law could ever make red. There
   * is now ONE implementation, in `src/customer-reversal.ts`, and
   * `customer-reversal-generation.test.ts` compares the SPECIFICATION'S SQL
   * against that same one.
   */
  private generationOf(row: Row, rows: readonly Row[], reversed: ReadonlySet<string>): bigint {
    const order = this.reversalOrderOf(rows, reversed);
    const at = order.indexOf(row.reducerId);
    return writeTimeGeneration(
      { rowId: row.reducerId, level: row.level, writtenAfter: row.writtenAfter ?? 0, reversedAt: at === -1 ? null : at },
      this.sequenceOf(rows, reversed),
    );
  }

  /**
   * The generation a writer at `level` must declare NOW, as `txn` sees the
   * chain: the law applied to a row about to be written, whose write time is
   * therefore the whole of the sequence it can see.
   */
  public generationFor(txn: string, chainId: string, level: bigint): bigint {
    const seq = this.reversalSequence(txn, chainId);
    return writeTimeGeneration({ rowId: '(the row about to be written)', level, writtenAfter: seq.length, reversedAt: null }, seq);
  }

  /**
   * The replacement UNIQUE key: the level AND the generation — PER RELATION.
   *
   * The relation name is part of the key because an index lives in ONE
   * relation. Two rows at one invoice level, one in each relation, therefore
   * take two DIFFERENT index keys and neither blocks on the other. That is not
   * a modelling convenience; it is the hole `0081:330-332` already records in
   * its own words, and the key must say so rather than hide it behind a shared
   * string.
   */
  public static keyOf(chainId: string, r: Row): string {
    return `${relationOf(r)}|${chainId}|${r.level}|${r.generation}`;
  }

  /** The key the OLD constraint used: the level alone, and still per relation. */
  public static levelKeyOf(chainId: string, r: Row): string {
    return `${relationOf(r)}|${chainId}|${r.level}`;
  }

  private verify(chainId: string, rows: readonly Row[], reversed: ReadonlySet<string>): void {
    const chain = this.chainOf(chainId, rows, reversed);
    let before = 0n;
    for (const r of orderedActive(chain)) {
      if (r.level !== before) throw new Error('invoice_settlement.settlement_inconsistent');
      before += r.amount;
    }
    if (before > chain.capacity) throw new Error('invoice_settlement.settlement_inconsistent');
    // THE GENERATION LAW, the third device of the replacement: EVERY row's
    // declared generation must be the one the reversal rows imply — and that
    // means every row, not every ACTIVE row (F-C2). The earlier revision of
    // this file skipped reversed rows, so the one row round 4's backfill
    // expression got wrong was structurally outside the model's reach and no
    // case in the slice could have found it.
    //
    // The deployed verifier is still scoped to ACTIVE rows, and that scoping is
    // sound rather than lucky: `generationFormsAgreeOnActive` is the theorem,
    // and `customer-reversal-generation.test.ts` falsifies it on an unlawful
    // chain so that it is a claim and not a tautology. The model checks the
    // wider set because a BACKFILL writes the narrower set's complement, and a
    // model that cannot see those rows cannot see a backfill defect.
    for (const r of rows) {
      if (r.generation !== this.generationOf(r, rows, reversed)) {
        throw new Error('invoice_settlement.settlement_generation_invalid');
      }
    }
  }

  /**
   * The DEFERRED CHAIN VERIFIER, run inside `txn` at its COMMIT, over what
   * `txn` can see. The replacement protection's commit-time half.
   */
  public verifyAtCommit(txn: string, chainId: string): void {
    this.verify(chainId, this.visibleRows(txn, chainId), this.visibleReversed(txn));
  }

  // ── Store ──────────────────────────────────────────────────────────────

  public commit(txn: string): void {
    for (const e of this.rowBuf.get(txn) ?? []) must(this.committedRows.get(e.chainId), `rows for chain ${e.chainId}`).push(e.row);
    for (const id of this.revBuf.get(txn) ?? []) this.committedReversed.add(id);
    this.rowBuf.delete(txn);
    this.revBuf.delete(txn);
  }

  public rollback(txn: string): void {
    this.rowBuf.delete(txn);
    this.revBuf.delete(txn);
  }

  // ── what a case asserts on, AFTER the run: committed state only ────────

  public committedRowsOf(chainId: string): readonly Row[] {
    return must(this.committedRows.get(chainId), `rows for chain ${chainId}`);
  }

  public committedReversals(): readonly string[] {
    return [...this.committedReversed];
  }

  /** Nothing is staged. A case that asserts on committed state checks this first. */
  public nothingStaged(): boolean {
    return this.rowBuf.size === 0 && this.revBuf.size === 0;
  }

  /** The verifier over COMMITTED state alone, for an assertion after the run. */
  public verifyCommitted(chainId: string): void {
    this.verify(chainId, this.committedRowsOf(chainId), this.committedReversed);
  }

  /**
   * THE UNIQUE INDEX, as the CONCURRENCY PRIMITIVE it actually is (F1).
   *
   * A `UNIQUE` index is not a predicate a `SELECT` can compute. It is
   * cross-transaction MUTUAL EXCLUSION, provided by the index itself with no
   * lock taken by anyone: the second inserter at an equal key BLOCKS on the
   * uncommitted index entry until the first transaction ends, and then either
   * raises `23505` (it committed) or proceeds (it rolled back). That is
   * visibility and atomicity together, and it is exactly what a `BEFORE INSERT`
   * trigger that READS cannot provide.
   *
   * It is modelled as a lock on the KEY — which the caller yields as an
   * ordinary lock step, so the scheduler's own queue barrier proves the
   * exclusion really happened — followed by this duplicate check against
   * COMMITTED state. The lock is released by `finish`, at commit or rollback,
   * which is the index entry's real lifetime.
   */
  public indexKeyLock(key: string): Step {
    return { kind: 'lock', resource: `uniqueindex:${key}`, mode: 'exclusive' };
  }

  /**
   * F-C8. The scheduler installs this on construction, so `insertUnique` can
   * refuse a case that FORGOT to yield `indexKeyLock`. Without it a future case
   * silently gets no mutual exclusion and no warning — a green test over a
   * world with no index, which is the vacuity this whole file exists against.
   */
  private holds: ((txn: string, resource: string) => boolean) | null = null;

  public attach(probe: (txn: string, resource: string) => boolean): void {
    this.holds = probe;
  }

  public insertUnique(txn: string, chainId: string, row: Row, keyOf: (chainId: string, r: Row) => string, index: string): void {
    const key = keyOf(chainId, row);
    // The index-key lock must be HELD. A case that forgot to yield it is a
    // model defect and says so, rather than quietly proving nothing.
    if (this.holds !== null && !this.holds(txn, `uniqueindex:${key}`)) {
      throw new Error(`model defect: ${txn} inserts under ${index} at key ${key} without having yielded indexKeyLock for it`);
    }
    // The duplicate check is against COMMITTED state, because that is what the
    // index holds once the other party's entry has either committed (it is
    // there, and this raises) or rolled back (it is gone, and this proceeds).
    // The WAIT for that outcome is the index-key lock the caller yielded.
    // EVERY row in the relation is indexed, active or not: an index cannot see
    // the activeness ANTI-JOIN, and that is exactly why the level-alone key is
    // incompatible with reversal rather than merely inconvenient.
    // COMMITTED rows, and this transaction's OWN uncommitted ones (F-C8): a
    // unique index refuses two equal keys inside ONE transaction too, and a
    // model that admitted them would pass a command PostgreSQL rejects.
    const own = (this.rowBuf.get(txn) ?? []).filter((e) => e.chainId === chainId).map((e) => e.row);
    if ([...this.committedRowsOf(chainId), ...own].some((r) => keyOf(chainId, r) === key)) {
      throw new Error(`23505 unique_violation ${index}`);
    }
    this.insert(txn, chainId, row);
  }
}

/**
 * The two index names the models name out loud. `LEGACY_UNIQUE` is the
 * constraint `0081:334` declares and that the first draft of
 * `docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` proposed to drop; `REPAIRED_UNIQUE` is
 * the key that replaces it, which carries the REVERSAL GENERATION beside the
 * level so a lawful successor at a freed level no longer collides with the
 * reversed original while two concurrent writers at one level still do.
 */
const LEGACY_UNIQUE = 'payment_allocations_level_uq';
const REPAIRED_UNIQUE = 'payment_allocations_level_generation_uq';

const CHAIN = 'invoice-1';
const INV_LOCK = `invoices:${CHAIN}`;
const CREDIT = 'credit-1';
const CREDIT_LOCK = `customer_credits:${CREDIT}`;

/** The three committed allocations of the standard world: 0 → 400 → 700, closing 1000. */
function seedThree(w: World): void {
  w.seed(CHAIN, 1000n, [
    { reducerId: 'alloc-1', level: 0n, amount: 400n, entryId: 'entry-1', generation: 0n },
    { reducerId: 'alloc-2', level: 400n, amount: 300n, entryId: 'entry-2', generation: 0n },
    { reducerId: 'alloc-3', level: 700n, amount: 300n, entryId: 'entry-3', generation: 0n },
  ]);
}

/**
 * A reversal transaction that follows the DECLARED lock order: advisory
 * document key, then the chain lock, then — and only then — the chain read and
 * the tail check.
 */
function reversalTxn(id: string, w: World, reducerId: string, extraChainLocks: readonly string[] = []): Txn {
  return {
    id,
    body: function* () {
      yield { kind: 'lock', resource: `advisory:daftar.allocation_reversal_id:${id}`, mode: 'exclusive' };
      for (const l of [INV_LOCK, ...extraChainLocks].sort()) yield { kind: 'lock', resource: l, mode: 'exclusive' };
      yield {
        kind: 'act',
        what: 'read the chain under the lock and check the tail',
        fn: () => {
          const chain = w.activeChain(id, CHAIN);
          const tail = tailOf(chain, 'allocation_reversal');
          if (tail === null || tail.reducerId !== reducerId) throw new Error('allocation_reversal.not_last_reducer');
          planAllocationReversal({
            reversalId: id,
            reducerId,
            kind: 'payment_allocation',
            originalEntryId: tail.originalEntryId,
            sourceType: 'customer_payment_allocation',
            chains: [chain],
            reversalDate: '2026-03-02',
            originalDate: '2026-03-01',
            reason: 'modelled',
          });
          w.reverse(id, reducerId);
        },
      };
      yield { kind: 'act', what: 'the deferred verifier at COMMIT', fn: () => w.verifyAtCommit(id, CHAIN) };
      yield { kind: 'commit' };
    },
  };
}

/**
 * A new allocation that follows the same order: the chain lock, then the level,
 * then — since F1 — the REPLACEMENT UNIQUE KEY, which it takes as an index-key
 * entry exactly as a real insert does. A lawful writer holds the chain lock, so
 * that key is always free for it and it never queues there; the key matters on
 * the UNLOCKED path, which is C-7.
 */
function allocationTxn(id: string, w: World, amount: bigint, reducerId: string): Txn {
  return {
    id,
    body: function* () {
      yield { kind: 'lock', resource: `advisory:daftar.payment_id:${id}`, mode: 'exclusive' };
      yield { kind: 'lock', resource: INV_LOCK, mode: 'exclusive' };
      const staged: { row?: Row } = {};
      yield {
        kind: 'act',
        what: 'compute the level and the generation under the lock',
        fn: () => {
          const chain = w.activeChain(id, CHAIN);
          const level = orderedActive(chain).reduce((a, r) => a + r.amount, 0n);
          if (level + amount > chain.capacity) throw new Error('customer_payment.amount_exceeds_outstanding');
          staged.row = { reducerId, level, amount, entryId: `entry-${reducerId}`, generation: w.generationFor(id, CHAIN, level) };
        },
      };
      yield w.indexKeyLock(World.keyOf(CHAIN, must(staged.row, `the level ${id} computed under the lock`)));
      yield {
        kind: 'act',
        what: 'append under the replacement unique key',
        fn: () => w.insertUnique(id, CHAIN, must(staged.row, `the staged row of ${id}`), World.keyOf, REPAIRED_UNIQUE),
      };
      yield { kind: 'act', what: 'the deferred verifier at COMMIT', fn: () => w.verifyAtCommit(id, CHAIN) };
      yield { kind: 'commit' };
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 3. The required cases.
// ══════════════════════════════════════════════════════════════════════════

describe('C-1 — reversal vs reversal of the SAME tail', () => {
  /** The race, as a factory, so the barrier can rebuild it without a contender. */
  function build(order: readonly string[]): () => WorldRace {
    return () => {
      const world = new World();
      seedThree(world);
      return { world, txns: [reversalTxn('A', world, 'alloc-3'), reversalTxn('B', world, 'alloc-3')], order };
    };
  }

  it('exactly one commits, the loser is refused not_last_reducer, and the world stays append-only', () => {
    // A takes its key and the chain lock. B is then enqueued behind the chain
    // lock, and its arrival is OBSERVED before A is allowed to proceed — and
    // the same race WITHOUT A is required to produce no queue at all.
    const { s, race } = raceProvingContention(build(['A', 'A', 'B', 'B']), 'B', INV_LOCK, 'A');
    expect(s.outcomes()).toEqual({ A: { kind: 'committed' }, B: { kind: 'refused', code: 'allocation_reversal.not_last_reducer' } });
    expect(race.world.nothingStaged(), 'a transaction left writes staged, so the assertions below are not about committed state').toBe(true);
    expect(race.world.committedReversals()).toEqual(['alloc-3']);
    // The original row is STILL THERE. Append-only, no delete, no mutation.
    // And B's refused write is GONE, which the earlier revision did not model.
    expect(race.world.committedRowsOf(CHAIN).map((r) => r.reducerId)).toEqual(['alloc-1', 'alloc-2', 'alloc-3']);
  });

  it('the OTHER service order gives the mirror outcome, so the result is the protocol and not the schedule', () => {
    const { s } = raceProvingContention(build(['B', 'B', 'A', 'A']), 'A', INV_LOCK, 'B');
    expect(s.outcomes()).toEqual({ B: { kind: 'committed' }, A: { kind: 'refused', code: 'allocation_reversal.not_last_reducer' } });
  });
});

describe('C-2 — reversal vs a NEW allocation on the same chain', () => {
  it('the reversal wins the lock: the allocation then computes its level from the SHORTENED chain and lands at the freed level', () => {
    const { s, race } = raceProvingContention(
      () => {
        const world = new World();
        seedThree(world);
        return {
          world,
          txns: [reversalTxn('REV', world, 'alloc-3'), allocationTxn('ALLOC', world, 150n, 'alloc-4')],
          order: ['REV', 'REV', 'ALLOC', 'ALLOC'],
        };
      },
      'ALLOC',
      INV_LOCK,
      'REV',
    );
    expect(s.outcomes()).toEqual({ REV: { kind: 'committed' }, ALLOC: { kind: 'committed' } });
    const w = race.world;
    const landed = must(
      w.committedRowsOf(CHAIN).find((r) => r.reducerId === 'alloc-4'),
      'the allocation the model just appended',
    );
    // The level the reversal freed. The ORIGINAL row at 700 still exists, so a
    // per-relation UNIQUE (business_id, invoice_id, level) would have refused
    // this LAWFUL allocation — the whole of the level-uniqueness replacement.
    expect(landed.level).toBe(700n);
    expect(w.committedRowsOf(CHAIN).filter((r) => r.level === 700n).length).toBe(2);
    // And the ACTIVE chain is still contiguous, which is what actually matters.
    expect(() => w.verifyCommitted(CHAIN)).not.toThrow();
  });

  it('the allocation wins the lock: the reversal then sees a reducer that is no longer the tail and is refused', () => {
    // The invoice must still be OPEN for a new allocation to be lawful at all,
    // so this case seeds 400 + 300 + 200 against a total of 1000. A closed
    // invoice would refuse the allocation by the cap and the race would never
    // happen — a case that cannot occur proves nothing about the one that can.
    const { s, race } = raceProvingContention(
      () => {
        const world = new World();
        world.seed(CHAIN, 1000n, [
          { reducerId: 'alloc-1', level: 0n, amount: 400n, entryId: 'entry-1', generation: 0n },
          { reducerId: 'alloc-2', level: 400n, amount: 300n, entryId: 'entry-2', generation: 0n },
          { reducerId: 'alloc-3', level: 700n, amount: 200n, entryId: 'entry-3', generation: 0n },
        ]);
        return {
          world,
          txns: [reversalTxn('REV', world, 'alloc-3'), allocationTxn('ALLOC', world, 100n, 'alloc-4')],
          order: ['ALLOC', 'ALLOC', 'REV', 'REV'],
        };
      },
      'REV',
      INV_LOCK,
      'ALLOC',
    );
    expect(s.outcomes()).toEqual({ ALLOC: { kind: 'committed' }, REV: { kind: 'refused', code: 'allocation_reversal.not_last_reducer' } });
    const w = race.world;
    // REV was refused, so its staged reversal row was DISCARDED.
    expect(w.committedReversals()).toEqual([]);
    expect(
      must(
        w.committedRowsOf(CHAIN).find((r) => r.reducerId === 'alloc-4'),
        'the allocation the model just appended',
      ).level,
    ).toBe(900n);
  });
});

describe('C-3 — TWO allocations after a reversal, both aiming at the freed level', () => {
  /** The world after the tail was reversed: level 700 free, the original row still at 700. */
  function build(amount: bigint): () => WorldRace {
    return () => {
      const world = new World();
      seedThree(world);
      world.seedReversed('alloc-3');
      return {
        world,
        txns: [allocationTxn('A1', world, amount, 'new-1'), allocationTxn('A2', world, amount, 'new-2')],
        order: ['A1', 'A1', 'A2', 'A2'],
      };
    };
  }

  it('both commit, at SUCCESSIVE levels, because each computes its level after taking the chain lock', () => {
    const { s, race } = raceProvingContention(build(100n), 'A2', INV_LOCK, 'A1');
    expect(s.outcomes()).toEqual({ A1: { kind: 'committed' }, A2: { kind: 'committed' } });
    expect(
      race.world
        .committedRowsOf(CHAIN)
        .filter((r) => r.reducerId.startsWith('new-'))
        .map((r) => r.level),
    ).toEqual([700n, 800n]);
    expect(() => race.world.verifyCommitted(CHAIN)).not.toThrow();
  });

  it('the last amount is capped under the lock: the loser is refused rather than over-allocating the invoice', () => {
    // 300 is exactly what the reversal freed, so only one of the two can land.
    const { s } = raceProvingContention(build(300n), 'A2', INV_LOCK, 'A1');
    expect(s.outcomes()).toEqual({ A1: { kind: 'committed' }, A2: { kind: 'refused', code: 'customer_payment.amount_exceeds_outstanding' } });
  });
});

describe('C-4 — a TWO-CHAIN reversal, in ONE transaction', () => {
  /**
   * A CHALLENGE FINDING ABOUT THIS BLOCK (F9), recorded rather than quietly
   * fixed: the act step used to be `fn: () => void 0` and the credit chain was
   * never seeded, so the whole of C-4 proved the LOCK ORDER and nothing about
   * the TWO-CHAIN LAW it is named after. A case whose subject is a no-op act
   * cannot fail for the reason its title gives.
   *
   * The act now runs the real `planAllocationReversal` over BOTH chains — the
   * invoice AR chain, ascending from zero, and the credit chain, which the
   * production constructor converts from its DESCENDING stored column — so the
   * two-chain arity and the two tail checks are the thing being exercised.
   */
  const CREDIT_ORIGINAL = 600n;

  /** The credit chain, built by the production constructor from stored descending levels. */
  function creditChainOf(consumers: readonly { readonly reducerId: string; readonly remainingBeforeMinor: bigint; readonly consumedMinor: bigint }[]) {
    return creditChain(
      CREDIT,
      CREDIT_ORIGINAL,
      consumers.map((c) => ({ ...c, originalEntryId: `entry-${c.reducerId}` })),
    );
  }

  /**
   * The credit-application reversal: both chain locks in resource order, in ONE
   * transaction, and THEN both tail checks in one call — which is the law, since
   * a reducer that is the tail on one chain and not the other must be refused
   * whole.
   */
  function twoChainReversal(id: string, taken: string[], chains: { readonly invoice: SettlementChain; readonly credit: SettlementChain }): Txn {
    return {
      id,
      body: function* () {
        yield { kind: 'lock', resource: `advisory:daftar.allocation_reversal_id:${id}`, mode: 'exclusive' };
        for (const l of [INV_LOCK, CREDIT_LOCK].sort()) {
          yield { kind: 'lock', resource: l, mode: 'exclusive' };
          taken.push(l);
        }
        yield {
          kind: 'act',
          what: 'both tail checks, in ONE call, under both locks',
          fn: () => {
            planAllocationReversal({
              reversalId: id,
              reducerId: 'app-2',
              kind: 'credit_application',
              originalEntryId: 'entry-app-2',
              sourceType: 'customer_credit_application',
              chains: [chains.invoice, chains.credit],
              reversalDate: '2026-03-02',
              originalDate: '2026-03-01',
              reason: 'modelled',
            });
          },
        };
        yield { kind: 'commit' };
      },
    };
  }

  /** The tail on BOTH chains: invoice 0 → 400 (app-2 at 400), credit 600 → 300 → 100. */
  function tailOnBoth(): { readonly invoice: SettlementChain; readonly credit: SettlementChain } {
    return {
      invoice: invoiceChain(CHAIN, 1000n, [
        { reducerId: 'alloc-1', kind: 'payment_allocation', level: 0n, amount: 400n, originalEntryId: 'entry-1' },
        { reducerId: 'app-2', kind: 'credit_application', level: 400n, amount: 200n, originalEntryId: 'entry-app-2' },
      ]),
      credit: creditChainOf([
        { reducerId: 'app-1', remainingBeforeMinor: 600n, consumedMinor: 300n },
        { reducerId: 'app-2', remainingBeforeMinor: 300n, consumedMinor: 200n },
      ]),
    };
  }

  it('both chain locks are taken in ONE transaction, in resource order, and the reducer that is the tail on BOTH chains is accepted', () => {
    const taken: string[] = [];
    const s = runRace({ txns: [twoChainReversal('T', taken, tailOnBoth())], order: ['T', 'T', 'T', 'T', 'T'] });
    expect(s.outcomeOf('T')).toEqual({ kind: 'committed' });
    expect(taken).toEqual([CREDIT_LOCK, INV_LOCK]);
    expect([...taken]).toEqual([...taken].sort());
  });

  it('PLANTED — the tail on its INVOICE but NOT on its CREDIT is refused under both locks, so the second chain is really checked', () => {
    // The planted fact is ONE: a later consumer on the CREDIT chain alone. The
    // credit chain stays otherwise contiguous (600 → 300 → 100 → 50), because a
    // planted gap would be refused by the chain law and would prove the wrong
    // thing.
    const planted = {
      invoice: tailOnBoth().invoice,
      credit: creditChainOf([
        { reducerId: 'app-1', remainingBeforeMinor: 600n, consumedMinor: 300n },
        { reducerId: 'app-2', remainingBeforeMinor: 300n, consumedMinor: 200n },
        { reducerId: 'app-3', remainingBeforeMinor: 100n, consumedMinor: 50n },
      ]),
    };
    const taken: string[] = [];
    const s = runRace({ txns: [twoChainReversal('T', taken, planted)], order: ['T', 'T', 'T', 'T', 'T'] });
    expect(s.outcomeOf('T')).toEqual({ kind: 'refused', code: 'allocation_reversal.not_last_reducer' });
    // BOTH locks were still taken before the refusal: the refusal is the law's,
    // not an early exit that skipped the second chain.
    expect(taken).toEqual([CREDIT_LOCK, INV_LOCK]);
  });

  it('PLANTED — the tail on its CREDIT but NOT on its INVOICE is refused the same way, so neither chain is the only one checked', () => {
    const planted = {
      invoice: invoiceChain(CHAIN, 1000n, [
        { reducerId: 'alloc-1', kind: 'payment_allocation', level: 0n, amount: 400n, originalEntryId: 'entry-1' },
        { reducerId: 'app-2', kind: 'credit_application', level: 400n, amount: 200n, originalEntryId: 'entry-app-2' },
        { reducerId: 'alloc-3', kind: 'payment_allocation', level: 600n, amount: 100n, originalEntryId: 'entry-3' },
      ]),
      credit: tailOnBoth().credit,
    };
    const s = runRace({ txns: [twoChainReversal('T', [], planted)], order: ['T', 'T', 'T', 'T', 'T'] });
    expect(s.outcomeOf('T')).toEqual({ kind: 'refused', code: 'allocation_reversal.not_last_reducer' });
  });

  it('PLANTED — ONE chain presented alone is refused by ARITY, before any tail check could pass', () => {
    const only = tailOnBoth();
    const s = runRace({
      txns: [
        {
          id: 'T',
          body: function* () {
            yield { kind: 'lock', resource: INV_LOCK, mode: 'exclusive' };
            yield {
              kind: 'act',
              what: 'one chain only',
              fn: () => {
                planAllocationReversal({
                  reversalId: 'T',
                  reducerId: 'app-2',
                  kind: 'credit_application',
                  originalEntryId: 'entry-app-2',
                  sourceType: 'customer_credit_application',
                  chains: [only.invoice],
                  reversalDate: '2026-03-02',
                  originalDate: '2026-03-01',
                  reason: 'modelled',
                });
              },
            };
            yield { kind: 'commit' };
          },
        },
      ],
      order: ['T', 'T', 'T'],
    });
    // It would have been the tail on the chain it DID present, so the refusal
    // can only be the arity law.
    expect(s.outcomeOf('T')).toEqual({ kind: 'refused', code: 'allocation_reversal.chain_inconsistent' });
  });

  it('a competing single-chain writer on EITHER chain queues behind it, so neither chain can move under a half-checked reversal', () => {
    for (const competitor of [INV_LOCK, CREDIT_LOCK]) {
      // The barrier is applied PER CHAIN, with the two-chain reversal itself as
      // the blocker to remove, so neither chain's claim rests on the other's.
      const { s } = raceProvingContention(
        () => ({
          txns: [
            twoChainReversal('T', [], tailOnBoth()),
            {
              id: 'OTHER',
              body: function* () {
                yield { kind: 'lock', resource: competitor, mode: 'exclusive' };
                yield { kind: 'commit' };
              },
            },
          ],
          order: ['T', 'T', 'T', 'OTHER', 'OTHER'],
        }),
        'OTHER',
        competitor,
        'T',
      );
      expect(s.outcomes()).toEqual({ T: { kind: 'committed' }, OTHER: { kind: 'committed' } });
    }
  });
});

describe('C-5 — the STALE HEAD', () => {
  /**
   * The defect, written out: the head is read with NO lock held, then compared
   * against the figure read under the lock. `observed` is the model's own record
   * of what the unlocked read saw, so a case can assert that the stale path was
   * actually exercised rather than assume it.
   */
  function staleTxn(world: World, observed: { before: number | null }): Txn {
    return {
      id: 'STALE',
      body: function* () {
        yield {
          kind: 'act',
          what: 'read the head WITHOUT the lock',
          fn: () => {
            observed.before = orderedActive(world.activeChain('STALE', CHAIN)).length;
          },
        };
        yield { kind: 'lock', resource: INV_LOCK, mode: 'exclusive' };
        yield {
          kind: 'act',
          what: 'recompute under the lock and compare',
          fn: () => {
            if (orderedActive(world.activeChain('STALE', CHAIN)).length !== observed.before) throw new Error('customer_payment.settlement_changed');
          },
        };
        yield { kind: 'commit' };
      },
    };
  }

  it('a head read BEFORE the chain lock is stale after it, and the recomputation under the lock refuses it', () => {
    // The barrier rebuilds the same race WITHOUT REV, where STALE must neither
    // queue nor be refused — which is what makes the refusal below a claim
    // about the reversal and not about STALE's own double read.
    const { s } = raceProvingContention(
      () => {
        const world = new World();
        seedThree(world);
        return {
          world,
          txns: [staleTxn(world, { before: null }), reversalTxn('REV', world, 'alloc-3')],
          order: ['STALE', 'REV', 'REV', 'REV', 'REV', 'STALE', 'STALE'],
        };
      },
      'STALE',
      INV_LOCK,
      'REV',
    );
    expect(s.outcomeOf('REV')).toEqual({ kind: 'committed' });
    expect(s.outcomeOf('STALE')).toEqual({ kind: 'refused', code: 'customer_payment.settlement_changed' });
  });

  it('with the reversal removed the SAME stale transaction COMMITS, so the refusal is the contention and not the double read', () => {
    // The non-vacuity proof of the case above, stated as its own claim because
    // it is the one a reader will doubt: STALE reads twice whatever happens, so
    // "it was refused" means nothing until the no-contender run commits.
    const world = new World();
    seedThree(world);
    const observed = { before: null as number | null };
    const s = runRace({ world, txns: [staleTxn(world, observed)], order: ['STALE', 'STALE', 'STALE', 'STALE'] });
    expect(s.outcomeOf('STALE')).toEqual({ kind: 'committed' });
    expect(s.queued).toEqual([]);
    expect(observed.before).toBe(3);
  });

  it('PLANTED — a transaction that does NOT recompute under the lock COMMITS over a stale read, which is what the recomputation prevents', () => {
    // A CHALLENGE FINDING (F10): the safety claim above had no planted
    // counterpart, so "no stale head commits" could have been true because
    // nothing in the model was capable of committing a stale head at all. This
    // is the planted defect: the SAME interleaving, with the compare-under-the-
    // lock step REMOVED and nothing else changed. It commits — and the commit
    // is the proof that the step the real protocol takes is load-bearing.
    const world = new World();
    seedThree(world);
    const observed = { before: null as number | null };
    const defective: Txn = {
      id: 'STALE',
      body: function* () {
        yield {
          kind: 'act',
          what: 'read the head WITHOUT the lock',
          fn: () => {
            observed.before = orderedActive(world.activeChain('STALE', CHAIN)).length;
          },
        };
        yield { kind: 'lock', resource: INV_LOCK, mode: 'exclusive' };
        // THE PLANTED OMISSION: no recomputation, no comparison. One step gone.
        yield { kind: 'commit' };
      },
    };
    const s = runRace({
      world,
      txns: [defective, reversalTxn('REV', world, 'alloc-3')],
      order: ['STALE', 'REV', 'REV', 'REV', 'REV', 'STALE', 'STALE'],
    });
    expect(s.outcomeOf('REV')).toEqual({ kind: 'committed' });
    // The read really was stale — it saw three active reducers and the reversal
    // committed before the lock was granted — and the transaction committed
    // anyway. That is the harm.
    expect(observed.before).toBe(3);
    expect(world.committedReversals()).toEqual(['alloc-3']);
    expect(s.outcomeOf('STALE'), 'the planted defect did not commit, so it is not a demonstration of the harm').toEqual({ kind: 'committed' });
    expectQueued(s, 'STALE', INV_LOCK);
  });

  it('NO stale head commits over a stale read, across four written-down interleavings, and the stale path is PROVEN exercised', () => {
    const orders: readonly (readonly string[])[] = [
      ['STALE', 'REV', 'REV', 'REV', 'REV', 'STALE'],
      ['REV', 'STALE', 'REV', 'REV', 'REV', 'STALE'],
      ['REV', 'REV', 'STALE', 'STALE', 'REV', 'REV'],
      ['REV', 'REV', 'REV', 'REV', 'STALE', 'STALE'],
    ];
    // An earlier revision asserted `bothCommitted && reversed && seen === 3`
    // was false, which PASSES TRIVIALLY whenever `seen !== 3` — so an
    // interleaving in which the stale read never happened looked like a proof.
    // The verdict is now computed per order, the two lawful verdicts are named,
    // and the loop must have reached the genuinely stale one at least once.
    const verdicts: string[] = [];
    for (const order of orders) {
      const world = new World();
      seedThree(world);
      const observed = { before: null as number | null };
      const s = runRace({ world, txns: [staleTxn(world, observed), reversalTxn('REV', world, 'alloc-3')], order });
      const st = s.outcomeOf('STALE');
      const rev = s.outcomeOf('REV');
      expect(st, `STALE never settled under order ${order.join(',')}`).not.toBe('running');
      expect(rev, `REV never settled under order ${order.join(',')}`).not.toBe('running');
      if (st === 'running' || rev === 'running') continue;
      expect(st.kind, 'a deadlock is a lock-order defect, never a business outcome').not.toBe('deadlock');
      expect(rev.kind, 'a deadlock is a lock-order defect, never a business outcome').not.toBe('deadlock');

      // Was the read genuinely stale? It is stale exactly when the reversal had
      // COMMITTED after the unlocked read and before the locked one — which the
      // model records as: REV committed, and the unlocked read saw all three.
      const wasStale = rev.kind === 'committed' && observed.before === 3;
      if (wasStale) {
        expect(st, `a stale head COMMITTED under order ${order.join(',')}`).toEqual({
          kind: 'refused',
          code: 'customer_payment.settlement_changed',
        });
        verdicts.push('stale-and-refused');
      } else {
        // Not stale: the figure STALE read was still true under the lock, so a
        // commit is correct and a refusal would be a false conflict.
        expect(st, `a non-stale transaction was refused under order ${order.join(',')}`).toEqual({ kind: 'committed' });
        verdicts.push('not-stale-and-committed');
      }
    }
    expect(verdicts.length).toBe(orders.length);
    // THE NON-VACUITY FLOOR: if no order produced a genuinely stale read, this
    // whole case proved nothing about staleness.
    expect(verdicts, 'no interleaving produced a genuinely stale read, so this case proves nothing').toContain('stale-and-refused');
  });
});

describe('C-6 — DEADLOCK ORDERING: every relevant lock pair, in BOTH directions', () => {
  /**
   * EVERY resource class on S6's path, including the ones S6 INTRODUCES.
   *
   * A CHALLENGE FINDING (F7): the earlier `RESOURCES` held the four classes a
   * reversal SHARES with a settlement and omitted every class this slice adds —
   * the advisory document keys. A deadlock sweep that omits the new lock
   * classes sweeps the predecessor's lock order, not this slice's, and the new
   * classes are the only ones whose ordering had never been exercised anywhere.
   *
   * A LATER FINDING ON THE SAME SWEEP (F-C3), recorded rather than quietly
   * fixed: round 4 made the provider key the NEW step 1 of the declared order
   * in three documents and in this file's own header, raised a patch request
   * saying S6 takes THREE advisory keys in one transaction — and did not add it
   * here, in the same commit that turned this sweep's counts into an identity.
   * An identity cannot drift, and it did not; what it cannot do is notice a
   * class that was never enumerated. A census is only as wide as its roster,
   * which is the one thing in this file that no assertion can check for itself.
   *
   * (The `payments` FOR UPDATE that was step 2 is NOT here, because it is gone:
   * it serialised nothing the advisory key and `payment_reversals_payment_uq`
   * do not already — see the header's lock order.)
   */
  const PROVIDER_KEY = 'advisory:daftar.payment_provider_reference:stripe|evt_1';
  const REVERSAL_KEY = 'advisory:daftar.payment_reversal_id:rev-1';
  const PAYMENT_KEY = 'advisory:daftar.payment_id:payment-1';
  const RESOURCES = [PROVIDER_KEY, REVERSAL_KEY, PAYMENT_KEY, INV_LOCK, CREDIT_LOCK, 'customers:cust-1', 'businesses:biz-1'] as const;

  /**
   * The declared order, in full: the provider key → the reversal's own key →
   * the payment key → `invoices` → `customer_credits` → `customers` →
   * `businesses`. The first three are the block `PATCH-REQ-S6-012` asks
   * `P4-AL-41` to rank; the last four are its existing domain list, unchanged
   * and not reordered.
   */
  const DECLARED_ORDER: readonly string[] = [PROVIDER_KEY, REVERSAL_KEY, PAYMENT_KEY, INV_LOCK, CREDIT_LOCK, 'customers:cust-1', 'businesses:biz-1'];

  /**
   * The mode the protocol takes each resource in: the two chain locks are
   * `FOR UPDATE`, and `customers` and `businesses` are `FOR SHARE`
   * (`0081:2014`, and `businesses` inside `accounting_post_reversal`).
   */
  function modeOf(resource: string): 'exclusive' | 'share' {
    // The two advisory keys are exclusive (`pg_advisory_xact_lock`, not the
    // `_shared` form), the two chain locks are FOR UPDATE, and `customers` and
    // `businesses` are FOR SHARE (`0081:2014`, and `businesses` inside
    // `accounting_post_reversal`).
    return resource.startsWith('customers') || resource.startsWith('businesses') ? 'share' : 'exclusive';
  }

  /** A pair can contend at all only if at least one of its two locks is exclusive. */
  function canContend(a: string, b: string): boolean {
    return modeOf(a) === 'exclusive' || modeOf(b) === 'exclusive';
  }

  /**
   * A pair can form a CYCLE only if BOTH of its locks conflict, because a
   * deadlock needs both parties to be waiting. One exclusive lock and one
   * shared one contend without ever cycling — which is a distinction the first
   * draft of the both-directions case did not make.
   */
  function canCycle(a: string, b: string): boolean {
    return modeOf(a) === 'exclusive' && modeOf(b) === 'exclusive';
  }

  function orderedTakerTxn(id: string, resources: readonly string[]): Txn {
    return {
      id,
      body: function* () {
        for (const r of resources) yield { kind: 'lock', resource: r, mode: modeOf(r) };
        yield { kind: 'commit' };
      },
    };
  }

  function orderedPairs(): readonly (readonly [string, string])[] {
    const out: [string, string][] = [];
    for (const a of RESOURCES) for (const b of RESOURCES) if (a !== b) out.push([a, b]);
    return out;
  }

  /** Each pair once, regardless of direction — the subject of the no-deadlock claim. */
  function unorderedPairs(): readonly (readonly [string, string])[] {
    return orderedPairs().filter(([a, b]) => DECLARED_ORDER.indexOf(a) < DECLARED_ORDER.indexOf(b));
  }

  /** The pair in the order the PROTOCOL requires of every path. */
  function declared(a: string, b: string): readonly string[] {
    return [a, b].sort((x, y) => DECLARED_ORDER.indexOf(x) - DECLARED_ORDER.indexOf(y));
  }

  /**
   * A VACUITY FINDING ABOUT THIS FILE'S OWN EARLIER REVISION, recorded rather
   * than quietly fixed.
   *
   * The first version of the case below ran all twelve ordered pairs and
   * asserted "deadlocks zero times". Two of the twelve — `customers` +
   * `businesses`, in both directions — are BOTH taken `FOR SHARE`, and two
   * shared locks on one row do not conflict in PostgreSQL either. So for those
   * two pairs neither transaction ever waited, and "zero deadlocks" was true
   * the way "no collisions on an empty road" is true. The claim passed while
   * proving nothing, which is exactly the failure mode a model is most at risk
   * of.
   *
   * The fix is not to force those pairs to contend — that would model a
   * protocol DAFTAR does not have. It is to SPLIT the claim: the pairs that can
   * contend must be proved to have contended, and the pairs that cannot are
   * asserted to be exactly the share/share ones and excluded BY NAME.
   */
  it('the pair census is split by whether contention is POSSIBLE, and the share/share pairs are excluded by name', () => {
    const pairs = orderedPairs();
    expect(pairs.length).toBe(RESOURCES.length * (RESOURCES.length - 1));
    const impossible = pairs.filter(([a, b]) => !canContend(a, b));
    // Exactly the two share/share orderings, named, so a later resource added
    // in share mode cannot silently join the excluded set.
    expect(impossible.map(([a, b]) => `${a} + ${b}`).sort()).toEqual(['businesses:biz-1 + customers:cust-1', 'customers:cust-1 + businesses:biz-1']);
    // SEVEN resource classes — five exclusive and two shared: 42 ordered
    // arrangements, 21 pairs, exactly one of which is share/share. The numbers
    // are asserted so that adding a resource without extending this sweep is a
    // failure and not a silent narrowing; and they are derived from the roster
    // itself, so the roster is the only thing a reader must check by hand.
    const exclusive = RESOURCES.filter((r) => modeOf(r) === 'exclusive').length;
    expect(exclusive, 'the five exclusive classes: three advisory keys and the two chain locks').toBe(5);
    expect(pairs.length).toBe(RESOURCES.length * (RESOURCES.length - 1));
    expect(pairs.length).toBe(42);
    expect(pairs.length - impossible.length).toBe(40);
    expect(unorderedPairs().length).toBe(21);
    expect(unorderedPairs().filter(([a, b]) => canContend(a, b)).length).toBe(20);
  });

  it('a share/share pair genuinely CANNOT contend: no queue entry exists, which is why it is not evidence of a lock order', () => {
    const norm = ['customers:cust-1', 'businesses:biz-1'];
    const s = runRace({ txns: [orderedTakerTxn('X', norm), orderedTakerTxn('Y', norm)], order: ['X', 'Y', 'X', 'Y', 'X', 'Y'] });
    expect(s.outcomes()).toEqual({ X: { kind: 'committed' }, Y: { kind: 'committed' } });
    // The point of the case: both committed AND nothing ever queued. A "zero
    // deadlocks" claim over this pair is vacuous, and this is the assertion
    // that says so out loud.
    expect(s.queued).toEqual([]);
  });

  it('every PAIR that can contend does contend, and deadlocks ZERO times when both parties use the declared order', () => {
    // A SECOND CHALLENGE FINDING ABOUT THIS CASE (F7), recorded rather than
    // quietly fixed. It used to enumerate the twelve ORDERED pairs and then
    // normalise BOTH transactions to the declared order before running — so
    // the two directions of a pair produced the identical run, and "both
    // directions" exercised six arrangements twice rather than twelve. The
    // claim was not wrong, it was mis-stated: with both parties in declared
    // order, direction is not a variable. So this case is now over UNORDERED
    // pairs and says so, and the case below carries the real both-directions
    // claim, where the two parties take the pair in OPPOSITE orders.
    const contended: string[] = [];
    for (const [a, b] of unorderedPairs()) {
      if (!canContend(a, b)) continue;
      const norm = declared(a, b);
      const s = runRace({ txns: [orderedTakerTxn('X', norm), orderedTakerTxn('Y', norm)], order: ['X', 'Y', 'X', 'Y', 'X', 'Y', 'X', 'Y'] });
      for (const [id, o] of Object.entries(s.outcomes())) {
        expect(o, `${id} on pair ${a} + ${b} did not settle`).not.toBe('running');
        if (o === 'running') continue;
        expect(o.kind, `${id} on pair ${a} + ${b} did not commit`).toBe('committed');
      }
      // THE NON-VACUITY FLOOR, per pair: one of the two must have waited for the
      // other, or this pair is another empty road.
      expect(s.queued.length, `neither transaction ever waited on pair ${a} + ${b}: zero deadlocks here is vacuous`).toBeGreaterThan(0);
      contended.push(`${a} + ${b}`);
    }
    expect(contended.length, 'the contending-pair set shrank; every pair with an exclusive lock must be covered').toBe(20);
  });

  it('BOTH DIRECTIONS, for real: for every contending pair, the two parties taking it in OPPOSITE orders deadlock — and in the SAME order they never do', () => {
    // This is the claim the previous case could not make, and it is the one
    // that says the declared order is doing work: a pair is only evidence of a
    // lock ORDER if taking it the other way round is a defect.
    //
    // A THIRD FINDING, and this one came out of writing the case: CONTENTION
    // and CYCLE-CAPABILITY ARE NOT THE SAME PREDICATE, and the first draft of
    // this case conflated them. It required every CONTENDING arrangement to
    // deadlock when opposed, and half of them do not — because a cycle needs
    // BOTH parties to wait, so BOTH resources must conflict. A pair of one
    // exclusive and one shared lock contends on the exclusive one and never on
    // the shared one, so the opposed arrangement produces a wait and no cycle.
    // That is correct database behaviour, and a model that demanded a deadlock
    // there would have been asserting a defect as a law. The sweep therefore
    // splits again: the cycle-capable arrangements must deadlock when opposed,
    // and the rest must contend and must not — 20 and 20 over seven classes,
    // both counts derived from the roster below and neither written as a
    // literal here.
    let opposedDeadlocks = 0;
    let matchedRuns = 0;
    let contendedWithoutCycle = 0;
    for (const [a, b] of orderedPairs()) {
      if (!canContend(a, b)) continue;
      const forward = declared(a, b);
      const backward = [...forward].reverse();

      // Matched: both parties in declared order. Never a deadlock.
      const matched = runRace({ txns: [orderedTakerTxn('X', forward), orderedTakerTxn('Y', forward)], order: ['X', 'Y', 'X', 'Y', 'X', 'Y', 'X', 'Y'] });
      for (const o of Object.values(matched.outcomes())) {
        expect(o).not.toBe('running');
        if (o !== 'running') expect(o.kind, `a matched pair ${a} + ${b} deadlocked, which would be a defect in the declared order itself`).toBe('committed');
      }
      matchedRuns += 1;

      // Opposed: one party reverses the pair. The ONLY planted difference is
      // the ORDER — the resource set and both modes are identical — so a
      // `40P01` here is attributable to the order and to nothing else.
      expect(new Set(forward), 'the planting must be in the ORDER and not in the subject').toEqual(new Set(backward));
      const opposed = runRace({ txns: [orderedTakerTxn('X', forward), orderedTakerTxn('Y', backward)], order: ['X', 'Y', 'X', 'Y', 'X', 'Y'] });
      const victims = Object.values(opposed.outcomes()).flatMap((o) => (o !== 'running' && o.kind === 'deadlock' ? [o] : []));
      if (canCycle(a, b)) {
        expect(victims.length, `the opposed arrangement of ${a} + ${b} claimed ${victims.length} victims; the database claims exactly one`).toBe(1);
        expect(must(victims[0], 'the deadlock victim').sqlstate).toBe('40P01');
        opposedDeadlocks += 1;
      } else {
        // One exclusive, one shared: the opposed arrangement contends on the
        // exclusive lock and cannot cycle, because nobody waits on the shared
        // one. So NO deadlock — and a wait must still have happened, or the
        // pair would not be evidence of anything at all.
        expect(victims.length, `the opposed arrangement of ${a} + ${b} deadlocked, but only one of its two locks can conflict`).toBe(0);
        expect(opposed.queued.length, `the opposed arrangement of ${a} + ${b} never waited: it is not evidence of a lock order`).toBeGreaterThan(0);
        contendedWithoutCycle += 1;
      }
    }
    // THE THREE COUNTS AS AN ASSERTED IDENTITY, not as three independent
    // numbers. Three literals can drift apart — one is edited, the other two
    // are not, and the sweep silently covers less than it claims. An identity
    // cannot: each count is compared against the ENUMERATION that produced it,
    // and the partition is required to be exhaustive, so an arrangement cannot
    // fall out of the sweep by landing in neither bucket.
    const canCycleCount = orderedPairs().filter(([a, b]) => canCycle(a, b)).length;
    const contendOnlyCount = orderedPairs().filter(([a, b]) => canContend(a, b) && !canCycle(a, b)).length;
    expect(matchedRuns, 'every CONTENDING arrangement must have been run in the matched direction').toBe(
      orderedPairs().filter(([a, b]) => canContend(a, b)).length,
    );
    expect(opposedDeadlocks, 'every CYCLE-CAPABLE arrangement must have deadlocked when opposed').toBe(canCycleCount);
    expect(contendedWithoutCycle, 'every arrangement that contends without cycling must have been run and must not have deadlocked').toBe(contendOnlyCount);
    // Exhaustive and disjoint: the two buckets partition the contending set.
    expect(opposedDeadlocks + contendedWithoutCycle, 'the two buckets do not partition the contending arrangements').toBe(matchedRuns);
    // And neither bucket is empty, or one half of the claim is an empty loop.
    expect(canCycleCount, 'no arrangement can cycle, so the deadlock half of this case proves nothing').toBeGreaterThan(0);
    expect(contendOnlyCount, 'no arrangement contends without cycling, so the other half proves nothing').toBeGreaterThan(0);
    // The literal census lives in ONE place — the pair-census case above — so
    // these numbers are stated once and derived everywhere else.
    expect(canCycleCount + contendOnlyCount).toBe(40);
  });

  it('PLANTED LOCK-ORDER DEFECT — the planting is in the ORDER ALONE, and it raises 40P01 on exactly one victim', () => {
    const forward = [INV_LOCK, CREDIT_LOCK];
    const reversed = [CREDIT_LOCK, INV_LOCK];

    // THE PLANTING IS ONE FACT. Same resources, same modes, same transaction
    // body, same scheduler: only the SEQUENCE differs. A subject broken in two
    // ways would prove nothing about either, so that is asserted and not
    // assumed.
    expect([...forward].sort()).toEqual([...reversed].sort());
    expect(forward).not.toEqual(reversed);
    expect(forward.map(modeOf)).toEqual(['exclusive', 'exclusive']);
    expect(reversed.map(modeOf)).toEqual(['exclusive', 'exclusive']);

    // THE CONTROL: the very same pair, both parties in the declared order, with
    // real contention and no deadlock. Stated inside this case so the
    // difference is attributable to the one planted fact.
    const control = runRace({ txns: [orderedTakerTxn('X', forward), orderedTakerTxn('Y', forward)], order: ['X', 'Y', 'X', 'Y', 'X', 'Y', 'X', 'Y'] });
    expect(control.outcomes()).toEqual({ X: { kind: 'committed' }, Y: { kind: 'committed' } });
    expect(control.queued.length, 'the control never contended, so it is not a control').toBeGreaterThan(0);

    // THE PLANT: Y takes the same two locks in the opposite order.
    const planted = runRace({ txns: [orderedTakerTxn('X', forward), orderedTakerTxn('Y', reversed)], order: ['X', 'Y', 'X', 'Y', 'X', 'Y'] });
    const victims = Object.entries(planted.outcomes()).flatMap(([id, o]) => (o !== 'running' && o.kind === 'deadlock' ? [{ id, sqlstate: o.sqlstate }] : []));
    // PostgreSQL's detector kills ONE victim, not both, so the model must too:
    // "exactly one" is the claim, and `toContain` would have accepted both.
    expect(victims.length, 'a deadlock must claim exactly one victim, as the database does').toBe(1);
    expect(must(victims[0], 'the deadlock victim').sqlstate).toBe('40P01');
    // And the plant really did contend before it cycled.
    expect(planted.queued.length).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// C-7 — THE DIRECT-SQL RACE, and CHALLENGE FINDING F1.
//
// THE FINDING, STATED FIRST AND NOT BURIED: the replacement protection this
// slice specified was WEAKER than the constraint it dropped, on the exact path
// the constraint existed for, and the earlier version of this model could not
// have found that out.
//
// What a `UNIQUE` index provides is not a predicate a `SELECT` can compute. It
// is cross-transaction MUTUAL EXCLUSION with no lock taken by anyone: the
// second inserter at an equal key blocks on the first's uncommitted index entry
// and then raises `23505` or proceeds, atomically. The replacement's two
// devices are a `BEFORE INSERT` trigger that READS and a
// `DEFERRABLE INITIALLY DEFERRED` constraint trigger that fires INSIDE the
// committing transaction. Under READ COMMITTED neither sees the other's
// uncommitted row, so two direct inserts at one freed level pass BOTH devices
// and BOTH commit — two active rows at one level, consumption past capacity,
// and no later transaction obliged to re-run anything. That is the first case
// below, and it is a demonstration of a defect in my own design.
//
// The earlier model reported the opposite ("the deferred verifier refuses the
// second") out of two defects working together: immediate visibility of other
// transactions' writes, and a refused transaction whose row was never removed.
// Its assertion was `codes.length >= 1`, which cannot tell "the second was
// refused" from "both were refused" from "neither was".
//
// THE REPAIR, and it is not a naked drop: the level UNIQUE is REPLACED by a
// WIDER one that carries the chain's REVERSAL GENERATION beside the level. The
// generation is derived from the append-only reversal rows alone, so two
// truthful writers at one level compute the SAME key and the index excludes one
// of them exactly as before, while a lawful successor at a freed level carries
// a different generation from the reversed original and no longer collides with
// it. A writer that FABRICATES a generation to dodge the key is refused by its
// own deferred verifier, which recomputes the generation from the reversals it
// can see. The three cases after the finding are that argument, run.
// ══════════════════════════════════════════════════════════════════════════

describe('C-7 — the DIRECT-SQL race: no routine, no lock, no tail check', () => {
  /** A world after the tail was reversed: level 700 free, the original row still at 700. */
  function afterReversal(): World {
    const w = new World();
    seedThree(w);
    w.seedReversed('alloc-3');
    return w;
  }

  /**
   * An attacker with INSERT on the relation and no interest in the protocol:
   * no advisory key, no `invoices FOR UPDATE`, a fabricated level. `unique`
   * selects which index its insert must pass, which is the whole experiment.
   */
  function directInsert(w: World, id: string, row: Row, unique: { readonly keyOf: (chainId: string, r: Row) => string; readonly name: string } | null): Txn {
    return {
      id,
      body: function* () {
        if (unique !== null) {
          // The index entry is taken at INSERT time and released when the
          // transaction ends. A second inserter at an equal key WAITS here.
          yield w.indexKeyLock(unique.keyOf(CHAIN, row));
          yield { kind: 'act', what: 'insert under the unique index', fn: () => w.insertUnique(id, CHAIN, row, unique.keyOf, unique.name) };
        } else {
          yield { kind: 'act', what: 'insert with no unique index at all', fn: () => w.insert(id, CHAIN, row) };
        }
        yield { kind: 'act', what: 'the deferred verifier at COMMIT', fn: () => w.verifyAtCommit(id, CHAIN) };
        yield { kind: 'commit' };
      },
    };
  }

  function bad(id: string, level: bigint, generation: bigint, amount = 50n): Row {
    return { reducerId: `bad-${id}`, level, amount, entryId: `e-${id}`, generation };
  }

  it('F1 — WITHOUT a unique key, two direct inserts at the freed level BOTH commit and the COMMITTED chain is left broken with nothing to refuse it', () => {
    const w = afterReversal();
    const s = new Scheduler([directInsert(w, 'D1', bad('1', 700n, 1n), null), directInsert(w, 'D2', bad('2', 700n, 1n), null)], w);
    // The interleaving is written down: both insert, THEN both reach COMMIT.
    s.run(['D1', 'D2', 'D1', 'D2', 'D1', 'D2']);

    // Neither queued, because neither took a lock. With no lock there is no
    // contention to arbitrate, which is why the protection cannot be a lock.
    expect(s.queued).toEqual([]);
    // BOTH COMMITTED. This is the finding, asserted rather than described.
    expect(s.outcomes()).toEqual({ D1: { kind: 'committed' }, D2: { kind: 'committed' } });

    // Two ACTIVE rows at level 700 — the state `payment_allocations_level_uq`
    // refused atomically and with no lock taken by anybody.
    const active = w.committedRowsOf(CHAIN).filter((r) => !w.committedReversals().includes(r.reducerId));
    expect(active.filter((r) => r.level === 700n).map((r) => r.reducerId)).toEqual(['bad-1', 'bad-2']);
    // And the committed world is now one the chain law itself calls broken,
    // with no transaction obliged ever to run the verifier on it again.
    expect(() => w.verifyCommitted(CHAIN)).toThrow(/settlement_inconsistent/);
    expect(active.reduce((a, r) => a + r.amount, 0n)).toBe(800n);
  });

  it('F1, the other half — the LEVEL-ALONE key refuses a LAWFUL successor at the freed level, which is why it cannot simply be kept', () => {
    // The incompatibility, as a single insert with no competitor at all: an
    // index cannot see the activeness ANTI-JOIN, so the reversed original at
    // 700 is still indexed and the lawful successor collides with a row that
    // reduces nothing. This is the one fact the whole replacement exists for.
    const w = afterReversal();
    const s = new Scheduler([directInsert(w, 'L', bad('lawful', 700n, 1n), { keyOf: World.levelKeyOf, name: LEGACY_UNIQUE })], w);
    s.run(['L', 'L', 'L', 'L']);
    expect(s.outcomeOf('L')).toEqual({ kind: 'refused', code: `23505 unique_violation ${LEGACY_UNIQUE}` });
    expect(w.committedRowsOf(CHAIN).map((r) => r.reducerId)).toEqual(['alloc-1', 'alloc-2', 'alloc-3']);
  });

  it('THE REPAIR — under the GENERATION key the lawful successor commits, and a second writer at the same level QUEUES on the index and is refused 23505', () => {
    // The same two inserts as the finding, under the replacement key. The
    // barrier proves the exclusion is real: with the first writer removed, the
    // second neither queues nor is refused.
    const build = (): WorldRace => {
      const world = afterReversal();
      return {
        world,
        txns: [
          directInsert(world, 'D1', bad('1', 700n, 1n), { keyOf: World.keyOf, name: REPAIRED_UNIQUE }),
          directInsert(world, 'D2', bad('2', 700n, 1n), { keyOf: World.keyOf, name: REPAIRED_UNIQUE }),
        ],
        order: ['D1', 'D2', 'D1', 'D1', 'D2', 'D2'],
      };
    };
    const { s, race } = raceProvingContention(build, 'D2', `uniqueindex:payment_allocations|${CHAIN}|700|1`, 'D1');
    expect(s.outcomes()).toEqual({
      D1: { kind: 'committed' },
      D2: { kind: 'refused', code: `23505 unique_violation ${REPAIRED_UNIQUE}` },
    });
    // EXACTLY ONE row landed at the freed level, and the committed chain is
    // whole — the property the level UNIQUE used to provide, restored.
    const w = race.world;
    expect(
      w
        .committedRowsOf(CHAIN)
        .filter((r) => r.level === 700n && r.generation === 1n)
        .map((r) => r.reducerId),
    ).toEqual(['bad-1']);
    expect(() => w.verifyCommitted(CHAIN)).not.toThrow();
  });

  it('THE REPAIR is not vacuous — the SAME index admits the lawful successor at the freed level, so it refuses the duplicate and not the level', () => {
    const w = afterReversal();
    const s = new Scheduler([directInsert(w, 'L', bad('lawful', 700n, 1n), { keyOf: World.keyOf, name: REPAIRED_UNIQUE })], w);
    s.run(['L', 'L', 'L', 'L']);
    expect(s.outcomeOf('L')).toEqual({ kind: 'committed' });
    expect(() => w.verifyCommitted(CHAIN)).not.toThrow();
  });

  it('a writer that FABRICATES the generation to dodge the index is refused by its OWN deferred verifier', () => {
    // The residual the key cannot cover: declaring a different generation is
    // the same move P4-AL-22 records for the level — "a direct SQL attacker
    // simply declares a different level". The generation is DERIVED from the
    // append-only reversal rows, so the verifier recomputes it and refuses.
    const w = afterReversal();
    const s = new Scheduler(
      [
        directInsert(w, 'D1', bad('1', 700n, 1n), { keyOf: World.keyOf, name: REPAIRED_UNIQUE }),
        directInsert(w, 'D2', bad('2', 700n, 7n), { keyOf: World.keyOf, name: REPAIRED_UNIQUE }),
      ],
      w,
    );
    s.run(['D1', 'D2', 'D1', 'D1', 'D2', 'D2']);
    expect(s.outcomes()).toEqual({
      D1: { kind: 'committed' },
      D2: { kind: 'refused', code: 'invoice_settlement.settlement_generation_invalid' },
    });
    // Nothing queued: the liar's key differed, so the index never excluded it.
    // The refusal came from its own COMMIT, which is the claim being made.
    expect(s.queued).toEqual([]);
    expect(() => w.verifyCommitted(CHAIN)).not.toThrow();
  });

  it('F-C1 IN THE MODEL — round 4`s backfill value on the REVERSED original is refused by the very verifier it was said to agree with', () => {
    // The state round 4's `UPDATE` would leave behind: the reversed original at
    // level 700 carrying generation 1, because its own reversal satisfied
    // `o.ar_released_before_txn_minor <= a.ar_released_before_txn_minor`.
    //
    // No concurrency here and none needed. The claim is about a VALUE, and the
    // model could not make it before this round because `verify` skipped every
    // reversed row — which is why the defect needed a real server to surface
    // and should not have.
    const w = new World();
    w.seed(CHAIN, 1000n, [
      { reducerId: 'alloc-1', level: 0n, amount: 400n, entryId: 'entry-1', generation: 0n },
      { reducerId: 'alloc-2', level: 400n, amount: 300n, entryId: 'entry-2', generation: 0n },
      // THE BACKFILLED VALUE, as round 4's expression computes it.
      { reducerId: 'alloc-3', level: 700n, amount: 300n, entryId: 'entry-3', generation: 1n },
    ]);
    w.seedReversed('alloc-3');
    expect(() => w.verifyCommitted(CHAIN)).toThrow(/settlement_generation_invalid/);
  });

  it('F-C1, the consequence — and the SAME world with the law`s value passes, so the refusal is about the backfill and not about reversal', () => {
    const w = afterReversal(); // alloc-3 reversed, carrying its write-time 0
    expect(() => w.verifyCommitted(CHAIN)).not.toThrow();
    // And the lawful successor at the freed level takes (700, 1) — the key
    // round 4's backfill had already given away to the reversed original,
    // which is the duplicate PostgreSQL refused to index.
    const s = new Scheduler([directInsert(w, 'L', bad('lawful', 700n, 1n), { keyOf: World.keyOf, name: REPAIRED_UNIQUE })], w);
    s.run(['L', 'L', 'L', 'L']);
    expect(s.outcomeOf('L')).toEqual({ kind: 'committed' });
    expect(w.committedRowsOf(CHAIN).map((r) => `${r.level}|${r.generation}`)).toEqual(['0|0', '400|0', '700|0', '700|1']);
  });

  it('F-C8 — two equal keys inside ONE transaction are refused 23505, as a unique index refuses them', () => {
    // The model used to check the key against COMMITTED rows alone, so one
    // transaction could insert two identical keys and the model would admit a
    // command PostgreSQL rejects.
    const w = afterReversal();
    const twice: Txn = {
      id: 'T',
      body: function* () {
        const first = bad('a', 700n, 1n);
        const second = bad('b', 700n, 1n);
        yield w.indexKeyLock(World.keyOf(CHAIN, first));
        yield { kind: 'act', what: 'the first insert', fn: () => w.insertUnique('T', CHAIN, first, World.keyOf, REPAIRED_UNIQUE) };
        yield { kind: 'act', what: 'the second insert, at the same key', fn: () => w.insertUnique('T', CHAIN, second, World.keyOf, REPAIRED_UNIQUE) };
        yield { kind: 'commit' };
      },
    };
    const s = new Scheduler([twice], w);
    s.run(['T', 'T', 'T', 'T']);
    expect(s.outcomeOf('T')).toEqual({ kind: 'refused', code: `23505 unique_violation ${REPAIRED_UNIQUE}` });
    // Rolled back whole: neither row landed.
    expect(w.committedRowsOf(CHAIN).map((r) => r.reducerId)).toEqual(['alloc-1', 'alloc-2', 'alloc-3']);
  });

  it('F-C8, the other half — a case that FORGETS the index-key lock is reported as a model defect and not as a business outcome', () => {
    // The probe the scheduler installs. Without it the forgotten lock is
    // silent: the insert succeeds, nothing queues, and the case proves nothing
    // while looking green.
    const w = afterReversal();
    const forgetful: Txn = {
      id: 'F',
      body: function* () {
        yield {
          kind: 'act',
          what: 'insert with no index-key lock taken',
          fn: () => w.insertUnique('F', CHAIN, bad('x', 700n, 1n), World.keyOf, REPAIRED_UNIQUE),
        };
        yield { kind: 'commit' };
      },
    };
    const s = new Scheduler([forgetful], w);
    s.run(['F', 'F']);
    const o = s.outcomeOf('F');
    expect(o, 'the forgetful transaction never settled').not.toBe('running');
    if (o === 'running') return;
    expect(o.kind).toBe('refused');
    expect(o.kind === 'refused' ? o.code : '').toMatch(/model defect: F inserts under payment_allocations_level_generation_uq/);
  });

  it('F-C5 — THE CROSS-RELATION SAME-LEVEL RACE IS OPEN, and the replacement does NOT close it: two rows at one invoice level, one per relation, BOTH commit', () => {
    // Round 4's `docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §4 said two rows at one
    // invoice level, one in each relation, "are refused at statement time and
    // at COMMIT". Both halves are false CONCURRENTLY, by the same F1 reasoning
    // the document applies correctly one paragraph earlier: a `BEFORE INSERT`
    // trigger that reads cannot see another transaction's uncommitted row, and
    // a `DEFERRABLE INITIALLY DEFERRED` trigger fires inside its own
    // transaction and cannot either. The index cannot see it at all, because an
    // index lives in one relation.
    //
    // The hole is PRE-EXISTING and S4 records it honestly at `0081:330-332`:
    // "a UNIQUE index cannot see across `payment_allocations` and
    // `customer_credit_applications`". What round 4 added was a document saying
    // it was closed — which is worse than the hole, because a reviewer reading
    // §4 stops checking. So the claim is deleted there and the seam is proved
    // OPEN here.
    const w = afterReversal();
    const alloc: Row = { reducerId: 'bad-pa', level: 700n, amount: 300n, entryId: 'e-pa', generation: 1n, relation: 'payment_allocations' };
    const credit: Row = { reducerId: 'bad-cca', level: 700n, amount: 300n, entryId: 'e-cca', generation: 1n, relation: 'customer_credit_applications' };
    const s = new Scheduler(
      [
        directInsert(w, 'T1', alloc, { keyOf: World.keyOf, name: REPAIRED_UNIQUE }),
        directInsert(w, 'T2', credit, { keyOf: World.keyOf, name: 'customer_credit_applications_invoice_level_generation_uq' }),
      ],
      w,
    );
    s.run(['T1', 'T2', 'T1', 'T2', 'T1', 'T2', 'T1', 'T2']);

    // NEITHER WAITED. The two index keys differ in their first component —
    // the relation — so there was never anything to wait on.
    expect(s.queued, 'if either queued, the two keys collided and this is not the seam').toEqual([]);
    // AND BOTH COMMITTED. This is the finding, asserted and not described.
    expect(s.outcomes()).toEqual({ T1: { kind: 'committed' }, T2: { kind: 'committed' } });

    // The committed world: two ACTIVE rows at level 700, releasing 1300
    // against a capacity of 1000 — 300 minor of AR released past capacity.
    const active = w.committedRowsOf(CHAIN).filter((r) => !w.committedReversals().includes(r.reducerId));
    expect(active.filter((r) => r.level === 700n).map((r) => r.reducerId)).toEqual(['bad-pa', 'bad-cca']);
    expect(active.reduce((a, r) => a + r.amount, 0n)).toBe(1300n);
    expect(w.capacity.get(CHAIN)).toBe(1000n);
    // The verifier WOULD refuse this state — run by hand, after the fact, by
    // this assertion. Nothing in the protocol is obliged to run it again, and
    // that gap between "would refuse" and "is obliged to look" is the seam.
    expect(() => w.verifyCommitted(CHAIN)).toThrow(/settlement_inconsistent/);
  });

  it('F-C5, the condition that WOULD close it — one shared exclusion point per invoice level, modelled as a single key both relations take', () => {
    // Stated as a condition and not as a design: PostgreSQL has no unique index
    // across two relations, so closing this needs either ONE relation for both
    // reducer kinds (an S4 schema change, not S6's) or a shared exclusion point
    // both writers take by protocol. The CHAIN LOCK of step 3 is exactly such a
    // point, and the ROUTINES take it — which is why this hole is reachable
    // only from the direct-SQL path.
    //
    // Modelled by giving both writers one key: the second now QUEUES and is
    // refused, which is what the index would do if it could span relations. The
    // case exists so the condition is a mechanism and not a wish.
    const sharedKey = (chainId: string, r: Row): string => `${chainId}|${r.level}|${r.generation}`;
    const alloc: Row = { reducerId: 'bad-pa', level: 700n, amount: 300n, entryId: 'e-pa', generation: 1n, relation: 'payment_allocations' };
    const credit: Row = { reducerId: 'bad-cca', level: 700n, amount: 300n, entryId: 'e-cca', generation: 1n, relation: 'customer_credit_applications' };
    const build = (): WorldRace => {
      const world = afterReversal();
      return {
        world,
        txns: [
          directInsert(world, 'T1', alloc, { keyOf: sharedKey, name: 'the hypothetical cross-relation key' }),
          directInsert(world, 'T2', credit, { keyOf: sharedKey, name: 'the hypothetical cross-relation key' }),
        ],
        order: ['T1', 'T2', 'T1', 'T1', 'T2', 'T2'],
      };
    };
    const { s } = raceProvingContention(build, 'T2', `uniqueindex:${CHAIN}|700|1`, 'T1');
    expect(s.outcomes()).toEqual({
      T1: { kind: 'committed' },
      T2: { kind: 'refused', code: '23505 unique_violation the hypothetical cross-relation key' },
    });
  });

  it('PLANTED — a direct insert at a fabricated MID-CHAIN level is refused at COMMIT even with no competitor', () => {
    const w = new World();
    seedThree(w);
    const s = new Scheduler(
      [directInsert(w, 'D', { reducerId: 'bad', level: 400n, amount: 10n, entryId: 'e-bad', generation: 0n }, { keyOf: World.keyOf, name: REPAIRED_UNIQUE })],
      w,
    );
    s.run(['D', 'D', 'D', 'D']);
    // It collides with alloc-2, which sits at (400, generation 0) — so the
    // index catches this one before the verifier ever runs. Both answers are
    // refusals; the case pins WHICH, because a refusal from the wrong device
    // would mean the other device is untested here.
    expect(s.outcomeOf('D')).toEqual({ kind: 'refused', code: `23505 unique_violation ${REPAIRED_UNIQUE}` });
    expect(w.committedRowsOf(CHAIN).map((r) => r.reducerId)).toEqual(['alloc-1', 'alloc-2', 'alloc-3']);
  });

  it('PLANTED — a direct insert at a fabricated level the index does NOT cover is refused by the verifier alone', () => {
    // A level no existing row occupies, so no key collides: the gap in the
    // recurrence is the only thing left to catch it. This is the case that
    // proves the deferred verifier is doing work the index cannot.
    const w = new World();
    seedThree(w);
    const s = new Scheduler(
      [directInsert(w, 'D', { reducerId: 'bad', level: 950n, amount: 10n, entryId: 'e-bad', generation: 0n }, { keyOf: World.keyOf, name: REPAIRED_UNIQUE })],
      w,
    );
    s.run(['D', 'D', 'D', 'D']);
    expect(s.outcomeOf('D')).toEqual({ kind: 'refused', code: 'invoice_settlement.settlement_inconsistent' });
    expect(w.committedRowsOf(CHAIN).map((r) => r.reducerId)).toEqual(['alloc-1', 'alloc-2', 'alloc-3']);
  });
});
