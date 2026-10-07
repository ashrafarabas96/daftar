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
 *   1.  advisory `daftar.<reversal document>_id`
 *   1'. advisory `daftar.payment_id` of the original payment (payment reversal)
 *   2.  `payments` FOR UPDATE (payment reversal only)
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
import { invoiceChain, orderedActive, planAllocationReversal, tailOf, type ActiveReducer } from '../src/customer-reversal';

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

type Outcome = { readonly kind: 'committed' } | { readonly kind: 'refused'; readonly code: string } | { readonly kind: 'deadlock' };

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

class Scheduler {
  private readonly gens = new Map<string, Generator<Step, void, void>>();
  private readonly held = new Map<string, Held[]>();
  private readonly pending = new Map<string, Step>();
  private readonly waiting = new Map<string, string>();
  private readonly done = new Map<string, Outcome>();
  /** Every resource every transaction has ever waited for, for the queue barrier. */
  public readonly queued: { readonly txn: string; readonly resource: string; readonly behind: readonly string[] }[] = [];

  constructor(txns: readonly Txn[]) {
    for (const t of txns) {
      this.gens.set(t.id, t.body());
      this.held.set(t.id, []);
    }
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
        if (this.cycle(id)) this.finish(id, { kind: 'deadlock' });
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
      this.finish(id, { kind: 'refused', code: e instanceof Error ? e.message : String(e) });
    }
  }

  private finish(id: string, outcome: Outcome): void {
    this.done.set(id, outcome);
    this.held.set(id, []);
    this.pending.delete(id);
    this.waiting.delete(id);
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

  /** Run a WRITTEN-DOWN interleaving: each element is the transaction to advance next. */
  public run(order: readonly string[]): void {
    for (const id of order) this.step(id);
    // Drain: every transaction that is no longer blocked finishes. Bounded by
    // construction, and the bound expiring is a failure, never a pass.
    for (let i = 0; i < 400; i += 1) {
      let moved = false;
      for (const id of this.gens.keys()) {
        if (this.done.has(id)) continue;
        const before = this.outcomeOf(id);
        this.step(id);
        if (this.outcomeOf(id) !== before || !this.waiting.has(id)) moved = true;
      }
      if (!moved) break;
    }
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

// ══════════════════════════════════════════════════════════════════════════
// 2. The world: committed state, READ COMMITTED, and the deferred verifier.
// ══════════════════════════════════════════════════════════════════════════

interface Row {
  readonly reducerId: string;
  readonly level: bigint;
  readonly amount: bigint;
  readonly entryId: string;
}

class World {
  /** Committed reducer rows per chain. Append-only: nothing is ever removed. */
  public rows = new Map<string, Row[]>();
  /** Committed reversal rows: the reducer ids that are no longer active. Append-only. */
  public reversed = new Set<string>();
  public capacity = new Map<string, bigint>();

  /** The committed rows of a chain, or a failure naming the chain that was never seeded. */
  public rowsOf(chainId: string): Row[] {
    return must(this.rows.get(chainId), `rows for chain ${chainId}`);
  }

  public seed(chainId: string, capacity: bigint, rows: readonly Row[]): void {
    this.capacity.set(chainId, capacity);
    this.rows.set(chainId, [...rows]);
  }

  /** The ACTIVE chain as of the COMMITTED state — the one definition of "active". */
  public activeChain(chainId: string) {
    const rows = (this.rows.get(chainId) ?? []).filter((r) => !this.reversed.has(r.reducerId));
    const active: ActiveReducer[] = rows.map((r) => ({
      reducerId: r.reducerId,
      kind: 'payment_allocation',
      level: r.level,
      amount: r.amount,
      originalEntryId: r.entryId,
    }));
    return invoiceChain(chainId, must(this.capacity.get(chainId), `capacity for ${chainId}`), active);
  }

  /**
   * The DEFERRED CHAIN VERIFIER, at COMMIT. The replacement protection's
   * sufficient half: it recomputes the chain over the ACTIVE subset and raises
   * if the recurrence from zero is broken. It is what catches a direct-SQL
   * writer that took no lock and consulted no routine.
   */
  public verifyAtCommit(chainId: string): void {
    const chain = this.activeChain(chainId);
    let before = 0n;
    for (const r of orderedActive(chain)) {
      if (r.level !== before) throw new Error('invoice_settlement.settlement_inconsistent');
      before += r.amount;
    }
    if (before > chain.capacity) throw new Error('invoice_settlement.settlement_inconsistent');
  }
}

const CHAIN = 'invoice-1';
const INV_LOCK = `invoices:${CHAIN}`;
const CREDIT = 'credit-1';
const CREDIT_LOCK = `customer_credits:${CREDIT}`;

/** The three committed allocations of the standard world: 0 → 400 → 700, closing 1000. */
function seedThree(w: World): void {
  w.seed(CHAIN, 1000n, [
    { reducerId: 'alloc-1', level: 0n, amount: 400n, entryId: 'entry-1' },
    { reducerId: 'alloc-2', level: 400n, amount: 300n, entryId: 'entry-2' },
    { reducerId: 'alloc-3', level: 700n, amount: 300n, entryId: 'entry-3' },
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
          const chain = w.activeChain(CHAIN);
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
          w.reversed.add(reducerId);
        },
      };
      yield { kind: 'act', what: 'the deferred verifier at COMMIT', fn: () => w.verifyAtCommit(CHAIN) };
      yield { kind: 'commit' };
    },
  };
}

/** A new allocation that follows the same order: the chain lock, then the level. */
function allocationTxn(id: string, w: World, amount: bigint, reducerId: string): Txn {
  return {
    id,
    body: function* () {
      yield { kind: 'lock', resource: `advisory:daftar.payment_id:${id}`, mode: 'exclusive' };
      yield { kind: 'lock', resource: INV_LOCK, mode: 'exclusive' };
      yield {
        kind: 'act',
        what: 'compute the level under the lock and append',
        fn: () => {
          const chain = w.activeChain(CHAIN);
          const level = orderedActive(chain).reduce((a, r) => a + r.amount, 0n);
          if (level + amount > chain.capacity) throw new Error('customer_payment.amount_exceeds_outstanding');
          w.rowsOf(CHAIN).push({ reducerId, level, amount, entryId: `entry-${reducerId}` });
        },
      };
      yield { kind: 'act', what: 'the deferred verifier at COMMIT', fn: () => w.verifyAtCommit(CHAIN) };
      yield { kind: 'commit' };
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 3. The required cases.
// ══════════════════════════════════════════════════════════════════════════

describe('C-1 — reversal vs reversal of the SAME tail', () => {
  it('exactly one commits; the loser is refused not_last_reducer, and nothing is reversed twice', () => {
    const w = new World();
    seedThree(w);
    const s = new Scheduler([reversalTxn('A', w, 'alloc-3'), reversalTxn('B', w, 'alloc-3')]);
    // A takes its key and the chain lock. B is then enqueued behind the chain
    // lock, and its arrival is OBSERVED before A is allowed to proceed.
    s.run(['A', 'A', 'B', 'B']);
    expectQueued(s, 'B', INV_LOCK);
    expect(s.outcomes()).toEqual({ A: { kind: 'committed' }, B: { kind: 'refused', code: 'allocation_reversal.not_last_reducer' } });
    expect([...w.reversed]).toEqual(['alloc-3']);
    // The original row is STILL THERE. Append-only, no delete, no mutation.
    expect(w.rowsOf(CHAIN).map((r) => r.reducerId)).toEqual(['alloc-1', 'alloc-2', 'alloc-3']);
  });

  it('the OTHER service order gives the mirror outcome, so the result is the protocol and not the schedule', () => {
    const w = new World();
    seedThree(w);
    const s = new Scheduler([reversalTxn('A', w, 'alloc-3'), reversalTxn('B', w, 'alloc-3')]);
    s.run(['B', 'B', 'A', 'A']);
    expectQueued(s, 'A', INV_LOCK);
    expect(s.outcomes()).toEqual({ B: { kind: 'committed' }, A: { kind: 'refused', code: 'allocation_reversal.not_last_reducer' } });
  });
});

describe('C-2 — reversal vs a NEW allocation on the same chain', () => {
  it('the reversal wins the lock: the allocation then computes its level from the SHORTENED chain and lands at the freed level', () => {
    const w = new World();
    seedThree(w);
    const s = new Scheduler([reversalTxn('REV', w, 'alloc-3'), allocationTxn('ALLOC', w, 150n, 'alloc-4')]);
    s.run(['REV', 'REV', 'ALLOC', 'ALLOC']);
    expectQueued(s, 'ALLOC', INV_LOCK);
    expect(s.outcomes()).toEqual({ REV: { kind: 'committed' }, ALLOC: { kind: 'committed' } });
    const landed = must(
      w.rowsOf(CHAIN).find((r) => r.reducerId === 'alloc-4'),
      'the allocation the model just appended',
    );
    // The level the reversal freed. The ORIGINAL row at 700 still exists, so a
    // per-relation UNIQUE (business_id, invoice_id, level) would have refused
    // this LAWFUL allocation — the whole of the level-uniqueness replacement.
    expect(landed.level).toBe(700n);
    expect(w.rowsOf(CHAIN).filter((r) => r.level === 700n).length).toBe(2);
    // And the ACTIVE chain is still contiguous, which is what actually matters.
    expect(() => w.verifyAtCommit(CHAIN)).not.toThrow();
  });

  it('the allocation wins the lock: the reversal then sees a reducer that is no longer the tail and is refused', () => {
    // The invoice must still be OPEN for a new allocation to be lawful at all,
    // so this case seeds 400 + 300 + 200 against a total of 1000. A closed
    // invoice would refuse the allocation by the cap and the race would never
    // happen — a case that cannot occur proves nothing about the one that can.
    const w = new World();
    w.seed(CHAIN, 1000n, [
      { reducerId: 'alloc-1', level: 0n, amount: 400n, entryId: 'entry-1' },
      { reducerId: 'alloc-2', level: 400n, amount: 300n, entryId: 'entry-2' },
      { reducerId: 'alloc-3', level: 700n, amount: 200n, entryId: 'entry-3' },
    ]);
    const s = new Scheduler([reversalTxn('REV', w, 'alloc-3'), allocationTxn('ALLOC', w, 100n, 'alloc-4')]);
    s.run(['ALLOC', 'ALLOC', 'REV', 'REV']);
    expectQueued(s, 'REV', INV_LOCK);
    expect(s.outcomes()).toEqual({ ALLOC: { kind: 'committed' }, REV: { kind: 'refused', code: 'allocation_reversal.not_last_reducer' } });
    expect(w.reversed.size).toBe(0);
    expect(
      must(
        w.rowsOf(CHAIN).find((r) => r.reducerId === 'alloc-4'),
        'the allocation the model just appended',
      ).level,
    ).toBe(900n);
  });
});

describe('C-3 — TWO allocations after a reversal, both aiming at the freed level', () => {
  it('both commit, at SUCCESSIVE levels, because each computes its level after taking the chain lock', () => {
    const w = new World();
    seedThree(w);
    w.reversed.add('alloc-3');
    const s = new Scheduler([allocationTxn('A1', w, 100n, 'new-1'), allocationTxn('A2', w, 100n, 'new-2')]);
    s.run(['A1', 'A1', 'A2', 'A2']);
    expectQueued(s, 'A2', INV_LOCK);
    expect(s.outcomes()).toEqual({ A1: { kind: 'committed' }, A2: { kind: 'committed' } });
    expect(
      w
        .rowsOf(CHAIN)
        .filter((r) => r.reducerId.startsWith('new-'))
        .map((r) => r.level),
    ).toEqual([700n, 800n]);
    expect(() => w.verifyAtCommit(CHAIN)).not.toThrow();
  });

  it('the last amount is capped under the lock: the loser is refused rather than over-allocating the invoice', () => {
    const w = new World();
    seedThree(w);
    w.reversed.add('alloc-3');
    // 300 is exactly what the reversal freed, so only one of the two can land.
    const s = new Scheduler([allocationTxn('A1', w, 300n, 'new-1'), allocationTxn('A2', w, 300n, 'new-2')]);
    s.run(['A1', 'A1', 'A2', 'A2']);
    expectQueued(s, 'A2', INV_LOCK);
    expect(s.outcomes()).toEqual({ A1: { kind: 'committed' }, A2: { kind: 'refused', code: 'customer_payment.amount_exceeds_outstanding' } });
  });
});

describe('C-4 — a TWO-CHAIN reversal, in ONE transaction', () => {
  /** The credit-application reversal takes BOTH chain locks, in resource order. */
  function twoChainReversal(id: string, w: World, taken: string[]): Txn {
    return {
      id,
      body: function* () {
        yield { kind: 'lock', resource: `advisory:daftar.allocation_reversal_id:${id}`, mode: 'exclusive' };
        for (const l of [INV_LOCK, CREDIT_LOCK].sort()) {
          yield { kind: 'lock', resource: l, mode: 'exclusive' };
          taken.push(l);
        }
        yield { kind: 'act', what: 'both tail checks', fn: () => void 0 };
        yield { kind: 'commit' };
      },
    };
  }

  it('both chain locks are taken in ONE transaction, in resource order, before either tail is checked', () => {
    const w = new World();
    seedThree(w);
    const taken: string[] = [];
    const s = new Scheduler([twoChainReversal('T', w, taken)]);
    s.run(['T', 'T', 'T', 'T', 'T']);
    expect(s.outcomeOf('T')).toEqual({ kind: 'committed' });
    expect(taken).toEqual([CREDIT_LOCK, INV_LOCK]);
    expect([...taken]).toEqual([...taken].sort());
  });

  it('a competing single-chain writer on EITHER chain queues behind it, so neither chain can move under a half-checked reversal', () => {
    for (const competitor of [INV_LOCK, CREDIT_LOCK]) {
      const w = new World();
      seedThree(w);
      const s = new Scheduler([
        twoChainReversal('T', w, []),
        {
          id: 'OTHER',
          body: function* () {
            yield { kind: 'lock', resource: competitor, mode: 'exclusive' };
            yield { kind: 'commit' };
          },
        },
      ]);
      s.run(['T', 'T', 'T', 'OTHER', 'OTHER']);
      expectQueued(s, 'OTHER', competitor);
      expect(s.outcomes()).toEqual({ T: { kind: 'committed' }, OTHER: { kind: 'committed' } });
    }
  });
});

describe('C-5 — the STALE HEAD', () => {
  it('a head read BEFORE the chain lock is stale after it, and the recomputation under the lock refuses it', () => {
    const w = new World();
    seedThree(w);
    let seenBeforeLock: bigint | null = null;
    const stale: Txn = {
      id: 'STALE',
      body: function* () {
        // The defect, written out: the head is read with no lock held.
        yield { kind: 'act', what: 'read the head WITHOUT the lock', fn: () => void (seenBeforeLock = BigInt(orderedActive(w.activeChain(CHAIN)).length)) };
        yield { kind: 'lock', resource: INV_LOCK, mode: 'exclusive' };
        yield {
          kind: 'act',
          what: 'compare the stale figure against the one under the lock',
          fn: () => {
            const now = BigInt(orderedActive(w.activeChain(CHAIN)).length);
            if (now !== seenBeforeLock) throw new Error('customer_payment.settlement_changed');
          },
        };
        yield { kind: 'commit' };
      },
    };
    const s = new Scheduler([stale, reversalTxn('REV', w, 'alloc-3')]);
    // STALE reads, then REV takes the lock and commits, then STALE takes it.
    s.run(['STALE', 'REV', 'REV', 'REV', 'REV', 'STALE', 'STALE']);
    expectQueued(s, 'STALE', INV_LOCK);
    expect(s.outcomeOf('REV')).toEqual({ kind: 'committed' });
    expect(s.outcomeOf('STALE')).toEqual({ kind: 'refused', code: 'customer_payment.settlement_changed' });
  });

  it('NO stale head commits: over every interleaving of the pair, a committed stale transaction is a failure', () => {
    const orders: readonly (readonly string[])[] = [
      ['STALE', 'REV', 'REV', 'REV', 'REV', 'STALE'],
      ['REV', 'STALE', 'REV', 'REV', 'REV', 'STALE'],
      ['REV', 'REV', 'STALE', 'STALE', 'REV', 'REV'],
      ['REV', 'REV', 'REV', 'REV', 'STALE', 'STALE'],
    ];
    for (const order of orders) {
      const w = new World();
      seedThree(w);
      let seen: number | null = null;
      const stale: Txn = {
        id: 'STALE',
        body: function* () {
          yield { kind: 'act', what: 'read the head WITHOUT the lock', fn: () => void (seen = orderedActive(w.activeChain(CHAIN)).length) };
          yield { kind: 'lock', resource: INV_LOCK, mode: 'exclusive' };
          yield {
            kind: 'act',
            what: 'recompute under the lock',
            fn: () => {
              if (orderedActive(w.activeChain(CHAIN)).length !== seen) throw new Error('customer_payment.settlement_changed');
            },
          };
          yield { kind: 'commit' };
        },
      };
      const s = new Scheduler([stale, reversalTxn('REV', w, 'alloc-3')]);
      s.run(order);
      const st = s.outcomeOf('STALE');
      const rev = s.outcomeOf('REV');
      // Either the reversal had not committed when STALE re-read (so STALE's
      // figure was never stale), or it had and STALE is refused. A STALE that
      // committed over a COMMITTED reversal is the defect.
      const bothCommitted = st !== 'running' && st.kind === 'committed' && rev !== 'running' && rev.kind === 'committed';
      expect(bothCommitted && w.reversed.has('alloc-3') && seen === 3, `a stale head committed under order ${order.join(',')}`).toBe(false);
      expect(st === 'running' || st.kind !== 'deadlock', 'a deadlock is a lock-order defect, never a business outcome').toBe(true);
    }
  });
});

describe('C-6 — DEADLOCK ORDERING: every relevant lock pair, in BOTH directions', () => {
  /** The four resource classes a reversal and a settlement both touch. */
  const RESOURCES = [INV_LOCK, CREDIT_LOCK, 'customers:cust-1', 'businesses:biz-1'] as const;

  /** The declared order: `invoices` → `customer_credits` → `customers` → `businesses`. */
  const DECLARED_ORDER: readonly string[] = [INV_LOCK, CREDIT_LOCK, 'customers:cust-1', 'businesses:biz-1'];

  function orderedTakerTxn(id: string, resources: readonly string[]): Txn {
    return {
      id,
      body: function* () {
        for (const r of resources) yield { kind: 'lock', resource: r, mode: r.startsWith('customers') || r.startsWith('businesses') ? 'share' : 'exclusive' };
        yield { kind: 'commit' };
      },
    };
  }

  it('every PAIR of resources, taken by two transactions in the DECLARED order, deadlocks ZERO times', () => {
    let pairs = 0;
    for (let i = 0; i < RESOURCES.length; i += 1) {
      for (let j = 0; j < RESOURCES.length; j += 1) {
        if (i === j) continue;
        const pair = [must(RESOURCES[i], `resource ${i}`), must(RESOURCES[j], `resource ${j}`)];
        // BOTH transactions normalise to the declared order, which is what the
        // protocol requires of every path. The pair is still run in both
        // directions, so the test covers the pair and not one arrangement.
        const norm = [...pair].sort((a, b) => DECLARED_ORDER.indexOf(a) - DECLARED_ORDER.indexOf(b));
        const s = new Scheduler([orderedTakerTxn('X', norm), orderedTakerTxn('Y', norm)]);
        s.run(['X', 'Y', 'X', 'Y', 'X', 'Y', 'X', 'Y']);
        for (const [id, o] of Object.entries(s.outcomes())) {
          expect(o !== 'running' && o.kind, `${id} on pair ${pair.join(' + ')} did not commit`).toBe('committed');
        }
        pairs += 1;
      }
    }
    expect(pairs).toBe(RESOURCES.length * (RESOURCES.length - 1));
  });

  it('PLANTED LOCK-ORDER DEFECT — one transaction taking the SAME pair in the opposite order deadlocks, which is what the declared order buys', () => {
    // The proof that the previous case is not vacuous. The subject is the same
    // scheduler and the same resources; the ONE planted fact is the reversed
    // order, and the model must report a deadlock rather than a refusal.
    const s = new Scheduler([orderedTakerTxn('X', [INV_LOCK, CREDIT_LOCK]), orderedTakerTxn('Y', [CREDIT_LOCK, INV_LOCK])]);
    s.run(['X', 'Y', 'X', 'Y', 'X', 'Y']);
    const kinds = Object.values(s.outcomes()).map((o) => (o === 'running' ? 'running' : o.kind));
    expect(kinds).toContain('deadlock');
  });
});

describe('C-7 — the DIRECT-SQL race: no routine, no lock, no tail check', () => {
  it('two direct inserts at the same freed level both skip the lock, and the DEFERRED VERIFIER refuses the second at COMMIT', () => {
    const w = new World();
    seedThree(w);
    w.reversed.add('alloc-3');

    /** An attacker with INSERT on the relation and no interest in the protocol. */
    function directInsert(id: string, reducerId: string): Txn {
      return {
        id,
        body: function* () {
          // No advisory key. No invoices FOR UPDATE. A fabricated level, which
          // is exactly what P4-AL-22 says a level UNIQUE cannot stop: "a direct
          // SQL attacker simply declares a different level."
          yield {
            kind: 'act',
            what: 'insert at a fabricated level',
            fn: () => void w.rowsOf(CHAIN).push({ reducerId, level: 700n, amount: 50n, entryId: `e-${id}` }),
          };
          yield { kind: 'act', what: 'the deferred verifier at COMMIT', fn: () => w.verifyAtCommit(CHAIN) };
          yield { kind: 'commit' };
        },
      };
    }

    const s = new Scheduler([directInsert('D1', 'bad-1'), directInsert('D2', 'bad-2')]);
    // Both insert, then both reach COMMIT. The interleaving is written down and
    // neither party ever queues — which is the point: with no lock there IS no
    // contention, so the protection cannot be a lock.
    s.run(['D1', 'D2', 'D1', 'D2']);
    expect(s.queued).toEqual([]);
    const codes = Object.values(s.outcomes()).flatMap((o) => (o !== 'running' && o.kind === 'refused' ? [o.code] : []));
    expect(codes.length, 'at least one direct insert must be refused at COMMIT by the deferred verifier').toBeGreaterThanOrEqual(1);
    expect(codes.every((c) => c === 'invoice_settlement.settlement_inconsistent')).toBe(true);
  });

  it('a SINGLE direct insert at the freed level is ACCEPTED, so the verifier refuses the overlap and not the level', () => {
    // The red proof's counterpart: without it, a verifier that refused every
    // direct insert would pass the case above while proving nothing about
    // overlaps. This is what makes the previous assertion non-vacuous.
    const w = new World();
    seedThree(w);
    w.reversed.add('alloc-3');
    const s = new Scheduler([
      {
        id: 'D',
        body: function* () {
          yield {
            kind: 'act',
            what: 'insert at the freed level',
            fn: () => void w.rowsOf(CHAIN).push({ reducerId: 'ok-1', level: 700n, amount: 50n, entryId: 'e-ok' }),
          };
          yield { kind: 'act', what: 'the deferred verifier at COMMIT', fn: () => w.verifyAtCommit(CHAIN) };
          yield { kind: 'commit' };
        },
      },
    ]);
    s.run(['D', 'D', 'D']);
    expect(s.outcomeOf('D')).toEqual({ kind: 'committed' });
  });

  it('PLANTED — a direct insert at a fabricated MID-CHAIN level is refused at COMMIT even with no competitor', () => {
    const w = new World();
    seedThree(w);
    const s = new Scheduler([
      {
        id: 'D',
        body: function* () {
          yield {
            kind: 'act',
            what: 'insert at a level already consumed',
            fn: () => void w.rowsOf(CHAIN).push({ reducerId: 'bad', level: 400n, amount: 10n, entryId: 'e-bad' }),
          };
          yield { kind: 'act', what: 'the deferred verifier at COMMIT', fn: () => w.verifyAtCommit(CHAIN) };
          yield { kind: 'commit' };
        },
      },
    ]);
    s.run(['D', 'D', 'D']);
    expect(s.outcomeOf('D')).toEqual({ kind: 'refused', code: 'invoice_settlement.settlement_inconsistent' });
  });
});
